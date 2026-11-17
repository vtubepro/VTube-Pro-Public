// Scene tab → "Space battle": the battle outside a ship's viewport (on / off, intensity, frequency, what shows up),
// support events (orbital barrage / threat event, minimum amounts), bridge red alert + camera shake, the cryo join /
// drop-pod leave cinematics and local test buttons. All part of the host's scene state, so every OBS page and party
// guest shows the same battle (src/scene/space/*). ?observer=1 studios only play it in their preview.
import type { App } from '../app.ts';
import { DEFAULT_SPACE_STATE, type SceneSpaceState, type SpaceIntensity, type SpaceToggles } from '../../shared/space.ts';
import { parseRoleStyles, usesStyle } from '../../shared/arrivals.ts';
import { button, debounce, h, rerender, section, select, slider, toggle } from './dom.ts';
import { SPACE_ACT_GROUPS, spaceActOn, spaceActsOf } from '../../shared/space.ts';
import { previewVisible } from './previewFrame.ts';

export function spaceSection(app: App): HTMLElement {
  const S = app.scene;
  const box = h('div');
  const stat = h('p', { class: 'note' });
  const setFreq = debounce((v: number) => S.setSpace({ freq: v }), 450);
  const room = () => S.scenes.find((x) => x.id === S.effective.sceneId);
  const render = () => rerender(box, () => {
    const st: SceneSpaceState = S.effective.space ?? DEFAULT_SPACE_STATE;
    const edit = S.canEdit;
    // the room's own list of acts (scene.json space.acts): only what the room keeps gets a toggle / test button
    const acts = spaceActsOf(room()?.space);
    const keeps = (...k: string[]) => k.some((x) => spaceActOn(acts, x));
    const show = (k: keyof SpaceToggles, label: string, hint: string, ...need: string[]) => (keeps(...need) ? toggle(label, st.show[k], (v) => S.setSpace({ show: { ...st.show, [k]: v } }), hint) : null);
    const battle = h('div', null,
      toggle('Space battle', st.on, (v) => S.setSpace({ on: v }), 'Fighters, warps, barrages and lasers outside the viewport (off = only the planet, the stars and the parked fleet)'),
      select<SpaceIntensity>('Intensity', st.intensity, [['chill', 'Chill (the odd patrol and flyby)'], ['normal', 'Normal'], ['hot', 'Hot (full-scale war)']], (v) => S.setSpace({ intensity: v })),
      slider('Frequency', st.freq, 0.25, 3, 0.05, (v) => setFreq(v), 'How often something happens (× the intensity’s pace)', (v) => `${v.toFixed(2)}×`, { def: DEFAULT_SPACE_STATE.freq }),
      show('fighters', 'Fighters & dropships', 'Patrols, formation flybys past the glass, dogfights with tracers, strafing runs, Pelican shuttles', ...SPACE_ACT_GROUPS.fighters),
      show('warps', 'Warp jumps', 'Friendly ships jump in and out (stretch, flash, tunnel lines)', 'warp'),
      show('barrages', 'Orbital barrages', 'Destroyers shell the planet: impacts bloom on the surface seconds later', 'barrage'),
      show('lasers', 'Orbital lasers', 'A beam from orbit burns a scar across the surface', 'laser'),
      show('threats', 'Threat events', 'Now and then an enemy dreadnought warps in close, charges its gun at YOUR ship, and gets torn apart', 'threat'),
      show('planet', 'Combat on the planet', 'Artillery flashes, fires, tracers, dropship lights and hellbombs on the surface', 'planet', 'hellbomb'),
      acts ? h('p', { class: 'note' }, `This room keeps only: ${[...acts].join(', ') || 'nothing'} (scene.json space.acts).`) : null,
    );
    const bridge = h('div', null,
      toggle('Red alert on the bridge', st.alert, (v) => S.setSpace({ alert: v }), 'During a threat the bridge lights pulse red (slow, under 1 Hz)'),
      toggle('Camera shake on explosions', st.shake, (v) => S.setSpace({ shake: v }), 'Never in React mode'),
    );
    const num = (label: string, title: string, value: number, set: (v: number) => void) => h('label', { class: 'row', title }, h('span', { class: 'lbl' }, label),
      h('input', { type: 'number', min: 0, step: 1, value, disabled: !edit, onChange: (e: Event) => set(Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0)) }));
    const sup = h('div', null,
      toggle('Support events call in the fleet', st.support, (v) => S.setSpace({ support: v }), 'A support event (Kicks, Rants, Super Chats, subs …) triggers an orbital barrage with the supporter’s name; bigger ones a threat event'),
      keeps('barrage') ? num('Barrage from $', 'Minimum USD value for an orbital barrage (subs / memberships count as $5)', st.min, (v) => S.setSpace({ min: v })) : null,
      keeps('threat') ? num('Threat event from $', 'Minimum USD value for a threat event (0 = never)', st.threatMin, (v) => S.setSpace({ threatMin: v })) : null,
    );
    const info = room();
    const moves = h('div', null,
      toggle('Cryo-pod join', st.cryo, (v) => S.setSpace({ cryo: v }), usesStyle(parseRoleStyles(info?.exit), 'cryo') ? 'Cryo pods: people who are away wait frozen in a pod, thaw out to join, and leave by walking back into one that frosts over (off = the normal walk-in / walk-out)' : usesStyle(parseRoleStyles(info?.entrance), 'cryo') ? 'People who join thaw out of a cryo pod and walk to the bridge (off = the normal walk-in)' : 'This room has no cryo bay'),
      toggle('Drop-pod leave', st.droppod, (v) => S.setSpace({ droppod: v }), usesStyle(parseRoleStyles(info?.exit), 'droppod') ? 'People who leave board a drop pod and are fired at the planet; watch the re-entry from the bridge' : 'This room has no drop-pod bay'),
      h('p', { class: 'note' }, '“Camera follows my entrance” (Mode & camera) also follows the thaw, and the drop pod out to the viewport.'),
    );
    const t = (k: string, label: string, primary = false) => button(label, () => S.spaceEvent(k, k === 'barrage' || k === 'threat' ? { user: 'Test Supporter', amount: '$10.00' } : {}), primary ? 'primary' : '');
    const tests = h('div', { class: 'btns tight' }, ...([['threat', '⚠ Test threat', true], ['barrage', '💥 Test barrage'], ['warp', '✦ Test warp'], ['laser', '☄ Test laser'], ['flyby', '✈ Flyby'], ['dogfight', '⚔ Dogfight'], ['strafe', '⤓ Strafing run'], ['hellbomb', '☢ Hellbomb']] as [string, string, boolean?][])
      .filter(([k]) => keeps(k)).map(([k, label, primary]) => t(k, label, primary)));
    for (const el of [battle, bridge, sup, moves]) for (const i of el.querySelectorAll('input, select')) if (!edit) (i as HTMLInputElement).disabled = true;
    box.append(
      stat,
      battle,
      h('h4', { style: 'margin:10px 0 4px' }, 'Bridge'), bridge,
      h('h4', { style: 'margin:10px 0 4px' }, 'Support events'), sup,
      h('h4', { style: 'margin:10px 0 4px' }, 'Join / leave'), moves,
      h('h4', { style: 'margin:10px 0 4px' }, 'Test'), edit ? tests : h('p', { class: 'note' }, 'The host runs the battle.'),
      h('p', { class: 'note' }, S.observer ? 'Observer: tests only play in this preview.' : 'Everyone’s OBS and party guests see the same battle. Original homage ships, no game assets.'),
    );
  });
  const renderStat = () => {
    const st: SceneSpaceState = S.effective.space ?? DEFAULT_SPACE_STATE;
    // (only a preview the user can see counts as live: the hidden room-analysis preview's one report is not — review round 1)
    const r = previewVisible() ? S.report?.space ?? null : null;
    const roomOk = S.report?.room?.id === S.effective.sceneId;
    stat.textContent = !S.effective.sceneId ? 'Pick a room first.'
      : !roomOk || !r ? (room()?.space ? 'Turn the preview on to see the battle numbers.' : 'This room has no viewport onto space (no SPACE_* anchors).')
        : `This room: ${r.space ? 'space battle ✓' : 'no SPACE_* anchors'} · ${r.cryo ? `${r.cryo} cryo pods ✓` : 'no cryo bay'} · ${r.droppod ? `${r.droppod} drop pods ✓` : 'no drop pods'}${r.active ? ` · ${r.active} on now` : ''}${r.next !== null && st.on ? ` · next threat in ~${r.next}s` : ''}${r.ms ? ` · ${r.ms} ms/frame` : ''}${r.level ? ` · reduced (${r.level})` : ''}`;
  };
  S.on((what) => { if (!box.isConnected) return; if (what === 'state') { render(); renderStat(); } else if (what === 'report') renderStat(); });
  render();
  renderStat();
  return section('Space battle', box);
}
