import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';

const COUNTS = { lite: 350, high: 900, ultra: 1400 };
const _farAway = new THREE.Vector3(0, -99999, 0);
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _oneScale = new THREE.Vector3(1, 1, 1);

/**
 * A volume of falling rain streaks that always surrounds `focus` (the
 * camera/player), recycling drops from the top as they fall past the bottom —
 * the classic "rain box follows the player" trick, no per-drop terrain
 * collision (kept deliberately cheap). Intensity 0..1 fades the whole thing
 * in/out and thins/thickens how many streaks are actually visible.
 */
export class Rain {
  constructor(scene) {
    this.scene = scene;
    this.count = COUNTS[QUALITY.tier] || 900;
    this.radius = 26;     // horizontal spread around the focus point
    this.height = 34;     // a drop starts this far above the focus
    this.floor = -6;      // ...and recycles once this far below it
    this.fallSpeed = 34;
    this.wind = new THREE.Vector3(2.4, 0, 1.1);

    this.intensity = 0;         // smoothed, what actually drives the visuals
    this._targetIntensity = 0;  // set by setIntensity()

    const streakLen = 0.85;
    const geo = new THREE.CylinderGeometry(0.011, 0.011, streakLen, 3, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xcfe0ff, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: true
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this._drops = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this._drops[i] = new THREE.Vector3(
        (Math.random() * 2 - 1) * this.radius,
        this.floor + Math.random() * (this.height - this.floor),
        (Math.random() * 2 - 1) * this.radius
      );
    }
    this._m = new THREE.Matrix4();
    // tilt the streaks slightly along the wind so they read as falling rain, not rods
    this._q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(-this.wind.x * 0.03, -1, -this.wind.z * 0.03).normalize()
    );
  }

  /** 0..1 — fades the rain in/out; call from World's weather cycle. */
  setIntensity(v) { this._targetIntensity = THREE.MathUtils.clamp(v, 0, 1); }

  update(dt, focus) {
    this.intensity = THREE.MathUtils.damp(this.intensity, this._targetIntensity, 0.7, dt);
    this.mesh.visible = this.intensity > 0.01;
    if (!this.mesh.visible || !focus) return;

    this.mesh.material.opacity = 0.12 + this.intensity * 0.34;
    const active = Math.max(1, Math.round(this.count * this.intensity));
    const fall = this.fallSpeed;
    for (let i = 0; i < this.count; i++) {
      const d = this._drops[i];
      if (i >= active) {
        this._m.compose(_farAway, this._q, _zeroScale);
        this.mesh.setMatrixAt(i, this._m);
        continue;
      }
      d.y -= fall * dt;
      d.x += this.wind.x * dt;
      d.z += this.wind.z * dt;
      if (d.y < focus.y + this.floor) {
        d.set(
          focus.x + (Math.random() * 2 - 1) * this.radius,
          focus.y + this.height,
          focus.z + (Math.random() * 2 - 1) * this.radius
        );
      }
      // keep the volume centred on a moving focus without a visible "wall" edge
      if (Math.abs(d.x - focus.x) > this.radius) d.x = focus.x + (Math.random() * 2 - 1) * this.radius;
      if (Math.abs(d.z - focus.z) > this.radius) d.z = focus.z + (Math.random() * 2 - 1) * this.radius;
      this._m.compose(d, this._q, _oneScale);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
