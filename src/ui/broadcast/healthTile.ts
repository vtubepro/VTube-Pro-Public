// The health tile: ONE plain sentence about how the show is going. The words come only from HEALTH_TEXT through
// healthTileView (no numbers, no units). A fix button appears when the sentence has a one-click fix.
import { h } from '../dom.ts';
import { healthTileView, toneClass } from './view.ts';
import type { FixId, HealthView } from '../../../shared/broadcastTypes.ts';

const MARK: Record<string, string> = { ok: '✓', warn: '!', bad: '×', quiet: '·' };

export function renderHealth(hv: HealthView | null | undefined, o: { canAct: boolean; onFix(fixId: FixId): void }): HTMLElement {
  const v = healthTileView(hv);
  return h('div', { class: `gl-card gl-health ${toneClass(v.tone)}`, 'data-gl': 'health', 'data-health': v.id, role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'gl-mark', 'aria-hidden': 'true' }, MARK[v.tone] ?? '·'),
    h('div', { class: 'body' }, h('b', null, v.title), h('span', { class: 'gl-dim' }, v.say),
      v.fixId && v.fixLabel ? h('div', { class: 'gl-row' }, h('button', { class: 'gl-btn s', type: 'button', 'data-gl': 'health-fix', 'data-fix': v.fixId, disabled: !o.canAct, onClick: () => o.onFix(v.fixId!) }, v.fixLabel)) : null));
}
