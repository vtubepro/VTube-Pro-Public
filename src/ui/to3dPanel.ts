// "Make a 3D version with my AI" (lane to3d, docs/PRO2D_TO_3D.md): a side drawer for a Pro2D avatar. Zero effort:
//   1. the checklist (the AI app, Blender, the Blender MCP, the 3D toolkit, a base body; live = a calm warning), each
//      row one sentence + ONE button (a one-click install after one consent sheet, or a link to get it yourself), and
//      "Set it all up for me";
//   2. the ownership tick + the privacy line + what to expect (Claude's Continue pauses, plan use);
//   3. Start in Claude (claude:// link, prefilled: press Enter) / Start in ChatGPT (copied: Codex mode);
//   4. "Your AI is working…": steps, round, the latest compare picture, stall hints, Waiting for your OK, Done.
// Standalone (one export, no App import): src/ui/rig2dPanel.ts opens it with one line; tools/to3d_drawer.html mounts it
// for screenshots. Talks only to this PC's VTube Pro server (/api/to3d/*).
import { h, toast } from './dom.ts';

type AppId = 'claude' | 'chatgpt';
interface Row { id: string; title: string; state: 'ok' | 'fix' | 'busy' | 'warn'; say: string; action?: { id: string; label: string }; link?: { label: string; url: string }; more?: string }
interface Looked { what: string; where: string; found: boolean }
/** looked / checkedAt: helpers from beta.12.3 on (they find a uv you installed yourself); missing = an older version */
interface Ready { enabled: boolean; app: AppId; rows: Row[]; canStart: boolean; live: { live: boolean; why: string | null }; pause: Record<AppId, string>; privacy: string; looked?: Looked[]; checkedAt?: number }
interface PubJob { id: string; avatarName: string; phase: string; step: { name: string; text: string; progress: number } | null; error: string | null; rounds: { n: number; lever: string; status: string; review: string | null; total: number | null; worst: string | null }[];
  best: number | null; roundsUsed: number; maxRounds: number; lastToolCallAt: number | null; approval: { state: string } | null; submitted: { avatarId: string } | null; knownGaps: string[]; working: string | null; createdAt: number }

export interface To3dOpts { avatarId: string; onWear?: (avatarId: string) => void; /** open this job's view (e.g. from a notice) */ jobId?: string;
  /** just the set-up checklist (the helper's tools.html?view=to3d page: installs only work on a page on this computer) */ setupOnly?: boolean;
  /** render inside this element instead of as a drawer */ inline?: HTMLElement }
/** How often the open checklist checks again (cheap: files, PATH, one port probe). */
export const READY_POLL_MS = 4000;

const CSS = `
.t3d-back{position:fixed;inset:0;background:#0006;z-index:8000}
.t3d{position:fixed;top:0;right:0;bottom:0;width:min(440px,100vw);z-index:8001;background:var(--panel,#161920);color:var(--text,#eef1f6);
  border-left:1px solid var(--line,#262b37);box-shadow:var(--shadow,0 10px 30px #0008);display:flex;flex-direction:column;font:13.5px/1.45 Inter,system-ui,-apple-system,'Segoe UI',sans-serif}
.t3d header{display:flex;align-items:flex-start;gap:10px;padding:16px 16px 10px;border-bottom:1px solid var(--line,#262b37)}
.t3d header h2{margin:0;font-size:17px;font-weight:650;flex:1}
.t3d header p{margin:4px 0 0;color:var(--dim,#a3abba);font-size:12.5px}
.t3d .x{background:none;border:0;color:var(--dim,#a3abba);font-size:22px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px}
.t3d .body{overflow:auto;padding:12px 16px 20px;display:flex;flex-direction:column;gap:12px}
.t3d .seg{display:flex;gap:6px}
.t3d button{font-family:inherit}.t3d .seg button{flex:1;padding:8px;border-radius:10px;border:1px solid var(--line2,#333a4a);background:var(--card,#1b1f28);color:var(--text,#eef1f6);font:inherit;cursor:pointer}
.t3d .seg button.on{border-color:var(--accent,#7bd88f);background:var(--accent-soft,#7bd88f22);font-weight:600}
.t3d .rows{display:flex;flex-direction:column;gap:8px}
.t3d .row3{display:grid;grid-template-columns:22px 1fr;gap:4px 10px;padding:10px 12px;border-radius:12px;background:var(--card,#1b1f28);border:1px solid var(--line,#262b37)}
.t3d .row3 .ic{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:13px;font-weight:700}
.t3d .row3.ok .ic{background:var(--accent-soft,#7bd88f22);color:var(--ok,#7bd88f)}
.t3d .row3.fix .ic{background:var(--warn-soft,#ffb45422);color:var(--warn,#ffb454)}
.t3d .row3.warn .ic{background:var(--warn-soft,#ffb45422);color:var(--warn,#ffb454)}
.t3d .row3.busy .ic{background:var(--accent2-soft,#6cc7f522);color:var(--accent2,#6cc7f5)}
.t3d .row3 b{font-weight:600}
.t3d .row3 .say{grid-column:2;color:var(--dim,#a3abba)}
.t3d .row3 .more{grid-column:2;color:var(--faint,#717a8b);font-size:12px}
.t3d .row3 .acts{grid-column:2;display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:4px}
.t3d button.b{padding:7px 12px;border-radius:9px;border:1px solid var(--line2,#333a4a);background:var(--card2,#222733);color:var(--text,#eef1f6);font:inherit;font-weight:550;cursor:pointer}
.t3d button.b.primary{background:var(--accent,#7bd88f);color:var(--accent-ink,#08130b);border-color:transparent}
.t3d button.b.big{width:100%;padding:12px;font-size:15px;border-radius:12px}
.t3d button.b:disabled{opacity:.45;cursor:not-allowed}
.t3d a.l{color:var(--accent2,#6cc7f5);font-size:12.5px;cursor:pointer;text-decoration:underline}
.t3d .card{padding:12px;border-radius:12px;background:var(--card,#1b1f28);border:1px solid var(--line,#262b37)}
.t3d .tick{display:flex;gap:10px;align-items:flex-start;cursor:pointer}
.t3d .tick input{width:18px;height:18px;margin-top:2px;accent-color:var(--accent,#7bd88f)}
.t3d .note{color:var(--dim,#a3abba);font-size:12.5px;margin:0}
.t3d .warnline{color:var(--warn,#ffb454);font-size:12.5px;margin:0}
.t3d .errline{color:var(--err,#ff6b6b);font-size:12.5px;margin:0}
.t3d ol.steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.t3d ol.steps li{display:flex;gap:8px;align-items:center;color:var(--dim,#a3abba)}
.t3d ol.steps li.done{color:var(--text,#eef1f6)} .t3d ol.steps li.now{color:var(--text,#eef1f6);font-weight:600}
.t3d ol.steps li i{width:18px;text-align:center;font-style:normal}
.t3d .bar{height:6px;border-radius:4px;background:var(--card3,#2a3040);overflow:hidden}.t3d .bar>i{display:block;height:100%;background:var(--accent,#7bd88f)}
.t3d img.sheet{width:100%;border-radius:10px;border:1px solid var(--line,#262b37);background:#0002}
.t3d .sheet-cons{position:fixed;inset:0;z-index:8002;display:grid;place-items:center;background:#0008}
.t3d .sheet-cons .card{width:min(420px,calc(100vw - 32px));max-height:80vh;overflow:auto;background:var(--panel,#161920)}
.t3d .sheet-cons ul{margin:8px 0;padding-left:18px}.t3d .sheet-cons li{margin:4px 0}
.t3d.inline{position:relative;inset:auto;width:auto;max-width:560px;margin:24px auto;border:1px solid var(--line,#262b37);border-radius:16px;z-index:auto}
.t3d .checkline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.t3d .checkline .note{flex:1}
.t3d details.looked summary{cursor:pointer}
.t3d details.looked ul{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:12px}
.t3d details.looked li{display:grid;grid-template-columns:16px 1fr;gap:2px 6px;color:var(--dim,#a3abba)}
.t3d details.looked li code{grid-column:2;font:11.5px/1.35 ui-monospace,Consolas,monospace;color:var(--faint,#717a8b);word-break:break-all}
.t3d .infoline{color:var(--accent2,#6cc7f5);font-size:12.5px;margin:0}
.t3d-page #toasts{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;z-index:9000;width:min(520px,calc(100vw - 32px))}
.t3d-page #toasts .toast{padding:10px 14px;border-radius:10px;background:#1b1f28;color:#eef1f6;border:1px solid #333a4a;font:13px/1.4 Inter,system-ui,'Segoe UI',sans-serif;box-shadow:0 8px 24px #0008}
.t3d-page #toasts .toast.warn,.t3d-page #toasts .toast.err{border-color:#ffb454}.t3d-page #toasts .toast.ok{border-color:#7bd88f}.t3d-page #toasts .toast.out{opacity:0;transition:opacity .3s}
`;
let cssDone = false;
/** The open drawer's close (one at a time: opening again stops the old one's 4 s poll too). */
let closeOpen: (() => void) | null = null;

/** Every write is a real click: x-vtp-user-action (the helper refuses writes without it, like the add-ons page). */
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-vtp-user-action': '1' } : {}) };
  const r = await fetch(url, { method, cache: 'no-store', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j: any = null;
  try { j = t ? JSON.parse(t) : null; } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(j?.error ?? `VTube Pro answered ${r.status}`), { status: r.status, code: j?.code });
  return j as T;
}

function openUrl(u: string) {
  if (u.startsWith('action:')) return;
  const w = window.open(u, '_blank');
  if (w) { try { w.opener = null; } catch { /* cross-origin */ } }
  else toast('Your browser blocked the new tab. Allow pop-ups for this page.', 'warn', 5000);
}

const STEPS = ['Getting your model ready', 'Making a first 3D version (2–8 min)', 'Your AI compares it with your 2D model and improves it', 'Final checks', 'Waiting for your OK to add it to your library', 'Done'];
function stepIndex(j: PubJob): number {
  if (j.phase === 'done') return STEPS.length;   // every step ticked
  if (j.phase === 'waiting_for_ok' || j.phase === 'importing') return 4;
  if (j.phase === 'created' || j.phase === 'bundling' || j.phase === 'bundled') return j.phase === 'bundled' ? 1 : 0;
  const r = j.rounds;
  if (!r.length || (r.length === 1 && r[0].status === 'running')) return 1;
  return j.roundsUsed >= j.maxRounds - 1 ? 3 : 2;
}

/** Open the drawer for an avatar (one at a time). */
export function openTo3d(o: To3dOpts) {
  if (!cssDone) { cssDone = true; document.head.append(h('style', { id: 'vtp-to3d' }, CSS)); }
  closeOpen?.();
  document.querySelector('.t3d')?.remove(); document.querySelector('.t3d-back')?.remove();
  const back = h('div', { class: 't3d-back' });
  const body = h('div', { class: 'body' });
  const panel = h('aside', { class: `t3d${o.inline ? ' inline' : ''}`, role: o.inline ? 'region' : 'dialog', 'aria-label': o.setupOnly ? 'Set up 3D versions' : 'Make a 3D version with my AI' },
    h('header', null, h('div', { style: 'flex:1' }, h('h2', null, o.setupOnly ? 'Set up 3D versions' : 'Make a 3D version with my AI'),
      h('p', null, o.setupOnly ? 'What VTube Pro needs on this computer to turn a 2D avatar into 3D with your AI app. Press the green buttons; this list checks again by itself.' : 'Your Claude or ChatGPT app builds a 3D model of this avatar in Blender, on this computer. It takes about 30–90 minutes. Your 2D avatar isn’t changed.')),
    o.inline ? null : h('button', { class: 'x', 'aria-label': 'Close', onClick: () => close() }, '×')),
    body);
  if (o.inline) { o.inline.append(panel); document.body.classList.add('t3d-page'); } else document.body.append(back, panel);   // t3d-page: toasts on a page without the studio's styles
  let alive = true, app: AppId | null = null, ticked = false, jobId: string | null = o.jobId ?? null, timer = 0, busy = false;
  /** the last thing that went wrong (stays on screen until something works: a toast is too easy to miss) */
  let lastErr: string | null = null, lookOpen = false, fresh = false;
  const close = () => { alive = false; clearTimeout(timer); panel.remove(); back.remove(); removeEventListener('keydown', esc); if (closeOpen === close) closeOpen = null; };
  closeOpen = close;
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', esc);
  back.addEventListener('click', close);

  let avatar: { ok: boolean; why: string | null; sampleNote: boolean; name: string; jobs: PubJob[] } | null = o.setupOnly ? { ok: true, why: null, sampleNote: false, name: '', jobs: [] } : null;
  const loop = async () => {
    if (!alive) return;
    clearTimeout(timer);
    try {
      if (!avatar) avatar = await call('GET', `/api/to3d/avatar/${encodeURIComponent(o.avatarId)}`);
      const open = avatar!.jobs.find((j) => !['done', 'stopped', 'failed'].includes(j.phase));
      if (!jobId && open) jobId = open.id;
      if (jobId) await renderJob(jobId); else if (!busy) await renderReady();
    } catch (e) {
      body.replaceChildren(h('p', { class: 'errline' }, (e as { status?: number }).status === 403
        ? 'This needs VTube Pro on your computer. Open the studio from VTube Pro (or link it), then try again.'
        : `VTube Pro couldn’t check this: ${(e as Error).message}`));
    }
    if (alive) timer = window.setTimeout(loop, jobId ? 2500 : READY_POLL_MS);
  };
  const checkAgain = () => { fresh = true; void loop(); };

  // ---------------------------------------------------------------- the checklist
  async function renderReady() {
    const q = [app ? `app=${app}` : '', fresh ? 'fresh=1' : ''].filter(Boolean).join('&');
    fresh = false;
    const r = await call<Ready>('GET', `/api/to3d/readiness${q ? `?${q}` : ''}`);
    if (!alive || busy) return;
    app = app ?? r.app;
    const a = avatar!;
    const kids: Node[] = [];
    if (!r.enabled) { body.replaceChildren(h('p', { class: 'note' }, '3D versions are switched off on this computer.')); return; }
    if (!a.ok) { body.replaceChildren(h('p', { class: 'warnline' }, a.why ?? 'This avatar can’t be turned into 3D.')); return; }
    kids.push(h('div', { class: 'seg', role: 'group', 'aria-label': 'Your AI app' },
      ...(['claude', 'chatgpt'] as AppId[]).map((x) => h('button', { class: x === app ? 'on' : '', 'aria-pressed': String(x === app), onClick: () => { app = x; void renderReady(); } }, x === 'claude' ? 'Claude' : 'ChatGPT'))));
    const fixable = [...new Set(r.rows.filter((x) => x.state === 'fix' && x.action && /^(install:|register:|unregister:|connect:)/.test(x.action.id)).map((x) => x.action!.id))];
    kids.push(h('div', { class: 'rows' }, ...r.rows.map((row) => rowEl(row))));
    if (lastErr) kids.push(h('p', { class: 'errline', role: 'alert' }, lastErr));
    if (fixable.length > 1) kids.push(h('button', { class: 'b primary', onClick: () => consent(fixable) }, 'Set it all up for me'));
    kids.push(h('div', { class: 'checkline' },
      h('span', { class: 'note' }, `Checked at ${new Date(r.checkedAt ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}. It checks again every few seconds.`),
      h('button', { class: 'b', onClick: checkAgain }, 'Check again')));
    if (r.looked?.length) {
      const d = h('details', { class: 'looked', open: lookOpen }, h('summary', { class: 'note' }, 'Where we looked'),
        h('ul', null, ...r.looked.map((l) => h('li', null, h('span', { 'aria-label': l.found ? 'found' : 'not found' }, l.found ? '✓' : '·'), h('span', null, l.what), h('code', null, l.where)))));
      d.addEventListener('toggle', () => { lookOpen = (d as HTMLDetailsElement).open; });
      kids.push(d);
    }
    if (o.setupOnly) {
      const left = r.rows.filter((x) => x.state !== 'ok' && (x.id === 'app' || x.id === 'blender' || x.id === 'kit')).length;
      kids.push(h('p', { class: 'note' }, left ? 'When the rows have ticks, go back to the studio: the list there refreshes by itself.' : 'All set. Go back to the studio and press Start (it refreshes by itself).'));
      body.replaceChildren(...kids);
      return;
    }
    if (a.sampleNote) kids.push(h('p', { class: 'warnline' }, 'This looks like a free sample model from another 2D app. It may be converted for testing on this computer only. Don’t stream or share the result.'));
    const tick = h('input', { type: 'checkbox', checked: ticked, onChange: (e: Event) => { ticked = (e.target as HTMLInputElement).checked; start.disabled = !(ticked && r.canStart); } }) as HTMLInputElement;
    kids.push(h('div', { class: 'card' },
      h('label', { class: 'tick' }, tick, h('span', null, 'This is my model, or its artist allows me to make a 3D version of it.')),
      h('p', { class: 'note', style: 'margin-top:8px' }, r.privacy),
      h('p', { class: 'note', style: 'margin-top:6px' }, r.pause[app])));
    const start = h('button', { class: 'b primary big', disabled: !(ticked && r.canStart), onClick: () => startJob() }, `Start in ${app === 'claude' ? 'Claude' : 'ChatGPT'}`) as HTMLButtonElement;
    kids.push(start);
    if (!r.canStart) kids.push(h('p', { class: 'note' }, 'Start turns on when the rows above are ready.'));
    const old = a.jobs.filter((j) => ['done', 'stopped', 'failed'].includes(j.phase));
    if (old.length) kids.push(h('details', null, h('summary', { class: 'note' }, `Earlier 3D jobs (${old.length})`),
      ...old.map((j) => h('div', { class: 'acts', style: 'display:flex;gap:8px;align-items:center;margin:6px 0' }, h('span', { class: 'note', style: 'flex:1' }, `${new Date(j.createdAt).toLocaleDateString()} · ${j.phase}`),
        h('button', { class: 'b', onClick: () => { jobId = j.id; void loop(); } }, 'Open'),
        h('button', { class: 'b', onClick: async () => { await call('DELETE', `/api/to3d/jobs/${j.id}`); avatar = null; void loop(); } }, 'Delete its files')))));
    body.replaceChildren(...kids);
  }

  function rowEl(row: Row): HTMLElement {
    const icon = row.state === 'ok' ? '✓' : row.state === 'busy' ? '…' : '!';
    const acts: Node[] = [];
    if (row.action) acts.push(h('button', { class: `b${row.state === 'fix' ? ' primary' : ''}`, onClick: () => act(row.action!.id) }, row.action.label));
    if (row.link) acts.push(h('a', { class: 'l', onClick: () => (row.link!.url.startsWith('action:') ? act(row.link!.url.slice(7)) : openUrl(row.link!.url)) }, row.link.label));
    return h('div', { class: `row3 ${row.state}`, 'data-row': row.id },
      h('span', { class: 'ic', 'aria-hidden': 'true' }, icon), h('b', null, row.title), h('span', { class: 'say' }, row.say),
      ...(row.more ? [h('span', { class: 'more' }, row.more)] : []), ...(acts.length ? [h('div', { class: 'acts' }, ...acts)] : []));
  }

  async function act(id: string) {
    if (id === 'recheck') return checkAgain();
    if (id === 'bases:pick-user') return pickBase();
    if (/^(install:|register:|unregister:|connect:)/.test(id)) return consent([id]);
    await runFix(id, null);
  }
  const failed = (e: unknown) => {
    const m = (e as Error).message || 'That didn’t work.';
    lastErr = /^(VTube Pro answered|Failed to fetch|NetworkError|Load failed)/i.test(m) ? 'VTube Pro couldn’t reach VTube Pro. Make sure it’s running (its icon is in the tray), then press Check again.' : m;
    toast(lastErr, 'warn', 6000);
  };

  async function runFix(id: string, token: string | null) {
    try {
      const r = await call<{ say?: string; open?: string | string[] }>('POST', '/api/to3d/fix', { action: id, token, consent: token ? true : undefined });
      if (r.open) for (const u of Array.isArray(r.open) ? r.open : [r.open]) openUrl(u);
      if (r.say) toast(r.say, 'ok', 5000);
      lastErr = null;
    } catch (e) {
      failed(e);
    }
  }

  async function consent(actions: string[]) {
    // the sheet first (what, from where, how big); the one-time token only after "Yes" (it lasts 2 minutes)
    let plan: { items: { what: string; from: string; mb: number | null }[] };
    try { plan = await call('GET', `/api/to3d/fix/plan?actions=${encodeURIComponent(actions.join(','))}`); }
    catch (e) { failed(e); void renderReady(); return; }
    const mb = plan.items.reduce((s, i) => s + (i.mb ?? 0), 0);
    const sheet = h('div', { class: 'sheet-cons', role: 'dialog', 'aria-label': 'What gets installed' }, h('div', { class: 'card' },
      h('b', null, mb ? 'This downloads and sets up' : 'This changes'),
      h('ul', null, ...plan.items.map((i) => h('li', null, `${i.what}${i.mb ? ` (about ${i.mb} MB)` : ''}${i.from === 'this computer' ? '' : ` — from ${i.from}`}`))),
      mb ? h('p', { class: 'note' }, `About ${mb} MB in all. Nothing else is installed.`) : '',
      h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
        h('button', { class: 'b primary', onClick: async () => {
          sheet.remove(); busy = true;
          try {
            const g = await call<{ token: string }>('POST', '/api/to3d/fix/consent', { actions });
            for (const a of actions) await runFix(a, g.token);
          } catch (e) { failed(e); }
          busy = false; void loop();
        } }, 'Yes, set it up'),
        h('button', { class: 'b', onClick: () => sheet.remove() }, 'Cancel'))));
    panel.append(sheet);
  }

  function pickBase() {
    const inp = h('input', { type: 'file', accept: '.vrm', style: 'display:none' }) as HTMLInputElement;
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const r = await fetch(`/api/to3d/bases/user?name=${encodeURIComponent(f.name.replace(/\.vrm$/i, ''))}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-vtp-user-action': '1' }, body: f });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? 'This base can’t be used.');
        toast(j.builtin ? 'That’s one of VTube Pro’s own bases: nothing to change.' : `Using your own base "${j.name}".`, 'ok', 5000);
        void renderReady();
      } catch (e) { toast((e as Error).message, 'warn', 7000); }
    };
    panel.append(inp); inp.click();
  }

  async function startJob() {
    if (!app) return;
    busy = true;
    try {
      const r = await call<{ job: PubJob; prompt: string; deepLink: string | null; steps: string[]; pause: string }>('POST', '/api/to3d/jobs', { avatarId: o.avatarId, app, consent: { ownership: true } });
      jobId = r.job.id;
      try { await navigator.clipboard.writeText(r.prompt); } catch { /* not allowed: the link / the button below */ }
      if (r.deepLink) { location.href = r.deepLink; }
      startNote = r.steps;
      busy = false;
      void loop();
    } catch (e) { busy = false; toast((e as Error).message, 'warn', 7000); }
  }
  let startNote: string[] | null = null;

  // ---------------------------------------------------------------- the job
  async function renderJob(id: string) {
    const r = await call<{ job: PubJob; resumePrompt: string; resumeLink: string | null; stale: boolean }>('GET', `/api/to3d/jobs/${id}`);
    if (!alive) return;
    const j = r.job, now = stepIndex(j);
    const kids: Node[] = [];
    if (startNote && j.lastToolCallAt === null) kids.push(h('div', { class: 'card' }, h('b', null, 'Next, in your AI app'), h('ol', { style: 'margin:6px 0 0;padding-left:18px' }, ...startNote.map((s) => h('li', null, s)))));
    kids.push(h('ol', { class: 'steps' }, ...STEPS.map((s, i) => h('li', { class: i < now ? 'done' : i === now ? 'now' : '' }, h('i', null, i < now ? '✓' : i === now ? '›' : '·'),
      i === 2 && j.roundsUsed ? `${s}: round ${j.roundsUsed} of up to ${j.maxRounds}` : s))));
    if (j.step && j.phase !== 'done') kids.push(h('div', null, h('p', { class: 'note' }, j.step.text), h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(Math.max(0.03, j.step.progress) * 100)}%` }))));
    if (j.working && j.phase === 'iterating') kids.push(h('p', { class: 'note' }, j.working));
    const best = j.best ?? [...j.rounds].reverse().find((x) => x.review)?.n;
    if (best !== undefined && best !== null && j.rounds.some((x) => x.n === best && x.review)) kids.push(h('img', { class: 'sheet', alt: '2D (left) and the 3D version (middle) side by side', src: `/api/to3d/jobs/${id}/picture/compare_sheet?round=${best}&t=${j.rounds.length}` }));
    if (j.phase === 'waiting_for_ok') kids.push(h('div', { class: 'card' }, h('b', null, 'Your AI is waiting for your OK'), h('p', { class: 'note' }, 'Look at the pictures, then press Approve to add it to your library as a new avatar (it isn’t worn).'),
      h('button', { class: 'b primary', style: 'margin-top:6px', onClick: () => openUrl('/aiconnect#apprBox') }, 'Open the approval page')));
    if (r.stale) kids.push(h('p', { class: 'warnline' }, j.lastToolCallAt === null ? 'Did the message reach your AI? Copy it again and paste it.' : app === 'chatgpt' ? 'Your AI paused. In ChatGPT, type "continue".' : 'Your AI paused. In Claude, click Continue.'));
    if (j.error) kids.push(h('p', { class: 'errline' }, j.error));
    if (j.phase === 'done' && j.submitted) {
      kids.push(h('div', { class: 'card' }, h('b', null, `“${j.avatarName} (3D)” is in your library.`), h('p', { class: 'note' }, 'It isn’t worn.'),
        ...(j.knownGaps.length ? [h('p', { class: 'note' }, `What your AI couldn’t match: ${j.knownGaps.slice(0, 4).join('; ')}`)] : []),
        h('div', { style: 'display:flex;gap:8px;margin-top:8px' },
          ...(o.onWear ? [h('button', { class: 'b primary', onClick: () => { o.onWear!(j.submitted!.avatarId); close(); } }, 'Wear it')] : []),
          h('button', { class: 'b', onClick: () => copy(r.resumePrompt, r.resumeLink) }, 'Keep improving'))));
    }
    const acts: Node[] = [];
    if (!['done', 'stopped', 'failed'].includes(j.phase)) {
      acts.push(h('button', { class: 'b', onClick: () => copy(r.resumePrompt, r.resumeLink) }, 'Continue in a new chat'));
      acts.push(h('button', { class: 'b', onClick: async () => { await call('POST', `/api/to3d/jobs/${id}/stop`, {}); toast('Stopped. Your AI is told to stop.', 'ok'); } }, 'Stop'));
    } else acts.push(h('button', { class: 'b', onClick: () => { jobId = null; avatar = null; startNote = null; void loop(); } }, 'Back'));
    acts.push(h('button', { class: 'b', onClick: async () => { if (!confirm('Delete this job’s files? (Your library is not touched.)')) return; await call('DELETE', `/api/to3d/jobs/${id}`); jobId = null; avatar = null; void loop(); } }, 'Delete this job’s files'));
    kids.push(h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' }, ...acts));
    body.replaceChildren(...kids);
  }

  async function copy(text: string, link: string | null) {
    try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into your AI app.', 'ok'); } catch { /* blocked */ }
    if (link) location.href = link;
  }

  void loop();
  return close;
}
