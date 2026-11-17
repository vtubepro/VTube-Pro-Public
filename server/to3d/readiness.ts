// Pro2D → 3D readiness facts on this computer (lane to3d) → shared/to3d/readiness.ts rows. Cheap enough to run every
// few seconds while the drawer is open: files on disk, one TCP probe, the remembered Blender; never starts Blender.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { blenderCompat } from '../../shared/blenderSetup.ts';
import type { McpKind } from '../../shared/to3d/blenderMcp.ts';
import { pickApp, rows, canStart, type AppId, type ReadyFacts } from '../../shared/to3d/readiness.ts';
import { appInstalled, readDesktopEntry, type ConnectorId } from '../aiConnectors.ts';
import { blenderInfo } from '../blender.ts';
import { SETTINGS_FILE } from '../paths.ts';
import { haveBases, userBase } from './bases.ts';
import { blenderEntries } from '../../shared/to3d/blenderMcp.ts';
import { addonsOnDisk, appServers, probePort, registered } from './blenderMcp.ts';
import { KIT_SIZE_MB, kitDetail, kitStatus, uvInstallState } from './kit.ts';
import { findUvx, forgetRegistryPath, realUvDeps, type Look, type UvxFound } from './uvFind.ts';
import { liveNow } from './live.ts';
import { KIT_DIR, listJobs } from './store.ts';

/** The emergency off switch: settings.json {"to3d": {"enabled": false}} or VTP_TO3D=0. ON by default everywhere. */
export function to3dEnabled(): boolean {
  if (process.env.VTP_TO3D === '0') return false;
  try { return (JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as { to3d?: { enabled?: boolean } }).to3d?.enabled !== false; } catch { return true; }
}

// ---------------------------------------------------------------- which AI app talked to VTube Pro, when
const lastSeen = new Map<AppId, number>();
export const appOfClient = (name: string): AppId | null => (/claude/i.test(name) && !/code/i.test(name) ? 'claude' : /chatgpt|codex|openai/i.test(name) ? 'chatgpt' : /claude/i.test(name) ? 'claude' : null);
/** Express middleware (mounted early, one line in server/index.ts): the stdio MCP server tags its calls with its app. */
export function noteMcpClient(req: Request, _res: Response, next: NextFunction) {
  const c = req.headers['x-vtp-mcp-client'];
  if (typeof c === 'string' && c) { const a = appOfClient(c); if (a) lastSeen.set(a, Date.now()); }
  next();
}
export const lastCallAgo = (a: AppId) => { const t = lastSeen.get(a); return t ? (Date.now() - t) / 1000 : null; };

const CONNECTOR: Record<AppId, ConnectorId> = { claude: 'claude-desktop', chatgpt: 'chatgpt-desktop' };
/** The user's Blender MCP pick (community = the default; official = the advanced one), kept across helper restarts. */
const choiceFile = () => path.join(KIT_DIR, 'settings.json');
const readKitSettings = (): Record<string, unknown> => { try { const j = JSON.parse(fs.readFileSync(choiceFile(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
export const getMcpChoice = (): McpKind => (readKitSettings().mcpChoice === 'official' ? 'official' : 'community');
export function setMcpChoice(k: McpKind) {
  fs.mkdirSync(KIT_DIR, { recursive: true });
  const f = choiceFile();
  fs.writeFileSync(f + '.tmp', JSON.stringify({ ...readKitSettings(), mcpChoice: k === 'official' ? 'official' : 'community' }, null, 1));
  fs.renameSync(f + '.tmp', f);
}

/** The commands the AI apps' Blender MCP entries start (a uvx there is the one the app really runs). */
function entryCommands(): string[] {
  const out: string[] = [];
  for (const a of ['claude', 'chatgpt'] as const) {
    try { const sv = appServers(a); for (const e of blenderEntries(sv)) { const c = sv[e.name]?.command; if (c) out.push(c); } } catch { /* unreadable config */ }
  }
  return out;
}
/** uvx for the community Blender MCP, wherever it is (server/to3d/uvFind.ts), looked up fresh on every call. */
export function resolveUvx(): Promise<UvxFound> { return findUvx(realUvDeps(KIT_DIR, entryCommands)); }

/** "Where we looked", for support: every place, what was there. Plain words, real paths. */
export interface Looked { what: string; where: string; found: boolean }

/** uv places in plain lines; a PATH with many folders becomes one line (the folder that had uvx, or how many we read). */
export function collapseLooks(list: readonly Look[]): Looked[] {
  const out: Looked[] = [];
  const groups = new Map<string, Look[]>();
  for (const l of list) { const g = groups.get(l.place); if (g) g.push(l); else groups.set(l.place, [l]); }
  for (const [place, g] of groups) {
    if (g.length <= 2) { for (const l of g) out.push({ what: `uv: ${place}`, where: l.path, found: l.found }); continue; }
    const hit = g.find((l) => l.found);
    out.push(hit ? { what: `uv: ${place}`, where: hit.path, found: true } : { what: `uv: ${place}`, where: `${g.length} folders, none has uvx`, found: false });
  }
  return out;
}

export async function readyFacts(fresh = false): Promise<ReadyFacts> { return (await gatherFacts(fresh)).facts; }

async function gatherFacts(fresh: boolean): Promise<{ facts: ReadyFacts; looked: Looked[] }> {
  if (fresh) forgetRegistryPath();
  const e = { env: process.env, platform: process.platform, home: os.homedir() };
  const app = (a: AppId) => {
    const id = CONNECTOR[a];
    const reg = !!readDesktopEntry(id, e) || (a === 'chatgpt' && !!readDesktopEntry('codex-cli', e));
    // (unknown = not found: the row offers the download AND "I have it: connect")
    return { installed: appInstalled(id, e) === true || reg, registered: reg, verified: null, needsRestart: false, lastCallAgoS: lastCallAgo(a) };
  };
  const b = await blenderInfo().catch(() => null);
  const compat = blenderCompat(b?.version);
  const store = !!b?.path && /WindowsApps/i.test(b.path);
  const level: ReadyFacts['blender']['level'] = !b ? 'missing' : store ? 'store' : compat.level === 'old' ? 'old' : compat.level === 'newer' ? 'newer' : 'ok';
  const addons = addonsOnDisk(b?.version ?? null, process.env, os.homedir(), b?.path ?? null);
  const regC = registered('claude'), regG = registered('chatgpt');
  const kit = kitStatus();
  const uv = await resolveUvx();
  const kd = kitDetail();
  const looked: Looked[] = [
    ...collapseLooks(uv.looked),
    { what: '3D toolkit folder', where: kd.dir, found: kd.stamp === 'ok' && kd.python },
    { what: '3D toolkit: its Python', where: kd.pythonPath, found: kd.python },
    { what: `3D toolkit: finished-install mark (${kd.stamp === 'ok' ? 'ok' : kd.stamp === 'old' ? 'from an older version' : kd.stamp === 'damaged' ? 'damaged' : 'missing'})`, where: path.join(kd.dir, 'kit.json'), found: kd.stamp === 'ok' },
    { what: `Blender: ${b?.version ?? 'not found'}`, where: b?.path ?? '(nowhere we know)', found: !!b },
    { what: `Blender settings folder (${addons.via})`, where: addons.dir ?? '(none)', found: !!addons.dir && fs.existsSync(addons.dir) },
    { what: 'Blender MCP add-on (MCP for Blender)', where: addons.community.where ?? (addons.dir ? path.join(addons.dir, 'scripts', 'addons') : '(no folder)'), found: addons.community.installed },
    { what: 'Blender MCP add-on (official)', where: addons.official.where ?? (addons.dir ? path.join(addons.dir, 'extensions') : '(no folder)'), found: addons.official.installed },
    { what: `Claude's Blender MCP entries: ${regC.names.join(', ') || 'none'}`, where: 'Claude settings', found: regC.kinds.length > 0 },
    { what: `ChatGPT / Codex Blender MCP entries: ${regG.names.join(', ') || 'none'}`, where: 'ChatGPT / Codex settings', found: regG.kinds.length > 0 },
  ];
  const live = await liveNow();
  const ub = userBase();
  const facts: ReadyFacts = {
    enabled: to3dEnabled(),
    os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux',
    apps: { claude: app('claude'), chatgpt: app('chatgpt') },
    blender: { found: !!b, version: b?.version ?? null, level },
    mcp: {
      choice: getMcpChoice(),
      addon: { community: { installed: addons.community.installed, enabled: addons.community.enabled }, official: { installed: addons.official.installed, enabled: addons.official.enabled } },
      registered: { claude: regC.kinds, chatgpt: regG.kinds },
      duplicate: { claude: regC.duplicate, chatgpt: regG.duplicate },
      oursDup: { claude: regC.duplicate && regC.ours, chatgpt: regG.duplicate && regG.ours },
      running: await probePort(),
      uvx: !!uv.path,
      uvInstall: uvInstallState(),
    },
    kit: { ready: kit.ready, installing: kit.installing, error: kit.error, sizeMB: KIT_SIZE_MB, step: kit.step, pct: kit.pct },
    bases: { have: haveBases(), user: ub ? { name: ub.name } : null },
    live: { live: live.live, why: live.why },
    jobs: { running: listJobs().filter((j) => j.phase === 'running' || j.phase === 'bundling').length },
  };
  return { facts, looked };
}

export async function readiness(want?: AppId | null, fresh = false) {
  const { facts: f, looked } = await gatherFacts(fresh);
  const app = pickApp(f, want);
  const rs = rows(f, app);
  return { enabled: f.enabled, app, rows: rs, canStart: f.enabled && canStart(rs), live: f.live, mcpChoice: f.mcp.choice, blender: f.blender, mcpRunning: f.mcp.running,
    /** for the drawer's "Where we looked" fold (support); also tells a new drawer this helper finds uv anywhere */
    looked, checkedAt: Date.now() };
}

