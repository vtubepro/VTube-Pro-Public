// FlatAvatar: a 2D avatar inside an AvatarRuntime (AvatarRuntime.load builds one when profile.flat is set). It loads the
// kind's FlatSource through the registry (src/avatar/flat/kinds.ts), feeds it the tracking + voice + the studio's
// hotkey cue every frame, and shows its canvas in the profile's display mode:
//   card    → card.ts     (a standee at the spot, sized + grounded from the picture's content: a whole body stands on
//                          the floor, head-and-shoulders sits on the seat or a pedestal; the default, and the fallback
//                          when a page has no overlay host)
//   overlay → overlay.ts  (a layer over the page's view: the OBS output)
//   tv      → flatTv.ts   (a walking TV's screen)
//   screen  → flatTv.ts   (a monitor on a stand)
// "When I talk" (shared/flatTalk.ts): the talk motions are computed here for every kind and applied on top of the kind's
// own picture + pose (hop, squash, wobble, shake, pulse, lean, nod, glow, brighten, sparkles).
// A kind that isn't available on this page (no plug-in, licence not accepted, load failed) shows a placeholder card that
// says why, so a party never breaks over one guest's avatar.
import * as THREE from 'three';
import { VoiceGate, voiceLevel, type FlatAvatarConfig, type FlatDisplayMode } from '../../../shared/flatAvatar.ts';
import { analyzeContent, withUnion, type ContentInfo, type ContentRect } from '../../../shared/flatFraming.ts';
import { drawnRect } from './measure.ts';
import { TalkMotor } from '../../../shared/flatTalk.ts';
import type { AvatarProfile, TrackingFrame } from '../../../shared/types.ts';
import type { SceneActor } from '../../scene/actor.ts';
import './kinds.ts';
import { flatSourceFor } from './registry.ts';
import { bundleFiles, libraryFiles, unpackFlatBundle } from './files.ts';
import { FULL_CONTENT, FlatCard } from './card.ts';
import { FlatOverlay, flatOverlayHost } from './overlay.ts';
import { FlatMonitor, FlatTvBody } from './flatTv.ts';
import type { FlatExpression, FlatFiles, FlatMotion, FlatPose, FlatSource } from './types.ts';
import { DetailWatch } from './rig2d/detailWatch.ts';

/** A stand-in picture: a soft silhouette + why the real avatar can't show here. */
class PlaceholderSource implements FlatSource {
  readonly kind = 'placeholder';
  readonly canvas = document.createElement('canvas');
  readonly width = 512;
  readonly height = 768;
  readonly premultiplied = false;
  readonly version = 1;
  constructor(name: string, why: string) {
    const c = this.canvas; c.width = this.width; c.height = this.height;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(120,135,160,0.55)';
    g.beginPath(); g.arc(256, 250, 120, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(80, 768); g.quadraticCurveTo(90, 420, 256, 400); g.quadraticCurveTo(422, 420, 432, 768); g.closePath(); g.fill();
    g.fillStyle = 'rgba(15,18,24,0.82)'; g.fillRect(24, 560, 464, 170);
    g.fillStyle = '#fff'; g.font = '700 30px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(name.slice(0, 26), 256, 606);
    g.font = '22px system-ui, sans-serif'; g.fillStyle = '#c9d2de';
    const words = why.split(/\s+/); let line = '', y = 646;
    for (const w of words) { if (g.measureText(`${line} ${w}`).width > 430 && line) { g.fillText(line, 256, y); y += 28; line = w; if (y > 720) break; } else line = line ? `${line} ${w}` : w; }
    if (y <= 720) g.fillText(line, 256, y);
  }
  face() { return { x: 0.5, y: 0.67, size: 0.34 }; }
  update() {}
  expressions(): FlatExpression[] { return []; }
  setExpression() {}
  dispose() { this.canvas.width = this.canvas.height = 0; }
}

/** A neutral frame (load-time first draw). */
const REST_FRAME: TrackingFrame = { t: 0, face: {}, head: [0, 0, 0], headPos: [0, 0, 0], gaze: [0, 0], mouth: { open: 0, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0 }, tracked: false };

/** Read where the character is on the source's picture (its alpha) and what it is (whole body / bust): a 256 px wide
 *  read for the shape; a mark too small or faint for that (a one-pixel picture) is found by a scan at the picture's
 *  own resolution (any alpha at all), then it is framed as is. Null: the picture is empty. */
export function measureContent(src: FlatSource): ContentInfo | null {
  try {
    const W = 256, H = Math.max(16, Math.min(1024, Math.round(W * src.height / Math.max(1, src.width))));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(src.canvas, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const a = new Uint8Array(W * H);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    c.width = c.height = 0;
    const info = analyzeContent(a, W, H);
    if (info) return info;
    const r = drawnRect(src.canvas, src.width, src.height, 0, 0, src.width, src.height, 2048);
    if (!r) return null;
    return { ...r, aspect: ((r.y1 - r.y0) * src.height) / Math.max(1e-6, (r.x1 - r.x0) * src.width), bottomCover: 1, bottomRuns: 1, bottomGap: 0, touchesBottom: r.y0 <= 0.015, framing: 'full', confidence: 0 };
  } catch (e) { console.warn('[flat] content', e); return null; }
}

/** Run a step generator in slices of at most `budgetMs` (yielding the thread between them), off the render loop. */
async function runSliced<T>(gen: Generator<void, T, void>, budgetMs: number, alive: () => boolean): Promise<T | null> {
  const idle = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const gap = () => new Promise<void>((r) => { if (idle) idle(() => r(), { timeout: 200 }); else setTimeout(r, 0); });
  for (;;) {
    if (!alive()) return null;
    const t0 = performance.now();
    for (;;) {
      const n = gen.next();
      if (n.done) return n.value;
      if (performance.now() - t0 > budgetMs) break;
    }
    await gap();
  }
}

/** Window event: a 2D avatar's art box changed after load (FlatAvatar.remeasure) — classic pages frame again. */
export const FLAT_CONTENT_EVENT = 'vtp:flat-content';

/** Two content boxes differ visibly (more than half a percent of the picture on any side). */
const moved = (a: ContentInfo, b: ContentInfo) => Math.max(Math.abs(a.x0 - b.x0), Math.abs(a.x1 - b.x1), Math.abs(a.y0 - b.y0), Math.abs(a.y1 - b.y1), Math.abs((a.hang ?? 0) - (b.hang ?? 0))) > 0.005;

export class FlatAvatar {
  /** The runtime's model: everything this avatar draws in 3D hangs under it. */
  readonly root = new THREE.Group();
  readonly mode: FlatDisplayMode;
  card: FlatCard | null = null;
  overlay: FlatOverlay | null = null;
  tv: FlatTvBody | null = null;
  monitor: FlatMonitor | null = null;
  readonly warnings: string[] = [];
  /** What the picture shows (alpha bounds, whole body / bust) and how the card is framed (the setting, or that). */
  content: ContentInfo = FULL_CONTENT;
  framing: 'full' | 'bust' = 'full';
  /** "When I talk" (debug / tests read its last output). */
  readonly motor = new TalkMotor();
  private gate = new VoiceGate({ threshold: 0.16, hold: 0.18, attack: 0.03 });
  /** The composed pose shown (the kind's own + the talk motions). */
  readonly pose: FlatPose = { x: 0, y: 0, rot: 0, sx: 1, sy: 1, lean: 0 };
  talking = false;
  private actor: SceneActor | null = null;
  private time = 0;
  private cueS: string | null = null;
  private motionId = -1;
  private disposed = false;
  private detail: DetailWatch | null = null;

  private constructor(readonly profile: AvatarProfile, readonly cfg: FlatAvatarConfig, readonly source: FlatSource, private files: FlatFiles & { dispose(): void }) {
    this.root.name = 'flat';
    const want = cfg.display.mode;
    this.mode = want === 'overlay' && !flatOverlayHost() ? 'card' : want;
  }

  /** `url`: the main file's URL (own avatar: files are read from its library folder) or a party guest's sealed bundle
   *  bytes (RAM only; the caller wipes its buffer afterwards). */
  static async load(profile: AvatarProfile, url: string | ArrayBuffer, onStatus?: (s: string) => void): Promise<FlatAvatar> {
    const cfg = profile.flat!;
    const files = typeof url === 'string' ? libraryFiles(profile) : bundleFiles(unpackFlatBundle(new Uint8Array(url)));
    let source: FlatSource;
    const warnings: string[] = [];
    const f = flatSourceFor(cfg.kind);
    const avail = f?.available?.() ?? { ok: true as const };
    if (!f) { source = new PlaceholderSource(profile.name, `This 2D avatar kind (${cfg.kind}) isn't installed on this PC.`); warnings.push(`2D avatar kind '${cfg.kind}' is not available here`); }
    else if (!avail.ok) { source = new PlaceholderSource(profile.name, avail.why); warnings.push(avail.why); }
    else {
      try { source = await f.load({ profile, config: cfg, files, res: cfg.res, onStatus }); }
      catch (e) { const m = (e as Error).message || String(e); console.warn('[flat] load failed', e); source = new PlaceholderSource(profile.name, `Couldn't load: ${m}`); warnings.push(`2D avatar failed to load: ${m}`); }
    }
    const fa = new FlatAvatar(profile, cfg, source, files);
    fa.warnings.push(...warnings);
    try { await fa.build(); } catch (e) { fa.dispose(); throw e; }
    return fa;
  }

  private async build() {
    // (the page gets the thread back between the pieces: a live page keeps drawing while a 2D avatar loads)
    const breathe = () => new Promise<void>((r) => setTimeout(r, 0));
    await breathe();
    // the first picture (idle, at rest) → where the character is on it, whole body or bust
    try { this.source.update({ frame: REST_FRAME, voice: 0, dt: 0, time: 0, talk: { swap: true } }); } catch (e) { console.warn('[flat] first draw', e); }
    await breathe();
    const rest = measureContent(this.source);
    if (!rest) this.warnings.push('The picture of this 2D avatar looks empty (fully see-through): it is framed as the whole picture.');
    this.restContent = rest ?? FULL_CONTENT;
    await breathe();
    const want = this.cfg.display.card.framing;
    this.framing = want === 'auto' ? this.restContent.framing : want;
    // widened to everything it can draw (other pictures, animation frames, head turns, expressions, physics, outfits):
    // framing never cuts off what the avatar does (load time: a few ms per slice, the page keeps drawing)
    this.content = withUnion({ ...this.restContent, framing: this.framing }, rest ? await this.drawUnion(true) : null);
    this.boundsSeen = this.source.boundsVersion ?? 0;
    await breathe();
    if (this.mode === 'tv') {
      this.tv = await FlatTvBody.load(this.source, this.cfg, this.profile.name, this.root);
      return;
    }
    if (this.mode === 'screen') { this.monitor = new FlatMonitor(this.source, this.cfg); this.root.add(this.monitor.group); return; }
    // card (also under an overlay: the performer still occupies the spot, invisibly — framing, seats and the
    // classic stage behave as usual)
    this.makeCard();
    if (this.mode === 'overlay') this.overlay = new FlatOverlay(this.source, this.cfg.display.overlay);
  }

  private makeCard(pictureH?: number) {
    this.card = new FlatCard(this.source, this.cfg, this.content, this.framing, pictureH);
    this.root.add(this.card.group);
    if (this.mode === 'overlay') this.card.setVisible(false);
    // sharper rigged 2D models in close-ups / 4K: the picture follows its size on screen (src/avatar/flat/rig2d/detailWatch.ts;
    // made again with the card, which a remeasure rebuilds)
    this.detail?.dispose();
    if ((this.source as { setDetail?: unknown }).setDetail) this.detail = new DetailWatch(this.source as never, this.mode === 'overlay' ? null : this.card, () => this.overlay?.el ?? null);
  }

  /** The union of everything the source can draw (its own steps, else the canvas as it is now), idle-time slices. */
  private async drawUnion(live: boolean): Promise<ContentRect | null> {
    const steps = this.source.contentBoundsSteps?.(live);
    if (steps) return runSliced(steps, 6, () => !this.disposed);
    return drawnRect(this.source.canvas, this.source.width, this.source.height);
  }

  /** What the avatar can draw changed after load (an outfit / model-slider set applied in place; a source bumping
   *  FlatSource.boundsVersion triggers it by itself): measure again in idle time and, when the art's box moved, rebuild
   *  the card and tell the room (its cams re-frame). Safe to call often: one measure at a time, the last call wins. */
  remeasure() {
    if (this.disposed || !this.card) return;
    if (this.measuring) { this.again = true; return; }
    this.measuring = true;
    this.measureDone = (async () => {
      try {
        do {
          this.again = false;
          const u = await this.drawUnion(true);
          if (this.disposed || !this.card) return;
          const next = withUnion({ ...this.restContent, framing: this.framing }, u);
          if (!moved(next, this.content)) continue;
          this.content = next;
          // (the art keeps its size on screen: only the box framing reads changes)
          const H = this.card.H;
          this.card.dispose();
          this.makeCard(H);
          this.actor?.refreshCard();
          // (the classic stage frames from the art too: its page re-frames on this)
          if (!this.actor) dispatchEvent(new CustomEvent(FLAT_CONTENT_EVENT));
        } while (this.again && !this.disposed);
      } catch (e) { console.warn('[flat] remeasure', e); }
      finally { this.measuring = false; }
    })();
  }
  private measuring = false;
  private measureDone: Promise<void> = Promise.resolve();
  /** Resolves once no measure of the art is in flight (load's is part of load; a remeasure after it): tests wait on it. */
  async settled(): Promise<void> { while (this.measuring) await this.measureDone; }
  private again = false;
  private boundsSeen = 0;
  /** What the resting picture shows (whole body / bust, its feet): `content` is this widened to everything it draws. */
  private restContent: ContentInfo = FULL_CONTENT;
  /** Classic stage: Stage.frame put a bust's cut edge past the frame's bottom (card.ts CardPlace.cutHidden). */
  cutHidden = false;
  /** Until then (performance.now ms) a cam shows this bust's cut edge (it had to stay close and crop): fade it. */
  cutFadeUntil = 0;

  /** At seats: 'stand' = stands on the floor in front of the seat (whole bodies, monitors); 'lower' = a bust sits on the
   *  seat (the card places itself from the actor's seat: card.ts); 'default' = the room's leg-less rule (walking TVs). */
  get seat(): 'stand' | 'lower' | 'default' {
    if (this.mode === 'tv') return 'default';
    if (this.mode === 'screen') return 'stand';   // (a monitor on a stand never climbs onto the seat)
    return this.framing === 'bust' ? 'lower' : 'stand';
  }
  /** The scene actor holding this avatar (walking TVs read its walk / sit state; busts its seat). */
  setActor(a: SceneActor | null) { this.actor = a; this.tv?.setActor(a); }

  expressions(): FlatExpression[] { return this.source.expressions(); }
  motions(): FlatMotion[] { return this.source.motions?.() ?? []; }

  update(frame: TrackingFrame, dt: number) {
    if (this.disposed) return;
    this.time += dt;
    const cue = frame.flat;
    const s = cue?.s ?? null;
    if (s !== this.cueS) { this.cueS = s; try { this.source.setExpression(s); } catch (e) { console.warn('[flat] expression', e); } }
    if (cue?.m && cue.m.id !== this.motionId) {
      const first = this.motionId === -1;
      this.motionId = cue.m.id;
      // (a page that joins late doesn't replay the last motion)
      if (!first) try { this.source.playMotion?.(cue.m.group, cue.m.index); } catch (e) { console.warn('[flat] motion', e); }
    }
    const voice = voiceLevel(frame);
    const swap = this.cfg.talk.perExpression[s ?? '']?.swap ?? this.cfg.talk.swap;
    try { this.source.update({ frame, voice, dt, time: this.time, cue, talk: { swap } }); } catch (e) { console.warn('[flat] update', e); }
    // "When I talk": the kind's own gate when it has one, else ours on the same voice level
    const own = this.gate.step(voice, dt);
    this.talking = this.source.talking ?? own;
    const te = this.motor.step(voice, this.talking, dt, this.cfg.talk, s);
    const sp = this.source.pose, P = this.pose;
    P.x = (sp?.x ?? 0) + te.x; P.y = (sp?.y ?? 0) + te.y; P.rot = (sp?.rot ?? 0) + te.rot;
    P.sx = (sp?.sx ?? 1) * te.sx; P.sy = (sp?.sy ?? 1) * te.sy; P.lean = (sp?.lean ?? 0) + te.lean;
    if ((this.source.boundsVersion ?? 0) !== this.boundsSeen) { this.boundsSeen = this.source.boundsVersion ?? 0; this.remeasure(); }
    if (this.card) {
      const a = this.actor, spot = a?.spot;
      const sit = spot?.pose === 'sit' ? a!.sit : 0;
      this.card.setPlace({ room: !!a, sit, seatY: spot ? spot.seatHeight / Math.max(1e-4, a!.scale || 1) : 0, cutHidden: !a && this.cutHidden, cutFade: this.cutFadeUntil > performance.now() });
      this.card.sync(P, te, dt);
    }
    this.overlay?.sync(P, te, frame);
    this.detail?.step(dt);
    this.tv?.update(frame, voice, dt);
    this.monitor?.update(dt);
  }

  /** The face in world space (talk cameras): the screen for TV / monitor, else the picture's face box. */
  faceWorld(): { center: THREE.Vector3; size: number } | undefined {
    if (this.tv) return this.tv.faceWorld();
    if (this.monitor) return this.monitor.faceWorld();
    if (!this.card) return undefined;
    const C = this.content, cw = C.x1 - C.x0, ch = C.y1 - C.y0;
    // (defaults in content fractions: a bust's face in its upper half, a body's near the top)
    const d = this.framing === 'bust' ? { x: 0.5, y: 0.64, size: 0.42 } : { x: 0.5, y: 0.88, size: 0.16 };
    const f = this.cfg.face ?? this.source.face() ?? { x: C.x0 + d.x * cw, y: C.y0 + d.y * ch, size: d.size * ch };
    const l = this.card.faceAt(f);
    this.card.group.updateWorldMatrix(true, false);
    const ws = this.card.group.getWorldScale(new THREE.Vector3()).y;
    return { center: l.center.applyMatrix4(this.card.group.matrixWorld), size: l.size * ws };
  }

  /** A rest point (avatar space, standing) where it is when this bust card sits on a seat `seatHeight` high (avatar
   *  space): the card drops onto the seat and grows (card.ts layout). Null: the card doesn't sit (whole body / TV). */
  seatedRestPoint(p: THREE.Vector3, seatHeight: number): { p: THREE.Vector3; k: number } | null {
    const plan = this.card?.seatedPlan(seatHeight);
    if (!plan) return null;
    this.root.updateMatrix();
    const inv = this.root.matrix.clone().invert(), q = p.clone().applyMatrix4(inv);
    q.set(q.x * plan.k, plan.y + (q.y - plan.standY) * plan.k, q.z * plan.k);
    return { p: q.applyMatrix4(this.root.matrix), k: plan.k };
  }

  /** What the card DRAWS, world space: the picture's opaque bounds (never the padded picture, its halo margin, the
   *  floor shadow or the pedestal), standing at rest (no seat, no talk hop: a seated bust is placed from this by
   *  seatedRestPoint, like the room does). `person`: from the virtual
   *  person's feet up (a bust stands for a whole person: rooms measure, size and seat it like one) — the runtime's
   *  bounds. Null for a walking TV / monitor (their own bodies are the bounds). */
  contentBox(person = false): THREE.Box3 | null {
    const c = this.card;
    if (!c) return null;
    const { y, k } = c.rest, hw = (c.drawnW * k) / 2, d = Math.max(0.01, c.H * 0.004);
    // (the art alone also reaches down to whatever hangs below a whole body's feet: a tail, a prop in another picture)
    const box = new THREE.Box3(new THREE.Vector3(-hw, person ? Math.min(0, y) : y - (this.content.hang ?? 0) * c.H * k, -d), new THREE.Vector3(hw, y + c.drawnH * k, d));
    c.group.updateWorldMatrix(true, false);
    return box.applyMatrix4(c.group.matrixWorld);
  }

  /** The whole head (hair, ears, hats) on a card, world lengths: its top above the face centre and its half width —
   *  when the source measured it (2D rigs: the meshes the head turn moves). Framing keeps all of it in a cam
   *  (RestMetrics.head, src/scene/actor.ts). */
  headWorld(): { top: number; half: number } | undefined {
    if (!this.card || this.cfg.face) return undefined;
    const f = this.source.face();
    if (!f || f.top === undefined) return undefined;
    this.card.group.updateWorldMatrix(true, false);
    const ws = this.card.group.getWorldScale(new THREE.Vector3()).y, k = this.card.H * this.card.scaleK * ws;
    return { top: f.top * k, half: (f.half ?? f.size * 0.6) * k };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.detail?.dispose();
    this.overlay?.dispose();
    this.card?.dispose();
    this.tv?.dispose();
    this.monitor?.dispose();
    try { this.source.dispose(); } catch (e) { console.warn('[flat] dispose', e); }
    this.files.dispose();
    this.root.removeFromParent();
  }
}
