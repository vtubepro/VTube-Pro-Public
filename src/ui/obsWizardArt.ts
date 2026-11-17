// Pictures for the "Set up OBS" wizard (lane obs-wizard): drawn, annotated sketches of the exact OBS menus and
// windows the user clicks (OBS Studio 30 / 31 / 32, default dark theme). Inline SVG strings, no network, no fonts.
// The same pictures are exported as files for the guide (tools/obs_wizard_art.ts → docs/img/obs-*.svg).
//
// OBS labels, checked against OBS's own sources (2026-10-01):
//   * Tools menu item + dialog title "WebSocket Server Settings"; "Plugin Settings", "Enable WebSocket server",
//     "Enable System Tray Alerts", "Server Settings", "Server Port", "Enable Authentication", "Server Password",
//     "Generate Password", "Show Connect Info"; Connect Info dialog "WebSocket Connect Info", "Server IP (Best Guess)",
//     "Server Port", "Server Password", "Copy" — obs-websocket data/locale/en-US.ini; the Tools entry uses the dialog
//     title (obs-websocket src/obs-websocket.cpp, obs_frontend_add_tools_menu_qaction). Built into OBS 28 and newer.
//   * Browser Source properties "URL", "Width", "Height", "Control audio via OBS", "Custom CSS", "Shutdown source when
//     not visible", "Refresh browser when scene becomes active" — obs-browser data/locale/en-US.ini.
//   * Menu bar File · Edit · View · Docks · Profile · Scene Collection · Tools · Help (OBS 30+), docks "Scenes",
//     "Sources", "Scene Transitions" (Duration in ms), Add Source menu "Browser" — OBS Studio UI (obs-studio
//     UI/data/locale/en-US.ini).

const C = {
  bg: '#16181d', win: '#24262d', bar: '#1b1d22', line: '#3a3d46', text: '#e8eaee', dim: '#9aa0aa', field: '#121317',
  sel: '#3b5bdb', lime: '#7bd88f', sky: '#6cc7f5', amber: '#ffcf6a',
};
const FONT = `font-family="Segoe UI, system-ui, -apple-system, sans-serif"`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const t = (x: number, y: number, s: string, o: { size?: number; fill?: string; weight?: number; anchor?: string } = {}) =>
  `<text x="${x}" y="${y}" font-size="${o.size ?? 12}" fill="${o.fill ?? C.text}"${o.weight ? ` font-weight="${o.weight}"` : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${esc(s)}</text>`;
const rect = (x: number, y: number, w: number, h: number, fill: string, o: { r?: number; stroke?: string; sw?: number } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 0}" fill="${fill}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"` : ''}/>`;
/** A window with a title bar. */
function win(x: number, y: number, w: number, h: number, title: string) {
  return rect(x, y, w, h, C.win, { r: 8, stroke: C.line }) + rect(x, y, w, 26, C.bar, { r: 8 }) + rect(x, y + 18, w, 8, C.bar)
    + t(x + 12, y + 17, title, { size: 12, fill: C.dim }) + t(x + w - 14, y + 17, '×', { size: 14, fill: C.dim, anchor: 'middle' });
}
/** Lime focus ring around the thing to click. */
const ring = (x: number, y: number, w: number, h: number) => rect(x - 3, y - 3, w + 6, h + 6, 'none', { r: 6, stroke: C.lime, sw: 2.5 });
/** Numbered callout. */
const badge = (n: number | string, x: number, y: number) =>
  `<circle cx="${x}" cy="${y}" r="11" fill="${C.lime}"/>${t(x, y + 4.5, String(n), { size: 13, fill: '#06080a', weight: 800, anchor: 'middle' })}`;
const arrow = (x1: number, y1: number, x2: number, y2: number) => {
  const a = Math.atan2(y2 - y1, x2 - x1), L = 8;
  const p = (d: number) => `${x2 - L * Math.cos(a + d)},${y2 - L * Math.sin(a + d)}`;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.lime}" stroke-width="2.5" stroke-linecap="round"/><polygon points="${x2},${y2} ${p(0.45)} ${p(-0.45)}" fill="${C.lime}"/>`;
};
const check = (x: number, y: number, label: string, on: boolean, o: { dimText?: boolean } = {}) =>
  rect(x, y, 14, 14, on ? C.sel : C.field, { r: 3, stroke: on ? C.sel : C.line })
  + (on ? `<path d="M${x + 3} ${y + 7.5} l3 3 l5 -6.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : '')
  + t(x + 22, y + 11.5, label, { size: 12, fill: o.dimText ? C.dim : C.text });
const btn = (x: number, y: number, w: number, label: string, o: { primary?: boolean } = {}) =>
  rect(x, y, w, 24, o.primary ? C.sel : '#33363f', { r: 4, stroke: C.line }) + t(x + w / 2, y + 16, label, { size: 12, anchor: 'middle' });
const field = (x: number, y: number, w: number, value: string) => rect(x, y, w, 22, C.field, { r: 3, stroke: C.line }) + t(x + 8, y + 15, value, { size: 11.5 });
const svg = (w: number, h: number, body: string, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" ${FONT}>${rect(0, 0, w, h, C.bg, { r: 14 })}${body}</svg>`;
/** OBS's main menu bar, with one menu open. */
function menuBar(x: number, y: number, w: number, open = -1) {
  const items = ['File', 'Edit', 'View', 'Docks', 'Profile', 'Scene Collection', 'Tools', 'Help'];
  let cx = x + 10, out = rect(x, y, w, 24, C.bar);
  const at: number[] = [];
  for (const [i, it] of items.entries()) {
    const ww = it.length * 6.6 + 14;
    at.push(cx);
    if (i === open) out += rect(cx - 4, y + 2, ww, 20, C.sel, { r: 3 });
    out += t(cx + 3, y + 16, it, { size: 12 });
    cx += ww + 4;
  }
  return { out, at };
}
/** A dock (Scenes / Sources) with its title and list. */
function dock(x: number, y: number, w: number, h: number, title: string, rows: { label: string; sel?: boolean; tag?: string; icon?: string }[]) {
  let out = rect(x, y, w, h, C.win, { r: 6, stroke: C.line }) + t(x + 10, y + 17, title, { size: 12, weight: 600 }) + rect(x, y + 24, w, 1, C.line);
  rows.forEach((r, i) => {
    const ry = y + 30 + i * 24;
    if (r.sel) out += rect(x + 4, ry, w - 8, 22, C.sel, { r: 3 });
    out += t(x + (r.icon ? 30 : 12), ry + 15, r.label, { size: 12 });
    if (r.icon) out += t(x + 14, ry + 15, r.icon, { size: 11, fill: C.dim });
    if (r.tag) out += rect(x + w - 74, ry + 4, 64, 15, 'none', { r: 7, stroke: C.lime }) + t(x + w - 42, ry + 15, r.tag, { size: 9.5, fill: C.lime, anchor: 'middle' });
  });
  out += rect(x, y + h - 26, w, 1, C.line);
  ['+', '−', '⚙', '∧', '∨'].forEach((s, i) => { out += t(x + 14 + i * 22, y + h - 8, s, { size: 14, fill: C.dim, anchor: 'middle' }); });
  return out;
}

// ---------------------------------------------------------------- one picture per step
export function artInstall() {
  const b = win(24, 24, 300, 200, 'obsproject.com')
    + rect(36, 58, 276, 36, C.bar, { r: 6 }) + t(48, 81, 'OBS Studio', { size: 16, weight: 700 }) + t(48, 110, 'Free and open source software', { size: 11.5, fill: C.dim })
    + t(48, 136, 'for video recording and live streaming.', { size: 11.5, fill: C.dim })
    + btn(48, 156, 76, 'Windows', { primary: true }) + btn(130, 156, 70, 'macOS') + btn(206, 156, 64, 'Linux') + ring(48, 156, 76, 24) + badge(1, 40, 152);
  const app = win(244, 196, 200, 120, 'OBS Studio') + rect(256, 230, 176, 56, '#0c0d10', { r: 4 }) + t(344, 263, 'Preview', { size: 11, fill: C.dim, anchor: 'middle' })
    + badge(2, 438, 192);
  return svg(468, 340, b + app + t(24, 330, 'Download, install, then open OBS once.', { size: 12.5, fill: C.dim }), 'The OBS website with the Download buttons, and OBS Studio opened once');
}

export function artRemote() {
  const W = 560;
  const m = menuBar(14, 14, W - 28, 6);
  const toolsX = m.at[6];
  const dx = Math.min(toolsX - 4, W - 14 - 222);
  const drop = rect(dx, 38, 222, 122, '#2c2f37', { r: 6, stroke: C.line })
    + t(dx + 14, 58, 'Auto-Configuration Wizard', { size: 12, fill: C.dim }) + t(dx + 14, 80, 'Output Timer', { size: 12, fill: C.dim })
    + t(dx + 14, 102, 'Scripts', { size: 12, fill: C.dim }) + rect(dx + 8, 112, 206, 1, C.line)
    + rect(dx + 6, 120, 210, 24, C.sel, { r: 4 }) + t(dx + 14, 137, 'WebSocket Server Settings', { size: 12, weight: 600 }) + ring(dx + 6, 120, 210, 24);
  const d = win(14, 172, 340, 244, 'WebSocket Server Settings')
    + t(28, 216, 'Plugin Settings', { size: 11.5, weight: 600, fill: C.dim })
    + check(28, 226, 'Enable WebSocket server', true) + ring(26, 224, 174, 18)
    + check(28, 250, 'Enable System Tray Alerts', false, { dimText: true })
    + t(28, 290, 'Server Settings', { size: 11.5, weight: 600, fill: C.dim })
    + t(28, 312, 'Server Port', { size: 12, fill: C.dim }) + field(132, 298, 70, '4455')
    + check(28, 328, 'Enable Authentication', true, { dimText: true })
    + t(28, 362, 'Server Password', { size: 12, fill: C.dim }) + field(132, 348, 90, '••••••••') + btn(228, 347, 116, 'Show Connect Info')
    + btn(178, 382, 48, 'OK') + btn(232, 382, 56, 'Cancel') + btn(294, 382, 50, 'Apply', { primary: true }) + ring(294, 382, 50, 24);
  const notes = badge(1, toolsX - 14, 26) + badge(2, dx + 226, 132) + badge(3, 214, 233) + badge(4, 348, 382)
    + arrow(dx + 60, 146, 220, 186);
  const side = t(376, 236, 'Tick the box,', { size: 14, weight: 600 }) + t(376, 256, 'then Apply.', { size: 14, weight: 600 })
    + t(376, 284, 'Leave the port and', { size: 12, fill: C.dim }) + t(376, 301, 'password as they are.', { size: 12, fill: C.dim })
    + t(376, 330, 'Then click OK.', { size: 12, fill: C.dim });
  return svg(W, 430, m.out + d + drop + notes + side, 'OBS: Tools menu, WebSocket Server Settings, tick Enable WebSocket server, then Apply');
}

export function artConnect() {
  const box = (x: number, y: number, w: number, title: string, sub: string, col: string) =>
    rect(x, y, w, 70, C.win, { r: 12, stroke: col, sw: 2 }) + t(x + w / 2, y + 31, title, { size: 14, weight: 700, anchor: 'middle' }) + t(x + w / 2, y + 51, sub, { size: 11, fill: C.dim, anchor: 'middle' });
  const top = box(24, 30, 170, 'OBS', 'its own settings file', C.line) + box(274, 30, 170, 'VTube Pro', 'on this computer', C.lime)
    + arrow(198, 65, 268, 65) + t(233, 56, 'reads', { size: 11, fill: C.lime, anchor: 'middle' })
    + `<g transform="translate(222 92)">${rect(0, 8, 22, 16, C.lime, { r: 3 })}<path d="M4 8 v-3 a7 7 0 0 1 14 0 v3" fill="none" stroke="${C.lime}" stroke-width="2.5"/></g>`
    + t(234, 136, 'The password never leaves your computer.', { size: 12, fill: C.dim, anchor: 'middle' }) + badge(1, 280, 30);
  const info = win(24, 160, 420, 150, 'WebSocket Connect Info')
    + t(40, 206, 'Server IP (Best Guess)', { size: 12, fill: C.dim }) + field(196, 192, 150, '192.168.1.20') + btn(354, 191, 70, 'Copy')
    + t(40, 236, 'Server Port', { size: 12, fill: C.dim }) + field(196, 222, 150, '4455') + btn(354, 221, 70, 'Copy')
    + t(40, 266, 'Server Password', { size: 12, fill: C.dim }) + field(196, 252, 150, '••••••••••••') + btn(354, 251, 70, 'Copy', { primary: true }) + ring(354, 251, 70, 24)
    + t(40, 296, 'Only if you type it yourself: Tools → WebSocket Server Settings → Show Connect Info.', { size: 10.5, fill: C.dim });
  return svg(468, 330, top + info + badge(2, 432, 252), 'VTube Pro reads OBS’s settings on this computer. Typing it yourself: Show Connect Info, Server Password, Copy');
}

export function artSource(url = 'http://127.0.0.1:5191/output.html', w = 1920, hgt = 1080) {
  const d = dock(14, 14, 190, 170, 'Sources', [{ label: 'VTube Pro', icon: '◍', sel: true, tag: 'added' }, { label: 'Game Capture', icon: '▣' }, { label: 'Webcam', icon: '◉' }]);
  const plus = ring(20, 160, 18, 18) + badge(1, 12, 150);
  const add = rect(40, 106, 130, 52, '#2c2f37', { r: 6, stroke: C.line }) + t(54, 124, 'Audio Input Capture', { size: 10.5, fill: C.dim })
    + rect(44, 130, 122, 22, C.sel, { r: 3 }) + t(54, 145, 'Browser', { size: 12, weight: 600 }) + badge(2, 176, 141);
  const p = win(214, 14, 240, 312, 'Properties for ‘VTube Pro’')
    + t(226, 62, 'URL', { size: 11.5, fill: C.dim }) + field(226, 68, 216, url.length > 34 ? `${url.slice(0, 33)}…` : url)
    + t(226, 112, 'Width', { size: 11.5, fill: C.dim }) + field(270, 98, 80, String(w))
    + t(226, 142, 'Height', { size: 11.5, fill: C.dim }) + field(270, 128, 80, String(hgt))
    + check(226, 164, 'Control audio via OBS', false, { dimText: true })
    + t(226, 202, 'Custom CSS', { size: 11.5, fill: C.dim }) + rect(226, 208, 216, 30, C.field, { r: 3, stroke: C.line })
    + check(226, 252, 'Shutdown source when not visible', false) + ring(224, 250, 210, 18)
    + check(226, 276, 'Refresh browser when scene', false) + t(248, 299, 'becomes active', { size: 12 }) + ring(224, 274, 186, 30)
    + badge(3, 444, 266);
  const note = t(14, 214, 'We set all of this', { size: 13, weight: 600 }) + t(14, 232, 'for you. Doing it by', { size: 11.5, fill: C.dim })
    + t(14, 248, 'hand? Sources → +', { size: 11.5, fill: C.dim }) + t(14, 264, '→ Browser, then copy', { size: 11.5, fill: C.dim }) + t(14, 280, 'the link and size.', { size: 11.5, fill: C.dim })
    + t(14, 306, 'Both boxes at 3', { size: 11.5, fill: C.amber }) + t(14, 322, 'stay unticked.', { size: 11.5, fill: C.amber });
  return svg(468, 340, d + add + plus + p + note, 'OBS Sources dock with the VTube Pro Browser Source, and its properties: URL, Width, Height, both boxes unticked');
}

export function artScenes(names: string[] = ['Talk', 'React', 'Gaming', 'BRB'], sel = 0) {
  const d = dock(24, 20, 200, 30 + names.length * 24 + 34, 'Scenes', names.map((label, i) => ({ label, sel: i === sel })));
  const prev = rect(250, 20, 194, 120, '#0c0d10', { r: 6, stroke: C.line }) + t(347, 150, 'Your stream', { size: 11, fill: C.dim, anchor: 'middle' })
    + `<g transform="translate(320 46)"><circle cx="27" cy="26" r="20" fill="${C.sky}" opacity=".85"/><path d="M-3 94 q30 -54 60 0 z" fill="${C.sky}" opacity=".85"/></g>`;
  const list = names.map((n, i) => t(250, 186 + i * 22, `${n}`, { size: 12 }) + t(444, 186 + i * 22, 'VTube Pro ✔', { size: 11, fill: C.lime, anchor: 'end' })).join('');
  return svg(468, 290, d + prev + list + badge(1, 214, 20), 'OBS Scenes dock: Talk, React, Gaming and BRB, each with VTube Pro in it');
}

export function artAutomation() {
  const looks = ['Talk', 'React', 'Gaming', 'BRB'], scenes = ['Talk', 'React', 'Gaming', 'BRB'];
  let out = t(24, 34, 'In VTube Pro you press…', { size: 12, fill: C.dim }) + t(280, 34, '…OBS shows', { size: 12, fill: C.dim });
  looks.forEach((l, i) => {
    const y = 48 + i * 44;
    out += rect(24, y, 168, 32, i === 2 ? C.lime : '#2c2f37', { r: 16 }) + t(108, y + 21, l, { size: 12.5, weight: 600, fill: i === 2 ? '#06080a' : C.text, anchor: 'middle' });
    out += rect(280, y, 164, 32, i === 2 ? C.sel : C.win, { r: 6, stroke: C.line }) + t(292, y + 21, scenes[i], { size: 12.5 });
    out += i === 2 ? arrow(198, y + 16, 274, y + 16) : `<line x1="198" y1="${y + 16}" x2="274" y2="${y + 16}" stroke="${C.line}" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  });
  const tr = rect(24, 236, 420, 74, C.win, { r: 6, stroke: C.line }) + t(36, 256, 'Scene Transitions', { size: 12, weight: 600 })
    + field(36, 266, 150, 'Fade') + t(176, 281, '▾', { size: 11, fill: C.dim }) + t(206, 281, 'Duration', { size: 12, fill: C.dim }) + field(262, 266, 90, '300 ms')
    + ring(36, 266, 150, 22) + badge(1, 444, 236);
  return svg(468, 326, out + tr, 'Press a look in VTube Pro and OBS switches to its scene, with OBS’s scene transition (for example Fade, 300 ms)');
}

export function artTest(names: string[] = ['Talk', 'React', 'Gaming', 'BRB'], on = 1) {
  const d = dock(24, 20, 190, 30 + names.length * 24 + 34, 'Scenes', names.map((label, i) => ({ label, sel: i === on })));
  const prog = rect(234, 20, 210, 130, '#0c0d10', { r: 6, stroke: C.lime, sw: 2 }) + t(242, 38, 'Program', { size: 10.5, fill: C.lime })
    + `<g transform="translate(312 52)"><circle cx="27" cy="26" r="20" fill="${C.sky}" opacity=".85"/><path d="M-3 94 q30 -54 60 0 z" fill="${C.sky}" opacity=".85"/></g>`
    + t(339, 168, `Now on air: ${names[on] ?? ''}`, { size: 12, anchor: 'middle' });
  return svg(468, 230, d + prog + badge(1, 204, 20 + 30 + on * 24 + 11), 'OBS switches to the scene you pressed, with VTube Pro in it');
}

export function artDone() {
  return svg(468, 230, `<circle cx="234" cy="96" r="58" fill="${C.lime}" opacity=".14"/><circle cx="234" cy="96" r="44" fill="${C.lime}"/>`
    + `<path d="M213 97 l14 14 l28 -30" fill="none" stroke="#06080a" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`
    + t(234, 190, 'OBS and VTube Pro work together now.', { size: 14, weight: 600, anchor: 'middle' }), 'All set');
}

export const ART: Record<string, () => string> = {
  install: artInstall, remote: artRemote, connect: artConnect, source: () => artSource(), scenes: () => artScenes(), automation: artAutomation, test: () => artTest(), done: artDone,
};
