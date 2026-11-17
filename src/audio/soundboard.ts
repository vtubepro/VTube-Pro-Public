// Soundboard player, studio side (beta.16 "soundfx" lane, docs/b16/SOUNDFX.md). Plays a sting when the bus command `sfx`
// arrives (Stream Deck, a rule, a key) or a cue fires (an emote, an outfit, a redeem, the scream).
//
// WHERE IT PLAYS: in the STUDIO window, never on the OBS page. Since beta.12 the OBS page is silent by design
// (src/audio/silentPage.ts) and exactly one studio window plays the show's sounds (src/audio/mixer/audioLeader.ts); your stream
// hears the studio the way it hears your guests (docs/SOUND.md). So a sting goes out through the show output of the leading
// window (the mixer's Games row, which is the only open output that is not tied to a feature) and nowhere else: an observer
// tab, a second studio window and every OBS page stay quiet.
//
// OFF BY DEFAULT: nothing plays until the streamer switches the Soundboard on (config/soundboard.json `on`).
//
// Everything the player touches comes in through BoardDeps, so tools/soundboard_unit.ts drives it with a fake audio context
// that counts what it was told to start and makes no sound.
import {
  MAX_SOUND_SECS, SoundGate, matchCues, soundGain, soundKind, synthSting, type CueTrigger, type FxPresetId, type SoundboardCfg,
} from '../../shared/soundboard.ts';

/** The slice of AudioContext the player uses. */
export interface BoardCtx {
  readonly currentTime: number;
  createBufferSource(): { buffer: AudioBuffer | null; connect(n: AudioNode): unknown; start(when?: number): void; stop(when?: number): void; onended: (() => void) | null };
  createGain(): { gain: { value: number }; connect(n: AudioNode): unknown; disconnect(): void };
  decodeAudioData(b: ArrayBuffer): Promise<AudioBuffer>;
}
export interface BoardOut { ctx: BoardCtx; node: AudioNode }
/** Starts a synthesised sound into `dest`; stop() cuts it. */
export type SynthFn = (ctx: BoardCtx, dest: AudioNode, gain: number) => { stop(): void };
export interface BoardDeps {
  /** The show's output of the window that plays (null = this window must stay quiet: observer, not the leader, no audio). */
  out(): BoardOut | null;
  cfg(): SoundboardCfg;
  /** The bytes of a file sound (a starter sting or one of the streamer's). */
  load(id: string): Promise<ArrayBuffer | null>;
  synth(name: string): SynthFn | null;
  now(): number;
  wait(ms: number): Promise<void>;
}
/** The headphones Test button plays a file through the mixer's timed-line path (showSounds.playLine), which drops a clip whose
 *  start time has passed by more than its length. A first press has to fetch and decode the file before it can start, and
 *  the shortest stings are only 0.06 to 0.17 s long, so the start time is set this far ahead of the press: the wait is
 *  never negative by more than the fetch-and-decode time, and the sting plays instead of being skipped as "already over". */
export const TEST_LEAD_MS = 400;
export function testStartAt(now: number): number { return now + TEST_LEAD_MS; }

export type PlayVerdict = 'played' | 'off' | 'quiet' | 'again' | 'busy' | 'rate' | 'nolead' | 'missing';

const BUF_CAP = 12;
const SYNTH_MS = 1800;

export class SoundboardPlayer {
  readonly gate = new SoundGate();
  /** What started (tests / the panel's "last played" line). */
  readonly log: { id: string; at: number; gain: number }[] = [];
  private bufs = new Map<string, Promise<AudioBuffer | null>>();
  private live = new Set<{ stop(): void }>();
  constructor(private d: BoardDeps) {}

  /** Start a sound. `vol` 0..1 on top of the master and the sound's own volume. Never throws. */
  async play(id: string, vol = 1): Promise<PlayVerdict> {
    try {
      const cfg = this.d.cfg();
      if (!cfg.on) return 'off';
      const kind = soundKind(id);
      if (!kind) return 'missing';
      const gain = soundGain(cfg, id, vol);
      if (gain <= 0.001) return 'quiet';
      // the leading window is still being chosen for a moment after the studio opens: look again once before giving up
      let out = this.d.out();
      if (!out) { await this.d.wait(450); out = this.d.out(); }
      if (!out) return 'nolead';
      if (kind === 'synth') {
        const fn = this.d.synth(synthSting(id)?.synth ?? '');
        if (!fn) return 'missing';
        const v = this.gate.admit(id, SYNTH_MS, this.d.now());
        if (v !== 'ok') return v;
        this.track(fn(out.ctx, out.node, gain), SYNTH_MS);
        this.note(id, gain);
        return 'played';
      }
      const buf = await this.buffer(id);
      if (!buf) return 'missing';
      out = this.d.out();
      if (!out) return 'nolead';                     // (lost the lead while the file loaded)
      const secs = Math.min(buf.duration, MAX_SOUND_SECS);
      const v = this.gate.admit(id, secs * 1000, this.d.now());
      if (v !== 'ok') return v;
      const src = out.ctx.createBufferSource(), g = out.ctx.createGain();
      src.buffer = buf; g.gain.value = gain;
      src.connect(g as unknown as AudioNode); g.connect(out.node);
      src.start();
      src.stop(out.ctx.currentTime + secs + 0.05);
      const h = { stop: () => { try { src.stop(); } catch { /* not started */ } try { g.disconnect(); } catch { /* gone */ } } };
      this.track(h, secs * 1000 + 100);
      src.onended = () => { this.live.delete(h); try { g.disconnect(); } catch { /* gone */ } };
      this.note(id, gain);
      return 'played';
    } catch { return 'missing'; }
  }
  private note(id: string, gain: number) { this.log.push({ id, at: this.d.now(), gain }); if (this.log.length > 40) this.log.shift(); }
  private track(h: { stop(): void }, ms: number) { this.live.add(h); (setTimeout(() => this.live.delete(h), ms + 200) as unknown as { unref?: () => void }).unref?.(); }
  /** Decoded once, kept (a few at most: a 20 s clip is a few MB). A file that failed is tried again next time. */
  private buffer(id: string): Promise<AudioBuffer | null> {
    const hit = this.bufs.get(id);
    if (hit) return hit;
    const out = this.d.out();
    const p = out
      ? this.d.load(id).then((b) => (b ? out.ctx.decodeAudioData(b.slice(0)) : null)).catch(() => null).then((b) => { if (!b) this.bufs.delete(id); return b; })
      : Promise.resolve(null);
    if (out) {
      this.bufs.set(id, p);
      while (this.bufs.size > BUF_CAP) this.bufs.delete(this.bufs.keys().next().value as string);
    }
    return p;
  }
  /** The streamer deleted a file or changed it: forget the decoded copy. */
  forget(id: string) { this.bufs.delete(id); }
  /** Cut everything that is sounding (this window lost the lead, the Soundboard was switched off). */
  stopAll() { for (const h of [...this.live]) { try { h.stop(); } catch { /* */ } } this.live.clear(); }
}

// ---------------------------------------------------------------- cues

export interface CueDeps {
  cfg(): SoundboardCfg;
  playSound(id: string, vol: number): void;
  fireFx(preset: FxPresetId, secs: number): void;
}
/**
 * "When X happens, play Y": an emote started, an outfit put on, a redeem. `eventId` (a platform id when there is one) makes a
 * happening that two paths report (the chat line and the rule engine) fire once.
 */
export class CueRunner {
  private seen = new Map<string, number>();
  constructor(private d: CueDeps) {}
  trigger(t: CueTrigger, eventId?: string, now = Date.now()): number {
    const cfg = this.d.cfg();
    // (not gated on the sounds switch: a cue may be only a screen effect; a sound that is switched off is refused by the player)
    if (!cfg.cues.length) return 0;
    if (eventId) {
      const key = `${t.kind}:${eventId}`;
      for (const [k, at] of this.seen) if (now - at > 60_000) this.seen.delete(k);
      if (this.seen.has(key)) return 0;
      this.seen.set(key, now);
      if (this.seen.size > 200) this.seen.delete(this.seen.keys().next().value as string);
    }
    const hit = matchCues(cfg.cues, t);
    for (const c of hit) {
      if (c.sound) this.d.playSound(c.sound, c.vol);
      if (c.fx) this.d.fireFx(c.fx.preset, c.fx.secs);
    }
    return hit.length;
  }
  /** The scream went off: its sound and effect. */
  scream(): boolean {
    const s = this.d.cfg().scream;
    if (!s.on) return false;
    if (s.sound) this.d.playSound(s.sound, 1);
    if (s.fx) this.d.fireFx(s.fx.preset, s.fx.secs);
    return !!(s.sound || s.fx);
  }
}
