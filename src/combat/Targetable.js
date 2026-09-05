import * as THREE from 'three';

/** Anything that can be hit. Handles hp, hit-flash, knockback impulse + death. */
export class Targetable {
  constructor(object3D, { hp = 100, radius = 0.9, faction = 'enemy', mass = 1 } = {}) {
    this.obj = object3D;
    this.maxHp = hp;
    this.hp = hp;
    this.radius = radius;
    this.faction = faction;
    this.mass = mass;
    this.dead = false;
    this.velocity = new THREE.Vector3();
    this.impulse = new THREE.Vector3();
    this._flash = 0;
    this._stun = 0;
    this._origColors = new Map();
    this.onDeath = null;
    this.onHitReact = null;

    object3D.traverse((c) => {
      if (c.isMesh && c.material && c.material.color && !c.name.endsWith('__outline')) {
        this._origColors.set(c, c.material.color.clone());
      }
    });
  }

  get center() {
    return _v.copy(this.obj.position).add(_o.set(0, this.radius, 0));
  }
  get stunned() { return this._stun > 0; }

  takeHit({ damage = 10, dir = null, knockback = 0, up = 0, stun = 0.25, source = null } = {}) {
    if (this.dead) return false;
    this.hp -= damage;
    this._flash = 1;
    this._stun = Math.max(this._stun, stun);
    if (dir && knockback) {
      this.impulse.addScaledVector(dir, knockback / this.mass);
      this.impulse.y += up / this.mass;
    }
    this.onHitReact && this.onHitReact({ damage, source, dir });
    if (this.hp <= 0) this._die(dir);
    return true;
  }

  _die(dir) {
    this.dead = true;
    if (dir) this.impulse.addScaledVector(dir, 6).setY(7);
    this.onDeath && this.onDeath(this);
  }

  update(dt, world) {
    // hit flash decay
    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt * 5);
      const k = this._flash;
      for (const [mesh, col] of this._origColors) {
        mesh.material.color.copy(col).lerp(_white, k * 0.85);
      }
    }
    if (this._stun > 0) this._stun -= dt;

    // knockback physics
    this.velocity.addScaledVector(this.impulse, 1);
    this.impulse.set(0, 0, 0);
    this.velocity.y -= 24 * dt;
    this.velocity.x *= Math.max(0, 1 - 3 * dt);
    this.velocity.z *= Math.max(0, 1 - 3 * dt);

    this.obj.position.addScaledVector(this.velocity, dt);

    const g = world ? world.sampleGround(this.obj.position.x, this.obj.position.z) : { height: 0 };
    const floor = g.height;
    if (this.obj.position.y <= floor) {
      this.obj.position.y = floor;
      if (this.velocity.y < -3 && !this.dead) this.velocity.y *= -0.35;   // small bounce
      else this.velocity.y = 0;
      this.velocity.x *= 0.7;
      this.velocity.z *= 0.7;
    }
  }
}

const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _white = new THREE.Color(0xffffff);
