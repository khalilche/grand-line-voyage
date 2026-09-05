import * as THREE from 'three';
import {
  FlamePlume, GroundDecal, ShockDome, LightningBolt, IceEncasement, CrackFX, HazardZone, StretchLimb,
  SeaClash, TransformAura, Beam, GiantArm, SplitBody, FlyingHands, SpringCoil, SandTornado,
  ElectricPrison, StormCloud, LightningRibbon, LavaSea, QuakeRing, FractureLine, TerrainShatter,
  Flipbook, Chains, AirRift, WaterShock, WaterWave, WindGust
} from './effects.js';

/* painterly frame-atlas effects (built by tools/build-flipbooks.mjs) */
const FX_ATLAS = {
  impact:     { cols: 5, rows: 4, frames: 20 },
  muzzle:     { cols: 5, rows: 4, frames: 20 },
  fire:       { cols: 8, rows: 4, frames: 32 },
  smoke:      { cols: 8, rows: 5, frames: 40 },
  energyball: { cols: 5, rows: 2, frames: 10 },
  magic:      { cols: 5, rows: 4, frames: 20 },
  shock:      { cols: 6, rows: 4, frames: 24 },
  // phoenix sets (tools/build-flipbooks.mjs): slash/flare are white streak
  // sprites; phx* are the warm packs re-baked to blue flame.
  slash:      { cols: 5, rows: 2, frames: 10 },
  flare:      { cols: 6, rows: 4, frames: 24 },
  phxfire:    { cols: 8, rows: 4, frames: 32 },
  phxball:    { cols: 5, rows: 2, frames: 10 },
  phxmuzzle:  { cols: 5, rows: 4, frames: 20 },
};

/**
 * Effects hub. Pooled cheap stuff (shock rings, additive particle bursts,
 * splashes) plus a list of richer self-managed effects (volumetric flame,
 * branching lightning, shock domes, ice encasement, ground cracks, hazard
 * fields, elastic limbs). One update() drives everything.
 */
export class VFX {
  constructor(scene) {
    this.scene = scene;
    this._rings = [];
    this._ringIdx = 0;
    this.effects = [];
    // headroom so a big multi-beat ult never force-evicts (and synchronously
    // disposes) a heavy effect mid-cast — the stutter that caused. Effects are
    // short-lived so the list drains back down on its own right after.
    this.maxEffects = 110;
    this._initRings(28);
    this._initParticles(6000);

    // painterly flipbook atlases — loaded once, shared by all Flipbook effects
    this._fx = {};
    const loader = new THREE.TextureLoader();
    for (const name of Object.keys(FX_ATLAS)) {
      loader.load(`textures/fx/${name}.png`, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        this._fx[name] = { tex, ...FX_ATLAS[name] };
      });
    }
  }

  // ---------------- rich effects ----------------
  spawn(fx) {
    if (this.effects.length >= this.maxEffects) { const old = this.effects.shift(); old.dispose?.(); }
    this.effects.push(fx);
    return fx;
  }
  flame(pos, o = {}) { return this.spawn(new FlamePlume(this.scene, { pos, ...o })); }
  decal(pos, o = {}) { return this.spawn(new GroundDecal(this.scene, { pos, ...o })); }
  dome(pos, o = {}) { return this.spawn(new ShockDome(this.scene, { pos, ...o })); }
  bolt(from, to, o = {}) { return this.spawn(new LightningBolt(this.scene, { from, to, ...o })); }
  encase(getPos, o = {}) { return this.spawn(new IceEncasement(this.scene, { getPos, ...o })); }
  crack(pos, o = {}) { return this.spawn(new CrackFX(this.scene, { pos, ...o })); }
  hazard(pos, o = {}) { return this.spawn(new HazardZone(this.scene, { pos, ...o })); }
  stretch(getStart, dir, o = {}) { return this.spawn(new StretchLimb(this.scene, { getStart, dir, ...o })); }
  seaClash(center, o = {}) { return this.spawn(new SeaClash(this.scene, { center, ...o })); }
  aura(getPos, o = {}) { return this.spawn(new TransformAura(this.scene, { getPos, ...o })); }
  beam(getFrom, getDir, o = {}) { return this.spawn(new Beam(this.scene, { getFrom, getDir, ...o })); }
  giantArm(from, to, o = {}) { return this.spawn(new GiantArm(this.scene, { from, to, ...o })); }
  split(getPos, mats, o = {}) { return this.spawn(new SplitBody(this.scene, { getPos, mats, ...o })); }
  flyingHands(getHomes, target, mat, o = {}) { return this.spawn(new FlyingHands(this.scene, { getHomes, target, mat, ...o })); }
  spring(getPos, axis, o = {}) { return this.spawn(new SpringCoil(this.scene, { getPos, axis, ...o })); }
  tornado(center, o = {}) { return this.spawn(new SandTornado(this.scene, { center, ...o })); }
  prison(getPos, o = {}) { return this.spawn(new ElectricPrison(this.scene, { getPos, ...o })); }
  chains(getPos, o = {}) { return this.spawn(new Chains(this.scene, { getPos, ...o })); }
  airRift(pos, o = {}) { return this.spawn(new AirRift(this.scene, { pos, ...o })); }
  waterShock(pos, o = {}) { return this.spawn(new WaterShock(this.scene, { pos, ...o })); }
  waterWave(pos, o = {}) { return this.spawn(new WaterWave(this.scene, { pos, ...o })); }
  windGust(pos, o = {}) { return this.spawn(new WindGust(this.scene, { pos, ...o })); }
  storm(pos, o = {}) { return this.spawn(new StormCloud(this.scene, { pos, ...o })); }
  ribbon(from, to, o = {}) { return this.spawn(new LightningRibbon(this.scene, { from, to, ...o })); }
  lavaSea(pos, o = {}) { return this.spawn(new LavaSea(this.scene, { pos, ...o })); }
  quakeRing(pos, o = {}) { return this.spawn(new QuakeRing(this.scene, { pos, ...o })); }
  fracture(from, dir, o = {}) { return this.spawn(new FractureLine(this.scene, { from, dir, ...o })); }
  shatter(pos, o = {}) { return this.spawn(new TerrainShatter(this.scene, { pos, ...o })); }
  /** painterly animated sprite: kind = impact|muzzle|fire|smoke|energyball|magic|shock */
  flipbook(pos, o = {}) {
    const a = this._fx[o.kind];
    if (!a) return null;                     // atlas not loaded yet — skip silently
    return this.spawn(new Flipbook(this.scene, { pos, tex: a.tex, cols: a.cols, rows: a.rows, frames: a.frames, ...o }));
  }

  // ---------------- shock rings ----------------
  _initRings(n) {
    this._ringFullGeo = new THREE.RingGeometry(0.7, 1.0, 40, 1);
    this._ringFullGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
      });
      const m = new THREE.Mesh(this._ringFullGeo, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.scene.add(m);
      this._rings.push({ m, life: 0, maxLife: 1, from: 0, to: 1, arcGeo: null });
    }
  }

  /**
   * `arc` (optional): render only a partial ring instead of a full circle.
   *   { dir: Vector3, sweep: radians }  — a wedge of angular width `sweep`
   *   centred on the flattened `dir` direction. Used for melee sweep arcs.
   * When omitted the ring is a full 360° circle (the shared geometry).
   */
  ring(pos, { color = 0xffffff, radius = 4, life = 0.5, thickness = 0.35, y = 0.15, vertical = false, arc = null } = {}) {
    const r = this._rings[this._ringIdx = (this._ringIdx + 1) % this._rings.length];
    r.m.visible = true;
    r.m.position.copy(pos);
    r.m.position.y += y;
    if (arc && arc.sweep) {
      const sweep = arc.sweep;
      if (r.arcGeo) r.arcGeo.dispose();
      r.arcGeo = new THREE.RingGeometry(0.7, 1.0, Math.max(8, Math.round(40 * sweep / (Math.PI * 2))), 1, -sweep / 2, sweep);
      r.arcGeo.rotateX(-Math.PI / 2);
      r.m.geometry = r.arcGeo;
      // theta=0 of the geometry points at world +X; aim it along `arc.dir`
      const d = arc.dir || _RING_FWD;
      r.m.rotation.set(vertical ? Math.PI / 2 : 0, Math.atan2(-d.z, d.x), 0);
    } else {
      if (r.m.geometry !== this._ringFullGeo) r.m.geometry = this._ringFullGeo;
      r.m.rotation.set(vertical ? Math.PI / 2 : 0, Math.random() * 6.28, 0);
    }
    r.m.material.color.set(color);
    r.life = 0; r.maxLife = life; r.from = 0.2; r.to = radius; r.thick = thickness;
    r.m.material.opacity = 0.9;
  }

  // ---------------- particle bursts ----------------
  // Atlas tiles (4x2, from the Kenney particle pack, CC0):
  //   0 circle  1 flame  2 smoke  3 spark  4 star  5 magic  6 light  7 trace
  _initParticles(max) {
    this.pMax = max;
    this.pPos = new Float32Array(max * 3);
    this.pVel = new Float32Array(max * 3);
    this.pCol = new Float32Array(max * 3);
    this.pLife = new Float32Array(max);
    this.pMaxLife = new Float32Array(max);
    this.pSize = new Float32Array(max);
    this.pGrav = new Float32Array(max);
    this.pDrag = new Float32Array(max);
    this.pHead = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    const aSize = new Float32Array(max);
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.aSize = aSize;
    const aTile = new Float32Array(max);
    geo.setAttribute('aTile', new THREE.BufferAttribute(aTile, 1).setUsage(THREE.DynamicDrawUsage));
    this.aTile = aTile;
    geo.setDrawRange(0, 0);

    const tex = new THREE.TextureLoader().load('textures/particles.png');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;

    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: window.innerHeight / 2 }, uMap: { value: tex } },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute float aTile;
        varying vec3 vColor;
        varying float vTile;
        uniform float uScale;
        void main() {
          vColor = color;
          vTile = aTile;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(-mv.z, 0.001);
        }
      `,
      fragmentShader: /* glsl */`
        precision mediump float;
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vTile;
        void main() {
          float col = mod(vTile, 4.0);                  // 0..3
          float row = step(3.5, vTile);                 // 0 = top row (0-3), 1 = bottom (4-7)
          vec2 uv = vec2((col + gl_PointCoord.x) * 0.25,
                         (1.0 - row * 0.5) - gl_PointCoord.y * 0.5);
          vec4 t = texture2D(uMap, uv);
          float a = t.a * max(max(t.r, t.g), t.b);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor * t.rgb, a);
        }
      `
    });
    mat.vertexColors = true;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    window.addEventListener('resize', () => { mat.uniforms.uScale.value = window.innerHeight / 2; });
  }

  _spawn(x, y, z, vx, vy, vz, r, g, b, size, life, grav, drag, tile) {
    const i = this.pHead = (this.pHead + 1) % this.pMax;
    const i3 = i * 3;
    this.pPos[i3] = x; this.pPos[i3 + 1] = y; this.pPos[i3 + 2] = z;
    this.pVel[i3] = vx; this.pVel[i3 + 1] = vy; this.pVel[i3 + 2] = vz;
    this.pCol[i3] = r; this.pCol[i3 + 1] = g; this.pCol[i3 + 2] = b;
    this.pLife[i] = life; this.pMaxLife[i] = life;
    this.pSize[i] = size; this.pGrav[i] = grav; this.pDrag[i] = drag;
    this.aTile[i] = tile || 0;
  }

  burst(pos, {
    count = 24, color = 0xffffff, color2 = null, speed = 6, spread = 1,
    size = 0.3, life = 0.6, gravity = 6, drag = 1.5, dir = null, cone = Math.PI, tile = 0
  } = {}) {
    const c1 = new THREE.Color(color);
    const c2 = color2 != null ? new THREE.Color(color2) : c1;
    const base = dir ? _v.copy(dir).normalize() : null;
    for (let i = 0; i < count; i++) {
      let vx, vy, vz;
      if (base) {
        const a = (Math.random() - 0.5) * cone;
        const b = (Math.random() - 0.5) * cone;
        _q.setFromEuler(_e.set(b, a, 0));
        _v2.copy(base).applyQuaternion(_q);
        const s = speed * (0.4 + Math.random() * 0.8);
        vx = _v2.x * s; vy = _v2.y * s; vz = _v2.z * s;
      } else {
        const th = Math.random() * 6.283, ph = Math.acos(2 * Math.random() - 1);
        const s = speed * (0.3 + Math.random() * 0.9) * spread;
        vx = Math.sin(ph) * Math.cos(th) * s;
        vy = Math.cos(ph) * s;
        vz = Math.sin(ph) * Math.sin(th) * s;
      }
      const t = Math.random();
      const cc = _c.copy(c1).lerp(c2, t);
      this._spawn(
        pos.x + (Math.random() - 0.5) * 0.2,
        pos.y + (Math.random() - 0.5) * 0.2,
        pos.z + (Math.random() - 0.5) * 0.2,
        vx, vy, vz, cc.r, cc.g, cc.b,
        size * (0.6 + Math.random() * 0.8),
        life * (0.6 + Math.random() * 0.7),
        gravity, drag, tile
      );
    }
  }

  splash(pos, strength = 1) {
    this.burst(pos, {
      count: 30 * strength, color: 0xdff4ff, color2: 0x8fd0e8,
      speed: 5 * strength, size: 0.28, life: 0.7, gravity: 16, drag: 1.2,
      dir: _up, cone: 1.6
    });
    this.ring(pos, { color: 0xcdeeff, radius: 2.4 * strength, life: 0.5, y: 0.02 });
  }

  update(dt) {
    // rich effects
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      let alive = true;
      try { alive = fx.update(dt) !== false && !fx.dead; }
      catch (e) { console.error('[vfx] effect error', e); alive = false; }
      if (!alive) { fx.dispose?.(); this.effects.splice(i, 1); }
    }

    // rings
    for (const r of this._rings) {
      if (!r.m.visible) continue;
      r.life += dt;
      const t = r.life / r.maxLife;
      if (t >= 1) { r.m.visible = false; continue; }
      const rad = THREE.MathUtils.lerp(r.from, r.to, 1 - Math.pow(1 - t, 2));
      r.m.scale.setScalar(rad);
      const inner = 1 - r.thick * (1 - t * 0.5);
      r.m.material.opacity = 0.9 * Math.pow(1 - t, 1.6);
    }

    // particles
    let maxUsed = 0;
    for (let i = 0; i < this.pMax; i++) {
      if (this.pLife[i] <= 0) { this.aSize[i] = 0; continue; }
      this.pLife[i] -= dt;
      const i3 = i * 3;
      const k = Math.max(0, this.pLife[i] / this.pMaxLife[i]);
      const drag = Math.max(0, 1 - this.pDrag[i] * dt);
      this.pVel[i3] *= drag;
      this.pVel[i3 + 1] = this.pVel[i3 + 1] * drag - this.pGrav[i] * dt;
      this.pVel[i3 + 2] *= drag;
      this.pPos[i3] += this.pVel[i3] * dt;
      this.pPos[i3 + 1] += this.pVel[i3 + 1] * dt;
      this.pPos[i3 + 2] += this.pVel[i3 + 2] * dt;
      this.aSize[i] = this.pSize[i] * (0.2 + k * 0.8);
      maxUsed = i + 1;
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, this.pMax);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aTile.needsUpdate = true;
  }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c = new THREE.Color();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _RING_FWD = new THREE.Vector3(0, 0, 1);   // fallback aim dir for arc rings
const _up = new THREE.Vector3(0, 1, 0);
