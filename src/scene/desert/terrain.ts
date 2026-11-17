// CDLOD terrain: one InstancedBufferGeometry patch (16 x 16 quads) drawn once per selected quadtree node in ONE draw
// call; per-instance (origin x, origin z, lod) in a small float DataTexture read with texelFetch(gl_InstanceID), so every
// camera that draws the room (compositor tiles, remote passes) gets its OWN selection uploaded right before its draw
// (DesertWorld.prepareView from onBeforeRender; an instanced attribute would only upload on the next render call). Vertex spacing at lod L = clipmap texel size of level L (0.5 m * 2^L),
// so every vertex reads its height with texelFetch from the matching clipmap level. Geomorphing (odd vertices slide
// onto the coarser grid across [0.8 r_L, r_L]) makes LOD transitions crack-free and pop-free.
// Ranges r_L = R0 * 2^L (R0 by quality, 40..64 m); the crack condition R0 + 22.6 <= 1.6 R0 and the clipmap window
// condition R0 + 30.6 <= 128 both hold for that range (a lod-L node is drawn inside [r(L-1), r(L) + its parent's
// diagonal]; its outer vertices are fully morphed before the coarser neighbour starts morphing; every patch stays inside
// its clipmap window minus the snap margin).
//
// Views far from the clipmap centre (the primary camera) skip the levels whose window would not hold their patches
// (coarser near that camera, never a read outside a window).
// All shading noise is WORLD-anchored (glsl.ts wvn / uAnc): the pattern never moves when the origin rebases.
// Fragment shader: per-pixel macro normal from the finest clipmap level covering the pixel (blended at window edges),
// wind ripples (anti-aliased saw-tooth along the dune wind, faded on slip faces), avalanche streaks on lee faces,
// hardpan cracks, colour by height / slope / lee, curvature AO, banded toon sun, forward-scatter sheen, sparkle,
// footprints, the sand wake astern (SPEC 3.6), analytic ship-shadow capsules, saltation streaks in storms, height-fog
// aerial perspective, mirage, and a soft circular far edge that blends into the sky dome's far-ground band.
import * as THREE from 'three';
import { CLIP_LEVELS, CLIP_RES, TS0, type HeightClipmap } from './clipmap.ts';
import { CLIP_DECODE_GLSL, DESERT_UNIFORMS, NOISE_GLSL, SHADE_GLSL, wn } from './glsl.ts';
import type { DesertUniforms } from './uniforms.ts';

export const PATCH_Q = 16;
export const LODS = CLIP_LEVELS;
export const MAX_PRINTS = 48;
export const MAX_CASTERS = 16;
const PATCH_TEX_W = 64;
const MAX_PATCHES = PATCH_TEX_W * 38;
/** Global height bounds for culling (m, terrain-local y before the group transform); relief raises the top (setRelief). */
const H_MIN = -45, H_MAX = 95;
/** Draw range (m) per quality: the dune sea, and with relief (taller land stacks into silhouettes further out). */
const END: Record<string, number> = { low: 1900, medium: 2300, high: 2600, ultra: 2600 };
const END_RELIEF: Record<string, number> = { low: 2600, medium: 3200, high: 3800, ultra: 4200 };

export const TERRAIN_R0: Record<string, number> = { low: 40, medium: 44, high: 48, ultra: 60 };

const VS = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2DArray;
uniform highp sampler2DArray uH;
uniform highp sampler2D uPatch;       // per instance: origin x, origin z, lod, 0 (this view's selection)
uniform vec4 uClip[${CLIP_LEVELS}];
uniform vec2 uMorph[${CLIP_LEVELS}];
uniform vec3 uCamT;
uniform float uPack;
varying vec3 vP;
varying float vFlat;
varying float vDist;
${CLIP_DECODE_GLSL}
float hTex(vec2 tc, int L) {
  vec2 i = floor(tc); vec2 fr = tc - i; ivec2 c = ivec2(i);
  float a = clipHd(texelFetch(uH, ivec3(c, L), 0));
  if (fr.x == 0.0 && fr.y == 0.0) return a;
  float b = clipHd(texelFetch(uH, ivec3(c + ivec2(1, 0), L), 0)), d = clipHd(texelFetch(uH, ivec3(c + ivec2(0, 1), L), 0)), e = clipHd(texelFetch(uH, ivec3(c + ivec2(1, 1), L), 0));
  return mix(mix(a, b, fr.x), mix(d, e, fr.x), fr.y);
}
void main() {
  vec4 iPatch = texelFetch(uPatch, ivec2(gl_InstanceID % ${PATCH_TEX_W}, gl_InstanceID / ${PATCH_TEX_W}), 0);
  int L = int(iPatch.z + 0.5);
  vec4 cl = uClip[L];
  float ts = cl.z;
  vec2 g = position.xz;
  vec2 wp0 = iPatch.xy + g * ts;
  float dist = distance(wp0, uCamT.xz);
  float k = clamp((dist - uMorph[L].x) * uMorph[L].y, 0.0, 1.0);
  vec2 gm = g - fract(g * 0.5) * 2.0 * k;
  vec2 wp = iPatch.xy + gm * ts;
  vec2 tc = (iPatch.xy - cl.xy) * cl.w + gm;
  float h = hTex(tc, L);
  vP = vec3(wp.x, h, wp.y);
  vFlat = 0.0;
  vDist = distance(vP, uCamT);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, 1.0);
}`;

const FS = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2DArray;
${DESERT_UNIFORMS}
uniform highp sampler2DArray uN;
uniform vec4 uClip[${CLIP_LEVELS}];
uniform vec2 uWindCS;
uniform vec4 uPrint[${MAX_PRINTS}];   // x, z, cos yaw, sin yaw (terrain-local)
uniform vec4 uPrintB[${MAX_PRINTS}];  // half-width, strength, length / width, 0
uniform int uPrintN;
uniform vec4 uPrintBound;             // centre x, z, radius (prints live inside it)
uniform vec4 uCapA[${MAX_CASTERS}];   // segment start xyz + radius (terrain-local)
uniform vec4 uCapB[${MAX_CASTERS}];   // segment end xyz
uniform int uCapN;
uniform vec4 uCapBound;               // centre x, z, radius (shadows fall inside it)
uniform vec3 uSand; uniform vec3 uCrest; uniform vec3 uTrough; uniform vec3 uLee; uniform vec3 uPan; uniform vec3 uCrack;
uniform vec3 uRockA; uniform vec3 uRockB; uniform vec3 uRockC;   // relief rock: pale ochre, rust, dark strata
uniform vec4 uSaltZ[2];               // salt-flat regions: centre x, z (terrain-local), radius, strength (desert/marks.ts)
uniform vec3 uFarGround;              // lit flat sand far away (matches the sky dome's below-horizon band)
uniform vec2 uEnd;                    // fade start, end (m)
uniform vec3 uMirage;                 // sky colour for the mirage
uniform float uMirageK;
uniform vec4 uWake;                   // ship x, z (terrain-local), strength, journey distance mod 4096 (wake streak anchor)
uniform vec2 uWakeDir;                // ship forward (terrain-local, unit)
uniform float uPack;
varying vec3 vP;
varying float vFlat;
varying float vDist;
${NOISE_GLSL}
${SHADE_GLSL}
${CLIP_DECODE_GLSL}
vec4 sampleN(vec2 p) {
  for (int l = 0; l < ${CLIP_LEVELS}; l++) {
    vec4 c = uClip[l];
    vec2 ctr = c.xy + ${(CLIP_RES / 2).toFixed(1)} * c.z;
    float m = max(abs(p.x - ctr.x), abs(p.y - ctr.y)) * c.w / ${(CLIP_RES / 2).toFixed(1)};
    if (m < 0.96 || l == ${CLIP_LEVELS - 1}) {
      vec4 a = texture(uN, vec3(((p - c.xy) * c.w + 0.5) / ${CLIP_RES.toFixed(1)}, float(l)));
      float b = smoothstep(0.78, 0.96, m);
      if (b > 0.0 && l < ${CLIP_LEVELS - 1}) {
        vec4 c1 = uClip[l + 1];
        a = mix(a, texture(uN, vec3(((p - c1.xy) * c1.w + 0.5) / ${CLIP_RES.toFixed(1)}, float(l + 1))), b);
      }
      return clipNd(a);
    }
  }
  return vec4(0.0, 0.0, 0.0, 0.0);
}
// closest distance between the ray (o + t d, t > 0) and the segment a-b
float rayCap(vec3 o, vec3 d, vec3 a, vec3 b) {
  vec3 u = b - a, w = o - a;
  float A = dot(d, d), B = dot(d, u), C = dot(u, u), Dd = dot(d, w), E = dot(u, w);
  float den = A * C - B * B;
  float s = den > 1e-6 ? clamp((A * E - B * Dd) / den, 0.0, 1.0) : 0.0;
  float t = max(0.0, (B * s - Dd) / A);
  s = clamp((B * t + E) / C, 0.0, 1.0);
  t = max(0.0, (B * s - Dd) / A);
  return length(w + d * t - u * s);
}
float sawRipple(float t) { t = fract(t); return t < 0.78 ? t / 0.78 : (1.0 - t) / 0.22; }
void main() {
  vec3 p = vP;
  float dist = vDist;
  if (dist > uEnd.y) discard;
  vec4 nn = sampleN(p.xz);
  vec3 N = normalize(vec3(nn.x, sqrt(max(0.0, 1.0 - nn.x * nn.x - nn.y * nn.y)), nn.y));
  float curv = nn.z;            // + trough, - crest (m)
  float flatK = nn.w;
  vec2 w = uWindCS;              // downwind (u axis)
  vec2 wp = vec2(-w.y, w.x);
  vec2 pw = p.xz + uAnc.xy;                                              // world mod 4096 m (shading lattices)
  vec2 puv = vec2(dot(p.xz, w) + uAnc.z, dot(p.xz, wp) + uAnc.w);        // wind frame, world mod 4096 m
  vec3 V = normalize(uCamT - p);
  float slope = 1.0 - N.y;
  // relief rock (shared/desert/height.ts RELIEF): cliffs steeper than any dune (sand rests at ~34 deg), above the dune
  // troughs; mesa caps and ridge tops are drifted rock
  float rock = smoothstep(0.2, 0.34, slope) * smoothstep(12.0, 28.0, p.y);
  // (far away the clipmap's coarse normals soften the cliffs: the high ground keeps its rock there too)
  rock = max(rock, smoothstep(0.1, 0.22, slope) * smoothstep(45.0, 90.0, p.y) * smoothstep(500.0, 1500.0, dist));
  float lee = smoothstep(0.12, 0.35, dot(N.xz, w)) * smoothstep(0.08, 0.25, slope) * (1.0 - rock);
  // ---- micro relief: ripples (saw-tooth, asymmetric) on stoss / flat sand, avalanche streaks on slip faces
  float ripA = (1.0 - lee) * (1.0 - flatK * 0.85) * (uQ > 0.5 ? 1.0 : 0.6) * (1.0 - rock);
  float ph = dot(p.xz, w) / 0.55 + uAncPh + 0.35 * wvn(wq(pw, ${wn(1 / 1.9)}), ${wn(1 / 1.9)}, 11u) + 0.6 * wvn(wq(pw, ${wn(0.05, 0.11)}), ${wn(0.05, 0.11)}, 12u);
  float fw = fwidth(ph);
  ripA *= 1.0 - smoothstep(0.06, 0.2, fw);
  vec3 Np = N;
  vec3 ripN = vec3(0.0);
  float ripShade = 0.0;
  if (ripA > 0.001) {
    float t = fract(ph);
    float dRip = t < 0.78 ? 1.0 / 0.78 : -1.0 / 0.22;
    ripN = vec3(w.x, 0.0, w.y) * (-dRip * 0.16 * ripA);
    ripShade = (sawRipple(ph) - 0.55) * ripA;
  }
  // avalanche streaks: stretched along the fall line on lee faces (two fixed wind-frame fields blended by the fall
  // line: down-wind slip faces / seif flanks; a per-pixel rotation would swim and could not be world-anchored)
  vec2 fall = normalize(N.xz + vec2(1e-4));
  float stU = wvn(wq(puv, ${wn(0.08, 1.6)}), ${wn(0.08, 1.6)}, 13u);
  float stV = wvn(wq(puv.yx, ${wn(0.08, 1.6)}), ${wn(0.08, 1.6)}, 14u);
  float streak = mix(stV, stU, smoothstep(0.35, 0.75, abs(dot(fall, w))));
  // ---- footprints (inside the ship's disc only)
  float printDark = 0.0;
  vec2 dpb = p.xz - uPrintBound.xy;
  if (uPrintN > 0 && dot(dpb, dpb) < uPrintBound.z * uPrintBound.z) {
    for (int i = 0; i < ${MAX_PRINTS}; i++) {
      if (i >= uPrintN) break;
      vec4 pr = uPrint[i]; vec4 pb = uPrintB[i];
      vec2 d = p.xz - pr.xy;
      if (dot(d, d) > pb.x * pb.x * pb.z * pb.z * 2.2) continue;
      vec2 q = vec2(d.x * pr.z + d.y * pr.w, -d.x * pr.w + d.y * pr.z) / pb.x;
      q.y /= max(1.0, pb.z);
      float r = length(q);
      // bowl (depth ~ 0.18 r) + raised rim: gradient of the height profile in print space
      float g = r < 1.0 ? 0.36 * r : -0.9 * (r - 1.0) * exp(-pow((r - 1.08) / 0.16, 2.0)) * 2.0;
      vec2 gq = r > 1e-4 ? q / r * g * pb.y : vec2(0.0);
      vec2 gw = vec2(gq.x * pr.z - gq.y * pr.w, gq.x * pr.w + gq.y * pr.z);
      Np += vec3(gw.x, 0.0, gw.y);
      float inside = (1.0 - smoothstep(0.85, 1.12, r)) * pb.y;
      printDark = max(printDark, inside);
      ripA *= 1.0 - inside;
    }
  }
  // ---- sand wake astern (SPEC 3.6): churned, darker sand in long streaks fixed on the ground (anchored on the route
  // distance), within ~60 m behind the ship above 3.5 m/s
  float wake = 0.0;
  if (uWake.z > 0.001) {
    vec2 rel = p.xz - uWake.xy;
    float back = -dot(rel, uWakeDir), lat = dot(rel, vec2(-uWakeDir.y, uWakeDir.x));
    if (back > -2.0 && back < 75.0 && abs(lat) < 14.0) {
      float m = smoothstep(-2.0, 10.0, back) * (1.0 - smoothstep(40.0, 72.0, back)) * (1.0 - smoothstep(8.0, 13.5, abs(lat)));
      float sq = (uWake.w - back) * ${String(Math.round(0.09 * 4096) / 4096)};
      float st = wvn(vec2(lat * 1.3 + 512.0, sq), ivec2(4096, ${Math.round(0.09 * 4096)}), 27u);
      wake = m * uWake.z * (0.55 + 0.45 * smoothstep(0.3, 0.75, st));
      ripA *= 1.0 - 0.85 * m * uWake.z;
    }
  }
  N = normalize(Np);
  vec3 Nr = normalize(Np + ripN);
  // ---- albedo
  float hk = smoothstep(-8.0, 30.0, p.y);
  vec3 alb = mix(uTrough, uSand, smoothstep(0.0, 0.6, hk));
  alb = mix(alb, uCrest, smoothstep(0.45, 1.0, hk) * 0.55 + smoothstep(0.05, 0.6, -curv) * 0.35);
  alb = mix(alb, uLee, lee * (0.55 + 0.25 * streak));
  alb = mix(alb, uTrough, smoothstep(0.1, 1.2, curv) * 0.35);
  // hardpan: paler, cracked in the flattest middle, patchy wind-blown sand over it
  if (flatK > 0.02) {
    // two octaves on differently-oriented lattices (world / wind frame): no square value-noise blocks through the threshold
    float sandCover = smoothstep(0.35, 0.75, wvn(wq(pw, ${wn(0.045)}), ${wn(0.045)}, 15u) * 0.7 + wvn(wq(puv, ${wn(0.21)}), ${wn(0.21)}, 16u) * 0.3);
    float edge = 0.0;
    if (dist < 90.0) {
      vec2 cw6 = wq(pw, ${wn(0.6)});
      vec2 cq = wq(pw, ${wn(0.8)}) + vec2(wvn(cw6, ${wn(0.6)}, 17u), wvn(cw6 + 7.0, ${wn(0.6)}, 18u)) * 0.6;
      vec2 ci = floor(cq), cf = cq - ci;
      float md = 9.0, md2 = 9.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        ivec2 cc = wwrap(ci + o, ${wn(0.8)});
        vec2 r = o + vec2(whf(cc, 19u), whf(cc, 20u)) * 0.85 - cf;
        float dd = dot(r, r);
        if (dd < md) { md2 = md; md = dd; } else if (dd < md2) md2 = dd;
      }
      edge = (1.0 - smoothstep(0.0, 0.045, sqrt(md2) - sqrt(md))) * (1.0 - smoothstep(35.0, 90.0, dist));
      edge *= smoothstep(0.6, 0.95, flatK) * (1.0 - sandCover);
    }
    vec3 pan = mix(uPan, uCrack, edge * 0.55);
    alb = mix(alb, pan, flatK * (1.0 - sandCover * 0.65) * smoothstep(0.0, 0.08, 0.12 - slope + 0.04));
  }
  // salt flats (a region rule): the flats and the low ground crust over white, with sandy polygon seams near the lens
  float salt = 0.0;
  for (int i = 0; i < 2; i++) { vec4 z = uSaltZ[i]; if (z.w > 0.0) salt = max(salt, z.w * (1.0 - smoothstep(z.z * 0.7, z.z, length(p.xz - z.xy)))); }
  if (salt > 0.001) {
    float lowK = 1.0 - smoothstep(-2.0, 9.0, p.y - uFog.z);
    float crustN = wvn(wq(pw, ${wn(0.11)}), ${wn(0.11)}, 23u);
    float k = salt * clamp(flatK * 1.4 + lowK * 1.1 - slope * 1.6, 0.0, 1.0) * smoothstep(0.1, 0.4, crustN + 0.3);
    alb = mix(alb, vec3(0.83, 0.8, 0.74) * (0.92 + 0.1 * crustN), k);
  }
  alb *= 0.94 + 0.12 * wvn(wq(pw, ${wn(0.07)}), ${wn(0.07)}, 21u) - 0.05 * wvn(wq(puv, ${wn(0.9)}), ${wn(0.9)}, 22u);
  // rock: horizontal strata (warped a little, world-anchored), rust and pale ochre layers with dark seams; caprock on the
  // high flats shows through drifted sand
  float cap = smoothstep(46.0, 72.0, p.y) * (1.0 - rock) * smoothstep(0.35, 0.7, wvn(wq(pw, ${wn(0.03)}), ${wn(0.03)}, 31u));
  if (rock + cap > 0.001) {
    // eroded rock: strata of uneven thickness (the band scale itself varies along the wall), wavy, with colour noise in
    // every band, brighter ledge lips, dark seams; vertical gullies (noise that only varies horizontally: it streaks
    // straight down any wall) cut into the face, with their own shading normal
    float thick = 0.8 + 0.45 * wvn(wq(pw, ${wn(0.006)}), ${wn(0.006)}, 36u);
    float sy = p.y * 0.16 * thick + 1.6 * wvn(wq(pw, ${wn(0.004)}), ${wn(0.004)}, 32u) + 0.35 * wvn(wq(pw, ${wn(0.05)}), ${wn(0.05)}, 33u)
      + 0.18 * wvn(wq(pw, ${wn(0.35)}), ${wn(0.35)}, 37u);
    float band = fract(sy), layer = wcell(vec2(floor(sy), 3.0), ivec2(4096, 8), 34u);
    vec3 rc = mix(uRockB, uRockA, smoothstep(0.25, 0.75, layer));
    rc *= 0.82 + 0.3 * wvn(wq(pw + vec2(p.y * 0.7, 0.0), ${wn(0.12)}), ${wn(0.12)}, 38u);
    rc = mix(rc, uRockA * 1.12, smoothstep(0.84, 0.98, band) * 0.45);
    rc = mix(rc, uRockC, (1.0 - smoothstep(0.0, 0.07, band)) * 0.7);
    rc *= 0.86 + 0.24 * wvn(wq(pw, ${wn(0.25, 0.04)}), ${wn(0.25, 0.04)}, 35u);
    float gq = 0.6 * wvn(wq(pw, ${wn(0.07)}), ${wn(0.07)}, 39u) + 0.4 * wvn(wq(pw, ${wn(0.21)}), ${wn(0.21)}, 40u);
    float gx = 0.6 * wvn(wq(pw + vec2(0.8, 0.0), ${wn(0.07)}), ${wn(0.07)}, 39u) + 0.4 * wvn(wq(pw + vec2(0.8, 0.0), ${wn(0.21)}), ${wn(0.21)}, 40u);
    float gz = 0.6 * wvn(wq(pw + vec2(0.0, 0.8), ${wn(0.07)}), ${wn(0.07)}, 39u) + 0.4 * wvn(wq(pw + vec2(0.0, 0.8), ${wn(0.21)}), ${wn(0.21)}, 40u);
    float gully = smoothstep(0.58, 0.8, gq) * rock;
    rc *= 1.0 - 0.38 * gully;
    N = normalize(N - vec3(gx - gq, 0.0, gz - gq) * 9.0 * rock);
    alb = mix(alb, rc, max(rock, cap * 0.55));
  }
  // talus: rubble on the slopes at the foot of the cliffs (pebbly rock blotches between the sand)
  float talusK = smoothstep(0.08, 0.2, slope) * (1.0 - rock) * smoothstep(6.0, 22.0, p.y) * smoothstep(900.0, 300.0, dist);
  if (talusK > 0.01) {
    float pc = wcell(wq(pw, ${wn(0.9)}), ${wn(0.9)}, 41u), pb = wvn(wq(pw, ${wn(0.15)}), ${wn(0.15)}, 42u);
    vec3 rub = mix(uRockB * 0.85, uRockA, pc) * (0.85 + 0.3 * pb);
    alb = mix(alb, rub, talusK * smoothstep(0.35, 0.6, pc * 0.6 + pb * 0.5) * 0.8);
  }
  alb = mix(alb, alb * vec3(0.78, 0.7, 0.66), printDark * 0.8);
  alb = mix(alb, alb * vec3(0.8, 0.74, 0.7), wake * 0.75);
  // moonlight: sand reads cool at night, but stays SAND (a warm grey-beige keeps some of its hue: never snow); lee slopes
  // and troughs go a deeper blue-grey
  float nightK = 1.0 - uDayK;
  float lum = dot(alb, vec3(0.3, 0.59, 0.11));
  vec3 moonSand = mix(vec3(lum) * vec3(0.86, 0.88, 0.98), alb, 0.45) * 0.88;
  alb = mix(alb, moonSand, nightK * 0.75);
  alb = mix(alb, alb * vec3(0.66, 0.74, 0.98), nightK * (lee * 0.7 + 0.45 * smoothstep(0.1, 1.4, curv)));
  // ---- shadows: ship capsules along the sun ray (inside the ship's disc only)
  float sh = 1.0;
  vec2 dcb = p.xz - uCapBound.xy;
  if (uCapN > 0 && uSunT.y > 0.02 && dot(dcb, dcb) < uCapBound.z * uCapBound.z) {
    for (int i = 0; i < ${MAX_CASTERS}; i++) {
      if (i >= uCapN) break;
      float d = rayCap(p, uSunT, uCapA[i].xyz, uCapB[i].xyz);
      sh = min(sh, smoothstep(uCapA[i].w * 0.82, uCapA[i].w * 1.05, d));
    }
    sh = mix(1.0, sh, 0.85);
  }
  // ---- lighting
  float ao = clamp(1.0 - curv * 0.18, 0.6, 1.08);
  vec3 col = dLight(alb, N, sh, ao);
  // ripples: their own non-banded micro light (cel bands would flatten them) + crest / trough tone; at night the low moon
  // rakes them harder (the moonlit dune texture)
  col *= 1.0 + clamp(dot(Nr - N, uSunT) * mix(3.6, 2.4, uDayK), -0.5, 0.36) * sh * mix(0.85, 1.0, uDayK) + ripShade * mix(0.12, 0.07, uDayK);
  // day: the dune SHAPE - faces turned from the sun fall into warm shade, crests catch a bright rim line (the SAND look:
  // long raking light, every dune readable)
  float crestK = smoothstep(0.35, 1.4, -curv);
  if (uDayK > 0.01) {
    float faceD = smoothstep(-0.12, 0.42, dot(N, uSunT));
    col *= mix(1.0, 0.66 + 0.34 * faceD, uDayK * (1.0 - uStorm) * (1.0 - rock * 0.4));
    col += uSunCol * alb * 0.22 * crestK * faceD * uDayK * (1.0 - uStorm);
  }
  // night: the dune SHAPE reads under the moon - faces turned away fall into cool shade, troughs darker
  if (nightK > 0.01) {
    float face = smoothstep(-0.15, 0.45, dot(N, uSunT));
    col *= mix(1.0, 0.5 + 0.5 * face, nightK * 0.85);
    col = mix(col, col * vec3(0.72, 0.8, 1.05), nightK * (1.0 - face) * 0.6);
    col *= 1.0 - nightK * 0.3 * smoothstep(0.1, 1.6, curv);
    // wind-combed streaks + broad patches of brighter / darker sand (the flat stretches never read as one pale sheet)
    float comb = wvn(wq(puv, ${wn(0.03, 0.22)}), ${wn(0.03, 0.22)}, 28u);
    float patchN = wvn(wq(pw, ${wn(0.008)}), ${wn(0.008)}, 29u);
    col *= 1.0 + nightK * (0.34 * (comb - 0.5) + 0.3 * (patchN - 0.5));
    // a cool moonlit rim on the crests and the cliff edges (grazing), so the relief reads against the dark
    float rimV = pow(1.0 - max(dot(N, V), 0.0), 2.5);
    col += vec3(0.13, 0.18, 0.32) * length(uSunCol) * 1.4 * nightK * (crestK * 0.8 + rock * 0.5) * (0.35 + 0.65 * rimV) * (0.6 + 0.4 * face);
  }
  // the burning wrecks' warm light pools on the sand round them
  col += alb * dFireLight(p, N);
  // forward-scatter sheen: golden edges with a low sun
  float sheen = pow(1.0 - max(dot(N, V), 0.0), 4.0) * pow(max(dot(-V, uSunT), 0.0), 2.0);
  col += uSunCol * sheen * 0.35 * sh;
  // sparkle (High+): tiny mica glints facing the half-vector - by moonlight too (cool, a little further out)
  float spR = mix(60.0, 36.0, uDayK);
  if (uQ > 1.5 && dist < spR) {
    float gl = step(0.997, wcell(wq(pw, ${wn(22)}), ${wn(22)}, 23u));
    vec3 Hh = normalize(uSunT + V);
    vec3 glc = mix(vec3(0.75, 0.85, 1.0) * 4.5 * max(length(uSunCol), 0.08), uSunCol * 2.0, uDayK);
    col += glc * gl * pow(max(dot(N, Hh), 0.0), 40.0) * (1.0 - smoothstep(spR * 0.4, spR, dist)) * sh;
  }
  // storm saltation: bright sand streaks racing over the ground near the camera
  if (uStorm > 0.02 && dist < 70.0) {
    // along / across the storm wind (= the dune wind, uWindT = uWindCS * speed): the anchored wind frame
    float s = wvn(wq(puv, ${wn(0.35, 3.5)}) - vec2(uTime * 9.0, 0.0), ${wn(0.35, 3.5)}, 24u) * wvn(wq(puv, ${wn(0.11, 0.9)}) - vec2(uTime * 4.0, 0.0), ${wn(0.11, 0.9)}, 25u);
    col = mix(col, uHazeCol * 1.15, smoothstep(0.35, 0.8, s) * uStorm * (1.0 - smoothstep(25.0, 70.0, dist)) * 0.6);
  }
  // mirage: far, grazing, under a high sun -> the sky shimmers on the sand
  if (uMirageK > 0.01 && dist > 500.0) {
    // signed: only sand BELOW eye level shimmers (a crest above the eye never mirrors the sky)
    float slope = (uCamT.y - p.y) / dist;
    float graze = smoothstep(-0.0005, 0.0015, slope) * (1.0 - smoothstep(0.004, 0.03, slope));
    float sh2 = 0.75 + 0.25 * wvn(wq(pw, ${wn(0.02)}) + vec2(uTime * 0.7, -uTime * 0.4), ${wn(0.02)}, 26u);
    col = mix(col, uMirage * sh2, graze * smoothstep(600.0, 1500.0, dist) * uMirageK);
  }
  // far edge: blend into the far-ground colour the sky dome draws below the horizon
  // (relief standing above the eye line fades into the haze instead: a ridge at the draw range never shows a cut edge)
  float above = smoothstep(-0.004, 0.014, (p.y - uCamT.y) / max(dist, 1.0));
  col = mix(col, mix(uFarGround, dHaze(normalize(p - uCamT)), above), smoothstep(uEnd.x, uEnd.y, dist));
  col = dApplyFog(col, uCamT, p);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const hexL = (h: string) => new THREE.Color(h);

export class DesertTerrain {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly material: THREE.ShaderMaterial;
  private patchData: Float32Array;
  private patchTex: THREE.DataTexture;
  private patchN = -1;
  private morph = { value: Array.from({ length: LODS }, () => new THREE.Vector2()) };
  readonly u: Record<string, THREE.IUniform>;
  private r0 = TERRAIN_R0.high;
  private ranges: number[] = [];
  /** Draw range (m). */
  end = 2600;
  /** Relief amplitude (DesertWorldSpec.relief): raises the culling top and the draw range. */
  private relief = 0;
  private hMax = H_MAX;
  private hMin = H_MIN;
  private q = 'high';
  private frustum = new THREE.Frustum();
  private box = new THREE.Box3();
  stats = { patches: 0, tris: 0, nodes: 0, perLod: [] as number[], lmin: 0, uploads: 0 };
  /** Finest clipmap level the last selection could use (0 for the primary camera). */
  lmin = 0;
  private uploads = 0;

  constructor(clip: HeightClipmap, du: DesertUniforms, windCS: { value: THREE.Vector2 }) {
    const g = new THREE.InstancedBufferGeometry();
    const n = PATCH_Q + 1;
    const pos = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = (j * n + i) * 3; pos[k] = i; pos[k + 1] = 0; pos[k + 2] = j; }
    const idx: number[] = [];
    for (let j = 0; j < PATCH_Q; j++) for (let i = 0; i < PATCH_Q; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      // alternate the diagonal so morphed (coarse) triangles stay symmetric
      if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
    }
    g.setIndex(idx);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.instanceCount = 0;
    this.patchData = new Float32Array(MAX_PATCHES * 4);
    this.patchTex = new THREE.DataTexture(this.patchData, PATCH_TEX_W, MAX_PATCHES / PATCH_TEX_W, THREE.RGBAFormat, THREE.FloatType);
    this.patchTex.minFilter = THREE.NearestFilter; this.patchTex.magFilter = THREE.NearestFilter; this.patchTex.generateMipmaps = false;
    this.patchTex.name = 'vtp:desert:patches';
    this.patchTex.needsUpdate = true;
    this.u = {
      ...du,
      uH: clip.hTexU, uN: clip.nTexU, uPack: clip.packU, uPatch: { value: this.patchTex }, uClip: clip.clipU, uMorph: this.morph, uWindCS: windCS,
      uWake: { value: new THREE.Vector4() }, uWakeDir: { value: new THREE.Vector2(0, -1) },
      uPrint: { value: Array.from({ length: MAX_PRINTS }, () => new THREE.Vector4()) }, uPrintB: { value: Array.from({ length: MAX_PRINTS }, () => new THREE.Vector4()) }, uPrintN: { value: 0 },
      uPrintBound: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCapA: { value: Array.from({ length: MAX_CASTERS }, () => new THREE.Vector4()) }, uCapB: { value: Array.from({ length: MAX_CASTERS }, () => new THREE.Vector4()) }, uCapN: { value: 0 },
      uCapBound: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSand: { value: hexL('#d9a25f') }, uCrest: { value: hexL('#f2cd92') }, uTrough: { value: hexL('#a0603e') }, uLee: { value: hexL('#c27a48') },
      uPan: { value: hexL('#cfae86') }, uCrack: { value: hexL('#8f6b4c') },
      uRockA: { value: hexL('#a5633b') }, uRockB: { value: hexL('#723620') }, uRockC: { value: hexL('#3b1c11') },
      uSaltZ: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uFarGround: { value: new THREE.Color(0.6, 0.45, 0.3) }, uEnd: { value: new THREE.Vector2(2200, 2600) },
      uMirage: { value: new THREE.Color(0.7, 0.75, 0.8) }, uMirageK: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.u, fog: false, lights: false });
    this.material.name = 'vtp:desert:terrain';
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'vtp:desert:terrain';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;          // after the ship / room: pixels under the hull are early-Z rejected
    this.setQuality('high');
  }

  /** The world's relief amplitude (0 = dunes only): culling bounds + draw range. Uniform-only. */
  setRelief(amp: number, maxH: number, minH = 0) { this.relief = amp; this.hMax = H_MAX + maxH; this.hMin = H_MIN + Math.min(0, minH); this.setQuality(this.q); }

  setQuality(q: string) {
    this.q = q;
    this.r0 = TERRAIN_R0[q] ?? TERRAIN_R0.high;
    this.end = (this.relief > 0 ? END_RELIEF : END)[q] ?? 2600;
    this.ranges = [];
    for (let l = 0; l < LODS; l++) this.ranges.push(this.r0 * 2 ** l);
    for (let l = 0; l < LODS; l++) {
      const end = l === LODS - 1 ? 1e9 : this.ranges[l], start = end * 0.8;
      this.morph.value[l].set(start, 1 / Math.max(1e-3, end - start));
    }
    (this.u.uEnd.value as THREE.Vector2).set(this.end * 0.82, this.end);
  }

  /** Select patches for a camera (terrain-local position + view-projection that maps terrain-local -> clip). With the
   *  clipmap, levels whose window would not hold this camera's patches are skipped (lmin: views far from the clipmap's
   *  centre draw coarser terrain near them instead of reading outside a window). */
  select(camT: THREE.Vector3, viewProjT: THREE.Matrix4, clip?: HeightClipmap) {
    this.frustum.setFromProjectionMatrix(viewProjT);
    const top = LODS - 1;
    let lmin = 0;
    if (clip) {
      for (; lmin < top; lmin++) {
        const L = clip.levels[lmin];
        // a level-l patch lies within ranges[l] + its parent's diagonal (22.6 * 2^l) of the camera; +1 texel for the
        // bilinear read; the window holds [centre - 256 ts, centre + 255 ts]
        const reach = (this.r0 + 24) * 2 ** lmin, half = (CLIP_RES / 2 - 2) * L.ts;
        if (L.valid && Math.max(Math.abs(camT.x - L.cx), Math.abs(camT.z - L.cz)) + reach <= half) break;
      }
    }
    this.lmin = lmin;
    const P = PATCH_Q * TS0 * 2 ** top;
    const reach = Math.min(this.end, this.ranges[top]) + P;
    const x0 = Math.floor((camT.x - reach) / P), x1 = Math.floor((camT.x + reach) / P);
    const z0 = Math.floor((camT.z - reach) / P), z1 = Math.floor((camT.z + reach) / P);
    this.nSel = 0; this.nodes = 0;
    for (let zi = z0; zi <= z1; zi++) for (let xi = x0; xi <= x1; xi++) this.rec(camT, xi * P, zi * P, top, lmin);
    // upload only when this selection differs from the one on the GPU (views alternate: then it uploads each time)
    const a = this.patchData, b = this.selData, n = this.nSel;
    const per = this.stats.perLod;
    per.length = LODS; per.fill(0);
    let same = n === this.patchN;
    for (let k = 0; k < n * 4; k += 4) {
      if (same && (a[k] !== b[k] || a[k + 1] !== b[k + 1] || a[k + 2] !== b[k + 2])) same = false;
      a[k] = b[k]; a[k + 1] = b[k + 1]; a[k + 2] = b[k + 2]; a[k + 3] = 0; per[b[k + 2]]++;
    }
    if (!same) { this.patchTex.needsUpdate = true; this.patchN = n; this.uploads++; }
    this.mesh.geometry.instanceCount = n;
    const st = this.stats;
    st.patches = n; st.tris = n * PATCH_Q * PATCH_Q * 2; st.nodes = this.nodes; st.lmin = lmin; st.uploads = this.uploads;
  }

  private selData = new Float32Array(MAX_PATCHES * 4);
  private nSel = 0;
  private nodes = 0;
  /** Quadtree descent (no allocation): draw the node at level l, or split it into four. */
  private rec(camT: THREE.Vector3, x: number, z: number, l: number, lmin: number) {
    this.nodes++;
    const size = PATCH_Q * TS0 * 2 ** l;
    if (!this.hit(camT, x, z, size, this.end + size)) return;
    this.box.min.set(x, this.hMin, z); this.box.max.set(x + size, this.hMax, z + size);
    if (!this.frustum.intersectsBox(this.box)) return;
    if (l > lmin && this.hit(camT, x, z, size, this.ranges[l - 1])) {
      const hs = size / 2;
      this.rec(camT, x, z, l - 1, lmin); this.rec(camT, x + hs, z, l - 1, lmin); this.rec(camT, x, z + hs, l - 1, lmin); this.rec(camT, x + hs, z + hs, l - 1, lmin);
      return;
    }
    if (this.nSel < MAX_PATCHES) { const k = this.nSel * 4; this.selData[k] = x; this.selData[k + 1] = z; this.selData[k + 2] = l; this.nSel++; }
  }

  /** Square node [x, x+size]^2 intersects the circle (camera xz, r)? */
  private hit(c: THREE.Vector3, x: number, z: number, size: number, r: number) {
    const dx = Math.max(x - c.x, 0, c.x - (x + size)), dz = Math.max(z - c.z, 0, c.z - (z + size));
    return dx * dx + dz * dz <= r * r;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.patchTex.dispose(); }
}
