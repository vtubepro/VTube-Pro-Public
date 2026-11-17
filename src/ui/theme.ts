// Studio design system (UI overhaul): colour tokens for the dark (default) and light themes, the app shell
// (top bar, area rail, area header), cards, chips, the Simple views, wizards and the room prompter.
// Injected once at start-up (no CSS import, so tsc needs no module declarations). The legacy panels keep their own
// small CSS blocks; the overrides at the bottom re-map their hard-coded dark colours onto the tokens so they read
// correctly in the light theme too.

export type ThemeChoice = 'dark' | 'light' | 'system';
const THEME_KEY = 'vtp.ui.theme';

export function themeChoice(): ThemeChoice {
  try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'system' ? v : 'dark'; } catch { return 'dark'; }
}
export function effectiveTheme(c: ThemeChoice = themeChoice()): 'dark' | 'light' {
  if (c === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return c;
}
export function setTheme(c: ThemeChoice) {
  try { localStorage.setItem(THEME_KEY, c); } catch { /* storage off */ }
  applyTheme();
}
export function applyTheme() {
  const t = effectiveTheme();
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t;
}

let injected = false;
export function injectTheme() {
  if (injected) return;
  injected = true;
  const s = document.createElement('style');
  s.id = 'vtp-theme';
  s.textContent = CSS;
  document.head.append(s);
  applyTheme();
  try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (themeChoice() === 'system') applyTheme(); }); } catch { /* old browser */ }
}

const CSS = `
:root, :root[data-theme=dark] {
  --bg: #0e1015; --bg2: #13161d; --panel: #161920; --card: #1b1f28; --card2: #222733; --card3: #2a3040;
  --line: #262b37; --line2: #333a4a; --text: #eef1f6; --dim: #a3abba; --faint: #717a8b;
  --accent: #7bd88f; --accent-ink: #08130b; --accent-soft: #7bd88f22; --accent2: #6cc7f5; --accent2-soft: #6cc7f522;
  --violet: #a78bfa; --pink: #ff7ac8; --warn: #ffb454; --warn-soft: #ffb45422; --err: #ff6b6b; --err-soft: #ff6b6b22; --ok: #7bd88f;
  --focus: #8ab4ff; --input: #10131a; --shadow: 0 10px 30px #0008; --radius: 12px; --radius-s: 8px;
  --stage: #1b1d24; --panel-w: 372px; --rail-w: 78px;
  color-scheme: dark;
}
:root[data-theme=light] {
  --bg: #eef0f4; --bg2: #ffffff; --panel: #f8f9fb; --card: #ffffff; --card2: #f1f3f7; --card3: #e6e9f0;
  --line: #e0e4eb; --line2: #cfd5df; --text: #141821; --dim: #525c6e; --faint: #7a8496;
  --accent: #23904a; --accent-ink: #ffffff; --accent-soft: #23904a1c; --accent2: #1678b8; --accent2-soft: #1678b81c;
  --violet: #6d4fd6; --pink: #c42c86; --warn: #b36b00; --warn-soft: #b36b001c; --err: #c9302c; --err-soft: #c9302c1a; --ok: #23904a;
  --focus: #2f6fdf; --input: #ffffff; --shadow: 0 10px 30px #1a203033; --stage: #d9dde5;
  color-scheme: light;
}
html, body { background: var(--bg); color: var(--text); font-size: 13.5px; }
body { -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 2px solid var(--focus) !important; outline-offset: 2px; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }

/* ---------------------------------------------------------------- shell */
#app { grid-template-columns: var(--rail-w) var(--panel-w) 1fr; grid-template-rows: 56px 1fr; }
@media (max-width: 1360px) { :root { --panel-w: 344px; --rail-w: 72px; } }
#topbar { background: var(--bg2); border-bottom: 1px solid var(--line); gap: 10px; padding: 0 14px 0 12px; }
#topbar .logo { font-size: 16px; gap: 9px; margin-right: 6px; }
#topbar .logo .mark { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; font-size: 18px; background: linear-gradient(135deg, #7bd88f33, #6cc7f533); }
#topbar .logo b { color: var(--accent); }
.tb-avatar { display: flex; align-items: center; gap: 7px; padding: 3px 10px 3px 4px; border-radius: 99px; background: var(--card); border: 1px solid var(--line); cursor: pointer; color: var(--text); font: inherit; max-width: 230px; }
.tb-avatar img, .tb-avatar .ph { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; background: var(--card2); display: grid; place-items: center; font-size: 14px; flex: none; }
.tb-avatar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.tb-chips { display: flex; gap: 6px; align-items: center; flex-wrap: nowrap; overflow: hidden; }
.chip { background: var(--card); color: var(--dim); border: 1px solid var(--line); font-size: 12px; padding: 3px 10px; display: inline-flex; align-items: center; gap: 6px; }
button.chip { cursor: pointer; font: inherit; font-size: 12px; }
button.chip:hover { border-color: var(--line2); color: var(--text); }
.chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
.chip.ok { color: var(--text); } .chip.ok .dot { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.chip.warn { color: var(--text); } .chip.warn .dot { background: var(--warn); }
.chip.err { color: var(--err); } .chip.err .dot { background: var(--err); }
.chip.live { background: var(--err-soft); border-color: #ff6b6b55; color: var(--text); }
.seg { display: inline-flex; background: var(--card); border: 1px solid var(--line); border-radius: 99px; padding: 2px; gap: 2px; }
.seg button { border: 0; background: transparent; color: var(--dim); font: inherit; font-size: 12px; font-weight: 600; padding: 4px 11px; border-radius: 99px; cursor: pointer; }
.seg button.on { background: var(--accent); color: var(--accent-ink); }
.seg button:not(.on):hover { color: var(--text); background: var(--card2); }
.icon-btn { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--dim); cursor: pointer; font-size: 15px; }
.icon-btn:hover { color: var(--text); border-color: var(--line2); }
.icon-btn svg, .rail-btn svg { width: 20px; height: 20px; }

#tabs { background: var(--bg2); border-right: 1px solid var(--line); padding: 10px 7px; gap: 6px; align-items: center; }
#tabs .rail-btn { width: calc(var(--rail-w) - 14px); height: 58px; border-radius: 12px; border: 0; background: transparent; color: var(--dim); cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; font: inherit; position: relative; }
#tabs .rail-btn span { position: static; font-size: 11px; font-weight: 600; letter-spacing: .01em; }
#tabs .rail-btn:hover { background: var(--card); color: var(--text); }
#tabs .rail-btn.on { background: var(--accent-soft); color: var(--accent); }
#tabs .rail-btn.on::before { content: ''; position: absolute; left: -7px; top: 14px; bottom: 14px; width: 3px; border-radius: 0 3px 3px 0; background: var(--accent); }
#tabs .rail-btn .badge { position: absolute; top: 6px; right: 10px; width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
#tabs .rail-spacer { flex: 1; }

#panel { background: var(--panel); border-right: 1px solid var(--line); padding: 0; display: flex; flex-direction: column; overflow: hidden; }
.area-head { padding: 14px 16px 10px; border-bottom: 1px solid var(--line); background: var(--panel); flex: none; }
.area-head .ttl { display: flex; align-items: center; gap: 10px; }
.area-head h2 { margin: 0 !important; font-size: 19px !important; font-weight: 700; flex: 1; letter-spacing: -.01em; }
.area-head .sub { color: var(--dim); font-size: 12.5px; margin-top: 3px; }
.adv-switch { display: inline-flex; align-items: center; gap: 7px; color: var(--dim); font-size: 12px; font-weight: 600; cursor: pointer; user-select: none; }
.adv-switch .switch { width: 32px; height: 18px; }
.adv-switch .switch i::after { width: 12px; height: 12px; }
.adv-switch .switch input:checked + i::after { left: 17px; }
.subtabs { display: flex; gap: 4px; margin-top: 10px; flex-wrap: wrap; }
.subtabs button { border: 1px solid var(--line); background: var(--card); color: var(--dim); font: inherit; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 99px; cursor: pointer; }
.subtabs button.on { background: var(--text); color: var(--bg); border-color: transparent; }
.subtabs button:not(.on):hover { color: var(--text); }
.area-body { flex: 1; overflow-y: auto; padding: 14px 16px 60px; scrollbar-gutter: stable; }
.area-body > h2:first-child { display: none; } /* legacy panels print their own title: the area header already says it */

/* ---------------------------------------------------------------- base controls (legacy panels too) */
.sec { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 12px 8px; margin-bottom: 12px; }
.sec .sec { background: var(--card2); }
.sec h3 { color: var(--dim); font-size: 11.5px; letter-spacing: .07em; }
.row { grid-template-columns: 124px 1fr; }
.row.slider { grid-template-columns: 124px 1fr 42px; }
.row .lbl { color: var(--dim); }
select, input[type=text], input[type=password], input[type=number], input[type=search], input[type=url], textarea {
  background: var(--input); color: var(--text); border: 1px solid var(--line2); border-radius: 9px; padding: 7px 9px;
}
select:hover, input[type=text]:hover, textarea:hover { border-color: var(--faint); }
input[type=color] { border-color: var(--line2); }
.switch i { background: var(--card3); }
.switch i::after { background: #e6eaf1; }
.btn { background: var(--card2); color: var(--text); border: 1px solid var(--line2); border-radius: 10px; padding: 7px 12px; transition: background .12s, border-color .12s, transform .06s; }
.btn:hover { background: var(--card3); }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.btn.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.btn.danger { color: var(--err); }
.btn.big { padding: 12px 18px; font-size: 15px; font-weight: 700; border-radius: 12px; width: 100%; }
.btn.ghost { background: transparent; border-color: transparent; color: var(--dim); }
.btn.ghost:hover { color: var(--text); background: var(--card2); }
.btn.link { background: none; border: 0; color: var(--accent2); padding: 2px 0; font-weight: 600; }
.btn.link:hover { text-decoration: underline; background: none; }
.note { color: var(--dim); }
.note b { color: var(--text); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
.card:hover { border-color: var(--line2); }
.card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.card img, .card .ph { background: radial-gradient(circle at 50% 40%, var(--card3), var(--card)); }
.drop { border-color: var(--line2); border-radius: 12px; }
.drop:hover { border-color: var(--faint); color: var(--text); }
.log { background: var(--input); border-color: var(--line); color: var(--dim); }
code { background: var(--input); color: var(--text); border: 1px solid var(--line); }
.kbd { background: var(--card2); border: 1px solid var(--line2); border-bottom-width: 2px; color: var(--text); padding: 0 6px; border-radius: 5px; }
.progress { background: var(--card3); }
details summary { color: var(--dim); }
#viewport { background: var(--stage); }
.viewbar .btn { background: #0d0f14b8; color: #eef1f6; border-color: #ffffff1c; backdrop-filter: blur(6px); }
.viewbar .btn:hover { background: #0d0f14e0; }
#hud .meters { background: #0d0f14cc; color: #cfd5df; }
#campip { border-color: #ffffff22; border-radius: 12px; box-shadow: var(--shadow); }
#statusline { color: #cfd5df; text-shadow: 0 1px 2px #000; }
#toasts { top: 68px; right: 18px; }
.toast { background: var(--card); color: var(--text); border: 1px solid var(--line2); border-left-width: 4px; border-radius: 12px; padding: 10px 14px; box-shadow: var(--shadow); font-size: 13px; line-height: 1.45; }
#prompt { border-color: var(--accent); }

/* ---------------------------------------------------------------- simple views */
.s-card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; margin-bottom: 12px; }
.s-card.hero { background: linear-gradient(160deg, var(--accent-soft), transparent 60%), var(--card); }
.s-card.hero.blue { background: linear-gradient(160deg, var(--accent2-soft), transparent 60%), var(--card); }
.s-card.hero.violet { background: linear-gradient(160deg, #a78bfa22, transparent 60%), var(--card); }
.s-card > h3 { margin: 0 0 4px; font-size: 14.5px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.s-card > h3 .grow { flex: 1; }
.s-card > .lead { color: var(--dim); margin: 0 0 10px; font-size: 12.5px; line-height: 1.45; }
.s-card .foot { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 8px; }
.s-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.s-grid.two { grid-template-columns: 1fr 1fr; }
.s-tile { border: 1px solid var(--line); background: var(--card2); border-radius: 12px; cursor: pointer; overflow: hidden; position: relative; text-align: left; color: var(--text); font: inherit; padding: 0; display: flex; flex-direction: column; }
.s-tile:hover { border-color: var(--line2); transform: translateY(-1px); }
.s-tile.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.s-tile .img { width: 100%; aspect-ratio: 1; object-fit: cover; background: radial-gradient(circle at 50% 40%, var(--card3), var(--card2)); display: grid; place-items: center; font-size: 26px; color: var(--faint); }
.s-tile.wide .img { aspect-ratio: 16/9; }
.s-tile .nm { padding: 6px 8px 7px; font-size: 12px; font-weight: 600; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.s-tile .tag { position: absolute; top: 6px; left: 6px; background: #000a; color: #fff; font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 99px; }
.s-tile .check { position: absolute; top: 6px; right: 6px; width: 20px; height: 20px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-size: 12px; font-weight: 800; }
.s-list { display: flex; flex-direction: column; gap: 2px; }
.s-item { display: grid; grid-template-columns: 30px 1fr auto; gap: 10px; align-items: center; padding: 8px 6px; border-radius: 10px; }
.s-item + .s-item { border-top: 1px solid var(--line); border-radius: 0; }
.s-item .ic { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--card2); font-size: 15px; }
.s-item.ok .ic { background: var(--accent-soft); color: var(--accent); }
.s-item.warn .ic { background: var(--warn-soft); color: var(--warn); }
.s-item.err .ic { background: var(--err-soft); color: var(--err); }
.s-item .t { font-weight: 650; font-size: 13px; }
.s-item .d { color: var(--dim); font-size: 12px; margin-top: 1px; line-height: 1.35; }
.s-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.s-pill { border: 1px solid var(--line2); background: var(--card2); color: var(--text); font: inherit; font-size: 12.5px; font-weight: 600; padding: 6px 11px; border-radius: 99px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.s-pill:hover { border-color: var(--faint); }
.s-pill.on { background: var(--accent); border-color: transparent; color: var(--accent-ink); }
.s-pill:disabled { opacity: .45; cursor: not-allowed; }
.s-pill .k { font-size: 10.5px; opacity: .7; font-weight: 600; }
.s-seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; background: var(--card2); border: 1px solid var(--line); border-radius: 12px; padding: 3px; }
.s-seg button { border: 0; background: transparent; color: var(--dim); font: inherit; font-weight: 650; padding: 8px 6px; border-radius: 9px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.s-seg button small { font-weight: 500; font-size: 10.5px; opacity: .8; }
.s-seg button.on { background: var(--card); color: var(--text); box-shadow: 0 1px 4px #0003, 0 0 0 1px var(--accent) inset; }
.s-seg button:disabled { opacity: .45; cursor: not-allowed; }
.s-field { display: grid; gap: 5px; margin: 8px 0; }
.s-field > span { font-size: 12px; font-weight: 600; color: var(--dim); }
.s-field .hint { font-size: 11.5px; color: var(--faint); }
.s-copy { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; margin: 5px 0; }
.s-copy code { padding: 7px 9px; font-size: 12px; border-radius: 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; word-break: normal; display: block; }
.s-copy .lbl { grid-column: 1 / -1; font-size: 11.5px; color: var(--dim); font-weight: 600; margin-bottom: -2px; }
.s-empty { text-align: center; padding: 18px 10px; color: var(--dim); }
.s-empty .big { font-size: 30px; margin-bottom: 6px; }
.s-empty b { color: var(--text); display: block; font-size: 14px; margin-bottom: 4px; }
.s-meter { height: 10px; border-radius: 99px; background: var(--card3); overflow: hidden; position: relative; }
.s-meter i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 99px; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .08s linear; }
.s-meter.mark::after { content: ''; position: absolute; top: -2px; bottom: -2px; left: 18%; width: 2px; background: var(--faint); }
.s-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12.5px; }
.s-kv > :nth-child(odd) { color: var(--dim); }
.s-more { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 12px; border: 1px dashed var(--line2); color: var(--dim); cursor: pointer; background: transparent; font: inherit; width: 100%; text-align: left; margin-bottom: 12px; }
.s-more:hover { color: var(--text); border-color: var(--faint); }
.s-more b { color: var(--text); }
.s-prev { position: relative; width: 100%; aspect-ratio: 16/9; border-radius: 12px; overflow: hidden; background: #000 repeating-conic-gradient(#1a1d24 0 25%, #14171c 0 50%) 0 0/16px 16px; border: 1px solid var(--line); }
/* color-scheme: normal — the studio is dark and output.html declares none, so Chrome painted an opaque WHITE box behind
   the see-through OBS page (a glaring white rectangle, and the "see-through background" looked broken) */
.s-prev iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; color-scheme: normal; }
.s-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.s-row.between { justify-content: space-between; }
.s-badge { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 99px; background: var(--card3); color: var(--dim); text-transform: uppercase; letter-spacing: .05em; }
.s-badge.ok { background: var(--accent-soft); color: var(--accent); }
.s-badge.warn { background: var(--warn-soft); color: var(--warn); }
.s-steps { counter-reset: st; display: grid; gap: 8px; margin: 6px 0; padding: 0; list-style: none; }
.s-steps li { counter-increment: st; display: grid; grid-template-columns: 24px 1fr; gap: 8px; font-size: 13px; line-height: 1.45; }
.s-steps li::before { content: counter(st); width: 22px; height: 22px; border-radius: 50%; background: var(--card3); color: var(--text); display: grid; place-items: center; font-size: 11.5px; font-weight: 700; margin-top: 1px; }
.s-steps li b { color: var(--text); }
.s-obs { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--card2); margin: 6px 0; }
.s-banner { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 12px; background: var(--accent2-soft); border: 1px solid #6cc7f544; margin-bottom: 12px; font-size: 12.5px; color: var(--text); }
.s-banner.warn { background: var(--warn-soft); border-color: #ffb45455; }
.s-banner .x { margin-left: auto; background: none; border: 0; color: var(--dim); cursor: pointer; font-size: 14px; }

.room-pip { position: absolute; left: 14px; bottom: 14px; z-index: 6; aspect-ratio: 16/9; border-radius: 12px; overflow: hidden; border: 1px solid #ffffff2a; box-shadow: 0 12px 40px #000a; background: #000 repeating-conic-gradient(#1a1d24 0 25%, #14171c 0 50%) 0 0/16px 16px; }
.room-pip iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; color-scheme: normal; }
/* clarity: the label always says what this is ("Preview · only you see this"), in white: a red "● OBS view" read like
   something going out. The buttons still show on hover. */
.room-pip-bar { position: absolute; left: 0; right: 0; top: 0; display: flex; gap: 6px; align-items: center; padding: 6px 8px; background: linear-gradient(#000b, #0000); color: #fff; font-size: 11.5px; font-weight: 700; }
.room-pip-bar .btn { opacity: 0; transition: opacity .15s; }
.room-pip:hover .room-pip-bar .btn, .room-pip:focus-within .room-pip-bar .btn { opacity: 1; }
.room-pip-bar .room-pip-lbl { color: #fff; text-shadow: 0 1px 2px #000; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
/* a small corner preview (a phone): one short line, never a 4-line label over the picture */
.room-pip { container-type: inline-size; }
@container (max-width: 240px) { .room-pip-bar { padding: 4px 6px; font-size: 10px; } .room-pip-bar .btn { display: none; } .room-pip:hover .room-pip-bar .btn, .room-pip:focus-within .room-pip-bar .btn { display: inline-flex; } }
.room-pip-bar .btn { padding: 2px 8px; font-size: 12px; background: #0009; color: #fff; border-color: #ffffff33; }

/* ---------------------------------------------------------------- prompter */
.pr-box { position: relative; }
.pr-box textarea { min-height: 76px; font-size: 14px; line-height: 1.45; padding: 10px 12px; border-radius: 12px; }
.pr-plan { border: 1px solid var(--line2); border-radius: 12px; padding: 10px 12px; background: var(--card2); margin-top: 10px; }
.pr-plan h4 { margin: 0 0 6px; font-size: 13.5px; display: flex; gap: 8px; align-items: center; }
.pr-plan ul { margin: 4px 0 8px; padding-left: 0; list-style: none; display: grid; gap: 4px; }
.pr-plan li { display: grid; grid-template-columns: 22px 1fr; gap: 6px; font-size: 12.5px; }
.pr-plan li .why { color: var(--faint); font-size: 11.5px; }
.pr-slider { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; font-size: 12px; color: var(--dim); margin: 8px 0; }
.pr-gen { margin-top: 10px; border-top: 1px dashed var(--line2); padding-top: 10px; }

/* ---------------------------------------------------------------- wizard */
.wiz-back { position: fixed; inset: 0; z-index: 60; background: #05070bb8; backdrop-filter: blur(3px); display: grid; place-items: center; padding: 20px; }
.wiz { width: min(980px, 100%); height: min(720px, calc(100vh - 40px)); background: var(--panel); color: var(--text); border: 1px solid var(--line2); border-radius: 18px; box-shadow: 0 24px 80px #000a; display: grid; grid-template-columns: 240px 1fr; grid-template-rows: 1fr auto; overflow: hidden; }
.wiz-side { grid-row: 1 / 3; background: var(--bg2); border-right: 1px solid var(--line); padding: 20px 14px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
.wiz-side .wt { font-size: 16px; font-weight: 750; margin: 0 6px 2px; }
.wiz-side .ws { color: var(--dim); font-size: 12px; margin: 0 6px 14px; line-height: 1.4; }
.wiz-step { display: grid; grid-template-columns: 26px 1fr; gap: 8px; align-items: center; padding: 7px 8px; border-radius: 10px; color: var(--dim); font-size: 13px; font-weight: 600; cursor: pointer; border: 0; background: none; text-align: left; font-family: inherit; }
.wiz-step .n { width: 24px; height: 24px; border-radius: 50%; border: 1.5px solid var(--line2); display: grid; place-items: center; font-size: 11.5px; }
.wiz-step.done { color: var(--text); } .wiz-step.done .n { background: var(--accent); border-color: transparent; color: var(--accent-ink); }
.wiz-step.skipped .n { border-style: dashed; }
.wiz-step.cur { background: var(--card); color: var(--text); } .wiz-step.cur .n { border-color: var(--accent); color: var(--accent); }
.wiz-step:hover:not(.cur) { background: var(--card); }
.wiz-side .prog { margin-top: auto; padding: 10px 6px 0; font-size: 12px; color: var(--dim); }
.wiz-side .prog .s-meter { margin-top: 6px; height: 6px; }
.wiz-main { padding: 22px 26px 12px; overflow-y: auto; position: relative; }
.wiz-main h2 { margin: 0 0 4px; font-size: 22px; letter-spacing: -.01em; }
.wiz-main .lead { color: var(--dim); font-size: 13.5px; margin: 0 0 16px; line-height: 1.5; max-width: 620px; }
.wiz-close { position: absolute; top: 14px; right: 14px; z-index: 2; /* above a wizard's preview frame */ }
.wiz-foot { display: flex; gap: 8px; align-items: center; padding: 12px 26px; border-top: 1px solid var(--line); background: var(--panel); }
.wiz-foot .grow { flex: 1; color: var(--faint); font-size: 12px; }
.wiz-cols { display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; align-items: start; }
.wiz-cam { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 14px; overflow: hidden; border: 1px solid var(--line2); }
.wiz-cam video, .wiz-cam canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.wiz-cam .mirror { transform: scaleX(-1); }
.wiz-cam .off { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; color: #9aa3b2; padding: 20px; font-size: 13px; }
.wiz-cam .guide { position: absolute; left: 32%; right: 32%; top: 12%; bottom: 18%; border: 2px dashed #ffffff55; border-radius: 50% 50% 45% 45%; pointer-events: none; }
.wiz-checks { display: grid; gap: 6px; }
.wiz-check { display: grid; grid-template-columns: 26px 1fr; gap: 8px; align-items: start; padding: 8px 10px; border-radius: 10px; background: var(--card); border: 1px solid var(--line); }
.wiz-check .ic { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 800; background: var(--card3); color: var(--dim); }
.wiz-check.ok .ic { background: var(--accent); color: var(--accent-ink); }
.wiz-check.warn .ic { background: var(--warn); color: #1a1000; }
.wiz-check.err .ic { background: var(--err); color: #fff; }
.wiz-check b { display: block; font-size: 13px; }
.wiz-check span { color: var(--dim); font-size: 12px; }
.wiz-choice { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.wiz-opt { border: 1.5px solid var(--line2); border-radius: 14px; padding: 12px; background: var(--card); cursor: pointer; text-align: left; color: var(--text); font: inherit; display: flex; flex-direction: column; gap: 6px; }
.wiz-opt:hover { border-color: var(--faint); }
.wiz-opt.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.wiz-opt b { font-size: 14px; } .wiz-opt span { color: var(--dim); font-size: 12px; line-height: 1.4; }
.wiz-opt svg { width: 100%; height: auto; border-radius: 8px; background: var(--card2); }
.wiz-mini { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 61; background: var(--card); border: 1px solid var(--line2); border-radius: 99px; padding: 6px 8px 6px 16px; display: flex; gap: 10px; align-items: center; box-shadow: var(--shadow); font-weight: 600; }
@media (max-width: 1100px) { .wiz { grid-template-columns: 1fr; } .wiz-side { display: none; } .wiz-cols { grid-template-columns: 1fr; } }

/* ---------------------------------------------------------------- overlays: shortcuts */
.sc-list { display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; font-size: 13px; align-items: center; }
.sc-list .kbd { justify-self: start; white-space: nowrap; }

/* ---------------------------------------------------------------- legacy panel colours → tokens (light theme) */
:root[data-theme=light] .scn-map, :root[data-theme=light] .scn-rect, :root[data-theme=light] .lt-meter canvas, :root[data-theme=light] .gfx-stat, :root[data-theme=light] .lt-pb-list { background: var(--card2); }
:root[data-theme=light] .lt-states button, :root[data-theme=light] .env-wx button, :root[data-theme=light] .lt-pb-cats button, :root[data-theme=light] .lt-grp { background: var(--card2); color: var(--text); }
:root[data-theme=light] .lt-states button.on, :root[data-theme=light] .env-wx button.on { color: #fff; }
:root[data-theme=light] .lt-pb-card { border-bottom-color: var(--line); }
:root[data-theme=light] .lt-pb-card.cur { background: #ede7ff; }
:root[data-theme=light] .scn-seg .btn.on, :root[data-theme=light] .gfx-seg .btn.on { color: #fff; }
:root[data-theme=light] .card .x { background: #0006; color: #fff; }
:root[data-theme=light] .meter .bar { background: var(--card3); }
`;
