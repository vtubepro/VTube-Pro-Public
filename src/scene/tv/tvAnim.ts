// Walking-TV animation: the pose state the runtime computes each frame (from the scene actor: walking speed, seat
// blend, voice level, one-shot reactions) and the two animators that turn it into a pose — the grey-box's procedural
// one (tvGreybox.ts) and the clip player for the tvart GLB (named clips, S\tv\CONTRACT.md).
import * as THREE from 'three';

export const TV_CLIPS = ['idle', 'idle_bored', 'walk', 'run', 'sit_down', 'sit_idle', 'stand_up', 'wave', 'talk_gesture', 'laugh', 'react_shock', 'clap', 'point', 'shrug', 'enter_hop', 'exit_wave', 'static_glitch', 'tumble'] as const;
export type TvClip = typeof TV_CLIPS[number];
/** Reactions other code may trigger (tvReact). */
export const TV_REACTIONS = ['wave', 'laugh', 'react_shock', 'clap', 'point', 'shrug', 'tumble', 'static_glitch', 'enter_hop', 'exit_wave'] as const;
export type TvReaction = typeof TV_REACTIONS[number];
/** One-shot lengths (s) for the procedural animator (clips use their own). */
export const SHOT_LEN: Record<TvReaction, number> = { wave: 1.8, laugh: 1.6, react_shock: 1.1, clap: 1.8, point: 1.4, shrug: 1.3, tumble: 2.4, static_glitch: 0.7, enter_hop: 0.8, exit_wave: 1.4 };

export interface TvPoseState {
  /** 0..1 walking amount, stride phase in cycles (distance / stride length), running. */
  gait: number; stride: number; run: boolean; speed: number;
  /** 0 standing … 1 seated (the scene's seat blend). */
  sit: number; sitDir: -1 | 0 | 1;
  /** 0..1 talking (voice level, gated + smoothed). */
  talk: number;
  bored: boolean;
  airborne: boolean;
  /** 'lively' = the original bouncy motion; calm (default) = subtle idle, small bob, soft antennas. */
  lively: boolean;
  /** Current one-shot: name, seconds in, blend weight 0..1. */
  shot: { name: TvReaction; t: number; w: number } | null;
}

/** Lively = calm × this (≈ 2× the calm motion, 1.5× the clips as authored). */
const LIVELY = 2;
/** Reaction clips authored as loops (played for SHOT_LEN, wrapping). */
const LOOPED = new Set(['laugh', 'clap', 'static_glitch']);

export interface TvAnimator { update(dt: number, s: TvPoseState): void; dispose(): void }

/** tvart GLB: named clips on an AnimationMixer, blended by the pose state. */
export class ClipTvAnimator implements TvAnimator {
  private mixer: THREE.AnimationMixer;
  private acts = new Map<string, THREE.AnimationAction>();
  /** Calm motion: the body / hips / head / antenna bones' deviation from their reference pose is scaled down after the
   *  mixer runs (softer bob, sway and antenna wobble without touching the clips). */
  private calmBones: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; k: number }[] = [];
  private calmReady = false;
  constructor(private root: THREE.Object3D, clips: THREE.AnimationClip[], private walkSpeed: number, private runSpeed: number) {
    this.mixer = new THREE.AnimationMixer(root);
    for (const c of clips) {
      const a = this.mixer.clipAction(c);
      a.enabled = true; a.setEffectiveWeight(0); a.play();
      if (['sit_down', 'stand_up', ...Object.keys(SHOT_LEN)].includes(c.name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.paused = true; }
      this.acts.set(c.name, a);
    }
  }
  private w(name: string, v: number) { const a = this.acts.get(name); if (a) a.setEffectiveWeight(v); return a; }
  update(dt: number, s: TvPoseState) {
    for (const a of this.acts.values()) a.setEffectiveWeight(0);
    const shotW = s.shot ? s.shot.w : 0;
    const base = 1 - shotW;
    const mid = s.sit > 0.02 && s.sit < 0.98;
    if (mid) {
      const clip = s.sitDir < 0 && this.acts.has('stand_up') ? 'stand_up' : 'sit_down';
      const a = this.w(clip, base);
      if (a) a.time = a.getClip().duration * (clip === 'stand_up' ? 1 - s.sit : s.sit);
    } else if (s.sit >= 0.98) {
      const tk = s.talk * (s.lively ? 0.5 : 0.25);
      this.w('sit_idle', base * (1 - tk));
      if (tk > 0.01) this.w('talk_gesture', base * tk);
    } else {
      const g = s.gait;
      const walk = this.w(s.run && this.acts.has('run') ? 'run' : 'walk', base * g);
      if (walk) walk.timeScale = Math.min(3, s.speed / Math.max(0.05, s.run ? this.runSpeed : this.walkSpeed));    // feet planted (tvart: clip speed per skin)
      const still = base * (1 - g);
      const tk = s.talk * (s.lively ? 1 : 0.45);            // calm: gestures stay small
      this.w(s.lively && s.bored && this.acts.has('idle_bored') ? 'idle_bored' : 'idle', still * (1 - tk));
      this.w('talk_gesture', still * tk);
    }
    if (s.shot) { const a = this.w(s.shot.name, shotW); if (a) { const d = a.getClip().duration; a.paused = true; a.time = LOOPED.has(s.shot.name) ? s.shot.t % d : Math.min(d, s.shot.t); } }
    this.mixer.update(dt);
    if (!this.calmReady) this.captureCalm();
    // calm: scale the big bones' motion (bob, sway, antenna wobble) down a little; lively: up (tvart's v2 clips are
    // already near-still) — never during reactions (they keep their authored punch)
    {
      const k0 = 1 - shotW;
      for (const b of this.calmBones) {
        const f = s.lively ? b.k * LIVELY : b.k;
        const k = 1 - (1 - f) * k0;
        b.o.position.lerpVectors(b.p, b.o.position, k);
        const cur = b.o.quaternion.clone();
        b.o.quaternion.copy(b.q).slerp(cur, k);
      }
    }
  }
  /** Reference pose = the `idle` clip's first frame (sampled once). */
  private captureCalm() {
    this.calmReady = true;
    const idle = this.acts.get('idle');
    if (!idle) return;
    const keep = [...this.acts.values()].map((a) => [a, a.getEffectiveWeight(), a.time] as const);
    for (const a of this.acts.values()) a.setEffectiveWeight(0);
    idle.setEffectiveWeight(1); idle.time = 0;
    this.mixer.update(0);
    const scale: [RegExp, number][] = [[/^TV_HIPS/, 0.75], [/^TV_BODY/, 0.75], [/^TV_HEAD/, 0.75], [/^TV_ANTENNA_[LR](_TIP)?/, 0.5], [/^TV_ARM_UP/, 0.9]];
    this.root.traverse((o) => {
      const m = scale.find(([re]) => re.test(o.name));
      if (m) this.calmBones.push({ o, p: o.position.clone(), q: o.quaternion.clone(), k: m[1] });
    });
    for (const [a, w, t] of keep) { a.setEffectiveWeight(w); a.time = t; }
  }
  clipLength(name: string): number | null { return this.acts.get(name)?.getClip().duration ?? null; }
  dispose() { this.mixer.stopAllAction(); }
}
