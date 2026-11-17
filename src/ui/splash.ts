// Studio loading screen ("Welcome to VTube Pro" + early-beta note). Loaded by one <script> line in index.html, BEFORE
// src/main.ts, so it paints while the studio code downloads. Studio only: output.html / OBS never load it.
// The progress bar follows real loading steps (no fake timer):
//   1. studio code  - each script that arrives moves the bar a little; done when main.ts has created the App (window.vtp)
//   2. server       - the avatar list answered (/api/avatars) and the scene settings arrived
//   3. avatar       - the App's own status messages while the model builds, done when the avatar is on screen
//   4. tracking     - only when the camera was on last time: done when tracking is running again
// Skippable (button, Esc, Enter), silent, honours reduced motion, fades out when ready. Never shown on ?observer=1
// debug tabs unless ?splash=1; ?nosplash turns it off.
import { injectTheme } from './theme.ts';
// the one studio version (src/ui/studioVersion.ts): the update notice names the same one
import { STUDIO_VERSION as pkgVersion, exposeStudioVersion } from './studioVersion.ts';
import { brandSvg } from './brandMark.ts';
import { isObserverTab } from './observerMode.ts';

type StepId = 'code' | 'server' | 'avatar' | 'tracking';
interface Step { id: StepId; label: string; weight: number; frac: number; done: boolean; note?: string }
interface AppLike {
  on?: (fn: (what: string) => void) => unknown;
  runtime?: unknown; profile?: { name?: string } | null; trackingOn?: boolean; observer?: boolean;
  scene?: { loaded?: boolean };
}

const TIPS = [
  'Press <kbd>?</kbd> any time to see every keyboard shortcut.',
  'Press <kbd>H</kbd> to hide the menus and see only your avatar.',
  'In OBS, add a Browser Source with the OBS link from Home (Copy OBS link). The background is see-through.',
  'Turn on your camera and your avatar copies your face. Nothing leaves this PC.',
  'Not sure what a setting does? Hover it for a plain-language explanation.',
];

const CSS = `
#vtp-splash { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 24px;
  background: radial-gradient(1200px 700px at 18% 12%, color-mix(in srgb, var(--accent, #7bd88f) 16%, transparent), transparent 60%),
    radial-gradient(1000px 700px at 85% 90%, color-mix(in srgb, var(--accent2, #6cc7f5) 14%, transparent), transparent 60%), var(--bg, #0e1015);
  color: var(--text, #eef1f6); font-family: var(--font-ui, "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif);
  opacity: 1; transition: opacity 480ms var(--ease, cubic-bezier(.2,.7,.2,1)); -webkit-font-smoothing: antialiased; }
#vtp-splash.out { opacity: 0; pointer-events: none; }
#vtp-splash .sp-card { width: min(560px, 100%); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 0; }
#vtp-splash .sp-mark { width: 88px; height: 88px; border-radius: 20px; display: grid; place-items: center; line-height: 1;
  box-shadow: 0 18px 50px -18px color-mix(in srgb, var(--accent, #7bd88f) 60%, transparent);
  animation: sp-float 4.2s ease-in-out infinite; }
#vtp-splash h1 { margin: 22px 0 0; font-family: var(--font-display, "Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif);
  font-size: clamp(28px, 3.4vw, 40px); font-weight: 700; letter-spacing: -.01em; line-height: 1.12; color: var(--text, #eef1f6); }
#vtp-splash h1 b { color: var(--accent, #7bd88f); font-weight: 700; }
#vtp-splash .sp-beta { margin-top: 16px; display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px 5px 6px; border-radius: 99px;
  background: color-mix(in srgb, var(--warn, #ffb454) 13%, transparent); color: var(--text, #eef1f6); font-size: var(--fs-s, 12.5px); }
#vtp-splash .sp-beta i { font-style: normal; font-weight: 700; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; padding: 2px 7px; border-radius: 99px;
  background: var(--warn, #ffb454); color: #1a1204; }
#vtp-splash .sp-thanks { margin: 14px 0 0; font-size: var(--fs-l, 15px); color: var(--dim, #a3abba); line-height: 1.5; max-width: 440px; }
#vtp-splash .sp-thanks strong { color: var(--text, #eef1f6); font-weight: 600; }
#vtp-splash .sp-prog { margin-top: 34px; width: min(420px, 100%); }
#vtp-splash .sp-bar { height: 6px; border-radius: 99px; background: color-mix(in srgb, var(--text, #fff) 9%, transparent); overflow: hidden; }
#vtp-splash .sp-bar > span { display: block; height: 100%; width: 0%; border-radius: inherit;
  background: linear-gradient(90deg, var(--accent, #7bd88f), var(--accent2, #6cc7f5)); transition: width 320ms var(--ease, ease-out); }
#vtp-splash .sp-now { margin-top: 10px; display: flex; justify-content: space-between; gap: 12px; font-size: var(--fs-s, 12.5px); color: var(--dim, #a3abba); }
#vtp-splash .sp-now span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
#vtp-splash .sp-now span:last-child { font-variant-numeric: tabular-nums; color: var(--faint, #717a8b); }
#vtp-splash .sp-steps { margin: 16px 0 0; padding: 0; list-style: none; display: flex; justify-content: center; flex-wrap: wrap; gap: 6px 16px;
  font-size: var(--fs-xs, 11.5px); color: var(--faint, #717a8b); }
#vtp-splash .sp-steps li { display: inline-flex; align-items: center; gap: 6px; }
#vtp-splash .sp-steps li::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: color-mix(in srgb, var(--text, #fff) 18%, transparent); }
#vtp-splash .sp-steps li.on { color: var(--text, #eef1f6); }
#vtp-splash .sp-steps li.on::before { background: var(--accent2, #6cc7f5); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent2, #6cc7f5) 25%, transparent); }
#vtp-splash .sp-steps li.done { color: var(--dim, #a3abba); }
#vtp-splash .sp-steps li.done::before { background: var(--accent, #7bd88f); }
#vtp-splash .sp-tip { margin-top: 26px; min-height: 20px; font-size: var(--fs-s, 12.5px); color: var(--faint, #717a8b); transition: opacity 260ms ease; }
#vtp-splash .sp-tip kbd { font: 600 11px/1 var(--font-ui, system-ui); padding: 2px 6px; border-radius: 5px; border: 1px solid var(--line2, #333a4a);
  background: var(--card, #1b1f28); color: var(--text, #eef1f6); }
#vtp-splash .sp-slow { margin-top: 14px; font-size: var(--fs-s, 12.5px); color: var(--dim, #a3abba); display: none; }
#vtp-splash .sp-slow.on { display: block; }
#vtp-splash .sp-foot { position: absolute; left: 0; right: 0; bottom: 18px; padding: 0 22px; display: flex; justify-content: space-between; align-items: center;
  font-size: var(--fs-xs, 11.5px); color: var(--faint, #717a8b); }
#vtp-splash .sp-skip { font: inherit; font-size: var(--fs-s, 12.5px); color: var(--dim, #a3abba); background: transparent; cursor: pointer;
  border: 1px solid var(--line2, #333a4a); border-radius: var(--r-m, 10px); padding: 6px 12px; }
#vtp-splash .sp-skip:hover { color: var(--text, #eef1f6); border-color: var(--dim, #a3abba); }
#vtp-splash .sp-skip:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bg, #0e1015), 0 0 0 4px var(--accent2, #6cc7f5); }
#vtp-splash .sp-mark svg { width: 100%; height: 100%; }
#vtp-splash .sp-fail-lead { margin: 12px 0 0; font-size: var(--fs-l, 15px); color: var(--dim, #a3abba); line-height: 1.5; max-width: 460px; }
#vtp-splash .sp-fail-list { margin: 20px 0 0; padding: 0 0 0 22px; text-align: left; display: grid; gap: 8px; max-width: 480px;
  font-size: var(--fs-m, 14px); line-height: 1.5; color: var(--text, #eef1f6); }
#vtp-splash .sp-fail-list a { color: var(--accent2, #6cc7f5); }
#vtp-splash .sp-fail-btns { margin-top: 24px; display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
#vtp-splash .sp-btn { font: inherit; font-size: var(--fs-m, 14px); font-weight: 600; color: var(--text, #eef1f6); background: transparent; cursor: pointer;
  text-decoration: none; border: 1px solid var(--line2, #333a4a); border-radius: var(--r-m, 10px); padding: 9px 16px; }
#vtp-splash .sp-btn.primary { background: var(--accent, #7bd88f); border-color: transparent; color: #0b0e12; }
#vtp-splash .sp-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bg, #0e1015), 0 0 0 4px var(--accent2, #6cc7f5); }
#vtp-splash .sp-fail-det { margin-top: 18px; max-width: 520px; text-align: left; font-size: var(--fs-xs, 11.5px); color: var(--faint, #717a8b); }
#vtp-splash .sp-fail-det code { display: block; margin-top: 6px; word-break: break-all; user-select: all; font-family: ui-monospace, Consolas, Menlo, monospace; }
@keyframes sp-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
@media (max-height: 640px) { #vtp-splash .sp-prog { margin-top: 22px; } #vtp-splash .sp-tip { margin-top: 16px; } #vtp-splash .sp-mark { width: 70px; height: 70px; border-radius: 16px; } }
@media (prefers-reduced-motion: reduce) {
  #vtp-splash, #vtp-splash .sp-bar > span, #vtp-splash .sp-tip { transition: none; }
  #vtp-splash .sp-mark { animation: none; }
}`;

// production: the hashed file name of this chunk is the build id; on the dev server there is none (a .ts URL). The
// build names chunks "name-hash.js" or just "hash.js": both count.
const BUILD_ID = /\/(?:[\w-]+-)?([A-Za-z0-9_-]{6,})\.js(?:\?|$)/.exec(import.meta.url)?.[1].slice(0, 8) ?? '';
const buildLabel = () => (BUILD_ID ? `build ${BUILD_ID}` : 'dev build');

/** WebGL 2 (three.js needs it) and the graphics card's name, for the "couldn't start" screen. The test context is freed. */
function webgl2(): { ok: boolean; gpu: string } {
  try {
    const g = document.createElement('canvas').getContext('webgl2');
    if (!g) return { ok: false, gpu: '' };
    const dbg = g.getExtension('WEBGL_debug_renderer_info');
    const gpu = String(g.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : g.RENDERER) ?? '');
    g.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: true, gpu };
  } catch { return { ok: false, gpu: '' }; }
}
/** No progress for this long after the studio started: the loading screen opens the studio by itself. */
const STALL_OPEN_MS = 40000;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function start() {
  const q = new URLSearchParams(location.search);
  if (q.has('nosplash') || (isObserverTab() && !q.has('splash'))) return;
  if (document.getElementById('vtp-splash')) return;
  injectTheme(); // the studio's own colour tokens + dark/light choice (the shell calls it again: a no-op)
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();

  const style = document.createElement('style');
  style.id = 'vtp-splash-css';
  style.textContent = CSS;
  document.head.append(style);

  const root = document.createElement('div');
  root.id = 'vtp-splash';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'vtp-splash-title');
  root.innerHTML = `
    <div class="sp-card">
      <div class="sp-mark" aria-hidden="true">${brandSvg('tile', 88)}</div>
      <h1 id="vtp-splash-title">Welcome to VTube <b>Pro</b></h1>
      <div class="sp-beta"><i>Early beta</i> VTube Pro is in early beta testing, so you may spot a few rough edges.</div>
      <p class="sp-thanks"><strong>Thank you for trying it out!</strong></p>
      <div class="sp-prog">
        <div class="sp-bar" role="progressbar" aria-label="Loading the studio" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
        <div class="sp-now" aria-live="polite"><span>Starting…</span><span>0%</span></div>
        <ul class="sp-steps"></ul>
        <div class="sp-slow">This is taking longer than usual. You can open the studio now; it keeps loading in the background.</div>
      </div>
      <div class="sp-tip"></div>
    </div>
    <div class="sp-foot"><span class="sp-ver" data-ui="splash-version"></span><button class="sp-skip" type="button">Skip <span aria-hidden="true">(Esc)</span></button></div>`;
  document.body.append(root);

  const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
  const bar = $<HTMLElement>('.sp-bar'), fill = $<HTMLElement>('.sp-bar > span');
  const nowText = $<HTMLElement>('.sp-now span:first-child'), pct = $<HTMLElement>('.sp-now span:last-child');
  const list = $<HTMLElement>('.sp-steps'), tip = $<HTMLElement>('.sp-tip'), slow = $<HTMLElement>('.sp-slow');
  const skip = $<HTMLButtonElement>('.sp-skip');
  $<HTMLElement>('.sp-ver').textContent = `v${pkgVersion || '?'} · early beta · ${buildLabel()}`;

  const resumesCamera = (() => { try { return !!localStorage.getItem('vtp.tracking'); } catch { return false; } })();
  const steps: Step[] = [
    { id: 'code', label: 'Studio', weight: 0.34, frac: 0, done: false },
    { id: 'server', label: 'Server', weight: 0.14, frac: 0, done: false },
    { id: 'avatar', label: 'Avatar', weight: 0.4, frac: 0, done: false },
    { id: 'tracking', label: 'Face tracking', weight: 0.12, frac: 0, done: false },
  ];
  const lis = steps.map((s) => { const li = document.createElement('li'); li.textContent = s.label; list.append(li); return li; });
  const step = (id: StepId) => steps.find((s) => s.id === id)!;
  const current = () => steps.find((s) => !s.done);
  let detail = '';

  const nowLine = (): string => {
    const c = current();
    if (!c) return 'Ready';
    if (c.id === 'code') return 'Loading the studio…';
    if (c.id === 'server') return 'Connecting to VTube Pro…';
    if (c.id === 'avatar') return detail ? `Loading your avatar: ${detail}` : 'Loading your avatar…';
    return 'Waking up face tracking (your camera was on last time)…';
  };
  let shown = 0;
  const render = () => {
    const total = steps.reduce((a, s) => a + s.weight * (s.done ? 1 : Math.min(0.95, s.frac)), 0);
    shown = Math.max(shown, Math.round(total * 100)); // never goes backwards
    fill.style.width = `${shown}%`;
    bar.setAttribute('aria-valuenow', String(shown));
    pct.textContent = `${shown}%`;
    nowText.textContent = nowLine();
    const c = current();
    steps.forEach((s, i) => { lis[i].className = s.done ? 'done' : s === c ? 'on' : ''; });
  };
  const finish = (id: StepId, note?: string) => { const s = step(id); if (!s.done) { s.done = true; s.frac = 1; s.note = note; } };

  // ---- step 1: studio code. Each script / module that arrives moves the bar a little (dev: hundreds, build: a few).
  let scripts = 0;
  let po: PerformanceObserver | null = null;
  let avatarList = false;
  const onEntry = (e: PerformanceEntry) => {
    const r = e as PerformanceResourceTiming;
    if (r.initiatorType === 'script' || r.initiatorType === 'link' || /\.(m?[jt]s|css)(\?|$)/.test(r.name)) scripts++;
    const path = (() => { try { return new URL(r.name).pathname; } catch { return ''; } })();
    if (path === '/api/avatars') avatarList = true;
    if (/^\/library\/.+\.(glb|vrm|gltf)$/i.test(path)) bumpAvatar();
  };
  try {
    for (const e of performance.getEntriesByType('resource')) onEntry(e);
    po = new PerformanceObserver((l) => { for (const e of l.getEntries()) onEntry(e); });
    po.observe({ type: 'resource', buffered: false });
  } catch { /* old browser: steps still complete from the App's events */ }

  // ---- step 3 progress: the App's status messages while the avatar builds ("Loading model…", "Rigging…")
  let avatarTicks = 0;
  function bumpAvatar() { avatarTicks++; const s = step('avatar'); s.frac = Math.max(s.frac, 1 - Math.pow(0.62, avatarTicks)); }

  let hooked: AppLike | null = null;
  let trackingSince = 0;
  const hook = (app: AppLike) => {
    hooked = app;
    app.on?.((what: string) => {
      if (what.startsWith('status:')) {
        const s = what.slice(7).trim();
        if (s && !step('avatar').done) { detail = s.replace(/[.…]+$/, '').slice(0, 60); bumpAvatar(); }
      }
      if (what === 'avatar') finish('avatar');
      // the avatar could not load (2026-10-06, a Bazzite user "stuck at 96%": an older Linux build 404ed every avatar file,
      // feedback#2): open the studio, whose own message says what went wrong, instead of a bar that never moves again
      if (what === 'avatar-failed') finish('avatar', 'failed');
      if (what === 'tracking' && app.trackingOn) finish('tracking');
    });
  };

  let closed = false, noProgressSince = performance.now(), lastShown = -1;
  const close = (why: 'ready' | 'skip') => {
    if (closed) return;
    closed = true;
    window.clearInterval(timer); window.clearInterval(tipTimer);
    window.removeEventListener('keydown', onKey, true);
    try { po?.disconnect(); } catch { /* */ }
    if (why === 'ready') { shown = 100; fill.style.width = '100%'; pct.textContent = '100%'; nowText.textContent = 'Ready'; }
    root.classList.add('out');
    const gone = () => { root.remove(); style.remove(); };
    if (reduced) gone(); else { root.addEventListener('transitionend', gone, { once: true }); window.setTimeout(gone, 900); }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close('skip'); }
  };
  window.addEventListener('keydown', onKey, true);
  skip.addEventListener('click', () => close('skip'));
  skip.focus({ preventScroll: true });

  const timer = window.setInterval(() => {
    const w = window as unknown as { vtp?: AppLike };
    const code = step('code');
    if (!code.done) {
      // dev server: one request per module (~700); a build: a handful of chunks. n/(n+k) never claims 100% early.
      code.frac = Math.max(code.frac, scripts / (scripts + (BUILD_ID ? 3 : 200)));
      if (w.vtp) { finish('code'); hook(w.vtp); }
    }
    const app = hooked;
    if (app) {
      if (!step('server').done) {
        const srv = step('server');
        srv.frac = (avatarList ? 0.6 : 0) + (app.scene?.loaded ? 0.4 : 0);
        if (avatarList || app.runtime) finish('server');
      }
      if (step('server').done && !step('avatar').done) {
        if (app.runtime) finish('avatar');
        // no avatar in the library at all (fresh install without samples): nothing to wait for
        else if (performance.now() - t0 > 4000 && avatarList && !app.profile && avatarTicks === 0 && (performance.now() - noProgressSince) > 2500) finish('avatar', 'none');
      }
      if (step('avatar').done && !step('tracking').done) {
        if (!resumesCamera || app.observer || app.trackingOn) finish('tracking');
        else {
          if (!trackingSince) trackingSince = performance.now();
          step('tracking').frac = Math.min(0.9, (performance.now() - trackingSince) / 8000);
          // a camera that doesn't come back (unplugged, permission prompt) shouldn't hold the studio hostage
          if (performance.now() - trackingSince > 12000) finish('tracking', 'later');
        }
      }
    }
    render();
    if (shown !== lastShown) { lastShown = shown; noProgressSince = performance.now(); }
    if (performance.now() - noProgressSince > 15000) { slow.classList.add('on'); skip.textContent = 'Open the studio now'; }
    // nothing moved for a long time once the studio exists: open it (it keeps loading behind; its own messages explain
    // a failure). A percentage that never moves again reads as "frozen" (the 4% and 96% reports).
    if (hooked && performance.now() - noProgressSince > STALL_OPEN_MS) { close('skip'); return; }
    // done: keep the welcome up a moment so it can be read, then fade
    if (!current() && performance.now() - t0 > 1600) close('ready');
  }, 120);

  // ---- the studio can't start (2026-10-03: a Bazzite user sat at 4% for good). The studio code arrived but creating
  // the App threw: usually no WebGL 2 (a Flatpak browser with the graphics card turned off, hardware acceleration off),
  // or blocked site data. Say so, say what to try, offer the details to copy. Never sit at a percentage forever.
  let failed = false;
  const fail = (err: unknown) => {
    if (failed || closed || step('code').done) return;
    failed = true;
    window.clearInterval(timer); window.clearInterval(tipTimer);
    window.removeEventListener('keydown', onKey, true);
    const msg = (err instanceof Error ? err.message : String(err ?? '')).slice(0, 300) || 'no error message';
    const gl = webgl2();
    const no3d = !gl.ok || /webgl|context/i.test(msg);
    const details = `VTube Pro v${pkgVersion || '?'} (${buildLabel()}) · WebGL 2: ${gl.ok ? `yes (${gl.gpu || 'unknown GPU'})` : 'no'} · ${navigator.userAgent} · error: ${msg}`;
    const tips = no3d
      ? ['Turn on hardware acceleration (graphics acceleration) in your browser\'s settings, then reload.',
        'Update your browser and graphics drivers. On Linux with a Flatpak browser, run <b>flatpak update</b>.',
        'Try Chrome, Edge or Firefox. <a href="https://get.webgl.org/webgl2/" target="_blank" rel="noopener">get.webgl.org/webgl2</a> should show a spinning cube.']
      : ['Reload the page.', 'Allow cookies and site data for this site.', 'Try Chrome, Edge or Firefox.'];
    $<HTMLElement>('.sp-card').innerHTML = `
      <div class="sp-mark" aria-hidden="true">${brandSvg('tile', 88)}</div>
      <h1 id="vtp-splash-title">${no3d ? 'Your browser can\'t show 3D right now' : 'The studio couldn\'t start'}</h1>
      <p class="sp-fail-lead">${no3d ? 'VTube Pro needs WebGL 2, the browser\'s 3D graphics. It\'s turned off or blocked here.' : 'Something stopped it while it was loading.'}</p>
      <ol class="sp-fail-list">${tips.map((t) => `<li>${t}</li>`).join('')}</ol>
      <div class="sp-fail-btns"><button type="button" class="sp-btn primary" data-act="reload">Reload</button><button type="button" class="sp-btn" data-act="copy">Copy details</button><a class="sp-btn" href="https://github.com/vtubepro/VTube-Pro-Public/issues" target="_blank" rel="noopener">Get help</a></div>
      <details class="sp-fail-det"><summary>Details</summary><code>${esc(details)}</code></details>`;
    root.setAttribute('aria-labelledby', 'vtp-splash-title');
    $<HTMLElement>('.sp-foot').style.display = 'none';
    $<HTMLButtonElement>('[data-act="reload"]').addEventListener('click', () => location.reload());
    const copy = $<HTMLButtonElement>('[data-act="copy"]');
    copy.addEventListener('click', () => { void navigator.clipboard?.writeText(details).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Select the details below'; }); });
    $<HTMLButtonElement>('[data-act="reload"]').focus({ preventScroll: true });
    console.error('[vtube-pro] the studio could not start:', err);
  };
  // main.ts reports a failed `new App` at once (src/main.ts). Other errors before the App exists are only remembered:
  // a stray error (an add-on script, the update ticker) must not stop a studio that would still start.
  (window as unknown as { __vtpBootFail?: (e: unknown) => void }).__vtpBootFail = fail;
  let firstErr: unknown = null;
  window.addEventListener('error', (e) => { if (!step('code').done) firstErr ??= e.error ?? e.message; });
  window.addEventListener('unhandledrejection', (e) => { if (!step('code').done) firstErr ??= e.reason; });
  // backstop: every script has run (the page's load event; main.ts has no top-level await before `new App`) and still
  // no App: a studio chunk that never arrived, or an error main.ts couldn't report
  let loadedAt = 0;
  const backstop = window.setInterval(() => {
    if (failed || closed || step('code').done) { window.clearInterval(backstop); return; }
    if (document.readyState === 'complete') { loadedAt ||= performance.now(); if (performance.now() - loadedAt > 5000) fail(firstErr ?? new Error('the studio code loaded but did not start')); }
  }, 500);

  // ---- rotating tips (optional nicety)
  let tipI = Math.floor(Math.random() * TIPS.length);
  const showTip = () => { tip.innerHTML = `Tip: ${TIPS[tipI % TIPS.length]}`; tipI++; };
  showTip();
  const tipTimer = window.setInterval(() => {
    if (reduced) { showTip(); return; }
    tip.style.opacity = '0';
    window.setTimeout(() => { showTip(); tip.style.opacity = '1'; }, 260);
  }, 5200);
  render();
}

exposeStudioVersion(); // <html data-vtp-version>, also when the loading screen is skipped
if (!/\/output\.html$/.test(location.pathname)) start();
