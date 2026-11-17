// GLSL twin of shared/desert/height.ts (generated from the same DUNE constants + SITES table, so a constant change
// reaches both) plus the shader chunks every desert material shares: uniforms, lighting, aerial perspective,
// distance compression. GLSL3 (WebGL2): uint hashes identical to Math.imul.
import { CORRIDOR_N, DUNE, MAX_FLATS, PHASES, RELIEF, SITES, SITE_BASE, SITE_COUNT, type Site } from '../../../shared/desert/height.ts';
import { OCT_MUL, OCT_SEED } from '../../../shared/desert/noise.ts';

const f = (x: number) => { const s = String(x); return /[.eE]/.test(s) ? s : `${s}.0`; };

/** World-anchored shading noise period (m): every shading lattice wraps exactly every ANCHOR_P metres, and the terrain
 *  origin's offset mod ANCHOR_P comes in as uAnc, so the origin's multiple of ANCHOR_P drops out (no pop on rebase). */
export const ANCHOR_P = 4096;
/** Fire light pools (DESERT_UNIFORMS uFires): the nearest burning wrecks light the sand round them. */
export const MAX_FIRES = 6;
/** Cells per ANCHOR_P metres for a feature frequency k (cells per metre), rounded to an integer (the wrap is exact). */
export const wcells = (k: number) => Math.max(1, Math.round(k * ANCHOR_P));
/** GLSL ivec2 cell counts for frequencies (kx, kz) (cells per metre). */
export const wn = (kx: number, kz = kx) => `ivec2(${wcells(kx)}, ${wcells(kz)})`;

/** Noise + hash primitives (no uniforms). */
export const NOISE_GLSL = /* glsl */ `
uint dh2(uint s, ivec2 c) {
  uvec2 w = uvec2(c) & 4095u;
  uint h = s ^ (w.x * 0x27d4eb2du) ^ (w.y * 0x165667b1u);
  h = (h ^ (h >> 15)) * 0x85ebca6bu;
  h = (h ^ (h >> 13)) * 0xc2b2ae35u;
  return h ^ (h >> 16);
}
float dvn(uint s, vec2 p) {
  vec2 i = floor(p), fr = p - i, u = fr * fr * (3.0 - 2.0 * fr);
  ivec2 c = ivec2(i);
  float a = float(dh2(s, c)) * 2.3283064365386963e-10, b = float(dh2(s, c + ivec2(1, 0))) * 2.3283064365386963e-10;
  float d = float(dh2(s, c + ivec2(0, 1))) * 2.3283064365386963e-10, e = float(dh2(s, c + ivec2(1, 1))) * 2.3283064365386963e-10;
  return a + (b - a) * u.x + (d - a) * u.y + (a - b - d + e) * u.x * u.y;
}
// value noise at lattice cell base + p (base: exact integer part of a far-away origin offset; p: small, precise)
float dvnO(uint s, ivec2 base, vec2 p) {
  vec2 i = floor(p), fr = p - i, u = fr * fr * (3.0 - 2.0 * fr);
  ivec2 c = ivec2(i) + base;
  float a = float(dh2(s, c)) * 2.3283064365386963e-10, b = float(dh2(s, c + ivec2(1, 0))) * 2.3283064365386963e-10;
  float d = float(dh2(s, c + ivec2(0, 1))) * 2.3283064365386963e-10, e = float(dh2(s, c + ivec2(1, 1))) * 2.3283064365386963e-10;
  return a + (b - a) * u.x + (d - a) * u.y + (a - b - d + e) * u.x * u.y;
}
// cheap float hash / value noise for detail that is NOT tied to the ground (uv-space puffs, the haboob sheet, sky)
float hf(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnf(vec2 p) { vec2 i = floor(p), fr = fract(p); fr = fr * fr * (3.0 - 2.0 * fr);
  return mix(mix(hf(i), hf(i + vec2(1.0, 0.0)), fr.x), mix(hf(i + vec2(0.0, 1.0)), hf(i + vec2(1.0, 1.0)), fr.x), fr.y); }
// WORLD-anchored shading noise (ground, rocks, cities): coordinates pw = terrain-local + uAnc.xy (the origin mod 4096 m)
// or the wind frame (dot(p, w) + uAnc.z, dot(p, wp) + uAnc.w); n = cells per 4096 m per axis (integers, wn() in TS), so
// the lattice wraps exactly every 4096 m and a rebase (O += k * 1024 m) leaves every pattern where it was.
uint wh32(ivec2 c, uint s) {
  uvec2 w = uvec2(c);
  uint h = s ^ (w.x * 0x27d4eb2du) ^ (w.y * 0x165667b1u);
  h = (h ^ (h >> 15)) * 0x85ebca6bu;
  h = (h ^ (h >> 13)) * 0xc2b2ae35u;
  return h ^ (h >> 16);
}
float whf(ivec2 c, uint s) { return float(wh32(c, s)) * 2.3283064365386963e-10; }
// integer cell i (an exact whole float) wrapped into [0, n) (float floor may be off by one: corrected in ints)
ivec2 wwrap(vec2 i, ivec2 n) {
  vec2 nf = vec2(n);
  ivec2 m = ivec2(i - nf * floor(i / nf));
  m += n * ivec2(lessThan(m, ivec2(0)));
  m -= n * ivec2(greaterThanEqual(m, n));
  return m;
}
vec2 wq(vec2 pw, ivec2 n) { return pw * vec2(n) * 0.000244140625; }
float wvn(vec2 q, ivec2 n, uint s) {
  vec2 i = floor(q), fr = q - i, u = fr * fr * (3.0 - 2.0 * fr);
  ivec2 a = wwrap(i, n), b = a + 1;
  b -= n * ivec2(greaterThanEqual(b, n));
  float h00 = whf(a, s), h10 = whf(ivec2(b.x, a.y), s), h01 = whf(ivec2(a.x, b.y), s), h11 = whf(b, s);
  return h00 + (h10 - h00) * u.x + (h01 - h00) * u.y + (h00 - h10 - h01 + h11) * u.x * u.y;
}
float wcell(vec2 q, ivec2 n, uint s) { return whf(wwrap(floor(q), n), s); }
`;

/** Clipmap texel decode (needs `uniform float uPack;`): float targets hold height (h, flat) and normal (nx, nz, curvature,
 *  flat); the RGBA8 fallback (no EXT_color_buffer_float, SPEC 3.2) packs h in 16 bits (1/64 m over -128..+896 m), flat
 *  in b, and the normal set affinely (curvature +-4 m). One program serves both: the switch is a uniform. */
export const CLIP_DECODE_GLSL = /* glsl */ `
float clipHd(vec4 t) { return uPack > 0.5 ? (floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5)) * 0.015625 - 128.0 : t.r; }
float clipFd(vec4 t) { return uPack > 0.5 ? t.b : t.g; }
vec4 clipNd(vec4 t) { return uPack > 0.5 ? vec4(t.xy * 2.0 - 1.0, (t.z - 0.5) * 8.0, t.w) : t; }
`;

function siteExpr(s: Site): string {
  const co = (a: string) => (a === 'x' ? 'p.x' : a === 'z' ? 'p.y' : a);
  const l = `vec2(${co(s.ax)} * ${f(1 / s.sx)}, ${co(s.az)} * ${f(1 / s.sz)})`;
  const seed = `(uSeed + ${s.seed}u)`;
  if (s.oct === 1) return `dvnO(${seed}, uOffI[${SITE_BASE[s.name]}], uOff[${SITE_BASE[s.name]}] + ${l})`;
  return `dfbm(${seed}, ${SITE_BASE[s.name]}, ${l}, ${s.oct})`;
}

const D = DUNE, R = RELIEF, RM = RELIEF.mesa, RC = RELIEF.canyon, RB = RELIEF.basin, RT = RELIEF.terrace;
const siteOf = (n: string) => SITES.find((s) => s.name === n)!;
/** The height function (needs HEIGHT_UNIFORMS + NOISE_GLSL). duneH(p, flatK) with p = terrain-local (x, z). */
export const HEIGHT_GLSL = /* glsl */ `
// dss = noise.ts sstep: the smoothstep formula, but also valid for reversed edges (basin.lo > basin.hi), which the GLSL built-in does not promise
float dss(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float dfbm(uint s, int base, vec2 l, int oct) {
  float sum = 0.0, a = 0.5, n = 0.0, m = 1.0;
  for (int i = 0; i < 3; i++) {
    if (i >= oct) break;
    sum += a * (dvnO(s + uint(i) * ${OCT_SEED}u, uOffI[base + i], uOff[base + i] + l * m) * 2.0 - 1.0);
    n += a; a *= 0.5; m *= ${f(OCT_MUL)};
  }
  return sum / n;
}
float dcrest(float t) {
  return t < ${f(D.crest.stoss)} ? pow(max(0.0, sin(${f((0.5 * Math.PI) / D.crest.stoss)} * t)), ${f(D.crest.p1)}) : pow(max(0.0, (1.0 - t) * ${f(1 / (1 - D.crest.stoss))}), ${f(D.crest.p2)});
}
// relief (height.ts reliefOf): mesas / ridges away from the route
float dTerrace(float h) {
  if (h <= ${f(RT.k0)}) return h;
  float t = h * ${f(1 / RT.step)}, k = floor(t), s = dss(0.3, 0.7, t - k);
  return h + ((k + s) * ${f(RT.step)} - h) * ${f(RT.k)} * dss(${f(RT.k0)}, ${f(RT.k1)}, h);
}
float dRelief(vec2 p, float rd) {
  float kind = dss(${f(R.kind.lo)}, ${f(R.kind.hi)}, ${siteExpr(siteOf('rkind'))});
  float mn = ${siteExpr(siteOf('rmesa'))}, rn = ${siteExpr(siteOf('rridge'))};
  float jg = ${siteExpr(siteOf('rjag'))};
  float m = mn + ${f(RM.rag)} * rn + ${f(R.jag.mesa)} * jg;
  float mesa = ${f(RM.h)} * dss(${f(RM.lo)}, ${f(RM.lo + RM.edge)}, m) + ${f(RM.h2)} * dss(${f(RM.lo + RM.tier)}, ${f(RM.lo + RM.tier + RM.tierEdge)}, m) + ${f(RM.talusH)} * dss(${f(RM.lo - RM.talus)}, ${f(RM.lo)}, m);
  float ridge = ${f(R.ridge.h)} * (pow(max(0.0, 1.0 - abs(rn) * ${f(R.ridge.sharp)}), ${f(R.ridge.pw)}) + ${f(R.ridge.lift)} * dss(-0.3, 0.4, mn));
  float a = ${f(R.amp.min)} + ${f(1 - R.amp.min)} * dss(${f(R.amp.lo)}, ${f(R.amp.hi)}, ${siteExpr(siteOf('ramp'))});
  float up = ${f(R.uplift.h)} * dss(${f(R.uplift.lo)}, ${f(R.uplift.hi)}, mn);
  float vn = ${siteExpr(siteOf('rvar'))};
  float cy = dss(${f(RC.lo)}, ${f(RC.hi)}, vn), bs = dss(${f(RB.lo)}, ${f(RB.hi)}, vn);
  float rel = dss(${f(R.r0)}, ${f(R.r1)}, rd) * (1.0 + ${f(R.farK)} * dss(${f(R.far0)}, ${f(R.far1)}, rd)) * a * (up + mix(mesa, ridge, kind));
  rel *= 1.0 - bs * (1.0 - dss(${f(RB.open0)}, ${f(RB.open1)}, rd));
  float wall = cy * ${f(RC.h)} * dss(${f(RC.r0)}, ${f(RC.r1)}, rd + ${f(R.jag.wall)} * jg) * (1.0 - dss(${f(RC.out0)}, ${f(RC.out1)}, rd)) * (0.78 + 0.22 * dss(-0.4, 0.4, rn));
  float dip = bs * ${f(RB.depth)} * dss(${f(RB.r0)}, ${f(RB.r1)}, rd) * (1.0 - dss(${f(RB.far0)}, ${f(RB.far1)}, rd));
  return uRelief * (dTerrace(max(rel, wall)) - dip);
}
float dseg(vec2 p, vec2 a, vec2 b) { vec2 e = b - a, w = p - a; float t = clamp(dot(w, e) / max(dot(e, e), 1e-6), 0.0, 1.0); return length(w - e * t); }
float duneH(vec2 p, out float flatK) {
  float base = ${f(D.base.amp)} * ${siteExpr(SITES[0])};
  vec2 q = p + ${f(D.warp.amp)} * vec2(${siteExpr(SITES[1])}, ${siteExpr(SITES[2])});
  float u = q.x * uWindCS.x + q.y * uWindCS.y, v = -q.x * uWindCS.y + q.y * uWindCS.x;
  float field = dss(${f(D.field.lo)}, ${f(D.field.hi)}, ${siteExpr(SITES[3])});
  float dt = fract(uPhase.z + u * ${f(1 / PHASES[2].lam)} + ${f(D.draa.ph)} * ${siteExpr(SITES[4])});
  float draa = pow(max(0.0, sin(3.141592653589793 * min(1.0, dt * ${f(1 / D.draa.top)}))), ${f(D.draa.pw)});
  float amp = (${f(D.amp.min)} + ${f(1 - D.amp.min)} * dss(${f(D.amp.lo)}, ${f(D.amp.hi)}, ${siteExpr(SITES[5])})) * (${f(1 - D.draa.ampMix)} + ${f(D.draa.ampMix)} * draa);
  float horn = ${f(D.crest.horn)} * (1.0 - amp);
  float c0 = dcrest(fract(uPhase.x + u * ${f(1 / PHASES[0].lam)} + ${f(D.crest.ph[0])} * ${siteExpr(SITES[6])} + horn));
  float c1 = dcrest(fract(uPhase.y + u * ${f(1 / PHASES[1].lam)} + ${f(D.crest.ph[1])} * ${siteExpr(SITES[7])} + horn));
  float mixL = dss(${f(D.mixL.lo)}, ${f(D.mixL.hi)}, ${siteExpr(SITES[8])});
  float trans = amp * (${f(D.crest.h[0])} * c0 * (1.0 - mixL) + ${f(D.crest.h[1])} * c1 * mixL);
  float r = 1.0 - abs(2.0 * fract(uPhase.w + v * ${f(1 / PHASES[3].lam)} + ${f(D.seif.ph)} * ${siteExpr(SITES[9])}) - 1.0);
  float seif = ${f(D.seif.amp)} * pow(r, ${f(D.seif.pw)}) * (0.55 + 0.45 * ${siteExpr(SITES[10])});
  flatK = dss(${f(D.flat.lo)}, ${f(D.flat.hi)}, ${siteExpr(SITES[11])});
  float dunes = ${f(D.draa.amp)} * draa * (1.0 - field) + (trans * (1.0 - field) + seif * field) * (1.0 - flatK);
  float rd = 1e9;
  if (uCorr > 0) for (int i = 0; i < ${CORRIDOR_N - 1}; i++) rd = min(rd, dseg(p, uPoly[i], uPoly[i + 1]));
  float corr = ${f(D.corridor.min)} + ${f(1 - D.corridor.min)} * dss(${f(D.corridor.r0)}, ${f(D.corridor.r1)}, rd);
  float rel = uRelief > 0.0 && rd > ${f(R.rMin)} ? dRelief(p, rd) : 0.0;
  float h = base + dunes * corr * (1.0 - ${f(R.dune)} * clamp(rel * ${f(1 / R.cover)}, 0.0, 1.0)) + rel;
  for (int i = 0; i < ${MAX_FLATS}; i++) {
    if (i >= uFlatN) break;
    vec4 fl = uFlats[i];
    h += (fl.w - h) * (1.0 - dss(fl.z * 0.7, fl.z, length(p - fl.xy)));
  }
  return h;
}
`;

export const HEIGHT_UNIFORMS = /* glsl */ `
uniform uint uSeed;
uniform vec2 uOff[${SITE_COUNT}];       // fractional part of each site octave's lattice offset at the origin
uniform ivec2 uOffI[${SITE_COUNT}];     // integer part (exact)
uniform vec4 uPhase;
uniform vec2 uWindCS;
uniform vec2 uPoly[${CORRIDOR_N}];
uniform int uCorr;
uniform float uRelief;
uniform vec4 uFlats[${MAX_FLATS}];
uniform int uFlatN;
`;

/** Desert-wide uniforms (one shared object drives every desert material; see uniforms.ts). */
export const DESERT_UNIFORMS = /* glsl */ `
uniform vec3 uCamT;          // camera in terrain-local space
uniform vec3 uSunT;          // key light direction (sun or moon) in terrain-local space
uniform vec3 uSunCol;        // key light colour x intensity (linear)
uniform vec3 uSkyAmb;        // sky ambient (from above)
uniform vec3 uGndAmb;        // ground bounce ambient
uniform vec3 uHazeCol;       // aerial perspective colour (away from the sun)
uniform vec3 uHazeSun;       // aerial perspective colour towards the sun
uniform vec4 uFog;           // x = density at ground (1/m), y = height falloff H (m), z = ground y (terrain-local), w = max
uniform float uStorm;        // 0..1
uniform float uDayK;         // 0 night .. 1 day
uniform float uDark;         // 0 day .. 1 deep night (night lights)
uniform float uTime;         // seconds (wall clock, wrapped)
uniform vec2 uWindT;         // dust-carrying wind in terrain-local space (m/s, x/z)
uniform float uQ;            // quality 0 low .. 3 ultra
uniform vec3 uFlash;         // lightning flash (dry lightning in storms)
uniform vec4 uAnc;           // world anchors for shading noise: origin mod 4096 m (x, z) and in the wind frame (u, v)
uniform float uAncPh;        // fract(dot(origin, wind) / 0.55): the ripple phase at the origin (float64 on the CPU)
uniform vec4 uAerial;        // aerial perspective in steps: x = haze factor near, y = far, between z..w m (1, 1 = one blanket)
uniform vec4 uFires[${MAX_FIRES}];       // fire light pools: x, y, z (terrain-local), reach (m; 0 = none)
uniform vec3 uFireCol;       // fire light colour x intensity (flicker, stronger in the dark)
`;

/** Aerial perspective + lighting helpers (need DESERT_UNIFORMS). */
export const SHADE_GLSL = /* glsl */ `
float dFogAmt(vec3 cam, vec3 p) {
  vec3 d = p - cam; float dist = length(d);
  float H = uFog.y, y0 = uFog.z;
  float dy = d.y;
  float k = abs(dy) < 0.01 ? 1.0 : (1.0 - exp(-dy / H)) / (dy / H);
  float od = uFog.x * exp(-(cam.y - y0) / H) * dist * k;
  // aerial perspective in steps: the mid-distance layers stay crisp, the far ones sink into the haze
  od *= mix(uAerial.x, uAerial.y, smoothstep(uAerial.z, uAerial.w, dist));
  return min(uFog.w, 1.0 - exp(-od));
}
// warm light from the burning wrecks on everything near them (sand, rock, the wrecks themselves)
vec3 dFireLight(vec3 p, vec3 N) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MAX_FIRES}; i++) {
    vec4 f = uFires[i];
    if (f.w <= 0.0) continue;
    vec3 d = f.xyz - p;
    float r = length(d);
    if (r >= f.w) continue;
    float fall = 1.0 - r / f.w;
    acc += fall * fall * (0.25 + 0.75 * max(0.0, dot(N, d / max(r, 0.01))));
  }
  return acc * uFireCol;
}
vec3 dHaze(vec3 viewDir) {
  float s = pow(max(dot(viewDir, uSunT), 0.0), 6.0);
  return mix(uHazeCol, uHazeSun, s);
}
vec3 dApplyFog(vec3 col, vec3 cam, vec3 p) {
  vec3 vd = normalize(p - cam);
  return mix(col, dHaze(vd), dFogAmt(cam, p));
}
// banded toon key light (cel terminator) + soft sky / bounce ambient
vec3 dLight(vec3 albedo, vec3 N, float shadow, float ao) {
  float ndl = dot(N, uSunT);
  float band = smoothstep(-0.02, 0.10, ndl) * (0.78 + 0.22 * smoothstep(0.2, 0.75, ndl));
  vec3 amb = mix(uGndAmb, uSkyAmb, 0.5 + 0.5 * N.y) * ao;
  return albedo * (uSunCol * band * shadow + amb + uFlash * 0.6);
}
`;

/** Distance compression for far layers (2-40 km objects drawn at <= ~2.3 km with exact angular size). */
export const COMPRESS_GLSL = /* glsl */ `
float dCompress(float D) { return D < 1600.0 ? D : 1600.0 + 700.0 * (1.0 - exp(-(D - 1600.0) / 9000.0)); }
// earth curvature drop (R = 6371 km)
float dDrop(float D) { return D * D / 12742000.0; }
`;

export { SITE_COUNT, CORRIDOR_N, MAX_FLATS };
