// "Just drop a model": the words. Turns the facts (analyze.ts, fbx.ts) into the report the import dialog shows before
// anything is saved: one line per topic, green / yellow / red / grey, one plain sentence each, with an optional "more"
// list (which bones and face shapes were matched). Style: docs/ARTIST_AVATARS.md, plain words, no jargon without a
// reason. Pure; tests: tools/model_import_unit.ts.
import type { GltfFacts } from './analyze.ts';
import type { FbxFacts } from './fbx.ts';
import { KIND_LABEL, type ModelKind } from './files.ts';
import { SCHEME_LABEL } from './bones.ts';
import { FACE_SCHEME_LABEL } from './morphs.ts';
import { TRIS_MAX, fmtTris } from '../modelStats.ts';

export type LineLevel = 'ok' | 'warn' | 'bad' | 'info';
export interface ReportLine { id: 'file' | 'skeleton' | 'face' | 'size' | 'pose' | 'textures' | 'detail' | 'materials' | 'animations' | 'springs'; label: string; level: LineLevel; detail: string; more?: string[] }
export interface FixLine {
  id: string; label: string; detail: string; on: boolean; toggle: 'upright' | 'units' | 'facing' | 'bones' | 'face' | 'materials' | null;
  /** The one plain sentence shown on the main screen (no jargon). Filled in by plainSay. */
  say?: string;
}
/** A plain note for the main screen: what's limited, in everyday words, with at most one next step. */
export interface PlainNote { level: 'warn' | 'bad' | 'info'; text: string; step?: 'folder' | 'rig' | 'blender' | 'helper' | 'size' | 'guide' }

const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
const mb = (b: number) => (b >= 1 << 20 ? `${Math.round(b / 1048576)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtM = (m: number) => (m >= 1 ? `${m.toFixed(2)} m` : `${Math.round(m * 100)} cm`);

export interface ReportIn {
  facts: GltfFacts; fbx: FbxFacts | null; kind: ModelKind; convertedFrom: ModelKind | null; path: string; fromZip: string | null; models: number;
  /** The size fix applied (1 = none). */
  scale: number; upright: boolean; lookupRelinked: number; notes: string | null;
}

export function buildReport(r: ReportIn): ReportLine[] {
  const f = r.facts, out: ReportLine[] = [];
  // ---- file
  const kindWord = f.container === 'vrm1' ? 'VRM 1.0' : f.container === 'vrm0' ? 'VRM 0.x' : r.convertedFrom ? KIND_LABEL[r.convertedFrom] : KIND_LABEL[r.kind];
  const how = f.container !== 'glb' ? 'opens as it is' : r.convertedFrom === 'pmx' ? 'converted to glTF right here' : r.convertedFrom ? 'converted to .glb by Blender in VTube Pro' : r.kind === 'gltf' ? 'packed into one .glb' : 'opens as it is';
  const from = f.generator ? ` Made with ${f.generator.replace(/\s*\(.*$/, '').slice(0, 40)}.` : r.fbx?.creator ? ` Made with ${r.fbx.creator.slice(0, 40)}.` : '';
  const where = r.fromZip ? ` From the zip: ${r.path.split('/').slice(1).join('/') || r.path}.` : '';
  out.push({ id: 'file', label: 'File', level: 'ok', detail: `${kindWord}: ${how}.${from}${where}${r.models > 1 ? ` (${r.models} models were in the drop: the best one is used; you can pick another.)` : ''}`,
    more: r.fbx ? [`FBX ${r.fbx.binary ? 'binary' : 'text'} ${r.fbx.version ? (r.fbx.version / 1000).toFixed(1) : ''}`.trim(), r.fbx.unitScale ? `units: ${r.fbx.unitScale === 1 ? 'centimetres' : r.fbx.unitScale === 100 ? 'metres' : `${r.fbx.unitScale} cm per unit`}` : '', r.fbx.upAxis !== null ? `up axis: ${'XYZ'[r.fbx.upAxis] ?? '?'}` : ''].filter(Boolean) : undefined });

  // ---- skeleton
  const bm = f.boneMap;
  if (!f.bones.length || !bm) {
    out.push({ id: 'skeleton', label: 'Skeleton', level: 'bad', detail: 'No skeleton: the model would move as one piece (it still leans and nods). VTube Pro can add one with Blender after it’s saved.' });
  } else {
    const names = Object.entries(bm.map).map(([vrm, i]) => `${vrm} ← ${f.bones[i as number]?.name}`);
    const scheme = f.container !== 'glb' ? 'VRM humanoid' : SCHEME_LABEL[bm.scheme];
    const parts = ['head', 'body', bm.arms ? 'arms' : '', bm.legs ? 'legs' : '', bm.fingers ? `${bm.fingers} finger bones` : ''].filter(Boolean);
    if (!bm.humanoid) out.push({ id: 'skeleton', label: 'Skeleton', level: 'warn', detail: `${plural(f.bones.length, 'bone')}, but no human body shape was recognised (${bm.missing.slice(0, 4).join(', ')} not found). It still leans and nods; VTube Pro can add a new skeleton with Blender.`, more: names });
    else if (!bm.arms || !bm.legs) out.push({ id: 'skeleton', label: 'Skeleton', level: 'warn', detail: `${scheme}: ${parts.join(', ')} found; no ${!bm.arms ? 'arms' : 'legs'} (${bm.missing.filter((m) => /Arm|Hand|Leg|Foot/.test(m)).slice(0, 3).join(', ')}). ${!bm.arms ? 'Arms won’t follow you.' : 'Fine for a head-and-shoulders stream.'}`, more: names });
    else out.push({ id: 'skeleton', label: 'Skeleton', level: 'ok', detail: `${scheme}: ${plural(Object.keys(bm.map).length, 'bone')} matched (${parts.join(', ')}).`, more: names });
  }

  // ---- face
  const fc = f.face;
  const faceMore = Object.entries(fc.faceMap).map(([k, v]) => `${k} → ${v}`);
  if (fc.unknown.length) faceMore.push(`not matched: ${fc.unknown.slice(0, 20).join(', ')}${fc.unknown.length > 20 ? ' …' : ''}`);
  const what = [fc.arkit.length ? `${fc.arkit.length} ARKit shapes` : '', fc.vowels.length ? `mouth vowels (${fc.vowels.join(' ')})` : '', fc.blink ? (fc.wink ? 'blink + wink' : 'blink') : '', fc.emotions.length ? `${fc.emotions.length} emotions` : ''].filter(Boolean);
  if (fc.scheme === 'none') {
    out.push({ id: 'face', label: 'Face shapes', level: fc.unnamed ? 'warn' : 'bad', detail: fc.unnamed ? `${plural(fc.unnamed, 'face shape')} without names (exported as numbers): they can’t be matched. VTube Pro adds a drawn mouth and eyes that follow yours. Re-export with shape names to use them.` : 'No face shapes (no blink or mouth shapes). VTube Pro adds a drawn mouth and eyes that follow yours.' });
  } else if (fc.arkit.length >= 40) {
    out.push({ id: 'face', label: 'Face shapes', level: 'ok', detail: `${FACE_SCHEME_LABEL[fc.scheme]}: ${what.join(', ')}. Full expressions and lip sync.`, more: faceMore.length ? faceMore : undefined });
  } else {
    const good = (fc.vowels.length >= 3 || fc.arkit.includes('jawOpen')) && fc.blink;
    out.push({ id: 'face', label: 'Face shapes', level: good ? 'ok' : 'warn', detail: `${FACE_SCHEME_LABEL[fc.scheme]}: ${what.join(', ') || 'a few shapes'}.${good ? '' : ` Missing: ${[!(fc.vowels.length >= 3 || fc.arkit.includes('jawOpen')) ? 'mouth shapes' : '', !fc.blink ? 'blink' : ''].filter(Boolean).join(' and ')}; VTube Pro fills ${!fc.blink && !(fc.vowels.length >= 3 || fc.arkit.includes('jawOpen')) ? 'them' : 'it'} in with its drawn face.`}`, more: faceMore.length ? faceMore : undefined });
  }

  // ---- size + axes
  const H = f.height * r.scale;
  const notes: string[] = [];
  if (f.container === 'glb' && f.up !== '+Y') notes.push(r.upright ? 'stood upright' : `saved with ${f.up} up (not fixed)`);
  if (r.scale !== 1) notes.push(`scaled from ${r.scale === 0.01 ? 'centimetres' : r.scale === 0.001 ? 'millimetres' : '1/100 size'}`);
  if (f.facesCamera === false) notes.push('turned to face the camera');
  if (!(H > 0)) out.push({ id: 'size', label: 'Size', level: 'warn', detail: 'Couldn’t measure the model.' });
  else if (H > 4 || H < 0.05) out.push({ id: 'size', label: 'Size', level: 'warn', detail: `${fmtM(H)} tall${notes.length ? ` (${notes.join(', ')})` : ''}. ${H > 4 ? 'A giant, or exported 10× too big?' : 'Very small: exported at the wrong scale?'} If the character really is that size, set its real size later (Me → Real size).` });
  else out.push({ id: 'size', label: 'Size', level: 'ok', detail: `${fmtM(H)} tall${notes.length ? ` (${notes.join(', ')})` : ''}.` });

  // ---- pose
  if (f.armAngle !== null) {
    const a = Math.round(f.armAngle);
    out.push({ id: 'pose', label: 'Rest pose', level: a > 70 ? 'info' : 'ok', detail: a < 15 && a > -20 ? 'T-pose.' : a <= -20 ? `Arms raised (${-a}°): works; each bone moves from its own rest direction.` : a <= 60 ? `A-pose (arms ${a}° down): works as it is.` : `Arms hanging down (${a}°): works; very wide arm moves can bend the shoulders a little.` });
  }

  // ---- textures
  const imgs = f.images;
  const missing = [...new Set([...f.missingImages])];
  const huge = imgs.filter((i) => Math.max(i.w, i.h) > 4096);
  const big = imgs.filter((i) => Math.max(i.w, i.h) > 2048 && Math.max(i.w, i.h) <= 4096);
  const memMB = Math.round(f.textureMemory / 1048576);
  if (!imgs.length && !missing.length) out.push({ id: 'textures', label: 'Textures', level: 'info', detail: 'No textures: plain colours only.' });
  else if (missing.length) out.push({ id: 'textures', label: 'Textures', level: 'warn', detail: `${plural(missing.length, 'texture')} not found (${missing.slice(0, 3).map((m) => m.split('/').pop()).join(', ')}${missing.length > 3 ? ' …' : ''}): those parts show plain colour. Drop the model’s whole folder or a .zip with its textures.`, more: missing });
  else if (huge.length) out.push({ id: 'textures', label: 'Textures', level: 'warn', detail: `${plural(imgs.length, 'texture')}; ${huge.length} ${huge.length === 1 ? 'is' : 'are'} bigger than 4K (${huge.slice(0, 2).map((i) => `${i.w}×${i.h}`).join(', ')}): about ${memMB} MB of graphics memory. 2K is plenty for streaming; Low / Medium graphics may stutter.`, more: imgs.map((i) => `${i.name}: ${i.w}×${i.h}, ${mb(i.bytes)}`) });
  else out.push({ id: 'textures', label: 'Textures', level: 'ok', detail: `${plural(imgs.length, 'texture')}, all found${r.lookupRelinked ? ` (${r.lookupRelinked} relinked)` : ''}; about ${Math.max(1, memMB)} MB of graphics memory${big.length ? ` (${big.length} at 4K)` : ''}.`, more: imgs.map((i) => `${i.name}: ${i.w}×${i.h}, ${mb(i.bytes)}`) });

  // ---- detail (polycount vs graphics tiers / parties)
  const t = f.stats.tris;
  const tierLine = t <= 37_000 ? 'light enough for any party and every graphics level.'
    : t <= 80_000 ? 'fine everywhere (a good size for streaming).'
      : t <= TRIS_MAX ? 'fine solo and in parties; Low graphics on older PCs may stutter.'
        : t <= 500_000 ? 'heavy: fine solo on a good graphics card; parties get an automatic lighter copy. A lighter version (Blender: Decimate to about half) runs better everywhere.'
          : 'very heavy: expect slow frames on most PCs. Please make a lighter version (Blender: Decimate modifier, ratio about 0.3) before streaming with it.';
  out.push({ id: 'detail', label: 'Detail', level: t > 500_000 ? 'warn' : t > TRIS_MAX ? 'warn' : 'ok', detail: `${fmtTris(t)} triangles, ${plural(f.stats.materials, 'material')}: ${tierLine}` });

  // ---- materials
  if (f.materialIssues.length) {
    const w = f.materialIssues.filter((m) => m.level === 'warn');
    out.push({ id: 'materials', label: 'Materials', level: w.length ? 'warn' : 'info', detail: `${f.materialIssues.slice(0, 2).map((m) => `${m.material} ${m.what}`).join('; ')}${f.materialIssues.length > 2 ? ` (+${f.materialIssues.length - 2} more)` : ''}.`, more: f.materialIssues.map((m) => `${m.material}: ${m.what}`) });
  }
  // ---- springs + animations (good to know)
  if (f.springs) out.push({ id: 'springs', label: 'Hair and clothes', level: 'info', detail: `${plural(f.springs, 'bone')} for hair, clothes or tails: they swing when you move.` });
  if (f.animations.length) out.push({ id: 'animations', label: 'Animations', level: 'info', detail: `${plural(f.animations.length, 'animation')} inside (${f.animations.slice(0, 3).join(', ')}${f.animations.length > 3 ? ' …' : ''}). They aren’t played: your camera moves the model.` });
  return out;
}

// ---------------------------------------------------------------- the zero-effort words (main screen)
// Owner rule: auto-fix everything, say what was done in one plain sentence each, no bone names / format jargon unless
// "Details" is opened, and when something can't be fixed give exactly one next step.

/** One plain sentence per fix. */
export function plainSay(x: FixLine, f: GltfFacts | null, heightM: number | null): string {
  switch (x.id) {
    case 'upright': return 'It was lying down, so we stood it up.';
    case 'units': return `It was saved at the wrong size, so we scaled it to a real height${heightM ? ` (${fmtM(heightM)})` : ''}.`;
    case 'facing': return 'It was facing away, so we turned it around.';
    case 'bones': return `We matched its skeleton, so your head, arms${f?.boneMap?.legs ? ', legs' : ''}${f?.boneMap?.fingers ? ' and fingers' : ''} move it.`;
    case 'face': return 'We matched its face shapes, so it blinks, talks and smiles.';
    case 'textures': return 'We found its textures, even the ones in other folders.';
    case 'pack': return 'We packed its files into one model.';
    case 'pmx': return 'We converted it from MMD so it works here.';
    case 'convert': return 'We converted it with Blender so it works here.';
    case 'materials': return 'We fixed colours that would have shown up grey.';
    default: return x.label;
  }
}

/** What's limited, in everyday words (main screen). Never more than three, worst first. */
export function plainNotes(r: { facts: GltfFacts | null; report: ReportLine[]; needsRig: boolean; needsFace: boolean; fileBytes: number; helper: boolean; blender: boolean | null }): PlainNote[] {
  const out: PlainNote[] = [];
  const line = (id: ReportLine['id']) => r.report.find((l) => l.id === id);
  if (r.needsRig) {
    const has = !!r.facts?.bones.length;
    const what = has ? 'Its skeleton can’t move arms' : 'It has no skeleton yet';
    if (r.helper && r.blender !== false) out.push({ level: 'info', text: `${what}, so right after saving Blender adds one on your computer (about a minute). Until then it leans and nods with you.`, step: 'rig' });
    else if (!r.helper) out.push({ level: 'warn', text: `${what}, so it will lean and nod but its arms won’t move. VTube Pro can add a skeleton.`, step: 'helper' });
    else out.push({ level: 'warn', text: `${what}, so it will lean and nod but its arms won’t move. Blender (free) can add a skeleton.`, step: 'blender' });
  }
  if (line('textures')?.level === 'warn' && r.facts?.missingImages.length) out.push({ level: 'warn', text: 'Some of its pictures (textures) are missing, so a few parts will be plain colour. Drop the model’s whole folder or .zip to bring them along.', step: 'folder' });
  else if (line('textures')?.level === 'warn') out.push({ level: 'info', text: 'Its pictures are very large, so it uses a lot of graphics memory.' });
  const t = r.facts?.stats.tris ?? 0;
  if (t > 500_000) out.push({ level: 'warn', text: 'It is extremely detailed, so it may run slowly on most PCs.', step: 'guide' });
  else if (t > TRIS_MAX) out.push({ level: 'info', text: 'It is very detailed. Friends in a party see a lighter copy automatically.' });
  if (line('size')?.level === 'warn') out.push({ level: 'info', text: 'It is an unusual size. If that’s not right, set its real height later (Me → Real size).' });
  if (r.fileBytes > 300 * 1048576) out.push({ level: 'info', text: 'It is a big file: the browser-only version can’t keep it, VTube Pro can.' });
  if (line('face')?.level === 'warn' && !r.needsFace) out.push({ level: 'info', text: 'Some face movements are missing; VTube Pro fills them in with its own drawn face.' });
  const rank = { bad: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 3);
}

/** An anonymised problem report for support: no file names, no author notes, no paths, only what kind of model it is
 *  and what the checks found. Safe to paste into a public bug page. */
export function supportReport(r: { status: string; title?: string; fix?: string; kind: string | null; facts: GltfFacts | null; fbx: FbxFacts | null; models: number; appVersion?: string }): string {
  const f = r.facts;
  const lines = [
    `VTube Pro import problem${r.appVersion ? ` (version ${r.appVersion})` : ''}`,
    `result: ${r.status}${r.title ? ` | ${r.title}` : ''}`,
    r.fix ? `message: ${r.fix}` : '',
    `format: ${r.kind ?? '?'}${f ? ` / ${f.container}` : ''}${r.models > 1 ? ` (${r.models} models in the drop)` : ''}`,
    f ? `made with: ${(f.generator || '?').replace(/[^\w .()/-]/g, '').slice(0, 40)}` : '',
    f ? `meshes ${f.stats.meshes}, triangles ${f.stats.tris}, materials ${f.stats.materials}, textures ${f.images.length} (missing ${f.missingImages.length})` : '',
    f ? `skeleton: ${f.bones.length} bones, scheme ${f.boneMap?.scheme ?? 'none'}, humanoid ${!!f.boneMap?.humanoid}, arms ${!!f.boneMap?.arms}, legs ${!!f.boneMap?.legs}, missing ${(f.boneMap?.missing ?? []).join(' ')}` : '',
    f ? `face: ${f.face.scheme}, ${f.face.arkit.length} ARKit, vowels ${f.face.vowels.length}, blink ${f.face.blink}, unmatched ${f.face.unknown.length}, unnamed ${f.face.unnamed}` : '',
    f ? `size: height ${f.height.toFixed(3)} units, up ${f.up} (${f.upFrom}), faces camera ${f.facesCamera}, arm angle ${f.armAngle === null ? '-' : Math.round(f.armAngle)}` : '',
    f?.blockers.length ? `blockers: ${f.blockers.length}` : '',
    r.fbx ? `fbx: ${r.fbx.binary ? 'binary' : 'text'} ${r.fbx.version}, unit ${r.fbx.unitScale}, up ${r.fbx.upAxis}, meshes ${r.fbx.meshes.length}, bones ${r.fbx.bones.length}, shapes ${r.fbx.shapes.length}, animations ${r.fbx.animations}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}
