// AUTO-RIG: a layered picture → a working, trackable 2D avatar in one step.
//   1. classify every layer (classify.ts) and mesh it (mesh.ts);
//   2. build the deformer tree (body tilt → head tilt) and the standard parameters (Live2D-style ids, so motions and
//      the parameter-mapping panel speak the same names; roles.bind on export says which tracked input drives which);
//   3. write keyforms for every part from its role: a 2.5D head turn / nod (each vertex projected on a head ellipsoid
//      plus the part's depth, so the fringe moves more than the face and the back hair moves the other way), blinks
//      that close the lid along a curve, eye smiles, gaze, brows, a mouth that opens (painting an inside of the mouth
//      when the art has none) and smiles, blush, body turn / lean / tilt, breathing, and hair swing driven by pendulum
//      physics;
//   4. masks (iris inside the eye white, teeth and tongue inside the mouth, Photoshop clipping), expressions.
// Re-running applyAutoRig on an edited document rebuilds only the auto keyforms (hand-made ones are kept) for the
// current roles, meshes and depths. Pure (no DOM).
import { trimLayer, type ArtLayer, type ArtSet } from './layers.ts';
import { classifyLayers, HEAD_ROLES, ridesOn, ROLE_LABEL, type ClassifyResult, type Role, type Side } from './classify.ts';
import { autoMesh, spacingFor } from './mesh.ts';
import { applyExtras, partsFromFolders, type Landmarks } from './extras.ts';
import { EDIT_VERSION, type EdDeformer, type EdDoc, type EdForm, type EdMesh, type EdParam, type EdTexture, type EdValue } from './doc.ts';

export interface AutoRigOpts {
  /** Mesh density 0 (coarse) … 1 (fine). */
  density?: number;
  /** How far the head turns at ±30 (0.3 … 1.2, default 0.6 = about ±18° of real turn). */
  turn?: number;
  name?: string;
  /** Side / back hair, ahoge, animal ears and hanging accessories swing on bones with chain physics (default true);
   *  false = the older keyform swing driven by pendulum strands. */
  bones?: boolean;
}

/** Standard parameters: id, name, min, max, default, group. */
export const STD_PARAMS: [string, string, number, number, number, string][] = [
  ['ParamAngleX', 'Head turn', -30, 30, 0, 'Head'], ['ParamAngleY', 'Head nod', -30, 30, 0, 'Head'], ['ParamAngleZ', 'Head tilt', -30, 30, 0, 'Head'],
  ['ParamBodyAngleX', 'Body turn', -10, 10, 0, 'Body'], ['ParamBodyAngleY', 'Body lean', -10, 10, 0, 'Body'], ['ParamBodyAngleZ', 'Body tilt', -10, 10, 0, 'Body'],
  ['ParamBreath', 'Breathing', 0, 1, 0, 'Body'],
  ['ParamEyeLOpen', 'Left eye open', 0, 1, 1, 'Eyes'], ['ParamEyeROpen', 'Right eye open', 0, 1, 1, 'Eyes'],
  ['ParamEyeLSmile', 'Left eye smile', 0, 1, 0, 'Eyes'], ['ParamEyeRSmile', 'Right eye smile', 0, 1, 0, 'Eyes'],
  ['ParamEyeBallX', 'Eyes look left / right', -1, 1, 0, 'Eyes'], ['ParamEyeBallY', 'Eyes look up / down', -1, 1, 0, 'Eyes'],
  ['ParamBrowLY', 'Left brow height', -1, 1, 0, 'Brows'], ['ParamBrowRY', 'Right brow height', -1, 1, 0, 'Brows'],
  ['ParamBrowLForm', 'Left brow shape', -1, 1, 0, 'Brows'], ['ParamBrowRForm', 'Right brow shape', -1, 1, 0, 'Brows'],
  ['ParamMouthOpenY', 'Mouth open', 0, 1, 0, 'Mouth'], ['ParamMouthForm', 'Mouth smile / frown', -1, 1, 0, 'Mouth'],
  ['ParamCheek', 'Blush', 0, 1, 0, 'Face'],
  ['ParamHairFront', 'Front hair swing', -1, 1, 0, 'Physics'], ['ParamHairSide', 'Side hair swing', -1, 1, 0, 'Physics'], ['ParamHairBack', 'Back hair swing', -1, 1, 0, 'Physics'],
  ['ParamHairAhoge', 'Ahoge swing', -1, 1, 0, 'Physics'],
  ['ParamVoice', 'Talking (voice level)', 0, 1, 0, 'Mouth'],
  // the five mouth shapes of speech (optional: shared/lipBus.ts feeds them from the voice visemes; a rig without them talks with Open + Form)
  ['ParamMouthA', 'Mouth shape "ah"', 0, 1, 0, 'Mouth'], ['ParamMouthI', 'Mouth shape "ee" (thin)', 0, 1, 0, 'Mouth'], ['ParamMouthU', 'Mouth shape "oo"', 0, 1, 0, 'Mouth'],
  ['ParamMouthE', 'Mouth shape "eh"', 0, 1, 0, 'Mouth'], ['ParamMouthO', 'Mouth shape "oh"', 0, 1, 0, 'Mouth'],
];
/** Tracked input (shared/rig2d/format.ts STANDARD_ROLES) → the parameter the auto-rig made for it. */
export const STD_BIND: Record<string, string> = {
  headYaw: 'ParamAngleX', headPitch: 'ParamAngleY', headRoll: 'ParamAngleZ', bodyYaw: 'ParamBodyAngleX', bodyPitch: 'ParamBodyAngleY', bodyRoll: 'ParamBodyAngleZ',
  eyeOpenL: 'ParamEyeLOpen', eyeOpenR: 'ParamEyeROpen', eyeSmileL: 'ParamEyeLSmile', eyeSmileR: 'ParamEyeRSmile', gazeX: 'ParamEyeBallX', gazeY: 'ParamEyeBallY',
  browLY: 'ParamBrowLY', browRY: 'ParamBrowRY', browLForm: 'ParamBrowLForm', browRForm: 'ParamBrowRForm', mouthOpen: 'ParamMouthOpenY', mouthForm: 'ParamMouthForm',
  cheek: 'ParamCheek', breath: 'ParamBreath', voice: 'ParamVoice',
};
/** The mouth shapes' bindings. NOT in roles.bind (its role list is closed: an older build's strict schema would refuse the file):
 *  vtp2.ts writes them to `extra.vowelBind`, which older builds accept and ignore (docs/RIG2D_FORMAT.md). */
export const VOWEL_BIND: Record<string, string> = { mouthA: 'ParamMouthA', mouthI: 'ParamMouthI', mouthU: 'ParamMouthU', mouthE: 'ParamMouthE', mouthO: 'ParamMouthO' };

/** Default 2.5D depth per role (head radii, + = toward the viewer). */
export const ROLE_DEPTH: Partial<Record<Role, number>> = {
  face: 0, nose: 0.22, blush: 0.06, ear: -0.3, eyeWhite: 0.08, iris: 0.085, highlight: 0.09, lashUpper: 0.08, lashLower: 0.08, eyeClosed: 0.08, eyeWhole: 0.08,
  brow: 0.14, mouthUpper: 0.12, mouthLower: 0.12, mouthInner: 0.12, teeth: 0.12, tongue: 0.12, mouth: 0.12, mouthOpening: 0.12, hairFront: 0.3, hairSide: 0.04, hairBack: -0.25, ahoge: 0.1,
  headAcc: 0.24, neck: -0.1, body: 0, arm: -0.12, hand: 0.2, bodyAcc: 0.15, unknown: 0.15,
};

/** Layers → a new rigged document + textures. */
export function autoRigArt(art0: ArtSet, o: AutoRigOpts = {}): { doc: EdDoc; textures: EdTexture[]; cls: ClassifyResult } {
  // full-canvas layers (GIMP, Clip Studio exports) are cropped to their pixels; empty layers are dropped
  const kept = art0.layers.map((l) => trimLayer(l, 2));
  const empty = art0.layers.filter((_, i) => !kept[i]).map((l) => l.name);
  const art: ArtSet = { ...art0, layers: kept.filter((l): l is ArtLayer => !!l) };
  // angle folders (Front / 3-4 / Side): each drawing is classified on its own, the shared layers with the front one
  const angles = detectAngles(art.layers);
  const cls = classifyLayers(art.layers, art);
  if (angles.views.length) {
    const front = angles.views.find((v) => v.kind === 'front');
    const groups = [{ id: front?.id ?? null, idx: art.layers.map((_, i) => i).filter((i) => angles.of[i] === null || angles.of[i] === front?.id) },
      ...angles.views.filter((v) => v !== front).map((v) => ({ id: v.id, idx: art.layers.map((_, i) => i).filter((i) => angles.of[i] === v.id) }))];
    for (const g of groups) {
      const sub = classifyLayers(g.idx.map((i) => art.layers[i]), art);
      sub.layers.forEach((c, k) => { cls.layers[g.idx[k]] = { ...c, index: g.idx[k] }; });
    }
  }
  const doc: EdDoc = { version: EDIT_VERSION, name: o.name ?? 'My avatar', canvas: { w: art.width, h: art.height }, textures: [], params: [], meshes: [], deformers: [], physics: [], expressions: [], meta: {} };
  const textures: EdTexture[] = [];
  const density = o.density ?? 0.5;
  const used = new Set<string>();
  art.layers.forEach((l, i) => {
    const c = cls.layers[i];
    const tex = textures.length;
    textures.push({ w: l.w, h: l.h, rgba: l.rgba });
    doc.textures.push({ name: l.name, x: l.x, y: l.y, w: l.w, h: l.h });
    let id = slug(`${l.name}${c.side && !/(^|[^a-z])[lr]$/i.test(l.name) ? '_' + c.side : ''}`);
    for (let k = 2; used.has(id); k++) id = slug(`${l.name}_${k}`);
    used.add(id);
    doc.meshes.push({
      id, name: l.name, group: l.path.join('/'), role: c.role, side: c.side, tex,
      mesh: meshFor(l, c.role, cls, density),
      deformer: null, z: i * 10, opacity: l.opacity, blend: l.blend === 'overlay' ? 'normal' : l.blend, masks: [], visible: l.visible,
      depth: ROLE_DEPTH[c.role] ?? 0.15, forms: [],
      ...(angles.views.length ? { view: angles.of[i] } : {}),
      ...(!l.visible && l.hiddenAt?.length ? { hiddenAt: [...l.hiddenAt] } : {}),
    });
    if (c.role === 'unknown') doc.meshes[doc.meshes.length - 1].rides = ridesOn(c);
  });
  // Photoshop clipping masks: clipped to the nearest non-clipped layer below
  art.layers.forEach((l, i) => {
    if (!l.clipped) return;
    if (l.clipFolder) {
      // clipped to a whole folder: every visible, unclipped layer in it (their merged alpha)
      const f = l.clipFolder.join('/');
      const inside = art.layers.map((x, k) => ({ x, k })).filter(({ x }) => !x.clipped && x.visible && (x.path.join('/') === f || x.path.join('/').startsWith(`${f}/`)));
      if (inside.length) { doc.meshes[i].masks = inside.slice(0, 64).map(({ k }) => doc.meshes[k].id); return; }
    }
    for (let k = i - 1; k >= 0; k--) if (!art.layers[k].clipped) { doc.meshes[i].masks = [doc.meshes[k].id]; break; }
  });
  doc.report = {
    understood: cls.layers.map((c) => ({ name: c.name, role: c.role, side: c.side, why: c.why })),
    notes: [...art0.warnings, ...cls.notes, ...(empty.length ? [`${empty.length} empty layer${empty.length > 1 ? 's' : ''} skipped.`] : []),
      ...(cls.layers.some((c) => c.role === 'ignore') ? [`Left out: ${cls.layers.filter((c) => c.role === 'ignore').map((c) => `"${c.name}"`).join(', ')} (backgrounds, adjustment layers and guides are not part of the avatar).`] : [])],
  };
  for (const m of doc.meshes) if (m.role === 'ignore') m.visible = false;
  // alternate states artists keep hidden (closed eyes): shown by their keyforms instead
  for (const m of doc.meshes) if (m.role === 'eyeClosed') m.visible = true;
  partsFromFolders(doc);
  if (angles.views.length) setupViews(doc, angles.views);
  applyAutoRig(doc, textures, o);
  return { doc, textures, cls };
}

// ------------------------------------------------------------------ angle views
type ViewKind = 'front' | 'quarter' | 'side';
interface AngleView { id: string; name: string; kind: ViewKind; dir: -1 | 0 | 1 }
/** An angle folder's name is (mostly) just the angle: "Front", "3/4 view", "Side L", "横顔", "45 right" … ("Side hair" is not). */
const angleKind = (name: string): ViewKind | null => {
  const n = name.toLowerCase().replace(/\b(view|angle|face|head|drawing|ver|version|pose|left|right|l|r)\b|左|右|向き/g, ' ').replace(/[()[\]_.,-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(3 ?\/ ?4|3 4|three ?quarters?|quarter|45|斜め|ななめ|半側面)$/.test(n)) return 'quarter';
  if (/^(side|profile|90|横顔|横|側面)$/.test(n)) return 'side';
  if (/^(front|frontal|正面)$/.test(n)) return 'front';
  return null;
};
/** Folders that hold one angle of the head (Front / 3-4 / Side): which layers belong to which. */
export function detectAngles(layers: readonly ArtLayer[]): { views: AngleView[]; of: (string | null)[] } {
  const views = new Map<string, AngleView>();
  const of = layers.map((l) => {
    for (let i = 0; i < l.path.length; i++) {
      const seg = l.path[i];
      const kind = angleKind(seg);
      if (!kind) continue;
      const id = slug(l.path.slice(0, i + 1).join('_'));
      const dir = /\b(left|l)\b|左/i.test(seg) ? -1 : /\b(right|r)\b|右/i.test(seg) ? 1 : 0;
      if (!views.has(id)) views.set(id, { id, name: seg, kind, dir: dir as -1 | 0 | 1 });
      return id;
    }
    return null;
  });
  const list = [...views.values()];
  // one front folder alone is not a multi-angle PSD
  if (!list.some((v) => v.kind !== 'front')) return { views: [], of: layers.map(() => null) };
  return { views: list, of };
}

/** Views from the angle folders: which way each drawing faces (from its features), the turn it shows at, and a mirrored
 *  copy for a 3/4 or side drawn only one way round. */
function setupViews(doc: EdDoc, views: AngleView[]) {
  const X = (doc.extras ??= {});
  const parts = X.parts ?? [];
  const box = (m: EdMesh) => doc.textures[m.tex];
  const front = views.find((v) => v.kind === 'front');
  const frontFace = doc.meshes.find((m) => m.role === 'face' && (!front || m.view === front.id || !m.view));
  const cx = frontFace ? box(frontFace).x + box(frontFace).w / 2 : doc.canvas.w / 2;
  const sets: { id: string; at: number; parts: string[] }[] = [];
  if (front) sets.push({ id: front.id, at: 0, parts: [front.id] });
  for (const v of views) {
    if (v === front) continue;
    const G = doc.meshes.filter((m) => m.view === v.id);
    let dir = v.dir;
    if (!dir) {
      // facing: the eyes and mouth sit toward the side the head turns to
      const face = G.find((m) => m.role === 'face');
      const feat = G.filter((m) => ['eyeWhite', 'eyeWhole', 'iris', 'mouth', 'mouthUpper', 'mouthInner', 'nose'].includes(m.role));
      if (face && feat.length) { const f = box(face), fx = feat.reduce((t, m) => t + box(m).x + box(m).w / 2, 0) / feat.length; dir = fx >= f.x + f.w / 2 ? 1 : -1; }
      else dir = 1;
    }
    const at = dir * (v.kind === 'quarter' ? 18 : 30);
    sets.push({ id: v.id, at, parts: [v.id] });
    const opposite = views.some((o) => o !== v && o.kind === v.kind && (o.dir === -dir || (!o.dir && o !== v)));
    if (opposite) continue;
    // mirror it for the other direction (the same pictures, flipped)
    const mid = `${v.id}_mirror`;
    parts.push({ id: mid, name: `${v.name} (mirrored)`, parent: null });
    const idMap = new Map<string, string>();
    const copies: EdMesh[] = G.map((m) => {
      const id = `${m.id}_mirror`;
      idMap.set(m.id, id);
      return { ...m, id, name: `${m.name} (mirrored)`, mirrorOf: m.id, view: mid, part: mid, side: m.side === 'L' ? 'R' : m.side === 'R' ? 'L' : null, forms: [], skin: undefined,
        mesh: { pos: m.mesh.pos.map((p, i) => (i % 2 === 0 ? 2 * cx - p : p)), uv: m.mesh.uv.slice(), tri: m.mesh.tri.slice() }, masks: m.masks.slice() };
    });
    for (const c of copies) c.masks = c.masks.map((id) => idMap.get(id) ?? id);
    doc.meshes.push(...copies);
    sets.push({ id: mid, at: -at, parts: [mid] });
  }
  X.parts = parts;
  // hand-over: a short band (3°) around each midpoint, kept 2° past it before switching back (no flicker)
  X.views = { by: 'ParamAngleX', sets: sets.sort((a, b) => a.at - b.at), blendBand: 3, hysteresis: 2 };
}

function slug(s: string) { return s.normalize('NFKC').replace(/[^\p{L}\p{N}_\-.]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'layer'; }

function meshFor(l: ArtLayer, role: Role, cls: ClassifyResult, density: number) {
  let sp = spacingFor(l.w, l.h, density);
  // parts that bend with the head turn need a fine enough mesh across the head
  if (HEAD_ROLES.has(role) && cls.face) sp = Math.min(sp, Math.max(6, cls.face.w / (8 + density * 14)));
  if (role === 'mouthInner' || role === 'mouth' || role === 'mouthUpper' || role === 'mouthLower' || role === 'teeth' || role === 'tongue') sp = Math.min(sp, Math.max(3, Math.min(l.w, l.h) / 5));
  if (role === 'lashUpper' || role === 'lashLower' || role === 'brow' || role === 'eyeWhite' || role === 'iris' || role === 'eyeWhole') sp = Math.min(sp, Math.max(3, l.w / 8));
  return autoMesh(l.rgba, l.w, l.h, l.x, l.y, { spacing: sp });
}

// ------------------------------------------------------------------ geometry from the art
type Box = { x: number; y: number; w: number; h: number };
const unionBox = (bs: Box[]): Box | null => {
  if (!bs.length) return null;
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y)), x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** Per canvas column across a mesh's texture: the alpha-weighted mean y (centre line) and the top / bottom of the art. */
class Profile {
  cy: Float32Array; top: Float32Array; bot: Float32Array;
  constructor(public x0: number, public y0: number, w: number, h: number, rgba: Uint8ClampedArray) {
    this.cy = new Float32Array(w); this.top = new Float32Array(w); this.bot = new Float32Array(w);
    const has = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let s = 0, sy = 0, t = -1, b = -1;
      for (let y = 0; y < h; y++) { const a = rgba[(y * w + x) * 4 + 3]; if (a > 40) { s += a; sy += a * y; if (t < 0) t = y; b = y; } }
      if (s > 0) { this.cy[x] = sy / s; this.top[x] = t; this.bot[x] = b + 1; has[x] = 1; }
    }
    // fill empty columns from the nearest filled one
    let last = -1;
    for (let x = 0; x < w; x++) if (has[x]) { if (last < 0) for (let k = 0; k < x; k++) this.copy(k, x); last = x; } else if (last >= 0) this.copy(x, last);
    if (last < 0) for (let x = 0; x < w; x++) { this.cy[x] = h / 2; this.top[x] = 0; this.bot[x] = h; }
  }
  private copy(d: number, s: number) { this.cy[d] = this.cy[s]; this.top[d] = this.top[s]; this.bot[d] = this.bot[s]; }
  private at(a: Float32Array, x: number) { const i = Math.max(0, Math.min(a.length - 1, Math.round(x - this.x0))); return a[i] + this.y0; }
  center(x: number) { return this.at(this.cy, x); }
  topAt(x: number) { return this.at(this.top, x); }
  botAt(x: number) { return this.at(this.bot, x); }
}

// ------------------------------------------------------------------ the rig
/** (Re)build the auto rig on a document: deformers, parameters, auto keyforms, masks, physics, expressions. */
export function applyAutoRig(doc: EdDoc, textures: EdTexture[], o: AutoRigOpts = {}) {
  // (an imported model keeps its own rig: the auto-rig would replace its deformers and keyforms; see adopt.ts)
  if (doc.imported) return;
  const turn = Math.max(0.2, Math.min(1.5, o.turn ?? doc.extras?.turn ?? 0.6));
  (doc.extras ??= {}).turn = turn;
  const useBones = o.bones ?? doc.extras?.useBones ?? true;
  doc.extras = { ...(doc.extras ?? {}), useBones };
  // parameters (keep any the user added)
  for (const [id, name, min, max, def, group] of STD_PARAMS) if (!doc.params.some((p) => p.id === id)) doc.params.push({ id, name, min, max, def, group } satisfies EdParam);
  // forget the old auto forms
  for (const m of doc.meshes) m.forms = m.forms.filter((f) => !f.auto);
  for (const f of doc.deformers) f.forms = f.forms.filter((x) => !x.auto);
  const box = (m: EdMesh): Box => { const t = doc.textures[m.tex]; return { x: t.x, y: t.y, w: t.w, h: t.h }; };
  const prof = new Map<string, Profile>();
  const profile = (m: EdMesh) => { let p = prof.get(m.id); if (!p) { const t = doc.textures[m.tex], tx = textures[m.tex]; p = new Profile(t.x, t.y, t.w, t.h, tx.rgba); prof.set(m.id, p); } return p; };

  const rigGroup = (G: EdMesh[], first: boolean, center: number, switchKeys: number[] = []) => {
  // ---- landmarks
  const { F, HC, HR } = landmarksOf(doc, G);
  const by = (r: Role, s?: Side | null) => G.filter((m) => m.role === r && (s === undefined || m.side === s));
  const neckM = by('neck')[0];
  const pivotHead: [number, number] = neckM ? [box(neckM).x + box(neckM).w / 2, Math.min(F.y + F.h * 0.92, box(neckM).y + box(neckM).h * 0.35)] : [HC[0], F.y + F.h * 0.92];
  const bodyMs = G.filter((m) => !isHead(m));
  // head + body painted as one blob (the head layer's sides run on into the body's): the turn fades out toward the
  // join, so the far side never shows the body's edge beside the head's (a ghost outline)
  const join = blobJoin(doc, textures, G.filter((m) => m.role === 'face'), bodyMs.filter((m) => m.role !== 'ignore'), F);
  const B = unionBox(by('body').map(box)) ?? unionBox(bodyMs.map(box)) ?? { x: F.x - F.w * 0.4, y: F.y + F.h, w: F.w * 1.8, h: doc.canvas.h - F.y - F.h };
  const pivotBody: [number, number] = [B.x + B.w / 2, Math.min(doc.canvas.h, B.y + B.h)];

  // ---- deformers: body tilt → head tilt
  const body = ensureRot(doc, 'Body', 'Body tilt', null, pivotBody, first);
  const head = ensureRot(doc, 'Head', 'Head tilt', body.id, pivotHead, first);
  for (const m of G) {
    if (m.deformer && m.deformer !== body.id && m.deformer !== head.id) continue; // the user put it elsewhere
    m.deformer = isHead(m) ? head.id : body.id;
  }
  // a form the user edited by hand (same parameters) wins over the auto one
  const auto = (t: { forms: EdForm[] }, axes: [string, number[]][], values: (EdValue | null)[]) => {
    if (t.forms.some((f) => !f.auto && f.axes.length === axes.length && f.axes.every((a, i) => a.param === axes[i][0]))) return;
    t.forms.push({ axes: axes.map(([param, keys]) => ({ param, keys })), values, auto: true });
  };
  const sym = [-1, 0, 1];

  // head tilt (+AngleZ = counter-clockwise on screen = negative deformer angle), body tilt, head follows the body
  if (first) {
  auto(head, [['ParamAngleZ', [-30, 0, 30]]], [{ a: 30 * 0.55 }, null, { a: -30 * 0.55 }]);
  auto(body, [['ParamBodyAngleZ', [-10, 0, 10]]], [{ a: 10 * 0.45 }, null, { a: -10 * 0.45 }]);
  const byaw = (deg: number) => Math.sin(deg * 0.8 * Math.PI / 180) * B.w * 0.42;
  auto(head, [['ParamBodyAngleX', [-10, 0, 10]]], [{ ox: byaw(-10) }, null, { ox: byaw(10) }]);
  auto(head, [['ParamBodyAngleY', [-10, 0, 10]]], [{ oy: B.h * 0.012 }, null, { oy: -B.h * 0.012 }]);
  auto(head, [['ParamBreath', [0, 1]]], [null, { oy: -B.h * 0.006 }]);
  // talking: the head lifts a touch and the brows rise a little with the voice (livelier speech)
  auto(head, [['ParamVoice', [0, 1]]], [null, { oy: -F.h * 0.008, a: 0 }]);
  }

  // ---- every mesh
  const eyeInfo = new Map<Side, ReturnType<typeof eyeGeometry>>();
  for (const s of ['L', 'R'] as const) eyeInfo.set(s, eyeGeometry(G, s, box, profile));
  const mouthInfo = mouthGeometry(doc, G, textures, box, profile);

  for (const m of G.slice()) {
    const n = m.mesh.pos.length / 2, P = m.mesh.pos;
    const D = () => new Array(n * 2).fill(0) as number[];
    const map = (f: (x: number, y: number) => [number, number]): EdValue | null => {
      const d = D(); let any = false;
      for (let i = 0; i < n; i++) { const [nx, ny] = f(P[i * 2], P[i * 2 + 1]); d[i * 2] = nx - P[i * 2]; d[i * 2 + 1] = ny - P[i * 2 + 1]; if (Math.abs(d[i * 2]) > 1e-4 || Math.abs(d[i * 2 + 1]) > 1e-4) any = true; }
      return any ? { d } : null;
    };
    if (isHead(m)) {
      // 2.5D head turn × nod: project on the head ellipsoid + depth
      const vals: (EdValue | null)[] = [];
      // a view drawn at another angle rests at its own angle (`center`)
      // keys: the ends, the drawing's own angle, and ±3° around each switch to a neighbouring angle (so this drawing is
      // still turning, accurately, while the hand-over happens)
      const xs = [...new Set([-30, center, 30, ...switchKeys])].sort((a, b) => a - b);
      for (const ay of [-30, 0, 30]) for (const ax of xs) {
        if (ax === center && !ay) { vals.push(null); continue; }
        const th = (ax - center) * turn * Math.PI / 180, ph = ay * turn * 0.8 * Math.PI / 180;
        const pin = join && !NO_PIN.has(m.role) ? join.pin : null;
        vals.push(map((x, y) => {
          const [nx, ny] = headTurn(x, y, HC, HR, m.depth, th, ph, m.role !== 'hairBack' && m.role !== 'ear', true);
          if (!pin) return [nx, ny];
          const k = pin(y);
          return [x + (nx - x) * k, y + (ny - y) * k];
        }));
      }
      auto(m, [['ParamAngleX', xs], ['ParamAngleY', [-30, 0, 30]]], vals);
      // the far ear hides as the head turns away from it
      if (m.role === 'ear' && m.side && !center) auto(m, [['ParamAngleX', [-30, 0, 30]]], m.side === 'L' ? [{ o: 1 }, null, { o: 0.15 }] : [{ o: 0.15 }, null, { o: 1 }]);
    } else {
      // body turn (gentler, on the torso's own ellipsoid), lean, breathing
      const BC: [number, number] = [B.x + B.w / 2, B.y + B.h * 0.35], BR: [number, number] = [B.w / 2, B.h * 0.6];
      auto(m, [['ParamBodyAngleX', [-10, 0, 10]]], [-10, 0, 10].map((deg) => (deg ? map((x, y) => headTurn(x, y, BC, BR, m.depth * 0.5, deg * 0.8 * Math.PI / 180, 0)) : null)));
      const lean = (v: number) => map((x, y) => [x, y - v * B.h * 0.012 * Math.max(0, 1 - (y - B.y) / B.h)]);
      auto(m, [['ParamBodyAngleY', [-10, 0, 10]]], [lean(-1), null, lean(1)]);
      const breath = map((x, y) => {
        const w = Math.max(0, Math.min(1, 1 - (y - B.y) / (B.h * 0.8)));
        const out = m.role === 'arm' || m.role === 'hand' ? Math.sign(x - pivotBody[0]) * B.w * 0.004 : 0;
        return [x + out * w, y - B.h * 0.008 * w];
      });
      auto(m, [['ParamBreath', [0, 1]]], [null, breath]);
      // the body's art under a blob head turns with the head (the same turn, faded the same way at the join)
      if (join && m.role !== 'ignore' && m.mesh.pos.some((v, i) => i % 2 === 1 && v < join.cut)) {
        const fd = G.find((x) => x.role === 'face')?.depth ?? 0;
        const xs = [...new Set([-30, center, 30, ...switchKeys])].sort((a, b) => a - b), vals: (EdValue | null)[] = [];
        for (const ay of [-30, 0, 30]) for (const ax of xs) {
          if (ax === center && !ay) { vals.push(null); continue; }
          const th = (ax - center) * turn * Math.PI / 180, ph = ay * turn * 0.8 * Math.PI / 180;
          vals.push(map((x, y) => {
            const k = join.under(x, y) * join.pin(y);
            if (!k) return [x, y];
            const [nx, ny] = headTurn(x, y, HC, HR, fd, th, ph, true, true);
            return [x + (nx - x) * k, y + (ny - y) * k];
          }));
        }
        if (vals.some(Boolean)) auto(m, [['ParamAngleX', xs], ['ParamAngleY', [-30, 0, 30]]], vals);
      }
    }
    // role keyforms
    const side = m.side;
    const E = side ? eyeInfo.get(side) : undefined;
    const pre = side === 'R' ? 'R' : 'L';
    switch (m.role) {
      case 'eyeWhite': case 'iris': case 'highlight': case 'lashUpper': case 'lashLower': case 'eyeWhole': case 'eyeClosed': {
        if (!E) break;
        const hasClosed = by('eyeClosed', side).length > 0;
        const closeAt = (c: number) => (c <= 0 ? null : map((x, y) => eyeClose(m.role, x, y, c, E)));
        if (m.role === 'eyeClosed') auto(m, [[`ParamEye${pre}Open`, [0, 0.25, 1]]], [{ o: 1 }, { o: 0 }, { o: 0 }]);
        else if (hasClosed) {
          const v0 = closeAt(1), v1 = closeAt(0.75);
          auto(m, [[`ParamEye${pre}Open`, [0, 0.25, 1]]], [{ ...(v0 ?? {}), o: 0 }, v1, null]);
        } else auto(m, [[`ParamEye${pre}Open`, [0, 1]]], [closeAt(1), null]);
        if (m.role !== 'eyeClosed') auto(m, [[`ParamEye${pre}Smile`, [0, 1]]], [null, map((x, y) => eyeSmile(m.role, x, y, E))]);
        if (m.role === 'iris' || m.role === 'highlight') {
          const k = m.role === 'highlight' ? 0.8 : 1;
          auto(m, [['ParamEyeBallX', sym]], sym.map((v) => (v ? { d: shift(n, v * E.gx * k, 0) } : null)));
          auto(m, [['ParamEyeBallY', sym]], sym.map((v) => (v ? { d: shift(n, 0, -v * E.gy * k) } : null)));
          const white = by('eyeWhite', side)[0] ?? by('eyeWhole', side)[0];
          if (white && !m.masks.length) m.masks = [white.id];
        }
        break;
      }
      case 'brow': {
        const b = box(m), cx = b.x + b.w / 2, faceDir = Math.sign(HC[0] - cx) || 1;
        auto(m, [[`ParamBrow${pre}Y`, sym]], sym.map((v) => (v ? { d: shift(n, 0, -v * F!.h * 0.06) } : null)));
        auto(m, [['ParamVoice', [0, 1]]], [null, { d: shift(n, 0, -F!.h * 0.012) }]);
        // shape: + = inner end up (worried / surprised), − = inner end down (angry)
        auto(m, [[`ParamBrow${pre}Form`, sym]], sym.map((v) => (v ? map((x, y) => { const tin = ((x - cx) / (b.w / 2)) * faceDir; return [x, y - v * b.w * 0.14 * tin - v * b.w * 0.03]; }) : null)));
        break;
      }
      case 'mouthUpper': case 'mouthLower': case 'mouthInner': case 'teeth': case 'tongue': case 'mouth': case 'mouthOpening': {
        if (!mouthInfo) break;
        const M = mouthInfo;
        if (M.closed && m.role !== 'mouthOpening') auto(m, [['ParamMouthOpenY', [0, 1]]], [null, map((x, y) => mouthOpen(m, x, y, M))]);
        else auto(m, [['ParamMouthOpenY', [0, 1]]], [map((x, y) => mouthClose(m.role, x, y, M)), null]);
        auto(m, [['ParamMouthForm', sym]], sym.map((v) => (v ? map((x, y) => { const t = Math.max(-1.2, Math.min(1.2, (x - M.cx) / (M.w / 2))); return [x, y - v * M.w * 0.11 * (t * t - 0.3)]; }) : null)));
        // the five mouth shapes (A I U E O), each one on top of Open + Form
        for (const s of VOWEL_SHAPES) auto(m, [[s.param, [0, 1]]], [null, map((x, y) => mouthVowel(m, x, y, M, s))]);
        {
          // clip the inside / teeth / tongue: to the lip opening when there is one, else (teeth, tongue) to the inside
          const opening = by('mouthOpening')[0], inner = by('mouthInner')[0];
          const auto0 = !m.masks.length || (m.masks.length === 1 && (m.masks[0] === inner?.id || m.masks[0] === opening?.id));
          if (auto0 && (m.role === 'mouthInner' || m.role === 'teeth' || m.role === 'tongue')) {
            if (opening && m.role !== 'mouthInner' || opening && m.role === 'mouthInner' && !m.generated) m.masks = [opening.id];
            else if (m.role !== 'mouthInner' && inner) m.masks = [inner.id];
          }
        }
        break;
      }
      case 'blush':
        auto(m, [['ParamCheek', [0, 1]]], [{ o: 0 }, null]);
        break;
      case 'hairFront': case 'hairSide': case 'hairBack': case 'ahoge': {
        if (useBones && m.role !== 'hairFront') break; // bones + chain physics (extras.ts)
        const b = box(m);
        const param = m.role === 'hairFront' ? 'ParamHairFront' : m.role === 'hairSide' ? 'ParamHairSide' : m.role === 'hairBack' ? 'ParamHairBack' : 'ParamHairAhoge';
        const up = m.role === 'ahoge';
        const root = up ? b.y + b.h : m.role === 'hairBack' ? Math.max(b.y, HC[1] - HR[1] * 0.4) : b.y + b.h * 0.08;
        const len = Math.max(10, up ? b.h : b.y + b.h - root);
        const amp = m.role === 'hairFront' ? F.w * 0.05 : m.role === 'ahoge' ? b.h * 0.35 : Math.min(F.w * 0.14, len * 0.16);
        auto(m, [[param, sym]], sym.map((v) => (v ? map((x, y) => {
          const t = Math.max(0, Math.min(1, (up ? root - y : y - root) / len));
          const w = Math.pow(t, 1.6);
          return [x + v * amp * w, y - Math.abs(v) * amp * 0.15 * w * w * (up ? -1 : 1)];
        }) : null)));
        break;
      }
    }
  }

    return { F, HC, HR };
  };
  // one rig per angle view (a PSD with Front / 3-4 / Side folders), the shared layers (body …) with the front one
  const viewOf = (m: EdMesh) => m.view ?? null;
  const sets = doc.extras?.views?.sets ?? [];
  const frontId = sets.length ? (sets.find((v) => v.at === 0)?.id ?? sets[0].id) : null;
  const sorted = sets.slice().sort((a, b) => a.at - b.at);
  const switchKeysOf = (id: string | null) => {
    const i = sorted.findIndex((v) => v.id === id);
    if (i < 0) return [];
    const mids = [i > 0 ? (sorted[i - 1].at + sorted[i].at) / 2 : null, i + 1 < sorted.length ? (sorted[i].at + sorted[i + 1].at) / 2 : null].filter((x): x is number => x !== null);
    return mids.flatMap((m) => [m - 3, m + 3]).map((k) => Math.round(k * 100) / 100).filter((k) => k > -30 && k < 30);
  };
  const L0 = rigGroup(doc.meshes.filter((m) => !sets.length || viewOf(m) === null || viewOf(m) === frontId), true, 0, switchKeysOf(frontId));
  for (const v of sets) if (v.id !== frontId) rigGroup(doc.meshes.filter((m) => viewOf(m) === v.id), false, v.at, switchKeysOf(v.id));
  const { F, HC, HR } = L0;
  const by = (r: Role, s?: Side | null) => doc.meshes.filter((m) => m.role === r && (s === undefined || m.side === s));

  // ---- physics: one pendulum per hair kind present
  const physFor: [Role, string, string, number, number][] = [['hairFront', 'ParamHairFront', 'Front hair', 0.6, 0.55], ['hairSide', 'ParamHairSide', 'Side hair', 1, 0.4], ['hairBack', 'ParamHairBack', 'Back hair', 1.2, 0.35], ['ahoge', 'ParamHairAhoge', 'Ahoge', 0.5, 0.25]];
  doc.physics = doc.physics.filter((p) => !p.id.startsWith('auto_'));
  for (const [role, out, name, lenK, damp] of physFor) {
    if (!by(role).length || (useBones && role !== 'hairFront')) continue;
    doc.physics.push({
      id: `auto_${role}`, name, output: out, length: F.h * lenK, damping: damp, maxAngle: 25, gain: role === 'ahoge' ? 1.4 : 1,
      inputs: [{ param: 'ParamAngleX', weight: 0.6, type: 'x' }, { param: 'ParamAngleZ', weight: -0.6, type: 'angle' }, { param: 'ParamBodyAngleX', weight: 0.4, type: 'x' }, { param: 'ParamBodyAngleZ', weight: -0.3, type: 'angle' }],
    });
  }
  // ---- expressions (only when the user has none)
  if (!doc.expressions.length) {
    doc.expressions = [
      { id: 'happy', name: 'Happy', params: [{ param: 'ParamMouthForm', value: 1, blend: 'overwrite' }, { param: 'ParamEyeLSmile', value: 0.6, blend: 'overwrite' }, { param: 'ParamEyeRSmile', value: 0.6, blend: 'overwrite' }, { param: 'ParamCheek', value: 0.6, blend: 'add' }] },
      { id: 'surprised', name: 'Surprised', params: [{ param: 'ParamBrowLY', value: 1, blend: 'overwrite' }, { param: 'ParamBrowRY', value: 1, blend: 'overwrite' }, { param: 'ParamBrowLForm', value: 0.6, blend: 'overwrite' }, { param: 'ParamBrowRForm', value: 0.6, blend: 'overwrite' }, { param: 'ParamMouthOpenY', value: 0.5, blend: 'add' }] },
      { id: 'angry', name: 'Angry', params: [{ param: 'ParamBrowLForm', value: -1, blend: 'overwrite' }, { param: 'ParamBrowRForm', value: -1, blend: 'overwrite' }, { param: 'ParamBrowLY', value: -0.5, blend: 'overwrite' }, { param: 'ParamBrowRY', value: -0.5, blend: 'overwrite' }, { param: 'ParamMouthForm', value: -0.7, blend: 'overwrite' }] },
      { id: 'sad', name: 'Sad', params: [{ param: 'ParamBrowLForm', value: 1, blend: 'overwrite' }, { param: 'ParamBrowRForm', value: 1, blend: 'overwrite' }, { param: 'ParamMouthForm', value: -0.6, blend: 'overwrite' }, { param: 'ParamEyeLOpen', value: 0.75, blend: 'multiply' }, { param: 'ParamEyeROpen', value: 0.75, blend: 'multiply' }] },
      { id: 'blush', name: 'Blush', params: [{ param: 'ParamCheek', value: 1, blend: 'overwrite' }] },
      { id: 'wink', name: 'Wink', params: [{ param: 'ParamEyeLOpen', value: 0, blend: 'overwrite' }, { param: 'ParamEyeRSmile', value: 0.5, blend: 'overwrite' }, { param: 'ParamMouthForm', value: 0.8, blend: 'overwrite' }] },
    ];
  }
  // ---- beyond Live2D: folders, bones + chain physics, lighting maps, moods, effects, outfits
  applyExtras(doc, textures, { F, HC, HR });
  // hair on bones swings by its bones (and each part's own "… swing" amount): the keyform-swing sliders for side / back
  // hair and the ahoge would move nothing, so they go (unless something of the user's still uses one)
  if (useBones) doc.params = doc.params.filter((p) => !BONE_HAIR_PARAMS.has(p.id) || paramInUse(doc, p.id));
  // ---- report
  const notes = (doc.report?.notes ?? []).filter((s) => !s.startsWith('Auto-rig:'));
  const roleCount = new Map<string, number>();
  for (const m of doc.meshes) if (m.role !== 'unknown') roleCount.set(ROLE_LABEL[m.role], (roleCount.get(ROLE_LABEL[m.role]) ?? 0) + 1);
  notes.unshift(`Auto-rig: ${doc.meshes.filter((m) => m.role !== 'unknown').length} of ${doc.meshes.length} layers rigged; ${doc.meshes.reduce((s, m) => s + m.mesh.pos.length / 2, 0)} vertices; ${doc.physics.length} physics strands; ${doc.expressions.length} expressions.`);
  doc.report = { understood: doc.meshes.map((m) => ({ name: m.name, role: m.role, side: m.side, why: doc.report?.understood.find((u) => u.name === m.name)?.why ?? '' })), notes };
}

/** Head parts that keep their full turn at a blob join (they hang free beside it). */
const NO_PIN = new Set<Role>(['hairBack', 'hairSide', 'hairFront', 'ahoge', 'ear', 'headAcc']);

/** Head and body drawn as one blob: the face layer's bottom is cut straight across on top of the body, and in its
 *  lowest rows its left and right edges are the body's edges (a normal chin sits over a narrower neck: its jaw edges
 *  are outside it). Then the head turn fades out toward the cut (`pin`: 0 at the cut, 1 a quarter of the face up,
 *  smooth), and the body's art under the head turns with it (`under`: 1 inside the face's outline above the cut,
 *  fading out beside it), so neither the join nor the body's own edge under the head ever shows beside the turned head
 *  (a ghost outline on the far side). null = no such join. */
export function blobJoin(doc: EdDoc, textures: readonly EdTexture[], faces: readonly EdMesh[], bodies: readonly EdMesh[], F: Box):
  { cut: number; pin: (y: number) => number; under: (x: number, y: number) => number } | null {
  if (!faces.length || !bodies.length) return null;
  const face = faces.slice().sort((a, b) => doc.textures[b.tex].w * doc.textures[b.tex].h - doc.textures[a.tex].w * doc.textures[a.tex].h)[0];
  const ft = doc.textures[face.tex], fr = textures[face.tex];
  if (!fr) return null;
  // row extents of opaque pixels (canvas x), for one mesh's texture
  const extent = (t: { x: number; y: number; w: number; h: number }, rgba: Uint8ClampedArray, y: number): [number, number] | null => {
    const ry = Math.round(y - t.y);
    if (ry < 0 || ry >= t.h) return null;
    let a = -1, b = -1;
    for (let x = 0; x < t.w; x++) if (rgba[(ry * t.w + x) * 4 + 3] > 128) { if (a < 0) a = x; b = x; }
    return a < 0 ? null : [t.x + a, t.x + b];
  };
  const bodyExtent = (y: number) => {
    let r: [number, number] | null = null;
    for (const m of bodies) { const t = doc.textures[m.tex], e = textures[m.tex] ? extent(t, textures[m.tex].rgba, y) : null; if (e) r = r ? [Math.min(r[0], e[0]), Math.max(r[1], e[1])] : e; }
    return r;
  };
  let bottom = -1;
  for (let y = ft.y + ft.h - 1; y >= ft.y; y--) if (extent(ft, fr.rgba, y)) { bottom = y; break; }
  if (bottom < 0) return null;
  const tol = Math.max(4, F.w * 0.03);
  let top = bottom, misses = 0;
  for (let y = bottom; y > bottom - F.h * 0.35; y--) {
    const fe = extent(ft, fr.rgba, y), be = bodyExtent(y);
    const joins = !!fe && !!be && Math.abs(fe[0] - be[0]) <= tol && Math.abs(fe[1] - be[1]) <= tol && fe[1] - fe[0] > F.w * 0.25;
    if (joins) { top = y; misses = 0; } else if (++misses > 3) break;
  }
  if (bottom - top < Math.max(6, F.h * 0.04)) return null;
  const ramp = Math.max(8, F.h * 0.25);
  const pin = (y: number) => { const t = Math.max(0, Math.min(1, (bottom - y) / ramp)); return t * t * (3 - 2 * t); };
  // the face's outline per row (canvas px), for the body's art under it
  const rows = new Map<number, [number, number] | null>();
  const faceRow = (y: number) => { const k = Math.round(y); if (!rows.has(k)) rows.set(k, extent(ft, fr.rgba, k)); return rows.get(k)!; };
  const under = (x: number, y: number) => {
    if (y >= bottom) return 0;
    let e: [number, number] | null = null;
    for (let d = 0; d <= 6 && !e; d += 2) e = faceRow(y + d) ?? faceRow(y - d);   // (mesh vertices sit up to a few px off the art)
    if (!e) return 0;
    const out = Math.max(0, e[0] - x, x - e[1]);
    return out <= tol ? 1 : Math.max(0, 1 - (out - tol) / (2 * tol));
  };
  return { cut: bottom, pin, under };
}

/** The face box, head centre and head radii the head turn is built on. */
export function landmarksOf(doc: EdDoc, meshes: EdMesh[]): Landmarks {
  const box = (m: EdMesh): Box => { const t = doc.textures[m.tex]; return { x: t.x, y: t.y, w: t.w, h: t.h }; };
  const faceM = meshes.filter((m) => m.role === 'face').sort((a, b) => box(b).w * box(b).h - box(a).w * box(a).h)[0];
  let F: Box | null = faceM ? box(faceM) : null;
  if (!F) {
    const feat = unionBox(meshes.filter((m) => ['eyeWhite', 'iris', 'eyeWhole', 'lashUpper', 'mouth', 'mouthUpper', 'mouthInner'].includes(m.role)).map(box));
    F = feat ? { x: feat.x - feat.w * 0.25, y: feat.y - feat.h * 0.6, w: feat.w * 1.5, h: feat.h * 2.0 } : { x: doc.canvas.w * 0.3, y: doc.canvas.h * 0.15, w: doc.canvas.w * 0.4, h: doc.canvas.h * 0.35 };
  }
  return { F, HC: [F.x + F.w / 2, F.y + F.h * 0.46], HR: [F.w / 2, F.h * 0.52] };
}

function isHead(m: EdMesh): boolean {
  if (m.role === 'ignore') return false;
  if (m.role === 'unknown') return m.rides !== 'body';
  return HEAD_ROLES.has(m.role);
}

function ensureRot(doc: EdDoc, id: string, name: string, parent: string | null, origin: [number, number], setOrigin = true): EdDeformer {
  let f = doc.deformers.find((x) => x.id === id);
  if (!f) { f = { id, name, kind: 'rotation', parent, origin, forms: [] }; doc.deformers.push(f); }
  else { if (setOrigin) f.origin = origin; if (f.parent === null && parent) f.parent = parent; }
  return f;
}

/** The keyform-swing parameters bone hair replaces. */
const BONE_HAIR_PARAMS = new Set(['ParamHairSide', 'ParamHairBack', 'ParamHairAhoge']);
/** Does anything in the document read or move this parameter (forms, physics, dynamics, expressions, extras)? */
export function paramInUse(doc: EdDoc, id: string): boolean {
  const inForms = (fs: { axes: { param: string }[] }[]) => fs.some((f) => f.axes.some((a) => a.param === id));
  if (doc.meshes.some((m) => inForms(m.forms)) || doc.deformers.some((f) => inForms(f.forms)) || (doc.extras?.bones ?? []).some((b) => inForms(b.forms))) return true;
  if (doc.physics.some((p) => p.output === id || p.chain?.includes(id) || p.inputs.some((i) => i.param === id))) return true;
  if (doc.expressions.some((e) => e.params.some((q) => q.param === id))) return true;
  const { bones: _b, ...rest } = doc.extras ?? {};
  void _b;
  return JSON.stringify(rest).includes(JSON.stringify(id));
}

/** 1 from the forehead down, easing to 0 at the crown (dy in head radii, −1 = the top of the head's ellipse). */
export function crownFade(dy: number): number { const t = Math.max(0, Math.min(1, (dy + CROWN_TOP) / (CROWN_TOP - CROWN_FULL))); return t * t * (3 - 2 * t); }
const CROWN_TOP = 1.15, CROWN_FULL = 0.55;

const shift = (n: number, dx: number, dy: number) => { const d: number[] = []; for (let i = 0; i < n; i++) d.push(dx, dy); return d; };

/** A point on / around the head ellipsoid turned by yaw th (+ = toward the viewer's right) and nod ph (+ = up).
 *  `crown`: the top of the head is its outline, which a turning head keeps where it is (the outline of a ball never
 *  moves as it turns): above the forehead every layer's depth (and the dome) fades to nothing at the crown, so on a
 *  nod or a turn the front hair, the back hair, the scalp and an ahoge on top all stay together there instead of the
 *  fringe's parallax sliding the whole front hair off the head (and the back hair's top showing above it). */
export function headTurn(x: number, y: number, C: [number, number], R: [number, number], depth: number, th: number, ph: number, dome = true, crown = false): [number, number] {
  const dx = (x - C[0]) / R[0], dy = (y - C[1]) / R[1];
  // a smooth dome: 1 at the centre, 0 at 1.25 radii and beyond (no infinite slope at the rim, so the mesh never
  // tears where the face's outline meets the hair / ears)
  const r = Math.sqrt(dx * dx + dy * dy);
  const z0 = dome && r < 1.25 ? Math.cos((r / 1.25) * Math.PI / 2) : 0;
  const z = (z0 + depth) * (crown ? crownFade(dy) : 1);
  const ct = Math.cos(th), st = Math.sin(th);
  const x1 = dx * ct + z * st, z1 = -dx * st + z * ct;
  const cp = Math.cos(ph), sp = Math.sin(ph);
  const y1 = dy * cp - z1 * sp;
  return [C[0] + x1 * R[0], C[1] + y1 * R[1]];
}

// ---- eyes
function eyeGeometry(G: EdMesh[], s: Side, box: (m: EdMesh) => Box, profile: (m: EdMesh) => Profile) {
  const pick = (r: Role) => G.find((m) => m.role === r && m.side === s);
  const white = pick('eyeWhite') ?? pick('eyeWhole') ?? pick('iris');
  if (!white) return undefined;
  const W = box(white), pw = profile(white);
  // the eye's real top / bottom from the white's pixels (texture boxes have padding)
  let top = Infinity, bot = -Infinity;
  for (let x = W.x; x < W.x + W.w; x += 1) { top = Math.min(top, pw.topAt(x)); bot = Math.max(bot, pw.botAt(x)); }
  const h = Math.max(4, bot - top), cx = W.x + W.w / 2;
  const iris = pick('iris');
  const I = iris ? box(iris) : null;
  const lash = pick('lashUpper'), lower = pick('lashLower');
  return {
    cx, top, bot, h, w: W.w,
    /** The closed-eye line: 62 % down the eye, bowing down a little in the middle. */
    closeY: (x: number) => { const t = Math.max(-1, Math.min(1, (x - cx) / (W.w / 2))); return top + h * 0.62 + h * 0.07 * (1 - t * t); },
    lash: lash ? profile(lash) : null,
    lower: lower ? profile(lower) : null,
    white: pw,
    gx: I ? Math.max(W.w * 0.08, (W.w - I.w) / 2 * 0.85 + I.w * 0.1) : W.w * 0.2,
    gy: I ? Math.max(h * 0.06, (h - I.h) / 2 * 0.8 + I.h * 0.08) : h * 0.12,
  };
}

/** Where a vertex of an eye part goes when the eye is closed by `c` (0 … 1). */
function eyeClose(role: Role, x: number, y: number, c: number, E: NonNullable<ReturnType<typeof eyeGeometry>>): [number, number] {
  const L = E.closeY(x);
  let ny = y;
  if (role === 'lashUpper') {
    const yc = E.lash ? E.lash.center(x) : E.top;
    ny = L + (y - yc) * 0.8 - E.h * 0.02;
  } else if (role === 'lashLower') {
    const yc = E.lower ? E.lower.center(x) : E.bot;
    ny = y + (L + E.h * 0.06 - yc) * 0.45;
  } else if (role === 'eyeWhole') ny = L + (y - E.white.center(x)) * 0.12;
  else ny = L + (y - L) * 0.05; // white / iris / highlight collapse onto the line (the iris is clipped by the white)
  return [x, y + (ny - y) * c];
}

/** Eye smile: the lower half rises into an arch. */
function eyeSmile(role: Role, x: number, y: number, E: NonNullable<ReturnType<typeof eyeGeometry>>): [number, number] {
  const mid = E.top + E.h * 0.45;
  const t = Math.max(-1, Math.min(1, (x - E.cx) / (E.w / 2)));
  const arch = E.top + E.h * 0.72 - E.h * 0.14 * (1 - t * t);
  if (role === 'lashUpper') return [x, y + E.h * 0.06];
  if (role === 'lashLower') { const yc = E.lower ? E.lower.center(x) : E.bot; return [x, y + (arch - yc)]; }
  if (y <= mid) return [x, y];
  // squeeze the part below the middle up to the arch
  const lim = Math.max(mid + 1, arch);
  const k = (lim - mid) / Math.max(1, E.bot - mid);
  return [x, mid + (y - mid) * k];
}

// ---- mouth
function mouthGeometry(doc: EdDoc, G: EdMesh[], textures: EdTexture[], box: (m: EdMesh) => Box, profile: (m: EdMesh) => Profile) {
  const pick = (r: Role) => G.find((m) => m.role === r);
  const upper = pick('mouthUpper') ?? pick('mouth');
  let inner = pick('mouthInner');
  const lower = pick('mouthLower');
  if (!upper && !inner && !lower) return null;
  if (!inner && upper) { inner = paintInnerMouth(doc, textures, upper, box(upper), profile(upper)); G.push(inner); }
  // a drawn inside of the mouth is usually bigger than the lips (artists paint it oversized): clip it, the teeth and
  // the tongue to the lip opening, as a Live2D artist would
  const upperLip = pick('mouthUpper');
  const all = [upper, inner, lower].filter(Boolean) as EdMesh[];
  const M = unionBox(all.map(box))!;
  const up = upper ? profile(upper) : null, inn = inner ? profile(inner) : null, lo = lower ? profile(lower) : null;
  // Drawn closed? Lips that touch in the middle (the inside painted underneath, hidden): then the rig OPENS the mouth
  // from the drawing (lower lip down, upper lip up a little) instead of closing a drawn-open one.
  let closed: { H: number; meet: (x: number) => number } | null = null;
  if (upperLip && lower && up && lo && inner && !inner.generated) {
    const ub = box(upperLip), lb = box(lower), mx = (Math.max(ub.x, lb.x) + Math.min(ub.x + ub.w, lb.x + lb.w)) / 2;
    let gap = 0, n = 0;
    for (let d = -0.15; d <= 0.15; d += 0.05) { const x = mx + d * ub.w; gap += lo.topAt(x) - up.botAt(x); n++; }
    gap /= n;
    if (gap <= Math.max(3, ub.w * 0.04)) {
      const ib = box(inner), W = Math.max(ub.w, lb.w);
      const meet = (x: number) => (up.botAt(x) + lo.topAt(x)) / 2;
      const H = Math.max(W * 0.15, Math.min(W * 0.3, ib.y + ib.h - meet(mx)));
      closed = { H, meet };
    }
  }
  if (upperLip && lower && inner && !inner.generated && !pick('mouthOpening')) { const op = paintMouthOpening(doc, textures, upperLip, lower, inner, closed); if (op) G.push(op); }
  const cx = M.x + M.w / 2;
  // the closed-mouth line: the upper lip's centre line, else the top of the inside
  const line = (x: number) => (up ? up.center(x) : inn ? inn.topAt(x) : M.y + M.h * 0.3);
  const uw = (upper ? box(upper) : M).w;
  const cornerY = up ? (up.center(cx - uw * 0.42) + up.center(cx + uw * 0.42)) / 2 : 0;
  return { cx, w: uw, cornerY, line, up, inn, lo, closed, innerTop: (x: number) => (inn ? inn.topAt(x) : line(x)), innerBot: (x: number) => (inn ? inn.botAt(x) : line(x)) };
}

/** A mouth shape of speech at full strength: `sx` = how much the mouth width changes (+ wider / − narrower, the corners
 *  move, the middle does not), `gape` = extra opening of the lower lip and everything under it (fraction of the mouth's
 *  width; − = a thinner mouth), `lift` = the upper lip rising (fraction of the width; − = pouting down). They add to
 *  Open and Form. Standard Japanese vowels (a i u e o), the same five a VRM rig has (aa ih ou ee oh). */
export const VOWEL_SHAPES: { param: string; key: 'A' | 'I' | 'U' | 'E' | 'O'; sx: number; gape: number; lift: number }[] = [
  { param: 'ParamMouthA', key: 'A', sx: -0.04, gape: 0.2, lift: 0.04 },
  { param: 'ParamMouthI', key: 'I', sx: 0.22, gape: -0.03, lift: 0 },
  { param: 'ParamMouthU', key: 'U', sx: -0.38, gape: 0.03, lift: -0.02 },
  { param: 'ParamMouthE', key: 'E', sx: 0.12, gape: 0.07, lift: 0.015 },
  { param: 'ParamMouthO', key: 'O', sx: -0.2, gape: 0.14, lift: 0.03 },
];
const smooth01 = (t: number) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };
/** Where a mouth part's vertex goes at full strength of one vowel shape (see VOWEL_SHAPES). */
export function mouthVowel(m: EdMesh, x: number, y: number, M: NonNullable<ReturnType<typeof mouthGeometry>>, s: typeof VOWEL_SHAPES[number]): [number, number] {
  const t = Math.max(-1.4, Math.min(1.4, (x - M.cx) / (M.w / 2)));
  const bow = Math.pow(Math.max(0, 1 - t * t), 0.7), arch = Math.max(0, 1 - t * t);
  // how much of the part is "lower mouth": the lower lip, the tongue and the lower teeth drop; the upper lip rises; the rest by where it sits
  const L = M.line(x);
  const lower = m.role === 'mouthLower' ? 1 : m.role === 'tongue' ? 0.8 : m.role === 'mouthUpper' || m.role === 'mouth' ? 0
    : m.role === 'teeth' ? (/bottom|lower|下/i.test(m.name) || (!/top|upper|上/i.test(m.name) && teethCentre(m) > M.line(M.cx)) ? 0.9 : 0)
    : smooth01((y - L) / Math.max(1, M.w * 0.08) * 0.5 + 0.5);
  return [M.cx + (x - M.cx) * (1 + s.sx), y + M.w * (s.gape * bow * lower - s.lift * arch * (1 - lower))];
}

const teethCentre = (m: EdMesh) => { let s = 0; for (let i = 1; i < m.mesh.pos.length; i += 2) s += m.mesh.pos[i]; return s / Math.max(1, m.mesh.pos.length / 2); };
/** A mouth drawn closed: where a part's vertex goes when it opens fully (lower lip, lower teeth and tongue down the
 *  most in the middle, the upper lip and upper teeth up a little; the corners stay). */
function mouthOpen(m: EdMesh, x: number, y: number, M: NonNullable<ReturnType<typeof mouthGeometry>>): [number, number] {
  const C = M.closed!;
  const t = Math.max(-1, Math.min(1, (x - M.cx) / (M.w / 2))), bow = Math.pow(Math.max(0, 1 - t * t), 0.7);
  const below = y > C.meet(x);
  void below;
  const down = C.H * bow, upLift = -C.H * 0.15 * (1 - t * t);
  switch (m.role) {
    case 'mouthLower': case 'tongue': return [x, y + down * (m.role === 'tongue' ? 0.75 : 1)];
    case 'mouthUpper': case 'mouth': return [x, y + upLift];
    case 'teeth': {
      // teeth move whole (no stretching): lower teeth with the lower lip, upper teeth with the upper lip
      const lowerTeeth = /bottom|lower|下/i.test(m.name) || (!/top|upper|上/i.test(m.name) && teethCentre(m) > C.meet(M.cx));
      return [x, y + (lowerTeeth ? C.H * 0.9 * bow : upLift)];
    }
    case 'mouthInner': return [x, y + Math.max(0, Math.min(1, (y - C.meet(x)) / Math.max(1, C.H))) * down * 0.5];
  }
  return [x, y];
}

/** Where a mouth part's vertex goes when the mouth is closed (the art is drawn open when it has an inside). */
function mouthClose(role: Role, x: number, y: number, M: NonNullable<ReturnType<typeof mouthGeometry>>): [number, number] {
  if (role === 'mouthOpening' && M.closed) { const L = M.closed.meet(x); return [x, L + (y - L) * 0.02]; }
  const L = M.line(x);
  const open = Math.max(0, M.innerBot(x) - Math.min(L, M.innerTop(x)));
  if (role === 'mouthUpper' || role === 'mouth') {
    // an open mouth's upper lip is drawn as an arch: closing relaxes it halfway toward a straight line
    if (!M.up) return [x, y];
    const t = Math.max(-1, Math.min(1, (x - M.cx) / (M.w / 2)));
    return [x, y + (M.cornerY - M.up.center(x)) * 0.5 * (1 - t * t)];
  }
  if (role === 'mouthLower') { const yc = M.lo ? M.lo.center(x) : y; const target = L + Math.max(2, M.w * 0.05); return [x, y + (target - yc)]; }
  // inside, teeth, tongue: squeezed onto the line (top-anchored, so teeth stay under the upper lip)
  void open;
  return [x, L + (y - L) * 0.06];
}

/** The opening between the lips (filled from the upper lip's centre line down to the lower lip's), invisible: it only
 *  clips the inside of the mouth, the teeth and the tongue. Its keyforms open / close / smile with the mouth. */
function paintMouthOpening(doc: EdDoc, textures: EdTexture[], up: EdMesh, lo: EdMesh, inner: EdMesh, closed: { H: number; meet: (x: number) => number } | null): EdMesh | null {
  const tu = doc.textures[up.tex], tl = doc.textures[lo.tex], U = textures[up.tex], Lo = textures[lo.tex];
  const col = (t: { x: number; y: number; w: number; h: number }, T: EdTexture, gx: number) => {
    const x = Math.round(gx - t.x);
    if (x < 0 || x >= T.w) return null;
    let s = 0, sy = 0;
    for (let y = 0; y < T.h; y++) { const a = T.rgba[(y * T.w + x) * 4 + 3]; if (a > 40) { s += a; sy += a * y; } }
    return s > 0 ? t.y + sy / s : null;
  };
  const x0 = Math.floor(Math.min(tu.x, tl.x)), x1 = Math.ceil(Math.max(tu.x + tu.w, tl.x + tl.w));
  const tops: (number | null)[] = [], bots: (number | null)[] = [];
  for (let x = x0; x < x1; x++) { tops.push(col(tu, U, x)); bots.push(col(tl, Lo, x)); }
  const have = tops.map((t, i) => t !== null || bots[i] !== null);
  const first = have.indexOf(true), last = have.lastIndexOf(true);
  if (first < 0 || last - first < 6) return null;
  // fill gaps: a column with only one lip takes the other lip's nearest line (so the corners pinch shut)
  const near = (arr: (number | null)[], i: number) => { for (let d = 0; d < arr.length; d++) { if (arr[i - d] != null) return arr[i - d]!; if (arr[i + d] != null) return arr[i + d]!; } return null; };
  const W = last - first + 1;
  let ymin = Infinity, ymax = -Infinity;
  const top: number[] = [], bot: number[] = [];
  for (let i = first; i <= last; i++) {
    const t = tops[i] ?? near(tops, i), b = bots[i] ?? near(bots, i);
    if (t === null || b === null) { top.push(0); bot.push(0); continue; }
    const k = (i - first) / Math.max(1, W - 1), taper = Math.min(1, Math.min(k, 1 - k) / 0.12);
    let tp: number, bt: number;
    if (closed) {
      // drawn closed: the shape the lips leave when fully open (the lip keyforms move them by the same amounts)
      const tt = k * 2 - 1, bow = Math.pow(Math.max(0, 1 - tt * tt), 0.7), mm = closed.meet(x0 + i);
      tp = mm - closed.H * 0.15 * (1 - tt * tt); bt = mm + closed.H * bow + 2;
      void t; void b;
    } else {
      const mid = (t + b) / 2, half = Math.max(0, b - t) / 2 * taper;
      tp = mid - half; bt = mid + half;
    }
    top.push(tp); bot.push(bt);
    ymin = Math.min(ymin, tp); ymax = Math.max(ymax, bt);
  }
  if (!(ymax - ymin > 2)) return null;
  const ox = x0 + first, oy = Math.floor(ymin) - 1, w = W, h = Math.ceil(ymax) - oy + 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    const gy = oy + y + 0.5, a = Math.max(0, Math.min(1, Math.min(gy - top[x], bot[x] - gy) + 0.5));
    if (a > 0) { const i = (y * w + x) * 4; rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = a * 255; }
  }
  const tex = textures.length;
  textures.push({ w, h, rgba });
  doc.textures.push({ name: 'mouth opening (made)', x: ox, y: oy, w, h });
  let id = 'mouth_opening';
  for (let k = 2; doc.meshes.some((m) => m.id === id); k++) id = `mouth_opening_${k}`;
  const m: EdMesh = {
    id, name: 'Mouth opening (made)', group: inner.group, role: 'mouthOpening', side: null, tex,
    mesh: autoMesh(rgba, w, h, ox, oy, { spacing: Math.max(3, Math.min(w, h) / 5) }),
    deformer: inner.deformer, z: inner.z - 1, opacity: 0, blend: 'normal', masks: [], visible: true, depth: inner.depth, forms: [], generated: true,
    ...(inner.part !== undefined ? { part: inner.part } : {}), ...(inner.view !== undefined ? { view: inner.view } : {}),
  };
  doc.meshes.splice(doc.meshes.indexOf(inner), 0, m);
  doc.report?.notes.push('The inside of the mouth is clipped to the opening between the lips, so it never shows outside them.');
  return m;
}

/** The art has a mouth line but no inside: paint one (dark, a tongue at the bottom) under the line, drawn OPEN; the
 *  mouth-open keyform closes it. */
function paintInnerMouth(doc: EdDoc, textures: EdTexture[], upper: EdMesh, U: Box, pu: Profile): EdMesh {
  // the line's real extent from its pixels
  let x0 = Infinity, x1 = -Infinity;
  const t = textures[upper.tex];
  for (let x = 0; x < t.w; x++) for (let y = 0; y < t.h; y++) if (t.rgba[(y * t.w + x) * 4 + 3] > 60) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); break; }
  if (!Number.isFinite(x0)) { x0 = 0; x1 = t.w - 1; }
  const lw = (x1 - x0 + 1) * 0.78, cx = U.x + (x0 + x1 + 1) / 2;
  const top = pu.center(cx) - 1, h = lw * 0.55;
  const W = Math.ceil(lw + 6), H = Math.ceil(h + 6), ox = Math.floor(cx - W / 2), oy = Math.floor(top - 2);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5 - W / 2) / (lw / 2), v = (y + 0.5 - 2) / h; // v 0 = top line, 1 = bottom
    // a half-ellipse hanging from the line
    const e = u * u + Math.pow(Math.max(0, v - 0.0) / 1, 2) * 1.0;
    const inside = v >= 0 && e <= 1 && v <= 1;
    if (!inside) continue;
    const edge = Math.min(1, (1 - Math.sqrt(e)) * Math.min(lw, h) * 0.5);
    const tongue = (u * u) / 0.5 + Math.pow((v - 0.95) / 0.45, 2) < 1;
    const c = tongue ? [214, 102, 112] : [96, 30, 44];
    const i = (y * W + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = Math.round(255 * Math.max(0, Math.min(1, edge)));
  }
  const tex = textures.length;
  textures.push({ w: W, h: H, rgba });
  doc.textures.push({ name: 'mouth inside (painted)', x: ox, y: oy, w: W, h: H });
  let id = 'mouth_inside_painted';
  for (let k = 2; doc.meshes.some((m) => m.id === id); k++) id = `mouth_inside_painted_${k}`;
  const m: EdMesh = {
    id, name: 'Mouth inside (painted)', group: upper.group, role: 'mouthInner', side: null, tex,
    mesh: autoMesh(rgba, W, H, ox, oy, { spacing: Math.max(3, Math.min(W, H) / 5) }),
    deformer: upper.deformer, z: upper.z - 1, opacity: 1, blend: 'normal', masks: [], visible: true, depth: ROLE_DEPTH.mouthInner ?? 0.1, forms: [], generated: true,
  };
  doc.meshes.splice(doc.meshes.indexOf(upper), 0, m);
  doc.report?.notes.push('Painted an inside of the mouth under the mouth line so the mouth can open.');
  return m;
}
