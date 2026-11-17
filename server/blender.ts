// Locating and driving headless Blender.
// Every script in blender/ ends with exactly one marker line: `VTP_OK <json>` or `VTP_FAIL <reason>`.
// We parse the last marker and never trust Blender's exit code (it exits 0 on Python errors).
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLENDER_SCRIPTS, CACHE_DIR } from './paths.ts';
import { loadSettings } from './settings.ts';
import { BLENDER_PLACES } from '../shared/blenderSetup.ts';
import { expandPath } from '../shared/toolsDetect.ts';

export interface BlenderInfo {
  path: string;
  version?: string;
}

function parseVersion(s: string): number[] {
  const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : [0, 0, 0];
}

function cmpVersion(a: number[], b: number[]) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function fromProgramFiles(): string | null {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean) as string[];
  const found: { exe: string; v: number[] }[] = [];
  for (const root of new Set(roots)) {
    const base = path.join(root, 'Blender Foundation');
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!/^Blender/i.test(d)) continue;
      const exe = path.join(base, d, 'blender.exe');
      if (fs.existsSync(exe)) found.push({ exe, v: parseVersion(d) });
    }
  }
  found.sort((a, b) => cmpVersion(b.v, a.v));
  return found[0]?.exe ?? null;
}

function fromPath(): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, 'blender' + ext);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** The other places people keep Blender (shared/blenderSetup.ts: macOS /Applications, Steam, Snap, Flatpak, an unzipped
 *  download, ~/Applications tarballs ...): a few file checks, only when Program Files and PATH found nothing. The
 *  "Set up AI creation" page saves the copy it picks in settings.blenderPath, so this is the fallback. */
function fromKnownPlaces(): string | null {
  const o = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const sep = o === 'win' ? '\\' : '/';
  for (const pl of BLENDER_PLACES[o]) {
    if (pl.source === 'store' || pl.source === 'dmg') continue;                       // not startable / not staying
    const p = expandPath(pl.path, { home: os.homedir(), vars: process.env, sep });
    if (!p) continue;
    let acc = [''];
    for (const seg of p.split(sep)) {
      if (!seg.includes('*')) { acc = acc.map((a) => (a === '' && seg === '' ? sep : a === '' ? seg : a.endsWith(sep) ? a + seg : a + sep + seg)); continue; }
      const re = new RegExp(`^${seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, o === 'win' ? 'i' : '');
      acc = acc.flatMap((a) => { try { return fs.readdirSync(/^[A-Za-z]:$/.test(a) ? a + sep : a).filter((n) => re.test(n)).sort((x, y) => y.localeCompare(x, 'en', { numeric: true })).map((n) => (a.endsWith(sep) ? a + n : a + sep + n)); } catch { return []; } });
    }
    const hit = acc.find((x) => x && fs.existsSync(x));
    if (hit) return hit;
  }
  return null;
}

// The same search off the event loop (GET /api/status asks every 10-15 s while the studio is open).
const existsAsync = (p: string) => fsp.access(p).then(() => true, () => false);
async function fromProgramFilesAsync(): Promise<string | null> {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean) as string[];
  const found: { exe: string; v: number[] }[] = [];
  for (const root of new Set(roots)) {
    const base = path.join(root, 'Blender Foundation');
    let dirs: string[] = [];
    try { dirs = await fsp.readdir(base); } catch { continue; }
    for (const d of dirs) {
      if (!/^Blender/i.test(d)) continue;
      const exe = path.join(base, d, 'blender.exe');
      if (await existsAsync(exe)) found.push({ exe, v: parseVersion(d) });
    }
  }
  found.sort((a, b) => cmpVersion(b.v, a.v));
  return found[0]?.exe ?? null;
}
async function fromPathAsync(): Promise<string | null> {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const cands = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap((dir) => exts.map((ext) => path.join(dir, 'blender' + ext)));
  const ok = await Promise.all(cands.map(existsAsync));
  return cands[ok.indexOf(true)] ?? null;
}

// Where Blender is, remembered: found = 5 minutes, not found = 15 s (someone may be installing it right now). A new
// settings.blenderPath or VTP_BLENDER looks again at once. (The search is a folder listing of Program Files plus a file
// check per PATH folder: GET /api/status ran it every 10-15 s, on the thread that relays tracking frames.)
// A remembered exe is looked at again (one file check) when it is 15 s old or older, and before every Blender start
// (runBlender): Blender uninstalled, or upgraded into a new folder with the old one removed, while the helper runs is
// searched for again instead of failing every job with "spawn ENOENT" for up to 5 minutes.
const FOUND_MS = 5 * 60_000, MISSING_MS = 15_000, RECHECK_MS = 15_000;
let found: { key: string; at: number; exe: string | null; checkedAt: number } | null = null;
let searching: { key: string; p: Promise<string | null> } | null = null;
const searchKey = () => `${loadSettings().blenderPath?.trim() ?? ''}\n${process.env.VTP_BLENDER ?? ''}`;
const remembered = (key: string) => !!found && found.key === key && Date.now() - found.at < (found.exe ? FOUND_MS : MISSING_MS);
/** The remembered exe that is due a look (null = nothing to check). */
const dueCheck = (recheckMs: number) => (found?.exe && Date.now() - found.checkedAt >= recheckMs ? found : null);

/** settings.blenderPath → env VTP_BLENDER → newest %ProgramFiles%\Blender Foundation\Blender* → PATH → the other known places.
 *  (`recheckMs`: tests; how old a remembered answer may be before its exe is looked at again.) */
export function findBlender(recheckMs = RECHECK_MS): string | null {
  const key = searchKey();
  if (remembered(key)) {
    const f = dueCheck(recheckMs);
    if (!f) return found!.exe;
    if (fs.existsSync(f.exe!)) { f.checkedAt = Date.now(); return f.exe; }
    found = null;                                                      // gone: search again
  }
  const configured = loadSettings().blenderPath?.trim();
  const env = process.env.VTP_BLENDER;
  const exe = configured && fs.existsSync(configured) ? configured : env && fs.existsSync(env) ? env : fromProgramFiles() ?? fromPath() ?? fromKnownPlaces();
  found = { key, at: Date.now(), exe, checkedAt: Date.now() };
  return exe;
}
/** findBlender without blocking the event loop (same answer, same memory). */
export async function findBlenderAsync(recheckMs = RECHECK_MS): Promise<string | null> {
  const key = searchKey();
  if (remembered(key)) {
    const f = dueCheck(recheckMs);
    if (!f) return found!.exe;
    if (await existsAsync(f.exe!)) { f.checkedAt = Date.now(); return f.exe; }
    if (found === f) found = null;                                     // gone: search again
  }
  if (searching?.key === key) return searching.p;
  const configured = loadSettings().blenderPath?.trim();
  const env = process.env.VTP_BLENDER;
  const p = (async () => {
    if (configured && await existsAsync(configured)) return configured;
    if (env && await existsAsync(env)) return env;
    return (await fromProgramFilesAsync()) ?? (await fromPathAsync()) ?? fromKnownPlaces();
  })();
  searching = { key, p };
  try {
    const exe = await p;
    found = { key, at: Date.now(), exe, checkedAt: Date.now() };
    return exe;
  } finally { if (searching?.p === p) searching = null; }
}
/** Forget where Blender is (a start found no exe there; tests). A changed settings.blenderPath / VTP_BLENDER is a new
 *  search anyway (the search key). */
export function forgetBlender() { found = null; }

const versionCache = new Map<string, string>();

export async function blenderInfo(): Promise<BlenderInfo | null> {
  const exe = await findBlenderAsync();
  if (!exe) return null;
  if (!versionCache.has(exe)) {
    const version = await new Promise<string>((resolve) => {
      execFile(exe, ['--version'], { timeout: 20000, windowsHide: true }, (_err, stdout) => {
        const m = String(stdout ?? '').match(/Blender\s+(\d+\.\d+(?:\.\d+)?)/);
        resolve(m ? m[1] : parseVersion(exe).join('.'));
      });
    });
    versionCache.set(exe, version);
  }
  return { path: exe, version: versionCache.get(exe) };
}

export interface RunOptions {
  timeoutMs?: number;
  onLine?: (line: string) => void;
  env?: Record<string, string>;
  /** Lowest CPU priority (like tools/blender_low.cmd), so Blender never starves the live studio's tracking. */
  lowPriority?: boolean;
}

export interface RunResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  /** Last ~20KB of stdout+stderr. */
  stdout: string;
  /** Python traceback printed by run_user.py (if any). */
  traceback?: string;
  exitCode: number | null;
  timedOut: boolean;
}

// A few Blender processes at once is plenty; more just thrashes the GPU/CPU.
const MAX_CONCURRENT = 3;
let running = 0;
const waiters: (() => void)[] = [];
async function acquire() {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
  running++;
}
function release() {
  running--;
  waiters.shift()?.();
}

const TAIL = 20 * 1024;

/**
 * Run `blender -b --factory-startup --python <script> -- <params>`.
 * `script` is a filename in blender/ or an absolute path. `params` objects are passed as a temp JSON file.
 */
export async function runBlender<T = unknown>(
  script: string,
  params: Record<string, unknown> | string[] = {},
  opts: RunOptions = {},
): Promise<RunResult<T>> {
  const exe = findBlender(0);                                          // (a remembered exe is looked at: a job start is rare)
  if (!exe) {
    return { ok: false, error: 'Blender not found. Install Blender or set its path in Settings.', stdout: '', exitCode: null, timedOut: false };
  }
  const scriptPath = path.isAbsolute(script) ? script : path.join(BLENDER_SCRIPTS, script);
  let args: string[];
  let tmpFile: string | null = null;
  if (Array.isArray(params)) args = params;
  else {
    const dir = path.join(CACHE_DIR, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    tmpFile = path.join(dir, `params-${crypto.randomUUID()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(params));
    args = [tmpFile];
  }

  await acquire();
  try {
    return await new Promise<RunResult<T>>((resolve) => {
      // --disable-autoexec: a .blend from an import never runs the Python it carries (driver / startup scripts)
      const child = spawn(exe, ['-b', '--factory-startup', '--disable-autoexec', '--python', scriptPath, '--', ...args], {
        env: { ...process.env, ...opts.env },
        windowsHide: true,
      });
      if (opts.lowPriority && child.pid) {
        try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed: normal priority */ }
      }
      let tail = '';
      let buf = '';
      let marker: string | null = null;
      let tb: string[] | null = null;
      let traceback: string | undefined;
      let timedOut = false;

      const onText = (text: string) => {
        tail = (tail + text).slice(-TAIL);
        buf += text;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line.startsWith('VTP_OK ') || line === 'VTP_OK' || line.startsWith('VTP_FAIL')) marker = line;
          if (line === 'VTP_TRACEBACK_BEGIN') tb = [];
          else if (line === 'VTP_TRACEBACK_END' && tb) {
            traceback = tb.join('\n');
            tb = null;
          } else if (tb) tb.push(line);
          opts.onLine?.(line);
        }
      };
      child.stdout.setEncoding('utf8').on('data', onText);
      child.stderr.setEncoding('utf8').on('data', onText);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs ?? 300_000);

      const finish = (exitCode: number | null, spawnError?: Error) => {
        clearTimeout(timer);
        if (buf) onText('\n');
        if (tmpFile) fs.rm(tmpFile, { force: true }, () => {});
        const m = marker as string | null;
        if (spawnError && (spawnError as NodeJS.ErrnoException).code === 'ENOENT') forgetBlender();   // gone since: the next job searches
        if (spawnError) return resolve({ ok: false, error: `Failed to start Blender: ${spawnError.message}`, stdout: tail, exitCode, timedOut });
        if (timedOut) return resolve({ ok: false, error: `Blender timed out after ${Math.round((opts.timeoutMs ?? 300_000) / 1000)}s`, stdout: tail, traceback, exitCode, timedOut });
        if (m?.startsWith('VTP_OK')) {
          let result: T | undefined;
          try {
            result = JSON.parse(m.slice(7) || '{}');
          } catch {
            result = undefined;
          }
          return resolve({ ok: true, result, stdout: tail, exitCode, timedOut });
        }
        const error = m ? m.slice(8).trim() || 'Blender script failed' : `Blender exited (code ${exitCode}) without a VTP_OK/VTP_FAIL marker`;
        resolve({ ok: false, error, stdout: tail, traceback, exitCode, timedOut });
      };
      child.on('error', (e) => finish(null, e));
      child.on('close', (code) => finish(code));
    });
  } finally {
    release();
  }
}
