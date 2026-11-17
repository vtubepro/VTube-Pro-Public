// Pro2D → 3D: find uv / uvx on THIS computer, wherever its installers put it, without a helper restart (lane to3dfix).
// Why: the checklist used to look ONLY in the 3D toolkit's own folder, so a uv the user (or VTube Pro's add-ons page)
// installed never counted, and the PATH the helper started with goes stale the moment an installer adds a folder.
// Every check (cheap: file stats, and on Windows one `reg query` per key, cached a few seconds) looks in order:
//   1. VTP_TO3D_UVX (developers / tests)       2. the 3D toolkit's own uv (<kit>/uv)
//   3. the uvx your AI app's Blender MCP entry starts (an absolute path in its settings)
//   4. PATH as Windows has it NOW (HKCU\Environment + HKLM\...\Session Manager\Environment, re-read every check)
//   5. PATH as the helper started with it      6. the folders the official installers use (astral installer
//      ~/.local/bin, UV_INSTALL_DIR, XDG_BIN_HOME, cargo, winget links + packages, Scoop, Chocolatey, pip, Homebrew, …)
// Every place is reported (found or not) for the drawer's "Where we looked" fold.
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { usableExe } from './kit.ts';

export interface Look { place: string; path: string; found: boolean }
export interface UvxFound { path: string | null; via: string | null; looked: Look[] }
export interface UvDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  kitDir: string;
  /** a real program file: regular, not tiny (symlinks followed: a dangling winget link is not a uv; kit.ts usableExe) */
  isFile: (f: string) => boolean;
  listDir: (d: string) => string[];
  /** Windows only: the user + machine PATH as stored now (null = couldn't read) */
  registryPath: () => Promise<string[] | null>;
  /** commands the AI apps' Blender MCP entries start (absolute or bare) */
  entryCommands: () => string[];
}

const listDirReal = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };

// ---------------------------------------------------------------- Windows: PATH as stored in the registry, right now
const USER_KEY = 'HKCU\\Environment';
const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
/** The Path value out of `reg query <key> /v Path` output (REG_SZ or REG_EXPAND_SZ). */
export function parseRegQuery(out: string): string | null {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}
/** %USERPROFILE%\.local\bin → C:\Users\x\.local\bin (case-insensitive names; unknown names stay as they are). */
export function expandWinVars(s: string, env: NodeJS.ProcessEnv): string {
  const low = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return s.replace(/%([^%;]+)%/g, (all, n: string) => low.get(n.toLowerCase()) ?? all);
}
export const splitPath = (s: string, platform: NodeJS.Platform) => s.split(platform === 'win32' ? ';' : ':').map((x) => x.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);

let regCache: { at: number; dirs: string[] | null } | null = null;
const REG_TTL_MS = 4000;
function regQuery(key: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const reg = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise((resolve) => {
    try {
      execFile(reg, ['query', key, '/v', 'Path'], { windowsHide: true, timeout: 3000 }, (err, stdout) => resolve(err && !stdout ? null : parseRegQuery(String(stdout ?? ''))));
    } catch { resolve(null); }
  });
}
export async function registryPathReal(env: NodeJS.ProcessEnv = process.env, fresh = false): Promise<string[] | null> {
  if (!fresh && regCache && Date.now() - regCache.at < REG_TTL_MS) return regCache.dirs;
  const [u, m] = await Promise.all([regQuery(USER_KEY, env), regQuery(MACHINE_KEY, env)]);
  const dirs = u === null && m === null ? null : mergeRegPaths(u, m, env);
  regCache = { at: Date.now(), dirs };
  return dirs;
}
/** The user's PATH first, then the machine's: what a program the user starts searches (user installers win). */
export function mergeRegPaths(user: string | null, machine: string | null, env: NodeJS.ProcessEnv): string[] {
  return [...splitPath(expandWinVars(user ?? '', env), 'win32'), ...splitPath(expandWinVars(machine ?? '', env), 'win32')];
}
/** "Check again": the next look reads the registry again. */
export function forgetRegistryPath() { regCache = null; }

// ---------------------------------------------------------------- the folders installers use
/** [place, folder] pairs where uv's installers put uv / uvx, for this OS (folders only; the file name is added later). */
export function knownUvDirs(d: Pick<UvDeps, 'platform' | 'env' | 'home' | 'listDir'>): [string, string][] {
  const { env, home } = d, win = d.platform === 'win32', path = pathFor(d.platform);
  const out: [string, string][] = [];
  if (env.UV_INSTALL_DIR) out.push(['uv\'s installer (UV_INSTALL_DIR)', env.UV_INSTALL_DIR]);
  if (env.XDG_BIN_HOME) out.push(['uv\'s installer (XDG_BIN_HOME)', env.XDG_BIN_HOME]);
  out.push(['uv\'s official installer', path.join(home, '.local', 'bin')]);
  out.push(['Cargo', path.join(env.CARGO_HOME || path.join(home, '.cargo'), 'bin')]);
  if (win) {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    out.push(['winget', path.join(local, 'Microsoft', 'WinGet', 'Links')]);
    const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    for (const p of d.listDir(pkgs).filter((n) => /^astral-sh\.uv_/i.test(n))) out.push(['winget', path.join(pkgs, p)]);
    const pf = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    out.push(['winget (all users)', path.join(pf, 'WinGet', 'Links')]);
    out.push(['Scoop', path.join(env.SCOOP || path.join(home, 'scoop'), 'shims')]);
    out.push(['Chocolatey', path.join(env.ChocolateyInstall || env.CHOCOLATEYINSTALL || path.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'chocolatey'), 'bin')]);
    for (const base of [path.join(roaming, 'Python'), path.join(local, 'Programs', 'Python')]) {
      for (const v of d.listDir(base).filter((n) => /^Python3\d+/i.test(n))) out.push(['pip (Python)', path.join(base, v, 'Scripts')]);
    }
  } else if (d.platform === 'darwin') {
    out.push(['Homebrew', '/opt/homebrew/bin'], ['Homebrew (Intel)', '/usr/local/bin'], ['MacPorts', '/opt/local/bin']);
  } else {
    out.push(['system', '/usr/local/bin'], ['system', '/usr/bin'], ['Homebrew', '/home/linuxbrew/.linuxbrew/bin'], ['Homebrew', path.join(home, '.linuxbrew', 'bin')], ['Snap', '/snap/bin']);
  }
  return out;
}

/** Windows paths on Windows, POSIX paths elsewhere (also when a test fakes another OS). */
const pathFor = (p: NodeJS.Platform) => (p === 'win32' ? nodePath.win32 : nodePath.posix);
// Windows: .exe only. A .cmd shim can't be started without a shell (Node 22.12+ refuses: EINVAL) and VTube Pro starts
// uvx without one, so a uvx.cmd is passed over and the search goes on to a real uvx.exe.
const exeNames = (name: 'uv' | 'uvx', platform: NodeJS.Platform) => (platform === 'win32' ? [`${name}.exe`] : [name]);
const isUvxCommand = (c: string) => /(^|[\\/])uvx(\.exe)?$/i.test(c.trim());

/** Find uvx (the program that starts the community Blender MCP). The first place that has it wins; every place is listed. */
export async function findUvx(d: UvDeps): Promise<UvxFound> {
  const path = pathFor(d.platform);
  const looked: Look[] = [];
  let hit: { path: string; via: string } | null = null;
  const seen = new Set<string>();
  const tryFile = (place: string, f: string) => {
    const key = d.platform === 'win32' ? f.toLowerCase() : f;
    if (seen.has(key)) return;
    seen.add(key);
    const found = d.isFile(f);
    looked.push({ place, path: f, found });
    if (found && !hit) hit = { path: f, via: place };
  };
  const tryDir = (place: string, dir: string) => {
    const names = exeNames('uvx', d.platform);
    const f = names.map((n) => path.join(dir, n)).find((x) => d.isFile(x));
    tryFile(place, f ?? path.join(dir, names[0]));
  };
  // the developer / test override is taken as given (as before: never second-guessed, never a download instead)
  if (d.env.VTP_TO3D_UVX) return { path: d.env.VTP_TO3D_UVX, via: 'VTP_TO3D_UVX (developer setting)', looked: [{ place: 'VTP_TO3D_UVX (developer setting)', path: d.env.VTP_TO3D_UVX, found: true }] };
  tryDir('VTube Pro\'s 3D toolkit', path.join(d.kitDir, 'uv'));
  for (const c of d.entryCommands()) if (isUvxCommand(c) && path.isAbsolute(c)) tryFile('your AI app\'s Blender MCP settings', c);
  if (d.platform === 'win32') {
    const reg = await d.registryPath();
    if (reg) for (const dir of reg) tryDir('PATH (Windows settings, now)', dir);
    else looked.push({ place: 'PATH (Windows settings, now)', path: 'could not be read', found: false });
  }
  for (const dir of splitPath(String(d.env.PATH ?? d.env.Path ?? ''), d.platform)) tryDir('PATH (when VTube Pro started)', dir);
  for (const [place, dir] of knownUvDirs(d)) tryDir(place, dir);
  const h = hit as { path: string; via: string } | null;
  return { path: h?.path ?? null, via: h?.via ?? null, looked };
}

export const realUvDeps = (kitDir: string, entryCommands: () => string[] = () => [], env: NodeJS.ProcessEnv = process.env, home = os.homedir()): UvDeps => ({
  platform: process.platform, env, home, kitDir, isFile: usableExe, listDir: listDirReal,
  // VTP_TO3D_FAKE_REG_PATH (tests): the PATH "Windows has now", as a REG_EXPAND_SZ value (%VARS% expanded)
  registryPath: () => (env.VTP_TO3D_FAKE_REG_PATH !== undefined ? Promise.resolve(splitPath(expandWinVars(env.VTP_TO3D_FAKE_REG_PATH, env), 'win32'))
    : process.platform === 'win32' ? registryPathReal(env) : Promise.resolve(null)), entryCommands,
});
