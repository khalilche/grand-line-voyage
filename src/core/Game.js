import * as THREE from 'three';
import { RenderSystem } from '../rendering/RenderSystem.js';
import { Input } from './Input.js';
import { World } from '../world/World.js';
import { VFX } from '../fx/VFX.js';
import { Character } from '../entities/Character.js';
import { CharacterController } from '../entities/CharacterController.js';
import { CameraRig } from '../camera/CameraRig.js';
import { Boat } from '../entities/Boat.js';
import { CombatSystem } from '../combat/CombatSystem.js';
import { Haki, BUSO_MELEE_MULT } from '../combat/Haki.js';
import { HUD } from '../ui/HUD.js';
import { WorldMap } from '../ui/WorldMap.js';
import { makeDummy, makeBandit, makeBoss } from '../entities/Enemies.js';
import { makeNPC } from '../entities/NPC.js';
import { Progression } from '../game/Progression.js';
import { FRUITS } from '../combat/DevilFruit.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const _NDC_CENTER = new THREE.Vector2(0, 0);   // screen-centre NDC, for aim-point raycasts while look is locked

export class Game {
  constructor({ mount, onProgress }) {
    this.mount = mount;
    this.onProgress = onProgress || (() => {});
    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.frame = 0;
    this._hitstop = 0;
    this._slowmo = 0;
    this._slowmoScale = 0.4;
    this.mode = 'foot';                 // 'foot' | 'sail'
    this._raf = 0;

    // melee combo
    this._combo = 0;
    this._comboTimer = 0;
    this._attackPose = null;
    this._attackPoseT = 0;

    this._fruitIdx = 0;
    this._boardCd = 0;

    this.npcs = [];
    this.activeBoss = null;
    this._currentIslandId = null;
    this._dialogue = null;            // { conv:[str], idx }
  }

  async init() {
    const p = this.onProgress;
    p(0.05);

    this.scene = new THREE.Scene();
    this.render = new RenderSystem(this.mount);
    this.input = new Input(this.render.renderer.domElement);
    p(0.15);

    this.world = new World(this.scene);
    p(0.55);

    this.vfx = new VFX(this.scene);

    this.character = new Character();
    this.scene.add(this.character.root);

    this.controller = new CharacterController(this.character.root, this.world);

    this._footColliders = this.world.footColliders;
    this.camera = new CameraRig(this.input, this._footColliders);
    this.camera.camera.position.set(0, 6, 14);
    p(0.7);

    this.boat = new Boat(this.scene, this.world, this.vfx);
    if (this.world.isArena) this.boat.root.visible = false;   // battleground: no sailing

    this.hud = new HUD();
    this.worldMap = new WorldMap();
    this.worldMap.setMarkers(this.world.mapMarkers);
    if (this.world.isArena) this.worldMap.enabled = false;

    this.progression = new Progression({
      onLevelUp: (lv) => {
        this.hud.flashLevelUp(lv);
        this.combat.playerMaxHp = this.progression.maxHp;
        this.combat.playerHp = this.progression.maxHp;
        this.combat.playerDamageMult = this.progression.damageMult;
        this.controller.runSpeed = 13.2 * this.progression.moveBonus;
        this.hud.setHealth(1);
        this.camera.addShake(0.2);
        this.vfx.ring(this.controller.chest, { color: 0xffe58a, radius: 5, life: 0.6, vertical: true });
        this.vfx.burst(this.controller.chest, { count: 40, color: 0xffe58a, color2: 0xffffff, speed: 8, size: 0.36, life: 0.8, gravity: -3, drag: 2, tile: 4 });
        this.haki.refreshUnlocks(this.progression.level);
      },
      onXp: (frac) => this.hud.setXp(frac)
    });

    this.haki = new Haki();
    this.haki.refreshUnlocks(this.progression.level);
    // TEST MODE: force all 3 Haki unlocked regardless of account level, so
    // the kit can be tried out now instead of waiting to reach level 15/30/50.
    // Doesn't touch the real level-gating logic or the saved account level —
    // just overrides what it decided. Remove this line once testing is done.
    this.haki.unlocked = { observation: true, armament: true, haoshoku: true };

    this.combat = new CombatSystem(this.scene, this.world, this.vfx, {
      onDamageNumber: (pos, amt) => this.hud.damageNumber(pos, amt),
      onHitstop: (s) => { this._hitstop = Math.max(this._hitstop, s); },
      onShake: (a) => this.camera.addShake(a),
      onPlayerHp: (f) => this.hud.setHealth(f),
      onFlash: (a, col) => this.render.flash(a, col),
      onSlowmo: (s, scale) => { this._slowmo = Math.max(this._slowmo || 0, s); this._slowmoScale = scale ?? 0.4; },
      onDodge: () => {
        this.vfx.burst(this.controller.chest, { count: 18, color: this.fruit.color, color2: 0xffffff, speed: 7, size: 0.3, life: 0.35, gravity: 0, drag: 4, tile: 4 });
        this.hud.damageNumber(this.controller.chest.clone().add(new THREE.Vector3(0, 1.4, 0)), 'esquiva', { color: '#bfe8ff' });
      }
    });
    this.combat.setPlayer(this.controller);
    this.combat.playerMaxHp = this.progression.maxHp;
    this.combat.playerHp = this.progression.maxHp;
    this.combat.playerDamageMult = this.progression.damageMult;
    this.hud.setLevel(this.progression.level);
    this.hud.setXp(this.progression.frac);

    // ---- controller feedback hooks ----
    this.controller.onJump = () => {
      this.vfx.ring(this.controller.position, { color: 0xdff0ff, radius: 2.4, life: 0.3, y: 0.05 });
    };
    this.controller.onSkyJump = (pos) => {
      this.vfx.ring(pos, { color: 0xbfe4ff, radius: 3.6, life: 0.4, y: 0.1 });
      this.vfx.burst(pos, { count: 20, color: 0xffffff, color2: 0x9ec7ff, speed: 6, size: 0.25, life: 0.4, gravity: 3, drag: 3, dir: new THREE.Vector3(0, -1, 0), cone: 1.6 });
      this.camera.addShake(0.12);
    };
    this.controller.onDash = (dir) => {
      this.combat.playerIFrames = Math.max(this.combat.playerIFrames, 0.22);   // brief dodge window
      const c = this.controller.chest;
      this.vfx.ring(c, { color: 0xffffff, radius: 2.6, life: 0.22, vertical: true });
      this.vfx.burst(c, { count: 18, color: 0xffffff, color2: 0xbfe0ff, speed: 9, size: 0.3, life: 0.32, gravity: 0, drag: 5, dir: dir.clone().negate(), cone: 1.1, tile: 7 });
      // little speed-streak puffs along the trail
      for (let i = 1; i <= 3; i++) this.vfx.burst(c.clone().addScaledVector(dir, -i * 0.8), { count: 4, color: 0xdff0ff, speed: 1.5, size: 0.26, life: 0.25, gravity: 0, drag: 4, tile: 7 });
      this.camera.addShake(0.12);
    };
    this.controller.onLand = (impact) => {
      this.vfx.ring(this.controller.position, { color: 0xe8dcc0, radius: Math.min(5, 1.5 + impact * 0.1), life: 0.35, y: 0.05 });
      this.vfx.burst(this.controller.position, { count: Math.min(24, impact | 0), color: 0xe8dcc0, speed: 3, size: 0.22, life: 0.4, gravity: 8, drag: 2, dir: new THREE.Vector3(0, 1, 0), cone: 2.2 });
      // Gura Gura passive: a hard landing sends out a tremor
      if (this.fruit.name === 'Gura Gura' && impact > 11) {
        const p = this.controller.position.clone();
        const r = Math.min(9, 3 + impact * 0.2);
        this.vfx.quakeRing(p.clone(), { radius: r, life: 0.4, thickness: 0.5, color: 0xd9d0ee });
        this.vfx.crack(p.clone(), { radius: r, count: 6, life: 1.6, ground: true, color: 0xd9d0ee });
        this.combat.areaStrike(p, { radius: r, damage: 14, knockback: 16, up: 4, stun: 0.3, color: 0xa89ec4, silent: true });
        this.camera.addShake(0.3);
      }
    };
    this.controller.onStep = () => {
      if (this.controller.inWater) return;
      this.vfx.burst(this.controller.position, { count: 3, color: 0xe8dcc0, speed: 1.2, size: 0.14, life: 0.25, gravity: 6, drag: 3, dir: new THREE.Vector3(0, 1, 0), cone: 1.2 });
    };

    // ---- fruits ----
    this.fruits = FRUITS.map((F) => new F());
    this.fruit = this.fruits[0];
    this.hud.setFruit(this.fruit);
    this._loadModels();

    // ---- populate islands from their definitions ----
    this._populateWorld();

    this.render.setScene(this.scene, this.camera.camera);

    // Blox-Fruits-style look: free cursor by default; hold RMB to orbit the
    // camera, or toggle shiftlock with Alt. Pointer-lock only while looking.
    this._shiftlock = false;
    this.input.onButtonDown = (b) => { if (b === 2 && !this._shiftlock) this.input.requestPointerLock(); };
    this.input.onButtonUp = (b) => { if (b === 2 && !this._shiftlock) this.input.exitPointerLock(); };

    // ---- multiplayer (opt-in: ?room=CODE in the URL, or the lobby overlay) ----
    this.net = null;
    this.remote = new Map();            // id -> RemotePlayer
    this._initNet();

    p(0.95);
  }

  /* Load external GLB props (fire-and-forget; not needed for boot). */
  _loadModels() {
    const zushi = this.fruits.find((f) => f.name === 'Zushi Zushi');
    if (!zushi) return;
    new GLTFLoader().load('models/meteor.glb', (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxAxis = Math.max(size.x, size.y, size.z) || 1;
      model.position.sub(box.getCenter(new THREE.Vector3()));   // centre geometry
      model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.frustumCulled = false;
        if (o.material) { o.material.metalness = 0; o.material.roughness = 1; }
      });
      const g = new THREE.Group();
      g.add(model);
      g.scale.setScalar(11 / maxAxis);                           // -> ~radius 5.5 (big)
      // burning halo so the crack-less rock still reads as a meteor
      g.add(new THREE.Mesh(
        new THREE.IcosahedronGeometry(7.5 * maxAxis / 11, 1),
        new THREE.MeshBasicMaterial({ color: 0xff6a24, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false })
      ));
      zushi._meteorMesh = g;
    }, undefined, (err) => console.warn('[models] meteor.glb load failed', err));

    // --- Hie Hie · Avalancha Celestial — the giant snowball ---
    const hie = this.fruits.find((f) => f.name === 'Hie Hie');
    if (hie) new GLTFLoader().load('models/snowball.glb', (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxAxis = Math.max(size.x, size.y, size.z) || 1;
      model.position.sub(box.getCenter(new THREE.Vector3()));      // centre geometry
      const snow = new THREE.MeshToonMaterial({ color: 0xffffff, emissive: new THREE.Color(0xeafaff).multiplyScalar(0.25), flatShading: true });
      model.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeVertexNormals();                          // GLB carries POSITION only
        o.material = snow;
        o.castShadow = true;
        o.frustumCulled = false;
      });
      const g = new THREE.Group();
      g.add(model);
      g.scale.setScalar(16 / maxAxis);                              // -> ~16 units across (big)
      const r = 8;
      // glowing ice core + additive frost shell so it reads like the VFX ball
      g.add(new THREE.Mesh(
        new THREE.IcosahedronGeometry(r * 0.42, 1),
        new THREE.MeshToonMaterial({ color: 0x8ff0e6, emissive: new THREE.Color(0x8ff0e6).multiplyScalar(0.35), flatShading: true })
      ));
      g.add(new THREE.Mesh(
        new THREE.IcosahedronGeometry(r * 1.12, 1),
        new THREE.MeshBasicMaterial({ color: 0xdff6ff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false })
      ));
      hie._snowballMesh = g;
    }, undefined, (err) => console.warn('[models] snowball.glb load failed', err));
  }

  _populateWorld() {
    const { enemies, npcs, bosses } = this.world.collectSpawns();

    for (const s of enemies) {
      let t;
      if (s.type === 'dummy') {
        t = makeDummy(this.scene, s.pos);
      } else {
        t = makeBandit(this.scene, s.pos, { level: s.level });
        t.attackHooks.onStrike = (dmg, dir) => this.combat.damagePlayer(dmg, dir);
      }
      t._spawnPos = s.pos.clone();
      t._islandId = s.island;
      t.onDeath = (self) => this._onEnemyKilled(self);
      this.combat.addTarget(t);
    }

    for (const b of bosses) {
      const t = makeBoss(this.scene, b.pos, { level: b.level, name: b.name, kind: b.type });
      t._spawnPos = b.pos.clone();
      t._islandId = b.island;
      t.attackHooks.onStrike = (dmg, dir, heavy) => {
        this.combat.damagePlayer(dmg, dir);
        if (heavy) this.camera.addShake(0.5);
      };
      t.onDeath = (self) => this._onEnemyKilled(self);
      this.combat.addTarget(t);
    }

    for (const n of npcs) {
      const npc = makeNPC(this.scene, n.pos, { type: n.type, seed: n.pos.x * 13 + n.pos.z });
      const g = this.world.sampleGround(n.pos.x, n.pos.z);
      npc.obj.position.y = g.onLand ? g.height : 0;
      this.npcs.push(npc);
    }
  }

  _onEnemyKilled(t) {
    if (t.isDummy) return;
    const res = this.progression.grantKill(t.level || 1, !!t.isBoss);
    const pct = Math.round(res.gained * 100);
    if (pct > 0) {
      this.hud.damageNumber(t.center.clone().add(new THREE.Vector3(0, 1.5, 0)), `+${pct}%`, { color: '#ffe58a', crit: t.isBoss });
    }
    if (t === this.activeBoss) this.activeBoss = null;
    this.combat.healPlayer(t.isBoss ? 60 : 8);
  }

  start() {
    this.clock.start();
    this._tick();
  }

  _tick = () => {
    this._raf = requestAnimationFrame(this._tick);
    let dt = this.clock.getDelta();
    dt = Math.min(dt, 0.05);
    this.elapsed += dt;
    this.frame++;

    // time scaling: hitstop (near-freeze) beats slow-mo (soft) beats normal
    let gdt = dt;
    if (this._hitstop > 0) {
      this._hitstop -= dt;
      gdt = dt * 0.06;
    } else if (this._slowmo > 0) {
      this._slowmo -= dt;
      gdt = dt * (this._slowmoScale || 0.4);
    }

    this._boardCd = Math.max(0, this._boardCd - dt);
    this._updateModeToggle();

    if (this.mode === 'foot') this._updateFoot(gdt, dt);
    else this._updateSail(gdt, dt);

    // shared systems
    const focus = this.mode === 'foot'
      ? this.controller.chest
      : this.boat.root.position.clone().setY(this.boat.root.position.y + 2.5);

    this.world.update(dt, this.elapsed, focus, this.camera.camera.position);
    this.combat.update(gdt);
    this.vfx.update(dt);
    this._netTick(dt);

    for (const f of this.fruits) f.update(dt);
    for (const npc of this.npcs) npc.update(dt, this.controller.position);
    this._updateWorldUI(dt);

    this.hud.update(dt, this.camera.camera);
    this.hud.updateCooldowns(this.fruit);
    this.hud.setCharges(this.fruit.hudPips?.() ?? 0, this.fruit.hudPipMax ?? 4, this.fruit.hudBar?.() ?? 0);
    this.hud.setCompass(this.camera.yaw);
    this.hud.setPerf(this.render.renderer);
    this.hud.setStamina(this._stamina01());

    this.render.render(gdt, this.elapsed);
    this.input.lateUpdate();
  };

  _updateWorldUI(dt) {
    const pp = this.controller.position;
    const shipPos = this.boat.root.position;
    this.worldMap.update(pp, this.camera.yaw, shipPos, this.mode);

    // island banner on entering a new island (skipped in battleground mode)
    const isl = (this.mode === 'foot' && !this.world.isArena) ? this.world.islandAt(pp.x, pp.z) : null;
    const id = isl ? isl.id : null;
    if (id !== this._currentIslandId) {
      this._currentIslandId = id;
      if (isl) {
        this.hud.showIslandBanner(isl.name, isl.levelBand);
        this.worldMap.markDiscovered(isl.id);
      }
    }

    // boss bar: nearest alive engaged boss
    let boss = this.activeBoss;
    if (boss && (boss.dead || pp.distanceTo(boss.obj.position) > 55)) boss = this.activeBoss = null;
    if (!boss) {
      for (const t of this.combat.targets) {
        if (t.isBoss && !t.dead && pp.distanceTo(t.obj.position) < 34) { boss = this.activeBoss = t; break; }
      }
    }
    this.hud.setBoss(boss ? boss.bossName : null, boss ? boss.hp / boss.maxHp : 0);

    // NPC interaction prompt / auto-close dialogue when walking away
    if (this._dialogue) {
      if (pp.distanceTo(this._dialogue.npc.obj.position) > 5.5) this._closeDialogue();
    } else if (this.mode === 'foot') {
      let near = null, nd = 99;
      for (const npc of this.npcs) {
        const d = pp.distanceTo(npc.obj.position);
        if (npc.nearPlayer && d < nd) { nd = d; near = npc; }
      }
      this._nearNpc = near;
      this.hud.setInteract(near ? `Hablar con ${near.name}` : null);
    } else {
      this.hud.setInteract(null);
    }
  }

  _handleTalk() {
    if (this._dialogue) {
      this._dialogue.idx++;
      if (this._dialogue.idx >= this._dialogue.conv.length) { this._closeDialogue(); return; }
      this.hud.showDialogue(this._dialogue.npc.name, this._dialogue.conv[this._dialogue.idx]);
      return;
    }
    if (this._nearNpc) {
      const conv = this._nearNpc.pickLine();
      this._dialogue = { npc: this._nearNpc, conv, idx: 0 };
      this.hud.showDialogue(this._nearNpc.name, conv[0]);
    }
  }
  _closeDialogue() { this._dialogue = null; this.hud.hideDialogue(); }

  _stamina01() {
    // light stamina model: sprinting drains, idle regens — visual only for now
    const spr = (this.input.isDown('ShiftLeft')) && this.controller.speed01 > 0.5;
    this._stam = THREE.MathUtils.clamp((this._stam ?? 1) + (spr ? -0.25 : 0.35) * (1 / 60), 0, 1);
    return this._stam;
  }

  _updateModeToggle() {
    if (this.world.isArena) return;                 // no boat in battleground mode
    if (this._boardCd > 0) return;
    if (!this.input.justPressed('KeyE')) return;

    if (this.mode === 'foot') {
      const d = this.controller.position.distanceTo(this.boat.root.position);
      if (d < 6.5) {
        this.mode = 'sail';
        this._boardCd = 0.4;
        this.boat.root.add(this.character.root);
        this.character.root.position.copy(this.boat.helmLocal);
        this.character.root.rotation.set(0, Math.PI, 0);
        this.camera.setMode('third');
        this.camera.setColliders([]);
        this.camera.wantDistance = 10;
      }
    } else {
      this.mode = 'foot';
      this._boardCd = 0.4;
      this.scene.add(this.character.root);
      this.camera.setColliders(this._footColliders);
      const off = new THREE.Vector3(0, 0, 4).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.boat.heading);
      const p = this.boat.root.position.clone().add(off);
      const g = this.world.sampleGround(p.x, p.z);
      p.y = g.onLand ? g.height : 0.2;
      this.controller.teleport(p);
      this.camera.wantDistance = 6.2;
    }
  }

  _updateHold(dt) {
    const c = this.controller;
    const flying = c.flying;
    const g = this.world.sampleGround(c.position.x, c.position.z, c.position.y);
    const overWater = !flying && !g.onLand;
    if (overWater && !this.world.isArena) c.position.y = this.world.waterHeight(c.position.x, c.position.z) - 0.75;
    if (!flying) c.velocity.set(0, 0, 0);
    this.character.root.position.copy(c.position);
    this.character.root.rotation.set(0, c.facing, 0);
    this._attackPoseT = Math.max(0, this._attackPoseT - dt);

    // animation preview: drive the rig in place at a chosen gait, phase pinned
    const ad = this._animDebug;
    const drive = ad === 'walk' ? { speed: 0.5, groundSpeed: 5.2 }
      : ad === 'run' ? { speed: 1.0, groundSpeed: 10.6 }
      : { speed: flying ? 0.6 : 0, groundSpeed: flying ? 8 : 0 };
    if (ad) { this.character._gait = 1; this.character._run = ad === 'run' ? 1 : 0; }
    this.character.update(dt, {
      ...drive, turn: 0, grounded: !overWater && !flying, vertVel: 0, inWater: overWater, flying, aim: false,
      attackPose: this._attackPoseT > 0 ? 'punch' : null
    });
    if (ad) { this.character._phase = 4.4; }   // fixed readable mid-stride for the still

    // Deterministic orbit framing — bypass the gameplay rig entirely.
    const cam = this.camera;
    const p = -cam.pitch, y = cam.yaw, d = cam.wantDistance;   // pitch = look-DOWN angle
    const tgt = c.chest.clone().add(new THREE.Vector3(0, 0.3, 0));
    const dir = new THREE.Vector3(
      Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)
    );
    cam.camera.position.copy(tgt).addScaledVector(dir, -d);
    cam.camera.lookAt(tgt);
    cam.camera.fov = 56;
    cam.camera.updateProjectionMatrix();
    cam._camPos.copy(cam.camera.position);
    cam.smoothTarget.copy(c.chest);

    this.hud.setAim(false);
    this.hud.setMode('Photo Mode');
  }

  _applyFruitBuffs(dt) {
    const f = this.fruit, pr = this.progression, ctl = this.controller;
    const tf = f.transformed;
    // NOTE: these base numbers must track CharacterController's own defaults
    // (walk/run/jump/gravity) — this function overwrites them every frame, so
    // a tuning pass on the controller's constructor alone silently gets
    // reverted here unless updated too.
    // Haki v2 note: Busoshoku's +damage is melee-ONLY per spec (applied at
    // the `_doMelee` call site, not here) and Kenbunshoku no longer grants a
    // flat dodge bonus (replaced by the real incoming-attack telegraph) — see
    // Haki.js / [[haki-system]]. Neither touches these global multipliers
    // anymore, so they can't fight with fruit/level buffs over the same field.
    this.combat.playerDamageMult = pr.damageMult * (tf ? f.transformDmg : 1);
    ctl.runSpeed = 13.2 * pr.moveBonus * (tf ? f.transformSpeed : 1);
    ctl.jumpVel = 12.4 * (f.jumpMul || 1);
    ctl.skyJumpVel = 11.2 * (f.jumpMul || 1);
    ctl.gravity = 25 * (f.fallMul ?? 1);               // Zushi Zushi passive: floaty
    this.combat.playerDodge = f.isLogia() ? (f.name === 'Goro Goro' ? 0.30 : 0.22) : 0;
    ctl.iceWalk = f.name === 'Hie Hie' || f.name === 'Magu Magu';   // passive: walk on water
    if (tf && f.transformRegen) this.combat.healPlayer(f.transformRegen * dt);

    // Haoshoku's PvP slow (received via _takeNetHit) — decays here since this
    // is the authoritative per-frame place controller speed gets set.
    if (this._hakiSlowT > 0) {
      this._hakiSlowT = Math.max(0, this._hakiSlowT - dt);
      ctl.speedMult = this._hakiSlowT > 0 ? (1 - this._hakiSlowFrac) : 1;
    } else {
      ctl.speedMult = 1;
    }
  }

  _updateFoot(gdt, dt) {
    if (this._holdShot) return this._updateHold(dt);

    // NPC dialogue (F to talk / advance, Esc to close)
    if (this.input.justPressed('KeyF')) this._handleTalk();
    if (this._dialogue && this.input.justPressed('Escape')) this._closeDialogue();
    const talking = !!this._dialogue;

    // Alt toggles shiftlock (pointer stays locked, character faces the camera)
    if (this.input.justPressed('AltLeft') || this.input.justPressed('AltRight')) {
      this._shiftlock = !this._shiftlock;
      if (this._shiftlock) this.input.requestPointerLock();
      else if (!this.input.mouseDown(2)) this.input.exitPointerLock();
    }
    const rmb = this.input.mouseDown(2) && !talking;
    const lookLocked = this._shiftlock || rmb;
    this.controller.update(gdt, { camera: this.camera, input: this.input, aiming: false, faceCamera: lookLocked });

    // melee combo — LMB always swings (aims at the cursor)
    this._comboTimer = Math.max(0, this._comboTimer - dt);
    if (this._comboTimer === 0) this._combo = 0;
    if (this.input.mouseJustPressed(0) && !talking) this._doMelee();

    // fruit skills + ultimate + Zoan transform buffs. Casting snap-faces the
    // character toward wherever you're aiming (cursor / crosshair).
    const ctx = this._fruitCtx();
    const cast = (slot, isTransform, arg) => {
      if (!isTransform) {
        this.controller.faceLockYaw = Math.atan2(ctx.forwardFlat.x, ctx.forwardFlat.z);
        this.controller.faceLock = 0.4;
      }
      const ok = this.fruit.use(slot, ctx, arg);
      if (ok && this.net) this.net.sendCast(slot, ctx.forwardFlat, ctx.aimDir, this.controller.position, this._fruitIdx, typeof arg === 'number' ? arg : null);
    };
    // chargeable Z (hold to power up, release to fire) — else a plain press
    const qs = this.fruit.slots.q;
    if (qs && qs.charge) {
      if (this.input.isDown('KeyZ') && qs._t <= 0 && !talking) {
        this._chargeZ = Math.min(1, (this._chargeZ || 0) + dt / (qs.chargeTime || 1.5));
        qs.onCharge && qs.onCharge(ctx, this._chargeZ);
      } else if (this.input.justReleased('KeyZ') && this._chargeZ > 0) {
        cast('q', false, this._chargeZ); this._chargeZ = 0;
      }
    } else if (this.input.justPressed('KeyZ')) cast('q');
    if (this.input.justPressed('KeyX')) cast('e');
    if (this.input.justPressed('KeyC')) cast('f', !!this.fruit.slots.f?.transform);
    if (this.input.justPressed('KeyV')) cast('v');
    if (this.input.justPressed('KeyT') && this.fruit.hasUlt()) cast('ult');
    this._applyFruitBuffs(dt);
    this.hud.setTransformed(this.fruit.transformed, (this.fruit.slots.f?.name || 'Transformado').toUpperCase());

    // Haki — G Busoshoku · H Kenbunshoku (independent toggles sharing one meter) · B Haoshoku (one-shot, own cooldown, no meter cost)
    if (this.input.justPressed('KeyG')) this.haki.toggle('armament');
    if (this.input.justPressed('KeyH')) this.haki.toggle('observation');
    // NOTE: Haoshoku's own VFX are NOT broadcast to peers (sendCast is fruit-
    // specific plumbing — reusing it here would misfire the peer's actual
    // equipped fruit ultimate on other clients' screens). Its real effect on
    // PvP opponents still reaches them correctly via takeHit -> sendHit below;
    // only the local caster's ring/burst are currently visible to onlookers.
    if (this.input.justPressed('KeyB') && !talking) this.haki.castHaoshoku(ctx);
    this.haki.update(dt, ctx);
    this.character.setHakiCoat && this.character.setHakiCoat(this.haki.armament);
    this.character.setObservationAura && this.character.setObservationAura(this.haki.observation);
    this.hud.setHaki && this.hud.setHaki(this.haki);

    // swap fruit — Digit 1-9, or R to cycle
    let swapTo = -1;
    for (let i = 0; i < this.fruits.length && i < 9; i++) {
      if (this.input.justPressed(`Digit${i + 1}`)) swapTo = i;
    }
    if (this.input.justPressed('KeyR')) swapTo = (this._fruitIdx + 1) % this.fruits.length;
    if (swapTo >= 0 && this.fruits[swapTo] && swapTo !== this._fruitIdx) {
      this.fruit.forceRevert(ctx);
      this.character.root.visible = true;         // safety: undo Bara Bara hide
      this.character.setHands(true);
      this.controller.flying = false;
      this._chargeZ = 0;
      this._fruitIdx = swapTo;
      this.fruit = this.fruits[swapTo];
      this.hud.setFruit(this.fruit);
      this.vfx.ring(this.controller.chest, { color: this.fruit.color, radius: 2.5, life: 0.35, vertical: true });
      this.vfx.burst(this.controller.chest, { count: 16, color: this.fruit.color, color2: 0xffffff, speed: 5, size: 0.3, life: 0.4, gravity: -1, drag: 3, tile: 4 });
    }

    // camera
    const speedFov = this.controller.speed01 > 0.6 ? this.controller.speed01 * 6 : 0;
    this.camera.update(dt, this.controller.chest, { aim: false, speedFov, shiftlock: lookLocked });
    this.hud.setAim(lookLocked);
    this.hud.setMode(this.controller.flying
      ? (this.fruit.name === 'Tori Tori: Fénix'
        ? 'Fénix · Espacio sube · Ctrl baja · C revierte'
        : this.fruit.name === 'Zushi Zushi'
          ? 'Levitando · Espacio sube · Ctrl baja'
          : 'Volando · Espacio sube · Ctrl baja · C aterriza')
      : 'On Foot');

    // water-walk passives: frost trail (Hie Hie) / obsidian step (Magu Magu)
    if (this.controller.onFrozenWater) {
      const f = this.controller.position.clone();
      if (this.fruit.name === 'Magu Magu') {
        // Paso de Obsidiana: dark volcanic-glass ring that flashes orange then sinks
        if (this.frame % 6 === 0) {
          this.vfx.decal(f.clone(), { kind: 'scorch', radius: 1.3, life: 1.6, groundY: f.y });
          this.vfx.ring(f.clone(), { color: 0xff6a24, radius: 1.2, life: 0.22, y: 0.03 });
          this.vfx.burst(f.clone(), { count: 4, color: 0xfff0d0, color2: 0xffffff, tile: 2, speed: 1.4, size: 0.3, life: 0.7, gravity: -3, drag: 1.6, dir: new THREE.Vector3(0, 1, 0), cone: 0.7 });
        }
        if (this.controller.groundSpeed > 1 && this.frame % 3 === 0) {
          this.vfx.burst(f.clone(), { count: 2, color: 0xff9a3a, color2: 0xc42a08, tile: 1, speed: 2, size: 0.22, life: 0.3, gravity: 5, drag: 3, dir: new THREE.Vector3(0, 1, 0), cone: 1.2 });
        }
      } else {
        if (this.frame % 8 === 0) this.vfx.decal(f.clone(), { kind: 'frost', radius: 1.4, life: 3.5, groundY: f.y });
        if (this.controller.groundSpeed > 1 && this.frame % 3 === 0) {
          this.vfx.burst(f.clone(), { count: 3, color: 0xeafaff, color2: 0x9fd8ff, speed: 2.2, size: 0.18, life: 0.35, gravity: 6, drag: 3, dir: new THREE.Vector3(0, 1, 0), cone: 1.4 });
        }
      }
    }

    // flight: Mera Mera (Vuelo), Phoenix (transformed), Zushi Zushi (Levitación); emit jets
    if (this.controller.flying) {
      const mera = this.fruit.name === 'Mera Mera';
      const phoenix = this.fruit.name === 'Tori Tori: Fénix' && this.fruit.transformed;
      const zushi = this.fruit.name === 'Zushi Zushi' && this.fruit._levit > 0;
      if (!mera && !phoenix && !zushi) {
        this.controller.flying = false;
      } else if (this.frame % 2 === 0) {
        const feet = this.controller.position.clone();
        const c1 = phoenix ? 0x3aa4ff : zushi ? 0x8a5cff : 0xffb43c;
        const c2 = phoenix ? 0xdff2ff : zushi ? 0xd9c6ff : 0xff3d12;
        this.vfx.burst(feet, { count: 4, color: c1, color2: c2, speed: 6, size: 0.28, life: 0.3, gravity: zushi ? -1 : 3, drag: 3, dir: new THREE.Vector3(0, -1, 0), cone: 0.9 });
        if (this.frame % 10 === 0 && !zushi) this.vfx.flame(feet, { radius: 0.7, height: 1.6, life: 0.4, color: phoenix ? 0x2f9fe8 : 0xff4d16, core: phoenix ? 0xdff2ff : 0xffd070 });
      }
    }

    // anim
    this._attackPoseT = Math.max(0, this._attackPoseT - dt);
    this.character.update(dt, {
      speed: this.controller.speed01,
      groundSpeed: this.controller.groundSpeed ?? 0,
      turn: this.controller.turnRate ?? 0,
      grounded: this.controller.grounded,
      vertVel: this.controller.velocity.y,
      inWater: this.controller.inWater,
      flying: this.controller.flying,
      aim: false,
      attackPose: this._attackPoseT > 0 ? 'punch' : null
    });
  }

  _updateSail(gdt, dt) {
    this.boat.control(this.input);
    if (this._sailHold) { this.boat.throttle = 1; this.boat.speed = Math.max(this.boat.speed, 8); }
    this.boat.update(gdt, this.elapsed, { controlled: true });

    // idle bob for the pilot
    this.character.update(dt, { speed: 0, grounded: true, vertVel: 0, aim: false, attackPose: null });

    const focus = this.boat.root.position.clone().add(new THREE.Vector3(0, 2.6, 0));
    this.camera.update(dt, focus, { speedFov: Math.abs(this.boat.speed) * 0.4 });
    this.hud.setAim(false);
    this.hud.setMode(`Sailing · ${(this.boat.speed).toFixed(0)} kn`);
  }

  _doMelee() {
    const chest = this.controller.chest;
    const dir = this._holdShot ? this.camera.getForward(new THREE.Vector3()) : this._fruitCtx().forwardFlat.clone();
    this.controller.faceLockYaw = Math.atan2(dir.x, dir.z);
    this.controller.faceLock = 0.3;
    this._combo = (this._combo % 3) + 1;
    this._comboTimer = 0.7;
    this._attackPoseT = 0.28;
    this.character.castPose('punch');

    const last = this._combo === 3;
    // Busoshoku: +20% on THIS basic melee only (never fruit-ability damage,
    // which is why the bonus lives here and not in combat.playerDamageMult)
    // and bypasses a struck PvP opponent's Logia elemental dodge outright.
    const busoActive = this.haki.armament;
    const hits = this.combat.meleeStrike(chest, dir, {
      arc: Math.PI * 0.62,
      range: this.fruit.meleeRange ?? 2.9,
      damage: (last ? 20 : 11) * (busoActive ? BUSO_MELEE_MULT : 1),
      knockback: last ? 18 : 5,
      up: last ? 6 : 1,
      stun: last ? 0.5 : 0.22,
      hitstop: last ? 0.07 : 0.04,
      shake: last ? 0.22 : 0.1,
      color: this.fruit.color ?? 0xffffff,
      ignoreDodge: busoActive
    });
    // lunge
    this.controller.velocity.addScaledVector(dir, hits ? 3 : 5);
    this.hud.meleeFlash();
    this.vfx.ring(chest.clone().addScaledVector(dir, 1.2), {
      color: this.fruit.color ?? 0xffffff, radius: last ? 2.6 : 1.8, life: 0.22, vertical: true
    });
    // per-fruit flavour (Bara Bara: hand deploys on the punch)
    this.fruit.onMelee?.(this._fruitCtx(), this._combo, dir);
    if (this.net) this.net.sendMelee(dir, this._combo, this.controller.position);
  }

  /* ---- debug / screenshot helpers (used by tools/shoot.mjs) ---- */
  castDebug(key) { return this.fruit.use(key, this._fruitCtx()); }
  meleeDebug() { this._doMelee(); }
  setFruitDebug(i) {
    this.fruit.forceRevert(this._fruitCtx());
    this.character.root.visible = true;
    this.character.setHands(true);
    this.controller.flying = false;
    this._fruitIdx = i % this.fruits.length;
    this.fruit = this.fruits[this._fruitIdx];
    this.hud.setFruit(this.fruit);
  }
  shot(name) {
    const V = THREE.Vector3;
    const isl = this.world.islands[0] || { center: new V(0, 0, 0), radius: this.world.arena?.radius ?? 60, structureMeta: {}, levelBand: [1, 1], name: 'Arena' };
    const cam = this.camera;
    const c = this.controller;
    if (this.mode === 'sail' && name !== 'sail') {
      this.mode = 'foot';
      this.scene.add(this.character.root);
    }
    cam.setColliders([]);          // screenshots: no camera collision jitter
    this._holdShot = name;         // freeze player physics; keep world + vfx + fruit casts live
    this.controller.flying = false;
    this._animDebug = (name === 'walk' || name === 'run') ? name : null;
    this.combat.freezeAI = true;
    if (name !== 'worldmap') this.worldMap.close();
    this._closeDialogue();
    // reset enemies to spawn so they don't wander into frame
    for (const t of this.combat.targets) {
      if (t._spawnPos && !t.dead) {
        t.obj.position.copy(t._spawnPos);
        t.velocity.set(0, 0, 0);
        if (t.ai) { t.ai.state = 'idle'; t.ai.t = 0; }
      }
    }
    // place feet on valid ground at (x,z); frame camera behind at yaw, looking down `pitch`
    const go = (x, z, yaw, pitch, dist) => {
      const g = this.world.sampleGround(x, z);
      const y = (g.onLand ? g.height : 0) + 0.05;
      c.teleport(new V(x, y, z));
      c.facing = yaw;
      this.character.root.position.set(x, y, z);
      this.character.root.rotation.set(0, yaw, 0);
      cam.yaw = yaw; cam.pitch = pitch;
      cam.wantDistance = dist; cam.distance = dist;
      const focus = new V(x, y + 1.15, z);
      cam.smoothTarget.copy(focus);
      const dir = new V(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      cam._camPos.copy(focus).addScaledVector(dir, -dist).add(new V(0, 0.4, 0));
      cam.camera.position.copy(cam._camPos);
      cam.camera.lookAt(focus);
    };
    // frame a structure: put the player just outside it (toward the shore) and
    // an elevated camera looking down at the cluster.
    const goStructure = (islandIdx, structType, back = 22, pitch = 0.34) => {
      const island = this.world.islands[islandIdx];
      const sm = island && island.structureMeta && island.structureMeta[structType];
      const w = sm ? sm.world : island.center.clone();
      // outward = from island centre toward the structure (points to the shore side)
      const outward = w.clone().sub(island.center).setY(0);
      if (outward.lengthSq() < 1) outward.set(0, 0, 1);
      outward.normalize();
      const stand = w.clone().addScaledVector(outward, back * 0.5);
      go(stand.x, stand.z, Math.atan2(w.x - stand.x, w.z - stand.z), pitch, back);
    };

    switch (name) {
      case 'arena-wide': {
        // high, pulled-back look at the whole greybox
        const c0 = c;
        c0.teleport(new V(0, this.world.sampleGround(0, 0, Infinity).height + 0.05, 0));
        c0.facing = 0;
        this.character.root.position.copy(c0.position);
        this.character.root.rotation.set(0, 0, 0);
        const dd = (this.world.arena?.radius ?? 60) * 3.4;
        cam.yaw = Math.PI * 0.75; cam.pitch = 0.62;
        cam.wantDistance = dd; cam.distance = dd;
        const focus = new V(0, 4, 0);
        cam.smoothTarget.copy(focus);
        const dir = new V(Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), Math.cos(cam.yaw) * Math.cos(cam.pitch));
        cam._camPos.copy(focus).addScaledVector(dir, -dd).add(new V(0, dd * 0.05, 0));
        cam.camera.position.copy(cam._camPos);
        cam.camera.lookAt(focus);
        break;
      }
      case 'arena-eye': go(0, 48, Math.PI, 0.05, 22); break;                 // stand back, face the podium + beam + LED band
      case 'arena-mid': go(0, 95, Math.PI, 0.12, 34); break;                 // wider: podium small, band + stands visible
      case 'beach':  go(isl.center.x + isl.radius * 0.66, isl.center.z + 8, 0.5, 0.17, 6.5); break;
      case 'inland': go(isl.center.x + 6, isl.center.z + 12, Math.PI * 1.1, 0.16, 7); break;
      case 'walk':
      case 'run': {
        // near-side profile so the full gait cycle reads
        const cx = isl.center.x - 40, cz = isl.center.z + 4;
        go(cx, cz, Math.PI * 0.5, 0.06, 7.5);
        c.facing = Math.PI * 0.5 - Math.PI * 0.42;   // ~3/4 toward camera, walking across frame
        this.character.root.rotation.set(0, c.facing, 0);
        break;
      }
      case 'hero-front':
      case 'hero-back':
      case 'hero-3q': {
        // clean flat ground, tight framing to inspect the model
        const cx = isl.center.x - 40, cz = isl.center.z + 4;
        go(cx, cz, Math.PI * 0.5, 0.05, 5.2);
        const face = name === 'hero-front' ? Math.PI * 0.5 + Math.PI
          : name === 'hero-3q' ? Math.PI * 0.5 + Math.PI * 0.78
          : Math.PI * 0.5;                            // hero-back
        c.facing = face;
        this.character.root.rotation.set(0, face, 0);
        break;
      }
      case 'village': if (isl.structureMeta?.village) goStructure(0, 'village', 26, 0.2); break;
      case 'camp':    if (this.world.islands[1]) goStructure(1, 'bandit_camp', 24, 0.2); break;
      case 'ruins':   if (this.world.islands[2]) goStructure(2, 'ruins', 30, 0.16); break;
      case 'arena':   go(isl.center.x, isl.center.z + 60, Math.PI, 0.12, 26); break;
      case 'worldmap': this.worldMap.discovered = new Set(this.world.mapMarkers.map((m) => m.id)); this.worldMap.show(); break;
      case 'town-wide': go(isl.center.x, isl.center.z + isl.radius * 0.95, Math.PI, 0.30, isl.radius * 0.72); break;
      case 'cala-wide': { const i = this.world.islands[1]; if (i) go(i.center.x, i.center.z + i.radius * 0.95, Math.PI, 0.30, i.radius * 0.72); break; }
      case 'ruinas-wide': { const i = this.world.islands[2]; if (i) go(i.center.x, i.center.z + i.radius * 0.95, Math.PI, 0.30, i.radius * 0.72); break; }
      case 'combat': {
        // stand ~6 m from a cluster of bandits so abilities actually connect
        const enemies = this.combat.targets.filter((x) => x.faction === 'enemy' && !x.dead);
        const t = enemies.sort((a, b) => a.obj.position.distanceTo(isl.center) - b.obj.position.distanceTo(isl.center))[Math.min(3, enemies.length - 1)] || this.combat.targets[0];
        const tp = t ? t.obj.position : new V(isl.center.x + 12, 0, isl.center.z + 12);
        const yaw = Math.atan2(tp.x - isl.center.x, tp.z - isl.center.z);
        const stand = tp.clone().sub(new V(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(7));
        go(stand.x, stand.z, yaw, 0.14, 8);
        break;
      }
      case 'ocean':  go(isl.center.x + isl.radius + 38, isl.center.z, Math.PI * 1.5, 0.14, 7); break;
      case 'hill':   go(isl.center.x - 2, isl.center.z - 2, 0.7, 0.24, 9); break;
      case 'sail': {
        if (this.mode === 'foot') {
          this.mode = 'sail';
          this.boat.root.add(this.character.root);
          this.character.root.position.copy(this.boat.helmLocal);
          this.character.root.rotation.set(0, Math.PI, 0);
        }
        cam.setColliders([]);
        this.boat.speed = 9;
        this._sailHold = true;                       // keep throttle in _updateSail
        const yaw = this.boat.heading + Math.PI, pitch = 0.16, dist = 13;
        cam.yaw = yaw; cam.pitch = pitch;
        cam.wantDistance = dist; cam.distance = dist;
        const focus = this.boat.root.position.clone().add(new V(0, 2.6, 0));
        cam.smoothTarget.copy(focus);
        const dir = new V(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
        cam._camPos.copy(focus).addScaledVector(dir, -dist).add(new V(0, 1.2, 0));
        cam.camera.position.copy(cam._camPos);
        cam.camera.lookAt(focus);
        break;
      }
    }
  }

  _fruitCtx() {
    const cam = this.camera;
    const chest = this.controller.chest.clone();
    // aim: crosshair when looking is locked (shiftlock / RMB), else the world
    // point under the free mouse cursor. Either way, also resolve the actual
    // world POINT under that aim (aimPoint) — abilities that should travel to
    // exactly where you're pointing (not just "in that direction", capped at a
    // short fixed distance) read this instead of walking N metres along
    // forwardFlat, so long-range/precision casts can reach anywhere the cursor
    // can see, clamped only by their own max range.
    const locked = this._shiftlock || this.input.mouseDown(2) || !!this._holdShot;
    const ndc = locked ? _NDC_CENTER : this.input.cursorNDC();
    const aimPoint = cam.aimPointFromScreen(ndc, chest, this._footColliders || []);
    let aimDir = aimPoint.clone().sub(chest);
    if (aimDir.lengthSq() < 1e-6) aimDir.copy(cam.getAimDir(new THREE.Vector3()));
    aimDir.normalize();
    const forwardFlat = new THREE.Vector3(aimDir.x, 0, aimDir.z);
    if (forwardFlat.lengthSq() < 1e-6) forwardFlat.set(Math.sin(this.controller.facing), 0, Math.cos(this.controller.facing));
    forwardFlat.normalize();
    return {
      origin: chest,
      aimDir,
      aimPoint,
      forwardFlat,
      combat: this.combat,
      vfx: this.vfx,
      camera: this.camera,
      render: this.render,
      controller: this.controller,
      character: this.character,
      scene: this.scene,
      world: this.world,
      elapsed: this.elapsed,
      pose: (kind) => { this.character.castPose(kind); this._attackPoseT = Math.max(this._attackPoseT, 0.34); }
    };
  }

  /* ======================= multiplayer ======================= */

  // Testing phase: EVERYONE who opens the game (with or without a link
  // param) lands in this one shared room automatically — zero clicks, zero
  // typing, no risk of two friends ending up in different rooms by mistake.
  // `?room=CODE` in the URL still overrides it for anyone who wants a
  // private room instead.
  static DEFAULT_ROOM = 'mundo1';

  /**
   * Region + latency selection, then matchmaking within the chosen region.
   *
   * Current reality (see [[multiplayer]] memory / src/net/Regions.js): there
   * is exactly ONE real server today, so "region selection" has exactly one
   * candidate to pick from and "expand search to a nearby region" has
   * nothing to expand to yet. Every step below still runs the generic,
   * region-list-driven code path — the day a second real server exists it's
   * one more entry in `listRegions()` and this all works unchanged.
   */
  async _initNet() {
    const q = new URLSearchParams(location.search);
    const room = (q.get('room') || Game.DEFAULT_ROOM).trim();
    const name = (q.get('name') || `Pirata${Math.floor(Math.random() * 900 + 100)}`).slice(0, 24);
    this._netName = name;
    this._netRoom = room;

    const { listRegions } = await import('../net/Regions.js');
    const { measureAllRegions, roomPlayerCount, pingQuality } = await import('../net/Ping.js');
    this._regionModule = { listRegions, roomPlayerCount };
    this._pingQuality = pingQuality;
    this._netQueryServer = (q.get('server') || '').trim();  // explicit ?server= still wins outright

    this._netBadge('Midiendo regiones…');
    this._regions = await measureAllRegions(listRegions());
    this._buildRegionPicker();

    let pref = null;
    try { pref = localStorage.getItem('region-pref'); } catch {}
    const reachable = this._regions.filter((r) => r.ping != null);
    const chosen = (this._netQueryServer ? null : (pref && this._regions.find((r) => r.id === pref && r.ping != null)))
      || reachable.slice().sort((a, b) => a.ping - b.ping)[0]
      || this._regions[0];

    this._activeRegion = chosen;
    this._renderRegionPicker();

    const server = this._netQueryServer || chosen.url;
    this._connectNet(server, room, name);
    this._runMatchmakingCheck(chosen, room);
  }

  /** Non-blocking: connecting already happened. This only decides whether to show a "looking for players" heads-up and, if other regions have people, offer (never force) switching. */
  async _runMatchmakingCheck(region, room) {
    const TIMEOUT_S = 18;                 // tunable — how long we wait before offering to expand the search
    const { roomPlayerCount } = this._regionModule;
    const already = await roomPlayerCount(region.url, room);
    if (already > 0) return;              // someone's already there — nothing to announce

    this._netBadge(`Buscando jugadores en ${region.label}… (0 por ahora)`);
    await new Promise((r) => setTimeout(r, TIMEOUT_S * 1000));
    if (this.net?.connected && this.remote.size > 0) return;   // someone joined while we waited

    const others = this._regions.filter((r) => r.id !== region.id && r.ping != null);
    let elsewhere = null;
    for (const r of others.sort((a, b) => a.ping - b.ping)) {
      const c = await this._regionModule.roomPlayerCount(r.url, room);
      if (c > 0) { elsewhere = { region: r, count: c }; break; }
    }
    if (elsewhere) {
      this._showExpandPrompt(elsewhere.region, elsewhere.count, room);
    } else {
      // nothing to expand to (today: the only case, since there's one region) — just say so, don't block play
      this._netBadge(`Sin otros jugadores todavía en ${region.label}`);
      setTimeout(() => this._netCount(), 4000);
    }
  }

  _showExpandPrompt(region, count, room) {
    let el = document.getElementById('mm-prompt');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'mm-prompt';
    el.innerHTML = `
      <p>Hay ${count} jugador${count === 1 ? '' : 'es'} en <b>${region.label}</b> (${region.ping}ms) — aquí no hay nadie todavía.</p>
      <div class="row">
        <button id="mm-switch">Cambiar a ${region.label}</button>
        <button id="mm-stay">Seguir esperando aquí</button>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#mm-switch').onclick = () => {
      el.remove();
      try { localStorage.setItem('region-pref', region.id); } catch {}
      this.net?.disconnect();
      this._clearRemotes();
      this._activeRegion = region;
      this._renderRegionPicker();
      this._connectNet(region.url, room, this._netName);
    };
    el.querySelector('#mm-stay').onclick = () => { el.remove(); this._netCount(); };
  }

  /** Small always-visible widget: current region + live ping + a dropdown to force another region manually. */
  _buildRegionPicker() {
    if (document.getElementById('region-picker')) return;
    const el = document.createElement('div');
    el.id = 'region-picker';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.rp-opt')) return;   // handled per-option below
      el.classList.toggle('open');
    });
  }

  _renderRegionPicker() {
    const el = document.getElementById('region-picker');
    if (!el || !this._activeRegion) return;
    const q = this._pingQuality(this._activeRegion.ping);
    const opts = this._regions.map((r) => {
      const cls = this._pingQuality(r.ping);
      const active = r.id === this._activeRegion.id ? ' active' : '';
      const pingTxt = r.ping == null ? '—' : `${r.ping}ms`;
      return `<div class="rp-opt${active}" data-id="${r.id}"><span class="dot ${cls}"></span>${r.label} <b>${pingTxt}</b></div>`;
    }).join('');
    el.innerHTML = `
      <div class="rp-current"><span class="dot ${q}"></span>${this._activeRegion.label} <b id="rp-ping">${this._activeRegion.ping ?? '—'}ms</b></div>
      <div class="rp-list">${opts}<div class="rp-hint">Elegir región fuerza esa opción y se recuerda</div></div>`;
    el.querySelectorAll('.rp-opt').forEach((node) => {
      node.onclick = () => {
        const region = this._regions.find((r) => r.id === node.dataset.id);
        if (!region || region.id === this._activeRegion.id) { el.classList.remove('open'); return; }
        try { localStorage.setItem('region-pref', region.id); } catch {}
        el.classList.remove('open');
        this.net?.disconnect();
        this._clearRemotes();
        this._activeRegion = region;
        this._renderRegionPicker();
        this._connectNet(region.url, this._netRoom, this._netName);
      };
    });
  }

  _netBadge(text) {
    let el = document.getElementById('net-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'net-badge';
      document.body.appendChild(el);
    }
    el.hidden = false;
    el.textContent = text;
  }

  async _connectNet(server, room, name) {
    this._netBadge('Conectando…');
    let NetClient, RemotePlayer;
    try {
      ({ NetClient } = await import('../net/NetClient.js'));
      ({ RemotePlayer } = await import('../entities/RemotePlayer.js'));
    } catch (e) {
      console.error('[net] module load failed', e);
      this._netBadge('Red no disponible');
      return;
    }
    this._RemotePlayer = RemotePlayer;
    const net = this.net = new NetClient();

    net.on('status', (s, attempt) => {
      const map = {
        connecting: 'Conectando…',
        retrying: `Despertando el servidor… (intento ${attempt}, puede tardar un momento)`,
        connected: `En línea · sala ${room}`,
        disconnected: 'Desconectado', error: 'Error de red', full: 'Sala llena'
      };
      this._netBadge(map[s] || s);
      if (s === 'disconnected' || s === 'error') this._clearRemotes();
    });
    net.on('ready', () => this._netCount());
    net.on('peerJoin', (id, info) => { this._addRemote(id, info); if (info.justJoined) this._showJoinToast(info); });
    net.on('peerLeave', (id) => this._removeRemote(id));
    // The world is big and everyone used to land at the same fixed spawn
    // point regardless of where anyone else already was — if the host had
    // wandered off, a joining friend showed up "online" (counted, connected)
    // but nowhere near them with no way to find each other. Fix: the FIRST
    // position we ever hear from anyone already in the room (arrives almost
    // immediately, via the cached state the server sends in `peers`) is used
    // to place US near them instead of the world's default spawn. Only the
    // very first player into an empty room keeps the default spawn.
    let snappedToPeer = false;
    net.on('state', (id, m) => {
      this.remote.get(id)?.applyState(m);
      if (!snappedToPeer && Array.isArray(m.p)) { snappedToPeer = true; this._snapNearPeer(m.p); }
    });
    net.on('cast', (id, m) => this._remoteCast(id, m));
    net.on('melee', (id, m) => this.remote.get(id)?.poke());
    net.on('hit', (m) => this._takeNetHit(m));
    net.on('respawn', (id, m) => { const r = this.remote.get(id); if (r && m.pos) { r.tPos.set(m.pos[0], m.pos[1], m.pos[2]); r.hp = r.maxHp; r._refreshHp(); } });
    net.on('ping', (ms) => {
      if (this._activeRegion) this._activeRegion.ping = ms;
      const el = document.getElementById('rp-ping');
      if (el) el.textContent = `${ms}ms`;
      this.hud?.setPing?.(ms);
    });

    net.connect(server, room, name, this._fruitIdx, this._activeRegion?.id ?? null);
  }

  /** "🇲🇽 Fulano se unió desde México" toast — with a (today inert) button to jump to whatever region they reported, ready for when a second real region exists. */
  _showJoinToast(info) {
    const layer = this._toastLayer || (this._toastLayer = (() => {
      const l = document.createElement('div'); l.id = 'join-toasts'; document.body.appendChild(l); return l;
    })());
    const card = document.createElement('div');
    card.className = 'join-toast';
    const where = info.flag ? `${info.flag} ${info.country}` : null;
    const region = this._regions?.find((r) => r.id === info.region);
    card.innerHTML = `<span>${info.name}${where ? ` se unió desde ${where}` : ' se unió'}</span>`;
    if (region && region.id !== this._activeRegion?.id) {
      const btn = document.createElement('button');
      btn.textContent = `Ir a ${region.label}`;
      btn.onclick = () => {
        card.remove();
        try { localStorage.setItem('region-pref', region.id); } catch {}
        this.net?.disconnect(); this._clearRemotes();
        this._activeRegion = region; this._renderRegionPicker();
        this._connectNet(region.url, this._netRoom, this._netName);
      };
      card.appendChild(btn);
    }
    layer.appendChild(card);
    setTimeout(() => card.remove(), 6000);
  }

  /** Teleport the local player to a few units beside `p` (a peer's [x,y,z]) so a fresh join always lands next to whoever's already in the world. */
  _snapNearPeer(p) {
    const ang = Math.random() * Math.PI * 2;
    const x = p[0] + Math.cos(ang) * 4;
    const z = p[2] + Math.sin(ang) * 4;
    const g = this.world.sampleGround(x, z);
    const y = (g.onLand ? g.height : p[1]) + 0.15;
    this.controller.teleport(new THREE.Vector3(x, y, z));
  }

  _addRemote(id, info) {
    if (!this._RemotePlayer || this.remote.has(id) || id === this.net?.id) return;
    const rp = new this._RemotePlayer(this.scene, id, info);
    rp._net = this.net;
    rp._getMyPos = () => this.controller.position;
    this.remote.set(id, rp);
    this.combat.addTarget(rp);
    this._netCount();
  }

  _removeRemote(id) {
    const rp = this.remote.get(id);
    if (!rp) return;
    const i = this.combat.targets.indexOf(rp);
    if (i >= 0) this.combat.targets.splice(i, 1);
    rp.dispose();
    this.remote.delete(id);
    this._netCount();
  }

  _clearRemotes() {
    for (const id of [...this.remote.keys()]) this._removeRemote(id);
  }

  _netCount() {
    if (!this.net) return;
    this._netBadge(`En línea · ${this.remote.size + 1} jugador${this.remote.size ? 'es' : ''}`);
  }

  _remoteCast(id, m) {
    const rp = this.remote.get(id);
    if (!rp) return;
    rp.setFruit(m.fruit);
    const ctx = this._remoteCtx(rp, m);
    try { rp.fruit.use(m.slot, ctx, m.arg ?? null); }
    catch (e) { console.warn('[net] remote cast failed', m.slot, e); }
  }

  _remoteCtx(rp, m) {
    const V = THREE.Vector3;
    const pos = new V(m.pos[0], m.pos[1], m.pos[2]);
    const aimDir = new V(m.aim[0], m.aim[1], m.aim[2]);
    const forwardFlat = new V(m.fwd[0], m.fwd[1], m.fwd[2]);
    if (aimDir.lengthSq() < 1e-6) aimDir.copy(forwardFlat);
    if (forwardFlat.lengthSq() < 1e-6) forwardFlat.set(Math.sin(rp.tYaw || 0), 0, Math.cos(rp.tYaw || 0));
    // live getters so trailing VFX / auras follow the moving avatar
    const ctl = {
      get position() { return rp.obj.position.clone(); },
      get chest() { return rp.obj.position.clone().add(new V(0, 1.1, 0)); },
      velocity: new V(), _dashTime: 0, _dashDir: new V(), _dashLen: 0.2,
      grounded: true, facing: rp.tYaw ?? 0, flying: rp.flying, playerIFrames: 0,
      teleport: () => {}
    };
    return {
      origin: ctl.chest, aimDir, forwardFlat,
      combat: (this._replayCombat ||= this._makeReplayCombat()),
      vfx: this.vfx,
      camera: { addShake: () => {} },
      controller: ctl,
      character: rp.character,
      scene: this.scene,
      world: this.world,
      elapsed: this.elapsed,
      pose: (kind) => rp.character.castPose && rp.character.castPose(kind)
    };
  }

  /** damage-free CombatSystem facade for replaying a peer's ability as pure VFX */
  _makeReplayCombat() {
    const real = this.combat;
    const noop = () => {};
    return {
      STATUS: real.STATUS,
      hooks: {},
      playerIFrames: 0,
      playerDamageMult: 1,
      vfx: this.vfx,
      areaStrike: noop,
      meleeStrike: () => 0,
      applyStatus: noop,
      hitstop: noop,
      shake: noop,
      healPlayer: noop,
      damagePlayer: noop,
      nearestEnemies: () => [],
      enemiesInRadius: () => [],
      spawnProjectile: (opts) => real.spawnProjectile({ ...opts, visualOnly: true, faction: 'replay' })
    };
  }

  _takeNetHit(m) {
    const from = m.fromPos || m.from;
    const fp = Array.isArray(from) ? new THREE.Vector3(from[0], from[1], from[2]) : this.controller.position.clone();
    const dir = this.controller.position.clone().sub(fp).setY(0.12);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.2, 1);
    dir.normalize();
    this.combat.damagePlayer(m.damage || 0, dir, { ignoreDodge: !!m.ignoreDodge });
    if ((m.up || 0) > 0 && this.combat.playerIFrames <= 0.3) {
      this.controller.velocity.y = Math.max(this.controller.velocity.y, (m.up || 0) * 0.5);
    }
    if ((m.stun || 0) > 0) this.controller.stunT = Math.max(this.controller.stunT, m.stun);
    if ((m.slowFrac || 0) > 0) {
      this._hakiSlowFrac = m.slowFrac;
      this._hakiSlowT = Math.max(this._hakiSlowT || 0, m.slowDur || 0);
    }
    if (this.combat.playerHp <= 0) this._netDeath();
  }

  _netDeath() {
    const a = Math.random() * Math.PI * 2;
    const R = (this.world.arena?.boundsR ?? this.world.arena?.radius ?? 40) * 0.5;
    const sp = new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R);
    const g = this.world.sampleGround(sp.x, sp.z);
    sp.y = (g.onLand ? g.height : 0) + 0.1;
    this.vfx.flipbook(this.controller.chest.clone(), { kind: 'impact', size: 10, life: 0.5, color: 0xff5555 });
    this.controller.teleport(sp);
    this.combat.playerHp = this.combat.playerMaxHp;
    this.combat.playerIFrames = 2.0;
    this.hud.setHealth(1);
    this.camera.addShake(0.5);
    this.render.flash(0.5, 0xff3344);
    this.net?.sendRespawn(sp);
  }

  _netTick(dt) {
    if (!this.net) return;
    // remote avatars are stepped by combat.update() (they are combat targets)
    const c = this.controller;
    this.net.sendState(dt, {
      p: [Math.round(c.position.x * 100) / 100, Math.round(c.position.y * 100) / 100, Math.round(c.position.z * 100) / 100],
      y: Math.round(c.facing * 1000) / 1000,
      fl: c.flying ? 1 : 0,
      hp: Math.round(this.combat.playerHp),
      f: this._fruitIdx
    });
    this.net.tick(dt);
  }
}
