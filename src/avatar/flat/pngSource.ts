// Kind 'png': PNG / APNG / GIF / WebP / JPEG image sets ("PNGTuber"). Idle ↔ talking from the voice (VoiceGate:
// threshold, hysteresis, attack, hold), blink pictures (the performer's own blinks with the camera on, else a timer),
// expression states with their own pictures, animated pictures playing on one shared clock, and head tilt / sway from
// the face tracking as a cheap pose (FlatPose) the display side applies without redrawing. The talk motions (hop,
// wobble, glow …) come from the display side (shared/flatTalk.ts). The canvas is only redrawn when the picture or its animation frame changes.
import { BlinkTimer, FLAT_PNG_DEFAULTS, VoiceGate, type FlatPngConfig, type FlatPngState } from '../../../shared/flatAvatar.ts';
import { closePicture, decodePicture, frameAt, type DecodedPicture } from './frames.ts';
import { registerFlatSource } from './registry.ts';
import { drawnRect } from './measure.ts';
import { unionRect, type ContentRect } from '../../../shared/flatFraming.ts';
import type { FlatDrive, FlatExpression, FlatLoadContext, FlatPose, FlatSource } from './types.ts';

type Look = Pick<FlatPngState, 'idle' | 'talk' | 'blink' | 'talkBlink'>;

/** Which picture shows (pure: tests). A state without its own talk / blink picture falls back to its idle one. */
export function pickPicture(look: Look, talking: boolean, closed: boolean): string {
  if (talking) return closed ? look.talkBlink ?? look.talk ?? look.idle : look.talk ?? look.idle;
  return closed ? look.blink ?? look.idle : look.idle;
}

export class PngSource implements FlatSource {
  readonly kind = 'png';
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly premultiplied = false;
  readonly pixelated: boolean;
  version = 0;
  readonly pose: FlatPose = { x: 0, y: 0, rot: 0, sx: 1, sy: 1 };
  talking = false;
  /** Debug / tests: what shows now. */
  readonly state = { talking: false, closed: false, picture: '', frame: 0, expression: null as string | null };
  private ctx: CanvasRenderingContext2D;
  private gate: VoiceGate;
  private blink: BlinkTimer;
  private expr: FlatPngState | null = null;
  private drawn = '';
  private disposed = false;

  private constructor(private cfg: FlatPngConfig, private pics: Map<string, DecodedPicture>, res: number) {
    const idle = pics.get(cfg.idle)!;
    // the canvas: the idle picture's aspect at the render height (pictures are drawn into it bottom-centred)
    this.height = Math.max(64, Math.min(res, Math.max(idle.height, 256)));
    this.width = Math.max(16, Math.round(this.height * (idle.width / idle.height)));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width; this.canvas.height = this.height;
    const ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.pixelated = cfg.pixelated;
    this.gate = new VoiceGate(cfg.gate);
    this.blink = new BlinkTimer(cfg.blinkTimer, Math.floor(Math.random() * 1e9));
  }

  static async load(ctx: FlatLoadContext): Promise<PngSource> {
    const cfg: FlatPngConfig = ctx.config.png ?? { idle: ctx.config.main, ...structuredClone(FLAT_PNG_DEFAULTS) };
    const names = new Set<string>();
    for (const l of [cfg as Look, ...cfg.states]) for (const k of ['idle', 'talk', 'blink', 'talkBlink'] as const) if (l[k]) names.add(l[k]!);
    const pics = new Map<string, DecodedPicture>();
    try {
      let n = 0;
      for (const f of names) {
        ctx.onStatus?.(`Loading pictures… ${++n}/${names.size}`);
        try { pics.set(f, await decodePicture(await ctx.files.bytes(f), ctx.res)); }
        catch (e) { if (f === cfg.idle) throw new Error(`The idle picture (${f}) could not be read: ${(e as Error).message}`); console.warn('[flat] picture skipped', f, e); }
      }
      // a missing picture: the look falls back to the next one (pickPicture), so drop the names that didn't load
      const keep = (l: Look): Look => ({ idle: pics.has(l.idle) ? l.idle : cfg.idle, ...(l.talk && pics.has(l.talk) ? { talk: l.talk } : {}),
        ...(l.blink && pics.has(l.blink) ? { blink: l.blink } : {}), ...(l.talkBlink && pics.has(l.talkBlink) ? { talkBlink: l.talkBlink } : {}) });
      const clean: FlatPngConfig = { ...cfg, ...keep(cfg), states: cfg.states.map((s) => ({ ...s, ...keep(s) })) };
      if (!clean.talk) delete clean.talk; if (!clean.blink) delete clean.blink; if (!clean.talkBlink) delete clean.talkBlink;
      return new PngSource(clean, pics, ctx.res);
    } catch (e) { for (const p of pics.values()) closePicture(p); throw e; }
  }

  face() { return null; }
  expressions(): FlatExpression[] { return this.cfg.states.map((s) => ({ id: s.id, name: s.name, ...(s.key ? { key: s.key } : {}) })); }
  setExpression(id: string | null) {
    this.expr = id ? this.cfg.states.find((s) => s.id === id) ?? null : null;
    this.state.expression = this.expr?.id ?? null;
  }

  update(d: FlatDrive) {
    if (this.disposed) return;
    const dt = Math.max(0, Math.min(0.1, d.dt));
    const f = d.frame;
    const gated = this.gate.step(d.voice, dt);
    // (the swap off: the idle picture stays; the motions still follow the gate)
    const talking = gated && d.talk.swap;
    this.talking = gated;
    // blinks: the performer's own with the camera on (and a blink picture to show it), else the timer
    const look: Look = this.expr ?? this.cfg;
    let closed = false;
    if (look.blink || look.talkBlink) {
      if (f.tracked) closed = ((f.face.eyeBlinkLeft ?? 0) + (f.face.eyeBlinkRight ?? 0)) / 2 > 0.55;
      else closed = this.blink.step(dt);
    }
    const pic = pickPicture(look, talking, closed);
    const P = this.pics.get(pic) ?? this.pics.get(this.cfg.idle)!;
    const fi = frameAt(P, d.time * 1000);
    const key = `${pic}#${fi}`;
    if (key !== this.drawn) this.draw(P, fi, key);
    Object.assign(this.state, { talking, closed, picture: pic, frame: fi });

    // head tilt (roll) + sway (yaw) when the camera sees the face; a slow idle sway otherwise
    const tracked = f.tracked;
    const rotT = tracked ? Math.max(-0.4, Math.min(0.4, f.head[2] * 0.8 * this.cfg.follow.tilt)) : 0.025 * Math.sin(d.time * 0.9) * this.cfg.follow.tilt;
    const xT = tracked ? Math.max(-0.12, Math.min(0.12, Math.sin(f.head[0]) * 0.12 * this.cfg.follow.sway)) : 0;
    const k = 1 - Math.exp(-12 * dt);
    const p = this.pose;
    p.rot += (rotT - p.rot) * k; p.x += (xT - p.x) * k;
  }

  /** Everything it can show: every picture of every state and EVERY animation frame, placed as draw() places them —
   *  so a talk picture wider than idle, raised arms in a blink picture or a GIF frame that jumps is never cut off by
   *  framing. Up to 600 frames in all each is scanned at 512 px; a bigger set scans every frame at 128 px (cheap) and
   *  widens each box by one scan pixel, so no extreme frame is missed. One frame per step (idle time). */
  *contentBoundsSteps(): Generator<void, ContentRect | null, void> {
    let u: ContentRect | null = null;
    const total = [...this.pics.values()].reduce((a, p) => a + p.frames.length, 0), coarse = total > 600;
    const side = coarse ? 128 : 512, pad = coarse ? 1 / side : 0;
    for (const P of this.pics.values()) {
      const k = Math.min(this.width / P.width, this.height / P.height), w = P.width * k, h = P.height * k;
      for (let i = 0; i < P.frames.length; i++) {
        if (this.disposed) return null;
        const r = drawnRect(P.frames[i], this.width, this.height, (this.width - w) / 2, this.height - h, w, h, side);
        if (r) u = unionRect(u, { x0: Math.max(0, r.x0 - pad), x1: Math.min(1, r.x1 + pad), y0: Math.max(0, r.y0 - pad), y1: Math.min(1, r.y1 + pad) });
        yield;
      }
    }
    return u;
  }

  private draw(P: DecodedPicture, fi: number, key: string) {
    const c = this.ctx, W = this.width, H = this.height;
    c.clearRect(0, 0, W, H);
    c.imageSmoothingEnabled = !this.pixelated;
    c.imageSmoothingQuality = 'high';
    // contain, bottom-centred (every picture of a set lines up on the same feet / chest line)
    const k = Math.min(W / P.width, H / P.height);
    const w = P.width * k, h = P.height * k;
    c.drawImage(P.frames[fi], (W - w) / 2, H - h, w, h);
    this.drawn = key;
    this.version++;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.pics.values()) closePicture(p);
    this.pics.clear();
    this.canvas.width = this.canvas.height = 0;   // frees the backing store now
  }
}

registerFlatSource({ kind: 'png', label: 'PNG / GIF pictures', load: (ctx) => PngSource.load(ctx) });
