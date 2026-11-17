// Tutorials: the hub. Every tutorial as a big card, grouped (Start here · Your look · Your show · Make things), with
// where you got to (New · Step 3 of 7 · Done), Start / Continue / Start over, and "Read it instead" (the written guide,
// docs/TUTORIALS.md). Opened from Help → Tutorials, the Tools menu and Home's Tools row. Esc / × / a click outside close it.
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { TUTORIALS, TUT_GROUPS } from './catalog.ts';
import { progressOf } from './progress.ts';
import { injectCss, startTutorial, stepsFor } from './engine.ts';
import type { Tutorial } from './types.ts';
import { slugify } from '../../../shared/markdown.ts';

let hubEl: HTMLElement | null = null;
export const hubOpen = () => !!hubEl;

/** Website anchor of a tutorial in docs/TUTORIALS.md (its "## <title>" heading, GitHub slug). */
export const tutAnchor = (t: Tutorial) => slugify(t.title);

export function openHub(o: { guide(target: string): void }) {
  if (hubEl) return;
  injectCss();
  if (!document.getElementById('vtp-tuhub-css')) document.head.append(h('style', { id: 'vtp-tuhub-css' }, CSS));
  const prev = document.activeElement as HTMLElement | null;
  const close = () => {
    if (!hubEl) return;
    const el = hubEl; hubEl = null;
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 160);
    window.removeEventListener('keydown', onKey, true);
    prev?.focus?.();
  };
  const begin = (t: Tutorial, restart: boolean) => { close(); window.setTimeout(() => startTutorial(t.id, { restart }), 120); };
  const cardOf = (t: Tutorial, i: number) => {
    const p = progressOf(t.id);
    const n = stepsFor(t).length;
    const going = !p.done && p.step > 0 && p.step < n;
    const badge = p.done ? h('span', { class: 'tuh-badge done' }, icon('check', 12), 'Done') : going ? h('span', { class: 'tuh-badge going' }, `Step ${p.step + 1} of ${n}`) : h('span', { class: 'tuh-badge' }, `${n} steps · about ${t.minutes} min`);
    return h('article', { class: `tuh-card${p.done ? ' done' : ''}`, 'data-tutorial': t.id, style: `--i:${i}` },
      h('span', { class: 'tuh-ic', 'aria-hidden': 'true' }, icon(t.icon, 26)),
      h('div', { class: 'tuh-words' }, h('b', null, t.title), h('span', null, t.blurb), badge),
      h('div', { class: 'tuh-acts' },
        h('button', { class: 'btn primary', type: 'button', onClick: () => begin(t, false) }, going ? 'Continue' : p.done ? 'Do it again' : 'Start'),
        going ? h('button', { class: 'btn ghost', type: 'button', onClick: () => begin(t, true) }, 'Start over') : null,
        h('button', { class: 'tuh-read', type: 'button', title: 'The same steps as a page to read', onClick: () => { close(); o.guide(`TUTORIALS.md#${tutAnchor(t)}`); } }, 'Read it instead')));
  };
  let i = 0;
  const groups = TUT_GROUPS.map((g) => ({ g, ts: TUTORIALS.filter((t) => t.group === g) })).filter((x) => x.ts.length);
  const done = TUTORIALS.filter((t) => progressOf(t.id).done).length;
  const dialog = h('div', { class: 'tuh', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tuh-t', tabindex: -1, 'data-ui': 'tutorials-hub' },
    h('div', { class: 'tuh-head' },
      h('div', null, h('p', { class: 'tu-eyebrow' }, 'Tutorials'), h('h1', { id: 'tuh-t' }, 'Learn it step by step'),
        h('p', { class: 'tuh-lead' }, 'We point at the right button and wait while you do it. Stop any time: we remember where you were.')),
      h('button', { class: 'tu-x', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', onClick: () => close() }, icon('x', 18))),
    done ? h('p', { class: 'tuh-score' }, `${done} of ${TUTORIALS.length} done`) : null,
    ...groups.map(({ g, ts }) => h('section', { class: 'tuh-group' }, h('h2', null, g), h('div', { class: 'tuh-grid' }, ...ts.map((t) => cardOf(t, i++))))));
  hubEl = h('div', { class: 'tuh-back', onClick: (e: Event) => { if (e.target === hubEl) close(); } }, dialog);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);
  document.body.append(hubEl);
  dialog.focus({ preventScroll: true });
}

const CSS = `
.tuh-back { position: fixed; inset: 0; z-index: 88; display: grid; place-items: center; padding: 24px; background: #05070bcc; backdrop-filter: blur(5px); animation: tu-fade 200ms ease both; }
.tuh-back.out { animation: tu-fade 150ms ease reverse both; }
.tuh { width: min(980px, 100%); max-height: calc(100vh - 48px); overflow: auto; overscroll-behavior: contain; background: var(--panel); color: var(--text); border: 1px solid var(--line2); border-radius: 22px; padding: 26px 28px 24px; box-shadow: 0 40px 120px -30px #000c, inset 0 1px 0 #ffffff12; }
html .tuh-back .tuh:is(:focus, :focus-visible) { outline: none !important; box-shadow: 0 40px 120px -30px #000c, inset 0 1px 0 #ffffff12 !important; }
.tuh-head { display: flex; align-items: flex-start; gap: 12px; }
.tuh-head > div { flex: 1; }
.tuh h1 { margin: 8px 0 4px; font: 750 clamp(24px, 3vw, 32px)/1.1 var(--font-display, system-ui); letter-spacing: -.02em; }
.tuh-lead { margin: 0; color: var(--dim); font-size: 15px; }
.tuh-score { margin: 12px 0 0; font-size: 13px; color: var(--accent); font-weight: 650; }
.tuh-group { margin-top: 20px; }
.tuh-group h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); }
.tuh-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.tuh-card { display: grid; grid-template-columns: auto 1fr; grid-template-rows: 1fr auto; gap: 6px 14px; padding: 16px; border-radius: 16px; border: 1px solid var(--line2); background: var(--card); }
.tuh-card.done { border-color: color-mix(in srgb, var(--accent) 35%, var(--line2)); }
.tuh-ic { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
.tuh-words b { display: block; font: 700 16.5px/1.25 var(--font-display, system-ui); }
.tuh-words > span { display: block; margin-top: 4px; color: var(--dim); font-size: 13.5px; line-height: 1.45; }
.tuh-badge { display: inline-flex !important; align-items: center; gap: 4px; margin-top: 8px !important; font-size: 11.5px !important; color: var(--faint) !important; }
.tuh-badge.going { color: var(--warn) !important; font-weight: 650; }
.tuh-badge.done { color: var(--accent) !important; font-weight: 650; }
.tuh-acts { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
.tuh-acts .btn { min-height: 34px; border-radius: 10px; padding: 5px 14px; }
.tuh-read { border: 0; background: none; color: var(--accent2, var(--accent)); font: inherit; font-size: 12.5px; cursor: pointer; padding: 4px 2px; margin-left: auto; }
.tuh-read:hover { text-decoration: underline; }
@media (max-width: 600px) { .tuh-back { padding: 10px; } .tuh { padding: 18px 16px; border-radius: 18px; max-height: calc(100vh - 20px); } .tuh-grid { grid-template-columns: 1fr; } .tuh-card { grid-template-columns: 1fr; } .tuh-ic { display: none; } .tuh-acts { grid-column: 1; } }
`;
