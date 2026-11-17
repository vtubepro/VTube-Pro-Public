// Pro2D → 3D readiness checklist (lane to3d): detected facts in, plain rows out. Zero effort: every row says in one
// sentence what is true and offers ONE button (a one-click install with consent, or a link to get it yourself).
// Pure: the helper gathers the facts (server/to3d/readiness.ts), the drawer (src/ui/to3dPanel.ts) shows the rows.
import { COMMUNITY, OFFICIAL, type McpKind } from './blenderMcp.ts';

export type AppId = 'claude' | 'chatgpt';
export interface AppFacts { installed: boolean; registered: boolean; verified: boolean | null; needsRestart: boolean; lastCallAgoS: number | null }
export interface ReadyFacts {
  enabled: boolean;
  os: 'windows' | 'mac' | 'linux';
  apps: Record<AppId, AppFacts>;
  blender: { found: boolean; version: string | null; level: 'ok' | 'newer' | 'old' | 'store' | 'missing' };
  mcp: {
    choice: McpKind;
    addon: Record<McpKind, { installed: boolean; enabled: boolean | null }>;
    /** which Blender MCP each app's config starts */
    registered: Record<AppId, McpKind[]>;
    duplicate: Record<AppId, boolean>;
    /** one of the duplicates is the entry VTube Pro added (it can take that one out) */
    oursDup?: Record<AppId, boolean>;
    /** what answers on the port now */
    running: McpKind | 'other' | null;
    /** a uvx was found (the toolkit's, the one your AI app's entry starts, PATH now, or an installer's folder) */
    uvx: boolean;
    /** "Get uv for me" (about 20 MB): running, or why it failed (one plain sentence + the next step) */
    uvInstall?: { installing: boolean; error: string | null };
  };
  kit: { ready: boolean; installing: boolean; error: string | null; sizeMB: number; step?: string | null; pct?: number };
  bases: { have: string[]; user: { name: string } | null };
  live: { live: boolean; why: string | null };
  jobs: { running: number };
}

export type RowState = 'ok' | 'fix' | 'busy' | 'warn';
export interface Action { id: string; label: string }
export interface Link { label: string; url: string }
export interface Row { id: 'app' | 'blender' | 'mcp' | 'kit' | 'bases' | 'live'; title: string; state: RowState; say: string; action?: Action; link?: Link; more?: string }

export const APP_LABEL: Record<AppId, string> = { claude: 'Claude', chatgpt: 'ChatGPT' };
export const APP_GET: Record<AppId, string> = { claude: 'https://claude.ai/download', chatgpt: 'https://openai.com/chatgpt/download/' };
export const BLENDER_GET = 'https://www.blender.org/download/';
/** uv's maker's own install page (winget / the official installer / Homebrew) */
export const UV_GET = 'https://docs.astral.sh/uv/getting-started/installation/';

/** The app to start in: the one that works, else the one installed, else Claude. */
export function pickApp(f: ReadyFacts, wanted?: AppId | null): AppId {
  if (wanted) return wanted;
  const score = (a: AppFacts) => (a.lastCallAgoS !== null && a.lastCallAgoS < 600 ? 8 : 0) + (a.verified ? 4 : 0) + (a.registered ? 2 : 0) + (a.installed ? 1 : 0);
  return score(f.apps.chatgpt) > score(f.apps.claude) ? 'chatgpt' : 'claude';
}

export function rows(f: ReadyFacts, app: AppId): Row[] {
  const out: Row[] = [];
  const A = f.apps[app], name = APP_LABEL[app];
  // 1. the AI app
  if (A.lastCallAgoS !== null && A.lastCallAgoS < 600) out.push({ id: 'app', title: 'Your AI app', state: 'ok', say: `${name} talked to VTube Pro ${A.lastCallAgoS < 90 ? 'just now' : `${Math.round(A.lastCallAgoS / 60)} min ago`}.` });
  else if (!A.installed) out.push({ id: 'app', title: 'Your AI app', state: 'fix', say: `${name} wasn't found on this computer.`, link: { label: `Get ${name}`, url: APP_GET[app] }, action: { id: `connect:${app}`, label: `I have it: connect ${name}` }, more: app === 'chatgpt' ? 'Use the ChatGPT desktop app (not the website).' : undefined });
  else if (!A.registered) out.push({ id: 'app', title: 'Your AI app', state: 'fix', say: `${name} is installed but not connected to VTube Pro.`, action: { id: `connect:${app}`, label: `Connect ${name}` } });
  else if (A.needsRestart) out.push({ id: 'app', title: 'Your AI app', state: 'fix', say: `Quit ${name} fully (${f.os === 'mac' ? 'menu bar → Quit' : 'tray icon → Quit'}) and open it again.`, action: { id: 'recheck', label: 'Check again' } });
  else out.push({ id: 'app', title: 'Your AI app', state: 'ok', say: `${name} is connected to VTube Pro.` });
  // 2. Blender
  const B = f.blender;
  if (B.level === 'missing') out.push({ id: 'blender', title: 'Blender', state: 'fix', say: 'Blender (free) isn\'t installed.', action: { id: 'install:blender', label: 'Install Blender' }, link: { label: 'Get it yourself', url: BLENDER_GET } });
  else if (B.level === 'store') out.push({ id: 'blender', title: 'Blender', state: 'fix', say: 'The Microsoft Store Blender can\'t be started by other programs. Install the blender.org one beside it.', action: { id: 'install:blender', label: 'Install Blender' }, link: { label: 'Get it yourself', url: BLENDER_GET } });
  else if (B.level === 'old') out.push({ id: 'blender', title: 'Blender', state: 'fix', say: `Blender ${B.version} is too old (4.2 or newer).`, action: { id: 'install:blender', label: 'Update Blender' }, link: { label: 'Get it yourself', url: BLENDER_GET } });
  else out.push({ id: 'blender', title: 'Blender', state: 'ok', say: `Blender ${B.version}${B.level === 'newer' ? ' (newer than we tested; it usually works)' : ''}.` });
  // 3. the Blender MCP
  const M = f.mcp, kind = M.choice, info = kind === 'official' ? OFFICIAL : COMMUNITY;
  const ad = M.addon[kind], reg = M.registered[app];
  const mcpTitle = 'Blender MCP (lets your AI work in Blender)';
  if (kind === 'official' && B.level !== 'missing' && B.version && cmp(B.version, OFFICIAL.minBlender) < 0) out.push({ id: 'mcp', title: mcpTitle, state: 'fix', say: `The official Blender MCP needs Blender ${OFFICIAL.minBlender} or newer.`, action: { id: 'mcp:choose:community', label: 'Use MCP for Blender instead' } });
  else if (!ad.installed) out.push({ id: 'mcp', title: mcpTitle, state: 'fix', say: `${info.label} isn't installed in Blender.`, action: { id: `install:mcp:${kind}`, label: 'Install it for me' }, link: { label: 'Get it yourself', url: info.home } });
  else if (ad.enabled === false) out.push({ id: 'mcp', title: mcpTitle, state: 'fix', say: `${info.label} is installed but switched off in Blender.`, action: { id: `install:mcp:${kind}`, label: 'Switch it on' } });
  else if (M.duplicate[app]) out.push(M.oursDup?.[app]
    ? { id: 'mcp', title: mcpTitle, state: 'fix', say: `${APP_LABEL[app]} has two Blender MCPs on the same port, so neither works. Yours stays; we take ours out.`, action: { id: `unregister:mcp:${app}`, label: 'Keep just one' } }
    : { id: 'mcp', title: mcpTitle, state: 'fix', say: `${APP_LABEL[app]} has two Blender MCPs on the same port, so neither works. Remove one of them in ${APP_LABEL[app]}'s settings (we never change servers you added).`, action: { id: 'recheck', label: 'Check again' } });
  else if (!reg.includes(kind)) out.push({ id: 'mcp', title: mcpTitle, state: 'fix', say: `${info.label} isn't added to ${APP_LABEL[app]} yet.`, action: { id: `register:mcp:${kind}:${app}`, label: `Add to ${APP_LABEL[app]}` } });
  else if (kind === 'community' && !M.uvx) {
    // uv alone (about 20 MB), never the whole 350 MB toolkit; a uv the user installed is found wherever it went
    if (M.uvInstall?.installing || f.kit.installing) out.push({ id: 'mcp', title: mcpTitle, state: 'busy', say: 'Getting uv, the small program that starts it…' });
    else if (M.uvInstall?.error) out.push({ id: 'mcp', title: mcpTitle, state: 'fix', say: `uv didn't install. ${M.uvInstall.error}`, action: { id: 'install:uv', label: 'Try again' }, link: { label: 'Get it yourself', url: UV_GET } });
    else out.push({ id: 'mcp', title: mcpTitle, state: 'fix', say: 'The small helper program that starts it (uv) is missing.', action: { id: 'install:uv', label: 'Get it for me' }, link: { label: 'Get it yourself', url: UV_GET },
      more: 'Installed it yourself already? This list finds it by itself in a few seconds (no restart needed).' });
  }
  else if (M.running !== kind) {
    if (M.running === 'other' || (M.running && M.running !== kind)) out.push({ id: 'mcp', title: mcpTitle, state: 'fix', say: `Something else is using port 9876. Close it, or quit the other Blender MCP.`, action: { id: 'recheck', label: 'Check again' } });
    else if (f.live.live) out.push({ id: 'mcp', title: mcpTitle, state: 'warn', say: 'Ready. Blender opens after your stream (it can slow a stream down).' });
    else out.push({ id: 'mcp', title: mcpTitle, state: 'fix', say: 'Blender isn\'t open.', action: { id: 'open:blender', label: 'Open Blender for me' },
      more: kind === 'official' ? 'If Blender asks, allow "Online access" (Preferences → System): the official MCP needs it, even on this computer.' : (f.os === 'windows' ? 'If Windows asks about the firewall, allow Blender on private networks: the MCP talks to it on this computer only.' : undefined) });
  } else out.push({ id: 'mcp', title: mcpTitle, state: 'ok', say: 'Blender is open and listening.' });
  // 4. the 3D toolkit
  if (f.kit.installing) out.push({ id: 'kit', title: '3D toolkit', state: 'busy', say: `Installing the 3D toolkit${f.kit.step ? `: ${f.kit.step.replace(/^\w/, (c) => c.toLowerCase())}` : ''}${f.kit.pct ? ` (${Math.round(f.kit.pct * 100)}%)` : ''}…` });
  else if (!f.kit.ready) out.push({ id: 'kit', title: '3D toolkit', state: 'fix', say: f.kit.error ? `The 3D toolkit didn't install: ${f.kit.error}` : `A one-time download (about ${f.kit.sizeMB} MB) that turns your 2D model into 3D.`, action: { id: 'install:kit', label: f.kit.error ? 'Try again' : 'Get the 3D toolkit' } });
  else out.push({ id: 'kit', title: '3D toolkit', state: 'ok', say: 'The 3D toolkit is ready.' });
  // 5. the base body
  // always ready: VTube Pro's own base bodies ship with the helper (Mirelle, Kairo); the user may pick their own instead
  if (f.bases.user) out.push({ id: 'bases', title: 'Base body', state: 'ok', say: `Using your own base "${f.bases.user.name}".`, action: { id: 'bases:clear-user', label: 'Use VTube Pro\'s bases instead' } });
  else out.push({ id: 'bases', title: 'Base body', state: 'ok', say: 'Starts from VTube Pro\'s own base bodies (Mirelle, Kairo), already included.', action: { id: 'bases:pick-user', label: 'Use my own base' } });
  // 6. live (never blocks)
  if (f.live.live) out.push({ id: 'live', title: 'Not live right now', state: 'warn', say: 'You\'re streaming. The conversion works in the background at low priority; Blender opens after your stream.' });
  return out;
}

/** Start needs: app, Blender, kit, a base. The Blender MCP is recommended, not required (parametric-only fallback). */
export function canStart(rs: readonly Row[]): boolean {
  return rs.filter((r) => r.id === 'app' || r.id === 'blender' || r.id === 'kit' || r.id === 'bases').every((r) => r.state === 'ok');
}

function cmp(a: string, b: string) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}
