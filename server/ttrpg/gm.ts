// One AI GM turn on the server: rate limit + token budget → prompt (shared/ttrpg/gm.ts) → streamed call to the model on
// this PC → the narration streamed back to the host studio as it arrives (SSE), the actions parsed + schema-validated at the
// end, token usage added to the session meter. One turn at a time; the studio can abort it.
import type { Response } from 'express';
import { NarrationSplitter, estimateTokens, gmSystemPrompt, gmUserPrompt, parseGmOutput, summaryPrompt, type GmContext } from '../../shared/ttrpg/gm.ts';
import { loadTtrpgConfig, scrub } from './config.ts';
import { ProviderError, streamChat, type Usage } from './providers.ts';

export interface SpendMeter { calls: number; input: number; output: number; since: number; recent: number[] }
const meter: SpendMeter = { calls: 0, input: 0, output: 0, since: Date.now(), recent: [] };
export const spend = () => ({ ...meter, recent: undefined, lastMinute: meter.recent.filter((t) => Date.now() - t < 60_000).length, budgetTokens: loadTtrpgConfig().limits.sessionTokens });
export function resetSpend() { Object.assign(meter, { calls: 0, input: 0, output: 0, since: Date.now(), recent: [] }); }

let running: AbortController | null = null;
let lastCall = 0;
export const gmBusy = () => !!running;
export function abortGm() { running?.abort(); }

function account(u: Usage) {
  meter.calls++; meter.input += u.input; meter.output += u.output;
}

/** Throws a ProviderError(429) when the host's limits say no. */
function gate() {
  const c = loadTtrpgConfig();
  const now = Date.now();
  if (running) throw new ProviderError('The GM is already answering — wait or press Stop.', 409);
  if (now - lastCall < c.limits.minGapSec * 1000) throw new ProviderError(`Slow down: at least ${c.limits.minGapSec} s between GM turns (TTRPG → limits).`, 429);
  meter.recent = meter.recent.filter((t) => now - t < 60_000);
  if (meter.recent.length >= c.limits.perMinute) throw new ProviderError(`Rate limit: ${c.limits.perMinute} GM turns per minute (TTRPG → limits).`, 429);
  if (meter.input + meter.output >= c.limits.sessionTokens) throw new ProviderError(`Session token budget reached (${meter.input + meter.output} tokens). Raise it or reset the meter.`, 402);
  lastCall = now; meter.recent.push(now);
}

const sseWrite = (res: Response, obj: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

/** POST /api/ttrpg/gm/turn → text/event-stream of {t:'delta', text} … {t:'turn', narration, actions, dropped} {t:'done', usage, meter} | {t:'error', message, status}. */
export async function gmTurn(ctx: GmContext, res: Response, override?: { model?: string }) {
  const c = loadTtrpgConfig();
  const model = (override?.model && /^[A-Za-z0-9._:/@+-]{1,120}$/.test(override.model) ? override.model : '') || c.model;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  try { gate(); } catch (e) { sseWrite(res, { t: 'error', message: (e as Error).message, status: (e as ProviderError).status ?? 429 }); res.end(); return; }
  const ctl = new AbortController();
  running = ctl;
  res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
  const system = gmSystemPrompt(ctx), user = gmUserPrompt(ctx);
  const split = new NarrationSplitter();
  let emitted = '';
  const t0 = Date.now();
  let first = 0;
  try {
    let usage: Usage | null = null;
    for await (const ev of streamChat({ model, system, user, maxTokens: c.maxTokens, temperature: c.temperature, signal: ctl.signal })) {
      if (ev.t === 'delta') {
        const shown = split.push(ev.text);
        if (shown) { if (!first) first = Date.now() - t0; emitted += shown; sseWrite(res, { t: 'delta', text: shown }); }
      } else usage = ev.usage;
    }
    const turn = parseGmOutput(split.text);
    // anything the splitter held back (a JSON-only answer, a trailing partial) — send the rest of the narration
    if (turn.narration.startsWith(emitted.trim()) && turn.narration.length > emitted.trim().length) sseWrite(res, { t: 'delta', text: turn.narration.slice(emitted.trim().length) });
    const u = usage ?? { input: estimateTokens(system + user), output: estimateTokens(split.text), estimated: true };
    account(u);
    sseWrite(res, { t: 'turn', narration: turn.narration, actions: turn.actions, dropped: turn.dropped, raw: split.text.length > 20000 ? split.text.slice(0, 20000) : split.text });
    sseWrite(res, { t: 'done', usage: u, firstMs: first, ms: Date.now() - t0, model, meter: spend() });
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError((e as Error).message);
    sseWrite(res, { t: 'error', message: scrub(err.message), status: err.status, partial: emitted });
  } finally {
    if (running === ctl) running = null;
    res.end();
  }
}

/** Memory compaction (a short, separate call): returns the new summary text. */
export async function gmSummary(prev: string, transcript: { who: string; text: string }[]): Promise<{ text: string }> {
  const c = loadTtrpgConfig();
  gate();
  const ctl = new AbortController();
  running = ctl;
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    let text = '', usage: Usage | null = null;
    for await (const ev of streamChat({ model: c.model, system: 'You keep concise, accurate campaign notes for a tabletop Game Master.', user: summaryPrompt(prev, transcript), maxTokens: 400, temperature: 0.3, signal: ctl.signal })) {
      if (ev.t === 'delta') text += ev.text; else usage = ev.usage;
    }
    account(usage ?? { input: 0, output: estimateTokens(text), estimated: true });
    return { text: text.replace(/\[\[ACTIONS\]\][\s\S]*$/i, '').trim().slice(0, 1600) };
  } finally { clearTimeout(timer); if (running === ctl) running = null; }
}
