// AI connectors: config (config/aiconnect.json), the local approval queue, MCP client config writers (Claude Desktop),
// and detection of local helpers (Ollama, LM Studio, ComfyUI, Blender). Routes: server/routes/aiconnect.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, PORT, ROOT } from './paths.ts';
import { DEFAULT_SCOPES, normalizeScopes, type ApprovalRequest, type Decision, type ScopeSettings } from './mcpScopes.ts';

// ---------------------------------------------------------------- config
export interface ProviderConf { baseUrl?: string; model?: string; /** 'local' connector: which runner (ollama, lmstudio ...) */ kind?: string }
export interface AiConnectConfig {
  scopes: ScopeSettings;
  remote: { enabled: boolean; token: string };
  localToken: string; // for the localhost streamable-HTTP MCP at http://127.0.0.1:5191/mcp
  providers: Record<string, ProviderConf>; // built-in AI host (a model on this PC): ollama / lmstudio / llamacpp / local
}
export const CONF_FILE = process.env.VTP_AICONNECT_CONFIG ?? path.join(CONFIG_DIR, 'aiconnect.json');
const newToken = () => crypto.randomBytes(32).toString('base64url');

/** Only a model on this PC is kept: an address, a model name and the runner kind. Anything else an older config file held is dropped. */
function cleanProviders(v: unknown): Record<string, ProviderConf> {
  const out: Record<string, ProviderConf> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [id, p] of Object.entries(v as Record<string, unknown>)) {
    if (!p || typeof p !== 'object') continue;
    const x = p as Record<string, unknown>;
    out[id] = {
      ...(typeof x.baseUrl === 'string' ? { baseUrl: x.baseUrl } : {}),
      ...(typeof x.model === 'string' ? { model: x.model } : {}),
      ...(typeof x.kind === 'string' ? { kind: x.kind } : {}),
    };
  }
  return out;
}

export function loadConf(): AiConnectConfig {
  let raw: Partial<AiConnectConfig> = {};
  try { raw = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')); } catch { /* first run */ }
  const c: AiConnectConfig = {
    scopes: normalizeScopes(raw.scopes ?? DEFAULT_SCOPES),
    remote: { enabled: !!raw.remote?.enabled, token: String(raw.remote?.token ?? '') },
    localToken: String(raw.localToken ?? ''),
    providers: cleanProviders(raw.providers),
  };
  // an older config may hold a pasted AI key under a provider: this build never uses one, so any field other than the address, model and kind is wiped from the file now
  const stale = Object.values((raw.providers ?? {}) as Record<string, unknown>).some((p) => !!p && typeof p === 'object' && Object.keys(p).some((k) => !['baseUrl', 'model', 'kind'].includes(k)));
  if (!c.localToken) c.localToken = newToken();
  if (!raw.localToken || stale) saveConf(c);
  return c;
}
export function saveConf(c: AiConnectConfig) {
  fs.mkdirSync(path.dirname(CONF_FILE), { recursive: true });
  const tmp = CONF_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CONF_FILE);
}
export function setRemote(enabled: boolean): AiConnectConfig {
  const c = loadConf();
  c.remote = { enabled, token: enabled ? c.remote.token || newToken() : c.remote.token };
  saveConf(c);
  return c;
}
/** For the page. */
export function publicConf(c = loadConf()) {
  const providers = Object.fromEntries(Object.entries(c.providers).map(([k, v]) => [k, { baseUrl: v.baseUrl, model: v.model, kind: v.kind }]));
  return { scopes: c.scopes, remote: c.remote, localToken: c.localToken, providers };
}

// ---------------------------------------------------------------- approvals (the click in the studio)
export interface Pending extends ApprovalRequest { id: string; createdAt: number; expiresAt: number; summary: string }
const pending = new Map<string, { req: Pending; resolve: (d: Decision) => void }>();
const sessionGrants = new Map<string, number>(); // `${client}|${tool}` -> until (ms); "approve for 30 min"
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

function summarizeArgs(r: ApprovalRequest): string {
  const a = (r.args ?? {}) as Record<string, unknown>;
  if (typeof a.script === 'string') return a.script;
  if (a.package) { const p = a.package as Record<string, unknown>; return `Creation package "${p.id}" (${p.action ?? 'create'} ${p.kind ?? 'room'})\n\n${String((p.build as any)?.script ?? '').slice(0, 20000)}`; }
  return JSON.stringify(a, null, 2).slice(0, 20000);
}

export function requestApproval(r: ApprovalRequest, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<Decision> {
  const key = `${r.client}|${r.tool}`;
  if ((sessionGrants.get(key) ?? 0) > Date.now()) return Promise.resolve({ approved: true, reason: 'approved for this session' });
  const id = crypto.randomUUID();
  const req: Pending = { ...r, id, createdAt: Date.now(), expiresAt: Date.now() + timeoutMs, summary: summarizeArgs(r) };
  return new Promise<Decision>((resolve) => {
    const t = setTimeout(() => { if (pending.delete(id)) { resolve({ approved: false, reason: `timed out after ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${Math.round(timeoutMs / 1000)} seconds`}` }); pendingChanged(); } }, timeoutMs);
    pending.set(id, { req, resolve: (d) => { clearTimeout(t); resolve(d); } });
    pendingChanged();
    showApprovalPage(id);
  });
}

// ---------------------------------------------------------------- polled approvals (lane to3d, beta.12)
// Claude Desktop cancels any tool call after ~60 s (not configurable), so a gated call must not block for the 5 minute
// approval window. requestApprovalPolled waits at most `waitMs` (40 s): approved / denied in that time = the answer;
// still waiting = { pending: true } and the SAME request stays on the approval page. When the AI calls again with the
// same tool + arguments it joins that request (or takes its answer, kept 10 min). Same queue, page and studio card.
// An OK is used by ONE call only (two identical calls in flight: the first takes it, the other is told it was used).
// An OK that lands in the last quarter of the wait (at most 15 s) is kept for the AI's next identical call, so the tool
// itself then starts with Claude's full ~60 s instead of the few seconds left of this one.
export const POLL_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const POLL_WAIT_MAX_MS = 40_000;
const lateMs = (waitMs: number) => Math.min(15_000, Math.floor(waitMs / 4));
const WAITING: Decision = { approved: false, pending: true, reason: 'waiting for the user' };
const polled = new Map<string, { p: Promise<Decision>; done: Decision | null; until: number }>();
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const approvalKey = (r: ApprovalRequest) => crypto.createHash('sha256').update(`${r.client}|${r.tool}|${stable(r.args)}`).digest('hex');

export async function requestApprovalPolled(r: ApprovalRequest, waitMs = POLL_WAIT_MAX_MS): Promise<Decision> {
  waitMs = Math.min(Math.max(0, Number(waitMs) || 0), POLL_WAIT_MAX_MS);
  const now = Date.now();
  for (const [k, v] of polled) if (v.done && v.until < now) polled.delete(k);
  const key = approvalKey(r);
  let e = polled.get(key);
  if (e?.done) { polled.delete(key); return e.done; }          // answered since the last call: use the answer once
  if (!e) {
    const entry: { p: Promise<Decision>; done: Decision | null; until: number } = { p: Promise.resolve({ approved: false }), done: null, until: 0 };
    entry.p = requestApproval(r, POLL_APPROVAL_TIMEOUT_MS).then((d) => { entry.done = d; entry.until = Date.now() + 10 * 60 * 1000; return d; });
    polled.set(key, entry);
    e = entry;
  }
  const mine = e;
  const got = await Promise.race([mine.p, new Promise<null>((res) => setTimeout(() => res(null), waitMs).unref?.())]);
  if (!got) return WAITING;
  if (!got.approved) { if (polled.get(key) === mine) polled.delete(key); return got; }   // a no is the same for every caller
  if (polled.get(key) !== mine) return { approved: false, reason: 'That OK was already used by the same request. Call again if you still need it (a new request).' };
  if (Date.now() - now > waitMs - lateMs(waitMs)) return WAITING;   // late: kept for the next identical call
  polled.delete(key);
  return got;
}

// ---------------------------------------------------------------- telling the user (2026-10-03 report: "the approval
// page never opened, and the studio didn't show it either")
/** Who wants to know when the waiting list changes (server/index.ts: a bus notice to every studio page). */
const pendingListeners = new Set<(waiting: Pending[]) => void>();
export function onPendingChange(cb: (waiting: Pending[]) => void) { pendingListeners.add(cb); return () => pendingListeners.delete(cb); }
function pendingChanged() { const list = listPending(); for (const cb of pendingListeners) { try { cb(list); } catch { /* a listener must not break approvals */ } } }

/** Is a studio page looking? (server/index.ts sets it: pages on the bus that aren't OBS output pages). */
let studioOpen: () => boolean = () => false;
export function setStudioOpen(fn: () => boolean) { studioOpen = fn; }
let opener: (url: string) => void = () => {};
/** server/index.ts: the helper's cross-platform launcher (it only logs under VTP_TOOLS_DRYRUN). */
export function setApprovalOpener(fn: (url: string) => void) { opener = fn; }

let lastPagePoll = 0;
let lastOpen = 0;
/** How long a studio's notice gets before the page opens anyway (VTP_APPROVAL_GRACE_MS: tests only). */
const graceMs = () => Number(process.env.VTP_APPROVAL_GRACE_MS) || 30_000;
/** Tests: forget the once-a-minute limit. */
export function resetApprovalOpenLimit() { lastOpen = 0; lastPagePoll = 0; }
/**
 * Make sure the user SEES the request. The approval page polls every 2 s while open. No studio page open: open the
 * approval page now. A studio page open: it shows "Your AI is waiting for your OK" first; if nobody has looked after
 * 30 s, open the page anyway. At most once a minute. Installed helpers start with VTP_NO_BROWSER=1 (no studio tab at
 * start-up), so the launcher / supervisor also sets VTP_APPROVAL_OPEN=1 for this; tests set neither and never pop a
 * window (before 1.0.0-beta.7 this was Windows-only and the flag above switched it off on every real install).
 */
function showApprovalPage(id: string, afterGrace = false) {
  if (process.env.VTP_NO_BROWSER && process.env.VTP_APPROVAL_OPEN !== '1') return;
  if (!pending.has(id) || Date.now() - lastPagePoll < 10_000) return;
  if (!afterGrace && studioOpen()) { setTimeout(() => showApprovalPage(id, true), graceMs()).unref?.(); return; }
  if (Date.now() - lastOpen < 60_000) return;
  lastOpen = Date.now();
  try { opener(`http://127.0.0.1:${process.env.VTP_PORT ?? 5191}/aiconnect#apprBox`); } catch { /* the studio notice and the AI's message still say where */ }
}
export const listPending = (fromPage = false) => { if (fromPage) lastPagePoll = Date.now(); return [...pending.values()].map((p) => p.req); };
export function decidePending(id: string, decision: 'approve' | 'session' | 'deny'): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  if (decision === 'session') sessionGrants.set(`${p.req.client}|${p.req.tool}`, Date.now() + 30 * 60 * 1000);
  p.resolve(decision === 'deny' ? { approved: false, reason: 'denied by the user' } : { approved: true });
  pendingChanged();
  return true;
}

// ---------------------------------------------------------------- MCP client configs
/** Command that starts the stdio MCP server from ANY working directory (Claude Desktop has no cwd setting). */
/**
 * The node an AI app should start the MCP server with: a path that survives updates (lane toolsetup, beta.12).
 *   * a release: its own runtime (runtime/node/node.exe, runtime/node/bin/node), whatever node runs the server right now;
 *   * Homebrew: the versioned Cellar path (/opt/homebrew/Cellar/node/22.9.0/bin/node) is deleted by `brew upgrade`, so
 *     use Homebrew's stable link (<prefix>/opt/node[@22]/bin/node, else <prefix>/bin/node);
 *   * anything else: this node.
 */
export function stableNode(execPath: string, root: string, platform: NodeJS.Platform, exists: (p: string) => boolean = fs.existsSync): string {
  const rt = platform === 'win32' ? path.join(root, 'runtime', 'node', 'node.exe') : path.join(root, 'runtime', 'node', 'bin', 'node');
  if (exists(rt)) return rt;
  const brew = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(execPath.replace(/\\/g, '/'));
  if (brew) for (const p of [`${brew[1]}/opt/${brew[2]}/bin/node`, `${brew[1]}/bin/node`]) if (exists(p)) return p;
  return execPath;
}

/** The MCP server's port when the helper does not use the default 5191 (helper.config.json "port" / VTP_PORT). */
const launchEnv = (): Record<string, string> | undefined => (PORT !== 5191 ? { VTP_PORT: String(PORT) } : undefined);

export function stdioLaunch(root = ROOT): { command: string; args: string[]; env?: Record<string, string> } {
  // helper-hardening: a hardened release ships the bundled MCP entry (dist-helper/mcp.mjs) and may strip server/ source,
  // so prefer the bundle when it exists; a source install (the owner) still runs server/mcp.ts through tsx.
  const node = stableNode(process.execPath, root, process.platform);
  const env = launchEnv();
  const bundled = path.join(root, 'dist-helper', 'mcp.mjs');
  if (fs.existsSync(bundled)) return { command: node, args: [bundled], ...(env ? { env } : {}) };
  return { command: node, args: [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'server', 'mcp.ts')], ...(env ? { env } : {}) };
}

/** Where Claude Desktop keeps its config (support.claude.com "Getting started with local MCP servers on Claude Desktop"). */
export function claudeDesktopCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  if (platform === 'win32') {
    const out: string[] = [];
    if (env.APPDATA) out.push(path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'));
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    return out;
  }
  if (platform === 'darwin') return [path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')];
  return [path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')];
}

export function detectClaudeDesktop(cands = claudeDesktopCandidates()) {
  // Claude Desktop is "installed" when its data folder exists; the config file itself may not exist yet.
  const found = cands.find((f) => fs.existsSync(f)) ?? cands.find((f) => fs.existsSync(path.dirname(f))) ?? null;
  let hasEntry = false;
  if (found && fs.existsSync(found)) { try { hasEntry = !!JSON.parse(fs.readFileSync(found, 'utf8'))?.mcpServers?.['vtube-pro']; } catch { /* unreadable */ } }
  return { installed: !!found, configPath: found ?? cands[0] ?? null, hasEntry };
}

/**
 * Add (or refresh) the "vtube-pro" entry in a Claude Desktop config. Backs the old file up next to it first
 * (claude_desktop_config.json.vtp-backup-<time>), keeps every other key, refuses to touch a file that is not valid JSON.
 */
export function writeClaudeDesktopEntry(configPath: string, launch = stdioLaunch()): { backup: string | null; configPath: string } {
  let cfg: Record<string, any> = {};
  let backup: string | null = null;
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    try { cfg = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error(`${configPath} is not valid JSON, so it was left alone. Fix or delete it, then try again.`); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${configPath} does not hold a JSON object; left alone.`);
    backup = `${configPath}.vtp-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(configPath, backup);
  } else fs.mkdirSync(path.dirname(configPath), { recursive: true });
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), 'vtube-pro': { command: launch.command, args: launch.args, env: { VTP_MCP_CLIENT: 'Claude Desktop', ...(launch.env ?? {}) } } };
  const tmp = configPath + '.vtp_tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, configPath);
  return { backup, configPath };
}

/** Copy-paste snippets for every client (exact commands, this PC's paths). */
export function snippets(localToken: string, port = 5191) {
  const l = stdioLaunch();
  const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const json = JSON.stringify({ mcpServers: { 'vtube-pro': { command: l.command, args: l.args, ...(l.env ? { env: l.env } : {}) } } }, null, 2);
  return {
    claudeDesktopJson: json,
    claudeCode: `claude mcp add --scope user vtube-pro -- ${[l.command, ...l.args].map(q).join(' ')}`,
    grokBuild: `grok mcp add vtube-pro -- ${[l.command, ...l.args].map(q).join(' ')}`,
    grokToml: `[mcp_servers.vtube-pro]\ncommand = ${JSON.stringify(l.command)}\nargs = ${JSON.stringify(l.args)}`,
    localHttpUrl: `http://127.0.0.1:${port}/mcp`,
    localHttpHeader: `Authorization: Bearer ${localToken}`,
  };
}

// ---------------------------------------------------------------- local helpers (fully local path)
async function getJson(url: string, ms = 1200): Promise<any | null> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
}
/** Model families that do tool calling well in Ollama / LM Studio; others use the JSON-plan fallback. */
export const TOOL_MODELS = /(qwen2\.5|qwen3|qwq|llama3\.[123]|llama-3\.[123]|mistral-(nemo|small|large)|mistral|mixtral|command-r|firefunction|hermes|granite3|gpt-oss|devstral|deepseek-v3|glm-4|gemma-?4)/i;
export async function detectLocal(urls = { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234', comfy: 'http://127.0.0.1:8188' }) {
  // ComfyUI Desktop listens on :8000 by default, Portable / manual installs on :8188 (ai-local, shared/localAi/catalog.ts)
  const comfyUrls = [...new Set([urls.comfy, 'http://127.0.0.1:8188', 'http://127.0.0.1:8000'])];
  const comfyProbe = async () => { for (const u of comfyUrls) { const j = await getJson(`${u}/system_stats`); if (j && typeof j === 'object' && (j.system || j.devices)) return { url: u, j }; } return null; };
  const [ol, lm, cfHit] = await Promise.all([getJson(`${urls.ollama}/api/tags`), getJson(`${urls.lmstudio}/v1/models`), comfyProbe()]);
  const cf = cfHit?.j ?? null;
  const mark = (name: string) => ({ name, tools: TOOL_MODELS.test(name) });
  return {
    ollama: { url: urls.ollama, running: !!ol, models: ((ol?.models ?? []) as { name: string }[]).map((m) => mark(m.name)) },
    lmstudio: { url: urls.lmstudio, running: !!lm, models: ((lm?.data ?? []) as { id: string }[]).map((m) => mark(m.id)) },
    comfy: { url: cfHit?.url ?? urls.comfy, running: !!cf, vramMB: cf?.devices?.[0]?.vram_total ? Math.round(cf.devices[0].vram_total / 1048576) : null },
  };
}
