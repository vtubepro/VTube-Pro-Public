// Scene tab → "Festival stage" (rooms with a scene.json `festival` key, src/scene/festival): which show runs (Auto by
// the music's tempo, or one of the generated shows by genre), special effects on / off, the show's strength, the buttons
// that fire an effect on every OBS page right now (Drop!, flames, CO2, confetti, fireworks …), the Look Lab picks, and
// the photosensitivity line. All host scene state (shared/festival.ts), so every OBS page and party guest sees the same.
import type { App } from '../app.ts';
import { DEFAULT_FESTIVAL_STATE, sanitizeFestivalState, type FestivalCuration } from '../../shared/festival.ts';
import { GENRES, LOOKS_VERSION, catalogue } from '../../shared/festivalLooks.ts';
import { button, debounce, h, rerender, section, slider, toggle } from './dom.ts';
import { forScripts } from './forScripts.ts';
import { endshowSection } from './festivalEndshowPanel.ts';

/** The Look Lab saves its keep / kill / favourite result here (same origin as the studio). */
export const LOOKLAB_KEY = 'vtp.festival.curation.v1';
export function readLabCuration(): FestivalCuration | null {
  try { const o = JSON.parse(localStorage.getItem(LOOKLAB_KEY) ?? 'null') as FestivalCuration | null; return o && o.v === LOOKS_VERSION && typeof o.kill === 'string' ? o : null; } catch { return null; }
}

const FIRE: [string, string, string][] = [
  ['drop', '💥 Drop!', 'The full drop on every OBS page right now: blinders, CO2, flames, confetti, then flames on the kicks'],
  ['flames', '🔥 Flames', 'Every flame column fires once'], ['co2', '💨 CO2', 'The CO2 jets blast'], ['confetti', '🎊 Confetti', 'The confetti cannons fire over the crowd'],
  ['fireworks', '🎆 Fireworks', 'Shells from behind the stage'], ['gerbs', '✨ Sparks', 'Spark fountains along the stage front'], ['blinders', '💡 Blinders', 'The blinders hit the crowd'], ['blackout', '⬛ Blackout', 'Two beats of darkness'],
];

const boxes = new WeakMap<App, HTMLElement>();
/** One Festival section per studio (it keeps its own state and re-renders on scene changes). */
export function festivalSection(app: App): HTMLElement {
  const had = boxes.get(app);
  if (had) return had;
  const S = app.scene;
  const box = h('div');
  const setIntensity = debounce((v: number) => S.setFestival({ intensity: v }), 300);
  const render = () => rerender(box, () => {
    const st = sanitizeFestivalState(S.effective.festival ?? DEFAULT_FESTIVAL_STATE);
    const edit = S.canEdit;
    const info = S.scenes.find((x) => x.id === S.effective.sceneId) as unknown as { festival?: { palettes?: { id: string; name: string; colors: string[] }[]; shows?: { id: string; name: string; genre: string; palettes: string[] }[]; script?: { name?: string; parts?: unknown[] }; ambient?: { on?: boolean } } } | undefined;
    const cat = catalogue(info?.festival ? { palettes: info.festival.palettes ?? [], shows: info.festival.shows ?? [] } : null);
    // the show picker: Auto, this room's own shows, then every genre
    const sel = h('select', { disabled: !edit, onChange: (e: Event) => S.setFestival({ show: (e.target as HTMLSelectElement).value }) },
      h('option', { value: 'auto', selected: st.show === 'auto' }, 'Auto (picks the style from the music’s tempo)'),
      ...(info?.festival?.shows?.length ? [h('optgroup', { label: 'This stage' }, ...info.festival.shows.map((s) => h('option', { value: s.id, selected: st.show === s.id }, s.name)))] : []),
      ...GENRES.map((g) => h('optgroup', { label: `${g.name} (${g.bpm[0]}–${g.bpm[1]} BPM)` }, ...cat.shows.filter((s) => s.genre === g.id && !info?.festival?.shows?.some((r) => r.id === s.id)).map((s) => h('option', { value: s.id, selected: st.show === s.id }, s.name)))));
    const fire = h('div', { class: 'btns tight' }, ...FIRE.map(([k, label, hint]) => { const b = button(label, () => S.setFestival({ cue: k }), k === 'drop' ? 'primary' : ''); b.title = hint; b.disabled = !edit || (!st.pyro && !['drop', 'blinders', 'blackout'].includes(k)); return b; }));
    const lab = readLabCuration();
    const using = !!st.curation && st.curation.v === LOOKS_VERSION;
    const kills = (c: FestivalCuration | null | undefined) => { if (!c) return 0; let n = 0; try { for (const ch of atob(c.kill.replace(/-/g, '+').replace(/_/g, '/'))) { let b = ch.charCodeAt(0); while (b) { n += b & 1; b >>= 1; } } } catch { /* empty */ } return n; };
    const safe = S.effective.lights?.safe !== false;
    // the room's scripted endshow (scene.json festival.script): play / stop, its camera cuts on or off
    const script = info?.festival?.script && Array.isArray(info.festival.script.parts) && info.festival.script.parts.length ? info.festival.script : null;
    const talkBg = info?.festival?.ambient?.on !== false;
    box.append(
      h('p', { class: 'note' }, `${cat.looks.length} light looks in ${cat.shows.length} shows. The show follows your music by itself: builds count down, drops hit with blinders, CO2 and flames.`),
      h('label', { class: 'row', title: 'Auto picks hardstyle at 145–165 BPM, hardcore above 170, trance around 138 … and changes colours every few drops' }, h('span', { class: 'lbl' }, 'Show'), sel),
      toggle('Special effects', st.pyro, (v) => S.setFestival({ pyro: v }), 'Flames, CO2, confetti, sparks, comets and fireworks (on screen only: nothing real is ever triggered)'),
      slider('Show strength', st.intensity, 0, 1.5, 0.05, (v) => setIntensity(v), 'How bright and busy the whole rig is', (v) => `${Math.round(v * 100)} %`, { def: 1 }),
      h('h4', { style: 'margin:10px 0 4px' }, 'Fire now'), edit ? fire : h('p', { class: 'note' }, 'The host runs the stage.'),
      edit ? endshowSection(app, st, script) : h('span'),
      edit && talkBg ? h('div', {}, h('h4', { style: 'margin:10px 0 4px' }, '🎙 Behind your conversation'),
        h('p', { class: 'note' }, 'In Talk and Interview the stage behind you plays a calm light show by itself, with small pyro moments now and then and a big one every few minutes (only when nobody is talking).'),
        h('div', { class: 'btns tight' }, button('🎆 Big moment now', () => S.setFestival({ cue: 'big' })))) : h('span'),
      h('h4', { style: 'margin:10px 0 4px' }, 'Your looks'),
      h('div', { class: 'btns tight' },
        button('🎛 Open the Look Lab', () => { window.open('/looklab.html', 'vtp-looklab', 'width=1280,height=860'); }),
        lab ? button(using && st.curation!.kill === lab.kill ? `✓ Using your picks (${kills(lab)} removed)` : `Use my Look Lab picks (${kills(lab)} removed)`, () => S.setFestival({ curation: lab }), using && st.curation!.kill === lab.kill ? 'primary' : '') : h('span'),
        using ? button('Use every look', () => S.setFestival({ curation: { v: LOOKS_VERSION, kill: '', fav: '' } })) : h('span')),
      h('p', { class: 'note' }, safe
        ? 'Flashing is limited to 3 flashes a second (safe for photosensitive viewers). To allow real strobes, turn off "Safe flashes" under Lights.'
        : S.effective.lights?.warnOnStream === true
          ? '⚠ Safe flashes are OFF: real strobes run and the stage screens show a FLASHING LIGHTS warning to your viewers.'
          : '⚠ Safe flashes are OFF: real strobes run. (A “Flashing lights” notice for viewers can be switched on under Lights.)'),
      forScripts('Stream Deck / DJ pad: POST /api/scene/festival {"cue":"drop"} (or flames, co2, confetti, fireworks, gerbs, blinders, blackout, big), {"show":"auto"}, {"pyro":false}, {"intensity":0.8}, {"endshow":<epoch ms> | 0}, {"showCams":false}, {"compose":"main","endshow":1} (a composed endshow: main, closing, acts3 or inverted; {"compose":"room","endshow":1} or a plain {"endshow":1} = this stage’s own).'));
  });
  S.on((what) => { if (box.isConnected && what === 'state') render(); });
  addEventListener('storage', (e: StorageEvent) => {
    if (e.key === LOOKLAB_KEY && box.isConnected) render();
    // the Look Lab's "Use these looks on my stage": apply the picks (host only)
    if (e.key === 'vtp.festival.apply' && S.canEdit) { const lab = readLabCuration(); if (lab) S.setFestival({ curation: { v: lab.v, kill: lab.kill, fav: lab.fav } }); }
  });
  render();
  const sec = section('🎆 Festival stage', box);
  boxes.set(app, sec);
  return sec;
}
