// Voice signals for the interview director, on every page (OBS host + guests, the Scene-tab preview):
//  · performers: each rendered frame's `mouth.speak` (the voice front-end's "speaking" 0..1; party members: from their
//    voice samples, src/net/remoteSmoother.ts) and the camera mouth, kept apart for activity.ts (the mouth counts only
//    by its movement, and only without a mic). Read by
//    wrapping the actor's AvatarRuntime.update on this page (restored on detach; no engine change needed);
//  · video guests: a level the studio's director measures from an audio input the host picks (the call's audio through a
//    loopback / virtual cable, or an audio mixer input) and sends to this PC's OBS pages ~10× a second while one is picked
//    (src/ui/stage/interviewHost.ts), as bus {type:'command', command:'interview', args:{v:[…]}};
//    without it, a video guest is presumed to talk while everyone with a voice is quiet (director.ts `voiceless`).
//  The host's studio measures all of this itself and sends the director's cuts (cues); pages use these only when no
//  cue arrives.
import type { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import type { TrackingFrame } from '../../../shared/types.ts';

type UpdateFn = AvatarRuntime['update'];

/** A simulated voice (test pages: VoiceTap.test) at time `ts` (s): `level` shaped like speech — uneven syllables and a
 *  gap between words — never a flat level (a flat level is a fan to the speaker detector and is tuned out). */
export function testSpeak(level: number, ts: number): number {
  if (!(level > 0.05) || (ts % 0.9) >= 0.74) return 0;
  return level * (0.35 + 0.65 * Math.abs(Math.sin(ts * Math.PI * 5.2 + 1.6 * Math.sin(ts * 2.3) + 0.9 * Math.sin(ts * 5.9))));
}

export class VoiceTap {
  private taps = new Map<AvatarRuntime, { orig: UpdateFn; key: string }>();
  private level = new Map<string, { v: number; speak: number | null; open: number | null; at: number }>();
  /** Test pages only: simulated voices (member key → 0..1) — levels AND a talking mouth on the avatar. */
  test: Map<string, number> | null = null;
  /** Video guest levels from the studio meter (index → level), with the time they arrived. */
  private video: { v: (number | null)[]; at: number } = { v: [], at: -1e9 };

  /** Keep taps on exactly these runtimes (key = member key). */
  sync(list: { key: string; rt: AvatarRuntime | null }[]) {
    const want = new Map(list.filter((x) => x.rt).map((x) => [x.rt!, x.key]));
    for (const [rt, t] of this.taps) if (want.get(rt) !== t.key) { rt.update = t.orig; this.taps.delete(rt); }
    for (const [rt, key] of want) {
      if (this.taps.has(rt)) continue;
      const orig = rt.update;
      const self = this;
      const wrapped = function (this: AvatarRuntime, frame: TrackingFrame, ...rest: unknown[]) {
        const tv = self.test?.get(key);
        if (tv !== undefined && frame) {
          // (like speech, not a flat level: uneven syllables and a gap between words — a flat test level reads as a fan
          // to the speaker detector and is tuned out after a few seconds, src/scene/talkshow/activity.ts)
          const sp = testSpeak(tv, performance.now() / 1000 + key.length * 0.37);
          const o = sp * 0.85;
          frame = { ...frame, mouth: { ...frame.mouth, open: o, speak: sp }, face: { ...frame.face, jawOpen: o * 0.8 } };
        }
        try {
          const m = frame?.mouth;
          if (m) {
            // the raw signals, kept apart (activity.ts decides what is speech): the mic's `speak` (the loudest sub-step of
            // the rendered frame) and the camera mouth (the newest; only its movement counts, never how open it rests —
            // a mouth that rests open read as "talking" for 9 minutes in the VOD of 2026-10-08)
            const now = performance.now(), cur = self.level.get(key);
            const sp = typeof m.speak === 'number' && Number.isFinite(m.speak) ? m.speak : null;
            const op = frame.tracked === false ? null : Number.isFinite(m.open) ? m.open : null;
            const fresh = !cur || now - cur.at > 8;
            self.level.set(key, { v: sp ?? 0, speak: sp === null ? (fresh ? null : cur!.speak) : fresh ? sp : Math.max(cur!.speak ?? 0, sp), open: op, at: now });
          }
        } catch { /* never break the avatar */ }
        return (orig as (...a: unknown[]) => unknown).call(this, frame, ...rest);
      } as unknown as UpdateFn;
      rt.update = wrapped;
      this.taps.set(rt, { orig, key });
    }
  }

  /** Performer's mic level 0..1 (0 when silent / stale for > 0.5 s / no mic). */
  get(key: string): number {
    const l = this.level.get(key);
    return l && performance.now() - l.at < 500 ? l.speak ?? 0 : 0;
  }
  /** Performer's raw signals for activity.ts: the mic's speak (null = no mic) and the camera mouth (null = not seen);
   *  null when nothing was rendered for them in the last 0.5 s. */
  signals(key: string): { speak: number | null; open: number | null } | null {
    const l = this.level.get(key);
    return l && performance.now() - l.at < 500 ? { speak: l.speak, open: l.open } : null;
  }

  pushVideo(v: unknown) {
    if (!Array.isArray(v)) return;
    // (null = no input picked for that caller: voiceless, never "silent")
    this.video = { v: v.slice(0, 3).map((x) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null)), at: performance.now() };
  }
  /** Video guest i level, or null when no meter data arrived recently. */
  videoLevel(i: number): number | null {
    if (performance.now() - this.video.at > 1500) return null;
    return this.video.v[i] ?? null;
  }

  dispose() {
    for (const [rt, t] of this.taps) rt.update = t.orig;
    this.taps.clear();
  }
}
