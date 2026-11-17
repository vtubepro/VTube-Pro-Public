// Food & drink event detection (pure logic — no DOM / three.js, tested in tools/test_snacks.ts and
// scored in tools/eval_snacks.ts).
//
// Inputs, per tracking result, all in IMAGE space with x scaled by the aspect ratio (units = frame
// heights, so distances are isotropic):
//   face   mouth centre, face width, raw jaw-open channel, lip opening, head tilt back
//   hands  per AVATAR side: 21 hand landmarks, or a few pose points (wrist / knuckles) when the hand
//          model lost the hand (a cup in the fist hides the fingers — common!)
//   dets   object-detector boxes (COCO classes, EfficientDet-Lite0) — only on the steps where the
//          throttled detector delivered a new result (null otherwise)
//   voice  voice activity (VAD probability and / or mic level), when the audio pipeline has one
//
// v2 (after live false triggers: chewing fired on beard-jaw noise and during speech, glasses lenses were
// boxed as 'cell phone', beard / mouth as 'donut'): every event is a per-hand STATE MACHINE that needs
// several cues to agree.
//
//   OBJECT TRACKER  detector boxes → tracks (IoU / centre match, or "the same hand is still carrying it"),
//                   class votes, aspect + colour, which hand holds it, where it sits relative to that hand
//                   (so the object follows the hand between the 4 Hz looks), and whether it is a STILL box
//                   (a bottle on the shelf, the mic on its arm — never counts unless a hand really lifts it).
//                   Boxes up at the eyes with no hand on them (glasses, headphones) and boxes on the mouth
//                   with no hand (a beard called 'donut') are dropped.
//   DRINK (per hand)  idle → candidate (drink box in the hand) → holding (≥ N looks, mean score) → raised
//                   (object / hand near the mouth) → sip (at the lips for ≥ sipMin, jaw closed or face
//                   hidden behind the cup, NOT speaking) → lowered → holding … → put down / lost → cooldown.
//                   Look-alike boxes (a can called 'banana', a slim bottle 'cell phone') only become a drink
//                   through the whole drinking motion: carried up from below to closed lips, then the head
//                   tips back or the cup hides the face (a vape / phone / hand at the chin never does both).
//                   Posture-only (no box at all) is OFF unless enabled, and then needs a long tilt-back hold.
//   FOOD (per hand)  food box tracked in the hand (≥ 2 looks) → hand to mouth (≥ 0.12 s, fingertips at the
//                   lips, not up at the glasses / out at the ear) with the mouth OPENING → bite. Without a
//                   food box: the same visit + ≥ chewConfirm s of chewing right after, while not speaking.
//   CHEWING         regular 1–2.5 Hz jaw rhythm, amplitude well above the jaw's frame-to-frame noise, the
//                   jaw closing at every cycle, and no voice (mic / VAD) or camera speech in the window.
//   SPEAKING        VAD (voice front-end) > mic level > camera (lips open + fast irregular movement).
//   MOUTH VISIBLE   (face.vis, mouthVisibility.ts, when the tracker reports it) a cup over the lips reads "covered", and
//                   MediaPipe's jaw behind it is a guess: covered-mouth samples never count as chewing; lips covered at
//                   the rim count like a closed jaw for a sip; and a mouth that was ALREADY covered before the hand came
//                   (a boom mic / pop filter in front of the face, the detector calling its foam a 'donut' or a 'cup')
//                   is a fixture being touched, never a drink being raised or a bite — unless the drink was confirmed
//                   in the hand AWAY from the mouth first (a mug picked up from the desk and raised behind the mic): that
//                   one sips like before mouth visibility (jaw closed, not speaking). In strict mode, covered lips never
//                   turn a box the detector calls a phone / remote into a drink (it needs the head tilt / hidden face).
// Sensitivity presets (strict / normal / loose) scale every threshold; strict is the default.

export type Side = 'left' | 'right';
export type SnackPropKind = 'coffee' | 'mug' | 'can' | 'bottle' | 'glass';
export type MessKind = 'crumbs' | 'spaghetti' | 'cheeto' | 'chocolate' | 'sugar';
export type Sensitivity = 'strict' | 'normal' | 'loose';
/** Per-type toggles (drink props + food). */
export type SnackType = SnackPropKind | 'food';
export const SNACK_TYPES: SnackType[] = ['mug', 'coffee', 'can', 'bottle', 'glass', 'food'];

export interface Pt { x: number; y: number }
/** Detector box (frame-height units, x scaled by aspect). rgb = mean colour inside the box (0..255), optional. */
export interface SnackDet { cls: string; score: number; x0: number; y0: number; x1: number; y1: number; rgb?: [number, number, number] }
export interface SnackFaceIn {
  mouth: Pt;
  /** Face width (cheek to cheek), frame-height units. */
  size: number;
  /** Jaw-open channel 0..1 (raw camera). */
  jaw: number;
  /** Head tilt back (radians, + = chin up). */
  tiltBack: number;
  /** Lip opening 0..1 (optional). */
  lips?: number;
  /** Mouth visibility 0..1 (optional; mouthVisibility.ts: a cup / hand / mic over the lips → ~0). */
  vis?: number;
}
export interface SnackHandIn { side: Side; pts: Pt[]; /** true = coarse pose points (no fingers) */ coarse?: boolean }
/** Voice activity from the audio pipeline (pluggable: VAD probability and / or mic level, both 0..1). */
export interface SnackVoice { vad?: number; level?: number }
export interface SnackInput {
  t: number;
  face: SnackFaceIn | null;
  hands: SnackHandIn[];
  dets: SnackDet[] | null;
  /** 0..1 mic level (legacy; `voice` wins when present), 0 when unknown. */
  speaking?: number;
  voice?: SnackVoice | null;
}

export const DRINK_CLASSES = new Set(['cup', 'bottle', 'wine glass', 'vase']);
/**
 * Boxes that may really be a drink. Real capture (Elgato Facecam, a yellow soda can at the mouth):
 * EfficientDet-Lite0 called it 'banana' 0.4–0.7 in 9 looks out of 9, and 'cup' / 'bottle' in none.
 * They only count through the whole drinking motion (see DRINK above).
 */
export const DRINK_LOOKALIKES = new Set(['banana', 'cell phone', 'remote', 'toothbrush', 'bowl']);
/** Look-alikes that are usually exactly what the detector says: a phone / a remote held at closed lips (thinking, a voice
 *  note, hiding a yawn) covers them just like a can's rim does. */
export const PHONE_LIKE = new Set(['cell phone', 'remote']);
export const FOOD_CLASSES = new Set(['banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'fork', 'knife', 'spoon', 'bowl']);
/** Every class the snack logic uses (the worker reports these as `dets`). */
export const DETECT_CLASSES = [...new Set([...DRINK_CLASSES, ...DRINK_LOOKALIKES, ...FOOD_CLASSES])];

const lum = (c: [number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const sat = (c: [number, number, number]) => { const mx = Math.max(...c), mn = Math.min(...c); return mx < 1 ? 0 : (mx - mn) / mx; };

/** Drink box → prop. aspect = box height / width; rgb (optional) breaks ties (paper cup vs mug, can vs bottle). */
export function propFor(cls: string, aspect: number, rgb?: [number, number, number] | null): SnackPropKind | null {
  if (cls === 'cup' || cls === 'vase') {
    // tall = to-go coffee cup, squat (the handle widens the box) = mug; in between: a pale / kraft
    // unsaturated cup is paper, anything else a mug
    // a tall, strongly coloured 'cup' is usually a soda can (paper coffee cups are white / kraft)
    if (aspect >= 1.45 && rgb && sat(rgb) > 0.55) return 'can';
    if (aspect >= 1.35) return 'coffee';
    if (aspect < 1.05) return 'mug';
    return rgb && lum(rgb) > 150 && sat(rgb) < 0.35 ? 'coffee' : 'mug';
  }
  if (cls === 'bottle') {
    if (aspect >= 2.4) return 'bottle';
    if (aspect < 1.9) return 'can';
    return rgb && sat(rgb) > 0.45 ? 'can' : 'bottle';
  }
  if (cls === 'wine glass') return 'glass';
  if (DRINK_LOOKALIKES.has(cls)) return aspect >= 2.4 ? 'bottle' : 'can';
  return null;
}

/** Food class → mess look ('auto' style). */
export function messFor(cls: string | null): MessKind {
  switch (cls) {
    case 'bowl': case 'fork': case 'spoon': case 'pizza': case 'hot dog': return 'spaghetti';
    case 'cake': return 'chocolate';
    case 'donut': return 'sugar';
    case 'carrot': case 'orange': return 'cheeto';
    default: return 'crumbs';
  }
}

/** Thresholds per sensitivity (seconds, face widths, detector scores). */
export interface SnackTuning {
  /** looks of a drink box in the hand before the prop shows, within holdWin s, with this mean score */
  holdLooks: number; holdWin: number; holdMean: number; minScore: number;
  /** a single look this confident is enough (Infinity = never) */
  holdSingle: number;
  /** look-alike drink: min score, min box width (face widths), head tilt rise OR face hidden (s) needed */
  lookScore: number; lookMinW: number; lookRise: number; lookHide: number;
  /** look-alike held to closed lips this long counts even without tilt / hiding (Infinity = never) */
  lookPlain: number;
  /** look-alike at closed lips that COVERS them (mouth visibility) this long counts like a tilt / hidden face (s) */
  lookCover: number;
  /** …and only for a box the detector did NOT call a phone / remote (PHONE_LIKE): those need the full drinking motion
   *  (lookRise / lookHide). Strict: a phone pressed to closed lips must never become a can. */
  lookCoverCue: boolean;
  /** sip: object / hand within sipNear face widths of the lips for sipMin s */
  sipNear: number; sipMin: number;
  /** jaw 'closed' (lips on a rim) below this */
  closedJaw: number;
  /** food box: looks in the hand + min score */
  foodLooks: number; foodScore: number;
  /** bite: jaw must open at least this much during the visit; visit length window */
  biteJaw: number; visitMin: number; visitMax: number;
  /** chewing seconds that confirm a bite with no food box */
  chewConfirm: number;
  /** max fraction of a hand-to-mouth visit spent speaking */
  visitVoiced: number;
  /** posture-only drink (when enabled): tilt rise + hold time */
  poseRise: number; poseMin: number;
  /** release: s without seeing the held object (+ at the mouth) */
  release: number; releaseAtMouth: number;
  /** the object must have moved this far (face widths) before it counts as carried */
  liftMin: number;
}
export const SNACK_PRESETS: Record<Sensitivity, SnackTuning> = {
  strict: {
    holdLooks: 2, holdWin: 2, holdMean: 0.42, minScore: 0.33, holdSingle: 0.62,
    lookScore: 0.4, lookMinW: 0.3, lookRise: 0.12, lookHide: 0.25, lookPlain: Infinity, lookCover: 0.6, lookCoverCue: true,
    sipNear: 0.55, sipMin: 0.25, closedJaw: 0.22,
    foodLooks: 2, foodScore: 0.35, biteJaw: 0.15, visitMin: 0.12, visitMax: 4, chewConfirm: 1.2, visitVoiced: 0.2,
    poseRise: 0.25, poseMin: 1.0, release: 2.5, releaseAtMouth: 5, liftMin: 0.12,
  },
  normal: {
    holdLooks: 2, holdWin: 2, holdMean: 0.36, minScore: 0.3, holdSingle: 0.7,
    lookScore: 0.35, lookMinW: 0.25, lookRise: 0.1, lookHide: 0.2, lookPlain: 0.8, lookCover: 0.45, lookCoverCue: false,
    sipNear: 0.6, sipMin: 0.2, closedJaw: 0.24,
    foodLooks: 2, foodScore: 0.3, biteJaw: 0.1, visitMin: 0.12, visitMax: 6, chewConfirm: 1.1, visitVoiced: 0.35,
    poseRise: 0.2, poseMin: 0.8, release: 2.5, releaseAtMouth: 5, liftMin: 0.1,
  },
  loose: {
    holdLooks: 2, holdWin: 2.5, holdMean: 0.32, minScore: 0.28, holdSingle: 0.5,
    lookScore: 0.33, lookMinW: 0.2, lookRise: 0.08, lookHide: 0.15, lookPlain: 0.5, lookCover: 0.3, lookCoverCue: false,
    sipNear: 0.7, sipMin: 0.15, closedJaw: 0.26,
    foodLooks: 1, foodScore: 0.28, biteJaw: 0.05, visitMin: 0.1, visitMax: 6, chewConfirm: 0.8, visitVoiced: 0.5,
    poseRise: 0.15, poseMin: 0.6, release: 3, releaseAtMouth: 6, liftMin: 0,
  },
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const quant = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };

interface Box { x0: number; y0: number; x1: number; y1: number }
function handBox(pts: Pt[], pad: number): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const s = Math.max(x1 - x0, y1 - y0, 0.02) * pad;
  return { x0: x0 - s, y0: y0 - s, x1: x1 + s, y1: y1 + s };
}
const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
function inter(a: Box, b: Box) { return area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }); }
const iou = (a: Box, b: Box) => { const i = inter(a, b); return i / Math.max(1e-9, area(a) + area(b) - i); };
const inside = (p: Pt, b: Box, pad = 0) => { const px = (b.x1 - b.x0) * pad, py = (b.y1 - b.y0) * pad; return p.x >= b.x0 - px && p.x <= b.x1 + px && p.y >= b.y0 - py && p.y <= b.y1 + py; };
const bc = (b: Box): Pt => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
function centre(pts: Pt[]): Pt { let x = 0, y = 0; for (const p of pts) { x += p.x; y += p.y; } return { x: x / pts.length, y: y / pts.length }; }
/** Fingertips (thumb, index, middle) when the full hand is known — what reaches the mouth first. */
const tips = (h: SnackHandIn) => (h.pts.length >= 21 ? centre([h.pts[4], h.pts[8], h.pts[12]]) : centre(h.pts));

// ---------------------------------------------------------------- object tracker

interface Track {
  id: number;
  box: Box;
  t0: number; t: number; hits: number;
  /** score-weighted class votes */
  votes: Map<string, number>;
  scores: number[];
  asp: number[];
  rgb: [number, number, number] | null;
  /** looks where a hand was on it (side, score) */
  inHand: { t: number; s: number; side: Side; cls: string; /** box centre / top vs the lips, face widths */ dy: number; dm: number; asp: number }[];
  /** object centre − hand centre at the last in-hand look (the object follows the hand between looks) */
  off: Pt | null; offSide: Side | null; offT: number;
  c0: Pt;
  /** max centre displacement from where it was first seen (face widths) */
  moved: number;
  /** looks with no hand anywhere near it */
  freeHits: number;
  /** consecutive free looks (put-down detection) */
  freeRun: number;
  /** seen still + hand-free often enough: shelf bottle / mic / lamp */
  still: boolean;
  /** this track was drunk from: never food */
  drink: boolean;
}
const topCls = (tr: Track, filter?: (c: string) => boolean) => {
  let b = '', bv = -1;
  for (const [c, v] of tr.votes) if ((!filter || filter(c)) && v > bv) { bv = v; b = c; }
  return b;
};

type DState = 'idle' | 'candidate' | 'holding' | 'raised' | 'sip' | 'lowered' | 'cooldown';
interface DrinkHand {
  st: DState; since: number;
  track: number | null;
  kind: SnackPropKind;
  lastSeen: number; handSeen: number;
  /** time the object / hand got within sipNear (−1 = not there) */
  nearT: number; awayT: number;
  /** head tilt when the hand arrived near the mouth (min since) */
  arriveTilt: number | null; mouthT: number;
  /** face hidden (behind the cup) while at the mouth, seconds */
  hidden: number;
  /** lips covered by the object at the mouth (mouth visibility), seconds */
  cover: number;
  /** a look-alike carried up from below the mouth (drink motion) */
  poseT: number; postural: boolean;
  sip: number; sipEv: number;
  why: string;
  drinkEnd: number;
  /** the held object was seen in this hand AWAY from the mouth when the hold started (picked up from the desk): it is a
   *  drink being carried, not the mic in front of the face */
  fromAway: boolean;
}
const newDrink = (): DrinkHand => ({ st: 'idle', since: 0, track: null, kind: 'mug', lastSeen: -99, handSeen: -99, nearT: -1, awayT: -1, arriveTilt: null, mouthT: -99, hidden: 0, cover: 0, poseT: -1, postural: false, sip: 0, sipEv: 0, why: '', drinkEnd: -99, fromAway: false });
interface Visit { at: boolean; since: number; nearT: number; jawMax: number; voiced: number; n: number; food: string | null }
const newVisit = (): Visit => ({ at: false, since: 0, nearT: -1, jawMax: 0, voiced: 0, n: 0, food: null });

export interface SnackHandDebug { state: DState; obj: string | null; score: number; dm: number; cues: string }
export interface SnackDebug {
  left: SnackHandDebug; right: SnackHandDebug;
  speaking: boolean; voice: 'vad' | 'mic' | 'camera' | 'none';
  chew: string;
  tracks: number;
  /** last events with the reason they fired (newest last) */
  events: { t: number; kind: string; side: Side | ''; why: string }[];
}
export interface SnackState {
  hold: Record<Side, { kind: SnackPropKind; since: number } | null>;
  /** 0..1 raw sip evidence per side (0 when not drinking). */
  sip: Record<Side, number>;
  /** Chewing rhythm detected now. */
  chewing: boolean;
  /** Last food class seen in a hand (null = none recently). */
  food: string | null;
  /** Why (live readout in the panel, diagnostics). */
  dbg?: SnackDebug;
}

export class SnackDetector {
  private tracks: Track[] = [];
  private nextTrack = 1;
  private d: Record<Side, DrinkHand> = { left: newDrink(), right: newDrink() };
  private visit: Record<Side, Visit> = { left: newVisit(), right: newVisit() };
  private jaw: { t: number; v: number; l: number; sp: boolean; hid: boolean }[] = [];
  /** since when the mouth has been covered (face.vis < 0.4); −1 = visible / not reported */
  private mouthHidSince = -1;
  /** the mouth was already covered well before `t0` (the hand / object arrived after it): a fixture in front of the face */
  private coveredBefore(t0: number) { return this.mouthHidSince >= 0 && t0 >= 0 && this.mouthHidSince < t0 - 1.0; }
  private foodT = -99;
  private foodCls: string | null = null;
  private foodTrack = -1;
  private pendingBite: { t: number; side: Side; chew: number; why: string } | null = null;
  private lastBite = -99;
  private chewSince = -1;
  private chewBiteT = -99;
  private chewingNow = false;
  private chewWhy = '';
  private chewT = -99;
  private lastT = -1;
  private faceSince = -99;
  private voiceT = -99; private voiceSrc: SnackDebug['voice'] = 'none';
  private micHeardT = -99;
  private micHist: { t: number; on: boolean }[] = [];
  private speakT = -99;
  private camTalkNow = false;
  private lastFace: { f: SnackFaceIn; t: number } | null = null;
  private lastKind: SnackPropKind = 'mug';
  private bites: Side[] = [];
  private events: SnackDebug['events'] = [];
  /** hand centre height below the lips (face widths) over the last 3 s, per side */
  private handY: Record<Side, { t: number; dy: number }[]> = { left: [], right: [] };
  /** Optional trace (offline replay: tools/replay_snacks.ts --verbose). */
  debug: ((t: number, msg: string) => void) | null = null;
  /** Current thresholds (see SNACK_PRESETS). */
  cfg: SnackTuning = { ...SNACK_PRESETS.strict };
  sensitivity: Sensitivity = 'strict';
  /** Posture-only drink guess (no box at all). Off by default. */
  posture = false;
  /** Enabled types (a disabled drink kind is never shown, disabled food never bites). */
  types: Record<SnackType, boolean> = { mug: true, coffee: true, can: true, bottle: true, glass: true, food: true };
  /** Chewing band (Hz). */
  chewHz: [number, number] = [1, 2.5];

  setSensitivity(s: Sensitivity) { this.sensitivity = s; this.cfg = { ...SNACK_PRESETS[s] }; }

  reset() {
    this.tracks = []; this.d = { left: newDrink(), right: newDrink() }; this.visit = { left: newVisit(), right: newVisit() };
    this.jaw = []; this.mouthHidSince = -1; this.foodT = -99; this.foodCls = null; this.pendingBite = null; this.bites = [];
    this.chewSince = -1; this.chewingNow = false; this.lastFace = null; this.lastT = -1; this.events = [];
  }

  /** Bites since the last call (each entry = the side that fed). */
  takeBites(): Side[] { const b = this.bites; this.bites = []; return b; }

  private log(t: number, kind: string, side: Side | '', why: string) {
    this.events.push({ t, kind, side, why });
    if (this.events.length > 12) this.events.shift();
    this.debug?.(t, `EVENT ${kind} ${side} — ${why}`);
  }

  /** Jaw (mostly) closed over the last ~0.4 s — lips on a rim, not a bite / yawn / talking. */
  private jawClosed(t: number): boolean {
    const J = this.jaw.filter((p) => t - p.t < 0.4);
    if (!J.length) return true;
    return median(J.map((p) => p.v)) < this.cfg.closedJaw;
  }

  // ---------------------------------------------------------------- voice

  private voiceStep(inp: SnackInput, F: SnackFaceIn | null): boolean {
    const t = inp.t;
    let sp = false;
    const v = inp.voice;
    if (v && v.vad !== undefined && isFinite(v.vad)) { this.voiceT = t; this.voiceSrc = 'vad'; sp = v.vad > 0.5; }
    else {
      // a bare mic LEVEL also hears crunching / clinking: only SUSTAINED sound (≥ 45 % of the last second)
      // counts as speech — a crunch is a short spike
      const lv = v?.level ?? inp.speaking ?? 0;
      if (lv > 0.03) this.micHeardT = t;
      this.micHist.push({ t, on: lv > 0.25 });
      while (this.micHist.length && t - this.micHist[0].t > 1) this.micHist.shift();
      if (t - this.micHeardT < 60) { this.voiceSrc = 'mic'; sp = this.micHist.filter((x) => x.on).length >= Math.max(3, this.micHist.length * 0.45); }
      else this.voiceSrc = 'none';
    }
    // camera speech: lips open most of the last 1.5 s AND moving fast and irregularly (syllables), which
    // chewing (a slow regular 1–2 Hz open-close) and resting never do
    this.camTalkNow = false;
    if (F) {
      const W = this.jaw.filter((p) => t - p.t < 1.5);
      if (W.length >= 12 && W[W.length - 1].t - W[0].t > 1) {
        const L = W.map((p) => p.l);
        const open = L.filter((x) => x > 0.25).length / L.length;
        let ext = 0, dir = 0;
        for (let i = 1; i < L.length; i++) { const dd = L[i] - L[i - 1]; if (Math.abs(dd) < 0.06) continue; const s = Math.sign(dd); if (dir && s !== dir) ext++; dir = s; }
        const rate = ext / (W[W.length - 1].t - W[0].t);
        this.camTalkNow = open > 0.55 && rate > 3.2 && quant(L, 0.9) - quant(L, 0.1) > 0.2;
      }
      if (this.voiceSrc === 'none' && this.camTalkNow) this.voiceSrc = 'camera';
    }
    if (sp || this.camTalkNow) this.speakT = t;
    return sp || this.camTalkNow;
  }
  /** Speaking now (with a short hang so gaps between words don't count as silence). */
  private speaking(t: number) { return t - this.speakT < 0.4; }

  // ---------------------------------------------------------------- tracker

  private trackStep(t: number, dets: SnackDet[], Fm: SnackFaceIn | null, hands: Map<Side, SnackHandIn>) {
    const size = Fm?.size ?? 0.25;
    this.tracks = this.tracks.filter((tr) => t - tr.t < (tr.still ? 30 : 3));
    const seen = new Set<number>();
    for (const d of dets) {
      const isDrink = DRINK_CLASSES.has(d.cls), isLook = DRINK_LOOKALIKES.has(d.cls), isFood = FOOD_CLASSES.has(d.cls);
      if (!isDrink && !isLook && !isFood) continue;
      if (d.score < 0.15) continue;
      const box: Box = { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
      const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
      // things held to the face are smaller than the face; a box swallowing the face / torso is the
      // detector mistaking the performer (or a toon avatar on screen) for a "cake"
      if (Fm && (bw > size * 1.35 || bh > size * 1.8)) continue;
      if (Fm && inside(Fm.mouth, box, -0.05) && inside({ x: Fm.mouth.x, y: Fm.mouth.y - size * 0.45 }, box, -0.05)) continue; // covers mouth AND eyes
      // which hand is on it
      let side: Side | null = null, bestOv = 0;
      for (const [s, hd] of hands) {
        const hb = handBox(hd.pts, hd.coarse ? 0.9 : 0.25);
        const ov = inter(hb, box) / Math.max(1e-9, Math.min(area(hb), area(box)));
        // coarse pose points get a huge box: a finger-tracked hand on the box wins; ties → the hand nearer
        // the mouth (that's the one drinking)
        const dmh = Fm ? Math.min(3, dist(centre(hd.pts), Fm.mouth) / size) : 0;
        const sc = Math.max(ov, inside(centre(hd.pts), box, 0.2) ? 0.6 : 0) * (hd.coarse ? 0.7 : 1) * (1 - 0.05 * dmh);
        // (pose-only points are often the pose model's guess: a finger-tracked hand on the box wins outright)
        const w = sc + (hd.coarse || ov < 0.2 ? 0 : 1);
        if (w > bestOv) { bestOv = w; side = s; }
      }
      if (bestOv < 0.2) side = null;
      // food is pinched at the fingertips, often beside the palm: any touch of the padded hand counts
      if (!side && isFood && !isDrink) {
        let bd = Infinity;
        for (const [s, hd] of hands) { if (inter(handBox(hd.pts, hd.coarse ? 1.2 : 0.5), box) > 0) { const dd = dist(tips(hd), bc(box)); if (dd < bd) { bd = dd; side = s; } } }
      }
      const c = bc(box);
      // face features with no hand on them: glasses lenses / headphones ('cell phone', 'remote', 'wine
      // glass' up at the eyes), a beard / open mouth called 'donut' / 'cake' / 'bowl' right on the lips
      if (Fm && !side) {
        const dx = (c.x - Fm.mouth.x) / size, dy = (c.y - Fm.mouth.y) / size;
        if (dy < -0.4 && Math.abs(dx) < 0.95) continue;
        if (Math.hypot(dx, dy) < 0.6 && !this.tracks.some((tr) => tr.offSide && t - tr.offT < 1.5 && iou(tr.box, box) > 0.1)) continue;
      }
      // match a track: overlap / near, or the same hand still carrying it (fast raise between looks)
      let m: Track | null = null, mv = 0;
      for (const tr of this.tracks) {
        if (seen.has(tr.id)) continue;
        const ov = iou(tr.box, box);
        const cd = dist(bc(tr.box), c) / Math.max(0.02, Math.max(bw, bh, tr.box.x1 - tr.box.x0, tr.box.y1 - tr.box.y0));
        let v = ov > 0.15 ? 1 + ov : cd < 0.7 ? 1 - cd : 0;
        if (side && tr.offSide === side && t - tr.offT < 1.5) v = Math.max(v, 1.2);
        if (v > mv) { mv = v; m = tr; }
      }
      if (!m) {
        if (this.tracks.length >= 40) continue;
        m = { id: this.nextTrack++, box, t0: t, t, hits: 0, votes: new Map(), scores: [], asp: [], rgb: null, inHand: [], off: null, offSide: null, offT: -99, c0: c, moved: 0, freeHits: 0, freeRun: 0, still: false, drink: false };
        this.tracks.push(m);
      }
      seen.add(m.id);
      // the box a hand is already drinking from stays with that hand while it touches it
      for (const x of ['left', 'right'] as Side[]) {
        const D = this.d[x], hx = hands.get(x);
        if (D.track === m.id && D.st !== 'idle' && D.st !== 'candidate' && D.st !== 'cooldown' && hx && inter(handBox(hx.pts, 0.9), box) > 0) side = x;
      }
      m.box = box; m.t = t; m.hits++;
      m.votes.set(d.cls, (m.votes.get(d.cls) ?? 0) + d.score);
      m.scores.push(d.score); if (m.scores.length > 10) m.scores.shift();
      if (d.rgb) m.rgb = m.rgb ? [0, 1, 2].map((i) => m!.rgb![i] * 0.6 + d.rgb![i] * 0.4) as [number, number, number] : d.rgb;
      m.moved = Math.max(m.moved, dist(c, m.c0) / size);
      // near the lips the box merges with hand / face: only far-from-mouth aspects vote on the prop shape
      if (!Fm || dist(c, Fm.mouth) / size > 0.8) { m.asp.push(bh / Math.max(1e-6, bw)); if (m.asp.length > 9) m.asp.shift(); }
      if (side) {
        const hd = hands.get(side)!;
        const hc = centre(hd.pts);
        const dy = Fm ? (c.y - Fm.mouth.y) / size : 9, dmo = Fm ? Math.min(dist({ x: c.x, y: box.y0 + bh * 0.15 }, Fm.mouth), dist(c, Fm.mouth)) / size : 9;
        m.inHand.push({ t, s: d.score, side, cls: d.cls, dy, dm: inside(Fm?.mouth ?? { x: -9, y: -9 }, box, 0.05) ? Math.min(dmo, 0.2) : dmo, asp: bh / Math.max(1e-6, bw) });
        if (m.inHand.length > 16) m.inHand.shift();
        m.off = { x: c.x - hc.x, y: c.y - hc.y }; m.offSide = side; m.offT = t;
        m.freeRun = 0;
      } else {
        // is any hand near at all? (a hand next to the mic is not "on" it, but not proof it's still either)
        let near = false;
        for (const hd of hands.values()) if (inter(handBox(hd.pts, hd.coarse ? 1.4 : 0.9), box) > 0) near = true;
        if (!near) { m.freeHits++; m.freeRun++; }
        if (m.freeHits >= 4 && m.moved < 0.35) m.still = true;
      }
    }
    // a track not seen this look that its hand carried: the hand keeps it (occluded at the mouth)
  }

  /** The drink / look-alike / food track this hand holds right now (recent in-hand looks). */
  private handTrack(s: Side, t: number, want: 'drink' | 'food', win: number): Track | null {
    let best: Track | null = null, bv = 0;
    const other = this.d[s === 'left' ? 'right' : 'left'];
    for (const tr of this.tracks) {
      if (other.track === tr.id && other.st !== 'idle' && other.st !== 'candidate' && other.st !== 'cooldown') continue;
      if (want === 'food' && tr.drink) continue;
      const ih = tr.inHand.filter((e) => e.side === s && t - e.t < win && (want === 'food' ? FOOD_CLASSES.has(e.cls) : DRINK_CLASSES.has(e.cls) || DRINK_LOOKALIKES.has(e.cls)));
      if (!ih.length) continue;
      const v = ih.reduce((a, e) => a + e.s, 0);
      if (v > bv) { bv = v; best = tr; }
    }
    return best;
  }

  // ---------------------------------------------------------------- step

  step(inp: SnackInput): SnackState {
    const t = inp.t, F = inp.face, C = this.cfg;
    const dt = this.lastT < 0 ? 0 : Math.min(0.25, Math.max(0, t - this.lastT));
    this.lastT = t;
    const faceSteady = !!F && !!this.lastFace && t - this.lastFace.t < 0.2 && t - this.faceSince > 0.3;
    if (F && (!this.lastFace || t - this.lastFace.t > 0.2)) this.faceSince = t;
    if (F) this.lastFace = { f: F, t };
    const Fm = F ?? (this.lastFace && t - this.lastFace.t < 2 ? this.lastFace.f : null);
    const hands = new Map<Side, SnackHandIn>();
    for (const hd of inp.hands) if (hd.pts.length) hands.set(hd.side, hd);
    for (const s of ['left', 'right'] as Side[]) {
      const hd = hands.get(s);
      if (hd) this.d[s].handSeen = t;
      const Y = this.handY[s];
      if (hd && Fm) Y.push({ t, dy: (centre(hd.pts).y - Fm.mouth.y) / Fm.size });
      while (Y.length && t - Y[0].t > 3) Y.shift();
    }

    if (F) {
      const vis = F.vis;
      if (vis !== undefined) { if (vis < 0.4) { if (this.mouthHidSince < 0) this.mouthHidSince = t; } else if (vis > 0.6) this.mouthHidSince = -1; }
      else this.mouthHidSince = -1;
      this.jaw.push({ t, v: F.jaw, l: F.lips ?? F.jaw, sp: false, hid: vis !== undefined && vis < 0.5 });
      while (this.jaw.length && t - this.jaw[0].t > 3) this.jaw.shift();
    }
    const spNow = this.voiceStep(inp, F);
    if (F && this.jaw.length) this.jaw[this.jaw.length - 1].sp = spNow;
    const talking = this.speaking(t);
    const closed = this.jawClosed(t);
    // lips covered (by the rim at the mouth, or anything else): MediaPipe's jaw there is a guess
    const lipsCovered = !!F && F.vis !== undefined && F.vis < 0.4;

    if (inp.dets) this.trackStep(t, inp.dets, Fm, hands);

    // ---- food in a hand (tracked, ≥ foodLooks looks within 4 s, not still) ----
    for (const s of ['left', 'right'] as Side[]) {
      const tr = this.handTrack(s, t, 'food', 4);
      if (!tr || tr.still) continue;
      const ih = tr.inHand.filter((e) => e.side === s && t - e.t < 4 && FOOD_CLASSES.has(e.cls) && e.s >= C.foodScore);
      if (!ih.length) continue;
      const mean = ih.reduce((a, e) => a + e.s, 0) / ih.length;
      // a look-alike this hand is drinking from is not food
      if (this.d[s].track === tr.id && this.d[s].st !== 'idle' && this.d[s].st !== 'candidate') continue;
      if (ih.length >= C.foodLooks && mean >= C.foodScore && ih[ih.length - 1].t === t) {
        const cls = topCls(tr, (c) => FOOD_CLASSES.has(c) && c !== 'knife') || 'food';
        if (this.foodT < t - 1) this.debug?.(t, `food in ${s} hand: ${cls} (${ih.length} looks, mean ${mean.toFixed(2)})`);
        this.foodT = t; this.foodCls = cls; this.foodTrack = tr.id;
        if (this.visit[s].at) this.visit[s].food = cls;
      }
    }

    const out: SnackState = { hold: { left: null, right: null }, sip: { left: 0, right: 0 }, chewing: false, food: t - this.foodT < 20 ? this.foodCls : null };
    const hdbg: Record<Side, SnackHandDebug> = { left: { state: 'idle', obj: null, score: 0, dm: Infinity, cues: '' }, right: { state: 'idle', obj: null, score: 0, dm: Infinity, cues: '' } };

    // ---- drinks per hand ----
    for (const s of ['left', 'right'] as Side[]) {
      const H = this.d[s];
      const hd = hands.get(s);
      const tr = this.handTrack(s, t, 'drink', 2.5);
      const held = H.track !== null ? this.tracks.find((x) => x.id === H.track) ?? null : null;
      const obj = held ?? tr;
      // where the object is now: it follows the hand between looks
      let op: Pt | null = null, oh = 0;
      if (obj && hd && obj.offSide === s && obj.off && t - obj.offT < 2) { const hc = centre(hd.pts); op = { x: hc.x + obj.off.x, y: hc.y + obj.off.y }; oh = obj.box.y1 - obj.box.y0; }
      else if (obj && t - obj.t < 0.5) { op = bc(obj.box); oh = obj.box.y1 - obj.box.y0; }
      let dm = Infinity;
      if (Fm) {
        if (hd) dm = dist(centre(hd.pts), Fm.mouth) / Fm.size;
        if (op) dm = Math.min(dm, dist({ x: op.x, y: op.y - oh * 0.35 }, Fm.mouth) / Fm.size);
        if (obj && t - obj.t < 0.3 && inside(Fm.mouth, obj.box, 0.1)) dm = Math.min(dm, 0.2);
      }
      // hand hidden by the face / cup while it was at the lips a moment ago: still there
      if (!hd && H.nearT >= 0 && t - H.mouthT < 1) dm = Math.min(dm, 0.3);
      const lastIn = obj?.inHand.filter((e) => e.side === s).at(-1);
      const objAtLips = !!lastIn && t - lastIn.t < 0.8 && lastIn.dm < 0.7;
      const handLow = !hd || !Fm || (centre(hd.pts).y - Fm.mouth.y) / Fm.size > -0.3;
      const faceHidden = !F && !!Fm && t - H.mouthT < 0.6 && handLow && (objAtLips || H.st === 'sip');
      if (dm < 1.0) {
        if (t - H.mouthT > 0.6 || H.arriveTilt === null) H.arriveTilt = F && faceSteady ? F.tiltBack : null;
        else if (F && faceSteady && H.arriveTilt !== null) H.arriveTilt = Math.min(H.arriveTilt, F.tiltBack);
        H.mouthT = t;
      } else if (t - H.mouthT > 0.6) H.arriveTilt = null;
      const rise = F && faceSteady && H.arriveTilt !== null ? F.tiltBack - H.arriveTilt : 0;
      if (faceHidden) H.hidden += dt; else if (F) H.hidden = Math.max(0, H.hidden - dt * 0.5);
      if (dm > 1.2) H.hidden = 0;
      const near = dm < C.sipNear;
      if (near) { if (H.nearT < 0) H.nearT = t; H.awayT = -1; }
      else if (dm > C.sipNear + 0.3) { if (H.awayT < 0) H.awayT = t; if (t - H.awayT > 0.25) H.nearT = -1; }
      const nearFor = H.nearT >= 0 ? t - H.nearT : 0;
      // object carried up from below the mouth (look-alike drink motion)
      const cues: string[] = [];
      // a covered mouth with the object right at it is lips on a rim (as good as a closed jaw) — unless it was covered
      // before the object arrived (a mic in front of the face)
      const fixture = this.coveredBefore(H.nearT >= 0 ? H.nearT : t);
      // …but a drink already HELD, confirmed in the hand away from the mouth (a mug picked up from the desk) and really
      // carried up (its box travelled ≥ 0.5 face widths), is not the mic: the mic only hides the lips. Judge its sip like
      // before mouth visibility (the jaw closed — MediaPipe's guess behind the mic — or the face hidden, and not speaking);
      // the covered lips say nothing about this cup. (Touching / adjusting the mic never gets here: its box is seen at the
      // covered mouth, so no hold starts, and a mic on its arm never travels that far.)
      const carried = fixture && H.fromAway && !!held && held.moved >= 0.5 && H.st !== 'idle' && H.st !== 'candidate' && H.st !== 'cooldown';
      const mouthOk = carried ? closed || faceHidden : (closed || faceHidden || (lipsCovered && dm < C.sipNear)) && !fixture;
      // the object covering the lips at the mouth (a can / bottle rim) — the drinking motion's visible half when the
      // face model keeps the face and the head barely tips
      if (lipsCovered && closed && dm < C.sipNear && !fixture) H.cover += dt; else if (F) H.cover = Math.max(0, H.cover - dt * 0.5);
      if (dm > 1.2) H.cover = 0;
      if (obj) cues.push(`${topCls(obj)} ${median(obj.scores).toFixed(2)}${obj.still ? ' still' : ''}`);
      if (isFinite(dm)) cues.push(`mouth ${dm.toFixed(2)}`);
      if (rise > 0.03) cues.push(`tilt +${rise.toFixed(2)}`);
      if (faceHidden) cues.push('face hidden');
      if (!closed && F) cues.push('jaw open');
      if (lipsCovered) cues.push(carried ? 'mouth covered before (mic?), drink carried in' : fixture ? 'mouth covered before (mic?)' : 'lips covered');
      if (talking) cues.push('speaking');

      const kindOf = (x: Track): SnackPropKind | null => {
        const cls = topCls(x, (c) => DRINK_CLASSES.has(c) || DRINK_LOOKALIKES.has(c));
        return propFor(cls, x.asp.length ? median(x.asp) : 1.3, x.rgb);
      };
      const enter = (st: DState, why: string) => { if (H.st !== st) { this.debug?.(t, `${s} ${H.st} → ${st}: ${why}`); H.st = st; H.since = t; H.why = why; } };
      const release = (why: string) => {
        if (H.st === 'sip') H.drinkEnd = t;
        if (H.st !== 'idle' && H.st !== 'candidate') this.log(t, 'put down', s, why);
        H.track = null; H.sip = 0; H.postural = false; H.poseT = -1; H.fromAway = false;
        enter('cooldown', why);
      };
      const startHold = (x: Track | null, k: SnackPropKind, why: string, postural = false) => {
        if (!this.types[k]) { H.why = `${k} disabled`; return false; }
        H.track = x?.id ?? null; H.kind = k; H.lastSeen = t; H.postural = postural;
        H.fromAway = !!x && x.inHand.some((e) => e.side === s && e.dm >= 0.8);
        if (x) { x.drink = true; if (this.foodTrack === x.id) { this.foodT = -99; this.foodCls = null; } }
        this.lastKind = k;
        this.log(t, 'hold ' + k, s, why);
        enter('holding', why);
        return true;
      };

      switch (H.st) {
        case 'cooldown':
          if (t - H.since > 1) enter('idle', 'cooldown over');
          break;
        case 'idle':
        case 'candidate': {
          if (tr && !tr.still) {
            if (H.st === 'idle') enter('candidate', `${topCls(tr)} in hand`);
            const ih = tr.inHand.filter((e) => e.side === s && t - e.t < C.holdWin);
            const dr = ih.filter((e) => DRINK_CLASSES.has(e.cls) && e.s >= C.minScore);
            const mean = dr.reduce((a, e) => a + e.s, 0) / Math.max(1, dr.length);
            const k = kindOf(tr);
            // a still box (the mic, a bottle on the shelf) only counts once a hand really lifted it
            // …and a box that never moved while in the hand (the mic you're touching) isn't carried
            const lifted = (!tr.still || tr.moved > 0.35) && tr.moved >= C.liftMin;
            // (a cup held still but seen clearly, again and again, needs no lift)
            const clear = dr.length >= 3 && mean >= 0.55;
            // only ever seen in the hand AT a mouth that was covered before the hand came: the mic being adjusted
            const micTouch = dr.length > 0 && dr.every((e) => e.dm < 0.8) && this.coveredBefore(dr[0].t);
            if (micTouch) H.why = 'touching what covers the mouth (mic?)';
            if (k && !micTouch && (lifted || clear) && ((dr.length >= C.holdLooks && mean >= C.holdMean) || (dr.length >= 1 && dr[dr.length - 1].s >= C.holdSingle))) {
              startHold(tr, k, `${topCls(tr, (c) => DRINK_CLASSES.has(c))} in hand ×${dr.length} (mean ${mean.toFixed(2)})`);
              break;
            }
            // look-alike: the whole drinking motion (carried up from below → closed lips → tilt back / cup hides the face)
            // (seen in the hand below the lips, then seen in the hand AT the lips, a box as wide as a can)
            const lk = tr.inHand.filter((e) => e.side === s && t - e.t < 3 && DRINK_LOOKALIKES.has(e.cls) && e.s >= C.lookScore);
            const bw = (tr.box.x1 - tr.box.x0) / (Fm?.size ?? 0.25);
            // (a wide flat box up at the eyes is the glasses, whatever hand is near it)
            const atLips = lk.find((e) => t - e.t < 1 && e.dm < 0.7 && e.dy > -0.35 && e.asp >= 0.6);
            const below = atLips && (tr.inHand.some((e) => e.side === s && e.t < atLips.t && atLips.t - e.t < 3 && e.dy > 0.4) || this.handY[s].some((e) => e.t < atLips.t && e.dy > 0.7));
            if (atLips && below && bw >= C.lookMinW && near && mouthOk && !talking) {
              // covered lips: a can's rim covers them, but so does a phone pressed to closed lips (MediaPipe guesses the
              // jaw closed behind anything) — strict: a box the detector calls a phone / remote needs the full drinking
              // motion (head tipped back or the face hidden), as before mouth visibility
              const coverOk = H.cover >= C.lookCover && (!C.lookCoverCue || !PHONE_LIKE.has(topCls(tr, (c) => DRINK_LOOKALIKES.has(c))));
              const motion = rise >= C.lookRise || H.hidden >= C.lookHide || coverOk || nearFor >= C.lookPlain;
              if (motion && k) {
                if (startHold(tr, k, `${topCls(tr, (c) => DRINK_LOOKALIKES.has(c))}→${k}: raised to closed lips, ${rise >= C.lookRise ? `tilt +${rise.toFixed(2)}` : H.hidden >= C.lookHide ? 'face hidden' : coverOk ? `lips covered ${H.cover.toFixed(1)} s${rise > 0.03 ? `, tilt +${rise.toFixed(2)}` : ''}` : `held ${nearFor.toFixed(1)} s`}`)) {
                  enter('sip', 'drinking motion'); H.sipEv = 0.8;
                }
                break;
              }
            }
          } else if (H.st === 'candidate' && (!tr || t - tr.t > 2)) enter('idle', 'object gone');
          // posture-only (no box): long characteristic drink motion, off unless enabled
          if (this.posture && hd && Fm && F && faceSteady) {
            const c = centre(hd.pts), tp = tips(hd);
            const lipsLevel = (c.y - Fm.mouth.y) / Fm.size > -0.25 && (tp.y - Fm.mouth.y) / Fm.size > -0.4;
            const pose = dm < 0.35 && lipsLevel && closed && !talking && rise > C.poseRise;
            H.poseT = pose ? Math.max(0, H.poseT) + dt : -1;
            if (H.poseT >= C.poseMin) {
              if (startHold(null, this.lastKind, `posture: hand at lips, tilt +${rise.toFixed(2)} for ${H.poseT.toFixed(1)} s`, true)) { enter('sip', 'posture'); H.sipEv = 0.75; }
            }
          } else H.poseT = -1;
          break;
        }
        default: {
          // holding / raised / sip / lowered
          const x = held;
          if (x && x.t === t && x.inHand.length && x.inHand[x.inHand.length - 1].t === t && x.inHand[x.inHand.length - 1].side === s) H.lastSeen = t;
          if (H.postural && H.st === 'sip' && hd && dm < 0.5) H.lastSeen = t;
          // at the lips the face / hand hide the cup from the detector: the hand being there is enough
          if (H.st === 'sip' && !H.postural && (hd || t - H.mouthT < 0.6)) H.lastSeen = Math.max(H.lastSeen, t);
          // re-vote the kind while the object is clearly visible (never morph mid-sip)
          if (x && !H.postural && H.st === 'holding') { const k = kindOf(x); if (k && this.types[k]) { H.kind = k; this.lastKind = k; } }
          const rel = H.postural ? 1.5 : (H.st === 'sip' || dm < 1.4) ? C.releaseAtMouth : C.release;
          if (x && x.freeRun >= 2 && x.t === t) { release(`${topCls(x)} seen put down`); break; }
          if (t - H.lastSeen > rel) { release(`not seen in hand for ${(t - H.lastSeen).toFixed(1)} s`); break; }
          if (t - H.handSeen > 1.5 + (H.st === 'sip' ? 2 : 0)) { release('hand lost'); break; }
          if (!this.types[H.kind]) { release(`${H.kind} disabled`); break; }
          if (H.st === 'holding' || H.st === 'lowered') {
            if (H.st === 'lowered' && t - H.since > 0.3) enter('holding', 'lowered');
            if (dm < C.sipNear + 0.35) enter('raised', `raised (mouth ${dm.toFixed(2)})`);
          } else if (H.st === 'raised') {
            if (near && nearFor >= C.sipMin && mouthOk && !talking) {
              H.sipEv = clamp01(0.6 + 0.3 * clamp01(rise / 0.25) + (faceHidden ? 0.2 : 0));
              this.log(t, 'sip', s, `${H.kind} at lips ${nearFor.toFixed(2)} s${rise > 0.03 ? `, tilt +${rise.toFixed(2)}` : ''}${faceHidden ? ', face hidden' : ''}, jaw closed, not speaking`);
              enter('sip', 'at lips');
            } else if (dm > C.sipNear + 0.5) enter('holding', 'moved away');
          } else if (H.st === 'sip') {
            const endSip = (H.awayT >= 0 && t - H.awayT > 0.25) || (talking && t - this.speakT < 0.05 && t - H.since > 0.4) || (F && !closed && t - H.since > 0.5 && !H.postural);
            if (endSip) { H.drinkEnd = t; enter('lowered', talking ? 'speaking' : !closed ? 'jaw opened' : 'lowered'); }
            else if (H.postural && F && rise < C.poseRise * 0.4 && t - H.since > 0.4) { release('posture ended'); break; }
          }
        }
      }
      const holding = H.st === 'holding' || H.st === 'raised' || H.st === 'sip' || H.st === 'lowered';
      if (holding) out.hold[s] = { kind: H.kind, since: H.since };
      H.sip = H.st === 'sip' ? Math.max(0.55, H.sipEv) : 0;
      out.sip[s] = H.sip;
      const ob = held ?? tr;
      hdbg[s] = { state: H.st, obj: ob ? topCls(ob) : null, score: ob ? +median(ob.scores).toFixed(2) : 0, dm: +dm.toFixed(2), cues: cues.join(', ') };
    }

    // ---- chewing rhythm on the jaw channel ----
    this.chewingNow = F ? this.chewRhythm(t) : false;
    if (this.chewingNow) this.chewT = t;
    out.chewing = this.chewingNow;

    // ---- hand → mouth visits (hands not holding a drink) ----
    for (const s of ['left', 'right'] as Side[]) {
      const V = this.visit[s];
      const H = this.d[s];
      const hd = hands.get(s);
      const drinking = H.st !== 'idle' && H.st !== 'candidate' && H.st !== 'cooldown';
      if (drinking || t - H.drinkEnd < 2 || !F || !hd) {
        if (V.at && (!hd || !F) && t - V.since > 1.5) V.at = false;
        if (drinking || t - H.drinkEnd < 2) V.at = false;
        continue;
      }
      const tp = tips(hd);
      const dx = (tp.x - F.mouth.x) / F.size, dy = (tp.y - F.mouth.y) / F.size;
      // fingertips up at the eyes / glasses / forehead, or out at the ear / headset, are not feeding the mouth
      const d = dy < -0.4 || Math.abs(dx) > 0.65 ? Infinity : Math.hypot(dx, dy);
      if (!V.at) {
        if (d < 0.75) { if (V.nearT < 0) V.nearT = t; if (t - V.nearT >= this.cfg.visitMin) { V.at = true; V.since = V.nearT; V.jawMax = F.jaw; V.voiced = 0; V.n = 0; V.food = null; } }
        else V.nearT = -1;
      } else {
        V.jawMax = Math.max(V.jawMax, F.jaw); V.n++; if (talking) V.voiced++;
        if (d > 1.05) {
          V.at = false; V.nearT = -1;
          const dur = t - V.since;
          const voicedFrac = V.voiced / Math.max(1, V.n);
          const food = V.food ?? (t - this.foodT < 20 ? this.foodCls : null);
          this.debug?.(t, `visit ${s} ${dur.toFixed(2)} s, jaw max ${V.jawMax.toFixed(2)}, voiced ${voicedFrac.toFixed(2)}, food ${food}`);
          if (!this.types.food) continue;
          if (dur < this.cfg.visitMin || dur > this.cfg.visitMax) continue;
          if (this.coveredBefore(V.since)) continue; // a hand at the mic that already covered the mouth
          if (voicedFrac > this.cfg.visitVoiced) continue; // talking with a hand at the face
          if (V.jawMax < this.cfg.biteJaw) continue; // a bite opens the mouth; a hand resting at the chin doesn't
          const why = `hand to mouth ${dur.toFixed(1)} s, mouth opened ${V.jawMax.toFixed(2)}`;
          if (food) this.fire(s, t, `${why}, ${food} in hand`);
          else this.pendingBite = { t, side: s, chew: 0, why };
        }
      }
    }

    // ---- bites confirmed by chewing ----
    const pb = this.pendingBite;
    if (pb) {
      // chewing only counts in silence (speech in between wipes it out again)
      if (this.chewingNow && t - this.speakT > 1) pb.chew += dt;
      else if (this.speaking(t)) pb.chew = Math.max(0, pb.chew - 2 * dt);
      if (pb.chew >= this.cfg.chewConfirm) { this.fire(pb.side, t, `${pb.why}, then chewing ${pb.chew.toFixed(1)} s (${this.chewWhy})`); this.pendingBite = null; }
      else if (t - pb.t > 5 + this.cfg.chewConfirm) this.pendingBite = null;
    }
    // long chewing with food in hand recently (fork / spoon food, the hand out of view) = more bites
    const foodRecent = t - this.foodT < 20;
    if (this.chewingNow && foodRecent && this.types.food) {
      if (this.chewSince < 0) this.chewSince = t;
      if (t - this.chewSince > 6 && t - this.chewBiteT > 6 && t - this.lastBite > 6) { this.chewBiteT = t; this.fire(this.lastSide, t, `chewing 6 s with ${this.foodCls} around`); }
    } else if (!this.chewingNow && t - this.chewT > 1.5) this.chewSince = -1;

    out.dbg = { left: hdbg.left, right: hdbg.right, speaking: talking, voice: this.voiceSrc, chew: this.chewingNow ? `chewing (${this.chewWhy})` : this.chewWhy, tracks: this.tracks.length, events: this.events };
    return out;
  }

  private lastSide: Side = 'right';
  private fire(side: Side, t: number, why: string) {
    if (t - this.lastBite < 1.2) return;
    this.lastBite = t;
    this.lastSide = side;
    this.bites.push(side);
    this.log(t, 'bite', side, why);
  }

  /**
   * Chewing: a regular 1–2.5 Hz jaw oscillation over the last ~3 s: amplitude well above the jaw's
   * frame-to-frame noise (a beard makes the jaw channel jitter ±0.05), regular cycle length AND swing
   * size, the jaw coming back near closed every cycle, and no speech in the window.
   */
  private chewRhythm(t: number): boolean {
    const J = this.jaw;
    this.chewWhy = '';
    if (J.length < 15) return false;
    const span = J[J.length - 1].t - J[0].t;
    if (span < 1.8) return false;
    const v = J.map((p) => p.v);
    const lo = quant(v, 0.1), hi = quant(v, 0.9);
    const amp = hi - lo;
    // noise: residual of each sample against its neighbours' mean
    const res: number[] = [];
    for (let i = 1; i + 1 < v.length; i++) res.push(Math.abs(v[i] - (v[i - 1] + v[i + 1]) / 2));
    const noise = median(res);
    if (amp < 0.1 || amp > 0.85) { this.chewWhy = `jaw swing ${amp.toFixed(2)}`; return false; }
    if (amp < noise * 5) { this.chewWhy = `jaw noise (${amp.toFixed(2)} vs ${noise.toFixed(3)})`; return false; }
    // a bare mic level also hears the crunching, so only a real VAD or the camera veto chewing (speech
    // itself fails the regularity tests below)
    const vadOk = this.voiceSrc === 'vad' || this.voiceSrc === 'camera' || this.camTalkNow;
    const voiced = J.filter((p) => p.sp).length / J.length;
    if (vadOk && (voiced > 0.15 || this.speaking(t))) { this.chewWhy = 'speaking'; return false; }
    // the jaw behind a cup / hand / mic is MediaPipe's guess, not chewing
    if (J.filter((p) => p.hid).length > J.length * 0.2) { this.chewWhy = 'mouth covered'; return false; }
    if (!vadOk && voiced > 0.6) { this.chewWhy = 'speaking (mic)'; return false; }
    let mean = 0; for (const x of v) mean += x; mean /= v.length;
    const th = amp * 0.3;
    let state = 0; const ups: number[] = [], peaks: number[] = [], troughs: number[] = [];
    let tr = Infinity;
    for (const p of J) {
      const x = p.v - mean;
      if (state <= 0 && x > th) { state = 1; ups.push(p.t); peaks.push(x); if (isFinite(tr)) troughs.push(tr); tr = Infinity; }
      else if (state >= 0 && x < -th) { state = -1; tr = x; }
      else if (state > 0) peaks[peaks.length - 1] = Math.max(peaks[peaks.length - 1], x);
      else if (state < 0) tr = Math.min(tr, x);
    }
    if (ups.length < 3) { this.chewWhy = 'no rhythm'; return false; }
    // one open-close per cycle: speech wiggles several times between the big swings (syllables)
    let rev = 0, dir = 0;
    for (let i = 2; i < v.length; i++) {
      const a0 = (v[i - 2] + v[i - 1]) / 2, a1 = (v[i - 1] + v[i]) / 2, dd = a1 - a0;
      if (Math.abs(dd) < Math.max(0.012, amp * 0.06)) continue;
      const sg = Math.sign(dd); if (dir && sg !== dir) rev++; dir = sg;
    }
    if (rev > ups.length * 2 * 1.6 + 2) { this.chewWhy = `wiggly (${rev} turns / ${ups.length} cycles)`; return false; }
    const pm = peaks.reduce((q, x) => q + x, 0) / peaks.length;
    const psd = Math.sqrt(peaks.reduce((q, x) => q + (x - pm) * (x - pm), 0) / peaks.length);
    if (psd / Math.max(1e-6, pm) > 0.35) { this.chewWhy = 'irregular swings'; return false; }
    // the jaw closes between chews (troughs near the window's floor); talking hovers half-open
    if (troughs.length >= 2 && troughs.filter((x) => x + mean < lo + amp * 0.35).length < troughs.length * 0.6) { this.chewWhy = 'jaw not closing'; return false; }
    const iv: number[] = [];
    for (let i = 1; i < ups.length; i++) iv.push(ups[i] - ups[i - 1]);
    const m = iv.reduce((a, b) => a + b, 0) / iv.length;
    const sd = Math.sqrt(iv.reduce((a, b) => a + (b - m) * (b - m), 0) / iv.length);
    const hz = 1 / m;
    if (hz < this.chewHz[0] || hz > this.chewHz[1]) { this.chewWhy = `${hz.toFixed(1)} Hz`; return false; }
    if (sd / m > 0.35) { this.chewWhy = 'irregular rhythm'; return false; }
    this.chewWhy = `${hz.toFixed(1)} Hz, swing ${amp.toFixed(2)}`;
    return true;
  }
}

// ---------------------------------------------------------------- mess accumulation

export interface MessLevels { style: MessKind; face: number; left: number; right: number }

/** Per-bite mess (face, eating hand) by style — spaghetti is the messiest, cheeto dust loves fingers. */
const BITE: Record<MessKind, { face: number; hand: number }> = {
  crumbs: { face: 0.07, hand: 0.08 },
  spaghetti: { face: 0.13, hand: 0.1 },
  cheeto: { face: 0.08, hand: 0.28 },
  chocolate: { face: 0.1, hand: 0.14 },
  sugar: { face: 0.09, hand: 0.12 },
};

export class MessState {
  lv: MessLevels = { style: 'crumbs', face: 0, left: 0, right: 0 };
  /** Face never gets messier than this (0..1). */
  max = 0.7;
  /** Minutes until a mess has faded to ~5 %. */
  fadeMin = 4;

  bite(side: Side, style: MessKind, scale = 1) {
    const b = BITE[style];
    const L = this.lv;
    // a new food mostly takes over the look (old stains fade under it)
    if (style !== L.style) { L.face *= 0.6; L.left *= 0.5; L.right *= 0.5; L.style = style; }
    L.face = Math.min(this.max, L.face + b.face * scale * (1 - 0.35 * L.face));
    const hk = side === 'left' ? 'left' : 'right';
    L[hk] = Math.min(1, L[hk] + b.hand * scale);
  }

  step(dt: number) {
    const tau = Math.max(5, this.fadeMin * 60) / 3; // exp(-3) ≈ 5 %
    const k = Math.exp(-dt / tau);
    const L = this.lv;
    L.face *= k; L.left *= k; L.right *= k;
    if (L.face > this.max) L.face = this.max;
    if (L.face < 0.004) L.face = 0;
    if (L.left < 0.004) L.left = 0;
    if (L.right < 0.004) L.right = 0;
  }

  clean() { this.lv.face = 0; this.lv.left = 0; this.lv.right = 0; }
  get any() { return this.lv.face > 0 || this.lv.left > 0 || this.lv.right > 0; }
}
