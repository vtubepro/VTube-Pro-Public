// "When tracking is lost" settings (per avatar profile: profile.tracking.trackLoss). The runtime is
// src/tracking/trackLoss.ts. Pure data + sanitising, shared by the studio, the OBS page and the deck registry.
//
//   hold  freeze in place and pick up where it left off (VTube Studio style, the default)
//   rest  ease back to the avatar's rest pose
//   life  voice-driven face life (src/avatar/voiceLife.ts): blinks, gaze, head beats from the voice.
//         Face / eyes only — body and hands treat it as `rest`.

export type TrackLossMode = 'hold' | 'rest' | 'life';
export type TrackLossPart = 'face' | 'eyes' | 'body' | 'hands';
export const TRACK_LOSS_PARTS: TrackLossPart[] = ['face', 'eyes', 'body', 'hands'];
export const TRACK_LOSS_MODES: TrackLossMode[] = ['hold', 'rest', 'life'];

export interface TrackLossSettings {
  /** What each part does when the camera loses it (face = head + expressions + mouth). */
  modes: Record<TrackLossPart, TrackLossMode>;
  /** Seconds to ease into the hold / rest pose (0–3). */
  lossS: number;
  /** Seconds to blend back to live tracking when it is found again (0–1.5). */
  recoverS: number;
  /** Milliseconds a part must be missing before anything moves (0–1000): a dropped frame never moves anything. */
  graceMs: number;
  /** Re-acquire outlier rejection: frames always discarded after a loss (0–5); acceptance also needs two
   *  consecutive frames that agree with each other. */
  rejectFrames: number;
}

export const TRACK_LOSS_DEFAULTS: TrackLossSettings = {
  modes: { face: 'hold', eyes: 'hold', body: 'hold', hands: 'hold' },
  lossS: 0.5,
  recoverS: 0.3,
  graceMs: 150,
  rejectFrames: 1,
};

const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const mode = (v: unknown, d: TrackLossMode): TrackLossMode => (TRACK_LOSS_MODES as string[]).includes(v as string) ? v as TrackLossMode : d;

/** Any junk → a complete, clamped settings object (missing = defaults). */
export function sanitizeTrackLoss(v: unknown): TrackLossSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const m = (o.modes && typeof o.modes === 'object' ? o.modes : {}) as Record<string, unknown>;
  const D = TRACK_LOSS_DEFAULTS;
  return {
    modes: { face: mode(m.face, D.modes.face), eyes: mode(m.eyes, D.modes.eyes), body: mode(m.body, D.modes.body), hands: mode(m.hands, D.modes.hands) },
    lossS: num(o.lossS, 0, 3, D.lossS),
    recoverS: num(o.recoverS, 0, 1.5, D.recoverS),
    graceMs: num(o.graceMs, 0, 1000, D.graceMs),
    rejectFrames: Math.round(num(o.rejectFrames, 0, 5, D.rejectFrames)),
  };
}

/** Body / hands have no voice life: it means rest there. */
export function effectiveMode(s: TrackLossSettings, part: TrackLossPart): TrackLossMode {
  const m = s.modes[part];
  return m === 'life' && (part === 'body' || part === 'hands') ? 'rest' : m;
}

export const TRACK_LOSS_LABEL: Record<TrackLossMode, string> = { hold: 'Hold last pose', rest: 'Return to rest pose', life: 'Voice life' };
