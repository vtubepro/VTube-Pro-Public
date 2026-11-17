// The helper's Tools list (catalogue: shared/toolsCatalog.ts, parsing: shared/toolsDetect.ts, page: tools.html).
//
//   GET  /api/tools[?refresh=1]          { v:1, os, arch, checkedAt, tools: ToolStatus[] }  detection on THIS computer
//   POST /api/tools/:id/plan  {method}   { plan, consent? }  what Install would do, in plain words; no side effects.
//                                         `consent` = { token, expiresIn } only for plans the helper may carry out
//   POST /api/tools/:id/install {method, token, iUnderstand:true}
//                                        carries out exactly that plan: opens the official page in the browser, or opens
//                                        a VISIBLE terminal running the catalogue's winget / brew command. Nothing else.
//
// Safety rules (unit-tested in tools/tools_catalog_unit.ts):
//   * Detection only READS: it checks files, runs `<tool> --version`-style flags (never anything that opens a window),
//     reads the Windows registry with reg.exe query, and asks 127.0.0.1 servers for their version. No downloads.
//   * Nothing installs without consent: /install needs a single-use token from /plan (2 minutes, bound to tool + method
//     + OS + caller origin) AND `iUnderstand: true`, which the studio sends only after the user ticks the box.
//   * The helper never downloads anything itself and never answers a licence prompt: open-url opens the vendor's page;
//     package-manager commands come only from the catalogue, must match RUNNABLE_COMMAND (plain `winget install -e --id`
//     / `brew install`), and run in a window the user can see. sudo / pipes / Linux terminals are copy-only.
//   * A caller that is not this PC's own page (isLocalCaller) gets paths with the home folder shown as "~", and gets plans
//     WITHOUT a consent token: /install answers 403 local-only, so the user confirms on the helper's own page
//     http://127.0.0.1:5191/tools.html?tool=<id> (the plan carries that `localUrl`).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { RUNNABLE_COMMAND, TOOL_CATALOG, getTool, isOfficialUrl, type ToolEntry, type ToolOs } from '../shared/toolsCatalog.ts';
import { decideState, expandPath, parseOutput, planFor, redactPath, toolOs, type Finding, type InstallPlan, type PathEnv, type ToolStatus, type ToolsReport } from '../shared/toolsDetect.ts';
import { ROOT } from './paths.ts';

// Launching an installer is local-only (coordinator rule, CONTRACT.md tools-catalog):
// a page that is not on this PC shows the plan and sends the user to http://127.0.0.1:5191/tools.html?tool=<id> to confirm on this PC.
export const TOOLS_INSTALL_PATH = /^\/api\/tools\/[^/]+\/install$/;
/** The helper's own Tools page, where installs are confirmed (a top-level loopback page; no Origin header). */
export const localToolsPage = (port: number, id?: string) => `http://127.0.0.1:${port}/tools.html${id ? `?tool=${encodeURIComponent(id)}` : ''}`;

// ---------------------------------------------------------------- injectable I/O (tests pass fakes)
export interface ToolsDeps {
  platform: string;
  arch: string;
  home: string;
  env: Record<string, string | undefined>;
  helperRoot: string;
  exists(p: string): boolean;
  readdir(p: string): string[];
  readText(p: string): string | null;
  /** Run a program (no shell) and return exit code + stdout/stderr. Must time out. */
  exec(file: string, args: string[]): Promise<{ code: number; out: string }>;
  /** GET a loopback URL. */
  http(url: string): Promise<{ status: number; body: string } | null>;
  settings(): { blenderPath?: string; comfyUrl?: string };
  /** Called before each detection run (the real one re-reads config/settings.json). */
  prepare?(): Promise<void>;
  launch: Launcher;
  now(): number;
}
export interface Launcher {
  openUrl(url: string, os: ToolOs): Promise<void>;
  runInTerminal(command: string, title: string, os: ToolOs): Promise<void>;
}

const execText = (file: string, args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
  try {
    execFile(file, args, { timeout: 10_000, windowsHide: true, maxBuffer: 1 << 20, shell: false }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  } catch { resolve({ code: 1, out: '' }); }
});

async function httpGet(url: string): Promise<{ status: number; body: string } | null> {
  const u = new URL(url);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return null; // loopback probes only
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1500);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'error' });
    const body = (await r.text()).slice(0, 64 * 1024);
    return { status: r.status, body };
  } catch { return null; } finally { clearTimeout(t); }
}

/** The real launcher. VTP_TOOLS_DRYRUN=1 only logs (team test servers). */
export const realLauncher: Launcher = {
  async openUrl(url, o) {
    if (process.env.VTP_TOOLS_DRYRUN === '1') { console.log(`[tools] (dry run) would open ${url}`); return; }
    const [cmd, args] = o === 'win' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : o === 'mac' ? ['open', [url]] : ['xdg-open', [url]];
    // no xdg-open (minimal Linux) must not crash the helper: an unhandled spawn error would
    const c = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', (e) => console.warn(`[tools] could not open ${url}: ${e.message}`));
    c.unref();
  },
  async runInTerminal(command, title, o) {
    if (!RUNNABLE_COMMAND.test(command)) throw new Error('refused: not a catalogue install command');
    if (process.env.VTP_TOOLS_DRYRUN === '1') { console.log(`[tools] (dry run) would open a terminal: ${command}`); return; }
    if (o === 'win') {
      // same pattern as /api/aiconnect/install-blender: a visible console; winget shows its agreement prompts to the user
      spawn('cmd.exe', ['/c', 'start', `"${title.replace(/[^\w .()+-]/g, '')}"`, 'cmd', '/k', command], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else if (o === 'mac') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "${command}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    } else throw new Error('Linux: copy the command into your terminal');
  },
};

export function realDeps(): ToolsDeps {
  return {
    platform: process.platform, arch: process.arch, home: os.homedir(), env: process.env,
    helperRoot: ROOT,
    exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
    readdir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
    readText: (p) => { try { const s = fs.statSync(p); return s.size < 1 << 20 ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } },
    exec: execText, http: httpGet,
    settings: () => settingsCache, prepare: refreshSettings,
    launch: realLauncher, now: () => Date.now(),
  };
}
// settings are read lazily (server/settings.ts touches config/ on import); refreshed on every detection run
let settingsCache: { blenderPath?: string; comfyUrl?: string } = {};
async function refreshSettings() {
  try { const m = await import('./settings.ts'); const s = m.loadSettings(); settingsCache = { blenderPath: s.blenderPath, comfyUrl: s.comfyUrl }; } catch { /* keep */ }
}

// ---------------------------------------------------------------- detection
function pathEnv(d: ToolsDeps, o: ToolOs): PathEnv {
  return { home: d.home, vars: d.env, sep: o === 'win' ? '\\' : '/', helperRoot: d.helperRoot };
}
const join = (o: ToolOs, a: string, b: string) => (a.endsWith(o === 'win' ? '\\' : '/') ? a + b : a + (o === 'win' ? '\\' : '/') + b);

/** Expand one `*` per segment against the disk (newest-looking names first). */
export function globPaths(d: ToolsDeps, o: ToolOs, p: string): string[] {
  const sep = o === 'win' ? '\\' : '/';
  const parts = p.split(sep);
  let acc: string[] = [parts[0] === '' ? '' : parts[0]];
  for (const seg of parts.slice(1)) {
    const next: string[] = [];
    for (const base of acc) {
      if (!seg.includes('*')) { next.push(`${base}${sep}${seg}`); continue; }
      const re = new RegExp(`^${seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, o === 'win' ? 'i' : '');
      const names = d.readdir(base === '' ? sep : /^[A-Za-z]:$/.test(base) ? base + sep : base).filter((n) => re.test(n)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })); // ("C:" alone would be that drive's current folder)
      for (const n of names) next.push(`${base}${sep}${n}`);
    }
    acc = next;
    if (!acc.length) break;
  }
  return acc;
}

/** Ordered candidate executables for an entry on this OS (only ones that exist on disk). */
export function exeCandidates(entry: ToolEntry, o: ToolOs, d: ToolsDeps): string[] {
  const ex = entry.detect.exe;
  if (!ex) return [];
  const pe = pathEnv(d, o);
  const out: string[] = [];
  if (entry.id === 'blender') { const c = d.settings().blenderPath?.trim(); if (c) out.push(c); }
  if (ex.env && d.env[ex.env]) out.push(String(d.env[ex.env]));
  // PATH first for names (that's what VTube Pro itself will run), then the known install places
  const pathVar = d.env.PATH ?? d.env.Path ?? '';
  const exts = o === 'win' ? ['.exe'] : [''];
  for (const name of ex.names) for (const dir of pathVar.split(o === 'win' ? ';' : ':')) if (dir.trim()) for (const e of exts) out.push(join(o, dir.trim(), name + e));
  for (const raw of ex.paths?.[o] ?? []) { const p = expandPath(raw, pe); if (p) out.push(...(p.includes('*') ? globPaths(d, o, p) : [p])); }
  const seen = new Set<string>();
  return out.filter((p) => { const k = o === 'win' ? p.toLowerCase() : p; if (seen.has(k)) return false; seen.add(k); return d.exists(p); });
}

/** Find one tool. Pure I/O through `d`; never installs, never opens windows. */
export async function detectTool(entry: ToolEntry, o: ToolOs, d: ToolsDeps): Promise<Finding> {
  if (!entry.os[o].supported) return { found: false };
  let f: Finding = { found: false };
  let note: string | undefined;
  const ex = entry.detect.exe;
  if (ex) {
    for (const exe of exeCandidates(entry, o, d)) {
      const r = await d.exec(exe, ex.args);
      const p = parseOutput(ex.parser, r.out, r.code);
      if (p.ok) { f = { found: true, version: p.version, path: exe, via: 'exe', ...(p.running !== undefined ? { running: p.running } : {}), ...(p.note ? { note: p.note } : {}) }; break; }
      note ??= p.note;
    }
  }
  if (!f.found && entry.detect.files?.[o]) {
    const pe = pathEnv(d, o);
    for (const raw of entry.detect.files[o]!) {
      const p = expandPath(raw, pe);
      if (!p) continue;
      const hit = p.includes('*') ? globPaths(d, o, p).find((x) => d.exists(x)) : d.exists(p) ? p : undefined;
      if (hit) { f = { found: true, path: hit, via: 'file' }; break; }
    }
    if (f.found && !entry.included && entry.detect.files[o]!.length && entry.id === 'blender' && /flatpak/.test(f.path ?? '')) f.note = 'Installed as a Flatpak: set Blender’s path in Settings so VTube Pro can run it.';
    if (f.found && o === 'win' && entry.detect.registry) {
      for (const key of entry.detect.registry) {
        const r = await d.exec('reg.exe', ['query', key, '/v', 'DisplayVersion']);
        const p = parseOutput('reg-version', r.out, r.code);
        if (p.ok) { f.version = p.version; break; }
      }
    }
    if (f.found && o === 'mac' && entry.detect.plist) {
      const txt = d.readText(entry.detect.plist);
      const p = txt ? parseOutput('plist-version', txt) : { ok: false };
      if (p.ok) f.version = (p as { version?: string }).version;
    }
  }
  if (entry.detect.http) {
    let url = entry.detect.http.url;
    if (entry.detect.http.settingKey === 'comfyUrl') {
      const c = d.settings().comfyUrl?.trim();
      try { if (c) { const u = new URL(c); if (u.protocol === 'http:' && u.hostname === '127.0.0.1') url = new URL('/system_stats', u).toString(); } } catch { /* default */ }
    }
    const r = await d.http(url);
    const p = r ? parseOutput(entry.detect.http.parser, r.body, r.status) : { ok: false } as const;
    if (p.ok) {
      f = { ...f, found: true, running: true, via: f.via ?? 'http', ...(f.version ? {} : p.version ? { version: p.version } : {}), ...(p.note ? { note: p.note } : {}) };
    } else if (f.found && entry.endpoint) f.running = false;
  }
  if (!f.found && note) f.note = note;
  return f;
}

/** Detect everything, in dependency order (requires first). */
export async function detectAll(d: ToolsDeps, list: readonly ToolEntry[] = TOOL_CATALOG): Promise<ToolsReport> {
  const o = toolOs(d.platform);
  if (!o) throw new Error(`Unsupported platform ${d.platform}`);
  const finds = await Promise.all(list.map((t) => detectTool(t, o, d).catch((): Finding => ({ found: false }))));
  const statuses: Record<string, ToolStatus> = {};
  const order = [...list.keys()].sort((a, b) => (list[a].requires?.length ?? 0) - (list[b].requires?.length ?? 0));
  for (const i of order) statuses[list[i].id] = decideState(list[i], o, finds[i], statuses);
  return { v: 1, os: o, arch: d.arch, checkedAt: d.now(), tools: list.map((t) => statuses[t.id]) };
}

// ---------------------------------------------------------------- consent
export interface ConsentGrant { token: string; toolId: string; methodId: string; os: ToolOs; origin: string; exp: number }
export class ConsentStore {
  private grants = new Map<string, ConsentGrant>();
  constructor(private now: () => number, private ttlMs = 120_000) {}
  issue(toolId: string, methodId: string, o: ToolOs, origin: string): ConsentGrant {
    this.sweep();
    if (this.grants.size > 50) this.grants.clear(); // nobody legitimately holds 50 open dialogs
    const g: ConsentGrant = { token: crypto.randomBytes(24).toString('base64url'), toolId, methodId, os: o, origin, exp: this.now() + this.ttlMs };
    this.grants.set(g.token, g);
    return g;
  }
  /** Single use: a matching, unexpired grant is consumed. */
  take(token: unknown, toolId: string, methodId: string, o: ToolOs, origin: string): boolean {
    if (typeof token !== 'string') return false;
    const g = this.grants.get(token);
    if (!g) return false;
    this.grants.delete(token);
    return g.exp > this.now() && g.toolId === toolId && g.methodId === methodId && g.os === o && g.origin === origin;
  }
  private sweep() { const t = this.now(); for (const [k, g] of this.grants) if (g.exp <= t) this.grants.delete(k); }
}

/** Carry out a consented plan. Throws on anything outside the catalogue's rules. */
export async function carryOut(entry: ToolEntry, plan: InstallPlan, d: ToolsDeps): Promise<string> {
  const m = entry.os[plan.os].methods.find((x) => x.id === plan.methodId);
  if (!m) throw new Error('unknown method');
  if (m.kind === 'open-url') {
    if (!m.url || !isOfficialUrl(entry, m.url)) throw new Error('not an official page');
    await d.launch.openUrl(m.url, plan.os);
    return `We opened ${new URL(m.url).hostname} in your browser. Download ${entry.name} there, run it, then press “Check again”.`;
  }
  if (!m.runnable || !m.command || !RUNNABLE_COMMAND.test(m.command)) throw new Error('copy-only');
  if ((m.command.startsWith('winget') && plan.os !== 'win') || (m.command.startsWith('brew') && plan.os !== 'mac')) throw new Error('wrong OS');
  await d.launch.runInTerminal(m.command, `VTube Pro - install ${entry.name}`, plan.os);
  return `A window opened and is installing ${entry.name}. Answer its questions there; when it says it’s done, press “Check again”.`;
}

// ---------------------------------------------------------------- HTTP
/** A page on this computer (no Origin: curl / tools; or a loopback Origin). Everything else = a web page. */
export function isLocalCaller(origin: string | undefined): boolean {
  if (!origin) return true;
  try { const u = new URL(origin); return /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(u.hostname); } catch { return false; }
}

export function createToolsRoutes(deps: () => ToolsDeps = realDeps): Router {
  const r = Router();
  let cache: { at: number; rep: ToolsReport } | null = null;
  let running: Promise<ToolsReport> | null = null;
  let consent: ConsentStore | null = null;
  const lastLaunch = new Map<string, number>();
  const store = (d: ToolsDeps) => (consent ??= new ConsentStore(d.now));

  const report = async (d: ToolsDeps, refresh: boolean) => {
    if (!refresh && cache && d.now() - cache.at < 60_000) return cache.rep;
    running ??= (async () => { await d.prepare?.(); return detectAll(d); })().finally(() => { running = null; });
    const rep = await running;
    cache = { at: d.now(), rep };
    return rep;
  };
  const originOf = (req: Request) => (typeof req.headers.origin === 'string' ? req.headers.origin : '');
  const bad = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) => { res.status(status).json({ error, ...extra }); };

  r.get('/api/tools', async (req, res) => {
    const d = deps();
    const rep = await report(d, req.query.refresh === '1');
    const local = isLocalCaller(originOf(req) || undefined);
    const win = rep.os === 'win';
    res.setHeader('Cache-Control', 'no-store');
    res.json(local ? rep : { ...rep, tools: rep.tools.map((t) => (t.path ? { ...t, path: redactPath(t.path, d.home, win) } : t)) });
  });

  r.post('/api/tools/:id/plan', async (req, res) => {
    const d = deps();
    const o = toolOs(d.platform);
    const entry = getTool(String(req.params.id));
    if (!entry || !o) return bad(res, 404, 'There is no such tool.');
    const plan = planFor(entry, o, String(req.body?.method ?? ''));
    if (!plan) return bad(res, 400, entry.os[o].supported ? 'That install option does not exist for this computer.' : entry.os[o].why ?? 'Not available on this computer.');
    if (!plan.runnable) { res.json({ plan }); return; } // copy-only: the user runs it themselves
    if (!isLocalCaller(originOf(req) || undefined)) {
      // a web page: open-url plans it can do itself (window.open of the official page); package-manager plans are
      // confirmed on this PC
      res.json({ plan, localUrl: localToolsPage(Number(req.socket.localPort) || 5191, entry.id) });
      return;
    }
    const g = store(d).issue(entry.id, plan.methodId, o, originOf(req));
    res.json({ plan, consent: { token: g.token, expiresIn: Math.round((g.exp - d.now()) / 1000) } });
  });

  r.post('/api/tools/:id/install', async (req, res) => {
    const d = deps();
    const o = toolOs(d.platform);
    const entry = getTool(String(req.params.id));
    if (!entry || !o) return bad(res, 404, 'There is no such tool.');
    const methodId = String(req.body?.method ?? '');
    if (!isLocalCaller(originOf(req) || undefined)) return bad(res, 403, 'Installing only works from VTube Pro on this computer.', { code: 'local-only', localUrl: localToolsPage(Number(req.socket.localPort) || 5191, entry.id) });
    if (req.body?.iUnderstand !== true) return bad(res, 400, 'Tick “I understand” first.', { consent: true });
    if (!store(d).take(req.body?.token, entry.id, methodId, o, originOf(req))) return bad(res, 403, 'That confirmation expired. Press Install again.', { consent: true });
    const plan = planFor(entry, o, methodId);
    if (!plan || !plan.runnable) return bad(res, 400, 'Copy the command into your terminal instead.');
    const k = `${entry.id}:${methodId}`;
    if (d.now() - (lastLaunch.get(k) ?? 0) < 10_000) return bad(res, 429, 'It’s already opening: give it a few seconds.');
    lastLaunch.set(k, d.now());
    try {
      const next = await carryOut(entry, plan, d);
      cache = null; // the next GET re-detects
      res.json({ ok: true, next });
    } catch (e) {
      bad(res, 500, `Couldn’t start it: ${(e as Error).message}. Use the official page instead.`);
    }
  });
  return r;
}

export const toolsRoutes = createToolsRoutes();
