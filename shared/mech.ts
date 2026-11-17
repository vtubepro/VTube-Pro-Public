// Mech / walker avatars (AvatarProfile.body = 'mech', AvatarProfile.mech): a pilot seated in a walking machine.
// Pure data + maths (studio, OBS page, server save, party wire). Contract: creations/desert_walker/SPEC.md §1.3, §1.9,
// §2.2. Runtime: src/avatar/mech.ts (MechRig); gait maths: shared/gait.ts.
//
// Behaviour: the machine's legs walk mechanically (lift, carry, slam; hydraulic body bob) ONLY while the avatar travels
// (walk-ins, spot changes, entrances); the pilot stays seated; the head is always tracked; the arms are tracked while
// parked and IK-locked onto the control grips while travelling (smooth blends both ways). Every page derives the same
// walk from the host-timed move: config only on the wire, never model data (model custody is unaffected).
//
// ---------------------------------------------------------------------------------------------- RIG NAMING CONTRACT
// Every machine bone starts with 'm' + a lowercase word, so it is never read as a humanoid bone (src/avatar/humanoid.ts
// rules) and never starts an automatic spring chain (src/avatar/physics.ts AUTO_CHAIN: never ear, gear, rear, tail,
// chain, strap, tie, hat, bow, elbow … anywhere in a name). `npx tsx tools/mech_rigcheck.ts <file.glb>` proves it.
//
//   root                         ground origin, never animated
//   └ mpelvis                    the hull carriage: bob, roll, pitch, stand-up / park
//      ├ mleg_<S>_1 → _2 → _3    coxa (yaw) → femur (hinge) → tibia (hinge); S = FL FR (ML MR) HL HR, or L R, or L1..R4
//      │  └ mfoot_<S>            the foot plate (ankle hinge): kept level with the ground
//      │     └ mtip_<S>          optional sole contact (else profile `contact`, else the ankle dropped to the floor)
//      ├ mpist_<id>_a / _b       telescoping hydraulics (cylinder / rod; each aims at the other), e.g. mpist_FL_a
//      ├ mexhaust_<id>           FX anchors (exhaust puffs), no weights
//      └ mcockpit                seat / cage: a softer spring behind the hull (≤ lagMax)
//         ├ mstick_L → mgrip_L   control sticks (origin = the gimbal); grip frame = palm centre, +Y up the shaft, +Z fwd
//         ├ mstick_R → mgrip_R   (aliases mstick_LH / mstick_RH / mgrip_LH / mgrip_RH also accepted)
//         └ hips → spine → chest → neck → head (+ jaw, eyes); chest → shoulders → arms → hands: the PILOT, exact VRM
//                                names, NO humanoid leg bones (the thighs ride on mcockpit)
// Sides are the WALKER's own: +X = left in glTF (it faces +Z). Hinge bones: the build may set bone-local X = the hinge
// axis, and also writes each axis (model space) into profile.mech.legs[].joints[].axis; the runtime uses those axes.

export type V3 = [number, number, number];

/** Bone names of the contract (+ accepted aliases). */
export const MECH_BONES = {
  pelvis: 'mpelvis',
  cockpit: 'mcockpit',
  stick: { left: 'mstick_L', right: 'mstick_R' },
  grip: { left: 'mgrip_L', right: 'mgrip_R' },
  alias: { mstick_L: ['mstick_LH'], mstick_R: ['mstick_RH'], mgrip_L: ['mgrip_LH'], mgrip_R: ['mgrip_RH'] } as Record<string, string[]>,
} as const;

/** Side tokens: FL FR ML MR HL HR (B for H accepted), L R, L1..R9, and 1L..9R. */
const SIDE = '(?:[FMHB][LR]|[LR][1-9]?|[1-9][LR])';
export const MECH_LEG_RE = new RegExp(`^mleg_(${SIDE})_([1-9])$`);
export const MECH_FOOT_RE = new RegExp(`^mfoot_(${SIDE})$`);
export const MECH_TIP_RE = new RegExp(`^mtip_(${SIDE})$`);
export const MECH_PISTON_RE = /^mpist_([A-Za-z0-9]{1,24})_(a|b)$/;
export const MECH_EXHAUST_RE = /^mexhaust_([A-Za-z0-9]{1,24})$/;
/** SPEC §2.2 MECH_BONE (+ the tip / alias / digit-row forms this runtime also reads). */
export const MECH_BONE = new RegExp(`^(mpelvis|mcockpit|mleg_${SIDE}_[1-9]|mfoot_${SIDE}|mtip_${SIDE}|mstick_(?:L|R|LH|RH)|mgrip_(?:L|R|LH|RH)|mpist_[A-Za-z0-9]{1,24}_[ab]|mexhaust_[A-Za-z0-9]{1,24})$`);
export function isMechBone(name: string): boolean { return MECH_BONE.test(name); }

export type MechSide = 'FL' | 'FR' | 'ML' | 'MR' | 'HL' | 'HR' | 'L' | 'R' | 'L1' | 'L2' | 'L3' | 'L4' | 'R1' | 'R2' | 'R3' | 'R4';
export const MECH_SIDES: readonly MechSide[] = ['FL', 'FR', 'ML', 'MR', 'HL', 'HR', 'L', 'R', 'L1', 'L2', 'L3', 'L4', 'R1', 'R2', 'R3', 'R4'];
export type MechGaitFamily = 'walk' | 'march' | 'hustle' | 'biped' | 'tripod' | 'ripple' | 'tetrapod';
const FAMILIES: readonly string[] = ['auto', 'walk', 'march', 'hustle', 'biped', 'tripod', 'ripple', 'tetrapod'];

/** One leg joint: model-space (glTF) axis, limits in DEGREES relative to rest. */
export interface MechJoint { bone: string; type: 'yaw' | 'hinge'; axis?: V3; min: number; max: number }
export interface MechLegConfig {
  side: MechSide;
  /** [coxa yaw, femur hinge, tibia hinge, (foot hinge)] top → bottom. */
  joints: MechJoint[];
  foot?: string;
  /** Sole contact at rest, model space (metres at the GLB's scale). */
  contact?: V3;
  /** Keep the foot plate level with the ground (default true). */
  level?: boolean;
  /** Phase offset 0..1 (default: the gait family's). */
  phase?: number;
}

export interface MechHandBox { space?: 'cockpit'; min: V3; max: V3; posts?: { a: V3; b: V3; r: number }[] }
export interface MechConfig {
  v?: 1;
  kind?: 'walker' | 'biped' | 'tank' | 'hover';
  /** Scale rule (SPEC §2.2): the pilot is normalised like a human performer: room scale = base × heroScale / pilotHeight. */
  pilotHeight?: number;
  pilotEye?: number;
  heroScale?: number;
  pelvis?: string;
  cockpit?: string;
  /** Missing = found by name (mleg_<S>_<n> / mfoot_<S> / mtip_<S>), axes from the rest geometry, no limits. */
  legs?: MechLegConfig[];
  footprint?: { w: number; d: number };
  gait?: {
    family?: 'auto' | MechGaitFamily;
    /** Body travel per gait cycle, model metres (default 0.9 × the measured leg length L). */
    stride?: number;
    /** Swing apex, model metres (default 0.18 × L). */
    lift?: number;
    /** Seconds per cycle at each pace (defaults walk 1.15, march 0.8, hustle 0.6): vmax = stride / period.hustle. */
    period?: Partial<Record<'walk' | 'march' | 'hustle', number>>;
    duty?: number;
    /** Apex hold in seconds (the servo stutter; default 0.04). */
    hitch?: number;
  };
  body?: {
    /** Body drop while walking, × L (default 0.03). */
    drop?: number;
    /** Lean toward a lifted leg, DEGREES (defaults 2.0 / 1.5). */
    roll?: number;
    pitch?: number;
    /** Plant thump: downward speed kick, × L per second (default 0.14; 0.01 is barely visible). */
    impact?: number;
    /** Hull spring (rad/s, damping ratio; default 16 / 0.35 = overshoots) and the cab's lag spring (9 / 0.6). */
    omega?: number;
    zeta?: number;
    lagOmega?: number;
    lagZeta?: number;
    /** The cab's lag is clamped to this (metres; default 0.015) and 1.5°. */
    lagMax?: number;
  };
  pilot?: {
    grips?: { left?: string; right?: string };
    sticks?: { left?: string; right?: string };
    /** 'auto' (default) = on the sticks while travelling, tracked while parked; 'grip' = always on the sticks; 'free'. */
    hands?: 'auto' | 'grip' | 'free';
    /** Counter the cab's roll / pitch on the pilot's head, 0 … 1 (default 0.5). */
    levelHead?: number;
    /** Hips strapped to the seat (default true). */
    lockHips?: boolean;
    /** Torso lean limit, DEGREES [pitch, yaw, roll] (default [8, 12, 6]: the back is fused to the seat). */
    torsoLimit?: V3;
    /** Where tracked hands may go (SPEC M4; written by the build): a box plus the cage posts as capsules, in cockpit space
     *  (glTF axes, origin = the mcockpit pivot at rest). Tracked wrists are kept inside the box and outside the posts. */
    handBox?: MechHandBox;
  };
  /** In-place turn rate, rad/s (default 0.9); stand-up before the first step and settle after arriving, s (1.2 / 0.6). */
  turnRate?: number;
  spool?: number;
  settle?: number;
  /** Extra piston pairs [cylinder, rod] beyond the mpist_<id>_a / _b found by name. */
  pistons?: [string, string][];
  /** Emissive materials driven by the state (default ['EMIT_walker_lamps']). */
  lamps?: string[];
  /** Exhaust FX anchors (default: every mexhaust_* bone). */
  exhaust?: string[];
  /** Big-entrance style (read by the entrance engine). */
  entrance?: 'auto' | 'iris' | 'crane' | 'lift' | 'powerup' | 'walk';
}

export const MECH_LIMITS = {
  pilotHeight: [0.3, 5], pilotEye: [0.2, 5], heroScale: [1, 2], footprint: [0.05, 50],
  stride: [0.02, 20], lift: [0.002, 5], period: [0.2, 5], duty: [0.3, 0.95], hitch: [0, 0.2],
  drop: [0, 0.3], roll: [0, 10], pitch: [0, 10], impact: [0, 1], omega: [2, 60], zeta: [0.05, 2], lagOmega: [1, 60], lagZeta: [0.05, 2], lagMax: [0, 0.2],
  levelHead: [0, 1], torso: [0, 90], postR: [0.001, 5], turnRate: [0.2, 4], spool: [0, 5], settle: [0, 5], phase: [0, 1], angle: [-180, 180], contact: [-100, 100],
} as const;

export const MECH_DEFAULTS = {
  gait: { family: 'auto' as 'auto' | MechGaitFamily, strideL: 0.9, liftL: 0.18, period: { walk: 1.15, march: 0.8, hustle: 0.6 }, hitch: 0.04 },
  body: { drop: 0.03, roll: 2.0, pitch: 1.5, impact: 0.14, omega: 16, zeta: 0.35, lagOmega: 9, lagZeta: 0.6, lagMax: 0.015 },
  pilot: { hands: 'auto' as 'auto' | 'grip' | 'free', levelHead: 0.5, lockHips: true, torsoLimit: [8, 12, 6] as V3 },
  turnRate: 0.9, spool: 1.2, settle: 0.6, lamps: ['EMIT_walker_lamps'], heroScale: 1,
};

const NAME = /^[\w.:-]{1,64}$/;
const nm = (v: unknown): string | undefined => (typeof v === 'string' && NAME.test(v) ? v : undefined);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const num = (v: unknown, k: keyof typeof MECH_LIMITS): number | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const [lo, hi] = MECH_LIMITS[k];
  return r4(Math.min(hi, Math.max(lo, v)));
};
const vec = (v: unknown, unit = false): V3 | undefined => {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined;
  let a = v.map((x) => Math.min(100, Math.max(-100, x as number))) as V3;
  if (unit) { const l = Math.hypot(...a); if (l < 1e-6) return undefined; a = a.map((x) => x / l) as V3; }
  return a.map(r4) as V3;
};
function pick<T extends object>(o: T): T | undefined {
  for (const k of Object.keys(o)) if ((o as Record<string, unknown>)[k] === undefined) delete (o as Record<string, unknown>)[k];
  return Object.keys(o).length ? o : undefined;
}
/** A hand box (box min < max on every axis; at most 4 post capsules), or undefined. */
function handBoxOf(v: unknown): MechHandBox | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const min = vec(o.min), max = vec(o.max);
  if (!min || !max || !(min[0] < max[0] && min[1] < max[1] && min[2] < max[2])) return undefined;
  const posts: { a: V3; b: V3; r: number }[] = [];
  for (const q of Array.isArray(o.posts) ? o.posts.slice(0, 4) : []) {
    if (!q || typeof q !== 'object') continue;
    const x = q as Record<string, unknown>;
    const a = vec(x.a), b = vec(x.b), r = num(x.r, 'postR');
    if (a && b && r !== undefined) posts.push({ a, b, r });
  }
  return { space: 'cockpit', min, max, ...(posts.length ? { posts } : {}) };
}
const names = (v: unknown, max: number) => (Array.isArray(v) ? v.map(nm).filter((x): x is string => !!x).slice(0, max) : undefined);

/** Profile field → a clean config (or undefined = all defaults / found by name). Server save, party wire, UI. ≤ 4 KB. */
export function sanitizeMech(v: unknown): MechConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: MechConfig = {};
  if (o.v === 1) out.v = 1;
  if (o.kind === 'walker' || o.kind === 'biped' || o.kind === 'tank' || o.kind === 'hover') out.kind = o.kind;
  for (const k of ['pilotHeight', 'pilotEye', 'heroScale'] as const) { const x = num(o[k], k); if (x !== undefined) out[k] = x; }
  const pelvis = nm(o.pelvis), cockpit = nm(o.cockpit);
  if (pelvis) out.pelvis = pelvis;
  if (cockpit) out.cockpit = cockpit;
  if (Array.isArray(o.legs)) {
    const legs: MechLegConfig[] = [];
    for (const l of o.legs.slice(0, 8)) {
      if (!l || typeof l !== 'object') continue;
      const x = l as Record<string, unknown>;
      const side = (MECH_SIDES as readonly string[]).includes(x.side as string) ? (x.side as MechSide) : null;
      const joints: MechJoint[] = [];
      for (const j of Array.isArray(x.joints) ? x.joints.slice(0, 5) : []) {
        if (!j || typeof j !== 'object') continue;
        const y = j as Record<string, unknown>;
        const bone = nm(y.bone), type = y.type === 'yaw' || y.type === 'hinge' ? y.type : null;
        if (!bone || !type) continue;
        let mn = num(y.min, 'angle') ?? -180, mx = num(y.max, 'angle') ?? 180;
        if (mn > mx) [mn, mx] = [mx, mn];
        const axis = vec(y.axis, true);
        joints.push({ bone, type, ...(axis ? { axis } : {}), min: mn, max: mx });
      }
      if (!side || joints.length < 2) continue;
      const leg: MechLegConfig = { side, joints };
      const foot = nm(x.foot), contact = vec(x.contact), ph = num(x.phase, 'phase');
      if (foot) leg.foot = foot;
      if (contact) leg.contact = contact;
      if (typeof x.level === 'boolean') leg.level = x.level;
      if (ph !== undefined) leg.phase = ph;
      legs.push(leg);
    }
    if (legs.length) out.legs = legs;
  }
  if (o.footprint && typeof o.footprint === 'object') {
    const f = o.footprint as Record<string, unknown>;
    const w = num(f.w, 'footprint'), d = num(f.d, 'footprint');
    if (w !== undefined && d !== undefined) out.footprint = { w, d };
  }
  if (o.gait && typeof o.gait === 'object') {
    const g = o.gait as Record<string, unknown>;
    const per = g.period && typeof g.period === 'object' ? pick({ walk: num((g.period as Record<string, unknown>).walk, 'period'), march: num((g.period as Record<string, unknown>).march, 'period'), hustle: num((g.period as Record<string, unknown>).hustle, 'period') }) : undefined;
    const gait = pick({
      family: FAMILIES.includes(g.family as string) ? (g.family as 'auto' | MechGaitFamily) : undefined,
      stride: num(g.stride, 'stride'), lift: num(g.lift, 'lift'), period: per, duty: num(g.duty, 'duty'), hitch: num(g.hitch, 'hitch'),
    });
    if (gait) out.gait = gait;
  }
  if (o.body && typeof o.body === 'object') {
    const b = o.body as Record<string, unknown>;
    const body = pick({
      drop: num(b.drop, 'drop'), roll: num(b.roll, 'roll'), pitch: num(b.pitch, 'pitch'), impact: num(b.impact, 'impact'),
      omega: num(b.omega, 'omega'), zeta: num(b.zeta, 'zeta'), lagOmega: num(b.lagOmega, 'lagOmega'), lagZeta: num(b.lagZeta, 'lagZeta'), lagMax: num(b.lagMax, 'lagMax'),
    });
    if (body) out.body = body;
  }
  if (o.pilot && typeof o.pilot === 'object') {
    const p = o.pilot as Record<string, unknown>;
    const pair = (x: unknown) => (x && typeof x === 'object' ? pick({ left: nm((x as Record<string, unknown>).left), right: nm((x as Record<string, unknown>).right) }) : undefined);
    const tl = Array.isArray(p.torsoLimit) && p.torsoLimit.length === 3 && p.torsoLimit.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (p.torsoLimit as number[]).map((x) => num(x, 'torso')!) as V3 : undefined;
    const pilot = pick({
      grips: pair(p.grips), sticks: pair(p.sticks),
      hands: p.hands === 'auto' || p.hands === 'grip' || p.hands === 'free' ? (p.hands as 'auto' | 'grip' | 'free') : undefined,
      levelHead: num(p.levelHead, 'levelHead'), lockHips: typeof p.lockHips === 'boolean' ? p.lockHips : undefined, torsoLimit: tl,
      handBox: handBoxOf(p.handBox),
    });
    if (pilot) out.pilot = pilot;
  }
  for (const k of ['turnRate', 'spool', 'settle'] as const) { const x = num(o[k], k); if (x !== undefined) out[k] = x; }
  if (Array.isArray(o.pistons)) {
    const ps = o.pistons.slice(0, 32).map((p) => (Array.isArray(p) ? [nm(p[0]), nm(p[1])] : [])).filter((p): p is [string, string] => !!p[0] && !!p[1]);
    if (ps.length) out.pistons = ps;
  }
  const lamps = names(o.lamps, 16), exhaust = names(o.exhaust, 8);
  if (lamps?.length) out.lamps = lamps;
  if (exhaust?.length) out.exhaust = exhaust;
  if (['auto', 'iris', 'crane', 'lift', 'powerup', 'walk'].includes(o.entrance as string)) out.entrance = o.entrance as MechConfig['entrance'];
  // ≤ 4 KB on the wire: drop the optional lists first, then the explicit legs (they are found by name anyway)
  for (const k of ['pistons', 'lamps', 'exhaust'] as const) if (JSON.stringify(out).length > 4096) delete out[k];
  if (JSON.stringify(out).length > 4096 && out.pilot?.handBox) delete out.pilot.handBox;
  if (JSON.stringify(out).length > 4096) delete out.legs;
  return Object.keys(out).length ? out : undefined;
}

/** Every setting resolved (defaults filled in; stride / lift = null → × the measured leg length at runtime). */
export interface MechResolved {
  legs: MechLegConfig[] | null;
  pelvis: string;
  cockpit: string;
  heroScale: number;
  pilotHeight: number | null;
  gait: { family: 'auto' | MechGaitFamily; stride: number | null; lift: number | null; period: { walk: number; march: number; hustle: number }; duty: number | null; hitch: number };
  body: { drop: number; roll: number; pitch: number; impact: number; omega: number; zeta: number; lagOmega: number; lagZeta: number; lagMax: number };
  pilot: { sticks: { left: string[]; right: string[] }; grips: { left: string[]; right: string[] }; hands: 'auto' | 'grip' | 'free'; levelHead: number; lockHips: boolean; torsoLimit: V3; handBox: { min: V3; max: V3; posts: { a: V3; b: V3; r: number }[] } | null };
  turnRate: number;
  spool: number;
  settle: number;
  pistons: [string, string][];
  lamps: string[];
  exhaust: string[] | null;
}

const withAlias = (n: string) => [n, ...(MECH_BONES.alias[n] ?? [])];

export function resolveMech(cfg: MechConfig | undefined): MechResolved {
  const c = sanitizeMech(cfg) ?? {};
  const D = MECH_DEFAULTS;
  return {
    legs: c.legs ?? null,
    pelvis: c.pelvis ?? MECH_BONES.pelvis,
    cockpit: c.cockpit ?? MECH_BONES.cockpit,
    heroScale: c.heroScale ?? D.heroScale,
    pilotHeight: c.pilotHeight ?? null,
    gait: {
      family: c.gait?.family ?? D.gait.family, stride: c.gait?.stride ?? null, lift: c.gait?.lift ?? null,
      period: { ...D.gait.period, ...c.gait?.period }, duty: c.gait?.duty ?? null, hitch: c.gait?.hitch ?? D.gait.hitch,
    },
    body: { ...D.body, ...c.body },
    pilot: {
      sticks: { left: c.pilot?.sticks?.left ? [c.pilot.sticks.left] : withAlias(MECH_BONES.stick.left), right: c.pilot?.sticks?.right ? [c.pilot.sticks.right] : withAlias(MECH_BONES.stick.right) },
      grips: { left: c.pilot?.grips?.left ? [c.pilot.grips.left] : withAlias(MECH_BONES.grip.left), right: c.pilot?.grips?.right ? [c.pilot.grips.right] : withAlias(MECH_BONES.grip.right) },
      hands: c.pilot?.hands ?? D.pilot.hands, levelHead: c.pilot?.levelHead ?? D.pilot.levelHead,
      lockHips: c.pilot?.lockHips ?? D.pilot.lockHips, torsoLimit: c.pilot?.torsoLimit ?? D.pilot.torsoLimit,
      handBox: c.pilot?.handBox ? { min: c.pilot.handBox.min, max: c.pilot.handBox.max, posts: c.pilot.handBox.posts ?? [] } : null,
    },
    turnRate: c.turnRate ?? D.turnRate,
    spool: c.spool ?? D.spool,
    settle: c.settle ?? D.settle,
    pistons: c.pistons ?? [],
    lamps: c.lamps ?? D.lamps,
    exhaust: c.exhaust ?? null,
  };
}

/** How tall a machine may claim to be next to its own pilot (measured model height / pilotHeight): a seated-pilot
 *  walker is ~1.1, a low kart ~0.7. A profile claiming more (a tiny pilotHeight on a big model: the party wire carries
 *  config from guests) is read as this ratio, so nobody turns a 1.7 m model into a 17 m giant with one number. */
export const MECH_RATIO: readonly [number, number] = [0.4, 6];
/** The shown-height ceiling of any performer (shared/avatarSize.ts shownHeight). */
export const MECH_MAX_SHOWN = 80;

/** SPEC scale rule: room scale (room metres per model metre) for a walker whose pilot is normalised like a human
 *  performer: base × heroScale / pilotHeight. null without pilotHeight (the caller keeps the size-class rule).
 *  `measuredHeight` (the model's own height, the same units as pilotHeight): the claimed pilot is kept within MECH_RATIO
 *  of it and the shown height under MECH_MAX_SHOWN. The room's clearance clamp comes on top (SceneRuntime.fit). */
export function mechRoomScale(base: number, m: MechConfig | undefined, measuredHeight?: number): number | null {
  const c = sanitizeMech(m);
  if (!c?.pilotHeight || !(base > 0)) return null;
  let pilot = c.pilotHeight;
  const H = measuredHeight !== undefined && Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : 0;
  if (H > 0) pilot = Math.min(H / MECH_RATIO[0], Math.max(H / MECH_RATIO[1], pilot));
  let s = (base * (c.heroScale ?? 1)) / pilot;
  if (H > 0 && H * s > MECH_MAX_SHOWN) s = MECH_MAX_SHOWN / H;
  return s;
}
/** The walker's shown height in a room under the scale rule (measured model height × room scale); null = no rule. */
export function mechShownHeight(base: number, m: MechConfig | undefined, measuredHeight: number): number | null {
  if (!(measuredHeight > 0)) return null;
  const s = mechRoomScale(base, m, measuredHeight);
  return s === null ? null : measuredHeight * s;
}
