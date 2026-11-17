// The GM's voice on the OBS pages of the host's PC: the studio renders each line on the server, PLAYS it (through the
// audio mixer: src/audio/mixer/showSounds.ts) and tells this PC's OBS pages over the bus ({k:'play', url, at}). The
// page runs the same audio at that wall-clock moment only to MEASURE it — the level drives the GM's mouth, so lip sync
// follows the real audio — into a muted destination: output pages are silent (src/audio/silentPage.ts). Test / preview
// pages skip it unless ?voice=1; a second OBS page can opt out with ?voice=0.
import { VOICE_URL, type TtrpgBus } from '../../../shared/ttrpg/wire.ts';

type Play = Extract<TtrpgBus, { k: 'play' }>;

export class VoicePlayer {
  private ctx: AudioContext | null = null;
  private cur: { id: string; src: AudioBufferSourceNode; an: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;
  private seq = 0;
  /** Debug: the last lines played (id, delay ms, duration s). */
  log: { id: string; late: number; dur: number; err?: string }[] = [];

  constructor(private onLevel: (id: string, v: number) => void) {}

  async play(m: Play) {
    if (!VOICE_URL.test(m.url)) return;
    const seq = ++this.seq;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
      const r = await fetch(m.url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`voice ${r.status}`);
      const data = await this.ctx.decodeAudioData(await r.arrayBuffer());
      if (seq !== this.seq) return;                                   // a newer line (or hush) came first
      this.stop();
      const ctx = this.ctx;
      const src = ctx.createBufferSource(); src.buffer = data;
      const gain = ctx.createGain(); gain.gain.value = Math.max(0, Math.min(1.5, m.vol ?? 1));
      const an = ctx.createAnalyser(); an.fftSize = 512;
      src.connect(gain); gain.connect(an); an.connect(ctx.destination);
      const wait = (m.at - Date.now()) / 1000;
      // late (slow fetch): start now, skipping what was missed only if it is a lot (keeps the mouth + captions in step)
      const skip = wait < -0.35 ? Math.min(data.duration - 0.05, -wait) : 0;
      src.start(ctx.currentTime + Math.max(0, wait), skip);
      this.cur = { id: m.id, src, an, buf: new Float32Array(an.fftSize) };
      src.onended = () => { if (this.cur?.src === src) { this.cur = null; this.onLevel(m.id, 0); } };
      this.log.push({ id: m.id, late: Math.round(Math.max(0, -wait) * 1000), dur: +data.duration.toFixed(2) });
      if (this.log.length > 20) this.log.shift();
    } catch (e) {
      this.log.push({ id: m.id, late: 0, dur: 0, err: (e as Error).message });
      console.warn('[ttrpg] GM voice line failed', e);
    }
  }

  hush(id?: string) { if (!id || this.cur?.id === id) { this.seq++; this.stop(); } }

  private stop() {
    const c = this.cur; this.cur = null;
    if (c) { try { c.src.stop(); } catch { /* not started */ } this.onLevel(c.id, 0); }
  }

  /** Call every frame: feeds the GM's mouth with the real level (~ like the studio's provider voice). */
  tick() {
    const c = this.cur;
    if (!c) return;
    c.an.getFloatTimeDomainData(c.buf);
    let s = 0; for (const x of c.buf) s += x * x;
    this.onLevel(c.id, Math.min(1, Math.sqrt(s / c.buf.length) * 5));
  }

  get playing() { return this.cur?.id ?? null; }
}
