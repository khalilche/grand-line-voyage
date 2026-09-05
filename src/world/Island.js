import * as THREE from 'three';
import { fbm, makeRng } from './noise.js';
import { toonMaterial, addOutline, outlineGroup, makeGradientMap } from '../rendering/toon.js';
import { QUALITY } from '../core/quality.js';
import { biome } from './islands/biomes.js';
import { STRUCTURE_BUILDERS } from './structures.js';

/**
 * Config-driven themed island. Reads an island definition (see
 * world/islands/definitions.js): biome palette, tree species, structure
 * placements, and spawn tables. Builds a displaced heightfield with flattened
 * pads under each structure, scatters biome-appropriate props, and resolves
 * enemy / npc / boss spawn points to world space for the Game to consume.
 */
export class Island {
  constructor(scene, def) {
    this.scene = scene;
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.levelBand = def.levelBand || [1, 10];
    this.center = new THREE.Vector3().fromArray(def.center);
    this.radius = def.radius ?? 120;
    this.seed = def.seed ?? 1;
    this.hill = def.hill ?? 22;
    this.arena = !!def.arena;
    this.bio = biome(def.biome);

    this.group = new THREE.Group();
    this.group.position.copy(this.center);
    scene.add(this.group);

    this.pads = [];                 // {x,z,r,h} flattened areas (local space)
    this.enemySpawns = [];
    this.npcSpawns = [];
    this.bossSpawn = null;
    this.dockEnd = this.center.clone();

    this._planStructures();         // fills this.pads + records structure defs
    this._buildTerrain();
    this._buildFoamRing();
    this._buildStructures();        // instantiates structure meshes on the pads
    this._scatter();
    this._resolveSpawns();
  }

  /* --------------------------- heightfield --------------------------- */
  _rawHeight(x, z) {
    const r = Math.hypot(x, z);
    const dn = r / this.radius;
    const mask = THREE.MathUtils.smoothstep(1.05, 0.5, dn);
    const terrain = (fbm(x * 0.018 + 50, z * 0.018 - 20, { seed: this.seed, octaves: 5 }) - 0.5) * 13;
    const bumps = (fbm(x * 0.07 + 9, z * 0.07 - 3, { seed: this.seed + 3, octaves: 4 }) - 0.5) * 2.0;
    const cone = Math.pow(THREE.MathUtils.clamp(1 - dn, 0, 1), 1.7) * this.hill;
    let h = mask * (1.4 + cone + terrain + bumps) - (1 - mask) * 6;
    h -= THREE.MathUtils.smoothstep(0.66, 0.92, dn) * 2.4;   // gentle beach shelf
    return h;
  }

  _localHeight(x, z) {
    let h = this._rawHeight(x, z);
    for (const p of this.pads) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d > p.r * 1.7) continue;
      const k = THREE.MathUtils.smoothstep(p.r * 1.7, p.r * 0.5, d);   // very wide, gentle blend
      h = THREE.MathUtils.lerp(h, p.h, k);
    }
    return h;
  }

  getHeightAt(worldX, worldZ) {
    const x = worldX - this.center.x;
    const z = worldZ - this.center.z;
    if (Math.hypot(x, z) > this.radius * 1.15) return -Infinity;
    return this._localHeight(x, z) + this.center.y;
  }

  /* --------------------------- structures --------------------------- */
  _polar(angle, dist) {
    const rad = dist * this.radius;
    return { x: Math.cos(angle) * rad, z: Math.sin(angle) * rad };
  }

  _planStructures() {
    this._structPlan = [];
    for (const s of this.def.structures || []) {
      if (s.type === 'dock') {
        const a = s.angle ?? 0;
        this._dockAngle = a;
        continue;
      }
      const { x, z } = this._polar(s.angle ?? 0, s.dist ?? 0.3);
      const padR = s.type === 'arena' ? 44 : s.type === 'ruins' ? 26 : s.type === 'village' ? 30 : 22;
      // pad height = mean of the raw terrain around the footprint, so it sits naturally
      let sum = this._rawHeight(x, z), n = 1;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 3) {
        sum += this._rawHeight(x + Math.cos(a) * padR, z + Math.sin(a) * padR);
        n++;
      }
      const h = Math.max(sum / n, 2.2);
      this.pads.push({ x, z, r: padR, h });
      this._structPlan.push({ ...s, x, z, h });
    }
  }

  _buildStructures() {
    this.structureMeta = {};
    for (const s of this._structPlan) {
      const builder = STRUCTURE_BUILDERS[s.type];
      if (!builder) continue;
      const { group, meta } = builder({ seed: this.seed + s.type.length, ...(s.props || {}) });
      group.position.set(s.x, s.h, s.z);
      // face structures roughly toward island centre
      group.rotation.y = Math.atan2(-s.x, -s.z);
      this.group.add(group);
      this.structureMeta[s.type] = { meta, world: this.center.clone().add(new THREE.Vector3(s.x, s.h, s.z)), rotY: group.rotation.y };
    }
  }

  /* ----------------------------- terrain --------------------------- */
  _buildTerrain() {
    const span = this.radius * 2.25;
    const segs = QUALITY.tier === 'lite' ? 96 : QUALITY.tier === 'ultra' ? 220 : 148;
    const geo = new THREE.PlaneGeometry(span, span, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const b = this.bio;
    const sand = new THREE.Color(b.sand);
    const sandWet = new THREE.Color(b.sandWet);
    const grass = new THREE.Color(b.grass);
    const grassLight = new THREE.Color(b.grassLight);
    const grassDark = new THREE.Color(b.grassDark);
    const rock = new THREE.Color(b.rock);
    const c = new THREE.Color();
    const g2 = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = this._localHeight(x, z);
      pos.setY(i, h);

      const e = 1.3;
      const hx = this._localHeight(x + e, z) - this._localHeight(x - e, z);
      const hz = this._localHeight(x, z + e) - this._localHeight(x, z - e);
      const slope = Math.min(1, Math.hypot(hx, hz) / (2 * e) * 1.6);

      const tint = fbm(x * 0.12, z * 0.12, { seed: this.seed + 7, octaves: 3 });
      const patch = fbm(x * 0.035 + 20, z * 0.035 - 8, { seed: this.seed + 11, octaves: 4 });
      if (h < 1.7 + tint * 0.8) {
        c.copy(sand).lerp(sandWet, THREE.MathUtils.clamp((1.4 - h) * 0.6, 0, 1));
      } else {
        g2.copy(grass).lerp(grassLight, THREE.MathUtils.clamp(patch * 1.6 - 0.3, 0, 1));
        g2.lerp(grassDark, THREE.MathUtils.clamp(tint * 0.7 + (h - 4) * 0.018, 0, 1));
        c.copy(g2);
      }
      c.lerp(rock, THREE.MathUtils.clamp(slope - 0.34, 0, 1));
      if (h > this.hill * 0.72) c.lerp(rock, THREE.MathUtils.clamp((h - this.hill * 0.72) * 0.1, 0, 1));

      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    this.terrain = new THREE.Mesh(geo, new THREE.MeshToonMaterial({
      vertexColors: true, gradientMap: makeGradientMap(4)
    }));
    this.terrain.receiveShadow = true;
    this.terrain.castShadow = true;
    this.terrain.name = `terrain:${this.id}`;
    this.group.add(this.terrain);
  }

  _buildFoamRing() {
    const outer = this.radius * 1.02;
    const shoreR = this.radius * 0.9;
    const geo = new THREE.RingGeometry(this.radius * 0.74, outer, 140, 6);
    geo.rotateX(-Math.PI / 2);
    this.foamUniforms = { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xf2fbff) } };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: this.foamUniforms,
      vertexShader: `varying vec2 vP; void main(){ vP=position.xz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vP; uniform float uTime; uniform vec3 uColor;
        float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
        float noise(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y); }
        void main(){
          float r = length(vP);
          float dist = abs(r - ${shoreR.toFixed(1)});
          float shore = smoothstep(5.0, 0.0, dist);
          float swash = sin(r*0.85 - uTime*1.8)*0.5+0.5;
          float n = noise(vP*0.8 + uTime*0.35)*0.6 + noise(vP*2.3 - uTime*0.5)*0.4;
          float foam = shore * swash * smoothstep(0.4, 0.8, n);
          foam += shore * smoothstep(1.8, 0.0, dist) * 0.28;
          gl_FragColor = vec4(uColor, clamp(foam,0.0,1.0) * 0.55);
        }`
    });
    this.foam = new THREE.Mesh(geo, mat);
    this.foam.position.y = 0.08;
    this.foam.renderOrder = 2;
    this.foam.frustumCulled = false;
    this.group.add(this.foam);
  }

  /* ------------------------------ props --------------------------- */
  _scatter() {
    const rng = makeRng(this.seed ^ 0x9e37);
    const b = this.bio;
    const proto = this._treeProto(b.tree);
    const rockMat = toonMaterial({ color: b.cliff, stops: 3, toe: 46, rimStrength: 0 });
    rockMat.flatShading = true;

    const inPad = (x, z, pad = 4) => this.pads.some((p) => Math.hypot(x - p.x, z - p.z) < p.r * 1.25 + pad);
    const scaleN = this.radius / 120;

    // trees — kept well clear of structure pads so nothing shadows the plaza
    let treesLeft = Math.round(b.treeCount * scaleN);
    for (let i = 0; i < treesLeft * 6 && treesLeft > 0; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = this.radius * (0.24 + rng() * 0.58);
      const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
      const h = this._localHeight(x, z);
      if (h < 1.9 || h > this.hill * 0.85 || inPad(x, z, 16)) continue;
      const t = proto.clone();
      t.position.set(x, h - 0.1, z);
      t.rotation.y = rng() * Math.PI * 2;
      t.rotation.z = (rng() - 0.5) * 0.16;
      t.scale.setScalar(0.85 + rng() * 0.55);
      this.group.add(t);
      treesLeft--;
    }

    // rocks
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    let rocksLeft = Math.round(b.rockCount * scaleN);
    for (let i = 0; i < rocksLeft * 6 && rocksLeft > 0; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = this.radius * (0.2 + rng() * 0.64);
      const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
      const h = this._localHeight(x, z);
      if (h < 0.7 || inPad(x, z)) continue;
      const g = rockGeo.clone();
      const gp = g.attributes.position;
      for (let v = 0; v < gp.count; v++) {
        gp.setXYZ(v, gp.getX(v) * (0.55 + rng() * 0.9), gp.getY(v) * (0.4 + rng() * 0.7), gp.getZ(v) * (0.55 + rng() * 0.9));
      }
      const gf = g.toNonIndexed(); gf.computeVertexNormals();
      const rock = new THREE.Mesh(gf, rockMat);
      const s = 0.4 + rng() * 0.9;
      rock.scale.set(s, s * (0.6 + rng() * 0.4), s);
      rock.position.set(x, h - s * 0.18, z);
      rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      rock.castShadow = rock.receiveShadow = true;
      this.group.add(rock);
      rocksLeft--;
    }

    this._buildGrass(rng);
  }

  _treeProto(kind) {
    const b = this.bio;
    if (kind === 'deadwood') {
      const g = new THREE.Group();
      const bark = toonMaterial({ color: 0x6f6257, stops: 3, toe: 60 });
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.4, 5.5, 7), bark);
      trunk.position.y = 2.75; trunk.rotation.z = 0.12;
      g.add(trunk);
      for (let i = 0; i < 4; i++) {
        const br = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.14, 1.6 + Math.random(), 5), bark);
        br.position.set((Math.random() - 0.5) * 0.6, 2 + i * 0.9, (Math.random() - 0.5) * 0.6);
        br.rotation.set(Math.random() * 2, Math.random() * 3, Math.random() * 2 - 1);
        g.add(br);
      }
      outlineGroup(g, { thickness: 0.0035 });
      g.traverse((c) => { if (c.isMesh && !c.name.endsWith('__outline')) c.castShadow = true; });
      return g;
    }
    if (kind === 'jungle') {
      const g = new THREE.Group();
      const bark = toonMaterial({ color: 0x6a4a30, stops: 3 });
      const leaf = toonMaterial({ color: b.grassDark, stops: 3, rim: 0x9fe07a, rimStrength: 0.25 });
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 8.5, 8), bark);
      trunk.position.y = 4.25;
      g.add(trunk);
      for (let i = 0; i < 3; i++) {
        const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(2.4 - i * 0.3, 1), leaf);
        blob.position.set((Math.random() - 0.5) * 1.6, 7.5 + i * 1.2, (Math.random() - 0.5) * 1.6);
        blob.scale.y = 0.7;
        g.add(blob);
      }
      outlineGroup(g, { thickness: 0.0035 });
      g.traverse((c) => { if (c.isMesh && !c.name.endsWith('__outline')) c.castShadow = true; });
      return g;
    }
    if (kind === 'pine' || kind === 'pine_snow') {
      const g = new THREE.Group();
      const bark = toonMaterial({ color: 0x6a4a30, stops: 3 });
      const leaf = toonMaterial({ color: kind === 'pine_snow' ? 0x2f6a4a : 0x357a45, stops: 3 });
      const snow = toonMaterial({ color: 0xf2f7fb, stops: 2, rimStrength: 0 });
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 3.0, 7), bark);
      trunk.position.y = 1.5; g.add(trunk);
      for (let i = 0; i < 4; i++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(2.2 - i * 0.45, 2.2, 8), leaf);
        cone.position.y = 3 + i * 1.5;
        g.add(cone);
        if (kind === 'pine_snow') {
          const cap = new THREE.Mesh(new THREE.ConeGeometry(2.25 - i * 0.45, 0.6, 8), snow);
          cap.position.y = 3 + i * 1.5 + 0.9;
          g.add(cap);
        }
      }
      outlineGroup(g, { thickness: 0.0035 });
      g.traverse((c) => { if (c.isMesh && !c.name.endsWith('__outline')) c.castShadow = true; });
      return g;
    }
    return this._makePalm();
  }

  _makePalm() {
    const g = new THREE.Group();
    const trunkMat = toonMaterial({ color: 0x9a6b3e, stops: 3, rim: 0xffe0b0, rimStrength: 0.25 });
    const leafMat = toonMaterial({ color: 0x3f9c3a, stops: 3, rim: 0xbfef8f, rimStrength: 0.3 });
    leafMat.side = THREE.DoubleSide;
    const leafDarkMat = toonMaterial({ color: 0x2f7a34, stops: 3 });
    leafDarkMat.side = THREE.DoubleSide;
    const coconutMat = toonMaterial({ color: 0x6b4a2c, stops: 3 });

    const h = 6.0;
    const trunkGeo = new THREE.CylinderGeometry(0.24, 0.46, h, 9, 6, true);
    const tp = trunkGeo.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const y = tp.getY(i), t = (y + h / 2) / h;
      tp.setX(i, tp.getX(i) + t * t * 0.7);
      tp.setZ(i, tp.getZ(i) + Math.sin(t * 2.2) * 0.12);
    }
    trunkGeo.computeVertexNormals();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = h / 2; trunk.castShadow = true;
    addOutline(trunk, { thickness: 0.0035 });
    g.add(trunk);

    const crown = new THREE.Group();
    crown.position.set(0.7, h - 0.15, 0);
    const frondGeo = this._frondGeo();
    for (let i = 0; i < 9; i++) {
      const f = new THREE.Mesh(frondGeo, i % 3 === 0 ? leafDarkMat : leafMat);
      f.rotation.y = (i / 9) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
      f.rotation.z = -0.15 - Math.random() * 0.25;
      f.scale.setScalar(0.9 + Math.random() * 0.25);
      f.castShadow = true;
      crown.add(f);
    }
    for (let i = 0; i < 4; i++) {
      const nut = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), coconutMat);
      const a = (i / 4) * Math.PI * 2;
      nut.position.set(Math.cos(a) * 0.22, -0.15, Math.sin(a) * 0.22);
      crown.add(nut);
    }
    g.add(crown);
    return g;
  }

  _frondGeo() {
    const len = 2.9;
    const g = new THREE.PlaneGeometry(len, 0.6, 10, 1);
    g.translate(len / 2, 0, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), t = THREE.MathUtils.clamp(x / len, 0, 1);
      p.setZ(i, p.getZ(i) * (1 - t * 0.92) * (1 + Math.sin(t * Math.PI) * 0.3));
      p.setY(i, p.getY(i) + Math.sin(t * 1.5) * 1.0 - t * t * 2.0);
    }
    g.computeVertexNormals();
    return g;
  }

  _buildGrass(rng) {
    const blades = Math.round(QUALITY.grassBlades * this.bio.grassMul * (this.radius / 120));
    if (blades < 20) return;
    const bladeGeo = new THREE.PlaneGeometry(0.28, 0.42, 1, 3);
    bladeGeo.translate(0, 0.21, 0);
    const p = bladeGeo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) * (1 - p.getY(i) / 0.5));
    bladeGeo.computeVertexNormals();

    const mat = toonMaterial({ color: this.bio.grass, stops: 3, rim: 0xbfe98f, rimStrength: 0.15 });
    mat.side = THREE.DoubleSide;
    this.grassUniforms = { uTime: { value: 0 } };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.grassUniforms.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float wpx = instanceMatrix[3][0]; float wpz = instanceMatrix[3][2];
          float sway = sin(uTime*1.6 + wpx*0.5 + wpz*0.3)*0.12 + sin(uTime*3.1 + wpz)*0.04;
          transformed.x += sway * position.y; transformed.z += sway * 0.6 * position.y;`);
    };

    const inst = new THREE.InstancedMesh(bladeGeo, mat, blades);
    inst.receiveShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < blades * 4 && n < blades; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = this.radius * (0.16 + rng() * 0.66);
      const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
      const h = this._localHeight(x, z);
      if (h < 2.0 || h > this.hill * 0.66) continue;
      if (this.pads.some((pd) => Math.hypot(x - pd.x, z - pd.z) < pd.r)) continue;
      q.setFromAxisAngle(_up, rng() * Math.PI);
      sc.set(0.7 + rng() * 0.7, 0.7 + rng() * 0.7, 1);
      m.compose(_v.set(x, h, z), q, sc);
      inst.setMatrixAt(n++, m);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
  }

  /* ---------------------------- spawns ---------------------------- */
  _spawnPoint(angle, dist, spread, rng) {
    const a = angle + (rng() - 0.5) * (spread || 0);
    const d = dist + (rng() - 0.5) * 0.12;
    const { x, z } = this._polar(a, THREE.MathUtils.clamp(d, 0.05, 0.92));
    const y = this._localHeight(x, z) + this.center.y;
    return new THREE.Vector3(x + this.center.x, y, z + this.center.z);
  }

  _resolveSpawns() {
    const rng = makeRng(this.seed ^ 0xa11);
    for (const e of this.def.enemies || []) {
      for (let i = 0; i < (e.count || 1); i++) {
        const lvl = Array.isArray(e.level)
          ? Math.round(THREE.MathUtils.lerp(e.level[0], e.level[1], rng()))
          : (e.level ?? this.levelBand[0]);
        this.enemySpawns.push({
          type: e.type, level: lvl, island: this.id,
          pos: this._spawnPoint(e.angle ?? 0, e.dist ?? 0.4, e.spread ?? 0.8, rng)
        });
      }
    }
    for (const npc of this.def.npcs || []) {
      const count = npc.count || 1;
      for (let i = 0; i < count; i++) {
        this.npcSpawns.push({
          type: npc.type,
          pos: this._spawnPoint(npc.angle ?? 0, npc.dist ?? 0.3, count > 1 ? (npc.spread ?? 0.6) : 0, rng)
        });
      }
    }
    if (this.def.boss) {
      const bd = this.def.boss;
      this.bossSpawn = {
        type: bd.type, name: bd.name, level: bd.level, island: this.id,
        pos: this._spawnPoint(bd.angle ?? 0, bd.dist ?? 0.1, 0, rng)
      };
    }
    // dock end point
    const da = this._dockAngle ?? 0;
    const { x, z } = this._polar(da, 1.0);
    this.dockEnd = this.center.clone().add(new THREE.Vector3(x * 0.98, 1.0, z * 0.98));
    if (!this.arena) this._buildDockMesh(da);        // no dock in battleground mode
  }

  _buildDockMesh(angle) {
    const dock = new THREE.Group();
    const startR = this.radius * 0.62;
    const len = Math.min(this.radius * 0.42, 34);
    const plankMat = toonMaterial({ color: 0x9c6b3f, stops: 3, rim: 0xffd9a0, rimStrength: 0.25 });
    const postMat = toonMaterial({ color: 0x6d4726, stops: 3 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 0.4, 4.4), plankMat);
    deck.position.set(startR + len / 2, 0.6, 0);
    deck.castShadow = deck.receiveShadow = true;
    addOutline(deck, { thickness: 0.004 });
    dock.add(deck);
    for (let i = 0; i <= 5; i++) {
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 3.6, 7), postMat);
        post.position.set(startR + (i / 5) * len, -0.7, s * 2.0);
        post.castShadow = true;
        addOutline(post, { thickness: 0.004 });
        dock.add(post);
      }
    }
    dock.rotation.y = -angle;
    this.group.add(dock);
  }

  update(dt, elapsed) {
    if (this.foamUniforms) this.foamUniforms.uTime.value = elapsed;
    if (this.grassUniforms) this.grassUniforms.uTime.value = elapsed;
    // campfire flicker
    const camp = this.structureMeta && this.structureMeta.bandit_camp;
    if (camp && camp.meta.fire) {
      const f = camp.meta.fire.getObjectByName('campfire-flame');
      if (f) f.scale.setScalar(0.85 + Math.sin(elapsed * 18) * 0.12 + Math.sin(elapsed * 7) * 0.06);
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((c) => {
      if (c.isMesh) { c.geometry?.dispose?.(); }
    });
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
