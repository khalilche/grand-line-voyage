import * as THREE from 'three';
import { toonMaterial, outlineGroup } from '../rendering/toon.js';
import { Targetable } from '../combat/Targetable.js';

/* --------------------------- floating label --------------------------- */
function makeLabel(text, color = '#ffffff') {
  const cv = document.createElement('canvas');
  cv.width = 300; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = '700 32px "Trebuchet MS", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(text, 150, 34);
  ctx.fillStyle = color;
  ctx.fillText(text, 150, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.scale.set(cv.width / 64, 1, 1);
  spr.renderOrder = 10;
  return spr;
}

/* --------------------------- training dummy ---------------------------
 * A papercraft / ball-jointed artist's mannequin: tube limbs, gold ball
 * joints, a can-shaped head & torso segments. Static prop (hp 9999). */
export function makeDummy(scene, pos) {
  const g = new THREE.Group();
  const V = THREE.Vector3;
  const paper = toonMaterial({ color: 0xecedf0, stops: 3, rim: 0xffffff, rimStrength: 0.22 });
  const joint = toonMaterial({ color: 0xc9a24a, stops: 2, rim: 0xffe9a8, rimStrength: 0.32 });
  const dark = toonMaterial({ color: 0xbfc3c9, stops: 3 });

  const bone = (a, b, r, mat = paper) => {
    const dir = b.clone().sub(a); const len = dir.length() || 1e-3;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
    m.position.copy(a).lerp(b, 0.5);
    m.quaternion.setFromUnitVectors(_UP, dir.normalize());
    m.castShadow = true; g.add(m); return m;
  };
  const ball = (at, r, mat = joint) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), mat);
    m.position.copy(at); m.castShadow = true; g.add(m); return m;
  };

  // ---- joint frame (local, feet at y≈0, head top ≈ 1.98) ----
  const pelvis = new V(0, 0.92, 0), chest = new V(0, 1.40, 0.02), neck = new V(0, 1.55, 0.02);
  const shL = new V(0.24, 1.38, 0.02), shR = new V(-0.24, 1.38, 0.02);
  const elL = new V(0.42, 1.08, 0.10), elR = new V(-0.42, 1.08, 0.10);
  const wrL = new V(0.36, 0.82, 0.24), wrR = new V(-0.36, 0.82, 0.24);
  const hipL = new V(0.13, 0.90, 0), hipR = new V(-0.13, 0.90, 0);
  const knL = new V(0.15, 0.48, 0.05), knR = new V(-0.15, 0.50, -0.02);
  const anL = new V(0.15, 0.09, 0), anR = new V(-0.15, 0.10, -0.05);

  // ---- torso: 3 tapered segments + pelvis / chest balls + collar & hip bars ----
  for (let i = 0; i < 3; i++) {
    const a = pelvis.clone().lerp(chest, i / 3), b = pelvis.clone().lerp(chest, (i + 1) / 3);
    bone(a, b, 0.17 - i * 0.02);
  }
  ball(pelvis, 0.15); ball(chest, 0.14);
  bone(hipL, hipR, 0.085);                       // hip bar
  bone(shL, shR, 0.075);                         // collarbone
  // ---- neck + can head ----
  bone(chest, neck, 0.06); ball(neck, 0.07);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.36, 14), paper);
  head.position.set(0, 1.78, 0.02); head.castShadow = true; g.add(head);
  ball(new V(0, 1.98, 0.02), 0.05);             // knob on top

  // ---- arms ----
  for (const [sh, el, wr] of [[shL, elL, wrL], [shR, elR, wrR]]) {
    ball(sh, 0.11);
    bone(sh, el, 0.072); ball(el, 0.095);
    bone(el, wr, 0.06); ball(wr, 0.07);
    bone(wr, wr.clone().add(new V(0, -0.14, 0.05)), 0.055, dark);   // hand stub
  }
  // ---- legs ----
  for (const [hip, kn, an] of [[hipL, knL, anL], [hipR, knR, anR]]) {
    ball(hip, 0.12);
    bone(hip, kn, 0.10); ball(kn, 0.11);
    bone(kn, an, 0.085); ball(an, 0.09);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.36), dark);
    foot.position.copy(an).add(new V(0, -0.05, 0.11)); foot.rotation.x = -0.12;
    foot.castShadow = true; g.add(foot);
  }

  g.position.copy(pos);
  g.scale.setScalar(1.6);                         // big, imposing training mannequin
  g.rotation.y = Math.atan2(-pos.x, -pos.z);     // face the arena centre (where the player fights)
  g._baseRotY = g.rotation.y;
  scene.add(g);
  outlineGroup(g, { thickness: 0.004 });

  // every dummy mesh material (body + ink outline) fades together on death / respawn
  const mats = [];
  g.traverse((o) => { if (o.isMesh && o.material) { o.material.transparent = true; mats.push(o.material); } });

  const t = new Targetable(g, { hp: 9999, radius: 1.6, faction: 'dummy', mass: 3 });
  t.isDummy = true;
  t._wob = new THREE.Vector3();
  t._st = 'idle';                 // idle | dying | dead | respawn
  t._sT = 0;                      // time in state
  t._poise = 260;                 // damage this dummy soaks before it "dies"
  t._breath = Math.random() * 6;
  t._toppleAxis = 0;
  // smoothed pose drivers
  const cur = { rx: 0, rz: 0, y: 0, sy: 1, sxz: 1, op: 1 };

  const baseImpulse = t.takeHit.bind(t);
  t.takeHit = (opts) => {
    baseImpulse({ ...opts, knockback: 0, up: 0, damage: opts.damage, stun: 0 });
    t.hp = 9999;
    if (t._st === 'idle') {
      if (opts.dir) t._wob.addScaledVector(opts.dir, Math.min(0.6, (opts.knockback || 6) * 0.035));
      t._poise -= (opts.damage || 8);
      if (t._poise <= 0) { t._st = 'dying'; t._sT = 0; t._toppleAxis = opts.dir ? Math.atan2(opts.dir.x, opts.dir.z) : Math.random() * 6.28; }
    }
    return true;
  };

  t.update = (dt) => {
    t._sT += dt; t._breath += dt;
    // hit flash (skip while dead)
    t._flash = Math.max(0, t._flash - dt * 5);
    const k = t._st === 'dead' ? 0 : t._flash;
    for (const [mesh, col] of t._origColors) mesh.material.color.copy(col).lerp(_white, k * 0.85);
    t._wob.multiplyScalar(Math.max(0, 1 - 9 * dt));

    // ---- per-state pose targets ----
    let rx = 0, rz = 0, y = 0, sy = 1, sxz = 1, op = 1, lam = 8;
    if (t._st === 'idle') {
      // breathing + slow weight-shift so it looks alive
      const b = Math.sin(t._breath * 1.6), s = Math.sin(t._breath * 0.7);
      sy = 1 + b * 0.02; sxz = 1 - b * 0.012;
      y = b * 0.03;
      rz = s * 0.045; rx = Math.sin(t._breath * 0.9 + 1) * 0.03;
      rx += t._wob.z * -1.4; rz += t._wob.x * 1.4;
      lam = 9;
    } else if (t._st === 'dying') {
      // crumple straight down + topple in the hit direction
      const p = Math.min(1, t._sT / 0.55);
      sy = THREE.MathUtils.lerp(1, 0.22, p * p);
      sxz = THREE.MathUtils.lerp(1, 1.35, p);
      y = -0.5 * p;
      rx = Math.cos(t._toppleAxis) * 1.15 * p;
      rz = Math.sin(t._toppleAxis) * 1.15 * p;
      op = 1 - 0.35 * p;
      lam = 16;
      if (t._sT >= 0.55) { t._st = 'dead'; t._sT = 0; }
    } else if (t._st === 'dead') {
      sy = 0.22; sxz = 1.35; y = -0.5;
      rx = Math.cos(t._toppleAxis) * 1.15; rz = Math.sin(t._toppleAxis) * 1.15;
      op = 0.5 + Math.sin(t._sT * 4) * 0.06;      // faint shimmer while "gone"
      lam = 6;
      if (t._sT >= 1.7) { t._st = 'respawn'; t._sT = 0; t._flash = 1; }
    } else { // respawn — rise with a bounce
      const p = Math.min(1, t._sT / 0.6);
      const eb = 1 - Math.pow(1 - p, 3);
      const bounce = Math.sin(p * Math.PI) * 0.14;
      sy = THREE.MathUtils.lerp(0.22, 1, eb) + bounce;
      sxz = THREE.MathUtils.lerp(1.35, 1, eb) - bounce * 0.6;
      y = THREE.MathUtils.lerp(-0.5, 0, eb);
      rx = Math.cos(t._toppleAxis) * 1.15 * (1 - eb);
      rz = Math.sin(t._toppleAxis) * 1.15 * (1 - eb);
      op = THREE.MathUtils.lerp(0.5, 1, eb);
      lam = 12;
      if (t._sT >= 0.6) { t._st = 'idle'; t._sT = 0; t._poise = 260; t._wob.set(0, 0, 0); }
    }

    // ---- ease everything (movimiento suave) ----
    cur.rx = THREE.MathUtils.damp(cur.rx, rx, lam, dt);
    cur.rz = THREE.MathUtils.damp(cur.rz, rz, lam, dt);
    cur.y = THREE.MathUtils.damp(cur.y, y, lam, dt);
    cur.sy = THREE.MathUtils.damp(cur.sy, sy, lam, dt);
    cur.sxz = THREE.MathUtils.damp(cur.sxz, sxz, lam, dt);
    cur.op = THREE.MathUtils.damp(cur.op, op, lam, dt);

    g.rotation.set(cur.rx, g._baseRotY || 0, cur.rz);
    g.position.y = pos.y + cur.y;
    g.scale.set(1.6 * cur.sxz, 1.6 * cur.sy, 1.6 * cur.sxz);
    for (const m of mats) m.opacity = cur.op;
  };
  return t;
}

/* ------------------------------ bandit ------------------------------- */
/**
 * Bandit — walks toward the player, telegraphs a lunging punch, staggers on hit.
 * hp / damage scale with `level`; carries a floating "Lv N" label.
 */
export function makeBandit(scene, pos, { level = 5, palette } = {}) {
  const g = new THREE.Group();
  const tone = 0.5 + Math.min(0.5, level / 40);       // higher-level bandits read darker/meaner
  const M = {
    skin: toonMaterial({ color: 0xd9a066, stops: 3 }),
    shirt: toonMaterial({ color: palette?.shirt ?? mix(0x5a708c, 0x3a2f3a, tone), stops: 3, rim: 0x9fc7ff, rimStrength: 0.2 }),
    pants: toonMaterial({ color: 0x2b2b33, stops: 3 }),
    scarf: toonMaterial({ color: palette?.scarf ?? 0xb23b32, stops: 2 })
  };
  const torso = new THREE.Group(); torso.position.y = 1.15; g.add(torso);
  add(torso, box(0.7, 0.9, 0.4, M.shirt), 0, 0, 0);
  add(torso, box(0.5, 0.2, 0.42, M.scarf), 0, 0.42, 0);
  const head = add(torso, box(0.42, 0.42, 0.42, M.skin), 0, 0.72, 0);
  add(head, box(0.1, 0.06, 0.02, M.pants), -0.1, 0.02, 0.21);
  add(head, box(0.1, 0.06, 0.02, M.pants), 0.1, 0.02, 0.21);
  const armPivR = new THREE.Group(); armPivR.position.set(0.46, 0.3, 0); torso.add(armPivR);
  add(armPivR, box(0.2, 0.7, 0.2, M.shirt), 0, -0.35, 0);
  const armPivL = new THREE.Group(); armPivL.position.set(-0.46, 0.3, 0); torso.add(armPivL);
  add(armPivL, box(0.2, 0.7, 0.2, M.shirt), 0, -0.35, 0);
  const legR = new THREE.Group(); legR.position.set(0.2, -0.45, 0); torso.add(legR);
  add(legR, box(0.24, 0.8, 0.26, M.pants), 0, -0.4, 0);
  const legL = new THREE.Group(); legL.position.set(-0.2, -0.45, 0); torso.add(legL);
  add(legL, box(0.24, 0.8, 0.26, M.pants), 0, -0.4, 0);

  g.position.copy(pos);
  g.traverse((c) => { if (c.isMesh) c.castShadow = true; });
  outlineGroup(g, { thickness: 0.004 });

  const label = makeLabel(`Bandido  Lv ${level}`, '#ffd9d0');
  label.position.set(0, 2.7, 0);
  g.add(label);
  scene.add(g);

  const hp = Math.round(38 + level * 8);
  const t = new Targetable(g, { hp, radius: 0.8, faction: 'enemy', mass: 1 });
  t.level = level;
  t.isBoss = false;
  t.hitDamage = Math.round(7 + level * 1.4);
  t.rig = { torso, armPivR, armPivL, legR, legL, head };
  t.ai = { state: 'idle', t: 0, walkPhase: Math.random() * 6 };
  t.attackHooks = { onStrike: null };
  t.speed = 3.2 + Math.min(2.2, level * 0.05);
  t.aggroRange = 24;
  t.label = label;

  t.think = _banditThink(t, g, { windup: 0.42, strikeAt: [0.06, 0.14], range: 2.8 });
  return t;
}

/* ------------------------------- boss -------------------------------- */
export function makeBoss(scene, pos, { level = 20, name = 'Jefe', kind = 'bandit_boss' } = {}) {
  const g = new THREE.Group();
  const isGuardian = kind === 'ruins_guardian';
  const M = isGuardian ? {
    skin: toonMaterial({ color: 0x8a8f80, stops: 3, toe: 74 }),
    shirt: toonMaterial({ color: 0x6f8a5a, stops: 3 }),
    pants: toonMaterial({ color: 0x5c6356, stops: 3 }),
    scarf: toonMaterial({ color: 0xd9b24a, stops: 3, rim: 0xfff0b0, rimStrength: 0.4 })
  } : {
    skin: toonMaterial({ color: 0xc98f5c, stops: 3 }),
    shirt: toonMaterial({ color: 0x7a2230, stops: 3, rim: 0xff8a7a, rimStrength: 0.25 }),
    pants: toonMaterial({ color: 0x241f24, stops: 3 }),
    scarf: toonMaterial({ color: 0x2b2b33, stops: 2 })
  };

  const torso = new THREE.Group(); torso.position.y = 1.5; g.add(torso);
  add(torso, box(1.15, 1.35, 0.65, M.shirt), 0, 0, 0);
  add(torso, box(0.8, 0.28, 0.7, M.scarf), 0, 0.68, 0);
  const head = add(torso, box(0.62, 0.6, 0.62, M.skin), 0, 1.05, 0);
  if (isGuardian) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe066 }));
    const eR = eye.clone();
    eye.position.set(-0.16, 0.05, 0.32); eR.position.set(0.16, 0.05, 0.32);
    head.add(eye, eR);
  } else {
    // horned helmet
    for (const s of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 6), M.pants);
      horn.position.set(s * 0.32, 0.42, 0); horn.rotation.z = -s * 0.5;
      head.add(horn);
    }
  }
  const armPivR = new THREE.Group(); armPivR.position.set(0.78, 0.4, 0); torso.add(armPivR);
  add(armPivR, box(0.34, 1.1, 0.34, M.shirt), 0, -0.55, 0);
  add(armPivR, box(0.42, 0.42, 0.42, M.skin), 0, -1.15, 0);          // big fist
  const armPivL = new THREE.Group(); armPivL.position.set(-0.78, 0.4, 0); torso.add(armPivL);
  add(armPivL, box(0.34, 1.1, 0.34, M.shirt), 0, -0.55, 0);
  add(armPivL, box(0.42, 0.42, 0.42, M.skin), 0, -1.15, 0);
  const legR = new THREE.Group(); legR.position.set(0.32, -0.7, 0); torso.add(legR);
  add(legR, box(0.4, 1.2, 0.44, M.pants), 0, -0.6, 0);
  const legL = new THREE.Group(); legL.position.set(-0.32, -0.7, 0); torso.add(legL);
  add(legL, box(0.4, 1.2, 0.44, M.pants), 0, -0.6, 0);

  g.position.copy(pos);
  g.traverse((c) => { if (c.isMesh) c.castShadow = true; });
  outlineGroup(g, { thickness: 0.0035 });

  const label = makeLabel(`${name}  ·  Lv ${level}`, '#ffdf8a');
  label.position.set(0, 4.0, 0);
  label.scale.set(6.4, 1.1, 1);
  g.add(label);
  scene.add(g);

  const hp = Math.round(260 + level * 34);
  const t = new Targetable(g, { hp, radius: 1.35, faction: 'enemy', mass: 4 });
  t.level = level;
  t.isBoss = true;
  t.bossName = name;
  t.hitDamage = Math.round(18 + level * 2.2);
  t.rig = { torso, armPivR, armPivL, legR, legL, head };
  t.ai = { state: 'idle', t: 0, walkPhase: Math.random() * 6 };
  t.attackHooks = { onStrike: null };
  t.speed = 2.6 + Math.min(2.0, level * 0.02);
  t.aggroRange = 30;
  t.label = label;

  t.think = _banditThink(t, g, { windup: 0.75, strikeAt: [0.05, 0.2], range: 4.6, heavy: true });
  return t;
}

/* --------------------- shared chase/telegraph AI --------------------- */
function _banditThink(t, g, cfg) {
  const { windup, strikeAt, range, heavy } = cfg;
  return (dt, playerPos, world) => {
    if (t.dead) {
      g.rotation.x = THREE.MathUtils.damp(g.rotation.x, Math.PI / 2, 4, dt);
      if (t.label) t.label.visible = false;
      return;
    }
    const a = t.ai;
    a.t += dt;
    const toP = _v.copy(playerPos).sub(g.position); toP.y = 0;
    const dist = toP.length();
    toP.normalize();
    const wantYaw = Math.atan2(toP.x, toP.z);
    if (t.stunned && a.state !== 'stagger') { a.state = 'stagger'; a.t = 0; }

    switch (a.state) {
      case 'idle':
        if (dist < (t.aggroRange || 22)) a.state = 'chase';
        break;
      case 'chase': {
        g.rotation.y = dampAngle(g.rotation.y, wantYaw, 8, dt);
        if (dist > range * 0.8) {
          g.position.addScaledVector(toP, t.speed * dt);
          a.walkPhase += dt * (heavy ? 6 : 9);
          const sw = Math.sin(a.walkPhase);
          t.rig.legR.rotation.x = sw * 0.8; t.rig.legL.rotation.x = -sw * 0.8;
          t.rig.armPivR.rotation.x = -sw * 0.5; t.rig.armPivL.rotation.x = sw * 0.5;
        } else { a.state = 'windup'; a.t = 0; a.windupDur = windup; }   // windupDur exposed so Kenbunshoku's telegraph (Haki.js) can read remaining time generically
        break;
      }
      case 'windup':
        g.rotation.y = dampAngle(g.rotation.y, wantYaw, 10, dt);
        t.rig.armPivR.rotation.x = THREE.MathUtils.damp(t.rig.armPivR.rotation.x, heavy ? 2.4 : 1.6, 12, dt);
        t.rig.torso.rotation.x = -0.25;
        if (a.t > windup) { a.state = 'strike'; a.t = 0; a._hit = false; }
        break;
      case 'strike':
        t.rig.armPivR.rotation.x = THREE.MathUtils.damp(t.rig.armPivR.rotation.x, -2.0, 28, dt);
        t.rig.torso.rotation.x = 0.3;
        if (!a._hit && a.t > strikeAt[0] && a.t < strikeAt[1] && t.attackHooks.onStrike) {
          if (playerPos.distanceTo(g.position) < range + (heavy ? 1.5 : 0.6)) {
            const nd = _v2.copy(playerPos).sub(g.position); nd.y = 0; nd.normalize();
            t.attackHooks.onStrike(t.hitDamage, nd, heavy);
            a._hit = true;
          }
        }
        if (a.t > 0.34) { a.state = 'recover'; a.t = 0; }
        break;
      case 'recover':
        t.rig.armPivR.rotation.x = THREE.MathUtils.damp(t.rig.armPivR.rotation.x, 0, 8, dt);
        t.rig.torso.rotation.x = THREE.MathUtils.damp(t.rig.torso.rotation.x, 0, 8, dt);
        if (a.t > (heavy ? 0.8 : 0.5)) a.state = 'chase';
        break;
      case 'stagger':
        t.rig.torso.rotation.x = -0.4;
        t.rig.armPivR.rotation.x = 0.4; t.rig.armPivL.rotation.x = 0.4;
        if (!t.stunned && a.t > 0.2) { a.state = 'chase'; a.t = 0; }
        break;
    }

    const gr = world.sampleGround(g.position.x, g.position.z);
    g.position.y = THREE.MathUtils.damp(g.position.y, Math.max(gr.height, 0), 12, dt);
  };
}

function box(w, h, d, m) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); }
function add(parent, mesh, x, y, z) { mesh.position.set(x, y, z); parent.add(mesh); return mesh; }
function dampAngle(cur, tgt, l, dt) {
  let d = ((tgt - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return cur + d * (1 - Math.exp(-l * dt));
}
function mix(a, b, t) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return ca.lerp(cb, t).getHex();
}
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _white = new THREE.Color(0xffffff);
const _UP = new THREE.Vector3(0, 1, 0);
