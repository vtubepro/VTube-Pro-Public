// Display modes on a screen:
//  'tv'     = the picture on a WALKING TV's screen: the TV performer set (src/scene/tv/tvRuntime.ts — the tvart GLB skin
//             when installed, else the engine's grey-box) walks through the door, sits, and gestures while the
//             performer talks, exactly like a TV guest; only its "video" is the 2D avatar's canvas.
//  'screen' = the picture on a flat monitor on a stand at the performer's spot (no legs: it doesn't walk).
// Both draw the source canvas over a backdrop colour into a small screen picture (re-drawn only when the source
// redraws) and use the TV screen material (tvScreen.ts: scanlines / curvature / glass by skin).
import * as THREE from 'three';
import type { FlatAvatarConfig } from '../../../shared/flatAvatar.ts';
import type { TrackingFrame } from '../../../shared/types.ts';
import { sanitizeTvInfo, tvSkin, type TvInfo } from '../../../shared/tv.ts';
import { liveCanvasTexture } from './liveTexture.ts';
import { TvRuntime } from '../../scene/tv/tvRuntime.ts';
import { TvScreenMaterial } from '../../scene/tv/tvScreen.ts';
import type { PageFeeds } from '../../scene/tv/tvFeeds.ts';
import type { SceneActor } from '../../scene/actor.ts';
import type { FlatSource } from './types.ts';

/** The source's picture over the backdrop, as a texture for a TV screen. */
class ScreenPicture {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  readonly size: { w: number; h: number };
  private version = -1;
  private ctx: CanvasRenderingContext2D;
  /** The part of the source shown (source px): the whole picture, or — when the source measured its head (2D rigs) and
   *  the picture is much more than a bust — a head-and-shoulders window round the face, like a webcam. */
  private crop: { x: number; y: number; w: number; h: number };
  constructor(private src: FlatSource, private backdrop: string) {
    this.crop = screenCrop(src);
    const h = Math.min(720, Math.round(this.crop.h)), w = Math.max(16, Math.round(h * this.crop.w / Math.max(1, this.crop.h)));
    this.canvas.width = w; this.canvas.height = h;
    this.size = { w, h };
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = liveCanvasTexture(this.canvas);   // (redrawn every frame: the fast upload path)
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
  }
  get aspect() { return this.size.w / this.size.h; }
  sync() {
    if (this.src.version === this.version) return;
    this.version = this.src.version;
    const c = this.ctx, { w, h } = this.size;
    if (this.backdrop === 'none') { c.fillStyle = '#05070a'; c.fillRect(0, 0, w, h); }
    else {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, this.backdrop); g.addColorStop(1, '#05070a');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    }
    c.imageSmoothingEnabled = !this.src.pixelated;
    const k = this.crop;
    c.drawImage(this.src.canvas, k.x, k.y, k.w, k.h, 0, 0, w, h);
    this.texture.needsUpdate = true;
  }
  dispose() { this.texture.dispose(); this.canvas.width = this.canvas.height = 0; }
}

/** The head-and-shoulders window of a source picture for a screen (4:3; the head about half its height, a little room
 *  above it), or the whole picture when there is no measured head / it already is a bust. */
export function screenCrop(src: Pick<FlatSource, 'width' | 'height' | 'face'>): { x: number; y: number; w: number; h: number } {
  const W = src.width, H = src.height, all = { x: 0, y: 0, w: W, h: H };
  let f: ReturnType<FlatSource['face']> = null;
  try { f = src.face(); } catch { f = null; }
  if (!f || f.top === undefined) return all;
  const head = (f.top + f.size * 0.6) * H;               // head top → chin (px)
  // (a narrow picture keeps its width: the window is then taller than 4:3)
  const h = Math.min(H, head * 2.1), w = Math.min(W, h * 4 / 3);
  if (h >= H * 0.85) return all;
  const top = (1 - f.y - f.top) * H - h * 0.08;
  const y = Math.min(H - h, Math.max(0, top)), x = Math.min(W - w, Math.max(0, f.x * W - w / 2));
  return { x, y, w, h };
}

export function tvInfoFor(cfg: FlatAvatarConfig, aspect: number): TvInfo {
  const skin = tvSkin(cfg.display.tv.skin || undefined);
  return sanitizeTvInfo({ kind: 'webcam', skin: skin.id, height: skin.height, aspect, mirror: false, chroma: null, bg: 'plain', fit: 'contain', look: 'tv', motion: 'lively' })!;
}

/** 'tv': a walking TV whose screen shows the 2D avatar. */
export class FlatTvBody {
  readonly tv: TvRuntime;
  private constructor(tv: TvRuntime, private pic: ScreenPicture, private voice: { v: number }) { this.tv = tv; }
  static async load(src: FlatSource, cfg: FlatAvatarConfig, name: string, parent: THREE.Object3D): Promise<FlatTvBody> {
    const pic = new ScreenPicture(src, cfg.display.tv.backdrop);
    pic.sync();
    const voice = { v: 0 };
    // a one-feed PageFeeds stand-in: always live, the 2D avatar's picture, the performer's voice
    const feed = { ready: true, state: 'live' as const, texture: pic.texture, get aspect() { return pic.aspect; }, size: pic.size, poll() {} };
    const feeds = { get: () => feed, level: () => voice.v } as unknown as PageFeeds;
    const tv = await TvRuntime.load({ feedId: 'flat', name, tv: tvInfoFor(cfg, pic.aspect), anchor: parent, feeds });
    return new FlatTvBody(tv, pic, voice);
  }
  setActor(a: SceneActor | null) { this.tv.actorOf = () => a; }
  update(frame: TrackingFrame, voice: number, dt: number) {
    this.pic.sync();
    this.voice.v = voice;
    this.tv.update(frame, null, null, dt);
  }
  faceWorld() { return this.tv.faceInfo(); }
  dispose() { this.tv.dispose(); this.pic.dispose(); }
}

/** 'screen': a flat monitor on a stand (no legs) showing the 2D avatar. */
export class FlatMonitor {
  readonly group = new THREE.Group();
  readonly screen: THREE.Mesh;
  private mat: TvScreenMaterial;
  private time = 0;
  private owned: { dispose(): void }[] = [];
  constructor(src: FlatSource, cfg: FlatAvatarConfig, private pic = new ScreenPicture(src, cfg.display.tv.backdrop)) {
    pic.sync();
    this.group.name = 'flat:monitor';
    const a = Math.min(2.2, Math.max(0.5, pic.aspect));
    const H = a > 1.3 ? 0.62 : 0.8, W = H * a, cy = 1.32;
    const info = { ...tvInfoFor({ ...cfg, display: { ...cfg.display, tv: { ...cfg.display.tv, skin: 'flat_modern' } } }, pic.aspect) };
    this.mat = new TvScreenMaterial(info, a, 'clean');
    this.mat.setMap(pic.texture, pic.aspect, pic.size);
    const g = <T extends { dispose(): void }>(x: T) => { this.owned.push(x); return x; };
    const dark = g(new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.45, metalness: 0.3 }));
    const bezel = new THREE.Mesh(g(new THREE.BoxGeometry(W + 0.05, H + 0.05, 0.045)), dark);
    bezel.position.set(0, cy, -0.024);
    this.screen = new THREE.Mesh(g(new THREE.PlaneGeometry(W, H)), this.mat.material);
    this.screen.position.set(0, cy, 0.0);
    this.screen.name = 'flat:screen';
    const pole = new THREE.Mesh(g(new THREE.CylinderGeometry(0.025, 0.03, cy - H / 2, 12)), dark);
    pole.position.set(0, (cy - H / 2) / 2, -0.05);
    const base = new THREE.Mesh(g(new THREE.CylinderGeometry(0.24, 0.27, 0.035, 28)), dark);
    base.position.set(0, 0.0175, -0.05);
    for (const m of [bezel, pole, base]) { m.castShadow = true; m.receiveShadow = true; }
    this.group.add(bezel, this.screen, pole, base);
  }
  update(dt: number) {
    this.time += dt;
    this.pic.sync();
    this.mat.step(dt, this.time, 'live');
  }
  faceWorld(): { center: THREE.Vector3; size: number } {
    this.screen.updateWorldMatrix(true, false);
    const g = this.screen.geometry; if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox!.clone().applyMatrix4(this.screen.matrixWorld);
    return { center: b.getCenter(new THREE.Vector3()), size: b.getSize(new THREE.Vector3()).y * 0.9 };
  }
  dispose() {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
    this.mat.dispose();
    this.pic.dispose();
  }
}
