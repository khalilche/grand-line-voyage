import * as THREE from 'three';

/**
 * Devil Fruit system with rarity tiers, fruit types (Paramecia / Logia / Zoan),
 * per-fruit passives, and — for Epic/Legendary — an Ultimate (T). Zoan fruits
 * carry a transformation toggle that buffs the player and unlocks their Ult.
 *
 * ctx = { origin, aimDir, forwardFlat, combat, vfx, camera, controller, scene,
 *         world, elapsed }
 */

export const RARITY = {
  comun:      { label: 'Común',       color: 0xaeb7c2 },
  poco_comun: { label: 'Poco común',  color: 0x63c76b },
  raro:       { label: 'Raro',        color: 0x4f9dff },
  epico:      { label: 'Épico',       color: 0xb15cff },
  legendario: { label: 'Legendario',  color: 0xffb43c },
  mitica:     { label: 'Mítica',      color: 0xff5ea8 }
};

export class DevilFruit {
  constructor(name, color, { rarity = 'raro', type = 'paramecia', passive = '' } = {}) {
    this.name = name;
    this.color = color;
    this.rarity = rarity;
    this.type = type;                 // 'paramecia' | 'logia' | 'zoan'
    this.passive = passive;
    // q=Z (builder) · e=X (signature) · f=C (mobility / Zoan toggle) · v=V (2nd tool) · ult=T
    this.slots = { q: null, e: null, f: null, v: null, ult: null };
    this._timers = [];

    this.transformed = false;
    this.transformDmg = 1.45;
    this.transformSpeed = 1.22;
    this.transformRegen = 0;          // hp / sec while transformed
    this._aura = null;

    this.jumpMul = 1;                 // passive jump-height multiplier
    this.momentum = 0;               // kinetic charge for momentum-based fruits
    this.momentumMax = 6;
    this.momentumDecay = 1.2;        // per second
  }
  addMomentum(n = 1) { this.momentum = Math.min(this.momentumMax, this.momentum + n); }

  hasUlt() { return !!this.slots.ult; }
  isZoan() { return this.type === 'zoan'; }
  isLogia() { return this.type === 'logia'; }
  rarityInfo() { return RARITY[this.rarity]; }

  schedule(delay, fn) { this._timers.push({ t: delay, fn }); }

  use(key, ctx, arg) {
    const s = this.slots[key];
    if (!s) return false;
    if (s.transform) { this.toggleForm(ctx); return true; }
    if (s._t > 0) return false;
    s._t = s.cd;
    try { s.cast(ctx, this, arg); } catch (e) { console.error('[fruit cast]', this.name, key, e); }
    return true;
  }

  cooldown01(key) {
    const s = this.slots[key];
    return s && !s.transform ? THREE.MathUtils.clamp(s._t / s.cd, 0, 1) : 0;
  }

  toggleForm(ctx) {
    this.transformed = !this.transformed;
    const p = ctx.controller.chest.clone();
    ctx.vfx.dome(p, { radius: 4.5, life: 0.5, color: this.color });
    ctx.vfx.burst(p, { count: 28, color: this.color, color2: 0xffffff, speed: 10, size: 0.3, life: 0.7, gravity: -3, drag: 2.4 });
    ctx.camera.addShake(0.25);
    if (this.transformed) {
      ctx.combat.playerIFrames = Math.max(ctx.combat.playerIFrames, 0.6);
      if (!this.noAura) {
        this._aura = ctx.vfx.aura(() => ctx.controller.chest, {
          color: this.color, radius: 1.4, while_: () => this.transformed
        });
      }
    }
    this.onForm && this.onForm(ctx, this.transformed);
  }

  forceRevert(ctx) {
    if (!this.transformed) return;
    this.transformed = false;
    this.onForm && this.onForm(ctx, false);
  }

  /** optional per-fruit flavour on a basic (LMB) strike. combo = 1..3 */
  onMelee(_ctx, _combo, _dir) {}

  update(dt) {
    if (this.momentum > 0) this.momentum = Math.max(0, this.momentum - dt * this.momentumDecay);
    for (const k of ['q', 'e', 'f', 'v', 'ult']) {
      const s = this.slots[k];
      if (s && !s.transform && s._t > 0) s._t = Math.max(0, s._t - dt);
    }
    for (let i = this._timers.length - 1; i >= 0; i--) {
      const tm = this._timers[i];
      tm.t -= dt;
      if (tm.t <= 0) { try { tm.fn(); } catch (e) { console.error('[fruit timer]', e); } this._timers.splice(i, 1); }
    }
  }
}

/* ============================ helpers ============================ */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function gY(c, x, z) { const g = c.world.sampleGround(x, z); return g.onLand ? g.height : c.world.waterHeight(x, z); }
function ahead(c, dist) {
  const p = c.controller.position.clone().addScaledVector(c.forwardFlat, dist);
  p.y = gY(c, p.x, p.z);
  return p;
}
/* Long-range / precision targeting: the ground point under wherever you're
   actually aiming (c.aimPoint — free cursor or the crosshair), clamped to
   [min, max] metres from the player so a cast can't undershoot a point-blank
   click or reach past its own max range. Use this instead of `ahead(c, N)`
   for any ability meant to travel to an exact spot on the map rather than a
   fixed short distance in front of you. */
function aimedGround(c, max, min = 0) {
  const o = c.controller.position;
  const to = c.aimPoint ? _v2.set(c.aimPoint.x - o.x, 0, c.aimPoint.z - o.z) : _v2.set(c.forwardFlat.x, 0, c.forwardFlat.z);
  let dist = to.length();
  if (dist < 1e-4) { to.copy(c.forwardFlat); dist = 1; }
  dist = THREE.MathUtils.clamp(dist, min, max);
  const p = o.clone().addScaledVector(to.normalize(), dist);
  p.y = gY(c, p.x, p.z);
  return p;
}
function flash(c, a, col) { c.combat.hooks?.onFlash?.(a, col); }
function slow(c, s, scale) { c.combat.hooks?.onSlowmo?.(s, scale); }
function smoke(c, pos, n = 10) {
  c.vfx.burst(pos, { count: n, color: 0x3a3a3a, color2: 0x707070, speed: 2.4, size: 0.95, life: 1.6, gravity: -1.2, drag: 1.4, dir: _up, cone: 1.4, tile: 2 });
}
const _gray = new THREE.Color(0x8a8378);

/* ================================================================ *
 *  COMÚN — Bara Bara (Trocea). Paramecia.
 * ================================================================ */
export class BaraBara extends DevilFruit {
  constructor() {
    super('Bara Bara', 0x8f7bd8, { rarity: 'comun', type: 'paramecia', passive: 'El cuerpo se separa: inmune a cortes y caídas · los golpes provocan Hemorragia' });
    this.meleeRange = 4.6;                 // fists stretch out on a basic punch

    const KNIFE = 0xff2e3e, CHOP = 0x8f7bd8, GLOW = 0xdcd4ff;

    // === Z — BARA BARA CAÑÓN: builder. Detached fist fired down the aim as a
    // rocket punch on a stretching arm. Fast, spammable, applies Hemorragia. ===
    this.slots.q = {
      name: 'Bara Bara Cañón', cd: 2.0, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const d = c.aimDir.clone().normalize();
        const start = c.controller.chest.clone().addScaledVector(d, 0.6);
        c.character.setHand(1, false);
        c.vfx.stretch(() => c.controller.chest.clone().addScaledVector(d, 0.4), d, { length: 6.5, radius: 0.34, color: 0xf3c9a6, life: 0.36 });
        c.vfx.flipbook(start.clone(), { kind: 'muzzle', size: 3.6, life: 0.2, color: 0xc9b8ff });
        c.vfx.burst(start, { count: 16, color: CHOP, color2: KNIFE, tile: 3, speed: 10, size: 0.3, life: 0.26, gravity: 0, drag: 4, dir: d, cone: 0.5 });
        c.camera.addShake(0.12);
        const fist = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.95, 0.95), c.character.materials.skin);
        c.combat.spawnProjectile({
          pos: start, vel: d.clone().multiplyScalar(54), gravity: 0, drag: 0,
          radius: 1.05, life: 0.7, damage: 18, knockback: 24, up: 6,
          color: CHOP, trailColor: GLOW, mesh: fist,
          onImpact: (p) => {
            c.vfx.flipbook(p.clone(), { kind: 'impact', size: 10, life: 0.44, color: 0xd6c8ff });
            c.vfx.burst(p, { count: 30, color: KNIFE, color2: CHOP, tile: 3, speed: 14, size: 0.32, life: 0.45, gravity: 6, drag: 2.4 });
            c.vfx.ring(p, { color: GLOW, radius: 4.2, life: 0.26, vertical: true });
            c.combat.areaStrike(p, { radius: 4, damage: 12, knockback: 16, up: 6, stun: 0.28, color: GLOW, silent: true, onHitTarget: (t) => c.combat.applyStatus(t, 'sever', { duration: 5 }) });
            c.combat.hitstop(0.04); c.camera.addShake(0.16);
          }
        });
        this.schedule(0.4, () => c.character.setHand(1, true));
      }
    };

    // === X — FESTIVAL BARA BARA: signature. YOU come apart into a roaming
    // blade-storm for 3.6 s — shreds + drags in everything around you, then
    // reassembles with an outward burst. ===
    this.slots.e = {
      name: 'Festival Bara Bara', cd: 9, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const DUR = 3.6;
        c.character.root.visible = false;
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.4);
        c.vfx.split(() => c.controller.chest, c.character.materials, { mode: 'orbit', duration: DUR, radius: 4.2, blades: 12 });
        c.vfx.ring(c.controller.chest, { color: GLOW, radius: 5, life: 0.4 });
        c.vfx.flipbook(c.controller.chest.clone(), { kind: 'shock', size: 9, life: 0.4, color: GLOW });
        c.camera.addShake(0.18);
        let el = 0;
        const tick = () => {
          el += 0.24;
          const cc2 = c.controller.chest;
          for (const t of c.combat.enemiesInRadius(cc2, 4.4)) {
            const pull = cc2.clone().sub(t.center).setY(0).normalize();
            t.takeHit({ damage: 7, dir: pull, knockback: 6, up: 1, stun: 0.06 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 7);
            c.combat.applyStatus(t, 'sever', { duration: 4 });
          }
          const gp = c.controller.position.clone(); gp.y = gY(c, gp.x, gp.z);
          c.vfx.decal(gp, { kind: 'scorch', radius: 2.4, life: 1.4, groundY: gp.y });
          c.vfx.burst(cc2.clone().add(_v.set((Math.random() - 0.5) * 8, Math.random() * 2.4 - 0.4, (Math.random() - 0.5) * 8)),
            { count: 4, color: KNIFE, color2: GLOW, tile: 3, speed: 13, size: 0.24, life: 0.3, gravity: 2, drag: 2 });
          if (el < DUR) this.schedule(0.24, tick);
          else {
            c.character.root.visible = true;
            c.vfx.flipbook(cc2.clone(), { kind: 'impact', size: 11, life: 0.42, color: GLOW });
            c.combat.areaStrike(cc2, { radius: 5.5, damage: 26, knockback: 26, up: 7, stun: 0.4, color: GLOW, shake: 0.4, onHitTarget: (t) => c.combat.applyStatus(t, 'sever', { stacks: 2, duration: 5 }) });
            c.vfx.burst(cc2, { count: 46, color: KNIFE, color2: CHOP, tile: 3, speed: 17, size: 0.3, life: 0.6, gravity: 5, drag: 1.6 });
            c.combat.hitstop(0.05);
          }
        };
        this.schedule(0.24, tick);
      }
    };

    // === C — BARA BARA CAR: mobility. Legs spin into a wheel and you barrel
    // forward, running over anyone in the lane (knockdown + Hemorragia). ===
    this.slots.f = {
      name: 'Bara Bara Car', cd: 4, _t: 0,
      cast: (c) => {
        const d = c.aimDir.clone(); d.y = 0; d.normalize();
        c.controller.velocity.copy(d).multiplyScalar(46); c.controller.velocity.y = 2.2;
        c.controller._dashTime = 0.42; c.controller._dashDir.copy(d);
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.5);
        c.pose('thrust');
        c.vfx.flipbook(c.controller.chest.clone(), { kind: 'shock', size: 6, life: 0.3, color: GLOW });
        const seen = new Set();
        for (let i = 0; i < 9; i++) this.schedule(i * 0.05, () => {
          const p = c.controller.position.clone(); p.y = gY(c, p.x, p.z);
          for (let k = 0; k < 5; k++) {
            const a = i * 0.7 + k * 1.256;
            c.vfx.burst(p.clone().add(_v.set(Math.cos(a) * 1.1, 0.5 + Math.sin(a * 2) * 0.4, Math.sin(a) * 1.1)),
              { count: 2, color: KNIFE, color2: GLOW, tile: 3, speed: 6, size: 0.22, life: 0.24, gravity: 3, drag: 3 });
          }
          c.vfx.decal(p.clone(), { kind: 'scorch', radius: 1.3, life: 2, groundY: p.y });
          for (const t of c.combat.enemiesInRadius(c.controller.chest, 2.4)) {
            if (seen.has(t)) continue; seen.add(t);
            t.takeHit({ damage: 16, dir: d.clone().setY(0.15).normalize(), knockback: 22, up: 6, stun: 0.45 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 16);
            c.combat.applyStatus(t, 'sever', { stacks: 2, duration: 5 });
            c.vfx.flipbook(t.center.clone(), { kind: 'impact', size: 6, life: 0.34, color: 0xd6c8ff });
            c.combat.hitstop(0.03);
          }
        });
      }
    };

    // === V — SEPARACIÓN: 2nd tool. Split apart in place (full i-frames ~1 s,
    // attacks pass through) then snap back with an outward nova of knives. ===
    this.slots.v = {
      name: 'Separación', cd: 6, _t: 0,
      cast: (c) => {
        const DUR = 1.0;
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, DUR + 0.1);
        c.character.root.visible = false;
        c.vfx.split(() => c.controller.chest, c.character.materials, { mode: 'scatter', duration: DUR, radius: 2.4 });
        c.vfx.flipbook(c.controller.chest.clone(), { kind: 'magic', size: 6, life: 0.5, color: 0xb9a6ff });
        c.vfx.burst(c.controller.chest, { count: 24, color: CHOP, color2: GLOW, tile: 5, speed: 8, size: 0.3, life: 0.5, gravity: 1.5, drag: 3 });
        this.schedule(DUR - 0.02, () => {
          c.character.root.visible = true;
          c.vfx.flipbook(c.controller.chest.clone(), { kind: 'shock', size: 10, life: 0.4, color: GLOW });
          c.vfx.ring(c.controller.chest, { color: KNIFE, radius: 4, life: 0.3, vertical: true });
          c.vfx.burst(c.controller.chest, { count: 40, color: KNIFE, color2: CHOP, tile: 3, speed: 18, size: 0.3, life: 0.55, gravity: 5, drag: 1.6 });
          c.combat.areaStrike(c.controller.chest, { radius: 5.5, damage: 26, knockback: 24, up: 8, stun: 0.4, color: GLOW, shake: 0.4, onHitTarget: (t) => c.combat.applyStatus(t, 'sever', { stacks: 2, duration: 5 }) });
          c.combat.hitstop(0.05);
        });
      }
    };

    // === T — BARA BARA EMPEROR: a colossal fist crashes down on a fixed zone;
    // a rolling knife-shockwave sweeps the whole radius, then a bleed field. ===
    this.slots.ult = {
      name: 'Bara Bara Emperor', cd: 24, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = ahead(c, 8);
        const R = 18;
        for (let i = 0; i < 3; i++) this.schedule(i * 0.14, () => c.vfx.ring(gp, { color: CHOP, radius: R * (0.4 + i * 0.3), life: 0.5, thickness: 0.5 }));
        c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(2)), { kind: 'energyball', size: 10, life: 0.6, color: 0xb9a6ff, rise: 3 });
        const from = gp.clone().add(_v.set(3, 44, 3));
        c.vfx.giantArm(from, gp.clone(), {
          color: 0xe7dcc4, scale: 3.2, life: 0.9,
          onHit: () => {
            flash(c, 0.9, 0xffffff); slow(c, 0.4, 0.3); c.combat.hitstop(0.16); c.camera.addShake(2.0);
            c.vfx.flipbook(gp.clone().add(_up), { kind: 'impact', size: 34, life: 0.6, color: 0xffffff });
            c.vfx.dome(gp, { radius: R + 3, life: 0.9, color: GLOW });
            c.vfx.decal(gp.clone(), { kind: 'scorch', radius: R, life: 8, groundY: gp.y });
            c.vfx.crack(gp.clone(), { radius: R * 0.9, count: 16, life: 3, color: GLOW });
            const seen = new Set();
            for (let w = 0; w < 8; w++) this.schedule(0.03 + w * 0.06, () => {
              const rNow = (w + 1) / 8 * R;
              c.vfx.ring(gp, { color: w % 2 ? KNIFE : GLOW, radius: rNow, life: 0.4, thickness: 0.5 });
              c.vfx.burst(gp.clone().add(_v.set((Math.random() - 0.5) * rNow * 1.6, 0.6, (Math.random() - 0.5) * rNow * 1.6)),
                { count: 8, color: KNIFE, color2: GLOW, tile: 3, speed: 16, size: 0.32, life: 0.5, gravity: 6, drag: 1.6 });
              for (const t of c.combat.enemiesInRadius(gp, rNow)) {
                if (seen.has(t)) continue; seen.add(t);
                const k = 1 - t.center.distanceTo(gp) / R * 0.6;
                t.takeHit({ damage: 120 * k, dir: t.center.clone().sub(gp).setY(0.2).normalize(), knockback: 34, up: 14, stun: 0.9 });
                c.combat.hooks?.onDamageNumber?.(t.center.clone(), Math.round(120 * k));
                c.combat.applyStatus(t, 'sever', { stacks: 3, duration: 6, maxStacks: 3 });
              }
            });
            for (let i = 0; i < 10; i++) this.schedule(0.1 + i * 0.06, () => {
              const a = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * R;
              const p = gp.clone().add(_v.set(Math.cos(a) * rr, 0, Math.sin(a) * rr)); p.y = gY(c, p.x, p.z);
              c.vfx.flipbook(p.clone().add(_up.clone().multiplyScalar(3)), { kind: 'impact', size: 5, life: 0.3, color: 0xd6c8ff });
              c.vfx.burst(p, { count: 10, color: KNIFE, color2: GLOW, tile: 3, speed: 8, size: 0.3, life: 0.5, gravity: 8, drag: 2, dir: _up, cone: 0.6 });
              c.combat.areaStrike(p, { radius: 3, damage: 22, knockback: 10, up: 6, stun: 0.3, color: KNIFE, silent: true, onHitTarget: (t) => c.combat.applyStatus(t, 'sever', { stacks: 2, duration: 6 }) });
            });
            c.vfx.hazard(gp.clone(), {
              kind: 'fire', radius: R * 0.8, duration: 5, groundY: gp.y,
              onTick: (ctr, r) => { for (const t of c.combat.enemiesInRadius(ctr, r)) { t.takeHit({ damage: 5, dir: null, knockback: 0, up: 0, stun: 0 }); c.combat.applyStatus(t, 'sever', { duration: 4, stacks: 2 }); } },
              onEmit: (ep) => c.vfx.burst(ep, { count: 2, color: KNIFE, color2: 0x9c0d18, tile: 3, speed: 3, size: 0.3, life: 0.7, gravity: 5, drag: 2, dir: _up, cone: 0.5 })
            });
          }
        });
      }
    };
  }

  // basic punch: the striking hand shoots out and snaps back (alternating), bleeds
  onMelee(c, combo, _dir) {
    const side = combo % 2;                       // 0 = left, 1 = right
    const reach = combo === 3 ? 4.8 : 3.2;
    const target = c.controller.chest.clone().addScaledVector(c.forwardFlat, reach);
    c.character.setHand(side, false);
    c.vfx.flyingHands(() => c.character.getHandPositions(), target, c.character.materials.skin, {
      homeIdx: [side], out: 0.09, back: 0.12, arc: 0.35,
      onHit: (p) => {
        c.vfx.burst(p, { count: combo === 3 ? 14 : 7, color: 0xff2e3e, color2: 0x8f7bd8, tile: 3, speed: 8, size: 0.2, life: 0.22, gravity: 2, drag: 4 });
        if (combo === 3) c.vfx.flipbook(p.clone(), { kind: 'impact', size: 5, life: 0.32, color: 0xd6c8ff });
        for (const t of c.combat.enemiesInRadius(p, 2.2)) c.combat.applyStatus(t, 'sever', { duration: 3.5 });
      },
      onReturn: () => c.character.setHand(side, true)
    });
  }
}

/* ================================================================ *
 *  POCO COMÚN — Bane Bane (Muelle). Paramecia.
 * ================================================================ */
export class BaneBane extends DevilFruit {
  constructor() {
    super('Bane Bane', 0x63c76b, { rarity: 'poco_comun', type: 'paramecia', passive: 'Piernas de resorte: saltos enormes · caída sin daño · el impulso carga los golpes · los golpes aplican Comprimido' });
    this.jumpMul = 1.55;              // springy legs — always jumps higher
    this.momentumDecay = 1.0;

    const SPR = 0x8fe08f, PALE = 0xbfffbf, LIME = 0xcfffcf;
    const feet = (c) => _v.set(c.controller.position.x, gY(c, c.controller.position.x, c.controller.position.z), c.controller.position.z).clone();
    const coil = (c, t, stacks = 1, duration = 4) => c.combat.applyStatus(t, 'coil', { stacks, duration });
    const bounceFx = (c, gp, big) => {
      c.vfx.spring(() => c.controller.position, _up, { color: SPR, life: 0.2, length: big ? 2.4 : 1.6 });
      c.vfx.dome(gp, { radius: (big ? 5 : 3.4) + this.momentum * 0.5, life: big ? 0.4 : 0.28, color: PALE });
      c.vfx.ring(gp, { color: PALE, radius: (big ? 4 : 2.6) + this.momentum * 0.6, life: 0.25 });
      c.vfx.flipbook(gp.clone(), { kind: big ? 'impact' : 'shock', size: (big ? 12 : 6) + this.momentum, life: 0.4, color: LIME });
      c.vfx.burst(gp, { count: big ? 24 : 12, color: PALE, color2: SPR, tile: big ? 3 : 2, speed: 8, size: 0.28, life: 0.4, gravity: 6, drag: 2, dir: _up, cone: 1.4 });
    };

    // === Z — PELOTA REBOTE: builder. A fast spring-ball — it fires quick,
    // hops once off the ground and EXPLODES. Low cooldown, spammable. ===
    this.slots.q = {
      name: 'Pelota Rebote', cd: 1.2, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const dir = c.aimDir.clone().normalize();
        const pos = c.controller.chest.clone().addScaledVector(dir, 0.7);
        const vel = dir.clone().multiplyScalar(46); vel.y += 5;
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 12), new THREE.MeshBasicMaterial({ color: PALE }));
        mesh.position.copy(pos); c.scene.add(mesh);
        c.vfx.spring(() => c.controller.chest, dir, { color: SPR, life: 0.14, length: 1.2 });
        c.vfx.flipbook(pos.clone(), { kind: 'muzzle', size: 2.6, life: 0.12, color: PALE });
        c.camera.addShake(0.08);
        let hopped = false, boomed = false, alive = 2.0;
        const boom = () => {
          if (boomed) return; boomed = true;
          c.vfx.flipbook(pos.clone().add(_up), { kind: 'impact', size: 11, life: 0.42, color: LIME });
          c.vfx.dome(pos.clone(), { radius: 5, life: 0.4, color: PALE });
          c.vfx.ring(pos.clone(), { color: PALE, radius: 4.5, life: 0.28 });
          c.vfx.crack(pos.clone(), { radius: 5, count: 7, life: 1.0, ground: true, color: 0xdfffdf });
          c.vfx.burst(pos.clone(), { count: 30, color: PALE, color2: SPR, tile: 4, speed: 15, size: 0.32, life: 0.5, gravity: 5, drag: 1.6, dir: _up, cone: 2.2 });
          c.combat.areaStrike(pos.clone(), { radius: 4.5, damage: 30 + this.momentum * 2, knockback: 26, up: 14, stun: 0.4, color: SPR, shake: 0.35, onHitTarget: (t) => coil(c, t, 2, 4) });
          c.combat.hitstop(0.04); this.addMomentum(1);
          c.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose();
        };
        const step = () => {
          const dt = 0.03; alive -= dt;
          vel.y -= 40 * dt;
          pos.addScaledVector(vel, dt);
          const gy = gY(c, pos.x, pos.z);
          if (pos.y <= gy + 0.35) {
            pos.y = gy + 0.35;
            if (!hopped) {
              hopped = true;
              vel.y = 9; vel.x *= 0.6; vel.z *= 0.6;
              c.vfx.ring(pos.clone(), { color: LIME, radius: 2, life: 0.2 });
              c.vfx.burst(pos.clone(), { count: 8, color: PALE, tile: 4, speed: 6, size: 0.22, life: 0.25, gravity: -2, drag: 2, dir: _up, cone: 1.2 });
              this.schedule(0.22, boom);
            } else { boom(); return; }
          }
          mesh.position.copy(pos);
          if (boomed) return;
          if (alive <= 0) { boom(); return; }
          this.schedule(dt, step);
        };
        this.schedule(0.03, step);
      }
    };

    // === X — CAMPO DE MUELLES: signature. Plant a spring-trap field ahead;
    // anyone who steps in is snared by CHAINS that whip out of the ground —
    // rooted in place, bled + Comprimido for as long as they stay. 5 s. ===
    this.slots.e = {
      name: 'Campo de Muelles', cd: 8.5, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = ahead(c, 6);
        const R = 5.5, DUR = 5.0;
        c.vfx.decal(gp.clone(), { kind: 'scorch', radius: R, life: DUR + 1, groundY: gp.y });
        c.vfx.ring(gp, { color: PALE, radius: R, life: 0.4 });
        c.vfx.flipbook(gp.clone().add(_up), { kind: 'shock', size: 8, life: 0.4, color: PALE });
        c.camera.addShake(0.14);
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * 6.283, rr = R * (0.3 + Math.random() * 0.6);
          const sp = gp.clone().add(_v.set(Math.cos(a) * rr, 0, Math.sin(a) * rr));
          c.vfx.spring(() => sp.clone(), _up, { color: SPR, life: DUR, length: 1.2 });
        }
        const chainAt = new Map();          // target -> elapsed when last chained
        let el = 0;
        const tick = () => {
          el += 0.35;
          const inside = c.combat.enemiesInRadius(gp, R);
          const insideSet = new Set(inside);
          for (const t of inside) {
            const last = chainAt.get(t);
            if (last === undefined || el - last > 2.0) {
              c.vfx.chains(() => t.center.clone(), { hold: 2.2, count: 4, color: 0x565c68 });
              c.vfx.flipbook(t.center.clone(), { kind: 'shock', size: 6, life: 0.3, color: LIME });
              c.combat.hitstop(0.03);
              chainAt.set(t, el);
            }
            t._stun = Math.max(t._stun || 0, 0.7);      // rooted while chained
            t.velocity?.set?.(0, 0, 0);
            t.takeHit({ damage: 7, dir: null, knockback: 0, up: 0, stun: 0.5 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 7);
            coil(c, t, 1, 3.5);
          }
          for (const t of [...chainAt.keys()]) if (!insideSet.has(t)) chainAt.delete(t);
          c.vfx.burst(gp.clone().add(_v.set((Math.random() - 0.5) * R * 1.6, 0.2, (Math.random() - 0.5) * R * 1.6)),
            { count: 4, color: PALE, color2: SPR, tile: 4, speed: 6, size: 0.24, life: 0.4, gravity: -3, drag: 2, dir: _up, cone: 1.0 });
          if (el < DUR) this.schedule(0.35, tick);
        };
        this.schedule(0.35, tick);
      }
    };

    // === C — SALTO DE RESORTE: mobility. Coil and spring toward the cursor
    // (works mid-air for a double-bounce); land with a shock ring. ===
    this.slots.f = {
      name: 'Salto de Resorte', cd: 3.5, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const d = c.aimDir.clone(); d.y = 0; d.normalize();
        c.vfx.spring(() => c.controller.position, _up, { color: SPR, life: 0.2, length: 2.0 });
        c.controller.velocity.set(d.x * 30, 15, d.z * 30);
        c.controller._dashTime = 0.2; c.controller._dashDir.copy(d);
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.3);
        c.vfx.flipbook(c.controller.position.clone(), { kind: 'shock', size: 6, life: 0.3, color: PALE });
        c.camera.addShake(0.1);
        let el = 0, landed = false;
        const watch = () => {
          el += 0.07;
          if (!landed && el > 0.28 && c.controller.grounded) {
            landed = true;
            const fp = feet(c);
            bounceFx(c, fp, false);
            c.combat.areaStrike(fp, { radius: 4, damage: 18 + this.momentum * 2, knockback: 20, up: 10, stun: 0.35, color: SPR, shake: 0.25, onHitTarget: (t) => coil(c, t, 1, 3.5) });
            c.combat.hitstop(0.03);
            return;
          }
          if (el < 1.6 && !landed) this.schedule(0.07, watch);
        };
        this.schedule(0.07, watch);
      }
    };

    // === V — RETROCESO: 2nd tool. Kick off a spring and rocket BACKWARD to
    // reposition, leaving a launch-trap where you stood. ===
    this.slots.v = {
      name: 'Retroceso', cd: 6, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const d = c.forwardFlat.clone();
        const trapPos = feet(c);
        c.controller.velocity.set(-d.x * 38, 12, -d.z * 38);
        c.controller._dashTime = 0.22; c.controller._dashDir.copy(d.clone().negate());
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.5);
        c.vfx.spring(() => c.controller.chest, d.clone().negate(), { color: SPR, life: 0.24, length: 2.4 });
        c.vfx.flipbook(c.controller.chest.clone(), { kind: 'shock', size: 7, life: 0.3, color: PALE });
        c.vfx.burst(c.controller.chest, { count: 16, color: PALE, color2: SPR, tile: 4, speed: 9, size: 0.28, life: 0.4, gravity: 2, drag: 3, dir: d, cone: 0.9 });
        c.camera.addShake(0.16);
        c.vfx.spring(() => trapPos.clone(), _up, { color: LIME, life: 2.6, length: 1.6 });
        c.vfx.decal(trapPos.clone(), { kind: 'scorch', radius: 2.6, life: 3, groundY: trapPos.y });
        const seen = new Set();
        let el = 0;
        const tick = () => {
          el += 0.25;
          for (const t of c.combat.enemiesInRadius(trapPos, 3)) {
            if (seen.has(t)) continue; seen.add(t);
            t.takeHit({ damage: 16, dir: _up.clone(), knockback: 4, up: 24, stun: 0.6 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 16);
            coil(c, t, 2, 4);
            c.vfx.flipbook(t.center.clone(), { kind: 'impact', size: 6, life: 0.34, color: LIME });
            c.vfx.spring(() => trapPos.clone(), _up, { color: LIME, life: 0.3, length: 2.4 });
            c.combat.hitstop(0.03);
          }
          if (el < 2.5) this.schedule(0.25, tick);
        };
        this.schedule(0.25, tick);
      }
    };

    // === T — BALA DE DEMOLICIÓN: compress into a giant spring-loaded ball and
    // rampage for 5 s — steer with the cursor, every landing is a quake AoE
    // that launches everything nearby. Pure VFX, no model. ===
    this.slots.ult = {
      name: 'Bala de Demolición', cd: 24, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const DUR = 5.0;
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, DUR + 0.3);
        flash(c, 0.5, 0xdfffe0); c.camera.addShake(0.6);
        c.vfx.spring(() => c.controller.position, _up, { color: SPR, life: 0.4, length: 3 });
        c.vfx.dome(c.controller.chest, { radius: 3.5, life: 0.5, color: PALE });
        const dir = c.aimDir.clone(); dir.y = 0;
        if (dir.lengthSq() < 0.01) dir.copy(c.forwardFlat);
        dir.normalize();
        c.controller.velocity.set(dir.x * 30, 16, dir.z * 30);
        let el = 0, bounces = 0, wasAir = false;
        const step = () => {
          const dt = 0.05; el += dt;
          c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.2);
          const ad = c.aimDir.clone(); ad.y = 0;
          if (ad.lengthSq() > 0.01) { ad.normalize(); dir.lerp(ad, 0.55); dir.normalize(); }   // track the cursor tightly
          c.controller.velocity.x = dir.x * 34;
          c.controller.velocity.z = dir.z * 34;
          c.vfx.burst(c.controller.chest, { count: 4, color: PALE, color2: SPR, tile: 4, speed: 5, size: 0.3, life: 0.3, gravity: 0, drag: 3 });
          if (Math.round(el * 20) % 4 === 0) c.vfx.ring(c.controller.position.clone(), { color: PALE, radius: 2.2, life: 0.22, vertical: true });
          if (c.controller.grounded && wasAir) {
            bounces++;
            const fp = feet(c);
            c.controller.velocity.y = 17;
            c.vfx.flipbook(fp.clone().add(_up), { kind: 'impact', size: 14, life: 0.42, color: 0xffffff });
            c.vfx.dome(fp, { radius: 7, life: 0.4, color: PALE });
            c.vfx.ring(fp, { color: LIME, radius: 6, life: 0.3 });
            c.vfx.crack(fp, { radius: 8, count: 8, life: 1.2, ground: true, color: 0xdfffdf });
            c.combat.areaStrike(fp, { radius: 6, damage: 44, knockback: 30, up: 22, stun: 0.6, color: SPR, shake: 0.7, onHitTarget: (t) => coil(c, t, 2, 5) });
            c.combat.hitstop(0.05); c.camera.addShake(0.5);
            this.addMomentum(1);
          }
          wasAir = !c.controller.grounded;
          if (el < DUR) this.schedule(dt, step);
          else {
            const fp = feet(c);
            slow(c, 0.3, 0.4); flash(c, 0.4, 0xffffff); c.combat.hitstop(0.12); c.camera.addShake(1.4);
            c.vfx.flipbook(fp.clone().add(_up), { kind: 'impact', size: 26, life: 0.6, color: 0xffffff });
            c.vfx.dome(fp, { radius: 12, life: 0.8, color: PALE });
            c.vfx.crack(fp, { radius: 13, count: 14, life: 2.5, ground: true, color: 0xdfffdf });
            bounceFx(c, fp, true);
            c.combat.areaStrike(fp, { radius: 11, damage: 80, knockback: 40, up: 26, stun: 1.0, color: SPR, shake: 1.0, onHitTarget: (t) => coil(c, t, 3, 6) });
            this.momentum = 0;
          }
        };
        this.schedule(0.05, step);
      }
    };
  }

  onMelee(c, combo, _dir) {
    const heavy = combo === 3;
    c.vfx.spring(() => c.controller.chest, c.forwardFlat.clone(), { color: 0x8fe08f, life: 0.16, length: heavy ? 1.8 : 1.2 });
    for (const t of c.combat.nearestEnemies(c.controller.position, 3, 4.2)) c.combat.applyStatus(t, 'coil', { stacks: heavy ? 2 : 1, duration: 3.5 });
    this.addMomentum(heavy ? 2 : 1);
  }
}

/* ================================================================ *
 *  ÉPICO — Suna Suna (Arena). Logia. Ult: Tormenta del Desierto.
 * ================================================================ */
export class SunaSuna extends DevilFruit {
  constructor() {
    super('Suna Suna', 0xdcc089, { rarity: 'epico', type: 'logia', passive: 'Logia: 22% esquiva · los golpes aplican Arena (deshidrata + 35% lento) · robas humedad al golpear' });

    const SAND = 0xdcc089, PALE = 0xe6d0a0, WET = 0x9c7b45, DUST = 0x8a6b3c, DARK = 0x6b5230;
    const dry = (t) => (t._status?.sand?.stacks || 0) >= 3;

    // === Z — DESERT SPADA: builder. A colossal travelling crescent of sand
    // scythes a tall corridor ~28 m forward, cleaving everything and ending
    // in a rising geyser. ===
    this.slots.q = {
      name: 'Desert Spada', cd: 2.2, _t: 0,
      cast: (c) => {
        c.pose('sweep');
        const d = c.aimDir.clone().normalize();
        const flat = c.forwardFlat.clone();
        const start = c.controller.chest.clone().addScaledVector(d, 0.8);
        c.vfx.burst(start, { count: 20, color: SAND, color2: PALE, tile: 2, speed: 7, size: 0.3, life: 0.2, gravity: 0, drag: 5, dir: d.clone().negate(), cone: 1.2 });
        c.vfx.flipbook(start.clone(), { kind: 'muzzle', size: 4.5, life: 0.2, color: 0xe8d6ac });
        c.camera.addShake(0.16);
        this.schedule(0.1, () => {
          const seen = new Set();
          const STEPS = 5, GAP = 5.2;
          let n = 0;
          const cut = () => {
            const at = start.clone().addScaledVector(d, 2.5 + n * GAP);
            const gy = gY(c, at.x, at.z);
            for (let k = -1; k <= 1; k++) c.vfx.flipbook(_v.set(at.x, gy + 1.4 + k * 1.6, at.z).clone(), { kind: 'shock', size: 6, life: 0.3, color: PALE });
            c.vfx.burst(_v.set(at.x, gy + 0.2, at.z).clone(), { count: 14, color: SAND, color2: WET, tile: 2, speed: 14, size: 0.42, life: 0.5, gravity: 10, drag: 1.8, dir: _up, cone: 0.7 });
            c.vfx.decal(_v.set(at.x, gy, at.z).clone(), { kind: 'sand', radius: 2.4, life: 3.5, groundY: gy });
            for (const t of c.combat.enemiesInRadius(at, 3.4)) {
              if (seen.has(t)) continue; seen.add(t);
              t.takeHit({ damage: 22, dir: flat.clone().setY(0.15).normalize(), knockback: 22, up: 9, stun: 0.35 });
              c.combat.hooks?.onDamageNumber?.(t.center.clone(), 22);
              c.combat.applyStatus(t, 'sand', { stacks: 2, duration: 5 });
              c.vfx.flipbook(t.center.clone(), { kind: 'impact', size: 6, life: 0.32, color: 0xe8d6ac });
              c.combat.healPlayer(4);
              c.combat.hitstop(0.03);
            }
            if (n === STEPS - 1) { sandPillar(c, _v.set(at.x, gy, at.z).clone(), 7); c.vfx.crack(_v.set(at.x, gy, at.z).clone(), { radius: 5, count: 6, life: 1.2, ground: true, color: 0xcbb27f }); }
            if (++n < STEPS) this.schedule(0.045, cut);
          };
          cut();
          c.camera.addShake(0.22);
        });
      }
    };

    // === X — MAREA DEL DESIERTO: signature. A wide wall of sand heaves up and
    // ROLLS forward ~28 m, carrying and burying everyone in its front, then
    // crashes into a crater. The whole lane it crossed stays quicksand. ===
    this.slots.e = {
      name: 'Marea del Desierto', cd: 9, _t: 0,
      cast: (c) => {
        c.pose('slam');
        const d = c.forwardFlat.clone();
        const right = _v.set(d.z, 0, -d.x).normalize().clone();
        const origin = c.controller.position.clone();
        const WIDTH = 9, STEPS = 12, GAP = 2.0;
        const seen = new Set();
        for (let s = -2; s <= 2; s++) {
          const p = origin.clone().addScaledVector(d, 3).addScaledVector(right, s * 2.2); p.y = gY(c, p.x, p.z);
          sandPillar(c, p, 3 + Math.random() * 2);
        }
        c.vfx.ring(origin.clone().addScaledVector(d, 3), { color: PALE, radius: WIDTH, life: 0.35 });
        c.camera.addShake(0.24);
        let n = 0;
        const roll = () => {
          const front = origin.clone().addScaledVector(d, 4 + n * GAP);
          const gy = gY(c, front.x, front.z);
          for (let s = -2; s <= 2; s++) {
            const p = front.clone().addScaledVector(right, s * (WIDTH * 0.42));
            for (let k = 0; k < 3; k++) c.vfx.flipbook(_v.set(p.x, gy + 1.4 + k * 1.7, p.z).clone(), { kind: 'shock', size: 7, life: 0.28, color: PALE });
          }
          c.vfx.burst(front.clone().add(_v.set(0, 0.4, 0)), { count: 22, color: SAND, color2: WET, tile: 2, speed: 15, size: 0.5, life: 0.6, gravity: 10, drag: 1.5, dir: _up, cone: 1.0 });
          c.vfx.decal(_v.set(front.x, gy, front.z).clone(), { kind: 'sand', radius: WIDTH * 0.55, life: 4, groundY: gy });
          for (const t of c.combat.enemiesInRadius(front, WIDTH * 0.6)) {
            if (seen.has(t)) continue; seen.add(t);
            t.takeHit({ damage: 26, dir: d.clone().setY(0.15).normalize(), knockback: 28, up: 9, stun: 0.4 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 26);
            c.combat.applyStatus(t, 'sand', { stacks: 2, duration: 5, maxStacks: 3 });
            c.vfx.flipbook(t.center.clone(), { kind: 'impact', size: 6, life: 0.3, color: 0xe8d6ac });
            c.combat.hitstop(0.02);
          }
          if (++n < STEPS) this.schedule(0.05, roll);
          else {
            const brk = origin.clone().addScaledVector(d, 4 + STEPS * GAP); brk.y = gY(c, brk.x, brk.z);
            slow(c, 0.16, 0.45); flash(c, 0.3, 0xe8d6a8); c.combat.hitstop(0.08); c.camera.addShake(1.0);
            c.vfx.dome(brk, { radius: WIDTH, life: 0.7, color: PALE });
            c.vfx.flipbook(brk.clone().add(_up), { kind: 'impact', size: WIDTH + 4, life: 0.5, color: 0xd8c096 });
            for (let i = 0; i < 3; i++) this.schedule(i * 0.1, () => c.vfx.flipbook(brk.clone().add(_up.clone().multiplyScalar(2 + i * 3)), { kind: 'smoke', size: WIDTH, life: 2.2, color: 0xbfa87c, additive: false, rise: 1.2, spin: true }));
            c.vfx.crack(brk.clone(), { radius: WIDTH, count: 12, life: 2.5, ground: true, color: 0xcbb27f });
            c.combat.areaStrike(brk, { radius: WIDTH, damage: 80, knockback: 22, up: 12, stun: 1.2, color: WET, shake: 0.7, onHitTarget: (t) => c.combat.applyStatus(t, 'sand', { stacks: 3, duration: 6, maxStacks: 3 }) });
          }
        };
        this.schedule(0.18, roll);
        // the crossed lane stays quicksand — roots + slows for 4 s
        this.schedule(0.6, () => {
          for (let m = 0; m < 5; m++) {
            const mid = origin.clone().addScaledVector(d, 6 + m * 4); mid.y = gY(c, mid.x, mid.z);
            c.vfx.hazard(mid.clone(), {
              kind: 'sand', radius: 4, duration: 4, groundY: mid.y, tick: 0.4,
              onTick: (ctr, r) => { for (const t of c.combat.enemiesInRadius(ctr, r)) { t._stun = Math.max(t._stun || 0, 0.4); t.velocity.y -= 4 / (t.mass || 1); c.combat.applyStatus(t, 'sand', { duration: 3 }); } }
            });
          }
        });
      }
    };

    // === C — SABLES: mobility + offense. Become a rushing sandstorm and
    // blitz to the cursor, a whirling column of blades shredding a wide lane. ===
    this.slots.f = {
      name: 'Sables', cd: 4, _t: 0,
      cast: (c) => {
        const d = c.aimDir.clone(); d.y = 0; d.normalize();
        c.controller.velocity.copy(d).multiplyScalar(46); c.controller.velocity.y = 2;
        c.controller._dashTime = 0.45; c.controller._dashDir.copy(d);
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.55);
        c.pose('thrust');
        c.vfx.tornado(c.controller.position.clone(), { radius: 2.4, height: 5, life: 0.9, blades: 8 });
        c.vfx.flipbook(c.controller.chest.clone(), { kind: 'smoke', size: 8, life: 0.5, color: 0xcbb27f, additive: false, rise: 0.5, spin: true });
        const seen = new Set();
        for (let i = 0; i < 10; i++) this.schedule(i * 0.045, () => {
          const p = c.controller.position.clone(); const gy = gY(c, p.x, p.z);
          c.vfx.decal(_v.set(p.x, gy, p.z).clone(), { kind: 'sand', radius: 2.2, life: 3, groundY: gy });
          c.vfx.burst(c.controller.chest.clone(), { count: 8, color: SAND, color2: WET, tile: 2, speed: 10, size: 0.4, life: 0.4, gravity: 4, drag: 2, dir: d.clone().negate(), cone: 1.8 });
          for (const t of c.combat.enemiesInRadius(c.controller.chest, 3)) {
            if (seen.has(t)) continue; seen.add(t);
            t.takeHit({ damage: 20, dir: d.clone().setY(0.12).normalize(), knockback: 18, up: 7, stun: 0.4 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 20);
            c.combat.applyStatus(t, 'sand', { stacks: 2, duration: 5 });
            c.vfx.flipbook(t.center.clone(), { kind: 'shock', size: 6, life: 0.3, color: PALE });
            c.combat.hitstop(0.025);
          }
        });
        c.camera.addShake(0.16);
      }
    };

    // === V — DESHIDRATACIÓN: press once → a scouring dehydration field wraps
    // you for 4 s over a compact-but-wide radius, draining everyone inside
    // (DoT + Arena + self-heal). Any foe that dries out (3 stacks) crumbles
    // to a husk on the spot. Closes with an outward sand burst. ===
    this.slots.v = {
      name: 'Deshidratación', cd: 11, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const R = 7, DUR = 4.0;
        c.vfx.dome(c.controller.chest, { radius: R, life: 0.5, color: PALE });
        c.vfx.ring(c.controller.chest, { color: PALE, radius: R, life: 0.4 });
        c.vfx.flipbook(c.controller.chest.clone(), { kind: 'muzzle', size: 5, life: 0.24, color: 0xe8d6ac });
        c.camera.addShake(0.2);
        let el = 0;
        const tick = () => {
          el += 0.4;
          const ch = c.controller.chest.clone();
          const gy = gY(c, ch.x, ch.z);
          c.vfx.decal(_v.set(ch.x, gy, ch.z).clone(), { kind: 'sand', radius: R * 0.9, life: 0.9, groundY: gy });
          for (let i = 0; i < 4; i++) {
            const a = el * 3 + i * 1.57;
            const off = new THREE.Vector3(Math.cos(a) * R, (Math.random() - 0.3) * 2.4, Math.sin(a) * R);
            c.vfx.burst(ch.clone().add(off), { count: 3, color: SAND, color2: PALE, tile: 2, speed: 8, size: 0.34, life: 0.4, gravity: 0, drag: 3, dir: off.clone().negate().normalize(), cone: 0.5 });
          }
          let heal = 0;
          for (const t of c.combat.enemiesInRadius(ch, R)) {
            const wasDry = dry(t);
            t.takeHit({ damage: 12, dir: null, knockback: 0, up: 0, stun: 0 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 12);
            c.combat.applyStatus(t, 'sand', { stacks: 1, duration: 5, maxStacks: 3 });
            heal += 6;
            c.vfx.burst(t.center.clone(), { count: 8, color: 0xbfe8ff, color2: SAND, tile: 6, speed: 9, size: 0.24, life: 0.4, gravity: 0, drag: 2, dir: ch.clone().sub(t.center).normalize(), cone: 0.6 });
            if (!wasDry && dry(t)) {                     // dried out this tick → husk
              t.takeHit({ damage: 55, dir: c.forwardFlat.clone().setY(0.1).normalize(), knockback: 24, up: 8, stun: 1.2 });
              c.combat.hooks?.onDamageNumber?.(t.center.clone(), 55);
              c.vfx.burst(t.center.clone(), { count: 48, color: 0xcbb27f, color2: DUST, tile: 2, speed: 16, size: 0.46, life: 0.85, gravity: 15, drag: 1.3 });
              c.vfx.flipbook(t.center.clone(), { kind: 'impact', size: 10, life: 0.42, color: 0xe0c896 });
              c.combat.hitstop(0.05);
            }
          }
          if (heal) c.combat.healPlayer(Math.min(24, heal));
          if (el < DUR) this.schedule(0.4, tick);
          else {
            c.vfx.dome(c.controller.chest, { radius: R + 1, life: 0.5, color: PALE });
            c.vfx.burst(c.controller.chest, { count: 40, color: SAND, color2: DUST, tile: 2, speed: 14, size: 0.44, life: 0.7, gravity: 12, drag: 1.5 });
            c.combat.areaStrike(c.controller.chest, { radius: R, damage: 24, knockback: 14, up: 6, stun: 0.4, color: WET, shake: 0.4, onHitTarget: (t) => c.combat.applyStatus(t, 'sand', { stacks: 2, duration: 5, maxStacks: 3 }) });
          }
        };
        this.schedule(0.3, tick);
      }
    };

    // === T — DESERT GIRASOLE: a titanic sandstorm buries a huge fixed zone.
    // Sand-cloud ceiling → the storm hits: blind, drag inward, ramping DoT,
    // sweeping crescents, sand HANDS slamming down → then the whole zone
    // implodes into a sinkhole that swallows everyone. ===
    this.slots.ult = {
      name: 'Sables: Pesado', cd: 28, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = ahead(c, 12);
        const R = 18;
        // phase 1 — the sky fills with sand
        c.vfx.storm(gp.clone(), { radius: R, height: 24, duration: 7, color: DARK });
        c.vfx.crack(gp.clone(), { radius: R, count: 16, life: 5, ground: true, color: 0xcbb27f });
        c.vfx.decal(gp.clone(), { kind: 'sand', radius: R, life: 15, groundY: gp.y });
        for (let i = 0; i < 3; i++) this.schedule(i * 0.12, () => c.vfx.ring(gp, { color: PALE, radius: R * (0.5 + i * 0.28), life: 0.5, thickness: 0.5 }));
        c.camera.addShake(0.4); slow(c, 0.5, 0.4); flash(c, 0.3, 0xe8d6a8);
        // phase 2 — the storm
        this.schedule(0.5, () => {
          c.vfx.dome(gp, { radius: R + 6, life: 1.0, color: PALE });
          for (let i = 0; i < 5; i++) c.vfx.tornado(gp.clone().add(_v.set((Math.random() - 0.5) * R * 1.4, 0, (Math.random() - 0.5) * R * 1.4)), { radius: 3 + Math.random() * 4, height: 8, life: 5.5, blades: 8 });
          c.vfx.hazard(gp.clone(), {
            kind: 'sand', radius: R, duration: 5.5, groundY: gp.y, tick: 0.3, emit: 0.02,
            onTick: (ctr, r) => {
              for (const t of c.combat.enemiesInRadius(ctr, r)) {
                const toC = ctr.clone().sub(t.center).setY(0).normalize();
                if (t.impulse) t.impulse.addScaledVector(toC, 14 / (t.mass || 1));
                t.velocity.y -= 4 / (t.mass || 1);
                t._stun = Math.max(t._stun || 0, 0.4);
                t.takeHit({ damage: 11, dir: null, knockback: 0, up: 0, stun: 0.3 });
                c.combat.applyStatus(t, 'sand', { stacks: 2, duration: 5, maxStacks: 3 });
              }
            },
            onEmit: (ep) => c.vfx.burst(ep, { count: 5, color: SAND, color2: 0xbfa066, speed: 10, size: 0.44, life: 0.9, gravity: 1, drag: 1.1, dir: c.forwardFlat.clone(), cone: 2.6 })
          });
          // sweeping crescents in rows
          const rt = _v.set(c.forwardFlat.z, 0, -c.forwardFlat.x).normalize().clone();
          for (let w = 0; w < 4; w++) this.schedule(w * 0.7, () => {
            const off = (w % 2 ? 1 : -1) * R * 0.55;
            for (let s = -2; s <= 2; s++) {
              const p = gp.clone().addScaledVector(rt, off).addScaledVector(c.forwardFlat, s * 5);
              const gy = gY(c, p.x, p.z);
              for (let k = 0; k < 3; k++) c.vfx.flipbook(_v.set(p.x, gy + 1.2 + k * 1.6, p.z).clone(), { kind: 'shock', size: 6, life: 0.3, color: PALE });
            }
            c.combat.areaStrike(gp.clone().addScaledVector(rt, off), { radius: R * 0.7, damage: 20, knockback: 12, up: 6, stun: 0.3, silent: true, color: SAND });
          });
          // sand hands slam
          for (let h = 0; h < 3; h++) this.schedule(0.4 + h * 1.1, () => {
            const a = Math.random() * 6.28, rr = Math.random() * R * 0.7;
            const hp = gp.clone().add(_v.set(Math.cos(a) * rr, 0, Math.sin(a) * rr)); hp.y = gY(c, hp.x, hp.z);
            c.vfx.giantArm(hp.clone().add(_v.set(2, 30, 2)), hp.clone(), {
              color: 0xcbb27f, scale: 2.6, life: 0.8,
              onHit: () => {
                c.combat.areaStrike(hp, { radius: 6, damage: 40, knockback: 22, up: 12, stun: 0.6, color: WET, shake: 0.5, onHitTarget: (t) => c.combat.applyStatus(t, 'sand', { stacks: 3, duration: 6, maxStacks: 3 }) });
                c.vfx.flipbook(hp.clone().add(_up), { kind: 'impact', size: 12, life: 0.4, color: 0xd8c096 });
                c.vfx.burst(hp.clone(), { count: 30, color: SAND, color2: DUST, tile: 2, speed: 13, size: 0.44, life: 0.7, gravity: 14, drag: 1.4 });
                c.camera.addShake(0.4);
              }
            });
          });
        });
        // phase 3 — the zone implodes into a sinkhole
        this.schedule(6.0, () => {
          slow(c, 0.35, 0.32); flash(c, 0.5, 0xffffff); c.combat.hitstop(0.14); c.camera.addShake(1.6);
          c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(2)), { kind: 'impact', size: R + 8, life: 0.6, color: 0xd8c096 });
          c.vfx.dome(gp, { radius: R + 4, life: 1.0, color: WET });
          for (let i = 0; i < 4; i++) this.schedule(i * 0.12, () => c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(2 + i * 3)), { kind: 'smoke', size: R, life: 2.6, color: 0xbfa87c, additive: false, rise: 0.5, spin: true }));
          c.vfx.crack(gp.clone(), { radius: R, count: 18, life: 3, ground: true, color: 0xcbb27f });
          c.combat.areaStrike(gp, { radius: R, damage: 120, knockback: 12, up: -8, stun: 2.0, color: WET, shake: 1.0, onHitTarget: (t) => c.combat.applyStatus(t, 'sand', { stacks: 3, duration: 7, maxStacks: 3 }) });
          smoke(c, gp.clone().add(_v.set(0, 3, 0)), 40);
          c.vfx.hazard(gp.clone(), {
            kind: 'sand', radius: R * 0.75, duration: 5, groundY: gp.y, tick: 0.4,
            onTick: (ctr, r) => { for (const t of c.combat.enemiesInRadius(ctr, r)) { t._stun = Math.max(t._stun || 0, 0.5); t.velocity.y -= 6 / (t.mass || 1); c.combat.applyStatus(t, 'sand', { duration: 3 }); } }
          });
        });
      }
    };
  }

  onMelee(c) {
    let healed = false;
    for (const t of c.combat.nearestEnemies(c.controller.position, 3, 4.6)) {
      c.combat.applyStatus(t, 'sand', { stacks: 1, duration: 4 });
      if (!healed) { c.combat.healPlayer(4); healed = true; }
    }
  }
}

/* ================================================================ *
 *  ÉPICO — Mera Mera (Fuego). Logia. Ult: Dai Enkai.
 * ================================================================ */
export class MeraMera extends DevilFruit {
  constructor() {
    super('Mera Mera', 0xff4d16, { rarity: 'epico', type: 'logia', passive: 'Logia: 22% esquiva · los golpes aplican Quemadura · tus habilidades DETONAN la Quemadura acumulada en cadena' });

    const FIRE = 0xff4d16, DEEP = 0xff2d08;

    // === Z — CHISPA: builder. Plant a hovering ember-mote at the cursor; for
    // 3.5 s it drips Burn onto anything nearby — you seed the field with fire. ===
    this.slots.q = {
      name: 'Chispa', cd: 1.4, _t: 0,
      cast: (c) => {
        c.pose('punch');
        const d = c.aimDir.clone().normalize();
        const from = c.controller.chest.clone().addScaledVector(d, 0.9);
        c.vfx.flipbook(from.clone(), { kind: 'muzzle', size: 2.6, life: 0.14, color: 0xffd9a0 });
        c.vfx.beam(() => from.clone(), () => d.clone(), { length: 7, radius: 0.35, life: 0.16, color: 0xff6a24, core: 0xffe08a });
        const foe = c.combat.nearestEnemies(c.controller.position, 1, 30).find((t) => t.center.clone().sub(from).setY(0).normalize().dot(c.forwardFlat) > 0.3);
        const mote = (foe ? foe.center.clone() : from.clone().addScaledVector(d, 7));
        mote.y = gY(c, mote.x, mote.z) + 1.3;
        c.vfx.flame(mote.clone(), { radius: 0.7, height: 1.8, life: 3.5, color: DEEP });
        c.vfx.flipbook(mote.clone(), { kind: 'fire', size: 3, life: 3.5, color: 0xff7a2c, loop: true, rise: 0.05 });
        c.vfx.burst(mote.clone(), { count: 12, color: 0xffca3a, color2: FIRE, tile: 1, speed: 7, size: 0.24, life: 0.35, gravity: 2, drag: 2 });
        c.camera.addShake(0.06);
        let n = 0;
        const drip = () => {
          n++;
          for (const t of c.combat.enemiesInRadius(mote, 3)) {
            t.takeHit({ damage: 4, dir: null, knockback: 0, up: 0, stun: 0 });
            c.combat.applyStatus(t, 'burn', { stacks: 1, duration: 4, maxStacks: 3 });
          }
          c.vfx.burst(mote.clone(), { count: 3, color: 0xffb43c, color2: 0xff3d12, tile: 1, speed: 3, size: 0.28, life: 0.4, gravity: -2, drag: 2, dir: _up, cone: 0.8 });
          if (n < 7) this.schedule(0.5, drip);
        };
        this.schedule(0.15, drip);
      }
    };

    // === X — REGUERO: signature. A living wildfire — flame nodes that spread
    // on their own, chasing new fuel and jumping Burn from foe to foe, until
    // the whole floor is alight. ~5 s. ===
    this.slots.e = {
      name: 'Reguero', cd: 8, _t: 0,
      cast: (c) => {
        c.pose('sweep');
        const d = c.forwardFlat.clone();
        const right = _v.set(d.z, 0, -d.x).normalize().clone();
        const base = c.controller.position.clone().addScaledVector(d, 4);
        const nodes = [];
        const addNode = (p) => {
          if (nodes.length >= 16) return;
          p.y = gY(c, p.x, p.z);
          nodes.push(p);
          c.vfx.flame(p.clone(), { radius: 1.3, height: 3.4, life: 4.5, color: DEEP });
          c.vfx.flipbook(p.clone().add(_up.clone().multiplyScalar(1.3)), { kind: 'fire', size: 4.5, life: 4.5, color: 0xff6a24, loop: true, rise: 0.1 });
          c.vfx.decal(p.clone(), { kind: 'scorch', radius: 2, life: 8, groundY: p.y });
        };
        for (let s = -2; s <= 2; s++) addNode(base.clone().addScaledVector(right, s * 2.4));
        c.camera.addShake(0.2); flash(c, 0.12, 0xff8a3c);
        let el = 0; const DUR = 5.0;
        const spread = () => {
          el += 0.4;
          for (const p of nodes) for (const t of c.combat.enemiesInRadius(p, 2.6)) {
            t.takeHit({ damage: 8, dir: t.center.clone().sub(p).setY(0.1).normalize(), knockback: 5, up: 2, stun: 0.1 });
            c.combat.applyStatus(t, 'burn', { stacks: 1, duration: 4, maxStacks: 3 });
          }
          // contagion — every burning foe lights an un-burnt neighbour
          const foes = c.combat.enemiesInRadius(base, 40);
          for (const t of foes) {
            if (!t._status?.burn) continue;
            const near = foes.find((o) => o !== t && !o._status?.burn && o.center.distanceTo(t.center) < 5);
            if (near) { c.combat.applyStatus(near, 'burn', { stacks: 1, duration: 4 }); c.vfx.beam(() => t.center.clone(), () => near.center.clone().sub(t.center).normalize(), { length: t.center.distanceTo(near.center), radius: 0.25, life: 0.18, color: 0xff6a24, core: 0xffe08a }); }
          }
          // the fire crawls — grow a node toward fresh fuel, else outward
          if (el < DUR - 0.4) {
            const seed = nodes[(Math.random() * nodes.length) | 0];
            const fuel = c.combat.nearestEnemies(seed, 1, 12).find((t) => !nodes.some((nd) => nd.distanceTo(t.center) < 2.5));
            const to = fuel ? fuel.center.clone().sub(seed).setY(0).normalize() : d.clone().add(_v.set((Math.random() - 0.5), 0, (Math.random() - 0.5))).normalize();
            addNode(seed.clone().addScaledVector(to, 3 + Math.random() * 2));
          }
          if (el < DUR) this.schedule(0.4, spread);
        };
        this.schedule(0.25, spread);
      }
    };

    // === C — ESPEJISMO: mobility. Dissolve into flame and reappear at the
    // cursor; the burning after-image you leave behind DETONATES all nearby
    // Burn a second later. ===
    this.slots.f = {
      name: 'Espejismo', cd: 4.0, _t: 0,
      cast: (c) => {
        const d = c.aimDir.clone(); d.y = 0; d.normalize();
        const decoy = c.controller.position.clone(); decoy.y = gY(c, decoy.x, decoy.z);
        const dest = c.controller.position.clone().addScaledVector(d, 12);
        const g = c.world.sampleGround(dest.x, dest.z);
        dest.y = (g.onLand ? g.height : 0) + 0.05;
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.5);
        c.vfx.burst(c.controller.chest, { count: 30, color: 0xffb43c, color2: 0xff3d12, tile: 1, speed: 13, size: 0.34, life: 0.45, gravity: -1, drag: 3 });
        c.vfx.flipbook(c.controller.chest.clone(), { kind: 'fire', size: 6, life: 0.4, color: 0xff7a2c });
        // burning after-image
        c.vfx.flame(decoy.clone(), { radius: 1.2, height: 4, life: 1.1, color: DEEP });
        c.vfx.flipbook(decoy.clone().add(_up.clone().multiplyScalar(1.6)), { kind: 'fire', size: 5, life: 1.1, color: 0xff6a24, loop: true });
        c.controller.teleport(dest);
        c.vfx.flipbook(c.controller.chest.clone(), { kind: 'impact', size: 6, life: 0.35, color: 0xffcf8a });
        this.schedule(0.6, () => {
          c.vfx.flipbook(decoy.clone().add(_up), { kind: 'impact', size: 10, life: 0.42, color: 0xffdca8 });
          c.vfx.dome(decoy.clone(), { radius: 8, life: 0.4, color: 0xff8a3c });
          const popped = detonateBurn(c, { center: decoy.clone().add(_up), radius: 8 });
          c.combat.areaStrike(decoy.clone(), { radius: 5, damage: 18, knockback: 16, up: 6, stun: 0.3, color: 0xff5a1e, silent: true, onHitTarget: (t) => c.combat.applyStatus(t, 'burn', { stacks: 1, duration: 4 }) });
          if (popped) { c.combat.hitstop(0.05); c.camera.addShake(0.4); }
        });
      }
    };

    // === V — DETONACIÓN: the finisher. Every burning enemy on the field
    // ERUPTS at once, each blast scaling with its Burn stacks and chaining
    // into its burning neighbours. ===
    this.slots.v = {
      name: 'Detonación', cd: 7.0, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        c.vfx.flipbook(c.controller.chest.clone().addScaledVector(c.aimDir, 1), { kind: 'muzzle', size: 4, life: 0.18, color: 0xffd9a0 });
        const popped = detonateBurn(c, { baseDmg: 16, perStack: 20 });
        if (popped) {
          flash(c, Math.min(0.5, 0.14 + popped * 0.08), 0xffe0b0);
          c.camera.addShake(Math.min(1.2, 0.3 + popped * 0.18));
          c.combat.hitstop(Math.min(0.12, 0.03 + popped * 0.02));
          if (popped >= 3) slow(c, 0.16, 0.42);
        } else {
          c.vfx.burst(c.controller.chest, { count: 12, color: 0xffb43c, speed: 5, size: 0.3, life: 0.3, gravity: 4, drag: 3, tile: 1 });
        }
      }
    };

    // === Z — HIGAN: builder. A rapid 6-round barrage of exploding fire
    // bullets to the cursor — pure spam pressure that stacks Burn. ===
    this.slots.q = {
      name: 'Higan', cd: 1.6, _t: 0,
      cast: (c) => {
        c.pose('punch');
        c.vfx.flipbook(c.controller.chest.clone().addScaledVector(c.aimDir, 1.1), { kind: 'muzzle', size: 3, life: 0.16, color: 0xffd9a0 });
        c.camera.addShake(0.08);
        const foe = c.combat.nearestEnemies(c.controller.position, 1, 48)[0] || null;
        for (let i = 0; i < 6; i++) this.schedule(i * 0.05, () => {
          const base = (foe && !foe.dead) ? foe.center.clone().sub(c.controller.chest).normalize() : c.aimDir.clone();
          const dir = base.add(_v.set((Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.07, (Math.random() - 0.5) * 0.1)).normalize();
          const hp = c.controller.chest.clone().addScaledVector(dir, 1.1);
          c.vfx.burst(hp, { count: 5, color: 0xffd27a, color2: FIRE, tile: 3, speed: 12, size: 0.2, life: 0.16, gravity: 0, drag: 6, dir, cone: 0.35 });
          c.combat.spawnProjectile({
            pos: hp, vel: dir.clone().multiplyScalar(72), gravity: 0, drag: 0,
            radius: 0.5, life: 1.0, damage: 12, aoe: 1.8, knockback: 6, up: 3,
            color: 0xff6a24, trailColor: 0xffc061, mesh: ember(0xff7a2a, 0.34),
            onImpact: (p) => {
              c.vfx.flipbook(p.clone(), { kind: 'impact', size: 4.5, life: 0.3, color: 0xffcf8a });
              c.vfx.burst(p.clone(), { count: 14, color: 0xffca3a, color2: 0xff3d12, tile: 1, speed: 11, size: 0.28, life: 0.4, gravity: 3, drag: 2 });
              for (const t of c.combat.enemiesInRadius(p, 2.2)) c.combat.applyStatus(t, 'burn', { stacks: 1, duration: 4 });
            }
          });
        });
      }
    };

    // === X — JUJIKA: signature. A colossal burning CROSS is branded across
    // the ground ahead — a fire lattice that traps and cooks everything in
    // it for 4 s, pulsing in flares, then bursts. ===
    this.slots.e = {
      name: 'Jujika', cd: 8, _t: 0,
      cast: (c) => {
        c.pose('sweep');
        const d = c.forwardFlat.clone();
        const right = _v.set(d.z, 0, -d.x).normalize().clone();
        const ctr = c.controller.position.clone().addScaledVector(d, 8); ctr.y = gY(c, ctr.x, ctr.z);
        const ARM = 8, LIFE = 4.0;
        c.camera.addShake(0.24); flash(c, 0.16, 0xff8a3c);
        const diagA = d.clone().add(right).normalize();
        const diagB = d.clone().sub(right).normalize();
        const nodes = [];
        for (const ax of [diagA, diagB]) for (let s = -3; s <= 3; s++) {
          const p = ctr.clone().addScaledVector(ax, s * (ARM / 3)); p.y = gY(c, p.x, p.z);
          nodes.push(p);
          c.vfx.flipbook(p.clone().add(_up.clone().multiplyScalar(1.6)), { kind: 'fire', size: 6, life: LIFE, color: 0xff6a24, loop: true, rise: 0.2 });
          c.vfx.flame(p.clone(), { radius: 1.5, height: 4, life: LIFE, color: DEEP });
          c.vfx.decal(p.clone(), { kind: 'scorch', radius: 2.2, life: 8, groundY: p.y });
        }
        c.vfx.flipbook(ctr.clone().add(_up.clone().multiplyScalar(2)), { kind: 'impact', size: 12, life: 0.4, color: 0xffdca8 });
        let n = 0;
        const tick = () => {
          n++;
          for (const p of nodes) for (const t of c.combat.enemiesInRadius(p, 2.4)) {
            t.takeHit({ damage: 9, dir: t.center.clone().sub(ctr).setY(0.12).normalize(), knockback: 8, up: 3, stun: 0.15 });
            c.combat.applyStatus(t, 'burn', { stacks: 1, duration: 4, maxStacks: 3 });
          }
          if (n % 3 === 0) for (const p of nodes) c.vfx.burst(p.clone(), { count: 6, color: 0xffca3a, color2: 0xff3d12, tile: 1, speed: 8, size: 0.3, life: 0.4, gravity: 4, drag: 2, dir: _up, cone: 1.4 });
          if (n * 0.35 < LIFE) this.schedule(0.35, tick);
          else {
            c.vfx.flipbook(ctr.clone().add(_up), { kind: 'impact', size: 14, life: 0.5, color: 0xffdca8 });
            c.combat.areaStrike(ctr, { radius: ARM, damage: 30, knockback: 20, up: 8, stun: 0.4, color: 0xff5a1e, shake: 0.4, onHitTarget: (t) => c.combat.applyStatus(t, 'burn', { stacks: 2, duration: 5 }) });
            c.combat.hitstop(0.04);
          }
        };
        this.schedule(0.2, tick);
      }
    };

    // === C — KAGERŌ: mobility. Blast off on a fire-jet, leaving a wall of
    // flame in your wake that keeps burning anyone who crosses it. ===
    this.slots.f = {
      name: 'Kagerō', cd: 3.5, _t: 0,
      cast: (c) => {
        const d = c.aimDir.clone(); d.y *= 0.3; d.normalize();
        c.controller.velocity.copy(d).multiplyScalar(42); c.controller.velocity.y += 4;
        c.controller._dashTime = 0.34; c.controller._dashDir.copy(d);
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.45);
        c.vfx.burst(c.controller.chest, { count: 26, color: 0xffb43c, color2: 0xff3d12, tile: 1, speed: 11, size: 0.32, life: 0.45, gravity: -2, drag: 3, dir: d.clone().negate(), cone: 1.1 });
        const trail = [];
        const seen = new Set();
        for (let i = 0; i < 8; i++) this.schedule(i * 0.045, () => {
          const p = c.controller.position.clone(); p.y = gY(c, p.x, p.z);
          trail.push(p);
          c.vfx.flame(p.clone(), { radius: 1.2, height: 3.2, life: 2.0, color: DEEP });
          c.vfx.flipbook(p.clone().add(_up.clone().multiplyScalar(1.4)), { kind: 'fire', size: 4, life: 2.0, color: 0xff6a24, loop: true });
          c.vfx.decal(p.clone(), { kind: 'scorch', radius: 1.6, life: 5, groundY: p.y });
          for (const t of c.combat.enemiesInRadius(c.controller.chest, 2.6)) {
            if (seen.has(t)) continue; seen.add(t);
            t.takeHit({ damage: 16, dir: d.clone().setY(0.1).normalize(), knockback: 12, up: 5, stun: 0.25 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 16);
            c.combat.applyStatus(t, 'burn', { stacks: 2, duration: 4 });
            c.vfx.flipbook(t.center.clone(), { kind: 'impact', size: 5, life: 0.3, color: 0xffcf8a });
          }
        });
        let bt = 0;
        const burnTrail = () => {
          bt += 0.4;
          for (const p of trail) for (const t of c.combat.enemiesInRadius(p, 2)) { t.takeHit({ damage: 5, dir: null, knockback: 0, up: 0, stun: 0 }); c.combat.applyStatus(t, 'burn', { duration: 3 }); }
          if (bt < 2.2) this.schedule(0.4, burnTrail);
        };
        this.schedule(0.5, burnTrail);
        c.camera.addShake(0.14);
      }
    };

    // === V — HIKEN: Ace's fist of fire. A colossal flame column ROARS ~29 m
    // down a wide corridor — huge damage, huge knockback, everyone left on
    // fire, ending in a towering eruption. ===
    this.slots.v = {
      name: 'Hiken', cd: 6.0, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const d = c.aimDir.clone().normalize();
        const flat = c.forwardFlat.clone();
        const start = c.controller.chest.clone().addScaledVector(d, 1.2);
        c.vfx.beam(() => c.controller.chest.clone(), () => d.clone(), { length: 8, radius: 1.4, life: 0.3, color: 0xff5a1e, core: 0xffe08a });
        c.vfx.flipbook(start.clone(), { kind: 'muzzle', size: 6, life: 0.24, color: 0xffd9a0 });
        c.camera.addShake(0.3); flash(c, 0.16, 0xffca9a);
        const seen = new Set();
        const STEPS = 6, GAP = 4.5;
        let n = 0;
        const roar = () => {
          const at = start.clone().addScaledVector(d, 2 + n * GAP);
          const gy = gY(c, at.x, at.z);
          c.vfx.flipbook(_v.set(at.x, gy + 2, at.z).clone(), { kind: 'fire', size: 11, life: 0.5, color: 0xff5a1e, rise: 1.5 });
          c.vfx.flame(_v.set(at.x, gy, at.z).clone(), { radius: 3, height: 9, life: 0.9, color: DEEP });
          c.vfx.burst(_v.set(at.x, gy + 1, at.z).clone(), { count: 20, color: 0xffca3a, color2: 0xff3d12, tile: 1, speed: 14, size: 0.44, life: 0.5, gravity: 4, drag: 1.8, dir: _up, cone: 1.4 });
          c.vfx.decal(_v.set(at.x, gy, at.z).clone(), { kind: 'scorch', radius: 4, life: 8, groundY: gy });
          for (const t of c.combat.enemiesInRadius(at, 4.5)) {
            if (seen.has(t)) continue; seen.add(t);
            t.takeHit({ damage: 44, dir: flat.clone().setY(0.15).normalize(), knockback: 40, up: 10, stun: 0.5 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 44);
            c.combat.applyStatus(t, 'burn', { stacks: 3, duration: 6, maxStacks: 3 });
            c.vfx.flipbook(t.center.clone(), { kind: 'impact', size: 8, life: 0.4, color: 0xffdca8 });
            c.combat.hitstop(0.04);
          }
          if (++n < STEPS) this.schedule(0.05, roar);
          else {
            const end = start.clone().addScaledVector(d, 2 + STEPS * GAP); end.y = gY(c, end.x, end.z);
            slow(c, 0.14, 0.4); c.combat.hitstop(0.07); c.camera.addShake(0.8);
            c.vfx.flipbook(end.clone().add(_up.clone().multiplyScalar(3)), { kind: 'impact', size: 16, life: 0.5, color: 0xffdca8 });
            c.vfx.flame(end.clone(), { radius: 5, height: 14, life: 1.6, color: DEEP });
            c.vfx.dome(end, { radius: 8, life: 0.5, color: 0xff8a3c });
            c.combat.areaStrike(end, { radius: 7, damage: 50, knockback: 30, up: 14, stun: 0.7, color: 0xff5a1e, shake: 0.5, onHitTarget: (t) => c.combat.applyStatus(t, 'burn', { stacks: 3, duration: 6 }) });
            smoke(c, end.clone(), 16);
          }
        };
        this.schedule(0.12, roar);
      }
    };

    // === T — HŌŌ: NOVA SOLAR. A fast beat: snap-lift into a sun, everyone in
    // range is YANKED in and rooted for ~1 s under a burning corona + two
    // instant solar flares, then an immediate SUPERNOVA (fast rolling blast +
    // every burning enemy detonated). No slow wind-up — foes can't walk out. ===
    this.slots.ult = {
      name: 'Hōō: Nova Solar', cd: 28, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const DUR = 1.0;
        const anchor = c.controller.position.clone();       // where the sun locks
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, DUR + 0.8);
        c.controller.velocity.y = 13;                       // snap lift
        flash(c, 0.45, 0xffe6b0); slow(c, 0.3, 0.5); c.combat.hitstop(0.05); c.camera.addShake(0.7);
        c.vfx.dome(c.controller.chest, { radius: 6, life: 0.5, color: 0xffca3a });
        c.vfx.flipbook(c.controller.chest.clone(), { kind: 'energyball', size: 9, life: 0.5, color: 0xffe6a8, rise: 1 });
        // instant hard yank — runners get caught before the sun even forms
        for (const t of c.combat.enemiesInRadius(anchor, 16)) {
          const toC = _v.set(anchor.x - t.center.x, 0, anchor.z - t.center.z).normalize();
          if (t.impulse) t.impulse.addScaledVector(toC, Math.min(40, t.center.distanceTo(anchor) * 3) / (t.mass || 1));
          t._stun = Math.max(t._stun || 0, 0.5);
        }
        // two instant solar flares at the cursor
        for (let f = 0; f < 2; f++) this.schedule(0.12 + f * 0.4, () => {
          const tp = ahead(c, 8 + Math.random() * 6); tp.y = gY(c, tp.x, tp.z);
          c.vfx.ring(tp, { color: 0xffb43c, radius: 5, life: 0.35 });
          c.combat.spawnProjectile({
            pos: tp.clone().add(_up.clone().multiplyScalar(26)), vel: _v.set(0, -70, 0).clone(),
            gravity: 0, drag: 0, radius: 1.6, life: 0.8, damage: 46, aoe: 6, knockback: 26, up: 8,
            color: 0xff6a24, trailColor: 0xffca3a, mesh: ember(0xff6a24, 0.9),
            onImpact: (p) => {
              const y = gY(c, p.x, p.z); const at = _v.set(p.x, y, p.z).clone();
              c.vfx.flipbook(at.clone().add(_up), { kind: 'impact', size: 12, life: 0.4, color: 0xffdca8 });
              c.vfx.flame(at.clone(), { radius: 3, height: 8, life: 1.0, color: DEEP });
              c.vfx.decal(at.clone(), { kind: 'scorch', radius: 6, life: 8, groundY: y });
              for (const t of c.combat.enemiesInRadius(at, 6)) c.combat.applyStatus(t, 'burn', { stacks: 2, duration: 5, maxStacks: 3 });
              c.camera.addShake(0.5);
            }
          });
        });

        // brief sun corona — burns + hard-pulls + roots so nothing escapes
        let el = 0;
        const sun = () => {
          el += 0.08;
          const R = 12 + (el / DUR) * 4;
          const ch = c.controller.chest.clone();
          const alt = c.controller.position.y - gY(c, c.controller.position.x, c.controller.position.z);
          if (alt < 4.5) c.controller.velocity.y = Math.max(c.controller.velocity.y, 6);
          else if (alt > 7) c.controller.velocity.y = Math.min(c.controller.velocity.y, -2);
          else c.controller.velocity.y *= 0.5;
          c.vfx.burst(ch.clone().add(_v.set((Math.random() - 0.5) * R, (Math.random() - 0.3) * 4, (Math.random() - 0.5) * R)),
            { count: 3, color: 0xffca3a, color2: 0xff3d12, tile: 1, speed: 7, size: 0.36, life: 0.4, gravity: 0, drag: 2 });
          if (Math.round(el * 100) % 16 === 0) {
            c.vfx.flipbook(ch.clone(), { kind: 'fire', size: 10, life: 0.35, color: 0xff7a2c });
            c.vfx.ring(_v.set(anchor.x, gY(c, anchor.x, anchor.z), anchor.z).clone(), { color: 0xffb43c, radius: R, life: 0.28 });
            for (const t of c.combat.enemiesInRadius(anchor, R)) {
              const toC = _v.set(anchor.x - t.center.x, 0, anchor.z - t.center.z).normalize();
              if (t.impulse) t.impulse.addScaledVector(toC, 28 / (t.mass || 1));
              t._stun = Math.max(t._stun || 0, 0.35);
              t.takeHit({ damage: 12, dir: null, knockback: 0, up: 0, stun: 0 });
              c.combat.applyStatus(t, 'burn', { stacks: 1, duration: 5, maxStacks: 3 });
            }
          }
          if (el < DUR) this.schedule(0.08, sun);
          else {
            // ---- SUPERNOVA (immediate) ----
            const gp = anchor.clone(); gp.y = gY(c, gp.x, gp.z);
            c.controller.velocity.set(0, -34, 0);
            flash(c, 0.95, 0xffffff); slow(c, 0.4, 0.26); c.combat.hitstop(0.16); c.camera.addShake(2.2);
            const at = gp.clone().add(_up.clone().multiplyScalar(2));
            const R2 = 20;
            c.vfx.flipbook(at.clone(), { kind: 'impact', size: 40, life: 0.5, color: 0xffffff });
            c.vfx.flame(gp.clone(), { radius: 7, height: 24, life: 2.0, color: DEEP });
            c.vfx.dome(at.clone(), { radius: R2 + 4, life: 0.9, color: 0xff8a3c });
            const seen = new Set();
            for (let w = 0; w < 6; w++) this.schedule(w * 0.03, () => {          // fast sweep — 0.18 s to the edge
              const rNow = (w + 1) / 6 * R2;
              c.vfx.ring(gp, { color: w % 2 ? 0xffd070 : 0xff5a1e, radius: rNow, life: 0.4, thickness: 0.9 });
              if (w === 1) c.vfx.flipbook(at.clone(), { kind: 'shock', size: R2 * 1.6, life: 0.4, color: 0xffe0b0 });
              for (const t of c.combat.enemiesInRadius(gp, rNow)) {
                if (seen.has(t)) continue; seen.add(t);
                const kk = 1 - (t.center.distanceTo(gp) / R2) * 0.6;
                t.takeHit({ damage: 150 * kk, dir: t.center.clone().sub(gp).setY(0.25).normalize(), knockback: 44 * kk, up: 14 * kk, stun: 1.1 });
                c.combat.hooks?.onDamageNumber?.(t.center.clone(), Math.round(150 * kk));
                c.combat.applyStatus(t, 'burn', { stacks: 3, duration: 6 });
              }
            });
            this.schedule(0.22, () => detonateBurn(c, { baseDmg: 20, perStack: 22 }));
            for (let i = 0; i < 4; i++) this.schedule(0.08 + i * 0.14, () =>
              c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(5 + i * 6)), { kind: 'smoke', size: 16 + i * 5, life: 2.6, color: 0x5a4a3a, additive: false, rise: 2, spin: true }));
            smoke(c, at.clone().add(_up.clone().multiplyScalar(3)), 40);
            c.vfx.decal(gp.clone(), { kind: 'scorch', radius: R2, life: 16, groundY: gp.y });
            c.vfx.crack(gp.clone(), { radius: R2 * 0.8, count: 14, life: 3, color: 0xff6a24 });
            debrisRing(c, gp, R2 * 0.7, 18);
            c.vfx.hazard(gp.clone(), {
              kind: 'fire', radius: R2 * 0.7, duration: 5, groundY: gp.y,
              onTick: (ctr, r) => { for (const t of c.combat.enemiesInRadius(ctr, r)) { t.takeHit({ damage: 6, dir: null, knockback: 0, up: 0, stun: 0 }); c.combat.applyStatus(t, 'burn', { duration: 3 }); } },
              onEmit: (ep) => c.vfx.burst(ep, { count: 2, color: 0xffb43c, color2: 0xff3d12, tile: 1, speed: 3, size: 0.4, life: 0.6, gravity: -3, drag: 2, dir: _up, cone: 0.6 })
            });
          }
        };
        this.schedule(0.16, sun);
      }
    };
  }

  // passive: melee strikes ignite everything in the swing
  onMelee(c, _combo, _dir) {
    for (const t of c.combat.nearestEnemies(c.controller.position, 4, 4.2)) c.combat.applyStatus(t, 'burn', { stacks: 1, duration: 3.5 });
  }
}

/* ================================================================ *
 *  ÉPICO — Hie Hie (Hielo). Logia. Ult: Era Glacial.
 * ================================================================ */
export class HieHie extends DevilFruit {
  constructor() {
    super('Hie Hie', 0x8fdcff, {
      rarity: 'epico', type: 'logia',
      passive: 'Logia: 22% esquiva · camina sobre el agua · los golpes aplican Escarcha · a 3 = Congelado; tus habilidades ROMPEN a los congelados'
    });
    // Kit rebuilt 2026-09 from 6 reference images — every ability polished to
    // match the concept art (shape, placement, size, thickness).
    const ICE = 0xa8ecff, PALE = 0xeafaff, FROST = 0xdff6ff, TEAL = 0x3fe6dc, DEEP = 0x2f7fc8;
    this._snowballMesh = null;   // Game._loadModels swaps in models/snowball.glb (Avalancha Celestial)

    // paint a patch of slippery ice: low-friction for the player (`_slick`),
    // and enemies inside skid around uncontrollably + keep getting chilled.
    const iceZone = (c, pos, R, dur) => {
      pos.y = gY(c, pos.x, pos.z);
      c.vfx.decal(pos.clone(), { kind: 'frost', radius: R, life: dur + 1, groundY: pos.y });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 6.283;
        const p = pos.clone().add(_v.set(Math.cos(a) * R * 0.9, 0, Math.sin(a) * R * 0.9)); p.y = gY(c, p.x, p.z);
        iceSpike(c, p, 1 + Math.random() * 1.4, { hold: dur * 0.4 });
      }
      let el = 0;
      const tick = () => {
        el += 0.3;
        if (c.controller.position.distanceTo(pos) < R + 1) c.controller._slick = 0.55;
        for (const t of c.combat.enemiesInRadius(pos, R)) {
          const rnd = _v.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
          if (t.impulse) t.impulse.addScaledVector(rnd, 12 / (t.mass || 1));
          c.combat.applyStatus(t, 'chill', { stacks: 1, duration: 3, maxStacks: 3 });
        }
        if (el < dur) this.schedule(0.3, tick);
      };
      this.schedule(0.2, tick);
    };

    // layered ice-impact FX (Goro-strike style — bolt/ribbon/beam analogs): a
    // white core flash, a frost shock ring, a crystal shard spray, a ground
    // decal, and a burst. One call per node so strikes read punchy.
    const iceHit = (c, p, { size = 10, decal = 2.4, shards = 22, spikes = 0, ground = true } = {}) => {
      const g = ground ? _v.set(p.x, gY(c, p.x, p.z), p.z).clone() : p.clone();
      c.vfx.flipbook(p.clone().add(_up), { kind: 'impact', size, life: 0.4, color: 0xffffff });
      c.vfx.flipbook(p.clone().add(_up), { kind: 'shock', size: size * 0.9, life: 0.34, color: PALE });
      c.vfx.dome(g.clone(), { radius: size * 0.42, life: 0.32, color: FROST });
      c.vfx.burst(p.clone().add(_up), { count: shards, color: 0xffffff, color2: _ICE_BODY, tile: 3, speed: 16, size: 0.34, life: 0.42, gravity: 8, drag: 1.7 });
      if (ground) c.vfx.decal(g.clone(), { kind: 'frost', radius: decal, life: 3, groundY: g.y });
      for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * 6.283 + Math.random();
        const q = g.clone().add(_v.set(Math.cos(a) * decal * 0.7, 0, Math.sin(a) * decal * 0.7)); q.y = gY(c, q.x, q.z);
        iceSpike(c, q, 1.4 + Math.random() * 2.2, { cluster: false, radius: 0.5, tilt: 0.28, lean: _v.set(Math.cos(a), 0, Math.sin(a)).clone(), hold: 2.2 });
      }
    };

    // === Z — LANZA GLACIAL: a charged ice LANCE rifles down the aim — layered
    // beam + a crystal spearhead that flies + displaced air — piercing the
    // line, and the frost then CREEPS to nearby foes (a chain-freeze). ===
    this.slots.q = {
      name: 'Lanza Glacial', cd: 1.6, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const d = c.aimDir.clone().normalize();
        const rt = _v.set(d.z, 0, -d.x).normalize().clone();
        const hand = c.controller.chest.clone().addScaledVector(d, 0.7);
        const LEN = 42;
        // wind-up
        c.vfx.flipbook(hand.clone(), { kind: 'magic', size: 3, life: 0.16, color: TEAL });
        c.vfx.burst(hand.clone(), { count: 12, color: 0xffffff, color2: FROST, tile: 5, speed: 4, size: 0.3, life: 0.18, gravity: 0, drag: 7, dir: d.clone().negate(), cone: 1.1 });
        c.camera.addShake(0.12); flash(c, 0.12, PALE);
        // FIRE — layered shaft
        c.vfx.beam(() => hand.clone(), () => d.clone(), { length: LEN, radius: 0.7, life: 0.22, color: DEEP, core: 0xffffff });
        c.vfx.beam(() => hand.clone(), () => d.clone(), { length: LEN, radius: 0.24, life: 0.18, color: 0xffffff, core: 0xffffff });
        c.vfx.windGust(_v.set(hand.x, gY(c, hand.x, hand.z), hand.z).clone(), { dir: c.forwardFlat.clone(), length: LEN, width: 4.5, life: 0.5, color: PALE });
        c.vfx.flipbook(hand.clone(), { kind: 'muzzle', size: 3.6, life: 0.14, color: PALE });
        c.combat.hitstop(0.04); c.camera.addShake(0.3);
        // the crystal spearhead flies the length, then shatters
        const head = new THREE.Group();
        head.add(new THREE.Mesh(new THREE.ConeGeometry(0.34, 3.2, 6, 1), new THREE.MeshToonMaterial({ color: _ICE_BODY, emissive: new THREE.Color(_ICE_CORE).multiplyScalar(0.3), transparent: true, opacity: 0.96, flatShading: true })));
        head.add(new THREE.Mesh(new THREE.ConeGeometry(0.6, 4, 6, 1), new THREE.MeshBasicMaterial({ color: FROST, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false })));
        head.quaternion.setFromUnitVectors(_up, d);
        head.position.copy(hand);
        c.scene.add(head);
        const g0 = head.children[0].geometry, g1 = head.children[1].geometry, m0 = head.children[0].material, m1 = head.children[1].material;
        let ft = 0;
        const fly = () => {
          ft += 1 / 60;
          const k = Math.min(1, ft / 0.2);
          head.position.copy(hand).addScaledVector(d, k * LEN);
          head.rotateOnAxis(_up, 0.5);
          c.vfx.burst(head.position.clone(), { count: 3, color: 0xffffff, color2: FROST, tile: 0, speed: 4, size: 0.35, life: 0.3, gravity: 2, drag: 2 });
          if (k >= 1) {
            c.scene.remove(head); g0.dispose(); g1.dispose(); m0.dispose(); m1.dispose();
            const endP = hand.clone().addScaledVector(d, LEN);
            iceHit(c, endP, { size: 12, decal: 3, shards: 24, spikes: 3 });
            return;
          }
          requestAnimationFrame(fly);
        };
        this.schedule(0.03, fly);
        // pierce the corridor + seed the frost-creep
        const seeds = [];
        for (const t of c.combat.enemiesInRadius(hand.clone().addScaledVector(d, LEN * 0.5), LEN * 0.6)) {
          const rel = _v.set(t.center.x - hand.x, 0, t.center.z - hand.z);
          const along = rel.dot(d);
          if (along < 0 || along > LEN) continue;
          if (Math.abs(rel.dot(rt)) > 2.2) continue;
          t.takeHit({ damage: 26, dir: d.clone().setY(0.12).normalize(), knockback: 14, up: 5, stun: 0.3 });
          c.combat.hooks?.onDamageNumber?.(t.center.clone(), 26);
          c.combat.applyStatus(t, 'chill', { stacks: 2, duration: 5, maxStacks: 3 });
          c.vfx.flipbook(t.center.clone(), { kind: 'shock', size: 6, life: 0.26, color: PALE });
          seeds.push(t.center.clone());
        }
        // frost creeps outward from each pierced foe + the tip, a beat later
        this.schedule(0.16, () => {
          const from = seeds.length ? seeds : [hand.clone().addScaledVector(d, LEN)];
          for (const s of from) {
            for (const t of c.combat.enemiesInRadius(s, 5)) {
              c.combat.applyStatus(t, 'chill', { stacks: 1, duration: 4, maxStacks: 3 });
              c.vfx.burst(t.center.clone(), { count: 6, color: 0xffffff, color2: _ICE_BODY, tile: 0, speed: 6, size: 0.24, life: 0.3, gravity: 4, drag: 2 });
            }
            shatterFrozen(c, { center: s.clone(), radius: 4.5, baseDmg: 30 });
          }
        });
      }
    };

    // === X — CERO ABSOLUTO: anticipation → a sphere of absolute cold BURSTS
    // from you and flash-freezes everything at once (heavy slow-mo beat) →
    // the field collapses inward and SHATTERS. Escalating, Goro-style. ===
    this.slots.e = {
      name: 'Cero Absoluto', cd: 10, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = _v.set(c.controller.position.x, gY(c, c.controller.position.x, c.controller.position.z), c.controller.position.z).clone();
        const ch = c.controller.chest.clone();
        const R = 16;
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 1.4);
        // --- anticipation: the air crystallizes around you ---
        c.camera.addShake(0.16); flash(c, 0.12, TEAL);
        c.vfx.flipbook(ch.clone(), { kind: 'magic', size: 6, life: 0.4, color: TEAL });
        c.vfx.burst(ch.clone().add(_v.set(0, 0.5, 0)), { count: 26, color: 0xffffff, color2: FROST, tile: 5, speed: 3, size: 0.32, life: 0.3, gravity: 0, drag: 6, dir: _up.clone().negate(), cone: 2 });
        c.vfx.decal(gp.clone(), { kind: 'frost', radius: 4, life: 4, groundY: gp.y });
        // --- the BURST (hero beat) ---
        this.schedule(0.2, () => {
          slow(c, 0.28, 0.22); flash(c, 0.5, FROST); c.combat.hitstop(0.14); c.camera.addShake(1.2);
          c.vfx.flipbook(ch.clone(), { kind: 'impact', size: 26, life: 0.55, color: 0xffffff });
          c.vfx.dome(gp.clone(), { radius: R, life: 0.7, color: 0xffffff });
          this.schedule(0.12, () => c.vfx.dome(gp.clone(), { radius: R + 5, life: 0.6, color: FROST }));
          c.vfx.waterShock(gp.clone(), { maxRadius: R + 3, life: 1.0, color: ICE, foam: 0xffffff, groundY: gp.y });
          c.vfx.crack(gp.clone(), { radius: R, count: 14, life: 3.5, ground: true, color: FROST });
          c.vfx.decal(gp.clone(), { kind: 'frost', radius: R, life: 4, groundY: gp.y });
          for (let i = 0; i < 4; i++) this.schedule(i * 0.05, () => c.vfx.ring(gp.clone(), { color: i % 2 ? 0xffffff : FROST, radius: R * (0.4 + i * 0.2), life: 0.45, thickness: 0.9 }));
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * 6.283 + 0.6;
            const p = gp.clone().add(_v.set(Math.cos(a) * R * 0.8, 0, Math.sin(a) * R * 0.8)); p.y = gY(c, p.x, p.z);
            this.schedule(0.05 + i * 0.03, () => iceSpike(c, p, 3 + Math.random() * 3, { cluster: false, radius: 0.75, tilt: 0.2, lean: _v.set(Math.cos(a), 0, Math.sin(a)).clone(), hold: 3.5 }));
          }
          // freeze everything, at once
          const seen = new Set();
          for (const t of c.combat.enemiesInRadius(gp, R)) {
            if (seen.has(t)) continue; seen.add(t);
            const k = Math.max(0.35, 1 - t.center.distanceTo(gp) / R * 0.6);
            const dmg = Math.round(60 * k);
            t.velocity.set(0, 0, 0);
            t.takeHit({ damage: dmg, dir: null, knockback: 3, up: 1, stun: 3 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), dmg);
            c.combat.applyStatus(t, 'chill', { stacks: 3, duration: 8, maxStacks: 3 });
            c.vfx.encase(() => t.center.clone(), { size: Math.max(1.5, t.radius * 1.6), hold: 3.5, color: ICE });
          }
        });
        // --- COLLAPSE + SHATTER ---
        this.schedule(0.62, () => {
          flash(c, 0.32, PALE); c.combat.hitstop(0.1); c.camera.addShake(1.0);
          for (let i = 0; i < 3; i++) this.schedule(i * 0.04, () => c.vfx.ring(gp.clone(), { color: i % 2 ? PALE : FROST, radius: R * (1 - i * 0.3), life: 0.3, thickness: 1.0 }));
          c.vfx.flipbook(gp.clone().add(_up), { kind: 'shock', size: R * 1.6, life: 0.5, color: 0xffffff });
          c.vfx.burst(gp.clone().add(_up), { count: 110, color: 0xffffff, color2: _ICE_BODY, tile: 3, speed: 26, size: 0.44, life: 0.7, gravity: 6, drag: 1.5 });
          shatterFrozen(c, { center: gp.clone(), radius: R, baseDmg: 80 });
        });
        // --- aftermath: a frozen field ---
        c.controller._slick = 2.5;
        this.schedule(0.7, () => c.vfx.hazard(gp.clone(), {
          kind: 'frost', radius: R * 0.85, duration: 3.5, groundY: gp.y,
          onTick: (ctr, rr) => {
            for (const t of c.combat.enemiesInRadius(ctr, rr)) { t.takeHit({ damage: 3, dir: null, knockback: 0, up: 0, stun: 0 }); c.combat.applyStatus(t, 'chill', { stacks: 1, duration: 2, maxStacks: 3 }); }
            c.vfx.burst(ctr.clone().add(_v.set((Math.random() - 0.5) * rr, 5, (Math.random() - 0.5) * rr)), { count: 2, color: 0xffffff, color2: FROST, tile: 0, speed: 1, size: 0.35, life: 1.2, gravity: 5, drag: 1 });
          }
        }));
      }
    };

    // === C — ARPÓN DE ESCARCHA: fire an ice harpoon on a frost line. Hits
    // TERRAIN → zip yourself to it (searing frost trail, crater on arrival).
    // Hits an ENEMY → yank them to you, frozen. Grapple mobility. ===
    this.slots.f = {
      name: 'Arpón de Escarcha', cd: 5, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const d = c.aimDir.clone().normalize();
        const hand0 = c.controller.chest.clone().addScaledVector(d, 0.6);
        const RANGE = 46, SPD = 150;
        c.vfx.flipbook(hand0.clone(), { kind: 'muzzle', size: 3, life: 0.13, color: PALE });
        c.vfx.burst(hand0.clone(), { count: 10, color: 0xffffff, color2: FROST, tile: 3, speed: 12, size: 0.24, life: 0.16, gravity: 0, drag: 6, dir: d, cone: 0.4 });
        c.camera.addShake(0.1);
        // the harpoon head
        const harp = new THREE.Group();
        harp.add(new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.7, 6, 1), new THREE.MeshToonMaterial({ color: _ICE_BODY, emissive: new THREE.Color(_ICE_CORE).multiplyScalar(0.3), flatShading: true })));
        harp.add(new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.2, 6, 1), new THREE.MeshBasicMaterial({ color: FROST, transparent: true, opacity: 0.24, blending: THREE.AdditiveBlending, depthWrite: false })));
        harp.quaternion.setFromUnitVectors(_up, d);
        harp.position.copy(hand0);
        c.scene.add(harp);
        const hg0 = harp.children[0].geometry, hg1 = harp.children[1].geometry, hm0 = harp.children[0].material, hm1 = harp.children[1].material;
        const disposeHarp = () => { c.scene.remove(harp); hg0.dispose(); hg1.dispose(); hm0.dispose(); hm1.dispose(); };
        // taut frost line, hand -> harpoon, redrawn each frame
        c.vfx.beam(() => c.controller.chest.clone().addScaledVector(c.forwardFlat, 0.5), () => harp.position.clone().sub(c.controller.chest).normalize(), { length: RANGE, radius: 0.13, life: 0.5, color: DEEP, core: PALE });

        let travelled = 0, resolved = false;
        const fireHarp = () => {
          travelled += SPD / 60;
          harp.position.copy(hand0).addScaledVector(d, travelled);
          harp.rotateOnAxis(_up, 0.6);
          c.vfx.burst(harp.position.clone(), { count: 3, color: 0xffffff, color2: FROST, tile: 0, speed: 3, size: 0.3, life: 0.26, gravity: 2, drag: 2 });
          const foe = c.combat.enemiesInRadius(harp.position, 2.2).find((t) => !t.dead);
          const gh = gY(c, harp.position.x, harp.position.z);
          const hitGround = harp.position.y <= gh + 0.3;
          if (!resolved && (foe || hitGround || travelled >= RANGE)) {
            resolved = true;
            if (foe) {
              // YANK the enemy in
              const to = c.controller.chest.clone().sub(foe.center).setY(0.1).normalize();
              if (foe.impulse) foe.impulse.addScaledVector(to, 60 / (foe.mass || 1));
              foe.velocity && foe.velocity.copy(to).multiplyScalar(26);
              foe.takeHit({ damage: 20, dir: to, knockback: 4, up: 4, stun: 0.7 });
              c.combat.hooks?.onDamageNumber?.(foe.center.clone(), 20);
              c.combat.applyStatus(foe, 'chill', { stacks: 2, duration: 5, maxStacks: 3 });
              c.vfx.encase(() => foe.center.clone(), { size: Math.max(1.4, foe.radius * 1.5), hold: 1.2, color: ICE });
              iceHit(c, foe.center.clone(), { size: 8, ground: false, shards: 16 });
              c.combat.hitstop(0.08); c.camera.addShake(0.4);
              disposeHarp();
            } else {
              // ZIP to the anchor
              const anchor = harp.position.clone(); anchor.y = Math.max(gh, gh) + 0.05;
              disposeHarp();
              c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.6);
              const start = c.controller.position.clone();
              const zipDur = 0.1 + start.distanceTo(anchor) * 0.004;   // fast, but scales with the long reach
              let zt = 0;
              const zip = () => {
                zt += 1 / 60;
                const kk = Math.min(1, zt / zipDur);
                const p = start.clone().lerp(anchor, kk * kk);
                c.controller.position.copy(p);
                c.controller.velocity.set(0, 0, 0);
                c.vfx.burst(c.controller.chest.clone(), { count: 5, color: 0xffffff, color2: FROST, tile: 0, speed: 6, size: 0.3, life: 0.25, gravity: 0, drag: 4, dir: d.clone().negate(), cone: 1.4 });
                if (kk >= 1) {
                  c.controller.velocity.copy(d).multiplyScalar(4); c.controller.velocity.y = 4;
                  iceHit(c, anchor.clone(), { size: 12, decal: 3, shards: 22, spikes: 2 });
                  c.vfx.crack(anchor.clone(), { radius: 5, count: 8, life: 2.5, ground: true, color: FROST });
                  c.combat.areaStrike(anchor, { radius: 5.5, damage: 26, knockback: 22, up: 8, stun: 0.4, color: ICE, shake: 0.5, onHitTarget: (t) => c.combat.applyStatus(t, 'chill', { stacks: 2, duration: 5, maxStacks: 3 }) });
                  return;
                }
                requestAnimationFrame(zip);
              };
              zip();
            }
            return;
          }
          if (!resolved) requestAnimationFrame(fireHarp);
        };
        this.schedule(0, fireHarp);
      }
    };

    // === V — DIAMOND DUST (img 2 + 4 + img 1 "4"): you rise; a swirling
    // maelstrom forms overhead and a RAIN of colossal ice crystals falls all
    // around a huge zone; then the whole ground SHATTERS — spikes erupt along
    // the crack lines and everyone left is frozen solid. ===
    this.slots.v = {
      name: 'Diamond Dust', cd: 16, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = _v.set(c.controller.position.x, gY(c, c.controller.position.x, c.controller.position.z), c.controller.position.z).clone();
        const R = 18;
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 2.0);
        c.controller.velocity.y = 13;
        slow(c, 0.3, 0.42); flash(c, 0.3, PALE); c.camera.addShake(0.6);
        c.vfx.storm(gp.clone(), { radius: R, height: 30, duration: 3, color: DEEP });
        c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(24)), { kind: 'energyball', size: 18, life: 1.0, color: DEEP, rise: 0.8 });
        for (let i = 0; i < 3; i++) this.schedule(i * 0.08, () => c.vfx.ring(gp.clone(), { color: i % 2 ? PALE : FROST, radius: R * (0.5 + i * 0.28), life: 0.5, thickness: 0.7 }));
        c.vfx.decal(gp.clone(), { kind: 'frost', radius: R * 0.8, life: 5, groundY: gp.y });
        // --- RAIN of colossal crystals (fast) ---
        for (let w = 0; w < 18; w++) this.schedule(0.15 + w * 0.055, () => {
          const a = Math.random() * 6.283, rr = Math.sqrt(Math.random()) * R;
          const land = gp.clone().add(_v.set(Math.cos(a) * rr, 0, Math.sin(a) * rr)); land.y = gY(c, land.x, land.z);
          const H = 7 + Math.random() * 7;
          const geo = new THREE.ConeGeometry(0.6 + Math.random() * 0.5, H, 5, 1);
          const m = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ color: _ICE_BODY, emissive: new THREE.Color(_ICE_BODY).multiplyScalar(0.18), transparent: true, opacity: 0.95, flatShading: true }));
          m.rotation.set(Math.PI + (Math.random() - 0.5) * 0.3, Math.random() * 6.28, (Math.random() - 0.5) * 0.3);
          m.position.set(land.x, land.y + 34, land.z);
          c.scene.add(m);
          let ft = 0;
          const drop = () => {
            ft += 1 / 60;
            m.position.y = land.y + 34 - (ft / 0.2) ** 2 * 34;
            if (m.position.y <= land.y + H * 0.28) {
              c.scene.remove(m); geo.dispose(); m.material.dispose();
              c.vfx.burst(land.clone(), { count: 18, color: 0xd6f4f4, color2: 0x4fb8d8, tile: 0, speed: 14, size: 0.32, life: 0.45, gravity: 16, drag: 1.4, dir: _up, cone: 1.8 });
              iceSpike(c, land.clone(), H * 0.8, { tilt: 0.06 + Math.random() * 0.12, lean: _v.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize().clone(), radius: 1.0, hold: 2.5, shatter: true });
              c.combat.areaStrike(land, { radius: 3.2, damage: 30, knockback: 10, up: 8, stun: 0.3, color: ICE, silent: w % 2 === 1, onHitTarget: (t) => c.combat.applyStatus(t, 'chill', { stacks: 2, duration: 5 }) });
              c.camera.addShake(0.1);
              return;
            }
            requestAnimationFrame(drop);
          };
          drop();
        });
        // --- ground SHATTER — spikes from radiating cracks + mass freeze ---
        this.schedule(1.5, () => {
          const g2 = c.controller.position.clone(); g2.y = gY(c, g2.x, g2.z);
          c.controller.velocity.y = -6;
          slow(c, 0.3, 0.3); flash(c, 0.55, PALE); c.combat.hitstop(0.15); c.camera.addShake(1.7);
          c.vfx.dome(g2.clone(), { radius: R + 3, life: 0.9, color: FROST });
          c.vfx.crack(g2.clone(), { radius: R, count: 10, life: 3.5, ground: true, color: FROST });
          for (let arm = 0; arm < 6; arm++) {
            const a = (arm / 6) * 6.283;
            for (let s = 1; s <= 3; s++) this.schedule((arm * 0.6 + s) * 0.04, () => {
              const p = g2.clone().add(_v.set(Math.cos(a) * s * (R / 3), 0, Math.sin(a) * s * (R / 3))); p.y = gY(c, p.x, p.z);
              iceSpike(c, p, 3 + Math.random() * 6, { tilt: 0.1, lean: _v.set(Math.cos(a), 0, Math.sin(a)).clone(), radius: 0.9, hold: 3, cluster: s === 1 });
            });
          }
          const seen = new Set();
          for (let ww = 0; ww < 6; ww++) this.schedule(ww * 0.04, () => {
            const rr = (ww + 1) / 6 * R;
            c.vfx.ring(g2.clone(), { color: ww % 2 ? PALE : FROST, radius: rr, life: 0.4, thickness: 0.8 });
            for (const t of c.combat.enemiesInRadius(g2, rr)) {
              if (seen.has(t)) continue; seen.add(t);
              const k = 1 - t.center.distanceTo(g2) / R * 0.5;
              t.takeHit({ damage: 120 * k, dir: null, knockback: 6, up: 4, stun: 3 });
              c.combat.hooks?.onDamageNumber?.(t.center.clone(), Math.round(120 * k));
              t.velocity.set(0, 0, 0);
              c.combat.applyStatus(t, 'chill', { stacks: 3, duration: 6, maxStacks: 3 });
              c.vfx.encase(() => t.center.clone(), { size: Math.max(1.4, t.radius * 1.5), hold: 3, color: ICE });
            }
          });
          this.schedule(0.3, () => shatterFrozen(c, { center: g2.clone(), radius: R, baseDmg: 80 }));
          c.vfx.hazard(g2.clone(), {
            kind: 'frost', radius: R * 0.85, duration: 5, groundY: g2.y,
            onTick: (ctr, rr) => { for (const t of c.combat.enemiesInRadius(ctr, rr)) { t.takeHit({ damage: 4, dir: null, knockback: 0, up: 0, stun: 0 }); c.combat.applyStatus(t, 'chill', { stacks: 2, duration: 3 }); } }
          });
        });
      }
    };

    // === T — AVALANCHA CELESTIAL (new): point ANYWHERE on the ground — a
    // colossal snowball is wrenched down out of the sky onto the aimed spot and
    // detonates in a white-out: crater, a crown of spikes, a rolling freeze
    // wave that flash-freezes the core and hurls the rest away. ===
    this.slots.ult = {
      name: 'Avalancha Celestial', cd: 24, _t: 0,
      cast: (c) => {
        c.pose('raise');
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.6);
        // --- aimed ground point: intersect the cursor ray with the ground, then
        //     snap Y to the real terrain. Any spot up to ~60 m; if you aim at
        //     the sky it drops 28 m ahead. Always at least 5 m from you, pushed
        //     along your facing (never on top of you). ---
        const chest = c.controller.chest.clone();
        const foot = c.controller.position.clone(); foot.y = 0;   // compare on the XZ plane
        const fwd = c.forwardFlat.clone();
        const dir = c.aimDir.clone().normalize();
        const footY = gY(c, foot.x, foot.z);
        let gp;
        if (dir.y < -0.05) {
          const t = THREE.MathUtils.clamp((chest.y - footY) / -dir.y, 4, 60);
          gp = chest.clone().addScaledVector(dir, t); gp.y = 0;
        } else {
          gp = foot.clone().addScaledVector(fwd, 28); gp.y = 0;
        }
        // minimum stand-off — keep the blast (and the spike crown) OFF the caster
        if (gp.distanceTo(foot) < 12) gp.copy(foot).addScaledVector(fwd, 12);
        gp.y = gY(c, gp.x, gp.z);
        const R = 14;

        // --- telegraph: landing reticle + a shaft of light punched skyward ---
        flash(c, 0.12, PALE); c.camera.addShake(0.2);
        c.vfx.decal(gp.clone(), { kind: 'frost', radius: R, life: 5, groundY: gp.y });
        c.vfx.beam(() => gp.clone(), () => _up.clone(), { length: 48, radius: 0.9, life: 0.9, color: DEEP, core: PALE });
        for (let i = 0; i < 4; i++) this.schedule(i * 0.09, () => c.vfx.ring(gp.clone(), { color: i % 2 ? 0xffffff : FROST, radius: R * (0.4 + i * 0.2), life: 0.4, thickness: 0.7 }));
        c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(46)), { kind: 'energyball', size: 16, life: 0.7, color: PALE });

        // --- the snowball: prefer the loaded GLB (models/snowball.glb, already
        //     re-skinned with the toon-ice material in Game._loadModels), else a
        //     procedural lumpy ice ball. Spawned high, freefalls onto the spot. ---
        let grp, _dispose = null;
        if (this._snowballMesh) {
          grp = this._snowballMesh.clone();
        } else {
          grp = new THREE.Group();
          const bg = new THREE.IcosahedronGeometry(7.5, 2);
          { const a = bg.attributes.position; for (let i = 0; i < a.count; i++) { const j = 0.82 + Math.random() * 0.36; a.setXYZ(i, a.getX(i) * j, a.getY(i) * j, a.getZ(i) * j); } bg.computeVertexNormals(); }
          const bmesh = new THREE.Mesh(bg, new THREE.MeshToonMaterial({ color: 0xffffff, emissive: new THREE.Color(PALE).multiplyScalar(0.25), flatShading: true }));
          const shellG = new THREE.IcosahedronGeometry(8.8, 1);
          const shell = new THREE.Mesh(shellG, new THREE.MeshBasicMaterial({ color: FROST, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
          const coreG = new THREE.IcosahedronGeometry(4.2, 1);
          const core = new THREE.Mesh(coreG, new THREE.MeshToonMaterial({ color: _ICE_CORE, emissive: new THREE.Color(_ICE_CORE).multiplyScalar(0.35), flatShading: true }));
          grp.add(bmesh, shell, core);
          _dispose = () => { bg.dispose(); shellG.dispose(); coreG.dispose(); bmesh.material.dispose(); shell.material.dispose(); core.material.dispose(); };
        }
        const startY = gp.y + 44;
        grp.position.set(gp.x, startY, gp.z);
        c.scene.add(grp);

        const boom = () => {
          flash(c, 0.6, PALE); slow(c, 0.18, 0.34); c.combat.hitstop(0.16); c.camera.addShake(2.6);
          c.vfx.flipbook(gp.clone().add(_up), { kind: 'impact', size: 28, life: 0.6, color: 0xffffff });
          c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(1.5)), { kind: 'shock', size: 22, life: 0.4, color: PALE });
          c.vfx.dome(gp.clone(), { radius: R + 4, life: 0.8, color: 0xffffff });
          c.vfx.crack(gp.clone(), { radius: R * 0.85, count: 10, life: 3.5, ground: true, color: FROST });
          // billowing snow — three drifting waves
          for (let w = 0; w < 3; w++) this.schedule(w * 0.07, () => {
            for (let i = 0; i < 12; i++) {
              const a = (i / 12) * 6.283 + w;
              c.vfx.burst(gp.clone().add(_v.set(Math.cos(a) * (2 + w), 0.4, Math.sin(a) * (2 + w))),
                { count: 5, color: 0xffffff, color2: FROST, tile: w === 1 ? 0 : 2, speed: 20 - w * 4, size: 1.4 - w * 0.2, life: 0.9 + w * 0.2, gravity: -1.5, drag: 1.2, dir: _v.set(Math.cos(a), 0.18, Math.sin(a)).clone(), cone: 0.4 });
            }
          });
          // a crown of spikes bursting outward + a spire at the point of impact
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * 6.283;
            const p = gp.clone().add(_v.set(Math.cos(a) * R * 0.72, 0, Math.sin(a) * R * 0.72)); p.y = gY(c, p.x, p.z);
            this.schedule(i * 0.025, () => iceSpike(c, p, 2.6 + Math.random() * 3.4, { tilt: 0.32, lean: _v.set(Math.cos(a), 0, Math.sin(a)).clone(), radius: 0.9, hold: 3, shards: 8, shardSpeed: 11 }));
          }
          iceSpike(c, gp.clone(), 8, { radius: 1.4, hold: 3.5, cluster: true, shards: 12, shardSpeed: 12 });
          // rolling freeze shockwave — concentric sweeps, distance-scaled
          const seen = new Set();
          for (let ww = 0; ww < 5; ww++) this.schedule(ww * 0.05, () => {
            const rr = (ww + 1) / 5 * R;
            c.vfx.ring(gp.clone(), { color: ww % 2 ? 0xffffff : FROST, radius: rr, life: 0.4, thickness: 0.9 });
            for (const t of c.combat.enemiesInRadius(gp, rr)) {
              if (seen.has(t)) continue; seen.add(t);
              const kk = Math.max(0.25, 1 - t.center.distanceTo(gp) / R * 0.62);
              const dmg = Math.round((ww === 0 ? 130 : 90) * kk);
              t.takeHit({ damage: dmg, dir: _v.set(t.center.x - gp.x, 0, t.center.z - gp.z).normalize().clone(), knockback: ww === 0 ? 12 : 34, up: ww === 0 ? 6 : 12, stun: ww === 0 ? 2.6 : 0.7 });
              c.combat.hooks?.onDamageNumber?.(t.center.clone(), dmg);
              c.combat.applyStatus(t, 'chill', { stacks: 3, duration: 6, maxStacks: 3 });
              if (ww === 0) { t.velocity.set(0, 0, 0); c.vfx.encase(() => t.center.clone(), { size: Math.max(1.4, t.radius * 1.5), hold: 2.6, color: ICE }); }
            }
          });
          this.schedule(0.28, () => shatterFrozen(c, { center: gp.clone(), radius: R, baseDmg: 90 }));
          // aftermath — a lingering blizzard field that keeps chilling
          c.vfx.storm(gp.clone(), { radius: R * 0.9, height: 16, duration: 4, color: PALE });
          c.vfx.hazard(gp.clone(), {
            kind: 'frost', radius: R * 0.8, duration: 4, groundY: gp.y,
            onTick: (ctr, rr) => {
              for (let i = 0; i < 3; i++) { const a = Math.random() * 6.283, d2 = Math.random() * rr; c.vfx.burst(ctr.clone().add(_v.set(Math.cos(a) * d2, 5 + Math.random() * 3, Math.sin(a) * d2)), { count: 2, color: 0xffffff, color2: FROST, tile: 0, speed: 1, size: 0.35, life: 1.2, gravity: 5, drag: 1 }); }
              for (const t of c.combat.enemiesInRadius(ctr, rr)) { t.takeHit({ damage: 4, dir: null, knockback: 0, up: 0, stun: 0 }); c.combat.applyStatus(t, 'chill', { stacks: 2, duration: 3 }); }
            }
          });
        };

        let ft = 0; const FALL = 0.46;
        const fall = () => {
          ft += 1 / 60;
          const k = Math.min(1, ft / FALL);
          grp.position.y = startY - Math.pow(k, 1.7) * (startY - gp.y - 3.0);   // accelerating, but visible the whole way
          grp.rotation.x += 0.16; grp.rotation.y += 0.1;
          if (((ft * 60) | 0) % 2 === 0)                                        // trail every other frame
            c.vfx.burst(grp.position.clone(), { count: 7, color: 0xffffff, color2: FROST, tile: 2, speed: 5, size: 2.3, life: 0.7, gravity: -1, drag: 1.3, dir: _up, cone: 1.9 });
          if (k >= 1) {
            c.scene.remove(grp);
            if (_dispose) _dispose();   // model clones share cached geo/mats — leave them
            boom();
            return;
          }
          requestAnimationFrame(fall);
        };
        this.schedule(0.32, fall);
      }
    };
  }

  onMelee(c) {
    for (const t of c.combat.nearestEnemies(c.controller.position, 4, 4.2)) c.combat.applyStatus(t, 'chill', { stacks: 1, duration: 3 });
  }
}

/* ================================================================ *
 *  LEGENDARIO — Gomu Gomu (mítica). Zoan: Gear 5. Ult: Bajrang Gun.
 * ================================================================ */
const G5W = 0xffffff, G5WARM = 0xffe6cf, G5PINK = 0xff9ec6, G5SUN = 0xffd884;

export class GomuGomu extends DevilFruit {
  constructor() {
    super('Gomu Gomu', 0xffffff, {
      rarity: 'mitica', type: 'zoan',
      passive: 'Cuerpo de goma: inmune a golpes contundentes y rayos · rebota · el DESPERTAR (Gear 5) libera un juego totalmente nuevo de habilidades'
    });
    this.transformDmg = 2.1; this.transformSpeed = 1.55; this.transformRegen = 10; this.jumpMul = 1.25;
    this.noAura = true;   // onForm spawns its own white liberation aura + cloud crown
    this._g5on = false;   // drives the persistent Gear-5 ensemble loop

    // Slots dispatch by form: same key, a whole different move in Gear 5.
    this.slots.q = { name: 'Impulso de Goma', cd: 2.4, _t: 0, cast: (c) => this.transformed ? this._grabGround(c) : this._propulsion(c) };
    this.slots.e = { name: 'Jet Gatling', cd: 5.5, _t: 0, cast: (c) => this.transformed ? this._taffy(c) : this._jetGatling(c) };
    this.slots.f = { name: 'Gear 5', transform: true };
    this.slots.v = { name: 'Bazuca de Goma', cd: 11, _t: 0, cast: (c) => this.transformed ? this._rocket(c) : this._bazooka(c) };
    this.slots.ult = { name: 'Bola de Goma', cd: 24, _t: 0, cast: (c) => this.transformed ? this._bajrang(c) : this._rubberBall(c) };
  }

  /* pick a lock-on target that INCLUDES dummies (enemiesInRadius), scored by
     how in-front + how near — a close foe wins even a bit off-aim. */
  _target(c, from, dir, range = 24, cone = 0.35) {
    let best = null, bs = -1;
    for (const t of c.combat.enemiesInRadius(from, range)) {
      const to = t.center.clone().sub(from); const dist = Math.max(0.6, to.length());
      const dot = to.multiplyScalar(1 / dist).dot(dir);
      if (dot < cone && dist > 7) continue;
      const s = (dot + 1) * 2 - dist * 0.05;
      if (s > bs) { bs = s; best = t; }
    }
    return best;
  }

  // ============================ NORMAL (no Gear 5) ============================
  // Z — Impulso de Goma: BOTH hands rocket out on elastic bands and grab the
  // first thing they touch — an enemy, a wall, or just the ground — then SNAP
  // taut and hurl you forward like a grappling-hook propulsion. Fast mobility
  // gap-closer. (Gear 5 swaps this slot for Agarre de Tierra.)
  _propulsion(c) {
    c.pose('thrust');
    const d = c.aimDir.clone().normalize();
    const RANGE = 60, SPD = 150;   // reaches much farther across the map
    const chest = () => c.controller.chest.clone();
    const hand0 = chest().addScaledVector(d, 0.5);
    const rt = _v.set(d.z, 0, -d.x).normalize().clone();
    c.vfx.flipbook(hand0.clone(), { kind: 'muzzle', size: 3, life: 0.12, color: 0xffffff });
    c.vfx.burst(hand0.clone(), { count: 10, color: 0xffffff, color2: 0xffcf9a, tile: 3, speed: 12, size: 0.22, life: 0.16, gravity: 0, drag: 6, dir: d, cone: 0.35 });
    c.camera.addShake(0.12);
    // twin elastic fists fly out side by side
    const fL = g5Fist(0.5), fR = g5Fist(0.5);
    c.scene.add(fL); c.scene.add(fR);
    let travelled = 0, resolved = false;
    const fly = () => {
      travelled += SPD / 60;
      const p = hand0.clone().addScaledVector(d, travelled);
      fL.position.copy(p).addScaledVector(rt, -0.4);
      fR.position.copy(p).addScaledVector(rt, 0.4);
      fL.rotation.y += 0.5; fR.rotation.y += 0.5;
      // taut elastic bands, redrawn every frame
      c.vfx.stretch(() => chest().addScaledVector(rt, -0.35), fL.position.clone().sub(chest()).normalize(), { length: chest().distanceTo(fL.position), radius: 0.1, color: 0xffe0c8, life: 0.06 });
      c.vfx.stretch(() => chest().addScaledVector(rt, 0.35), fR.position.clone().sub(chest()).normalize(), { length: chest().distanceTo(fR.position), radius: 0.1, color: 0xffe0c8, life: 0.06 });
      c.vfx.burst(p.clone(), { count: 2, color: 0xffe0c0, color2: 0xff9a6a, tile: 0, speed: 3, size: 0.22, life: 0.2, gravity: 0, drag: 3 });
      const foe = c.combat.enemiesInRadius(p, 2.3).find((t) => !t.dead);
      const gh = gY(c, p.x, p.z);
      const hitGround = p.y <= gh + 0.4;
      if (!resolved && (foe || hitGround || travelled >= RANGE)) {
        resolved = true;
        c.scene.remove(fL); c.scene.remove(fR); fL.userData.dispose(); fR.userData.dispose();
        const anchor = foe ? foe.center.clone() : _v.set(p.x, gh, p.z).clone();
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.6);
        const start = c.controller.position.clone();
        const stop = foe ? anchor.clone().addScaledVector(d, -1.6) : anchor.clone();   // stop just short of an enemy
        const zipDur = 0.08 + start.distanceTo(stop) * 0.0035;
        let zt = 0;
        const zip = () => {
          zt += 1 / 60;
          const kk = Math.min(1, zt / zipDur);
          const pp = start.clone().lerp(stop, kk * kk);
          c.controller.position.copy(pp);
          c.controller.velocity.set(0, 0, 0);
          if ((zt * 60 | 0) % 2 === 0) c.vfx.burst(chest(), { count: 3, color: 0xffffff, color2: 0xffcf9a, tile: 2, speed: 5, size: 0.3, life: 0.25, gravity: 0, drag: 3, dir: d.clone().negate(), cone: 1.2 });
          if (kk >= 1) {
            c.controller.velocity.copy(d).multiplyScalar(foe ? 10 : 14); c.controller.velocity.y = foe ? 6 : 3;
            c.combat.hitstop(0.05); c.camera.addShake(0.5);
            if (foe) {
              foe.takeHit({ damage: 32, dir: d.clone().setY(0.2).normalize(), knockback: 30, up: 10, stun: 0.5 });
              c.combat.hooks?.onDamageNumber?.(foe.center.clone(), 32);
              c.vfx.flipbook(foe.center.clone(), { kind: 'impact', size: 10, life: 0.4, color: 0xffcf9a });
            } else {
              c.vfx.flipbook(anchor.clone().add(_up), { kind: 'shock', size: 8, life: 0.35, color: 0xffe0c0 });
              c.vfx.burst(anchor.clone(), { count: 14, color: 0xffe0c0, color2: 0xff9a6a, tile: 2, speed: 8, size: 0.35, life: 0.4, gravity: 4, drag: 1.6, dir: _up, cone: 1.6 });
            }
            return;
          }
          requestAnimationFrame(zip);
        };
        zip();
        return;
      }
      if (!resolved) requestAnimationFrame(fly);
    };
    this.schedule(0, fly);
  }

  // X (normal) — Jet Gatling (Gear 2 flavour): built on the same production as
  // the Bazuca (steam wind-up, visible stretchy FISTS punching out, a staggered
  // ground-destruction finisher) — but it's a RAPID BARRAGE, not one big ram,
  // and stays lighter/smaller than the Bazuca throughout.
  _jetGatling(c) {
    c.pose('thrust');
    const d = c.forwardFlat.clone();
    const chest = () => c.controller.chest.clone();
    c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.6);
    c.controller.velocity.addScaledVector(d, 8);
    c.camera.addShake(0.14); flash(c, 0.08, 0xffe6cf);
    // wind-up — steam vents off both arms
    c.vfx.flipbook(chest(), { kind: 'smoke', size: 5, life: 0.9, color: 0xffd9c4, additive: false, rise: 1.6 });
    for (const s of [-1, 1]) c.vfx.stretch(() => chest().add(_v.set(s * 0.4, 0, 0)), d.clone().negate(), { length: 2.4, radius: 0.28, color: 0xffd8c0, life: 0.1, fist: true });
    for (let i = 0; i < 8; i++) c.vfx.burst(chest(), { count: 3, color: 0xffe0c0, color2: 0xff9a6a, tile: 2, speed: 6, size: 0.5, life: 0.5, gravity: -2, drag: 1.6, dir: _up, cone: 2.4 });

    let n = 0; const total = 15;
    const jab = () => {
      const o = chest();
      const pd = d.clone().add(_v.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 0.5)).normalize();
      const last = n === total - 1;
      c.controller.velocity.addScaledVector(d, 1.2);
      c.combat.meleeStrike(o, pd, { arc: Math.PI * 0.55, range: 4.6, damage: last ? 42 : 9, knockback: last ? 30 : 3, up: last ? 10 : 0.4, stun: 0.12, hitstop: last ? 0.1 : 0.012, shake: last ? 0.4 : 0.03, color: 0xffd0a0 });
      // a real visible stretchy FIST jets out for every punch, not just a line
      c.vfx.stretch(() => o, pd, { length: last ? 6.5 : 4.8, radius: last ? 0.36 : 0.2, color: 0xffd8c0, life: 0.08, fist: true });
      if (n % 3 === 0) c.vfx.burst(o.clone().addScaledVector(pd, 2), { count: 4, color: 0xfff0e0, color2: 0xffb98a, tile: 3, speed: 10, size: 0.24, life: 0.25, gravity: 0, drag: 4, dir: pd, cone: 0.6 });
      if (last) {
        const hp = o.clone().addScaledVector(pd, 5.5);
        const gp = _v.set(hp.x, gY(c, hp.x, hp.z), hp.z).clone();
        flash(c, 0.3, 0xfff2e8); c.combat.hitstop(0.08); slow(c, 0.08, 0.45); c.camera.addShake(0.9);
        c.vfx.windGust(_v.set(o.x, gY(c, o.x, o.z), o.z).clone(), { dir: pd.clone(), length: 12, width: 5, life: 0.3, color: 0xffe6cf });
        c.vfx.flipbook(hp.clone(), { kind: 'impact', size: 16, life: 0.5, color: 0xffcf9a });
        for (let i = 0; i < 3; i++) this.schedule(i * 0.05, () => c.vfx.flipbook(hp.clone(), { kind: 'shock', size: 12 + i * 6, life: 0.42, color: i % 2 ? 0xffe0c0 : 0xffffff }));
        c.vfx.dome(hp.clone(), { radius: 8, life: 0.5, color: 0xffd0a0 });
        this.schedule(0.02, () => c.vfx.crack(gp, { radius: 10, count: 13, life: 1.9, ground: true, color: 0xffe0c0 }));
        this.schedule(0.04, () => c.vfx.shatter(gp, { radius: 9, count: 13, life: 2.4, groundY: gp.y, color: 0x3a2c22 }));
        for (let i = 0; i < 3; i++) { const fa = i / 3 * 6.283 + 0.5; c.vfx.fracture(gp, _v.set(Math.cos(fa), 0, Math.sin(fa)).clone(), { length: 11 + Math.random() * 5, width: 1.0, grow: 20, life: 1.9, color: 0xffe0c0, groundY: gp.y }); }
        c.vfx.burst(hp.clone().add(_up), { count: 45, color: 0xffffff, color2: 0xffcf9a, tile: 4, speed: 18, size: 0.4, life: 0.6, gravity: 5, drag: 1.5, dir: _up, cone: 2.0 });
        this.schedule(0.03, () => debrisRing(c, gp, 6, 14));
        c.combat.areaStrike(hp, { radius: 9, damage: 60, knockback: 42, up: 10, stun: 0.5, color: 0xffd0a0, shake: 0.6 });
      }
      if (++n < total) this.schedule(0.042, jab);
    };
    jab();
  }

  // V (normal) — Bazuca de Goma: haul both fists way back, then RAM a giant
  // two-handed palm-strike straight forward — a short lunge, a wall of wind and
  // a heavy blast where it lands. Close/mid range, horizontal, no sky drop.
  // (Gear 5 swaps this slot for Puño del Cielo / `_rocket`.)
  _bazooka(c) {
    c.pose('thrust');
    const d = c.forwardFlat.clone();
    const chest = () => c.controller.chest.clone();
    c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.8);
    c.camera.addShake(0.2); flash(c, 0.1, 0xffe6cf);
    // wind-up — both arms stretch back, small hop back
    for (const s of [-1, 1]) c.vfx.stretch(() => chest().add(_v.set(s * 0.5, 0, 0)), d.clone().negate(), { length: 6, radius: 0.4, color: 0xffd8c0, life: 0.16, fist: true });
    c.controller.velocity.addScaledVector(d, -4);
    c.combat.hitstop(0.04); slow(c, 0.06, 0.6);
    this.schedule(0.18, () => {
      const from = chest();
      const to = from.clone().addScaledVector(d, 20); to.y = gY(c, to.x, to.z) + 1.5;
      c.controller.velocity.set(d.x * 30, 4, d.z * 30);
      c.camera.addShake(0.6);
      c.vfx.windGust(_v.set(from.x, gY(c, from.x, from.z), from.z).clone(), { dir: d.clone(), length: 24, width: 8, life: 0.4, color: 0xffe6cf });
      for (const s of [-1, 1]) c.vfx.stretch(() => chest().add(_v.set(s * 0.55, 0, 0)), d.clone(), { length: 21, radius: 0.6, color: 0xffe0c8, life: 0.22, fist: true });
      c.vfx.beam(() => from, () => d.clone(), { length: 20, radius: 1.1, life: 0.18, color: 0xffd0a0, core: 0xffffff });
      const ep = _v.set(to.x, gY(c, to.x, to.z), to.z).clone();
      flash(c, 0.5, 0xfff2e8); c.combat.hitstop(0.14); slow(c, 0.14, 0.32); c.camera.addShake(2.2);
      c.vfx.flipbook(ep.clone().add(_up), { kind: 'impact', size: 20, life: 0.6, color: 0xffe6cf });
      for (let i = 0; i < 3; i++) this.schedule(i * 0.05, () => c.vfx.flipbook(ep.clone().add(_up), { kind: 'shock', size: 12 + i * 7, life: 0.45, color: i % 2 ? 0xffc888 : 0xffffff }));
      c.vfx.dome(ep.clone(), { radius: 10, life: 0.7, color: 0xffd0a0 });
      this.schedule(0.02, () => c.vfx.crack(ep.clone(), { radius: 12, count: 14, life: 2, ground: true, color: 0xffe0c0 }));
      this.schedule(0.05, () => c.vfx.shatter(ep.clone(), { radius: 10, count: 12, life: 2.6, groundY: ep.y, color: 0x3a2c22 }));
      for (let i = 0; i < 5; i++) this.schedule(0.03 + (i % 3) * 0.03, () => { const fa = i / 5 * 6.283 + 0.4; c.vfx.fracture(ep.clone(), _v.set(Math.cos(fa), 0, Math.sin(fa)).clone(), { length: 12 + Math.random() * 6, width: 1.1, grow: 24, life: 2, color: 0xffe0c0, groundY: ep.y }); });
      c.vfx.burst(ep.clone().add(_up), { count: 90, color: 0xffffff, color2: 0xffcf9a, tile: 4, speed: 24, size: 0.5, life: 0.9, gravity: 6, drag: 1.4, dir: _up, cone: 2.2 });
      this.schedule(0.04, () => debrisRing(c, ep.clone(), 8, 18));
      c.combat.areaStrike(ep, { radius: 12, damage: 95, knockback: 62, up: 14, stun: 1.0, color: 0xffe0c0, shake: 1.0 });
      c.combat.areaStrike(from.clone().addScaledVector(d, 10), { radius: 6, damage: 55, knockback: 44, up: 8, stun: 0.5, color: 0xffd0a0, silent: true });
    });
  }

  // T (normal) — Bola de Goma: your whole body balloons into a giant rubber
  // SPHERE for a few seconds. You stay in full control — W/A/S/D roll it around
  // exactly like normal walking, just heavier and faster — and anything it
  // rolls into gets crushed. Ends in a big bounce-slam. (Gear 5 swaps for
  // Bajrang Gun — this is the normal-form ult.)
  _rubberBall(c) {
    if (this._rolling) return;
    c.pose('raise');
    const DUR = 5.0, R = 3.6;
    c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.5);
    flash(c, 0.2, 0xffffff); c.camera.addShake(0.3);
    c.vfx.flipbook(c.controller.chest.clone(), { kind: 'shock', size: 8, life: 0.4, color: 0xffffff });
    c.vfx.burst(c.controller.chest.clone(), { count: 30, color: 0xffffff, color2: G5PINK, tile: 4, speed: 12, size: 0.5, life: 0.5, gravity: 2, drag: 1.8 });

    // ---- balloon into the ball ----
    this._rolling = true;
    c.character.root.visible = false;
    const geo = new THREE.SphereGeometry(R, 16, 12);
    const mat = new THREE.MeshToonMaterial({ color: 0xffffff, flatShading: true, emissive: 0x2a2a2a });
    const ball = new THREE.Mesh(geo, mat); ball.castShadow = true;
    const glowGeo = new THREE.SphereGeometry(R * 1.08, 12, 10);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false });
    ball.add(new THREE.Mesh(glowGeo, glowMat));
    const bandGeo = new THREE.TorusGeometry(R * 0.98, R * 0.045, 6, 20);
    const bandMat = new THREE.MeshBasicMaterial({ color: G5PINK, transparent: true, opacity: 0.55 });
    const band = new THREE.Mesh(bandGeo, bandMat); band.rotation.x = Math.PI / 2; ball.add(band);
    ball.position.copy(c.controller.position).add(_up.clone().multiplyScalar(R));
    c.scene.add(ball);
    ball.scale.setScalar(0.15);

    // ---- heavier, faster momentum while rolling (restored on end) ----
    const K = c.controller;
    const saved = { walkSpeed: K.walkSpeed, runSpeed: K.runSpeed, accel: K.accel, friction: K.friction, radius: K.radius };
    K.walkSpeed = 15; K.runSpeed = 21; K.accel = 46; K.friction = 3; K.radius = R * 0.85;

    const lastHit = new Map();
    let t = 0, growK = 0, done = false;
    const roll = () => {
      if (done) return;
      t += 1 / 60;
      growK = Math.min(1, growK + 1 / 12);
      ball.scale.setScalar(THREE.MathUtils.lerp(0.15, 1, growK * (2 - growK)));
      ball.position.set(K.position.x, K.position.y + R * ball.scale.x, K.position.z);
      const hs = Math.hypot(K.velocity.x, K.velocity.z);
      if (hs > 0.3) {
        const axis = _v.set(-K.velocity.z, 0, K.velocity.x).normalize().clone();
        ball.rotateOnWorldAxis(axis, (hs / R) * (1 / 60));
        if ((t * 60 | 0) % 4 === 0) c.vfx.burst(_v.set(K.position.x, gY(c, K.position.x, K.position.z) + 0.1, K.position.z).clone(), { count: 3, color: 0xe8e8e8, color2: 0xffffff, tile: 2, speed: 4, size: 0.4, life: 0.4, gravity: 3, drag: 1.8, dir: _up, cone: 1.4 });
      }
      // crush anything it rolls into
      for (const en of c.combat.enemiesInRadius(K.position, R + 0.7)) {
        const last = lastHit.get(en) || -1;
        if (t - last < 0.45) continue;
        lastHit.set(en, t);
        const away = _v.set(en.center.x - K.position.x, 0, en.center.z - K.position.z).normalize().clone();
        en.takeHit({ damage: 34, dir: away.setY(0.3).normalize(), knockback: 42, up: 12, stun: 0.4 });
        c.combat.hooks?.onDamageNumber?.(en.center.clone(), 34);
        c.camera.addShake(0.15);
        c.vfx.flipbook(en.center.clone(), { kind: 'shock', size: 6, life: 0.3, color: 0xffffff });
      }
      if (t < DUR) { requestAnimationFrame(roll); return; }
      end();
    };
    const end = () => {
      if (done) return; done = true; this._rolling = false;
      c.scene.remove(ball); geo.dispose(); mat.dispose(); glowGeo.dispose(); glowMat.dispose(); bandGeo.dispose(); bandMat.dispose();
      K.walkSpeed = saved.walkSpeed; K.runSpeed = saved.runSpeed; K.accel = saved.accel; K.friction = saved.friction; K.radius = saved.radius;
      c.character.root.visible = true;
      // ---- deflate: a big bounce-pop shockwave ----
      const gp = c.controller.position.clone(); gp.y = gY(c, gp.x, gp.z);
      flash(c, 0.5, 0xffffff); c.combat.hitstop(0.14); c.camera.addShake(1.8); slow(c, 0.12, 0.4);
      c.vfx.flipbook(gp.clone().add(_up), { kind: 'impact', size: 30, life: 0.6, color: 0xffffff });
      c.vfx.dome(gp.clone(), { radius: 16, life: 0.7, color: 0xffffff });
      for (let i = 0; i < 4; i++) this.schedule(i * 0.05, () => c.vfx.ring(gp.clone(), { color: i % 2 ? G5PINK : 0xffffff, radius: (i + 1) / 4 * 22, life: 0.6 }));
      c.vfx.burst(gp.clone().add(_up), { count: 90, color: 0xffffff, color2: G5PINK, tile: 4, speed: 18, size: 0.5, life: 0.65, gravity: 4, drag: 1.6, dir: _up, cone: 2.2 });
      c.combat.areaStrike(gp, { radius: 16, damage: 70, knockback: 48, up: 18, stun: 0.7, color: 0xffffff, silent: true, shake: 0.9 });
    };
    // end early if a fresh cast comes in and the timer somehow desyncs
    this.schedule(DUR + 0.3, end);
    roll();
  }

  // V (Gear 5) — Puño del Cielo: a CINEMATIC. Everyone near you freezes to watch,
  // the camera pulls out, a COLOSSAL hand descends from the sky — fingers splayed
  // — then CLENCHES and PRESSES the world flat: a massive explosion, radiating
  // fissures, a marching shockwave, and a grinding hold before it lifts off.
  _rocket(c) {
    c.pose('raise');
    const big = this.transformed;
    const gp = aimedGround(c, 65, big ? 12 : 10);   // travels to wherever you're aiming, up to 65 m out
    const R = big ? 22 : 16, PARA_R = big ? 26 : 20, HR = big ? 11 : 7.5, DMG = big ? 240 : 160;
    c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 2.4);
    c.camera.addShake(0.3); flash(c, 0.16, G5WARM);
    c.camera.cine({ dist: big ? 15 : 12, fov: big ? 58 : 60, focus: gp.clone().add(_up.clone().multiplyScalar(4)), focusMix: 0.6, spin: 1.1, pitchAdd: 0.12, inT: 0.3, holdT: 1.3, outT: 1.4 });
    // freeze every foe nearby so they watch it come down
    const frozen = [...c.combat.enemiesInRadius(c.controller.position, PARA_R)];
    for (const en of frozen) {
      if (en.velocity) en.velocity.set(0, 0, 0);
      en._stun = Math.max(en._stun || 0, 2.0);
      c.vfx.ring(_v.set(en.center.x, gY(c, en.center.x, en.center.z) + 0.1, en.center.z).clone(), { color: G5PINK, radius: 1.7, life: 0.4 });
    }
    const keep = { t: 0 };
    const holdFrozen = () => {
      keep.t += 1 / 30;
      for (const en of frozen) { if (!en || en.dead) continue; if (en.velocity) en.velocity.set(0, 0, 0); en._stun = Math.max(en._stun || 0, 0.4); }
      if (keep.t < 1.7) this.schedule(1 / 30, holdFrozen);
    };
    this.schedule(0.05, holdFrozen);
    // THE SHADOW — a dark disc on the ground that swells as the hand nears
    const shGeo = new THREE.CircleGeometry(1, 40); shGeo.rotateX(-Math.PI / 2);
    const shMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.0, depthWrite: false });
    const shadow = new THREE.Mesh(shGeo, shMat); shadow.position.set(gp.x, gp.y + 0.06, gp.z); c.scene.add(shadow);
    // landing telegraph
    c.vfx.decal(gp.clone(), { kind: 'crack', radius: R, life: 3, groundY: gp.y, color: 0xffe0c0 });
    for (let i = 0; i < 4; i++) this.schedule(i * 0.14, () => c.vfx.ring(gp.clone(), { color: i % 2 ? G5WARM : 0xffffff, radius: R * (0.4 + i * 0.2), life: 0.5 }));
    // THE HAND — starts high, fingers splayed
    const hand = g5Fist(HR);
    hand.rotation.x = Math.PI;                              // palm-down
    const startY = gp.y + (big ? 68 : 54);
    hand.position.set(gp.x, startY, gp.z);
    hand.scale.set(1.35, 1.35, 1.35);                       // "open hand" = spread wide
    c.scene.add(hand);
    slow(c, 0.5, 0.42);
    let t = 0;
    const DUR = 1.0;
    const fall = () => {
      t += 1 / 60;
      const k = Math.min(1, t / DUR);
      const drop = k < 0.55 ? k * 0.35 : 0.19 + Math.pow((k - 0.55) / 0.45, 2.6) * 0.81;   // ominous drift, then PLUNGE
      hand.position.y = startY - drop * (startY - gp.y - HR * 0.5);
      hand.rotation.y += 0.06;
      hand.scale.setScalar(THREE.MathUtils.lerp(1.35, 1.0, k * k));   // fingers clench as it closes in
      const h01 = 1 - (hand.position.y - gp.y) / (startY - gp.y);
      shMat.opacity = 0.05 + h01 * 0.4;
      shadow.scale.setScalar(THREE.MathUtils.lerp(HR * 3.4, HR * 1.15, h01));
      c.camera.addShake(0.04 + k * 0.5);
      if ((t * 60 | 0) % 2 === 0) c.vfx.burst(hand.position.clone(), { count: 5, color: 0xffffff, color2: G5WARM, tile: 2, speed: 5, size: 1.6, life: 0.5, gravity: 0, drag: 1.3 });
      if (k >= 1) {
        c.scene.remove(shadow); shGeo.dispose(); shMat.dispose();
        // ---- THE PRESS: colossal explosion ----
        flash(c, big ? 1.15 : 1.0, 0xfff2e8); slow(c, big ? 0.42 : 0.36, 0.22); c.combat.hitstop(big ? 0.34 : 0.28); c.camera.addShake(big ? 5.5 : 4.4, 1.5);
        c.vfx.flipbook(gp.clone().add(_up), { kind: 'impact', size: big ? 58 : 44, life: 0.9, color: 0xffe6cf });
        for (let i = 0; i < 6; i++) this.schedule(i * 0.05, () => c.vfx.flipbook(gp.clone().add(_up), { kind: 'shock', size: (big ? 26 : 20) + i * 11, life: 0.55, color: i % 2 ? G5WARM : 0xffffff }));
        c.vfx.dome(gp.clone(), { radius: R + 8, life: 1.2, color: G5WARM });
        c.vfx.shatter(gp.clone(), { radius: R, count: big ? 30 : 24, life: 3.5, groundY: gp.y, color: 0x3a2c22 });
        c.vfx.crack(gp.clone(), { radius: R + 4, count: big ? 32 : 24, life: 2.5, ground: true, color: 0xffe0c0 });
        for (let i = 0; i < (big ? 10 : 8); i++) {          // fissures rip outward from the palm
          const fa = (i / (big ? 10 : 8)) * 6.283 + Math.random() * 0.3;
          c.vfx.fracture(gp.clone(), _v.set(Math.cos(fa), 0, Math.sin(fa)).clone(), { length: R + Math.random() * 10, width: 1.5, grow: 28, life: 2.4, color: G5WARM, groundY: gp.y });
        }
        c.vfx.burst(gp.clone().add(_up), { count: big ? 200 : 150, color: 0xffffff, color2: G5WARM, tile: 4, speed: 30, size: 0.55, life: 1.0, gravity: 6, drag: 1.4, dir: _up, cone: 2.4 });
        debrisRing(c, gp.clone(), R * 0.75, 22);
        // the shockwave MARCHES out, each ring a damage pulse
        const seen = new Set();
        for (let w = 0; w < 9; w++) this.schedule(w * 0.05, () => {
          const rr = ((w + 1) / 9) * (R + 16);
          c.vfx.ring(gp.clone(), { color: w % 2 ? G5WARM : 0xffffff, radius: rr, life: 0.75, thickness: 0.9 });
          for (const en of c.combat.enemiesInRadius(gp, rr)) {
            if (seen.has(en)) continue; seen.add(en);
            const away = _v.set(en.center.x - gp.x, 0, en.center.z - gp.z).normalize().clone();
            en.takeHit({ damage: w === 0 ? DMG : 70, dir: away.setY(0.35).normalize(), knockback: w === 0 ? 70 : 48, up: 18, stun: 1.4 });
            c.combat.hooks?.onDamageNumber?.(en.center.clone(), w === 0 ? DMG : 70);
          }
        });
        c.combat.areaStrike(gp, { radius: R + 4, damage: DMG, knockback: 66, up: 18, stun: 1.5, color: G5WARM, shake: 1.6, silent: true });
        // ---- THE GRIND: the palm stays a beat, crushing, then shoves off ----
        let gt = 0;
        const grind = () => {
          gt += 1 / 30;
          hand.position.y = gp.y + HR * 0.5 + Math.sin(gt * 20) * 0.12;
          c.camera.addShake(0.25);
          if ((gt * 30 | 0) % 3 === 0) {
            c.vfx.burst(gp.clone().add(_v.set((Math.random() - 0.5) * R, 0.3, (Math.random() - 0.5) * R)), { count: 5, color: 0x8a7563, color2: 0x3a2c22, tile: 2, speed: 8, size: 0.9, life: 0.7, gravity: 8, drag: 1.4, dir: _up, cone: 1.0 });
            for (const en of c.combat.enemiesInRadius(gp, R * 0.9)) { en.takeHit({ damage: 14, dir: _up.clone(), knockback: 0, up: 0, stun: 0.4 }); if (en.velocity) en.velocity.set(0, 0, 0); }
          }
          if (gt < 0.75) { this.schedule(1 / 30, grind); return; }
          // lift-off shove
          c.scene.remove(hand); hand.userData.dispose();
          flash(c, 0.4, 0xffffff); c.camera.addShake(1.6);
          c.vfx.dome(gp.clone(), { radius: R + 2, life: 0.7, color: 0xffffff });
          for (let w = 0; w < 4; w++) this.schedule(w * 0.04, () => c.vfx.ring(gp.clone(), { color: w % 2 ? G5PINK : 0xffffff, radius: (w + 1) / 4 * (R + 6), life: 0.6 }));
          c.combat.areaStrike(gp, { radius: R + 2, damage: 50, knockback: 44, up: 22, stun: 0.6, color: 0xffffff, silent: true, shake: 0.6 });
          this.schedule(0.1, () => smoke(c, gp.clone().add(_up.clone().multiplyScalar(5)), 40));
        };
        this.schedule(0.14, grind);
        return;
      }
      requestAnimationFrame(fall);
    };
    this.schedule(0.3, fall);
  }

  // ======================= GEAR 5 (the massive set) =========================
  // drop a giant white cartoon fist mesh from `startP`, arc it to `land` over
  // `dur`, spin + trail, then `onLand(landPoint)`.
  _dropFist(c, startP, land, r, dur, onLand) {
    const fist = g5Fist(r);
    fist.position.copy(startP); c.scene.add(fist);
    let t = 0;
    const fly = () => {
      t += 1 / 60;
      const k = Math.min(1, t / dur);
      fist.position.lerpVectors(startP, land, k * k);
      fist.rotation.x += 0.4; fist.rotation.z += 0.16;
      fist.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.15);
      if ((t * 60 | 0) % 2 === 0) c.vfx.burst(fist.position.clone(), { count: 3, color: 0xffffff, color2: G5WARM, tile: 2, speed: 4, size: r * 0.4, life: 0.4, gravity: 0, drag: 1.4 });
      if (k >= 1) { c.scene.remove(fist); fist.userData.dispose(); onLand(land.clone()); return; }
      requestAnimationFrame(fly);
    };
    fly();
  }

  // Z (Gear 5) — Agarre de Tierra: REACH DOWN, tear a chunk of the landscape
  // free (the ground craters where it was), HEAVE it overhead, then HURL it
  // forward — a giant tumbling boulder that smashes through foes and detonates
  // where it lands: crater, terrain shatter, and it bursts into rolling rocks.
  _grabGround(c) {
    c.pose('raise');
    const d = c.forwardFlat.clone();
    const o = c.controller.position.clone(); o.y = gY(c, o.x, o.z);
    const grabP = o.clone().addScaledVector(d, 4); grabP.y = gY(c, grabP.x, grabP.z);
    c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 1.0);
    c.camera.addShake(0.4); flash(c, 0.16, G5W);
    // WIND-UP — reach down, the ground groans and cracks (quick, no cinematic)
    c.vfx.stretch(() => c.controller.chest.clone(), _up.clone().negate(), { length: 4.5, radius: 0.42, color: G5W, life: 0.16 });
    c.vfx.crack(grabP.clone(), { radius: 9, count: 16, life: 3, ground: true, color: G5WARM });
    c.vfx.decal(grabP.clone(), { kind: 'crack', radius: 9, life: 5, groundY: grabP.y, color: 0xffe0c0 });
    c.vfx.shatter(grabP.clone(), { radius: 7, count: 12, life: 3, groundY: grabP.y, color: 0x2c211a });
    c.combat.hitstop(0.05); slow(c, 0.07, 0.55);
    // the SLAB — a torn chunk of landscape (built straight into the scene)
    const geos = [], mats = [];
    const slab = new THREE.Group();
    slab.rotation.y = Math.atan2(d.x, d.z);
    const mk = (g, m, y = 0) => { geos.push(g); mats.push(m); const me = new THREE.Mesh(g, m); me.position.y = y; slab.add(me); };
    const dirtG = new THREE.BoxGeometry(9, 3, 9);
    { const a = dirtG.attributes.position; for (let i = 0; i < a.count; i++) { const j = 0.65 + Math.random() * 0.7; a.setXYZ(i, a.getX(i) * j, a.getY(i) * j + (a.getY(i) > 0 ? Math.random() * 1.0 : 0), a.getZ(i) * j); } dirtG.computeVertexNormals(); }
    mk(dirtG, new THREE.MeshToonMaterial({ color: 0x5a4632, flatShading: true }));
    mk(new THREE.BoxGeometry(8, 0.8, 8), new THREE.MeshToonMaterial({ color: 0x6f5f42, flatShading: true }), 1.7);
    mk(new THREE.IcosahedronGeometry(6.4, 1), new THREE.MeshBasicMaterial({ color: G5W, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false }));
    slab.position.copy(o).addScaledVector(d, 4).add(_up.clone().multiplyScalar(-3));
    c.scene.add(slab);
    const MAX = 50;
    const seen = new Set();
    const vel = new THREE.Vector3();
    let t = 0, thrown = false, travelled = 0;
    const anim = () => {
      t += 1 / 60;
      if (!thrown) {
        const k = Math.min(1, t / 0.16);                    // RIP FREE + heave overhead — FAST
        slab.position.copy(o).addScaledVector(d, 4 - k * 1).add(_up.clone().multiplyScalar(-3 + k * 9));
        slab.rotation.x = -0.4 * k;
        slab.rotation.z += 0.03;
        c.vfx.burst(slab.position.clone().add(_up.clone().multiplyScalar(-2)), { count: 7, color: 0x8a7563, color2: 0x3a2c22, tile: 2, speed: 7, size: 1.0, life: 0.9, gravity: 12, drag: 1.3, dir: _up.clone().negate(), cone: 1.2 });
        if (k >= 1) {
          thrown = true;
          c.combat.hitstop(0.05); c.camera.addShake(0.7); slow(c, 0.05, 0.6);
          c.vfx.windGust(_v.set(slab.position.x, gY(c, slab.position.x, slab.position.z), slab.position.z).clone(), { dir: d.clone(), length: MAX, width: 9, life: 0.45, color: G5W });
          vel.copy(d).multiplyScalar(58); vel.y = 6;          // HURL forward, flat and fast
        }
      } else {
        vel.y -= 42 / 60;
        slab.position.addScaledVector(vel, 1 / 60);
        travelled += 58 / 60;
        slab.rotation.x += 0.5; slab.rotation.z += 0.13;      // hard tumble
        c.vfx.burst(slab.position.clone(), { count: 6, color: 0x9a8a7a, color2: 0x4a3a2a, tile: 2, speed: 7, size: 1.1, life: 0.6, gravity: 4, drag: 1.4 });
        c.vfx.burst(slab.position.clone(), { count: 2, color: 0xffffff, color2: G5W, tile: 7, speed: 6, size: 0.8, life: 0.3, gravity: 0, drag: 2 });
        // plough through foes it flies past
        for (const en of c.combat.enemiesInRadius(slab.position, 5.5)) {
          if (seen.has(en)) continue; seen.add(en);
          en.takeHit({ damage: 95, dir: d.clone().setY(0.25).normalize(), knockback: 56, up: 18, stun: 1.1 });
          c.combat.hooks?.onDamageNumber?.(en.center.clone(), 95);
          if (en.impulse) en.impulse.addScaledVector(d, 34 / (en.mass || 1));
        }
        const gh = gY(c, slab.position.x, slab.position.z);
        if (slab.position.y <= gh + 2 || travelled >= MAX) {
          c.scene.remove(slab); geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose());
          const ep = _v.set(slab.position.x, gh, slab.position.z).clone();
          flash(c, 1.0, G5W); slow(c, 0.34, 0.24); c.combat.hitstop(0.3); c.camera.addShake(5, 1.5);
          c.vfx.flipbook(ep.clone().add(_up), { kind: 'impact', size: 44, life: 0.85, color: 0xffffff });
          for (let i = 0; i < 6; i++) this.schedule(i * 0.05, () => c.vfx.flipbook(ep.clone().add(_up), { kind: 'shock', size: 20 + i * 11, life: 0.55, color: i % 2 ? G5WARM : 0xffffff }));
          c.vfx.dome(ep.clone(), { radius: 26, life: 1.1, color: G5W });
          c.vfx.shatter(ep.clone(), { radius: 24, count: 26, life: 3.5, groundY: ep.y, color: 0x2c211a });
          c.vfx.crack(ep.clone(), { radius: 26, count: 30, life: 2.5, ground: true, color: G5WARM });
          for (let i = 0; i < 8; i++) {                       // fissures split the ground outward
            const fa = (i / 8) * 6.283 + Math.random() * 0.3;
            c.vfx.fracture(ep.clone(), _v.set(Math.cos(fa), 0, Math.sin(fa)).clone(), { length: 20 + Math.random() * 8, width: 1.4, grow: 26, life: 2.4, color: G5WARM, groundY: ep.y });
          }
          for (let w = 0; w < 7; w++) this.schedule(w * 0.04, () => c.vfx.ring(ep.clone(), { color: w % 2 ? G5WARM : 0xffffff, radius: (w + 1) / 7 * 34, life: 0.7, thickness: 0.85 }));
          debrisRing(c, ep.clone(), 18, 22);
          c.combat.areaStrike(ep, { radius: 24, damage: 210, knockback: 74, up: 16, stun: 1.5, color: G5W, shake: 1.6 });
          // a marching ring of secondary blasts
          for (let w = 1; w <= 3; w++) this.schedule(0.06 + w * 0.09, () => {
            const rr = 10 + w * 8;
            c.vfx.flipbook(ep.clone().add(_up), { kind: 'shock', size: rr * 1.6, life: 0.45, color: G5WARM });
            c.combat.areaStrike(ep, { radius: rr, damage: 60, knockback: 40, up: 10, stun: 0.6, color: G5WARM, silent: true, shake: 0.5 });
          });
          for (let i = 0; i < 8; i++) {                       // the boulder shatters into rolling rocks
            const a = (i / 8) * 6.283 + Math.random();
            const cg = new THREE.IcosahedronGeometry(1.2 + Math.random() * 0.7, 0);
            c.combat.spawnProjectile({
              pos: ep.clone().add(_up.clone().multiplyScalar(2)),
              vel: _v.set(Math.cos(a), 0.5 + Math.random() * 0.4, Math.sin(a)).normalize().multiplyScalar(20 + Math.random() * 12).clone(),
              gravity: 34, radius: 1.2, life: 2.6, damage: 38, aoe: 3, knockback: 26, up: 5, color: G5W, trailColor: 0x8a7563,
              mesh: new THREE.Mesh(cg, new THREE.MeshToonMaterial({ color: 0x5a4632, flatShading: true })),
              onImpact: (pp) => { const e2 = _v.set(pp.x, gY(c, pp.x, pp.z), pp.z).clone(); cg.dispose(); c.vfx.burst(e2.clone(), { count: 12, color: 0x8a7563, color2: 0x3a2c22, tile: 2, speed: 10, size: 0.7, life: 0.6, gravity: 9, drag: 1.5 }); c.vfx.crack(e2.clone(), { radius: 4, count: 6, life: 1.5, ground: true, color: G5WARM }); },
            });
          }
          this.schedule(0.12, () => smoke(c, ep.clone().add(_up.clone().multiplyScalar(4)), 40));
          return;
        }
      }
      requestAnimationFrame(anim);
    };
    this.schedule(0.03, anim);
  }

  // X (Gear 5) — Chicle: GRAB a foe and stretch them grotesquely long toward a
  // point behind you, hold them helpless, then SNAP — they rocket forward past
  // you and slam into the ground. No target -> a wide rubber air-whip.
  _taffy(c) {
    c.pose('thrust');
    const d = c.aimDir.clone().normalize();
    const from = c.controller.chest.clone();
    const foe = this._target(c, from, d, 26, 0.3);
    if (!foe) {
      const gp = from.clone().addScaledVector(d, 12); gp.y = gY(c, gp.x, gp.z);
      c.vfx.stretch(() => from.clone().addScaledVector(d, 0.4), d, { length: 20, radius: 0.5, color: G5W, life: 0.18 });
      c.vfx.flipbook(gp.clone().add(_up), { kind: 'shock', size: 14, life: 0.4, color: G5PINK });
      c.vfx.burst(gp.clone().add(_up), { count: 26, color: 0xffffff, color2: G5PINK, tile: 4, speed: 18, size: 0.4, life: 0.4, gravity: 4, drag: 1.6 });
      c.vfx.crack(gp.clone(), { radius: 9, count: 12, life: 1.8, ground: true, color: G5WARM });
      c.vfx.shatter(gp.clone(), { radius: 8, count: 10, life: 2.2, groundY: gp.y, color: 0x2c211a });
      c.combat.areaStrike(gp, { radius: 9, damage: 56, knockback: 46, up: 9, stun: 0.5, color: G5W, shake: 0.6 });
      this.slots.e._t = 2.0;
      return;
    }
    c.combat.hitstop(0.06); slow(c, 0.06, 0.5); c.camera.addShake(0.3);
    if (foe.velocity) foe.velocity.set(0, 0, 0);
    foe._stun = Math.max(foe._stun || 0, 1.4);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 8), new THREE.MeshToonMaterial({ color: G5W, emissive: 0x666666 }));
    band.geometry.translate(0, 0.5, 0);
    c.scene.add(band);
    const _by = new THREE.Vector3(0, 1, 0), _bq = new THREE.Quaternion();
    let t = 0;
    const stretch = () => {
      t += 1 / 60;
      const k = Math.min(1, t / 0.5);
      const anchor = c.controller.chest.clone().addScaledVector(c.forwardFlat, -8).add(_up);
      const fc = (foe && !foe.dead) ? foe.center.clone() : anchor.clone();
      if (foe && !foe.dead) {
        if (foe.impulse) foe.impulse.addScaledVector(c.controller.chest.clone().sub(foe.center).setY(0).normalize(), 10 * k / (foe.mass || 1));
        foe._stun = Math.max(foe._stun || 0, 0.3);
        if ((t * 60 | 0) % 10 === 0) foe.takeHit({ damage: 5, dir: null, knockback: 0, up: 0, stun: 0.3 });
      }
      const seg = anchor.clone().sub(fc); const len = Math.max(0.1, seg.length());
      band.position.copy(fc);
      band.quaternion.copy(_bq.setFromUnitVectors(_by, seg.multiplyScalar(1 / len)));
      band.scale.set(0.6 + Math.sin(t * 30) * 0.15, len, 0.6 + Math.sin(t * 30 + 1) * 0.15);
      c.vfx.burst(fc.clone().lerp(anchor, Math.random()), { count: 2, color: 0xffffff, color2: G5PINK, tile: 5, speed: 3, size: 0.3, life: 0.3, gravity: 0, drag: 2 });
      if (t < 0.62) { requestAnimationFrame(stretch); return; }
      // SNAP
      c.scene.remove(band); band.geometry.dispose(); band.material.dispose();
      if (foe && !foe.dead) {
        c.camera.addShake(0.6); c.combat.hitstop(0.12); flash(c, 0.24, G5W); slow(c, 0.1, 0.4);
        const fwd = c.forwardFlat.clone();
        if (foe.velocity) foe.velocity.copy(fwd).multiplyScalar(64).setY(6);
        if (foe.impulse) foe.impulse.addScaledVector(fwd, 92 / (foe.mass || 1));
        foe.takeHit({ damage: 105, dir: fwd.clone().setY(0.15).normalize(), knockback: 30, up: 10, stun: 1.1 });
        c.combat.hooks?.onDamageNumber?.(foe.center.clone(), 105);
        c.vfx.stretch(() => c.controller.chest.clone(), fwd, { length: 18, radius: 0.6, color: G5W, life: 0.16 });
        c.vfx.flipbook(foe.center.clone(), { kind: 'impact', size: 14, life: 0.45, color: 0xffffff });
        this.schedule(0.2, () => {
          if (!foe || foe.dead) return;
          const ep = _v.set(foe.center.x, gY(c, foe.center.x, foe.center.z), foe.center.z).clone();
          c.combat.hitstop(0.1); c.camera.addShake(0.9); slow(c, 0.08, 0.4);
          for (let i = 0; i < 3; i++) this.schedule(i * 0.05, () => c.vfx.flipbook(ep.clone().add(_up), { kind: 'shock', size: 10 + i * 6, life: 0.4, color: i % 2 ? G5PINK : 0xffffff }));
          c.vfx.dome(ep.clone(), { radius: 10, life: 0.6, color: G5W });
          c.vfx.crack(ep.clone(), { radius: 11, count: 14, life: 2, ground: true, color: G5WARM });
          c.vfx.shatter(ep.clone(), { radius: 9, count: 12, life: 2.6, groundY: ep.y, color: 0x2c211a });
          for (let i = 0; i < 4; i++) { const fa = i / 4 * 6.283 + 0.5; c.vfx.fracture(ep.clone(), _v.set(Math.cos(fa), 0, Math.sin(fa)).clone(), { length: 12 + Math.random() * 5, width: 1.0, grow: 24, life: 2.0, color: G5WARM, groundY: ep.y }); }
          debrisRing(c, ep.clone(), 8, 16);
          c.combat.areaStrike(ep, { radius: 10, damage: 70, knockback: 44, up: 12, stun: 0.6, color: G5W, shake: 0.9 });
        });
      }
    };
    this.schedule(0.05, stretch);
  }

  // V (Gear 5) — Mundo de Goma: slam the ground and a wide patch of the world
  // turns to BOUNCY WHITE RUBBER for ~5 s — foes trapped inside are flung
  // skyward again and again, helpless; ends with a huge rebound slam.
  _rubberWorld(c) {
    c.pose('slam');
    const gp = c.controller.position.clone(); gp.y = gY(c, gp.x, gp.z);
    const R = 14, DUR = 5;
    slow(c, 0.14, 0.35); flash(c, 0.3, G5W); c.combat.hitstop(0.14); c.camera.addShake(1.8);
    c.vfx.flipbook(c.controller.chest.clone(), { kind: 'impact', size: 22, life: 0.6, color: 0xffffff });
    c.vfx.dome(gp.clone(), { radius: R, life: 0.7, color: G5W });
    c.vfx.crack(gp.clone(), { radius: R, count: 12, life: DUR, ground: true, color: G5WARM });
    for (let i = 0; i < 4; i++) this.schedule(i * 0.05, () => c.vfx.ring(gp.clone(), { color: i % 2 ? G5PINK : G5W, radius: (i + 1) / 4 * R, life: 0.55 }));
    // a low wobbling white rubber disc over the patch
    const geo = new THREE.CircleGeometry(R, 40); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: G5W, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
    const disc = new THREE.Mesh(geo, mat); disc.position.set(gp.x, gp.y + 0.05, gp.z); c.scene.add(disc);
    let t = 0;
    const boing = () => {
      t += 1 / 30;
      disc.scale.set(1 + Math.sin(t * 7) * 0.03, 1, 1 + Math.sin(t * 7 + 1) * 0.03);
      mat.opacity = 0.16 + Math.abs(Math.sin(t * 5)) * 0.12;
      // the player bounces high whenever grounded inside
      if (c.controller.grounded && c.controller.position.distanceTo(gp) < R) c.controller.velocity.y = Math.max(c.controller.velocity.y, 16);
      for (const en of c.combat.enemiesInRadius(gp, R)) {
        if ((t * 30 | 0) % 9 === 0) {
          if (en.velocity) { en.velocity.set((Math.random() - 0.5) * 6, 24, (Math.random() - 0.5) * 6); }
          en._stun = Math.max(en._stun || 0, 0.6);
          en.takeHit({ damage: 8, dir: _up.clone(), knockback: 0, up: 0, stun: 0.5 });
          c.vfx.burst(_v.set(en.center.x, gY(c, en.center.x, en.center.z), en.center.z).clone(), { count: 6, color: 0xffffff, color2: G5WARM, tile: 4, speed: 10, size: 0.35, life: 0.4, gravity: 6, drag: 1.6, dir: _up, cone: 1.4 });
          c.vfx.ring(_v.set(en.center.x, gY(c, en.center.x, en.center.z) + 0.1, en.center.z).clone(), { color: G5PINK, radius: 2, life: 0.3 });
        }
      }
      if ((t * 30 | 0) % 6 === 0) c.vfx.burst(gp.clone().add(_v.set((Math.random() - 0.5) * R * 1.6, 0.2, (Math.random() - 0.5) * R * 1.6)), { count: 2, color: 0xffffff, tile: 4, speed: 5, size: 0.4, life: 0.5, gravity: 6, drag: 1.6, dir: _up, cone: 0.8 });
      if (t < DUR) { this.schedule(1 / 30, boing); return; }
      // rebound slam
      c.scene.remove(disc); geo.dispose(); mat.dispose();
      flash(c, 0.5, G5W); slow(c, 0.14, 0.3); c.combat.hitstop(0.14); c.camera.addShake(2);
      c.vfx.flipbook(gp.clone().add(_up), { kind: 'impact', size: 26, life: 0.6, color: 0xffffff });
      for (let i = 0; i < 4; i++) this.schedule(i * 0.05, () => c.vfx.ring(gp.clone(), { color: i % 2 ? G5PINK : G5W, radius: (i + 1) / 4 * (R + 6), life: 0.6 }));
      c.vfx.dome(gp.clone(), { radius: R + 4, life: 0.8, color: G5W });
      c.combat.areaStrike(gp, { radius: R + 2, damage: 100, knockback: 44, up: 24, stun: 1.0, color: G5W, shake: 1.0 });
    };
    this.schedule(0.2, boing);
  }

  // T (Gear 5) — Bajrang Gun: gather the world's air, INFLATE a fist to titanic
  // size overhead, then rocket it forward on a rubber recoil to flatten
  // everything. Colossal crater, fissures splitting to the horizon, a shockwave
  // that marches the whole arena, and a toon TRIPLE-bounce each landing bigger.
  // (Normal T is the controllable Bola de Goma / `_rubberBall` instead.)
  _bajrang(c) {
    c.pose('raise');
    const d = c.forwardFlat.clone();
    const big = this.transformed;
    c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 2.6);
    c.camera.addShake(0.4); flash(c, 0.14, 0xfff0e0);
    slow(c, 0.6, 0.3);
    c.vfx.flipbook(c.controller.chest.clone(), { kind: 'energyball', size: big ? 10 : 7, life: 0.7, color: 0xfff0e0 });
    // gather — long streams of air drawn in from all around (batched: same
    // particle count, a fraction of the call/alloc overhead)
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * 6.283, rr = 7 + Math.random() * 7;
      const fp = c.controller.chest.clone().add(_v.set(Math.cos(a) * rr, (Math.random() - 0.5) * 5, Math.sin(a) * rr));
      c.vfx.burst(fp, { count: 8, color: 0xffffff, color2: 0xffcf9a, tile: 6, speed: 14, size: 0.5, life: 0.5, gravity: 0, drag: 1, dir: c.controller.chest.clone().sub(fp).normalize(), cone: 0.35 });
    }
    for (let i = 0; i < 3; i++) this.schedule(i * 0.1, () => c.vfx.ring(c.controller.chest.clone(), { color: i % 2 ? G5PINK : 0xffffff, radius: 4 + i * 3, life: 0.5, vertical: true }));

    this.schedule(0.36, () => {
      const base = big ? 9 : 6.5;
      const fist = g5Fist(base);
      const anchor = () => c.controller.chest.clone().addScaledVector(d, 3).add(_up.clone().multiplyScalar(2.5));
      fist.position.copy(anchor());
      fist.scale.setScalar(0.15);
      c.scene.add(fist);
      const GROW = big ? 2.7 : 2.2;
      c.camera.cine({ dist: big ? 14 : 11, fov: big ? 62 : 64, focus: anchor().addScaledVector(d, big ? 20 : 16), focusMix: 0.55, spin: big ? 1.6 : 1.0, pitchAdd: 0.14, inT: 0.22, holdT: 1.0, outT: 1.6 });
      let t = 0, phase = 0;
      const from = new THREE.Vector3();
      const to = new THREE.Vector3();
      const travelDir = d.clone();   // set for real once `to` is resolved — the actual aim line, not just forwardFlat
      const step = () => {
        t += 1 / 60;
        if (phase === 0) {                                   // INFLATE overhead
          const k = Math.min(1, t / 0.55);
          fist.position.copy(anchor());
          fist.scale.setScalar(THREE.MathUtils.lerp(0.15, GROW, k * (2 - k)));
          fist.rotation.y += 0.05;
          if ((t * 60 | 0) % 4 === 0) c.vfx.stretch(() => c.controller.chest.clone(), fist.position.clone().sub(c.controller.chest).normalize(), { length: fist.position.distanceTo(c.controller.chest), radius: 0.7, color: G5W, life: 0.16 });
          if ((t * 60 | 0) % 3 === 0) c.vfx.burst(fist.position.clone(), { count: 5, color: 0xffffff, color2: 0xffcf9a, tile: 2, speed: 5, size: 1.6, life: 0.5, gravity: 0, drag: 1.3 });
          c.camera.addShake(0.1 + k * 0.4);
          if (k >= 1) {
            phase = 1; t = 0;
            from.copy(fist.position);
            // FIRE toward wherever you're aiming, not just a fixed distance ahead
            to.copy(aimedGround(c, big ? 70 : 55, big ? 20 : 16));
            to.y += base * GROW * 0.4;
            travelDir.copy(to).sub(from).setY(0);
            if (travelDir.lengthSq() < 1e-4) travelDir.copy(d); else travelDir.normalize();
            c.combat.hitstop(0.1); c.camera.addShake(1.2); flash(c, 0.3, 0xffffff);
            c.vfx.windGust(c.controller.chest.clone(), { dir: travelDir.clone(), length: big ? 46 : 38, width: 12, life: 0.5, color: G5W });
          }
        } else {                                             // FIRE forward
          const k = Math.min(1, t / 0.36);
          fist.position.lerpVectors(from, to, k * k);
          fist.rotation.x += 0.4; fist.rotation.z += 0.14;
          c.vfx.burst(fist.position.clone(), { count: 6, color: 0xffffff, color2: 0xffcf9a, tile: 2, speed: 5, size: 1.6, life: 0.5, gravity: 0, drag: 1.3 });
          for (const en of c.combat.enemiesInRadius(fist.position, base * GROW * 0.6)) {
            en.takeHit({ damage: 40, dir: travelDir.clone().setY(0.2).normalize(), knockback: 40, up: 14, stun: 0.6 });
          }
          if (k < 1) { requestAnimationFrame(step); return; }
          c.scene.remove(fist); fist.userData.dispose();

          const RAD = big ? 30 : 22;
          const hit = (p, scale, dmg, marchTo) => {
            // screen-feel + cheap layers land instantly; the geometry-heavy
            // effects (shatter plates / crack lines / fissures / debris) are
            // spread over the next few frames so no single frame allocates
            // hundreds of objects — the spike that caused the lag. Same counts,
            // same sizes, staggered by <120 ms (invisible under the slow-mo).
            flash(c, 0.7 * scale + 0.3, 0xfff2e8); c.combat.hitstop(0.16 + 0.06 * scale); c.camera.addShake(2.4 * scale, 1.4); slow(c, 0.22, 0.3);
            c.vfx.flipbook(p.clone().add(_up), { kind: 'impact', size: 40 * scale, life: 0.85, color: 0xffe6cf });
            for (let i = 0; i < 6; i++) this.schedule(i * 0.05, () => c.vfx.flipbook(p.clone().add(_up), { kind: 'shock', size: (18 + i * 10) * scale, life: 0.55, color: i % 2 ? 0xffffff : 0xffc888 }));
            c.vfx.dome(p.clone(), { radius: RAD * scale + 6, life: 1.2, color: 0xffd0a0 });
            c.vfx.burst(p.clone().add(_up), { count: Math.round(160 * scale), color: 0xffffff, color2: 0xffcf9a, tile: 4, speed: 32, size: 0.55, life: 1.1, gravity: 6, drag: 1.4, dir: _up, cone: 2.4 });
            this.schedule(0.02, () => c.vfx.shatter(p.clone(), { radius: RAD * scale, count: Math.round(26 * scale), life: 3.5, groundY: p.y, color: 0x3a2c22 }));
            this.schedule(0.06, () => c.vfx.crack(p.clone(), { radius: RAD * scale + 4, count: Math.round(28 * scale), life: 2.6, ground: true, color: 0xffe0c0 }));
            const arms = Math.round(10 * scale);
            for (let i = 0; i < arms; i++) this.schedule(0.03 + (i % 3) * 0.03, () => {
              const fa = (i / arms) * 6.283 + Math.random() * 0.3;
              c.vfx.fracture(p.clone(), _v.set(Math.cos(fa), 0, Math.sin(fa)).clone(), { length: RAD * scale + Math.random() * 12, width: 1.6, grow: 32, life: 2.6, color: 0xffe0c0, groundY: p.y });
            });
            this.schedule(0.04, () => debrisRing(c, p.clone(), RAD * scale * 0.7, 22));
            this.schedule(0.05, () => c.vfx.flipbook(p.clone().add(_up.clone().multiplyScalar(4)), { kind: 'smoke', size: 30 * scale, life: 2.0, color: 0x8a7a6a, additive: false, rise: 1.6, spin: true }));
            // the shockwave MARCHES the arena — each ring a damage pulse
            const seen = new Set();
            const far = (RAD * scale + 20) * (marchTo || 1);
            for (let w = 0; w < 10; w++) this.schedule(w * 0.05, () => {
              const rr = ((w + 1) / 10) * far;
              c.vfx.ring(p.clone(), { color: w % 2 ? 0xffc888 : 0xffffff, radius: rr, life: 0.8, thickness: 0.9 });
              for (const en of c.combat.enemiesInRadius(p, rr)) {
                if (seen.has(en)) continue; seen.add(en);
                const away = _v.set(en.center.x - p.x, 0, en.center.z - p.z).normalize().clone();
                en.takeHit({ damage: w === 0 ? dmg : 80, dir: away.setY(0.4).normalize(), knockback: w === 0 ? 80 : 55, up: 22, stun: 1.5 });
                c.combat.hooks?.onDamageNumber?.(en.center.clone(), w === 0 ? dmg : 80);
              }
            });
            c.combat.areaStrike(p, { radius: RAD * scale + 4, damage: dmg, knockback: 70, up: 20, stun: 1.6, color: 0xffe0c0, silent: true, shake: 1.6 });
          };
          const gp = to.clone(); gp.y = gY(c, gp.x, gp.z);
          hit(gp, big ? 1.5 : 1.0, big ? 360 : 220, 1);
          if (big) {                                          // toon TRIPLE bounce, each further along the same line + smaller
            this.schedule(0.34, () => { const p2 = gp.clone().addScaledVector(travelDir, 12); p2.y = gY(c, p2.x, p2.z); hit(p2, 1.0, 150, 1.1); });
            this.schedule(0.66, () => { const p3 = gp.clone().addScaledVector(travelDir, 24); p3.y = gY(c, p3.x, p3.z); hit(p3, 0.65, 90, 1.2); });
          }
          return;                                             // impact done — STOP the loop
        }
        requestAnimationFrame(step);
      };
      step();
    });
  }

  // ==================== THE AWAKENING — Gear 5 ("Nika") ====================
  //   Effects AROUND the body (ref image, no body models): a bright white
  //   RIM-LIGHT silhouette, flowing white smoke-HAIR wisps streaming up/back,
  //   PINK LOTUS flowers at the shoulders. Sequenced for maximum drama:
  //   PUNCH-IN -> Drums of Liberation -> full white-out RELEASE + orbit reveal.
  onForm(c, on) {
    c.character?.setForm(on ? 'gear5' : null);
    c.character?.setGlow(on);
    this.slots.q.name = on ? 'Agarre de Tierra' : 'Impulso de Goma';
    this.slots.e.name = on ? 'Chicle' : 'Jet Gatling';
    this.slots.v.name = on ? 'Puño del Cielo' : 'Bazuca de Goma';
    this.slots.ult.name = on ? 'Bajrang Gun' : 'Bola de Goma';
    if (!on) {
      this._g5on = false;
      c.vfx.burst(c.controller.chest, { count: 24, color: 0xffffff, color2: G5PINK, tile: 2, speed: 5, size: 0.5, life: 0.6, gravity: 6, drag: 2.4 });
      c.vfx.ring(c.controller.chest, { color: 0xffffff, radius: 3, life: 0.4, vertical: true });
      c.camera.addShake(0.3);
      return;
    }
    const ch = () => c.controller.chest.clone();
    c.character?.gear5Awaken();
    c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 2.6);
    c.controller.velocity.y = Math.max(c.controller.velocity.y, 5);

    // ---- PHASE 0: the pull-in. everything slows to a crawl ----
    slow(c, 1.5, 0.14);
    c.camera.cine({ dist: 3.8, fov: 80, focus: ch().add(_up.clone().multiplyScalar(0.55)), focusMix: 0.85, inT: 0.14, holdT: 0.85, outT: 0.05 });
    flash(c, 0.4, 0xffffff);
    c.vfx.flipbook(ch(), { kind: 'energyball', size: 3, life: 1.0, color: 0xffffff, rise: 0 });

    // ---- PHASE 1: Drums of Liberation — 4 escalating heartbeat BOOMs ----
    for (let i = 0; i < 4; i++) this.schedule(0.12 + i * 0.18, () => {
      c.combat.hitstop(0.04 + i * 0.03); c.camera.addShake(0.5 + i * 0.7);
      flash(c, 0.14 + i * 0.06, i % 2 ? G5PINK : 0xffffff);
      c.vfx.ring(ch(), { color: i % 2 ? G5PINK : 0xffffff, radius: 3 + i * 4, life: 0.6, thickness: 0.7, vertical: true });
      c.vfx.ring(ch(), { color: 0xffffff, radius: 2 + i * 3.5, life: 0.55 });
      c.vfx.flipbook(ch(), { kind: 'shock', size: 8 + i * 7, life: 0.44, color: 0xffffff });
      c.vfx.burst(ch(), { count: 20 + i * 10, color: 0xffffff, color2: G5PINK, tile: 4, speed: 10 + i * 5, size: 0.5, life: 0.9, gravity: -2, drag: 1.9 });
    });

    // ---- PHASE 2: THE RELEASE — white-out + a shockwave that rolls the arena;
    //      the camera SLAMS out and orbits, revealing the glowing silhouette ----
    this.schedule(0.92, () => {
      const gp = c.controller.position.clone(); gp.y = gY(c, gp.x, gp.z);
      c.camera.cine({ dist: 13, fov: 54, focus: gp.clone().add(_up.clone().multiplyScalar(1.5)), focusMix: 0.7, spin: 3.2, pitchAdd: 0.2, inT: 0.06, holdT: 1.1, outT: 2.0 });
      // lingering white-out (staggered so it doesn't just blink)
      flash(c, 1.0, 0xffffff);
      this.schedule(0.1, () => flash(c, 0.6, 0xffffff));
      this.schedule(0.22, () => flash(c, 0.35, G5PINK));
      c.combat.hitstop(0.32); c.camera.addShake(4.5, 1.7);
      // a colossal light pillar to the sky
      c.vfx.beam(() => ch(), () => _up.clone(), { length: 60, radius: 3, life: 1.4, color: 0xffffff, core: 0xffffff });
      c.vfx.flipbook(ch().add(_up), { kind: 'impact', size: 40, life: 0.9, color: 0xffffff });
      c.vfx.dome(gp.clone(), { radius: 30, life: 1.3, color: 0xffffff });
      c.vfx.crack(gp.clone(), { radius: 24, count: 20, life: 3, ground: true, color: G5PINK });
      c.vfx.burst(gp.clone().add(_up), { count: 160, color: 0xffffff, color2: G5PINK, tile: 4, speed: 30, size: 0.5, life: 1.2, gravity: -2, drag: 1.6 });
      // the shockwave rolls out
      const seen = new Set();
      for (let w = 0; w < 10; w++) this.schedule(w * 0.045, () => {
        const rr = ((w + 1) / 10) * 34;
        c.vfx.ring(gp.clone(), { color: w % 2 ? G5PINK : 0xffffff, radius: rr, life: 0.7, thickness: 0.8 });
        for (const t of c.combat.enemiesInRadius(gp, rr)) {
          if (seen.has(t)) continue; seen.add(t);
          const away = _v.set(t.center.x - gp.x, 0, t.center.z - gp.z).normalize().clone();
          t.takeHit({ damage: 60, dir: away.setY(0.35).normalize(), knockback: 55, up: 22, stun: 1.2 });
          c.combat.hooks?.onDamageNumber?.(t.center.clone(), 60);
        }
      });
      c.combat.healPlayer?.(50);
      // the 4 elements SNAP in with their own bursts
      c.vfx.burst(ch().add(_up.clone().multiplyScalar(1.6)), { count: 40, color: 0xffffff, tile: 2, speed: 7, size: 1.3, life: 1.6, gravity: -1, drag: 1.3, dir: _up, cone: 2.0 });   // hair
      for (const s of [-1, 1]) c.vfx.burst(ch().add(_v.set(s * 0.6, 0.5, 0)), { count: 14, color: G5PINK, color2: 0xffd6e8, tile: 5, speed: 5, size: 0.4, life: 0.7, gravity: -1, drag: 1.8 });   // lotuses
      this.schedule(0.25, () => smoke(c, ch().add(_up.clone().multiplyScalar(3)), 34));
    });

    // ---- PERSISTENT ENSEMBLE: (rim-glow lives on the Character) + smoke-hair
    //      strands + pink lotuses. Kept DELIBERATELY restrained so the
    //      silhouette stays readable — no aura, thin wisps, punchy lotuses. ----
    this._g5on = true;
    const grp = new THREE.Group(); c.scene.add(grp);
    const geos = [];
    const hairInner = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide });
    const hairGlow = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const lotusMat = new THREE.MeshToonMaterial({ color: 0xff5c9e, emissive: new THREE.Color(0xff2e7e).multiplyScalar(0.4), flatShading: true, side: THREE.DoubleSide });
    const lotusGlow = new THREE.MeshBasicMaterial({ color: 0xff86b8, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
    // flowing smoke-HAIR: many thin, long tapered strands fanned up + back
    const wisps = [];
    for (let i = 0; i < 9; i++) {
      const len = 3.2 + Math.random() * 3.0;
      const g = new THREE.ConeGeometry(0.13, len, 5, 4, true); g.translate(0, len / 2, 0); geos.push(g);
      const w = new THREE.Mesh(g, hairInner);
      w.add(new THREE.Mesh(g, hairGlow));
      const spread = (i / 8 - 0.5);
      w.userData = { baseX: spread * 1.7, baseZ: -0.35 - Math.abs(spread) * 0.45, tilt: 2.5 + Math.abs(spread) * 0.45, ph: Math.random() * 6.28, sp: 1.1 + Math.random() * 1.0 };
      grp.add(w); wisps.push(w);
    }
    const mkLotus = (sgn) => {
      const l = new THREE.Group();
      for (const [n, tilt, sc] of [[6, -1.2, 1], [5, -0.7, 0.6]]) {
        for (let p = 0; p < n; p++) {
          const pg = new THREE.ConeGeometry(0.14, 0.42, 4); pg.translate(0, 0.21, 0); geos.push(pg);
          const pet = new THREE.Mesh(pg, lotusMat);
          pet.rotation.y = (p / n) * 6.283 + (sc < 1 ? 0.5 : 0);
          pet.rotation.x = tilt;
          pet.scale.set(sc, sc, sc * 0.45);
          l.add(pet);
        }
      }
      const gg = new THREE.SphereGeometry(0.32, 10, 8); geos.push(gg);
      l.add(new THREE.Mesh(gg, lotusGlow));
      l.userData.sgn = sgn; l.scale.setScalar(0.01); grp.add(l); return l;
    };
    const lotus = [mkLotus(-1), mkLotus(1)];
    let ft = 0;
    const _fw = new THREE.Vector3(), _rt = new THREE.Vector3(), _q = new THREE.Quaternion(), _tw = new THREE.Quaternion();
    const _base = new THREE.Vector3();
    const tick = () => {
      if (!this._g5on) {
        c.scene.remove(grp); geos.forEach((g) => g.dispose());
        hairInner.dispose(); hairGlow.dispose(); lotusMat.dispose(); lotusGlow.dispose();
        return;
      }
      ft += 1 / 60;
      const bloom = Math.min(1, ft / 0.45);
      const p = c.controller.chest;
      const yaw = c.controller.facing || 0;
      _fw.set(Math.sin(yaw), 0, Math.cos(yaw));
      _rt.set(_fw.z, 0, -_fw.x);
      const hx = p.x, hy = p.y + 0.6, hz = p.z;
      for (const w of wisps) {
        const u = w.userData;
        w.position.set(hx + _rt.x * u.baseX + _fw.x * u.baseZ, hy, hz + _rt.z * u.baseX + _fw.z * u.baseZ);
        _q.setFromAxisAngle(_rt, -u.tilt + Math.sin(ft * u.sp + u.ph) * 0.4);
        _tw.setFromAxisAngle(_fw, Math.sin(ft * u.sp * 0.7 + u.ph) * 0.45 + u.baseX * 0.3);
        w.quaternion.copy(_tw).multiply(_q);
        const s = bloom * (1 + Math.sin(ft * 3 + u.ph) * 0.09);
        w.scale.set(s, s * (1 + Math.sin(ft * 1.5 + u.ph) * 0.14), s);
      }
      for (const l of lotus) {
        const sgn = l.userData.sgn;
        _base.set(p.x, p.y, p.z).addScaledVector(_rt, sgn * 0.62).addScaledVector(_fw, 0.16);
        l.position.set(_base.x, p.y + 0.62 + Math.sin(ft * 1.7 + sgn) * 0.05, _base.z);
        l.rotation.y = yaw + Math.sin(ft * 0.8 + sgn) * 0.2;
        l.scale.setScalar(bloom);
      }
      requestAnimationFrame(tick);
    };
    tick();
  }
}

/* ================================================================ *
 *  LEGENDARIO — Goro Goro (Rayo). Logia. Ult: Raigō.
 * ================================================================ */
export class GoroGoro extends DevilFruit {
  constructor() {
    super('Goro Goro', 0xbfe8ff, { rarity: 'legendario', type: 'logia', passive: 'Elemental: 30% esquiva · el rayo encadena · acumulas VOLTAJE al golpear y lo descargas en El Thor / Raigō' });
    this.voltage = 0; this.voltageMax = 100;
    this.transformDmg = 1.3; this.transformSpeed = 1.85; this.noAura = true;
    this._boltT = 0;         // seconds left of Cuerpo de Rayo
    this.hudPipMax = 4;

    // === Z — DESCARGA EN CADENA: a fat, forked bolt that LEAPS from foe to
    // foe — each arc a triple-layer strike (bolt + ribbon + glow beam) with a
    // scorched line on the ground and a burst at every node. Jumps scale with
    // Voltage; inside your Campo Electrizado it storms the whole field. ===
    this.slots.q = {
      name: 'Descarga en Cadena', cd: 1.4, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const o = c.controller.chest.clone();
        const d = c.aimDir.clone().normalize();
        const foe = c.combat.nearestEnemies(c.controller.position, 5, 32).find((t) => t.center.clone().sub(o).setY(0).normalize().dot(c.forwardFlat) > 0.1)
          || c.combat.nearestEnemies(c.controller.position, 1, 12)[0] || null;
        // hand discharge
        c.vfx.flipbook(o.clone().addScaledVector(d, 1), { kind: 'muzzle', size: 3.2, life: 0.14, color: 0xffffff });
        c.vfx.burst(o.clone().addScaledVector(d, 0.8), { count: 14, color: 0xdff2ff, color2: 0x6fb8ff, tile: 3, speed: 16, size: 0.24, life: 0.18, gravity: 0, drag: 6, dir: d, cone: 0.4 });
        c.vfx.beam(() => o.clone(), () => d.clone(), { length: 3, radius: 0.28, life: 0.1, color: 0x6fb8ff, core: 0xffffff });
        c.camera.addShake(0.1); flash(c, 0.1, 0xdff2ff);
        if (foe) {
          const inField = this._fieldActive(c) && foe.center.distanceTo(this._field.c) < this._field.r + 2;
          if (inField) { c.vfx.dome(this._field.c.clone().add(_up), { radius: this._field.r, life: 0.5, color: 0xffffff }); c.vfx.flipbook(this._field.c.clone().add(_up), { kind: 'shock', size: this._field.r * 1.8, life: 0.4, color: 0xffffff }); flash(c, 0.35, 0xffffff); c.combat.hitstop(0.06); c.camera.addShake(0.6); }
          const n = chainBolt(c, o, foe, { jumps: inField ? 99 : this._voltJumps() + 1, dmg: 24 * this._voltMul(), range: inField ? 18 : 11 });
          this.addVoltage(7 + n * 4);
          c.combat.hitstop(0.04);
        } else {
          const end = o.clone().addScaledVector(d, 20); end.y = gY(c, end.x, end.z) + 0.5;
          for (let i = 0; i < 5; i++) c.vfx.bolt(o.clone(), end.clone(), { color: i ? 0x8fdcff : 0xffffff, core: 0xffffff, branches: 6 - i, life: 0.22, jitter: 1.4 + i * 0.2 });
          c.vfx.ribbon(o.clone(), end.clone(), { width: 1.0, life: 0.22, color: 0xffffff });
          c.vfx.beam(() => o.clone(), () => d.clone(), { length: o.distanceTo(end), radius: 0.6, life: 0.16, color: 0x6fb8ff, core: 0xffffff });
          c.vfx.flipbook(end.clone(), { kind: 'impact', size: 10, life: 0.36, color: 0xffffff });
          c.vfx.flipbook(end.clone(), { kind: 'shock', size: 10, life: 0.32, color: 0x9fdcff });
          c.vfx.dome(end.clone(), { radius: 4, life: 0.28, color: 0x8fdcff });
          c.vfx.decal(_v.set(end.x, gY(c, end.x, end.z), end.z).clone(), { kind: 'scorch', radius: 2.6, life: 3, groundY: gY(c, end.x, end.z) });
          c.combat.areaStrike(end, { radius: 4, damage: 22 * this._voltMul(), knockback: 12, up: 4, stun: 0.25, color: 0x8fdcff, silent: true, onHitTarget: (t) => c.combat.applyStatus(t, 'shock', { stacks: 2, duration: 4 }) });
          this.addVoltage(4);
        }
      }
    };

    // === X — LLUVIA DE TRUENOS: signature. A black storm rolls in and a wall
    // of thick sky-bolts hammers a huge zone (most home on enemies), building
    // to one colossal central strike + a chain-web. Voltage-scaled. ===
    this.slots.e = {
      name: 'Lluvia de Truenos', cd: 9, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = ahead(c, 12); gp.y = gY(c, gp.x, gp.z);
        const R = 17;
        this._field = { c: gp.clone(), r: R, until: c.elapsed + 4.2 };
        c.vfx.storm(gp.clone(), { radius: R + 4, height: 38, duration: 5, color: 0x0b1226 });
        c.vfx.decal(gp.clone(), { kind: 'scorch', radius: R, life: 10, groundY: gp.y });
        for (let i = 0; i < 4; i++) this.schedule(i * 0.09, () => c.vfx.ring(gp, { color: i % 2 ? 0xffffff : 0x6fb8ff, radius: R * (0.4 + i * 0.26), life: 0.55, thickness: 0.8 }));
        c.camera.addShake(0.3); flash(c, 0.16, 0xdff2ff);
        const N = 34;
        for (let i = 0; i < N; i++) this.schedule(0.25 + i * 0.065 + Math.random() * 0.03, () => {
          let strike;
          const foes = c.combat.enemiesInRadius(gp, R + 3);
          if (foes.length && i % 3 !== 0) strike = foes[(Math.random() * foes.length) | 0].center.clone();
          else { const a = Math.random() * 6.283, rr = Math.sqrt(Math.random()) * R; strike = gp.clone().add(_v.set(Math.cos(a) * rr, 0, Math.sin(a) * rr)); }
          strike.y = gY(c, strike.x, strike.z);
          const top = strike.clone().add(_up.clone().multiplyScalar(38));
          for (let k = 0; k < 3; k++) c.vfx.bolt(top.clone().add(_up.clone().multiplyScalar(k * 5)), strike.clone(), { color: k ? 0x8fdcff : 0xffffff, core: 0xffffff, branches: 4 + (i % 3), life: 0.22, jitter: 1.4 });
          c.vfx.ribbon(top.clone(), strike.clone(), { width: 0.9, life: 0.22, color: 0xffffff });
          c.vfx.beam(() => top.clone(), () => strike.clone().sub(top).normalize(), { length: top.distanceTo(strike), radius: 0.7, life: 0.13, color: 0x6fb8ff, core: 0xffffff });
          c.vfx.flipbook(strike.clone().add(_up), { kind: 'impact', size: 8, life: 0.3, color: 0xffffff });
          c.vfx.flipbook(strike.clone().add(_up), { kind: 'shock', size: 7, life: 0.26, color: 0x9fdcff });
          c.vfx.decal(strike.clone(), { kind: 'scorch', radius: 2.2, life: 4, groundY: strike.y });
          c.vfx.dome(strike.clone(), { radius: 3.2, life: 0.22, color: 0xdff2ff });
          c.vfx.burst(strike.clone().add(_up), { count: 20, color: 0xffffff, color2: 0x6fb8ff, tile: 3, speed: 16, size: 0.34, life: 0.4, gravity: 4, drag: 1.9 });
          c.combat.areaStrike(strike, { radius: 3.6, damage: 30 * this._voltMul(), knockback: 12, up: 6, stun: 0.35, color: 0xbfe8ff, silent: i % 2 === 1, onHitTarget: (t) => c.combat.applyStatus(t, 'shock', { stacks: 1, duration: 4 }) });
          this.addVoltage(2);
          if (i % 3 === 0) { flash(c, 0.12, 0xdff2ff); c.camera.addShake(0.18); }
        });
        const central = (big) => {
          slow(c, big ? 0.3 : 0.16, 0.32); flash(c, big ? 0.95 : 0.55, 0xffffff); c.combat.hitstop(big ? 0.18 : 0.08); c.camera.addShake(big ? 2.6 : 1.4);
          for (let k = 0; k < 5; k++) c.vfx.bolt(gp.clone().add(_up.clone().multiplyScalar(58 + k * 4)), gp.clone(), { color: k ? 0x8fdcff : 0xffffff, core: 0xffffff, branches: 10 - k, life: 0.4, jitter: 1.9 });
          c.vfx.ribbon(gp.clone().add(_up.clone().multiplyScalar(54)), gp.clone(), { width: big ? 3 : 2, life: 0.4, color: 0xffffff });
          c.vfx.beam(() => gp.clone().add(_up.clone().multiplyScalar(44)), () => _up.clone().negate(), { length: 44, radius: big ? 5 : 3.5, life: 0.38, color: 0x8fdcff, core: 0xffffff });
          c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(2)), { kind: 'impact', size: big ? 42 : 30, life: 0.6, color: 0xffffff });
          for (let i = 0; i < 4; i++) this.schedule(i * 0.05, () => c.vfx.flipbook(gp.clone().add(_up), { kind: 'shock', size: (R + 4) + i * 6, life: 0.5, color: i % 2 ? 0xffffff : 0x9fdcff }));
          c.vfx.dome(gp.clone().add(_up), { radius: R + 5, life: 1.0, color: 0x8fdcff });
          c.vfx.crack(gp.clone(), { radius: R, count: 22, life: 3, color: 0x6fb8ff });
          c.vfx.burst(gp.clone().add(_up), { count: big ? 130 : 90, color: 0xffffff, color2: 0x6fb8ff, tile: 3, speed: 26, size: 0.46, life: 0.75, gravity: 3, drag: 1.5 });
          const seen = new Set();
          for (let w = 0; w < 6; w++) this.schedule(w * 0.03, () => {
            const rr = (w + 1) / 6 * R * 0.85;
            c.vfx.ring(gp, { color: w % 2 ? 0xffffff : 0x6fb8ff, radius: rr, life: 0.4, thickness: 0.9 });
            for (const t of c.combat.enemiesInRadius(gp, rr)) {
              if (seen.has(t)) continue; seen.add(t);
              const kk = 1 - t.center.distanceTo(gp) / R * 0.5;
              const dd = (big ? 110 : 78) * this._voltMul() * kk;
              t.takeHit({ damage: dd, dir: t.center.clone().sub(gp).setY(0.25).normalize(), knockback: 28 * kk, up: 13 * kk, stun: 0.8 });
              c.combat.hooks?.onDamageNumber?.(t.center.clone(), Math.round(dd));
              c.combat.applyStatus(t, 'shock', { stacks: 3, duration: 6 });
            }
          });
          for (const t of c.combat.enemiesInRadius(gp, R).slice(0, 5)) chainBolt(c, gp.clone().add(_up.clone().multiplyScalar(3)), t, { jumps: 8, dmg: 36 * this._voltMul(), range: 14 });
        };
        this.schedule(0.25 + N * 0.065 + 0.3, () => central(false));
        this.schedule(0.25 + N * 0.065 + 0.65, () => central(true));   // aftershock — the real hammer
      }
    };

    // === C — EL THOR: toggle a lightning-form (up to 6 s / 5 blinks). While
    // in form, press C to BLINK ~22 m — a searing trail zaps the whole path
    // and a sky-bolt slams a crater at the landing. Untouchable in form. ===
    this.slots.f = { name: 'El Thor', transform: true };

    // === V — TRUENO PRISIÓN: fire an orb; on hit it CAGES the target in a
    // colossal branching-lightning sphere — pulls nearby foes in, roots them,
    // ticks, then COLLAPSES into a huge blast that chains. Voltage-scaled. ===
    this.slots.v = {
      name: 'Trueno Prisión', cd: 8, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const o = c.controller.chest.clone();
        const foe = c.combat.nearestEnemies(c.controller.position, 1, 40)[0] || null;
        const dir = (foe ? foe.center.clone().sub(o) : c.aimDir.clone()).normalize();
        c.vfx.beam(() => o.clone(), () => dir.clone(), { length: 3.5, radius: 0.4, life: 0.14, color: 0x6fb8ff, core: 0xffffff });
        c.vfx.burst(o.clone().addScaledVector(dir, 0.9), { count: 16, color: 0xdff2ff, color2: 0x6fb8ff, tile: 3, speed: 15, size: 0.24, life: 0.18, gravity: 0, drag: 5, dir, cone: 0.4 });
        c.combat.spawnProjectile({
          pos: o.clone().addScaledVector(dir, 1.1), vel: dir.clone().multiplyScalar(50), gravity: 0,
          radius: 1.0, life: 1.5, damage: 18, aoe: 0, knockback: 4, up: 2, color: 0x8fdcff, trailColor: 0xdff2ff, mesh: ember(0x8fdcff, 0.7),
          onImpact: (p) => {
            const PR = 8, HOLD = 2.8;
            const tgt = c.combat.enemiesInRadius(p, PR).sort((a, b) => a.center.distanceTo(p) - b.center.distanceTo(p))[0] || null;
            const ctr = (tgt ? tgt.center.clone() : p.clone()); ctr.y = gY(c, ctr.x, ctr.z) + 1.5;
            slow(c, 0.18, 0.36); flash(c, 0.55, 0xdff2ff); c.combat.hitstop(0.11); c.camera.addShake(1.2);
            c.vfx.prison(() => (tgt && !tgt.dead ? tgt.center.clone() : ctr), { radius: PR, hold: HOLD, color: 0x8fdcff });
            for (let i = 0; i < 3; i++) c.vfx.bolt(ctr.clone().add(_up.clone().multiplyScalar(44 + i * 3)), ctr.clone(), { color: i ? 0x8fdcff : 0xffffff, core: 0xffffff, branches: 8 - i, life: 0.32, jitter: 1.7 });
            c.vfx.beam(() => ctr.clone(), () => _up.clone(), { length: 40, radius: 1.2, life: HOLD, color: 0x6fb8ff, core: 0xffffff });   // pillar of light for the hold
            c.vfx.dome(ctr.clone(), { radius: PR + 2, life: 0.6, color: 0xdff2ff });
            c.vfx.flipbook(ctr.clone(), { kind: 'impact', size: 16, life: 0.45, color: 0xffffff });
            for (let i = 0; i < 4; i++) this.schedule(i * 0.05, () => c.vfx.ring(ctr, { color: i % 2 ? 0xffffff : 0x6fb8ff, radius: PR + i * 3, life: 0.45 }));
            for (const t of c.combat.enemiesInRadius(ctr, PR + 7)) {
              const to = ctr.clone().sub(t.center).setY(0).normalize();
              if (t.impulse) t.impulse.addScaledVector(to, 44 / (t.mass || 1));
              t._stun = Math.max(t._stun || 0, HOLD * 0.85);
              c.combat.applyStatus(t, 'shock', { stacks: 2, duration: HOLD + 2 });
            }
            let z = 0;
            const zap = () => {
              z += 0.16;
              for (const t of c.combat.enemiesInRadius(ctr, PR)) {
                t.takeHit({ damage: 12 * this._voltMul(), dir: _up.clone(), knockback: 0, up: 0, stun: 0.3 });
                for (let k = 0; k < 2; k++) c.vfx.bolt(t.center.clone(), t.center.clone().add(_v.set((Math.random() - 0.5) * PR * 1.6, (Math.random() - 0.5) * PR * 1.6, (Math.random() - 0.5) * PR * 1.6)), { color: 0xbfe8ff, branches: 1, life: 0.1, jitter: 1.9 });
              }
              c.vfx.ring(ctr, { color: 0x9fdcff, radius: PR * (0.4 + Math.random() * 0.5), life: 0.16, y: 0.05 });
              if (z < HOLD) this.schedule(0.16, zap);
              else {
                const cc = (tgt && !tgt.dead ? tgt.center.clone() : ctr); cc.y = gY(c, cc.x, cc.z) + 1;
                slow(c, 0.2, 0.3); flash(c, 0.9, 0xffffff); c.combat.hitstop(0.16); c.camera.addShake(2.2);
                for (let i = 0; i < 4; i++) c.vfx.bolt(cc.clone().add(_up.clone().multiplyScalar(46 + i * 4)), cc.clone(), { color: i ? 0x8fdcff : 0xffffff, core: 0xffffff, branches: 9 - i, life: 0.36, jitter: 1.9 });
                c.vfx.flipbook(cc.clone().add(_up), { kind: 'impact', size: 34, life: 0.6, color: 0xffffff });
                for (let i = 0; i < 4; i++) this.schedule(i * 0.05, () => c.vfx.flipbook(cc.clone().add(_up), { kind: 'shock', size: 14 + i * 6, life: 0.5, color: i % 2 ? 0xffffff : 0x9fdcff }));
                c.vfx.dome(cc.clone(), { radius: 16, life: 0.7, color: 0xdff2ff });
                c.vfx.crack(cc.clone(), { radius: 13, count: 18, life: 2, color: 0x6fb8ff });
                c.vfx.burst(cc.clone(), { count: 120, color: 0xffffff, color2: 0xdff2ff, tile: 3, speed: 30, size: 0.44, life: 0.75, gravity: 3, drag: 1.4 });
                for (let i = 0; i < 3; i++) this.schedule(i * 0.04, () => c.vfx.ring(cc, { color: i % 2 ? 0xffffff : 0x6fb8ff, radius: 8 + i * 5, life: 0.5 }));
                c.combat.areaStrike(cc, { radius: 14, damage: 110 * this._voltMul(), knockback: 34, up: 14, stun: 0.9, color: 0xbfe8ff, shake: 1.0 });
                for (const t of c.combat.enemiesInRadius(cc, 18).slice(0, 5)) chainBolt(c, cc, t, { jumps: 5, dmg: 42 * this._voltMul(), range: 12 });
              }
            };
            zap();
            this.addVoltage(12);
          }
        });
      }
    };

    // === T — JUICIO FINAL: a titanic sphere of storm-energy assembles high
    // overhead, charges, then CRASHES with slow-mo — colossal crater, scattered
    // "flower" detonations, and a chain-web through the survivors. Dumps all
    // Voltaje for a bonus. ===
    this.slots.ult = {
      name: 'Juicio Final', cd: 28, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = ahead(c, 13); gp.y = gY(c, gp.x, gp.z);
        const R = 24;
        const spent = this.voltage; this.voltage = 0;
        const mul = 1 + spent / 40;
        c.camera.addShake(0.35); flash(c, 0.16, 0xdff2ff);
        c.vfx.storm(gp.clone(), { radius: R + 5, height: 36, duration: 4, color: 0x0d1424 });
        c.vfx.decal(gp.clone(), { kind: 'scorch', radius: R, life: 12, groundY: gp.y });
        for (let i = 0; i < 6; i++) this.schedule(0.1 + i * 0.14, () => c.vfx.ring(gp, { color: i % 2 ? 0xffffff : 0x6fb8ff, radius: R * 0.7, life: 0.5 }));
        const orb = ember(0xdff2ff, 2.6); orb.scale.setScalar(0.2);
        const HOV = gp.clone().add(_up.clone().multiplyScalar(92));
        orb.position.copy(HOV); c.scene.add(orb);
        for (let i = 0; i < 5; i++) this.schedule(i * 0.1, () => c.vfx.ring(HOV.clone(), { color: 0x9fdcff, radius: 8 - i, life: 0.9, vertical: true }));
        let t = 0; const HOVER = 0.5, FALL = 0.5;
        const tgtP = gp.clone().add(_up.clone().multiplyScalar(3));
        let smFired = false;
        const fall = () => {
          t += 1 / 60;
          if (t < HOVER) {
            orb.scale.setScalar(0.2 + (t / HOVER) * 1.1);
            orb.position.y = HOV.y + Math.sin(t * 8) * 0.7;
            if ((t * 60) % 3 < 1) {
              c.vfx.burst(orb.position.clone(), { count: 5, color: 0xdff2ff, color2: 0x6fb8ff, tile: 4, speed: 7, size: 0.7, life: 0.5, gravity: 0, drag: 2 });
              c.vfx.bolt(orb.position.clone(), orb.position.clone().add(_v.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8)), { color: 0x8fdcff, branches: 2, life: 0.14, jitter: 1.5 });
            }
          } else {
            const k = Math.min(1, (t - HOVER) / FALL);
            orb.position.lerpVectors(HOV, tgtP, k * k * k);
            orb.scale.setScalar(1.3 + k * 0.6);
            c.camera.addShake(0.05 + k * 0.28);
            c.vfx.ribbon(orb.position.clone().add(_up.clone().multiplyScalar(5)), orb.position.clone(), { width: 1.5, life: 0.3, color: 0xffffff });
            c.vfx.burst(orb.position.clone(), { count: 10, color: 0xffffff, color2: 0x9fdcff, tile: 3, speed: 10, size: 0.8, life: 0.4, gravity: 0, drag: 1.2 });
            if (!smFired && k > 0.5) { smFired = true; slow(c, 0.45, 0.28); }
            if (k >= 1) { impact(); return; }
          }
          requestAnimationFrame(fall);
        };
        const impact = () => {
          c.scene.remove(orb); orb.geometry.dispose(); orb.material.dispose();
          flash(c, 0.95, 0xffffff); c.combat.hitstop(0.22); c.camera.addShake(2.8);
          for (let k = 0; k < 4; k++) c.vfx.bolt(gp.clone().add(_up.clone().multiplyScalar(58 + k * 4)), gp.clone(), { color: k ? 0x8fdcff : 0xffffff, core: 0xffffff, branches: 9 - k, life: 0.42, jitter: 1.9 });
          c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(2)), { kind: 'impact', size: R * 1.7, life: 0.65, color: 0xffffff });
          for (let i = 0; i < 5; i++) this.schedule(i * 0.06, () => c.vfx.flipbook(gp.clone().add(_up), { kind: 'shock', size: (R + 6) + i * 7, life: 0.5, color: i % 2 ? 0xffffff : 0x9fdcff }));
          c.vfx.dome(gp.clone().add(_up), { radius: R + 8, life: 1.1, color: 0xffffff });
          c.vfx.beam(() => gp.clone().add(_up.clone().multiplyScalar(36)), () => _up.clone().negate(), { length: 36, radius: 6, life: 0.45, color: 0x8fdcff, core: 0xffffff });
          c.vfx.crack(gp.clone(), { radius: R, count: 24, life: 3, color: 0x6fb8ff });
          c.vfx.burst(gp.clone().add(_up.clone().multiplyScalar(1.5)), { count: 130, color: 0xffffff, color2: 0xdff2ff, tile: 4, speed: 12, size: 1.1, life: 0.5, gravity: 0, drag: 3 });
          const seen = new Set();
          for (let w = 0; w < 7; w++) this.schedule(w * 0.03, () => {
            const rr = (w + 1) / 7 * R;
            c.vfx.ring(gp, { color: w % 2 ? 0xffffff : 0x6fb8ff, radius: rr, life: 0.5, thickness: 0.9 });
            for (const t of c.combat.enemiesInRadius(gp, rr)) {
              if (seen.has(t)) continue; seen.add(t);
              const kk = 1 - t.center.distanceTo(gp) / R * 0.5;
              t.takeHit({ damage: 220 * mul * kk, dir: t.center.clone().sub(gp).setY(0.25).normalize(), knockback: 42 * kk, up: 16 * kk, stun: 1.4 });
              c.combat.hooks?.onDamageNumber?.(t.center.clone(), Math.round(220 * mul * kk));
              c.combat.applyStatus(t, 'shock', { stacks: 3, duration: 6 });
            }
          });
          for (let i = 0; i < 12; i++) this.schedule(0.1 + Math.random() * 0.35 + i * 0.05, () => {
            const a = Math.random() * 6.283, rr = R * (0.3 + Math.random() * 0.65);
            const sp = gp.clone().add(_v.set(Math.cos(a) * rr, 0, Math.sin(a) * rr)); sp.y = gY(c, sp.x, sp.z);
            c.vfx.bolt(sp.clone().add(_up.clone().multiplyScalar(22)), sp.clone(), { color: 0xbfe8ff, core: 0xffffff, branches: 3, life: 0.2, jitter: 1.4 });
            c.vfx.flipbook(sp.clone().add(_up), { kind: 'impact', size: 9, life: 0.4, color: 0xdff2ff });
            c.vfx.burst(sp.clone().add(_up), { count: 40, color: 0xffffff, color2: 0x9fdcff, tile: 4, speed: 16, size: 0.7, life: 0.45, gravity: 2, drag: 2 });
            c.vfx.dome(sp.clone(), { radius: 5, life: 0.35, color: 0xdff2ff });
            c.combat.areaStrike(sp, { radius: 6, damage: 60 * mul, knockback: 22, up: 9, stun: 0.4, color: 0xbfe8ff, silent: i % 2 === 1 });
            flash(c, 0.12, 0xdff2ff); c.camera.addShake(0.5);
          });
          this.schedule(0.3, () => { for (const t of c.combat.enemiesInRadius(gp, R).slice(0, 6)) chainBolt(c, gp.clone().add(_up.clone().multiplyScalar(3)), t, { jumps: 99, dmg: 60 * mul, range: 20 }); });
          this.schedule(0.5, () => c.vfx.hazard(gp.clone(), { kind: 'frost', radius: R * 0.8, duration: 4.5, groundY: gp.y, onTick: (ctr, r) => { for (const t of c.combat.enemiesInRadius(ctr, r)) { t.takeHit({ damage: 8, dir: null, knockback: 0, up: 0, stun: 0.25 }); c.combat.applyStatus(t, 'shock', { duration: 3 }); } c.vfx.bolt(ctr.clone().add(_v.set((Math.random()-0.5)*r,0.2,(Math.random()-0.5)*r)), ctr.clone().add(_v.set((Math.random()-0.5)*r,0.2,(Math.random()-0.5)*r)), { color: 0x8fdcff, branches: 1, life: 0.1, jitter: 1.6 }); }, onEmit: (ep) => c.vfx.burst(ep, { count: 2, color: 0x8fdcff, color2: 0xffffff, tile: 3, speed: 3, size: 0.3, life: 0.5, gravity: 3, drag: 2, dir: _up, cone: 0.5 }) }));
          smoke(c, gp.clone().add(_up.clone().multiplyScalar(6)), 44);
        };
        fall();
      }
    };
  }

  _voltMul() { return 1 + this.voltage / 90; }
  _voltJumps() { return 2 + Math.floor(this.voltage / 22); }
  addVoltage(n) { this.voltage = Math.max(0, Math.min(this.voltageMax, (this.voltage || 0) + n)); }
  _fieldActive(c) { return this._field && c.elapsed < this._field.until; }
  hudPips() { return this.transformed ? this._thorBlinks : Math.min(4, Math.floor(this.voltage / 25)); }
  hudBar() { return this.transformed ? (this._boltT || 0) / 7 : (this.voltage || 0) / this.voltageMax; }

  /* one El Thor blink: sear the path, land in a bolt-struck crater */
  _thorBlink(c) {
    if ((this._thorBlinks || 0) <= 0) return;
    this._thorBlinks--;
    const startC = c.controller.chest.clone();
    const dir = c.aimDir.clone(); dir.y *= 0.15; dir.normalize();
    const dest = c.controller.position.clone().addScaledVector(dir, 24);
    const g = c.world.sampleGround(dest.x, dest.z);
    dest.y = (g.onLand ? g.height : 0) + 0.05;
    c.controller.teleport(dest);
    c.controller.velocity.set(dir.x * 8, 3, dir.z * 8);
    c.controller.faceLockYaw = Math.atan2(dir.x, dir.z); c.controller.faceLock = 0.4;
    c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.4);
    const here = c.controller.chest.clone();
    for (let i = 0; i < 3; i++) c.vfx.bolt(startC.clone(), here.clone(), { color: i ? 0x8fdcff : 0xffffff, core: 0xffffff, branches: 4 - i, life: 0.22, jitter: 1.2 });
    c.vfx.ribbon(startC.clone(), here.clone(), { width: 0.7, life: 0.32, color: 0x9fdcff });
    c.vfx.beam(() => startC.clone(), () => here.clone().sub(startC).normalize(), { length: startC.distanceTo(here), radius: 0.5, life: 0.16, color: 0x6fb8ff, core: 0xffffff });
    c.vfx.burst(startC.clone(), { count: 18, color: 0xdff2ff, color2: 0x6fb8ff, tile: 3, speed: 14, size: 0.3, life: 0.35, gravity: 0, drag: 4 });
    c.vfx.burst(here.clone(), { count: 24, color: 0xffffff, color2: 0x9fdcff, tile: 3, speed: 16, size: 0.34, life: 0.4, gravity: 2, drag: 3 });
    for (let i = 1; i <= 5; i++) {
      const pp = startC.clone().lerp(here, i / 5);
      c.combat.areaStrike(pp, { radius: 3.2, damage: 30 * this._voltMul(), knockback: 14, up: 4, stun: 0.35, color: 0xbfe8ff, silent: i < 5, onHitTarget: (t) => c.combat.applyStatus(t, 'shock', { stacks: 2, duration: 4 }) });
    }
    const gp = c.controller.position.clone(); gp.y = gY(c, gp.x, gp.z);
    for (let k = 0; k < 2; k++) c.vfx.bolt(gp.clone().add(_up.clone().multiplyScalar(46 + k * 4)), gp.clone(), { color: k ? 0x8fdcff : 0xffffff, core: 0xffffff, branches: 5 - k, life: 0.26, jitter: 1.4 });
    c.vfx.flipbook(gp.clone().add(_up), { kind: 'impact', size: 14, life: 0.42, color: 0xffffff });
    c.vfx.crack(gp.clone(), { radius: 5.5, count: 9, life: 1.5, color: 0x6fb8ff });
    c.vfx.dome(gp.clone().add(_up), { radius: 6, life: 0.4, color: 0xdff2ff });
    for (let i = 0; i < 2; i++) c.vfx.ring(gp, { color: i ? 0xffffff : 0x6fb8ff, radius: 4 + i * 3, life: 0.35 });
    c.vfx.burst(gp.clone().add(_up), { count: 34, color: 0xdff2ff, color2: 0x6fb8ff, tile: 3, speed: 15, size: 0.34, life: 0.5, gravity: 3, drag: 1.6 });
    c.combat.areaStrike(gp, { radius: 7, damage: 50 * this._voltMul(), knockback: 22, up: 8, stun: 0.55, color: 0xbfe8ff, shake: 0.55, onHitTarget: (t) => c.combat.applyStatus(t, 'shock', { stacks: 3, duration: 5 }) });
    c.vfx.flipbook(gp.clone().add(_up), { kind: 'impact', size: 18, life: 0.4, color: 0xffffff });
    c.vfx.beam(() => gp.clone().add(_up.clone().multiplyScalar(30)), () => _up.clone().negate(), { length: 30, radius: 2, life: 0.28, color: 0x8fdcff, core: 0xffffff });
    const near = c.combat.nearestEnemies(gp, 1, 9)[0];
    if (near) chainBolt(c, gp, near, { jumps: this._voltJumps(), dmg: 20 * this._voltMul(), range: 8 });
    this.addVoltage(5);
    c.combat.hitstop(0.03); flash(c, 0.22, 0xdff2ff); c.camera.addShake(0.3);
    if (this._thorBlinks <= 0) this.forceRevert(c);
  }

  /** C while in El Thor form = a blink, not a fresh cast. */
  use(key, ctx) {
    if (key === 'f' && this.transformed) { this._thorBlink(ctx); return true; }
    return super.use(key, ctx);
  }

  onForm(c, on) {
    if (on) {
      this._ctx = c;
      this._boltT = 7.0;
      this._thorBlinks = 6;
      c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.6);
      slow(c, 0.08, 0.5); flash(c, 0.28, 0xdff2ff); c.camera.addShake(0.4);
      c.vfx.flipbook(c.controller.chest.clone(), { kind: 'shock', size: 12, life: 0.4, color: 0xffffff });
      c.vfx.beam(() => c.controller.chest.clone(), () => _up.clone(), { length: 8, radius: 0.8, life: 0.35, color: 0x6fb8ff, core: 0xffffff });
      c.vfx.burst(c.controller.chest, { count: 36, color: 0xdff2ff, color2: 0x8fdcff, tile: 3, speed: 17, size: 0.32, life: 0.45, gravity: 0, drag: 4 });
      for (let i = 0; i < 4; i++) this.schedule(i * 0.05, () => c.vfx.bolt(c.controller.chest.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3.4, 3, (Math.random() - 0.5) * 3.4)), c.controller.chest.clone(), { color: 0x8fdcff, core: 0xffffff, branches: 2, life: 0.15, jitter: 1.5 }));
      this._thorBlink(c);   // the cast itself blinks once
    } else {
      this._boltT = 0; this._thorBlinks = 0;
      c.vfx.burst(c.controller.chest, { count: 18, color: 0xdff2ff, speed: 6, size: 0.24, life: 0.4, gravity: 4, drag: 3 });
    }
  }

  update(dt) {
    super.update(dt);
    if (this.voltage > 0) this.voltage = Math.max(0, this.voltage - dt * 4);
    const c = this._ctx;
    if (!c) return;
    if (this.transformed && this._boltT > 0) {
      this._boltT -= dt;
      c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.2);
      this._bfx = (this._bfx || 0) + dt;
      if (this._bfx > 0.07) {
        this._bfx = 0;
        const ch = c.controller.chest.clone();
        c.vfx.burst(ch.clone().add(_v.set((Math.random() - 0.5) * 1.8, (Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 1.8)), { count: 2, color: 0xdff2ff, color2: 0x8fdcff, tile: 3, speed: 7, size: 0.26, life: 0.25, gravity: 0, drag: 4 });
        if (Math.random() < 0.5) c.vfx.bolt(ch.clone(), ch.clone().add(_v.set((Math.random() - 0.5) * 2.6, (Math.random() - 0.5) * 2.6, (Math.random() - 0.5) * 2.6)), { color: 0xbfe8ff, branches: 1, life: 0.09, jitter: 1.8 });
      }
      if (this._boltT <= 0) this.forceRevert(c);
    }
  }
}

/* ================================================================ *
 *  LEGENDARIO — Gura Gura (Temblor). Paramecia. Ult: Choque de Mares.
 * ================================================================ */
const QK = 0xa89ec4, QK_LT = 0xd9d0ee, QK_DK = 0x5a4f78;

export class GuraGura extends DevilFruit {
  constructor() {
    super('Gura Gura', QK, { rarity: 'legendario', type: 'paramecia', passive: 'El poder más destructivo · temblor al aterrizar · los golpes AGRIETAN EL AIRE (Sacudida)' });

    // === Z — TORMENTA DE MAREMOTO: a colossal CYCLONE spins around you for
    // 5 s — a sweeping gale arm whips round and round, catching every enemy
    // that gets near, spinning them, then HURLING them all far outward. ===
    this.slots.q = {
      name: 'Tormenta de Maremoto', cd: 11, _t: 0,
      cast: (c) => {
        c.pose('slam');
        const RAD = 11, DUR = 5.0, SPIN = 3.4;     // rad/s of the sweep arm
        c.combat.hitstop(0.05); c.camera.addShake(0.7); flash(c, 0.2, QK_LT);
        airCrack(c, c.controller.chest.clone().add(_up), { size: 12, count: 7, life: 0.8, color: QK_LT });
        c.vfx.tornado(c.controller.position.clone(), { radius: RAD * 0.55, height: 9, life: DUR, blades: 10, color: QK_LT });
        const caught = new Set();
        let el = 0, ang = 0, reFx = -1, reTor = 0;
        const gust = () => {
          const dt = 0.06;
          el += dt; ang += SPIN * dt;
          const chest = c.controller.chest.clone();
          const sd = _v.set(Math.cos(ang), 0, Math.sin(ang)).clone();          // sweep-arm direction
          const tan = new THREE.Vector3(-sd.z, 0, sd.x);                       // tangential (spin) direction
          // the whirling gale arm
          if (el - reFx > 0.28) { reFx = el; c.vfx.windGust(chest.clone(), { dir: sd.clone(), length: RAD + 4, width: 5.5, life: 0.85, color: 0xdfe6f2 }); }
          if (el - reTor > 0.9) { reTor = el; c.vfx.tornado(c.controller.position.clone(), { radius: RAD * 0.55, height: 9, life: 1.4, blades: 10, color: QK_LT }); }
          c.vfx.ring(c.controller.position.clone(), { color: QK_LT, radius: RAD, life: 0.18, y: 0.1 });
          c.vfx.burst(chest.clone().addScaledVector(sd, RAD * (0.4 + Math.random() * 0.6)).add(_v.set(0, Math.random() * 3, 0)),
            { count: 8, color: 0xdfe6f2, color2: 0x8a8296, tile: 7, speed: 26, size: 0.4, life: 0.5, gravity: 1, drag: 0.9, dir: tan, cone: 0.5 });
          c.camera.addShake(0.05);
          // catch everyone near you and spin them
          const lift = 5 + (el / DUR) * 5;           // rises through the funnel...
          for (const t of c.combat.enemiesInRadius(c.controller.chest, RAD + 1.5)) {
            caught.add(t);
            const out = t.center.clone().sub(chest).setY(0);
            if (out.lengthSq() < 0.01) out.set(1, 0, 0);
            out.normalize();
            if (t.impulse) t.impulse.addScaledVector(tan.clone().addScaledVector(out, 0.28).setY(0.12).normalize(), 40 / (t.mass || 1));
            const alt = t.center.y - gY(c, t.center.x, t.center.z);
            if (alt < 6 + (el / DUR) * 3) t.velocity.y = Math.max(t.velocity.y, lift);   // ...but capped — hovers, whirling
            else t.velocity.y = Math.min(t.velocity.y, 1.5);
            t._stun = Math.max(t._stun || 0, 0.4);
            t.takeHit({ damage: 6, dir: null, knockback: 0, up: 0, stun: 0.3 });
            c.combat.applyStatus(t, 'quake', { stacks: 1, duration: 4 });
            c.vfx.burst(t.center.clone(), { count: 3, color: 0xdfe6f2, tile: 7, speed: 10, size: 0.3, life: 0.25, gravity: 0, drag: 2, dir: tan, cone: 0.6 });
          }
          if (el < DUR) this.schedule(dt, gust);
          else {
            const chest2 = c.controller.chest.clone();
            slow(c, 0.16, 0.34); flash(c, 0.5, QK_LT); c.combat.hitstop(0.14); c.camera.addShake(1.7);
            for (let k = 0; k < 6; k++) c.vfx.windGust(chest2.clone(), { dir: _v.set(Math.cos(k * 1.05), 0, Math.sin(k * 1.05)).clone(), length: RAD + 12, width: 7, life: 0.6, color: 0xffffff });
            c.vfx.flipbook(chest2.clone().add(_up), { kind: 'shock', size: RAD * 2.8, life: 0.5, color: 0xffffff });
            c.vfx.dome(chest2.clone(), { radius: RAD + 5, life: 0.55, color: 0xffffff });
            for (const t of caught) {
              if (t.dead) continue;
              const away = t.center.clone().sub(chest2).setY(0).normalize();
              if (t.impulse) t.impulse.addScaledVector(away, 40 / (t.mass || 1));   // extra outward shove past the base knockback
              t.velocity.y = Math.max(t.velocity.y, 26);
              t.takeHit({ damage: 60, dir: away.clone().setY(0.55).normalize(), knockback: 140, up: 40, stun: 1.3 });
              c.combat.hooks?.onDamageNumber?.(t.center.clone(), 60);
              c.combat.applyStatus(t, 'quake', { stacks: 2, duration: 5 });
              c.vfx.burst(t.center.clone(), { count: 20, color: 0xffffff, color2: QK_LT, tile: 7, speed: 30, size: 0.4, life: 0.6, gravity: 6, drag: 0.9, dir: away.clone().setY(0.4).normalize(), cone: 0.6 });
            }
          }
        };
        this.schedule(0.08, gust);
      }
    };

    // === X — FRACTURA DEL MUNDO: a seismic rip tears along the ground AND the
    // air above it, ending in a combined earth + air shatter. ===
    this.slots.e = {
      name: 'Fractura del Mundo', cd: 6, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const d = c.forwardFlat.clone();
        const from = _v.set(c.controller.position.x, gY(c, c.controller.position.x, c.controller.position.z), c.controller.position.z).clone().addScaledVector(d, 1.5);
        const LEN = 18, GROW = 0.3;
        c.camera.addShake(0.4); c.combat.hitstop(0.04); flash(c, 0.14, QK_LT);
        c.vfx.fracture(from.clone(), d.clone(), { length: LEN, width: 4.4, grow: GROW, life: 3.4, color: QK_LT, groundY: from.y });
        const STEPS = 7;
        for (let i = 1; i <= STEPS; i++) this.schedule((i / STEPS) * GROW, () => {
          const p = from.clone().addScaledVector(d, (i / STEPS) * LEN); p.y = gY(c, p.x, p.z);
          c.combat.areaStrike(p, { radius: 4.2, damage: 40, knockback: 26, up: 9, stun: 0.42, color: QK, silent: i < STEPS, onHitTarget: (t) => c.combat.applyStatus(t, 'quake', { stacks: 1, duration: 4 }) });
          c.vfx.burst(p.clone().add(_up), { count: 16, color: 0x8a8296, color2: 0x5a5266, tile: 2, speed: 10, size: 0.6, life: 0.7, gravity: 12, drag: 1.3, dir: _up, cone: 1.2 });
          c.vfx.quakeRing(p.clone(), { radius: 5, life: 0.26, thickness: 0.45, color: QK_LT, y: 0.1 });
          if (i % 2 === 1) airCrack(c, p.clone().add(_up.clone().multiplyScalar(2.2)), { size: 5, count: 4, life: 0.7, color: QK_LT });
        });
        this.schedule(GROW + 0.04, () => {
          const end = from.clone().addScaledVector(d, LEN); end.y = gY(c, end.x, end.z);
          slow(c, 0.12, 0.42); flash(c, 0.3, QK_LT); c.combat.hitstop(0.1); c.camera.addShake(0.9);
          airCrack(c, end.clone().add(_up.clone().multiplyScalar(2.5)), { size: 12, count: 7, life: 0.9, color: 0xe4dcf2 });
          c.vfx.shatter(end.clone(), { radius: 11, count: 12, life: 3, groundY: end.y, color: 0x2a2634 });
          c.combat.areaStrike(end, { radius: 11, damage: 100, knockback: 48, up: 16, stun: 0.8, color: QK, shake: 0.8, onHitTarget: (t) => c.combat.applyStatus(t, 'quake', { stacks: 2, duration: 5 }) });
          c.vfx.dome(end.clone().add(_up), { radius: 12, life: 0.5, color: QK });
          for (let j = 0; j < 3; j++) this.schedule(j * 0.06, () => c.vfx.quakeRing(end.clone(), { radius: 10 + j * 5, life: 0.5 + j * 0.1, thickness: 0.7, color: j % 2 ? QK_LT : QK }));
          c.vfx.crack(end.clone(), { radius: 13, count: 14, life: 2.6, ground: true, color: QK_LT });
          c.vfx.decal(end.clone(), { kind: 'crack', radius: 11, life: 9, groundY: end.y });
          debrisRing(c, end, 7, 22);
        });
      }
    };

    // === C — SALTO SÍSMICO: leap and CRASH — a wide ground quake + the air
    // shatters at the landing. ===
    this.slots.f = {
      name: 'Salto Sísmico', cd: 6.0, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const d = c.aimDir.clone(); d.y = 0; d.normalize();
        c.controller.velocity.set(d.x * 12, 18, d.z * 12);
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.7);
        let t = 0;
        const arc = () => {
          t += 1 / 60;
          const p = c.controller.position.clone();
          if (t < 1.0 && !(c.controller.grounded && t > 0.25)) {
            if ((t * 60) % 2 < 1) c.vfx.burst(p.clone().add(_up.clone().multiplyScalar(0.5)), { count: 3, color: 0x8a8296, color2: QK, tile: 2, speed: 3, size: 0.42, life: 0.5, gravity: 3, drag: 1.5, dir: _up.clone().negate(), cone: 1.2 });
            if (t > 0.32) c.controller.velocity.y -= 70 / 60;
            requestAnimationFrame(arc); return;
          }
          const gp = _v.set(p.x, gY(c, p.x, p.z), p.z).clone();
          const R = 18;
          slow(c, 0.12, 0.42); flash(c, 0.3, QK_LT); c.combat.hitstop(0.1); c.camera.addShake(1.3);
          airCrack(c, gp.clone().add(_up.clone().multiplyScalar(2.5)), { size: 13, count: 8, life: 0.9, color: 0xe4dcf2 });
          const seen = new Set();
          for (let i = 0; i < 4; i++) this.schedule(i * 0.07, () => {
            const rr = (i + 1) / 4 * R;
            c.vfx.quakeRing(gp.clone(), { radius: rr, life: 0.55 + i * 0.1, thickness: 0.8, color: i % 2 ? QK_LT : QK });
            c.vfx.ring(gp.clone(), { color: QK_LT, radius: rr, life: 0.45 });
            for (const t2 of c.combat.enemiesInRadius(gp, rr)) {
              if (seen.has(t2)) continue; seen.add(t2);
              t2.takeHit({ damage: 85, dir: t2.center.clone().sub(gp).setY(0.22).normalize(), knockback: 52, up: 13, stun: 0.85 });
              c.combat.hooks?.onDamageNumber?.(t2.center.clone(), 85);
              c.combat.applyStatus(t2, 'quake', { stacks: 2, duration: 5 });
            }
          });
          c.vfx.dome(gp.clone().add(_up), { radius: R, life: 0.55, color: QK });
          c.vfx.crack(gp.clone(), { radius: R, count: 18, life: 3.6, ground: true, color: QK_LT });
          c.vfx.decal(gp.clone(), { kind: 'crack', radius: R, life: 11, groundY: gp.y });
          debrisRing(c, gp, R * 0.7, 28);
          c.vfx.burst(gp.clone().add(_up), { count: 56, color: 0x8a8296, color2: 0x5a5266, tile: 2, speed: 9, size: 0.9, life: 1.3, gravity: 6, drag: 1.3, dir: _up, cone: 2.0 });
        };
        arc();
      }
    };

    // === V — ONDA DE CHOQUE: grab the air ahead and RIP it — a travelling
    // wall of fractured space rushes ~26 m forward, shattering on everything,
    // with a colossal knockback. ===
    this.slots.v = {
      name: 'Onda de Choque', cd: 8, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const d = c.forwardFlat.clone();
        const right = _v.set(d.z, 0, -d.x).normalize().clone();
        const origin = c.controller.position.clone();
        c.camera.addShake(0.35); flash(c, 0.16, QK_LT); c.combat.hitstop(0.04);
        c.vfx.seaClash(origin.clone().addScaledVector(d, 10), { dir: d.clone(), width: 22, height: 12, life: 1.4 });
        const seen = new Set();
        const STEPS = 12, GAP = 2.2;
        let n = 0;
        const roll = () => {
          const front = origin.clone().addScaledVector(d, 4 + n * GAP);
          const gy = gY(c, front.x, front.z);
          for (let s = -1; s <= 1; s++) airCrack(c, front.clone().addScaledVector(right, s * 5).add(_up.clone().multiplyScalar(1.6 + Math.abs(s))), { size: 6, count: 4, life: 0.55, color: QK_LT });
          c.vfx.quakeRing(_v.set(front.x, gy, front.z).clone(), { radius: 6, life: 0.28, thickness: 0.5, color: QK_LT, y: 0.1 });
          c.vfx.burst(_v.set(front.x, gy + 0.4, front.z).clone(), { count: 16, color: 0x8a8296, color2: 0x5a5266, tile: 2, speed: 12, size: 0.6, life: 0.5, gravity: 10, drag: 1.4, dir: _up, cone: 1.1 });
          for (const t of c.combat.enemiesInRadius(front, 6)) {
            if (seen.has(t)) continue; seen.add(t);
            t.takeHit({ damage: 44, dir: d.clone().setY(0.2).normalize(), knockback: 60, up: 12, stun: 0.55 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 44);
            c.combat.applyStatus(t, 'quake', { stacks: 2, duration: 5 });
            c.combat.hitstop(0.02);
          }
          if (++n < STEPS) this.schedule(0.045, roll);
          else {
            const brk = origin.clone().addScaledVector(d, 4 + STEPS * GAP); brk.y = gY(c, brk.x, brk.z);
            slow(c, 0.12, 0.42); flash(c, 0.3, QK_LT); c.combat.hitstop(0.09); c.camera.addShake(1.0);
            airCrack(c, brk.clone().add(_up.clone().multiplyScalar(3)), { size: 16, count: 9, life: 1.0, color: 0xe4dcf2 });
            c.vfx.shatter(brk.clone(), { radius: 12, count: 14, life: 3, groundY: brk.y, color: 0x2a2634 });
            c.combat.areaStrike(brk, { radius: 12, damage: 90, knockback: 55, up: 16, stun: 0.9, color: QK, shake: 0.9 });
          }
        };
        this.schedule(0.14, roll);
      }
    };

    // T — El Fin del Mundo: charge, then the whole SKY cracks and shatters,
    // the ground caves into plates, and the world quakes itself apart.
    this.slots.ult = {
      name: 'El Fin del Mundo', cd: 32, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp0 = _v.set(c.controller.position.x, gY(c, c.controller.position.x, c.controller.position.z), c.controller.position.z).clone();
        const R = 28;
        const cd0 = c.camera.wantDistance;
        c.camera.addShake(0.2);
        c.camera.wantDistance = 3.4;                      // dramatic zoom-in

        // PHASE 1 — charge-up: emissive pulse + dust pulled inward + cracks
        const saved = [];
        c.character?.root.traverse((o) => { if (o.isMesh && o.material && o.material.color && !o.name.endsWith('__outline')) saved.push([o.material, o.material.color.clone()]); });
        const chargeTick = (n) => {
          if (n > 12) return;
          const p = c.controller.chest.clone();
          const pulse = 0.4 + 0.4 * Math.sin(n * 0.9);
          saved.forEach(([m, col]) => m.color.copy(col).lerp(new THREE.Color(QK_LT), pulse * 0.6));
          const a = Math.random() * 6.283, rr = 8 + Math.random() * 7;
          const from = p.clone().add(_v.set(Math.cos(a) * rr, Math.random() * 2, Math.sin(a) * rr));
          c.vfx.burst(from, { count: 2, color: 0x8a8296, color2: QK, tile: 2, speed: 15, size: 0.4, life: 0.4, gravity: 0, drag: 0.6, dir: p.clone().sub(from).normalize(), cone: 0.2 });
          if (n % 3 === 0) c.vfx.crack(gp0.clone(), { radius: 3 + n * 0.5, count: 4, life: 1.5, ground: true, color: QK_DK });
          c.camera.addShake(0.05 + n * 0.02);
          this.schedule(0.07, () => chargeTick(n + 1));
        };
        chargeTick(0);

        // PHASE 2 — the strike
        this.schedule(0.9, () => {
          saved.forEach(([m, col]) => m.color.copy(col));
          const gp = _v.set(c.controller.position.x, gY(c, c.controller.position.x, c.controller.position.z), c.controller.position.z).clone();
          c.camera.wantDistance = 9;                      // snap zoom-out to reveal scale
          flash(c, 0.95, 0xffffff); slow(c, 0.6, 0.26);
          c.combat.hitstop(0.28); c.camera.addShake(3.4, 1.8);   // apocalyptic
          // THE SKY CRACKS — a lattice of air-fractures across the whole zone, then shatters
          airCrack(c, gp.clone().add(_up.clone().multiplyScalar(6)), { size: 34, count: 14, life: 1.3, color: 0xf0eaff });
          for (let i = 0; i < 8; i++) this.schedule(Math.random() * 0.25, () => { const a = Math.random() * 6.283, rr = Math.random() * R; airCrack(c, gp.clone().add(_v.set(Math.cos(a) * rr, 2 + Math.random() * 8, Math.sin(a) * rr)), { size: 8 + Math.random() * 8, count: 5, life: 1.0, color: QK_LT }); });
          c.vfx.shatter(gp.clone(), { radius: R, count: 30, life: 4, groundY: gp.y, color: 0x2a2634 });
          // ===== TSUNAMI — real water erupts outward as a shock-wave =====
          for (let k = 0; k < 4; k++) {
            const a = k * Math.PI / 2 + 0.4;
            const wd = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
            this.schedule(k * 0.03, () => c.vfx.seaClash(gp.clone().addScaledVector(wd, 3), { dir: wd, width: R * 2.1, height: 22, life: 2.0 }));
          }
          c.vfx.waterShock(gp.clone(), { maxRadius: R + 12, life: 1.9, groundY: gp.y });   // wet-ground wash under it
          // the real thing: a 3-D wall of water rears up into a curling crest and rolls out
          c.vfx.waterWave(gp.clone(), {
            maxR: R + 14, width: 5.5, crest: 4.2, life: 1.7, groundY: gp.y,
            spray: (p) => c.vfx.burst(p, { count: 4, color: 0xeaf6ff, color2: 0x2f74c8, tile: 2, speed: 9, size: 0.4, life: 0.8, gravity: 16, drag: 1.1, dir: _up, cone: 1.1 })
          });
          this.schedule(0.16, () => c.vfx.waterWave(gp.clone(), { maxR: R + 8, width: 4, crest: 2.8, life: 1.5, groundY: gp.y, body: 0x3f8fe0 }));
          c.vfx.splash(gp.clone().add(_up), 3.2);
          for (let i = 0; i < 3; i++) this.schedule(i * 0.08, () => c.vfx.burst(gp.clone().add(_up.clone().multiplyScalar(1 + i)), { count: 90, color: 0xeaf6ff, color2: 0x2f74c8, tile: 2, speed: 20 + i * 6, size: 0.5, life: 1.3, gravity: 16, drag: 1.1, dir: _up, cone: 2.4 }));
          for (let w = 0; w < 5; w++) this.schedule(0.05 + w * 0.05, () => {
            const rr = (w + 1) / 5 * R;
            c.vfx.burst(gp.clone().add(_v.set((Math.random() - 0.5) * rr * 1.6, 0.3, (Math.random() - 0.5) * rr * 1.6)), { count: 14, color: 0xeaf6ff, color2: 0x2f74c8, tile: 2, speed: 12, size: 0.44, life: 0.9, gravity: 14, drag: 1.2, dir: _up, cone: 1.2 });
            for (const t of c.combat.enemiesInRadius(gp, rr)) t.velocity && t.velocity.addScaledVector(t.center.clone().sub(gp).setY(0.35).normalize(), 10);   // the wave shoves everyone
          });
          c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(2)), { kind: 'impact', size: R * 1.7, life: 0.7, color: 0xffffff });
          this.schedule(0.15, () => c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(4)), { kind: 'smoke', size: R * 1.2, life: 2.8, color: 0x6a6478, additive: false, rise: 1.4, spin: true }));
          const seen = new Set();
          for (let i = 0; i < 6; i++) this.schedule(i * 0.14, () => {
            const rr = 7 + i * (R - 7) / 5;
            c.vfx.flipbook(gp.clone().add(_up), { kind: 'shock', size: rr * 1.5, life: 0.55, color: i % 2 ? QK_LT : QK });
            c.vfx.quakeRing(gp.clone(), { radius: rr, life: 0.65 + i * 0.1, thickness: 0.95, color: i % 2 ? QK_LT : QK });
            c.vfx.ring(gp.clone(), { color: QK_LT, radius: rr, life: 0.55 });
            c.vfx.crack(gp.clone(), { radius: rr, count: 10, life: 3.2, ground: true, color: QK_LT });
            for (const t of c.combat.enemiesInRadius(gp, rr)) {
              if (seen.has(t)) continue; seen.add(t);
              const kk = 1 - t.center.distanceTo(gp) / R * 0.5;
              const dd = (i === 0 ? 260 : 70) * kk;
              t.takeHit({ damage: dd, dir: t.center.clone().sub(gp).setY(0.28).normalize(), knockback: 52 * kk, up: (i === 0 ? 22 : 9) * kk, stun: i === 0 ? 1.6 : 0.5 });
              c.combat.hooks?.onDamageNumber?.(t.center.clone(), Math.round(dd));
              c.combat.applyStatus(t, 'quake', { stacks: 3, duration: 6 });
            }
            c.camera.addShake(0.8);
          });
          c.vfx.dome(gp.clone().add(_up), { radius: R + 4, life: 1.0, color: QK });
          c.vfx.decal(gp.clone(), { kind: 'crack', radius: R, life: 14, groundY: gp.y });
          debrisRing(c, gp, R * 0.7, 30);
          // lingering dust cloud
          const dz = { t: 0 };
          const dust = () => {
            dz.t += 0.15;
            const a = Math.random() * 6.283, rr = Math.random() * R;
            c.vfx.burst(gp.clone().add(_v.set(Math.cos(a) * rr, 0.5 + Math.random() * 3, Math.sin(a) * rr)),
              { count: 3, color: 0x8a8296, color2: 0x5a5266, tile: 2, speed: 2, size: 1.1, life: 1.7, gravity: -0.5, drag: 0.7, dir: _up, cone: 1.5 });
            if (dz.t < 3.4) this.schedule(0.15, dust);
          };
          this.schedule(0.1, dust);
          this.schedule(3.4, () => { c.camera.wantDistance = cd0; });   // restore zoom
        });
      }
    };
  }

  onMelee(c) {
    for (const t of c.combat.nearestEnemies(c.controller.position, 4, 4.4)) c.combat.applyStatus(t, 'quake', { stacks: 1, duration: 3.5 });
  }
}

/* ================================================================ *
 *  LEGENDARIO — Magu Magu (Magma). Logia. Ult: Gran Erupción.
 * ================================================================ */
export class MaguMagu extends DevilFruit {
  constructor() {
    super('Magu Magu', 0xd83c14, { rarity: 'legendario', type: 'logia', passive: 'Paso de Obsidiana · funde defensas · 22% esquiva' });
    this._chargeOrb = null;

    // Z — Núcleo Fundido: hold to charge a magma orb, release to hurl it.
    this.slots.q = {
      name: 'Núcleo Fundido', cd: 3.2, _t: 0, charge: true, chargeTime: 1.5,
      onCharge: (c, k) => {
        const at = c.origin.clone().addScaledVector(c.aimDir, 1.1);
        if (!this._chargeOrb) { this._chargeOrb = magmaRock(0.4); c.scene.add(this._chargeOrb); }
        this._chargeOrb.position.copy(at);
        this._chargeOrb.scale.setScalar(0.5 + k * 2.4);
        if (Math.random() < 0.5) c.vfx.burst(at.clone(), { count: 2, color: 0xff9a3a, color2: 0xffe08a, tile: 3, speed: 3 + k * 7, size: 0.2, life: 0.3, gravity: 4, drag: 3, dir: _up, cone: 1.2 });
        if (k >= 1 && Math.random() < 0.3) c.vfx.burst(at.clone(), { count: 3, color: 0xffffff, tile: 1, speed: 5, size: 0.3, life: 0.22, gravity: 0, drag: 4 });
      },
      cast: (c, self, k0) => {
        const k = k0 || 0.2;
        const dir = c.aimDir.clone();
        const origin = c.origin.clone();
        if (this._chargeOrb) { c.scene.remove(this._chargeOrb); this._chargeOrb.geometry.dispose(); this._chargeOrb = null; }
        c.pose('thrust');
        const R = 0.6 + k * 0.95;
        const dmg = 22 + k * 48;
        const aoe = 3 + k * 3.6;
        c.vfx.burst(origin.clone().addScaledVector(dir, 1), { count: 12 + k * 22, color: 0xff7a2c, color2: 0xffe08a, tile: 1, speed: 12, size: 0.4, life: 0.3, gravity: 2, drag: 4, dir, cone: 0.7 });
        c.camera.addShake(0.14 + k * 0.2);
        c.combat.spawnProjectile({
          pos: origin.clone().addScaledVector(dir, 1.3), vel: dir.clone().multiplyScalar(38 + k * 12), gravity: 6,
          radius: R, life: 2.4, damage: dmg, aoe, knockback: 14 + k * 12, up: 5, color: 0xd83c14, trailColor: 0xff7a2c, mesh: magmaRock(R * 0.9),
          onImpact: (p) => {
            const y = gY(c, p.x, p.z);
            const at = _v.set(p.x, y, p.z).clone();
            c.combat.hitstop(0.03 + k * 0.05);
            flash(c, 0.14 + k * 0.14, 0xffca9a);
            c.vfx.flame(at.clone(), { radius: 2 + k * 3, height: 5 + k * 7, life: 1.2 + k, color: 0xc42a08 });
            c.vfx.dome(p, { radius: aoe + 2, life: 0.4, color: 0xff6a24 });
            c.vfx.decal(at.clone(), { kind: 'scorch', radius: aoe + 1, life: 9, groundY: y });
            c.vfx.crack(at.clone(), { radius: aoe, count: 6, life: 1.4, color: 0xff6a24 });
            // lava splash — globs that arc up, fall under gravity, leave puddles
            for (let i = 0; i < 10 + k * 14; i++) {
              const a = Math.random() * 6.283;
              c.vfx.burst(at.clone().add(_up), { count: 1, color: 0xff9a3a, color2: 0xc42a08, tile: 1, speed: 6 + Math.random() * 8, size: 0.44, life: 0.9, gravity: 22, drag: 0.8, dir: _v.set(Math.cos(a), 1.6, Math.sin(a)).normalize(), cone: 0.2 });
            }
            for (let i = 0; i < 4; i++) this.schedule(0.25 + Math.random() * 0.3, () => {
              const a = Math.random() * 6.283, rr = (aoe + 1) * Math.random();
              const sp = at.clone().add(_v.set(Math.cos(a) * rr, 0, Math.sin(a) * rr));
              c.vfx.decal(sp.clone(), { kind: 'scorch', radius: 1 + Math.random(), life: 4, groundY: gY(c, sp.x, sp.z) });
            });
            smoke(c, at.clone().add(_up), 12 + k * 12);
            c.vfx.hazard(at.clone(), {
              kind: 'fire', radius: aoe, duration: 3 + k * 2, groundY: y,
              onTick: (ctr, r) => c.combat.areaStrike(ctr, { radius: r, damage: 7, knockback: 1, up: 0.4, stun: 0.12, silent: true, color: 0xd83c14 })
            });
          }
        });
      }
    };

    // X — Mar de Lava: split the ground and flood a pool of molten rock that
    // spreads out, drags enemies, burns, then cools to dark stone.
    this.slots.e = {
      name: 'Mar de Lava', cd: 10.0, _t: 0,
      cast: (c) => {
        c.pose('slam');
        const gp = ahead(c, 8); gp.y = gY(c, gp.x, gp.z);
        const R = 12;
        c.camera.addShake(0.22); c.combat.hitstop(0.04); flash(c, 0.18, 0xffb070);
        // the ground splits and lava wells up
        c.vfx.crack(gp.clone(), { radius: R * 0.5, count: 11, life: 2.4, color: 0xff6a24 });
        c.vfx.burst(gp.clone().add(_up), { count: 44, color: 0xff9a3a, color2: 0xc42a08, tile: 1, speed: 11, size: 0.6, life: 1.0, gravity: 6, drag: 1.1, dir: _up, cone: 1.7 });
        c.vfx.decal(gp.clone(), { kind: 'scorch', radius: R + 1, life: 14, groundY: gp.y });
        smoke(c, gp.clone().add(_up.clone().multiplyScalar(2)), 16);
        for (let i = 0; i < 7; i++) this.schedule(Math.random() * 0.6, () => {
          const a = Math.random() * 6.283;
          c.vfx.burst(gp.clone().add(_up), { count: 1, color: 0xff9a3a, color2: 0xc42a08, tile: 1, speed: 9 + Math.random() * 7, size: 0.5, life: 1.0, gravity: 20, drag: 0.8, dir: _v.set(Math.cos(a), 1.5, Math.sin(a)).normalize(), cone: 0.2 });
        });

        c.vfx.lavaSea(gp.clone(), {
          radius: R, spread: 0.7, duration: 6.0, groundY: gp.y,
          onTick: (ctr, rad) => {
            for (const t of c.combat.enemiesInRadius(ctr, rad)) {
              t.takeHit({ damage: 10, dir: _up.clone(), knockback: 0, up: 0, stun: 0.15 });
              t.velocity.x *= 0.85; t.velocity.z *= 0.85;   // viscous — the lava drags them down
              t.velocity.y = Math.min(t.velocity.y, 1);
            }
          },
          onEmit: (ep) => {
            c.vfx.burst(ep.clone(), { count: 4, color: 0xffca3a, color2: 0xff5a1e, tile: 1, speed: 4, size: 0.4, life: 0.5, gravity: -3, drag: 1.4, dir: _up, cone: 0.5 });
            if (Math.random() < 0.3) c.vfx.flame(ep.clone(), { radius: 0.8, height: 1.9, life: 0.5, color: 0xc42a08 });
            if (Math.random() < 0.12) c.vfx.burst(ep.clone(), { count: 6, color: 0xff9a3a, color2: 0xffe08a, tile: 1, speed: 8, size: 0.42, life: 0.8, gravity: 16, drag: 0.9, dir: _up, cone: 0.4 });   // gout
          }
        });
      }
    };

    // C — Oleada Volcánica: sheathe in magma and charge, burning all hit.
    this.slots.f = {
      name: 'Oleada Volcánica', cd: 6.0, _t: 0,
      cast: (c) => {
        const d = c.aimDir.clone(); d.y = Math.max(-0.1, d.y * 0.3); d.normalize();
        c.controller.velocity.copy(d).multiplyScalar(38);
        c.controller._dashTime = 0.4; c.controller._dashDir.copy(d);
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.5);
        // pulsing magma overlay on the character
        const saved = [];
        c.character?.root.traverse((o) => { if (o.isMesh && o.material && o.material.color && !o.name.endsWith('__outline')) { saved.push([o.material, o.material.color.clone()]); o.material.color.lerp(new THREE.Color(0xff6a1e), 0.7); } });
        this.schedule(0.55, () => saved.forEach(([m, col]) => m.color.copy(col)));
        const burned = new Set();
        for (let i = 0; i < 7; i++) this.schedule(i * 0.055, () => {
          const p = c.controller.chest.clone(); const y = gY(c, p.x, p.z);
          c.vfx.flame(_v.set(p.x, y, p.z).clone(), { radius: 1.6, height: 3.6, life: 0.6, color: 0xc42a08 });
          c.vfx.burst(p.clone(), { count: 8, color: 0xff9a3a, color2: 0xc42a08, tile: 1, speed: 6, size: 0.4, life: 0.5, gravity: 3, drag: 1.8, dir: d.clone().negate(), cone: 1.2 });
          c.vfx.decal(_v.set(p.x, y, p.z).clone(), { kind: 'scorch', radius: 1.8, life: 5, groundY: y });
          for (const t of c.combat.enemiesInRadius(c.controller.chest, 3)) {
            t.takeHit({ damage: 12, dir: d.clone(), knockback: 12, up: 4, stun: 0.25 });
            if (!burned.has(t)) { burned.add(t); this._applyBurn(c, t, 4, 2.0); }
          }
        });
        this.schedule(0.42, () => {
          const p = c.controller.chest.clone();
          c.combat.areaStrike(p, { radius: 5, damage: 30, knockback: 20, up: 8, stun: 0.4, color: 0xd83c14, shake: 0.35 });
          c.vfx.flame(p.clone(), { radius: 3, height: 7, life: 1.2, color: 0xc42a08 });
          c.vfx.dome(p, { radius: 6, life: 0.4, color: 0xff6a24 });
          for (let i = 0; i < 3; i++) c.vfx.ring(p.clone(), { color: i % 2 ? 0xffca3a : 0xff6a24, radius: 4 + i * 2.5, life: 0.35 + i * 0.1 });
          c.combat.hitstop(0.05);
        });
      }
    };

    // T — Erupción del Juicio: crack -> column -> molten rain.
    this.slots.ult = {
      name: 'Erupción del Juicio', cd: 30, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = ahead(c, 13); gp.y = gY(c, gp.x, gp.z);
        const R = 18;
        c.camera.addShake(0.3); flash(c, 0.14, 0xffca9a);

        // PHASE 1 — radial crack spreads from the centre
        c.vfx.decal(gp.clone(), { kind: 'scorch', radius: R, life: 2.5, groundY: gp.y });
        for (let i = 0; i < 4; i++) this.schedule(i * 0.12, () => {
          c.vfx.crack(gp.clone(), { radius: (i + 1) / 4 * R, count: 8, life: 2.0, color: 0xff6a24 });
          c.vfx.ring(gp.clone(), { color: 0xff8a3c, radius: (i + 1) / 4 * R, life: 0.4 });
          c.camera.addShake(0.08);
        });

        // PHASE 2 — eruption column with 2 rising toroidal rings
        this.schedule(0.5, () => {
          slow(c, 0.3, 0.4); flash(c, 0.55, 0xffb070);
          c.combat.hitstop(0.1); c.camera.addShake(1.4);
          c.vfx.flame(gp.clone(), { radius: 6, height: 26, life: 2.4, color: 0xc42a08 });
          c.vfx.flame(gp.clone(), { radius: 3, height: 40, life: 1.9, color: 0xff7a2a, core: 0xffe6a8 });
          c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(2)), { kind: 'impact', size: R * 1.3, life: 0.55, color: 0xffb877 });
          c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(8)), { kind: 'fire', size: 18, life: 1.1, color: 0xff6a24, rise: 3.5 });
          for (let i = 0; i < 3; i++) this.schedule(0.2 + i * 0.15, () => c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(6 + i * 5)), { kind: 'smoke', size: R, life: 2.6, color: 0x5a4a3a, additive: false, rise: 1.8, spin: true }));
          c.vfx.dome(gp.clone().add(_up), { radius: R + 4, life: 0.9, color: 0xff6a24 });
          c.vfx.burst(gp.clone().add(_up), { count: 100, color: 0xff9a3a, color2: 0xc42a08, tile: 1, speed: 12, size: 0.9, life: 1.4, gravity: -3, drag: 0.9, dir: _up, cone: 0.7 });
          c.combat.areaStrike(gp, { radius: R * 0.7, damage: 120, knockback: 26, up: 24, stun: 1.2, color: 0xd83c14, shake: 1.2 });
          const rings = [];
          for (let i = 0; i < 2; i++) {
            const torus = new THREE.Mesh(new THREE.TorusGeometry(4 + i * 2, 0.4, 8, 24),
              new THREE.MeshBasicMaterial({ color: i ? 0xffe08a : 0xff6a24, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
            torus.rotation.x = Math.PI / 2;
            torus.position.copy(gp).add(_up.clone().multiplyScalar(3 + i * 4));
            c.scene.add(torus);
            rings.push({ m: torus, spd: 2 + i * 1.5, rise: 6 + i * 3, base: torus.position.y });
          }
          let rt = 0;
          const spin = () => {
            rt += 1 / 60;
            for (const rk of rings) { rk.m.rotation.z += rk.spd / 60; rk.m.position.y = rk.base + rt * rk.rise; rk.m.material.opacity = 0.7 * Math.max(0, 1 - rt / 1.6); rk.m.scale.setScalar(1 + rt * 0.5); }
            if (rt < 1.6) { requestAnimationFrame(spin); return; }
            for (const rk of rings) { c.scene.remove(rk.m); rk.m.geometry.dispose(); rk.m.material.dispose(); }
          };
          spin();
        });

        // PHASE 3 — molten rain over a wide radius, then lingering smoke
        this.schedule(1.1, () => {
          for (let i = 0; i < 10; i++) this.schedule(i * 0.16 + Math.random() * 0.05, () => {
            const a = Math.random() * 6.283, rr = Math.sqrt(Math.random()) * R;
            const land = gp.clone().add(_v.set(Math.cos(a) * rr, 0, Math.sin(a) * rr)); land.y = gY(c, land.x, land.z);
            this._magmaFall(c, land, { r: 1.0, height: 46, sink: 0.4, geyser: 1.4 });
          });
          this.schedule(2.2, () => {
            c.vfx.hazard(gp.clone(), {
              kind: 'fire', radius: R * 0.7, duration: 4, groundY: gp.y,
              onTick: (ctr, r) => c.combat.areaStrike(ctr, { radius: r, damage: 9, knockback: 1, up: 0.4, stun: 0.12, silent: true, color: 0xd83c14 }),
              onEmit: (ep) => c.vfx.burst(ep, { count: 3, color: 0xff9a3a, color2: 0xc42a08, tile: 2, speed: 3, size: 0.5, life: 0.8, gravity: -3, drag: 2, dir: _up, cone: 0.7 })
            });
            smoke(c, gp.clone().add(_up.clone().multiplyScalar(5)), 44);
          });
        });
      }
    };
  }

  forceRevert(ctx) {
    super.forceRevert(ctx);
    if (this._chargeOrb) { ctx.scene?.remove(this._chargeOrb); this._chargeOrb.geometry.dispose(); this._chargeOrb = null; }
  }

  /* falling molten fragment: brief hover then accelerate; geyser on land */
  _magmaFall(c, land, { r = 0.8, height = 36, sink = 0.35, geyser = 1 } = {}) {
    const rock = magmaRock(r);
    const from = land.clone().add(_up.clone().multiplyScalar(height)).add(new THREE.Vector3((Math.random() - 0.5) * 8, 0, (Math.random() - 0.5) * 8));
    const to = land.clone().add(_up.clone().multiplyScalar(r));
    rock.position.copy(from);
    c.scene.add(rock);
    let t = 0;
    const HOV = 0.18;
    const fall = () => {
      t += 1 / 60;
      if (t < HOV) { rock.position.copy(from); rock.position.y += Math.sin(t * 20) * 0.3; }
      else rock.position.lerpVectors(from, to, Math.min(1, ((t - HOV) / sink)) ** 2);
      if ((t * 60) % 2 < 1) c.vfx.burst(rock.position.clone(), { count: 3, color: 0xff9a3a, color2: 0xc42a08, tile: 1, speed: 3, size: 0.4, life: 0.5, gravity: -4, drag: 1.2 });
      if (t >= HOV + sink) {
        c.scene.remove(rock); rock.geometry.dispose();
        c.vfx.flame(land.clone(), { radius: 1.6 * geyser, height: 5 * geyser, life: 0.9 + geyser * 0.4, color: 0xc42a08 });
        c.vfx.dome(land.clone(), { radius: 3 * geyser, life: 0.3, color: 0xff6a24 });
        c.vfx.decal(land.clone(), { kind: 'scorch', radius: 2.4 * geyser, life: 7, groundY: land.y });
        c.vfx.burst(land.clone().add(_up), { count: 20, color: 0xffca3a, color2: 0xc42a08, tile: 1, speed: 11, size: 0.44, life: 0.7, gravity: 14, drag: 1, dir: _up, cone: 0.5 });
        c.combat.areaStrike(land, { radius: 3.4 * geyser, damage: 34, knockback: 10, up: 8, stun: 0.35, color: 0xd83c14, silent: true });
        smoke(c, land.clone().add(_up), 8);
        c.camera.addShake(0.12);
        return;
      }
      requestAnimationFrame(fall);
    };
    fall();
  }

  /* burn DoT: `n` extra hits of `dmg` over `dur` seconds */
  _applyBurn(c, t, dmg, dur) {
    const n = 4;
    for (let i = 1; i <= n; i++) this.schedule((dur / n) * i, () => {
      if (t.dead) return;
      t.takeHit({ damage: dmg, dir: _up.clone(), knockback: 0, up: 0, stun: 0.1 });
      c.vfx.burst(t.center.clone(), { count: 3, color: 0xff9a3a, color2: 0xffe08a, tile: 1, speed: 3, size: 0.28, life: 0.4, gravity: -2, drag: 2, dir: _up, cone: 0.8 });
    });
  }
}

/* ================================================================ *
 *  ÉPICO — Tori Tori: Fénix (Zoan). Transform: llamas azules, regen.
 * ================================================================ */
const PHX = 0x2f9fe8, PHX_CORE = 0xdff2ff, PHX_DEEP = 0x1663d6;
export class ToriToriPhoenix extends DevilFruit {
  constructor() {
    super('Tori Tori: Fénix', PHX, {
      rarity: 'epico', type: 'zoan',
      passive: 'Solo ataca en forma Fénix · vuela mientras está transformado · regeneración'
    });
    this.transformDmg = 1.55; this.transformSpeed = 1.35; this.transformRegen = 16;
    this.abilitiesNeedForm = true;   // abilities locked until transformed
    this.noAura = true;              // the phoenix form is already made of flame
    this._immortalT = 0;
    this._revivedThisForm = false;

    // C — Fénix: toggle the transformation. Flight + regen + the whole kit.
    this.slots.f = { name: 'Fénix', transform: true };

    // === Z — PICOTAZO ARDIENTE: a fast 3-hit blue-talon dive combo. Each hit
    // heals 35% of the damage dealt; the FINAL peck brands foes with an ember
    // that keeps feeding you life (and burning them) for 2 s — a sustained
    // lifesteal hook, not just a burst. ===
    this.slots.q = {
      name: 'Picotazo Ardiente', cd: 1.8, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const d = c.aimDir.clone().normalize();
        const foe = c.combat.nearestEnemies(c.controller.position, 1, 24)[0] || null;
        let n = 0;
        const peck = () => {
          const dir = (foe && !foe.dead) ? foe.center.clone().sub(c.controller.chest).normalize() : d.clone();
          c.controller.velocity.addScaledVector(dir, 22); c.controller.velocity.y += 2;
          c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.2);
          const hp = c.controller.chest.clone().addScaledVector(dir, 2.2);
          const last = n === 2;
          const dmg = last ? 26 : 15;
          c.vfx.flame(hp.clone(), { radius: 0.8, height: 2, life: 0.35, color: PHX, core: PHX_CORE });
          c.vfx.flipbook(hp.clone(), { kind: 'muzzle', size: 2.6, life: 0.14, color: PHX_CORE });
          const branded = [];
          const hits = c.combat.areaStrike(hp, {
            radius: 2.6, damage: dmg, knockback: last ? 20 : 8, up: last ? 8 : 3, stun: 0.2, color: PHX, shake: 0.1,
            onHitTarget: (t) => { if (last) branded.push(t); }
          });
          if (hits) c.combat.healPlayer(dmg * 0.35 * hits);
          c.vfx.burst(hp.clone(), { count: 12, color: PHX_CORE, color2: PHX, tile: 1, speed: 10, size: 0.26, life: 0.3, gravity: 2, drag: 3, dir, cone: 0.6 });
          if (last && branded.length) {
            let bt = 0;
            const brandTick = () => {
              let alive = false;
              for (const t of branded) {
                if (t.dead) continue;
                alive = true;
                t.takeHit({ damage: 4, dir: null, knockback: 0, up: 0, stun: 0 });
                c.vfx.flipbook(t.center.clone(), { kind: 'fire', size: 1.6, life: 0.3, color: PHX, rise: 1 });
                c.combat.healPlayer(6);
              }
              if (alive && ++bt < 4) this.schedule(0.5, brandTick);
            };
            this.schedule(0.5, brandTick);
          }
          if (++n < 3) this.schedule(0.09, peck);
        };
        peck();
        c.camera.addShake(0.1);
      }
    };

    // === X — ALIENTO DE RESTAURACIÓN: rear back and breathe a huge cone of
    // blue fire — heavy damage to foes, a massive heal to you (scales with
    // hits), and a lingering carpet that keeps healing you / burning them. ===
    this.slots.e = {
      name: 'Aliento de Restauración', cd: 8, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const d = c.forwardFlat.clone();
        const right = _v.set(d.z, 0, -d.x).normalize().clone();
        c.camera.addShake(0.24); flash(c, 0.16, 0xdff2ff);
        c.vfx.flipbook(c.controller.chest.clone().addScaledVector(d, 1), { kind: 'muzzle', size: 6, life: 0.26, color: PHX_CORE });
        const seen = new Set();
        let heal = 0;
        for (let w = 0; w < 8; w++) this.schedule(w * 0.045, () => {
          const fwd = 2 + w * 1.9;
          for (const off of [-1, 0, 1]) {
            const p = c.controller.position.clone().addScaledVector(d, fwd).addScaledVector(right, off * (fwd * 0.28));
            p.y = gY(c, p.x, p.z);
            c.vfx.flame(p.clone(), { radius: 1.6, height: 4, life: 0.6, color: PHX, core: PHX_CORE });
            c.vfx.flipbook(p.clone().add(_up.clone().multiplyScalar(1.5)), { kind: 'fire', size: 5, life: 0.4, color: PHX, rise: 1 });
          }
          const hc = c.controller.position.clone().addScaledVector(d, fwd); hc.y = gY(c, hc.x, hc.z);
          for (const t of c.combat.enemiesInRadius(hc, 3 + fwd * 0.2)) {
            if (seen.has(t)) continue; seen.add(t);
            t.takeHit({ damage: 26, dir: d.clone().setY(0.15).normalize(), knockback: 16, up: 6, stun: 0.3 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), 26);
            heal += 14;
          }
          if (w === 7) c.combat.healPlayer(Math.min(90, 20 + heal));
        });
        const gp = c.controller.position.clone().addScaledVector(d, 8); gp.y = gY(c, gp.x, gp.z);
        c.vfx.decal(gp.clone(), { kind: 'scorch', radius: 8, life: 5, groundY: gp.y });
        c.vfx.hazard(gp.clone(), {
          kind: 'fire', radius: 8, duration: 4, groundY: gp.y,
          onTick: (ctr, r) => {
            for (const t of c.combat.enemiesInRadius(ctr, r)) t.takeHit({ damage: 6, dir: null, knockback: 0, up: 0, stun: 0 });
            if (c.controller.position.distanceTo(ctr) < r + 1) {
              c.combat.healPlayer(8);
              // the restoration fire RE-ARMS your once-per-form phoenix revive —
              // stand in it after a near-death and you can rise again
              this._revivedThisForm = false;
              c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.35);
            }
          },
          onEmit: (ep) => c.vfx.burst(ep, { count: 3, color: PHX_CORE, color2: PHX, tile: 1, speed: 3, size: 0.34, life: 0.7, gravity: -3, drag: 2, dir: _up, cone: 0.6 })
        });
      }
    };

    // === V — COMETA AZUL: rocket up, then streak DOWN as a comet of blue fire
    // to EXACTLY where you're aiming (up to 60 m) — colossal impact, you emerge
    // fully healed, and it leaves a 3 s blue-flame updraft that juggles foes
    // and rockets you skyward again if you fly back into it. ===
    this.slots.v = {
      name: 'Cometa Azul', cd: 6, _t: 0,
      cast: (c) => {
        c.pose('raise');
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 1.1);
        c.controller.velocity.set(0, 20, 0);
        c.vfx.burst(c.controller.chest, { count: 24, color: PHX_CORE, color2: PHX, tile: 1, speed: 10, size: 0.3, life: 0.5, gravity: -3, drag: 2, dir: _up, cone: 1.1 });
        const tp = aimedGround(c, 60, 6);
        this.schedule(0.26, () => {
          const from = c.controller.chest.clone();
          const dv = tp.clone().add(_up).sub(from).normalize();
          c.controller.velocity.copy(dv).multiplyScalar(56);
          c.controller._dashTime = 0.22; c.controller._dashDir.copy(dv);
          for (let i = 0; i < 4; i++) this.schedule(i * 0.04, () => c.vfx.flame(c.controller.chest.clone(), { radius: 1.4, height: 3, life: 0.3, color: PHX, core: 0xffffff }));
        });
        this.schedule(0.52, () => {
          const gp = c.controller.position.clone(); gp.y = gY(c, gp.x, gp.z);
          slow(c, 0.14, 0.4); flash(c, 0.3, 0xdff2ff); c.combat.hitstop(0.09); c.camera.addShake(1.0);
          c.combat.healPlayer(9999);
          c.vfx.flipbook(gp.clone().add(_up), { kind: 'impact', size: 24, life: 0.55, color: 0xffffff });
          c.vfx.flame(gp.clone(), { radius: 5, height: 14, life: 1.4, color: PHX, core: PHX_CORE });
          c.vfx.dome(gp, { radius: 10, life: 0.6, color: PHX_CORE });
          c.vfx.crack(gp.clone(), { radius: 8, count: 10, life: 2, color: 0x8fd0ff });
          c.vfx.decal(gp.clone(), { kind: 'scorch', radius: 6, life: 6, groundY: gp.y });
          const seen = new Set();
          for (let w = 0; w < 6; w++) this.schedule(w * 0.03, () => {
            const rr = (w + 1) / 6 * 10;
            c.vfx.ring(gp, { color: w % 2 ? PHX_CORE : PHX, radius: rr, life: 0.4 });
            for (const t of c.combat.enemiesInRadius(gp, rr)) {
              if (seen.has(t)) continue; seen.add(t);
              const k = 1 - t.center.distanceTo(gp) / 10 * 0.5;
              t.takeHit({ damage: 70 * k, dir: t.center.clone().sub(gp).setY(0.2).normalize(), knockback: 30, up: 12, stun: 0.6 });
              c.combat.hooks?.onDamageNumber?.(t.center.clone(), Math.round(70 * k));
            }
          });
          c.vfx.burst(gp.clone(), { count: 70, color: PHX_CORE, color2: 0xffffff, tile: 1, speed: 20, size: 0.4, life: 0.9, gravity: 4, drag: 1.5, dir: _up, cone: 2.4 });
          // ---- lingering blue-flame updraft column ----
          c.vfx.hazard(gp.clone(), {
            kind: 'fire', radius: 4, duration: 3, groundY: gp.y,
            onTick: (ctr, r) => {
              for (const t of c.combat.enemiesInRadius(ctr, r)) t.takeHit({ damage: 5, dir: _up, knockback: 2, up: 9, stun: 0 });
              if (c.controller.position.distanceTo(ctr) < r + 1.5 && c.controller.flying) {
                c.controller.velocity.y = Math.max(c.controller.velocity.y, 17);
              }
            },
            onEmit: (ep) => c.vfx.burst(ep, { count: 3, color: PHX_CORE, color2: PHX, tile: 1, speed: 6, size: 0.3, life: 0.6, gravity: -6, drag: 1.6, dir: _up, cone: 0.4 })
          });
        });
      }
    };

    // === T — FÉNIX INMORTAL: become a colossal phoenix — full heal, a fast
    // arena-wide sweep of blue fire, then ~4 s where you CANNOT drop below 1 HP
    // while healing feathers rain down. Ends in a wing-slam. ===
    this.slots.ult = {
      name: 'Fénix Inmortal', cd: 26, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = _v.set(c.controller.position.x, gY(c, c.controller.position.x, c.controller.position.z), c.controller.position.z).clone();
        const R = 22;
        c.combat.healPlayer(9999);
        this._immortalT = 4.0;
        this._absorbed = 0;
        this._lastHp = c.combat.playerHp;
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 1.4);
        c.controller.velocity.y = 16;
        slow(c, 0.4, 0.4); flash(c, 0.6, 0xdff2ff); c.combat.hitstop(0.14); c.camera.addShake(1.6);
        c.vfx.flame(gp.clone(), { radius: 8, height: 30, life: 2.4, color: PHX, core: 0xffffff });
        c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(3)), { kind: 'impact', size: 40, life: 0.6, color: 0xffffff });
        c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(8)), { kind: 'fire', size: 30, life: 1.6, color: PHX, rise: 3 });
        const seen = new Set();
        for (let w = 0; w < 7; w++) this.schedule(0.05 + w * 0.04, () => {
          const rr = (w + 1) / 7 * R;
          c.vfx.ring(gp, { color: w % 2 ? PHX_CORE : PHX, radius: rr, life: 0.45, thickness: 0.8 });
          for (const t of c.combat.enemiesInRadius(gp, rr)) {
            if (seen.has(t)) continue; seen.add(t);
            const k = 1 - t.center.distanceTo(gp) / R * 0.55;
            t.takeHit({ damage: 120 * k, dir: t.center.clone().sub(gp).setY(0.25).normalize(), knockback: 40 * k, up: 14 * k, stun: 1.0 });
            c.combat.hooks?.onDamageNumber?.(t.center.clone(), Math.round(120 * k));
          }
        });
        c.vfx.dome(gp.clone().add(_up), { radius: R + 4, life: 1.0, color: PHX_CORE });
        let ft = 0;
        const feathers = () => {
          ft += 0.18;
          for (let i = 0; i < 3; i++) {
            const a = Math.random() * 6.283, rr = Math.random() * R;
            c.vfx.burst(gp.clone().add(_v.set(Math.cos(a) * rr, 10 + Math.random() * 6, Math.sin(a) * rr)), { count: 2, color: PHX_CORE, color2: PHX, tile: 4, speed: 1.5, size: 0.4, life: 1.6, gravity: 5, drag: 0.7 });
          }
          if (c.controller.position.distanceTo(gp) < R) c.combat.healPlayer(10);
          for (const t of c.combat.enemiesInRadius(gp, R)) t.takeHit({ damage: 5, dir: null, knockback: 0, up: 0, stun: 0 });
          if (ft < 4.0) this.schedule(0.18, feathers);
          else {
            // the closing wing-slam scales with punishment absorbed during the window
            const slam = 60 + (this._absorbed || 0) * 25;
            c.combat.hitstop(0.1); c.camera.addShake(1.0 + Math.min(1, (this._absorbed || 0) * 0.15)); flash(c, 0.3, 0xdff2ff);
            c.vfx.flipbook(gp.clone().add(_up), { kind: 'impact', size: 28 + Math.min(20, (this._absorbed || 0) * 4), life: 0.5, color: 0xffffff });
            c.combat.areaStrike(gp, { radius: R, damage: slam, knockback: 30, up: 12, stun: 0.7, color: PHX, shake: 0.7 });
          }
        };
        this.schedule(0.4, feathers);
      }
    };
  }

  /** Abilities are locked until you've turned into the Phoenix. */
  use(key, ctx) {
    const s = this.slots[key];
    if (!s) return false;
    if (s.transform) return super.use(key, ctx);
    if (!this.transformed) {
      ctx.vfx?.burst(ctx.controller.chest, { count: 7, color: 0x3a6a8a, speed: 3, size: 0.16, life: 0.25, gravity: 5, drag: 4 });
      ctx.camera?.addShake(0.03);
      return false;
    }
    return super.use(key, ctx);
  }

  // regeneration passive + once-per-form auto-revive + T's immortality window
  update(dt) {
    super.update(dt);
    const c = this._ctx;
    if (!c || !this.transformed) return;
    // continuous blue embers rising off the flame form
    this._fxT = (this._fxT || 0) + dt;
    if (this._fxT > 0.05) {
      this._fxT = 0;
      c.vfx.burst(c.controller.chest.clone().add(_v.set((Math.random() - 0.5) * 2.6, (Math.random() - 0.3) * 1.8, (Math.random() - 0.5) * 1.5)),
        { count: 2, color: 0xdff2ff, color2: PHX, tile: 1, speed: 2, size: 0.3, life: 0.7, gravity: -4, drag: 1.6, dir: _up, cone: 0.6 });
    }
    if (this._immortalT > 0) {
      this._immortalT -= dt;
      // a real HP drop this frame = a hit got through the window: soak it,
      // convert it to a healing pulse, and lash back at the nearest attacker
      // (being focused only feeds the phoenix — and swells the closing slam)
      if (this._lastHp != null && c.combat.playerHp < this._lastHp - 0.5) {
        this._absorbed = (this._absorbed || 0) + 1;
        c.combat.healPlayer(14);
        c.camera.addShake(0.25);
        c.vfx.flipbook(c.controller.chest.clone(), { kind: 'muzzle', size: 3, life: 0.16, color: PHX_CORE });
        const foe = c.combat.nearestEnemies(c.controller.position, 1, 14)[0];
        if (foe && !foe.dead) {
          foe.takeHit({ damage: 22, dir: foe.center.clone().sub(c.controller.position).setY(0.2).normalize(), knockback: 14, up: 5, stun: 0.3 });
          c.vfx.ribbon(c.controller.chest.clone(), foe.center.clone(), { color: PHX_CORE, life: 0.22 });
          c.vfx.flame(foe.center.clone(), { radius: 1, height: 3, life: 0.4, color: PHX, core: 0xffffff });
        }
      }
      if (c.combat.playerHp < 1) {
        c.combat.playerHp = 1;
        c.combat.hooks?.onPlayerHp?.(1 / c.combat.playerMaxHp);
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.12);
      }
      this._lastHp = c.combat.playerHp;
    } else if (!this._revivedThisForm && c.combat.playerHp <= 0) {
      this._revivedThisForm = true;
      c.combat.playerHp = Math.round(c.combat.playerMaxHp * 0.6);
      c.combat.hooks?.onPlayerHp?.(c.combat.playerHp / c.combat.playerMaxHp);
      c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 2.2);
      flash(c, 0.7, 0xdff2ff); c.camera.addShake(1.0); slow(c, 0.2, 0.4);
      const p = c.controller.chest.clone();
      c.vfx.flame(p.clone(), { radius: 4, height: 14, life: 1.6, color: PHX, core: 0xffffff });
      c.vfx.flipbook(p.clone(), { kind: 'impact', size: 22, life: 0.6, color: 0xdff2ff });
      c.vfx.dome(p, { radius: 12, life: 0.8, color: PHX_CORE });
      c.vfx.burst(p, { count: 90, color: PHX_CORE, color2: 0xffffff, speed: 16, size: 0.4, life: 1.0, gravity: -3, drag: 1.7 });
      c.combat.areaStrike(c.controller.position.clone(), { radius: 8, damage: 40, knockback: 24, up: 12, stun: 0.6, color: PHX, shake: 0.6 });
    }
  }

  onForm(c, on) {
    c.character?.setForm(on ? 'phoenix' : null);
    c.controller.flying = on;
    if (on) {
      this._ctx = c;
      this._revivedThisForm = false;
      this._absorbed = 0;                 // hits soaked during T's immortal window
      c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 1.1);

      const chest = () => c.controller.chest.clone();
      const gp = () => { const p = c.controller.position.clone(); p.y = gY(c, p.x, p.z); return p; };

      // ---- ONE long sweeping cinematic across the whole rebirth: pull back
      // and orbit while craning UP to follow the phoenix rising out of the
      // ash. ~3.3s total, gentle slow-mo so it reads. ----
      slow(c, 1.9, 0.55);
      c.camera.cine({
        dist: 9.5, fov: 64,
        focus: chest().add(_up.clone().multiplyScalar(1.2)), focusMix: 0.8,
        spin: 1.7, pitchAdd: 0.3,
        inT: 0.32, holdT: 1.9, outT: 1.15
      });

      // ---- Phase 0: DEATH — the body goes to ash, a held breath ----
      flash(c, 0.12, 0x0a1a2a); c.camera.addShake(0.25);
      c.vfx.burst(chest(), { count: 34, color: 0x22303a, color2: 0x101820, tile: 2, speed: 3, size: 0.55, life: 1.1, gravity: 7, drag: 1.3, dir: _up, cone: 2.7 });
      c.vfx.ring(chest(), { color: 0x1663d6, radius: 5, life: 0.28, vertical: false });   // implosion inward

      // ---- Phase 1: IGNITION — pillar of blue fire erupts, wings unfurl.
      // Kept deliberately blue-cored (not white) and shorter so the CAMERA
      // move stays the star, not a screen-filling white-out. ----
      this.schedule(0.32, () => {
        c.character?.phoenixAwaken();
        c.controller.velocity.y = Math.max(c.controller.velocity.y, 10);
        flash(c, 0.11, 0x2f6fd0); c.camera.addShake(1.0); c.combat.hitstop(0.05);
        c.vfx.flame(gp(), { radius: 2.4, height: 13, life: 1.4, color: PHX, core: PHX_CORE });
        c.vfx.flipbook(gp().add(_up.clone().multiplyScalar(4)), { kind: 'impact', size: 10, life: 0.5, color: 0xdff2ff });
        c.vfx.flipbook(gp().add(_up.clone().multiplyScalar(8)), { kind: 'fire', size: 15, life: 1.5, color: PHX, rise: 3.2 });
        c.vfx.decal(gp(), { kind: 'scorch', radius: 5.5, life: 9, groundY: gp().y });
        c.vfx.burst(chest(), { count: 40, color: PHX_CORE, color2: PHX, tile: 4, speed: 13, size: 0.34, life: 1.0, gravity: -3, drag: 1.7, dir: _up, cone: 1.3 });
      });

      // ---- Phase 2: WINGS OPEN — a rebirth shockwave rolls out ----
      this.schedule(0.62, () => {
        c.camera.addShake(0.8);
        c.vfx.dome(gp().add(_up), { radius: 12, life: 0.8, color: PHX_CORE });
        for (let w = 0; w < 4; w++) this.schedule(w * 0.05, () => {
          const rr = (w + 1) / 4 * 13;
          c.vfx.ring(gp(), { color: w % 2 ? PHX_CORE : PHX, radius: rr, life: 0.5 });
        });
        c.vfx.burst(gp().add(_up), { count: 44, color: PHX_CORE, color2: PHX, tile: 4, speed: 16, size: 0.4, life: 1.1, gravity: 2, drag: 1.3, dir: _up, cone: 2.7 });
        // a push, not an attack — stagger nearby foes as the wings snap open
        for (const t of c.combat.enemiesInRadius(gp(), 10)) {
          const away = t.center.clone().sub(c.controller.position).setY(0.25).normalize();
          t.takeHit({ damage: 8, dir: away, knockback: 16, up: 6, stun: 0.6 });
        }
      });

      // ---- Phase 3: SETTLE — halo converges, sustained aura, buoyant hover ----
      this.schedule(1.0, () => {
        c.controller.velocity.y = Math.max(c.controller.velocity.y, 6);
        c.vfx.ring(chest(), { color: 0xdff2ff, radius: 3, life: 0.7, vertical: false });
        c.vfx.flame(chest(), { radius: 1.9, height: 4.5, life: 0.9, color: PHX, core: PHX_CORE });
      });
    } else {
      this._immortalT = 0;
      c.vfx.burst(c.controller.chest, { count: 16, color: PHX_CORE, speed: 5, size: 0.24, life: 0.4, gravity: 6, drag: 3 });
      c.vfx.ring(c.controller.chest, { color: PHX, radius: 2.2, life: 0.3, vertical: true });
    }
  }
}

/* ================================================================ *
 *  LEGENDARIO — Zushi Zushi (Gravedad). Paramecia. Ult: Meteorito.
 *  Inspirada en la Zushi Zushi no Mi de Fujitora.
 * ================================================================ */
const GRV = 0x8a5cff, GRV_LT = 0xd9c6ff, GRV_DK = 0x5a2fb0;
// shared (never-disposed) resources for Zushi's suspended zero-G debris chunks
const _susGeo = new THREE.IcosahedronGeometry(0.5, 0);
const _susMat = new THREE.MeshToonMaterial({ color: GRV_DK, emissive: new THREE.Color(GRV).multiplyScalar(0.25), flatShading: true });

export class ZushiZushi extends DevilFruit {
  constructor() {
    super('Zushi Zushi', GRV, {
      rarity: 'legendario', type: 'paramecia',
      passive: 'Gravedad: caída lenta · salto flotante'
    });
    this.fallMul = 0.6;           // read by Game._applyFruitBuffs -> lighter gravity
    this._levit = 0;              // (kept only for Game's flight check; unused now)
    this._meteorMesh = null;      // swapped for a loaded GLB when available

    // a heavy gravity crater — the vocabulary is DUST + FRACTURED GROUND +
    // debris, not glowing particle fountains. `press`>0 also caves the floor.
    const gravCrater = (c, g, { R = 6, dmg = 0, up = -8, stun = 0.5, press = 0, chunks = 12, shake = 0.6, silent = false } = {}) => {
      c.vfx.crack(g.clone(), { radius: R, count: Math.round(R * 1.4), life: 2.4, color: GRV_DK });
      c.vfx.decal(g.clone(), { kind: 'crack', radius: R, life: 6, groundY: g.y, color: GRV_DK });
      c.vfx.dome(g.clone(), { radius: R * 0.9, life: 0.4, color: GRV });
      if (press) c.vfx.shatter(g.clone(), { radius: R, count: press, life: 3, groundY: g.y, color: 0x2c211a });
      // dust punched out low + a slow rolling cloud
      c.vfx.burst(g.clone().add(_up.clone().multiplyScalar(0.6)), { count: 20, color: 0x8a7563, color2: 0x3a2c22, tile: 2, speed: 9, size: 0.9, life: 1.1, gravity: 3, drag: 1.5, dir: _up, cone: 2.4 });
      c.vfx.burst(g.clone().add(_up.clone().multiplyScalar(2)), { count: 16, color: GRV_LT, color2: GRV_DK, tile: 5, speed: 12, size: 0.34, life: 0.45, gravity: 24, drag: 1.3, dir: _up.clone().negate(), cone: 0.7 });
      debrisRing(c, g, R * 0.8, chunks);
      if (dmg) c.combat.areaStrike(g, { radius: R, damage: dmg, knockback: 6, up, stun, color: GRV, silent, shake, onHitTarget: (t) => c.combat.applyStatus(t, 'gravity', { stacks: 2, duration: 4 }) });
    };
    // pin a target: kill upward motion, add crushing weight, sink dust.
    const pinDown = (c, t, force = 8) => {
      if (t.velocity) t.velocity.y = Math.min(t.velocity.y, -force);
      t._stun = Math.max(t._stun || 0, 0.35);
      c.combat.applyStatus(t, 'gravity', { stacks: 1, duration: 3 });
    };

    // ---- COSMIC-GRAVITY vfx vocabulary (2026-09-03 rework) --------------------
    //  deep violet -> magenta -> white core + black voids, SPACE-WARP (airRift),
    //  crystalline shatter, sleek chromatic rings. NOT brown dust.
    const GRV_MAG = 0xd94fe0;
    // space-warp — the air/space visibly cracks + a violet dome + a chromatic
    // double-ring (violet + cyan offset) reading as lensing.
    const warp = (c, p, { size = 7, life = 0.55, arms = 6 } = {}) => {
      c.vfx.airRift(p.clone(), { size, life, color: GRV_LT, arms });
      c.vfx.dome(p.clone(), { radius: size * 0.5, life: life * 0.7, color: GRV });
      c.vfx.ring(p.clone(), { color: GRV_MAG, radius: size * 0.6, life: life * 0.6, vertical: true });
      c.vfx.ring(p.clone(), { color: 0x62d8ff, radius: size * 0.68, life: life * 0.5, vertical: true });
    };
    // crystalline violet SHATTER — thin shards spray out + a softer glow puff.
    const shardBurst = (c, p, { n = 24, speed = 16, size = 0.34, up = 0 } = {}) => {
      c.vfx.burst(p.clone(), { count: n, color: 0xffffff, color2: GRV_MAG, tile: 3, speed, size, life: 0.5, gravity: up ? 6 : 0, drag: 1.6, dir: up ? _up : undefined, cone: up ? 1.4 : 2.6 });
      c.vfx.burst(p.clone(), { count: Math.round(n * 0.4), color: GRV_LT, color2: GRV_DK, tile: 4, speed: speed * 0.65, size: size * 1.3, life: 0.6, gravity: 2, drag: 1.4 });
    };
    // small chunks HANG rotating in zero-G around a point for `dur`, then drop.
    const suspend = (c, center, R, n, dur) => {
      n = Math.min(n, 8);
      for (let i = 0; i < n; i++) {
        const m = new THREE.Mesh(_susGeo, _susMat);
        const a = (i / n) * 6.283, rr = R * (0.35 + Math.random() * 0.5);
        const bx = center.x + Math.cos(a) * rr, bz = center.z + Math.sin(a) * rr, by = gY(c, bx, bz);
        m.position.set(bx, by + 0.4, bz);
        m.scale.setScalar(0.55 + Math.random() * 0.9);
        c.scene.add(m);
        const rec = { t: 0, hov: 1 + Math.random() * R * 0.35, sp: (Math.random() - 0.5) * 0.11 };
        const tick = () => {
          rec.t += 1 / 60;
          m.position.y = rec.t < dur ? by + rec.hov + Math.sin(rec.t * 2 + a) * 0.4 : m.position.y - (rec.t - dur) * (rec.t - dur) * 16;
          m.rotation.x += rec.sp; m.rotation.y += rec.sp * 0.7;
          if (m.position.y <= by + 0.25 || rec.t > dur + 1.4) { c.scene.remove(m); return; }
          requestAnimationFrame(tick);
        };
        tick();
      }
    };
    // build a "singularity" mesh: black void + white-hot BackSide glow + magenta
    // halo + a tilted spinning accretion RING. Returns {grp, geos, mats, disk, hot}.
    const mkSingularity = (voidR = 0.8) => {
      const geos = [new THREE.SphereGeometry(voidR, 20, 16), new THREE.SphereGeometry(voidR * 1.4, 16, 12), new THREE.SphereGeometry(voidR * 2.7, 16, 12), new THREE.RingGeometry(voidR * 2.7, voidR * 8, 44, 2)];
      const mats = [
        new THREE.MeshBasicMaterial({ color: 0x02010a }),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false }),
        new THREE.MeshBasicMaterial({ color: GRV_MAG, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
        new THREE.MeshBasicMaterial({ color: GRV_LT, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
      ];
      const grp = new THREE.Group();
      const hot = new THREE.Mesh(geos[1], mats[1]);
      const disk = new THREE.Mesh(geos[3], mats[3]); disk.rotation.x = -Math.PI / 2 + 0.5;
      grp.add(new THREE.Mesh(geos[0], mats[0]), hot, new THREE.Mesh(geos[2], mats[2]), disk);
      return { grp, geos, mats, disk, hot, dispose: () => { geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); } };
    };

    // lock-on target for a pointed ability. Uses `enemiesInRadius` so DUMMIES
    // count (unlike `nearestEnemies`, which is enemy-faction only) — scored by
    // how in-front + how near; a close foe wins even a bit off-aim.
    const aimTarget = (c, from, dir, { range = 34, cone = 0.4, near = 8 } = {}) => {
      let best = null, bestScore = -1;
      for (const t of c.combat.enemiesInRadius(from, range)) {
        const to = t.center.clone().sub(from);
        const dist = Math.max(0.6, to.length());
        const dot = to.multiplyScalar(1 / dist).dot(dir);
        if (dot < cone && dist > near) continue;
        const score = (dot + 1) * 2 - dist * 0.05;
        if (score > bestScore) { bestScore = score; best = t; }
      }
      return best;
    };

    // ==== HIDDEN COMBO: cast Z (Colapso) inside an active X (Campo de Ingravidez)
    //      dome -> COLAPSO ESTELAR: the weightless field feeds a runaway black
    //      hole — accretion -> a frozen CRUNCH beat -> SUPERNOVA. ====
    const stellarCollapse = (c, cen, R) => {
      cen = cen.clone(); const cy = gY(c, cen.x, cen.z);
      const core = _v.set(cen.x, cy + 3, cen.z).clone();
      c.combat.hitstop(0.12); slow(c, 0.25, 0.3); flash(c, 0.5, GRV_MAG); c.camera.addShake(1.2);
      c.camera.cine({ dist: 12, fov: 60, focus: core.clone(), focusMix: 0.6, inT: 0.3, holdT: 1.4, outT: 1.3 });
      airCrack(c, core.clone(), { size: R, count: 9, life: 0.8, color: GRV_LT });
      warp(c, core.clone(), { size: R * 0.9, life: 0.9, arms: 9 });
      const S = mkSingularity(0.9);
      S.grp.position.copy(core); c.scene.add(S.grp);
      const seen = new Set();
      let t = 0;
      const grow = () => {
        t += 1 / 60;
        const k = t / 1.3;
        S.grp.rotation.y += 0.02; S.disk.rotation.z += 0.3;
        S.disk.scale.setScalar(0.6 + k * 1.0 + Math.sin(t * 20) * 0.03);
        S.hot.scale.setScalar(1 + k * 0.9);
        c.camera.addShake(0.05 + k * 0.4);
        for (const en of c.combat.enemiesInRadius(cen, R + 2)) {
          seen.add(en);
          const rel = new THREE.Vector3(en.center.x - cen.x, 0, en.center.z - cen.z);
          const dist = Math.max(0.8, rel.length()); rel.multiplyScalar(1 / dist);
          if (en.velocity) {
            en.velocity.x = (-rel.x * 11 + -rel.z * 8) * (0.4 + k);
            en.velocity.z = (-rel.z * 11 + rel.x * 8) * (0.4 + k);
            en.velocity.y += ((core.y - en.center.y) * 2 - en.velocity.y * 3) / 60;
          }
          en._stun = Math.max(en._stun || 0, 0.4);
          if ((t * 60 | 0) % 8 === 0) { en.takeHit({ damage: 6, dir: null, knockback: 0, up: 0, stun: 0.3 }); c.combat.applyStatus(en, 'gravity', { stacks: 3, duration: 2 }); }
        }
        if ((t * 60 | 0) % 2 === 0) {
          const a = t * 16, rr = (R + 3) * Math.max(0.15, 1 - k);
          const sp = core.clone().add(new THREE.Vector3(Math.cos(a) * rr, Math.sin(a * 2.3) * 3 * (1 - k), Math.sin(a) * rr));
          c.vfx.burst(sp.clone(), { count: 2, color: GRV_LT, color2: GRV_MAG, tile: 5, speed: 14 + k * 22, size: 0.34, life: 0.34, gravity: 0, drag: 0.6, dir: core.clone().sub(sp).normalize(), cone: 0.14 });
        }
        if ((t * 60 | 0) % 10 === 0) c.vfx.ring(core.clone(), { color: GRV_MAG, radius: (R + 4) * Math.max(0.2, 1 - k * 0.7), life: 0.4, vertical: true });
        if (t < 1.3) { requestAnimationFrame(grow); return; }
        // THE CRUNCH — a frozen beat
        S.grp.scale.setScalar(0.15);
        slow(c, 0.14, 0.05); c.combat.hitstop(0.24); flash(c, 0.75, 0xffffff);
        for (const en of seen) { if (en && !en.dead && en.velocity) { en.velocity.set(0, 0, 0); en._stun = Math.max(en._stun || 0, 0.6); } }
        this.schedule(0.17, supernova);
      };
      const supernova = () => {
        c.scene.remove(S.grp); S.dispose();
        flash(c, 1.0, GRV_LT); slow(c, 0.6, 0.14); c.combat.hitstop(0.35); c.camera.addShake(4, 1.5);
        c.camera.cine({ dist: 5, fov: 82, focus: core.clone(), focusMix: 0.7, inT: 0.04, holdT: 0.5, outT: 2.4 });
        airCrack(c, core.clone(), { size: R * 2.2, count: 9, life: 1.1, color: GRV_LT });
        warp(c, core.clone(), { size: R * 1.8, life: 1.0, arms: 9 });
        c.vfx.flipbook(core.clone(), { kind: 'impact', size: R * 2.4, life: 0.85, color: 0xffffff });
        shardBurst(c, core.clone(), { n: 80, speed: 34 });
        c.vfx.burst(core.clone(), { count: 60, color: GRV_MAG, color2: GRV_DK, tile: 4, speed: 26, size: 0.6, life: 1.0, gravity: 2, drag: 1.2 });
        const gc = _v.set(cen.x, cy, cen.z).clone();
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * 6.283;
          c.vfx.beam(() => core.clone(), () => new THREE.Vector3(Math.cos(a), 0.15 + (i % 2) * 0.3, Math.sin(a)).normalize(), { length: R * 1.8, radius: 0.34, life: 0.42, color: GRV_MAG, core: 0xffffff });
          c.vfx.fracture(gc.clone(), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).normalize(), { length: R * 1.6, width: 0.7, grow: 0.35, life: 3.2, color: GRV, groundY: cy });
        }
        for (let i = 0; i < 6; i++) this.schedule(i * 0.045, () => {
          const col = [GRV_LT, GRV_MAG, 0x62d8ff][i % 3];
          c.vfx.ring(gc.clone(), { color: col, radius: ((i + 1) / 6) * (R + 12), life: 0.6, thickness: 0.7 });
          c.vfx.ring(core.clone(), { color: col, radius: ((i + 1) / 6) * (R + 8), life: 0.5, vertical: true });
        });
        c.vfx.dome(gc.clone(), { radius: R + 8, life: 1.0, color: GRV });
        c.vfx.crack(gc.clone(), { radius: R + 4, count: 22, life: 3.5, color: GRV });
        c.vfx.decal(gc.clone(), { kind: 'crack', radius: R + 6, life: 14, groundY: cy, color: GRV_DK });
        const hitS = new Set();
        for (let w = 0; w < 7; w++) this.schedule(w * 0.04, () => {
          const rw = ((w + 1) / 7) * (R + 10);
          for (const en of c.combat.enemiesInRadius(gc, rw)) {
            if (hitS.has(en)) continue; hitS.add(en);
            const kk = Math.max(0.3, 1 - en.center.distanceTo(cen) / (R + 10) * 0.5);
            const dmg = Math.round((w === 0 ? 320 : 110) * kk);
            const away = new THREE.Vector3(en.center.x - cen.x, 0, en.center.z - cen.z).normalize();
            en.takeHit({ damage: dmg, dir: away.setY(0.35).normalize(), knockback: 46 * kk, up: 22 * kk, stun: w === 0 ? 2.5 : 0.8 });
            c.combat.hooks?.onDamageNumber?.(en.center.clone(), dmg);
            c.combat.applyStatus(en, 'gravity', { stacks: 3, duration: 8 });
          }
        });
        suspend(c, gc.clone(), R + 4, 8, 0.9);
        this.schedule(0.15, () => smoke(c, core.clone(), 40));
        this.schedule(0.7, () => smoke(c, core.clone().add(_up.clone().multiplyScalar(8)), 28));
      };
      this.schedule(0.05, grow);
    };

    // === Z — COLAPSO: a pinpoint SINGULARITY blinks onto the target — space
    // bends inward around it, it drags everything toward the point for a beat,
    // then IMPLODES to nothing and detonates in a violet crystalline shock. ===
    this.slots.q = {
      name: 'Colapso', cd: 4, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const d = c.aimDir.clone().normalize();
        const o = c.controller.chest.clone().addScaledVector(d, 0.6);
        const foe = aimTarget(c, o, d, { range: 34, cone: 0.45, near: 7 });
        let cp;
        if (foe) cp = foe.center.clone().add(_up.clone().multiplyScalar(0.3));
        else { cp = o.clone().addScaledVector(d, 14); cp.y = gY(c, cp.x, cp.z) + 1.6; }
        // --- HIDDEN COMBO: Colapso cast inside an active Campo de Ingravidez ---
        const vf = this._voidField;
        if (vf && !vf.consumed && c.elapsed < vf.until
          && Math.hypot(cp.x - vf.center.x, cp.z - vf.center.z) < vf.R + 1.5) {
          vf.consumed = true; this._voidField = null;
          stellarCollapse(c, vf.center, vf.R);
          return;
        }
        // the singularity — a black void with a violet warp shell
        const sing = new THREE.Group();
        const svGeo = new THREE.SphereGeometry(0.5, 14, 10), srGeo = new THREE.SphereGeometry(0.9, 14, 10);
        const svMat = new THREE.MeshBasicMaterial({ color: 0x05030a });
        const srMat = new THREE.MeshBasicMaterial({ color: GRV, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false });
        sing.add(new THREE.Mesh(svGeo, svMat), new THREE.Mesh(srGeo, srMat));
        sing.position.copy(cp); c.scene.add(sing);
        c.vfx.flipbook(cp.clone(), { kind: 'magic', size: 4, life: 0.3, color: GRV_MAG });
        c.vfx.beam(() => o.clone(), () => cp.clone().sub(o).normalize(), { length: o.distanceTo(cp), radius: 0.16, life: 0.12, color: GRV_DK, core: GRV_LT });
        warp(c, cp, { size: 5, life: 0.45, arms: 5 });
        c.camera.addShake(0.14); c.combat.hitstop(0.03);
        let t = 0;
        const pull = () => {
          t += 1 / 60;
          sing.rotation.y += 0.3; sing.scale.setScalar(1 + Math.sin(t * 22) * 0.09);
          for (const en of c.combat.enemiesInRadius(cp, 8)) {
            const to = _v.copy(cp).sub(en.center); const dist = Math.max(0.6, to.length()); to.normalize();
            if (en.impulse) en.impulse.addScaledVector(to, 36 * Math.min(1.6, 8 / dist) / 60 / (en.mass || 1));
            en._stun = Math.max(en._stun || 0, 0.3);
          }
          if ((t * 60 | 0) % 2 === 0) {
            const a = t * 13, rr = 5 * Math.max(0, 1 - t / 0.5);
            const sp = cp.clone().add(_v.set(Math.cos(a) * rr, Math.sin(a * 1.7) * 2, Math.sin(a) * rr));
            c.vfx.burst(sp.clone(), { count: 2, color: GRV_LT, color2: GRV_MAG, tile: 5, speed: 9, size: 0.3, life: 0.3, gravity: 0, drag: 1, dir: cp.clone().sub(sp).normalize(), cone: 0.2 });
          }
          if (t < 0.5) { requestAnimationFrame(pull); return; }
          // IMPLODE -> DETONATE
          c.scene.remove(sing); svGeo.dispose(); srGeo.dispose(); svMat.dispose(); srMat.dispose();
          slow(c, 0.1, 0.35); c.combat.hitstop(0.1); c.camera.addShake(1.3); flash(c, 0.3, GRV_LT);
          airCrack(c, cp.clone(), { size: 10, count: 7, life: 0.7, color: GRV_LT });
          warp(c, cp, { size: 9, life: 0.6, arms: 7 });
          shardBurst(c, cp, { n: 34, speed: 22 });
          const gc = _v.set(cp.x, gY(c, cp.x, cp.z), cp.z).clone();
          c.vfx.crack(gc.clone(), { radius: 7, count: 9, life: 2, color: GRV });
          c.vfx.decal(gc.clone(), { kind: 'crack', radius: 7, life: 4, groundY: gc.y, color: GRV_DK });
          c.combat.areaStrike(cp, { radius: 8, damage: foe ? 72 : 55, knockback: 30, up: 14, stun: 0.7, color: GRV, shake: 0.6, onHitTarget: (en) => c.combat.applyStatus(en, 'gravity', { stacks: 3, duration: 4 }) });
        };
        this.schedule(0.05, pull);
      }
    };

    // === X — CAMPO DE INGRAVIDEZ: raise a violet zero-G dome where you aim.
    // Everything inside is lifted off the ground and HANGS rotating, weightless,
    // for ~3 s — then you clench and gravity returns ×5: the dome collapses and
    // the whole cluster SLAMS to the floor at once + a violet ground-fracture.
    // COMBO: cast Z (Colapso) inside the dome -> Colapso Estelar (see slots.q). ===
    this.slots.e = {
      name: 'Campo de Ingravidez', cd: 10, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = ahead(c, 12); gp.y = gY(c, gp.x, gp.z);
        const R = 11, DUR = 3;
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 0.5);
        const field = { center: gp.clone(), R, until: c.elapsed + DUR + 0.5, consumed: false };
        this._voidField = field;
        const domeGeo = new THREE.SphereGeometry(R, 22, 12, 0, 6.283, 0, Math.PI / 2);
        const domeMat = new THREE.MeshBasicMaterial({ color: GRV, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
        const dome = new THREE.Mesh(domeGeo, domeMat); dome.position.copy(gp); c.scene.add(dome);
        const killDome = () => { c.scene.remove(dome); domeGeo.dispose(); domeMat.dispose(); };
        warp(c, gp.clone().add(_up.clone().multiplyScalar(2)), { size: R, life: 0.6, arms: 7 });
        c.vfx.decal(gp.clone(), { kind: 'crack', radius: R, life: DUR + 2, groundY: gp.y, color: GRV_DK });
        for (let i = 0; i < 3; i++) c.vfx.ring(gp.clone(), { color: i % 2 ? GRV_MAG : GRV_LT, radius: R * (0.5 + i * 0.28), life: 0.5 });
        c.camera.addShake(0.2); flash(c, 0.12, GRV_LT);
        suspend(c, gp, R * 0.9, 8, DUR);
        const caught = new Set();
        let t = 0;
        const rise = () => {
          if (field.consumed) { killDome(); return; }   // the combo ate the field — no slam
          t += 1 / 30;
          domeMat.opacity = 0.13 + Math.sin(t * 3) * 0.03;
          dome.rotation.y += 0.01;
          for (const en of c.combat.enemiesInRadius(gp, R)) {
            caught.add(en);
            const target = gY(c, en.center.x, en.center.z) + Math.min(R * 0.5, 2.5);
            if (en.velocity) { en.velocity.x *= 0.9; en.velocity.z *= 0.9; en.velocity.y += ((target - en.center.y) * 3 - en.velocity.y * 4) / 30; }
            en._stun = Math.max(en._stun || 0, 0.4);
            if ((t * 30 | 0) % 4 === 0) c.vfx.burst(en.center.clone(), { count: 2, color: GRV_LT, color2: GRV_MAG, tile: 5, speed: 2, size: 0.3, life: 0.5, gravity: -2, drag: 1.2 });
          }
          if ((t * 30 | 0) % 3 === 0) c.vfx.burst(gp.clone().add(_v.set((Math.random() - 0.5) * R * 1.5, Math.random() * R * 0.5, (Math.random() - 0.5) * R * 1.5)), { count: 1, color: GRV_LT, tile: 5, speed: 1, size: 0.3, life: 0.8, gravity: -1, drag: 1 });
          if (t < DUR) { this.schedule(1 / 30, rise); return; }
          // --- the SLAM ---
          if (this._voidField === field) this._voidField = null;
          killDome();
          slow(c, 0.24, 0.24); c.combat.hitstop(0.16); c.camera.addShake(2.2); flash(c, 0.4, GRV_LT);
          airCrack(c, gp.clone().add(_up), { size: R * 1.3, count: 8, life: 0.7, color: GRV_LT });
          warp(c, gp.clone().add(_up), { size: R + 3, life: 0.6, arms: 8 });
          shardBurst(c, gp.clone().add(_up), { n: 40, speed: 24 });
          c.vfx.crack(gp.clone(), { radius: R + 2, count: 14, life: 3, color: GRV });
          c.vfx.decal(gp.clone(), { kind: 'crack', radius: R + 2, life: 6, groundY: gp.y, color: GRV_DK });
          for (let i = 0; i < 5; i++) this.schedule(i * 0.04, () => c.vfx.ring(gp.clone(), { color: i % 2 ? GRV_MAG : GRV_LT, radius: (i + 1) / 5 * (R + 5), life: 0.5, thickness: 0.6 }));
          for (const en of (caught.size ? [...caught] : c.combat.enemiesInRadius(gp, R + 2))) {
            if (!en || en.dead) continue;
            if (en.velocity) en.velocity.set(0, -45, 0);
            const k = Math.max(0.35, 1 - en.center.distanceTo(gp) / (R + 2) * 0.5);
            const dmg = Math.round(100 * k);
            en.takeHit({ damage: dmg, dir: null, knockback: 6, up: -24, stun: 1.6 });
            c.combat.hooks?.onDamageNumber?.(en.center.clone(), dmg);
            c.combat.applyStatus(en, 'gravity', { stacks: 3, duration: 6 });
          }
          this.schedule(0.12, () => smoke(c, gp.clone().add(_up.clone().multiplyScalar(4)), 24));
        };
        this.schedule(0.2, rise);
      }
    };

    // === C — LAZO GRAVITATORIO: fire an ELASTIC rope of violet gravity that
    // latches onto an enemy and PARALYZES them for ~4 s — frozen mid-pose,
    // caged in a warp with a spinning gravity halo + orbiting shards — then
    // snaps loose with a shard-burst + a hard knockback. ===
    this.slots.f = {
      name: 'Lazo Gravitatorio', cd: 5, _t: 0,
      cast: (c) => {
        c.pose('thrust');
        const PARA = 1.5;
        const d = c.aimDir.clone().normalize();
        const hand = c.controller.chest.clone().addScaledVector(d, 0.5);
        // target: nearest enemy roughly under the cursor (≤40 m), else just the
        // nearest one within 9 m regardless of aim.
        const foe = aimTarget(c, hand, d, { range: 40, cone: 0.25, near: 9 });
        const shootDir = (foe ? foe.center.clone().sub(hand).normalize() : d);
        c.vfx.stretch(() => c.controller.chest.clone().addScaledVector(shootDir, 0.4), shootDir,
          { length: foe ? hand.distanceTo(foe.center) : 16, radius: 0.18, color: GRV, life: 0.2, fist: false });
        c.vfx.burst(hand.clone(), { count: 12, color: GRV_LT, color2: GRV_MAG, tile: 5, speed: 14, size: 0.24, life: 0.16, gravity: 0, drag: 5, dir: shootDir, cone: 0.35 });
        c.camera.addShake(0.1);
        if (!foe) {
          c.vfx.burst(hand.clone().addScaledVector(d, 13), { count: 8, color: GRV_LT, tile: 5, speed: 6, size: 0.3, life: 0.3, gravity: 0, drag: 3 });
          this.slots.f._t = 1.2;                          // whiff — refund most of the cooldown
          return;
        }
        // --- LATCH: a gravity CAGE clamps down, the foe freezes ---
        c.combat.hitstop(0.08); slow(c, 0.06, 0.45); flash(c, 0.16, GRV_LT); c.camera.addShake(0.3);
        foe.takeHit({ damage: 24, dir: d.clone().setY(0.04).normalize(), knockback: 0, up: 0, stun: PARA });
        c.combat.hooks?.onDamageNumber?.(foe.center.clone(), 24);
        if (foe.velocity) foe.velocity.set(0, 0, 0);
        if (foe.impulse) foe.impulse.set(0, 0, 0);
        foe._stun = Math.max(foe._stun || 0, PARA);
        warp(c, foe.center.clone(), { size: 4.5, life: 0.5, arms: 6 });
        c.vfx.encase(() => (foe && !foe.dead ? foe.center.clone() : hand.clone()), { size: Math.max(1.6, (foe.radius || 0.9) * 2), hold: PARA, color: GRV });
        c.vfx.chains(() => (foe && !foe.dead ? foe.center.clone() : hand.clone()), { count: 6, spread: 1.6, hold: PARA, color: GRV });
        // the elastic line + a persistent paralysis halo, for the whole PARA
        const ropeGeo = new THREE.CylinderGeometry(0.08, 0.08, 1, 6); ropeGeo.translate(0, 0.5, 0);
        const ropeMat = new THREE.MeshBasicMaterial({ color: GRV_LT, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
        const haloGeo = new THREE.TorusGeometry(1.15, 0.09, 8, 22);
        const haloMat = new THREE.MeshBasicMaterial({ color: GRV_MAG, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
        const rope = new THREE.Mesh(ropeGeo, ropeMat);
        const halo1 = new THREE.Mesh(haloGeo, haloMat), halo2 = new THREE.Mesh(haloGeo, haloMat);
        halo1.rotation.x = Math.PI / 2;
        c.scene.add(rope, halo1, halo2);
        const _ry = new THREE.Vector3(0, 1, 0), _rq = new THREE.Quaternion();
        let t = 0;
        const hold = () => {
          t += 1 / 60;
          const alive = foe && !foe.dead;
          const from = c.controller.chest.clone().addScaledVector(c.forwardFlat, 0.4);
          const fc = alive ? foe.center.clone() : from.clone();
          const seg = fc.clone().sub(from); const len = Math.max(0.1, seg.length());
          rope.position.copy(from);
          rope.quaternion.copy(_rq.setFromUnitVectors(_ry, seg.multiplyScalar(1 / len)));
          rope.scale.set(1 + Math.sin(t * 40) * 0.4, len, 1 + Math.sin(t * 40 + 1) * 0.4);
          ropeMat.opacity = 0.5 + Math.sin(t * 26) * 0.25;
          // paralysis halo — two rings tumbling around the frozen foe
          halo1.position.copy(fc); halo2.position.copy(fc);
          halo1.rotation.z += 0.16; halo2.rotation.x = Math.PI / 2 + t * 3.2; halo2.rotation.y += 0.12;
          const pu = 1 + Math.sin(t * 9) * 0.12; halo1.scale.setScalar(pu); halo2.scale.setScalar(pu * 0.8);
          haloMat.opacity = alive ? 0.55 + Math.sin(t * 12) * 0.25 : 0;
          if (alive) {
            // hard lock — nothing moves them
            if (foe.velocity) foe.velocity.set(0, 0, 0);
            if (foe.impulse) foe.impulse.set(0, 0, 0);
            foe._stun = Math.max(foe._stun || 0, 0.4);
            if ((t * 60 | 0) % 6 === 0) c.combat.applyStatus(foe, 'gravity', { stacks: 3, duration: 1.2, maxStacks: 3 });
            if ((t * 60 | 0) % 8 === 0) c.vfx.burst(fc.clone().add(_v.set((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.6)), { count: 2, color: GRV_LT, color2: GRV_MAG, tile: 5, speed: 3, size: 0.28, life: 0.4, gravity: 0, drag: 1.6 });
            if ((t * 60 | 0) % 16 === 0) c.vfx.beam(() => from.clone(), () => fc.clone().sub(from).normalize(), { length: len, radius: 0.1, life: 0.16, color: GRV_MAG, core: 0xffffff });
          }
          if (t < PARA) { requestAnimationFrame(hold); return; }
          // --- RELEASE — the cage shatters ---
          c.scene.remove(rope, halo1, halo2);
          ropeGeo.dispose(); ropeMat.dispose(); haloGeo.dispose(); haloMat.dispose();
          if (foe && !foe.dead) {
            c.camera.addShake(0.4); c.combat.hitstop(0.06); flash(c, 0.14, GRV_LT);
            shardBurst(c, foe.center.clone(), { n: 22, speed: 20 });
            warp(c, foe.center.clone(), { size: 4, life: 0.35, arms: 5 });
            foe.takeHit({ damage: 22, dir: c.forwardFlat.clone().setY(0.18).normalize(), knockback: 26, up: 10, stun: 0.3 });
            c.combat.hooks?.onDamageNumber?.(foe.center.clone(), 22);
            c.combat.applyStatus(foe, 'gravity', { stacks: 3, duration: 4 });
          }
        };
        this.schedule(0.08, hold);
      }
    };

    // === V — METEORO: thrust a hand skyward and WRENCH a chunk of the sky
    // down — a jagged asteroid with violet-veined cracks, gravity-fire and a
    // warp halo screams onto the aimed point, distortion trailing, and CRACKS
    // THE WORLD — a violet fracture spreads, debris hangs then drops. ===
    this.slots.v = {
      name: 'Meteoro', cd: 9, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = ahead(c, 15); gp.y = gY(c, gp.x, gp.z);
        c.vfx.beam(() => c.controller.chest.clone(), () => _up.clone(), { length: 26, radius: 0.7, life: 0.9, color: GRV_DK, core: GRV_LT });
        c.vfx.decal(gp.clone(), { kind: 'crack', radius: 7, life: 3, groundY: gp.y, color: GRV_DK });
        for (let i = 0; i < 4; i++) this.schedule(i * 0.14, () => c.vfx.ring(gp.clone(), { color: i % 2 ? GRV_MAG : GRV_LT, radius: 7, life: 0.5 }));
        c.camera.addShake(0.25); flash(c, 0.12, GRV_LT);
        // the asteroid — dark jittered core + violet crack wireframe + warp halo
        const rk = new THREE.Group();
        const bg = new THREE.IcosahedronGeometry(2.6, 1);
        { const a = bg.attributes.position; for (let i = 0; i < a.count; i++) { const j = 0.7 + Math.random() * 0.6; a.setXYZ(i, a.getX(i) * j, a.getY(i) * j, a.getZ(i) * j); } bg.computeVertexNormals(); }
        const bm = new THREE.Mesh(bg, new THREE.MeshToonMaterial({ color: 0x1a1024, flatShading: true }));
        const vgeo = new THREE.IcosahedronGeometry(2.66, 1), hgeo = new THREE.IcosahedronGeometry(3.4, 1);
        const veins = new THREE.Mesh(vgeo, new THREE.MeshBasicMaterial({ color: GRV_MAG, wireframe: true, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
        const halo = new THREE.Mesh(hgeo, new THREE.MeshBasicMaterial({ color: GRV, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }));
        rk.add(bm, veins, halo);
        rk.position.set(gp.x + (Math.random() - 0.5) * 10, gp.y + 52, gp.z + (Math.random() - 0.5) * 10);
        c.scene.add(rk);
        const target = gp.clone().add(_up.clone().multiplyScalar(2));
        const vel = target.clone().sub(rk.position).normalize().multiplyScalar(40);
        let f = 0;
        const fall = () => {
          f++;
          vel.y -= 150 / 60;
          rk.position.addScaledVector(vel, 1 / 60);
          rk.rotation.x += 0.14; rk.rotation.z += 0.1;
          c.camera.addShake(0.02 + f * 0.004);
          if (f % 2 === 0) c.vfx.burst(rk.position.clone(), { count: 5, color: GRV_LT, color2: GRV_MAG, tile: 1, speed: 5, size: 0.8, life: 0.6, gravity: 0, drag: 1.1 });
          if (f % 3 === 0) c.vfx.airRift(rk.position.clone(), { size: 3, life: 0.25, color: GRV_LT, arms: 4 });
          if (rk.position.y <= target.y) {
            c.scene.remove(rk); bg.dispose(); vgeo.dispose(); hgeo.dispose(); bm.material.dispose(); veins.material.dispose(); halo.material.dispose();
            const ep = _v.set(rk.position.x, gY(c, rk.position.x, rk.position.z), rk.position.z).clone();
            slow(c, 0.14, 0.3); c.combat.hitstop(0.14); c.camera.addShake(1.8); flash(c, 0.3, GRV_LT);
            airCrack(c, ep.clone().add(_up), { size: 14, count: 8, life: 0.8, color: GRV_LT });
            warp(c, ep.clone().add(_up), { size: 12, life: 0.7, arms: 8 });
            shardBurst(c, ep.clone().add(_up), { n: 44, speed: 24 });
            c.vfx.dome(ep.clone(), { radius: 11, life: 0.7, color: GRV });
            c.vfx.crack(ep.clone(), { radius: 11, count: 16, life: 3, color: GRV });
            c.vfx.decal(ep.clone(), { kind: 'crack', radius: 11, life: 7, groundY: ep.y, color: GRV_DK });
            for (let i = 0; i < 5; i++) this.schedule(i * 0.045, () => c.vfx.ring(ep.clone(), { color: i % 2 ? GRV_MAG : GRV_LT, radius: 5 + i * 3.5, life: 0.55 }));
            suspend(c, ep, 8, 8, 0.6);
            c.combat.areaStrike(ep, { radius: 11, damage: 90, knockback: 34, up: 12, stun: 0.8, color: GRV, shake: 0.9, onHitTarget: (en) => c.combat.applyStatus(en, 'gravity', { stacks: 3, duration: 5 }) });
            return;
          }
          requestAnimationFrame(fall);
        };
        this.schedule(0.3, fall);
      }
    };

    // === T — EL PESO DEL CIELO: the cinematic ult. Point anywhere — the sky
    // is DRAGGED down. Phase 1: a vast shadow spreads, dust across the whole
    // arena rises and hangs, foes are pinned. Phase 2: a lens of compressed
    // space plunges. Phase 3: ONE total gravitational PRESS — the ground caves
    // into a bowl, everything is flattened. Phase 4: the crater crushes on. ===
    this.slots.ult = {
      name: 'El Peso del Cielo', cd: 34, _t: 0,
      cast: (c) => {
        c.pose('raise');
        const gp = ahead(c, 16); gp.y = gY(c, gp.x, gp.z);
        const R = 34;                                          // MASSIVE
        const HIGH = gp.clone().add(_up.clone().multiplyScalar(94));
        const ringP = (r, a) => gp.clone().add(_v.set(Math.cos(a) * r, 0, Math.sin(a) * r));

        // ===== PHASE 1 — THE GATHER (1.7 s) — the sky is dragged down =====
        c.combat.playerIFrames = Math.max(c.combat.playerIFrames, 9);
        slow(c, 1.7, 0.5);
        c.camera.addShake(0.4);
        c.camera.cine({ dist: 21, fov: 50, focus: gp, focusMix: 0.5, liftAdd: 12, inT: 0.55, holdT: 1.3, outT: 0.6 });
        c.vfx.storm(gp.clone(), { radius: R + 12, height: 60, duration: 4, color: 0x080610 });
        c.vfx.decal(gp.clone(), { kind: 'crack', radius: R, life: 20, groundY: gp.y, color: GRV_DK });
        c.vfx.beam(() => gp.clone(), () => _up.clone(), { length: 80, radius: 1.3, life: 1.7, color: GRV_DK, core: GRV_LT });
        for (let i = 0; i < 8; i++) this.schedule(i * 0.11, () => c.vfx.ring(gp.clone(), { color: i % 2 ? GRV_DK : GRV, radius: R * (0.25 + i * 0.1), life: 0.9 }));
        let g = 0;
        const gather = () => {
          g += 1 / 30;
          for (let i = 0; i < 4; i++) {
            const a = Math.random() * 6.283, rr = Math.sqrt(Math.random()) * R;
            c.vfx.burst(gp.clone().add(_v.set(Math.cos(a) * rr, 0.3, Math.sin(a) * rr)), { count: 2, color: i % 2 ? GRV_MAG : GRV_LT, color2: GRV_DK, tile: i % 2 ? 3 : 5, speed: 8, size: 0.6, life: 1.8, gravity: -12, drag: 0.4, dir: _up, cone: 0.32 });
          }
          for (const t of c.combat.enemiesInRadius(gp, R)) {
            if (t.velocity) t.velocity.y = Math.min(t.velocity.y, -8);
            if (t.impulse) t.impulse.set(0, 0, 0);
            t._stun = Math.max(t._stun || 0, 0.6);
            if ((g * 30 | 0) % 5 === 0) c.combat.applyStatus(t, 'gravity', { stacks: 3, duration: 3, maxStacks: 3 });
            if ((g * 30 | 0) % 7 === 0) c.vfx.burst(_v.set(t.center.x, gY(c, t.center.x, t.center.z), t.center.z).clone(), { count: 3, color: 0x8a7563, tile: 2, speed: 3, size: 0.5, life: 0.7, gravity: 7, drag: 1.5, dir: _up, cone: 1 });
          }
          if (g < 1.7) this.schedule(1 / 30, gather);
          else drop();
        };

        // ===== PHASE 2 — THE DROP (0.6 s) — a lens of compressed space plunges =====
        const drop = () => {
          c.camera.cine({ dist: 14, fov: 58, focus: gp, focusMix: 0.6, liftAdd: 5, inT: 0.1, holdT: 0.4, outT: 0.3 });
          const lens = new THREE.Group();
          const lc = new THREE.Mesh(new THREE.SphereGeometry(14, 26, 20), new THREE.MeshBasicMaterial({ color: 0x030209 }));
          const lr = new THREE.Mesh(new THREE.SphereGeometry(16, 24, 18), new THREE.MeshBasicMaterial({ color: GRV_LT, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false }));
          const lr2 = new THREE.Mesh(new THREE.SphereGeometry(17.5, 20, 14), new THREE.MeshBasicMaterial({ color: GRV, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false }));
          lens.add(lc, lr, lr2);
          lens.position.copy(HIGH);
          c.scene.add(lens);
          const tgt = gp.clone().add(_up.clone().multiplyScalar(5));
          let t = 0;
          const fall = () => {
            t += 1 / 60;
            const k = Math.min(1, t / 0.6);
            lens.position.lerpVectors(HIGH, tgt, k * k * k);
            lens.scale.setScalar(1 - k * 0.42);
            lens.rotation.y += 0.14;
            c.camera.addShake(0.14 + k * 0.9);
            c.vfx.burst(lens.position.clone(), { count: 7, color: GRV_LT, color2: GRV_DK, tile: 7, speed: 11, size: 0.55, life: 0.32, gravity: 0, drag: 1.4, dir: _up, cone: 2.2 });
            if (k >= 1) {
              c.scene.remove(lens); lc.geometry.dispose(); lr.geometry.dispose(); lr2.geometry.dispose(); lc.material.dispose(); lr.material.dispose(); lr2.material.dispose();
              press(true);
              return;
            }
            requestAnimationFrame(fall);
          };
          fall();
        };

        // ===== PHASE 3 — THE PRESS — one total gravitational SLAM (+ aftershock) =====
        const press = (main) => {
          const rr0 = main ? R : R * 0.62;
          flash(c, main ? 1.0 : 0.55, 0xffffff); slow(c, main ? 0.7 : 0.3, main ? 0.12 : 0.24);
          c.combat.hitstop(main ? 0.4 : 0.16); c.camera.addShake(main ? 4.5 : 2.0, main ? 1.4 : 2.5);
          if (main) c.camera.cine({ dist: 4.4, fov: 84, focus: gp, focusMix: 0.75, inT: 0.04, holdT: 0.5, outT: 2.0 });
          // SPACE ITSELF cracks + a violet crystalline shatter
          airCrack(c, gp.clone().add(_up.clone().multiplyScalar(2)), { size: rr0 * (main ? 1.4 : 1.0), count: 9, life: main ? 1.0 : 0.7, color: GRV_LT });
          warp(c, gp.clone().add(_up.clone().multiplyScalar(2)), { size: rr0 * 0.7, life: 0.8, arms: 9 });
          shardBurst(c, gp.clone().add(_up.clone().multiplyScalar(3)), { n: main ? 60 : 30, speed: 26 });
          // the earth breaks apart in outward WAVES
          for (let s = 0; s < (main ? 4 : 2); s++) this.schedule(s * 0.06, () => {
            c.vfx.shatter(gp.clone(), { radius: rr0 * (0.35 + s * 0.24), count: main ? 16 : 10, life: 4, groundY: gp.y, color: 0x241634 });
          });
          c.vfx.crack(gp.clone(), { radius: rr0, count: main ? 40 : 20, life: 3.5, color: GRV_DK });
          c.vfx.decal(gp.clone(), { kind: 'crack', radius: rr0, life: main ? 40 : 12, groundY: gp.y, color: GRV_DK });
          c.vfx.dome(gp.clone().add(_up), { radius: rr0 + 8, life: 1.4, color: GRV });
          c.vfx.flipbook(gp.clone().add(_up.clone().multiplyScalar(2)), { kind: 'impact', size: rr0 * 1.8, life: 0.8, color: 0xe6d8ff });
          c.vfx.burst(gp.clone().add(_up.clone().multiplyScalar(4)), { count: main ? 120 : 60, color: GRV_LT, color2: GRV_DK, tile: 5, speed: 24, size: 0.5, life: 0.6, gravity: 46, drag: 1.2, dir: _up.clone().negate(), cone: 0.9 });
          this.schedule(0.12, () => c.vfx.burst(gp.clone().add(_up), { count: main ? 100 : 50, color: GRV_LT, color2: GRV_DK, tile: 2, speed: 14, size: 1.1, life: 1.7, gravity: 7, drag: 1.3, dir: _up, cone: 2 }));
          debrisRing(c, gp, rr0 * 0.55, main ? 44 : 22);
          if (main) debrisRing(c, gp, rr0 * 0.9, 34);
          // FLUNG TERRAIN — big chunks blasted out that arc down into their own craters
          if (main) for (let i = 0; i < 14; i++) this.schedule(Math.random() * 0.12, () => {
            const a = Math.random() * 6.283;
            const dir = new THREE.Vector3(Math.cos(a), 0.55 + Math.random() * 0.7, Math.sin(a)).normalize();
            const cg = new THREE.IcosahedronGeometry(0.8 + Math.random() * 0.7, 0);
            c.combat.spawnProjectile({
              pos: gp.clone().add(_up.clone().multiplyScalar(2)), vel: dir.multiplyScalar(24 + Math.random() * 18), gravity: 36,
              radius: 0.9, life: 3, damage: 26, aoe: 0, knockback: 20, up: -4, color: GRV, trailColor: 0x8a7563,
              mesh: new THREE.Mesh(cg, new THREE.MeshToonMaterial({ color: 0x4a3e32, flatShading: true })),
              onImpact: (pp) => {
                const e2 = _v.set(pp.x, gY(c, pp.x, pp.z), pp.z).clone();
                cg.dispose();
                gravCrater(c, e2.clone(), { R: 4.5, dmg: 24, up: -6, stun: 0.5, press: 5, chunks: 8, shake: 0.35, silent: true });
              }
            });
          });
          const seen = new Set();
          for (let w = 0; w < (main ? 9 : 5); w++) this.schedule(w * 0.04, () => {
            const rw = ((w + 1) / (main ? 9 : 5)) * rr0;
            c.vfx.ring(gp.clone(), { color: w % 2 ? GRV_LT : GRV, radius: rw, life: 0.55, thickness: 0.8 });
            for (const t of c.combat.enemiesInRadius(gp, rw)) {
              if (seen.has(t)) continue; seen.add(t);
              const k = Math.max(0.3, 1 - t.center.distanceTo(gp) / rr0 * 0.55);
              const dmg = Math.round((w === 0 ? (main ? 420 : 140) : (main ? 130 : 55)) * k);
              if (t.velocity) t.velocity.set(0, -34, 0);
              t.takeHit({ damage: dmg, dir: null, knockback: w === 0 ? 12 : 26, up: -20, stun: w === 0 ? 3.5 : 1 });
              c.combat.hooks?.onDamageNumber?.(t.center.clone(), dmg);
              c.combat.applyStatus(t, 'gravity', { stacks: 3, duration: 8, maxStacks: 3 });
            }
          });
          this.schedule(0.15, () => smoke(c, gp.clone().add(_up.clone().multiplyScalar(7)), main ? 70 : 40));
          this.schedule(0.6, () => smoke(c, gp.clone().add(_up.clone().multiplyScalar(18)), main ? 52 : 28));
          if (main) this.schedule(1.2, () => smoke(c, gp.clone().add(_up.clone().multiplyScalar(30)), 34));
          if (!main) return;
          // --- the AFTERSHOCK: a second lens drops for the real hammer ---
          this.schedule(1.6, () => {
            const l2 = new THREE.Mesh(new THREE.SphereGeometry(8, 20, 14), new THREE.MeshBasicMaterial({ color: 0x040308 }));
            l2.position.copy(gp).add(_up.clone().multiplyScalar(52));
            c.scene.add(l2);
            let t2 = 0;
            const f2 = () => {
              t2 += 1 / 60;
              const k = Math.min(1, t2 / 0.34);
              l2.position.y = (gp.y + 52) - k * k * k * 48;
              c.camera.addShake(0.1 + k * 0.5);
              if (k >= 1) { c.scene.remove(l2); l2.geometry.dispose(); l2.material.dispose(); press(false); return; }
              requestAnimationFrame(f2);
            };
            f2();
          });
          // ===== PHASE 4 — THE CRATER holds & keeps collapsing (7 s) =====
          const af = { t: 0 };
          const field = () => {
            af.t += 0.4;
            for (const t of c.combat.enemiesInRadius(gp, R * 0.9)) {
              if (t.velocity) { t.velocity.y = Math.min(t.velocity.y, -6); t.velocity.x *= 0.86; t.velocity.z *= 0.86; }
              t._stun = Math.max(t._stun || 0, 0.35);
              t.takeHit({ damage: 6, dir: null, knockback: 0, up: 0, stun: 0.25 });
              c.combat.applyStatus(t, 'gravity', { stacks: 2, duration: 2 });
            }
            for (let i = 0; i < 2; i++) c.vfx.burst(ringP(Math.random() * R, Math.random() * 6.283).setY(0.3), { count: 2, color: 0x8a7563, tile: 2, speed: 2, size: 0.55, life: 1.3, gravity: 4, drag: 1.4, dir: _up, cone: 0.6 });
            if (af.t % 1.4 < 0.4) {                          // periodic aftershock ring — still hurts
              c.vfx.ring(gp.clone(), { color: GRV, radius: R * 0.7, life: 0.7, thickness: 0.6 });
              c.camera.addShake(0.3);
              c.combat.areaStrike(gp, { radius: R * 0.7, damage: 14, knockback: 4, up: -6, stun: 0.4, color: GRV, silent: true });
            }
            if (af.t < 7) this.schedule(0.4, field);
          };
          this.schedule(0.3, field);
        };

        this.schedule(0, gather);
      }
    };
  }

  update(dt) {
    super.update(dt);
    if (this._levit > 0) this._levit -= dt;
  }
}

/* roster ordered by rarity (drives the R cycle + start fruit) */
export const FRUITS = [
  BaraBara, BaneBane, SunaSuna, MeraMera, HieHie,
  ToriToriPhoenix, GomuGomu, GoroGoro, GuraGura, MaguMagu, ZushiZushi
];

/* ============================ shared abilities ============================ */
function fireFist(c, self) {
  c.pose('thrust');
  const dir = c.aimDir.clone();
  const origin = c.origin.clone();
  c.vfx.burst(origin.clone().addScaledVector(dir, 1), { count: 22, color: 0xffb43c, color2: 0xffffff, speed: 12, size: 0.32, life: 0.28, gravity: 0, drag: 4, dir, cone: 0.9 });
  c.vfx.flipbook(origin.clone().addScaledVector(dir, 1.6), { kind: 'muzzle', size: 4.2, life: 0.32, color: 0xffd8a0 });
  c.vfx.beam(() => c.controller.chest.clone(), () => dir.clone(), { length: 5.5, radius: 0.7, life: 0.28, color: 0xff5a1e, core: 0xffe08a });
  c.combat.spawnProjectile({
    pos: origin.clone().addScaledVector(dir, 1.2), vel: dir.clone().multiplyScalar(50), gravity: 0,
    radius: 0.95, life: 2.0, damage: 40, aoe: 4.6, knockback: 18, up: 5, color: 0xff5a1e, trailColor: 0xffb43c, mesh: ember(0xff5a1e, 0.75),
    onImpact: (p) => {
      const y = gY(c, p.x, p.z);
      c.vfx.flipbook(_v.set(p.x, y + 2, p.z).clone(), { kind: 'impact', size: 11, life: 0.5, color: 0xffc088 });
      c.vfx.flipbook(_v.set(p.x, y + 3, p.z).clone(), { kind: 'smoke', size: 9, life: 1.3, color: 0x6b5a4a, additive: false, rise: 1.4, spin: true });
      c.vfx.flame(_v.set(p.x, y, p.z).clone(), { radius: 3.6, height: 8.5, life: 1.4 });
      c.vfx.decal(_v.set(p.x, y, p.z).clone(), { kind: 'scorch', radius: 5, life: 7, groundY: y });
      c.vfx.dome(p, { radius: 8, life: 0.5, color: 0xff8a3c });
      c.vfx.burst(p, { count: 55, color: 0xffca3a, color2: 0xff3d12, tile: 1, speed: 15, size: 0.45, life: 0.8, gravity: 5, drag: 1.8 });
      smoke(c, p, 14);
      flash(c, 0.14, 0xffca9a);
      c.vfx.hazard(_v.set(p.x, y, p.z).clone(), {
        kind: 'fire', radius: 4, duration: 2.8, groundY: y,
        onTick: (ctr, r) => c.combat.areaStrike(ctr, { radius: r, damage: 6, knockback: 1, up: 0.5, stun: 0.1, silent: true, color: 0xff6a24 }),
        onEmit: (ep) => c.vfx.burst(ep, { count: 2, color: 0xffb43c, color2: 0xff3d12, tile: 1, speed: 2.5, size: 0.35, life: 0.5, gravity: -3, drag: 2, dir: _up, cone: 0.6 })
      });
    }
  });
  c.camera.addShake(0.2);
}

/* ============================ prop meshes ============================ */
function ember(color, r) {
  const g = new THREE.IcosahedronGeometry(r, 1);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color }));
  m.add(new THREE.Mesh(new THREE.SphereGeometry(r * 2.2, 12, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })));
  return m;
}
/* Gear 5 — a giant WHITE cartoon fist: rounded palm + 4 knuckles + a thumb +
   an additive glow shell. `grp.userData.dispose()` frees it. */
function g5Fist(r = 3) {
  const grp = new THREE.Group();
  const m = new THREE.MeshToonMaterial({ color: 0xffffff, emissive: 0x8a8a8a });
  grp.add(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), m));
  for (let i = 0; i < 4; i++) {
    const k = new THREE.Mesh(new THREE.SphereGeometry(r * 0.34, 10, 8), m);
    k.position.set((i - 1.5) * r * 0.5, r * 0.55, r * 0.5);
    grp.add(k);
  }
  const th = new THREE.Mesh(new THREE.SphereGeometry(r * 0.36, 10, 8), m);
  th.position.set(-r * 0.75, -r * 0.1, r * 0.35); grp.add(th);
  grp.add(new THREE.Mesh(new THREE.IcosahedronGeometry(r * 1.25, 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false })));
  grp.userData.dispose = () => grp.traverse((o) => { o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); });
  return grp;
}
/* swirling fireball: a shader sphere (`userData.u` = uniforms) + additive shell.
   Drive `u.uTime` each frame; raise `u.uGrow` 0->1 as it balloons & fades. */
function fireBall(radius = 1.4, hotCol = 0xffe6b0, edgeCol = 0xff5a1e) {
  const u = {
    uTime: { value: 0 }, uGrow: { value: 0 },
    uHot: { value: new THREE.Color(hotCol) }, uEdge: { value: new THREE.Color(edgeCol) }
  };
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: u,
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `precision highp float; varying vec3 vP;
      uniform float uTime, uGrow; uniform vec3 uHot, uEdge;
      float sw(vec3 p){ return sin(p.x*4.0+uTime*5.0)+sin(p.y*4.0-uTime*4.0)+sin(p.z*4.0+uTime*3.0); }
      void main(){
        float w = sw(vP*1.4) / 3.0;
        float bands = sin(vP.y*7.0 + w*5.0 - uTime*7.0) * 0.5 + 0.5;
        vec3 col = mix(uEdge, uHot, pow(bands, 1.5));
        col = mix(col, uEdge * 0.5, smoothstep(0.2, 1.0, w * 0.5 + 0.5));
        col += uHot * (1.0 - clamp(uGrow, 0.0, 1.0)) * 0.7;
        float a = mix(0.95, 0.1, clamp(uGrow, 0.0, 1.0));
        gl_FragColor = vec4(col, a);
      }`
  });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 3), mat);
  core.add(new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius * 1.35, 2),
    new THREE.MeshBasicMaterial({ color: edgeCol, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false })
  ));
  core.frustumCulled = false;
  core.userData.u = u;
  return core;
}
/* ring of charred rock chunks that pop up around a blast, then settle & fade.
   Each chunk is a mesh + its own rAF loop, so the count is hard-capped. */
function debrisRing(c, center, radius, count = 14) {
  count = Math.min(count, 22);
  const gy = gY(c, center.x, center.z);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * 6.283 + Math.random() * 0.5;
    const rr = radius * (0.78 + Math.random() * 0.32);
    const s = 0.32 + Math.random() * 0.6;
    const px = center.x + Math.cos(a) * rr, pz = center.z + Math.sin(a) * rr;
    const py = gY(c, px, pz);
    const geo = new THREE.IcosahedronGeometry(s, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshToonMaterial({
      color: new THREE.Color(0x2a1a12).lerp(new THREE.Color(0xff5a1e), Math.random() * 0.55)
    }));
    mesh.position.set(px, py + s, pz);
    mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    mesh.castShadow = false;   // tiny tumbling pebbles — shadow pass isn't worth it
    c.scene.add(mesh);
    const rest = py + s * 0.5;
    let vy = 4 + Math.random() * 5, t = 0;
    const tick = () => {
      t += 1 / 60;
      vy -= 30 / 60;
      mesh.position.y = Math.max(rest, mesh.position.y + vy / 60);
      mesh.rotation.x += 0.16; mesh.rotation.z += 0.11;
      if (t > 1.5) mesh.scale.multiplyScalar(0.85);
      if (t > 2.0) { c.scene.remove(mesh); geo.dispose(); mesh.material.dispose(); return; }
      requestAnimationFrame(tick);
    };
    tick();
  }
  c.vfx.burst(_v.set(center.x, gy + 0.3, center.z), {
    count: 42, color: 0x3a2418, color2: 0xff5a1e, speed: 17, size: 0.42, life: 0.9,
    gravity: 24, drag: 1.4, dir: _up, cone: 2.3
  });
}
/* Gura Gura "cracked air" — a shader billboard (branching fissures spread,
   hold, then flash & burst) plus a bright sprite pop + shard burst. */
function airCrack(c, pos, { size = 6, count = 5, life = 0.9, color = 0xd9d0ee } = {}) {
  c.vfx.airRift(pos.clone(), { size, life, color, arms: Math.min(9, count + 2) });
  c.vfx.flipbook(pos.clone(), { kind: 'impact', size: size * 0.9, life: Math.min(0.4, life * 0.5), color: 0xffffff });
  c.vfx.burst(pos.clone(), { count: 6 + count * 3, color: 0xffffff, color2: color, tile: 0, speed: 15, size: 0.32, life: 0.5, gravity: 4, drag: 1.7 });
}

/* Mera Mera core mechanic: consume every target's Burn stacks in a chain
   reaction. Each pop scales with stacks and splash-ignites/chains burning
   neighbours. `center`+`radius` limits it; omit for the whole field. */
function detonateBurn(c, { center = null, radius = 999, baseDmg = 14, perStack = 16, color = 0xff5a1e } = {}) {
  const hit = new Set();
  let count = 0;
  const wave = (t) => {
    if (hit.has(t) || t.dead) return;
    const st = t._status && t._status.burn;
    if (!st) return;
    hit.add(t); count++;
    const stacks = Math.max(1, st.stacks || 1);
    delete t._status.burn;                                  // consume it
    const p = t.center.clone();
    const dmg = baseDmg + perStack * stacks;
    t.takeHit({ damage: dmg, dir: _up.clone(), knockback: 10 + stacks * 4, up: 8 + stacks * 3, stun: 0.35 });
    c.combat.hooks && c.combat.hooks.onDamageNumber && c.combat.hooks.onDamageNumber(p.clone(), Math.round(dmg));
    const r = 2.6 + stacks * 1.1;
    c.vfx.flipbook(p.clone().add(_up), { kind: 'impact', size: 4 + stacks * 3, life: 0.4, color: 0xffdca8 });
    c.vfx.burst(p.clone(), { count: 14 + stacks * 8, color: 0xffca3a, color2: 0xff3d12, tile: 1, speed: 11 + stacks * 3, size: 0.34, life: 0.5, gravity: 4, drag: 1.8 });
    c.vfx.dome(p.clone(), { radius: r, life: 0.32, color: 0xff8a3c });
    c.vfx.ring(p.clone(), { color, radius: r, life: 0.28 });
    for (const o of c.combat.enemiesInRadius(p, r)) {
      if (o === t || hit.has(o)) continue;
      o.takeHit({ damage: dmg * 0.35, dir: o.center.clone().sub(p).setY(0.15).normalize(), knockback: 9, up: 4, stun: 0.18 });
      if (o._status && o._status.burn) wave(o);              // chain reaction
    }
  };
  const list = center
    ? c.combat.enemiesInRadius(center, radius)
    : c.combat.targets.filter((t) => !t.dead && (t.faction === 'enemy' || t.isDummy || t.pvp));
  for (const t of list) wave(t);
  return count;
}
/* Hie Hie core mechanic: SHATTER every enemy frozen solid (Escarcha at max
   stacks) — huge damage + an ice-shard spray that re-chills neighbours.
   Pass `target` for one, or `center`+`radius` / nothing for an area/field. */
function shatterFrozen(c, { center = null, radius = 999, target = null, baseDmg = 30 } = {}) {
  const pop = (t) => {
    if (!t || t.dead) return 0;
    const st = t._status && t._status.chill;
    if (!st || st.stacks < (st.max || 3)) return 0;
    delete t._status.chill;
    const p = t.center.clone();
    t.takeHit({ damage: baseDmg, dir: _up.clone(), knockback: 20, up: 8, stun: 0.6 });
    c.combat.hooks && c.combat.hooks.onDamageNumber && c.combat.hooks.onDamageNumber(p.clone(), Math.round(baseDmg));
    c.vfx.flipbook(p.clone().add(_up), { kind: 'impact', size: 9, life: 0.4, color: 0xeafaff });
    c.vfx.flipbook(p.clone().add(_up), { kind: 'shock', size: 8, life: 0.36, color: 0xdff6ff });
    c.vfx.burst(p.clone(), { count: 46, color: 0xeafaff, color2: 0xbfe4ff, tile: 0, speed: 18, size: 0.32, life: 0.6, gravity: 20, drag: 1.2, dir: _up, cone: 2.4 });
    c.vfx.ring(p.clone(), { color: 0xdff6ff, radius: 4, life: 0.3 });
    for (const o of c.combat.enemiesInRadius(p, 4)) {
      if (o === t) continue;
      o.takeHit({ damage: baseDmg * 0.3, dir: o.center.clone().sub(p).setY(0.15).normalize(), knockback: 12, up: 4, stun: 0.2 });
      c.combat.applyStatus(o, 'chill', { stacks: 1, duration: 4 });
    }
    c.combat.hitstop(0.04);
    return 1;
  };
  if (target) return pop(target);
  const list = center
    ? c.combat.enemiesInRadius(center, radius)
    : c.combat.targets.filter((t) => !t.dead && (t.faction === 'enemy' || t.isDummy || t.pvp));
  let count = 0;
  for (const t of list) count += pop(t);
  return count;
}
/* Goro Goro core mechanic: a fat forked bolt that LEAPS from enemy to enemy.
   Each hop is a 3-layer strike (branching bolt + ribbon + glow beam) with a
   node burst, a small dome and a scorched ground line. Damage tapers per hop;
   applies Electrocutado (`shock`). Returns how many it hit. */
function chainBolt(c, from, first, { jumps = 3, dmg = 16, range = 8, shock = true, color = 0x8fdcff } = {}) {
  const hit = new Set();
  let src = from.clone();
  let cur = first;
  for (let j = 0; j <= jumps && cur; j++) {
    if (hit.has(cur) || cur.dead) break;
    hit.add(cur);
    const p = cur.center.clone();
    for (let i = 0; i < 5; i++) c.vfx.bolt(src.clone(), p.clone(), { color: i ? color : 0xffffff, core: 0xffffff, branches: 6 - i, life: 0.18, jitter: 1.3 + i * 0.22 });
    c.vfx.ribbon(src.clone(), p.clone(), { width: 0.85, life: 0.18, color: 0xffffff });
    c.vfx.beam(() => src.clone(), () => p.clone().sub(src).normalize(), { length: src.distanceTo(p), radius: 0.5, life: 0.14, color: 0x6fb8ff, core: 0xffffff });
    // scorch the whole arc + a bright hit sigil
    for (let s = 0.2; s < 1; s += 0.28) { const m = src.clone().lerp(p, s); const my = gY(c, m.x, m.z); c.vfx.decal(_v.set(m.x, my, m.z).clone(), { kind: 'scorch', radius: 1.3, life: 2, groundY: my }); }
    c.vfx.flipbook(p.clone().add(_up), { kind: 'impact', size: 8, life: 0.32, color: 0xffffff });
    c.vfx.flipbook(p.clone().add(_up), { kind: 'shock', size: 9, life: 0.3, color: 0x9fdcff });
    c.vfx.burst(p.clone(), { count: 26, color: 0xffffff, color2: 0x6fb8ff, tile: 3, speed: 18, size: 0.32, life: 0.4, gravity: 3, drag: 2.2 });
    c.vfx.dome(p.clone(), { radius: 3.4, life: 0.26, color: color });
    c.vfx.ring(p.clone(), { color: 0xffffff, radius: 3, life: 0.22, vertical: true });
    // fork out to any other burning-close enemies (splash arcs)
    for (const o of c.combat.enemiesInRadius(p, range * 0.7)) {
      if (o === cur || hit.has(o)) continue;
      c.vfx.bolt(p.clone(), o.center.clone(), { color, core: 0xffffff, branches: 2, life: 0.12, jitter: 1.6 });
      o.takeHit({ damage: Math.round(dmg * 0.3), dir: o.center.clone().sub(p).setY(0.1).normalize(), knockback: 6, up: 2, stun: 0.12 });
      if (shock) c.combat.applyStatus(o, 'shock', { stacks: 1, duration: 3 });
    }
    const d = Math.round(dmg * Math.pow(0.9, j));
    cur.takeHit({ damage: d, dir: p.clone().sub(src).setY(0.12).normalize(), knockback: 12, up: 4, stun: 0.25 });
    c.combat.hooks && c.combat.hooks.onDamageNumber && c.combat.hooks.onDamageNumber(p.clone(), d);
    if (shock) c.combat.applyStatus(cur, 'shock', { stacks: 1, duration: 4, maxStacks: 3 });
    src = p;
    let best = null, bd = range * range;
    for (const t of c.combat.enemiesInRadius(p, range)) {
      if (hit.has(t) || t.dead) continue;
      const dd = t.center.distanceToSquared(p);
      if (dd < bd) { bd = dd; best = t; }
    }
    cur = best;
  }
  if (hit.size) c.combat.hitstop(0.03);
  return hit.size;
}
/* jagged burning meteor: dark rock + glowing crack wireframe + fiery halo.
   Placeholder until a real GLB is dropped in (ZushiZushi._meteorMesh). */
function meteorRock(r = 3) {
  const geo = new THREE.IcosahedronGeometry(r, 2);
  const gp = geo.attributes.position;
  for (let i = 0; i < gp.count; i++) {
    const s = 0.76 + Math.random() * 0.42;
    gp.setXYZ(i, gp.getX(i) * s, gp.getY(i) * s, gp.getZ(i) * s);
  }
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ color: 0x2b2530 }));
  rock.add(new THREE.Mesh(new THREE.IcosahedronGeometry(r * 1.03, 2),
    new THREE.MeshBasicMaterial({ color: 0xffb43c, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, wireframe: true, depthWrite: false })));
  rock.add(new THREE.Mesh(new THREE.IcosahedronGeometry(r * 1.5, 1),
    new THREE.MeshBasicMaterial({ color: 0xff6a24, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false })));
  rock.castShadow = true;
  rock.frustumCulled = false;
  return rock;
}
/* molten rock: dark jittered core + pulsing emissive-crack shell (no GLSL).
   `onBeforeRender` breathes the glow layer to fake heat pulse. */
function magmaRock(r = 0.8) {
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const gp = geo.attributes.position;
  for (let i = 0; i < gp.count; i++) { const s = 0.78 + Math.random() * 0.4; gp.setXYZ(i, gp.getX(i) * s, gp.getY(i) * s, gp.getZ(i) * s); }
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ color: 0x2a1a14 }));
  const cracks = new THREE.Mesh(new THREE.IcosahedronGeometry(r * 1.02, 1),
    new THREE.MeshBasicMaterial({ color: 0xff5a1e, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, wireframe: true, depthWrite: false }));
  rock.add(cracks);
  rock.add(new THREE.Mesh(new THREE.IcosahedronGeometry(r * 1.55, 1),
    new THREE.MeshBasicMaterial({ color: 0xff8a3c, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false })));
  let t = 0;
  rock.onBeforeRender = () => { t += 0.05; cracks.material.opacity = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(t * 6)); rock.rotation.x += 0.03; rock.rotation.y += 0.02; };
  rock.castShadow = true;
  rock.frustumCulled = false;
  return rock;
}
function crescent(color) {
  const g = new THREE.TorusGeometry(0.9, 0.16, 8, 20, Math.PI * 1.2);
  g.rotateY(Math.PI / 2);
  return new THREE.Mesh(g, new THREE.MeshToonMaterial({ color }));
}
function blade(color) {
  const g = new THREE.ConeGeometry(0.18, 0.9, 4);
  g.rotateX(Math.PI / 2);
  return new THREE.Mesh(g, new THREE.MeshToonMaterial({ color }));
}
function sandBall(color) {
  const g = new THREE.IcosahedronGeometry(0.62, 1);
  const gp = g.attributes.position;
  for (let i = 0; i < gp.count; i++) { const s = 0.82 + Math.random() * 0.34; gp.setXYZ(i, gp.getX(i) * s, gp.getY(i) * s, gp.getZ(i) * s); }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshToonMaterial({ color }));
  m.onBeforeRender = () => { m.rotation.x += 0.25; m.rotation.y += 0.18; };
  return m;
}
function sandPillar(c, pos, height) {
  const geo = new THREE.CylinderGeometry(0.75, 1.25, height, 7, 3);
  geo.translate(0, height / 2, 0);
  const gp = geo.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setX(i, gp.getX(i) * (0.82 + Math.random() * 0.36));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ color: 0xcbb27f }));
  mesh.position.copy(pos);
  mesh.rotation.y = Math.random() * 6.28;
  mesh.scale.y = 0.04;
  mesh.castShadow = true;
  c.scene.add(mesh);
  c.vfx.burst(pos, { count: 18, color: 0xdcc089, color2: 0x9c7b45, speed: 6, size: 0.36, life: 0.6, gravity: 12, drag: 1.6, dir: _up, cone: 1.2 });
  let t = 0;
  const tick = () => {
    t += 1 / 60;
    mesh.scale.y = t < 0.09 ? THREE.MathUtils.lerp(0.04, 1.12, t / 0.09) : t < 0.15 ? 1.12 - (t - 0.09) / 0.06 * 0.12 : 1;
    if (t > 0.85) { mesh.scale.x *= 0.94; mesh.scale.z *= 0.94; mesh.position.y -= 0.12; }
    if (t > 1.4) { c.scene.remove(mesh); geo.dispose(); mesh.material.dispose(); return; }
    requestAnimationFrame(tick);
  };
  tick();
}
/* An ice-crystal FORMATION (ref: the crystal-cluster art sheet): a SOLID,
   saturated blue faceted quartz point with a brighter teal inner crystal +
   (with `cluster:true`) 2 smaller flankers. `cluster` defaults to FALSE.
   Erupts, holds, collapses. Geometry + materials are POOLED/SHARED across
   every call — spawning dozens at once (Diamond Dust, Avalancha) must stay
   cheap, so nothing here allocates a geometry or a material per call. */
const _ICE_BODY = 0x53b7ee, _ICE_CORE = 0x8ff0e6, _ICE_ROCK = 0x1b3a5c;
const _spikeMat = new THREE.MeshToonMaterial({ color: _ICE_BODY, emissive: new THREE.Color(_ICE_CORE).multiplyScalar(0.22), transparent: true, opacity: 0.96, flatShading: true });
const _spikeGeoPool = [];
function _spikeGeo() {
  if (_spikeGeoPool.length < 6) {
    const g = new THREE.CylinderGeometry(0.16, 1, 1, 6, 3, false);   // unit crystal (r1, h1)
    const a = g.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const y = a.getY(i), up = y + 0.5;
      if (up > 0.06 && up < 0.94) {
        const j = 0.8 + Math.random() * 0.4;
        a.setX(i, a.getX(i) * j); a.setZ(i, a.getZ(i) * j);
        a.setY(i, y + (Math.random() - 0.5) * 0.06);
      }
    }
    g.computeVertexNormals();
    g.translate(0, 0.5, 0);          // base on y=0
    _spikeGeoPool.push(g);
    return g;
  }
  return _spikeGeoPool[(Math.random() * _spikeGeoPool.length) | 0];
}
function iceSpike(c, pos, height, opts = {}) {
  const rad = opts.radius ?? 0.55;
  const custom = opts.color != null && opts.color !== _ICE_BODY;
  const bodyMat = custom
    ? new THREE.MeshToonMaterial({ color: opts.color, emissive: new THREE.Color(opts.color).multiplyScalar(0.18), transparent: true, opacity: 0.95, flatShading: true })
    : _spikeMat;
  const cluster = opts.cluster ?? false;
  const grp = new THREE.Group();
  grp.position.copy(pos);
  grp.rotation.y = Math.random() * 6.28;
  if (opts.tilt && opts.lean) {
    grp.rotation.x = opts.tilt * opts.lean.z;
    grp.rotation.z = -opts.tilt * opts.lean.x;
  }
  const mk = (h, r, x, z, tiltOut) => {
    const mesh = new THREE.Mesh(_spikeGeo(), bodyMat);   // shared geo + material, no shadow, no inner mesh
    mesh.scale.set(r, h, r);
    mesh.position.set(x, 0, z);
    mesh.rotation.set(-z * 0.5 + (Math.random() - 0.5) * tiltOut, Math.random() * 6.28, -x * 0.5 + (Math.random() - 0.5) * tiltOut);
    grp.add(mesh);
  };
  mk(height, rad, 0, 0, 0.1);
  if (cluster) {
    mk(height * (0.5 + Math.random() * 0.2), rad * 0.66, rad * 1.2, rad * 0.3, 0.4);
    mk(height * (0.42 + Math.random() * 0.18), rad * 0.58, -rad * 1.15, -rad * 0.42, 0.4);
  }
  c.scene.add(grp);
  c.vfx.burst(pos, { count: opts.shards ?? 6, color: 0xbfeff0, color2: 0x4fb8d8, tile: 0, speed: opts.shardSpeed ?? 5, size: 0.22, life: 0.34, gravity: 12, drag: 2.2, dir: _up, cone: 0.9 });
  const hold = opts.hold ?? 1.6;
  let t = 0;
  const tick = () => {
    t += 1 / 60;
    const s = t < 0.1 ? t / 0.1 : 1;
    grp.scale.y = Math.max(0.02, s);
    if (t > hold - 0.35) grp.scale.y *= 0.86;
    if (t > hold) {
      c.scene.remove(grp);
      if (custom) bodyMat.dispose();
      return;
    }
    requestAnimationFrame(tick);
  };
  tick();
}
