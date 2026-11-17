// Viseme rig: makes every speech viseme read correctly on THIS model, automatically.
//
// At load it inspects what the avatar can do with its mouth + face —
//   ARKit perfect-sync keys (full or partial sets) · VRM A/I/U/E/O + emotion presets (and whether an
//   emotion blocks the mouth) · VRoid raw Fcl_MTH_* / Fcl_EYE_* / Fcl_BRW_* shapes · MMD / VRChat named
//   visemes · the procedural mouth (toon / cavity / 3d, teeth or toothless, tongue) · jaw rigs (jaw /
//   puppet, mechanical, light-grille drive) · the look (anime / realistic)
// — measures how far each of its mouth shapes actually moves the surface (weak and strong rigs are
// normalised to the same visual strength) and builds a per-model mapping. Every frame it turns
// frame.visemes (voice-timed, camera-confirmed) into:
//   * a speech-shaped TrackingFrame (face ARKit channels + the mouth summary) that the existing drivers
//     — procedural mouth, own shape keys, jaw bones, voice-glow — already render, with substitutes for
//     shapes the model lacks (no mouthRollLower → FF from press + lip raise, etc.)
//   * extras the procedural mouth draws itself (tongue tip raised for L, tongue between teeth for TH)
//   * VRM / named-viseme vowel weights (+ VRoid Fcl_MTH_Close/Small) for preset-only faces
// …with an emotive layer on top: smiles/frowns are never erased by speech (visemes shape the mouth,
// emotions own the corners), an angry shout bares the teeth, happy talking keeps the cheek squint and
// eyes, VRM emotions that would block the mouth are eased while talking and their eye/brow part is kept.
// No frame.visemes (mic off) → the frame passes through untouched apart from the emotive eye consistency.

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { AvatarProfile, TrackingFrame } from '../../shared/types.ts';
import { clamp01, smoothstep as ss } from '../tracking/filters.ts';
import { VISEMES, type Viseme } from '../tracking/visemes.ts';
import { estimateEmotions, type ExpressionDriver, type Target } from './expressions.ts';
import { visemeOpenScale } from './mouthRules.ts';
import { A2F_EYES, A2F_UPPER, readA2f, vrmPresetsFromArticulators } from '../../shared/lipBus.ts';

/** A walking machine's PILOT height (model units): profile.mech.pilotHeight, else hips → head × 2.9 on the skeleton. */
function mechPilotHeight(p: AvatarProfile, model: THREE.Object3D): number | null {
  const ph = (p.mech as { pilotHeight?: unknown } | undefined)?.pilotHeight;
  if (typeof ph === 'number' && ph > 0) return ph;
  const hips = model.getObjectByName('hips'), head = model.getObjectByName('head');
  if (!hips || !head) return null;
  model.updateWorldMatrix(true, true);
  const inv = model.matrixWorld.clone().invert();
  const d = head.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).distanceTo(hips.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv));
  return d > 1e-4 ? d * 2.9 : null;
}

/** Control space the viseme targets are authored in (ARKit-like, symmetric) + procedural extras. */
interface Ctl {
  jawOpen: number; mouthClose: number; mouthPress: number; mouthRollUpper: number; mouthRollLower: number;
  mouthShrugLower: number; mouthUpperUp: number; mouthLowerDown: number; mouthStretch: number; mouthSmile: number;
  mouthFunnel: number; mouthPucker: number; tongueOut: number; cheekPuff: number;
  /** procedural extras */
  tongueUp: number; tongueTip: number; fv: number; sib: number; closure: number;
}
const CTL_KEYS: (keyof Ctl)[] = ['jawOpen', 'mouthClose', 'mouthPress', 'mouthRollUpper', 'mouthRollLower', 'mouthShrugLower', 'mouthUpperUp', 'mouthLowerDown',
  'mouthStretch', 'mouthSmile', 'mouthFunnel', 'mouthPucker', 'tongueOut', 'cheekPuff', 'tongueUp', 'tongueTip', 'fv', 'sib', 'closure'];

// What each viseme looks like at full intensity (human articulation, anime-readable).
const TARGET: Record<Viseme, Partial<Ctl>> = {
  sil: {},
  PP: { mouthClose: 0.5, mouthPress: 0.85, mouthRollUpper: 0.3, mouthRollLower: 0.3, cheekPuff: 0.12, closure: 1 },
  FF: { jawOpen: 0.05, mouthRollLower: 0.8, mouthShrugLower: 0.35, mouthUpperUp: 0.3, fv: 1 },
  TH: { jawOpen: 0.16, mouthUpperUp: 0.12, tongueOut: 0.22, tongueTip: 1 },
  DD: { jawOpen: 0.14, mouthStretch: 0.15, mouthUpperUp: 0.1, tongueUp: 0.55, sib: 0.25 },
  kk: { jawOpen: 0.24, mouthStretch: 0.12 },
  CH: { jawOpen: 0.07, mouthFunnel: 0.6, mouthPucker: 0.4, mouthUpperUp: 0.25, sib: 0.85 },
  SS: { jawOpen: 0.04, mouthStretch: 0.45, mouthUpperUp: 0.18, mouthLowerDown: 0.15, sib: 1 },
  nn: { jawOpen: 0.1, mouthClose: 0.1, tongueUp: 0.65 },
  RR: { jawOpen: 0.17, mouthFunnel: 0.5, mouthPucker: 0.3 },
  L: { jawOpen: 0.34, mouthStretch: 0.1, tongueUp: 1 },
  W: { jawOpen: 0.05, mouthPucker: 1, mouthFunnel: 0.25 },
  aa: { jawOpen: 0.8, mouthLowerDown: 0.3 },
  E: { jawOpen: 0.42, mouthStretch: 0.45, mouthUpperUp: 0.12 },
  I: { jawOpen: 0.18, mouthStretch: 0.7, mouthSmile: 0.12 },
  O: { jawOpen: 0.52, mouthFunnel: 0.85 },
  U: { jawOpen: 0.14, mouthPucker: 0.9, mouthFunnel: 0.3 },
};
/** how strongly each viseme holds the mouth (nearly) shut regardless of the loudness-driven opening */
const CLOSING: Partial<Record<Viseme, number>> = { PP: 1, FF: 0.85, SS: 0.7, CH: 0.6, nn: 0.55, DD: 0.5, TH: 0.35, W: 0.5, kk: 0.25 };

const VOWEL_SET = new Set<Viseme>(['aa', 'E', 'I', 'O', 'U']);

/** Typical displacement of each ARKit mouth shape relative to a full jawOpen on a well-made rig. */
const REF_RATIO: Record<string, number> = {
  jawOpen: 1, mouthClose: 0.45, mouthFunnel: 0.35, mouthPucker: 0.35, mouthRollLower: 0.25, mouthRollUpper: 0.25,
  mouthShrugLower: 0.2, mouthShrugUpper: 0.2, mouthPressLeft: 0.15, mouthPressRight: 0.15, mouthUpperUpLeft: 0.22, mouthUpperUpRight: 0.22,
  mouthLowerDownLeft: 0.25, mouthLowerDownRight: 0.25, mouthStretchLeft: 0.3, mouthStretchRight: 0.3,
  // (smile / frown / tongueOut are emotion + gag shapes the author tuned — never normalised)
};

export interface MouthCaps {
  arkit: string[];
  perfectSync: boolean;
  vrmVowels: boolean;
  namedVowels: boolean;
  fcl: string[];
  procedural: null | { style: string; teeth: boolean; tongue: boolean };
  jaw: null | { kind: string; drive: string };
  mechanical: boolean;
  voiceGlow: boolean;
  realistic: boolean;
  mouthBlockers: string[];
  gains: Record<string, number>;
  /** overall viseme exaggeration for this model style */
  intensity: number;
  /** the model's pucker / funnel shapes OPEN the lips into the "o" themselves (glTF extra vtp_round_opens):
   *  rounded visemes keep the jaw shut and use one rounded shape at a time */
  roundOpens: boolean;
  /** how speech maps onto this mouth (profile.mouth.rules.style; 'human' unless the profile picks 'wideCartoon') */
  style: MouthStyle;
  /** the model looks like a wide cartoon mouth (the studio suggests the style; it never switches by itself) */
  wideLikely: boolean;
}

export type MouthStyle = 'human' | 'wideCartoon';

/** Default jaw share per viseme on a wide cartoon mouth (the profile's own rules.visemeOpen wins per key): the full gape
 *  is a big event, everyday sounds use a fraction of it. */
export const WIDE_VISEME_OPEN: Record<string, number> = {
  aa: 1.1, O: 0.8, E: 0.7, I: 0.5, U: 0.55, W: 0.5, RR: 0.7, L: 0.85, kk: 0.85, DD: 0.75, TH: 0.85, nn: 0.7, CH: 0.7, SS: 0.6,
};

/** The avatar's mouth style: 'wideCartoon' only when the profile says so (profile.mouth.rules.style); everything else —
 *  unset, 'auto', 'human' — keeps the human mapping, so no existing avatar changes by itself. */
export function mouthStyleFor(p: AvatarProfile): MouthStyle {
  return p.mouth.rules?.style === 'wideCartoon' ? 'wideCartoon' : 'human';
}

/** Does this model look like a wide cartoon mouth? A jaw-bone mouth (no jawOpen shape of its own, a moving jaw,
 *  mouth.mode 'model') at least a tenth of the avatar's height wide (a frog / toad / mascot gape; a human mouth is ~3 %).
 *  Only used to SUGGEST the style (src/ui/mouthStyle.ts); the user switches. */
export function wideMouthLikely(p: AvatarProfile, modelHeight: number, arkit: Set<string>, jaw: { kind: string; drive: string } | null): boolean {
  if (!jaw || jaw.kind !== 'jaw' || jaw.drive === 'light' || arkit.has('jawOpen') || p.mouth.mode !== 'model') return false;
  return modelHeight > 0 && p.mouth.width / modelHeight >= 0.1;
}

/** Soft ceiling: unchanged below 70 % of `cap`, then eases into `cap` (never a hard clip that flattens the jaw stroke). */
export function softCap(x: number, cap: number): number {
  const k = cap * 0.7;
  if (x <= k || cap >= 0.999) return x;
  const r = cap - k;
  return k + r * Math.tanh((x - k) / r);
}

/** Extra drive for the procedural mouth. */
export interface VisemeExtras { tongueUp: number; tongueTip: number; bulge: number }

export interface VisemeRigInput {
  profile: AvatarProfile; model: THREE.Object3D; vrm: VRM | null; expressions: ExpressionDriver;
  hasProceduralMouth: boolean; jaw: null | { kind: string; drive: string }; mechanical: boolean; voiceGlow: boolean;
}

export class VisemeRig {
  readonly caps: MouthCaps;
  private fcl = new Map<string, Target[]>();
  private eyePart = new Map<string, Target[]>();
  private has: Set<string>;
  /** last output (debug / screenshots) */
  last: { vis: Record<string, number> | null; ctl: Partial<Ctl>; engage: number; out?: Record<string, number> } = { vis: null, ctl: {}, engage: 0 };

  constructor(private readonly inp: VisemeRigInput) {
    const { profile: p, model, vrm, expressions: ex } = inp;
    this.has = ex.arkitKeys();
    // VRoid raw shapes (not bound to an expression → safe to drive directly)
    const bound = new Set<string>();
    for (const e of vrm?.expressionManager?.expressions ?? []) for (const b of e.binds as unknown as { primitives?: THREE.Mesh[]; index?: number }[]) {
      if (b.primitives && b.index !== undefined) for (const m of b.primitives) bound.add(m.uuid + ':' + b.index);
    }
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.morphTargetDictionary || m.userData.vtpGenerated) return;
      for (const [name, index] of Object.entries(m.morphTargetDictionary)) {
        if (bound.has(m.uuid + ':' + index)) continue;
        const k = /Fcl_(MTH_(?:Close|Small)|EYE_(?:Joy|Angry|Sorrow|Surprised)|BRW_(?:Joy|Angry|Sorrow|Surprised))$/i.exec(name)?.[1];
        if (!k) continue;
        const key = k.toLowerCase();
        const map = key.startsWith('mth') ? this.fcl : this.eyePart;
        (map.get(key) ?? map.set(key, []).get(key)!).push({ mesh: m, index });
      }
    });
    let roundOpens = false;
    model.traverse((o) => { if (o.userData?.vtp_round_opens) roundOpens = true; });
    const gains = this.measureGains(model);
    const style = mouthStyleFor(p);
    const wideLikely = wideMouthLikely(p, new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y, this.has, inp.jaw);
    for (const [k, g] of Object.entries(gains)) ex.gains.set(k, g);
    const realistic = p.look?.shading === 'realistic';
    const jaw = inp.jaw;
    const intensity = (realistic ? 0.82 : 1) * (vrm ? 0.95 : 1) * (jaw?.kind === 'puppet' ? 1.1 : 1);
    this.caps = {
      arkit: [...this.has],
      perfectSync: ex.hasArkit,
      vrmVowels: !!vrm?.expressionManager?.getExpression('aa'),
      namedVowels: ex.namedTargets('aa').length > 0,
      fcl: [...this.fcl.keys(), ...this.eyePart.keys()],
      procedural: inp.hasProceduralMouth ? { style: p.mouth.style, teeth: p.mouth.showTeeth, tongue: p.mouth.showTongue } : null,
      jaw, mechanical: inp.mechanical, voiceGlow: inp.voiceGlow, realistic,
      mouthBlockers: [...ex.mouthBlockers.keys()],
      gains, intensity, roundOpens, style, wideLikely,
    };
  }

  /**
   * How far each of the model's own mouth shapes moves its surface → gain so a weak rig reads as strongly as
   * a well-made one (and an over-strong one calms down). Measured against the rig's own jawOpen (or, for
   * preset faces, its own "aa"), softened (sqrt) and clamped — this is normalisation, not re-authoring.
   */
  private measureGains(model: THREE.Object3D): Record<string, number> {
    const ex = this.inp.expressions;
    const disp = (ts: readonly Target[]) => {
      let mx = 0;
      for (const t of ts) {
        const attr = t.mesh.geometry.morphAttributes.position?.[t.index];
        if (!attr) continue;
        const rel = t.mesh.geometry.morphTargetsRelative;
        const base = t.mesh.geometry.attributes.position;
        const s = t.mesh.getWorldScale(new THREE.Vector3()).x;
        const step = Math.max(1, Math.floor(attr.count / 20000));
        for (let i = 0; i < attr.count; i += step) {
          const dx = rel ? attr.getX(i) : attr.getX(i) - base.getX(i), dy = rel ? attr.getY(i) : attr.getY(i) - base.getY(i), dz = rel ? attr.getZ(i) : attr.getZ(i) - base.getZ(i);
          const d = Math.hypot(dx, dy, dz) * s;
          if (d > mx) mx = d;
        }
      }
      return mx;
    };
    const out: Record<string, number> = {};
    let height = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y || 1.6;
    // a pilot in a walking machine: the mouth belongs to the pilot, not the machine (profile.mech.pilotHeight, else the
    // pilot's skeleton: hips → head × 2.9) — the machine's height would over-boost every shape
    if (this.inp.profile.body === 'mech') height = mechPilotHeight(this.inp.profile, model) ?? height;
    const soft = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.sqrt(x)));
    // reference: the rig's own jawOpen, else (jaw-bone rigs) what a typical full jawOpen moves — ~1.4 % of height
    const jawD = disp(ex.arkitTargets('jawOpen'));
    const jaw = jawD > 0 ? jawD : (this.has.size ? 0.014 * height : 0);
    if (jaw > 0) {
      // a full jawOpen on a typical rig drops the chin ~1.4 % of the avatar's height
      if (jawD > 0) out.jawOpen = soft((0.014 * height) / jaw, 0.88, 1.25);
      for (const k of Object.keys(REF_RATIO)) {
        if (k === 'jawOpen') continue;
        const d = disp(ex.arkitTargets(k));
        // lip-closing shapes are never boosted: on a weak-jaw rig a boosted close/press/roll crosses the lips
        const hi = /mouthClose|mouthPress|mouthRoll/.test(k) ? 1 : 1.3;
        // (jaw-bone rigs: the reference is only a guess — a big cartoon mouth must not be weakened by it)
        if (d > 0) out[k] = soft((REF_RATIO[k] * jaw) / d, jawD > 0 ? 0.88 : 1, Math.max(1, hi));
      }
    }
    const aa = disp(ex.namedTargets('aa'));
    if (aa > 0) {
      const ref: Record<string, number> = { ih: 0.45, ou: 0.5, ee: 0.6, oh: 0.75 };
      for (const k of Object.keys(ref)) { const d = disp(ex.namedTargets(k)); if (d > 0) out[k] = soft((ref[k] * aa) / d, 0.8, 1.25); }
    }
    for (const k in out) out[k] = +out[k].toFixed(3);
    return out;
  }

  /**
   * Speech-shaped frame for this model + procedural extras + preset vowels. Call once per rendered frame
   * with its dt (studio and OBS output pages alike) — the articulators have their own dynamics.
   *
   * Coarticulation model: visemes (voice-timed class weights) → continuous ARTICULATOR targets
   * (jaw opening, lip rounding, spreading, lip seal, lower-lip tuck, teeth, tongue up / tip), each driven
   * through its own attack/release envelope, so flicker between neighbouring classes can't pop the mouth,
   * the jaw moves in smooth syllable strokes and closures are brief but crisp (a lip seal only fires when
   * PP clearly dominates, snaps shut in ~25 ms, holds ≥ 60 ms). Then every output is clamped against the
   * others (no pucker + stretch, no tongue through closed lips, no jaw over-open) before it reaches the model.
   */
  apply(f: TrackingFrame, dt = 1 / 60): { frame: TrackingFrame; extras: VisemeExtras; vowels?: Record<string, number>; emotionCap?: Record<string, number> } {
    dt = Math.min(0.1, Math.max(1e-3, dt));
    const extras: VisemeExtras = { tongueUp: 0, tongueTip: 0, bulge: 0 };
    const face = { ...f.face };
    const g = (k: string) => face[k] ?? 0;
    const emo = estimateEmotions(face);
    // ---- emotive layer, always: eyes agree with the mouth (raise only — never fight the camera)
    const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) / 2;
    const smileK = ss(0.25, 0.8, smile);
    for (const s of ['Left', 'Right']) {
      face['cheekSquint' + s] = Math.max(g('cheekSquint' + s), smileK * 0.5);
      face['eyeSquint' + s] = Math.max(g('eyeSquint' + s), smileK * 0.22 + ss(0.3, 0.9, emo.angry) * 0.25);
      face['eyeWide' + s] = Math.max(g('eyeWide' + s), ss(0.35, 0.9, emo.surprised) * 0.4);
    }
    const vis = f.visemes;
    // speaking engagement: fast in (50 ms), slow out (350 ms) — no popping between words
    const engTarget = vis ? clamp01(1 - (vis.sil ?? 1)) * ss(0.02, 0.2, f.mouth.speak ?? 0) : 0;
    const e = this.env('engage', engTarget > 0.05 ? 1 : 0, dt, 0.05, 0.35);
    this.last = { vis: vis ?? null, ctl: {}, engage: e, out: {} };
    if (!vis || e < 0.005) {
      if (this.rawDirty) { this.idle(); this.rawDirty = false; }
      for (const k of ARTIC) this.st[k] = 0;
      this.st.jaw = f.mouth.open; this.st.jaw_d = 0;
      if (this.caps.style === 'wideCartoon') return { frame: this.wideCamera(f, face, dt), extras };
      if (this.caps.roundOpens) return { frame: roundCamera(f, face), extras };
      return { frame: { ...f, face }, extras };
    }

    // ---- articulator targets from the viseme mix (shape normalised by the speech mass)
    const mass = Math.max(1e-3, 1 - (vis.sil ?? 0));
    const T: Record<Artic, number> = { round: 0, spread: 0, tongueUp: 0, tongueTip: 0, vowelOpen: 0, seal: 0, tuck: 0, teeth: 0 };
    for (const v of VISEMES) {
      const w = vis[v] ?? 0;
      if (w <= 0 || v === 'sil') continue;
      const a = ARTIC_T[v];
      for (const k in a) T[k as Artic] += (w / Math.max(mass, 0.3)) * (a[k as Artic] ?? 0);
    }
    // closures are CATEGORICAL: only a clearly dominant class seals / tucks / clenches (kills flicker)
    const share = (v: Viseme) => (vis[v] ?? 0) / mass;
    // …or the voice's own lip-closure detector (formants collapse while the hum goes on: M/B/P) when it
    // is decisive — running speech often splits an M between PP and a neighbouring vowel class
    T.seal = Math.max(ss(0.25, 0.45, share('PP')), ss(0.4, 0.75, f.mouth.closure ?? 0) * (1 - ss(0.3, 0.6, share('FF') + share('SS') + share('CH'))));
    T.tuck = ss(0.28, 0.5, share('FF'));
    T.teeth = ss(0.25, 0.5, share('SS') + share('CH') * 0.9 + share('DD') * 0.4);
    // emotion: a smiling mouth talks wider and less puckered; the smile itself is never touched
    const happyK = ss(0.2, 0.7, emo.happy), angryK = ss(0.2, 0.7, emo.angry);
    T.round *= 1 - 0.35 * happyK;
    T.spread = Math.min(1, T.spread + 0.25 * happyK);
    // ---- GPU lip sync (Audio2Face-3D, src/tracking/a2fMerge.ts): its continuous mouth steers the articulators;
    // the engine's categorical seal / tuck only ever get stronger (max), never weaker
    const A = readA2f(f), ak = A.k;
    const ag = A.ch;
    const jawA = ag('jawOpen');
    if (ak > 0) {
      const press = (ag('mouthPressLeft') + ag('mouthPressRight')) / 2;
      const sealA = ss(A2F_SEAL[0], A2F_SEAL[1], press + 0.5 * ag('mouthClose') + 0.3 * ag('mouthRollUpper')) * ss(0.3, 0.1, jawA);
      const tuckA = ss(A2F_TUCK[0], A2F_TUCK[1], ag('mouthRollLower') + 0.3 * ag('mouthShrugLower') - A2F_TUCK[2] * press) * ss(0.35, 0.12, jawA);
      T.seal = Math.max(T.seal, ak * sealA * (1 - tuckA));
      T.tuck = Math.max(T.tuck, ak * tuckA);
      const lerp = (x: number, y: number, k: number) => x + (y - x) * k;
      // rounding / spreading: A2F adds the continuous in-between shapes, the categorical vowels keep their contrast
      const rA = Math.max(ag('mouthPucker'), ag('mouthFunnel')), sA = (ag('mouthStretchLeft') + ag('mouthStretchRight')) / 2;
      T.round = Math.max(T.round, rA * ak * (1 - 0.6 * sA));
      T.spread = Math.max(T.spread, sA * ak * (1 - 0.6 * rA));
      T.vowelOpen = lerp(T.vowelOpen, jawA, ak * 0.5);
    }
    // ---- envelopes: attack ~35 ms, release ~70 ms; the lip seal snaps (25 ms) and holds ≥ 60 ms
    const round = this.env('round', T.round, dt, 0.04, 0.08);
    const spread = this.env('spread', T.spread, dt, 0.04, 0.08);
    const vOpen = this.env('vowelOpen', T.vowelOpen, dt, 0.035, 0.07);
    const tongueUp = this.env('tongueUp', T.tongueUp, dt, 0.04, 0.07);
    const tongueTip = this.env('tongueTip', T.tongueTip, dt, 0.035, 0.07);
    const tuck = this.env('tuck', T.tuck, dt, 0.03, 0.06);
    const teeth = this.env('teeth', T.teeth, dt, 0.03, 0.06);
    if (T.seal > 0.5) this.sealHold = 0.06; else this.sealHold -= dt;
    const seal = this.env('seal', this.sealHold > 0 ? Math.max(T.seal, this.st.seal ?? 0) : T.seal, dt, 0.025, 0.05);
    // ---- loudness sets the SIZE: the mouth summary's open (voice envelope + camera, tuned for syllable
    // timing), re-shaped by what's being said
    const I = this.caps.intensity;
    const m = { ...f.mouth };
    // (A2F's jaw has the syllable timing of a real face: closes on consonants inside words)
    const loud = clamp01(ak > 0 ? m.open + (Math.min(1, jawA * 1.1) - m.open) * ak * 0.6 : m.open);
    // a short drop of the VOICE inside speech (the silent hold of a P / B / T / K, a breath between words)
    // brings the lips together — relaxed, not pressed — whatever the (late) camera still shows
    const voice = f.mouth.speak ?? 0;
    // (…but not between the "ha"s of a laugh: the mouth stays open — speechFusion / vocalGestures.ts)
    const laughK = f.mouth.laugh ?? 0;
    const rest = this.env('rest', Math.max(ss(0.16, 0.05, voice), f.mouth.gap ?? 0) * (1 - laughK), dt, 0.018, 0.012);
    const shapeK = 0.55 + 0.6 * vOpen;                         // "aa" opens most, "ee"/"oo" less
    let open = loud * shapeK * (1 - seal) * (1 - 0.8 * tuck) * (1 - 0.55 * teeth) * (1 - rest);
    // per-avatar jaw opening per viseme (profile.mouth.rules.visemeOpen: a wide cartoon mouth's small "I", big "aa")
    const isWide = this.caps.style === 'wideCartoon';
    // (a wide cartoon mouth without its own table gets WIDE_VISEME_OPEN)
    const rules = this.inp.profile.mouth.rules;
    open *= visemeOpenScale(isWide && !rules?.visemeOpen ? { ...rules, visemeOpen: WIDE_VISEME_OPEN } : rules, vis);
    // rounded vowels / W: a small jaw — the rounded lips make the "o" (on wide mouths a jaw drop turns
    // every OO into a full-width letterbox)
    const rr = Math.min(1, round * 1.3);                       // a dominant OO / W reads fully rounded
    open *= this.caps.roundOpens ? 1 - rr : 1 - 0.7 * rr * (1 - 0.5 * vOpen);
    // L / TH keep a visible gap for the tongue even when quiet
    open = Math.max(open, (tongueUp * 0.3 + tongueTip * 0.16) * (1 - seal) * ss(0.03, 0.2, loud + e * 0.2));
    if (angryK > 0) open *= 1 + 0.15 * angryK * ss(0.3, 0.7, loud);
    // shouting: a bigger jaw than everyday talk (the voice envelope itself saturates at the usual level)
    if (f.mouth.loud) open *= 1 + 0.18 * f.mouth.loud;
    if (laughK > 0) open = Math.max(open, 0.24 * laughK);
    if (this.caps.jaw?.kind === 'puppet') open *= 1.08;
    // modelled teeth but no lower-lip roll (jaw-rig faces): a hair of jaw shows the teeth on the lip for F
    const teethGap = !this.caps.procedural && this.inp.profile.mouth.showTeeth && !this.has.has('mouthRollLower') ? tuck * 0.1 + teeth * 0.05 : 0;
    open = Math.max(open, teethGap);
    // the jaw itself — syllables read as open/close beats
    // anime beat: contrast curve — the tail of a syllable closes fully, vowel peaks open a bit further
    const beat = Math.pow(clamp01((open - 0.06) / 0.84), 0.85);
    // (the voice envelope is already smoothed upstream — only a light de-jitter here, or closures land late)
    // One-Euro: slow wobble is smoothed hard (≈4 Hz), real strokes pass with ~no lag (cutoff rises with speed)
    let jaw = this.euro('jaw', Math.min(0.95, Math.max(beat, teethGap)), dt, 3.5, 1.6);
    // wide cartoon: everyday talk uses part of the gape; shouts, laughs and held openings get the rest
    if (isWide) jaw = softCap(jaw, this.jawCap(jaw, dt, Math.max(f.mouth.loud ?? 0, laughK)));
    const mix = (cur: number, v: number) => cur * (1 - e) + v * e;
    m.open = clamp01(mix(m.open, jaw));
    // shapes, clamped against each other: rounding and spreading can't both win
    let pucker = rr * 0.95 * I * (1 - 0.5 * vOpen);
    let funnel = rr * 0.85 * I * (0.35 + 0.65 * vOpen);
    if (this.caps.roundOpens) {
      // one clean oval at a time: small "o" (U / W / SH / R) → pucker, big "O" (OH) → funnel
      const fs = ss(0.35, 0.62, vOpen);
      pucker = rr * I * (1 - fs); funnel = rr * I * fs;
    }
    let wide = spread * 0.9 * I * (1 - rr);
    // wide cartoon: rounding is the corners pressing in (no protruding snout), spreading needs no stretch
    let zip = 0;
    if (this.caps.style === 'wideCartoon') { zip = clamp01(Math.max(pucker, funnel)); pucker *= 0.15; funnel *= 0.15; wide = 0; }
    const rs = pucker + wide;
    if (rs > 1) { pucker /= rs; wide /= rs; }
    funnel = Math.min(funnel, 1.05 - pucker * 0.5);
    // a seal wins over rounding / spreading: pucker keeps a hint of protrusion, the funnel's "O" closes
    pucker *= 1 - 0.85 * seal; funnel *= 1 - 0.95 * seal; wide *= 1 - 0.7 * seal;
    // between syllables (voice nearly gone) the lips come together: the rounding's "o" follows the voice
    const voiceK = ss(0.03, 0.16, loud) * (1 - rest);
    pucker *= this.caps.roundOpens ? voiceK : 0.3 + 0.7 * voiceK; funnel *= voiceK;
    // shapes that open the lips themselves must shut completely on a seal (not just ease)
    if (this.caps.roundOpens) {
      const k = 1 - Math.min(1, seal * 1.8); pucker *= k; funnel *= k;
      // a weak rounding is a half-gathered lens (the pinched look) and still parts the lips: only a clear
      // rounding shows, and then as (nearly) the full oval
      pucker = ss(0.25, 0.7, pucker) * I; funnel = ss(0.25, 0.7, funnel) * I;
    }
    m.pucker = clamp01(mix(m.pucker, pucker));
    m.funnel = clamp01(mix(m.funnel, funnel));
    m.wide = clamp01(mix(m.wide, wide));
    m.fv = clamp01(mix(m.fv ?? 0, tuck) * (1 - seal));
    m.sib = clamp01(mix(m.sib ?? 0, teeth) * (1 - seal) * (1 - tuck * 0.8));
    m.closure = clamp01(mix(m.closure ?? 0, seal));
    // the tongue never shows through sealed / tucked lips, and never further out than the jaw allows
    const tongueRoom = (1 - seal) * (1 - tuck) * ss(0.02, 0.15, m.open + tongueTip * 0.1);
    extras.tongueUp = tongueUp * e * tongueRoom * (1 - round * 0.6);
    extras.tongueTip = tongueTip * e * (1 - seal) * (1 - tuck) * (1 - round * 0.8);
    extras.bulge = seal * e * 0.6;
    m.tongue = Math.min(m.tongue, 0.2 + m.open * 1.2);

    // ---- the model's own ARKit shapes (perfect sync or partial): speech shapes + substitutes, clamped
    const has = (k: string) => this.has.has(k);
    const put = (k: string, v: number) => { face[k] = clamp01(mix(face[k] ?? 0, v)); };
    const both = (k: string, v: number) => { put(k + 'Left', v); put(k + 'Right', v); };
    put('jawOpen', m.open);
    put('mouthPucker', m.pucker); put('mouthFunnel', m.funnel);
    both('mouthStretch', m.wide);
    put('mouthClose', seal * 0.6 * (1 - m.open));                 // mouthClose on an open jaw tears the lips apart
    put('mouthRollLower', has('mouthRollLower') ? tuck * 0.8 * I : 0);
    put('mouthRollUpper', seal * 0.3 * I);
    put('mouthShrugLower', tuck * 0.35 * I);
    both('mouthPress', Math.max((seal * 0.85 + (has('mouthRollLower') ? 0 : tuck * 0.5)) * I * (1 - m.open), zip * 0.55 * I * (1 - seal)));
    both('mouthUpperUp', ((teeth * 0.2 + tuck * 0.3) * I + angryK * 0.35 * ss(0.2, 0.6, m.open)) * (1 - seal));
    both('mouthLowerDown', vOpen * 0.3 * m.open * I * (1 - seal) * (1 - rest));
    if (has('tongueOut')) put('tongueOut', Math.min(extras.tongueTip * 0.3, m.open * 0.8));
    if (!has('mouthPucker') && has('mouthFunnel')) put('mouthFunnel', Math.max(m.funnel, m.pucker));
    // A2F's fine lip detail on perfect-sync / partial ARKit faces (the shapes the articulators don't own)
    if (ak > 0) {
      for (const c of A2F_DETAIL) {
        if (!has(c)) continue;
        const cur = face[c] ?? 0, v = clamp01(cur + (ag(c) * (1 - seal) - cur) * ak * e);
        // the rig's upper-lip lift shows the teeth on an F / S: A2F may add to it, not take it away
        face[c] = c.startsWith('mouthUpperUp') ? Math.max(cur, v) : v;
      }
      // A2F's tongue, eyes and upper face (docs/GPU_TRACKING.md). The bus makes them camera-aware: the upper face may only
      // RAISE what the camera sees (35 %), the eye look is used only while the camera has lost the performer, and the
      // tongue is A2F's alone (the camera can't see it). Only the shapes this model has.
      for (const c of A2F_UPPER) if (has(c)) face[c] = Math.max(face[c] ?? 0, clamp01(A.extra(c) * ak * e));
      for (const c of A2F_EYES) if (has(c)) face[c] = Math.max(face[c] ?? 0, clamp01(A.extra(c) * ak * e));
      if (has('tongueOut')) face.tongueOut = Math.max(face.tongueOut ?? 0, clamp01(A.extra('tongueOut') * ak * e));
      extras.tongueUp = Math.max(extras.tongueUp, clamp01(A.extra('tongueUp') * ak * e) * (1 - seal) * (1 - tuck));
      extras.tongueTip = Math.max(extras.tongueTip, clamp01(A.extra('tongueTipUp') * ak * e) * (1 - seal) * (1 - tuck));
    }
    if (angryK > 0) for (const s of ['Left', 'Right']) face['noseSneer' + s] = Math.max(g('noseSneer' + s), angryK * 0.4 * ss(0.2, 0.6, m.open));
    face.cheekPuff = Math.max(g('cheekPuff'), extras.bulge * 0.3);
    // smiles / frowns belong to the emotion — untouched (the camera's values pass through)

    // ---- preset-only faces (VRM A/I/U/E/O, VRChat / MMD visemes), from the SAME smoothed articulators
    let vowels: Record<string, number> | undefined;
    let emotionCap: Record<string, number> | undefined;
    // (perfect-sync faces are driven through their ARKit shapes only — adding presets on top double-deforms)
    if ((this.caps.vrmVowels || this.caps.namedVowels) && !this.caps.perfectSync) {
      const o = ss(0.02, 0.5, m.open);                             // (the close / small raw shapes below follow the jaw stroke)
      // presets are additive blendshapes: the shared bus formula caps the total (shared/lipBus.ts)
      vowels = vrmPresetsFromArticulators({ open: m.open, round, spread, teeth, tuck, seal }, I * e);
      this.setRaw(this.fcl.get('mth_close'), seal * 0.8 * e);
      this.setRaw(this.fcl.get('mth_small'), round * 0.4 * e * (1 - o * 0.5));
      this.rawDirty = true;
      if (this.caps.mouthBlockers.length) {
        emotionCap = {};
        const vrmName: Record<string, string> = { happy: 'joy', angry: 'angry', sad: 'sorrow', surprised: 'surprised' };
        for (const n of this.caps.mouthBlockers) {
          emotionCap[n] = 1 - 0.7 * e;
          const key = vrmName[n];
          const w = (emo as unknown as Record<string, number>)[n] ?? 0;
          if (key) { this.setRaw(this.eyePart.get('eye_' + key), w * 0.7 * e); this.setRaw(this.eyePart.get('brw_' + key), w * 0.7 * e); }
        }
      }
    }
    this.last.out = { jaw: m.open, round, spread, seal, rest, tuck, teeth, tongueUp: extras.tongueUp, tongueTip: extras.tongueTip, pucker: m.pucker, wide: m.wide };
    return { frame: { ...f, face, mouth: m }, extras, vowels, emotionCap };
  }

  /** Jaw ceiling for a wide cartoon mouth: rules.speechJaw (default 0.55) for everyday talk, up to the full gape for a
   *  loud voice / laugh (`boost` 0..1) or an opening held ≥ ~0.4 s (a held "aah", a gasp). */
  private jawCap(open: number, dt: number, boost: number) {
    const sj = this.inp.profile.mouth.rules?.speechJaw;
    const base = typeof sj === 'number' && Number.isFinite(sj) ? Math.min(1, Math.max(0.2, sj)) : 0.55;
    const held = this.env('held', open > base * 0.8 ? 1 : 0, dt, 0.45, 0.12);
    return base + (1 - base) * Math.max(ss(0.15, 0.7, boost), ss(0.6, 0.95, held));
  }

  /** Camera-only frame on a wide cartoon mouth: the same jaw ceiling and the corners-press rounding. */
  private wideCamera(f: TrackingFrame, face: Record<string, number>, dt: number): TrackingFrame {
    const m = f.mouth;
    const open = softCap(clamp01(m.open), this.jawCap(clamp01(m.open), dt, m.loud ?? 0));
    const k = m.open > 1e-4 ? open / m.open : 1;
    const zip = clamp01(Math.max(face.mouthPucker ?? 0, face.mouthFunnel ?? 0));
    const out: Record<string, number> = { ...face, jawOpen: (face.jawOpen ?? 0) * k, mouthPucker: (face.mouthPucker ?? 0) * 0.15, mouthFunnel: (face.mouthFunnel ?? 0) * 0.15,
      mouthStretchLeft: (face.mouthStretchLeft ?? 0) * 0.3, mouthStretchRight: (face.mouthStretchRight ?? 0) * 0.3 };
    for (const sd of ['Left', 'Right']) out['mouthPress' + sd] = Math.max(face['mouthPress' + sd] ?? 0, zip * 0.55);
    return { ...f, face: out, mouth: { ...m, open, pucker: m.pucker * 0.15, funnel: m.funnel * 0.15, wide: m.wide * 0.3 } };
  }

  /** Articulator + envelope state. */
  private st: Record<string, number> = {};
  private sealHold = 0;
  private rawDirty = false;
  /** One-Euro filter (minCutoff Hz, beta per unit/s of speed): low jitter at rest, low lag on fast moves. */
  private euro(k: string, x: number, dt: number, minCut: number, beta: number) {
    const prev = this.st[k] ?? x, dPrev = this.st[k + '_d'] ?? 0;
    const a = (cut: number) => 1 / (1 + 1 / (2 * Math.PI * cut * dt));
    const d = dPrev + a(8) * ((x - prev) / dt - dPrev);
    const v = prev + a(minCut + beta * Math.abs(d)) * (x - prev);
    this.st[k] = v; this.st[k + '_d'] = d;
    return v;
  }

  /** One-pole envelope with separate attack / release time constants (seconds). */
  private env(k: string, target: number, dt: number, attack: number, release: number) {
    const cur = this.st[k] ?? 0;
    const tau = target > cur ? attack : release;
    const v = cur + (target - cur) * (1 - Math.exp(-dt / tau));
    this.st[k] = v;
    return v;
  }

  /** Zero the raw shapes we drive when speech stops (they're not reset by anyone else). */
  idle() {
    for (const ts of [...this.fcl.values(), ...this.eyePart.values()]) this.setRaw(ts, 0);
  }

  private setRaw(ts: Target[] | undefined, v: number) {
    if (!ts) return;
    for (const t of ts) if (t.mesh.morphTargetInfluences) t.mesh.morphTargetInfluences[t.index] = v;
  }
}

/** A2F → seal: press + close + upper roll between these (after the gains in a2fMerge.ts); tuck: lower roll + shrug
 *  − k·press between [0], [1] (k = [2]: a press is a seal's, not an F's). Calibrated with tools/eval_a2f.ts. */
const A2F_SEAL: [number, number] = [0.35, 0.65];
const A2F_TUCK: [number, number, number] = [0.3, 0.6, 0.5];
const A2F_DETAIL = ['mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthShrugUpper', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthLeft', 'mouthRight', 'mouthRollUpper'];
type Artic = 'round' | 'spread' | 'tongueUp' | 'tongueTip' | 'vowelOpen' | 'seal' | 'tuck' | 'teeth';
const ARTIC: Artic[] = ['round', 'spread', 'tongueUp', 'tongueTip', 'vowelOpen', 'seal', 'tuck', 'teeth'];
/** Articulator targets per viseme (seal / tuck / teeth are decided categorically, see apply). */
const ARTIC_T: Record<Viseme, Partial<Record<Artic, number>>> = {
  sil: {},
  PP: { vowelOpen: 0 },
  FF: { vowelOpen: 0.05 },
  TH: { vowelOpen: 0.25, tongueTip: 1, spread: 0.2 },
  DD: { vowelOpen: 0.2, tongueUp: 0.5, spread: 0.25 },
  kk: { vowelOpen: 0.35, spread: 0.15 },
  CH: { vowelOpen: 0.1, round: 0.7 },
  SS: { vowelOpen: 0.08, spread: 0.6 },
  nn: { vowelOpen: 0.15, tongueUp: 0.7 },
  RR: { vowelOpen: 0.35, round: 0.6 },
  L: { vowelOpen: 0.5, tongueUp: 1, spread: 0.1 },
  W: { vowelOpen: 0.1, round: 1 },
  aa: { vowelOpen: 1, spread: 0.1 },
  E: { vowelOpen: 0.6, spread: 0.5 },
  I: { vowelOpen: 0.35, spread: 0.85 },
  O: { vowelOpen: 0.7, round: 0.75 },
  U: { vowelOpen: 0.3, round: 0.9 },
};

/** Camera-only frames on a model whose rounded shapes open the lips: pucker + funnel never stack past one full
 *  shape (their gathers would cross the lips), and a rounded mouth keeps the jaw nearly shut (the "o" is the
 *  shape's own opening; a jaw drop would turn it into a full-width letterbox). */
function roundCamera(f: TrackingFrame, face: Record<string, number>): TrackingFrame {
  const pk = clamp01(face.mouthPucker ?? 0), fn = clamp01(face.mouthFunnel ?? 0);
  const sum = pk + fn;
  if (sum < 0.02) return { ...f, face };
  const k = sum > 1 ? 1 / sum : 1;
  const out = { ...face, mouthPucker: pk * k, mouthFunnel: fn * k };
  const round = Math.min(1, sum);
  return { ...f, face: out, mouth: { ...f.mouth, open: f.mouth.open * (1 - 0.85 * ss(0.15, 0.6, round)) } };
}
