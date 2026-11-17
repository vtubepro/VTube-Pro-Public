// "Check my setup": green / amber / red rows in plain words, each with its own one-click fix button.
import { h } from '../dom.ts';
import { preflightView, toneClass } from './view.ts';
import type { FixId, PreflightReport } from '../../../shared/broadcastTypes.ts';

const MARK: Record<string, string> = { check: '✓', warn: '!', cross: '×', dot: '?' };

export interface PreflightOpts {
  report: PreflightReport | null;
  /** A check is running. */
  running: boolean;
  canAct: boolean;
  onCheck(): void;
  onFix(fixId: FixId): void;
  onAccept(): void;
  /** The 10 second private test (null = not offered). */
  onTest: ((ev: MouseEvent) => void) | null;
}

export function renderPreflight(o: PreflightOpts): HTMLElement {
  const v = preflightView(o.report);
  const head = h('div', { class: 'gl-head' }, h('h3', null, 'Check my setup'),
    h('button', { class: 'gl-btn s', type: 'button', 'data-gl': 'check', disabled: o.running || !o.canAct, onClick: () => o.onCheck() }, o.running ? 'Checking…' : o.report ? 'Check again' : 'Check my setup'));
  const summary = h('div', { class: `gl-row ${toneClass(v.tone)}`, role: 'status', 'data-gl': 'preflight-summary', 'data-verdict': o.report?.verdict ?? 'none' },
    o.report ? h('span', { class: 'gl-mark', 'aria-hidden': 'true' }, v.tone === 'ok' ? '✓' : v.tone === 'bad' ? '×' : '!') : null,
    h('div', { class: 'gl-grow' }, h('b', null, v.headline), h('div', { class: 'gl-dim gl-small' }, v.sub)));
  const rows = v.rows.length ? h('ul', { class: 'gl-rows', 'aria-label': 'Setup check results' }, ...v.rows.map((r) =>
    h('li', { class: `gl-prow ${toneClass(r.tone)}`, 'data-row': r.id, 'data-status': r.status },
      h('span', { class: 'gl-mark', 'aria-hidden': 'true' }, MARK[r.mark] ?? '?'),
      h('div', { class: 't' }, h('b', null, r.title), h('span', null, r.say)),
      r.fixId && r.fixLabel ? h('button', { class: 'gl-btn s', type: 'button', 'data-gl': 'fix', 'data-fix': r.fixId, disabled: !o.canAct, onClick: () => o.onFix(r.fixId!) }, r.fixLabel) : null))) : null;
  const actions = v.showAccept || o.onTest ? h('div', { class: 'gl-row' },
    v.showAccept ? h('button', { class: 'gl-btn warn', type: 'button', 'data-gl': 'accept', disabled: !o.canAct, onClick: () => o.onAccept() }, 'Go live anyway with the yellow items') : null,
    o.onTest ? h('button', { class: 'gl-btn s', type: 'button', 'data-gl': 'dryrun', disabled: !o.canAct, onClick: (ev: MouseEvent) => o.onTest!(ev) }, 'Try a 10 second private test') : null) : null;
  return h('section', { class: 'gl-card', 'data-gl': 'preflight', 'aria-label': 'Check my setup' }, head, summary, rows, actions);
}
