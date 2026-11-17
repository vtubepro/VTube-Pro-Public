// The Room editor (docs/ROOM_EDITOR.md): runs inside `output.html?roomEdit=<room>` — a private test page of the room
// (it never follows the bus' scene state, never publishes frames), opened by the studio's "Edit room" (src/ui/roomEditor.ts)
// in a full-window frame. Select and move / turn cameras (CAM_WIDE, CAM_REACT, CAM_*, the talk cameras SPOT_xx_CAM, your
// own CAM_MY_n), the places (SPOT_xx), the react SCREEN, the solo React screen + chat monitor + support board + chat-buddy
// point of a spot, and placed props, with a gizmo (W move · E turn · R size) or typed numbers. "Look through" shows the
// selected camera exactly as OBS frames it (16:9) with the face-safe guides; in that view the mouse flies that camera.
// Snap, Reset (one thing / everything), Undo / Redo (Ctrl+Z / Ctrl+Y). Nothing reaches OBS until Save: Save writes the
// override layer (server/routes/roomEdits.ts) and the server sends ONE message the OBS pages apply in place; while OBS
// is streaming / recording it asks first (apply now, or keep it for the next time the room loads).
// Also: the room's OWN objects (a desk, the plants, a wall: src/scene/roomObjects.ts) — click one in the view or the
// "Room objects" list, then move / turn / size it with the same gizmo, or Hide it; and named Layouts (layouts.ts) +
// Reset to default.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Stage } from '../../stage/Stage.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { lookPose } from '../cameraRig.ts';
import { EVAL_SAFE_BY } from '../../../shared/framing.ts';
import { chatScreenBox, checkEditView, faceBoxNdc, propBox, type CheckView, type EditWarning } from '../../../shared/roomEditCheck.ts';
import { checkRoomEdits, cloneEdits, editCount, emptyEdits, newPropUid, sameEdits, spotKey, MY_CAM_KEY, type RoomEdits, type V3 } from '../../../shared/roomEdits.ts';
import type { PropItem } from '../../../shared/propPacks.ts';
import { PlacedProps, eulerOf, propCatalog, rotOf } from '../roomEdits.ts';
import { ChatScreens, chatScreensOf } from '../chatScreens.ts';
import { CHAT_SCREEN_LIMITS, DEFAULT_CHAT_SCREEN, type ChatScreen } from '../../../shared/roomEdits.ts';
import { faceHeight } from '../../../shared/roomSeats.ts';
import { editsEmpty } from '../../../shared/roomEdits.ts';
import { authoredRoomMatrix, listRoomObjects, moveRoomNodes, objectNode, objectNodes, objectTarget, originToPivot, roomPose, type RoomObject } from '../roomObjects.ts';
import { LayoutsSection } from './layouts.ts';

export interface EditorHost { stage: Stage; room: string; scene: () => SceneRuntime | null; reload: () => void }
type Kind = 'cam' | 'spot' | 'screen' | 'solo' | 'monitor' | 'board' | 'buddy' | 'prop' | 'chat' | 'obj';
interface Item { id: string; kind: Kind; label: string; key: string; edited: boolean; group: string }

const PANEL_W = 340, BAR_H = 46;
const CSS = `
body.vtp-re { background:#0d1016 !important; font: 13px/1.35 Inter, system-ui, sans-serif; color:#e7ebf3; }
body.vtp-re canvas#stage { position:fixed; }
.re-panel { position:fixed; left:0; top:0; bottom:0; width:${PANEL_W}px; overflow:auto; background:#151a23; border-right:1px solid #283041; z-index:10; box-sizing:border-box; padding:10px 12px 40px; }
.re-bar { position:fixed; left:${PANEL_W}px; right:0; top:0; height:${BAR_H}px; display:flex; gap:6px; align-items:center; padding:0 10px; background:#151a23; border-bottom:1px solid #283041; z-index:10; box-sizing:border-box; overflow-x:auto; }
.re-bar .sp { flex:1; }
.re-btn { background:#232a38; color:#e7ebf3; border:1px solid #344055; border-radius:7px; padding:5px 10px; font:600 12px system-ui, sans-serif; cursor:pointer; white-space:nowrap; }
.re-btn:hover { background:#2b3446; } .re-btn.on { background:#6cc7f5; color:#06131a; border-color:transparent; }
.re-btn.go { background:#7bd88f; color:#06131a; border-color:transparent; } .re-btn.warn { background:#3a2a1a; border-color:#a8742c; }
.re-btn:disabled { opacity:.45; cursor:default; }
.re-h { font:700 11px system-ui; letter-spacing:.06em; text-transform:uppercase; color:#8d99ae; margin:14px 0 6px; }
.re-title { font:700 16px system-ui; margin:2px 0 2px; } .re-sub { color:#8d99ae; font-size:12px; margin-bottom:6px; }
.re-list { display:flex; flex-direction:column; gap:2px; }
.re-item { display:flex; align-items:center; gap:6px; padding:4px 7px; border-radius:6px; cursor:pointer; border:1px solid transparent; }
.re-item:hover { background:#1d2330; } .re-item.sel { background:#1f3242; border-color:#6cc7f5; }
.re-item .dot { width:8px; height:8px; border-radius:50%; background:#4a5568; flex:none; } .re-item.ed .dot { background:#ffd166; }
.re-item .nm { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .re-item .tag { color:#8d99ae; font-size:11px; }
.re-fields { display:grid; grid-template-columns: 64px 1fr 1fr 1fr; gap:4px 6px; align-items:center; margin:6px 0; }
.re-fields label { color:#8d99ae; font-size:12px; } .re-fields input { width:100%; box-sizing:border-box; background:#0f131b; color:#e7ebf3; border:1px solid #344055; border-radius:5px; padding:3px 5px; font: 12px ui-monospace, Consolas, monospace; }
.re-row { display:flex; gap:6px; flex-wrap:wrap; margin:6px 0; }
.re-sel { background:#0f131b; color:#e7ebf3; border:1px solid #344055; border-radius:5px; padding:3px 5px; }
.re-warn { position:fixed; right:10px; bottom:10px; max-width:440px; z-index:11; display:flex; flex-direction:column; gap:4px; pointer-events:none; }
.re-warn div { pointer-events:auto; display:flex; gap:8px; align-items:center; } .re-warn div span { flex:1; }
.re-warn button { flex:none; background:#ffd166; color:#1b1408; border:0; border-radius:6px; padding:4px 9px; font:700 12px system-ui; cursor:pointer; }
.re-big { font-size:14px; padding:8px 14px; }
.re-warn div { background:#2a2113ee; border:1px solid #a8742c; color:#ffe2b0; border-radius:7px; padding:5px 9px; font-size:12px; }
.re-warn div.bad { background:#2c1518ee; border-color:#c2454f; color:#ffd0d4; }
.re-warn div.ok { background:#13261aee; border-color:#3d8a55; color:#c7f0d2; }
.re-guides { position:fixed; pointer-events:none; z-index:5; }
.re-guides .g { position:absolute; border:1px dashed #ffffffaa; } .re-guides .g.t { border-color:#7bd88fcc; } .re-guides .g.w { border-color:#6cc7f5aa; }
.re-guides .f { position:absolute; border:2px solid #7bd88f; border-radius:3px; } .re-guides .f.out { border-color:#ff5d6c; }
.re-guides .lb { position:absolute; left:6px; top:4px; font:600 11px system-ui; color:#fff; text-shadow:0 1px 2px #000; }
.re-props { display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; max-height:300px; overflow:auto; margin-top:6px; }
.re-prop { background:#0f131b; border:1px solid #2a3344; border-radius:7px; padding:4px; cursor:pointer; text-align:center; font-size:11px; color:#c9d2e3; }
.re-prop:hover { border-color:#6cc7f5; } .re-prop img { width:100%; aspect-ratio:1; object-fit:contain; display:block; }
.re-prop .ph { width:100%; aspect-ratio:1; display:flex; align-items:center; justify-content:center; color:#4a5568; font-size:22px; }
.re-modal { position:fixed; inset:0; background:#000a; z-index:30; display:flex; align-items:center; justify-content:center; }
.re-modal .box { background:#151a23; border:1px solid #344055; border-radius:12px; padding:16px 18px; max-width:440px; box-shadow:0 10px 40px #000c; }
.re-note { color:#8d99ae; font-size:12px; margin:4px 0; }
.re-cur { position:sticky; top:-10px; z-index:2; background:#151a23; margin:0 -12px; padding:2px 12px 6px; border-bottom:1px solid #283041; }
.re-lays { display:flex; flex-direction:column; gap:6px; margin:6px 0; }
.re-lay { background:#0f131b; border:1px solid #2a3344; border-radius:8px; padding:6px 8px; }
.re-lay-top { display:flex; gap:8px; align-items:baseline; } .re-lay-top .nm { flex:1; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.re-lay-top .tag { color:#8d99ae; font-size:11px; white-space:nowrap; } .re-lay .re-row { margin:4px 0 0; } .re-lay .re-btn { padding:3px 8px; }
.re-note.bad { color:#ffb4bb; }
.re-objs { display:flex; flex-direction:column; gap:2px; max-height:320px; overflow:auto; }
.re-objs .re-item .re-btn { padding:2px 8px; font-size:11px; } .re-item.hid .nm { color:#8d99ae; text-decoration:line-through; }
.re-store { display:inline-block; margin:2px 0 4px; padding:2px 8px; border-radius:20px; font-size:11px; background:#1f3242; color:#bfe6ff; border:1px solid #31506a; }
.re-toast { position:fixed; left:50%; top:${BAR_H + 10}px; transform:translateX(-50%); background:#1f3242; border:1px solid #6cc7f5; border-radius:8px; padding:6px 12px; z-index:31; }
@media (max-width: 760px) {
  .re-panel { top:auto; width:auto; right:0; height:46vh; border-right:0; border-top:1px solid #283041; }
  .re-bar { left:0; }
  .re-warn { left:8px; right:8px; bottom:auto; top:${BAR_H + 6}px; max-width:none; }
}
`;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const v3 = (v: THREE.Vector3): V3 => [r3(v.x), r3(v.y), r3(v.z)];
const deg = THREE.MathUtils.radToDeg, rad = THREE.MathUtils.degToRad;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined | false)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v); else if (k === 'style') e.style.cssText = String(v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};

/** Install the editor on the room test page. Returns the per-frame hook output.ts calls after every engine. */
export function installRoomEditor(host: EditorHost): (dt: number) => void {
  const ed = new RoomEditor(host);
  (window as unknown as { vtpRoomEdit: RoomEditor }).vtpRoomEdit = ed;
  return (dt) => ed.frame(dt);
}

export class RoomEditor {
  edits: RoomEdits;
  saved: RoomEdits;
  private undo: RoomEdits[] = [];
  private redo: RoomEdits[] = [];
  sel: string | null = null;
  view: 'free' | 'look' = 'free';
  mode: 'translate' | 'rotate' | 'scale' = 'translate';
  snap: 'off' | 'fine' | 'coarse' = 'fine';
  warnings: EditWarning[] = [];
  private rt: SceneRuntime | null = null;
  private readonly edCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.03, 500);
  private orbit: OrbitControls;
  private pilot: OrbitControls;
  private readonly pilotCam = new THREE.PerspectiveCamera(38, 16 / 9, 0.03, 500);
  private tc: TransformControls;
  private helpers = new THREE.Group();
  private proxies = new Map<string, THREE.Object3D>();
  private panel: HTMLElement;
  private bar: HTMLElement;
  private warnBox: HTMLElement;
  private guides: HTMLElement;
  private catalog: PropItem[] = [];
  private catalogFilter = { kit: '', q: '' };
  private dragging = false;
  private loadedFor: SceneRuntime | null = null;
  private ready = false;
  private anchors: { spots: string[]; cams: string[]; screen: boolean } | null = null;
  status = '';
  /** "Reset to default" was pressed: a Save of the empty layer removes the saved one (the live camera tweaks too). */
  private resetPending = false;
  readonly layouts: LayoutsSection;
  /** The room's own objects (src/scene/roomObjects.ts), listed once per room runtime. */
  private objCache: { rt: SceneRuntime; list: RoomObject[]; moving: Set<string> } | null = null;
  private objSection: HTMLElement;
  private objList: HTMLElement;
  private objQ = '';
  private objBox: THREE.BoxHelper | null = null;
  /** Drag start of a room object: its authored room-space size (the gizmo scales on top of it). */
  /** Drag start of a room object (all its nodes: an LOD group's levels too): where they were (the drag moves them live
   *  by the handle's transform; the commit puts them back first and lets the runtime place them from the layer, so the
   *  authored state the runtime snapshots is never a dragged one). */
  private objStart: { primary: THREE.Object3D; authored: THREE.Matrix4; nodes: { node: THREE.Object3D; from: THREE.Matrix4; position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }[] } | null = null;
  private bakedSaid = false;
  private downAt: { x: number; y: number; t: number; hit: boolean } | null = null;

  constructor(private host: EditorHost) {
    this.edits = emptyEdits(host.room);
    this.saved = emptyEdits(host.room);
    document.head.append(el('style', {}, CSS));
    document.body.classList.add('vtp-re');
    this.panel = el('div', { class: 're-panel' });
    this.bar = el('div', { class: 're-bar' });
    this.warnBox = el('div', { class: 're-warn' });
    this.guides = el('div', { class: 're-guides' });
    document.body.append(this.panel, this.bar, this.warnBox, this.guides);
    this.layouts = new LayoutsSection({
      room: host.room, edits: () => this.edits, flash: (m, ms) => this.flash(m, ms), confirm: (t, x, ok, danger) => this.askConfirm(t, x, ok, danger),
      load: (e, name) => this.loadLayout(e, name), resetToDefault: () => this.resetToDefault(),
    });
    this.objList = el('div', { class: 're-objs' });
    const search = el('input', { class: 're-sel', placeholder: 'Find an object', style: 'flex:1;min-width:100px', 'data-obj-search': '1',
      oninput: (e: Event) => { this.objQ = (e.target as HTMLInputElement).value; this.renderObjects(); } });
    this.objSection = el('div', { 'data-section': 'objects' },
      el('div', { class: 're-h' }, 'Room objects'),
      el('div', { class: 're-note', 'data-obj-help': '1' }, "The room's own things. Click one here or in the view, then move, turn or size it. Hide takes it out of the room; Show brings it back."),
      el('div', { class: 're-row' }, search), this.objList);
    PlacedProps.editAll = true;
    ChatScreens.alwaysShow = true;   // (the chat screens show while editing, whatever the chat setting)
    const canvas = host.stage.canvas;
    this.layoutCanvas();
    addEventListener('resize', () => this.layoutCanvas());
    this.orbit = new OrbitControls(this.edCam, canvas);
    this.orbit.enableDamping = true; this.orbit.dampingFactor = 0.15; this.orbit.screenSpacePanning = true;
    this.pilot = new OrbitControls(this.pilotCam, canvas);
    this.pilot.enabled = false; this.pilot.enableDamping = false; this.pilot.screenSpacePanning = true;
    this.pilot.addEventListener('change', () => { if (this.view === 'look' && this.pilot.enabled) this.pilotChanged(); });
    this.pilot.addEventListener('end', () => { if (this.view === 'look') this.commit(); });
    this.tc = new TransformControls(host.stage.camera, canvas);
    this.tc.setSize(1.25);   // (big handles: easy to grab for anyone)
    this.tc.addEventListener('dragging-changed', (e) => {
      this.dragging = !!(e as unknown as { value: boolean }).value;
      if (this.dragging) this.objDragStart();
      this.orbit.enabled = !this.dragging && this.view === 'free';
      if (!this.dragging) this.commitFromProxy();
    });
    this.tc.addEventListener('objectChange', () => this.liveFromProxy());
    this.helpers.name = 'vtp:roomEditHelpers';
    canvas.addEventListener('pointerdown', (e) => this.pick(e));
    canvas.addEventListener('pointerup', (e) => this.pickObject(e));
    window.addEventListener('keydown', (e) => this.key(e));
    void this.loadServer();
    // (installed prop packs first, then the CC0 library kits)
    void propCatalog(true).then((m) => { this.catalog = [...m.values()].sort((a, b) => Number(a.src.startsWith('lib:')) - Number(b.src.startsWith('lib:'))); this.render(); });
    this.render();
  }

  // ---------------------------------------------------------------- layout
  /** The viewport: right of the panel, under the bar, letterboxed to 16:9 (what OBS frames). */
  private viewRect() {
    const narrow = innerWidth <= 760;
    const x0 = narrow ? 0 : PANEL_W, y0 = BAR_H, w0 = innerWidth - x0, h0 = (narrow ? innerHeight * 0.54 : innerHeight) - y0;
    let w = w0, h = (w * 9) / 16;
    if (h > h0) { h = h0; w = (h * 16) / 9; }
    return { x: Math.round(x0 + (w0 - w) / 2), y: Math.round(y0 + (h0 - h) / 2), w: Math.round(w), h: Math.round(h) };
  }
  private layoutCanvas() {
    const r = this.viewRect(), c = this.host.stage.canvas;
    Object.assign(c.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    Object.assign(this.guides.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  // ---------------------------------------------------------------- server
  private async loadServer() {
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(this.host.room)}/edits`);
      const j = await r.json() as { edits?: unknown; anchors?: { spots: string[]; cams: string[]; screen: boolean } | null; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      this.anchors = j.anchors ?? null;
      const e = j.edits ? checkRoomEdits(j.edits, { room: this.host.room }).edits : emptyEdits(this.host.room);
      this.edits = cloneEdits(e); this.saved = cloneEdits(e);
      this.ready = true;
      if (this.rt) this.rt.applyEdits(this.edits);
      this.rebuild();
      // opened for the chat ("Place the chat in the room"): select the first chat screen, or say how to add one
      if (new URLSearchParams(location.search).get('focus') === 'chat') {
        const first = this.edits.chatScreens?.[0];
        if (first) this.select(`chat:${first.uid}`);
        else this.flash('Click "+ Add chat screen" to put the chat where you are looking.', 6000);
      }
    } catch (err) { this.flash(`Could not read this room's edits: ${(err as Error).message}`); this.ready = true; }
  }

  async save(opts: { apply?: 'now' | 'later'; live?: 'ok' } = {}): Promise<boolean> {
    const url = `/api/rooms/${encodeURIComponent(this.host.room)}/edits`;
    // "Reset to default" and nothing changed since: remove the saved layer (the live camera tweaks too), same on-air rule
    const reset = this.resetPending && editsEmpty(this.edits);
    const body = { edits: this.edits, apply: opts.apply ?? 'now', ...(opts.live ? { live: opts.live } : {}) };
    const r = reset
      ? await fetch(`${url}?apply=${opts.apply ?? 'now'}${opts.live ? `&live=${opts.live}` : ''}`, { method: 'DELETE' })
      : await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})) as { live?: boolean; error?: string; errors?: string[]; edits?: RoomEdits | null; applied?: boolean; removed?: boolean };
    if (r.status === 409 && j.live) return this.askLive(j.error ?? 'You are live.');
    if (!r.ok) { this.flash(j.error ?? `Save failed (${r.status})`, 6000); return false; }
    this.saved = cloneEdits(reset ? emptyEdits(this.host.room) : j.edits ?? emptyEdits(this.host.room));
    this.edits.rev = this.saved.rev;
    this.resetPending = false;                       // (the reset was saved, or a later layer replaced it)
    if (reset) { delete this.edits.camTweaks; this.rt?.applyEdits(this.edits); }
    this.host.reload();
    const applied = reset ? opts.apply !== 'later' : !!j.applied;
    this.flash(applied ? (reset ? 'Back to default. Your OBS output now shows it.' : 'Saved. Your OBS output now shows it.') : 'Saved. It shows the next time the room loads.');
    j.applied = applied;
    this.post({ action: 'saved', applied: !!j.applied, changes: editCount(this.saved) });
    this.render();
    return true;
  }
  private askLive(msg: string): Promise<boolean> {
    return new Promise((done) => {
      const m = el('div', { class: 're-modal' }, el('div', { class: 'box' },
        el('div', { class: 're-title' }, 'You are live'), el('p', {}, msg),
        el('div', { class: 're-row' },
          el('button', { class: 're-btn go', onclick: async () => { m.remove(); done(await this.save({ apply: 'now', live: 'ok' })); } }, 'Apply now on stream'),
          el('button', { class: 're-btn', onclick: async () => { m.remove(); done(await this.save({ apply: 'later' })); } }, 'Save for later'),
          el('button', { class: 're-btn', onclick: () => { m.remove(); done(false); } }, 'Cancel'))));
      document.body.append(m);
    });
  }
  /** A plain yes / no question in the editor's own style (never the browser's confirm box). */
  askConfirm(title: string, text: string, ok: string, danger = false): Promise<boolean> {
    return new Promise((done) => {
      const m = el('div', { class: 're-modal', 'data-confirm': '1' }, el('div', { class: 'box' },
        el('div', { class: 're-title' }, title), el('p', {}, text),
        el('div', { class: 're-row' },
          el('button', { class: `re-btn ${danger ? 'warn' : 'go'}`, 'data-ok': '1', onclick: () => { m.remove(); done(true); } }, ok),
          el('button', { class: 're-btn', onclick: () => { m.remove(); done(false); } }, 'Cancel'))));
      document.body.append(m);
    });
  }
  /** A saved layout into the editor (one undo step; Save puts it on stream). */
  loadLayout(e: RoomEdits, name: string) {
    const next = cloneEdits(e);
    next.room = this.host.room; next.rev = this.edits.rev;
    if (this.edits.camTweaks) next.camTweaks = this.edits.camTweaks; else delete next.camTweaks;
    this.resetPending = false;
    this.sel = null;
    this.apply(next);
    this.flash(`Loaded "${name}". Press Save to use it on stream. Undo (Ctrl+Z) goes back.`, 5000);
  }
  /** The room as it came (one undo step). Save then removes the saved layer. */
  resetToDefault() {
    const e = emptyEdits(this.host.room); e.rev = this.edits.rev;
    this.sel = null;
    this.apply(e);
    this.resetPending = true;
    this.flash('The room is back to default here. Press Save to use it on stream. Undo (Ctrl+Z) goes back.', 5000);
  }

  private post(msg: Record<string, unknown>) { try { parent?.postMessage({ type: 'vtp-roomedit', room: this.host.room, ...msg }, location.origin); } catch { /* not framed */ } }
  get dirty() { return !sameEdits(this.edits, this.saved) || (this.resetPending && !!this.saved.camTweaks && Object.keys(this.saved.camTweaks).length > 0); }

  // ---------------------------------------------------------------- per frame
  frame(_dt: number) {
    const rt = this.host.scene();
    if (rt !== this.rt) this.attach(rt);
    if (!rt) return;
    const cam = this.host.stage.camera;
    if (this.view === 'free') {
      this.orbit.update();
      cam.position.copy(this.edCam.position); cam.quaternion.copy(this.edCam.quaternion);
      cam.fov = this.edCam.fov;
    } else {
      cam.position.copy(this.pilotCam.position); cam.quaternion.copy(this.pilotCam.quaternion);
      cam.fov = this.pilotCam.fov;
    }
    cam.near = 0.03; cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    // the helpers face-scale with distance a little so far ones stay pickable
    for (const [, o] of this.proxies) if (o.userData.scaleWithDist) { const d = o.getWorldPosition(new THREE.Vector3()).distanceTo(cam.position); o.scale.setScalar(THREE.MathUtils.clamp(d * 0.08, 0.6, 3)); }
    this.drawGuides();
    // (props finish loading after a change: the warnings are looked at again once a second)
    this.checkT -= _dt;
    if (this.checkT <= 0 && !this.dragging) { this.checkT = 1; this.check(); }
  }
  private checkT = 1;
  private warnSig = '';

  private attach(rt: SceneRuntime | null) {
    this.tc.detach();
    this.helpers.removeFromParent();
    this.rt = rt;
    if (!rt) return;
    rt.room.root.add(this.helpers);
    this.host.stage.scene.add(this.tc.getHelper());
    // a free view: CAM_WIDE (or what the room shows now), a bit wider
    const c = rt.room.cameras.get('CAM_WIDE');
    const p = c?.position.clone() ?? this.host.stage.camera.position.clone();
    const q = c?.quaternion.clone() ?? this.host.stage.camera.quaternion.clone();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    // (from the wide camera itself, a little higher: behind it is usually the fourth wall)
    this.edCam.position.copy(p).add(new THREE.Vector3(0, 0.6, 0));
    this.orbit.target.copy(p).addScaledVector(fwd, 5);
    this.edCam.fov = 50; this.edCam.aspect = 16 / 9;
    this.edCam.lookAt(this.orbit.target);
    this.orbit.update();
    // props: one object per copy (pickable)
    if (rt.props && !rt.props.edit) { rt.props.edit = true; void rt.props.sync((rt.info as { placedProps?: [] }).placedProps ?? []); }
    if (this.ready) rt.applyEdits(this.edits);
    this.loadedFor = rt;
    this.rebuild();
  }

  // ---------------------------------------------------------------- the anchors
  items(): Item[] {
    const rt = this.rt;
    if (!rt) return [];
    const E = this.edits, out: Item[] = [];
    const camNames = [...rt.room.cameras.keys()].sort((a, b) => (a === 'CAM_WIDE' ? -1 : b === 'CAM_WIDE' ? 1 : a === 'CAM_REACT' ? -1 : b === 'CAM_REACT' ? 1 : a.localeCompare(b)));
    for (const n of camNames) out.push({ id: `cam:${n}`, kind: 'cam', key: n, label: n === 'CAM_WIDE' ? 'Wide camera' : n === 'CAM_REACT' ? 'React camera' : MY_CAM_KEY.test(n) ? `My camera ${n.slice(7)}` : n.replace(/^CAM_/, '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), edited: !!E.cameras?.[n], group: 'Cameras' });
    rt.room.spots.forEach((s, i) => {
      if (!s) return;
      const k = spotKey(i);
      if (s.cam || E.cameras?.[`${k}_CAM`]) out.push({ id: `cam:${k}_CAM`, kind: 'cam', key: `${k}_CAM`, label: `Talk camera · ${s.label}`, edited: !!E.cameras?.[`${k}_CAM`], group: 'Cameras' });
    });
    rt.room.spots.forEach((s, i) => { if (s) out.push({ id: `spot:${spotKey(i)}`, kind: 'spot', key: spotKey(i), label: s.label, edited: !!E.spots?.[spotKey(i)], group: 'Places' }); });
    if (rt.room.screen) out.push({ id: 'screen', kind: 'screen', key: 'SCREEN', label: 'React screen', edited: !!E.screen, group: 'Screens + chat' });
    for (const [kind, key, label] of [['solo', 'soloScreens', 'Solo React screen'], ['monitor', 'chatMonitors', 'Chat monitor'], ['board', 'chatBoards', 'Support board'], ['buddy', 'buddySpots', 'Chat buddy spot']] as const) {
      for (const [k] of Object.entries(E[key] ?? {})) out.push({ id: `${kind}:${k}`, kind, key: k, label: `${label} · ${rt.room.spots[+k.slice(5) - 1]?.label ?? k}`, edited: true, group: 'Screens + chat' });
    }
    (E.chatScreens ?? []).forEach((c, i) => out.push({ id: `chat:${c.uid}`, kind: 'chat', key: c.uid, label: `Chat screen ${i + 1}`, edited: true, group: 'Screens + chat' }));
    for (const p of E.props ?? []) out.push({ id: `prop:${p.uid}`, kind: 'prop', key: p.uid, label: this.catalog.find((c) => c.src === p.src)?.name ?? p.src.split('/').pop() ?? p.src, edited: true, group: 'Props' });
    const hid = new Set(E.hiddenObjects ?? []);
    for (const o of this.objects()) out.push({ id: `obj:${o.name}`, kind: 'obj', key: o.name, label: o.label, edited: hid.has(o.name) || !!E.movedObjects?.[o.name], group: 'Room objects' });
    return out;
  }

  /** The room's own objects of the room on show (listed once per room; parts that turn out to move by themselves — a
   *  room animation, an engine — are left out a moment later). */
  objects(): RoomObject[] {
    const rt = this.rt;
    if (!rt) return [];
    if (this.objCache?.rt !== rt) {
      const hidden = new Set([...(this.edits.hiddenObjects ?? []), ...((rt.info.userEdits?.hiddenObjects as string[] | undefined) ?? [])]);
      const list = listRoomObjects(rt.room, hidden);
      const cache = { rt, list, moving: new Set<string>() };
      this.objCache = cache;
      const editOf = (n: string) => JSON.stringify(this.edits.movedObjects?.[n] ?? null);
      const at = new Map(list.map((o) => [o.name, { m: o.node.matrixWorld.clone(), e: editOf(o.name) }]));
      setTimeout(() => {
        if (this.objCache !== cache) return;
        // (moving by itself: its matrix changed while its own edit did not — a room clip, an engine, a moving parent;
        // the user's own moves, and a drag in progress, don't count)
        for (const o of list) {
          o.node.updateWorldMatrix(true, false);
          const a = at.get(o.name)!;
          if (a.e === editOf(o.name) && !(this.dragging && this.sel === `obj:${o.name}`) && !a.m.equals(o.node.matrixWorld)) cache.moving.add(o.name);
        }
        if (cache.moving.size) {
          // (left out, unless the layer already holds it: then it stays listed to Show / Put back, without a handle)
          cache.list = list.filter((o) => !cache.moving.has(o.name) || this.inLayer(o.name));
          if (this.sel?.startsWith('obj:') && cache.moving.has(this.sel.slice(4)) && !this.inLayer(this.sel.slice(4))) this.sel = null;
          this.rebuild();
        }
      }, 2000);
    }
    return this.objCache.list;
  }
  private inLayer(name: string) { return !!this.edits.movedObjects?.[name] || !!this.edits.hiddenObjects?.includes(name); }
  /** A room object that moves by itself (an animation or an engine moves it): no handle, only Show / Put back. */
  movesByItself(name: string) { return !!this.objCache?.moving.has(name);
  }
  private renderObjects() {
    const all = this.objects(), E = this.edits;
    const hid = new Set(E.hiddenObjects ?? []);
    const q = this.objQ.trim().toLowerCase();
    const match = q ? all.filter((o) => `${o.label} ${o.name}`.toLowerCase().includes(q)) : all;
    const shown = match.slice(0, 80);
    const b = (label: string, on: (e: Event) => void, title = '') => el('button', { class: 're-btn', title, onclick: (e: Event) => { e.stopPropagation(); on(e); } }, label);
    this.objList.replaceChildren(...(!all.length ? [el('div', { class: 're-note' }, this.rt ? 'This room has no separate objects to move or hide.' : 'Loading the room…')]
      : !match.length ? [el('div', { class: 're-note' }, `Nothing called "${this.objQ}" in this room.`)]
      : [...shown.map((o) => {
        const h = hid.has(o.name), m = !!E.movedObjects?.[o.name], id = `obj:${o.name}`;
        return el('div', { class: `re-item${id === this.sel ? ' sel' : ''}${h || m ? ' ed' : ''}${h ? ' hid' : ''}`, 'data-id': id, onclick: () => this.select(id) },
          el('span', { class: 'dot' }), el('span', { class: 'nm', title: o.name }, o.label), this.movesByItself(o.name) ? el('span', { class: 'tag', title: 'An animation moves it: it can be hidden or put back, not moved' }, 'moves by itself') : m ? el('span', { class: 'tag' }, 'moved') : null,
          b(h ? 'Show' : 'Hide', () => this.toggleHidden(o.name), h ? 'Put it back in the room' : 'Take it out of the room (Show brings it back)'));
      }), ...(shown.length < match.length ? [el('div', { class: 're-note' }, `Showing ${shown.length} of ${match.length}: type to find the others.`)] : [])]));
  }
  /** Hide / show one of the room's own objects (one undo step). */
  toggleHidden(name: string) {
    const next = cloneEdits(this.edits);
    const h = new Set(next.hiddenObjects ?? []);
    if (h.has(name)) h.delete(name); else h.add(name);
    if (h.size) next.hiddenObjects = [...h]; else delete next.hiddenObjects;
    this.apply(next);
  }

  /** The room-space pose of an item now (from the runtime, which shows the layer). */
  private poseOf(it: Item): { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number } | null {
    const rt = this.rt!, R = rt.room, root = R.root;
    if (it.kind === 'obj') {
      const n = objectNode(R, it.key);
      if (!n) return null;
      const p = roomPose(R, n);
      // (the handle sits at the bottom centre of the object, not at its origin)
      return { pos: originToPivot(n, p.pos, p.quat, p.scale), quat: p.quat, scale: this.edits.movedObjects?.[it.key]?.scale ?? 1 };
    }
    root.updateMatrixWorld(true);
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion()), rootQi = rootQ.clone().invert();
    const local = (w: THREE.Vector3) => root.worldToLocal(w.clone());
    const E = this.edits;
    if (it.kind === 'cam') {
      const sm = /^SPOT_(\d\d)_CAM$/.exec(it.key);
      const c = sm ? R.spots[+sm[1] - 1]?.cam : R.cameras.get(it.key);
      if (!c) return null;
      return { pos: local(c.position), quat: rootQi.clone().multiply(c.quaternion), scale: 1 };
    }
    if (it.kind === 'spot') {
      const s = R.spots[+it.key.slice(5) - 1];
      if (!s) return null;
      return { pos: local(s.position), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw).premultiply(rootQi), scale: 1 };
    }
    if (it.kind === 'screen') {
      const n = R.screen!.node;
      n.updateWorldMatrix(true, false);
      const m = root.matrixWorld.clone().invert().multiply(n.matrixWorld);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), sc = new THREE.Vector3();
      m.decompose(pos, quat, sc);
      // (rolled up at rest: the shown position)
      if (R.screen && n.parent) { const shown = n.parent.localToWorld(R.screen.shownPosition.clone()); pos.copy(local(shown)); }
      return { pos, quat, scale: E.screen?.scale ?? 1 };
    }
    if (it.kind === 'prop') {
      const p = E.props?.find((x) => x.uid === it.key);
      if (!p) return null;
      return { pos: new THREE.Vector3(...p.pos), quat: new THREE.Quaternion().setFromEuler(eulerOf(p.rot)), scale: p.scale };
    }
    if (it.kind === 'chat') {
      const c = E.chatScreens?.find((x) => x.uid === it.key);
      return c ? { pos: new THREE.Vector3(...c.pos), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(c.pitch), rad(c.yaw), 0, 'YXZ')), scale: 1 } : null;
    }
    if (it.kind === 'buddy') {
      const p = E.buddySpots?.[it.key]?.[0];
      return p ? { pos: new THREE.Vector3(...p), quat: new THREE.Quaternion(), scale: 1 } : null;
    }
    const rec = it.kind === 'solo' ? E.soloScreens : it.kind === 'monitor' ? E.chatMonitors : E.chatBoards;
    const p = rec?.[it.key];
    return p ? { pos: new THREE.Vector3(...p.position), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rad(p.yaw)), scale: 1 } : null;
  }

  /** Helper objects (frustums, place markers, panels) for every item; the gizmo moves these. */
  private rebuild() {
    if (!this.rt) { this.render(); return; }
    for (const o of this.proxies.values()) { o.removeFromParent(); o.traverse((c) => { const m = c as THREE.Mesh; m.geometry?.dispose?.(); }); }
    this.proxies.clear();
    for (const it of this.items()) {
      if (it.kind === 'obj' && it.id !== this.sel) continue;           // (room objects: only the selected one needs a handle)
      const p = this.poseOf(it);
      if (!p) continue;
      const o = it.kind === 'prop' || it.kind === 'obj' ? new THREE.Object3D() : helperFor(it, this.edits);
      o.position.copy(p.pos); o.quaternion.copy(p.quat);
      if (it.kind === 'prop' || it.kind === 'screen' || it.kind === 'obj') o.scale.setScalar(p.scale);
      o.userData.item = it.id;
      o.traverse((c) => { c.userData.item = it.id; });
      this.helpers.add(o);
      this.proxies.set(it.id, o);
    }
    this.helpers.visible = this.view === 'free';
    if (this.sel && !this.proxies.has(this.sel)) this.sel = null;
    this.attachGizmo();
    this.check();
    this.render();
    this.renderObjects();
  }
  private attachGizmo() {
    const o = this.sel ? this.proxies.get(this.sel) : null;
    const it = this.sel ? this.items().find((i) => i.id === this.sel) : null;
    this.highlight(it?.kind === 'obj' && this.rt ? objectNode(this.rt.room, it.key) : null);
    if (!o || !it || this.view === 'look' || (it.kind === 'obj' && (this.edits.hiddenObjects?.includes(it.key) || this.movesByItself(it.key)))) { this.tc.detach(); return; }
    this.tc.attach(o);
    const mode = this.mode === 'scale' && !(it.kind === 'prop' || it.kind === 'screen' || it.kind === 'chat' || it.kind === 'obj') ? 'translate' : this.mode;
    this.tc.setMode(mode);
    this.tc.setSpace((mode === 'rotate' && (it.kind === 'cam' || it.kind === 'screen' || it.kind === 'prop' || it.kind === 'chat' || it.kind === 'obj')) || (mode === 'scale' && it.kind === 'chat') ? 'local' : 'world');
    const yawOnly = mode === 'rotate' && (it.kind === 'spot' || it.kind === 'solo' || it.kind === 'monitor' || it.kind === 'board');
    this.tc.showX = !yawOnly && !(mode === 'rotate' && it.kind === 'buddy'); this.tc.showZ = !yawOnly && !(mode === 'rotate' && it.kind === 'cam');
    this.tc.showY = true;
    if (mode === 'rotate' && it.kind === 'chat') { this.tc.showX = true; this.tc.showY = true; this.tc.showZ = false; }
    if (mode === 'scale') { this.tc.showX = this.tc.showY = true; this.tc.showZ = it.kind !== 'chat'; }
    const sn = this.snap === 'off' ? null : this.snap === 'fine' ? [0.05, 5, 0.05] : [0.25, 15, 0.25];
    this.tc.setTranslationSnap(sn ? sn[0] : null); this.tc.setRotationSnap(sn ? rad(sn[1]) : null); this.tc.setScaleSnap(sn ? sn[2] : null);
  }

  // ---------------------------------------------------------------- edits from the gizmo
  /** While dragging: cheap live feedback (cameras / props / the screen move at once; everything else on release). */
  private liveFromProxy() {
    const it = this.sel ? this.items().find((i) => i.id === this.sel) : null, o = this.sel ? this.proxies.get(this.sel) : null;
    if (!it || !o || !this.rt) return;
    if (it.kind === 'prop') {
      if (this.mode === 'scale') { const s = (o.scale.x + o.scale.y + o.scale.z) / 3; o.scale.setScalar(s); }
      const obj = this.rt.props?.objects.get(it.key);
      if (obj) { obj.position.copy(o.position); obj.quaternion.copy(o.quaternion); obj.scale.copy(o.scale); }
    }
    if (it.kind === 'obj') {
      if (this.mode === 'scale') { const s = (o.scale.x + o.scale.y + o.scale.z) / 3; o.scale.setScalar(s); }
      if (this.objStart) {
        // (exactly what the Save will place: the handle → the origin at the AUTHORED size × the gizmo's size, every node
        // of the object moved from its authored room matrix by the same transform, as applyRoomObjects does)
        const s0 = this.objStart, t = objectTarget(this.rt.room, s0.primary, o.position, o.quaternion, o.scale.x, s0.authored);
        moveRoomNodes(this.rt.room, s0.nodes, t.want.clone().multiply(s0.authored.clone().invert()));
      }
      this.objBox?.update();
    }
    if (it.kind === 'chat') {
      const obj = chatScreensOf(this.rt)?.objects.get(it.key);
      if (obj) { obj.position.copy(o.position); obj.quaternion.copy(o.quaternion); obj.scale.set(o.scale.x, o.scale.y, 1); }
    }
    this.syncFields();
  }
  /** A drag of a room object starts: its authored room-space size (the gizmo's size is on top of it). */
  private objDragStart() {
    const it = this.selItem(), o = this.sel ? this.proxies.get(this.sel) : null;
    this.objStart = null;
    if (it?.kind !== 'obj' || !o || !this.rt) return;
    const room = this.rt.room;
    const nodes = objectNodes(room, it.key).map((n) => ({ node: n, from: authoredRoomMatrix(room, n), position: n.position.clone(), quaternion: n.quaternion.clone(), scale: n.scale.clone() }));
    if (!nodes.length) return;
    this.objStart = { primary: nodes[0].node, authored: nodes[0].from.clone(), nodes };
  }
  private commitFromProxy() {
    const it = this.sel ? this.items().find((i) => i.id === this.sel) : null, o = this.sel ? this.proxies.get(this.sel) : null;
    if (!it || !o) return;
    if (it.kind === 'obj' && this.objStart) { for (const s0 of this.objStart.nodes) { s0.node.position.copy(s0.position); s0.node.quaternion.copy(s0.quaternion); s0.node.scale.copy(s0.scale); s0.node.updateMatrixWorld(true); } this.objStart = null; }
    if (it.kind === 'obj' && !this.bakedSaid) { this.bakedSaid = true; this.flash('Moved. Heads-up: shadows painted into the room stay where it stood.', 5000); }
    const next = cloneEdits(this.edits);
    writeItem(next, it, { pos: o.position.clone(), quat: o.quaternion.clone(), scale: (o.scale.x + o.scale.y + o.scale.z) / 3, sx: o.scale.x, sy: o.scale.y }, this.rt!, this.edits);
    this.apply(next);
  }
  /** One undoable change. */
  apply(next: RoomEdits, rebuild = true) {
    const { edits, errors } = checkRoomEdits(next, { room: this.host.room, ...(this.anchors ? { spots: this.anchors.spots.length ? new Set(this.anchors.spots) : undefined } : {}) });
    if (errors.length) this.flash(errors[0], 5000);
    if (sameEdits(edits, this.edits)) { if (rebuild) this.rebuild(); return; }
    this.undo.push(cloneEdits(this.edits)); if (this.undo.length > 100) this.undo.shift();
    this.redo = [];
    this.edits = edits;
    this.rt?.applyEdits(this.edits);
    if (rebuild) this.rebuild(); else { this.check(); this.render(); }
  }
  // (undo / redo leave "Reset to default": a later Save of an empty layer is then a normal Save, the live tweaks kept)
  undoStep() { const p = this.undo.pop(); if (!p) return; this.resetPending = false; this.redo.push(cloneEdits(this.edits)); this.edits = p; this.rt?.applyEdits(p); this.rebuild(); }
  redoStep() { const p = this.redo.pop(); if (!p) return; this.resetPending = false; this.undo.push(cloneEdits(this.edits)); this.edits = p; this.rt?.applyEdits(p); this.rebuild(); }

  /** Reset one item to the room's own value (its edit is removed). */
  resetItem(id: string) {
    const it = this.items().find((i) => i.id === id);
    if (!it) return;
    const next = cloneEdits(this.edits);
    const del = (rec: Record<string, unknown> | undefined, k: string) => { if (rec) delete rec[k]; };
    if (it.kind === 'cam') del(next.cameras, it.key);
    else if (it.kind === 'spot') del(next.spots, it.key);
    else if (it.kind === 'screen') delete next.screen;
    else if (it.kind === 'solo') del(next.soloScreens, it.key);
    else if (it.kind === 'monitor') del(next.chatMonitors, it.key);
    else if (it.kind === 'board') del(next.chatBoards, it.key);
    else if (it.kind === 'buddy') del(next.buddySpots, it.key);
    else if (it.kind === 'prop') next.props = (next.props ?? []).filter((p) => p.uid !== it.key);
    else if (it.kind === 'chat') next.chatScreens = (next.chatScreens ?? []).filter((c) => c.uid !== it.key);
    else if (it.kind === 'obj') {
      del(next.movedObjects, it.key);
      if (next.movedObjects && !Object.keys(next.movedObjects).length) delete next.movedObjects;
      next.hiddenObjects = (next.hiddenObjects ?? []).filter((n) => n !== it.key);
      if (!next.hiddenObjects.length) delete next.hiddenObjects;
    }
    this.apply(next);
  }
  resetAll() { const e = emptyEdits(this.host.room); e.rev = this.edits.rev; this.apply(e); }

  // ---------------------------------------------------------------- adding
  /** A point on the room in front of the view (props, displays land there). */
  private aim(dist = 2.5): THREE.Vector3 {
    const rt = this.rt!, cam = this.host.stage.camera;
    const ray = new THREE.Raycaster(cam.position.clone(), new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), 0.1, 30);
    const hit = ray.intersectObjects(rt.room.occluders.filter((m) => !m.userData.vtpProp), false)[0];
    const w = hit ? hit.point.clone().addScaledVector(ray.ray.direction, -0.05) : cam.position.clone().addScaledVector(ray.ray.direction, dist);
    return rt.room.root.worldToLocal(w);
  }
  /** Floor under a room-space point (or the point). */
  private floorUnder(p: THREE.Vector3): THREE.Vector3 {
    const rt = this.rt!, root = rt.room.root;
    const w = root.localToWorld(p.clone().add(new THREE.Vector3(0, 0.6, 0)));
    const ray = new THREE.Raycaster(w, new THREE.Vector3(0, -1, 0), 0, 20);
    const hit = ray.intersectObjects(rt.room.occluders.filter((m) => !m.userData.vtpProp), false).find((h) => (h.face?.normal ? h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 0.5 : true));
    return hit ? root.worldToLocal(hit.point.clone()) : p;
  }
  async addProp(item: PropItem) {
    if (!this.rt) return;
    const at = this.floorUnder(this.aim());
    const box = await PlacedProps.boxOf(item.src);
    const next = cloneEdits(this.edits);
    const uid = newPropUid(next);
    const yaw = Math.round(deg(Math.atan2(this.host.stage.camera.position.x - at.x, this.host.stage.camera.position.z - at.z)) / 15) * 15;
    (next.props ??= []).push({ uid, src: item.src, pos: v3(at), rot: [0, yaw, 0], scale: item.scale ?? 1, ...(box && !box.isEmpty() ? { box: [...box.min.toArray(), ...box.max.toArray()].map(r3) as [number, number, number, number, number, number] } : {}) });
    this.sel = `prop:${uid}`;
    this.apply(next);
    // (the model loads async: re-attach the gizmo once its object exists)
    setTimeout(() => this.rebuild(), 400);
  }
  duplicate() {
    const it = this.sel?.startsWith('prop:') ? this.edits.props?.find((p) => `prop:${p.uid}` === this.sel) : null;
    if (!it) return;
    const next = cloneEdits(this.edits);
    const uid = newPropUid(next);
    next.props!.push({ ...it, uid, pos: [it.pos[0] + 0.4, it.pos[1], it.pos[2] + 0.4] });
    this.sel = `prop:${uid}`;
    this.apply(next);
  }
  deleteSel() {
    if (this.sel?.startsWith('prop:') || this.sel?.startsWith('chat:')) { this.resetItem(this.sel); this.sel = null; }
    else if (this.sel?.startsWith('obj:') && !this.edits.hiddenObjects?.includes(this.sel.slice(4))) this.toggleHidden(this.sel.slice(4));   // (Delete on a room object hides it: Show brings it back)
  }
  /** Place a display (solo screen / chat monitor / support board / buddy point) for a spot, in front of it. */
  placeDisplay(kind: 'solo' | 'monitor' | 'board' | 'buddy', spot: string) {
    const rt = this.rt;
    const s = rt?.room.spots[+spot.slice(5) - 1];
    if (!rt || !s) return;
    const root = rt.room.root;
    const pos = root.worldToLocal(s.position.clone());
    const f = s.forward.clone(), side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), f).normalize();
    const H = rt.info.avatarHeight ?? 1.5;
    const next = cloneEdits(this.edits);
    const yaw = r3(deg(Math.atan2(f.x, f.z)));
    if (kind === 'buddy') (next.buddySpots ??= {})[spot] = [v3(pos.clone().addScaledVector(f, 1.1).addScaledVector(side, 0.9))];
    else {
      const d = kind === 'solo' ? 1.6 : 1.2, sx = kind === 'solo' ? -1.4 : kind === 'monitor' ? 1.1 : -1.1;
      const c = pos.clone().addScaledVector(f, d).addScaledVector(side, sx); c.y += H * (kind === 'solo' ? 0.8 : 0.75);
      const rec = kind === 'solo' ? (next.soloScreens ??= {}) : kind === 'monitor' ? (next.chatMonitors ??= {}) : (next.chatBoards ??= {});
      rec[spot] = { position: v3(c), yaw, width: kind === 'solo' ? 2.2 : kind === 'monitor' ? 0.9 : 1.4 };
    }
    this.sel = `${kind}:${spot}`;
    this.apply(next);
  }
  /** "+ Add chat screen": a chat screen where the view looks (eye height, facing the camera), selected to move / size. */
  addChatScreen() {
    if (!this.rt) return;
    const next = cloneEdits(this.edits);
    if ((next.chatScreens?.length ?? 0) >= CHAT_SCREEN_LIMITS.count) { this.flash(`A room can have ${CHAT_SCREEN_LIMITS.count} chat screens.`); return; }
    const cam = this.host.stage.camera, root = this.rt.room.root;
    const at = this.aim(3);
    const camL = root.worldToLocal(cam.position.clone());
    const back = camL.clone().sub(at).setY(0);
    if (back.lengthSq() > 1e-6) at.addScaledVector(back.normalize(), 0.4);   // (a little in front of the wall it hit)
    at.y = THREE.MathUtils.clamp(at.y, 1.5, 2.4);
    const uid = newPropUid(next).replace(/^p/, 'c');
    (next.chatScreens ??= []).push({ uid, ...DEFAULT_CHAT_SCREEN, pos: v3(at), yaw: r3(deg(Math.atan2(camL.x - at.x, camL.z - at.z))) });
    this.sel = `chat:${uid}`;
    this.apply(next);
  }
  /** One chat-screen setting (opacity, frame, facing, text, size) changed from the panel. */
  setChat(uid: string, patch: Partial<ChatScreen>) {
    const next = cloneEdits(this.edits);
    const c = next.chatScreens?.find((x) => x.uid === uid);
    if (!c) return;
    Object.assign(c, patch);
    // (a bigger screen never sinks into the floor: its bottom stays at least 0.3 m up)
    if (patch.height !== undefined) c.pos = [c.pos[0], Math.max(c.pos[1], r3(c.height / 2 + 0.3)), c.pos[2]];
    this.apply(next);
  }
  /** One-click fix for a warning: re-aim / re-fit a camera, or move a prop / chat screen out of the way. */
  fixWarning(w: EditWarning) {
    const rt = this.rt, v = this.checkView();
    if (!rt || !v) return;
    const next = cloneEdits(this.edits);
    const H = rt.info.avatarHeight ?? 1.5;
    const camOf = (name: string) => v.cams.find((c) => c.name === name);
    const setCam = (name: string, pos: V3, target: V3, fov: number) => { (next.cameras ??= {})[name] = { pos, target: target.map(r3) as V3, fov: Math.round(THREE.MathUtils.clamp(fov, 18, 75) * 10) / 10 }; };
    if (w.code === 'cam-face' || w.code === 'cam-miss') {
      const c = camOf(w.anchor), s = v.spots.find((x) => w.anchor.startsWith(x.key));
      if (!c || !s) return;
      const face: V3 = [s.pos[0], s.pos[1] + faceHeight(s, H), s.pos[2]];
      const d = Math.hypot(face[0] - c.pos[0], face[1] - c.pos[1], face[2] - c.pos[2]);
      // head + shoulders fill the frame: about 0.9 m of height at the face
      setCam(w.anchor, c.pos, [face[0], face[1] - 0.12, face[2]], deg(2 * Math.atan(0.45 / Math.max(0.5, d))));
    } else if (w.code === 'wide-face') {
      const c = camOf(w.anchor);
      if (!c || !v.spots.length) return;
      const faces = v.spots.map((s) => new THREE.Vector3(s.pos[0], s.pos[1] + faceHeight(s, H), s.pos[2]));
      const mid = faces.reduce((a, f) => a.add(f), new THREE.Vector3()).multiplyScalar(1 / faces.length);
      const pos = new THREE.Vector3(...c.pos), fwd = mid.clone().sub(pos).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize(), up = new THREE.Vector3().crossVectors(right, fwd);
      let tx = 0, ty = 0;
      for (const f of faces) { const d = f.clone().sub(pos), z = Math.max(0.3, d.dot(fwd)); tx = Math.max(tx, Math.abs(d.dot(right)) / z); ty = Math.max(ty, (Math.abs(d.dot(up)) + 0.25) / z); }
      const fovV = deg(2 * Math.atan(Math.max(ty, tx / (16 / 9)) * 1.3));
      setCam(w.anchor, c.pos, v3(mid), fovV);
    } else if (w.code === 'react-screen' && v.screen) {
      const c = camOf('CAM_REACT');
      if (!c) return;
      const sc = v.screen, ctr = new THREE.Vector3(...sc.center), pos = new THREE.Vector3(...c.pos);
      const wid = Math.max(...sc.corners.map((q) => Math.hypot(q[0] - sc.center[0], q[2] - sc.center[2]))) * 2;
      const d = ctr.distanceTo(pos);
      setCam('CAM_REACT', c.pos, sc.center, deg(2 * Math.atan(Math.tan(Math.atan((wid / 2 / 0.8) / Math.max(0.5, d))) / (16 / 9))));
    } else if (w.code.startsWith('prop-')) {
      // the nearest spot within 4 m (on the floor plane) where this prop / chat screen raises no warning
      const isChat = !!next.chatScreens?.some((c) => c.uid === w.anchor);
      const cur = isChat ? next.chatScreens!.find((c) => c.uid === w.anchor)! : next.props?.find((p) => p.uid === w.anchor);
      if (!cur) return;
      const base = [...cur.pos] as V3;
      let best: V3 | null = null;
      outer: for (const r of [0.5, 0.9, 1.4, 2, 2.8, 4]) for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2, cand: V3 = [r3(base[0] + Math.sin(a) * r), base[1], r3(base[2] + Math.cos(a) * r)];
        cur.pos = cand;
        const trial = this.checkViewFor(next);
        if (trial && !checkEditView(trial).some((x) => x.anchor === w.anchor)) { best = cand; break outer; }
      }
      cur.pos = best ?? base;
      if (!best) { this.flash('No clear place nearby: drag it somewhere else, or delete it.'); return; }
    } else return;
    this.apply(next);
    this.flash('Fixed. Undo (Ctrl+Z) puts it back.');
  }
  /** checkView with another layer's props / chat screens (the fix search; cameras as the room shows them now). */
  private checkViewFor(e: RoomEdits): CheckView | null {
    const v = this.checkView();
    if (!v) return null;
    const props = v.props.filter((p) => !(e.props ?? []).some((q) => q.uid === p.uid) && !(e.chatScreens ?? []).some((q) => q.uid === p.uid));
    for (const p of e.props ?? []) { const old = v.props.find((q) => q.uid === p.uid), src = (this.edits.props ?? []).find((q) => q.uid === p.uid); if (!old || !src) continue; const d = [0, 1, 2].map((k) => p.pos[k] - src.pos[k]); props.push({ ...old, min: old.min.map((m, k) => m + d[k]) as V3, max: old.max.map((m, k) => m + d[k]) as V3 }); }
    for (const c of e.chatScreens ?? []) { const bx = chatScreenBox(c); props.push({ uid: c.uid, name: 'The chat screen', min: bx.min, max: bx.max }); }
    return { ...v, props };
  }

  /** A new camera of your own from the current view. */
  addMyCamera() {
    const used = new Set(Object.keys(this.edits.cameras ?? {}));
    let n = 1; while (n <= 8 && (used.has(`CAM_MY_${n}`) || this.rt?.room.cameras.has(`CAM_MY_${n}`))) n++;
    if (n > 8) { this.flash('You already have 8 cameras of your own.'); return; }
    const cam = this.host.stage.camera, root = this.rt!.room.root;
    const pos = root.worldToLocal(cam.position.clone());
    const target = root.worldToLocal(cam.position.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), 3));
    const next = cloneEdits(this.edits);
    (next.cameras ??= {})[`CAM_MY_${n}`] = { pos: v3(pos), target: v3(target), fov: Math.round(Math.min(60, cam.fov)) };
    this.sel = `cam:CAM_MY_${n}`;
    this.apply(next);
  }
  /** A talk camera for a spot that has none (from the current view). */
  addTalkCamera(spot: string) {
    const cam = this.host.stage.camera, root = this.rt!.room.root;
    const next = cloneEdits(this.edits);
    (next.cameras ??= {})[`${spot}_CAM`] = { pos: v3(root.worldToLocal(cam.position.clone())), target: v3(root.worldToLocal(cam.position.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), 2))), fov: 32 };
    this.sel = `cam:${spot}_CAM`;
    this.apply(next);
  }

  // ---------------------------------------------------------------- views
  setView(v: 'free' | 'look') {
    const it = this.selItem();
    if (v === 'look' && it?.kind !== 'cam') { this.flash('Pick a camera first, then "Look through" it.'); return; }
    this.view = v;
    this.orbit.enabled = v === 'free';
    this.pilot.enabled = v === 'look';
    this.helpers.visible = v === 'free';
    if (v === 'look' && it) this.startPilot(it);
    this.attachGizmo();
    this.render();
  }
  private startPilot(it: Item) {
    const p = this.poseOf(it);
    if (!p || !this.rt) return;
    const root = this.rt.room.root;
    const pos = root.localToWorld(p.pos.clone());
    const q = root.getWorldQuaternion(new THREE.Quaternion()).multiply(p.quat);
    const e = this.edits.cameras?.[it.key];
    const dist = e ? Math.hypot(e.pos[0] - e.target[0], e.pos[1] - e.target[1], e.pos[2] - e.target[2]) : 3;
    this.pilotCam.position.copy(pos); this.pilotCam.quaternion.copy(q);
    this.pilotCam.fov = this.camFov(it); this.pilotCam.aspect = 16 / 9; this.pilotCam.updateProjectionMatrix();
    this.pilot.target.copy(pos).addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(q), Math.max(0.5, dist));
    this.pilot.update();
  }
  private camFov(it: Item) {
    const sm = /^SPOT_(\d\d)_CAM$/.exec(it.key);
    const c = sm ? this.rt?.room.spots[+sm[1] - 1]?.cam : this.rt?.room.cameras.get(it.key);
    return c?.fov ?? 38;
  }
  /** Look-through: the mouse flies the camera itself; its preset follows live, committed when the move ends. */
  private pilotChanged() {
    const it = this.selItem();
    if (!it || it.kind !== 'cam' || !this.rt) return;
    const root = this.rt.room.root;
    const pos = root.worldToLocal(this.pilotCam.position.clone()), tgt = root.worldToLocal(this.pilot.target.clone());
    const pose = lookPose(this.pilotCam.position.clone(), this.pilot.target.clone(), this.pilotCam.fov);
    const sm = /^SPOT_(\d\d)_CAM$/.exec(it.key);
    const preset = { name: it.key, position: pose.position, quaternion: pose.quaternion, fov: pose.fov };
    if (sm) { const s = this.rt.room.spots[+sm[1] - 1]; if (s) s.cam = preset; } else this.rt.room.cameras.set(it.key, preset);
    this.pending = { key: it.key, pos: v3(pos), target: v3(tgt), fov: Math.round(this.pilotCam.fov * 10) / 10 };
    this.syncFields();
  }
  private pending: { key: string; pos: V3; target: V3; fov: number } | null = null;
  private commit() {
    if (!this.pending) return;
    const p = this.pending; this.pending = null;
    const next = cloneEdits(this.edits);
    (next.cameras ??= {})[p.key] = { pos: p.pos, target: p.target, fov: p.fov };
    this.apply(next, false);
  }

  // ---------------------------------------------------------------- picking + keys
  private pick(e: PointerEvent) {
    this.downAt = null;
    if (e.button !== 0 || this.view !== 'free' || this.dragging || (this.tc as unknown as { axis: string | null }).axis) return;
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now(), hit: false };
    const id = this.hitAt(e.clientX, e.clientY);
    if (id && !id.startsWith('obj:')) { this.downAt.hit = true; this.select(id); }
  }
  /** A click (not a drag) on the room: the room object under the mouse is selected (helpers were tried on press). */
  private pickObject(e: PointerEvent) {
    const d = this.downAt;
    this.downAt = null;
    if (!d || d.hit || e.button !== 0 || this.view !== 'free' || this.dragging || !this.rt) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 600) return;
    const id = this.hitAt(e.clientX, e.clientY);
    if (id?.startsWith('obj:')) this.select(id);
  }
  /** What a click at this page point selects: a camera / place / screen handle, prop or chat screen, or one of the room's
   *  own objects. Drawn handles (lines, rings: on top of everything) win; an invisible grab volume wins only when it is
   *  nearer than the room object under the mouse. Debug / tests: vtpRoomEdit.hitAt(x, y). */
  hitAt(clientX: number, clientY: number): string | null {
    if (!this.rt) return null;
    const c = this.host.stage.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - c.left) / c.width) * 2 - 1, -((clientY - c.top) / c.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.params.Line.threshold = 0.04;     // (the default 1 m made a camera's frustum lines catch every click near it)
    ray.setFromCamera(ndc, this.host.stage.camera);
    const objs: THREE.Object3D[] = [...this.helpers.children, ...(this.rt.props ? [...this.rt.props.objects.values()] : []), ...[...(chatScreensOf(this.rt)?.objects.values() ?? [])]];
    const hit = ray.intersectObjects(objs, true).find((h) => h.object.userData.item || h.object.userData.vtpProp || h.object.userData.vtpChatScreen);
    const hid = hit ? (hit.object.userData.item as string | undefined) ?? (hit.object.userData.vtpChatScreen ? `chat:${hit.object.userData.vtpChatScreen}` : `prop:${hit.object.userData.vtpProp}`) : null;
    const onTop = (hit?.object as THREE.Mesh | undefined)?.material as THREE.Material | undefined;
    if (hit && hid && hit.object.userData.item && onTop && onTop !== MAT.pick && onTop.depthTest === false) return hid;   // a handle drawn over everything
    const list = this.objects().filter((o) => o.nodes.some((n) => n.visible));
    const owner = new Map(list.flatMap((o) => o.nodes.map((n) => [n, o.name] as const)));
    const oh = ray.intersectObjects(list.flatMap((o) => o.nodes), true)[0];
    let oid: string | null = null;
    for (let q: THREE.Object3D | null = oh?.object ?? null; q && !oid; q = q.parent) { const n = owner.get(q); if (n) oid = `obj:${n}`; }
    if (hid && (!oid || hit!.distance <= oh!.distance)) return hid;
    return oid;
  }
  select(id: string | null) {
    this.sel = id;
    if (id?.startsWith('obj:') && !this.proxies.has(id)) { this.rebuild(); return; }   // (a room object's handle is made when it is picked)
    this.attachGizmo(); this.check(); this.render(); this.renderObjects();
  }
  /** A yellow box round the selected room object. */
  private highlight(n: THREE.Object3D | null) {
    if (!n) { if (this.objBox) { this.objBox.removeFromParent(); this.objBox.dispose(); this.objBox = null; } return; }
    if (this.objBox && (this.objBox as unknown as { object: THREE.Object3D }).object === n) { this.objBox.update(); return; }
    this.highlight(null);
    this.objBox = new THREE.BoxHelper(n, 0xffd166);
    (this.objBox.material as THREE.LineBasicMaterial).depthTest = false;
    this.objBox.renderOrder = 999;
    this.host.stage.scene.add(this.objBox);
  }
  selItem() { return this.sel ? this.items().find((i) => i.id === this.sel) ?? null : null; }
  private key(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redoStep(); else this.undoStep(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); this.redoStep(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); this.duplicate(); }
    else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); void this.save(); }
    else if (k === 'w') this.setMode('translate'); else if (k === 'e') this.setMode('rotate'); else if (k === 'r') this.setMode('scale');
    else if (k === 'c') this.setView(this.view === 'look' ? 'free' : 'look');
    else if (k === 'delete' || k === 'backspace') this.deleteSel();
    else if (k === 'escape') { if (this.view === 'look') this.setView('free'); else this.select(null); }
  }
  setMode(m: 'translate' | 'rotate' | 'scale') { this.mode = m; this.attachGizmo(); this.render(); }

  // ---------------------------------------------------------------- warnings + guides
  /** The room as the editor shows it, for shared/roomEditCheck.ts. */
  checkView(): CheckView | null {
    const rt = this.rt;
    if (!rt) return null;
    const R = rt.room, root = R.root;
    const L = (w: THREE.Vector3) => v3(root.worldToLocal(w.clone()));
    const cams = [...R.cameras.entries()].map(([name, c]) => ({ name, pos: L(c.position), target: L(c.position.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion), 3)), fov: c.fov }));
    R.spots.forEach((s, i) => { if (s?.cam) cams.push({ name: `${spotKey(i)}_CAM`, pos: L(s.cam.position), target: L(s.cam.position.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(s.cam.quaternion), 3)), fov: s.cam.fov }); });
    let screen: CheckView['screen'] = null;
    if (R.screen) {
      const n = R.screen.node, surf = R.screen.surface;
      // the shown pose (the node may be rolled up right now)
      const saved = n.position.clone(); n.position.copy(R.screen.shownPosition); n.updateMatrixWorld(true);
      surf.geometry.computeBoundingBox();
      const b = surf.geometry.boundingBox!, sz = b.getSize(new THREE.Vector3());
      const thin = sz.x <= sz.y && sz.x <= sz.z ? 'x' : sz.y <= sz.z ? 'y' : 'z';
      const pts: THREE.Vector3[] = [];
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const p = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
        const axes = (['x', 'y', 'z'] as const).filter((a) => a !== thin);
        p[axes[0]] = u ? b.max[axes[0]] : b.min[axes[0]]; p[axes[1]] = v ? b.max[axes[1]] : b.min[axes[1]];
        pts.push(surf.localToWorld(p));
      }
      n.position.copy(saved); n.updateMatrixWorld(true);
      const corners = pts.map(L) as [V3, V3, V3, V3];
      screen = { corners, center: [0, 1, 2].map((k) => corners.reduce((s, q) => s + q[k], 0) / 4) as V3 };
    }
    const props = (this.edits.props ?? []).map((p) => {
      const o = rt.props?.objects.get(p.uid);
      const b = o ? new THREE.Box3().setFromObject(o) : null;
      const fb = propBox(p.box, p.pos, p.rot, p.scale);   // (its model still loading: its own box from the catalog)
      const lo = b && !b.isEmpty() ? L(b.min) : fb.min, hi = b && !b.isEmpty() ? L(b.max) : fb.max;
      return { uid: p.uid, name: this.catalog.find((c) => c.src === p.src)?.name ?? 'A prop', min: lo, max: hi };
    });
    for (const c of this.edits.chatScreens ?? []) { const bx = chatScreenBox(c); props.push({ uid: c.uid, name: 'The chat screen', min: bx.min, max: bx.max }); }
    const spots = R.spots.flatMap((s, i) => (s ? [{ key: spotKey(i), label: s.label, pos: L(s.position), yawDeg: deg(s.yaw), pose: s.pose, seatHeight: s.seatHeight }] : []));
    return { spots, cams, screen, props, avatarHeight: rt.info.avatarHeight ?? 1.5, edited: { cams: Object.keys(this.edits.cameras ?? {}), spots: Object.keys(this.edits.spots ?? {}), screen: !!this.edits.screen } };
  }
  check() {
    const v = this.checkView();
    this.warnings = v ? checkEditView(v) : [];
    const sig = JSON.stringify(this.warnings.slice(0, 6));
    if (sig === this.warnSig) return;                    // (unchanged: keep the buttons the mouse may be on)
    this.warnSig = sig;
    const fixLabel = (w: EditWarning) => (w.code.startsWith('prop-') ? 'Move it out of the way' : 'Fix this camera');
    this.warnBox.replaceChildren(...this.warnings.slice(0, 6).map((w) => el('div', { class: w.level === 'bad' ? 'bad' : '' }, el('span', {}, w.text),
      el('button', { onclick: () => this.fixWarning(w), title: 'One click: VTube Pro fixes it (Undo puts it back)' }, fixLabel(w)))));
  }
  /** Look-through: the safe areas + each spot's face box through this camera. */
  private drawGuides() {
    const it = this.selItem();
    if (this.view !== 'look' || !it || it.kind !== 'cam' || !this.rt) { if (this.guides.childElementCount) this.guides.replaceChildren(); return; }
    const box = (s: { x: number; top: number; bottom: number }, cls: string, label: string) => el('div', { class: `g ${cls}`, style: `left:${(1 - s.x) * 50}%;right:${(1 - s.x) * 50}%;top:${(1 - s.top) * 50}%;bottom:${(1 - s.bottom) * 50}%` }, el('span', { class: 'lb' }, label));
    const talk = /_CAM$/.test(it.key) && /^SPOT_/.test(it.key);
    const kids: HTMLElement[] = [box({ x: 0.9, top: 0.9, bottom: 0.9 }, '', 'title safe'), talk ? box(EVAL_SAFE_BY.talk, 't', 'face safe (talk)') : box(EVAL_SAFE_BY.wide, 'w', 'face safe (group)')];
    const root = this.rt.room.root;
    const cam = this.host.stage.camera;
    const c = { name: it.key, pos: v3(root.worldToLocal(cam.position.clone())), target: v3(root.worldToLocal(cam.position.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), 3))), fov: cam.fov };
    const H = this.rt.info.avatarHeight ?? 1.5;
    this.rt.room.spots.forEach((s, i) => {
      if (!s) return;
      if (talk && !it.key.startsWith(spotKey(i))) return;
      const b = faceBoxNdc(c, { key: spotKey(i), pos: v3(root.worldToLocal(s.position.clone())), yawDeg: deg(s.yaw), pose: s.pose, seatHeight: s.seatHeight }, H);
      if (!b || b.x1 < -1.2 || b.x0 > 1.2 || b.y1 < -1.2 || b.y0 > 1.2) return;
      const safe = talk ? EVAL_SAFE_BY.talk : EVAL_SAFE_BY.wide;
      const out = b.x0 < -safe.x || b.x1 > safe.x || b.y1 > safe.top || b.y0 < -safe.bottom;
      kids.push(el('div', { class: `f${out ? ' out' : ''}`, title: s.label, style: `left:${(b.x0 + 1) * 50}%;width:${(b.x1 - b.x0) * 50}%;top:${(1 - b.y1) * 50}%;height:${(b.y1 - b.y0) * 50}%` }));
    });
    this.guides.replaceChildren(...kids);
  }

  // ---------------------------------------------------------------- the panel
  private fieldsBox: HTMLElement | null = null;
  private syncFields() {
    const it = this.selItem(), o = this.sel ? this.proxies.get(this.sel) : null;
    if (!this.fieldsBox || !it) return;
    const inputs = this.fieldsBox.querySelectorAll<HTMLInputElement>('input[data-f]');
    const vals = this.fieldValues(it, o);
    inputs.forEach((i) => { const v = vals[i.dataset.f!]; if (v !== undefined && document.activeElement !== i) i.value = String(Math.round(v * 1000) / 1000); });
  }
  private fieldValues(it: Item, o: THREE.Object3D | null | undefined): Record<string, number> {
    const p = o && this.view === 'free' ? { pos: o.position, quat: o.quaternion, scale: (o.scale.x + o.scale.y + o.scale.z) / 3 } : this.poseOf(it);
    if (!p) return {};
    if (this.view === 'look' && this.pending) { const q = this.pending; const e = new THREE.Euler().setFromQuaternion(lookPose(new THREE.Vector3(...q.pos), new THREE.Vector3(...q.target), q.fov).quaternion, 'YXZ'); return { x: q.pos[0], y: q.pos[1], z: q.pos[2], yaw: deg(e.y), pitch: deg(e.x), fov: q.fov }; }
    const e = new THREE.Euler().setFromQuaternion(p.quat, 'YXZ');
    const out: Record<string, number> = { x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: deg(e.y), pitch: deg(e.x), roll: deg(e.z), scale: it.kind === 'screen' ? this.edits.screen?.scale ?? 1 : p.scale };
    if (it.kind === 'cam') out.fov = this.camFov(it);
    const rec = it.kind === 'solo' ? this.edits.soloScreens : it.kind === 'monitor' ? this.edits.chatMonitors : it.kind === 'board' ? this.edits.chatBoards : null;
    if (rec?.[it.key]) out.width = rec[it.key].width;
    if (it.kind === 'chat') { const c = this.edits.chatScreens?.find((x) => x.uid === it.key); if (c) { out.width = c.width * (o && this.view === 'free' ? o.scale.x : 1); out.height = c.height * (o && this.view === 'free' ? o.scale.y : 1); } }
    return out;
  }
  /** A typed number: the proxy moves to it and the change is committed. */
  private typed(it: Item, f: string, v: number) {
    if (!Number.isFinite(v)) return;
    const o = this.proxies.get(it.id);
    if (!o) return;
    const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'YXZ');
    if (f === 'x' || f === 'y' || f === 'z') o.position[f] = v;
    else if (f === 'yaw') e.y = rad(v); else if (f === 'pitch') e.x = rad(v); else if (f === 'roll') e.z = rad(v);
    if (f === 'yaw' || f === 'pitch' || f === 'roll') o.quaternion.setFromEuler(e);
    if (f === 'scale') o.scale.setScalar(v);
    const next = cloneEdits(this.edits);
    writeItem(next, it, { pos: o.position.clone(), quat: o.quaternion.clone(), scale: (o.scale.x + o.scale.y + o.scale.z) / 3 }, this.rt!, this.edits);
    if (f === 'fov' && it.kind === 'cam') next.cameras![it.key].fov = v;
    if (it.kind === 'chat' && (f === 'width' || f === 'height')) { const c = next.chatScreens?.find((x) => x.uid === it.key); if (c) c[f] = THREE.MathUtils.clamp(v, f === 'width' ? CHAT_SCREEN_LIMITS.width[0] : CHAT_SCREEN_LIMITS.height[0], f === 'width' ? CHAT_SCREEN_LIMITS.width[1] : CHAT_SCREEN_LIMITS.height[1]); this.apply(next); return; }
    if (f === 'width') { const rec = it.kind === 'solo' ? next.soloScreens : it.kind === 'monitor' ? next.chatMonitors : next.chatBoards; if (rec?.[it.key]) rec[it.key].width = v; }
    this.apply(next);
  }

  render() {
    const rt = this.rt, items = this.items(), it = this.selItem();
    const b = (label: string, on: () => void, cls = '', title = '', disabled = false) => el('button', { class: `re-btn ${cls}`, onclick: on, title, disabled }, label);
    // top bar
    this.bar.replaceChildren(
      b('Move (W)', () => this.setMode('translate'), this.mode === 'translate' ? 'on' : ''),
      b('Turn (E)', () => this.setMode('rotate'), this.mode === 'rotate' ? 'on' : ''),
      b('Size (R)', () => this.setMode('scale'), this.mode === 'scale' ? 'on' : '', 'Props and the react screen'),
      el('select', { class: 're-sel', title: 'Snap', onchange: (e: Event) => { this.snap = (e.target as HTMLSelectElement).value as typeof this.snap; this.attachGizmo(); } },
        ...(['off', 'fine', 'coarse'] as const).map((s) => { const o = el('option', { value: s }, s === 'off' ? 'Snap: off' : s === 'fine' ? 'Snap: 5 cm · 5°' : 'Snap: 25 cm · 15°'); o.selected = this.snap === s; return o; })),
      b(this.view === 'look' ? 'Free view (C)' : 'Look through (C)', () => this.setView(this.view === 'look' ? 'free' : 'look'), this.view === 'look' ? 'on' : '', 'See exactly what this camera shows on stream'),
      b('Undo', () => this.undoStep(), '', 'Ctrl+Z', !this.undo.length),
      b('Redo', () => this.redoStep(), '', 'Ctrl+Y', !this.redo.length),
      el('span', { class: 'sp' }),
      el('span', { class: 're-note' }, this.dirty ? `${editCount(this.edits)} change${editCount(this.edits) === 1 ? '' : 's'} · not saved` : 'Saved'),
      b('Save', () => void this.save(), this.dirty ? 'go' : '', 'Ctrl+S · your OBS output updates once', !this.dirty),
      b('Close', () => { if (this.dirty && !confirm('Close without saving your changes?')) return; this.post({ action: 'close' }); }),
    );
    // panel
    const groups = new Map<string, Item[]>();
    for (const i of items) { const a = groups.get(i.group) ?? []; a.push(i); groups.set(i.group, a); }
    const list = (g: string) => el('div', { class: 're-list' }, ...(groups.get(g) ?? []).map((i) => el('div', { class: `re-item${i.id === this.sel ? ' sel' : ''}${i.edited ? ' ed' : ''}`, 'data-id': i.id, onclick: () => this.select(i.id) },
      el('span', { class: 'dot' }), el('span', { class: 'nm' }, i.label), i.edited ? el('span', { class: 'tag' }, 'changed') : null)));
    const spots = rt ? rt.room.spots.flatMap((s, i) => (s ? [[spotKey(i), s.label] as const] : [])) : [];
    const hostSpot = spots[0]?.[0] ?? 'SPOT_01';
    let dispSpot = (this.panel.querySelector('select[data-disp]') as HTMLSelectElement | null)?.value ?? hostSpot;
    if (!spots.some(([k]) => k === dispSpot)) dispSpot = hostSpot;
    const kits = [...new Map(this.catalog.map((c) => [c.kit, c.kitName])).entries()];
    const match = this.catalog.filter((c) => (!this.catalogFilter.kit || c.kit === this.catalogFilter.kit) && (!this.catalogFilter.q || `${c.name} ${c.category}`.toLowerCase().includes(this.catalogFilter.q.toLowerCase())));
    const all = match.length, shown = match.slice(0, 60);
    this.fieldsBox = it ? this.fields(it) : null;
    const pinfo = rt?.props?.info;
    this.panel.replaceChildren(...(([
      el('div', { class: 're-title' }, 'Room editor'),
      el('div', { class: 're-sub' }, `${rt?.info.name ?? this.host.room} · your changes are kept separately; the room itself is never changed.`),
      this.fieldsBox ? el('div', { class: 're-cur' }, el('div', { class: 're-h' }, it!.label), this.fieldsBox) : el('div', { class: 're-note' }, 'Click a camera, place, screen, prop or any object of the room (in the lists or in the view). Drag with the left mouse to look around, right mouse to pan, wheel to zoom.'),
      this.layouts.root,
      el('div', { class: 're-h' }, 'Cameras'), list('Cameras'),
      el('div', { class: 're-row' }, b('+ My camera from this view', () => this.addMyCamera())),
      el('div', { class: 're-h' }, 'Places'), list('Places'),
      this.objSection,
      el('div', { class: 're-h' }, 'Screens + chat'), list('Screens + chat'),
      el('div', { class: 're-row' },
        el('select', { class: 're-sel', 'data-disp': '1', onchange: () => this.render() }, ...spots.map(([k, l]) => { const o = el('option', { value: k }, `For ${l}`); o.selected = k === dispSpot; return o; })),
        b('+ Solo screen', () => this.placeDisplay('solo', dispSpot)), b('+ Chat monitor', () => this.placeDisplay('monitor', dispSpot)),
        b('+ Support board', () => this.placeDisplay('board', dispSpot)), b('+ Chat buddy spot', () => this.placeDisplay('buddy', dispSpot))),
      el('div', { class: 're-row' }, b('+ Add chat screen', () => this.addChatScreen(), 'go re-big', 'A chat screen where you are looking: move it, turn it, make it bigger or smaller')),
      el('div', { class: 're-note' }, (this.edits.chatScreens?.length ? 'Your chat screens show the live chat when chat is "In the room" (they replace the automatic chat monitor here).' : 'No chat screen of your own yet: VTube Pro places the chat monitor automatically for every shot.') + ' The solo screen, monitor, board and buddy spot above are per place; without one they are automatic too.'),
      el('div', { class: 're-h' }, 'Props'), list('Props'),
      pinfo && (pinfo.over.length || pinfo.missing.length) ? el('div', { class: 're-note' }, pinfo.over.length ? `${pinfo.over.length} prop(s) over this PC's graphics budget are not drawn (${pinfo.tris.toLocaleString()} triangles placed).` : '', pinfo.missing.length ? ` ${pinfo.missing.length} prop(s) are not installed on this PC.` : '') : null,
      el('div', { class: 're-h' }, 'Add a prop'),
      this.catalog.length ? el('div', {},
        el('div', { class: 're-row' },
          el('select', { class: 're-sel', onchange: (e: Event) => { this.catalogFilter.kit = (e.target as HTMLSelectElement).value; this.render(); } }, el('option', { value: '' }, 'All packs'), ...kits.map(([k, n]) => { const o = el('option', { value: k }, n); o.selected = this.catalogFilter.kit === k; return o; })),
          el('input', { class: 're-sel', placeholder: 'Search', value: this.catalogFilter.q, style: 'flex:1;min-width:80px', oninput: (e: Event) => { this.catalogFilter.q = (e.target as HTMLInputElement).value; clearTimeout(this.searchT); this.searchT = window.setTimeout(() => this.render(), 250); } })),
        el('div', { class: 're-note' }, `${shown.length < all ? `Showing ${shown.length} of ${all}: search or pick a pack. ` : ''}Props from free packs and the CC0 library.`),
        el('div', { class: 're-props' }, ...shown.map((c) => el('div', { class: 're-prop', title: `${c.name} · ${c.kitName} · ${c.tris.toLocaleString()} triangles · ${c.license}`, 'data-src': c.src, onclick: () => void this.addProp(c) },
          c.thumb ? el('img', { src: c.thumb, loading: 'lazy', alt: '' }) : el('div', { class: 'ph' }, '▣'), c.name))))
        : el('div', { class: 're-note' }, 'No prop packs installed yet. Free prop packs show up here once installed.'),
    ] as (HTMLElement | null)[]).filter((x): x is HTMLElement => !!x)));
    this.layouts.render();
  }
  private searchT = 0;
  private fields(it: Item): HTMLElement {
    const o = this.proxies.get(it.id);
    const v = this.fieldValues(it, o);
    const inp = (f: string, step = 0.05) => el('input', { type: 'number', step, 'data-f': f, value: v[f] !== undefined ? String(Math.round(v[f] * 1000) / 1000) : '', onchange: (e: Event) => this.typed(it, f, parseFloat((e.target as HTMLInputElement).value)) });
    const rows: (HTMLElement | string)[] = [el('label', {}, 'Position'), inp('x'), inp('y'), inp('z')];
    if (it.kind === 'cam') rows.push(el('label', {}, 'Turn · lens'), inp('yaw', 1), inp('pitch', 1), inp('fov', 1));
    else if (it.kind === 'chat') rows.push(el('label', {}, 'Turn'), inp('pitch', 1), inp('yaw', 1), el('span'), el('label', {}, 'Width · height'), inp('width', 0.05), inp('height', 0.05), el('span'));
    else if (it.kind === 'screen' || it.kind === 'prop' || it.kind === 'obj') rows.push(el('label', {}, 'Turn'), inp('pitch', 1), inp('yaw', 1), inp('roll', 1), el('label', {}, 'Size'), inp('scale', 0.05), el('span'), el('span'));
    else if (it.kind !== 'buddy') rows.push(el('label', {}, 'Facing'), inp('yaw', 1), it.kind === 'spot' ? el('span') : inp('width', 0.05), el('span'));
    const b = (label: string, on: () => void, cls = '') => el('button', { class: `re-btn ${cls}`, onclick: on }, label);
    const hints: Record<Kind, string> = {
      cam: 'Look through (C) to see the shot with the face-safe guides; drag in that view to fly the camera.',
      spot: 'Where a performer sits / stands (the arrow is where they face). Talk shots re-frame round it.',
      screen: 'The big React screen. In-scene capture follows it at any angle; an OBS window box needs it square to CAM_REACT.',
      solo: 'The side screen React uses when you are alone at this place.', monitor: 'The chat monitor for this place (portrait).',
      board: 'The support board for this place.', buddy: 'Where the chat buddy likes to stand for this place.', prop: 'Delete removes it; Ctrl+D duplicates it.',
      chat: 'Drag it anywhere. Size (R) or Width / Height make it bigger: the text stays the same size, a bigger screen shows more lines.',
      obj: 'One of the room\'s own things. Move (W), Turn (E) or Size (R) it, or Hide it (Delete). "Put back" returns it to where the room had it.',
    };
    const cs = it.kind === 'chat' ? this.edits.chatScreens?.find((c) => c.uid === it.key) : null;
    const chatOpts = cs ? el('div', {},
      el('div', { class: 're-fields' }, el('label', {}, 'Opacity'), el('input', { type: 'range', min: CHAT_SCREEN_LIMITS.opacity[0], max: 1, step: 0.05, value: cs.opacity, style: 'grid-column: span 3', onchange: (e: Event) => this.setChat(cs.uid, { opacity: parseFloat((e.target as HTMLInputElement).value) }) }),
        el('label', {}, 'Text size'), el('input', { type: 'range', min: CHAT_SCREEN_LIMITS.text[0], max: CHAT_SCREEN_LIMITS.text[1], step: 0.05, value: cs.text, style: 'grid-column: span 3', onchange: (e: Event) => this.setChat(cs.uid, { text: parseFloat((e.target as HTMLInputElement).value) }) })),
      el('div', { class: 're-row' },
        b(cs.frame ? 'Frame: on' : 'Frame: off', () => this.setChat(cs.uid, { frame: !cs.frame }), cs.frame ? 'on' : ''),
        b(cs.face === 'camera' ? 'Turns to the camera' : 'Stays where it is', () => this.setChat(cs.uid, { face: cs.face === 'camera' ? 'fixed' : 'camera' }), cs.face === 'camera' ? 'on' : ''),
        b('Small', () => this.setChat(cs.uid, { width: 0.7, height: 0.9 })), b('Medium', () => this.setChat(cs.uid, { width: 1, height: 1.3 })), b('Large', () => this.setChat(cs.uid, { width: 1.6, height: 2 })), b('Wide', () => this.setChat(cs.uid, { width: 2.2, height: 1.1 })))) : null;
    return el('div', {}, el('div', { class: 're-fields' }, ...rows), chatOpts,
      el('div', { class: 're-note' }, hints[it.kind]),
      it.kind === 'obj' ? el('div', { class: 're-row' },
        b(this.edits.hiddenObjects?.includes(it.key) ? 'Show' : 'Hide', () => this.toggleHidden(it.key), this.edits.hiddenObjects?.includes(it.key) ? 'go' : ''),
        b('Drop to floor', () => { const o2 = this.proxies.get(it.id); const n = this.rt && objectNode(this.rt.room, it.key); if (!o2 || !n) return; o2.position.y += this.dropBy(n); this.commitFromProxy(); }),
        b('Put back', () => this.resetItem(it.id), 'warn')) :
      el('div', { class: 're-row' },
        it.kind === 'cam' ? b(this.view === 'look' ? 'Free view' : 'Look through', () => this.setView(this.view === 'look' ? 'free' : 'look'), 'on') : null,
        (it.kind === 'spot' || it.kind === 'prop' || it.kind === 'buddy') ? b('Drop to floor', () => { const o2 = this.proxies.get(it.id); if (!o2) return; o2.position.copy(this.floorUnder(o2.position)); this.commitFromProxy(); }) : null,
        it.kind === 'prop' ? b('Duplicate', () => this.duplicate()) : null,
        it.kind === 'prop' || it.kind === 'chat' ? b('Delete', () => this.deleteSel(), 'warn') : b(it.kind === 'cam' && MY_CAM_KEY.test(it.key) || ['solo', 'monitor', 'board', 'buddy'].includes(it.kind) ? 'Remove' : 'Reset to original', () => this.resetItem(it.id), 'warn')));
  }

  /** How far (room space, m) a room object must move down so its lowest point rests on the floor under it (+ = up). */
  private dropBy(n: THREE.Object3D): number {
    const rt = this.rt!, root = rt.room.root;
    const b = new THREE.Box3().setFromObject(n);
    if (b.isEmpty()) return 0;
    const c = b.getCenter(new THREE.Vector3());
    const ray = new THREE.Raycaster(new THREE.Vector3(c.x, b.min.y + 0.05, c.z), new THREE.Vector3(0, -1, 0), 0, 20);
    const own = new Set<THREE.Object3D>(); n.traverse((x) => own.add(x));
    const hit = ray.intersectObjects(rt.room.occluders.filter((m) => !m.userData.vtpProp && !own.has(m)), false).find((h) => (h.face?.normal ? h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 0.5 : true));
    if (!hit) return 0;
    const lo = root.worldToLocal(new THREE.Vector3(c.x, b.min.y, c.z)).y, fl = root.worldToLocal(hit.point.clone()).y;
    return fl - lo;
  }

  flash(msg: string, ms = 3200) {
    this.status = msg;
    const t = el('div', { class: 're-toast' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), ms);
  }
}

// ---------------------------------------------------------------- helpers (3D)
const MAT = {
  cam: new THREE.LineBasicMaterial({ color: 0x6cc7f5, depthTest: false, transparent: true }),
  camEd: new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }),
  spot: new THREE.MeshBasicMaterial({ color: 0x7bd88f, depthTest: false, transparent: true, opacity: 0.85 }),
  panel: new THREE.LineBasicMaterial({ color: 0xa78bfa, depthTest: false, transparent: true }),
  pick: new THREE.MeshBasicMaterial({ visible: false }),
};
function helperFor(it: Item, edits: RoomEdits): THREE.Object3D {
  const g = new THREE.Group();
  g.renderOrder = 999;
  if (it.kind === 'cam') {
    // a little frustum pointing down -Z
    const d = 0.45, w = 0.26, h = 0.15;
    const pts = [0, 0, 0, -w, h, -d, 0, 0, 0, w, h, -d, 0, 0, 0, w, -h, -d, 0, 0, 0, -w, -h, -d, -w, h, -d, w, h, -d, w, h, -d, w, -h, -d, w, -h, -d, -w, -h, -d, -w, -h, -d, -w, h, -d, -0.08, h + 0.03, -d, 0, h + 0.12, -d, 0, h + 0.12, -d, 0.08, h + 0.03, -d];
    const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(geo, edits.cameras?.[it.key] ? MAT.camEd : MAT.cam);
    l.renderOrder = 999;
    g.add(l, new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.5).translate(0, 0, -0.22), MAT.pick));
  } else if (it.kind === 'spot' || it.kind === 'buddy') {
    const ring = new THREE.Mesh(new THREE.RingGeometry(it.kind === 'buddy' ? 0.12 : 0.22, it.kind === 'buddy' ? 0.17 : 0.28, 32).rotateX(-Math.PI / 2), MAT.spot);
    ring.position.y = 0.02; ring.renderOrder = 999;
    g.add(ring);
    if (it.kind === 'spot') {
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 12).rotateX(Math.PI / 2).translate(0, 0.03, 0.38), MAT.spot);
      arrow.renderOrder = 999;
      g.add(arrow, new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.4, 12).translate(0, 0.7, 0), MAT.pick));
    } else g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.8, 10).translate(0, 0.4, 0), MAT.pick));
  } else if (it.kind === 'chat') {
    const c = edits.chatScreens?.find((x) => x.uid === it.key);
    const w = (c?.width ?? 1) + 0.1, hgt = (c?.height ?? 1) + 0.1;
    const pts = [-w / 2, -hgt / 2, 0.03, w / 2, -hgt / 2, 0.03, w / 2, -hgt / 2, 0.03, w / 2, hgt / 2, 0.03, w / 2, hgt / 2, 0.03, -w / 2, hgt / 2, 0.03, -w / 2, hgt / 2, 0.03, -w / 2, -hgt / 2, 0.03];
    const l = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), MAT.panel);
    l.renderOrder = 999;
    g.add(l, new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), MAT.pick));
  } else if (it.kind === 'screen') {
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), MAT.pick));
  } else {
    const rec = it.kind === 'solo' ? edits.soloScreens : it.kind === 'monitor' ? edits.chatMonitors : edits.chatBoards;
    const w = rec?.[it.key]?.width ?? 1, hgt = it.kind === 'monitor' ? (w * 4) / 3 : it.kind === 'solo' ? (w * 9) / 16 : w * 0.75;
    const pts = [-w / 2, -hgt / 2, 0, w / 2, -hgt / 2, 0, w / 2, -hgt / 2, 0, w / 2, hgt / 2, 0, w / 2, hgt / 2, 0, -w / 2, hgt / 2, 0, -w / 2, hgt / 2, 0, -w / 2, -hgt / 2, 0, 0, 0, 0, 0, 0, 0.3];
    const l = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), MAT.panel);
    l.renderOrder = 999;
    g.add(l, new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), new THREE.MeshBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })));
  }
  return g;
}

/** Write an item's new room-space pose into a layer. */
function writeItem(next: RoomEdits, it: Item, p: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number; sx?: number; sy?: number }, rt: SceneRuntime, prev: RoomEdits) {
  const pos = v3(p.pos);
  const yawOf = (q: THREE.Quaternion) => { const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q); return r3(deg(Math.atan2(f.x, f.z))); };
  if (it.kind === 'cam') {
    const old = prev.cameras?.[it.key];
    const dist = old ? Math.hypot(old.pos[0] - old.target[0], old.pos[1] - old.target[1], old.pos[2] - old.target[2]) : 3;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(p.quat);
    const sm = /^SPOT_(\d\d)_CAM$/.exec(it.key);
    const fov = old?.fov ?? (sm ? rt.room.spots[+sm[1] - 1]?.cam?.fov : rt.room.cameras.get(it.key)?.fov) ?? 38;
    (next.cameras ??= {})[it.key] = { pos, target: v3(p.pos.clone().addScaledVector(fwd, dist)), fov: Math.round(fov * 10) / 10 };
  } else if (it.kind === 'spot') (next.spots ??= {})[it.key] = { pos, yaw: yawOf(p.quat) };
  else if (it.kind === 'screen') next.screen = { pos, rot: rotOf(p.quat), scale: r3(THREE.MathUtils.clamp(p.scale, 0.25, 4)) };
  else if (it.kind === 'prop') { const q = next.props?.find((x) => x.uid === it.key); if (q) { q.pos = pos; q.rot = rotOf(p.quat); q.scale = r3(THREE.MathUtils.clamp(p.scale, 0.05, 20)); } }
  else if (it.kind === 'buddy') (next.buddySpots ??= {})[it.key] = [pos];
  else if (it.kind === 'obj') {
    // the handle's pose → the node's origin (the layer stores the origin, like the room authors it)
    const n = objectNode(rt.room, it.key);
    if (!n) return;
    const scale = r3(THREE.MathUtils.clamp(p.scale, 0.05, 20));
    // (from the AUTHORED room size, as applyRoomObjects places it — never the live size under a resized parent)
    (next.movedObjects ??= {})[it.key] = { pos: v3(objectTarget(rt.room, n, p.pos, p.quat, scale).origin), rot: rotOf(p.quat), scale };
  }
  else if (it.kind === 'chat') {
    const c = next.chatScreens?.find((x) => x.uid === it.key);
    if (c) {
      const e = new THREE.Euler().setFromQuaternion(p.quat, 'YXZ');
      const L = CHAT_SCREEN_LIMITS;
      c.pos = pos; c.yaw = r3(deg(e.y)); c.pitch = r3(THREE.MathUtils.clamp(deg(e.x), L.pitch[0], L.pitch[1]));
      if (p.sx !== undefined && p.sy !== undefined) { c.width = r3(THREE.MathUtils.clamp(c.width * p.sx, L.width[0], L.width[1])); c.height = r3(THREE.MathUtils.clamp(c.height * p.sy, L.height[0], L.height[1])); }
    }
  }
  else {
    const rec = it.kind === 'solo' ? (next.soloScreens ??= {}) : it.kind === 'monitor' ? (next.chatMonitors ??= {}) : (next.chatBoards ??= {});
    const w = rec[it.key]?.width ?? 1;
    rec[it.key] = { position: pos, yaw: yawOf(p.quat), width: w };
  }
}
