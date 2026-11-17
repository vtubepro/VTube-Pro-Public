// Attachments + particles (docs/RIG2D_FORMAT.md §8.6 / §8.7) and sprite-sheet frames (§8.10). Pure; drawn by the normal
// mesh renderer: augmentRig() appends one synthetic mesh per attachment (a quad) and per emitter (a batch of quads in ONE
// mesh = one draw call), marked disabled so the evaluator never orders them; Fx.update() places them each frame and
// splices them into the render order. Seeded: the same frames give the same particles.
import { BufferBuilder, f32 } from './container.ts';
import type { Rig2DAttachment, Rig2DDoc, Rig2DParticle } from './format.ts';
import type { EvalOut, RigEval } from './evaluate.ts';
import { idPhase } from './dynamics.ts';
import type { Rig2DEvent } from './world.ts';

type Slot = Rig2DAttachment['slot'];
interface SlotRt { bone: number; mesh: number; v: number; v2: number; def: number; x: number; y: number }
interface AttRt { a: Rig2DAttachment; mesh: number; slot: SlotRt; at: { above: number; front: boolean } }
interface EmRt {
  p: Rig2DParticle; mesh: number; slot: SlotRt; at: { above: number; front: boolean }; cap: number;
  // particle state (structure of arrays)
  x: Float32Array; y: Float32Array; vx: Float32Array; vy: Float32Array; age: Float32Array; life: Float32Array; rot: Float32Array; alive: Uint8Array;
  carry: number; seed: number; burst: number; lastSerial: number;
}

export interface FxMap { atts: AttRt[]; ems: EmRt[]; first: number }

/** Append the synthetic meshes. Returns the augmented doc + buffers (the original doc is not changed). */
export function augmentRig(doc: Rig2DDoc, buffers: readonly Uint8Array[]): { doc: Rig2DDoc; buffers: Uint8Array[]; fx: FxMap | null } {
  const atts = doc.attachments ?? [], ems = doc.particles ?? [];
  if (!atts.length && !ems.length) return { doc, buffers: [...buffers], fx: null };
  const B = new BufferBuilder(buffers.length);
  const d: Rig2DDoc = { ...doc, meshes: [...doc.meshes], grids: [...doc.grids, { axes: [] }], buffers: [...doc.buffers] };
  const g = d.grids.length - 1, first = d.meshes.length;
  const meshIdx = new Map(doc.meshes.map((m, i) => [m.id, i])), boneIdx = new Map((doc.bones ?? []).map((b, i) => [b.id, i])), defIdx = new Map(doc.deformers.map((f, i) => [f.id, i]));
  const slot = (s: Slot): SlotRt => ({ bone: s.bone ? boneIdx.get(s.bone) ?? -1 : -1, mesh: s.mesh ? meshIdx.get(s.mesh) ?? -1 : -1, v: s.vertex ?? 0, v2: s.vertex2 ?? -1,
    def: s.deformer ? defIdx.get(s.deformer) ?? -1 : -1, x: s.x ?? 0, y: s.y ?? 0 });
  const at = (dr: { above?: string; at?: 'front' | 'back' } | undefined) => ({ above: dr?.above ? meshIdx.get(dr.above) ?? -1 : -1, front: dr?.at !== 'back' });
  const quads = (n: number, rect: [number, number, number, number]) => {
    const uv = new Float32Array(n * 8), ix = new Uint16Array(n * 6);
    const [u, v, w, h] = rect;
    for (let q = 0; q < n; q++) {
      uv.set([u, v, u + w, v, u, v + h, u + w, v + h], q * 8);
      ix.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 1, q * 4 + 3, q * 4 + 2], q * 6);
    }
    return { uvs: B.add(uv, 'f32'), indices: B.add(ix, 'u16'), positions: B.add(new Float32Array(n * 8), 'f32') };
  };
  const fx: FxMap = { atts: [], ems: [], first };
  for (const a of atts) {
    const q = quads(1, a.rect);
    d.meshes.push({ id: `__att_${a.id}`, name: a.name, part: -1, deformer: -1, texture: a.texture, grid: g, vertexCount: 4, ...q, opacity: [1], drawOrder: [0],
      blend: a.blend ?? 'normal', doubleSided: true, masks: [], visible: true, enabled: false });
    fx.atts.push({ a, mesh: d.meshes.length - 1, slot: slot(a.slot), at: at(a.draw) });
  }
  for (const p of ems) {
    const cap = Math.max(1, Math.min(p.max ?? 64, 1024));
    const q = quads(cap, p.rect);
    d.meshes.push({ id: `__fx_${p.id}`, name: p.name ?? p.id, part: -1, deformer: -1, texture: p.texture, grid: g, vertexCount: cap * 4, ...q, opacity: [1], drawOrder: [0],
      blend: p.blend ?? 'normal', doubleSided: true, masks: [], visible: true, enabled: false });
    const z = () => new Float32Array(cap);
    fx.ems.push({ p, mesh: d.meshes.length - 1, slot: slot(p.slot), at: at(p.draw), cap, x: z(), y: z(), vx: z(), vy: z(), age: z(), life: z(), rot: z(), alive: new Uint8Array(cap),
      carry: 0, seed: (Math.floor(idPhase(p.id) * 1e6) >>> 0) || 1, burst: 0, lastSerial: -1 });
  }
  const bytes = B.bytes();
  d.buffers.push({ file: `buffers/${buffers.length}.bin`, byteLength: bytes.length });
  return { doc: d, buffers: [...buffers, bytes], fx };
}

export interface FxTriggers {
  voice: number;
  values: Float64Array;
  paramIndex: (id: string) => number;
  expression: string | null;
  emotion: { name: string; level: number };
  hotkey: string | null;
  /** expressions toggled on (they stack): `expression` / `hotkey` triggers match these too */
  toggled?: readonly string[];
  /** events since the last frame */
  events: readonly Rig2DEvent[];
  /** particle budget for the whole puppet (graphics tier) */
  budget: number;
  /** is attachment `id` shown (its `on`, or a costume layer)? */
  attachmentOn: (i: number) => boolean;
}

const tmp = new Float64Array(2), tmp2 = new Float64Array(2);

export class Fx {
  constructor(private doc: Rig2DDoc, readonly map: FxMap) {}

  /** Where a slot is now: origin (model units) + turn (radians, clockwise). */
  private slotAt(s: SlotRt, ev: RigEval, out: Float64Array): number {
    if (s.bone >= 0 && s.bone < ev.boneCount) {
      ev.bonePoint(s.bone, s.x, s.y, out);
      const W = ev.boneWorld, o = s.bone * 6;
      return Math.atan2(W[o + 1], W[o]);
    }
    if (s.mesh >= 0) {
      const p = ev.out.positions[s.mesh];
      const v = Math.min(s.v, p.length / 2 - 1);
      out[0] = p[v * 2]; out[1] = p[v * 2 + 1];
      if (s.v2 >= 0 && s.v2 < p.length / 2) return Math.atan2(p[s.v2 * 2 + 1] - out[1], p[s.v2 * 2] - out[0]);
      return 0;
    }
    if (s.def >= 0) { ev.deformerPointInto(s.def, s.x, s.y, out); return ev.deformerTurn(s.def, s.x, s.y) * Math.PI / 180; }
    out[0] = s.x; out[1] = s.y; return 0;
  }

  update(ev: RigEval, dt: number, t: FxTriggers) {
    const out = ev.out;
    // attachments
    for (let i = 0; i < this.map.atts.length; i++) {
      const A = this.map.atts[i], a = A.a, P = out.positions[A.mesh];
      const on = t.attachmentOn(i);
      out.opacity[A.mesh] = on ? 1 : 0;
      if (!on) continue;
      const turn = (a.rotate === false ? 0 : this.slotAt(A.slot, ev, tmp)) + (a.angle ?? 0) * Math.PI / 180;
      if (a.rotate === false) this.slotAt(A.slot, ev, tmp);
      const c = Math.cos(turn), s = Math.sin(turn), [w, h] = a.size, px = a.pivot[0] * w, py = a.pivot[1] * h;
      const corner = (k: number, lx: number, ly: number) => { const x = lx - px, y = ly - py; P[k] = tmp[0] + c * x - s * y; P[k + 1] = tmp[1] + s * x + c * y; };
      corner(0, 0, 0); corner(2, w, 0); corner(4, 0, h); corner(6, w, h);
    }
    // particles
    const nEm = this.map.ems.length;
    const share = nEm ? Math.floor(t.budget / nEm) : 0;
    for (const E of this.map.ems) this.emit(E, ev, dt, t, Math.min(E.cap, share));
    this.splice(out);
  }

  private rnd(E: EmRt) { E.seed = (Math.imul(E.seed, 1664525) + 1013904223) >>> 0; return E.seed / 4294967296; }

  private triggered(E: EmRt, dt: number, t: FxTriggers): boolean {
    const tr = E.p.trigger, v = tr.value ?? '';
    switch (tr.kind) {
      case 'always': return true;
      case 'voice': return t.voice >= (tr.above ?? 0.15);
      case 'param': { const i = t.paramIndex(v); return i >= 0 && t.values[i] >= (tr.above ?? 0.5); }
      case 'expression': return t.expression === v || !!t.toggled?.includes(v);
      default: {
        let hit = false;
        if (tr.kind === 'emotion') hit = t.emotion.name === v && t.emotion.level >= (tr.above ?? 0.5);
        else if (tr.kind === 'hotkey') hit = t.hotkey === v || !!t.toggled?.includes(v);
        else for (const e of t.events) if (e.serial > E.lastSerial && e.kind === tr.kind && (tr.kind === 'chat' ? !v || e.value.toLowerCase().includes(v.toLowerCase()) : e.value.toLowerCase() === v.toLowerCase())) hit = true;
        if (t.events.length) E.lastSerial = Math.max(E.lastSerial, t.events[t.events.length - 1].serial);
        if (hit && tr.kind !== 'emotion' && tr.kind !== 'hotkey') E.burst = tr.burst ?? 1;
        else if (hit) E.burst = Math.max(E.burst, dt);
        E.burst = Math.max(0, E.burst - dt);
        return E.burst > 0 || hit;
      }
    }
  }

  private emit(E: EmRt, ev: RigEval, dt: number, t: FxTriggers, cap: number) {
    const p = E.p, P = ev.out.positions[E.mesh];
    let A = ev.out.alpha[E.mesh];
    if (!A) A = ev.out.alpha[E.mesh] = new Float32Array(E.cap * 4);
    const on = cap > 0 && this.triggered(E, dt, t);
    const turn = this.slotAt(E.slot, ev, tmp2);
    // spawn
    if (on) {
      E.carry += p.rate * dt;
      let n = Math.floor(E.carry);
      E.carry -= n;
      for (let i = 0; i < cap && n > 0; i++) {
        if (E.alive[i]) continue;
        const ang = ((p.angle ?? 0) + (this.rnd(E) * 2 - 1) * p.spread) * Math.PI / 180 + turn;
        const sp = p.speed[0] + (p.speed[1] - p.speed[0]) * this.rnd(E);
        E.alive[i] = 1; E.age[i] = 0; E.life[i] = Math.max(0.05, p.life * (0.8 + 0.4 * this.rnd(E)));
        E.x[i] = tmp2[0]; E.y[i] = tmp2[1]; E.vx[i] = Math.sin(ang) * sp; E.vy[i] = -Math.cos(ang) * sp; E.rot[i] = this.rnd(E) * Math.PI * 2;
        n--;
      }
    } else E.carry = 0;
    // move + write quads
    let live = 0;
    const fade = Math.max(0.01, p.fade ?? 0.3), spin = (p.spin ?? 0) * Math.PI / 180;
    for (let i = 0; i < E.cap; i++) {
      const k = i * 8;
      if (E.alive[i] && i < Math.max(cap, 0)) {
        E.age[i] += dt;
        if (E.age[i] >= E.life[i]) E.alive[i] = 0;
      } else E.alive[i] = 0;
      if (!E.alive[i]) { for (let j = 0; j < 8; j++) P[k + j] = 0; A[i * 4] = A[i * 4 + 1] = A[i * 4 + 2] = A[i * 4 + 3] = 0; continue; }
      live++;
      E.vx[i] += p.gravity[0] * dt; E.vy[i] += p.gravity[1] * dt;
      E.x[i] += E.vx[i] * dt; E.y[i] += E.vy[i] * dt; E.rot[i] += spin * dt;
      const u = E.age[i] / E.life[i];
      const size = p.size[0] + (p.size[1] - p.size[0]) * u, h = size / 2;
      const a = Math.min(1, u / 0.08) * Math.min(1, (1 - u) / fade);
      const c = Math.cos(E.rot[i]) * h, s = Math.sin(E.rot[i]) * h;
      P[k] = E.x[i] - c + s; P[k + 1] = E.y[i] - s - c;
      P[k + 2] = E.x[i] + c + s; P[k + 3] = E.y[i] + s - c;
      P[k + 4] = E.x[i] - c - s; P[k + 5] = E.y[i] - s + c;
      P[k + 6] = E.x[i] + c - s; P[k + 7] = E.y[i] + s + c;
      A[i * 4] = A[i * 4 + 1] = A[i * 4 + 2] = A[i * 4 + 3] = a;
    }
    ev.out.opacity[E.mesh] = live ? 1 : 0;
  }

  /** Insert the shown synthetic meshes into the render order. */
  private order: number[] = [];
  private splice(out: EvalOut) {
    const o = this.order;
    o.length = 0;
    const items = [...this.map.atts, ...this.map.ems].filter((x) => out.opacity[x.mesh] > 0);
    if (!items.length) return;
    for (const x of items) if (x.at.above < 0 && !x.at.front) o.push(x.mesh);
    for (let k = 0; k < out.orderCount; k++) {
      const m = out.order[k];
      o.push(m);
      for (const x of items) if (x.at.above === m) o.push(x.mesh);
    }
    const drawn = new Set(o);
    for (const x of items) if (!drawn.has(x.mesh)) o.push(x.mesh);
    const n = Math.min(o.length, out.order.length);
    for (let k = 0; k < n; k++) out.order[k] = o[k];
    out.orderCount = n;
  }
}

/** Current UV offset (u, v) per texture for sprite sheets (§8.10): frame from time × fps or a parameter. */
export function sheetOffsets(doc: Rig2DDoc, time: number, values: Float64Array, paramIndex: (id: string) => number, out: Float32Array) {
  doc.textures.forEach((tx, i) => {
    const sh = tx.sheet;
    if (!sh) { out[i * 2] = 0; out[i * 2 + 1] = 0; return; }
    let f: number;
    if (sh.param) {
      const pi = paramIndex(sh.param), p = doc.params[pi];
      const u = p && p.max > p.min ? (values[pi] - p.min) / (p.max - p.min) : 0;
      f = Math.min(sh.frames - 1, Math.max(0, Math.floor(u * sh.frames)));
    } else {
      const raw = Math.floor(time * (sh.fps ?? 12));
      f = sh.loop === false ? Math.min(raw, sh.frames - 1) : ((raw % sh.frames) + sh.frames) % sh.frames;
    }
    out[i * 2] = (f % sh.cols) / sh.cols; out[i * 2 + 1] = Math.floor(f / sh.cols) / sh.rows;
  });
}


