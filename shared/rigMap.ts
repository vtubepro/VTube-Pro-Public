// Per-rig retarget map: which of a rig's bones follows what. Written next to a 3D auto-rig (profile.rig.retarget) so live
// tracking can pose animals, birds, snakes and things the same way it poses a person, and so the parts tracking cannot
// reach (a tail, wings, a lamp's loose end, legs) still move.
//
//   by 'humanoid'   the studio's normal retarget already drives it: the bones carry VRM names (hips spine chest neck head,
//                   neck_2 ...), so the face tracker's head turn is spread down the neck and back, exactly as on a person
//   by 'quadruped'  src/avatar/quadruped.ts: planted feet, a walk cycle, tail swish (bones leg_FL_1.., tail_1..)
//   by 'physics'    spring bones (src/avatar/physics.ts AUTO_CHAIN: tail_*, chain_*)
//   by 'map'        src/avatar/rigMap.ts moves it from this entry: head-turn share (`face`) and/or an idle motion
//
// Pure data + pure functions (no three.js), so tools/autorig3d_unit.ts checks it without a browser. The map arrives from
// disk, from the MCP tool and from party guests' profiles: sanitizeRigMap keeps known fields, clamps numbers and bounds
// sizes, never trusts names beyond a plain-character check.

import type { RigTemplate, BodyType } from './rigTaps.ts';

export type RigRole = 'hips' | 'spine' | 'chest' | 'neck' | 'head' | 'leg' | 'tail' | 'wing' | 'ear' | 'spring' | 'body';
export type RigDrive = 'face' | 'gait' | 'idle' | 'spring' | 'hold';
export type RigBy = 'humanoid' | 'quadruped' | 'physics' | 'map';
export type IdleKind = 'flap' | 'sway' | 'breathe' | 'undulate';
export type ModelAxis = 'x' | 'y' | 'z';

export interface RigIdle {
  kind: IdleKind;
  /** Peak turn in radians (negative = the mirror side of a pair). */
  amp: number;
  hz: number;
  /** Radians. */
  phase: number;
  /** Axis in the MODEL's frame (the model faces +Z, +Y up, +X is its left): z = roll, x = nod, y = turn. */
  axis: ModelAxis;
}

export interface RigMapEntry {
  bone: string;
  role: RigRole;
  drive: RigDrive;
  by: RigBy;
  /** `face` driven by the map: the share (0..1) of the head turn this bone takes. */
  weight?: number;
  idle?: RigIdle;
}

export interface RigRetargetMap {
  version: 1;
  template: RigTemplate;
  bodyType?: BodyType;
  entries: RigMapEntry[];
}

const ROLES: readonly RigRole[] = ['hips', 'spine', 'chest', 'neck', 'head', 'leg', 'tail', 'wing', 'ear', 'spring', 'body'];
const DRIVES: readonly RigDrive[] = ['face', 'gait', 'idle', 'spring', 'hold'];
const BYS: readonly RigBy[] = ['humanoid', 'quadruped', 'physics', 'map'];
const KINDS: readonly IdleKind[] = ['flap', 'sway', 'breathe', 'undulate'];
const AXES: readonly ModelAxis[] = ['x', 'y', 'z'];
export const MAX_RIG_ENTRIES = 96;
const NAME_OK = /^[\p{L}\p{N}_.:\- ]{1,64}$/u;

const clamp = (n: unknown, lo: number, hi: number, d: number) => { const v = Number(n); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const pick = <T extends string>(v: unknown, set: readonly T[]): T | null => (typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : null);

/** A clean map or null. */
export function sanitizeRigMap(raw: unknown): RigRetargetMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const template = pick(r.template, ['humanoid', 'quadruped', 'creature', 'object'] as const);
  if (!template || !Array.isArray(r.entries)) return null;
  const entries: RigMapEntry[] = [];
  const seen = new Set<string>();
  for (const e of r.entries.slice(0, MAX_RIG_ENTRIES)) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const bone = typeof o.bone === 'string' && NAME_OK.test(o.bone) ? o.bone : null;
    const role = pick(o.role, ROLES), drive = pick(o.drive, DRIVES), by = pick(o.by, BYS);
    if (!bone || !role || !drive || !by || seen.has(bone)) continue;
    seen.add(bone);
    const out: RigMapEntry = { bone, role, drive, by };
    if (o.weight !== undefined) out.weight = clamp(o.weight, 0, 1, 0);
    const i = o.idle as Record<string, unknown> | undefined;
    if (i && typeof i === 'object') {
      const kind = pick(i.kind, KINDS), axis = pick(i.axis, AXES);
      if (kind && axis) out.idle = { kind, axis, amp: clamp(i.amp, -1.2, 1.2, 0), hz: clamp(i.hz, 0.02, 3, 0.3), phase: clamp(i.phase, -7, 7, 0) };
    }
    entries.push(out);
  }
  if (!entries.length) return null;
  const bodyType = pick(r.bodyType, ['person', 'fourLegs', 'bird', 'tail', 'thing'] as const);
  return { version: 1, template, ...(bodyType ? { bodyType } : {}), entries };
}

const idx = (name: string) => Number((/(\d+)$/.exec(name) ?? [])[1] ?? 1);

/**
 * The map for a freshly built rig, from its bone names (the template names are the contract: blender/rigplan.py).
 * Unknown bones are left out: they simply do not move beyond the skin.
 */
export function buildRigMap(template: RigTemplate, bodyType: BodyType | undefined, bones: readonly string[]): RigRetargetMap {
  const entries: RigMapEntry[] = [];
  const add = (e: RigMapEntry) => { if (entries.length < MAX_RIG_ENTRIES) entries.push(e); };
  const thing = template === 'object';
  const snake = template === 'creature' && bodyType === 'tail';
  // a snake slithers: a wave of side-to-side turns (about the model's up axis) travels from the head to the tail tip
  const slither = (amp: number, step: number): RigIdle => ({ kind: 'undulate', amp, hz: 0.42, phase: -0.8 * step, axis: 'y' });
  for (const b of bones) {
    if (b === 'hips') add({ bone: b, role: 'hips', drive: 'hold', by: 'humanoid' });      // (never given an idle motion: the hips of a thing or a snake stay at rest)
    else if (b === 'spine' || b === 'chest') {
      // a thing's bend chain sways a little on its own when nobody is there; people and animals do not need it
      const idle: RigIdle | undefined = thing ? { kind: 'sway', amp: b === 'spine' ? 0.025 : 0.035, hz: 0.18, phase: b === 'spine' ? 0 : 0.9, axis: 'x' } : snake ? slither(0.05, b === 'spine' ? 2 : 1) : undefined;
      add({ bone: b, role: b, drive: 'face', by: 'humanoid', ...(idle ? { idle } : {}) });
    } else if (b === 'neck' || /^neck_\d+$/.test(b)) {
      const idle: RigIdle | undefined = thing ? { kind: 'sway', amp: 0.04, hz: 0.18, phase: 1.7, axis: 'z' } : snake ? slither(0.04, 0) : undefined;
      add({ bone: b, role: 'neck', drive: 'face', by: 'humanoid', ...(idle ? { idle } : {}) });
    } else if (b === 'head') add({ bone: b, role: 'head', drive: 'face', by: 'humanoid' });
    else if (/^leg_[FH][LR]_(\d+|toe)$/.test(b)) add({ bone: b, role: 'leg', drive: 'gait', by: 'quadruped' });
    else if (/^tail_\d+$/.test(b)) {
      if (snake) add({ bone: b, role: 'tail', drive: 'idle', by: 'map', idle: slither(0.06 + 0.035 * Math.min(idx(b), 6), -idx(b)) });
      else add({ bone: b, role: 'tail', drive: 'idle', by: 'quadruped' });
    }
    else if (/^ear_[LR]_\d+$/.test(b)) add({ bone: b, role: 'ear', drive: 'idle', by: 'quadruped' });
    else if (/^chain_\d+$/.test(b)) add({ bone: b, role: 'spring', drive: 'spring', by: 'physics' });
    else if (/^wing_[LR]_\d+$/.test(b)) {
      // wings flutter about the body's forward axis, the two sides mirrored; the outer bones swing more
      const left = b[5] === 'L', n = idx(b);
      add({ bone: b, role: 'wing', drive: 'idle', by: 'map', idle: { kind: 'flap', amp: (left ? 1 : -1) * (0.05 + 0.07 * n), hz: 0.28, phase: 0.35 * n, axis: 'z' } });
    }
  }
  return { version: 1, template, ...(bodyType ? { bodyType } : {}), entries };
}

/** Plain-words lines for the "what will move" note under the rig button. */
export function describeRigMap(map: RigRetargetMap): string[] {
  const has = (role: RigRole) => map.entries.some((e) => e.role === role);
  const out: string[] = [];
  if (has('head')) out.push('The head, neck and back follow your face.');
  if (has('leg')) out.push('The legs stand and walk by themselves.');
  if (has('tail')) out.push('The tail swishes on its own.');
  if (has('wing')) out.push('The wings flutter on their own.');
  if (has('spring')) out.push('The loose end swings on springs.');
  if (map.template === 'object') out.push('It sways a little when nobody is tracking.');
  return out;
}
