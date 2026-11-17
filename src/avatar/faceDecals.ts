// Cheek blush + nose highlight for procedural faces, drawn on conforming surface patches (like the decal
// eyes / mouth), placed automatically from the eye + mouth markers:
//   blush — soft pink ellipse on each cheek with optional anime diagonal hatch lines, MULTIPLIED onto the
//           skin (so it respects the cel shading underneath). Strength = rest amount + smile / happy /
//           cheek squint.
//   nose  — a small soft specular dot on the lit side of the nose (anime noses are just a highlight).
//           Needs both eyes + the mouth; skipped otherwise.

import * as THREE from 'three';
import type { BlushConfig, SurfaceMarker } from '../../shared/types.ts';
import { SKINNED_VERTEX_MAIN, SKINNED_VERTEX_PARS } from './shaderChunks.ts';
import { buildPatches, faceFrame, syncPatchMorphs } from './surfacePatch.ts';

export interface FaceDecalDrive { smile: number; happy: number; cheekSquint: number }

export interface FaceDecalOptions {
  eyeL: SurfaceMarker | null;
  eyeR: SurfaceMarker | null;
  mouth: SurfaceMarker | null;
  /** Eye size in WORLD units (the runtime pre-scales it). */
  eyeSize: number;
  blush: BlushConfig | null;
  nose: boolean;
}

const HAIR_RE = /hair|bang|fringe|ponytail|twintail/i;

const VERT = /* glsl */ `
  ${SKINNED_VERTEX_PARS}
  attribute vec2 patchUv; varying vec2 vP;
  void main() { vP = patchUv; ${SKINNED_VERTEX_MAIN} }`;

const BLUSH_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uAmt, uHatch, uSide;
  varying vec2 vP;
  float aa(float d) { float w = max(fwidth(d), 1e-5); return smoothstep(-w, w, d); }
  void main() {
    vec2 p = vP;                                   // blush units: ±1 across, ±0.58 tall
    float r = length(p / vec2(1.0, 0.58));
    float blush = (1.0 - smoothstep(0.3, 1.0, r)) * uAmt;
    // hatch: three short diagonal strokes (mirrored per cheek)
    vec2 h = vec2(p.x * uSide, p.y);
    float c = cos(1.1), s = sin(1.1);
    vec2 hr = vec2(c * h.x + s * h.y, -s * h.x + c * h.y);
    float k = hr.x / 0.27, cell = floor(k + 0.5), fx = (k - cell) * 0.27;
    float stroke = aa(0.03 * (1.0 - abs(hr.y) / 0.3) - abs(fx)) * aa(0.3 - abs(hr.y)) * step(abs(cell), 1.5);
    float hatch = stroke * uHatch * smoothstep(0.12, 0.45, uAmt);
    vec3 tint = mix(vec3(1.0), uColor, blush * 0.8);
    tint = mix(tint, uColor * vec3(0.78, 0.42, 0.48), hatch * 0.85);
    if (max(blush, hatch) < 0.003) discard;
    gl_FragColor = vec4(tint, 1.0);               // multiplied onto the skin (see blending)
    #include <colorspace_fragment>
  }`;

const NOSE_FRAG = /* glsl */ `
  uniform float uAmt;
  varying vec2 vP;
  void main() {
    float d = length((vP - vec2(0.35, 0.25)) / vec2(0.6, 1.0));
    float a = (1.0 - smoothstep(0.45, 1.0, d)) * uAmt;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(1.0), a);
    #include <colorspace_fragment>
  }`;

export class FaceDecals {
  readonly patches: THREE.Mesh[] = [];
  private blushMats: THREE.ShaderMaterial[] = [];
  private noseMat: THREE.ShaderMaterial | null = null;
  private rest = 0;

  constructor(meshes: THREE.Mesh[], modelRoot: THREE.Object3D, anchor: THREE.Object3D, o: FaceDecalOptions) {
    const skin = meshes.filter((m) => !HAIR_RE.test(m.name) && ![m.material].flat().some((x) => HAIR_RE.test(x.name)));
    modelRoot.updateWorldMatrix(true, true);
    const M = modelRoot.matrixWorld, inv = M.clone().invert();
    const toW = (m: SurfaceMarker) => new THREE.Vector3(...m.position).applyMatrix4(M);
    const nW = (m: SurfaceMarker) => new THREE.Vector3(...m.normal).transformDirection(M);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(anchor.getWorldQuaternion(new THREE.Quaternion()));
    const s = o.eyeSize;
    // project a guessed point onto the skin along a direction (from outside, toward the head)
    const ray = new THREE.Raycaster();
    const surfaceAt = (p: THREE.Vector3, n: THREE.Vector3): SurfaceMarker | null => {
      const reach = s * 5;
      ray.set(p.clone().addScaledVector(n, reach), n.clone().negate());
      ray.far = reach * 2;
      const hit = ray.intersectObjects(skin, false)[0];
      if (!hit?.face) return null;
      const hn = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      return { position: hit.point.clone().applyMatrix4(inv).toArray() as SurfaceMarker['position'], normal: hn.transformDirection(inv).toArray() as SurfaceMarker['normal'] };
    };
    const eyes = [o.eyeL, o.eyeR].filter((e): e is SurfaceMarker => !!e);
    const mid = eyes.length ? eyes.map(toW).reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / eyes.length) : null;
    const mouthW = o.mouth ? toW(o.mouth) : null;

    // --- blush ---
    const B = o.blush;
    if (B?.enabled && eyes.length) {
      this.rest = B.rest;
      const half = s * (B.size ?? 1.1);
      for (const [isLeft, eye, explicit] of [[true, o.eyeL, B.left], [false, o.eyeR, B.right]] as const) {
        let marker: SurfaceMarker | null = explicit ?? null;
        if (!marker && eye) {
          const e = toW(eye);
          const down = mouthW && mid ? mouthW.clone().sub(mid) : up.clone().multiplyScalar(-s * 2.6);
          const out = mid && eyes.length > 1 ? e.clone().sub(mid) : new THREE.Vector3();
          const guess = e.clone().addScaledVector(down, 0.58).addScaledVector(out, 0.42);
          const n = nW(eye).add(o.mouth ? nW(o.mouth) : nW(eye)).normalize();
          marker = surfaceAt(guess, n);
        }
        if (!marker) continue;
        const mat = new THREE.ShaderMaterial({
          name: 'vtp-blush',
          transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
          side: THREE.DoubleSide,
          blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
          blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
          blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
          uniforms: {
            uColor: { value: new THREE.Color(B.color) }, uAmt: { value: B.rest },
            uHatch: { value: B.hatch ? 1 : 0 }, uSide: { value: isLeft ? 1 : -1 },
          },
          vertexShader: VERT, fragmentShader: BLUSH_FRAG,
        });
        const frame = faceFrame(marker, modelRoot, anchor);
        const ps = buildPatches(skin, frame, { radius: half * 1.4, lift: s * 0.008, minFacing: 0.05, uvScale: half }, mat);
        for (const p of ps) { p.renderOrder = 1; p.name = p.name.replace(/_patch$/, '_blush'); }
        this.patches.push(...ps);
        this.blushMats.push(mat);
      }
    }

    // --- nose highlight: between the eyes and the mouth, 55% of the way down ---
    if (o.nose && o.eyeL && o.eyeR && mouthW && mid) {
      const guess = mid.clone().lerp(mouthW, 0.55);
      const n = nW(o.eyeL).add(nW(o.eyeR)).add(nW(o.mouth!)).normalize();
      const marker = surfaceAt(guess, n);
      if (marker) {
        this.noseMat = new THREE.ShaderMaterial({
          name: 'vtp-nose-highlight',
          transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
          side: THREE.DoubleSide,
          uniforms: { uAmt: { value: 0.85 } },
          vertexShader: VERT, fragmentShader: NOSE_FRAG,
        });
        const u = s * 0.12;
        const ps = buildPatches(skin, faceFrame(marker, modelRoot, anchor), { radius: u * 3, lift: s * 0.008, minFacing: 0.1, uvScale: u }, this.noseMat);
        for (const p of ps) p.name = p.name.replace(/_patch$/, '_nose');
        this.patches.push(...ps);
      }
    }
  }

  get hasBlush() { return this.blushMats.length > 0; }

  update(d: FaceDecalDrive) {
    const amt = THREE.MathUtils.clamp(this.rest + 0.55 * d.happy + 0.35 * d.cheekSquint + 0.2 * d.smile, 0, 1);
    for (const m of this.blushMats) m.uniforms.uAmt.value = Number.isFinite(amt) ? amt : this.rest;
    for (const p of this.patches) syncPatchMorphs(p); // follow the face's own shape keys (cheek puff / squint)
  }

  dispose() {
    for (const p of this.patches) { p.removeFromParent(); p.geometry.dispose(); }
    for (const m of this.blushMats) m.dispose();
    this.noseMat?.dispose();
  }
}
