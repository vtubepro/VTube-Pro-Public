// Scene tab → Lights → the "Reactive lights" card: the one place a streamer needs. On / off, a look (Match the room ·
// Calm · Club · Rave), brightness, the flash limit, what the lights listen to, and a live meter that shows it working
// (BPM, the beat in the bar, the song section, how loud / intense, and "talking — lights calm").
// Everything but the music input lives in SceneState.lights (saved, sent to OBS + party guests).
// Stream Deck / scripts: POST http://127.0.0.1:5191/api/scene/lighting {"reactive":"toggle"} · {"mood":"club"} ·
// {"mood":"next"} · {"safe":true}.
import type { App } from '../app.ts';
import type { BeatInput, BeatSource } from '../audio/beat/beatInput.ts';
import { epochNow } from '../audio/beat/beatInput.ts';
import { MOODS, type Mood } from '../../shared/lightDirector.ts';
import { DEFAULT_LIGHTS } from '../../shared/scene.ts';
import { button, h, slider } from './dom.ts';
import type { CameraOption } from '../tracking/camera.ts';

const CSS = `
.rl-card { border:1px solid var(--line); border-radius:12px; padding:10px 12px 8px; margin:2px 0 10px; background:linear-gradient(180deg,#1a1626,#14171d); }
.rl-top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.rl-title { font-weight:800; font-size:15px; letter-spacing:.01em; }
.rl-title small { display:block; font-weight:500; font-size:11.5px; color:var(--dim); margin-top:1px; }
.rl-sw { position:relative; width:52px; height:28px; flex:none; border-radius:14px; border:1px solid var(--line); background:#262c3a; cursor:pointer; transition:background 160ms; }
.rl-sw::after { content:''; position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#c9cfdb; transition:transform 160ms, background 160ms; }
.rl-sw[aria-checked=true] { background:linear-gradient(90deg,#ff4fd8,#7c3cff); border-color:transparent; }
.rl-sw[aria-checked=true]::after { transform:translateX(24px); background:#fff; }
.rl-sw:disabled { opacity:.5; cursor:default; }
.rl-moods { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; margin:10px 0 8px; }
.rl-moods button { padding:8px 2px 7px; border-radius:9px; border:1px solid var(--line); background:#171b22; color:inherit; font-weight:700; font-size:12.5px; cursor:pointer; line-height:1.15; }
.rl-moods button small { display:block; font-weight:500; font-size:10px; color:var(--dim); margin-top:2px; }
.rl-moods button.on { background:#2a2140; border-color:#b04bff; box-shadow:0 0 0 1px #b04bff inset; }
.rl-moods button:disabled { opacity:.55; cursor:default; }
.rl-live { display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:center; padding:8px 10px; border-radius:10px; background:#0f1218; border:1px solid var(--line); }
.rl-bpm { font:800 22px/1 ui-monospace, Consolas, monospace; min-width:64px; text-align:right; }
.rl-bpm small { display:block; font:600 10px/1.2 system-ui, sans-serif; color:var(--dim); text-align:right; letter-spacing:.06em; }
.rl-mid { display:flex; flex-direction:column; gap:6px; min-width:0; }
.rl-dots { display:flex; gap:6px; align-items:center; }
.rl-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.rl-row .rl-chip { line-height:16px; }
.rl-dots i { width:11px; height:11px; border-radius:50%; background:#2a303c; transition:background 50ms, box-shadow 50ms; }
.rl-dots i.on { background:#4cc9f0; box-shadow:0 0 8px #4cc9f0; }
.rl-dots i.on.d { background:#fff; box-shadow:0 0 10px #fff; }
.rl-chip { font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; background:#262c3a; color:#dfe3ea; white-space:nowrap; }
.rl-chip.rl-music { background:#16352a; color:#7bd88f; } .rl-chip.rl-talk { background:#2d2a16; color:#ffd24a; } .rl-chip.rl-drop { background:#3a1630; color:#ff7ad9; } .rl-chip.rl-build { background:#2b2140; color:#c6a8ff; }
.rl-bar { height:6px; border-radius:3px; background:#232937; overflow:hidden; }
.rl-bar b { display:block; height:100%; width:0; background:linear-gradient(90deg,#4cc9f0,#ff4fd8); transition:width 120ms; }
.rl-kick { width:26px; height:26px; border-radius:50%; background:#262c3a; border:1px solid var(--line); transition:background 60ms; }
.rl-kick.on { background:#ff4fd8; box-shadow:0 0 12px #ff4fd8; }
.rl-say { font-size:12.5px; margin:7px 0 2px; color:#dfe3ea; min-height:17px; }
.rl-say.dim { color:var(--dim); }
.rl-src { display:flex; flex-wrap:wrap; gap:6px; margin:4px 0 6px; }
.rl-warn { font-size:11.5px; color:#ffd24a; margin:2px 0 4px; }
.rl-note { font-size:12px; color:#c6a8ff; margin:-2px 0 8px; }
`;
let cssDone = false;
let devs: CameraOption[] | null = null;
const LOOPBACK = /stereo mix|loopback|cable output|vb-?audio|voicemeeter|what u hear|wave out|monitor of|blackhole|soundflower/i;

/** The card. `B` = the studio's music input (src/ui/lightsPanel.ts creates it with the OBS / guest / preview sinks). */
export function reactiveLightsCard(app: App, B: BeatInput, rerender: () => void): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene, L = S.effective.lights, edit = S.canEdit;
  // no mood saved = a setup from before Reactive lights v2: it keeps its old show until the host picks a look here
  const mood: Mood | null = L.mood ?? null;
  // the lip-sync mic tells the analysis when the host is talking (a loopback that also carries the voice stays calm)
  B.setVoiceProbe(() => {
    const a = app.audio;
    if (!a.active) return -1;
    const st = a.fx?.stat;
    return st ? (st.gate ? 1 : 0) : Math.min(1, (a.last.level ?? 0) * 4);
  });

  const sw = h('button', { class: 'rl-sw', role: 'switch', 'aria-checked': String(!!L.reactive), 'aria-label': 'Reactive lights', disabled: !edit,
    onClick: () => S.setLights({ reactive: !S.effective.lights.reactive }) });
  const moods = h('div', { class: 'rl-moods', role: 'radiogroup', 'aria-label': 'Look' },
    ...MOODS.map((m) => h('button', { class: m.id === mood ? 'on' : '', role: 'radio', 'aria-checked': String(m.id === mood), title: m.hint, disabled: !edit,
      onClick: () => S.setLights({ mood: m.id, ...(S.effective.lights.reactive ? {} : { reactive: true }) }) },
      m.id === 'room' ? 'Room' : m.label, h('small', null, m.id === 'room' ? 'its own colours' : m.id === 'calm' ? 'soft swells' : m.id === 'club' ? 'beat + drops' : 'hard + strobes'))));

  // ---- live meter
  const bpm = h('div', { class: 'rl-bpm' }, '–', h('small', null, 'BPM'));
  const dots = h('div', { class: 'rl-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
  const chipMode = h('span', { class: 'rl-chip' }, '…'), chipSec = h('span', { class: 'rl-chip' }, '');
  const bar = h('b');
  const kick = h('div', { class: 'rl-kick', title: 'Kick drum' });
  const say = h('div', { class: 'rl-say dim' });
  const live = h('div', { class: 'rl-live' }, bpm, h('div', { class: 'rl-mid' }, h('div', { class: 'rl-row' }, dots, chipMode, chipSec), h('div', { class: 'rl-bar', title: 'How intense the music is right now' }, bar)), kick);

  // ---- what the lights listen to (zero effort: a found loopback is one click)
  const src = h('div', { class: 'rl-src' });
  // picking an input also turns the reactive lights on (that is what the click means)
  const pick = (s: BeatSource) => { void B.start(s); if (edit && !S.effective.lights.reactive) S.setLights({ reactive: true }); };
  const fillSrc = () => {
    src.replaceChildren();
    if (B.active || S.role === 'guest') return;
    const loop = devs?.find((d) => LOOPBACK.test(d.label));
    if (loop) src.append(button(`🎚 Listen to “${loop.label.replace(/\s*\(.*\)\s*$/, '')}”`, () => pick({ kind: 'device', deviceId: loop.deviceId, label: loop.label }), 'primary'));
    src.append(button('🎵 Listen to a browser tab…', () => pick({ kind: 'display' }), loop ? '' : 'primary'));
    src.append(button('Try a test beat', () => pick({ kind: 'test' })));
  };
  if (!devs) void B.devices().then((d) => { devs = d; fillSrc(); }); else fillSrc();

  const tick = () => {
    const m = B.meter, Ln = S.effective.lights;
    const on = !!m?.on, locked = !!(on && m?.locked);
    bpm.firstChild!.textContent = locked ? String(Math.round(m!.bpm)) : '–';
    const beat = locked ? (m!.beat | 0) : -1;
    [...dots.children].forEach((d, i) => { d.classList.toggle('on', i === beat); d.classList.toggle('d', i === 0); });
    kick.classList.toggle('on', epochNow() - B.kickAt < 110);
    bar.style.width = `${Math.round((on ? m!.energy : 0) * 100)}%`;
    const mode = !B.active ? 'off' : m?.mode ?? (on ? 'music' : 'silence');
    chipMode.className = `rl-chip ${mode === 'music' || mode === 'mixed' ? 'rl-music' : mode === 'talk' ? 'rl-talk' : ''}`;
    chipMode.textContent = mode === 'off' ? 'no input' : mode === 'music' ? 'music' : mode === 'mixed' ? 'music + voice' : mode === 'talk' ? 'talking' : 'quiet';
    const sec = on ? String(m!.section) : '';
    chipSec.className = `rl-chip ${sec === 'drop' ? 'rl-drop' : sec === 'build' || sec === 'buildup' ? 'rl-build' : ''}`;
    chipSec.textContent = sec === 'buildup' ? 'build' : sec;
    chipSec.style.display = sec ? '' : 'none';
    let text: string, dim = false;
    if (S.role === 'guest') text = 'The host\'s music drives the lights on your OBS.';
    else if (!B.active) { text = 'Pick what the lights listen to:'; dim = true; }
    else if (!Ln.reactive) { text = 'Reactive lights are off — the room stays as it is.'; dim = true; }
    else if (mode === 'talk') text = 'Hearing talking, no music — the lights stay calm.';
    else if (!on) { text = 'Waiting for music…'; dim = true; }
    else if (!locked) text = 'Music! Finding the beat…';
    else if (m?.quiet) text = 'Following the music — it sounds very quiet: turn up what you are playing for sharper lights.';
    else text = sec === 'drop' ? 'Following the music — drop!' : sec === 'build' || sec === 'buildup' ? 'Following the music — building up…' : 'Following the music.';
    say.textContent = text; say.classList.toggle('dim', dim);
    if (!B.active && !src.childElementCount) fillSrc();
    if (B.active && src.childElementCount) src.replaceChildren();
  };
  const timer = window.setInterval(() => { if (!card.isConnected) { window.clearInterval(timer); return; } tick(); }, 80);

  const safe = L.safe !== false;
  const card = h('div', { class: 'rl-card', 'data-tut': 'reactive-lights' },
    h('div', { class: 'rl-top' }, h('div', { class: 'rl-title' }, 'Reactive lights', h('small', null, 'The room\'s lights follow your music: colour, beat, build-ups and drops. Talking keeps them calm.')), sw),
    moods,
    mood ? null : h('p', { class: 'rl-note' }, 'New: Reactive lights. Your lights still run your saved setup — pick a look above to switch (lamps, windows and screens then stay calm, the rest follows the music).'),
    live, say, src,
    slider('Brightness', L.intensity, 0, 2, 0.01, (v) => S.setLights({ intensity: v }), 'All the room\'s show lights', { def: DEFAULT_LIGHTS.intensity, unit: '×' }),
    h('label', { class: 'row toggle', title: 'At most 3 flashes a second (WCAG). Recommended: some viewers are sensitive to flashing light.' },
      h('span', { class: 'lbl' }, 'Safe flashes (≤ 3 a second)'),
      h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: safe, disabled: !edit, onChange: (e: Event) => S.setLights({ safe: (e.target as HTMLInputElement).checked }) }), h('i'))),
    safe ? null : h('label', { class: 'row toggle', title: 'While the show flashes faster than 3 a second, your stream (and a festival stage’s screens) shows a small “Flashing lights” notice for viewers.' },
      h('span', { class: 'lbl' }, 'Show a “Flashing lights” notice on stream'),
      h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: L.warnOnStream === true, disabled: !edit, onChange: (e: Event) => S.setLights({ warnOnStream: (e.target as HTMLInputElement).checked }) }), h('i'))),
    safe ? null : h('p', { class: 'rl-warn' }, '⚠ Off: strobes can flash faster than 3 a second.'));
  void rerender;
  tick();
  return card;
}
