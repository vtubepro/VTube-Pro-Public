// Scene tab → Lights: master (beat reactive, level, show preset, photosensitivity limit, delay), the music input
// for the beat analysis (with a live meter / BPM / kick flash), and one row per LIGHT_* group (program, level,
// speed, colour). Everything but the music input lives in SceneState.lights (saved, sent to OBS + party guests).
import type { App } from '../app.ts';
import type { LightGroupSetting, LightProgram, LightingLook, LightingStateId } from '../../shared/types.ts';
import type { ObsPublic } from '../../shared/obs.ts';
import { DEFAULT_LOOKS, LIGHTING_STATES, LIGHT_PRESETS, LIGHT_PROGRAMS, PALETTES, lookFromPreset, lookOf, resolveGroup, resolveLookGroup } from '../../shared/lightShow.ts';
import { DEFAULT_LIGHTS } from '../../shared/scene.ts';

/** A light group's setting in a preset program (what "Reset group" goes back to): the sliders' ↺ default. */
const presetGroup = (program: string, g: string) => (LIGHT_PRESETS[program] ?? LIGHT_PRESETS.show).group(g);
import { PRESET_CATS, SHOW_PRESETS, canonPresetId, presetById, type ShowPreset } from '../../shared/lightPresets.ts';
import type { RoomSummary } from '../scene/previewLink.ts';
import { beatInput, epochNow, type BeatInput, type BeatSource } from '../audio/beat/beatInput.ts';
import type { CameraOption } from '../tracking/camera.ts';
import { button, h, section, select, slider, sliderControl, toggle } from './dom.ts';
import { stylesSection } from './lightStylesPanel.ts';
import { LIGHTS_BAR_NOTE } from './sceneParts.ts';
import { reactiveLightsCard } from './reactiveLightsPanel.ts';

const CSS = `
.lt-meter { display:grid; grid-template-columns: 1fr auto; gap:8px; align-items:center; margin:6px 0 4px; }
.lt-meter canvas { width:100%; height:38px; background:#12151b; border:1px solid var(--line); border-radius:6px; }
.lt-kick { width:30px; height:30px; border-radius:50%; background:#262c3a; border:1px solid var(--line); transition: background 60ms; }
.lt-kick.on { background:#ff4fd8; box-shadow:0 0 12px #ff4fd8; }
.lt-read { font: 12px ui-monospace, Consolas, monospace; color: var(--dim); margin-bottom:6px; min-height:15px; }
.lt-grp { border:1px solid var(--line); border-radius:8px; margin:5px 0; background:#14171d; }
.lt-grp > summary { display:grid; grid-template-columns: 14px 1fr 150px; gap:8px; align-items:center; padding:5px 8px; cursor:pointer; list-style:none; }
.lt-grp > summary::-webkit-details-marker { display:none; }
.lt-grp > summary select { width:100%; }
.lt-grp .sw { width:12px; height:12px; border-radius:3px; }
.lt-grp .body { padding:0 8px 6px; }
.lt-grp .nm small { color: var(--dim); margin-left:4px; }
`;
let cssDone = false;
const openGroups = new Set<string>();
let devices: CameraOption[] | null = null;
let lightsGen = 0;

let djRelay = false;
function input(app: App): BeatInput {
  // a DJ clock (djsync: packets with src != 'audio' on this PC's bus) also reaches the Scene-tab preview and party guests
  if (!djRelay) {
    djRelay = true;
    app.bus.on((m) => {
      const b = (m as { type?: string; b?: { src?: string } }).type === 'beat' ? (m as unknown as { b: import('../../shared/lightShow.ts').BeatPacket }).b : null;
      if (!b || !b.src || b.src === 'audio') return;
      try { app.scene.sendBeat(b); } catch { /* no preview */ }
      if (!app.scene.observer && app.party.role === 'host') try { app.party.sendBeat(b); } catch { /* no party */ }
    });
  }
  return beatInput(() => [
    // this PC's OBS pages (an ?observer=1 studio's bus is muted, so it never reaches them)
    { send: (b) => app.bus.send({ type: 'beat', b }) },
    // party guests (host only) — they relay to their own OBS pages
    { send: (b) => { if (!app.scene.observer && app.party.role === 'host') app.party.sendBeat(b); } },
    // the Scene-tab preview(s)
    { send: (b) => app.scene.sendBeat(b) },
  ]);
}

// ---------------------------------------------------------------- live meter (kept across re-renders)
let meterBox: HTMLElement | null = null;
let meterTimer = 0;
function meter(B: BeatInput) {
  if (meterBox) return meterBox;
  const cv = h('canvas', { width: 300, height: 38 });
  const kick = h('div', { class: 'lt-kick', title: 'Kick' });
  const read = h('div', { class: 'lt-read' });
  meterBox = h('div', null, h('div', { class: 'lt-meter' }, cv, kick), read);
  const g = cv.getContext('2d')!;
  const cols = ['#ff4fd8', '#ff7a45', '#ffd24a', '#7bd88f', '#4cc9f0', '#9d7bff'];
  let idle = 0;
  meterTimer = window.setInterval(() => {
    if (!meterBox?.isConnected) { if (++idle > 30) { clearInterval(meterTimer); meterBox = null; } return; }
    idle = 0;
    const m = B.meter;
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const bw = (W - 70) / 6;
    for (let i = 0; i < 6; i++) {
      const v = m?.bands[i] ?? 0;
      g.fillStyle = '#1e232c'; g.fillRect(6 + i * bw, 4, bw - 4, H - 8);
      g.fillStyle = cols[i]; g.fillRect(6 + i * bw, 4 + (H - 8) * (1 - v), bw - 4, (H - 8) * v);
    }
    // beat within the bar
    for (let i = 0; i < 4; i++) {
      g.fillStyle = m?.locked && (m.beat | 0) === i ? (i === 0 ? '#ffffff' : '#4cc9f0') : '#2a303c';
      g.beginPath(); g.arc(W - 56 + i * 14, H / 2, 5, 0, Math.PI * 2); g.fill();
    }
    kick.classList.toggle('on', epochNow() - B.kickAt < 110);
    read.textContent = !B.active ? (B.status || 'No music input — the lights stay steady.')
      : !m?.on ? `${B.status} · silence`
      : `${m.locked ? `${m.bpm.toFixed(1)} BPM` : 'finding the beat…'} · ${m.grid}${m.section && m.section !== 'listening' ? ` · ${m.section}` : ''} · energy ${Math.round((m.energy || 0) * 100)}%`;
  }, 66);
  return meterBox;
}

function sourceRow(B: BeatInput, rerender: () => void) {
  const cur = B.source;
  const val = cur.kind === 'device' ? `dev:${cur.deviceId}` : cur.kind;
  const opts: [string, string][] = [['off', 'Off'], ['display', 'Tab / screen audio… (pick a tab, tick "Share audio")'], ['test', 'Test beat (built-in 128 BPM loop)']];
  for (const d of devices ?? []) opts.push([`dev:${d.deviceId}`, `🎚 ${d.label}`]);
  if (cur.kind === 'device' && !opts.some((o) => o[0] === val)) opts.push([val, `🎚 ${cur.label ?? 'device'}`]);
  const sel = select('Music input', val, opts, (v) => {
    let s: BeatSource;
    if (v === 'off' || v === 'display' || v === 'test') s = { kind: v };
    else { const id = v.slice(4); s = { kind: 'device', deviceId: id, label: devices?.find((d) => d.deviceId === id)?.label }; }
    void B.start(s);
  }, 'What the beat analysis listens to: a loopback / "Stereo Mix" / VB-Cable / interface loopback input, or a browser tab. It opens its own stream — the lip-sync mic is never touched.');
  if (!devices) void B.devices().then((d) => { devices = d; rerender(); });
  return h('div', null, sel, h('div', { class: 'btns tight' }, button('Refresh inputs', () => { devices = null; rerender(); })));
}

// ---------------------------------------------------------------- the section
export function lightsSection(app: App, room: RoomSummary | null, rerender: () => void): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const st = S.effective, L = st.lights, edit = S.canEdit;
  const info = S.scenes.find((x) => x.id === st.sceneId);
  const authored = ((info?.lights as { groups?: Record<string, string> } | undefined)?.groups) ?? {};
  const groups = [...new Set([...Object.keys(authored), ...(room?.lights?.map((x) => x.group) ?? [])])];
  const B = input(app);
  const gen = ++lightsGen;   // newest build: may be the one kept even if this box was dropped as unchanged
  const un = B.on(() => { un(); if (box.isConnected || gen === lightsGen) rerender(); });   // one shot: the re-render subscribes again

  const presets: [string, string][] = Object.entries(LIGHT_PRESETS).map(([k, v]) => [k, v.label]);
  for (const p of info?.lights?.programs ?? []) if (!LIGHT_PRESETS[p]) presets.push([p, `${p} (room)`]);
  if (!presets.some((p) => p[0] === L.program)) presets.push([L.program, L.program]);
  const custom = L.groups && Object.keys(L.groups).length ? ` · ${Object.keys(L.groups).length} group${Object.keys(L.groups).length > 1 ? 's' : ''} customised` : '';
  const showSel = select('SHOW preset', L.program, presets, (v) => S.setLights({ program: v, groups: undefined }), 'A preset for every group; picking one clears your per-group changes');

  const setGroup = (g: string, patch: Partial<LightGroupSetting>) => {
    const cur = resolveGroup(S.effective.lights, g);
    S.setLights({ groups: { ...(S.effective.lights.groups ?? {}), [g]: { ...cur, ...patch } } });
  };
  const rows = groups.map((g) => {
    const gs = resolveGroup(L, g);
    const count = room?.lights?.find((x) => x.group === g)?.count;
    const sw = gs.color ?? authored[g] ?? '#ffffff';
    const prog = h('select', { disabled: !edit, onClick: (e: Event) => e.stopPropagation(), onChange: (e: Event) => setGroup(g, { program: (e.target as HTMLSelectElement).value as LightProgram }) },
      ...LIGHT_PROGRAMS.map((p) => h('option', { value: p.id, selected: p.id === gs.program, title: p.hint }, p.label)));
    const colour = h('input', { type: 'color', value: sw, disabled: !edit, onChange: (e: Event) => setGroup(g, { color: (e.target as HTMLInputElement).value }) });
    const d = h('details', { class: 'lt-grp', open: openGroups.has(g) },
      h('summary', null, h('span', { class: 'sw', style: `background:${sw}` }), h('span', { class: 'nm' }, g, count ? h('small', null, `×${count}`) : null, L.groups?.[g] ? h('small', null, '✎') : null), prog),
      h('div', { class: 'body' },
        slider('Level', gs.intensity, 0, 2, 0.01, (v) => setGroup(g, { intensity: v }), undefined, { def: presetGroup(L.program, g).intensity, unit: '×' }),
        slider('Speed', gs.speed, 0.25, 4, 0.05, (v) => setGroup(g, { speed: v }), 'Chase sweeps / breaths per bar, flicker rate, pulse length …', { def: presetGroup(L.program, g).speed, unit: '×' }),
        h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Colour'), h('span', null, colour, ' ',
          button('Authored', () => setGroup(g, { color: null })),
          L.groups?.[g] ? button('Reset group', () => { const next = { ...(S.effective.lights.groups ?? {}) }; delete next[g]; S.setLights({ groups: Object.keys(next).length ? next : undefined }); }) : null)),
        h('p', { class: 'note', style: 'margin:2px 0 0' }, LIGHT_PROGRAMS.find((p) => p.id === gs.program)?.hint ?? '')));
    d.addEventListener('toggle', () => { if (d.open) openGroups.add(g); else openGroups.delete(g); });
    return d;
  });

  const box = section('Lights',
    toggle('Beat reactive', L.reactive, (v) => S.setLights({ reactive: v }), 'Follow the music input below. Off (or when the music stops) every beat program eases back to steady.'),
    slider('Master level', L.intensity, 0, 2, 0.01, (v) => S.setLights({ intensity: v }), undefined, { def: DEFAULT_LIGHTS.intensity, unit: '×' }),
    showSel,
    custom ? h('p', { class: 'note', style: 'margin:0 0 4px' }, custom.slice(3)) : null,
    toggle('Photosensitivity-safe flashes', L.safe !== false, (v) => S.setLights({ safe: v }), 'On: at most 3 big flashes per second across the whole room (strobes, kick pulses, drops); chases ≤ 3 steps/s. Recommended for streams.'),
    slider('Light delay (ms)', L.delay ?? 0, -300, 300, 5, (v) => S.setLights({ delay: Math.round(v) }), '+ = OBS lights later (if your stream audio is delayed), − = earlier', { def: DEFAULT_LIGHTS.delay, hard: [-500, 500] }),
    S.role === 'guest'
      ? h('p', { class: 'note' }, 'The host\'s music drives the lights on your OBS.')
      : h('div', null, sourceRow(B, rerender), meter(B),
        h('p', { class: 'note' }, 'The beat analysis runs in this studio (BeatEngine v8) and sends ~30 small packets a second to OBS', S.observer ? ' — in this observer tab only to the preview.' : ' and party guests.')),
    stylesSection(app, rerender),
    groups.length ? h('div', null, h('p', { class: 'note', style: 'margin:8px 0 2px' }, 'Groups (LIGHT_* fixtures):'), ...rows) : h('p', { class: 'note' }, 'Turn the preview on to list the room\'s light groups.'),
  );
  if (!edit) for (const x of box.querySelectorAll('input,select,button')) (x as HTMLInputElement).disabled = true;
  return h('div', null, S.role === 'guest' ? null : reactiveLightsCard(app, B, rerender), box, statesSection(app, groups, rerender));
}

// ---------------------------------------------------------------- lighting states
const STATE_CSS = `
.lt-states { display:grid; grid-template-columns: repeat(5, 1fr); gap:5px; margin:2px 0 10px; }
.lt-states-lbl { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); margin:2px 0 4px; }
.lt-states-lbl span { text-transform:none; letter-spacing:0; font-weight:500; color:var(--faint, var(--dim)); }
.lt-states button { padding:10px 2px 8px; border-radius:9px; border:1px solid var(--line); background:#171b22; color:inherit; font-weight:700; font-size:13px; cursor:pointer; line-height:1.1; }
.lt-states button small { display:block; font-weight:500; font-size:10px; color:var(--dim); margin-top:3px; }
.lt-states button.on { background: linear-gradient(180deg, #ff4fd8, #7c3cff); color:#fff; border-color:transparent; box-shadow:0 0 14px #b04bff88; }
.lt-states button.on[data-id=show] { background: linear-gradient(180deg, #7bd88f, #3aa35a); box-shadow:0 0 12px #7bd88f66; }
.lt-states button.on small { color:#ffffffcc; }
.lt-lookrow { display:grid; grid-template-columns: 1fr 130px 64px; gap:6px; align-items:center; padding:3px 8px; }
.lt-lookrow select { width:100%; }
.lt-lookrow { grid-template-columns: 1fr 150px; row-gap: 2px; } .lt-lookrow .sl-inline { grid-column: 1 / -1; }
`;
let stateCss = false;

/** Big one-click lighting-state buttons (top of the Scene tab). */
export function lightingBar(app: App): HTMLElement {
  if (!stateCss) { document.head.append(h('style', null, STATE_CSS)); stateCss = true; }
  const S = app.scene, cur = S.effective.lights.state ?? 'show';
  // (clarity: a visible "Room lights" label: "Show" and "React" here are lights, not the show mode, which is in Show & layout)
  return h('div', { class: 'lt-states-box' }, h('div', { class: 'lt-states-lbl' }, 'Room lights', h('span', null, LIGHTS_BAR_NOTE)),
    h('div', { class: 'lt-states', role: 'group', 'aria-label': 'Room lights', title: 'Room lights only: Shift+1–5 in the studio. Stream Deck: see Guides → Stream Deck & controllers.' },
      ...LIGHTING_STATES.map((s) => h('button', { class: s.id === cur ? 'on' : '', 'data-id': s.id, disabled: !S.canEdit, title: s.hint, onClick: () => S.setLighting(s.id) },
        s.label, h('small', null, `Shift+${s.key}`)))));
}

let editLook: LightingStateId = 'preshow';
let obsCfg: ObsPublic | null | undefined;
let obsAt = 0;

/** Editor for the non-SHOW looks (SHOW = the settings of the Lights section). */
function lookEditor(app: App, groups: string[], rerender: () => void): HTMLElement {
  const S = app.scene, L = S.effective.lights, edit = S.canEdit;
  if (editLook === 'show') editLook = 'preshow';
  const look = lookOf(L, editLook);
  const setLook = (patch: Partial<LightingLook>) => {
    const cur = lookOf(S.effective.lights, editLook);
    S.setLights({ states: { ...(S.effective.lights.states ?? {}), [editLook]: { ...cur, ...patch } } });
  };
  const pick = select('Edit look', editLook, LIGHTING_STATES.filter((s) => s.id !== 'show').map((s): [string, string] => [s.id, s.label]), (v) => { editLook = v as LightingStateId; rerender(); });
  const presets: [string, string][] = [['', 'Same as SHOW'], ...Object.entries(LIGHT_PRESETS).map(([k, v]): [string, string] => [k, v.label])];
  const setGroup = (g: string, patch: Partial<LightGroupSetting>) => {
    const cur = lookOf(S.effective.lights, editLook);
    const gs = resolveLookGroup(S.effective.lights, cur, g);
    setLook({ program: cur.program || 'show', groups: { ...(cur.groups ?? {}), [g]: { ...gs, ...patch } } });
  };
  const rows = groups.map((g) => {
    const gs = resolveLookGroup(L, look, g);
    return h('div', { class: 'lt-grp lt-lookrow' },
      h('span', { class: 'nm' }, g, look.groups?.[g] ? h('small', null, ' *') : null),
      h('select', { disabled: !edit, onChange: (e: Event) => setGroup(g, { program: (e.target as HTMLSelectElement).value as LightProgram }) },
        ...LIGHT_PROGRAMS.map((p) => h('option', { value: p.id, selected: p.id === gs.program }, p.label))),
      sliderControl(gs.intensity, 0, 2, 0.05, (v) => setGroup(g, { intensity: v }), { inline: true, commit: true, disabled: !edit, label: `${g} level`, unit: '×',
        def: look.program ? presetGroup(look.program, g).intensity : resolveGroup(L, g).intensity }));
  });
  const tint = h('input', { type: 'color', value: look.tint ?? '#ffffff', disabled: !edit, onChange: (e: Event) => setLook({ tint: (e.target as HTMLInputElement).value }) });
  const custom = !!L.states?.[editLook];
  const live = (L.state ?? 'show') === editLook;
  const label = LIGHTING_STATES.find((s) => s.id === editLook)?.label ?? editLook;
  const box = h('div', null,
    pick,
    h('div', { class: 'btns tight' },
      button(live ? `${label} is live now` : `▶ Switch to ${label} now`, () => S.setLighting(editLook), live ? '' : 'primary'),
      h('span', { class: 'note', style: 'margin-left:8px' }, 'Editing a look doesn’t switch to it — use this or the state buttons.')),
    slider('House lights', look.house, 0, 1.2, 0.01, (v) => setLook({ house: v }), '0 = lights down (a moody low light: practicals stay on, never black) … 1 = normal studio lighting', { def: DEFAULT_LOOKS[editLook].house }),
    h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'House tint'), h('span', null, tint, ' ', button('Neutral', () => setLook({ tint: null })))),
    slider('Effects rig', look.fx, 0, 1, 0.01, (v) => setLook({ fx: v }), 'Moving-head beams, laser fans, mirror ball', { def: DEFAULT_LOOKS[editLook].fx }),
    select('Palette', look.palette, Object.entries(PALETTES).map(([k, v]): [string, string] => [k, v.label]), (v) => setLook({ palette: v }), 'Changes every phrase (8 bars) and on drops'),
    slider('Effects speed', look.energy, 0.25, 2, 0.05, (v) => setLook({ energy: v }), undefined, { def: DEFAULT_LOOKS[editLook].energy, unit: '×' }),
    select('Groups', look.program, presets, (v) => setLook({ program: v, groups: undefined })),
    select('Music', look.music, [['auto', 'Always animated (music, else auto show)'], ['user', 'Follow Beat reactive']], (v) => setLook({ music: v as 'auto' | 'user' })),
    h('div', null, ...rows),
    h('div', { class: 'btns tight' }, button(custom ? 'Reset this look to default' : 'Default look (unchanged)', () => { const next = { ...(S.effective.lights.states ?? {}) }; delete next[editLook]; S.setLights({ states: Object.keys(next).length ? next : undefined }); })),
  );
  if (!edit) for (const x of box.querySelectorAll('input,select,button')) (x as HTMLInputElement).disabled = true;
  (pick.querySelector('select') as HTMLSelectElement).disabled = false;
  return box;
}

/** OBS scene -> lighting state (only when the OBS automation is on; never from an observer sandbox). */
function obsMap(app: App, rerender: () => void): HTMLElement | null {
  if (app.scene.observer && !/[?&]obsTest=1/.test(location.search)) return null;
  if (obsCfg === undefined || Date.now() - obsAt > 10000) {
    const had = !!obsCfg?.enabled;
    obsAt = Date.now();
    void fetch('/api/obs').then((r) => (r.ok ? r.json() : null)).then((c) => { obsCfg = c as ObsPublic | null; if (!!obsCfg?.enabled !== had) rerender(); }).catch(() => {});
    if (obsCfg === undefined) { obsCfg = null; return null; }
  }
  if (!obsCfg?.enabled) return null;
  const map: Record<string, string> = { ...(obsCfg.lightingMap ?? {}) };
  const save = async () => {
    const r = await fetch('/api/obs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lightingMap: map }) });
    if (r.ok) { obsCfg = (await r.json()) as ObsPublic; rerender(); }
  };
  const nameIn = h('input', { type: 'text', placeholder: 'OBS scene name, e.g. Starting Soon', style: 'width:100%' }) as HTMLInputElement;
  const stSel = h('select', null, ...LIGHTING_STATES.map((s) => h('option', { value: s.id }, s.label))) as HTMLSelectElement;
  return h('div', null,
    h('p', { class: 'note', style: 'margin:8px 0 2px' }, 'OBS scene → lighting state (switches when OBS changes scene):'),
    ...Object.entries(map).map(([k, v]) => h('div', { class: 'row' }, h('span', { class: 'lbl' }, k), h('span', null, LIGHTING_STATES.find((s) => s.id === v)?.label ?? v, ' ', button('✕', () => { delete map[k]; void save(); })))),
    nameIn, h('div', { class: 'btns tight' }, stSel, button('Add mapping', () => { const n = nameIn.value.trim(); if (n) { map[n] = stSel.value; void save(); } })));
}

/** Lighting-states block (below the Lights section). */
export function statesSection(app: App, groups: string[], rerender: () => void): HTMLElement {
  const S = app.scene, L = S.effective.lights;
  return section('Lighting states',
    lightingBar(app),
    h('p', { class: 'note' }, 'Current: ', h('b', null, LIGHTING_STATES.find((s) => s.id === (L.state ?? 'show'))?.label ?? 'Show'),
      ' — SHOW is the normal studio lighting set above. Preshow → Show plays a show-open (blackout, ON AIR slams on, the house lights rack up).'),
    slider('Change duration (s)', L.stateFade ?? 2, 0, 8, 0.1, (v) => S.setLights({ stateFade: v }), undefined, { def: DEFAULT_LIGHTS.stateFade }),
    lookEditor(app, groups, rerender),
    presetBrowser(app, rerender),
    obsMap(app, rerender),
  );
}

// ---------------------------------------------------------------- preset browser
const BROWSER_CSS = `
.lt-pb-cats { display:flex; flex-wrap:wrap; gap:4px; margin:4px 0 6px; }
.lt-pb-cats button { padding:4px 9px; border-radius:12px; border:1px solid var(--line); background:#171b22; color:inherit; font-size:12px; cursor:pointer; }
.lt-pb-cats button.on { background:#7c3cff; border-color:transparent; color:#fff; }
.lt-pb-list { max-height:430px; overflow:auto; border:1px solid var(--line); border-radius:8px; background:#12151b; }
.lt-pb-card { display:grid; grid-template-columns: 1fr auto; gap:2px 6px; padding:6px 8px; border-bottom:1px solid #1e232c; }
.lt-pb-card:last-child { border-bottom:0; }
.lt-pb-card.cur { background:#1d1830; }
.lt-pb-card .nm { font-weight:700; font-size:13px; }
.lt-pb-card .nm small { font-weight:500; color:var(--dim); margin-left:6px; text-transform:uppercase; font-size:10px; letter-spacing:.04em; }
.lt-pb-card .vibe { grid-column:1 / 3; font-size:11px; color:var(--dim); }
.lt-pb-card .sw { display:inline-flex; gap:2px; margin-right:6px; vertical-align:middle; }
.lt-pb-card .sw i { width:9px; height:9px; border-radius:2px; display:inline-block; }
.lt-pb-card .act { display:flex; gap:3px; }
.lt-pb-card .act button { padding:2px 7px; font-size:12px; }
.lt-pb-card .act button.fav { color:#ffd000; }
.lt-pb-prev { background:#3a2a10; border:1px solid #806020; border-radius:6px; padding:5px 8px; margin:4px 0; font-size:12px; }
`;
let browserCss = false;
const tb = (label: string, fn: () => void, title = '') => { const x = button(label, fn); if (title) x.title = title; return x; };
let pbCat: string = 'all';
const FAV_KEY = 'vtp.lights.favPresets';
// favourites saved under a retired preset id still count (canonPresetId)
const favs = (): Set<string> => { try { return new Set((JSON.parse(localStorage.getItem(FAV_KEY) || '[]') as string[]).map((id) => canonPresetId(id))); } catch { return new Set(); } };
const saveFavs = (s: Set<string>) => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch { /* storage off */ } };

/** Put a preset into a state: its whole look (SHOW: only the group programs — the house stays normal). */
function applyPreset(app: App, id: LightingStateId, p: ShowPreset, keepCycle = false) {
  const S = app.scene, L = S.effective.lights;
  if (id === 'show') { S.setLights({ program: `p_${p.id}`, groups: undefined }); return; }
  const cur = lookOf(L, id);
  const look: LightingLook = { ...lookFromPreset(p, cur.music), ...(keepCycle && cur.cycle ? { cycle: cur.cycle } : {}) };
  S.setLights({ states: { ...(L.states ?? {}), [id]: look } });
}

function presetBrowser(app: App, rerender: () => void): HTMLElement {
  if (!browserCss) { document.head.append(h('style', null, BROWSER_CSS)); browserCss = true; }
  const S = app.scene, L = S.effective.lights, edit = S.canEdit;
  const target = editLook;
  const look = lookOf(L, target);
  const f = favs();
  const cats: [string, string][] = [['all', 'All'], ...PRESET_CATS.map((c): [string, string] => [c.id, c.label]), ['fav', '★ Favourites']];
  const list = SHOW_PRESETS.filter((p) => pbCat === 'all' || (pbCat === 'fav' ? f.has(p.id) : p.cat === pbCat));
  const search = h('input', { type: 'search', placeholder: `Search ${SHOW_PRESETS.length} presets…`, style: 'width:100%' }) as HTMLInputElement;
  const previewing = (S as unknown as { previewing: unknown }).previewing as LightingLook | null;
  const cards = list.map((p) => {
    const isCur = look.preset === p.id && !look.cycle;
    const isPrev = previewing?.preset === p.id;
    const card = h('div', { class: `lt-pb-card ${isCur ? 'cur' : ''}`, 'data-q': `${p.name} ${p.vibe} ${p.cat}`.toLowerCase() },
      h('span', { class: 'nm' }, h('span', { class: 'sw' }, ...p.palette.slice(0, 3).flat().slice(0, 4).map((c) => h('i', { style: `background:${c}` }))), p.name, h('small', null, p.cat), isCur ? h('small', null, '• in use') : null),
      h('span', { class: 'act' },
        tb(isPrev ? '■' : '▶', () => S.previewLook(isPrev ? null : { ...lookFromPreset(p), music: 'auto' }), isPrev ? 'Stop the preview' : 'Preview in the Scene-tab preview only (not saved, not sent)'),
        edit ? tb('Use', () => { S.previewLook(null); applyPreset(app, target, p); }, `Apply to ${LIGHTING_STATES.find((s) => s.id === target)?.label}`) : null,
        tb(f.has(p.id) ? '★' : '☆', () => { if (f.has(p.id)) f.delete(p.id); else f.add(p.id); saveFavs(f); rerender(); }, 'Favourite')),
      h('span', { class: 'vibe' }, p.vibe));
    const fb = card.querySelector('.act button:last-child');
    fb?.classList.add('fav');
    return card;
  });
  search.addEventListener('input', () => { const q = search.value.trim().toLowerCase(); for (const c of cards) c.style.display = !q || (c.dataset.q ?? '').includes(q) ? '' : 'none'; });
  const cycleSel = h('select', { disabled: !edit, onChange: (e: Event) => {
    const v = (e.target as HTMLSelectElement).value;
    const cur = lookOf(S.effective.lights, target);
    const next: LightingLook = { ...cur };
    if (v === 'off') delete next.cycle; else next.cycle = { cat: v, every: cur.cycle?.every ?? 2 };
    S.setLights({ states: { ...(S.effective.lights.states ?? {}), [target]: next } });
  } }, ...[['off', 'Auto-cycle: off'], ['all', 'Cycle all presets'], ...PRESET_CATS.map((c) => [c.id, `Cycle ${c.label}`])].map(([v, l]) => h('option', { value: v, selected: (look.cycle?.cat ?? 'off') === v }, l)));
  const everySel = h('select', { disabled: !edit || !look.cycle, onChange: (e: Event) => {
    const cur = lookOf(S.effective.lights, target);
    if (cur.cycle) S.setLights({ states: { ...(S.effective.lights.states ?? {}), [target]: { ...cur, cycle: { ...cur.cycle, every: +(e.target as HTMLSelectElement).value } } } });
  } }, ...[1, 2, 4, 8].map((n) => h('option', { value: n, selected: (look.cycle?.every ?? 2) === n }, `every ${n} phrase${n > 1 ? 's' : ''} (${n * 8} bars)`)));
  return h('div', null,
    h('p', { class: 'note', style: 'margin:8px 0 2px' }, h('b', null, 'Presets'), ` — ${SHOW_PRESETS.length} looks. "Use" puts one into `, h('b', null, LIGHTING_STATES.find((s) => s.id === target)?.label ?? target), ' (the look picked in "Edit look"); ▶ plays it in the preview only.'),
    previewing ? h('div', { class: 'lt-pb-prev' }, `Previewing "${presetById(previewing.preset)?.name ?? 'look'}" in the Scene-tab preview only — OBS and guests still see the real lights. `, tb('Stop preview', () => S.previewLook(null))) : null,
    h('div', { class: 'lt-pb-cats' }, ...cats.map(([id, label]) => h('button', { class: pbCat === id ? 'on' : '', onClick: () => { pbCat = id; rerender(); } }, label)),
      edit ? h('button', { onClick: () => { const pool = list.length ? list : SHOW_PRESETS; applyPreset(app, target, pool[Math.floor(Math.random() * pool.length)]); }, title: 'Apply a random preset from this category' }, '🎲 Surprise me') : null),
    search,
    h('div', { class: 'lt-pb-list' }, ...cards),
    h('div', { class: 'btns tight', style: 'margin-top:6px' }, cycleSel, everySel),
  );
}
