import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { QUALITY } from '../core/quality.js';

/**
 * Owns the WebGLRenderer and the post-processing stack:
 *   scene -> RenderPass -> Bloom -> Grade (vignette + subtle chroma) -> SMAA -> Output
 * Tuned for a saturated, stylized "anime ocean" look.
 */
export class RenderSystem {
  constructor(mount) {
    this.mount = mount;

    const renderer = new THREE.WebGLRenderer({
      antialias: !QUALITY.post,    // post path uses SMAA; otherwise fall back to MSAA
      powerPreference: 'high-performance',
      stencil: false
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.pixelRatioCap));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = QUALITY.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this._scenePass = null; // set in setScene

    // Bloom — restrained; the ocean specular and VFX should glow, not the whole frame.
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.48,   // strength
      0.6,    // radius
      0.9     // threshold — only genuine highlights / VFX bloom
    );

    this.grade = new ShaderPass(GradeShader);
    this.smaa = new SMAAPass(window.innerWidth, window.innerHeight);
    this.output = new OutputPass();

    window.addEventListener('resize', () => this.setSize(window.innerWidth, window.innerHeight));
  }

  setScene(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.composer.passes.length = 0;
    this._scenePass = new RenderPass(scene, camera);
    this.composer.addPass(this._scenePass);
    if (QUALITY.bloom) this.composer.addPass(this.bloom);
    if (QUALITY.grade) this.composer.addPass(this.grade);
    this.composer.addPass(this.output);              // tone-map + sRGB
    if (QUALITY.smaa) this.composer.addPass(this.smaa); // AA on the final LDR image
    this.usePost = QUALITY.post && this.composer.passes.length > 2;
    this.setSize(window.innerWidth, window.innerHeight);
  }

  setSize(w, h) {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.grade.uniforms.uResolution.value.set(w * dpr, h * dpr);
  }

  /** brief full-screen tint/whiteout, e.g. a lightning strike. amount 0..1 */
  flash(amount = 0.6, color = 0xffffff) {
    this._flash = Math.min(1, (this._flash || 0) + amount);
    this.grade.uniforms.uFlashColor.value.set(color);
  }

  render(dt, elapsed) {
    this._flash = Math.max(0, (this._flash || 0) - dt * 4.5);
    this.grade.uniforms.uFlash.value = this._flash;
    if (this.usePost) {
      this.grade.uniforms.uTime.value = elapsed;
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose() {
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** Vignette + gentle warm/cool split + film grain. Keeps the frame from going flat. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 0.16 },
    uGrain: { value: 0.010 },
    uSaturation: { value: 1.14 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(0xffffff) }
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uSaturation;
    uniform float uFlash;
    uniform vec3 uFlashColor;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      // Saturation
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);

      // Warm highlights, cool shadows — very subtle
      col += (col - 0.5) * 0.03;
      col.r += (1.0 - l) * -0.01;
      col.b += (1.0 - l) * 0.02;

      // Vignette
      vec2 q = vUv - 0.5;
      float v = smoothstep(0.9, 0.15, dot(q, q) * 2.4);
      col *= mix(1.0, v, uVignette);

      // Grain
      float g = hash(vUv * uResolution + fract(uTime) * 100.0);
      col += (g - 0.5) * uGrain;

      // Ability flash (lightning etc.)
      col = mix(col, uFlashColor, clamp(uFlash, 0.0, 0.85));

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `
};
