import * as THREE from 'three';
import { Character } from './Character.js';
import { FRUITS } from '../combat/DevilFruit.js';

/* distinct shirt / hat tints so teammates are told apart at a glance */
const PALETTES = [
  { shirt: 0xd24a41, hatBand: 0xc23a2e },
  { shirt: 0x3a7bd5, hatBand: 0x2b5fa8 },
  { shirt: 0x49a84c, hatBand: 0x37803a },
  { shirt: 0xc9a227, hatBand: 0xa5851b },
  { shirt: 0x8e44ad, hatBand: 0x6f3488 },
  { shirt: 0xe67e22, hatBand: 0xb5611a },
  { shirt: 0x16a085, hatBand: 0x0f7c66 },
  { shirt: 0xdd4b7a, hatBand: 0xb23a61 }
];

function hashId(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

function makeLabel(text) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  g.font = 'bold 34px "Trebuchet MS", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.strokeText(text, 128, 34);
  g.fillStyle = '#eaf2ff'; g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(2.2, 0.55, 1);
  spr.position.set(0, 2.75, 0);
  spr.renderOrder = 999;
  return spr;
}

/**
 * A networked stand-in for another player. Reuses the real Character rig so it
 * looks and animates like the local avatar. Registers as a `pvp` combat target
 * so local abilities can strike it — damage is NOT applied here; takeHit()
 * forwards the blow to that player over the wire, and they apply it to themself.
 *
 * combat.update() calls `update(dt)` on every target, so that is the single
 * driver. Sprites (label + hp bar) auto-billboard, no camera needed.
 */
export class RemotePlayer {
  constructor(scene, id, info = {}) {
    this.id = id;
    this.name = info.name || 'Pirata';
    this.scene = scene;

    // ---- combat-target interface ----
    this.faction = 'player';
    this.pvp = true;
    this.isRemotePlayer = true;
    this.dead = false;
    this.radius = 0.55;
    this.maxHp = 100; this.hp = 100;
    this._stun = 0;
    this._status = {};
    this.velocity = new THREE.Vector3();
    this.impulse = new THREE.Vector3();   // abilities push here; ignored (net-authoritative pos)
    this.mass = 1;
    this._net = null;                 // set by Game
    this._getMyPos = null;            // () => local player position, set by Game

    // ---- visuals ----
    const pal = PALETTES[hashId(String(id)) % PALETTES.length];
    this.character = new Character({ palette: pal });
    this.obj = this.character.root;
    scene.add(this.obj);

    this.label = makeLabel(this.name);
    this.obj.add(this.label);

    this._hpBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x0b131f, transparent: true, opacity: 0.82, depthTest: false }));
    this._hpBg.scale.set(1.5, 0.16, 1);
    this._hpBg.position.set(0, 2.42, 0);
    this._hpBg.renderOrder = 998;
    this.obj.add(this._hpBg);

    this._hpFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x66dd77, depthTest: false }));
    this._hpFill.scale.set(1.42, 0.1, 1);
    this._hpFill.position.set(0, 2.42, 0.001);
    this._hpFill.renderOrder = 999;
    this.obj.add(this._hpFill);
    this._hpFullW = 1.42;

    // ---- own fruit instances (isolated cooldowns / timers) ----
    this.fruitIdx = info.fruit ?? 0;
    this.fruits = FRUITS.map((F) => new F());
    this.fruit = this.fruits[this.fruitIdx] || this.fruits[0];

    // ---- interpolation state ----
    this.tPos = new THREE.Vector3().copy(this.obj.position);
    this.tYaw = Math.PI;
    this.obj.rotation.y = Math.PI;
    this._prev = this.tPos.clone();
    this._speed = 0;
    this.flying = false;
    this._poseT = 0;
  }

  get center() { return this.obj.position.clone().add(_UPCHEST); }

  setFruit(idx) {
    if (idx == null || idx === this.fruitIdx || !this.fruits[idx]) return;
    this.fruitIdx = idx;
    this.fruit = this.fruits[idx];
  }

  applyState(s) {
    if (s.p) {
      this.tPos.set(s.p[0], s.p[1], s.p[2]);
      if (!this._gotFirst) { this._gotFirst = true; this.obj.position.copy(this.tPos); }
    }
    if (typeof s.y === 'number') { this.tYaw = s.y; if (!this._gotYaw) { this._gotYaw = true; this.obj.rotation.y = s.y; } }
    this.flying = !!s.fl;
    if (typeof s.hp === 'number') { this.hp = THREE.MathUtils.clamp(s.hp, 0, this.maxHp); this._refreshHp(); }
    if (typeof s.f === 'number') this.setFruit(s.f);
  }

  /** a local ability struck this puppet — bounce the blow to its real owner */
  takeHit(opts = {}) {
    if (this._net && this._getMyPos) {
      this._net.sendHit(this.id, opts.damage || 0, opts.up || 0, opts.stun || 0, this._getMyPos(), {
        ignoreDodge: !!opts.ignoreDodge, slowFrac: opts.slowFrac || 0, slowDur: opts.slowDur || 0
      });
    }
  }

  poke() { this._poseT = 0.28; this.character.castPose && this.character.castPose('punch'); }

  _refreshHp() {
    const k = THREE.MathUtils.clamp(this.hp / this.maxHp, 0.001, 1);
    this._hpFill.scale.x = this._hpFullW * k;
    this._hpFill.position.x = -(1 - k) * this._hpFullW * 0.5;
    this._hpFill.material.color.setHex(k > 0.5 ? 0x66dd77 : k > 0.25 ? 0xe6c14a : 0xdd5555);
  }

  update(dt) {
    dt = Math.min(dt, 1 / 20);
    this.impulse.set(0, 0, 0);          // discard ability knockback — position is network-driven
    this._prev.copy(this.obj.position);
    this.obj.position.lerp(this.tPos, Math.min(1, dt * 14));
    let dy = this.tYaw - this.obj.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.obj.rotation.y += dy * Math.min(1, dt * 12);

    const moved = this.obj.position.distanceTo(this._prev) / Math.max(dt, 1e-4);
    this._speed = THREE.MathUtils.damp(this._speed, THREE.MathUtils.clamp(moved / 11, 0, 1), 8, dt);
    this._poseT = Math.max(0, this._poseT - dt);

    this.character.update(dt, {
      speed: this._speed, groundSpeed: moved, turn: 0,
      grounded: !this.flying, vertVel: 0, inWater: false, flying: this.flying,
      aim: false, attackPose: this._poseT > 0 ? 'punch' : null
    });
    if (this.fruit) this.fruit.update(dt);
  }

  dispose() {
    this.scene.remove(this.obj);
    this.label.material.map?.dispose?.();
    this.label.material.dispose?.();
    this._hpBg.material.dispose?.();
    this._hpFill.material.dispose?.();
  }
}

const _UPCHEST = new THREE.Vector3(0, 1.1, 0);
