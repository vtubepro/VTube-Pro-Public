// AI co-host (docs/b16/COHOST.md): the one call to the AI. It uses the model the user already set up on the "Connect an AI"
// page (docs/AI_CONNECT.md): a model running on this PC (Ollama / LM Studio / llama.cpp: free, nothing leaves the PC).
// There is no cloud path and no key: every address here is a loopback one. Every network call goes through the injected
// `fetch`, so a test talks to a mock and never to a real model.
import type { CohostConfig } from './config.ts';

export interface AiRow { id: string; label: string; baseUrl: string; model: string }
export interface AiDeps {
  fetch: typeof fetch;
  /** The user's connections (server/aiAgent.ts PROVIDERS + resolveProvider + modelFor). `ready` false = not set up (no address). */
  rows(): AiRow[];
}
export interface AiConn extends AiRow { models?: string[] }

/** The local runners tried by 'auto', in this order. */
export const AUTO_ORDER = ['local', 'ollama', 'lmstudio', 'llamacpp'] as const;
const PROBE_MS = 1500;
export const REPLY_TIMEOUT_MS = 25_000;
const AUTO_KEEP_MS = 60_000;

export class AiError extends Error {
  constructor(readonly kind: 'none' | 'busy' | 'slow' | 'down' | 'bad' | 'empty', message: string) { super(message); }
}
/** The words a streamer reads (the Check button and the panel's status line). */
export const AI_SAYS: Record<AiError['kind'], string> = {
  none: 'No AI is connected yet. Open "Connect an AI" and set up a model on this PC.',
  busy: 'The AI is busy right now. The co-host will try again with the next question.',
  slow: 'The AI took too long to answer, so the co-host skipped that one.',
  down: 'The co-host cannot reach the AI. If it is a model on this PC, make sure it is running.',
  bad: 'The AI could not answer that.',
  empty: 'The AI sent back nothing to say.',
};

const trimBase = (u: string) => u.replace(/\/+$/, '');

/** Is a model server answering at this connection? Returns its model ids, or null. */
async function probe(c: AiRow, f: typeof fetch): Promise<string[] | null> {
  if (!c.baseUrl) return null;
  try {
    const r = await f(`${trimBase(c.baseUrl)}/models`, { signal: AbortSignal.timeout(PROBE_MS) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null) as { data?: { id?: string }[]; models?: { id?: string; name?: string }[] } | null;
    const list = (j?.data ?? j?.models ?? []).map((m) => (m as { id?: string; name?: string }).id ?? (m as { name?: string }).name ?? '').filter(Boolean);
    return list.length ? list.slice(0, 100) : [];
  } catch { return null; }
}

let autoChoice: { id: string; at: number } | null = null;
/** Tests: forget the remembered 'auto' pick. */
export function resetAutoChoice() { autoChoice = null; }

/** Which connection answers. 'auto' = the first model on this PC that is running; else the one the user picked. */
export async function pickConn(cfg: Pick<CohostConfig, 'model'>, d: AiDeps, now = Date.now()): Promise<AiConn> {
  const rows = d.rows();
  const want = cfg.model.provider;
  if (want !== 'auto') {
    const r = rows.find((x) => x.id === want);
    if (!r || !r.baseUrl) throw new AiError('none', AI_SAYS.none);
    return { ...r, model: cfg.model.model || r.model };
  }
  const order = AUTO_ORDER.map((id) => rows.find((r) => r.id === id)).filter((r): r is AiRow => !!r && !!r.baseUrl);
  if (autoChoice && now - autoChoice.at < AUTO_KEEP_MS) {
    const keep = order.find((r) => r.id === autoChoice!.id);
    if (keep) return { ...keep, model: cfg.model.model || keep.model };
  }
  for (const r of order) {
    const models = await probe(r, d.fetch);
    if (models === null) continue;
    autoChoice = { id: r.id, at: now };
    return { ...r, model: cfg.model.model || r.model || models[0] || '', models };
  }
  throw new AiError('none', AI_SAYS.none);
}

/** The status the panel shows for every connection: is it usable? (A model on this PC is "ready" when it answers.) */
export async function connectionStatus(d: AiDeps): Promise<{ id: string; label: string; ready: boolean }[]> {
  const out: { id: string; label: string; ready: boolean }[] = [];
  const rows = d.rows();
  await Promise.all(rows.map(async (r) => {
    const ready = !!r.baseUrl && (await probe(r, d.fetch)) !== null;
    out.push({ id: r.id, label: r.label, ready });
  }));
  const order = d.rows().map((r) => r.id);
  return out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export interface CompleteReq { system: string; user: string; maxTokens?: number; signal?: AbortSignal }

/** One chat completion on an OpenAI-compatible endpoint. Throws AiError (plain words), never the raw provider text. */
export async function complete(c: AiConn, d: Pick<AiDeps, 'fetch'>, q: CompleteReq): Promise<string> {
  if (!c.baseUrl) throw new AiError('none', AI_SAYS.none);
  const body = {
    model: c.model, stream: false, temperature: 0.8,
    messages: [{ role: 'system', content: q.system }, { role: 'user', content: q.user }],
    max_tokens: q.maxTokens ?? 200,
  };
  const sig = q.signal ? AbortSignal.any([q.signal, AbortSignal.timeout(REPLY_TIMEOUT_MS)]) : AbortSignal.timeout(REPLY_TIMEOUT_MS);
  let res: Response;
  try { res = await d.fetch(`${trimBase(c.baseUrl)}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: sig }); }
  catch (e) { const n = (e as Error).name; throw new AiError(n === 'TimeoutError' || n === 'AbortError' ? 'slow' : 'down', AI_SAYS[n === 'TimeoutError' || n === 'AbortError' ? 'slow' : 'down']); }
  if (!res.ok) {
    const k = res.status === 429 || res.status === 402 ? 'busy' : res.status >= 500 ? 'down' : 'bad';
    throw new AiError(k, AI_SAYS[k]);
  }
  const j = await res.json().catch(() => null) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = j?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((p) => (p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : '')).join('') : typeof content === 'string' ? content : '';
  if (!text.trim()) throw new AiError('empty', AI_SAYS.empty);
  return text;
}
