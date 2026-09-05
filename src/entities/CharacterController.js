import * as THREE from 'three';

/**
 * Kinematic capsule controller over the World heightfield + ocean.
 * Handles: accel/friction ground move, sprint, air control, jump w/ coyote +
 * buffer, an air "sky jump" (Geppo), a dash burst, and buoyant swimming.
 * Hooks (assign functions): onJump, onSkyJump, onDash, onLand, onStep.
 */
export class CharacterController {
  constructor(object3D, world) {
    this.obj = object3D;
    this.world = world;

    this.position = world.spawn.clone();
    this.velocity = new THREE.Vector3();
    this.facing = Math.PI;                 // yaw radians
    this.radius = 0.4;
    this.height = 1.8;

    this.grounded = false;
    this.inWater = false;
    this.flying = false;
    this.flySpeed = 15;
    this.flyVertSpeed = 11;
    this.iceWalk = false;          // Hie Hie passive: freeze the water underfoot
    this.onFrozenWater = false;
    this.faceLock = 0;             // seconds left to hold facing at faceLockYaw (ability cast)
    this.faceLockYaw = 0;
    this.state = 'idle';
    this.speed01 = 0;

    // tuning — snappy, air-mobile, Blox-Fruits-ish
    this.walkSpeed = 7.3;
    this.runSpeed = 13.2;
    this.swimSpeed = 5.2;
    this.accel = 98;
    this.airAccel = 50;
    this.friction = 16;
    this.gravity = 25;
    this.jumpVel = 12.4;
    this.skyJumpVel = 11.2;
    this.maxFall = -48;

    // timers
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._airJumps = 0;
    this._maxAirJumps = 2;          // ground jump + 2 air jumps = triple jump
    this._dashCd = 0;
    this._dashTime = 0;
    this._dashLen = 0.2;
    this._dashDir = new THREE.Vector3();
    this._slick = 0;               // seconds of "on ice": low friction + weak control (Hie Hie ice patches / slide)
    this._airDashes = 0;
    this._maxAirDashes = 2;         // chain multiple dashes in the air before touching down
    this._stepDist = 0;
    this._tap = { code: null, t: 0 };
    this._wave = { height: 0, normal: new THREE.Vector3() };
    this.stunT = 0;          // seconds of input lock left (Haoshoku CC on the player)
    this.speedMult = 1;      // temporary movement-speed multiplier (Haoshoku's PvP slow); Game.js decays this

    // hooks
    this.onJump = null;
    this.onSkyJump = null;
    this.onDash = null;
    this.onLand = null;
    this.onStep = null;
  }

  get eyeHeight() { return this.position.y + 1.5; }
  get chest() { return _v0.set(this.position.x, this.position.y + 1.15, this.position.z); }

  teleport(v) { this.position.copy(v); this.velocity.set(0, 0, 0); }

  update(dt, { camera, input, aiming, faceCamera }) {
    dt = Math.min(dt, 1 / 30);
    if (this.faceLock > 0) this.faceLock -= dt;
    if (this._slick > 0) this._slick -= dt;
    if (this.stunT > 0) this.stunT = Math.max(0, this.stunT - dt);   // Haoshoku CC — see wantDash below for the dash gate
    const lockFace = aiming || faceCamera;

    // ---- input basis ----
    const fwd = camera.getForward(_v1);
    const right = camera.getRight(_v2);
    let ix = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    let iz = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    if (this.stunT > 0) { ix = 0; iz = 0; }
    const wish = _v3.set(0, 0, 0).addScaledVector(fwd, iz).addScaledVector(right, ix);
    const hasInput = wish.lengthSq() > 0.0001;
    if (hasInput) wish.normalize();

    const sprint = input.isDown('ShiftLeft') || input.isDown('ShiftRight');

    // ---- flight (Mera Mera "Vuelo") — free 3D movement, no gravity ----
    if (this.flying) {
      const fs = sprint ? this.flySpeed * 1.6 : this.flySpeed;
      this.velocity.x = THREE.MathUtils.damp(this.velocity.x, wish.x * fs, 6, dt);
      this.velocity.z = THREE.MathUtils.damp(this.velocity.z, wish.z * fs, 6, dt);
      let vy = 0;
      if (input.isDown('Space')) vy = this.flyVertSpeed;
      else if (input.isDown('ControlLeft') || input.isDown('ControlRight')) vy = -this.flyVertSpeed;
      this.velocity.y = THREE.MathUtils.damp(this.velocity.y, vy, 6, dt);

      this.position.addScaledVector(this.velocity, dt);
      this.world.arena && this.world.arena.resolveWalls(this.position, this.radius);
      const fg = this.world.sampleGround(this.position.x, this.position.z, this.position.y);
      const floorY = (fg.onLand ? fg.height : 0) + 0.6;
      if (this.position.y < floorY) { this.position.y = floorY; if (this.velocity.y < 0) this.velocity.y = 0; }
      if (this.position.y > floorY + 70 && this.velocity.y > 0) this.velocity.y = 0;   // soft ceiling

      this.grounded = false; this.inWater = false;
      const hs = Math.hypot(this.velocity.x, this.velocity.z);
      this.groundSpeed = hs;
      this.speed01 = THREE.MathUtils.clamp(hs / this.flySpeed, 0, 1);
      if (hs > 0.6) this.facing = _dampAngle(this.facing, Math.atan2(this.velocity.x, this.velocity.z), 8, dt);
      this.turnRate = 0;
      this.state = 'fly';
      this.obj.position.copy(this.position);
      this.obj.rotation.y = this.facing;
      return;
    }

    // ---- ground / water probe ----
    const g = this.world.sampleGround(this.position.x, this.position.z, this.position.y);
    this.world.waterWave(this.position.x, this.position.z, this._wave);
    const waterY = this._wave.height;
    const feetY = this.position.y;

    const overLand = g.onLand;
    const landY = g.height;

    // Hie Hie passive: when over open water, the surface is solid ground
    const frozen = this.iceWalk && !overLand && feetY < waterY + 1.2 && this.velocity.y < 8;
    this.onFrozenWater = false;

    // ---- dash — advanced: short cooldown so it chains almost constantly,
    // up to `_maxAirDashes` in the air, and steerable mid-dash so holding a
    // different direction curves it naturally instead of locking a straight line ----
    this._dashCd = Math.max(0, this._dashCd - dt);
    this._detectDoubleTap(input, dt);
    const wantDash = (input.justPressed('KeyQ') || this._tap.fired) && this.stunT <= 0;
    const canAirDash = !this.grounded && this._airDashes < this._maxAirDashes && !this.inWater;
    if (wantDash && this._dashCd <= 0 && this._dashTime <= 0 && (this.grounded || canAirDash || this.inWater)) {
      this._dashDir.copy(hasInput ? wish : _v4.set(Math.sin(this.facing), 0, Math.cos(this.facing))).setY(0).normalize();
      this._dashTime = this._dashLen;
      this._dashCd = 0.2;
      if (!this.grounded) this._airDashes++;
      this.velocity.y = this.grounded ? 2.0 : Math.max(this.velocity.y, -2);   // float the air-dash, don't nosedive
      this.onDash && this.onDash(this._dashDir.clone());
    }
    if (this._dashTime > 0) {
      this._dashTime -= dt;
      if (hasInput) this._dashDir.lerp(wish, Math.min(1, dt * 6)).normalize();   // steer with live input mid-dash
      const k = Math.max(0, this._dashTime / this._dashLen);   // 1 -> 0
      const dashSpeed = 22 + 24 * k;                           // punchy start, eases out
      this.velocity.x = this._dashDir.x * dashSpeed;
      this.velocity.z = this._dashDir.z * dashSpeed;
    }
    if (this.grounded || this.inWater) this._airDashes = 0;

    // ---- swimming ----
    this.inWater = !overLand && !frozen && feetY < waterY + 0.3;
    if (this.inWater) {
      this._airJumps = this._maxAirJumps;
      // buoyancy toward the surface with damping + bob
      const targetY = waterY - 0.35;
      const buoy = (targetY - feetY) * 42;
      this.velocity.y += (buoy - this.velocity.y * 6) * dt;
      const sp = this.swimSpeed;
      const tvx = wish.x * sp, tvz = wish.z * sp;
      this.velocity.x = THREE.MathUtils.damp(this.velocity.x, tvx, 5, dt);
      this.velocity.z = THREE.MathUtils.damp(this.velocity.z, tvz, 5, dt);
      if (input.justPressed('Space')) { this.velocity.y = 6.5; }
      this.grounded = false;
      this.state = hasInput ? 'swim' : 'tread';
    } else {
      // ---- gravity ----
      if (this._dashTime <= 0) this.velocity.y -= this.gravity * dt;
      this.velocity.y = Math.max(this.velocity.y, this.maxFall);

      // ---- horizontal accel ----
      const onGround = this.grounded;
      const maxSpeed = (sprint && hasInput ? this.runSpeed : this.walkSpeed) * this.speedMult;
      const slick = this._slick > 0 && onGround;
      const a = (onGround ? this.accel : this.airAccel) * (slick ? 0.16 : 1);   // ice patch: weak grip
      if (this._dashTime <= 0) {
        const tvx = wish.x * maxSpeed;
        const tvz = wish.z * maxSpeed;
        this.velocity.x += THREE.MathUtils.clamp(tvx - this.velocity.x, -a * dt, a * dt);
        this.velocity.z += THREE.MathUtils.clamp(tvz - this.velocity.z, -a * dt, a * dt);
        if (onGround && !hasInput) {
          const fr = Math.max(0, 1 - (slick ? 1.1 : this.friction) * dt);   // on ice you keep gliding
          this.velocity.x *= fr;
          this.velocity.z *= fr;
        }
      }

      // ---- jump ----
      this._coyote = onGround ? 0.12 : Math.max(0, this._coyote - dt);
      if (input.justPressed('Space')) this._jumpBuffer = 0.12;
      this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);

      if (this._jumpBuffer > 0 && this._coyote > 0) {
        this.velocity.y = this.jumpVel;
        this._jumpBuffer = 0;
        this._coyote = 0;
        this.grounded = false;
        this.onJump && this.onJump();
      } else if (input.justPressed('Space') && !onGround && this._airJumps > 0) {
        this._airJumps--;
        this.velocity.y = this.skyJumpVel;
        // small horizontal boost toward input
        if (hasInput) { this.velocity.x += wish.x * 3; this.velocity.z += wish.z * 3; }
        this.onSkyJump && this.onSkyJump(this.position.clone());
      }
    }

    // ---- integrate ----
    this.position.addScaledVector(this.velocity, dt);
    this.world.arena && this.world.arena.resolveWalls(this.position, this.radius);

    // ---- resolve ground ----
    if (!this.inWater) {
      const g2 = this.world.sampleGround(this.position.x, this.position.z, this.position.y);
      if (g2.onLand) {
        const snap = 0.5;
        if (this.position.y <= g2.height + 0.02 ||
            (this.velocity.y <= 0 && this.position.y - g2.height < snap && this.grounded)) {
          if (!this.grounded && this.velocity.y < -6) {
            this.onLand && this.onLand(-this.velocity.y);
            camera && camera.addShake(THREE.MathUtils.clamp(-this.velocity.y / 40, 0, 0.5));
          }
          this.position.y = g2.height;
          this.velocity.y = 0;
          this.grounded = true;
          this._airJumps = this._maxAirJumps;
        } else {
          this.grounded = false;
        }
      } else if (frozen) {
        // Hie Hie: stand on the frozen surface as if it were solid ground
        const surf = this._wave.height;
        if (this.position.y <= surf + 0.06 ||
            (this.velocity.y <= 0 && this.position.y - surf < 0.6)) {
          if (!this.grounded && this.velocity.y < -6) {
            this.onLand && this.onLand(-this.velocity.y);
            camera && camera.addShake(THREE.MathUtils.clamp(-this.velocity.y / 40, 0, 0.5));
          }
          this.position.y = surf;
          this.velocity.y = 0;
          this.grounded = true;
          this._airJumps = this._maxAirJumps;
          this.onFrozenWater = true;
        } else {
          this.grounded = false;
        }
      } else {
        // over open water but above surface -> falling; land on water = splash handled next frame
        this.grounded = false;
        if (this.position.y < (this.world.voidY ?? -8)) this.teleport(this.world.spawn);
      }
    }

    // ---- facing + speed ----
    const horiz = _v5.set(this.velocity.x, 0, this.velocity.z);
    const hs = horiz.length();
    this.speed01 = THREE.MathUtils.clamp(hs / this.runSpeed, 0, 1);

    let targetYaw = this.facing;
    let yawLambda = 14;
    if (this.faceLock > 0) {
      targetYaw = this.faceLockYaw;                // snap-face the aim during a cast
      yawLambda = 22;
    } else if (lockFace) {
      targetYaw = camera.yaw;                      // shiftlock / aim: face where the camera looks (was `+ Math.PI` — spun the character to face the camera, back-to-front)
      yawLambda = 18;
    } else if (hs > 0.6) {
      targetYaw = Math.atan2(horiz.x, horiz.z);
    }
    const prevFacing = this.facing;
    this.facing = _dampAngle(this.facing, targetYaw, yawLambda, dt);
    let dyaw = ((this.facing - prevFacing + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    this.turnRate = dt > 0 ? dyaw / dt : 0;
    this.groundSpeed = hs;

    // ---- footsteps ----
    if (this.grounded && hs > 1) {
      this._stepDist += hs * dt;
      const stride = sprint ? 2.4 : 1.8;
      if (this._stepDist > stride) {
        this._stepDist = 0;
        this.onStep && this.onStep();
      }
    }

    // ---- state for anim ----
    if (!this.inWater) {
      if (!this.grounded) this.state = this.velocity.y > 1 ? 'jump' : 'fall';
      else if (hs > this.walkSpeed * 0.9 && sprint) this.state = 'run';
      else if (hs > 0.6) this.state = 'walk';
      else this.state = 'idle';
    }

    // ---- push transform to the mesh ----
    this.obj.position.copy(this.position);
    this.obj.rotation.y = this.facing;
  }

  _detectDoubleTap(input, dt) {
    this._tap.fired = false;
    this._tap.t += dt;
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
      if (input.justPressed(code)) {
        if (this._tap.code === code && this._tap.t < 0.28) {
          this._tap.fired = true;
          this._tap.code = null;
        } else {
          this._tap.code = code;
          this._tap.t = 0;
        }
      }
    }
  }
}

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();

function _dampAngle(current, target, lambda, dt) {
  let diff = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * (1 - Math.exp(-lambda * dt));
}
