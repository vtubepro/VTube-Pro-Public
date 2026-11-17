// Pro2D → 3D review renders in the app renderer, in a SEPARATE muted headless browser (lane to3d; finding 1: never in
// the live studio's process). The helper starts Edge / Chrome / Chromium headless with the CPU rasteriser (SwiftShader:
// never the graphics card the stream uses), at the lowest priority (Windows `start /low`, so its child processes inherit
// it; elsewhere `nice -n 19`), --mute-audio, a throw-away profile folder. It loads to3d-render.html with a one-time
// token; the page fetches the plan + model from here and posts each PNG back. While live: one view at a time with
// gaps. No browser on the PC → the caller falls back to the Blender toon stand-in (marked approximate).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { ANGLES } from '../../shared/to3d/job.ts';
import { PORT } from '../paths.ts';

export interface Shot { name: string; focus: 'head' | 'bust' | 'full'; yaw: number; pose?: string | null; eyes?: boolean }
/** the compare's head close-ups (eyes projected), the 8 angles, the expression / viseme sheet */
export const SHOTS: Shot[] = [
  { name: 'head_0', focus: 'head', yaw: 0, eyes: true }, { name: 'head_p20', focus: 'head', yaw: 20, eyes: true }, { name: 'head_m20', focus: 'head', yaw: -20, eyes: true },
  ...ANGLES.map((a): Shot => ({ name: `bust_${a < 0 ? 'm' : 'p'}${Math.abs(a)}`, focus: 'bust', yaw: a })),
  ...['Blink', 'Smile', 'Surprised', 'Angry', 'Say “Ahh”', 'Say “Ooh”', 'Say “Eee”', 'Say “Mmm”'].map((p, i): Shot => ({ name: `expr_${i}`, focus: 'head', yaw: 0, pose: p })),
];
export const EXPR_LABELS = ['blink', 'smile', 'surprised', 'angry', 'aa', 'oo', 'ee', 'PP (lips sealed)'];

interface Session { token: string; dir: string; model: string; profile: unknown; gapMs: number; shots: Shot[]; got: Set<string>; resolve: (r: RenderResult) => void; timer: NodeJS.Timeout }
export interface RenderResult { ok: boolean; error?: string; eyes?: Record<string, { L: [number, number]; R: [number, number] }>; files: string[] }
const sessions = new Map<string, Session>();

export function findBrowser(env = process.env, exists = fs.existsSync): string | null {
  if (env.VTP_TO3D_BROWSER && exists(env.VTP_TO3D_BROWSER)) return env.VTP_TO3D_BROWSER;
  const c: string[] = [];
  if (process.platform === 'win32') {
    for (const pf of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean) as string[]) {
      c.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium');
  return c.find((p) => exists(p)) ?? null;
}

export const renderOrigin = () => process.env.VTP_TO3D_RENDER_ORIGIN || `http://127.0.0.1:${PORT}`;

export function browserArgs(profileDir: string, url: string, size: number): string[] {
  return ['--headless=new', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--autoplay-policy=user-gesture-required', '--hide-scrollbars',
    `--user-data-dir=${profileDir}`, `--window-size=${size + 32},${size + 32}`, url];
}

/** Kill only the browser processes that use OUR profile folder (never the user's own browser). */
function killOurs(profileDir: string, child: ReturnType<typeof spawn> | null) {
  if (process.platform === 'win32') {
    const needle = profileDir.replace(/'/g, "''");
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { windowsHide: true, timeout: 20000 }, () => setTimeout(() => fs.rm(profileDir, { recursive: true, force: true }, () => {}), 1500));
  } else {
    try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    setTimeout(() => fs.rm(profileDir, { recursive: true, force: true }, () => {}), 1500);
  }
}

/** Render the round's candidate. Resolves when the page says done, fails, or the time runs out (never throws). */
export async function renderCandidate(o: { dir: string; model: string; profile: unknown; live: boolean; size?: number; timeoutMs?: number; shots?: Shot[] }): Promise<RenderResult> {
  const exe = findBrowser();
  if (!exe) return { ok: false, error: 'no Chrome / Edge / Chromium on this computer', files: [] };
  fs.mkdirSync(o.dir, { recursive: true });
  const token = crypto.randomBytes(18).toString('base64url');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `vtp-to3d-render-${process.pid}-`));   // (VTube Pro's pid: orphans are told apart)
  const size = o.size ?? 640;
  const url = `${renderOrigin()}/to3d-render.html?t=${token}`;
  let child: ReturnType<typeof spawn> | null = null;
  const args = browserArgs(profileDir, url, size);
  const p = new Promise<RenderResult>((resolve) => {
    const timer = setTimeout(() => finish(token, { ok: false, error: 'the renderer did not finish in time' }), o.timeoutMs ?? (o.live ? 15 : 8) * 60_000);
    sessions.set(token, { token, dir: o.dir, model: o.model, profile: o.profile, gapMs: o.live ? 600 : 0, shots: o.shots ?? SHOTS, got: new Set(), resolve, timer });
  });
  if (process.platform === 'win32') {
    // `start /low` gives the browser AND every process it starts the idle priority class
    const q = (s: string) => `"${s.replace(/"/g, '')}"`;
    // cmd /s /c "<line>": cmd strips exactly the outer pair of quotes, the rest is passed on as written
    child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "" /low /b ${q(exe)} ${args.map(q).join(' ')}"`], { windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
  } else {
    child = spawn('nice', ['-n', '19', exe, ...args], { detached: true, stdio: 'ignore' });
  }
  child.on('error', () => finish(token, { ok: false, error: 'the browser could not be started' }));
  const r = await p;
  killOurs(profileDir, child);
  return r;
}

function finish(token: string, r: Omit<RenderResult, 'files'> & { files?: string[] }) {
  const s = sessions.get(token);
  if (!s) return;
  sessions.delete(token);
  clearTimeout(s.timer);
  s.resolve({ ...r, files: [...s.got].map((n) => `${n}.png`) });
}

/** A helper that stopped mid-render (crash, update) leaves its headless browser behind: at start, end every browser
 *  that uses one of OUR throw-away profile folders (never anything else) and remove the folders. */
export function cleanupOrphans() {
  let dirs: string[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
  try {
    dirs = fs.readdirSync(os.tmpdir()).map((d) => /^vtp-to3d-render-(\d+)-[A-Za-z0-9]{6}$/.exec(d)).filter((m): m is RegExpExecArray => !!m && Number(m[1]) !== process.pid && !alive(Number(m[1])))
      .map((m) => path.join(os.tmpdir(), m[0]));
  } catch { return; }
  for (const d of dirs) killOurs(d, null);
}

// ---------------------------------------------------------------- what the page calls (routes.ts mounts these)
export const sessionOf = (t: string) => sessions.get(t) ?? null;
export function planOf(t: string) {
  const s = sessions.get(t);
  return s ? { model: `/api/to3d/render/${encodeURIComponent(t)}/model`, profile: s.profile, size: 640, gapMs: s.gapMs, shots: s.shots } : null;
}
export function saveShot(t: string, name: string, png: Buffer): boolean {
  const s = sessions.get(t);
  if (!s || !s.shots.some((x) => x.name === name) || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return false;
  fs.writeFileSync(path.join(s.dir, `${name}.png`), png);
  s.got.add(name);
  return true;
}
export function doneShots(t: string, body: { eyes?: RenderResult['eyes']; error?: string }) {
  const s = sessions.get(t);
  if (!s) return false;
  if (body.eyes) fs.writeFileSync(path.join(s.dir, 'eyes.json'), JSON.stringify(body.eyes));
  finish(t, body.error ? { ok: false, error: body.error } : { ok: s.got.size > 0, eyes: body.eyes, ...(s.got.size ? {} : { error: 'no pictures came back' }) });
  return true;
}
