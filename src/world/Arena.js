import * as THREE from 'three';

/**
 * ARENA — open-air floor.
 *
 * A single large circular combat floor (radius 156 m) under the game's normal
 * painterly sky. No LED band, no walls, no stands — just the floor, a radial
 * plate pattern, a central podium, and a thin edge rim. Lit by the world Sky
 * (sun + hemisphere fill); Arena adds no lights of its own.
 *
 * Walkable surface is analytic `sampleGround(x,z)`; `resolveWalls` keeps the
 * pawn on the disc (fall off the edge -> respawn at centre).
 */

const H = 1.8;
const R = 480;                        // combat-floor radius  (⌀ 960) — bumped up from 186 ("mucho más grande")
const FLOOR_Y = 0;
const VOID_Y = -40;

const PODIUM_RADIUS = 4 * H;          // 7.2
const PODIUM_HEIGHT = 1 * H;          // 1.8
const PODIUM_TOP_Y = FLOOR_Y + PODIUM_HEIGHT;
const PODIUM_STEPS = 4;

const C_STRUCT = 0x3a4048, C_STRUCT_D = 0x232830, C_CYAN = 0x4fd6ee;
const STEP = 0.6;

function makeFloorTexture() {
  if (typeof document === 'undefined') return null;
  const N = 1024, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const c = cv.getContext('2d');
  const rg = c.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  rg.addColorStop(0, '#9aa2ac'); rg.addColorStop(0.25, '#8b929c'); rg.addColorStop(0.7, '#7c838d'); rg.addColorStop(1, '#6c727c');
  c.fillStyle = rg; c.fillRect(0, 0, N, N);
  c.translate(N / 2, N / 2);
  c.strokeStyle = 'rgba(40,46,54,0.5)'; c.lineWidth = 3;
  for (let i = 0; i < 20; i++) {                       // radial sectors
    const a = (i / 20) * Math.PI * 2;
    c.beginPath(); c.moveTo(Math.cos(a) * 20, Math.sin(a) * 20); c.lineTo(Math.cos(a) * N / 2, Math.sin(a) * N / 2); c.stroke();
  }
  for (const rr of [0.22, 0.42, 0.62, 0.82, 0.99]) {  // concentric rings
    c.beginPath(); c.arc(0, 0, rr * N / 2, 0, Math.PI * 2); c.stroke();
  }
  // glowing cyan ring around the podium
  c.strokeStyle = 'rgba(99,224,255,0.85)'; c.lineWidth = 6; c.shadowColor = 'rgba(99,224,255,0.95)'; c.shadowBlur = 24;
  c.beginPath(); c.arc(0, 0, 0.10 * N / 2, 0, Math.PI * 2); c.stroke();
  c.shadowBlur = 0;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

export class Arena {
  constructor(scene) {
    this.scene = scene;
    this.radius = R;
    this.boundsR = R - 1.5;
    this.voidY = VOID_Y;
    this.group = new THREE.Group();
    this.collision = new THREE.Group();
    this.collision.visible = false;
    scene.add(this.group);
    scene.add(this.collision);

    this._struct = new THREE.MeshStandardMaterial({ color: C_STRUCT, roughness: 0.6, metalness: 0.18 });
    this._structD = new THREE.MeshStandardMaterial({ color: C_STRUCT_D, roughness: 0.7, metalness: 0.12 });
    this._solids = this.solids = [];
    this._visTris = 0; this._drawCalls = 0;
    this._t0 = 0;

    this._build();

    this.spawn = new THREE.Vector3(0, FLOOR_Y + 0.05, 26);
    // 4 dummies — one to each side (N / E / S / O), evenly around the podium.
    // Kept at a fixed, conveniently-testable distance — decoupled from R now
    // that the floor itself is much bigger, so they don't scatter miles apart.
    const DR = 80;
    this.dummySpawns = [
      [0, -DR], [DR, 0], [0, DR], [-DR, 0]
    ].map(([x, z]) => ({ type: 'dummy', island: 'arena', level: 1, pos: new THREE.Vector3(x, FLOOR_Y, z) }));
  }

  /* ---------------- walkable surface ---------------- */
  sampleGround(x, z, _fromY) {
    const r = Math.hypot(x, z);
    if (r <= PODIUM_RADIUS) {
      const t = 1 - Math.min(1, (r - PODIUM_RADIUS * 0.35) / (PODIUM_RADIUS * 0.65));
      const s = Math.max(0, Math.min(PODIUM_STEPS, Math.ceil(t * PODIUM_STEPS)));
      return { height: (s / PODIUM_STEPS) * PODIUM_HEIGHT, onLand: true, island: null };
    }
    if (r <= R + 1) return { height: FLOOR_Y, onLand: true, island: null };
    return { height: VOID_Y, onLand: false, island: null };
  }

  waterHeight() { return -9990; }

  /* ---------------- collision: keep the pawn on the disc ---------------- */
  resolveWalls(pos, radius = 0.4) {
    let r = Math.hypot(pos.x, pos.z);
    const max = this.boundsR - radius;
    if (r > max) { const k = max / r; pos.x *= k; pos.z *= k; r = max; }
    // podium: a knee-high blocker (walk into it -> stop, small hop -> mount it)
    if (pos.y < PODIUM_TOP_Y - 1.0) {
      const need = PODIUM_RADIUS + radius;
      if (r < need) { const k = need / (r || 1e-4); pos.x *= k; pos.z *= k; }
    }
  }
  resolveSolids(pos, radius) { return this.resolveWalls(pos, radius); }

  /* ---------------- build ---------------- */
  _mesh(geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    this.group.add(m);
    this._visTris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    this._drawCalls++;
    return m;
  }

  _build() {
    // ---- floor: big circular slab + radial-plate texture ----
    const floorTex = makeFloorTexture();
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: floorTex, roughness: 0.62, metalness: 0.12,
      emissive: 0xffffff, emissiveMap: floorTex, emissiveIntensity: 0.28
    });
    const fg = new THREE.CircleGeometry(R, 128);
    fg.rotateX(-Math.PI / 2);
    const floor = this._mesh(fg, floorMat, 0, FLOOR_Y, 0);
    floor.receiveShadow = true;
    // thick edge skirt so the disc reads as solid, hanging into the void
    this._mesh(new THREE.CylinderGeometry(R, R * 0.985, 8, 128, 1, true), this._structD, 0, FLOOR_Y - 4, 0);
    // thin edge rim line
    const rim = new THREE.TorusGeometry(R - 0.4, 0.35, 6, 160);
    rim.rotateX(-Math.PI / 2);
    this._rim = this._mesh(rim, new THREE.MeshBasicMaterial({ color: C_CYAN, toneMapped: false }), 0, FLOOR_Y + 0.1, 0);

    // ---- central podium: stepped drum + cyan rim ----
    for (let s = 0; s < PODIUM_STEPS; s++) {
      const rr = PODIUM_RADIUS * (1.22 - 0.22 * s / PODIUM_STEPS);
      const yy = (s / PODIUM_STEPS) * PODIUM_HEIGHT;
      const step = this._mesh(new THREE.CylinderGeometry(rr, rr, PODIUM_HEIGHT / PODIUM_STEPS + 0.05, 44),
        s % 2 ? this._structD : this._struct, 0, yy + (PODIUM_HEIGHT / PODIUM_STEPS) / 2, 0);
      step.receiveShadow = step.castShadow = true;
    }
    const prim = new THREE.TorusGeometry(PODIUM_RADIUS * 0.95, 0.16, 8, 60);
    prim.rotateX(-Math.PI / 2);
    this._podRim = this._mesh(prim, new THREE.MeshBasicMaterial({ color: C_CYAN, toneMapped: false }), 0, PODIUM_TOP_Y + 0.02, 0);
  }

  update(dt) {
    this._t0 += dt;
    const p = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(this._t0 * 2.0));
    if (this._podRim) this._podRim.material.color.setRGB(0.16 * p, 0.72 * p, 0.86 * p);
    if (this._rim) this._rim.material.color.setRGB(0.12 * p, 0.6 * p, 0.72 * p);
  }

  get triCount() { return Math.round(this._visTris); }
  get stats() { return { visTris: Math.round(this._visTris), drawCalls: this._drawCalls, solids: 0 }; }
  debugPoints() {
    return { H, R, floorY: FLOOR_Y, podiumR: PODIUM_RADIUS, podiumTopY: PODIUM_TOP_Y,
      boundsR: this.boundsR, spawn: this.spawn.clone(), voidY: VOID_Y, ...this.stats };
  }

  dispose() {
    this.scene.remove(this.group); this.scene.remove(this.collision);
    this.group.traverse((c) => { c.geometry?.dispose?.(); c.material?.map?.dispose?.(); c.material?.dispose?.(); });
  }
}
