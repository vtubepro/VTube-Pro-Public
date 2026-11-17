// Scene tab → "Club" (rooms with a scene.json `club` key, e.g. the Studio Club): where the host is (the DJ booth or
// the balcony — taking the balcony plays the entrance camera), the background bits (on / how often), the DJ pose,
// sounds, the big-donation line, and test buttons for every bit and every celebration. All host scene state
// (shared/club.ts), so every OBS page and party guest sees the same club (src/scene/club/*).
import type { App } from '../app.ts';
import { CLUB_BITS, CLUB_BIT_LABELS, CLUB_CELEBRATIONS, CLUB_CELEBRATION_LABELS, DEFAULT_CLUB_STATE, sanitizeClubState } from '../../shared/club.ts';
import { button, debounce, h, rerender, section, slider, toggle } from './dom.ts';
import { forScripts } from './forScripts.ts';
import { canonStyleId, styleById } from '../../shared/lightStyles.ts';

const ICON: Record<string, string> = { crowdsurf: '🙌', danceoff: '🕺', conga: '🐸', proposal: '💍', stagefall: '🤕', juggle: '🍾', bouncer: '🚪', mirrorball: '🪩', drop: '💥', bartrick: '🍹',
  tip: '🎉', sub: '💨', bits: '📯', raid: '🎆', big: '🥂' };

export function clubSection(app: App): HTMLElement {
  const S = app.scene;
  const box = h('div');
  const setFreq = debounce((v: number) => S.setClub({ freq: v }), 450);
  const render = () => rerender(box, () => {
    const st = S.effective.club ? sanitizeClubState(S.effective.club) : DEFAULT_CLUB_STATE;
    const edit = S.canEdit;
    const seat = S.effective.spots['@host'];
    const info = S.scenes.find((x) => x.id === S.effective.sceneId) as unknown as { club?: { djSpot?: string; balconySpot?: string } } | undefined;
    const idx = (n: string | undefined, d: number) => { const m = /(\d+)$/.exec(n ?? ''); return m ? +m[1] - 1 : d; };
    const dj = idx(info?.club?.djSpot, 0), balc = idx(info?.club?.balconySpot, 2);
    const where = seat === dj ? 'at the decks' : seat === balc ? 'on the balcony' : `at spot ${(seat ?? 0) + 1}`;
    const sug = canonStyleId((info as unknown as { suggestedStyle?: string } | undefined)?.suggestedStyle ?? 'neon_rave');
    const area = h('div', { class: 'btns tight' },
      button('🎧 DJ booth', () => S.clubArea('dj'), seat === dj ? 'primary' : ''),
      button('🌃 Take the balcony (entrance)', () => S.clubArea('balcony'), seat === balc ? 'primary' : ''),
      S.effective.lights.style === sug ? h('span') : button(`🪩 Club lights (${styleById(sug)?.name ?? sug.replace(/_/g, ' ')})`, () => S.setLights({ style: sug })));
    const opts = h('div', null,
      toggle('Background bits', st.bits, (v) => S.setClub({ bits: v }), 'Crowd-surfers, dance-offs, conga lines, a proposal, stage falls, bottle juggling, the bouncer, mirror-ball moments, drops, rounds of drinks — on a shared schedule every page plays the same'),
      slider('How often', st.freq, 0.25, 3, 0.05, (v) => setFreq(v), '1× ≈ one bit every 50 s', (v) => `${v.toFixed(2)}×`, { def: DEFAULT_CLUB_STATE.freq }),
      toggle('DJ hands on the decks', st.djHands, (v) => S.setClub({ djHands: v }), 'At the DJ booth your arms play the decks (scratching, faders, a headphone to the ear, fists up on drops). Face, head and expressions stay tracked; off = your tracked arms'),
      toggle('Entrance camera', st.entranceCam, (v) => S.setClub({ entranceCam: v }), 'Your walk from the booth to the balcony is filmed like a music video and ends with the sweeping reveal of the club behind you'),
      toggle('Club sounds', st.sound, (v) => S.setClub({ sound: v }), 'The air horn (bits / Kicks) and the raid bass drop play in this studio (Audio mixer → Room sounds), never on the OBS page'),
      h('label', { class: 'row', title: 'A tip / donation at or above this (USD value) gets the champagne tower + confetti storm + a sign with the name' }, h('span', { class: 'lbl' }, 'Big donation from $'),
        h('input', { type: 'number', min: 1, step: 5, value: st.bigMin, disabled: !edit, onChange: (e: Event) => S.setClub({ bigMin: Math.max(1, parseFloat((e.target as HTMLInputElement).value) || 50) }) })));
    const bits = h('div', { class: 'btns tight' }, ...CLUB_BITS.map((k) => button(`${ICON[k] ?? ''} ${CLUB_BIT_LABELS[k]}`, () => S.clubEvent(k))));
    const cel = h('div', { class: 'btns tight' }, ...CLUB_CELEBRATIONS.map((k) => {
      const b = button(`${ICON[k]} ${k === 'big' ? 'Big donation' : k[0].toUpperCase() + k.slice(1)}`, () => S.clubEvent(k, { user: 'Test Supporter', usd: k === 'big' ? Math.max(100, st.bigMin) : 10 }));
      b.title = CLUB_CELEBRATION_LABELS[k]; return b;
    }));
    for (const i of opts.querySelectorAll('input, select')) if (!edit) (i as HTMLInputElement).disabled = true;
    box.append(
      h('p', { class: 'note' }, `The host is ${where}. Real tips, subs, Kicks / Jewels and raids from chat trigger the celebrations by themselves.`),
      edit ? area : h('span'),
      h('h4', { style: 'margin:10px 0 4px' }, 'Options'), opts,
      h('h4', { style: 'margin:10px 0 4px' }, 'Test a bit'), edit ? bits : h('p', { class: 'note' }, 'The host runs the club.'),
      h('h4', { style: 'margin:10px 0 4px' }, 'Test a celebration'), edit ? cel : h('span'),
      h('p', { class: 'note' }, S.observer ? 'Observer: tests only play in this preview.' : 'Everyone’s OBS and party guests see the same club.'),
      forScripts('Stream Deck: POST /api/scene/club {"event":"raid"} or {"area":"balcony"}.'));
  });
  S.on((what) => { if (box.isConnected && what === 'state') render(); });
  render();
  return section('Club', box);
}
