// 2D avatars: "When I talk" — what the picture does while the performer speaks. One talk-picture swap (image sets; rigged
// kinds use their own mouth) plus any number of motions, scaled by how loud the voice is (capped), with a strength and a
// speed, and per-expression overrides ("angry" shakes instead of hopping). Computed here for every kind alike; the
// display side (src/avatar/flat/FlatAvatar.ts) applies the result on top of the kind's own picture. Pure: tests in
// tools/flat_unit.ts. Saved per avatar in profile.flat.talk.

export const TALK_MOTIONS = ['hop', 'squash', 'wobble', 'shake', 'pulse', 'lean', 'nod', 'glow', 'brighten', 'sparkle'] as const;
export type TalkMotion = typeof TALK_MOTIONS[number];
export const TALK_MOTION_LABEL: Record<TalkMotion, string> = {
  hop: 'Hop', squash: 'Squash and stretch', wobble: 'Wobble', shake: 'Shake', pulse: 'Pulse bigger', lean: 'Lean forward',
  nod: 'Nod', glow: 'Glow', brighten: 'Brighten (others dim)', sparkle: 'Sparkles',
};

export interface FlatTalkOverride { swap?: boolean; motions?: TalkMotion[] }
export interface FlatTalkConfig {
  /** Show the talking picture while talking (image sets). Rigged kinds always use their own mouth. */
  swap: boolean;
  motions: TalkMotion[];
  /** 0..1 (0.5 = natural). */
  strength: number;
  /** 0.25..3 (1 = natural). */
  speed: number;
  /** Per expression / state id. */
  perExpression: Record<string, FlatTalkOverride>;
}
export const talkDefaults = (pictures: boolean): FlatTalkConfig => ({ swap: true, motions: pictures ? ['hop'] : [], strength: pictures ? 0.4 : 0.5, speed: 1, perExpression: {} });

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const motionList = (v: unknown): TalkMotion[] | undefined => Array.isArray(v) ? [...new Set(v.filter((m): m is TalkMotion => TALK_MOTIONS.includes(m as TalkMotion)))] : undefined;

export function sanitizeTalk(v: unknown, pictures: boolean): FlatTalkConfig {
  const d = talkDefaults(pictures);
  if (!v || typeof v !== 'object') return d;
  const b = v as Record<string, unknown>;
  const per: Record<string, FlatTalkOverride> = {};
  if (b.perExpression && typeof b.perExpression === 'object') {
    for (const [k, o] of Object.entries(b.perExpression as Record<string, unknown>).slice(0, 32)) {
      if (!/^[A-Za-z0-9 _.-]{1,64}$/.test(k) || !o || typeof o !== 'object') continue;
      const x = o as Record<string, unknown>, r: FlatTalkOverride = {};
      if (typeof x.swap === 'boolean') r.swap = x.swap;
      const m = motionList(x.motions);
      if (m) r.motions = m;
      if (Object.keys(r).length) per[k] = r;
    }
  }
  return { swap: b.swap !== false, motions: motionList(b.motions) ?? d.motions, strength: num(b.strength, 0, 1, d.strength), speed: num(b.speed, 0.25, 3, d.speed), perExpression: per };
}

/** What applies now (the expression's override over the base). */
export function talkFor(c: FlatTalkConfig, expression: string | null): { swap: boolean; motions: TalkMotion[] } {
  const o = expression ? c.perExpression[expression] : undefined;
  return { swap: o?.swap ?? c.swap, motions: o?.motions ?? c.motions };
}

/** The talk layer's output: a pose delta (picture widths / heights, radians; pivot = the bottom centre) + effects. */
export interface TalkEffect { x: number; y: number; rot: number; sx: number; sy: number; lean: number; glow: number; bright: number; sparkle: number }
export const NO_TALK: TalkEffect = { x: 0, y: 0, rot: 0, sx: 1, sy: 1, lean: 0, glow: 0, bright: 0, sparkle: 0 };

/** Loudness → action size: grows with the voice, capped (shouting is not 3x the hop). */
export const loudness = (voice: number) => Math.min(1, Math.max(0, voice) / 0.6);

/** The talk motions over time. step() with this frame's voice (0..1) and whether the voice gate says talking. */
export class TalkMotor {
  private t = 0;
  private hopT = 99;
  private was = false;
  private env = 0;          // eased talking × loudness
  private lean = 0;
  private glow = 0;
  private bright = 0;
  private seed = 1;
  readonly out: TalkEffect = { ...NO_TALK };
  private rnd() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296 * 2 - 1; }

  step(voice: number, talking: boolean, dt: number, cfg: FlatTalkConfig, expression: string | null): TalkEffect {
    const { motions } = talkFor(cfg, expression);
    const on = new Set(motions);
    const sp = cfg.speed, A = cfg.strength * 2;
    this.t += dt * sp;
    const L = talking ? Math.max(0.35, loudness(voice)) : 0;
    const k = 1 - Math.exp(-(L > this.env ? 22 : 7) * dt * Math.max(0.5, sp));
    this.env += (L - this.env) * k;
    const E = this.env * A, t = this.t;
    if (talking && !this.was) this.hopT = 0;
    this.was = talking;
    this.hopT += dt * sp;
    const o = this.out;
    o.x = 0; o.y = 0; o.rot = 0; o.sx = 1; o.sy = 1;
    if (on.has('hop')) {
      const HOP = 0.24;
      const hop = this.hopT < HOP ? Math.sin(Math.PI * this.hopT / HOP) : 0;
      o.y += 0.05 * A * hop * Math.max(0.5, loudness(voice)) + 0.012 * E * Math.abs(Math.sin(t * 9));
    }
    if (on.has('squash')) { const s = 0.055 * E * Math.sin(t * 13); o.sy *= 1 + s; o.sx *= 1 - 0.6 * s; }
    if (on.has('wobble')) o.rot += 0.07 * E * Math.sin(t * 7);
    if (on.has('shake')) { if (E > 0.01) { o.x += 0.012 * E * this.rnd(); o.rot += 0.012 * E * this.rnd(); } }
    if (on.has('pulse')) { const s = 1 + 0.05 * E * (0.5 + 0.5 * Math.sin(t * 10)); o.sx *= s; o.sy *= s; }
    const leanT = (on.has('lean') ? 0.14 * E : 0) + (on.has('nod') ? 0.07 * E * Math.max(0, Math.sin(t * 8)) : 0);
    this.lean += (leanT - this.lean) * (1 - Math.exp(-14 * dt));
    o.lean = this.lean;
    // (seen head-on a lean is mostly coming closer: a little bigger, a little lower)
    if (this.lean > 0.001) { o.sx *= 1 + this.lean * 0.45; o.sy *= 1 + this.lean * 0.35; }
    if (on.has('nod')) o.y -= 0.012 * E * Math.max(0, Math.sin(t * 8));
    const glowT = on.has('glow') ? Math.min(1, E) : 0;
    this.glow += (glowT - this.glow) * (1 - Math.exp(-10 * dt));
    o.glow = this.glow;
    // brighten: up while talking, slightly dimmer while quiet (the speaker stands out in a group)
    const brightT = on.has('brighten') ? (talking ? 0.14 * Math.max(0.5, A) : -0.1) : 0;
    this.bright += (brightT - this.bright) * (1 - Math.exp(-8 * dt));
    o.bright = this.bright;
    o.sparkle = on.has('sparkle') ? Math.min(1.5, E) : 0;
    // caps: never so big the picture leaves its spot
    o.y = Math.max(-0.05, Math.min(0.08, o.y)); o.x = Math.max(-0.04, Math.min(0.04, o.x)); o.rot = Math.max(-0.2, Math.min(0.2, o.rot));
    o.sx = Math.max(0.85, Math.min(1.15, o.sx)); o.sy = Math.max(0.85, Math.min(1.15, o.sy));
    return o;
  }
}
