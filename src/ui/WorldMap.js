import { SEA_BOUNDS } from '../world/islands/definitions.js';

/**
 * Full-screen sea chart (toggle with M). Draws the whole First Sea: island
 * discs sized to their radius, names + level bands, the player arrow and the
 * ship. Undiscovered stub islands read as "???" until you sail near them.
 */
export class WorldMap {
  constructor() {
    this.open = false;
    this.markers = [];
    this.discovered = new Set();

    this.root = document.createElement('div');
    this.root.id = 'worldmap';
    this.root.style.cssText = `
      position:fixed; inset:0; z-index:40; display:none;
      background:rgba(4,10,20,0.82); backdrop-filter:blur(3px);
      align-items:center; justify-content:center; flex-direction:column; gap:14px;`;
    this.root.innerHTML = `
      <div style="font:700 22px 'Trebuchet MS',sans-serif; letter-spacing:.22em; text-transform:uppercase; color:#dcefff; text-shadow:0 2px 10px #0008;">Carta del Primer Mar</div>
      <canvas id="worldmap-cv" width="1100" height="820" style="max-width:92vw; max-height:78vh; border:1px solid rgba(255,255,255,0.14); border-radius:14px; box-shadow:0 20px 60px #000a; background:#0a2b49;"></canvas>
      <div style="font:12px 'Trebuchet MS',sans-serif; opacity:.55; letter-spacing:.1em;">M para cerrar &nbsp;·&nbsp; los puntos ??? se revelan al acercarte</div>`;
    document.body.appendChild(this.root);
    this.cv = this.root.querySelector('#worldmap-cv');
    this.ctx = this.cv.getContext('2d');

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM' && !e.repeat) this.toggle();
      if (e.code === 'Escape' && this.open) this.close();
    });
  }

  setMarkers(m) { this.markers = m; }
  markDiscovered(id) { this.discovered.add(id); }
  toggle() { this.open ? this.close() : this.show(); }
  show() { if (this.enabled === false) return; this.open = true; this.root.style.display = 'flex'; this._draw(); }
  close() { this.open = false; this.root.style.display = 'none'; }

  _w2m(x, z) {
    const b = SEA_BOUNDS, pad = 46;
    const W = this.cv.width - pad * 2, H = this.cv.height - pad * 2;
    return [
      pad + ((x - b.minX) / (b.maxX - b.minX)) * W,
      pad + ((z - b.minZ) / (b.maxZ - b.minZ)) * H
    ];
  }
  _scale() {
    const b = SEA_BOUNDS, pad = 46;
    return (this.cv.width - pad * 2) / (b.maxX - b.minX);
  }

  update(playerPos, playerYaw, shipPos, mode) {
    // discovery check runs even when the map is closed
    for (const m of this.markers) {
      if (this.discovered.has(m.id)) continue;
      const p = mode === 'sail' && shipPos ? shipPos : playerPos;
      if (Math.hypot(p.x - m.center.x, p.z - m.center.z) < m.radius * 2.0) this.discovered.add(m.id);
    }
    this._player = playerPos; this._yaw = playerYaw; this._ship = shipPos; this._mode = mode;
    if (this.open) this._draw();
  }

  _draw() {
    const ctx = this.ctx;
    const { width: W, height: H } = this.cv;
    ctx.clearRect(0, 0, W, H);

    // water
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#0e3f68'); grd.addColorStop(1, '#0a2b49');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    for (let gx = 0; gx <= 10; gx++) { const x = 46 + gx / 10 * (W - 92); ctx.beginPath(); ctx.moveTo(x, 46); ctx.lineTo(x, H - 46); ctx.stroke(); }
    for (let gy = 0; gy <= 8; gy++) { const y = 46 + gy / 8 * (H - 92); ctx.beginPath(); ctx.moveTo(46, y); ctx.lineTo(W - 46, y); ctx.stroke(); }

    const s = this._scale();

    // routes between built islands (dashed)
    const built = this.markers.filter((m) => m.built);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.setLineDash([6, 8]); ctx.lineWidth = 2;
    ctx.beginPath();
    built.forEach((m, i) => { const [x, y] = this._w2m(m.center.x, m.center.z); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);

    // islands
    for (const m of this.markers) {
      const [x, y] = this._w2m(m.center.x, m.center.z);
      const r = Math.max(7, m.radius * s);
      const known = this.discovered.has(m.id) || m.built;
      const reveal = this.discovered.has(m.id);

      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = !known ? 'rgba(120,130,140,0.25)'
        : m.built ? 'rgba(120,190,110,0.85)' : 'rgba(150,160,170,0.6)';
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = m.built ? 'rgba(240,255,230,0.7)' : 'rgba(255,255,255,0.3)';
      ctx.stroke();

      ctx.fillStyle = '#eef6ff';
      ctx.font = '700 14px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'center';
      const label = reveal || m.built ? m.name : '???';
      ctx.fillText(label, x, y - r - 8);
      if ((reveal || m.built) && m.levelBand) {
        ctx.fillStyle = 'rgba(255,220,140,0.9)';
        ctx.font = '600 11px "Trebuchet MS", sans-serif';
        ctx.fillText(`Nv ${m.levelBand[0]}-${m.levelBand[1]}`, x, y - r + 6 + (r < 12 ? -14 : 0));
      }
    }

    // ship
    if (this._ship) {
      const [x, y] = this._w2m(this._ship.x, this._ship.z);
      ctx.fillStyle = '#ffd24a';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#5a3a10'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // player arrow
    if (this._player) {
      const [x, y] = this._w2m(this._player.x, this._player.z);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((this._yaw ?? 0) + Math.PI);
      ctx.fillStyle = '#4fd0ff';
      ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#08324a'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
    }
  }
}
