// Scene tab → "Transitions": the card that hides the loading when the room changes (src/scene/transition/*,
// shared/curtain.ts). Style picker with live mini previews (hover to play), speed, minimum time, "hold until I confirm"
// + Confirm (Shift+Enter), cover on OBS page load, per-style Test (plays in the Scene-tab preview only, never on OBS),
// and what this PC's OBS pages report (cover → load → ready → reveal, with timings).
import type { App } from '../app.ts';
import { DEFAULT_CURTAIN, type CurtainStatus } from '../../shared/curtain.ts';
import { CURTAIN_STYLES, CUT, SHUFFLE, shufflePool } from '../scene/transition/styles.ts';
import type { CurtainStyleDef } from '../scene/transition/kit.ts';
import { drawCurtainMini as miniFrame } from '../scene/transition/mini.ts';
import { button, clear, debounce, h, rerender, section, slider, toast, toggle } from './dom.ts';
import { forScripts } from './forScripts.ts';
import { previewVisible } from './previewFrame.ts';

const CSS = `
.trn-grid { display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin:6px 0 10px; }
.trn-card { border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--card, #151920); cursor:pointer; position:relative; }
.trn-card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.trn-card canvas { display:block; width:100%; aspect-ratio:16/9; background:#000 repeating-conic-gradient(#1a1d24 0 25%, #14171c 0 50%) 0 0/12px 12px; }
.trn-card .ph { width:100%; aspect-ratio:16/9; display:grid; place-items:center; font-size:26px; color:var(--dim); background:repeating-conic-gradient(#1a1d24 0 25%, #14171c 0 50%) 0 0/12px 12px; }
.trn-card .meta { display:flex; align-items:center; gap:4px; padding:5px 6px 6px; }
.trn-card .meta b { flex:1; font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.trn-card .meta button { font-size:11px; padding:2px 7px; }
.trn-card .tag { position:absolute; left:6px; top:6px; font-size:10px; padding:1px 6px; border-radius:8px; background:#000a; color:#fff; }
.trn-status { font: 12px ui-monospace, Consolas, monospace; background:var(--input, #12151b); border:1px solid var(--line); border-radius:6px; padding:6px 8px; margin:4px 0; white-space:pre-wrap; }
.trn-confirm { width:100%; font-weight:700; padding:10px; margin:4px 0 8px; }
`;
let cssDone = false;
const roomPics = new Map<string, HTMLImageElement>();

export function transitionsSection(app: App): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const grid = h('div', { class: 'trn-grid' });
  const controls = h('div');
  const status = h('div', { class: 'trn-status' });
  const cards = new Map<string, HTMLElement>();
  const redraws: (() => void)[] = [];
  let thumb: HTMLImageElement | null = null, thumbFor = '';

  const roomTitle = () => { const id = S.effective.sceneId; return id ? S.scenes.find((x) => x.id === id)?.name ?? id : ''; };
  const roomThumb = () => {
    const id = S.effective.sceneId ?? S.scenes.find((x) => x.ready !== false)?.id ?? '';
    if (id && id !== thumbFor) {
      thumbFor = id;
      // (one picture per room for every build of this section: a tab switch never fetches + decodes it again)
      let img = roomPics.get(id);
      if (!img) {
        const im = img = new Image();
        im.src = `/api/scenes/${encodeURIComponent(id)}/file/preview.png`;
        im.onerror = () => { const t = S.scenes.find((x) => x.id === id)?.thumb; if (t && !im.src.endsWith(t)) im.src = t; };
        roomPics.set(id, im);
      }
      if (!img.complete || !img.naturalWidth) img.addEventListener('load', () => { if (grid.isConnected && thumb === img) redraws.forEach((f) => f()); }, { once: true });
      thumb = img;
    }
    return thumb;
  };

  const pick = (id: string) => { if (!S.canEdit) { toast('The host picks the transition', 'warn'); return; } S.setCurtain({ style: id }); };
  const test = (id: string) => {
    S.testCurtain(id === CUT ? S.curtain.style : id);
    const live = previewVisible();   // (the hidden room-analysis preview plays it unseen: not "playing in the preview")
    toast(live ? 'Playing in the Scene preview only (OBS never sees tests)' : 'Turn the Scene preview on (above) to see the test', live ? 'info' : 'warn', 2200);
  };

  const card = (id: string, name: string, tag: string, st: CurtainStyleDef | null, icon = '') => {
    let cv: HTMLCanvasElement | null = null;
    let raf = 0, t0 = 0;
    const draw = (time: number | null) => {
      if (!cv) return;
      const ctx = cv.getContext('2d');
      if (ctx && st) miniFrame(ctx, cv.width, cv.height, st, time, roomTitle() || 'VTube Pro', roomThumb());
    };
    const loop = () => { raf = requestAnimationFrame(loop); draw((performance.now() - t0) / 1000); };
    const el = h('div', { class: 'trn-card', title: st?.blurb ?? name, onClick: () => pick(id),
      onMouseenter: () => { if (st && !raf) { t0 = performance.now(); loop(); } },
      onMouseleave: () => { cancelAnimationFrame(raf); raf = 0; draw(null); } },
      st ? (cv = h('canvas', { width: 384, height: 216 }) as HTMLCanvasElement) : h('div', { class: 'ph' }, icon),
      tag ? h('span', { class: 'tag' }, tag) : null,
      h('div', { class: 'meta' }, h('b', null, name),
        id !== CUT ? h('button', { class: 'btn', title: 'Play it in the Scene preview (never on OBS)', onClick: (e: Event) => { e.stopPropagation(); test(id); } }, 'Test') : null));
    cards.set(id, el);
    if (st) { redraws.push(() => draw(null)); draw(null); }
    return el;
  };

  const buildGrid = () => {
    const vtp = CURTAIN_STYLES.filter((s) => s.theme === 'vtp'), own = CURTAIN_STYLES.filter((s) => s.theme !== 'vtp');
    clear(grid); cards.clear(); redraws.length = 0;
    grid.append(...vtp.map((s) => card(s.id, s.name, 'VTube Pro', s)));
    for (const s of own) grid.append(card(s.id, s.name, 'Yours', s));
    if (own.length) grid.append(card(SHUFFLE, 'Shuffle (your set)', '', null, '🎲'));
    grid.append(card(CUT, 'Cut (no transition)', '', null, '✂'));
  };
  buildGrid();

  const setDur = debounce((v: number) => S.setCurtain({ dur: v }), 300);
  const setMin = debounce((v: number) => S.setCurtain({ minHold: v }), 300);
  const renderControls = () => rerender(controls, () => {
    const c = S.curtain, edit = S.canEdit;
    for (const [id, el] of cards) el.classList.toggle('on', id === c.style);
    const waiting = S.curtainWaiting;
    const conf = button(waiting ? '✅ Confirm — show the new room (Shift+Enter)' : 'Confirm (nothing waiting)', () => S.confirmCurtain(), waiting ? 'primary trn-confirm' : 'trn-confirm');
    (conf as HTMLButtonElement).disabled = !edit || !waiting;
    const bits = [
      slider('Speed: cover-in (s)', c.dur, 0.25, 1.5, 0.05, (v) => setDur(v), 'How long the card takes to cover the frame (the reveal is a little slower). Themed styles scale this.', (v) => `${v.toFixed(2)} s`, { def: DEFAULT_CURTAIN.dur, hard: [0.25, 2] }),
      slider('Minimum time on screen (s)', c.minHold, 0, 4, 0.1, (v) => setMin(v), 'Even a room that loads instantly keeps the card up this long, so it never just flashes', (v) => `${v.toFixed(1)} s`, { def: DEFAULT_CURTAIN.minHold, hard: [0, 10] }),
      toggle('Hold until I confirm', c.hold, (v) => S.setCurtain({ hold: v }), 'The card stays up after the room has loaded until you press Confirm (or Shift+Enter, or a Stream Deck key). Your guests’ OBS reveals on your confirm too.'),
      c.hold ? conf : null,
      toggle('Also when an OBS page (re)loads', c.boot, (v) => S.setCurtain({ boot: v }), 'OBS “refresh browser when scene becomes active” and first loads: the room is covered until it is ready'),
      toggle('Rooms bring their own transition', c.rooms !== false, (v) => S.setCurtain({ rooms: v }), 'A room can set its own arrival / departure card (scene.json curtain: {in, out}). It replaces your pick for changes into (or out of) that room; Cut always wins.'),
    ];
    for (const b of bits) if (b && !edit) for (const i of (b as HTMLElement).querySelectorAll('input')) (i as HTMLInputElement).disabled = true;
    const sel = c.style === CUT ? 'Cut — rooms swap with no transition (the old behaviour)' : c.style === SHUFFLE ? `Shuffle — ${shufflePool(c).map((s) => s.name).join(', ')}` : CURTAIN_STYLES.find((s) => s.id === c.style)?.blurb ?? c.style;
    controls.append(h('p', { class: 'note' }, h('b', null, 'Now: '), sel), ...bits.filter(Boolean) as HTMLElement[]);
    if (!edit) controls.append(h('p', { class: 'note' }, 'The host picks the transition and confirms; your OBS plays the same one.'));
  });

  const line = (label: string, s: CurtainStatus | undefined, age?: number) => {
    if (!s) return '';
    const sec = (ms?: number) => (ms === undefined ? '…' : `${(ms / 1000).toFixed(1)} s`);
    const what = s.phase === 'idle' ? (s.totalMs !== undefined ? `done in ${sec(s.totalMs)} (room loaded ${sec(s.loadMs)}, ready ${sec(s.readyMs)}${s.why && s.why !== 'ready' ? `, ${s.why}` : ''})` : 'idle')
      : s.phase === 'covering' ? 'covering…' : s.phase === 'loading' || s.phase === 'warming' ? `loading ${s.room ?? 'Classic'}… (room ${sec(s.loadMs)})`
      : s.phase === 'ready' ? (S.curtainWaiting ? `READY — waiting for your confirm (${sec(s.readyMs)})` : `ready (${sec(s.readyMs)})`)
      : s.phase === 'failed' ? `${s.room ?? 'the room'} didn't load (${s.why === 'stalled' ? 'no progress for a minute' : 'an error'}) - pick it again to retry`
      : 'revealing…';
    return `${label}: ${what}${age !== undefined && age > 60_000 && s.phase === 'idle' ? ` · ${Math.round(age / 60_000)} min ago` : ''}`;
  };
  const renderStatus = () => {
    const lines: string[] = [];
    const now = Date.now();
    let i = 0;
    for (const s of S.curtainPages.values()) if (now - s.at < 30 * 60_000) lines.push(line(`OBS page ${++i}`, s, now - s.at));
    if (previewVisible() && (S.report?.curtain && S.report.curtain.phase !== 'idle' || S.report?.curtain?.totalMs !== undefined)) lines.push(line('Preview', S.report?.curtain));
    status.textContent = lines.length ? lines.join('\n') : 'No room change yet. OBS pages report here when they cover, load and reveal a room.';
    if (S.curtainWaiting && !controls.querySelector('.trn-confirm.primary')) renderControls();
  };

  S.on((what) => {
    if (!grid.isConnected) return;
    if (what === 'state') { renderControls(); renderStatus(); if (S.effective.sceneId !== thumbFor && S.effective.sceneId) { roomThumb(); redraws.forEach((f) => f()); } }
    else if (what === 'curtain' || what === 'report') renderStatus();
  });
  renderControls();
  renderStatus();
  return section('Transitions',
    h('p', { class: 'note' }, 'When the room changes, every OBS page (and your party guests’) covers the frame with this card ', h('b', null, 'before'), ' the old room goes, loads the new one behind it, and reveals it once it is ready — no black frames, no pop-in. Hover a card to play it.'),
    grid, controls,
    h('h4', { style: 'margin:10px 0 4px' }, 'Status'), status,
    forScripts('Automation: bus / MCP ', h('code', null, 'send_command scene {"curtain":{"confirm":true}}'), ' or ', h('code', null, 'POST /api/scene/curtain {"confirm":true}'), ' (also style, hold, dur, boot).'));
}
