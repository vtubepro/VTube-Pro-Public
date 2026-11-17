// Scene tab → the show: one-click mode bar (Talk · React · Gaming · modes other workstreams register), the current
// mode's presets right under it (src/ui/stage/panels/*), a live picture of the layout OBS is drawing, where chat +
// support go, and the one OBS step (a capture under the browser source) with a line-up test and a one-click fit.
// Keyboard: Shift+T / R / G (each mode's `key`), Shift+< / Shift+> = previous / next preset of the current mode.
import type { App } from '../app.ts';
import { HOST_KEY } from '../../shared/scene.ts';
import type { ObsFitReport, ObsProbe } from '../../shared/obs.ts';
import { cameraNote } from '../../shared/cameraHelp.ts';
import { CONTENT_ASPECTS, GAMING_LAYOUTS, REACT_PRESETS, type DockMode, type Rect, type StagePlan } from '../../shared/stage.ts';
import { stageModeList, stageModeDef } from '../scene/stage/registry.ts';
import { modePanel } from './stage/panelRegistry.ts';
import { STAGE_CSS, canvasAspect, canvasSize, nameOf } from './stage/common.ts';
import { layoutSvg } from './stage/layoutSvg.ts';
import { lookSection } from './stage/lookPanel.ts';
import { button, h, section, select, sliderControl, toast } from './dom.ts';
import { gamingHelp } from './gamingHelp.ts';

let cssDone = false;
const HELPER_DONE = 'vtp.stage.helperDone';
const FIT_SOURCE = 'vtp.stage.fitSource';
let probe: ObsProbe | null = null;
let fitOut: ObsFitReport | null = null;

export function stageSection(app: App): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, STAGE_CSS)); cssDone = true; }
  const S = app.scene, st = S.stage, eff = S.effective, edit = S.canEdit;
  const modes = stageModeList();
  const bar = h('div', { class: 'stg-modes' }, ...modes.map((m) => h('button', {
    class: `stg-mode ${eff.mode === m.id ? 'on' : ''}`, disabled: !edit, title: `${m.hint ?? m.label}${m.key ? ` (Shift+${m.key})` : ''}`,
    onClick: () => { S.setMode(m.id); toast(`${m.icon} ${m.label}`, 'ok', 1100); },
  }, h('span', { class: 'ic' }, m.icon), h('b', null, m.label), m.key ? h('kbd', null, `⇧${m.key}`) : null)));
  const cur = stageModeDef(eff.mode);
  let sub: HTMLElement | null = null;
  try { sub = modePanel(eff.mode)?.(app, S) ?? null; } catch (e) { console.warn('[stage] panel', e); }
  // ---- live layout (what the preview page is drawing: the same plan every OBS page draws)
  const rep = S.report?.stage;
  const aspect = canvasAspect();
  let live: HTMLElement | null = null;
  if (rep && eff.sceneId) {
    const plan: StagePlan | null = rep.view === 'composite' || rep.tiles.length || rep.capture
      ? { key: rep.key, view: rep.view as StagePlan['view'], label: rep.label, capture: rep.capture as Rect | null, tiles: rep.tiles.map((t) => ({ key: t.key, rect: t.rect, framing: 'bust', backdrop: 'room', tag: 'inside', ...(t.hero ? { hero: true } : {}) })), docks: { chat: rep.docks.chat, support: rep.docks.support } }
      : null;
    const svg = rep.view === 'composite' || plan ? layoutSvg(plan, { width: 330, aspect, name: nameOf(S), size: 'live', captureLabel: eff.mode === 'gaming' ? 'GAME' : 'WINDOW' }) : null;
    live = svg ? h('div', { class: 'stg-live' }, svg as unknown as Node, h('span', { class: 'cap' }, `Live · ${rep.label}${rep.rail.length ? ` · ${rep.rail.length} cam${rep.rail.length > 1 ? 's' : ''}` : ''}`)) : null;
  }
  // ---- docks
  const dockSel = (label: string, k: 'chat' | 'support', v: DockMode) => {
    const s = select(label, v, [['auto', 'Auto — when the room can’t show it'], ['always', 'Always docked'], ['off', 'Never docked']], (x) => S.setStage({ dock: { ...st.dock, [k]: x } }), 'Docked panels sit in free space (never over faces or the window) in the room’s colours');
    (s.querySelector('select') as HTMLSelectElement).disabled = !edit;
    return s;
  };
  const hole = !!cur?.hole && !!eff.sceneId;
  // what this mode's camera does by itself + how to keep one shot (a tester read Interview's auto director cutting
  // between the desk close-up and the wide shot as a zoom bug)
  const camText = eff.sceneId ? cameraNote(eff.mode, { director: (eff.modes?.interview as { director?: string } | undefined)?.director, ambient: !!eff.ambcam?.on, afk: !!eff.afk?.on }) : null;
  return h('div', { class: 'stg' },
    section('Show mode', bar,
      camText ? h('p', { class: 'note', 'data-camnote': eff.mode, style: 'margin:6px 0' }, camText) : null,
      sub,
      live,
      eff.sceneId ? null : h('p', { class: 'note' }, 'Pick a room first (Gaming takes you to the Gaming Lounge if it is installed).'),
      h('p', { class: 'note', style: 'margin-top:6px' }, 'Chat and support always stay on screen: the in-world chat monitor, support board and Sprocket when they fit the shot, else docked panels.'),
      dockSel('Chat panel', 'chat', st.dock.chat), dockSel('Support panel', 'support', st.dock.support),
      chatTextRow(app)),
    lookSection(app),
    namesSection(app),
    hole ? captureHelper(app) : null,
  );
}

/** Docked chat panel text size (the OBS pages' docked chat; the in-world chat monitor has its own size). */
function chatTextRow(app: App): HTMLElement {
  const S = app.scene, edit = S.canEdit, pct = Math.round((S.stage.chatText ?? 1) * 100);
  const set = (v: number) => { const x = Math.min(160, Math.max(60, Math.round(v))); if (Number.isFinite(x)) S.setStage({ chatText: x / 100 }); };
  // slider + number box (%) + ↺ (100 %): sliderControl in dom.ts
  const ctl = sliderControl(pct, 60, 160, 5, set, { inline: true, commit: true, disabled: !edit, label: 'Chat text size', unit: '%', def: 100, snap: false });
  return h('div', { class: 'stg-row', title: 'Size of the text in the docked chat panel on your OBS pages (100 % ≈ 18 px at 1080p)' },
    h('span', { class: 'lbl' }, 'Chat text size'), ctl);
}

/** "My name on screen": the name on your cam's tag — everywhere, or just in this room; the host can rename guests' tags. */
function namesSection(app: App): HTMLElement {
  const S = app.scene, eff = S.effective, edit = S.canEdit, mine = S.myNames(), names = S.stage.names ?? {};
  const room = eff.sceneId, roomName = room ? (S.scenes.find((x) => x.id === room)?.name ?? room) : '';
  const own = new Map(S.members().map((m) => [m.key, m.name.replace(/\s*\((host|you|test)\)$/i, '').replace(/\s*\(@.*?\)$/, '')]));
  const field = (label: string, value: string, placeholder: string, on: (v: string) => void, tip: string) => h('div', { class: 'stg-row', title: tip },
    h('span', { class: 'lbl' }, label),
    h('input', { type: 'text', value, placeholder, maxLength: 32, disabled: !edit, style: 'flex:1;min-width:0',
      onChange: (e: Event) => on((e.target as HTMLInputElement).value),
      onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); } }));
  const guests = S.members().filter((m) => m.key !== HOST_KEY && eff.present[m.key] !== false);
  return section('Names on screen',
    field('My name', mine.def, own.get(HOST_KEY) || 'Your name', (v) => { S.setMyName(v, 'default'); toast(v.trim() ? `Your cams now say “${v.trim()}”` : 'Name reset', 'ok', 1400); },
      'The name on your cam’s tag in every room (empty = your profile name)'),
    room ? field('In this room', mine.rooms[room] ?? '', mine.def || 'same as above', (v) => S.setMyName(v, 'room'),
      `Only in ${roomName}: overrides the name above here (empty = use the name above)`) : null,
    ...(edit ? guests.map((m) => field(own.get(m.key) ?? m.key, names[m.key] ?? '', `${own.get(m.key) ?? 'Guest'} (their own name)`, (v) => S.setGuestName(m.key, v),
      'What this guest’s cam tag says on every OBS page (empty = the name they chose)')) : []),
    h('p', { class: 'note' }, 'Shown on the cam name tags in every layout, on your OBS and your guests’. Guests keep their own names unless you change them here.'));
}

/** The one OBS step for React / Gaming (window, game or display capture under the browser source) + test + fit. */
function captureHelper(app: App): HTMLElement {
  const S = app.scene, st = S.stage, eff = S.effective;
  const [W, H] = canvasSize();
  const cap = S.report?.stage?.capture ?? null;
  const gaming = eff.mode === 'gaming';
  const nums = cap ? `Position  x ${Math.round(cap.x * W)}   y ${Math.round(cap.y * H)}\nSize      ${Math.round(cap.w * W)} × ${Math.round(cap.h * H)}   (${W}×${H} canvas)` : 'Turn the Scene preview on to measure the box.';
  const det = h('details', { class: 'stg-help', open: localStorage.getItem(HELPER_DONE) !== '1' });
  const srcs = (probe?.inputs ?? []).filter((i) => /window_capture|game_capture|monitor_capture|screen_capture|xcomposite|pipewire|av_capture/.test(i.kind));
  const kindName = (k: string) => (/game/.test(k) ? 'Game Capture' : /window|xcomposite/.test(k) ? 'Window Capture' : /monitor|screen|pipewire/.test(k) ? 'Display Capture' : k);
  let pick = localStorage.getItem(FIT_SOURCE) || srcs[0]?.name || '';
  const srcSel = h('select', { style: 'flex:1;min-width:0', onChange: (e: Event) => { pick = (e.target as HTMLSelectElement).value; localStorage.setItem(FIT_SOURCE, pick); } },
    ...(srcs.length ? srcs : pick ? [{ name: pick, kind: '' }] : []).map((i) => h('option', { value: i.name, selected: i.name === pick }, i.kind ? `${i.name} · ${kindName(i.kind)}` : i.name)));
  const fit = async (how: 'fit' | 'fill') => {
    if (S.observer) { toast('Observer sandbox: OBS is never touched', 'warn'); return; }
    if (!pick) { toast('Load your OBS sources and pick the capture first', 'warn'); return; }
    try {
      fitOut = await (await fetch('/api/obs/fit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: pick, rect: cap, fit: how }) })).json() as ObsFitReport;
      toast(fitOut.ok ? `“${pick}” fitted to the ${gaming ? 'game' : 'window'} box` : fitOut.error ?? 'Could not fit', fitOut.ok ? 'ok' : 'warn', 3500);
    } catch (e) { toast(`OBS: ${(e as Error).message}`, 'warn'); }
    app.scene.poke();
  };
  const load = async () => {
    try { probe = await (await fetch('/api/obs/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as ObsProbe; }
    catch (e) { probe = { ok: false, error: (e as Error).message }; }
    if (!probe.ok) toast(`Can’t reach OBS: ${probe.error ?? '?'} — set it up under OBS automation (WebSocket password)`, 'warn', 5000);
    app.scene.poke();
  };
  det.append(h('summary', null, h('b', null, gaming ? '🎮 Show your game (one OBS step)' : '🖥 Show your window (one OBS step)')), h('div', null,
    h('ol', null,
      h('li', null, 'In OBS, add a capture of your ', gaming ? 'game' : 'window', ' and drag it ', h('b', null, 'below'), ' the VTube Pro browser source:',
        h('ul', { style: 'margin:3px 0 3px 14px;padding:0' },
          h('li', null, h('b', null, 'Game Capture'), ' — best for games (fast). Shows black? Some games / anti-cheat block it: VTube Pro notices and offers a one-click switch to Display Capture or Window Capture (below).'),
          h('li', null, h('b', null, 'Window Capture'), ' — browsers, videos, apps, most games (Capture method: “Windows 10 (1903 and up)”).'),
          h('li', null, h('b', null, 'Display Capture'), ' — the whole monitor; works when the other two show black (exclusive fullscreen, some launchers). With several monitors pick the right one in its Properties → Display, and set the capture aspect below (21:9 ultrawide…).'))),
      h('li', null, 'Put it exactly in the box — one click below, or type these into Transform → Edit Transform (Bounding Box: Scale to inner bounds, Alignment Top Left):'),
      h('li', null, 'Press ', h('b', null, 'Show line-up test'), ': OBS shows a grid and a pink edge where your capture must sit.')),
    h('div', { class: 'stg-nums' }, nums),
    h('div', { class: 'btns tight' }, button('Copy numbers', () => { void navigator.clipboard.writeText(nums); toast('Copied', 'ok'); }),
      button('Show line-up test (12 s)', () => { S.lineupTest(true); toast('Line-up test on your OBS for 12 s', 'ok'); }, 'primary'),
      localStorage.getItem(HELPER_DONE) !== '1' ? button('Got it', () => { localStorage.setItem(HELPER_DONE, '1'); det.open = false; }) : null),
    h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Capture'), srcSel, button(srcs.length ? '↻' : 'Load OBS sources', () => void load())),
    h('div', { class: 'btns tight' },
      button('Fit my capture to the layout', () => void fit('fit'), 'primary'),
      button('Fill (crop edges)', () => void fit('fill'))),
    h('p', { class: 'note' }, 'Fit only changes that capture’s position / size in OBS, only when you click it (needs the OBS WebSocket password under OBS automation). Change the layout later? Click it again.'),
    fitOut ? h('div', { class: 'note', style: fitOut.ok ? '' : 'color:var(--warn,#e0a030)' }, fitOut.ok ? `✔ ${fitOut.placed}` : `⚠ ${fitOut.error}`, ...fitOut.warnings.map((w) => h('div', { style: 'color:var(--warn,#e0a030)' }, '⚠ ', w))) : null,
    gamingHelp(app, () => app.scene.poke()),                       // Game Capture shows nothing → one-click Display / Window Capture; OBS-side tips for a lag-free stream
    select('Capture aspect', String(CONTENT_ASPECTS.find((a) => Math.abs(a - (st.content ?? 16 / 9)) < 0.02) ?? 16 / 9), CONTENT_ASPECTS.map((a): [string, string] => [String(a), a === 16 / 9 ? '16:9 (most games / video)' : a === 16 / 10 ? '16:10 (laptops)' : a === 21 / 9 ? '21:9 ultrawide' : a === 32 / 9 ? '32:9 super-ultrawide' : '4:3 (retro)']),
      (v) => S.setStage({ content: parseFloat(v) }), 'The box keeps this shape so the capture fills it exactly'),
  ));
  return section(gaming ? 'Game capture' : 'Window capture', det);
}

/** Studio keys: Shift+<mode key> switches mode; Shift+< / Shift+> steps through the current mode's presets. */
export function stageKeys(e: KeyboardEvent, app: App): boolean {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  const S = app.scene;
  if (!S.canEdit) return false;
  const k = e.key.length === 1 ? e.key.toUpperCase() : '';
  const def = stageModeList().find((m) => m.key && m.key.toUpperCase() === k);
  if (def) { e.preventDefault(); S.setMode(def.id); toast(`${def.icon} ${def.label}`, 'ok', 1100); return true; }
  if (e.key === '<' || e.key === '>') {
    const d = e.key === '>' ? 1 : -1, st = S.stage, mode = S.effective.mode;
    if (mode === 'react') { const i = REACT_PRESETS.indexOf(st.react); const v = REACT_PRESETS[(i + d + REACT_PRESETS.length) % REACT_PRESETS.length]; S.setStage({ react: v }); toast(`React: ${v}`, 'ok', 1000); }
    else if (mode === 'gaming') { const i = GAMING_LAYOUTS.indexOf(st.gaming); const v = GAMING_LAYOUTS[(i + d + GAMING_LAYOUTS.length) % GAMING_LAYOUTS.length]; S.setStage({ gaming: v }); toast(`Gaming: ${v}`, 'ok', 1000); }
    else return false;
    e.preventDefault();
    return true;
  }
  return false;
}
