// The 'rig2d' 2D-avatar kind: VTube Pro's own rigged 2D puppets (.vtp2, docs/RIG2D_FORMAT.md), including Live2D models
// converted on import. Implements the 2D-avatar interface (src/avatar/flat/types.ts): loads ONLY through ctx.files
// (party guests stay in RAM), animates from the tracking / voice / hotkey cue, draws with the page's shared WebGL2
// renderer into this source's own canvas. Registered by src/avatar/flat/kinds.ts (one import line).
import { readVtp2, browserInflateRaw } from '../../../../shared/rig2d/container.ts';
import { RigEval } from '../../../../shared/rig2d/evaluate.ts';
import { Animator, type AnimatorOpts } from '../../../../shared/rig2d/animate.ts';
import { L2D_STANDARD, sanitizeBindings, sanitizeTune, type Rig2DBinding } from '../../../../shared/rig2d/drive.ts';
import type { Rig2DDoc } from '../../../../shared/rig2d/format.ts';
import { registerFlatSource } from '../registry.ts';
import type { FlatDrive, FlatExpression, FlatLoadContext, FlatMotion, FlatSource, FlatSourceFactory } from '../types.ts';
import { RigGpu, Rig2DRenderer, type RigImage, type RigMaps } from './renderer.ts';
import { Fx, augmentRig, sheetOffsets } from '../../../../shared/rig2d/fx.ts';
import { PARTICLE_BUDGET, eventsSince, lastEventSerial, rig2dWorld } from '../../../../shared/rig2d/world.ts';
import { rig2dDecodeScale } from '../../../../shared/rig2d/limits.ts';
import { pickTextureTier, type TierCache, type TierInfo } from './textureTier.ts';
import { buildTiersInBrowser } from './gpuTextures.ts';
import { textureDevice } from '../../../mobile/device.ts';
import { SilhouetteWatch, drawUnionSteps, viewFractions } from '../../../../shared/rig2d/drawUnion.ts';
import { classifyParams, expressionKeys, exprKeyOpts, paramValuesJson, sanitizeParamValues, type ExprKeyOpts } from '../../../../shared/rig2d/userParams.ts';

/** Plain options a profile may carry in flat.opts (validated here; anything else is ignored). */
export function rig2dOpts(v: unknown): AnimatorOpts {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (x: unknown, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : undefined);
  const out: AnimatorOpts = {};
  const b = sanitizeBindings(o.bindings);
  if (b?.length) out.bindings = b;
  if (o.idleMotion === false) out.idleMotion = false;
  if (o.physics === false) out.physics = false;
  const lg = num(o.lipGain, 0, 3), hg = num(o.headGain, 0, 2);
  if (lg !== undefined) out.lipGain = lg;
  if (hg !== undefined) out.headGain = hg;
  // "How much each part moves" (src/ui/rig2dTune.ts): per tracked part, how far up / down it may go (missing = as tracked)
  const tune = sanitizeTune(o.tune);
  if (tune) out.tune = tune;
  if (Array.isArray(o.layers)) out.layers = o.layers.filter((x): x is string => typeof x === 'string').slice(0, 64);
  const pv = sanitizeParamValues(o.params);
  if (pv.size) out.params = paramValuesJson(pv);
  return out;
}

/** The frame shown: the union of the puppet's bounds over its head / body extremes and its expressions (so turning or a
 *  hotkey never crops), padded. `bindings`: the puppet's tracking bindings, so a model with its own parameter names is
 *  framed by ITS head / body parameters (at their full range), not only Cubism's standard ids. */
export function frameBounds(doc: Rig2DDoc, ev: RigEval, bindings: readonly Rig2DBinding[] = []): [number, number, number, number] {
  const poses: Record<string, number>[] = [{}, { ParamAngleX: 30 }, { ParamAngleX: -30 }, { ParamAngleY: 30 }, { ParamAngleY: -30 }, { ParamAngleZ: 30 }, { ParamAngleZ: -30 }, { ParamBodyAngleX: 10 }, { ParamBodyAngleX: -10 }];
  for (const b of bindings) {
    if (b.off || !/^(head|body)(Yaw|Pitch|Roll)$/.test(b.src) || /^Param(Body)?Angle[XYZ]$|^PARAM_/.test(b.param)) continue;
    const q = doc.params.find((x) => x.id === b.param);
    if (q) poses.push({ [q.id]: q.min }, { [q.id]: q.max });
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let rest: [number, number, number, number] | null = null;
  const save = Float64Array.from(ev.values);
  for (const p of poses) {
    ev.values.set(doc.params.map((q) => q.default));
    for (const [k, v] of Object.entries(p)) { let i = ev.paramIndex(k); if (i < 0) for (const a of Object.values(L2D_STANDARD).find((l) => l!.includes(k)) ?? []) { i = ev.paramIndex(a); if (i >= 0) break; } if (i >= 0) ev.values[i] = v; }
    ev.update();
    const b = ev.bounds();
    rest ??= [b[0], b[1], b[2], b[3]];
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  // every expression too (a hotkey that pops an exclamation mark or a prop over the head must not be cut off)
  for (const e of (doc.expressions ?? []).slice(0, 48)) {
    ev.values.set(doc.params.map((q) => q.default));
    for (const p of e.params) {
      const i = ev.paramIndex(p.param);
      if (i < 0) continue;
      const q = doc.params[i], v = p.blend === 'overwrite' ? p.value : p.blend === 'multiply' ? ev.values[i] * p.value : ev.values[i] + p.value;
      ev.values[i] = Math.min(q.max, Math.max(q.min, v));
    }
    ev.update();
    const b = ev.bounds();
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  ev.values.set(save);
  // a bust cut off at its canvas's bottom edge: nothing below the cut is art (a body sway only swings the cut's corners
  // down), and the camera always keeps the cut edge out of view - so the frame ends at the cut. Otherwise the picture
  // gets an empty band under the waist, reads as a figure that does not reach the bottom, and the cut edge shows.
  const ch = doc.canvas?.height ?? 0;
  if (rest && ch > 0 && rest[3] >= ch * 0.985 && y1 > rest[3]) y1 = rest[3];
  const w = x1 - x0, h = y1 - y0, pad = 0.03;
  return [x0 - w * pad, y0 - h * pad, x1 + w * pad, y1 + h * 0.005];
}

/** The rig's parameters for a standard source: its own binding (roles.bind), the roles lists, then the Cubism 3 / 2
 *  standard ids. */
function stdParams(doc: Rig2DDoc, src: 'eyeOpenL' | 'eyeOpenR' | 'mouthOpen' | 'headRoll' | 'headYaw' | 'headPitch', bindings: readonly Rig2DBinding[] = []): string[] {
  const b = doc.roles.bind?.[src];
  // the puppet's own tracking bindings first (a model with its own parameter names: l2dsoak's auto-mapper)
  const own = bindings.filter((x) => !x.off && x.src === src).map((x) => x.param);
  const out = [...own, typeof b === 'string' ? b : b?.param, ...(L2D_STANDARD[src] ?? [])].filter((x): x is string => !!x);
  if (src === 'mouthOpen') out.push(...doc.roles.lipSync);
  if (src === 'eyeOpenL' && doc.roles.eyeBlink[0]) out.push(doc.roles.eyeBlink[0]);
  if (src === 'eyeOpenR' && doc.roles.eyeBlink.length > 1) out.push(doc.roles.eyeBlink[doc.roles.eyeBlink.length - 1]);
  return [...new Set(out)];
}

export interface Rig2DFace {
  /** face centre (between the eyes and the mouth): x from the left, y from the BOTTOM of the frame (fractions) */
  x: number; y: number;
  /** the face (brows → chin, the eyes across), fractions of the frame height: what cameras frame as "the face" */
  size: number;
  /** the whole head (hair, ears, hats, a mascot's whole head) above the face centre, and its half width, fractions of
   *  the frame height (absent: no head parameters) */
  top?: number; half?: number;
}

/** Where the face and the head are ON THE DRAWN PICTURE (the frame `view`, model units), at rest. The eyes, mouth and head
 *  are the visible meshes their parameters move (blink: each eye; mouth open; head turn / tilt / nod); never the canvas
 *  (a converted Live2D model's canvas can be far bigger than the model, off-centre, or mostly empty). Null when the rig
 *  has no eyes and no mouth to find. */
export function findFace(doc: Rig2DDoc, ev: RigEval, view: [number, number, number, number], bindings: readonly Rig2DBinding[] = []): Rig2DFace | null {
  const save = Float64Array.from(ev.values);
  const rest = () => { ev.values.set(doc.params.map((q) => q.default)); ev.update(); };
  rest();
  const base = ev.out.positions.map((p) => p.slice()), shown = Array.from(ev.out.opacity, (o, m) => o > 0.05 && ev.out.enabled[m] === 1);
  const fh = view[3] - view[1], fw = view[2] - view[0];
  /** Positions of the vertices the parameters move (each moved to its far end, one at a time), of meshes visible at
   *  rest (their rest positions) or shown by the move (a closed-eye mesh: where it appears); meshes wider than `maxW` /
   *  taller than `maxH` (frame fractions: a whole-face warp a mouth stretches) are left out. */
  const moved = (ids: string[], first = true, maxW = 1, maxH = 1): { xs: number[]; ys: number[]; meshes: Set<number> } | null => {
    const xs: number[] = [], ys: number[] = [], meshes = new Set<number>();
    for (const id of ids) {
      const i = ev.paramIndex(id);
      if (i < 0) continue;
      const p = doc.params[i];
      for (const to of Math.abs(p.max - p.default) > 1e-9 && Math.abs(p.min - p.default) > 1e-9 ? [p.min, p.max] : [Math.abs(p.min - p.default) > Math.abs(p.max - p.default) ? p.min : p.max]) {
        rest(); ev.values[i] = to; ev.update();
        ev.out.positions.forEach((q, m) => {
          const now = ev.out.opacity[m] > 0.05 && ev.out.enabled[m] === 1;
          if (!shown[m] && !now) return;
          const a = shown[m] ? base[m] : q, appeared = !shown[m] && now;
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          const vx: number[] = [], vy: number[] = [];
          for (let k = 0; k < q.length; k += 2) if (appeared || Math.abs(q[k] - base[m][k]) + Math.abs(q[k + 1] - base[m][k + 1]) > 1e-6) {
            vx.push(a[k]); vy.push(a[k + 1]);
            if (a[k] < x0) x0 = a[k]; if (a[k] > x1) x1 = a[k]; if (a[k + 1] < y0) y0 = a[k + 1]; if (a[k + 1] > y1) y1 = a[k + 1];
          }
          if (!vx.length || x1 - x0 > fw * maxW || y1 - y0 > fh * maxH) return;
          for (let k = 0; k < vx.length; k++) { xs.push(vx[k]); ys.push(vy[k]); }
          meshes.add(m);
        });
      }
      if (first && xs.length) break;   // (the first of the aliases the rig has)
    }
    return xs.length ? { xs, ys, meshes } : null;
  };
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const span = (a: number[]) => Math.max(...a) - Math.min(...a);
  try {
    // eyes: each blink's meshes (a lash that spans both eyes counts once: then the pair's width is that mesh's); a
    // blink that warps half the model is no eye
    const L = moved(stdParams(doc, 'eyeOpenL', bindings), true, 0.6, 0.35), R = moved(stdParams(doc, 'eyeOpenR', bindings), true, 0.6, 0.35);
    const mo = moved(stdParams(doc, 'mouthOpen', bindings), true, 0.45, 0.3);
    if (!L && !R && !mo) return null;
    const eyes = L || R ? (() => {
      const xs = [...(L?.xs ?? []), ...(R?.xs ?? [])], ys = [...(L?.ys ?? []), ...(R?.ys ?? [])];
      const w = span(xs), d = L && R ? Math.hypot(mean(L.xs) - mean(R.xs), mean(L.ys) - mean(R.ys)) : 0;
      // one blink only, or both on the same pair of meshes: the pair's width says it (a single eye's mesh: twice it)
      const pair = d > w * 0.3 ? d : (L && R) || w > fw * 0.12 ? w * 0.55 : w * 1.6;
      const one = !(L && R) && w <= fw * 0.12;
      return { x: mean(xs) + (one ? 0 : 0), y: mean(ys), w: one ? w * 2.6 : w, d: pair };
    })() : null;
    const mouth = mo ? { x: mean(mo.xs), y: mean(mo.ys), w: span(mo.xs) } : null;
    // eyes → mouth (down the picture, model y grows downwards); a sideways or upside-down pair is not trusted
    const em = eyes && mouth && mouth.y > eyes.y ? mouth.y - eyes.y : 0;
    const cx = eyes && mouth ? eyes.x * 0.6 + mouth.x * 0.4 : (eyes ?? mouth)!.x;
    const cy = eyes && mouth ? eyes.y * 0.6 + mouth.y * 0.4 : eyes ? eyes.y + eyes.d * 0.35 : mouth!.y - mouth!.w * 0.8;
    // the face: brows → chin and across the eyes (the same measure 3D faces report: tileCams / talk cams frame it)
    let size = eyes ? Math.max(eyes.w * 1.25, em * 2.6, eyes.d * 1.6) : mouth!.w * 4;
    const chin = eyes && mouth ? mouth.y + Math.max(em * 0.9, mouth.w * 0.3) : cy + size * 0.5;
    // the head: everything the head turn / tilt / nod moves above the chin (hair, ears, hats, a mascot's whole head)
    let top: number | undefined, half: number | undefined;
    // (rigs that turn the head through physics outputs — ParamAugAngleX, AngleXPhysic …: any angle / head parameter
    // that isn't the body's or a limb's)
    let hd = moved([...stdParams(doc, 'headRoll', bindings), ...stdParams(doc, 'headYaw', bindings), ...stdParams(doc, 'headPitch', bindings)], false);
    if (!hd) hd = moved(doc.params.filter((p) => /angle|head/i.test(p.id) && !/body|arm|hand|leg|foot|tail|wing|eye|brow|mouth/i.test(p.id)).map((p) => p.id), false);
    if (hd) {
      let t = Infinity, hw = 0;
      for (let k = 0; k < hd.xs.length; k++) if (hd.ys[k] <= chin) { t = Math.min(t, hd.ys[k]); hw = Math.max(hw, Math.abs(hd.xs[k] - cx)); }
      // (sane: above the face, and not the whole picture's height above it)
      if (Number.isFinite(t) && t < cy && cy - t < fh * 0.95) { top = cy - t; half = hw; }
    }
    // a face is never bigger than its head (a mascot's eyes sit wide on a small face)
    if (top !== undefined) size = Math.min(size, Math.max(top + (chin - cy), size * 0.5));
    const H = fh;
    return {
      x: (cx - view[0]) / fw, y: 1 - (cy - view[1]) / H, size: Math.min(1, Math.max(0.02, size / H)),
      ...(top !== undefined ? { top: Math.min(1, top / H), half: Math.min(1, (half ?? 0) / H) } : {}),
    };
  } finally { ev.values.set(save); ev.update(); }
}

/** The expressions the studio offers (hotkeys, the 2D panel): the rig's own keys (a VTube Studio import keeps the
 *  model's) unless the studio / the browser keeps that key, and the free number keys 1..9 in order for the rest — never
 *  a key another expression, or one of the model's own motion hotkeys, already has (shared/rig2d/userParams.ts
 *  expressionKeys). */
export function rig2dExpressionList(doc: Rig2DDoc, ko: ExprKeyOpts = {}): FlatExpression[] {
  // the model's own hotkeys for its motions (e.g. from its VTube Studio file) keep their keys too
  const motionKeys = (doc.motions ?? []).map((m) => m.key).filter((k): k is string => !!k);
  return expressionKeys(doc, motionKeys.length ? { ...ko, taken: [...(ko.taken ?? []), ...motionKeys] } : ko);
}

class Rig2DSource implements FlatSource {
  readonly kind = 'rig2d';
  readonly canvas: HTMLCanvasElement;
  /** the picture's size: set at load from the profile's resolution, raised for close-ups / 4K output (setDetail) */
  width: number;
  height: number;
  /** the height the profile asks for (the picture never goes below it) and the most this page draws */
  readonly baseHeight: number;
  readonly maxHeight: number;
  private aspect: number;
  private demoteSince = 0;
  readonly premultiplied = false;
  version = 0;
  private ctx2d: CanvasRenderingContext2D;
  private renderer = Rig2DRenderer.shared();
  private held: string | null = null;
  private faceBox: Rig2DFace | null;
  private depthOffsets: Float32Array | null;
  private meshDepth: Float32Array | null;
  private yawIdx: number;
  private pitchIdx: number;
  private disposed = false;
  private fx: Fx | null;
  private cells: Float32Array | null;
  private eventSerial = lastEventSerial();
  /** where the texture pages came from (tier cache / original pictures), their memory: textureTier.ts TierInfo */
  textures: TierInfo | null = null;
  /** …as they were when the model loaded (before a swap to the compressed pages) */
  texturesAtLoad: TierInfo | null = null;
  /** CPU time per frame for the rig itself (animate + evaluate + effects), ms, smoothed; shown in the 2D panel */
  cpuMs = 0;
  /** time spent drawing (GL submission + the copy into this source's canvas), ms, smoothed */
  drawMs = 0;
  constructor(readonly doc: Rig2DDoc, private gpu: RigGpu, readonly ev: RigEval, readonly anim: Animator, private view: [number, number, number, number], res: number, private images: RigImage[], fx: Fx | null) {
    this.fx = fx;
    this.cells = doc.textures.some((t) => t.sheet) ? new Float32Array(doc.textures.length * 2) : null;
    const aspect = (view[2] - view[0]) / (view[3] - view[1]);
    // (the picture: up to 2048 px tall, 4096 on a desktop GPU that can take it: 4K output / close-ups, HQ decision #10)
    this.aspect = aspect;
    this.maxHeight = Math.round(outputCap() / Math.max(1, aspect));
    this.height = this.baseHeight = Math.round(Math.min(res, this.maxHeight));
    this.width = Math.max(16, Math.round(this.height * aspect));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width; this.canvas.height = this.height;
    this.ctx2d = this.canvas.getContext('2d')!;
    this.renderer.retain();
    this.faceBox = findFace(doc, ev, view, anim.bindings);
    // 2.5D: each mesh's depth = its own + its parts' (summed up the part tree)
    const d = doc.depth;
    this.yawIdx = d?.yaw ? ev.paramIndex(d.yaw) : -1;
    this.pitchIdx = d?.pitch ? ev.paramIndex(d.pitch) : -1;
    if (d && (this.yawIdx >= 0 || this.pitchIdx >= 0)) {
      const partDepth = new Float32Array(doc.parts.length);
      doc.parts.forEach((p, i) => { partDepth[i] = (p.depth ?? 0) + (p.parent >= 0 && p.parent < i ? partDepth[p.parent] : 0); });
      this.meshDepth = Float32Array.from(doc.meshes.map((m) => (m.depth ?? 0) + (m.part >= 0 ? partDepth[m.part] : 0)));
      this.depthOffsets = new Float32Array(doc.meshes.length * 2);
    } else { this.meshDepth = null; this.depthOffsets = null; }
  }
  face() { return this.faceBox; }
  /** Bumped when what the rig can show changes after load — its outfit layers switched, a model slider that changes the
   *  silhouette moved and settled (SilhouetteWatch), new saved options (applyOpts): the display side then measures
   *  contentBoundsSteps again in idle time (FlatAvatar.remeasure) and eases its cameras to the new framing. */
  boundsVersion = 0;
  private watch: SilhouetteWatch | null = null;
  private sliders: string[] | null = null;
  /** The performer's model sliders (classifyParams' user parameters for the current tracking bindings). */
  private sliderIds(): string[] { return (this.sliders ??= classifyParams(this.doc, this.anim.bindings).user.map((u) => u.id)); }
  private watchFor(): SilhouetteWatch { return (this.watch ??= new SilhouetteWatch(this.doc, this.ev, this.sliderIds())); }
  private togCache = new Map<string, boolean>();
  /** Does this expression set one of the watched sliders (an outfit toggle that changes the silhouette)? */
  private togglesSlider(id: string): boolean {
    let v = this.togCache.get(id);
    if (v === undefined) { const mv = this.watchFor().moving; v = !!this.doc.expressions?.find((e) => e.id === id)?.params.some((p) => mv.some((m) => m.id === p.param)); this.togCache.set(id, v); }
    return v;
  }
  /** Build the silhouette watch now (at load, with the rest of the rig: never on the first frame on air). */
  prepareWatch() { this.watchFor(); }
  private layersOn: boolean[] = [];
  /** Everything it can draw (drawUnionSteps), picture fractions: run in idle slices by the display side. */
  *contentBoundsSteps(live = false): Generator<void, { x0: number; x1: number; y0: number; y1: number } | null, void> {
    const held = new Set(this.sliderIds()), now = live ? Float64Array.from(this.ev.values) : undefined;
    let b = yield* drawUnionSteps(this.doc, this.ev, now, held);
    // (a slider / outfit toggle still fading in: also where it is heading — the camera widens WHILE the jacket appears)
    const to = live ? this.targetValues() : null;
    if (to && now && to.some((v, i) => Math.abs(v - now[i]) > 1e-6)) {
      const t = yield* drawUnionSteps(this.doc, this.ev, to, held);
      if (t) b = b ? [Math.min(b[0], t[0]), Math.min(b[1], t[1]), Math.max(b[2], t[2]), Math.max(b[3], t[3])] : t;
    }
    return b ? viewFractions(b, this.view) : null;
  }
  private lastCue: FlatDrive['cue'];
  /** The live values with every slider at its cue target and every toggled expression fully on (where a fade is
   *  heading); null without a cue. */
  private targetValues(): Float64Array | null {
    const cue = this.lastCue;
    if (!cue?.p && !cue?.x?.length) return null;
    const v = Float64Array.from(this.ev.values), P = this.doc.params;
    for (const [id, e] of Object.entries(cue.p ?? {})) { const i = this.ev.paramIndex(id); if (i >= 0 && Array.isArray(e)) v[i] = Math.min(Math.max(P[i].min, P[i].max), Math.max(Math.min(P[i].min, P[i].max), e[0])); }
    for (const x of cue.x ?? []) {
      const e = this.doc.expressions?.find((q) => q.id === x);
      for (const p of e?.params ?? []) { const i = this.ev.paramIndex(p.param); if (i < 0) continue; const q = P[i], w = p.blend === 'overwrite' ? p.value : p.blend === 'multiply' ? v[i] * p.value : v[i] + p.value; v[i] = Math.min(q.max, Math.max(q.min, w)); }
    }
    return v;
  }
  /** The silhouette's state for SilhouetteWatch: the moving sliders' TARGETS (a fade counts once, at its start) and
   *  the toggled expressions that set one of them. */
  private silValue(id: string): number { const e = this.lastCue?.p?.[id]; return Array.isArray(e) ? e[0] : this.ev.values[this.ev.paramIndex(id)] ?? 0; }
  update(d: FlatDrive) {
    if (this.disposed) return;
    const t0 = performance.now();
    const cue = d.cue, W = rig2dWorld();
    const dt = Math.min(0.1, Math.max(0, d.dt));
    const exp = this.held ?? (cue?.s && this.doc.expressions?.some((e) => e.id === cue.s) ? cue.s : null);
    const events = W.events.length && W.events[W.events.length - 1].serial > this.eventSerial ? eventsSince(this.eventSerial) : NO_EVENTS;
    if (events.length) this.eventSerial = events[events.length - 1].serial;
    this.anim.update({ frame: d.frame, voice: d.voice, dt, time: d.time, expression: exp, motion: cue?.m ?? null, hotkey: cue?.s ?? null, env: { wind: W.wind, windDir: W.windDir, events }, user: cue?.p, toggles: cue?.x });
    // (the silhouette's state — outfit layers, the sliders that move meshes: a settled change → measure the art again)
    {
      this.lastCue = cue;
      const w = this.watchFor(), L = this.doc.layers ?? [];
      if (this.layersOn.length !== L.length) this.layersOn = L.map(() => false);
      for (let i = 0; i < L.length; i++) this.layersOn[i] = this.anim.layerOn(L[i].id);
      // (the toggled outfits that set a watched slider, as one number: a string hash, no allocation)
      let tog = 0;
      for (const x of cue?.x ?? []) if (this.togglesSlider(x)) for (let i = 0; i < x.length; i++) tog = (tog * 31 + x.charCodeAt(i)) % 2147483647;
      if (w.update(w.key(this.layersOn, (id) => this.silValue(id), tog), d.time)) this.boundsVersion++;
    }
    this.ev.update();
    this.anim.afterEvaluate();
    if (this.fx) this.fx.update(this.ev, dt, { voice: d.voice, values: this.ev.values, paramIndex: (id) => this.ev.paramIndex(id), expression: this.anim.exp.current,
      emotion: this.anim.emotion, hotkey: cue?.s ?? null, toggled: this.anim.toggled, events, budget: PARTICLE_BUDGET[W.tier], attachmentOn: (i) => this.anim.attachmentOn[i] === 1 });
    if (this.cells) sheetOffsets(this.doc, d.time, this.ev.values, (id) => this.ev.paramIndex(id), this.cells);
    if (this.meshDepth && this.depthOffsets) {
      const unit = this.doc.canvas.unit ?? 1, k = (this.doc.depth?.strength ?? 0.4) / unit;
      const sy = this.yawIdx >= 0 ? Math.sin(this.ev.values[this.yawIdx] * Math.PI / 180) : 0;
      const sp = this.pitchIdx >= 0 ? Math.sin(this.ev.values[this.pitchIdx] * Math.PI / 180) : 0;
      for (let i = 0; i < this.meshDepth.length; i++) { this.depthOffsets[i * 2] = this.meshDepth[i] * sy * k; this.depthOffsets[i * 2 + 1] = -this.meshDepth[i] * sp * k; }
    }
    const t1 = performance.now();
    this.renderer.draw(this.gpu, this.ev.out, { width: this.width, height: this.height, view: this.view, opacity: this.anim.opacity, offsets: this.depthOffsets,
      cells: this.cells, light: this.gpu.lit ? W : null, quality: W.tier }, this.ctx2d);
    this.version++;
    const t2 = performance.now(), ms = t1 - t0, dm = t2 - t1;
    this.cpuMs = this.cpuMs ? this.cpuMs * 0.95 + ms * 0.05 : ms;
    this.drawMs = this.drawMs ? this.drawMs * 0.95 + dm * 0.05 : dm;
  }
  /** the performer's expression keys + their slider keys (profile.flat.opts: exprKeys, paramTriggers) */
  keyOpts: ExprKeyOpts = {};
  expressions(): FlatExpression[] {
    return rig2dExpressionList(this.doc, this.keyOpts);
  }
  /** New flat.opts without a reload (src/avatar/flat/rig2d/liveOpts.ts). */
  applyOpts(opts: unknown) {
    this.anim.applyOpts(rig2dOpts(opts)); this.keyOpts = exprKeyOpts(opts);
    // (saved outfit layers / slider positions / tracking bindings may change the silhouette and which sliders exist)
    this.watch = null; this.sliders = null; this.togCache.clear();
    this.watchFor();
    this.boundsVersion++;
  }
  /** What a re-pick needs (loadRig2D sets it): the model as read, its files, the tier cache, the full-quality choice. */
  tierCtx: { doc: Rig2DDoc; files: Map<string, Uint8Array>; buffers: readonly Uint8Array[]; augBuffers: readonly Uint8Array[]; cache: TierCache | null; fullQuality?: boolean | number[] } | null = null;
  private retiering = false;
  /** Re-pick the texture tiers for a picture `outputPx` tall (before a close-up / 4K output: promotion is immediate,
   *  demotion only when the smaller tier is comfortably enough: shared/rig2d/gpu/pick.ts). Swaps the pages without a
   *  reload; resolves whether anything changed. */
  private retierNext = 0;
  async retier(outputPx: number): Promise<boolean> {
    const c = this.tierCtx;
    if (!c || this.disposed) return false;
    // (one at a time; a newer request made meanwhile runs right after, with the newest size)
    if (this.retiering) { this.retierNext = outputPx; return false; }
    this.retiering = true;
    try {
      const t = await pickTextureTier(c.doc, c.files, textureDevice(outputPx), { buffers: c.buffers, cache: c.cache, fullQuality: c.fullQuality, prev: this.textures?.tiers });
      const imgs: RigImage[] = t.pages.map((p) => (p.kind === 'image' ? p.image : p));
      if (this.disposed || (t.info && this.textures && t.info.tiers.join() === this.textures.tiers.join() && t.info.status === this.textures.status)) {
        for (const b of imgs) if ('close' in b) b.close();
        return false;
      }
      const gpu = new RigGpu(this.doc, c.augBuffers, imgs, this.gpu.maps, t.layout);
      // the new pages go up in parts between frames (about UPLOAD_MB each step, in strips of rows: a 4096 BC7 page with
      // its mips is ~21 MB), while the current tier keeps drawing; the swap happens when all of them are there
      const step = ((globalThis as { __vtpHiqUploadMB?: number }).__vtpHiqUploadMB ?? UPLOAD_MB) * 1048576;
      while (!this.renderer.prepare(gpu, step)) {
        await new Promise((r) => setTimeout(r, 16));
        if (this.disposed) { this.renderer.free(gpu); for (const b of imgs) if ('close' in b) b.close(); return false; }
      }
      this.renderer.free(this.gpu);
      for (const b of this.images) if ('close' in b) b.close();
      this.gpu = gpu; this.images = imgs; this.textures = t.info ?? null;
      return true;
    } finally {
      this.retiering = false;
      const next = this.retierNext;
      if (next) { this.retierNext = 0; void this.retier(next).catch(() => undefined); }
    }
  }
  /** The picture is shown `px` tall on screen right now (the biggest use: card in a close-up, overlay, 4K output; or
   *  the next camera shot, before the cut). Grows the picture and promotes the texture tier at once when it is shown
   *  noticeably bigger than it is drawn; shrinks back toward the profile's size only after it has been comfortably
   *  smaller for 2 s (no flipping between shots). `now` = seconds (performance.now() / 1000). */
  setDetail(px: number, now = performance.now() / 1000): void {
    if (this.disposed || !Number.isFinite(px) || px <= 0) return;
    const want = Math.max(this.baseHeight, Math.min(this.maxHeight, Math.ceil(px / 64) * 64));
    if (want > this.height * 1.15) { this.demoteSince = 0; this.resize(want); return; }
    if (want < this.height / 1.6 && this.height > this.baseHeight) {
      if (!this.demoteSince) { this.demoteSince = now; return; }
      if (now - this.demoteSince >= 2) { this.demoteSince = 0; this.resize(Math.max(this.baseHeight, want)); }
      return;
    }
    this.demoteSince = 0;
  }
  private resize(h: number) {
    if (h === this.height) return;
    this.height = h; this.width = Math.max(16, Math.round(h * this.aspect));
    this.canvas.width = this.width; this.canvas.height = this.height;
    this.version++;
    // the texture tier for the new size (promotion at once, demotion with hysteresis: shared/rig2d/gpu/pick.ts)
    void this.retier(h).catch(() => undefined);
  }
  setExpression(id: string | null) { this.held = id && this.doc.expressions?.some((e) => e.id === id) ? id : null; }
  motions(): FlatMotion[] {
    const seen = new Map<string, number>();
    return (this.doc.motions ?? []).filter((m) => !/^idle$/i.test(m.group)).map((m) => { const i = seen.get(m.group) ?? 0; seen.set(m.group, i + 1); return { group: m.group, index: i, name: m.name, ...(m.key ? { key: m.key } : {}) }; });
  }
  playMotion(group: string, index: number) { this.anim.playMotion(group, index); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.free(this.gpu);
    this.renderer.release();
    for (const b of this.images) if ('close' in b) b.close();
    for (const m of this.gpu.maps) for (const b of [m?.normal, m?.emission, m?.rim]) if (b && 'close' in b) (b as ImageBitmap).close();
    this.images = [];
    this.canvas.width = this.canvas.height = 0;
  }
}

/** Load a .vtp2 from bytes (also used by the test viewer). */
export async function loadRig2D(bytes: Uint8Array, res: number, opts: AnimatorOpts = {}, tiers: { cache?: TierCache | null; fullQuality?: boolean | number[] } = {}): Promise<Rig2DSource> {
  const r = await readVtp2(bytes, browserInflateRaw);
  if (!r.ok) throw new Error(r.error);
  const { files } = r.pkg;
  // the texture pages for this device: the hiq lane's hook (src/avatar/flat/rig2d/textureTier.ts; RGBA8 or GPU-compressed)
  let tier: Awaited<ReturnType<typeof pickTextureTier>>;
  try { tier = await pickTextureTier(r.pkg.doc, files, textureDevice(res), { buffers: r.pkg.buffers, cache: tiers.cache, fullQuality: tiers.fullQuality }); }
  catch (e) { throw new Error(`A texture of this 2D model can't be read (${(e as Error).message}).`); }
  // attachments + particle emitters become extra meshes (shared/rig2d/fx.ts)
  const aug = augmentRig(tier.doc, r.pkg.buffers);
  const doc = aug.doc, buffers = aug.buffers;
  const images: RigImage[] = tier.pages.map((p) => (p.kind === 'image' ? p.image : p));
  const maps: RigMaps[] = [];
  // decoded memory: the pages are decoded one at a time, and when all of them together would exceed this device's
  // decode budget (shared/rig2d/limits.ts rig2dDecodeBudget) every page is decoded scaled down to fit: a high-quality
  // model always loads (UVs are relative, so the art just gets a little softer)
  const pages: { width: number; height: number }[] = [];
  // (the art pages are textureTier.ts's: only lighting maps are decoded here)
  for (const t of doc.textures) for (const f of [t.normal, t.emission, t.rim]) if (f && files.has(f)) pages.push(t);
  const k = rig2dDecodeScale(pages);
  if (k < 1) console.warn(`[rig2d] textures decoded at ${Math.round(k * 100)} % to fit this device's texture memory budget`);
  const mime = (f: string) => (/\.webp$/i.test(f) ? 'image/webp' : /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/png');
  const decode = (f: string, premul: boolean, w: number, h: number) => createImageBitmap(new Blob([files.get(f)!.slice()], { type: mime(f) }), {
    premultiplyAlpha: premul ? 'premultiply' : 'none', colorSpaceConversion: 'none',
    ...(k < 1 ? { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high' as const } : {}) });
  try {
    for (const t of doc.textures) {
      const m: RigMaps = {};
      // lighting maps: normal / rim keep their raw values (not premultiplied); emission is light, premultiplied like art
      if (t.normal && files.has(t.normal)) m.normal = await decode(t.normal, false, t.width, t.height);
      if (t.emission && files.has(t.emission)) m.emission = await decode(t.emission, true, t.width, t.height);
      if (t.rim && files.has(t.rim)) m.rim = await decode(t.rim, false, t.width, t.height);
      maps.push(m);
    }
  } catch (e) { for (const b of images) if ('close' in b) b.close(); throw new Error(`A texture of this 2D model can't be read (${(e as Error).message}).`); }
  const ev = new RigEval(doc, buffers);
  const gpu = new RigGpu(doc, buffers, images, maps, tier.layout);
  let view = frameBounds(doc, ev, opts.bindings ?? Animator.autoBindings(doc));
  if (aug.fx) { const w = view[2] - view[0], h = view[3] - view[1]; view = [view[0] - w * 0.12, view[1] - h * 0.06, view[2] + w * 0.12, view[3]]; }
  const anim = new Animator(doc, buffers, ev, opts);
  const src = new Rig2DSource(doc, gpu, ev, anim, view, res, images, aug.fx ? new Fx(doc, aug.fx) : null);
  src.textures = src.texturesAtLoad = tier.info ?? null;
  src.tierCtx = { doc: r.pkg.doc, files, buffers: r.pkg.buffers, augBuffers: buffers, cache: tiers.cache ?? null, fullQuality: tiers.fullQuality };
  return src;
}
const NO_EVENTS: never[] = [];

/** Texture bytes a tier switch uploads per step (tools/hiq_e2e.mts measures the frame times while it runs). */
const UPLOAD_MB = 6;

/** The tallest picture a 2D rig draws: 2048 px, or 4096 on a desktop GPU (not software, MAX_TEXTURE_SIZE ≥ 8192). */
function outputCap(): number {
  try { const d = textureDevice(1024); return d.deviceClass === 'desktop' && !d.software && d.maxTexture >= 8192 ? 4096 : 2048; } catch { return 2048; }
}

/** The one status line while the helper makes the compressed tiers (zero-effort rule: the model already works). */
export const HIQ_STATUS = 'Making your model sharper and lighter… you can use it now.';

/** This server always makes the tier caches this studio reads: the page may always ask. */
const helperMakesOurTiers = async (): Promise<boolean> => true;

/** Every tier cache this page asked for, by `${avatar id}|${key}`: its answer. A reload of the avatar or a close-up's
 *  re-pick (both end in request() while the cache is missing) waits for that answer and never asks again: a helper that
 *  answers 'none' (it made another key) is never asked in a loop. Forgotten when the helper wasn't reachable or wasn't
 *  asked (too old), so a later load asks once it is back / updated. */
const tierAsked = new Map<string, Promise<boolean>>();

/** The tier cache of the avatar being loaded: its files (own folder or party bundle). Own avatars ask the helper to make
 *  it (POST /api/avatars/:id/gpu), once per page (tierAsked) and never a helper older than this studio (mayAsk); a web
 *  studio without the helper (503) makes the ≤ 4096 tiers in a browser worker (gpuTextures.ts buildTiersInBrowser).
 *  Either way the model keeps drawing from its original pictures meanwhile, and swaps to the compressed pages when they
 *  are ready (Rig2DSource.retier). `mayAsk`: tests (tools/hiq_request_unit.ts). */
export function tierCache(ctx: FlatLoadContext, model: Uint8Array, mayAsk: () => Promise<boolean> = helperMakesOurTiers): TierCache & { whenReady?: (src: Rig2DSource) => void } {
  const f = ctx.files, id = ctx.profile.id;
  let job: Promise<boolean> | null = null;
  /** the helper's build: poll its state (every 5 s, up to an hour); null = the helper didn't answer */
  const helperDone = async (key: string): Promise<boolean | null> => {
    for (let i = 0; i < 720; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const s = await (await fetch(`/api/avatars/${encodeURIComponent(id)}/gpu?key=${key}`)).json() as { state?: string };
        if (s.state === 'done') return true;
        if (s.state === 'failed' || s.state === 'none') return false;
      } catch { return null; }
    }
    return false;
  };
  return {
    read: async (rel) => {
      if (f.sealed && !(f.list()?.includes(rel))) return null;
      try { return new Uint8Array(await f.bytes(rel)); } catch { return null; }
    },
    ...(f.sealed ? {} : {
      request: (key: string) => {
        const ask = `${id}|${key}`, asked = tierAsked.get(ask);
        if (asked) { job = asked; return; }
        const forget = () => { tierAsked.delete(ask); return false; };
        const copy = model.slice();   // (the loader zeroes its bytes after loading)
        job = mayAsk().catch(() => true).then((may) => {
          if (!may) { copy.fill(0); return forget(); }
          return fetch(`/api/avatars/${encodeURIComponent(id)}/gpu`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })
            .then(async (r) => {
              if (r.status === 503) return buildTiersInBrowser(id, copy, key).then(() => true, (e) => { console.warn(`[rig2d] lighter textures not made in this browser: ${(e as Error).message}`); return false; });
              copy.fill(0);
              return r.ok ? (await helperDone(key)) ?? forget() : false;
            }, () => { copy.fill(0); return forget(); });
        }).catch(() => false);
        tierAsked.set(ask, job);
      },
      // (nothing is being made after all: the 2D panel then says the original pictures are drawn, not "Making…")
      whenReady: (src: Rig2DSource) => { void job?.then((ok) => { if (ok) void src.retier(src.height).catch(() => undefined); else if (src.textures?.building) src.textures = { ...src.textures, building: false }; }); },
    }),
  };
}

let hasGl2: boolean | undefined;
export const rig2dFactory: FlatSourceFactory = {
  kind: 'rig2d',
  label: 'Pro2D',
  available() {
    hasGl2 ??= (() => { try { return typeof WebGL2RenderingContext !== 'undefined' && !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
    return hasGl2 ? { ok: true } : { ok: false, why: 'This browser can’t draw 2D models: turn on “hardware acceleration” in the browser settings, then reload.' };
  },
  async load(ctx: FlatLoadContext) {
    ctx.onStatus?.('Loading the 2D model…');
    const bytes = new Uint8Array(await ctx.files.bytes(ctx.config.main));
    const opts = rig2dOpts(ctx.config.opts);
    // the model's texture tier cache (server/gpuTiers.ts; read from the avatar's own folder, or a party bundle in RAM)
    const fq = (ctx.config.opts as { fullQuality?: unknown } | undefined)?.fullQuality;
    const fullQuality = fq === true ? true : Array.isArray(fq) ? fq.filter((x): x is number => Number.isInteger(x) && x >= 0).slice(0, 256) : undefined;
    const cache = tierCache(ctx, bytes);
    const src = await loadRig2D(bytes, ctx.res, opts, { cache, fullQuality });
    if (src.textures?.building) { ctx.onStatus?.(HIQ_STATUS); cache.whenReady?.(src); }
    src.keyOpts = exprKeyOpts(ctx.config.opts);
    // the avatar's costume list (studio wardrobe) picks a costume layer by id or name (docs/RIG2D_FORMAT.md §8.8)
    const costume = (ctx.profile as { costume?: string | null }).costume;
    if (costume) { const l = src.doc.layers?.find((x) => x.id === costume || x.name.toLowerCase() === String(costume).toLowerCase()); if (l) src.anim.setLayer(l.id, true); }
    src.prepareWatch();   // (its slider test runs here, at load: never on the first frame on air)
    bytes.fill(0); // party custody: drop our copy of the file bytes
    return src;
  },
};

registerFlatSource(rig2dFactory);
