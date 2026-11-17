// 3D avatars (.vrm / .glb / .gltf, and anything the drop importer reads): the studio's own import report
// (shared/modelImport/prepare.ts → report.ts), then the agent bar on top of it: an agent-made model should need none of
// the importer's automatic fixes, should have a full face (ARKit 52 or the VRM preset set), shape keys resting at 0,
// bone names that survive three.js' name cleaning, and party-friendly weight.
import { prepareImport, type Prepared } from '../modelImport/prepare.ts';
import type { DroppedFile } from '../modelImport/files.ts';
import { ARKIT } from '../../src/core/arkit.ts';
import { DOC, finish, type CheckFile, type CheckItem, type CheckResult } from './types.ts';

/** VRM expression presets a complete VRM face has (VRM 1.0 names; VRM 0.x a / i / u / e / o map onto the vowels). */
const VRM_FACE = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
/** ARKit shapes that carry most of a VTuber's face: missing ones are named in the fix. */
const ARKIT_CORE = ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthRollLower', 'mouthRollUpper', 'mouthStretchLeft', 'mouthStretchRight',
  'browInnerUp', 'browDownLeft', 'browDownRight', 'eyeWideLeft', 'eyeWideRight', 'eyeSquintLeft', 'eyeSquintRight', 'cheekPuff'];
/** Party-friendly (every party shows the real model) and "fine everywhere" lines from shared/modelImport/report.ts. */
export const AVATAR_BUDGET = { partyTris: 37_000, goodTris: 80_000, maxTris: 200_000, materials: 25, texSide: 2048, faceTexSide: 2048 };

type Json = Record<string, any>;

const lvl = (l: string): CheckItem['level'] => (l === 'bad' ? 'error' : l === 'warn' ? 'warn' : l === 'info' ? 'info' : 'ok');

export async function checkAvatar3d(files: CheckFile[], name: string): Promise<CheckResult> {
  const input: DroppedFile[] = files.map((f) => ({ path: f.path, bytes: f.bytes }));
  const p: Prepared = await prepareImport(input, { helper: false, blender: null });
  const items: CheckItem[] = [];
  if (p.status === 'route2d') {
    items.push({ id: 'file', level: 'error', what: `${p.title}: this is a 2D model, not a 3D one.`, fix: 'Run the check with --kind pro2d-psd / pngtuber / live2d, or import it through Avatars → Add a 2D avatar.', doc: DOC.live2d });
    return finish('avatar3d', name, items, {}, '3D avatar');
  }
  if (p.status === 'needs-helper' || p.status === 'needs-blender') {
    items.push({ id: 'file', level: 'warn', what: `${p.title}. This check reads .vrm, .glb and .gltf directly; ${p.kind?.toUpperCase()} is converted by Blender inside VTube Pro.`,
      fix: 'Export a binary glTF (.glb) yourself (Blender: File → Export → glTF 2.0, Format "glTF Binary", +Y Up, Apply Modifiers off if you have shape keys) and check that file. It is what VTube Pro loads in the end.', doc: DOC.avatar3d });
    return finish('avatar3d', name, items, { kind: p.kind }, '3D avatar');
  }
  if (p.status === 'refuse' || !p.facts) {
    items.push({ id: 'file', level: 'error', what: `${p.title ?? 'This model can’t be opened'}.`, fix: p.fix, doc: DOC.avatar3d });
    return finish('avatar3d', name, items, {}, '3D avatar');
  }
  const f = p.facts;
  const isVrm = f.container !== 'glb';
  // 1. the studio's own report, line for line (what the performer will see)
  for (const r of p.report) {
    if (r.id === 'file') { items.push({ id: 'file', level: 'ok', what: r.detail }); continue; }
    items.push({ id: r.id, level: lvl(r.level), what: r.detail, ...(r.level === 'bad' || r.level === 'warn' ? { fix: fixFor(r.id, p), doc: DOC.avatar3d } : {}) });
  }
  // 2. automatic fixes the importer had to make: fine for a performer's download, a defect in an agent's own export
  for (const x of p.fixes) {
    if (x.id === 'upright') items.push({ id: 'export.up', level: 'warn', what: `Saved with ${f.up} up: the importer has to stand it upright.`, fix: 'Export with "+Y Up" ticked (Blender glTF exporter default) and apply rotation (Ctrl+A → Rotation & Scale) on the armature and meshes first.', doc: DOC.avatarFailures });
    else if (x.id === 'units') items.push({ id: 'export.units', level: 'warn', what: `Wrong units: ${x.detail}`, fix: 'Model in metres (Blender: Scene → Units → Metric, Unit Scale 1.0), a human about 1.6-1.8 m tall, apply scale (Ctrl+A) and export again.', doc: DOC.avatarFailures });
    else if (x.id === 'facing') items.push({ id: 'export.facing', level: 'warn', what: 'The model faces away from the camera (-Z in glTF).', fix: 'Face +Z in glTF = -Y in Blender (the "Front" view looks at its face). Rotate 180° about the up axis, apply rotation, export again.', doc: DOC.avatarFailures });
    else if (x.id === 'materials') items.push({ id: 'export.materials', level: 'warn', what: x.detail, fix: 'Use Principled BSDF (metal-rough) materials; the old specular-glossiness extension shows grey in many viewers.' });
    else if (x.id === 'bones' && f.boneMap && f.boneMap.scheme !== 'vrm') items.push({ id: 'skeleton.names', level: 'info', what: `Bones matched by name rules (${x.detail})`, fix: 'Fine as it is. For a 100 % match everywhere, name the bones exactly like VRM: hips, spine, chest, upperChest, neck, head, leftUpperArm, leftLowerArm, leftHand, leftUpperLeg, leftLowerLeg, leftFoot … (right side the same).' });
  }
  // 3. the agent bar
  const json = (await jsonOf(files, p)) ?? {};
  const facts: Record<string, unknown> = {
    container: f.container, generator: f.generator, triangles: f.stats.tris, materials: f.stats.materials, textures: f.images.length,
    heightM: round(f.height * (p.fixes.some((x) => x.id === 'units' && x.on) ? unitOf(p) : 1)), up: f.up, facesCamera: f.facesCamera, armAngle: f.armAngle === null ? null : Math.round(f.armAngle),
    bones: f.bones.length, humanoid: f.boneMap?.humanoid ?? false, boneScheme: f.boneMap?.scheme ?? null, missingBones: f.boneMap?.missing ?? [],
    arkit: f.face.arkit.length, vowels: f.face.vowels, blink: f.face.blink, vrmExpressions: f.vrmExpressions, springBones: f.springs,
    textureMemoryMB: Math.round(f.textureMemory / 1048576), needsRig: p.needsRig, needsFace: p.needsFace,
  };
  // face completeness
  if (isVrm) {
    const have = new Set(f.vrmExpressions.map((e) => e.toLowerCase()));
    const vrm0 = f.container === 'vrm0';
    const want = vrm0 ? ['a', 'i', 'u', 'e', 'o', 'blink', 'blink_l', 'blink_r', 'joy', 'angry', 'sorrow', 'fun'] : VRM_FACE.map((e) => e.toLowerCase());
    const miss = want.filter((e) => !have.has(e));
    if (miss.length && f.face.arkit.length < 40) items.push({ id: 'face.vrm', level: miss.some((m) => /^(aa|ih|ou|ee|oh|a|i|u|e|o|blink)$/.test(m)) ? 'warn' : 'info', what: `VRM expressions missing: ${miss.join(', ')}.`, fix: `Bind every preset to shape keys (VRM Add-on for Blender: VRM → Expressions). Lip sync needs ${vrm0 ? 'A I U E O' : 'aa ih ou ee oh'}, blinking needs blink + blinkLeft/Right. Best of all, add the 52 ARKit shape keys too (perfect sync).`, doc: DOC.avatar3d });
  } else if (f.face.scheme !== 'none' && f.face.arkit.length < 52) {
    const have = new Set(f.face.arkit);
    const missCore = ARKIT_CORE.filter((k) => !have.has(k));
    const missAll = ARKIT.filter((k) => !have.has(k));
    if (f.face.arkit.length >= 10 && missAll.length) items.push({ id: 'face.arkit', level: missCore.length ? 'warn' : 'info', what: `${f.face.arkit.length} of the 52 ARKit shapes (perfect sync is on from 10).`, fix: `Add the missing shape keys with these exact names: ${(missCore.length ? missCore : missAll).join(', ')}${missCore.length && missAll.length > missCore.length ? ` (then: ${missAll.filter((k) => !missCore.includes(k)).join(', ')})` : ''}.`, doc: DOC.avatar3d });
    else if (f.face.arkit.length < 10) items.push({ id: 'face.arkit', level: 'info', what: 'No ARKit perfect-sync set: the face runs on the simpler presets.', fix: 'For full expressions add the 52 ARKit shape keys (exact names: eyeBlinkLeft, jawOpen, mouthSmileLeft …; see the spec "avatar3d.face.arkit52").', doc: DOC.avatar3d });
  }
  // shape keys must rest at 0 (a non-zero default shows until the engine first drives it, or forever if it never does)
  const restOn = morphDefaults(json);
  if (restOn.length) items.push({ id: 'face.defaults', level: 'warn', what: `${restOn.length} shape key${restOn.length === 1 ? ' is' : 's are'} saved switched on: ${restOn.slice(0, 6).join(', ')}${restOn.length > 6 ? ' …' : ''}.`, fix: 'Set every shape key Value to 0 before export (Blender: Object Data → Shape Keys, or `for k in obj.data.shape_keys.key_blocks: k.value = 0`). The glTF mesh.weights must all be 0.', doc: DOC.avatarFailures });
  // unnamed morphs
  if (f.face.unnamed) items.push({ id: 'face.unnamed', level: 'warn', what: `${f.face.unnamed} shape keys have no names in the file.`, fix: 'Tick "Shape Keys" under Data → Shape Keys in the glTF exporter (it writes mesh.extras.targetNames); never export through a format that drops names.' });
  // bone names three.js rewrites ("arm.L" → "armL")
  const dotted = boneNamesWithPunctuation(json);
  if (dotted.length && !isVrm) items.push({ id: 'skeleton.punctuation', level: f.boneMap?.humanoid && f.boneMap.arms ? 'info' : 'warn', what: `${dotted.length} bone name${dotted.length === 1 ? ' has' : 's have'} characters three.js removes (. : / [ ]): ${dotted.slice(0, 5).join(', ')}${dotted.length > 5 ? ' …' : ''}.`, fix: 'Rename to plain VRM names (leftUpperArm, not upper_arm.L / DEF-upper_arm.L). Costumes match bones by the cleaned name, so they must use the very same names.' });
  // arms + legs for full-body; eyes for gaze
  if (f.boneMap?.humanoid && f.boneMap.arms && !f.boneMap.map.leftEye && !isVrm && f.face.arkit.filter((k) => /^eyeLook/.test(k)).length < 8) items.push({ id: 'skeleton.eyes', level: 'info', what: 'No eye bones (leftEye / rightEye) and no eyeLook shapes: the eyes won’t follow your gaze.', fix: 'Add leftEye / rightEye bones at the eyeball centres (children of head), or the eight eyeLook* ARKit shapes.' });
  // weight
  const t = f.stats.tris;
  if (t > AVATAR_BUDGET.partyTris && t <= AVATAR_BUDGET.maxTris) items.push({ id: 'budget.tris', level: 'info', what: `${t.toLocaleString('en-US')} triangles: over ${AVATAR_BUDGET.partyTris.toLocaleString('en-US')}, so a party host with a strict limit gets a lighter copy.`, fix: `Aim for ≤ ${AVATAR_BUDGET.partyTris.toLocaleString('en-US')} triangles (face 1.5-4k anime) when the user wants to join parties.` });
  if (f.stats.materials > AVATAR_BUDGET.materials) items.push({ id: 'budget.materials', level: 'warn', what: `${f.stats.materials} materials (each is a draw call).`, fix: `Merge materials into texture atlases: ≤ ${AVATAR_BUDGET.materials} materials, ideally ≤ 10.` });
  const bigTex = f.images.filter((i) => Math.max(i.w, i.h) > AVATAR_BUDGET.texSide);
  if (bigTex.length && !items.some((i) => i.id === 'textures' && i.level === 'warn')) items.push({ id: 'budget.textures', level: 'info', what: `${bigTex.length} texture${bigTex.length === 1 ? '' : 's'} above 2048 px (${bigTex.slice(0, 3).map((i) => `${i.w}×${i.h}`).join(', ')}).`, fix: 'Only the face texture needs 2048²; body / outfit atlases 2048-4096, everything else ≤ 1024.' });
  const npot = f.images.filter((i) => i.w > 0 && (!pow2(i.w) || !pow2(i.h)));
  if (npot.length) items.push({ id: 'textures.pow2', level: 'info', what: `${npot.length} texture${npot.length === 1 ? ' is' : 's are'} not a power-of-two size (${npot.slice(0, 3).map((i) => `${i.w}×${i.h}`).join(', ')}).`, fix: 'Use 256 / 512 / 1024 / 2048 sides: mipmaps and GPU compression work best.' });
  // licence meta for VRM
  if (isVrm && !p.notes) items.push({ id: 'vrm.meta', level: 'info', what: 'The VRM has no author / licence meta.', fix: 'Fill VRM meta (name, authors, licence URL, avatar permission, commercial usage) so the performer knows what they may do with it.' });
  return finish('avatar3d', name, items, facts, isVrm ? `VRM avatar (${f.container === 'vrm1' ? '1.0' : '0.x'})` : '3D avatar (glTF)');
}

function fixFor(id: string, p: Prepared): string {
  const f = p.facts!;
  switch (id) {
    case 'skeleton': return f.bones.length
      ? `Name the bones exactly like VRM: hips → spine → chest → (upperChest) → neck → head, leftShoulder → leftUpperArm → leftLowerArm → leftHand, leftUpperLeg → leftLowerLeg → leftFoot → leftToes, the same for right. Missing now: ${f.boneMap?.missing.slice(0, 8).join(', ') || 'arms / legs'}.`
      : 'Add an armature (Blender: Rigify human, or start from a VRoid CC0 base), parent the mesh with automatic weights, name the bones like VRM. Or let the user run VTube Pro\'s autorig after import.';
    case 'face': return 'Add shape keys with exact ARKit names (eyeBlinkLeft, eyeBlinkRight, jawOpen, mouthClose, mouthFunnel, mouthPucker, mouthSmileLeft, mouthSmileRight …), or for a VRM bind the presets aa ih ou ee oh blink.';
    case 'size': return 'Model in metres: a human is about 1.6-1.8 m. A character that is really tiny or huge is fine: say so in profile.json "size": {"height": <metres>}.';
    case 'textures': return 'Embed every texture in the .glb (glTF Binary) and keep sides ≤ 2048 (face 2048², body atlas up to 4096).';
    case 'detail': return 'Decimate to ≤ 80k triangles (≤ 37k for parties): body and clothes first, never the face or shape-key areas.';
    case 'materials': return 'Principled BSDF only; no transmission / volume; alpha "Blend" only on hair tips and glass (use "Alpha Clip" where you can).';
    default: return 'See the guide.';
  }
}

async function jsonOf(files: CheckFile[], p: Prepared): Promise<Json | null> {
  const b = p.file?.bytes;
  if (!b || b.length < 20) return null;
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const len = dv.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + len)));
  } catch { return null; }
}

/** Names of shape keys whose default weight (mesh.weights) is not 0. */
export function morphDefaults(json: Json): string[] {
  const out: string[] = [];
  for (const m of Array.isArray(json.meshes) ? json.meshes : []) {
    const w: unknown[] = Array.isArray(m?.weights) ? m.weights : [];
    const names: unknown[] = m?.extras?.targetNames ?? m?.primitives?.[0]?.extras?.targetNames ?? [];
    w.forEach((v, i) => { if (typeof v === 'number' && Math.abs(v) > 1e-4) out.push(String(names[i] ?? `#${i}`)); });
  }
  return [...new Set(out)];
}

/** Skin joint names that three.js' PropertyBinding.sanitizeNodeName changes. */
export function boneNamesWithPunctuation(json: Json): string[] {
  const joints = new Set<number>((Array.isArray(json.skins) ? json.skins : []).flatMap((s: Json) => (Array.isArray(s?.joints) ? s.joints : [])));
  return [...joints].map((i) => String(json.nodes?.[i]?.name ?? '')).filter((n) => /[.:/[\]]/.test(n));
}

const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
const round = (n: number) => Math.round(n * 100) / 100;
const unitOf = (p: Prepared) => { const H = p.facts!.height; return H > 300 ? 0.001 : H > 30 ? 0.01 : H < 0.02 ? 100 : 1; };
