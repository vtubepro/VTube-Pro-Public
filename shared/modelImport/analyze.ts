// "Just drop a model": everything the import report says about a glTF / GLB / VRM, read straight from the file (no
// three.js, no GPU): VRM 0.x / 1.0, skeleton + which bones map to the humanoid (shared/modelImport/bones.ts), face
// shapes + their mapping (morphs.ts), size / units / up axis / facing, T- or A-pose, textures (sizes, missing ones),
// polycount, materials that render badly, compression the studio can't open. Pure; tests: tools/model_import_unit.ts.
import { apply, imageBytes, imageSize, mul, readAccessor, worldMatrices, type GltfDoc, type Json, type Mat4 } from './gltf.ts';
import { mapBones, type BoneIn, type BoneMapResult, type HumanBone } from './bones.ts';
import { analyzeMorphs, type MorphReport } from './morphs.ts';
import { gltfStats } from '../modelStats.ts';

export type Axis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export interface ImageFact { index: number; name: string; mime: string | null; w: number; h: number; alpha: boolean; bytes: number }
export interface MaterialIssue { material: string; level: 'warn' | 'info'; what: string; fix?: 'specgloss' }

export interface GltfFacts {
  container: 'vrm0' | 'vrm1' | 'glb';
  generator: string;
  /** Things the studio can't open at all (each a full "what to do" sentence). Empty = it loads. */
  blockers: string[];
  stats: { tris: number; verts: number; meshes: number; materials: number; textures: number; primitives: number; nodes: number };
  skinned: boolean;
  /** Skin joints (+ bones the VRM humanoid names), with rest positions in world space (file units). */
  bones: BoneIn[];
  boneMap: BoneMapResult | null;
  /** VRM files name their humanoid bones themselves. */
  vrmBones: string[];
  morphs: string[];
  vrmExpressions: string[];
  face: MorphReport;
  springs: number;
  animations: string[];
  /** World-space bounds of the meshes in file units. */
  min: [number, number, number];
  max: [number, number, number];
  up: Axis;
  upFrom: 'bones' | 'shape' | 'spec';
  /** Height along the up axis, in file units. */
  height: number;
  /** After turning it upright: does it face +Z (the camera)? null = can't tell (no left / right bones). */
  facesCamera: boolean | null;
  /** Upper-arm angle below horizontal, degrees (0 = T-pose, ~30-45 = A-pose, ~80 = arms down). null = no arms. */
  armAngle: number | null;
  images: ImageFact[];
  /** Rough GPU memory of all textures with mipmaps, bytes. */
  textureMemory: number;
  materialIssues: MaterialIssue[];
  /** Images referenced by uri that were not found (only for .gltf with external files; GLB/VRM embed them). */
  missingImages: string[];
}

const AXES: Axis[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const axisOf = (v: readonly number[]): Axis => {
  const a = v.map(Math.abs), i = a.indexOf(Math.max(...a));
  return AXES[i * 2 + (v[i] >= 0 ? 0 : 1)];
};

/** Rotation that makes `up` point to +Y (as a root-node fix): rotX / rotZ in degrees. */
export function uprightFix(up: Axis): { rotX?: number; rotZ?: number } {
  switch (up) {
    case '+Z': return { rotX: -90 };
    case '-Z': return { rotX: 90 };
    case '-Y': return { rotX: 180 };
    case '+X': return { rotZ: 90 };
    case '-X': return { rotZ: -90 };
    default: return {};
  }
}
/** A point in the file's space after uprightFix. */
export function uprightPoint(p: readonly number[], up: Axis): [number, number, number] {
  const [x, y, z] = p;
  switch (up) {
    case '+Z': return [x, z, -y];
    case '-Z': return [x, -z, y];
    case '-Y': return [x, -y, -z];
    case '+X': return [-y, x, z];
    case '-X': return [y, -x, z];
    default: return [x, y, z];
  }
}

const SUPPORTED_REQUIRED = new Set(['KHR_materials_unlit', 'KHR_texture_transform', 'KHR_mesh_quantization', 'EXT_meshopt_compression', 'EXT_texture_webp',
  'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_clearcoat',
  'KHR_materials_sheen', 'KHR_materials_iridescence', 'KHR_materials_anisotropy', 'KHR_lights_punctual', 'EXT_mesh_gpu_instancing', 'KHR_materials_dispersion']);

export function analyzeGltf(doc: GltfDoc, opts: { missingImages?: string[] } = {}): GltfFacts {
  const json = doc.json;
  const arr = (k: string): Json[] => (Array.isArray(json[k]) ? json[k] : []);
  const nodes = arr('nodes'), meshes = arr('meshes'), skins = arr('skins'), materials = arr('materials');
  const ext = json.extensions ?? {};
  const container: GltfFacts['container'] = ext.VRMC_vrm ? 'vrm1' : ext.VRM ? 'vrm0' : 'glb';
  const blockers: string[] = [];
  const req: string[] = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  if (req.includes('KHR_draco_mesh_compression')) blockers.push('It is saved with Draco compression, which VTube Pro can’t open. Export it again with compression off (Blender: glTF export → Data → Compression off).');
  if (req.includes('KHR_texture_basisu')) blockers.push('Its textures are KTX2 / Basis compressed, which VTube Pro can’t open. Export it again with normal PNG or JPEG textures (gltfpack: turn KTX2 off).');
  const unknown = req.filter((e) => e !== 'KHR_draco_mesh_compression' && e !== 'KHR_texture_basisu' && !SUPPORTED_REQUIRED.has(e) && !e.startsWith('VRM'));
  if (unknown.length) blockers.push(`It needs ${unknown.join(', ')}, which VTube Pro can’t read. Export it again as a plain .glb from Blender.`);
  if (!meshes.length) blockers.push('There is nothing to show in this file (no meshes: only a skeleton, animation or camera). Export the model with its meshes.');
  // buffers the meshes need but nobody dropped (.gltf with a missing .bin)
  const lostBuffers = (Array.isArray(json.buffers) ? json.buffers : []).map((_: unknown, i: number) => i).filter((i: number) => !doc.buffers[i]);
  if (lostBuffers.length) {
    const names = lostBuffers.map((i: number) => String(json.buffers[i]?.uri ?? `buffer ${i}`));
    blockers.push(`Its geometry file${names.length > 1 ? 's are' : ' is'} missing (${names.join(', ')}). Drop the whole folder or a .zip with the .gltf and its .bin, or export a single .glb.`);
  }
  const s = gltfStats(json);
  const stats = { ...s, primitives: meshes.reduce((n: number, m: Json) => n + (Array.isArray(m?.primitives) ? m.primitives.length : 0), 0), nodes: nodes.length };
  const { world, parent } = worldMatrices(json);

  // ---- skeleton
  const jointSet = new Set<number>();
  for (const sk of skins) for (const j of Array.isArray(sk?.joints) ? sk.joints : []) if (typeof j === 'number' && j < nodes.length) jointSet.add(j);
  const vrmBoneNodes = new Map<number, string>();
  if (container === 'vrm0') for (const hb of ext.VRM?.humanoid?.humanBones ?? []) if (typeof hb?.node === 'number') vrmBoneNodes.set(hb.node, String(hb.bone));
  if (container === 'vrm1') for (const [b, v] of Object.entries(ext.VRMC_vrm?.humanoid?.humanBones ?? {})) if (typeof (v as Json)?.node === 'number') vrmBoneNodes.set((v as Json).node, b);
  for (const n of vrmBoneNodes.keys()) jointSet.add(n);
  // weighted joints (what the skin actually follows)
  const weightedNodes = new Set<number>();
  let weightsKnown = false;
  meshes.forEach((m, mi) => {
    const users = nodes.map((n, i) => ({ n, i })).filter((x) => x.n?.mesh === mi && typeof x.n?.skin === 'number');
    if (!users.length) return;
    const joints: number[] = skins[users[0].n.skin]?.joints ?? [];
    for (const p of Array.isArray(m?.primitives) ? m.primitives : []) {
      for (let set = 0; set < 2; set++) {
        const ja = p?.attributes?.[`JOINTS_${set}`], wa = p?.attributes?.[`WEIGHTS_${set}`];
        if (ja === undefined || wa === undefined) continue;
        const J = readAccessor(doc, ja, 2_000_000), W = readAccessor(doc, wa, 2_000_000);
        if (!J || !W) continue;
        weightsKnown = true;
        for (let k = 0; k < Math.min(J.data.length, W.data.length); k++) if (W.data[k] > 0.001) { const node = joints[J.data[k]]; if (node !== undefined) weightedNodes.add(node); }
      }
    }
  });
  const order = [...jointSet].sort((a, b) => a - b);
  const idx = new Map(order.map((n, i) => [n, i]));
  const bones: BoneIn[] = order.map((n) => {
    let p = parent[n];
    while (p >= 0 && !idx.has(p)) p = parent[p];
    const w = world[n];
    return { name: String(nodes[n]?.name ?? `node${n}`), parent: p >= 0 ? idx.get(p)! : -1, pos: [w[12], w[13], w[14]] as [number, number, number], weighted: weightsKnown ? weightedNodes.has(n) : undefined };
  });
  const vrmBones = [...vrmBoneNodes.values()];
  let boneMap: BoneMapResult | null = null;
  if (container !== 'glb' && vrmBoneNodes.size) {
    const map: Partial<Record<HumanBone, number>> = {};
    for (const [node, b] of vrmBoneNodes) if (idx.has(node)) map[b as HumanBone] = idx.get(node)!;
    const has = (k: string) => map[k as HumanBone] !== undefined;
    boneMap = { map, scheme: 'vrm', missing: ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'].filter((k) => !has(k)) as HumanBone[],
      humanoid: has('hips') && has('spine') && has('head'), arms: ['leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'].every(has),
      legs: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'].every(has), fingers: [...vrmBoneNodes.values()].filter((b) => /Thumb|Index|Middle|Ring|Little/.test(b)).length, rejected: [] };
  } else if (bones.length) boneMap = mapBones(bones);

  // ---- face
  const morphs: string[] = [];
  let unnamedTargets = 0;
  for (const m of meshes) {
    const names: unknown = m?.extras?.targetNames ?? m?.primitives?.[0]?.extras?.targetNames;
    const nT = Array.isArray(m?.primitives?.[0]?.targets) ? m.primitives[0].targets.length : 0;
    if (Array.isArray(names)) for (const n of names) morphs.push(String(n));
    else for (let i = 0; i < nT; i++) { morphs.push(`morph_${i}`); unnamedTargets++; }
  }
  const vrmExpressions: string[] = [];
  if (container === 'vrm0') for (const g of ext.VRM?.blendShapeMaster?.blendShapeGroups ?? []) { const n = g?.presetName && g.presetName !== 'unknown' ? g.presetName : g?.name; if (n) vrmExpressions.push(String(n)); }
  if (container === 'vrm1') { const ex = ext.VRMC_vrm?.expressions ?? {}; vrmExpressions.push(...Object.keys(ex.preset ?? {}), ...Object.keys(ex.custom ?? {})); }
  const face = analyzeMorphs(morphs, { vrm: container !== 'glb', vrmExpressions });
  if (unnamedTargets && !face.unnamed) face.unnamed = unnamedTargets;
  const springs = container === 'vrm0' ? (ext.VRM?.secondaryAnimation?.boneGroups ?? []).reduce((n: number, g: Json) => n + (g?.bones?.length ?? 0), 0)
    : container === 'vrm1' ? (json.extensions?.VRMC_springBone?.springs ?? []).reduce((n: number, sp: Json) => n + (sp?.joints?.length ?? 0), 0)
      : bones.filter((b) => /hair|skirt|tail|ear|ribbon|bust|breast|cape|coat|sleeve|髪|スカート|尻尾/i.test(b.name)).length;

  // ---- bounds (bind pose: skinned meshes through their first joint's world × inverse bind matrix)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const ibmCache = new Map<number, Float32Array | null>();
  nodes.forEach((n, i) => {
    if (typeof n?.mesh !== 'number' || !meshes[n.mesh]) return;
    let M: Mat4 = world[i];
    if (typeof n.skin === 'number' && skins[n.skin]?.joints?.length) {
      const sk = skins[n.skin], j0 = sk.joints[0];
      let ibm = ibmCache.get(n.skin);
      if (ibm === undefined) { ibm = typeof sk.inverseBindMatrices === 'number' ? readAccessor(doc, sk.inverseBindMatrices, 1)?.data ?? null : null; ibmCache.set(n.skin, ibm); }
      M = ibm ? mul(world[j0], Float64Array.from(ibm.subarray(0, 16))) : world[j0];
    }
    for (const p of meshes[n.mesh].primitives ?? []) {
      const a = json.accessors?.[p?.attributes?.POSITION];
      if (!a || !Array.isArray(a.min) || !Array.isArray(a.max)) continue;
      for (let c = 0; c < 8; c++) {
        const corner = [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]];
        const w = apply(M, corner);
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
      }
    }
  });
  const min = (lo.every(Number.isFinite) ? lo : [0, 0, 0]) as [number, number, number];
  const max = (hi.every(Number.isFinite) ? hi : [0, 0, 0]) as [number, number, number];
  const ext3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

  // ---- up axis: hips → head (bones), else the shape; VRM is always +Y by spec
  const at = (k: HumanBone) => { const i = boneMap?.map[k]; return i !== undefined ? bones[i]?.pos ?? null : null; };
  let up: Axis = '+Y', upFrom: GltfFacts['upFrom'] = 'shape';
  if (container !== 'glb') upFrom = 'spec';
  else {
    const hipsP = at('hips'), headP = at('head') ?? at('neck');
    const footL = at('leftFoot'), footR = at('rightFoot');
    const low = hipsP ?? (footL && footR ? footL.map((v, k) => (v + footR[k]) / 2) : null);
    if (low && headP && Math.hypot(headP[0] - low[0], headP[1] - low[1], headP[2] - low[2]) > 1e-6) { up = axisOf([headP[0] - low[0], headP[1] - low[1], headP[2] - low[2]]); upFrom = 'bones'; }
    else if (ext3[2] > 2.5 * ext3[1] && ext3[2] >= 0.8 * ext3[0] && ext3[2] > 0) up = '+Z'; // tall along Z, thin along Y: lying down
  }
  const upI = up[1] === 'X' ? 0 : up[1] === 'Y' ? 1 : 2;
  const height = ext3[upI];

  // ---- facing + pose (in the upright space)
  let facesCamera: boolean | null = null, armAngle: number | null = null;
  const U = (p: readonly number[] | null) => (p ? uprightPoint(p, up) : null);
  const pairs: [HumanBone, HumanBone][] = [['leftUpperArm', 'rightUpperArm'], ['leftUpperLeg', 'rightUpperLeg'], ['leftShoulder', 'rightShoulder'], ['leftEye', 'rightEye'], ['leftHand', 'rightHand']];
  for (const [l, r] of pairs) {
    const L = U(at(l)), R = U(at(r));
    // (VRM 0.x is stored facing −Z by its spec; the studio turns it around itself)
    if (L && R && Math.abs(L[0] - R[0]) > 1e-6) { facesCamera = (L[0] > R[0]) !== (container === 'vrm0'); break; }
  }
  for (const side of ['left', 'right'] as const) {
    const a = U(at(`${side}UpperArm`)), b = U(at(`${side}LowerArm`) ?? at(`${side}Hand`));
    if (!a || !b) continue;
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ang = (Math.atan2(-d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
    armAngle = armAngle === null ? ang : (armAngle + ang) / 2;
  }

  // ---- textures
  const images: ImageFact[] = [];
  let textureMemory = 0;
  arr('images').forEach((im, i) => {
    const b = imageBytes(doc, i);
    const sz = b ? imageSize(b) : null;
    const mime = b ? (sz ? (im.mimeType ?? null) : null) : null;
    const f: ImageFact = { index: i, name: String(im.name ?? im.uri ?? `image ${i}`), mime: mime ?? im.mimeType ?? null, w: sz?.w ?? 0, h: sz?.h ?? 0, alpha: !!sz?.alpha, bytes: b?.byteLength ?? 0 };
    images.push(f);
    textureMemory += f.w * f.h * 4 * 1.34;
  });

  // ---- materials that render badly
  const materialIssues: MaterialIssue[] = [];
  const blendUse = new Map<number, number>();
  for (const m of meshes) for (const p of m?.primitives ?? []) if (typeof p?.material === 'number') {
    const ac = json.accessors?.[p.indices ?? p.attributes?.POSITION];
    blendUse.set(p.material, (blendUse.get(p.material) ?? 0) + (Number(ac?.count) || 0) / 3);
  }
  materials.forEach((m, i) => {
    const name = String(m?.name ?? `material ${i}`);
    const e = m?.extensions ?? {};
    if (e.KHR_materials_pbrSpecularGlossiness) materialIssues.push({ material: name, level: 'warn', what: 'uses the old “specular-glossiness” type, which shows grey or white', fix: 'specgloss' });
    if (e.KHR_materials_transmission || e.KHR_materials_volume) materialIssues.push({ material: name, level: 'info', what: 'is glass-like (transmission): it costs an extra render pass and looks flat in the toon look' });
    if (m?.alphaMode === 'BLEND' && (blendUse.get(i) ?? 0) > 8000) materialIssues.push({ material: name, level: 'info', what: 'is see-through (alpha blend) on a big part: overlapping see-through parts can draw in the wrong order' });
  });
  if (materials.length > 40) materialIssues.push({ material: `${materials.length} materials`, level: 'info', what: 'many materials = many draw calls; about 25 or fewer keeps rooms and parties smooth' });

  return {
    container, generator: String(json.asset?.generator ?? ''), blockers, stats, skinned: skins.length > 0, bones, boneMap, vrmBones, morphs, vrmExpressions, face, springs,
    animations: arr('animations').map((a, i) => String(a?.name ?? `animation ${i}`)),
    min, max, up, upFrom, height, facesCamera, armAngle, images, textureMemory, materialIssues, missingImages: opts.missingImages ?? [],
  };
}

/** Converts KHR_materials_pbrSpecularGlossiness materials to metal/rough (diffuse → base colour, glossiness → 1 −
 *  roughness, metallic 0). Returns the number converted. Mutates json. */
export function convertSpecGloss(json: Json): number {
  let n = 0;
  for (const m of Array.isArray(json.materials) ? json.materials : []) {
    const sg = m?.extensions?.KHR_materials_pbrSpecularGlossiness;
    if (!sg) continue;
    const pbr: Json = (m.pbrMetallicRoughness ??= {});
    if (Array.isArray(sg.diffuseFactor)) pbr.baseColorFactor = sg.diffuseFactor;
    if (sg.diffuseTexture) pbr.baseColorTexture = sg.diffuseTexture;
    pbr.metallicFactor = 0;
    pbr.roughnessFactor = Math.max(0, Math.min(1, 1 - (typeof sg.glossinessFactor === 'number' ? sg.glossinessFactor : 1) * 0.6));
    delete m.extensions.KHR_materials_pbrSpecularGlossiness;
    if (!Object.keys(m.extensions).length) delete m.extensions;
    n++;
  }
  if (n) for (const k of ['extensionsUsed', 'extensionsRequired']) {
    if (Array.isArray(json[k])) { json[k] = json[k].filter((e: string) => e !== 'KHR_materials_pbrSpecularGlossiness'); if (!json[k].length) delete json[k]; }
  }
  return n;
}
