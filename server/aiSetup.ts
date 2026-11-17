// "Set up AI creation" (lane toolsetup, beta.12): one flow in the helper that gets a person from nothing to an AI app
// that can really build with VTube Pro: (1) Blender found, new enough, and saved so the Blender bridge uses it (or a
// guided install from the official source only), (2) the vtube-pro MCP server registered with the AI apps they have
// (preview of exactly what is written, backup first, merge, never clobber other servers, verify by starting it the way the
// app will), (3) a checklist with self-tests: a tiny headless Blender job and an MCP tools/list + status round trip.
//
//   GET  /api/ai-setup/status                       everything the checklist shows (local only: full paths)
//   POST /api/ai-setup/blender/detect               look again; when nothing usable is saved yet, save the best one
//   POST /api/ai-setup/blender/use {path}           use this Blender (checked with --version first), saved for the bridge
//   POST /api/ai-setup/blender/selftest             a tiny headless Blender job (low priority) through the real bridge
//   GET  /api/ai-setup/mcp/:app/preview             what "Add VTube Pro" would write: file, action, our entry, other servers kept
//   POST /api/ai-setup/mcp/:app/register {consent}  write it (backup first) + start the server from that file to verify
//   POST /api/ai-setup/mcp/:app/verify              start the server exactly as the app's file says, tools/list + status
//   GET  /api/ai-setup/mcp/:app/backups             our backups of that app's file
//   POST /api/ai-setup/mcp/:app/restore {name, consent}   put a backup back (the current file is backed up first)
//   POST /api/ai-setup/mcp/selftest                 the MCP server the helper would register: tools/list + status
// Installing Blender reuses the Tools list's consent flow (/api/tools/blender/plan + /install: official hosts, a visible
// terminal, single-use token, "I understand"); the page then polls /blender/detect until Blender shows up.
// Everything is LOCAL ONLY (server/localGuard.ts): another website gets 403. All I/O is injectable: the unit test
// (tools/ai_setup_unit.ts) runs against fake machines and temp folders, never the user's real apps or Blender.
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Router, type Response } from 'express';
import {
  BLENDER_PLACES, SOURCE_LABEL, STEAM_VDF, blenderCompat, linuxBlenderPlan, linuxFlavor, parseMdfind, parseOsRelease, parseRegUninstallKeys,
  parseRegValue, parseSteamLibraries, pickBlender, steamBlenderExe, type BlenderInstall, type BlenderSource, type LinuxFlavor, type LinuxPlan,
} from '../shared/blenderSetup.ts';
import { TOOL_CATALOG, getTool, type ToolOs } from '../shared/toolsCatalog.ts';
import { expandPath, parseOutput, toolOs } from '../shared/toolsDetect.ts';
import {
  CONNECTORS, SETUP_STAMP_RE, appInstalled, backupName, claudeCodeAddArgs, claudeCodeCli, configTarget, connectorById, manualSnippet, mergeDesktopConfig,
  readDesktopEntry, setupDesktop, type ConnectorId, type Env, type Launch, type TestResult,
} from './aiConnectors.ts';
import { detectTool, globPaths, realDeps, type ToolsDeps } from './toolsCatalog.ts';

/** The AI apps that start VTube Pro's MCP server on this computer (each has a settings file we can add it to). */
export const SETUP_APPS: readonly ConnectorId[] = CONNECTORS.filter((c) => c.kind === 'desktop').map((c) => c.id);

// ---------------------------------------------------------------- Blender: find every copy
interface Cand { path: string; source: BlenderSource }

/** Every place this computer may have Blender, in preference order (only ones that exist on disk). Pure I/O through `d`. */
export async function blenderCandidates(d: ToolsDeps, o: ToolOs): Promise<Cand[]> {
  const pe = { home: d.home, vars: d.env, sep: (o === 'win' ? '\\' : '/') as '\\' | '/', helperRoot: d.helperRoot };
  const out: Cand[] = [];
  const add = (p: string | null | undefined, source: BlenderSource) => { if (p && p.trim()) out.push({ path: p.trim(), source }); };
  add(d.settings().blenderPath, 'settings');
  add(d.env.VTP_BLENDER, 'env');
  const pathVar = d.env.PATH ?? d.env.Path ?? '';
  for (const dir of pathVar.split(o === 'win' ? ';' : ':')) if (dir.trim()) add(`${dir.trim().replace(/[\\/]+$/, '')}${o === 'win' ? '\\blender.exe' : '/blender'}`, 'path');
  for (const pl of BLENDER_PLACES[o]) {
    const p = expandPath(pl.path, pe);
    if (!p) continue;
    for (const x of p.includes('*') ? globPaths(d, o, p) : [p]) add(x, pl.source);
  }
  // Steam libraries on other drives
  const vdfs = STEAM_VDF[o].map((p) => expandPath(p, pe)).filter((p): p is string => !!p);
  if (o === 'win') {
    const r = await d.exec('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    const sp = r.code === 0 ? parseRegValue(r.out, 'SteamPath') : null;
    if (sp) vdfs.unshift(`${sp.replace(/\//g, '\\')}\\steamapps\\libraryfolders.vdf`);
  }
  for (const v of vdfs) { const t = d.readText(v); if (t) for (const lib of parseSteamLibraries(t)) add(steamBlenderExe(lib, o), 'steam'); }
  if (o === 'win') {
    // installs on another drive (D:\Blender ...): the uninstall entries' InstallLocation
    for (const root of ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall']) {
      const r = await d.exec('reg.exe', ['query', root, '/s', '/f', 'Blender', '/d']);
      if (r.code !== 0) continue;
      for (const key of parseRegUninstallKeys(r.out).slice(0, 6)) {
        const q = await d.exec('reg.exe', ['query', key, '/v', 'InstallLocation']);
        const loc = q.code === 0 ? parseRegValue(q.out, 'InstallLocation') : null;
        if (loc) add(`${loc.replace(/[\\/]+$/, '')}\\blender.exe`, 'registry');
      }
    }
  }
  if (o === 'mac') {
    const r = await d.exec('mdfind', ['kMDItemCFBundleIdentifier == "org.blenderfoundation.blender"']);
    if (r.code === 0) for (const p of parseMdfind(r.out).slice(0, 8)) add(p, p.startsWith('/Volumes/') ? 'dmg' : 'spotlight');
  }
  // one entry per path, in first-seen order; a copy found first through the saved path / VTP_BLENDER / PATH keeps that
  // place but takes the more telling source of a later hit ("Steam", "the Blender installer" ...)
  const seen = new Map<string, Cand>();
  const vague = new Set<BlenderSource>(['settings', 'env', 'path']);
  for (const c of out) {
    const k = o === 'win' ? c.path.toLowerCase() : c.path;
    const had = seen.get(k);
    if (!had) seen.set(k, { ...c });
    else if (vague.has(had.source) && !vague.has(c.source)) had.source = c.source;
  }
  return [...seen.values()].filter((c) => d.exists(c.path));
}

const STORE_NOTE = 'This is the Microsoft Store copy: Windows doesn’t let other programs start it. Install Blender from blender.org (or winget) as well: both can live side by side.';
const DMG_NOTE = 'Blender is still inside its disk image: drag Blender into Applications, eject the disk image, then press “Check again”.';

// `blender --version` answers, remembered for 5 minutes per machine (the page asks on every "Check again"; a working
// answer does not change while the file stays; a failed one is asked again next time)
const versionMemo = new WeakMap<ToolsDeps, Map<string, { at: number; p: ReturnType<typeof parseOutput> }>>();
async function blenderVersion(d: ToolsDeps, exe: string) {
  let m = versionMemo.get(d);
  if (!m) versionMemo.set(d, (m = new Map()));
  const hit = m.get(exe);
  if (hit && d.now() - hit.at < 5 * 60_000) return hit.p;
  const r = await d.exec(exe, ['--version']);
  const p = parseOutput('blender', r.out, r.code);
  if (p.ok) m.set(exe, { at: d.now(), p }); else m.delete(exe);
  return p;
}

/** Find, run `--version` on (at most 8) copies, and judge each one. */
export async function findBlenders(d: ToolsDeps, o: ToolOs): Promise<BlenderInstall[]> {
  const cands = (await blenderCandidates(d, o)).slice(0, 8);
  const out: BlenderInstall[] = [];
  for (const c of cands) {
    const p = await blenderVersion(d, c.path);
    const b: BlenderInstall = { path: c.path, source: c.source, runs: p.ok, compat: p.ok ? blenderCompat(p.version).level : 'unknown', ...(p.version ? { version: p.version } : {}) };
    if (c.source === 'store' && !p.ok) b.note = STORE_NOTE;
    else if (c.source === 'dmg') b.note = DMG_NOTE;
    else if (!p.ok) b.note = 'It is there, but it did not start (damaged, or blocked by security software). Reinstall it from blender.org.';
    else if (b.compat !== 'ok') b.note = blenderCompat(p.version).text;
    else if (c.source === 'flatpak') b.note = 'The Flatpak copy works for most jobs. If the self-test below fails, use the blender.org download instead.';
    out.push(b);
  }
  return out;
}

/** Is winget / Homebrew on this computer? (other methods: always) */
export function packageManagerHere(methodId: string, d: Pick<ToolsDeps, 'env' | 'exists'>): boolean {
  if (methodId === 'winget') return !!d.env.LOCALAPPDATA && d.exists(`${d.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\winget.exe`);
  if (methodId === 'brew') return d.exists('/opt/homebrew/bin/brew') || d.exists('/usr/local/bin/brew');
  return true;
}

export interface LinuxInfo { flavor: LinuxFlavor; plan: LinuxPlan }
export function linuxInfo(d: Pick<ToolsDeps, 'readText' | 'exists'>): LinuxInfo {
  const txt = d.readText('/etc/os-release') ?? d.readText('/usr/lib/os-release') ?? '';
  const flavor = linuxFlavor(parseOsRelease(txt), d.exists('/run/ostree-booted'));
  return { flavor, plan: linuxBlenderPlan(flavor) };
}

export interface BlenderReport {
  state: 'ready' | 'unsaved' | 'outdated' | 'blocked' | 'missing';
  /** One plain sentence for the checklist. */
  summary: string;
  chosen: BlenderInstall | null;
  saved: { path: string; ok: boolean } | null;
  installs: (BlenderInstall & { sourceLabel: string })[];
  linux?: LinuxInfo;
}

export function blenderReport(o: ToolOs, installs: BlenderInstall[], savedPath: string | undefined, linux?: LinuxInfo): BlenderReport {
  const win = o === 'win';
  const chosen = pickBlender(installs, savedPath, win);
  const same = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  const savedHit = savedPath ? installs.find((b) => same(b.path, savedPath)) : undefined;
  const saved = savedPath ? { path: savedPath, ok: !!chosen && same(chosen.path, savedPath) } : null;
  const withLabel = installs.map((b) => ({ ...b, sourceLabel: SOURCE_LABEL[b.source] }));
  const base = { chosen: chosen ? { ...chosen, sourceLabel: SOURCE_LABEL[chosen.source] } : null, saved, installs: withLabel, ...(linux ? { linux } : {}) };
  if (chosen && saved?.ok) return { ...base, state: 'ready', summary: `Blender ${chosen.version ?? ''} is ready (${SOURCE_LABEL[chosen.source]}).`.replace('  ', ' ') };
  if (chosen) return { ...base, state: 'unsaved', summary: `Found Blender ${chosen.version ?? ''} (${SOURCE_LABEL[chosen.source]}). Press “Use this Blender” so VTube Pro uses it.`.replace('  ', ' ') };
  if (installs.some((b) => b.runs && b.compat === 'old')) { const v = installs.find((b) => b.runs && b.compat === 'old')!; return { ...base, state: 'outdated', summary: blenderCompat(v.version).text }; }
  if (installs.length) return { ...base, state: 'blocked', summary: installs[0].note ?? 'Blender is here, but VTube Pro can’t start it.' };
  if (savedPath && !savedHit) return { ...base, state: 'missing', summary: 'The Blender saved in VTube Pro is gone (moved or uninstalled), and no other copy was found.' };
  return { ...base, state: 'missing', summary: 'Blender is not on this computer yet.' };
}

// ---------------------------------------------------------------- MCP: launch check, apps, backups
export interface LaunchCheck { command: string; args: string[]; env?: Record<string, string>; kind: 'bundled' | 'source'; ok: boolean; problem?: string; warning?: string }
/** Can an AI app start this launch? (files exist; not running from a temporary place that vanishes) */
export function checkLaunch(l: Launch, exists: (p: string) => boolean = fs.existsSync): LaunchCheck {
  const kind = l.args.some((a) => /[\\/]dist-helper[\\/]mcp\.mjs$/.test(a)) ? 'bundled' : 'source';
  const files = [l.command, ...l.args.filter((a) => /[\\/]/.test(a))];
  const missing = files.find((f) => path.isAbsolute(f) && !exists(f));
  const base: LaunchCheck = { command: l.command, args: l.args, ...(l.env ? { env: l.env } : {}), kind, ok: !missing };
  if (missing) base.problem = `A file the AI apps need is missing (${path.basename(missing)}). Check that the VTube Pro folder is complete, then try again.`;
  const all = [l.command, ...l.args].join(' ');
  if (/[\\/](AppTranslocation|Temp|tmp)[\\/]|[\\/]Downloads[\\/]|^\/Volumes\//i.test(all) && !/[\\/]vtp-b12[\\/]/.test(all))
    base.warning = 'VTube Pro is running from a temporary place (a download or disk image). Move the VTube Pro folder somewhere permanent first, or your AI apps lose it when that folder goes away.';
  return base;
}

export interface AppRow {
  id: ConnectorId; name: string; getUrl: string; getLabel: string;
  supported: boolean; why?: string;
  /** true = found on this computer, null = can't tell, false = not there */
  installed: boolean | null;
  registered: boolean;
  /** our entry starts the helper's current MCP server (false = an old path: re-add) */
  current: boolean;
  configPath: string | null;
  format: 'json' | 'toml';
  /** Claude Code with its CLI: we run `claude mcp add` (after our own backup) */
  viaCli: boolean;
}
const sameLaunch = (a: Launch | null, b: Launch) => !!a && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {});

export function appRows(e: Env, launch: Launch): AppRow[] {
  return SETUP_APPS.map((id) => {
    const c = connectorById(id)!;
    const t = configTarget(id, e);
    const plat = c.os[e.platform as 'win32' | 'darwin' | 'linux'] ?? true;
    let entry: Launch | null = null;
    try { entry = t.supported ? readDesktopEntry(id, e) : null; } catch { entry = null; }
    return {
      id, name: c.name, getUrl: c.getUrl, getLabel: c.getLabel, supported: plat && t.supported, ...(t.why ? { why: t.why } : {}),
      installed: plat && t.supported ? appInstalled(id, e) : false, registered: !!entry, current: sameLaunch(entry, launch),
      configPath: t.path, format: t.format, viaCli: id === 'claude-code' && !!claudeCodeCli(e),
    };
  });
}

export interface Preview {
  app: ConnectorId; name: string; configPath: string; format: 'json' | 'toml';
  exists: boolean; action: 'create' | 'add' | 'update' | 'same';
  entryText: string; others: string[];
  /** where the backup goes ("<file>.vtp-backup-<time>"), null when there is no file yet */
  backupPattern: string | null;
  /** Claude Code with its CLI: the exact command we run */
  cli?: string;
  /** the copy-paste fallback (the "I'll do it myself" box) */
  manual: string;
  /** set when we must NOT write this file (damaged...): the copy box is the way */
  refused?: string;
}

export function previewApp(id: ConnectorId, e: Env, launch: Launch): Preview {
  const c = connectorById(id);
  const t = configTarget(id, e);
  if (!c || !t.supported || !t.path) throw new Error(t.why ?? 'This app has no settings file we can add VTube Pro to.');
  const exists = fs.existsSync(t.path);
  const raw = exists ? fs.readFileSync(t.path, 'utf8') : '';
  const manual = manualSnippet(id, launch);
  const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const cliExe = id === 'claude-code' ? claudeCodeCli(e) : null;
  const base = { app: id, name: c.name, configPath: t.path, format: t.format, exists, backupPattern: exists ? `${t.path}.vtp-backup-<time>` : null, manual,
    ...(cliExe ? { cli: ['claude', ...claudeCodeAddArgs(launch)].map(q).join(' ') } : {}) };
  try {
    const m = mergeDesktopConfig(id, raw, launch, t);
    return { ...base, action: m.action, entryText: m.entryText, others: m.others };
  } catch (err) {
    return { ...base, action: exists ? 'update' : 'create', entryText: '', others: [], refused: (err as Error).message };
  }
}

export interface BackupInfo { name: string; at: string; bytes: number }
/** Our backups of one config file (newest first). */
export function listBackups(configPath: string): BackupInfo[] {
  const dir = path.dirname(configPath), base = path.basename(configPath);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.startsWith(`${base}.vtp-backup-`) && SETUP_STAMP_RE.test(n.slice(base.length + '.vtp-backup-'.length)))
    .map((n) => { const st = fs.statSync(path.join(dir, n)); return { name: n, at: st.mtime.toISOString(), bytes: st.size }; })
    .sort((a, b) => b.name.localeCompare(a.name));
}
/** Put one of OUR backups back (only a file named like ours, next to the config). The current file is backed up first. */
export function restoreBackup(configPath: string, name: string, now: number): { restored: string; backupOfCurrent: string | null } {
  const base = path.basename(configPath);
  if (path.basename(name) !== name || !name.startsWith(`${base}.vtp-backup-`) || !SETUP_STAMP_RE.test(name.slice(base.length + '.vtp-backup-'.length))) throw new Error('That is not one of VTube Pro’s backups of this file.');
  const src = path.join(path.dirname(configPath), name);
  if (!fs.existsSync(src)) throw new Error('That backup is gone.');
  let backupOfCurrent: string | null = null;
  if (fs.existsSync(configPath)) {
    backupOfCurrent = backupName(configPath, now);
    fs.copyFileSync(configPath, backupOfCurrent);
  }
  const tmp = `${configPath}.vtp_tmp`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, configPath);
  return { restored: name, backupOfCurrent };
}

// ---------------------------------------------------------------- MCP round trip (initialize, tools/list, status)
export interface RoundTrip extends TestResult { tools?: number; helper?: 'reached' | 'not-running' | 'unknown'; blender?: string | null }

/**
 * Start the MCP server exactly as an app would (command, args, env), say hello, list the tools, call the read-only
 * `status` tool (which asks the helper), stop it. Never calls a tool that writes.
 */
export function mcpRoundTrip(launch: Launch, spawn: Env['spawn'], timeoutMs = 30_000): Promise<RoundTrip> {
  const t0 = Date.now();
  for (const f of [launch.command, ...launch.args.filter((a) => /[\\/]/.test(a) && /\.(m?[jt]s|cjs)$/.test(a))]) {
    if (path.isAbsolute(f) && !fs.existsSync(f)) return Promise.resolve({ ok: false, title: 'The VTube Pro connection points at a missing file', detail: 'Usually VTube Pro moved or was updated.', fix: 'Press “Add VTube Pro” again: it writes the current location.' });
  }
  return new Promise<RoundTrip>((resolve) => {
    let child: ChildProcess;
    try { child = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...(launch.env ?? {}), VTP_MCP_CLIENT: 'VTube Pro setup check', VTP_NO_BROWSER: '1' } }); }
    catch (err) { resolve({ ok: false, title: 'We could not start the VTube Pro connection', detail: ((err as Error).message), fix: 'Restart VTube Pro, then try again.' }); return; }
    let buf = '', err = '', tools = 0, done = false;
    const finish = (r: RoundTrip) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve({ ...r, ms: Date.now() - t0 }); };
    const timer = setTimeout(() => finish({ ok: false, title: 'The VTube Pro connection did not answer in time', detail: (err.trim().split('\n').slice(-2).join(' ')).slice(0, 300) || undefined, fix: 'Close other heavy programs for a moment, then try again.' }), timeoutMs);
    const send = (m: unknown) => { try { child.stdin?.write(`${JSON.stringify(m)}\n`); } catch { /* closed */ } };
    child.on('error', (e) => finish({ ok: false, title: 'We could not start the VTube Pro connection', detail: (e.message), fix: 'Check that the VTube Pro folder is complete, then try again.' }));
    child.on('exit', (code) => finish({ ok: false, title: 'The VTube Pro connection stopped right away', detail: `exit code ${code}${err.trim() ? `: ${(err.trim().split('\n').slice(-1)[0]).slice(0, 200)}` : ''}`, fix: 'Check that the VTube Pro folder is complete, then try again.' }));
    child.stderr?.on('data', (b: Buffer) => { err = (err + b.toString('utf8')).slice(-4000); });
    child.stdout?.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && m.result) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
        else if (m.id === 1 && m.error) finish({ ok: false, title: 'The VTube Pro connection refused to start', detail: (String(m.error.message ?? '')), fix: 'Restart VTube Pro, then try again.' });
        else if (m.id === 2) {
          const names: string[] = (m.result?.tools ?? []).map((t: { name: string }) => t.name);
          tools = names.length;
          if (!names.includes('get_docs') || !names.includes('status')) { finish({ ok: false, title: 'The connection started but its tools are missing', tools, fix: 'Restart VTube Pro, then try again.' }); continue; }
          send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } });
        } else if (m.id === 3) {
          const text = String((m.result?.content ?? []).find((c: { type: string }) => c.type === 'text')?.text ?? m.error?.message ?? '');
          if (m.error || m.result?.isError) {
            const down = /not reachable|not running|ECONNREFUSED/i.test(text);
            finish({ ok: true, tools, helper: down ? 'not-running' : 'unknown', title: `VTube Pro’s ${tools} tools are ready`, detail: down ? 'The connection works. VTube Pro itself is not running right now: start VTube Pro before you ask your AI to build something.' : (text).slice(0, 200) });
            continue;
          }
          let bl: string | null = null;
          try { const j = JSON.parse(text); bl = j?.blender && j.blender.available !== false ? String(j.blender.version ?? 'found') : null; } catch { /* not JSON */ }
          finish({ ok: true, tools, helper: 'reached', blender: bl, title: `VTube Pro’s ${tools} tools are ready`, detail: `The connection reached VTube Pro${bl ? ` and sees Blender ${bl}` : ', but VTube Pro does not see Blender yet'}.` });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vtube-pro-setup-check', version: '1' } } });
  });
}

// ---------------------------------------------------------------- deps + routes
export interface BlenderRun { ok: boolean; result?: unknown; error?: string; traceback?: string; timedOut?: boolean }
export interface AiSetupDeps {
  tools: ToolsDeps;
  env: () => Env;
  launch: () => Launch;
  saveBlenderPath(p: string): void;
  /** runBlender (server/blender.ts) with the SAVED Blender: what every job uses */
  runBlender(script: string, params: Record<string, unknown>, opts: { timeoutMs: number; lowPriority: boolean }): Promise<BlenderRun>;
  tmpDir(): string;
}

export async function realAiSetupDeps(): Promise<AiSetupDeps> {
  const [{ realEnv }, { stdioLaunch }, settings, blender, paths] = await Promise.all([import('./aiConnectors.ts'), import('./aiconnect.ts'), import('./settings.ts'), import('./blender.ts'), import('./paths.ts')]);
  return {
    tools: realDeps(), env: realEnv, launch: stdioLaunch,
    saveBlenderPath: (p) => { settings.updateSettings({ blenderPath: p }); blender.forgetBlender(); },
    runBlender: (s, p, o) => blender.runBlender(s, p, o),
    tmpDir: () => path.join(paths.CACHE_DIR, 'tmp'),
  };
}

/** A file name that is Blender (the /use endpoint only ever runs Blender's own --version). */
export const BLENDER_EXE_RE = /^(blender(\.exe)?|Blender|org\.blender\.Blender)$/;

export function createAiSetupRoutes(getDeps: () => Promise<AiSetupDeps> = realAiSetupDeps): Router {
  const r = Router();
  let depsP: Promise<AiSetupDeps> | null = null;
  const deps = () => (depsP ??= getDeps());
  let busy = '';
  const bad = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) => { res.status(status).json({ error, ...extra }); };
  const app = (id: string): ConnectorId | null => ((SETUP_APPS as readonly string[]).includes(id) ? (id as ConnectorId) : null);

  async function blenderNow(d: AiSetupDeps): Promise<BlenderReport> {
    await d.tools.prepare?.();
    const o = toolOs(d.tools.platform)!;
    const installs = await findBlenders(d.tools, o);
    return blenderReport(o, installs, d.tools.settings().blenderPath?.trim() || undefined, o === 'linux' ? linuxInfo(d.tools) : undefined);
  }
  async function status(d: AiSetupDeps) {
    const o = toolOs(d.tools.platform);
    if (!o) throw new Error('unsupported platform');
    const launch = d.launch();
    const [blender, comfyF] = await Promise.all([blenderNow(d), detectTool(getTool('comfyui')!, o, d.tools).catch(() => ({ found: false }))]);
    const comfy = comfyF as { found: boolean; running?: boolean; version?: string };
    return {
      v: 1, os: o, arch: d.tools.arch, checkedAt: d.tools.now(),
      blender,
      // a package manager that is not on this computer is not offered (old Windows 10 without winget, a Mac without Homebrew)
      blenderInstall: { methods: getTool('blender')!.os[o].methods.filter((m) => packageManagerHere(m.id, d.tools)).map((m) => ({ id: m.id, kind: m.kind, label: m.label, runnable: m.kind === 'open-url' || !!m.runnable, ...(m.command ? { command: m.command } : {}), ...(m.url ? { url: m.url } : {}) })) },
      mcp: { launch: checkLaunch(launch), apps: appRows(d.env(), launch) },
      comfy: { found: !!comfy.found, running: !!comfy.running, ...(comfy.version ? { version: comfy.version } : {}) },
      catalogue: TOOL_CATALOG.length,
    };
  }

  r.get('/api/ai-setup/status', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await status(await deps())); } catch (e) { bad(res, 500, `Checking failed: ${(e as Error).message}`); }
  });

  r.post('/api/ai-setup/blender/detect', async (_req, res) => {
    const d = await deps();
    const rep = await blenderNow(d);
    let saved: string | null = null;
    // "after install, re-detect automatically and save the path": save the best copy when nothing usable is saved yet
    if (rep.chosen && !rep.saved?.ok) { d.saveBlenderPath(rep.chosen.path); saved = rep.chosen.path; }
    const out = saved ? await blenderNow(d) : rep;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ blender: out, saved });
  });

  r.post('/api/ai-setup/blender/use', async (req, res) => {
    const d = await deps();
    const p = String(req.body?.path ?? '').trim().replace(/^"(.*)"$/, '$1');
    if (!p || !path.isAbsolute(p)) return bad(res, 400, 'Give the full path to Blender (for example C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe).');
    // macOS: Blender.app (any name, e.g. "Blender 4.2.app") means its Contents/MacOS/Blender
    const exe = /\.app[\\/]?$/i.test(p) ? path.join(p.replace(/[\\/]$/, ''), 'Contents', 'MacOS', 'Blender') : p;
    if (!BLENDER_EXE_RE.test(path.basename(exe))) return bad(res, 400, 'That file is not Blender. Pick blender.exe (Windows), Blender.app (macOS) or the blender program (Linux).');
    if (!d.tools.exists(exe)) return bad(res, 404, 'There is no file there.');
    const r0 = await d.tools.exec(exe, ['--version']);
    const v = parseOutput('blender', r0.out, r0.code);
    if (!v.ok) return bad(res, 422, 'That program did not answer like Blender does. Check the path, or reinstall Blender from blender.org.');
    const c = blenderCompat(v.version);
    if (c.level === 'old') return bad(res, 422, c.text);
    d.saveBlenderPath(exe);
    res.json({ saved: exe, version: v.version, compat: c, blender: await blenderNow(d) });
  });

  r.post('/api/ai-setup/blender/selftest', async (_req, res) => {
    const d = await deps();
    if (busy) return bad(res, 429, 'A check is already running: give it a moment.');
    busy = 'blender';
    try {
      const rep = await blenderNow(d);
      if (!rep.chosen) return bad(res, 409, 'Find or install Blender first (step 1).');
      if (!rep.saved?.ok) d.saveBlenderPath(rep.chosen.path);
      const dir = d.tmpDir();
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `selftest-${Date.now()}.glb`);
      const t0 = d.tools.now();
      const run = await d.runBlender('selftest.py', { out }, { timeoutMs: 120_000, lowPriority: true });
      let bytes = 0;
      try { bytes = fs.statSync(out).size; } catch { /* not written */ }
      fs.rmSync(out, { force: true });
      const r0 = (run.result ?? {}) as { version?: string; objects?: number; gltf?: boolean };
      const ok = run.ok && bytes > 0;
      res.json(ok
        ? { ok, title: `Blender ${r0.version ?? ''} works with VTube Pro`.replace('  ', ' '), detail: `It ran headless, built a test model and saved it as glTF (${bytes} bytes) in ${((d.tools.now() - t0) / 1000).toFixed(1)} s.`, ms: d.tools.now() - t0 }
        : { ok: false, title: run.timedOut ? 'Blender took too long' : 'Blender did not finish the test job', detail: (String(run.error ?? (run.ok ? 'It did not save the test model.' : ''))).slice(0, 300),
          fix: rep.chosen.source === 'flatpak' ? 'The Flatpak copy may not reach VTube Pro’s folders: install the blender.org download (see step 1) and use that one.' : 'Reinstall Blender from blender.org (step 1), then run the check again.', ms: d.tools.now() - t0 });
    } finally { busy = ''; }
  });

  r.get('/api/ai-setup/mcp/:app/preview', async (req, res) => {
    const id = app(String(req.params.app));
    if (!id) return bad(res, 404, 'We don’t know that app.');
    const d = await deps();
    try { res.setHeader('Cache-Control', 'no-store'); res.json(previewApp(id, d.env(), d.launch())); } catch (e) { bad(res, 409, (e as Error).message); }
  });

  r.post('/api/ai-setup/mcp/:app/register', async (req, res) => {
    const id = app(String(req.params.app));
    if (!id) return bad(res, 404, 'We don’t know that app.');
    if (req.body?.consent !== true) return bad(res, 400, 'Tick “Yes, add VTube Pro” first.', { consent: true });
    const d = await deps();
    const e = d.env();
    const launch = d.launch();
    const lc = checkLaunch(launch);
    if (!lc.ok) return bad(res, 409, lc.problem ?? 'The VTube Pro connection is not complete.');
    let w;
    try { w = await setupDesktop(id, e, launch); } catch (err) { return bad(res, 409, (err as Error).message, { manual: manualSnippet(id, launch) }); }
    const back = readDesktopEntry(id, e);
    const verify: RoundTrip = back ? await mcpRoundTrip(back, e.spawn) : { ok: false, title: 'We wrote it, but could not read it back', fix: 'Use “Copy the settings” and add them yourself.' };
    res.json({ ok: !!back && verify.ok, configPath: w.configPath, backup: w.backup, via: w.via, verify, next: NEXT_STEP[id] ?? `Fully quit ${connectorById(id)!.name} and open it again.` });
  });

  r.post('/api/ai-setup/mcp/:app/verify', async (req, res) => {
    const id = app(String(req.params.app));
    if (!id) return bad(res, 404, 'We don’t know that app.');
    const d = await deps();
    const e = d.env();
    const entry = readDesktopEntry(id, e);
    if (!entry) return res.json({ ok: false, title: 'VTube Pro is not added to this app yet', fix: 'Press “Add VTube Pro” first.' } satisfies RoundTrip);
    res.json(await mcpRoundTrip(entry, e.spawn));
  });

  r.get('/api/ai-setup/mcp/:app/backups', async (req, res) => {
    const id = app(String(req.params.app));
    if (!id) return bad(res, 404, 'We don’t know that app.');
    const d = await deps();
    const t = configTarget(id, d.env());
    res.setHeader('Cache-Control', 'no-store');
    res.json({ configPath: t.path, backups: t.path ? listBackups(t.path) : [] });
  });

  r.post('/api/ai-setup/mcp/:app/restore', async (req, res) => {
    const id = app(String(req.params.app));
    if (!id) return bad(res, 404, 'We don’t know that app.');
    if (req.body?.consent !== true) return bad(res, 400, 'Confirm first.', { consent: true });
    const d = await deps();
    const t = configTarget(id, d.env());
    if (!t.path) return bad(res, 409, 'This app has no settings file.');
    try { res.json(restoreBackup(t.path, String(req.body?.name ?? ''), d.tools.now())); } catch (e) { bad(res, 400, (e as Error).message); }
  });

  r.post('/api/ai-setup/mcp/selftest', async (_req, res) => {
    const d = await deps();
    if (busy) return bad(res, 429, 'A check is already running: give it a moment.');
    busy = 'mcp';
    try {
      const launch = d.launch();
      const lc = checkLaunch(launch);
      if (!lc.ok) return res.json({ ok: false, title: 'The VTube Pro connection is not complete', fix: lc.problem } satisfies RoundTrip);
      res.json(await mcpRoundTrip(launch, d.env().spawn));
    } finally { busy = ''; }
  });
  return r;
}

/** What to do after "Add VTube Pro" (apps read their settings when they start). */
export const NEXT_STEP: Partial<Record<ConnectorId, string>> = {
  'claude-desktop': 'Fully quit Claude Desktop (also from the tray / menu bar) and open it again: VTube Pro is in its tools (the slider icon).',
  'claude-code': 'Start a new Claude Code session (or type /mcp in a running one): VTube Pro is in the list.',
  'chatgpt-desktop': 'Fully quit the ChatGPT app and open it again.',
  'codex-cli': 'Start a new Codex session: VTube Pro is in its tool list (/mcp). The ChatGPT desktop app sees it too.',
  'grok-build': 'Start a new Grok Build session: VTube Pro is in its tool list (/mcps).',
  'lm-studio': 'Nothing to restart: LM Studio loads it by itself. Chat with a model that can use tools.',
  cursor: 'Open Cursor Settings > MCP (or restart Cursor): VTube Pro is in the list. Switch it on if it shows as off.',
  vscode: 'In VS Code open Chat in Agent mode and press the tools button: VTube Pro is in the list (VS Code asks you to trust it once).',
  'gemini-cli': 'Start a new Gemini CLI session: type /mcp to see VTube Pro.',
  antigravity: 'In Antigravity open MCP Servers > Manage MCP Servers and press Refresh (or restart Antigravity): VTube Pro is in the list.',
};

export const aiSetupRoutes = createAiSetupRoutes();
