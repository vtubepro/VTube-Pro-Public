// Per-avatar mouth behaviour rules (profile.mouth.rules, shared/types.ts MouthRules): small, generic character
// touches on top of the tracked / voice-driven face, all optional and off when unset.
//   cornerBias  a resting smile (or frown) for avatars with their own smile / frown shapes — a content character keeps a
//               hint of a smile while it talks; a real smile / frown from the camera still goes all the way.
//   visemeOpen  jaw opening per speech viseme (×): a very wide cartoon mouth reads better with a small "I" / "E" and a big
//               "aa" (applied by the viseme rig, src/avatar/visemeRig.ts, through visemeOpenScale()).
//   puff        a shape that swells with LOUD speech (a frog's throat sac, puffed cheeks) and, optionally, a slow idle
//               breathing pulse while quiet. The shape is the model's own morph (any name, e.g. 'throatPuff') or an ARKit
//               channel ('cheekPuff'); driven from the voice envelope the frame already carries (mouth.loud / open /
//               speak), so it is the same on the studio, OBS and party pages. No mic = only the idle pulse.
import * as THREE from 'three';
import type { MouthRules, TrackingFrame } from '../../shared/types.ts';
import { ARKIT_BY_NORM, normKey } from '../core/arkit.ts';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ss = (e0: number, e1: number, x: number) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

/** Morph names that ARE a voice puff by convention: a model that has one gets the puff rule with no setup. */
export const AUTO_PUFF_RE = /^(throat_?puff|throat_?sac|vocal_?sac)$/i;

/** The rules an avatar runs with: its profile's, plus the automatic defaults (zero setup): a model with a morph named
 *  like a throat / vocal sac (AUTO_PUFF_RE) swells it on loud speech + a slow idle pulse unless the profile sets its own
 *  `puff` (or `puff: null` to switch it off). Null = nothing to do. */
export function effectiveMouthRules(r: MouthRules | undefined | null, model?: THREE.Object3D | null): MouthRules | null {
  const out: MouthRules = { ...(r ?? {}) };
  if (out.puff === undefined && model) {
    let name: string | null = null;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (name || !m.isMesh || !m.morphTargetDictionary || m.userData.vtpGenerated || m.userData.vtpOutline) return;
      name = Object.keys(m.morphTargetDictionary).find((n) => AUTO_PUFF_RE.test(n)) ?? null;
    });
    if (name) out.puff = { shape: name, amount: 0.6, threshold: 0.45, idle: 0.15 };
  }
  if (!out.puff) delete out.puff;
  return Object.keys(out).length ? out : null;
}

/** The puff rule's settings with defaults filled in (null = no puff). */
export function puffSettings(r: MouthRules | undefined | null) {
  const p = r?.puff;
  if (!p || typeof p.shape !== 'string' || !p.shape) return null;
  return {
    shape: p.shape,
    amount: num(p.amount, 0.8, 0, 1),
    threshold: num(p.threshold, 0.5, 0, 0.95),
    attack: num(p.attack, 0.08, 0.005, 2),
    release: num(p.release, 0.35, 0.005, 5),
    idle: num(p.idle, 0, 0, 1),
    idleRate: num(p.idleRate, 0.35, 0.02, 3),
    plosive: num(p.plosive, 0, 0, 1),
  };
}

/** Jaw-opening factor for the current viseme mix: the weighted mean of the rule's per-viseme factors (1 where unset).
 *  `vis` = viseme weights (sil ignored); 1 when there is no rule or no speech. */
export function visemeOpenScale(r: MouthRules | undefined | null, vis: Record<string, number> | undefined | null): number {
  const t = r?.visemeOpen;
  if (!t || !vis) return 1;
  let sw = 0, s = 0;
  for (const [v, w] of Object.entries(vis)) {
    if (v === 'sil' || !(w > 0)) continue;
    sw += w; s += w * num(t[v], 1, 0, 2);
  }
  return sw > 1e-4 ? s / sw : 1;
}

/** How loud the frame's voice is for the puff, 0..1: the "louder than usual" detector, or a strong syllable peak. */
export function puffLoudness(m: TrackingFrame['mouth']): number {
  return clamp01(Math.max(m.loud ?? 0, clamp01(m.open) * clamp01(m.speak ?? 0) * 0.75));
}

export class MouthRulesDriver {
  private puffV = 0;
  private t = 0;
  /** M / B / P release pulse: the lips part after a seal → a quick swell of the sac (1 → 0 over ~0.15 s) */
  private pop = 0;
  private sealed = false;
  private morphs: { mesh: THREE.Mesh; index: number }[] = [];
  /** the puff shape is an ARKit channel (written into frame.face) rather than a raw morph */
  private channel: string | null = null;
  /** last values (debug / tests) */
  last = { puff: 0, bias: 0, loud: 0 };

  constructor(readonly rules: MouthRules, model?: THREE.Object3D) {
    const p = puffSettings(rules);
    if (!p) return;
    this.channel = ARKIT_BY_NORM.get(normKey(p.shape)) ?? null;
    if (this.channel || !model) return;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.morphTargetDictionary || m.userData.vtpGenerated || m.userData.vtpOutline) return;
      const i = m.morphTargetDictionary[p.shape];
      if (i !== undefined) this.morphs.push({ mesh: m, index: i });
    });
  }

  /** Does this avatar have anything to do? */
  get active() { return !!puffSettings(this.rules) || !!this.rules.cornerBias; }

  /** Face-channel part (call after the viseme rig / speech motion, before the expression driver). */
  apply(f: TrackingFrame, dt: number): TrackingFrame {
    dt = Math.min(0.1, Math.max(1e-3, dt));
    this.t += dt;
    let face = f.face;
    const bias = num(this.rules.cornerBias, 0, -1, 1);
    if (bias) {
      face = { ...face };
      for (const s of ['Left', 'Right']) {
        const sm = face['mouthSmile' + s] ?? 0, fr = face['mouthFrown' + s] ?? 0;
        // the bias gives way to the opposite expression (a resting smile doesn't fight a real frown)
        if (bias > 0) face['mouthSmile' + s] = clamp01(sm + bias * (1 - clamp01(fr * 2)));
        else face['mouthFrown' + s] = clamp01(fr - bias * (1 - clamp01(sm * 2)));
      }
    }
    const p = puffSettings(this.rules);
    let puff = 0;
    if (p) {
      const loud = puffLoudness(f.mouth);
      const talking = ss(0.05, 0.3, f.mouth.speak ?? 0);
      const target = p.amount * ss(p.threshold, Math.min(1, p.threshold + 0.4), loud);
      const idle = p.idle * (1 - talking) * Math.pow(0.5 + 0.5 * Math.sin(this.t * p.idleRate * 2 * Math.PI), 2);
      // a bilabial release (the seal opening again) pops the sac a little — a very froggy read of every M / B / P
      const clo = f.mouth.closure ?? 0;
      if (clo > 0.5) this.sealed = true;
      else if (this.sealed && clo < 0.3) { this.sealed = false; this.pop = 1; }
      this.pop *= Math.exp(-dt / 0.06);
      const goal = Math.max(target, idle, p.amount * p.plosive * this.pop);
      const tau = goal > this.puffV ? p.attack : p.release;
      this.puffV += (goal - this.puffV) * (1 - Math.exp(-dt / tau));
      puff = this.puffV;
      if (this.channel) {
        if (face === f.face) face = { ...face };
        face[this.channel] = Math.max(face[this.channel] ?? 0, clamp01(puff));
      }
      this.last.loud = loud;
    }
    this.last.puff = puff;
    this.last.bias = bias;
    return face === f.face ? f : { ...f, face };
  }

  /** Raw-morph part (call after the expression driver has written the model's own shapes). */
  applyMorphs(resting = false) {
    const v = resting ? 0 : clamp01(this.puffV);
    for (const t of this.morphs) if (t.mesh.morphTargetInfluences) t.mesh.morphTargetInfluences[t.index] = v;
  }
}
