/**
 * Thin WebSocket client for the multiplayer relay (server/index.mjs).
 *
 * Model: every client owns its own player and its own outgoing hits. Remote
 * players are rendered as puppets; their ability casts are replayed as
 * VFX-only. Trusted-clients — good enough for playing with friends.
 *
 * Events (register with .on(name, fn)):
 *   status(str, attempt)         'connecting'|'retrying'|'connected'|'disconnected'|'error'|'full'
 *                                 'retrying' fires while the FIRST connection attempt keeps failing
 *                                 (e.g. a Render free-tier service still waking up from a cold
 *                                 start) — `attempt` is the retry count, for a UI message like
 *                                 "Despertando el servidor... intento 3".
 *   ready(id)                    joined, got our id
 *   peerJoin(id, info)           info = { name, fruit, region, country, countryCode, flag, justJoined }
 *   peerLeave(id)
 *   state(id, msg)               msg = { p:[x,y,z], y:yaw, fl:flying, hp, f:fruitIdx }
 *   cast(id, msg)                msg = { slot, fwd:[..], aim:[..], pos:[..], fruit, arg }
 *   melee(id, msg)               msg = { dir:[..], combo, pos:[..] }
 *   hit(msg)                     msg = { from, damage, up, stun, fromPos:[..], ignoreDodge, slowFrac, slowDur }
 *   respawn(id, msg)             msg = { pos:[..] }
 *   chat(id, text)
 *   ping(ms)                     live round-trip latency on the real connection
 */
export class NetClient {
  constructor() {
    this.ws = null;
    this.id = null;
    this.connected = false;
    this.room = null;
    this.name = null;
    this.fruit = 0;
    this._handlers = {};
    this._stateT = 0;
    this._rate = 1 / 15;                 // outgoing state packets / sec
    this.ping = null;                    // last measured RTT (ms), null until first sample
    this._pingT = 0;
    this._pingInterval = 3;              // seconds between live latency samples

    // ---- cold-start retry state (a free-tier host like Render can take
    // 20-50s to wake a sleeping service — the FIRST connection attempt
    // failing there is normal, not an error, so retry with backoff instead
    // of giving up immediately) ----
    this._retryAttempt = 0;
    this._maxRetries = 14;               // ~14 attempts with growing backoff covers a slow cold start comfortably
    this._retryTimer = null;
    this._manuallyClosed = false;
  }

  on(ev, fn) { this._handlers[ev] = fn; return this; }
  _emit(ev, ...a) { const h = this._handlers[ev]; if (h) try { h(...a); } catch (e) { console.error('[net]', ev, e); } }

  connect(url, room, name, fruit = 0, region = null) {
    this.room = room; this.name = name; this.fruit = fruit; this._region = region; this._url = url;
    this._manuallyClosed = false;
    this._retryAttempt = 0;
    this._attemptConnect();
  }

  _attemptConnect() {
    if (this._manuallyClosed) return;
    this._emit('status', this._retryAttempt > 0 ? 'retrying' : 'connecting', this._retryAttempt);
    let ws;
    try { ws = new WebSocket(this._url); }
    catch (e) { console.error('[net] bad url', e); this._emit('status', 'error'); return; }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => { opened = true; this._retryAttempt = 0; this.send({ t: 'join', room: this.room, name: this.name, fruit: this.fruit, region: this._region }); };
    ws.onclose = () => {
      this.connected = false;
      // never opened at all -> most likely the host is still cold-starting; retry instead of surfacing an error
      if (!opened && !this._manuallyClosed && this._retryAttempt < this._maxRetries) {
        this._retryAttempt++;
        const delay = Math.min(6000, 1200 * this._retryAttempt);
        this._emit('status', 'retrying', this._retryAttempt);
        this._retryTimer = setTimeout(() => this._attemptConnect(), delay);
        return;
      }
      this._emit('status', opened ? 'disconnected' : 'error');
    };
    ws.onerror = () => { /* onclose always follows onerror for WebSocket — retry logic lives there so it isn't handled twice */ };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      this._onMsg(m);
    };
  }

  disconnect() {
    this._manuallyClosed = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null; this.connected = false;
  }

  _onMsg(m) {
    switch (m.t) {
      case 'welcome':
        this.id = m.id; this.connected = true;
        this._emit('status', 'connected'); this._emit('ready', m.id);
        break;
      case 'full': this._emit('status', 'full'); break;
      case 'peers':
        // peers already in the room when WE arrived — not a "just joined" event (no toast for these)
        for (const p of m.peers || []) {
          this._emit('peerJoin', p.id, { name: p.name, fruit: p.fruit, region: p.region, country: p.country, countryCode: p.countryCode, flag: p.flag, justJoined: false });
          if (p.state) this._emit('state', p.id, p.state);
        }
        break;
      case 'join':
        this._emit('peerJoin', m.id, { name: m.name, fruit: m.fruit, region: m.region, country: m.country, countryCode: m.countryCode, flag: m.flag, justJoined: true });
        break;
      case 'leave': this._emit('peerLeave', m.id); break;
      case 'state': this._emit('state', m.id, m); break;
      case 'cast': this._emit('cast', m.id, m); break;
      case 'melee': this._emit('melee', m.id, m); break;
      case 'hit': this._emit('hit', m); break;
      case 'respawn': this._emit('respawn', m.id, m); break;
      case 'chat': this._emit('chat', m.id, m.text); break;
      case 'pong':
        this.ping = Math.max(0, Math.round(performance.now() - m.ts));
        this._emit('ping', this.ping);
        break;
    }
  }

  /** Call every frame (or from a fixed tick) once connected — samples live RTT every `_pingInterval`s. */
  tick(dt) {
    if (!this.connected) return;
    this._pingT += dt;
    if (this._pingT >= this._pingInterval) {
      this._pingT = 0;
      this.send({ t: 'ping', ts: performance.now() });
    }
  }

  send(o) { const w = this.ws; if (w && w.readyState === 1) w.send(JSON.stringify(o)); }

  /** rate-limited local player snapshot */
  sendState(dt, s) {
    this._stateT += dt;
    if (this._stateT < this._rate || !this.connected) return;
    this._stateT = 0;
    this.send({ t: 'state', ...s });
  }

  sendCast(slot, fwd, aim, pos, fruit, arg) {
    this.send({ t: 'cast', slot, fwd: v3(fwd), aim: v3(aim), pos: v3(pos), fruit, arg: arg ?? null });
  }
  sendMelee(dir, combo, pos) { this.send({ t: 'melee', dir: v3(dir), combo, pos: v3(pos) }); }
  sendHit(toId, damage, up, stun, fromPos, extra = {}) {
    this.send({
      t: 'hit', to: toId, damage: Math.round(damage) || 0, up: up || 0, stun: stun || 0, from: v3(fromPos),
      ignoreDodge: !!extra.ignoreDodge, slowFrac: extra.slowFrac || 0, slowDur: extra.slowDur || 0
    });
  }
  sendRespawn(pos) { this.send({ t: 'respawn', pos: v3(pos) }); }
  sendChat(text) { this.send({ t: 'chat', text: String(text).slice(0, 200) }); }
}

const r2 = (n) => Math.round(n * 100) / 100;
const v3 = (v) => (v ? [r2(v.x), r2(v.y), r2(v.z)] : [0, 0, 0]);
