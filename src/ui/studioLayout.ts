// Studio layout (UI overhaul 2): the options come first, the 3D studio view is a monitor you size to taste.
//   • a draggable divider between the options panel and the studio view (double-click = default width; ← / → keys);
//     the width is remembered (vtp.ui.panelW)
//   • the studio view docked beside the options, as a small floating monitor (drag its bar, resize its corner), or
//     hidden (it keeps running off-screen: tracking and OBS never stop) — vtp.ui.view
//   • wide panels lay their cards out in two columns
//   • a settings search: filters the cards of the area you are in and lists matching settings in every other area
//     (Ctrl+K focuses it). The index = a built-in list + every section the studio has shown you (vtp.ui.searchIdx).
// Nothing here changes what OBS shows; `H` (clean window capture) still gives the whole window to the studio view.
import { h, toast } from './dom.ts';
import { icon } from './icons.ts';

type View = 'dock' | 'mini' | 'hidden';
const K = { w: 'vtp.ui.panelW', view: 'vtp.ui.view', mini: 'vtp.ui.miniBox', idx: 'vtp.ui.searchIdx' };
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
};
const RAIL = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')) || 78;
const MIN_W = 340, MIN_VIEW = 300;
/** The width the studio (#app) really has: the window minus a docked tool drawer (src/ui/dockTools.ts sets --vdk-w). The options
 *  panel's share is taken from THIS, so a docked drawer leaves the studio view room (1920 with a 820 px drawer: #app is 1100). */
const appWidth = () => Math.max(0, window.innerWidth - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vdk-w')) || 0));
export const defaultPanelW = () => { const a = appWidth(); return Math.round(Math.min(900, Math.max(420, a * (a < 1500 ? 0.56 : 0.48)))); };

const CSS = `
#panel { position: relative; }
.pane-div { position: absolute; top: 0; bottom: 0; right: -1px; width: 9px; cursor: col-resize; z-index: 20; touch-action: none; }
.pane-div::after { content: ''; position: absolute; top: 0; bottom: 0; right: 3px; width: 2px; background: transparent; transition: background .12s; }
.pane-div:hover::after, .pane-div.drag::after, .pane-div:focus-visible::after { background: var(--accent2); }
.pane-div .grip { position: absolute; top: 50%; right: 0; width: 8px; height: 44px; margin-top: -22px; border-radius: 4px; background: var(--card3); border: 1px solid var(--line2); opacity: .0; transition: opacity .12s; }
#panel:hover .pane-div .grip, .pane-div.drag .grip, .pane-div:focus-visible .grip { opacity: 1; }
body.pane-dragging, body.pane-dragging * { cursor: col-resize !important; user-select: none !important; }
body.pane-dragging iframe, body.pane-dragging canvas { pointer-events: none; }

/* the studio view: floating monitor / hidden (never in the clean window-capture mode) */
body:is(.vp-mini, .vp-hidden):not(.clean) #app { grid-template-columns: var(--rail-w) 1fr !important; }
body:is(.vp-mini, .vp-hidden):not(.clean) .pane-div { display: none; }
body.vp-mini:not(.clean) #viewport { position: fixed; z-index: 60; width: var(--mini-w, 440px); height: var(--mini-h, 300px); right: var(--mini-r, 18px); bottom: var(--mini-b, 18px);
  min-width: 220px; min-height: 150px; max-width: 70vw; max-height: 80vh; border-radius: 14px; border: 1px solid var(--line2); box-shadow: 0 18px 50px #000a; resize: both; overflow: hidden; }
body.vp-hidden:not(.clean) #viewport { position: fixed; width: 192px; height: 108px; left: -10000px; top: 0; pointer-events: none; }
.vp-grab { display: none; }
body.vp-mini:not(.clean) .vp-grab { display: flex; position: absolute; z-index: 40; left: 0; right: 0; top: 0; height: 26px; align-items: center; gap: 6px; padding: 0 8px; background: linear-gradient(#000c, #0000); color: #e8ecf3; font-size: 11.5px; font-weight: 600; cursor: grab; touch-action: none; user-select: none; }
body.vp-mini:not(.clean) .vp-grab:active { cursor: grabbing; }
body.vp-mini:not(.clean) .vp-grab .sp { flex: 1; }
body.vp-mini:not(.clean) .vp-grab button { background: #0008; border: 1px solid #fff3; color: #fff; border-radius: 6px; font: inherit; font-size: 11px; padding: 1px 7px; cursor: pointer; }
body.vp-mini:not(.clean) .viewbar { top: 32px; right: 8px; flex-wrap: wrap; justify-content: flex-end; max-width: calc(100% - 16px); }
body.vp-mini:not(.clean) .viewbar .btn { padding: 3px 7px; font-size: 11px; }
body.vp-mini:not(.clean) #hud .meters { display: none; }
body.vp-mini:not(.clean) #campip { width: 34%; }

.vp-seg { display: inline-flex; border: 1px solid var(--line2); border-radius: 10px; overflow: hidden; }
.vp-seg button { background: transparent; border: 0; color: var(--dim); padding: 5px 8px; cursor: pointer; display: grid; place-items: center; }
.vp-seg button + button { border-left: 1px solid var(--line2); }
.vp-seg button:hover { color: var(--text); background: var(--card2); }
.vp-seg button.on { background: var(--accent-soft); color: var(--accent); }
.vp-seg svg { width: 17px; height: 17px; }

/* two columns of cards in a wide panel: the panel body (legacy tabs / Simple cards) or a plain wrapper of sections
   (the Room / Show / Chat parts of the old Scene tab) becomes a 2-column grid; anything that is not a card spans both */
.area-body.cols2:has(> .sec, > .s-card), .area-body.cols2 > div:not([class]):has(> .sec, > .s-card, > .stg) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; align-content: start; align-items: start; }
.area-body.cols2 .stg { display: contents; }
:is(.area-body.cols2, .area-body.cols2 > div:not([class])) > :not(.sec):not(.s-card):not(details):not(section):not(.stg),
.area-body.cols2 .s-card.hero, .area-body.cols2 .lay-sec { grid-column: 1 / -1; }
.area-body.cols2 .scn-prev { max-width: 1040px; margin: 0 auto 10px; }

/* search */
.set-search { position: relative; margin-top: 10px; }
.set-search .in { display: flex; align-items: center; gap: 8px; background: var(--input); border: 1px solid var(--line2); border-radius: 10px; padding: 0 10px; }
.set-search .in:focus-within { border-color: var(--accent2); box-shadow: 0 0 0 3px var(--accent2-soft); }
.set-search .in svg { color: var(--faint); flex: none; width: 16px; height: 16px; }
.set-search input { flex: 1; min-width: 0; border: 0 !important; background: transparent !important; padding: 8px 0 !important; box-shadow: none !important; outline: none; font-size: 13px; }
.set-search input:focus-visible { outline: none !important; }
.set-search kbd { font: 10.5px Inter, system-ui, sans-serif; color: var(--faint); border: 1px solid var(--line2); border-radius: 5px; padding: 0 5px; }
.set-search .res { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 50; background: var(--card); border: 1px solid var(--line2); border-radius: 12px; box-shadow: var(--shadow); padding: 6px; max-height: 50vh; overflow-y: auto; }
.set-search .res .hd { font-size: 11.5px; color: var(--faint); padding: 4px 8px 2px; }
.set-search .res button { display: flex; width: 100%; gap: 8px; align-items: baseline; text-align: left; border: 0; background: transparent; color: var(--text); font: inherit; padding: 7px 8px; border-radius: 8px; cursor: pointer; }
.set-search .res button:hover, .set-search .res button.act { background: var(--accent2-soft); }
.set-search .res button .wh { color: var(--dim); font-size: 12px; margin-left: auto; white-space: nowrap; }
.set-search .res .none { padding: 8px; color: var(--dim); font-size: 12.5px; }
.srch-hide { display: none !important; }
.srch-hit > h3, .srch-hit > summary { box-shadow: inset 3px 0 0 var(--accent2); }

/* one type scale for every settings card: sentence-case titles, the same weight as the Simple cards */
.area-body { padding: 16px 20px 60px; }
.sec > h3.sec-h { text-transform: none; letter-spacing: 0; font-size: 13.5px; font-weight: 700; color: var(--text); margin: 0 0 10px; }
.sec .sec > h3.sec-h { font-size: 12.5px; color: var(--dim); }
.sec.collapsed > h3.sec-h { margin: 0 0 3px; color: var(--dim); }
.sec > h3.sec-h:hover { color: var(--accent2); }
@media (max-height: 820px) { #tabs { gap: 3px; padding-top: 6px; padding-bottom: 6px; } #tabs .rail-btn { height: 50px; gap: 2px; } }
`;

export interface StudioLayout {
  /** Top-bar control: docked / mini / hidden studio view. */
  viewControl: HTMLElement;
  setView(v: View): void;
}

export function initStudioLayout(): StudioLayout {
  document.head.append(h('style', { id: 'vtp-studio-layout' }, CSS));
  const root = document.documentElement;
  const panel = document.getElementById('panel')!;
  const vp = document.getElementById('viewport')!;

  // ---------------------------------------------------------------- panel width + divider
  const maxW = () => Math.max(MIN_W, appWidth() - RAIL() - MIN_VIEW);
  // the user's chosen width (null = the default share of the window); the applied width is clamped to the window
  const saved = parseInt(ls.get(K.w) || '', 10);
  let pref: number | null = Number.isFinite(saved) ? saved : null;
  let w = pref ?? defaultPanelW();
  const apply = (px: number | null, save = false) => {
    if (save) { pref = px; if (px === null) { try { localStorage.removeItem(K.w); } catch { /* off */ } } else ls.set(K.w, String(Math.round(px))); }
    w = Math.round(Math.min(maxW(), Math.max(MIN_W, px ?? pref ?? defaultPanelW())));
    root.style.setProperty('--panel-w', `${w}px`);
    div.setAttribute('aria-valuenow', String(w));
  };
  const div = h('div', { class: 'pane-div', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Options width (drag, or ← / →; double-click for the default)', tabindex: 0, 'aria-valuemin': MIN_W, title: 'Drag to resize the options · double-click: default width' }, h('span', { class: 'grip' }));
  panel.append(div);
  apply(null);
  div.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    div.classList.add('drag'); document.body.classList.add('pane-dragging');
    const left = panel.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => apply(ev.clientX - left);
    const up = () => { div.classList.remove('drag'); document.body.classList.remove('pane-dragging'); div.removeEventListener('pointermove', move); div.removeEventListener('pointerup', up); div.removeEventListener('pointercancel', up); apply(w, true); };
    div.addEventListener('pointermove', move); div.addEventListener('pointerup', up); div.addEventListener('pointercancel', up);
  });
  div.addEventListener('dblclick', () => { apply(null, true); toast(`Options width reset (${w} px)`, 'info', 1400); });
  div.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); apply(w + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 80 : 20), true); }
    else if (e.key === 'Home') { e.preventDefault(); apply(MIN_W, true); } else if (e.key === 'End') { e.preventDefault(); apply(maxW(), true); }
  });
  window.addEventListener('resize', () => apply(null));

  // ---------------------------------------------------------------- studio view: docked / mini / hidden
  let view: View = (['dock', 'mini', 'hidden'] as const).find((v) => v === ls.get(K.view)) ?? 'dock';
  const mini = (() => { try { const v = JSON.parse(ls.get(K.mini) || 'null'); return v && typeof v === 'object' ? v as { w: number; h: number; r: number; b: number } : null; } catch { return null; } })() ?? { w: 440, h: 300, r: 18, b: 18 };
  const paintMini = () => { for (const [k, v] of Object.entries({ '--mini-w': mini.w, '--mini-h': mini.h, '--mini-r': mini.r, '--mini-b': mini.b })) root.style.setProperty(k, `${Math.round(v)}px`); };
  paintMini();
  const grab = h('div', { class: 'vp-grab', title: 'Drag to move · resize from the bottom-right corner' }, h('span', null, 'Studio view'), h('span', { class: 'sp' }),
    h('button', { title: 'Dock the studio view beside the options', onClick: () => setView('dock') }, 'Dock'),
    h('button', { title: 'Hide the studio view (it keeps running for OBS and tracking)', onClick: () => setView('hidden') }, 'Hide'));
  vp.append(grab);
  grab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault(); grab.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, r0 = mini.r, b0 = mini.b;
    const move = (ev: PointerEvent) => {
      const bw = vp.offsetWidth, bh = vp.offsetHeight;
      mini.r = Math.min(window.innerWidth - bw - 4, Math.max(4, r0 - (ev.clientX - x0)));
      mini.b = Math.min(window.innerHeight - bh - 4, Math.max(4, b0 - (ev.clientY - y0)));
      paintMini();
    };
    const up = () => { grab.removeEventListener('pointermove', move); grab.removeEventListener('pointerup', up); ls.set(K.mini, JSON.stringify(mini)); };
    grab.addEventListener('pointermove', move); grab.addEventListener('pointerup', up);
  });
  // native corner resize (CSS resize: both) → remember the size
  let rsT = 0;
  new ResizeObserver(() => {
    if (view !== 'mini' || document.body.classList.contains('clean')) return;
    clearTimeout(rsT);
    rsT = window.setTimeout(() => { const bw = vp.offsetWidth, bh = vp.offsetHeight; if (bw > 100 && bh > 80 && (Math.abs(bw - mini.w) > 2 || Math.abs(bh - mini.h) > 2)) { mini.w = bw; mini.h = bh; vp.style.width = vp.style.height = ''; paintMini(); ls.set(K.mini, JSON.stringify(mini)); } }, 250);
  }).observe(vp);

  const seg = h('div', { class: 'vp-seg', role: 'radiogroup', 'aria-label': 'Studio view' });
  const opt = (v: View, ic: string, tip: string) => h('button', { role: 'radio', title: tip, 'aria-label': tip, onClick: () => setView(v) }, icon(ic, 17));
  const bDock = opt('dock', 'dock', 'Studio view beside the options (drag the divider to size it)');
  const bMini = opt('mini', 'mini', 'Studio view as a small floating monitor');
  const bHide = opt('hidden', 'eyeoff', 'Hide the studio view (keeps running: tracking and OBS are unaffected)');
  const bPop = h('button', { title: 'Pop out what OBS shows in its own window', 'aria-label': 'Pop out the OBS view', onClick: () => { window.open('/output.html?preview=1&fps=20&tier=medium', 'vtp-scene-preview', 'width=960,height=540'); } }, icon('popout', 17));
  seg.append(bDock, bMini, bHide, bPop);
  function setView(v: View) {
    view = v; ls.set(K.view, v);
    document.body.classList.toggle('vp-mini', v === 'mini');
    document.body.classList.toggle('vp-hidden', v === 'hidden');
    for (const [b, id] of [[bDock, 'dock'], [bMini, 'mini'], [bHide, 'hidden']] as const) { b.classList.toggle('on', v === id); b.setAttribute('aria-checked', String(v === id)); }
    apply(null);
  }
  setView(view);
  return { viewControl: seg, setView };
}

// ================================================================ two columns in wide panels
export function watchColumns(body: HTMLElement) {
  const ro = new ResizeObserver(() => {
    const wide = body.clientWidth >= 860 && !['voice', 'party', 'games'].includes(body.dataset.ui ?? '');
    if (body.classList.contains('cols2') !== wide) body.classList.toggle('cols2', wide);
  });
  ro.observe(body);
  return () => ro.disconnect();
}

// ================================================================ settings search
export interface SearchHit { t: string; area: string; sub?: string; where: string }
/** Built-in index: the sections of every area (what someone would type → where it lives). */
const SEED: [string, string, string | undefined, string][] = [
  // [title, area, legacy sub, area label]
  ['Your avatar · import a model', 'me', undefined, 'Me'], ['Outfit · accessories', 'me', undefined, 'Me'], ['Surface style (felt, plush, clay…)', 'me', undefined, 'Me'], ['Real size', 'me', undefined, 'Me'],
  ['Emotes', 'me', undefined, 'Me'], ['Camera framing (head / bust / full body)', 'me', undefined, 'Me'],
  ['Loaded model · scale · position', 'me', 'avatars', 'Me › Avatars'], ['Create a costume with AI', 'me', 'wardrobe', 'Me › Outfits'], ['Costume labels · import costume', 'me', 'wardrobe', 'Me › Outfits'],
  ['Eyes · blink · gaze', 'me', 'face', 'Me › Face'], ['Mouth · teeth · lips', 'me', 'face', 'Me › Face'], ['Test expressions', 'me', 'face', 'Me › Face'], ['Look · blush · tint', 'me', 'face', 'Me › Face'],
  ['Rig · soft rig', 'me', 'body', 'Me › Body & physics'], ['Physics · jiggle · hair', 'me', 'body', 'Me › Body & physics'], ['Food & drinks (fun)', 'me', 'body', 'Me › Body & physics'], ['Emotes (VRMA)', 'me', 'body', 'Me › Body & physics'],
  // the Hands / Body switches (Simple → Tracking; Advanced → Tracking → Camera): "hand tracking off", "body tracking off"
  ['Hand tracking on / off (Hands switch)', 'live', undefined, 'Tracking'], ['Body tracking on / off (Body switch)', 'live', undefined, 'Tracking'],
  ['Camera · webcam · resolution', 'live', 'tracking', 'Tracking'], ['Calibration · neutral face', 'live', 'tracking', 'Tracking'], ['Depth & mouth detail', 'live', 'tracking', 'Tracking'], ['Feel · smoothing · expressiveness', 'live', 'tracking', 'Tracking'],
  ['Expressions', 'live', 'tracking', 'Tracking'], ['Arms & hands · body tracking', 'live', 'tracking', 'Tracking'], ['Voice lip-sync', 'live', 'tracking', 'Tracking'], ['Fine tuning · gains', 'live', 'tracking', 'Tracking'],
  ['Neck & head', 'live', 'tracking', 'Tracking'], ['External tracking (VTS phone, iFacialMocap, VMC)', 'live', 'tracking', 'Tracking'],
  ['Microphone · noise filter · voice', 'live', 'voice', 'Tracking › Voice'], ['Phone tracking', 'live', 'voice', 'Tracking › Voice'], ['Second camera (multicam)', 'live', 'voice', 'Tracking › Voice'], ['Speaking profile', 'live', 'voice', 'Tracking › Voice'],
  ['Room · change room', 'room', 'scene', 'Room'], ['Room camera · camera move', 'room', 'scene', 'Room'], ['Who sits where · spots · walk in', 'room', 'scene', 'Room'], ['Avatar size in the room', 'room', 'scene', 'Room'],
  ['Time & weather', 'room', 'scene', 'Room'], ['Eras', 'room', 'scene', 'Room'], ['Graphics quality', 'room', 'scene', 'Room'], ['Avatar detail (very detailed avatars · lighter · LOD)', 'room', 'scene', 'Room'], ['Lights · lighting states', 'room', 'scene', 'Room'],
  ['Kitchen', 'room', 'scene', 'Room'], ['Club', 'room', 'scene', 'Room'], ['Space battle', 'room', 'scene', 'Room'], ['Yacht life', 'room', 'scene', 'Room'], ['Lounge events · donations · gifted subs', 'room', 'scene', 'Room'], ['Describe your room (AI)', 'room', undefined, 'Room'],
  ['Show mode (Talk · React · Gaming)', 'show', 'show', 'Show & layout'], ['Layout editor · corner cam size · position', 'show', 'show', 'Show & layout'], ['Custom layout · cam tiles · safe margin', 'show', 'show', 'Show & layout'],
  ['Docked chat panel · support ticker · chat text size', 'show', 'show', 'Show & layout'], ['Names on screen', 'show', 'show', 'Show & layout'], ['Game / window capture · fit my capture', 'show', 'show', 'Show & layout'],
  ['Hide my screen (capture cover)', 'show', 'show', 'Show & layout'], ['Transitions (room change)', 'show', 'show', 'Show & layout'], ['Screen video · playlists · BRB', 'show', 'show', 'Show & layout'], ['React screen', 'show', 'show', 'Show & layout'],
  ['Chat & events · connect chats', 'chat', 'chatev', 'Chat & events'], ['Raid', 'chat', 'chatev', 'Chat & events'], ['Slap!', 'chat', 'chatev', 'Chat & events'], ['Donations · read aloud · Chat Hub', 'chat', 'chatev', 'Chat & events'],
  ['Games · The Trail · tabletop RPG', 'games', undefined, 'Games'],
  ['Party · Discord · invite', 'friends', undefined, 'Party'], ['TURN · hide my IP · allow-list · bans', 'friends', 'party', 'Party'],
  ['Browser Source URL', 'stream', 'output', 'OBS & stream'], ['Output size & position', 'stream', 'output', 'OBS & stream'], ['Studio view', 'stream', 'output', 'OBS & stream'],
  ['OBS automation · WebSocket password', 'stream', 'obs', 'OBS & stream'], ['OBS passthrough (fallback)', 'stream', 'obs', 'OBS & stream'], ['OBS setup', 'stream', 'obs', 'OBS & stream'],
  ['Make an avatar with AI', 'create', undefined, 'Create'], ['Avatar builder · local AI 3D (ComfyUI)', 'create', 'create', 'Create'],
  ['Theme · light / dark', 'settings', undefined, 'Settings'], ['Layout · new / classic (the old arrangement)', 'settings', undefined, 'Settings'], ['Guided set-ups (wizards)', 'settings', undefined, 'Settings'], ['Performance', 'settings', undefined, 'Settings'], ['Keyboard shortcuts', 'settings', undefined, 'Settings'],
  ['AI apps and local AI', 'settings', 'settings', 'Settings'], ['Models & tools · Blender · ComfyUI', 'settings', 'settings', 'Settings'], ['Credits', 'settings', 'settings', 'Settings'],
];

function learned(): SearchHit[] { try { const v = JSON.parse(ls.get(K.idx) || '[]'); return Array.isArray(v) ? v.filter((x) => x && typeof x.t === 'string') : []; } catch { return []; } }
/** Remember the section titles an area shows (so search finds settings that other workstreams add later). */
export function learnSections(body: HTMLElement, area: string, sub: string | undefined, where: string) {
  const titles = new Set<string>();
  for (const e of body.querySelectorAll('.sec > h3, .s-card > h3, details > summary')) { const t = (e.textContent ?? '').replace(/\s+/g, ' ').trim(); if (t && t.length <= 70) titles.add(t); }
  if (!titles.size) return;
  const all = learned().filter((x) => !(x.area === area && x.sub === sub && titles.has(x.t)));
  for (const t of titles) all.push({ t, area, ...(sub ? { sub } : {}), where });
  ls.set(K.idx, JSON.stringify(all.slice(-400)));
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text: string, ws: string[]) => { const t = text.toLowerCase(); return ws.every((w) => t.includes(w)); };

/** The search box for the area header. `jump(area, sub)` opens a result elsewhere. */
export function searchBox(body: HTMLElement, current: () => string, jump: (area: string, sub?: string) => void, actions?: (q: string) => { t: string; where: string; run(): void }[]): HTMLElement {
  const input = h('input', { type: 'search', placeholder: actions ? 'Search or run… (“BRB”, “mic”, “outfit”)' : 'Search settings…', 'aria-label': actions ? 'Search settings or run a live action' : 'Search settings', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
  const res = h('div', { class: 'res', role: 'listbox', style: 'display:none' });
  const wrap = h('div', { class: 'set-search' }, h('div', { class: 'in' }, icon('search', 16), input, h('kbd', null, 'Ctrl K')), res);
  let q = '';
  let act = -1;
  const shown: HTMLButtonElement[] = [];
  const cands = () => {
    const all = [...body.querySelectorAll('.sec, .s-card, details, .stg-row, .row')] as HTMLElement[];
    // only the outermost cards (their inner rows are matched through them)
    return all.filter((e) => e.matches('.sec, .s-card, details') && !e.parentElement?.closest('.sec, .s-card, details'));
  };
  const filter = () => {
    const ws = words(q);
    for (const e of body.querySelectorAll('.srch-hide, .srch-hit')) e.classList.remove('srch-hide', 'srch-hit');
    for (const e of body.querySelectorAll('[data-srch-open]')) { const x = e as HTMLElement; if (x.tagName === 'SECTION') x.classList.add('collapsed'); else (x as HTMLDetailsElement).open = false; delete x.dataset.srchOpen; }
    if (!ws.length) return 0;
    let n = 0;
    for (const c of cands()) {
      const hit = matches(c.textContent ?? '', ws) || [...c.querySelectorAll('input[placeholder], [title], [aria-label]')].some((x) => matches(`${x.getAttribute('placeholder') ?? ''} ${x.getAttribute('title') ?? ''} ${x.getAttribute('aria-label') ?? ''}`, ws));
      c.classList.toggle('srch-hide', !hit); c.classList.toggle('srch-hit', hit);
      if (hit) {
        n++;
        if (c.tagName === 'SECTION' && c.classList.contains('collapsed')) { c.classList.remove('collapsed'); c.dataset.srchOpen = '1'; }
        if (c.tagName === 'DETAILS' && !(c as HTMLDetailsElement).open) { (c as HTMLDetailsElement).open = true; c.dataset.srchOpen = '1'; }
      }
    }
    return n;
  };
  const list = () => {
    shown.length = 0; act = -1;
    const ws = words(q);
    if (!ws.length) { res.style.display = 'none'; return; }
    const here = filter();
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const [t, area, sub, where] of SEED) if (matches(`${t} ${where}`, ws)) hits.push({ t, area, ...(sub ? { sub } : {}), where });
    for (const x of learned()) if (matches(`${x.t} ${x.where}`, ws)) hits.push(x);
    const cur = current();
    const rows = hits.filter((x) => { const k = `${x.area}|${x.sub ?? ''}|${x.t.toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
    // livedash: Live Control actions matching the text run right here (Enter runs the first one)
    const acts = actions ? actions(q) : [];
    const actBtns = acts.map((x) => { const b = h('button', { role: 'option', class: 'run', onMouseDown: (e: Event) => e.preventDefault(), onClick: () => { res.style.display = 'none'; input.value = q = ''; filter(); x.run(); } }, h('span', null, x.t), h('span', { class: 'wh' }, x.where)) as HTMLButtonElement; shown.push(b); return b; });
    if (actBtns.length) { act = 0; actBtns[0].classList.add('act'); }
    // (clarity: an action that matches is a result: don't also say "nothing matches"; "(others hidden)" read like
    // results were being kept from you)
    const onlyActs = actBtns.length > 0 && !rows.length && !here;
    res.replaceChildren(...(actBtns.length ? [h('div', { class: 'hd' }, 'Run'), ...actBtns] : []),
      ...(onlyActs ? [] : [h('div', { class: 'hd' }, here ? `${here} match${here > 1 ? 'es' : ''} here. Other settings in this area are hidden while you search.` : 'Nothing in this area')]),
      ...(rows.length ? rows.map((x) => {
        const b = h('button', { role: 'option', onMouseDown: (e: Event) => e.preventDefault(), onClick: () => go(x) }, h('span', null, x.t), h('span', { class: 'wh' }, x.area === cur ? `${x.where} (here)` : x.where)) as HTMLButtonElement;
        shown.push(b); return b;
      }) : onlyActs ? [] : [h('div', { class: 'none' }, here ? 'No other areas match.' : 'No setting matches. Try one word, like “chat”, “cam” or “size”.')]));
    res.style.display = '';
  };
  const go = (x: SearchHit) => { res.style.display = 'none'; jump(x.area, x.sub); setTimeout(() => { filter(); (body.querySelector('.srch-hit') as HTMLElement | null)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 350); };
  input.addEventListener('input', () => { q = input.value; list(); });
  input.addEventListener('focus', () => { if (q) list(); });
  input.addEventListener('blur', () => setTimeout(() => { res.style.display = 'none'; }, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (q) { input.value = q = ''; filter(); res.style.display = 'none'; } else input.blur(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!shown.length) return; act = (act + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; shown.forEach((b, i) => b.classList.toggle('act', i === act)); shown[act].scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'Enter') { e.preventDefault(); if (act >= 0) shown[act].click(); else { res.style.display = 'none'; (body.querySelector('.srch-hit') as HTMLElement | null)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }
  });
  // re-renders replace the cards: keep the filter on
  let mt = 0;
  new MutationObserver(() => { if (!q) return; clearTimeout(mt); mt = window.setTimeout(filter, 120); }).observe(body, { childList: true, subtree: true });
  window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); input.select(); } }, true);
  return wrap;
}
