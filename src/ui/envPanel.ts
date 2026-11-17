// Scene tab → "Time & weather" (rooms with scene.json `environment`): the time of day (slider, quick picks, a moving /
// real / locked clock and its speed), the weather (manual, an automatic game-style cycle, or following the lighting
// state), wind, lightning. Host-owned like the rest of the scene state: every OBS page and party guest shows the same
// sky (src/scene/environment/*). ?observer=1 studios only change their own preview.
import type { App } from '../app.ts';
import { ENV_WEATHERS, WEATHER_ICON, WEATHER_LABEL, envDefaults, envHour, fmtHour, type EnvClock, type EnvWeatherMode } from '../../shared/environment.ts';
import { button, debounce, h, rerender, section, select, slider, syncSlider, toggle } from './dom.ts';
import { previewVisible } from './previewFrame.ts';

const CSS = `
.env-wx { display:grid; grid-template-columns: repeat(4, 1fr); gap:4px; margin:4px 0 8px; }
.env-wx button { padding:6px 4px; border-radius:8px; border:1px solid var(--line); background:#171b22; color:inherit; font-size:12px; cursor:pointer; }
.env-wx button b { display:block; font-size:17px; line-height:1.1; }
.env-wx button.on { background: var(--accent2); color:#06131a; border-color:transparent; font-weight:700; }
.env-wx button.soon { outline:1px dashed var(--accent2); }
.env-clock { font: 600 22px ui-monospace, Consolas, monospace; letter-spacing:1px; margin:2px 0 0; }
.env-bar { height:8px; border-radius:4px; margin:4px 0 8px; background: linear-gradient(90deg, #0b1030 0%, #1a2150 20%, #e0703e 26%, #9fd0ff 36%, #7fbcf0 60%, #f09652 76%, #6a3a5e 80%, #0b1030 88%, #0b1030 100%); position:relative; }
.env-bar i { position:absolute; top:-3px; width:3px; height:14px; background:#fff; border-radius:2px; box-shadow:0 0 3px #000; }
`;
let cssDone = false;

const SPEEDS: [string, string][] = [
  ['1', 'Real time (1 game hour per hour)'], ['6', '1 game hour per 10 min'], ['12', '1 game hour per 5 min'],
  ['24', '1 game hour per 2.5 min (a day per hour)'], ['60', '1 game hour per minute'], ['120', '1 game hour per 30 s'], ['360', 'Demo: a day in 4 minutes'],
];

/** '14:30', '2:30 pm', '9pm', '14.5' → hours (NaN when unreadable). */
function parseHour(s: string): number {
  const t = s.trim().toLowerCase();
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  let v: number;
  if (m) {
    let hr = +m[1];
    if (m[3]) { hr %= 12; if (m[3] === 'pm') hr += 12; }
    const mi = m[2] ? +m[2] : 0;
    if (mi >= 60) return NaN;
    v = hr + mi / 60;
  } else if (/^\d+[.,]\d+$/.test(t)) v = parseFloat(t.replace(',', '.'));
  else return NaN;
  return v >= 0 && v < 24 ? Math.min(23.99, v) : NaN;
}

export function envSection(app: App): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const box = h('div');
  const clock = h('div', { class: 'env-clock' });
  const bar = h('div', { class: 'env-bar' }, h('i'));
  const stat = h('p', { class: 'note' });
  const setHour = debounce((v: number) => S.setEnv({ hour: v }), 120);
  const setWind = debounce((v: number) => S.setEnv({ wind: v }), 300);
  const setFade = debounce((v: number) => S.setEnv({ fade: v }), 300);
  const setCycle = debounce((v: number) => S.setEnv({ cycleMins: v }), 300);
  const room = () => S.scenes.find((x) => x.id === S.effective.sceneId);
  const render = () => rerender(box, () => {
    const st = S.envState;
    const cfg = room()?.environment ?? {};
    const edit = S.canEdit;
    const hourNow = envHour(st, Date.now());
    const ED = envDefaults(cfg); // this room's starting state: what ↺ restores
    const time = h('div', null,
      toggle('Time & weather', st.on, (v) => S.setEnv({ on: v }), 'Off = the room exactly as authored (no sky changes, rain, night lights …)'),
      slider('Time of day', +hourNow.toFixed(2), 0, 23.99, 0.05, (v) => setHour(v), 'Drag to set the time (the sky and the lights glide there on every OBS page)', (v) => fmtHour(v), { def: ED.hour, parse: parseHour }),
      h('div', { class: 'btns tight' },
        button('🌅 Dawn', () => S.setEnv({ hour: (cfg.sunrise ?? 6) + 0.2 })), button('☀ Noon', () => S.setEnv({ hour: 12.5 })),
        button('🌇 Sunset', () => S.setEnv({ hour: (cfg.sunset ?? 18.5) - 0.3 })), button('🌙 Night', () => S.setEnv({ hour: 23 })),
        button('⏱ Match my local time', () => S.setEnv({ clock: 'real' }), st.clock === 'real' ? 'primary' : '')),
      select<EnvClock>('Clock', st.clock, [['cycle', 'Moving (game clock)'], ['real', 'Real local time'], ['fixed', 'Locked (time stands still)']], (v) => S.setEnv({ clock: v }),
        'Moving: time passes at the speed below. Real: follows your PC clock (guests see YOUR local time). Locked: stays put.'),
      st.clock === 'cycle' ? select('Speed', String(st.speed), SPEEDS.some(([v]) => +v === st.speed) ? SPEEDS : [[String(st.speed), `${st.speed}× real time`], ...SPEEDS], (v) => S.setEnv({ speed: +v }), 'How fast a day goes by') : null,
      toggle('Lock time', st.clock === 'fixed', (v) => S.setEnv({ clock: v ? 'fixed' : 'cycle' }), 'Freeze the clock where it is'),
    );
    const cur = (previewVisible() ? S.report : null)?.env?.weather;
    const wx = h('div', { class: 'env-wx' }, ...ENV_WEATHERS.map((w) => h('button', {
      class: `${st.weatherMode === 'manual' && st.weather === w ? 'on' : ''} ${cur && cur.to === w && st.weatherMode !== 'manual' ? 'soon' : ''}`.trim(), disabled: !edit, title: WEATHER_LABEL[w],
      onClick: () => S.setEnv({ weather: w, weatherMode: 'manual' }),
    }, h('b', null, WEATHER_ICON[w]), WEATHER_LABEL[w])));
    const modes: [EnvWeatherMode, string][] = [['manual', 'Manual (the buttons above)'], ['cycle', 'Automatic (changes by itself, like games)']];
    if (cfg.weatherByState) modes.push(['state', 'Follow the lighting state (e.g. PRESHOW → storm)']);
    const weather = h('div', null, wx,
      select<EnvWeatherMode>('Weather', st.weatherMode, modes, (v) => S.setEnv({ weatherMode: v }), 'Automatic: a seeded weather cycle for this room\'s climate — every OBS page and guest sees the same weather'),
      st.weatherMode === 'cycle' ? slider('Average weather length', st.cycleMins, 2, 60, 1, (v) => setCycle(v), 'Minutes of real time per weather', (v) => `${v.toFixed(0)} min`, { def: ED.cycleMins, hard: [1, 240] }) : null,
      slider('Weather change', st.fade, 0, 180, 5, (v) => setFade(v), 'How long a change of weather takes (s)', (v) => `${v.toFixed(0)} s`, { def: ED.fade, hard: [0, 600] }),
      slider('Wind', st.wind, 0, 2, 0.05, (v) => setWind(v), 'Foliage, cloth, rain and clouds (× the weather\'s own wind, with gusts)', (v) => `${v.toFixed(2)}×`, { def: ED.wind }),
      toggle('Lightning in storms', st.lightning, (v) => S.setEnv({ lightning: v }), 'Flashes follow the lighting\'s photosensitivity setting (Safe: at most 3 flashes a second, softer)'),
    );
    box.append(clock, bar, stat, time, h('h4', { style: 'margin:10px 0 4px' }, 'Weather'), weather,
      h('p', { class: 'note' }, S.observer ? 'Observer: changes stay in this preview.' : edit ? 'Everyone\'s OBS and party guests see the same time and weather. Lanterns, street lights and windows marked as night lights switch on by themselves when it gets dark (also in storms).' : 'The host runs the time and the weather.'));
    if (!edit) for (const i of box.querySelectorAll('input, select, button')) (i as HTMLInputElement).disabled = true;
  });
  const renderStat = () => {
    const st = S.envState;
    const hr = envHour(st, Date.now());
    // (only a preview the user can see counts as live: the hidden room-analysis preview's one report is not — review round 1)
    const r = previewVisible() ? S.report?.env ?? null : null;
    const shown = r && r.on ? r.hour : hr;
    clock.textContent = `${fmtHour(shown)}${st.clock === 'fixed' ? ' 🔒' : st.clock === 'real' ? ' (local)' : st.speed !== 1 ? ` · ×${st.speed}` : ''}`;
    (bar.firstChild as HTMLElement).style.left = `calc(${((shown / 24) * 100).toFixed(2)}% - 1px)`;
    // the time slider follows the moving clock (unless it's being dragged)
    const inp = box.querySelector('input[type=range]') as HTMLInputElement | null;
    if (inp && document.activeElement !== inp && !inp.matches(':active') && !syncSlider(inp, +shown.toFixed(2))) { inp.value = String(+shown.toFixed(2)); const o = inp.nextElementSibling; if (o) o.textContent = fmtHour(shown); }
    if (!S.effective.sceneId) { stat.textContent = 'Pick a room first.'; return; }
    if (!r || !r.on || S.report?.room?.id !== S.effective.sceneId) { stat.textContent = room()?.environment ? 'Turn the preview on to see the live numbers.' : 'This room has no time / weather (scene.json "environment").'; return; }
    const w = r.weather;
    const wtxt = w ? (w.k < 0.99 && w.from !== w.to ? `${WEATHER_ICON[w.from as keyof typeof WEATHER_ICON]} ${WEATHER_LABEL[w.from as keyof typeof WEATHER_LABEL]} → ${WEATHER_ICON[w.to as keyof typeof WEATHER_ICON]} ${WEATHER_LABEL[w.to as keyof typeof WEATHER_LABEL]} ${Math.round(w.k * 100)}%` : `${WEATHER_ICON[w.to as keyof typeof WEATHER_ICON]} ${WEATHER_LABEL[w.to as keyof typeof WEATHER_LABEL]}`) + (w.next !== null && w.mode === 'cycle' ? ` · next change in ${Math.ceil(w.next / 60)} min` : '') : '';
    stat.textContent = `${wtxt} · darkness ${Math.round(r.darkness * 100)}% · night lights ${r.night.lit}/${r.night.total}${r.night.windows.length ? ` · windows ${r.night.windows.join(', ')}` : ''}${r.wet > 0.05 ? ` · wet ${Math.round(r.wet * 100)}%` : ''}${r.rain ? ` · ${r.rain} drops` : ''} · ${r.level} · ${r.ms} ms/frame`;
  };
  S.on((what) => { if (!box.isConnected) return; if (what === 'state') { render(); renderStat(); } else if (what === 'report') renderStat(); });
  // the clock ticks on its own (moving time); stops once the panel is gone for good
  let gone = 0;
  const tick = window.setInterval(() => { if (!box.isConnected) { if (++gone > 120) window.clearInterval(tick); return; } gone = 0; renderStat(); }, 1000);
  render();
  renderStat();
  return section('Time & weather', box);
}
