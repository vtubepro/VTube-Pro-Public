// Environment shader patches for a room's own materials — installed ONCE when an opted-in room loads (one compile per
// variant; the programs are shared), then driven only by uniforms, so time / weather / quality changes never compile.
//
//   lit     every lit room material: its reflected light × the time-of-day room light (uEnvLit), a banded sun term from
//           the real sun direction with drifting cloud shadows, "light pools" around lit night lights (lanterns light the
//           ground without real THREE lights), lightning flashes. Emission is untouched (self-lit things stay lit).
//   wet     MeshStandard / Physical: rain darkens porous surfaces, gloss on High/Ultra, puddles with rain ripples on flat
//           ground (Ultra/High), never inside ENV_DRY_* boxes (tents, roofs).
//   sky     the room's own sky meshes (M_Sky*, GFX_SKY*, SKY_*): tinted by the time + weather, stars at night, flashes.
//   emit    EMIT_<group> night lights: emission × a per-material glow uniform (lanterns fade on at dusk, flicker).
//   grid    window-grid mask on an EMIT_ group (city buildings): every window has its own darkness threshold + colour,
//           so lights come on one by one as it gets dark (and some go out late at night).
//   sway    foliage / cloth materials bend in the global wind (vertex shader; height-weighted from the mesh origin).
//   night   rooms that ship a second, NIGHT light bake (glTF COLOR_1 = the practicals only; material extras `nightBake`):
//           the vertex colour crossfades from the day bake to the night bake as it gets dark (uEnvNight), and the night
//           bake is exempt from the time-of-day dimming - lamp-lit interiors stay lamp-lit at night.
//
// With every uniform at its neutral value a patched material renders exactly as authored (environment off).
import * as THREE from 'three';

export const MAX_POOLS = 12;
export const MAX_DRY = 8;

const v3 = () => new THREE.Vector3();
/** Shared by every patched material (one CPU update per frame for the whole room). */
export const EU = {
  uEnvLit: { value: new THREE.Vector3(1, 1, 1) },
  uEnvSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uEnvSunCol: { value: new THREE.Vector3(0, 0, 0) },
  /** cloud shadows: xy = drift offset (m), z = strength, w = 1 / scale (m) */
  uEnvCloudSh: { value: new THREE.Vector4(0, 0, 0, 1 / 28) },
  uEnvT: { value: 0 },
  uEnvFlash: { value: new THREE.Vector3(0, 0, 0) },
  uEnvDryN: { value: 0 },
  uEnvDryMin: { value: Array.from({ length: MAX_DRY }, v3) },
  uEnvDryMax: { value: Array.from({ length: MAX_DRY }, v3) },
  uEnvPoolN: { value: 0 },
  uEnvPool: { value: Array.from({ length: MAX_POOLS }, () => new THREE.Vector4()) },
  uEnvPoolCol: { value: Array.from({ length: MAX_POOLS }, v3) },
  uEnvWet: { value: 0 },
  /** 0 = darkening only, 1 = + gloss, 2 = + puddles + ripples */
  uEnvWetQ: { value: 0 },
  uEnvPuddle: { value: 0.35 },
  uEnvRain: { value: 0 },
  uEnvDark: { value: 0 },
  uEnvLate: { value: 0 },
  uEnvGridOn: { value: 0 },
  uEnvSkyTint: { value: new THREE.Vector3(1, 1, 1) },
  /** painted skies: blend towards the real sky colours as the moment differs from the reference */
  uEnvSkyHor: { value: new THREE.Vector3(1, 1, 1) },
  uEnvSkyZen: { value: new THREE.Vector3(1, 1, 1) },
  uEnvSkyMix: { value: 0 },
  uEnvStars: { value: 0 },
  uEnvSkyFlash: { value: new THREE.Vector3(0, 0, 0) },
  /** 0 = the day bake (COLOR_0), 1 = the night bake (COLOR_1) on `night` materials */
  uEnvNight: { value: 0 },
  /** undoes the stage lights' night dimming / moonlight tint on the night bake (it is the practicals' own light) */
  uEnvNightGain: { value: new THREE.Vector3(1, 1, 1) },
  /** wind (world): x, z = direction × strength (m/s-ish), y = gust factor */
  uEnvWind: { value: new THREE.Vector3(0, 1, 0) },
};

export function neutralUniforms() {
  EU.uEnvLit.value.set(1, 1, 1); EU.uEnvSunCol.value.set(0, 0, 0); EU.uEnvFlash.value.set(0, 0, 0); EU.uEnvPoolN.value = 0;
  EU.uEnvWet.value = 0; EU.uEnvRain.value = 0; EU.uEnvDark.value = 0; EU.uEnvLate.value = 0; EU.uEnvGridOn.value = 0;
  EU.uEnvSkyTint.value.set(1, 1, 1); EU.uEnvSkyMix.value = 0; EU.uEnvNight.value = 0; EU.uEnvNightGain.value.set(1, 1, 1); EU.uEnvStars.value = 0; EU.uEnvSkyFlash.value.set(0, 0, 0); EU.uEnvWind.value.set(0, 1, 0);
  EU.uEnvCloudSh.value.z = 0; EU.uEnvDryN.value = 0;
}

export interface GridSpec { mode: 'world' | 'uv'; cell: [number, number]; grid: [number, number]; frame: number; lit: number; late: number; tv: number; threshold: number; spread: number; colors: THREE.Color[] }
export interface PatchOpts {
  lit?: boolean; basic?: boolean; wet?: boolean; sky?: boolean;
  /** EMIT_ night light: this material's glow uniform ({value: 0..}). */
  glow?: { value: number };
  grid?: GridSpec;
  /** Foliage / cloth: {value: Vector4(amp m, height m, freq, base y)} */
  sway?: { value: THREE.Vector4 };
  /** the mesh carries a night bake in `color_1` (glTF COLOR_1) */
  night?: boolean;
}

const COMMON = /* glsl */ `
uniform float uEnvT;
varying vec3 vEnvW;
float vtpEH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vtpEN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vtpEH(i), vtpEH(i + vec2(1.0, 0.0)), f.x), mix(vtpEH(i + vec2(0.0, 1.0)), vtpEH(i + vec2(1.0, 1.0)), f.x), f.y); }
`;
const FRAG_PARS = /* glsl */ `
uniform vec3 uEnvLit; uniform vec3 uEnvSunDir; uniform vec3 uEnvSunCol; uniform vec4 uEnvCloudSh; uniform vec3 uEnvFlash;
uniform int uEnvDryN; uniform vec3 uEnvDryMin[${MAX_DRY}]; uniform vec3 uEnvDryMax[${MAX_DRY}];
uniform int uEnvPoolN; uniform vec4 uEnvPool[${MAX_POOLS}]; uniform vec3 uEnvPoolCol[${MAX_POOLS}];
uniform float uEnvWet; uniform float uEnvWetQ; uniform float uEnvPuddle; uniform float uEnvRain; uniform float uEnvDark; uniform float uEnvLate;
uniform float uEnvGridOn; uniform vec3 uEnvSkyTint; uniform vec3 uEnvSkyHor; uniform vec3 uEnvSkyZen; uniform float uEnvSkyMix; uniform float uEnvStars; uniform vec3 uEnvSkyFlash;
float vtpEnvOpen(vec3 p) {                                    // 1 = under the open sky, 0 = inside a dry box
  float o = 1.0;
  for (int i = 0; i < ${MAX_DRY}; i++) {
    if (i >= uEnvDryN) break;
    vec3 a = uEnvDryMin[i], b = uEnvDryMax[i];
    vec3 d = max(a - p, p - b);
    o = min(o, smoothstep(-0.25, 0.1, max(d.x, max(d.y, d.z))));
  }
  return o;
}
vec2 vtpEnvRipple(vec2 p, float t) {                          // expanding rain rings → a normal offset
  vec2 g = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    vec2 q = p + float(k) * vec2(0.37, 0.61);
    vec2 c = floor(q), f = fract(q) - 0.5;
    float h = vtpEH(c + float(k) * 7.3);
    vec2 o = vec2(vtpEH(c + 3.1), vtpEH(c + 5.7)) * 0.5 - 0.25;
    float ph = fract(t * (0.9 + 0.5 * h) + h);
    vec2 d = f - o;
    float r = length(d);
    float ring = sin((r - ph * 0.45) * 42.0) * (1.0 - ph) * smoothstep(0.45 * ph + 0.07, 0.45 * ph, r) * smoothstep(0.45 * ph - 0.12, 0.45 * ph, r);
    g += (r > 1e-4 ? d / r : vec2(0.0)) * ring;
  }
  return g;
}
`;

function vertexPatch(vs: string, o: PatchOpts): string {
  let out = vs.replace('void main() {', `${COMMON}\n${o.sway ? 'uniform vec3 uEnvWind; uniform vec4 uEnvSway;' : ''}\n${o.grid?.mode === 'uv' ? 'varying vec2 vEnvUv;' : ''}\n${o.night ? 'attribute vec4 color_1; varying vec3 vEnvNight;' : ''}\nvoid main() {`);
  if (o.sway) {
    out = out.replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
  {
    mat4 vtpM = modelMatrix;
    #ifdef USE_INSTANCING
      vtpM = modelMatrix * instanceMatrix;
    #endif
    vec3 wp0 = (vtpM * vec4(transformed, 1.0)).xyz;
    float hgt = clamp((transformed.y - uEnvSway.w) / max(0.05, uEnvSway.y), 0.0, 1.0); hgt *= hgt;
    float ph = dot(wp0.xz, vec2(0.37, 0.23));
    float s = sin(uEnvT * uEnvSway.z + ph) * 0.65 + sin(uEnvT * uEnvSway.z * 2.3 + ph * 1.9) * 0.35;
    float st = length(uEnvWind.xz);
    vec3 dW = vec3(uEnvWind.x, 0.0, uEnvWind.z) * (0.45 + 0.55 * s) * uEnvWind.y
            + vec3(sin(ph * 3.1 + uEnvT * uEnvSway.z * 3.7), 0.0, cos(ph * 2.7 + uEnvT * uEnvSway.z * 3.1)) * 0.22 * st;
    transformed += inverse(mat3(vtpM)) * dW * uEnvSway.x * hgt;
  }`);
  }
  out = out.replace('#include <project_vertex>', /* glsl */ `#include <project_vertex>
  {
    vec4 vtpW = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
      vtpW = batchingMatrix * vtpW;
    #endif
    #ifdef USE_INSTANCING
      vtpW = instanceMatrix * vtpW;
    #endif
    vEnvW = (modelMatrix * vtpW).xyz;
    ${o.grid?.mode === 'uv' ? 'vEnvUv = uv;' : ''}
    ${o.night ? 'vEnvNight = color_1.rgb;' : ''}
  }`);
  return out;
}

const LIT_BLOCK = /* glsl */ `
  {
    float vtpOpen = vtpEnvOpen(vEnvW);
    reflectedLight.directDiffuse *= uEnvLit; reflectedLight.indirectDiffuse *= uEnvLit;
    #ifndef VTP_ENV_BASIC
    reflectedLight.directSpecular *= uEnvLit; reflectedLight.indirectSpecular *= uEnvLit;
    vec3 vtpN = normalize(normal);
    if (uEnvSunCol.x + uEnvSunCol.y + uEnvSunCol.z > 0.001) {
      vec3 sunV = normalize((viewMatrix * vec4(uEnvSunDir, 0.0)).xyz);
      float band = smoothstep(0.02, 0.3, dot(vtpN, sunV));
      vec2 cq = (vEnvW.xz + uEnvCloudSh.xy) * uEnvCloudSh.w;
      float cs = 1.0 - uEnvCloudSh.z * smoothstep(0.42, 0.62, vtpEN(cq) * 0.65 + vtpEN(cq * 2.3) * 0.35);
      reflectedLight.directDiffuse += diffuseColor.rgb * uEnvSunCol * band * cs * (0.08 + 0.92 * vtpOpen);
    }
    for (int i = 0; i < ${MAX_POOLS}; i++) {
      if (i >= uEnvPoolN) break;
      vec3 L = uEnvPool[i].xyz - vEnvW;
      float d = length(L);
      float att = clamp(1.0 - d / uEnvPool[i].w, 0.0, 1.0); att *= att;
      if (att <= 0.0) continue;
      vec3 lv = normalize((viewMatrix * vec4(L, 0.0)).xyz);
      reflectedLight.directDiffuse += diffuseColor.rgb * uEnvPoolCol[i] * att * (0.3 + 0.7 * clamp(dot(vtpN, lv), 0.0, 1.0));
    }
    #endif
    reflectedLight.indirectDiffuse += diffuseColor.rgb * uEnvFlash * (0.3 + 0.7 * vtpOpen);
  }`;

const WET_BLOCK = /* glsl */ `
  if (uEnvWet > 0.001) {
    float vtpWo = vtpEnvOpen(vEnvW);
    vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    float flatUp = smoothstep(0.6, 0.93, dot(normal, upV));
    float w = uEnvWet * vtpWo;
    diffuseColor.rgb *= 1.0 - w * (0.22 + 0.2 * flatUp);
    if (uEnvWetQ > 0.5) roughnessFactor = mix(roughnessFactor, 0.34, w * (0.3 + 0.55 * flatUp));
    if (uEnvWetQ > 1.5 && flatUp > 0.0) {
      float pn = vtpEN(vEnvW.xz * 0.33) * 0.65 + vtpEN(vEnvW.xz * 1.07 + 4.1) * 0.35;
      float pud = smoothstep(1.0 - uEnvPuddle, 1.0 - uEnvPuddle + 0.07, pn) * flatUp * smoothstep(0.3, 0.85, w);
      diffuseColor.rgb *= 1.0 - pud * 0.3;
      roughnessFactor = mix(roughnessFactor, 0.14, pud);
      if (uEnvRain > 0.01 && pud > 0.01) {
        vec2 g = vtpEnvRipple(vEnvW.xz * 2.4, uEnvT);
        vec3 xV = (viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz, zV = (viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz;
        normal = normalize(normal + (xV * g.x + zV * g.y) * pud * min(1.0, uEnvRain * 1.4) * 0.55);
      }
    }
  }`;

function gridBlock(g: GridSpec): string {
  const nC = Math.min(4, Math.max(1, g.colors.length));
  const cols = Array.from({ length: 4 }, (_, i) => g.colors[i % nC]);
  const f = (x: number) => x.toFixed(4);
  const cv = (c: THREE.Color) => `vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`;
  const cell = g.mode === 'uv'
    ? `vec2 q = vEnvUv * vec2(${f(g.grid[0])}, ${f(g.grid[1])}); vec2 cid = floor(q); vec2 fr = fract(q); float inside = 1.0; float fac = 0.0;`
    : `vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
       float vert = 1.0 - smoothstep(0.55, 0.75, abs(nW.y));
       vec2 fp = abs(nW.x) > abs(nW.z) ? vec2(vEnvW.z, vEnvW.y) : vec2(vEnvW.x, vEnvW.y);
       float fac = abs(nW.x) > abs(nW.z) ? sign(nW.x) * 3.0 : sign(nW.z) * 5.0;
       vec2 q = fp / vec2(${f(g.cell[0])}, ${f(g.cell[1])});
       vec2 cid = floor(q); vec2 fr = fract(q);
       float fx = ${f(g.frame)}, fy = ${f(g.frame * 1.1)};
       float inside = vert * smoothstep(fx - 0.02, fx + 0.02, fr.x) * smoothstep(1.0 - fx + 0.02, 1.0 - fx - 0.02, fr.x)
                    * smoothstep(fy - 0.02, fy + 0.02, fr.y) * smoothstep(1.0 - fy * 0.7 + 0.02, 1.0 - fy * 0.7 - 0.02, fr.y);`;
  return /* glsl */ `
  if (uEnvGridOn > 0.5) {
    ${cell}
    vec2 cs = cid + vec2(fac * 13.1, fac * 7.7);
    float h1 = vtpEH(cs), h2 = vtpEH(cs + 17.3), h3 = vtpEH(cs + 31.9), h4 = vtpEH(cs + 5.3);
    float thr = ${f(g.threshold)} + (h1 - 0.5) * 2.0 * ${f(g.spread)};
    float on = smoothstep(thr, thr + 0.025, uEnvDark) * step(h2, ${f(g.lit)});
    on *= 1.0 - step(h3, ${f(g.late)}) * step(h4 * 0.8 + 0.1, uEnvLate);          // some go dark late at night
    int ci = int(floor(h4 * 3.999));
    vec3 wc = ci == 0 ? ${cv(cols[0])} : ci == 1 ? ${cv(cols[1])} : ci == 2 ? ${cv(cols[2])} : ${cv(cols[3])};
    float tv = step(1.0 - ${f(g.tv)}, h3);
    wc = mix(wc, vec3(0.45, 0.62, 1.0) * (0.55 + 0.45 * vtpEN(vec2(uEnvT * 5.0 + h1 * 40.0, h2 * 9.0))), tv);
    float shade = (0.62 + 0.55 * h2) * (0.8 + 0.2 * smoothstep(0.0, 0.6, fr.y));   // curtains / depth
    totalEmissiveRadiance *= wc * on * inside * shade;
  }`;
}

const SKY_BLOCK = /* glsl */ `
  {
    vec3 d = normalize(vEnvW - cameraPosition);
    float tl = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
    vec3 tgt = mix(uEnvSkyHor, uEnvSkyZen, smoothstep(0.0, 0.6, d.y)) * clamp(0.55 + tl * 0.9, 0.6, 1.35);   // keeps the painting's clouds
    outgoingLight = mix(outgoingLight * uEnvSkyTint, tgt, uEnvSkyMix);
    if (uEnvStars > 0.001 && d.y > 0.0) {
      vec2 cell = floor(vec2(atan(d.z, d.x) * 170.0, d.y * 240.0));
      float h = vtpEH(cell);
      float tw = 0.55 + 0.45 * sin(uEnvT * (1.3 + h * 3.0) + h * 40.0);
      outgoingLight += vec3(step(0.9972, h) * tw * 1.2) * uEnvStars * smoothstep(0.04, 0.3, d.y);
    }
    outgoingLight += uEnvSkyFlash * (0.6 + 0.4 * d.y);
  }`;

// the day bake (vColor) crossfades to the night bake; the night bake is divided by the room light so the LIT_BLOCK's
// time-of-day dimming leaves it as baked (lamps don't dim at night)
const NIGHT_COLOR = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  diffuseColor.rgb *= mix(vColor.rgb, vEnvNight * uEnvNightGain / max(uEnvLit, vec3(0.05)), uEnvNight);
  #ifdef USE_COLOR_ALPHA
  diffuseColor.a *= vColor.a;
  #endif
#endif`;

/** Install the patch (once per material). Returns false if the material can't take it. */
export function patchEnvMaterial(m: THREE.Material, o: PatchOpts): boolean {
  if (m.userData.vtpEnv) return true;
  const sm = m as THREE.MeshStandardMaterial & { isShaderMaterial?: boolean; isPointsMaterial?: boolean; isLineBasicMaterial?: boolean; isSpriteMaterial?: boolean };
  if (sm.isShaderMaterial || sm.isPointsMaterial || sm.isLineBasicMaterial || sm.isSpriteMaterial) return false;
  const std = !!sm.isMeshStandardMaterial;
  const opts: PatchOpts = { ...o, wet: o.wet && std, basic: !!(m as THREE.MeshBasicMaterial).isMeshBasicMaterial };
  m.userData.vtpEnv = opts.sky ? 'sky' : opts.grid ? 'grid' : opts.glow ? 'emit' : 'lit';
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  const key = `vtpenv1:${opts.night ? 'N' : ''}${opts.lit ? 'L' : ''}${opts.basic ? 'B' : ''}${opts.wet ? 'W' : ''}${opts.sky ? 'S' : ''}${opts.glow ? 'E' : ''}${opts.sway ? 'V' : ''}${opts.grid ? `G${JSON.stringify([opts.grid.mode, opts.grid.cell, opts.grid.grid, opts.grid.frame, opts.grid.lit, opts.grid.late, opts.grid.tv, opts.grid.threshold, opts.grid.spread, opts.grid.colors.map((c) => c.getHexString())])}` : ''}`;
  m.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    const fs0 = sh.fragmentShader;
    if (!fs0.includes('#include <aomap_fragment>') && !opts.sky) return;
    Object.assign(sh.uniforms, EU);
    if (opts.glow) sh.uniforms.uEnvGlow = opts.glow;
    if (opts.sway) sh.uniforms.uEnvSway = opts.sway;
    sh.vertexShader = vertexPatch(sh.vertexShader, opts);
    let fs = fs0.replace('void main() {', `${COMMON}\n${FRAG_PARS}\n${opts.glow ? 'uniform float uEnvGlow;' : ''}\n${opts.grid?.mode === 'uv' ? 'varying vec2 vEnvUv;' : ''}\nvoid main() {`);
    if (opts.basic) fs = `#define VTP_ENV_BASIC\n${fs}`;
    if (opts.night && fs.includes('#include <color_fragment>')) {
      fs = fs.replace('void main() {', 'varying vec3 vEnvNight; uniform float uEnvNight; uniform vec3 uEnvNightGain;\nvoid main() {');
      fs = fs.replace('#include <color_fragment>', NIGHT_COLOR);
    }
    if (opts.wet && fs.includes('#include <normal_fragment_maps>') && fs.includes('#include <roughnessmap_fragment>')) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${WET_BLOCK}`);
    if ((opts.glow || opts.grid) && fs.includes('#include <emissivemap_fragment>')) {
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  ${opts.glow ? 'totalEmissiveRadiance *= uEnvGlow;' : ''}\n${opts.grid ? gridBlock(opts.grid) : ''}`);
    }
    if (opts.lit && !opts.sky && fs.includes('#include <aomap_fragment>')) fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${LIT_BLOCK}`);
    if (opts.sky) {
      const hook = fs.includes('#include <opaque_fragment>') ? '#include <opaque_fragment>' : fs.includes('#include <output_fragment>') ? '#include <output_fragment>' : null;
      if (hook) fs = fs.replace(hook, `${SKY_BLOCK}\n  ${hook}`);
    }
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = function () { return `${prevKey.call(this)}|${key}`; };
  m.needsUpdate = true;
  return true;
}
