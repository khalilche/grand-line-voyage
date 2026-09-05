import * as THREE from 'three';
import { toonMaterial, addOutline, outlineGroup } from '../rendering/toon.js';
import { makeRng } from './noise.js';

/**
 * Placeable structures. Each builder returns { group, meta } where the group is
 * positioned at its own local origin (the Island places it) and meta carries
 * anchor points (boss arena, npc/enemy spots) in the group's local space.
 */

/* ------------------------------------------------------------------ *
 *  Pirate village — thatched houses around a well, on a flattened pad.
 * ------------------------------------------------------------------ */
export function buildVillage({ seed = 1, houses = 10 } = {}) {
  const rng = makeRng(seed ^ 0x51);
  const group = new THREE.Group();
  const meta = { spots: [], radius: 22 };

  const wall = toonMaterial({ color: 0xd8b98a, stops: 3, rim: 0xffe9c8, rimStrength: 0.2 });
  const wall2 = toonMaterial({ color: 0xc79b6b, stops: 3 });
  const roof = toonMaterial({ color: 0x9c4b39, stops: 3, rim: 0xe08b6a, rimStrength: 0.2 });
  const roof2 = toonMaterial({ color: 0x7d5a37, stops: 3 });
  const wood = toonMaterial({ color: 0x6d4a2b, stops: 3 });
  const stone = toonMaterial({ color: 0x8b929c, stops: 3, toe: 70 });

  const houseProtoA = _house(wall, roof, wood);
  const houseProtoB = _house(wall2, roof2, wood);

  const ring = meta.radius;
  for (let i = 0; i < houses; i++) {
    const a = (i / houses) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const rad = ring * (0.45 + rng() * 0.6);
    const h = (i % 2 ? houseProtoB : houseProtoA).clone();
    h.position.set(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    h.rotation.y = -a + Math.PI + (rng() - 0.5) * 0.5;
    const s = 0.85 + rng() * 0.5;
    h.scale.setScalar(s);
    group.add(h);
  }

  // central well
  const well = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 1.2, 12), stone);
  base.position.y = 0.6;
  const water = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.1, 12),
    toonMaterial({ color: 0x2f88c0, stops: 2, rimStrength: 0 }));
  water.position.y = 1.0;
  const postL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.4, 0.2), wood); postL.position.set(-1.2, 1.8, 0);
  const postR = postL.clone(); postR.position.x = 1.2;
  const beam = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.2, 0.2), wood); beam.position.y = 3.0;
  const roofw = new THREE.Mesh(new THREE.ConeGeometry(1.9, 1.0, 4), roof); roofw.position.y = 3.6; roofw.rotation.y = Math.PI / 4;
  well.add(base, water, postL, postR, beam, roofw);
  well.traverse((c) => { if (c.isMesh) c.castShadow = true; });
  group.add(well);

  // market stall + crates near the well (shopkeeper spot)
  const stall = _stall(wood, roof);
  stall.position.set(4.5, 0, 2);
  stall.rotation.y = -1.1;
  group.add(stall);
  meta.spots.push({ role: 'shopkeeper', x: 5.6, z: 2.6 });

  outlineGroup(group, { thickness: 0.0035 });
  group.traverse((c) => { if (c.isMesh && !c.name.endsWith('__outline')) { c.castShadow = true; c.receiveShadow = true; } });
  return { group, meta };
}

function _house(wallMat, roofMat, woodMat) {
  const g = new THREE.Group();
  const w = 3.4, d = 3.0, wallH = 2.5, rise = 1.35;
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
  body.position.y = wallH / 2;
  g.add(body);

  // gable triangles fill the wall-to-ridge gap on the front/back
  const gable = new THREE.BufferGeometry();
  gable.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -w / 2, 0, 0, w / 2, 0, 0, 0, rise, 0
  ]), 3));
  gable.computeVertexNormals();
  const gableMat = wallMat.clone();
  gableMat.side = THREE.DoubleSide;
  for (const s of [-1, 1]) {
    const tri = new THREE.Mesh(gable, gableMat);
    tri.position.set(0, wallH, s * d / 2);
    g.add(tri);
  }

  // two slanted roof slabs meeting at the ridge, with eave overhang
  const pitch = Math.atan2(rise, w / 2);
  const rlen = Math.hypot(w / 2, rise) + 0.5;
  for (const s of [-1, 1]) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(rlen, 0.16, d + 0.8), roofMat);
    slab.position.set(s * (w / 4), wallH + rise / 2, 0);
    slab.rotation.z = -s * pitch;
    g.add(slab);
  }
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, d + 0.85), woodMat);
  ridge.position.y = wallH + rise;
  g.add(ridge);

  // door + a couple of windows
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.6, 0.1), woodMat);
  door.position.set(0, 0.8, d / 2 + 0.02);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.08, 1.78, 0.06), woodMat);
  frame.position.set(0, 0.89, d / 2 + 0.01);
  g.add(frame, door);
  for (const s of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.66, 0.08), woodMat);
    win.position.set(s * (w / 2 + 0.01), 1.7, 0.4);
    win.rotation.y = Math.PI / 2;
    g.add(win);
  }
  g.traverse((c) => { if (c.isMesh) c.castShadow = c.receiveShadow = true; });
  return g;
}

function _stall(woodMat, clothMat) {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.0, 1.6), woodMat);
  top.position.y = 1.0;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.0, 0.14), woodMat);
    leg.position.set(sx * 1.1, 0.5, sz * 0.6);
    g.add(leg);
  }
  const awning = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.1, 1.9), clothMat);
  awning.position.set(0, 1.7, -0.3);
  awning.rotation.x = -0.25;
  g.add(top, awning);
  g.traverse((c) => { if (c.isMesh) c.castShadow = true; });
  return g;
}

/* ------------------------------------------------------------------ *
 *  Bandit camp — tents around a campfire, ringed by a stake palisade.
 * ------------------------------------------------------------------ */
export function buildBanditCamp({ seed = 1 } = {}) {
  const rng = makeRng(seed ^ 0x7d);
  const group = new THREE.Group();
  const meta = { spots: [], radius: 18, fire: null };

  const cloth = toonMaterial({ color: 0x8a5a3c, stops: 3 });
  const cloth2 = toonMaterial({ color: 0x6d4a3a, stops: 3 });
  const wood = toonMaterial({ color: 0x5c4230, stops: 3 });
  const iron = toonMaterial({ color: 0x3c3f45, stops: 3, toe: 60 });

  // tents
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rng() * 0.5;
    const rad = 7 + rng() * 5;
    const tent = _tent(i % 2 ? cloth2 : cloth, wood);
    tent.position.set(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    tent.rotation.y = rng() * Math.PI * 2;
    group.add(tent);
    meta.spots.push({ role: 'enemy', x: Math.cos(a) * rad, z: Math.sin(a) * rad });
  }

  // campfire
  const fire = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 1.6, 6), wood);
    const a = (i / 5) * Math.PI * 2;
    log.position.set(Math.cos(a) * 0.4, 0.2, Math.sin(a) * 0.4);
    log.rotation.set(Math.PI / 2 - 0.5, a, 0);
    fire.add(log);
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.4, 7),
    new THREE.MeshBasicMaterial({ color: 0xff8a3c }));
  flame.position.y = 0.9;
  flame.name = 'campfire-flame';
  const glow = new THREE.Mesh(new THREE.SphereGeometry(1.3, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xff7a2c, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.y = 0.8;
  fire.add(flame, glow);
  group.add(fire);
  meta.fire = fire;

  // palisade arc
  const stakeMat = wood;
  for (let i = 0; i < 22; i++) {
    const a = -0.9 + (i / 22) * 3.2;
    const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 2.6, 5), stakeMat);
    stake.position.set(Math.cos(a) * meta.radius, 1.0, Math.sin(a) * meta.radius);
    stake.rotation.z = (rng() - 0.5) * 0.2;
    // pointed top
    stake.geometry = stake.geometry;
    group.add(stake);
  }

  // crates + barrels
  for (let i = 0; i < 6; i++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), i % 2 ? wood : cloth2);
    box.position.set((rng() - 0.5) * 10, 0.5, (rng() - 0.5) * 10);
    box.rotation.y = rng() * 3;
    group.add(box);
  }

  outlineGroup(group, { thickness: 0.0035 });
  group.traverse((c) => {
    if (c.isMesh && !c.name.endsWith('__outline') && c.name !== 'campfire-flame') {
      c.castShadow = true; c.receiveShadow = true;
    }
  });
  return { group, meta };
}

function _tent(clothMat, woodMat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(2.0, 2.6, 4), clothMat);
  body.position.y = 1.3;
  body.rotation.y = Math.PI / 4;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.0, 5), woodMat);
  pole.position.y = 1.5;
  const flap = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.3, 0.05), clothMat);
  flap.position.set(0, 0.65, 1.4);
  flap.rotation.x = 0.3;
  g.add(body, pole, flap);
  g.traverse((c) => { if (c.isMesh) c.castShadow = true; });
  return g;
}

/* ------------------------------------------------------------------ *
 *  Jungle ruins — stepped stone dais with broken columns; boss arena.
 * ------------------------------------------------------------------ */
export function buildRuins({ seed = 1 } = {}) {
  const rng = makeRng(seed ^ 0x3a3);
  const group = new THREE.Group();
  const meta = { spots: [], radius: 20, arena: { x: 0, z: 0 } };

  const stone = toonMaterial({ color: 0x8a8f80, stops: 3, toe: 74 });
  const stoneMoss = toonMaterial({ color: 0x6f8a5a, stops: 3 });
  const gold = toonMaterial({ color: 0xd9b24a, stops: 3, rim: 0xfff0b0, rimStrength: 0.35 });

  // stepped platform
  for (let i = 0; i < 3; i++) {
    const s = 22 - i * 5;
    const step = new THREE.Mesh(new THREE.BoxGeometry(s, 1.0, s), i === 1 ? stoneMoss : stone);
    step.position.y = 0.5 + i * 0.9;
    step.receiveShadow = true;
    group.add(step);
  }
  const daisY = 0.5 + 2 * 0.9 + 0.5;

  // altar
  const altar = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.0, 1.4, 8), stone);
  altar.position.y = daisY + 0.7;
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), gold);
  orb.position.y = daisY + 2.0;
  orb.name = 'ruins-orb';
  group.add(altar, orb);
  meta.arena = { x: 0, z: 0, y: daisY };

  // broken columns around the dais
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const rad = 15 + rng() * 3;
    const broken = rng() < 0.45;
    const hgt = broken ? 1.5 + rng() * 2.5 : 5 + rng() * 2;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, hgt, 8), i % 3 === 0 ? stoneMoss : stone);
    col.position.set(Math.cos(a) * rad, hgt / 2, Math.sin(a) * rad);
    if (broken) col.rotation.z = (rng() - 0.5) * 0.4;
    col.castShadow = true;
    group.add(col);
    // a fallen segment
    if (broken && rng() < 0.5) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.7, 2.4, 8), stone);
      seg.position.set(Math.cos(a) * (rad + 2), 0.7, Math.sin(a) * (rad + 2));
      seg.rotation.set(Math.PI / 2, rng() * 3, 0);
      group.add(seg);
    }
    meta.spots.push({ role: 'enemy', x: Math.cos(a) * (rad + 5), z: Math.sin(a) * (rad + 5) });
  }

  // archway entrance
  const archL = new THREE.Mesh(new THREE.BoxGeometry(1.2, 6, 1.2), stone); archL.position.set(-3.5, 3, 20);
  const archR = archL.clone(); archR.position.x = 3.5;
  const archT = new THREE.Mesh(new THREE.BoxGeometry(9, 1.4, 1.4), stoneMoss); archT.position.set(0, 6.4, 20);
  group.add(archL, archR, archT);

  outlineGroup(group, { thickness: 0.0035 });
  group.traverse((c) => {
    if (c.isMesh && !c.name.endsWith('__outline') && c.name !== 'ruins-orb') {
      c.castShadow = true; c.receiveShadow = true;
    }
  });
  return { group, meta };
}

/* ------------------------------------------------------------------ *
 *  Battleground arena — a low central dais, broken arches, rock cover
 *  clusters, a boundary ring of pylons and a small training corner.
 * ------------------------------------------------------------------ */
export function buildArena({ seed = 1 } = {}) {
  const rng = makeRng(seed ^ 0x8b47);
  const group = new THREE.Group();
  const meta = { spots: [], radius: 90 };

  const stone = toonMaterial({ color: 0x757b85, stops: 3, toe: 72 });
  const stoneDark = toonMaterial({ color: 0x565b64, stops: 3 });
  const stoneWarm = toonMaterial({ color: 0xb7a075, stops: 3, rim: 0xffe6b0, rimStrength: 0.2 });
  const wood = toonMaterial({ color: 0x8a5a33, stops: 3, rim: 0xffd9a0, rimStrength: 0.2 });
  const rockMat = toonMaterial({ color: 0x6a707a, stops: 3, toe: 46, rimStrength: 0 });
  rockMat.flatShading = true;

  // --- central dais: two low tiers you can stand / land on ---
  const t0 = new THREE.Mesh(new THREE.CylinderGeometry(16, 17, 1.1, 40), stone);
  t0.position.y = 0.55; t0.receiveShadow = true;
  const t1 = new THREE.Mesh(new THREE.CylinderGeometry(11, 12, 1.0, 36), stoneDark);
  t1.position.y = 1.6; t1.receiveShadow = true;
  const centreMark = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 0.12, 32), stoneWarm);
  centreMark.position.y = 2.16;
  group.add(t0, t1, centreMark);

  // --- broken arches at the cardinals ---
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + 0.15;
    const rad = 40;
    const ax = Math.cos(a) * rad, az = Math.sin(a) * rad;
    const arch = new THREE.Group();
    arch.position.set(ax, 0, az);
    arch.rotation.y = Math.atan2(-ax, -az);
    const legH = 7 + rng() * 2;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(1.6, legH, 1.6), i % 2 ? stoneDark : stone);
    legL.position.set(-3, legH / 2, 0);
    const legR = legL.clone(); legR.position.x = 3;
    arch.add(legL, legR);
    if (rng() < 0.6) {
      const top = new THREE.Mesh(new THREE.BoxGeometry(9.4, 1.8, 1.7), stoneWarm);
      top.position.set(0, legH + 0.6, 0); top.rotation.z = (rng() - 0.5) * 0.12;
      arch.add(top);
    } else {
      legR.scale.y = 0.55; legR.position.y = legH * 0.275;   // one leg snapped
      const rubble = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 3.2), stone);
      rubble.position.set(3, 0.8, 3); rubble.rotation.set(0.3, rng() * 3, 0.2);
      arch.add(rubble);
    }
    group.add(arch);
  }

  // --- rock cover clusters ---
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  for (let c = 0; c < 7; c++) {
    const a = rng() * Math.PI * 2;
    const rad = 52 + rng() * 26;
    const cx = Math.cos(a) * rad, cz = Math.sin(a) * rad;
    const n = 3 + (rng() * 3 | 0);
    for (let k = 0; k < n; k++) {
      const g = rockGeo.clone();
      const gp = g.attributes.position;
      for (let v = 0; v < gp.count; v++) {
        gp.setXYZ(v, gp.getX(v) * (0.6 + rng() * 0.9), gp.getY(v) * (0.5 + rng() * 0.8), gp.getZ(v) * (0.6 + rng() * 0.9));
      }
      const gf = g.toNonIndexed(); gf.computeVertexNormals();
      const rock = new THREE.Mesh(gf, rockMat);
      const s = 1.8 + rng() * 2.8;
      rock.scale.set(s, s * (0.7 + rng() * 0.5), s);
      rock.position.set(cx + (rng() - 0.5) * 6, s * 0.35, cz + (rng() - 0.5) * 6);
      rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      rock.castShadow = rock.receiveShadow = true;
      group.add(rock);
    }
  }

  // --- boundary ring of short pylons ---
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const rad = 96;
    const py = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 3.4 + rng() * 1.5, 6), stoneDark);
    py.position.set(Math.cos(a) * rad, 1.5, Math.sin(a) * rad);
    py.castShadow = true;
    group.add(py);
  }

  // --- training corner (north) ---
  const tc = new THREE.Group();
  tc.position.set(0, 0, -62);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(22, 0.5, 10), wood);
  deck.position.y = 0.25; deck.receiveShadow = true;
  tc.add(deck);
  for (let s = -1; s <= 1; s += 2) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 4.5, 6), wood);
    post.position.set(s * 9, 2.2, -4.6); tc.add(post);
  }
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(17, 3), stoneWarm);
  banner.position.set(0, 3.5, -4.6);
  tc.add(banner);
  group.add(tc);

  outlineGroup(group, { thickness: 0.0035 });
  group.traverse((c) => {
    if (c.isMesh && !c.name.endsWith('__outline')) { c.castShadow = true; c.receiveShadow = true; }
  });
  return { group, meta };
}

export const STRUCTURE_BUILDERS = {
  village: buildVillage,
  bandit_camp: buildBanditCamp,
  ruins: buildRuins,
  arena: buildArena
};
