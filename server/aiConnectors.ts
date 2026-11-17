// "Connect an AI in 3 steps" (lane ai-connect, docs/AI_CONNECT.md section 0): the AI app the user already has talks to
// VTube Pro's local MCP server (this server on 127.0.0.1:5191). VTube Pro holds no AI account and no key, and never calls
// a cloud AI service: the only AI it talks to itself is a model running on this PC (the "local" connector).
//
// The connectors (what each one really supports was checked on 2026-10-01; sources in CITES):
//   claude-desktop   local stdio MCP: we write the "vtube-pro" entry into claude_desktop_config.json (Windows, macOS)
//   claude-code      local stdio MCP, user scope: the official `claude mcp add --scope user` CLI writes ~/.claude.json
//                    (lane create-gating; we run that CLI when we can find it, else we add the same entry ourselves)
//   chatgpt-desktop  local stdio MCP: ChatGPT desktop shares the Codex MCP config (~/.codex/config.toml [mcp_servers.*])
//   codex-cli        the same ~/.codex/config.toml as ChatGPT desktop (OpenAI: they "share MCP configuration")
//   grok-build       local stdio MCP: Grok Build reads ~/.grok/config.toml [mcp_servers.*] (grok mcp add)
//   cursor           local stdio MCP: Cursor reads ~/.cursor/mcp.json (mcpServers, "type": "stdio") for every project
//   vscode           local stdio MCP: VS Code (Copilot agent mode) reads the user profile's mcp.json ("servers", not
//                    "mcpServers"): %APPDATA%\Code\User, ~/Library/Application Support/Code/User, ~/.config/Code/User
//   gemini-cli       local stdio MCP: Gemini CLI reads ~/.gemini/settings.json "mcpServers" (user scope, `gemini mcp add -s user`)
//   antigravity      local stdio MCP: Google Antigravity 2.x (IDE + agy CLI) shares ONE file, ~/.gemini/config/mcp_config.json
//                    "mcpServers" (older builds: ~/.gemini/antigravity/mcp_config.json, now a link to it). Lane aiskills,
//                    checked 2026-10-06 on a real install (the .migrated marker + the link) and atamel.dev/posts/2026/07-10.
//                    (cursor / vscode / gemini-cli: lane toolsetup, beta.12 "Set up AI creation", checked 2026-10-06)
//   lm-studio        local stdio MCP: LM Studio (0.3.17+) reads ~/.lmstudio/mcp.json (Cursor's mcpServers notation) and loads
//                    it by itself when the file is saved; it asks before each tool call (owner 2026-10-02: "add support for
//                    helper to connect to LM Studio"). Its local server on :1234 is a different thing: the "local" connector.
//   grok-bot         Grok Bot runs on a computer in the CLOUD, so it cannot start anything on this PC: the only real
//                    path is the opt-in Remote connector (server/mcpRemote.ts, safe tools only) behind a public tunnel,
//                    or the copy-paste instruction pack. The same bridge serves grok.com and ChatGPT on the web.
//   local            Ollama / LM Studio / llama.cpp / vLLM / KoboldCpp / Jan on this PC (OpenAI-compatible), auto-detected;
//                    the helper's built-in AI host (server/aiAgent.ts) talks to it
// Everything here is dependency-injected (fetch, spawn, env, home, fs root) so a test runs against mocks and temp folders
// only: never the real Claude / ChatGPT / Grok config.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDesktopCandidates, stdioLaunch } from './aiconnect.ts';

// ---------------------------------------------------------------- the catalog
export type ConnectorId = 'claude-desktop' | 'claude-code' | 'chatgpt-desktop' | 'codex-cli' | 'grok-build' | 'lm-studio' | 'cursor' | 'vscode' | 'gemini-cli' | 'antigravity' | 'grok-bot' | 'local';
export type ConnectorKind = 'desktop' | 'remote' | 'local';
export interface ConnectorDef {
  id: ConnectorId;
  name: string;
  kind: ConnectorKind;
  /** One plain sentence: what you get. */
  blurb: string;
  /** Where to get the app (official pages only). */
  getUrl: string;
  getLabel: string;
  os: { win32: boolean; darwin: boolean; linux: boolean };
  /** Sources that back what the wizard says (checked 2026-10-01). */
  cites: string[];
}

export const CITES = {
  claudeDesktop: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
  // Claude Code: `claude mcp add [options] <name> -- <command> [args...]`, scopes local / project (.mcp.json) / user (~/.claude.json)
  claudeCodeMcp: 'https://code.claude.com/docs/en/mcp',
  // "Claude Code also keeps ... ~/.claude.json, that it writes for itself ... It holds ... MCP server configurations"
  claudeCodeSettings: 'https://code.claude.com/docs/en/settings',
  // Codex: `codex mcp add <server-name> --env VAR1=VALUE1 -- <stdio server-command>`; ~/.codex/config.toml [mcp_servers.<name>]
  codexMcp: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
  chatgptDesktop: 'https://learn.chatgpt.com/docs/extend/mcp',
  chatgptPlugins: 'https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex',
  grokBuildMcp: 'https://docs.x.ai/build/features/mcp-servers',
  // LM Studio 0.3.17+ is an MCP host: "%USERPROFILE%/.lmstudio/mcp.json" (macOS / Linux "~/.lmstudio/mcp.json"), "Cursor's
  // mcp.json notation", "When you save the mcp.json file, LM Studio will automatically load the MCP servers defined in
  // it", and a confirmation per tool call ("always allow a given tool or allow it only once"). Checked 2026-10-02.
  lmstudioMcp: 'https://lmstudio.ai/docs/app/mcp',
  lmstudioBlog: 'https://lmstudio.ai/blog/mcp',
  // Cursor: "Create ~/.cursor/mcp.json in your home directory for tools available everywhere"; stdio entries: type, command, args, env
  cursorMcp: 'https://cursor.com/docs/context/mcp',
  // VS Code: "MCP: Open User Configuration" opens the user profile's mcp.json; top-level "servers", entries type "stdio"
  vscodeMcp: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
  vscodeMcpRef: 'https://code.visualstudio.com/docs/agents/reference/mcp-configuration',
  // Gemini CLI: user scope "~/.gemini/settings.json", mcpServers.{command,args,env,cwd,timeout}; timeout default 600,000 ms
  geminiMcp: 'https://geminicli.com/docs/tools/mcp-server/',
  // Antigravity 2.x: "~/.gemini/config/mcp_config.json" (global, every surface), workspace ".agents/mcp_config.json"
  antigravityMcp: 'https://atamel.dev/posts/2026/07-10_where_agy_mcp_servers/',
  grokBot: 'https://docs.x.ai/grok-bot',
  grokBotTeams: 'https://docs.x.ai/grok-bot/teams-and-enterprises',
  grokConnectors: 'https://docs.x.ai/grok/connectors',
  grokTunnel: 'https://docs.x.ai/grok/connectors/custom-mcp-tunneling',
} as const;

export const CONNECTORS: readonly ConnectorDef[] = [
  { id: 'claude-desktop', name: 'Claude Desktop', kind: 'desktop', blurb: 'Chat with Claude in its app and let it build rooms, avatars and costumes in VTube Pro.',
    getUrl: 'https://claude.ai/download', getLabel: 'Get Claude Desktop', os: { win32: true, darwin: true, linux: false }, cites: [CITES.claudeDesktop] },
  { id: 'claude-code', name: 'Claude Code', kind: 'desktop', blurb: 'Claude in your terminal or code editor, with VTube Pro\'s tools in every project.',
    getUrl: 'https://code.claude.com/docs/en/setup', getLabel: 'Get Claude Code', os: { win32: true, darwin: true, linux: true }, cites: [CITES.claudeCodeMcp, CITES.claudeCodeSettings] },
  { id: 'chatgpt-desktop', name: 'ChatGPT Desktop', kind: 'desktop', blurb: 'Use ChatGPT\'s desktop app with VTube Pro\'s tools (it runs them on this PC).',
    getUrl: 'https://chatgpt.com/download', getLabel: 'Get the ChatGPT app', os: { win32: true, darwin: true, linux: true }, cites: [CITES.chatgptDesktop, CITES.chatgptPlugins] },
  { id: 'codex-cli', name: 'Codex', kind: 'desktop', blurb: 'OpenAI\'s Codex in your terminal or code editor, with VTube Pro\'s tools.',
    getUrl: 'https://developers.openai.com/codex', getLabel: 'Get Codex', os: { win32: true, darwin: true, linux: true }, cites: [CITES.codexMcp, CITES.chatgptDesktop] },
  { id: 'grok-build', name: 'Grok Build', kind: 'desktop', blurb: 'xAI\'s Grok in your terminal, with VTube Pro\'s tools.',
    getUrl: 'https://x.ai/build', getLabel: 'Get Grok Build', os: { win32: true, darwin: true, linux: true }, cites: [CITES.grokBuildMcp] },
  { id: 'lm-studio', name: 'LM Studio', kind: 'desktop', blurb: 'Chat with a free model on your own computer in LM Studio, with VTube Pro\'s tools.',
    getUrl: 'https://lmstudio.ai/download', getLabel: 'Get LM Studio', os: { win32: true, darwin: true, linux: true }, cites: [CITES.lmstudioMcp, CITES.lmstudioBlog] },
  { id: 'cursor', name: 'Cursor', kind: 'desktop', blurb: 'The Cursor code editor\'s AI, with VTube Pro\'s tools in every project.',
    getUrl: 'https://cursor.com/download', getLabel: 'Get Cursor', os: { win32: true, darwin: true, linux: true }, cites: [CITES.cursorMcp] },
  { id: 'vscode', name: 'VS Code (Copilot)', kind: 'desktop', blurb: 'GitHub Copilot\'s agent mode in Visual Studio Code, with VTube Pro\'s tools.',
    getUrl: 'https://code.visualstudio.com/download', getLabel: 'Get VS Code', os: { win32: true, darwin: true, linux: true }, cites: [CITES.vscodeMcp, CITES.vscodeMcpRef] },
  { id: 'gemini-cli', name: 'Gemini CLI', kind: 'desktop', blurb: 'Google\'s Gemini in your terminal, with VTube Pro\'s tools.',
    getUrl: 'https://geminicli.com/', getLabel: 'Get Gemini CLI', os: { win32: true, darwin: true, linux: true }, cites: [CITES.geminiMcp] },
  { id: 'antigravity', name: 'Antigravity', kind: 'desktop', blurb: 'Google’s Antigravity app and its agy terminal, with VTube Pro’s tools.',
    getUrl: 'https://antigravity.google/download', getLabel: 'Get Antigravity', os: { win32: true, darwin: true, linux: true }, cites: [CITES.antigravityMcp] },
  { id: 'grok-bot', name: 'Grok Bot (and grok.com)', kind: 'remote', blurb: 'Grok Bot works on a computer in the cloud, so it reaches VTube Pro through a private internet address you switch on and off.',
    getUrl: 'https://docs.x.ai/grok-bot', getLabel: 'About Grok Bot', os: { win32: true, darwin: true, linux: true }, cites: [CITES.grokBot, CITES.grokBotTeams, CITES.grokConnectors, CITES.grokTunnel] },
  { id: 'local', name: 'A model on this PC', kind: 'local', blurb: 'Free and private: Ollama, LM Studio or llama.cpp running on your own computer. No account, no key.',
    getUrl: 'https://ollama.com/download', getLabel: 'Get Ollama (free)', os: { win32: true, darwin: true, linux: true }, cites: [] },
];
export const connectorById = (id: string) => CONNECTORS.find((c) => c.id === id);

// ---------------------------------------------------------------- environment (injectable)
export interface Env {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  fetch: typeof fetch;
  spawn: (cmd: string, args: string[], o: SpawnOptions) => ChildProcess;
  now: () => number;
}
export const realEnv = (): Env => ({ env: process.env, platform: process.platform, home: os.homedir(), fetch: globalThis.fetch.bind(globalThis), spawn: nodeSpawn, now: Date.now });

// ---------------------------------------------------------------- desktop MCP clients: where their config lives
export interface ConfigTarget { path: string | null; format: 'json' | 'toml'; supported: boolean; why?: string; /** JSON: the object that holds the servers (VS Code: "servers") */ key?: 'mcpServers' | 'servers' }

/** VS Code's user profile folder (where its user mcp.json lives). */
export function vscodeUserDir(e: Pick<Env, 'env' | 'platform' | 'home'>): string | null {
  if (e.platform === 'win32') return e.env.APPDATA ? path.join(e.env.APPDATA, 'Code', 'User') : null;
  if (e.platform === 'darwin') return path.join(e.home, 'Library', 'Application Support', 'Code', 'User');
  return path.join(e.env.XDG_CONFIG_HOME && path.isAbsolute(e.env.XDG_CONFIG_HOME) ? e.env.XDG_CONFIG_HOME : path.join(e.home, '.config'), 'Code', 'User');
}

export function configTarget(id: ConnectorId, e: Pick<Env, 'env' | 'platform' | 'home'>): ConfigTarget {
  if (id === 'claude-desktop') {
    if (e.platform !== 'win32' && e.platform !== 'darwin') return { path: null, format: 'json', supported: false, why: 'Claude Desktop is made for Windows and macOS only. On Linux, use Claude Code instead (it connects the same way).' };
    const cands = e.platform === 'darwin' ? [path.join(e.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')] : claudeDesktopCandidates(e.env, 'win32');
    const found = cands.find((f) => fs.existsSync(f)) ?? cands.find((f) => fs.existsSync(path.dirname(f))) ?? cands[0] ?? null;
    return { path: found, format: 'json', supported: true };
  }
  if (id === 'claude-code') {
    // user scope lives in ~/.claude.json (CITES.claudeCodeMcp). CLAUDE_CONFIG_DIR moves Claude Code's home files; we only
    // follow it when a .claude.json is really there, otherwise the documented ~/.claude.json.
    const dir = e.env.CLAUDE_CONFIG_DIR && path.isAbsolute(e.env.CLAUDE_CONFIG_DIR) ? e.env.CLAUDE_CONFIG_DIR : null;
    const moved = dir ? path.join(dir, '.claude.json') : null;
    return { path: moved && fs.existsSync(moved) ? moved : path.join(e.home, '.claude.json'), format: 'json', supported: true };
  }
  if (id === 'chatgpt-desktop' || id === 'codex-cli') {
    // "The ChatGPT desktop app, Codex CLI, and IDE extension support MCP servers and share MCP configuration" (CITES.chatgptDesktop)
    const base = e.env.CODEX_HOME && path.isAbsolute(e.env.CODEX_HOME) ? e.env.CODEX_HOME : path.join(e.home, '.codex');
    return { path: path.join(base, 'config.toml'), format: 'toml', supported: true };
  }
  if (id === 'grok-build') return { path: path.join(e.home, '.grok', 'config.toml'), format: 'toml', supported: true }; // CITES.grokBuildMcp
  if (id === 'lm-studio') return { path: path.join(e.home, '.lmstudio', 'mcp.json'), format: 'json', supported: true }; // CITES.lmstudioMcp
  if (id === 'cursor') return { path: path.join(e.home, '.cursor', 'mcp.json'), format: 'json', supported: true }; // CITES.cursorMcp
  if (id === 'gemini-cli') return { path: path.join(e.home, '.gemini', 'settings.json'), format: 'json', supported: true }; // CITES.geminiMcp
  if (id === 'antigravity') { const p = antigravityConfig(e.home); return p ? { path: p, format: 'json', supported: true } : { path: null, format: 'json', supported: false, why: 'Antigravity’s settings file points outside its own folder, so we won’t write to it. Add VTube Pro by hand (“Copy the settings”).' }; } // CITES.antigravityMcp
  if (id === 'vscode') { const d = vscodeUserDir(e); return d ? { path: path.join(d, 'mcp.json'), format: 'json', supported: true, key: 'servers' } : { path: null, format: 'json', supported: false, why: 'We could not find VS Code\'s settings folder.' }; }
  return { path: null, format: 'json', supported: false };
}

/**
 * Antigravity's MCP file. 2.x: ~/.gemini/config/mcp_config.json (one file for the IDE and the agy CLI). An older install
 * that only has ~/.gemini/antigravity/mcp_config.json as a real file keeps using it; when that old path is a link (2.x
 * migrated it) we write its target, never the link itself (a rename over a link would cut it).
 */
export function antigravityConfig(home: string): string | null {
  const v2 = path.join(home, '.gemini', 'config', 'mcp_config.json');
  const v1 = path.join(home, '.gemini', 'antigravity', 'mcp_config.json');
  let link = false;
  try { link = fs.lstatSync(v1).isSymbolicLink(); } catch { /* no old file */ }
  if (link) {
    // follow the link only while it stays inside ~/.gemini (Grok review: a link must not aim our write anywhere else)
    let rp = '', base = '';
    try { rp = fs.realpathSync(v1); } catch { rp = ''; }
    try { base = fs.realpathSync(path.join(home, '.gemini')); } catch { base = path.join(home, '.gemini'); }
    const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const rel = rp ? path.relative(base, rp) : '';
    if (!rp || !rel || rel.startsWith('..') || path.isAbsolute(rel) || same(rp, base)) return null;
    return rp;
  }
  if (!fs.existsSync(path.join(home, '.gemini', 'config')) && fs.existsSync(v1)) return v1;
  return v2;
}

/** Is the app itself installed? Best effort, never required ("we can't tell" is a fine answer). */
export function appInstalled(id: ConnectorId, e: Pick<Env, 'env' | 'platform' | 'home'>): boolean | null {
  if (id === 'claude-desktop') { const t = configTarget(id, e); return t.path ? fs.existsSync(path.dirname(t.path)) : false; }
  if (id === 'grok-build') return onPath(['grok'], e) || fs.existsSync(path.join(e.home, '.grok'));
  // LM Studio makes ~/.lmstudio on first run; its CLI is `lms`
  if (id === 'lm-studio') return fs.existsSync(path.join(e.home, '.lmstudio')) || onPath(['lms'], e) ? true : null;
  if (id === 'claude-code') return claudeCodeCli(e) || fs.existsSync(path.join(e.home, '.claude')) || fs.existsSync(path.join(e.home, '.claude.json')) ? true : null;
  if (id === 'codex-cli') return onPath(['codex'], e) || fs.existsSync(path.join(e.home, '.codex')) ? true : null;
  if (id === 'cursor') return onPath(['cursor'], e) || fs.existsSync(path.join(e.home, '.cursor')) || (e.platform === 'darwin' && fs.existsSync('/Applications/Cursor.app')) ? true : null;
  if (id === 'vscode') { const d = vscodeUserDir(e); return onPath(['code'], e) || (!!d && fs.existsSync(d)) || (e.platform === 'darwin' && fs.existsSync('/Applications/Visual Studio Code.app')) ? true : null; }
  if (id === 'gemini-cli') return onPath(['gemini'], e) || fs.existsSync(path.join(e.home, '.gemini', 'settings.json')) ? true : null;
  if (id === 'antigravity') {
    if (onPath(['agy', 'antigravity'], e)) return true;
    if (e.platform === 'win32' && e.env.LOCALAPPDATA && fs.existsSync(path.join(e.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'Antigravity.exe'))) return true;
    if (e.platform === 'darwin' && fs.existsSync('/Applications/Antigravity.app')) return true;
    // Linux: the tarball / APT installs land in /opt/antigravity (third-party guides, 2026: unconfirmed for every distro)
    if (e.platform === 'linux' && (fs.existsSync('/opt/antigravity') || fs.existsSync('/usr/share/applications/antigravity.desktop'))) return true;
    return fs.existsSync(path.join(e.home, '.gemini', 'antigravity')) || fs.existsSync(path.join(e.home, '.gemini', 'config', 'mcp_config.json')) ? true : null;
  }
  if (id === 'chatgpt-desktop') {
    if (e.platform === 'darwin' && fs.existsSync('/Applications/ChatGPT.app')) return true;
    return fs.existsSync(path.join(e.home, '.codex')) ? true : null;
  }
  return null;
}

/** A program on PATH (no spawning): grok, cloudflared ... */
export function onPath(names: string[], e: Pick<Env, 'env' | 'platform'>): boolean {
  const dirs = String(e.env.PATH ?? e.env.Path ?? '').split(e.platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = e.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return dirs.some((d) => names.some((n) => exts.some((x) => { try { return fs.statSync(path.join(d, n + x)).isFile(); } catch { return false; } })));
}
export function whichPath(name: string, e: Pick<Env, 'env' | 'platform'>): string | null {
  const dirs = String(e.env.PATH ?? e.env.Path ?? '').split(e.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const d of dirs) for (const x of e.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
    const f = path.join(d, name + x);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------- config writers (backup first, keep everything else)
export interface Launch { command: string; args: string[]; /** extra environment (VTP_PORT when VTube Pro is not on 5191) */ env?: Record<string, string> }
const ENTRY = 'vtube-pro';
const stamp = (now: number) => new Date(now).toISOString().replace(/[:.]/g, '-');
/** The time part of our backup names ("<file>.vtp-backup-2026-10-06T12-30-00-000Z", "-2" ... when one already exists). */
export const SETUP_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d{1,3})?$/;
/** A backup name that does not overwrite an older backup made in the same millisecond. */
export function backupName(file: string, now: number): string {
  const b0 = `${file}.vtp-backup-${stamp(now)}`;
  let b = b0;
  for (let n = 2; fs.existsSync(b) && n < 999; n++) b = `${b0}-${n}`;
  return b;
}

function backupAndPrepare(file: string, now: number): { raw: string; backup: string | null } {
  if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); return { raw: '', backup: null }; }
  const raw = fs.readFileSync(file, 'utf8');
  const backup = backupName(file, now);
  fs.copyFileSync(file, backup);
  return { raw, backup };
}
function atomicWrite(file: string, text: string) {
  const tmp = `${file}.vtp_tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** TOML basic string. JSON escapes (\\ \" \n \uXXXX) are valid TOML basic-string escapes. */
const tomlStr = (s: string) => JSON.stringify(s);

/** Codex / ChatGPT Desktop per-server timeouts (seconds; ~/.codex/config.toml keys, docs/AI_CONNECT.md CITES.codexMcp). */
export const CODEX_TIMEOUTS: Record<string, number> = { startup_timeout_sec: 30, tool_timeout_sec: 900 };

/** The [mcp_servers.vtube-pro] block (Codex / ChatGPT Desktop and Grok Build use the same keys: command, args, env). */
export function tomlBlock(launch: Launch, client: string, extra: Record<string, number | boolean> = {}): string {
  const lines = [
    `[mcp_servers.${ENTRY}]`,
    `command = ${tomlStr(launch.command)}`,
    `args = [${launch.args.map(tomlStr).join(', ')}]`,
    ...Object.entries(extra).map(([k, v]) => `${k} = ${v}`),
    '',
    `[mcp_servers.${ENTRY}.env]`,
    `VTP_MCP_CLIENT = ${tomlStr(client)}`,
    ...Object.entries(launch.env ?? {}).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k)).map(([k, v]) => `${k} = ${tomlStr(v)}`),
  ];
  return `# Added by VTube Pro (AI connectors). Remove these lines to disconnect.\n${lines.join('\n')}\n`;
}

const OUR_HEADER = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${ENTRY}"?\\s*(\\.[^\\]]*)?\\]\\s*(#.*)?$`);
const ANY_HEADER = /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/;
const OUR_COMMENT = /^# Added by VTube Pro \(AI connectors\)/;

/**
 * Put our block into a TOML file's text, replacing an older one. Refuses (throws a plain-words error) when the file
 * defines vtube-pro some other way (dotted key / inline table) that a section edit could turn into invalid TOML.
 */
export function upsertTomlServer(text: string, block: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let ours = false;
  let multi = false; // inside a """ or ''' multi-line string
  for (const l of lines) {
    const tq = (l.match(/"""|'''/g) ?? []).length;
    if (!multi && ANY_HEADER.test(l)) ours = OUR_HEADER.test(l);
    else if (!multi && !ours && new RegExp(`(^|[.\\s])"?${ENTRY}"?\\s*[=.]`).test(l) && !l.trim().startsWith('#')) {
      throw new Error(`This settings file already mentions "${ENTRY}" in a way we can't safely change. Open it, delete the ${ENTRY} lines, then try again.`);
    }
    if (tq % 2 === 1) multi = !multi;
    if (!ours && !OUR_COMMENT.test(l)) out.push(l);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return (out.length ? `${out.join('\n')}\n\n` : '') + block;
}

/** Remove our block (disconnect). */
export function removeTomlServer(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let ours = false;
  for (const l of lines) {
    if (ANY_HEADER.test(l)) ours = OUR_HEADER.test(l);
    if (!ours && !OUR_COMMENT.test(l)) out.push(l);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.length ? `${out.join('\n')}\n` : '';
}

/** Does a TOML text hold our server, and with which command / args? (enough of TOML for what we wrote ourselves) */
export function readTomlServer(text: string): Launch | null {
  const lines = text.split(/\r?\n/);
  let inMain = false;
  let inEnv = false;
  let command: string | null = null;
  let args: string[] = [];
  const env: Record<string, string> = {};
  for (const l of lines) {
    if (ANY_HEADER.test(l)) {
      inMain = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${ENTRY}"?\\s*\\]`).test(l);
      inEnv = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${ENTRY}"?\\s*\\.\\s*env\\s*\\]`).test(l);
      continue;
    }
    if (inEnv) {
      const v = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(".*")\s*$/.exec(l);
      if (v && v[1] !== 'VTP_MCP_CLIENT') { try { env[v[1]] = JSON.parse(v[2]); } catch { /* not ours */ } }
      continue;
    }
    if (!inMain) continue;
    const c = /^\s*command\s*=\s*(".*")\s*$/.exec(l);
    if (c) { try { command = JSON.parse(c[1]); } catch { /* not ours */ } }
    const a = /^\s*args\s*=\s*(\[.*\])\s*$/.exec(l);
    if (a) { try { args = JSON.parse(a[1]); } catch { /* not ours */ } }
  }
  return command ? { command, args, ...(Object.keys(env).length ? { env } : {}) } : null;
}

export function readJsonServer(text: string, key: 'mcpServers' | 'servers' = 'mcpServers'): Launch | null {
  try {
    const e = JSON.parse(text)?.[key]?.[ENTRY];
    if (!e || typeof e.command !== 'string') return null;
    // extra environment only (VTP_PORT ...): VTP_MCP_CLIENT is the app's name tag, not part of the launch
    const env = e.env && typeof e.env === 'object' ? Object.fromEntries(Object.entries(e.env as Record<string, unknown>).filter(([k, v]) => typeof v === 'string' && k !== 'VTP_MCP_CLIENT')) as Record<string, string> : {};
    return { command: e.command, args: Array.isArray(e.args) ? e.args : [], ...(Object.keys(env).length ? { env } : {}) };
  } catch { return null; }
}

/** The other servers in an app's config (names only: their settings are never shown). */
export function otherServerNames(text: string, format: 'json' | 'toml', key: 'mcpServers' | 'servers' = 'mcpServers'): string[] {
  if (format === 'json') {
    try { const s = JSON.parse(text)?.[key]; return s && typeof s === 'object' && !Array.isArray(s) ? Object.keys(s).filter((k) => k !== ENTRY) : []; } catch { return []; }
  }
  const out = new Set<string>();
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*\[\s*mcp_servers\s*\.\s*("([^"]+)"|'([^']+)'|[A-Za-z0-9_-]+)/.exec(l);
    if (m) { const n = m[2] ?? m[3] ?? m[1]; if (n !== ENTRY) out.add(n); }
  }
  return [...out];
}

/** The vtube-pro entry as each JSON app expects it (Claude Code / Cursor / VS Code: "type": "stdio"; Gemini CLI: a 15 min timeout). */
export function jsonEntry(id: ConnectorId, launch: Launch): Record<string, unknown> {
  const client = connectorById(id)?.name ?? id;
  return {
    ...(id === 'claude-code' || id === 'cursor' || id === 'vscode' ? { type: 'stdio' } : {}),
    command: launch.command, args: launch.args, env: { VTP_MCP_CLIENT: client, ...(launch.env ?? {}) },
    // one call may wait for the user's OK (5 min) and then for Blender (5 min): Gemini CLI's own default is 10 min
    ...(id === 'gemini-cli' ? { timeout: 900_000 } : {}),
  };
}

export interface MergedConfig {
  /** The whole new file text (what writeDesktopEntry writes). */
  text: string;
  /** create = new file, add = new entry in an existing file, update = our entry changes, same = nothing to change */
  action: 'create' | 'add' | 'update' | 'same';
  /** Only the part we add (JSON entry or TOML block), for the "what will be written" preview. */
  entryText: string;
  /** Names of the other servers, all kept. */
  others: string[];
}

/**
 * The ONE merge used both for the preview and for the write (so what the user saw is what lands): keeps every other key
 * and server, replaces only ours. Throws a plain-words error for a file we must not touch (damaged / unexpected shape).
 */
export function mergeDesktopConfig(id: ConnectorId, raw: string, launch: Launch, t: Pick<ConfigTarget, 'format' | 'key'>): MergedConfig {
  const client = connectorById(id)?.name ?? id;
  const exists = raw.trim().length > 0;
  if (t.format === 'json') {
    const key = t.key ?? 'mcpServers';
    let cfg: Record<string, any> = {};
    try { cfg = exists ? JSON.parse(raw) : {}; } catch { throw new Error(JSON_DAMAGED[id] ?? `${client}'s settings file is damaged (or has comments in it), so we left it alone. Use "Copy the settings" and add them in ${client} yourself.`); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${client}'s settings file has an unexpected shape, so we left it alone.`);
    if (cfg[key] !== undefined && (typeof cfg[key] !== 'object' || cfg[key] === null || Array.isArray(cfg[key]))) throw new Error(`${client}'s settings file has an unexpected "${key}" section, so we left it alone.`);
    const entry = jsonEntry(id, launch);
    const before = cfg[key]?.[ENTRY];
    const others = Object.keys(cfg[key] ?? {}).filter((k) => k !== ENTRY);
    const next = { ...cfg, [key]: { ...(cfg[key] ?? {}), [ENTRY]: entry } };
    const action = !exists ? 'create' : before === undefined ? 'add' : JSON.stringify(before) === JSON.stringify(entry) ? 'same' : 'update';
    return { text: JSON.stringify(next, null, 2), action, entryText: JSON.stringify({ [key]: { [ENTRY]: entry } }, null, 2), others };
  }
  // ChatGPT Desktop / Codex: startup_timeout_sec defaults to 10 s; tsx needs a little longer on a cold disk. tool_timeout_sec:
  // one call may wait for the user's OK (APPROVAL_TIMEOUT_MS, 5 min) and then for Blender (300 s by default), so give it
  // 15 min instead of Codex's own per-tool default (docs/MAKE_WITH_CLAUDE_OR_CODEX.md "timed out")
  const extra: Record<string, number> = id === 'chatgpt-desktop' || id === 'codex-cli' ? CODEX_TIMEOUTS : {};
  const block = tomlBlock(launch, client, extra);
  const lf = upsertTomlServer(raw, block);
  const had = readTomlServer(raw);
  const action = !exists ? 'create' : !had ? 'add' : lf.trim() === raw.replace(/\r\n/g, '\n').trim() ? 'same' : 'update';
  // a Windows (CRLF) file stays CRLF
  const text = /\r\n/.test(raw) ? lf.replace(/\r?\n/g, '\r\n') : lf;
  return { text, action, entryText: block, others: otherServerNames(raw, 'toml') };
}

export interface WriteResult { configPath: string; backup: string | null }

/** A JSON settings file we can't read is left alone, with the app's own way to fix it. */
const JSON_DAMAGED: Partial<Record<ConnectorId, string>> = {
  'claude-desktop': 'Claude Desktop\'s settings file is damaged, so we left it alone. In Claude Desktop open Settings > Developer > Edit Config, fix or empty it, then try again.',
  'claude-code': 'Claude Code\'s settings file is damaged, so we left it alone. Start Claude Code once (it repairs it), then try again.',
  'lm-studio': 'LM Studio\'s mcp.json is damaged, so we left it alone. In LM Studio open the Program tab (right sidebar) > Install > Edit mcp.json, fix or empty it, then try again.',
};

/** Add / refresh the vtube-pro entry for a desktop connector. Only ever called after the user ticked "Yes, add it". */
export function writeDesktopEntry(id: ConnectorId, e: Pick<Env, 'env' | 'platform' | 'home' | 'now'>, launch: Launch = stdioLaunch()): WriteResult {
  const t = configTarget(id, e);
  if (!t.supported || !t.path) throw new Error(t.why ?? 'This AI has no settings file we can add VTube Pro to.');
  // the merge runs BEFORE the backup + write (mergeDesktopConfig, the same one the preview shows): a file we must not touch
  // (damaged JSON, an odd vtube-pro definition) is left exactly as it was
  const merged = mergeDesktopConfig(id, fs.existsSync(t.path) ? fs.readFileSync(t.path, 'utf8') : '', launch, t);
  const { backup } = backupAndPrepare(t.path, e.now());
  atomicWrite(t.path, merged.text);
  return { configPath: t.path, backup };
}

export function removeDesktopEntry(id: ConnectorId, e: Pick<Env, 'env' | 'platform' | 'home' | 'now'>): WriteResult {
  const t = configTarget(id, e);
  if (!t.path || !fs.existsSync(t.path)) return { configPath: t.path ?? '', backup: null };
  const { raw, backup } = backupAndPrepare(t.path, e.now());
  if (t.format === 'json') {
    let cfg: Record<string, any>;
    try { cfg = JSON.parse(raw); } catch { throw new Error('That settings file is damaged, so we left it alone.'); }
    const key = t.key ?? 'mcpServers';
    if (cfg?.[key] && typeof cfg[key] === 'object') delete cfg[key][ENTRY];
    atomicWrite(t.path, JSON.stringify(cfg, null, 2));
  } else atomicWrite(t.path, removeTomlServer(raw));
  return { configPath: t.path, backup };
}

// ---------------------------------------------------------------- Claude Code: through its own CLI when we can
/**
 * The `claude` program, but only one we can start WITHOUT a shell (no .cmd / .bat on Windows: those need cmd.exe and its
 * quoting rules). The native installer puts it in ~/.local/bin (CITES.claudeCodeMcp setup page); npm puts it on PATH.
 */
export function claudeCodeCli(e: Pick<Env, 'env' | 'platform' | 'home'>): string | null {
  const exts = e.platform === 'win32' ? ['.exe'] : [''];
  const dirs = [...String(e.env.PATH ?? e.env.Path ?? '').split(e.platform === 'win32' ? ';' : ':').filter(Boolean), path.join(e.home, '.local', 'bin')];
  for (const d of dirs) for (const x of exts) { const f = path.join(d, `claude${x}`); try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ } }
  return null;
}

/** Run a CLI (no shell), collect its output. Never shows a window. */
function runCli(e: Pick<Env, 'spawn'>, exe: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcess;
    try { child = e.spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }); } catch (err) { resolve({ code: -1, out: (err as Error).message }); return; }
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ code: -1, out: `${out}\n(timed out)` }); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(t); resolve({ code: -1, out: err.message }); });
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

/** The exact `claude mcp add` arguments (user scope, stdio). --env goes first: it takes several values (CITES.claudeCodeMcp). */
export const claudeCodeAddArgs = (launch: Launch) => ['mcp', 'add', '--env', 'VTP_MCP_CLIENT=Claude Code', ...Object.entries(launch.env ?? {}).map(([k, v]) => `${k}=${v}`), '--transport', 'stdio', '--scope', 'user', ENTRY, '--', launch.command, ...launch.args];
export const claudeCodeRemoveArgs = () => ['mcp', 'remove', '--scope', 'user', ENTRY];

export interface SetupResult extends WriteResult { via: 'cli' | 'file' }

/**
 * "Add VTube Pro" for any desktop connector (only after the user ticked consent). Claude Code: Claude Code writes
 * ~/.claude.json for itself, so we prefer its own `claude mcp add --scope user` (after our backup); without the CLI we add
 * the same user-scope entry ourselves (backup + atomic write, like the other apps). Everyone else: writeDesktopEntry.
 */
export async function setupDesktop(id: ConnectorId, e: Pick<Env, 'env' | 'platform' | 'home' | 'now' | 'spawn'>, launch: Launch = stdioLaunch()): Promise<SetupResult> {
  if (id !== 'claude-code') return { ...writeDesktopEntry(id, e, launch), via: 'file' };
  const cli = claudeCodeCli(e);
  if (!cli) return { ...writeDesktopEntry(id, e, launch), via: 'file' };
  const t = configTarget(id, e);
  const backup = t.path && fs.existsSync(t.path) ? backupName(t.path, e.now()) : null;
  if (backup) fs.copyFileSync(t.path!, backup);
  // an older vtube-pro entry makes `claude mcp add` refuse ("already exists"): remove ours first, ignore "not found"
  await runCli(e, cli, claudeCodeRemoveArgs());
  const r = await runCli(e, cli, claudeCodeAddArgs(launch));
  if (r.code !== 0) throw new Error(`Claude Code didn't accept the change${r.out.trim() ? `: ${r.out.trim().slice(0, 200)}` : '.'} Use "I'd rather do it myself" below.`);
  return { configPath: t.path ?? '', backup, via: 'cli' };
}

export async function unsetupDesktop(id: ConnectorId, e: Pick<Env, 'env' | 'platform' | 'home' | 'now' | 'spawn'>): Promise<SetupResult> {
  if (id !== 'claude-code') return { ...removeDesktopEntry(id, e), via: 'file' };
  const cli = claudeCodeCli(e);
  if (!cli) return { ...removeDesktopEntry(id, e), via: 'file' };
  const t = configTarget(id, e);
  const backup = t.path && fs.existsSync(t.path) ? backupName(t.path, e.now()) : null;
  if (backup) fs.copyFileSync(t.path!, backup);
  await runCli(e, cli, claudeCodeRemoveArgs());
  return { configPath: t.path ?? '', backup, via: 'cli' };
}

export function readDesktopEntry(id: ConnectorId, e: Pick<Env, 'env' | 'platform' | 'home'>): Launch | null {
  const t = configTarget(id, e);
  if (!t.path || !fs.existsSync(t.path)) return null;
  const raw = fs.readFileSync(t.path, 'utf8');
  return t.format === 'json' ? readJsonServer(raw, t.key) : readTomlServer(raw);
}

/** Copy-paste fallback for each desktop client (the "do it myself" path). */
export function manualSnippet(id: ConnectorId, launch: Launch = stdioLaunch()): string {
  const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const cmd = [launch.command, ...launch.args].map(q).join(' ');
  if (id === 'claude-desktop') return JSON.stringify({ mcpServers: { [ENTRY]: { command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) } } }, null, 2);
  if (id === 'chatgpt-desktop') return `codex mcp add ${ENTRY} -- ${cmd}\n\n# or in ~/.codex/config.toml:\n${tomlBlock(launch, 'ChatGPT Desktop', CODEX_TIMEOUTS)}`;
  if (id === 'codex-cli') return `codex mcp add ${ENTRY} --env VTP_MCP_CLIENT=Codex -- ${cmd}\n\n# or in ~/.codex/config.toml (ChatGPT Desktop reads the same file):\n${tomlBlock(launch, 'Codex', CODEX_TIMEOUTS)}`;
  if (id === 'claude-code') {
    // --env first: it takes several values, so it must not sit right before the name (CITES.claudeCodeMcp shows this order)
    const project = JSON.stringify({ mcpServers: { [ENTRY]: jsonEntry('claude-code', launch) } }, null, 2);
    return `claude mcp add --env "VTP_MCP_CLIENT=Claude Code"${Object.entries(launch.env ?? {}).map(([k, v]) => ` ${k}=${v}`).join('')} --transport stdio --scope user ${ENTRY} -- ${cmd}\n\n# or only for one project: save this as .mcp.json in that project's folder\n${project}`;
  }
  if (id === 'grok-build') return `grok mcp add ${ENTRY} -- ${cmd}\n\n# or in ~/.grok/config.toml:\n${tomlBlock(launch, 'Grok Build')}`;
  // LM Studio: Program tab > Install > Edit mcp.json, add this inside "mcpServers" (CITES.lmstudioMcp); it loads on save
  if (id === 'lm-studio') return JSON.stringify({ mcpServers: { [ENTRY]: { command: launch.command, args: launch.args, env: { VTP_MCP_CLIENT: 'LM Studio', ...(launch.env ?? {}) } } } }, null, 2);
  // Cursor: Settings > MCP > "Add a custom server" opens ~/.cursor/mcp.json; VS Code: "MCP: Open User Configuration"; Gemini CLI: ~/.gemini/settings.json
  if (id === 'cursor') return JSON.stringify({ mcpServers: { [ENTRY]: jsonEntry(id, launch) } }, null, 2);
  if (id === 'vscode') return `# in VS Code run "MCP: Open User Configuration" and add this inside "servers":\n${JSON.stringify({ servers: { [ENTRY]: jsonEntry(id, launch) } }, null, 2)}`;
  if (id === 'gemini-cli') {
    const envs = Object.entries({ VTP_MCP_CLIENT: 'Gemini CLI', ...(launch.env ?? {}) }).map(([k, v]) => ` -e ${q(`${k}=${v}`)}`).join('');
    return `gemini mcp add -s user${envs} ${ENTRY} ${cmd}\n\n# or in ~/.gemini/settings.json:\n${JSON.stringify({ mcpServers: { [ENTRY]: jsonEntry(id, launch) } }, null, 2)}`;
  }
  // Antigravity: MCP Servers > Manage MCP Servers > View raw config (~/.gemini/config/mcp_config.json)
  if (id === 'antigravity') return `# in Antigravity open MCP Servers > Manage MCP Servers > View raw config and add this inside "mcpServers":\n${JSON.stringify({ mcpServers: { [ENTRY]: jsonEntry(id, launch) } }, null, 2)}`;
  return '';
}

/** Claude Desktop writes mcp-server-<name>.log when it starts a server (CITES.claudeDesktop, "Getting logs"). */
export function claudeDesktopLog(e: Pick<Env, 'env' | 'platform' | 'home'>): { path: string; mtimeMs: number } | null {
  const dir = e.platform === 'darwin' ? path.join(e.home, 'Library', 'Logs', 'Claude') : e.platform === 'win32' && e.env.APPDATA ? path.join(e.env.APPDATA, 'Claude', 'logs') : null;
  if (!dir) return null;
  const f = path.join(dir, `mcp-server-${ENTRY}.log`);
  try { return { path: f, mtimeMs: fs.statSync(f).mtimeMs }; } catch { return null; }
}

// ---------------------------------------------------------------- tests (the big "Test" button)
export interface TestResult {
  ok: boolean;
  /** One short headline in plain words. */
  title: string;
  /** What we saw (plain words). */
  detail?: string;
  /** If it failed: the one thing to do next. */
  fix?: string;
  models?: string[];
  ms?: number;
}

/** Start the MCP server exactly as the AI app will, say hello, list the tools, stop it. */
export async function testStdioLaunch(launch: Launch, e: Pick<Env, 'spawn'>, timeoutMs = 25_000): Promise<TestResult> {
  const t0 = Date.now();
  for (const f of [launch.command, ...launch.args.filter((a) => /[\\/]/.test(a) && /\.(m?[jt]s|cjs)$/.test(a))]) {
    if (path.isAbsolute(f) && !fs.existsSync(f)) {
      return { ok: false, title: 'The VTube Pro connection is pointing at a missing file', detail: 'Usually this means VTube Pro moved or was updated.', fix: 'Click "Add VTube Pro" again: it writes the current location.' };
    }
  }
  return new Promise<TestResult>((resolve) => {
    let child: ChildProcess;
    try { child = e.spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...(launch.env ?? {}), VTP_MCP_CLIENT: 'VTube Pro connection test', VTP_NO_BROWSER: '1' } }); }
    catch (err) { resolve({ ok: false, title: 'We could not start the VTube Pro connection', detail: (err as Error).message, fix: 'Restart VTube Pro, then press Test again.' }); return; }
    let buf = '';
    let done = false;
    const finish = (r: TestResult) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve({ ...r, ms: Date.now() - t0 }); };
    const timer = setTimeout(() => finish({ ok: false, title: 'The VTube Pro connection did not answer in time', fix: 'Close other heavy programs for a moment, then press Test again.' }), timeoutMs);
    const send = (m: unknown) => { try { child.stdin?.write(`${JSON.stringify(m)}\n`); } catch { /* closed */ } };
    child.on('error', (err) => finish({ ok: false, title: 'We could not start the VTube Pro connection', detail: err.message, fix: 'Restart VTube Pro, then press Test again.' }));
    child.on('exit', (code) => finish({ ok: false, title: 'The VTube Pro connection stopped right away', detail: `exit code ${code}`, fix: 'Restart VTube Pro, then press Test again.' }));
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && m.result) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
        else if (m.id === 1 && m.error) finish({ ok: false, title: 'The VTube Pro connection refused to start', detail: String(m.error.message ?? ''), fix: 'Restart VTube Pro, then press Test again.' });
        else if (m.id === 2) {
          const names: string[] = (m.result?.tools ?? []).map((t: { name: string }) => t.name);
          if (names.includes('get_docs')) finish({ ok: true, title: `VTube Pro's ${names.length} tools are ready`, detail: 'Your AI app will start this same connection by itself.' });
          else finish({ ok: false, title: 'The connection started but its tools are missing', fix: 'Restart VTube Pro, then press Test again.' });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vtube-pro-connection-test', version: '1' } } });
  });
}

// ---------------------------------------------------------------- local models (OpenAI-compatible servers on this PC)
export interface LocalKind { kind: string; label: string; port: number; getUrl: string; how: string }
/** Default ports (each runner's own docs). Only 127.0.0.1 is ever probed. */
export const LOCAL_KINDS: readonly LocalKind[] = [
  { kind: 'ollama', label: 'Ollama', port: 11434, getUrl: 'https://ollama.com/download', how: 'Install Ollama, then it runs by itself in the background.' },
  { kind: 'lmstudio', label: 'LM Studio', port: 1234, getUrl: 'https://lmstudio.ai/download', how: 'In LM Studio open the Developer tab and switch "Start server" on.' },
  { kind: 'llamacpp', label: 'llama.cpp server', port: 8080, getUrl: 'https://github.com/ggml-org/llama.cpp', how: 'Start llama-server with your model (it listens on port 8080).' },
  { kind: 'vllm', label: 'vLLM', port: 8000, getUrl: 'https://docs.vllm.ai', how: 'Start vllm serve <model> (port 8000).' },
  { kind: 'koboldcpp', label: 'KoboldCpp', port: 5001, getUrl: 'https://github.com/LostRuins/koboldcpp', how: 'Start KoboldCpp with a model (port 5001).' },
  { kind: 'jan', label: 'Jan', port: 1337, getUrl: 'https://jan.ai', how: 'In Jan, switch the Local API Server on (port 1337).' },
];
export interface FoundLocal { kind: string; label: string; baseUrl: string; models: string[] }

/** A base URL a local model may use: loopback only (the helper never sends anything to the LAN or the internet here). */
export function localBaseOk(u: string): boolean {
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') && /^(127(\.\d{1,3}){3}|localhost|\[::1\])$/i.test(x.hostname) && x.port !== '5191' && x.port !== '5193'; } catch { return false; }
}

/** Look for running local model servers on their default ports (127.0.0.1 only, 1 s each, in parallel). */
export async function scanLocal(e: Pick<Env, 'fetch'>, kinds: readonly LocalKind[] = LOCAL_KINDS, host = '127.0.0.1'): Promise<FoundLocal[]> {
  const found = await Promise.all(kinds.map(async (k) => {
    const baseUrl = `http://${host}:${k.port}/v1`;
    try {
      const r = await e.fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1000) });
      if (!r.ok) return null;
      const j: any = await r.json();
      if (!j || !Array.isArray(j.data)) return null; // something else is on that port
      return { kind: k.kind, label: k.label, baseUrl, models: j.data.map((m: { id?: string }) => String(m.id ?? '')).filter(Boolean) } as FoundLocal;
    } catch { return null; }
  }));
  return found.filter((x): x is FoundLocal => !!x);
}

/** Test a local server: list its models, then ask the model for one word (free, local). */
export async function testLocal(baseUrl: string, model: string | undefined, e: Pick<Env, 'fetch'>): Promise<TestResult> {
  const t0 = Date.now();
  if (!localBaseOk(baseUrl)) return { ok: false, title: 'That address is not on this PC', fix: 'Use an address that starts with http://127.0.0.1 (your model app shows it).' };
  const base = baseUrl.replace(/\/+$/, '');
  let models: string[] = [];
  try {
    const r = await e.fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
    const j: any = await r.json();
    models = (j?.data ?? []).map((m: { id?: string }) => String(m.id ?? '')).filter(Boolean);
  } catch {
    return { ok: false, title: 'Your model app is not answering', fix: 'Start Ollama or LM Studio (switch its server on), then press Test again.' };
  }
  if (!models.length) return { ok: false, title: 'Your model app is running, but it has no model yet', fix: 'Download one model in it first (step 1 shows a good one for most PCs), then press Test again.' };
  const use = model && models.includes(model) ? model : models[0];
  try {
    const r = await e.fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ model: use, messages: [{ role: 'user', content: 'Reply with just the word OK.' }], max_tokens: 8, temperature: 0 }),
    });
    if (!r.ok) return { ok: false, title: `"${use}" didn't answer (error ${r.status})`, fix: 'Pick another model below, or load this one in your model app first.', models };
    const j: any = await r.json();
    const said = String(j?.choices?.[0]?.message?.content ?? '').trim().slice(0, 40);
    return { ok: true, title: `"${use}" is working`, detail: said ? `It answered: "${said}"` : 'It answered.', models, ms: Date.now() - t0 };
  } catch {
    return { ok: false, title: `"${use}" took too long to answer`, fix: 'The first answer can take a minute while the model loads. Press Test again.', models };
  }
}

// ---------------------------------------------------------------- remote bridge test (Grok Bot / grok.com / ChatGPT web)
/** Call the public bridge address the way Grok will (MCP initialize over Streamable HTTP). */
export async function testRemoteUrl(url: string, e: Pick<Env, 'fetch'>): Promise<TestResult> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, title: 'That is not an internet address', fix: 'Copy the address again from step 2.' }; }
  if (u.protocol !== 'https:') return { ok: false, title: 'The address must start with https://', fix: 'Start the bridge in step 2 and copy the address it shows.' };
  const t0 = Date.now();
  try {
    const r = await e.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vtube-pro-bridge-test', version: '1' } } }),
    });
    if (r.status === 403) return { ok: false, title: 'The bridge is switched off', fix: 'Switch it on in step 1, then press Test again.' };
    if (r.status === 401) return { ok: false, title: 'That address has an old secret in it', fix: 'Copy the address again from step 2 (it changes when you switch the bridge off and on).' };
    if (!r.ok) return { ok: false, title: `The bridge answered with error ${r.status}`, fix: 'Stop and start the bridge in step 2, then press Test again.' };
    const txt = await r.text();
    if (!/"serverInfo"|"protocolVersion"/.test(txt)) return { ok: false, title: 'Something answered, but it is not VTube Pro', fix: 'Copy the address again from step 2.' };
    return { ok: true, title: 'The internet bridge works', detail: 'Paste the address into Grok as a custom connector. Switch the bridge off when you are done.', ms: Date.now() - t0 };
  } catch {
    return { ok: false, title: 'We couldn\'t reach the bridge from the internet', fix: 'Wait 20 seconds (new addresses take a moment), then press Test again.' };
  }
}
