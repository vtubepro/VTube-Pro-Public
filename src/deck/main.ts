// Stream Deck & controllers (deck.html, docs/STREAM_DECK.md).
//   deck.html            → the editor: device size, pages, drag actions onto keys, title / icon / colour / params,
//                          live lit state, test press, export / import, "copy URL" for any other device.
//   deck.html?virtual=1  → the virtual deck: exactly what the Stream Deck plugin does (same /ws/deck socket, same key
//                          faces from tools/streamdeck-plugin/src/face.ts), for people without the hardware.
// Nothing here touches the avatar or the scene directly: presses go through the server's action registry (server/deck.ts).
import '../storageGuard.ts'; // (must stay the first import: a memory-only stand-in when the page may not keep site data)
import '../licenseNotice.ts'; // hosted copies say that VTube Pro is free (LICENSE); never shown on this PC or the home network
import '../net/lanPage.ts'; // a stream PC's page follows the gaming PC's mode
import { DEVICE_SIZES, MAX_COLS, MAX_PAGES, MAX_ROWS, nextPage, resizeLayout, sanitizeLayout,
  type DeckActionDef, type DeckKey, type DeckLayout, type DeckLiveState, type DeckResolved, type DeckServerMsg } from '../../shared/deck.ts';
import { faceSvg, svgDataUrl, type Face } from '../../tools/streamdeck-plugin/src/face.ts';
import { dockButtonSpec, initDockedPage, isDocked } from '../ui/dockEmbed.ts';

const $h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> | null = null, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value') (e as HTMLInputElement).value = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};
const CSS = `
:root { --bg:#12151d; --panel:#1a1f2b; --line:#2a3142; --text:#e8ecf4; --dim:#8b93a7; --acc:#7c5cff; --ok:#5dff9b; --warn:#f0c060; --err:#ff6b6b; }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--text); font:14px/1.4 "Segoe UI", system-ui, sans-serif; }
button, select, input { font:inherit; color:inherit; } button { cursor:pointer; }
.btn { background:#262d3d; border:1px solid var(--line); border-radius:8px; padding:6px 12px; } .btn:hover { border-color:#4a5470; }
.btn.primary { background:var(--acc); border-color:var(--acc); color:#fff; } .btn.danger { color:var(--err); } .btn.sm { padding:3px 8px; font-size:12.5px; }
select, input[type=text], input[type=number] { background:#0f131b; border:1px solid var(--line); border-radius:6px; padding:5px 8px; min-width:0; }
.top { display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
.top h1 { font-size:17px; margin:0 12px 0 0; } .top .sp { flex:1; }
.pill { font-size:12px; padding:2px 9px; border-radius:99px; background:#262d3d; color:var(--dim); } .pill.ok { color:var(--ok); } .pill.warn { color:var(--warn); }
.main { display:grid; grid-template-columns: 260px 1fr 330px; height:calc(100vh - 56px); }
.col { overflow:auto; padding:12px 14px; min-width:0; }
.main .grid { --k: clamp(44px, calc((100vw - 690px) / var(--cols) - 12px), 84px); } .col + .col { border-left:1px solid var(--line); }
.pal h3 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:14px 0 6px; }
.act { display:flex; gap:8px; align-items:center; padding:6px 8px; border-radius:8px; background:#1f2533; margin:4px 0; cursor:grab; border:1px solid transparent; user-select:none; }
.act:hover { border-color:#3d4660; } .act .ic { font-size:18px; width:24px; text-align:center; } .act small { display:block; color:var(--dim); font-size:11.5px; }
.pages { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
.pages .tab { padding:5px 12px; border-radius:99px; background:#1f2533; border:1px solid var(--line); } .pages .tab.on { background:var(--acc); border-color:var(--acc); color:#fff; }
.grid { display:grid; gap:10px; justify-content:center; padding:18px; background:#0b0d12; border-radius:18px; border:1px solid var(--line); width:max-content; margin:0 auto; }
.key { width:var(--k, 84px); height:var(--k, 84px); border-radius:14px; position:relative; overflow:hidden; border:2px solid #222838; background:#000; padding:0; display:block; }
.key img { width:100%; height:100%; display:block; pointer-events:none; }
.key.sel { outline:3px solid var(--acc); outline-offset:2px; } .key.over { outline:3px dashed var(--ok); outline-offset:2px; }
.key.empty::after { content:'+'; position:absolute; inset:0; display:grid; place-items:center; color:#333a4c; font-size:28px; }
.key:active { transform:scale(.96); }
.insp h2 { font-size:15px; margin:4px 0 10px; } .row { display:grid; grid-template-columns: 96px 1fr; gap:6px 8px; align-items:center; margin:6px 0; }
.row label { color:var(--dim); font-size:12.5px; } .note { color:var(--dim); font-size:12.5px; margin:6px 0; }
.btns { display:flex; gap:6px; flex-wrap:wrap; margin:10px 0; }
.url { font-family:Consolas, monospace; font-size:11.5px; background:#0f131b; border:1px solid var(--line); border-radius:6px; padding:6px; word-break:break-all; margin:4px 0; }
.dev h3 { margin:16px 0 4px; font-size:13.5px; } .dev p { margin:3px 0; color:var(--dim); font-size:12.5px; }
.toast { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); background:#262d3d; border:1px solid var(--line); padding:8px 14px; border-radius:10px; z-index:9; }
body.virtual { background:#07080b; } body.virtual .vwrap { display:grid; place-items:center; min-height:100vh; gap:10px; padding:16px; }
body.virtual .vbar { display:flex; gap:10px; align-items:center; color:var(--dim); font-size:12.5px; justify-content:center; }
@media (max-width: 1000px) { .main { grid-template-columns: 1fr; height:auto; } .col + .col { border-left:0; border-top:1px solid var(--line); } }
`;
document.head.append($h('style', null, CSS));
// docked (a drawer inside the studio, src/ui/dockTools.ts): Esc closes it; "Pop out ↗" / "Dock back" in the top bar
initDockedPage('deck');
const dockBtn = dockButtonSpec('deck');
if (isDocked()) document.head.append($h('style', null, 'html.vtp-docked .top h1 { display: none; } html.vtp-docked body { font-family: var(--vtpfont-ui, system-ui, "Segoe UI", sans-serif); }'));
const app = document.getElementById('app')!;
const virtual = new URLSearchParams(location.search).has('virtual');

let toastT = 0;
function toast(msg: string) {
  document.querySelector('.toast')?.remove();
  const t = $h('div', { class: 'toast' }, msg); document.body.append(t);
  clearTimeout(toastT); toastT = window.setTimeout(() => t.remove(), 2600);
}
async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}

// ---------------------------------------------------------------- state
let actions: DeckActionDef[] = [];
let layout: DeckLayout = sanitizeLayout(null);
let resolved: DeckResolved | null = null;
let live: DeckLiveState | null = null;
let deckKey = '', serverPort = 5191;
let online = false;
let page = 0;
let sel = -1;
let rooms: { id: string; name: string }[] = [];
const byId = () => new Map(actions.map((a) => [a.id, a]));

// ---------------------------------------------------------------- socket (same one the plugin uses)
let ws: WebSocket | null = null, retry = 800, seq = 0;
const waits = new Map<string, (ok: boolean, err?: string) => void>();
function connect() {
  const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/deck`);
  ws = s;
  s.onopen = () => { online = true; retry = 800; render(); };
  s.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as DeckServerMsg;
    if (m.t === 'hello') { actions = m.actions; resolved = m.resolved; live = m.live; if (adopt(m.layout)) layout = m.layout; }
    else if (m.t === 'layout') { resolved = m.resolved; if (adopt(m.layout)) layout = m.layout; }
    else if (m.t === 'state') { resolved = m.resolved; live = m.live; }
    else if (m.t === 'result') { if (m.id) { waits.get(m.id)?.(m.ok, m.error); waits.delete(m.id); } return; }
    page = Math.min(page, (virtual ? resolved?.pages.length ?? 1 : layout.pages.length) - 1);
    render();
  };
  s.onclose = () => { if (ws !== s) return; online = false; render(); setTimeout(connect, retry); retry = Math.min(8000, retry * 2); };
}
function wsSend(m: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: 'VTube Pro server is not reachable' });
  const id = `v${++seq}`;
  ws.send(JSON.stringify({ ...m, id }));
  return new Promise((res) => { waits.set(id, (ok, error) => res({ ok, error })); setTimeout(() => { if (waits.delete(id)) res({ ok: false, error: 'timeout' }); }, 4000); });
}

// ---------------------------------------------------------------- saving
let dirty = false, saveT = 0;
const adopt = (_l: DeckLayout) => !dirty;
function changed() {
  dirty = true; clearTimeout(saveT);
  saveT = window.setTimeout(async () => {
    try {
      const r = await api<{ layout: DeckLayout; resolved: DeckResolved }>('/api/deck/layout', 'PUT', layout);
      resolved = r.resolved; dirty = false; layout = r.layout;
      render();
    }
    catch (e) { toast(`Not saved: ${(e as Error).message}`); }
  }, 350);
  render();
}

// ---------------------------------------------------------------- faces
function faceFor(i: number) {
  // the editor draws from its own (maybe unsaved) layout, lit state from the server's resolve of the saved one
  const k = layout.pages[page]?.keys[i];
  if (!k) return null;
  const def = byId().get(k.action);
  const on = resolved?.pages[page]?.keys[i]?.a === k.action ? resolved.pages[page].keys[i].on : null;
  return { a: k.action, title: k.title ?? def?.label ?? k.action, icon: k.icon ?? def?.icon ?? '', color: k.color ?? '#1d2230', on };
}
const faceImg = (f: Face | null, offline = false) => $h('img', { src: svgDataUrl(faceSvg(f, 144, { offline })), alt: f?.title ?? '' });

async function press(i: number) {
  const k = layout.pages[page]?.keys[i];
  if (!k) return;
  const def = byId().get(k.action);
  if (def?.local) { page = nextPage(k.action, k.params, page, layout.pages.length); sel = -1; render(); return; }
  const r = await wsSend({ t: 'press', page, index: i });
  toast(r.ok ? `Sent: ${k.title ?? def?.label}` : `Failed: ${r.error}`);
}

// ---------------------------------------------------------------- virtual deck (plugin twin)
function renderVirtual() {
  document.body.classList.add('virtual');
  const R = resolved;
  const cols = R?.cols ?? layout.cols, pg = R?.pages[page];
  const grid = $h('div', { class: 'grid', style: `grid-template-columns:repeat(${cols}, 84px)` });
  const n = cols * (R?.rows ?? layout.rows);
  for (let i = 0; i < n; i++) {
    const f = pg?.keys[i] ?? null;
    grid.append($h('button', { class: `key${f?.a ? '' : ' empty'}`, title: f?.title ?? '', 'data-i': i, onclick: async () => {
      if (!f?.a || !R) return;
      const def = byId().get(f.a);
      if (def?.local) { page = f.a === 'page-next' ? (page + 1) % R.pages.length : f.a === 'page-prev' ? (page - 1 + R.pages.length) % R.pages.length : Math.min(R.pages.length - 1, f.go ?? 0); render(); return; }
      const r = await wsSend({ t: 'press', page, index: i });
      if (!r.ok) toast(`Failed: ${r.error}`);
    } }, f?.a ? faceImg(f, !online) : null));
  }
  app.replaceChildren($h('div', { class: 'vwrap' },
    $h('div', null, grid,
      $h('div', { class: 'vbar', style: 'margin-top:10px' }, $h('span', { class: `pill ${online ? 'ok' : 'warn'}` }, online ? '● connected' : '● offline'),
        `${R?.name ?? ''} · page ${page + 1} / ${R?.pages.length ?? 1}${pg ? ` (${pg.name})` : ''}`,
        live && !live.studio ? $h('span', { class: 'pill warn' }, 'studio closed: scene keys go nowhere') : null))));
}

// ---------------------------------------------------------------- editor
function paramField(def: DeckActionDef, k: DeckKey, p: NonNullable<DeckActionDef['params']>[number]) {
  const cur = k.params?.[p.key] ?? p.default ?? '';
  const set = (v: string | number) => { k.params = { ...(k.params ?? {}), [p.key]: v }; changed(); };
  if (p.type === 'select' || (p.type === 'room' && rooms.length)) {
    const opts = p.type === 'room' ? [{ value: '', label: 'Classic (no room)' }, ...rooms.map((r) => ({ value: r.id, label: r.name }))] : p.options ?? [];
    const s = $h('select', { onchange: () => set(s.value) }, ...opts.map((o) => $h('option', { value: o.value, selected: String(o.value) === String(cur) }, o.label)));
    return s;
  }
  const i = $h('input', { type: p.type === 'number' ? 'number' : 'text', value: cur, min: p.min, max: p.max, step: 'any', onchange: () => set(p.type === 'number' ? Number(i.value) : i.value) });
  return i;
}
function urls(i: number) {
  const k = layout.pages[page]?.keys[i];
  if (!k) return null;
  const origin = `http://127.0.0.1:${serverPort}`;
  const q = new URLSearchParams({ key: deckKey });
  for (const [a, b] of Object.entries(k.params ?? {})) q.set(a, String(b));
  return {
    get: `${origin}/api/deck/run/${k.action}?${q}`,
    press: `${origin}/api/deck/press/${page}/${i}?key=${deckKey}`,
    curl: `curl -s -X POST ${origin}/api/deck/run/${k.action} -H "Content-Type: application/json" -d "${JSON.stringify({ params: k.params ?? {} }).replace(/"/g, '\\"')}"`,
  };
}
const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast('Copied'), () => toast('Copy failed: select the text and press Ctrl+C'));

function inspector(): HTMLElement {
  const k = sel >= 0 ? layout.pages[page]?.keys[sel] : null;
  if (sel < 0) return $h('div', { class: 'insp' }, $h('h2', null, 'Key settings'), $h('p', { class: 'note' }, 'Click a key to edit it, or drag an action from the left onto a key. Double-click a key to test-press it.'), devices());
  if (!k) return $h('div', { class: 'insp' }, $h('h2', null, `Key ${sel + 1} (empty)`), $h('p', { class: 'note' }, 'Drag an action onto it, or pick one:'),
    (() => { const s = $h('select', { onchange: () => { if (s.value) { layout.pages[page].keys[sel] = { action: s.value }; changed(); } } }, $h('option', { value: '' }, '— pick an action —'), ...actions.map((a) => $h('option', { value: a.id }, `${a.icon} ${a.group}: ${a.label}`))); return s; })(), devices());
  const def = byId().get(k.action)!;
  const colour = $h('input', { type: 'color', value: k.color ?? '#1d2230', oninput: () => { k.color = colour.value; changed(); } });
  const title = $h('input', { type: 'text', value: k.title ?? '', placeholder: def.label, maxlength: 40, oninput: () => { k.title = title.value || undefined; changed(); } });
  const icon = $h('input', { type: 'text', value: k.icon && !k.icon.startsWith('data:') ? k.icon : '', placeholder: def.icon, maxlength: 16, style: 'width:70px', oninput: () => { k.icon = icon.value || undefined; changed(); } });
  const file = $h('input', { type: 'file', accept: 'image/png,image/svg+xml,image/jpeg,image/webp', style: 'display:none', onchange: () => {
    const f = file.files?.[0]; if (!f) return;
    if (f.size > 60_000) { toast('Image too big (max 60 KB — 144×144 PNG is ideal)'); return; }
    const r = new FileReader(); r.onload = () => { k.icon = String(r.result); changed(); }; r.readAsDataURL(f);
  } });
  const u = urls(sel)!;
  return $h('div', { class: 'insp' },
    $h('h2', null, `${def.icon} ${def.label}`), $h('p', { class: 'note' }, def.hint),
    $h('div', { class: 'row' }, $h('label', null, 'Title'), title),
    $h('div', { class: 'row' }, $h('label', null, 'Icon (emoji)'), $h('div', { style: 'display:flex;gap:6px' }, icon, $h('button', { class: 'btn sm', onclick: () => file.click() }, 'Image…'), k.icon?.startsWith('data:') ? $h('button', { class: 'btn sm', onclick: () => { k.icon = undefined; changed(); } }, '✕') : null, file)),
    $h('div', { class: 'row' }, $h('label', null, 'Colour'), colour),
    ...(def.params ?? []).map((p) => $h('div', { class: 'row' }, $h('label', null, p.label), paramField(def, k, p))),
    $h('div', { class: 'row' }, $h('label', null, 'Action'), (() => { const s = $h('select', { onchange: () => { layout.pages[page].keys[sel] = { action: s.value, title: k.title, color: k.color }; changed(); } }, ...actions.map((a) => $h('option', { value: a.id, selected: a.id === k.action }, `${a.icon} ${a.label}`))); return s; })()),
    $h('div', { class: 'btns' }, $h('button', { class: 'btn primary', onclick: () => press(sel) }, '▶ Test press'),
      $h('button', { class: 'btn', onclick: () => { const c = layout.pages[page].keys.indexOf(null); if (c < 0) { toast('No free key on this page'); return; } layout.pages[page].keys[c] = structuredClone(k); sel = c; changed(); } }, 'Duplicate'),
      $h('button', { class: 'btn danger', onclick: () => { layout.pages[page].keys[sel] = null; changed(); } }, 'Clear key')),
    def.local ? $h('p', { class: 'note' }, 'Page keys work on the Stream Deck plugin and the virtual deck (each device keeps its own page).') : $h('div', null,
      $h('h3', { style: 'font-size:13.5px;margin:14px 0 4px' }, 'Use this button on another device'),
      $h('p', { class: 'note' }, 'Stream Deck "Website" (GET in background), Touch Portal, Loupedeck, Companion, macro keyboards (AutoHotkey) … — these URLs only work on this PC, and carry your private key: never share them.'),
      $h('div', { class: 'url' }, u.get), $h('div', { class: 'btns' }, $h('button', { class: 'btn sm', onclick: () => copy(u.get) }, 'Copy action URL (GET)'), $h('button', { class: 'btn sm', onclick: () => copy(u.press) }, 'Copy "this key" URL'), $h('button', { class: 'btn sm', onclick: () => copy(u.curl) }, 'Copy curl (POST, no key)'))),
    devices());
}

function devices(): HTMLElement {
  return $h('div', { class: 'dev' },
    $h('h3', null, 'Devices'),
    $h('p', null, $h('b', null, 'Elgato Stream Deck: '), 'install the VTube Pro plugin (tools/streamdeck-plugin → docs/STREAM_DECK.md), put "VTube Pro Page key" on every key: this layout appears on the device, lit keys included.'),
    $h('p', null, $h('b', null, 'No hardware? '), $h('a', { href: '/deck.html?virtual=1', target: 'vtp-vdeck', style: 'color:#a99bff' }, 'Open the virtual deck'), ' — it runs exactly like the plugin.'),
    $h('p', null, $h('b', null, 'Touch Portal, Bitfocus Companion, Loupedeck, Streamer.bot, macro pads: '), 'use the per-key URLs above, or the ready files in tools/streamdeck-plugin/other-devices/.'),
    $h('p', null, 'All of this works only on this PC (127.0.0.1) and refuses other websites.'));
}

function palette(): HTMLElement {
  const groups = [...new Set(actions.map((a) => a.group))];
  return $h('div', { class: 'pal' }, $h('p', { class: 'note', style: 'margin-top:0' }, 'Drag an action onto a key.'),
    ...groups.flatMap((g) => [$h('h3', null, g), ...actions.filter((a) => a.group === g).map((a) =>
      $h('div', { class: 'act', draggable: 'true', title: a.hint, ondragstart: (e: DragEvent) => { e.dataTransfer!.setData('text/vtp-action', a.id); e.dataTransfer!.effectAllowed = 'copy'; },
        onclick: () => { if (sel >= 0 && !layout.pages[page].keys[sel]) { layout.pages[page].keys[sel] = { action: a.id }; changed(); } } },
      $h('span', { class: 'ic' }, a.icon), $h('div', null, a.label, $h('small', null, a.stateful ? 'lights up when on' : a.local ? 'deck page' : '')))),
    ]));
}

function sizeBar(): HTMLElement {
  const cur = DEVICE_SIZES.find((d) => d.cols === layout.cols && d.rows === layout.rows)?.id ?? 'custom';
  const cols = $h('input', { type: 'number', min: 1, max: MAX_COLS, value: layout.cols, style: 'width:56px', onchange: () => { layout = resizeLayout(layout, +cols.value, layout.rows); sel = -1; changed(); } });
  const rows = $h('input', { type: 'number', min: 1, max: MAX_ROWS, value: layout.rows, style: 'width:56px', onchange: () => { layout = resizeLayout(layout, layout.cols, +rows.value); sel = -1; changed(); } });
  const s = $h('select', { onchange: () => { const d = DEVICE_SIZES.find((x) => x.id === s.value); if (d) { layout = resizeLayout(layout, d.cols, d.rows); sel = -1; changed(); } } },
    ...DEVICE_SIZES.map((d) => $h('option', { value: d.id, selected: d.id === cur }, d.label)), $h('option', { value: 'custom', selected: cur === 'custom' }, 'Custom'));
  return $h('span', { style: 'display:flex;gap:6px;align-items:center' }, 'Device', s, cols, '×', rows);
}

function exportLayout() {
  const a = $h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(layout, null, 1)], { type: 'application/json' })), download: `${layout.name.replace(/[^\w-]+/g, '_') || 'deck'}.vtpdeck.json` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importLayout() {
  const f = $h('input', { type: 'file', accept: '.json,application/json', onchange: async () => {
    const file = f.files?.[0]; if (!file) return;
    try { layout = sanitizeLayout(JSON.parse(await file.text())); page = 0; sel = -1; changed(); toast(`Imported "${layout.name}"`); }
    catch { toast('That file is not a VTube Pro deck layout'); }
  } });
  f.click();
}

function renderEditor() {
  const pg = layout.pages[page];
  const grid = $h('div', { class: 'grid', style: `--cols:${layout.cols};grid-template-columns:repeat(${layout.cols}, var(--k))` });
  pg.keys.forEach((k, i) => {
    const b = $h('button', { class: `key${k ? '' : ' empty'}${i === sel ? ' sel' : ''}`, draggable: k ? 'true' : undefined, title: k ? `${k.title ?? byId().get(k.action)?.label} — double-click to test` : 'empty',
      onclick: () => { sel = i; render(); }, ondblclick: () => press(i),
      ondragstart: (e: DragEvent) => { e.dataTransfer!.setData('text/vtp-key', String(i)); e.dataTransfer!.effectAllowed = 'move'; },
      ondragover: (e: DragEvent) => { e.preventDefault(); b.classList.add('over'); }, ondragleave: () => b.classList.remove('over'),
      ondrop: (e: DragEvent) => {
        e.preventDefault(); b.classList.remove('over');
        const a = e.dataTransfer!.getData('text/vtp-action'), from = e.dataTransfer!.getData('text/vtp-key');
        if (a) pg.keys[i] = { action: a };
        else if (from !== '') { const j = +from; [pg.keys[i], pg.keys[j]] = [pg.keys[j], pg.keys[i]]; }
        sel = i; changed();
      } }, k ? faceImg(faceFor(i)) : null);
    grid.append(b);
  });
  const name = $h('input', { type: 'text', value: layout.name, style: 'width:150px', onchange: () => { layout.name = name.value || 'My deck'; changed(); } });
  const pname = $h('input', { type: 'text', value: pg.name, style: 'width:120px', onchange: () => { pg.name = pname.value || `Page ${page + 1}`; changed(); } });
  app.replaceChildren(
    $h('div', { class: 'top' }, $h('h1', null, '🎛️ Stream Deck & controllers'), name, sizeBar(), $h('span', { class: 'sp' }),
      $h('span', { class: `pill ${online ? 'ok' : 'warn'}` }, online ? '● live' : '● server offline'),
      live && !live.studio ? $h('span', { class: 'pill warn', title: 'Scene keys are bus commands: the studio must be open to apply them' }, 'studio closed') : null,
      dirty ? $h('span', { class: 'pill' }, 'saving…') : $h('span', { class: 'pill ok' }, 'saved'),
      $h('button', { class: 'btn', onclick: importLayout }, 'Import…'), $h('button', { class: 'btn', onclick: exportLayout }, 'Export'),
      $h('button', { class: 'btn', onclick: () => window.open('/deck.html?virtual=1', 'vtp-vdeck', 'popup=yes,width=620,height=420') }, 'Virtual deck ↗'),
      !virtual && dockBtn ? $h('button', { class: 'btn', title: dockBtn.title, onclick: dockBtn.run }, dockBtn.label) : null),
    $h('div', { class: 'main' },
      $h('div', { class: 'col' }, palette()),
      $h('div', { class: 'col' },
        $h('div', { class: 'pages' }, ...layout.pages.map((p, i) => $h('button', { class: `tab${i === page ? ' on' : ''}`, onclick: () => { page = i; sel = -1; render(); } }, p.name)),
          layout.pages.length < MAX_PAGES ? $h('button', { class: 'btn sm', onclick: () => { layout.pages.push({ name: `Page ${layout.pages.length + 1}`, keys: Array(layout.cols * layout.rows).fill(null) }); page = layout.pages.length - 1; sel = -1; changed(); } }, '+ Page') : null,
          $h('span', { style: 'flex:1' }), 'Page name', pname,
          layout.pages.length > 1 ? $h('button', { class: 'btn sm danger', onclick: () => { if (!confirm(`Delete page "${pg.name}"?`)) return; layout.pages.splice(page, 1); page = Math.max(0, page - 1); sel = -1; changed(); } }, 'Delete page') : null),
        grid,
        $h('p', { class: 'note', style: 'text-align:center' }, 'Green ring = on right now (lighting state, mode, room, cover, read-aloud …). Double-click a key to test it. Drag keys to move / swap them.')),
      $h('div', { class: 'col' }, inspector())));
}

function render() { if (virtual) renderVirtual(); else renderEditor(); }

// ---------------------------------------------------------------- boot
(async () => {
  document.title = virtual ? 'VTube Pro — virtual deck' : document.title;
  try {
    const r = await api<{ layout: DeckLayout; resolved: DeckResolved; live: DeckLiveState; key: string; port?: number }>('/api/deck/layout');
    layout = r.layout; resolved = r.resolved; live = r.live; deckKey = r.key; serverPort = r.port ?? 5191;
    actions = (await api<{ actions: DeckActionDef[] }>('/api/deck/actions')).actions;
  } catch (e) { toast(`VTube Pro server: ${(e as Error).message}`); }
  if (!virtual) api<{ id: string; name: string }[]>('/api/scenes').then((s) => { rooms = s.map((x) => ({ id: x.id, name: x.name })); render(); }).catch(() => {});
  render();
  connect();
  (window as unknown as { vtpDeck: unknown }).vtpDeck = { get layout() { return layout; }, get resolved() { return resolved; }, get live() { return live; }, get page() { return page; }, get online() { return online; } };
})();
