// Streaming chat for the AI GM, on a model server on THIS PC. Server-side only.
//  - chat: Ollama, LM Studio, llama.cpp, KoboldCpp, anything OpenAI-compatible, on a loopback address (/chat/completions SSE)
//  - voice / speech-to-text: an optional OpenAI-compatible voice or whisper server on this PC (Kokoro, openedai-speech, a local whisper)
// Every adapter yields text deltas and ends with usage (reported by the server, or estimated). Nothing here leaves the PC.
import { estimateTokens } from '../../shared/ttrpg/gm.ts';
import { loadTtrpgConfig, scrub } from './config.ts';

export interface StreamReq { model: string; system: string; user: string; maxTokens: number; temperature: number; signal: AbortSignal }
export interface Usage { input: number; output: number; estimated: boolean; cacheRead?: number }
export type StreamEv = { t: 'delta'; text: string } | { t: 'done'; usage: Usage; stop: string };

export class ProviderError extends Error { constructor(msg: string, readonly status = 502) { super(scrub(msg)); } }

export const baseUrl = (): string => loadTtrpgConfig().local.url;

export async function* streamChat(r: StreamReq): AsyncGenerator<StreamEv> {
  if (!r.model) throw new ProviderError('Pick a model first (TTRPG → AI Game Master → model). Start your model app (Ollama, LM Studio ...) and press "Find models".', 400);
  yield* streamOpenAi(r);
}

/** Server-sent events → JSON payloads ("data: …" lines; "[DONE]" ends). */
async function* sse(res: Response): AsyncGenerator<unknown> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1));
      const m = /^data:\s?(.*)$/.exec(line);
      if (!m) continue;
      if (m[1].trim() === '[DONE]') return;
      try { yield JSON.parse(m[1]); } catch { /* keep-alive / partial */ }
    }
  }
}

async function fail(res: Response, what: string, model: string): Promise<never> {
  const t = await res.text().catch(() => '');
  let msg = t.slice(0, 400);
  try { const j = JSON.parse(t); msg = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : msg); } catch { /* text */ }
  if (res.status === 404) throw new ProviderError(`${what}: model “${model}” not found (${msg}).`, 404);
  throw new ProviderError(`${what} error ${res.status}: ${msg}`, res.status >= 400 && res.status < 600 ? res.status : 502);
}

async function* streamOpenAi(r: StreamReq): AsyncGenerator<StreamEv> {
  const base = baseUrl();
  const body: Record<string, unknown> = {
    model: r.model, stream: true,
    messages: [{ role: 'system', content: r.system }, { role: 'user', content: r.user }],
    max_tokens: r.maxTokens, temperature: r.temperature, stream_options: { include_usage: true },
  };
  let res: Response;
  try { res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: r.signal }); }
  catch (e) {
    if ((e as Error).name === 'AbortError') throw new ProviderError('Stopped.', 499);
    throw new ProviderError(`Can’t reach ${base} — is the model app running?`, 503);
  }
  if (!res.ok) await fail(res, 'Your model app', r.model);
  let out = '', usage: Usage | null = null, stop = 'end_turn';
  try {
    for await (const j of sse(res)) {
      const o = j as any;
      const d = o?.choices?.[0]?.delta?.content;
      const piece = typeof d === 'string' ? d : Array.isArray(d) ? d.map((x: any) => x?.text ?? '').join('') : '';
      if (piece) { out += piece; yield { t: 'delta', text: piece }; }
      if (o?.choices?.[0]?.finish_reason) stop = o.choices[0].finish_reason;
      if (o?.usage && typeof o.usage.prompt_tokens === 'number') usage = { input: o.usage.prompt_tokens, output: o.usage.completion_tokens ?? 0, estimated: false };
      if (o?.error) throw new ProviderError(`Your model app: ${o.error.message ?? JSON.stringify(o.error).slice(0, 200)}`);
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ProviderError('Stopped.', 499);
    throw e instanceof ProviderError ? e : new ProviderError(`Your model app’s answer broke off: ${(e as Error).message}`);
  }
  yield { t: 'done', usage: usage ?? { input: estimateTokens(r.system + r.user), output: estimateTokens(out), estimated: true }, stop };
}

// ---------------------------------------------------------------- model list + connection test
export async function listModels(signal?: AbortSignal): Promise<string[]> {
  const sig = signal ?? AbortSignal.timeout(8000);
  const base = baseUrl();
  try {
    const res = await fetch(`${base}/models`, { signal: sig });
    if (!res.ok) {
      // Ollama's native list as a fallback (older Ollama builds without /v1/models)
      if (/11434/.test(base)) {
        const r2 = await fetch(base.replace(/\/v1$/, '') + '/api/tags', { signal: sig });
        if (r2.ok) { const j = await r2.json() as { models?: { name: string }[] }; return (j.models ?? []).map((m) => m.name); }
      }
      await fail(res, 'Your model app', '');
    }
    const j = await res.json() as { data?: { id: string }[]; models?: { id?: string; name?: string }[] };
    return (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean).slice(0, 400);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(`Can’t reach ${base} — is the model app running? (${(e as Error).message})`, 503);
  }
}

/** "Test connection": list models, then a tiny generation with the chosen model (free: it runs on this PC). */
export async function testConnection(model: string): Promise<{ ok: boolean; models: string[]; reply: string; ms: number; error?: string }> {
  const t0 = Date.now();
  let models: string[] = [];
  try { models = await listModels(); } catch (e) { if (!model) return { ok: false, models: [], reply: '', ms: Date.now() - t0, error: (e as Error).message }; }
  const use = model || models[0] || '';
  if (!use) return { ok: false, models, reply: '', ms: Date.now() - t0, error: 'No models found' };
  let reply = '';
  try {
    const ctl = AbortSignal.timeout(90_000);
    for await (const ev of streamChat({ model: use, system: 'You are a connection test. Reply with exactly: Ready to roll!', user: 'Say it.', maxTokens: 400, temperature: 0, signal: ctl })) {
      if (ev.t === 'delta') reply += ev.text;
    }
    return { ok: true, models, reply: reply.trim().slice(0, 80), ms: Date.now() - t0 };
  } catch (e) { return { ok: false, models, reply, ms: Date.now() - t0, error: (e as Error).message }; }
}

// ---------------------------------------------------------------- TTS / STT (optional voice servers on this PC; the browser's own voice is the free default)
export async function synthesize(text: string, voice?: string, signal?: AbortSignal): Promise<{ audio: ArrayBuffer; type: string }> {
  const c = loadTtrpgConfig();
  if (c.tts.provider === 'browser') throw new ProviderError('TTS is set to the browser voice (no server TTS).', 400);
  const res = await fetch(`${c.tts.url}/audio/speech`, { method: 'POST', signal: signal ?? AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.tts.model, voice: voice || c.tts.voice, input: text.slice(0, 1200), response_format: 'mp3' }) }).catch((e) => { throw new ProviderError(`Voice server unreachable: ${(e as Error).message}`, 503); });
  if (!res.ok) await fail(res, 'Your voice server', c.tts.model);
  return { audio: await res.arrayBuffer(), type: res.headers.get('content-type') || 'audio/mpeg' };
}

export async function transcribe(audio: Buffer, mime: string): Promise<string> {
  const c = loadTtrpgConfig();
  if (c.stt.provider === 'browser') throw new ProviderError('Speech-to-text is set to the browser.', 400);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), `speech.${/ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm'}`);
  form.append('model', c.stt.model);
  const res = await fetch(`${c.stt.url}/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
    .catch((e) => { throw new ProviderError(`Speech-to-text server unreachable: ${(e as Error).message}`, 503); });
  if (!res.ok) await fail(res, 'Your speech-to-text server', c.stt.model);
  const j = await res.json() as { text?: string };
  return String(j.text ?? '').trim().slice(0, 500);
}
