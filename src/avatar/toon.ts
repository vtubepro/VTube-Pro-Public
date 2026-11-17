// Toon look for non-VRM models: cel-shaded materials + constant-pixel-width inverted-hull outlines
// that follow skinning and morph targets (so outlines stay glued on when the mouth opens).
//
// Per material the look picks a treatment (users never tune this):
//   anime   — cel shading (albedo-tinted shadows, rim, key-light self-shadows, crisp highlights on glossy parts)
//   metal   — in 'anime', metallic materials keep PBR with studio reflections + banded light (stylised metal)
//   toy     — look.shading 'toy' (robots / props): every material is stylised PBR like 'metal'
// All of them get inverted-hull outlines tinted from the surface colour, and cast / receive the key shadow.

import * as THREE from 'three';
import type { LookConfig } from '../../shared/types.ts';
import { SKINNED_VERTEX_MAIN, SKINNED_VERTEX_PARS } from './shaderChunks.ts';
import { markShared } from './gpuDispose.ts';
import { runSync, type Steps } from './loadSlicer.ts';

let gradient: THREE.DataTexture | null = null;
function gradientMap() {
  if (gradient) return gradient;
  // 3-band cel ramp: shadow, mid, lit
  const data = new Uint8Array([150, 150, 150, 255, 215, 215, 215, 255, 255, 255, 255, 255]);
  gradient = markShared(new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat));   // every toon avatar's: outlives each
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  return gradient;
}

/**
 * Generated models (Tripo / Hunyuan & co.) often ship emissive = white × the base-colour texture so they look
 * "unlit" in viewers. Under studio lights that doubles the albedo (washed out, and it would bloom everywhere):
 * drop that baked emissive. Real emissive parts (own colour / own texture) are untouched.
 */
function stripBakedEmissive(src: THREE.Material) {
  const m = src as THREE.MeshStandardMaterial;
  if (!m.emissive || !m.emissiveMap || !m.map || m.userData.vtpBakedEmissive) return;
  const same = m.emissiveMap === m.map || (m.emissiveMap.source && m.emissiveMap.source === m.map.source);
  if (!same || m.emissive.r + m.emissive.g + m.emissive.b < 2.4) return;
  m.userData.vtpBakedEmissive = true;
  m.emissiveMap = null;
  m.emissive.setRGB(0, 0, 0);
  m.needsUpdate = true;
}

const METAL_RE = /steel|metal|chrome|brass|gold|silver|iron|copper|bronze|alumin/i;
/** Authored metal (not glTF's metalness=1 / roughness=1 "unspecified" default, not a packed metalness map). */
function isMetal(src: THREE.Material): boolean {
  const m = src as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial || m.metalnessMap) return false;
  if (m.metalness >= 0.999 && m.roughness >= 0.999) return false;
  return m.metalness >= 0.3 || (METAL_RE.test(m.name) && m.metalness > 0.05);
}

export function toToonMaterial(src: THREE.Material): THREE.Material {
  const m = src as THREE.MeshStandardMaterial;
  if ((m as unknown as { isMToonMaterial?: boolean }).isMToonMaterial || m.type === 'ShaderMaterial') return src;
  const toon = new THREE.MeshToonMaterial({
    color: m.color?.clone() ?? new THREE.Color(0xffffff),
    map: m.map ?? null,
    alphaMap: m.alphaMap ?? null,
    normalMap: m.normalMap ?? null,
    emissive: m.emissive?.clone() ?? new THREE.Color(0),
    emissiveMap: m.emissiveMap ?? null,
    emissiveIntensity: m.emissiveIntensity ?? 1,
    transparent: m.transparent,
    opacity: m.opacity,
    alphaTest: m.alphaTest,
    side: m.side,
    vertexColors: m.vertexColors,
    gradientMap: gradientMap(),
  });
  if (m.alphaTest > 0) toon.alphaToCoverage = true; // MSAA-smoothed cut-outs (hair cards, lashes, fur)
  // see-through overlays (anime iris / eye line / lash / brow cards): glTF material extras { "vtpDepthWrite": false }
  // keep GLTFLoader's no-depth-write for BLEND, so their clear texels never hide what is drawn after them
  const dw = m.userData?.vtpDepthWrite;
  if (dw === false || dw === 0 || dw === 'false') toon.depthWrite = false;
  toon.name = m.name;
  toon.userData.source = m;
  return toon;
}

/** Minimum outline width (NDC units); the stage keeps it at ~1.3 px of the current drawing buffer. */
export const OUTLINE_GLOBALS = { uMinW: { value: 0 } };
/** Called by the stage on resize: outlines never drop below `px` pixels (thin lines alias badly). */
/** (A canvas that isn't laid out yet / is hidden reports a 1 px drawing buffer: its resize must not set this for every
 *  outline on the page, or the hull grows to (2 * px) clip units and one flat-coloured shell covers the whole view.) */
export function setOutlineMinPixels(bufferHeight: number, px = 1.3) { if (bufferHeight >= 32) OUTLINE_GLOBALS.uMinW.value = (px * 2) / bufferHeight; }

/**
 * Inverted-hull outline. With `src` the line takes a deep, saturated shade of the surface colour (texture
 * included) instead of flat black — the "coloured lineart" look of anime key art.
 */
export function outlineMaterial(color: THREE.ColorRepresentation, width: number, src?: THREE.Material | null): THREE.ShaderMaterial {
  const s = src as THREE.MeshStandardMaterial | null | undefined;
  const map = s?.map ?? null;
  const tint = s ? 0.7 : 0;
  return new THREE.ShaderMaterial({
    name: 'vtp-outline',
    side: THREE.BackSide,
    defines: map ? { VTP_OMAP: '' } : {},
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uWidth: { value: width }, uAspect: { value: 1 },
      uMinW: OUTLINE_GLOBALS.uMinW,
      uAlbedo: { value: s?.color?.clone() ?? new THREE.Color(1, 1, 1) }, uTint: { value: tint }, uMap: { value: map },
    },
    vertexShader: /* glsl */ `
      ${SKINNED_VERTEX_PARS}
      uniform float uWidth;
      uniform float uAspect;
      uniform float uMinW;
      #ifdef VTP_OMAP
      varying vec2 vOUv;
      #endif
      void main() {
        ${SKINNED_VERTEX_MAIN}
        #ifdef VTP_OMAP
        vOUv = uv;
        #endif
        // push the hull outward along the view-space normal, constant width in screen space
        vec3 n = normalize(normalMatrix * objectNormal);
        vec4 clipN = projectionMatrix * vec4(n, 0.0);
        vec2 dir = normalize(clipN.xy + 1e-6);
        dir.x /= uAspect;
        gl_Position.xy += dir * max(uWidth, uMinW) * gl_Position.w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor, uAlbedo;
      uniform float uTint;
      #ifdef VTP_OMAP
      uniform sampler2D uMap;
      varying vec2 vOUv;
      #endif
      void main() {
        vec3 a = uAlbedo;
        #ifdef VTP_OMAP
        a *= texture2D(uMap, vOUv).rgb;
        #endif
        float l = dot(a, vec3(0.2126, 0.7152, 0.0722));
        vec3 deep = max(mix(vec3(l), a, 1.5), 0.0) * 0.22;          // darker + more saturated than the surface
        gl_FragColor = vec4(mix(uColor, min(deep, vec3(0.09)), uTint), 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

export interface ToonOptions {
  outline: boolean; outlineColor: string; outlineWidth: number;
  /** Surface look; unset (or shading 'classic') = the original grey-ramp MeshToonMaterial. */
  look?: LookConfig;
}

const GLASS_RE = /lens|glass|visor|goggle/i;

/** Convert all meshes under root to toon + add outline hulls. Returns outline meshes (to toggle/update aspect). */
export function applyToon(root: THREE.Object3D, opts: ToonOptions): THREE.Mesh[] {
  return runSync(applyToonSteps(root, opts));
}

/** applyToon as steps (src/avatar/loadSlicer.ts): a place to give the page back after each mesh (its outline hull). */
export function* applyToonSteps(root: THREE.Object3D, opts: ToonOptions): Steps<THREE.Mesh[]> {
  const outlines: THREE.Mesh[] = [];
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.vtpNoToon) meshes.push(o as THREE.Mesh); });
  const look = opts.look;
  const shading = look?.shading ?? 'classic';
  const shared = shading === 'anime' ? animeUniforms(look!) : null;
  if (shared) root.userData.vtpLook = shared;
  const toy = toyUniforms(look);
  root.userData.vtpToyLook = toy;
  root.userData.vtpPost = postLook(look);
  const outlineMats = new Map<THREE.Material, THREE.ShaderMaterial>();
  const outlineFor = (m: THREE.Material) => {
    let o = outlineMats.get(m);
    if (!o) { o = outlineMaterial(opts.outlineColor, opts.outlineWidth, look && shading !== 'classic' ? m : null); o.userData.vtpSrc = m; outlineMats.set(m, o); }
    return o;
  };
  for (const mesh of meshes) {
    const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of src) stripBakedEmissive(m);
    const conv = src.map((m) => {
      const stylised = (shading === 'toy' || (shading === 'anime' && isMetal(m))) && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial;
      if (stylised && patchToy(m as THREE.MeshStandardMaterial, toy, shading === 'anime')) return m;
      const t = toToonMaterial(m);
      if (shared && (t as THREE.MeshToonMaterial).isMeshToonMaterial) patchAnime(t as THREE.MeshToonMaterial, shared, mesh, isHair(mesh, t, look!), look?.gloss ?? 1);
      return t;
    });
    mesh.material = Array.isArray(mesh.material) ? conv : conv[0];
    // layered see-through overlays draw in a fixed order (node extras { "vtpRenderOrder": n }): iris < line < lash
    if (typeof mesh.userData?.vtpRenderOrder === 'number') mesh.renderOrder = mesh.userData.vtpRenderOrder;
    // key-light self shadows (hair on the face, arms on the body); glass and see-through parts don't cast
    const clear = src.some((m) => GLASS_RE.test(m.name) || (m.transparent && m.opacity < 0.9));
    mesh.castShadow = !clear;
    mesh.receiveShadow = true;
    // (eye parts hidden by the painted-eye replacement, src/avatar/bakedEyes.ts, get no hull either)
    if (!opts.outline || mesh.userData.vtpBakedHidden || mesh.userData.vtpBakedSkinned) continue;
    if (conv.every((m) => m.transparent && m.opacity < 0.95)) continue;
    outlines.push(makeOutline(mesh, Array.isArray(mesh.material) ? src.map(outlineFor) : outlineFor(src[0])));
    yield;
  }
  return outlines;
}

function postLook(look?: LookConfig) {
  return { bloom: look?.bloom, saturation: look?.saturation, contrast: look?.contrast };
}

/**
 * Inverted-hull outlines push each vertex along its normal. Hard edges / UV seams duplicate vertices
 * with DIFFERENT normals, so the hull tears open at seams and its dark inside shows as black lines
 * across the model. The hull therefore gets its own geometry whose normals are averaged across
 * every vertex sharing a position (morph targets are kept so it still follows the face).
 */
function outlineGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.clone();
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
  if (!nrm) { g.computeVertexNormals(); return g; }
  // vertices sharing a position (0.1 mm grid) share a normal: grouped by their grid cell — integer cells hashed, compared
  // exactly (the same groups and the same sums, in the same order, as keying by the cell's text; 4-5x faster: a
  // detailed avatar's hulls took 20-30 ms in one piece of its load)
  const n = pos.count;
  const qx = new Int32Array(n), qy = new Int32Array(n), qz = new Int32Array(n), grp = new Int32Array(n);
  const reps: number[] = [], buckets = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const x = (qx[i] = Math.round(pos.getX(i) * 1e4)), y = (qy[i] = Math.round(pos.getY(i) * 1e4)), z = (qz[i] = Math.round(pos.getZ(i) * 1e4));
    const h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
    const list = buckets.get(h);
    let gi = -1;
    if (list) for (const c of list) { const r = reps[c]; if (qx[r] === x && qy[r] === y && qz[r] === z) { gi = c; break; } }
    if (gi < 0) { gi = reps.length; reps.push(i); if (list) list.push(gi); else buckets.set(h, [gi]); }
    grp[i] = gi;
  }
  const acc = new Float64Array(reps.length * 3);
  for (let i = 0; i < n; i++) { const a = grp[i] * 3; acc[a] += nrm.getX(i); acc[a + 1] += nrm.getY(i); acc[a + 2] += nrm.getZ(i); }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = grp[i] * 3;
    const l = Math.hypot(acc[a], acc[a + 1], acc[a + 2]) || 1;
    out[i * 3] = acc[a] / l; out[i * 3 + 1] = acc[a + 1] / l; out[i * 3 + 2] = acc[a + 2] / l;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  delete g.morphAttributes.normal; // seam-split morph normals would re-open the cracks
  return g;
}

export function makeOutline(mesh: THREE.Mesh, mat: THREE.Material | THREE.Material[]): THREE.Mesh {
  let o: THREE.Mesh;
  const geo = outlineGeometry(mesh.geometry);
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
    const sm = mesh as THREE.SkinnedMesh;
    const so = new THREE.SkinnedMesh(geo, mat);
    so.bind(sm.skeleton, sm.bindMatrix);
    o = so;
  } else {
    o = new THREE.Mesh(geo, mat);
  }
  o.name = `${mesh.name}_outline`;
  o.userData.vtpOutline = true;
  o.userData.vtpOutlineOf = mesh;   // its source (Avatar detail switches the two together: src/avatar/lod/extract.ts)
  o.userData.vtpNoToon = true;
  o.position.copy(mesh.position); o.quaternion.copy(mesh.quaternion); o.scale.copy(mesh.scale);
  o.frustumCulled = false;
  o.renderOrder = -1;
  // share morph weights so the hull deforms with the face
  o.morphTargetDictionary = mesh.morphTargetDictionary;
  o.morphTargetInfluences = mesh.morphTargetInfluences;
  mesh.parent?.add(o);
  return o;
}

// ---------------------------------------------------------------- anime cel shading
// MeshToonMaterial patched in onBeforeCompile (so skinning, morphs, maps, normal maps, emissive and the
// outline hulls all keep working): one crisp terminator against the key light, shadows coloured from the
// albedo (saturated + hue-shifted by a tint, never grey), a warm band at the terminator, a soft fresnel rim,
// and on hair an angel-ring highlight band that rides the head (skinned up-axis, view-dependent).
// On high tiers the key light's shadow map joins the terminator (hair shadow on the face, arm on the body),
// and glossy materials (low roughness in the source PBR material) get a crisp cel highlight.

const HAIR_RE = /hair|bang|fringe|ponytail|twintail/i;
function isHair(mesh: THREE.Mesh, m: THREE.Material, look: LookConfig): boolean {
  if (look.hairMeshes?.length) return look.hairMeshes.some((n) => n === mesh.name || n === m.name);
  return HAIR_RE.test(mesh.name) || HAIR_RE.test(m.name);
}

type Uniforms = Record<string, THREE.IUniform>;

// Mouth interiors / cavities must stay dark: a fresnel rim on their grazing walls reads as grey sheen
// inside the mouth. Per-material override: glTF material extras { "vtpRim": 0..1 } (multiplier).
const CAVITY_RE = /mouth|tongue|interior|cavity|throat|gum/i;
function rimScale(m: THREE.Material): number {
  const src = (m.userData?.source as THREE.Material | undefined) ?? m;
  const x = (src.userData?.vtpRim ?? m.userData?.vtpRim) as unknown;
  if (typeof x === 'number' && isFinite(x)) return THREE.MathUtils.clamp(x, 0, 2);
  return CAVITY_RE.test(m.name) ? 0.1 : 1;
}
// Per-material terminator shift (MToon-style shadeShift): glTF material extras { "vtpShadeShift": -1..1 }.
// Negative = lit further round the form (anime / comic faces: only a slim shadow on the far side of the face).
function shadeShift(m: THREE.Material): number {
  const src = (m.userData?.source as THREE.Material | undefined) ?? m;
  const x = (src.userData?.vtpShadeShift ?? m.userData?.vtpShadeShift) as unknown;
  return typeof x === 'number' && isFinite(x) ? THREE.MathUtils.clamp(x, -1, 1) : 0;
}
function animeUniforms(look: LookConfig): Uniforms {
  return {
    uVtpShade: { value: new THREE.Color(look.shadowTint || '#ceb6c2') },
    uVtpShadeCool: { value: new THREE.Color('#b4b8d4') },
    uVtpRim: { value: look.rim ?? 0.5 },
    uVtpSoft: { value: look.softness ?? 0.15 },
    uVtpHair: { value: look.hairShine ?? 0.6 },
    uVtpTh: { value: 0.2 },
  };
}

/** Live-update the anime look (rim, tint, softness, hair shine) of a model built with applyToon. */
export function setToonLook(root: THREE.Object3D, look: LookConfig) {
  const R = root.userData.vtpRealLook as Uniforms | undefined;
  if (R) { R.uVtpStylize.value = THREE.MathUtils.clamp(look.stylize ?? 0, 0, 1); R.uVtpRimR.value = look.rim ?? 0.2; }
  if (root.userData.vtpPost) root.userData.vtpPost = postLook(look);
  const T = root.userData.vtpToyLook as Uniforms | undefined;
  if (T) { T.uVtpToyRim.value = look.rim ?? 0.5; T.uVtpToySoft.value = look.softness ?? 0.15; T.uVtpToySpec.value = look.gloss ?? 1; }
  const U = root.userData.vtpLook as Uniforms | undefined;
  if (!U) return;
  (U.uVtpShade.value as THREE.Color).set(look.shadowTint || '#ceb6c2');
  U.uVtpRim.value = look.rim ?? 0.5;
  U.uVtpSoft.value = look.softness ?? 0.15;
  U.uVtpHair.value = look.hairShine ?? 0.6;
  // gloss is baked per material at build (a define + uniform); a rebuild picks up big changes
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).isMesh ? ([] as THREE.Material[]).concat((o as THREE.Mesh).material) : [];
    for (const m of mats) if (m.userData.vtpGlossU) (m.userData.vtpGlossU as THREE.IUniform).value = (m.userData.vtpGlossBase as number) * (look.gloss ?? 1);
  });
}

// Key-light shadow capture: the lighting loop already evaluates the shadow map for every directional light;
// grab light 0's factor (shadow-casting lights are sorted first, and only the stage's key casts).
const SHADOW_LINE_RE = /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? (getShadow\( directionalShadowMap\[ i \][^;]*?) : 1\.0;/;
function lightsBeginWithShadowCapture(): string | null {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  if (!SHADOW_LINE_RE.test(chunk)) return null;
  return chunk.replace(SHADOW_LINE_RE, (_all, call: string) =>
    `{ float vtpS = ( directLight.visible && receiveShadow ) ? ${call} : 1.0; directLight.color *= vtpS; if ( UNROLLED_LOOP_INDEX == 0 ) vtpShadowK = vtpS; }`);
}

const ANIME_VERT_PARS = /* glsl */ `
varying vec3 vVtpUp;
varying vec3 vVtpRest;
uniform vec3 uVtpUpObj;
`;
const ANIME_VERT_MAIN = /* glsl */ `
  {
    vec3 vtpUp = uVtpUpObj;
    #ifdef USE_SKINNING
      vtpUp = ( skinMatrix * vec4( vtpUp, 0.0 ) ).xyz;
    #endif
    vVtpUp = normalize( ( modelViewMatrix * vec4( vtpUp, 0.0 ) ).xyz );
    vVtpRest = position;
  }
`;
const ANIME_FRAG_PARS = /* glsl */ `
uniform vec3 uVtpShade, uVtpShadeCool;
uniform float uVtpRim, uVtpSoft, uVtpHair, uVtpTh, uVtpRimK, uVtpGloss, uVtpShift;
uniform vec3 uVtpCenter, uVtpSideObj, uVtpFwdObj, uVtpUpObj;
varying vec3 vVtpUp;
varying vec3 vVtpRest;
float vtpLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
`;
const ANIME_FRAG_MAIN = /* glsl */ `
  vec3 vtpA = diffuseColor.rgb;
  // key light = the brightest directional light (the stage's key; the back light only feeds the rim)
  vec3 vtpL = normalize( vec3( 0.3, 0.6, 0.75 ) );
  float vtpBest = -1.0;
  #if NUM_DIR_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    {
      float vtpW = vtpLuma( directionalLights[ i ].color );
      if ( vtpW > vtpBest ) { vtpBest = vtpW; vtpL = directionalLights[ i ].direction; }
    }
  }
  #pragma unroll_loop_end
  #endif
  vec3 vtpN = normalize( normal );
  vec3 vtpV = normalize( vViewPosition );
  float vtpNdl = dot( vtpN, vtpL );
  // cel terminator: one crisp band, softened by uVtpSoft
  float vtpW2 = mix( 0.015, 0.22, uVtpSoft );
  float vtpLit = smoothstep( uVtpTh + uVtpShift - vtpW2, uVtpTh + uVtpShift + vtpW2, vtpNdl );
  // cast shadow from the key (shadow-mapped tiers): same cel edge, a touch softer
  vtpLit = min( vtpLit, smoothstep( 0.3, 0.7, vtpShadowK ) );
  // shadow colour from the albedo: more saturated, darker, hue-shifted by the tint (warm on saturated
  // colours like skin, cooler lavender on near-neutral ones like white cloth) — never grey
  float vtpLa = vtpLuma( vtpA );
  vec3 vtpSat = max( mix( vec3( vtpLa ), vtpA, 1.35 ), 0.0 );
  float vtpChroma = clamp( ( max( vtpA.r, max( vtpA.g, vtpA.b ) ) - min( vtpA.r, min( vtpA.g, vtpA.b ) ) ) / max( max( vtpA.r, max( vtpA.g, vtpA.b ) ), 1e-3 ) * 2.5, 0.0, 1.0 );
  vec3 vtpShade = vtpSat * mix( uVtpShadeCool, uVtpShade, vtpChroma );
  vec3 vtpLitC = vtpA * mix( 0.96, 1.04, smoothstep( 0.25, 0.95, vtpNdl ) );
  vec3 vtpCol = mix( vtpShade, vtpLitC, vtpLit );
  // saturated warm band right at the terminator (the painted "subsurface" edge of anime skin)
  float vtpBand = vtpLit * ( 1.0 - vtpLit ) * 4.0;
  vtpCol = mix( vtpCol, vtpSat * mix( vec3( 1.0 ), uVtpShade, 0.45 ), vtpBand * 0.35 * vtpChroma );
  // soft fresnel rim, stronger on the lit side, tinted from the albedo
  float vtpFres = 1.0 - clamp( dot( vtpN, vtpV ), 0.0, 1.0 );
  float vtpRim = smoothstep( 0.55, 0.92, vtpFres ) * mix( 0.45, 1.0, vtpLit );
  vtpCol += mix( vtpA, vec3( 1.0 ), 0.55 ) * vtpRim * uVtpRim * uVtpRimK * 0.45;
  #ifdef VTP_GLOSS
  {
    // crisp cel highlight on glossy surfaces (wet frog skin, plastic, lacquer): a hard-edged blob whose size
    // follows the source roughness, only where the key actually lands
    vec3 vtpHv = normalize( vtpL + vtpV );
    float vtpShin = mix( 18.0, 140.0, uVtpGloss );
    float vtpS = pow( max( dot( vtpN, vtpHv ), 0.0 ), vtpShin ) - 0.45;
    float vtpFw = fwidth( vtpS ) + 1e-4;
    float vtpHl = smoothstep( -vtpFw, vtpFw, vtpS ) * vtpLit;
    vtpCol = mix( vtpCol, mix( vtpA, vec3( 1.0 ), 0.75 ) * 1.02, vtpHl * clamp( uVtpGloss * 1.3, 0.0, 0.85 ) );
  }
  #endif
  #ifdef VTP_HAIR
  {
    // angel ring: Kajiya-Kay-style band across the strands (strands run along the head's up axis),
    // shifted up toward the crown, crisp cel edges with a jagged strand-tip lower edge
    vec3 vtpT = normalize( vVtpUp - vtpN * dot( vtpN, vVtpUp ) + 1e-5 );
    vec3 vtpTs = normalize( vtpT + vtpN * 0.3 );
    vec3 vtpH = normalize( vtpV + vtpL * 0.5 );
    float vtpD = dot( vtpTs, vtpH );                       // 0 at the ring centre
    vec3 vtpRel = vVtpRest - uVtpCenter;
    float vtpAng = atan( dot( vtpRel, uVtpSideObj ), dot( vtpRel, uVtpFwdObj ) );
    float vtpTri = abs( fract( vtpAng * 4.5 ) - 0.5 ) * 2.0;            // strand-clump zigzag
    float vtpTri2 = abs( fract( vtpAng * 11.0 + 0.3 ) - 0.5 ) * 2.0;
    float vtpHalf = 0.09;
    float vtpLo = vtpHalf * ( 0.6 + 1.6 * vtpTri * vtpTri + 0.5 * vtpTri2 );
    float vtpE1 = vtpHalf * 0.8 - vtpD;                    // upper edge (smooth)
    float vtpE2 = vtpD + vtpLo;                            // lower edge (jagged)
    float vtpRing = smoothstep( 0.0, fwidth( vtpE1 ) + 1e-4, vtpE1 ) * smoothstep( 0.0, fwidth( vtpE2 ) + 1e-4, vtpE2 );
    vtpRing *= smoothstep( 0.05, 0.35, dot( vtpN, vtpV ) );
    vec3 vtpRingC = mix( vtpA * 1.9 + 0.06, vec3( 1.0 ), 0.3 );
    vtpCol = mix( vtpCol, vtpRingC, vtpRing * uVtpHair * mix( 0.55, 1.0, vtpLit ) );
  }
  #endif
  vec3 outgoingLight = vtpCol + totalEmissiveRadiance;
`;
const TOON_OUT = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';

/** Cel-highlight strength from the source material's roughness (0 = matte: no highlight). */
function glossOf(m: THREE.Material): number {
  const src = ((m.userData?.source as THREE.Material | undefined) ?? m) as THREE.MeshStandardMaterial;
  if (!src.isMeshStandardMaterial || src.roughnessMap) return 0;
  if (src.metalness >= 0.999 && src.roughness >= 0.999) return 0; // glTF "unspecified" defaults
  return THREE.MathUtils.clamp((0.72 - src.roughness) / 0.5, 0, 1);
}

function patchAnime(mat: THREE.MeshToonMaterial, shared: Uniforms, mesh: THREE.Mesh, hair: boolean, glossK: number) {
  // per-mesh frame: the avatar's up / forward axes in this mesh's object (bind) space
  mesh.updateWorldMatrix(true, false);
  const inv = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert();
  const up = new THREE.Vector3(0, 1, 0).applyMatrix3(inv).normalize();
  const fwd = new THREE.Vector3(0, 0, 1).applyMatrix3(inv);
  fwd.addScaledVector(up, -fwd.dot(up)).normalize();
  const side = new THREE.Vector3().crossVectors(up, fwd).normalize();
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const center = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3());
  const gloss = CAVITY_RE.test(mat.name) ? 0 : glossOf(mat);
  const glossU: THREE.IUniform = { value: gloss * glossK };
  const own: Uniforms = { uVtpUpObj: { value: up }, uVtpFwdObj: { value: fwd }, uVtpSideObj: { value: side }, uVtpCenter: { value: center }, uVtpRimK: { value: rimScale(mat) }, uVtpGloss: glossU, uVtpShift: { value: shadeShift(mat) } };
  if (hair) mat.defines = { ...(mat.defines ?? {}), VTP_HAIR: '' };
  if (gloss > 0.02) { mat.defines = { ...(mat.defines ?? {}), VTP_GLOSS: '' }; mat.userData.vtpGlossU = glossU; mat.userData.vtpGlossBase = gloss; }
  mat.userData.vtpAnime = true;
  const lightsBegin = lightsBeginWithShadowCapture();
  mat.onBeforeCompile = (sh) => {
    if (!sh.fragmentShader.includes(TOON_OUT)) return; // unknown three.js version → keep the classic look
    Object.assign(sh.uniforms, shared, own);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
${ANIME_VERT_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
${ANIME_VERT_MAIN}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${ANIME_FRAG_PARS}`)
      .replace('#include <lights_fragment_begin>', `float vtpShadowK = 1.0;
${lightsBegin ?? '#include <lights_fragment_begin>'}`)
      .replace(TOON_OUT, ANIME_FRAG_MAIN);
  };
  mat.customProgramCacheKey = () => 'vtp-anime-2' + (lightsBegin ? 's' : '');
  mat.needsUpdate = true;
}

// ---------------------------------------------------------------- stylised PBR (toy / robot / metal)
// Keeps the model's MeshStandard / Physical material (so the studio environment gives plastics and metals
// real reflections) but stylises the key light: a banded terminator instead of Lambert falloff, a crisp
// toon highlight sized by roughness on top of a softened GGX lobe, a fresnel rim, and a highlight shoulder
// that leaves emissive parts unclipped (they're what blooms).

function toyUniforms(look?: LookConfig): Uniforms {
  return {
    uVtpToyTh: { value: 0.05 },
    uVtpToySoft: { value: look?.softness ?? 0.15 },
    uVtpToyRim: { value: look?.rim ?? 0.5 },
    uVtpToySpec: { value: look?.gloss ?? 1 },
    uVtpToySmooth: { value: 0.45 },
    uVtpToyKey: { value: 1.35 },
    uVtpToyAmb: { value: 1.0 },
  };
}

const TOY_PARS = /* glsl */ `
uniform float uVtpToyTh, uVtpToySoft, uVtpToyRim, uVtpToySpec, uVtpToySmooth, uVtpToyKey, uVtpToyAmb;
float vtpToyBand( float ndl ) {
  float w = mix( 0.03, 0.3, uVtpToySoft );
  float b = smoothstep( uVtpToyTh - w, uVtpToyTh + w, ndl );
  return b * mix( 0.72, 1.0, smoothstep( 0.15, 0.9, ndl ) );
}
`;
const TOY_HL = /* glsl */ `
vec3 vtpToyHL( const in vec3 L, const in vec3 V, const in vec3 N, const in PhysicalMaterial material ) {
  float gloss = clamp( 1.0 - material.roughness, 0.0, 1.0 );
  float k = smoothstep( 0.3, 0.8, gloss ) * uVtpToySpec;
  vec3 H = normalize( L + V );
  float shin = exp2( mix( 3.5, 8.5, gloss ) );
  float s = pow( max( dot( N, H ), 0.0 ), shin ) - 0.5;
  float fw = fwidth( s ) + 1e-4;
  float hl = smoothstep( -fw, fw, s );
  float sc = max( material.specularColor.r, max( material.specularColor.g, material.specularColor.b ) );
  float metal = smoothstep( 0.08, 0.4, sc );
  vec3 tint = mix( vec3( 1.0 ), material.specularColor / max( sc, 1e-3 ), metal * 0.8 );
  return tint * hl * k * 0.5;
}
`;
const TOY_OUT = /* glsl */ `
  {
    vec3 vtpE = totalEmissiveRadiance;
    vec3 vtpC = max( outgoingLight - vtpE, 0.0 );
    float vtpNV = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
    vtpC += mix( diffuseColor.rgb, vec3( 1.0 ), 0.4 ) * uVtpToyRim * smoothstep( 0.55, 0.95, 1.0 - vtpNV ) * 0.22;
    vec3 vtpX = max( vtpC - 0.82, 0.0 );
    vtpC = min( vtpC, 0.82 ) + vtpX / ( 1.0 + vtpX / 0.24 );
    outgoingLight = vtpC + vtpE;
  }
  #include <opaque_fragment>`;
const TOY_IRR = 'vec3 irradiance = dotNL * directLight.color;';
const TOY_FN = 'void RE_Direct_Physical(';
const TOY_SPEC = 'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;';

/** Stylised-PBR patch. Returns false (material untouched) on an unknown three.js shader layout. */
function patchToy(std: THREE.MeshStandardMaterial, U: Uniforms, metalOnly: boolean): boolean {
  if (std.userData.vtpToy) return true;
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (!chunk.includes(TOY_IRR) || !chunk.includes(TOY_SPEC) || !chunk.includes(TOY_FN)) return false;
  std.userData.vtpToy = true;
  // glTF metalness=1/roughness=1 with no maps means "unspecified" (common in generated models): dielectric
  if (!metalOnly && !std.metalnessMap && !std.roughnessMap && std.metalness >= 0.999 && std.roughness >= 0.999) { std.metalness = 0; std.roughness = 0.6; }
  if (std.alphaTest > 0) std.alphaToCoverage = true;
  const patched = chunk
    .replace(TOY_FN, TOY_HL + TOY_FN)
    .replace(TOY_IRR, 'vec3 irradiance = vtpToyBand( dot( geometryNormal, directLight.direction ) ) * directLight.color;')
    .replace(TOY_SPEC, 'reflectedLight.directSpecular += irradiance * ( specularBRDF * uVtpToySmooth * material.multiScatteringCompensation + vtpToyHL( directLight.direction, geometryViewDir, geometryNormal, material ) );');
  std.onBeforeCompile = (sh) => {
    if (!sh.fragmentShader.includes('#include <lights_physical_pars_fragment>') || !sh.fragmentShader.includes('#include <opaque_fragment>')) return;
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', TOY_PARS + patched)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.indirectDiffuse *= uVtpToyAmb; reflectedLight.directDiffuse *= uVtpToyKey; reflectedLight.directSpecular *= uVtpToyKey;')
      .replace('#include <opaque_fragment>', TOY_OUT);
  };
  std.customProgramCacheKey = () => 'vtp-toy-2';
  std.needsUpdate = true;
  return true;
}

// ---------------------------------------------------------------- realistic (PBR) look
// look.shading 'realistic' keeps the model's own MeshStandard/Physical materials (no toon, no outlines) and
// patches them lightly: skin gets wrapped diffuse with red-shifted light bleed at the terminator (a cheap
// subsurface stand-in), every surface gets a soft highlight shoulder (the stage renders without tone mapping,
// so lit skin would clip), a faint fresnel rim, and `stylize` pulls the diffuse toward two soft bands for the
// semi-stylised end of the human creator. Alpha-clipped cards (hair, brows, lashes) use alpha-to-coverage.

const SKIN_RE = /skin|body/i;
const REAL_PARS = /* glsl */ `
uniform float uVtpStylize, uVtpSSS, uVtpRimR, uVtpAmb, uVtpKey, uVtpHairSheen;
vec3 vtpDiffuseIrr( const in vec3 n, const in IncidentLight L ) {
  float w = dot( n, L.direction );
  #ifdef VTP_SKIN
    vec3 k = vec3( 0.45, 0.2, 0.12 ) * uVtpSSS;
    vec3 d = clamp( ( vec3( w ) + k ) / ( 1.0 + k ), 0.0, 1.0 );
    d = d * d * ( 3.0 - 2.0 * d ) * 0.35 + d * 0.65;
  #else
    vec3 d = vec3( clamp( w, 0.0, 1.0 ) );
  #endif
  vec3 band = smoothstep( vec3( 0.05 ), vec3( 0.3 ), d ) * 0.8 + d * 0.2;
  return mix( d, band, uVtpStylize ) * L.color;
}
`;
const REAL_OUT = /* glsl */ `
  {
    float vtpNV = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
    outgoingLight += diffuseColor.rgb * uVtpRimR * pow( 1.0 - vtpNV, 3.0 ) * 0.35;
    #if defined( VTP_HAIRR ) && NUM_DIR_LIGHTS > 0
    {
      // Kajiya-Kay style dual highlight along the strands (cards run down the head's up axis)
      vec3 vtpN2 = normalize( normal );
      vec3 vtpV2 = normalize( vViewPosition );
      vec3 vtpUp2 = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
      vec3 vtpT2 = normalize( vtpUp2 - vtpN2 * dot( vtpN2, vtpUp2 ) + 1e-5 );
      vec3 vtpL2 = directionalLights[ 0 ].direction;
      vec3 vtpH2 = normalize( vtpL2 + vtpV2 );
      float vtpA1 = dot( normalize( vtpT2 + vtpN2 * 0.12 ), vtpH2 );
      float vtpA2 = dot( normalize( vtpT2 - vtpN2 * 0.2 ), vtpH2 );
      float vtpS1 = pow( sqrt( max( 0.0, 1.0 - vtpA1 * vtpA1 ) ), 90.0 );
      float vtpS2 = pow( sqrt( max( 0.0, 1.0 - vtpA2 * vtpA2 ) ), 22.0 );
      float vtpLit2 = clamp( dot( vtpN2, vtpL2 ) * 0.5 + 0.5, 0.0, 1.0 );
      outgoingLight += ( vec3( vtpS1 ) * 0.07 + diffuseColor.rgb * vtpS2 * 0.3 ) * directionalLights[ 0 ].color * vtpLit2 * uVtpHairSheen;
    }
    #endif
    vec3 vtpX = max( outgoingLight - 0.78, 0.0 );
    outgoingLight = min( outgoingLight, 0.78 ) + vtpX / ( 1.0 + vtpX / 0.22 );
  }
  #include <opaque_fragment>`;
const DIFFUSE_RE = /reflectedLight\.directDiffuse \+= irradiance \*/;

/** Keep PBR materials, add skin wrap lighting / stylisation. Returns nothing to toggle (no outlines). */
export function applyRealistic(root: THREE.Object3D, look: LookConfig) {
  const U: Uniforms = {
    uVtpStylize: { value: THREE.MathUtils.clamp(look.stylize ?? 0, 0, 1) },
    uVtpSSS: { value: 1 },
    uVtpRimR: { value: look.rim ?? 0.2 },
    uVtpAmb: { value: 0.72 }, // the stage's hemisphere fill is tuned for cel shading: flatter than a key-lit face
    uVtpKey: { value: 1.2 },
    uVtpHairSheen: { value: look.hairShine ?? 0.6 },
  };
  root.userData.vtpRealLook = U;
  root.userData.vtpPost = postLook(look);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || o.userData.vtpNoToon) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.castShadow = !mats.some((m) => GLASS_RE.test(m.name) || (m.transparent && m.opacity < 0.9));
    mesh.receiveShadow = true;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
      patchRealistic(m, U, SKIN_RE.test(m.name) || SKIN_RE.test(mesh.name), isHair(mesh, m, look));
  });
}

function patchRealistic(m: THREE.Material, U: Uniforms, skin: boolean, hair: boolean) {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial || std.userData.vtpReal) return;
  std.userData.vtpReal = true;
  if (std.alphaTest > 0) std.alphaToCoverage = true;
  if (skin) std.defines = { ...(std.defines ?? {}), VTP_SKIN: '' };
  if (hair) std.defines = { ...(std.defines ?? {}), VTP_HAIRR: '' };
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (!DIFFUSE_RE.test(chunk)) return; // unknown three.js version → plain PBR
  std.onBeforeCompile = (sh) => {
    if (!sh.fragmentShader.includes('#include <lights_physical_pars_fragment>') || !sh.fragmentShader.includes('#include <opaque_fragment>')) return;
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', REAL_PARS + chunk.replace(DIFFUSE_RE, 'reflectedLight.directDiffuse += vtpDiffuseIrr( geometryNormal, directLight ) *'))
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.indirectDiffuse *= uVtpAmb; reflectedLight.directDiffuse *= uVtpKey;')
      .replace('#include <opaque_fragment>', REAL_OUT);
  };
  std.customProgramCacheKey = () => 'vtp-real-2' + (skin ? 's' : '') + (hair ? 'h' : '');
  std.needsUpdate = true;
}
