// Tools & add-ons (tools.html): the helper's catalogue of optional programs (shared/toolsCatalog.ts), what is installed
// on this computer (GET /api/tools, server/toolsCatalog.ts), and a consent dialog before anything is installed.
// Opens docked in the studio (src/ui/dockTools.ts 'tools') or on its own: http://127.0.0.1:5191/tools.html[?tool=<id>]
// is also the LOCAL confirm page people are sent to (installs are local-only; CONTRACT.md tools-catalog).
// Brand: T\portal\BRAND.md tokens, system fonts (no web fonts). No sound, no storage except try/catch'd UI prefs.
// (integration: vite/client types not referenced here; src/ui/help/globTypes.d.ts declares import.meta.glob for the project)
import '../storageGuard.ts'; // (first import: a memory-only stand-in when the page may not keep site data)
import '../licenseNotice.ts'; // hosted copies say that VTube Pro is free (LICENSE); never shown on this PC or the home network
import '../net/lanPage.ts';
import { CATEGORY_LABEL, OS_LABEL, TOOL_CATALOG, TOOL_OSES, getTool, type ToolCategory, type ToolEntry, type ToolMethod, type ToolOs } from '../../shared/toolsCatalog.ts';
import { guessOsFromUa, planFor, stateLabel, type InstallPlan, type ToolStatus, type ToolsReport } from '../../shared/toolsDetect.ts';
import { mountAiSetup } from './aiSetup.ts';

const q = new URLSearchParams(location.search);
const DOCKED = q.get('docked') === '1';

// ---------------------------------------------------------------- tiny DOM helper (textContent only, never innerHTML for data)
type Kids = (Node | string | null | undefined | false)[];
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void) | undefined> = {}, ...kids: Kids): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const nodes = (...kids: Kids): (Node | string)[] => kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false);

const CSS = `
:root { --ink:#06080a; --ink-2:#0b0f12; --ink-3:#11171b; --line:rgb(255 255 255/.08); --line-strong:rgb(255 255 255/.14);
  --fg:#eef3ef; --mute:#9aa6a0; --dim:#85918b; --lime:#7bd88f; --lime-hi:#a6f5b4; --sky:#6cc7f5; --amber:#ffcf6a; --err:#ff6b6b;
  --display: ui-sans-serif, system-ui, "Segoe UI", sans-serif; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ease: cubic-bezier(.16,1,.3,1); color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--ink); color: var(--fg); font: 15px/1.45 var(--display); -webkit-font-smoothing: antialiased; }
::selection { background: rgb(123 216 143/.35); color: #fff; }
:focus-visible { outline: 2px solid var(--lime); outline-offset: 3px; border-radius: 6px; }
a { color: var(--sky); }
.wrap { max-width: 1120px; margin: 0 auto; padding: 28px 24px 64px; }
body.docked .wrap { padding: 16px 16px 48px; }
.top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: -.01em; font-size: 17px; }
.brand svg { width: 30px; height: 30px; flex: none; }
.beta { font: 500 10px/1 var(--mono); text-transform: uppercase; letter-spacing: .12em; color: var(--lime); background: rgb(123 216 143/.1);
  border: 1px solid rgb(123 216 143/.3); border-radius: 9999px; padding: 4px 8px; }
.sp { flex: 1; }
.eyebrow { display: flex; align-items: center; gap: 10px; font: 500 11px/1 var(--mono); text-transform: uppercase; letter-spacing: .2em; color: var(--lime); margin: 28px 0 10px; }
.eyebrow::before { content: ""; width: 24px; height: 1px; background: var(--lime); }
h1 { font: 700 clamp(26px, 4vw, 38px)/1.1 var(--display); letter-spacing: -.02em; margin: 0 0 8px; }
h1 .g { background: linear-gradient(135deg,#7bd88f 0%,#6cc7f5 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
body.docked h1 { font-size: 24px; }
.lead { color: var(--mute); margin: 0 0 18px; max-width: 64ch; }
.summary { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 16px; border-radius: 16px; border: 1px solid var(--line);
  background: linear-gradient(180deg, rgb(255 255 255/.055), rgb(255 255 255/.02)); }
.summary .big { font-weight: 650; }
.summary .muted { color: var(--mute); }
.banner { margin-top: 12px; padding: 12px 14px; border-radius: 12px; border: 1px solid rgb(255 207 106/.35); background: rgb(255 207 106/.08); color: var(--fg); }
.banner.err { border-color: rgb(255 107 107/.4); background: rgb(255 107 107/.08); }
.btn { height: 44px; padding: 0 18px; border-radius: 12px; border: 1px solid var(--line-strong); background: rgb(255 255 255/.06); color: var(--fg);
  font: 600 14px/1 var(--display); cursor: pointer; display: inline-flex; align-items: center; gap: 8px; transition: background 150ms, border-color 150ms; white-space: nowrap; }
.btn:hover { background: rgb(255 255 255/.1); }
.btn.primary { background: var(--lime); border-color: var(--lime); color: var(--ink); }
.btn.primary:hover { background: var(--lime-hi); border-color: var(--lime-hi); }
.btn.ghost { border-color: transparent; background: transparent; color: var(--mute); padding: 0 10px; }
.btn.ghost:hover { color: var(--fg); background: rgb(255 255 255/.05); }
.btn.sm { height: 34px; padding: 0 12px; font-size: 13px; border-radius: 10px; }
.btn[disabled] { opacity: .45; cursor: not-allowed; }
.cat { margin-top: 30px; }
.cat h2 { font: 650 13px/1 var(--mono); text-transform: uppercase; letter-spacing: .16em; color: var(--dim); margin: 0 0 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 330px), 1fr)); gap: 14px; }
.card { border-radius: 18px; border: 1px solid var(--line); background: var(--ink-3); padding: 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.card.flash { border-color: var(--lime); box-shadow: 0 0 0 3px rgb(123 216 143/.18); }
.card .head { display: flex; align-items: flex-start; gap: 10px; }
.card .ic { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; flex: none; font-size: 18px; background: rgb(123 216 143/.1); color: var(--lime); }
.card .name { font-weight: 700; font-size: 16px; letter-spacing: -.01em; }
.card .need { font: 500 10.5px/1.2 var(--mono); color: var(--dim); text-transform: uppercase; letter-spacing: .1em; margin-top: 3px; }
.pill { margin-left: auto; flex: none; border-radius: 9999px; padding: 5px 10px; font: 600 12px/1 var(--display); border: 1px solid var(--line-strong); color: var(--mute); background: rgb(255 255 255/.03); white-space: nowrap; }
.pill.installed, .pill.included { color: var(--lime); border-color: rgb(123 216 143/.35); background: rgb(123 216 143/.1); }
.pill.outdated, .pill.needs { color: var(--amber); border-color: rgb(255 207 106/.35); background: rgb(255 207 106/.08); }
.pill.unsupported { color: var(--dim); }
.blurb { margin: 0; }
.note { margin: 0; color: var(--amber); font-size: 13.5px; }
.note.ok { color: var(--mute); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border-radius: 9999px; border: 1px solid var(--line-strong); background: rgb(255 255 255/.03); color: var(--mute); font-size: 12px; padding: 3px 9px; }
.chip a { color: inherit; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: auto; padding-top: 4px; }
.where { font: 12px/1.3 var(--mono); color: var(--dim); overflow-wrap: anywhere; }
.guide { border-top: 1px solid var(--line); padding-top: 10px; display: none; }
.card.open .guide { display: block; }
.tabs { display: flex; gap: 4px; margin-bottom: 8px; }
.tab { height: 30px; padding: 0 10px; border-radius: 9999px; border: 1px solid var(--line); background: transparent; color: var(--mute); font: 600 12.5px/1 var(--display); cursor: pointer; }
.tab[aria-selected="true"] { background: rgb(123 216 143/.12); color: var(--lime); border-color: rgb(123 216 143/.35); }
ol.steps { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
ol.steps li::marker { color: var(--lime); font-weight: 700; }
.cmd { display: flex; gap: 6px; align-items: stretch; margin-top: 6px; }
.cmd code { flex: 1; min-width: 0; font: 12.5px/1.4 var(--mono); background: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; overflow-wrap: anywhere; color: var(--fg); }
.alts { margin-top: 10px; display: grid; gap: 8px; }
.alt { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--ink-2); }
.alt b { display: block; margin-bottom: 2px; }
.alt p { margin: 0; color: var(--mute); font-size: 13.5px; }
.extra { color: var(--mute); font-size: 13.5px; margin: 8px 0 0; }
dialog { border: 1px solid var(--line); background: var(--ink-3); color: var(--fg); border-radius: 20px; padding: 24px; width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px); }
dialog::backdrop { background: rgb(5 7 11/.7); }
dialog h3 { font: 700 23px/1.15 var(--display); letter-spacing: -.02em; margin: 6px 0 8px; }
dialog .eyebrow { margin: 0; }
dialog p { margin: 0 0 12px; color: var(--mute); }
dialog ul { margin: 0 0 14px; padding-left: 20px; display: grid; gap: 6px; }
.methods { display: grid; gap: 8px; margin: 0 0 14px; }
.method { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line-strong); cursor: pointer; }
.method:has(input:checked) { border-color: var(--lime); background: rgb(123 216 143/.07); }
.method input { accent-color: var(--lime); margin-top: 3px; }
.method small { display: block; color: var(--dim); font-size: 12px; }
.facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13.5px; margin: 0 0 14px; }
.facts dt { color: var(--dim); }
.facts dd { margin: 0; }
.agree { display: flex; gap: 10px; align-items: flex-start; padding: 12px; border-radius: 12px; background: var(--ink-2); border: 1px solid var(--line); margin-bottom: 16px; cursor: pointer; }
.agree input { width: 18px; height: 18px; accent-color: var(--lime); margin: 1px 0 0; flex: none; }
.actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.actions .btn.primary { min-width: 140px; justify-content: center; }
.done { font-size: 40px; line-height: 1; }
.err { color: var(--err); }
@media (prefers-reduced-motion: no-preference) { .card { transition: border-color 200ms var(--ease), box-shadow 200ms var(--ease); } dialog[open] { animation: dl-in 220ms var(--ease); } @keyframes dl-in { from { transform: translateY(8px); opacity: 0; } } }
@media (max-width: 520px) { .wrap { padding: 18px 16px 48px; } .actions .btn { flex: 1; } }
`;

const MARK = () => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '8 16 84 72'); svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS(ns, 'defs');
  const g = document.createElementNS(ns, 'linearGradient');
  g.id = 'vtpg'; g.setAttribute('gradientUnits', 'userSpaceOnUse'); g.setAttribute('x1', '22'); g.setAttribute('y1', '66'); g.setAttribute('x2', '80'); g.setAttribute('y2', '34');
  for (const [o, c] of [['0', '#8be39b'], ['.3', '#7bd88f'], ['.7', '#6cc7f5'], ['1', '#7fd2ff']]) { const s = document.createElementNS(ns, 'stop'); s.setAttribute('offset', o); s.setAttribute('stop-color', c); g.append(s); }
  defs.append(g);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M12 20H30L46.6 48V61L60.5 50.5L54.3 41.3L67 20H88L50 84Z'); p.setAttribute('fill', 'url(#vtpg)');
  svg.append(defs, p);
  return svg;
};

const ICON: Record<string, string> = { blender: '◆', 'vtp-blender-kit': '✦', ffmpeg: '▶', 'python-spout': '⧉', comfyui: '✿', ollama: '◉', lmstudio: '◎', llamacpp: '❯', obs: '●', 'obs-websocket': '⇄', 'obs-shaderfilter': '◱', distroav: '⇶' };
const CAT_ORDER: ToolCategory[] = ['3d', 'art', 'video', 'ai', 'obs', 'windows'];

// ---------------------------------------------------------------- state
let os: ToolOs = guessOsFromUa(`${(navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ''} ${navigator.userAgent}`);
let report: ToolsReport | null = null;
let problem: '' | 'no-helper' | 'error' = '';
let loading = true;
const statusOf = (id: string): ToolStatus | undefined => report?.tools.find((t) => t.id === id);
const openGuides = new Set<string>();

async function load(refresh = false) {
  loading = true; render();
  try {
    const r = await fetch(`/api/tools${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
    if (!r.ok) {
      // 503 {helper:true} = web mode without a helper (web-studio shim); 401 = not paired; 5xx = the helper is not running
      problem = r.status === 401 || r.status === 404 || r.status >= 500 ? 'no-helper' : 'error';
      report = null;
    } else {
      report = await r.json() as ToolsReport;
      os = report.os;
      problem = '';
    }
  } catch { problem = 'no-helper'; report = null; }
  loading = false;
  render();
}

// ---------------------------------------------------------------- copy
async function copy(text: string, btn: HTMLButtonElement) {
  let done = false;
  try { await navigator.clipboard.writeText(text); done = true; } catch {
    try { const t = h('textarea', {}, text); document.body.append(t); t.select(); done = document.execCommand('copy'); t.remove(); } catch { /* */ }
  }
  const old = btn.textContent;
  btn.textContent = done ? 'Copied ✔' : 'Select & copy';
  setTimeout(() => { btn.textContent = old; }, 1600);
}
const cmdBox = (command: string) => { const b = h('button', { class: 'btn sm', type: 'button' }, 'Copy'); b.onclick = () => void copy(command, b); return h('div', { class: 'cmd' }, h('code', {}, command), b); };

// ---------------------------------------------------------------- guide (per-OS steps)
function guideEl(t: ToolEntry): HTMLElement {
  let shown: ToolOs = os;
  const body = h('div', {});
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const draw = () => {
    tabs.replaceChildren(...TOOL_OSES.map((o) => {
      const b = h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(o === shown) }, OS_LABEL[o] + (o === os ? ' (this one)' : ''));
      b.onclick = () => { shown = o; draw(); };
      return b;
    }));
    const info = t.os[shown];
    const kids: Kids = [];
    if (!info.supported && info.why) kids.push(h('p', { class: 'extra', style: 'margin:0 0 10px' }, info.why));
    kids.push(h('ol', { class: 'steps' }, ...info.steps.map((s) => h('li', {}, s.text, s.url ? h('div', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, new URL(s.url).hostname + ' ↗')) : null, s.command ? cmdBox(s.command) : null))));
    const alts = (t.alternatives ?? []).filter((a) => !a.os || a.os.includes(shown));
    if (alts.length) kids.push(h('div', { class: 'alts' }, ...alts.map((a) => h('div', { class: 'alt' }, h('b', {}, a.name), h('p', {}, a.text), a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, 'Learn more ↗') : null))));
    for (const g of t.guide ?? []) kids.push(h('p', { class: 'extra' }, g));
    body.replaceChildren(...kids.filter(Boolean) as Node[]);
  };
  draw();
  return h('div', { class: 'guide' }, tabs, body);
}

// ---------------------------------------------------------------- consent dialog
function bestMethods(t: ToolEntry): ToolMethod[] {
  const ms = t.os[os].methods;
  // runnable first on the helper's own page; the web page can only open links itself
  return [...ms].sort((a, b) => score(b) - score(a));
  function score(m: ToolMethod) { return m.kind === 'package-manager' && m.runnable ? 3 : m.kind === 'open-url' ? 2 : 0; }
}

async function postJson(path: string, body: unknown): Promise<{ status: number; j: Record<string, unknown> }> {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, j: await r.json().catch(() => ({})) as Record<string, unknown> };
  } catch { return { status: 0, j: { error: 'VTube Pro did not answer.' } }; }
}

function openInstall(t: ToolEntry) {
  const dlg = h('dialog', { 'aria-labelledby': 'dl-title' });
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  const methods = bestMethods(t);
  let methodId = methods[0]?.id ?? '';
  const close = () => dlg.close();

  const step1 = () => {
    const plan = planFor(t, os, methodId);
    if (!plan) { dlg.replaceChildren(h('h3', { id: 'dl-title' }, `${t.name} isn’t available here`), h('p', {}, t.os[os].why ?? 'Open the guide for other options.'), h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'OK'))); return; }
    const agree = h('input', { type: 'checkbox', id: 'dl-agree' });
    const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, plan.runnable ? (plan.kind === 'open-url' ? 'Open the page' : 'Install') : 'Show me the command');
    agree.onchange = () => { go.disabled = !agree.checked; };
    const radios = methods.length > 1 ? h('div', { class: 'methods', role: 'radiogroup', 'aria-label': 'How to install' }, ...methods.map((m) => {
      const r = h('input', { type: 'radio', name: 'm', value: m.id, checked: m.id === methodId });
      r.onchange = () => { methodId = m.id; step1(); };
      return h('label', { class: 'method' }, r, h('span', {}, m.label, h('small', {}, m.kind === 'open-url' ? `Opens ${new URL(m.url!).hostname} in your browser` : m.runnable ? 'Opens a window you can watch' : 'You copy one command into a terminal')));
    })) : null;
    go.onclick = () => void confirmPlan(plan, go);
    dlg.replaceChildren(...nodes(
      h('div', { class: 'eyebrow' }, 'Step 1 of 2'),
      h('h3', { id: 'dl-title' }, plan.title),
      h('p', {}, t.blurb),
      radios,
      h('p', { style: 'margin-bottom:6px;color:var(--fg);font-weight:600' }, 'What happens'),
      h('ul', {}, ...plan.happens.map((x) => h('li', {}, x))),
      h('dl', { class: 'facts' }, h('dt', {}, 'From'), h('dd', {}, plan.source), h('dt', {}, 'Download'), h('dd', {}, plan.size), h('dt', {}, 'Licence'), h('dd', {}, h('a', { href: t.licence.url, target: '_blank', rel: 'noopener noreferrer' }, plan.licence))),
      h('label', { class: 'agree', for: 'dl-agree' }, agree, h('span', {}, `I understand this ${plan.kind === 'open-url' ? 'opens the official download page so I can install' : 'installs'} ${t.name} on this computer.`)),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancel'), go),
    ));
  };

  const confirmPlan = async (plan: InstallPlan, btn: HTMLButtonElement) => {
    btn.disabled = true;
    // copy-only (Linux sudo, scripts): never run by the helper
    if (!plan.runnable) { step2Copy(plan); return; }
    const p = await postJson(`/api/tools/${t.id}/plan`, { method: plan.methodId });
    const token = (p.j.consent as { token?: string } | undefined)?.token;
    if (p.status !== 200 || !token) { fail(String(p.j.error ?? 'VTube Pro said no.')); return; }
    const r = await postJson(`/api/tools/${t.id}/install`, { method: plan.methodId, token, iUnderstand: true });
    if (r.status !== 200) { fail(String(r.j.error ?? 'Something went wrong.')); return; }
    step2(String(r.j.next ?? 'Finish the installer, then press “Check again”.'));
  };
  const fail = (msg: string) => dlg.replaceChildren(h('h3', { id: 'dl-title' }, 'That didn’t work'), h('p', { class: 'err' }, msg),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Close'), h('button', { class: 'btn primary', type: 'button', onclick: step1 }, 'Try again')));
  const step2 = (msg: string) => dlg.replaceChildren(h('div', { class: 'eyebrow' }, 'Step 2 of 2'), h('div', { class: 'done', 'aria-hidden': 'true' }, '⏳'),
    h('h3', { id: 'dl-title' }, 'Almost there'), h('p', {}, msg),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Close'), h('button', { class: 'btn primary', type: 'button', onclick: () => { close(); void load(true); } }, 'Check again')));
  const step2Copy = (plan: InstallPlan) => dlg.replaceChildren(h('div', { class: 'eyebrow' }, 'Step 2 of 2'), h('h3', { id: 'dl-title' }, 'Copy this into a terminal'),
    h('p', {}, plan.admin ? 'It asks for your password, because it installs for the whole computer. When it finishes, come back here.' : 'When it finishes, come back here.'),
    cmdBox(plan.command ?? ''), h('div', { style: 'height:16px' }),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Close'), h('button', { class: 'btn primary', type: 'button', onclick: () => { close(); void load(true); } }, 'I did it — check again')));

  step1();
  dlg.showModal();
}

// ---------------------------------------------------------------- cards
function card(t: ToolEntry): HTMLElement {
  const st = statusOf(t.id);
  const supported = t.os[os].supported;
  const state = st?.state ?? (supported ? (t.included ? 'included' : 'unknown') : 'unsupported');
  const label = st ? stateLabel(st) : state === 'unsupported' ? 'Not for this computer' : state === 'included' ? 'Comes with VTube Pro' : loading ? 'Checking…' : 'Unknown';
  const el = h('article', { class: `card${openGuides.has(t.id) ? ' open' : ''}`, id: `tool-${t.id}` });
  const toggle = h('button', { class: 'btn ghost sm', type: 'button', 'aria-expanded': String(openGuides.has(t.id)) }, openGuides.has(t.id) ? 'Hide guide' : 'Open guide');
  toggle.onclick = () => { if (openGuides.has(t.id)) openGuides.delete(t.id); else openGuides.add(t.id); render(); };
  const buttons: Kids = [];
  if (supported && !t.included && (state === 'missing' || state === 'outdated' || state === 'unknown') && t.os[os].methods.length)
    buttons.push(h('button', { class: 'btn primary sm', type: 'button', onclick: () => openInstall(t) }, state === 'outdated' ? 'Update' : 'Install'));
  if (state === 'needs' && st?.missing?.length) {
    const dep = getTool(st.missing[0]);
    if (dep) buttons.push(h('button', { class: 'btn sm', type: 'button', onclick: () => focusTool(dep.id) }, `Get ${dep.name} first`));
  }
  if (state === 'unsupported' && t.alternatives?.length && !openGuides.has(t.id)) toggle.textContent = 'See other options';
  buttons.push(toggle);
  const note = st?.note && state !== 'unsupported' ? st.note : state === 'unsupported' ? t.os[os].why : '';
  el.append(...nodes(
    h('div', { class: 'head' }, h('div', { class: 'ic', 'aria-hidden': 'true' }, ICON[t.id] ?? '•'),
      h('div', {}, h('div', { class: 'name' }, t.name), h('div', { class: 'need' }, t.need === 'feature' ? 'Used by VTube Pro features' : 'Optional')),
      h('span', { class: `pill ${state}` }, label)),
    h('p', { class: 'blurb' }, t.blurb),
    note ? h('p', { class: `note${state === 'installed' || state === 'included' || state === 'unsupported' ? ' ok' : ''}` }, note) : null,
    h('div', { class: 'chips' }, h('span', { class: 'chip' }, `Download: ${t.size.download}`), h('span', { class: 'chip' }, `Disk: ${t.size.disk}`),
      h('span', { class: 'chip' }, h('a', { href: t.licence.url, target: '_blank', rel: 'noopener noreferrer' }, t.licence.name))),
    st?.path ? h('div', { class: 'where' }, `Found at ${st.path}${st.running ? ' · running' : ''}`) : st?.running ? h('div', { class: 'where' }, 'Running on this computer') : null,
    h('div', { class: 'row' }, ...buttons),
    guideEl(t),
  ));
  return el;
}

function focusTool(id: string) {
  const el = document.getElementById(`tool-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1800);
}

/** The way in to "Set up AI creation" (tools.html?view=ai-setup): Blender + the AI apps in one flow. */
function aiSetupCard(): HTMLElement {
  const b = statusOf('blender');
  const ready = b?.state === 'installed';
  const href = `?view=ai-setup${DOCKED ? '&docked=1' : ''}`;
  return h('section', { class: 'cat' }, h('article', { class: 'card', style: 'border-color:rgb(123 216 143/.35);background:linear-gradient(135deg,rgb(123 216 143/.08),rgb(108 199 245/.06))' },
    h('div', { class: 'head' }, h('div', { class: 'ic', 'aria-hidden': 'true' }, '✦'), h('div', {}, h('div', { class: 'name' }, 'Set up AI creation'), h('div', { class: 'need' }, 'Blender + your AI app, in one go')),
      h('span', { class: `pill ${ready ? 'installed' : ''}` }, ready ? 'Blender ready ✔' : 'Start here')),
    h('p', { class: 'blurb' }, 'Lets Claude, ChatGPT / Codex, Cursor, VS Code, Gemini and other AI apps build rooms, avatars and costumes in VTube Pro: we find or install Blender, add VTube Pro to your AI app and check it all works.'),
    h('div', { class: 'row' }, h('a', { class: 'btn primary sm', href, style: 'text-decoration:none' }, 'Set up AI creation'))));
}

// ---------------------------------------------------------------- page
const root = document.getElementById('app') ?? document.body;
function render() {
  const ready = report ? report.tools.filter((s) => (s.state === 'installed' || s.state === 'included')).length : 0;
  const forOs = TOOL_CATALOG.filter((t) => t.os[os].supported).length;
  const check = h('button', { class: 'btn', type: 'button', disabled: loading, onclick: () => void load(true) }, loading ? 'Checking…' : '↻ Check again');
  const head = h('div', { class: 'top' }, h('div', { class: 'brand' }, MARK(), 'VTube Pro', h('span', { class: 'beta' }, 'Beta')), h('span', { class: 'sp' }), check);
  const summary = h('div', { class: 'summary', role: 'status', 'aria-live': 'polite' },
    report ? h('span', { class: 'big' }, `${ready} of ${forOs} ready on this ${OS_LABEL[os]} computer`) : h('span', { class: 'big' }, loading ? 'Looking at what’s on this computer…' : `Showing the ${OS_LABEL[os]} guide`),
    h('span', { class: 'muted' }, 'Nothing is installed unless you say so.'));
  const banner = problem === 'no-helper'
    ? h('div', { class: 'banner' }, 'VTube Pro didn’t answer, so we can’t check what’s installed. Is VTube Pro running?')
    : problem === 'error' ? h('div', { class: 'banner err' }, 'Something went wrong while checking. Press “Check again”.') : null;
  const cats = CAT_ORDER.map((c) => {
    const list = TOOL_CATALOG.filter((t) => t.category === c);
    return list.length ? h('section', { class: 'cat' }, h('h2', {}, CATEGORY_LABEL[c]), h('div', { class: 'grid' }, ...list.map(card))) : null;
  });
  root.replaceChildren(h('div', { class: 'wrap' }, head,
    h('div', { class: 'eyebrow' }, 'Tools & add-ons'),
    h('h1', {}, 'Make VTube Pro do ', h('span', { class: 'g' }, 'more')),
    h('p', { class: 'lead' }, 'Free extras for 3D models, video, AI on your own computer and OBS. Each one says what it’s for, how big it is, and where it comes from. Install only what you want.'),
    summary, banner, aiSetupCard(), ...cats));
}

function boot() {
  document.head.append(h('style', {}, CSS));
  if (DOCKED) document.body.classList.add('docked');
  // "Set up AI creation" (lane toolsetup, beta.12): Blender + the MCP server for the user's AI apps, one flow (src/tools/aiSetup.ts)
  if (q.get('view') === 'ai-setup') { mountAiSetup(root, { docked: DOCKED, tools: `${location.pathname}${DOCKED ? '?docked=1' : ''}`, markEl: MARK }); return; }
  if (q.get('view') === 'djlib') { void import('./djlibView.ts').then((m) => m.mountDjlib(root, MARK)); return; }   // the Track library on this PC (beta.13.1): where the DJ library import runs
  if (q.get('view') === 'to3d') { void import('../ui/to3dPanel.ts').then((m) => m.openTo3d({ avatarId: '', setupOnly: true, inline: root })); return; }   // the 3D-version set-up checklist (lane to3dfix): where installs run
  render();
  void load().then(() => {
    const want = q.get('tool');
    const t = want ? getTool(want) : undefined;
    if (t) { focusTool(t.id); if (t.os[os].supported && t.os[os].methods.length && !t.included && statusOf(t.id)?.state !== 'installed') openInstall(t); }
  });
}
boot();
