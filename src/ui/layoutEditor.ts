// Show area → "Layout editor": absolute control over the stage layout the OBS pages draw (shared/stageLayout.ts).
// Pick Auto (the automatic plans, default) or Custom for the current room + mode + preset; then drag / resize the
// corner cam, each cam tile, the game / window capture, the docked chat and the support ticker right over the live
// preview (or type exact pixel values), with snapping to the frame, the centre lines, the safe margin and the other
// elements. Every change is one write of the `layout` mode bag (SceneController.setModeBag): no server change; guests'
// pages follow the host's state like every other stage setting.
//
// Keyboard (a box focused): arrows move 1 px (Shift: 10 px), Alt+arrows resize, Delete = back to automatic.
import type { App } from '../app.ts';
import type { Rect } from '../../shared/stage.ts';
import { LAYOUT_BAG, activeSlot, roomKey, sanitizeLayoutBag, slotKey, snapRect, toR4, toRect, type LayoutBag, type LayoutSlot } from '../../shared/stageLayout.ts';
import { HUD_TYPES } from '../../shared/hud.ts';
import { button, h, section, sliderControl, toast } from './dom.ts';
import { canvasSize, nameOf } from './stage/common.ts';
import { placeChatFromLayout } from './chatBoxPanel.ts';

type Item = { k: string; label: string; rect: Rect; custom: boolean; kind: 'capture' | 'cam' | 'dock'; hero?: boolean };
type BagApi = { modeBag(id: string): unknown; setModeBag(id: string, v: unknown): void };
const SNAP_KEY = 'vtp.layout.snap', EDIT_KEY = 'vtp.layout.edit';
const ls = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* off */ } } };

const CSS = `
.lay-ov { position:absolute; inset:0; z-index:6; touch-action:none; user-select:none; }
.lay-ov .g { position:absolute; background:var(--pink,#ff7ac8); pointer-events:none; opacity:.9; }
.lay-ov .g.v { top:0; bottom:0; width:1px; } .lay-ov .g.hz { left:0; right:0; height:1px; }
.lay-ov .safe { position:absolute; border:1px dashed #ffffff55; pointer-events:none; }
.lay-box { position:absolute; border:1.5px solid #6cc7f5cc; background:#6cc7f514; border-radius:4px; cursor:move; outline:none; }
.lay-box.cam { border-color:#7bd88fcc; background:#7bd88f12; }
.lay-box.hero { border-color:#ffd166; }
.lay-box.dock { border-color:#a78bfacc; background:#a78bfa12; }
.lay-box.custom { border-style:solid; box-shadow:0 0 0 1px #0008 inset; }
.lay-box:not(.custom) { border-style:dashed; }
.lay-box.sel { border-color:#fff; background:#ffffff1c; box-shadow:0 0 0 2px #6cc7f5, 0 0 0 1px #000 inset; z-index:2; }
.lay-box:focus-visible { outline:2px solid var(--focus,#8ab4ff) !important; outline-offset:1px; }
.lay-box .t { position:absolute; left:3px; top:2px; font:600 10px/1.2 Inter, system-ui, sans-serif; color:#fff; background:#000a; padding:1px 5px; border-radius:4px; white-space:nowrap; pointer-events:none; max-width:calc(100% - 6px); overflow:hidden; text-overflow:ellipsis; }
.lay-box .hd { position:absolute; width:11px; height:11px; background:#fff; border:1.5px solid #1b1f28; border-radius:3px; }
.lay-box .hd.nw { left:-6px; top:-6px; cursor:nwse-resize; } .lay-box .hd.ne { right:-6px; top:-6px; cursor:nesw-resize; }
.lay-box .hd.sw { left:-6px; bottom:-6px; cursor:nesw-resize; } .lay-box .hd.se { right:-6px; bottom:-6px; cursor:nwse-resize; }
.lay-box:not(.sel) .hd { display:none; }
.lay-stage { position:relative; width:100%; background:#0e131b repeating-conic-gradient(#171b23 0 25%, #12151c 0 50%) 0 0/16px 16px; border:1px solid var(--line); border-radius:10px; overflow:hidden; margin:8px 0; }
.lay-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.lay-head .what { flex:1; min-width:160px; font-size:12.5px; color:var(--dim); }
.lay-head .what b { color:var(--text); }
.lay-list { display:flex; flex-wrap:wrap; gap:5px; margin:6px 0; }
.lay-list button { font:inherit; font-size:12px; padding:4px 9px; border-radius:99px; border:1px solid var(--line2); background:var(--card2); color:var(--text); cursor:pointer; }
.lay-list button.on { background:var(--accent2); color:#06131a; border-color:transparent; font-weight:600; }
.lay-list button .dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--accent); margin-left:6px; vertical-align:middle; }
.lay-nums { display:grid; grid-template-columns: 22px 1fr; gap:4px 8px; align-items:center; margin:6px 0; }
.lay-nums > span { color:var(--dim); font-size:12px; font-weight:600; }
.lay-tools { display:flex; flex-wrap:wrap; gap:5px; margin:6px 0; }
.lay-tools .btn { padding:4px 9px; font-size:12px; }
`;
let cssDone = false;

export interface LayoutEditor { el: HTMLElement; update(): void; dispose(): void }

/** `frame`: the live preview frame (src/ui/scenePanel.ts .scn-prev) to draw the handles over, when it is showing. */
export function layoutEditor(app: App, frame: () => HTMLElement | null): LayoutEditor {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const B = S as unknown as BagApi;
  let sel: string | null = null;
  let editing = ls.get(EDIT_KEY) === '1';
  let snap = ls.get(SNAP_KEY) !== '0';
  let drag: { k: string; mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; x0: number; y0: number; r0: Rect; box: HTMLElement; ov: HTMLElement; cur: Rect } | null = null;
  const pending = new Map<string, { r: Rect | null; until: number }>();
  const autoSeen = new Map<string, Rect>();
  const ov = h('div', { class: 'lay-ov' });
  const ownStage = h('div', { class: 'lay-stage' });
  const body = h('div');
  const el = section('Layout editor', body);
  el.classList.add('lay-sec');

  const bag = (): LayoutBag => sanitizeLayoutBag(B.modeBag(LAYOUT_BAG));
  const rep = () => S.report?.stage ?? null;
  const ctx = () => { const r = rep(), eff = S.effective; return r && eff.sceneId ? { room: eff.sceneId, mode: eff.mode, label: r.label, view: r.view } : null; };
  const slotOf = (b: LayoutBag, create: boolean): LayoutSlot | null => {
    const c = ctx(); if (!c) return null;
    const rk = roomKey(c.room), sk = slotKey(c.mode, c.label);
    const room = b.rooms[rk] ?? (create ? (b.rooms[rk] = {}) : null);
    if (!room) return null;
    return room[sk] ?? (create ? (room[sk] = { on: true }) : null);
  };
  const save = (b: LayoutBag) => { if (!S.canEdit) { toast('The host runs the layout', 'warn'); return; } B.setModeBag(LAYOUT_BAG, b); };

  const items = (): Item[] => {
    const r = rep(); const c = ctx(); if (!r || !c) return [];
    const b = bag(); const slot = activeSlot(b, c.room, c.mode, c.label);
    const has = (k: string) => !!slot && Array.isArray(slot[k]);
    const out: Item[] = [];
    const name = nameOf(S);
    if (r.view === 'composite' && r.capture) out.push({ k: 'capture', kind: 'capture', label: c.mode === 'gaming' ? 'Game' : 'Window', rect: r.capture as Rect, custom: has('capture') });
    const tiles = [...r.tiles].filter((t) => (t as { slot?: number }).slot !== undefined && (t as { slot?: number }).slot! >= 0).sort((a, b2) => (a as { slot: number }).slot - (b2 as { slot: number }).slot);
    for (const t of tiles) {
      const i = (t as { slot: number }).slot;
      out.push({ k: `cam${i}`, kind: 'cam', hero: t.hero, label: `${tiles.length === 1 && r.label === 'Corner cam' ? 'Corner cam' : `Cam ${i + 1}`} · ${name(t.key)}`, rect: t.rect, custom: has(`cam${i}`) });
    }
    if (r.docks.chat) out.push({ k: 'chat', kind: 'dock', label: 'Docked chat', rect: r.docks.chat, custom: has('chat') });
    if (r.docks.support) out.push({ k: 'support', kind: 'dock', label: 'Support ticker', rect: r.docks.support, custom: has('support') });
    // HUD elements of the Full screen layouts (shared/hud.ts): custom rects 'hud-<id>'
    for (const e of r.hud ?? []) out.push({ k: `hud-${e.id}`, kind: 'dock', label: `${HUD_TYPES[e.type]?.icon ?? ''} ${HUD_TYPES[e.type]?.label ?? e.type}`.trim(), rect: e.rect, custom: has(`hud-${e.id}`) });
    const now = performance.now();
    for (const it of out) {
      const p = pending.get(it.k);
      if (p && now < p.until) { if (p.r) it.rect = p.r; } else pending.delete(it.k);
      if (!it.custom && !p) autoSeen.set(`${c.room}|${c.mode}|${c.label}|${it.k}`, it.rect);
    }
    return out;
  };
  const autoOf = (k: string): Rect | null => { const c = ctx(); return c ? autoSeen.get(`${c.room}|${c.mode}|${c.label}|${k}`) ?? null : null; };

  /** Store one element's rect (switches this preset to Custom). */
  const setRect = (k: string, r: Rect | null) => {
    if (k === 'chat') { pending.set(k, { r, until: performance.now() + 1500 }); placeChatFromLayout(app, r); paint(); return; }   // chatfx: one place for the chat (the chat box, room + mode)
    const b = bag(); const slot = slotOf(b, !!r); if (!slot) return;
    if (r) { slot[k] = toR4(r); slot.on = true; } else delete slot[k];
    pending.set(k, { r, until: performance.now() + 1500 });
    save(b); paint();
  };
  const setMode = (custom: boolean) => {
    const b = bag(); const slot = slotOf(b, custom); if (!slot) return;
    slot.on = custom; save(b);
    toast(custom ? 'Custom layout: drag the boxes on the preview' : 'Auto layout (your custom boxes are kept for later)', 'ok', 1800);
    paint();
  };
  const resetAll = () => { const b = bag(); const c = ctx(); if (!c) return; const rk = roomKey(c.room); if (b.rooms[rk]) { delete b.rooms[rk][slotKey(c.mode, c.label)]; if (!Object.keys(b.rooms[rk]).length) delete b.rooms[rk]; } pending.clear(); save(b); toast('Back to the automatic layout', 'ok', 1500); paint(); };

  // ---------------------------------------------------------------- overlay (drawn over the live preview)
  const [CW, CH] = canvasSize();
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  function drawOverlay(list: Item[]) {
    if (drag) return;
    const host = editing ? (frame() && frame()!.offsetParent !== null ? frame()! : ownStage) : null;
    ownStage.style.display = editing && host === ownStage ? '' : 'none';
    ownStage.style.aspectRatio = `${CW} / ${CH}`;
    if (!host) { ov.remove(); return; }
    if (ov.parentElement !== host) host.append(ov);
    const safe = bag().safe ?? 0;
    const boxes: Node[] = [];
    if (safe > 0) boxes.push(h('div', { class: 'safe', style: `left:${pct(safe)};top:${pct(safe)};right:${pct(safe)};bottom:${pct(safe)}` }));
    for (const it of list) {
      const b = h('div', { class: `lay-box ${it.kind} ${it.hero ? 'hero' : ''} ${it.custom ? 'custom' : ''} ${sel === it.k ? 'sel' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${it.label}: drag to move, corners to resize`, title: `${it.label} — ${it.custom ? 'custom' : 'automatic'}`,
        style: `left:${pct(it.rect.x)};top:${pct(it.rect.y)};width:${pct(it.rect.w)};height:${pct(it.rect.h)}` },
        h('span', { class: 't' }, it.label, it.custom ? ' ✎' : ''),
        ...(['nw', 'ne', 'sw', 'se'] as const).map((c) => h('i', { class: `hd ${c}`, 'data-h': c })));
      b.dataset.k = it.k;
      b.addEventListener('pointerdown', (e) => start(e, it, b));
      b.addEventListener('keydown', (e) => key(e, it));
      b.addEventListener('focus', () => { if (sel !== it.k) { sel = it.k; paintSide(items()); for (const x of ov.querySelectorAll('.lay-box')) x.classList.toggle('sel', (x as HTMLElement).dataset.k === sel); } });
      boxes.push(b);
    }
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.k;
    ov.replaceChildren(...boxes);
    if (focused) (ov.querySelector(`[data-k="${focused}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
  }
  function start(e: PointerEvent, it: Item, box: HTMLElement) {
    if (!S.canEdit || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    sel = it.k;
    const hd = (e.target as HTMLElement).dataset.h as 'nw' | 'ne' | 'sw' | 'se' | undefined;
    drag = { k: it.k, mode: hd ?? 'move', x0: e.clientX, y0: e.clientY, r0: { ...it.rect }, box, ov, cur: { ...it.rect } };
    box.classList.add('sel');
    box.setPointerCapture(e.pointerId);
    const others = items().filter((x) => x.k !== it.k).map((x) => x.rect);
    const lockA = it.kind === 'capture' ? it.rect.w / it.rect.h : 0;
    const move = (ev: PointerEvent) => {
      if (!drag) return;
      const bb = ov.getBoundingClientRect();
      const dx = (ev.clientX - drag.x0) / bb.width, dy = (ev.clientY - drag.y0) / bb.height;
      const r0 = drag.r0; let r: Rect;
      if (drag.mode === 'move') r = { x: r0.x + dx, y: r0.y + dy, w: r0.w, h: r0.h };
      else {
        const L = drag.mode.includes('w'), T = drag.mode.includes('n');
        let x = r0.x, y = r0.y, w = r0.w + (L ? -dx : dx), hh = r0.h + (T ? -dy : dy);
        w = Math.max(0.03, w); hh = Math.max(0.03, hh);
        if (lockA && !ev.shiftKey) hh = w / lockA;   // keep the capture's shape (Shift: free)
        if (L) x = r0.x + r0.w - w;
        if (T) y = r0.y + r0.h - hh;
        r = { x, y, w, h: hh };
      }
      const guides: Node[] = [];
      if (snap && !ev.altKey) {
        const tol = 10 / bb.width;
        const s = snapRect(r, others, tol, bag().safe ?? 0, drag.mode === 'move' ? 'move' : 'resize');
        if (drag.mode === 'move' || drag.mode === 'se') r = s.rect;
        for (const gx of s.gx) guides.push(h('div', { class: 'g v', style: `left:${pct(gx)}` }));
        for (const gy of s.gy) guides.push(h('div', { class: 'g hz', style: `top:${pct(gy)}` }));
      }
      r.x = Math.min(1 - r.w * 0.2, Math.max(-r.w * 0.8, r.x)); r.y = Math.min(1 - r.h * 0.2, Math.max(-r.h * 0.8, r.y));
      drag.cur = r;
      Object.assign(box.style, { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });
      for (const g of ov.querySelectorAll('.g')) g.remove();
      ov.append(...guides);
      paintNums(r);
    };
    const up = () => {
      box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); box.removeEventListener('pointercancel', up);
      const d = drag; drag = null;
      for (const g of ov.querySelectorAll('.g')) g.remove();
      if (!d) return;
      const moved = Math.abs(d.cur.x - d.r0.x) + Math.abs(d.cur.y - d.r0.y) + Math.abs(d.cur.w - d.r0.w) + Math.abs(d.cur.h - d.r0.h) > 0.001;
      if (moved) { const wasAuto = !activeSlot(bag(), ctx()?.room, ctx()?.mode ?? '', ctx()?.label ?? ''); setRect(d.k, d.cur); if (wasAuto) toast('Switched this layout to Custom (Reset to Auto brings the automatic one back)', 'info', 3200); }
      else paint();
    };
    box.addEventListener('pointermove', move); box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
    paintSide(items());
  }
  function key(e: KeyboardEvent, it: Item) {
    const px = (e.shiftKey ? 10 : 1);
    const dx = px / CW, dy = px / CH;
    const r = { ...it.rect };
    const k = e.key;
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); setRect(it.k, null); return; }
    if (!k.startsWith('Arrow')) return;
    e.preventDefault(); e.stopPropagation();
    if (e.altKey) { if (k === 'ArrowRight') r.w += dx; if (k === 'ArrowLeft') r.w = Math.max(0.03, r.w - dx); if (k === 'ArrowDown') r.h += dy; if (k === 'ArrowUp') r.h = Math.max(0.03, r.h - dy); }
    else { if (k === 'ArrowRight') r.x += dx; if (k === 'ArrowLeft') r.x -= dx; if (k === 'ArrowDown') r.y += dy; if (k === 'ArrowUp') r.y -= dy; }
    setRect(it.k, r);
  }

  // ---------------------------------------------------------------- side controls
  const side = h('div');
  const numsBox = h('div');
  function paintNums(r: Rect) {
    const bxs = numsBox.querySelectorAll('input.sl-in') as NodeListOf<HTMLInputElement>;
    const v = [r.x * CW, r.y * CH, r.w * CW, r.h * CH];
    bxs.forEach((b, i) => { if (document.activeElement !== b) b.value = String(Math.round(v[i])); });
  }
  function paintSide(list: Item[]) {
    const c = ctx();
    if (!c) { side.replaceChildren(h('p', { class: 'note' }, S.effective.sceneId ? (localStorage.getItem('vtp.scene.preview') === '1' ? 'Loading the preview…' : 'Turn the preview on (top of this area) to see and edit the layout.') : 'Pick a room first: layouts belong to a room and a show mode.')); return; }
    const b = bag(); const slot = activeSlot(b, c.room, c.mode, c.label);
    const stored = slotOf(b, false);
    const custom = !!slot;
    const edit = S.canEdit;
    const seg = h('span', { class: 'seg' },
      h('button', { class: custom ? '' : 'on', disabled: !edit, onClick: () => { if (custom) setMode(false); } }, 'Auto'),
      h('button', { class: custom ? 'on' : '', disabled: !edit, onClick: () => { if (!custom) setMode(true); } }, 'Custom'));
    const head = h('div', { class: 'lay-head' },
      h('span', { class: 'what' }, 'Editing ', h('b', null, c.label), ` in ${S.scenes.find((x) => x.id === c.room)?.name ?? c.room}`, c.view === '3d' ? ' (room shot: cams and docked panels only)' : ''),
      seg);
    const editBtn = button(editing ? 'Done editing' : 'Edit on the preview', () => { editing = !editing; ls.set(EDIT_KEY, editing ? '1' : '0'); if (!editing) sel = null; paint(); if (editing) (frame() ?? ownStage).scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, editing ? '' : 'primary');
    const snapBtn = h('label', { class: 'adv-switch', title: 'Snap edges to the frame, centre lines, the safe margin and the other boxes (hold Alt while dragging to place freely)' }, 'Snap',
      h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: snap, onChange: (e: Event) => { snap = (e.target as HTMLInputElement).checked; ls.set(SNAP_KEY, snap ? '1' : '0'); } }), h('i')));
    const pills = h('div', { class: 'lay-list', role: 'listbox', 'aria-label': 'Layout elements' }, ...list.map((it) => h('button', { class: sel === it.k ? 'on' : '', 'aria-selected': String(sel === it.k), onClick: () => { sel = sel === it.k ? null : it.k; if (!editing && sel) { editing = true; ls.set(EDIT_KEY, '1'); } paint(); } }, it.label, it.custom ? h('span', { class: 'dot', title: 'custom' }) : null)));
    const cur = list.find((x) => x.k === sel) ?? null;
    numsBox.replaceChildren();
    if (cur) {
      const R = cur.rect, auto = autoOf(cur.k);
      const num = (label: string, v: number, max: number, d: number | undefined, f: (n: number) => Rect) => [h('span', null, label), sliderControl(Math.round(v), 0, max, 1, (n) => setRect(cur.k, f(n)), { inline: true, commit: true, disabled: !edit, label: `${cur.label} ${label}`, unit: 'px', hard: [-max, max * 2], ...(d !== undefined ? { def: Math.round(d) } : {}) })];
      numsBox.append(h('div', { class: 'lay-nums' },
        ...num('X', R.x * CW, CW, auto ? auto.x * CW : undefined, (n) => ({ ...R, x: n / CW })),
        ...num('Y', R.y * CH, CH, auto ? auto.y * CH : undefined, (n) => ({ ...R, y: n / CH })),
        ...num('W', R.w * CW, CW, auto ? auto.w * CW : undefined, (n) => ({ ...R, w: Math.max(20, n) / CW })),
        ...num('H', R.h * CH, CH, auto ? auto.h * CH : undefined, (n) => ({ ...R, h: Math.max(20, n) / CH }))));
      const m = b.safe ?? 0;
      const al = (lbl: string, tip: string, f: () => Rect) => h('button', { class: 'btn', title: tip, disabled: !edit, onClick: () => setRect(cur.k, f()) }, lbl);
      const scale = (k: number) => { const cx = R.x + R.w / 2, cy = R.y + R.h / 2, w = R.w * k, hh = R.h * k; return { x: cx - w / 2, y: cy - hh / 2, w, h: hh }; };
      numsBox.append(h('div', { class: 'lay-tools' },
        al('⇤ Left', 'Align to the left edge (safe margin)', () => ({ ...R, x: m })),
        al('↔ Centre', 'Centre horizontally', () => ({ ...R, x: 0.5 - R.w / 2 })),
        al('Right ⇥', 'Align to the right edge', () => ({ ...R, x: 1 - m - R.w })),
        al('⤒ Top', 'Align to the top edge', () => ({ ...R, y: m })),
        al('↕ Middle', 'Centre vertically', () => ({ ...R, y: 0.5 - R.h / 2 })),
        al('Bottom ⤓', 'Align to the bottom edge', () => ({ ...R, y: 1 - m - R.h })),
        al('− Smaller', '10 % smaller around its centre', () => scale(0.9)),
        al('+ Bigger', '10 % bigger around its centre', () => scale(1.1)),
        cur.kind === 'capture' ? al('16:9', 'Give the capture the capture aspect again (height from width)', () => ({ ...R, h: R.w * CW / (S.stage.content ?? 16 / 9) / CH })) : null,
        h('button', { class: 'btn', disabled: !edit || !cur.custom, title: 'This element goes back to its automatic place and size', onClick: () => setRect(cur.k, null) }, '↺ Automatic')));
    }
    const safeCtl = h('div', { class: 'stg-row', title: 'Keeps every automatic layout this far from the frame edges (TV-safe / overlay room). Custom boxes stay exactly where you put them.' },
      h('span', { class: 'lbl' }, 'Safe margin'),
      sliderControl(Math.round((b.safe ?? 0) * 1000) / 10, 0, 8, 0.5, (v) => { const x = bag(); x.safe = Math.max(0, Math.min(8, v)) / 100; if (x.safe < 0.0005) delete x.safe; save(x); }, { inline: true, commit: true, disabled: !edit, label: 'Safe margin', unit: '%', def: 0 }));
    const tools = h('div', { class: 'lay-tools' }, editBtn, editing ? snapBtn : null, stored ? h('button', { class: 'btn', disabled: !edit, title: 'Forget the custom boxes of this layout', onClick: resetAll }, '↺ Reset to Auto') : null);
    // closed: one compact row under the preview; open: the element list, exact numbers, align tools, safe margin
    if (!editing) { side.replaceChildren(head, tools, h('p', { class: 'note', style: 'margin:2px 0 0' }, custom ? 'Custom layout in use for this preset.' : 'Drag the corner cam, the cams, the game window or the docked chat anywhere, at any size.')); return; }
    side.replaceChildren(head, tools,
      list.length ? pills : h('p', { class: 'note' }, c.view === '3d' ? 'Nothing to place in this shot right now: cams and docked panels appear here when the room shows them.' : 'Waiting for the preview…'),
      numsBox,
      h('p', { class: 'note' }, custom ? 'Custom boxes are saved for this room + mode + preset. Other presets and rooms keep Auto until you edit them.' : 'Auto places everything for you. Drag any box (or pick Custom) to take over; Auto stays one click away.',
        ' Keys: arrows move 1 px (Shift 10), Alt+arrows resize, Delete = automatic.'),
      safeCtl);
  }
  function paint() {
    const list = items();
    if (sel && !list.some((x) => x.k === sel)) sel = null;
    if (!drag) paintSide(list);
    drawOverlay(list);
  }
  body.append(side, ownStage);
  ownStage.style.display = 'none';
  let lastSig = '';
  const off = S.on((what) => {
    if (drag || !el.isConnected) return;
    const r = rep();
    const sig = JSON.stringify([r?.label, r?.capture, r?.tiles, r?.docks, S.effective.sceneId, S.effective.mode, (S.effective.modes ?? {})[LAYOUT_BAG]]);
    if (what === 'report' && sig === lastSig) return;
    lastSig = sig;
    const ae = document.activeElement;
    if (ae && side.contains(ae) && (ae as HTMLInputElement).type === 'text') { drawOverlay(items()); return; }
    paint();
  });
  paint();
  return { el, update: paint, dispose: () => { off(); ov.remove(); } };
}
