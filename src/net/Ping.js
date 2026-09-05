/**
 * Latency measurement helpers. Browsers give JS no access to the raw
 * WebSocket ping/pong control frames, so RTT is measured at the app level:
 * open a socket, send { t:'ping', ts }, time how long { t:'pong', ts } takes.
 */

/** Color-coded quality thresholds (ms) — tune freely, used by the HUD dot. */
export const PING_GOOD_MS = 80;
export const PING_OK_MS = 150;

export function pingQuality(ms) {
  if (ms == null) return 'bad';
  if (ms <= PING_GOOD_MS) return 'good';
  if (ms <= PING_OK_MS) return 'ok';
  return 'bad';
}

/** One-shot RTT to a region's URL via a throwaway connection. Resolves to a number (ms) or null on failure/timeout. */
export function measurePing(url, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { ws && ws.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish(null), timeout);
    const t0 = performance.now();
    try { ws = new WebSocket(url); } catch { finish(null); return; }
    ws.onopen = () => { try { ws.send(JSON.stringify({ t: 'ping', ts: t0 })); } catch { finish(null); } };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'pong') finish(Math.round(performance.now() - t0));
    };
    ws.onerror = () => finish(null);
  });
}

/** Measures every region in parallel; returns them with a `.ping` field added (null = unreachable). */
export async function measureAllRegions(regions) {
  return Promise.all(regions.map(async (r) => ({ ...r, ping: await measurePing(r.url) })));
}

/** Fetches how many players are already in `room` on `wsUrl`'s server (for matchmaking). Resolves 0 on any failure. */
export async function roomPlayerCount(wsUrl, room, { timeout = 3000 } = {}) {
  try {
    const httpUrl = wsUrl.replace(/^ws/, 'http') + `/api/status?room=${encodeURIComponent(room)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(httpUrl, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    const j = await res.json();
    return j.count || 0;
  } catch { return 0; }
}
