// Pro2D "model sliders": the parameters a performer sets and holds by hand (chest / body shape, hair length, outfit
// dissolves, blush strength …), as opposed to the ones tracking, lip sync, blinks, motions or physics move.
// Pure (no DOM): unit-tested in tools/rig2d_params_unit.ts. The studio side (sliders, keys, deck, chat) is
// src/ui/rig2dSliders.ts; the runtime side is UserParamDriver below, run by the Animator (shared/rig2d/animate.ts).
//
// How Live2D / VTube Studio models do it (docs/RIG2D_FORMAT.md §8.12): a rigger adds a custom parameter (any id; the
// meaning is in the cdi3 display name: "Chest size", 胸, 衣装 …) and the performer drives it with VTube Studio
// expressions (.exp3.json, Add / Multiply / Overwrite) on hotkeys, which VTube Studio STACKS (outfit toggles stay on
// together; Pro2D does the same: FlatCue.x + ExpressionMixer in animate.ts). Here those parameters get sliders of their
// own, which the performer can also put on keys, the deck or chat; expressions still apply on top.
//
// Live values ride in the studio's flat cue (FlatCue.p: id → [target, fade s]) so OBS and party guests show the same;
// the slider positions the performer chose are saved in profile.flat.opts.params; costume layers ride along as
// "layer:<id>" entries (1 = on).
import { rig2dDynamics, type Rig2DDoc, type Rig2DParam } from './format.ts';
import type { Rig2DBinding } from './drive.ts';
import type { ChatEvent } from '../chat.ts';
import { reservedKey } from '../studioKeys.ts';

const cl = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const ID_RE = /^[^\x00-\x1f]{1,128}$/;
/** Prefix of costume-layer entries in the cue / triggers. */
export const LAYER_PREFIX = 'layer:';

// ================================================================ classification
/** Cubism standard ids a face / head / body tracker drives (VTube Studio's default setup binds these): never sliders,
 *  even when this model's binding table leaves one unbound. Arms / hands / bust sway are NOT here (riggers pose arms
 *  with expressions; bust sway is a physics output). */
export const TRACKING_STANDARD_IDS = new Set([
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeBallForm',
  'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLX', 'ParamBrowRX', 'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLForm', 'ParamBrowRForm',
  'ParamMouthForm', 'ParamMouthOpenY', 'ParamBreath', 'ParamBaseX', 'ParamBaseY',
  'PARAM_ANGLE_X', 'PARAM_ANGLE_Y', 'PARAM_ANGLE_Z', 'PARAM_BODY_ANGLE_X', 'PARAM_BODY_ANGLE_Y', 'PARAM_BODY_ANGLE_Z',
  'PARAM_EYE_L_OPEN', 'PARAM_EYE_R_OPEN', 'PARAM_EYE_L_SMILE', 'PARAM_EYE_R_SMILE', 'PARAM_EYE_BALL_X', 'PARAM_EYE_BALL_Y', 'PARAM_EYE_BALL_FORM',
  'PARAM_BROW_L_Y', 'PARAM_BROW_R_Y', 'PARAM_BROW_L_X', 'PARAM_BROW_R_X', 'PARAM_BROW_L_ANGLE', 'PARAM_BROW_R_ANGLE', 'PARAM_BROW_L_FORM', 'PARAM_BROW_R_FORM',
  'PARAM_MOUTH_FORM', 'PARAM_MOUTH_OPEN_Y', 'PARAM_BREATH', 'PARAM_BASE_X', 'PARAM_BASE_Y',
]);

export type UserParamGroup = 'chest' | 'body' | 'outfit' | 'hair' | 'face' | 'pose' | 'other';
/** What a slider shows: rank 0 first (the common ones: chest, body, outfit, hair). */
const GROUPS: [UserParamGroup, RegExp][] = [
  ['chest', /bust|breast|boob|chest|oppai|tits?\b|titty|mune|胸|おっぱい|乳|バスト|胸部|乳房|胸围|胸圍/i],
  ['body', /body ?(size|shape|type|weight)|figure|waist|hips?\b|thigh|belly|tummy|weight|chubby|thin|fat\b|muscle|tall|height|体型|体形|体重|腰|お尻|尻|太もも|ふともも|お腹|身材|体型|腰围|臀|大腿|肚子|胖|瘦/i],
  ['outfit', /outfit|earring|cloth|costume|dress|jacket|coat|hood|hoodie|hat\b|cap\b|glasses|shirt|skirt|pants|shorts|sock|shoe|boot|uniform|swim|bikini|apron|cape|scarf|mask|ribbon|bow\b|accessor|toggle|strip|undress|nude|衣装|服|着替|上着|帽子|眼鏡|めがね|メガネ|靴|脱|衣服|服装|外套|帽|眼镜|裙|袜|鞋|换装|脱衣/i],
  ['hair', /hair|bang|fringe|ponytail|twintail|braid|髪|前髪|後ろ髪|ポニテ|ツインテ|头发|头髮|髮|刘海|马尾|辫/i],
  ['face', /blush|cheek|tear|cry|sweat|shadow|dark ?face|gloom|heart|star|pupil|highlight|teeth|tongue|fang|照れ|赤面|頬|涙|汗|青ざめ|ハート|瞳|舌|牙|脸红|腮红|眼泪|泪|汗|心|瞳孔|舌头/i],
  ['pose', /arm|hand|finger|leg|foot|wing|tail|ear|腕|手|足|脚|翼|尻尾|しっぽ|耳|胳膊|手臂|腿|翅膀|尾巴|耳朵/i],
];
const RANK: Record<UserParamGroup, number> = { chest: 0, body: 1, outfit: 2, hair: 3, face: 4, other: 5, pose: 6 };

export interface UserParamInfo {
  id: string;
  /** What the slider says: the model's display name (cdi3), else the id made readable. */
  name: string;
  min: number; max: number; def: number;
  group: UserParamGroup;
  /** Feeds a physics strand / dynamics solver: changes are always eased (no strand kick). */
  physicsInput: boolean;
  decimals?: number;
}

/** "ParamBustSize" → "Bust size", "PARAM_HAIR_LENGTH" → "Hair length", "Param12" stays "Param12". */
export function readableId(id: string): string {
  let s = id.replace(/^(Param|PARAM_|param_?)(?=[A-Z0-9_]|$)/, '');
  if (!s || /^\d+$/.test(s)) return id;
  if (/^[A-Z0-9_]+$/.test(s)) s = s.toLowerCase().replace(/_+/g, ' ');
  else s = s.replace(/_+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase();
  s = s.trim();
  return s ? s[0].toUpperCase() + s.slice(1) : id;
}
export function friendlyName(p: Pick<Rig2DParam, 'id' | 'name'>): string {
  const n = (p.name ?? '').trim();
  return n && n !== p.id ? n.slice(0, 64) : readableId(p.id);
}
export function paramGroup(p: Pick<Rig2DParam, 'id' | 'name'>): UserParamGroup {
  const txt = `${p.name ?? ''} ${readableId(p.id)} ${p.id}`;
  // (a sway / bounce the rigger left free is motion, not a shape: not one of the common sliders)
  if (/sway|bounce|jiggle|physic|揺れ|ゆれ|摇|晃/i.test(txt)) return 'other';
  for (const [g, re] of GROUPS) if (re.test(txt)) return g;
  return 'other';
}

/** Why a parameter is not a slider ('' = it is one). */
export type TrackedReason = 'tracking' | 'blink' | 'lipsync' | 'physics' | 'motion' | 'standard' | 'vts' | 'fixed' | 'unused' | '';

/** Parameters that change something on the model (a keyform grid axis, a blend shape, a colour binding, an animated
 *  texture, physics / dynamics input, views, state machine or particle triggers). A slider for anything else does nothing. */
export function usedParams(doc: Rig2DDoc): Set<string> {
  const used = new Set<string>();
  const byIdx = (i: number | undefined) => { if (i !== undefined && doc.params[i]) used.add(doc.params[i].id); };
  for (const g of doc.grids) for (const a of g.axes) byIdx(a.param);
  for (const b of doc.blendShapes ?? []) { byIdx(b.param); byIdx(b.param2); }
  for (const m of doc.materialBindings ?? []) for (const b of m.bindings) { byIdx(b.param); byIdx(b.param2); }
  for (const t of doc.textures) if (t.sheet?.param) used.add(t.sheet.param);
  for (const s of doc.physics ?? []) for (const i of s.inputs) used.add(i.param);
  for (const d of rig2dDynamics(doc)) { if (d.input) used.add(d.input); if (d.amount) used.add(d.amount); }
  if (doc.views) used.add(doc.views.by);
  for (const L of doc.states?.layers ?? []) {
    for (const st of L.states) if (st.blend) used.add(st.blend.by);
    for (const t of L.transitions) if (t.on.kind === 'param' && t.on.value) used.add(t.on.value);
  }
  for (const p of doc.particles ?? []) if (p.trigger.kind === 'param' && p.trigger.value) used.add(p.trigger.value);
  return used;
}

/** Every parameter that is free for the performer (sorted: chest, body, outfit, hair, face, other, arms / poses; then the
 *  model's own order), and why each other one isn't. `bindings` = the tracking bindings in use (Animator.bindings). */
export function classifyParams(doc: Rig2DDoc, bindings: readonly Rig2DBinding[]): { user: UserParamInfo[]; reason: Map<string, TrackedReason> } {
  const reason = new Map<string, TrackedReason>();
  const mark = (id: string | undefined, r: TrackedReason) => { if (id && !reason.has(id)) reason.set(id, r); };
  for (const b of bindings) if (!b.off) mark(b.param, 'tracking');
  for (const id of doc.roles.eyeBlink) mark(id, 'blink');
  for (const id of doc.roles.lipSync) mark(id, 'lipsync');
  for (const s of doc.physics ?? []) for (const o of s.outputs) mark(o.param, 'physics');
  for (const d of rig2dDynamics(doc)) { mark(d.output, 'physics'); mark(d.output2, 'physics'); }
  // a parameter an idle motion animates (not just holds) is the model's own life (breathing, swaying)
  for (const m of doc.motions ?? []) {
    if (!/^idle$/i.test(m.group)) continue;
    for (const c of m.curves) if (c.target === 'param' && Array.isArray(c.values) && c.values.length > 1 && Math.max(...c.values) - Math.min(...c.values) > 1e-6) mark(c.id, 'motion');
  }
  const vts = doc.extra?.vtsTracked;
  if (Array.isArray(vts)) for (const id of vts) if (typeof id === 'string') mark(id, 'vts');
  if (doc.views?.by && !doc.views.by.startsWith('role:')) mark(doc.views.by, 'tracking');
  mark(doc.depth?.yaw, 'tracking'); mark(doc.depth?.pitch, 'tracking');
  const physIn = new Set<string>();
  for (const s of doc.physics ?? []) for (const i of s.inputs) physIn.add(i.param);
  // (a dynamics `amount` — a part's "swing" slider — eases too: the hair calms or livens smoothly)
  for (const d of rig2dDynamics(doc)) { if (d.input) physIn.add(d.input); if (d.amount) physIn.add(d.amount); }
  const user: (UserParamInfo & { order: number })[] = [];
  const used = usedParams(doc);
  doc.params.forEach((p, order) => {
    if (TRACKING_STANDARD_IDS.has(p.id)) mark(p.id, 'standard');
    if (!(p.max - p.min > 1e-9)) mark(p.id, 'fixed');
    if (!used.has(p.id)) mark(p.id, 'unused');
    if (reason.has(p.id)) return;
    reason.set(p.id, '');
    user.push({ id: p.id, name: friendlyName(p), min: p.min, max: p.max, def: p.default, group: paramGroup(p), physicsInput: physIn.has(p.id),
      ...(p.decimals !== undefined ? { decimals: p.decimals } : {}), order });
  });
  user.sort((a, b) => RANK[a.group] - RANK[b.group] || a.order - b.order);
  return { user: user.map(({ order: _o, ...u }) => u), reason };
}

// ================================================================ keys
/** A key combination as the studio stores it: "Ctrl+Alt+Shift+Meta+<KeyboardEvent.code>" (modifiers in that order). */
export function comboOf(e: { code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }): string {
  return `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.metaKey ? 'Meta+' : ''}${e.code}`;
}
/** The same key for matching: the number row and the keypad are one key (VTube Studio models save either). */
export const sameKey = (a: string, b: string) => a.replace(/Numpad(\d)$/, 'Digit$1') === b.replace(/Numpad(\d)$/, 'Digit$1');
/** How people read a combination: "Ctrl+Shift+B", "1", "F5", "Num +". */
export function keyLabel(combo: string | undefined): string {
  if (!combo) return '';
  return combo.replace(/Key([A-Z])$/, '$1').replace(/Digit(\d)$/, '$1').replace(/Numpad(\d)$/, 'Num $1').replace(/NumpadAdd$/, 'Num +').replace(/NumpadSubtract$/, 'Num −')
    .replace(/Arrow(Up|Down|Left|Right)$/, '$1 arrow');
}
/** A key the studio or the browser keeps (shared/studioKeys.ts), as one sentence for the key forms; null = free. */
export function studioKeyClash(combo: string): string | null {
  const why = reservedKey(combo);
  return why ? `${keyLabel(combo)} ${why} — pick another key.` : null;
}

/** The performer's key choices that decide where a model's expressions sit (profile.flat.opts): their own key per
 *  expression (`exprKeys: [[expression id, combo | ""]]`, "" = no key) and the keys their model-slider / outfit
 *  triggers use (`paramTriggers`: an expression never gets one of those). */
export interface ExprKeyOpts { exprKeys?: ReadonlyMap<string, string>; taken?: readonly string[] }
export function exprKeyOpts(opts: unknown): ExprKeyOpts {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>;
  const exprKeys = new Map<string, string>();
  if (Array.isArray(o.exprKeys)) for (const x of o.exprKeys.slice(0, 256)) {
    if (Array.isArray(x) && typeof x[0] === 'string' && ID_RE.test(x[0]) && typeof x[1] === 'string' && (x[1] === '' || (/^((Ctrl|Alt|Shift|Meta)\+){0,4}[A-Za-z0-9]{1,24}$/.test(x[1]) && !reservedKey(x[1])))) exprKeys.set(x[0], x[1]);
  }
  return { exprKeys, taken: sanitizeTriggers(o.paramTriggers).map((t) => t.key).filter((k): k is string => !!k) };
}

/** The keys a model's expressions are on in the studio, in this order of say:
 *   1. the performer's own choice for that expression (`exprKeys`, "" = no key);
 *   2. the model's own key (a VTube Studio import keeps the model's) — unless the studio or the browser keeps that key
 *      (shared/studioKeys.ts), a model slider / outfit key already uses it, or an earlier expression has it;
 *   3. the free number keys 1..9 then 0 in order — never one a slider or another expression uses.
 *  None left: no key (the 2D panel's Expressions list lets the performer pick one). */
export function expressionKeys(doc: Pick<Rig2DDoc, 'expressions'>, ko: ExprKeyOpts = {}): { id: string; name: string; key?: string }[] {
  const list = doc.expressions ?? [];
  const norm = (k: string) => k.replace(/Numpad(\d)$/, 'Digit$1');
  const used = new Set((ko.taken ?? []).map(norm));
  const pick = new Map<string, string | null>();   // id → key (null = none on purpose)
  for (const e of list) {
    const mine = ko.exprKeys?.get(e.id);
    if (mine !== undefined) { if (mine && !used.has(norm(mine))) { pick.set(e.id, mine); used.add(norm(mine)); } else if (!mine) pick.set(e.id, null); }
  }
  for (const e of list) {
    if (pick.has(e.id) || !e.key || reservedKey(e.key) || used.has(norm(e.key))) continue;
    pick.set(e.id, e.key); used.add(norm(e.key));
  }
  const free = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].filter((d) => !used.has(`Digit${d}`));
  return list.map((e) => {
    const k = pick.get(e.id);
    if (k) return { id: e.id, name: e.name, key: k };
    if (k === null || !free.length) return { id: e.id, name: e.name };
    return { id: e.id, name: e.name, key: `Digit${free.shift()}` };
  });
}

/** Saved slider positions to write for an avatar: only when the profile on show is still that avatar (a model switch
 *  inside the save delay must never get another model's values), and only parameters that are sliders. null = skip. */
export function sliderSaveFor(profileId: string | null | undefined, ownerId: string, saved: ReadonlyMap<string, number>, userIds: ReadonlySet<string>): [string, number][] | null {
  if (!profileId || profileId !== ownerId) return null;
  return paramValuesJson(new Map([...saved].filter(([k]) => userIds.has(k))));
}

/** Costume layers: switch one on / off (one per group), and the layer a wardrobe costume (id or name) is. */
export interface LayerInfoLite { id: string; name: string; group: string | null }
export function switchLayer(layers: readonly LayerInfoLite[], on: Map<string, boolean>, id: string, value: boolean) {
  const L = layers.find((l) => l.id === id);
  if (!L) return;
  if (value && L.group) for (const x of layers) if (x !== L && x.group === L.group) on.set(x.id, false);
  on.set(id, value);
}
export const costumeLayer = (layers: readonly LayerInfoLite[], costume: string | null | undefined) =>
  costume ? layers.find((l) => l.id === costume || l.name.toLowerCase() === String(costume).toLowerCase()) ?? null : null;

/** The studio's wardrobe driving costume layers (src/ui/rig2dSliders.ts, on the app's 'costume' event). It remembers
 *  the layer the wardrobe switched on and what its group (or the layer alone) looked like before:
 *   - a costume that is a layer: that layer on (one per group);
 *     (a layer that was on already stays the performer's: not remembered, so taking the costume off leaves it);
 *   - then another costume, or none: the layer it switched on goes off and its group is put back as it was
 *     (wear "No hat" → no costume = the hat is back);
 *   - the same costume again (an accessory toggle also fires the event): nothing — a layer the performer switched off
 *     in the panel stays off.
 *  Returns whether a layer changed. */
export class WardrobeLayers {
  private costume: string | null = null;
  private worn: string | null = null;
  private before: [string, boolean][] = [];
  constructor(private layers: readonly LayerInfoLite[]) {}
  /** The costume the avatar loaded with (its layer is already on: the model switched it on at load). */
  start(on: Map<string, boolean>, costume: string | null | undefined) {
    this.costume = costume ?? null; this.worn = null; this.before = [];
    this.adopt(on, costumeLayer(this.layers, this.costume));
  }
  /** Switch the costume's layer on — and only then remember it (with its group as it was): a layer that is already on
   *  (the panel / a key / the saved list had it on) is not the wardrobe's, so taking the costume off leaves it alone. */
  private adopt(on: Map<string, boolean>, L: LayerInfoLite | null): boolean {
    if (!L || on.get(L.id)) return false;
    this.remember(L, on); switchLayer(this.layers, on, L.id, true); this.worn = L.id;
    return true;
  }
  private remember(L: LayerInfoLite, on: Map<string, boolean>) {
    const group = this.layers.filter((x) => x === L || (L.group && x.group === L.group));
    this.before = group.map((x) => [x.id, !!on.get(x.id)]);
  }
  wear(on: Map<string, boolean>, costume: string | null | undefined): boolean {
    const next = costume ?? null;
    if (next === this.costume) return false;
    this.costume = next;
    let changed = false;
    if (this.worn) { for (const [id, v] of this.before) if (on.get(id) !== v) { on.set(id, v); changed = true; } this.worn = null; this.before = []; }
    if (this.adopt(on, costumeLayer(this.layers, next))) changed = true;
    return changed;
  }
  /** (tests / probes) the layer the wardrobe has on, if any */
  get wornLayer() { return this.worn; }
}

// ================================================================ triggers (keys, deck, chat, stream events)
export type TriggerMode = 'toggle' | 'step';
export interface ParamTrigger {
  /** A parameter id, or "layer:<id>" (a costume layer: 1 = on). */
  param: string;
  /** toggle: values[0] = where it goes, values[1] = where it comes back to (absent = the saved slider position);
   *  step: every press goes to the next value (cycling). */
  mode: TriggerMode;
  values: number[];
  key?: string;
  /** a chat message containing this (case-insensitive) */
  chat?: string;
  /** a stream event: follow, sub, raid, cheer, donation, redeem (any channel-point reward) or "redeem:<reward words>" */
  event?: string;
  /** transition time, seconds (absent: 0.4) */
  fade?: number;
  /** go back after this many seconds (chat / redeem fun: "big for 30 s") */
  hold?: number;
  /** chat / events: at most once per this many seconds (absent: 2) */
  cooldown?: number;
}
export const DEFAULT_FADE = 0.4;
/** Chat / stream-event triggers fire at most once per this many seconds each (a busy chat can't strobe an outfit). */
export const DEFAULT_COOLDOWN = 2;
/** Chat words shorter than this are refused ("a" would match nearly every message). */
export const MIN_CHAT_WORD = 3;
/** Changes of a parameter that feeds physics are never faster than this (no strand kick). */
export const PHYSICS_MIN_FADE = 0.5;
const MAX_TRIGGERS = 128;

export function sanitizeTriggers(v: unknown): ParamTrigger[] {
  if (!Array.isArray(v)) return [];
  const out: ParamTrigger[] = [];
  for (const x of v.slice(0, MAX_TRIGGERS)) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.param !== 'string' || !ID_RE.test(o.param)) continue;
    const mode: TriggerMode = o.mode === 'step' ? 'step' : 'toggle';
    const values = Array.isArray(o.values) ? o.values.filter(fin).slice(0, 16).map((n) => cl(n, -1e5, 1e5)) : [];
    if (!values.length) continue;
    const t: ParamTrigger = { param: o.param, mode, values };
    if (typeof o.key === 'string' && /^((Ctrl|Alt|Shift|Meta)\+){0,4}[A-Za-z0-9]{1,24}$/.test(o.key) && !reservedKey(o.key)) t.key = o.key;
    if (typeof o.chat === 'string' && o.chat.trim().length >= MIN_CHAT_WORD) t.chat = o.chat.trim().slice(0, 64);
    if (typeof o.event === 'string' && /^[a-z]{2,16}(:.{1,64})?$/i.test(o.event.trim())) t.event = o.event.trim().toLowerCase();
    if (fin(o.fade)) t.fade = cl(o.fade, 0, 30);
    if (fin(o.hold) && o.hold > 0) t.hold = cl(o.hold, 0.5, 3600);
    if (fin(o.cooldown)) t.cooldown = cl(o.cooldown, 0, 600);
    out.push(t);
  }
  return out;
}

/** Saved slider positions (profile.flat.opts.params: [[id, value], …]) → a map; junk dropped. */
export function sanitizeParamValues(v: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(v)) return out;
  for (const x of v.slice(0, 512)) if (Array.isArray(x) && typeof x[0] === 'string' && ID_RE.test(x[0]) && fin(x[1])) out.set(x[0], cl(x[1], -1e5, 1e5));
  return out;
}
export const paramValuesJson = (m: ReadonlyMap<string, number>): [string, number][] => [...m].map(([k, v]) => [k, +v.toFixed(5)]);

// ================================================================ chat + stream events
/** Stream event names an event counts as (the same words the 2D rigs' state machines use, worldFeed.ts). */
export function eventNames(e: ChatEvent): string[] {
  if (e.kind === 'finance' && e.fkind) {
    const k = e.fkind;
    const n = k === 'bits' ? 'cheer' : k === 'resub' || k === 'giftSub' || k === 'membership' || k === 'giftMembership' ? 'sub'
      : k === 'superchat' || k === 'supersticker' || k === 'tip' || k === 'rant' || k === 'wallet' || k === 'kicks' || k === 'jewels' || k === 'tiktokGift' ? 'donation' : k;
    return n === k ? [n] : [n, k.toLowerCase()];
  }
  if (e.kind === 'system') {
    if (e.ev === 'reward') return ['redeem'];
    if (e.ev) return [e.ev];
    if (/follow/i.test(e.text ?? '')) return ['follow'];
  }
  return [];
}
/** Which triggers a batch of chat / stream events fires (one bus message), `now` in seconds: each trigger at most once
 *  per its cooldown (default 2 s), each parameter / outfit at most once per batch (a burst of matching messages can't
 *  flip it back and forth). `last` keeps the fire times between batches. */
export function chatFires(triggers: readonly ParamTrigger[], events: readonly ChatEvent[], now: number, last: Map<ParamTrigger, number>): ParamTrigger[] {
  const out: ParamTrigger[] = [], params = new Set<string>();
  for (const e of events) for (const t of triggers) {
    if (!(t.chat || t.event) || params.has(t.param) || !triggerMatches(t, e)) continue;
    const at = last.get(t);
    if (at !== undefined && now - at < (t.cooldown ?? DEFAULT_COOLDOWN)) continue;
    last.set(t, now); params.add(t.param); out.push(t);
  }
  return out;
}
export function triggerMatches(t: ParamTrigger, e: ChatEvent): boolean {
  if (t.chat && t.chat.length >= MIN_CHAT_WORD && e.kind === 'chat') return (e.text ?? '').toLowerCase().includes(t.chat.toLowerCase());
  if (!t.event) return false;
  const names = eventNames(e);
  if (t.event.startsWith('redeem:')) return names.includes('redeem') && (e.text ?? '').toLowerCase().includes(t.event.slice(7).trim());
  return names.includes(t.event);
}

// ================================================================ the live state (studio side)
/** One entry of the cue: target value + transition time (s). */
export type CueEntry = [number, number];
export type ParamCue = Record<string, CueEntry>;

/** What the performer holds now: the saved slider positions, moved by triggers (keys, deck, chat) and the panel. Pure
 *  data: the studio wraps it (src/ui/rig2dSliders.ts) and sends cue() with every frame. */
export class UserParamState {
  /** current targets (absent = default / not held) */
  readonly target = new Map<string, number>();
  readonly fade = new Map<string, number>();
  /** timed returns (hold): id → [time s, value] */
  private back = new Map<string, [number, number]>();
  constructor(readonly info: ReadonlyMap<string, { min: number; max: number; def: number }>, readonly saved: Map<string, number>) {
    for (const [k, v] of saved) if (info.has(k)) this.target.set(k, this.clamp(k, v));
  }
  private clamp(id: string, v: number) { const p = this.info.get(id); return p ? cl(v, Math.min(p.min, p.max), Math.max(p.min, p.max)) : v; }
  value(id: string): number { return this.target.get(id) ?? this.info.get(id)?.def ?? 0; }
  /** The saved position (where a toggle comes back to). */
  base(id: string): number { return this.saved.get(id) ?? this.info.get(id)?.def ?? 0; }
  set(id: string, v: number, fade = DEFAULT_FADE) {
    if (!this.info.has(id)) return false;
    this.target.set(id, this.clamp(id, v)); this.fade.set(id, Math.max(0, fade)); this.back.delete(id);
    return true;
  }
  /** Save the current position as the one the model starts with (the panel's slider). */
  keep(id: string) { if (!this.info.has(id)) return; const v = this.value(id), d = this.info.get(id)!.def; if (Math.abs(v - d) < 1e-9) this.saved.delete(id); else this.saved.set(id, v); }
  reset(id: string, fade = DEFAULT_FADE) { const d = this.info.get(id)?.def; if (d === undefined) return; this.set(id, d, fade); this.saved.delete(id); }
  /** A trigger fired (key / deck / chat / event) at time `now` (s). Returns the new target. */
  press(t: ParamTrigger, now = 0): number | null {
    if (!this.info.has(t.param) || !t.values.length) return null;
    const cur = this.value(t.param), near = (a: number, b: number) => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(b));
    let next: number;
    if (t.mode === 'step') {
      const vs = t.values.map((v) => this.clamp(t.param, v));
      const at = vs.findIndex((v) => near(v, cur));
      next = vs[(at + 1) % vs.length];
    } else {
      const to = this.clamp(t.param, t.values[0]), from = t.values.length > 1 ? this.clamp(t.param, t.values[1]) : this.base(t.param);
      next = near(cur, to) ? from : to;
    }
    const prev = cur;
    this.set(t.param, next, t.fade ?? DEFAULT_FADE);
    if (t.hold && !near(prev, next)) this.back.set(t.param, [now + t.hold, prev]);
    return next;
  }
  /** Timed returns that are due (call each frame / second with the time in s); true = something changed. */
  tick(now: number, fade = DEFAULT_FADE): boolean {
    let changed = false;
    for (const [id, [at, v]] of this.back) if (now >= at) { this.back.delete(id); this.target.set(id, v); this.fade.set(id, fade); changed = true; }
    return changed;
  }
  /** The cue the frames carry: every held parameter (defaults too, so the pages ease back and let go). */
  cue(): ParamCue {
    const out: ParamCue = {};
    for (const [k, v] of this.target) out[k] = [+v.toFixed(5), +(this.fade.get(k) ?? DEFAULT_FADE).toFixed(3)];
    return out;
  }
}

/** The cue as a page receives it (TrackingFrame.flat.p): bounded, finite. */
export function sanitizeParamCue(v: unknown): ParamCue | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: ParamCue = {};
  let n = 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (n >= 128) break;
    if (!ID_RE.test(k) || k === '__proto__' || !Array.isArray(x) || !fin(x[0])) continue;
    out[k] = [cl(x[0], -1e5, 1e5), fin(x[1]) ? cl(x[1], 0, 30) : DEFAULT_FADE];
    n++;
  }
  return out;
}

// ================================================================ the runtime driver (every page)
interface Live { idx: number; from: number; to: number; t: number; dur: number; cur: number; def: number; lo: number; hi: number; held: boolean }
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

/** Holds and eases the performer's parameter values on a rig (run by the Animator after motions, before expressions:
 *  expressions still apply on top, physics reads the eased value). Starts at the saved positions with no transition
 *  (no pop on load); `cue` (the studio's live targets) replaces them when present. A parameter eased back to its
 *  default is let go (motions drive it again). Costume layers ("layer:<id>") are switched through `setLayer`. */
export class UserParamDriver {
  private live = new Map<string, Live>();
  private idx: Map<string, number>;
  private physIn: Set<string>;
  private layerIds: Set<string>;
  /** each costume layer's group (one on at a time), null = a free switch */
  private layerGroup = new Map<string, string | null>();
  /** what the cue last said for each costume layer (its on / off edges switch it) */
  private layerOn = new Map<string, boolean>();
  /** when each layer was last switched on by the cue (a counter): in a group the latest "on" wins */
  private layerAt = new Map<string, number>();
  private layerSeq = 0;
  private lastCue: ParamCue | undefined = undefined;
  /** the parameters the performer may hold (classifyParams' sliders): tracked / blink / lip-sync / physics outputs never */
  private allowed: Set<string> | null = null;
  /** `isLayerOn` = the rig's costume layer now (another member of its group may have taken over): a group whose cue
   *  still says "on" for a member gets that member back (the latest one switched on wins). */
  constructor(private doc: Rig2DDoc, saved: ReadonlyMap<string, number> | undefined, private setLayer: (id: string, on: boolean) => void = () => {}, allowed?: Iterable<string>,
    private isLayerOn?: (id: string) => boolean) {
    if (allowed) this.allowed = new Set(allowed);
    this.idx = new Map(doc.params.map((p, i) => [p.id, i]));
    this.physIn = new Set([...(doc.physics ?? []).flatMap((s) => s.inputs.map((i) => i.param)), ...rig2dDynamics(doc).flatMap((d) => [d.input ?? '', d.amount ?? ''])]);
    this.layerIds = new Set((doc.layers ?? []).map((l) => l.id));
    for (const l of doc.layers ?? []) this.layerGroup.set(l.id, l.group ?? null);
    for (const [k, v] of saved ?? []) { const L = this.allowed && !this.allowed.has(k) ? null : this.entry(k); if (L) { L.from = L.to = L.cur = cl(v, L.lo, L.hi); L.t = L.dur = 0; L.held = true; } }
  }
  private entry(id: string): Live | null {
    let L = this.live.get(id);
    if (L) return L;
    const i = this.idx.get(id);
    if (i === undefined) return null;
    const p = this.doc.params[i];
    L = { idx: i, from: p.default, to: p.default, t: 0, dur: 0, cur: p.default, def: p.default, lo: Math.min(p.min, p.max), hi: Math.max(p.min, p.max), held: false };
    this.live.set(id, L);
    return L;
  }
  /** The studio's live cue has reached this page (it then owns the sliders and the outfit layers). */
  get cueSeen() { return this.lastCue !== undefined; }
  /** New classification (the tracking bindings changed): parameters that are tracked now are let go at once. */
  setAllowed(ids: Iterable<string>) {
    this.allowed = new Set(ids);
    for (const [k, L] of this.live) if (!this.allowed.has(k)) { L.held = false; this.live.delete(k); }
  }
  /** Outfit layers were rewritten from saved options: the next cue sets them again (its on / off wins). */
  forgetLayers() { this.layerOn.clear(); this.lastCue = this.lastCue ? { ...this.lastCue } : this.lastCue; }
  /** Is a parameter held (being set by the performer) right now? (tests / probes) */
  value(id: string): number | null { const L = this.live.get(id); return L && L.held ? L.cur : null; }
  /** New targets from the studio (call each frame with the frame's cue; undefined = keep what it has). */
  setCue(cue: ParamCue | undefined) {
    if (!cue || typeof cue !== 'object' || cue === this.lastCue) return;
    this.lastCue = cue;
    // grouped layers the cue says are on: group → the one switched on last (it wins the group)
    let claim: Map<string, string> | null = null, edged: Set<string> | null = null;
    for (const k in cue) {
      const e = cue[k];
      if (!Array.isArray(e) || !fin(e[0])) continue;   // (OBS pages read the bus frame as sent: skip junk)
      const v = e[0], f = fin(e[1]) ? cl(e[1], 0, 30) : DEFAULT_FADE;
      if (k.startsWith(LAYER_PREFIX)) {
        const id = k.slice(LAYER_PREFIX.length);
        if (!this.layerIds.has(id)) continue;
        const on = v > 0.5, was = this.layerOn.get(id);
        if (was !== on) {
          this.layerOn.set(id, on);
          // (a layer the cue had on before a forgetLayers keeps its place in the order)
          if (on && (was === false || !this.layerAt.has(id))) this.layerAt.set(id, ++this.layerSeq);
          this.setLayer(id, on);
        }
        const g = this.layerGroup.get(id);
        if (g && was !== on) (edged ??= new Set()).add(g);
        if (on && g) { const c = (claim ??= new Map()).get(g); if (c === undefined || (this.layerAt.get(id) ?? 0) > (this.layerAt.get(c) ?? 0)) claim.set(g, id); }
        continue;
      }
      this.retarget(k, v, f);
    }
    // an outfit whose "on" still stands while another member of its group took over (a cue listing only some layers
    // switched another on), or the member that took over went off in this cue: the latest "on" of the group wins,
    // even unchanged. (A group someone emptied outside the cue — a show-mode tap — is left alone.)
    if (claim && this.isLayerOn) for (const [g, id] of claim) {
      if (this.isLayerOn(id)) continue;
      if (edged?.has(g) || [...this.layerGroup].some(([x, xg]) => xg === g && x !== id && this.isLayerOn!(x))) this.setLayer(id, true);
    }
    // held parameters the cue no longer lists ease back to their defaults
    for (const [k, L] of this.live) if (L.held && !(k in cue) && L.to !== L.def) this.retarget(k, L.def, DEFAULT_FADE);
  }
  private retarget(id: string, v: number, fade: number) {
    if (this.allowed && !this.allowed.has(id)) return;
    const L = this.entry(id);
    if (!L) return;
    const to = cl(v, L.lo, L.hi);
    if (L.held && Math.abs(to - L.to) < 1e-9) return;
    const min = this.physIn.has(id) ? PHYSICS_MIN_FADE : 1 / 60;
    L.from = L.held ? L.cur : L.def; L.to = to; L.t = 0; L.dur = Math.max(min, fade); L.held = true;
  }
  /** New saved positions (a profile save, no reload). Ignored once the studio's live cue drives this page: the cue
   *  already carries them. */
  setSaved(saved: ReadonlyMap<string, number>) {
    if (this.lastCue !== undefined) return;
    for (const [k, v] of saved) this.retarget(k, v, DEFAULT_FADE);
    for (const [k, L] of this.live) if (L.held && !saved.has(k) && L.to !== L.def) this.retarget(k, L.def, DEFAULT_FADE);
  }
  /** Write the held values (each frame, after motions, before expressions). */
  apply(dt: number, values: Float64Array) {
    for (const L of this.live.values()) {
      if (!L.held) continue;
      if (L.t < L.dur) { L.t = Math.min(L.dur, L.t + Math.max(0, dt)); L.cur = L.from + (L.to - L.from) * ease(L.t / L.dur); }
      else L.cur = L.to;
      values[L.idx] = L.cur;
      // back at the default and settled: let go (motions / expressions own it again)
      if (L.t >= L.dur && Math.abs(L.to - L.def) < 1e-9) L.held = false;
    }
  }
}
