// Model import: which files the studio accepts (and which need Blender), and the friendly "rigging check" shown after
// an import (skeleton, face shapes, scale, polycount). Pure logic, no DOM / three.js — unit tests in
// tools/importcheck_test.ts. The dialog is src/ui/importDialog.ts; the formats mirror server/routes/avatars.ts
// (KEEP_AS_IS / CONVERT) and blender/common.py import_model. Docs: docs/AVATARS_SIMPLE.md, docs/AVATARS_ADVANCED.md §11.
import { TRIS_MAX, fmtTris } from './modelStats.ts';

export type ImportRoute = 'direct' | 'blender';
export interface ImportFormat { ext: string; label: string; route: ImportRoute; note?: string }

export const IMPORT_FORMATS: readonly ImportFormat[] = [
  { ext: '.vrm', label: 'VRM (VRoid Studio, VRM 0 / 1)', route: 'direct' },
  { ext: '.glb', label: 'glTF binary', route: 'direct' },
  { ext: '.gltf', label: 'glTF', route: 'direct', note: 'must be a single file (no separate .bin / textures) — export .glb otherwise' },
  { ext: '.fbx', label: 'FBX', route: 'blender' },
  { ext: '.obj', label: 'OBJ', route: 'blender', note: 'shape only: colours in a separate .mtl file are not brought along — export .glb for colours' },
  { ext: '.blend', label: 'Blender file', route: 'blender', note: 'pack textures into the .blend (File → External Data → Pack Resources)' },
  { ext: '.dae', label: 'COLLADA', route: 'blender', note: 'only if your Blender version still reads COLLADA' },
  { ext: '.stl', label: 'STL', route: 'blender', note: 'no colours or materials' },
  { ext: '.ply', label: 'PLY', route: 'blender', note: 'no materials' },
  { ext: '.usd', label: 'USD', route: 'blender' },
  { ext: '.usda', label: 'USD (text)', route: 'blender' },
  { ext: '.usdc', label: 'USD (binary)', route: 'blender' },
  { ext: '.usdz', label: 'USDZ', route: 'blender' },
  { ext: '.abc', label: 'Alembic', route: 'blender', note: 'geometry only; no skeleton' },
];
/** For <input type=file accept=…>. */
export const IMPORT_ACCEPT = IMPORT_FORMATS.map((f) => f.ext).join(',');
export const BLENDER_EXTS = IMPORT_FORMATS.filter((f) => f.route === 'blender').map((f) => f.ext);

export type Level = 'ok' | 'warn' | 'bad';

export function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return m ? `.${m[1].toLowerCase()}` : '';
}

export interface FormatCheck { ext: string; format: ImportFormat | null; level: Level; canImport: boolean; needsBlender: boolean; message: string }

/** blender: true / false = known, null = not known yet (still checking). */
export function checkFormat(filename: string, blender: boolean | null): FormatCheck {
  const ext = extOf(filename);
  const format = IMPORT_FORMATS.find((f) => f.ext === ext) ?? null;
  if (!format) {
    return { ext, format, level: 'bad', canImport: false, needsBlender: false,
      message: `${ext || 'This file type'} isn't a 3D model format VTube Pro can read. Use .vrm, .glb, .fbx, .obj or .blend (full list in the Avatars guide).` };
  }
  const needsBlender = format.route === 'blender';
  if (needsBlender && blender === false) {
    return { ext, format, level: 'bad', canImport: false, needsBlender,
      message: `${format.label} files are converted by Blender (free), which isn't installed on this PC yet.` };
  }
  const base = needsBlender ? `${format.label}: converted to GLB by Blender on this PC.` : `${format.label}: loaded as-is.`;
  return { ext, format, level: needsBlender || format.note ? 'warn' : 'ok', canImport: true, needsBlender, message: format.note ? `${base} Note: ${format.note}.` : base };
}

// ---------------------------------------------------------------- the rigging check (after the model loaded)

/** What the loaded runtime reports (src/avatar/AvatarRuntime.ts RuntimeInfo + a humanoid bone probe + raw height). */
export interface RigFacts {
  rig: 'vrm' | 'humanoid' | 'soft' | 'none';
  /** VRM humanoid bone names the model maps (for vrm / humanoid rigs; ignored for soft / none). */
  bones: readonly string[];
  /** Own ARKit shapes (incl. VRM custom expressions named like ARKit). */
  arkit: number;
  /** Named presets found (a, i, blink, joy …) and VRM expressions. */
  named: readonly string[];
  vrm: boolean;
  triangles: number;
  /** The model's height in its own units (metres if exported correctly). 0 = unknown. */
  height: number;
  /** A modelled jaw / puppet mouth driven by bones (robots, frogs, puppets). */
  jaw?: boolean;
  /** VTube Pro's drawn (procedural) mouth and/or eyes are already set up for this avatar. */
  drawnFace?: boolean;
}

export interface CheckItem { key: 'skeleton' | 'face' | 'scale' | 'polycount'; label: string; level: Level; detail: string }
export interface RigCheck { items: CheckItem[]; needsRig: boolean; needsFace: boolean; summary: string }

const GROUPS: [string, string[]][] = [
  ['arms', ['leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand']],
  ['legs', ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']],
  ['fingers', ['leftIndexProximal', 'leftMiddleProximal', 'leftLittleProximal', 'rightIndexProximal', 'rightMiddleProximal', 'rightLittleProximal']],
  ['eyes', ['leftEye', 'rightEye']],
];
const VISEMES = /^(a|aa|i|ih|u|ou|e|ee|o|oh)$/i;

export function checkRig(f: RigFacts): RigCheck {
  const items: CheckItem[] = [];
  const has = new Set(f.bones);
  // skeleton
  let needsRig = false;
  if (f.rig === 'vrm' || f.rig === 'humanoid') {
    const missing = GROUPS.filter(([, names]) => !names.some((n) => has.has(n))).map(([g]) => g);
    const partial = GROUPS.filter(([, names]) => names.some((n) => has.has(n)) && !names.every((n) => has.has(n))).map(([g]) => g);
    const core = missing.filter((g) => g === 'arms' || g === 'legs');
    const kind = f.rig === 'vrm' ? 'VRM skeleton' : 'Humanoid skeleton';
    if (core.length) {
      needsRig = missing.includes('arms');
      items.push({ key: 'skeleton', label: 'Skeleton', level: 'warn', detail: `${kind} found, but no ${core.join(' or ')} bones — ${core.join(' and ')} won't track.${needsRig ? ' Re-rigging with Blender adds them.' : ''}` });
    } else if (partial.includes('arms') || partial.includes('legs')) {
      const which = partial.filter((g) => g === 'arms' || g === 'legs');
      items.push({ key: 'skeleton', label: 'Skeleton', level: 'warn', detail: `${kind} found, but some ${which.join(' / ')} bones weren't recognised (unusual names?) — one side may not track. Re-rigging with Blender, or renaming bones to VRM names, fixes it.` });
    } else {
      const soft = [...new Set([...missing, ...partial])].filter((g) => g === 'fingers' || g === 'eyes');
      items.push({ key: 'skeleton', label: 'Skeleton', level: 'ok', detail: `${kind} found: head, body, arms and legs track.${soft.length ? ` (No ${soft.join(' / ')} bones: those use simpler motion.)` : ''}` });
    }
  } else if (f.rig === 'soft') {
    needsRig = true;
    items.push({ key: 'skeleton', label: 'Skeleton', level: 'warn', detail: 'No tracking skeleton in the file: a simple "soft rig" was made so the head and body bend. Arms and legs won\'t track until you re-rig it with Blender.' });
  } else {
    needsRig = true;
    items.push({ key: 'skeleton', label: 'Skeleton', level: 'bad', detail: 'No skeleton: the model moves as one piece. Re-rig it with Blender for tracking.' });
  }
  // face
  const visemes = f.named.filter((n) => VISEMES.test(n)).length || (f.vrm && f.named.some((n) => /^aa$/i.test(n)) ? 1 : 0);
  const blink = f.named.some((n) => /blink/i.test(n));
  let needsFace = false;
  if (f.arkit >= 10) items.push({ key: 'face', label: 'Face shapes', level: 'ok', detail: `${f.arkit} ARKit face shapes: full expressions and lip sync ("perfect sync").` });
  else if (f.vrm && (visemes || blink)) items.push({ key: 'face', label: 'Face shapes', level: 'ok', detail: `VRM expressions found (${[visemes ? 'mouth vowels' : '', blink ? 'blink' : ''].filter(Boolean).join(', ')}${f.arkit ? `, ${f.arkit} ARKit` : ''}).` });
  else if (f.drawnFace) items.push({ key: 'face', label: 'Face shapes', level: 'ok', detail: `Drawn face set up (VTube Pro's mouth / eyes follow yours)${f.arkit || visemes || blink ? ', plus the model’s own shapes' : ''}.` });
  else if (f.jaw && !(f.arkit > 0 || visemes || blink)) items.push({ key: 'face', label: 'Face shapes', level: 'warn', detail: 'The mouth opens with a jaw bone (talks with your voice / mouth), but there are no blink or expression shapes. "Set up the face" adds drawn eyes if you want them.' });
  else if (f.arkit > 0 || visemes || blink) {
    const what = [f.arkit ? `${f.arkit} ARKit shape${f.arkit > 1 ? 's' : ''}` : '', visemes ? 'mouth vowels' : '', blink ? 'blink' : ''].filter(Boolean).join(', ');
    items.push({ key: 'face', label: 'Face shapes', level: 'warn', detail: `Some face shapes (${what}). They're used; anything missing is filled in by VTube Pro's drawn face.` });
  } else {
    needsFace = true;
    items.push({ key: 'face', label: 'Face shapes', level: 'bad', detail: 'No face shapes (no blink or mouth shapes). VTube Pro can add a drawn mouth and eyes that follow yours: "Set up the face".' });
  }
  // scale
  const h = f.height;
  if (!(h > 0)) items.push({ key: 'scale', label: 'Size', level: 'warn', detail: 'Couldn\'t measure the model.' });
  else if (h < 0.05 || h > 50) items.push({ key: 'scale', label: 'Size', level: 'warn', detail: `${fmtLen(h)} tall in its own units — probably exported in ${h > 50 ? 'centimetres or millimetres' : 'the wrong units'}. It's corrected on screen and in rooms; re-export in metres to be safe.` });
  else if (h < 0.3 || h > 3) items.push({ key: 'scale', label: 'Size', level: 'warn', detail: `${fmtLen(h)} tall. If the character really is that ${h < 0.3 ? 'tiny' : 'big'}, set Me → 📏 Real size so rooms seat it right.` });
  else items.push({ key: 'scale', label: 'Size', level: 'ok', detail: `${fmtLen(h)} tall.` });
  // polycount
  const t = f.triangles;
  if (t <= 37_000) items.push({ key: 'polycount', label: 'Detail', level: 'ok', detail: `${fmtTris(t)} triangles — light enough for any party.` });
  else if (t <= TRIS_MAX) items.push({ key: 'polycount', label: 'Detail', level: 'ok', detail: `${fmtTris(t)} triangles — fine (parties with a lower limit get an automatic lighter copy).` });
  else items.push({ key: 'polycount', label: 'Detail', level: 'warn', detail: `${fmtTris(t)} triangles — heavy. Fine solo; parties get an automatic lighter "party version" (preview: Me → 📏 Real size).` });
  const bad = items.filter((i) => i.level === 'bad').length, warn = items.filter((i) => i.level === 'warn').length;
  const summary = bad ? 'Your model loaded, but tracking is limited. The buttons below can fix it.'
    : warn ? 'Your model works. A few things are limited — see below.'
      : 'Your model is ready for full tracking.';
  return { items, needsRig, needsFace, summary };
}

function fmtLen(m: number) {
  return m >= 10 ? `${Math.round(m)} units` : m >= 1 ? `${m.toFixed(2)} m` : `${Math.round(m * 100)} cm`;
}

/** The friendly notice shown before every import. */
export const RIG_NOTICE = 'We\'ll check your model\'s rigging. If it isn\'t rigged for tracking (or is missing face shapes), VTube Pro can re-rig it automatically using Blender. This runs on your PC.';
