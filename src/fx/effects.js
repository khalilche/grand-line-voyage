import * as THREE from 'three';

/**
 * Self-managed "heavy" effects. Each has update(dt) -> alive:boolean and
 * dispose(). The VFX manager keeps a list and drives them. These are the pieces
 * that make Devil-Fruit abilities read as real forces rather than sparkles:
 * volumetric flame, branching lightning, expanding shock domes, ice encasement,
 * ground cracks, scorch / frost decals, and lingering hazard fields.
 */

const _v = new THREE.Vector3();

/* small shared GLSL noise */
const GLSL_NOISE = /* glsl */`
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p){ float a=0.5,v=0.0; for(int i=0;i<5;i++){ v+=a*vnoise(p); p=p*2.03+1.7; a*=0.5; } return v; }
`;

/* ------------------------------------------------------------------ *
 *  FlamePlume — crossed cones with scrolling fbm; rises, billows, dies.
 * ------------------------------------------------------------------ */
export class FlamePlume {
  constructor(scene, { pos, radius = 2.2, height = 5, life = 1.3, color = 0xff4d16, core = 0xffd070 } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    scene.add(this.group);

    this.u = {
      uTime: { value: 0 }, uLife: { value: 0 }, uGlow: { value: 0 },
      uCore: { value: new THREE.Color(core) }, uEdge: { value: new THREE.Color(color) }
    };
    const frag = /* glsl */`
      precision highp float; varying vec2 vUv;
      uniform float uTime, uLife, uGlow; uniform vec3 uCore, uEdge;
      ${GLSL_NOISE}
      void main(){
        float g = clamp(vUv.y, 0.0, 1.0);
        float n = fbm(vec2(vUv.x*5.0, vUv.y*2.6 - uTime*3.8));
        n += 0.5*fbm(vec2(vUv.x*11.0, vUv.y*5.0 - uTime*6.2));
        float top = smoothstep(0.12 + n*0.55, 1.15, g);      // flames lick / erode near the tip
        float a = (1.0 - top) * (1.0 - uLife*0.8);
        a *= mix(1.0, 0.45, uGlow);
        if (a < 0.03) discard;
        vec3 col = mix(uCore, uEdge, smoothstep(0.0, 0.5, g + n*0.15));
        col = mix(col, vec3(0.32,0.08,0.03), smoothstep(0.55, 1.0, g));
        col += uCore * (1.0 - g) * 0.7 * (0.55 + 0.45*n);      // white-hot base
        gl_FragColor = vec4(col, a);
      }`;
    const vert = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
    this.coreMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: this.u, vertexShader: vert, fragmentShader: frag });
    this.glowMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { ...this.u, uGlow: { value: 1 } }, vertexShader: vert, fragmentShader: frag });

    this.cones = [];
    for (let i = 0; i < 2; i++) {
      const geo = new THREE.ConeGeometry(radius * (1 - i * 0.2), height * (1 + i * 0.12), 16, 9, true);
      const m = new THREE.Mesh(geo, this.coreMat);
      m.position.y = height * 0.5;
      m.rotation.y = i * 1.7;
      this.group.add(m);
      this.cones.push(m);
    }
    const gGeo = new THREE.ConeGeometry(radius * 1.7, height * 1.25, 14, 6, true);
    this.glow = new THREE.Mesh(gGeo, this.glowMat);
    this.glow.position.y = height * 0.6;
    this.group.add(this.glow);
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    this.u.uTime.value = this.t;
    this.u.uLife.value = k;
    this.glowMat.uniforms.uTime.value = this.t;
    this.glowMat.uniforms.uLife.value = k;
    const grow = k < 0.12 ? k / 0.12 : 1;
    const shrink = k > 0.55 ? 1 - (k - 0.55) / 0.45 * 0.5 : 1;
    this.group.scale.set(grow * shrink, THREE.MathUtils.lerp(0.5, 1.15, Math.min(1, k * 2.6)), grow * shrink);
    this.group.position.y += dt * 0.5;
    for (let i = 0; i < this.cones.length; i++) this.cones[i].rotation.y += dt * (0.7 + i * 0.4);
    return true;
  }
  dispose() {
    this.scene.remove(this.group);
    this.cones.forEach((c) => c.geometry.dispose());
    this.glow.geometry.dispose();
    this.coreMat.dispose(); this.glowMat.dispose();
  }
}

/* ------------------------------------------------------------------ *
 *  GroundDecal — scorch / frost / crack / sand splat, flat on terrain.
 * ------------------------------------------------------------------ */
const DECAL_KIND = { scorch: 0, frost: 1, crack: 2, sand: 3 };
export class GroundDecal {
  constructor(scene, { pos, radius = 3, kind = 'scorch', life = 6, groundY, color = null } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    const geo = new THREE.CircleGeometry(radius, 40);
    geo.rotateX(-Math.PI / 2);
    // `color` (optional): recolours the SCORCH kind — the soot is tinted toward
    // this hue and the ember glow toward a brightened version of it, so an
    // ability can leave e.g. a bluish "sacred burn" mark instead of the
    // default brown+orange. `uTintOn` 0 = untouched default.
    const tint = color != null ? new THREE.Color(color) : new THREE.Color(0x000000);
    this.u = {
      uTime: { value: 0 }, uFade: { value: 0 }, uKind: { value: DECAL_KIND[kind] ?? 0 }, uSeed: { value: Math.random() * 10 },
      uTint: { value: tint }, uTintOn: { value: color != null ? 1 : 0 }
    };
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: this.u,
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv;
        uniform float uTime, uFade, uKind, uSeed, uTintOn;
        uniform vec3 uTint;
        ${GLSL_NOISE}
        void main(){
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          float ang = atan(p.y, p.x);
          float edge = fbm(vec2(ang*2.2 + uSeed, uSeed)) * 0.35;
          float mask = smoothstep(1.0, 0.55 - edge, r);
          if (mask < 0.02) { discard; }
          vec3 col; float a = mask;
          if (uKind < 0.5) {                     // scorch
            float soot = fbm(p*3.0 + uSeed);
            vec3 sootLo = mix(vec3(0.05,0.04,0.03), uTint * 0.35, uTintOn);
            vec3 sootHi = mix(vec3(0.16,0.12,0.10), uTint * 0.85, uTintOn);
            col = mix(sootLo, sootHi, soot);
            float ember = smoothstep(0.9,1.0, r) * max(0.0, 1.0 - uTime*1.6);
            col += mix(vec3(1.0,0.4,0.1), uTint + vec3(0.35), uTintOn) * ember;
            a *= 0.9;
          } else if (uKind < 1.5) {              // frost
            float cr = fbm(p*5.0 + uSeed) + 0.4*fbm(p*12.0);
            col = mix(vec3(0.72,0.85,0.95), vec3(0.95,0.99,1.0), cr);
            a *= 0.75 + 0.25*step(0.55, cr);
          } else if (uKind < 2.5) {              // crack
            float lines = 0.0;
            for (int i=0;i<7;i++){
              float aa = float(i)*0.8976 + uSeed + fbm(vec2(float(i), uSeed))*1.4;
              float wob = fbm(vec2(r*3.0, aa*4.0)) * 0.06;
              float d = abs(sin(ang - aa) + wob) * r;
              lines = max(lines, smoothstep(0.035, 0.0, d) * smoothstep(1.0, 0.15, r));
            }
            col = vec3(0.05);
            a *= lines * 0.8;
            if (a < 0.03) discard;
          } else {                               // sand
            float sw = fbm(p*3.0 + vec2(uTime*0.3, 0.0) + uSeed);
            col = mix(vec3(0.78,0.66,0.44), vec3(0.62,0.5,0.32), sw);
            a *= 0.7;
          }
          a *= 1.0 - uFade;
          gl_FragColor = vec4(col, a);
        }`
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.copy(pos);
    this.mesh.position.y = (groundY ?? pos.y) + 0.04 + Math.random() * 0.01;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    this.u.uTime.value = this.t;
    const outStart = this.life * 0.65;
    this.u.uFade.value = this.t < outStart ? 0 : (this.t - outStart) / (this.life - outStart);
    if (this.t >= this.life) { this.dead = true; return false; }
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  ShockDome — expanding rim-lit hemisphere for slams / bursts.
 * ------------------------------------------------------------------ */
export class ShockDome {
  constructor(scene, { pos, radius = 9, life = 0.5, color = 0xcfe4ff } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.radius = radius; this.dead = false;
    const geo = new THREE.SphereGeometry(1, 22, 11, 0, Math.PI * 2, 0, Math.PI * 0.55);
    this.u = { uOpacity: { value: 0.6 }, uColor: { value: new THREE.Color(color) } };
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: this.u,
      vertexShader: `varying vec3 vN; varying vec3 vView;
        void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0);
        vView=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `precision highp float; varying vec3 vN; varying vec3 vView;
        uniform float uOpacity; uniform vec3 uColor;
        void main(){ float rim=pow(1.0-abs(dot(vN,vView)),2.2);
        gl_FragColor=vec4(uColor,(rim*0.65+0.02)*uOpacity); }`
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.copy(pos);
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    const s = this.radius * (1 - Math.pow(1 - k, 2.4));
    this.mesh.scale.setScalar(Math.max(0.2, s));
    this.u.uOpacity.value = 0.6 * Math.pow(1 - k, 1.4);
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  LightningBolt — jagged midpoint-displaced polyline + branches + flash.
 * ------------------------------------------------------------------ */
export class LightningBolt {
  constructor(scene, { from, to, color = 0xbfe8ff, branches = 2, life = 0.2, jitter = 1.0 } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    this.group = new THREE.Group();
    scene.add(this.group);

    const main = boltPoints(from, to, 6, jitter);
    this._addLine(main, color, 1.0);
    this._addLine(main, 0xffffff, 0.55);       // bright core, same path

    for (let b = 0; b < branches; b++) {
      const i = 1 + Math.floor(Math.random() * (main.length - 2));
      const a = main[i];
      const dir = _v.copy(to).sub(from).normalize();
      const off = new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5) * 0.5, (Math.random() - 0.5))
        .add(dir).normalize().multiplyScalar(2 + Math.random() * 3);
      this._addLine(boltPoints(a, a.clone().add(off), 4, jitter * 0.8), color, 0.7);
    }

    // impact flash
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.flash.position.copy(to);
    this.group.add(this.flash);
  }
  _addLine(pts, color, opacity) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    this.group.add(new THREE.Line(geo, mat));
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    const flick = (Math.random() > 0.35 ? 1 : 0.3) * (1 - k);
    this.group.traverse((c) => {
      if (!c.isLine) return;
      if (c.material.userData._base === undefined) c.material.userData._base = c.material.opacity;
      c.material.opacity = c.material.userData._base * flick;
    });
    const f = 1 - k;
    this.flash.scale.setScalar(0.6 + k * 3.5);
    this.flash.material.opacity = f * f;
    return true;
  }
  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
  }
}
function boltPoints(from, to, subdiv, jitter) {
  let pts = [from.clone(), to.clone()];
  const len = from.distanceTo(to);
  let amp = len * 0.14 * jitter;
  for (let s = 0; s < subdiv; s++) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const mid = a.clone().lerp(b, 0.5);
      mid.x += (Math.random() - 0.5) * amp;
      mid.y += (Math.random() - 0.5) * amp * 0.7;
      mid.z += (Math.random() - 0.5) * amp;
      next.push(a, mid);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
    amp *= 0.55;
  }
  return pts;
}

/* ------------------------------------------------------------------ *
 *  IceEncasement — grows a translucent ice shell on a target, shatters.
 * ------------------------------------------------------------------ */
export class IceEncasement {
  constructor(scene, { getPos, size = 1.5, hold = 1.4, color = 0xbfefff } = {}) {
    this.scene = scene; this.getPos = getPos; this.hold = hold; this.dead = false;
    this.phase = 'grow'; this.t = 0;
    this.group = new THREE.Group();
    scene.add(this.group);
    const geo = new THREE.IcosahedronGeometry(size, 1);
    const gp = geo.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      gp.setXYZ(i, gp.getX(i) * (0.85 + Math.random() * 0.4), gp.getY(i) * (1.0 + Math.random() * 0.5), gp.getZ(i) * (0.85 + Math.random() * 0.4));
    }
    geo.computeVertexNormals();
    this.shell = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      color, transparent: true, opacity: 0.55, shininess: 90, specular: 0xffffff, flatShading: true
    }));
    this.rim = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, wireframe: true, depthWrite: false
    }));
    this.group.add(this.shell, this.rim);
    this.group.scale.setScalar(0.01);
    this.size = size; this.color = new THREE.Color(color);
  }
  update(dt) {
    this.t += dt;
    const p = this.getPos ? this.getPos() : null;
    if (p) this.group.position.copy(p);
    if (this.phase === 'grow') {
      const k = Math.min(1, this.t / 0.18);
      this.group.scale.setScalar(k);
      if (k >= 1) { this.phase = 'hold'; this.t = 0; }
    } else if (this.phase === 'hold') {
      this.group.rotation.y += dt * 0.3;
      if (this.t >= this.hold) { this.phase = 'shatter'; this.t = 0; this._shatter(); }
    } else {
      const k = this.t / 0.5;
      for (const s of this._shards) {
        s.mesh.position.addScaledVector(s.vel, dt);
        s.vel.y -= 22 * dt;
        s.mesh.rotation.x += s.spin * dt;
        s.mesh.material.opacity = 0.7 * (1 - k);
      }
      this.shell.visible = this.rim.visible = false;
      if (k >= 1) { this.dead = true; return false; }
    }
    return true;
  }
  _shatter() {
    this._shards = [];
    const g = new THREE.TetrahedronGeometry(this.size * 0.35);
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ color: this.color, transparent: true, opacity: 0.7, flatShading: true, shininess: 80 }));
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6 + 0.2, Math.random() - 0.5).normalize();
      m.position.copy(dir).multiplyScalar(this.size * 0.4);
      this.group.add(m);
      this._shards.push({ mesh: m, vel: dir.clone().multiplyScalar(4 + Math.random() * 5), spin: (Math.random() - 0.5) * 12 });
    }
  }
  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
  }
}

/* ------------------------------------------------------------------ *
 *  CrackFX — jagged fracture lines radiating on the ground or in the air.
 * ------------------------------------------------------------------ */
export class CrackFX {
  constructor(scene, { pos, radius = 7, count = 6, life = 1.8, color = 0xdfeeff, dir, ground = true } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    if (ground) this.group.position.y += 0.06;
    scene.add(this.group);

    const baseAng = dir ? Math.atan2(dir.x, dir.z) : 0;
    const spread = dir ? 1.1 : Math.PI * 2;
    this.lines = [];
    for (let i = 0; i < count; i++) {
      const ang = baseAng + (dir ? (Math.random() - 0.5) * spread : (i / count) * Math.PI * 2 + Math.random() * 0.3);
      const pts = [new THREE.Vector3()];
      const steps = 5 + (Math.random() * 3 | 0);
      let cur = new THREE.Vector3();
      const step = radius / steps;
      for (let s = 0; s < steps; s++) {
        const wob = (Math.random() - 0.5) * 0.5;
        const a2 = ang + wob;
        cur = cur.clone().add(new THREE.Vector3(Math.sin(a2), 0, Math.cos(a2)).multiplyScalar(step * (0.7 + Math.random() * 0.6)));
        if (!ground) cur.y = Math.abs(cur.length()) * 0.15 * (Math.random() - 0.2);
        pts.push(cur.clone());
      }
      const geo = new THREE.BufferGeometry().setFromPoints(ground ? pts.map((p) => p) : pts);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
      const line = new THREE.Line(geo, mat);
      geo.setDrawRange(0, 2);
      this.group.add(line);
      this.lines.push({ line, total: pts.length });
    }
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    const draw = Math.min(1, this.t / 0.12);
    for (const l of this.lines) {
      l.line.geometry.setDrawRange(0, Math.max(2, Math.floor(2 + draw * (l.total - 2))));
      l.line.material.opacity = 0.95 * (this.t < this.life * 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
    }
    return true;
  }
  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
  }
}

/* ------------------------------------------------------------------ *
 *  HazardZone — lingering AoE field (fire / sand / frost) that ticks.
 * ------------------------------------------------------------------ */
const ZONE_KIND = { fire: 0, sand: 1, frost: 2 };
export class HazardZone {
  constructor(scene, { pos, radius = 4.5, kind = 'fire', duration = 5, groundY, onTick, tick = 0.45, onEmit, emit = 0.12 } = {}) {
    this.scene = scene; this.t = 0; this.duration = duration; this.dead = false;
    this.radius = radius; this.onTick = onTick; this.tick = tick; this._tt = 0;
    this.onEmit = onEmit; this.emit = emit; this._et = 0;
    this.center = pos.clone();

    const geo = new THREE.CircleGeometry(radius, 48);
    geo.rotateX(-Math.PI / 2);
    this.u = { uTime: { value: 0 }, uFade: { value: 0 }, uKind: { value: ZONE_KIND[kind] ?? 0 } };
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: (kind === 'fire' ? THREE.AdditiveBlending : THREE.NormalBlending),
      uniforms: this.u,
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv;
        uniform float uTime, uFade, uKind;
        ${GLSL_NOISE}
        void main(){
          vec2 p=(vUv-0.5)*2.0; float r=length(p); if(r>1.0) discard;
          float sw=fbm(p*3.0 + vec2(uTime*0.6, uTime*0.2));
          sw += 0.4*fbm(p*7.0 - vec2(uTime*1.1));
          float edge = smoothstep(1.0,0.7,r);
          vec3 col; float a;
          if(uKind<0.5){ col=mix(vec3(1.0,0.35,0.06), vec3(1.0,0.8,0.3), sw); a=edge*(0.35+0.5*sw); }
          else if(uKind<1.5){ col=mix(vec3(0.72,0.58,0.36), vec3(0.5,0.4,0.24), sw); a=edge*(0.62+0.3*sw); }
          else { col=mix(vec3(0.75,0.88,0.98), vec3(0.9,0.97,1.0), sw); a=edge*(0.65+0.25*sw); }
          a*=1.0-uFade;
          gl_FragColor=vec4(col,a);
        }`
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.copy(pos);
    this.mesh.position.y = (groundY ?? pos.y) + 0.06;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    this.u.uTime.value = this.t;
    const outStart = this.duration - 0.7;
    this.u.uFade.value = this.t < outStart ? 0 : Math.min(1, (this.t - outStart) / 0.7);
    if (this.t >= this.duration) { this.dead = true; return false; }
    this._tt += dt;
    if (this._tt >= this.tick) { this._tt = 0; this.onTick && this.onTick(this.center, this.radius); }
    this._et += dt;
    if (this.onEmit && this._et >= this.emit) {
      this._et = 0;
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * this.radius;
      this.onEmit(_v.set(this.center.x + Math.cos(a) * rr, this.center.y + 0.1, this.center.z + Math.sin(a) * rr).clone());
    }
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  LavaSea — a pool of molten rock that floods out from a point:
 *  undulating surface, dark cooled crust webbed with flowing bright
 *  cracks, bubbling hotspots. Expands, holds, then cools & fades.
 *  onTick(center, radius) / onEmit(surfacePos) hooks like HazardZone.
 * ------------------------------------------------------------------ */
export class LavaSea {
  constructor(scene, { pos, radius = 10, spread = 0.7, duration = 6, groundY, onTick, tick = 0.4, onEmit, emit = 0.16 } = {}) {
    this.scene = scene; this.t = 0; this.duration = duration; this.dead = false;
    this.radius = radius; this.spread = spread;
    this.center = pos.clone(); this.center.y = (groundY ?? pos.y);
    this.onTick = onTick; this.tick = tick; this._tt = 0;
    this.onEmit = onEmit; this.emit = emit; this._et = 0;

    const geo = new THREE.PlaneGeometry(radius * 2, radius * 2, 36, 36);
    geo.rotateX(-Math.PI / 2);
    this.u = { uTime: { value: 0 }, uFade: { value: 0 }, uGrow: { value: 0.02 } };
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide,
      uniforms: this.u,
      vertexShader: /* glsl */`
        precision highp float; varying vec2 vUv; uniform float uTime;
        ${GLSL_NOISE}
        void main(){
          vUv = uv;
          vec3 pos = position;
          float w = fbm(uv * 4.0 + vec2(uTime * 0.3, -uTime * 0.2));
          pos.y += (w - 0.5) * 0.35 + sin(uv.x * 12.0 + uTime * 2.0) * 0.05;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv;
        uniform float uTime, uFade, uGrow;
        ${GLSL_NOISE}
        void main(){
          vec2 p = (vUv - 0.5) * 2.0; float r = length(p);
          if (r > uGrow) discard;
          float flow = fbm(p * 2.5 + vec2(uTime * 0.22, -uTime * 0.16));
          flow += 0.5 * fbm(p * 6.0 + vec2(-uTime * 0.4, uTime * 0.28));
          float crack = pow(1.0 - abs(fract(flow * 3.0) - 0.5) * 2.0, 6.0);
          float hot = smoothstep(0.52, 0.92, flow);
          vec3 crust = mix(vec3(0.09,0.06,0.06), vec3(0.22,0.13,0.10), fbm(p * 10.0));
          vec3 lava = mix(vec3(1.0,0.32,0.04), vec3(1.0,0.75,0.28), hot);
          vec3 col = mix(crust, lava, clamp(crack + hot * 0.7, 0.0, 1.0));
          col += lava * crack * 0.8;
          float bub = smoothstep(0.9, 1.0, fbm(p * 8.0 + uTime * 1.6));
          col += vec3(1.0,0.6,0.22) * bub;
          col = mix(col, crust * 0.45, uFade);                 // cools to dark rock
          float edge = smoothstep(uGrow, uGrow - 0.14, r);
          float a = edge * (0.9 + 0.1 * flow) * (1.0 - uFade * 0.55);
          gl_FragColor = vec4(col, a);
        }`
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.copy(this.center);
    this.mesh.position.y += 0.06;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    this.u.uTime.value = this.t;
    this.u.uGrow.value = Math.min(1.02, 0.05 + (this.t / this.spread) * 1.0);
    const outStart = this.duration - 1.2;
    this.u.uFade.value = this.t < outStart ? 0 : Math.min(1, (this.t - outStart) / 1.2);
    if (this.t >= this.duration) { this.dead = true; return false; }
    const rad = this.radius * Math.min(1, this.t / this.spread);
    this._tt += dt;
    if (this._tt >= this.tick) { this._tt = 0; this.onTick && this.onTick(this.center, rad); }
    this._et += dt;
    if (this.onEmit && this._et >= this.emit) {
      this._et = 0;
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * rad;
      this.onEmit(_v.set(this.center.x + Math.cos(a) * rr, this.center.y + 0.12, this.center.z + Math.sin(a) * rr).clone());
    }
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  QuakeRing — a fat emissive shockwave torus that scales out and fades.
 * ------------------------------------------------------------------ */
export class QuakeRing {
  constructor(scene, { pos, radius = 12, life = 0.5, thickness = 0.6, color = 0xa89ec4, y = 0.2 } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.radius = radius; this.dead = false;
    const geo = new THREE.TorusGeometry(1, thickness, 8, 40);
    geo.rotateX(-Math.PI / 2);
    this.mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.copy(pos); this.mesh.position.y += y;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    const r = this.radius * (1 - Math.pow(1 - k, 2.2));
    this.mesh.scale.set(Math.max(0.1, r), 1 + k * 2.5, Math.max(0.1, r));
    this.mat.opacity = 0.9 * Math.pow(1 - k, 1.5);
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  FractureLine — a jagged ground crack that draws itself along `dir`
 *  over `grow` seconds (segment-by-segment reveal), then fades.
 * ------------------------------------------------------------------ */
export class FractureLine {
  constructor(scene, { from, dir, length = 18, width = 2.6, grow = 0.5, life = 3.4, color = 0xd9d0ee, groundY } = {}) {
    this.scene = scene; this.t = 0; this.grow = grow; this.life = life; this.dead = false;
    const d = _v.copy(dir).setY(0).normalize();
    const side = new THREE.Vector3(-d.z, 0, d.x);
    const y = (groundY ?? from.y) + 0.05;
    this.N = 24;
    const verts = new Float32Array((this.N + 1) * 2 * 3);
    for (let i = 0; i <= this.N; i++) {
      const f = i / this.N;
      const jag = (Math.random() - 0.5) * width * 0.6;
      const cx = from.x + d.x * length * f + side.x * jag;
      const cz = from.z + d.z * length * f + side.z * jag;
      const w = width * (0.4 + 0.6 * Math.sin(f * Math.PI)) * (1 - f * 0.35) + 0.12;
      verts.set([cx - side.x * w, y, cz - side.z * w, cx + side.x * w, y, cz + side.z * w], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    const idx = [];
    for (let i = 0; i < this.N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    this._maxTri = this.N * 6;
    this.mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    const gk = Math.min(1, this.t / this.grow);
    this.mesh.geometry.setDrawRange(0, Math.floor(gk * this.N) * 6);
    const outStart = this.life - 0.9;
    this.mat.opacity = 0.95 * (this.t < outStart ? 1 : Math.max(0, 1 - (this.t - outStart) / 0.9));
    if (this.t >= this.life) { this.dead = true; return false; }
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  TerrainShatter — flat rock plates over an area that drop / tilt out
 *  of alignment and settle, with glowing crack rims. Fakes the ground
 *  breaking into pieces for a quake ult.
 * ------------------------------------------------------------------ */
export class TerrainShatter {
  constructor(scene, { pos, radius = 16, count = 16, life = 3.2, groundY, color = 0x2a2634 } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.plates = [];
    const y = (groundY ?? pos.y);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * radius;
      const s = 2 + Math.random() * 4.5;
      const geo = new THREE.CircleGeometry(s, 5);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ color }));
      m.position.set(pos.x + Math.cos(a) * rr, y + 0.04, pos.z + Math.sin(a) * rr);
      m.rotation.y = Math.random() * 6.28;
      const rim = new THREE.Mesh(new THREE.RingGeometry(s * 0.82, s, 5),
        new THREE.MeshBasicMaterial({ color: 0xc9bff0, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
      rim.rotation.x = -Math.PI / 2; rim.position.y = 0.03;
      m.add(rim);
      this.group.add(m);
      this.plates.push({ m, rim, drop: 0.3 + Math.random() * 1.4, tiltX: (Math.random() - 0.5) * 0.35, tiltZ: (Math.random() - 0.5) * 0.35, delay: Math.random() * 0.25, y0: m.position.y });
    }
  }
  update(dt) {
    this.t += dt;
    if (this.t >= this.life) { this.dead = true; return false; }
    const fade = Math.max(0, 1 - Math.max(0, this.t - (this.life - 0.9)) / 0.9);
    for (const p of this.plates) {
      const k = Math.min(1, Math.max(0, (this.t - p.delay) / 0.35));
      const settle = 1 - Math.pow(1 - k, 3);
      p.m.position.y = p.y0 - p.drop * settle;
      p.m.rotation.x = p.tiltX * settle;
      p.m.rotation.z = p.tiltZ * settle;
      p.rim.material.opacity = 0.7 * fade * (0.55 + 0.45 * Math.sin(this.t * 6 + p.delay * 20));
    }
    return true;
  }
  dispose() { this.scene.remove(this.group); this.group.traverse((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); }); }
}

/* ------------------------------------------------------------------ *
 *  StretchLimb — a real elastic arm/leg from A toward B, with recoil.
 * ------------------------------------------------------------------ */
export class StretchLimb {
  constructor(scene, { getStart, dir, length = 8, radius = 0.18, color = 0xffb27a, life = 0.32, fist = true } = {}) {
    this.scene = scene; this.getStart = getStart; this.dir = dir.clone().normalize();
    this.length = length; this.life = life; this.t = 0; this.dead = false;
    const geo = new THREE.CylinderGeometry(radius * 0.8, radius, 1, 8);
    geo.translate(0, 0.5, 0);
    this.arm = new THREE.Mesh(geo, toonish(color));
    this.scene.add(this.arm);
    if (fist) {
      this.fist = new THREE.Mesh(new THREE.BoxGeometry(radius * 3.4, radius * 3.4, radius * 3.4), toonish(color, 0.15));
      this.scene.add(this.fist);
    }
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    const reach = k < 0.4 ? (k / 0.4) : 1 - (k - 0.4) / 0.6;    // punch out then snap back
    const start = this.getStart();
    const len = Math.max(0.001, this.length * reach);
    this.arm.position.copy(start);
    this.arm.quaternion.setFromUnitVectors(_UP, this.dir);
    this.arm.scale.set(1, len, 1);
    if (this.fist) {
      this.fist.position.copy(start).addScaledVector(this.dir, len);
      this.fist.rotation.x += dt * 20;
    }
    return true;
  }
  dispose() {
    this.scene.remove(this.arm); this.arm.geometry.dispose(); this.arm.material.dispose();
    if (this.fist) { this.scene.remove(this.fist); this.fist.geometry.dispose(); this.fist.material.dispose(); }
  }
}
const _UP = new THREE.Vector3(0, 1, 0);
function toonish(color, emissive = 0) {
  return new THREE.MeshToonMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(emissive) });
}

/* ------------------------------------------------------------------ *
 *  SplitBody — Bara Bara. Stand-in body chunks that either scatter and
 *  snap back to a (possibly new) point, or orbit the player as a
 *  spinning blade-storm. `mats` are the live character materials so the
 *  chunks match the current look (transforms included).
 * ------------------------------------------------------------------ */
export class SplitBody {
  constructor(scene, { getPos, mats, mode = 'scatter', duration = 0.6, radius = 3, blades = 6 } = {}) {
    this.scene = scene; this.getPos = getPos; this.mode = mode;
    this.t = 0; this.duration = duration; this.radius = radius; this.dead = false;
    this.group = new THREE.Group();
    scene.add(this.group);

    const mk = (w, h, d, mat, home) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.castShadow = true;
      m.userData.home = home.clone();
      m.userData.dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.7 + 0.25, Math.random() - 0.5).normalize();
      m.userData.spin = new THREE.Vector3((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
      this.group.add(m);
      return m;
    };
    this.chunks = [
      mk(0.72, 0.6, 0.42, mats.shirt, new THREE.Vector3(0, 1.28, 0)),
      mk(0.6, 0.36, 0.38, mats.skin, new THREE.Vector3(0, 0.9, 0)),
      mk(0.52, 0.5, 0.5, mats.skin, new THREE.Vector3(0, 1.95, 0)),
      mk(0.26, 0.7, 0.24, mats.shirt, new THREE.Vector3(-0.52, 1.3, 0)),
      mk(0.26, 0.7, 0.24, mats.shirt, new THREE.Vector3(0.52, 1.3, 0)),
      mk(0.26, 0.8, 0.28, mats.shorts, new THREE.Vector3(-0.2, 0.5, 0)),
      mk(0.26, 0.8, 0.28, mats.shorts, new THREE.Vector3(0.2, 0.5, 0))
    ];
    if (mats.straw) this.chunks.push(mk(0.66, 0.5, 0.66, mats.straw, new THREE.Vector3(0, 2.45, 0)));

    this.blades = [];
    if (mode === 'orbit') {
      this.bladeMat = new THREE.MeshToonMaterial({ color: 0xe4defc, emissive: 0x2a2440 });
      for (let i = 0; i < blades; i++) {
        const b = new THREE.Mesh(new THREE.ConeGeometry(0.14, 1.8, 4), this.bladeMat);
        b.geometry.rotateZ(Math.PI / 2);
        b.castShadow = true;
        this.group.add(b);
        this.blades.push(b);
      }
    }
  }
  update(dt) {
    this.t += dt;
    this.group.position.copy(this.getPos());

    if (this.mode === 'scatter') {
      const k = this.t / this.duration;
      if (k >= 1) { this.dead = true; return false; }
      // 0..0.22 explode outward · 0.22..0.72 float scattered · 0.72..1 rush back and vanish
      for (const ch of this.chunks) {
        ch.rotation.x += ch.userData.spin.x * dt;
        ch.rotation.y += ch.userData.spin.y * dt;
        ch.rotation.z += ch.userData.spin.z * dt;
        let p;
        if (k < 0.22) {
          const r = k / 0.22;
          p = ch.userData.home.clone().addScaledVector(ch.userData.dir, this.radius * (1 - Math.pow(1 - r, 2)));
        } else if (k < 0.72) {
          const fl = (k - 0.22) / 0.5;
          p = ch.userData.home.clone().addScaledVector(ch.userData.dir, this.radius);
          p.y += Math.sin(fl * Math.PI * 3 + ch.userData.home.y) * 0.35;   // bob while floating
          p.x += Math.sin(fl * 6 + ch.userData.home.x * 3) * 0.25;
        } else {
          const r = (k - 0.72) / 0.28;
          p = ch.userData.home.clone().addScaledVector(ch.userData.dir, this.radius).lerp(ch.userData.home, 1 - Math.pow(1 - r, 3));
        }
        ch.position.copy(p);
        ch.scale.setScalar(k > 0.9 ? Math.max(0, (1 - k) / 0.1) : 1);
      }
    } else {                              // orbit
      if (this.t >= this.duration) { this.dead = true; return false; }
      const fade = this.t > this.duration - 0.4 ? (this.duration - this.t) / 0.4 : 1;
      const spin = this.t * 7;
      this.chunks.forEach((ch, i) => {
        const a = spin + (i / this.chunks.length) * Math.PI * 2;
        const rad = this.radius * (0.7 + 0.3 * Math.sin(this.t * 3 + i)) * fade;
        ch.position.set(Math.cos(a) * rad, 1.2 + Math.sin(this.t * 4 + i) * 0.55, Math.sin(a) * rad);
        ch.rotation.x += 11 * dt; ch.rotation.y += 8 * dt;
      });
      this.blades.forEach((b, i) => {
        const a = -spin * 1.7 + (i / this.blades.length) * Math.PI * 2;
        b.position.set(Math.cos(a) * this.radius * 1.05 * fade, 1.2, Math.sin(a) * this.radius * 1.05 * fade);
        b.rotation.y = -a; b.rotation.x += 32 * dt;
      });
    }
    return true;
  }
  dispose() {
    this.scene.remove(this.group);
    this.chunks.forEach((c) => c.geometry.dispose());
    this.blades.forEach((b) => b.geometry.dispose());
    this.bladeMat && this.bladeMat.dispose();
  }
}

/* ------------------------------------------------------------------ *
 *  FlyingHands — Bara Bara. Both hands detach, arc to a target, strike,
 *  and return to the character's live hand positions.
 * ------------------------------------------------------------------ */
export class FlyingHands {
  constructor(scene, { getHomes, target, mat, onHit, onReturn, homeIdx = [0, 1], out = 0.3, back = 0.34, arc = 1.6 } = {}) {
    this.scene = scene; this.getHomes = getHomes; this.target = target.clone();
    this.onHit = onHit; this.onReturn = onReturn; this.homeIdx = homeIdx; this.arc = arc;
    this.t = 0; this.out = out; this.back = back; this.hit = false; this.dead = false;
    this.group = new THREE.Group();
    scene.add(this.group);
    const homes = getHomes();
    this.starts = homeIdx.map((i) => homes[i].clone());
    this.hands = homeIdx.map((i, j) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.36), mat);
      m.castShadow = true;
      m.position.copy(this.starts[j]);
      this.group.add(m);
      return m;
    });
  }
  update(dt) {
    this.t += dt;
    if (this.t < this.out) {
      const r = this.t / this.out, e = 1 - Math.pow(1 - r, 2);
      this.hands.forEach((h, j) => {
        h.position.lerpVectors(this.starts[j], this.target, e);
        h.position.y += Math.sin(r * Math.PI) * this.arc;
        h.rotation.x += 24 * dt; h.rotation.z += (j ? -20 : 20) * dt;
      });
    } else if (!this.hit) {
      this.hit = true;
      this.onHit && this.onHit(this.target.clone());
    } else {
      const r = Math.min(1, (this.t - this.out) / this.back);
      const e = 1 - Math.pow(1 - r, 3);
      const homes = this.getHomes();
      this.hands.forEach((h, j) => {
        h.position.lerpVectors(this.target, homes[this.homeIdx[j]], e);
        h.position.y += Math.sin(r * Math.PI) * this.arc * 0.35;
        h.rotation.x += 16 * dt;
      });
      if (r >= 1) { this.onReturn && this.onReturn(); this.dead = true; return false; }
    }
    return true;
  }
  dispose() {
    this.scene.remove(this.group);
    this.hands.forEach((h) => h.geometry.dispose());
  }
}

/* ------------------------------------------------------------------ *
 *  SandTornado — Suna Suna. A towering rotating funnel of sand with
 *  orbiting blade shards. Exposes .center / .radius so the ability can
 *  pull + grind enemies each tick.
 * ------------------------------------------------------------------ */
export class SandTornado {
  constructor(scene, { center, radius = 5, height = 14, life = 3.4, blades = 14, color = 0xdcc089 } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    this.center = center.clone(); this.radius = radius; this.height = height;
    this.group = new THREE.Group();
    this.group.position.copy(center);
    scene.add(this.group);

    this.u = { uTime: { value: 0 }, uFade: { value: 1 }, uColor: { value: new THREE.Color(color) } };
    const geo = new THREE.CylinderGeometry(radius, radius * 0.26, height, 26, 9, true);
    geo.translate(0, height / 2, 0);
    this.funnel = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: this.u,
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv; uniform float uTime, uFade; uniform vec3 uColor;
        ${GLSL_NOISE}
        void main(){
          float sw = fbm(vec2(vUv.x*8.0 + uTime*3.2, vUv.y*3.0 - uTime*1.6));
          sw += 0.5*fbm(vec2(vUv.x*18.0 - uTime*5.0, vUv.y*6.0));
          float streak = smoothstep(0.4, 0.7, fract(vUv.x*11.0 + uTime*2.2 + sw));
          float a = (0.32 + 0.5*sw) * (0.55 + 0.45*streak) * (1.0 - uFade);
          a *= smoothstep(1.0, 0.7, vUv.y) * smoothstep(0.0, 0.12, vUv.y);
          vec3 col = mix(uColor*0.72, uColor*1.15, sw);
          gl_FragColor = vec4(col, a);
        }`
    }));
    this.group.add(this.funnel);

    this.bmat = new THREE.MeshToonMaterial({
      color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45),
      emissive: new THREE.Color(color).multiplyScalar(0.14)
    });
    this.blades = [];
    for (let i = 0; i < blades; i++) {
      const b = new THREE.Mesh(new THREE.ConeGeometry(0.14, 1.5, 4), this.bmat);
      b.userData.h = Math.random();
      b.userData.a = Math.random() * Math.PI * 2;
      b.userData.rr = 0.55 + Math.random() * 0.5;
      b.castShadow = true;
      this.group.add(b);
      this.blades.push(b);
    }
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    this.u.uTime.value = this.t;
    this.u.uFade.value = k < 0.12 ? 1 - k / 0.12 : (k > 0.85 ? (k - 0.85) / 0.15 : 0);
    this.funnel.rotation.y += dt * 3.2;
    const spin = this.t * 6.5;
    for (const b of this.blades) {
      const rad = THREE.MathUtils.lerp(this.radius * 0.26, this.radius, b.userData.h) * b.userData.rr;
      const a = b.userData.a + spin * (1 + b.userData.h * 0.8);
      b.position.set(Math.cos(a) * rad, b.userData.h * this.height + Math.sin(this.t * 4 + b.userData.h * 6) * 0.5, Math.sin(a) * rad);
      b.rotation.set(0, -a, 1.25);
      b.rotation.x += 22 * dt;
    }
    return true;
  }
  dispose() {
    this.scene.remove(this.group);
    this.funnel.geometry.dispose(); this.funnel.material.dispose();
    this.blades.forEach((b) => b.geometry.dispose());
    this.bmat.dispose();
  }
}

/* ------------------------------------------------------------------ *
 *  SpringCoil — Bane Bane. A stack of rings that snaps from compressed
 *  to fully extended along an axis (legs coiling for a launch, an arm
 *  coiling for a piston punch), then fades.
 * ------------------------------------------------------------------ */
export class SpringCoil {
  constructor(scene, { getPos, axis = new THREE.Vector3(0, 1, 0), color = 0x8fe08f, life = 0.24, coils = 5, length = 1.8, radius = 0.42 } = {}) {
    this.scene = scene; this.getPos = getPos; this.t = 0; this.life = life; this.dead = false;
    this.length = length;
    this.group = new THREE.Group();
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize());
    scene.add(this.group);
    this.mat = new THREE.MeshToonMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.15), transparent: true });
    this.rings = [];
    for (let i = 0; i < coils; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(radius * (1 - i * 0.07), 0.075, 6, 16), this.mat);
      r.rotation.x = Math.PI / 2;
      this.group.add(r);
      this.rings.push(r);
    }
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    this.group.position.copy(this.getPos());
    const ext = k < 0.4 ? 0.14 : 0.14 + ((k - 0.4) / 0.6) * (1 - Math.pow(1 - (k - 0.4) / 0.6, 2)) * 0.86;
    const n = this.rings.length - 1;
    this.rings.forEach((r, i) => {
      r.position.y = (i / n) * this.length * ext;
      r.scale.setScalar(1 - k * 0.25);
    });
    this.mat.opacity = 1 - k;
    return true;
  }
  dispose() {
    this.scene.remove(this.group);
    this.rings.forEach((r) => r.geometry.dispose());
    this.mat.dispose();
  }
}

/* ------------------------------------------------------------------ *
 *  Beam — a sustained energy stream (flamethrower, lightning stream,
 *  magma jet). Follows a live origin/direction; fades in and out.
 * ------------------------------------------------------------------ */
export class Beam {
  constructor(scene, { getFrom, getDir, length = 18, radius = 0.8, life = 0.9, color = 0xff6a24, core = 0xffe08a } = {}) {
    this.scene = scene; this.getFrom = getFrom; this.getDir = getDir;
    this.length = length; this.life = life; this.t = 0; this.dead = false;
    this.u = { uTime: { value: 0 }, uFade: { value: 0 }, uColor: { value: new THREE.Color(color) }, uCore: { value: new THREE.Color(core) } };
    const geo = new THREE.CylinderGeometry(radius, radius * 1.35, 1, 14, 1, true);
    geo.translate(0, 0.5, 0);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: this.u,
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv; uniform float uTime, uFade; uniform vec3 uColor, uCore;
        ${GLSL_NOISE}
        void main(){
          float n = fbm(vec2(vUv.x*6.0, vUv.y*4.0 - uTime*7.0));
          float core = smoothstep(0.55, 0.05, abs(vUv.x - 0.5));
          float body = (0.28 + 0.5*n);
          float taper = smoothstep(1.0, 0.7, vUv.y);
          float a = body * taper * (1.0 - uFade) * 0.7;
          vec3 col = mix(uColor, uCore, core*0.6 + n*0.15);
          gl_FragColor = vec4(col * (0.9 + n*0.4), a);
        }`
    }));
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    this.u.uTime.value = this.t;
    this.u.uFade.value = k < 0.15 ? (0.15 - k) / 0.15 * 0.6 : Math.max(0, (k - 0.7) / 0.3);
    const from = this.getFrom(); const dir = this.getDir().clone().normalize();
    this.mesh.position.copy(from);
    this.mesh.quaternion.setFromUnitVectors(_UP, dir);
    const wob = 1 + Math.sin(this.t * 40) * 0.06;
    this.mesh.scale.set(wob, this.length, wob);
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  GiantArm — a huge stylised fist that winds up and slams a point.
 *  `onHit(pos)` fires at the strike apex.
 * ------------------------------------------------------------------ */
export class GiantArm {
  constructor(scene, { from, to, color = 0xffe0c0, scale = 1, life = 0.75, onHit } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.onHit = onHit; this._hit = false; this.dead = false;
    this.from = from.clone(); this.to = to.clone();
    this.group = new THREE.Group();
    scene.add(this.group);
    const mat = new THREE.MeshToonMaterial({ color });
    const s = scale;
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.6 * s, 0.9 * s, 4 * s, 10), mat);
    fore.rotation.z = Math.PI / 2; fore.position.x = -2.4 * s;
    const fist = new THREE.Mesh(new THREE.BoxGeometry(2.4 * s, 2.4 * s, 2.4 * s), mat);
    const knuck = new THREE.Mesh(new THREE.BoxGeometry(2.5 * s, 0.8 * s, 2.5 * s), mat);
    knuck.position.y = 1.0 * s;
    this.group.add(fore, fist, knuck);
    this.group.traverse((c) => { if (c.isMesh) c.castShadow = true; });
    this._dir = to.clone().sub(from).normalize();
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), this._dir);
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    let p;
    if (k < 0.28) {                       // wind up (pull back past the origin)
      const r = k / 0.28;
      p = this.from.clone().addScaledVector(this._dir, -6 * (1 - Math.pow(1 - r, 2)));
      this.group.scale.setScalar(0.4 + r * 0.7);
    } else if (k < 0.5) {                 // strike
      const r = (k - 0.28) / 0.22;
      p = this.from.clone().addScaledVector(this._dir, -6).lerp(this.to, 1 - Math.pow(1 - r, 3));
      this.group.scale.setScalar(1.1);
      if (!this._hit && r > 0.8) { this._hit = true; this.onHit && this.onHit(this.to.clone()); }
    } else {                             // recoil + fade
      const r = (k - 0.5) / 0.5;
      p = this.to.clone().addScaledVector(this._dir, -3 * r);
      this.group.scale.setScalar(1.1 - r * 0.6);
      this.group.traverse((c) => { if (c.material && c.material.opacity !== undefined) { c.material.transparent = true; c.material.opacity = 1 - r; } });
    }
    this.group.position.copy(p);
    return true;
  }
  dispose() { this.scene.remove(this.group); this.group.traverse((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); }); }
}

/* ------------------------------------------------------------------ *
 *  SeaClash — Whitebeard's quake: two ocean walls rise and slam
 *  together with a colossal spray, then collapse. `onClash` fires at
 *  the moment of impact so the ability can apply damage + flash.
 * ------------------------------------------------------------------ */
export class SeaClash {
  constructor(scene, { center, dir, width = 46, height = 16, life = 1.7, onClash } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    this.onClash = onClash; this._clashed = false;
    this.group = new THREE.Group();
    this.group.position.copy(center);
    const yaw = dir ? Math.atan2(dir.x, dir.z) : 0;
    this.group.rotation.y = yaw;
    scene.add(this.group);

    const geo = new THREE.PlaneGeometry(width, height, 30, 10);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / (width * 0.5);          // -1..1
      p.setZ(i, -Math.cos(x * Math.PI * 0.5) * 6);   // concave, cupping inward
      p.setY(i, p.getY(i) + Math.sin(x * 3.0) * 0.6);
    }
    geo.computeVertexNormals();

    this.u = { uTime: { value: 0 }, uFade: { value: 0 } };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: this.u,
      vertexShader: `varying vec2 vUv; varying vec3 vPos;
        void main(){ vUv=uv; vPos=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv; varying vec3 vPos;
        uniform float uTime, uFade;
        ${GLSL_NOISE}
        void main(){
          float g = clamp(vUv.y, 0.0, 1.0);                       // base -> crest
          float n = fbm(vec2(vUv.x*6.0, vUv.y*3.0 - uTime*2.6));
          n += 0.4*fbm(vec2(vUv.x*14.0 + uTime, vUv.y*7.0));
          vec3 deep = vec3(0.03,0.20,0.42);
          vec3 shallow = vec3(0.12,0.55,0.72);
          vec3 col = mix(deep, shallow, g*0.7 + n*0.3);
          float foam = smoothstep(0.72, 1.0, g + n*0.35);
          col = mix(col, vec3(0.95,0.99,1.0), foam);
          float a = (0.82 + 0.18*n) * (1.0 - uFade);
          gl_FragColor = vec4(col, a);
        }`
    });

    this.wallL = new THREE.Mesh(geo, mat);
    this.wallR = new THREE.Mesh(geo, mat);
    this.wallR.rotation.y = Math.PI;
    this.group.add(this.wallL, this.wallR);
    this.spread = width * 0.5 + 6;
    this.wallL.position.set(-this.spread, -height, 0);
    this.wallR.position.set(this.spread, -height, 0);
    this.height = height;
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    this.u.uTime.value = this.t;

    if (k < 0.42) {                       // rise + rush inward
      const r = k / 0.42;
      const ease = 1 - Math.pow(1 - r, 3);
      const x = THREE.MathUtils.lerp(this.spread, 3.5, ease);
      const y = THREE.MathUtils.lerp(-this.height, -1, ease);
      this.wallL.position.set(-x, y, 0);
      this.wallR.position.set(x, y, 0);
    } else if (!this._clashed) {          // CLASH
      this._clashed = true;
      this.wallL.position.x = -1; this.wallR.position.x = 1;
      this.wallL.position.y = this.wallR.position.y = -0.5;
      this.onClash && this.onClash(this.group.position.clone());
    } else {                             // collapse outward + sink + fade
      const r = (k - 0.42) / 0.58;
      this.wallL.position.x = -1 - r * 10;
      this.wallR.position.x = 1 + r * 10;
      this.wallL.position.y = this.wallR.position.y = -0.5 - r * 8;
      this.u.uFade.value = Math.max(0, (r - 0.4) / 0.6);
    }
    return true;
  }
  dispose() {
    this.scene.remove(this.group);
    this.wallL.geometry.dispose();
    this.wallL.material.dispose();
  }
}

/* ------------------------------------------------------------------ *
 *  WaterWave — a real 3-D shock-ring of water: a band of surface rushes
 *  outward from a point, the leading edge rears up into a curling,
 *  foam-capped crest with fbm chop, then it flattens and fades. The
 *  `spray` callback fires along the crest so the caller can add droplets.
 * ------------------------------------------------------------------ */
export class WaterWave {
  constructor(scene, {
    pos, maxR = 22, width = 4.5, crest = 3.2, life = 1.4, groundY,
    body = 0x1f6fc0, foam = 0xeaf6ff, spray
  } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    this.maxR = maxR; this.spray = spray;
    this._center = pos.clone(); this._gy = (groundY ?? pos.y);

    const geo = new THREE.RingGeometry(0.02, maxR, 160, 48);   // 48 radial rings = a smooth curling crest
    geo.rotateX(-Math.PI / 2);

    this.u = {
      uTime: { value: 0 }, uK: { value: 0 }, uFront: { value: 0 }, uFade: { value: 0 },
      uMaxR: { value: maxR }, uWidth: { value: width }, uCrest: { value: crest },
      uBody: { value: new THREE.Color(body) }, uFoam: { value: new THREE.Color(foam) }
    };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: this.u,
      vertexShader: /* glsl */`
        precision highp float;
        uniform float uTime, uFront, uWidth, uCrest, uMaxR;
        varying float vU;      // 0 = trailing edge .. 1 = crest/front
        varying float vFoam;
        varying vec3 vN;
        ${GLSL_NOISE}
        void main(){
          vec3 p = position;
          float r = length(p.xz);
          float back = uFront - uWidth;
          float u = clamp((r - back) / max(uWidth, 0.001), 0.0, 1.0);
          if (r > uFront || u <= 0.0) { u = 0.0; }
          vU = u;
          // crest profile: swells toward the front, lips over at the very edge
          float hump = smoothstep(0.0, 0.55, u);
          float lip  = smoothstep(0.80, 1.0, u);
          p.xz *= (1.0 - lip * 0.11);                       // the crest curls inward
          float chop = (fbm(p.xz * 0.9 + uTime * vec2(1.4, -0.9)) - 0.5) * 0.45
                     + (fbm(p.xz * 2.6 - uTime * 1.7) - 0.5) * 0.18;
          p.y += (hump * 0.75 + lip * 0.55 + chop * step(0.06, u)) * uCrest;
          if (u <= 0.0) p.y -= 40.0;                        // hide the rest of the disc
          vFoam = smoothstep(0.55, 1.0, u) + max(0.0, chop) * 0.9;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vN = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uK, uFade;
        uniform vec3 uBody, uFoam;
        varying float vU; varying float vFoam; varying vec3 vN;
        void main(){
          if (vU <= 0.001) discard;
          float foam = clamp(vFoam, 0.0, 1.0);
          vec3 col = mix(uBody, uFoam, foam * foam);
          col += pow(1.0 - abs(vN.y), 2.0) * 0.25;          // fresnel-ish rim
          float edge = smoothstep(0.0, 0.25, vU);           // soft trailing edge
          float a = edge * (0.55 + 0.4 * foam) * (1.0 - uFade) * smoothstep(0.0, 0.12, uK);
          gl_FragColor = vec4(col, a);
        }`
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(pos);
    this.mesh.position.y = this._gy + 0.05;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this._sprayT = 0;
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    this.u.uTime.value = this.t;
    this.u.uK.value = k;
    const ease = 1 - Math.pow(1 - k, 2.4);                  // fast front, easing out
    this.u.uFront.value = 1.5 + ease * (this.maxR - 1.5);
    this.u.uFade.value = k < 0.68 ? 0 : (k - 0.68) / 0.32;

    if (this.spray && k < 0.8) {
      this._sprayT += dt;
      if (this._sprayT > 0.045) {
        this._sprayT = 0;
        const front = this.u.uFront.value;
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          _v.set(this._center.x + Math.cos(a) * front, this._gy + this.u.uCrest.value * 0.8, this._center.z + Math.sin(a) * front);
          this.spray(_v.clone());
        }
      }
    }
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  WindGust — a colossal directional gale: layered sheets of streaking
 *  air blow forward along `dir`, a bright leading edge races down the
 *  length, then it fades. For pressure-wave / airquake blasts.
 * ------------------------------------------------------------------ */
export class WindGust {
  constructor(scene, { pos, dir, length = 20, width = 9, life = 1.0, color = 0xdfe6f2 } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    this.group.rotation.y = Math.atan2(dir.x, dir.z);
    scene.add(this.group);

    this.u = { uTime: { value: 0 }, uProg: { value: 0 }, uFade: { value: 0 }, uColor: { value: new THREE.Color(color) } };
    this._mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: this.u,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){
          vUv = uv;
          vec3 p = position;
          p.y += sin(uv.x * 3.14159) * 0.7;      // bow the sheet up in the middle
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv;
        uniform float uTime, uProg, uFade; uniform vec3 uColor;
        ${GLSL_NOISE}
        void main(){
          float s = fbm(vec2(vUv.y * 9.0, vUv.x * 2.5 - uTime * 7.0));
          s += 0.5 * fbm(vec2(vUv.y * 20.0, vUv.x * 5.0 - uTime * 12.0));
          float streak = pow(smoothstep(0.45, 0.95, s), 2.0);
          float front = smoothstep(uProg - 0.12, uProg, vUv.x) * (1.0 - smoothstep(uProg, uProg + 0.18, vUv.x));
          float body  = smoothstep(0.0, 0.18, vUv.x) * (1.0 - smoothstep(uProg + 0.1, 1.0, vUv.x));
          float edgeY = 1.0 - pow(abs(vUv.y - 0.5) * 2.0, 2.0);
          float a = (streak * body * 0.5 + front * 0.9) * edgeY * (1.0 - uFade);
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor + front * 0.4, a);
        }`
    });
    this._geo = new THREE.PlaneGeometry(length, width, 44, 6);
    this._geo.rotateX(-Math.PI / 2);            // lie flat: X = length (gust axis), Z = width
    this._geo.translate(length / 2, 0, 0);      // start at the origin
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(this._geo, this._mat);
      m.position.y = 0.6 + i * 0.85;
      m.rotation.z = (i - 1) * 0.12;            // slight bank per layer
      this.group.add(m);
    }
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    this.u.uTime.value = this.t;
    this.u.uProg.value = Math.min(1.15, 1 - Math.pow(1 - Math.min(1, k / 0.5), 2.5));
    this.u.uFade.value = k < 0.6 ? 0 : (k - 0.6) / 0.4;
    return true;
  }
  dispose() { this.scene.remove(this.group); this._geo.dispose(); this._mat.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  TransformAura — persistent aura while a Zoan form is active.
 *  Dies when `while_` returns false (then fades), or after `duration`.
 * ------------------------------------------------------------------ */
export class TransformAura {
  constructor(scene, { getPos, color = 0x9fd0ff, radius = 1.8, duration = 30, while_ } = {}) {
    this.scene = scene; this.getPos = getPos; this.while_ = while_;
    this.t = 0; this.duration = duration; this.dead = false; this.fadeOut = 0;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.u = { uTime: { value: 0 }, uFade: { value: 0 }, uColor: { value: new THREE.Color(color) } };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: this.u,
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv; uniform float uTime, uFade; uniform vec3 uColor;
        ${GLSL_NOISE}
        void main(){
          float g = vUv.y;
          float n = fbm(vec2(vUv.x*8.0, vUv.y*3.0 - uTime*4.0));
          float a = (1.0-g) * (0.12 + 0.22*n) * (1.0-uFade);
          if (a < 0.02) discard;
          gl_FragColor = vec4(uColor * (1.05 + n*0.5), a);
        }`
    });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(radius, radius * 2.0, 16, 6, true), mat);
    cone.position.y = radius;
    this.group.add(cone);
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.9, radius * 1.5, 28), mat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06;
    this.group.add(ring);
    this.cone = cone; this.ring = ring;
  }
  update(dt) {
    this.t += dt;
    this.u.uTime.value = this.t;
    if (this.getPos) this.group.position.copy(this.getPos());
    const stop = (this.while_ && !this.while_()) || this.t > this.duration;
    if (stop) this.fadeOut += dt;
    this.u.uFade.value = Math.min(1, this.fadeOut / 0.35);
    this.cone.rotation.y += dt * 2.5;
    this.cone.scale.setScalar(1 + Math.sin(this.t * 8) * 0.04);
    if (this.fadeOut > 0.35) { this.dead = true; return false; }
    return true;
  }
  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((c) => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
  }
}

/* ------------------------------------------------------------------ *
 *  ElectricPrison — a spiky semi-transparent energy sphere that snaps
 *  around a target: branching-lightning surface, bright core, scales in,
 *  holds, then collapses inward. Follows getPos().
 * ------------------------------------------------------------------ */
export class ElectricPrison {
  constructor(scene, { getPos, radius = 2.2, hold = 1.6, color = 0x8fdcff } = {}) {
    this.scene = scene; this.getPos = getPos; this.radius = radius; this.hold = hold;
    this.t = 0; this.phase = 'in'; this.dead = false; this._t0 = 0;
    this.u = { uTime: { value: 0 }, uAmt: { value: 0 }, uColor: { value: new THREE.Color(color) }, uCore: { value: new THREE.Color(0xffffff) } };
    const geo = new THREE.IcosahedronGeometry(radius, 4);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: this.u,
      vertexShader: `varying vec3 vP; varying vec3 vN;
        void main(){ vP = normalize(position); vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `precision highp float; varying vec3 vP; varying vec3 vN;
        uniform float uTime, uAmt; uniform vec3 uColor, uCore;
        ${GLSL_NOISE}
        void main(){
          vec2 uv = vec2(atan(vP.z, vP.x) * 1.6, vP.y * 3.0);
          float n = fbm(uv * 2.0 + uTime * 1.5);
          float branch = fbm(uv * 6.0 - uTime * 3.0);
          float veins = pow(1.0 - abs(branch - 0.5) * 2.0, 8.0);
          veins += pow(1.0 - abs(n - 0.5) * 2.0, 5.0) * 0.6;
          float rim = pow(1.0 - abs(dot(vN, vec3(0.0, 0.0, 1.0))), 2.0);
          float spikes = step(0.58, fbm(uv * 10.0 + uTime * 4.0));
          float a = (veins * 0.9 + rim * 0.5 + spikes * 0.3) * uAmt;
          if (a < 0.02) discard;
          gl_FragColor = vec4(mix(uColor, uCore, clamp(veins, 0.0, 1.0)), a);
        }`
    });
    this.mesh = new THREE.Mesh(geo, mat);
    scene.add(this.mesh);
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.28, 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(this.core);
  }
  update(dt) {
    this.t += dt;
    this.u.uTime.value = this.t;
    const p = this.getPos && this.getPos();
    if (p) { this.mesh.position.copy(p); this.core.position.copy(p); }
    let amt = 1, s = 1;
    if (this.phase === 'in') {
      const k = Math.min(1, this.t / 0.3);
      amt = k; s = 0.4 + 0.6 * (1 - Math.pow(1 - k, 3));
      if (this.t >= 0.3) this.phase = 'hold';
    } else if (this.phase === 'hold') {
      s = 1 + Math.sin(this.t * 20) * 0.02;
      if (this.t >= 0.3 + this.hold) { this.phase = 'out'; this._t0 = this.t; }
    } else {
      const k = (this.t - this._t0) / 0.22;
      if (k >= 1) { this.dead = true; return false; }
      amt = 1 - k; s = 1 - 0.55 * k;
    }
    this.mesh.scale.setScalar(s);
    this.core.scale.setScalar(this.phase === 'out' ? s * (1 + (this.t - this._t0) * 7) : s);
    this.u.uAmt.value = amt;
    this.core.material.opacity = 0.9 * amt;
    this.mesh.rotation.y += dt * 1.6;
    return true;
  }
  dispose() {
    this.scene.remove(this.mesh); this.scene.remove(this.core);
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.core.geometry.dispose(); this.core.material.dispose();
  }
}

/* ------------------------------------------------------------------ *
 *  StormCloud — a churning dark disc high above a zone with a faint
 *  inner lightning glow. Lives `duration` seconds, fades in / out.
 * ------------------------------------------------------------------ */
export class StormCloud {
  constructor(scene, { pos, radius = 12, height = 22, duration = 3, color = 0x1a2438 } = {}) {
    this.scene = scene; this.t = 0; this.duration = duration; this.dead = false;
    this.u = { uTime: { value: 0 }, uFade: { value: 1 }, uColor: { value: new THREE.Color(color) } };
    const geo = new THREE.CircleGeometry(radius, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide, uniforms: this.u,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `precision highp float; varying vec2 vUv; uniform float uTime, uFade; uniform vec3 uColor;
        ${GLSL_NOISE}
        void main(){
          vec2 p = (vUv - 0.5) * 2.0; float r = length(p); if (r > 1.0) discard;
          float c = fbm(p * 3.0 + uTime * 0.3) + 0.5 * fbm(p * 7.0 - uTime * 0.5);
          float edge = smoothstep(1.0, 0.5, r);
          float flick = 0.82 + 0.18 * sin(uTime * 13.0 + c * 22.0);
          float a = edge * (0.5 + 0.35 * c) * (1.0 - uFade) * 0.85;
          gl_FragColor = vec4(mix(uColor, vec3(0.45, 0.6, 0.9), pow(c, 3.0) * 0.35) * flick, a);
        }`
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(pos); this.mesh.position.y = (pos.y || 0) + height;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt; this.u.uTime.value = this.t;
    const fadeIn = Math.min(1, this.t / 0.4);
    const fadeOut = Math.max(0, (this.t - (this.duration - 0.6)) / 0.6);
    this.u.uFade.value = Math.max(1 - fadeIn, fadeOut);
    if (this.t > this.duration) { this.dead = true; return false; }
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  LightningRibbon — a jagged tapered additive strip A->B, fades fast.
 *  Dash / blink trail.
 * ------------------------------------------------------------------ */
export class LightningRibbon {
  constructor(scene, { from, to, width = 0.5, life = 0.4, color = 0x9fdcff } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    const dir = _v.copy(to).sub(from);
    const len = Math.max(0.001, dir.length()); dir.normalize();
    const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const N = 14;
    const pos = new Float32Array((N + 1) * 2 * 3);
    const c = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const env = Math.sin(f * Math.PI);
      const jit = (Math.random() - 0.5) * 0.9 * env;
      c.copy(from).addScaledVector(dir, len * f).addScaledVector(side, jit);
      const w = width * env * 1.4 + 0.05;
      pos.set([c.x - side.x * w, c.y - side.y * w, c.z - side.z * w, c.x + side.x * w, c.y + side.y * w, c.z + side.z * w], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const idx = [];
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    this.mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, this.mat);
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    this.mat.opacity = 0.9 * (1 - k) * (1 - k);
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  Flipbook — a camera-facing quad that plays one grid-atlas frame
 *  sequence over its lifetime. Used for the painterly "hero" beats
 *  (impact flash, muzzle flash, big flame, smoke, energy core).
 *    { tex, cols, rows, frames, size, life, color, additive, spin,
 *      rise, loop, fadeIn, hold }
 * ------------------------------------------------------------------ */
export class Flipbook {
  constructor(scene, o = {}) {
    this.scene = scene; this.t = 0; this.dead = false;
    this.life = o.life ?? 0.6;
    this.frames = o.frames ?? 16;
    this.loop = !!o.loop;
    this.rise = o.rise ?? 0;
    this._pos = (o.pos || new THREE.Vector3()).clone();
    // `spin`: true = random roll (old behaviour), a number = that exact roll (rad).
    // `flat` + `yaw`: lay the sprite FLAT on the ground (world XZ plane) rotated
    //   by `yaw`, instead of the default camera-facing billboard — lets a sweep
    //   sprite actually follow a world-space arc direction.
    // `color2`: if set, the sprite fades from `color` (trailing edge, vUv.x=0)
    //   to `color2` (leading edge, vUv.x=1).
    this._flat = !!o.flat;
    this.u = {
      uTex: { value: o.tex },
      uGrid: { value: new THREE.Vector2(o.cols ?? 4, o.rows ?? 4) },
      uFrame: { value: 0 },
      uColor: { value: new THREE.Color(o.color ?? 0xffffff) },
      uColor2: { value: new THREE.Color(o.color2 ?? o.color ?? 0xffffff) },
      uTwo: { value: o.color2 != null ? 1 : 0 },
      uAlpha: { value: 1 },
      uSize: { value: o.size ?? 4 },
      uSpin: { value: typeof o.spin === 'number' ? o.spin : (o.spin ? (Math.random() - 0.5) * 6.28 : 0) },
      uFlat: { value: this._flat ? 1 : 0 },
      uYaw: { value: o.yaw ?? 0 },
    };
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      blending: (o.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending),
      uniforms: this.u,
      vertexShader: /* glsl */`
        uniform float uSize, uSpin, uFlat, uYaw; varying vec2 vUv;
        void main(){
          vUv = uv;
          float s = sin(uSpin), c = cos(uSpin);
          vec2 q = mat2(c, -s, s, c) * position.xy;
          vec3 wp0 = (modelMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
          vec3 wp;
          if (uFlat > 0.5) {
            float sy = sin(uYaw), cy = cos(uYaw);
            wp = wp0 + vec3(q.x * cy - q.y * sy, 0.0, q.x * sy + q.y * cy) * uSize;
          } else {
            vec3 camR = vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]);
            vec3 camU = vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]);
            wp = wp0 + (camR * q.x + camU * q.y) * uSize;
          }
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv;
        uniform sampler2D uTex; uniform vec2 uGrid; uniform float uFrame, uAlpha, uTwo; uniform vec3 uColor, uColor2;
        void main(){
          float f = floor(uFrame);
          float col = mod(f, uGrid.x);
          float row = floor(f / uGrid.x);
          vec2 cell = (vUv + vec2(col, uGrid.y - 1.0 - row)) / uGrid;   // atlas row 0 = top
          vec4 t = texture2D(uTex, cell);
          vec3 tint = mix(uColor, mix(uColor, uColor2, vUv.x), uTwo);
          gl_FragColor = vec4(t.rgb * tint, t.a * uAlpha);
        }`,
    });
    this.mesh = new THREE.Mesh(_QUAD, this.mat);
    this.mesh.position.copy(this._pos);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    let k = this.t / this.life;
    if (k >= 1) {
      if (!this.loop) { this.dead = true; return false; }
      k -= Math.floor(k); this.t = k * this.life;
    }
    this.u.uFrame.value = Math.min(this.frames - 1, Math.floor(k * this.frames));
    // ease alpha in fast, out over the tail
    this.u.uAlpha.value = Math.min(1, k / 0.12) * (k > 0.6 ? Math.max(0, 1 - (k - 0.6) / 0.4) : 1);
    if (this.rise) { this._pos.y += this.rise * dt; this.mesh.position.copy(this._pos); }
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mat.dispose(); }
}
const _QUAD = new THREE.PlaneGeometry(1, 1);

/* ------------------------------------------------------------------ *
 *  Chains — heavy shackle-chains that whip up out of the ground and
 *  pin a captive: several strands from a ring of ground anchors up to
 *  a cuff at the target's chest. Snap taut, hold, then dissolve.
 *  Follows a live getPos() so it tracks the bound target.
 * ------------------------------------------------------------------ */
export class Chains {
  constructor(scene, { getPos, count = 4, spread = 1.7, hold = 2.2, color = 0x565c68 } = {}) {
    this.scene = scene; this.getPos = getPos; this.hold = hold;
    this.t = 0; this.dead = false; this.phase = 'in'; this._t0 = 0;
    this.N = 6; this.count = count;
    this.mat = new THREE.MeshToonMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.3), transparent: true, opacity: 1 });
    this.anchors = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      this.anchors.push(new THREE.Vector3(Math.cos(a) * spread, 0, Math.sin(a) * spread));
    }
    this.im = new THREE.InstancedMesh(_CHAIN_LINK, this.mat, count * this.N);
    this.im.frustumCulled = false;
    scene.add(this.im);
    this.cuff = new THREE.Mesh(_CHAIN_CUFF, this.mat);
    this.cuff.frustumCulled = false;
    scene.add(this.cuff);
    this._d = new THREE.Object3D();
    this._base = new THREE.Vector3();
    this.update(0.0001);                 // place instances before first render
  }
  update(dt) {
    this.t += dt;
    const p = this.getPos && this.getPos();
    if (!p) { this.dead = true; return false; }
    this._base.copy(p);

    let ext = 1, op = 1;
    if (this.phase === 'in') {
      const k = Math.min(1, this.t / 0.16); ext = 1 - Math.pow(1 - k, 3);
      if (this.t >= 0.16) this.phase = 'hold';
    } else if (this.phase === 'hold') {
      if (this.t >= 0.16 + this.hold) { this.phase = 'out'; this._t0 = this.t; }
    } else {
      const k = (this.t - this._t0) / 0.28;
      if (k >= 1) { this.dead = true; return false; }
      op = 1 - k;
    }
    this.mat.opacity = op;

    const cuffY = 1.15;
    this.cuff.position.set(this._base.x, this._base.y + cuffY, this._base.z);
    this.cuff.rotation.x = Math.PI / 2;
    this.cuff.rotation.z += dt * 1.4;

    const wob = this.phase === 'hold' ? 0.035 : 0;
    let idx = 0;
    for (let ci = 0; ci < this.count; ci++) {
      const an = this.anchors[ci];
      for (let j = 0; j < this.N; j++) {
        const f = ((j + 0.5) / this.N) * ext;
        this._d.position.set(
          this._base.x + an.x * (1 - f) + (Math.random() - 0.5) * wob,
          this._base.y + cuffY * f + Math.sin(f * Math.PI) * 0.18,
          this._base.z + an.z * (1 - f) + (Math.random() - 0.5) * wob
        );
        this._d.rotation.set(0, (j % 2) * Math.PI / 2, f * 1.2);
        this._d.scale.setScalar(1);
        this._d.updateMatrix();
        this.im.setMatrixAt(idx++, this._d.matrix);
      }
    }
    this.im.instanceMatrix.needsUpdate = true;
    return true;
  }
  dispose() {
    this.scene.remove(this.im); this.scene.remove(this.cuff);
    this.im.dispose?.(); this.mat.dispose();
  }
}
const _CHAIN_LINK = new THREE.TorusGeometry(0.13, 0.042, 5, 8);
const _CHAIN_CUFF = new THREE.TorusGeometry(0.62, 0.08, 6, 18);

/* ------------------------------------------------------------------ *
 *  AirRift — Gura Gura "cracked air". A camera-facing billboard whose
 *  shader draws glowing branching fissures spreading from the centre,
 *  holds with a pulse, then flashes white and bursts outward.
 * ------------------------------------------------------------------ */
export class AirRift {
  constructor(scene, { pos, size = 8, life = 0.95, color = 0xd9d0ee, arms = 7 } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false;
    this.u = {
      uTime: { value: 0 }, uProgress: { value: 0 }, uShatter: { value: 0 }, uAlpha: { value: 0 },
      uSize: { value: size }, uArms: { value: Math.min(9, arms) }, uColor: { value: new THREE.Color(color) },
      uSpin: { value: (Math.random() - 0.5) * 6.28 },
    };
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: this.u,
      vertexShader: /* glsl */`
        uniform float uSize, uSpin; varying vec2 vUv;
        void main(){
          vUv = uv - 0.5;
          float s = sin(uSpin), c = cos(uSpin);
          vec2 q = mat2(c, -s, s, c) * position.xy;
          vec3 R = vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]);
          vec3 U = vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]);
          vec3 wp = (modelMatrix * vec4(0.0,0.0,0.0,1.0)).xyz + (R * q.x + U * q.y) * uSize;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv;
        uniform float uTime, uProgress, uShatter, uAlpha, uArms; uniform vec3 uColor;
        ${GLSL_NOISE}
        void main(){
          vec2 p = vUv * 2.0;
          float r = length(p);
          if (r > 1.0) discard;
          float ang = atan(p.y, p.x);
          float crack = 1.0;
          for (int i = 0; i < 9; i++){
            if (float(i) >= uArms) break;
            float base = (float(i) + 0.5) / uArms * 6.2832;
            float wob = (fbm(vec2(r * 4.0, float(i) * 13.7 + uTime * 0.6)) - 0.5) * 0.75;
            float da = abs(mod(ang - base - wob + 3.1416, 6.2832) - 3.1416);
            float w = mix(0.18, 0.015, r);
            crack = min(crack, da / w);
          }
          float ringf = min(abs(fract(r * 3.0 + fbm(p * 5.0)) - 0.5) * 2.0, abs(fract(r * 1.7) - 0.5) * 2.0);
          crack = min(crack, ringf * 3.5 + 0.4);
          float grow = smoothstep(uProgress + 0.06, uProgress - 0.02, r);
          float g = pow(max(0.0, 1.0 - crack), 6.0) * grow;
          float core = pow(max(0.0, 1.0 - crack * 2.2), 8.0) * grow;
          float a = (g * 0.9 + core) * uAlpha * (1.0 - uShatter * 0.55);
          if (a < 0.02) discard;
          vec3 col = mix(uColor, vec3(1.0), core + uShatter);
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.mesh = new THREE.Mesh(_QUAD, this.mat);
    this.mesh.position.copy(pos);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    this.u.uTime.value = this.t;
    this.u.uProgress.value = Math.min(1, k / 0.3);
    if (k < 0.55) { this.u.uShatter.value = 0; this.u.uAlpha.value = Math.min(1, k / 0.08); }
    else {
      const s = (k - 0.55) / 0.45;
      this.u.uShatter.value = s;
      this.u.uAlpha.value = 1 - s;
      this.u.uSize.value += dt * this.u.uSize.value * 0.9;
    }
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mat.dispose(); }
}

/* ------------------------------------------------------------------ *
 *  WaterShock — a tsunami shock-ring: a foaming water crest that races
 *  outward from a point across the ground, blue water trailing behind,
 *  then sinks and fades. Flat ground disc, all in the shader.
 * ------------------------------------------------------------------ */
export class WaterShock {
  constructor(scene, { pos, maxRadius = 28, life = 1.7, color = 0x2f74c8, foam = 0xeaf6ff, groundY } = {}) {
    this.scene = scene; this.t = 0; this.life = life; this.dead = false; this.maxR = maxRadius;
    this.u = {
      uTime: { value: 0 }, uFade: { value: 0 },
      uColor: { value: new THREE.Color(color) }, uFoam: { value: new THREE.Color(foam) },
    };
    const geo = new THREE.CircleGeometry(1, 72);
    geo.rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, uniforms: this.u,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv;
        uniform float uTime, uFade; uniform vec3 uColor, uFoam;
        ${GLSL_NOISE}
        void main(){
          vec2 p = (vUv - 0.5) * 2.0;
          float d = length(p);
          if (d > 1.0) discard;
          float ang = atan(p.y, p.x);
          float wob = fbm(vec2(ang * 3.0, uTime * 1.5)) * 0.06;
          float front = d + wob;
          float crest = smoothstep(0.16, 0.0, abs(front - 0.96));
          float water = smoothstep(0.98, 0.25, front) * (1.0 - crest * 0.5);
          float ripple = 0.6 + 0.4 * fbm(p * 9.0 - uTime * 2.0);
          float foam = crest * (0.55 + 0.45 * fbm(p * 24.0 + uTime * 4.0));
          vec3 col = mix(uColor * (0.55 + 0.45 * ripple), uFoam, foam);
          float a = (crest * 0.95 + water * 0.42 * ripple) * (1.0 - uFade);
          if (a < 0.015) discard;
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.set(pos.x, (groundY ?? pos.y) + 0.14, pos.z);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  update(dt) {
    this.t += dt;
    const k = this.t / this.life;
    if (k >= 1) { this.dead = true; return false; }
    this.u.uTime.value = this.t;
    const grow = 1 - Math.pow(1 - Math.min(1, k / 0.72), 2.2);
    this.mesh.scale.setScalar(0.6 + grow * this.maxR);
    this.u.uFade.value = k < 0.72 ? 0 : (k - 0.72) / 0.28;
    return true;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}
