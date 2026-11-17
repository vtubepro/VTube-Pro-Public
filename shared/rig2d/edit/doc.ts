// The rig editor's document: an EDITABLE form of a .vtp2 rig. Geometry is kept in plain canvas pixels (x right, y down)
// whatever deformer a mesh hangs under, keyforms are kept as additive "forms" (one per parameter or parameter grid),
// and every object has a stable string id, so editing, undo and the auto-rig stay simple. exportVtp2 (vtp2.ts) turns
// it into the runtime format (deformer-local coordinates, keyform grids + blend shapes). Evaluation semantics match the
// runtime (shared/rig2d/evaluate.ts): rotation deformers turn their children rigidly about their origin (angle + =
// clockwise on screen) and follow their parent at that origin; warp deformers map their children through a lattice.
// Pure (no DOM).
import type { Mesh } from './mesh.ts';
import type { Role, Side } from './classify.ts';
import type { Rig2DDoc, Rig2DDynamic, Rig2DMaterialBinding, Rig2DPhysics } from '../format.ts';

export const EDIT_VERSION = 1;

export interface EdParam {
  id: string;
  name: string;
  min: number; max: number; def: number;
  /** UI grouping ("Head", "Eyes", "Mouth", "Physics" …). */
  group?: string;
  /** Kept from an imported rig (format ParamSchema): wraps around, decimals shown, a blend-shape parameter. */
  repeat?: boolean;
  decimals?: number;
  kind?: 'normal' | 'blend';
}

/** One keyform value. Meshes / warps use `d` (point offsets, canvas px, one x, y pair per point) and `o` (opacity
 *  factor, 1 = as authored). Rotation deformers use `a` (degrees, + = clockwise on screen), `ox` / `oy` (origin offset,
 *  px) and `s` (scale offset, 0 = none). */
export interface EdValue {
  d?: number[]; o?: number; a?: number; ox?: number; oy?: number; s?: number;
  /** Imported rigs (adopt.ts): multiply colour (rgb, 1 = none) and screen colour (rgb, 0 = none) at this keyform, and a
   *  draw-order offset added to the object's `z` (an arm that moves in front of the body). */
  mul?: [number, number, number]; scr?: [number, number, number]; z?: number;
}

/** A keyform group: values on the grid of its axes' keys (axis 0 varies fastest), blended multilinearly. Groups ADD up
 *  (offsets, angles) or MULTIPLY (opacity). `null` = the rest pose at that grid point. */
export interface EdForm {
  axes: { param: string; keys: number[] }[];
  values: (EdValue | null)[];
  /** Made by the auto-rig (re-running the auto-rig replaces auto forms, never hand-made ones). */
  auto?: boolean;
  /** From an imported rig (adopt.ts): exported as a keyform grid with exactly these keys, so (as in the imported model)
   *  the object is switched off where a parameter is outside its keys. May have no axes (one fixed keyform). */
  exact?: boolean;
  /** From an imported rig: exported as an additive blend shape (one or two axes), with the imported weight limits. */
  shape?: boolean;
  constraints?: { param: string; keys: number[]; weights: number[] }[];
}

export type EdBlend = 'normal' | 'add' | 'multiply' | 'screen';

export interface EdMesh {
  id: string;
  name: string;
  /** Folder path from the art (UI grouping). */
  group: string;
  role: Role;
  side: Side | null;
  /** Index into EdDoc.textures. */
  tex: number;
  /** Rest geometry, canvas px; uv 0..1 inside the texture. */
  mesh: Mesh;
  deformer: string | null;
  /** Draw order (higher = in front). */
  z: number;
  opacity: number;
  blend: EdBlend;
  /** Shows only where these meshes are drawn (clipping masks); maskInvert = only where they are not. */
  masks: string[];
  maskInvert?: boolean;
  visible: boolean;
  /** 2.5D depth in head radii (+ = toward the viewer): how far it shifts when the head turns (auto-rig). */
  depth: number;
  forms: EdForm[];
  /** Painted by the auto-rig (e.g. a missing inside of the mouth). */
  generated?: boolean;
  /** For layers the auto-rig did not understand: what they move with. */
  rides?: 'head' | 'body';
  /** The folder (EdPart id) it belongs to: costume layers and angle views switch whole folders. */
  part?: string | null;
  /** Hidden in the painted file but part of a costume switch (extras.ts autoCostumes): drawn while its switch is on;
   *  the switch starts off. */
  hiddenInArt?: boolean;
  /** What hid it in the painted file: indices into its folder path of the hidden folders, plus the path's length when
   *  its own eye was off (ArtLayer.hiddenAt). */
  hiddenAt?: number[];
  /** Bone weights: bone id → one weight per vertex (0..1). Normalised on export (4 strongest per vertex). */
  skin?: Record<string, number[]>;
  /** Ink outline around the part's silhouette (§8.10): width px, colour sRGB 0..255, opacity, follows the room light. */
  outline?: { width: number; color: [number, number, number]; opacity?: number; light?: boolean };
  /** 0..1: how much the part glows in the dark (emission map). */
  glow?: number;
  /** Angle view this layer belongs to (an angle folder in the PSD: front / three-quarter / side), null = every view. */
  view?: string | null;
  /** A mirrored copy of another mesh (made for an angle drawn only one way round). */
  mirrorOf?: string;
  /** Back faces are not drawn (an imported single-sided part). */
  culled?: boolean;
  /** Imported part (adopt.ts): its uv is not the canvas placement of its picture (the picture was cut from the imported
   *  atlas), so mesh edits read the uv from the mesh itself (meshEdit.ts). */
  uvFree?: boolean;
}

export interface EdDeformer {
  id: string;
  name: string;
  kind: 'rotation' | 'warp';
  parent: string | null;
  /** rotation: pivot (canvas px). */
  origin?: [number, number];
  /** warp: lattice rectangle (canvas px) and cells. */
  rect?: [number, number, number, number];
  cols?: number; rows?: number;
  /** warp: false = cells interpolate over two triangles (an imported lattice); default true (bilinear). */
  quad?: boolean;
  /** rotation, imported rigs: the rest frame its children are drawn in (canvas px = origin + scale · R(angle) · local;
   *  angle in degrees, + = clockwise, accumulated down the rotation chain) and mirroring. Absent = upright, scale 1. */
  frame?: { angle: number; scale: number };
  reflect?: [boolean, boolean];
  forms: EdForm[];
}

/** A hair strand: the weighted inputs swing it, its angle drives the output parameter (exported as a runtime physics strand).
 *  `chain` = extra outputs, one per further strand particle (bone chains: one bone angle parameter per particle). */
export interface EdPhysics {
  id: string;
  name: string;
  inputs: { param: string; weight: number; type: 'x' | 'angle' }[];
  output: string;
  chain?: string[];
  /** Pendulum length (px; longer = slower), damping 0..1, how far it may swing (degrees), output gain. */
  length: number;
  damping: number;
  maxAngle: number;
  gain: number;
}

export interface EdExpression {
  id: string;
  name: string;
  key?: string;
  /** Fade times (s); default 0.25. */
  fadeIn?: number; fadeOut?: number;
  params: { param: string; value: number; blend: 'add' | 'multiply' | 'overwrite' }[];
}

/** A texture and where its picture sits on the canvas as painted (px). `kind`: 'layer' (art, default), 'sprite' (a
 *  particle / prop picture, not drawn as a mesh). */
export interface EdTextureInfo { name: string; x: number; y: number; w: number; h: number; kind?: 'layer' | 'sprite' }

/** A bone (beyond Live2D). Rest pose in its deformer's rest space (canvas px): origin x, y, direction `angle` (degrees,
 *  clockwise from +x, so 90 points down), length. `forms` turn it (value.a = degrees, clockwise on screen). */
export interface EdBone {
  id: string;
  name: string;
  parent: string | null;
  deformer: string | null;
  x: number; y: number; angle: number; length: number;
  forms: EdForm[];
  auto?: boolean;
}

/** A folder of the art (parts in the format): costume layers and angle views switch folders on and off. */
export interface EdPart { id: string; name: string; parent: string | null }

/** Where an effect / prop sits: on a mesh vertex (vertex2 = its +x direction), a bone, or a point in a deformer's rest
 *  space (canvas px). */
export interface EdSlot { mesh?: string; vertex?: number; vertex2?: number; bone?: string; deformer?: string; x?: number; y?: number }
export type EdDrawAt = { above?: string; at?: 'front' | 'back' };

/** Particle emitter (sparkles, tears, sweat, steam …), docs/RIG2D_FORMAT.md §8.7: speed [min, max] px / s in direction
 *  `angle` (0 = up, + clockwise) ± spread degrees, gravity px / s² (+y down), size [start, end] px, spin degrees / s. */
export interface EdParticles {
  id: string;
  name: string;
  preset?: string;
  slot: EdSlot;
  /** Sprite texture index (EdDoc.textures, kind 'sprite'). */
  tex: number;
  rate: number; life: number; speed: [number, number]; angle?: number; spread: number; gravity: [number, number]; size: [number, number];
  spin?: number; fade?: number; max?: number; blend?: 'normal' | 'add' | 'screen'; draw?: EdDrawAt;
  trigger: { kind: 'always' | 'voice' | 'emotion' | 'chat' | 'hotkey' | 'param' | 'event' | 'expression'; value?: string; above?: number; burst?: number };
  /** Off = kept in the project, not exported. */
  on?: boolean;
}

/** A prop pinned to the avatar (a held item, a hat …), §8.6. */
export interface EdAttachment {
  id: string;
  name: string;
  slot: EdSlot;
  tex: number;
  pivot: [number, number];
  size: [number, number];
  angle?: number;
  rotate?: boolean;
  blend?: 'normal' | 'add' | 'multiply' | 'screen';
  draw?: EdDrawAt;
  on: boolean;
}

/** Procedural motion, §8.4 (format shape; inputs may be "role:<name>"). */
export interface EdDynamic {
  id: string; kind: 'spring' | 'jiggle' | 'wind' | 'chain' | 'follow';
  input?: string; output?: string; bones?: string[];
  /** follow (follow-through, §8.4): the meshes, the held side, how much of the extent is held, overlap 0..1, offset cap (fraction of the mesh's size), squash and stretch 0..1 */
  meshes?: string[]; anchor?: 'top' | 'bottom' | 'left' | 'right' | 'center'; reach?: number; spread?: number; stretch?: number; squash?: number;
  stiffness?: number; damping?: number; gain?: number; strength?: number; period?: number; gravity?: number;
  /** chain: how far the whole chain may bend / each bone may bend (degrees). */
  limit?: number; boneLimit?: number;
  /** the parameter whose value scales this motion (0 = still, 1 = as rigged; a part's "swing" slider) */
  amount?: string;
  auto?: boolean;
}

/** Costume layer: folders switched together (one per `group`). */
export interface EdCostume { id: string; name: string; parts: string[]; attachments?: string[]; group?: string; on: boolean }

/** Expression state machine (the format's states.layers, ids as in the format). */
export interface EdStateLayer {
  id: string; name?: string; initial: string;
  states: { id: string; expression?: string; motion?: string }[];
  transitions: { from: string; to: string; fade?: number; on: { kind: 'voice' | 'silence' | 'emotion' | 'chat' | 'hotkey' | 'param' | 'timer' | 'event'; value?: string; above?: number; below?: number; after?: number } }[];
}

/** Optional / beyond-Live2D features of a document. */
export interface EdExtras {
  /** Hair / ears / hanging accessories on bones (true) or keyform swing (false). */
  useBones?: boolean;
  /** How far the head turns in 2.5D (auto-rig `turn`). */
  turn?: number;
  parts?: EdPart[];
  bones?: EdBone[];
  particles?: EdParticles[];
  attachments?: EdAttachment[];
  dynamics?: EdDynamic[];
  costumes?: EdCostume[];
  states?: EdStateLayer[];
  /** Angle views: by = the yaw parameter, sets = folders shown at a yaw (degrees). */
  views?: { by: string; sets: { id: string; at: number; parts: string[] }[]; blendBand?: number; hysteresis?: number };
  /** Room lighting (§8.3): generate normal / rim maps from the art (`maps`; `rimPx` = the rim band painted into the rim
   *  map), how much room colour tints it, shading strength, rim light (width 0..1, strength 0..2). */
  lighting?: { maps: boolean; rimPx: number; tint: number; strength: number; rim: { width: number; strength: number } };
}

export interface EdDoc {
  version: number;
  name: string;
  canvas: { w: number; h: number };
  textures: EdTextureInfo[];
  params: EdParam[];
  meshes: EdMesh[];
  deformers: EdDeformer[];
  physics: EdPhysics[];
  expressions: EdExpression[];
  meta: { authors?: string[]; license?: string; notes?: string };
  /** Beyond-Live2D features (bones, lighting, effects, props, costumes, moods, angle views). */
  extras?: EdExtras;
  /** Auto-rig report (which layers it understood, notes). */
  report?: { understood: { name: string; role: Role; side: Side | null; why: string }[]; notes: string[] };
  /** Set when this document was made from an imported model (adopt.ts): the auto-rig never re-rigs it. */
  imported?: EdImported;
}

/** What an imported model (a converted Live2D / Inochi2D model, or a .vtp2 from elsewhere) brings that the maker keeps
 *  as it is (exported unchanged by vtp2.ts buildRig; ids, not indices, so edits elsewhere never break them). */
export interface EdImported {
  from: 'live2d' | 'inochi2d' | 'native';
  file?: string;
  /** What did not come over exactly (plain sentences, shown once when it opens). */
  notes: string[];
  roles?: Rig2DDoc['roles'];
  physics?: Rig2DPhysics[];
  physicsWorld?: Rig2DDoc['physicsWorld'];
  glue?: EdGlue[];
  /** Solvers the maker has no editor for (pendulums of Inochi2D models). */
  dynamics?: Rig2DDynamic[];
  materialBindings?: EdMaterialBinding[];
  switches?: Rig2DDoc['switches'];
  hitAreas?: Rig2DDoc['hitAreas'];
  /** 2.5D parallax as the model had it: the turn parameters + strength, and each part's total depth (px) by id. */
  depth?: { yaw?: string; pitch?: string; strength: number; meshes: Record<string, number> };
  extra?: Record<string, unknown>;
  licenseUrl?: string;
  rights?: Rig2DDoc['meta']['rights'];
}
/** Glue between two imported meshes (pairs of vertex indices + weights per pair, intensity on a keyform grid). Dropped
 *  on export once either mesh has another number of points. */
export interface EdGlue { id: string; name?: string; a: string; b: string; na: number; nb: number; axes: { param: string; keys: number[] }[]; intensity: number[]; pairs: number[]; weights: number[] }
export interface EdMaterialBinding {
  deformer: string; opacity: number; multiply: [number, number, number]; screen: [number, number, number];
  bindings: { channel: Rig2DMaterialBinding['bindings'][number]['channel']; param: string; keys: number[]; param2?: string; keys2?: number[]; values: number[] }[];
}

/** Texture pixels live beside the document (not in undo snapshots). */
export interface EdTexture { w: number; h: number; rgba: Uint8ClampedArray }

export const emptyDoc = (w: number, h: number, name = 'New avatar'): EdDoc => ({ version: EDIT_VERSION, name, canvas: { w, h }, textures: [], params: [], meshes: [], deformers: [], physics: [], expressions: [], meta: {} });

export const findParam = (d: EdDoc, id: string) => d.params.find((p) => p.id === id);
export const findMesh = (d: EdDoc, id: string) => d.meshes.find((m) => m.id === id);
export const findDeformer = (d: EdDoc, id: string) => d.deformers.find((f) => f.id === id);
export function uniqueId(base: string, taken: (id: string) => boolean): string {
  const b = base.replace(/[^A-Za-z0-9_\-.]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'item';
  if (!taken(b)) return b;
  for (let i = 2; ; i++) if (!taken(`${b}_${i}`)) return `${b}_${i}`;
}

/** How many points a target's `d` has. */
export function pointCount(d: EdDoc, t: EdMesh | EdDeformer): number {
  if ('mesh' in t) return t.mesh.pos.length / 2;
  return t.kind === 'warp' ? ((t.cols ?? 1) + 1) * ((t.rows ?? 1) + 1) : 0;
}

// ---------------------------------------------------------------- grid helpers
export function gridSize(f: EdForm) { return f.axes.reduce((n, a) => n * a.keys.length, 1); }
/** [lower key index, fraction] of v among keys (clamped at the ends). */
export function bracket(keys: readonly number[], v: number): [number, number] {
  const n = keys.length;
  if (n <= 1 || v <= keys[0]) return [0, 0];
  if (v >= keys[n - 1]) return [n - 2, 1];
  let u = 1;
  while (u < n - 1 && keys[u] <= v) u++;
  return [u - 1, (v - keys[u - 1]) / (keys[u] - keys[u - 1])];
}

/** The grid corners around `vals` and their weights (multilinear). Writes into idx / w (length 2^axes). */
export function corners(f: EdForm, vals: (id: string) => number, idx: number[], w: number[]): number {
  const n = f.axes.length;
  const lo: number[] = [], t: number[] = [], size: number[] = [];
  for (const a of f.axes) { const [l, tt] = bracket(a.keys, vals(a.param)); lo.push(a.keys.length > 1 ? l : 0); t.push(a.keys.length > 1 ? tt : 0); size.push(a.keys.length); }
  const cn = 1 << n;
  for (let c = 0; c < cn; c++) {
    let k = 0, s = 1, ww = 1;
    for (let i = 0; i < n; i++) {
      const hi = (c >> i) & 1;
      const li = Math.min(lo[i] + hi, size[i] - 1);
      k += li * s; s *= size[i];
      ww *= hi ? t[i] : 1 - t[i];
    }
    idx[c] = k; w[c] = ww;
  }
  return cn;
}

/** Grid index of an exact key combination (`at[i]` = key index on axis i). */
export function gridIndex(f: EdForm, at: number[]): number { let k = 0, s = 1; f.axes.forEach((a, i) => { k += at[i] * s; s *= a.keys.length; }); return k; }

/** The key index on each axis when every axis parameter sits exactly on a key (±eps), else null. */
export function onKeys(f: EdForm, vals: (id: string) => number, eps = 1e-4): number[] | null {
  const at: number[] = [];
  for (const a of f.axes) { const v = vals(a.param); const i = a.keys.findIndex((k) => Math.abs(k - v) <= eps * Math.max(1, Math.abs(k))); if (i < 0) return null; at.push(i); }
  return at;
}

/** Find (or make) the form of `target` over exactly these parameters. */
export function formFor(target: { forms: EdForm[] }, params: string[], keysOf: (p: string) => number[]): EdForm {
  let f = target.forms.find((x) => x.axes.length === params.length && x.axes.every((a, i) => a.param === params[i]));
  if (!f) {
    f = { axes: params.map((p) => ({ param: p, keys: keysOf(p).slice() })), values: [] };
    f.values = new Array(gridSize(f)).fill(null);
    target.forms.push(f);
  }
  return f;
}

/** Add a key to one axis of a form, keeping the existing values (the new grid points get the blended value there, so the
 *  look does not change until the user records something). */
export function addKey(f: EdForm, param: string, key: number, nPoints: number) {
  const ai = f.axes.findIndex((a) => a.param === param);
  if (ai < 0) return;
  const ax = f.axes[ai];
  if (ax.keys.some((k) => Math.abs(k - key) < 1e-6)) return;
  const oldKeys = ax.keys.slice();
  const newKeys = [...oldKeys, key].sort((a, b) => a - b);
  const old: EdForm = { axes: f.axes.map((a) => ({ param: a.param, keys: a.keys.slice() })), values: f.values };
  const nf: EdForm = { axes: f.axes.map((a, i) => ({ param: a.param, keys: i === ai ? newKeys : a.keys.slice() })), values: [] };
  const N = gridSize(nf);
  nf.values = new Array(N);
  const at = new Array(nf.axes.length).fill(0);
  for (let k = 0; k < N; k++) {
    let r = k;
    nf.axes.forEach((a, i) => { at[i] = r % a.keys.length; r = Math.floor(r / a.keys.length); });
    const vals = (p: string) => { const i = nf.axes.findIndex((a) => a.param === p); return nf.axes[i].keys[at[i]]; };
    nf.values[k] = sampleForm(old, vals, nPoints);
  }
  f.axes = nf.axes; f.values = nf.values;
}

/** Remove a key from one axis (its grid points are dropped). */
export function removeKey(f: EdForm, param: string, key: number) {
  const ai = f.axes.findIndex((a) => a.param === param);
  if (ai < 0) return;
  const ki = f.axes[ai].keys.findIndex((k) => Math.abs(k - key) < 1e-6);
  if (ki < 0 || f.axes[ai].keys.length <= 1) return;
  const at = new Array(f.axes.length).fill(0);
  const vals: (EdValue | null)[] = [];
  for (let k = 0; k < f.values.length; k++) {
    let r = k;
    f.axes.forEach((a, i) => { at[i] = r % a.keys.length; r = Math.floor(r / a.keys.length); });
    if (at[ai] !== ki) vals.push(f.values[k]);
  }
  f.axes[ai].keys.splice(ki, 1);
  f.values = vals;
}

/** A form's blended value at parameter values (a fresh EdValue; null when every corner is the rest pose). */
export function sampleForm(f: EdForm, vals: (id: string) => number, nPoints: number): EdValue | null {
  const idx: number[] = [], w: number[] = [];
  const cn = corners(f, vals, idx, w);
  let any = false, anyO = false, oSum = 0, anyMul = false, anyScr = false;
  const out: EdValue = {}, mul = [0, 0, 0], scr = [0, 0, 0];
  for (let c = 0; c < cn; c++) {
    const v = f.values[idx[c]], ww = w[c];
    if (!ww) continue;
    oSum += ww * (v?.o ?? 1);
    for (let k = 0; k < 3; k++) { mul[k] += ww * (v?.mul?.[k] ?? 1); scr[k] += ww * (v?.scr?.[k] ?? 0); }
    if (!v) continue;
    any = true;
    if (v.o !== undefined) anyO = true;
    if (v.mul) anyMul = true;
    if (v.scr) anyScr = true;
    if (v.d) { if (!out.d) out.d = new Array(nPoints * 2).fill(0); for (let k = 0; k < out.d.length && k < v.d.length; k++) out.d[k] += v.d[k] * ww; }
    for (const k of ['a', 'ox', 'oy', 's', 'z'] as const) if (v[k] !== undefined) out[k] = (out[k] ?? 0) + v[k]! * ww;
  }
  if (anyO) out.o = oSum;
  if (anyMul) out.mul = mul as [number, number, number];
  if (anyScr) out.scr = scr as [number, number, number];
  return any ? out : null;
}

/** Record into `target`'s form over `params` at the CURRENT parameter values: keys are added where the values are not
 *  on a key yet (keeping the look), then `edit` changes the value stored at that grid point (created from the rest pose
 *  when empty). Other forms are untouched, so what you record is what this parameter adds. Returns the form. */
export function recordAt(target: { forms: EdForm[] }, params: string[], vals: (id: string) => number, nPoints: number, edit: (v: EdValue) => void, keysOf: (p: string) => number[]): EdForm {
  const f = formFor(target, params, keysOf);
  f.auto = false; // hand-edited: the auto-rig keeps it from now on
  for (const p of params) addKey(f, p, Math.round(vals(p) * 1e4) / 1e4, nPoints);
  const at = onKeys(f, vals, 1e-3);
  if (!at) return f;
  const k = gridIndex(f, at);
  const v: EdValue = f.values[k] ? { ...f.values[k]!, ...(f.values[k]!.d ? { d: f.values[k]!.d!.slice() } : {}) } : {};
  edit(v);
  f.values[k] = v;
  return f;
}

/** Add (dx, dy) to point i of a value (making its offset list). */
export function nudge(v: EdValue, nPoints: number, i: number, dx: number, dy: number) {
  if (!v.d) v.d = new Array(nPoints * 2).fill(0);
  v.d[i * 2] += dx; v.d[i * 2 + 1] += dy;
}

/** Default keys for a new form over a parameter: its min, default and max. */
export const defaultKeys = (p: EdParam) => [...new Set([p.min, p.def, p.max])].sort((a, b) => a - b);
