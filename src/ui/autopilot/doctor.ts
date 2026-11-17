// "Something wrong? Fix it" (autopilot doctor, ZERO-EFFORT RULE). One button in the top bar, on every screen. It checks
// the camera, face tracking, the microphone, the avatar, the room, OBS, the graphics card and the AI
// creation tools (Blender + AI apps, through the helper's GET /api/autopilot/tools, which asks the toolsetup lane's
// /api/ai-setup/status), says what is wrong in one plain sentence per row, and fixes it: "Fix everything" does every fix
// that needs no choice (turn on the camera + mic, put on a starter avatar / room, add VTube Pro to OBS); the other rows
// have one button each (open the browser's camera setting, graphics acceleration, AI set-up).
// It replaces the older read-only "Help me" checker (src/ui/guide/helpCheck.ts setHelpCheckTakeover) when mounted.
// Rules + words: shared/autopilot/doctorRules.ts. Mounted once from src/main.ts (mountDoctor).
import type { App } from '../../app.ts';
import { h, toast } from '../dom.ts';
import { icon } from '../icons.ts';
import { api } from '../../api.ts';
import { autoFixes, doctorHeadline, doctorRows, isSoftwareRenderer, nextStep, problemCount, type DoctorAction, type DoctorFacts, type DoctorRow } from '../../../shared/autopilot/doctorRules.ts';
import { BROWSER_NAME } from '../../../shared/autopilot/media.ts';
import { BROWSER, clearMediaError, mediaError, openSettingsPage, permState, showFix } from './media.ts';
import { startCamera, startMic } from '../liveOps.ts';
import { starterRoom } from './firstRunRoom.ts';
import { HELP_CHAT_URL } from '../guide/links.ts';
import { setHelpCheckTakeover } from '../guide/helpCheck.ts';
import { registerFixIt } from '../assistHooks.ts';

let app: App;
let go: (area: 'live' | 'me' | 'room' | 'home') => void = () => {};
let avatarLoadedAt = 0, avatarFailedAt = 0, failedName = '';

async function devicesOf(kind: MediaDeviceKind) { try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind).length; } catch { return -1; } }
function gpuFacts(): DoctorFacts['gpu'] {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { software: true, webgl2: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { software: isSoftwareRenderer(r), webgl2: true };
  } catch { return { software: false, webgl2: true }; }
}
async function json<T>(url: string, ms = 8000): Promise<T | null> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { cache: 'no-store', signal: ac.signal }); return r.ok ? await r.json() as T : null; } catch { return null; } finally { clearTimeout(t); }
}
/** Is a face seen right now? (sampled for ~1.5 s: one missed frame is not "lost") */
async function faceSeen(): Promise<boolean> {
  for (let i = 0; i < 8; i++) { if (app.stats.tracked) return true; await new Promise((r) => setTimeout(r, 200)); }
  return false;
}

export async function gatherDoctorFacts(probeHelper = true): Promise<DoctorFacts> {
  const S = app.scene;
  const f: DoctorFacts = {
    camera: { perm: await permState('camera'), on: app.trackingOn, devices: await devicesOf('videoinput'), label: app.mainCam?.label ?? '', error: app.trackingOn ? null : mediaError('camera') },
    mic: { perm: await permState('mic'), on: app.audio.active, devices: await devicesOf('audioinput'), label: app.audio.deviceLabel, error: app.audio.active ? null : mediaError('mic') },
    face: !app.trackingOn ? 'off' : (await faceSeen()) ? 'seen' : 'lost',
    obs: 'unknown', gpu: gpuFacts(), tools: null,
    avatar: { loaded: !!app.profile, name: app.profile?.name ?? failedName, failed: avatarFailedAt > avatarLoadedAt },
    room: { id: S.effective.sceneId, name: S.scenes.find((x) => x.id === S.effective.sceneId)?.name ?? 'your room', missing: !!S.effective.sceneId && S.scenes.length > 0 && !S.scenes.some((x) => x.id === S.effective.sceneId) },
  };
  if (app.trackingOn) clearMediaError('camera');
  if (app.audio.active) clearMediaError('mic');
  const [o, v, t] = await Promise.all([json<{ count?: number; inObs?: number; noGl?: number }>('/api/obs/outputs'), json<{ enabled?: boolean; status?: { connected?: boolean; error?: string | null } }>('/api/obs'), toolsFacts(probeHelper)]);
  f.obs = !o ? 'unknown' : (o.noGl ?? 0) > 0 ? 'noGl' : (o.inObs ?? 0) > 0 ? 'inObs' : v?.enabled && v.status && !v.status.connected && v.status.error ? 'broken' : (o.count ?? 0) > 0 ? 'tab' : 'none';
  if (t) f.tools = t;
  return f;
}
type ToolsAnswer = { ok?: boolean; blender?: { state: NonNullable<DoctorFacts['tools']>['blender']; summary: string; saved?: boolean }; ai?: { installed: string[]; connected: string[]; old?: string[] } };
let toolsCache: { at: number; facts: DoctorFacts['tools'] } | null = null;
/** Blender + AI apps (the helper's /api/autopilot/tools asks /api/ai-setup/status: a disk scan). The quiet count reuses a
 *  recent answer (5 min); opening the doctor asks again. */
async function toolsFacts(fresh: boolean): Promise<DoctorFacts['tools']> {
  if (!fresh && toolsCache && Date.now() - toolsCache.at < 300_000) return toolsCache.facts;
  const t = await json<ToolsAnswer>('/api/autopilot/tools', 25_000);
  const facts = t?.ok && t.blender ? { blender: t.blender.state, blenderSays: t.blender.summary, blenderSaved: !!t.blender.saved, aiConnected: t.ai?.connected ?? [], aiInstalled: t.ai?.installed ?? [], aiOld: t.ai?.old ?? [] } : null;
  toolsCache = { at: Date.now(), facts };
  return facts;
}

// ---------------------------------------------------------------- fixes
async function starterAvatarId(): Promise<string | null> {
  try { const list = await api.avatars(); return (list.find((a) => a.id === 'mirelle') ?? list.find((a) => !/test|grey/i.test(a.id)) ?? list[0])?.id ?? null; } catch { return null; }
}
/** Run one fix. Returns the sentence for "what we did" (empty when it opened something for the user instead). */
async function runFix(a: DoctorAction): Promise<string> {
  const S = app.scene;
  switch (a) {
    case 'camera': return (await startCamera(app)) ? 'turned your camera on' : '';
    case 'mic': return (await startMic(app)) ? 'turned your microphone on' : '';
    case 'cameraFix': close(); void showFix('camera', null); return '';
    case 'micFix': close(); void showFix('mic', null); return '';
    case 'light': close(); go('live'); toast('Face the camera with a lamp or window in front of you (not behind you). The Tracking page shows what the camera sees.', 'info', 9000); return '';
    case 'avatar': { const id = await starterAvatarId(); if (!id) return ''; await app.loadAvatar(id); return app.profile ? `put on ${app.profile.name}` : ''; }
    case 'room': { const id = starterRoom(S.scenes); if (!id || !S.canEdit) return ''; S.setScene(id); return `put you in ${S.scenes.find((x) => x.id === id)?.name ?? 'the starter room'}`; }
    case 'obs': {
      const m = await import('./obsOneClick.ts');
      const r = await m.addToObs();
      if (r.open) { close(); if (r.why) toast(r.why, 'info', 8000); void import('../obsWizard.ts').then((w) => w.openObsWizard({ step: r.step, full: true })); return ''; }
      // OBS loads its new source in a moment: wait for its page, so the next check is right
      for (let i = 0; i < 12; i++) { const o = await json<{ inObs?: number }>('/api/obs/outputs'); if ((o?.inObs ?? 0) > 0) break; await new Promise((res) => setTimeout(res, 700)); }
      return 'added VTube Pro to OBS';
    }
    case 'obsGl': close(); void import('../../../shared/obsGlHelp.ts').then((m) => toast(m.obsGlSteps(navigator.userAgent).join(' '), 'info', 20000)); return '';
    case 'gpu': {
      const r = await openSettingsPage('gpu', 'camera');
      if (r.ok) { toast(`${BROWSER_NAME[BROWSER]}’s settings opened: turn on “Use graphics acceleration when available”, then press Relaunch.`, 'info', 12000); return ''; }
      toast(BROWSER === 'firefox' ? 'Firefox: Settings → General → Performance → untick “Use recommended performance settings” → tick “Use hardware acceleration”, then restart Firefox.'
        : `${BROWSER_NAME[BROWSER]}: Settings → System → turn on “Use graphics acceleration when available”, then press Relaunch.`, 'info', 14000);
      return '';
    }
    case 'tools': window.open('/tools.html?view=ai-setup', '_blank', 'noopener'); return '';
    case 'reload': location.reload(); return '';
    default: return '';
  }
}

// ---------------------------------------------------------------- the dialog
const CSS = `
.dr-btn{display:inline-flex;align-items:center;gap:6px;font:600 13px/1 inherit;border-radius:99px;padding:7px 12px;border:1px solid rgb(255 207 106 / .45);background:rgb(255 207 106 / .08);color:var(--text);cursor:pointer;white-space:nowrap;position:relative}
.dr-btn:hover{border-color:#ffcf6a}.dr-btn.clean{border-color:var(--line);background:transparent;color:var(--dim)}
.dr-btn .n{min-width:17px;height:17px;border-radius:99px;background:#ff7a6b;color:#160606;font:800 11px/17px system-ui;text-align:center;padding:0 4px}
.dr-btn.float{position:fixed;left:12px;bottom:12px;z-index:60}
@media (max-width:700px){.dr-btn .l{display:none}}
.dr-wrap{position:fixed;inset:0;z-index:9000;display:grid;place-items:center;background:#05070bb3}
.dr{width:min(620px,calc(100vw - 32px));max-height:calc(100dvh - 40px);overflow:auto;border-radius:16px;border:1px solid var(--line);background:var(--bg2,#0b0f12);color:var(--text);box-shadow:0 30px 80px -20px #000c;padding:22px 24px 20px;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;position:relative}
.dr h2{margin:0;font-size:21px}.dr p{margin:0;line-height:1.5;color:var(--dim)}
.dr-eyebrow{font-size:12px;letter-spacing:.4px;text-transform:uppercase;color:var(--accent);font-weight:700}
.dr-next{border-radius:12px;padding:12px 14px;border:1px solid rgb(255 207 106 / .4);background:rgb(255 207 106 / .07);font-size:15px;line-height:1.45}
.dr-next.done{border-color:rgb(123 216 143 / .45);background:rgb(123 216 143 / .08)}
.dr-next.calm{border-color:rgb(108 199 245 / .4);background:rgb(108 199 245 / .07)}
.dr-row .m.todo{border:1.5px solid #6cc7f5;color:#6cc7f5}
.dr-rows{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.dr-row{display:grid;grid-template-columns:22px 1fr auto;gap:3px 10px;align-items:start;padding:10px 12px;border-radius:10px;background:var(--panel)}
.dr-row .t{font-weight:600;font-size:14px}.dr-row .s{grid-column:2;font-size:13px;color:var(--dim);line-height:1.4}
.dr-row .m{grid-row:span 2;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font:700 12px/1 system-ui;color:#06080a;margin-top:1px}
.dr-row .m.ok{background:#7bd88f}.dr-row .m.warn{background:#ffcf6a}.dr-row .m.bad{background:#ff7a6b}.dr-row .m.skip{border:1.5px dashed var(--dim)}
.dr-row .b{grid-row:span 2;align-self:center}
.dr-b{font:600 13px/1 inherit;border-radius:99px;padding:8px 12px;border:1px solid var(--line);background:var(--bg2,#11171b);color:var(--text);cursor:pointer;white-space:nowrap}
.dr-b:hover{border-color:var(--accent)}.dr-b.primary{background:var(--accent);color:var(--accent-ink,#0b1410);border-color:transparent;font-size:15px;padding:12px 18px}
.dr-b:focus-visible,.dr-btn:focus-visible{outline:2px solid #7bd88f;outline-offset:3px}
.dr-foot{display:flex;gap:10px;flex-wrap:wrap}
.dr-x{position:absolute;right:12px;top:10px;background:none;border:0;color:var(--dim);font-size:22px;cursor:pointer}
.dr-spin{width:18px;height:18px;border-radius:50%;border:2px solid rgb(123 216 143 / .3);border-top-color:#7bd88f;animation:dr-sp .8s linear infinite;display:inline-block;vertical-align:-4px;margin-right:8px}
.dr-did{font-size:14px;color:var(--text)}
@keyframes dr-sp{to{transform:rotate(360deg)}}
@media (max-width:520px){.dr{padding:18px 14px}.dr-row{grid-template-columns:22px 1fr}.dr-row .b{grid-column:2;grid-row:auto;justify-self:start;margin-top:4px}}
`;
let root: HTMLElement | null = null;
let seq = 0;
function close() { root?.remove(); root = null; seq++; window.removeEventListener('keydown', onKey, true); }
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && root) { e.preventDefault(); e.stopPropagation(); close(); } };
const MARK: Record<DoctorRow['mark'], string> = { ok: '✓', warn: '!', bad: '✕', todo: '•', skip: '' };

function paint(card: HTMLElement, rows: DoctorRow[], did: string[]) {
  const head = doctorHeadline(rows);
  const auto = autoFixes(rows);
  const list = h('ul', { class: 'dr-rows' }, ...rows.map((r) => h('li', { class: 'dr-row', 'data-row': r.id, 'data-mark': r.mark },
    h('span', { class: `m ${r.mark}`, role: 'img', 'aria-label': r.mark === 'ok' ? 'Working' : r.mark === 'skip' ? 'Optional' : r.mark === 'todo' ? 'Not set up yet' : 'Needs a fix' }, MARK[r.mark]),
    h('span', { class: 't' }, r.title),
    r.fix && r.mark !== 'ok' ? h('button', { class: 'dr-b b', onClick: () => void fixOne(r) }, r.fix.label) : h('span'),
    h('span', { class: 's' }, r.says))));
  card.replaceChildren(
    h('button', { class: 'dr-x', 'aria-label': 'Close', onClick: close }, '×'),
    h('div', { class: 'dr-eyebrow' }, 'Fix it'),
    h('h2', null, head.tone === 'ok' ? 'Everything works' : head.tone === 'next' ? 'Nothing is broken' : 'Here’s what we found'),
    did.length ? h('p', { class: 'dr-did', role: 'status' }, `Done: we ${did.join(', ')}.`) : h('span', { hidden: true }),
    h('div', { class: `dr-next${head.tone === 'ok' ? ' done' : head.tone === 'next' ? ' calm' : ''}`, role: 'status', 'data-tone': head.tone }, head.says),
    auto.length ? h('button', { class: 'dr-b primary', 'data-ui': 'fix-everything', onClick: () => void fixAll() }, auto.length > 1 ? `Fix everything (${auto.length})` : 'Fix it') : h('span', { hidden: true }),
    list,
    h('div', { class: 'dr-foot' },
      h('button', { class: 'dr-b', onClick: () => void check() }, 'Check again'),
      h('button', { class: 'dr-b', onClick: () => window.open(HELP_CHAT_URL, '_blank', 'noopener') }, 'Ask a person')));
  (card.querySelector('.dr-b.primary, .dr-b') as HTMLElement | null)?.focus();
}
function busy(card: HTMLElement, line: string) {
  card.replaceChildren(h('div', { class: 'dr-eyebrow' }, 'Fix it'), h('h2', null, 'One moment…'), h('p', { role: 'status' }, h('span', { class: 'dr-spin', 'aria-hidden': 'true' }), line));
}
async function check(did: string[] = []) {
  const card = root?.querySelector('.dr') as HTMLElement | null;
  if (!card) return;
  const my = ++seq;
  busy(card, 'Checking your camera, microphone, OBS and graphics. Nothing changes yet.');
  const facts = await gatherDoctorFacts();
  if (my !== seq || !root) return;
  paint(card, doctorRows(facts), did);
}
async function fixOne(r: DoctorRow) {
  if (!r.fix) return;
  const card = root?.querySelector('.dr') as HTMLElement | null;
  if (card && r.fix.auto) busy(card, `${r.fix.label}…`);
  const said = await runFix(r.fix.action);
  if (root) await check(said ? [said] : []);
}
async function fixAll() {
  const card = root?.querySelector('.dr') as HTMLElement | null;
  if (!card) return;
  const order: DoctorAction[] = ['avatar', 'room', 'camera', 'mic', 'obs'];
  const rows = doctorRows(await gatherDoctorFacts(false));
  const todo = order.filter((a) => autoFixes(rows).includes(a));
  const did: string[] = [];
  for (const a of todo) {
    if (!root) return;
    busy(card, a === 'camera' ? 'Turning on your camera…' : a === 'mic' ? 'Turning on your microphone…' : a === 'obs' ? 'Adding VTube Pro to OBS…' : a === 'avatar' ? 'Putting on a starter avatar…' : 'Opening the starter room…');
    try { const s = await runFix(a); if (s) did.push(s); } catch { /* the next check shows what's still wrong */ }
  }
  if (root) await check(did);
}

/** Open the doctor and check straight away. */
export function openDoctor() {
  if (!document.getElementById('dr-style')) document.head.append(h('style', { id: 'dr-style' }, CSS));
  close();
  root = h('div', { class: 'dr-wrap', onClick: (e: MouseEvent) => { if (e.target === root) close(); } },
    h('div', { class: 'dr', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Fix it: check my setup' }));
  document.body.append(root);
  window.addEventListener('keydown', onKey, true);
  void check();
}

// ---------------------------------------------------------------- the button
let btn: HTMLButtonElement | null = null;
let count = 0, counting = false;
let next: { id: string; says: string; short: string } | null = null;
async function quickCount() {
  if ((!btn && !counting) || root) return;
  // cheap and silent: never probes for the helper (that may make the browser ask), never starts anything
  const f = await gatherDoctorFacts(false).catch(() => null);
  if (!f) return;
  // owner rule: only real problems count; "not set up yet" is the calm Next step (shared/autopilot/doctorRules.ts)
  const rows = doctorRows(f);
  const n = problemCount(rows);
  count = n; next = nextStep(rows);
  if (!btn) return;
  const badge = btn.querySelector('.n') as HTMLElement;
  badge.textContent = String(n); badge.hidden = n === 0;
  btn.classList.toggle('clean', n === 0);
  btn.title = n ? `${n} thing${n > 1 ? 's' : ''} to fix. Click: we fix what we can.` : next ? `Next step: ${next.says}` : 'Something wrong? We check everything and fix it.';
}
/** Mount "Something wrong? Fix it" (top bar, left of Help; floating if the page has no top bar) + take over "Help me". */
export function mountDoctor(a: App, opts: { go?: (area: 'live' | 'me' | 'room' | 'home') => void } = {}) {
  app = a;
  if (opts.go) go = opts.go;
  app.on((w) => { if (w === 'avatar') avatarLoadedAt = Date.now(); });
  // an avatar that failed to load (src/app.ts toasts "Couldn't load avatar: …")
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLElement && n.classList.contains('toast') && /Couldn.t load avatar/i.test(n.textContent ?? '')) { avatarFailedAt = Date.now(); failedName = app.profile?.name ?? ''; } })
    .observe(document.body, { childList: true, subtree: true });
  setHelpCheckTakeover(openDoctor);
  if (app.observer || btn || counting) return;
  // the studio's top bar already has the one "Fix it" button (src/ui/assistHooks.ts fixItButton, also the show dock's):
  // the doctor plugs into it instead of adding a second one. Its own button is only for a page without that bar.
  if (document.querySelector('#topbar [data-ui="fix-it"]')) {
    counting = true;
    registerFixIt({ open: () => openDoctor(), issues: () => count, next: () => next, label: 'Something wrong? Fix it' });
    void quickCount();
    window.setInterval(() => { if (document.visibilityState === 'visible') void quickCount(); }, 15_000);
    // a camera start that ended (worked or failed: 'status:' is its last word) is counted again soon
    let t = 0;
    app.on((w) => { if (w === 'tracking' || w === 'avatar' || w === 'status:') { clearTimeout(t); t = window.setTimeout(() => void quickCount(), 1500); } });
    return;
  }
  if (!document.getElementById('dr-style')) document.head.append(h('style', { id: 'dr-style' }, CSS));
  btn = h('button', { class: 'dr-btn clean', 'data-ui': 'fix-it', 'aria-label': 'Something wrong? Fix it', onClick: () => openDoctor() },
    icon('check', 15), h('span', { class: 'l' }, 'Fix it'), h('span', { class: 'n', hidden: true }, '0')) as HTMLButtonElement;
  const place = () => {
    const top = document.getElementById('topbar');
    const help = top?.querySelector('.gd-help');
    if (help) { help.before(btn!); btn!.classList.remove('float'); return true; }
    return false;
  };
  if (!place()) { btn.classList.add('float'); document.body.append(btn); let tries = 0; const t = window.setInterval(() => { if (place() || ++tries > 20) clearInterval(t); }, 500); }
  void quickCount();
  window.setInterval(() => { if (document.visibilityState === 'visible') void quickCount(); }, 15_000);
  app.on((w) => { if (w === 'tracking' || w === 'avatar') setTimeout(() => void quickCount(), 1500); });
}
