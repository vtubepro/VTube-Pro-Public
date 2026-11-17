// Step-by-step setup wizards: a modal with a step list + progress on the left, the step on the right, Back / Skip /
// Next at the bottom. Skippable (every step), resumable (closing pauses it: the step and what is done are remembered
// in localStorage 'vtp.wiz.<id>'), and each step re-renders through dom.ts rerender() so typing / focus survive the
// live refreshes. A wizard never changes the camera, the avatar or the room by itself: steps only offer buttons.
import type { App } from '../app.ts';
import { button, clear, h, rerender, toast } from './dom.ts';
import { icon } from './icons.ts';
import { add } from './bits.ts';
import { openHelp } from './help/helpViewer.ts';
import { WIZARD_HELP } from '../../shared/helpCatalog.ts';
import { counterText, emptyWizState, markStep, nextMark, parseWizState, stepMark, type WizMark, type WizState } from './onboard/wizState.ts';
export type { WizState } from './onboard/wizState.ts';

export interface WizCtx {
  app: App;
  /** Scratch data shared by the steps of this run (typed-in fields, choices). */
  data: Record<string, unknown>;
  refresh(): void;
  next(): void;
  back(): void;
  goto(id: string): void;
  close(): void;
  /** Hide the wizard while something happens on the main screen (e.g. the expression test); comes back when `until()` turns true. */
  minimize(label: string, until: () => boolean): void;
}
export interface WizStep {
  id: string;
  title: string;
  render(ctx: WizCtx, el: HTMLElement): void;
  /** Called 4× a second while the step shows (update live bits in place; don't rebuild). */
  live?(ctx: WizCtx): void;
  /** Hide the step (e.g. "Time & weather" for a room without a sky). */
  hidden?(ctx: WizCtx): boolean;
  /** Next is disabled with this reason while it returns a string (Skip always works). */
  blocker?(ctx: WizCtx): string | null;
  /** The REAL state of this step (camera on, mic on, OBS seen, room loaded, profile chosen), read live. Only a step that
   *  has it can show a tick or count toward the sidebar total; pressing Next only ever means "seen" (FR-01). */
  isDone?(ctx: WizCtx): boolean;
  nextLabel?: string;
  /** Show the wizard's persistent element (e.g. the room preview) above this step. */
  persistent?: boolean;
}
export interface WizDef {
  id: string;
  title: string;
  blurb: string;
  steps: WizStep[];
  /** One element kept alive across steps (an iframe would reload if it were re-created). */
  persistent?(ctx: WizCtx): HTMLElement;
  onFinish?(ctx: WizCtx): void;
}

const KEY = (id: string) => `vtp.wiz.${id}`;
/** The saved place (any version: a beta.15 blob loads, its `done` ids read as "seen"; src/ui/onboard/wizState.ts). */
export function wizardState(id: string): WizState {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY(id)); } catch { /* storage off */ }
  return parseWizState(raw);
}
function saveState(id: string, s: WizState) { try { localStorage.setItem(KEY(id), JSON.stringify({ ...s, at: Date.now() })); } catch { /* storage off */ } }
export function resetWizard(id: string) { try { localStorage.removeItem(KEY(id)); } catch { /* storage off */ } }

let open: { close(): void } | null = null;
/** Marks the sidebar adds on top of src/ui/theme.ts: "seen" and "skipped" are words, never a tick (FR-01). */
const WIZ_CSS = `.wiz-step .wz-mark{display:block;font-size:11px;font-weight:500;color:var(--faint);margin-top:1px}
.wiz-step.skipped .wz-mark{color:var(--warn,#f5c451)}.wiz-step.seen .n{border-color:var(--accent)}
.toast .wz-continue{margin-left:8px;min-height:30px;padding:3px 12px}`;
function wizStyle() { if (!document.getElementById('wiz-extra-style')) document.head.append(h('style', { id: 'wiz-extra-style' }, WIZ_CSS)); }
export const wizardOpen = () => !!open;

export function openWizard(app: App, def: WizDef, opts: { restart?: boolean; at?: string } = {}) {
  open?.close();
  wizStyle();
  const st: WizState = opts.restart ? emptyWizState() : wizardState(def.id);
  if (st.finished && !opts.at) { st.finished = false; st.step = null; }
  const data: Record<string, unknown> = {};
  const visible = () => def.steps.filter((s) => !s.hidden?.(ctx));
  let cur = 0;
  const side = h('div', { class: 'wiz-side' });
  const main = h('div', { class: 'wiz-main', 'data-ui': `wiz-${def.id}` } as never);
  const body = h('div');
  const foot = h('div', { class: 'wiz-foot' });
  const persist = h('div');
  const closeBtn = h('button', { class: 'icon-btn wiz-close', title: 'Close (Esc) — you can continue later', 'aria-label': 'Close', onClick: () => close(false) }, icon('x', 18));
  // the guide for this helper in the Help viewer (it opens on top; the helper stays where it was)
  const helpTo = WIZARD_HELP[def.id];
  const helpBtn = helpTo ? h('button', { class: 'icon-btn', style: 'position:absolute;top:14px;right:56px;z-index:2', title: 'Help for this set-up (F1)', 'aria-label': 'Help', onClick: () => openHelp(helpTo) }, icon('help', 18)) : null;
  main.append(closeBtn, ...(helpBtn ? [helpBtn] : []), persist, body);
  const card = h('div', { class: 'wiz', role: 'dialog', 'aria-modal': 'true', 'aria-label': def.title }, side, main, foot);
  const back = h('div', { class: 'wiz-back' }, card);
  let mini: HTMLElement | null = null;
  let persistentEl: HTMLElement | null = null;

  const ctx: WizCtx = {
    app, data,
    refresh: () => draw(),
    next: () => go(cur + 1, 'next'),
    back: () => go(cur - 1),
    goto: (id) => { const i = visible().findIndex((s) => s.id === id); if (i >= 0) go(i); },
    close: () => close(false),
    minimize: (label, until) => {
      back.style.display = 'none';
      mini = h('div', { class: 'wiz-mini' }, h('span', null, label), button('Back to setup', () => restore()));
      document.body.append(mini);
      const t = window.setInterval(() => { if (until()) { window.clearInterval(t); restore(); } }, 400);
      const restore = () => { window.clearInterval(t); mini?.remove(); mini = null; back.style.display = ''; draw(); };
    },
  };

  const steps = () => visible();
  const startAt = opts.at ?? st.step;
  if (startAt) { const i = steps().findIndex((s) => s.id === startAt); if (i >= 0) cur = i; }

  const real = (s: WizStep): boolean | undefined => { if (!s.isDone) return undefined; try { return !!s.isDone(ctx); } catch { return false; } };
  /** `done` on disk = the steps whose real state is true right now (nothing is "done" because Next was pressed). */
  let sig = '';
  const signature = () => steps().map((x) => `${x.id}:${real(x)}`).join(',');
  const syncDone = () => { st.done = steps().filter((x) => real(x) === true).map((x) => x.id); };
  function go(i: number, how?: 'next' | 'skip') {
    const list = steps();
    const s = list[cur];
    if (s && how) markStep(st, s.id, how === 'skip' ? 'skipped' : nextMark(!!s.isDone, real(s) === true));
    syncDone();
    if (i >= list.length) { st.finished = true; st.step = null; saveState(def.id, st); def.onFinish?.(ctx); close(true); return; }
    cur = Math.max(0, i);
    st.step = list[cur].id;
    saveState(def.id, st);
    main.scrollTop = 0;
    draw(true);
  }

  function draw(stepChanged = false) {
    const list = steps();
    if (cur >= list.length) cur = list.length - 1;
    const s = list[cur];
    // side: step list + progress
    clear(side);
    side.append(h('div', { class: 'wt' }, def.title), h('div', { class: 'ws' }, def.blurb));
    list.forEach((x, i) => {
      const mark: WizMark = stepMark(st, x.id, real(x));
      const word = mark === 'done' ? 'ready' : mark === 'skipped' ? 'skipped' : mark === 'seen' ? 'seen' : '';
      const tip = mark === 'done' ? 'Ready' : mark === 'skipped' ? 'Skipped. Click to do it now.' : mark === 'seen' ? 'Seen, not set up yet. Click to open it.' : '';
      side.append(h('button', { class: `wiz-step ${i === cur ? 'cur' : ''} ${mark === 'none' ? '' : mark}`, 'data-step': x.id, 'data-mark': mark, onClick: () => go(i), title: tip, 'aria-label': word ? `${x.title}, ${word}` : x.title },
        h('span', { class: 'n' }, mark === 'done' ? '✓' : String(i + 1)), h('span', null, x.title, word && mark !== 'done' ? h('small', { class: 'wz-mark' }, word) : null)));
    });
    const cnt = counterText(st, list.map((x) => ({ id: x.id, real: real(x) })));
    side.append(h('div', { class: 'prog', 'data-wiz-count': String(cnt.n) }, cnt.text, h('div', { class: 's-meter' }, h('i', { style: `width:${cnt.pct}%` }))));
    sig = signature();
    // persistent element
    if (def.persistent) {
      if (!persistentEl) { persistentEl = def.persistent(ctx); persist.append(persistentEl); }
      persist.style.display = s.persistent ? '' : 'none';
    }
    // body (keeps focus / caret / scroll while it re-renders)
    if (stepChanged) { clear(body); s.render(ctx, body); }
    else rerender(body, () => s.render(ctx, body));
    // footer
    clear(foot);
    const why = s.blocker?.(ctx) ?? null;
    const last = cur === list.length - 1;
    const nextB = button(s.nextLabel ?? (last ? 'Finish' : 'Next'), () => go(cur + 1, 'next'), 'primary');
    nextB.disabled = !!why;
    add(foot,
      cur > 0 ? button('Back', () => go(cur - 1)) : h('span'),
      h('span', { class: 'grow' }, why ?? `Step ${cur + 1} of ${list.length}`),
      last ? null : button('Skip this step', () => go(cur + 1, 'skip'), 'ghost'),
      nextB,
    );
  }

  const tick = window.setInterval(() => {
    if (!back.isConnected) return;
    const s = steps()[cur];
    try { s?.live?.(ctx); } catch (e) { console.warn('wizard live', e); }
    // the sidebar ticks and the counter follow the real state (camera, mic, OBS, room, avatar), not clicks
    if (back.style.display !== 'none' && signature() !== sig) draw();
    // keep the Next blocker current
    const why = s?.blocker?.(ctx) ?? null;
    const nb = foot.querySelector('.btn.primary') as HTMLButtonElement | null;
    const grow = foot.querySelector('.grow');
    if (nb) nb.disabled = !!why;
    if (grow) grow.textContent = why ?? `Step ${cur + 1} of ${steps().length}`;
  }, 250);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && back.style.display !== 'none' && !document.querySelector('.hv-back, .ap-wrap')) { e.stopPropagation(); close(false); } }; // (Esc with Help or the camera card open on top closes that one only)
  window.addEventListener('keydown', onKey, true);

  function close(finished: boolean) {
    window.clearInterval(tick);
    window.removeEventListener('keydown', onKey, true);
    mini?.remove();
    back.remove();
    open = null;
    if (!finished) {
      st.step = steps()[cur]?.id ?? null; syncDone(); saveState(def.id, st);
      // FR-02: say where to come back to, and offer the way back right here (Home and Help exist in Simple and Advanced)
      const where = def.id === 'firstRun' ? 'continue from Home → Continue setup or Help → Tutorials' : 'continue any time from Settings → Guided set-ups or Help → Tutorials';
      toast(`“${def.title}” paused — ${where}.`, 'info', 9000);
      const at = st.step ?? undefined;
      const t = document.getElementById('toasts')?.lastElementChild as HTMLElement | null;
      if (t) { t.append(' ', button('Continue', () => { t.remove(); openWizard(app, def, { at }); }, 'primary wz-continue')); t.dataset.ui = 'wiz-paused'; }
    }
    else toast(`“${def.title}” done ✓`, 'ok', 3500);
    document.dispatchEvent(new CustomEvent('vtp-wizard', { detail: { id: def.id, finished } }));
  }
  open = { close: () => close(false) };

  document.body.append(back);
  draw(true);
  (card.querySelector('.btn.primary') as HTMLElement | null)?.focus({ preventScroll: true });
}

/** Step helpers */
export const wizHead = (title: string, lead: string | Node) => [h('h2', null, title), h('p', { class: 'lead' }, lead)];
