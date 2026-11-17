// "Set up AI creation" (lane toolsetup, beta.12): tools.html?view=ai-setup on the helper. One flow for people who just
// want their AI app to build things in VTube Pro: (1) Blender found / installed from the official source and saved,
// (2) VTube Pro's MCP server added to the AI apps on this computer (preview of exactly what is written, a backup first,
// verified), (3) a checklist with self-tests. API: server/aiSetup.ts (/api/ai-setup/*, local only); installs reuse the
// Tools list's consent flow (/api/tools/blender/plan + /install). No sound, no storage, textContent only for data.
// Mounted by src/tools/main.ts (which owns the shared page CSS: .wrap .btn .card .pill dialog .agree .cmd ...).

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

const fill = (el: HTMLElement, ...kids: Kids) => el.replaceChildren(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false));

// ---------------------------------------------------------------- API shapes (server/aiSetup.ts)
type Compat = 'ok' | 'newer' | 'old' | 'unknown';
interface Install { path: string; source: string; sourceLabel: string; runs: boolean; version?: string; compat: Compat; note?: string }
interface Way { title: string; recommended?: boolean; steps: { text: string; command?: string; url?: string }[] }
interface BlenderRep {
  state: 'ready' | 'unsaved' | 'outdated' | 'blocked' | 'missing'; summary: string; chosen: Install | null; saved: { path: string; ok: boolean } | null; installs: Install[];
  linux?: { flavor: { label: string; immutable: boolean }; plan: { intro: string; ways: Way[] } };
}
interface Method { id: string; kind: string; label: string; runnable: boolean; command?: string; url?: string }
interface AppRow { id: string; name: string; getUrl: string; getLabel: string; supported: boolean; why?: string; installed: boolean | null; registered: boolean; current: boolean; configPath: string | null; viaCli: boolean }
interface Status {
  os: 'win' | 'mac' | 'linux'; blender: BlenderRep; blenderInstall: { methods: Method[] };
  mcp: { launch: { kind: string; ok: boolean; problem?: string; warning?: string }; apps: AppRow[] };
  comfy: { found: boolean; running: boolean; version?: string };
}
interface Check { ok: boolean; title: string; detail?: string; fix?: string; tools?: number; helper?: string }
interface Preview { name: string; configPath: string; exists: boolean; action: 'create' | 'add' | 'update' | 'same'; entryText: string; others: string[]; backupPattern: string | null; cli?: string; manual: string; refused?: string }

async function api<T>(method: string, url: string, body?: unknown): Promise<{ status: number; j: T & { error?: string } }> {
  try {
    const r = await fetch(url, { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, j: await r.json().catch(() => ({})) as T & { error?: string } };
  } catch { return { status: 0, j: { error: 'VTube Pro did not answer. Is VTube Pro running?' } as T & { error?: string } }; }
}

const CSS = `
.ais .back { text-decoration: none; }
.ais .lead { margin-bottom: 22px; }
.ais .check { display: grid; gap: 8px; }
.ais .ck { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--ink-3); min-width: 0; }
.ais .ck .mk { width: 28px; height: 28px; border-radius: 9999px; display: grid; place-items: center; flex: none; font-weight: 800; font-size: 15px; }
.ais .ck .mk.yes { background: rgb(123 216 143/.16); color: var(--lime); }
.ais .ck .mk.no { background: rgb(255 107 107/.14); color: var(--err); }
.ais .ck .mk.warn { background: rgb(255 207 106/.14); color: var(--amber); }
.ais .ck .mk.opt { background: rgb(255 255 255/.06); color: var(--dim); }
.ais .ck .tx { flex: 1; min-width: 0; }
.ais .ck .tx b { display: block; font-size: 14.5px; }
.ais .ck .tx span { color: var(--mute); font-size: 13.5px; overflow-wrap: anywhere; }
.ais .step { margin-top: 26px; border-radius: 20px; border: 1px solid var(--line); background: var(--ink-2); padding: 18px; }
.ais .step > header { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.ais .num { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; font: 700 15px/1 var(--mono); background: rgb(123 216 143/.12); color: var(--lime); flex: none; }
.ais .step h2 { font: 700 20px/1.2 var(--display); letter-spacing: -.01em; margin: 0; }
.ais .step .sum { margin: 0 0 12px; }
.ais .apps { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 10px; }
.ais .app { border: 1px solid var(--line); border-radius: 14px; background: var(--ink-3); padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ais .app.dim { opacity: .72; }
.ais .app .nm { display: flex; align-items: center; gap: 8px; font-weight: 700; }
.ais .app .nm .pill { margin-left: auto; }
.ais .app small { color: var(--mute); font-size: 12.5px; }
.ais .app .links { display: flex; gap: 14px; flex-wrap: wrap; }
.ais .lnk { background: none; border: 0; padding: 2px 0; color: var(--mute); font: 600 12.5px/1.2 var(--display); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgb(255 255 255/.2); }
.ais .lnk:hover { color: var(--fg); }
.ais .res { border-radius: 12px; padding: 10px 12px; font-size: 13.5px; border: 1px solid var(--line); background: var(--ink); }
.ais .res.good { border-color: rgb(123 216 143/.35); }
.ais .res.bad { border-color: rgb(255 107 107/.4); }
.ais .res b { display: block; }
.ais .res span { color: var(--mute); }
.ais pre.entry { margin: 0 0 12px; max-height: 240px; overflow: auto; font: 12px/1.45 var(--mono); background: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 10px; color: var(--fg); white-space: pre-wrap; overflow-wrap: anywhere; }
.ais .ways { display: grid; gap: 10px; }
.ais .way { border: 1px solid var(--line); border-radius: 14px; padding: 12px; background: var(--ink-3); }
.ais .way.rec { border-color: rgb(123 216 143/.35); }
.ais .way h3 { margin: 0 0 8px; font-size: 15px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ais .tag { font: 600 10.5px/1 var(--mono); text-transform: uppercase; letter-spacing: .1em; color: var(--lime); border: 1px solid rgb(123 216 143/.35); border-radius: 9999px; padding: 4px 7px; }
.ais .copies { display: grid; gap: 6px; margin-top: 8px; }
.ais .copy { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 13px; padding: 8px 10px; border-radius: 10px; background: var(--ink-3); border: 1px solid var(--line); }
.ais .copy .where { flex: 1; min-width: 200px; }
.ais .pathrow { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.ais .pathrow input { flex: 1; min-width: 220px; height: 40px; border-radius: 10px; border: 1px solid var(--line-strong); background: var(--ink); color: var(--fg); padding: 0 12px; font: 13px var(--mono); }
.ais details summary { cursor: pointer; color: var(--mute); font-size: 13.5px; margin-top: 10px; }
.ais .wait { display: flex; align-items: center; gap: 10px; color: var(--amber); font-size: 14px; }
.ais .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgb(255 207 106/.3); border-top-color: var(--amber); flex: none; }
@media (prefers-reduced-motion: no-preference) { .ais .spin { animation: ais-spin .9s linear infinite; } @keyframes ais-spin { to { transform: rotate(360deg); } } }
@media (max-width: 520px) { .ais .step { padding: 14px; } .ais .ck { padding: 10px 12px; } }
`;

const COPY = async (text: string, btn: HTMLButtonElement) => {
  let done = false;
  try { await navigator.clipboard.writeText(text); done = true; } catch {
    try { const t = h('textarea', {}, text); document.body.append(t); t.select(); done = document.execCommand('copy'); t.remove(); } catch { /* */ }
  }
  const old = btn.textContent;
  btn.textContent = done ? 'Copied ✔' : 'Select & copy';
  setTimeout(() => { btn.textContent = old; }, 1600);
};
const cmdBox = (command: string) => { const b = h('button', { class: 'btn sm', type: 'button' }, 'Copy'); b.onclick = () => void COPY(command, b); return h('div', { class: 'cmd' }, h('code', {}, command), b); };
const resBox = (c: Check) => h('div', { class: `res ${c.ok ? 'good' : 'bad'}`, role: 'status' }, h('b', {}, `${c.ok ? '✔' : '✖'} ${c.title}`), c.detail ? h('span', {}, c.detail) : null, c.fix ? h('div', { style: 'margin-top:4px' }, c.fix) : null);
const ACTION: Record<Preview['action'], string> = { create: 'creates this settings file', add: 'adds VTube Pro to this settings file', update: 'updates the VTube Pro entry in this settings file', same: 'is already set up exactly like this (nothing changes)' };

export function mountAiSetup(root: HTMLElement, o: { docked: boolean; tools: string; markEl: () => SVGElement }) {
  document.head.append(h('style', {}, CSS));
  let st: Status | null = null;
  let problem = '';
  let loading = true;
  let waiting: { until: number; timer: number } | null = null;
  const results = new Map<string, Check>();       // 'blender', 'mcp', 'app:<id>'
  const busy = new Set<string>();

  async function load() {
    loading = true; draw();
    const r = await api<Status>('GET', '/api/ai-setup/status');
    if (r.status === 200) { st = r.j; problem = ''; } else { problem = r.j.error ?? (r.status === 403 ? 'Open this page in VTube Pro on this computer.' : 'VTube Pro did not answer.'); }
    loading = false; draw();
  }
  const run = async (key: string, fn: () => Promise<void>) => { if (busy.has(key)) return; busy.add(key); draw(); try { await fn(); } finally { busy.delete(key); draw(); } };

  // ------------------------------------------------ Blender
  const useBlender = (p: string) => run('use', async () => {
    const r = await api<{ blender: BlenderRep }>('POST', '/api/ai-setup/blender/use', { path: p });
    if (r.status !== 200) { results.set('blender', { ok: false, title: 'We can’t use that one', fix: r.j.error }); return; }
    if (st) st.blender = r.j.blender;
    results.delete('blender');
  });
  const detectNow = async (): Promise<boolean> => {
    const r = await api<{ blender: BlenderRep; saved: string | null }>('POST', '/api/ai-setup/blender/detect');
    if (r.status === 200 && st) st.blender = r.j.blender;
    return r.status === 200 && r.j.blender.state === 'ready';
  };
  const stopWaiting = () => { if (waiting) clearInterval(waiting.timer); waiting = null; draw(); };
  /** After an install starts: look every 5 s (up to 20 min); when Blender shows up it is saved for VTube Pro. */
  const startWaiting = () => {
    if (waiting) return;
    const until = Date.now() + 20 * 60_000;
    const timer = window.setInterval(async () => {
      if (!waiting) return;
      if (Date.now() > until) { stopWaiting(); results.set('blender', { ok: false, title: 'We didn’t see Blender arrive', fix: 'When the installer has finished, press “Check again”. Installed somewhere unusual? Paste its path below.' }); draw(); return; }
      if (await detectNow()) { stopWaiting(); results.set('blender', { ok: true, title: 'Blender is installed and saved for VTube Pro', detail: 'Run the Blender check below to be sure.' }); }
      draw();
    }, 5000);
    waiting = { until, timer };
    draw();
  };

  function installDialog(m: Method) {
    const dlg = h('dialog', { class: 'ais', 'aria-labelledby': 'ais-dl' });
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    const close = () => dlg.close();
    const agree = h('input', { type: 'checkbox', id: 'ais-agree' });
    const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, m.kind === 'open-url' ? 'Open the page' : 'Install');
    agree.onchange = () => { go.disabled = !agree.checked; };
    const fail = (msg: string) => fill(dlg, h('h3', { id: 'ais-dl' }, 'That didn’t work'), h('p', { class: 'err' }, msg), h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Close')));
    go.onclick = async () => {
      go.disabled = true;
      const p = await api<{ consent?: { token: string } }>('POST', '/api/tools/blender/plan', { method: m.id });
      const token = p.j.consent?.token;
      if (p.status !== 200 || !token) { fail(p.j.error ?? 'VTube Pro said no.'); return; }
      const r = await api<{ next?: string }>('POST', '/api/tools/blender/install', { method: m.id, token, iUnderstand: true });
      if (r.status !== 200) { fail(r.j.error ?? 'Something went wrong.'); return; }
      fill(dlg, h('div', { class: 'eyebrow' }, 'Step 2 of 2'), h('h3', { id: 'ais-dl' }, 'Almost there'), h('p', {}, r.j.next ?? 'Finish the installer.'),
        h('p', {}, 'Leave this page open: we look for Blender every few seconds and save it for VTube Pro as soon as it is there.'),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'OK')));
      startWaiting();
    };
    const happens = m.kind === 'open-url'
      ? [`Your web browser opens ${new URL(m.url!).hostname}, Blender’s official download page.`, 'You download and run the installer yourself. Nothing downloads until you click there.']
      : [`A ${st?.os === 'win' ? 'command window' : 'Terminal window'} opens on this computer and runs: ${m.command}`, 'It downloads Blender (about 400 MB) from the Blender Foundation’s official package.', 'Any licence question appears in that window for YOU to answer. VTube Pro never answers for you.'];
    fill(dlg, h('div', { class: 'eyebrow' }, 'Step 1 of 2'), h('h3', { id: 'ais-dl' }, 'Install Blender?'),
      h('p', {}, 'A free 3D program (GPL licence, about 1.5 GB on disk) that VTube Pro runs quietly in the background for every “make it with AI” job.'),
      h('p', { style: 'margin-bottom:6px;color:var(--fg);font-weight:600' }, 'What happens'), h('ul', {}, ...happens.map((x) => h('li', {}, x))),
      h('label', { class: 'agree', for: 'ais-agree' }, agree, h('span', {}, `I understand this ${m.kind === 'open-url' ? 'opens the official download page so I can install' : 'installs'} Blender on this computer.`)),
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancel'), go));
    dlg.showModal();
  }

  function blenderStep(): HTMLElement {
    const b = st!.blender;
    const pill = b.state === 'ready' ? h('span', { class: 'pill installed' }, `Ready ✔ ${b.chosen?.version ?? ''}`) : b.state === 'unsaved' ? h('span', { class: 'pill outdated' }, 'Found: confirm') : b.state === 'outdated' ? h('span', { class: 'pill outdated' }, 'Too old') : h('span', { class: 'pill' }, b.state === 'blocked' ? 'Can’t be used' : 'Not installed');
    const kids: Kids = [h('p', { class: 'sum' }, b.summary)];
    if (b.chosen) kids.push(h('div', { class: 'where' }, `${b.chosen.path}  ·  from ${b.chosen.sourceLabel}`));
    if (b.chosen?.note && b.state !== 'missing') kids.push(h('p', { class: 'note' }, b.chosen.note));
    const row: Kids = [];
    if (b.state === 'unsaved' && b.chosen) row.push(h('button', { class: 'btn primary', type: 'button', disabled: busy.has('use'), onclick: () => void useBlender(b.chosen!.path) }, busy.has('use') ? 'Saving…' : 'Use this Blender'));
    if (b.chosen) row.push(h('button', { class: `btn${b.state === 'ready' ? ' primary' : ''}`, type: 'button', disabled: busy.has('btest'), onclick: () => void blenderTest() }, busy.has('btest') ? 'Running Blender…' : 'Run the Blender check'));
    if (row.length) kids.push(h('div', { class: 'row' }, ...row));
    if (results.get('blender')) kids.push(resBox(results.get('blender')!));
    if (waiting) kids.push(h('div', { class: 'wait', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Waiting for Blender to finish installing… we look every few seconds.', h('button', { class: 'btn ghost sm', type: 'button', onclick: stopWaiting }, 'Stop looking')));
    if (b.state !== 'ready' && b.state !== 'unsaved') {
      // install guidance: Windows / macOS = the catalogue's methods (consented); Linux = the plan for this distro
      if (b.linux) {
        kids.push(h('p', { class: 'extra', style: 'margin:4px 0 10px;color:var(--fg)' }, b.linux.plan.intro));
        kids.push(h('div', { class: 'ways' }, ...b.linux.plan.ways.map((w) => h('div', { class: `way${w.recommended ? ' rec' : ''}` }, h('h3', {}, w.title, w.recommended ? h('span', { class: 'tag' }, 'Best here') : null),
          h('ol', { class: 'steps' }, ...w.steps.map((s) => h('li', {}, s.text, s.url ? h('div', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, `${new URL(s.url).hostname} ↗`)) : null, s.command ? cmdBox(s.command) : null)))))));
        kids.push(h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: startWaiting, disabled: !!waiting }, 'I’m installing it: watch for it')));
      } else {
        const ms = st!.blenderInstall.methods;
        kids.push(h('div', { class: 'row' }, ...ms.map((m, i) => m.runnable
          ? h('button', { class: `btn${i === 0 ? ' primary' : ''}`, type: 'button', onclick: () => installDialog(m) }, m.kind === 'open-url' ? 'Official download page' : m.id === 'winget' ? 'Install Blender (winget)' : m.id === 'brew' ? 'Install with Homebrew' : m.label)
          : null)));
        kids.push(h('p', { class: 'extra' }, 'Only from blender.org or the Blender Foundation’s own package. A window shows every step; nothing is installed silently.'));
      }
    }
    const others = b.installs.filter((x) => !b.chosen || x.path !== b.chosen.path);
    if (others.length) {
      kids.push(h('details', {}, h('summary', {}, `${others.length} other ${others.length === 1 ? 'copy' : 'copies'} found`), h('div', { class: 'copies' }, ...others.map((x) => h('div', { class: 'copy' },
        h('div', { class: 'where' }, x.path), h('span', {}, `${x.version ? `Blender ${x.version}` : 'unknown version'} · ${x.sourceLabel}`), x.note ? h('div', { class: 'note', style: 'flex-basis:100%' }, x.note) : null,
        x.runs && (x.compat === 'ok' || x.compat === 'newer') && x.source !== 'dmg' ? h('button', { class: 'btn sm', type: 'button', onclick: () => void useBlender(x.path) }, 'Use this one') : null)))));
    }
    const input = h('input', { type: 'text', placeholder: st!.os === 'win' ? 'C:\\…\\blender.exe' : st!.os === 'mac' ? '/Applications/Blender.app' : '/home/you/blender/blender', 'aria-label': 'Path to Blender', spellcheck: 'false' });
    kids.push(h('details', {}, h('summary', {}, 'Blender is somewhere else?'), h('div', { class: 'pathrow' }, input, h('button', { class: 'btn sm', type: 'button', onclick: () => { if (input.value.trim()) void useBlender(input.value.trim()); } }, 'Use this path'))));
    return h('section', { class: 'step', id: 'ais-blender' }, h('header', {}, h('span', { class: 'num' }, '1'), h('h2', {}, 'Blender'), h('span', { class: 'sp' }), pill), ...kids);
  }
  const blenderTest = () => run('btest', async () => {
    const r = await api<Check>('POST', '/api/ai-setup/blender/selftest');
    results.set('blender', r.status === 200 ? r.j : { ok: false, title: 'The Blender check could not run', fix: r.j.error });
    await load();
  });

  // ------------------------------------------------ AI apps
  function addDialog(a: AppRow) {
    const dlg = h('dialog', { class: 'ais', 'aria-labelledby': 'ais-add' });
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    const close = () => dlg.close();
    fill(dlg, h('p', {}, 'Reading its settings…'));
    dlg.showModal();
    void (async () => {
      const r = await api<Preview>('GET', `/api/ai-setup/mcp/${a.id}/preview`);
      if (r.status !== 200) { fill(dlg, h('h3', { id: 'ais-add' }, `Can’t add it to ${a.name}`), h('p', { class: 'err' }, r.j.error ?? 'Unknown problem.'), h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Close'))); return; }
      const p = r.j;
      if (p.refused) {
        const b = h('button', { class: 'btn primary', type: 'button' }, 'Copy the settings');
        b.onclick = () => void COPY(p.manual, b);
        fill(dlg, h('div', { class: 'eyebrow' }, a.name), h('h3', { id: 'ais-add' }, 'We left this file alone'), h('p', {}, p.refused), h('pre', { class: 'entry' }, p.manual),
          h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Close'), b));
        return;
      }
      const agree = h('input', { type: 'checkbox', id: 'ais-yes' });
      const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, p.action === 'same' ? 'Check it' : 'Add VTube Pro');
      agree.onchange = () => { go.disabled = !agree.checked; };
      go.onclick = async () => {
        go.disabled = true; go.textContent = 'Adding and checking…';
        const w = await api<{ ok: boolean; backup: string | null; verify: Check; next: string; manual?: string }>('POST', `/api/ai-setup/mcp/${a.id}/register`, { consent: true });
        if (w.status !== 200) {
          fill(dlg, h('h3', { id: 'ais-add' }, 'That didn’t work'), h('p', { class: 'err' }, w.j.error ?? 'Something went wrong.'), w.j.manual ? h('pre', { class: 'entry' }, w.j.manual) : null,
            h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Close')));
          return;
        }
        results.set(`app:${a.id}`, w.j.verify);
        fill(dlg, h('div', { class: 'eyebrow' }, a.name), h('div', { class: 'done', 'aria-hidden': 'true' }, w.j.ok ? '✅' : '⚠️'), h('h3', { id: 'ais-add' }, w.j.ok ? `VTube Pro is in ${a.name}` : 'Added, but the check failed'),
          resBox(w.j.verify), h('p', { style: 'margin-top:12px' }, w.j.next), w.j.backup ? h('p', { class: 'extra' }, `Your old settings were saved as ${w.j.backup.split(/[\\/]/).pop()} (Backups → Restore puts them back).`) : null,
          h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => { close(); void load(); } }, 'Done')));
      };
      fill(dlg, h('div', { class: 'eyebrow' }, 'Add VTube Pro'), h('h3', { id: 'ais-add' }, `Add VTube Pro to ${a.name}?`),
        h('p', {}, `This ${ACTION[p.action]}:`), h('div', { class: 'where', style: 'margin:-6px 0 10px' }, p.configPath),
        p.cli ? h('p', {}, 'We use Claude Code’s own command for it:') : null, p.cli ? h('pre', { class: 'entry' }, p.cli) : null,
        h('p', { style: 'margin-bottom:6px;color:var(--fg);font-weight:600' }, 'What we write'), h('pre', { class: 'entry' }, p.entryText),
        h('ul', {},
          p.others.length ? h('li', {}, p.others.length === 1 ? `Your other server (${p.others[0]}) stays exactly as it is.` : `Your ${p.others.length} other servers stay exactly as they are: ${p.others.join(', ')}.`) : h('li', {}, 'Nothing else in the file changes.'),
          p.backupPattern ? h('li', {}, 'A backup of the file is saved next to it first.') : h('li', {}, 'There is no file yet, so there is nothing to back up.'),
          h('li', {}, 'Then we start VTube Pro’s connection exactly as the app will, to check it works.')),
        h('label', { class: 'agree', for: 'ais-yes' }, agree, h('span', {}, `Yes, add VTube Pro to ${a.name}.`)),
        h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancel'), go));
    })();
  }
  function copyDialog(a: AppRow) {
    const dlg = h('dialog', { class: 'ais', 'aria-labelledby': 'ais-cp' });
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    fill(dlg, h('p', {}, 'Loading…'));
    dlg.showModal();
    void (async () => {
      const r = await api<Preview>('GET', `/api/ai-setup/mcp/${a.id}/preview`);
      const text = r.j.manual ?? '';
      const b = h('button', { class: 'btn primary', type: 'button' }, 'Copy');
      b.onclick = () => void COPY(text, b);
      fill(dlg, h('div', { class: 'eyebrow' }, a.name), h('h3', { id: 'ais-cp' }, 'Do it yourself'), h('p', {}, r.j.configPath ? `Paste this into ${r.j.configPath} (or run the command).` : 'Paste this into the app’s MCP settings.'),
        h('pre', { class: 'entry' }, text || (r.j.error ?? '')), h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Close'), b));
    })();
  }
  function backupsDialog(a: AppRow) {
    const dlg = h('dialog', { class: 'ais', 'aria-labelledby': 'ais-bk' });
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    const close = () => dlg.close();
    const show = async (msg?: Check) => {
      const r = await api<{ configPath: string; backups: { name: string; at: string; bytes: number }[] }>('GET', `/api/ai-setup/mcp/${a.id}/backups`);
      const list = r.j.backups ?? [];
      fill(dlg, h('div', { class: 'eyebrow' }, a.name), h('h3', { id: 'ais-bk' }, 'Backups of its settings'), msg ? resBox(msg) : null,
        list.length ? h('div', { class: 'copies' }, ...list.slice(0, 12).map((b) => h('div', { class: 'copy' }, h('div', { class: 'where' }, `${new Date(b.at).toLocaleString()} · ${b.bytes} bytes`),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => {
            if (!confirm(`Put the settings from ${new Date(b.at).toLocaleString()} back? The current file is backed up first.`)) return;
            const x = await api<{ restored: string }>('POST', `/api/ai-setup/mcp/${a.id}/restore`, { name: b.name, consent: true });
            await show(x.status === 200 ? { ok: true, title: 'Restored', detail: `Restart ${a.name} to load it.` } : { ok: false, title: 'Couldn’t restore it', fix: x.j.error });
            void load();
          } }, 'Restore')))) : h('p', {}, 'No backups yet: VTube Pro makes one each time it changes this file.'),
        h('div', { class: 'actions', style: 'margin-top:14px' }, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Close')));
    };
    fill(dlg, h('p', {}, 'Loading…'));
    dlg.showModal();
    void show();
  }
  const verifyApp = (a: AppRow) => run(`v:${a.id}`, async () => {
    const r = await api<Check>('POST', `/api/ai-setup/mcp/${a.id}/verify`);
    results.set(`app:${a.id}`, r.status === 200 ? r.j : { ok: false, title: 'The check could not run', fix: r.j.error });
  });

  function appsStep(): HTMLElement {
    const m = st!.mcp;
    const rows = [...m.apps].sort((x, y) => Number(y.supported) - Number(x.supported) || Number(y.installed === true) - Number(x.installed === true) || Number(y.registered) - Number(x.registered));
    const added = m.apps.filter((a) => a.registered && a.current).length;
    const kids: Kids = [h('p', { class: 'sum' }, added ? `VTube Pro is in ${added} of your AI apps. Add it to any other app you use.` : 'Pick the AI app you use and press “Add VTube Pro”. It then sees VTube Pro’s tools (rooms, avatars, Blender) and asks you before big changes.')];
    if (!m.launch.ok) kids.push(h('div', { class: 'banner err' }, m.launch.problem ?? 'The VTube Pro connection is not complete.'));
    if (m.launch.warning) kids.push(h('div', { class: 'banner' }, m.launch.warning));
    kids.push(h('div', { class: 'apps' }, ...rows.map((a) => {
      const res = results.get(`app:${a.id}`);
      const state = !a.supported ? h('span', { class: 'pill unsupported' }, 'Not for this computer') : a.registered && a.current ? h('span', { class: 'pill installed' }, 'Added ✔') : a.registered ? h('span', { class: 'pill outdated' }, 'Old path: re-add') : h('span', { class: 'pill' }, 'Not added');
      const btns: Kids = [];
      const links: Kids = [];
      if (a.supported) {
        btns.push(h('button', { class: `btn sm${!a.registered || !a.current ? ' primary' : ''}`, type: 'button', onclick: () => addDialog(a) }, a.registered && a.current ? 'Show / re-add' : 'Add VTube Pro'));
        if (a.registered) btns.push(h('button', { class: 'btn sm', type: 'button', disabled: busy.has(`v:${a.id}`), onclick: () => void verifyApp(a) }, busy.has(`v:${a.id}`) ? 'Checking…' : 'Check'));
        links.push(h('button', { class: 'lnk', type: 'button', onclick: () => copyDialog(a) }, 'Copy the settings'));
        links.push(h('button', { class: 'lnk', type: 'button', onclick: () => backupsDialog(a) }, 'Backups'));
      }
      return h('div', { class: `app${a.installed === true || a.registered ? '' : ' dim'}` },
        h('div', { class: 'nm' }, a.name, state),
        h('small', {}, !a.supported ? a.why ?? '' : a.installed === true ? 'Found on this computer.' : a.installed === false ? 'Not on this computer.' : 'We can’t tell if it’s installed.', ' ', a.installed !== true && a.supported ? h('a', { href: a.getUrl, target: '_blank', rel: 'noopener noreferrer' }, `${a.getLabel} ↗`) : null),
        res ? resBox(res) : null,
        btns.length ? h('div', { class: 'row', style: 'padding-top:0' }, ...btns) : null,
        links.length ? h('div', { class: 'links' }, ...links) : null);
    })));
    return h('section', { class: 'step', id: 'ais-apps' }, h('header', {}, h('span', { class: 'num' }, '2'), h('h2', {}, 'Your AI apps'), h('span', { class: 'sp' }),
      h('span', { class: `pill ${added ? 'installed' : ''}` }, added ? `${added} added ✔` : 'None yet')), ...kids);
  }

  // ------------------------------------------------ checks
  const checkAll = () => run('all', async () => {
    const r = await api<Check>('POST', '/api/ai-setup/mcp/selftest');
    results.set('mcp', r.status === 200 ? r.j : { ok: false, title: 'The connection check could not run', fix: r.j.error });
    draw();
    if (st?.blender.chosen) {
      const b = await api<Check>('POST', '/api/ai-setup/blender/selftest');
      results.set('blender', b.status === 200 ? b.j : { ok: false, title: 'The Blender check could not run', fix: b.j.error });
      draw();
    }
    for (const a of st?.mcp.apps.filter((x) => x.registered) ?? []) {
      const v = await api<Check>('POST', `/api/ai-setup/mcp/${a.id}/verify`);
      results.set(`app:${a.id}`, v.status === 200 ? v.j : { ok: false, title: 'The check could not run', fix: v.j.error });
      draw();
    }
    await load();
  });
  function checksStep(): HTMLElement {
    const mcp = results.get('mcp');
    return h('section', { class: 'step', id: 'ais-checks' }, h('header', {}, h('span', { class: 'num' }, '3'), h('h2', {}, 'Check that it all works')),
      h('p', { class: 'sum' }, 'Runs a tiny Blender job in the background (low priority, a few seconds), starts VTube Pro’s connection and lists its tools, then checks every app you added. Nothing changes on your stream.'),
      h('div', { class: 'row', style: 'padding-top:0;margin-bottom:10px' }, h('button', { class: 'btn primary', type: 'button', disabled: busy.has('all'), onclick: () => void checkAll() }, busy.has('all') ? 'Checking…' : 'Run all checks')),
      mcp ? resBox(mcp) : null);
  }

  // ------------------------------------------------ checklist + page
  function checklist(): HTMLElement {
    const s = st!;
    const b = s.blender;
    const added = s.mcp.apps.filter((a) => a.registered && a.current);
    const stale = s.mcp.apps.filter((a) => a.registered && !a.current);
    const go = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const row = (mk: 'yes' | 'no' | 'warn' | 'opt', title: string, text: string, fix?: [string, () => void]) => h('div', { class: 'ck' },
      h('span', { class: `mk ${mk}`, 'aria-hidden': 'true' }, mk === 'yes' ? '✓' : mk === 'no' ? '✗' : mk === 'warn' ? '!' : '–'),
      h('div', { class: 'tx' }, h('b', {}, `${title}${mk === 'yes' ? '' : mk === 'opt' ? ' (optional)' : ''}`), h('span', {}, text)),
      fix ? h('button', { class: `btn sm${mk === 'no' ? ' primary' : ''}`, type: 'button', onclick: fix[1] }, fix[0]) : null);
    const bt = results.get('blender');
    const mc = results.get('mcp');
    return h('div', { class: 'check', role: 'status', 'aria-live': 'polite' },
      row(b.state === 'ready' ? (bt && !bt.ok ? 'warn' : 'yes') : b.state === 'unsaved' ? 'warn' : 'no', 'Blender', bt && !bt.ok ? bt.title : b.summary,
        b.state === 'ready' ? undefined : b.state === 'unsaved' && b.chosen ? ['Use it', () => void useBlender(b.chosen!.path)] : ['Fix', go('ais-blender')]),
      row(!s.mcp.launch.ok ? 'no' : mc ? (mc.ok ? 'yes' : 'no') : 'yes', 'VTube Pro connection (MCP server)', !s.mcp.launch.ok ? s.mcp.launch.problem ?? '' : mc ? `${mc.title}${mc.detail ? `. ${mc.detail}` : ''}` : `Ready to start (${s.mcp.launch.kind === 'bundled' ? 'the installed helper' : 'this VTube Pro folder'}). “Run all checks” starts it once to be sure.`,
        !s.mcp.launch.ok || (mc && !mc.ok) ? ['Fix', go('ais-checks')] : undefined),
      row(added.length ? (stale.length ? 'warn' : 'yes') : 'no', 'Added to your AI apps', added.length ? `${added.map((a) => a.name).join(', ')}${stale.length ? `. Needs re-adding: ${stale.map((a) => a.name).join(', ')}` : ''}` : stale.length ? `Needs re-adding: ${stale.map((a) => a.name).join(', ')}` : 'Not added to any app yet.',
        !added.length || stale.length ? ['Fix', go('ais-apps')] : undefined),
      row(s.comfy.running ? 'yes' : 'opt', 'ComfyUI', s.comfy.running ? `Running${s.comfy.version ? ` (${s.comfy.version})` : ''}: AI textures and images work on this computer.` : s.comfy.found ? 'Installed, not running.' : 'Only for making AI textures on your own computer. Not needed to start.',
        s.comfy.running ? undefined : ['About ComfyUI', () => { location.href = `${o.tools}${o.tools.includes('?') ? '&' : '?'}tool=comfyui`; }]));
  }

  function draw() {
    const back = h('a', { class: 'btn ghost back', href: o.tools }, '← All tools');
    const head = h('div', { class: 'top' }, h('div', { class: 'brand' }, o.markEl(), 'VTube Pro', h('span', { class: 'beta' }, 'Beta')), h('span', { class: 'sp' }), back,
      h('button', { class: 'btn', type: 'button', disabled: loading, onclick: () => void load() }, loading ? 'Checking…' : '↻ Check again'));
    const body: Kids = [];
    if (problem) body.push(h('div', { class: 'banner err' }, problem));
    else if (!st) body.push(h('div', { class: 'summary' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Looking at what’s on this computer…'));
    else body.push(checklist(), blenderStep(), appsStep(), checksStep());
    fill(root, h('div', { class: 'wrap ais' }, head, h('div', { class: 'eyebrow' }, 'Set up AI creation'),
      h('h1', {}, 'Let your AI ', h('span', { class: 'g' }, 'build'), ' in VTube Pro'),
      h('p', { class: 'lead' }, 'Three steps: Blender, your AI app, a quick check. Nothing is installed or changed unless you say so.'), ...body));
  }

  draw();
  void load();
}
