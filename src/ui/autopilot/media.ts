// Autopilot: camera + microphone that just work (ZERO-EFFORT RULE).
//  * the best device is picked for the user (a real webcam over "OBS Virtual Camera", the main microphone over "Stereo
//    Mix"), with one sentence saying which and why (shared/autopilot/media.ts pickCamera / pickMic);
//  * one browser question for both when both are still to be asked ("Turn on camera" turns the mic on too, unless the
//    user turned it off before);
//  * when the browser or the computer says no, the recovery dialog says exactly what happened in one sentence and fixes
//    it: ask again (prompt), open the browser's own camera setting for this site or the OS privacy page through the helper
//    (a web page can't open chrome:// or ms-settings:), or a picture guide + Copy + Reload without the helper; a camera
//    held by another app names that app (the helper looks at the running apps). It tries again by itself when the
//    permission flips to Allow or the user comes back to this tab, and confirms with a live preview tick.
// Hooks: src/app.ts startTracking (pick + recovery), src/ui/liveOps.ts startCamera / startMic. Also used by the doctor.
import type { App } from '../../app.ts';
import { h, toast } from '../dom.ts';
import { micLevel } from '../liveOps.ts';
import {
  adviceFor, browserKind, classifyMediaError, osKind, pickCamera, pickMic, siteSettingsUrl,
  type Advice, type Device, type MediaKind, type MediaProblem, type PermState,
} from '../../../shared/autopilot/media.ts';

const ls = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* off */ } } };
export const BROWSER = browserKind(navigator.userAgent, typeof (navigator as Navigator & { brave?: unknown }).brave === 'object');
export const OS = osKind(navigator.userAgent);

/** The last "which device and why" sentences (the doctor shows them). */
export const lastPick: { camera: string; mic: string } = { camera: '', mic: '' };

export async function permState(kind: MediaKind): Promise<PermState> {
  try { return (await navigator.permissions.query({ name: (kind === 'camera' ? 'camera' : 'microphone') as PermissionName })).state as PermState; } catch { return 'unknown'; }
}
async function devices(kind: MediaKind): Promise<Device[]> {
  try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === (kind === 'camera' ? 'videoinput' : 'audioinput')).map((d) => ({ deviceId: d.deviceId, label: d.label })); } catch { return []; }
}

/** Before the first camera start: when the browser still has to ask for both, ask once for both (one click on Allow). */
export async function askOnceForBoth(): Promise<void> {
  if (ls.get('vtp.micOff') === '1') return;
  const [c, m] = await Promise.all([permState('camera'), permState('mic')]);
  if (c !== 'prompt' || m !== 'prompt') return;
  try { const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); s.getTracks().forEach((t) => t.stop()); } catch { /* the camera start below reports it */ }
}

/** The camera to open when the user hasn't picked one (labels unlocked first). Says once which one and why. */
export async function autoPickCamera(prefer?: RegExp): Promise<string | undefined> {
  let list = await devices('camera');
  if (list.length && list.every((d) => !d.label)) {
    try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach((t) => t.stop()); } catch (e) { throw e; }
    list = await devices('camera');
  }
  const chosen = ls.get('vtp.camChosen') ? ls.get('vtp.cam') : null;
  const p = pickCamera(list, chosen, prefer);
  lastPick.camera = p.why;
  if (p.device && !chosen && ls.get('vtp.autopilot.camSaid') !== p.device.deviceId && list.length > 1) { ls.set('vtp.autopilot.camSaid', p.device.deviceId); toast(p.why, 'info', 7000); }
  return p.device?.deviceId || undefined;
}
/** The microphone to open when the user hasn't picked one. */
export async function autoPickMic(prefer?: RegExp): Promise<{ id?: string; label: string }> {
  const chosen = ls.get('vtp.micChosen') ? ls.get('vtp.mic') : null;
  let list = await devices('mic');
  if (list.length && list.every((d) => !d.label)) {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch (e) { throw e; }
    list = await devices('mic');
  }
  const p = pickMic(list, chosen, prefer);
  lastPick.mic = p.why;
  // 'default' follows the system default: keep it as "no device" so a later change in Windows is followed too
  return { id: p.device && p.device.deviceId !== 'default' ? p.device.deviceId : undefined, label: (p.device?.label ?? '').replace(/^Default - /i, '') };
}

// ---------------------------------------------------------------- recovery
const CSS = `
.ap-wrap{position:fixed;inset:0;z-index:9100;display:grid;place-items:center;background:#05070bb3;animation:ap-in .18s ease-out}
.ap{width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 40px);overflow:auto;border-radius:16px;border:1px solid var(--line);background:var(--bg2,#0b0f12);color:var(--text);box-shadow:0 30px 80px -20px #000c;padding:22px 24px 20px;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;position:relative}
.ap h2{margin:0;font-size:20px;line-height:1.3}.ap p{margin:0;line-height:1.5;color:var(--dim)}.ap p b{color:var(--text)}
.ap-eyebrow{font-size:12px;letter-spacing:.4px;text-transform:uppercase;color:var(--accent);font-weight:700}
.ap-btn{font:600 14px/1 inherit;border-radius:12px;padding:12px 16px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer}
.ap-btn:hover{border-color:var(--accent)}.ap-btn.primary{background:var(--accent);color:var(--accent-ink,#0b1410);border-color:transparent;font-size:16px;padding:14px 18px}
.ap:focus{outline:none}
.ap-btn:focus-visible{outline:2px solid #7bd88f;outline-offset:3px}
.ap-row{display:flex;gap:10px;flex-wrap:wrap}.ap-row>*{flex:1}
.ap-steps{margin:0;padding-left:22px;display:grid;gap:6px;color:var(--text);line-height:1.45}
.ap-x{position:absolute;right:12px;top:10px;background:none;border:0;color:var(--dim);font-size:22px;cursor:pointer}
.ap-url{display:flex;gap:8px;align-items:center}.ap-url code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;padding:8px 10px;border-radius:8px;background:var(--panel);border:1px solid var(--line)}
.ap-ok{display:flex;gap:12px;align-items:center;padding:10px 12px;border-radius:12px;border:1px solid rgb(123 216 143 / .45);background:rgb(123 216 143 / .08)}
.ap-ok video{width:120px;height:68px;border-radius:8px;object-fit:cover;transform:scaleX(-1);background:#000}
.ap-tick{width:26px;height:26px;border-radius:50%;background:#7bd88f;color:#06100a;display:grid;place-items:center;font:800 15px/1 system-ui;flex:none}
.ap-meter{flex:1;height:10px;border-radius:99px;background:var(--panel);overflow:hidden}.ap-meter i{display:block;height:100%;width:0;background:#7bd88f;transition:width .1s}
.ap-wait{font-size:13px;color:var(--dim)}
.ap-pic{border-radius:12px;border:1px solid var(--line);background:var(--panel);padding:10px}
@keyframes ap-in{from{opacity:0}}
@media (max-width:520px){.ap{padding:18px 16px}.ap-row{flex-direction:column}}
`;
let root: HTMLElement | null = null;
let seq = 0;
let opener: HTMLElement | null = null;
/** Esc closes this card like "Not now", Tab stays inside it (FR-06, REDESIGN principle 9). Only while it is open. */
function onCardKey(e: KeyboardEvent) {
  if (!root) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
  if (e.key !== 'Tab') return;
  const f = [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null);
  const box = root.querySelector('.ap') as HTMLElement;
  if (!f.length) { e.preventDefault(); box.focus(); return; }
  const a = f[0], z = f[f.length - 1], at = document.activeElement;
  if (!box.contains(at)) { e.preventDefault(); (e.shiftKey ? z : a).focus(); }
  else if (e.shiftKey && (at === a || at === box)) { e.preventDefault(); z.focus(); }
  else if (!e.shiftKey && at === z) { e.preventDefault(); a.focus(); }
}
function close() {
  const back = opener; opener = null;
  const had = !!root;
  root?.remove(); root = null; seq++; offWatch?.(); offWatch = null;
  window.removeEventListener('keydown', onCardKey, true);
  if (had && back?.isConnected) back.focus({ preventScroll: true }); // focus goes back to the control that opened it
}
let offWatch: (() => void) | null = null;
function card(...kids: (Node | null)[]) {
  if (!document.getElementById('ap-style')) document.head.append(h('style', { id: 'ap-style' }, CSS));
  if (!root) {
    const a = document.activeElement as HTMLElement | null;
    opener = a && a !== document.body ? a : null;
    root = h('div', { class: 'ap-wrap', onClick: (e: MouseEvent) => { if (e.target === root) close(); } }, h('div', { class: 'ap', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Camera and microphone', tabindex: -1 }));
    document.body.append(root);
    window.addEventListener('keydown', onCardKey, true);
  }
  const c = root.querySelector('.ap') as HTMLElement;
  c.replaceChildren(h("button", { class: "ap-x", "aria-label": "Close", onClick: close }, "×"), ...kids.filter((k): k is Node => !!k));
  // the accessible name is the card's own heading ("Camera: Your browser blocked it"), else the generic one
  const hd = c.querySelector('h2');
  if (hd) { hd.id = 'ap-title'; c.setAttribute('aria-labelledby', 'ap-title'); c.removeAttribute('aria-label'); }
  else { c.removeAttribute('aria-labelledby'); c.setAttribute('aria-label', (c.querySelector('.ap-eyebrow')?.textContent || 'Camera and microphone') + ' help'); }
  const first = (c.querySelector('.ap-btn.primary') ?? c.querySelector('.ap-btn')) as HTMLElement | null;
  (first ?? c).focus({ preventScroll: true });
}

async function busyApp(): Promise<string | null> {
  try { const r = await fetch('/api/autopilot/camera-users', { cache: 'no-store' }); const j = await r.json() as { apps?: string[] }; return j.apps?.[0] ?? null; } catch { return null; }
}
async function openSettings(target: 'site' | 'os' | 'gpu', kind: MediaKind): Promise<{ ok: boolean; says: string; url: string | null }> {
  try {
    const r = await fetch('/api/autopilot/open-settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, kind, browser: BROWSER, origin: location.origin }) });
    const j = await r.json() as { ok?: boolean; says?: string; url?: string | null };
    return { ok: !!j.ok, says: j.says ?? '', url: j.url ?? null };
  } catch { return { ok: false, says: '', url: null }; }
}
export { openSettings as openSettingsPage };

/** Watch for the fix: the permission flips to Allow, or the user comes back to this tab. */
function watch(kind: MediaKind, retry: () => void): () => void {
  let stop = false; let status: PermissionStatus | null = null;
  const onChange = () => { if (!stop && status?.state === 'granted') retry(); };
  void navigator.permissions?.query({ name: (kind === 'camera' ? 'camera' : 'microphone') as PermissionName }).then((s) => { status = s; s.addEventListener('change', onChange); }).catch(() => {});
  const onBack = () => { if (!stop && document.visibilityState === 'visible') setTimeout(() => { if (!stop) retry(); }, 600); };
  document.addEventListener('visibilitychange', onBack);
  return () => { stop = true; status?.removeEventListener('change', onChange); document.removeEventListener('visibilitychange', onBack); };
}

export interface FixHost { app: App; start: (kind: MediaKind) => Promise<boolean> }
let host: FixHost | null = null;
/** The studio passes how to start the camera / mic (liveOps), so a fix can try again by itself. */
export function setMediaHost(h: FixHost) { host = h; }

/**
 * The camera / mic failed to start: say why in one sentence and fix it. Returns true when it took over (so the caller
 * shows no raw error toast). Never opens while another recovery card is up.
 */
const lastErr: Record<MediaKind, { name?: string; message?: string } | null> = { camera: null, mic: null };
/** Why the last start failed (the doctor counts blocked / busy as real problems); cleared once it works. */
export const mediaError = (kind: MediaKind): MediaProblem | null => (lastErr[kind] ? classifyMediaError(lastErr[kind], 'unknown', -1) : null);
export const clearMediaError = (kind: MediaKind) => { lastErr[kind] = null; };
export function mediaFailed(kind: MediaKind, err: unknown): boolean {
  lastErr[kind] = err as { name?: string; message?: string };
  if (root) return true; // the open card's own retry shows the new reason
  void showFix(kind, err as { name?: string; message?: string });
  return true;
}

/** Open the recovery card (the doctor's camera / mic rows use it too). `err` null = look first. */
export async function showFix(kind: MediaKind, err: { name?: string; message?: string } | null) {
  const my = ++seq;
  const perm = await permState(kind);
  const n = (await devices(kind)).length;
  let problem: MediaProblem = err ? classifyMediaError(err, perm, n) : perm === 'denied' ? 'browser' : n === 0 ? 'none' : perm === 'prompt' ? 'prompt' : 'unknown';
  if (problem === 'constraint') { // retry plain once, quietly
    if (host && await host.start(kind)) return; problem = 'unknown';
  }
  const busy = problem === 'busy' ? await busyApp() : null;
  if (my !== seq) return;
  const linuxFlatpak = OS === 'linux' && /flatpak/i.test(navigator.userAgent);
  const a = adviceFor(kind, problem, BROWSER, OS, { busyApp: busy, helper: true, linuxFlatpak });
  paintFix(kind, a, my);
}

function paintFix(kind: MediaKind, a: Advice, my: number, note = '') {
  const w = kind === 'camera' ? 'camera' : 'microphone';
  const retry = async () => {
    if (my !== seq || !host) return;
    card(h('div', { class: 'ap-eyebrow' }, kind === 'camera' ? 'Camera' : 'Microphone'), h('h2', null, `Trying your ${w} again…`), h('p', { class: 'ap-wait', role: 'status' }, 'One moment.'));
    const ok = await host.start(kind);
    if (my !== seq) return;
    if (ok) { offWatch?.(); offWatch = null; showWorking(kind, my); return; }
    // still failing: the start's own failure re-opens the card with the new reason (mediaFailed sees root and returns)
    void showFix(kind, lastErr[kind]);
  };
  const wait = h('p', { class: 'ap-wait', role: 'status' }, note);
  const btns: Node[] = [];
  const url = siteSettingsUrl(BROWSER, location.origin);
  if (a.action === 'ask' || a.action === 'retry') btns.push(h('button', { class: 'ap-btn primary', onClick: () => void retry() }, a.actionLabel));
  if (a.action === 'open-site-settings' || a.action === 'open-os-settings') {
    const target = a.action === 'open-site-settings' ? 'site' : 'os';
    btns.push(h('button', { class: 'ap-btn primary', onClick: async () => {
      const r = await openSettings(target, kind);
      if (my !== seq) return;
      wait.textContent = r.ok ? `${r.says} Set it to Allow, then come back: we try again by itself.` : (r.says || 'We couldn’t open it. Follow the steps below.');
      offWatch?.(); offWatch = watch(kind, () => void retry());
    } }, a.actionLabel));
    btns.push(h('button', { class: 'ap-btn', onClick: () => void retry() }, 'Try again'));
  }
  const showSteps = a.steps.length && (a.action !== 'open-site-settings' || BROWSER === 'safari');
  card(
    h('div', { class: 'ap-eyebrow' }, kind === 'camera' ? 'Camera' : 'Microphone'),
    h('h2', null, a.title),
    a.says ? h('p', null, a.says) : null,
    showSteps ? h('ol', { class: 'ap-steps' }, ...a.steps.map((s) => h('li', null, s))) : null,
    a.problem === 'browser' && url ? h('div', { class: 'ap-url' }, h('code', { title: 'Paste this into a new tab' }, url),
      h('button', { class: 'ap-btn', onClick: () => void navigator.clipboard.writeText(url).then(() => toast('Copied: paste it into a new tab', 'ok', 4000), () => toast('Select the address and copy it', 'warn')) }, 'Copy')) : null,
    btns.length ? h('div', { class: 'ap-row' }, ...btns) : null,
    wait,
    h('div', { class: 'ap-row' },
      a.problem === 'browser' || a.problem === 'system' ? h('button', { class: 'ap-btn', onClick: () => location.reload() }, 'Reload the page') : null,
      h('button', { class: 'ap-btn', onClick: close }, kind === 'mic' ? 'Skip the microphone' : 'Not now')),
  );
}

/** The fix worked: a live preview (camera) or a level meter (mic) with a tick, then it closes by itself. */
function showWorking(kind: MediaKind, my: number) {
  const app = host?.app;
  let live: Node;
  let stop = () => {};
  if (kind === 'camera' && app?.video.video.srcObject) {
    const v = h('video', { muted: true, playsInline: true, autoplay: true }) as HTMLVideoElement;
    v.srcObject = app.video.video.srcObject; v.muted = true; void v.play().catch(() => {});
    live = v;
  } else {
    const bar = h('i'); live = h('div', { class: 'ap-meter', 'aria-hidden': 'true' }, bar);
    const t = window.setInterval(() => { const l = app ? micLevel(app) : 0; bar.style.width = `${Math.min(100, Math.round(l * 100))}%`; }, 100);
    stop = () => clearInterval(t);
  }
  card(h('div', { class: 'ap-eyebrow' }, kind === 'camera' ? 'Camera' : 'Microphone'),
    h('div', { class: 'ap-ok', role: 'status' }, h('span', { class: 'ap-tick', 'aria-hidden': 'true' }, '✓'), h('div', { style: 'flex:1' }, h('b', null, kind === 'camera' ? 'Your camera works.' : 'Your microphone works.'), h('p', null, kind === 'camera' ? 'Your avatar follows you now.' : 'Say something: the bar moves.')), live),
    h('button', { class: 'ap-btn primary', onClick: () => { stop(); close(); } }, 'Done'));
  setTimeout(() => { if (my === seq) { stop(); close(); } }, 6000);
}
