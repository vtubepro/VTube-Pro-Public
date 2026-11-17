// "Toon+" shading for the High / Ultra tiers — anime, not photoreal: a stepped fresnel RIM band (strongest on the edge
// turned away from the key light, tinted by the room + the light show's rim colour) and a stepped Blinn SPECULAR from
// the key light (hair / metal / visors / gear only on avatars; everywhere on NPC gear, masked by the LOD0 atlas's
// alpha). NPC MeshToonMaterials also get a TINTED ramp (cool, colourful shadows instead of grey ones).
//
// One small shader patch per material, installed at a tier change / room load (never mid-show); everything else is
// uniforms. With uGfxOn = 0 a patched material renders exactly as before (Auto pre-installs it so it can step up
// without compiling). Same hook points as src/scene/performerLight.ts (they chain: each calls the previous
// onBeforeCompile first).
import * as THREE from 'three';

export interface GfxToonUniforms {
  uGfxOn: { value: number };
  uGfxRim: { value: THREE.Vector3 };
  uGfxKey: { value: THREE.Vector3 };
  uGfxKeyCol: { value: THREE.Vector3 };
}
/** One set for the whole page (every patched material shares it). */
export const TOON_U: GfxToonUniforms = {
  uGfxOn: { value: 0 },
  uGfxRim: { value: new THREE.Vector3() },
  uGfxKey: { value: new THREE.Vector3(0.4, 0.6, 0.7).normalize() },
  uGfxKeyCol: { value: new THREE.Vector3(1, 1, 1) },
};

const UNIFS = /* glsl */ `
#ifndef VTP_GFX_U
#define VTP_GFX_U
uniform float uGfxOn;
uniform vec3 uGfxRim;
uniform vec3 uGfxKey;
uniform vec3 uGfxKeyCol;
uniform float uGfxSpec;
uniform float uGfxMask;
#endif
`;
const FN = /* glsl */ `
vec3 vtpGfxPlus(vec3 n, vec3 v, vec3 alb, float mask) {
  if (uGfxOn < 0.5) return vec3(0.0);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float side = clamp(0.6 - 0.5 * dot(n, uGfxKey), 0.0, 1.0);
  vec3 rim = uGfxRim * smoothstep(0.6, 0.7, 1.0 - ndv) * side * (0.35 + 0.65 * alb);
  vec3 h = normalize(uGfxKey + v);
  float sp = smoothstep(0.952, 0.968, dot(n, h)) * uGfxSpec * mask;
  return min(rim + uGfxKeyCol * sp, vec3(0.6));
}
`;
const HOOK = '#include <tonemapping_fragment>';
const MTOON_OUT = 'gl_FragColor = vec4( col, diffuseColor.a );';
const GRAD = 'vec3( texture2D( gradientMap, coord ).r )';

/** Spec weight for an avatar material by name (anime: highlights on hair / hard surfaces, not on skin). */
export function avatarSpec(name: string): number {
  if (/hair|bang|fringe|ponytail|twintail|ahoge/i.test(name)) return 0.32;
  if (/metal|visor|glass|lens|helmet|armou?r|leather|boot|shoe|latex|plastic|gem|jewel|chrome|gold|silver|button|buckle|zip/i.test(name)) return 0.45;
  return 0;
}

/** Patch one material (once). `spec` = highlight weight, `mask` = 1 → multiply by the map's alpha (LOD0 atlas). */
export function patchToon(m: THREE.Material, spec: number, mask = 0, tintRamp = false): boolean {
  if (m.userData.vtpGfx) { (m.userData.vtpGfx as { spec: { value: number } }).spec.value = spec; return true; }
  if (/^EMIT_/.test(m.name) || (m as THREE.MeshBasicMaterial).isMeshBasicMaterial || (m as THREE.PointsMaterial).isPointsMaterial || (m as THREE.LineBasicMaterial).isLineBasicMaterial) return false;
  const own = { spec: { value: spec }, mask: { value: mask } };
  m.userData.vtpGfx = own;
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  const isToon = (m as THREE.MeshToonMaterial).isMeshToonMaterial === true;
  m.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    let fs = sh.fragmentShader;
    const addMat = /* glsl */ `
      #ifdef USE_MAP
        float vtpGM = mix(1.0, clamp(texture2D(map, vMapUv).a * 2.0 - 1.0, 0.0, 1.0), uGfxMask);
      #else
        float vtpGM = 1.0;
      #endif
      { vec3 vtpA = vtpGfxPlus(normalize(normal), normalize(vViewPosition), diffuseColor.rgb, vtpGM);
        float vtpMx = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));
        gl_FragColor.rgb += vtpA * clamp((0.97 - vtpMx) / max(max(vtpA.r, max(vtpA.g, vtpA.b)), 1e-4), 0.0, 1.0); }`;
    let out: string | null = null;
    if (fs.includes('void postCorrection') && fs.includes(MTOON_OUT)) {
      const at = fs.lastIndexOf(MTOON_OUT) + MTOON_OUT.length;
      out = `${fs.slice(0, at)}\n  #ifndef OUTLINE\n  { vec3 vtpA = vtpGfxPlus(normalize(normal), normalize(vViewPosition), diffuseColor.rgb, 1.0);\n    float vtpMx = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));\n    gl_FragColor.rgb += vtpA * clamp((0.97 - vtpMx) / max(max(vtpA.r, max(vtpA.g, vtpA.b)), 1e-4), 0.0, 1.0); }\n  #endif${fs.slice(at)}`;
    } else if (/^[ \t]*#include <normal_fragment_begin>/m.test(fs) && fs.includes(HOOK) && fs.includes('vViewPosition') && /vec4 diffuseColor/.test(fs)) {
      out = fs.replace(HOOK, `${addMat}\n${HOOK}`);
    }
    if (!out) return;
    fs = out;
    // a map whose alpha is a specular mask (LOD0 atlas) must not make the surface see-through
    if (mask > 0 && fs.includes('#include <map_fragment>')) fs = fs.replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.a = opacity;');
    if (isToon && tintRamp && fs.includes('#include <gradientmap_pars_fragment>')) {
      const chunk = THREE.ShaderChunk.gradientmap_pars_fragment.replace(GRAD, '(uGfxOn > 0.5 ? texture2D( gradientMap, coord ).rgb : vec3( texture2D( gradientMap, coord ).r ))');
      fs = fs.replace('#include <gradientmap_pars_fragment>', `${UNIFS}\n${chunk}`);
    }
    Object.assign(sh.uniforms, TOON_U, { uGfxSpec: own.spec, uGfxMask: own.mask });
    sh.fragmentShader = fs.replace('void main(', `${UNIFS}\n${FN}\nvoid main(`);
  };
  m.customProgramCacheKey = function () { return `${prevKey.call(this)}|vtpgfx1${tintRamp ? 'r' : ''}`; };
  m.needsUpdate = true;
  return true;
}

/** Cel ramp with coloured (cool, slightly violet) shadows for the NPCs (RGB is used once patched with tintRamp). */
let tinted: THREE.DataTexture | null = null;
export function tintedRamp(): THREE.DataTexture {
  if (tinted) return tinted;
  const d = new Uint8Array([
    128, 130, 170, 255,   // core shadow: cool violet-blue (as bright as the old grey ramp, just coloured)
    146, 146, 180, 255,
    222, 220, 232, 255,   // mid band
    255, 252, 246, 255,   // lit (a touch warm)
    255, 255, 255, 255,
  ]);
  tinted = new THREE.DataTexture(d, 5, 1, THREE.RGBAFormat);
  tinted.minFilter = tinted.magFilter = THREE.NearestFilter;
  tinted.colorSpace = THREE.NoColorSpace;
  tinted.needsUpdate = true;
  return tinted;
}

/** Per frame: key light direction (view space), rim + key colours. */
export function updateToonUniforms(on: boolean, camera: THREE.Camera, key: THREE.DirectionalLight | null, rim: THREE.Color, rimK: number, stageRim: THREE.DirectionalLight | null) {
  TOON_U.uGfxOn.value = on ? 1 : 0;
  if (!on) return;
  if (key) {
    const d = TOON_U.uGfxKey.value.copy(key.position).sub(key.target.position).normalize();
    d.transformDirection(camera.matrixWorldInverse);
    const k = Math.min(1.4, key.intensity / 2);
    TOON_U.uGfxKeyCol.value.set(key.color.r * k, key.color.g * k, key.color.b * k);
  }
  // the room's rim tint, pulled towards the stage rim light's colour (the light show recolours it in effects looks)
  const sr = stageRim ? stageRim.color : rim;
  const sk = stageRim ? Math.min(2, stageRim.intensity / 0.9) : 1;
  TOON_U.uGfxRim.value.set(
    (rim.r * 0.6 + sr.r * 0.4 * sk) * rimK, (rim.g * 0.6 + sr.g * 0.4 * sk) * rimK, (rim.b * 0.6 + sr.b * 0.4 * sk) * rimK);
}
