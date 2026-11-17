// Built-in "Create with AI" host for a model that runs ON THIS PC (Ollama / LM Studio / llama.cpp / vLLM / any
// OpenAI-compatible server on a loopback address). VTube Pro runs the agent loop itself: the model's tool calls map to the
// same tool table as the MCP server (server/mcpTools.ts) with the same scopes and approval clicks (server/mcpScopes.ts).
// There is no cloud provider and no key here: every base URL must be a loopback one (localBaseOk), nothing leaves the PC.
// (An AI app of your own, such as Claude Desktop or ChatGPT, uses the MCP server instead: it never goes through this file.)
// Models without native tool calling use the JSON-plan mode: they answer {"tool": ..., "args": ...} / {"final": ...}.
import crypto from 'node:crypto';
import { DERIVED_RESOURCES, HOUSE_RULES } from './aiKnowledge.ts';
import { gate } from './mcpScopes.ts';
import { INSTRUCTIONS, runTool, toolByName, toolJsonSchema, TOOLS, type ToolResult } from './mcpTools.ts';
import { loadConf, requestApproval, TOOL_MODELS } from './aiconnect.ts';
import { localBaseOk } from './aiConnectors.ts';

export interface ProviderInfo { id: string; label: string; baseUrl: string; defaultModel: string }
export const PROVIDERS: ProviderInfo[] = [
  { id: 'ollama', label: 'Ollama (on this PC, free)', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen2.5:14b' },
  { id: 'lmstudio', label: 'LM Studio (on this PC, free)', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'qwen2.5-14b-instruct' },
  { id: 'llamacpp', label: 'llama.cpp / vLLM server (on this PC)', baseUrl: 'http://127.0.0.1:8080/v1', defaultModel: 'local' },
  // "A model on this PC" from the connect wizard (server/aiConnectors.ts): whichever local server it found / the user picked
  { id: 'local', label: 'A model on this PC', baseUrl: '', defaultModel: '' },
];

export interface AgentEvent { t: number; kind: 'user' | 'assistant' | 'tool' | 'result' | 'image' | 'waiting' | 'error' | 'usage' | 'done'; text?: string; tool?: string; image?: string; usage?: Usage }
interface Usage { promptTokens: number; completionTokens: number }
interface Msg { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string }
export interface Session { id: string; provider: string; model: string; mode: 'native' | 'json'; messages: Msg[]; events: AgentEvent[]; busy: boolean; usage: Usage }
const sessions = new Map<string, Session>();
export const getSession = (id: string) => sessions.get(id);

export function resolveProvider(id: string, conf = loadConf()): { info: ProviderInfo; baseUrl: string } {
  const info = PROVIDERS.find((p) => p.id === id);
  if (!info) throw new Error(`Unknown provider "${id}"`);
  const baseUrl = (conf.providers[id]?.baseUrl || info.baseUrl).replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Pick a model on this PC first (AI connectors > A model on this PC).');
  if (!localBaseOk(baseUrl)) throw new Error('The built-in AI only talks to a model on this PC (an address that starts with http://127.0.0.1).');
  return { info, baseUrl };
}

/** The model a provider uses when the chat names none: the wizard's / page's choice, else the built-in default. */
export function modelFor(id: string, conf = loadConf()): string {
  return conf.providers[id]?.model || PROVIDERS.find((p) => p.id === id)?.defaultModel || '';
}

/** Tools whose job is to CHECK work (validate_room, validate_creation_package, check_room, check_avatar ... from any lane). */
export const checkTools = () => TOOLS.filter((t) => /^(check_|validate_)/.test(t.name)).map((t) => t.name);

/**
 * What every AI without MCP gets up front, so it knows the rules even if it never calls get_docs (small local models
 * often don't): the room contract + the avatar checklist (cut from the guides at read time, server/aiKnowledge.ts) and
 * the check tools. MCP clients get the same through INSTRUCTIONS + get_docs + the vtube-pro:// resources.
 */
export async function knowledgeBlock(): Promise<string> {
  const pick = async (uri: string) => { try { return await DERIVED_RESOURCES.find((r) => r.uri === uri)!.read(); } catch { return ''; } };
  const [room, avatar] = await Promise.all([pick('vtube-pro://contract/room'), pick('vtube-pro://contract/avatar')]);
  const checks = checkTools();
  return [
    checks.length ? `# Check before you call anything done\nRun these check tools on every room / avatar you make or fix, and fix what they report: ${checks.join(', ')}.` : '',
    room ? `# Room contract (what an environment needs; docs/ARTIST_ENVIRONMENTS.md)\n${room}` : '',
    avatar ? `# Avatar checklist (docs/ARTIST_AVATARS.md)\n${avatar}` : '',
  ].filter(Boolean).join('\n\n');
}

export async function systemPrompt(mode: 'native' | 'json'): Promise<string> {
  // models on this PC often run with a small context: they get the contracts + checks but not the whole connect guide
  // (get_docs {topic:"connect"} still has it)
  const knowledge = await knowledgeBlock();
  const tools = mode === 'json'
    ? '\n\n# Tools (JSON-plan mode)\nYou cannot call functions natively. To use a tool reply with ONLY one JSON object: {"tool": "<name>", "args": {...}}. ' +
      'You get the result back and continue. When done reply {"final": "<your answer to the user>"}.\nTools:\n' +
      TOOLS.map((t) => `- ${t.name} [${t.scope}]: ${t.description} args schema: ${JSON.stringify(toolJsonSchema(t).properties ?? {})}`).join('\n')
    : '';
  return `${INSTRUCTIONS}\n\nYou are the "Create with AI" assistant inside VTube Pro. Plan, then act with the tools.\n` +
    `- Rooms: read get_docs {topic:"environments"} (the room contract, budgets, camera rules), write a creation package ` +
    `(get_instruction_pack), validate_creation_package until clean, then install_creation_package (the user approves the Blender run), then validate_room and check_room (at least 1 seat, 2+ recommended; ` +
    `it suggests SPOT_xx + cameras when a room has none). A user who only wants their own room file working can use the studio's "Add my room" wizard, ` +
    `or you can add the file for them with import_room (the same steps; the user approves it).\n` +
    `- Avatars: read get_docs {topic:"avatars"} first. Build them with blender_run_python (the user approves it) or generate_avatar with the ` +
    `local ComfyUI recipe; humans come from a proper base. Look at the result with render_avatar from several views before you call it done.\n` +
    `- Costumes: read get_docs {topic:"avatars", section:"costumes"}; build the costume GLB with blender_run_python, add it with import_costume and wear it with set_costume (the user approves what changes the stream).\n` +
    `- When unsure, call get_docs with a topic and a section word instead of guessing.\n\n${HOUSE_RULES}` +
    `${knowledge ? `\n\n${knowledge}` : ''}${tools}`;
}

/** Pull the first JSON object out of a model reply (fenced or bare). */
export function parseJsonPlan(s: string): { tool?: string; args?: unknown; final?: string } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const cand = fenced ? fenced[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  try { const j = JSON.parse(cand); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

const flatten = (r: ToolResult, s: Session) => r.content.map((c) => {
  if (c.type === 'image') {
    // a tool's image goes into the approvals page as <img src>: only a plain image type and base64 data, nothing else
    const type = /^image\/(png|jpeg|gif|webp)$/.test(String(c.mimeType)) ? c.mimeType : '';
    if (!type || !/^[A-Za-z0-9+/=]+$/.test(String(c.data))) return '[image: not shown (not a PNG / JPEG / GIF / WebP)]';
    s.events.push({ t: Date.now(), kind: 'image', image: `data:${type};base64,${c.data}` }); return '[image: shown to the user in the chat panel]';
  }
  return c.text;
}).join('\n').slice(0, 30000);

type Fetch = typeof fetch;
export async function startTurn(o: { sessionId?: string; provider: string; model?: string; message: string; mode?: 'auto' | 'native' | 'json' }, fetchImpl: Fetch = fetch): Promise<Session> {
  const { info, baseUrl } = resolveProvider(o.provider);
  let s = o.sessionId ? sessions.get(o.sessionId) : undefined;
  if (s?.busy) throw new Error('The assistant is still working on the last message.');
  const model = o.model || modelFor(o.provider);
  if (!s) {
    const mode = o.mode === 'native' || o.mode === 'json' ? o.mode : !TOOL_MODELS.test(model) ? 'json' : 'native';
    s = { id: crypto.randomUUID(), provider: o.provider, model, mode, messages: [{ role: 'system', content: await systemPrompt(mode) }], events: [], busy: false, usage: { promptTokens: 0, completionTokens: 0 } };
    sessions.set(s.id, s);
  }
  s.messages.push({ role: 'user', content: o.message });
  s.events.push({ t: Date.now(), kind: 'user', text: o.message });
  s.busy = true;
  void loop(s, baseUrl, fetchImpl).catch((e) => s!.events.push({ t: Date.now(), kind: 'error', text: (e as Error).message })).finally(() => { s!.busy = false; s!.events.push({ t: Date.now(), kind: 'done' }); });
  return s;
}

async function callTool(s: Session, name: string, args: unknown): Promise<string> {
  const def = toolByName(name);
  if (!def) return `Unknown tool "${name}". Tools: ${TOOLS.map((t) => t.name).join(', ')}`;
  s.events.push({ t: Date.now(), kind: 'tool', tool: name, text: JSON.stringify(args ?? {}).slice(0, 2000) });
  const refusal = await gate(def, args, {
    settings: loadConf().scopes, origin: 'local', client: `Create with AI (${s.provider})`,
    requestApproval: (r) => { s.events.push({ t: Date.now(), kind: 'waiting', tool: name, text: 'Waiting for your Approve click (see Approvals above).' }); return requestApproval(r); },
  });
  const out = refusal ?? flatten(await runTool(def, args), s);
  s.events.push({ t: Date.now(), kind: 'result', tool: name, text: out.slice(0, 4000) });
  return out;
}

async function loop(s: Session, baseUrl: string, fetchImpl: Fetch, maxSteps = 24) {
  const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toolJsonSchema(t) } }));
  for (let step = 0; step < maxSteps; step++) {
    const body: Record<string, unknown> = { model: s.model, messages: s.messages };
    if (s.mode === 'native') body.tools = tools;
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000),
    });
    const txt = await res.text();
    if (!res.ok) {
      if (s.mode === 'native' && res.status === 400 && /tool/i.test(txt)) { // model/server without tool support -> JSON-plan mode
        s.mode = 'json'; s.messages[0] = { role: 'system', content: await systemPrompt('json') };
        s.events.push({ t: Date.now(), kind: 'assistant', text: '(This model does not support tool calling; switched to JSON-plan mode.)' });
        continue;
      }
      throw new Error(`Your model app answered HTTP ${res.status}: ${txt.slice(0, 400)}`);
    }
    const j = JSON.parse(txt);
    const u = j.usage ?? {};
    s.usage.promptTokens += u.prompt_tokens ?? 0; s.usage.completionTokens += u.completion_tokens ?? 0;
    s.events.push({ t: Date.now(), kind: 'usage', usage: { ...s.usage } });
    const m = j.choices?.[0]?.message ?? {};
    if (s.mode === 'native' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      s.messages.push({ role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls });
      if (m.content) s.events.push({ t: Date.now(), kind: 'assistant', text: m.content });
      for (const tc of m.tool_calls) {
        let args: unknown = {};
        try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* bad JSON from the model */ }
        s.messages.push({ role: 'tool', tool_call_id: tc.id, content: await callTool(s, tc.function?.name, args) });
      }
      continue;
    }
    const content = String(m.content ?? '');
    s.messages.push({ role: 'assistant', content });
    if (s.mode === 'json') {
      const plan = parseJsonPlan(content);
      if (plan?.tool) { s.messages.push({ role: 'user', content: `Result of ${plan.tool}:\n${await callTool(s, plan.tool, plan.args)}` }); continue; }
      s.events.push({ t: Date.now(), kind: 'assistant', text: plan?.final ?? content });
      return;
    }
    s.events.push({ t: Date.now(), kind: 'assistant', text: content });
    return;
  }
  s.events.push({ t: Date.now(), kind: 'error', text: `Stopped after ${maxSteps} steps. Say "continue" to go on.` });
}
