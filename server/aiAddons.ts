// "Make your AI better" (lane aiskills, beta.12): the helper half of shared/aiAddons.ts. It finds what is already on this
// computer (the AI apps' MCP entries, our skill folders, Blender / GIMP / uv / Photoshop, the GIMP plug-in, the Blender
// add-ons, the bridges on 127.0.0.1:9876 / 9877) and, ONLY after the user ticks "Yes", installs the pinned add-ons:
//   * our VTube Pro Creator skill: a folder per app (~/.claude/skills, ~/.agents/skills, ~/.grok/skills, ~/.gemini/skills)
//     with an ownership marker, and a .zip for Claude Desktop's Customize > Skills upload;
//   * MCP for Blender 2.1.9: the `blender` entry (absolute uvx path, telemetry off, safe mode on) in the chosen apps, and
//     (optionally) its Blender add-on via its own `install-addon` command;
//   * GIMP MCP at a reviewed commit: every file downloaded from GitHub and checked against its SHA-256, the GIMP plug-in
//     copied into GIMP's profile, `uv sync --frozen`, then the `gimp` entry in the chosen apps;
//   * Blender Lab's .mcpb (advanced): downloaded from its releases page, checked, opened with Claude Desktop.
// Every config write: the same preview the user saw, a backup first ("<file>.vtp-backup-<time>"), other servers kept,
// a server we did not write is never changed or removed (ours carry env VTP_ADDON=<id>). LOCAL ONLY (server/localGuard.ts).
//
//   GET  /api/ai-addons/status                       everything the panel shows (this PC only: paths included)
//   GET  /api/ai-addons/summary                      plain text for the AI (MCP tool ai_addons_status): no paths
//   POST /api/ai-addons/skill {consent, apps?}       install / update our skill for those apps
//   GET  /api/ai-addons/skill.zip                    the skill as a zip (Claude Desktop upload)
//   GET  /api/ai-addons/:id/preview?app=             what "Set it up" would write into that app
//   POST /api/ai-addons/:id/setup {consent, apps, blenderAddon?}   install an add-on and add it to those apps
//   POST /api/ai-addons/:id/remove {consent, apps}   take OUR entry out again (backup first)
//   POST /api/ai-addons/blender-lab-mcp/mcpb {consent}   fetch + verify Blender Lab's .mcpb and open it with Claude
//   POST /api/ai-addons/local-tools {baseUrl, model} can this local model call tools? (metadata, then a 1-turn probe)
// All I/O goes through AddonsDeps, so tools/ai_addons_unit.ts runs against temp folders and fakes only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { Router, type Request, type Response } from 'express';
import {
  ADDON_APPS, AI_ADDONS, APP_NAME, CREATOR_SKILL_NAME, FIRST_MESSAGE, GIMP_MCP_COMMIT, GIMP_MCP_PORT, BLENDER_MCP_PORT, LOCAL_MODEL_NOTE, MODEL_ADVICE,
  SKILL_DIRS, getAddon, recommendFor, type AddonApp, type AddonEntry, type Have,
} from '../shared/aiAddons.ts';
import { CREATOR_SKILL_VERSION, creatorSkillFiles } from '../shared/creatorSkill.ts';
import { getTool, type ToolOs } from '../shared/toolsCatalog.ts';
import { toolOs } from '../shared/toolsDetect.ts';
import { appInstalled, backupName, claudeCodeCli, configTarget, localBaseOk, readDesktopEntry, whichPath, type ConnectorId, type Env } from './aiConnectors.ts';
import { detectTool, type ToolsDeps } from './toolsCatalog.ts';

// ---------------------------------------------------------------- deps (injectable)
export interface RunResult { code: number | null; out: string }
export interface AddonsDeps {
  env(): Env;
  tools(): ToolsDeps;
  /** The helper's own data folder (downloaded add-ons + the skill zip live under <dataDir>/ai-addons). */
  dataDir(): string;
  houseRules(): string;
  /** Does something accept a TCP connection on 127.0.0.1:<port>? (connect only, nothing sent) */
  tcp(port: number): Promise<boolean>;
  /** GET an https URL, at most maxBytes; a redirect is followed only to https on one of `hosts` (the add-on's official ones). */
  download(url: string, maxBytes: number, hosts: readonly string[]): Promise<Buffer>;
  /** Run a program without a shell or a window; must time out. */
  run(file: string, args: string[], o: { cwd?: string; timeoutMs: number; env?: Record<string, string> }): Promise<RunResult>;
  /** Open a file with its default app (the .mcpb with Claude Desktop). */
  openWithDefaultApp(file: string): Promise<void>;
  now(): number;
}

// ---------------------------------------------------------------- reading the apps' MCP entries
/** The apps an add-on MCP can be written into (the desktop connectors). */
export const MCP_TARGETS: readonly AddonApp[] = ['claude-desktop', 'claude-code', 'chatgpt-desktop', 'codex-cli', 'grok-build', 'antigravity', 'gemini-cli', 'cursor', 'vscode', 'lm-studio'];
const sameFile = (a: AddonApp, b: AddonApp) => (a === 'chatgpt-desktop' && b === 'codex-cli') || (a === 'codex-cli' && b === 'chatgpt-desktop');

export interface ServerRef { name: string; line: string; addon?: string }
/** "<command file name without .exe/.cmd> <args...>": what detect.mcpEntry patterns are matched against. */
export function normLaunch(command: string, args: unknown[]): string {
  const base = path.basename(String(command).replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '');
  return [base, ...args.map((a) => String(a).replace(/\\/g, '/'))].join(' ');
}

const TOML_STR = /'([^']*)'|"((?:[^"\\]|\\.)*)"/g;
function tomlValue(raw: string): string { const m = /^\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/.exec(raw); if (!m) return ''; if (m[1] !== undefined) return m[1]; try { return JSON.parse(`"${m[2]}"`); } catch { return m[2]; } }
/** Every [mcp_servers.<name>] in a TOML text, with its command / args / url and our VTP_ADDON tag (enough TOML for MCP blocks). */
export function parseTomlServers(text: string): ServerRef[] {
  const out = new Map<string, { command: string; args: string[]; url: string; addon?: string }>();
  let cur: string | null = null, inEnv = false;
  for (const l of text.split(/\r?\n/)) {
    const h = /^\s*\[\s*mcp_servers\s*\.\s*("([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(\.\s*env\s*)?\]/.exec(l);
    if (h) { cur = h[2] ?? h[3] ?? h[4]; inEnv = !!h[5]; if (!out.has(cur)) out.set(cur, { command: '', args: [], url: '' }); continue; }
    if (/^\s*\[/.test(l)) { cur = null; continue; }
    if (!cur) continue;
    const s = out.get(cur)!;
    if (inEnv) { const v = /^\s*VTP_ADDON\s*=\s*(.*)$/.exec(l); if (v) s.addon = tomlValue(v[1]); continue; }
    const c = /^\s*command\s*=\s*(.*)$/.exec(l); if (c) s.command = tomlValue(c[1]);
    const u = /^\s*url\s*=\s*(.*)$/.exec(l); if (u) s.url = tomlValue(u[1]);
    const a = /^\s*args\s*=\s*\[(.*)\]\s*$/.exec(l);
    if (a) { s.args = []; for (const m of a[1].matchAll(TOML_STR)) s.args.push(m[1] !== undefined ? m[1] : (() => { try { return JSON.parse(`"${m[2]}"`); } catch { return m[2]; } })()); }
    const ie = /^\s*env\s*=\s*\{(.*)\}/.exec(l); if (ie) { const v = /VTP_ADDON\s*=\s*('([^']*)'|"([^"]*)")/.exec(ie[1]); if (v) s.addon = v[2] ?? v[3]; }
  }
  return [...out].map(([name, s]) => ({ name, line: s.command ? normLaunch(s.command, s.args) : s.url, ...(s.addon ? { addon: s.addon } : {}) }));
}
export function parseJsonServers(text: string, key: 'mcpServers' | 'servers'): ServerRef[] {
  if (!text.trim()) return [];
  let j: any;
  try { j = JSON.parse(text); } catch { return []; }
  const s = j?.[key];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [];
  return Object.entries(s as Record<string, any>).map(([name, v]) => ({
    name, line: typeof v?.command === 'string' ? normLaunch(v.command, Array.isArray(v.args) ? v.args : []) : String(v?.url ?? v?.serverUrl ?? ''),
    ...(typeof v?.env?.VTP_ADDON === 'string' ? { addon: v.env.VTP_ADDON } : {}),
  }));
}
export function listServers(app: AddonApp, e: Pick<Env, 'env' | 'platform' | 'home'>): ServerRef[] {
  const t = configTarget(app as ConnectorId, e);
  if (!t.supported || !t.path) return [];
  let raw = '';
  try { raw = fs.readFileSync(t.path, 'utf8'); } catch { return []; }
  return t.format === 'json' ? parseJsonServers(raw, t.key ?? 'mcpServers') : parseTomlServers(raw);
}
/** The server in this app that IS this add-on (ours or the user's own), if any. */
export function findAddonIn(entry: AddonEntry, servers: ServerRef[]): ServerRef | null {
  if (!entry.detect?.mcpEntry) return null;
  const re = new RegExp(entry.detect.mcpEntry, 'i');
  return servers.find((s) => s.addon === entry.id) ?? servers.find((s) => re.test(s.line)) ?? null;
}

// ---------------------------------------------------------------- writing an add-on's entry (backup, merge, never clobber)
export interface AddonLaunch { command: string; args: string[]; env: Record<string, string> }
const TAG = (id: string) => `# Added by VTube Pro (add-on ${id}). Remove these lines to take it out.`;

/** The launch with absolute uv / uvx paths and the add-on's folder filled in, tagged VTP_ADDON=<id>. */
export function resolveLaunch(entry: AddonEntry, p: { uv?: string | null; uvx?: string | null; dir?: string }): AddonLaunch {
  const l = entry.mcp!.launch;
  const command = l.command === 'uvx' ? p.uvx : l.command === 'uv' ? p.uv : l.command;
  if (!command) throw new Error('uv is not installed yet. Press “Get uv” first (it is free), then try again.');
  return { command, args: l.args.map((a) => (a === '${dir}' ? p.dir ?? a : a)), env: { ...(l.env ?? {}), VTP_ADDON: entry.id } };
}

export function addonJsonEntry(app: AddonApp, l: AddonLaunch): Record<string, unknown> {
  return { ...(app === 'claude-code' || app === 'cursor' || app === 'vscode' ? { type: 'stdio' } : {}), command: l.command, args: l.args, env: l.env, ...(app === 'gemini-cli' ? { timeout: 600_000 } : {}) };
}
const tq = (s: string) => JSON.stringify(s);
export function addonTomlBlock(name: string, id: string, l: AddonLaunch): string {
  return [TAG(id), `[mcp_servers.${name}]`, `command = ${tq(l.command)}`, `args = [${l.args.map(tq).join(', ')}]`, '', `[mcp_servers.${name}.env]`,
    ...Object.entries({ ...l.env, VTP_ADDON: id }).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k)).map(([k, v]) => `${k} = ${tq(v)}`), ''].join('\n');
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Put / replace the [mcp_servers.<name>] block (and its .env table). Refuses when <name> is defined another way (dotted / inline). */
export function upsertTomlNamed(text: string, name: string, block: string | null): string {
  const OURS = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*["']?${esc(name)}["']?\\s*(\\.[^\\]]*)?\\]\\s*(#.*)?$`);
  const ANY = /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/;
  const out: string[] = [];
  let ours = false;
  for (const l of text.split(/\r?\n/)) {
    if (ANY.test(l)) ours = OURS.test(l);
    else if (!ours && new RegExp(`^\\s*mcp_servers\\s*\\.\\s*["']?${esc(name)}["']?\\s*[=.]`).test(l)) throw new Error(`This settings file already defines "${name}" in a way we can't safely change, so we left it alone.`);
    if (!ours && !/^# Added by VTube Pro \(add-on /.test(l)) out.push(l);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  if (!block) return out.length ? `${out.join('\n')}\n` : '';
  return (out.length ? `${out.join('\n')}\n\n` : '') + block;
}

/** A Windows (CRLF) settings file stays CRLF. */
export const keepEol = (raw: string, text: string) => (/\r\n/.test(raw) ? text.replace(/\r?\n/g, '\r\n') : text);

export interface AddonMerge { text: string; action: 'create' | 'add' | 'update' | 'same' | 'remove'; entryText: string; others: string[]; name: string }
/** The ONE merge for preview and write. `launch` null = remove our entry. */
export function mergeAddonEntry(app: AddonApp, raw: string, name: string, id: string, launch: AddonLaunch | null): AddonMerge {
  const t = { format: app === 'chatgpt-desktop' || app === 'codex-cli' || app === 'grok-build' ? 'toml' : 'json', key: app === 'vscode' ? 'servers' : 'mcpServers' } as const;
  const exists = raw.trim().length > 0;
  const appName = APP_NAME[app];
  if (t.format === 'json') {
    let cfg: Record<string, any> = {};
    try { cfg = exists ? JSON.parse(raw) : {}; } catch { throw new Error(`${appName}’s settings file is damaged (or has comments in it), so we left it alone. Use “Copy the settings” and add it yourself.`); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${appName}’s settings file has an unexpected shape, so we left it alone.`);
    const servers = cfg[t.key];
    if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) throw new Error(`${appName}’s settings file has an unexpected "${t.key}" section, so we left it alone.`);
    const before = servers?.[name];
    const others = Object.keys(servers ?? {}).filter((k) => k !== name);
    if (!launch) {
      if (!before) return { text: raw, action: 'same', entryText: '', others, name };
      const next = { ...cfg, [t.key]: { ...servers } };
      delete next[t.key][name];
      return { text: keepEol(raw, JSON.stringify(next, null, 2)), action: 'remove', entryText: '', others, name };
    }
    const entry = addonJsonEntry(app, launch);
    const next = { ...cfg, [t.key]: { ...(servers ?? {}), [name]: entry } };
    const action = !exists ? 'create' : before === undefined ? 'add' : JSON.stringify(before) === JSON.stringify(entry) ? 'same' : 'update';
    return { text: keepEol(raw, JSON.stringify(next, null, 2)), action, entryText: JSON.stringify({ [t.key]: { [name]: entry } }, null, 2), others, name };
  }
  const had = parseTomlServers(raw).some((s) => s.name === name);
  const others = parseTomlServers(raw).map((s) => s.name).filter((n) => n !== name);
  const block = launch ? addonTomlBlock(name, id, launch) : null;
  const lf = upsertTomlNamed(raw, name, block);
  const text = /\r\n/.test(raw) ? lf.replace(/\r?\n/g, '\r\n') : lf;
  const action = !launch ? (had ? 'remove' : 'same') : !exists ? 'create' : !had ? 'add' : lf.trim() === raw.replace(/\r\n/g, '\n').trim() ? 'same' : 'update';
  return { text, action, entryText: block ?? '', others, name };
}

/** Which server name to use in this app: the add-on's own name, or "<name>-vtp" when the user has an unrelated server called that. */
export function pickServerName(entry: AddonEntry, servers: ServerRef[]): string {
  const want = entry.mcp!.serverName;
  const same = servers.find((s) => s.name === want);
  return !same || same.addon === entry.id ? want : `${want}-vtp`;
}

function atomicWrite(file: string, text: string) { const tmp = `${file}.vtp_tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }

export interface AppWrite { app: AddonApp; name: string; configPath: string | null; backup: string | null; action: AddonMerge['action'] | 'skipped' | 'error'; note?: string }
/** Add (launch) or remove (null) this add-on's entry in one app. A server that already IS this add-on but isn't ours is left alone. */
export function writeAddonEntry(app: AddonApp, entry: AddonEntry, launch: AddonLaunch | null, e: Pick<Env, 'env' | 'platform' | 'home' | 'now'>): AppWrite {
  const t = configTarget(app as ConnectorId, e);
  if (!t.supported || !t.path) return { app, name: entry.mcp!.serverName, configPath: null, backup: null, action: 'error', note: t.why ?? `${APP_NAME[app]} has no settings file we can use.` };
  const raw = fs.existsSync(t.path) ? fs.readFileSync(t.path, 'utf8') : '';
  const servers = t.format === 'json' ? parseJsonServers(raw, t.key ?? 'mcpServers') : parseTomlServers(raw);
  const there = findAddonIn(entry, servers);
  if (launch && there && there.addon !== entry.id) return { app, name: there.name, configPath: t.path, backup: null, action: 'skipped', note: `${APP_NAME[app]} already has it (“${there.name}”): we left yours as it is.` };
  if (!launch && (!there || there.addon !== entry.id)) return { app, name: there?.name ?? entry.mcp!.serverName, configPath: t.path, backup: null, action: 'skipped', note: there ? 'This one was not added by VTube Pro, so we left it.' : 'Nothing to take out.' };
  const name = launch ? (there?.addon === entry.id ? there.name : pickServerName(entry, servers)) : there!.name;
  const m = mergeAddonEntry(app, raw, name, entry.id, launch);
  if (m.action === 'same') return { app, name, configPath: t.path, backup: null, action: 'same' };
  let backup: string | null = null;
  if (fs.existsSync(t.path)) { backup = backupName(t.path, e.now()); fs.copyFileSync(t.path, backup); } else fs.mkdirSync(path.dirname(t.path), { recursive: true });
  atomicWrite(t.path, m.text);
  return { app, name, configPath: t.path, backup, action: m.action };
}

// ---------------------------------------------------------------- programs: uv, GIMP profile + plug-in, Blender add-ons, Photoshop
export function findUv(e: Pick<Env, 'env' | 'platform' | 'home'>, name: 'uv' | 'uvx'): string | null {
  const onPath = whichPath(name, e);
  if (onPath) return onPath;
  const x = e.platform === 'win32' ? '.exe' : '';
  const c = [path.join(e.home, '.local', 'bin', name + x), path.join(e.home, '.cargo', 'bin', name + x)];
  if (e.platform === 'win32' && e.env.LOCALAPPDATA) c.push(path.join(e.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', name + x));
  if (e.platform === 'darwin') c.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
  if (e.platform === 'linux') c.push(`/usr/local/bin/${name}`, `/usr/bin/${name}`, `/home/linuxbrew/.linuxbrew/bin/${name}`);
  return c.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) ?? null;
}

const verNum = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
const byVersionDesc = (a: { version: string }, b: { version: string }) => { const x = verNum(a.version), y = verNum(b.version); return (y[0] - x[0]) || ((y[1] ?? 0) - (x[1] ?? 0)); };
/** GIMP's per-user profile folders (newest first): %APPDATA%\GIMP\3.2, ~/Library/Application Support/GIMP/3.2, ~/.config/GIMP/3.2, Flatpak. */
export function gimpProfiles(e: Pick<Env, 'env' | 'platform' | 'home'>): { dir: string; version: string }[] {
  const bases = e.platform === 'win32' ? (e.env.APPDATA ? [path.join(e.env.APPDATA, 'GIMP')] : [])
    : e.platform === 'darwin' ? [path.join(e.home, 'Library', 'Application Support', 'GIMP')]
      : [path.join(e.home, '.config', 'GIMP'), path.join(e.home, '.var', 'app', 'org.gimp.GIMP', 'config', 'GIMP')];
  const out: { dir: string; version: string }[] = [];
  for (const b of bases) { let names: string[] = []; try { names = fs.readdirSync(b); } catch { continue; } for (const n of names) if (/^3\.\d+$/.test(n)) out.push({ dir: path.join(b, n), version: n }); }
  return out.sort(byVersionDesc);
}
/** A GIMP MCP plug-in already in a GIMP profile (ours or the user's own clone): plug-ins/<x>/gimp-mcp-plugin.py or plug-ins/gimp-mcp-plugin.py. */
export function findGimpPlugin(profiles: { dir: string }[]): string | null {
  for (const p of profiles) {
    const pi = path.join(p.dir, 'plug-ins');
    const direct = path.join(pi, 'gimp-mcp-plugin.py');
    if (fs.existsSync(direct)) return direct;
    let subs: string[] = [];
    try { subs = fs.readdirSync(pi); } catch { continue; }
    for (const s of subs) { const f = path.join(pi, s, 'gimp-mcp-plugin.py'); if (fs.existsSync(f)) return f; }
  }
  return null;
}
/** Blender's per-user version folders (newest first). */
export function blenderUserDirs(e: Pick<Env, 'env' | 'platform' | 'home'>): { dir: string; version: string }[] {
  const b = e.platform === 'win32' ? (e.env.APPDATA ? path.join(e.env.APPDATA, 'Blender Foundation', 'Blender') : null)
    : e.platform === 'darwin' ? path.join(e.home, 'Library', 'Application Support', 'Blender') : path.join(e.home, '.config', 'blender');
  if (!b) return [];
  let names: string[] = [];
  try { names = fs.readdirSync(b); } catch { return []; }
  return names.filter((n) => /^\d+\.\d+$/.test(n)).map((n) => ({ dir: path.join(b, n), version: n })).sort(byVersionDesc);
}
const head = (f: string) => { try { const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd); return buf.subarray(0, n).toString('utf8'); } catch { return ''; } };
/** Which Blender MCP add-ons are in the user's Blender (any version folder). */
export function blenderAddons(e: Pick<Env, 'env' | 'platform' | 'home'>): { community: string | null; lab: string | null } {
  let community: string | null = null, lab: string | null = null;
  for (const v of blenderUserDirs(e)) {
    const ad = path.join(v.dir, 'scripts', 'addons');
    for (const f of ['blender_mcp.py', 'addon.py', path.join('blender_mcp', '__init__.py')]) {
      const p = path.join(ad, f);
      if (!community && fs.existsSync(p) && /["'](MCP for Blender|Blender MCP|BlenderMCP)["']/.test(head(p))) community = p;
    }
    let repos: string[] = [];
    try { repos = fs.readdirSync(path.join(v.dir, 'extensions')); } catch { /* none */ }
    for (const r of repos) { const m = path.join(v.dir, 'extensions', r, 'mcp', 'blender_manifest.toml'); if (!lab && fs.existsSync(m) && /Blender Lab/.test(head(m))) lab = m; }
  }
  return { community, lab };
}
export function photoshopFound(e: Pick<Env, 'env' | 'platform' | 'home'>): boolean {
  const dirs = e.platform === 'win32' ? [e.env.ProgramFiles, e.env.ProgramW6432].filter((x): x is string => !!x).map((p) => path.join(p, 'Adobe'))
    : e.platform === 'darwin' ? ['/Applications'] : [];
  for (const d of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) if (/^Adobe Photoshop/i.test(n) && (e.platform !== 'win32' || fs.existsSync(path.join(d, n, 'Photoshop.exe')))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- our skill: folders with an ownership marker, and a zip
export const SKILL_MARKER = '.vtp-owned.json';
export type SkillState = 'missing' | 'current' | 'old' | 'edited' | 'foreign';
const hashFiles = (files: Record<string, string>) => crypto.createHash('sha256').update(Object.keys(files).sort().map((k) => `${k}\0${files[k]}`).join('\0')).digest('hex');
function readFilesUnder(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const n of names) {
    const r = rel ? `${rel}/${n.name}` : n.name;
    if (n.name === SKILL_MARKER) continue;
    if (n.isDirectory()) Object.assign(out, readFilesUnder(dir, r)); else if (n.isFile()) out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
  }
  return out;
}
export function skillDir(app: AddonApp, home: string): string | null { const p = SKILL_DIRS[app]; return p ? path.join(home, ...p, CREATOR_SKILL_NAME) : null; }
export function skillState(dir: string, want: Record<string, string>): SkillState {
  if (!fs.existsSync(dir)) return 'missing';
  let mark: { by?: string; version?: string; hash?: string } | null = null;
  try { mark = JSON.parse(fs.readFileSync(path.join(dir, SKILL_MARKER), 'utf8')); } catch { mark = null; }
  if (!mark || mark.by !== 'VTube Pro') return 'foreign';
  const have = hashFiles(readFilesUnder(dir));
  if (have !== mark.hash) return 'edited';
  return have === hashFiles(want) ? 'current' : 'old';
}
/** Write / refresh our skill folder. A folder that isn't ours is never touched; one the user edited is backed up first. */
/** A plain relative name ("a/b.md"): no absolute path, no ".." / "." segment, no backslash, no drive. */
export function safeRel(rel: string): boolean {
  return typeof rel === 'string' && rel.length > 0 && rel.length < 200 && !/[\\:\0]/.test(rel) && !rel.startsWith('/') && rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}
/** dir + rel, refusing anything that would land outside dir. */
export function inside(dir: string, rel: string): string {
  if (!safeRel(rel)) throw new Error(`Refused an unsafe file name (${String(rel).slice(0, 60)}).`);
  const root = path.resolve(dir), f = path.resolve(root, ...rel.split('/'));
  if (f !== root && !f.startsWith(root + path.sep)) throw new Error(`Refused a file outside its folder (${rel.slice(0, 60)}).`);
  return f;
}
export function installSkillAt(dir: string, files: Record<string, string>, now: number): { action: 'create' | 'update' | 'same'; backup: string | null } {
  for (const rel of Object.keys(files)) inside(dir, rel); // every name checked BEFORE anything is removed or written
  const st = skillState(dir, files);
  if (st === 'foreign') throw new Error(`There is already a "${CREATOR_SKILL_NAME}" folder that VTube Pro didn’t make (${dir}), so we left it alone.`);
  if (st === 'current') return { action: 'same', backup: null };
  let backup: string | null = null;
  if (st === 'edited') { backup = backupName(dir, now); fs.renameSync(dir, backup); }
  else if (st === 'old') fs.rmSync(dir, { recursive: true, force: true });
  for (const rel of Object.keys(files)) inside(dir, rel); // every name checked BEFORE anything is written
  for (const [rel, text] of Object.entries(files)) { const f = inside(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  fs.writeFileSync(path.join(dir, SKILL_MARKER), JSON.stringify({ by: 'VTube Pro', version: CREATOR_SKILL_VERSION, hash: hashFiles(files), note: 'Made by VTube Pro. Delete this folder to remove the skill.' }, null, 2));
  return { action: st === 'missing' ? 'create' : 'update', backup };
}

/** A plain (stored, uncompressed) zip: enough for a skill upload; no dependency. */
export function makeZip(files: Record<string, string | Buffer>, root = ''): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | 10 << 5 | 6; // fixed date: the same skill gives the same bytes
  if (root && !safeRel(root)) throw new Error('Refused an unsafe zip folder name.');
  for (const [rel, body] of Object.entries(files)) {
    if (!safeRel(rel)) throw new Error(`Refused an unsafe file name in the zip (${String(rel).slice(0, 60)}).`);
    const name = Buffer.from(root ? `${root}/${rel}` : rel, 'utf8');
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------------------------------------------------------------- pinned downloads
export function addonFolder(dataDir: string, id: string, ref: string): string { return path.join(dataDir, 'ai-addons', id, ref.slice(0, 12)); }
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
/** Download every pinned file of an add-on into `dir` (from its official host), each checked against its SHA-256 BEFORE it is written. */
export async function fetchPinned(entry: AddonEntry, dir: string, d: Pick<AddonsDeps, 'download'>): Promise<{ fetched: string[]; kept: string[] }> {
  const pin = entry.pin;
  if (!pin?.files?.length || !pin.baseUrl) throw new Error('This add-on has no files to download.');
  const host = new URL(pin.baseUrl).hostname;
  if (new URL(pin.baseUrl).protocol !== 'https:' || !entry.officialHosts.includes(host)) throw new Error('That download is not from the add-on’s official site, so we stopped.');
  fs.mkdirSync(dir, { recursive: true });
  const fetched: string[] = [], kept: string[] = [];
  for (const f of pin.files) {
    if (!safeRel(f.name) || f.name.includes('/')) throw new Error(`Refused an unsafe file name (${f.name}).`);
    const dest = inside(dir, f.name);
    try { if (sha256(fs.readFileSync(dest)) === f.sha256) { kept.push(f.name); continue; } } catch { /* not there yet */ }
    const body = await d.download(pin.baseUrl + encodeURIComponent(f.name), Math.max((f.bytes ?? 0) * 2, 1_000_000), entry.officialHosts);
    if (sha256(body) !== f.sha256) throw new Error(`${f.name} from ${host} is not the version we checked, so we stopped and installed nothing.`);
    fs.writeFileSync(`${dest}.vtp_tmp`, body);
    fs.renameSync(`${dest}.vtp_tmp`, dest);
    fetched.push(f.name);
  }
  return { fetched, kept };
}

// ---------------------------------------------------------------- status
export interface ToolSeen { found: boolean; version?: string; path?: string; running?: boolean }
export interface AddonsStatus {
  v: 1; os: ToolOs; checkedAt: number;
  tools: Record<'blender' | 'gimp' | 'uv' | 'comfyui' | 'photoshop', ToolSeen>;
  apps: { id: AddonApp; name: string; installed: boolean | null; connected: boolean; configPath: string | null }[];
  addons: {
    id: string; name: string; maker: string; status: string; kind: string; blurb: string; price: string; licence: { name: string; url: string }; homepage: string;
    cautions: string[]; next: string[]; links: { label: string; url: string }[]; requires: string[]; security: AddonEntry['security'];
    ways: Partial<Record<AddonApp, { how: string; url?: string; command?: string; steps?: string[] }>>;
    /** app -> the server name it has there (ours: true when VTube Pro added it) */
    inApps: Partial<Record<AddonApp, { name: string; ours: boolean }>>;
    extra: Record<string, string | boolean | null>;
  }[];
  recs: Partial<Record<AddonApp, { id: string; level: string; why: string }[]>>;
  skill: { version: string; dests: { app: AddonApp; dir: string; state: SkillState }[]; claudeDesktopNote: string };
  running: { blender: boolean; gimp: boolean };
  model: ReturnType<typeof publicAdvice>; firstMessage: string; localNote: string;
}

/** The model advice without the hidden list (models not publicly available are never sent to a page). */
export function publicAdvice(): Omit<typeof MODEL_ADVICE, 'hidden'> { const { hidden: _hidden, ...rest } = MODEL_ADVICE; return rest; }

// Program detection runs `blender --version` etc.: remembered for a minute per deps (the page polls; a live PC must not
// start Blender every few seconds). `forget` (after an install / "Check again") clears it.
const toolMemo = new WeakMap<AddonsDeps, Map<string, { at: number; v: ToolSeen }>>();
export function forgetTools(d: AddonsDeps) { toolMemo.delete(d); }

export async function addonsStatus(d: AddonsDeps): Promise<AddonsStatus> {
  const e = d.env();
  const td = d.tools();
  await td.prepare?.();
  const o = toolOs(td.platform);
  if (!o) throw new Error('unsupported platform');
  let memo = toolMemo.get(d);
  if (!memo) toolMemo.set(d, (memo = new Map()));
  const det = async (id: string): Promise<ToolSeen> => {
    const hit = memo!.get(id);
    if (hit && d.now() - hit.at < 60_000) return hit.v;
    const t = getTool(id);
    let v: ToolSeen = { found: false };
    if (t) { try { const f = await detectTool(t, o, td); v = { found: f.found, ...(f.version ? { version: f.version } : {}), ...(f.path ? { path: f.path } : {}), ...(f.running !== undefined ? { running: f.running } : {}) }; } catch { v = { found: false }; } }
    memo!.set(id, { at: d.now(), v });
    return v;
  };
  const [blender, gimp, uvT, comfyui, tcpB, tcpG] = await Promise.all([det('blender'), det('gimp'), det('uv'), det('comfyui'), d.tcp(BLENDER_MCP_PORT), d.tcp(GIMP_MCP_PORT)]);
  const uvPath = findUv(e, 'uv');
  const uv: ToolSeen = uvPath ? { found: true, path: uvPath } : uvT;
  const photoshop: ToolSeen = { found: photoshopFound(e) };
  const tools = { blender, gimp, uv, comfyui, photoshop };
  const have: Have = tools;
  const apps = ADDON_APPS.map((id) => {
    const t = configTarget(id as ConnectorId, e);
    let connected = false;
    try { connected = t.supported ? !!readDesktopEntry(id as ConnectorId, e) : false; } catch { connected = false; }
    return { id, name: APP_NAME[id], installed: t.supported ? appInstalled(id as ConnectorId, e) : false, connected, configPath: t.path };
  });
  const servers = new Map<AddonApp, ServerRef[]>(MCP_TARGETS.map((a) => [a, listServers(a, e)]));
  const profiles = gimpProfiles(e);
  const bl = blenderAddons(e);
  const files = creatorSkillFiles(d.houseRules());
  const addons = AI_ADDONS.map((a) => {
    const inApps: Partial<Record<AddonApp, { name: string; ours: boolean }>> = {};
    if (a.detect?.mcpEntry) for (const app of MCP_TARGETS) { const s = findAddonIn(a, servers.get(app) ?? []); if (s) inApps[app] = { name: s.name, ours: s.addon === a.id }; }
    const extra: Record<string, string | boolean | null> = {};
    if (a.id === 'gimp-mcp') { const p = findGimpPlugin(profiles); extra.pluginInstalled = !!p; extra.pluginPath = p; extra.gimpProfile = profiles[0]?.dir ?? null; extra.running = tcpG; extra.filesReady = fs.existsSync(path.join(addonFolder(d.dataDir(), a.id, GIMP_MCP_COMMIT), 'gimp_mcp_server.py')); }
    if (a.id === 'mcp-for-blender') { extra.addonInstalled = !!bl.community; extra.running = tcpB && !bl.lab; }
    if (a.id === 'blender-lab-mcp') { extra.addonInstalled = !!bl.lab; extra.running = tcpB && !!bl.lab; }
    return {
      id: a.id, name: a.name, maker: a.maker, status: a.status, kind: a.kind, blurb: a.blurb, price: a.price, licence: a.licence, homepage: a.homepage,
      cautions: a.cautions ?? [], next: a.next ?? [], links: a.links ?? [], requires: a.requires ?? [], security: a.security,
      ways: Object.fromEntries(Object.entries(a.apps).map(([k, w]) => [k, { how: w!.how, ...(w!.url ? { url: w!.url } : {}), ...(w!.command ? { command: w!.command } : {}), ...(w!.steps ? { steps: w!.steps } : {}) }])),
      inApps, extra,
    };
  });
  const recs: AddonsStatus['recs'] = {};
  for (const app of ADDON_APPS) recs[app] = recommendFor(app, have).map((r) => ({ id: r.entry.id, level: r.level, why: r.why }));
  const seen = new Set<string>();
  const dests: AddonsStatus['skill']['dests'] = [];
  for (const app of ADDON_APPS) { const dir = skillDir(app, e.home); if (!dir || seen.has(dir)) continue; seen.add(dir); dests.push({ app, dir, state: skillState(dir, files) }); }
  return {
    v: 1, os: o, checkedAt: d.now(), tools, apps, addons, recs,
    skill: { version: CREATOR_SKILL_VERSION, dests, claudeDesktopNote: 'Claude Desktop keeps skills in your Claude account: upload the zip in Customize > Skills (with Code execution switched on).' },
    running: { blender: tcpB, gimp: tcpG }, model: publicAdvice(), firstMessage: FIRST_MESSAGE, localNote: LOCAL_MODEL_NOTE,
  };
}

/** Plain text for the AI (MCP ai_addons_status): what is ready and the ONE step for what isn't. No paths, no config details. */
export function summaryText(s: AddonsStatus): string {
  const L: string[] = ['# VTube Pro helpers for your AI (this computer)'];
  const t = s.tools;
  const add = (id: string) => s.addons.find((a) => a.id === id)!;
  const yes = (b: unknown) => (b ? 'yes' : 'no');
  L.push(`- Blender: ${t.blender.found ? `installed${t.blender.version ? ` (${t.blender.version})` : ''}` : 'not installed (the user can install it in VTube Pro > Tools)'}`);
  const mb = add('mcp-for-blender'), lab = add('blender-lab-mcp');
  const mbApps = Object.keys(mb.inApps).length + Object.keys(lab.inApps).length;
  L.push(`- Blender MCP: added to ${mbApps ? Object.keys({ ...mb.inApps, ...lab.inApps }).map((a) => APP_NAME[a as AddonApp]).join(', ') : 'no AI app yet'}; Blender add-on installed: ${yes(mb.extra.addonInstalled || lab.extra.addonInstalled)}; running now: ${yes(s.running.blender)}.`);
  if (!s.running.blender) L.push('  To use it: ask the user to open Blender, press N in the 3D view, open the BlenderMCP tab and press Connect (or start the Blender Lab MCP add-on). Headless VTube Pro tools (blender_run_python) work without it.');
  L.push(`- Photoshop: ${t.photoshop.found ? 'installed' : 'not installed'}. GIMP: ${t.gimp.found ? `installed${t.gimp.version ? ` (${t.gimp.version})` : ''}` : 'not installed'}.`);
  const g = add('gimp-mcp');
  L.push(`- GIMP MCP: added to ${Object.keys(g.inApps).length ? Object.keys(g.inApps).map((a) => APP_NAME[a as AddonApp]).join(', ') : 'no AI app yet'}; GIMP plug-in installed: ${yes(g.extra.pluginInstalled)}; running now: ${yes(s.running.gimp)}.`);
  if (!s.running.gimp) L.push('  To use it: ask the user to open GIMP, then Tools > MCP > Start MCP Server.');
  L.push(`- ComfyUI: ${t.comfyui.found ? (t.comfyui.running ? 'running (use comfy_workflows)' : 'installed, not running (ask the user to open it)') : 'not installed'}.`);
  L.push(`- uv (runs the Blender / GIMP MCPs): ${yes(t.uv.found)}.`);
  const sk = s.skill.dests.filter((x) => x.state !== 'missing' && x.state !== 'foreign').map((x) => APP_NAME[x.app]);
  L.push(`- VTube Pro Creator skill ${s.skill.version}: installed for ${sk.length ? sk.join(', ') : 'no app yet'}.`);
  L.push('', 'Missing something? Tell the user ONE step: "Open VTube Pro > Create > Connect your AI > Make your AI better and press Set it up." Never install anything yourself.');
  return L.join('\n');
}

// ---------------------------------------------------------------- local models: can it call tools?
export interface ToolCheck { state: 'tools' | 'guided' | 'too-small' | 'unreachable'; small: boolean; title: string; detail: string }
/** Billions of parameters from a model name ("qwen3:8b", "llama-3.2-3b-instruct") or null. */
export function paramsB(model: string): number | null { const m = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z])/i.exec(model.replace(/[:_]/g, '-')); return m ? parseFloat(m[1]) : null; }
export async function localToolCheck(baseUrl: string, model: string, f: typeof fetch): Promise<ToolCheck> {
  if (!localBaseOk(baseUrl)) return { state: 'unreachable', small: false, title: 'That address is not on this PC', detail: 'Use the address your model app shows (it starts with http://127.0.0.1).' };
  const base = baseUrl.replace(/\/+$/, '');
  const root = base.replace(/\/v1$/, '');
  const b = paramsB(model);
  const small = b !== null && b < 7;
  let meta: boolean | null = null;
  try {
    if (/:11434$/.test(new URL(root).host)) {
      const r = await f(`${root}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(4000) });
      const j: any = r.ok ? await r.json() : null;
      if (Array.isArray(j?.capabilities)) meta = j.capabilities.includes('tools');
    } else if (/:1234$/.test(new URL(root).host)) {
      const r = await f(`${root}/api/v0/models/${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(4000) });
      const j: any = r.ok ? await r.json() : null;
      if (Array.isArray(j?.capabilities)) meta = j.capabilities.includes('tool_use');
    }
  } catch { /* metadata is a hint only */ }
  let live: boolean | null = null;
  if (meta !== false) {
    try {
      const r = await f(`${base}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({ model, temperature: 0, max_tokens: 64, tool_choice: 'auto', messages: [{ role: 'user', content: 'Call the ping tool now. Do not answer in text.' }],
          tools: [{ type: 'function', function: { name: 'ping', description: 'Answer a ping from VTube Pro.', parameters: { type: 'object', properties: {} } } }] }),
      });
      if (!r.ok) live = false;
      else { const j: any = await r.json(); const tc = j?.choices?.[0]?.message?.tool_calls; live = Array.isArray(tc) && tc.length > 0; }
    } catch { if (meta === null) return { state: 'unreachable', small, title: `“${model}” didn’t answer`, detail: 'Start your model app (in LM Studio switch “Start server” on), load the model, then check again.' }; }
  }
  const tools = live === true || (live === null && meta === true);
  if (small) return { state: 'too-small', small, title: 'Fine for chat, too small for building', detail: `${tools ? 'It can use VTube Pro’s tools, but a' : 'A'} model this size (${b}B) usually can’t make avatars or rooms. Pick a bigger one (14B or more) for building, or use an AI app of your own.` };
  return tools
    ? { state: 'tools', small, title: 'It can use VTube Pro’s tools ✓', detail: LOCAL_MODEL_NOTE }
    : { state: 'guided', small, title: 'It can’t use tools directly', detail: 'VTube Pro will guide it step by step instead (slower). Models with tool use (Qwen 3.x, Llama 3.1+, Mistral) work better.' };
}


// ---------------------------------------------------------------- real deps
export async function realAddonsDeps(): Promise<AddonsDeps> {
  const [{ realEnv }, tc, paths, know] = await Promise.all([import('./aiConnectors.ts'), import('./toolsCatalog.ts'), import('./paths.ts'), import('./aiKnowledge.ts')]);
  return {
    env: realEnv, tools: tc.realDeps, dataDir: () => paths.DATA_DIR, houseRules: () => know.HOUSE_RULES, now: () => Date.now(),
    tcp: (port) => new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port });
      const done = (v: boolean) => { s.destroy(); resolve(v); };
      s.setTimeout(400, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false));
    }),
    download: async (url, maxBytes, hosts) => {
      let r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      for (let hop = 0; r.status >= 300 && r.status < 400; hop++) {
        const loc = r.headers.get('location');
        let next: URL | null = null;
        try { next = loc ? new URL(loc, url) : null; } catch { next = null; }
        if (hop >= 5 || !next || next.protocol !== 'https:' || !hosts.includes(next.hostname.toLowerCase())) throw new Error('The download tried to send us to another website, so we stopped.');
        url = next.toString();
        r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      }
      if (!r.ok) throw new Error(`The download failed (error ${r.status}). Check that this PC is online, then try again.`);
      if (Number(r.headers.get('content-length') ?? 0) > maxBytes) throw new Error('That download is much bigger than expected, so we stopped.');
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length > maxBytes) throw new Error('That download is much bigger than expected, so we stopped.');
      return b;
    },
    run: (file, args, o) => new Promise((resolve) => {
      let out = '';
      let child: ReturnType<typeof spawn>;
      try { child = spawn(file, args, { cwd: o.cwd, env: { ...process.env, ...(o.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }); } catch (err) { resolve({ code: -1, out: (err as Error).message }); return; }
      const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ code: -1, out: `${out}\n(took too long)` }); }, o.timeoutMs);
      child.stdout?.on('data', (b: Buffer) => { out = (out + b.toString('utf8')).slice(-8000); });
      child.stderr?.on('data', (b: Buffer) => { out = (out + b.toString('utf8')).slice(-8000); });
      child.on('error', (err) => { clearTimeout(t); resolve({ code: -1, out: err.message }); });
      child.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
    }),
    openWithDefaultApp: async (file) => {
      const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '""', file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
      spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    },
  };
}

// ---------------------------------------------------------------- actions
const isApp = (x: unknown): x is AddonApp => typeof x === 'string' && (ADDON_APPS as readonly string[]).includes(x);
const appsFrom = (x: unknown): AddonApp[] => (Array.isArray(x) ? [...new Set(x.filter(isApp))] : []);

/** Claude Code writes ~/.claude.json for itself: use its own CLI when it is here (after our backup), like "Add VTube Pro". */
async function writeForApp(app: AddonApp, entry: AddonEntry, launch: AddonLaunch | null, d: AddonsDeps): Promise<AppWrite> {
  const e = d.env();
  if (app !== 'claude-code') return writeAddonEntry(app, entry, launch, e);
  const cli = claudeCodeCli(e);
  if (!cli) return writeAddonEntry(app, entry, launch, e);
  const t = configTarget('claude-code', e);
  const raw = t.path && fs.existsSync(t.path) ? fs.readFileSync(t.path, 'utf8') : '';
  const servers = parseJsonServers(raw, 'mcpServers');
  const there = findAddonIn(entry, servers);
  if (launch && there && there.addon !== entry.id) return { app, name: there.name, configPath: t.path, backup: null, action: 'skipped', note: `Claude Code already has it (“${there.name}”): we left yours as it is.` };
  if (!launch && (!there || there.addon !== entry.id)) return { app, name: there?.name ?? entry.mcp!.serverName, configPath: t.path, backup: null, action: 'skipped', note: there ? 'This one was not added by VTube Pro, so we left it.' : 'Nothing to take out.' };
  const name = there?.addon === entry.id ? there.name : pickServerName(entry, servers);
  const backup = t.path && fs.existsSync(t.path) ? backupName(t.path, d.now()) : null;
  if (backup) fs.copyFileSync(t.path!, backup);
  if (there) await d.run(cli, ['mcp', 'remove', '--scope', 'user', name], { timeoutMs: 30_000 });
  if (!launch) return { app, name, configPath: t.path, backup, action: 'remove' };
  const r = await d.run(cli, ['mcp', 'add', '--env', ...Object.entries(launch.env).map(([k, v]) => `${k}=${v}`), '--transport', 'stdio', '--scope', 'user', name, '--', launch.command, ...launch.args], { timeoutMs: 30_000 });
  if (r.code !== 0) { if (backup && t.path) { try { fs.copyFileSync(backup, t.path); } catch { /* the backup stays for Restore */ } } }
  if (r.code !== 0) return { app, name, configPath: t.path, backup, action: 'error', note: `We put Claude Code’s settings back as they were. Claude Code didn’t accept it${r.out.trim() ? `: ${(r.out.trim()).slice(0, 160)}` : '.'}` };
  return { app, name, configPath: t.path, backup, action: there ? 'update' : 'add' };
}

export interface SetupOutcome { ok: boolean; title: string; detail?: string; fix?: string; writes: AppWrite[]; steps: string[]; next: string[] }

export async function setupAddon(id: string, apps: AddonApp[], o: { blenderAddon?: boolean }, d: AddonsDeps): Promise<SetupOutcome> {
  const entry = getAddon(id);
  if (!entry) throw new Error('We don’t know that add-on.');
  const e = d.env();
  const steps: string[] = [];
  const next = entry.next ?? [];
  if (entry.id === 'vtp-creator-skill') {
    const files = creatorSkillFiles(d.houseRules());
    const done: string[] = [];
    const seen = new Set<string>();
    for (const app of apps.length ? apps : ADDON_APPS) {
      const dir = skillDir(app, e.home);
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      const r = installSkillAt(dir, files, d.now());
      done.push(`${APP_NAME[app]}: ${r.action === 'same' ? 'already up to date' : r.action === 'create' ? 'added' : 'updated'}${r.backup ? ` (your edited copy was kept as ${path.basename(r.backup)})` : ''}`);
    }
    return { ok: true, title: 'The VTube Pro Creator skill is ready', detail: done.join('. '), writes: [], steps: done, next };
  }
  if (!entry.mcp) throw new Error('This add-on is installed from its own page: use its link.');
  const targets = apps.filter((a) => entry.apps[a]?.how === 'auto' && MCP_TARGETS.includes(a));
  if (!targets.length) throw new Error('Pick at least one AI app.');
  // one config file for ChatGPT + Codex: write it once
  const uniq = targets.filter((a, i) => !targets.slice(0, i).some((b) => b === a || sameFile(a, b)));
  let launch: AddonLaunch;
  if (entry.id === 'mcp-for-blender') {
    const uvx = findUv(e, 'uvx');
    if (!uvx) return { ok: false, title: 'uv is needed first', fix: 'Press “Get uv” (free, from its maker) and wait for it to finish, then press Set it up again.', writes: [], steps, next };
    launch = resolveLaunch(entry, { uvx });
    if (o.blenderAddon) {
      const r = await d.run(uvx, ['--from', `mcp-for-blender==${entry.pin!.ref}`, 'mcp-for-blender', 'install-addon'], { timeoutMs: 240_000, env: { DISABLE_TELEMETRY: 'true' } });
      steps.push(r.code === 0 ? 'Put the MCP for Blender add-on into your Blender.' : `We couldn’t put the add-on into Blender (${(r.out.trim().split('\n').slice(-1)[0] ?? '').slice(0, 140)}). You can add it yourself: see the add-on’s page.`);
    }
  } else if (entry.id === 'gimp-mcp') {
    const uv = findUv(e, 'uv');
    if (!uv) return { ok: false, title: 'uv is needed first', fix: 'Press “Get uv” (free, from its maker) and wait for it to finish, then press Set it up again.', writes: [], steps, next };
    const prof = gimpProfiles(e)[0];
    if (!prof) return { ok: false, title: 'Open GIMP once first', fix: 'Open GIMP once (it makes its settings folder the first time), close it, then press Set it up again.', writes: [], steps, next };
    const dir = addonFolder(d.dataDir(), entry.id, GIMP_MCP_COMMIT);
    const f = await fetchPinned(entry, dir, d);
    steps.push(f.fetched.length ? `Downloaded the GIMP MCP from GitHub and checked all ${f.fetched.length + f.kept.length} files.` : 'The GIMP MCP files were already here and checked.');
    const have = findGimpPlugin([prof]);
    if (have) steps.push('GIMP already has the MCP plug-in: we kept it.');
    else {
      const pd = path.join(prof.dir, 'plug-ins', 'gimp-mcp-plugin');
      fs.mkdirSync(pd, { recursive: true });
      fs.copyFileSync(path.join(dir, 'gimp-mcp-plugin.py'), path.join(pd, 'gimp-mcp-plugin.py'));
      if (e.platform !== 'win32') { try { fs.chmodSync(path.join(pd, 'gimp-mcp-plugin.py'), 0o755); } catch { /* best effort */ } }
      steps.push(`Added the MCP plug-in to GIMP ${prof.version}.`);
    }
    const r = await d.run(uv, ['sync', '--frozen', '--directory', dir], { timeoutMs: 300_000, env: { UV_NO_PROGRESS: '1' } });
    if (r.code !== 0) return { ok: false, title: 'We couldn’t finish the GIMP MCP', detail: (r.out.trim().split('\n').slice(-2).join(' ')).slice(0, 240), fix: 'Check that this PC is online, then press Set it up again.', writes: [], steps, next };
    steps.push('Prepared its Python pieces.');
    launch = resolveLaunch(entry, { uv, dir });
  } else throw new Error('This add-on is installed from its own page: use its link.');
  const writes: AppWrite[] = [];
  for (const app of uniq) writes.push(await writeForApp(app, entry, launch, d));
  const bad = writes.filter((w) => w.action === 'error');
  const okApps = writes.filter((w) => w.action !== 'error').map((w) => APP_NAME[w.app]);
  return {
    ok: !bad.length, title: bad.length ? `${entry.name} is set up, but not for every app` : `${entry.name} is set up`,
    detail: [okApps.length ? `Added for ${okApps.join(', ')}.` : '', ...writes.filter((w) => w.action === 'skipped').map((w) => w.note ?? ''), ...bad.map((w) => `${APP_NAME[w.app]}: ${w.note}`)].filter(Boolean).join(' '),
    ...(bad.length ? { fix: 'Use “Copy the settings” for that app and add it yourself.' } : {}), writes, steps, next,
  };
}

export async function removeAddon(id: string, apps: AddonApp[], d: AddonsDeps): Promise<AppWrite[]> {
  const entry = getAddon(id);
  if (!entry?.mcp) throw new Error('Only add-ons VTube Pro added to your apps can be taken out here.');
  const uniq = apps.filter((a, i) => MCP_TARGETS.includes(a) && !apps.slice(0, i).some((b) => b === a || sameFile(a, b)));
  const out: AppWrite[] = [];
  for (const app of uniq) out.push(await writeForApp(app, entry, null, d));
  return out;
}

/** "Copy the settings": the exact entry for one app (the do-it-yourself box), without writing anything. */
export function previewAddon(id: string, app: AddonApp, d: AddonsDeps): { app: AddonApp; configPath: string | null; name: string; action: string; entryText: string; others: string[]; skipped?: string } {
  const entry = getAddon(id);
  if (!entry?.mcp) throw new Error('This add-on has no settings to add.');
  const e = d.env();
  const t = configTarget(app as ConnectorId, e);
  if (!t.supported || !t.path) throw new Error(t.why ?? `${APP_NAME[app]} has no settings file we can use.`);
  const raw = fs.existsSync(t.path) ? fs.readFileSync(t.path, 'utf8') : '';
  const servers = t.format === 'json' ? parseJsonServers(raw, t.key ?? 'mcpServers') : parseTomlServers(raw);
  const there = findAddonIn(entry, servers);
  const p = { uv: findUv(e, 'uv') ?? 'uv', uvx: findUv(e, 'uvx') ?? 'uvx', dir: addonFolder(d.dataDir(), entry.id, entry.pin?.ref ?? 'x') };
  const name = there?.addon === entry.id ? there.name : pickServerName(entry, servers);
  let m: AddonMerge;
  try { m = mergeAddonEntry(app, raw, name, entry.id, resolveLaunch(entry, p)); } catch (err) { return { app, configPath: t.path, name, action: 'refused', entryText: '', others: [], skipped: (err as Error).message }; }
  return { app, configPath: t.path, name, action: m.action, entryText: m.entryText, others: m.others, ...(there && there.addon !== entry.id ? { skipped: `Already there as “${there.name}”.` } : {}) };
}

/// ---------------------------------------------------------------- routes
/** One-time "Yes" tokens (like the Tools list): the page asks for one right after the user's tick, the write uses it once. */
export interface AddonGrant { token: string; key: string; origin: string; exp: number }
export class AddonConsent {
  private grants = new Map<string, AddonGrant>();
  constructor(private now: () => number, private ttlMs = 120_000) {}
  static key(action: string, id: string, apps: readonly string[]) { return `${action}|${id}|${[...apps].sort().join(',')}`; }
  issue(key: string, origin: string): AddonGrant {
    for (const [k, g] of this.grants) if (g.exp <= this.now()) this.grants.delete(k);
    if (this.grants.size > 50) this.grants.clear();
    const g = { token: crypto.randomBytes(24).toString('base64url'), key, origin, exp: this.now() + this.ttlMs };
    this.grants.set(g.token, g);
    return g;
  }
  take(token: unknown, key: string, origin: string): boolean {
    if (typeof token !== 'string') return false;
    const g = this.grants.get(token);
    if (!g) return false;
    this.grants.delete(token);
    return g.exp > this.now() && g.key === key && g.origin === origin;
  }
}
/** The helper's own page (same host as the request) or a program with no Origin. */
export function helperCaller(req: Request): boolean {
  const o = req.headers.origin;
  if (o === undefined) return true;
  try { return new URL(String(o)).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase(); } catch { return false; }
}
const USER_ACTION = 'x-vtp-user-action';

export function createAddonsRoutes(getDeps: () => Promise<AddonsDeps> = realAddonsDeps): Router {
  const r = Router();
  let depsP: Promise<AddonsDeps> | null = null;
  const deps = () => (depsP ??= getDeps());
  let busy = '';
  let memo: { at: number; s: AddonsStatus } | null = null;
  let consent: AddonConsent | null = null;
  const grants = (d: AddonsDeps) => (consent ??= new AddonConsent(() => d.now()));
  const bad = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) => { res.status(status).json({ error, ...extra }); };
  const fresh = async (d: AddonsDeps) => { if (memo && d.now() - memo.at < 4000) return memo.s; const s = await addonsStatus(d); memo = { at: d.now(), s }; return s; };
  const guard = async (res: Response, what: string, fn: () => Promise<unknown>) => {
    if (busy) return bad(res, 429, 'Another set-up is still running: give it a moment.');
    busy = what;
    try { res.json(await fn()); } catch (e) { bad(res, 409, (e as Error).message); } finally { busy = ''; memo = null; void deps().then(forgetTools); }
  };
  const originOf = (req: Request) => String(req.headers.origin ?? '');
  const notLocal = (res: Response) => bad(res, 403, 'This only works from VTube Pro’s own page on this computer.', { code: 'local-only' });
  /** Every write: from this PC's helper page (defence in depth behind localGuard), ticked, and with its one-time token. */
  async function allowed(req: Request, res: Response, action: string, id: string, apps: readonly string[]): Promise<AddonsDeps | null> {
    if (!helperCaller(req)) { notLocal(res); return null; }
    if (req.body?.consent !== true) { bad(res, 400, 'Tick “Yes” first.', { consent: true }); return null; }
    const d = await deps();
    if (!grants(d).take(req.body?.token, AddonConsent.key(action, id, apps), originOf(req))) { bad(res, 403, 'That confirmation expired. Press the button again.', { consent: true }); return null; }
    return d;
  }

  r.get('/api/ai-addons/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { const d = await deps(); if (req.query.force === '1') { memo = null; forgetTools(d); } res.json(await fresh(d)); } catch (e) { bad(res, 500, `Checking failed: ${(e as Error).message}`); }
  });
  r.get('/api/ai-addons/summary', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.type('text/plain').send(summaryText(await fresh(await deps()))); } catch (e) { bad(res, 500, (e as Error).message); }
  });
  r.get('/api/ai-addons/skill.zip', async (_req, res) => {
    const d = await deps();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${CREATOR_SKILL_NAME}.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(makeZip(creatorSkillFiles(d.houseRules()), CREATOR_SKILL_NAME));
  });
  /** The page asks for a token right after the tick (that click sends x-vtp-user-action). */
  r.post('/api/ai-addons/consent', async (req, res) => {
    if (!helperCaller(req)) return notLocal(res);
    if (req.headers[USER_ACTION] !== '1') return bad(res, 400, 'Press the button on the page.');
    const action = String(req.body?.action ?? ''), id = String(req.body?.id ?? '');
    if (!['setup', 'remove', 'skill', 'mcpb'].includes(action) || !getAddon(id)) return bad(res, 400, 'We don’t know that add-on.');
    const d = await deps();
    const g = grants(d).issue(AddonConsent.key(action, id, appsFrom(req.body?.apps)), originOf(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token: g.token, expiresIn: Math.round((g.exp - d.now()) / 1000) });
  });
  r.post('/api/ai-addons/skill', async (req, res) => {
    const apps = appsFrom(req.body?.apps);
    const d = await allowed(req, res, 'skill', 'vtp-creator-skill', apps);
    if (d) await guard(res, 'skill', () => setupAddon('vtp-creator-skill', apps, {}, d));
  });
  r.post('/api/ai-addons/local-tools', async (req, res) => {
    if (!helperCaller(req)) return notLocal(res);
    if (req.headers[USER_ACTION] !== '1') return bad(res, 400, 'Press the button on the page.');
    const base = String(req.body?.baseUrl ?? ''), model = String(req.body?.model ?? '');
    if (!model) return bad(res, 400, 'Pick a model first.');
    res.json(await localToolCheck(base, model, fetch));
  });
  r.post('/api/ai-addons/blender-lab-mcp/mcpb', async (req, res) => {
    const d = await allowed(req, res, 'mcpb', 'blender-lab-mcp', appsFrom(req.body?.apps));
    if (!d) return;
    await guard(res, 'mcpb', async () => {
      const entry = getAddon('blender-lab-mcp')!;
      const dir = addonFolder(d.dataDir(), entry.id, entry.pin!.ref);
      await fetchPinned(entry, dir, d);
      const mcpb = inside(dir, entry.pin!.files!.find((x) => x.name.endsWith('.mcpb'))!.name);
      await d.openWithDefaultApp(mcpb);
      return { ok: true, title: 'Claude Desktop is opening the Blender extension', detail: 'Press Install in the window Claude shows. We downloaded it from Blender’s releases page and checked it first.', file: mcpb, addonZip: inside(dir, entry.pin!.files!.find((x) => x.name.endsWith('.zip'))!.name) };
    });
  });
  r.get('/api/ai-addons/:id/preview', async (req, res) => {
    const app = String(req.query.app ?? '');
    if (!isApp(app)) return bad(res, 400, 'Which app?');
    try { res.setHeader('Cache-Control', 'no-store'); res.json(previewAddon(String(req.params.id), app, await deps())); } catch (e) { bad(res, 409, (e as Error).message); }
  });
  r.post('/api/ai-addons/:id/setup', async (req, res) => {
    const id = String(req.params.id), apps = appsFrom(req.body?.apps);
    const d = await allowed(req, res, 'setup', id, apps);
    if (d) await guard(res, 'setup', () => setupAddon(id, apps, { blenderAddon: req.body?.blenderAddon === true }, d));
  });
  r.post('/api/ai-addons/:id/remove', async (req, res) => {
    const id = String(req.params.id), apps = appsFrom(req.body?.apps);
    const d = await allowed(req, res, 'remove', id, apps);
    if (d) await guard(res, 'remove', async () => ({ writes: await removeAddon(id, apps, d) }));
  });
  return r;
}

export const aiAddonsRoutes = createAddonsRoutes();
