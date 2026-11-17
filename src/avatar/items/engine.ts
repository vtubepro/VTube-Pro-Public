// The items lane's two page engines (beta.16, docs/b16/ITEMS.md).
//
//   StudioEngine  the performer's studio: owns the ItemStore, applies every command, decides random picks / scene contents,
//                 tells the OBS pages what happened (`item-play`), keeps the host's own library items across a reload
//                 (SceneState.modes.items), answers the VTS API lane (`item-state`, `item-event`, `art-list-reply`),
//                 runs the preview's drop zone + selection frame, and registers the rule actions.
//   OutputEngine  an OBS page / room preview: replays what the studio sends onto the host's avatar. Decides nothing.
//
// CUSTODY: a dropped or plugin-sent picture is held in RAM here and on the pages, rides the live bus, and is never written
// anywhere unless the host presses "Keep in my library" (their own file, on their PC). Items only ever go on the host's OWN
// avatar; a command that names another member is refused (ItemStore, shared/avatarItems.ts itemMayApply).
import type { App } from '../../app.ts';
import type { B16Ctx } from '../../b16/mount.ts';
import type { Bus } from '../../bus.ts';
import type { BusMessage } from '../../../shared/types.ts';
import { ACTION_BY_ID } from '../../../shared/deck.ts';
import { registerRuleAction } from '../../../shared/streamRules.ts';
import {
  ITEMS_BAG, ITEM_COMMAND, ITEM_EVENT_COMMAND, ITEM_LIMITS, ITEM_NEED_COMMAND, ITEM_PLAY_COMMAND, ITEM_STATE_COMMAND, ITEM_SYNC_COMMAND,
  b64Bytes, freeItemId, itemKindOf, nearestPin, pinChoice, sanitizeItemOp, sanitizeItemPlay, sanitizeItemSync, sniffItemMime, specForChoice,
  type HandPose, type ItemOp, type ItemPlace, type ItemSource, type ItemSpec, type StickerDef,
} from '../../../shared/avatarItems.ts';
import { ART_LIST_COMMAND, ART_TINT_COMMAND, commandMessage, replyOf, sanitizeArtTint } from '../../../shared/b16Commands.ts';
import { toast } from '../../ui/dom.ts';
import type { AvatarRuntime } from '../AvatarRuntime.ts';
import { onAvatarBeforeDispose } from '../b16Hooks.ts';
import { ItemStore, type ApplyResult } from './store.ts';
import { ItemsView } from './view.ts';
import { ArtTinter } from './tint.ts';
import { cleanSceneName, pickables, planItemScene, planSticker, type PickableSticker } from './plan.ts';
import { ItemGizmo } from './gizmo.ts';
import { ItemDropZone } from './dropzone.ts';

export interface MineFile { lib: string; name: string; kind: 'image' | 'model'; bytes: number }
export interface LibraryState {
  state: 'idle' | 'loading' | 'ready' | 'offline'; starters: StickerDef[]; mine: MineFile[]; licence: string;
}

const bufToB64 = (buf: ArrayBuffer) => {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64ToBuf = (b64: string) => {
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
};
/** What an OBS page says when it asks for the items: who it is (the bus id of the page) and which RAM pictures it already holds. */
const NEED_ID = /^[A-Za-z0-9_-]{1,40}$/;
const needOf = (a: unknown): { from: string; have: Set<string> } => {
  const x = (a && typeof a === 'object' ? a : {}) as { from?: unknown; have?: unknown };
  const have = new Set<string>();
  if (Array.isArray(x.have)) for (const r of x.have.slice(0, ITEM_LIMITS.maxRamItems)) if (typeof r === 'string' && r.length <= 80) have.add(r);
  return { from: typeof x.from === 'string' && NEED_ID.test(x.from) ? x.from : '', have };
};
const newRef = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const libUrl = (lib: string) => `/api/items/file/${lib.split('/').map(encodeURIComponent).join('/')}`;

/** What a model-like runtime looks like (the OBS page's debug handle can hold other things, e.g. a TV). */
function asRuntime(x: unknown): AvatarRuntime | null {
  const r = x as Partial<AvatarRuntime> | null | undefined;
  return r && typeof r === 'object' && r.model && r.wrapper && typeof r.bounds === 'function' ? (r as AvatarRuntime) : null;
}

// ================================================================ shared byte source

class ByteSource {
  private cache = new Map<string, ArrayBuffer>();
  constructor(private readonly store: ItemStore) {}
  async bytesOf(spec: ItemSpec): Promise<ArrayBuffer | null> {
    if ('ram' in spec.src) {
      const d = this.store.ram.get(spec.src.ram);
      return d ? b64ToBuf(d.b64) : null;
    }
    const lib = spec.src.lib;
    const hit = this.cache.get(lib);
    if (hit) return hit.slice(0);
    const r = await fetch(libUrl(lib)).catch(() => null);
    if (!r?.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > ITEM_LIMITS.maxBytes) return null;
    if (this.cache.size >= 24) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(lib, buf);
    return buf.slice(0);
  }
  forget(lib: string) { this.cache.delete(lib); }
  clear() { this.cache.clear(); }
}

// ================================================================ the studio

export class StudioEngine {
  readonly store = new ItemStore({ self: '@host', honorTtl: true });
  readonly view: ItemsView;
  readonly tint: ArtTinter;
  readonly lib: LibraryState = { state: 'idle', starters: [], mine: [], licence: '' };
  private readonly bytes: ByteSource;
  private readonly gizmo: ItemGizmo;
  private readonly drop: ItemDropZone;
  private readonly watchers = new Set<() => void>();
  private readonly undo: (() => void)[] = [];
  private readonly readOnly: boolean;
  private selectedId: string | null = null;
  private scenesLoaded: Promise<void> | null = null;
  private libLoading: Promise<void> | null = null;
  private expiryT = 0;
  private bagT = 0;
  private lastBag = '';
  private stateT = 0;
  private needT = 0;
  /** Pages that asked since the last reply (bus id -> the RAM refs it already holds); '' = an asker that did not say who it is. */
  private readonly needs = new Map<string, Set<string>>();
  private restored = false;
  private dead = false;

  constructor(private readonly ctx: B16Ctx & { app: App }) {
    const app = ctx.app;
    this.readOnly = app.observer;
    this.bytes = new ByteSource(this.store);
    this.view = new ItemsView(this.store, { bytesOf: (s) => this.bytes.bytesOf(s), onProblem: (_id, why) => toast(why, 'warn', 6000) });
    this.tint = new ArtTinter(() => app.runtime);
    this.gizmo = new ItemGizmo({
      canvas: app.stage.canvas, camera: () => app.stage.camera, view: this.view,
      place: (id) => this.store.items.get(id)?.spec.place,
      move: (id, p, live) => this.patch(id, p, live),
      remove: (id) => this.remove(id),
      committed: (id) => this.commit(id),
      changed: (id) => { this.selectedId = id; this.notify(); },
      count: () => this.store.size,
    });
    this.drop = new ItemDropZone({
      canvas: app.stage.canvas,
      files: (files, at) => this.addFiles(files, at ? this.pinAt(at.x, at.y) : undefined),
    });

    // the avatar was (re)built: hang everything on the new one
    this.undo.push(app.on((what) => { if (what === 'avatar') this.attach(); }));
    // the OLD avatar is about to be disposed (App.build): its dispose walks every mesh under its model, and our holders hang there
    this.undo.push(onAvatarBeforeDispose((old) => { if (this.view.runtime === old) this.view.attach(null); }));
    // the host's own library items come back after a studio reload (they were saved in the scene's items bag)
    this.undo.push(app.scene.on(() => this.restore()));
    this.restore();
    this.attach();

    this.undo.push(ctx.bus.on((m) => this.onBus(m)));
    this.registerRules();
  }

  // ------------------------------------------------------------ plumbing

  onChange(fn: () => void) { this.watchers.add(fn); return () => { this.watchers.delete(fn); }; }
  private notify() { for (const w of [...this.watchers]) { try { w(); } catch { /* a panel that is gone */ } } }
  get selected() { return this.selectedId; }
  get runtime(): AvatarRuntime | null { return this.ctx.app.runtime; }

  private attach() {
    this.view.attach(this.ctx.app.runtime);
    this.tint.reattach();
    this.gizmo.refresh();
  }

  /** The reload path: put back the host's library items from the scene bag once, as soon as the scene state is in. */
  private restore() {
    if (this.restored || this.dead) return;
    const app = this.ctx.app;
    if (!app.scene.videoHost && !this.readOnly) return;
    this.restored = true;
    const bag = app.scene.modeBag(ITEMS_BAG);
    if (bag && !this.store.size) {
      this.store.loadBag(bag);
      this.lastBag = JSON.stringify(this.store.toBag());
      this.view.reconcile();
      this.afterChange({ ok: true, changed: true, played: this.store.snapshot(), events: [], added: [], removed: [] }, { persist: false });
    }
  }

  // (an observer tab's own bus is muted by App, so nothing from a read-only studio ever reaches an OBS page)
  private send(m: BusMessage) { this.ctx.bus.send(m); }

  // ------------------------------------------------------------ the library and the scenes (the helper)

  loadLibrary(force = false): Promise<void> {
    if (this.libLoading && !force) return this.libLoading;
    this.lib.state = 'loading'; this.notify();
    this.libLoading = (async () => {
      try {
        const r = await fetch('/api/items/library');
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json() as { starter?: { stickers?: StickerDef[]; licence?: string }; mine?: MineFile[] };
        this.lib.starters = j.starter?.stickers ?? []; this.lib.licence = j.starter?.licence ?? '';
        this.lib.mine = Array.isArray(j.mine) ? j.mine : [];
        this.lib.state = 'ready';
      } catch { this.lib.state = 'offline'; }
      this.notify();
    })();
    return this.libLoading;
  }

  private ensureScenes(): Promise<void> {
    this.scenesLoaded ??= (async () => {
      try {
        const r = await fetch('/api/items/scenes');
        if (r.ok) { const j = await r.json() as { scenes?: unknown }; this.store.setScenes(j.scenes); this.notify(); }
      } catch { /* VTube Pro is not answering: scenes stay empty */ }
    })();
    return this.scenesLoaded;
  }

  /** True when the server wrote the scenes. A save that did not land says so (the scenes stay here, in this page, until a reload). */
  private async saveScenes(): Promise<boolean> {
    try {
      const r = await fetch('/api/items/scenes', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-vtp-user-action': '1' }, body: JSON.stringify({ scenes: this.store.scenes }) });
      if (r.ok) return true;
      toast('Your scenes did not save on this PC. They stay here until you reload this page', 'warn', 6000);
    } catch { toast('Could not save your scenes on this PC. Is VTube Pro running?', 'warn', 6000); }
    return false;
  }

  pickable(): PickableSticker[] { return pickables(this.lib.starters, this.lib.mine); }

  // ------------------------------------------------------------ applying

  /** Apply one op from anywhere (panel, bus, rules). Plain-words error toasts unless `quiet`. */
  dispatch(op: ItemOp, o: { quiet?: boolean; live?: boolean } = {}): ApplyResult {
    const r = this.store.apply(op, Date.now());
    if (!r.ok) { if (!o.quiet) toast(r.error ?? 'That did not work', 'warn', 5000); return r; }
    if (op.op === 'list') { this.publishState(op.req, true); return r; }
    if (r.changed) this.afterChange(r, { live: o.live });
    else if (op.op === 'scene-save') this.notify();
    return r;
  }

  private afterChange(r: ApplyResult, o: { persist?: boolean; live?: boolean } = {}) {
    this.view.reconcile();
    if (r.played.length) this.send(commandMessage(ITEM_PLAY_COMMAND, { ops: r.played }));
    for (const e of r.events) if (!(o.live && e.ev === 'moved')) this.send(commandMessage(ITEM_EVENT_COMMAND, e));
    if (this.selectedId && !this.store.has(this.selectedId)) { this.selectedId = null; this.gizmo.select(null); }
    this.armExpiry();
    if (o.persist !== false) this.armBag();
    this.armState();
    this.gizmo.refresh();
    this.notify();
  }

  private armExpiry() {
    clearTimeout(this.expiryT);
    const at = this.store.nextExpiry();
    if (at === null) return;
    this.expiryT = window.setTimeout(() => { const r = this.store.expire(Date.now()); if (r.changed) this.afterChange(r); else this.armExpiry(); }, Math.max(20, at - Date.now() + 5));
  }
  private armBag() {
    if (this.readOnly) return;
    clearTimeout(this.bagT);
    this.bagT = window.setTimeout(() => {
      const bag = this.store.toBag();
      const j = JSON.stringify(bag);
      if (j === this.lastBag) return;
      this.lastBag = j;
      this.ctx.app.scene.setModeBag(ITEMS_BAG, bag);
    }, 500);
  }
  private armState() {
    if (this.stateT) return;
    this.stateT = window.setTimeout(() => { this.stateT = 0; this.publishState(undefined, false); }, 150);
  }
  private publishState(req: string | undefined, now: boolean) {
    if (now) { clearTimeout(this.stateT); this.stateT = 0; }
    this.send(commandMessage(ITEM_STATE_COMMAND, this.store.state(req)));
  }

  // ------------------------------------------------------------ the bus

  private onBus(m: BusMessage) {
    if (m.type !== 'command') return;
    switch (m.command) {
      case ITEM_COMMAND: { const op = sanitizeItemOp(m.args); if (op) void this.fromBus(op); break; }
      case 'item-scene': void this.runScene(m.args as Record<string, unknown> | undefined, 'deck'); break;
      case 'sticker': void this.runSticker(m.args as Record<string, unknown> | undefined, 'deck'); break;
      case ITEM_NEED_COMMAND: {
        const n = needOf(m.args);
        if (this.needs.size < 16 || this.needs.has(n.from)) this.needs.set(n.from, n.have); else this.needs.set('', new Set());   // (a crowd of askers: one reply to all)
        if (!this.needT) this.needT = window.setTimeout(() => { this.needT = 0; this.sendSync(); }, 150);
        break;
      }
      case ART_LIST_COMMAND: { const req = typeof (m.args as { req?: unknown } | undefined)?.req === 'string' ? (m.args as { req: string }).req : undefined; this.send(commandMessage(replyOf(ART_LIST_COMMAND), this.tint.list(req))); break; }
      case ART_TINT_COMMAND: { const t = sanitizeArtTint(m.args); if (t) this.tint.apply(t); break; }
    }
  }

  private async fromBus(op: ItemOp) {
    if (op.op.startsWith('scene-')) await this.ensureScenes();
    const r = this.dispatch(op, { quiet: ('by' in op && op.by === 'vts') || op.op === 'list' });
    if (r.ok && op.op === 'scene-save') void this.saveScenes();
    if (r.ok && op.op === 'scene-delete') void this.saveScenes();
  }

  /** One reply per page that asked, addressed to it (`to`) and carrying only the RAM pictures it does not hold yet; the others ignore it.
   *  An asker that did not say who it is gets everything, as before. */
  private sendSync() {
    const asked = [...this.needs]; this.needs.clear();
    if (!asked.length) return;
    const items = this.store.list().map((e) => { const { ttlSecs: _t, ...spec } = e.spec; void _t; return { ...spec, ...(e.by ? { by: e.by } : {}), ...(e.scene ? { scene: e.scene } : {}) }; });
    for (const [from, have] of asked) {
      const data = [...this.store.ram.values()].filter((d) => !have.has(d.ref));
      this.send(commandMessage(ITEM_SYNC_COMMAND, { items, data, ...(from ? { to: from } : {}) }));
    }
  }

  // ------------------------------------------------------------ deck / rules words

  async runSticker(a: Record<string, unknown> | undefined, by: ItemSource, quiet = false): Promise<{ ok: boolean; error?: string; ids: string[] }> {
    await this.loadLibrary();
    const plan = planSticker({ op: typeof a?.op === 'string' ? a.op : 'random', item: typeof a?.item === 'string' ? a.item : '', secs: Number(a?.secs) || 0 }, { store: this.store, pickables: this.pickable(), rng: Math.random, by });
    if (!plan.ok) { if (!quiet) toast(plan.error, 'warn', 5000); return { ok: false, error: plan.error, ids: [] }; }
    for (const op of plan.ops) this.dispatch(op.op === 'add' ? { ...op, item: { ...op.item, place: this.view.fitPlace(op.item.pin, op.item.place) } } : op, { quiet: true });
    return { ok: true, ids: plan.ids };
  }

  async runScene(a: Record<string, unknown> | undefined, by: ItemSource, quiet = false): Promise<{ ok: boolean; error?: string; name?: string; before?: boolean }> {
    await this.ensureScenes();
    const plan = planItemScene({ name: typeof a?.name === 'string' ? a.name : '', on: a?.on as boolean | string | undefined }, { store: this.store, by });
    if (!plan.ok) { if (!quiet) toast(plan.error, 'warn', 5000); return { ok: false, error: plan.error }; }
    const name = plan.name!;
    const before = this.store.sceneOn(name);
    for (const op of plan.ops) this.dispatch(op, { quiet });
    return { ok: true, name, before };
  }

  private registerRules() {
    const meta = (id: string) => ACTION_BY_ID.get(id);
    const st = meta('sticker'), sc = meta('item-scene');
    this.undo.push(registerRuleAction('sticker', async (c) => {
      const r = await this.runSticker({ op: c.params.op, item: c.params.item, secs: c.params.secs }, 'rule', true);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, ...(r.ids.length ? { undo: { action: 'sticker', params: { op: 'remove', item: r.ids[0] } } } : {}) };
    }, { label: st?.label ?? 'Sticker on me', group: st?.group ?? 'Stream extras', icon: st?.icon ?? '🏷️', params: st?.params, where: 'studio', undoable: true }));
    this.undo.push(registerRuleAction('item-scene', async (c) => {
      const r = await this.runScene({ name: c.params.name, on: c.params.on }, 'rule', true);
      if (!r.ok) return { ok: false, error: r.error };
      const now = this.store.sceneOn(r.name!);
      return { ok: true, ...(now !== r.before ? { undo: { action: 'item-scene', params: { name: r.name!, on: r.before ? true : false } } } : {}) };
    }, { label: sc?.label ?? 'Item scene', group: sc?.group ?? 'Stream extras', icon: sc?.icon ?? '🎩', params: sc?.params, where: 'studio', undoable: true }));
  }

  // ------------------------------------------------------------ what the panel and the preview do

  select(id: string | null) { this.selectedId = id && this.store.has(id) ? id : null; this.gizmo.select(this.selectedId); this.notify(); }

  /** The "Where" choice nearest a point of the preview (0..1 of it). */
  pinAt(nx: number, ny: number): string | undefined {
    const pts = this.view.choicePoints(this.ctx.app.stage.camera);
    return nearestPin(pts, nx, ny) ?? undefined;
  }

  addSticker(p: PickableSticker, choiceId?: string): string | null {
    if (this.store.size >= ITEM_LIMITS.maxItems) { toast(`You already have ${ITEM_LIMITS.maxItems} things on your avatar. Take one off first`, 'warn'); return null; }
    const def = p.def;
    const choice = pinChoice(choiceId ?? def?.pin ?? 'forehead') ?? pinChoice('forehead')!;
    const id = freeItemId(`st-${p.id}`, (x) => this.store.has(x));
    const kind = /\.glb$/i.test(p.lib) ? 'model' : 'image';
    const spec = specForChoice(id, kind, { lib: p.lib }, choice, choiceId && choiceId !== def?.pin ? { name: p.name } : { place: def?.place, layer: def?.layer, hand: def?.hand, name: p.name });
    const r = this.dispatch({ op: 'add', item: { ...spec, place: this.view.fitPlace(spec.pin, spec.place) }, by: 'host' });
    if (!r.ok) return null;
    this.select(id);
    return id;
  }

  randomSticker() { void this.runSticker({ op: 'random' }, 'host').then((r) => { if (r.ok && r.ids[0]) this.select(r.ids[0]); }); }

  /** Files from a drop or the "Add a picture" button: RAM only. `choiceId`: where (the nearest spot to the drop). */
  async addFiles(files: File[], choiceId?: string): Promise<void> {
    let n = 0;
    for (const f of files.slice(0, 5)) {
      if (f.size > ITEM_LIMITS.maxBytes) { toast(`"${f.name}" is bigger than 2 MB. Try a smaller picture`, 'warn', 6000); continue; }
      const buf = await f.arrayBuffer();
      const mime = sniffItemMime(new Uint8Array(buf, 0, Math.min(4200, buf.byteLength)));
      if (!mime) { toast(`"${f.name}" is not a picture or 3D model I can put on you. Use PNG, GIF, WebP, JPEG or a .glb`, 'warn', 7000); continue; }
      const b64 = bufToB64(buf);
      if (b64Bytes(b64) > ITEM_LIMITS.maxBytes) continue;
      const ref = newRef();
      const choice = pinChoice(choiceId ?? 'forehead') ?? pinChoice('forehead')!;
      const nm = f.name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 40) || 'My picture';
      const id = freeItemId(nm, (x) => this.store.has(x));
      const spec = specForChoice(id, itemKindOf(mime), { ram: ref }, choice, { name: nm, place: n ? { x: choice.place.x + n * 0.03, y: choice.place.y - n * 0.03 } : undefined });
      const r = this.dispatch({ op: 'add', item: { ...spec, place: this.view.fitPlace(spec.pin, spec.place) }, data: { ref, mime, b64 }, by: 'host' });
      if (r.ok) { n++; this.select(id); }
    }
    if (n) toast(n === 1 ? 'On! Drag it to move, the corner to resize' : `${n} things on`, 'ok', 3500);
  }

  setWhere(id: string, choiceId: string) {
    const e = this.store.items.get(id), c = pinChoice(choiceId);
    if (!e || !c) return;
    this.dispatch({ op: 'pin', id, pin: c.pin, place: this.view.fitPlace(c.pin, c.place) });
    this.dispatch({ op: 'move', id, layer: c.layer });
    // a held prop keeps the hand pose the person chose; moving it off a hand lets go
    const want = c.hand ? (e.spec.hand ?? c.hand) : undefined;
    if ((e.spec.hand?.pose ?? null) !== (want?.pose ?? null)) this.setHand(id, (want?.pose as HandPose | undefined) ?? null);
  }
  setHand(id: string, pose: HandPose | null) {
    const e = this.store.items.get(id);
    if (!e) return;
    const { hand: _h, ...rest } = e.spec;
    void _h;
    this.dispatch({ op: 'add', item: { ...rest, ...(pose ? { hand: { pose } } : {}) }, ...(e.by ? { by: e.by } : {}) });
  }
  /** A drag on the preview ended: now tell subscribers where it landed (and save it). */
  private commit(id: string) {
    const e = this.store.items.get(id);
    if (!e) return;
    this.send(commandMessage(ITEM_EVENT_COMMAND, { ev: 'moved', id, place: e.spec.place, target: '@host' }));
    this.publishState(undefined, true);
    this.armBag();
    this.notify();
  }
  patch(id: string, p: Partial<ItemPlace>, live = false) { this.dispatch({ op: 'move', id, place: p }, { quiet: true, live }); }
  setLayer(id: string, layer: 'front' | 'behind') { this.dispatch({ op: 'move', id, layer }); }
  setOpacity(id: string, opacity: number) { this.dispatch({ op: 'move', id, opacity }, { live: true }); }
  remove(id: string) { this.dispatch({ op: 'remove', id }); }
  clearAll() { this.dispatch({ op: 'clear' }); }

  /** "Keep in my library": the host's own picture, saved on this PC on their click, then the item points at the saved file. */
  async keep(id: string): Promise<boolean> {
    const e = this.store.items.get(id);
    if (!e || !('ram' in e.spec.src)) return false;
    const d = this.store.ram.get(e.spec.src.ram);
    if (!d) { toast('That picture is not here any more. Drop it again', 'warn'); return false; }
    try {
      const r = await fetch(`/api/items/mine?name=${encodeURIComponent(e.spec.name || e.spec.id)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-vtp-user-action': '1' }, body: b64ToBuf(d.b64) });
      const j = await r.json().catch(() => ({})) as { lib?: string; error?: string };
      if (!r.ok || !j.lib) { toast(j.error ?? 'I could not save it. Is VTube Pro running?', 'warn', 6000); return false; }
      this.dispatch({ op: 'add', item: { ...e.spec, src: { lib: j.lib } }, ...(e.by ? { by: e.by } : {}) }, { quiet: true });
      void this.loadLibrary(true);
      return true;
    } catch { toast('I could not save it. Is VTube Pro running?', 'warn', 6000); return false; }
  }

  async deleteMine(file: string) {
    try {
      const r = await fetch(`/api/items/mine/${encodeURIComponent(file.replace(/^mine\//, ''))}`, { method: 'DELETE', headers: { 'x-vtp-user-action': '1' } });
      if (r.ok) this.bytes.forget(file);
    }
    catch { toast('I could not delete it. Is VTube Pro running?', 'warn'); }
    void this.loadLibrary(true);
  }

  async saveScene(rawName: string, secs: number, keepDropped: boolean): Promise<boolean> {
    const name = cleanSceneName(rawName);
    if (!name) { toast('Give the scene a name first', 'warn'); return false; }
    await this.ensureScenes();
    if (keepDropped) for (const e of this.store.list()) if ('ram' in e.spec.src) await this.keep(e.spec.id);
    const r = this.dispatch({ op: 'scene-save', name, ...(secs > 0 ? { secs } : {}) });
    if (r.ok) { if (await this.saveScenes()) toast(`Saved "${name}". Switch it on from here, a deck key or a redeem`, 'ok', 4500); this.notify(); }
    return r.ok;
  }
  async toggleScene(name: string) { await this.runScene({ name, on: 'toggle' }, 'host'); }
  async deleteScene(name: string) { await this.ensureScenes(); const r = this.dispatch({ op: 'scene-delete', name }); if (r.ok) { await this.saveScenes(); this.notify(); } }
  async openScenes() { await this.ensureScenes(); this.notify(); }
  droppedCount() { return this.store.ramCount(); }

  dispose() {
    this.dead = true;
    for (const u of this.undo.splice(0)) { try { u(); } catch { /* best effort */ } }
    clearTimeout(this.expiryT); clearTimeout(this.bagT); clearTimeout(this.stateT); clearTimeout(this.needT); this.needs.clear();
    this.gizmo.dispose(); this.drop.dispose(); this.view.dispose(); this.tint.clearAll(); this.bytes.clear();
    this.watchers.clear();
  }
}

// ================================================================ an OBS page / preview

export class OutputEngine {
  readonly store = new ItemStore({ self: '@host', honorTtl: false });
  readonly view: ItemsView;
  readonly tint: ArtTinter;
  private readonly bytes: ByteSource;
  private watchT = 0;
  private readonly undo: (() => void)[] = [];
  private dead = false;

  constructor(private readonly bus: Bus) {
    this.bytes = new ByteSource(this.store);
    this.view = new ItemsView(this.store, { bytesOf: (s) => this.bytes.bytesOf(s) });
    this.tint = new ArtTinter(() => this.runtime());
    this.undo.push(bus.on((m) => this.onBus(m)));
    // a page that opens (or reconnects) asks the studio what is on
    this.ask();
    this.undo.push(bus.onLink((up) => { if (up) this.ask(); }));
  }

  private runtime(): AvatarRuntime | null { return asRuntime((window as unknown as { vtpOut?: { runtime?: unknown } }).vtpOut?.runtime); }
  /** `from` = this page (the studio answers it alone); `have` = the RAM pictures already here, which the studio then leaves out. */
  private ask() { this.bus.send(commandMessage(ITEM_NEED_COMMAND, { from: this.bus.id, have: [...this.store.ram.keys()] })); }

  private onBus(m: BusMessage) {
    if (m.type !== 'command') return;
    switch (m.command) {
      case ITEM_PLAY_COMMAND: {
        const p = sanitizeItemPlay(m.args);
        if (p) { this.store.replay(p.ops); this.sync(); }
        break;
      }
      case ITEM_SYNC_COMMAND: {
        const to = (m.args as { to?: unknown } | undefined)?.to;
        if (typeof to === 'string' && to !== this.bus.id) break;   // another page's answer
        const s = sanitizeItemSync(m.args);
        if (!s) break;
        const held = new Map(this.store.ram);   // pictures cached by ref: the studio does not send these again
        this.store.reset();
        const ops: ItemOp[] = [];
        for (const it of s.items) { const ref = 'ram' in it.src ? (it.src as { ram: string }).ram : '', d = ref ? s.data.find((x) => x.ref === ref) ?? held.get(ref) : undefined; const { by, scene: _s, ...spec } = it; void _s; ops.push({ op: 'add', item: spec, ...(d ? { data: d } : {}), ...(by ? { by } : {}) }); }
        for (const o of ops) this.store.apply(o);
        this.sync();
        break;
      }
      case ART_TINT_COMMAND: { const t = sanitizeArtTint(m.args); if (t) { this.attachNow(); this.tint.apply(t); this.watch(); } break; }
    }
  }

  private attachNow() {
    const rt = this.runtime();
    if (rt && rt !== this.view.runtime) { this.view.attach(rt); this.tint.reattach(); }
  }
  private sync() { this.attachNow(); this.view.reconcile(); this.watch(); }

  /** While something is on, notice an avatar switch (the page rebuilt its runtime) once a second; with nothing on there is no timer. */
  private watch() {
    const need = this.store.size > 0 || this.tint.count > 0;
    if (need && !this.watchT && !this.dead) this.watchT = window.setInterval(() => { this.attachNow(); if (!this.store.size && !this.tint.count) this.watch(); }, 1000);
    else if (!need && this.watchT) { clearInterval(this.watchT); this.watchT = 0; }
  }

  dispose() {
    this.dead = true;
    for (const u of this.undo.splice(0)) { try { u(); } catch { /* best effort */ } }
    if (this.watchT) clearInterval(this.watchT);
    this.view.dispose(); this.tint.clearAll(); this.bytes.clear();
  }
}
