// Premium polish layer (UX pass 3): one type scale + spacing + motion tokens on top of theme.ts, a consistent button
// hierarchy and focus ring, styled tooltips for every `title` (plus plain-language explanations for jargon words in
// labels), "G then a letter" area jumps, the grouped keyboard-shortcut sheet (?), and error toasts that say how to fix
// the problem. Purely additive: nothing here changes a setting, and every legacy panel keeps working untouched.
import { h, setToastHelp } from './dom.ts';
import { icon } from './icons.ts';
import { stageModeList } from '../scene/stage/registry.ts';
import { HOME_CSS } from './home.ts';
import { loadHideScreenKey } from '../../shared/hotkey.ts';

const safeLs = () => { try { return localStorage; } catch { return null; } };

// ================================================================ jargon → plain words (tooltips on labels)
export const GLOSSARY: [RegExp, string, string][] = [
  [/\bBrowser Source\b/i, 'Browser Source', 'The OBS source that shows a web page. VTube Pro’s output page goes in one, with a see-through background.'],
  [/\bWebSocket\b/i, 'WebSocket', 'How VTube Pro talks to OBS remotely (switching scenes for you). Turn it on in OBS → Tools → WebSocket Server Settings.'],
  [/\bVMC\b/, 'VMC', 'A standard way for tracking apps to send motion to each other over your network (Virtual Motion Capture).'],
  [/\bOSC\b/, 'OSC', 'A network message format some tracking apps and controllers use.'],
  [/\bVRMA\b/, 'VRMA', 'An animation file for VRM avatars (a wave, a dance). Works on any VRM model.'],
  [/\bVRM\b/, 'VRM', 'The standard avatar file for VTubers (VRoid Studio exports it). Comes with its face expressions built in.'],
  [/\bSMAA\b/, 'SMAA', 'Smooths jagged edges. Costs a little GPU.'],
  [/\bN8AO\b|\bSSAO\b|\bambient occlusion\b/i, 'Ambient occlusion', 'Soft contact shadows in corners and under objects. Looks richer, costs GPU.'],
  [/\bHDRI\b/, 'HDRI', 'A 360° photo used as the sky and to light the scene realistically.'],
  [/\bLUT\b/, 'LUT', 'A colour grade: a preset “look” applied to the whole picture.'],
  [/\bbloom\b/i, 'Bloom', 'A soft glow around bright lights and neon.'],
  [/\bARKit\b/, 'ARKit', 'Apple’s list of 52 face shapes (blink, smile, jaw open…). Most face tracking speaks it.'],
  [/\bblendshapes?\b|\bshape keys?\b|\bmorphs?\b/i, 'Face shapes', 'Pre-made face movements in the model (blink, smile, mouth open) that tracking blends together.'],
  [/\bvisemes?\b/i, 'Mouth shapes', 'The mouth positions for speech sounds (A, I, U, E, O). Lip sync picks them from your voice.'],
  [/\bIK\b/, 'IK', 'Inverse kinematics: the arm or leg follows where the hand or foot should be.'],
  [/\bsidecar\b/i, 'Add-on program', 'A small program VTube Pro runs next to itself (for GPU tracking). It restarts by itself if it stops.'],
  [/\bAudio2Face\b/i, 'Audio2Face', 'NVIDIA’s GPU lip sync: moves the whole face from your voice. Needs an RTX card.'],
  [/\bMaxine\b/i, 'Maxine', 'NVIDIA’s GPU face tracking: finer expressions than the webcam model. Needs an RTX card.'],
  [/\bRTMW\b/, 'RTMW', 'A GPU body + finger tracker (OpenMMLab) that steadies arms and hands. You download it on your click; its model was trained on research-licensed data.'],
  [/\bTURN\b/, 'TURN', 'A relay server for multiplayer, so guests never see your home IP address.'],
  [/\brelay\b/i, 'Relay', 'A small server that passes party data between friends when a direct connection is not possible.'],
  [/\bPiP\b/, 'Picture in picture', 'A small window on top of the main view.'],
  [/\bchroma\b/i, 'Chroma key', 'Removes a solid colour background (green screen).'],
  [/\bpassthrough\b/i, 'Passthrough', 'A see-through hole in the output: OBS shows your real game capture through it, at full quality.'],
  [/\btier\b/i, 'Quality tier', 'A bundle of graphics settings. Lower it if the avatar stutters.'],
  [/\bsmoothing\b/i, 'Smoothing', 'Calms jitter. More smoothing = steadier but a little slower to react.'],
  [/\blatency\b|\blag\b/i, 'Delay', 'How long it takes your movement to reach the avatar. Under 60 ms feels instant.'],
  [/\bcalibrat/i, 'Calibrate', 'Teaches the app what your face looks like at rest, so small movements read correctly.'],
  [/\bfps\b/i, 'FPS', 'Frames per second: how smooth the picture is. 60 is ideal for streaming.'],
  [/\bHz\b/, 'Hz', 'Updates per second (here: how often tracking reads your camera).'],
  [/\bspring bones?\b|\bjiggle\b/i, 'Physics', 'Hair, ears and clothes that swing and bounce by themselves.'],
];
const glossFor = (text: string) => { for (const [re, t, d] of GLOSSARY) if (re.test(text)) return `${t}: ${d}`; return null; };

// ================================================================ friendly errors: what went wrong → how to fix it
const FIXES: [RegExp, string | (() => string)][] = [
  [/NotAllowedError|permission denied|not allowed/i, 'Fix: your browser blocked it. Click the icon at the left of the address bar, set Camera / Microphone to Allow, then press the button again. On Windows also check Settings → Privacy & security → Camera / Microphone.'],
  [/NotReadableError|could not start (video|audio) source|in use|busy/i, 'Fix: another app is using the device (OBS, Discord, Zoom?). Close it there or pick a different device, then try again.'],
  [/NotFoundError|requested device not found|no camera|no microphone|device not found/i, 'Fix: plug the device in (or pick another) under Tracking, then try again.'],
  [/OverconstrainedError/i, 'Fix: this camera can’t do that picture size. Pick “Smooth (720p)” under Tracking.'],
  [/(obs).*(password|auth)/i, 'Fix: copy the password from OBS → Tools → WebSocket Server Settings → Show connect info.'],
  [/(obs).*(refused|connect|reach|closed)/i, 'Fix: open OBS and tick Tools → WebSocket Server Settings → Enable WebSocket server (port 4455).'],
  [/blender/i, 'Fix: install Blender (free, blender.org) and set its path in Settings → Advanced → Models & tools.'],
  [/\b429\b|rate.?limit/i, 'Fix: it is busy. Wait a minute, then try again.'],
  [/failed to fetch|networkerror|econnrefused|server offline|couldn.t reach the studio server|\b50[234]\b/i, () => 'Fix: the studio server isn’t answering. Keep the VTube Pro window (START_HERE) open, or start it again.'],
  [/timed? ?out|timeout/i, 'Fix: it took too long. Check your internet connection, then try again.'],
  [/webgl|context lost|gpu/i, 'Fix: the graphics card reset. Lower Settings → Performance, update your GPU driver, then reload the studio (F5).'],
  [/discord/i, 'Fix: open Party → Set up to check the Discord app ID and sign-in.'],
];
export function fixFor(msg: string): string | null {
  if (/^fix:/i.test(msg) || /\bfix:/i.test(msg)) return null;
  for (const [re, f] of FIXES) if (re.test(msg)) return typeof f === 'function' ? f() : f;
  return null;
}

// ================================================================ tooltips
function initTooltips() {
  const tip = h('div', { class: 'pm-tip', role: 'tooltip', id: 'pm-tip' });
  document.body.append(tip);
  let owner: HTMLElement | null = null, saved = '', timer = 0;
  const hide = () => {
    window.clearTimeout(timer);
    tip.classList.remove('on');
    if (owner) { if (saved && !owner.getAttribute('title')) owner.setAttribute('title', saved); owner.removeAttribute('aria-describedby'); }
    owner = null; saved = '';
  };
  const place = (el: HTMLElement) => {
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.width / 2, y = r.bottom + 8;
    if (y + t.height > innerHeight - 8) y = r.top - t.height - 8;
    x = Math.max(8, Math.min(innerWidth - t.width - 8, x));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  const show = (el: HTMLElement, text: string, delay: number) => {
    hide();
    owner = el;
    const t = el.getAttribute('title');
    if (t) { saved = t; el.removeAttribute('title'); } // no double (native) tooltip
    timer = window.setTimeout(() => {
      if (owner !== el || !el.isConnected) return;
      tip.textContent = text;
      tip.classList.add('on');
      el.setAttribute('aria-describedby', 'pm-tip');
      place(el);
    }, delay);
  };
  const find = (t: EventTarget | null): [HTMLElement, string] | null => {
    let el = t instanceof Element ? t as HTMLElement : null;
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      if (el === document.body || el.closest('iframe, canvas, #viewport canvas')) return null;
      const t2 = el.getAttribute('title') || el.dataset.gloss;
      if (t2 && t2.trim().length > 1) return [el, t2];
    }
    return null;
  };
  document.addEventListener('pointerover', (e) => {
    const hit = find(e.target);
    if (!hit) { if (owner && !(e.target instanceof Node && owner.contains(e.target))) hide(); return; }
    if (hit[0] === owner) return;
    show(hit[0], hit[1], 380);
  }, true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
  // keyboard users: focus shows the tip too (only for real keyboard focus)
  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement;
    if (!el.matches?.(':focus-visible')) return;
    const hit = find(el);
    if (hit && hit[0] === el) show(el, hit[1], 250);
  });
  document.addEventListener('focusout', () => hide());
  // mark jargon words in labels (dotted underline + plain explanation). Cheap: only visible panel labels, 1×/1.5 s.
  const SEL = '#panel .row .lbl, #panel .sec h3, #panel .s-field > span, #panel label > span:first-child, #panel .s-card > h3, #panel summary, .wiz-main .s-field > span';
  const scan = () => {
    const panel = document.getElementById('panel');
    if (!panel || document.hidden) return;
    for (const el of document.querySelectorAll<HTMLElement>(SEL)) {
      if (el.dataset.glossed === '1' || el.getAttribute('title')) continue;
      el.dataset.glossed = '1';
      const g = glossFor(el.textContent ?? '');
      if (g) { el.dataset.gloss = g; el.classList.add('pm-term'); }
    }
  };
  window.setInterval(scan, 1500);
}

// ================================================================ G + letter: jump to an area
export const JUMPS: [string, string, string][] = [
  ['h', 'home', 'Home'], ['m', 'me', 'Me'], ['t', 'live', 'Tracking'], ['r', 'room', 'Room'], ['s', 'show', 'Show & layout'],
  ['c', 'chat', 'Chat & events'], ['g', 'games', 'Games'], ['p', 'friends', 'Party'], ['o', 'stream', 'OBS & stream'],
  ['n', 'create', 'Create'], [',', 'settings', 'Settings'],
];
function initJumps(go: (area: string) => void) {
  let armed = 0;
  const hint = h('div', { class: 'pm-jump', 'aria-live': 'polite' });
  document.body.append(hint);
  const disarm = () => { armed = 0; hint.classList.remove('on'); };
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t?.closest?.('input,textarea,select,[contenteditable=true]') || e.ctrlKey || e.altKey || e.metaKey) return;
    if (document.querySelector('.wiz-back, .gh-back')) return; // a dialog is open
    const k = e.key.toLowerCase();
    if (armed && Date.now() - armed < 1600) {
      const j = JUMPS.find((x) => x[0] === k);
      e.preventDefault(); e.stopImmediatePropagation(); // don't also trigger C (calibrate) / F / H…
      disarm();
      if (j) go(j[1]);
      return;
    }
    if (k === 'g' && !e.shiftKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      armed = Date.now();
      hint.replaceChildren(h('b', null, 'Go to…'), ...JUMPS.map(([key, , label]) => h('span', null, h('span', { class: 'kbd' }, key === ',' ? ',' : key.toUpperCase()), label)));
      hint.classList.add('on');
      window.setTimeout(() => { if (armed && Date.now() - armed >= 1500) disarm(); }, 1650);
    }
  }, true);
}

// ================================================================ the shortcut sheet
const k = (...keys: string[]) => h('span', { class: 'pm-keys' }, ...keys.flatMap((x, i) => [i ? h('i', null, x === '…' ? '' : 'then') : '', h('span', { class: 'kbd' }, x)]).filter((x) => x !== ''));
const kp = (...keys: string[]) => h('span', { class: 'pm-keys' }, ...keys.flatMap((x, i) => [i ? h('i', null, '+') : '', h('span', { class: 'kbd' }, x)]).filter((x) => x !== ''));
const GUIDE_LINKS: [string, string, string][] = [
  ['QUICK_START.md', 'Quick Start', 'from download to live in about 10 minutes'],
  ['SIMPLE_MODE.md', 'Simple mode', 'every area, button by button'],
  ['LIVE_PANEL.md', 'The Live panel', 'cameras, people, guest voice, polls, Stream Deck'],
  ['AVATARS_SIMPLE.md', 'Avatars: the easy way', 'import any model, AI-create, outfits, size, testing'],
  ['ENVIRONMENTS_SIMPLE.md', 'Rooms: the easy way', 'pick, add, describe and arrange rooms'],
  ['AVATARS_ADVANCED.md', 'Avatars by hand', 'formats, rig, face shapes, springs, costumes (in depth)'],
  ['ENVIRONMENTS_ADVANCED.md', 'Rooms by hand', 'the room contract as a Blender tutorial (in depth)'],
];
export function shortcutSheet(opts: { onHelpers(): void; onFirstRun(): void; close(): void; /** open the in-app Help viewer (src/ui/help) at a guide */ onHelp?(target?: string): void }) {
  const modes = (() => { try { return stageModeList().filter((m) => m.key); } catch { return []; } })();
  const group = (title: string, rows: [Node, string][]) => h('section', { class: 'pm-sc-group' }, h('h4', null, title),
    h('div', { class: 'pm-sc-rows' }, ...rows.flatMap(([keys, what]) => [keys, h('span', null, what)])));
  const back = h('div', { class: 'wiz-back pm-sc-back sc-back', onClick: (e: Event) => { if (e.target === back) opts.close(); } },
    h('div', { class: 'pm-sc', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts' },
      h('header', null,
        h('div', null, h('h3', null, 'Keyboard shortcuts'), h('p', null, 'They work anywhere in the studio, except while you type in a box.')),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => opts.close() }, icon('x', 16))),
      h('div', { class: 'pm-sc-grid' },
        group('Get around', [
          [k('G', 'H'), 'Home'], [k('G', 'M'), 'Me (avatar & outfits)'], [k('G', 'T'), 'Tracking'], [k('G', 'R'), 'Room'],
          [k('G', 'S'), 'Show & layout'], [k('G', 'C'), 'Chat & events'], [k('G', 'G'), 'Games'], [k('G', 'P'), 'Party'], [k('G', 'O'), 'OBS & stream'],
          [kp('Ctrl', 'K'), 'Search every setting'], [kp('F1'), 'Help: every guide, searchable'], [kp('?'), 'This sheet'],
        ]),
        group('While you perform', [
          [kp('C'), 'Set your neutral face'], [kp('F'), 'Re-frame the camera on your avatar'], [kp('1–9'), 'Preview an expression'],
          [kp('Ctrl', '1–9'), 'Wear outfit 1–9 (Ctrl+0: default look)'], [kp('Shift', '1–5'), 'Lights: Preshow, Show, React, BRB, Outro'],
        ]),
        group('Your show', [
          ...modes.map((m): [Node, string] => [kp('Shift', m.key!.toUpperCase()), `Show mode: ${m.label}`]),
          [kp('Shift', '<  >'), 'Previous / next layout of the current mode'], [kp(...loadHideScreenKey(safeLs()).split('+')), 'Hide my screen (on / off; change the key in Live → Privacy)'],
          [kp('Shift', 'S'), 'Slap! A little minion runs in and slaps someone'], [kp('Shift', 'Enter'), 'Reveal a held room change'],
        ]),
        group('Window', [[kp('H'), 'Hide every menu for a clean window capture'], [kp('Esc'), 'Close / cancel, and bring the menus back']]),
      ),
      // guides: in the Help viewer (bundled, offline — src/ui/help); without it, the server's page (server/routes/docsView.ts)
      h('section', { class: 'pm-sc-group pm-guides', style: 'padding:0 24px 12px' }, h('h4', null, 'Guides'),
        h('div', { class: 'pm-sc-rows' }, ...GUIDE_LINKS.flatMap(([file, title, what]) => [h('a', { href: `/api/docs/${file}`, target: '_blank', rel: 'noopener', onClick: (e: Event) => { if (opts.onHelp) { e.preventDefault(); opts.onHelp(file); } } }, title), h('span', null, what)]))),
      h('footer', null,
        opts.onHelp ? h('button', { class: 'btn', onClick: () => opts.onHelp?.() }, 'Help & guides (F1)') : null,
        h('button', { class: 'btn primary', onClick: () => opts.onFirstRun() }, 'Run the first-time setup'),
        h('button', { class: 'btn', onClick: () => opts.onHelpers() }, 'All guided set-ups'))));
  return back;
}

// ================================================================ init
let inited = false;
export function initPremium(go: (area: string) => void) {
  if (inited) return;
  inited = true;
  const s = document.createElement('style');
  s.id = 'vtp-premium';
  s.textContent = CSS + HOME_CSS;
  document.head.append(s);
  document.documentElement.classList.add('pm');
  initTooltips();
  initJumps(go);
  setToastHelp(fixFor);
}

const CSS = `
:root {
  --font-ui: "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif;
  --font-display: "Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif;
  --fs-xs: 11.5px; --fs-s: 12.5px; --fs-m: 13.5px; --fs-l: 15px; --fs-xl: 18px; --fs-2xl: 23px; --fs-3xl: 30px;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px;
  --ease: cubic-bezier(.2, .7, .2, 1); --dur: 160ms;
  --r-s: 8px; --r-m: 10px; --r-l: 14px; --r-xl: 18px;
  --ring: 0 0 0 2px var(--bg2), 0 0 0 4px var(--focus);
  --tally-on: #3ddc84; --tally-wait: #ffb454; --tally-off: #5b6475; --tally-err: #ff5d5d; --tally-live: #ff3b4e;
  --console: #0b0d12; --console-line: #232838;
}
:root[data-theme=light] { --console: #1c2130; --console-line: #2e3548; --tally-off: #6b7486; }
html.pm, html.pm body, html.pm button, html.pm input, html.pm select, html.pm textarea { font-family: var(--font-ui); }
html.pm .area-head h2, html.pm .wiz-main h2, html.pm .hm-head h1 { font-family: var(--font-display); }
html.pm .area-head h2 { font-size: var(--fs-2xl) !important; font-weight: 650; letter-spacing: -.015em; }
html.pm .area-head .sub { font-size: var(--fs-s); }
html.pm .s-card > h3 { font-size: var(--fs-l); letter-spacing: -.005em; }
html.pm .s-card > .lead, html.pm .note { font-size: var(--fs-s); line-height: 1.5; }
html.pm .s-card { border-radius: var(--r-l); padding: var(--sp-4); }
html.pm .s-card.hero { border-radius: var(--r-xl); }

/* focus: one ring everywhere (keyboard only) */
html.pm :focus-visible { outline: none !important; box-shadow: var(--ring) !important; border-radius: var(--r-s); }
html.pm .rail-btn:focus-visible, html.pm .btn:focus-visible, html.pm .s-tile:focus-visible { border-radius: 12px; }

/* button hierarchy: primary (one per card) · secondary · ghost · link · danger */
html.pm .btn { font-weight: 600; min-height: 32px; transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease), color var(--dur) var(--ease), box-shadow var(--dur) var(--ease), transform 60ms; }
html.pm .btn.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; box-shadow: inset 0 1px 0 #ffffff40, 0 1px 2px #0004; }
html.pm .btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 88%, white); }
html.pm .btn.danger { border-color: color-mix(in srgb, var(--err) 45%, transparent); }
html.pm .btn.danger:hover:not(:disabled) { background: var(--err-soft); }
html.pm .btn.big { min-height: 44px; }
html.pm .s-tile { transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease); }
html.pm .rail-btn { transition: background var(--dur) var(--ease), color var(--dur) var(--ease); }
html.pm #tabs .rail-btn.on::before { transition: top var(--dur) var(--ease); }

/* the rail fits short screens (1366×768 and laptops) */
/* the rail has 14 buttons since Guides: it tightens a bit earlier, and never pushes the page into a scroll */
html.pm #tabs { min-height: 0; overflow-y: auto; scrollbar-width: none; }
@media (max-height: 1000px) { html.pm #tabs { gap: 3px; padding: 8px 7px; } html.pm #tabs .rail-btn { height: 50px; gap: 3px; } html.pm #tabs .rail-btn svg { width: 19px; height: 19px; } }
@media (max-height: 780px) { html.pm #tabs .rail-btn { height: 42px; } html.pm #tabs .rail-btn span { font-size: 10px; } }

/* terms with a plain-language explanation */
html.pm .pm-term { text-decoration: underline dotted color-mix(in srgb, var(--dim) 70%, transparent); text-underline-offset: 3px; cursor: help; }

/* tooltips */
.pm-tip { position: fixed; left: 0; top: 0; z-index: 9100; max-width: 320px; padding: 7px 10px; border-radius: var(--r-s); background: #11141b; color: #eef1f6; border: 1px solid #ffffff1f; font: 500 12.5px/1.45 var(--font-ui); box-shadow: 0 8px 24px #0007; pointer-events: none; opacity: 0; transition: opacity 120ms var(--ease); white-space: pre-line; }
.pm-tip.on { opacity: 1; }
:root[data-theme=light] .pm-tip { background: #1d2230; }

/* toasts: the fix line */
.toast .pm-fix { display: block; margin-top: 4px; color: var(--dim); font-size: 12px; }
.toast { max-width: 420px; }

/* G-jump hint */
.pm-jump { position: fixed; left: 50%; bottom: 22px; transform: translate(-50%, 8px); z-index: 120; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; max-width: min(760px, 92vw); padding: 10px 16px; border-radius: 14px; background: var(--card); border: 1px solid var(--line2); box-shadow: var(--shadow); font-size: 12.5px; color: var(--dim); opacity: 0; pointer-events: none; transition: opacity 140ms var(--ease), transform 140ms var(--ease); }
.pm-jump.on { opacity: 1; transform: translate(-50%, 0); }
.pm-jump b { color: var(--text); margin-right: 4px; }
.pm-jump span { display: inline-flex; gap: 5px; align-items: center; }

/* shortcut sheet */
.pm-sc { width: min(920px, 100%); max-height: calc(100vh - 40px); overflow: auto; background: var(--panel); border: 1px solid var(--line2); border-radius: var(--r-xl); box-shadow: 0 24px 80px #000a; }
.pm-sc header { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; padding: 20px 24px 8px; }
.pm-sc header h3 { margin: 0; font: 650 var(--fs-2xl)/1.2 var(--font-display); letter-spacing: -.015em; }
.pm-sc header p { margin: 4px 0 0; color: var(--dim); font-size: var(--fs-s); }
.pm-sc-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 28px; padding: 8px 24px 12px; }
.pm-sc-group h4 { margin: 12px 0 8px; font-size: var(--fs-m); color: var(--text); font-weight: 650; }
.pm-sc-rows { display: grid; grid-template-columns: max-content 1fr; gap: 7px 14px; align-items: center; font-size: 13px; color: var(--dim); }
.pm-keys { display: inline-flex; align-items: center; gap: 4px; }
.pm-keys i { font-style: normal; color: var(--faint); font-size: 11px; }
.pm-sc footer { display: flex; gap: 8px; padding: 14px 24px 20px; border-top: 1px solid var(--line); }
@media (max-width: 760px) { .pm-sc-grid { grid-template-columns: 1fr; } }

/* empty state with its fix, under an area's title */
.pm-hint { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-top: 10px; padding: 10px 12px; border-radius: 12px; background: var(--accent2-soft); border: 1px solid color-mix(in srgb, var(--accent2) 30%, transparent); font-size: var(--fs-s); line-height: 1.45; }
.pm-hint .btn { flex: none; }

@media (prefers-reduced-motion: reduce) { .pm-tip, .pm-jump { transition: none; } }
`;
