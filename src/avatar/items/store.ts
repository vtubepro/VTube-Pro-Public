// The items lane's state machine (beta.16, docs/b16/ITEMS.md): what is on the avatar, the saved item scenes, the limits and the
// custody rules. PURE: no DOM, no three.js, no network, no clock of its own (every call that needs "now" takes it), so
// tools/avatar_items_unit.ts can drive it end to end. The studio owns one store and decides everything; an OBS page owns another
// that only replays the primitive ops the studio sends (`played`), so no page rolls its own dice or needs the saved scenes.
//
// CUSTODY: a RAM-only picture (`src: { ram }`) lives in `ram` until nothing uses it; it never leaves this object except as the
// `data` of a primitive add on the live bus. Scenes only ever hold `lib` items.
import {
  ITEM_LIMITS, b64Bytes, itemMayApply, sanitizeItemScenes, sanitizeItemsBag, sanitizeItemSpec,
  type ItemData, type ItemEvent, type ItemOp, type ItemPlace, type ItemScene, type ItemSource, type ItemSpec, type ItemState, type ItemsBag, type PrimitiveItemOp,
} from '../../../shared/avatarItems.ts';

/** All the RAM pictures together (decoded bytes). Each one is up to ITEM_LIMITS.maxBytes (2 MB) and up to 20 may be on, but the studio
 *  sends them to every OBS page as base64 in one bus message and each page holds them twice (text + decoded): 12 MB keeps that small. */
export const RAM_BYTES_CAP = 12 * 1024 * 1024;

export interface StoreEntry {
  spec: ItemSpec;
  by?: ItemSource;
  /** The saved scene that put it there (so switching the scene off takes exactly these away). */
  scene?: string;
  /** Bumped on every change: a view redraws only what moved. */
  rev: number;
  /** Epoch ms it removes itself (ttlSecs), studio only. */
  expires?: number;
}

export interface ApplyResult {
  ok: boolean;
  /** Plain words, shown to the person (a toast) when ok is false. */
  error?: string;
  changed: boolean;
  /** The primitive ops that were applied, for the OBS pages (RAM pictures ride along on their add). */
  played: PrimitiveItemOp[];
  events: ItemEvent[];
  added: string[];
  removed: string[];
}

export interface StoreOptions {
  /** Which avatar this page shows: '@host' (default) or a party member key. */
  self?: string;
  /** The person switched "let the host decorate me" on in THIS studio. Items for other members never apply without it. */
  guestOptIn?: boolean;
  /** Studio: honour ttlSecs. OBS pages: the studio sends the remove. */
  honorTtl?: boolean;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';
const fail = (error: string): ApplyResult => ({ ok: false, error, changed: false, played: [], events: [], added: [], removed: [] });
const none = (): ApplyResult => ({ ok: true, changed: false, played: [], events: [], added: [], removed: [] });
const isRam = (s: ItemSpec) => 'ram' in s.src;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export class ItemStore {
  readonly items = new Map<string, StoreEntry>();
  /** RAM pictures by ref. */
  readonly ram = new Map<string, ItemData>();
  scenes: ItemScene[] = [];
  /** The scene used last (the deck "Item scene" with no name). */
  lastScene = '';
  rev = 0;
  private readonly o: Required<StoreOptions>;

  constructor(o: StoreOptions = {}) { this.o = { self: o.self ?? '@host', guestOptIn: o.guestOptIn ?? false, honorTtl: o.honorTtl ?? false }; }

  get size() { return this.items.size; }
  has(id: string) { return this.items.has(id); }
  list(): StoreEntry[] { return [...this.items.values()]; }
  sceneByName(name: string): ItemScene | undefined { return this.scenes.find((s) => sameName(s.name, name)); }
  sceneOn(name: string) { const n = this.sceneByName(name)?.name ?? name; for (const e of this.items.values()) if (e.scene && sameName(e.scene, n)) return true; return false; }
  /** Decoded bytes of every RAM picture held, not counting `exceptRef` (the one being replaced). */
  ramBytes(exceptRef?: string) { let n = 0; for (const [ref, d] of this.ram) if (ref !== exceptRef) n += b64Bytes(d.b64); return n; }
  ramCount() { let n = 0; for (const e of this.items.values()) if (isRam(e.spec)) n++; return n; }

  // ------------------------------------------------------------ applying ops

  /** Apply one op. Never throws; a refusal is `{ ok: false, error }` in plain words. */
  apply(op: ItemOp, now = Date.now()): ApplyResult {
    if (op.op !== 'scene-delete' && !itemMayApply(op.target, this.o.self, this.o.guestOptIn)) return fail('That is not for this avatar');
    switch (op.op) {
      case 'add': return this.add(op.item, op.data, op.by, undefined, now);
      case 'move': return this.move(op);
      case 'pin': return this.pinTo(op);
      case 'remove': return this.removeIds([op.id]);
      case 'clear': return this.clear(op.by);
      case 'list': return none();
      case 'scene-save': return this.saveScene(op.name, op.secs);
      case 'scene-apply': return this.applyScene(op.name, op.mode ?? 'replace', op.by, now);
      case 'scene-toggle': return this.toggleScene(op.name, op.on ?? 'toggle', op.by, now);
      case 'scene-delete': return this.deleteScene(op.name);
    }
    return fail('Unknown item command');
  }

  /** OBS pages: replay primitive ops the studio sent. Anything else is ignored. */
  replay(ops: readonly PrimitiveItemOp[]): ApplyResult {
    const sum = none();
    for (const op of ops) {
      const r = this.apply(op);
      sum.changed ||= r.changed; sum.played.push(...r.played); sum.events.push(...r.events); sum.added.push(...r.added); sum.removed.push(...r.removed);
    }
    return sum;
  }

  private add(spec: ItemSpec, data: ItemData | undefined, by: ItemSource | undefined, scene: string | undefined, now: number): ApplyResult {
    const old = this.items.get(spec.id);
    if (!old && this.items.size >= ITEM_LIMITS.maxItems) return fail(`You already have ${ITEM_LIMITS.maxItems} things on your avatar. Take one off first`);
    if (isRam(spec)) {
      const ref = (spec.src as { ram: string }).ram;
      const d = data ?? this.ram.get(ref);
      if (!d) return fail('That picture is not here any more. Drop it again');
      if (!old || !isRam(old.spec)) if (this.ramCount() >= ITEM_LIMITS.maxRamItems) return fail('Too many dropped-in pictures at once. Take one off first');
      if (this.ramBytes(ref) + b64Bytes(d.b64) > RAM_BYTES_CAP) return fail(`Your dropped-in pictures add up to more than ${RAM_BYTES_CAP / 1024 / 1024} MB. Take one off first, or use smaller ones`);
      this.ram.set(ref, d);
    }
    const ttl = this.o.honorTtl && spec.ttlSecs ? now + spec.ttlSecs * 1000 : undefined;
    const entry: StoreEntry = { spec, ...(by ? { by } : {}), ...(scene ? { scene } : {}), rev: ++this.rev, ...(ttl ? { expires: ttl } : {}) };
    this.items.set(spec.id, entry);
    if (old) this.dropUnusedRam(old.spec);
    // the picture rides the live bus once: when it is new (or a different one), not on every nudge of the same item
    const sameRam = !!old && isRam(old.spec) && isRam(spec) && (old.spec.src as { ram: string }).ram === (spec.src as { ram: string }).ram;
    const ramData = isRam(spec) && (data || !sameRam) ? this.ram.get((spec.src as { ram: string }).ram) : undefined;
    return {
      ok: true, changed: true, added: old ? [] : [spec.id], removed: [],
      played: [{ op: 'add', item: spec, ...(ramData ? { data: ramData } : {}), ...(by ? { by } : {}) }],
      events: [old ? { ev: 'moved', id: spec.id, place: spec.place, target: this.o.self } : { ev: 'added', id: spec.id, item: spec, target: this.o.self }],
    };
  }

  private move(op: Extract<ItemOp, { op: 'move' }>): ApplyResult {
    const e = this.items.get(op.id);
    if (!e) return fail('That item is not on the avatar');
    const place: ItemPlace = { ...e.spec.place, ...op.place };
    if (op.place && 'flipX' in op.place && op.place.flipX === false) delete place.flipX;
    const spec: ItemSpec = { ...e.spec, place, ...(op.layer ? { layer: op.layer } : {}), ...(op.opacity !== undefined ? { opacity: op.opacity } : {}) };
    const same = JSON.stringify(spec) === JSON.stringify(e.spec);
    if (!same) this.items.set(op.id, { ...e, spec, rev: ++this.rev });
    return same ? none() : { ok: true, changed: true, added: [], removed: [], played: [{ op: 'move', id: op.id, place: op.place, ...(op.layer ? { layer: op.layer } : {}), ...(op.opacity !== undefined ? { opacity: op.opacity } : {}) }], events: [{ ev: 'moved', id: op.id, place, target: this.o.self }] };
  }

  private pinTo(op: Extract<ItemOp, { op: 'pin' }>): ApplyResult {
    const e = this.items.get(op.id);
    if (!e) return fail('That item is not on the avatar');
    const spec: ItemSpec = { ...e.spec, pin: op.pin, place: { ...e.spec.place, ...op.place } };
    this.items.set(op.id, { ...e, spec, rev: ++this.rev });
    return { ok: true, changed: true, added: [], removed: [], played: [{ op: 'pin', id: op.id, pin: op.pin, ...(op.place ? { place: op.place } : {}) }], events: [{ ev: 'pinned', id: op.id, item: spec, target: this.o.self }] };
  }

  private removeIds(ids: readonly string[]): ApplyResult {
    const r: ApplyResult = { ok: true, changed: false, played: [], events: [], added: [], removed: [] };
    for (const id of ids) {
      const e = this.items.get(id);
      if (!e) continue;
      this.items.delete(id);
      this.dropUnusedRam(e.spec);
      this.rev++;
      r.changed = true; r.removed.push(id);
      r.played.push({ op: 'remove', id });
      r.events.push({ ev: 'removed', id, target: this.o.self });
    }
    return r;
  }

  private clear(by?: ItemSource): ApplyResult {
    const ids = this.list().filter((e) => !by || e.by === by).map((e) => e.spec.id);
    const r = this.removeIds(ids);
    // one `clear` is enough for the OBS pages (and keeps a 20-item clear to a single message)
    if (r.changed) r.played = [{ op: 'clear', ...(by ? { by } : {}) }];
    return r;
  }

  private dropUnusedRam(spec: ItemSpec) {
    if (!isRam(spec)) return;
    const ref = (spec.src as { ram: string }).ram;
    for (const e of this.items.values()) if (isRam(e.spec) && (e.spec.src as { ram: string }).ram === ref) return;
    this.ram.delete(ref);
  }

  // ------------------------------------------------------------ timers (studio)

  /** When the next timed item runs out (epoch ms), or null: the page sets ONE timer for this, never a poll. */
  nextExpiry(): number | null {
    let t: number | null = null;
    for (const e of this.items.values()) if (e.expires !== undefined && (t === null || e.expires < t)) t = e.expires;
    return t;
  }
  /** Remove everything whose time is up. */
  expire(now: number): ApplyResult {
    const ids = this.list().filter((e) => e.expires !== undefined && e.expires <= now).map((e) => e.spec.id);
    return this.removeIds(ids);
  }

  // ------------------------------------------------------------ scenes

  /** Save what is on (library items only) as a scene; the same name replaces the old one. */
  private saveScene(name: string, secs?: number): ApplyResult {
    const items: ItemSpec[] = [];
    const taken = new Set<string>();
    for (const e of this.items.values()) {
      if (isRam(e.spec) || items.length >= ITEM_LIMITS.maxSceneItems) continue;
      // an item that came from a scene carries that scene's prefix: take it off so saving again does not grow the id
      let id = e.spec.id;
      if (e.scene) { const pre = `${slug(e.scene)}-`; if (id.startsWith(pre) && id.length > pre.length) id = id.slice(pre.length); }
      while (taken.has(id)) id = `${id.slice(0, 44)}-${taken.size}`;
      taken.add(id);
      const { ttlSecs: _t, ...rest } = e.spec;
      void _t;
      items.push({ ...rest, id });
    }
    if (!items.length) return fail('Nothing to save yet. Pictures you only dropped in are not kept: use "Keep in my library" first');
    const scene: ItemScene = { name: name.trim().slice(0, ITEM_LIMITS.maxName), items, ...(secs && secs > 0 ? { secs } : {}) };
    const at = this.scenes.findIndex((s) => sameName(s.name, name));
    if (at >= 0) this.scenes[at] = scene;
    else {
      if (this.scenes.length >= ITEM_LIMITS.maxScenes) return fail(`You can keep ${ITEM_LIMITS.maxScenes} scenes. Delete one first`);
      this.scenes.push(scene);
    }
    this.lastScene = scene.name;
    // saving is "what is on is now this scene": mark those items so switching it off takes them away
    for (const e of this.items.values()) if (!isRam(e.spec) && !e.scene) this.items.set(e.spec.id, { ...e, scene: scene.name });
    return { ok: true, changed: true, played: [], events: [], added: [], removed: [] };
  }

  private deleteScene(name: string): ApplyResult {
    const sc = this.sceneByName(name);
    if (!sc) return fail(`There is no scene called "${name}"`);
    const ids = this.list().filter((e) => e.scene && sameName(e.scene, sc.name)).map((e) => e.spec.id);
    this.scenes = this.scenes.filter((s) => s !== sc);
    if (sameName(this.lastScene, sc.name)) this.lastScene = '';
    const r = this.removeIds(ids);
    r.changed = true;
    return r;
  }

  private sceneItems(sc: ItemScene, by: ItemSource | undefined, now: number): { specs: ItemSpec[] } {
    const specs: ItemSpec[] = [];
    for (const it of sc.items.slice(0, ITEM_LIMITS.maxSceneItems)) {
      const id = `${slug(sc.name).slice(0, 20)}-${it.id}`.slice(0, 48);
      const spec: ItemSpec = { ...it, id, ...(sc.secs && !it.ttlSecs ? { ttlSecs: sc.secs } : {}) };
      specs.push(spec);
    }
    void by; void now;
    return { specs };
  }

  private applyScene(name: string, mode: 'replace' | 'add', by: ItemSource | undefined, now: number): ApplyResult {
    const sc = this.sceneByName(name);
    if (!sc) return fail(`There is no scene called "${name}"`);
    const sum = none();
    const merge = (r: ApplyResult) => { sum.ok &&= r.ok; sum.error ??= r.error; sum.changed ||= r.changed; sum.played.push(...r.played); sum.events.push(...r.events); sum.added.push(...r.added); sum.removed.push(...r.removed); };
    // a plugin's own items (by 'vts') are never taken away by a scene change
    if (mode === 'replace') merge(this.removeIds(this.list().filter((e) => e.by !== 'vts').map((e) => e.spec.id)));
    for (const spec of this.sceneItems(sc, by, now).specs) merge(this.add(spec, undefined, by ?? 'host', sc.name, now));
    this.lastScene = sc.name;
    // many removes in a row read as one clear on the wire
    if (mode === 'replace' && sum.removed.length > 1) {
      const rm = sum.played.filter((p) => p.op === 'remove').length;
      if (rm > 1) sum.played = [{ op: 'clear' }, ...sum.played.filter((p) => p.op !== 'remove')];
    }
    return sum.ok ? sum : { ...sum, ok: sum.added.length > 0 ? true : false };
  }

  private toggleScene(name: string, on: boolean | 'toggle', by: ItemSource | undefined, now: number): ApplyResult {
    const sc = this.sceneByName(name);
    if (!sc) return fail(`There is no scene called "${name}"`);
    const isOn = this.sceneOn(sc.name);
    const want = on === 'toggle' ? !isOn : on;
    this.lastScene = sc.name;
    if (want === isOn) return none();
    if (want) return this.applyScene(sc.name, 'add', by, now);
    return this.removeIds(this.list().filter((e) => e.scene && sameName(e.scene, sc.name)).map((e) => e.spec.id));
  }

  // ------------------------------------------------------------ out

  /** What the studio publishes (never carries picture data). */
  state(req?: string): ItemState {
    return {
      ...(req ? { req } : {}), target: this.o.self,
      items: this.list().map((e) => ({ ...e.spec, ...(e.by ? { by: e.by } : {}) })),
      scenes: this.scenes.map((s) => ({ name: s.name, on: this.sceneOn(s.name), count: s.items.length })),
    };
  }

  /** Everything that is on, as primitive ops (an OBS page that just opened replays this). */
  snapshot(): PrimitiveItemOp[] {
    const ops: PrimitiveItemOp[] = [{ op: 'clear' }];
    for (const e of this.items.values()) {
      const ref = isRam(e.spec) ? (e.spec.src as { ram: string }).ram : '';
      const d = ref ? this.ram.get(ref) : undefined;
      const { ttlSecs: _t, ...spec } = e.spec;
      void _t;
      ops.push({ op: 'add', item: spec, ...(d ? { data: d } : {}), ...(e.by ? { by: e.by } : {}) });
    }
    return ops;
  }

  /** The part of the state that survives a studio reload (SceneState.modes.items). */
  toBag(): ItemsBag {
    return sanitizeItemsBag({ items: this.list().map((e) => ({ ...e.spec, ...(e.by ? { by: e.by } : {}), ...(e.scene ? { scene: e.scene } : {}) })), ...(this.lastScene ? { last: this.lastScene } : {}) });
  }
  /** Put a saved bag back (a studio reload). Only library items; nothing else can be in a bag. */
  loadBag(raw: unknown): void {
    const bag = sanitizeItemsBag(raw);
    this.items.clear();
    for (const it of bag.items) {
      const spec = sanitizeItemSpec(it);
      if (!spec || isRam(spec)) continue;
      this.items.set(spec.id, { spec, ...(it.by ? { by: it.by } : {}), ...(it.scene ? { scene: it.scene } : {}), rev: ++this.rev });
    }
    if (bag.last) this.lastScene = bag.last;
  }
  setScenes(raw: unknown) { this.scenes = sanitizeItemScenes(raw); if (this.lastScene && !this.sceneByName(this.lastScene)) this.lastScene = ''; }
  /** Forget everything (the avatar was switched off, tests). */
  reset() { this.items.clear(); this.ram.clear(); this.rev++; }
}
