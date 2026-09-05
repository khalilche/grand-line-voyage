import * as THREE from 'three';

/**
 * Third-person orbit rig with over-the-shoulder aim and a first-person toggle.
 * Mouse-look via pointer lock; spring smoothing on position + collision pull-in.
 */
export class CameraRig {
  constructor(input, colliders = []) {
    this.input = input;
    this.colliders = colliders;

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 8000);

    this.target = new THREE.Vector3();      // world point we orbit (roughly the chest)
    this.smoothTarget = new THREE.Vector3();
    this.yaw = Math.PI;
    this.pitch = 0.16;
    this.distance = 6.2;
    this.wantDistance = 6.2;
    this._zoom = 6.2;              // user wheel-zoom distance (3rd-person), persists across mode changes
    this._zoomMin = 1.1;           // close enough to feel almost over-the-shoulder
    this._zoomMax = 42;            // wide establishing-shot distance
    this._shiftlockMin = 8.5;      // while shiftlocked, never sit closer than this — keeps the body from feeling cramped against the lens
    this.mode = 'third';                    // 'third' | 'shoulder' | 'first'
    this._camPos = new THREE.Vector3(0, 3, 10);
    this._shake = 0;
    this._shakeDecay = 0;

    this.sensitivity = 0.0024;
    this.minPitch = -0.9;
    this.maxPitch = 1.15;

    this._ray = new THREE.Raycaster();
    this._aimRay = new THREE.Raycaster();
    this._baseFov = 58;
    this.minCollision = 2.3;
  }

  /**
   * World point the mouse cursor is over — for "cast toward the pointer".
   * Tries scene colliders, then a horizontal plane at chest height, then a
   * far point down the ray.
   */
  aimPointFromScreen(ndc, chest, colliders = []) {
    this._aimRay.setFromCamera(ndc, this.camera);
    const o = this._aimRay.ray.origin, d = this._aimRay.ray.direction;
    if (colliders && colliders.length) {
      const hits = this._aimRay.intersectObjects(colliders, true);
      if (hits.length) return hits[0].point.clone();
    }
    if (Math.abs(d.y) > 1e-4) {
      const t = (chest.y - o.y) / d.y;
      if (t > 0.5 && t < 500) return o.clone().addScaledVector(d, t);
    }
    return o.clone().addScaledVector(d, 80);
  }

  setColliders(arr) { this.colliders = arr || []; }

  setMode(m) {
    if (m === 'first') m = 'third';                 // first-person removed
    this.mode = m;
    if (m === 'shoulder') this.wantDistance = 2.6;
    else this.wantDistance = this._zoom;            // restore the user's wheel zoom
  }
  toggleFirstPerson() {}                            // no-op — kept so old callers don't crash
  addShake(amount, decay = 3) {
    this._shake = Math.min(1.2, this._shake + amount);
    this._shakeDecay = decay;
  }

  /**
   * Timed CINEMATIC override for an ability beat — dolly the orbit, punch the
   * FOV, and/or bias the framing toward a world point, then ease back to
   * gameplay. All fields optional; call again to retarget mid-move.
   *   dist     pull the orbit to this distance
   *   fov      punch the vertical FOV to this value
   *   focus    Vector3 the camera frames (blended by `focusMix`)
   *   liftAdd  raise the framing by this many metres (for "epic" high angles)
   *   inT/holdT/outT   seconds to ramp in, hold, ramp out
   */
  cine({ dist = null, fov = null, focus = null, focusMix = 0.6, liftAdd = 0, spin = 0, pitchAdd = 0, inT = 0.18, holdT = 0.3, outT = 0.7 } = {}) {
    this._cine = { dist, fov, focus: focus ? focus.clone() : null, focusMix, liftAdd, spin, pitchAdd, t: 0, inT, holdT, outT, total: inT + holdT + outT };
  }
  _cineK(dt) {
    const c = this._cine;
    if (!c) return 0;
    c.t += dt;
    let k;
    if (c.t < c.inT) k = c.t / c.inT;
    else if (c.t < c.inT + c.holdT) k = 1;
    else if (c.t < c.total) k = 1 - (c.t - c.inT - c.holdT) / c.outT;
    else { this._cine = null; return 0; }
    return k * k * (3 - 2 * k);                     // smoothstep
  }

  /** @param {THREE.Vector3} focus chest-height world point to follow */
  update(dt, focus, opts = {}) {
    if (this.input.pointerLocked) {
      const { dx, dy } = this.input.consumeLook();
      this.yaw -= dx * this.sensitivity;
      this.pitch -= dy * this.sensitivity;
      this.pitch = THREE.MathUtils.clamp(this.pitch, this.minPitch, this.maxPitch);
    }
    // mouse-wheel zoom — scroll to pull the camera in / out (step scales with
    // distance so it stays smooth across the whole range)
    const w = this.input.consumeWheel();
    if (w) {
      this._zoom = THREE.MathUtils.clamp(this._zoom * (1 + w * 0.18), this._zoomMin, this._zoomMax);
      if (this.mode !== 'shoulder') this.wantDistance = this._zoom;
    }

    // aim override — pull to an over-the-shoulder framing while aiming
    const aiming = !!opts.aim;
    if (aiming && this.mode !== 'shoulder') this.setMode('shoulder');
    else if (!aiming && this.mode === 'shoulder') this.setMode('third');

    // cinematic override (ability beats) — dolly / FOV punch / reframing
    const cineK = this._cineK(dt);
    const cine = this._cine;
    const cineDolly = cine && cine.dist != null;
    let wantDist = cineDolly ? THREE.MathUtils.lerp(this.wantDistance, cine.dist, cineK) : this.wantDistance;
    // shiftlock — hold the camera back a comfortable minimum so the body never
    // feels pinned against the lens; purely local (doesn't touch this.wantDistance
    // / the persisted scroll-zoom), so it releases cleanly the instant you let go
    if (opts.shiftlock && !cineDolly && this.mode !== 'shoulder') wantDist = Math.max(wantDist, this._shiftlockMin);
    this.distance = THREE.MathUtils.damp(this.distance, wantDist, cineK > 0 ? 7 : 10, dt);

    this.target.copy(focus);
    if (cineK > 0 && cine && cine.focus) this.target.lerp(cine.focus, cineK * cine.focusMix);
    this.smoothTarget.x = THREE.MathUtils.damp(this.smoothTarget.x, this.target.x, 16, dt);
    this.smoothTarget.y = THREE.MathUtils.damp(this.smoothTarget.y, this.target.y + (cine ? cine.liftAdd * cineK : 0), 12, dt);
    this.smoothTarget.z = THREE.MathUtils.damp(this.smoothTarget.z, this.target.z, 16, dt);

    // cinematic orbit / tilt — sweep the yaw during the in+hold, then keep it
    const cineOrbit = cine ? cine.spin * THREE.MathUtils.smoothstep(cine.t / Math.max(0.001, cine.inT + cine.holdT), 0, 1) : 0;
    const cinePitch = cine ? cine.pitchAdd * cineK : 0;
    const cYaw = this.yaw + cineOrbit;
    const cPit = THREE.MathUtils.clamp(this.pitch + cinePitch, this.minPitch, this.maxPitch);
    const dir = new THREE.Vector3(
      Math.sin(cYaw) * Math.cos(cPit),
      Math.sin(cPit),
      Math.cos(cYaw) * Math.cos(cPit)
    );

    // shoulder offset to the right in camera space
    const right = new THREE.Vector3().crossVectors(dir, _up).normalize();
    const shoulder = this.mode === 'shoulder' ? 0.85 : 0.4;
    const lift = this.mode === 'shoulder' ? 0.4 : 0.85;
    const desired = this.smoothTarget.clone()
      .addScaledVector(dir, -this.distance)
      .addScaledVector(right, shoulder)
      .add(new THREE.Vector3(0, lift, 0));

    // collision pull-in — keep a hard minimum so the camera never enters the pawn
    if (this.colliders.length) {
      const from = this.smoothTarget.clone().add(new THREE.Vector3(0, 0.5, 0));
      const seg = desired.clone().sub(from);
      const len = seg.length();
      if (len > 0.001) {
        const nseg = seg.clone().normalize();
        this._ray.set(from, nseg);
        this._ray.far = len;
        const hits = this._ray.intersectObjects(this.colliders, true);
        if (hits.length) {
          const d = Math.max(hits[0].distance - 0.35, 1.0);
          desired.copy(from).addScaledVector(nseg, d);
          // if forced very close, lift up and over the obstruction instead of into the pawn
          if (d < this.minCollision) desired.y += (this.minCollision - d) * 0.7;
        }
      }
    }

    this._camPos.x = THREE.MathUtils.damp(this._camPos.x, desired.x, 18, dt);
    this._camPos.y = THREE.MathUtils.damp(this._camPos.y, desired.y, 18, dt);
    this._camPos.z = THREE.MathUtils.damp(this._camPos.z, desired.z, 18, dt);

    this.camera.position.copy(this._camPos);

    // shake
    if (this._shake > 0.0001) {
      const s = this._shake * this._shake;
      this.camera.position.x += (Math.random() - 0.5) * s * 0.6;
      this.camera.position.y += (Math.random() - 0.5) * s * 0.6;
      this._shake = Math.max(0, this._shake - dt * this._shakeDecay);
    }

    const lookAt = this.smoothTarget.clone().add(new THREE.Vector3(0, this.mode === 'shoulder' ? 0.2 : 0.35, 0));
    this.camera.lookAt(lookAt);

    // fov: punch in slightly when aiming, widen a touch at speed, + cinematic punch
    let targetFov = this._baseFov + (aiming ? -8 : 0) + (opts.speedFov || 0);
    if (cineK > 0 && cine && cine.fov != null) targetFov = THREE.MathUtils.lerp(targetFov, cine.fov, cineK);
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, cineK > 0 ? 12 : 8, dt);
    this.camera.updateProjectionMatrix();
  }

  /** horizontal forward = camera->target projected to the ground plane */
  getForward(target = new THREE.Vector3()) {
    return target.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).normalize();
  }
  /** cross(forward, up) */
  getRight(target = new THREE.Vector3()) {
    return target.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw)).normalize();
  }
  /** full aim direction incl. pitch, for shooting */
  getAimDir(target = new THREE.Vector3()) {
    return target.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch)
    ).normalize();
  }
}

const _up = new THREE.Vector3(0, 1, 0);
