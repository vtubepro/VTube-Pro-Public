// The 2D avatar maker's live preview through the REAL runtime (the 'rig2d' 2D-avatar kind's own pieces:
// shared/rig2d/evaluate.ts, animate.ts, fx.ts and src/avatar/flat/rig2d/renderer.ts): bones + skinning + chain physics,
// lighting maps, dynamics, the state machine, attachments, costume layers, particles, views, outlines exactly as they
// will look live. Built from the in-memory rig (no PNG round trip), drawn into a 2D canvas over the editor's stage.
// An edit that leaves the art alone keeps the same atlas pages and lighting maps (src/rig2dEditor/editor.ts caches
// them): their canvases are made once and reused, not copied again for every rebuilt preview.
import { augmentRig, Fx, sheetOffsets } from '../../shared/rig2d/fx.ts';
import { RigEval } from '../../shared/rig2d/evaluate.ts';
import { Animator } from '../../shared/rig2d/animate.ts';
import { PARTICLE_BUDGET, eventsSince, lastEventSerial, pushRig2DEvent, rig2dWorld, setRig2DWorld } from '../../shared/rig2d/world.ts';
import { RigGpu, Rig2DRenderer, type RigMaps } from '../avatar/flat/rig2d/renderer.ts';
import type { BuiltRig } from '../../shared/rig2d/edit/vtp2.ts';
import type { LightMaps } from '../../shared/rig2d/edit/maps.ts';
import type { TrackingFrame } from '../../shared/types.ts';

type Page = { w: number; h: number; rgba: Uint8ClampedArray };
/** A page's canvas, made once per page object (a page whose pixels change is a new object: the editor's texChanged). */
const canvases = new WeakMap<Page, HTMLCanvasElement>();
const canvasOf = (p: Page) => {
  let c = canvases.get(p);
  if (c && c.width === p.w && c.height === p.h) return c;
  c = document.createElement('canvas');
  c.width = p.w; c.height = p.h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.w, p.h), 0, 0);
  canvases.set(p, c);
  return c;
};

export class RuntimePreview {
  readonly ev: RigEval;
  readonly anim: Animator;
  private gpu: RigGpu;
  private fx: Fx | null;
  private renderer = Rig2DRenderer.shared();
  private cells: Float32Array | null;
  private serial = lastEventSerial();
  private hotkey: { id: string; until: number } | null = null;
  private time = 0;
  private warm = false;

  /** `prev`: the preview this one replaces (the same rig after an edit): its hair keeps swinging where it was. */
  constructor(readonly built: BuiltRig, maps: LightMaps | null, physics = true, layersOn?: string[], prev?: RuntimePreview | null) {
    const aug = augmentRig(built.doc, built.buffers);
    const images = built.pages.map(canvasOf);
    const m: RigMaps[] = built.pages.map((_, i) => (maps ? { normal: canvasOf(maps.normal[i]), rim: canvasOf(maps.rim[i]), ...(maps.emission ? { emission: canvasOf(maps.emission[i]) } : {}) } : {}));
    this.ev = new RigEval(aug.doc, aug.buffers);
    this.gpu = new RigGpu(aug.doc, aug.buffers, images, maps ? m : []);
    this.anim = new Animator(aug.doc, aug.buffers, this.ev, { physics, ...(layersOn ? { layers: layersOn } : {}) });
    this.fx = aug.fx ? new Fx(aug.doc, aug.fx) : null;
    this.cells = aug.doc.textures.some((t) => t.sheet) ? new Float32Array(aug.doc.textures.length * 2) : null;
    this.renderer.retain();
    if (prev && prev.warm) { this.anim.carryMotionFrom(prev.anim); this.warm = true; this.time = prev.time; }
  }

  /** A chat message / stream event / hotkey for the effects and moods ("Try" buttons). */
  fire(kind: string, value: string) {
    if (kind === 'chat' || kind === 'event') pushRig2DEvent(kind, value);
    else if (kind === 'hotkey') this.hotkey = { id: value, until: this.time + 2 };
  }

  /** Animate from a tracking frame (or hold `values` as they are when `still`), then evaluate. */
  update(frame: TrackingFrame, voice: number, dt: number, time: number, o: { expression?: string | null; still?: (values: Float64Array, idx: (id: string) => number) => void; parts?: (partId: string) => number }) {
    this.time = time;
    const W = rig2dWorld();
    const events = eventsSince(this.serial);
    if (events.length) this.serial = events[events.length - 1].serial;
    const hk = this.hotkey && this.hotkey.until > time ? this.hotkey.id : null;
    if (o.still) {
      // sliders: the values as set; folders shown by views / costumes as the editor computes them
      o.still(this.ev.values, (id) => this.ev.paramIndex(id));
      this.ev.boneAngleAdd.fill(0); // no physics while posing by hand
      const po = this.ev.partOpacity; po.fill(1);
      if (o.parts) this.built.doc.parts.forEach((p, i) => { po[i] = o.parts!(p.id); });
    }
    else {
      // first frame after a (re)build: settle the physics on this pose first, so the hair does not jump in from rest
      if (!this.warm) { this.warm = true; this.ev.update(); for (let i = 0; i < 90; i++) { this.anim.update({ frame, voice, dt: 1 / 60, time: time - (90 - i) / 60, expression: o.expression ?? null, env: { wind: W.wind, windDir: W.windDir, events: [] } }); this.ev.update(); this.anim.afterEvaluate(); } }
      this.anim.update({ frame, voice, dt, time, expression: o.expression ?? null, hotkey: hk, env: { wind: W.wind, windDir: W.windDir, events } });
    }
    this.ev.update();
    if (!o.still) this.anim.afterEvaluate();
    if (this.fx) this.fx.update(this.ev, dt, { voice, values: this.ev.values, paramIndex: (id) => this.ev.paramIndex(id), expression: this.anim.exp.current,
      emotion: this.anim.emotion, hotkey: hk, events, budget: PARTICLE_BUDGET[W.tier], attachmentOn: (i) => this.anim.attachmentOn[i] === 1 });
    if (this.cells) sheetOffsets(this.gpu.doc, time, this.ev.values, (id) => this.ev.paramIndex(id), this.cells);
  }

  /** Draw the rectangle `view` (model units) into ctx (w × h px). light: null = flat; else the test light. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, view: [number, number, number, number], light: { dir: [number, number, number]; color: [number, number, number] } | null) {
    if (light) setRig2DWorld({ key: { dir: [-light.dir[0], -light.dir[1], -light.dir[2]], color: light.color } });
    const W = rig2dWorld();
    ctx.clearRect(0, 0, w, h);
    this.renderer.draw(this.gpu, this.ev.out, { width: w, height: h, view, opacity: this.anim.opacity, cells: this.cells, light: light && this.gpu.lit ? W : null, quality: W.tier }, ctx);
  }

  /** Mesh positions after skinning (the editor's own meshes come first, in the same order). */
  get positions() { return this.ev.out.positions; }

  dispose() { this.renderer.free(this.gpu); this.renderer.release(); }
}
