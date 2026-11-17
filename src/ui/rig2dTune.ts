// "How much each part moves" in the 2D model block (src/ui/rig2dPanel.ts, one line): a strength per tracked part, with
// separate up / down amounts where a part goes both ways (brows up / brows down when you frown, eyes open wide / close,
// head nod up / down, mouth smile / frown). Brows sit on top; the other parts under "Fine-tune each part (N)". Saved
// in profile.flat.opts.tune (shared/rig2d/drive.ts Rig2DTune), applied live on every page (no reload). Each part shows
// a live bar: the dot is what your face does now, the filled part what the avatar does with your settings, so a frown
// that hits a lowered limit is plain to see.
import type { Animator } from '../../shared/rig2d/animate.ts';
import { sanitizeTune, type Rig2DTune } from '../../shared/rig2d/drive.ts';
import { boundParts, markerOf, partStrength, withPartStrength, type TunePart } from '../../shared/rig2d/tune.ts';
import { button, h, slider, syncSlider } from './dom.ts';

const CSS = `
.r2t-now{position:relative;height:6px;margin:-2px 0 8px;border-radius:3px;background:var(--line,rgba(127,127,127,.25));overflow:visible}
.r2t-now i{position:absolute;top:0;bottom:0;border-radius:3px;background:var(--accent,#6aa8ff);opacity:.75}
.r2t-now b{position:absolute;top:-3px;width:2px;height:12px;margin-left:-1px;background:currentColor;opacity:.85;border-radius:1px}
.r2t-now s{position:absolute;top:-1px;bottom:-1px;width:1px;background:currentColor;opacity:.35}
.r2t h4{margin:10px 0 2px;font-size:13px}
.r2t details summary{cursor:pointer;margin:8px 0;font-weight:600}
.r2t .r2t-legend{opacity:.75;font-size:12px;margin:0 0 4px}
@media (max-width:640px),(pointer:coarse){
 .r2t details>summary{min-height:44px;display:flex;align-items:center;font-size:15px}
 .r2t .row.slider{grid-template-columns:minmax(0,1fr) auto;row-gap:0;margin-bottom:2px}
 .r2t .row.slider>.lbl{grid-column:1;grid-row:1}
 .r2t .row.slider .sl-end{grid-column:2;grid-row:1}
 .r2t .row.slider .sl-track{grid-column:1/-1;grid-row:2}
 .r2t .sl-track input[type=range]{-webkit-appearance:none;appearance:none;height:44px;background:transparent;touch-action:pan-y}
 .r2t .sl-track input[type=range]::-webkit-slider-runnable-track{height:8px;border-radius:4px;background:var(--line2)}
 .r2t .sl-track input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:44px;height:44px;margin-top:-18px;border-radius:50%;background:var(--accent);border:3px solid var(--card)}
 .r2t .sl-track input[type=range]::-moz-range-track{height:8px;border-radius:4px;background:var(--line2)}
 .r2t .sl-track input[type=range]::-moz-range-thumb{width:44px;height:44px;border-radius:50%;background:var(--accent);border:3px solid var(--card)}
 .r2t .sl-reset{width:44px;height:44px;font-size:20px}
 .r2t .sl-num{height:36px;width:64px}
 .r2t .sl-num input.sl-in{height:34px;line-height:34px;font-size:14px}
 .r2t details>button.btn,.rig2d [data-ui=rig2d-editrig] button.btn{min-height:44px !important;font-size:14px}
}`;
let cssDone = false;

interface Live { anim: Animator }
interface Marker { part: TunePart; el: HTMLElement; fill: HTMLElement; dot: HTMLElement }
interface Block { root: HTMLElement; markers: Marker[]; cur: () => Live | null | undefined; born: number; seen: boolean; gone: number }

/** Every block built (a panel may be built before it is put on the page, e.g. a card filled while closed, or built and
 *  dropped by a re-render): a block is dropped once it has been on the page and left it for 3 s, or was never shown in
 *  60 s. */
const blocks = new Set<Block>();
let loopOn = false, last = 0;
/** (tests only, on a page opened with ?tuneProbe=1: how many blocks the live loop watches, whether it runs) */
if (typeof location !== 'undefined' && /[?&]tuneProbe=1(&|$)/.test(location.search)) (globalThis as { __vtpTuneBars?: unknown }).__vtpTuneBars = { blocks: () => blocks.size, running: () => loopOn,
  probe: () => [...blocks].map((b) => ({ on: b.root.isConnected, shown: b.root.offsetParent !== null, seen: b.seen, raw: b.cur()?.anim?.rawSources?.browLY ?? null, dot: b.markers[0]?.dot.style.left })) };
function loop(t: number) {
  if (!blocks.size) { loopOn = false; return; }
  requestAnimationFrame(loop);
  if (t - last < 66) return;
  last = t;
  const now = performance.now();
  for (const b of blocks) {
    // (a panel the studio moves between places is off the page for a moment: only a block gone for 3 s is dropped)
    if (b.root.isConnected) { b.seen = true; b.gone = 0; }
    else { if (b.seen) { b.gone ||= now; if (now - b.gone > 3000) blocks.delete(b); } else if (now - b.born > 60000) blocks.delete(b); continue; }
    if (b.root.offsetParent === null) continue;
    // (the rig on show now: a reload of the avatar since this block was built has a new one)
    const a = b.cur()?.anim;
    if (!a) continue;
    const raw = a.rawSources, cur = a.sources;
    for (const m of b.markers) {
      const v = markerOf(m.part, cur), r = markerOf(m.part, raw);
      const lo = Math.min(v.at, v.rest), hi = Math.max(v.at, v.rest);
      m.fill.style.left = `${lo * 100}%`; m.fill.style.width = `${(hi - lo) * 100}%`;
      m.dot.style.left = `${r.at * 100}%`;
    }
  }
}

/** The block, or null when the model has no tracked part it could tune. `save(tune)` stores + applies it (the panel's
 *  edit()). */
export function rig2dTuneBlock(src: Live, saved: unknown, save: (tune: Rig2DTune | undefined) => void, live: () => Live | null | undefined = () => src): HTMLElement | null {
  const parts = boundParts(src.anim.bindings);
  if (!parts.length) return null;
  if (!cssDone) { cssDone = true; document.head.append(h('style', { id: 'vtp-rig2d-tune' }, CSS)); }
  let tune = sanitizeTune(saved);
  const markers: Marker[] = [];
  const set = (part: TunePart, dir: 'up' | 'down', v: number) => { tune = withPartStrength(tune, part, dir, v); save(tune); };
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  const rows = (part: TunePart): Node[] => {
    const out: Node[] = [slider(part.up, partStrength(tune, part, 'up'), 0, 2, 0.05, (v) => set(part, 'up', v), part.hint, pct, { def: 1, scale: 100, unit: '%' })];
    if (part.down) out.push(slider(part.down, partStrength(tune, part, 'down'), 0, 2, 0.05, (v) => set(part, 'down', v), part.hint, pct, { def: 1, scale: 100, unit: '%' }));
    const fill = h('i'), dot = h('b'), restEl = h('s');
    const el = h('div', { class: 'r2t-now', title: 'Now: the line is your face, the bar is what the avatar does', 'data-part': part.id }, restEl, fill, dot);
    markers.push({ part, el, fill, dot });
    restEl.style.left = `${markerOf(part, {}).rest * 100}%`;
    out.push(el);
    return out;
  };
  const brows = parts.find((p) => p.id === 'brows');
  const rest = parts.filter((p) => p !== brows);
  const root = h('div', { class: 'r2t', 'data-ui': 'rig2d-tune' },
    h('h4', null, 'How much each part moves'),
    h('p', { class: 'r2t-legend' }, '100 % = as your face does it. Under each part: the line is your face now, the bar is your avatar.'),
    ...(brows ? rows(brows) : []),
    rest.length ? h('details', null, h('summary', null, `Fine-tune each part (${rest.length})`),
      ...rest.flatMap(rows),
      button('Everything as tracked (100 %)', () => { tune = undefined; save(undefined); for (const r of root.querySelectorAll<HTMLInputElement>('input[type=range]')) syncSlider(r, 1); })) : null);
  // the live bars (~15 a second, only while the block is on screen): one shared loop for every block
  blocks.add({ root, markers, cur: () => live() ?? src, born: performance.now(), seen: false, gone: 0 });
  if (!loopOn) { loopOn = true; requestAnimationFrame(loop); }
  return root;
}
