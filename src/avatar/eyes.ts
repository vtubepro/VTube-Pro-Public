// Procedural eyes, placed by the user anywhere on the model (frog eyes on top of the head, cyclops,
// visor eyes…). Styles:
//   bulb / inset — sphere eyes with shader-drawn iris/pupil/highlight and eyelid shells that blink,
//                  squint, widen and tilt with emotion (angry/sad lids read even without brows).
//   decal        — flat cartoon/anime eyes drawn on a conforming surface patch.
//   led          — glowing screen eyes (robots): emissive shapes on a patch — shutter blink, ^^ happy,
//                  slanted angry / sad, wide surprise, a pixel grid and a soft glow halo.
//   anime        — modern gacha-style eyes on a patch: tall upturned almond, thick winged lash line with
//                  spikes, gradient iris (dark lid-shadowed top → glowing bottom) with streaks + limbal ring,
//                  star/heart/slit/round pupil, layered highlights, blue-grey lid shadow on the sclera.

import * as THREE from 'three';
import type { BrowConfig, EyeConfig, PupilShape, SurfaceMarker } from '../../shared/types.ts';
import { outlineMaterial } from './toon.ts';
import { SKINNED_VERTEX_MAIN, SKINNED_VERTEX_PARS } from './shaderChunks.ts';
import { buildPatches, faceFrame, syncPatchMorphs, type FaceFrame } from './surfacePatch.ts';
import { GooglyPupil, puppetEyeMaterial } from './puppetEyes.ts';
import { bulbDepthRange, clampEyeDepth } from '../../shared/eyeDepth.ts';
import { CENTER_SCALE_DEFAULT, centerMarker, effectiveLayout, sanitizeCenterScale } from '../../shared/eyeLayout.ts';

export interface EyeDrive {
  blinkL: number; blinkR: number;
  squintL: number; squintR: number;
  wideL: number; wideR: number;
  gazeYaw: number; gazePitch: number; // normalized −1..1 (+yaw = avatar-left, +pitch = down)
  angryL: number; angryR: number; sadL: number; sadR: number; surprise: number;
  happy: number;
  /** Brow channels (for floating brows). */
  browInnerUp: number; browDownL: number; browDownR: number; browOuterUpL: number; browOuterUpR: number;
}

/** Find the bone that dominates skinning nearest to a world point (the eye's parent). */
export function findAttachBone(meshes: THREE.Mesh[], p: THREE.Vector3): THREE.Object3D | null {
  let best: { d: number; mesh: THREE.Mesh; i: number } | null = null;
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    m.updateWorldMatrix(true, false);
    const step = Math.max(1, Math.floor(pos.count / 20000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const d = v.distanceToSquared(p);
      if (!best || d < best.d) best = { d, mesh: m, i };
    }
  }
  if (!best) return null;
  const sm = best.mesh as THREE.SkinnedMesh;
  if (!sm.isSkinnedMesh) return best.mesh;
  const si = sm.geometry.attributes.skinIndex, sw = sm.geometry.attributes.skinWeight;
  let bi = 0, bw = -1;
  for (let c = 0; c < 4; c++) { const w = sw.getComponent(best.i, c); if (w > bw) { bw = w; bi = si.getComponent(best.i, c); } }
  return sm.skeleton.bones[bi] ?? best.mesh;
}

const deg = THREE.MathUtils.degToRad;

class BulbEye {
  readonly group = new THREE.Group();
  readonly sclera: THREE.ShaderMaterial;
  readonly lid: THREE.ShaderMaterial;
  readonly outline: THREE.ShaderMaterial;
  brow: THREE.Mesh | null = null;
  private r: number;
  /** cfg.puppet 'googly': the loose pupil's physics */
  private googly: GooglyPupil | null = null;

  /** `center`: a single cyclops eye on the midline (symmetric lid tilts, driven by both sides). */
  constructor(readonly isLeft: boolean, cfg: EyeConfig, lidColor: THREE.Color, brows?: BrowConfig, readonly center = false) {
    const r = cfg.size;
    this.r = r;
    const irisAng = Math.asin(THREE.MathUtils.clamp(cfg.irisSize, 0.05, 0.95));
    this.sclera = new THREE.ShaderMaterial({
      name: 'vtp-eye',
      uniforms: {
        uGaze: { value: new THREE.Vector3(0, 0, 1) },
        uScleraC: { value: new THREE.Color(cfg.scleraColor) },
        uIrisC: { value: new THREE.Color(cfg.irisColor) },
        uIrisCos: { value: Math.cos(irisAng) },
        uPupilCos: { value: Math.cos(irisAng * cfg.pupilSize) },
        uPupilScale: { value: 1 },
        uHighlight: { value: cfg.highlight ? 1 : 0 },
        uLight: { value: new THREE.Vector3(0.4, 0.7, 0.6).normalize() },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir; varying vec3 vN;
        void main() {
          vDir = normalize(position);
          vN = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uGaze, uScleraC, uIrisC, uLight; uniform float uIrisCos, uPupilCos, uHighlight, uPupilScale;
        varying vec3 vDir; varying vec3 vN;
        float aa(float d) { float w = max(fwidth(d), 1e-5); return smoothstep(-w, w, d); }
        void main() {
          float c = dot(vDir, normalize(uGaze));
          vec3 col = uScleraC * mix(0.86, 1.0, smoothstep(-0.2, 0.9, c));
          float iris = aa(c - uIrisCos);
          float ring = smoothstep(uIrisCos, 1.0, c);
          vec3 irisC = mix(uIrisC * 0.55, uIrisC * 1.25 + 0.03, ring);
          col = mix(col, irisC, iris);
          col = mix(col, vec3(0.02), aa(c - cos(acos(uPupilCos) * uPupilScale)));
          // iris rim line
          col = mix(col, vec3(0.03), (1.0 - aa(abs(c - uIrisCos) - 0.004)) * 0.8);
          // highlights ride with the pupil, offset up-left like hand-drawn eyes
          vec3 g = normalize(uGaze);
          vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), g) + vec3(1e-4));
          vec3 up = cross(g, side);
          float ia = acos(uIrisCos);
          vec3 h1 = normalize(g * cos(ia * 0.45) + normalize(up * 0.8 + side * 0.6) * sin(ia * 0.45));
          vec3 h2 = normalize(g * cos(ia * 0.55) - normalize(up * 0.6 + side * 0.8) * sin(ia * 0.55));
          float hl = aa(dot(vDir, h1) - cos(ia * 0.2)) + 0.8 * aa(dot(vDir, h2) - cos(ia * 0.09));
          col = mix(col, vec3(1.0), clamp(hl, 0.0, 1.0) * uHighlight);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    // puppet eyes (felt / sock puppets, plush): same uniforms, different sclera
    if (cfg.puppet) { this.sclera.dispose(); this.sclera = puppetEyeMaterial(cfg.puppet, cfg); if (cfg.puppet === 'googly') this.googly = new GooglyPupil(); }
    this.lid = new THREE.ShaderMaterial({
      name: 'vtp-eyelid',
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: lidColor.clone() },
        uUpper: { value: deg(70) }, uLower: { value: deg(-70) },
        uAngry: { value: 0 }, uSad: { value: 0 }, uHappy: { value: 0 }, uInnerSign: { value: center ? 0 : isLeft ? -1 : 1 },
        uZMin: { value: -0.2 },
        uLight: { value: new THREE.Vector3(0.4, 0.8, 0.5).normalize() },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir; varying vec3 vN;
        void main() {
          vDir = normalize(position);
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor, uLight; uniform float uUpper, uLower, uAngry, uSad, uHappy, uInnerSign, uZMin;
        varying vec3 vDir; varying vec3 vN;
        float aa(float d) { float w = max(fwidth(d), 1e-5); return smoothstep(-w, w, d); }
        void main() {
          float el = asin(clamp(vDir.y, -1.0, 1.0));
          // + toward the nose (a centre eye: toward its middle, so angry / sad tilts come out symmetric)
          float xin = uInnerSign == 0.0 ? 0.55 - abs(vDir.x) * 1.6 : vDir.x * uInnerSign;
          // angry: lid drops and slants down toward the nose; sad: slants down toward the outside
          float up = uUpper - uAngry * (0.55 + 0.5 * xin) - uSad * (0.35 - 0.45 * xin);
          // lower lid curves up in the middle when squinting/happy (the "^^" look)
          float lo = uLower + uHappy * 0.35 * (1.0 - vDir.x * vDir.x);
          // opening: front-facing band between the lids
          float dOpen = min(min(up - el, el - lo), (vDir.z - uZMin) * 1.5);
          float open = aa(dOpen);
          if (open > 0.99) discard;
          float lit = dot(normalize(vN), uLight) > 0.1 ? 1.0 : 0.8;
          vec3 col = uColor * lit;
          // dark lid edge line
          float edge = 1.0 - aa(-dOpen - 0.06);
          col = mix(col, vec3(0.04), edge * step(uZMin, vDir.z + 0.2));
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.outline = outlineMaterial('#111111', 0.004);

    const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 32), this.sclera);
    const lidMesh = new THREE.Mesh(new THREE.SphereGeometry(r * 1.035, 48, 32), this.lid);
    const hull = new THREE.Mesh(new THREE.SphereGeometry(r * 1.035, 32, 24), this.outline);
    hull.visible = cfg.outline;
    for (const m of [ball, lidMesh, hull]) { m.userData.vtpGenerated = true; m.userData.vtpNoToon = true; }
    this.group.add(ball, lidMesh, hull);
    if (brows?.enabled) {
      // floating toon brow: a tapered arc hovering above the eye
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-0.75 * r, 0, 0), new THREE.Vector3(0, 0.22 * r, 0.12 * r), new THREE.Vector3(0.75 * r, 0, 0));
      const geo = new THREE.TubeGeometry(curve, 24, Math.max(brows.thickness, r * 0.08), 8, false);
      const brow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: brows.color }));
      brow.userData.vtpGenerated = true; brow.userData.vtpNoToon = true;
      brow.position.set(0, r * 1.28, r * 0.35);
      this.group.add(brow);
      this.brow = brow;
    }
  }

  updateBrow(innerUp: number, outerUp: number, down: number, angry: number, sad: number) {
    if (!this.brow) return;
    const r = this.r, inner = this.center ? 0 : this.isLeft ? -1 : 1;
    // big cartoon range: brows fly up on surprise, crash down on anger
    this.brow.position.y = r * (1.28 + 0.6 * Math.max(innerUp * 0.7, outerUp) - 0.4 * down);
    this.brow.rotation.z = inner * (sad * 0.6 + innerUp * 0.18 - angry * 0.7);
  }

  update(blink: number, squint: number, wide: number, gaze: THREE.Vector3, angry: number, sad: number, surprise: number, restOpen: number, happy = 0) {
    const meet = deg(-22);
    const upOpen = THREE.MathUtils.lerp(meet + deg(10), deg(78), restOpen) + deg(18) * Math.max(wide, surprise * 0.6);
    const loOpen = deg(-72);
    const U = this.lid.uniforms;
    U.uUpper.value = THREE.MathUtils.lerp(upOpen, meet, blink);
    // both lids travel to the meeting line on a blink; squints only raise the lower lid
    U.uLower.value = THREE.MathUtils.lerp(loOpen, meet - deg(1), Math.min(1, Math.max(blink, squint * 0.55 + blink * 0.3)));
    U.uAngry.value = angry; U.uSad.value = sad; U.uHappy.value = happy;
    this.sclera.uniforms.uPupilScale.value = THREE.MathUtils.clamp(1 - surprise * 0.45 - angry * 0.15 + happy * 0.2, 0.45, 1.3);
    this.sclera.uniforms.uGaze.value.copy(this.googly ? this.googly.step(gaze, this.group) : gaze);
  }

  setAspect(a: number) { this.outline.uniforms.uAspect.value = a; }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); ([] as THREE.Material[]).concat(m.material).forEach((x) => x.dispose()); } });
  }
}

class DecalEye {
  readonly material: THREE.ShaderMaterial;
  patches: THREE.Mesh[] = [];
  /** `lidRatio`: painted-eye replacement — lid ÷ skin (linear; 1 = the skin itself), see the lid pass below. */
  constructor(readonly isLeft: boolean, cfg: EyeConfig, meshes: THREE.Mesh[], frame: FaceFrame, readonly center = false, lidRatio: THREE.Color | null = null) {
    const led = cfg.style === 'led';
    this.material = new THREE.ShaderMaterial({
      name: led ? 'vtp-led-eye' : 'vtp-decal-eye',
      defines: led ? { VTP_LED: '' } : {},
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      uniforms: {
        uBlink: { value: 0 }, uSquint: { value: 0 }, uWide: { value: 0 }, uGaze: { value: new THREE.Vector2() },
        uAngry: { value: 0 }, uSad: { value: 0 }, uInner: { value: center ? 0 : isLeft ? -1 : 1 }, uRestOpen: { value: cfg.restOpen },
        uScleraC: { value: new THREE.Color(cfg.scleraColor) }, uIrisC: { value: new THREE.Color(cfg.irisColor) },
        uIris: { value: cfg.irisSize }, uPupil: { value: cfg.pupilSize }, uHighlight: { value: cfg.highlight ? 1 : 0 },
        uLine: { value: new THREE.Color('#141414') },
        uHappy: { value: 0 }, uSurprise: { value: 0 },
      },
      vertexShader: /* glsl */ `
        ${SKINNED_VERTEX_PARS}
        attribute vec2 patchUv; varying vec2 vP;
        void main() { vP = patchUv; ${SKINNED_VERTEX_MAIN} }`,
      fragmentShader: /* glsl */ `
        uniform float uBlink, uSquint, uWide, uAngry, uSad, uInner, uRestOpen, uIris, uPupil, uHighlight, uHappy, uSurprise;
        uniform vec2 uGaze; uniform vec3 uScleraC, uIrisC, uLine;
        varying vec2 vP;
        float aa(float d) { float w = max(fwidth(d), 1e-5); return smoothstep(-w, w, d); }
        #ifdef VTP_LED
        float rbox(vec2 q, vec2 b, float r) { vec2 d = abs(q) - b + r; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r; }
        void main() {
          vec2 p = vP;                          // eye units: ±1 across, + = avatar-left
          float xin = uInner == 0.0 ? 0.55 - abs(p.x) * 1.2 : p.x * uInner;  // + toward the nose (centre eye: its middle)
          vec2 q = p - vec2(uGaze.x * 0.34, -uGaze.y * 0.26);
          float open = clamp(uRestOpen + uWide * 0.22 + uSurprise * 0.3, 0.0, 1.35) * (1.0 - uBlink) * (1.0 - uSquint * 0.45);
          float rx = 0.46 + uSurprise * 0.12, ry = max(0.07, 0.58 * open);
          float d = rbox(q, vec2(rx, ry), min(rx, ry) * 0.85);                     // < 0 inside
          // ^^ happy: an arch
          vec2 aq = q - vec2(0.0, -0.28);
          float arch = max(abs(length(aq) - 0.5) - 0.12, -aq.y);
          d = mix(d, arch, clamp(uHappy * 1.4 - uBlink, 0.0, 1.0));
          // angry: lid slanting down toward the nose; sad: down toward the outside
          d = max(d, mix(-1.0, q.y - (ry - 0.62 * uAngry * (xin + 0.55)), step(0.02, uAngry)));
          d = max(d, mix(-1.0, q.y - (ry - 0.5 * uSad * (0.55 - xin)), step(0.02, uSad)));
          float core = aa(-d);
          float halo = exp(-max(d, 0.0) * 9.0) * 0.5 * (1.0 - core);
          vec2 g = abs(fract(p * 7.0) - 0.5);
          float cell = 1.0 - smoothstep(0.34, 0.5, max(g.x, g.y)) * 0.35;         // LED pixel grid
          float hot = aa(uIris * uPupil * 0.9 - length(q - vec2(0.0, ry * 0.15))) * (1.0 - uHappy);
          vec3 col = uIrisC * (1.25 * cell + 0.6 * hot);
          float hl = aa(0.09 - length(q - vec2(-0.2, ry * 0.55))) * uHighlight * core * (1.0 - uHappy);
          col = mix(col, vec3(1.0), hl * 0.8);
          float alpha = clamp(core + halo, 0.0, 1.0);
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(mix(uIrisC * 0.9, col, core), alpha);
          #include <colorspace_fragment>
        }
        #else
        void main() {
          vec2 p = vP; // eye units: ±1 across, + = avatar-left
          float xin = uInner == 0.0 ? 0.55 - abs(p.x) * 1.2 : p.x * uInner;
          float shape = 1.0 - length(p / vec2(1.0, 0.72));
          float openAmt = clamp(uRestOpen + uWide * 0.2, 0.0, 1.2) * (1.0 - uBlink);
          float up = mix(-0.08, 0.72, openAmt) * (1.0 - p.x * p.x * 0.55) - uAngry * 0.35 * (xin + 0.3) + uSad * 0.3 * (xin - 0.2);
          float lo = mix(-0.62, -0.1, clamp(uSquint * 0.7 + uBlink * 0.4, 0.0, 1.0)) * (1.0 - p.x * p.x * 0.5);
          float d = min(shape * 0.72, min(up - p.y, p.y - lo));
          float inside = aa(d);
          vec2 ic = vec2(uGaze.x * 0.42, -uGaze.y * 0.3);
          float ir = uIris * 1.1;
          float irisD = ir - length(p - ic);
          vec3 col = uScleraC;
          col = mix(col, mix(uIrisC * 0.5, uIrisC * 1.2, clamp((p.y - ic.y) / ir * -0.5 + 0.5, 0.0, 1.0)), aa(irisD));
          col = mix(col, vec3(0.02), aa(ir * uPupil * 0.6 - length(p - ic)));
          float hl = aa(ir * 0.28 - length(p - ic - vec2(-0.28, 0.3) * ir)) + aa(ir * 0.12 - length(p - ic - vec2(0.3, -0.35) * ir));
          col = mix(col, vec3(1.0), clamp(hl, 0.0, 1.0) * uHighlight);
          // lash line (thick upper, thin lower)
          float lash = 1.0 - aa(abs(up - p.y) - 0.07 * (1.0 - abs(p.x) * 0.5));
          float lowerLine = 1.0 - aa(abs(p.y - lo) - 0.02);
          float lineMask = max(lash * aa(shape * 0.72 + 0.1), lowerLine * inside * 0.0 + lowerLine * aa(shape * 0.72) * 0.7);
          float alpha = max(inside, lineMask);
          if (alpha < 0.01) discard;
          col = mix(col, uLine, lineMask);
          gl_FragColor = vec4(col, alpha);
          #include <colorspace_fragment>
        }
        #endif`,
    });
    const anime = cfg.style === 'anime';
    if (anime) {
      this.material.name = 'vtp-anime-eye';
      this.material.fragmentShader = ANIME_EYE_FRAG;
      Object.assign(this.material.uniforms, animeEyeUniforms(cfg));
    }
    this.patches = buildPatches(meshes, frame, { radius: cfg.size * (anime ? 1.75 : 1.6), lift: cfg.size * 0.01, minFacing: 0.05, uvScale: cfg.size }, this.material);
    // painted-eye replacement: a second pass over the same patch paints the lid (the area the rest-open eye covers
    // and the current lids don't) by MULTIPLYING the lit skin underneath by lid / skin (1 = auto colour: only the
    // lid's rounding shade), so the lid keeps the face's own cel shading, shadows and rim light (an unlit flat
    // colour would glow in shadow)
    if (lidRatio && !led) {
      this.material.uniforms.uLidRatio = { value: lidRatio.clone() };
      this.lidMaterial = new THREE.ShaderMaterial({
        name: 'vtp-eyelid-tint',
        uniforms: this.material.uniforms,               // shared: the drive uniforms update both passes
        vertexShader: this.material.vertexShader,
        fragmentShader: anime ? ANIME_LID_FRAG : DECAL_LID_FRAG,
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide,
        // dst × (2 × src): src = 0.5 leaves the skin untouched, src = ratio / 2 recolours it
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor,
      });
      for (const p of this.patches) {
        const twin = twinPatch(p, this.lidMaterial);
        twin.renderOrder = 2;
        p.renderOrder = 3;           // eye (with its lash line) over the lid
        this.lidPatches.push(twin);
      }
    }
  }
  lidMaterial: THREE.ShaderMaterial | null = null;
  lidPatches: THREE.Mesh[] = [];
}

/** A second mesh over a patch's geometry with another material (same skeleton binding, same parent). */
function twinPatch(p: THREE.Mesh, mat: THREE.Material): THREE.Mesh {
  let m: THREE.Mesh;
  if ((p as THREE.SkinnedMesh).isSkinnedMesh) { const sp = new THREE.SkinnedMesh(p.geometry, mat); sp.bind((p as THREE.SkinnedMesh).skeleton, (p as THREE.SkinnedMesh).bindMatrix); m = sp; }
  else m = new THREE.Mesh(p.geometry, mat);
  m.name = `${p.name}_lid`;
  Object.assign(m.userData, { vtpGenerated: true, vtpNoToon: true, source: p.userData.source });
  m.position.copy(p.position); m.quaternion.copy(p.quaternion); m.scale.copy(p.scale);
  m.frustumCulled = false;
  m.morphTargetInfluences = p.morphTargetInfluences;   // (shared array: rides the same face shapes)
  m.morphTargetDictionary = p.morphTargetDictionary;
  p.parent?.add(m);
  return m;
}

/** This eye's value of a per-side channel. A centre (cyclops) eye follows both: mostly the stronger side, so a real
 *  blink closes it fully and a wink still reads (0.7), while one-sided noise barely moves it. */
function side(e: { isLeft: boolean; center: boolean }, l: number, r: number): number {
  return e.center ? Math.max(l, r) * 0.7 + Math.min(l, r) * 0.3 : e.isLeft ? l : r;
}

/** Move a frame's centre onto the model's outer surface along its normal (vertices within a narrow cylinder around
 *  the normal line; the frontmost wins). `span` = eye distance in world units (search size). Rest pose. */
function projectToSurface(frame: FaceFrame, meshes: THREE.Mesh[], span: number, rad = Math.max(span * 0.12, 1e-4), reach = Math.max(span * 1.2, 1e-3)) {
  const v = new THREE.Vector3(), d = new THREE.Vector3();
  let best = -Infinity;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    m.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      d.subVectors(v, frame.c);
      const along = d.dot(frame.N);
      if (along < -reach || along > reach) continue;
      if (d.lengthSq() - along * along > rad * rad) continue;
      if (along > best) best = along;
    }
  }
  if (Number.isFinite(best)) frame.c.addScaledVector(frame.N, best);
  return Number.isFinite(best) ? best : null;
}

const SNAP_SKIP = /hair|bang|fringe|ponytail|twintail|ahoge|brow|glass|goggle|visor|mask/i;

/** Where the generated eyes go: one entry per eye (layout-aware: one side only, or one centre eye). `cfg` comes back
 *  with a centre eye's size scaled. Sizes in world units (the runtime pre-scales them). Rest pose. */
export function eyeSpots(meshes: THREE.Mesh[], modelRoot: THREE.Object3D, anchor: THREE.Object3D, cfg: EyeConfig, snap = false): { cfg: EyeConfig; spots: { isLeft: boolean; isCenter: boolean; frame: FaceFrame }[] } {
  const layout = effectiveLayout(cfg.layout, 'procedural');
  let sides: [boolean, SurfaceMarker | null, boolean][] = [[true, layout === 'right' ? null : cfg.left, false], [false, layout === 'left' ? null : cfg.right, false]];
  if (layout === 'center') {
    const cm = centerMarker(cfg.left, cfg.right);
    sides = cm ? [[true, cm, true]] : [];
    cfg = { ...cfg, size: cfg.size * (sanitizeCenterScale(cfg.centerScale) ?? CENTER_SCALE_DEFAULT) };
  }
  const spots: { isLeft: boolean; isCenter: boolean; frame: FaceFrame }[] = [];
  for (const [isLeft, marker, isCenter] of sides) {
    if (!marker) continue;
    const frame = faceFrame(marker, modelRoot, anchor);
    // the midpoint of two eye markers lies inside a curved face: put the centre eye back onto the surface
    if (isCenter && cfg.left && cfg.right) projectToSurface(frame, meshes, new THREE.Vector3(...cfg.left.position).distanceTo(new THREE.Vector3(...cfg.right.position)) * modelRoot.getWorldScale(new THREE.Vector3()).x);
    // painted-eye replacement: the eye must sit ON the painted face — a marker left hovering in front of it or sunk
    // into it (placed for the model's own eyes) is moved onto the skin along its normal (hair / glasses skipped; the
    // model's hidden eye parts are already out of `meshes`)
    else if (snap) projectToSurface(frame, meshes.filter((m) => ![m.name, ...([] as THREE.Material[]).concat(m.material).map((x) => x?.name ?? '')].some((n) => SNAP_SKIP.test(n))), 0, cfg.size * 0.6, cfg.size * 8);
    spots.push({ isLeft, isCenter, frame });
  }
  return { cfg, spots };
}

export interface ProceduralEyesOptions {
  /** Painted-eye replacement (shared/bakedEyes.ts): per eye (eyeSpots order) the measured skin around it (linear).
   *  The eyelid defaults to it; a custom lidColor tints the lit skin by lidColor ÷ this. */
  bakedSkin?: (THREE.Color | null)[];
}

export class ProceduralEyes {
  private bulbs: BulbEye[] = [];
  private decals: DecalEye[] = [];
  private gaze = new THREE.Vector3();
  /** Painted-eye replacement: the auto eyelid colour per eye (sRGB hex, the skin around it), for the Face tab. */
  autoLid: (string | null)[] = [];

  /** `cfg` sizes must already be in world units (the runtime pre-scales them). */
  constructor(meshes: THREE.Mesh[], modelRoot: THREE.Object3D, anchor: THREE.Object3D, readonly cfg: EyeConfig, skinColor: THREE.Color, brows?: BrowConfig, opts: ProceduralEyesOptions = {}) {
    const placed = eyeSpots(meshes, modelRoot, anchor, cfg, !!opts.bakedSkin);
    cfg = placed.cfg;
    this.cfg = cfg;
    const baked = opts.bakedSkin;
    this.autoLid = baked ? baked.map((c) => (c ? '#' + c.getHexString() : null)) : [];
    placed.spots.forEach(({ isLeft, isCenter, frame }, k) => {
      // eyelid: the chosen colour, else the skin around this eye (replacement) / at the marker
      const skin = baked?.[k] ?? null;
      const lidColor = cfg.lidColor ? new THREE.Color(cfg.lidColor) : skin ?? skinColor;
      if (cfg.style === 'decal' || cfg.style === 'led' || cfg.style === 'anime') {
        // (replacement: the lid pass always runs — auto colour = ratio 1, it then only adds the lid's rounding)
        const ratio = baked ? (cfg.lidColor && skin ? lidRatio(new THREE.Color(cfg.lidColor), skin) : new THREE.Color(1, 1, 1)) : null;
        this.decals.push(new DecalEye(isLeft, cfg, meshes, frame, isCenter, ratio));
        return;
      }
      const eye = new BulbEye(isLeft, cfg, lidColor, brows, isCenter);
      const protrusion = cfg.style === 'inset' ? Math.min(cfg.protrusion, 0.3) : cfg.protrusion;
      const center = frame.c.clone().addScaledVector(frame.N, cfg.size * (2 * protrusion - 1));
      const bone = findAttachBone(meshes, frame.c) ?? modelRoot;
      bone.updateWorldMatrix(true, false);
      bone.add(eye.group);
      eye.group.position.copy(bone.worldToLocal(center.clone()));
      // eye depth (setDepth): slides the whole eye along the marker normal, in the bone's own space
      eye.group.userData.depthBase = eye.group.position.clone();
      eye.group.userData.depthDir = bone.worldToLocal(center.clone().add(frame.N)).sub(eye.group.position);
      // eye-local axes = avatar axes at rest (so gaze "forward" is the character's forward)
      const bq = bone.getWorldQuaternion(new THREE.Quaternion());
      const aq = anchor.getWorldQuaternion(new THREE.Quaternion());
      eye.group.quaternion.copy(bq.invert().multiply(aq));
      // cancel bone scale so eyes stay round at the configured (world-unit) size
      const ws = bone.getWorldScale(new THREE.Vector3());
      eye.group.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
      eye.group.userData.baseScale = eye.group.scale.clone();
      eye.group.name = isCenter ? 'vtp_eye_C' : isLeft ? 'vtp_eye_L' : 'vtp_eye_R';
      this.bulbs.push(eye);
    });
    this.setDepth(cfg.depth ?? 0);
  }

  /** Eye depth in WORLD units (the runtime scales profile.eyes.depth): in (−) / out (+) along the face normal,
   *  clamped so the eyeball neither sinks fully into the head nor floats off it. Painted eyes ignore it. */
  setDepth(d: number) {
    const v = clampEyeDepth(d, bulbDepthRange(this.cfg.size, this.cfg.protrusion, this.cfg.style));
    for (const e of this.bulbs) {
      const b = e.group.userData.depthBase as THREE.Vector3 | undefined, dir = e.group.userData.depthDir as THREE.Vector3 | undefined;
      if (b && dir) e.group.position.copy(b).addScaledVector(dir, v);
    }
  }

  /** Cartoon squash & stretch amount (0 = off). */
  cartoon = 1;

  update(d: EyeDrive) {
    // eyes POP on surprise / wide, squash a touch on blinks and big smiles
    const pop = 1 + this.cartoon * (0.2 * Math.max(d.surprise, (d.wideL + d.wideR) * 0.5));
    for (const e of this.bulbs) {
      const b = e.group.userData.baseScale as THREE.Vector3 | undefined;
      if (!b) continue;
      const blink = side(e, d.blinkL, d.blinkR);
      const sq = 1 - this.cartoon * (0.08 * blink + 0.06 * d.happy);
      e.group.scale.set(b.x * pop * (2 - sq), b.y * pop * sq, b.z * pop);
    }
    const range = THREE.MathUtils.degToRad(this.cfg.gazeRange);
    const yaw = d.gazeYaw * range, pitch = d.gazePitch * range * 0.75;
    this.gaze.set(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    // resting scowl (grumpy characters): the lids keep an angry tilt, released by surprise / joy
    const rest = (this.cfg.restAngry ?? 0) * (1 - Math.max(d.surprise, d.happy));
    const angry = (a: number) => Math.max(a, rest);
    for (const e of this.bulbs) {
      e.update(side(e, d.blinkL, d.blinkR), side(e, d.squintL, d.squintR), side(e, d.wideL, d.wideR), this.gaze,
        angry(side(e, d.angryL, d.angryR)), side(e, d.sadL, d.sadR), d.surprise, this.cfg.restOpen, d.happy);
      e.updateBrow(d.browInnerUp, side(e, d.browOuterUpL, d.browOuterUpR), side(e, d.browDownL, d.browDownR), side(e, d.angryL, d.angryR), side(e, d.sadL, d.sadR));
    }
    for (const e of this.decals) {
      // decal patches ride the face's own shape keys (ARKit models: a scowl presses the drawn lid, a smile lifts it)
      for (const p of e.patches) syncPatchMorphs(p);   // (lid twins share the patch's influence array)
      const U = e.material.uniforms;
      U.uBlink.value = side(e, d.blinkL, d.blinkR); U.uSquint.value = side(e, d.squintL, d.squintR);
      U.uWide.value = Math.max(side(e, d.wideL, d.wideR), d.surprise * 0.6);
      U.uAngry.value = angry(side(e, d.angryL, d.angryR)); U.uSad.value = side(e, d.sadL, d.sadR);
      U.uGaze.value.set(d.gazeYaw, d.gazePitch);
      U.uHappy.value = d.happy; U.uSurprise.value = d.surprise;
    }
  }

  setAspect(a: number) { for (const e of this.bulbs) e.setAspect(a); }

  dispose() {
    for (const e of this.bulbs) e.dispose();
    for (const e of this.decals) {
      for (const p of [...e.patches, ...e.lidPatches]) p.removeFromParent();
      for (const p of e.patches) p.geometry.dispose();   // (a lid twin draws its patch's geometry)
      e.material.dispose();
      e.lidMaterial?.dispose();
    }
  }
}

/** Lid tint for the multiply pass: lid ÷ skin per channel (linear), clamped to what dst × 2·src can express. */
function lidRatio(lid: THREE.Color, skin: THREE.Color): THREE.Color {
  const r = (a: number, b: number) => THREE.MathUtils.clamp(a / Math.max(b, 0.004), 0, 2);
  return new THREE.Color(r(lid.r, skin.r), r(lid.g, skin.g), r(lid.b, skin.b));
}

// ---------------------------------------------------------------- 'anime' eyes

const PUPIL_SHAPES: Record<PupilShape, number> = { round: 0, star: 1, heart: 2, slit: 3 };

/** Default bottom-glow colour: a brighter, slightly more saturated version of the iris colour. */
export function autoIrisGlow(hex: string): string {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(hex).getHSL(hsl);
  return '#' + new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.05 + 0.1), Math.min(0.85, hsl.l + 0.32)).getHexString();
}

function animeEyeUniforms(cfg: EyeConfig): Record<string, THREE.IUniform> {
  return {
    uIrisC2: { value: new THREE.Color(cfg.irisColor2 || autoIrisGlow(cfg.irisColor)) },
    uLashC: { value: new THREE.Color(cfg.lashColor || '#1b1116') },
    uWing: { value: cfg.lashWing ?? 0.7 },
    uLashW: { value: cfg.lashThickness ?? 1 },
    uLowerLash: { value: cfg.lowerLash ?? 0.7 },
    uPupilShape: { value: PUPIL_SHAPES[cfg.pupilShape ?? 'star'] ?? 1 },
    uPupilC: { value: new THREE.Color(cfg.pupilColor || '#000000') },
    uPupilGlow: { value: cfg.pupilColor ? 1 : 0 },
  };
}

// Eye units: ±1 across (+ = avatar-left), y up. Same drive uniforms as the decal eye (blink, squint, wide,
// gaze, angry/sad lid tilt, happy ^^ arch, surprise, rest openness; restAngry arrives through uAngry).
const ANIME_EYE_COMMON = /* glsl */ `
  uniform float uBlink, uSquint, uWide, uAngry, uSad, uInner, uRestOpen, uIris, uPupil, uHighlight, uHappy, uSurprise;
  uniform vec2 uGaze; uniform vec3 uScleraC, uIrisC, uLine;
  uniform vec3 uIrisC2, uLashC;
  uniform float uWing, uLashW, uLowerLash, uPupilShape;
  uniform vec3 uPupilC; uniform float uPupilGlow;
  varying vec2 vP;
  float aa(float d) { float w = max(fwidth(d), 1e-5); return smoothstep(-w, w, d); }
  // tapered stroke from a (radius ra) to b (radius rb); < 0 inside
  float taper(vec2 p, vec2 a, vec2 b, float ra, float rb) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - mix(ra, rb, h);
  }
  // asymmetric lid profiles over u = 0 (inner corner) .. 1 (outer corner), peak = 1
  float fU(float u) { u = clamp(u, 1e-4, 1.0); return pow(u, 0.55) * pow(max(1.0 - u, 0.0), 0.75) / 0.4125; }
  float fL(float u) { u = clamp(u, 1e-4, 1.0); return pow(u, 1.1) * pow(max(1.0 - u, 0.0), 0.55) / 0.3498; }
  float dot2(vec2 v) { return dot(v, v); }
  float sdHeart(vec2 p) {
    p.x = abs(p.x);
    if (p.y + p.x > 1.0) return sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
    return sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
  }
  vec4 over(vec4 dst, vec3 c, float a) { float na = a + dst.a * (1.0 - a); return vec4((c * a + dst.rgb * dst.a * (1.0 - a)) / max(na, 1e-4), na); }

  const float XI = -0.92, XO = 1.0;          // inner / outer corner (xo units)
  float gOpen, gArch, gTilt, gSq, gBlink;
  float xAt(float u) { return XI + (XO - XI) * u; }
  float baseAt(float u) { return mix(-0.06, 0.1, clamp(u, 0.0, 1.0)); }
  float closedAt(float u) { float b = baseAt(u); return mix(b - 0.16 * fU(u), b + 0.3 * fU(u), gArch); }  // relaxed ∪ … happy ∩
  float lowerAt(float u) { return mix(baseAt(u) - 0.6 * fL(u), closedAt(u), max(gSq, max(gBlink, gArch))); }
  float upperAt(float u) {
    float xin = -xAt(u);
    float y = mix(closedAt(u), baseAt(u) + 0.76 * fU(u), gOpen);
    y -= gTilt * (uAngry * 0.4 * (xin + 0.3) - uSad * 0.3 * (xin - 0.2));  // angry: down to the nose; sad: down outside
    return max(y, lowerAt(u));
  }
  float lashTh(float u) { return uLashW * mix(0.045, 0.17, smoothstep(0.0, 0.85, u)); }

`;
const ANIME_EYE_FRAG = ANIME_EYE_COMMON + /* glsl */ `
  void main() {
    vec2 p = vP / (1.0 + 0.1 * uSurprise);     // eye units: ±1 across, + = avatar-left
    // + toward the OUTER corner; a centre (cyclops) eye folds at its middle: both ends are outer corners
    float xo = uInner == 0.0 ? -0.1136 + abs(p.x) * 1.1136 : -p.x * uInner;
    float u = (xo - XI) / (XO - XI);            // 0 inner corner .. 1 outer corner
    gArch = clamp((uHappy - 0.5) * 2.5, 0.0, 1.0) * (1.0 - smoothstep(0.3, 0.7, uSurprise));
    gOpen = clamp(uRestOpen + uWide * 0.25 + uSurprise * 0.2, 0.0, 1.3) * (1.0 - uBlink) * (1.0 - gArch);
    gTilt = smoothstep(0.0, 0.35, gOpen);
    gSq = clamp(uSquint * 0.6, 0.0, 1.0);
    gBlink = uBlink;

    // --- lids (upturned almond: outer corner higher than the inner one) ---
    float yU = upperAt(u), yL = lowerAt(u);
    float inU = step(0.0, u) * step(u, 1.0);
    float inside = aa(min(yU - p.y, p.y - yL)) * inU;

    // --- sclera: soft blue-grey shadow under the upper lid, darker toward the corners ---
    float lidSh = 1.0 - smoothstep(0.0, 0.34, yU - p.y);
    vec3 col = mix(uScleraC, uScleraC * vec3(0.7, 0.75, 0.9), lidSh * 0.85);
    col *= mix(0.88, 1.0, smoothstep(0.0, 0.22, min(u, 1.0 - u)));
    col = mix(col, vec3(0.96, 0.68, 0.7), (1.0 - smoothstep(0.0, 0.09, u)) * 0.55);  // inner-corner pink

    // --- iris: tall oval, dark lid-shadowed top -> glowing bottom, radial streaks, limbal ring ---
    float pupScale = clamp(1.0 - uSurprise * 0.4 - uAngry * 0.12 + uHappy * 0.12, 0.5, 1.25);
    vec2 rI = vec2(uIris * 1.22, uIris * 1.56);
    vec2 ic = vec2(-0.04 * uInner + uGaze.x * 0.36, -uGaze.y * 0.24 - 0.01);
    vec2 q = (p - ic) / rI;
    float r = length(q);
    float irisM = aa((1.0 - r) * rI.x);
    vec3 ci = mix(uIrisC2, uIrisC, smoothstep(-0.85, 0.05, q.y));
    ci = mix(ci, uIrisC * 0.3, smoothstep(0.0, 0.8, q.y));
    float ang = atan(q.x, q.y);
    float s1 = sin(ang * 27.0 + sin(ang * 9.0) * 1.7) * 0.5 + 0.5, s2 = sin(ang * 13.0 + 1.3) * 0.5 + 0.5;
    float band = smoothstep(0.22, 0.48, r) * (1.0 - smoothstep(0.84, 0.96, r));
    ci *= 1.0 + (s1 * 0.24 + s2 * 0.12 - 0.18) * band;
    float glow = smoothstep(0.15, 0.75, -q.y) * (1.0 - smoothstep(0.62, 0.95, r)) * smoothstep(0.2, 0.5, r);
    ci += uIrisC2 * glow * 0.5;
    ci = mix(ci, uIrisC * 0.16, smoothstep(0.8, 0.98, r));                 // limbal ring
    // pupil: 0 round, 1 star (4-point), 2 heart, 3 slit
    float pr = uPupil * 0.5 * pupScale;
    float dPup;
    if (uPupilShape < 0.5) dPup = (r - pr) * rI.x;
    else if (uPupilShape < 1.5) { vec2 s = abs(q) / vec2(pr * 0.95, pr * 1.2); float e = 0.55; dPup = (pow(pow(s.x, e) + pow(s.y, e), 1.0 / e) - 1.0) * pr * rI.x; }
    else if (uPupilShape < 2.5) dPup = sdHeart(q / (pr * 1.5) + vec2(0.0, 0.55)) * pr * 1.5 * rI.x;
    else dPup = (length(q / vec2(0.3, 1.3)) - pr) * rI.x * 0.3;
    vec3 pupC = mix(mix(uLashC, uIrisC * 0.12, 0.5), uPupilC, uPupilGlow);
    // soft halo around the pupil: dark for a normal pupil, a bright bloom for a glowing one
    float halo = 1.0 - smoothstep(0.0, pr * rI.x * 0.9, dPup);
    ci = mix(ci * (1.0 - 0.28 * halo), ci + uPupilC * 0.45 * halo, uPupilGlow);
    ci = mix(ci, pupC, aa(-dPup));
    ci *= mix(1.0, mix(0.62, 0.85, uPupilGlow), lidSh);                    // upper-lid shadow over the iris
    col = mix(col, ci, irisM);

    // --- highlights: one big upper-left + small secondaries (same side on both eyes, ride the iris) ---
    vec2 h1 = ic + vec2(-0.36, 0.34) * rI, h2 = ic + vec2(0.36, -0.44) * rI, h3 = ic + vec2(-0.08, 0.12) * rI;
    float hl = aa((1.0 - length((p - h1) / (vec2(0.27, 0.3) * rI))) * rI.x * 0.27);
    hl = max(hl, aa((1.0 - length((p - h2) / (vec2(0.12) * rI.x))) * rI.x * 0.12));
    hl = max(hl, 0.85 * aa((1.0 - length((p - h3) / (vec2(0.06) * rI.x))) * rI.x * 0.06));
    col = mix(col, vec3(1.0), hl * uHighlight);

    vec4 o = vec4(col, inside);

    // --- upper lash line: thin at the inner corner, thick toward the outer corner ---
    vec2 pq = vec2(xo, p.y);
    float th = lashTh(u);
    float slope = clamp((upperAt(u + 0.01) - upperAt(u - 0.01)) / (0.02 * (XO - XI)), -2.5, 2.5);
    float dy = abs(p.y - (yU + th * 0.22));
    float dl = dy / sqrt(1.0 + slope * slope);                           // perpendicular-ish distance
    float lash = aa(th * 0.5 - dl) * step(dy, th * 1.6 + 0.02) * smoothstep(0.0, 0.04, u) * (1.0 - smoothstep(0.98, 1.03, u));
    // winged flick past the outer corner
    float w = uWing;
    float uA = 0.95;
    vec2 wa = vec2(xAt(uA), upperAt(uA) + lashTh(uA) * 0.1);
    vec2 wtip = vec2(XO + 0.34 * w, baseAt(1.0) + 0.05 + 0.08 * w - 0.06 * uSad + 0.03 * uAngry);
    float wing = aa(-taper(pq, wa, wtip, lashTh(uA) * 0.6, 0.0)) * step(0.02, w);
    // a few lash spikes on the outer upper edge
    float spikes = 0.0;
    for (int k = 0; k < 3; k++) {
      float uk = 0.6 + 0.14 * float(k);
      vec2 bk = vec2(xAt(uk), upperAt(uk) + lashTh(uk) * 0.55);
      vec2 dir = normalize(vec2(0.45 + 0.35 * float(k), 1.0 - 0.3 * float(k)));
      float len = (0.12 + 0.04 * float(k)) * (0.4 + 0.6 * w) * mix(0.7, 1.0, clamp(gOpen, 0.0, 1.0));
      spikes = max(spikes, aa(-taper(pq, bk, bk + dir * len, 0.03 * uLashW, 0.0)));
    }
    float lashM = max(lash, max(wing, spikes));
    // double-eyelid crease (faint)
    float yCr = mix(baseAt(u) + 0.76 * fU(u), yU, 0.5) + 0.2 + 0.03 * fU(u);
    float crease = aa(0.009 - abs(p.y - yCr)) * smoothstep(0.3, 0.45, u) * (1.0 - smoothstep(0.93, 1.0, u)) * smoothstep(0.35, 0.75, gOpen) * 0.45;
    // lower lash accent on the outer third + one small spike
    float thl = 0.022 * smoothstep(0.55, 0.85, u);
    float lower = aa(thl * 0.5 - abs(p.y - (yL - thl * 0.3))) * (1.0 - smoothstep(0.97, 1.02, u));
    float us = 0.86;
    vec2 ls = vec2(xAt(us), lowerAt(us) - 0.006);
    lower = max(lower, aa(-taper(pq, ls, ls + vec2(0.07, -0.08), 0.012, 0.0)));
    lower *= smoothstep(0.15, 0.5, gOpen) * uLowerLash * step(0.5, u) * step(u, 1.05);
    vec3 lowC = mix(uLashC, vec3(0.36, 0.18, 0.2), 0.35);

    o = over(o, uLashC, crease);
    o = over(o, lowC, lower * 0.9);
    o = over(o, uLashC, lashM);
    if (o.a < 0.01) discard;
    gl_FragColor = o;
    #include <colorspace_fragment>
  }
`;
const ANIME_LID_FRAG = ANIME_EYE_COMMON + /* glsl */ `
  // painted-eye replacement, custom eyelid colour: the lid = what the rest-open eye covers and the current lids don't
  // (blink, squint, the ^^ smile arch, an angry / sad drop). Output for the dst × 2·src multiply blend.
  uniform vec3 uLidRatio;
  void main() {
    vec2 p = vP / (1.0 + 0.1 * uSurprise);
    float xo = uInner == 0.0 ? -0.1136 + abs(p.x) * 1.1136 : -p.x * uInner;
    float u = (xo - XI) / (XO - XI);
    float inU = step(0.0, u) * step(u, 1.0);
    // rest-open eye (no blink, squint, smile arch or brow tilt)
    gArch = 0.0; gSq = 0.0; gBlink = 0.0; gTilt = 0.0;
    gOpen = clamp(uRestOpen + uWide * 0.25 + uSurprise * 0.2, 0.0, 1.3);
    float in0 = aa(min(upperAt(u) - p.y, p.y - lowerAt(u))) * inU;
    // the eye now (same as the eye pass)
    gArch = clamp((uHappy - 0.5) * 2.5, 0.0, 1.0) * (1.0 - smoothstep(0.3, 0.7, uSurprise));
    gOpen = clamp(uRestOpen + uWide * 0.25 + uSurprise * 0.2, 0.0, 1.3) * (1.0 - uBlink) * (1.0 - gArch);
    gTilt = smoothstep(0.0, 0.35, gOpen);
    gSq = clamp(uSquint * 0.6, 0.0, 1.0);
    gBlink = uBlink;
    float yU1 = upperAt(u), yL1 = lowerAt(u);
    float in1 = aa(min(yU1 - p.y, p.y - yL1)) * inU;
    float a = in0 * (1.0 - in1);
    if (a < 0.004) discard;
    // a rounded lid: a soft shade just above the lash line (the lid curving in under the lashes), a lighter one over
    // the lower lid — so a closed eye reads as an eyelid, not a flat patch
    float shade = p.y > yU1 ? mix(0.8, 1.0, smoothstep(0.0, 0.3, p.y - yU1)) : mix(0.9, 1.0, smoothstep(0.0, 0.14, yL1 - p.y));
    gl_FragColor = vec4(uLidRatio * shade, 1.0);
    #include <colorspace_fragment>
    gl_FragColor = vec4(mix(vec3(0.5), gl_FragColor.rgb * 0.5, a), 1.0);
  }
`;

// the plain painted ('decal') eye's lid, same idea (its lid curves: see the decal fragment shader above)
const DECAL_LID_FRAG = /* glsl */ `
  uniform float uBlink, uSquint, uWide, uAngry, uSad, uInner, uRestOpen, uHappy, uSurprise;
  uniform vec3 uLidRatio;
  varying vec2 vP;
  float aa(float d) { float w = max(fwidth(d), 1e-5); return smoothstep(-w, w, d); }
  void main() {
    vec2 p = vP;
    float xin = uInner == 0.0 ? 0.55 - abs(p.x) * 1.2 : p.x * uInner;
    float shape = 1.0 - length(p / vec2(1.0, 0.72));
    float open0 = clamp(uRestOpen + uWide * 0.2, 0.0, 1.2);
    float up0 = mix(-0.08, 0.72, open0) * (1.0 - p.x * p.x * 0.55);
    float lo0 = -0.62 * (1.0 - p.x * p.x * 0.5);
    float in0 = aa(min(shape * 0.72, min(up0 - p.y, p.y - lo0)));
    float openAmt = open0 * (1.0 - uBlink);
    float up = mix(-0.08, 0.72, openAmt) * (1.0 - p.x * p.x * 0.55) - uAngry * 0.35 * (xin + 0.3) + uSad * 0.3 * (xin - 0.2);
    float lo = mix(-0.62, -0.1, clamp(uSquint * 0.7 + uBlink * 0.4, 0.0, 1.0)) * (1.0 - p.x * p.x * 0.5);
    float in1 = aa(min(shape * 0.72, min(up - p.y, p.y - lo)));
    float a = in0 * (1.0 - in1);
    if (a < 0.004) discard;
    float shade = p.y > up ? mix(0.8, 1.0, smoothstep(0.0, 0.3, p.y - up)) : mix(0.9, 1.0, smoothstep(0.0, 0.14, lo - p.y));
    gl_FragColor = vec4(uLidRatio * shade, 1.0);
    #include <colorspace_fragment>
    gl_FragColor = vec4(mix(vec3(0.5), gl_FragColor.rgb * 0.5, a), 1.0);
  }
`;
