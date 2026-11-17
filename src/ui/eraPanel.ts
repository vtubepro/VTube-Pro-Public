// Scene tab → "Eras": rooms with scene.json `eras` (the Last Epoch End of Time hub): every few minutes a time crystal
// forms over the stage, cracks, and the world around the performers shifts to another era. On / off, the interval
// (1–15 min), Shift now, and support events (≥ a minimum) that shift time. Host-owned scene state (shared/era.ts), so
// every OBS page and party guest shows the same era at the same moment. ?observer=1 studios only play it in their preview.
import type { App } from '../app.ts';
import { DEFAULT_ERA_STATE, eraAt } from '../../shared/era.ts';
import { button, debounce, h, rerender, section, slider, toggle } from './dom.ts';

export function eraSection(app: App): HTMLElement {
  const S = app.scene;
  const box = h('div');
  const stat = h('p', { class: 'note' });
  const setEvery = debounce((v: number) => S.setEra({ every: v }), 450);
  const render = () => rerender(box, () => {
    const st = S.eraState ?? { ...DEFAULT_ERA_STATE, base: 0 };
    const edit = S.canEdit;
    const list = S.eraList();
    const num = (label: string, title: string, value: number, set: (v: number) => void) => h('label', { class: 'row', title }, h('span', { class: 'lbl' }, label),
      h('input', { type: 'number', min: 0, step: 1, value, disabled: !edit, onChange: (e: Event) => set(Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0)) }));
    const ctl = h('div', null,
      toggle('Era shifts', st.on, (v) => S.setEra({ on: v }), 'Every few minutes a time crystal forms over the stage, cracks, and the world around you shifts to the next era (the stage itself never moves)'),
      slider('Every', st.every, 1, 15, 1, (v) => setEvery(v), 'Minutes between shifts', (v) => `${v} min`, { def: DEFAULT_ERA_STATE.every }),
      toggle('Support events shift time', st.support, (v) => S.setEra({ support: v }), 'A support event (Kicks, Rants, Super Chats, subs …) at or above the minimum shifts to the next era now (at most one every 20 s)'),
      num('From $', 'Minimum USD value of a support event that shifts time (subs / memberships count as $5)', st.min, (v) => S.setEra({ min: v })),
    );
    for (const i of ctl.querySelectorAll('input, select')) if (!edit) (i as HTMLInputElement).disabled = true;
    box.append(
      stat, ctl,
      edit ? h('div', { class: 'btns tight' }, button('⏳ Shift now', () => S.eraShift(), 'primary')) : h('p', { class: 'note' }, 'The host shifts time.'),
      h('p', { class: 'note' }, `Cycle: ${list.map((e) => e.name ?? e.id).join(' → ')} → …`),
      h('p', { class: 'note' }, S.observer ? 'Observer: shifts only play in this preview.' : 'Everyone’s OBS and party guests shift at the same moment. Original homage sets, no game assets.'),
    );
  });
  const renderStat = () => {
    const st = S.eraState;
    const list = S.eraList();
    if (!list.length) { stat.textContent = 'This room has no eras.'; return; }
    if (!st || !st.base) { stat.textContent = `Showing: ${list[0]?.name ?? list[0]?.id}`; return; }
    const m = eraAt(st, list.length, Date.now(), S.eraTiming());
    const cur = list[m.current];
    const nxt = m.next ? Math.max(0, Math.round((m.next - Date.now()) / 1000)) : null;
    stat.textContent = m.shift ? `Shifting: ${list[m.shift.from]?.name} → ${list[m.shift.to]?.name}…` : `Showing: ${cur?.name ?? cur?.id}${nxt !== null ? ` · next shift in ${Math.floor(nxt / 60)}:${String(nxt % 60).padStart(2, '0')}` : ' · shifts off'}`;
  };
  S.on((what) => { if (!box.isConnected) return; if (what === 'state') { render(); renderStat(); } });
  setInterval(() => { if (box.isConnected) renderStat(); }, 1000);
  render();
  renderStat();
  return section('Eras', box);
}
