// Render pipeline for the studio preview + OBS output: MSAA HDR scene target (+ its depth) → optional depth passes
// (half-res ambient occlusion, background depth of field, glossy-floor screen-space reflections), selective
// (threshold) bloom, quarter-res light shafts → final composite (AO, DOF, SSR, glowing haze, grade + LUT, vignette,
// bloom + shafts, sRGB encode) that PRESERVES ALPHA for transparent OBS output → optional SMAA (or FXAA).
// Optional third-party passes (both keep the alpha contract): N8AO (N8python/n8ao, CC0) instead of the built-in SSAO —
// it only produces the AO term; the final pass applies it (performers protected, far fade) exactly like the built-in
// one — and SMAA (pmndrs/postprocessing's edge-detection + weights materials, Zlib) on the final LDR image, blended
// in PREMULTIPLIED space (the final pass writes premultiplied sRGB into its LDR target while SMAA runs), so silhouettes
// over OBS content never gain dark fringes and the OBS hole stays clear.
//
// Alpha: the scene target is cleared to transparent black and every material blends with three's default
// (SRC_ALPHA, ONE_MINUS_SRC_ALPHA / ONE, ONE_MINUS_SRC_ALPHA), so its contents are premultiplied colour. MSAA
// resolve keeps it premultiplied (edge pixels average (c,1) and (0,0)). The final pass grades the
// un-premultiplied colour, adds bloom as light (glow outside the silhouette raises alpha so it shows in OBS)
// and writes UN-premultiplied sRGB, matching the canvas context (premultipliedAlpha: false). Rendering the
// scene straight to the canvas instead leaves dark fringes on every anti-aliased edge over OBS content.
// In a room with an opaque background (`opaque`), the only transparent pixels are the react screen's OBS hole:
// nothing (bloom, haze, shafts) is ever added there, so the Window Capture below stays untouched.
// "Verbatim" pixels: a React screen showing a captured window in the scene (src/scene/screenFx.ts) writes alpha
// 1 + coverage (the half-float target keeps values above 1; MSAA and blending over it keep the excess proportional to
// how much of the pixel is still the window). The final pass shows those pixels as they are: no AO, haze, grade / LUT,
// vignette, bloom or shafts on them — the window must read exactly like the source, not washed or tinted by the room.
//
// Bloom is selective by construction: the stage renders without tone mapping and every lit surface is kept
// ≤ ~1.0 by its shader (cel ramp, stylised PBR shoulder), so only emissive parts (LED eyes, glowing grilles,
// flames, room EMIT_ materials with emissive strength 2–5) and hot speculars exceed the threshold.
//
// Every pass is compiled when the pipeline is built (warm()): a pipeline is only (re)built at a tier / effect
// change or a room load, never mid-show; per-frame changes are uniforms only.

import * as THREE from 'three';
import { EdgeDetectionMaterial, EdgeDetectionMode, SMAAImageLoader, SMAAWeightsMaterial } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { FxPass } from './fxPresets.ts';   // screen FX presets (soundfx lane): one hook, idle cost = one property read per frame

export interface PipelineConfig {
  /** MSAA samples for the scene target (0 = none). */
  samples: number;
  /** Bloom mip levels (0 = bloom off). Each level halves the resolution. */
  bloomLevels: number;
  /** Half-res SSAO (needs the depth texture). */
  ao?: boolean;
  aoSamples?: number;
  /** Half-res background depth of field. */
  dof?: boolean;
  /** Depth-based haze lit by the bloom chain. */
  haze?: boolean;
  /** Quarter-res radial light shafts from up to 4 screen points. */
  shafts?: boolean;
  /** Half-res planar screen-space reflections on a floor plane. */
  ssr?: boolean;
  /** Final FXAA pass (ignored when smaa is on). */
  fxaa?: boolean;
  /** Final SMAA (edge detection → blend weights → premultiplied neighbourhood blend). */
  smaa?: boolean;
  /** N8AO instead of the built-in SSAO (needs `ao`): half resolution + sample count. */
  n8ao?: { half: boolean; samples: number } | null;
  /** Colour-grading LUT (32³ strip texture). */
  lut?: boolean;
  /** Glow layer: additive effects (tracers, beams, lasers, flashes) re-drawn into a depth-tested buffer that feeds
   *  the bloom — their own shaders untouched. */
  glow?: boolean;
}

export interface GradeParams {
  /** Bloom strength (0 = off). */
  bloom: number;
  /** Brightness above which pixels bloom (linear, max channel). */
  threshold: number;
  saturation: number;
  contrast: number;
  /** LUT strip (1024×32, 32 blue slices) + how much of it (0..1). */
  lut?: THREE.Texture | null;
  lutMix?: number;
  /** Corner darkening 0..1 (opaque pixels only). */
  vignette?: number;
  /** AO strength 0..1 and radius (m). */
  ao?: number;
  aoRadius?: number;
  /** View-space spheres (xyz, radius) where AO is suppressed (the performers). */
  protect?: THREE.Vector4[];
  /** Background DOF: focus distance (m), blur ramp length (m), max blur radius (full-res px), amount 0..1. */
  dof?: { focus: number; range: number; blur: number; amount: number } | null;
  /** Haze: air colour (linear), density (1/m), how much bloom glow lights it. */
  haze?: { color: THREE.Color; density: number; glow: number } | null;
  /** Shafts: up to 4 screen points (uv x, y, strength, 0), ray length (fraction of the way to the light), decay. */
  shafts?: { pts: THREE.Vector4[]; length: number; decay: number; strength: number } | null;
  /** Glossy floor: plane height (world y), strength 0..1, max ray length (m). */
  ssr?: { y: number; strength: number; maxDist: number } | null;
  /** Room with an opaque background: transparent pixels are the OBS hole (kept exactly clear). */
  opaque?: boolean;
  /** Glow layer: which scene + a camera that only sees the glow layer, and how strongly it blooms. */
  glow?: { scene: THREE.Scene; camera: THREE.Camera; gain: number } | null;
}

const BLACK = new THREE.Color(0, 0, 0);   // read-only (copied from, never mutated)
const FS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DEPTH_FN = /* glsl */ `
  uniform sampler2D tDepth; uniform mat4 uProjInv;
  float depthAt(vec2 uv) { return texture2D(tDepth, uv).x; }
  vec3 viewPos(vec2 uv, float d) { vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`;

// bright pass + first downsample (13-tap-ish: 4 bilinear taps = 16 texels, anti-firefly Karis weights)
const BRIGHT_FRAG = /* glsl */ `
  uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold;
  #ifdef USE_GLOW
    uniform sampler2D tGlow; uniform float uGlow;
  #endif
  varying vec2 vUv;
  vec3 pick(vec2 uv) {
    vec4 c = texture2D(tSrc, uv);
    vec3 col = c.rgb;                                   // premultiplied: coverage already folded in
    // never let one bad pixel (NaN / Inf / negative from any material) into the mip chain: it would spread into blocks
    col = (any(isnan(col)) || any(isinf(col))) ? vec3(0.0) : clamp(col, 0.0, 64.0);
    float m = max(col.r, max(col.g, col.b));
    float knee = uThreshold * 0.35;
    float s = clamp(m - uThreshold + knee, 0.0, 2.0 * knee);
    float w = max(s * s / (4.0 * knee + 1e-5), m - uThreshold) / max(m, 1e-5);
    vec3 o = col * w / (1.0 + m * w * 0.25);            // soft Karis weight: one hot pixel can't flash the frame
    #ifdef USE_GLOW
      vec3 g = texture2D(tGlow, uv).rgb * uGlow;
      o += g / (1.0 + max(g.r, max(g.g, g.b)) * 0.2);
    #endif
    return o;
  }
  void main() {
    vec2 o = uTexel * 0.5;
    vec3 c = pick(vUv + vec2(-o.x, -o.y)) + pick(vUv + vec2(o.x, -o.y)) + pick(vUv + vec2(-o.x, o.y)) + pick(vUv + vec2(o.x, o.y));
    gl_FragColor = vec4(c * 0.25, 1.0);
  }`;

const DOWN_FRAG = /* glsl */ `
  uniform sampler2D tSrc; uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec2 o = uTexel;
    vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
    c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb;
    c += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
    gl_FragColor = vec4(c / 8.0, 1.0);
  }`;

// tent upsample of the smaller level, added onto this level
const UP_FRAG = /* glsl */ `
  uniform sampler2D tSrc; uniform sampler2D tBase; uniform vec2 uTexel; uniform float uWeight;
  varying vec2 vUv;
  void main() {
    vec2 o = uTexel;
    vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
    c += (texture2D(tSrc, vUv + vec2(-o.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(o.x, 0.0)).rgb
        + texture2D(tSrc, vUv + vec2(0.0, -o.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, o.y)).rgb) * 2.0;
    c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb
       + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
    gl_FragColor = vec4(texture2D(tBase, vUv).rgb + c / 16.0 * uWeight, 1.0);
  }`;

// half-res SSAO: hemisphere kernel around the depth-reconstructed normal, range-checked, interleaved-gradient rotation
const AO_FRAG = (n: number) => /* glsl */ `
  ${DEPTH_FN}
  #define NS ${n}
  uniform vec3 uKernel[NS]; uniform mat4 uProj; uniform vec2 uStep; uniform float uRadius; uniform vec4 uProt[4];
  varying vec2 vUv;
  void main() {
    float d = depthAt(vUv);
    if (d >= 0.99999) { gl_FragColor = vec4(1.0, 1e4, 0.0, 1.0); return; }
    vec3 P = viewPos(vUv, d);
    vec3 Pr = viewPos(vUv + vec2(uStep.x, 0.0), depthAt(vUv + vec2(uStep.x, 0.0)));
    vec3 Pl = viewPos(vUv - vec2(uStep.x, 0.0), depthAt(vUv - vec2(uStep.x, 0.0)));
    vec3 Pu = viewPos(vUv + vec2(0.0, uStep.y), depthAt(vUv + vec2(0.0, uStep.y)));
    vec3 Pd = viewPos(vUv - vec2(0.0, uStep.y), depthAt(vUv - vec2(0.0, uStep.y)));
    vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
    vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
    vec3 N = normalize(cross(dx, dy));
    if (dot(N, P) > 0.0) N = -N;
    float a = ign(gl_FragCoord.xy) * 6.2831853;
    vec3 rv = vec3(cos(a), sin(a), 0.0);
    vec3 T = normalize(rv - N * dot(rv, N));
    mat3 TBN = mat3(T, cross(N, T), N);
    float rad = uRadius * clamp(-P.z * 0.18, 0.35, 1.0);    // tighter up close: no dark halos round a near face
    float occ = 0.0;
    for (int i = 0; i < NS; i++) {
      vec3 S = P + TBN * uKernel[i] * rad;
      vec4 c = uProj * vec4(S, 1.0);
      vec2 suv = c.xy / c.w * 0.5 + 0.5;
      float sz = viewPos(suv, depthAt(suv)).z;
      float range = smoothstep(0.0, 1.0, rad / max(abs(P.z - sz), 1e-4));
      occ += (sz >= S.z + 0.025 * rad ? 1.0 : 0.0) * range;
    }
    float ao = 1.0 - occ / float(NS);
    for (int i = 0; i < 4; i++) {
      vec4 s = uProt[i];
      if (s.w > 0.0) ao = mix(ao, 1.0, 1.0 - smoothstep(s.w * 0.75, s.w * 1.15, length(P - s.xyz)));
    }
    ao = mix(ao, 1.0, smoothstep(22.0, 38.0, -P.z));
    gl_FragColor = vec4(ao, -P.z, 0.0, 1.0);
  }`;

const AO_BLUR_FRAG = /* glsl */ `
  uniform sampler2D tSrc; uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec2 c = texture2D(tSrc, vUv).rg;
    float sum = c.r, w = 1.0;
    for (int i = -3; i <= 3; i++) {
      if (i == 0) continue;
      vec2 s = texture2D(tSrc, vUv + uDir * float(i)).rg;
      float wd = exp(-abs(s.g - c.g) / max(0.04 * c.g, 0.03)) * (1.0 - abs(float(i)) / 4.5);
      sum += s.r * wd; w += wd;
    }
    gl_FragColor = vec4(sum / w, c.g, 0.0, 1.0);
  }`;

// half-res background blur: Vogel disk, samples weighted by their own circle of confusion (no in-focus bleed)
const DOF_FRAG = /* glsl */ `
  ${DEPTH_FN}
  uniform sampler2D tScene; uniform vec2 uTexel; uniform float uFocus, uRange, uBlur;
  varying vec2 vUv;
  float coc(vec2 uv) { return clamp((-viewPos(uv, depthAt(uv)).z - uFocus) / uRange, 0.0, 1.0); }
  void main() {
    float c0 = coc(vUv);
    vec4 base = texture2D(tScene, vUv);
    if (c0 <= 0.001) { gl_FragColor = base; return; }
    vec4 acc = base * c0; float ws = c0;
    float rot = ign(gl_FragCoord.xy) * 6.2831853;
    for (int i = 0; i < 16; i++) {
      float r = sqrt((float(i) + 0.5) / 16.0);
      float th = float(i) * 2.39996323 + rot;
      vec2 suv = vUv + vec2(cos(th), sin(th)) * r * uBlur * c0 * uTexel;
      float cs = coc(suv);
      float w = smoothstep(r * c0 * 0.5, r * c0 * 0.5 + 0.12, cs);
      acc += texture2D(tScene, suv) * w; ws += w;
    }
    gl_FragColor = acc / max(ws, 1e-4);
  }`;

// planar SSR on one floor plane (world y): the view ray reflected about the plane, marched against the depth buffer
const SSR_FRAG = /* glsl */ `
  ${DEPTH_FN}
  uniform sampler2D tScene; uniform mat4 uProj, uInvView, uView; uniform float uPlaneY, uMaxDist; uniform vec2 uStep;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(0.0);
    float d = depthAt(vUv);
    if (d >= 0.99999) return;
    vec3 P = viewPos(vUv, d);
    vec3 W = (uInvView * vec4(P, 1.0)).xyz;
    if (abs(W.y - uPlaneY) > 0.035) return;
    // only flat floor: both neighbours on the plane too (no reflections on the feet of chairs / people)
    vec3 Wr = (uInvView * vec4(viewPos(vUv + vec2(uStep.x, 0.0), depthAt(vUv + vec2(uStep.x, 0.0))), 1.0)).xyz;
    vec3 Wu = (uInvView * vec4(viewPos(vUv + vec2(0.0, uStep.y), depthAt(vUv + vec2(0.0, uStep.y))), 1.0)).xyz;
    if (abs(Wr.y - uPlaneY) > 0.05 || abs(Wu.y - uPlaneY) > 0.05) return;
    vec3 Nv = normalize((uView * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 V = normalize(P);
    vec3 R = reflect(V, Nv);
    float st = uMaxDist / 22.0;
    float t = st * (0.3 + ign(gl_FragCoord.xy) * 0.7);
    vec2 hit = vec2(-1.0); float ht = 0.0;
    for (int i = 0; i < 22; i++) {
      vec3 Q = P + R * t;
      vec4 c = uProj * vec4(Q, 1.0);
      vec2 uv = c.xy / c.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || c.w <= 0.0) break;
      float sz = viewPos(uv, depthAt(uv)).z;
      if (sz > Q.z && sz - Q.z < 0.25 + t * 0.06) { hit = uv; ht = t; break; }
      t += st * (1.0 + float(i) * 0.1);
    }
    if (hit.x < 0.0) return;
    float cosv = max(dot(-V, Nv), 0.0);
    float F = mix(0.18, 1.0, pow(1.0 - cosv, 3.0));
    vec2 e = min(hit, 1.0 - hit);
    float fade = smoothstep(0.0, 0.08, min(e.x, e.y)) * (1.0 - smoothstep(0.55, 1.0, ht / uMaxDist));
    vec4 col = texture2D(tScene, hit);
    gl_FragColor = vec4(col.rgb, col.a) * F * fade;
  }`;

// quarter-res god rays: radial blur of the bright pass towards up to 4 light points (occluders are dark in it)
const SHAFT_FRAG = /* glsl */ `
  uniform sampler2D tSrc; uniform vec4 uL[4]; uniform float uLen, uDecay, uAspect;
  varying vec2 vUv;
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  #define NS 28
  void main() {
    vec3 acc = vec3(0.0);
    float j = ign(gl_FragCoord.xy);
    for (int l = 0; l < 4; l++) {
      vec4 L = uL[l];
      if (L.z <= 0.0) continue;
      vec2 dv = vUv - L.xy;
      float dist = length(dv * vec2(uAspect, 1.0));
      vec2 st = dv * uLen / float(NS);
      vec2 p = vUv - st * j;
      float il = 1.0; vec3 s = vec3(0.0);
      for (int i = 0; i < NS; i++) { p -= st; s += texture2D(tSrc, p).rgb * il; il *= uDecay; }
      acc += s * (L.z / float(NS)) * (1.0 - smoothstep(0.15, 0.85, dist));
    }
    gl_FragColor = vec4(acc, 1.0);
  }`;

const FINAL_FRAG = /* glsl */ `
  #include <packing>
  uniform sampler2D tScene; uniform sampler2D tBloom;
  uniform float uBloom, uSat, uContrast, uHasBloom, uOpaque, uVig;
  varying vec2 vUv;
  #if defined(USE_DOF) || defined(USE_HAZE) || defined(USE_N8AO)
    ${DEPTH_FN}
  #endif
  #ifdef USE_AO
    uniform sampler2D tAO; uniform float uAO;
  #endif
  #ifdef USE_N8AO
    uniform vec4 uProt[4];
    // N8AO's term under the built-in pass's rules: never on performers, fades out beyond 22–38 m
    float n8ao(vec2 uv) {
      float d = depthAt(uv);
      if (d >= 0.99999) return 1.0;
      float ao = texture2D(tAO, uv).r;
      vec3 P = viewPos(uv, d);
      for (int i = 0; i < 4; i++) {
        vec4 s = uProt[i];
        if (s.w > 0.0) ao = mix(ao, 1.0, 1.0 - smoothstep(s.w * 0.75, s.w * 1.15, length(P - s.xyz)));
      }
      return mix(ao, 1.0, smoothstep(22.0, 38.0, -P.z));
    }
  #endif
  uniform float uPremulOut;
  #ifdef USE_DOF
    uniform sampler2D tDof; uniform float uFocus, uRange, uDofAmt;
  #endif
  #ifdef USE_SSR
    uniform sampler2D tSSR; uniform float uSSR;
  #endif
  #ifdef USE_HAZE
    uniform sampler2D tGlow; uniform vec3 uHazeCol; uniform float uHazeDen, uHazeGlow;
  #endif
  #ifdef USE_SHAFTS
    uniform sampler2D tShafts; uniform float uShafts;
  #endif
  #ifdef USE_LUT
    uniform sampler2D tLut; uniform float uLutMix;
    vec3 lut(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      float b = c.b * 31.0, b0 = floor(b), b1 = min(b0 + 1.0, 31.0);
      float x = c.r * 31.0 + 0.5, y = (c.g * 31.0 + 0.5) / 32.0;
      vec3 l0 = texture2D(tLut, vec2((b0 * 32.0 + x) / 1024.0, y)).rgb;
      vec3 l1 = texture2D(tLut, vec2((b1 * 32.0 + x) / 1024.0, y)).rgb;
      return mix(l0, l1, b - b0);
    }
  #endif
  vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055, step(0.0031308, c)); }
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    vec4 s = texture2D(tScene, vUv);
    float vb = clamp(s.a - 1.0, 0.0, 1.0);             // verbatim coverage (a captured window on a React screen)
    #if defined(USE_DOF) || defined(USE_HAZE)
      float vz = -viewPos(vUv, depthAt(vUv)).z;
    #endif
    #ifdef USE_DOF
      float k = clamp((vz - uFocus) / uRange, 0.0, 1.0);
      s = mix(s, texture2D(tDof, vUv), smoothstep(0.0, 0.3, k) * uDofAmt);
    #endif
    #ifdef USE_SSR
      vec4 r = texture2D(tSSR, vUv);
      s.rgb += r.rgb * uSSR * min(s.a, 1.0) * (1.0 - vb);
    #endif
    #ifdef USE_AO
      #ifdef USE_N8AO
        s.rgb *= mix(1.0, n8ao(vUv), uAO * (1.0 - vb));
      #else
        s.rgb *= mix(1.0, texture2D(tAO, vUv).r, uAO * (1.0 - vb));
      #endif
    #endif
    float a = clamp(s.a, 0.0, 1.0);
    bool hole = uOpaque > 0.5 && a < 0.5;
    vec3 col = a > 1e-4 ? s.rgb / a : vec3(0.0);
    vec3 raw = col;
    #ifdef USE_HAZE
      if (!hole && a > 0.0) {
        float f = (1.0 - exp(-max(vz - 0.5, 0.0) * uHazeDen)) * (1.0 - vb);
        vec3 hg = texture2D(tGlow, vUv).rgb;
        hg = (any(isnan(hg)) || any(isinf(hg))) ? vec3(0.0) : clamp(hg, 0.0, 64.0);
        col = col * (1.0 - f * 0.35) + (uHazeCol + hg * uHazeGlow) * f;
      }
    #endif
    // grade (on straight colour): saturation around luma, contrast around mid-grey in perceptual space
    col = max(mix(vec3(luma(col)), col, uSat), 0.0);
    vec3 p = toSRGB(clamp(col, 0.0, 1.0));
    p = clamp((p - 0.5) * uContrast + 0.5, 0.0, 1.0);
    #ifdef USE_LUT
      p = mix(p, lut(p), uLutMix);
    #endif
    p = mix(p, toSRGB(clamp(raw, 0.0, 1.0)), vb);       // the window's own pixels: ungraded
    // back to linear premultiplied, add bloom as emitted light (can extend beyond the silhouette)
    vec3 lin = mix(p / 12.92, pow((p + 0.055) / 1.055, vec3(2.4)), step(0.04045, p));
    vec3 prem = lin * a;
    if (uVig > 0.0 && a > 0.5) { vec2 q = (vUv - 0.5) * vec2(1.0, 0.82); prem *= 1.0 - uVig * smoothstep(0.32, 0.78, length(q)) * (1.0 - vb); }
    float outA = a;
    vec3 add = vec3(0.0);
    if (uHasBloom > 0.5) add += texture2D(tBloom, vUv).rgb * uBloom;
    add = (any(isnan(add)) || any(isinf(add))) ? vec3(0.0) : clamp(add, 0.0, 64.0);
    #ifdef USE_SHAFTS
      add += texture2D(tShafts, vUv).rgb * uShafts;
    #endif
    if (hole) add = vec3(0.0);
    add *= 1.0 - vb;                                     // no bloom / shaft veil over a captured window
    if (max(add.r, max(add.g, add.b)) > 0.0) {
      prem += add;
      outA = max(a, min(1.0, max(add.r, max(add.g, add.b)) * 1.15 + a));
      outA = clamp(max(outA, max(prem.r, max(prem.g, prem.b))), 0.0, 1.0);
    }
    vec3 straight = outA > 1e-4 ? min(prem / outA, 1.0) : vec3(0.0);
    gl_FragColor = vec4(toSRGB(straight) * (uPremulOut > 0.5 ? outA : 1.0), outA);
  }`;

// SMAA neighbourhood blending (iryoku SMAA 2.8, as in pmndrs' SMAAEffect) on PREMULTIPLIED sRGB, written back straight
const SMAA_BLEND_FRAG = /* glsl */ `
  uniform sampler2D tSrc; uniform sampler2D tWeights; uniform vec2 uTexel; uniform float uOpaque;
  varying vec2 vUv;
  void main() {
    vec4 c0 = texture2D(tSrc, vUv);
    // opaque room: the OBS hole's pixels are never touched (its rim keeps exactly the MSAA edge)
    if (uOpaque > 0.5 && c0.a < 0.5) { gl_FragColor = c0.a > 1e-4 ? vec4(min(c0.rgb / c0.a, 1.0), c0.a) : vec4(0.0); return; }
    vec4 a;
    a.x = texture2D(tWeights, vUv + vec2(uTexel.x, 0.0)).a;
    a.y = texture2D(tWeights, vUv + vec2(0.0, uTexel.y)).g;
    a.wz = texture2D(tWeights, vUv).rb;
    vec4 c = c0;
    if (dot(a, vec4(1.0)) >= 1e-5) {
      bool h = max(a.x, a.z) > max(a.y, a.w);
      vec4 off = h ? vec4(a.x, 0.0, a.z, 0.0) : vec4(0.0, a.y, 0.0, a.w);
      vec2 w = h ? a.xz : a.yw;
      w /= dot(w, vec2(1.0));
      vec4 bc = off * vec4(uTexel, -uTexel) + vUv.xyxy;
      c = w.x * texture2D(tSrc, bc.xy) + w.y * texture2D(tSrc, bc.zw);
    }
    gl_FragColor = c.a > 1e-4 ? vec4(min(c.rgb / c.a, 1.0), c.a) : vec4(0.0);
  }`;

/** SMAA lookup textures (pmndrs/postprocessing's embedded search / area images), decoded once per page. */
let smaaTex: Promise<{ search: THREE.Texture; area: THREE.Texture } | null> | null = null;
function smaaTextures() {
  smaaTex ??= (new SMAAImageLoader() as unknown as { load(onLoad: () => void): Promise<HTMLImageElement[]> }).load(() => { /* the promise below */ }).then(([si, ai]) => {
    const search = new THREE.Texture(si);
    search.name = 'SMAA.Search'; search.magFilter = search.minFilter = THREE.NearestFilter; search.generateMipmaps = false; search.flipY = true; search.needsUpdate = true;
    const area = new THREE.Texture(ai);
    area.name = 'SMAA.Area'; area.magFilter = area.minFilter = THREE.LinearFilter; area.generateMipmaps = false; area.flipY = false; area.needsUpdate = true;
    return { search, area };
  }).catch((e: unknown) => { console.warn('[post] SMAA textures', e); return null; });
  return smaaTex;
}

// FXAA (3.11-style, luma from the sRGB colour); alpha is carried from the centre
const FXAA_FRAG = /* glsl */ `
  uniform sampler2D tSrc; uniform vec2 uTexel;
  varying vec2 vUv;
  float L(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  void main() {
    vec4 cM = texture2D(tSrc, vUv);
    float lM = L(cM.rgb);
    float lNW = L(texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb), lNE = L(texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb);
    float lSW = L(texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb), lSE = L(texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb);
    float mn = min(lM, min(min(lNW, lNE), min(lSW, lSE))), mx = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    if (mx - mn < max(0.0312, mx * 0.125)) { gl_FragColor = cM; return; }
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
    float red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
    dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), -8.0, 8.0) * uTexel;
    vec3 a = 0.5 * (texture2D(tSrc, vUv - dir / 6.0).rgb + texture2D(tSrc, vUv + dir / 6.0).rgb);
    vec3 b = a * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);
    float lB = L(b);
    gl_FragColor = vec4((lB < mn || lB > mx) ? a : b, cM.a);
  }`;

function fsMaterial(frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
}

function rt(w: number, h: number, type: THREE.TextureDataType = THREE.HalfFloatType): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, { type, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
}

type N8Transparency = {
  autoDetectTransparency: boolean; configuration: { transparencyAware: boolean };
  effectCompositerQuad?: { material?: { uniforms?: Record<string, { value: unknown } | undefined> } };
};
/** Anything of N8AO's transparency mode still on: its auto-detect, the passes, or the compositing pass reading them. */
export function n8aoTransparencyLeft(n8: N8Transparency): boolean {
  return n8.autoDetectTransparency || n8.configuration.transparencyAware || n8.effectCompositerQuad?.material?.uniforms?.transparencyAware?.value === true;
}
/** N8AO without its transparency passes (High / Ultra rooms). Writing `transparencyAware = false` alone does nothing on a
 *  fresh pass: false is already the default, and n8ao only drops its per-frame auto-detect when the value CHANGES — so
 *  its render() found the first transparent material in the room and switched the passes on: a scene traversal plus
 *  2 extra whole-scene renders, 2 full-res clears and 2 depth copies EVERY frame (stage.render CPU −13 to −34 % at
 *  High / Ultra in the A/B runs, docs/PERFORMANCE.md; checks: tools/room_render_unit.ts). AO then ignores transparent
 *  surfaces (glass, smoke, FX planes) as intended; the performers keep their own protection (uProt). Returns true when it
 *  had to switch something off. */
export function n8aoTransparencyOff(n8: N8Transparency): boolean {
  const was = n8aoTransparencyLeft(n8);
  n8.autoDetectTransparency = false;
  n8.configuration.transparencyAware = false;
  // n8ao sets its compositing pass's `transparencyAware` uniform to true on every frame the passes ran and never back to
  // false: left on, AO compositing would keep sampling the transparency targets the setter above has just disposed
  const u = n8.effectCompositerQuad?.material?.uniforms?.transparencyAware;
  if (u) u.value = false;
  return was;
}

/** Cosine-weighted hemisphere kernel (+Z), denser near the centre. */
function aoKernel(n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) {
    const u = rnd(), v = rnd();
    const r = Math.sqrt(u), th = v * Math.PI * 2;
    const p = new THREE.Vector3(r * Math.cos(th), r * Math.sin(th), Math.sqrt(Math.max(0, 1 - u)));
    let s = (i + 1) / n; s = 0.15 + 0.85 * s * s;
    out.push(p.multiplyScalar(s));
  }
  return out;
}

export class Pipeline {
  private scene: THREE.WebGLRenderTarget;
  private levels: THREE.WebGLRenderTarget[] = [];
  private ups: THREE.WebGLRenderTarget[] = [];
  private aoRT: THREE.WebGLRenderTarget | null = null;
  private aoTmp: THREE.WebGLRenderTarget | null = null;
  private dofRT: THREE.WebGLRenderTarget | null = null;
  private ssrRT: THREE.WebGLRenderTarget | null = null;
  private shaftRT: THREE.WebGLRenderTarget | null = null;
  private ldr: THREE.WebGLRenderTarget | null = null;
  private glowRT: THREE.WebGLRenderTarget | null = null;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  /** Nothing in it: an empty render resolves a multisampled scene target's clear (see render's `fill`). */
  private resolveScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bright = fsMaterial(BRIGHT_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 } });
  private down = fsMaterial(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  private up = fsMaterial(UP_FRAG, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } });
  private final: THREE.ShaderMaterial;
  private aoMat: THREE.ShaderMaterial | null = null;
  private aoBlur: THREE.ShaderMaterial | null = null;
  private dofMat: THREE.ShaderMaterial | null = null;
  private ssrMat: THREE.ShaderMaterial | null = null;
  private shaftMat: THREE.ShaderMaterial | null = null;
  private fxaaMat: THREE.ShaderMaterial | null = null;
  private smaaEdges: EdgeDetectionMaterial | null = null;
  private smaaWeights: SMAAWeightsMaterial | null = null;
  private smaaBlend: THREE.ShaderMaterial | null = null;
  private edgesRT: THREE.WebGLRenderTarget | null = null;
  private weightsRT: THREE.WebGLRenderTarget | null = null;
  private smaaReady = false;
  private clearTmp = new THREE.Color();
  private n8: N8AOPostPass | null = null;
  private n8Warned = false;
  /** Keeps N8AO's transparency passes off every frame (false only for A/B measurements of the old behaviour). */
  n8TransparencyGuard = true;
  private glowClearTmp = new THREE.Color();
  private n8Out: THREE.WebGLRenderTarget | null = null;
  /** Screen FX presets (src/stage/post/fxPresets.ts): made when the pipeline is warmed, its target only while a preset runs. */
  private fxPass: FxPass | null = null;
  private w = 1; private h = 1;
  private readonly depth: boolean;
  private readonly chain: boolean;
  /** Last frame's GPU-side cost estimate inputs (for the perf report). */
  readonly passes: string[] = [];

  constructor(private renderer: THREE.WebGLRenderer, readonly cfg: PipelineConfig) {
    this.depth = !!(cfg.ao || cfg.dof || cfg.haze || cfg.ssr || cfg.glow);
    this.chain = cfg.bloomLevels > 0 || !!cfg.haze || !!cfg.shafts;
    const levels = this.chain ? Math.max(cfg.bloomLevels, cfg.haze ? 5 : cfg.shafts ? 2 : 0) : 0;
    this.scene = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, samples: cfg.samples, depthBuffer: true, stencilBuffer: true,
      colorSpace: THREE.LinearSRGBColorSpace, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    if (this.depth) {
      const dt = new THREE.DepthTexture(1, 1);
      dt.format = THREE.DepthStencilFormat;
      dt.type = THREE.UnsignedInt248Type;
      dt.minFilter = dt.magFilter = THREE.NearestFilter;
      this.scene.depthTexture = dt;
    }
    this.scene.texture.generateMipmaps = false;
    // MSAA resolve: never blit the stencil (carved mouths only need it while drawing), depth only when a pass reads it —
    // resolving depth + stencil costs ~3.5 ms per frame at 1080p on ANGLE / D3D11 (measured), colour-only ~0.
    (this.scene as THREE.WebGLRenderTarget & { resolveStencilBuffer: boolean; resolveDepthBuffer: boolean }).resolveStencilBuffer = false;
    (this.scene as THREE.WebGLRenderTarget & { resolveStencilBuffer: boolean; resolveDepthBuffer: boolean }).resolveDepthBuffer = this.depth;
    if (cfg.glow && this.chain) {
      this.glowRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
      this.glowRT.depthTexture = this.scene.depthTexture;      // depth-tested against the scene, never writes it
      this.bright.defines.USE_GLOW = '';
      this.bright.uniforms.tGlow = { value: this.glowRT.texture };
      this.bright.uniforms.uGlow = { value: 0 };
      this.passes.push('glow');
    }
    for (let i = 0; i < levels; i++) {
      this.levels.push(rt(1, 1));
      if (i < levels - 1) this.ups.push(rt(1, 1));
    }
    const defines: Record<string, string> = {};
    const U: Record<string, THREE.IUniform> = {
      tScene: { value: null }, tBloom: { value: null }, uBloom: { value: 0.6 }, uSat: { value: 1 }, uContrast: { value: 1 }, uHasBloom: { value: 0 },
      uOpaque: { value: 0 }, uVig: { value: 0 },
      tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uPremulOut: { value: 0 },
    };
    const projInv = U.uProjInv;
    const depthU = U.tDepth;
    if (cfg.ao && cfg.n8ao) {
      defines.USE_AO = ''; defines.USE_N8AO = '';
      U.tAO = { value: null }; U.uAO = { value: 0 }; U.uProt = { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) };
      const n8 = new N8AOPostPass(new THREE.Scene(), new THREE.PerspectiveCamera(), 1, 1);
      const c = n8.configuration;
      n8aoTransparencyOff(n8);
      c.gammaCorrection = false; c.renderMode = 1; c.colorMultiply = false; c.color = new THREE.Color(0, 0, 0);
      c.halfRes = cfg.n8ao.half; c.depthAwareUpsampling = true;
      c.aoSamples = cfg.n8ao.samples; c.denoiseSamples = 8; c.denoiseRadius = 12; c.denoiseIterations = 2;
      c.aoRadius = 1.0; c.distanceFalloff = 1.0; c.intensity = 2.2; c.screenSpaceRadius = false;
      this.n8 = n8;
      this.n8Out = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });   // its copy-out (1×1: we read its internal target)
      this.passes.push(`n8ao×${cfg.n8ao.samples}${cfg.n8ao.half ? '½' : ''}`);
    } else if (cfg.ao) {
      defines.USE_AO = '';
      U.tAO = { value: null }; U.uAO = { value: 0 };
      const n = Math.max(4, Math.min(16, cfg.aoSamples ?? 8));
      this.aoRT = rt(1, 1); this.aoTmp = rt(1, 1);
      this.aoMat = fsMaterial(AO_FRAG(n), { tDepth: depthU, uProjInv: projInv, uKernel: { value: aoKernel(n) }, uProj: { value: new THREE.Matrix4() }, uStep: { value: new THREE.Vector2() }, uRadius: { value: 0.5 }, uProt: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) } });
      this.aoBlur = fsMaterial(AO_BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
      this.passes.push(`ao×${n}`);
    }
    if (cfg.dof) {
      defines.USE_DOF = '';
      U.tDof = { value: null }; U.uFocus = { value: 3 }; U.uRange = { value: 4 }; U.uDofAmt = { value: 0 };
      this.dofRT = rt(1, 1);
      this.dofMat = fsMaterial(DOF_FRAG, { tDepth: depthU, uProjInv: projInv, tScene: { value: null }, uTexel: { value: new THREE.Vector2() }, uFocus: U.uFocus, uRange: U.uRange, uBlur: { value: 6 } });
      this.passes.push('dof');
    }
    if (cfg.ssr) {
      defines.USE_SSR = '';
      U.tSSR = { value: null }; U.uSSR = { value: 0 };
      this.ssrRT = rt(1, 1);
      this.ssrMat = fsMaterial(SSR_FRAG, { tDepth: depthU, uProjInv: projInv, tScene: { value: null }, uProj: { value: new THREE.Matrix4() }, uInvView: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix4() }, uPlaneY: { value: 0 }, uMaxDist: { value: 6 }, uStep: { value: new THREE.Vector2() } });
      this.passes.push('ssr');
    }
    if (cfg.haze) {
      defines.USE_HAZE = '';
      U.tGlow = { value: null }; U.uHazeCol = { value: new THREE.Color() }; U.uHazeDen = { value: 0 }; U.uHazeGlow = { value: 0 };
      this.passes.push('haze');
    }
    if (cfg.shafts) {
      defines.USE_SHAFTS = '';
      U.tShafts = { value: null }; U.uShafts = { value: 0 };
      this.shaftRT = rt(1, 1);
      this.shaftMat = fsMaterial(SHAFT_FRAG, { tSrc: { value: null }, uL: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, uLen: { value: 0.6 }, uDecay: { value: 0.96 }, uAspect: { value: 16 / 9 } });
      this.passes.push('shafts');
    }
    if (cfg.lut) { defines.USE_LUT = ''; U.tLut = { value: null }; U.uLutMix = { value: 0 }; this.passes.push('lut'); }
    if (cfg.smaa) {
      this.ldr = rt(1, 1, THREE.UnsignedByteType);
      this.edgesRT = rt(1, 1, THREE.UnsignedByteType);
      this.weightsRT = rt(1, 1, THREE.UnsignedByteType);
      const e = new EdgeDetectionMaterial(new THREE.Vector2(), EdgeDetectionMode.COLOR);
      e.edgeDetectionThreshold = 0.1;
      const wm = new SMAAWeightsMaterial(new THREE.Vector2(), new THREE.Vector2());
      wm.orthogonalSearchSteps = 16; wm.diagonalSearchSteps = 8; wm.cornerRounding = 25; wm.diagonalDetection = true; (wm as unknown as { cornerDetection: boolean }).cornerDetection = true;
      this.smaaEdges = e; this.smaaWeights = wm;
      this.smaaBlend = fsMaterial(SMAA_BLEND_FRAG, { tSrc: { value: null }, tWeights: { value: null }, uTexel: { value: new THREE.Vector2() }, uOpaque: { value: 0 } });
      void smaaTextures().then((t) => { if (!t || !this.smaaWeights) return; this.smaaWeights.searchTexture = t.search; this.smaaWeights.areaTexture = t.area; this.smaaReady = true; });
      this.passes.push('smaa');
    } else if (cfg.fxaa) {
      this.ldr = rt(1, 1, THREE.UnsignedByteType);
      this.fxaaMat = fsMaterial(FXAA_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
      this.passes.push('fxaa');
    }
    if (levels) this.passes.push(`bloom×${levels}`);
    this.final = fsMaterial(FINAL_FRAG, U, defines);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.final);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Compile every pass now (at build time), so the first frame with this pipeline never compiles mid-show. */
  warm() {
    for (const m of [this.bright, this.down, this.up, this.final, this.aoMat, this.aoBlur, this.dofMat, this.ssrMat, this.shaftMat, this.fxaaMat, this.smaaEdges, this.smaaWeights, this.smaaBlend]) {
      if (!m) continue;
      this.quad.material = m;
      try { this.renderer.compile(this.quadScene, this.quadCam); } catch { /* optional */ }
    }
    this.quad.material = this.final;
    (this.fxPass ??= new FxPass()).warm(this.renderer);
  }

  setSize(w: number, h: number) {
    w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.scene.setSize(w, h);
    let lw = w, lh = h;
    for (let i = 0; i < this.levels.length; i++) {
      lw = Math.max(1, Math.ceil(lw / 2)); lh = Math.max(1, Math.ceil(lh / 2));
      this.levels[i].setSize(lw, lh);
      if (i < this.ups.length) this.ups[i].setSize(lw, lh);
    }
    const hw = Math.max(1, Math.ceil(w / 2)), hh = Math.max(1, Math.ceil(h / 2));
    this.aoRT?.setSize(hw, hh); this.aoTmp?.setSize(hw, hh);
    this.dofRT?.setSize(hw, hh); this.ssrRT?.setSize(hw, hh);
    this.shaftRT?.setSize(Math.max(1, Math.ceil(w / 4)), Math.max(1, Math.ceil(h / 4)));
    this.ldr?.setSize(w, h);
    this.glowRT?.setSize(w, h);
    this.edgesRT?.setSize(w, h); this.weightsRT?.setSize(w, h);
    this.smaaEdges?.setSize(w, h); this.smaaWeights?.setSize(w, h);
    this.n8?.setSize(w, h);
    this.fxPass?.setSize(w, h);
  }

  /** GPU memory held by the targets (bytes, estimate). */
  memoryBytes(): number {
    const px = this.w * this.h;
    let b = px * 8 * Math.max(1, this.cfg.samples) + px * 8 + (this.cfg.samples ? px * 4 * this.cfg.samples : 0) + (this.depth ? px * 4 : 0);
    let lw = this.w, lh = this.h;
    for (let i = 0; i < this.levels.length; i++) { lw = Math.ceil(lw / 2); lh = Math.ceil(lh / 2); b += lw * lh * 8 * (i < this.ups.length ? 2 : 1); }
    const half = Math.ceil(this.w / 2) * Math.ceil(this.h / 2) * 8;
    if (this.aoRT) b += half * 2;
    if (this.dofRT) b += half;
    if (this.ssrRT) b += half;
    if (this.shaftRT) b += Math.ceil(this.w / 4) * Math.ceil(this.h / 4) * 8;
    if (this.ldr) b += px * 4;
    if (this.glowRT) b += px * 8;
    if (this.edgesRT) b += px * 8;
    // N8AO: output + AO ping-pong + accumulation (+ depth / normal downsample at half res)
    b += this.fxPass?.memoryBytes() ?? 0;
    if (this.n8) b += px * 8 + (this.cfg.n8ao?.half ? px / 4 * (8 * 3 + 12) : px * 8 * 3);
    return b;
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  /** `fill` (the stage compositor's performer cams): draws the picture into the scene target itself (several scissored
   *  renders) instead of one render of `scene` from `camera` — pass depth-free grade params then (no AO / SSR / DOF /
   *  haze / shafts / glow: the cams have different cameras). */
  render(scene: THREE.Scene, camera: THREE.Camera, g: GradeParams, fill?: (target: THREE.WebGLRenderTarget) => void) {
    const r = this.renderer;
    const canvasTarget = r.getRenderTarget();
    // a screen FX preset is running: the finished picture goes into the FX pass's target and is drawn to `canvasTarget` with it (src/stage/post/fxPresets.ts)
    const fxOn = FxPass.wanted() && !!(this.fxPass ??= new FxPass());
    const prevTarget = fxOn ? this.fxPass!.begin(this.w, this.h) : canvasTarget;
    const autoClear = r.autoClear;
    r.autoClear = true;
    r.setRenderTarget(this.scene);
    if (fill) {
      const cc = r.getClearColor(this.clearTmp), ca = r.getClearAlpha();
      r.setClearColor(0x000000, 0); r.clear(true, true, true);
      // A multisampled target only resolves (blitFramebuffer) inside the scissor its renders used, so the texture
      // outside the cams kept an older full-frame picture: SMAA and bloom then bled it into the cams' edges (a faint
      // square line along a cut-out's top and sides). One empty render with no scissor resolves the clear first.
      if (this.scene.samples > 0) { this.scene.scissorTest = false; r.setRenderTarget(this.scene); r.render(this.resolveScene, this.quadCam); }
      r.setClearColor(cc, ca);
      r.autoClear = false;
      fill(this.scene);
      this.scene.scissorTest = false; this.scene.viewport.set(0, 0, this.scene.width, this.scene.height); this.scene.scissor.set(0, 0, this.scene.width, this.scene.height);
      r.setRenderTarget(this.scene);
    } else r.render(scene, camera);
    r.autoClear = false;
    const u = this.final.uniforms;
    const cam = camera as THREE.PerspectiveCamera;
    if (this.depth) {
      u.tDepth.value = this.scene.depthTexture;
      (u.uProjInv.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    }
    const hw = Math.ceil(this.w / 2), hh = Math.ceil(this.h / 2);

    // ---- N8AO (its AO term only; the final pass applies it with the performer protection)
    if (this.n8 && this.n8Out) {
      const on = (g.ao ?? 0) > 0.001;
      if (on) {
        const n8 = this.n8;
        // (the check that keeps them off: anything that turned them back on is undone here, said once)
        if (this.n8TransparencyGuard && n8aoTransparencyLeft(n8) && n8aoTransparencyOff(n8) && !this.n8Warned) {
          this.n8Warned = true; console.warn('[post] N8AO transparency passes were switched on again: off (they cost 2 extra scene renders per frame)');
        }
        n8.camera = camera; n8.scene = scene;
        n8.setDepthTexture(this.scene.depthTexture!);
        n8.render(r, this.scene, this.n8Out);
        r.autoClear = false;
        const prot = u.uProt.value as THREE.Vector4[];
        for (let i = 0; i < 4; i++) prot[i].copy(g.protect?.[i] ?? prot[i].set(0, 0, 0, 0));
        u.tAO.value = n8.outputTargetInternal.texture;
      }
      u.uAO.value = on ? g.ao ?? 0 : 0;
    }
    // ---- ambient occlusion (half res + depth-aware blur)
    if (this.aoMat && this.aoRT && this.aoTmp && this.aoBlur) {
      const a = this.aoMat.uniforms;
      (a.uProj.value as THREE.Matrix4).copy(cam.projectionMatrix);
      (a.uStep.value as THREE.Vector2).set(2 / this.w, 2 / this.h);
      a.uRadius.value = g.aoRadius ?? 0.55;
      const prot = a.uProt.value as THREE.Vector4[];
      for (let i = 0; i < 4; i++) prot[i].copy(g.protect?.[i] ?? prot[i].set(0, 0, 0, 0));
      this.pass(this.aoMat, this.aoRT);
      this.aoBlur.uniforms.tSrc.value = this.aoRT.texture;
      (this.aoBlur.uniforms.uDir.value as THREE.Vector2).set(1 / hw, 0);
      this.pass(this.aoBlur, this.aoTmp);
      this.aoBlur.uniforms.tSrc.value = this.aoTmp.texture;
      (this.aoBlur.uniforms.uDir.value as THREE.Vector2).set(0, 1 / hh);
      this.pass(this.aoBlur, this.aoRT);
      u.tAO.value = this.aoRT.texture;
      u.uAO.value = g.ao ?? 0;
    }

    // ---- glossy floor reflections
    if (this.ssrMat && this.ssrRT) {
      const on = !!g.ssr && g.ssr.strength > 0;
      if (on) {
        const s = this.ssrMat.uniforms;
        s.tScene.value = this.scene.texture;
        (s.uProj.value as THREE.Matrix4).copy(cam.projectionMatrix);
        (s.uInvView.value as THREE.Matrix4).copy(cam.matrixWorld);
        (s.uView.value as THREE.Matrix4).copy(cam.matrixWorldInverse);
        s.uPlaneY.value = g.ssr!.y; s.uMaxDist.value = g.ssr!.maxDist;
        (s.uStep.value as THREE.Vector2).set(2 / this.w, 2 / this.h);
        this.pass(this.ssrMat, this.ssrRT);
      }
      u.tSSR.value = this.ssrRT.texture;
      u.uSSR.value = on ? g.ssr!.strength : 0;
    }

    // ---- background depth of field
    if (this.dofMat && this.dofRT) {
      const on = !!g.dof && g.dof.amount > 0.001;
      if (on) {
        const d = this.dofMat.uniforms;
        d.tScene.value = this.scene.texture;
        (d.uTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
        d.uBlur.value = g.dof!.blur / 2;
        u.uFocus.value = g.dof!.focus; u.uRange.value = Math.max(0.2, g.dof!.range);
        this.pass(this.dofMat, this.dofRT);
      }
      u.tDof.value = this.dofRT.texture;
      u.uDofAmt.value = on ? g.dof!.amount : 0;
    }

    // ---- bloom chain (also lights the haze / feeds the shafts)
    const n = this.levels.length;
    const chainOn = n > 0 && (g.bloom > 0.001 || (!!g.haze && g.haze.glow > 0) || (!!g.shafts && g.shafts.strength > 0));
    if (chainOn && this.glowRT) {
      const on = !!g.glow && g.glow.gain > 0;
      this.bright.uniforms.uGlow.value = on ? g.glow!.gain : 0;
      if (on) {
        // additive effects again, into their own buffer, depth-tested against the scene (colour-only clear)
        const sc = g.glow!.scene, bg = sc.background;
        const cc = r.getClearColor(this.glowClearTmp), ca = r.getClearAlpha();
        sc.background = null;
        r.setRenderTarget(this.glowRT);
        r.setClearColor(0x000000, 0);
        r.clear(true, false, false);
        // perf: the main pass already updated every world matrix this frame and nothing moves in between — skip the
        // whole-scene updateMatrixWorld() this second render would do (exact same picture, ~1/3 of that cost saved)
        const au = sc.matrixWorldAutoUpdate;
        if (!fill) sc.matrixWorldAutoUpdate = false;
        try { r.render(sc, g.glow!.camera); } finally { sc.matrixWorldAutoUpdate = au; }
        r.setClearColor(cc, ca);
        sc.background = bg;
      }
    }
    if (chainOn) {
      this.bright.uniforms.tSrc.value = this.scene.texture;
      this.bright.uniforms.uTexel.value.set(1 / this.w, 1 / this.h);
      this.bright.uniforms.uThreshold.value = g.threshold;
      this.pass(this.bright, this.levels[0]);
      for (let i = 1; i < n; i++) {
        const src = this.levels[i - 1];
        this.down.uniforms.tSrc.value = src.texture;
        this.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this.pass(this.down, this.levels[i]);
      }
      // shafts from the half-res bright pass (before the upsample overwrites nothing — levels stay intact)
      if (this.shaftMat && this.shaftRT && g.shafts && g.shafts.strength > 0) {
        const s = this.shaftMat.uniforms;
        s.tSrc.value = this.levels[0].texture;
        const L = s.uL.value as THREE.Vector4[];
        for (let i = 0; i < 4; i++) L[i].copy(g.shafts.pts[i] ?? L[i].set(0, 0, 0, 0));
        s.uLen.value = g.shafts.length; s.uDecay.value = g.shafts.decay; s.uAspect.value = this.w / this.h;
        this.pass(this.shaftMat, this.shaftRT);
      }
      if (this.cfg.haze) u.tGlow.value = this.levels[n - 1].texture;
      // upsample: ups[i] = levels[i] + tent(ups[i+1] | levels[n-1])
      let prev = this.levels[n - 1];
      for (let i = n - 2; i >= 0; i--) {
        this.up.uniforms.tSrc.value = prev.texture;
        this.up.uniforms.tBase.value = this.levels[i].texture;
        this.up.uniforms.uTexel.value.set(1 / prev.width, 1 / prev.height);
        this.up.uniforms.uWeight.value = 1;
        this.pass(this.up, this.ups[i]);
        prev = this.ups[i];
      }
      u.tBloom.value = prev.texture;
    }
    if (this.shaftRT) { u.tShafts.value = this.shaftRT.texture; u.uShafts.value = chainOn && g.shafts ? g.shafts.strength : 0; }
    if (this.cfg.haze) {
      const hz = g.haze;
      (u.uHazeCol.value as THREE.Color).copy(hz?.color ?? BLACK);
      u.uHazeDen.value = hz ? hz.density : 0;
      u.uHazeGlow.value = hz && chainOn ? hz.glow : 0;
    }
    if (this.cfg.lut) { u.tLut.value = g.lut ?? null; u.uLutMix.value = g.lut ? g.lutMix ?? 1 : 0; }
    u.tScene.value = this.scene.texture;
    u.uHasBloom.value = chainOn && g.bloom > 0.001 ? 1 : 0;
    // levels are summed (n contributions) — normalise so the strength reads the same on every tier
    u.uBloom.value = g.bloom / Math.max(1, this.cfg.bloomLevels || n) * 1.6;
    u.uSat.value = g.saturation;
    u.uContrast.value = g.contrast;
    u.uOpaque.value = g.opaque ? 1 : 0;
    u.uVig.value = g.vignette ?? 0;
    u.uPremulOut.value = 0;
    if (this.smaaEdges && this.smaaWeights && this.smaaBlend && this.ldr && this.edgesRT && this.weightsRT && this.smaaReady) {
      u.uPremulOut.value = 1;
      this.pass(this.final, this.ldr);
      this.smaaEdges.uniforms.inputBuffer.value = this.ldr.texture;
      const cc = r.getClearColor(this.clearTmp), ca = r.getClearAlpha();
      r.setRenderTarget(this.edgesRT); r.setClearColor(0x000000, 0); r.clear(true, false, false); r.setClearColor(cc, ca);
      this.pass(this.smaaEdges, this.edgesRT);
      this.smaaWeights.uniforms.inputBuffer.value = this.edgesRT.texture;
      this.pass(this.smaaWeights, this.weightsRT);
      const b = this.smaaBlend.uniforms;
      b.tSrc.value = this.ldr.texture; b.tWeights.value = this.weightsRT.texture; b.uOpaque.value = g.opaque ? 1 : 0;
      (b.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      this.pass(this.smaaBlend, prevTarget);
    } else if (this.fxaaMat && this.ldr) {
      this.pass(this.final, this.ldr);
      this.fxaaMat.uniforms.tSrc.value = this.ldr.texture;
      (this.fxaaMat.uniforms.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      this.pass(this.fxaaMat, prevTarget);
    } else this.pass(this.final, prevTarget);
    if (fxOn) this.fxPass!.finish(r, canvasTarget); else this.fxPass?.idle(performance.now());
    r.autoClear = autoClear;
  }

  dispose() {
    this.scene.depthTexture?.dispose();
    this.scene.dispose();
    if (this.glowRT) this.glowRT.depthTexture = null;
    for (const t of [...this.levels, ...this.ups, this.aoRT, this.aoTmp, this.dofRT, this.ssrRT, this.shaftRT, this.ldr, this.glowRT, this.edgesRT, this.weightsRT, this.n8Out]) t?.dispose();
    for (const m of [this.bright, this.down, this.up, this.final, this.aoMat, this.aoBlur, this.dofMat, this.ssrMat, this.shaftMat, this.fxaaMat, this.smaaEdges, this.smaaWeights, this.smaaBlend]) m?.dispose();
    try { (this.n8 as unknown as { dispose?: () => void } | null)?.dispose?.(); } catch { /* optional */ }
    this.fxPass?.dispose();
    this.fxPass = null;
    this.quad.geometry.dispose();
  }
}
