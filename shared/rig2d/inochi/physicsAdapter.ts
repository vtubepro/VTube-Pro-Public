// Solver for the canonical `dynamics` kind 'pendulum' (docs/RIG2D_FORMAT.md §8.4): Inochi2D SimplePhysics converted
// by shared/rig2d/inochi/convert.ts, also usable by native rigs. (Files written before the field existed carried the
// same data in `extra['vtubepro.inochi.simplePhysics']`; still read.)
// Reference-derived equations: Inochi2D v0.8.7, Copyright (c) 2020/2022 Inochi2D Project,
// SimplePhysics by Asahi Lina, BSD-2-Clause. Corroborated with inox2d (BSD-2-Clause).
// Both licences and source revisions are retained in THIRD_PARTY_NOTICES.md and provenance §5.
import { z } from 'zod';
import type { Rig2DDoc } from '../format.ts';
import type { RigEval } from '../evaluate.ts';
import type { InochiRig } from './inp.ts';

export const INOCHI_PHYSICS_ADAPTER = 'vtubepro.inochi.simplePhysics';
const finite = z.number().finite();
const positive = finite.positive();
const PhysicsAdapterSchema = z.object({
  version: z.literal(1),
  world: z.object({ pixelsPerMeter: positive, gravity: finite.nonnegative() }).strict(),
  drivers: z.array(z.object({
    id: z.string().min(1).max(128), deformer: z.number().int().nonnegative(),
    outputs: z.tuple([z.string().min(1).max(128), z.string().min(1).max(128).nullable()]),
    model: z.enum(['Pendulum', 'SpringPendulum']), map: z.enum(['AngleLength', 'LengthAngle', 'XY', 'YX']),
    gravity: finite.nonnegative(), length: positive, frequency: positive,
    angleDamping: finite.nonnegative(), lengthDamping: finite.nonnegative(),
    outputScale: z.tuple([finite, finite]), localOnly: z.boolean(),
  }).strict()).max(2048),
}).strict();
export type InochiPhysicsData = z.infer<typeof PhysicsAdapterSchema>;
type Driver = InochiPhysicsData['drivers'][number];
type Frame = [number, number, number, number, number, number];
type State = { bobX: number; bobY: number; vx: number; vy: number; omega: number };

/** SimplePhysics nodes → canonical `dynamics` entries of kind 'pendulum' (format §8.4): gravity is stored already
 *  multiplied out (node gravity × puppet gravity × pixels per metre = model px / s²). */
export function convertPhysics(rig: InochiRig, nodeDef: Int32Array, indices: [number, number][], params: Rig2DDoc['params'], deformers: Rig2DDoc['deformers'], warn: (s: string) => void): NonNullable<Rig2DDoc['dynamics']> {
  const out: NonNullable<Rig2DDoc['dynamics']> = [];
  const world = rig.puppet.physics;
  rig.nodes.forEach((n, i) => {
    const ph = n.node.physics;
    if (!ph) return;
    const pi = rig.paramByUuid.get(ph.param);
    if (pi === undefined) { warn('A hair / clothes physics driver has no output control: that driver was skipped.'); return; }
    const [x, y] = indices[pi];
    out.push({ id: `physics_${n.node.uuid}`, kind: 'pendulum', deformer: deformers[nodeDef[i]].id, output: params[x].id, ...(y >= 0 ? { output2: params[y].id } : {}),
      model: ph.model === 'SpringPendulum' ? 'spring' : 'pendulum', map: MAP_TO[ph.map], gravity: ph.gravity * Math.max(0, world.gravity) * world.pixelsPerMeter,
      length: ph.length, frequency: ph.frequency, angleDamping: ph.angleDamping, lengthDamping: ph.lengthDamping, outputScale: ph.outputScale, localOnly: ph.localOnly });
  });
  return out;
}
const MAP_TO = { AngleLength: 'angleLength', LengthAngle: 'lengthAngle', XY: 'xy', YX: 'yx' } as const;
const MAP_FROM = { angleLength: 'AngleLength', lengthAngle: 'LengthAngle', xy: 'XY', yx: 'YX' } as const;

/** The canonical pendulum dynamics of a rig as the solver's driver list (world = 1 px/m, gravity 1: already folded in). */
function driversOf(doc: Rig2DDoc): InochiPhysicsData | null {
  const defIdx = new Map(doc.deformers.map((d, i) => [d.id, i]));
  const ps = (doc.dynamics ?? []).filter((d) => d.kind === 'pendulum');
  if (!ps.length) return null;
  return { version: 1, world: { pixelsPerMeter: 1, gravity: 1 }, drivers: ps.map((d) => ({
    id: d.id, deformer: d.deformer !== undefined ? defIdx.get(d.deformer) ?? 1e9 : 1e9, outputs: [d.output ?? '', d.output2 ?? null] as [string, string | null],
    model: d.model === 'spring' ? 'SpringPendulum' as const : 'Pendulum' as const, map: MAP_FROM[d.map ?? 'angleLength'],
    gravity: Math.max(0, d.gravity ?? 0), length: d.length ?? 100, frequency: d.frequency ?? 1, angleDamping: Math.max(0, d.angleDamping ?? 0.5),
    lengthDamping: Math.max(0, d.lengthDamping ?? 0.5), outputScale: d.outputScale ?? [1, 1], localOnly: d.localOnly ?? false,
  })) };
}

/** Validate untrusted vendor data and all references before using it. Native rigs pay no evaluation cost. */
export function createInochiPhysicsAdapter(doc: Rig2DDoc, ev: RigEval): InochiPhysicsAdapter | null {
  // canonical dynamics (format §8.4); the earlier `extra` adapter key is still read for files written before it
  const raw = driversOf(doc) ?? doc.extra?.[INOCHI_PHYSICS_ADAPTER];
  if (raw === undefined) return null;
  const parsed = PhysicsAdapterSchema.safeParse(raw);
  const ids = new Set(doc.params.map((p) => p.id));
  if (!parsed.success || parsed.data.drivers.some((p) => p.deformer >= doc.deformers.length || p.outputs.some((id) => id !== null && !ids.has(id)))) {
    throw new Error('The puppet’s hair / clothes physics data is damaged. Import the original puppet again.');
  }
  return new InochiPhysicsAdapter(doc, ev, parsed.data);
}

function inversePoint(m: Frame, x: number, y: number): [number, number] | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  x -= m[4]; y -= m[5];
  return [(m[3] * x - m[2] * y) / det, (m[0] * y - m[1] * x) / det];
}

// Classical RK4 as used by the reference PhysicsSystem; at most 10ms per integration step.
function rk4(state: number[], dt: number, derivative: (v: number[]) => number[]) {
  const a = derivative(state), b = derivative(state.map((v, i) => v + a[i] * dt / 2));
  const c = derivative(state.map((v, i) => v + b[i] * dt / 2)), d = derivative(state.map((v, i) => v + c[i] * dt));
  return state.map((v, i) => v + dt * (a[i] + 2 * b[i] + 2 * c[i] + d[i]) / 6);
}

/** The equations operate in pixels and seconds, with +y downward. Outputs are absolute parameter
 *  values, NOT normalized around the parameter's default. Angle is atan2(-x,y)/PI; length is L/L0. */
export class InochiPhysicsAdapter {
  private states: State[] = [];
  private outputIndices: [number, number][];
  constructor(private doc: Rig2DDoc, private ev: RigEval, readonly data: InochiPhysicsData) {
    this.outputIndices = data.drivers.map((p) => p.outputs.map((id) => doc.params.findIndex((q) => q.id === id)) as [number, number]);
    this.reset();
  }
  private frame(di: number): Frame {
    const [x, y] = this.ev.deformerPoint(di, 0, 0), a = this.ev.deformerPoint(di, 1, 0), b = this.ev.deformerPoint(di, 0, 1);
    return [a[0] - x, a[1] - y, b[0] - x, b[1] - y, x, y];
  }
  private anchor(p: Driver, frame: Frame): [number, number] {
    if (!p.localOnly) return [frame[4], frame[5]];
    const parent = this.doc.deformers[p.deformer].parent;
    return parent < 0 ? [frame[4], frame[5]] : inversePoint(this.frame(parent), frame[4], frame[5]) ?? [0, 0];
  }
  private enabled(p: Driver) {
    for (let i = p.deformer; i >= 0; i = this.doc.deformers[i].parent) if (!this.doc.deformers[i].enabled) return false;
    return true;
  }
  reset() {
    this.ev.update();
    this.states = this.data.drivers.map((p) => {
      const [x, y] = this.anchor(p, this.frame(p.deformer));
      return { bobX: x, bobY: y + p.length, vx: 0, vy: 0, omega: 0 };
    });
  }
  update(dt: number) {
    if (!Number.isFinite(dt) || dt < 0) return;
    // Bound catch-up work after a suspended tab. Ordinary frames use the reference's 10ms steps.
    const elapsed = Math.min(dt, 0.1);
    // ONE evaluation for every driver (not one per driver): read all anchors from the same evaluated pose, step all
    // solvers, write all outputs. A pendulum anchored under a node another pendulum moves sees that motion one frame
    // later (the reference re-evaluates between drivers; at 60 fps the difference is one 16 ms step).
    this.ev.update();
    const frames = this.data.drivers.map((p) => (this.enabled(p) ? this.frame(p.deformer) : null));
    this.data.drivers.forEach((p, i) => {
      const frame = frames[i];
      if (!frame) return;
      const [ax, ay] = this.anchor(p, frame), s = this.states[i];
      const g = p.gravity * this.data.world.gravity * this.data.world.pixelsPerMeter;
      const angularDamping = 2 * Math.sqrt(g / p.length) * p.angleDamping;
      const w = 2 * Math.PI * p.frequency, k = w * w;
      // Smaller steps keep high-frequency or overdamped user settings stable as well.
      const maxStep = Math.min(0.01, 0.5 / Math.max(1, Math.sqrt(g / p.length), angularDamping, p.model === 'SpringPendulum' ? w * Math.max(1, 2 * p.lengthDamping) : 1));
      const count = Math.max(1, Math.min(1000, Math.ceil(elapsed / maxStep))), h = Math.min(maxStep, elapsed / count);
      for (let step = 0; step < count; step++) {
        if (p.model === 'Pendulum') {
          const angle = Math.atan2(-(s.bobX - ax), s.bobY - ay);
          const [a, omega] = rk4([angle, s.omega], h, ([a, v]) => [v, -g / p.length * Math.sin(a) - angularDamping * v]);
          s.bobX = ax - Math.sin(a) * p.length; s.bobY = ay + Math.cos(a) * p.length; s.omega = omega;
        } else {
          const rest = p.length - g / k, lengthDamping = 2 * w * p.lengthDamping;
          [s.bobX, s.bobY, s.vx, s.vy] = rk4([s.bobX, s.bobY, s.vx, s.vy], h, ([x, y, vx, vy]) => {
            const dx = x - ax, dy = y - ay, length = Math.hypot(dx, dy), nx = length > 1e-9 ? dx / length : 0, ny = length > 1e-9 ? dy / length : 1;
            const force = (length - rest) * k;
            // Preserve the D reference's damping-coordinate rotation exactly.
            const tx = vx * ny + vy * nx, ty = vy * ny - vx * nx;
            const fx = -tx * angularDamping, fy = -ty * lengthDamping;
            return [vx, vy, -nx * force + fx * ny - ty * nx, g - ny * force + fy * ny + tx * nx];
          });
        }
      }
      if (![s.bobX, s.bobY, s.vx, s.vy, s.omega].every(Number.isFinite)) {
        s.bobX = ax; s.bobY = ay + p.length; s.vx = s.vy = s.omega = 0;
      }
      // local_only deliberately uses the local bob position without subtracting the anchor,
      // matching SimplePhysics.updateOutputs (including its nonzero-local-origin behaviour).
      const local = p.localOnly ? [s.bobX, s.bobY] : inversePoint(frame, s.bobX, s.bobY);
      if (!local) return;
      const n = Math.hypot(local[0], local[1]), x = n > 1e-9 ? local[0] / n : 0, y = n > 1e-9 ? local[1] / n : 1;
      const length = Math.hypot(s.bobX - ax, s.bobY - ay) / p.length, angle = Math.atan2(-x, y) / Math.PI;
      const value = p.map === 'AngleLength' ? [angle, length] : p.map === 'LengthAngle' ? [length, angle] : p.map === 'XY' ? [x * length, 1 - y * length] : [1 - y * length, x * length];
      this.outputIndices[i].forEach((index, axis) => {
        if (index < 0) return;
        const param = this.doc.params[index], v = value[axis] * p.outputScale[axis];
        this.ev.values[index] = Math.max(param.min, Math.min(param.max, v));
      });
    });
  }
}
