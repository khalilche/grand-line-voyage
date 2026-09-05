import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';

/**
 * Painterly stylised sky: gradient dome + soft sun disk + drifting fbm clouds.
 * Also owns the sun DirectionalLight and hemisphere fill, and exposes the
 * values the rest of the world needs (sun direction, horizon colour for fog).
 */
export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.sunDir = new THREE.Vector3(0.42, 0.66, 0.55).normalize();
    this.moonDir = this.sunDir.clone().negate();

    // ---- day/night cycle clock ----
    this.dayLength = 600;     // seconds for one full dawn->dusk->dawn cycle
    this._dayT = 0.28;        // start a little after dawn
    this.paused = false;      // set true to freeze the clock (e.g. in the arena)

    // ---- weather (rain darkens + thickens the sky; see setStormy) ----
    this._stormy = 0;         // 0..1, driven by World's weather system
    this._baseCloudCover = 0.6;
    this._lightning = 0;      // 0..1, decays every frame — a brief sky-wide flash

    const geo = new THREE.SphereGeometry(6000, 48, 32);
    this.uniforms = {
      uSunDir: { value: this.sunDir.clone() },
      uMoonDir: { value: this.moonDir.clone() },
      uTime: { value: 0 },
      uZenith: { value: new THREE.Color(0x1a5fc4) },
      uMid: { value: new THREE.Color(0x4c9ee6) },
      uHorizon: { value: new THREE.Color(0xa9d8f5) },
      uGround: { value: new THREE.Color(0x8fb9d8) },
      uSunColor: { value: new THREE.Color(0xffe9b8) },
      uMoonColor: { value: new THREE.Color(0xdfe8ff) },
      uCloud: { value: new THREE.Color(0xfdfeff) },
      uCloudShade: { value: new THREE.Color(0x93accb) },
      uCloudCover: { value: 0.6 },
      uStarBrightness: { value: 0 },   // 0 by day, ramps up at night
      uLightning: { value: 0 }
    };

    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vDir;
        uniform vec3 uSunDir, uMoonDir, uZenith, uMid, uHorizon, uGround, uSunColor, uMoonColor, uCloud, uCloudShade;
        uniform float uTime, uCloudCover, uStarBrightness, uLightning;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
                     mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
        }
        float fbm(vec2 p){
          float v = 0.0, a = 0.55;
          for (int i = 0; i < 6; i++){ v += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; }
          return v;
        }

        void main() {
          vec3 dir = normalize(vDir);
          float h = clamp(dir.y, -1.0, 1.0);
          float hu = clamp(h, 0.0, 1.0);

          // Three-stop vertical gradient (horizon -> mid -> zenith), saturated.
          vec3 sky = mix(uHorizon, uMid, smoothstep(0.0, 0.32, hu));
          sky = mix(sky, uZenith, smoothstep(0.28, 0.9, hu));
          sky = mix(sky, uGround, smoothstep(0.0, -0.25, h));

          // Sun: crisp disk + tight glow (no sky-wide wash)
          float sd = max(dot(dir, normalize(uSunDir)), 0.0);
          float disk = smoothstep(0.9986, 0.9993, sd);
          float glow = pow(sd, 320.0) * 0.5 + pow(sd, 44.0) * 0.10;
          sky += uSunColor * (disk * 3.2 + glow);
          // faint warm lift only right at the horizon toward the sun
          float sunAz = pow(max(dot(normalize(dir.xz), normalize(uSunDir.xz)), 0.0), 8.0);
          sky += uSunColor * smoothstep(0.12, 0.0, abs(h)) * sunAz * 0.10;

          // Moon: a soft pale disk, only really visible once the sun is down
          float nightK = smoothstep(0.15, -0.05, uSunDir.y);
          float md = max(dot(dir, normalize(uMoonDir)), 0.0);
          float moonDisk = smoothstep(0.9975, 0.999, md);
          float moonGlow = pow(md, 220.0) * 0.35;
          sky += uMoonColor * (moonDisk * 1.6 + moonGlow) * nightK;

          // Stars: a sparse hashed field above the horizon, fading in at night
          // and gently twinkling; hidden entirely below cloud cover.
          if (nightK > 0.02 && h > 0.05) {
            vec2 starUv = dir.xz / (h + 0.05) * 3.0;
            float cellId = hash(floor(starUv));
            float star = step(0.9915, cellId);
            float twinkle = 0.6 + 0.4 * sin(uTime * (2.0 + cellId * 6.0) + cellId * 40.0);
            sky += vec3(0.9, 0.95, 1.0) * star * twinkle * uStarBrightness * smoothstep(0.05, 0.3, h);
          }

          // Stylised cumulus — planar projection, defined edges, sun-lit tops.
          if (h > 0.02) {
            vec2 cuv = dir.xz / (h + 0.18);
            cuv *= 0.8;
            vec2 drift = vec2(uTime * 0.024, uTime * 0.009);
            float base = fbm(cuv * 1.0 + drift);
            float detail = fbm(cuv * 2.9 - drift * 1.7);
            float d = base * 0.72 + detail * 0.28;
            float mask = smoothstep(uCloudCover, uCloudCover + 0.10, d);
            float lit = smoothstep(0.32, 0.82, fbm(cuv * 1.5 + vec2(0.7) + drift));
            vec3 cloudCol = mix(uCloudShade, uCloud, lit);
            cloudCol += uSunColor * pow(sd, 12.0) * 0.3;
            float horizonFade = smoothstep(0.02, 0.12, h) * (1.0 - smoothstep(0.75, 1.0, hu) * 0.5);
            sky = mix(sky, cloudCol, mask * horizonFade * 0.95);
          }

          // lightning — a brief, near-white wash across the whole dome
          sky += vec3(0.85, 0.9, 1.0) * uLightning;

          gl_FragColor = vec4(sky, 1.0);
        }
      `
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    scene.add(this.mesh);

    // Lights
    this.sun = new THREE.DirectionalLight(0xfff1d4, 2.6);
    this.sun.castShadow = QUALITY.shadows;
    this.sun.shadow.mapSize.set(QUALITY.shadowMap, QUALITY.shadowMap);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 170;
    this.sun.shadow.camera.left = -46;
    this.sun.shadow.camera.right = 46;
    this.sun.shadow.camera.top = 46;
    this.sun.shadow.camera.bottom = -46;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xa9d8f5, 0x53744f, 0.7);
    scene.add(this.hemi);

    this.fill = new THREE.DirectionalLight(0x8fb6ff, 0.35);
    this.fill.position.copy(this.sunDir).multiplyScalar(-1);
    scene.add(this.fill);

    scene.fog = new THREE.FogExp2(0xbcdcf2, 0.00042);
    this._baseFogDensity = 0.00042;
    this._applySun();
    this.setTimeOfDay(this._dayT);
  }

  _applySun() {
    this.uniforms.uSunDir.value.copy(this.sunDir);
    this.uniforms.uMoonDir.value.copy(this.moonDir);
    this.sun.position.copy(this.sunDir).multiplyScalar(120);
    this.fill.position.copy(this.sunDir).multiplyScalar(-100);
  }

  /** t in [0,1): 0 = dawn, 0.5 = noon, ~0.85 = dusk, the rest is night. */
  setTimeOfDay(t) {
    this._dayT = ((t % 1) + 1) % 1;
    const ang = (this._dayT - 0.25) * Math.PI * 2;
    this.sunDir.set(Math.cos(ang) * 0.8, Math.sin(ang), 0.35).normalize();
    this.moonDir.copy(this.sunDir).negate();
    const noon = THREE.MathUtils.clamp(this.sunDir.y, 0, 1);
    const night = THREE.MathUtils.clamp(-this.sunDir.y, 0, 1);   // 0 at the horizon -> 1 at true midnight

    this.uniforms.uZenith.value.set(0x1a5fc4).lerp(new THREE.Color(0x0d1b3a), 1 - noon).lerp(new THREE.Color(0x03050f), night * 0.85);
    this.uniforms.uMid.value.set(0x4c9ee6).lerp(new THREE.Color(0x274a86), 1 - noon).lerp(new THREE.Color(0x0b1226), night * 0.85);
    this.uniforms.uHorizon.value.set(0xa9d8f5).lerp(new THREE.Color(0xff9d5c), (1 - noon) * 0.85).lerp(new THREE.Color(0x161d33), night * 0.8);
    this.uniforms.uSunColor.value.set(0xffe9b8).lerp(new THREE.Color(0xff7a3c), (1 - noon) * 0.7);
    this.uniforms.uStarBrightness.value = THREE.MathUtils.smoothstep(night, 0.05, 0.5);

    this.sun.intensity = 0.4 + noon * 2.4;
    this.hemi.intensity = Math.max(0.12, 0.25 + noon * 0.7 - night * 0.15);
    this.scene.fog.color.copy(this.uniforms.uHorizon.value);
    this._applySun();
  }

  /** 0..1 — how stormy it is right now (driven by World's rain cycle).
      Darkens/greys the sky and clouds, thickens fog, dims the sun a touch. */
  setStormy(amount) { this._stormy = THREE.MathUtils.clamp(amount, 0, 1); }

  /** a brief sky-wide lightning flash — call occasionally during heavy rain */
  flashLightning() { this._lightning = 1; }

  _applyStormy() {
    const s = this._stormy;
    this.uniforms.uCloudCover.value = THREE.MathUtils.lerp(this._baseCloudCover, 0.94, s);
    this.uniforms.uCloud.value.set(0xfdfeff).lerp(new THREE.Color(0x8b93a3), s);
    this.uniforms.uCloudShade.value.set(0x93accb).lerp(new THREE.Color(0x454c58), s);
    this.sun.intensity *= (1 - s * 0.55);
    this.hemi.intensity *= (1 - s * 0.35);
    this.scene.fog.density = this._baseFogDensity + s * 0.0009;
  }

  update(dt, elapsed, focus) {
    this.uniforms.uTime.value = elapsed;
    if (!this.paused) {
      this._dayT = (this._dayT + dt / this.dayLength) % 1;
      this.setTimeOfDay(this._dayT);
    }
    this._applyStormy();
    if (this._lightning > 0) {
      this._lightning = Math.max(0, this._lightning - dt * 2.6);
      this.uniforms.uLightning.value = this._lightning;
    }
    if (focus) {
      this.mesh.position.copy(focus);
      this.sun.target.position.copy(focus);
      this.sun.position.copy(focus).addScaledVector(this.sunDir, 120);
    }
  }
}
