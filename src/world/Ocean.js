import * as THREE from 'three';

/**
 * Stylised Gerstner ocean.
 *  - GPU: 4 summed Gerstner waves displace a follow-the-camera grid; fragment does
 *    depth gradient, sun specular, fresnel sky tint and crest foam.
 *  - CPU: sampleHeight()/sampleWave() reproduce the exact same sum for buoyancy.
 */

const WAVES = [
  // dirX, dirZ, steepness, wavelength, speed
  [1.0, 0.0, 0.20, 38, 7.2],
  [0.75, 0.66, 0.16, 21, 6.1],
  [-0.5, 0.85, 0.12, 12, 5.2],
  [0.2, -1.0, 0.08, 6.6, 4.4]
];
const GRAVITY = 9.81;

export class Ocean {
  constructor(scene, { size = 900, segments = 320 } = {}) {
    this.scene = scene;
    this.time = 0;
    this.size = size;

    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);

    // Pack wave params for the shader
    const dir = [], params = [];
    for (const [dx, dz, steep, wl, spd] of WAVES) {
      const d = new THREE.Vector2(dx, dz).normalize();
      dir.push(d.x, d.y);
      params.push(steep, wl, spd, (2 * Math.PI) / wl);
    }

    this.uniforms = {
      uTime: { value: 0 },
      uWaveDir: { value: dir },
      uWaveParams: { value: params },   // steepness, wavelength, speed, k
      uSunDir: { value: new THREE.Vector3(0.55, 0.42, 0.72).normalize() },
      uSunColor: { value: new THREE.Color(0xfff2d6) },
      uDeep: { value: new THREE.Color(0x0a3e6b) },
      uShallow: { value: new THREE.Color(0x1f95bf) },
      uFoam: { value: new THREE.Color(0xf4fcff) },
      uSkyTint: { value: new THREE.Color(0x5aa6e6) },
      uCameraPos: { value: new THREE.Vector3() },
      uFogColor: { value: new THREE.Color(0xbfe4ff) },
      uFogDensity: { value: 0.0016 }
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      fog: false,
      vertexShader: VERT,
      fragmentShader: FRAG
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    scene.add(this.mesh);
  }

  setSun(dir, color) {
    this.uniforms.uSunDir.value.copy(dir);
    if (color) this.uniforms.uSunColor.value.copy(color);
  }
  setFog(color, density) {
    this.uniforms.uFogColor.value.copy(color);
    this.uniforms.uFogDensity.value = density;
  }

  /** @returns {number} world-space water height at (x,z). */
  sampleHeight(x, z) {
    let y = 0;
    for (let i = 0; i < WAVES.length; i++) {
      const [dx, dz, steep, wl, spd] = WAVES[i];
      const d = _tmpDir.set(dx, dz).normalize();
      const k = (2 * Math.PI) / wl;
      const a = steep / k;
      const f = k * (d.x * x + d.y * z) + this.time * spd * Math.sqrt(GRAVITY * k) * 0.15;
      y += a * Math.cos(f);
    }
    return y;
  }

  /** Full wave sample: { height, normal }. */
  sampleWave(x, z, target = { height: 0, normal: new THREE.Vector3() }) {
    let y = 0, nx = 0, nz = 0;
    for (let i = 0; i < WAVES.length; i++) {
      const [dx, dz, steep, wl, spd] = WAVES[i];
      const d = _tmpDir.set(dx, dz).normalize();
      const k = (2 * Math.PI) / wl;
      const a = steep / k;
      const f = k * (d.x * x + d.y * z) + this.time * spd * Math.sqrt(GRAVITY * k) * 0.15;
      const c = Math.cos(f), s = Math.sin(f);
      y += a * c;
      nx -= d.x * k * a * s;
      nz -= d.y * k * a * s;
    }
    target.height = y;
    target.normal.set(-nx, 1, -nz).normalize();
    return target;
  }

  update(dt, elapsed, focusPos, cameraPos) {
    this.time = elapsed;
    this.uniforms.uTime.value = elapsed;
    if (focusPos) {
      // Snap the grid to a coarse lattice so vertices don't crawl under the camera.
      const step = this.size / 64;
      this.mesh.position.set(
        Math.round(focusPos.x / step) * step,
        0,
        Math.round(focusPos.z / step) * step
      );
    }
    if (cameraPos) this.uniforms.uCameraPos.value.copy(cameraPos);
  }
}

const _tmpDir = new THREE.Vector2();

const VERT = /* glsl */`
  precision highp float;
  uniform float uTime;
  uniform vec2 uWaveDir[4];
  uniform vec4 uWaveParams[4]; // steepness, wavelength, speed, k

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vCrest;   // 0..1 crest sharpness for foam
  varying float vViewDist;

  const float G = 9.81;

  void main() {
    vec3 pos = position;
    vec3 worldBase = (modelMatrix * vec4(position, 1.0)).xyz;

    vec3 disp = vec3(0.0);
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);
    float crest = 0.0;

    for (int i = 0; i < 4; i++) {
      vec2 d = normalize(uWaveDir[i]);
      float steep = uWaveParams[i].x;
      float k = uWaveParams[i].w;
      float a = steep / k;
      float spd = uWaveParams[i].z;
      float phase = k * dot(d, worldBase.xz) + uTime * spd * sqrt(G * k) * 0.15;
      float c = cos(phase);
      float s = sin(phase);

      disp.x += d.x * (a * c);
      disp.z += d.y * (a * c);
      disp.y += a * s;

      tangent += vec3(
        -d.x * d.x * (steep * s),
        d.x * (steep * c),
        -d.x * d.y * (steep * s)
      );
      binormal += vec3(
        -d.x * d.y * (steep * s),
        d.y * (steep * c),
        -d.y * d.y * (steep * s)
      );
      crest += steep * s;
    }

    vec3 newPos = vec3(worldBase.x + disp.x, disp.y, worldBase.z + disp.z);
    vNormal = normalize(cross(binormal, tangent));
    vWorldPos = newPos;
    vCrest = smoothstep(0.35, 0.95, crest * 0.9);

    vec4 mv = viewMatrix * vec4(newPos, 1.0);
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform vec3 uSunDir, uSunColor, uDeep, uShallow, uFoam, uSkyTint, uCameraPos, uFogColor;
  uniform float uTime, uFogDensity;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vCrest;
  varying float vViewDist;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }

  void main() {
    // perturb the Gerstner normal with a little high-freq detail so flat water lives
    vec3 N = normalize(vNormal);
    float nd = noise(vWorldPos.xz * 0.9 + uTime * 0.6) - noise(vWorldPos.xz * 0.9 - uTime * 0.55);
    float nd2 = noise(vWorldPos.xz * 2.7 - uTime * 0.9) - 0.5;
    N = normalize(N + vec3(nd * 0.22 + nd2 * 0.08, 0.0, nd * 0.18 - nd2 * 0.06));

    vec3 V = normalize(uCameraPos - vWorldPos);
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);

    float ndv = max(dot(N, V), 0.0);

    // Base water body: turquoise where we see into it, deep blue at grazing angles.
    float depthCue = pow(ndv, 0.6);
    float mott = noise(vWorldPos.xz * 0.025 + uTime * 0.015) * 0.5
               + noise(vWorldPos.xz * 0.08 - uTime * 0.02) * 0.5;
    vec3 water = mix(uDeep, uShallow, depthCue * 0.8 + mott * 0.2);
    water *= 0.9 + N.y * 0.15;                       // slope shading: crests lighter

    // Sky reflection — a *blue* reflection colour, capped so water never turns into sky.
    float fres = pow(1.0 - ndv, 5.0);
    water = mix(water, uSkyTint, clamp(fres, 0.0, 1.0) * 0.38);

    // Sun specular — tight stylised highlight + a sparse broken sparkle field.
    float spec = pow(max(dot(N, H), 0.0), 260.0);
    float sparkMask = step(0.78, noise(vWorldPos.xz * 0.8 + uTime * 0.6));
    float spark = sparkMask * pow(max(dot(N, H), 0.0), 90.0);
    water += uSunColor * (spec * 1.1 + spark * 0.4);

    // Crest foam — only on the sharpest crests, broken up by noise so it reads painted.
    float fn = noise(vWorldPos.xz * 0.4 + uTime * 0.3) * 0.6 + noise(vWorldPos.xz * 1.3 - uTime * 0.5) * 0.4;
    float foam = smoothstep(0.55, 0.95, vCrest) * smoothstep(0.4, 0.75, fn);
    water = mix(water, uFoam, clamp(foam, 0.0, 0.9));

    // Gentle distance fade to the horizon colour.
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vViewDist * vViewDist);
    water = mix(water, uFogColor, clamp(fogFactor * 0.9, 0.0, 0.85));

    gl_FragColor = vec4(water, 1.0);
  }
`;
