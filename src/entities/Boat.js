import * as THREE from 'three';
import { toonMaterial, addOutline } from '../rendering/toon.js';

/**
 * A small caravel that floats via 4-point buoyancy sampling against the Ocean,
 * with arcade sailing (throttle + rudder), a bob-driven wake, and a deck the
 * player can stand on (boardable). getDeckHeight() answers stand queries.
 */
export class Boat {
  constructor(scene, world, vfx) {
    this.scene = scene;
    this.world = world;
    this.vfx = vfx;

    this.root = new THREE.Group();
    const dock = world.islands[0]?.dockEnd || world.spawn;
    this.root.position.copy(dock).add(new THREE.Vector3(6, 0, 0));
    scene.add(this.root);

    this.hullGroup = new THREE.Group();     // visually tilts with waves
    this.root.add(this.hullGroup);

    this.velocity = new THREE.Vector3();
    this.heading = -Math.PI / 2;            // yaw
    this.throttle = 0;
    this.rudder = 0;
    this.speed = 0;

    // buoyancy probes in local space (bow, stern, port, starboard)
    this.probes = [
      new THREE.Vector3(0, 0, 3.4),
      new THREE.Vector3(0, 0, -3.4),
      new THREE.Vector3(1.7, 0, 0),
      new THREE.Vector3(-1.7, 0, 0)
    ];
    this._wave = { height: 0, normal: new THREE.Vector3() };
    this._wakeT = 0;

    this._build();
  }

  _build() {
    const woodDark = toonMaterial({ color: 0x6e4324, stops: 3, rim: 0xffd9a0, rimStrength: 0.25 });
    const wood = toonMaterial({ color: 0x9c6b3f, stops: 3, rim: 0xffe6bf, rimStrength: 0.3 });
    const trim = toonMaterial({ color: 0xcaa15e, stops: 3 });
    const sailMat = toonMaterial({ color: 0xf3ead6, stops: 3, rim: 0xffffff, rimStrength: 0.4 });
    sailMat.side = THREE.DoubleSide;
    const flagMat = toonMaterial({ color: 0xcf3b32, stops: 2 });
    flagMat.side = THREE.DoubleSide;

    // hull — tapered box + prow wedge
    const hull = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.6, 7.4, 4, 2, 6), woodDark);
    const hp = hull.geometry.attributes.position;
    for (let i = 0; i < hp.count; i++) {
      const z = hp.getZ(i), y = hp.getY(i);
      const t = (z / 3.7);
      hp.setX(i, hp.getX(i) * (1 - Math.abs(t) * 0.45) * (y < 0 ? 0.8 : 1));
      if (y < 0) hp.setY(i, y - Math.abs(t) * 0.3);
    }
    hull.geometry.computeVertexNormals();
    hull.position.y = 0.2;
    hull.castShadow = hull.receiveShadow = true;
    addOutline(hull, { thickness: 0.004 });
    this.hullGroup.add(hull);

    // deck
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.2, 6.6), wood);
    deck.position.y = 1.0;
    deck.receiveShadow = true;
    addOutline(deck, { thickness: 0.004 });
    this.hullGroup.add(deck);
    this.deckLocalY = 1.1;

    // gunwale rails
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 6.4), trim);
      rail.position.set(s * 1.45, 1.3, 0);
      addOutline(rail, { thickness: 0.0035 });
      this.hullGroup.add(rail);
    }

    // mast + yard + sail
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 6.4, 8), trim);
    mast.position.set(0, 4.0, 0.4);
    mast.castShadow = true;
    addOutline(mast, { thickness: 0.0035 });
    this.hullGroup.add(mast);

    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.6, 6), trim);
    yard.rotation.z = Math.PI / 2;
    yard.position.set(0, 5.6, 0.4);
    this.hullGroup.add(yard);

    const sailGeo = new THREE.PlaneGeometry(4.2, 3.6, 12, 10);
    this._sailGeo = sailGeo;
    this._sailRest = sailGeo.attributes.position.array.slice();
    const sail = new THREE.Mesh(sailGeo, sailMat);
    sail.position.set(0, 3.9, 0.42);
    sail.castShadow = true;
    this.sail = sail;
    this.hullGroup.add(sail);

    // pirate flag
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.8, 8, 6), flagMat);
    this._flagGeo = flag.geometry;
    this._flagRest = flag.geometry.attributes.position.array.slice();
    flag.position.set(0, 7.1, 0.4);
    this.flag = flag;
    this.hullGroup.add(flag);

    // ship's wheel
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.06, 8, 16), trim);
    wheel.position.set(0, 1.7, -2.6);
    this.wheel = wheel;
    this.hullGroup.add(wheel);

    // helm stand marker (where the player controls from)
    this.helmLocal = new THREE.Vector3(0, this.deckLocalY, -2.2);
  }

  /** world Y of the deck surface near (x,z), or -Infinity if off the deck. */
  getDeckHeight(x, z) {
    const local = _v.set(x, 0, z).sub(this.root.position);
    local.applyAxisAngle(_up, -this.root.rotation.y);
    if (Math.abs(local.x) > 1.5 || Math.abs(local.z) > 3.3) return -Infinity;
    return this.root.position.y + this.deckLocalY + this.hullGroup.position.y;
  }

  get helmWorld() {
    return this.helmLocal.clone().applyAxisAngle(_up, this.root.rotation.y).add(this.root.position);
  }

  control(input) {
    const fwd = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const turn = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    this.throttle = THREE.MathUtils.damp(this.throttle, fwd, 2, 1 / 60);
    this.rudder = THREE.MathUtils.damp(this.rudder, turn, 6, 1 / 60);
  }

  update(dt, elapsed, { controlled = false } = {}) {
    // ---- sailing dynamics ----
    if (controlled) {
      const accel = 7.0;
      this.speed += this.throttle * accel * dt;
    }
    this.speed *= Math.max(0, 1 - 1.1 * dt);            // water drag
    this.speed = THREE.MathUtils.clamp(this.speed, -6, 16);
    this.heading -= this.rudder * (0.9 + Math.abs(this.speed) * 0.06) * dt * (this.speed >= 0 ? 1 : -1);

    const dir = _v2.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.root.position.addScaledVector(dir, this.speed * dt);

    // ---- buoyancy: average probe heights + tilt from the plane they form ----
    let avgY = 0;
    _n.set(0, 0, 0);
    const pts = [];
    for (const p of this.probes) {
      const wp = _v3.copy(p).applyAxisAngle(_up, this.heading).add(this.root.position);
      this.world.waterWave(wp.x, wp.z, this._wave);
      avgY += this._wave.height;
      _n.add(this._wave.normal);
      pts.push(this._wave.height);
    }
    avgY /= this.probes.length;
    _n.normalize();

    const targetY = avgY + 0.35;
    this.root.position.y = THREE.MathUtils.damp(this.root.position.y, targetY, 6, dt);

    // pitch from bow-stern diff, roll from port-starboard diff
    const pitch = Math.atan2(pts[0] - pts[1], 6.8) * 0.8;
    const roll = Math.atan2(pts[2] - pts[3], 3.4) * 0.8;
    this.root.rotation.y = this.heading;
    this.hullGroup.rotation.x = THREE.MathUtils.damp(this.hullGroup.rotation.x, -pitch, 5, dt);
    this.hullGroup.rotation.z = THREE.MathUtils.damp(this.hullGroup.rotation.z, roll, 5, dt);
    this.hullGroup.position.y = Math.sin(elapsed * 1.3) * 0.05;

    // ---- cloth wobble ----
    this._flutter(this._sailGeo, this._sailRest, elapsed, 0.12 + Math.abs(this.throttle) * 0.1, 2.2);
    this._flutter(this._flagGeo, this._flagRest, elapsed, 0.22, 6.0);
    this.wheel.rotation.z = -this.rudder * 1.6;

    // ---- wake ----
    this._wakeT += dt;
    if (Math.abs(this.speed) > 2 && this._wakeT > 0.06) {
      this._wakeT = 0;
      const stern = _v3.set(0, 0, -3.6).applyAxisAngle(_up, this.heading).add(this.root.position);
      stern.y = avgY + 0.1;
      this.vfx.burst(stern, {
        count: 6, color: 0xffffff, color2: 0xbfe4ff, speed: 1.6, size: 0.35,
        life: 0.9, gravity: 1.5, drag: 1.8, dir: _up, cone: 1.2
      });
    }
  }

  _flutter(geo, rest, t, amp, freq) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = rest[i * 3], y = rest[i * 3 + 1];
      const edge = (x + 2.1) / 4.2;
      const w = Math.sin(x * 1.6 + t * freq) * amp * edge
              + Math.sin(y * 2.0 + t * freq * 0.7) * amp * 0.4 * edge;
      pos.setZ(i, rest[i * 3 + 2] + w);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
