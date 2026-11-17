// Scene tab → Festival stage → "Endshow": compose a whole endshow for this stage in one click (shared/festivalCompose.ts)
// - pick a kind of show (or leave the default), press Play. Every page composes the same show from the host's choice
// (SceneFestivalState.compose) and this room's own flames, comets, CO2, confetti and fireworks; it plays on the music's
// beat with its own camera cuts. The room's hand-made endshow (scene.json festival.script), when it has one, stays here
// too. Mounted from festivalPanel.ts (one hook).
import type { App } from '../app.ts';
import type { SceneFestivalState } from '../../shared/festival.ts';
import { COMPOSE_LABEL, COMPOSE_MINUTES, COMPOSE_TEMPLATES, DEFAULT_COMPOSE, composeBpm, composedLenMs, type ComposeTemplate } from '../../shared/festivalComposeState.ts';
import { currentBeatInput } from '../audio/beat/beatInput.ts';
import { button, h, slider, toggle } from './dom.ts';

const HINT: Record<ComposeTemplate, string> = {
  main: 'A quiet cinematic start, full-force tracks, a breather, the big sing-along, rising new tracks, a near-dark break and a finale of fire, comet fans and fireworks.',
  closing: 'An overture, one closing theme and a finale - shorter and more emotional.',
  acts3: 'Act one at full force, a calmer look back, then everything comes together for the encore finale.',
  inverted: 'Opens at full force, cuts almost to dark, then rebuilds to the finale.',
};
/** the host's pending choice (kind of show, sing-along) between renders: any scene-state change re-renders this panel */
const draft = new WeakMap<object, { t: ComposeTemplate; anthem: number }>();

/** The endshow block: the room's own endshow (if it has one) + a composed one. `script` = the room's script info. */
export function endshowSection(app: App, st: SceneFestivalState, script: { name?: string } | null): HTMLElement {
  const S = app.scene;
  const now = Date.now();
  const comp = st.compose ?? null;
  const t = (comp?.t ?? DEFAULT_COMPOSE.t) as ComposeTemplate;
  const playingComposed = !!st.endshow && !!comp && now - st.endshow < composedLenMs(comp.min, comp.bpm);
  const playingRoom = !!st.endshow && !comp && now - st.endshow < 30 * 60_000;
  // (the choice survives a re-render until Play writes it into the scene state)
  const d = playingComposed ? null : draft.get(app);
  let pick: ComposeTemplate = d?.t ?? t, anthem = d?.anthem ?? comp?.anthem ?? DEFAULT_COMPOSE.anthem;
  const keep = () => draft.set(app, { t: pick, anthem });
  const sel = h('select', { disabled: playingComposed, onChange: (e: Event) => { pick = (e.target as HTMLSelectElement).value as ComposeTemplate; hint.textContent = HINT[pick]; keep(); } },
    ...COMPOSE_TEMPLATES.map((k) => h('option', { value: k, selected: k === pick }, `${COMPOSE_LABEL[k]} · about ${COMPOSE_MINUTES[k][0]} min`)));
  const hint = h('p', { class: 'note' }, HINT[pick]);
  const play = () => {
    draft.delete(app);
    S.setFestival({ compose: { t: pick, min: COMPOSE_MINUTES[pick][0], bpm: composeBpm(currentBeatInput()?.meter), seed: Math.floor(Math.random() * 1e6), anthem }, endshow: Date.now() + 400 });
  };
  const box = h('div', {},
    h('h4', { style: 'margin:10px 0 4px' }, '🎇 Endshow'),
    h('label', { class: 'row', title: 'What kind of show: the stage builds it from its own lights and effects' }, h('span', { class: 'lbl' }, 'Kind of show'), sel),
    hint,
    slider('Big sing-along at', anthem, 0.1, 0.9, 0.05, (v) => { anthem = v; keep(); }, 'Where in the show the anthem (the biggest sing-along) sits', (v) => `${Math.round(v * 100)} %`, { def: DEFAULT_COMPOSE.anthem }),
    h('div', { class: 'btns tight' },
      playingComposed ? button('⏹ Stop the endshow', () => S.setFestival({ endshow: 0 })) : button('▶ Play an endshow', play, 'primary'),
      ...(script ? [playingRoom ? button(`⏹ Stop ${script.name ?? 'the stage’s endshow'}`, () => S.setFestival({ endshow: 0 })) : button(`▶ ${script.name ?? 'This stage’s endshow'}`, () => S.setFestival({ endshow: Date.now() + 400, compose: undefined }))] : []),
      toggle('It cuts the cameras', st.showCams !== false, (v) => S.setFestival({ showCams: v }), 'The endshow cuts between the stage cameras on the music: wide on the drops, close in the quiet parts. Off = your camera choice stays')),
    h('p', { class: 'note' }, playingComposed ? `Playing: ${COMPOSE_LABEL[comp!.t]}. It follows your music’s beat.` : 'Built from this stage’s own flames, comets, CO2 and fireworks, on your music’s beat. Text and light only - nothing is ever played.'));
  return box;
}
