// Avatar items & item scenes (beta.16, docs/b16/LANES.md): stickers, hats, held signs and small models that pin to the
// avatar and follow it. This is the CONTRACT between the items lane (src/avatar/items, server/routes/items.ts, the panel)
// and everybody who adds or moves items: the VTS API lane (a plugin's Item requests), Rules / the deck (item-scene,
// sticker), Throw (a thrown prop that sticks) and Pro2D. No DOM, no file system, no network here.
//
// One command in, one event out, both on the existing bus message `{ type: 'command', command, args }`:
//
//   command 'item'        args = ItemOp   add · move · pin · remove · clear · list · scene-save · scene-apply · scene-toggle · scene-delete
//   command 'item-state'  args = ItemState   the studio's answer to `list` and to every change (what the VTS API reads)
//   command 'item-event'  args = ItemEvent   added / removed / moved / pinned / clicked, for subscribers (VTS ItemEvent)
//
// (The deck actions `item-scene` and `sticker` plan to the bus commands `item-scene` and `sticker` in shared/deck.ts; the
// items lane turns those into ItemOps. Rules call the same two actions.)
//
// CUSTODY (AGENTS.md rule 7, docs/MULTIPLAYER_DISCORD.md): a picture or model that arrives WITH a command (`data`, a VTS
// plugin's base64 image, a drop on the preview) is kept in RAM by the page that shows it and is never written to disk,
// never put in SceneState / cache/scene.json and never relayed to party guests. Only a `src: { lib }` item (an asset in the
// HOST's installed library: the starter stickers, files the host dropped in on purpose) can be saved in an item scene.
// A host's items never land on a guest's avatar unless that guest switched "let the host decorate me" on in their own
// studio (itemMayApply): a command naming another member is ignored by the receiver.
import type { BusMessage } from './types.ts';

export const ITEM_COMMAND = 'item';
export const ITEM_STATE_COMMAND = 'item-state';
export const ITEM_EVENT_COMMAND = 'item-event';

export const ITEM_LIMITS = {
  /** One picture / model that came with a command (bytes of the decoded data). */
  maxBytes: 2 * 1024 * 1024,
  /** Items alive at once on one avatar (RAM-only ones included): the 21st add is refused. */
  maxItems: 20,
  /** Of those, how many may be RAM-only (plugin / drop) items. */
  maxRamItems: 20,
  maxScenes: 50,
  maxSceneItems: 20,
  maxName: 48,
} as const;

/** Kinds a drop / plugin may send. */
export const ITEM_MIMES = ['image/png', 'image/gif', 'image/webp', 'image/apng', 'image/jpeg', 'model/gltf-binary'] as const;
export type ItemMime = (typeof ITEM_MIMES)[number];
export type ItemKind = 'image' | 'model';

/** In front of or behind the avatar (3D: render order / depth offset; 2D: layer above or below the part). */
export type ItemLayer = 'front' | 'behind';

/**
 * What an item is pinned to. `bone`: a humanoid bone name of the 3D avatar (head, chest, hand ...); `part`: a Pro2D / flat
 * part name (shared/rig2d); `face`: the face decal plane (src/avatar/faceDecals.ts); `screen`: a free spot on the picture
 * (x, y in 0..1 of the frame) that does not follow the avatar (VTS "unpinned").
 */
export type ItemPin =
  | { to: 'bone'; bone: string }
  | { to: 'part'; part: string }
  | { to: 'face' }
  | { to: 'screen' };

/** Where the item's picture / model comes from. `lib`: an asset id in the host's library (saved with scenes). `ram`: a key of the
 *  data that came with the command (never saved). */
export type ItemSrc = { lib: string } | { ram: string };

/** An item's placement relative to its pin (metres for 3D bones; avatar-height units for faces / parts / screen). */
export interface ItemPlace {
  x: number; y: number; z: number;
  /** Degrees. */
  rot: number;
  scale: number;
  flipX?: boolean;
}

export interface ItemSpec {
  /** Stable id of this item on the avatar (a-z0-9_-). The adder picks it; a clash is a move. */
  id: string;
  name?: string;
  kind: ItemKind;
  src: ItemSrc;
  pin: ItemPin;
  place: ItemPlace;
  layer: ItemLayer;
  /** 0..1. */
  opacity?: number;
  /** A held prop: the pose the hand takes (src/avatar/retarget.ts grips) while it is on. */
  hand?: { pose: string };
  /** Animated picture / model clip speed (1 = as made). */
  speed?: number;
  /** Remove itself after this many seconds (a Rules / sticker timed revert). */
  ttlSecs?: number;
}

/** What the page needs to show a RAM-only item. base64 so it fits a JSON bus message; the decoded size is checked against ITEM_LIMITS.maxBytes. */
export interface ItemData { ref: string; mime: ItemMime; b64: string }

/** Which avatar: '@host' = the host's own (the default); a party member key for a guest who opted in. */
export type ItemTarget = '@host' | string;

export type ItemOp =
  | { op: 'add'; item: ItemSpec; data?: ItemData; target?: ItemTarget; by?: ItemSource }
  | { op: 'move'; id: string; place?: Partial<ItemPlace>; layer?: ItemLayer; opacity?: number; target?: ItemTarget }
  | { op: 'pin'; id: string; pin: ItemPin; place?: Partial<ItemPlace>; target?: ItemTarget }
  | { op: 'remove'; id: string; target?: ItemTarget }
  | { op: 'clear'; target?: ItemTarget; /** only items added by this source (a plugin disconnecting takes its own away) */ by?: ItemSource }
  | { op: 'list'; target?: ItemTarget; req?: string }
  | { op: 'scene-save'; name: string; target?: ItemTarget; /** the scene turns itself off after this many seconds (0 / absent = stays) */ secs?: number }
  | { op: 'scene-apply'; name: string; target?: ItemTarget; /** replace what is on (default) or add to it */ mode?: 'replace' | 'add'; by?: ItemSource }
  | { op: 'scene-toggle'; name: string; on?: boolean | 'toggle'; target?: ItemTarget; by?: ItemSource }
  | { op: 'scene-delete'; name: string };

/** Who put an item there (so a plugin that disconnects, or a rule that reverts, only takes away its own). */
export type ItemSource = 'host' | 'rule' | 'throw' | 'vts' | 'deck';

/** A saved set of items. Only `src: { lib }` items can be in one (RAM-only items are skipped when saving). `secs`: the scene
 *  turns itself off again after this many seconds (a timer; absent / 0 = it stays until switched off). */
export interface ItemScene { name: string; items: ItemSpec[]; secs?: number }

/** What the studio publishes (answer to `list`, and after every change). Never carries `data`. */
export interface ItemState {
  req?: string;
  target: ItemTarget;
  items: (ItemSpec & { by?: ItemSource })[];
  scenes: { name: string; on: boolean; count: number }[];
}

export type ItemEvent =
  | { ev: 'added' | 'removed' | 'pinned'; id: string; item?: ItemSpec; target: ItemTarget }
  | { ev: 'moved'; id: string; place: ItemPlace; target: ItemTarget }
  | { ev: 'clicked'; id: string; target: ItemTarget };

// ---------------------------------------------------------------- bus helpers

export const itemBusMessage = (op: ItemOp): BusMessage => ({ type: 'command', command: ITEM_COMMAND, args: op });
export const itemStateMessage = (s: ItemState): BusMessage => ({ type: 'command', command: ITEM_STATE_COMMAND, args: s });
export const itemEventMessage = (e: ItemEvent): BusMessage => ({ type: 'command', command: ITEM_EVENT_COMMAND, args: e });

/** The receiver's check: may this op change THIS page's avatar? The host's own avatar yes; anyone else only when that member opted in. */
export function itemMayApply(target: ItemTarget | undefined, self: string, guestOptIn: boolean): boolean {
  const t = target ?? '@host';
  if (t === '@host') return self === '@host'; // the host's own avatar: only the host's own page
  return t === self && guestOptIn;           // a guest's avatar: only that guest's page, only after their own opt-in
}

// ---------------------------------------------------------------- sanitising

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const LIB = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,95}$/;
const REF = /^[A-Za-z0-9_-]{1,48}$/;
const BONE = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;
const TARGET = /^(@host|[a-z0-9]{6,32}|lib:[A-Za-z0-9_-]{1,48})$/;
const SOURCES: readonly ItemSource[] = ['host', 'rule', 'throw', 'vts', 'deck'];
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const name = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ITEM_LIMITS.maxName) : '');
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

export const DEFAULT_PLACE: ItemPlace = { x: 0, y: 0, z: 0, rot: 0, scale: 1 };

export function sanitizePlace(o: unknown, base: ItemPlace = DEFAULT_PLACE): ItemPlace {
  const x = rec(o);
  return { x: num(x.x, -10, 10, base.x), y: num(x.y, -10, 10, base.y), z: num(x.z, -10, 10, base.z), rot: num(x.rot, -360, 360, base.rot), scale: num(x.scale, 0.01, 20, base.scale), ...(x.flipX === true || (x.flipX === undefined && base.flipX) ? { flipX: true } : {}) };
}
const placePatch = (o: unknown): Partial<ItemPlace> | undefined => {
  const x = rec(o), p: Partial<ItemPlace> = {};
  for (const k of ['x', 'y', 'z'] as const) if (typeof x[k] === 'number') p[k] = num(x[k], -10, 10, 0);
  if (typeof x.rot === 'number') p.rot = num(x.rot, -360, 360, 0);
  if (typeof x.scale === 'number') p.scale = num(x.scale, 0.01, 20, 1);
  if (typeof x.flipX === 'boolean') p.flipX = x.flipX;
  return Object.keys(p).length ? p : undefined;
};

export function sanitizePin(o: unknown): ItemPin | null {
  const x = rec(o);
  switch (x.to) {
    case 'bone': return typeof x.bone === 'string' && BONE.test(x.bone) ? { to: 'bone', bone: x.bone } : null;
    case 'part': return typeof x.part === 'string' && BONE.test(x.part) ? { to: 'part', part: x.part } : null;
    case 'face': return { to: 'face' };
    case 'screen': return { to: 'screen' };
  }
  return null;
}

export function sanitizeItemSpec(o: unknown): ItemSpec | null {
  const x = rec(o), s = rec(x.src), pin = sanitizePin(x.pin);
  if (typeof x.id !== 'string' || !ID.test(x.id) || !pin) return null;
  if (x.kind !== 'image' && x.kind !== 'model') return null;
  const src: ItemSrc | null = typeof s.lib === 'string' && LIB.test(s.lib) && !s.lib.includes('..') ? { lib: s.lib } : typeof s.ram === 'string' && REF.test(s.ram) ? { ram: s.ram } : null;
  if (!src) return null;
  const h = rec(x.hand);
  const nm = name(x.name);
  return {
    id: x.id, ...(nm ? { name: nm } : {}), kind: x.kind, src, pin, place: sanitizePlace(x.place), layer: x.layer === 'behind' ? 'behind' : 'front',
    ...(typeof x.opacity === 'number' ? { opacity: num(x.opacity, 0, 1, 1) } : {}),
    ...(typeof h.pose === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(h.pose) ? { hand: { pose: h.pose } } : {}),
    ...(typeof x.speed === 'number' ? { speed: num(x.speed, 0.1, 4, 1) } : {}),
    ...(typeof x.ttlSecs === 'number' && x.ttlSecs > 0 ? { ttlSecs: num(x.ttlSecs, 0.5, 3600, 10) } : {}),
  };
}

/** Decoded size of a base64 string without decoding it. */
export const b64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

export function sanitizeItemData(o: unknown): ItemData | null {
  const x = rec(o);
  if (typeof x.ref !== 'string' || !REF.test(x.ref) || typeof x.b64 !== 'string' || !(ITEM_MIMES as readonly unknown[]).includes(x.mime)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(x.b64) || b64Bytes(x.b64) > ITEM_LIMITS.maxBytes) return null;
  return { ref: x.ref, mime: x.mime as ItemMime, b64: x.b64 };
}

/** A bus ItemOp, cleaned. A `ram` item with no matching `data` is refused here: nothing can show it. */
export function sanitizeItemOp(o: unknown): ItemOp | null {
  const x = rec(o);
  const target = typeof x.target === 'string' && TARGET.test(x.target) ? x.target : undefined;
  const t = target ? { target } : {};
  const id = typeof x.id === 'string' && ID.test(x.id) ? x.id : '';
  const nm = name(x.name);
  switch (x.op) {
    case 'add': {
      const item = sanitizeItemSpec(x.item);
      if (!item) return null;
      const data = x.data === undefined ? undefined : sanitizeItemData(x.data);
      if (x.data !== undefined && !data) return null;
      if ('ram' in item.src && (!data || data.ref !== item.src.ram)) return null;
      const by = SOURCES.includes(x.by as ItemSource) ? x.by as ItemSource : undefined;
      return { op: 'add', item, ...(data ? { data } : {}), ...t, ...(by ? { by } : {}) };
    }
    case 'move': {
      if (!id) return null;
      const place = placePatch(x.place);
      return { op: 'move', id, ...(place ? { place } : {}), ...(x.layer === 'front' || x.layer === 'behind' ? { layer: x.layer } : {}), ...(typeof x.opacity === 'number' ? { opacity: num(x.opacity, 0, 1, 1) } : {}), ...t };
    }
    case 'pin': { const pin = sanitizePin(x.pin); if (!id || !pin) return null; const place = placePatch(x.place); return { op: 'pin', id, pin, ...(place ? { place } : {}), ...t }; }
    case 'remove': return id ? { op: 'remove', id, ...t } : null;
    case 'clear': { const by = SOURCES.includes(x.by as ItemSource) ? x.by as ItemSource : undefined; return { op: 'clear', ...t, ...(by ? { by } : {}) }; }
    case 'list': return { op: 'list', ...t, ...(typeof x.req === 'string' && REF.test(x.req) ? { req: x.req } : {}) };
    case 'scene-save': return nm ? { op: 'scene-save', name: nm, ...t, ...(typeof x.secs === 'number' && x.secs > 0 ? { secs: num(x.secs, 1, 3600, 30) } : {}) } : null;
    case 'scene-apply': { const by = SOURCES.includes(x.by as ItemSource) ? x.by as ItemSource : undefined; return nm ? { op: 'scene-apply', name: nm, ...t, ...(x.mode === 'add' ? { mode: 'add' as const } : {}), ...(by ? { by } : {}) } : null; }
    case 'scene-toggle': { const by = SOURCES.includes(x.by as ItemSource) ? x.by as ItemSource : undefined; return nm ? { op: 'scene-toggle', name: nm, on: x.on === true ? true : x.on === false ? false : 'toggle', ...t, ...(by ? { by } : {}) } : null; }
    case 'scene-delete': return nm ? { op: 'scene-delete', name: nm } : null;
  }
  return null;
}

/** An item scene as the host saves it: RAM-only items are dropped (custody), the rest cleaned. */
export function sanitizeItemScene(o: unknown): ItemScene | null {
  const x = rec(o), nm = name(x.name);
  if (!nm) return null;
  const items = (Array.isArray(x.items) ? x.items : []).slice(0, ITEM_LIMITS.maxSceneItems).map(sanitizeItemSpec).filter((i): i is ItemSpec => !!i && 'lib' in i.src);
  return { name: nm, items, ...(typeof x.secs === 'number' && x.secs > 0 ? { secs: num(x.secs, 1, 3600, 30) } : {}) };
}
export function sanitizeItemScenes(o: unknown): ItemScene[] {
  const out: ItemScene[] = [], seen = new Set<string>();
  for (const v of (Array.isArray(o) ? o : []).slice(0, ITEM_LIMITS.maxScenes)) { const s = sanitizeItemScene(v); if (s && !seen.has(s.name.toLowerCase())) { seen.add(s.name.toLowerCase()); out.push(s); } }
  return out;
}

/** What may go into SceneState / a file from an op: the same op with the RAM data removed (nothing of another person's picture is kept). */
export function stripItemData(op: ItemOp): ItemOp {
  if (op.op !== 'add' || !op.data) return op;
  const { data: _data, ...rest } = op;
  void _data;
  return rest;
}

// ================================================================ items lane additions (beta.16, all additive)
//
// The studio is the only page that decides anything (random picks, scene contents, limits). It applies an op to its own
// ItemStore and tells every OBS page what to do as PRIMITIVE ops (a scene becomes the removes and adds it came to), so no
// page ever has to know the saved scenes or roll its own dice:
//
//   command 'item-play'  studio -> OBS pages   args = ItemPlay   the primitive ops that were just applied (RAM pictures ride along, once)
//   command 'item-need'  OBS page -> studio    "I just opened: send me what is on"
//   command 'item-sync'  studio -> OBS pages   args = ItemSync   everything that is on now (+ the RAM pictures it needs)
//
// Both stay on the live bus (RAM only): nothing here is written to disk, SceneState or relayed to party guests.
// SceneState.modes.items (ITEMS_BAG) keeps only the host's own library items that are on, so a studio reload puts them back.

export const ITEM_PLAY_COMMAND = 'item-play';
export const ITEM_NEED_COMMAND = 'item-need';
export const ITEM_SYNC_COMMAND = 'item-sync';
export const ITEMS_BAG = 'items';

/** Size of one item at scale 1: its longer side, in metres on a 1.6 m tall avatar (other heights scale with the avatar). */
export const ITEM_BASE_M = 0.2;
/** The avatar height the metres above are quoted for. */
export const ITEM_REF_HEIGHT_M = 1.6;

export type PrimitiveItemOp = Extract<ItemOp, { op: 'add' | 'move' | 'pin' | 'remove' | 'clear' }>;
export interface ItemPlay { ops: PrimitiveItemOp[] }
export interface ItemSync { items: (ItemSpec & { by?: ItemSource; scene?: string })[]; data: ItemData[] }

const PRIMITIVE = new Set(['add', 'move', 'pin', 'remove', 'clear']);
export function sanitizeItemPlay(o: unknown): ItemPlay | null {
  const x = rec(o);
  if (!Array.isArray(x.ops)) return null;
  const ops: PrimitiveItemOp[] = [];
  for (const v of x.ops.slice(0, ITEM_LIMITS.maxItems * 2 + 4)) {
    const op = sanitizeItemOp(v);
    if (op && PRIMITIVE.has(op.op)) ops.push(op as PrimitiveItemOp);
  }
  return ops.length ? { ops } : null;
}
export function sanitizeItemSync(o: unknown): ItemSync | null {
  const x = rec(o);
  const items: ItemSync['items'] = [];
  for (const v of (Array.isArray(x.items) ? x.items : []).slice(0, ITEM_LIMITS.maxItems)) {
    const s = sanitizeItemSpec(v), r = rec(v);
    if (!s) continue;
    items.push({ ...s, ...(SOURCES.includes(r.by as ItemSource) ? { by: r.by as ItemSource } : {}), ...(name(r.scene) ? { scene: name(r.scene) } : {}) });
  }
  const data: ItemData[] = [];
  for (const v of (Array.isArray(x.data) ? x.data : []).slice(0, ITEM_LIMITS.maxRamItems)) { const d = sanitizeItemData(v); if (d) data.push(d); }
  return { items, data };
}

/** The host's own library items that are on right now (what a studio reload puts back). Never a RAM picture, never a timed one. */
export interface ItemsBag { v: 1; items: (ItemSpec & { by?: ItemSource; scene?: string })[]; /** the scene used last (the deck "Item scene" with no name) */ last?: string }
export const ITEMS_BAG_MAX_ITEMS = 12;
export function sanitizeItemsBag(o: unknown): ItemsBag {
  const x = rec(o), items: ItemsBag['items'] = [];
  for (const v of (Array.isArray(x.items) ? x.items : [])) {
    if (items.length >= ITEMS_BAG_MAX_ITEMS) break;
    const s = sanitizeItemSpec(v), r = rec(v);
    if (!s || !('lib' in s.src) || s.ttlSecs) continue;
    if (items.some((i) => i.id === s.id)) continue;
    items.push({ ...s, ...(SOURCES.includes(r.by as ItemSource) ? { by: r.by as ItemSource } : {}), ...(name(r.scene) ? { scene: name(r.scene) } : {}) });
  }
  const last = name(x.last);
  const bag: ItemsBag = { v: 1, items, ...(last ? { last } : {}) };
  // the mode bag is capped at 6 KB (shared/stage.ts): drop from the end until it fits with room to spare
  while (bag.items.length && JSON.stringify(bag).length > 5200) bag.items.pop();
  return bag;
}

// ---------------------------------------------------------------- where things go, in plain words

/** What a pin means to a person. `place` is in metres for a 1.6 m avatar, in the pin's own frame (the avatar's own axes, so a hat
 *  tilts with the head). `outward`: x counts away from the body's middle, so the left and right hand share one number. */
export interface PinChoice {
  id: string;
  label: string;
  group: 'head' | 'body' | 'hands' | 'free';
  pin: ItemPin;
  place: ItemPlace;
  layer: ItemLayer;
  outward?: boolean;
  /** A held prop: how the hand closes while it is on. */
  hand?: { pose: HandPose };
  /** Bones to try in this order when the avatar has no `pin.bone` (a VRM without a shoulder bone ...). */
  fallback?: string[];
}

export const HAND_POSES = ['hold', 'loose', 'flat'] as const;
export type HandPose = (typeof HAND_POSES)[number];
/** The finger curl each hand pose asks the retargeter for (src/avatar/retarget.ts grip: 0 = open ... 1 = closed round a handle). */
export const HAND_POSE_CURL: Record<HandPose, number> = { hold: 1, loose: 0.55, flat: 0 };
export const HAND_POSE_LABEL: Record<HandPose, string> = { hold: 'Hold it tight', loose: 'Hold it loosely', flat: 'Open hand (a sign, a plate)' };
/** Which hand a bone name belongs to (a pin on `leftHand` closes the left hand ...). */
export const handSideOf = (bone: string): 'left' | 'right' | null => (/^left(Hand|Thumb|Index|Middle|Ring|Little)/.test(bone) ? 'left' : /^right(Hand|Thumb|Index|Middle|Ring|Little)/.test(bone) ? 'right' : null);

const PL = (x: number, y: number, z: number, scale = 1, rot = 0): ItemPlace => ({ x, y, z, rot, scale });
export const PIN_CHOICES: readonly PinChoice[] = [
  { id: 'head-top', label: 'On top of my head', group: 'head', pin: { to: 'bone', bone: 'head' }, place: PL(0, 0.22, 0.01, 1.1), layer: 'front' },
  { id: 'forehead', label: 'On my forehead', group: 'head', pin: { to: 'face' }, place: PL(0, 0.075, 0), layer: 'front' },
  { id: 'temple', label: 'By my eye (side of my head)', group: 'head', pin: { to: 'face' }, place: PL(0.065, 0.065, 0, 0.8), layer: 'front' },
  { id: 'eye-l', label: 'Under my left eye', group: 'head', pin: { to: 'face' }, place: PL(0.034, -0.032, 0, 0.45), layer: 'front' },
  { id: 'eye-r', label: 'Under my right eye', group: 'head', pin: { to: 'face' }, place: PL(-0.034, -0.032, 0, 0.45), layer: 'front' },
  { id: 'cheek-l', label: 'On my left cheek', group: 'head', pin: { to: 'face' }, place: PL(0.052, -0.05, 0, 0.6), layer: 'front' },
  { id: 'cheek-r', label: 'On my right cheek', group: 'head', pin: { to: 'face' }, place: PL(-0.052, -0.05, 0, 0.6), layer: 'front' },
  { id: 'face', label: 'Over my face', group: 'head', pin: { to: 'face' }, place: PL(0, -0.01, 0.01, 1.2), layer: 'front' },
  { id: 'behind-head', label: 'Behind my head', group: 'head', pin: { to: 'bone', bone: 'head' }, place: PL(0, 0.1, -0.12, 1.8), layer: 'behind' },
  { id: 'neck', label: 'Around my neck', group: 'body', pin: { to: 'bone', bone: 'neck' }, place: PL(0, 0.01, 0.07, 0.9), layer: 'front', fallback: ['head'] },
  { id: 'chest', label: 'On my chest', group: 'body', pin: { to: 'bone', bone: 'upperChest' }, place: PL(0, 0.02, 0.12, 1.1), layer: 'front', fallback: ['chest', 'spine'] },
  { id: 'back', label: 'On my back', group: 'body', pin: { to: 'bone', bone: 'upperChest' }, place: PL(0, 0.02, -0.14, 2), layer: 'behind', fallback: ['chest', 'spine'] },
  { id: 'shoulder-l', label: 'On my left shoulder', group: 'body', pin: { to: 'bone', bone: 'leftShoulder' }, place: PL(0.07, 0.06, 0.02, 0.8), layer: 'front', outward: true, fallback: ['leftUpperArm'] },
  { id: 'shoulder-r', label: 'On my right shoulder', group: 'body', pin: { to: 'bone', bone: 'rightShoulder' }, place: PL(0.07, 0.06, 0.02, 0.8), layer: 'front', outward: true, fallback: ['rightUpperArm'] },
  { id: 'hand-l', label: 'In my left hand', group: 'hands', pin: { to: 'bone', bone: 'leftHand' }, place: PL(0.07, 0, 0.04, 1.3), layer: 'front', outward: true, hand: { pose: 'hold' } },
  { id: 'hand-r', label: 'In my right hand', group: 'hands', pin: { to: 'bone', bone: 'rightHand' }, place: PL(0.07, 0, 0.04, 1.3), layer: 'front', outward: true, hand: { pose: 'hold' } },
  { id: 'stay', label: 'Stay where I put it (does not follow my body)', group: 'free', pin: { to: 'screen' }, place: PL(0.5, 1.2, 0.2, 1.6), layer: 'front' },
];
export const pinChoice = (id: string): PinChoice | undefined => PIN_CHOICES.find((c) => c.id === id);
/** The choice that describes an existing pin best (for the "Where" menu). */
export function choiceOfPin(pin: ItemPin, place?: ItemPlace): string {
  if (pin.to === 'screen') return 'stay';
  const same = PIN_CHOICES.filter((c) => (pin.to === 'face' ? c.pin.to === 'face' : c.pin.to === 'bone' && pin.to === 'bone' && c.pin.bone === pin.bone));
  if (!same.length) return pin.to === 'face' ? 'face' : '';
  if (!place || same.length === 1) return same[0].id;
  let best = same[0], bd = Infinity;
  for (const c of same) { const d = Math.hypot(c.place.x - place.x, c.place.y - place.y, c.place.z - place.z); if (d < bd) { bd = d; best = c; } }
  return best.id;
}

/** Which anchor is nearest a point on the picture (the drop position): `points` are the anchors projected to 0..1 screen coordinates. */
export function nearestPin(points: readonly { id: string; x: number; y: number }[], px: number, py: number): string | null {
  let best: string | null = null, bd = Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d < bd) { bd = d; best = p.id; }
  }
  return best;
}

// ---------------------------------------------------------------- the picture / model kinds

/** What bytes a dropped file is (by its first bytes, never by its name). Null: not something an item can be. */
export function sniffItemMime(b: Uint8Array): ItemMime | null {
  if (b.length >= 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    // an animated PNG has an acTL chunk before the first IDAT
    for (let i = 8; i + 8 < Math.min(b.length, 4096);) {
      const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      const t = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      if (t === 'acTL') return 'image/apng';
      if (t === 'IDAT') break;
      i += 12 + len;
    }
    return 'image/png';
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46) return 'model/gltf-binary';
  return null;
}
export const itemKindOf = (m: ItemMime): ItemKind => (m === 'model/gltf-binary' ? 'model' : 'image');
export const ITEM_EXT: Record<ItemMime, string> = { 'image/png': 'png', 'image/apng': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'model/gltf-binary': 'glb' };
/** The content type a library file is served as, from its extension. */
export const ITEM_TYPE_OF_EXT: Record<string, string> = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', glb: 'model/gltf-binary' };
export const libKind = (lib: string): ItemKind => (/\.glb$/i.test(lib) ? 'model' : 'image');

/** A bare file name for the host's own item library: letters, digits, dash; never a path. */
export function itemFileName(raw: string, ext: string): string {
  const base = raw.replace(/\.[A-Za-z0-9]{1,5}$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
  return `${base}.${ext}`;
}

// ---------------------------------------------------------------- the starter stickers (assets/library/stickers/index.json)

export interface StickerDef {
  /** a-z0-9-. */
  id: string;
  /** File name inside assets/library/stickers/. */
  file: string;
  /** Plain name for the grid. */
  name: string;
  /** The PIN_CHOICES id it goes to first. */
  pin: string;
  /** Overrides of the choice's place (scale ...). */
  place?: Partial<ItemPlace>;
  layer?: ItemLayer;
  hand?: { pose: HandPose };
}
export interface StickerIndex { licence: string; stickers: StickerDef[] }
export function sanitizeStickerIndex(o: unknown): StickerIndex {
  const x = rec(o), out: StickerDef[] = [];
  for (const v of (Array.isArray(x.stickers) ? x.stickers : []).slice(0, 60)) {
    const r = rec(v), pc = placePatch(r.place);
    if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(r.id) || typeof r.file !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}\.(png|gif|webp)$/.test(r.file)) continue;
    const nm = name(r.name);
    if (!nm || !pinChoice(String(r.pin)) || out.some((s) => s.id === r.id)) continue;
    const hp = rec(r.hand).pose;
    out.push({ id: r.id, file: r.file, name: nm, pin: String(r.pin), ...(pc ? { place: pc } : {}), ...(r.layer === 'behind' ? { layer: 'behind' as const } : r.layer === 'front' ? { layer: 'front' as const } : {}), ...((HAND_POSES as readonly unknown[]).includes(hp) ? { hand: { pose: hp as HandPose } } : {}) });
  }
  return { licence: typeof x.licence === 'string' ? x.licence.slice(0, 40) : '', stickers: out };
}

/** The ItemSpec that putting `choice` on the avatar means. */
export function specForChoice(id: string, kind: ItemKind, src: ItemSrc, choice: PinChoice, over?: { place?: Partial<ItemPlace>; layer?: ItemLayer; hand?: { pose: HandPose } | null; name?: string }): ItemSpec {
  const place = sanitizePlace({ ...choice.place, ...over?.place });
  const hand = over?.hand === null ? undefined : over?.hand ?? choice.hand;
  const nm = name(over?.name);
  return { id, ...(nm ? { name: nm } : {}), kind, src, pin: choice.pin, place, layer: over?.layer ?? choice.layer, ...(hand ? { hand: { pose: hand.pose } } : {}) };
}

/** An id for a new item that is not taken: `base`, `base-2`, `base-3` ... */
export function freeItemId(base: string, taken: (id: string) => boolean): string {
  const b = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 40) || 'item';
  if (!taken(b)) return b;
  for (let i = 2; i < 1000; i++) { const id = `${b}-${i}`.slice(0, 48); if (!taken(id)) return id; }
  return `${b.slice(0, 30)}-${Math.random().toString(36).slice(2, 8)}`;
}
