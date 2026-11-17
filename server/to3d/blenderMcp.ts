// Pro2D → 3D: the Blender MCP on THIS computer (lane to3d). What shared/to3d/blenderMcp.ts knows, applied:
//   * add-ons read from Blender's prefs ON DISK (no Blender started just to look): <user>/scripts/addons/blender_mcp.py,
//     <user>/extensions/<repo>/mcp/blender_manifest.toml, and whether userpref.blend lists the module (= enabled);
//   * the port: two framed probes, 2 s each (community ping, then the official no-op);
//   * the AI apps' configs: which Blender MCP each starts, duplicates on one port;
//   * install (with consent): community = the helper's pinned uvx runs `install-addon` into this Blender's add-on folder,
//     then this Blender (the user's prefs, headless, low priority) enables it and saves its prefs; official = the release
//     zip (sha256-pinned) installed as an extension the same way, and its .mcpb handed to Claude Desktop;
//   * open: the user's Blender, VISIBLE, below-normal priority, never while live (server/to3d/live.ts decides);
//   * tools/list on the registered server (names for the pack), only when asked (job start / Check again).
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import {
  COMMUNITY, COMMUNITY_PROBE, MCP_PORT, OFFICIAL, OFFICIAL_PROBE, PROBE_TIMEOUT_MS, addonEnabledInPrefs, blenderEntries, blenderUserDir,
  communityEntry, duplicatePorts, extensionModule, readProbeAnswer, type McpEntry, type McpKind, type ProbeAnswer,
} from '../../shared/to3d/blenderMcp.ts';
import { configTarget, type ConnectorId } from '../aiConnectors.ts';
import { getAddon, type AddonApp } from '../../shared/aiAddons.ts';
import { resolveLaunch, writeAddonEntry } from '../aiAddons.ts';
import { realRun } from './kit.ts';
import { acquireBlenderLock } from '../creator/blenderLock.ts';
import { liveNow } from './live.ts';
import { KIT_DIR } from './store.ts';

export type AppId = 'claude' | 'chatgpt';
export const APP_CONNECTOR: Record<AppId, ConnectorId> = { claude: 'claude-desktop', chatgpt: 'chatgpt-desktop' };
const APP_ADDON: Record<AppId, AddonApp> = { claude: 'claude-desktop', chatgpt: 'chatgpt-desktop' };
const toolOs = (): 'windows' | 'mac' | 'linux' => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux');

// ---------------------------------------------------------------- add-ons on disk
export interface AddonState { installed: boolean; enabled: boolean | null; where: string | null }
/**
 * The settings folder THIS Blender uses (scripts/addons, extensions, config/userpref.blend), the way Blender picks it:
 * BLENDER_USER_RESOURCES, then a portable install (<blender folder>/portable, Blender 4.2+), then the per-user folder for
 * its major.minor ("5.2.2" → ...\Blender\5.2). VTP_BLENDER_USER_DIR overrides (tests).
 */
export function blenderUserDirFor(version: string | null, exe: string | null = null, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): { dir: string | null; via: string } {
  if (env.VTP_BLENDER_USER_DIR) return { dir: env.VTP_BLENDER_USER_DIR, via: 'VTP_BLENDER_USER_DIR' };
  if (env.BLENDER_USER_RESOURCES) return { dir: env.BLENDER_USER_RESOURCES, via: 'BLENDER_USER_RESOURCES' };
  if (exe) { const p = path.join(path.dirname(exe), 'portable'); try { if (fs.statSync(p).isDirectory()) return { dir: p, via: 'portable Blender' }; } catch { /* not portable */ } }
  if (!version) return { dir: null, via: 'no Blender version' };
  return { dir: blenderUserDir(toolOs(), version, { APPDATA: env.APPDATA, HOME: home, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME }), via: `Blender ${version.split('.').slice(0, 2).join('.')} settings` };
}

/** A community Blender MCP add-on installed under another file name (Blender's "Install from Disk" keeps the file's
 *  name, e.g. addon.py from the blender-mcp project): its bl_info names it. → [file, module] */
function legacyCommunityAddon(addons: string): [string, string] | null {
  let names: string[] = [];
  try { names = fs.readdirSync(addons); } catch { return null; }
  for (const n of names) {
    const f = n.endsWith('.py') ? path.join(addons, n) : path.join(addons, n, '__init__.py');
    let head = '';
    try { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(8192); head = b.subarray(0, fs.readSync(fd, b, 0, 8192, 0)).toString('utf8'); } finally { fs.closeSync(fd); } } catch { continue; }
    if (/bl_info\s*=/.test(head) && /["']name["']\s*:\s*["'][^"']*(blender[\s_-]*mcp|mcp\s+for\s+blender)/i.test(head)) return [f, n.replace(/\.py$/, '')];
  }
  return null;
}

export function addonsOnDisk(version: string | null, env: NodeJS.ProcessEnv = process.env, home = os.homedir(), exe: string | null = null): Record<McpKind, AddonState> & { dir: string | null; via: string } {
  const none = { installed: false, enabled: null, where: null };
  if (!version) return { community: none, official: none, dir: null, via: 'no Blender' };
  const { dir, via } = blenderUserDirFor(version, exe, env, home);
  if (!dir) return { community: none, official: none, dir: null, via };
  let prefs: Uint8Array | null = null;
  try { prefs = fs.readFileSync(path.join(dir, 'config', 'userpref.blend')); } catch { /* no saved prefs yet */ }
  const addonsDir = path.join(dir, 'scripts', 'addons');
  let cModule = COMMUNITY.module;
  let cFile = [path.join(addonsDir, COMMUNITY.addonFile), path.join(addonsDir, COMMUNITY.module, '__init__.py')].find((p) => fs.existsSync(p)) ?? null;
  if (!cFile) { const l = legacyCommunityAddon(addonsDir); if (l) [cFile, cModule] = l; }
  let oDir: string | null = null, oRepo = 'user_default';
  try {
    for (const repo of fs.readdirSync(path.join(dir, 'extensions'))) {
      const m = path.join(dir, 'extensions', repo, OFFICIAL.extensionId, 'blender_manifest.toml');
      if (fs.existsSync(m) && /maintainer\s*=\s*"Blender Lab"/.test(fs.readFileSync(m, 'utf8'))) { oDir = path.dirname(m); oRepo = repo; break; }
    }
  } catch { /* no extensions */ }
  return {
    community: { installed: !!cFile, enabled: cFile ? addonEnabledInPrefs(prefs, cModule) : null, where: cFile },
    official: { installed: !!oDir, enabled: oDir ? addonEnabledInPrefs(prefs, extensionModule(OFFICIAL.extensionId, oRepo)) : null, where: oDir },
    dir, via,
  };
}

// ---------------------------------------------------------------- the port
function oneProbe(kind: McpKind, port: number, host: string, timeoutMs: number): Promise<ProbeAnswer> {
  return new Promise((resolve) => {
    let got = '', done = false;
    const s = net.connect({ port, host });
    const end = (a: ProbeAnswer) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve(a); };
    const t = setTimeout(() => end(got ? readProbeAnswer(kind, got) : null), timeoutMs);
    s.on('connect', () => s.write(kind === 'community' ? COMMUNITY_PROBE : OFFICIAL_PROBE));
    s.on('data', (b) => {
      got += b.toString('utf8');
      const a = readProbeAnswer(kind, got);
      if (a === kind || (kind === 'official' && got.includes('\0'))) end(a);
      else if (kind === 'community') { try { JSON.parse(got); end(a); } catch { /* more to come */ } }
    });
    s.on('error', () => end(null));
    s.on('close', () => end(got ? readProbeAnswer(kind, got) : null));
  });
}

/** What answers on the Blender MCP port: 'community' | 'official' | 'other' (listening, neither) | null (nothing). */
export async function probePort(port = Number(process.env.VTP_TO3D_MCP_PORT) || MCP_PORT, host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS): Promise<McpKind | 'other' | null> {
  const listening = await new Promise<boolean>((res) => { const s = net.connect({ port, host }); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); setTimeout(() => { s.destroy(); res(false); }, timeoutMs); });
  if (!listening) return null;
  if ((await oneProbe('community', port, host, timeoutMs)) === 'community') return 'community';
  if ((await oneProbe('official', port, host, timeoutMs)) === 'official') return 'official';
  return 'other';
}

// ---------------------------------------------------------------- the AI apps' configs
/** The servers an app starts (names + entries), JSON or Codex TOML; {} when there is no file. */
export function appServers(app: AppId, e = { env: process.env, platform: process.platform, home: os.homedir() }): Record<string, McpEntry> {
  const t = configTarget(APP_CONNECTOR[app], e);
  if (!t.path || !fs.existsSync(t.path)) return {};
  const text = fs.readFileSync(t.path, 'utf8');
  if (t.format === 'json') { try { return (JSON.parse(text)?.[t.key ?? 'mcpServers'] ?? {}) as Record<string, McpEntry>; } catch { return {}; } }
  return parseTomlServers(text);
}

/** The [mcp_servers.<name>] tables of a Codex config.toml: command, args, env (enough to tell a Blender MCP). */
export function parseTomlServers(text: string): Record<string, McpEntry> {
  const out: Record<string, McpEntry> = {};
  let cur: McpEntry | null = null, inEnv = false;
  const str = (v: string) => { try { return JSON.parse(v.replace(/^'(.*)'$/, (_m, s: string) => JSON.stringify(s))); } catch { return v; } };
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const h = /^\[\s*mcp_servers\s*\.\s*("([^"]+)"|'([^']+)'|[A-Za-z0-9_-]+)\s*(\.\s*env\s*)?\]$/.exec(l);
    if (h) { const n = h[2] ?? h[3] ?? h[1]; cur = out[n] ??= {}; inEnv = !!h[4]; continue; }
    if (l.startsWith('[')) { cur = null; continue; }
    if (!cur) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(l);
    if (!kv) continue;
    if (inEnv) (cur.env ??= {})[kv[1]] = String(str(kv[2]));
    else if (kv[1] === 'command') cur.command = String(str(kv[2]));
    else if (kv[1] === 'args') { try { cur.args = JSON.parse(kv[2].replace(/'([^']*)'/g, (_m, s: string) => JSON.stringify(s))); } catch { cur.args = []; } }
    else if (kv[1] === 'url') cur.url = String(str(kv[2]));
  }
  return out;
}

/** Claude Desktop's installed extensions (.mcpb) with Blender in the name (the official server's bundle). */
export function claudeExtensions(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const dirs = process.platform === 'win32' ? [path.join(env.APPDATA ?? '', 'Claude', 'Claude Extensions')] : [path.join(home, 'Library', 'Application Support', 'Claude', 'Claude Extensions')];
  const out: string[] = [];
  for (const d of dirs) { try { for (const f of fs.readdirSync(d)) if (/blender/i.test(f)) out.push(f); } catch { /* none */ } }
  return out;
}

export function registered(app: AppId): { kinds: McpKind[]; duplicate: boolean; ours: boolean; names: string[] } {
  const servers = appServers(app);
  const list = blenderEntries(servers);
  const kinds = [...new Set(list.map((x) => x.kind))];
  if (app === 'claude' && claudeExtensions().length && !kinds.includes('official')) kinds.push('official');
  // ours = the entry the add-on catalog's writer tagged (env VTP_ADDON = mcp-for-blender)
  const ours = list.some((x) => servers[x.name]?.env?.VTP_ADDON === COMMUNITY.id);
  return { kinds, duplicate: duplicatePorts(list), ours, names: list.map((x) => x.name) };
}

/**
 * Add the community Blender MCP to an app (only after the user's tick), through the add-on catalog's own writer
 * (server/aiAddons.ts writeAddonEntry): the catalog's pinned launch with the helper's absolute uvx, our entry tagged
 * VTP_ADDON, a backup first, every other server kept. A Blender MCP the user added themselves is never changed or
 * removed: two on one port is reported (readiness: "Keep just one"), and only OUR entry can be taken out.
 */
export function registerCommunity(app: AppId, uvx: string, e = { env: process.env, platform: process.platform, home: os.homedir(), now: Date.now }): { file: string | null; backup: string | null; action: string; note?: string } {
  const entry = getAddon(COMMUNITY.id)!;
  const w = writeAddonEntry(APP_ADDON[app], entry, resolveLaunch(entry, { uvx }), e);
  if (w.action === 'error') throw new Error(w.note ?? 'This AI app has no settings file we can add the Blender MCP to.');
  return { file: w.configPath, backup: w.backup, action: w.action, note: w.note };
}

/** Take OUR Blender MCP entry out of an app again (the "Keep just one" fix when the user also has their own). */
export function unregisterOurs(app: AppId, e = { env: process.env, platform: process.platform, home: os.homedir(), now: Date.now }): { action: string; note?: string } {
  const w = writeAddonEntry(APP_ADDON[app], getAddon(COMMUNITY.id)!, null, e);
  return { action: w.action, note: w.note };
}

// ---------------------------------------------------------------- install (consent given by the route)
// The route refuses while live and while a Blender window is open (that window would write its own preferences back
// when it closes, undoing the add-on switch). The headless Blender here runs inside the Blender lock (VTP_BLENDER_LOCK,
// one headless Blender at a time on this PC) at IDLE priority, like the pipeline's own Blender runs.

export type WindowState = 'open' | 'closed' | 'unknown';
const PROBE_DONE = 'VTP_PROBE_DONE';
type ProbeExec = (cmd: string, args: string[], cb: (err: Error | null, stdout: string) => void) => void;
const realExec: ProbeExec = (cmd, args, cb) => { execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (e, out) => cb(e, String(out ?? ''))); };

/** Is a Blender WINDOW open (a blender process started without -b / --background)? Headless runs don't count. The probe
 *  prints an end marker: a failed, empty or cut-off probe is 'unknown', and every caller treats 'unknown' as open. */
export function blenderWindowState(exec: ProbeExec = installDeps.exec): Promise<WindowState> {
  if (process.env.VTP_TO3D_FAKE_BLENDER_WINDOW) return Promise.resolve(process.env.VTP_TO3D_FAKE_BLENDER_WINDOW === '1' ? 'open' : 'closed');   // tests
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const cmd = win ? 'powershell.exe' : 'sh';
    const args = win
      ? ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter "Name='blender.exe'" | ForEach-Object { if ($_.CommandLine) { $_.CommandLine } else { 'blender.exe' } }; '${PROBE_DONE}'`]
      : ['-c', `ps -axo command && echo ${PROBE_DONE}`];
    try {
      exec(cmd, args, (err, stdout) => {
        const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (err || !lines.includes(PROBE_DONE)) return resolve('unknown');
        const blender = lines.filter((l) => l !== PROBE_DONE && (win || /(^|\/)blender(\s|$)|Blender\.app\/Contents\/MacOS\/Blender/i.test(l)));
        resolve(blender.some((l) => /blender/i.test(l) && !/\s(-b|--background)(\s|$)/.test(` ${l} `) && !/blender-launcher|blender_mcp|mcp-for-blender/i.test(l)) ? 'open' : 'closed');
      });
    } catch { resolve('unknown'); }
  });
}
export const blenderWindowOpen = async () => (await blenderWindowState()) !== 'closed';

/** Why an install can't touch Blender's preferences right now (null = it can). Status 409 for the route. */
export class InstallRefused extends Error { status = 409; }
export const installDeps = {
  live: async (): Promise<boolean> => (await liveNow()).live,
  windowState: (): Promise<WindowState> => blenderWindowState(),
  exec: realExec,
  run: realRun,
  lock: () => acquireBlenderLock({ who: 'vtubepro-to3d', what: 'Blender MCP install', pollMs: 5000, timeoutMs: 3 * 60_000 }),
};
export async function prefsGuard(): Promise<void> {
  if (await installDeps.live()) throw new InstallRefused('Finish your stream first, or install it later.');
  const w = await installDeps.windowState();
  if (w === 'open') throw new InstallRefused('Close Blender first, then press this again (Blender saves its own settings when it closes and would switch the add-on off again).');
  if (w === 'unknown') throw new InstallRefused('We couldn\'t check whether Blender is open. Close Blender if it is, then press this again.');
}

/** A headless Blender that changes the user's preferences: checked again right before it starts (the download before
 *  it can take minutes: the user may have gone live or opened Blender meanwhile), the Blender lock, IDLE priority. */
async function prefsBlender(blender: string, args: string[], timeoutMs: number) {
  await prefsGuard();
  const release = await installDeps.lock();
  try {
    await prefsGuard();   // the lock may have waited too
    return await installDeps.run(blender, args, { timeoutMs, idle: true });
  } finally { release(); }
}
/** Community: install-addon into this Blender version's folder, then enable it in the user's prefs (headless, low). */
export async function installCommunity(blender: string, version: string, uvx: string): Promise<void> {
  const dir = blenderUserDirFor(version, blender).dir;   // the same folder the checklist reads (portable Blender too)
  if (!dir) throw new Error('Blender\'s settings folder was not found.');
  const addons = path.join(dir, 'scripts', 'addons');
  fs.mkdirSync(addons, { recursive: true });
  const env = { ...process.env, ...COMMUNITY.env };
  let r = await installDeps.run(uvx, [...COMMUNITY.launch.args, 'install-addon', '--addons-dir', addons], { env, timeoutMs: 10 * 60_000 });
  if (r.code !== 0 || !fs.existsSync(path.join(addons, COMMUNITY.addonFile))) throw new Error('The Blender add-on could not be installed: ' + r.out.trim().split('\n').slice(-1)[0]);
  r = await prefsBlender(blender, ['-b', '--python-expr', `import addon_utils, bpy; addon_utils.enable(${JSON.stringify(COMMUNITY.module)}, default_set=True, persistent=True); bpy.ops.wm.save_userpref(); print("TO3D_ADDON_ON")`], 120_000);
  if (!r.out.includes('TO3D_ADDON_ON')) throw new Error('The add-on is installed but Blender could not switch it on. Open Blender → Preferences → Add-ons → "MCP for Blender" and tick it.');
}

/** Official (advanced choice): the pinned release zip installed as an extension, enabled, prefs saved. */
export async function installOfficial(blender: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const dl = path.join(KIT_DIR, 'downloads');
  fs.mkdirSync(dl, { recursive: true });
  const zip = path.join(dl, path.basename(OFFICIAL.zipUrl));
  const r0 = await fetchFn(OFFICIAL.zipUrl, { redirect: 'follow' });
  if (!r0.ok) throw new Error(`The official add-on didn't download (${r0.status}).`);
  const buf = Buffer.from(await r0.arrayBuffer());
  if (crypto.createHash('sha256').update(buf).digest('hex') !== OFFICIAL.zipSha256) throw new Error('The official add-on download was damaged or changed; we did not install it.');
  fs.writeFileSync(zip, buf);
  const r = await prefsBlender(blender, ['-b', '--online-mode', '--python-expr',
    `import bpy; bpy.ops.extensions.package_install_files(filepath=${JSON.stringify(zip)}, repo="user_default", enable_on_install=True); bpy.ops.wm.save_userpref(); print("TO3D_ADDON_ON")`], 180_000);
  if (!r.out.includes('TO3D_ADDON_ON')) throw new Error('Blender could not install the official add-on: ' + r.out.trim().split('\n').slice(-1)[0]);
  return zip;
}

// ---------------------------------------------------------------- open the user's Blender (visible; never while live)
export function openBlender(exe: string, file: string | null, kind: McpKind): number | null {
  const args = [...(kind === 'official' ? ['--online-mode'] : []), ...(file && fs.existsSync(file) ? [file] : [])];
  const p = spawn(exe, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...(kind === 'community' ? COMMUNITY.env : {}) } });
  p.unref();
  try { if (p.pid) os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine */ }
  return p.pid ?? null;
}

// ---------------------------------------------------------------- tools/list on the registered server
/** Start the app's Blender MCP entry like the app does, list its tools, stop it. null when it doesn't answer in time. */
export function listServerTools(entry: McpEntry, timeoutMs = 60_000): Promise<string[] | null> {
  return new Promise((resolve) => {
    if (!entry.command) return resolve(null);
    const p = spawn(entry.command, entry.args ?? [], { env: { ...process.env, ...(entry.env ?? {}) }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '', done = false;
    const end = (v: string[] | null) => { if (done) return; done = true; clearTimeout(t); try { p.kill(); } catch { /* gone */ } resolve(v); };
    const t = setTimeout(() => end(null), timeoutMs);
    const send = (m: unknown) => { try { p.stdin.write(JSON.stringify(m) + '\n'); } catch { /* closed */ } };
    p.on('error', () => end(null));
    p.on('close', () => end(null));
    p.stdout.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: { id?: number; result?: { tools?: { name: string }[] } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
        if (m.id === 2) end((m.result?.tools ?? []).map((x) => x.name));
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vtube-pro-to3d-check', version: '1' } } });
  });
}

const TOOLS_CACHE = () => path.join(KIT_DIR, 'blender_mcp_tools.json');
export function cachedTools(): { kind: McpKind; tools: string[]; at: number } | null { try { return JSON.parse(fs.readFileSync(TOOLS_CACHE(), 'utf8')); } catch { return null; } }
export function saveTools(kind: McpKind, tools: string[]) { fs.mkdirSync(KIT_DIR, { recursive: true }); fs.writeFileSync(TOOLS_CACHE(), JSON.stringify({ kind, tools, at: Date.now() })); }
