// Tool scopes + the local approval gate shared by every AI host (docs/AI_CONNECT.md).
//   read / render / create : on by default (create = new library items, never worn / never live)
//   library                : "ask" by default (update_avatar, import_model, import_costume, autorig, import_room)
//   live, python           : ALWAYS ask - a click in the studio (AI connectors page); can be switched off, never to "allow"
//   diag                   : local only (device + tracking state), never over the remote tunnel
//   There is NO scope (and no tool) that starts or ends a broadcast: going live is a person's click in the studio, or a
//   Stream Deck key confirmed on screen (the Go Live rule, docs/GO_LIVE.md). "live" below means "changes what viewers
//   see" (costume, commands), never "starts the stream". assertNoGoLiveScope() keeps it that way.
export type Scope = 'read' | 'render' | 'create' | 'library' | 'live' | 'python' | 'diag';
export type Policy = 'allow' | 'ask' | 'deny';

export interface ScopeSettings {
  read: 'allow' | 'deny';
  render: 'allow' | 'deny';
  create: 'allow' | 'ask' | 'deny';
  library: 'allow' | 'ask' | 'deny';
  live: 'ask' | 'deny';
  python: 'ask' | 'deny';
  diag: 'allow' | 'deny';
}

export const DEFAULT_SCOPES: ScopeSettings = { read: 'allow', render: 'allow', create: 'allow', library: 'ask', live: 'ask', python: 'ask', diag: 'allow' };

export const SCOPE_LABELS: Record<Scope, string> = {
  read: 'Read (status, lists, guides, validation)',
  render: 'Render previews',
  create: 'Create new library items / rooms (never worn)',
  library: 'Change the library (update / import / rig)',
  live: 'Change what viewers see (wear costume, commands). Can never start or stop your stream',
  python: 'Run Blender Python (build scripts)',
  diag: 'Diagnostics (camera frame + tracking state)',
};

/** Tools a REMOTE (tunnel) client may ever see. Never python, live, library or diag. */
export const REMOTE_SAFE = new Set([
  'get_docs', 'get_creator_guide', 'get_instruction_pack', 'status', 'list_avatars', 'get_avatar', 'list_costumes', 'list_rooms', 'get_job',
  'wait_for_job', 'validate_room', 'room_checklist', 'creation_spec', 'validate_creation_package', 'submit_creation_package', 'render_avatar',
  // ai-local (read-only text: tier tables + ComfyUI workflows; the hardware summary only if the user switched sharing on)
  'local_ai_recommend', 'comfy_workflows',
]);

const ALLOWED: Record<Scope, readonly Policy[]> = {
  read: ['allow', 'deny'], render: ['allow', 'deny'], create: ['allow', 'ask', 'deny'], library: ['allow', 'ask', 'deny'],
  live: ['ask', 'deny'], python: ['ask', 'deny'], diag: ['allow', 'deny'],
};

/** Words that would make a scope (or a tool) able to start, stop or schedule a broadcast. No capability may carry one:
 *  tools/golive_guard_unit.ts runs the same test over every scope and every MCP tool. */
export const GOLIVE_WORDS = /go[-_ ]?live|golive|broadcast|start[-_ ]?(stream|record|output)|stream[-_ ]?(start|on)|end[-_ ]?show/i;

/** Throws if any scope name looks like a broadcast capability. Runs once at load (below), so a "golive" scope can never ship. */
export function assertNoGoLiveScope(scopes: readonly string[]): void {
  const bad = scopes.filter((s) => GOLIVE_WORDS.test(s));
  if (bad.length) throw new Error(`MCP scopes must never start or stop a broadcast (the Go Live rule): remove ${bad.map((b) => `"${b}"`).join(', ')}`);
}
assertNoGoLiveScope(Object.keys(ALLOWED));

/** Clamp anything stored / sent to what each scope may be (live + python can never become "allow"). */
export function normalizeScopes(raw: unknown): ScopeSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SCOPES } as Record<Scope, Policy>;
  for (const k of Object.keys(ALLOWED) as Scope[]) if (ALLOWED[k].includes(src[k] as Policy)) out[k] = src[k] as Policy;
  return out as unknown as ScopeSettings;
}

/** What happens when `scope` is called from `origin`. Remote callers only reach REMOTE_SAFE tools (checked by the host). */
export function decide(scope: Scope, settings: ScopeSettings, origin: 'local' | 'remote' = 'local'): Policy {
  if (!Object.hasOwn(ALLOWED, scope)) return 'deny'; // an unknown scope (a typo, or a "golive" someone tried to add) is never approvable
  if (origin === 'remote' && (scope === 'python' || scope === 'live' || scope === 'library' || scope === 'diag')) return 'deny';
  return (settings as unknown as Record<Scope, Policy>)[scope] ?? 'ask';
}

export interface ApprovalRequest { tool: string; scope: Scope; client: string; args: unknown }
/** pending = the user hasn't answered yet (a polled approval: the call returns at once, the AI calls again). */
export type Decision = { approved: boolean; reason?: string; pending?: boolean };

/** gate() returns text starting with this when a polled approval is still waiting: the host answers
 *  {status: "waiting_for_ok"} (not an error) and the AI calls the same tool again with the same arguments. */
export const WAITING_PREFIX = 'WAITING_FOR_OK ';
export const POLL_WAIT_MS = 40_000;

/**
 * Gate a call: returns null when it may run, else the refusal text. `ask` goes to the approval queue and waits for the
 * user's click (or the 5 min timeout = denied). `settings` / `requestApproval` are injected so every host (stdio MCP via
 * HTTP, the in-process AI host, tests) shares this exact logic.
 */
export async function gate(
  tool: { name: string; scope: Scope },
  args: unknown,
  o: { settings: ScopeSettings; origin?: 'local' | 'remote'; client: string; requestApproval: (r: ApprovalRequest) => Promise<Decision> },
): Promise<string | null> {
  const p = decide(tool.scope, o.settings, o.origin ?? 'local');
  if (p === 'allow') return null;
  if (p === 'deny') return `"${tool.name}" is switched off in VTube Pro (scope "${tool.scope}"). The user can change this on the AI connectors page (Settings -> AI connectors).`;
  const d = await o.requestApproval({ tool: tool.name, scope: tool.scope, client: o.client, args });
  if (d.approved) return null;
  // a polled approval still waiting (Claude Desktop cancels a tool call after ~60 s, so nobody blocks for minutes)
  if (d.pending) return WAITING_PREFIX + JSON.stringify({ status: 'waiting_for_ok', tool: tool.name,
    message: `"${tool.name}" waits for the user's OK. Tell them in one sentence to press Approve in VTube Pro (the "Your AI is waiting for your OK" notice, or http://127.0.0.1:${process.env.VTP_PORT ?? 5191}/aiconnect on their computer). Then call ${tool.name} again with exactly the same arguments: it runs as soon as they approved. Don't call anything else that changes their library or stream meanwhile.` });
  // nobody answered: say where the OK is given, so the AI can point the user at it (2026-10-03 report)
  if (/timed out/.test(d.reason ?? '')) return `Nobody answered the approval for "${tool.name}" (${d.reason}). Ask the user to open the approval page on their computer (http://127.0.0.1:${process.env.VTP_PORT ?? 5191}/aiconnect) or the "Your AI is waiting for your OK" notice in the studio, then try again when they say they're ready.`;
  return `The user did not approve "${tool.name}"${d.reason ? ` (${d.reason})` : ''}. Do not retry it unless they ask.`;
}
