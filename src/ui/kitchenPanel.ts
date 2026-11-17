// Scene tab → "Kitchen" (rooms with KITCHEN_* anchors, e.g. the fast-food room): the crew on / off, random food
// fights (+ frequency), donations → the unrest meter (riot threshold, cool-down), the riot camera, and test buttons.
// All of it is host scene state, so every OBS page and party guest sees the same kitchen (src/scene/kitchen/*).
import type { App } from '../app.ts';
import { DEFAULT_KITCHEN_STATE, kitchenUnrestAt, type SceneKitchenState } from '../../shared/kitchen.ts';
import { button, debounce, h, rerender, section, slider, toggle } from './dom.ts';
import { previewVisible } from './previewFrame.ts';

export function kitchenSection(app: App): HTMLElement {
  const S = app.scene;
  const box = h('div');
  const stat = h('p', { class: 'note' });
  const setFreq = debounce((v: number) => S.setKitchen({ freq: v }), 450);
  const num = (label: string, value: number, min: number, step: number, set: (v: number) => void, title: string) =>
    h('label', { class: 'row', title }, h('span', { class: 'lbl' }, label),
      h('input', { type: 'number', min, step, value, disabled: !S.canEdit, onChange: (e: Event) => set(Math.max(min, parseFloat((e.target as HTMLInputElement).value) || min)) }));
  const render = () => rerender(box, () => {
    const st: SceneKitchenState = S.effective.kitchen ?? DEFAULT_KITCHEN_STATE;
    const edit = S.canEdit;
    const crew = h('div', null,
      toggle('Frog crew working', st.on, (v) => S.setKitchen({ on: v }), 'The Sprocket crew works the grill, fries, bags and drinks behind the counter (never in front of you or the react screen)'),
      toggle('Random food fights', st.fights, (v) => S.setKitchen({ fights: v }), 'Every few minutes a frog snaps and starts a food fight; the manager kicks the office door open, yells and punts frogs across the kitchen, then they mop up'),
      slider('Fight frequency', st.freq, 0.25, 3, 0.05, (v) => setFreq(v), 'How often a random food fight starts (1× ≈ one every 4 minutes)', (v) => `${v.toFixed(2)}×`, { def: DEFAULT_KITCHEN_STATE.freq }));
    const money = h('div', null,
      toggle('Donations feed the unrest meter', st.donations, (v) => S.setKitchen({ donations: v }), 'Each donation (subs / memberships count as $5) makes a frog seethe and fills the FROG UNREST meter. Halfway: a food fight. At the top: a RIOT, until the freezer guy pacifies them'),
      num('Riot at $', st.riotAt, 1, 5, (v) => S.setKitchen({ riotAt: v }), 'Total donations (USD value) that fill the meter and start a riot'),
      num('Cool-down $/min', st.decay, 0, 0.25, (v) => S.setKitchen({ decay: v }), 'How fast the meter drains by itself (0 = never)'),
      toggle('Riots take over the camera', st.riotCam, (v) => S.setKitchen({ riotCam: v }), 'During a riot the camera cuts to the kitchen / freezer / riot cameras, then back (never during React)'));
    const tests = h('div', { class: 'btns tight' },
      button('🍔 Test food fight', () => S.kitchenEvent('foodfight'), 'primary'),
      button('👔 Test manager', () => S.kitchenEvent('manager')),
      button('🚨 Test RIOT', () => S.kitchenEvent('riot', { user: 'Test Supporter', amount: '$50.00' })),
      button('💵 Test $5 donation', () => S.kitchenSupport(5, 'Test Supporter', '$5.00')),
      button('🧊 Calm them down', () => S.setKitchen({ unrest: 0, unrestAt: Date.now() })));
    for (const el of [crew, money]) for (const i of el.querySelectorAll('input, select')) if (!edit) (i as HTMLInputElement).disabled = true;
    box.append(stat, h('h4', { style: 'margin:10px 0 4px' }, 'Crew'), crew, h('h4', { style: 'margin:10px 0 4px' }, 'Unrest meter'), money,
      h('h4', { style: 'margin:10px 0 4px' }, 'Test'), edit ? tests : h('p', { class: 'note' }, 'The host runs the kitchen.'),
      h('p', { class: 'note' }, S.observer ? 'Observer: tests only play in this preview.' : 'Everyone’s OBS and party guests see the same kitchen.'));
  });
  const renderStat = () => {
    const st: SceneKitchenState = S.effective.kitchen ?? DEFAULT_KITCHEN_STATE;
    // (only a preview the user can see counts as live: the hidden room-analysis preview's one report is not — review round 1)
    const k = previewVisible() ? S.report?.kitchen ?? null : null;
    const u = kitchenUnrestAt(st, Date.now());
    const roomOk = S.report?.room?.id === S.effective.sceneId;
    stat.textContent = !S.effective.sceneId ? 'Pick a room first.' : !roomOk || !k ? `Unrest $${u.toFixed(2)} / $${st.riotAt}. Turn the preview on to see the crew.`
      : `${k.room ? `${k.frogs} frogs on shift` : 'This room has no kitchen'}${k.episode ? ` · ${k.episode.kind === 'riot' ? '🚨 RIOT' : k.episode.kind === 'manager' ? '👔 inspection' : '🍔 food fight'} (${Math.round(k.episode.t)}/${Math.round(k.episode.dur)}s)` : ''}${k.next ? ` · next ${k.next.kind} in ~${k.next.in}s` : ''} · unrest $${u.toFixed(2)} / $${st.riotAt}`;
  };
  S.on((what) => { if (!box.isConnected) return; if (what === 'state') { render(); renderStat(); } else if (what === 'report') renderStat(); });
  setInterval(() => { if (box.isConnected) renderStat(); }, 2000);
  render();
  renderStat();
  return section('Kitchen', box);
}
