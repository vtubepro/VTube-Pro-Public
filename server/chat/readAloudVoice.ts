// Which voice reads a Chat Hub line (server/chat/hostHub.ts say()): this computer's voices (free, the default) or Kokoro,
// a free voice that runs on this PC (server/kokoro.ts). Both run locally: nothing is sent anywhere and no account or key
// is involved.
//   - Kokoro problem (not installed, a crashed sidecar) -> that line uses this computer's voice, one plain status line
//     in the Chat Hub, and a 30 s rest before Kokoro is tried again (a missing install must not make every line wait).
//   - Kokoro had nothing it could say in a line (only emoji / unsupported scripts) -> the line is skipped, not read by
//     another voice, and nothing is reported as broken.
// Pure policy over injected engines.
import type { TtsSettings, VoiceStatus } from '../../shared/chathub.ts';
import { DEFAULT_KOKORO } from '../../shared/chathub.ts';

export interface Rendered { audio: Buffer; type: string; dur: number; engine: 'system' | 'kokoro' }
export interface ReadAloudDeps {
  system(text: string, o: { voice?: string; rate?: number }): Promise<{ audio: Buffer; type: string; dur: number }>;
  /** Kokoro on this PC (server/kokoro.ts): a WAV buffer. Absent / rejecting = this computer's voice reads instead. */
  kokoro?(text: string, o: { voice: string; speed: number }): Promise<{ audio: Buffer; type: string; dur: number }>;
  now?(): number;
}

/** Kokoro had nothing it could say in this line (only emoji / unsupported scripts): the line is skipped, not read by another
 *  voice, and nothing is reported as broken. */
export class LineSkipped extends Error {}
export const KOKORO_NOTE = 'The Kokoro voice isn’t ready (install it in Settings), so that line used your computer’s voice.';
const KOKORO_REST_MS = 30_000;

export class ReadAloudVoice {
  private note = '';
  private noteAt = 0;
  private kokoroRestUntil = 0;
  /** What happened, for tests / diagnostics (never the text). */
  readonly log: string[] = [];

  constructor(private d: ReadAloudDeps) {}
  private now() { return this.d.now?.() ?? Date.now(); }
  private say(n: string) { if (n) { this.note = n; this.noteAt = this.now(); } }

  status(): VoiceStatus {
    return { note: this.note, noteAt: this.noteAt };
  }

  private system(text: string, t: TtsSettings): Promise<Rendered> {
    return this.d.system(text, { voice: t.voice || undefined, rate: t.rate }).then((a) => ({ ...a, engine: 'system' as const }));
  }

  /** Kokoro (free, local): any problem -> this computer's voice for that line, and a 30 s rest before trying again. */
  private async kokoro(text: string, t: TtsSettings): Promise<Rendered> {
    const k = t.kokoro ?? DEFAULT_KOKORO;
    if (!this.d.kokoro || this.now() < this.kokoroRestUntil) { this.log.push('skip:kokoro'); return this.system(text, t); }
    try {
      const a = await this.d.kokoro(text, { voice: k.voice, speed: k.speed });
      this.log.push('kokoro');
      if (this.note === KOKORO_NOTE) { this.note = ''; this.noteAt = 0; }
      return { audio: a.audio, type: a.type, dur: a.dur || a.audio.length / 48_000, engine: 'kokoro' };
    } catch (err) {
      if ((err as { skip?: boolean }).skip) { this.log.push('skip:line'); throw new LineSkipped((err as Error).message); }   // no rest, no note
      this.kokoroRestUntil = this.now() + KOKORO_REST_MS;
      this.log.push('fallback:kokoro');
      this.say(KOKORO_NOTE);
      return this.system(text, t);
    }
  }

  /** Render one line with the chosen engine. */
  async render(text: string, t: TtsSettings): Promise<Rendered> {
    if (t.engine === 'kokoro') return this.kokoro(text, t);
    return this.system(text, t);
  }
}
