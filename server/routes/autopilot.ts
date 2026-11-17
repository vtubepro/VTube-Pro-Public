// Autopilot (beta.12, ZERO-EFFORT RULE): the helper does the parts a web page can't, so the studio can fix things for
// first-time users with one click.
//   POST /api/autopilot/open-settings {target:'site'|'os'|'gpu', kind:'camera'|'mic', browser, origin}
//        → opens the user's own browser on its camera / microphone page for the studio's site (chrome://, edge://,
//          brave://, about:preferences), the OS privacy page (ms-settings:, x-apple.systempreferences:) or the
//          browser's graphics page. Allow-listed launches only (shared/autopilot/openSettings.ts): a page sends names,
//          never a path or URL that reaches a command line. VTP_TOOLS_DRYRUN=1: plan only, nothing starts (tests).
//   GET  /api/autopilot/camera-users → { apps: ['Zoom', 'OBS'] } apps that usually hold a webcam and are running now
//          (names from a fixed list only: the process list itself never leaves this computer)
//   GET  /api/autopilot/tools → Blender + AI apps in one line each, for the studio's "Fix it" check (the full
//          /api/ai-setup/status is local only and has paths; this has none)
//   GET  /api/autopilot/first-run → { freshScene, freshLibrary } was this helper brand new when it started (no saved
//          scene / no own avatars): the studio then picks a starter room itself, so the first screen is never empty
// Who may call: server/localGuard.ts (this PC's pages).
import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { CACHE_DIR, LIBRARY_DIR, PORT } from '../paths.ts';
import { cameraUsers, type OsKind } from '../../shared/autopilot/media.ts';
import { isFlatpakBrowser, parseOpenRequest, planOpen, type OpenEnv } from '../../shared/autopilot/openSettings.ts';

export const autopilotRoutes = Router();

const HOST_OS: OsKind = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform === 'linux' ? 'linux' : 'other';
// measured once, when the helper starts (the studio saves a scene within seconds of opening)
const FRESH_SCENE = !fs.existsSync(path.join(CACHE_DIR, 'scene.json'));
const FRESH_LIBRARY = (() => { try { return !fs.readdirSync(LIBRARY_DIR).some((d) => !d.startsWith('.')); } catch { return true; } })();

function which(cmd: string): string | null {
  if (!/^[\w.+-]+$/.test(cmd)) return null;
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}
export const realOpenEnv = (): OpenEnv => ({ os: HOST_OS, vars: process.env, home: os.homedir(), exists: (p) => { try { return fs.existsSync(p); } catch { return false; } }, which });

let lastOpen = 0;
autopilotRoutes.post('/api/autopilot/open-settings', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const r = parseOpenRequest(req.body);
  if (!r) { res.status(400).json({ ok: false, says: 'Which setting? (target, kind, browser, origin)' }); return; }
  if (Date.now() - lastOpen < 1500) { res.status(429).json({ ok: false, says: 'One moment…' }); return; }
  lastOpen = Date.now();
  const env = realOpenEnv();
  const plan = planOpen(r, env);
  const flatpak = isFlatpakBrowser(r.browser, env);
  if (!plan.ok) { res.json({ ok: false, opened: false, says: plan.says, url: plan.url, flatpak }); return; }
  if (process.env.VTP_TOOLS_DRYRUN === '1') { console.log(`[autopilot] (dry run) would run ${plan.command} ${plan.args.join(' ')}`); res.json({ ok: true, opened: false, dryRun: true, says: plan.says, url: plan.url, flatpak }); return; }
  try {
    const c = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', (e) => console.warn(`[autopilot] could not open ${plan.url}: ${e.message}`));
    c.unref();
    res.json({ ok: true, opened: true, says: plan.says, url: plan.url, flatpak });
  } catch (e) { res.json({ ok: false, opened: false, says: 'We couldn’t open it. Copy the address below into a new tab instead.', url: plan.url, error: (e as Error).message, flatpak }); }
});

function processNames(): Promise<string[]> {
  return new Promise((resolve) => {
    const done = (out: string) => resolve(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    if (process.platform === 'win32') execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000, maxBuffer: 4 << 20 }, (_e, out) => done(String(out ?? '').split(/\r?\n/).map((l) => (/^"([^"]+)"/.exec(l)?.[1] ?? '')).join('\n')));
    else execFile('ps', ['-A', '-o', 'comm='], { timeout: 5000, maxBuffer: 4 << 20 }, (_e, out) => done(String(out ?? '').split(/\r?\n/).map((l) => path.basename(l.trim())).join('\n')));
  });
}
autopilotRoutes.get('/api/autopilot/camera-users', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.VTP_AUTOPILOT_FAKE_PS) { res.json({ apps: cameraUsers(process.env.VTP_AUTOPILOT_FAKE_PS.split(',')) }); return; }
  try { res.json({ apps: cameraUsers(await processNames()) }); } catch { res.json({ apps: [] }); }
});

interface AiStatus { blender?: { state?: string; summary?: string; saved?: { path: string; ok: boolean } | null }; mcp?: { apps?: { name: string; supported: boolean; installed: boolean | null; registered: boolean; current: boolean }[] } }
autopilotRoutes.get('/api/autopilot/tools', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    // the full check is local only (it has paths): ask it from here, pass on the plain words only
    const r = await fetch(`http://127.0.0.1:${PORT}/api/ai-setup/status`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) { res.json({ ok: false }); return; }
    const s = await r.json() as AiStatus;
    const apps = (s.mcp?.apps ?? []).filter((a) => a.supported);
    res.json({
      ok: true,
      blender: { state: s.blender?.state ?? 'missing', summary: String(s.blender?.summary ?? '').slice(0, 200), saved: !!s.blender?.saved }, // saved: the user set it up (no path ever)
      ai: { installed: apps.filter((a) => a.installed).map((a) => a.name), connected: apps.filter((a) => a.registered && a.current).map((a) => a.name), old: apps.filter((a) => a.registered && !a.current).map((a) => a.name) },
    });
  } catch { res.json({ ok: false }); }
});

autopilotRoutes.get('/api/autopilot/first-run', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ freshScene: FRESH_SCENE, freshLibrary: FRESH_LIBRARY, os: HOST_OS });
});
