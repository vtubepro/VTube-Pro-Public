// Scene tab → "Capture cover": hide ONLY the game / window capture while you set a game up (src/scene/capcover/*,
// shared/capcover.ts). One big on / off button (also the Hide my screen key — Ctrl+B unless changed in Live → Privacy —, bus / MCP scene {cover:{on:'toggle'}}, Stream Deck
// POST /api/scene/cover), the card's text, and the style cards with live mini previews (hover to play).
import type { App } from '../app.ts';
import { COVER_STYLES } from '../scene/capcover/styles.ts';
import { drawCoverMini } from '../scene/capcover/cover.ts';
import type { CoverStyleDef } from '../scene/capcover/kit.ts';
import { cleanCoverText } from '../../shared/capcover.ts';
import { clear, debounce, h, rerender, section, toast } from './dom.ts';
import { forScripts } from './forScripts.ts';
import { comboLabel, loadHideScreenKey } from '../../shared/hotkey.ts';

const CSS = `
.ccv-grid { display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin:6px 0 10px; }
.ccv-card { border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--card, #151920); cursor:pointer; position:relative; }
.ccv-card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ccv-card canvas { display:block; width:100%; aspect-ratio:16/9; background:#000; }
.ccv-card .meta { padding:5px 6px 6px; font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ccv-card .tag { position:absolute; left:6px; top:6px; font-size:10px; padding:1px 6px; border-radius:8px; background:#000a; color:#fff; }
.ccv-toggle { width:100%; font-weight:800; font-size:15px; padding:12px; margin:4px 0 8px; }
.ccv-toggle.live { background:#c0392b; border-color:#e74c3c; color:#fff; }
.ccv-text { width:100%; box-sizing:border-box; }
`;
let cssDone = false;

export function capcoverSection(app: App): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const top = h('div');
  const grid = h('div', { class: 'ccv-grid' });
  const cards = new Map<string, HTMLElement>();
  const redraws: (() => void)[] = [];
  const text = () => S.capcover.text;

  const card = (st: CoverStyleDef) => {
    let raf = 0, t0 = 0;
    const cv = h('canvas', { width: 384, height: 216 }) as HTMLCanvasElement;
    const draw = (time: number | null) => { const ctx = cv.getContext('2d'); if (ctx) drawCoverMini(ctx, cv.width, cv.height, st, time, text()); };
    const loop = () => { raf = requestAnimationFrame(loop); draw((performance.now() - t0) / 1000); };
    const el = h('div', { class: 'ccv-card', title: st.blurb, onClick: () => { if (!S.canEdit) { toast('The host picks the cover', 'warn'); return; } S.setCapCover({ style: st.id }); },
      onMouseenter: () => { if (!raf) { t0 = performance.now(); loop(); } },
      onMouseleave: () => { cancelAnimationFrame(raf); raf = 0; draw(null); } },
      cv, h('span', { class: 'tag' }, st.theme === 'vtp' ? 'VTube Pro' : 'Yours'), h('div', { class: 'meta' }, st.name));
    cards.set(st.id, el);
    redraws.push(() => draw(null));
    draw(null);
    return el;
  };
  const buildGrid = () => {
    clear(grid); cards.clear(); redraws.length = 0;
    grid.append(...COVER_STYLES.filter((s) => s.theme === 'vtp').map(card), ...COVER_STYLES.filter((s) => s.theme !== 'vtp').map(card));
  };
  buildGrid();

  const setText = debounce((v: string) => S.setCapCover({ text: cleanCoverText(v) }), 400);
  const input = h('input', { class: 'ccv-text', type: 'text', maxlength: 60, placeholder: 'Card text (empty = the style’s own line, e.g. “Setting up the game…”)', value: text(),
    onInput: (e: Event) => { setText((e.target as HTMLInputElement).value); }, onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); } }) as HTMLInputElement;

  const render = () => rerender(top, () => {
    const c = S.capcover, edit = S.canEdit;
    for (const [id, el] of cards) el.classList.toggle('on', id === c.style);
    const k = comboLabel(loadHideScreenKey((() => { try { return localStorage; } catch { return null; } })()));
    const b = h('button', { class: `btn ccv-toggle ${c.on ? 'live' : 'primary'}`, disabled: !edit, title: `${k} (change it in Live → Privacy)`,
      onClick: () => S.toggleCapCover(!c.on) }, c.on ? `👀 Show my screen again (${k})` : `🙈 Hide my screen (${k})`);
    top.append(b, h('p', { class: 'note' }, c.on
      ? h('span', null, h('b', null, 'Covered. '), 'Your game / window capture is hidden on every OBS page (and your guests’) until you turn this off. The avatars, cams and chat stay visible.')
      : 'Setting up a game or picking a window? Cover it first: only the capture area (the React screen / the game box) is covered, never the performers — it stays up until you turn it off.'));
  });
  S.on((what) => {
    if (!grid.isConnected) return;
    if (what === 'state') {
      render();
      if (document.activeElement !== input && input.value !== text()) { input.value = text(); redraws.forEach((f) => f()); }
    }
  });
  render();
  // (clarity: the same key is "Hide my screen" everywhere else; "capture cover" stays in the title so Ctrl+K finds it)
  return section('Hide my screen (capture cover)',
    top, input, grid,
    forScripts('Automation: ', h('code', null, 'POST /api/scene/cover {"on":"toggle"}'), ' (Stream Deck; also true / false, style, text) or bus / MCP ', h('code', null, 'send_command scene {"cover":{"on":true}}'), '.'));
}
