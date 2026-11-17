// Kokoro-82M alert voice (Apache-2.0 weights), local and free: a supervised sidecar (tools/voice/kokoro_sidecar.py,
// installed on demand with the voice pack, server/voice/) that turns a line of text into a WAV buffer. This file only ever
// produces bytes; it never plays anything. The Chat Hub's read-aloud uses it as a third engine
// (server/chat/readAloudVoice.ts, falling back to this computer's voice on any problem).
//   GET  /api/kokoro/status                 → installed? voices, sidecar, last timing
//   POST /api/kokoro/say {text, voice?, speed?} → audio/wav (this PC only; the Chat Hub's "Test voice" and tools use it)
// The sidecar starts on the first line and stops after `idleMs` without one (it holds ~300 MB).
import path from 'node:path';
import { Router } from 'express';
import WebSocket from 'ws';
import { KOKORO_VOICES } from '../tools/voice/voice_setup.ts';
import { HttpError } from './library.ts';
import { ROOT } from './paths.ts';
import { requireLocal } from './routes/util.ts';
import { voiceSetup } from './voice/routes.ts';
import { SidecarProc } from './voice/sidecarProc.ts';
import type { VoiceSetupJob } from './voice/setup.ts';


export interface KokoroDeps {
  setup: VoiceSetupJob;
  port?: number;
  script?: string;
  python?: () => string;
  extraArgs?: string[];
  skipInstallCheck?: boolean;
  idleMs?: number;
  timeoutMs?: number;
}
export interface KokoroResult { audio: Buffer; type: 'audio/wav'; dur: number; ms: number; spelled: string[]; skipped: string[] }

/** The line has nothing this voice can say (only emoji, Han / Hangul words, symbols ...). Not a failure: the caller skips the
 *  LINE and the engine is neither rested nor reported as "not ready". */
export class KokoroSkip extends Error { readonly skip = true; }
export const DEFAULT_VOICE = 'af_heart';
export const MAX_CHARS = 600;

export class KokoroEngine {
  private proc: SidecarProc;
  private ws: WebSocket | null = null;
  private voices: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  private id = 0;
  lastMs = 0;
  lastError = '';
  private pending: { id: number; head: { seconds?: number; ms?: number; spelled?: string[]; skipped?: string[] } | null; resolve(r: KokoroResult): void; reject(e: Error): void; timer: NodeJS.Timeout } | null = null;

  constructor(private d: KokoroDeps) {
    this.proc = new SidecarProc({
      name: 'kokoro', port: d.port ?? 5201, script: d.script ?? path.join(ROOT, 'tools', 'voice', 'kokoro_sidecar.py'),
      python: d.python ?? (() => d.setup.paths().python),
      args: () => d.extraArgs ?? ['--model-dir', d.setup.paths().kokoro],
    });
    d.setup.beforeRemove.push(() => this.stop());
  }

  installed() { const i = this.d.setup.inspect(); return this.d.skipInstallCheck ? true : i.kokoro; }

  /** Say one line. Rejects (never throws synchronously) when Kokoro is not installed, not starting, or the line is empty. */
  say(text: string, o: { voice?: string; speed?: number } = {}): Promise<KokoroResult> {
    const run = () => this.sayNow(text, o);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async sayNow(text: string, o: { voice?: string; speed?: number }): Promise<KokoroResult> {
    const clean = String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!clean) throw new Error('nothing to say');
    // no letter or digit in ANY script (emoji, symbols): nothing to start a sidecar for
    if (!/[\p{L}\p{N}]/u.test(clean)) throw new KokoroSkip('nothing the voice can say');
    if (!this.installed()) throw new Error('Kokoro is not installed yet');
    const voice = typeof o.voice === 'string' && /^[a-z]{2}_[a-z]+$/.test(o.voice) ? o.voice : DEFAULT_VOICE;
    const speed = Math.min(1.6, Math.max(0.6, Number(o.speed) || 1));
    await this.connect();
    this.touch();
    const ws = this.ws!;
    const id = ++this.id;
    return new Promise<KokoroResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; this.lastError = 'the alert voice took too long'; reject(new Error(this.lastError)); try { ws.close(); } catch { /* */ } }, this.d.timeoutMs ?? 30000);
      this.pending = { id, head: null, resolve, reject, timer };
      ws.send(JSON.stringify({ type: 'say', id, text: clean, voice, speed }), (err) => { if (err) { clearTimeout(timer); this.pending = null; reject(err); } });
    });
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.stop(); }, this.d.idleMs ?? 5 * 60_000);
    this.idle.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await this.proc.start();
    const url = `ws://127.0.0.1:${this.proc.port}/kokoro`;
    const deadline = Date.now() + 40_000;
    let lastErr = '';
    while (Date.now() < deadline) {
      try { await this.open(url); return; } catch (e) { lastErr = (e as Error).message; }
      const st = await this.proc.status();
      if (!st.running && !st.starting) { this.lastError = st.error || lastErr || 'the alert voice did not start'; throw new Error(this.lastError); }
      await new Promise((r) => setTimeout(r, 400));
    }
    this.lastError = lastErr || 'the alert voice did not start in time';
    throw new Error(this.lastError);
  }

  private open(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: 3000, maxPayload: 1 << 26 });
      let ready = false;
      ws.on('message', (d, isBinary) => {
        if (isBinary) {
          const p = this.pending;
          if (!p || !p.head) return;
          this.pending = null; clearTimeout(p.timer);
          const audio = Buffer.from(d as Buffer);
          this.lastMs = Number(p.head.ms) || 0;
          p.resolve({ audio, type: 'audio/wav', dur: Number(p.head.seconds) || 0, ms: this.lastMs, spelled: Array.isArray(p.head.spelled) ? p.head.spelled.map(String) : [], skipped: Array.isArray(p.head.skipped) ? p.head.skipped.map(String) : [] });
          return;
        }
        let m: { type?: string; id?: number; voices?: unknown; error?: string; code?: string; seconds?: number; ms?: number; spelled?: string[]; skipped?: string[] };
        try { m = JSON.parse(String(d)); } catch { return; }
        if (m.type === 'ready') { ready = true; this.ws = ws; this.voices = Array.isArray(m.voices) ? m.voices.map(String) : []; this.lastError = ''; resolve(); }
        else if (m.type === 'audio' && this.pending && m.id === this.pending.id) this.pending.head = m;
        else if (m.type === 'error' && this.pending && m.id === this.pending.id) {
          const p = this.pending; this.pending = null; clearTimeout(p.timer);
          if (m.code === 'unspeakable') { p.reject(new KokoroSkip(String(m.error ?? 'nothing the voice can say'))); return; }   // (not an error of the engine)
          this.lastError = String(m.error ?? 'error'); p.reject(new Error(this.lastError));
        }
      });
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        const p = this.pending; if (p) { this.pending = null; clearTimeout(p.timer); p.reject(new Error('the alert voice closed')); }
        if (!ready) reject(new Error('closed before ready'));
      });
      ws.on('error', (e) => { if (!ready) reject(e); });
    });
  }

  stop() {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    try { this.ws?.close(); } catch { /* */ }
    this.ws = null;
    this.proc.stop();
  }

  async status() {
    const i = this.d.setup.inspect();
    return {
      installed: this.installed(), runtime: i.runtime,
      voices: (i.kokoroVoices.length ? i.kokoroVoices : this.voices).map((id) => ({ id, label: KOKORO_VOICES[id]?.label ?? id })),
      allVoices: Object.entries(KOKORO_VOICES).map(([id, v]) => ({ id, label: v.label })),
      sidecar: await this.proc.status(), lastMs: this.lastMs, lastError: this.lastError,
    };
  }
}

export const kokoro = new KokoroEngine({ setup: voiceSetup, port: Number(process.env.VTP_KOKORO_PORT) || 5201 });

export function kokoroRoutes(e: KokoroEngine = kokoro) {
  const r = Router();
  r.get('/api/kokoro/status', async (req, res) => { requireLocal(req); const st = await e.status(); res.json(st); });
  r.post('/api/kokoro/say', async (req, res) => {
    requireLocal(req);
    const b = (req.body ?? {}) as { text?: unknown; voice?: unknown; speed?: unknown };
    if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'text is needed');
    try {
      const a = await e.say(b.text, { voice: typeof b.voice === 'string' ? b.voice : undefined, speed: Number(b.speed) || undefined });
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('X-Seconds', String(a.dur));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(a.audio);
    } catch (err) {
      if (err instanceof KokoroSkip) { res.status(422).json({ error: err.message, skip: true }); return; }
      throw new HttpError(503, (err as Error).message);
    }
  });
  return r;
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) process.once(sig, () => { try { kokoro.stop(); } catch { /* */ } if (sig !== 'exit') process.exit(0); });
