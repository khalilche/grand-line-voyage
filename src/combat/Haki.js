import * as THREE from 'three';

/**
 * Haki v2 — Kenbunshoku (Observation), Busoshoku (Armament, both toggles
 * sharing one meter) and Haoshoku (Conqueror, a separate one-shot ultimate
 * with its own long cooldown, no meter cost). Rewritten from the v1 pass
 * (radar-ping Observation + repeating-pulse Conqueror-as-toggle) to match a
 * full mechanic/balance/unlock spec — see [[haki-system]] memory for the
 * full before/after and the account-level unlock design.
 *
 * All tunable numbers live here as named constants (never hardcoded at the
 * call sites) so the whole kit can be rebalanced after playtesting without
 * hunting through Game.js/CombatSystem.js.
 */

// ---- meter ----
export const METER_MAX = 100;
export const DRAIN_PER_SEC = 15;          // while EITHER toggle is on (flat — not additive per toggle)
export const REGEN_PER_SEC = 10;          // while BOTH toggles are off
export const REGEN_DELAY = 0;             // seconds of "both off" before regen starts (0 = instant, per spec)
export const REACTIVATE_MIN_FRAC = 0.20;  // can't turn a toggle back on below this fraction after hitting 0

// ---- Kenbunshoku (Observation) ----
export const KEN_WARNING_LEAD = 0.4;      // seconds of advance warning on an incoming hit
export const KEN_PROJECTILE_HIT_R = 2.2;  // "close enough to me" radius used by the projectile predictor
export const KEN_PING_INTERVAL = 1.8;     // seconds between the cheap "sonar" ring pulses while active

// ---- Busoshoku (Armament) ----
export const BUSO_MELEE_MULT = 1.20;      // +20% on basic melee ONLY (never fruit-ability damage) — applied at Game._doMelee

// ---- Haoshoku (Conqueror) ----
export const HAO_RADIUS = 15;
export const HAO_NPC_STUN = 3.0;
export const HAO_PVP_SLOW_FRAC = 0.40;
export const HAO_PVP_SLOW_DUR = 1.5;
export const HAO_PVP_STUN = 0.3;
export const HAO_DAMAGE_FRAC = 0.08;      // 8% of target max HP — control is the point, not damage (spec: 5-10%)
export const HAO_COOLDOWN = 110;          // seconds (spec: 100-120)
export const HAO_ANTICIPATION = 0.5;      // seconds of aura before the wave fires

// ---- account-level unlocks (see Progression.js for the persisted level) ----
export const UNLOCK_LEVEL_KEN = 15;
export const UNLOCK_LEVEL_BUSO = 30;
export const UNLOCK_LEVEL_HAO_MIN = 50;
export const UNLOCK_CHANCE_HAO = 0.02;    // rolled ONCE, the first time level >= UNLOCK_LEVEL_HAO_MIN
const HAO_SAVE_KEY = 'haki-haoshoku-v1';

export class Haki {
  constructor() {
    this.meter = METER_MAX;
    this.maxMeter = METER_MAX;   // convenience alias for HUD code
    this.armament = false;     // Busoshoku toggle
    this.observation = false;  // Kenbunshoku toggle
    this._regenT = 0;
    this._haoCd = 0;           // seconds left before Haoshoku can be cast again
    this._haoPending = null;   // seconds left in the anticipation beat before the wave actually fires
    this._kenPingT = 0;

    this.unlocked = { observation: false, armament: false, haoshoku: false };
    this._haoRoll = { rolled: false, unlocked: false };
    try {
      const saved = JSON.parse(localStorage.getItem(HAO_SAVE_KEY) || 'null');
      if (saved) this._haoRoll = saved;
    } catch {}
  }

  /** Call once at boot and again whenever account level changes (Progression's onLevelUp). */
  refreshUnlocks(level) {
    this.unlocked.observation = level >= UNLOCK_LEVEL_KEN;
    this.unlocked.armament = level >= UNLOCK_LEVEL_BUSO;
    if (!this._haoRoll.rolled && level >= UNLOCK_LEVEL_HAO_MIN) {
      this._haoRoll = { rolled: true, unlocked: Math.random() < UNLOCK_CHANCE_HAO };
      try { localStorage.setItem(HAO_SAVE_KEY, JSON.stringify(this._haoRoll)); } catch {}
    }
    this.unlocked.haoshoku = this._haoRoll.unlocked;
  }

  /** Dev/achievement escape hatch — grant Haoshoku without relying on the 2% roll. */
  grantHaoshoku() {
    this._haoRoll = { rolled: true, unlocked: true };
    try { localStorage.setItem(HAO_SAVE_KEY, JSON.stringify(this._haoRoll)); } catch {}
    this.unlocked.haoshoku = true;
  }

  get active() { return this.armament || this.observation; }
  get haoReady() { return this.unlocked.haoshoku && this._haoCd <= 0; }
  get haoCooldownFrac() { return THREE.MathUtils.clamp(1 - this._haoCd / HAO_COOLDOWN, 0, 1); }

  /** flip Kenbunshoku/Busoshoku on/off. Refuses if not unlocked, or turning ON below the reactivation floor. */
  toggle(kind) {
    if (kind !== 'armament' && kind !== 'observation') return;
    if (!this.unlocked[kind]) return;
    if (!this[kind] && this.meter < METER_MAX * REACTIVATE_MIN_FRAC) return;
    this[kind] = !this[kind];
  }

  update(dt, ctx) {
    // ---- shared meter ----
    if (this.armament || this.observation) {
      this.meter = Math.max(0, this.meter - DRAIN_PER_SEC * dt);
      this._regenT = 0;
      if (this.meter <= 0) { this.armament = false; this.observation = false; }
    } else {
      this._regenT += dt;
      if (this._regenT >= REGEN_DELAY) this.meter = Math.min(METER_MAX, this.meter + REGEN_PER_SEC * dt);
    }

    // ---- Haoshoku cooldown (independent of the meter entirely) ----
    if (this._haoCd > 0) this._haoCd = Math.max(0, this._haoCd - dt);

    if (!ctx) return;

    // ---- Kenbunshoku: incoming-attack telegraph + a periodic cheap "sonar" ping so the field reads as alive, not just a static outline ----
    if (this.observation) {
      this._scanTelegraphs(ctx);
      this._kenPingT += dt;
      if (this._kenPingT >= KEN_PING_INTERVAL) { this._kenPingT = 0; this._fireKenPing(ctx); }
    } else this._kenPingT = 0;

    // ---- Haoshoku's anticipation beat: aura fires instantly on cast, the actual wave/damage lands HAO_ANTICIPATION seconds later at wherever the caster is BY THEN ----
    if (this._haoPending != null) {
      this._haoPending -= dt;
      if (this._haoPending <= 0) { this._haoPending = null; this._fireHaoshoku(ctx); }
    }
  }

  _fireKenPing(ctx) {
    ctx.vfx.ring(_v.copy(ctx.origin).setY(ctx.origin.y - 0.95), { color: 0x9fd0ff, radius: 1.4, life: 0.9, vertical: false });
  }

  _scanTelegraphs(ctx) {
    const origin = ctx.origin;
    // 1) PvE enemy melee — real windup→strike AI state (see Enemies.js `_banditThink`)
    for (const t of ctx.combat.targets) {
      if (t.dead || t.pvp || t.faction !== 'enemy' || !t.ai) continue;
      const a = t.ai;
      if (a.state !== 'windup' || !a.windupDur) { t._kenWarned = false; continue; }
      const remain = a.windupDur - a.t;
      if (remain < 0 || remain > KEN_WARNING_LEAD) continue;
      if (t._kenWarned) continue;
      t._kenWarned = true;
      this._fireTelegraph(t.center, remain, ctx);
    }
    // 2) Incoming projectiles — peers' replayed casts (faction:'replay', see Game._makeReplayCombat)
    //    are already rendered locally as real moving objects; predict a close pass in the next
    //    KEN_WARNING_LEAD seconds via simple linear extrapolation (cheap, good enough for a warning).
    for (const p of ctx.combat.projectiles) {
      if (p.faction !== 'replay' || p._kenWarned) continue;
      const now = p.pos.distanceTo(origin);
      const future = _tmp.copy(p.pos).addScaledVector(p.vel, KEN_WARNING_LEAD).distanceTo(origin);
      if (future < KEN_PROJECTILE_HIT_R && future < now) {
        p._kenWarned = true;
        this._fireTelegraph(p.pos, KEN_WARNING_LEAD, ctx);
      }
    }
  }

  /** Cheap, particle-free warning marker — a pulsing red ring that shrinks/fades over the remaining time until impact. */
  _fireTelegraph(pos, remain, ctx) {
    ctx.vfx.ring(_v.copy(pos).setY(pos.y + 0.05), { color: 0xff3344, radius: 1.1, life: Math.max(0.12, remain), vertical: false });
  }

  /**
   * Haoshoku — a single-cast AoE, NOT a toggle, doesn't touch the Haki meter.
   * Two beats, per spec: an anticipation aura fires immediately, then
   * HAO_ANTICIPATION seconds later the real wave lands (at wherever the
   * caster is BY THEN, via `update()`/`_fireHaoshoku`, not frozen at the
   * press moment — reads as "gathering power then releasing", not instant).
   * Returns true if the cast was accepted (cooldown/unlock allowed it).
   */
  castHaoshoku(ctx) {
    if (!this.haoReady) return false;
    this._haoCd = HAO_COOLDOWN;
    this._haoPending = HAO_ANTICIPATION;

    // ---- anticipation: dark-purple aura gathering on the caster, screen dims, a beat of hitstop-free tension ----
    const origin = ctx.origin;
    ctx.vfx.burst(origin.clone(), {
      count: 28, color: 0x160826, color2: 0x8a2fd6, tile: 4, speed: 1.7, size: 0.5,
      life: HAO_ANTICIPATION + 0.2, gravity: -1.6, drag: 1.1, dir: _up, cone: 3.05
    });
    ctx.vfx.ring(origin.clone(), { color: 0x8a2fd6, radius: 1.35, life: HAO_ANTICIPATION, vertical: true });
    ctx.render?.flash?.(HAO_ANTICIPATION * 1.3, 0x0a0014);
    ctx.camera.addShake(0.5, HAO_ANTICIPATION);
    return true;
  }

  /** The actual release — NPCs fully stunned, PvP opponents get the much softer spec'd slow+short-stun instead so it can't fully lock out a rival player. */
  _fireHaoshoku(ctx) {
    const origin = ctx.origin.clone();
    let hits = 0;
    for (const t of ctx.combat.targets) {
      if (t.dead) continue;
      const d = t.center.distanceTo(origin);
      if (d > HAO_RADIUS + (t.radius || 0)) continue;
      const away = _v.copy(t.center).sub(origin).setY(0.2).normalize();
      if (t.pvp) {
        // PvP: soft control, not a lockout — short stun + a temporary slow, small chip damage.
        const dmg = (t.maxHp || 100) * HAO_DAMAGE_FRAC;
        t.takeHit({
          damage: dmg, dir: away, knockback: 4, up: 1.5, stun: HAO_PVP_STUN,
          slowFrac: HAO_PVP_SLOW_FRAC, slowDur: HAO_PVP_SLOW_DUR
        });
      } else {
        const dmg = (t.maxHp || t.hp || 100) * HAO_DAMAGE_FRAC;
        t.takeHit({ damage: dmg, dir: away, knockback: 10, up: 4, stun: HAO_NPC_STUN });
      }
      hits++;
    }

    ctx.camera.addShake(hits ? 2.2 : 1.1, 1.6);
    ctx.combat.hitstop(hits ? 0.18 : 0.07);
    ctx.vfx.dome(origin.clone(), { radius: HAO_RADIUS, life: 0.75, color: 0x1a0a2a });
    ctx.vfx.ring(origin.clone(), { color: 0x8a2fd6, radius: HAO_RADIUS, life: 0.7 });                // fast inner shock
    ctx.vfx.ring(origin.clone(), { color: 0x4a1a6a, radius: HAO_RADIUS * 1.6, life: 1.05 });          // slower, bigger outer wave — reads as pressure still expanding after the first crack
    ctx.vfx.burst(origin.clone().add(_up), {
      count: 70, color: 0x2a0a3a, color2: 0xd6aaff, tile: 4, speed: 18, size: 0.5,
      life: 0.7, gravity: 2, drag: 1.6, dir: _up, cone: 2.6
    });
    ctx.render?.flash?.(0.35, 0x2a0a4a);
  }
}

const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _tmp = new THREE.Vector3();
