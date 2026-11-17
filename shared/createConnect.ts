// Create → connect (lane create-connect, 2026-10-02). Pure logic + every word the Create area's "how do you use AI" part
// says, so tools/create_connect_unit.ts can test every state and the voice rules (VOICE.md) with made-up answers. No DOM,
// no network. The UI is src/ui/createGate.ts (Create).
//
// Why (owner, 2026-10-02): people were "crazy confused". Create told EVERY visitor "The VTube Pro Helper isn't
// answering" (the page never even asked a helper), people didn't know the helper is needed, and they didn't know the
// difference between an AI app (Claude / ChatGPT desktop) and a free model on this PC. So Create now asks ONE plain
// question first, says what each answer means, and walks through the helper, the app and a first request step by step.
// VTube Pro holds no AI account and no API key: an AI app does the making through VTube Pro's MCP server, or a model that
// runs on this PC answers.

// ---------------------------------------------------------------- "How do you use AI?" (one plain question first)
export type CreatePath = 'app' | 'none';
export interface PathCopy { title: string; sub: string; icon: string; means: string }
export const PATHS: Record<CreatePath, PathCopy> = {
  app: { title: 'I use an AI app (Claude, ChatGPT, Grok ...)', sub: 'You already have the app and log in to it there.', icon: 'aiapp',
    means: 'You talk to the AI in its own app. VTube Pro gives it tools to build your stuff. VTube Pro never asks for an AI account or key.' },
  none: { title: 'I don’t have an AI app', sub: 'Get an AI app, or start with a free AI on your own computer.', icon: 'chip',
    means: 'No problem. Get an AI app such as Claude, ChatGPT or Grok, or pick a free AI that runs on your own computer.' },
};
export const PATH_ORDER: CreatePath[] = ['app', 'none'];
/** The answer Create recommends (owner 2026-10-02: steer people to the Claude, ChatGPT and Grok apps). */
export const RECOMMENDED_PATH: CreatePath = 'app';
/**
 * Where Create opens for someone who never answered "How do you use AI?": a connected AI app → the app path; only a
 * free AI on this computer → "I don't have an AI app"; anything else → the question itself, with the app answer marked
 * Recommended.
 */
export function landingPath(ready: { desktop: boolean; local: boolean }): CreatePath | null {
  if (ready.desktop) return 'app';
  if (ready.local) return 'none';
  return null;
}
/** "What's the difference?": 3 lines + a tiny table (where you chat / what VTube Pro adds / what you need). */
export const DIFFERENCE = {
  lines: ['Both make the same rooms, characters and outfits. The difference is where you chat.',
    'An AI app is the app you already use. A free AI runs on your own computer, inside VTube Pro.',
    'We recommend the app: it is the strongest, and VTube Pro just gives it tools.'],
  head: ['', 'Claude, ChatGPT or Grok app (recommended)', 'Free AI on my computer'],
  rows: [
    ['Where you chat', 'In the app', 'Here, in Create'],
    ['What VTube Pro asks for', 'Nothing: no account, no key', 'Nothing: no account, no key'],
    ['What you need', 'The app + VTube Pro', 'A strong graphics card + VTube Pro'],
  ],
};
export const PATH_KEY = 'vtp.create.path';
export const isPath = (v: unknown): v is CreatePath => v === 'app' || v === 'none';

// ---------------------------------------------------------------- the AI apps (path "app"): status + 1-2-3
export const DESKTOP_APPS = ['claude-desktop', 'chatgpt-desktop', 'claude-code', 'codex-cli', 'grok-build', 'lm-studio', 'cursor', 'vscode', 'gemini-cli', 'antigravity'] as const;
/** Apps that load VTube Pro by themselves as soon as it is added (LM Studio reloads mcp.json on save): no restart step. */
export const SELF_RELOADING: readonly string[] = ['lm-studio'];
/** The part of GET /api/ai/connectors a desktop app row reads (helper 1.0.0-beta.3 and newer). */
export interface AppConnector {
  id: string; name: string; kind: string; supported: boolean; ready: boolean;
  installed?: boolean | null; added?: boolean; current?: boolean; seenAt?: number | null;
  lastTest?: { ok: boolean; at?: number; title?: string } | null; getUrl?: string; getLabel?: string;
}
export type AppStatus = 'connected' | 'restart' | 'update' | 'found' | 'missing' | 'unknown' | 'unsupported';
export function appStatus(c: AppConnector): AppStatus {
  if (!c.supported) return 'unsupported';
  if (c.added && c.current === false) return 'update';
  if (c.ready) return (c.seenAt ?? 0) > 0 || c.lastTest?.ok || SELF_RELOADING.includes(c.id) ? 'connected' : 'restart';
  if (c.installed === true) return 'found';
  if (c.installed === false) return 'missing';
  return 'unknown';
}
export const STATUS_COPY: Record<AppStatus, { chip: string; tone: 'ok' | 'warn' | 'info' | '' }> = {
  connected: { chip: 'Connected', tone: 'ok' },
  restart: { chip: 'Needs restart', tone: 'warn' },
  update: { chip: 'Connect again', tone: 'warn' },
  found: { chip: 'Found', tone: 'info' },
  missing: { chip: 'Not found', tone: '' },
  unknown: { chip: 'Not connected', tone: '' },
  unsupported: { chip: 'Not on this computer', tone: '' },
};
/** Which step of the 1-2-3 is next for this app (1 install, 2 connect, 3 restart, 4 ask). */
export function nextStep(s: AppStatus): 1 | 2 | 3 | 4 {
  if (s === 'missing') return 1;
  if (s === 'restart') return 3;
  if (s === 'connected') return 4;
  return 2;
}
/** `get`: step 1 when the app is not found (default: free to download, log in with your account). */
export const APP_HELP: Record<string, { short: string; where: string; restart: string; get?: string }> = {
  'claude-desktop': { short: 'Claude', where: 'Claude’s connectors list', restart: 'Quit Claude fully (also from the tray or menu bar), then open it again.' },
  'chatgpt-desktop': { short: 'ChatGPT', where: 'ChatGPT’s tools list', restart: 'Quit ChatGPT fully, then open it again.' },
  'claude-code': { short: 'Claude Code', where: 'Claude Code’s tools list', restart: 'Start a new Claude Code session.' },
  'codex-cli': { short: 'Codex', where: 'Codex’s tools list', restart: 'Start a new Codex session.' },
  'grok-build': { short: 'Grok Build', where: 'Grok Build’s tools list', restart: 'Start a new Grok Build session.' },
  // SELF_RELOADING: step 3 is titled "Nothing to restart" and shows this line instead
  'lm-studio': { short: 'LM Studio', where: 'LM Studio’s tools list', restart: 'LM Studio loads it by itself. Pick a model that can use tools.', get: 'It’s free to download. No account needed.' },
  'cursor': { short: 'Cursor', where: 'Cursor’s tools list', restart: 'Quit Cursor fully, then open it again.' },
  'vscode': { short: 'VS Code', where: 'Copilot’s tools list in VS Code', restart: 'Close VS Code, then open it again and use Copilot’s agent mode.' },
  'gemini-cli': { short: 'Gemini CLI', where: 'Gemini CLI’s tools list', restart: 'Start a new Gemini CLI session.' },
  'antigravity': { short: 'Antigravity', where: 'Antigravity’s tools list', restart: 'Quit Antigravity fully, then open it again.' },
};
/** The app to open first: one that needs a restart, else one that was found, else Claude Desktop. */
export function focusApp(list: AppConnector[]): string | null {
  const rows = list.filter((c) => (DESKTOP_APPS as readonly string[]).includes(c.id) && c.supported);
  const by = (s: AppStatus) => rows.find((c) => appStatus(c) === s)?.id;
  return by('restart') ?? by('update') ?? by('found') ?? by('connected') ?? rows[0]?.id ?? null;
}
/** The first thing to ask (owner's example), then more ideas. */
export const FIRST_ASK = 'Make me a cozy cabin room for VTube Pro.';
/** What to paste in a NEW chat first (owner 2026-10-02: "I have VTube Pro and the helper installed. Find it and connect
 *  so I can create with it."): the app finds VTube Pro's tools, checks the link and says what it can make. */
export const CONNECT_ASK = 'I have VTube Pro installed. Find it and connect, so I can create with it.';

// ---------------------------------------------------------------- "Check what Claude made" (pending imports)
// What can be asked: an AI app can't be queried by VTube Pro (MCP calls only go from the app TO the helper), so the
// check reads what the AI's tools SENT to the helper: room packages in the helper's inbox that aren't built yet
// (submit_creation_package) and requests waiting for the user's OK (import_model, install_creation_package ...).
export interface InboxEntry { inboxId: string; from?: string; receivedAt?: string; id?: string; name?: string; action?: string; ok?: boolean }
export interface ApprovalEntry { id: string; tool: string; client?: string; createdAt?: number; expiresAt?: number }
export interface PendingItem { key: string; kind: 'room' | 'approval'; name: string; from: string; at: number; ok: boolean; action: string; inboxId?: string; approvalId?: string; tool?: string }
/** GET /api/ai/pending (helper 1.0.0-beta.5+): the helper's own answer. */
export interface PendingAnswer { v: 1; items: PendingItem[]; checked?: { inbox: number; approvals: number } }
export const isPendingAnswer = (j: unknown): j is PendingAnswer =>
  !!j && typeof j === 'object' && (j as PendingAnswer).v === 1 && Array.isArray((j as PendingAnswer).items);
export const TOOL_WORDS: Record<string, string> = {
  import_model: 'Add a model', import_costume: 'Add an outfit', install_creation_package: 'Build a room',
  update_avatar: 'Change your avatar', set_costume: 'Wear an outfit', send_command: 'Change your live show', blender_run_python: 'Run a Blender script',
  autorig: 'Rig a model', install_comfy_workflow: 'Add a picture recipe', import_room: 'Add a room',
};
const clip = (s: unknown, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/**
 * Inbox packages that are not in the studio yet: a new room whose id is not installed (newest package per id), or a
 * change to a room received in the last `recentMs` (older versions can't say whether a change was already built).
 */
export function pendingFromInbox(inbox: InboxEntry[], installed: Set<string>, now: number, recentMs = 2 * 3600_000): PendingItem[] {
  const newest = new Map<string, InboxEntry>();
  for (const e of inbox) {
    const id = clip(e.id, 48) || e.inboxId;
    const prev = newest.get(id);
    if (!prev || Date.parse(e.receivedAt ?? '') > Date.parse(prev.receivedAt ?? '')) newest.set(id, e);
  }
  const out: PendingItem[] = [];
  for (const [id, e] of newest) {
    const at = Date.parse(e.receivedAt ?? '') || 0;
    const action = e.action === 'modify' ? 'modify' : 'create';
    if (action === 'create' && installed.has(id)) continue;
    if (action === 'modify' && now - at > recentMs) continue;
    out.push({ key: `inbox:${e.inboxId}`, kind: 'room', name: clip(e.name) || clip(e.id) || 'A room', from: clip(e.from, 40) || 'Your AI', at, ok: e.ok !== false, action, inboxId: e.inboxId });
  }
  return out.sort((a, b) => b.at - a.at);
}
export function pendingFromApprovals(list: ApprovalEntry[], now: number): PendingItem[] {
  return list.filter((a) => !a.expiresAt || a.expiresAt > now).map((a) => ({
    key: `approval:${a.id}`, kind: 'approval' as const, name: TOOL_WORDS[a.tool] ?? 'A change', from: clip(a.client, 40) || 'Your AI', at: a.createdAt ?? now, ok: true, action: 'approve', approvalId: a.id, tool: a.tool,
  }));
}
export const IMPORTS_COPY = {
  title: 'Did Claude make something?',
  lead: 'Check for rooms and models your AI made that aren’t in your studio yet.',
  button: 'Check what Claude made',
  checking: 'Checking VTube Pro…',
  nothing: 'Nothing waiting — everything Claude made is already in your studio.',
  found: (n: number) => (n === 1 ? '1 thing is ready to import.' : `${n} things are ready to import.`),
  scanned: 'Checked VTube Pro’s inbox and the requests waiting for your OK.',
  approval: 'Waiting for your OK in VTube Pro.',
  problem: 'It has a problem. Ask your AI to fix it and send it again.',
};
