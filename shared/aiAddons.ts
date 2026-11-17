// "Recommended for your AI" (lane aiskills, beta.12): the ONE catalog of add-ons that make an AI app better at building
// for VTube Pro (skills, MCP servers, connectors, plugins), plus the model advice on the Connect-your-AI page.
// DATA + PURE LOGIC ONLY (no node / DOM imports): the helper (server/aiAddons.ts) detects and installs, the connect page
// shows it, the to3d lane reads its Blender entries (getAddon('mcp-for-blender'), getAddon('blender-lab-mcp')).
//
// Owner rules this file encodes:
//   * the user's own AI apps (Claude / ChatGPT / Grok apps, Cursor ...) or a model on this PC; VTube Pro holds no AI key;
//   * no gatekeeping: users get things themselves by one consented click or a link; we never bundle third-party code;
//   * nothing installs without the user's tick; every download is from the project's own host, pinned to what we
//     reviewed (version / commit + SHA-256); telemetry off where there is a switch;
//   * "if people don't have Photoshop ... recommend GIMP" (free, open source) + its MCP.
// Research and sources: vtp-b12/aiskills_research_claude.md (and Grok's), consensus 2026-10-06.
// Checked by tools/ai_addons_unit.ts (validateAddons): https + official hosts, pins on every downloadable, one-sentence blurbs.

export type AddonApp =
  | 'claude-desktop' | 'claude-code' | 'chatgpt-desktop' | 'codex-cli' | 'grok-build' | 'antigravity' | 'gemini-cli'
  | 'cursor' | 'vscode' | 'lm-studio';
export const ADDON_APPS: readonly AddonApp[] = ['claude-desktop', 'claude-code', 'chatgpt-desktop', 'codex-cli', 'grok-build', 'antigravity', 'gemini-cli', 'cursor', 'vscode', 'lm-studio'];
export const APP_NAME: Record<AddonApp, string> = {
  'claude-desktop': 'Claude Desktop', 'claude-code': 'Claude Code', 'chatgpt-desktop': 'ChatGPT (desktop app)', 'codex-cli': 'Codex',
  'grok-build': 'Grok Build', antigravity: 'Antigravity', 'gemini-cli': 'Gemini CLI', cursor: 'Cursor', vscode: 'VS Code', 'lm-studio': 'LM Studio',
};

export type AddonKind = 'ours-skill' | 'mcp-local' | 'connector' | 'plugin' | 'skill' | 'built-in' | 'blender-addon';
export type AddonArea = '3d' | 'pro2d' | 'rooms' | 'costumes' | 'textures' | 'overlays' | 'sfx' | 'qa';
/** default = shown first with a one-click button; advanced = behind "More options"; optional = the "also good" list; info = a tip. */
export type Recommend = 'default' | 'advanced' | 'optional' | 'info';
export type AddonStatus = 'ours' | 'first-party' | 'vendor' | 'community';

/** When an entry's recommendation applies (all must hold). Tool ids are shared/toolsCatalog.ts ids (+ 'photoshop'). */
export interface AddonCondition { tool?: { id: string; minVersion?: string }; missingTool?: string }

/** A stdio MCP server launch. `uv` / `uvx` are replaced by the absolute path the helper found (GUI apps have no PATH). */
export interface McpLaunch { command: 'uv' | 'uvx' | 'node'; args: string[]; env?: Record<string, string> }

export interface PinnedFile { name: string; sha256: string; bytes?: number }
export interface Pin {
  /** What we reviewed: a version or a commit. */
  ref: string;
  reviewedAt: string;
  /** Downloads the helper fetches (each verified against its SHA-256 before anything is written). */
  files?: PinnedFile[];
  /** Base URL the files come from (https, an official host). `${name}` is appended. */
  baseUrl?: string;
}

export interface AddonLink { label: string; url: string }
export interface AddonEntry {
  id: string;
  name: string;
  maker: string;
  status: AddonStatus;
  kind: AddonKind;
  areas: AddonArea[];
  recommend: Recommend;
  /** Raises an optional entry to default (or keeps a default one) only when this holds; otherwise it drops one level. */
  when?: AddonCondition;
  /** ONE plain sentence for someone who will not read docs. */
  blurb: string;
  licence: { name: string; url: string };
  price: 'free' | 'free-tier' | 'paid';
  security: { runsCode: boolean; telemetry: 'none' | 'off-by-us' | 'opt-in' | 'on'; needsKey: boolean };
  /** Plain sentences shown on the consent sheet BEFORE anything happens. */
  cautions?: string[];
  pin?: Pin;
  /** toolsCatalog ids that must be there first ('blender', 'gimp', 'uv', 'comfyui'). */
  requires?: string[];
  officialHosts: string[];
  homepage: string;
  /** Which apps it helps, and how it gets there. */
  apps: Partial<Record<AddonApp, AddonAppWay>>;
  mcp?: { serverName: string; launch: McpLaunch };
  detect?: {
    /** matched (case-insensitive) against "<command file name without .exe> <args...>" of every MCP server in each app's settings */
    mcpEntry?: string;
    /** a TCP port on 127.0.0.1 that answers while the add-on runs inside its program */
    tcpPort?: number;
  };
  links?: AddonLink[];
  /** Steps after install, plain words (shown with the "Done" state). */
  next?: string[];
}
/** How an add-on reaches one app. auto = the helper does it after a tick; link = we open the official page; copy = a command to copy. */
export interface AddonAppWay { how: 'auto' | 'link' | 'copy' | 'built-in'; url?: string; command?: string; steps?: string[] }

// ---------------------------------------------------------------- pins (reviewed 2026-10-06 by lane aiskills)
/** MCP for Blender 2.1.9 (PyPI, MIT). Reviewed: DISABLE_TELEMETRY + BLENDER_MCP_SAFE_MODE switches (telemetry.py, safe_mode.py),
 *  `install-addon` copies the bundled add-on into Blender's user add-ons folder. */
export const MCP_FOR_BLENDER_VERSION = '2.1.9';
/** maorcc/gimp-mcp at this commit (GPL-3.0). Reviewed: the GIMP plug-in listens on localhost:9877 only and runs the Python the
 *  MCP server sends (like every Blender MCP); the server talks only to that socket; no telemetry; uv.lock pins mcp 1.10.1. */
export const GIMP_MCP_COMMIT = '09bfb2d3e5ca8efdc50c8d0b8c9cdf590ce422c6';
/** Blender Lab MCP v1.0.3 (GPL-3.0-or-later): the .mcpb for Claude Desktop and the Blender add-on zip, from its releases page. */
export const BLENDER_LAB_VERSION = '1.0.3';

/** The TCP port each in-program bridge listens on (both Blender MCPs share 9876: never run both). */
export const BLENDER_MCP_PORT = 9876;
export const GIMP_MCP_PORT = 9877;

// ---------------------------------------------------------------- the catalog
const ANY_SKILL_APP: Partial<Record<AddonApp, AddonAppWay>> = {
  'claude-code': { how: 'auto' }, 'codex-cli': { how: 'auto' }, 'chatgpt-desktop': { how: 'auto' }, 'grok-build': { how: 'auto' },
  antigravity: { how: 'auto' }, 'gemini-cli': { how: 'auto' },
  'claude-desktop': { how: 'link', url: 'https://claude.ai/customize/skills', steps: ['Press "Get the skill file": it saves vtube-pro-creator.zip.', 'In Claude open Customize > Skills > Upload skill, pick that file, then turn it on.', 'Needs "Code execution and file creation" switched on in Claude (Settings > Capabilities).'] },
};
const MCP_APPS: Partial<Record<AddonApp, AddonAppWay>> = {
  'claude-desktop': { how: 'auto' }, 'claude-code': { how: 'auto' }, 'chatgpt-desktop': { how: 'auto' }, 'codex-cli': { how: 'auto' },
  'grok-build': { how: 'auto' }, antigravity: { how: 'auto' }, 'gemini-cli': { how: 'auto' }, cursor: { how: 'auto' }, vscode: { how: 'auto' }, 'lm-studio': { how: 'auto' },
};

export const AI_ADDONS: readonly AddonEntry[] = [
  {
    id: 'vtp-creator-skill', name: 'VTube Pro Creator skill', maker: 'VTube Pro', status: 'ours', kind: 'ours-skill',
    areas: ['3d', 'pro2d', 'rooms', 'costumes', 'textures', 'overlays', 'sfx', 'qa'], recommend: 'default',
    blurb: 'Teaches your AI how VTube Pro wants avatars, Pro2D art, rooms and costumes made, so it gets them right the first time.',
    licence: { name: 'VTube Pro (free during the beta)', url: 'https://github.com/vtubepro/VTube-Pro-Public' }, price: 'free',
    security: { runsCode: false, telemetry: 'none', needsKey: false },
    officialHosts: ['github.com', 'claude.ai'], homepage: 'https://github.com/vtubepro/VTube-Pro-Public',
    apps: ANY_SKILL_APP,
    next: ['Start a new chat in your AI app: it uses the skill by itself whenever you ask for VTube Pro things.'],
  },
  {
    id: 'mcp-for-blender', name: 'Blender MCP (MCP for Blender)', maker: 'Siddharth Ahuja (community)', status: 'community', kind: 'mcp-local',
    areas: ['3d', 'rooms', 'costumes', 'textures'], recommend: 'default', when: { tool: { id: 'blender', minVersion: '4.2' } },
    blurb: 'Lets your AI work inside a Blender window you can watch, for models, rooms and outfits.',
    licence: { name: 'MIT (free)', url: 'https://github.com/ahujasid/mcp-for-blender/blob/main/LICENSE' }, price: 'free',
    security: { runsCode: true, telemetry: 'off-by-us', needsKey: false },
    cautions: [
      'It lets your AI run commands inside Blender. Only use it with an AI you trust, and save your Blender file first.',
      'We switch its usage reporting off and turn on its safe mode (no file or internet access from AI scripts).',
      'Its built-in 3D generators (Hunyuan3D, Tripo, Rodin) send your words or pictures to someone else\'s service, so VTube Pro work does not use them: our skill tells the AI so. Hunyuan3D runs through VTube Pro\'s Character 3D recipe in your own ComfyUI instead.',
    ],
    pin: { ref: MCP_FOR_BLENDER_VERSION, reviewedAt: '2026-10-06' },
    requires: ['blender', 'uv'],
    officialHosts: ['github.com', 'pypi.org', 'mcp-for-blender.com'], homepage: 'https://github.com/ahujasid/mcp-for-blender',
    apps: MCP_APPS,
    mcp: { serverName: 'blender', launch: { command: 'uvx', args: ['--from', `mcp-for-blender==${MCP_FOR_BLENDER_VERSION}`, 'mcp-for-blender'], env: { DISABLE_TELEMETRY: 'true', BLENDER_MCP_SAFE_MODE: '1' } } },
    detect: { mcpEntry: 'mcp-for-blender|^uvx .*\\bblender-mcp\\b', tcpPort: BLENDER_MCP_PORT },
    next: ['Open Blender, go to Edit > Preferences > Add-ons and tick "MCP for Blender".', 'In the 3D view press N, open the BlenderMCP tab and press Connect.', 'Restart your AI app, then ask it to "look at my Blender scene".'],
  },
  {
    id: 'blender-lab-mcp', name: 'Blender Lab MCP (official, advanced)', maker: 'Blender Foundation (Blender Lab)', status: 'first-party', kind: 'mcp-local',
    areas: ['3d', 'rooms'], recommend: 'advanced', when: { tool: { id: 'blender', minVersion: '5.1' } },
    blurb: 'Blender’s own AI connection for scene checks, screenshots and scripts, for people comfortable with its warning.',
    licence: { name: 'GPL-3.0-or-later (free)', url: 'https://projects.blender.org/lab/blender_mcp/src/branch/main/LICENSE' }, price: 'free',
    security: { runsCode: true, telemetry: 'none', needsKey: false },
    cautions: [
      'Blender’s own words: “The MCP server will execute LLM generated code in Blender without any guards in place to protect your data from removal or being sent to a remote location.” Blender recommends a separate computer or a virtual machine.',
      'It uses the same connection port as the other Blender MCP: use one or the other, never both.',
    ],
    pin: { ref: `v${BLENDER_LAB_VERSION}`, reviewedAt: '2026-10-06', baseUrl: `https://projects.blender.org/lab/blender_mcp/releases/download/v${BLENDER_LAB_VERSION}/`, files: [
      { name: `blender-${BLENDER_LAB_VERSION}.mcpb`, sha256: 'd6fe04dd17767f7c7fb452142f1f0e6787db575db49f3976a166142683b5b97e', bytes: 5500672 },
      { name: `mcp-${BLENDER_LAB_VERSION}.zip`, sha256: 'a7a9da816192502e5a0a202a396444e266b47d8fc4f74ad4698048bd43040707', bytes: 17975 },
    ] },
    requires: ['blender'],
    officialHosts: ['www.blender.org', 'projects.blender.org', 'lab.blender.org', 'claude.ai'], homepage: 'https://www.blender.org/lab/mcp-server/',
    apps: {
      'claude-desktop': { how: 'link', url: 'https://claude.ai/customize/connectors', steps: ['In Claude open Customize > Connectors, search "Blender" and press Add.'] },
      'claude-code': { how: 'link', url: 'https://www.blender.org/lab/mcp-server/' }, 'codex-cli': { how: 'link', url: 'https://www.blender.org/lab/mcp-server/' },
      'chatgpt-desktop': { how: 'link', url: 'https://www.blender.org/lab/mcp-server/' },
    },
    detect: { mcpEntry: 'blmcp|lab/blender_mcp|^uv run blender-mcp\\b', tcpPort: BLENDER_MCP_PORT },
    links: [{ label: 'Blender’s MCP page', url: 'https://www.blender.org/lab/mcp-server/' }, { label: 'Release files', url: 'https://projects.blender.org/lab/blender_mcp/releases' }],
    next: ['In Blender add the Blender Lab extensions repository and install "MCP" (Blender’s page shows the drag-and-drop link).', 'Start its server from the add-on’s preferences, then restart your AI app.'],
  },
  {
    id: 'gimp-mcp', name: 'GIMP MCP', maker: 'Maor Cohen (maorcc) and Viesar Lab (community)', status: 'community', kind: 'mcp-local',
    areas: ['pro2d', 'textures', 'overlays'], recommend: 'default', when: { missingTool: 'photoshop' },
    blurb: 'GIMP is a free, open-source alternative to Photoshop. Your AI can use it to make and edit layered art for Pro2D avatars.',
    licence: { name: 'GPL-3.0 (free, open source)', url: 'https://github.com/maorcc/gimp-mcp/blob/main/LICENSE' }, price: 'free',
    security: { runsCode: true, telemetry: 'none', needsKey: false },
    cautions: [
      'Its GIMP plug-in runs the Python your AI sends, the same way the Blender MCPs do. Only use it with an AI you trust.',
      'It only listens on this computer (port 9877) and sends nothing to the internet.',
      'We download the exact version we checked from GitHub and verify every file before installing it.',
    ],
    pin: { ref: GIMP_MCP_COMMIT, reviewedAt: '2026-10-06', baseUrl: `https://raw.githubusercontent.com/maorcc/gimp-mcp/${GIMP_MCP_COMMIT}/`, files: [
      { name: 'gimp_mcp_server.py', sha256: 'ee3bb14e00f5bb680236eb665922b0b0642685a59dd93ad59f102e2c3d4f0c47', bytes: 94233 },
      { name: 'gimp-mcp-plugin.py', sha256: 'bad845db751ada0e89caf9cd731f5f7ae67d5315c655dad2685d27588ef29908', bytes: 184854 },
      { name: 'pyproject.toml', sha256: '0552c7e802c70e499c31b32ed40736f44cb1cf95586ddbed3372d008be1208d9', bytes: 578 },
      { name: 'uv.lock', sha256: '8a4df597bc8febb2eaccc38f16adc6191f8cabf4229edc322bca800b05b3a177', bytes: 122179 },
      { name: 'LICENSE', sha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986', bytes: 35149 },
    ] },
    requires: ['gimp', 'uv'],
    officialHosts: ['github.com', 'raw.githubusercontent.com', 'www.gimp.org'], homepage: 'https://github.com/maorcc/gimp-mcp',
    apps: MCP_APPS,
    mcp: { serverName: 'gimp', launch: { command: 'uv', args: ['run', '--frozen', '--directory', '${dir}', 'gimp_mcp_server.py'] } },
    detect: { mcpEntry: 'gimp_mcp_server\\.py|gimp-mcp', tcpPort: GIMP_MCP_PORT },
    next: ['Open GIMP, then Tools > MCP > Start MCP Server (do this each time you open GIMP).', 'Restart your AI app, then ask it to "make a layered PSD for a Pro2D avatar".'],
  },
  {
    id: 'adobe-creativity', name: 'Adobe for creativity', maker: 'Adobe', status: 'vendor', kind: 'connector',
    areas: ['pro2d', 'textures', 'overlays'], recommend: 'optional', when: { tool: { id: 'photoshop' } },
    blurb: 'Adobe’s own connection for Photoshop-style edits, background removal and Firefly pictures, in Claude and ChatGPT.',
    licence: { name: 'Adobe terms (free guest tools; more with an Adobe account)', url: 'https://helpx.adobe.com/creative-cloud/apps/integration-with-other-apps/adobe-connectors/adobe-for-claude.html' }, price: 'free-tier',
    security: { runsCode: false, telemetry: 'on', needsKey: false },
    cautions: ['It works in Adobe’s cloud: your pictures go to Adobe. It does simple edits, not full Photoshop layer work.'],
    officialHosts: ['helpx.adobe.com', 'claude.ai', 'chatgpt.com', 'github.com'], homepage: 'https://helpx.adobe.com/creative-cloud/apps/integration-with-other-apps/adobe-connectors/adobe-for-claude.html',
    apps: {
      'claude-desktop': { how: 'link', url: 'https://claude.ai/customize/connectors', steps: ['In Claude open Customize > Connectors, search "Adobe for creativity" and press Add.'] },
      'claude-code': { how: 'copy', command: 'claude plugin install adobe-for-creativity@claude-plugins-official' },
      'chatgpt-desktop': { how: 'link', url: 'https://chatgpt.com/plugins', steps: ['Open Plugins in ChatGPT, search "Adobe" and press Install.'] },
      'codex-cli': { how: 'link', url: 'https://chatgpt.com/plugins' },
    },
  },
  {
    id: 'comfy-mcp', name: 'ComfyUI MCP (official)', maker: 'Comfy Org', status: 'first-party', kind: 'mcp-local',
    areas: ['textures', 'overlays'], recommend: 'optional', when: { tool: { id: 'comfyui' } },
    blurb: 'For ComfyUI fans: lets your AI build its own picture workflows (VTube Pro’s ready-made ones already work without it).',
    licence: { name: 'AGPL-3.0 or Comfy commercial (free)', url: 'https://docs.comfy.org/agent-tools/local' }, price: 'free',
    security: { runsCode: true, telemetry: 'opt-in', needsKey: false },
    cautions: ['It lets your AI build and run picture workflows in ComfyUI on this computer. Its usage summary is only sent if you say yes.'],
    officialHosts: ['docs.comfy.org', 'comfy.org', 'github.com'], homepage: 'https://docs.comfy.org/agent-tools/local',
    requires: ['comfyui'],
    apps: { 'claude-desktop': { how: 'link', url: 'https://docs.comfy.org/agent-tools/local' }, 'claude-code': { how: 'link', url: 'https://docs.comfy.org/agent-tools/local' }, 'codex-cli': { how: 'link', url: 'https://docs.comfy.org/agent-tools/local' } },
  },
  {
    id: 'frontend-design', name: 'Frontend Design skill', maker: 'Anthropic', status: 'first-party', kind: 'skill',
    areas: ['overlays'], recommend: 'optional',
    blurb: 'Anthropic’s design skill that makes overlays, alerts and stream pages look less generic.',
    licence: { name: 'Apache-2.0 (free)', url: 'https://github.com/anthropics/skills' }, price: 'free',
    security: { runsCode: false, telemetry: 'none', needsKey: false },
    officialHosts: ['claude.ai', 'github.com'], homepage: 'https://github.com/anthropics/skills',
    apps: {
      'claude-desktop': { how: 'link', url: 'https://claude.ai/customize/skills', steps: ['In Claude open Customize > Skills and turn on "frontend-design".'] },
      'claude-code': { how: 'copy', command: 'claude plugin install frontend-design@claude-plugins-official' },
    },
  },
  {
    id: 'playwright', name: 'Playwright (page checks)', maker: 'Microsoft', status: 'vendor', kind: 'plugin',
    areas: ['qa', 'overlays'], recommend: 'optional',
    blurb: 'Lets a coding AI open web pages and take screenshots, to check overlays it made.',
    licence: { name: 'Apache-2.0 (free)', url: 'https://github.com/microsoft/playwright-mcp' }, price: 'free',
    security: { runsCode: true, telemetry: 'none', needsKey: false },
    cautions: ['Our skill tells the AI to open only VTube Pro’s test pages (never your live studio) and to keep sound off.'],
    officialHosts: ['github.com'], homepage: 'https://github.com/microsoft/playwright-mcp',
    apps: { 'claude-code': { how: 'copy', command: 'claude plugin install playwright@claude-plugins-official' }, 'codex-cli': { how: 'link', url: 'https://github.com/microsoft/playwright-mcp' } },
  },
  {
    id: 'game-studio', name: 'Game Studio plugin', maker: 'OpenAI', status: 'first-party', kind: 'plugin',
    areas: ['3d', 'textures'], recommend: 'optional',
    blurb: 'OpenAI’s plugin with 3D asset and sprite pipeline skills for Codex and ChatGPT.',
    licence: { name: 'MIT (free)', url: 'https://github.com/openai/plugins' }, price: 'free',
    security: { runsCode: false, telemetry: 'none', needsKey: false },
    officialHosts: ['github.com', 'chatgpt.com'], homepage: 'https://github.com/openai/plugins',
    apps: { 'codex-cli': { how: 'copy', command: '/plugins', steps: ['In Codex type /plugins, find "Game Studio" and install it.'] }, 'chatgpt-desktop': { how: 'link', url: 'https://chatgpt.com/plugins' } },
  },
  {
    id: 'imagegen', name: 'Built-in image making', maker: 'OpenAI', status: 'first-party', kind: 'built-in',
    areas: ['textures', 'overlays'], recommend: 'info',
    blurb: 'ChatGPT and Codex can already make pictures: nothing to install.',
    licence: { name: 'Part of ChatGPT and Codex', url: 'https://github.com/openai/skills' }, price: 'free',
    security: { runsCode: false, telemetry: 'on', needsKey: false },
    officialHosts: ['github.com'], homepage: 'https://github.com/openai/skills',
    apps: { 'chatgpt-desktop': { how: 'built-in' }, 'codex-cli': { how: 'built-in' } },
  },
  {
    id: 'vrm-addon', name: 'VRM add-on for Blender', maker: 'VRM Consortium', status: 'community', kind: 'blender-addon',
    areas: ['3d', 'costumes'], recommend: 'info', when: { tool: { id: 'blender' } },
    blurb: 'Lets the Blender on your screen open and save VRM avatars, so your AI can edit them while you watch.',
    licence: { name: 'MIT and GPL-3.0 (free)', url: 'https://extensions.blender.org/add-ons/vrm/' }, price: 'free',
    security: { runsCode: false, telemetry: 'none', needsKey: false },
    officialHosts: ['extensions.blender.org'], homepage: 'https://extensions.blender.org/add-ons/vrm/',
    apps: {},
    links: [{ label: 'Get it from extensions.blender.org', url: 'https://extensions.blender.org/add-ons/vrm/' }],
  },
];

export const ADDON_IDS: readonly string[] = AI_ADDONS.map((a) => a.id);
export function getAddon(id: string): AddonEntry | undefined { return AI_ADDONS.find((a) => a.id === id); }

// ---------------------------------------------------------------- recommendations
export interface ToolHave { found: boolean; version?: string }
export type Have = Record<string, ToolHave | undefined>;

function versionAtLeast(v: string | undefined, min: string): boolean {
  if (!v) return false;
  const a = v.split(/[.\s-]/).map((x) => parseInt(x, 10)), b = min.split('.').map((x) => parseInt(x, 10));
  for (let i = 0; i < b.length; i++) { const x = Number.isFinite(a[i]) ? a[i] : 0; if (x !== b[i]) return x > b[i]; }
  return true;
}
/** Does an entry's condition hold on this computer? (no condition = yes) */
export function conditionHolds(c: AddonCondition | undefined, have: Have): boolean {
  if (!c) return true;
  if (c.missingTool && have[c.missingTool]?.found) return false;
  if (c.tool) { const t = have[c.tool.id]; if (!t?.found) return false; if (c.tool.minVersion && t.version && !versionAtLeast(t.version, c.tool.minVersion)) return false; }
  return true;
}

export interface Recommendation { entry: AddonEntry; level: Recommend; why: string }
const LEVELS: Recommend[] = ['default', 'advanced', 'optional', 'info'];

/**
 * What to show for one app on this computer, best first. A condition that holds keeps (default) or raises (optional ->
 * default for Adobe when Photoshop is here) the level; one that fails drops it one level. Entries that cannot reach this
 * app are left out. Blender MCP stays "default" when Blender is missing: the panel offers Blender first.
 */
export function recommendFor(app: AddonApp, have: Have): Recommendation[] {
  const out: Recommendation[] = [];
  for (const e of AI_ADDONS) {
    if (e.kind !== 'blender-addon' && !e.apps[app]) continue;
    const holds = conditionHolds(e.when, have);
    let level = e.recommend;
    let why = '';
    if (e.id === 'adobe-creativity' && holds) { level = 'default'; why = 'Photoshop is on this computer.'; }
    else if (e.id === 'gimp-mcp') { if (!holds) { level = 'optional'; why = 'Photoshop is on this computer, so GIMP is optional.'; } else why = 'Photoshop isn’t on this computer: GIMP is the free alternative.'; }
    else if (e.id === 'mcp-for-blender' && !have.blender?.found) why = 'Needs Blender first (free).';
    else if (e.when && !holds && (e.recommend === 'default' || e.recommend === 'advanced')) level = LEVELS[Math.min(LEVELS.indexOf(e.recommend) + 1, LEVELS.length - 1)];
    out.push({ entry: e, level, why });
  }
  return out.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
}

// ---------------------------------------------------------------- skill destinations (Agent Skills folders per app)
/** Where each app reads personal skills (relative to the home folder). Claude Desktop keeps skills on the account (zip upload). */
export const SKILL_DIRS: Partial<Record<AddonApp, string[]>> = {
  'claude-code': ['.claude', 'skills'],
  // "USER $HOME/.agents/skills" (learn.chatgpt.com/docs/build-skills): ChatGPT desktop app, Codex CLI and the IDE extension
  'codex-cli': ['.agents', 'skills'], 'chatgpt-desktop': ['.agents', 'skills'],
  'grok-build': ['.grok', 'skills'],
  // Antigravity 2.x / Gemini CLI personal skills (seen on a real Antigravity install, 2026-10-06)
  antigravity: ['.gemini', 'skills'], 'gemini-cli': ['.gemini', 'skills'],
};
export const CREATOR_SKILL_NAME = 'vtube-pro-creator';

// ---------------------------------------------------------------- the first message (copy button on every connected app)
export const FIRST_MESSAGE =
  'I use VTube Pro. Use its vtube-pro tools: first call get_instruction_pack (or get_docs with no arguments) and follow those ' +
  'instructions for everything you build for me. Then tell me in 3 short lines what you can make.';

// ---------------------------------------------------------------- model advice (HQ consensus 2026-10-06; data, not code)
/** `where`: where to pick it, in plain words, for the apps that offer it. */
export interface ModelPick { modelId: string; name: string; apps: AddonApp[]; text: string; size?: string; where: string }
export interface ModelAdvice {
  checkedAt: string;
  headline: ModelPick;
  alsoGreat: ModelPick[];
  local: ModelPick;
  honest: string;
  /** Never shown (not publicly available, ...). */
  hidden: { modelId: string; why: string }[];
  sources: AddonLink[];
}
export const MODEL_ADVICE: ModelAdvice = {
  checkedAt: '2026-10-06',
  headline: { modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5', apps: ['claude-desktop', 'claude-code'],
    text: 'Recommended for 3D: Claude Opus 5.5. It’s the current leader for building and fixing 3D in Blender from pictures: top of the Blender AI Arena’s blind votes and best at building from reference drawings.',
    where: 'In Claude Desktop pick it in the model menu under the message box; in Claude Code type /model.' },
  alsoGreat: [
    { modelId: 'gpt-6-astra', name: 'GPT-6 Astra', apps: ['chatgpt-desktop', 'codex-cli'], text: 'Strongest at rigging, UVs, materials and lighting in BlenderBench.', where: 'In the ChatGPT app pick it in the model menu at the top; in Codex type /model.' },
    { modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', apps: ['chatgpt-desktop', 'codex-cli'], text: 'Close behind Opus.', where: 'In the ChatGPT app pick it in the model menu at the top; in Codex type /model.' },
  ],
  local: { modelId: 'qwen3.8-27b', name: 'Qwen 3.8 27B', apps: ['lm-studio'], size: 'about 18 GB',
    text: 'The best local option (about 18 GB; needs a strong GPU). Expect retries; small local models often struggle with 3D.',
    where: 'Download it in LM Studio or Ollama, then pick it under “A model on this PC”.' },
  honest: 'No public test covers VTuber VRM avatars yet; we’re running our own comparison.',
  hidden: [{ modelId: 'gemini-4-argon', why: 'In a closed program, not publicly available (checked 2026-10-06).' }],
  sources: [
    { label: 'Blender AI Arena leaderboard (blind votes)', url: 'https://blenderai.org/leaderboard' },
    { label: 'Blender AI Arena methodology', url: 'https://blenderai.org/methodology' },
    { label: 'BlenderBench (Refresh, 29 Sep 2026)', url: 'https://refresh.dev/blog/blenderbench' },
    { label: 'GPT-6.1 Sol announcement', url: 'https://openai.com/index/introducing-gpt-6-1-sol/' },
    { label: 'GPT-6 Astra vs GPT-6.1 Sol', url: 'https://llm-stats.com/models/compare/gpt-6-astra-vs-gpt-6.1-sol' },
    { label: 'Qwen models', url: 'https://huggingface.co/Qwen' },
  ],
};
/** Plain line for local models (every local card). */
export const LOCAL_MODEL_NOTE = 'Works, but small local models often struggle with 3D: expect retries and simpler results. The AI app you already use is usually better for avatars and rooms.';

// ---------------------------------------------------------------- schema check (unit-tested)
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const hostOf = (u: string): string | null => { try { const x = new URL(u); return x.protocol === 'https:' ? x.hostname.toLowerCase() : null; } catch { return null; } };

/** Every problem with the catalog and the model advice, as plain sentences (empty = fine). */
export function validateAddons(list: readonly AddonEntry[] = AI_ADDONS, advice: ModelAdvice = MODEL_ADVICE): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const a of list) {
    const at = `"${a.id}"`;
    if (!ID_RE.test(a.id)) out.push(`${at}: bad id`);
    if (ids.has(a.id)) out.push(`${at}: duplicate id`);
    ids.add(a.id);
    // GIMP's wording is the owner's two sentences; every other blurb is one sentence
    const sentences = a.blurb.split(/(?<=\.)\s+/).length;
    if (!/^[A-Z].{15,200}\.$/.test(a.blurb) || sentences > (a.id === 'gimp-mcp' ? 2 : 1)) out.push(`${at}: blurb must be one plain sentence`);
    if (!hostOf(a.homepage) || !hostOf(a.licence.url)) out.push(`${at}: homepage / licence must be https`);
    const links = [...(a.links ?? []).map((l) => l.url), ...Object.values(a.apps).map((w) => w?.url).filter((u): u is string => !!u)];
    for (const u of links) { const h = hostOf(u); if (!h || !a.officialHosts.includes(h)) out.push(`${at}: link ${u} is not on an official https host`); }
    if (a.status === 'community' && a.kind === 'mcp-local' && !a.pin) out.push(`${at}: a community MCP must be pinned to what we reviewed`);
    if (a.pin?.files) {
      const h = a.pin.baseUrl ? hostOf(a.pin.baseUrl) : null;
      if (!h || !a.officialHosts.includes(h)) out.push(`${at}: pinned downloads must come from an official https host`);
      for (const f of a.pin.files) if (!/^[a-f0-9]{64}$/.test(f.sha256) || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(f.name) || f.name.includes('..')) out.push(`${at}: pinned file ${f.name} needs a SHA-256 and a plain name (no "..")`);
    }
    if (a.mcp) {
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(a.mcp.serverName) || a.mcp.serverName === 'vtube-pro') out.push(`${at}: bad MCP server name`);
      if (a.mcp.launch.args.some((x) => /@latest|\|/.test(x))) out.push(`${at}: never launch @latest or a pipe`);
      if (a.mcp.launch.command === 'uvx' && !a.mcp.launch.args.some((x) => /==\d/.test(x))) out.push(`${at}: uvx launches must pin a version`);
      if (a.security.telemetry === 'off-by-us' && !Object.keys(a.mcp.launch.env ?? {}).some((k) => /TELEMETRY/.test(k))) out.push(`${at}: telemetry "off-by-us" needs the switch in env`);
      if (!a.detect?.mcpEntry) out.push(`${at}: an MCP add-on needs a detect.mcpEntry`);
      else try { new RegExp(a.detect.mcpEntry, 'i'); } catch { out.push(`${at}: detect.mcpEntry is not a valid pattern`); }
    }
    if (a.security.runsCode && !(a.cautions ?? []).length) out.push(`${at}: anything that runs code needs a plain caution`);
    for (const [app, w] of Object.entries(a.apps)) {
      if (!ADDON_APPS.includes(app as AddonApp)) out.push(`${at}: unknown app ${app}`);
      if (w?.how === 'auto' && a.kind === 'mcp-local' && !a.mcp) out.push(`${at}/${app}: "auto" needs an mcp launch`);
      if (w?.how === 'auto' && a.kind !== 'mcp-local' && a.kind !== 'ours-skill') out.push(`${at}/${app}: only our skill and pinned MCPs install automatically`);
      if (w?.how === 'copy' && !w.command) out.push(`${at}/${app}: copy needs a command`);
    }
  }
  const shown = [advice.headline, ...advice.alsoGreat, advice.local].map((m) => m.modelId);
  for (const h of advice.hidden) if (shown.includes(h.modelId)) out.push(`model advice shows hidden model ${h.modelId}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(advice.checkedAt)) out.push('model advice needs a checkedAt date');
  for (const s of advice.sources) if (!hostOf(s.url)) out.push(`model advice source ${s.url} is not https`);
  return out;
}

/** Days since the model advice was checked (the release checklist re-checks it past 60). */
export function adviceAgeDays(now: number, advice: ModelAdvice = MODEL_ADVICE): number {
  return Math.floor((now - Date.parse(`${advice.checkedAt}T00:00:00Z`)) / 86_400_000);
}
