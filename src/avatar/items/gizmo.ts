// The selection frame on the studio preview: drag an item to move it, the corner dot to resize, the top dot to turn it, ✕ to take it
// off. A plain DOM overlay (position: fixed over the canvas) so the studio layout is never touched. It exists only while an item is
// selected: no overlay element, no timer and no frame loop at any other time (idle = zero cost). It deselects itself after 25 s
// with no touch, and on Escape or a click on empty preview.
import * as THREE from 'three';
import type { ItemPlace } from '../../../shared/avatarItems.ts';
import type { ItemsView } from './view.ts';

export interface GizmoOpts {
  canvas: HTMLCanvasElement;
  camera: () => THREE.PerspectiveCamera;
  view: ItemsView;
  place: (id: string) => ItemPlace | undefined;
  /** `live`: a drag in progress (the engine batches what it tells the other pages). */
  move: (id: string, p: Partial<ItemPlace>, live: boolean) => void;
  /** A drag ended. */
  committed: (id: string) => void;
  remove: (id: string) => void;
  /** The selection changed (the panel highlights the row). */
  changed: (id: string | null) => void;
  /** How many items are on (no picking at all when none). */
  count: () => number;
}

const IDLE_MS = 25_000;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

let cssDone = false;
function css() {
  if (cssDone) return;
  cssDone = true;
  const s = document.createElement('style');
  s.id = 'vtp-items-css';
  s.textContent = `
.itm-layer{position:fixed;pointer-events:none;z-index:60;overflow:hidden}
.itm-box{position:absolute;border:2px dashed #fff;border-radius:6px;box-shadow:0 0 0 1px rgba(0,0,0,.55),0 0 12px rgba(80,160,255,.5);pointer-events:auto;cursor:move;touch-action:none}
.itm-h{position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #2b7bff;pointer-events:auto;touch-action:none;box-shadow:0 1px 4px rgba(0,0,0,.5)}
.itm-h.scale{right:-9px;bottom:-9px;cursor:nwse-resize}
.itm-h.rot{left:calc(50% - 8px);top:-30px;cursor:grab;background:#ffe27a}
.itm-x{position:absolute;right:-12px;top:-30px;width:22px;height:22px;border-radius:50%;background:#ff4f6a;color:#fff;border:2px solid #fff;font:700 12px/18px system-ui,sans-serif;text-align:center;pointer-events:auto;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.5);padding:0}
.itm-tip{position:absolute;left:0;top:calc(100% + 6px);white-space:nowrap;font:600 11px system-ui,sans-serif;color:#fff;background:rgba(10,14,24,.78);padding:2px 7px;border-radius:5px;pointer-events:none}
.itm-drop{position:fixed;z-index:70;display:flex;gap:10px;padding:10px;background:rgba(8,12,24,.55);backdrop-filter:blur(2px)}
.itm-tile{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:2px dashed rgba(255,255,255,.6);border-radius:14px;color:#fff;font:600 14px system-ui,sans-serif;text-align:center;padding:10px;transition:background .12s,border-color .12s}
.itm-tile b{font-size:17px}.itm-tile span{font-weight:400;opacity:.85;font-size:12px}
.itm-tile.main{border-color:#7fd1ff;background:rgba(40,110,200,.35)}
.itm-tile.over{background:rgba(60,160,255,.55);border-style:solid;border-color:#fff}
.itm-tile.quiet{opacity:.75}
`;
  document.head.append(s);
}

export class ItemGizmo {
  private id: string | null = null;
  private layer: HTMLDivElement | null = null;
  private box!: HTMLDivElement;
  private raf = 0;
  private idleT = 0;
  private drag: { kind: 'move' | 'scale' | 'rot'; id: string; px: number; py: number; cx: number; cy: number; start: ItemPlace; d0: number; a0: number } | null = null;
  private dead = false;

  constructor(private readonly o: GizmoOpts) {
    o.canvas.addEventListener('pointerdown', this.onCanvasDown, true);
  }

  get selected() { return this.id; }

  select(id: string | null) {
    if (this.dead) return;
    this.id = id;
    if (!id) { this.hide(); return; }
    this.ensure();
    this.touch();
    this.update();
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
    window.addEventListener('keydown', this.onKey, true);
  }

  /** The item or the avatar changed: redraw the frame now. */
  refresh() { if (this.id && this.layer) this.update(); }

  private hide() {
    cancelAnimationFrame(this.raf); this.raf = 0;
    clearTimeout(this.idleT);
    window.removeEventListener('keydown', this.onKey, true);
    this.layer?.remove(); this.layer = null;
  }

  private touch() { clearTimeout(this.idleT); this.idleT = window.setTimeout(() => this.deselect(), IDLE_MS); }
  private deselect() { this.id = null; this.hide(); this.o.changed(null); }

  private ensure() {
    if (this.layer) return;
    css();
    const layer = document.createElement('div'); layer.className = 'itm-layer';
    const box = document.createElement('div'); box.className = 'itm-box'; box.title = 'Drag to move';
    const hs = document.createElement('div'); hs.className = 'itm-h scale'; hs.title = 'Drag to resize';
    const hr = document.createElement('div'); hr.className = 'itm-h rot'; hr.title = 'Drag to turn';
    const bx = document.createElement('button'); bx.className = 'itm-x'; bx.type = 'button'; bx.textContent = '✕'; bx.title = 'Take it off'; bx.setAttribute('aria-label', 'Take it off');
    const tip = document.createElement('div'); tip.className = 'itm-tip'; tip.textContent = 'Drag to move · corner = size · yellow dot = turn';
    box.append(hs, hr, bx, tip);
    layer.append(box);
    document.body.append(layer);
    this.layer = layer; this.box = box;
    box.addEventListener('pointerdown', (e) => this.startDrag(e, 'move'));
    hs.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startDrag(e, 'scale'); });
    hr.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startDrag(e, 'rot'); });
    bx.addEventListener('pointerdown', (e) => e.stopPropagation());
    bx.addEventListener('click', (e) => { e.stopPropagation(); if (this.id) { const id = this.id; this.deselect(); this.o.remove(id); } });
  }

  private canvasRect() { return this.o.canvas.getBoundingClientRect(); }

  private update() {
    if (!this.id || !this.layer) return;
    const c = this.o.canvas, cr = this.canvasRect();
    const L = this.layer.style;
    L.left = `${cr.left}px`; L.top = `${cr.top}px`; L.width = `${cr.width}px`; L.height = `${cr.height}px`;
    const r = this.o.view.rectOf(this.id, this.o.camera(), c.clientWidth || cr.width, c.clientHeight || cr.height);
    if (!r) { this.box.style.display = 'none'; return; }
    const sx = cr.width / Math.max(1, c.clientWidth || cr.width), sy = cr.height / Math.max(1, c.clientHeight || cr.height);
    const w = Math.max(28, r.w * sx), h = Math.max(28, r.h * sy);
    const B = this.box.style;
    B.display = 'block';
    B.left = `${r.cx * sx - w / 2}px`; B.top = `${r.cy * sy - h / 2}px`; B.width = `${w}px`; B.height = `${h}px`;
  }

  private readonly loop = () => {
    this.raf = 0;
    if (!this.id || this.dead) return;
    this.update();
    this.raf = requestAnimationFrame(this.loop);
  };

  // ------------------------------------------------------------ picking on the canvas

  private readonly onCanvasDown = (e: PointerEvent) => {
    if (this.dead || e.button !== 0 || !this.o.count() || this.o.canvas.classList.contains('placing')) return;
    const cr = this.canvasRect();
    const ndc = new THREE.Vector2(((e.clientX - cr.left) / cr.width) * 2 - 1, -((e.clientY - cr.top) / cr.height) * 2 + 1);
    const id = this.o.view.pick(ndc, this.o.camera());
    if (!id) { if (this.id) this.deselect(); return; }
    e.preventDefault(); e.stopPropagation();
    if (this.id !== id) { this.select(id); this.o.changed(id); }
    this.startDrag(e, 'move');
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.id) return;
    if (e.key === 'Escape') { this.deselect(); return; }
    const t = e.target as HTMLElement | null;
    const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) { const id = this.id; e.preventDefault(); this.deselect(); this.o.remove(id); }
  };

  // ------------------------------------------------------------ dragging

  private startDrag(e: PointerEvent, kind: 'move' | 'scale' | 'rot') {
    if (!this.id || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const start = this.o.place(this.id);
    if (!start) return;
    this.touch();
    const cr = this.canvasRect(), c = this.o.canvas;
    const r = this.o.view.rectOf(this.id, this.o.camera(), c.clientWidth || cr.width, c.clientHeight || cr.height);
    const sx = cr.width / Math.max(1, c.clientWidth || cr.width), sy = cr.height / Math.max(1, c.clientHeight || cr.height);
    const cx = cr.left + (r?.cx ?? cr.width / 2) * sx, cy = cr.top + (r?.cy ?? cr.height / 2) * sy;
    this.drag = { kind, id: this.id, px: e.clientX, py: e.clientY, cx, cy, start: { ...start }, d0: Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy)), a0: Math.atan2(e.clientY - cy, e.clientX - cx) };
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onUp, true);
  }

  private readonly onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    this.touch();
    const cur = this.o.place(d.id);
    if (!cur) { this.endDrag(); return; }
    if (d.kind === 'move') {
      const cam = this.o.camera(), cr = this.canvasRect();
      const wpp = this.o.view.worldPerPixel(d.id, cam, cr.height);
      const dx = e.clientX - d.px, dy = e.clientY - d.py;
      d.px = e.clientX; d.py = e.clientY;
      cam.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      const world = right.multiplyScalar(dx * wpp).add(up.multiplyScalar(-dy * wpp));
      const dp = this.o.view.placeDelta(d.id, world);
      if (dp) this.o.move(d.id, { x: r4(cur.x + dp.x), y: r4(cur.y + dp.y), z: r4(cur.z + dp.z) }, true);
    } else if (d.kind === 'scale') {
      const dist = Math.max(4, Math.hypot(e.clientX - d.cx, e.clientY - d.cy));
      this.o.move(d.id, { scale: r4(Math.min(10, Math.max(0.05, d.start.scale * (dist / d.d0)))) }, true);
    } else {
      const ang = Math.atan2(e.clientY - d.cy, e.clientX - d.cx);
      let rot = d.start.rot - ((ang - d.a0) * 180) / Math.PI;
      rot = ((((rot + 180) % 360) + 360) % 360) - 180;
      this.o.move(d.id, { rot: Math.round(rot * 10) / 10 }, true);
    }
    this.update();
  };

  private readonly onUp = () => this.endDrag();
  private endDrag() {
    const d = this.drag;
    this.drag = null;
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onUp, true);
    if (d) this.o.committed(d.id);
  }

  dispose() {
    this.dead = true;
    this.o.canvas.removeEventListener('pointerdown', this.onCanvasDown, true);
    this.endDrag();
    this.id = null;
    this.hide();
  }
}
