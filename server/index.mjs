/**
 * Grand Line Voyage — multiplayer relay server.
 *
 * A dumb, trusting room relay: clients are authoritative over their own player
 * and their own hits. This is fine for playing with friends; it is NOT
 * cheat-proof. Messages are JSON. See src/net/NetClient.js for the protocol.
 *
 * ALSO serves the built game (../dist, from `npm run build` at the project
 * root) as static files on this SAME port — so one process + one public URL
 * (e.g. a `cloudflared`/`ngrok` tunnel to this port) is enough for friends on
 * ANY network to open the game and land in multiplayer, no LAN/port-forward
 * needed. If ../dist doesn't exist yet, the game route just 404s with a hint
 * to build it; the WebSocket relay works either way.
 *
 *   node index.mjs            # listens on PORT (env) or 8080
 */
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';

// Defense in depth against a bad message or a flaky external geo-lookup
// taking the whole relay down — log and keep serving instead of crashing.
// (Node treats an unhandled promise rejection as fatal by default since v15;
// this is what stops one bad `fetch` or malformed client message from
// killing the process everyone's connected through.)
process.on('uncaughtException', (err) => console.error('[relay] uncaughtException (kept running):', err));
process.on('unhandledRejection', (err) => console.error('[relay] unhandledRejection (kept running):', err));
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 8080;
const MAX_PER_ROOM = 16;
// CORS: only matters when the client is hosted on a DIFFERENT origin than
// this relay (e.g. client on GitHub Pages/Vercel, relay alone on Render) —
// the default same-origin setup (this server also serves dist/) doesn't need
// it at all, browsers don't apply CORS to same-origin requests. '*' is fine
// for a trusted-friends hobby project with no cookies/auth; set
// ALLOWED_ORIGIN to a specific origin (e.g. https://mygame.pages.dev) to
// lock it down once you know where the client will live.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ---------------- IP -> country (for the "X se unió desde <país>" toast) ----------------
// Free, no-key lookup. Cached per IP so repeat joins from the same address
// (or a friend refreshing) don't re-hit the external service. Best-effort:
// any failure (offline, rate-limited, a private/local IP in dev) just means
// no flag is shown — never blocks the join itself for long.
const _geoCache = new Map();     // ip -> { country, countryCode, flag }
function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
async function geoLookup(ip) {
  if (!ip) return null;
  if (_geoCache.has(ip)) return _geoCache.get(ip);
  let result = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await res.json();
    if (j.status === 'success' && j.countryCode) {
      result = { country: j.country, countryCode: j.countryCode, flag: flagEmoji(j.countryCode) };
    }
  } catch { /* offline / rate-limited / local IP in dev — no flag, not fatal */ }
  _geoCache.set(ip, result);
  return result;
}
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  const xff = req.headers['x-forwarded-for'];
  const ip = cf || (xff ? xff.split(',')[0].trim() : req.socket.remoteAddress) || '';
  return ip.replace('::ffff:', '');
}

// ---------------- static game files (optional) ----------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon'
};

const httpServer = http.createServer((req, res) => {
  // ---- tiny JSON status API (used by client-side region matchmaking to see
  // how many players are already in a room BEFORE opening a socket) ----
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname === '/api/status') {
    const room = String(url.searchParams.get('room') || '').slice(0, 40);
    const count = room ? (rooms.get(room)?.size || 0) : [...rooms.values()].reduce((n, s) => n + s.size, 0);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN });
    res.end(JSON.stringify({ room: room || null, count }));
    return;
  }
  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('El relay está corriendo, pero no hay un build del juego (carpeta dist/) — corre "npm run build" en la raíz del proyecto y reinicia este server.');
    return;
  }
  let reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
  const filePath = path.normalize(path.join(DIST_DIR, reqPath));
  if (!filePath.startsWith(DIST_DIR)) { res.writeHead(403); res.end(); return; }   // no path traversal
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA-ish fallback: unknown path -> index.html, so a stray refresh doesn't 404
      fs.readFile(path.join(DIST_DIR, 'index.html'), (err2, idx) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
      return;
    }
    // no-store: never let a browser (or an intermediate proxy/tunnel) cache
    // a stale build — this is a fast-iterating test server, always serve
    // exactly what's in dist/ right now.
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });
const rooms = new Map(); // roomId -> Set<ws>

function roomPeers(room, exceptWs) {
  const set = rooms.get(room);
  if (!set) return [];
  const out = [];
  for (const c of set) {
    if (c === exceptWs || c.readyState !== c.OPEN) continue;
    out.push({ id: c.id, name: c.name, fruit: c.fruit, state: c.lastState || null, region: c.region || null, country: c.geo?.country || null, countryCode: c.geo?.countryCode || null, flag: c.geo?.flag || '' });
  }
  return out;
}

function broadcast(room, obj, exceptWs) {
  const set = rooms.get(room);
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const c of set) {
    if (c === exceptWs || c.readyState !== c.OPEN) continue;
    c.send(data);
  }
}

function sendTo(room, id, obj) {
  const set = rooms.get(room);
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const c of set) {
    if (c.id === id && c.readyState === c.OPEN) { c.send(data); return; }
  }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // kick the (best-effort, cached) geo lookup off immediately so it's
  // usually already resolved by the time the client's 'join' arrives —
  // doesn't add latency to the handshake in the common case.
  ws._geoPromise = geoLookup(clientIp(req)).then((g) => { ws.geo = g; return g; });

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    // App-level latency probe — usable before AND after 'join' (the browser
    // WebSocket API gives JS no access to the low-level ping/pong control
    // frames, so round-trip latency has to be measured with a real message).
    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', ts: m.ts })); return; }

    if (m.t === 'join') {
      const room = String(m.room || 'lobby').slice(0, 40);
      let set = rooms.get(room);
      if (!set) { set = new Set(); rooms.set(room, set); }
      if (set.size >= MAX_PER_ROOM) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
      ws.id = randomUUID().slice(0, 8);
      ws.room = room;
      ws.name = String(m.name || 'Pirata').slice(0, 24);
      ws.fruit = Number.isInteger(m.fruit) ? m.fruit : 0;
      ws.region = typeof m.region === 'string' ? m.region.slice(0, 40) : null;
      try { await ws._geoPromise; } catch { ws.geo = null; }   // best-effort — never blocks the join on failure
      set.add(ws);
      ws.send(JSON.stringify({ t: 'welcome', id: ws.id }));
      ws.send(JSON.stringify({ t: 'peers', peers: roomPeers(room, ws) }));
      broadcast(room, {
        t: 'join', id: ws.id, name: ws.name, fruit: ws.fruit, region: ws.region,
        country: ws.geo?.country || null, countryCode: ws.geo?.countryCode || null, flag: ws.geo?.flag || ''
      }, ws);
      console.log(`[+] ${ws.name} (${ws.id}) -> room "${room}" (${set.size}) ${ws.geo?.flag || ''}${ws.geo?.country || ''}`);
      return;
    }

    if (!ws.room || !ws.id) return;                 // must join first

    switch (m.t) {
      case 'state':
        ws.lastState = m;                            // cache for late joiners
        broadcast(ws.room, { ...m, id: ws.id }, ws);
        break;
      case 'cast':
      case 'melee':
      case 'respawn':
      case 'chat':
        broadcast(ws.room, { ...m, id: ws.id }, ws);
        break;
      case 'hit':
        if (m.to) sendTo(ws.room, m.to, { ...m, from: ws.id, fromPos: m.from || null });
        break;
    }
  });

  ws.on('close', () => {
    const set = rooms.get(ws.room);
    if (set) {
      set.delete(ws);
      broadcast(ws.room, { t: 'leave', id: ws.id });
      if (set.size === 0) rooms.delete(ws.room);
    }
    if (ws.id) console.log(`[-] ${ws.name} (${ws.id}) left "${ws.room}"`);
  });
});

// drop dead sockets
const ping = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
wss.on('close', () => clearInterval(ping));

httpServer.listen(PORT, () => {
  console.log(`Grand Line MP relay + game listening on :${PORT}${fs.existsSync(DIST_DIR) ? '' : ' (no dist/ build found yet)'}`);
});
