// Studio side of the food & drink fun layer: settings, tracking → SnackDetector input, and the
// SnackFrame every viewer renders (studio preview, OBS output, party guests). Everything is decided
// here once, so all viewers show exactly the same props and mess.

import type { MessStyle, SnackFrame, SnackHand, SnackProp, TrackingFrame } from '../../shared/types.ts';
import type { ObjectBox, ObjectRegion, RawTracking } from './Tracker.ts';
import { MessState, SnackDetector, messFor, type Pt, type Sensitivity, type Side, type SnackDet, type SnackHandIn, type SnackState, type SnackType, type SnackVoice } from './snacks.ts';

export interface SnackSettings {
  /** Master switch: camera detection of drinks / food (runs the object detector). */
  enabled: boolean;
  /** Show props: a drink prop in the avatar's hand. */
  drinks: boolean;
  /** How much evidence an event needs (strict = several cues must agree; default). */
  sensitivity: Sensitivity;
  /** Per-type toggles (drink kinds + food). */
  types: Record<SnackType, boolean>;
  /** Guess a drink from the posture alone (hand at the lips + long head tilt back) when no cup is seen. */
  posture: boolean;
  /** Food mess on the face / fingers. */
  mess: boolean;
  messStyle: 'auto' | MessStyle;
  propStyle: 'auto' | SnackProp;
  /** Max face messiness 0.1..1. */
  maxMess: number;
  /** Minutes until a mess has faded. */
  fadeMin: number;
  /** Detector rate (Hz) while a hand is up / something is going on. */
  hz: number;
  /** Detector rate (Hz) while nothing is going on (no hand in view). */
  idleHz: number;
}

export const SNACK_DEFAULTS: SnackSettings = {
  enabled: false, drinks: true, mess: true, messStyle: 'auto', propStyle: 'auto', maxMess: 0.7, fadeMin: 4, hz: 4, idleHz: 1.5,
  sensitivity: 'strict', posture: false, types: { mug: true, coffee: true, can: true, bottle: true, glass: true, food: true },
};
const KEY = 'vtp.snacks';

function load(): SnackSettings {
  try {
    const s = localStorage.getItem(KEY);
    if (s) { const p = JSON.parse(s) as Partial<SnackSettings>; return { ...SNACK_DEFAULTS, ...p, types: { ...SNACK_DEFAULTS.types, ...(p.types ?? {}) } }; }
  } catch { /* ignore */ }
  return { ...SNACK_DEFAULTS, types: { ...SNACK_DEFAULTS.types } };
}

interface HandAnim { k: SnackProp; a: number; sip: number }

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const boxRow = (d: ObjectBox): [string, number, number, number, number, number] => [d.cls, Math.round(d.score * 100) / 100, r3(d.x), r3(d.y), r3(d.w), r3(d.h)];

/**
 * Diagnostic capture (feature on + auto diagnostics): the detector inputs that actually reach the snack
 * logic — every step's face / hand summary (≤ 20 Hz), every detector look's raw boxes (all classes, before
 * any threshold) + which crop it saw, and ~1 JPEG / s of that crop. Dumped every ~20 s to the local diag
 * route (cache/diag/snacks-cap.json) so real sessions can be replayed offline (tools/test_snacks.ts).
 * Nothing leaves the machine.
 */
class SnackCapture {
  steps: unknown[] = [];
  looks: unknown[] = [];
  /** decided events with their reasons (hold / sip / bite / put down) */
  events: { t: number; kind: string; side: string; why: string }[] = [];
  private lastEvT = -1;
  snaps: { t: number; region?: ObjectRegion; roi?: object; jpg: Blob }[] = [];
  private lastStepT = -1;
  aspect = 16 / 9;
  mirror = false;

  step(t: number, face: { mouth: Pt; size: number; jaw: number; tiltBack: number; lips?: number; vis?: number } | null, hands: SnackHandIn[], speaking: number, st: SnackState) {
    if (t - this.lastStepT < 0.05) return;
    this.lastStepT = t;
    const hs = hands.map((h) => [h.side === 'left' ? 0 : 1, h.coarse ? 1 : 0, ...h.pts.flatMap((p) => [r3(p.x), r3(p.y)])]);
    const S = st.hold;
    this.steps.push([r3(t), face ? [r3(face.mouth.x), r3(face.mouth.y), r3(face.size), r3(face.jaw), r3(face.tiltBack), r3(face.lips ?? 0), ...(face.vis === undefined ? [] : [r3(face.vis)])] : null, hs, r3(speaking),
      [S.left?.kind ?? 0, S.right?.kind ?? 0, r3(st.sip.left), r3(st.sip.right), st.chewing ? 1 : 0, st.dbg?.left.state ?? '', st.dbg?.right.state ?? '', st.dbg?.speaking ? 1 : 0]]);
    for (const e of st.dbg?.events ?? []) if (e.t > this.lastEvT) { this.lastEvT = e.t; this.events.push(e); }
    if (this.steps.length > 600) this.steps.shift();
  }

  look(t: number, ob: { region?: ObjectRegion; roi?: { x: number; y: number; w: number; h: number }; raw?: ObjectBox[]; dets: ObjectBox[]; jpg?: Blob | null; ms?: number }) {
    this.looks.push({ t: r3(t), region: ob.region ?? '?', roi: ob.roi ? [r3(ob.roi.x), r3(ob.roi.y), r3(ob.roi.w), r3(ob.roi.h)] : null, ms: Math.round(ob.ms ?? 0), raw: (ob.raw ?? ob.dets).map(boxRow), snap: !!ob.jpg });
    if (this.looks.length > 200) this.looks.shift();
    if (ob.jpg) { this.snaps.push({ t: r3(t), region: ob.region, roi: ob.roi, jpg: ob.jpg }); if (this.snaps.length > 24) this.snaps.shift(); }
  }

  /** JSON of everything since the last dump (null when nothing was recorded); clears the buffers. */
  async dump(): Promise<string | null> {
    if (!this.steps.length && !this.looks.length) return null;
    const steps = this.steps, looks = this.looks, snaps = this.snaps, events = this.events;
    this.steps = []; this.looks = []; this.snaps = []; this.events = [];
    const toUrl = (b: Blob) => new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => res(''); fr.readAsDataURL(b); });
    const sn = await Promise.all(snaps.map(async (x) => ({ t: x.t, region: x.region, roi: x.roi, jpg: await toUrl(x.jpg) })));
    return JSON.stringify({ v: 1, at: new Date().toISOString(), aspect: this.aspect, mirror: this.mirror,
      stepCols: 't, face[mx,my,size,jaw,tilt,lips,(vis)], hands[[side 0=L 1=R, coarse, x0,y0,...]], speaking, state[holdL, holdR, sipL, sipR, chew, stateL, stateR, speakingDecided]',
      steps, looks, events, snaps: sn });
  }
}

export class SnackController {
  settings: SnackSettings = load();
  readonly detector = new SnackDetector();
  readonly mess = new MessState();
  /** Last detector state (UI / diagnostics). */
  state: SnackState | null = null;
  /** Latest detector look (diagnostics / state.json): region + top raw boxes (all classes). */
  lastLook: { region: string; raw: ReturnType<typeof boxRow>[]; t: number } | null = null;
  /** Diagnostic capture ring (null = off). Turned on by the app while auto-diagnostics run. */
  capture: SnackCapture | null = null;
  setCapture(on: boolean) { if (on && !this.capture) this.capture = new SnackCapture(); else if (!on) this.capture = null; }
  private objectsId = 0;
  private anim: Record<Side, HandAnim> = { left: { k: 'coffee', a: 0, sip: 0 }, right: { k: 'coffee', a: 0, sip: 0 } };
  private bites = 0;
  /** Debug / preview overrides (UI buttons, `vtp.snacks.debug`): forced props + sip, expire at `until` (s). */
  private forced: { side: Side; k: SnackProp; sip: number; until: number }[] = [];

  constructor() { this.applySettings(); }

  save(patch: Partial<SnackSettings>) {
    this.settings = { ...this.settings, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
    this.applySettings();
    if (!this.settings.enabled) this.detector.reset();
  }

  private applySettings() {
    const S = this.settings;
    if (this.detector.sensitivity !== S.sensitivity) this.detector.setSensitivity(S.sensitivity);
    this.detector.posture = !!S.posture;
    this.detector.types = { ...SNACK_DEFAULTS.types, ...S.types, food: S.types?.food !== false && S.mess };
    this.mess.max = Math.min(1, Math.max(0.05, this.settings.maxMess));
    this.mess.fadeMin = Math.max(0.25, this.settings.fadeMin);
  }

  /** The tracker should run the object detector. */
  get wantObjects() { return this.settings.enabled && (this.settings.drinks || this.settings.mess); }

  /** Something is in progress (a hand holds / carries something, a hand is near the mouth): the tracker
   *  runs the object detector at the full rate; otherwise at settings.idleHz. */
  get busy() {
    const d = this.state?.dbg;
    return !!d && (d.left.state !== 'idle' || d.right.state !== 'idle' || d.left.dm < 1.5 || d.right.dm < 1.5);
  }

  // ---------------------------------------------------------------- voice activity (pluggable)
  /** Latest voice frame (VAD 0..1, level 0..1) and when it arrived (performance.now() s). */
  private voice: { at: number; vad?: number; level?: number } | null = null;
  private voiceSrc: unknown = null;
  /** Feed a voice-activity frame (from the voice front-end: {t, vad, level, visemes}). */
  onVoice(f: { vad?: number; level?: number }) {
    this.voice = { at: performance.now() / 1000, vad: typeof f.vad === 'number' ? f.vad : undefined, level: typeof f.level === 'number' ? f.level : undefined };
  }
  /** Subscribe to a voice front-end exposing onFrame(cb) (idempotent; anything else is ignored). */
  attachVoice(src: unknown) {
    if (!src || src === this.voiceSrc) return;
    const on = (src as { onFrame?: unknown }).onFrame;
    if (typeof on !== 'function') return;
    this.voiceSrc = src;
    try { (on as (cb: (f: { vad?: number; level?: number }) => void) => void).call(src, (f) => this.onVoice(f ?? {})); } catch { this.voiceSrc = null; }
  }

  /** Per NEW tracking result (studio, webcam). jaw = raw camera jawOpen, speaking = mic level 0..1. */
  onTracking(raw: RawTracking, frame: TrackingFrame, jaw: number, mirror: boolean, speaking: number) {
    if (!this.settings.enabled) return;
    const A = raw.width / Math.max(1, raw.height);
    const P = (p: { x: number; y: number }): Pt => ({ x: p.x * A, y: p.y });
    // face
    const lm = raw.face?.faceLandmarks?.[0];
    const face = lm && lm.length > 454
      ? { mouth: { x: ((lm[13].x + lm[14].x) / 2) * A, y: (lm[13].y + lm[14].y) / 2 }, size: Math.hypot((lm[234].x - lm[454].x) * A, lm[234].y - lm[454].y), jaw, lips: frame.mouth?.open ?? 0, tiltBack: -(frame.head?.[1] ?? 0),
        // mouth visibility (mouthVisibility.ts): a cup / hand / mic over the lips
        ...(typeof frame.face._mouthVis === 'number' ? { vis: frame.face._mouthVis } : {}) }
      : null;
    // hands: anatomical side from the nearest pose wrist (else MediaPipe's label — it assumes a selfie
    // image, ours isn't mirrored), then the avatar side (mirror swaps)
    const pl = raw.pose?.landmarks?.[0];
    const avatarSide = (anat: Side): Side => (mirror ? (anat === 'left' ? 'right' : 'left') : anat);
    const hands: SnackHandIn[] = [];
    const got = new Set<Side>();
    const hl = raw.hands?.landmarks ?? [];
    for (let i = 0; i < Math.min(2, hl.length); i++) {
      const w = hl[i][0];
      let anat: Side;
      if (pl && pl.length > 16) {
        const dl = Math.hypot((pl[15].x - w.x) * A, pl[15].y - w.y), dr = Math.hypot((pl[16].x - w.x) * A, pl[16].y - w.y);
        anat = dl <= dr ? 'left' : 'right';
      } else anat = raw.hands?.handedness?.[i]?.[0]?.categoryName === 'Left' ? 'right' : 'left';
      if (got.has(anat)) anat = anat === 'left' ? 'right' : 'left';
      got.add(anat);
      hands.push({ side: avatarSide(anat), pts: hl[i].map(P) });
    }
    // the hand model often loses a hand wrapped around a cup: fall back to the pose's wrist + knuckles
    if (pl && pl.length > 22) {
      for (const [anat, ids] of [['left', [15, 17, 19, 21]], ['right', [16, 18, 20, 22]]] as const) {
        if (got.has(anat)) continue;
        const w = pl[ids[0]];
        if ((w.visibility ?? 0) < 0.5 || w.y > 1.02 || w.y < -0.02 || w.x < -0.02 || w.x > 1.02) continue;
        hands.push({ side: avatarSide(anat), pts: ids.map((i) => P(pl[i])), coarse: true });
      }
    }
    // detector boxes (only on a NEW detector result)
    let dets: SnackDet[] | null = null;
    const ob = raw.objects;
    if (ob && ob.id !== this.objectsId) {
      this.objectsId = ob.id;
      dets = ob.dets.map((d) => ({ cls: d.cls, score: d.score, x0: d.x * A, y0: d.y, x1: (d.x + d.w) * A, y1: d.y + d.h, rgb: d.rgb }));
      this.lastLook = { region: ob.region ?? '?', raw: (ob.raw ?? ob.dets).slice(0, 8).map(boxRow), t: raw.t };
      if (this.capture) { this.capture.aspect = A; this.capture.mirror = mirror; this.capture.look(raw.t, ob); }
    }
    // voice activity: the voice front-end's VAD when it is feeding us (fresh), else the mic level
    const vf = this.voice && performance.now() / 1000 - this.voice.at < 0.5 ? this.voice : null;
    const voice: SnackVoice | null = vf ? { vad: vf.vad, level: vf.level ?? speaking } : null;
    this.state = this.detector.step({ t: raw.t, face, hands, dets, speaking, voice });
    this.capture?.step(raw.t, face, hands, speaking, this.state);
    if (this.settings.mess) {
      const style = this.settings.messStyle === 'auto' ? messFor(this.state.food) : this.settings.messStyle;
      for (const side of this.detector.takeBites()) { this.mess.bite(side, style); this.bites++; }
    } else this.detector.takeBites();
  }

  /** Live readout for the panel: per-hand state + cues, voice, chewing, the last decisions and why. */
  debugText(now = performance.now() / 1000): string {
    const d = this.state?.dbg;
    if (!d) return '';
    const hand = (k: 'left' | 'right') => { const x = d[k]; return `${k === 'left' ? 'L' : 'R'}: ${x.state}${x.cues ? ` · ${x.cues}` : ''}`; };
    const lines = [hand('left'), hand('right'), `voice: ${d.voice}${d.speaking ? ' — speaking' : ''} · jaw: ${d.chew || '—'} · tracks ${d.tracks}`];
    for (const e of d.events.slice(-4).reverse()) lines.push(`${Math.max(0, now - e.t).toFixed(0)} s ago: ${e.kind}${e.side ? ` (${e.side})` : ''} — ${e.why}`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- debug / preview
  /** Show a prop in a hand for `seconds` (sip 0..1 tilts it to the mouth). */
  forceHold(side: Side, k: SnackProp, sip = 0, seconds = 6) {
    this.forced = this.forced.filter((f) => f.side !== side);
    this.forced.push({ side, k, sip, until: performance.now() / 1000 + seconds });
  }
  /** Simulate `n` bites of a style (preview / tests). */
  forceBite(n = 1, style?: MessStyle, side: Side = 'right') {
    const s = style ?? (this.settings.messStyle === 'auto' ? this.mess.lv.style : this.settings.messStyle);
    for (let i = 0; i < n; i++) { this.mess.bite(side, s); this.bites++; }
  }
  /** Set mess levels directly (debug). */
  setMess(style: MessStyle, face: number, left = 0, right = 0) { Object.assign(this.mess.lv, { style, face, left, right }); }
  clean() { this.mess.clean(); }

  /** Per render tick: animate, fade the mess, and build the frame's `snack` (undefined = nothing to show). */
  tick(dt: number, tNow: number): SnackFrame | undefined {
    this.mess.step(dt);
    this.forced = this.forced.filter((f) => f.until > tNow);
    const out: SnackFrame = {};
    let any = false;
    for (const side of ['left', 'right'] as Side[]) {
      const A = this.anim[side];
      const f = this.forced.find((x) => x.side === side);
      const live = this.settings.enabled && this.settings.drinks ? this.state?.hold[side] ?? null : null;
      const holding = !!f || !!live;
      let target = holding ? 1 : 0;
      if (holding) {
        let k: SnackProp = f ? f.k : live!.kind;
        if (!f && this.settings.propStyle !== 'auto') k = this.settings.propStyle;
        if (A.a < 0.05) A.k = k;          // switch kind only while hidden (no morphing mid-hand):
        else if (A.k !== k) target = 0;   // pop the old prop out, the new one pops in
      }
      A.a = target > A.a ? Math.min(target, A.a + dt / 0.25) : Math.max(target, A.a - dt / 0.3);
      const sipT = f ? f.sip : live ? this.state!.sip[side] : 0;
      A.sip += (sipT - A.sip) * (1 - Math.exp(-(sipT > A.sip ? 7 : 4.5) * dt));
      if (A.a > 0.001) { out[side === 'left' ? 'l' : 'r'] = { k: A.k, a: +A.a.toFixed(3), sip: +Math.max(0, A.sip).toFixed(3) } satisfies SnackHand; any = true; }
    }
    if (this.mess.any) {
      const L = this.mess.lv;
      out.m = { s: L.style, f: +L.face.toFixed(4), hl: +L.left.toFixed(4), hr: +L.right.toFixed(4) };
      any = true;
    }
    if (this.bites) { out.b = this.bites; any = true; }
    return any ? out : undefined;
  }
}

/** Lips close + pucker on the rim while sipping (applied to the published frame, so OBS sees it too). */
export function applySip(frame: TrackingFrame): TrackingFrame {
  const sn = frame.snack;
  if (!sn) return frame;
  const s = Math.max((sn.l?.sip ?? 0) * (sn.l?.a ?? 0), (sn.r?.sip ?? 0) * (sn.r?.a ?? 0));
  if (s < 0.01) return frame;
  const face = { ...frame.face };
  const k = Math.min(1, s);
  face.mouthPucker = Math.max(face.mouthPucker ?? 0, 0.75 * k);
  face.mouthFunnel = Math.max(face.mouthFunnel ?? 0, 0.3 * k);
  face.jawOpen = (face.jawOpen ?? 0) * (1 - 0.75 * k) + 0.06 * k;
  face.mouthSmileLeft = (face.mouthSmileLeft ?? 0) * (1 - 0.6 * k);
  face.mouthSmileRight = (face.mouthSmileRight ?? 0) * (1 - 0.6 * k);
  face.eyeSquintLeft = Math.max(face.eyeSquintLeft ?? 0, 0.25 * k); // a contented sip
  face.eyeSquintRight = Math.max(face.eyeSquintRight ?? 0, 0.25 * k);
  const m = frame.mouth;
  return {
    ...frame, face,
    mouth: { ...m, pucker: Math.max(m.pucker, 0.75 * k), funnel: Math.max(m.funnel, 0.3 * k), open: m.open * (1 - 0.75 * k) + 0.05 * k, smile: m.smile * (1 - 0.6 * k), wide: m.wide * (1 - k) },
  };
}
