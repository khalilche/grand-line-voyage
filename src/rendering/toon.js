import * as THREE from 'three';

/**
 * Stylised toon shading toolkit.
 *  - makeGradientMap: hard-stepped light ramp for cel banding
 *  - toonMaterial:    MeshToonMaterial + injected rim light + optional wrap
 *  - addOutline:      inverted-hull ink outline as a child mesh
 */

const _rampCache = new Map();

export function makeGradientMap(stops = 3, toe = 102) {
  const key = `${stops}_${toe}`;
  if (_rampCache.has(key)) return _rampCache.get(key);
  const data = new Uint8Array(stops * 4);
  for (let i = 0; i < stops; i++) {
    // `toe` = brightness floor of the darkest band (keeps shadowed colour alive)
    const t = stops === 1 ? 1 : i / (stops - 1);
    const v = Math.round(THREE.MathUtils.lerp(toe, 255, Math.pow(t, 0.9)));
    data[i * 4 + 0] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, stops, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _rampCache.set(key, tex);
  return tex;
}

/**
 * @param {object} o
 * @param {THREE.ColorRepresentation} o.color
 * @param {number} [o.stops=3]           cel bands
 * @param {THREE.ColorRepresentation} [o.rim]  rim/fresnel light colour
 * @param {number} [o.rimPower=2.5]
 * @param {number} [o.rimStrength=0.6]
 * @param {THREE.Texture} [o.map]
 * @param {boolean} [o.transparent]
 * @param {number} [o.emissiveIntensity=0]
 * @param {THREE.ColorRepresentation} [o.emissive]
 */
export function toonMaterial(o = {}) {
  const mat = new THREE.MeshToonMaterial({
    color: o.color ?? 0xffffff,
    gradientMap: makeGradientMap(o.stops ?? 3, o.toe ?? 102),
    map: o.map ?? null,
    transparent: !!o.transparent,
    opacity: o.opacity ?? 1,
    emissive: o.emissive ?? 0x000000,
    emissiveIntensity: o.emissiveIntensity ?? 1,
    fog: o.fog ?? true
  });

  const rim = new THREE.Color(o.rim ?? 0x9ec7ff);
  const rimPower = o.rimPower ?? 2.5;
  const rimStrength = o.rimStrength ?? 0.6;

  mat.userData.rim = { color: rim, power: { value: rimPower }, strength: { value: rimStrength } };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rim };
    shader.uniforms.uRimPower = mat.userData.rim.power;
    shader.uniforms.uRimStrength = mat.userData.rim.strength;

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uRimColor;
         uniform float uRimPower;
         uniform float uRimStrength;`
      )
      .replace(
        '#include <opaque_fragment>',
        `float rimDot = 1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
         float rimF = pow(rimDot, uRimPower) * uRimStrength;
         outgoingLight += uRimColor * rimF;
         #include <opaque_fragment>`
      );
  };

  return mat;
}

/**
 * Inverted-hull outline. Adds a slightly inflated back-faced dark shell.
 * Works on any mesh with a BufferGeometry that has normals.
 */
export function addOutline(mesh, { thickness = 0.0038, color = 0x0a0f1e } = {}) {
  if (!mesh.geometry) return null;
  const outlineMat = new THREE.ShaderMaterial({
    uniforms: { uThickness: { value: thickness }, uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */`
      uniform float uThickness;
      void main() {
        vec3 n = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // scale the shell by view depth -> near-constant screen-space outline width
        mv.xyz += n * uThickness * max(-mv.z, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }
    `,
    side: THREE.BackSide
  });
  const shell = new THREE.Mesh(mesh.geometry, outlineMat);
  shell.name = `${mesh.name || 'mesh'}__outline`;
  shell.castShadow = false;
  shell.receiveShadow = false;
  shell.frustumCulled = mesh.frustumCulled;
  mesh.add(shell);
  return shell;
}

/** Recursively outline every mesh in a group. */
export function outlineGroup(group, opts) {
  group.traverse((c) => {
    if (c.isMesh && !c.name.endsWith('__outline')) addOutline(c, opts);
  });
}
