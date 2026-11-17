// Studio ⇄ preview page link. The studio's Scene tab embeds output.html?preview=1 (same origin, or cross-site in its own
// process with the same calls over a port: src/scene/previewBridge.ts) and
// drives it directly — the preview never reads scene state from the bus or the server, so a preview
// (or an ?observer=1 studio) can try rooms / cameras without touching what OBS shows.
import type { SceneState } from '../../shared/types.ts';
import type { ScreenRect } from './screen.ts';

export interface PreviewExtra { key: string; avatarId: string; name: string }

export interface RoomSummary {
  id: string;
  /** Index = SceneState spot index: SPOT_01…12 (0…11), then the size spots (12…: scene.json sizeSpots + automatic
   *  micro perches / macro back-row spots, src/scene/sizeSpots.ts). `sizes` null = an ordinary spot. */
  spots: ({ index: number; label: string; pose: 'sit' | 'stand'; x: number; z: number; yaw: number; sizes?: import('../../shared/avatarSize.ts').SizeClass[] | null;
    /** Body kinds the spot takes (null / missing = any: shared/occupant.ts spotFitOcc). */ kinds?: import('../../shared/occupant.ts').OccupantKind[] | null;
    sizeSpot?: 'auto' | 'json'; clearance?: number } | null)[];
  /** Size classes in this room: automatic size spots derived yet, notes, each performer's class / real / shown height. */
  sizes?: { ready: boolean; notes: string[]; actors: { key: string; cls: import('../../shared/avatarSize.ts').SizeClass; real: number; auto: boolean; shown: number; spot: number | null; fix: string | null }[] };
  cameras: string[];
  screen: boolean;
  /** Spots in front of the big React screen in the Big shot (their occupant would cover it): the controller re-seats them. */
  reactBlock?: number[];
  /** React layout in effect + the solo side screen's placement (source 'node' | 'scene.json' | 'auto'). */
  layout?: 'big' | 'solo';
  /** Solo layout, waiting for its performer to finish walking in. */
  soloPending?: boolean;
  /** React screen content: the host's setting, whether in-scene capture is in effect, whether a window is shared. */
  screenMode?: 'auto' | 'inscene' | 'passthrough';
  inScene?: boolean;
  signal?: boolean;
  /** Room skins (shared/screenSkin.ts): one line per prop, where the choice came from, scene.json problems. */
  skins?: { solo: string; monitor: string; board: string; source: string; warnings: string[] };
  solo?: { source: string; width: number; center: number[]; yaw: number; wfrac: number | null; clear: boolean | null } | null;
  /** PATH_* waypoints (x, z) - the entrance walk. */
  path?: number[][];
  bounds: { min: number[]; max: number[] } | null;
  /** LIGHT_* groups (fixture count, kinds) — the Scene tab's per-group light controls. */
  lights?: { group: string; count: number; kinds: string[] }[];
  /** Room prop toggles (src/scene/roomToggles.ts): scene.json + glb extras, whether each is on here, root nodes found;
   *  the room clips skipped while their group is hidden. Missing = the room has none. */
  toggles?: { id: string; label: string; default: boolean; on: boolean; found: number }[];
  clipsSkipped?: string[];
}

export interface PreviewReport {
  room: RoomSummary | null;
  /** React screen in the output frame with the react camera (fractions of the frame). */
  rect: ScreenRect | null;
  /** Both React layouts' rects (big centre / solo side) and which one is in effect. */
  rects?: { big: ScreenRect | null; solo: ScreenRect | null; layout: 'big' | 'solo'; quads?: { big: [number, number][] | null; solo: [number, number][] | null } } | null;
  loading: boolean;
  error?: string;
  fps?: number;
  /** Background combat in this room (src/scene/raid): anchors present, NPCs on screen, next skirmish (s), cost (ms). */
  raid?: { fight: boolean | null; tagilla: boolean | null; patrol?: boolean; raidCams?: number; director?: string | null; active: number; next: number | null; ms: number } | null;
  /** Scene graphics quality in effect on this preview page (src/stage/gfx/Graphics.ts info()). */
  gfx?: import('../stage/gfx/Graphics.ts').GfxInfo;
  /** Space battle in this room (src/scene/space): anchors, cryo / drop pods, acts on screen, next threat (s), cost (ms). */
  space?: { space: boolean; cryo: number; droppod: number; entrance: string | null; exit: string | null; active: number; next: number | null; ms: number; level: number } | null;
  /** Time of day + weather in this room (src/scene/environment info()): hour, weather blend, darkness, night lights, cost. */
  env?: import('./environment/index.ts').EnvInfo | null;
  /** Kitchen in this room (src/scene/kitchen): anchors, crew size, the episode playing, the next one, the meter. */
  kitchen?: { room: boolean; loaded: boolean; frogs: number; episode: { kind: string; t: number; dur: number } | null; next: { kind: string; in: number } | null; unrest: number; riotAt: number } | null;
  /** Room-change transition on this preview (src/scene/transition/curtain.ts): phase, timings. */
  curtain?: import('../../shared/curtain.ts').CurtainStatus;
  /** Stage layout in effect on this preview (src/scene/stage/compositor.ts info()): plan, capture rect, cams, docks. */
  stage?: ReturnType<import('./stage/compositor.ts').StageCompositor['info']> | null;
  /** React mode: is the React screen in the shot of the camera in use (`cam` = SceneState.camera then, `at` = Date.now())?
   *  null = no React screen showing. The Live panel warns when it isn't (shared/reactShot.ts). */
  shot?: import('../../shared/reactShot.ts').ReactShotReport | null;
  /** AFK cinematic director on this preview (src/scene/afk/afkScene.ts info()): shot on air, next event shot, the plan. */
  afk?: ReturnType<import('./afk/afkScene.ts').AfkScene['info']> | null;
}

/** Implemented by the preview page. */
export interface PreviewPage {
  apply(state: SceneState, self: string, extras: PreviewExtra[]): void;
  setCapture(stream: MediaStream | null): void;
  /** Studio beat analysis → this preview's lights (shared/lightShow.ts BeatPacket). */
  beat?(b: unknown): void;
  /** Play a light look in this preview only (Scene tab preset browser); null = back to the real state. */
  lookPreview?(look: unknown): void;
  /** Observer tests: chat / support events for this preview's in-world chat props only (shared/chat.ts ChatEvent[]). */
  chat?(evs: unknown[]): void;
  /** Play a room-change transition in this preview only (no room change; Scene tab → Transitions → Test). */
  curtainTest?(style: string): void;
  /** Quality benchmark (~10 s) on this preview page (src/stage/gfx/bench.ts). */
  gfxBench?(opts?: { targetFps?: number }): Promise<import('../../shared/graphics.ts').GfxBenchResult>;
  /** Studio (PreviewGate): false = nobody can see this preview (scrolled away, tab hidden, box collapsed) — the page
   *  stops drawing until true again (the last picture stays). `note` = a label over that picture (the opt-in pause).
   *  A paused page still runs its room logic twice a second and reports about once a second (room stats, React
   *  re-seat hints), and full frames while anything the studio waits on is in flight (output.ts previewBusy). */
  setActive?(on: boolean, note?: string | null): void;
  /** Studio: a frame-rate cap under the page's own ?fps= while tracking runs (null = the page's own again). */
  setFps?(fps: number | null): void;
  /** The preview page's own window: the studio finds its <iframe> (frameElement) from it. */
  view?: Window;
  /** A cross-site preview's <iframe> (src/scene/previewBridge.ts: its window can't be read from here). */
  frame?: HTMLIFrameElement;
}

/** Implemented by the studio (window.vtpScenePreview). */
export interface PreviewHost {
  connect(page: PreviewPage): { report(r: PreviewReport): void; disconnect(): void };
}

// ---------------------------------------------------------------- PreviewGate
// The room preview (output.html?preview=1) is a SAME-ORIGIN iframe: it runs on the studio's main thread — the thread
// that submits camera frames to the tracker and handles its results — and draws through the studio's GPU process.
// A Kingsmarch preview costs ~230 ms of main thread per second at 20 fps (measured). The gate pauses it whenever
// nobody can see it (no visual change), and offers two opt-in savings while tracking runs.

/** Opt-in settings (this computer; Room → Advanced preview options). Defaults change nothing. */
export const PREVIEW_FPS_KEY = 'vtp.scene.previewFps';          // '20' (default) | '10' | '5' — while tracking runs
export const PREVIEW_PAUSE_KEY = 'vtp.scene.previewPauseBlur';  // '1' = pause while tracking when this window has had no focus for 10 s (in-page previews, not a pop-out)
export const PREVIEW_FPS_CHOICES = [20, 10, 5] as const;
export const PREVIEW_PAUSE_MS = 10000;
export const PREVIEW_PAUSED_NOTE = 'Preview paused to save the tracker';

const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
/** The chosen preview fps while tracking (20 = the page's own rate, unchanged). */
export function previewFpsSetting(get: (k: string) => string | null = lsGet): number {
  const v = parseInt(get(PREVIEW_FPS_KEY) ?? '', 10);
  return (PREVIEW_FPS_CHOICES as readonly number[]).includes(v) ? v : 20;
}
export const previewPauseSetting = (get: (k: string) => string | null = lsGet) => get(PREVIEW_PAUSE_KEY) === '1';

export interface GateInput {
  /** The studio page is hidden (minimised, another browser tab). */
  docHidden: boolean;
  /** The preview's <iframe> was found (false: a pop-out window — only its own visibility counts). */
  frameKnown: boolean;
  /** Some of the frame is inside the viewport (IntersectionObserver), and it has a box (not collapsed / display:none). */
  inView: boolean;
  hasBox: boolean;
  tracking: boolean;
  fpsWhileTracking: number;
  pauseUnfocused: boolean;
  /** How long the studio window has had no focus (ms; 0 = focused). */
  unfocusedMs: number;
}
export interface GateOutput { active: boolean; note: string | null; fps: number | null }

/** Pure decision (tools/room_render_unit.ts). Anything unknown counts as visible: a preview is never paused on a doubt. */
export function previewGate(s: GateInput): GateOutput {
  const fps = s.tracking && s.fpsWhileTracking > 0 && s.fpsWhileTracking < 20 ? s.fpsWhileTracking : null;
  if (s.docHidden) return { active: false, note: null, fps };
  if (s.frameKnown && (!s.inView || !s.hasBox)) return { active: false, note: null, fps };
  // (the studio window's focus says nothing about a popped-out preview: it is its own window — clicking into it even
  // takes the studio's focus — that the host put somewhere to watch it, e.g. next to OBS: only its own visibility counts)
  if (s.frameKnown && s.tracking && s.pauseUnfocused && s.unfocusedMs >= PREVIEW_PAUSE_MS) return { active: false, note: PREVIEW_PAUSED_NOTE, fps };
  return { active: true, note: null, fps };
}

type Listen = { addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void };
export interface GateEnv {
  doc: Listen & { visibilityState: string; hasFocus(): boolean };
  win: Listen;
  now(): number;
  every(fn: () => void, ms: number): () => void;
  get(k: string): string | null;
  IO?: typeof IntersectionObserver;
  RO?: typeof ResizeObserver;
}
const browserEnv = (): GateEnv => ({
  doc: document, win: window, now: () => performance.now(), get: lsGet,
  every: (fn, ms) => { const t = window.setInterval(fn, ms); return () => window.clearInterval(t); },
  IO: typeof IntersectionObserver === 'function' ? IntersectionObserver : undefined,
  RO: typeof ResizeObserver === 'function' ? ResizeObserver : undefined,
});

/** One per connected preview page (SceneController.connectPreview): watches its frame + the studio window and tells the
 *  page when to draw (setActive) and how fast (setFps). Disposes itself when the frame / window goes away. */
export class PreviewGate {
  private frame: HTMLIFrameElement | null = null;
  private inView = true;
  private hasBox = true;
  private unfocusedAt: number | null = null;
  private last = '';
  private stops: (() => void)[] = [];
  private dead = false;
  /** What the gate last told the page (tests / the studio report). */
  state: GateOutput = { active: true, note: null, fps: null };

  constructor(private page: PreviewPage, private tracking: () => boolean, private env: GateEnv = browserEnv()) {
    try { this.frame = page.frame ?? (page.view?.frameElement as HTMLIFrameElement | null) ?? null; } catch { this.frame = null; }
    const e = this.env, f = this.frame;
    const on = (t: Listen, ev: string, fn: () => void) => { t.addEventListener(ev, fn); this.stops.push(() => t.removeEventListener(ev, fn)); };
    try {
      if (f && e.IO) {
        const io = new e.IO((ents) => { const x = ents[ents.length - 1]; if (x) { this.inView = x.isIntersecting && x.intersectionRect.width >= 1 && x.intersectionRect.height >= 1; this.apply(); } }, { threshold: [0, 0.01] });
        io.observe(f); this.stops.push(() => io.disconnect());
      }
      if (f && e.RO) {
        const ro = new e.RO((ents) => { const x = ents[ents.length - 1]; if (x) { this.hasBox = x.contentRect.width >= 1 && x.contentRect.height >= 1; this.apply(); } });
        ro.observe(f); this.stops.push(() => ro.disconnect());
      }
    } catch { this.inView = true; this.hasBox = true; }
    on(e.doc, 'visibilitychange', () => this.apply());
    // a popped-out preview: its own window being minimised / restored counts at once, not on the next poll (which a
    // hidden studio tab's timer throttling can delay by seconds)
    if (!f) try { const pd = page.view?.document as unknown as Listen | undefined; if (pd && pd !== e.doc) on(pd, 'visibilitychange', () => this.apply()); } catch { /* closed / cross-window: the poll still sees it */ }
    on(e.win, 'focus', () => { this.unfocusedAt = null; this.apply(); });
    on(e.win, 'blur', () => { this.unfocusedAt ??= e.now(); this.apply(); });
    this.stops.push(e.every(() => this.poll(), 500));
    this.apply();
  }

  private poll() {
    const f = this.frame;
    // the frame left the page / the pop-out closed: this gate is done (the page disconnects itself on pagehide)
    try { if ((f && !f.isConnected) || this.page.view?.closed) { this.dispose(); return; } } catch { /* cross-window */ }
    try { if (this.env.doc.hasFocus()) this.unfocusedAt = null; else this.unfocusedAt ??= this.env.now(); } catch { this.unfocusedAt = null; }
    // (display:none ancestors: no client rects — the observers may not say so when nothing intersected before either)
    try { if (f) this.hasBox = f.getClientRects().length > 0 && f.offsetWidth >= 1 && f.offsetHeight >= 1; } catch { this.hasBox = true; }
    this.apply();
  }

  /** Recompute and tell the page (only when something changed). */
  apply() {
    if (this.dead) return;
    let out: GateOutput;
    try {
      const e = this.env;
      // (a pop-out window: its own visibility, not the studio's)
      let vis = e.doc.visibilityState;
      if (!this.frame) try { vis = this.page.view?.document?.visibilityState ?? vis; } catch { /* closed */ }
      out = previewGate({
        docHidden: vis === 'hidden', frameKnown: !!this.frame, inView: this.inView, hasBox: this.hasBox,
        tracking: !!this.tracking(), fpsWhileTracking: previewFpsSetting(e.get), pauseUnfocused: previewPauseSetting(e.get),
        unfocusedMs: this.unfocusedAt === null ? 0 : e.now() - this.unfocusedAt,
      });
    } catch { out = { active: true, note: null, fps: null }; }
    const sig = JSON.stringify(out);
    if (sig === this.last) return;
    this.last = sig; this.state = out;
    try { this.page.setActive?.(out.active, out.note); } catch { /* page gone */ }
    try { this.page.setFps?.(out.fps); } catch { /* page gone */ }
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    for (const s of this.stops.splice(0)) try { s(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- the preview page's side (output.ts)
/** A paused preview looks again this often (ms) instead of on every display frame. */
export const PREVIEW_LOOK_MS = 100;

export interface LoopEnv {
  raf(cb: (ts: number) => void): void;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(t: number): void;
}
const browserLoopEnv = (): LoopEnv => ({
  raf: (cb) => { window.requestAnimationFrame(cb); },
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: (t) => window.clearTimeout(t),
});

/** Scheduling of the preview / OBS page's render loop (output.ts loop): display-rate frames on requestAnimationFrame,
 *  or, while the studio has paused the preview, a look every PREVIEW_LOOK_MS on a timer. The page queues its next
 *  callback BEFORE the frame's work (the busy check, an idle logic frame, a drawn frame), so one error in a frame
 *  never stops the loop; kick() (the studio un-pauses the page or sends it anything) moves a waiting look to the next
 *  display frame and restarts a loop that has nothing queued at all. Never more than one callback queued. */
export class PreviewLoop {
  private timer: number | null = null;
  private rafQueued = false;
  // (one callback each, made once: nothing allocated per frame on the OBS page)
  private readonly onFrame = (ts: number) => { this.rafQueued = false; this.run(ts); };
  private readonly onLook = () => { this.timer = null; this.frame(); };
  constructor(private run: (ts?: number) => void, private env: LoopEnv = browserLoopEnv()) {}
  /** Next display frame (a waiting look is dropped: the frame comes sooner). */
  frame() {
    if (this.timer !== null) { this.env.clearTimeout(this.timer); this.timer = null; }
    if (this.rafQueued) return;
    this.rafQueued = true;
    this.env.raf(this.onFrame);
  }
  /** Look again in `ms` (default PREVIEW_LOOK_MS) while paused. Nothing to do while a frame or a look is already queued. */
  later(ms: number = PREVIEW_LOOK_MS) {
    if (this.rafQueued || this.timer !== null) return;
    this.timer = this.env.setTimeout(this.onLook, ms);
  }
  /** Look now: a waiting look becomes the next display frame; a loop with nothing queued starts again. */
  kick() { if (!this.rafQueued) this.frame(); }
  /** What is queued (tests / debugging). */
  get queued(): 'frame' | 'look' | null { return this.rafQueued ? 'frame' : this.timer !== null ? 'look' : null; }
}

/** A paused preview runs full frames for a while after anything the studio waits on (output.ts previewBusy), and
 *  longer while the camera still glides: the React re-seat analysis waits for a settled shot, so a glide is seen
 *  through, then PREVIEW_GLIDE_TAIL_MS more. That extension stops PREVIEW_GLIDE_CAP_MS past the wake's own end: enough
 *  for the longest glide (a 5 s camera transition starting as late as the end of a 3 s wake) plus its tail, and a
 *  camera that never settles (glides re-aimed back to back) cannot keep a preview nobody can see drawing at the full
 *  rate. After that the idle logic frames carry on as for any paused preview. */
export const PREVIEW_GLIDE_TAIL_MS = 1000;
export const PREVIEW_GLIDE_CAP_MS = 6000;
/** The paused preview's new wake end (ms, the page clock): `until` = the current end, `reasonUntil` = the end set by
 *  the wake reasons themselves (a message from the studio, a load / walk / reveal that finished). */
export function previewWakeEnd(until: number, reasonUntil: number, now: number, gliding: boolean): number {
  if (!gliding) return until;
  return Math.max(until, Math.min(now + PREVIEW_GLIDE_TAIL_MS, reasonUntil + PREVIEW_GLIDE_CAP_MS));
}
