// Audio + camera speech fusion (pure; shared by the app and tools/eval_mouth.ts).
//
// The camera (lip capture) gives the SHAPE; the mic gives TIMING (~20 ms vs ~80 ms camera latency) and
// the consonants a camera can't see. Voice onsets open the mouth before the camera catches up,
// silence snaps it shut, F/V tucks the lower lip under the teeth, S/SH shows clenched teeth.
//
// The camera is always ~80 ms behind: when a word ends it still sees the lips open, and taking the max
// of camera and voice held the mouth open in every gap between words and through every F. So the
// camera's say depends on timing:
//   talking         the voice leads the shape; the camera mostly adds size
//   between words   (≲ 0.6 s after the voice stops) the late camera is mostly ignored — unless the
//                   mouth is being HELD open (gasp, "ooh" face), which the camera sees steadily
//   silence         the camera owns the mouth (expressions, silent mouthing)
// F/V and S/SH pull the mouth nearly shut whatever either source says.
// A face that is tracked but whose MOUTH is hidden (mic, mug, hand in front: face._mouthVis, mouthVisibility.ts)
// counts as not seeing the mouth: MediaPipe guesses a calm closed mouth there, which must not hold the voice back.
import type { TrackingFrame, TrackingTuning } from '../../shared/types.ts';
import type { AudioMouth } from './audioFeatures.ts';
import { VisemeFusion } from './visemeFusion.ts';
import { DEFAULT_STYLE, type VowelStyle } from './speakingProfile.ts';
import { VocalGestures } from './vocalGestures.ts';

export interface SpeechDbg { cam: number; aud: number; lvl: number; fused: number; fv: number; sib: number; voiced: boolean; camClo?: number; sync?: number }

/** One camera result for the synced closure history: capture time (s), lip gap (face._lipOpen), how much the camera
 *  sees the mouth (0 untracked, else face._mouthVis ?? 1). */
export interface CamSample { t: number; v: number; vis: number }

/** Optional per-step context: content timestamps (seconds, one clock — performance.now()/1000 live). */
export interface FusionOpts {
  /** capture time of this camera frame (requestVideoFrameCallback captureTime) */
  camTime?: number;
  /**
   * the instant the voice frame describes. With the lip-sync lookahead (D ≥ the camera latency, ~80-100 ms) the
   * camera history already covers that instant, so the camera can confirm lip closures ON TIME (a webcam alone is
   * ~80 ms late for a 60 ms "p"). Without the lookahead the camera has not seen that instant yet → unused
   * (today's behaviour).
   */
  voiceTime?: number;
  /**
   * every camera result of this step, oldest first (the studio loop runs ALL results queued since the last tick:
   * app.ts `batch`), each with its own capture time (s), lip gap and mouth visibility (0 = untracked). Without it the
   * closure history saw only the newest result of a batch, and a one-frame M/B/P dip in an earlier one was lost
   * (review of beta.9). Used only with camTime (synced mode); the per-result cam > 0.6 gate applies to each.
   */
  camSamples?: CamSample[];
}

const ss = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };


export class SpeechFusion {
  private sinceVoice = 9;
  private cam: number[] = [];      // recent camera openness (one entry per step)
  private fvS = 0;                 // smoothed fricative / sibilant closures (a frame of detector dropout mustn't pop the mouth open)
  private sibS = 0;
  /** Voice-timed visemes confirmed by the camera → frame.visemes (additive: frame.mouth is unchanged). */
  readonly visemes = new VisemeFusion();
  /** camera lip opening (normalised per user, raw) by capture time, ~0.4 s, for the synced closure-dip detector */
  private lipHist: { t: number; v: number }[] = [];
  /** camera-seen lip closure (0..1) of the last step (synced mode only) */
  camClo = 0;
  /** Voice → mouth-shape constants per vowel: the performer's own from "My speaking profile" (speakingProfile.ts). */
  style: VowelStyle = DEFAULT_STYLE;
  /** how stale (s) the camera's newest frame may be vs the voice's instant for the synced closure (a frame interval
   *  more for slow cameras) */
  syncTol = 0.03;
  /** laughter / shouting (vocalGestures.ts); `vocalOn = false` → off */
  readonly vocal = new VocalGestures();
  vocalOn = true;
  /** 0..1 evidence that the voice in the mic is NOT the performer's (a guest, a call, game / room audio). It only
   *  builds while the camera has seen the performer's lips resting (face._lipAct below 0.2, slackMouth.ts) for a full
   *  second with no syllable landing, and it clears as soon as the lips move above rest. Off: `foreignOn = false`, or
   *  localStorage vtp.foreignGate = '0'. */
  foreign = 0;
  foreignOn = (() => { try { return localStorage.getItem('vtp.foreignGate') !== '0'; } catch { return true; } })();
  /** how much of the voice drove the mouth on the last step (1 = all of it) */
  own = 1;
  /** seconds the lips have rested (no syllable) */
  private lipsStill = 0;
  /** reused per step while the voice is scaled down (no allocation per frame) */
  private scaled: AudioMouth | null = null;
  private scaledVis: Record<string, number> = {};
  /** One camera result into the closure history (the same gate and window as step's own frame: a mouth the camera
   *  doesn't see clearly empties it; ~0.4 s kept). */
  private noteCam(s: CamSample) {
    const h = this.lipHist;
    if (!(s.vis > 0.6)) { h.length = 0; return; }
    if (!h.length || s.t > h[h.length - 1].t + 1e-4) h.push({ t: s.t, v: s.v });
    while (h.length > 2 && h[0].t < s.t - 0.4) h.shift();
  }

  /** Someone else's voice in the mic must not work the performer's mouth. Evidence builds (~0.35 s) only once the
   *  camera has clearly seen the lips at rest for ≥ 1 s with no syllable landing; any lip movement above rest clears it
   *  within ~60 ms (a quiet talker with small lip travel is never attenuated). Then the voice's drive fades to 10 %.
   *  No lip-motion reading (older tracker, phone / VMC source, hidden mouth) → the voice is always the performer's. */
  private ownVoice(frame: TrackingFrame, a: AudioMouth, cam: number, dt: number): AudioMouth {
    const act = frame.face._lipAct;
    if (!this.foreignOn || act === undefined || cam <= 0.6) { this.foreign = 0; this.own = 1; this.lipsStill = 0; return a; }
    this.lipsStill = act < 0.2 ? this.lipsStill + dt : 0;
    const loud = a.level > 0.1 || a.fv > 0.4 || a.sib > 0.4;
    if (act >= 0.2) this.foreign = Math.max(0, this.foreign - dt / 0.06);
    else if (loud && this.lipsStill >= 1) this.foreign = Math.min(1, this.foreign + dt / 0.35);
    else if (!loud) this.foreign = Math.max(0, this.foreign - dt / 1.5);
    const own = 1 - 0.9 * ss(0.35, 0.9, this.foreign);
    this.own = own;
    if (own > 0.999) return a;
    // scaled into one reused object (the caller's AudioMouth is left as it is)
    const o = (this.scaled ??= { ...a });
    Object.assign(o, a);
    o.level = a.level * own; o.open = a.open * own; o.wide = a.wide * own; o.pucker = a.pucker * own; o.funnel = a.funnel * own;
    o.fv = a.fv * own; o.sib = a.sib * own; o.closure = a.closure * own;
    const v = a.visemes;
    if (v) {
      const sv = this.scaledVis;
      for (const k in sv) delete sv[k];
      for (const k in v) sv[k] = k === 'sil' ? 1 - (1 - (v.sil ?? 0)) * own : (v[k as keyof typeof v] ?? 0) * own;
      o.visemes = sv as AudioMouth['visemes'];
    }
    return o;
  }

  step(frame: TrackingFrame, a: AudioMouth, tune: TrackingTuning, dt: number, opt?: FusionOpts): { frame: TrackingFrame; dbg: SpeechDbg } {
    // how much the camera SEES the mouth: 0 untracked, else the mouth visibility (1 when the tracker doesn't say)
    const cam = frame.tracked ? Math.min(1, Math.max(0, frame.face._mouthVis ?? 1)) : 0;
    a = this.ownVoice(frame, a, cam, dt);
    const m = frame.mouth;
    const aw = 1.2 - 0.35 * cam; // audio weight: 0.85 when the camera sees the mouth, 1.2 when it can't (mic-only)
    // scale for the camera's own mouth values: a hidden mouth's guessed shape fades out (an untracked frame keeps its
    // decaying last shape exactly as before)
    const camSee = frame.tracked ? cam : 1;
    const en = tune.enunciation ?? 1.3;
    // how much we're speaking right now: voice-led shapes take over from the (laggy) camera shape
    // (quiet fricatives count too: a held "fffff" is speech even though its level is near zero)
    const speak = Math.max(Math.min(1, a.level * 1.6) * (a.voiced || a.fv > 0.3 || a.sib > 0.3 ? 1 : 0.4), Math.max(a.fv, a.sib) * 0.7);
    const voiceNow = a.level > 0.15 || (a.level > 0.05 && (a.voiced || a.fv > 0.3 || a.sib > 0.3)) || a.fv > 0.45 || a.sib > 0.45;
    this.sinceVoice = voiceNow ? 0 : this.sinceVoice + dt;
    // any clearly HELD mouth shape counts (a held "oh" reads as round more than open)
    this.cam.push(Math.max(m.open, m.funnel * 1.2, m.pucker));
    const keep = Math.max(4, Math.round(0.3 / Math.max(dt, 1e-3)));
    while (this.cam.length > keep) this.cam.shift();
    const camHeld = Math.min(...this.cam); // a clear shape for the whole last 300 ms = deliberately held
    // sharpen vowel weights so A/E/I/O/U read as distinct shapes instead of a mush
    const vw = a.vowels, sq = (x: number) => Math.pow(x, 1 + en);
    const vs = sq(vw.A) + sq(vw.E) + sq(vw.I) + sq(vw.O) + sq(vw.U) || 1;
    const A = sq(vw.A) / vs, E = sq(vw.E) / vs, I = sq(vw.I) / vs, O = sq(vw.O) / vs, U = sq(vw.U) / vs;
    const L = a.level;
    // per-vowel shape constants (generic, or the performer's own speaking profile) — order A E I O U
    const st = this.style, W = [A, E, I, O, U];
    const dw = (k: number[]) => k[0] * W[0] + k[1] * W[1] + k[2] * W[2] + k[3] * W[3] + k[4] * W[4];
    const shapeOpen = L * (st.base + dw(st.open));
    const shapeWide = L * Math.min(1, dw(st.wide) * en);
    const shapeRound = L * Math.min(1, dw(st.round) * en);
    const shapePucker = L * Math.min(1, dw(st.pucker) * en);
    // M/B/P: lips close even if the camera (90 ms late) still sees them open
    let clo = a.closure * (a.voiced || a.level > 0.05 ? 1 : 0.6);
    // synced camera: a quick dip of the lip gap inside speech = the lips really met (M / B / P). MediaPipe rarely
    // shows a brief bilabial fully shut (the gap bottoms out at ~5-10 % of the open range), so this is a RELATIVE
    // dip against the last 150 ms peak, gated to near-closed and to speech. Measured on the test clip: 9/11 M/B/P
    // events, 0 % of neutral frames, ~1-2 % of held-vowel frames (tracking_rnd3/cam/dip.py).
    this.camClo = 0;
    let sync = 0;
    // the earlier results of a batched tick first (the newest is this frame, below: same capture time, not added twice)
    if (opt?.camTime !== undefined && opt.camSamples) for (const s of opt.camSamples) this.noteCam(s);
    if (cam > 0.6 && opt?.camTime !== undefined) {
      const lo = frame.face._lipOpen ?? m.open;
      const h = this.lipHist;
      if (!h.length || opt.camTime > h[h.length - 1].t + 1e-4) h.push({ t: opt.camTime, v: lo });
      while (h.length > 2 && h[0].t < opt.camTime - 0.4) h.shift();
      const tv = opt.voiceTime;
      // the camera must already have seen the voice's instant: within 30 ms, or within ~1 frame interval for a slower
      // camera (a 30 fps webcam / a busy PC delivers a frame every 33-70 ms; with the 60 ms lookahead its newest frame is
      // often a frame older than the voice's instant, and a strict 30 ms test switched the confirmation off)
      const iv = h.length > 1 ? Math.min(0.07, Math.max(0.012, (h[h.length - 1].t - h[0].t) / (h.length - 1))) : 0.02;
      if (tv !== undefined && h.length > 2 && h[h.length - 1].t >= tv - Math.max(this.syncTol, iv * 1.25)) {
        sync = 1;
        let k = h.length - 1;
        while (k > 0 && h[k].t > tv) k--;
        const cur = h[k].v;
        let pk = 0;
        for (let q = k; q >= 0 && h[q].t >= tv - 0.15; q--) pk = Math.max(pk, h[q].v);
        // (MediaPipe's gap dips to ~0.08 for a single frame at 47 Hz; a slower camera rarely samples the bottom, so the
        // "near closed" bar rises with the frame interval: 0.06-0.2 at >= 37 Hz -> 0.10-0.26 at <= 25 Hz)
        const slow = Math.min(1, Math.max(0, (iv - 0.027) / 0.013));
        const dip = (1 - cur / Math.max(pk, 1e-3)) * ss(0.1, 0.25, pk) * ss(0.2 + 0.06 * slow, 0.06 + 0.04 * slow, cur);
        const ctx = this.sinceVoice < 0.25 || a.level > 0.05 ? 1 : 0;
        // a lip-teeth F / V or a clenched S also brings the lips close: the voice's hiss vetoes the seal
        const hissy = Math.max(ss(0.3, 0.6, a.fv), ss(0.3, 0.6, a.sib), ss(0.25, 0.5, (a.visemes?.FF ?? 0) + (a.visemes?.SS ?? 0) + (a.visemes?.CH ?? 0) + (a.visemes?.TH ?? 0)));
        this.camClo = Math.max(0, Math.min(1, dip * ctx * (1 - hissy)));
        clo = Math.max(clo, ss(0.35, 0.75, this.camClo) * 0.9);
      }
    } else if (cam <= 0.6) this.lipHist.length = 0;
    // F/V, S: fast attack, ~60 ms release
    const k = 1 - Math.exp(-dt / 0.06);
    // a real F/V is QUIET (lip-teeth friction, ~0.0-0.1 level on the test clip); the detector also fires
    // on loud hissy speech (SH, CH, Z, TH, breathy vowels at 0.2-0.6) where the lips stay open
    const fvQ = a.fv * (1 - ss(0.1, 0.26, a.level));
    this.fvS = Math.max(ss(0.3, 0.65, fvQ), this.fvS + (0 - this.fvS) * k);
    this.sibS = Math.max(ss(0.3, 0.65, a.sib), this.sibS + (0 - this.sibS) * k);
    // how much the (late) camera may open the mouth right now
    const gap = !voiceNow && this.sinceVoice < 0.6;
    let camTrust: number;
    if (voiceNow) camTrust = 1 - 0.35 * speak;
    else if (gap) camTrust = 0.15 + 0.85 * Math.max(ss(0.45, 0.65, camHeld), ss(0.4, 0.6, this.sinceVoice));
    else camTrust = 1;
    // silent: the camera's small mouth openings (lips resting a hair apart, tracker noise, the breath before
    // a word) read as a CLOSED mouth; deliberate big ones (surprise, yawn, a held "oh") still come through
    const quietGate = voiceNow ? 1 : ss(0.14, 0.32, m.open);
    const camOpen = m.open * quietGate * camSee;
    let open = Math.max(camOpen * camTrust, shapeOpen * aw) * (1 - clo * 0.9);
    open *= (1 - 0.82 * this.fvS) * (1 - 0.55 * this.sibS);
    // laughter keeps the mouth open between the "ha"s (the jaw still bounces on each one); a shout opens wider
    const vg = this.vocalOn ? this.vocal.step(a, dt, a.dbfs) : { laugh: 0, loud: 0 };
    const laughK = ss(0.2, 0.6, vg.laugh), loudK = vg.loud;
    if (loudK > 0.01) open = Math.min(1, open * (1 + 0.22 * loudK) + 0.08 * loudK * Math.min(1, a.level * 2));
    if (laughK > 0.01) open = Math.max(open, 0.26 * laughK);
    const dbg: SpeechDbg = { cam: m.open, aud: a.open, lvl: a.level, fused: open, fv: a.fv, sib: a.sib, voiced: a.voiced, camClo: this.camClo, sync };
    const face = { ...frame.face };
    face.jawOpen = Math.max((face.jawOpen ?? 0) * (voiceNow ? 1 : ss(0.14, 0.32, face.jawOpen ?? 0)) * camTrust * camSee, a.open * aw) * (1 - 0.82 * this.fvS);
    if (loudK > 0.01) face.jawOpen = Math.min(1, face.jawOpen * (1 + 0.22 * loudK));
    if (laughK > 0.01) {
      face.jawOpen = Math.max(face.jawOpen, 0.26 * laughK);
      // a laughing smile — gentle (never past 0.5 from the voice alone; a camera smile passes through)
      for (const s of ['mouthSmileLeft', 'mouthSmileRight']) face[s] = Math.max(face[s] ?? 0, 0.5 * laughK);
    }
    if (quietGate < 1) {
      // lip-parting camera channels follow the same gate
      for (const k of ['mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight']) face[k] = (face[k] ?? 0) * quietGate;
    }
    // while speaking the voice leads the shape; the camera still contributes when it sees more
    const sw = 0.45 + 0.5 * speak;
    const lerpTo = (camV: number, audV: number) => Math.max(camV * camSee * (1 - speak * 0.5) * (gap ? camTrust : 1), audV * sw);
    face.mouthPucker = lerpTo(face.mouthPucker ?? 0, shapePucker);
    face.mouthFunnel = lerpTo(face.mouthFunnel ?? 0, shapeRound);
    face.mouthStretchLeft = lerpTo(face.mouthStretchLeft ?? 0, shapeWide);
    face.mouthStretchRight = lerpTo(face.mouthStretchRight ?? 0, shapeWide);
    face.mouthPressLeft = Math.max(face.mouthPressLeft ?? 0, clo * 0.8);
    face.mouthPressRight = Math.max(face.mouthPressRight ?? 0, clo * 0.8);
    let visemes: Record<string, number> | undefined;
    try { visemes = { ...this.visemes.step(frame, a.visemes, dt, sync, this.camClo) }; } catch { visemes = undefined; }
    // captured inner-lip contour (procedural mouths): the upper and lower lip meet under the same gate
    let lips = frame.lips;
    if (lips && quietGate < 1) {
      const u = lips.u.map((x, i) => { const mid = (x + lips!.l[i]) / 2; return mid + (x - mid) * quietGate; });
      const l = lips.l.map((x, i) => { const mid = (lips!.u[i] + x) / 2; return mid + (x - mid) * quietGate; });
      lips = { u, l };
    }
    return {
      dbg,
      frame: {
        ...frame,
        lips,
        visemes,
        face,
        mouth: {
          ...m,
          open,
          wide: lerpTo(m.wide, shapeWide),
          pucker: lerpTo(m.pucker, shapePucker),
          funnel: lerpTo(m.funnel, shapeRound),
          fv: Math.max(fvQ, this.fvS),
          sib: Math.max(a.sib, this.sibS),
          speak,
          closure: clo,
          gap: a.gap ?? 0,
          ...(laughK > 0.01 ? { laugh: +laughK.toFixed(3), smile: Math.max(m.smile, 0.5 * laughK) } : {}),
          ...(loudK > 0.01 ? { loud: +loudK.toFixed(3) } : {}),
          // voice pitch (prosody for voiceLife) — only on voiced frames
          ...(a.f0 && typeof a.pitch === 'number' ? { pitch: Math.round(a.pitch * 100) / 100 } : {}),
        },
      },
    };
  }
}
