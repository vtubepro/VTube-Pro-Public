// Tutorials: the runner. One tutorial at a time: it goes to the right area, puts a spotlight on the real button, says
// one plain sentence, and waits until the person has done it (a click on the spotlit thing, a window opening, or the
// studio saying it is done: camera on, room picked, OBS showing the studio…), then moves on by itself.
// Back / Next (or "Skip this step") / Close are always there; Close keeps your place, the hub's "Start over" resets it.
// The dim layer never blocks a click: the person can use the studio normally, the bubble just follows along.
// Read-only by design: the runner itself never changes a setting, never starts the camera, never talks to OBS and never
// makes a sound; it only navigates between areas and watches. Observer pages (?observer=1) never write progress.
import { h, toast } from '../dom.ts';
import { icon } from '../icons.ts';
import type { TutHook, TutState, TutStep, Tutorial } from './types.ts';
import { TUTORIALS } from './catalog.ts';
import { forget, progressOf, saveProgress, setActive } from './progress.ts';
import { resetOnce, watchOnce } from './state.ts';

export interface TutHost {
  go(area: string): void;
  advanced(area: string, sub?: string): void;
  /** Is this studio state true right now? (src/ui/tutorials/state.ts) */
  state(s: TutState): boolean;
  /** Open the hub (the list of tutorials). */
  hub(): void;
  /** Open a written guide (FILE.md#anchor). */
  guide(target: string): void;
  /** Open a guided set-up (src/ui/wizards.ts openNamed), optionally at one page. */
  wizard(id: string, at?: string): void;
}

/** `name` → [data-tut~="name"], `ui:name` → [data-ui="name"], `#id` → the element with that id. */
export function hookSelector(hk: TutHook): string {
  if (hk.startsWith('#')) return `#${CSS.escape(hk.slice(1))}`;
  if (hk.startsWith('ui:')) return `[data-ui="${CSS.escape(hk.slice(3))}"]`;
  return `[data-tut~="${CSS.escape(hk)}"]`;
}

const shown = (el: Element): el is HTMLElement => {
  const r = (el as HTMLElement).getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
};
/** The first hook with an element on screen (rendered; maybe scrolled out of view). */
export function findHook(hooks: TutHook[] | undefined): HTMLElement | null {
  for (const hk of hooks ?? []) {
    for (const el of document.querySelectorAll(hookSelector(hk))) {
      if (el.closest('.tu-bubble, .tu-hub')) continue;
      if (shown(el)) return el;
    }
  }
  return null;
}
/** A hook inside a folded card / section: unfold it (like the person clicking its title) so the spotlight can reach it. */
function unfoldFor(hooks: TutHook[] | undefined): boolean {
  for (const hk of hooks ?? []) {
    for (const el of document.querySelectorAll(hookSelector(hk))) {
      const fold = el.closest('.collapsed');
      if (fold && !el.closest('.tu-bubble, .tu-hub')) { fold.classList.remove('collapsed'); return true; }
    }
  }
  return false;
}
/** The part of an element you can actually see: clipped by every scrolling / clipping box around it. */
function visibleRect(el: HTMLElement): DOMRect {
  let { left, top, right, bottom } = el.getBoundingClientRect();
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const r = p.getBoundingClientRect();
    left = Math.max(left, r.left); top = Math.max(top, r.top); right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
const inView = (r: DOMRect) => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;

let host: TutHost | null = null;
let saving = true;
export function setTutHost(x: TutHost, canSave: boolean) { host = x; saving = canSave; }

// ---------------------------------------------------------------- the run
interface Run { tut: Tutorial; steps: TutStep[]; ix: number; close(keep: boolean): void; repaint(): void }
let run: Run | null = null;
export const runningTutorial = () => run?.tut.id ?? null;
export const runningStep = () => (run ? { id: run.tut.id, step: run.steps[run.ix]?.id ?? '', ix: run.ix, of: run.steps.length } : null);

/** The steps that apply here. */
export const stepsFor = (t: Tutorial) => t.steps;

export function stopTutorial() { run?.close(true); }

export function startTutorial(id: string, opts: { restart?: boolean } = {}) {
  const H = host;
  const found = TUTORIALS.find((t) => t.id === id);
  if (!H || !found) return;
  const tut: Tutorial = found;
  run?.close(true);
  injectCss();
  const steps = stepsFor(tut);
  if (!steps.length) return;
  const saved = progressOf(tut.id);
  let ix = opts.restart || saved.done ? 0 : Math.min(Math.max(0, saved.step), steps.length - 1);
  if (opts.restart) forget(tut.id, saving);
  watchOnce(); resetOnce();

  // ---- DOM
  const dim = h('div', { class: 'tu-dim', 'aria-hidden': 'true' });
  const ring = h('div', { class: 'tu-ring', 'aria-hidden': 'true' });
  const eyebrow = h('p', { class: 'tu-eyebrow' });
  const title = h('h2', { class: 'tu-title', id: 'tu-title' });
  const text = h('p', { class: 'tu-text', id: 'tu-text' });
  const status = h('p', { class: 'tu-status', 'aria-live': 'polite' });
  const extra = h('div', { class: 'tu-extra' });
  const bar = h('div', { class: 'tu-bar', 'aria-hidden': 'true' }, h('i'));
  const back = h('button', { class: 'btn ghost tu-back', type: 'button', onClick: () => go(-1) }, 'Back') as HTMLButtonElement;
  const next = h('button', { class: 'btn primary tu-next', type: 'button', onClick: () => go(1) }, 'Next') as HTMLButtonElement;
  const closeBtn = h('button', { class: 'tu-x', type: 'button', title: 'Close (your place is kept)', 'aria-label': 'Close the tutorial', onClick: () => close(true) }, icon('x', 16));
  const minBtn = h('button', { class: 'tu-min', type: 'button', title: 'Move this out of the way', 'aria-label': 'Move the tutorial box', onClick: () => { bubble.classList.toggle('tu-low'); place(); } }, icon('mini', 16));
  const bubble = h('div', { class: 'tu-bubble', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tu-title', 'aria-describedby': 'tu-text', 'data-tut-run': tut.id },
    h('div', { class: 'tu-top' }, eyebrow, minBtn, closeBtn), bar, title, text, status, extra,
    h('div', { class: 'tu-row' }, back, next));
  const layer = h('div', { class: 'tu-layer' }, dim, ring, bubble);

  let target: HTMLElement | null = null;
  let stepAt = 0, doneAt = 0, scrolled = false, navigated = false, finished = false, fellBack = false;
  let lastDir: 1 | -1 = 1;
  let poll = 0;

  function step() { return steps[ix]; }
  function waiting() { const s = step(); return !!s.wait && !doneAt; }

  function enter(dir: 1 | -1 | 0) {
    // forward: skip steps that are already true (camera already on…), never past the last one
    if (dir >= 0) while (ix < steps.length - 1 && steps[ix].skipIf && H!.state(steps[ix].skipIf!)) ix++;
    const s = step();
    stepAt = performance.now(); doneAt = 0; scrolled = false; navigated = false; fellBack = false; target = null;
    lastDir = dir < 0 ? -1 : 1;
    bubble.classList.remove('tu-low');
    if (s.adv && s.area) H!.advanced(s.area, s.adv);
    else if (s.area) H!.go(s.area);
    navigated = !!s.area;
    // zero effort: open what the step is about instead of asking the person to find it (only when going forward)
    if (dir >= 0 && s.open) H!.wizard(s.open.wizard, s.open.at);
    if (s.press) window.setTimeout(() => { const b = findHook([s.press!]); if (b && b.getAttribute('aria-selected') !== 'true') b.click(); }, s.area ? 350 : 0);
    saveProgress(tut.id, { step: ix, done: false }, saving);
    setActive(tut.id, saving);
    paint();
  }

  function paint() {
    const s = step();
    const last = ix === steps.length - 1;
    eyebrow.textContent = `Step ${ix + 1} of ${steps.length} · ${tut.title}`;
    (bar.firstElementChild as HTMLElement).style.width = `${Math.round(((ix + (doneAt ? 1 : 0)) / steps.length) * 100)}%`;
    title.textContent = s.title;
    text.textContent = s.text;
    back.disabled = ix === 0;
    back.style.visibility = ix === 0 ? 'hidden' : '';
    extra.replaceChildren();
    if (tut.fixes?.length) {
      extra.append(h('details', { class: 'tu-fixes' }, h('summary', null, 'Something went wrong?'),
        ...tut.fixes.map((f) => h('div', { class: 'tu-fix' }, h('b', null, f.problem), h('span', null, f.fix)))));
    }
    if (last && tut.readMore) extra.append(h('button', { class: 'tu-link', type: 'button', onClick: () => H!.guide(tut.readMore!) }, icon('book', 14), 'Read the full guide'));
    paintStatus();
    place();
    requestAnimationFrame(place);
  }

  function paintStatus() {
    const s = step();
    const last = ix === steps.length - 1;
    if (doneAt) { status.className = 'tu-status ok'; status.replaceChildren(icon('check', 14), h('span', null, 'Done!')); }
    else if (s.wait) {
      status.className = 'tu-status wait';
      const what = 'click' in s.wait ? 'Waiting for your click…' : 'Waiting for you…';
      status.replaceChildren(h('i', { class: 'tu-spin', 'aria-hidden': 'true' }), h('span', null, what));
    } else { status.className = 'tu-status'; status.replaceChildren(); }
    next.textContent = last ? 'Finish' : s.wait && !doneAt ? 'Skip this step' : 'Next';
    next.classList.toggle('primary', !waiting());
    next.classList.toggle('ghost', waiting());
  }

  function place() {
    if (!run) return;
    const s = step();
    const el = findHook(s.at);
    target = el;
    const pad = 8;
    const bw = Math.min(380, innerWidth - 24);
    bubble.style.width = `${bw}px`;
    const bh = bubble.offsetHeight || 200;
    if (el) {
      let r = visibleRect(el);
      const full = el.getBoundingClientRect();
      // hidden under a sticky header or scrolled away inside its panel: bring it into view (once per step)
      const cut = r.height < Math.min(full.height, innerHeight * 0.5) * 0.8 || r.width < Math.min(full.width, innerWidth * 0.5) * 0.8;
      if ((cut || !inView(full)) && !scrolled) { scrolled = true; el.scrollIntoView({ block: 'center', inline: 'nearest' }); r = visibleRect(el); }
      const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
      const w = Math.max(16, Math.min(innerWidth - 4, r.right + pad) - x), hh = Math.max(16, Math.min(innerHeight - 4, r.bottom + pad) - y);
      Object.assign(ring.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
      // the dim: the whole window minus the hole (a clip-path cut-out: a giant box-shadow got dropped by Chrome's
      // compositor while the camera ran, so the page looked un-dimmed)
      const X = x + w, Y = y + hh;
      dim.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x}px ${y}px, ${X}px ${y}px, ${X}px ${Y}px, ${x}px ${Y}px, ${x}px ${y}px)`;
      // a window opened over the studio (a set-up, a dialog) that isn't the spotlit thing: don't darken it, the person
      // needs to read it; the ring still shows where the step points
      const over = [...document.querySelectorAll<HTMLElement>('dialog[open], .wiz-back, .vtpi-shade, .rp-over, .gd-back')].some((o) => !o.contains(el) && !o.contains(layer));
      dim.classList.toggle('on', !over); ring.classList.add('on');
      if (bubble.classList.contains('tu-low')) { setBubble(innerWidth - bw - 16, innerHeight - bh - 16, bw, bh); return; }
      // the bubble goes where there is most room: right, below, left, above; never over the spotlit thing
      const gap = 14;
      const room = { right: innerWidth - (x + w), below: innerHeight - (y + hh), left: x, above: y };
      let bx: number, by: number;
      if (room.right >= bw + gap * 2) { bx = x + w + gap; by = y + hh / 2 - bh / 2; }
      else if (room.below >= bh + gap * 2) { bx = x + w / 2 - bw / 2; by = y + hh + gap; }
      else if (room.left >= bw + gap * 2) { bx = x - bw - gap; by = y + hh / 2 - bh / 2; }
      else if (room.above >= bh + gap * 2) { bx = x + w / 2 - bw / 2; by = y - bh - gap; }
      else { bx = innerWidth - bw - 16; by = innerHeight - bh - 16; } // a big target: the corner
      setBubble(bx, by, bw, bh);
    } else {
      dim.classList.remove('on'); ring.classList.remove('on');
      // nothing to point at (yet): bottom middle, out of the way of the studio's own windows
      setBubble(innerWidth / 2 - bw / 2, innerHeight - bh - 24, bw, bh);
    }
  }
  function setBubble(x: number, y: number, bw: number, bh: number) {
    bubble.style.left = `${Math.round(Math.max(12, Math.min(innerWidth - bw - 12, x)))}px`;
    bubble.style.top = `${Math.round(Math.max(12, Math.min(innerHeight - bh - 12, y)))}px`;
  }

  /** A modal window (<dialog> shown with showModal: chat & stream set-up, OBS set-up) sits in the
   *  browser's top layer and makes the rest of the page unclickable: the tutorial moves inside it while it is open. */
  function follow() {
    const modal = [...document.querySelectorAll('dialog[open]')].filter((d) => { try { return d.matches(':modal'); } catch { return false; } }).pop() ?? null;
    const want = modal ?? document.body;
    if (layer.parentElement !== want) want.append(layer);
  }

  function tick() {
    if (!run || finished) return;
    follow();
    const s = step();
    // the area can be left by the person; while the target is missing, go back to the step's area once
    if (!findHook(s.at) && s.area && !navigated && performance.now() - stepAt > 600) { navigated = true; if (s.adv) H!.advanced(s.area, s.adv); else H!.go(s.area); }
    if (!doneAt) {
      const w = s.wait;
      let ok = !!w && ('state' in w ? H!.state(w.state) : 'shows' in w ? !!findHook([w.shows]) : false);
      if (!ok && s.orDone && H!.state(s.orDone)) ok = true;
      if (!ok && s.orShows && findHook([s.orShows])) ok = true;
      if (ok) markDone();
    }
    if (!findHook(s.at) && s.at?.length) unfoldFor(s.at);
    place();
    const age = performance.now() - stepAt;
    if (!target && s.at?.length && age > 1500 && !doneAt && !fellBack) {
      fellBack = true;
      // a "find the way" step whose button isn't on screen (phone-sized window): go there for them
      if (s.orGo) { if (s.orGo.adv) H!.advanced(s.orGo.area, s.orGo.adv); else H!.go(s.orGo.area); markDone(); return; }
      // a step about something this studio doesn't show right now: leave it out
      if (s.ifShown) { if ((lastDir > 0 && ix < steps.length - 1) || (lastDir < 0 && ix > 0)) go(lastDir); else if (ix < steps.length - 1) go(1); return; }
    }
    // a step waiting long without a target: say where to look
    const missing = !target && !!s.at?.length && performance.now() - stepAt > 2500;
    bubble.classList.toggle('tu-lost', missing);
    if (missing && !bubble.querySelector('.tu-hint')) text.after(h('p', { class: 'tu-hint' }, s.lost ?? 'Can’t see it? Close any window that is open, or scroll down a little.'));
    if (!missing) bubble.querySelector('.tu-hint')?.remove();
  }

  function markDone() {
    if (doneAt) return;
    doneAt = performance.now();
    paintStatus();
    (bar.firstElementChild as HTMLElement).style.width = `${Math.round(((ix + 1) / steps.length) * 100)}%`;
    window.setTimeout(() => { if (run && doneAt && steps[ix] === step()) go(1); }, 900);
  }

  // a click on the spotlit thing: seen on the capture phase (the studio's own handler may redraw and remove the button
  // before a bubbling listener would look), counted a moment later so the studio's handler has run
  const onClick = (e: MouseEvent) => {
    const s = step();
    if (!s.wait || !('click' in s.wait) || doneAt) return;
    const t = e.target as Element | null;
    if (t?.closest && (s.at ?? []).some((hk) => !!t.closest(hookSelector(hk)))) window.setTimeout(markDone, 60);
  };

  function go(d: 1 | -1) {
    if (d > 0 && ix === steps.length - 1) { finish(); return; }
    ix = Math.max(0, Math.min(steps.length - 1, ix + d));
    enter(d);
  }

  function finish() {
    finished = true;
    saveProgress(tut.id, { step: 0, done: true }, saving);
    setActive(null, saving);
    dim.classList.remove('on'); ring.classList.remove('on');
    eyebrow.textContent = tut.title;
    title.textContent = 'You did it!';
    text.textContent = 'That’s the whole tutorial. You can open it again any time.';
    status.className = 'tu-status ok'; status.replaceChildren(icon('check', 14), h('span', null, 'Finished'));
    (bar.firstElementChild as HTMLElement).style.width = '100%';
    extra.replaceChildren();
    back.style.visibility = 'hidden';
    next.textContent = 'More tutorials'; next.className = 'btn primary tu-next';
    next.onclick = (e) => { e.stopImmediatePropagation(); close(false); H!.hub(); };
    setBubble(innerWidth / 2 - bubble.offsetWidth / 2, innerHeight - bubble.offsetHeight - 24, bubble.offsetWidth, bubble.offsetHeight);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !bubble.contains(document.activeElement)) return;
    e.preventDefault(); e.stopPropagation(); close(true);
  };

  function close(keep: boolean) {
    if (!run) return;
    run = null;
    window.clearInterval(poll);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    layer.classList.add('out');
    window.setTimeout(() => layer.remove(), 160);
    if (keep && !finished) toast('Tutorial paused. Help → Tutorials picks it up where you left off.', 'info', 4200);
    if (!finished) setActive(keep ? tut.id : null, saving);
  }

  run = { tut, steps, get ix() { return ix; }, close, repaint: () => paint() } as Run;
  document.body.append(layer);
  document.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  poll = window.setInterval(tick, 250);
  enter(0);
  next.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- style (the studio's own theme variables)
export function injectCss() {
  if (document.getElementById('vtp-tut-css')) return;
  document.head.append(h('style', { id: 'vtp-tut-css' }, STYLE));
}
const STYLE = `
.tu-layer { position: fixed; inset: 0; z-index: 90; pointer-events: none; animation: tu-fade 200ms ease both; }
.tu-layer.out { animation: tu-fade 150ms ease reverse both; }
@keyframes tu-fade { from { opacity: 0; } to { opacity: 1; } }
.tu-dim { position: fixed; inset: 0; opacity: 0; background: #05070bb8; transition: clip-path 300ms cubic-bezier(.16,1,.3,1), opacity 200ms; }
.tu-dim.on { opacity: 1; }
.tu-ring { position: fixed; border-radius: 14px; opacity: 0; box-shadow: 0 0 0 2px var(--accent), 0 0 0 7px color-mix(in srgb, var(--accent) 28%, transparent); transition: left 300ms cubic-bezier(.16,1,.3,1), top 300ms cubic-bezier(.16,1,.3,1), width 300ms cubic-bezier(.16,1,.3,1), height 300ms cubic-bezier(.16,1,.3,1), opacity 200ms; }
.tu-ring.on { opacity: 1; animation: tu-pulse 1.6s ease-in-out infinite; }
@keyframes tu-pulse { 50% { box-shadow: 0 0 0 2px var(--accent), 0 0 0 12px color-mix(in srgb, var(--accent) 10%, transparent); } }
.tu-bubble { position: fixed; pointer-events: auto; background: var(--panel); color: var(--text); border: 1px solid var(--line2); border-radius: 18px; padding: 14px 16px 14px; box-shadow: 0 30px 80px -24px #000d, inset 0 1px 0 #ffffff10; transition: left 300ms cubic-bezier(.16,1,.3,1), top 300ms cubic-bezier(.16,1,.3,1); font-size: 14px; }
.tu-top { display: flex; align-items: center; gap: 6px; }
.tu-eyebrow { flex: 1; min-width: 0; margin: 0; font: 600 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tu-x, .tu-min { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 8px; background: none; color: var(--dim); cursor: pointer; }
.tu-x:hover, .tu-min:hover { background: var(--card2); color: var(--text); }
.tu-bar { height: 3px; border-radius: 2px; background: var(--line); margin: 8px 0 2px; overflow: hidden; }
.tu-bar i { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 2px; transition: width 400ms cubic-bezier(.16,1,.3,1); }
.tu-title { margin: 10px 0 4px; font: 700 19px/1.2 var(--font-display, system-ui); letter-spacing: -.015em; }
.tu-text { margin: 0; color: var(--text); opacity: .86; font-size: 15px; line-height: 1.5; }
.tu-hint { margin: 8px 0 0; padding: 7px 10px; border-radius: 10px; background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--text); font-size: 13px; }
.tu-status { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; font-size: 13px; color: var(--dim); min-height: 0; }
.tu-status:empty { display: none; }
.tu-status.ok { color: var(--ok, var(--accent)); font-weight: 650; }
.tu-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent); border-top-color: var(--accent); animation: tu-rot 900ms linear infinite; }
@keyframes tu-rot { to { transform: rotate(360deg); } }
.tu-extra:empty { display: none; }
.tu-extra { margin-top: 10px; display: grid; gap: 8px; }
.tu-fixes { border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; background: var(--card); }
.tu-fixes summary { cursor: pointer; font-weight: 650; font-size: 13.5px; }
.tu-fix { margin-top: 8px; font-size: 13px; line-height: 1.45; }
.tu-fix b { display: block; }
.tu-fix span { color: var(--dim); }
.tu-link { display: inline-flex; align-items: center; gap: 6px; justify-self: start; border: 0; background: none; color: var(--accent2, var(--accent)); font: inherit; font-size: 13px; cursor: pointer; padding: 2px 0; }
.tu-link:hover { text-decoration: underline; }
.tu-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.tu-row .tu-back { margin-right: auto; }
.tu-row .btn { min-height: 36px; border-radius: 10px; padding: 6px 16px; }
.tu-resume { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 89; display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 6px; border-radius: 999px; background: var(--panel); border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line2)); box-shadow: 0 20px 50px -20px #000c; animation: tu-fade 240ms ease both; max-width: calc(100vw - 24px); }
.tu-resume-go { display: inline-flex; align-items: center; gap: 8px; min-width: 0; border: 0; background: none; color: var(--text); font: inherit; font-size: 13.5px; cursor: pointer; padding: 6px 8px; border-radius: 999px; }
.tu-resume-go span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tu-resume-go svg { color: var(--accent); flex: none; }
.tu-resume-go small { color: var(--dim); }
.tu-resume-go:hover { background: var(--card2); }
@media (max-width: 600px) { .tu-bubble { padding: 12px 14px; } .tu-title { font-size: 17px; } .tu-text { font-size: 14px; } }
@media (prefers-reduced-motion: reduce) { .tu-layer, .tu-dim, .tu-ring, .tu-bubble, .tu-bar i { animation: none !important; transition: none !important; } }
`;
