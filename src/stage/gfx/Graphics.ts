// Scene graphics quality for one page (OBS output / studio preview): Performance · Balanced · High · Ultra · Auto
// (shared/graphics.ts). Owns the post pipeline for rooms, the toon+ shading patches, performer shadows, water / sky,
// the LOD system, the NPC detail layer, and the Auto governor.
//
// Safety rules (the face tracker shares the GPU):
// - Balanced is a no-op: the page renders exactly as before (Stage's own tier path; no patches, no extra passes).
// - Classic (no room) is never touched.
// - Shader programs are only compiled when a level / effect set changes or a room loads (compile() right there);
//   Auto pre-installs everything it may switch to when the room loads, so its steps never compile mid-show.
// - Auto never climbs while the studio's face inference is slower than its baseline, and steps down at once when it
//   rises (src/stage/gfx/auto.ts). Ultra is never a default and Auto only uses it when allowed.
import * as THREE from 'three';
import { GFX_DEFAULTS, gfxEffects, type GfxChoice, type GfxEffect, type GfxLevel, type SceneGfxState, type TrackingHealth } from '../../../shared/graphics.ts';
import type { Stage } from '../Stage.ts';
import { Pipeline, type GradeParams, type PipelineConfig } from '../post/Pipeline.ts';
import { AutoGovernor } from './auto.ts';
import { AutoLower } from './autoLower.ts';
import type { StarveLevel } from './starve.ts';
import { installProgramKeeper, type ProgramKeeper } from './programKeep.ts';
import { installSkinBounds } from './skinBounds.ts';
import { canRenderHalfFloat } from './gpuClass.ts';
import { singlePassSheets, singlePassStats } from './singlePass.ts';
import { gfxLod, setGfxBudgetLevel } from './lod.ts';
import { RoomEnvLight, roomHdri } from './hdri.ts';
import { buildLut } from './lut.ts';
import { NpcDetail } from './npcDetail.ts';
import { roomLook, type RoomLook } from './roomLooks.ts';
import { PerformerShadows, type ShadowActor } from './shadows.ts';
import { Surfaces } from './surfaces.ts';
import { hazeHook, shaftSources } from './shaftSources.ts';
import { DormantTimer } from './dormant.ts';
import { avatarSpec, patchToon, updateToonUniforms } from './toonPlus.ts';
import { setSurfaceQuality, withSurfaceShells } from '../../avatar/surfaceStyles.ts';

/** What Graphics needs from a SceneRuntime (kept structural so it never imports the scene engine). */
export interface GfxRoom {
  root: THREE.Object3D;
  info: { id: string; ambience?: { background?: string | null; fog?: string }; gfx?: unknown };
  state: { mode: string };
  room: { spots: ({ position: THREE.Vector3; pose: string } | null)[]; fixtures: { node: THREE.Object3D; group: string; kind: string }[] };
  actors: Map<string, { shown: boolean; mount: THREE.Object3D; spot: unknown; rest: { height: number } | null; scale: number; sit: number; faceAt(s: never): { center: THREE.Vector3; size: number } | null; runtime: unknown }>;
}

const ORDER: GfxLevel[] = ['performance', 'balanced', 'high', 'ultra'];
/** Additive effects (blending = Additive) are also on this layer: the glow buffer re-draws them for the bloom. */
export const GLOW_LAYER = 5;
const ULTRA_MAX_PX = 3840 * 2160;

export interface GfxInfo {
  choice: GfxChoice; level: GfxLevel; fx: Record<GfxEffect, boolean>; post: string[]; memMB: number; ratio: number;
  auto: ReturnType<AutoGovernor['info']> | null; lower?: ReturnType<AutoLower['info']> | null; scale?: number; msaa?: number; hdrPost?: boolean; singlePass?: { switched: number; kept: number }; lod: typeof gfxLod.stats; npc: ReturnType<NpcDetail['info']>; shadows: string;
  surfaces: { water: number; sky: number; clouds: number }; costMs: number; room: string | null; compiles: number;
  hdri: { name: string | null; active: boolean; materials: number };
}

export class Graphics {
  choice: GfxChoice = 'balanced';
  level: GfxLevel = 'balanced';
  fx: Record<GfxEffect, boolean> = { ...GFX_DEFAULTS.balanced };
  private overrides: Partial<Record<GfxEffect, boolean>> = {};
  private autoUltra = false;
  readonly auto = new AutoGovernor();
  /** "Lower quality automatically if fps < target" (off by default; never above the chosen preset). */
  readonly lower = new AutoLower();
  private lowerOn = false;
  private targetFps = 60;
  /** Benchmark (src/stage/gfx/bench.ts): a level forced for a few seconds. */
  private benchForced: GfxLevel | null = null;
  /** A starved OBS page (src/stage/gfx/starve.ts, set by src/output.ts): 1 / 2 = the lightest preset whatever was chosen. */
  private starved: StarveLevel = 0;
  /** Render scale for this page (Settings, 0.5–1) and the post MSAA samples (4 = today's default). */
  private scale = 1;
  private msaa = 4;
  /** Half-float colour targets available (High / Ultra post chain). If not, High / Ultra render like Medium. */
  private readonly hdrOk: boolean;
  private pipeline: Pipeline | null = null;
  private pipes = new Map<string, Pipeline>();
  /** Counts down after a pipeline switch, then releaseTargets() frees the ones not drawn (src/stage/gfx/dormant.ts). */
  private dormant = new DormantTimer();
  private rt: GfxRoom | null = null;
  private look: RoomLook | null = null;
  private lutTex: THREE.Texture | null = null;
  private roomLut: THREE.Texture | null = null;
  private shadows: PerformerShadows;
  private surfaces = new Surfaces();
  readonly env: RoomEnvLight;
  readonly npc: NpcDetail;
  private toonMats = new WeakSet<THREE.Material>();
  private actorCheck = 0;
  /** A performer's model just changed (a costume / avatar change, a guest joining): their one-pass sheets, glow tags and
   *  graphics patches on the next frame (not up to 1-2 s later: a second round of new programs + a visible change of
   *  look after they appeared), so the page's compile gate holds for and warms the final programs once. */
  actorsChanged() { this.actorCheck = 0; this.tagT = 0; this.spT = 0; }
  private preinstalled = false;
  private params: GradeParams = { bloom: 0, threshold: 1.05, saturation: 1, contrast: 1 };
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private buf = new THREE.Vector2();
  private prot: THREE.Vector4[] = [];
  private protPool: THREE.Vector4[] = [];
  private hazeColor = new THREE.Color();
  private fixtureMeshes = new Map<THREE.Object3D, THREE.MeshStandardMaterial[]>();
  private rimColor = new THREE.Color();
  private glowCam = new THREE.PerspectiveCamera();
  private tagT = 0;
  private spT = 0;
  private emits: { m: THREE.MeshStandardMaterial; gain: number }[] = [];
  private emitBase: number[] = [];
  private cost = 0;
  readonly keeper: ProgramKeeper;
  /** Shader compiles triggered here (tier changes / room loads) — for the perf report. */
  compiles = 0;
  /** Called whenever the effective level changes (the OBS page reports it). */
  onChange: ((info: GfxInfo) => void) | null = null;

  /** `pinned` = the page's ?gfx= param (wins over the scene state). */
  constructor(readonly stage: Stage, readonly role: 'obs' | 'preview', private pinned: GfxChoice | null = null) {
    this.shadows = new PerformerShadows(stage.scene);
    this.npc = new NpcDetail(stage);
    this.env = new RoomEnvLight(stage.renderer);
    this.hdrOk = canRenderHalfFloat(stage.renderer.getContext());
    // no program compiled twice in a room, and warm-ups cover both output targets (src/stage/gfx/programKeep.ts)
    this.keeper = installProgramKeeper(stage.renderer);
    installSkinBounds();   // (a detailed avatar's first frame: no per-vertex skinned bounding sphere, src/stage/gfx/skinBounds.ts)
    // (the studio's preview: no extra programs at load — its GPU is the face tracker's too, and a hitch there is not on stream)
    this.keeper.lean = role === 'preview';
    if (!this.hdrOk) console.warn('[gfx] no half-float render targets (EXT_color_buffer_float): High / Ultra fall back to the Medium path');
    // a map finished loading after the level change: compile its (unchanged-size) programs now, not on a later frame
    this.env.onBound = () => { this.compile(); this.onChange?.(this.info()); };
    stage.renderHook = () => this.render();
  }

  /** Host's scene state (gfx part). */
  setState(g: SceneGfxState | undefined) {
    const gs = g ?? { obs: 'balanced', preview: 'balanced', autoUltra: false, fx: {} };
    const choice = this.pinned ?? (this.role === 'preview' ? gs.preview : gs.obs);
    const ovr = JSON.stringify(gs.fx ?? {}) !== JSON.stringify(this.overrides);
    this.overrides = { ...(gs.fx ?? {}) };
    this.autoUltra = !!gs.autoUltra;
    this.auto.ceiling = this.autoUltra ? 'ultra' : 'high';
    this.targetFps = gs.targetFps ?? 60;
    const lowerOn = gs.autoLower !== false;          // (on unless the user turned it off: zero-effort default)
    const scale = (this.role === 'preview' ? gs.previewScale : gs.obsScale) ?? 1;
    const msaa = gs.msaa ?? 4;
    const tune = scale !== this.scale || msaa !== this.msaa || lowerOn !== this.lowerOn;
    this.scale = scale; this.msaa = msaa;
    if (lowerOn !== this.lowerOn) { this.lowerOn = lowerOn; this.lower.reset(choice === 'auto' ? this.auto.level : choice); }
    if (choice !== this.choice || ovr || tune) this.setChoice(choice, ovr || tune);
  }

  setChoice(c: GfxChoice, force = false) {
    const changed = c !== this.choice;
    this.choice = c;
    if (c === 'auto' && this.rt) this.preinstall();
    if (changed && c !== 'auto') this.lower.reset(c);
    this.apply(this.target(), force);
  }

  /** The level to render: benchmark > starved (the lightest) > Auto > auto-lowered > the chosen preset. */
  private target(): GfxLevel {
    if (this.benchForced) return this.benchForced;
    if (this.starved) return 'performance';
    if (this.choice === 'auto') return this.auto.level;
    return this.lowerOn ? this.lower.level : this.choice;
  }

  /** Benchmark only: render at `l` for a moment (null = back to the page's own choice). */
  benchLevel(l: GfxLevel | null) {
    this.benchForced = l;
    this.apply(this.target());
  }

  /** Room loaded (or null = left / Classic). */
  bindRoom(rt: GfxRoom | null) {
    // (a room change: programs only the old room used can go once the next one is bound; its engines' warm-ups ran in between)
    if (!rt) this.keeper.mark(); else if (rt !== this.rt) this.keeper.releaseUnused();
    if (this.rt) { gfxLod.remove(this.rt.root); this.surfaces.clear(); this.npc.unbind(); this.fixtureMeshes.clear(); }
    this.env.bind(rt?.root ?? null, rt ? roomHdri(rt.info.id, rt.info as { gfx?: unknown; hdri?: unknown }) : null, rt ? [...rt.actors.values()].map((a) => a.mount) : []);
    this.rt = rt;
    this.preinstalled = false;
    this.lutTex?.dispose(); this.lutTex = null; this.roomLut = null;
    if (!rt) { this.apply('balanced', true, true); return; }
    this.look = roomLook(rt.info.id, rt.info.gfx, rt.info.ambience?.fog);
    this.lutTex = buildLut(this.look.grade);
    gfxLod.add(rt.root);
    this.surfaces.scan(rt.root);
    for (const f of rt.room.fixtures) {
      const mats: THREE.MeshStandardMaterial[] = [];
      f.node.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if ((o as THREE.Mesh).isMesh && m && m.emissive) mats.push(m); });
      this.fixtureMeshes.set(f.node, mats);
    }
    this.npc.bind(rt.root);
    void this.loadRoomLut(rt.info.id);
    if (this.choice === 'auto') this.preinstall();
    else if (this.lowerOn) this.preinstallBelow(this.choice);
    this.apply(this.target(), true);
  }

  /** Auto-lower may step down from `top`: build + compile the post pipelines below it now (room load), not mid-show. */
  private preinstallBelow(top: GfxLevel) {
    for (const l of ORDER.filter((x) => ORDER.indexOf(x) >= 2 && ORDER.indexOf(x) < ORDER.indexOf(top))) {
      const cfg = this.pipeCfg(l, gfxEffects(l, this.overrides));
      if (cfg) this.getPipe(cfg);
    }
  }

  /** A room may ship its own LUT strip (lut.png, 1024×32). */
  private async loadRoomLut(id: string) {
    const url = `/api/scenes/${encodeURIComponent(id)}/file/lut.png`;
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('image')) return;
      const tex = await new THREE.TextureLoader().loadAsync(url);
      if (this.rt?.info.id !== id) { tex.dispose(); return; }
      tex.flipY = false; tex.colorSpace = THREE.NoColorSpace; tex.generateMipmaps = false; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
      this.roomLut = tex;
    } catch { /* no room LUT */ }
  }

  onHealth(h: TrackingHealth) { this.auto.onHealth(h); }

  /** May this page lower its own quality? ("Lower quality automatically" on, or Auto: the user's own choice otherwise.) */
  get lowersItself(): boolean { return this.choice === 'auto' || this.lowerOn; }

  /** A starved OBS page (src/stage/gfx/starve.ts): level 1 / 2 render the lightest preset at once and release every post
   *  target not in use; back at 0 the page continues from Low (Auto / "Lower quality automatically" climb back one step
   *  at a time, the levels above barred for a few minutes). Returns the level now rendered. */
  setStarved(l: StarveLevel, now = performance.now()): GfxLevel {
    if (l === this.starved) return this.level;
    const was = this.starved;
    this.starved = l;
    if (l && !was) {
      // (where the page continues from once the frames are back: Low, not the preset that starved)
      if (this.choice === 'auto') this.auto.starve(now); else this.lower.starve(now);
      const from = this.level;
      this.apply(this.target(), true);
      if (ORDER.indexOf(this.level) < ORDER.indexOf(from)) try { this.onLower?.(from, this.level, this.lower.reason || 'starved', 'starved'); } catch { /* optional */ }
    } else this.apply(this.target(), true);
    if (l) this.releaseTargets();
    return this.level;
  }
  get starvedLevel(): StarveLevel { return this.starved; }

  /** Post-pipeline render targets not used by the current level go back to 1×1 (their GPU memory freed; a pipeline used
   *  again is sized on its first frame, its shaders were kept). Returns the bytes released (estimate). */
  releaseTargets(): number {
    let freed = 0;
    for (const p of this.pipes.values()) {
      if (p === this.pipeline) continue;
      const b = p.memoryBytes();
      if (b > 64) { p.setSize(1, 1); freed += b; }
    }
    return freed;
  }

  /** GPU memory this page's post pipelines hold right now (bytes, estimate: src/stage/gfx/vramEstimate.ts). */
  targetBytes(): number {
    let b = 0;
    for (const p of this.pipes.values()) b += p.memoryBytes();
    return b + this.shadows.memoryBytes();
  }

  /** "Lower quality automatically" stepped down (from → to, one plain-words reason): the OBS page tells the studio.
   *  `cause` 'starved' = the starvation guard did it (the page announces that its own way, src/output.ts). */
  onLower: ((from: GfxLevel, to: GfxLevel, why: string, cause?: string) => void) | null = null;

  /** OutputPerf window → Auto. `cpuP95` = the page's main-thread ms per frame (p95). */
  onPerfWindow(w: { gpuP90: number; fps: number; late: number; targetFps: number; cpuP95?: number; driven?: boolean }) {
    if (this.benchForced || !this.rt) return;
    // (starved: the guard owns the level until the frames are back — src/stage/gfx/starve.ts)
    if (this.starved) return;
    if (this.choice !== 'auto') {
      if (!this.lowerOn) return;
      const l = this.lower.onWindow({ ...w, trackingBad: this.auto.trackingBad() }, Math.min(this.targetFps, w.targetFps));
      if (l !== this.level) {
        const from = this.level;
        this.apply(l);
        if (ORDER.indexOf(l) < ORDER.indexOf(from)) try { this.onLower?.(from, l, this.lower.reason, this.lower.cause); } catch { /* optional */ }
      }
      return;
    }
    const l = this.auto.onWindow(w);
    if (l !== this.level) this.apply(l);
  }

  // ------------------------------------------------------------------ levels
  private pipeCfg(level: GfxLevel, fx: Record<GfxEffect, boolean>): PipelineConfig | null {
    if (level !== 'high' && level !== 'ultra') return null;
    if (!this.hdrOk) return null; // AMD / Intel / old drivers without half-float targets: the Medium path, never black
    const ultra = level === 'ultra';
    return {
      samples: Math.min(this.stage.renderer.capabilities.maxSamples || 4, 4, this.msaa),
      bloomLevels: fx.bloom ? (ultra ? 5 : 4) : 0,
      ao: fx.ao, aoSamples: ultra ? 12 : 8,
      dof: fx.dof, haze: fx.haze, shafts: fx.shafts, ssr: fx.reflect && (this.look?.reflect.strength ?? 0) > 0,
      fxaa: fx.fxaa && !fx.smaa, lut: fx.grade, glow: fx.bloom && (this.look?.glow ?? 0) > 0,
      smaa: fx.smaa, n8ao: fx.ao && fx.n8ao ? { half: !ultra, samples: ultra ? 16 : 8 } : null,
    };
  }

  private getPipe(cfg: PipelineConfig): Pipeline {
    const key = JSON.stringify(cfg);
    let p = this.pipes.get(key);
    if (!p) {
      p = new Pipeline(this.stage.renderer, cfg);
      p.warm();
      this.compiles++;
      this.pipes.set(key, p);
    }
    return p;
  }

  /** Everything Auto may switch to, installed + compiled now (room load), with the extras switched off. */
  private preinstall() {
    if (this.preinstalled || !this.rt) return;
    this.preinstalled = true;
    const top = this.autoUltra ? 'ultra' : 'high';
    for (const l of ORDER.filter((x) => ORDER.indexOf(x) >= 2 && ORDER.indexOf(x) <= ORDER.indexOf(top))) {
      const cfg = this.pipeCfg(l, gfxEffects(l, this.overrides));
      if (cfg) this.getPipe(cfg);
    }
    this.installToon();
    this.surfaces.install();
    this.npc.preload();
    this.env.prefetch();
    this.compile();
  }

  /** An incoming model, still off-stage (src/output.ts stageModel): the one-pass sheets and graphics-preset patch it
   *  would get once shown (installToon / singlePassSheets), so the programs warmed for it are the ones it draws with. */
  prepareModel(root: THREE.Object3D) {
    if (!this.rt) return;
    singlePassSheets(root);
    if (!(this.pipeline && (this.fx.toon || this.preinstalled))) return;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (this.toonMats.has(m)) continue;
        const ss = m.userData.vtpSurfSpec as number | undefined;
        if (patchToon(m, typeof ss === 'number' ? ss : avatarSpec(m.name))) this.toonMats.add(m);
      }
    });
  }

  private installToon() {
    const rt = this.rt;
    if (!rt) return;
    for (const a of rt.actors.values()) {
      let patched = 0;
      a.mount.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if (this.toonMats.has(m)) continue;
          // surface styles decide their own highlight (felt / fur / clay must not get a hard-surface toon+ spec)
          const ss = m.userData.vtpSurfSpec as number | undefined;
          if (patchToon(m, typeof ss === 'number' ? ss : avatarSpec(m.name))) { this.toonMats.add(m); patched++; }
        }
      });
      this.shadows.tag(a.mount);
      // (a performer who just arrived: their patched programs now, for every output target — not one by one as each
      // camera / React tile first draws them, src/stage/gfx/programKeep.ts)
      if (patched) try { this.stage.renderer.compile(a.mount, this.stage.camera, this.stage.scene); } catch { /* optional */ }
    }
  }

  private compile() {
    // hidden shell-fur layers are compiled too, so a later tier step never compiles mid-show
    try { withSurfaceShells(() => this.stage.renderer.compile(this.stage.scene, this.stage.camera)); this.compiles++; } catch { /* optional */ }
  }

  private apply(level: GfxLevel, force = false, classic = false) {
    const fx = gfxEffects(level, this.overrides);
    const changed = force || level !== this.level || JSON.stringify(fx) !== JSON.stringify(this.fx);
    if (!changed) return;
    this.level = level;
    this.fx = fx;
    setGfxBudgetLevel(classic ? 'balanced' : level);
    setSurfaceQuality(this.rt && !classic ? level : 'balanced'); // surface styles: octaves / sparkle / shell fur (uniforms + visibility only)
    gfxLod.level = level;
    const st = this.stage;
    const room = !!this.rt && !classic;
    // resolution: Performance never supersamples; Ultra supersamples ×1.5 (capped at ~4K of pixels)
    st.ratioOverride = !room || level === 'balanced' || level === 'high' ? null
      : level === 'performance' ? (d) => Math.min(d, 1)
      : (d) => { const w = st.canvas.clientWidth || 1, h = st.canvas.clientHeight || 1; return Math.min(Math.max(1, d) * 1.5, Math.sqrt(ULTRA_MAX_PX / (w * h))); };
    st.qualityScale = room ? this.scale : 1; // Settings → render scale (rooms only; Classic is never touched)
    st.resize();
    const cfg = room ? this.pipeCfg(level, fx) : null;
    const prevPipe = this.pipeline;
    this.pipeline = cfg ? this.getPipe(cfg) : null;
    // (the pipeline just left keeps its full-size targets: handed back after a quiet 30 s, see frame())
    if (prevPipe && prevPipe !== this.pipeline) this.dormant.arm();
    // (by the level, not the pipeline: a room's engines warm up while it loads, before the pipeline is bound to it)
    this.keeper.twin = (level === 'high' || level === 'ultra') && this.hdrOk;
    let needCompile = false;
    if (room && (fx.toon || fx.npc) && level !== 'balanced' && level !== 'performance') { this.installToon(); needCompile = true; }
    if (room && fx.water && cfg) { this.surfaces.install(); needCompile = true; }
    this.surfaces.setOn(room && fx.water && !!cfg);
    this.env.setOn(room && fx.hdri && !!cfg);
    this.shadows.setMode(room && fx.shadow && cfg ? (level === 'ultra' ? 'map' : 'blob') : 'off');
    this.npc.setLevel(room ? level : 'balanced', room && fx.npc && !!cfg, room && fx.toon && !!cfg);
    if (needCompile && !this.preinstalled) this.compile();
    this.onChange?.(this.info());
  }

  // ------------------------------------------------------------------ per frame
  /** After the scene / raid updates, before stage.render(). */
  frame(dt: number) {
    const rt = this.rt;
    if (!rt) { updateToonUniforms(false, this.stage.camera, null, this.rimColor, 0, null); return; }
    const t0 = performance.now();
    const st = this.stage, cam = st.camera, fx = this.fx, L = this.look!;
    const post = !!this.pipeline;
    const H = st.renderer.getDrawingBufferSize(this.buf).y || 1080;
    gfxLod.update(dt, cam, H);
    if (this.dormant.tick(dt)) this.releaseTargets();
    // transparent double-sided SHEETS → one pass (same picture, half the program re-derivation; every level)
    this.spT -= dt;
    if (this.spT <= 0) {
      this.spT = 2; singlePassSheets(st.scene);
      // materials no compile has seen yet (engines that build on their first updates, NPCs spawning): compiled now, both
      // output targets + declared variants, before they are drawn mid-show (src/stage/gfx/programKeep.ts)
      if (this.keeper.sweep(st.scene, cam)) this.compiles++;
    }
    // newly loaded performers (costume change, a guest joining) get the patches too
    this.tagT -= dt;
    if (this.tagT <= 0 && post) { this.tagT = 1; this.tagGlow(); }
    this.actorCheck -= dt;
    if (this.actorCheck <= 0) { this.actorCheck = 1; if (post && (fx.toon || this.preinstalled)) this.installToon(); }
    this.rimColor.set(L.rim.color);
    updateToonUniforms(post && fx.toon, cam, st.keyLight, this.rimColor, L.rim.strength, st.rimLight);
    // performers: shadows, AO protection, DOF focus
    const actors = this.shownActors(rt);
    if (post && fx.shadow) {
      if (this.deferShadows) this.shadowsDue = true;     // → preRender(), after the page's single matrix update
      else this.updateShadows(actors);
    }
    this.npc.update(dt, cam);
    this.surfaces.update(dt, st.keyLight ? this.tmp.copy(st.keyLight.position).sub(st.keyLight.target.position) : null, null);
    if (post) this.buildParams(actors, cam, H);
    this.cost += (performance.now() - t0 - this.cost) * 0.05;
  }

  /** The performers on a spot and shown, in one array reused every frame (cleared in place: callers only read it during
   *  the call and never keep it). */
  private shadowBuf: ShadowActor[] = [];
  private actorBuf: NonNullable<ReturnType<GfxRoom['actors']['get']>>[] = [];
  private shownActors(rt: GfxRoom) {
    const out = this.actorBuf;
    out.length = 0;
    for (const a of rt.actors.values()) if (a.shown && a.spot) out.push(a);
    return out;
  }

  /** Performer shadows: place the blob / receiver quads and (Ultra) render the performers' shadow map. */
  private updateShadows(actors: NonNullable<ReturnType<GfxRoom['actors']['get']>>[]) {
    const st = this.stage;
    const sa = this.shadowBuf;
    sa.length = 0;
    for (const a of actors) sa.push({ obj: a.mount, floorY: a.mount.getWorldPosition(this.tmp).y, height: (a.rest?.height ?? 1.6) * a.scale, sit: a.sit, shown: a.shown });
    const kd = st.keyLight ? this.tmp2.copy(st.keyLight.position).sub(st.keyLight.target.position).normalize() : this.tmp2.set(0.4, 1, 0.4).normalize();
    this.shadows.update(st.renderer, sa, kd);
  }

  /** One-matrix-pass frames (src/output.ts): the page updates every world matrix ONCE after all of its engines and late
   *  movers, then draws the frame's passes without re-traversing the room. The performer shadows then run here — after
   *  that update and before the main render (scene auto-update off): the map sees this frame's final poses (no lag
   *  behind a late mover), and only the shadow group's own quads get their matrices refreshed. */
  deferShadows = false;
  private shadowsDue = false;
  preRender() {
    if (!this.shadowsDue) return;
    this.shadowsDue = false;
    const rt = this.rt;
    if (!rt || !this.pipeline || !this.fx.shadow) return;
    this.updateShadows(this.shownActors(rt));
    this.shadows.group.updateMatrixWorld(true);
  }

  private buildParams(actors: ReturnType<GfxRoom['actors']['get']>[], cam: THREE.PerspectiveCamera, H: number) {
    const L = this.look!, fx = this.fx, p = this.params, ultra = this.level === 'ultra';
    const view = cam.matrixWorldInverse;
    p.bloom = fx.bloom ? L.bloom : 0;
    p.threshold = L.threshold;
    p.saturation = 1; p.contrast = 1;
    p.lut = fx.grade ? this.roomLut ?? this.lutTex : null;
    p.lutMix = L.lutMix;
    p.vignette = fx.grade ? L.vignette : 0;
    p.opaque = !!this.stage.background;
    p.ao = fx.ao ? L.ao : 0;
    p.aoRadius = 0.55;
    // performers: never AO on them; the nearest face sets the talk-shot focus
    const prot = this.prot;
    prot.length = 0;
    let near = Infinity;
    for (const a of actors) {
      if (!a) continue;
      const face = a.faceAt(a.spot as never);
      const base = a.mount.getWorldPosition(this.tmp);
      if (!face) continue;
      const mid = this.tmp2.copy(face.center).add(base).multiplyScalar(0.5);
      const r = Math.max(0.45, face.center.distanceTo(base) * 0.62);
      mid.applyMatrix4(view);
      const v = this.protPool[prot.length] ??= new THREE.Vector4();
      prot.push(v.set(mid.x, mid.y, mid.z, r));
      // the talk-shot focus: only a face that is in frame and big on screen (≥ 5 % of the height)
      const fp = this.tmp.copy(face.center).project(cam);
      const d = face.center.distanceTo(cam.position);
      const px = face.size / (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
      if (fp.z < 1 && Math.abs(fp.x) < 0.95 && Math.abs(fp.y) < 0.95 && px > 0.05) near = Math.min(near, d);
    }
    prot.sort((a, b) => b.z - a.z);
    p.protect = prot.slice(0, 4);
    const react = this.rt!.state.mode === 'react';
    const dofK = fx.dof && !react && Number.isFinite(near) ? L.dof * (1 - THREE.MathUtils.smoothstep(near, 2.6, 4.4)) : 0;
    p.dof = dofK > 0.01 ? { focus: near + 0.3, range: THREE.MathUtils.clamp(near * 0.9, 1.2, 4), blur: (ultra ? 7 : 5) * (H / 1080), amount: dofK } : null;
    p.haze = fx.haze ? { color: this.hazeColor.set(L.haze.color), density: L.haze.density, glow: L.haze.glow } : null;
    if (p.haze && hazeHook.fn) { try { hazeHook.fn(p.haze); } catch { /* optional */ } }
    p.ssr = fx.reflect && L.reflect.strength > 0 ? { y: L.reflect.y ?? this.floorY(), strength: L.reflect.strength, maxDist: L.reflect.maxDist } : null;
    p.shafts = fx.shafts && L.shafts > 0 ? this.shaftPoints(cam, L.shafts) : null;
    if (fx.bloom && L.glow > 0) {
      this.glowCam.copy(cam);
      this.glowCam.layers.set(GLOW_LAYER);
      p.glow = { scene: this.glowView ? this.glowScene() : this.stage.scene, camera: this.glowCam, gain: L.glow };
    } else p.glow = null;
  }

  /** The glow pass draws the same objects through a second Scene view with its OWN render state. three.js keeps one
   *  light set per scene: the glow camera (glow layer only) sees no lights, so drawing it through the main scene flipped
   *  the light-state version twice a frame and every lit material re-derived its shader program (getParameters + cache
   *  key) on the next main pass: 40-60 extra getProgram per frame at High (measured). Same objects, same picture.
   *  A/B switch: `glowView` (localStorage vtp.glowView = '0' turns it off). */
  glowView = (() => { try { return localStorage.getItem('vtp.glowView') !== '0'; } catch { return true; } })();
  private glowScn: THREE.Scene | null = null;
  private glowScene(): THREE.Scene {
    const main = this.stage.scene;
    let g = this.glowScn;
    if (!g) {
      g = this.glowScn = new THREE.Scene();
      g.name = 'vtp:glow-view';
      g.matrixWorldAutoUpdate = false;          // (never updates the shared objects itself: the main pass did)
      // the main scene's look and render hooks, read live (the HDRI light swaps `environment` around each render; space
      // rooms hook onBeforeRender / onAfterRender)
      for (const k of ['fog', 'environment', 'environmentIntensity', 'environmentRotation', 'overrideMaterial', 'onBeforeRender', 'onAfterRender'] as const) {
        Object.defineProperty(g, k, { configurable: true, get: () => main[k], set: () => { /* read-only view */ } });
      }
    }
    (g as unknown as { children: THREE.Object3D[] }).children = main.children;   // the very same objects (same array)
    return g;
  }

  /** Additive effects → the glow layer; EMIT_<group> materials (incl. the light show's clones) → their bloom gain. */
  private tagGlow() {
    const L = this.look!, emits: typeof this.emits = [];
    const seen = new Set<THREE.Material>();
    this.stage.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) {
        if (x.blending === THREE.AdditiveBlending) o.layers.enable(GLOW_LAYER);
        const g = /^EMIT_(.+?)(?:[._]\d+)?$/.exec(x.name);
        if (g && !seen.has(x) && (x as THREE.MeshStandardMaterial).emissive) { seen.add(x); const k = L.groups[g[1]] ?? 1; if (k !== 1) emits.push({ m: x as THREE.MeshStandardMaterial, gain: k }); }
      }
    });
    this.emits = emits;
  }

  private floorCache: { id: string; y: number } | null = null;
  private floorY(): number {
    const rt = this.rt!;
    if (this.floorCache?.id === rt.info.id) return this.floorCache.y;
    const ys = rt.room.spots.filter((s): s is NonNullable<typeof s> => !!s && s.pose === 'stand').map((s) => s.position.y);
    const all = ys.length ? ys : rt.room.spots.filter((s): s is NonNullable<typeof s> => !!s).map((s) => s.position.y);
    all.sort((a, b) => a - b);
    const y = all.length ? all[Math.floor(all.length / 2)] : 0;
    this.floorCache = { id: rt.info.id, y };
    return y;
  }

  /** The (up to 4) brightest light fixtures on screen → shaft sources. */
  private shaftPoints(cam: THREE.PerspectiveCamera, k: number) {
    const cand: { v: THREE.Vector4; w: number }[] = [];
    for (const f of this.rt!.room.fixtures) {
      if (f.group === 'screen' || f.group === 'onair') continue;
      const mats = this.fixtureMeshes.get(f.node) ?? [];
      let lum = 0;
      for (const m of mats) lum = Math.max(lum, (m.emissive.r + m.emissive.g + m.emissive.b) * m.emissiveIntensity);
      if (lum < 0.5) continue;
      const p = f.node.getWorldPosition(this.tmp);
      const dist = p.distanceTo(cam.position);
      if (dist < 1.5) continue;
      p.project(cam);
      if (p.z > 1 || Math.abs(p.x) > 1.15 || Math.abs(p.y) > 1.15) continue;
      const w = Math.min(1, lum / 6) * Math.min(1, 6 / dist);
      cand.push({ v: new THREE.Vector4(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, w * k, 0), w });
    }
    // other layers' sources (e.g. the environment's sun, src/stage/gfx/shaftSources.ts)
    for (const src of shaftSources) { try { for (const q of src(cam)) cand.push({ v: new THREE.Vector4(q.x, q.y, Math.min(1, q.w) * k, 0), w: 2 + q.w }); } catch { /* optional */ } }
    cand.sort((a, b) => b.w - a.w);
    return { pts: cand.slice(0, 4).map((c) => c.v), length: 0.55, decay: 0.955, strength: 1 };
  }

  /** Stage.renderHook: true = drawn here (post pipeline), false = the stage's own path. */
  render(): boolean {
    // one-matrix-pass frames (scene auto-update off): Stage.render() has just re-aimed the key light (fitShadow) after
    // the page's single update — its own matrix is the only one that moved since
    if (!this.stage.scene.matrixWorldAutoUpdate) this.stage.keyLight.updateMatrixWorld();
    const p = this.pipeline;
    if (!p || !this.rt) return false;
    const buf = this.stage.renderer.getDrawingBufferSize(this.buf);
    p.setSize(buf.x, buf.y);
    // per-group emissive gains, for this frame only (the light show rewrites its own values every frame anyway)
    const E = this.emits, base = this.emitBase;
    for (let i = 0; i < E.length; i++) { base[i] = E[i].m.emissiveIntensity; E[i].m.emissiveIntensity *= E[i].gain; }
    this.env.pre();
    try { p.render(this.stage.scene, this.stage.camera, this.params); }
    finally { for (let i = 0; i < E.length; i++) E[i].m.emissiveIntensity = base[i]; this.env.post(); }
    return true;
  }

  /** Stage compositor (src/scene/stage): a frame whose picture is several scissored renders (performer cams) through
   *  the post chain — bloom, grade / LUT, SMAA; the depth-based effects (AO, SSR, DOF, haze, shafts, glow layer) stay
   *  off (every cam has its own camera). The OBS hole is untouched: the compositor's frame pass writes it afterwards.
   *  false = no post pipeline at this level (Performance / Balanced: the plain path). */
  renderComposite(fill: (target: THREE.WebGLRenderTarget) => void): boolean {
    const p = this.pipeline;
    if (!p || !this.rt) return false;
    const buf = this.stage.renderer.getDrawingBufferSize(this.buf);
    p.setSize(buf.x, buf.y);
    const E = this.emits, base = this.emitBase;
    for (let i = 0; i < E.length; i++) { base[i] = E[i].m.emissiveIntensity; E[i].m.emissiveIntensity *= E[i].gain; }
    this.env.pre();
    const g: GradeParams = { ...this.params, ao: 0, protect: undefined, dof: null, haze: null, shafts: null, ssr: null, glow: null, opaque: false, vignette: 0 };
    try { p.render(this.stage.scene, this.stage.camera, g, fill); }
    finally { for (let i = 0; i < E.length; i++) E[i].m.emissiveIntensity = base[i]; this.env.post(); }
    return true;
  }

  info(): GfxInfo {
    return {
      choice: this.choice, level: this.level, fx: { ...this.fx }, post: this.pipeline?.passes ?? [], memMB: +((this.pipeline?.memoryBytes() ?? 0) / 1048576).toFixed(1),
      ratio: +this.stage.renderer.getPixelRatio().toFixed(2), auto: this.choice === 'auto' ? this.auto.info() : null,
      lower: this.lowerOn && this.choice !== 'auto' ? this.lower.info() : null, scale: this.scale, msaa: this.msaa, hdrPost: this.hdrOk, singlePass: { ...singlePassStats }, lod: { ...gfxLod.stats }, npc: this.npc.info(),
      shadows: this.fx.shadow && this.pipeline ? (this.level === 'ultra' ? 'map' : 'blob') : 'off', surfaces: this.surfaces.found, costMs: +this.cost.toFixed(3),
      room: this.rt?.info.id ?? null, compiles: this.compiles,
      hdri: { name: this.env.name, active: this.env.active, materials: this.env.count },
    };
  }

  dispose() {
    this.bindRoom(null);
    for (const p of this.pipes.values()) p.dispose();
    this.pipes.clear();
    this.shadows.dispose();
    this.env.dispose();
    this.npc.dispose();
    if (this.stage.renderHook) this.stage.renderHook = null;
  }
}
