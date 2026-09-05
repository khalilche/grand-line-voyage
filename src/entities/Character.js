import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toonMaterial, outlineGroup } from '../rendering/toon.js';

/**
 * Procedurally-built stylised "straw hat pirate". No external rig — limbs are
 * pivot groups driven by a small procedural animation state machine, which is
 * a good match for the blocky Blox-Fruits silhouette.
 *
 * Every STATIC same-material box cluster inside a rigid node (torso skin,
 * neck/head skin, hair, eyes, ankle shoe/toes) is baked into ONE merged mesh
 * via `mergeBoxes()` instead of one mesh per box — this is the only thing
 * that differs structurally from the original version of this rig: it cuts
 * ~63 meshes (+63 outline shells = 126 draw calls) down to ~23 (+23 = 46).
 * `arm`+`hand` and `thigh`+`cuff` are deliberately LEFT UNMERGED — see the
 * comments at `_limb()`/`_leg()`, they have to stay independently toggleable/
 * differently-materialed. Every animated pivot (`torso`, `neck`, `hat`,
 * `armL/R.pivot/.fore`, `legL/R.pivot/.shin/.ankle`) is still its own
 * `THREE.Group`, unaffected by the merge — the whole pose/animation system
 * below only ever rotates these groups, never touches individual boxes.
 */

// ---------------------------------------------------------------------------
// construction-time geometry helpers
// ---------------------------------------------------------------------------
function box(w, h, d, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}
function boxGeom(w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (x || y || z || rx || ry || rz) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1)));
  }
  return g;
}
function cylGeom(rTop, rBot, h, seg, y = 0) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  if (y) g.translate(0, y, 0);
  return g;
}
/** specs: [{w,h,d,x,y,z,rx,ry,rz}, ...] sharing ONE material -> ONE Mesh */
function mergeBoxes(specs, material) {
  const geoms = specs.map((s) => boxGeom(s.w, s.h, s.d, s.x, s.y, s.z, s.rx, s.ry, s.rz));
  const merged = mergeGeometries(geoms, false);   // useGroups=false -> single material, no groups array
  geoms.forEach((g) => g.dispose());
  return new THREE.Mesh(merged, material);
}
function mergeGeoms(geoms, material) {
  const merged = mergeGeometries(geoms, false);
  geoms.forEach((g) => g.dispose());
  return new THREE.Mesh(merged, material);
}

export class Character {
  constructor({ palette } = {}) {
    const p = Object.assign({
      skin: 0xf1c19b, shirt: 0xd24a41, shirtTrim: 0xe9edef,
      shorts: 0x315f88, shoes: 0x5f3f28, hair: 0x1b1916,
      hatStraw: 0xe4b64a, hatBand: 0xc23a2e, sash: 0xe4b24a
    }, palette || {});

    this.root = new THREE.Group();
    this.root.name = 'character';

    const M = {
      skin: toonMaterial({ color: p.skin, stops: 4, rim: 0xffe9cf, rimStrength: 0.3 }),
      shirt: toonMaterial({ color: p.shirt, stops: 4, rim: 0xff9a90, rimStrength: 0.25 }),
      trim: toonMaterial({ color: p.shirtTrim, stops: 4 }),
      shorts: toonMaterial({ color: p.shorts, stops: 4, rim: 0x9ccdf0, rimStrength: 0.25 }),
      shoes: toonMaterial({ color: p.shoes, stops: 3 }),
      hair: toonMaterial({ color: p.hair, stops: 3, rim: 0x6a6a80, rimStrength: 0.35 }),
      straw: toonMaterial({ color: p.hatStraw, stops: 4, rim: 0xfff0c0, rimStrength: 0.3 }),
      band: toonMaterial({ color: p.hatBand, stops: 3 }),
      sash: toonMaterial({ color: p.sash, stops: 3 }),
      eye: toonMaterial({ color: 0x1a1a22, stops: 1, rimStrength: 0 })
    };
    this.materials = M;

    // ================= TORSO — bare chest, blocky abs (ref model sheet) ======
    this.torso = new THREE.Group();
    this.torso.position.y = 1.12;
    this.root.add(this.torso);

    // chest + midriff + 2 pecs + 6 abs = 10 static skin boxes -> 1 merged mesh
    const torsoSkinSpecs = [
      { w: 0.68, h: 0.46, d: 0.38, y: 0.24 },              // upper ribcage
      { w: 0.62, h: 0.5, d: 0.36, y: -0.16 },              // stomach block
    ];
    for (const sx of [-1, 1]) torsoSkinSpecs.push({ w: 0.26, h: 0.13, d: 0.05, x: sx * 0.15, y: 0.29, z: 0.17 });   // pecs
    for (let r = 0; r < 3; r++) for (const sx of [-1, 1]) torsoSkinSpecs.push({ w: 0.13, h: 0.1, d: 0.035, x: sx * 0.085, y: 0.03 - r * 0.14, z: 0.165 });   // abs
    const torsoSkin = mergeBoxes(torsoSkinSpecs, M.skin);
    torsoSkin.name = 'torsoSkin';
    this.torso.add(torsoSkin);

    // waistband of the shorts wrapping the pelvis (alone at this material -> stays its own mesh)
    const waist = box(0.64, 0.26, 0.42, M.shorts);
    waist.position.y = -0.42;
    this.torso.add(waist);

    // ================= HEAD + HAIR + HAT ====================================
    this.neck = new THREE.Group();
    this.neck.position.y = 0.5;
    this.torso.add(this.neck);

    // stubby neck + head -> 1 merged skin mesh
    const headSkin = mergeBoxes([
      { w: 0.24, h: 0.14, d: 0.24, y: -0.02 },   // nub
      { w: 0.54, h: 0.52, d: 0.5, y: 0.32 },     // head
    ], M.skin);
    headSkin.name = 'headSkin';
    this.neck.add(headSkin);

    // eyes -> 1 merged eye mesh
    const eyes = mergeBoxes([
      { w: 0.08, h: 0.13, d: 0.04, x: -0.13, y: 0.34, z: 0.26 },
      { w: 0.08, h: 0.13, d: 0.04, x: 0.13, y: 0.34, z: 0.26 },
    ], M.eye);
    eyes.name = 'eyes';
    this.neck.add(eyes);

    // spiky black hair (cap + all tufts) + brows -> 1 merged hair mesh
    const hairSpecs = [];
    const spike = (x, y, z, sx, sy, sz, rx = 0, rz = 0) => hairSpecs.push({ w: sx, h: sy, d: sz, x, y, z, rx, rz });
    for (let i = 0; i < 6; i++) spike(-0.26 + i * 0.105, 0.6, 0.24, 0.12, 0.2, 0.12, -0.6 + Math.random() * 0.2, 0);   // fringe over forehead
    for (let i = 0; i < 5; i++) spike(-0.26 + i * 0.13, 0.66, -0.26, 0.13, 0.22, 0.13, 0.5, 0);                        // back
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) spike(sx * 0.32, 0.5 + i * 0.06, -0.1 + i * 0.08, 0.12, 0.16, 0.16, 0, sx * (0.5 + i * 0.15)); // sides
    spike(0, 0.78, -0.02, 0.14, 0.22, 0.14, 0.1, 0.05);
    hairSpecs.push({ w: 0.58, h: 0.26, d: 0.56, y: 0.52 });                                   // hair cap
    hairSpecs.push({ w: 0.16, h: 0.035, d: 0.04, x: -0.13, y: 0.47, z: 0.26, rz: 0.16 });      // brow L
    hairSpecs.push({ w: 0.16, h: 0.035, d: 0.04, x: 0.13, y: 0.47, z: 0.26, rz: -0.16 });      // brow R
    const hair = mergeBoxes(hairSpecs, M.hair);
    hair.name = 'hair';
    this.neck.add(hair);

    // straw hat — wide flat brim + short crown merged (straw), red band alone
    this.hat = new THREE.Group();
    this.hat.position.y = 0.62;
    this.neck.add(this.hat);
    const strawGeom = mergeGeoms([
      cylGeom(0.7, 0.74, 0.055, 18, 0),      // brim
      cylGeom(0.32, 0.38, 0.24, 18, 0.13),   // crown
    ], M.straw);
    strawGeom.name = 'hatStraw';
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.335, 0.39, 0.09, 18), M.band);
    band.position.y = 0.055;
    this.hat.add(strawGeom, band);

    // ================= ARMS (bare) =========================================
    this.armL = this._limb(M.skin, M.skin, -1);
    this.armR = this._limb(M.skin, M.skin, 1);
    this.armL.pivot.position.set(-0.46, 0.34, 0);
    this.armR.pivot.position.set(0.46, 0.34, 0);
    this.torso.add(this.armL.pivot, this.armR.pivot);

    // ================= LEGS (blue shorts w/ white cuff, sandals) ===========
    this.legL = this._leg(M.shorts, M.skin, M.shoes, -1);
    this.legR = this._leg(M.shorts, M.skin, M.shoes, 1);
    this.legL.pivot.position.set(-0.2, -0.42, 0);
    this.legR.pivot.position.set(0.2, -0.42, 0);
    this.torso.add(this.legL.pivot, this.legR.pivot);

    this.root.traverse((c) => {
      if (c.isMesh && !c.name.endsWith('__outline')) { c.castShadow = true; c.receiveShadow = true; }
    });
    outlineGroup(this.root, { thickness: 0.0045, color: 0x0b0f1c });

    // transformation add-ons (hidden until a Zoan form activates)
    this._baseColors = new Map();
    for (const m of Object.values(M)) if (m.color) this._baseColors.set(m, m.color.clone());
    this._buildForms();
    this._form = null;

    // anim state
    this.state = 'idle';
    this.animT = 0;
    this._prevState = 'idle';
    this._stateTime = 0;
    this._g5AwakenT = 0;   // Gear 5 "liberation" pose timer (s)

    // locomotion
    this._phase = 0;        // gait phase (π per step, 2π per L+R cycle)
    this._gait = 0;         // smoothed 0..1 locomotion amount
    this._run = 0;          // smoothed 0..1 walk->run blend
    this._breatheT = 0;
    this._lean = 0;         // smoothed turn lean
  }

  /* ---------- transformation models ---------- */
  _buildForms() {
    // GEAR 5 — long flowing white hair
    this.gear5Hair = new THREE.Group();
    const white = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: this.materials.hair.gradientMap });
    this._g5Hair = white;
    for (let i = 0; i < 7; i++) {
      const s = new THREE.Mesh(new THREE.ConeGeometry(0.11, 1.1 + Math.random() * 0.5, 5), white);
      s.geometry.translate(0, -0.55, 0);
      s.position.set(-0.3 + i * 0.1, 0.62, -0.18 - Math.random() * 0.1);
      s.rotation.set(-2.2 - Math.random() * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.5);
      this.gear5Hair.add(s);
    }
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.7, 4), white);
      s.geometry.translate(0, -0.35, 0);
      s.position.set(-0.2 + i * 0.13, 0.66, 0.24);
      s.rotation.x = -0.9 - Math.random() * 0.3;
      this.gear5Hair.add(s);
    }
    this.gear5Hair.visible = false;
    this.neck.add(this.gear5Hair);

    // PHOENIX — a whole separate bird model. On transform the human body is
    // hidden and this takes its place (see setForm / _animPhoenix).
    this.phoenix = this._buildPhoenix();
    this.phoenix.visible = false;
    this.root.add(this.phoenix);
  }

  /* ILLUSORY phoenix: NO bird model — the human stays, wrapped in additive
     blue-flame WINGS built as a few big clean silhouette shapes (a filled
     ShapeGeometry per wing, not a noisy stack of thin planes — that read as
     a faceted crystal from bad angles), plus a soft body aura, a subtle
     halo, a short crest and a back-trailing tail. */
  _buildPhoenix() {
    const mk = (hex, op) => new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: op, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const core = mk(0xeaf6ff, 0.58);
    const bright = mk(0x9fd6ff, 0.5);
    const mid = mk(0x3f9be8, 0.4);
    const deep = mk(0x1663d6, 0.26);
    const auraMat = mk(0x2f9fe8, 0.14);
    this._phxMats = { core, bright, mid, deep, auraMat };
    this._phxAwakenT = 0;   // 1 -> 0 wing-unfurl timer, set by phoenixAwaken()

    // one clean swept-wing outline, pointing +X, span ~3.6, chord ~1.5
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0.34);
    wingShape.quadraticCurveTo(1.6, 1.0, 3.5, 0.34);          // leading edge sweeps up to the tip
    wingShape.lineTo(3.7, 0.02);                              // tip
    wingShape.quadraticCurveTo(2.9, -0.42, 2.5, -0.12);       // scalloped trailing feathers
    wingShape.quadraticCurveTo(2.05, -0.62, 1.65, -0.2);
    wingShape.quadraticCurveTo(1.2, -0.72, 0.8, -0.26);
    wingShape.quadraticCurveTo(0.4, -0.46, 0, -0.12);
    wingShape.closePath();
    const wingGeo = new THREE.ShapeGeometry(wingShape);
    // a thin bright leading-edge sliver
    const edgeShape = new THREE.Shape();
    edgeShape.moveTo(0, 0.3); edgeShape.quadraticCurveTo(1.6, 0.96, 3.5, 0.3);
    edgeShape.quadraticCurveTo(1.6, 0.78, 0, 0.16); edgeShape.closePath();
    const edgeGeo = new THREE.ShapeGeometry(edgeShape);

    const plume = (len, wid, mat) => {
      const g = new THREE.PlaneGeometry(len, wid, 6, 1);
      g.translate(len / 2, 0, 0);
      const p = g.attributes.position;
      for (let v = 0; v < p.count; v++) p.setY(v, p.getY(v) * (1 - (p.getX(v) / len) * 0.85));
      return new THREE.Mesh(g, mat);
    };

    const g = new THREE.Group();

    // ---- body aura: cool outer shell + a small hot inner core ----
    this._phxAura = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 2), auraMat);
    this._phxAura.position.set(0, 1.15, 0);
    this._phxAura.scale.set(0.85, 1.5, 0.85);
    g.add(this._phxAura);
    this._phxAuraCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 1), core);
    this._phxAuraCore.position.set(0, 1.2, 0);
    g.add(this._phxAuraCore);

    // ---- single soft halo ----
    this._phxHalo = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.045, 6, 24), bright);
    this._phxHalo.rotation.x = Math.PI / 2;
    this._phxHalo.position.set(0, 2.02, -0.04);
    g.add(this._phxHalo);

    // ---- short crest: 3 clean tufts behind the head ----
    this._phxCrest = [];
    for (let i = 0; i < 3; i++) {
      const cf = i - 1;
      const c = plume(0.5 + (1 - Math.abs(cf)) * 0.32, 0.18, i === 1 ? bright : mid);
      c.position.set(cf * 0.15, 1.78, -0.18);
      c.rotation.z = 1.9; c.rotation.y = cf * 0.4;
      g.add(c); this._phxCrest.push(c);
    }

    // ---- wings: one big silhouette + a soft oversized glow backing per side ----
    this._phxWings = [];
    for (const sgn of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(sgn * 0.26, 1.42, -0.05);
      shoulder.scale.x = sgn;
      shoulder.userData = { sgn };
      g.add(shoulder);

      const glow = new THREE.Mesh(wingGeo, deep);
      glow.scale.setScalar(1.28); glow.position.z = -0.08;
      shoulder.add(glow);

      const wing = new THREE.Mesh(wingGeo, mid);
      shoulder.add(wing);

      const inner = new THREE.Mesh(wingGeo, bright);
      inner.scale.setScalar(0.62); inner.position.set(0.15, 0.04, 0.03);
      shoulder.add(inner);

      const edge = new THREE.Mesh(edgeGeo, core);
      edge.position.z = 0.04;
      shoulder.add(edge);

      shoulder.userData.tipEmber = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), core);
      shoulder.userData.tipEmber.position.set(3.5, 0.28, 0);
      shoulder.add(shoulder.userData.tipEmber);

      this._phxWings.push(shoulder);
    }

    // ---- tail: 3 clean ribbons trailing straight back ----
    this._phxTail = new THREE.Group();
    this._phxTail.position.set(0, 1.05, -0.5);
    g.add(this._phxTail);
    for (let i = -1; i <= 1; i++) {
      const fe = plume(2.6 - Math.abs(i) * 0.5, 0.5 - Math.abs(i) * 0.1, Math.abs(i) < 1 ? bright : mid);
      fe.rotation.y = Math.PI - i * 0.26;             // point back (-Z), fan slightly
      fe.rotation.z = -0.12;
      fe.userData.i = i;
      this._phxTail.add(fe);
    }

    return g;
  }

  /** one-shot dramatic wing-unfurl on transforming into the phoenix */
  phoenixAwaken() { this._phxAwakenT = 1; }

  /** name: 'gear5' | 'phoenix' | null */
  setForm(name) {
    this._form = name || null;
    this.gear5Hair.visible = name === 'gear5';
    // phoenix is ILLUSORY — the human body stays visible, just wreathed in flame.
    // The HANDS are hidden and the arms tuck in so the clean flame wings own
    // the silhouette (see _animPhoenix).
    this.phoenix.visible = name === 'phoenix';
    this.setHands(name !== 'phoenix');
    this.torso.visible = true;
    this.root.scale.setScalar(name === 'gear5' ? 1.15 : name === 'phoenix' ? 1.04 : 1);

    const M = this.materials;
    const to = (mat, hex, amt) => {
      const base = this._baseColors.get(mat);
      if (!base) return;
      mat.color.copy(base).lerp(new THREE.Color(hex), amt);
    };
    if (name === 'gear5') {
      to(M.shirt, 0xffffff, 0.9); to(M.shorts, 0xffffff, 0.8); to(M.skin, 0xffffff, 0.45);
      to(M.hair, 0xffffff, 1); to(M.sash, 0xffffff, 0.7); to(M.band, 0xff4d4d, 0.2);
    } else if (name === 'phoenix') {
      to(M.skin, 0x9fd6ff, 0.5); to(M.shirt, 0x2f9fe8, 0.62); to(M.shorts, 0x1663d6, 0.55);
      to(M.hair, 0xdff2ff, 0.7); to(M.straw, 0x6cc0ff, 0.5); to(M.band, 0x2f9fe8, 0.5);
      to(M.sash, 0xbfe4ff, 0.6); to(M.trim, 0xdff2ff, 0.5); to(M.shoes, 0x1b56a8, 0.5);
    } else {
      for (const [mat, base] of this._baseColors) mat.color.copy(base);
    }
  }

  _limb(skinMat, sleeveMat, side) {
    const pivot = new THREE.Group();
    const upper = box(0.2, 0.3, 0.22, sleeveMat);      // shoulder + bicep
    upper.position.y = -0.14;
    pivot.add(upper);
    const fore = new THREE.Group();
    fore.position.y = -0.28;
    pivot.add(fore);
    // arm + hand deliberately stay SEPARATE meshes (not merged): setHand()
    // toggles the hand's visibility alone for the flying-fist/detach ability
    // (Bara Bara) — merging them would take the forearm with it.
    const arm = box(0.18, 0.34, 0.19, skinMat);
    arm.position.y = -0.17;
    arm.name = 'arm';           // Busoshoku's coat is scoped to just arm+hand — see setHakiCoat()
    fore.add(arm);
    const hand = box(0.21, 0.17, 0.21, skinMat);
    hand.position.y = -0.4;
    hand.name = 'hand';
    fore.add(hand);
    return { pivot, fore, hand, side };
  }

  getHandPositions() {
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    this.armL.hand.getWorldPosition(a);
    this.armR.hand.getWorldPosition(b);
    return [a, b];
  }
  setHands(v) {
    this.armL.hand.visible = v;
    this.armR.hand.visible = v;
  }
  setHand(side, v) { (side === 0 ? this.armL : this.armR).hand.visible = v; }

  _leg(shortMat, skinMat, shoeMat, side) {
    const trim = this.materials.trim;
    const pivot = new THREE.Group();            // hip
    // thigh (shorts) + cuff (trim) use DIFFERENT materials -> can't merge
    // without a multi-material array, which would break the whole-body tint
    // abilities (they read a single `mesh.material.color`) — left separate.
    const thigh = box(0.28, 0.4, 0.29, shortMat);       // blue shorts, knee-length
    thigh.position.y = -0.2;
    pivot.add(thigh);
    const cuff = box(0.31, 0.09, 0.31, trim);           // rolled white hem
    cuff.position.y = -0.385;
    pivot.add(cuff);
    const shin = new THREE.Group();             // knee
    shin.position.y = -0.34;
    pivot.add(shin);
    const calf = box(0.21, 0.34, 0.23, skinMat);        // bare lower leg
    calf.position.y = -0.17;
    shin.add(calf);
    const ankle = new THREE.Group();            // ankle
    ankle.position.y = -0.34;
    shin.add(ankle);
    // brown thong sandal: sole + instep strap + toe strap merged (shoe), 3 little toes merged (skin)
    const sandal = mergeBoxes([
      { w: 0.24, h: 0.06, d: 0.42, x: 0, y: -0.05, z: 0.06 },   // sole
      { w: 0.24, h: 0.05, d: 0.12, x: 0, y: 0.02, z: -0.02 },   // instep
      { w: 0.05, h: 0.05, d: 0.18, x: 0, y: -0.01, z: 0.13 },   // thong
    ], shoeMat);
    sandal.name = 'sandal';
    ankle.add(sandal);
    const toeSpecs = [];
    for (let i = -1; i <= 1; i++) toeSpecs.push({ w: 0.055, h: 0.055, d: 0.06, x: i * 0.065, y: -0.03, z: 0.24 });
    const toes = mergeBoxes(toeSpecs, skinMat);
    toes.name = 'toes';
    ankle.add(toes);
    return { pivot, shin, ankle, side };
  }

  setState(s) {
    if (s === this.state) return;
    this._prevState = this.state;
    this.state = s;
    this._stateTime = 0;
  }
  castPose(kind) { this._castKind = kind; }
  /** play the Gear 5 "Liberation" pose — arms flung wide, arched back, head up. */
  gear5Awaken() { this._g5AwakenT = 1.1; }

  /** Shared shell-building helper: clones every real body mesh's geometry into a
      thin extruded-shell child using `mat`, tagged `userData.shell=true` so no
      other shell system's traversal ever re-shells it (name-substring matching
      broke down once suffixes like "__hakiglow" stopped literally containing
      "__glow" — a real bug from the v1 Haki pass, fixed here for good).
      `filterFn(mesh)` optionally restricts which real meshes get a shell
      (e.g. Busoshoku only wants arm/hand, not the whole body). */
  _buildShell(mat, filterFn) {
    const shells = [];
    this.root.traverse((c) => {
      if (!c.isMesh || !c.geometry || c.userData.shell) return;
      if (c.name.endsWith('__outline')) return;
      if (filterFn && !filterFn(c)) return;
      const s = new THREE.Mesh(c.geometry, mat);
      s.name = (c.name || 'm') + '__shell';
      s.userData.shell = true;
      s.castShadow = false; s.receiveShadow = false; s.frustumCulled = c.frustumCulled;
      c.add(s); shells.push(s);
    });
    return shells;
  }

  /** bright additive RIM-LIGHT around every body mesh (Gear 5). Built lazily. */
  setGlow(on) {
    if (on && !this._glowShells) {
      this._glowMat = new THREE.ShaderMaterial({
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
        uniforms: { uThickness: { value: 0.0075 }, uColor: { value: new THREE.Color(0xffffff) }, uT: { value: 0 } },
        vertexShader: `uniform float uThickness; void main(){ vec3 n = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); mv.xyz += n*uThickness*max(-mv.z,1.0); gl_Position = projectionMatrix*mv; }`,
        fragmentShader: `uniform vec3 uColor; uniform float uT; void main(){ gl_FragColor = vec4(uColor, 0.22 + 0.1*sin(uT*7.0)); }`,
      });
      this._glowShells = this._buildShell(this._glowMat);
    }
    if (this._glowShells) for (const s of this._glowShells) s.visible = !!on;
  }

  /** Busoshoku "tell" — a hardened black-armor coat on the fists/forearms
      (per spec: cheap, always-on-capable across many players at once), with
      a cheap fresnel-style icy edge-glint so it actually reads as "armored"
      at a glance instead of a flat translucent tint. Independent shell set
      from setGlow/setObservationAura so none fight over the same mesh's
      visible flag. Built lazily, same technique. */
  setHakiCoat(on) {
    if (on && !this._hakiShells) {
      this._hakiMat = new THREE.ShaderMaterial({
        transparent: true, blending: THREE.NormalBlending, depthWrite: false, side: THREE.BackSide,
        uniforms: { uThickness: { value: 0.012 }, uColor: { value: new THREE.Color(0x08080d) }, uEdge: { value: new THREE.Color(0x9fd0ff) }, uT: { value: 0 } },
        vertexShader: `
          uniform float uThickness; varying float vFres;
          void main(){
            vec3 n = normalize(normalMatrix*normal);
            vFres = pow(1.0 - clamp(abs(n.z), 0.0, 1.0), 2.2);
            vec4 mv = modelViewMatrix*vec4(position,1.0);
            mv.xyz += n*uThickness*max(-mv.z,1.0);
            gl_Position = projectionMatrix*mv;
          }`,
        fragmentShader: `
          uniform vec3 uColor; uniform vec3 uEdge; uniform float uT; varying float vFres;
          void main(){
            float pulse = 0.5 + 0.5*sin(uT*6.0);
            vec3 col = mix(uColor, uEdge, vFres*0.9 + pulse*0.06);
            gl_FragColor = vec4(col, 0.9);
          }`,
      });
      this._hakiShells = this._buildShell(this._hakiMat, (c) => c.name === 'arm' || c.name === 'hand');
    }
    if (this._hakiShells) for (const s of this._hakiShells) s.visible = !!on;
  }

  /** Kenbunshoku "tell" — a pale blue-white full-body field, bright enough at
      the silhouette edges to actually read against a sky, still cheap (no
      particles, one static material — the sonar-style pulse ring is handled
      separately in Haki.js via a plain vfx.ring so it stays a once-in-a-while
      cost, not a per-frame one). */
  setObservationAura(on) {
    if (on && !this._kenShells) {
      this._kenMat = new THREE.ShaderMaterial({
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
        uniforms: { uThickness: { value: 0.009 }, uColor: { value: new THREE.Color(0x2f7fd6) }, uEdge: { value: new THREE.Color(0xdff4ff) }, uT: { value: 0 } },
        vertexShader: `
          uniform float uThickness; varying float vFres;
          void main(){
            vec3 n = normalize(normalMatrix*normal);
            vFres = pow(1.0 - clamp(abs(n.z), 0.0, 1.0), 1.6);
            vec4 mv = modelViewMatrix*vec4(position,1.0);
            mv.xyz += n*uThickness*max(-mv.z,1.0);
            gl_Position = projectionMatrix*mv;
          }`,
        fragmentShader: `
          uniform vec3 uColor; uniform vec3 uEdge; uniform float uT; varying float vFres;
          void main(){
            float pulse = 0.6 + 0.4*sin(uT*2.2);
            vec3 col = mix(uColor, uEdge, vFres);
            gl_FragColor = vec4(col, (0.22 + vFres*0.35) * pulse);
          }`,
      });
      this._kenShells = this._buildShell(this._kenMat);
    }
    if (this._kenShells) for (const s of this._kenShells) s.visible = !!on;
  }

  /**
   * @param {number} dt
   * @param {object} ctx
   *   speed:0..1        normalised move speed (walk≈0.5, run≈1)
   *   groundSpeed:m/s   actual horizontal speed (used to lock stride to distance)
   *   turn:rad/s        facing change rate (lean into turns)
   *   grounded, inWater, vertVel, aim, attackPose
   */
  update(dt, ctx = {}) {
    dt = Math.min(dt, 1 / 30);
    const L = THREE.MathUtils;
    const speedIn = L.clamp(ctx.speed ?? 0, 0, 1);
    const groundSpeed = ctx.groundSpeed ?? speedIn * 10.5;

    // smoothed locomotion drivers
    this._gait = L.damp(this._gait, speedIn > 0.03 ? 1 : 0, 12, dt);
    this._run = L.damp(this._run, L.smoothstep(speedIn, 0.5, 1.0), 8, dt);
    this._lean = L.damp(this._lean, L.clamp((ctx.turn ?? 0) * 0.5, -0.4, 0.4), 7, dt);
    const move01 = L.smoothstep(this._gait, 0.05, 0.55);
    const run01 = this._run;

    // gait phase advances by real ground distance so the feet never slip
    const strideLen = L.lerp(1.15, 2.2, run01);
    const cadence = groundSpeed > 0.08 ? groundSpeed / strideLen : 0;   // steps / sec
    this._phase += dt * cadence * Math.PI;                              // π per step
    if (cadence < 0.01) {
      const snap = Math.round(this._phase / Math.PI) * Math.PI;
      this._phase = L.damp(this._phase, snap, 6, dt);
    }
    this._phase %= Math.PI * 2;

    this._breatheT += dt;
    this._stateTime += dt;
    this.animT += dt;
    if (this._g5AwakenT > 0) this._g5AwakenT = Math.max(0, this._g5AwakenT - dt);
    if (this._phxAwakenT > 0) this._phxAwakenT = Math.max(0, this._phxAwakenT - dt / 0.6);
    if (this._glowMat && this._form === 'gear5') this._glowMat.uniforms.uT.value = this.animT;
    if (this._hakiMat) this._hakiMat.uniforms.uT.value = this.animT;
    if (this._kenMat) this._kenMat.uniforms.uT.value = this.animT;
    const t = this.animT;

    // ---- state ----
    if (ctx.flying) this.setState('fly');
    else if (ctx.inWater) this.setState(speedIn > 0.05 ? 'swim' : 'tread');
    else if (!ctx.grounded) this.setState(ctx.vertVel > 1 ? 'jump' : 'fall');
    else this.setState('ground');
    if (ctx.attackPose && ctx.grounded && !ctx.inWater) this.setState('attack');

    // ---- reset pose (everything additive from here) ----
    const R = (o, x, y, z) => o.rotation.set(x, y, z);
    R(this.torso, 0, 0, 0); R(this.neck, 0, 0, 0); R(this.hat, 0, 0, 0);
    R(this.armL.pivot, 0, 0, 0.08); R(this.armL.fore, 0, 0, 0);
    R(this.armR.pivot, 0, 0, -0.08); R(this.armR.fore, 0, 0, 0);
    R(this.legL.pivot, 0, 0, 0); R(this.legL.shin, 0, 0, 0); R(this.legL.ankle, 0, 0, 0);
    R(this.legR.pivot, 0, 0, 0); R(this.legR.shin, 0, 0, 0); R(this.legR.ankle, 0, 0, 0);
    this.torso.position.set(0, 1.12, 0);

    switch (this.state) {
      case 'ground':
        this._poseIdle(1 - move01);
        this._poseLocomotion(move01, run01);
        break;
      case 'attack':
        this._poseLocomotion(move01 * 0.45, run01);
        this._poseAttack();
        break;
      case 'jump':
        this.torso.rotation.x = -0.18;
        this.armL.pivot.rotation.z = 1.5; this.armR.pivot.rotation.z = -1.5;
        this.armL.pivot.rotation.x = -0.6; this.armR.pivot.rotation.x = -0.6;
        this.legL.pivot.rotation.x = 0.55; this.legL.shin.rotation.x = 0.9;
        this.legR.pivot.rotation.x = -0.25; this.legR.shin.rotation.x = 0.25;
        this.neck.rotation.x = -0.15;
        break;
      case 'fall':
        this.torso.rotation.x = 0.08;
        this.armL.pivot.rotation.z = 1.9 + Math.sin(t * 9) * 0.18;
        this.armR.pivot.rotation.z = -1.9 - Math.sin(t * 9) * 0.18;
        this.armL.pivot.rotation.x = -0.3; this.armR.pivot.rotation.x = -0.3;
        this.legL.pivot.rotation.x = -0.35; this.legR.pivot.rotation.x = 0.25;
        this.legR.shin.rotation.x = 0.5;
        break;
      case 'tread': {
        const b = Math.sin(this._breatheT * 1.7) * 0.03;
        this.torso.position.y = 1.12 + b;
        this.torso.rotation.x = 0.1;
        this.armL.pivot.rotation.z = 1.25 + Math.sin(t * 2) * 0.18;
        this.armR.pivot.rotation.z = -1.25 - Math.sin(t * 2 + 1) * 0.18;
        this.armL.pivot.rotation.x = Math.sin(t * 3) * 0.28;
        this.armR.pivot.rotation.x = Math.sin(t * 3 + Math.PI) * 0.28;
        this.legL.pivot.rotation.x = Math.sin(t * 2.4) * 0.5;
        this.legR.pivot.rotation.x = Math.sin(t * 2.4 + Math.PI) * 0.5;
        this.legL.shin.rotation.x = 0.5; this.legR.shin.rotation.x = 0.5;
        break;
      }
      case 'fly': {
        const f = t * 9;
        this.torso.rotation.x = 0.6;                       // pitched forward, prone-ish
        this.torso.position.y = 1.16;
        this.neck.rotation.x = -0.55;                      // head up, eyes forward
        this.armL.pivot.rotation.x = 2.35 + Math.sin(f) * 0.12;      // arms swept back
        this.armR.pivot.rotation.x = 2.35 + Math.sin(f + 1) * 0.12;
        this.armL.pivot.rotation.z = 0.35; this.armR.pivot.rotation.z = -0.35;
        this.armL.fore.rotation.x = -0.3; this.armR.fore.rotation.x = -0.3;
        this.legL.pivot.rotation.x = -0.45 + Math.sin(f * 0.8) * 0.1;  // legs trailing
        this.legR.pivot.rotation.x = -0.45 + Math.sin(f * 0.8 + 1) * 0.1;
        this.legL.shin.rotation.x = 0.35; this.legR.shin.rotation.x = 0.35;
        this.legL.ankle.rotation.x = 0.4; this.legR.ankle.rotation.x = 0.4;
        this.hat.rotation.x = -0.1;
        break;
      }
      case 'swim': {
        const f = t * 3.4;
        this.torso.rotation.x = 1.15;
        this.torso.position.y = 1.0;
        this.neck.rotation.x = -0.9;
        this.armL.pivot.rotation.x = Math.sin(f) * 2.4 - 0.4;
        this.armR.pivot.rotation.x = Math.sin(f + Math.PI) * 2.4 - 0.4;
        this.armL.pivot.rotation.z = 0.25; this.armR.pivot.rotation.z = -0.25;
        this.legL.pivot.rotation.x = Math.sin(f * 1.4) * 0.45;
        this.legR.pivot.rotation.x = Math.sin(f * 1.4 + Math.PI) * 0.45;
        break;
      }
    }

    if (ctx.aim && this.state === 'ground') this._poseAim();

    // transformation add-on motion
    if (this._form === 'phoenix' && this.phoenix.visible) {
      this._animPhoenix(t, ctx);
    } else if (this._form === 'gear5' && this.gear5Hair.visible) {
      this._animGear5(t, move01);
    }
  }

  /* Gear 5 — loose, springy rubber-hose stance; and the arched-back "Liberation"
     pose for ~1 s right after the awakening. Everything additive. */
  _animGear5(t, move01) {
    const L = THREE.MathUtils;
    this.gear5Hair.rotation.x = Math.sin(t * 2) * 0.06;
    this.gear5Hair.rotation.z = Math.sin(t * 1.6 + 1) * 0.05;

    if (this._g5AwakenT > 0) {
      const k = L.smoothstep(this._g5AwakenT / 1.1, 0, 1);   // 1 at start -> 0
      const s = Math.sin(k * Math.PI);                       // ease bump
      this.torso.rotation.x += -0.7 * k;                     // arch back
      this.torso.position.y += 0.12 * s;
      this.neck.rotation.x += -0.85 * k;                     // head thrown back
      this.hat.rotation.x += -0.35 * k;
      this.armL.pivot.rotation.z += 2.5 * k; this.armR.pivot.rotation.z += -2.5 * k;   // arms flung wide + up
      this.armL.pivot.rotation.x += -0.9 * k; this.armR.pivot.rotation.x += -0.9 * k;
      this.armL.fore.rotation.x += -0.2 * k; this.armR.fore.rotation.x += -0.2 * k;
      this.legL.pivot.rotation.x += 0.3 * k; this.legR.pivot.rotation.x += -0.3 * k;   // planted wide
      this.legL.shin.rotation.x += 0.25 * k; this.legR.shin.rotation.x += 0.25 * k;
      return;
    }

    // persistent stance — Gear 5 "Nika": LYING BACK in the air like an invisible
    // recliner — belly up, head lifted looking forward, BOTH hands laced behind
    // the head, legs CROSSED one over the other, floating. IDLE ONLY (fades the
    // instant you walk or run, so travel looks completely normal).
    const w = L.clamp(1 - move01 * 3, 0, 1);
    if (w < 0.02) return;
    const bob = Math.sin(t * 1.2);

    // float clear of the ground + a slow drift
    this.root.position.y += (0.85 + bob * 0.12) * w;
    // torso tips way back toward horizontal (negative X = lean back in this rig)
    this.torso.rotation.x += -1.24 * w;
    this.torso.rotation.y += Math.sin(t * 0.3) * 0.06 * w;
    this.torso.rotation.z += Math.sin(t * 0.45) * 0.05 * w;
    // head counter-rotates so the face stays up and pointed forward
    this.neck.rotation.x += 1.0 * w + Math.sin(t * 0.9) * 0.03;
    this.neck.rotation.z += Math.sin(t * 0.6) * 0.04 * w;
    this.hat.rotation.x += 0.16 * w;

    // BOTH arms up beside the head, elbows flared, forearms folded in behind it
    this.armR.pivot.rotation.z += -2.3 * w;
    this.armL.pivot.rotation.z += 2.3 * w;
    this.armR.pivot.rotation.x += -0.4 * w;
    this.armL.pivot.rotation.x += -0.4 * w;
    this.armR.fore.rotation.x += -2.1 * w + Math.sin(t * 1.1) * 0.03 * w;
    this.armL.fore.rotation.x += -2.1 * w + Math.sin(t * 1.1 + 1) * 0.03 * w;

    // legs extended along the body, RIGHT crossed over the LEFT
    this.legL.pivot.rotation.x += -0.16 * w;
    this.legL.pivot.rotation.z += -0.1 * w;
    this.legL.shin.rotation.x += 0.22 * w;
    this.legR.pivot.rotation.x += -0.34 * w;            // right thigh rides higher
    this.legR.pivot.rotation.z += 0.44 * w;             // swings across the left
    this.legR.shin.rotation.x += 0.5 * w;               // knee bent, shin laid over
    this.legL.ankle && (this.legL.ankle.rotation.x += 0.12 * w);
    this.legR.ankle && (this.legR.ankle.rotation.x += 0.2 * w);
  }

  /* Illusory phoenix: a few big clean flame WINGS do the whole silhouette.
     The human's hands are hidden (setForm) and the arms tuck close to the
     body so nothing pokes through the wings. `_phxAwakenT` drives a one-shot
     unfurl from folded-behind-the-back to full span. */
  _animPhoenix(t, ctx) {
    const L = THREE.MathUtils;
    const fly = ctx.flying ? 1 : 0;
    const g = this.phoenix;

    const unfurl = 1 - this._phxAwakenT;                 // 0 folded -> 1 open (ticked in update())
    const ease = unfurl * unfurl * (3 - 2 * unfurl);     // smoothstep

    const bob = fly ? Math.sin(t * 3.4) * 0.07 : Math.sin(t * 2.0) * 0.035;
    g.position.set(0, bob, 0);
    g.rotation.set(fly ? L.clamp(-(ctx.vertVel || 0) * 0.02, -0.3, 0.3) : 0, 0, L.clamp((ctx.turn || 0) * -0.08, -0.3, 0.3));

    // ---- wings: aligned, clean flap. Neutral pose = swept slightly back and
    // level; flap rocks them up/down. Unfurl sweeps them from folded (rotated
    // right back over the spine, scaled down) to full. ----
    const rate = fly ? 5.5 : 3.0;
    const swing = Math.sin(t * rate);
    const foldZ = -2.0;                                  // folded: pointing up/back over the shoulders
    const openZ = fly ? -0.05 : 0.16;                    // open: near-level, tips a touch up
    const restZ = L.lerp(foldZ, openZ, ease);
    const flapAmp = (fly ? 0.55 : 0.22) * ease;
    const sweepBack = L.lerp(0.9, 0.12, ease);           // folded wings also rotate back on Y
    for (const w of this._phxWings) {
      const s = w.userData.sgn;
      w.rotation.set(
        -0.06 + swing * 0.16 * (fly ? 1 : 0.5),          // x: slight forward/back rock
        s * -sweepBack,                                   // y: swept back, less as it opens
        s * (restZ - swing * flapAmp)                     // z: the flap
      );
      w.scale.setScalar(0.4 + 0.6 * ease);
      if (w.userData.tipEmber) {
        const f = 0.65 + 0.35 * Math.sin(t * 18 + s * 2);
        w.userData.tipEmber.scale.setScalar(f * (0.6 + 0.4 * ease));
        w.userData.tipEmber.material.opacity = 0.5 * f * ease;
      }
    }

    // ---- tail: trails straight back, gentle sway ----
    this._phxTail.rotation.x = (fly ? -0.28 : 0.1) + Math.sin(t * 1.8) * 0.08;
    this._phxTail.rotation.z = Math.sin(t * 1.3) * 0.1;
    this._phxTail.scale.setScalar(0.5 + 0.5 * ease);
    this._phxTail.children.forEach((fe, k) => {
      fe.rotation.z = -0.12 + Math.sin(t * 2.6 + k) * 0.08;
    });

    // ---- aura + halo + crest ----
    if (this._phxAura) {
      const s = 1 + Math.sin(t * 3.6) * 0.06;
      this._phxAura.scale.set(0.85 * s, 1.5 * s, 0.85 * s);
      this._phxAura.rotation.y = t * 0.6;
    }
    if (this._phxAuraCore) {
      this._phxAuraCore.scale.setScalar((1 + Math.sin(t * 6) * 0.14) * (0.5 + 0.5 * ease));
      this._phxAuraCore.rotation.y = -t;
    }
    if (this._phxHalo) {
      this._phxHalo.position.y = 2.02 + Math.sin(t * 2.4) * 0.03;
      this._phxHalo.rotation.z = t * 1.1;
      this._phxHalo.scale.setScalar(0.6 + 0.4 * ease);
    }
    for (let i = 0; i < (this._phxCrest || []).length; i++) {
      this._phxCrest[i].rotation.y = (i - 1) * 0.4 + Math.sin(t * 2.8 + i) * 0.06;
    }

    // ---- human: hands are hidden; keep the arms tucked in close so they
    // never poke out past the wings ----
    this.armL.pivot.rotation.z += 0.16;
    this.armR.pivot.rotation.z += -0.16;
    this.armL.pivot.rotation.x += 0.12 + Math.sin(t * 1.6) * 0.03;
    this.armR.pivot.rotation.x += 0.12 + Math.sin(t * 1.6 + 1) * 0.03;
    this.armL.fore.rotation.x += -0.5;
    this.armR.fore.rotation.x += -0.5;
  }

  _poseIdle(w) {
    if (w <= 0.002) return;
    const t = this._breatheT;
    this.torso.position.y += Math.sin(t * 1.7) * 0.028 * w;
    this.torso.rotation.z += Math.sin(t * 0.55) * 0.014 * w;
    this.neck.rotation.x += Math.sin(t * 1.3) * 0.03 * w;
    this.neck.rotation.y += Math.sin(t * 0.4) * 0.06 * w;
    this.armL.pivot.rotation.z += (0.05 + Math.sin(t * 1.2) * 0.025) * w;
    this.armR.pivot.rotation.z += (-0.05 - Math.sin(t * 1.2 + 1) * 0.025) * w;
    this.armL.pivot.rotation.x += Math.sin(t * 1.0) * 0.04 * w;
    this.armR.pivot.rotation.x += Math.sin(t * 1.0 + 0.7) * 0.04 * w;
  }

  _poseLocomotion(w, run01) {
    if (w <= 0.002) return;
    const L = THREE.MathUtils;
    const p = this._phase;
    const s = Math.sin(p);            // left leg drive
    const s2 = Math.sin(p + Math.PI); // right leg drive (opposite)
    const c2 = Math.cos(2 * p);       // twice per cycle -> vertical bob

    const thighAmp = L.lerp(0.5, 0.98, run01) * w;
    const kneeAmp = L.lerp(0.9, 1.7, run01) * w;
    const armAmp = L.lerp(0.35, 0.9, run01) * w;
    const lean = L.lerp(0.05, 0.21, run01) * w;
    const bobAmp = L.lerp(0.028, 0.07, run01) * w;
    const rollAmp = L.lerp(0.025, 0.055, run01) * w;
    const twistAmp = L.lerp(0.04, 0.11, run01) * w;

    // legs — thigh swing + knee bend through the swing phase + ankle roll
    this.legL.pivot.rotation.x += s * thighAmp;
    this.legR.pivot.rotation.x += s2 * thighAmp;
    const kneeL = Math.max(0, -Math.sin(p - 0.5)) * kneeAmp + Math.max(0, s) * 0.12 * w;
    const kneeR = Math.max(0, -Math.sin(p + Math.PI - 0.5)) * kneeAmp + Math.max(0, s2) * 0.12 * w;
    this.legL.shin.rotation.x += kneeL;
    this.legR.shin.rotation.x += kneeR;
    // ankle: soak up knee bend so the sole stays flatter, then a toe-off push at the back
    this.legL.ankle.rotation.x += -kneeL * 0.55 + Math.max(0, -s) * 0.28 * w + Math.max(0, Math.sin(p + 0.5)) * 0.3 * w - 0.06 * w;
    this.legR.ankle.rotation.x += -kneeR * 0.55 + Math.max(0, -s2) * 0.28 * w + Math.max(0, Math.sin(p + Math.PI + 0.5)) * 0.3 * w - 0.06 * w;

    // arms — opposite phase, elbow tucks more at a run
    this.armL.pivot.rotation.x += -s * armAmp;
    this.armR.pivot.rotation.x += -s2 * armAmp;
    this.armL.pivot.rotation.z += 0.12 * run01 * w;
    this.armR.pivot.rotation.z += -0.12 * run01 * w;
    const elbow = -(0.15 + run01 * 0.55) * w;
    this.armL.fore.rotation.x += elbow - Math.max(0, s) * 0.4 * w;
    this.armR.fore.rotation.x += elbow - Math.max(0, s2) * 0.4 * w;

    // torso — lean in, double vertical bob, roll toward stance leg, counter-twist
    this.torso.rotation.x += lean + Math.abs(s) * 0.02 * w;
    this.torso.position.y += -c2 * bobAmp * 0.5;          // up at mid-stance, down at contact
    this.torso.rotation.z += -s * rollAmp + this._lean * 0.5;
    this.torso.rotation.y += s * twistAmp;
    this.torso.position.z += -Math.abs(s) * 0.014 * w;

    // head stabilises against the pitch and looks into turns; hat lags a touch
    this.neck.rotation.x += -lean * 0.78 + c2 * 0.014 * w;
    this.neck.rotation.z += this._lean * 0.35;
    this.hat.rotation.z += s * rollAmp * 0.6 - this._lean * 0.2;
    this.hat.rotation.x += -this.torso.rotation.x * 0.14 + c2 * 0.02 * w;
  }

  _poseAttack() {
    const kind = this._castKind || 'punch';
    const k = Math.min(1, this._stateTime / 0.3);
    const s = Math.sin(k * Math.PI);
    if (kind === 'thrust') {
      this.torso.rotation.y += -0.6 * s;
      this.armR.pivot.rotation.x += -0.3 - s * 2.4;
      this.armR.fore.rotation.x += -0.15 - (1 - s) * 0.7;
      this.armL.pivot.rotation.x += 0.5 * s; this.armL.pivot.rotation.z += 0.35;
      this.torso.rotation.x += 0.15 * s; this.legR.pivot.rotation.x += -0.4 * s;
    } else if (kind === 'slam') {
      const down = k < 0.4 ? -1 + k / 0.4 : 1;                 // arms up then smash down
      this.armL.pivot.rotation.x += -2.4 * (1 - Math.max(0, down));
      this.armR.pivot.rotation.x += -2.4 * (1 - Math.max(0, down));
      this.armL.pivot.rotation.x += 1.4 * Math.max(0, down);
      this.armR.pivot.rotation.x += 1.4 * Math.max(0, down);
      this.torso.rotation.x += 0.35 * Math.max(0, down) - 0.2 * (1 - Math.max(0, down));
      this.legL.pivot.rotation.x += 0.3; this.legR.pivot.rotation.x += 0.3;
    } else if (kind === 'raise') {
      this.armL.pivot.rotation.x += -2.6 * s; this.armR.pivot.rotation.x += -2.6 * s;
      this.armL.pivot.rotation.z += 0.3; this.armR.pivot.rotation.z += -0.3;
      this.torso.rotation.x += -0.15 * s; this.neck.rotation.x += -0.25 * s;
    } else if (kind === 'sweep') {
      this.torso.rotation.y += (0.7 - 1.4 * k);
      this.armR.pivot.rotation.x += -1.4; this.armR.pivot.rotation.y += 1.2 - 2.2 * k;
      this.armR.fore.rotation.x += -0.3;
    } else {                                                    // punch
      this.torso.rotation.y += -0.5 * s;
      this.armR.pivot.rotation.x += -0.4 - s * 2.2;
      this.armR.fore.rotation.x += -0.2 - (1 - s) * 0.8;
      this.armL.pivot.rotation.x += 0.6 * s; this.armL.pivot.rotation.z += 0.4;
      this.legR.pivot.rotation.x += -0.35 * s;
    }
  }

  _poseAim() {
    this.armR.pivot.rotation.set(-1.3, 0, -0.2);
    this.armR.fore.rotation.x = -0.1;
    this.torso.rotation.y += -0.22;
    this.neck.rotation.y += 0.1;
  }
}
