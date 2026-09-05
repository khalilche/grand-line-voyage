import * as THREE from 'three';

/**
 * Central arbiter for damage. Owns the target list + projectiles, runs melee
 * arc queries, applies hit-stop / screen-shake, and reports floating damage
 * numbers. Player health lives here too.
 */
export class CombatSystem {
  constructor(scene, world, vfx, hooks = {}) {
    this.scene = scene;
    this.world = world;
    this.vfx = vfx;
    this.hooks = hooks;              // { onDamageNumber, onHitstop, onShake, onPlayerHp }
    this.targets = [];
    this.projectiles = [];
    this.freezeAI = false;
    this.playerDamageMult = 1;        // scales with player level (+ Zoan form)
    this.playerDodge = 0;             // Logia elemental dodge chance 0..1
    this.playerHp = 100;
    this.playerMaxHp = 100;
    this.playerIFrames = 0;
    this.player = null;              // CharacterController

    // ---- status / elemental states (each fruit's Z applies one) ----
    this.STATUS = {
      burn:    { color: 0xff7a2c, tint: 0xff4400, tick: 0.5, dot: 4, slow: 0.0,  tile: 1, grav: -3 },
      magma:   { color: 0xd83c14, tint: 0xff5a1e, tick: 0.45, dot: 6, slow: 0.0, tile: 1, grav: -3, melt: true },
      chill:   { color: 0x9fdcff, tint: 0x4fb8ff, tick: 0.6, dot: 2, slow: 0.4,  tile: 0, grav: 3, freeze: true },
      shock:   { color: 0xbfe8ff, tint: 0x8fd0ff, tick: 0.4, dot: 3, slow: 0.15, tile: 3, grav: 3 },
      gravity: { color: 0x9a6cff, tint: 0x6a3cd6, tick: 0.5, dot: 2, slow: 0.3,  tile: 5, grav: 6, heavy: true },
      sand:    { color: 0xdcc089, tint: 0xbfa066, tick: 0.5, dot: 4, slow: 0.35, tile: 2, grav: 4, dehydrate: true },
      quake:   { color: 0xdfeeff, tint: 0x9fd0ff, tick: 0.6, dot: 2, slow: 0.1,  tile: 3, grav: 3 },
      sever:   { color: 0xff2e3e, tint: 0x9c0d18, tick: 0.5, dot: 3, slow: 0.0,  tile: 3, grav: 9 },
      coil:    { color: 0x8fe08f, tint: 0x4fbf6a, tick: 0.5, dot: 2, slow: 0.12, tile: 4, grav: -6 }
    };
  }

  /** apply / refresh an elemental state on a target */
  applyStatus(target, kind, { stacks = 1, maxStacks = 3, duration = 3.5 } = {}) {
    if (!target || (target.dead && !target.isDummy) || !this.STATUS[kind]) return;
    target._status = target._status || {};
    const cur = target._status[kind];
    if (cur) { cur.stacks = Math.min(maxStacks, cur.stacks + stacks); cur.t = 0; cur.duration = Math.max(cur.duration, duration); cur.max = maxStacks; }
    else target._status[kind] = { stacks: Math.min(maxStacks, stacks), max: maxStacks, t: 0, tt: 0, duration };
  }

  _tickStatuses(t, dt) {
    const s = t._status;
    t._statusSlow = 0; t._heavy = false;
    if (!s) return;
    for (const k in s) {
      const st = s[k], cat = this.STATUS[k];
      if (!cat) { delete s[k]; continue; }
      st.t += dt; st.tt += dt;
      const frac = 0.4 + 0.6 * st.stacks / st.max;
      if (cat.slow) t._statusSlow = Math.max(t._statusSlow, cat.slow * frac);
      if (cat.heavy) t._heavy = true;
      if (st.tt >= cat.tick) {
        st.tt = 0;
        const dmg = cat.dot * st.stacks * (cat.melt ? 1.4 : 1);
        t.takeHit({ damage: dmg, dir: null, knockback: 0, up: 0, stun: 0 });
        this.hooks.onDamageNumber && this.hooks.onDamageNumber(t.center.clone(), Math.round(dmg));
        this.vfx.burst(t.center, { count: 2 + st.stacks, color: cat.color, color2: cat.tint, tile: cat.tile, speed: 2.6, size: 0.32, life: 0.5, gravity: cat.grav, drag: 2, dir: _up1, cone: 1.6 });
        if (cat.freeze && st.stacks >= st.max) t._stun = Math.max(t._stun || 0, 0.9);
      }
      if (st.t >= st.duration) delete s[k];
    }
  }

  addTarget(t) { this.targets.push(t); return t; }
  setPlayer(controller) { this.player = controller; }

  hitstop(s = 0.06) { this.hooks.onHitstop && this.hooks.onHitstop(s); }
  shake(a) { this.hooks.onShake && this.hooks.onShake(a); }

  damagePlayer(amount, dir, opts = {}) {
    if (this.playerIFrames > 0) return;
    // Busoshoku bypass: the attacker's melee ignores our Logia elemental
    // dodge (`playerDodge`) entirely — see Haki.js / Game.js `_doMelee`.
    if (!opts.ignoreDodge && this.playerDodge > 0 && Math.random() < this.playerDodge) {
      this.playerIFrames = 0.25;
      this.hooks.onDodge && this.hooks.onDodge();
      return;
    }
    this.playerHp = Math.max(0, this.playerHp - amount);
    this.playerIFrames = 0.6;
    this.hooks.onPlayerHp && this.hooks.onPlayerHp(this.playerHp / this.playerMaxHp);
    this.shake(0.35);
    this.hitstop(0.05);
    if (this.player && dir) {
      this.player.velocity.addScaledVector(dir, 7);
      this.player.velocity.y += 3;
    }
  }
  healPlayer(a) {
    this.playerHp = Math.min(this.playerMaxHp, this.playerHp + a);
    this.hooks.onPlayerHp && this.hooks.onPlayerHp(this.playerHp / this.playerMaxHp);
  }

  /** live enemy targets within `maxDist` of `pos`, nearest first (for chains). */
  nearestEnemies(pos, count = 3, maxDist = 14, exclude = null) {
    const out = [];
    for (const t of this.targets) {
      if (t.dead || (t.faction !== 'enemy' && !t.pvp) || t === exclude) continue;
      const d = pos.distanceTo(t.center);
      if (d <= maxDist) out.push({ t, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, count).map((o) => o.t);
  }
  enemiesInRadius(center, r) {
    return this.targets.filter((t) => !t.dead && (t.faction === 'enemy' || t.isDummy || t.pvp) && t.center.distanceTo(center) <= r + t.radius);
  }

  /**
   * Cone/arc melee query around `origin` facing `dir`.
   * @returns {number} number of targets hit
   */
  meleeStrike(origin, dir, {
    arc = Math.PI * 0.62, range = 2.8, damage = 12, knockback = 8, up = 2,
    stun = 0.3, hitstop = 0.055, shake = 0.14, color = 0xffffff, faction = 'enemy', onHitTarget = null,
    ignoreDodge = false   // Busoshoku: bypasses the target's Logia elemental dodge (only meaningful on `pvp` targets today — see Haki.js)
  } = {}) {
    const flatDir = _v1.set(dir.x, 0, dir.z).normalize();
    const dmg = damage * (faction === 'enemy' ? this.playerDamageMult : 1);
    let hits = 0;
    for (const t of this.targets) {
      if (t.dead && !t.isDummy) continue;
      if (faction && t.faction !== faction && !t.isDummy && !t.pvp) continue;
      const to = _v2.copy(t.center).sub(origin);
      const d = to.length();
      if (d > range + t.radius) continue;
      to.y = 0; to.normalize();
      if (flatDir.dot(to) < Math.cos(arc * 0.5)) continue;
      const kdir = _v3.copy(t.center).sub(origin); kdir.y = 0; kdir.normalize();
      t.takeHit({ damage: dmg, dir: kdir, knockback, up, stun, ignoreDodge });
      if (onHitTarget) onHitTarget(t);
      this._onHitFx(t.center, color, dmg, kdir);
      hits++;
    }
    if (hits) { this.hitstop(hitstop); this.shake(shake); }
    return hits;
  }

  /** Radial burst damage (explosions, slams). */
  areaStrike(center, {
    radius = 4, damage = 20, knockback = 12, up = 6, stun = 0.4,
    hitstop = 0.07, shake = 0.4, color = 0xffa53c, faction = 'enemy', falloff = true,
    silent = false, onHitTarget = null
  } = {}) {
    const dmg = damage * (faction === 'enemy' ? this.playerDamageMult : 1);
    let hits = 0;
    for (const t of this.targets) {
      if (t.dead && !t.isDummy) continue;
      if (faction && t.faction !== faction && !t.isDummy && !t.pvp) continue;
      const to = _v2.copy(t.center).sub(center);
      const d = to.length();
      if (d > radius + t.radius) continue;
      const k = falloff ? THREE.MathUtils.clamp(1 - d / (radius + t.radius), 0.2, 1) : 1;
      const kdir = _v3.copy(to).setY(0.15).normalize();
      t.takeHit({ damage: dmg * k, dir: kdir, knockback: knockback * k, up: up * k, stun });
      if (!silent) this._onHitFx(t.center, color, dmg * k, kdir);
      else if (this.hooks.onDamageNumber) this.hooks.onDamageNumber(t.center.clone(), Math.round(dmg * k));
      if (onHitTarget) onHitTarget(t, k);
      hits++;
    }
    if (hits) { this.hitstop(hitstop); this.shake(shake); }
    return hits;
  }

  spawnProjectile(opts) {
    const p = {
      pos: opts.pos.clone(),
      vel: opts.vel.clone(),
      gravity: opts.gravity ?? 0,
      drag: opts.drag ?? 0,
      radius: opts.radius ?? 0.4,
      life: opts.life ?? 3,
      damage: (opts.damage ?? 15) * ((opts.faction ?? 'enemy') === 'enemy' ? this.playerDamageMult : 1),
      aoe: opts.aoe ?? 0,
      knockback: opts.knockback ?? 8,
      up: opts.up ?? 2,
      pierce: opts.pierce ?? false,
      color: opts.color ?? 0xffffff,
      trailColor: opts.trailColor ?? opts.color ?? 0xffffff,
      faction: opts.faction ?? 'enemy',
      visualOnly: !!opts.visualOnly,          // replayed remote casts: move + trail + onImpact, hit nothing
      onImpact: opts.onImpact ?? null,
      mesh: opts.mesh ?? this._defaultProjMesh(opts.color ?? 0xffffff, opts.radius ?? 0.4),
      _trailT: 0, _hitSet: new Set(), _t: 0
    };
    p.mesh.position.copy(p.pos);
    this.scene.add(p.mesh);
    this.projectiles.push(p);
    return p;
  }

  _defaultProjMesh(color, radius) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 12, 10),
      new THREE.MeshBasicMaterial({ color })
    );
    return m;
  }

  _onHitFx(pos, color, dmg, dir) {
    this.vfx.burst(pos, {
      count: 14, color: 0xffffff, color2: color, speed: 7, size: 0.22,
      life: 0.35, gravity: 4, drag: 3, dir, cone: 2.4
    });
    this.vfx.ring(pos, { color, radius: 1.6, life: 0.28, y: 0, vertical: true });
    this.hooks.onDamageNumber && this.hooks.onDamageNumber(pos.clone(), Math.round(dmg));
  }

  update(dt) {
    if (this.playerIFrames > 0) this.playerIFrames -= dt;

    // targets
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];
      if (t.think && !this.freezeAI) t.think(dt, this.player ? this.player.position : _v1.set(0, 0, 0), this.world);
      this._tickStatuses(t, dt);
      t.update(dt, this.world);
      if (t.dead && !t.isDummy) {
        t._deadT = (t._deadT || 0) + dt;
        t.obj.scale.setScalar(Math.max(0, 1 - t._deadT * 1.3));
        if (t._deadT > 1.1) {
          this.scene.remove(t.obj);
          this.targets.splice(i, 1);
        }
      }
    }

    // projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p._t += dt;
      p.vel.y -= p.gravity * dt;
      if (p.drag) p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      p.mesh.position.copy(p.pos);
      p.mesh.scale.setScalar(1 + Math.sin(p._t * 30) * 0.06);

      // trail
      p._trailT += dt;
      if (p._trailT > 0.02) {
        p._trailT = 0;
        this.vfx.burst(p.pos, {
          count: 3, color: p.trailColor, color2: 0xffffff, speed: 0.6,
          size: p.radius * 1.6, life: 0.3, gravity: -1, drag: 2, cone: 2
        });
      }

      let impacted = false;

      // ground / water
      const g = this.world.sampleGround(p.pos.x, p.pos.z);
      const surfaceY = g.onLand ? g.height : this.world.waterHeight(p.pos.x, p.pos.z);
      if (p.pos.y <= surfaceY) { impacted = true; p.pos.y = surfaceY; }

      // targets
      if (!p.visualOnly && (!impacted || p.aoe > 0)) {
        for (const t of this.targets) {
          if (t.dead && !t.isDummy) continue;
          if (t.faction === p.faction && !t.isDummy) continue;
          if (p._hitSet.has(t)) continue;
          if (p.pos.distanceTo(t.center) <= p.radius + t.radius) {
            if (p.aoe <= 0) {
              const kdir = _v2.copy(t.center).sub(p.pos).setY(0.1).normalize();
              t.takeHit({ damage: p.damage, dir: kdir, knockback: p.knockback, up: p.up, stun: 0.3 });
              this._onHitFx(t.center, p.color, p.damage, kdir);
            }
            p._hitSet.add(t);
            if (!p.pierce) { impacted = true; break; }
          }
        }
      }

      if (impacted || p._t > p.life) {
        if (p.aoe > 0 && impacted && !p.visualOnly) {
          this.areaStrike(p.pos, {
            radius: p.aoe, damage: p.damage, knockback: p.knockback, up: p.up,
            color: p.color, faction: p.faction
          });
        }
        if (p.onImpact) p.onImpact(p.pos.clone(), impacted);
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose?.();
        this.projectiles.splice(i, 1);
      }
    }
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _up1 = new THREE.Vector3(0, 1, 0);
