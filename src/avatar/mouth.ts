// Procedural mouth for models that have none (or a sealed one).
//
// Two layers, both generated at load time from a single user-placed marker:
//  1. Skin morphs (style 'cavity'): real 3D deformation of the surrounding surface — jaw drop,
//     per-side smile, pucker, cheek puff — so the face moves around the mouth.
//  2. A conforming surface patch with an SDF shader that draws the mouth itself: lip line,
//     opening, interior, teeth, tongue — driven every frame by the 52 ARKit channels.
// Nothing touches the source topology, so it works on AI-generated "soup" meshes too.

import * as THREE from 'three';
import type { MouthConfig } from '../../shared/types.ts';
import { SKINNED_VERTEX_MAIN, SKINNED_VERTEX_PARS } from './shaderChunks.ts';
import { addGeneratedMorph, buildPatches, setMorph, syncPatchMorphs, type FaceFrame } from './surfacePatch.ts';
import { MouthInterior3D } from './mouth3d.ts';

const MORPHS = ['vtp_jawOpen', 'vtp_smileL', 'vtp_smileR', 'vtp_pucker', 'vtp_cheekPuff', 'vtp_frownL', 'vtp_frownR', 'vtp_jawSide'] as const;

export interface MouthDrive {
  open: number; wide: number; smileL: number; smileR: number; frownL: number; frownR: number;
  pucker: number; funnel: number; tongue: number; shift: number; upperUp: number; lowerDown: number;
  press: number; cheekPuff: number;
  jaw: number; stretchL: number; stretchR: number;
  /** Captured inner-lip contour (TrackingFrame.lips) and how much to trust it (0..1). */
  lips?: { u: number[]; l: number[] };
  capture?: number;
  fv?: number; sib?: number;
  /** Viseme extras: tongue tip raised to the upper teeth (L, N, D) and tongue tip between the teeth (TH). */
  tongueUp?: number; tongueTip?: number;
}

export class ProceduralMouth {
  readonly patches: THREE.Mesh[] = [];
  readonly material: THREE.ShaderMaterial;
  private morphMeshes: THREE.Mesh[] = [];
  private interior: MouthInterior3D | null = null;

  constructor(meshes: THREE.Mesh[], readonly frame: FaceFrame, readonly cfg: MouthConfig) {
    const w = cfg.width, h = cfg.openHeight, R = cfg.influence;
    const is3d = cfg.style === '3d';
    if (cfg.style === 'cavity' || is3d) this.buildMorphs(meshes, w, h, R);

    this.material = new THREE.ShaderMaterial({
      name: 'vtp-mouth',
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      extensions: { derivatives: true } as never,
      uniforms: {
        uOpen: { value: 0 }, uWide: { value: 0 }, uSmileL: { value: 0 }, uSmileR: { value: 0 },
        uFrownL: { value: 0 }, uFrownR: { value: 0 }, uPucker: { value: 0 }, uFunnel: { value: 0 },
        uTongue: { value: 0 }, uShift: { value: 0 }, uUpperUp: { value: 0 }, uLowerDown: { value: 0 }, uPress: { value: 0 },
        uJaw: { value: 0 }, uStretchL: { value: 0 }, uStretchR: { value: 0 },
        uCapU: { value: new Float32Array(7) }, uCapL: { value: new Float32Array(7) },
        uCapture: { value: 0 }, uCapScale: { value: (h / w) * 0.9 }, uFV: { value: 0 }, uSib: { value: 0 }, uTongueUp: { value: 0 }, uTongueTip: { value: 0 },
        uTongueOK: { value: cfg.showTongue ? 1 : 0 },
        uRest: { value: cfg.restCurve },
        uLine: { value: cfg.lineWidth / w },
        uOpenH: { value: (h / w) * (cfg.style === 'toon' ? 1.0 : 0.8) },
        uLip: { value: new THREE.Color(cfg.lipColor) },
        uInterior: { value: new THREE.Color(cfg.interiorColor) },
        uTongueC: { value: new THREE.Color(cfg.tongueColor) },
        uTeethC: { value: new THREE.Color(cfg.teethColor) },
        uShowTeeth: { value: cfg.showTeeth ? 1 : 0 },
        uShowTongue: { value: cfg.showTongue && !is3d ? 1 : 0 }, // 3D mode has a real tongue
      },
      vertexShader: /* glsl */ `
        ${SKINNED_VERTEX_PARS}
        attribute vec2 patchUv;
        varying vec2 vP;
        void main() {
          vP = patchUv;
          ${SKINNED_VERTEX_MAIN}
        }`,
      fragmentShader: MOUTH_FRAG,
      defines: is3d ? { VTP_3D: '' } : {},
    });
    const radius = w * 1.7 + h * 1.4;
    this.patches = buildPatches(meshes, frame, { radius, lift: w * 0.004, minFacing: 0.05, uvScale: w }, this.material);
    if (is3d) {
      const pass = (name: string, defines: Record<string, string>) => new THREE.ShaderMaterial({
        name,
        uniforms: this.material.uniforms, // shared → the hole always matches the drawn mouth
        vertexShader: this.material.vertexShader,
        fragmentShader: MOUTH_FRAG,
        defines,
        side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      });
      this.interior = new MouthInterior3D(frame, cfg, meshes, this.patches,
        pass('vtp-mouth-portal', { VTP_MASK: '' }), pass('vtp-mouth-punch', { VTP_MASK: '', VTP_PUNCH: '' }));
    }
  }

  private buildMorphs(meshes: THREE.Mesh[], w: number, h: number, R: number) {
    const { T, B, N } = this.frame;
    const ss = THREE.MathUtils.smoothstep;
    // gate out the back of the head / inner surfaces that fall inside the radius
    const front = (n: number) => 1 - ss(-n, 0.15 * R, 0.55 * R);
    const add = (name: string, radius: number, fn: (u: number, v: number, n: number, r: number) => THREE.Vector3 | null) => {
      for (const m of addGeneratedMorph(meshes, this.frame, name, radius, (d, u, v, n) => fn(u, v, n, d.length() / radius)))
        if (!this.morphMeshes.includes(m)) this.morphMeshes.push(m);
    };
    add('vtp_jawOpen', R, (u, v, n, r) => {
      const f = (1 - ss(r, 0.35, 1.0)) * front(n);
      const below = ss(-v, -0.02 * w, 0.45 * w); // 0 at the lip line, 1 below
      const fx = 1 - ss(Math.abs(u), 0.9 * w, 1.7 * w);
      const k = f * below * fx;
      if (k < 1e-4) return null;
      return B.clone().multiplyScalar(-h * 0.45 * k).addScaledVector(N, -h * 0.1 * k);
    });
    for (const [name, s] of [['vtp_smileL', 1], ['vtp_smileR', -1]] as const) {
      add(name, R, (u, v, n) => {
        const du = u - s * w;
        const g = Math.exp(-(du * du + v * v) / ((0.4 * w) ** 2)) * front(n);
        if (g < 1e-4) return null;
        return B.clone().multiplyScalar(0.12 * w * g).addScaledVector(T, s * 0.05 * w * g).addScaledVector(N, -0.03 * w * g);
      });
    }
    for (const [name, s] of [['vtp_frownL', 1], ['vtp_frownR', -1]] as const) {
      add(name, R, (u, v, n) => {
        const du = u - s * w;
        const g = Math.exp(-(du * du + (v + 0.1 * w) ** 2) / ((0.45 * w) ** 2)) * front(n);
        if (g < 1e-4) return null;
        return B.clone().multiplyScalar(-0.1 * w * g).addScaledVector(T, s * 0.02 * w * g);
      });
    }
    add('vtp_jawSide', R, (u, v, n, r) => {
      const below = ss(-v, -0.02 * w, 0.45 * w);
      const k = (1 - ss(r, 0.35, 1.0)) * front(n) * below;
      if (k < 1e-4) return null;
      return T.clone().multiplyScalar(0.18 * w * k);
    });
    add('vtp_pucker', R, (u, v, n) => {
      const g = Math.exp(-(u * u + v * v) / ((0.75 * w) ** 2)) * front(n);
      if (g < 1e-4) return null;
      return N.clone().multiplyScalar(0.16 * w * g).addScaledVector(T, -u * 0.25 * g).addScaledVector(B, -v * 0.15 * g);
    });
    add('vtp_cheekPuff', R * 2.2, (u, v, n) => {
      // cheeks balloon outward toward the silhouette (visible from the front) …
      const du = Math.abs(u) - 1.8 * w, dv = v - 0.05 * w;
      const gc = Math.exp(-(du * du + dv * dv) / ((0.9 * w) ** 2));
      // … and the throat / vocal sac under the mouth inflates (very froggy)
      const gt = Math.exp(-(u * u / ((1.3 * w) ** 2) + ((v + 1.1 * w) ** 2) / ((0.7 * w) ** 2)));
      const f = 1 - ss(-n, 0.2 * R, 0.9 * R);
      if ((gc + gt) * f < 1e-4) return null;
      return N.clone().multiplyScalar((0.22 * gc + 0.3 * gt) * w * f)
        .addScaledVector(T, Math.sign(u) * (0.3 * gc + 0.12 * gt * Math.min(1, Math.abs(u) / w)) * w * f)
        .addScaledVector(B, (0.04 * gc - 0.08 * gt) * w * f);
    });
  }

  update(d: MouthDrive) {
    const U = this.material.uniforms;
    // never let a NaN/undefined reach the shader — it corrupts the whole patch (long streak artifacts)
    for (const k in d) {
      const v = (d as unknown as Record<string, unknown>)[k];
      if (typeof v === 'number' && !Number.isFinite(v)) (d as unknown as Record<string, number>)[k] = 0;
    }
    if (d.lips && (d.lips.u.some((x) => !Number.isFinite(x)) || d.lips.l.some((x) => !Number.isFinite(x)))) d.lips = undefined;
    U.uOpen.value = d.open; U.uWide.value = d.wide; U.uSmileL.value = d.smileL; U.uSmileR.value = d.smileR;
    U.uFrownL.value = d.frownL; U.uFrownR.value = d.frownR; U.uPucker.value = d.pucker; U.uFunnel.value = d.funnel;
    U.uTongue.value = d.tongue; U.uShift.value = d.shift; U.uUpperUp.value = d.upperUp; U.uLowerDown.value = d.lowerDown;
    U.uPress.value = d.press; U.uJaw.value = d.jaw; U.uStretchL.value = d.stretchL; U.uStretchR.value = d.stretchR;
    if (d.lips && d.lips.u.length === 7) {
      (U.uCapU.value as Float32Array).set(d.lips.u); (U.uCapL.value as Float32Array).set(d.lips.l);
      U.uCapture.value = d.capture ?? 0.65;
    } else U.uCapture.value = 0;
    U.uFV.value = d.fv ?? 0; U.uSib.value = d.sib ?? 0;
    U.uTongueUp.value = Math.min(1, Math.max(0, d.tongueUp ?? 0)); U.uTongueTip.value = Math.min(1, Math.max(0, d.tongueTip ?? 0));
    for (const m of this.morphMeshes) {
      setMorph(m, 'vtp_jawOpen', d.open);
      setMorph(m, 'vtp_smileL', Math.max(0, d.smileL - d.frownL * 0.5));
      setMorph(m, 'vtp_smileR', Math.max(0, d.smileR - d.frownR * 0.5));
      setMorph(m, 'vtp_pucker', Math.max(d.pucker, d.funnel * 0.6));
      setMorph(m, 'vtp_cheekPuff', d.cheekPuff);
      setMorph(m, 'vtp_frownL', d.frownL); setMorph(m, 'vtp_frownR', d.frownR);
      setMorph(m, 'vtp_jawSide', d.jaw * d.open);
    }
    for (const p of this.patches) syncPatchMorphs(p);
    this.interior?.update({ open: d.open, tongue: d.tongue, fv: d.fv ?? 0, sib: d.sib ?? 0, jaw: d.jaw, round: Math.max(d.pucker, d.funnel), tongueUp: d.tongueUp ?? 0 });
  }

  dispose() {
    this.interior?.dispose();
    for (const p of this.patches) { p.removeFromParent(); p.geometry.dispose(); }
    this.material.dispose();
    for (const m of this.morphMeshes) for (const name of MORPHS) setMorph(m, name, 0);
  }
}

// Mouth drawn in mouth units: x = across (±1 at the resting corners, + = avatar-left), y = up.
// Each corner is positioned independently; lip curves use shape exponents so one parameter space
// covers the classic cartoon mouths: closed line, D-grin, shout, EE box, O, pucker, pressed lips.
const MOUTH_FRAG = /* glsl */ `
  uniform float uOpen, uWide, uSmileL, uSmileR, uFrownL, uFrownR, uPucker, uFunnel, uTongue, uShift;
  uniform float uUpperUp, uLowerDown, uPress, uRest, uLine, uOpenH, uShowTeeth, uShowTongue, uJaw, uStretchL, uStretchR;
  uniform float uCapU[7]; uniform float uCapL[7]; uniform float uCapture, uCapScale, uFV, uSib, uTongueUp, uTongueTip, uTongueOK;
  uniform vec3 uLip, uInterior, uTongueC, uTeethC;
  varying vec2 vP;

  float aa(float d) { float w = max(fwidth(d), 1e-4); return smoothstep(-w, w, d); }
  float prof(float t, float p, float e) { return pow(max(1.0 - pow(abs(t), p), 0.0), e); }
  // captured lip height at t (samples at t = -0.75..0.75 step 0.25, tapering to 0 at the corners)
  float capAt(float arr[7], float t) {
    float at = abs(t);
    if (at >= 1.0) return 0.0;
    float x = clamp((t + 0.75) / 0.25, 0.0, 6.0);
    int i = int(floor(min(x, 5.999)));
    float f = x - float(i);
    float v = 0.0;
    for (int k = 0; k < 6; k++) if (k == i) v = mix(arr[k], arr[k + 1], f);
    return v * (at > 0.75 ? (1.0 - at) / 0.25 : 1.0);
  }

  void main() {
    vec2 p = vP;
    float rnd = clamp(max(uPucker, uFunnel * 0.85), 0.0, 1.0);
    float smileMax = max(uSmileL, uSmileR);
    // rounding the lips or tucking them for F raises the lower lip — that's not a frown
    float noFrown = (1.0 - rnd) * (1.0 - uFV);
    float frownL = uFrownL * noFrown, frownR = uFrownR * noFrown;
    float frownMax = max(frownL, frownR);
    float wideMax = max(uStretchL, uStretchR);

    // corners
    // rounding narrows the mouth, but never past a small "o" (combined pucker+funnel used to invert it)
    float narrow = min(0.62 * uPucker + 0.4 * uFunnel, 0.68);
    float wl = max(1.0 + 0.30 * max(uWide, uStretchL) + 0.14 * uSmileL - narrow - 0.06 * uOpen, 0.3);
    float wr = max(1.0 + 0.30 * max(uWide, uStretchR) + 0.14 * uSmileR - narrow - 0.06 * uOpen, 0.3);
    vec2 cL = vec2(uShift + wl, uRest * 0.18 * (1.0 - rnd) + 0.26 * uSmileL - 0.3 * frownL - uOpen * 0.06);
    vec2 cR = vec2(uShift - wr, uRest * 0.18 * (1.0 - rnd) + 0.26 * uSmileR - 0.3 * frownR - uOpen * 0.06);
    float t = ((p.x - cR.x) / max(cL.x - cR.x, 1e-3)) * 2.0 - 1.0;
    float halfW = (cL.x - cR.x) * 0.5;
    float cornerY = mix(cR.y, cL.y, clamp((t + 1.0) * 0.5, 0.0, 1.0));
    // centre of the lip line stays put; a smile bows it slightly down, a frown slightly up
    float c0 = -smileMax * 0.05 + frownMax * 0.05 - uOpen * 0.04;
    float yMid = mix(c0, cornerY, t * t);

    // shape blend: grin (D), shout (inverted D), EE (box), round (O)
    float H = uOpen * uOpenH * (1.0 + 0.3 * uFunnel);
    float g = smileMax * smoothstep(0.05, 0.4, uOpen);
    float sh = frownMax * smoothstep(0.05, 0.4, uOpen);
    float ee = wideMax * (1.0 - rnd);
    float pU = mix(mix(mix(2.0, 5.0, g), 1.5, sh), 5.5, ee * 0.7);
    float pL = mix(mix(mix(1.7, 1.35, g), 4.5, sh), 5.0, ee * 0.7);
    pU = mix(pU, 2.0, rnd); pL = mix(pL, 2.0, rnd);
    float eU = mix(1.0, 0.5, rnd), eL = mix(0.8, 0.5, rnd);
    // round vowels: a real "o" — small for OO/pucker, bigger & taller for OH/funnel
    float minHole = uPucker * 0.14 + uFunnel * 0.2 * (0.5 + uOpen);
    float uAmt = max(H * (0.24 + 0.25 * sh - 0.14 * g), minHole) + uUpperUp * 0.07;
    float lAmt = max(H * (0.76 + 0.14 * g), minHole * 1.2) + uLowerDown * 0.05;
    float tl = t - uJaw * 0.35 * uOpen; // jaw slides the lower lip sideways
    float yU = yMid + uAmt * prof(t, pU, eU);
    float yL = yMid - lAmt * prof(tl, pL, eL);
    // captured lip contour: your actual mouth shape, scaled to the avatar. Gated by the fused open
    // amount so audio silence snaps it shut even while the camera frame lags.
    float gate = smoothstep(0.0, 0.22, uOpen + rnd * 0.4);
    float cw = uCapture * gate * (1.0 - smoothstep(0.25, 0.6, rnd));
    yU = mix(yU, yMid + max(capAt(uCapU, t), 0.0) * uCapScale + minHole * prof(t, 2.0, 0.5), cw);
    yL = mix(yL, yMid + min(capAt(uCapL, tl), 0.0) * uCapScale - minHole * 1.2 * prof(tl, 2.0, 0.5), cw);
    // F/V and S/SH. With teeth: F bares the upper teeth on the lower lip, S shows clenched teeth.
    // Toothless (frogs, birds, plushies): F = lower lip tucked up under an overhanging upper lip,
    // S = tight stretched slit with the tongue tip showing — no borrowed teeth.
    float hasT = step(0.5, uShowTeeth);
    // toothless F: the upper lip overhangs (bows down) onto the tucked lower lip
    float overhang = (1.0 - hasT) * uFV * 0.05 * prof(t * 1.1, 2.0, 1.0);
    yMid -= overhang;
    yU = mix(yU, yMid + mix(0.01, 0.16, hasT) * prof(t * 1.1, 3.0, 1.0), uFV);
    yL = mix(yL, yMid - mix(0.0, 0.02, hasT) * prof(t, 3.0, 1.0), uFV);
    yU = mix(yU, yMid + mix(0.04, 0.06, hasT) * prof(t, 4.0, 1.0), uSib * (1.0 - uFV));
    yL = mix(yL, yMid - mix(0.04, 0.06, hasT) * prof(t, 4.0, 1.0), uSib * (1.0 - uFV));

    float dLip = min(min(yU - p.y, p.y - yL), (1.0 - abs(t)) * halfW * 0.7);
    // round vowels (OO / OH / pucker): a true ellipse, not a pointed lens
    float roundK = smoothstep(0.2, 0.6, rnd);
    if (roundK > 0.0) {
      float ry = max((uAmt + lAmt) * 0.5, minHole);
      float rx = max(halfW * 0.92, ry * 0.8);
      vec2 ec = vec2(uShift + uJaw * 0.2 * uOpen, yMid + (uAmt - lAmt) * 0.5);
      vec2 qe = (p - ec) / vec2(rx, ry);
      float dEll = (1.0 - length(qe)) * min(rx, ry);
      dLip = mix(dLip, dEll, roundK);
      yU = mix(yU, ec.y + ry * sqrt(max(1.0 - pow((p.x - ec.x) / rx, 2.0), 0.0)), roundK);
      yL = mix(yL, ec.y - ry * sqrt(max(1.0 - pow((p.x - ec.x) / rx, 2.0), 0.0)), roundK);
    }
    float opening = H + minHole + uUpperUp * 0.02 + uFV * 0.05 + uSib * 0.05 + cw * max(capAt(uCapU, 0.0) - capAt(uCapL, 0.0), 0.0);
    float inside = step(0.003, opening) * aa(dLip);

    // lip line: tapered at the corners; pressed lips (M/B/P) get thick; pucker gets a thick ring
    float lw = uLine * (0.55 + 0.45 * (1.0 - t * t)) * (1.0 + 1.4 * uPress + 1.2 * uPucker);
    // anime line weight: the upper lip carries the bold stroke, the lower edge is lighter
    float upperEdge = step((yU + yL) * 0.5, p.y);
    lw *= mix(0.6, 1.0, max(upperEdge, 1.0 - step(0.003, H + minHole)));
    float lineMask = 1.0 - aa(abs(dLip) - lw * 0.5);
    lineMask *= aa((1.03 - abs(t)) * halfW);
    // toothless F: the tucked lower lip reads as a second, shorter lip fold just below the line
    float tuckY = yMid - 0.13 * prof(t * 1.15, 2.0, 1.0) + overhang * 0.5;
    float tuck = (1.0 - aa(abs(p.y - tuckY) - lw * 0.55)) * aa((0.85 - abs(t)) * halfW);
    lineMask = max(lineMask, tuck * uFV * (1.0 - hasT));

    // corner dimples + smile lines
    for (int s = -1; s <= 1; s += 2) {
      float fs = float(s);
      float sm = fs > 0.0 ? uSmileL : uSmileR;
      vec2 cp = fs > 0.0 ? cL : cR;
      vec2 q = p - cp;
      float tick = abs(length(q - vec2(-fs * 0.10, 0.02)) - 0.12) - lw * 0.35;
      float arcMask = step(0.0, fs * q.x) * step(-0.06, q.y) * step(q.y, 0.14);
      lineMask = max(lineMask, (1.0 - aa(tick)) * arcMask * smoothstep(0.3, 0.65, sm) * (1.0 - rnd));
      vec2 q2 = p - cp - vec2(fs * 0.22, 0.12);
      float cheek = abs(length(q2 - vec2(-fs * 0.3, -0.05)) - 0.3) - lw * 0.3;
      float cm = step(0.0, fs * q2.x) * step(-0.25, q2.y) * step(q2.y, 0.12);
      lineMask = max(lineMask, (1.0 - aa(cheek)) * cm * smoothstep(0.55, 0.9, sm) * 0.85);
    }

    // interior: darker toward the throat
    float depth = clamp((yU - p.y) / max(yU - yL, 1e-3), 0.0, 1.0);
    vec3 col = uInterior * mix(0.5, 1.0, depth) * mix(0.75, 1.0, abs(t));
    // anime teeth: ONE flat band tucked under the upper lip (never individual 3D teeth), inset from the
    // corners with rounded ends and a soft cool shadow where the lip overhangs; a thinner lower band shows
    // only when the mouth is wide (shout / grin / grimace)
    float teethOK = uShowTeeth; // toothless characters never sprout teeth
    float thU = 0.065 + H * 0.16 + (uFV + uSib) * 0.04;
    float bandU = yU - thU * prof(t / 0.86, 2.4, 0.55);
    float teethU = teethOK * aa(p.y - bandU) * inside * step(abs(t), 0.86);
    float thL = 0.035 + H * 0.07;
    float bandL = yL + thL * prof(tl / 0.66, 2.4, 0.55);
    float teethL = teethOK * aa(bandL - p.y) * inside * step(abs(tl), 0.66)
                 * smoothstep(0.4, 0.75, uOpen) * clamp(0.15 + max(g, max(sh, ee)), 0.0, 1.0);
    float teethShadow = 1.0 - 0.18 * (1.0 - smoothstep(0.0, thU * 0.45, yU - p.y));
    // clenched teeth for S fill the whole gap, with a faint bite line
    float teethS = max(uSib, uFV) * inside * hasT;
    // toothless S: the tongue tip fills the middle of the slit
    float tipS = uSib * (1.0 - hasT) * inside * aa(halfW * 0.32 - abs(p.x - uShift));
    // L / N / D: the tongue tip rises to the upper teeth (drawn under the flat teeth band, so the tip tucks
    // behind it); a tongue floor keeps it reading as a tongue rather than a blob
    float tuK = uTongueUp * uShowTongue * inside;
    if (tuK > 0.001) {
      float gapH = max(yU - yL, 0.02);
      vec2 lc = vec2(uShift + uJaw * 0.2 * uOpen, yL + gapH * 0.5);
      vec2 lr = vec2(halfW * 0.3, gapH * 0.5);
      float lT = aa((1.0 - length((p - lc) / lr)) * lr.y);
      vec2 fr = vec2(halfW * 0.62, gapH * 0.3 + 0.015);
      float lF = aa((1.0 - length((p - vec2(lc.x, yL)) / fr)) * fr.y);
      float lShade = clamp((p.y - yL) / gapH, 0.0, 1.0);
      col = mix(col, uTongueC * mix(0.8, 1.08, lShade), max(lT, lF) * tuK);
    }
    col = mix(col, uTeethC * mix(vec3(0.8, 0.82, 0.92), vec3(1.0), teethShadow), max(max(teethU, teethL), teethS));
    col = mix(col, uTeethC * 0.55, uSib * inside * (1.0 - aa(abs(p.y - yMid) - 0.004)));
    vec2 tc = vec2(uShift + uJaw * 0.2 * uOpen, yL - 0.02 - uTongue * 0.24);
    vec2 tr = vec2(halfW * 0.6, 0.05 + H * 0.36 + uTongue * 0.12);
    float tongueShape = aa((1.0 - length((p - tc) / tr)) * tr.y);
    float outK = smoothstep(0.25, 0.6, uTongue);
    float tongueIn = uShowTongue * tongueShape * inside * smoothstep(0.08, 0.35, uOpen) * (1.0 - rnd * 0.8) * (1.0 - outK);
    col = mix(col, uTongueC * mix(0.8, 1.05, clamp((p.y - tc.y) / tr.y + 0.5, 0.0, 1.0)), max(tongueIn, tipS));
    col = mix(col, uLip, lineMask);
    // TH: the tongue tip peeks out between the teeth, resting over the lower lip line
    float thK = uTongueTip * uTongueOK;
    float thTip = 0.0;
    if (thK > 0.001) {
      vec2 hc = vec2(uShift + uJaw * 0.2 * uOpen, yL + 0.012);
      vec2 hr = vec2(halfW * 0.3, 0.035 + 0.03 * thK);
      float dTh = (1.0 - length((p - hc) / hr)) * hr.y;
      thTip = aa(dTh) * thK * step(p.y, yU - lw * 0.5);
      float thEdge = (1.0 - aa(abs(dTh) - lw * 0.4)) * thTip;
      col = mix(col, uTongueC * mix(1.05, 0.85, clamp((hc.y - p.y) / hr.y * 0.5 + 0.5, 0.0, 1.0)), thTip);
      col = mix(col, mix(uTongueC * 0.45, uLip, 0.45), thEdge);
    }
    // ':P' tongue out: a rounded U-shaped tongue hanging OVER the lower lip (drawn after the lip line) with
    // a centre groove and a darker outline; the flat upper teeth band stays visible above it
    float tx = uShift + uJaw * 0.2 * uOpen;
    float tTop = yL + 0.07;                                            // root, inside the mouth
    float tTip = yL - (0.14 + 0.34 * uTongue) * (0.7 + 0.3 * outK);     // tip, hanging below the lip line
    float tw0 = halfW * 0.46;
    float tRy = min(tw0 * 0.9, (tTop - tTip) * 0.6);
    float tCy = tTip + tRy;
    float tw = tw0 * (1.0 + 0.1 * smoothstep(tTop, tCy, p.y));        // a touch fuller toward the tip
    float dT = p.y >= tCy ? tw - abs(p.x - tx) : (1.0 - length(vec2(p.x - tx, p.y - tCy) / vec2(tw, tRy))) * min(tw, tRy);
    dT = min(dT, tTop - p.y);
    float tVis = max(step(p.y, yL + lw * 0.5), inside) * step(p.y, yU - lw);
    float tOn = uShowTongue * outK * tVis;
    float tongueM = aa(dT) * tOn;
    float tongueEdge = (1.0 - aa(abs(dT) - lw * 0.42)) * tOn * step(p.y, tTop - lw);
    float gTip = mix(tTip, yL, 0.3);
    float groove = (1.0 - aa(abs(p.x - tx) - lw * 0.32 * smoothstep(gTip, gTip + 0.1, p.y))) * step(gTip, p.y) * step(p.y, yL + 0.03);
    float tShade = clamp((p.y - tTip) / max(tTop - tTip, 1e-3), 0.0, 1.0);
    vec3 tCol = uTongueC * mix(1.06, 0.8, tShade);
    tCol = mix(tCol, vec3(1.0), 0.35 * (1.0 - smoothstep(0.4, 1.0, length((p - vec2(tx - tw * 0.42, tCy - tRy * 0.1)) / vec2(tw * 0.22, tRy * 0.3)))));
    col = mix(col, tCol, tongueM);
    col = mix(col, uTongueC * 0.58, groove * tongueM);
    col = mix(col, mix(uTongueC * 0.42, uLip, 0.45), tongueEdge);
    float tongueOut = max(tongueM, tongueEdge);

#ifdef VTP_MASK
    // portal pass: carve the opening (stencil=1, depth → far) so the 3D interior shows through
    if (inside < 0.5) discard;
    gl_FragColor = vec4(0.0);
  #ifdef VTP_PUNCH
    gl_FragDepth = 1.0;
  #endif
    return;
#endif
#ifdef VTP_3D
    // the interior is real geometry behind the portal; this pass only draws lips + bared teeth
    float over = max(max(max(lineMask, max(max(teethU, teethL), teethS)), tipS), thTip);
    if (over < 0.01) discard;
    gl_FragColor = vec4(col, over);
    #include <colorspace_fragment>
    return;
#endif
    float alpha = max(max(max(inside, lineMask), tongueOut), thTip);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;
