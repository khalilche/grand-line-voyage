/**
 * AOPG-style progression. XP is tracked internally but the player only ever
 * sees a percent bar + level. Kills grant a percentage of the *current* level
 * bar, scaled by how the target's level compares to the player's (arcade rate:
 * a same-level NPC ≈ 8% of the bar, a same-level boss ≈ 64%). An anti-farm cap
 * keeps an over-levelled boss from being worth an absurd amount.
 */
const SAVE_KEY = 'account-progress-v1';

export class Progression {
  constructor(hooks = {}) {
    this.hooks = hooks;               // { onLevelUp(level), onXp(frac01, gainedFrac), onKill(info) }
    this.level = 1;
    this.xp = 0;                      // 0..1 of the current level bar
    this.maxLevel = 1500;

    // Account-level persistence (client-side only — this project has no
    // backend/database, see [[multiplayer]] memory — so "account level" is a
    // per-browser localStorage save). Needed so Haki's level-gated unlocks
    // (see Haki.js) mean something across sessions instead of resetting on
    // every refresh like everything else in this class used to.
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (saved && Number.isFinite(saved.level)) { this.level = saved.level; this.xp = saved.xp || 0; }
    } catch {}

    // per-level derived stats
    this.recompute();
  }

  save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ level: this.level, xp: this.xp })); } catch {}
  }

  recompute() {
    const L = this.level;
    this.maxHp = Math.round(100 + (L - 1) * 12 + Math.pow(L, 1.35) * 1.5);
    this.damageMult = 1 + (L - 1) * 0.06;
    this.moveBonus = 1 + Math.min(0.35, (L - 1) * 0.004);
  }

  /** fraction of the current bar a kill is worth */
  killValue(enemyLevel, isBoss = false) {
    const ratio = enemyLevel / Math.max(1, this.level);
    const scaled = Math.min(4, Math.max(0.15, ratio));   // anti-farm cap at 4×
    const base = isBoss ? 0.64 : 0.08;                   // arcade rate (doubled)
    return base * scaled;
  }

  grantKill(enemyLevel, isBoss = false) {
    if (this.level >= this.maxLevel) return { gained: 0, levels: 0 };
    const gain = this.killValue(enemyLevel, isBoss);
    let levels = 0;
    this.xp += gain;
    while (this.xp >= 1 && this.level < this.maxLevel) {
      this.xp -= 1;
      this.level++;
      levels++;
    }
    if (levels) {
      this.recompute();
      this.hooks.onLevelUp && this.hooks.onLevelUp(this.level, levels);
    }
    this.hooks.onXp && this.hooks.onXp(this.xp, gain);
    this.hooks.onKill && this.hooks.onKill({ enemyLevel, isBoss, gain, levels });
    this.save();
    return { gained: gain, levels };
  }

  /** 0..1 for the HUD bar */
  get frac() { return this.xp; }
}
