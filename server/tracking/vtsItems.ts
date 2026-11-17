// VTube Studio API, pack 2 (beta.16, docs/b16/VTS_API.md): the requests a plugin sends about the MODEL and ITEMS.
//
//   MoveModelRequest / CurrentModelRequest  ->  bus `model-move` / `model-state` (+ `model-state-reply`)   shared/b16Commands.ts
//   ArtMeshListRequest / ColorTintRequest   ->  bus `art-list` (+ `-reply`) / `art-tint`                    shared/b16Commands.ts
//   ItemList / ItemLoad / ItemUnload / ItemMove / ItemPin / ItemAnimationControl  ->  bus `item` ops        shared/avatarItems.ts
//   ModelMovedEvent / ItemEvent / ModelClickedEvent                                                         bus `model-state`, `item-event`, `model-clicked`
//   PermissionRequest                       ->  answered here (LoadCustomImagesAsItems is granted to a plugin the user approved)
//
// This file knows nothing about sockets or sessions: server/tracking/vtsApi.ts hands it a parsed request and sends back what it
// returns. It talks to the studio ONLY through bus commands (the studio page owns the avatar), so a studio without the beta.16
// lanes simply never answers; every request then falls back to something a plugin can live with (see each handler).
//
// CUSTODY (AGENTS.md rule 7): a picture a plugin sends (`customDataBase64`) is forwarded on the bus once, as ItemData, and is
// never kept: not on disk, not in this object, not in SceneState. Size limits are ITEM_LIMITS (2 MB each, 20 items).
//
// Spec read for this file (MIT, github.com/DenchiSoft/VTubeStudio): README.md (CurrentModel, MoveModel, ArtMeshList, ColorTint,
// Item*, Permissions), Events/README.md (ModelMoved, Item, ModelClicked), Files/ErrorID.cs. Nothing of the VTS app was used.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BusMessage } from '../../shared/types.ts';
import { ROOT } from '../paths.ts';
import {
  ITEM_COMMAND, ITEM_EVENT_COMMAND, ITEM_LIMITS, ITEM_STATE_COMMAND, itemBusMessage, sanitizeItemOp, sanitizeItemSpec,
  type ItemKind, type ItemMime, type ItemOp, type ItemPin, type ItemPlace, type ItemSource, type ItemSpec, type ItemState,
} from '../../shared/avatarItems.ts';
import {
  ART_LIST_COMMAND, ART_TINT_COMMAND, MODEL_MOVE_COMMAND, MODEL_STATE_COMMAND, commandMessage, replyOf, sanitizeArtTint, sanitizeModelMove,
  type ArtList, type ModelState,
} from '../../shared/b16Commands.ts';

// ---------------------------------------------------------------- errors (Files/ErrorID.cs)

export class VtsApiError extends Error { constructor(public id: number, msg: string) { super(msg); } }

export const VTS_ERR = {
  RequestRequiresPermission: 9,
  ColorTintRequestNoModelLoaded: 250, ColorTintRequestMatchOrColorMissing: 251, ColorTintRequestInvalidColorValue: 252,
  MoveModelRequestNoModelLoaded: 300, MoveModelRequestMissingFields: 301, MoveModelRequestValuesOutOfRange: 302,
  ItemFileNameMissing: 750, ItemFileNameNotFound: 751, CannotCurrentlyLoadItem: 753, CannotLoadItemSceneFull: 754, ItemOrderInvalid: 755,
  ItemOrderAlreadyTaken: 756, ItemLoadValuesInvalid: 757, ItemCustomDataInvalid: 758,
  ItemAnimationControlInstanceIDNotFound: 850, ItemAnimationControlSimpleImageDoesNotSupportAnim: 854,
  ItemMoveRequestInstanceIDNotFound: 900, ItemMoveRequestInvalidFadeMode: 901, ItemMoveRequestItemOrderTakenOrInvalid: 902,
  ItemPinRequestGivenItemNotLoaded: 1050, ItemPinRequestInvalidAngleOrSizeType: 1051, ItemPinRequestModelNotFound: 1052,
  ItemPinRequestArtMeshNotFound: 1053, ItemPinRequestPinPositionInvalid: 1054,
  PermissionRequestUnknownPermission: 1100,
} as const;

/** The request types this file answers (vtsApi.ts routes them here after the authentication check). */
export const VTS_BRIDGE_TYPES: ReadonlySet<string> = new Set([
  'MoveModelRequest', 'ArtMeshListRequest', 'ColorTintRequest', 'PermissionRequest',
  'ItemListRequest', 'ItemLoadRequest', 'ItemUnloadRequest', 'ItemAnimationControlRequest', 'ItemMoveRequest', 'ItemPinRequest',
]);

// ---------------------------------------------------------------- plain helpers

const clampN = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strs = (v: unknown, max = 256): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 128).slice(0, max) : []);
/** A missing field, null, or VTS's "ignore this" value (-1000 or lower for item moves). */
const given = (v: unknown) => v !== undefined && v !== null;

/** VTS "size" of an item is 0..1 with 0.32 about the default a user gets; our ItemPlace.scale 1 is that default. */
export const VTS_ITEM_DEFAULT_SIZE = 0.32;
/** Item rotation: VTS counts degrees clockwise; ItemPlace.rot is counter-clockwise (the items lane renders it that way). One place to flip it. */
export const ROT_SIGN = -1;
/** An unpinned (`screen`) item sits at x, y in 0..1 of the frame (shared/avatarItems.ts ItemPin); y grows downwards. VTS: -1..1, y up. */
export const SCREEN_Y_DOWN = true;

export const vtsToScreen = (x: number, y: number) => ({ x: clampN((x + 1) / 2, -4, 5), y: clampN(SCREEN_Y_DOWN ? (1 - y) / 2 : (y + 1) / 2, -4, 5) });
export const screenToVts = (x: number, y: number) => ({ x: x * 2 - 1, y: SCREEN_Y_DOWN ? 1 - y * 2 : y * 2 - 1 });
export const vtsSizeToScale = (size: number) => clampN(size / VTS_ITEM_DEFAULT_SIZE, 0.01, 20);
export const scaleToVtsSize = (scale: number) => clampN(scale * VTS_ITEM_DEFAULT_SIZE, 0, 1);
export const posRot = (deg: number) => ((deg % 360) + 360) % 360;

/** The VTS order spots: negative = behind the model, positive = in front (0 is never free). */
export const ORDER_MIN = -30;
export const ORDER_MAX = 30;

const EASE: Record<string, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeBoth: (t) => t * t * (3 - 2 * t),
  overshoot: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  zip: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
};
export const FADE_MODES = Object.keys(EASE);

// ---------------------------------------------------------------- a plugin's picture (RAM only)

export type VtsItemType = 'PNG' | 'JPG' | 'GIF' | 'AnimationFolder' | 'Live2D';
export interface PluginImage { mime: ItemMime; type: VtsItemType; bytes: number; width: number; height: number; frames: number; b64: string }

/** VTS: 64..2048 px each way, at most 1024 GIF frames. The size limit is ours (ITEM_LIMITS.maxBytes). */
export const IMAGE_LIMITS = { minPx: 64, maxPx: 2048, maxFrames: 1024 } as const;

/** Decode and look into a plugin's base64 picture. Returns null for anything that is not a PNG / APNG / JPEG / GIF inside the limits. */
export function inspectPluginImage(input: unknown): PluginImage | null {
  if (typeof input !== 'string' || input.length < 16 || input.length > Math.ceil(ITEM_LIMITS.maxBytes * 4 / 3) + 4096) return null;
  const clean = input.replace(/^data:[^;,]{1,40};base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  const buf = Buffer.from(clean, 'base64');
  if (buf.length < 16 || buf.length > ITEM_LIMITS.maxBytes) return null;
  let mime: ItemMime, type: VtsItemType, w = 0, h = 0, frames = 1;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    mime = 'image/png'; type = 'PNG';
    w = buf.readUInt32BE(16); h = buf.readUInt32BE(20);
    // walk the chunks until the first IDAT: an acTL chunk before it makes it an animated PNG
    for (let p = 8; p + 8 <= buf.length;) {
      const len = buf.readUInt32BE(p), name = buf.toString('latin1', p + 4, p + 8);
      if (name === 'acTL' && p + 16 <= buf.length) { mime = 'image/apng'; frames = Math.max(1, buf.readUInt32BE(p + 8)); }
      if (name === 'IDAT' || name === 'IEND') break;
      p += 12 + len;
    }
  } else if (buf.toString('latin1', 0, 3) === 'GIF' && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) {
    mime = 'image/gif'; type = 'GIF';
    w = buf.readUInt16LE(6); h = buf.readUInt16LE(8);
    frames = countGifFrames(buf);
  } else if (buf[0] === 0xff && buf[1] === 0xd8) {
    mime = 'image/jpeg'; type = 'JPG';
    for (let p = 2; p + 9 < buf.length;) {
      if (buf[p] !== 0xff) { p++; continue; }
      const m = buf[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = buf.readUInt16BE(p + 5); w = buf.readUInt16BE(p + 7); break; }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
      p += 2 + buf.readUInt16BE(p + 2);
    }
  } else return null;
  if (w < IMAGE_LIMITS.minPx || h < IMAGE_LIMITS.minPx || w > IMAGE_LIMITS.maxPx || h > IMAGE_LIMITS.maxPx) return null;
  if (frames < 1 || frames > IMAGE_LIMITS.maxFrames) return null;
  return { mime, type, bytes: buf.length, width: w, height: h, frames, b64: buf.toString('base64') };
}

function countGifFrames(b: Buffer): number {
  let p = 13, n = 0;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
  while (p < b.length) {
    const t = b[p++];
    if (t === 0x3b) break;
    if (t === 0x2c) {
      n++;
      if (p + 9 > b.length) break;
      const flags = b[p + 8];
      p += 9;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++;                                     // LZW minimum code size
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p++;
    } else if (t === 0x21) {
      p++;                                     // extension label
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p++;
    } else break;
    if (n > IMAGE_LIMITS.maxFrames) break;
  }
  return n;
}

// ---------------------------------------------------------------- item files the plugin may load by name

export interface VtsItemFile { fileName: string; type: VtsItemType; /** asset id in the host's library (ItemSrc.lib) */ lib: string; kind: ItemKind }

// (ROOT from server/paths.ts, like server/routes/items.ts: a path built from import.meta.url is wrong in the bundled helper, where every
// module shares dist-helper/index.mjs as its URL)
export const STICKER_DIR = path.join(ROOT, 'assets', 'library', 'stickers');
let stickerCache: { at: number; list: VtsItemFile[] } | null = null;
/** Default item files: the starter stickers the items lane ships in assets/library/stickers (read-only, a short cache). */
export function defaultItemFiles(): VtsItemFile[] {
  if (stickerCache && Date.now() - stickerCache.at < 10_000) return stickerCache.list;
  const list: VtsItemFile[] = [];
  try {
    for (const f of fs.readdirSync(STICKER_DIR).sort()) {
      const m = /\.(png|jpe?g|gif)$/i.exec(f);
      if (!m || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(f)) continue;
      list.push({ fileName: f, type: /gif/i.test(m[1]) ? 'GIF' : /jpe?g/i.test(m[1]) ? 'JPG' : 'PNG', lib: `stickers/${f}`, kind: 'image' });
    }
  } catch { /* no stickers folder (yet) */ }
  stickerCache = { at: Date.now(), list: list.slice(0, 500) };
  return stickerCache.list;
}

// ---------------------------------------------------------------- the bus: ask the studio, wait for its answer

export class VtsBus {
  private waits = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  constructor(private send: (m: BusMessage) => void, private timeoutMs = 700) {}

  newReq() { return `v${(++this.seq).toString(36)}${crypto.randomBytes(3).toString('hex')}`; }

  /** Send `command` and wait for `${command}-reply` (or `replyCommand`) carrying the same `req`. null = nobody answered in time. */
  request<T>(command: string, args: Record<string, unknown>, replyCommand = replyOf(command), ms = this.timeoutMs): Promise<T | null> {
    const req = typeof args.req === 'string' ? args.req : this.newReq();
    const key = `${replyCommand}|${req}`;
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => { this.waits.delete(key); resolve(null); }, ms);
      timer.unref?.();
      this.waits.set(key, { resolve: (v) => resolve(v as T), timer });
      this.send(commandMessage(command, { ...args, req }));
    });
  }

  /** A reply came in; true when somebody was waiting for it. */
  settle(replyCommand: string, req: unknown, value: unknown): boolean {
    if (typeof req !== 'string') return false;
    const key = `${replyCommand}|${req}`, w = this.waits.get(key);
    if (!w) return false;
    clearTimeout(w.timer); this.waits.delete(key); w.resolve(value);
    return true;
  }

  stop() { for (const w of this.waits.values()) { clearTimeout(w.timer); w.resolve(null); } this.waits.clear(); }
  get pendingCount() { return this.waits.size; }
}

// ---------------------------------------------------------------- the bridge

/** What the bridge needs to know about a plugin's connection (vtsApi.ts's Session satisfies it). */
export interface BridgeSession { key: string; pluginName: string; perms: Set<string> }

export interface BridgeDeps {
  /** Server-originated bus message (the helper's `broadcast`). */
  send(m: BusMessage): void;
  /** Send an event to the plugins subscribed to `name` (filtered by their config), or only to `only`. */
  emit(name: string, data: unknown, opts?: { filter?: (cfg: unknown) => boolean; only?: BridgeSession }): void;
  /** How many plugins are subscribed to an event (the model-moved poll only runs when somebody listens). */
  subscribers(name: string): number;
  currentAvatar(): { id: string; name: string } | null;
  /** Item files a plugin may load by name. Default: the starter stickers. */
  itemFiles?(): VtsItemFile[];
  /** How long to wait for the studio's answer (ms). */
  timeoutMs?: number;
}

interface MItem {
  id: string; fileName: string; type: VtsItemType; spec: ItemSpec; by?: ItemSource; owner?: string; unloadOnDisconnect: boolean;
  order: number; flipped: boolean; locked: boolean; censored: boolean; smoothing: number; framerate: number; frameCount: number; addedAt: number; seen: boolean;
}
interface Glide { id: string; t0: number; dur: number; from: { x: number; y: number; rot: number; scale: number }; to: { x: number; y: number; rot: number; scale: number }; ease: (t: number) => number;
  /** the last place sent for this glide (a step that moved less than GLIDE_EPS is not sent) */
  sent?: { x: number; y: number; rot: number; scale: number } }

/** R3-12: a glide step smaller than this (screen fractions / degrees / scale) changes nothing anyone can see: not sent. */
const GLIDE_EPS = { pos: 0.0005, rot: 0.05, scale: 0.001 };
/** With this many items gliding at once the steps run at half rate (each step is a bus message on every page; the studio takes ops one at a time). */
const GLIDE_CROWD = 8;
const GLIDE_STEP_MS = 33;

const PERMISSIONS = ['LoadCustomImagesAsItems', 'ControlNDISettings'] as const;
const GRANTABLE = new Set<string>(['LoadCustomImagesAsItems']);
/** VTS humanoid-ish pin targets a plugin may name (case and separators ignored) -> the avatar's bone name. */
const BONES: Record<string, string> = {
  head: 'head', face: 'head', neck: 'neck', chest: 'chest', upperchest: 'upperChest', spine: 'spine', hips: 'hips', body: 'chest',
  lefthand: 'leftHand', righthand: 'rightHand', handl: 'leftHand', handr: 'rightHand', leftshoulder: 'leftShoulder', rightshoulder: 'rightShoulder',
  leftupperarm: 'leftUpperArm', rightupperarm: 'rightUpperArm', lefteye: 'leftEye', righteye: 'rightEye', jaw: 'jaw',
};
const boneOf = (name: string) => BONES[name.toLowerCase().replace(/[^a-z]/g, '')] ?? null;

export class VtsBridge {
  readonly bus: VtsBus;
  private items = new Map<string, MItem>();
  private scenes: ItemState['scenes'] = [];
  private lastItemsAt = 0;
  private glides = new Map<string, Glide>();
  private lastGlideStep = 0;
  private glideTimer: ReturnType<typeof setInterval> | null = null;
  private quiet = new Map<string, number>();
  /** Items we removed a moment ago: an item-state the studio sent before it saw the remove must not bring them back. */
  private gone = new Map<string, number>();
  private modelLast: ModelState | null = null;
  private modelSent: ModelState | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private artLast: { at: number; art: ArtList } | null = null;
  private tinted = new Set<string>();
  private loadBytes = new Map<string, { at: number; bytes: number }[]>();

  constructor(private deps: BridgeDeps) {
    this.bus = new VtsBus((m) => deps.send(m), deps.timeoutMs ?? 700);
  }

  private files(): VtsItemFile[] { return (this.deps.itemFiles ?? defaultItemFiles)(); }
  private send(command: string, args: unknown) { this.deps.send(commandMessage(command, args)); }
  private sendOp(op: ItemOp) { this.deps.send(itemBusMessage(op)); }

  stop() {
    this.bus.stop();
    if (this.glideTimer) clearInterval(this.glideTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.glideTimer = this.pollTimer = null;
    this.glides.clear();
    // items the plugins asked to be taken away with them
    for (const it of this.items.values()) if (it.unloadOnDisconnect) this.sendOp({ op: 'remove', id: it.id });
    this.items.clear();
  }

  // ---------------------------------------------------------------- bus in (the studio's answers and events)

  /** Feed every bus message the helper hears here. Returns true when the message was one of ours. */
  onBusMessage(msg: unknown): boolean {
    const m = rec(msg);
    if (m.type !== 'command' || typeof m.command !== 'string') return false;
    const a = m.args;
    switch (m.command) {
      case replyOf(MODEL_STATE_COMMAND): { const s = cleanModelState(a); if (s) { this.modelLast = s; this.bus.settle(m.command, rec(a).req, s); } return true; }
      case replyOf(ART_LIST_COMMAND): { const l = cleanArtList(a); if (l) { this.artLast = { at: Date.now(), art: l }; this.bus.settle(m.command, rec(a).req, l); } return true; }
      case ITEM_STATE_COMMAND: this.onItemState(a); return true;
      case ITEM_EVENT_COMMAND: this.onItemEvent(a); return true;
      case 'model-clicked': this.onModelClicked(a); return true;
    }
    return false;
  }

  /** An item is gone: its glide and its "our own move" stamp go with it. (`gone` is NOT cleared here: it is the 5 s "do not bring it
   *  back from a stale item-state" guard, and it ages out in sweepStamps.) */
  private forget(id: string) { this.items.delete(id); this.glides.delete(id); this.quiet.delete(id); }
  /** Drop the stamps whose time is up, so a plugin that spawns and removes items all stream never grows these maps. */
  private sweepStamps() {
    if (this.gone.size <= 32 && this.quiet.size <= 32) return;
    const now = Date.now();
    for (const [k, t] of this.gone) if (t < now) this.gone.delete(k);
    for (const [k, t] of this.quiet) if (t < now) this.quiet.delete(k);
  }

  private onItemState(a: unknown) {
    const s = rec(a);
    if (s.target !== undefined && s.target !== '@host') return;          // a guest's items are not the plugin's business
    const now = Date.now(), seen = new Set<string>();
    for (const raw of Array.isArray(s.items) ? s.items.slice(0, ITEM_LIMITS.maxItems * 2) : []) {
      const spec = sanitizeItemSpec(raw);
      if (!spec) continue;
      if ((this.gone.get(spec.id) ?? 0) > now) continue;
      seen.add(spec.id);
      const by = SOURCES.includes(rec(raw).by as ItemSource) ? rec(raw).by as ItemSource : undefined;
      const old = this.items.get(spec.id);
      if (old) { old.spec = spec; old.by = by ?? old.by; old.seen = true; }
      else this.items.set(spec.id, this.fresh(spec, by, undefined, now));
    }
    for (const [id, it] of this.items) if (!seen.has(id) && now - it.addedAt > 3000) this.forget(id);
    this.scenes = (Array.isArray(s.scenes) ? s.scenes : []).slice(0, ITEM_LIMITS.maxScenes).map(rec)
      .filter((x) => typeof x.name === 'string').map((x) => ({ name: String(x.name).slice(0, ITEM_LIMITS.maxName), on: x.on === true, count: isNum(x.count) ? x.count : 0 }));
    this.lastItemsAt = now;
    this.bus.settle(ITEM_STATE_COMMAND, s.req, true);
  }

  private fresh(spec: ItemSpec, by: ItemSource | undefined, owner: string | undefined, now: number, over: Partial<MItem> = {}): MItem {
    const fileName = spec.name || ('lib' in spec.src ? spec.src.lib.split('/').pop()! : spec.id);
    const animated = /\.gif$/i.test(fileName);
    return {
      id: spec.id, fileName, type: /\.gif$/i.test(fileName) ? 'GIF' : /\.jpe?g$/i.test(fileName) ? 'JPG' : 'PNG', spec, by, owner, unloadOnDisconnect: false,
      order: spec.layer === 'behind' ? -1 : 3, flipped: !!spec.place.flipX, locked: false, censored: false, smoothing: 0, framerate: animated ? 12 : 0, frameCount: animated ? 0 : -1,
      addedAt: now, seen: false, ...over,
    };
  }

  private onItemEvent(a: unknown) {
    const e = rec(a);
    if (e.target !== undefined && e.target !== '@host') return;
    if (typeof e.id !== 'string') return;
    const id = e.id, ev = String(e.ev);
    let it = this.items.get(id);
    if (!it && ev === 'added') {
      const spec = sanitizeItemSpec(e.item);
      if (spec) { it = this.fresh(spec, undefined, undefined, Date.now()); this.items.set(id, it); }
    }
    if (ev === 'moved') {
      const p = rec(e.place);
      if (it && isNum(p.x) && isNum(p.y)) it.spec = { ...it.spec, place: { ...it.spec.place, x: p.x, y: p.y } };
      if ((this.quiet.get(id) ?? 0) > Date.now()) return;               // our own move coming back is not "dropped by the user"
    }
    if (ev === 'pinned' && it) { const pin = sanitizeItemSpec(e.item)?.pin; if (pin) it.spec = { ...it.spec, pin }; }
    const type = ({ added: 'Added', removed: 'Removed', pinned: 'DroppedPinned', moved: 'DroppedUnpinned', clicked: 'Clicked' } as Record<string, string>)[ev];
    if (!type) return;
    const fileName = it?.fileName ?? id;
    const pos = it && it.spec.pin.to === 'screen' ? screenToVts(it.spec.place.x, it.spec.place.y) : { x: 0, y: 0 };
    if (ev === 'removed') { this.forget(id); this.gone.set(id, Date.now() + 5000); this.sweepStamps(); }
    this.deps.emit('ItemEvent', { itemEventType: type, itemInstanceID: id, itemFileName: fileName, itemPosition: pos }, {
      filter: (cfg) => {
        const c = rec(cfg), ids = strs(c.itemInstanceIDs), names = strs(c.itemFileNames);
        if (!ids.length && !names.length) return true;
        return ids.includes(id) || names.some((n) => fileName.toLowerCase().includes(n.toLowerCase()));
      },
    });
  }

  /** `model-clicked` { x, y (VTS -1..1), button 0|1|2, hit: boolean, parts?: string[] } from the studio page that shows the avatar. */
  private onModelClicked(a: unknown) {
    const c = rec(a);
    const x = isNum(c.x) ? clampN(c.x, -3, 3) : 0, y = isNum(c.y) ? clampN(c.y, -3, 3) : 0, hit = c.hit !== false;
    const av = this.deps.currentAvatar();
    const parts = strs(c.parts, 16);
    this.deps.emit('ModelClickedEvent', {
      modelLoaded: !!av, loadedModelID: av?.id ?? '', loadedModelName: av?.name ?? '', modelWasClicked: hit,
      mouseButtonID: isNum(c.button) ? clampN(Math.round(c.button), 0, 2) : 0, clickPosition: { x, y }, windowSize: { x: 1920, y: 1080 },
      clickedArtMeshCount: hit ? parts.length : 0,
      artMeshHits: hit ? parts.map((p, i) => ({ artMeshOrder: i, isMasked: false, hitInfo: { modelID: av?.id ?? '', artMeshID: p, angle: 0, size: 1, vertexID1: 0, vertexID2: 0, vertexID3: 0, vertexWeight1: 1, vertexWeight2: 0, vertexWeight3: 0 } })) : [],
    }, { filter: (cfg) => rec(cfg).onlyClicksOnModel !== true || hit });
  }

  // ---------------------------------------------------------------- requests

  async handle(s: BridgeSession, type: string, d: Record<string, unknown>): Promise<[string, unknown]> {
    switch (type) {
      case 'MoveModelRequest': return ['MoveModelResponse', this.moveModel(d)];
      case 'ArtMeshListRequest': return ['ArtMeshListResponse', await this.artMeshList()];
      case 'ColorTintRequest': return ['ColorTintResponse', await this.colorTint(s, d)];
      case 'PermissionRequest': return ['PermissionResponse', this.permission(s, d)];
      case 'ItemListRequest': return ['ItemListResponse', await this.itemList(d)];
      case 'ItemLoadRequest': return ['ItemLoadResponse', await this.itemLoad(s, d)];
      case 'ItemUnloadRequest': return ['ItemUnloadResponse', this.itemUnload(s, d)];
      case 'ItemAnimationControlRequest': return ['ItemAnimationControlResponse', this.itemAnimation(d)];
      case 'ItemMoveRequest': return ['ItemMoveResponse', this.itemMove(d)];
      case 'ItemPinRequest': return ['ItemPinResponse', await this.itemPin(d)];
    }
    throw new VtsApiError(7, `'${type.slice(0, 64)}' is not supported by VTube Pro`);
  }

  // ---- the model

  moveModel(d: Record<string, unknown>) {
    if (!this.deps.currentAvatar()) throw new VtsApiError(VTS_ERR.MoveModelRequestNoModelLoaded, 'No model loaded');
    if (!given(d.timeInSeconds) || typeof d.valuesAreRelativeToModel !== 'boolean') throw new VtsApiError(VTS_ERR.MoveModelRequestMissingFields, 'timeInSeconds and valuesAreRelativeToModel are required');
    const range = (v: unknown, lo: number, hi: number, name: string) => {
      if (!given(v)) return undefined;
      if (!isNum(v) || v < lo || v > hi) throw new VtsApiError(VTS_ERR.MoveModelRequestValuesOutOfRange, `${name} must be between ${lo} and ${hi}`);
      return v;
    };
    const secs = range(d.timeInSeconds, 0, 2, 'timeInSeconds') ?? 0;
    const move = sanitizeModelMove({
      x: range(d.positionX, -1000, 1000, 'positionX'), y: range(d.positionY, -1000, 1000, 'positionY'),
      rot: range(d.rotation, -360, 360, 'rotation'), size: range(d.size, -100, 100, 'size'), relative: d.valuesAreRelativeToModel, secs,
    });
    if (move) this.send(MODEL_MOVE_COMMAND, move);
    return {};
  }

  /** One request in flight per kind: a plugin polling at 60 Hz sends the studio one question, not sixty. */
  private inflight = new Map<string, Promise<unknown>>();
  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const have = this.inflight.get(key) as Promise<T> | undefined;
    if (have) return have;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
  private modelAt = 0;
  private modelMissAt = 0;
  private artMissAt = 0;
  private itemsMissAt = 0;

  /** The model's place as VTS reports it. Without an answer from the studio: the last one we heard, else the centre. */
  async modelPosition(): Promise<{ positionX: number; positionY: number; rotation: number; size: number }> {
    const now = Date.now();
    if (!(this.modelLast && now - this.modelAt < 100) && now - this.modelMissAt >= 5000) {
      const s = await this.once('model', () => this.bus.request<ModelState>(MODEL_STATE_COMMAND, {}));
      if (s) { this.modelLast = s; this.modelAt = Date.now(); } else this.modelMissAt = Date.now();
    }
    const s = this.modelLast;
    return s ? { positionX: s.x, positionY: s.y, rotation: posRot(s.rot), size: s.size } : { positionX: 0, positionY: 0, rotation: 0, size: 0 };
  }

  private async art(maxAgeMs = 5000): Promise<ArtList | null> {
    const now = Date.now();
    if (this.artLast && now - this.artLast.at < maxAgeMs) return this.artLast.art;
    if (now - this.artMissAt < 5000) return this.artLast?.art ?? null;
    const l = await this.once('art', () => this.bus.request<ArtList>(ART_LIST_COMMAND, {}));
    if (!l) this.artMissAt = Date.now();
    return l ?? this.artLast?.art ?? null;
  }

  async artMeshList() {
    const av = this.deps.currentAvatar();
    const art = av ? await this.art(1000) : null;
    const names = art?.names ?? [], tags = art?.tags ?? [];
    return { modelLoaded: !!av, numberOfArtMeshNames: names.length, numberOfArtMeshTags: tags.length, artMeshNames: names, artMeshTags: tags, numberOfArtMeshGroups: 0, artMeshGroups: [] };
  }

  async colorTint(s: BridgeSession, d: Record<string, unknown>) {
    if (!this.deps.currentAvatar()) throw new VtsApiError(VTS_ERR.ColorTintRequestNoModelLoaded, 'No model loaded');
    const ct = rec(d.colorTint), mt = rec(d.artMeshMatcher);
    const ch = (v: unknown, req: boolean) => {
      if (!given(v)) { if (req) throw new VtsApiError(VTS_ERR.ColorTintRequestInvalidColorValue, 'colorR, colorG and colorB are required'); return 255; }
      if (!isNum(v) || v < 0 || v > 255) throw new VtsApiError(VTS_ERR.ColorTintRequestInvalidColorValue, 'colour values must be between 0 and 255');
      return Math.round(v);
    };
    const r = ch(ct.colorR, true), g = ch(ct.colorG, true), b = ch(ct.colorB, true), a = ch(ct.colorA, false);
    const all = mt.tintAll === true;
    const nameExact = strs(mt.nameExact), nameContains = strs(mt.nameContains), tagExact = strs(mt.tagExact), tagContains = strs(mt.tagContains);
    const nums = (Array.isArray(mt.artMeshNumber) ? mt.artMeshNumber : []).filter((n): n is number => Number.isInteger(n) && n >= 0).slice(0, 512);
    const groups = strs(mt.artMeshGroupIDExact);
    if (!all && !nameExact.length && !nameContains.length && !tagExact.length && !tagContains.length && !nums.length && !groups.length)
      throw new VtsApiError(VTS_ERR.ColorTintRequestMatchOrColorMissing, 'Set tintAll or give at least one matcher');
    let names: string[] = [], tags: string[] = [];
    if (!all) {
      const lower = (x: string[]) => x.map((v) => v.toLowerCase());
      const ne = new Set(lower(nameExact)), nc = lower(nameContains), te = new Set(lower(tagExact)), tc = lower(tagContains);
      const art = await this.art();
      if (art) {
        names = art.names.filter((n, i) => { const l = n.toLowerCase(); return ne.has(l) || nc.some((c) => l.includes(c)) || nums.includes(i); });
        tags = art.tags.filter((t) => { const l = t.toLowerCase(); return te.has(l) || tc.some((c) => l.includes(c)); });
      } else { names = nameExact; tags = tagExact; }                      // no list from the studio: take the exact ones as given
    }
    const by = `vts-${s.key.slice(0, 8)}`;
    const white = r === 255 && g === 255 && b === 255 && a === 255;
    const tint = sanitizeArtTint({ names, tags, all, r, g, b, a, ...(white ? { clear: true } : {}), by });
    if (!tint) return { matchedArtMeshes: 0 };
    this.send(ART_TINT_COMMAND, tint);
    if (!white) this.tinted.add(s.key);
    return { matchedArtMeshes: all ? ((await this.art())?.names.length ?? 0) : (tint.names?.length ?? 0) };
  }

  permission(s: BridgeSession, d: Record<string, unknown>) {
    const want = d.requestedPermission;
    let success = false, asked = '';
    if (given(want) && want !== '') {
      if (typeof want !== 'string' || !(PERMISSIONS as readonly string[]).includes(want)) throw new VtsApiError(VTS_ERR.PermissionRequestUnknownPermission, `Unknown permission '${String(want).slice(0, 64)}'`);
      asked = want;
      // The user already approved this plugin in the Track tab (and can remove it there); no second pop-up in the middle of a stream.
      if (GRANTABLE.has(want)) { s.perms.add(want); success = true; }
    }
    return { grantSuccess: success, requestedPermission: asked, permissions: PERMISSIONS.map((name) => ({ name, granted: s.perms.has(name) })) };
  }

  /** A plugin left: take back what it asked to be taken back, and its tints. */
  sessionClosed(s: BridgeSession) {
    for (const it of [...this.items.values()]) if (it.owner === s.key && it.unloadOnDisconnect) this.removeItem(it.id);
    this.loadBytes.delete(s.key);
    if (this.tinted.delete(s.key)) this.send(ART_TINT_COMMAND, sanitizeArtTint({ all: true, clear: true, r: 255, g: 255, b: 255, by: `vts-${s.key.slice(0, 8)}` }));
  }

  /** Subscriptions changed: the model-moved poll runs only while somebody listens. */
  subscriptionsChanged() {
    const want = this.deps.subscribers('ModelMovedEvent') > 0;
    if (want && !this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.pollModel(); }, 200);
      this.pollTimer.unref?.();
    } else if (!want && this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; this.modelSent = null; }
  }

  /** Right after a plugin subscribed: ModelMovedEvent sends the current place at once. */
  async onSubscribed(s: BridgeSession, name: string) {
    if (name === 'ModelMovedEvent') {
      const av = this.deps.currentAvatar();
      if (av) this.deps.emit('ModelMovedEvent', { modelID: av.id, modelName: av.name, modelPosition: await this.modelPosition() }, { only: s });
    }
    this.subscriptionsChanged();
  }

  private pollBusy = false;
  private async pollModel() {
    if (this.pollBusy) return;
    this.pollBusy = true;
    try {
      const av = this.deps.currentAvatar();
      if (!av) return;
      const s = await this.bus.request<ModelState>(MODEL_STATE_COMMAND, {}, undefined, 300);
      if (!s) return;
      this.modelLast = s; this.modelAt = Date.now();
      const o = this.modelSent;
      if (o && Math.abs(o.x - s.x) < 1e-3 && Math.abs(o.y - s.y) < 1e-3 && Math.abs(o.rot - s.rot) < 0.05 && Math.abs(o.size - s.size) < 0.05) return;
      this.modelSent = s;
      this.deps.emit('ModelMovedEvent', { modelID: av.id, modelName: av.name, modelPosition: { positionX: s.x, positionY: s.y, rotation: posRot(s.rot), size: s.size } });
    } finally { this.pollBusy = false; }
  }

  // ---- items

  private async refreshItems(maxAgeMs = 1500) {
    const now = Date.now();
    if (now - this.lastItemsAt < maxAgeMs || now - this.itemsMissAt < 5000) return;
    const got = await this.once('items', () => this.bus.request<boolean>(ITEM_COMMAND, { op: 'list' }, ITEM_STATE_COMMAND));
    if (!got) this.itemsMissAt = Date.now();
  }

  private freeOrder(want: number | null, fail: boolean): number {
    const taken = new Set([...this.items.values()].map((i) => i.order));
    const start = want ?? 3;
    if (!taken.has(start) && start !== 0) return start;
    if (fail) throw new VtsApiError(VTS_ERR.ItemOrderAlreadyTaken, `Order ${start} is taken`);
    for (let o = start; o <= ORDER_MAX; o++) if (o !== 0 && !taken.has(o)) return o;
    for (let o = start - 1; o >= ORDER_MIN; o--) if (o !== 0 && !taken.has(o)) return o;
    throw new VtsApiError(VTS_ERR.CannotLoadItemSceneFull, 'No free order spot');
  }

  private pinView(it: MItem) {
    const p = it.spec.pin;
    return p.to === 'screen' ? { pinnedToModel: false, pinnedModelID: '', pinnedArtMeshID: '' }
      : { pinnedToModel: true, pinnedModelID: this.deps.currentAvatar()?.id ?? '', pinnedArtMeshID: p.to === 'bone' ? p.bone : p.to === 'part' ? p.part : 'face' };
  }

  private instance(it: MItem) {
    return {
      fileName: it.fileName, instanceID: it.id, order: it.order, type: it.type, censored: it.censored, flipped: it.flipped, locked: it.locked, smoothing: it.smoothing,
      framerate: it.framerate, frameCount: it.frameCount, currentFrame: it.frameCount > 0 ? 0 : -1, ...this.pinView(it), groupName: '', sceneName: '', fromWorkshop: false,
    };
  }

  async itemList(d: Record<string, unknown>) {
    await this.refreshItems();
    const onlyFile = typeof d.onlyItemsWithFileName === 'string' && d.onlyItemsWithFileName ? d.onlyItemsWithFileName : '';
    const onlyId = typeof d.onlyItemsWithInstanceID === 'string' && d.onlyItemsWithInstanceID ? d.onlyItemsWithInstanceID : '';
    const all = [...this.items.values()];
    const match = (x: { fileName: string; instanceID?: string }) => (!onlyFile || x.fileName === onlyFile) && (!onlyId || x.instanceID === onlyId);
    const spots: number[] = [];
    if (d.includeAvailableSpots === true) { const taken = new Set(all.map((i) => i.order)); for (let o = ORDER_MIN; o <= ORDER_MAX; o++) if (o !== 0 && !taken.has(o)) spots.push(o); }
    const loaded = (f: string) => all.filter((i) => i.fileName === f).length;
    return {
      itemsInSceneCount: all.length, totalItemsAllowedCount: ITEM_LIMITS.maxItems, canLoadItemsRightNow: true, availableSpots: spots,
      itemInstancesInScene: d.includeItemInstancesInScene === true ? all.map((i) => this.instance(i)).filter(match) : [],
      availableItemFiles: d.includeAvailableItemFiles === true ? this.files().map((f) => ({ fileName: f.fileName, type: f.type, loadedCount: loaded(f.fileName) })).filter(match) : [],
    };
  }

  async itemLoad(s: BridgeSession, d: Record<string, unknown>) {
    const fileName = d.fileName;
    if (typeof fileName !== 'string' || !fileName) throw new VtsApiError(VTS_ERR.ItemFileNameMissing, 'fileName missing');
    const bad = (m: string) => new VtsApiError(VTS_ERR.ItemLoadValuesInvalid, m);
    const num = (v: unknown, lo: number, hi: number, def: number, name: string) => {
      if (!given(v)) return def;
      if (!isNum(v) || v < lo || v > hi) throw bad(`${name} must be between ${lo} and ${hi}`);
      return v;
    };
    const x = num(d.positionX, -1000, 1000, 0, 'positionX'), y = num(d.positionY, -1000, 1000, 0, 'positionY');
    const size = num(d.size, 0, 1, VTS_ITEM_DEFAULT_SIZE, 'size'), rot = num(d.rotation, -360, 360, 0, 'rotation');
    num(d.fadeTime, 0, 2, 0, 'fadeTime'); const smoothing = num(d.smoothing, 0, 1, 0, 'smoothing');
    const orderWanted = given(d.order) ? d.order : null;
    if (orderWanted !== null && (!Number.isInteger(orderWanted) || (orderWanted as number) < ORDER_MIN || (orderWanted as number) > ORDER_MAX || orderWanted === 0)) throw new VtsApiError(VTS_ERR.ItemOrderInvalid, `order must be a whole number from ${ORDER_MIN} to ${ORDER_MAX}, not 0`);

    await this.refreshItems();
    if (this.items.size >= ITEM_LIMITS.maxItems) throw new VtsApiError(VTS_ERR.CannotLoadItemSceneFull, `The scene holds at most ${ITEM_LIMITS.maxItems} items`);
    const ownRam = [...this.items.values()].filter((i) => i.owner === s.key && 'ram' in i.spec.src).length;

    const id = crypto.randomBytes(16).toString('hex');
    let src: ItemSpec['src'], data: { ref: string; mime: ItemMime; b64: string } | undefined, type: VtsItemType, kind: ItemKind = 'image', frames = -1, name = fileName;
    if (typeof d.customDataBase64 === 'string' && d.customDataBase64 !== '') {
      if (!s.perms.has('LoadCustomImagesAsItems')) throw new VtsApiError(VTS_ERR.RequestRequiresPermission, 'Loading your own pictures needs the LoadCustomImagesAsItems permission (send a PermissionRequest first)');
      if (!/^[A-Za-z0-9_-]{1,60}\.(png|jpe?g|gif)$/i.test(fileName)) throw new VtsApiError(VTS_ERR.ItemCustomDataInvalid, 'fileName must be letters, digits and hyphens and end in .png, .jpg or .gif');
      if (ownRam >= ITEM_LIMITS.maxRamItems) throw new VtsApiError(VTS_ERR.CannotLoadItemSceneFull, 'This plugin already has the most pictures it may have on screen');
      const img = inspectPluginImage(d.customDataBase64);
      if (!img) throw new VtsApiError(VTS_ERR.ItemCustomDataInvalid, `The picture must be a PNG, JPG or GIF, ${IMAGE_LIMITS.minPx} to ${IMAGE_LIMITS.maxPx} px, at most ${ITEM_LIMITS.maxBytes / 1024 / 1024} MB`);
      // at most 8 MB of pictures per plugin per 10 s: a plugin stuck in a loop cannot flood the bus
      const now = Date.now(), win = (this.loadBytes.get(s.key) ?? []).filter((e) => now - e.at < 10_000);
      if (win.reduce((n, e) => n + e.bytes, 0) + img.bytes > 8 * 1024 * 1024) throw new VtsApiError(VTS_ERR.CannotCurrentlyLoadItem, 'Too many pictures too fast; wait a few seconds');
      win.push({ at: now, bytes: img.bytes }); this.loadBytes.set(s.key, win);
      src = { ram: id }; data = { ref: id, mime: img.mime, b64: img.b64 }; type = img.type; frames = img.frames > 1 ? img.frames : -1;
      name = fileName.replace(/\.[^.]+$/, '');
    } else {
      const f = this.files().find((v) => v.fileName === fileName);
      if (!f) throw new VtsApiError(VTS_ERR.ItemFileNameNotFound, `There is no item file '${fileName.slice(0, 64)}'`);
      src = { lib: f.lib }; type = f.type; kind = f.kind; name = f.fileName;
    }
    const order = this.freeOrder(orderWanted as number | null, d.failIfOrderTaken === true);
    const pos = vtsToScreen(x, y);
    const place: ItemPlace = { x: pos.x, y: pos.y, z: 0, rot: ROT_SIGN * rot, scale: vtsSizeToScale(size), ...(d.flipped === true ? { flipX: true } : {}) };
    const spec: ItemSpec = { id, name: name.replace(/[^\w .()-]/g, ' ').slice(0, ITEM_LIMITS.maxName).trim() || id, kind, src, pin: { to: 'screen' }, place, layer: order < 0 ? 'behind' : 'front' };
    const op = sanitizeItemOp({ op: 'add', item: spec, ...(data ? { data } : {}), by: 'vts' });
    if (!op) throw bad('The studio would not take this item');
    this.sendOp(op);
    const it = this.fresh(spec, 'vts', s.key, Date.now(), {
      fileName, type, order, flipped: d.flipped === true, locked: d.locked === true, censored: d.censored === true, smoothing, unloadOnDisconnect: d.unloadWhenPluginDisconnects === true,
      frameCount: frames > 1 ? frames : type === 'GIF' ? 0 : -1, framerate: frames > 1 || type === 'GIF' ? 12 : 0,
    });
    this.items.set(id, it);
    return { instanceID: id, fileName };
  }

  private removeItem(id: string) {
    this.forget(id);
    this.gone.set(id, Date.now() + 5000);
    this.sweepStamps();
    this.sendOp({ op: 'remove', id });
  }

  itemUnload(s: BridgeSession, d: Record<string, unknown>) {
    const mine = (it: MItem) => it.owner === s.key;
    const allowOthers = d.allowUnloadingItemsLoadedByUserOrOtherPlugins !== false;
    const ids = new Set(strs(d.instanceIDs, 64)), names = new Set(strs(d.fileNames, 64));
    let hit: MItem[];
    if (d.unloadAllInScene === true) hit = [...this.items.values()];
    else {
      hit = [...this.items.values()].filter((it) => (d.unloadAllLoadedByThisPlugin === true && mine(it)) || ids.has(it.id) || names.has(it.fileName));
      if (!allowOthers) hit = hit.filter(mine);
    }
    for (const it of hit) this.removeItem(it.id);
    return { unloadedItems: hit.map((it) => ({ instanceID: it.id, fileName: it.fileName })) };
  }

  itemAnimation(d: Record<string, unknown>) {
    const id = d.itemInstanceID;
    const it = typeof id === 'string' ? this.items.get(id) : undefined;
    if (!it) throw new VtsApiError(VTS_ERR.ItemAnimationControlInstanceIDNotFound, 'No item with that instance ID');
    const animated = it.type === 'GIF' || it.frameCount > 0;
    const wantsAnim = (isNum(d.framerate) && d.framerate >= 0) || (isNum(d.frame) && d.frame >= 0) || d.setAutoStopFrames === true || d.setAnimationPlayState === true;
    if (!animated && wantsAnim) throw new VtsApiError(VTS_ERR.ItemAnimationControlSimpleImageDoesNotSupportAnim, 'This item is a plain picture; only opacity and brightness can be set');
    if (isNum(d.framerate) && d.framerate >= 0) it.framerate = clampN(d.framerate, 0.1, 120);   // shown in ItemList; the studio plays the picture at its own pace
    if (isNum(d.opacity) && d.opacity >= 0) {
      const op = sanitizeItemOp({ op: 'move', id: it.id, opacity: clampN(d.opacity, 0, 1) });
      if (op) this.sendOp(op);
    }
    return { frame: it.frameCount > 0 ? 0 : -1, animationPlaying: animated };
  }

  itemMove(d: Record<string, unknown>) {
    const list = (Array.isArray(d.itemsToMove) ? d.itemsToMove : []).slice(0, 64).map(rec);
    const last = new Map<string, Record<string, unknown>>();
    for (const e of list) if (typeof e.itemInstanceID === 'string') last.set(e.itemInstanceID, e);
    const out: { itemInstanceID: string; success: boolean; errorID: number }[] = [];
    for (const e of list) {
      const id = typeof e.itemInstanceID === 'string' ? e.itemInstanceID : '';
      if (last.get(id) !== e && id) continue;
      const fail = (errorID: number) => out.push({ itemInstanceID: id, success: false, errorID });
      const it = this.items.get(id);
      if (!it) { fail(VTS_ERR.ItemMoveRequestInstanceIDNotFound); continue; }
      const mode = given(e.fadeMode) ? e.fadeMode : 'linear';
      if (typeof mode !== 'string' || !EASE[mode]) { fail(VTS_ERR.ItemMoveRequestInvalidFadeMode); continue; }
      const val = (v: unknown, lo: number, hi: number) => (isNum(v) && v > -1000 ? clampN(v, lo, hi) : undefined);
      const px = val(e.positionX, -1000, 1000), py = val(e.positionY, -1000, 1000), size = val(e.size, 0, 1), rot = val(e.rotation, -360, 360);
      const secs = isNum(e.timeInSeconds) ? clampN(e.timeInSeconds, 0, 30) : 0;
      let order: number | undefined;
      if (isNum(e.order) && e.order > -1000 && e.order !== it.order) {
        if (!Number.isInteger(e.order) || e.order < ORDER_MIN || e.order > ORDER_MAX || e.order === 0 || [...this.items.values()].some((o) => o.order === e.order)) { fail(VTS_ERR.ItemMoveRequestItemOrderTakenOrInvalid); continue; }
        order = e.order;
      }
      const cur = it.spec.place, curV = it.spec.pin.to === 'screen' ? screenToVts(cur.x, cur.y) : { x: 0, y: 0 };
      const to = vtsToScreen(px ?? curV.x, py ?? curV.y);
      const target = { x: to.x, y: to.y, rot: rot !== undefined ? ROT_SIGN * rot : cur.rot, scale: size !== undefined ? vtsSizeToScale(size) : cur.scale };
      this.glides.delete(id);
      if (order !== undefined) { it.order = order; this.sendOp({ op: 'move', id, layer: order < 0 ? 'behind' : 'front' }); it.spec = { ...it.spec, layer: order < 0 ? 'behind' : 'front' }; }
      if (e.setFlip === true) it.flipped = e.flip === true;
      const flip = e.setFlip === true ? { flipX: e.flip === true } : {};
      if (it.spec.pin.to !== 'screen') {                                     // moving a pinned item takes it off the model
        this.quiet.set(id, Date.now() + 600);
        this.sendOp({ op: 'pin', id, pin: { to: 'screen' }, place: { ...target, ...flip } });
        it.spec = { ...it.spec, pin: { to: 'screen' }, place: { ...cur, ...target, ...(flip.flipX !== undefined ? { flipX: flip.flipX } : {}) } };
      } else if (secs <= 0) this.applyPlace(it, target, flip);
      else {
        if (this.glides.size >= 64) { fail(VTS_ERR.CannotCurrentlyLoadItem); continue; }
        this.glides.set(id, { id, t0: Date.now(), dur: secs * 1000, from: { x: cur.x, y: cur.y, rot: cur.rot, scale: cur.scale }, to: target, ease: EASE[mode] });
        if (flip.flipX !== undefined) this.applyPlace(it, {}, flip);
        this.startGlides();
      }
      out.push({ itemInstanceID: id, success: true, errorID: -1 });
    }
    return { movedItems: out };
  }

  private applyPlace(it: MItem, p: Partial<ItemPlace>, extra: { flipX?: boolean } = {}) {
    this.quiet.set(it.id, Date.now() + 600);
    it.spec = { ...it.spec, place: { ...it.spec.place, ...p, ...extra } };
    this.sendOp({ op: 'move', id: it.id, place: { ...p, ...extra } });
  }

  private startGlides() {
    if (this.glideTimer) return;
    this.glideTimer = setInterval(() => this.stepGlides(), GLIDE_STEP_MS);
    this.glideTimer.unref?.();
  }

  /** Public for tests: advance the item glides to `now`. */
  stepGlides(now = Date.now()) {
    // a crowd of glides steps at half rate; a glide that has just finished is never held back (it lands exactly)
    if (this.glides.size > GLIDE_CROWD && now - this.lastGlideStep < GLIDE_STEP_MS * 1.5 && ![...this.glides.values()].some((g) => now >= g.t0 + g.dur)) return;
    this.lastGlideStep = now;
    for (const [id, g] of [...this.glides]) {
      const it = this.items.get(id);
      if (!it) { this.glides.delete(id); continue; }
      const t = clampN((now - g.t0) / g.dur, 0, 1), k = g.ease(t), L = (a: number, b: number) => a + (b - a) * k;
      const p = t >= 1 ? g.to : { x: L(g.from.x, g.to.x), y: L(g.from.y, g.to.y), rot: L(g.from.rot, g.to.rot), scale: clampN(L(g.from.scale, g.to.scale), 0.01, 20) };
      const s0 = g.sent;
      const same = !!s0 && Math.abs(p.x - s0.x) < GLIDE_EPS.pos && Math.abs(p.y - s0.y) < GLIDE_EPS.pos && Math.abs(p.rot - s0.rot) < GLIDE_EPS.rot && Math.abs(p.scale - s0.scale) < GLIDE_EPS.scale;
      if (t >= 1 || !same) { this.applyPlace(it, p); g.sent = { x: p.x, y: p.y, rot: p.rot, scale: p.scale }; }
      if (t >= 1) this.glides.delete(id);
    }
    if (!this.glides.size && this.glideTimer) { clearInterval(this.glideTimer); this.glideTimer = null; }
  }
  get glideCount() { return this.glides.size; }

  async itemPin(d: Record<string, unknown>) {
    const id = d.itemInstanceID;
    const it = typeof id === 'string' ? this.items.get(id) : undefined;
    if (!it) throw new VtsApiError(VTS_ERR.ItemPinRequestGivenItemNotLoaded, 'No item with that instance ID');
    this.glides.delete(it.id);                                               // a pin cancels a running move (VTS)
    const result = () => ({ isPinned: it.spec.pin.to !== 'screen', itemInstanceID: it.id, itemFileName: it.fileName });
    if (d.pin !== true) {
      const cur = it.spec.place;
      const at = it.spec.pin.to === 'screen' ? { x: cur.x, y: cur.y } : vtsToScreen(0, 0.3);
      this.quiet.set(it.id, Date.now() + 600);
      this.sendOp({ op: 'pin', id: it.id, pin: { to: 'screen' }, place: { x: at.x, y: at.y, z: 0, rot: cur.rot, scale: cur.scale } });
      it.spec = { ...it.spec, pin: { to: 'screen' }, place: { ...cur, x: at.x, y: at.y, z: 0 } };
      return result();
    }
    const info = rec(d.pinInfo);
    const angleRel = given(d.angleRelativeTo) ? d.angleRelativeTo : 'RelativeToModel', sizeRel = given(d.sizeRelativeTo) ? d.sizeRelativeTo : 'RelativeToWorld';
    if (!['RelativeToWorld', 'RelativeToCurrentItemRotation', 'RelativeToModel', 'RelativeToPinPosition'].includes(angleRel as string)
      || !['RelativeToWorld', 'RelativeToCurrentItemSize'].includes(sizeRel as string)) throw new VtsApiError(VTS_ERR.ItemPinRequestInvalidAngleOrSizeType, 'angleRelativeTo or sizeRelativeTo is not a known type');
    const av = this.deps.currentAvatar();
    const modelID = typeof info.modelID === 'string' ? info.modelID : '';
    if (!av || (modelID && modelID !== av.id)) throw new VtsApiError(VTS_ERR.ItemPinRequestModelNotFound, 'The model is not the loaded one');
    const vpt = given(d.vertexPinType) ? d.vertexPinType : 'Center';
    if (vpt === 'Provided') {
      const w = [info.vertexWeight1, info.vertexWeight2, info.vertexWeight3];
      if (!w.every(isNum) || Math.abs((w as number[]).reduce((a, b) => a + b, 0) - 1) > 0.01) throw new VtsApiError(VTS_ERR.ItemPinRequestPinPositionInvalid, 'The vertex weights must add up to 1');
    } else if (vpt !== 'Center' && vpt !== 'Random') throw new VtsApiError(VTS_ERR.ItemPinRequestPinPositionInvalid, 'vertexPinType must be Provided, Center or Random');
    const mesh = typeof info.artMeshID === 'string' ? info.artMeshID : '';
    let pin: ItemPin;
    if (!mesh) pin = { to: 'face' };
    else {
      const art = await this.art(10_000);
      const part = art?.names.find((n) => n === mesh) ?? art?.names.find((n) => n.toLowerCase() === mesh.toLowerCase());
      const bone = boneOf(mesh);
      if (part) pin = { to: 'part', part };
      else if (bone) pin = { to: 'bone', bone };
      else throw new VtsApiError(VTS_ERR.ItemPinRequestArtMeshNotFound, `The model has no ArtMesh '${mesh.slice(0, 64)}'`);
    }
    const cur = it.spec.place;
    const ang = isNum(info.angle) ? info.angle : 0, sz = isNum(info.size) ? info.size : VTS_ITEM_DEFAULT_SIZE;
    const rot = angleRel === 'RelativeToCurrentItemRotation' ? cur.rot + ROT_SIGN * ang : ROT_SIGN * ang;
    const scale = sizeRel === 'RelativeToCurrentItemSize' ? clampN(cur.scale + sz / VTS_ITEM_DEFAULT_SIZE, 0.01, 20) : vtsSizeToScale(clampN(sz, 0, 1));
    const place = { x: 0, y: 0, z: 0, rot: clampN(rot, -360, 360), scale };
    const op = sanitizeItemOp({ op: 'pin', id: it.id, pin, place });
    if (!op) throw new VtsApiError(VTS_ERR.ItemPinRequestPinPositionInvalid, 'That pin position cannot be used');
    this.quiet.set(it.id, Date.now() + 600);
    this.sendOp(op);
    it.spec = { ...it.spec, pin, place: { ...cur, ...place } };
    return result();
  }

  /** Saved item scenes the host made: the server offers each one as a ToggleItemScene hotkey. */
  sceneNames(): string[] { return this.scenes.map((s) => s.name); }
  /** Ask the studio for its item list now and then, so hotkeys know the scenes (cheap, never awaited by a request). */
  warmScenes() { if (Date.now() - this.lastItemsAt > 5000) void this.refreshItems(0); }
  /** Test hook. */
  itemCount() { return this.items.size; }
  itemById(id: string) { return this.items.get(id); }
}

const SOURCES: readonly ItemSource[] = ['host', 'rule', 'throw', 'vts', 'deck'];

// ---------------------------------------------------------------- what the studio sends back, cleaned

export function cleanModelState(a: unknown): ModelState | null {
  const o = rec(a);
  if (!isNum(o.x) || !isNum(o.y) || !isNum(o.rot) || !isNum(o.size)) return null;
  return {
    ...(typeof o.req === 'string' ? { req: o.req } : {}), x: clampN(o.x, -1000, 1000), y: clampN(o.y, -1000, 1000), rot: clampN(o.rot, -3600, 3600), size: clampN(o.size, -100, 100),
    loaded: o.loaded !== false, id: typeof o.id === 'string' ? o.id.slice(0, 128) : '', name: typeof o.name === 'string' ? o.name.slice(0, 128) : '',
  };
}

export function cleanArtList(a: unknown): ArtList | null {
  const o = rec(a);
  if (!Array.isArray(o.names)) return null;
  const clean = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 128).slice(0, max) : []);
  return { ...(typeof o.req === 'string' ? { req: o.req } : {}), names: clean(o.names, 2000), tags: clean(o.tags, 500) };
}
