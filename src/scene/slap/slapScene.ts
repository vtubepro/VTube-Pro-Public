// "Slap!" — the page side of the gag (OBS pages of the host and of every party guest, the Scene-tab preview, test pages).
// shared/slap.ts has the contract: the host stamps {seq, at, target, seed} into SceneState.modes.slap; every page plans
// the same choreography from (room, target, seed) and samples it at (now − at), so pages agree and one that loads
// mid-gag lands mid-gag.
//
//   plan      where the minion comes from and stands (target-mount space): a run-in lane from off-screen checked
//             against the room (floor all the way, room rays at knee + chest height, COLLIDE_* boxes, other
//             performers, never across the React screen / its OBS hole) — or from the chat buddy's (the interview
//             sidekick's) own place when he is the slapper — else a poof beside the target; in cam tiles (bust) and on
//             the interview monitor the minion leaps into the target's own frame instead ("close" framing);
//   minion    minion.ts: run cycle, skid, wind-up, a jump to face height, the slap through the cheek, a cheeky bow or
//             dusting off the hands, then runs off (or poofs out) — parented under the TARGET'S mount, so it shows in
//             their cam tile (stage layouts isolate a tile to its performer's mount), in the interview's remote
//             studio (the mount moves there) and wherever else that performer is drawn;
//   target    knocked over: a procedural fall (pivot at the foot on the far side; seated: out of the chair onto the
//             floor, then back up; micro: a mid-air spin; macro: a slower, heavier fall) on top of the tracked pose,
//             limited by the room (a wall / a neighbour is leaned on), head snap + flailing arms (humanoids, through
//             the runtime's pose hook), a daze with circling stars, then back to tracking ~2.6 s after the hit.
//             Walking TVs play their `tumble` clip + screen static; projector screens swing on their cables + static;
//   camera    Talk: cuts to the target (their talk shot, widened) when they aren't clearly in the shot; Interview:
//             cuts to the show's own shot of them (host single, their monitor close-up, their chair); React / stage
//             layouts: no cut. Impact: hit-stop, snap zoom, a short shake — never while a passthrough hole is open;
//   fx        slapFx.ts: the SLAP! card (kept off the OBS hole), impact burst, stars, puffs, punch + thud sounds.
// Costs nothing between gags (no per-frame work beyond reading the bag).
import * as THREE from 'three';
import type { SceneState } from '../../../shared/types.ts';
import { SLAP_BAG, SLAP_T, pickSlapTarget, sanitizeSlap, slapRand, slapTau, type SlapBag, type SlapEvent } from '../../../shared/slap.ts';
import { sanitizeStageState } from '../../../shared/stage.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';
import type { SceneActor } from '../actor.ts';
import type { CamPose } from '../cameraRig.ts';
import { RoomRays } from '../twoShot.ts';
import { tvOfActor, tvReact } from '../tv/tvApi.ts';
import { Minion, SLAPPER_DEFAULT, restDrive, type MinionDrive } from './minion.ts';
import { SlapFx, SlapSound, type FxSpec } from './slapFx.ts';

const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };
const easeIn = (v: number) => { const k = clamp01(v); return k * k; };
const easeOutBack = (v: number, s = 1.7) => { const k = clamp01(v); return 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2); };
const lerpAng = (a: number, b: number, k: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * clamp01(k); };
const yawTo = (from: THREE.Vector3, to: THREE.Vector3) => Math.atan2(to.x - from.x, to.z - from.z);
const K = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));

type Kind = 'humanoid' | 'blob' | 'tv' | 'projector';
type Entry = 'run' | 'poof' | 'leap';
interface Rect { x: number; y: number; w: number; h: number }

/** Everything decided when the gag starts (target-mount space unless noted). */
interface Plan {
  ev: SlapEvent;
  key: string;
  actor: SceneActor;
  runtime: unknown;
  kind: Kind;
  framing: 'room' | 'close';
  entry: Entry;
  side: 1 | -1;
  seated: boolean;
  cls: string;
  H: number;
  face: THREE.Vector3;
  faceSize: number;
  cheek: THREE.Vector3;
  /** Minion: height, stand point at the slap, lane start (run / exit), whether that start is on screen. */
  mh: number;
  P: THREE.Vector3;
  S: THREE.Vector3;
  sOnScreen: boolean;
  jump: number;
  /** Close framing: the height the minion hangs at (its feet are out of the frame). */
  baseY: number;
  hand: 1 | -1;
  bow: 'bow' | 'dust';
  /** Knock-down. */
  fall: { pivot: THREE.Vector3; max: number; drop: THREE.Vector3; slow: number; spin: boolean };
  /** Target arms' rest directions (avatar space → normalized), for the flail. */
  arms: { side: 1 | -1; restU: THREE.Vector3; restL: THREE.Vector3 }[];
  toNorm: THREE.Quaternion | null;
  cut: CamPose | null;
  camLocal: THREE.Vector3;
  fx: FxSpec;
  from: 'buddy' | 'sidekick' | null;
  notes: string[];
}

export interface SlapPageOpts {
  /** 'obs' pages play the sounds; 'preview' / 'test' pages are silent unless asked. */
  page: 'obs' | 'preview' | 'test';
}

export class SlapScene {
  rt: SceneRuntime | null = null;
  private rays: RoomRays | null = null;
  private minion: Minion | null = null;
  private fx: SlapFx | null = null;
  private sound = new SlapSound();
  private plan: Plan | null = null;
  private doneSeq = -1;
  private prevT = -99;
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  private wrapped: { rt: { poseHook: unknown }; orig: unknown; mine: unknown } | null = null;
  private tvShot = -1;
  private bag: SlapBag = sanitizeSlap(null);
  /** Chat scene (the chat buddy is the default slapper) + the page's state for the layouts. */
  chat: unknown = null;
  /** Test pages: a local bag (vtpOut.slap.test) instead of the host's. */
  local: SlapBag | null = null;
  /** Manual clock (frame strips on test pages): epoch ms. */
  manual = false;
  clock = 0;
  /** This page reports the gag's sounds to the studio, which plays them (OBS pages; test pages with vtpOut.slap.soundOn = true). */
  soundOn: boolean;
  readonly stats = { plans: 0, ms: 0, planMs: 0, warmMs: 0 };

  constructor(readonly opts: SlapPageOpts) {
    this.soundOn = opts.page === 'obs';
  }

  private now() { return this.manual ? this.clock : Date.now(); }

  // ---------------------------------------------------------------- lifecycle
  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.rt = rt;
    this.rays = new RoomRays(rt.room);
    // camera: our cut (only during a gag) first, then whatever director was installed before (raid preshow, kitchen
    // riots …). Modes that attach later (the interview) call theirs after ours: ours still wins while it answers.
    const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
    this.prevOverride = hook.cameraOverride;
    this.myOverride = (aspect) => this.cameraShot() ?? this.prevOverride?.(aspect) ?? null;
    hook.cameraOverride = this.myOverride;
  }

  detach() {
    this.end();
    const rt = this.rt;
    if (rt) {
      const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
      if (hook.cameraOverride === this.myOverride) hook.cameraOverride = this.prevOverride;
    }
    this.prevOverride = null; this.myOverride = null;
    this.rt = null; this.rays = null;
  }

  /** Test pages: slap `target` (member key) `delayMs` from now (or at an absolute epoch ms — two pages agreeing). */
  test(target: string, seed = 7, delayMs = 400, at?: number, model = '') {
    const prev = this.local?.ev?.seq ?? 0;
    if (target === 'random' && this.rt) target = pickSlapTarget([...this.rt.actors.values()].filter((a) => a.shown && a.runtime).map((a) => a.key).sort(), seed) ?? '@host';
    this.local = { model, sound: this.soundOn, ev: { seq: prev + 1, at: at ?? this.now() + delayMs, target, seed } };
    return this.local.ev;
  }

  // ---------------------------------------------------------------- per frame
  /** After the room engines (chat buddy placed): plan / the minion / the knock-down / effects. */
  pre(dt: number, state: SceneState) {
    const rt = this.rt;
    if (!rt) return;
    const t0 = performance.now();
    const bag = this.local ?? sanitizeSlap((state.modes ?? {})[SLAP_BAG]);
    this.bag = bag;
    const ev = bag.ev;
    // warm the slapper model up once the host uses slaps (the first press has a short lead for it too)
    const want = this.modelId(state);
    if ((ev || this.local) && (!this.minion || (this.minion.modelId !== want && !this.plan))) this.loadMinion(want);
    this.warm();
    if (this.warmDraw || this.warmShown) this.drawWarm();
    if (!ev) { if (this.plan) this.end(); return; }
    const t = (this.now() - ev.at) / 1000;
    if (this.plan && (this.plan.ev.seq !== ev.seq || this.plan.ev.at !== ev.at)) this.end();
    if (!this.plan) {
      if (ev.seq === this.doneSeq || t > SLAP_T.total || t < -3) { this.prevT = t; return; }
      // plan once the minion is in (or the start has come: the show goes on with the default proportions)
      if (t < -0.6 || (!this.minion?.ready && !this.minion?.failed && t < 0)) { this.prevT = t; if (this.soundOn && bag.sound) this.sound.preload(); return; }
      const p = this.makePlan(ev, state);
      if (!p) { this.doneSeq = ev.seq; this.prevT = t; return; }
      this.plan = p;
      this.stats.plans++;
      this.stats.planMs = performance.now() - t0;
    }
    const p = this.plan;
    const a = rt.actors.get(p.key);
    if (t > SLAP_T.total || !a || a !== p.actor || a.runtime !== p.runtime || !a.runtime) { this.doneSeq = p.ev.seq; this.end(); this.prevT = t; return; }
    const tau = slapTau(Math.max(-1, t));
    this.stepMinion(dt, tau, t);
    this.stepTarget(tau, t);
    this.stepFx(tau);
    this.hideBuddy(t);
    this.sounds(t);
    this.prevT = t;
    this.stats.ms = this.stats.ms * 0.9 + (performance.now() - t0) * 0.1;
  }

  /** After the stage layouts / modes (the interview placed its guests + sidekick): camera punch, the sidekick steps out. */
  post(_dt: number) {
    const p = this.plan, rt = this.rt;
    if (!p || !rt) return;
    const t = (this.now() - p.ev.at) / 1000;
    if (p.from === 'sidekick' && t >= 0 && t < 4.3 + SLAP_T.stop) {
      const sk = (this.interview() as { sidekick?: { actor?: SceneActor } | null } | null)?.sidekick;
      if (sk?.actor) sk.actor.mount.visible = false;
    }
    if (p.cut && t >= 0 && t <= SLAP_T.release) {
      const mon = (this.interview() as { monitor?: { open: number; mat?: { uniforms?: Record<string, { value: number }> } } | null } | null)?.monitor;
      if (mon && mon.open > 0) { mon.open = 0; const u = mon.mat?.uniforms?.uOpen; if (u) u.value = 0; }
    }
    this.punch(t);
  }

  // ---------------------------------------------------------------- plan
  /** Compile the slapper's + the effects' shaders in the background once they exist (the first appearance on a live
   *  OBS page would otherwise hitch ~0.3 s while the GPU compiles them). */
  private warmed = new WeakSet<object>();
  private warm() {
    const m = this.minion, rt = this.rt;
    if (!m?.ready || !rt || this.warmed.has(m)) return;
    this.warmed.add(m);
    const fx = this.fx ??= new SlapFx();
    const r = rt.stage.renderer;
    // 1) its programs, compiled in the background (KHR_parallel_shader_compile) for this room's lights
    const g = new THREE.Group();
    const show = (on: boolean, into: THREE.Object3D | null) => {
      const mount = m.actor.mount;
      if (on) { this.warmPrev = { parent: mount.parent, vis: mount.visible, fx: fx.root.children.map((c) => c.visible) }; into?.add(mount, fx.root); mount.visible = true; for (const c of fx.root.children) c.visible = true; }
      else if (this.warmPrev) {
        const w = this.warmPrev; this.warmPrev = null;
        fx.root.children.forEach((c, i) => { c.visible = w.fx[i]; });
        mount.visible = w.vis;
        if (mount.parent !== w.parent) { mount.removeFromParent(); w.parent?.add(mount); }
        if (fx.root.parent === into) fx.root.removeFromParent();
      }
    };
    let compiled: Promise<unknown> = Promise.resolve();
    try {
      show(true, g); g.updateMatrixWorld(true);
      compiled = r.compileAsync(g, rt.stage.camera, rt.stage.scene).catch(() => { /* compiles on first draw */ });
      // (its textures uploaded now: a first draw uploading 2K maps is part of the hitch)
      const texs = new Set<THREE.Texture>();
      g.traverse((o) => {
        const mm = (o as THREE.Mesh).material;
        for (const mat of (Array.isArray(mm) ? mm : mm ? [mm] : []) as THREE.Material[]) {
          for (const v of Object.values(mat as unknown as Record<string, unknown>)) if (v && (v as THREE.Texture).isTexture) texs.add(v as THREE.Texture);
          const u = (mat as THREE.ShaderMaterial).uniforms;
          if (u) for (const x of Object.values(u)) if (x?.value && (x.value as THREE.Texture).isTexture) texs.add(x.value as THREE.Texture);
        }
      });
      for (const t of texs) { try { r.initTexture(t); } catch { /* uploads on first draw */ } }
    } catch { /* older three: compiles on first draw */ } finally { show(false, g); }
    // 2) once compiled: shown for ONE ordinary frame, invisibly small in front of the lens — the per-geometry data a
    //    first draw builds on the CPU (the expressions' morph-target texture, bone textures, buffers: ~70 ms for a
    //    100k-triangle model) is made now (with the room load, under its curtain, once the host has used slaps), not
    //    mid-gag on a live OBS page
    void compiled.then(() => { if (this.minion === m && !this.noWarmDraw) this.warmDraw = m; });
  }
  private warmDraw: Minion | null = null;
  private warmShown: Minion | null = null;
  /** Debug: skip the warm-up draw. */
  noWarmDraw = false;
  private drawWarm() {
    const rt = this.rt;
    // (the frame after: take it away again)
    if (this.warmShown) {
      const w = this.warmShown; this.warmShown = null;
      if (!this.plan || w !== this.minion) { w.actor.shown = false; w.actor.sync(); if (w.actor.mount.parent === rt?.root) w.actor.mount.removeFromParent(); }
      return;
    }
    const m = this.warmDraw;
    this.warmDraw = null;
    if (!m || !rt || m !== this.minion || this.plan) return;
    const cam = rt.stage.camera;
    rt.root.add(m.actor.mount);
    m.actor.mount.position.copy(rt.root.worldToLocal(cam.getWorldPosition(new THREE.Vector3()).add(cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(2))));
    m.actor.shown = true; m.actor.appear = 0.002; m.actor.sync();
    this.warmShown = m;
  }
  private warmPrev: { parent: THREE.Object3D | null; vis: boolean; fx: boolean[] } | null = null;

  private modelId(state: SceneState) { return this.bag.model || state.chat?.buddyModel || SLAPPER_DEFAULT; }
  private loadMinion(id: string) {
    if (this.minion?.modelId === id) return;
    this.minion?.dispose();
    this.minion = new Minion(id);
    void this.minion.load();
  }
  private interview(): { remote?: { has(k: string): boolean } | null; monitor?: { open: number; quad(c: THREE.PerspectiveCamera, p?: number, n?: number): [number, number][] } | null; bag?: { guests: { key?: string }[] }; poseFor?(s: string, sub: string): { pose: CamPose } | null; poseOfKey?(key: string): { pose: CamPose } | null; sidekick?: { actor: SceneActor; modelId: string; ready: boolean } | null; sidekickPlace?: { position: THREE.Vector3 } | null; rt?: unknown } | null {
    const e = (window as unknown as { vtpInterview?: { rt?: unknown } }).vtpInterview;
    return e && e.rt === this.rt ? e as never : null;
  }

  private makePlan(ev: SlapEvent, state: SceneState): Plan | null {
    const rt = this.rt!, rays = this.rays!;
    const a = rt.actors.get(ev.target);
    if (!a || !a.runtime || !a.shown || !a.rest) return null;
    const notes: string[] = [];
    const seed = ev.seed;
    const r = a.runtime as unknown as { look?: string; humanoid?: unknown; quadruped?: unknown };
    const tv = tvOfActor(a);
    const kind: Kind = r.look === 'projector' ? 'projector' : tv ? 'tv' : r.humanoid ? 'humanoid' : 'blob';
    const m = this.minion;
    const base = (rt.info.avatarHeight ?? 1.5) * (state.avatarScale || 1);
    const mh = base * 0.72 * (m?.ready ? m.heightK : 0.72);
    if (m?.ready) m.setHeight(mh);
    const shoulder = m?.ready ? m.shoulder : 0.62, reach = m?.ready ? m.reach : 0.35;
    // ---- the target in its own mount space (= its spot's frame; the interview's remote studio uses the same frame)
    const spot = a.spot;
    const k = a.scale || 1;
    let face: THREE.Vector3, faceSize = a.rest.face.size * k;
    const fAt = spot ? a.faceAt(spot) : null;
    if (spot && fAt) { face = fAt.center.clone().sub(spot.position).applyAxisAngle(UP, -spot.yaw); faceSize = fAt.size; }
    else face = a.rest.face.center.clone().multiplyScalar(k);
    faceSize = THREE.MathUtils.clamp(faceSize, 0.06, 1.5);
    const H = Math.max(0.2, a.height);
    const seated = a.sit > 0.5 && kind !== 'projector';
    const cls = a.size.cls;
    let half = THREE.MathUtils.clamp(H * 0.12, 0.1, 0.8);
    if (kind === 'tv' || kind === 'projector') {
      try { const b = (a.runtime as unknown as { bounds(): THREE.Box3 }).bounds(); const s = b.getSize(new THREE.Vector3()); half = THREE.MathUtils.clamp(Math.max(s.x, s.z) * 0.5, 0.12, 1.4); } catch { /* estimate */ }
    }
    // ---- framing: bust cam tiles and the interview monitor = "close" (the minion leaps into their frame)
    const iv = this.interview();
    const remote = !!iv?.remote?.has(a.key);
    const composite = rt.composite;
    const stage = sanitizeStageState(state.stage ?? {});
    let framing: 'room' | 'close' = remote || (composite && stage.framing === 'bust') ? 'close' : 'room';
    const react = state.mode === 'react' && !composite;
    const cam = rt.stage.camera;
    const aspect = cam.aspect || 16 / 9;
    // passthrough holes in the shot (the 3D React screen, an interview monitor with a video guest): nothing of the gag
    // may cover them — no camera cut happens while one is open, so the live camera is the one to check against
    const holes: Rect[] = [];
    const hole = react ? rt.reactRect() : null;
    if (hole) holes.push(hole.rect);
    const monHole = !!iv?.monitor && iv.monitor.open > 0 && !composite;
    if (monHole) {
      try { cam.updateMatrixWorld(); const q = iv!.monitor!.quad(cam); const xs = q.map((v) => v[0]), ys = q.map((v) => v[1]); holes.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }); } catch { /* no quad */ }
    }
    const toW = (v: THREE.Vector3) => { a.mount.updateWorldMatrix(true, false); return a.mount.localToWorld(v.clone()); };
    const toL = (v: THREE.Vector3) => { a.mount.updateWorldMatrix(true, false); return a.mount.worldToLocal(v.clone()); };
    // ---- camera: cut to the target when the show isn't already on them (Talk / Interview; never React / layouts)
    let cut: CamPose | null = null;
    const faceW = toW(face);
    const inView = (c: THREE.Camera, fov: number, min = 0.05) => {
      c.updateMatrixWorld();
      const q = faceW.clone().project(c);
      if (q.z > 1 || Math.abs(q.x) > 0.94 || Math.abs(q.y) > 0.94) return false;
      const d = faceW.distanceTo(c.position);
      return (faceSize / (2 * d * Math.tan(THREE.MathUtils.degToRad(fov) / 2))) > min;
    };
    // React (no cut there): someone the React shot doesn't show is on a rail cam — the gag plays in that cam
    if (framing === 'room' && react && !inView(cam, cam.fov, 0.02)) { framing = 'close'; notes.push('not in the React shot: in their cam'); }
    if (!composite && !react && !monHole) {
      if (iv && !remote) {
        // (the show's own single of them: the host, a co-host, a guest — shared/talkshow.ts planLineup numbering)
        const gi = iv.bag?.guests.findIndex((g) => g.key === a.key) ?? -1, n = iv.bag?.guests.length ?? 0;
        const got = iv.poseOfKey ? iv.poseOfKey(a.key) : a.key === '@host' ? iv.poseFor?.('host', 'host') : gi >= 0 ? iv.poseFor?.(n > 1 ? `guest${gi + 1}` : 'guest', `g${gi}`) : null;
        if (got) cut = { position: got.pose.position.clone(), quaternion: got.pose.quaternion.clone(), fov: Math.min(60, got.pose.fov * 1.3) };
        notes.push(`interview cut: ${got ? 'show shot' : 'none'}`);
      } else if (iv && remote) {
        const gi = iv.bag?.guests.findIndex((g) => g.key === a.key) ?? -1, n = iv.bag?.guests.length ?? 0;
        const got = iv.poseOfKey ? iv.poseOfKey(a.key) : gi >= 0 ? iv.poseFor?.(n > 1 ? `guest${gi + 1}` : 'guest', `g${gi}`) : null;
        if (got) cut = { position: got.pose.position.clone(), quaternion: got.pose.quaternion.clone(), fov: got.pose.fov };
        notes.push(`interview monitor cut: ${got ? 'close-up' : 'none'}`);
      } else if (!iv && !inView(cam, cam.fov)) {
        const tp = rt.talkPoseFor(a.key, aspect);
        if (tp) cut = { position: tp.position.clone(), quaternion: tp.quaternion.clone(), fov: Math.min(62, tp.fov * 1.45) };
        notes.push(`talk cut: ${tp ? 'target not in the shot' : 'no talk shot'}`);
      }
    }
    // the camera the gag is seen through (for sides, off-screen lanes, the bow)
    const view = new THREE.PerspectiveCamera(cut?.fov ?? cam.fov, aspect, 0.03, 500);
    if (cut) { view.position.copy(cut.position); view.quaternion.copy(cut.quaternion); } else { view.position.copy(cam.position); view.quaternion.copy(cam.quaternion); }
    view.updateProjectionMatrix(); view.updateMatrixWorld();
    const camLocal = framing === 'close' ? new THREE.Vector3(0, face.y, 6) : toL(view.position);
    const onScreen = (pw: THREE.Vector3, margin = 0.02) => { const q = pw.clone().project(view); return q.z < 1 && Math.abs(q.x) < 1 + margin && Math.abs(q.y) < 1 + margin; };
    const boxHitsHole = (pts: THREE.Vector3[]) => {
      if (!holes.length) return false;
      cam.updateMatrixWorld();
      const qs = pts.map((p) => p.clone().project(cam)).filter((q) => q.z < 1);
      if (!qs.length) return false;
      const xs = qs.map((q) => (q.x + 1) / 2), ys = qs.map((q) => (1 - q.y) / 2);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      return holes.some((r) => x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h);
    };
    const column = (pl: THREE.Vector3, h: number, rad: number) => {
      const out: THREE.Vector3[] = [];
      for (const y of [0, h]) for (const dx of [-rad, rad]) out.push(toW(pl.clone().add(new THREE.Vector3(dx, y, 0))));
      return out;
    };
    // ---- side: the minion comes from the camera's side (never hidden behind the target), else the seed decides
    let side: 1 | -1 = Math.abs(camLocal.x) > 0.25 * Math.max(1, Math.abs(camLocal.z)) ? (camLocal.x > 0 ? 1 : -1) : slapRand(seed, 1) < 0.5 ? 1 : -1;
    const cheekOf = (L: number) => face.clone().add(new THREE.Vector3(L * faceSize * 0.42, -faceSize * 0.12, faceSize * 0.12));
    const standOf = (L: number, front = false) => front
      ? new THREE.Vector3(face.x, 0, face.z + half + mh * 0.3)
      : new THREE.Vector3(L * (half + mh * 0.2 + 0.06), 0, face.z + 0.05);
    const floorOk = (pl: THREE.Vector3) => {
      const w = toW(pl.clone().setY(0.5));
      const fy = rays.floorBelow(w, 1.4);
      const y0 = toW(new THREE.Vector3()).y;
      return fy !== null && Math.abs(fy - y0) < 0.3 && !rays.insideCollider(toW(pl.clone().setY(Math.min(0.3, mh * 0.35))));
    };
    // (the slap is at face height: nothing between there and their cheek — a chair's arm below doesn't matter)
    const reachOk = (pl: THREE.Vector3) => {
      const y = Math.max(face.y - faceSize * 0.2, pl.y + mh * 0.5);
      const toward = new THREE.Vector3(pl.x - face.x, 0, pl.z - face.z).normalize().multiplyScalar(faceSize * 0.75);
      return rays.clear(toW(pl.clone().setY(y)), toW(face.clone().add(toward).setY(y)));
    };
    const others = [...rt.actors.values()].filter((o) => o !== a && o.shown && o.runtime);
    const nearOther = (pl: THREE.Vector3, r: number) => others.some((o) => toL(o.mount.getWorldPosition(new THREE.Vector3())).setY(0).distanceTo(pl.clone().setY(0)) < r + 0.12 * o.height);
    let P = standOf(side), entry: Entry = framing === 'close' ? 'leap' : 'run';
    let front = false;
    let S = P.clone(), sOnScreen = true, from: Plan['from'] = null;
    if (framing === 'room') {
      const cands: { L: 1 | -1; front: boolean }[] = [{ L: side, front: false }, { L: (-side) as 1 | -1, front: false }, { L: side, front: true }];
      const why: string[] = [];
      const valid: { L: 1 | -1; front: boolean; P: THREE.Vector3 }[] = [];
      for (const c of cands) {
        const pl = standOf(c.L, c.front);
        const f = floorOk(pl), r = f && reachOk(pl), n = r && !nearOther(pl, 0.3), hh = n && !boxHitsHole(column(pl, mh + 0.3, mh * 0.3));
        if (hh) valid.push({ ...c, P: pl });
        else why.push(`${c.front ? 'front' : c.L > 0 ? 'left' : 'right'}: ${!f ? 'no floor' : !r ? 'blocked' : !n ? 'someone there' : 'OBS hole'}`);
      }
      // ---- the run-in lane: from off-screen (or the chat buddy / the sidekick) to the stand point
      const laneWhy = new Map<string, number>();
      const no = (w: string) => { laneWhy.set(w, (laneWhy.get(w) ?? 0) + 1); return false; };
      const laneOk = (s: THREE.Vector3, p: THREE.Vector3) => {
        const len = s.distanceTo(p);
        if (len < 0.6) return no('short');
        for (let i = 0; i < 6; i++) { const q = s.clone().lerp(p, i / 6); if (!floorOk(q)) return no('floor'); }
        for (const hgt of [mh * 0.25, mh * 0.65]) if (!rays.clear(toW(s.clone().setY(hgt)), toW(p.clone().setY(hgt)))) return no('room');
        const seg = new THREE.Line3(s.clone().setY(0), p.clone().setY(0));
        for (const o of others) {
          const ol = toL(o.mount.getWorldPosition(new THREE.Vector3())).setY(0);
          if (seg.closestPointToPoint(ol, true, new THREE.Vector3()).distanceTo(ol) < 0.3 + 0.1 * o.height) return no('performer');
        }
        if (boxHitsHole([...column(s, mh, mh * 0.3), ...column(s.clone().lerp(p, 0.5), mh, mh * 0.3)])) return no('hole');
        return true;
      };
      const buddyPos = this.buddyStart(state, iv);
      const laneFor = (v: { L: 1 | -1; front: boolean; P: THREE.Vector3 }) => {
        // the chat buddy (roaming in the room) or the interview sidekick IS the slapper: he runs over from where he is
        if (buddyPos) {
          const s = toL(buddyPos.pos).setY(0);
          if (s.distanceTo(v.P) < 7 && laneOk(s, v.P)) return { s, score: -100, on: onScreen(toW(s.clone().setY(mh * 0.5))), from: buddyPos.from };
        }
        const L = v.L;
        const dirs = v.front ? [new THREE.Vector3(0, 0, 1), new THREE.Vector3(L * 0.7, 0, 0.7).normalize(), new THREE.Vector3(-L * 0.7, 0, 0.7).normalize(), new THREE.Vector3(L, 0, 0)]
          : [new THREE.Vector3(L, 0, 0.35).normalize(), new THREE.Vector3(L, 0, 0), new THREE.Vector3(L, 0, -0.45).normalize(), new THREE.Vector3(L * 0.6, 0, 0.8).normalize(), new THREE.Vector3(L * 0.2, 0, 1).normalize(), new THREE.Vector3(L * 0.5, 0, -0.85).normalize()];
        let best: { s: THREE.Vector3; score: number; on: boolean; from: Plan['from'] } | null = null;
        dirs.forEach((d, di) => {
          for (const D of [3.4, 2.7, 2.0, 1.4, 1.0]) {
            const s = v.P.clone().addScaledVector(d, D * Math.max(0.8, base / 1.5));
            if (!laneOk(s, v.P)) continue;
            const on = onScreen(toW(s.clone().setY(mh * 0.5)), 0.08);
            // off-screen starts first ("runs in from off-screen"); stage layouts: straight in from the side of the tile
            const score = (composite ? (di === 1 ? 0 : 2) : on ? 6 : 0) + (3.4 - D) * 0.6 + di * 0.4;
            if (!best || score < best.score) best = { s, score, on, from: null };
            break;
          }
        });
        return best as { s: THREE.Vector3; score: number; on: boolean; from: Plan['from'] } | null;
      };
      // …and never stand in front of anyone's face (the target's included) as the camera sees it
      const faceRect = (c: THREE.Vector3, size: number): Rect | null => {
        const q = c.clone().project(view);
        if (q.z > 1) return null;
        const hf = (size * 1.2) / (2 * c.distanceTo(view.position) * Math.tan(THREE.MathUtils.degToRad(view.fov) / 2));
        return { x: (q.x + 1) / 2 - hf / aspect, y: (1 - q.y) / 2 - hf, w: (2 * hf) / aspect, h: 2 * hf };
      };
      const faceBoxes = [faceRect(faceW, faceSize), ...others.map((o) => { const f = o.spot ? o.faceAt(o.spot) : null; return f ? faceRect(f.center, f.size) : null; })].filter((r): r is Rect => !!r);
      const coversFace = (pl: THREE.Vector3) => {
        if (composite) return false;
        const qs = column(pl, mh * 0.95, mh * 0.28).map((p) => p.project(view)).filter((q) => q.z < 1);
        if (!qs.length) return false;
        const xs = qs.map((q) => (q.x + 1) / 2), ys = qs.map((q) => (1 - q.y) / 2);
        const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        return faceBoxes.some((h) => Math.max(0, Math.min(r.x + r.w, h.x + h.w) - Math.max(r.x, h.x)) * Math.max(0, Math.min(r.y + r.h, h.y + h.h) - Math.max(r.y, h.y)) > 0.15 * h.w * h.h);
      };
      // the minion must be SEEN (a desk / console between the lens and the floor beside them hides it)
      const seen = (pl: THREE.Vector3) => {
        if (composite) return true;
        const hd = toW(pl.clone().add(new THREE.Vector3(0, mh * 0.72, 0)));
        return rays.hit(view.position, hd) === Infinity;
      };
      // the camera's side first; a side with a way in beats one without (then it poofs in); a visible place beats a
      // hidden one — the furniture top beside them (below) when the floor there is out of sight
      let pick: (typeof valid)[number] | null = null;
      let lane: ReturnType<typeof laneFor> = null;
      const lanes = valid.filter((v) => { const c = coversFace(v.P); if (c) why.push(`${v.front ? 'front' : v.L > 0 ? 'left' : 'right'}: in front of a face`); return !c; }).map((v) => ({ v, l: laneFor(v), seen: seen(v.P) }));
      const order = [lanes.find((x) => x.l && x.seen), lanes.find((x) => !x.l && x.seen)];
      for (const x of order) if (x && !pick) { pick = x.v; lane = x.l; }
      if (pick && !lane) notes.push(`no lane (${[...laneWhy].map(([k, n]) => `${k} ${n}`).join(', ')}): poof in`);
      if (lanes.some((x) => !x.seen)) notes.push(`hidden from the camera: ${lanes.filter((x) => !x.seen).map((x) => (x.v.front ? 'front' : x.v.L > 0 ? 'left' : 'right')).join(', ')}`);
      let perch = 0;
      // no floor place in sight (a desk, a console, a bar in the way): hop up onto the furniture beside them
      if (!pick) for (const c of cands) {
        const pl = standOf(c.L, c.front);
        const top = face.y + 0.25;
        const sy = rays.floorBelow(toW(pl.clone().setY(top)), top + 0.2);
        const y = sy === null ? null : sy - toW(new THREE.Vector3()).y;
        if (y === null || y < 0.2 || y > face.y - Math.max(0.15, mh * 0.3)) continue;
        const up = pl.clone().setY(y);
        if (rays.insideCollider(toW(up.clone().setY(y + mh * 0.3))) || !reachOk(up)) continue;
        if (!rays.clear(toW(up.clone().setY(y + 0.05)), toW(up.clone().setY(y + mh * 0.95)))) continue;
        if (boxHitsHole(column(up, mh + 0.3, mh * 0.3)) || !seen(up) || coversFace(up)) continue;
        pick = { ...c, P: up }; perch = y; notes.push(`on the furniture beside them (${y.toFixed(2)} m up)`); break;
      }
      // (else a hidden floor place with its lane, else any floor place, else the camera side)
      // (else — the floor beside them is out of sight: behind a desk / console — it leaps up beside their face from
      // behind it, like in a cam tile; nothing at all: a poof on the camera side)
      // nothing to stand on in sight: it LEAPS up beside their face (from behind the furniture / out of a puff) on a side
      // where it covers nobody's face — like in a cam tile
      let hiddenLeap = false;
      const leapAt = (L: number) => new THREE.Vector3(L * (faceSize * 1.25 + mh * 0.16), face.y - faceSize * 0.12 - mh * (shoulder + reach * 0.25), face.z + faceSize * 0.25);
      if (!pick) {
        const L = ([side, -side] as (1 | -1)[]).find((q) => !coversFace(leapAt(q))) ?? side;
        pick = { L, front: false, P: standOf(L) }; hiddenLeap = true;
        notes.push(`no place in sight beside them (${why.join(', ') || 'hidden'}): leaps up beside the face`);
      } else if (why.length) notes.push(why.join(', '));
      side = pick.L; front = pick.front;
      P = pick.P.clone().setY(perch);
      if (hiddenLeap) { entry = 'leap'; P = new THREE.Vector3(side * (faceSize * 1.25 + mh * 0.16), 0, face.z + faceSize * 0.25); }
      else if (lane) { S = lane.s; sOnScreen = lane.on; from = lane.from; }
      else entry = 'poof';
    } else {
      // close: the minion hangs beside the face (feet out of the frame), leaps in from further out and lower
      P = new THREE.Vector3(side * (faceSize * 1.05 + mh * 0.1), 0, face.z + faceSize * 0.3);
    }
    const cheek = cheekOf(front ? 0 : side);
    // ---- jump: the slapping hand reaches the cheek (capped: a giant gets it on the knee)
    const handH = mh * (shoulder + reach * 0.55);
    const leapy = entry === 'leap';
    const jump = leapy ? 0 : THREE.MathUtils.clamp(cheek.y - P.y - handH, 0, mh * 1.7);
    const baseY = leapy ? cheek.y - mh * (shoulder + reach * 0.25) : 0;
    if (leapy) P.y = baseY;
    // ---- knock-down geometry
    const macro = cls === 'macro' || cls === 'large', micro = cls === 'micro';
    let maxA = seated ? 1.18 : kind === 'humanoid' && (a.runtime as unknown as { quadruped?: unknown }).quadruped ? 1.45 : 1.38;
    if (kind === 'projector') maxA = 0.42;
    const fallDir = new THREE.Vector3(-(front ? (slapRand(seed, 2) < 0.5 ? 1 : -1) : side), 0, 0);
    const fs = fallDir.x > 0 ? 1 : -1;       // the fall goes towards +X (fs 1) or −X
    if (framing === 'room' && kind !== 'projector' && kind !== 'tv') {
      // the room (a wall, furniture) or a neighbour stops the fall: they lean on it instead
      const top = seated ? face.y - 0.1 : H * 0.62;
      const from0 = toW(new THREE.Vector3(0, top, 0));
      const hitD = rays.hit(from0, toW(new THREE.Vector3(fs * H * 0.95, top, 0)));
      let room = hitD === Infinity ? H : hitD;
      for (const o of others) { const ol = toL(o.mount.getWorldPosition(new THREE.Vector3())); if (Math.sign(ol.x) === fs && Math.abs(ol.z) < 0.5) room = Math.min(room, Math.abs(ol.x) - 0.15 * o.height); }
      const lim = Math.asin(clamp01((room - 0.08) / Math.max(0.2, top)));
      if (lim < maxA) { maxA = Math.max(0.3, lim); notes.push(`fall limited to ${Math.round(maxA * 57.3)}° (room ${room.toFixed(2)} m)`); }
    }
    // React: the fall must not sweep over the screen / its hole
    if (holes.length && kind !== 'tv' && kind !== 'projector') {
      for (let i = 0; i < 6 && maxA > 0.25; i++) {
        const q = new THREE.Quaternion().setFromAxisAngle(Z, fs * -maxA);
        const pts = [new THREE.Vector3(0, H, 0), new THREE.Vector3(0, H * 0.5, 0), face.clone()].map((v) => toW(v.clone().sub(new THREE.Vector3(fs * half * 0.8, 0, 0)).applyQuaternion(q).add(new THREE.Vector3(fs * half * 0.8, 0, 0))));
        if (!boxHitsHole(pts)) break;
        maxA *= 0.7;
      }
    }
    const seatH = seated && spot ? spot.seatHeight : 0;
    const fall = {
      pivot: seated ? new THREE.Vector3(fs * half * 0.9, seatH, 0.05) : kind === 'projector' ? new THREE.Vector3(0, face.y + faceSize * 1.5 + 0.45, 0) : new THREE.Vector3(fs * half * 0.8, 0, 0),
      max: maxA,
      drop: seated ? new THREE.Vector3(fs * H * 0.1, -seatH * 0.4, 0.12) : new THREE.Vector3(),
      slow: macro ? 1.25 : 1,
      spin: micro && kind !== 'projector',
    };
    // ---- target arms (flail)
    const arms: Plan['arms'] = [];
    const rest = a.rest;
    if (kind === 'humanoid' && rest.toNorm) {
      for (const s of ['left', 'right'] as const) {
        const u = rest.joints[`${s}UpperArm`], l = rest.joints[`${s}LowerArm`], hd = rest.joints[`${s}Hand`];
        if (!u || !l) continue;
        const du = l.clone().sub(u), dl = hd ? hd.clone().sub(l) : du.clone();
        if (du.lengthSq() < 1e-10 || dl.lengthSq() < 1e-10) continue;
        arms.push({ side: s === 'left' ? 1 : -1, restU: du.normalize().applyQuaternion(rest.toNorm), restL: dl.normalize().applyQuaternion(rest.toNorm) });
      }
    }
    // ---- effects: the card beside the face on the minion's side, off the OBS hole
    // (close framing: the card goes on the far side — the minion's own head is right beside the face there)
    const cs = front ? (slapRand(seed, 5) < 0.5 ? 1 : -1) : framing === 'close' ? (-side as 1 | -1) : side;
    const cardW = framing === 'close' ? THREE.MathUtils.clamp(faceSize * 2.4, 0.16, 0.9) : THREE.MathUtils.clamp(faceSize * 3.4, 0.35, 1.6);
    // (close framing — a cam tile, the monitor: just above their head, where even a narrow cam shows it)
    const card = framing === 'close' ? face.clone().add(new THREE.Vector3(cs * faceSize * 0.35, faceSize * 1.05 + cardW * 0.2, faceSize * 0.3))
      : face.clone().add(new THREE.Vector3(cs * (faceSize * 1.1 + cardW * 0.32), faceSize * 0.95, faceSize * 0.3));
    const puffs: FxSpec['puffs'] = [];
    const ps = mh * 0.55;
    if (entry === 'run') {
      if (sOnScreen && !from) puffs.push({ t: 0, at: S.clone().setY(mh * 0.35), size: mh * 0.9 });
      puffs.push({ t: 0.32, at: S.clone().lerp(P, 0.08).setY(ps * 0.25), size: ps });
      puffs.push({ t: 1.2, at: P.clone().setY(ps * 0.2), size: ps * 1.1 });
      puffs.push({ t: 2.3, at: P.clone().setY(ps * 0.2), size: ps * 0.9 });
      puffs.push({ t: 3.32, at: P.clone().setY(ps * 0.25), size: ps });
      if (sOnScreen && !from) puffs.push({ t: 4.22, at: S.clone().setY(mh * 0.35), size: mh * 0.9 });
    } else if (entry === 'leap' && framing === 'room') {
      // (in the room the leap starts and ends in a puff: it never seems to come out of the floor)
      puffs.push({ t: 1.5, at: P.clone().add(new THREE.Vector3(side * 1.0, -mh * 0.35, 0.05)), size: mh * 1.0 });
      puffs.push({ t: 3.68, at: P.clone().add(new THREE.Vector3(side * 1.15, -mh * 0.5, 0)), size: mh * 1.0 });
    } else if (entry === 'poof') {
      puffs.push({ t: 0.4, at: P.clone().add(new THREE.Vector3(0, mh * 0.4, 0)), size: mh * 1.1 });
      puffs.push({ t: 2.3, at: P.clone().add(new THREE.Vector3(0, ps * 0.2, 0)), size: ps * 0.9 });
      puffs.push({ t: 3.35, at: P.clone().add(new THREE.Vector3(0, mh * 0.4, 0)), size: mh * 1.1 });
    }
    const fx: FxSpec = { impact: cheek.clone(), card, cardW, side: cs, face: faceSize, puffs, ringFrom: 0.75 * fall.slow, ringTo: 1.75 * fall.slow, seed, close: framing === 'close' };
    const fxObj = this.fx ??= new SlapFx();
    fxObj.cardHidden = false;
    // the card never covers an OBS hole (3D React screen, an interview monitor's video guest) nor anyone else's face:
    // the minion's side, else the other side, else above the head; nothing fits a hole → no card (faces: least overlap)
    if (framing === 'room') {
      const faceRects: Rect[] = [];
      for (const o of others) {
        const f = o.spot ? o.faceAt(o.spot) : null;
        if (!f) continue;
        const q = f.center.clone().project(view);
        if (q.z > 1) continue;
        const d = f.center.distanceTo(view.position), hf = (f.size * 1.3) / (2 * d * Math.tan(THREE.MathUtils.degToRad(view.fov) / 2));
        faceRects.push({ x: (q.x + 1) / 2 - hf / aspect, y: (1 - q.y) / 2 - hf, w: (2 * hf) / aspect, h: 2 * hf });
      }
      const over = (r: Rect, h: Rect) => Math.max(0, Math.min(r.x + r.w, h.x + h.w) - Math.max(r.x, h.x)) * Math.max(0, Math.min(r.y + r.h, h.y + h.h) - Math.max(r.y, h.y));
      const places = [card.clone(), face.clone().add(new THREE.Vector3(-cs * (faceSize * 1.1 + cardW * 0.32), faceSize * 0.95, faceSize * 0.3)), face.clone().add(new THREE.Vector3(0, faceSize * 1.2 + cardW * 0.4, faceSize * 0.3))];
      let best: { i: number; cost: number } | null = null;
      places.forEach((pl, i) => {
        fx.card.copy(pl);
        const r = fxObj.cardRect(fx, a.mount, view);
        if (!r) return;
        if (holes.some((h) => over(r, h) > 0)) return;
        const out = Math.max(0, -r.x) + Math.max(0, r.x + r.w - 1) + Math.max(0, -r.y) + Math.max(0, r.y + r.h - 1);
        const cost = faceRects.reduce((s, h) => s + 3 * over(r, h) / Math.max(1e-6, h.w * h.h), 0) + i * 0.02 + (out > 0 ? 0.4 + out * 3 : 0);
        if (!best || cost < best.cost) best = { i, cost };
      });
      const b = best as { i: number; cost: number } | null;
      if (!b) { fxObj.cardHidden = true; fx.card.copy(card); notes.push('card hidden: it would cover the OBS hole'); }
      else { fx.card.copy(places[b.i]); if (b.i === 1) fx.side = (-cs) as 1 | -1; if (b.i) notes.push(`card moved (${b.i === 1 ? 'other side' : 'above'})`); }
      // pull it fully into the frame (a performer at the frame edge)
      const r = b ? fxObj.cardRect(fx, a.mount, view) : null;
      if (r) {
        const dx = r.x < 0.02 ? 0.02 - r.x : r.x + r.w > 0.98 ? 0.98 - (r.x + r.w) : 0, dy = r.y < 0.02 ? 0.02 - r.y : 0;
        if (dx || dy) {
          const cw = toW(fx.card), dist = cw.distanceTo(view.position), fh = 2 * dist * Math.tan(THREE.MathUtils.degToRad(view.fov) / 2);
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(view.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(view.quaternion);
          const moved = cw.addScaledVector(right, dx * fh * aspect).addScaledVector(up, -dy * fh);
          const nc = toL(moved), keep = fx.card.clone();
          fx.card.copy(nc);
          const r2 = fxObj.cardRect(fx, a.mount, view);
          if (r2 && holes.some((h) => over(r2, h) > 0)) fx.card.copy(keep); else notes.push('card pulled into the frame');
        }
      }
    }
    const hand: 1 | -1 = m?.ready && m.armed ? (m.shoulderOf(-1) ? -1 : 1) : -1;
    notes.push(`${kind} ${cls}${seated ? ' seated' : ''} · ${framing} · entry ${entry}${from ? ` (from the ${from})` : ''} · side ${side > 0 ? 'their left' : 'their right'}${front ? ' (front)' : ''} · jump ${jump.toFixed(2)} m`);
    return {
      ev, key: a.key, actor: a, runtime: a.runtime, kind, framing, entry, side, seated, cls, H, face, faceSize, cheek, mh, P, S, sOnScreen, jump, baseY, hand,
      bow: slapRand(seed, 6) < 0.55 ? 'bow' : 'dust', fall, arms, toNorm: rest.toNorm?.clone() ?? null, cut, camLocal, fx, from, notes,
    };
  }

  /** The chat buddy (roam / stay, in the room) or the interview sidekick, when the slapper is the same model: where he is. */
  private buddyStart(state: SceneState, iv: ReturnType<SlapScene['interview']>): { pos: THREE.Vector3; from: 'buddy' | 'sidekick' } | null {
    const m = this.minion;
    if (!m?.ready || this.bag.model) return null;
    const b = (this.chat as { buddy?: { ready: boolean; shown: boolean; loadedId: string; overlayOn: boolean; plan?: { mode?: string } | null; actor: SceneActor } | null } | null)?.buddy;
    if (b?.ready && b.shown && !b.overlayOn && b.plan?.mode !== 'fore' && b.loadedId === m.loadedId && state.chat?.buddy) return { pos: b.actor.mount.getWorldPosition(new THREE.Vector3()), from: 'buddy' };
    const sk = iv?.sidekick;
    if (sk?.ready && sk.modelId === m.loadedId && sk.actor.mount.visible) return { pos: sk.actor.mount.getWorldPosition(new THREE.Vector3()), from: 'sidekick' };
    return null;
  }

  // ---------------------------------------------------------------- the minion
  private stepMinion(dt: number, tau: number, t: number) {
    const p = this.plan!, m = this.minion, a = p.actor;
    if (!m?.ready) return;
    if (m.actor.mount.parent !== a.mount) a.mount.add(m.actor.mount);
    m.setHeight(p.mh);
    const d: MinionDrive = restDrive();
    const mount = m.actor.mount;
    let shown = true, appear = 1;
    let pos = p.P.clone(), yaw = 0;
    const faceYaw = yawTo(p.P, p.face);
    const camYaw = p.framing === 'close' ? 0 : yawTo(p.P, p.camLocal);
    const runYaw = yawTo(p.S, p.P), exitYaw = yawTo(p.P, p.S);
    const lane = p.S.distanceTo(p.P);
    const I = SLAP_T.impact;
    // hands (anchor space) — computed lazily from the minion's own rig
    const handTargets = () => this.hands(p, m, tau);
    if (p.entry === 'run' || p.entry === 'poof') {
      const run = p.entry === 'run';
      if (run && tau < 0.3) {
        // anticipation at the lane start: crouch, lean into it, arms back
        pos = p.S.clone(); yaw = runYaw;
        d.crouch = Math.sin(Math.PI * K(tau, 0, 0.3)) * 0.9; d.lean = -0.1 + 0.35 * K(tau, 0.1, 0.3); d.angry = 0.7;
        if (!p.from && p.sOnScreen) appear = easeOutBack(K(tau, 0, 0.14));
      } else if (run && tau < 1.2) {
        const u = K(tau, 0.3, 1.2), e = u * u * (3 - 2 * u);
        pos = p.S.clone().lerp(p.P, e); yaw = runYaw;
        const sp = lane * 6 * u * (1 - u) / 0.9;
        d.gait = clamp01(sp / 0.8); d.speed = sp; d.lean = 0.32 * d.gait; d.angry = 0.85;
      } else if (!run && tau < 1.4) {
        // poof in beside them, rub the hands, grin at the camera
        shown = tau >= 0.42; appear = easeOutBack(K(tau, 0.42, 0.6)); yaw = lerpAng(camYaw, faceYaw, K(tau, 1.1, 1.4));
        d.grin = 0.9; d.jaw = 0.15 * Math.abs(Math.sin(tau * 14));
      } else if (tau < 1.4) {
        // skid to a stop, turning to them
        const u = K(tau, 1.2, 1.4);
        pos = p.P.clone().addScaledVector(p.P.clone().sub(p.S).setY(0).normalize(), 0.12 * Math.sin(Math.PI * u));
        yaw = lerpAng(runYaw, faceYaw, smooth(u)); d.lean = -0.28 * Math.sin(Math.PI * u); d.crouch = 0.5 * Math.sin(Math.PI * u); d.angry = 0.85;
      } else if (tau < 2.42) {
        yaw = faceYaw;
        // wind-up → crouch → jump + slap → land
        d.angry = tau < I ? 1 : 0; d.grin = tau >= I ? 1 : 0; d.jaw = tau >= I && tau < 2.3 ? 0.45 : 0;
        d.twist = tau < I ? p.hand * -0.5 * smooth(K(tau, 1.4, 1.7)) : p.hand * 0.5 * (1 - smooth(K(tau, 2.2, 2.42)));
        if (tau >= 1.72 && tau < 1.86) d.crouch = smooth(K(tau, 1.72, 1.86));
        d.jump = this.jumpAt(p, tau);
        if (tau >= 2.3) d.crouch = 0.6 * (1 - K(tau, 2.3, 2.42));
      } else if (tau < 3.3) {
        this.bowDrive(p, d, tau);
        yaw = lerpAng(faceYaw, camYaw, smooth(K(tau, 2.42, 2.6)));
      } else if (run) {
        // run off the way it came
        const u = K(tau, 3.3, 4.3), e = u * u * (3 - 2 * u);
        const turn = K(tau, 3.3, 3.45);
        yaw = lerpAng(camYaw, exitYaw, smooth(turn));
        pos = p.P.clone().lerp(p.S, e);
        const sp = lane * 6 * u * (1 - u) / 1.0;
        d.gait = clamp01(sp / 0.8); d.speed = sp; d.lean = 0.3 * d.gait; d.grin = 0.8;
        if (tau >= 4.3) shown = false;
        if (p.sOnScreen && !p.from && tau >= 4.22) appear = 1 - K(tau, 4.22, 4.34);
      } else {
        yaw = camYaw; d.grin = 1;
        if (tau >= 3.35) appear = 1 - K(tau, 3.35, 3.47);
        if (tau >= 3.47) shown = false;
      }
    } else {
      // close framing: leap into their frame from low and to the side, slap, bow in the frame, hop back out
      const out0 = p.P.clone().add(new THREE.Vector3(p.side * 1.0, -p.mh * 0.75, 0.05));
      const out1 = p.P.clone().add(new THREE.Vector3(p.side * 1.15, -p.mh * 0.95, 0));
      yaw = faceYaw;
      if (tau < 1.5) shown = false;
      else if (tau < I) {
        const u = K(tau, 1.5, I);
        pos = out0.clone().lerp(p.P, 1 - (1 - u) * (1 - u)).add(new THREE.Vector3(0, p.mh * 0.18 * Math.sin(Math.PI * u), 0));
        d.angry = 1; d.twist = p.hand * -0.5; d.crouch = 0;
      } else if (tau < 2.42) {
        const u = K(tau, I, 2.3);
        pos = p.P.clone().add(new THREE.Vector3(p.side * 0.12 * Math.sin(Math.PI * u), -0.04 * Math.sin(Math.PI * u), 0));
        d.grin = 1; d.jaw = tau < 2.3 ? 0.45 : 0; d.twist = p.hand * 0.5 * (1 - smooth(K(tau, 2.2, 2.42)));
      } else if (tau < 3.3) {
        this.bowDrive(p, d, tau);
        yaw = lerpAng(faceYaw, camYaw, smooth(K(tau, 2.42, 2.6)));
      } else if (tau < 3.75) {
        const u = K(tau, 3.3, 3.75);
        pos = p.P.clone().lerp(out1, u * u).add(new THREE.Vector3(0, p.mh * 0.2 * Math.sin(Math.PI * u), 0));
        yaw = lerpAng(camYaw, yawTo(p.P, out1), smooth(K(tau, 3.3, 3.4))); d.grin = 1;
      } else shown = false;
    }
    if (t < 0) shown = false;
    mount.position.copy(pos);
    mount.rotation.set(0, yaw, 0);
    m.actor.shown = shown;
    m.actor.appear = Math.max(0.001, appear);
    if (shown) {
      const h = handTargets();
      d.hands = h.hands; d.look = h.look;
      m.drive = d;
      m.update(dt, this.rt!.stage.camera.aspect || 16 / 9);
    } else m.actor.sync();
  }

  private jumpAt(p: Plan, tau: number) {
    const I = SLAP_T.impact;
    if (tau < 1.86 || tau >= 2.3 || p.jump <= 0) return 0;
    const u = tau < I ? (tau - I) / 0.14 : (tau - I) / 0.3;
    return Math.max(0, p.jump * (1 - u * u));
  }

  private bowDrive(p: Plan, d: MinionDrive, tau: number) {
    const u = K(tau, 2.42, 3.3);
    const env = smooth(K(u, 0, 0.2)) * (1 - smooth(K(u, 0.8, 1)));
    d.grin = 1;
    if (p.bow === 'bow') { d.bow = 0.8 * env; d.blink = env > 0.6 ? 1 : 0; }
    else { d.jaw = 0.2 * env; d.bow = 0.12 * env; }
  }

  /** Hand + look targets in the minion's anchor space for this moment. */
  private hands(p: Plan, m: Minion, tau: number): { hands: MinionDrive['hands']; look: THREE.Vector3 | null } {
    const a = p.actor, I = SLAP_T.impact;
    const W = (v: THREE.Vector3) => { a.mount.updateWorldMatrix(true, false); return m.toAnchor(a.mount.localToWorld(v.clone())); };
    const look = tau < 2.42 ? W(p.face) : tau < 3.3 ? W(p.camLocal) : null;
    const hs = p.hand, sh = m.shoulderOf(hs), sho = m.shoulderOf((-hs) as 1 | -1);
    const R = m.armLen(hs) || 0.3, Ro = m.armLen((-hs) as 1 | -1) || 0.3;
    const out: MinionDrive['hands'] = { left: null, right: null, w: 0 };
    const set = (side: 1 | -1, v: THREE.Vector3 | null) => { if (side === 1) out.left = v; else out.right = v; };
    const H = m.restH;
    if (!sh) return { hands: out, look };
    if (tau < 1.4 && p.entry === 'poof') {
      // rubbing the hands (poof entry)
      const c = new THREE.Vector3(0, sh.y - R * 0.45, R * 0.55), wig = 0.04 * H * Math.sin(tau * 22);
      set(hs, c.clone().add(new THREE.Vector3(hs * (0.03 * H + wig), 0, 0))); set((-hs) as 1 | -1, c.clone().add(new THREE.Vector3(-hs * (0.03 * H - wig), 0, 0)));
      out.w = smooth(K(tau, 0.5, 0.7));
      return { hands: out, look };
    }
    if (tau >= 1.3 && tau < 2.42) {
      const wind = sh.clone().add(new THREE.Vector3(hs * 0.72, 0.62, -0.42).normalize().multiplyScalar(R * 0.95));
      const cheek = W(p.cheek);
      const through = cheek.clone().add(new THREE.Vector3(-hs * R * 0.5, -R * 0.35, R * 0.1));
      let hand: THREE.Vector3;
      if (tau < 1.86) hand = sh.clone().add(new THREE.Vector3(hs * 0.3, -0.9, 0.2).normalize().multiplyScalar(R)).lerp(wind, smooth(K(tau, 1.3, 1.62)));
      else if (tau < I) hand = wind.clone().lerp(cheek, Math.pow(K(tau, 1.86, I), 2.2));
      else hand = cheek.clone().lerp(through, smooth(K(tau, I, 2.28)));
      // (out of reach: the arm points at it)
      const D = hand.clone().sub(sh); if (D.length() > R) hand = sh.clone().addScaledVector(D.normalize(), R);
      set(hs, hand);
      if (sho) set((-hs) as 1 | -1, sho.clone().add(new THREE.Vector3(-hs * 0.55, -0.05, 0.8).normalize().multiplyScalar(Ro * 0.9)));
      out.w = tau < 1.45 ? smooth(K(tau, 1.3, 1.45)) : tau > 2.3 ? 1 - K(tau, 2.3, 2.42) * 0.6 : 1;
      return { hands: out, look };
    }
    if (tau >= 2.42 && tau < 3.3) {
      const u = K(tau, 2.42, 3.3), env = smooth(K(u, 0, 0.15)) * (1 - smooth(K(u, 0.85, 1)));
      if (p.bow === 'bow') {
        // one hand on the belly, the other swept out: a butler's bow
        set(hs, new THREE.Vector3(0, H * 0.42, H * 0.2));
        if (sho) set((-hs) as 1 | -1, sho.clone().add(new THREE.Vector3(-hs * 0.8, -0.35, 0.3).normalize().multiplyScalar(Ro * 0.95)));
      } else {
        // dusting off the hands: clap-clap-clap in front of the chest
        const c = new THREE.Vector3(0, sh.y - R * 0.3, R * 0.6), gap = 0.05 * H + 0.09 * H * Math.abs(Math.sin(u * Math.PI * 5));
        set(hs, c.clone().add(new THREE.Vector3(hs * gap, 0, 0))); set((-hs) as 1 | -1, c.clone().add(new THREE.Vector3(-hs * gap, 0, 0)));
      }
      out.w = env;
      return { hands: out, look };
    }
    return { hands: out, look };
  }

  // ---------------------------------------------------------------- the target
  private stepTarget(tau: number, t: number) {
    const p = this.plan!, a = p.actor, I = SLAP_T.impact;
    const ti = tau - I;
    // walking TVs: their own tumble clip; projector screens: swing (below); both get a burst of static
    if (p.kind === 'tv' || p.kind === 'projector') {
      if (ti >= 0 && this.tvShot !== p.ev.seq && t - I < 0.6) { this.tvShot = p.ev.seq; try { tvReact(a, p.kind === 'tv' ? 'tumble' : 'react_shock'); } catch { /* optional */ } }
      const flick = ti >= 0 && ti < 1.1 ? (ti < 0.35 ? 1 : 0.8 * Math.max(0, Math.sin(ti * 31)) * (1 - ti / 1.1)) : 0;
      const U = (a.runtime as unknown as { screenMat?: { material?: { uniforms?: Record<string, { value: number }> } } }).screenMat?.material?.uniforms;
      if (U?.uBad && flick > U.uBad.value) U.uBad.value = flick;
      if (p.kind === 'tv') return;
    }
    if (ti < 0) { this.unwrapPose(); return; }
    const s = p.fall.slow;
    // fall angle over time: snap, fall, bounce, lie (dazed), get up (with an overshoot), settle
    let ang = 0, dropK = 0;
    const A = p.fall.max;
    if (p.kind === 'projector') {
      ang = A * Math.exp(-2.1 * ti) * Math.sin(ti * 8.5) * (ti < 3 ? 1 : 0);
    } else if (ti < 0.08) ang = A * 0.1 * (ti / 0.08);
    else if (ti < 0.55 * s) { const u = (ti - 0.08) / (0.47 * s); ang = A * (0.1 + 0.9 * easeIn(u)); dropK = easeIn(u); }
    else if (ti < 0.75 * s) { const u = (ti - 0.55 * s) / (0.2 * s); ang = A * (1 - 0.1 * Math.sin(Math.PI * u)); dropK = 1; }
    else if (ti < 1.55 * s) { ang = A * (1 + 0.015 * Math.sin(ti * 11)); dropK = 1; }
    else if (ti < 2.2 * s) { const u = (ti - 1.55 * s) / (0.65 * s); ang = A * (1 - easeOutBack(u, 1.4)); dropK = 1 - smooth(u); }
    else if (ti < 2.6 * s) { const u = (ti - 2.2 * s) / (0.4 * s); ang = -0.05 * Math.sin(Math.PI * 2 * u) * (1 - u); }
    const fs = Math.sign(p.fall.pivot.x) || (p.side > 0 ? -1 : 1);
    const lift = a.lift;
    if (p.fall.spin) {
      // micro: knocked into a mid-air spin, back to the perch
      const u = clamp01(ti / (1.0 * s));
      const spin = u < 1 ? fs * -Math.PI * 2 * smooth(u) : 0;
      const piv = new THREE.Vector3(0, p.face.y * 0.6, 0);
      const q = new THREE.Quaternion().setFromAxisAngle(Z, spin);
      const arc = new THREE.Vector3(fs * p.H * 0.6 * Math.sin(Math.PI * u), p.H * 0.35 * Math.sin(Math.PI * u), 0);
      lift.position.sub(piv).applyQuaternion(q).add(piv).add(arc);
      lift.quaternion.premultiply(q);
    } else if (Math.abs(ang) > 1e-4 || dropK > 0) {
      // rotate about the pivot (target-mount space) — on top of whatever placed them (seat drop, walk, tracking lift)
      const q = new THREE.Quaternion().setFromAxisAngle(Z, fs * -ang);
      if (p.kind === 'projector') q.multiply(new THREE.Quaternion().setFromAxisAngle(X, 0.3 * ang));
      lift.position.sub(p.fall.pivot).applyQuaternion(q).add(p.fall.pivot).addScaledVector(p.fall.drop, dropK);
      lift.quaternion.premultiply(q);
    }
    // head snap + flailing arms (humanoids, through their pose hook), ~2.6 s then back to tracking
    if (p.kind === 'humanoid' && ti < 2.7 * s) this.wrapPose(); else this.unwrapPose();
    // the dazed stars circle over where the head is now
    if (this.fx) {
      const head = p.face.clone().add(new THREE.Vector3(0, p.faceSize * 0.9, 0));
      const hl = head.clone().sub(p.fall.pivot);
      const q = new THREE.Quaternion().setFromAxisAngle(Z, fs * -ang);
      this.fx.ringAt.copy(hl.applyQuaternion(q).add(p.fall.pivot).addScaledVector(p.fall.drop, dropK)).add(new THREE.Vector3(0, p.faceSize * 0.35, 0));
    }
  }

  /** Bone layer on the target (after tracking + seat + walk): head snap / daze wobble, arms flail then flop. */
  private targetBones(rt: { humanoid: unknown }) {
    const p = this.plan;
    if (!p || !p.toNorm) return;
    const h = rt.humanoid as { getNormalizedBoneNode(n: string): THREE.Object3D | null; normalizedHumanBonesRoot: THREE.Object3D } | null;
    if (!h) return;
    const t = (this.now() - p.ev.at) / 1000, ti = slapTau(t) - SLAP_T.impact, s = p.fall.slow;
    if (ti < 0) return;
    const w = ti < 1.6 * s ? smooth(ti / 0.06) : 1 - smooth((ti - 1.6 * s) / (0.7 * s));
    if (w <= 1e-3) return;
    const toNorm = p.toNorm, fromNorm = toNorm.clone().invert();
    const pre = (bone: string, q: THREE.Quaternion, k: number) => { const n = h.getNormalizedBoneNode(bone); if (n) n.quaternion.premultiply(new THREE.Quaternion().slerp(toNorm.clone().multiply(q).multiply(fromNorm), k)); };
    const L = p.side;
    // head: snapped away from the slap, then a dazed wobble
    const snap = ti < 0.5 ? Math.sin(Math.min(1, ti / 0.07) * Math.PI / 2) * (1 - 0.5 * K(ti, 0.12, 0.5)) : 0.5 * (1 - K(ti, 1.5 * s, 2.2 * s));
    const daze = ti > 0.6 * s && ti < 2.0 * s ? Math.sin(Math.PI * K(ti, 0.6 * s, 2.0 * s)) : 0;
    const e = new THREE.Euler(0.1 * snap + 0.12 * daze * Math.sin(ti * 5), -L * 0.75 * snap + 0.3 * daze * Math.sin(ti * 6.5), L * 0.35 * snap + 0.2 * daze * Math.sin(ti * 4.2), 'YXZ');
    pre('neck', new THREE.Quaternion().setFromEuler(e), 0.4 * w);
    pre('head', new THREE.Quaternion().setFromEuler(e), 0.7 * w);
    // arms: flail while falling, flop while down
    const parentStop = h.normalizedHumanBonesRoot.parent;
    for (const arm of p.arms) {
      const side = arm.side === 1 ? 'left' : 'right';
      const ua = h.getNormalizedBoneNode(`${side}UpperArm`), la = h.getNormalizedBoneNode(`${side}LowerArm`);
      if (!ua || !la) continue;
      const fl = ti < 0.8 * s ? 1 : 1 - K(ti, 0.8 * s, 1.1 * s);
      const wig = Math.sin(ti * 23 + arm.side * 1.7);
      const flail = new THREE.Vector3(arm.side * 0.8, 0.5 + 0.25 * wig, 0.25 + 0.2 * Math.cos(ti * 19)).normalize();
      const flop = new THREE.Vector3(arm.side * 0.6, -0.7, 0.35).normalize();
      const du = flop.clone().lerp(flail, fl).normalize().applyQuaternion(toNorm);
      const dl = du.clone().applyQuaternion(toNorm.clone().invert()).add(new THREE.Vector3(0, 0.2 * fl * wig, 0.3)).normalize().applyQuaternion(toNorm);
      const parentW = worldQ(ua.parent, parentStop, new THREE.Quaternion());
      const upW = new THREE.Quaternion().setFromUnitVectors(arm.restU.clone().applyQuaternion(parentW), du).multiply(parentW);
      ua.quaternion.slerp(parentW.clone().invert().multiply(upW), w * 0.9);
      const upWb = parentW.clone().multiply(ua.quaternion);
      const loW = new THREE.Quaternion().setFromUnitVectors(arm.restL.clone().applyQuaternion(upWb), dl).multiply(upWb);
      la.quaternion.slerp(upWb.clone().invert().multiply(loW), w * 0.9);
    }
  }

  private wrapPose() {
    const p = this.plan!, rt = p.actor.runtime as unknown as { poseHook: ((r: unknown, dt: number) => void) | null } | null;
    if (!rt) return;
    if (this.wrapped && this.wrapped.rt === rt && rt.poseHook === this.wrapped.mine) return;
    const orig = rt.poseHook;
    const mine = (r: unknown, dt: number) => { orig?.(r, dt); try { this.targetBones(r as { humanoid: unknown }); } catch (e) { console.warn('slap: pose', e); } };
    rt.poseHook = mine;
    this.wrapped = { rt, orig, mine };
  }
  private unwrapPose() {
    const w = this.wrapped;
    if (!w) return;
    const rt = w.rt as { poseHook: unknown };
    if (rt.poseHook === w.mine) rt.poseHook = w.orig;
    this.wrapped = null;
  }

  // ---------------------------------------------------------------- effects, sounds, camera
  private stepFx(tau: number) {
    const p = this.plan!, fx = this.fx;
    if (!fx) return;
    if (fx.root.parent !== p.actor.mount) p.actor.mount.add(fx.root);
    fx.sample(tau, p.fx);
  }

  /** The chat buddy steps out while he is the slapper (he pops back onto his timeline after, with a puff). */
  private hideBuddy(t: number) {
    const p = this.plan!;
    if (p.from !== 'buddy' || t < 0 || t >= 4.3 + SLAP_T.stop) return;
    const b = (this.chat as { buddy?: { actor: SceneActor; overlay: THREE.Object3D } | null } | null)?.buddy;
    if (!b) return;
    b.actor.mount.visible = false;
    b.overlay.visible = false;
    const stand = (b as unknown as { stand?: THREE.Object3D }).stand;
    if (stand) stand.visible = false;
  }

  private sounds(t: number) {
    const p = this.plan!;
    if (!this.soundOn || !this.bag.sound) return;
    const cross = (x: number) => this.prevT < x && t >= x && t - x < 0.25;
    const I = SLAP_T.impact;
    if (cross(I)) this.sound.play('slap', p.ev.seed, 1, 0.95 + 0.1 * slapRand(p.ev.seed, 91));
    if (p.kind !== 'tv' && p.kind !== 'projector' && cross(I + SLAP_T.stop + 0.55 * p.fall.slow)) this.sound.play('thud', p.ev.seed + 1, 0.55, p.fall.slow > 1 ? 0.8 : 1);
    if (p.entry === 'poof' && cross(0.4)) this.sound.play('poof', p.ev.seed + 2, 0.35, 1.3, 'in');
    if (p.entry === 'poof' && cross(3.35)) this.sound.play('poof', p.ev.seed + 2, 0.35, 1.3, 'out');
  }

  /** Our camera cut (SceneRuntime.cameraOverride), only while a gag runs and only if it wants one. */
  private cameraShot(): { key: string; pose: CamPose; secs: number } | null {
    const p = this.plan;
    if (!p?.cut) return null;
    const t = (this.now() - p.ev.at) / 1000;
    if (t < 0 || t > SLAP_T.release) return null;
    return { key: `slap:${p.ev.seq}`, pose: p.cut, secs: 0 };
  }

  /** Impact: snap zoom + a short shake on the page's camera (3D views; never with a passthrough hole open). */
  private punch(t: number) {
    const p = this.plan!, rt = this.rt!;
    const ti = slapTau(t) - SLAP_T.impact;
    if (ti < 0 || ti > 0.6 || rt.composite) return;
    if (rt.reactRect()) return;
    const iv = this.interview();
    if (iv?.monitor && iv.monitor.open > 0) return;
    if (p.framing === 'close') return;
    const cam = rt.stage.camera;
    const z = ti < 0.05 ? ti / 0.05 : ti < 0.14 ? 1 : 1 - smooth((ti - 0.14) / 0.4);
    cam.fov = cam.fov * (1 - 0.12 * z);
    cam.updateProjectionMatrix();
    const e = ti < 0.45 ? (1 - ti / 0.45) ** 2 : 0;
    if (e > 0) {
      const big = p.cls === 'macro' ? 1.6 : 1, sd = p.ev.seed;
      const n = (k: number) => Math.sin(ti * 57 + sd * 0.37 + k) * 0.6 + Math.sin(ti * 91 + k * 2.1) * 0.4;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      cam.position.addScaledVector(right, n(1) * 0.028 * e * big).addScaledVector(up, n(2) * 0.022 * e * big);
      cam.rotateZ(n(3) * 0.012 * e * big);
    }
    cam.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- end + debug
  private end() {
    const p = this.plan;
    this.unwrapPose();
    if (this.minion) { this.minion.actor.shown = false; this.minion.actor.sync(); this.minion.actor.mount.removeFromParent(); this.minion.drive = restDrive(); }
    if (this.fx) { this.fx.hide(); this.fx.root.removeFromParent(); }
    if (p) this.doneSeq = p.ev.seq;
    this.plan = null;
  }

  debug() {
    const p = this.plan;
    const t = p ? (this.now() - p.ev.at) / 1000 : null;
    return {
      bag: this.bag, local: !!this.local,
      minion: this.minion ? { model: this.minion.modelId, loaded: this.minion.loadedId, ready: this.minion.ready, failed: this.minion.failed, fallback: this.minion.fallback, shown: this.minion.actor.shown, h: +this.minion.height.toFixed(2) } : null,
      plan: p ? { seq: p.ev.seq, target: p.key, t: t !== null ? +t.toFixed(2) : null, kind: p.kind, framing: p.framing, entry: p.entry, from: p.from, side: p.side, seated: p.seated, cls: p.cls, jump: +p.jump.toFixed(2), fall: +(p.fall.max * 57.3).toFixed(0), cut: !!p.cut, bow: p.bow, lane: +p.S.distanceTo(p.P).toFixed(2), sOnScreen: p.sOnScreen, cardHidden: !!this.fx?.cardHidden, notes: p.notes } : null,
      done: this.doneSeq, stats: { ...this.stats, ms: +this.stats.ms.toFixed(3), planMs: +this.stats.planMs.toFixed(1) },
    };
  }

  dispose() { this.detach(); this.minion?.dispose(); this.minion = null; this.fx?.dispose(); this.fx = null; }
}

function worldQ(n: THREE.Object3D | null, stop: THREE.Object3D | null, out: THREE.Quaternion) {
  out.identity();
  for (let o = n; o && o !== stop; o = o.parent) out.premultiply(o.quaternion);
  return out;
}

