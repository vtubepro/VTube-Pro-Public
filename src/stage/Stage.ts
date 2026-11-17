// Rendering stage: renderer, lights, camera framing, quality tiers, transparent (OBS) output.
//
// Quality tiers (the studio's tier picker; the OBS page takes ?tier=, default 'high'):
//   low    — straight to the canvas, no MSAA, no post, no shadows (integrated GPUs)
//   medium — MSAA ×4 HDR target, light bloom (3 levels), grade
//   high   — MSAA ×4, bloom (5 levels), key-light self-shadows 2048²
//   ultra  — supersampled (DPR ×1.5, capped), MSAA ×4–8, bloom (6 levels), soft shadows 4096²
// Everything above 'low' goes through post/Pipeline.ts, which keeps alpha exact for OBS transparency.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { QualityTier } from '../tracking/Tracker.ts';
import { Pipeline, type GradeParams } from './post/Pipeline.ts';
import { setOutlineMinPixels } from '../avatar/toon.ts';
import { cardShot } from '../../shared/flatFraming.ts';

export interface StageOptions {
  transparent: boolean;
  tier: QualityTier;
  controls: boolean;
  /** Keep the drawing buffer after compositing (screenshots / thumbnails read the canvas). Default true. Off: every
   *  reader has to render and read in the same task (screenshot() and grab() do). */
  preserve?: boolean;
  /** The studio's room preview: build the studio environment map only once its shader programs have linked in the
   *  driver's threads (KHR_parallel_shader_compile). Built at once it blocked the graphics card's command queue for
   *  ~370 ms waiting for those links — the face tracker's GPU model waits in that same queue. `envReady` says when. */
  asyncEnv?: boolean;
  /** This stage sets the page-wide minimum outline width from its drawing buffer (default true). A small side view
   *  (the import preview) says false: its size must not thicken the outlines of the studio's own view. */
  outlines?: boolean;
}

interface TierSpec {
  ratio: (dpr: number) => number;
  samples: number;
  bloomLevels: number;
  shadow: number; // shadow map size (0 = off)
  shadowRadius: number;
  post: boolean;
}
const TIERS: Record<QualityTier, TierSpec> = {
  low: { ratio: () => 1, samples: 0, bloomLevels: 0, shadow: 0, shadowRadius: 0, post: false },
  // The face tracker shares the GPU: rendering must never starve it (ultra at 3x/8xMSAA/4K shadows took face
  // inference from ~10 ms to ~90 ms live). Keep the render budget modest; quality comes from AA + good shading.
  medium: { ratio: (d) => Math.min(d, 1), samples: 4, bloomLevels: 3, shadow: 0, shadowRadius: 0, post: false },
  high: { ratio: (d) => Math.min(d, 1.25), samples: 4, bloomLevels: 4, shadow: 0, shadowRadius: 1.5, post: false },
  ultra: { ratio: (d) => Math.min(d, 1.5), samples: 4, bloomLevels: 5, shadow: 0, shadowRadius: 1.5, post: false },
};
/** Supersampled pixel budget on ultra (above it the ratio is reduced; MSAA drops to ×4 past ~4 MP). */
const ULTRA_MAX_PIXELS = 3840 * 2160;

/** Per-avatar post look, published by the look builder on the model root (`userData.vtpPost`). */
export interface PostLook { bloom?: number; saturation?: number; contrast?: number }
const DEFAULT_GRADE: GradeParams = { bloom: 0.7, threshold: 1.0, saturation: 1.04, contrast: 1.03 };

// key light direction (avatar space: +Z faces the camera): up and to the avatar's left, far enough to the
// side that cel shading reads as form (a terminator on cheeks / bellies) instead of a flat front-lit sticker
const KEY_DIR = new THREE.Vector3(1.55, 2.3, 2.35).normalize();

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
  readonly controls: OrbitControls | null = null;
  /** Everything avatar-related goes under this — it defines "avatar space" (+Z faces the camera). */
  readonly anchor = new THREE.Group();
  private key: THREE.DirectionalLight;
  private rim: THREE.DirectionalLight;
  private ground: THREE.Mesh;
  private resizeObs: ResizeObserver;
  private pipeline: Pipeline | null = null;
  private spec: TierSpec = TIERS.medium;
  /** What frame() aimed at: shadow-camera fitting follows it. */
  private framed = { center: new THREE.Vector3(0, 1, 0), radius: 1.2, dist: 4 };
  private grade: GradeParams = { ...DEFAULT_GRADE };
  background: string | null = '#1b1d24';
  tier: QualityTier;
  private ownsOutlines = true;
  /** Extra resolution factor on top of the tier's pixel ratio (the OBS page lowers it when frames run late). */
  renderScale = 1;
  /** Quality preset render scale (src/stage/gfx: Settings → render scale, 0.5–1), on top of everything else. */
  qualityScale = 1;
  /** Scene graphics quality (src/stage/gfx/Graphics.ts): draws the frame itself (post pipeline) when it returns true. */
  renderHook: (() => boolean) | null = null;
  /** Scene graphics quality: pixel ratio instead of the tier's (Performance / Ultra), null = the tier's. */
  ratioOverride: ((dpr: number) => number) | null = null;
  /** Studio "Light" preview while live (opt-in): the drawing buffer is capped at this many pixels, 0 = no cap. Never set
   *  on the OBS page. screenshot() lifts it for its own frame. */
  private previewCap = 0;
  /** The key / rim lights (toon+ shading reads their direction + colour; the light show recolours the rim). */
  get keyLight(): THREE.DirectionalLight { return this.key; }
  get rimLight(): THREE.DirectionalLight { return this.rim; }

  constructor(readonly canvas: HTMLCanvasElement, opts: StageOptions) {
    this.tier = opts.tier;
    this.ownsOutlines = opts.outlines ?? true;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: opts.tier === 'low' ? false : !TIERS[opts.tier]?.post, // post tiers anti-alias in their MSAA target
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: opts.preserve ?? true, // screenshots & thumbnails
      stencil: true, // 3D carved mouths cut a portal into the face with the stencil buffer
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // no global tone mapping: anime colours stay exactly as authored; PBR materials carry their own shoulder
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    if (opts.transparent) { this.background = null; this.renderer.setClearColor(0x000000, 0); }

    // studio environment for PBR / stylised-metal materials (generated, no downloads). Toon materials ignore it.
    this.scene.environmentIntensity = 0.55;
    if (opts.asyncEnv) { this.envReady = false; void this.buildEnvAsync().finally(() => { this.envReady = true; }); }
    else this.buildEnv();

    this.scene.add(this.anchor);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6);
    this.scene.add(hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 2.0);
    this.key.position.copy(KEY_DIR).multiplyScalar(4);
    this.key.shadow.bias = -0.0004;
    this.scene.add(this.key, this.key.target);
    this.rim = new THREE.DirectionalLight(0xcfe2ff, 0.9);
    this.rim.position.set(-2, 1.5, -2);
    this.scene.add(this.rim);

    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 48),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0.001;
    this.ground.visible = !opts.transparent;
    this.scene.add(this.ground);

    this.camera.position.set(0, 1.2, 4);
    if (opts.controls) {
      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.enableDamping = true;
      this.controls.target.set(0, 1, 0);
    }
    this.applyTier(opts.tier);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.resize();
  }

  /** The studio environment map is in place (always true unless StageOptions.asyncEnv is still building it). */
  envReady = true;
  private buildEnv(pmrem = new THREE.PMREMGenerator(this.renderer), room = new RoomEnvironment()) {
    try {
      this.scene.environment = pmrem.fromScene(room, 0.035).texture;
      room.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
      pmrem.dispose();
    } catch (e) { console.warn('stage: environment unavailable', e); }
  }
  /** The same map, its programs linked first: PMREMGenerator's own targets + blur / GGX materials and the environment
   *  scene's materials are compiled for the half-float target they render into, then we wait (≤ 3 s) for every program
   *  to report ready, then build it (no link waits left). Any trouble: built the plain way. */
  private async buildEnvAsync() {
    const r = this.renderer;
    const pmrem = new THREE.PMREMGenerator(r), room = new RoomEnvironment();
    try {
      const p = pmrem as unknown as { _setSize(n: number): void; _allocateTargets(): THREE.WebGLRenderTarget; _compileMaterial(m: THREE.Material): void; _blurMaterial: THREE.Material | null; _ggxMaterial: THREE.Material | null };
      if (typeof p._allocateTargets === 'function' && typeof p._setSize === 'function' && r.getContext().getExtension('KHR_parallel_shader_compile')) {
        p._setSize(256);
        const rt = p._allocateTargets();
        const prev = r.getRenderTarget();
        r.setRenderTarget(rt);
        try {
          if (p._blurMaterial) p._compileMaterial(p._blurMaterial);
          if (p._ggxMaterial) p._compileMaterial(p._ggxMaterial);
          r.compile(room, new THREE.PerspectiveCamera(90, 1, 0.1, 100));
        } finally { r.setRenderTarget(prev); }
        rt.dispose();
        const t0 = performance.now();
        const progs = () => (r.info.programs ?? []) as unknown as { isReady(): boolean }[];
        while (progs().some((x) => !x.isReady()) && performance.now() - t0 < 3000) await new Promise((res) => setTimeout(res, 16));
      }
    } catch (e) { console.warn('stage: async environment warm-up', e); }
    this.buildEnv(pmrem, room);
  }

  applyTier(tier: QualityTier) {
    const spec = TIERS[tier] ?? TIERS.medium;
    const shadowsChanged = (this.spec.shadow > 0) !== (spec.shadow > 0);
    this.tier = tier;
    this.spec = spec;
    this.pipeline?.dispose();
    this.pipeline = null;
    // a WebGL1 / no-float context can't take the HDR target: fall back to direct rendering
    const canPost = spec.post && this.renderer.capabilities.isWebGL2 !== false;
    if (canPost) this.pipeline = new Pipeline(this.renderer, { samples: Math.min(spec.samples, this.renderer.capabilities.maxSamples || 4), bloomLevels: spec.bloomLevels });
    const sm = this.renderer.shadowMap;
    sm.enabled = spec.shadow > 0;
    this.key.castShadow = spec.shadow > 0;
    if (spec.shadow > 0) {
      this.key.shadow.mapSize.set(spec.shadow, spec.shadow);
      this.key.shadow.radius = spec.shadowRadius;
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    // shadow on/off changes every lit program: recompile
    if (shadowsChanged) this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const x of Array.isArray(m) ? m : m ? [m] : []) x.needsUpdate = true;
    });
    this.resize();
  }

  setTransparent(t: boolean) {
    this.background = t ? null : '#1b1d24';
    this.ground.visible = !t;
  }

  resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const dpr = window.devicePixelRatio || 1;
    let ratio = (this.ratioOverride ? this.ratioOverride(dpr) : this.spec.ratio(dpr)) * this.renderScale;
    if (!this.ratioOverride && this.tier === 'ultra' && w * h * ratio * ratio > ULTRA_MAX_PIXELS) ratio = Math.max(Math.min(dpr, 1), Math.sqrt(ULTRA_MAX_PIXELS / (w * h)));
    if (this.qualityScale < 1) ratio *= Math.max(0.5, this.qualityScale);
    if (this.previewCap > 0 && w * h * ratio * ratio > this.previewCap) ratio = Math.max(0.5, Math.sqrt(this.previewCap / (w * h)));
    if (this.renderer.getPixelRatio() !== ratio) this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.ownsOutlines) setOutlineMinPixels(buf.y, 1.3 * Math.max(1, ratio));
    if (this.pipeline) {
      // MSAA ×8 on a supersampled 4K target is ~0.5 GB: past 4 MP the pipeline is rebuilt at ×4
      if (this.pipeline.cfg.samples > 4 && buf.x * buf.y > 4.2e6) {
        this.pipeline.dispose();
        this.pipeline = new Pipeline(this.renderer, { samples: 4, bloomLevels: this.spec.bloomLevels });
      }
      this.pipeline.setSize(buf.x, buf.y);
    }
  }

  /** Frame the camera on a bounding box. `focus`: 'full' body, 'bust' (head+shoulders), or 'head'. Returns true when it
   *  framed a 2D card's own shot (`card`: its art, bottom on the frame's bottom edge — a bust's cut edge out of view). */
  frame(box: THREE.Box3, focus: 'full' | 'bust' | 'head' = 'bust', face?: { center: THREE.Vector3; size: number }, card?: { box: THREE.Box3; bust: boolean } | null): boolean {
    this.camBlend = null;
    // (a 2D card: its whole drawn art, bottom-anchored; 'head' still frames the face)
    if (card && !card.box.isEmpty() && focus !== 'head') { this.frameCard(card.box, card.bust); return true; }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    let targetY = center.y, height = size.y;
    if (face) {
      // frame on the actual face (markers / head bone), not the bbox — hats & ears would skew it
      if (focus === 'bust') {
        height = face.size * 2.5; targetY = face.center.y - face.size * 0.45;
        // keep the whole head in a bust shot: hair volume, cat ears, an ahoge (the bbox top above the face, capped so a tall
        // hat / halo / stray mesh can't zoom the shot out). The bottom edge stays put; ~0.62 × height is the visible half.
        const top = Math.min(box.max.y, face.center.y + face.size * 2.2) + face.size * 0.08;
        const bottom = targetY - height * 0.62;
        if (top > targetY + height * 0.62) { height = (top - bottom) / 1.24; targetY = bottom + height * 0.62; }
      }
      if (focus === 'head') { height = face.size * 1.45; targetY = face.center.y + face.size * 0.08; }
      if (focus !== 'full') center.x = face.center.x;
    } else {
      if (focus === 'bust') { height = size.y * 0.55; targetY = box.max.y - height * 0.48; }
      if (focus === 'head') { height = size.y * 0.32; targetY = box.max.y - height * 0.5; }
    }
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (height * 0.62) / Math.tan(fov / 2) + size.z * 0.5;
    this.camera.position.set(center.x, targetY + height * 0.05, center.z + dist);
    this.camera.near = Math.max(0.005, dist / 100);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    if (this.controls) { this.controls.target.set(center.x, targetY, center.z); this.controls.update(); }
    else this.camera.lookAt(center.x, targetY, center.z);
    this.ground.scale.setScalar(Math.max(size.x, size.z) * 0.9);
    this.framed.center.set(center.x, box.getCenter(new THREE.Vector3()).y, center.z);
    this.framed.radius = Math.max(0.3, size.length() * 0.5);
    this.framed.dist = dist;
    return false;
  }

  /** A 2D card (its drawn art's box, world): the whole art in view, its bottom on the frame's bottom edge (a bust's cut
   *  edge just past it, like a 3D avatar's body), the lens level with the frame's middle so the upright card isn't
   *  foreshortened (shared/flatFraming.ts cardShot). */
  private frameCard(card: THREE.Box3, bust: boolean) {
    const size = card.getSize(new THREE.Vector3()), c = card.getCenter(new THREE.Vector3());
    const s = cardShot({ bottom: card.min.y, top: card.max.y, half: size.x / 2 }, this.camera.aspect || 16 / 9, bust);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = s.frameH / 2 / Math.tan(fov / 2) + size.z * 0.5;
    this.camera.position.set(c.x, s.centerY, c.z + dist);
    this.camera.near = Math.max(0.005, dist / 100);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    if (this.controls) { this.controls.target.set(c.x, s.centerY, c.z); this.controls.update(); }
    else this.camera.lookAt(c.x, s.centerY, c.z);
    this.ground.scale.setScalar(Math.max(size.x, 0.3) * 0.9);
    this.framed.center.copy(c);
    this.framed.radius = Math.max(0.3, size.length() * 0.5);
    this.framed.dist = dist;
  }

  /** Fit the key light's shadow frustum to what the camera sees of the avatar (sharp at head framing). */
  private fitShadow() {
    const cam = this.camera, f = this.framed;
    // point the camera looks at, at the framing distance
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const target = cam.position.clone().addScaledVector(dir, this.controls ? cam.position.distanceTo(this.controls.target) : f.dist);
    const d = cam.position.distanceTo(target);
    const halfH = d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / Math.max(cam.zoom, 0.05);
    const half = Math.min(Math.max(halfH, halfH * cam.aspect) * 1.25, f.radius * 1.6);
    const reach = f.radius * 3 + 1;
    const c = this.key.shadow.camera;
    c.left = -half; c.right = half; c.top = half; c.bottom = -half;
    c.near = 0.01; c.far = reach * 2;
    c.updateProjectionMatrix();
    // texel-snap the light's origin so a still avatar's shadow edges don't crawl
    const texel = (2 * half) / Math.max(1, this.key.shadow.mapSize.x);
    const snap = (v: number) => Math.round(v / texel) * texel;
    target.set(snap(target.x), snap(target.y), snap(target.z));
    this.key.target.position.copy(target);
    this.key.position.copy(target).addScaledVector(KEY_DIR, reach);
    this.key.target.updateMatrixWorld();
    // normal offset scaled to the texel: kills acne on the cel terminator without peter-panning the hair
    this.key.shadow.normalBias = texel * 1.6;
  }

  /** Per-avatar post settings (bloom / grade) from the first avatar root that publishes them. */
  private updateGrade() {
    let post: PostLook | undefined;
    const visit = (o: THREE.Object3D, depth: number) => {
      if (post || depth > 4) return;
      if (o.userData.vtpPost) { post = o.userData.vtpPost as PostLook; return; }
      for (const ch of o.children) visit(ch, depth + 1);
    };
    visit(this.anchor, 0);
    const g = this.grade;
    g.bloom = post?.bloom ?? DEFAULT_GRADE.bloom;
    g.saturation = post?.saturation ?? DEFAULT_GRADE.saturation;
    g.contrast = post?.contrast ?? DEFAULT_GRADE.contrast;
  }

  /** The camera as it is now (for blendFrom). */
  cameraState(): { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number } {
    return { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), fov: this.camera.fov };
  }
  /** Ease from an earlier camera to the one just framed over `ms` (a 2D avatar's art measured again mid-stream: no cut).
   *  A later frame() call takes over (the blend ends). */
  blendFrom(from: { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number }, ms = 500) {
    const c = this.camera;
    if (from.position.distanceToSquared(c.position) < 1e-10 && Math.abs(from.fov - c.fov) < 1e-6 && from.quaternion.angleTo(c.quaternion) < 1e-6) return;
    this.camBlend = { from, to: { position: c.position.clone(), quaternion: c.quaternion.clone(), fov: c.fov }, t0: performance.now(), ms };
    this.stepBlend();
  }
  /** A room took the camera over (or anything else that places it): a classic ease in progress ends. */
  cancelBlend() { this.camBlend = null; }
  private camBlend: { from: { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number }; to: { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number }; t0: number; ms: number } | null = null;
  private stepBlend() {
    const b = this.camBlend;
    if (!b) return;
    // (ease-out: most of the move at the start — a wider outfit is let into the frame quickly, then it settles)
    const u = Math.min(1, (performance.now() - b.t0) / b.ms), k = 1 - (1 - u) ** 3, c = this.camera;
    c.position.lerpVectors(b.from.position, b.to.position, k);
    c.quaternion.slerpQuaternions(b.from.quaternion, b.to.quaternion, k);
    c.fov = b.from.fov + (b.to.fov - b.from.fov) * k;
    c.updateProjectionMatrix();
    if (u >= 1) this.camBlend = null;
  }

  render() {
    this.stepBlend();
    this.controls?.update();
    if (this.background) this.renderer.setClearColor(this.background, 1);
    else this.renderer.setClearColor(0x000000, 0);
    if (this.key.castShadow) this.fitShadow();
    if (this.renderHook?.()) return;
    if (this.pipeline) {
      this.updateGrade();
      this.pipeline.render(this.scene, this.camera, this.grade);
    } else this.renderer.render(this.scene, this.camera);
  }

  /** Cap the drawing buffer at `pixels` (0 = off): the studio's opt-in Light preview. Resizes only when it changes. */
  setPreviewCap(pixels: number) {
    const px = Math.max(0, pixels || 0);
    if (px === this.previewCap) return;
    this.previewCap = px;
    this.resize();
  }

  /** Full-resolution PNG of a fresh frame (thumbnails, the 'screenshot' / 'diag' commands). The canvas is read in the
   *  same task as the render (toBlob copies the pixels when it is called), so it works with or without preserve. */
  screenshot(): Promise<Blob> {
    const cap = this.previewCap;
    if (cap) { this.previewCap = 0; this.resize(); }
    this.render();
    const blob = new Promise<Blob>((res) => this.canvas.toBlob((b) => res(b!), 'image/png'));
    // back to the Light preview size, redrawn at once so the preview never shows a cleared canvas
    if (cap) { this.previewCap = cap; this.resize(); this.render(); }
    return blob;
  }

  /** A GPU-scaled copy (<= maxW px wide) of the frame just drawn. Call it right after render(), in the same task (with
   *  preserve off the drawing buffer is only valid until the browser composites it). The main thread pays only for the
   *  call (no readback, no encode); encode the bitmap with a ShotEncoder. Null when there is nothing. */
  grab(maxW = 960): Promise<ImageBitmap> | null {
    const c = this.canvas;
    if (!c.width || !c.height) return null;
    const w = Math.min(maxW, c.width), h = Math.max(1, Math.round((w * c.height) / c.width));
    try { return createImageBitmap(c, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' }); } catch { return null; }
  }

  dispose() {
    this.resizeObs.disconnect();
    this.controls?.dispose();
    this.pipeline?.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
  }
}

/** Landmark dots drawn onto a camera snapshot: normalized [x, y] pairs. */
export interface ShotDots { face?: Float32Array; pose?: Float32Array }

/** shotWorker.ts replies: `blob` = the JPEG; `bitmap` (+ the dots) = handed back untouched because the worker can't
 *  draw or encode here (`unsupported`); `error` = it failed after using the bitmap up. */
interface ShotReply { id: number; blob?: Blob | null; bitmap?: ImageBitmap; face?: Float32Array; pose?: Float32Array; quality?: number; unsupported?: boolean; error?: string }

/**
 * JPEG encoder for the diagnostics pictures on a worker thread (src/stage/shotWorker.ts). Start it early (the first
 * use builds the canvas + encoder, ~40 ms, off the main thread). If a worker can't run or can't encode here (no module
 * workers, no OffscreenCanvas 2D / convertToBlob in workers: Safari before 16.4), encode() uses a reused main-thread
 * canvas from then on (a bitmap the worker could not use is handed back and encoded there), so diagnostics never stop.
 */
export class ShotEncoder {
  private w: Worker | null = null;
  private failed = false;
  private seq = 0;
  private wait = new Map<number, (b: Blob | null) => void>();
  private cv: HTMLCanvasElement | null = null;
  /** A worker that turned out unable to encode here, finishing the requests already queued on it. */
  private retired: Worker | null = null;

  get running() { return !!this.w; }

  start() {
    if (this.w || this.failed) return;
    try {
      const w = new Worker(new URL('./shotWorker.ts', import.meta.url), { type: 'module', name: 'vtp-shot' });
      w.onmessage = (e: MessageEvent<ShotReply>) => this.reply(w, e.data);
      w.onerror = () => { this.failed = true; if (this.w === w) this.stop(); else { w.terminate(); this.retired = null; } };
      w.postMessage({ id: 0, warm: true });
      this.w = w;
    } catch { this.failed = true; }
  }

  private reply(w: Worker, m: ShotReply) {
    if (m.unsupported || m.error) {
      // this worker can't do the job here: every later picture is encoded on the main thread. Requests still queued on it
      // come back the same way (their bitmaps handed back), so the worker ends once none is left.
      this.failed = true;
      if (this.w === w) { this.w = null; this.retired = w; }
    }
    const r = this.wait.get(m.id);
    if (r) this.wait.delete(m.id);
    if (m.bitmap) {
      if (r) void this.encodeHere(m.bitmap, { face: m.face, pose: m.pose }, m.quality ?? 0.8).then(r);
      else m.bitmap.close();
    } else r?.(m.blob ?? null);
    if (this.retired === w && !this.wait.size) { w.terminate(); this.retired = null; }
  }

  stop() {
    this.w?.terminate();
    this.w = null;
    this.retired?.terminate();
    this.retired = null;
    for (const r of this.wait.values()) r(null);
    this.wait.clear();
  }

  /** Encode (and close) a bitmap as JPEG, with optional landmark dots. Resolves null on any failure (never throws). */
  encode(bitmap: ImageBitmap, dots: ShotDots = {}, quality = 0.8): Promise<Blob | null> {
    this.start();
    const w = this.w;
    if (!w) return this.encodeHere(bitmap, dots, quality);
    const id = ++this.seq;
    return new Promise<Blob | null>((res) => {
      this.wait.set(id, res);
      const transfer: Transferable[] = [bitmap];
      if (dots.face) transfer.push(dots.face.buffer);
      if (dots.pose) transfer.push(dots.pose.buffer);
      try { w.postMessage({ id, bitmap, quality, face: dots.face, pose: dots.pose }, transfer); }
      catch { this.wait.delete(id); bitmap.close(); res(null); return; }
      // a diagnostics cycle never hangs on a stuck worker
      setTimeout(() => { if (this.wait.delete(id)) res(null); }, 5000);
    });
  }

  private encodeHere(bitmap: ImageBitmap, dots: ShotDots, quality: number): Promise<Blob | null> {
    try {
      const cv = (this.cv ??= document.createElement('canvas'));
      const W = bitmap.width, H = bitmap.height;
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const g = cv.getContext('2d');
      if (!g) { bitmap.close(); return Promise.resolve(null); }
      g.drawImage(bitmap, 0, 0);
      bitmap.close();
      const dot = (p: Float32Array | undefined, s: number, c: string) => { if (!p) return; g.fillStyle = c; for (let i = 0; i + 1 < p.length; i += 2) g.fillRect(p[i] * W - s / 2, p[i + 1] * H - s / 2, s, s); };
      dot(dots.face, 2, '#39ff14'); dot(dots.pose, 6, '#ff3fa4');
      return new Promise((res) => cv.toBlob((b) => res(b), 'image/jpeg', quality));
    } catch { try { bitmap.close(); } catch { /* closed */ } return Promise.resolve(null); }
  }
}
