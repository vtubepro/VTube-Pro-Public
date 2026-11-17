// Water + sky upgrades any room can use (High / Ultra), cel-styled — found by MATERIAL name, so a room opts in just by
// naming its materials (no rebuild of the engine; docs/SCENES.md → Graphics quality):
//   water:  M_Sea / M_Water / M_Ocean / M_Lake / M_River / M_Pond / GFX_WATER*  → animated wave normals (3 travelling
//           wave trains in world space), banded fresnel sky reflection, stepped sun glints, crest foam lines
//   sky:    M_Sky / GFX_SKY* → textured (unlit) skies get a slow drifting two-band cloud layer above the horizon; plain
//           emissive (space) skies get twinkling stars
//   clouds: M_Clouds* → their texture drifts slowly (planet cloud decks rotate)
// Each is one patch per material installed at a tier change / room load; `uGfxSurf` = 0 renders the authored look.
import * as THREE from 'three';

const U = { uGfxSurf: { value: 0 }, uGfxT: { value: 0 }, uGfxSun: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() }, uGfxSkyCol: { value: new THREE.Color(0.3, 0.38, 0.46) } };

const WATER_RX = /^(M_)?(sea|water|ocean|lake|river|pond)|^GFX_WATER/i;
const SKY_RX = /^(M_)?sky\b|^M_Sky|^GFX_SKY/i;
const CLOUD_RX = /^(M_)?clouds?/i;

const WATER_V = /* glsl */ `varying vec3 vGfxW;`;
const WATER_PARS = /* glsl */ `
uniform float uGfxSurf; uniform float uGfxT; uniform vec3 uGfxSun; uniform vec3 uGfxSkyCol;
varying vec3 vGfxW;
float vtpWave(vec2 p, vec2 d, float f, float s, out vec2 g) { float ph = dot(p, d) * f + uGfxT * s; g = d * f * cos(ph); return sin(ph); }
`;

function patchWater(m: THREE.MeshStandardMaterial) {
  if (m.userData.vtpSurf) return;
  m.userData.vtpSurf = 'water';
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    if (!sh.fragmentShader.includes('#include <normal_fragment_maps>')) return;
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('void main() {', `${WATER_V}\nvoid main() {`)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vGfxW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', `${WATER_PARS}\nvoid main() {\n  float vtpCrest = 0.0;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  if (uGfxSurf > 0.5) {
    vec2 p = vGfxW.xz, g1, g2, g3;
    float h = vtpWave(p, vec2(0.8, 0.6), 0.9, 1.1, g1) * 0.5 + vtpWave(p, vec2(-0.45, 0.89), 1.9, 1.7, g2) * 0.3 + vtpWave(p, vec2(0.17, -0.98), 4.1, 2.6, g3) * 0.2;
    vec2 g = g1 * 0.5 + g2 * 0.3 + g3 * 0.2;
    vec3 wn = normalize(vec3(-g.x * 0.09, 1.0, -g.y * 0.09));
    normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
    vtpCrest = h;
  }`)
      .replace('#include <tonemapping_fragment>', `
  if (uGfxSurf > 0.5) {
    vec3 vv = normalize(vViewPosition);
    float fr = pow(1.0 - clamp(dot(normal, vv), 0.0, 1.0), 3.0);
    fr = floor(fr * 3.0 + 0.5) / 3.0;                                          // banded (cel) fresnel
    vec3 sunV = normalize((viewMatrix * vec4(uGfxSun, 0.0)).xyz);
    float gl = smoothstep(0.986, 0.992, dot(reflect(-vv, normal), sunV));       // stepped glints
    float foam = smoothstep(0.74, 0.8, vtpCrest) * 0.3;
    gl_FragColor.rgb = gl_FragColor.rgb * (1.0 - fr * 0.35) + uGfxSkyCol * fr * 0.4 + vec3(gl * 0.8) + vec3(foam * 0.5);
  }
  #include <tonemapping_fragment>`);
  };
  m.customProgramCacheKey = function () { return `${prevKey.call(this)}|vtpwater1`; };
  m.needsUpdate = true;
}

const SKY_V = /* glsl */ `varying vec3 vGfxDir;`;
const SKY_PARS = /* glsl */ `
uniform float uGfxSurf; uniform float uGfxT;
varying vec3 vGfxDir;
float vtpH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vtpN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vtpH(i), vtpH(i + vec2(1, 0)), f.x), mix(vtpH(i + vec2(0, 1)), vtpH(i + vec2(1, 1)), f.x), f.y); }
float vtpFbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vtpN(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
`;

function patchSky(m: THREE.Material) {
  if (m.userData.vtpSurf) return;
  const textured = !!(m as THREE.MeshBasicMaterial).map;
  m.userData.vtpSurf = textured ? 'sky' : 'stars';
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    const hookF = sh.fragmentShader.includes('#include <opaque_fragment>') ? '#include <opaque_fragment>' : sh.fragmentShader.includes('#include <output_fragment>') ? '#include <output_fragment>' : null;
    if (!hookF || !sh.vertexShader.includes('#include <worldpos_vertex>')) return;
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('void main() {', `${SKY_V}\nvoid main() {`)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vGfxDir = (modelMatrix * vec4(transformed, 1.0)).xyz - cameraPosition;');
    const body = textured ? /* glsl */ `
  if (uGfxSurf > 0.5) {
    vec3 d = normalize(vGfxDir);
    if (d.y > 0.01) {
      vec2 q = d.xz / (d.y + 0.25) * 1.6 + vec2(uGfxT * 0.006, uGfxT * 0.002);
      float c = vtpFbm(q);
      float band = smoothstep(0.55, 0.6, c) * 0.55 + smoothstep(0.68, 0.72, c) * 0.35;   // two cel bands
      float fade = smoothstep(0.01, 0.22, d.y);
      outgoingLight = mix(outgoingLight, vec3(1.0, 0.98, 0.95) * max(outgoingLight * 1.35, vec3(0.55)), band * fade * 0.5);
    }
  }` : /* glsl */ `
  if (uGfxSurf > 0.5) {
    vec3 d = normalize(vGfxDir);
    vec2 cell = floor(vec2(atan(d.z, d.x) * 180.0, d.y * 260.0));
    float h = vtpH(cell);
    float tw = 0.55 + 0.45 * sin(uGfxT * (1.5 + h * 3.0) + h * 40.0);
    outgoingLight += vec3(step(0.9975, h) * tw * 1.4);
  }`;
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', `${SKY_PARS}\nvoid main() {`).replace(hookF, `${body}\n  ${hookF}`);
  };
  m.customProgramCacheKey = function () { return `${prevKey.call(this)}|vtp${textured ? 'sky' : 'stars'}1`; };
  m.needsUpdate = true;
}

export class Surfaces {
  private water: THREE.MeshStandardMaterial[] = [];
  private skies: THREE.Material[] = [];
  private clouds: { tex: THREE.Texture; base: THREE.Vector2; wrapS: THREE.Wrapping }[] = [];
  private t = 0;
  on = false;

  /** Room load: find the materials (by name). */
  scan(root: THREE.Object3D) {
    const seen = new Set<THREE.Material>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (seen.has(m)) continue;
        seen.add(m);
        if (WATER_RX.test(m.name) && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) this.water.push(m as THREE.MeshStandardMaterial);
        else if (SKY_RX.test(m.name)) this.skies.push(m);
        else if (CLOUD_RX.test(m.name) && (m as THREE.MeshStandardMaterial).map) {
          const tex = ((m as THREE.MeshStandardMaterial).emissiveMap ?? (m as THREE.MeshStandardMaterial).map)!;
          this.clouds.push({ tex, base: tex.offset.clone(), wrapS: tex.wrapS });
        }
      }
    });
  }

  get found() { return { water: this.water.length, sky: this.skies.length, clouds: this.clouds.length }; }

  /** Install the shader patches (tier change / room load only). */
  install() { for (const m of this.water) patchWater(m); for (const m of this.skies) patchSky(m); }

  setOn(on: boolean) {
    this.on = on;
    U.uGfxSurf.value = on ? 1 : 0;
    for (const c of this.clouds) {
      if (on && c.tex.wrapS !== THREE.RepeatWrapping) { c.tex.wrapS = THREE.RepeatWrapping; c.tex.needsUpdate = true; }
      if (!on) { c.tex.offset.copy(c.base); if (c.tex.wrapS !== c.wrapS) { c.tex.wrapS = c.wrapS; c.tex.needsUpdate = true; } }
    }
  }

  update(dt: number, sun: THREE.Vector3 | null, sky: THREE.Color | null) {
    if (!this.on) return;
    this.t += dt;
    U.uGfxT.value = this.t;
    if (sun) U.uGfxSun.value.copy(sun).normalize();
    if (sky) U.uGfxSkyCol.value.copy(sky);
    for (const c of this.clouds) c.tex.offset.x = c.base.x + this.t * 0.0018;
  }

  clear() { this.setOn(false); this.water = []; this.skies = []; this.clouds = []; }
}
