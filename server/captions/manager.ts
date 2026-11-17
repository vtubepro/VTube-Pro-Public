// Live captions, server side: the studio streams the voice front end's 16 kHz mic signal (with its "performer is
// speaking" gate flag) to /ws/captions-in; this turns it into captions with faster-whisper (tools/voice/whisper_sidecar.py,
// installed on demand) and the stable-prefix policy (server/captions/session.ts), and
//   * pushes them to the OBS overlay page (captions.html, a transparent browser source) over /ws/captions,
//   * appends every finished cue to SRT + VTT sidecar files (server/captions/files.ts, <data>/cache/captions/).
// No second microphone capture: the audio is the one the studio already analyses. Nothing leaves this PC.
//
// Audio frame (binary websocket message, ~100 ms): [u8 n][n gate bytes: 1 = speaking][n x 160 int16 LE samples], n <= 50.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CaptionMsg, CapWord } from '../../shared/captions.ts';
import { joinWords } from '../../shared/captions.ts';
import { DEFAULT_MODEL, WHISPER_MODELS, type WhisperModelId } from '../../tools/voice/voice_setup.ts';
import { ROOT } from '../paths.ts';
import { SidecarProc } from '../voice/sidecarProc.ts';
import type { VoiceSetupJob } from '../voice/setup.ts';
import { CaptionFiles } from './files.ts';
import { CHUNK, CaptionSession, SR, type SessionOpts } from './session.ts';
import { WhisperClient, type ClientState } from './whisperClient.ts';

/** A new overlay (or a config change) is told only the words committed within this long (the overlay's default idle clear). */
export const HELLO_MAX_AGE_MS = 4500;

export type CaptionState = 'off' | 'needs-setup' | 'starting' | 'waiting' | 'on' | 'error';

export interface CaptionConfig {
  on: boolean;
  model: WhisperModelId;
  /** 'en' · 'auto' · another ISO 639-1 code (multilingual models only). */
  lang: string;
  device: 'auto' | 'cpu' | 'cuda';
  /** Show the not-yet-final words on the overlay (they can change: off by default, "no flicker"). */
  showTentative: boolean;
  /** Seconds added to every time in the SRT / VTT files (the recording started earlier / later than the captions). */
  offsetSec: number;
}
export const DEFAULT_CAPTIONS: CaptionConfig = { on: false, model: DEFAULT_MODEL, lang: 'en', device: 'auto', showTentative: false, offsetSec: 0 };

export function sanitizeCaptionConfig(o: unknown, base: CaptionConfig = DEFAULT_CAPTIONS): CaptionConfig {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const model = typeof x.model === 'string' && x.model in WHISPER_MODELS ? x.model as WhisperModelId : base.model;
  const english = model.endsWith('.en');
  const lang = typeof x.lang === 'string' && /^(auto|[a-z]{2})$/.test(x.lang) ? x.lang : base.lang;
  return {
    on: typeof x.on === 'boolean' ? x.on : base.on,
    model,
    lang: english ? 'en' : lang,
    device: x.device === 'cpu' || x.device === 'cuda' || x.device === 'auto' ? x.device : base.device,
    showTentative: typeof x.showTentative === 'boolean' ? x.showTentative : base.showTentative,
    offsetSec: typeof x.offsetSec === 'number' && Number.isFinite(x.offsetSec) ? Math.min(7200, Math.max(-7200, x.offsetSec)) : base.offsetSec,
  };
}

/** One audio frame from the studio → samples + gate flags (null = malformed). */
export function parseAudioFrame(b: Buffer): { pcm: Float32Array; gate: Uint8Array } | null {
  if (b.length < 2) return null;
  const n = b[0];
  if (n < 1 || n > 50 || b.length !== 1 + n + n * CHUNK * 2) return null;
  const gate = new Uint8Array(n);
  for (let i = 0; i < n; i++) gate[i] = b[1 + i] ? 1 : 0;
  const pcm = new Float32Array(n * CHUNK);
  const base = 1 + n;
  for (let i = 0; i < pcm.length; i++) pcm[i] = b.readInt16LE(base + i * 2) / 32768;
  return { pcm, gate };
}

export interface CaptionDeps {
  /** The voice folder (venv + models); see tools/voice/voice_setup.ts. */
  setup: VoiceSetupJob;
  /** Where config/captions.json lives. */
  configFile: string;
  /** Where the SRT / VTT go. */
  filesDir: string;
  port?: number;
  /** Tests: the sidecar's script and extra arguments (a fake model), and the interpreter. */
  script?: string;
  extraArgs?: string[];
  python?: () => string;
  /** Tests: skip the "model installed?" check. */
  skipInstallCheck?: boolean;
  /** A studio page that sent no audio for this long no longer owns the caption audio (default 5 s). */
  ownerStaleMs?: number;
  session?: Partial<SessionOpts>;
  now?: () => number;
  /** The live signal (true = OBS is streaming / recording, false = idle, null = can't tell). Default: the one the GPU sidecars use. */
  live?: () => Promise<boolean | null>;
}

/** The same live signal as server/gpuSidecars.ts (loaded on first use: that module pulls in the OBS link). */
const defaultLive = async (): Promise<boolean | null> => { try { return await (await import('../gpuSidecars.ts')).gpuHooks.live(); } catch { return null; } };

const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export class CaptionManager {
  cfg: CaptionConfig;
  state: CaptionState = 'off';
  detail = '';
  readonly files: CaptionFiles;
  private proc: SidecarProc;
  private client: WhisperClient | null = null;
  private session: CaptionSession | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private overlays = new Set<WebSocket>();
  private source: WebSocket | null = null;
  /** When the page that owns the audio last sent a frame (or connected). */
  private sourceAt = 0;
  private seq = 0;
  private lastAudioAt = 0;
  /** The last committed words with the time each arrived (a hello sends only the fresh ones). */
  private recent: { word: CapWord; at: number }[] = [];
  private tentative = '';
  private starting = false;
  /** 'cpu' = this run was brought back at helper start while live (or while the live state was unknown): no graphics card, whatever config says. */
  private deviceOverride: 'cpu' | null = null;
  private errors = 0;
  private lastError = '';
  readonly wssIn = new WebSocketServer({ noServer: true, maxPayload: 1 << 16, perMessageDeflate: false });
  readonly wssOut = new WebSocketServer({ noServer: true, maxPayload: 1 << 12, perMessageDeflate: false });

  constructor(private d: CaptionDeps) {
    this.cfg = this.load();
    this.files = new CaptionFiles(d.filesDir);
    this.files.offsetSec = this.cfg.offsetSec;
    const port = d.port ?? 5200;
    this.proc = new SidecarProc({
      name: 'whisper', port, script: d.script ?? path.join(ROOT, 'tools', 'voice', 'whisper_sidecar.py'),
      python: d.python ?? (() => this.d.setup.paths().python),
      args: () => [...(d.extraArgs ?? ['--model-dir', this.d.setup.paths().whisper(this.cfg.model), '--device', this.deviceOverride ?? this.cfg.device])],
    });
    this.proc.onExit = (code, reason) => { if (this.cfg.on && code === 2) this.set('needs-setup', 'Install the caption engine first.'); else if (this.cfg.on && !this.client?.info) { this.lastError = reason; this.detail = reason; } };
    this.wssIn.on('connection', (ws) => this.onSource(ws));
    this.wssOut.on('connection', (ws) => this.onOverlay(ws));
    d.setup.beforeRemove.push(() => this.stop(true));
    d.setup.onDone = () => { if (this.cfg.on && (this.state === 'needs-setup' || this.state === 'error')) void this.start(); };
  }

  private now() { return this.d.now?.() ?? Date.now(); }
  private load(): CaptionConfig {
    try { return sanitizeCaptionConfig(JSON.parse(fs.readFileSync(this.d.configFile, 'utf8'))); } catch { return { ...DEFAULT_CAPTIONS }; }
  }
  private save() {
    try {
      fs.mkdirSync(path.dirname(this.d.configFile), { recursive: true });
      const tmp = `${this.d.configFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2));
      fs.renameSync(tmp, this.d.configFile);
    } catch { /* best effort */ }
  }
  private set(s: CaptionState, detail = '') {
    if (s === this.state && detail === this.detail) return;
    this.state = s; this.detail = detail;
    this.out({ type: 'state', seq: ++this.seq, on: this.cfg.on, state: s, detail });
  }

  // ---------------------------------------------------------------- switching on / off
  async setConfig(patch: unknown): Promise<CaptionConfig> {
    const before = this.cfg;
    this.deviceOverride = null; // (the owner's own click: the device they chose counts)
    this.cfg = sanitizeCaptionConfig(patch, before);
    this.files.offsetSec = this.cfg.offsetSec;
    this.save();
    const restart = this.cfg.on && (before.model !== this.cfg.model || before.device !== this.cfg.device || before.lang !== this.cfg.lang);
    if (before.on && !this.cfg.on) await this.stop();
    else if (this.cfg.on && (!before.on || restart)) { if (before.on) await this.stop(true); await this.start(); }
    else this.out(this.hello(++this.seq));
    return this.cfg;
  }

  /** Called at server start: bring captions back if they were on. A helper restarted MID-STREAM must not load the speech model onto
   *  the graphics card (that stalls the game / encoder for seconds): while OBS is live, or when that can't be told, a run that would
   *  use the card (device auto / cuda) starts on the processor instead, with a plain message. The owner's own click (switching
   *  captions off and on, or picking a device) uses the card as chosen. */
  async resume() {
    if (!this.cfg.on) return;
    if (this.cfg.device !== 'cpu') {
      let live: boolean | null = null;
      try { live = await (this.d.live ?? defaultLive)(); } catch { /* unknown */ }
      if (live !== false) this.deviceOverride = 'cpu';
    }
    await this.start();
  }

  async start(): Promise<void> {
    if (this.starting || this.session) return;
    this.starting = true;
    try {
      this.cfg = { ...this.cfg, on: true };
      this.save();
      if (!this.d.skipInstallCheck && !this.d.setup.inspect().models.includes(this.cfg.model)) { this.set('needs-setup', `The ${WHISPER_MODELS[this.cfg.model].label} caption engine is not installed yet.`); return; }
      this.set('starting', 'Starting the caption engine…');
      await this.proc.start();
      this.client?.close();
      const client = new WhisperClient(`ws://127.0.0.1:${this.proc.port}/whisper`, (s, detail) => this.onClient(s, detail));
      this.client = client;
      client.connect();
      this.session = new CaptionSession(client, {
        commit: (words) => this.onCommit(words),
        tentative: (t) => this.onTentative(t),
        cue: (c) => this.files.add(c),
        error: (e) => { this.errors++; this.lastError = String((e as Error)?.message ?? e); },
      }, { lang: this.cfg.lang, ...this.d.session });
      this.files.start(0);
      this.timer ??= setInterval(() => void this.tick(), 100);
    } finally { this.starting = false; }
  }

  /** `silent`: leave the saved on / off alone (a restart, the server shutting down). */
  async stop(silent = false): Promise<void> {
    if (!silent) { this.cfg = { ...this.cfg, on: false }; this.save(); }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const s = this.session; this.session = null;
    try { await s?.end(); } catch { /* */ }
    await this.files.flush();
    this.client?.close(); this.client = null;
    this.proc.stop();
    try { this.source?.close(4001, 'captions are off'); } catch { /* */ }
    this.source = null;
    this.tentative = '';
    this.recent = [];
    if (!silent) { this.set('off'); this.out({ type: 'clear', seq: ++this.seq }); }
  }

  /** "My recording starts now": a new SRT / VTT pair whose time zero is this moment. */
  mark() { if (this.session) this.files.rebase(this.session.now); else this.files.start(0); return this.files.current; }

  private onClient(s: ClientState, detail: string) {
    if (!this.cfg.on) return;
    if (s === 'ready') {
      this.errors = 0;
      const i = this.client?.info;
      const engine = i ? `${i.model} on ${i.device}${i.fallback ? ` (${i.fallback})` : ''}` : '';
      if (this.fresh()) this.set('on', engine); else this.set('waiting', 'Waiting for microphone audio from the studio.');
    }
    else if (s === 'down' && this.state !== 'needs-setup') this.set('starting', detail || this.lastError || 'Waiting for the caption engine…');
  }
  private fresh() { return this.now() - this.lastAudioAt < 3000; }

  // ---------------------------------------------------------------- audio in
  /** One studio page owns the caption audio: the FIRST one that is live. A second page (two tabs, an old tab left open)
   *  is turned away (4002) and waits; it only takes over when the owner has gone quiet (closed, mic off, no frame for
   *  `ownerStaleMs`). Before, the newest page always won, and two tabs with captions on handed the stream back and forth
   *  every retry. */
  private onSource(ws: WebSocket) {
    if (!this.cfg.on || !this.session) { ws.close(4001, 'captions are off'); return; }
    const cur = this.source;
    if (cur && cur.readyState === 1 && this.now() - this.sourceAt < (this.d.ownerStaleMs ?? 5000)) { ws.close(4002, 'another studio page is already sending the captions'); return; }
    try { cur?.close(4000, 'another studio page took over'); } catch { /* */ }
    this.source = ws; this.sourceAt = this.now();
    ws.send(JSON.stringify({ type: 'ready', state: this.state }));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const f = parseAudioFrame(data as Buffer);
      if (!f || this.source !== ws) return;
      // the owner is LIVE as long as well-formed frames arrive, whether or not the recogniser is up yet: while the model
      // starts (seconds, the first time) a second tab must not take the audio away from the page that is already sending
      this.lastAudioAt = this.sourceAt = this.now();
      if (!this.session || this.client?.state !== 'ready') return;        // (nothing to feed yet: those frames are dropped, as before)
      this.session.feed(f.pcm, f.gate);
      if (this.state === 'waiting') this.set('on', this.client?.info ? `${this.client.info.model} on ${this.client.info.device}` : '');
    });
    ws.on('close', () => { if (this.source === ws) this.source = null; });
    ws.on('error', () => ws.terminate());
  }

  private async tick() {
    if (this.ticking || !this.session || this.client?.state !== 'ready') return;
    this.ticking = true;
    try { await this.session.step(); } finally { this.ticking = false; }
    if (this.state === 'on' && !this.fresh()) this.set('waiting', 'No microphone audio is arriving from the studio (is the mic on?).');
  }

  // ---------------------------------------------------------------- out
  private out(m: CaptionMsg) {
    const t = JSON.stringify(m);
    for (const ws of this.overlays) if (ws.readyState === 1 && ws.bufferedAmount < 1 << 20) ws.send(t);
  }
  private onCommit(words: CapWord[]) {
    const at = this.now();
    for (const word of words) this.recent.push({ word, at });
    if (this.recent.length > 60) this.recent.splice(0, this.recent.length - 60);
    this.out({ type: 'cap', seq: ++this.seq, words, tentative: this.cfg.showTentative ? this.tentative : '' });
  }
  private onTentative(t: string) {
    if (t === this.tentative) return;
    this.tentative = t;
    if (this.cfg.showTentative) this.out({ type: 'cap', seq: ++this.seq, words: [], tentative: t });
  }
  /** The hello for an overlay: only words committed within HELLO_MAX_AGE_MS (up to 14), nothing when the last ones are older. */
  private hello(seq: number): CaptionMsg {
    const t = this.now();
    const fresh = this.recent.filter((r) => t - r.at <= HELLO_MAX_AGE_MS).slice(-14);
    return { type: 'hello', seq, on: this.cfg.on, text: joinWords(fresh.map((r) => r.word)), tentative: this.cfg.showTentative,
      ...(fresh.length ? { ageMs: Math.max(0, t - fresh[fresh.length - 1].at) } : {}) };
  }
  private onOverlay(ws: WebSocket) {
    this.overlays.add(ws);
    ws.send(JSON.stringify(this.hello(this.seq)));
    ws.send(JSON.stringify({ type: 'state', seq: this.seq, on: this.cfg.on, state: this.state, detail: this.detail } satisfies CaptionMsg));
    ws.on('close', () => this.overlays.delete(ws));
    ws.on('error', () => ws.terminate());
    ws.on('message', () => { /* the overlay only listens */ });
  }

  upgradeSource(req: IncomingMessage, socket: Duplex, head: Buffer) { this.wssIn.handleUpgrade(req, socket, head, (ws) => this.wssIn.emit('connection', ws, req)); }
  upgradeOverlay(req: IncomingMessage, socket: Duplex, head: Buffer) { this.wssOut.handleUpgrade(req, socket, head, (ws) => this.wssOut.emit('connection', ws, req)); }

  // ---------------------------------------------------------------- status
  async status() {
    const inst = this.d.setup.inspect();
    const st = this.session?.stats;
    const lag = st ? st.lagMs.slice(-300) : [];
    const run = st ? st.runMs.slice(-30) : [];
    const p95 = Math.round(pct(lag, 0.95));
    return {
      config: this.cfg, state: this.state, detail: this.detail,
      installed: { runtime: inst.runtime, engine: inst.captionsPkgs, models: inst.models, gpuLibs: inst.gpuPkgs },
      models: Object.values(WHISPER_MODELS).map((m) => ({ id: m.id, label: m.label, langs: m.langs, mb: m.mb, note: m.note, installed: inst.models.includes(m.id) })),
      engine: this.client?.info ?? null,
      sidecar: await this.proc.status(),
      audio: { live: this.fresh() },
      stats: { runs: st?.runs ?? 0, words: st?.words ?? 0, lagP50Ms: Math.round(pct(lag, 0.5)), lagP95Ms: p95, runMs: run.length ? Math.round(run.reduce((a, b) => a + b, 0) / run.length) : 0, errors: this.errors, lastError: this.lastError },
      deviceNote: this.deviceNote(),
      advice: [this.deviceNote(), p95 > 2000 ? `Captions are running about ${(p95 / 1000).toFixed(1)} seconds behind (the target is under 2). This computer is slow for this speech model: pick a smaller one, or use your graphics card.` : ''].filter(Boolean).join(' '),
      text: joinWords(this.recent.slice(-14).map((r) => r.word)),
      files: { current: this.files.current, list: this.files.list().slice(0, 20) },
    };
  }

  /** Why the captions run on the processor although the card was chosen ('' = they run as configured). */
  private deviceNote() {
    return this.deviceOverride && this.cfg.on
      ? 'The captions came back while you were live (or VTube Pro could not tell), so they run on the processor, not the graphics card, to keep your stream smooth. Switch captions off and on after the stream to use the graphics card again.' : '';
  }

  shutdown() { void this.stop(true); this.wssIn.close(); this.wssOut.close(); }
}

export { SR };
