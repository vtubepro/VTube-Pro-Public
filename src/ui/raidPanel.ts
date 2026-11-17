// Scene tab → "Raid": background combat (on / off, intensity, frequency, factions), the donation event (Tagilla in
// Factory: on / min amount / camera shake) and local test buttons. All of it is part of the host's scene state, so every
// OBS page and party guest shows the same fight (src/scene/raid/*). ?observer=1 studios only play it in their preview.
import type { App } from '../app.ts';
import { DEFAULT_RAID_STATE, RAID_FACTIONS, RAID_FACTION_LABELS, type RaidFaction, type RaidIntensity, type SceneRaidState } from '../../shared/raid.ts';
import { button, debounce, h, rerender, section, select, slider, toggle } from './dom.ts';
import { previewVisible } from './previewFrame.ts';

export function raidSection(app: App): HTMLElement {
  const S = app.scene;
  const box = h('div');
  const stat = h('p', { class: 'note' });
  const setFreq = debounce((v: number) => S.setRaid({ freq: v }), 450);
  const render = () => rerender(box, () => {
    const st: SceneRaidState = S.effective.raid ?? DEFAULT_RAID_STATE;
    const edit = S.canEdit;
    const facs = st.factions ?? null;
    const roomFacs = (S.scenes.find((x) => x.id === S.effective.sceneId)?.raid?.factions ?? ['usec', 'bear', 'scav']) as RaidFaction[];
    const facToggle = (f: RaidFaction) => toggle(RAID_FACTION_LABELS[f], (facs ?? roomFacs).includes(f), (v) => {
      const cur = new Set<RaidFaction>(facs ?? roomFacs);
      if (v) cur.add(f); else cur.delete(f);
      S.setRaid({ factions: cur.size ? RAID_FACTIONS.filter((x) => cur.has(x)) : null });
    }, facs ? undefined : 'Room default right now (the room decides who shows up) — ticking a box sets your own list');
    const fight = h('div', null,
      toggle('Background skirmishes', st.on, (v) => S.setRaid({ on: v }), 'Soldiers fight in the background zones of the room (never in front of you or the react screen)'),
      select<RaidIntensity>('Intensity', st.intensity, [['chill', 'Chill (1v1 / 1v2, rare)'], ['normal', 'Normal (2v2 – 3v2)'], ['hot', 'Hot raid (up to 4v4, often)']], (v) => S.setRaid({ intensity: v })),
      slider('Frequency', st.freq, 0.25, 3, 0.05, (v) => setFreq(v), 'How often a skirmish starts (× the intensity’s pace)', (v) => `${v.toFixed(2)}×`, { def: DEFAULT_RAID_STATE.freq }),
      h('div', { class: 'note', style: 'margin:6px 0 2px' }, facs ? 'Factions:' : 'Factions (room default):'),
      // (the warzone pack's frogs / militia only where the room uses them or they were picked)
      ...RAID_FACTIONS.filter((f) => !(f === 'frog' || f === 'militia') || roomFacs.includes(f) || (facs ?? []).includes(f)).map(facToggle),
      facs ? h('div', { class: 'btns tight' }, button('Use the room’s factions', () => S.setRaid({ factions: null }))) : null,
    );
    const tag = h('div', null,
      toggle('Tagilla on donations', st.tagilla, (v) => S.setRaid({ tagilla: v }), 'Support events summon the room’s donation event: in Factory the masked brute bursts in and smashes something'),
      h('label', { class: 'row', title: 'Minimum USD value (Kicks / Jewels at payout value; subs / memberships count as $5 each)' }, h('span', { class: 'lbl' }, 'Min amount $'),
        h('input', { type: 'number', min: 0, step: 1, value: st.min, disabled: !edit, onChange: (e: Event) => S.setRaid({ min: Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0) }) })),
      toggle('Camera shake on the hit', st.shake, (v) => S.setRaid({ shake: v })),
      toggle('Big donations interrupt the stream', st.bigOn ?? true, (v) => S.setRaid({ bigOn: v }), 'A big donation brings him in even during React: the screen winches up, the camera cuts to him, he smashes a prop and roars the supporter\u2019s name, then React resumes where it was'),
      h('label', { class: 'row', title: 'Minimum USD value for the interrupt (other currencies at their USD value)' }, h('span', { class: 'lbl' }, 'Big donation $'),
        h('input', { type: 'number', min: 1, step: 5, value: st.bigMin ?? 100, disabled: !edit, onChange: (e: Event) => S.setRaid({ bigMin: Math.max(1, parseFloat((e.target as HTMLInputElement).value) || 100) }) })),
    );
    const tests = h('div', { class: 'btns tight' },
      button('🔨 Test Tagilla', () => S.raidEvent('tagilla', { user: 'Test Supporter', amount: '$10.00' }), 'primary'),
      button('🚨 Test big donation', () => S.raidEvent('donation', { user: 'Test Supporter', amount: `$${(S.effective.raid?.bigMin ?? 100).toFixed(2)}`, big: true })),
      button('⚔ Test skirmish', () => S.raidEvent('skirmish')),
      button('👑 Test patrol', () => S.raidEvent('patrol')),
      button('💥 Test ambush', () => S.raidEvent('ambush')));
    const cams = h('div', null,
      toggle('Preshow: show the raid', st.preshowCam, (v) => S.setRaid({ preshowCam: v }), 'During the PRESHOW lighting state the camera cuts between your shots and the fight (the room\u2019s CAM_RAID_xx cameras, else an automatic telephoto)'),
      toggle('…and during BRB', st.preshowBrb, (v) => S.setRaid({ preshowBrb: v })));
    // warzone rooms (scene.json `warzone`): calm + the set pieces (src/scene/warzone/*)
    const wz = !!(S.scenes.find((x) => x.id === S.effective.sceneId) as unknown as { warzone?: unknown } | undefined)?.warzone;
    const war = wz ? h('div', null,
      toggle('Calm (I’m talking)', st.calm === true, (v) => S.setRaid({ calm: v }), 'No new shells, RPGs, vehicles or strikes start and nothing shakes inside; the far fighting, fires and flares go on. Supporters’ set pieces still play'),
      h('div', { class: 'btns tight' },
        ...([['wz_airstrike', '✈ Air strike'], ['wz_armor', '🛡 Armoured push'], ['wz_assault', '⚔ Assault'], ['wz_technical', '🛻 Technical'], ['wz_mortar', '💥 Mortars'], ['wz_heli', '🚁 Gunship'], ['wz_flare', '✨ Flares'], ['wz_sniper', '🎯 Sniper']] as const)
          .map(([k, l]) => button(l, () => S.raidEvent(k, { user: 'Test Supporter', amount: '$25.00' })))),
      h('p', { class: 'note' }, 'Donations buy set pieces by amount (mortars → technical → gunship → armour → assault; big donations = air strike). Stream Deck: “Warzone set piece”, “Calm the battle”. Channel-point rewards: name them “Air Strike”, “Tank Push”, “Mortar”, “Gunship”, “Flare”, “Sniper”, “Technical”, “Assault”.')) : null;
    for (const el of [fight, tag, cams]) for (const i of el.querySelectorAll('input, select')) if (!edit) (i as HTMLInputElement).disabled = true;
    box.append(
      stat,
      h('h4', { style: 'margin:10px 0 4px' }, 'Background combat'), fight,
      ...(war && edit ? [h('h4', { style: 'margin:10px 0 4px' }, 'Warzone'), war] : []),
      h('h4', { style: 'margin:10px 0 4px' }, 'Camera'), cams,
      h('h4', { style: 'margin:10px 0 4px' }, 'Donation event'), tag,
      h('h4', { style: 'margin:10px 0 4px' }, 'Test'), edit ? tests : h('p', { class: 'note' }, 'The host runs the raid.'),
      h('p', { class: 'note' }, S.observer ? 'Observer: tests only play in this preview.' : 'Everyone’s OBS and party guests see the same fight. Original homage characters — no game assets.'),
    );
  });
  const renderStat = () => {
    const st: SceneRaidState = S.effective.raid ?? DEFAULT_RAID_STATE;
    // (only a preview the user can see counts as live: the hidden room-analysis preview's one report is not — review round 1)
    const r = previewVisible() ? S.report?.raid ?? null : null;
    const roomOk = S.report?.room?.id === S.effective.sceneId;
    // (clarity: the room list already knows which rooms have a raid; there is no preview in Chat & events)
    const info = S.effective.sceneId ? S.scenes.find((x) => x.id === S.effective.sceneId) : null;
    stat.textContent = !S.effective.sceneId ? 'Pick a room first (Classic has no background).'
      : info && !info.raid ? 'This room has no raid. Raids only play in rooms built for them.'
      : !roomOk || !r ? 'Open Room or Show & layout with the preview on to load this room’s details.'
        : `This room: ${r.fight ? 'background fights ✓' : 'no background fights'} · ${r.tagilla ? 'Tagilla event ✓' : 'no Tagilla event'}${r.patrol ? ' · boss patrol ✓' : ''}${r.raidCams ? ` · ${r.raidCams} raid cameras` : ''}${r.director ? ' · 🎥 on the raid' : ''}${r.active ? ` · ${r.active} on screen now` : ''}${r.next !== null && st.on ? ` · next skirmish in ~${r.next}s` : ''}${r.ms ? ` · ${r.ms} ms/frame` : ''}`;
  };
  S.on((what) => { if (!box.isConnected) return; if (what === 'state') { render(); renderStat(); } else if (what === 'report') renderStat(); });
  render();
  renderStat();
  return section('Raid', box);
}
