// novice-proofing: the "Help me" checker. One button (Help menu → Help me) checks the browser, OBS, the camera and the
// microphone, then says in plain words what to do next, with one fix button per row.
// Read-only: it never starts the camera or microphone (it only asks the browser what is allowed), never saves, never
// makes a sound. Network: GET /api/obs/outputs on this PC's studio server, read-only.
import { h } from '../dom.ts';
import { browserOf, diagnose, nextStep, type Facts, type FixAction, type Row } from './helpCheckRules.ts';
import { HELP_CHAT_URL, openGuide } from './links.ts';

/** Where the studio's buttons for the camera / mic live (the shell passes its own area switcher in). */
let goArea: ((a: 'live') => void) | null = null;
export function setHelpCheckHost(go: (a: 'live') => void) { goArea = go; }

/** "See all fixes" / "Show me how": the bundled Quick Start guide (works offline); the checker's old website anchors no longer apply. */
const openFixes = () => void openGuide('QUICK_START.md');

async function permission(name: 'camera' | 'microphone', kind: MediaDeviceKind): Promise<Facts['camera']> {
  let devices = -1;
  try { devices = (await navigator.mediaDevices?.enumerateDevices?.() ?? []).filter((d) => d.kind === kind).length; } catch { /* not allowed */ }
  try {
    const p = await navigator.permissions.query({ name: name as PermissionName });
    if (p.state === 'denied') return 'denied';
    if (devices === 0) return 'nodevice';
    return p.state === 'granted' ? 'granted' : 'prompt';
  } catch {
    return devices === 0 ? 'nodevice' : 'unknown'; // Firefox has no camera permission query
  }
}

async function obsState(): Promise<Facts['obs']> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch('/api/obs/outputs', { cache: 'no-store', signal: ac.signal });
    if (!r.ok) return 'unknown';
    const o = await r.json() as { count?: number; inObs?: number };
    return (o.inObs ?? 0) > 0 ? 'inObs' : (o.count ?? 0) > 0 ? 'tab' : 'none';
  } catch { return 'unknown'; } finally { clearTimeout(t); }
}

/** Collect the facts. Exported for tests on observer pages. */
export async function gatherFacts(): Promise<Facts> {
  const ua = navigator.userAgent;
  const f: Facts = {
    browser: browserOf(ua), mobile: /Android|iPhone|iPad|Mobile/.test(ua),
    obs: 'unknown', camera: 'unknown', mic: 'unknown',
  };
  const [cam, mic] = await Promise.all([permission('camera', 'videoinput'), permission('microphone', 'audioinput')]);
  f.camera = cam; f.mic = mic;
  f.obs = await obsState();
  return f;
}

// ---------------------------------------------------------------- the dialog
const CSS = `
.hc-wrap { position: fixed; inset: 0; z-index: 9000; display: grid; place-items: center; background: #05070bb3; animation: hc-in .2s cubic-bezier(.16,1,.3,1); }
.hc { width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); overflow: auto; border-radius: 16px; border: 1px solid var(--line); background: var(--bg2, #0b0f12); color: var(--text); box-shadow: 0 30px 80px -20px #000c; padding: 22px 24px 20px; display: grid; gap: 14px; position: relative; }
.hc h2 { margin: 0; font-size: 21px; } .hc p { margin: 0; line-height: 1.5; color: var(--dim); }
.hc-eyebrow { font-size: 12px; letter-spacing: .4px; text-transform: uppercase; color: var(--accent); font-weight: 700; }
.hc-next { border-radius: 12px; padding: 12px 14px; border: 1px solid rgb(255 207 106 / .4); background: rgb(255 207 106 / .07); color: var(--text); font-size: 15px; line-height: 1.45; }
.hc-next.done { border-color: rgb(123 216 143 / .45); background: rgb(123 216 143 / .08); }
.hc-next b { display: block; font-size: 12px; letter-spacing: .4px; text-transform: uppercase; color: var(--dim); margin-bottom: 3px; }
.hc-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.hc-row { display: grid; grid-template-columns: 22px 1fr auto; gap: 4px 10px; align-items: start; padding: 10px 12px; border-radius: 10px; background: var(--panel); }
.hc-row .hc-t { font-weight: 600; font-size: 14px; color: var(--text); } .hc-row .hc-s { grid-column: 2; font-size: 13px; color: var(--dim); line-height: 1.4; }
.hc-row .hc-m { grid-row: span 2; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font: 700 12px/1 system-ui; color: #06080a; margin-top: 1px; }
.hc-m.ok { background: #7bd88f; } .hc-m.warn { background: #ffcf6a; } .hc-m.bad { background: #ff7a6b; } .hc-m.skip { background: transparent; border: 1.5px dashed var(--dim); }
.hc-row .hc-btn { grid-row: span 2; align-self: center; }
.hc-btn { font: 600 13px/1 inherit; border-radius: 99px; padding: 8px 12px; border: 1px solid var(--line); background: var(--bg2, #11171b); color: var(--text); cursor: pointer; white-space: nowrap; }
.hc-btn:hover { border-color: var(--accent); } .hc-btn.primary { background: var(--accent); color: #0b1410; border-color: transparent; }
.hc-btn:focus-visible { outline: 2px solid #7bd88f; outline-offset: 3px; }
.hc-foot { display: flex; gap: 10px; flex-wrap: wrap; } .hc-foot .hc-btn { padding: 11px 16px; font-size: 14px; }
.hc-x { position: absolute; right: 12px; top: 10px; background: none; border: 0; color: var(--dim); font-size: 22px; cursor: pointer; }
.hc-spin { width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgb(123 216 143 / .3); border-top-color: #7bd88f; animation: hc-sp .8s linear infinite; display: inline-block; vertical-align: -4px; margin-right: 8px; }
@keyframes hc-sp { to { transform: rotate(360deg); } } @keyframes hc-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .hc-wrap, .hc-spin { animation: none; } }
`;
let root: HTMLElement | null = null;
let seq = 0;
function close() { root?.remove(); root = null; seq++; window.removeEventListener('keydown', onKey, true); }
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && root) { e.preventDefault(); e.stopPropagation(); close(); } };

async function run(action: FixAction) {
  if (action === 'guide') { openFixes(); return; }
  close();
  if (action === 'connectObs') { void openGuide('GO_LIVE.md'); return; }
  if (action === 'camera' || action === 'mic') goArea?.('live'); // the Tracking area has Turn on camera / Turn on mic
}

const MARK: Record<Row['mark'], string> = { ok: '✓', warn: '!', bad: '✕', skip: '' };
const MARK_LABEL: Record<Row['mark'], string> = { ok: 'Working', warn: 'Check this', bad: 'Needs fixing', skip: 'Not checked yet' };

function paint(card: HTMLElement, rows: Row[]) {
  const next = nextStep(rows);
  const list = h('ul', { class: 'hc-rows' }, ...rows.map((r) => h('li', { class: 'hc-row', 'data-row': r.id, 'data-mark': r.mark },
    h('span', { class: `hc-m ${r.mark}`, role: 'img', 'aria-label': MARK_LABEL[r.mark] }, MARK[r.mark]),
    h('span', { class: 'hc-t' }, r.title),
    r.fix ? h('button', { class: 'hc-btn', onClick: () => void run(r.fix!.action) }, r.fix.label) : h('span'),
    h('span', { class: 'hc-s' }, r.says))));
  const doNext = next.row?.fix;
  card.replaceChildren(
    h('button', { class: 'hc-x', 'aria-label': 'Close', onClick: close }, '×'),
    h('div', { class: 'hc-eyebrow' }, 'Help me'),
    h('h2', null, next.done ? 'You’re all set' : 'Here’s what to do next'),
    h('div', { class: `hc-next${next.done ? ' done' : ''}`, role: 'status' }, h('b', null, next.done ? 'All good' : 'Next step'), next.says),
    list,
    h('div', { class: 'hc-foot' },
      doNext ? h('button', { class: 'hc-btn primary', onClick: () => void run(doNext.action) }, doNext.label) : null,
      h('button', { class: `hc-btn${doNext ? '' : ' primary'}`, onClick: () => void check() }, 'Check again'),
      h('button', { class: 'hc-btn', onClick: openFixes }, 'See all fixes'),
      h('button', { class: 'hc-btn', onClick: () => window.open(HELP_CHAT_URL, '_blank', 'noopener') }, 'Ask for help')),
  );
  (card.querySelector('.hc-foot .hc-btn') as HTMLElement | null)?.focus();
}

async function check() {
  const card = root?.querySelector('.hc') as HTMLElement | null;
  if (!card) return;
  const my = ++seq;
  card.replaceChildren(
    h('div', { class: 'hc-eyebrow' }, 'Help me'),
    h('h2', null, 'Checking your setup…'),
    h('p', { role: 'status' }, h('span', { class: 'hc-spin', 'aria-hidden': 'true' }), 'This takes a few seconds. Nothing changes.'));
  const facts = await gatherFacts();
  if (my !== seq || !root) return;
  paint(card, diagnose(facts));
}

let takeover: (() => void) | null = null;
/** autopilot: the "Fix it" doctor (src/ui/autopilot/doctor.ts) replaces this read-only checker once the studio mounted it. */
export function setHelpCheckTakeover(fn: () => void) { takeover = fn; }
/** Open the checker and run it straight away. */
export function openHelpCheck() {
  if (takeover) { takeover(); return; }
  if (!document.getElementById('hc-style')) document.head.append(h('style', { id: 'hc-style' }, CSS));
  close();
  root = h('div', { class: 'hc-wrap', onClick: (e: MouseEvent) => { if (e.target === root) close(); } },
    h('div', { class: 'hc', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Help me: check my setup' }));
  document.body.append(root);
  window.addEventListener('keydown', onKey, true);
  void check();
}
