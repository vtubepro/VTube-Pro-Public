// Studio app core: owns the stage, tracking pipeline, avatar runtime, and the frame loop.

import { ExternalFaceSource, type TrackingSourceChoice } from './tracking/externalSource.ts';
import { FaceChain, SENTENCE } from './tracking/faceChain.ts';
import { OsfController } from './tracking/openSeeFace/osfController.ts';
import { OcclusionFallback } from './tracking/occlusion.ts';
import { Party } from './party.ts';
import { SceneController } from './scene/controller.ts';
import { slapCommand } from './ui/slapPanel.ts';
import { yachtCommand } from './ui/yachtPanel.ts';
import { voyageCommand } from './ui/voyagePanel.ts';
import { rig2dSliderCommand } from './ui/rig2dSliders.ts';
import { collectMeshes } from './avatar/surfacePatch.ts';
import { guessFaceMarkers } from './avatar/faceGuess.ts';
import { SpeechFusion, type CamSample } from './tracking/speechFusion.ts';
import { GpuVision } from './tracking/gpuVision.ts';
import { isObserverTab } from './ui/observerMode.ts';
import { probeReadback, readback } from './core/readbackProbe.ts';
import { LipLookahead, loadLookahead } from './tracking/lipLookahead.ts';
import { modelForLookahead } from './tracking/neuralMerge.ts';
import * as THREE from 'three';
import type { AvatarProfile, SurfaceMarker, TrackingFrame } from '../shared/types.ts';
import { resolveExpression } from '../shared/showDock.ts';
import { studioViewHidden } from './ui/previewRate.ts';
import { normalizeProfile } from '../shared/defaults.ts';
import { api } from './api.ts';
import { LAST_KEY } from './net/helperLib.ts';
import { AvatarRuntime } from './avatar/AvatarRuntime.ts';
import { Bus } from './bus.ts';
import { ShotEncoder, Stage, type ShotDots } from './stage/Stage.ts';
import { FpsGate } from './outputSync.ts';
import { AudioLipSync } from './tracking/audioLipSync.ts';
import { BodySolver, type BodyTargets } from './tracking/bodySolver.ts';
import { PREFERRED_CAMERA, VideoSource, type CameraRequest } from './tracking/camera.ts';
import { autoPickCamera, mediaFailed } from './ui/autopilot/media.ts';
import { FaceSolver, emptyFrame } from './tracking/faceSolver.ts';
import { lipTestHands } from './tracking/mouthVisibility.ts';
import { MultiCam } from './tracking/multicam/multiCam.ts';
import { DEFAULT_STYLE, fitStyle, loadSpeakingProfile, saveSpeakingProfile, sharpen, type SpeakingProfile, type StyleSample } from './tracking/speakingProfile.ts';
import { Tracker, type QualityTier, type RawTracking } from './tracking/Tracker.ts';
import { debounce, toast } from './ui/dom.ts';
import { showAiWaiting, type AiWaitingItem } from './ui/aiWaiting.ts';
import { CLIP_SCRIPT, ClipRecorder } from './tracking/clipRecorder.ts';
import { GestureDetector, type GestureKind } from './tracking/gestures.ts';
import { REACTIONS } from './avatar/effects.ts';
import { EXPR_CLASSES, EXPR_PRESETS, classifyExpr, exprFeatures, exprGate, trainExprModel, type ExprClass, type ExprModel } from './tracking/expressionModel.ts';
import DEFAULT_EXPR_MODEL from './tracking/expressionModel.default.json';
import { AsymEma } from './tracking/filters.ts';
import { JitterMeter, MotionRecorder } from './tracking/jitterMeter.ts';
import type { Viseme } from './tracking/visemes.ts';
import { SnackController, applySip } from './tracking/snackController.ts';
import { EMOTES, type EmoteState } from './avatar/emotes.ts';
import { LearnMe } from './tracking/learnMe.ts';
import { FaceModel } from './tracking/faceNet/faceModel.ts';
import { TrackLoss } from './tracking/trackLoss.ts';
import { HeadFollower, StarveMeter, starveFace, withStarve } from './tracking/stallLife.ts';
import { trackingHealthNow } from './stage/gfx/healthBeacon.ts';
import { sanitizeTrackLoss } from '../shared/trackLoss.ts';
import { applyBlendCurves, sanitizeBlendCurves, type BlendCurves } from '../shared/blendCurves.ts';
import { ARKIT } from './core/arkit.ts';
import { TRACK_PARTS, resolveTrackParts, sameParts, withPart, type TrackPart, type TrackParts } from '../shared/trackParts.ts';
import { PartFade, loadTrackParts, saveTrackParts } from './tracking/trackParts.ts';
import type { TrackingTuning } from '../shared/types.ts';
import { avatarDetailOf } from '../shared/avatarDetail.ts';
import { setFlatOverlayHost } from './avatar/flat/overlay.ts';
import type { FlatCue } from '../shared/flatAvatar.ts';
import { SOFT_PRESET, detectSoftwareGl, type SoftGlState } from './stage/gfx/softwareGl.ts';
import { glDiag } from './core/glDiag.ts';
import { faceOnlyParts } from './mobile/cameraProfile.ts';
import { isPhone } from './mobile/device.ts';
import { adoptBuildFree, sameAvatarBuild } from '../shared/profileBuild.ts';
import { autoFaceNeeds, autoFacePlace } from '../shared/autoFace.ts';
import { autoPickA2f } from './tracking/lipEngine.ts';
import { showA2fChip, showA2fPrompt } from './ui/a2fPrompt.ts';
import { installCacheLru, type CacheLike } from './core/cacheLru.ts';
import { mountB16 } from './b16/mount.ts';
import { runAvatarBeforeDispose, runAvatarLoaded } from './avatar/b16Hooks.ts';

THREE.Cache.enabled = true;
// ...but not forever: the downloaded GLB bytes it keeps are capped at 256 MB, least recently used first (src/core/cacheLru.ts).
// What is on screen (the avatar + its costumes, the one before it, the room) is never dropped: App.cachePrefixes().
let cacheKeep: () => string[] = () => [];
installCacheLru(THREE.Cache as unknown as CacheLike, (key) => cacheKeep().some((p) => key.includes(p)));

export type PlaceKind = 'eyeL' | 'eyeR' | 'mouth' | 'shoulderL' | 'shoulderR' | 'handL' | 'handR' | 'jiggle';

/** `fps`: studio preview frames drawn per second (0 while the preview is hidden). `loopHz`: studio ticks per second
 *  (tracking intake, voice, avatar, OBS publish; ~60). `avatarHz`: avatar updates per second. `rafHz`: display frames
 *  the browser offered per second (the monitor's refresh rate, minus the ones a busy main thread missed). */
export interface Stats { fps: number; inferMs: number; tracked: boolean; delegate: string; camera: string; trackFps?: number; latencyMs?: number; bodyMs?: number; trackMode?: string; leadMs?: number; quality?: number; loopHz?: number; avatarHz?: number; rafHz?: number }

/** Seconds from the studio publishing a frame to it being on screen in OBS (bus hop + the OBS render frame). */
const OUTPUT_LAG = 0.022;
/** Studio "Light" preview while live: drawing-buffer budget (about 1080p worth of pixels). */
const LIGHT_PREVIEW_PIXELS = 2.1e6;
/** Diagnostics: width of the 3-second stage.jpg and camera.jpg snapshots. */
const DIAG_STAGE_W = 960, DIAG_CAMERA_W = 640;
/** Expression classes that speech shape-shifts into (held back while talking). */
const SPEECH_SENSITIVE = new Set<ExprClass>(['sad', 'angry', 'kiss', 'puff', 'surprised']);
/** No tracker results this tick. */
const NO_RAW: RawTracking[] = [];
/** Most tracker results kept between two studio ticks (at 60 ticks/s and a <= 60 fps camera it is 1-2). */
const RAW_QUEUE_MAX = 4;

/** Named test expressions (preview without a camera, and to tune the face). */
export const TEST_EXPRESSIONS: Record<string, Record<string, number>> = {
  Neutral: {},
  Talk: { jawOpen: 0.6 },
  Smile: { mouthSmileLeft: 1, mouthSmileRight: 1, cheekSquintLeft: 0.5, cheekSquintRight: 0.5 },
  'Big grin': { mouthSmileLeft: 1, mouthSmileRight: 1, jawOpen: 0.55, cheekSquintLeft: 0.8, cheekSquintRight: 0.8, eyeSquintLeft: 0.5, eyeSquintRight: 0.5 },
  Surprised: { jawOpen: 0.8, mouthFunnel: 0.5, browOuterUpLeft: 1, browOuterUpRight: 1, browInnerUp: 1, eyeWideLeft: 1, eyeWideRight: 1 },
  Angry: { browDownLeft: 1, browDownRight: 1, mouthFrownLeft: 0.8, mouthFrownRight: 0.8, noseSneerLeft: 0.6, noseSneerRight: 0.6, mouthPressLeft: 0.6, mouthPressRight: 0.6 },
  Sad: { browInnerUp: 1, mouthFrownLeft: 1, mouthFrownRight: 1, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
  'Ooh': { mouthPucker: 1, jawOpen: 0.15 },
  'Oh!': { mouthFunnel: 1, jawOpen: 0.5 },
  Blink: { eyeBlinkLeft: 1, eyeBlinkRight: 1 },
  Wink: { eyeBlinkLeft: 1, mouthSmileLeft: 0.8, mouthSmileRight: 0.3 },
  Puff: { cheekPuff: 1, mouthPucker: 0.3 },
  Tongue: { jawOpen: 0.45, tongueOut: 1 },
  Smirk: { mouthSmileLeft: 0.9, mouthLeft: 0.4, browDownRight: 0.5 },
  Shout: { jawOpen: 0.85, mouthFrownLeft: 0.9, mouthFrownRight: 0.9, browDownLeft: 1, browDownRight: 1 },
  EE: { mouthStretchLeft: 1, mouthStretchRight: 1, jawOpen: 0.25 },
  'M/B/P': { mouthPressLeft: 1, mouthPressRight: 1, mouthRollUpper: 0.5 },
  'Jaw side': { jawOpen: 0.5, jawLeft: 0.8 },
  'F / V': { _fv: 1 },
  'S / SH': { _sib: 1, jawOpen: 0.1 },
  // ':P' — tongue hanging over the lower lip, flat upper teeth band above it
  'Tongue out': { tongueOut: 1, jawOpen: 0.35, mouthSmileLeft: 0.5, mouthSmileRight: 0.5 },
  // viseme engine checks (`_vis_<viseme>` = a speech viseme weight; see src/avatar/visemeRig.ts)
  'V·PP': { _vis_PP: 1 },
  'V·FF': { _vis_FF: 1, jawOpen: 0.1 },
  'V·TH': { _vis_TH: 1, jawOpen: 0.2 },
  'V·L': { _vis_L: 1, jawOpen: 0.4 },
  'V·SH': { _vis_CH: 1, jawOpen: 0.12 },
  'V·SS': { _vis_SS: 1, jawOpen: 0.08 },
  'V·OO': { _vis_U: 1, jawOpen: 0.2 },
  'V·RR': { _vis_RR: 1, jawOpen: 0.25 },
  'V·aa': { _vis_aa: 1, jawOpen: 0.75 },
  'V·smile-talk': { _vis_E: 1, jawOpen: 0.45, mouthSmileLeft: 0.9, mouthSmileRight: 0.9 },
  'V·angry-shout': { _vis_aa: 1, jawOpen: 0.9, browDownLeft: 1, browDownRight: 1, mouthFrownLeft: 0.6, mouthFrownRight: 0.6 },
};

export class App {
  readonly stage: Stage;
  readonly bus = new Bus('studio');
  readonly tracker = new Tracker();
  readonly video = new VideoSource();
  readonly face = new FaceSolver();
  /** Optional second webcam (stereo / close-up mouth / body), see tracking/multicam/multiCam.ts. */
  readonly multicam = new MultiCam(this.tracker);
  /** Main camera as opened (label / size / device) — camera 2 is calibrated against it. */
  mainCam: { label: string; w: number; h: number; deviceId: string } | null = null;
  private mcWatchT = 0;
  readonly body = new BodySolver();
  /** Live jitter meters + rolling raw-landmark recorder (diagnostics only; see jitterMeter.ts). */
  readonly jitter = new JitterMeter();
  readonly motionRec = new MotionRecorder();
  private motionUpT = 0;
  private snackUpT = 0;
  private meterBodyId = -1;
  readonly audio = new AudioLipSync();
  /** Per-frame speech fusion taps (diagnostics / tuning tools). */
  private speech = new SpeechFusion();
  /** GPU camera sidecars: Maxine AR face expressions, RTMW whole-body pose (tracking/gpuVision.ts, docs/GPU_TRACKING.md) */
  readonly gpuVision = new GpuVision();
  /** "My speaking profile" (tracking/speakingProfile.ts): the performer's own voice → mouth-shape style, every avatar. */
  speakingProfile: SpeakingProfile | null = loadSpeakingProfile();
  /** "Keep learning me" (opt-in, off by default): learns this performer's lip / blink / motion style from their own
   *  sessions (features only, this PC only) — tracking/learnMe.ts. Never records party guests or observer tabs. */
  readonly learnMe = new LearnMe(isObserverTab());
  /** "My face model" (opt-in, off by default): a small image-input expression net taught on this performer's own face (a guided ~2.5 minute
   *  routine, trained in a worker on this PC) and folded into the face scores before the solvers, only for the channels it proved better on
   *  frames it never saw — tracking/faceNet/, docs/FACE_MODEL.md. Does nothing until the performer teaches it; observer tabs never run it. */
  readonly faceModel = new FaceModel({ host: this.tracker, observer: isObserverTab(), trackingOn: () => this.trackingOn,
    busy: () => (this.learnMe.learning ? 'Keep learning me finishes' : this.setupRunning ? 'the setup test finishes' : ''),
    maxineOn: () => this.gpuVision.settings.maxine.on && this.gpuVision.dbg.faceUsed, trackMaxine: (on) => { this.gpuVision.trackMapped = on; } });
  /** guided-setup capture of voice + camera mouth pairs for the speaking profile (vowel + talk steps) */
  private styleRec: { on: boolean; aud: { t: number; level: number; w: number[] }[]; cam: { t: number; open: number; wide: number; round: number; pucker: number }[] } | null = null;
  /** Apply (or clear) the speaking profile's face style. */
  applySpeakingProfile(p: SpeakingProfile | null) {
    this.speakingProfile = p;
    this.speech.style = this.learnMe.styleFor(p?.face?.style);
    saveSpeakingProfile(p);
  }
  /** optional lip-sync lookahead (Track tab → Voice lip-sync; pairs with the mic's OBS Sync Offset). 0 = off */
  readonly lookahead = Object.assign(new LipLookahead(), { delayMs: loadLookahead() });
  /** neural viseme model for the stored lookahead, chosen before the mic opens (then per tick) */
  private readonly nvModelInit = this.audio.setNeuralModel(modelForLookahead(this.lookahead.delayMs));
  private occlusion = new OcclusionFallback();
  /** When tracking is lost (src/tracking/trackLoss.ts): hold / rest / voice life per part, eased both ways. */
  readonly trackLoss = new TrackLoss();
  /** Face results sparse / late (a game holding the graphics card): how starved the face is (frame.starve) and the head's
   *  smooth follower — no statue and no snap on stream (src/tracking/stallLife.ts). */
  readonly starveMeter = new StarveMeter();
  private headFollow = new HeadFollower();
  private trackLossSrc: unknown = null;
  /** The avatar's saved per-channel curves (shared/blendCurves.ts), cleaned once per change (the object identity is the key). */
  private curvesSrc: unknown = null;
  private curvesOk: BlendCurves | undefined;
  private occOn = false;
  /** Hands / Body switches (shared/trackParts.ts): this browser's choice, for every avatar. The face always tracks. */
  private partsSaved: Partial<TrackParts> = loadTrackParts();
  /** The switch state the tracker / sidecars / camera 2 were last set up for. */
  private partsApplied: TrackParts = resolveTrackParts(this.partsSaved, null);
  /** Eases a switched-off part into the rest pose (src/tracking/trackParts.ts). */
  private readonly partFade = new PartFade();
  /** Face tracking from phones / VMC apps / VTS plugins (server relays it as 'ext' bus messages). */
  readonly external = new ExternalFaceSource(null);
  trackingSource: TrackingSourceChoice = ((v) => (v && v !== 'phone-web' ? v : 'webcam') as TrackingSourceChoice)(localStorage.getItem('vtp.trackSource'));   // ('phone-web' = a source of an older build: gone)
  setTrackingSource(k: TrackingSourceChoice) {
    if (k !== 'openseeface' && this.osf.running) this.endOpenSeeFace(k === 'webcam');   // (another source, or back to the webcam's usual tracker)
    this.trackingSource = k;
    localStorage.setItem('vtp.trackSource', k);
    this.external.source = k === 'webcam' ? null : k;   // resets filters and the rest pose
    this.emit('status:' + (k === 'webcam' ? 'Webcam tracking' : `External tracking: ${k}`));
    if (k === 'openseeface' && this.trackingOn && !this.osf.running) void this.startOpenSeeFace('The light face tracker follows your face now.');
  }

  // ---- the face tracker's fallback chain (src/tracking/faceChain.ts): MediaPipe on the card -> on the processor -> OpenSeeFace
  readonly faceChain = new FaceChain();
  readonly osf = new OsfController();
  /** The last thing the chain told the user (the Tracking panel shows it next to its buttons). */
  chainNote = '';
  private chainT = 0;
  private chainAsked = false;
  private chainInitError: string | undefined;
  private osfStarting = false;
  /** The source to give back when OpenSeeFace was switched on by the chain (not saved: a restart begins with the usual tracker). */
  private osfPrev: TrackingSourceChoice | null = null;

  private chainStep(now: number) {
    if (this.observer || (this.trackingSource !== 'webcam' && !this.osf.running)) return;
    if (!this.chainAsked) { this.chainAsked = true; void this.osf.refresh(); }     // once per camera start: are the models there?
    const f = this.tracker.models().roles?.face ?? null;
    const a = this.faceChain.step({
      now, trackingOn: this.trackingOn, camFps: this.tracker.camFps(now), faceDelegate: f ? (f.delegate === 'CPU' ? 'CPU' : 'GPU') : '', faceHz: f?.hz ?? 0,
      faceInFlightMs: this.tracker.inFlightMs, initError: this.chainInitError, cpuReason: f?.reason, policy: this.tracker.delegatePolicy,
      osf: { installed: this.osf.installed, running: this.osf.running, hz: this.osf.status.hz },
    });
    if (!a) return;
    this.chainNote = a.text;
    if (a.kind === 'say') toast(a.text, a.level === 'warn' ? 'warn' : 'info', 8000);
    else if (a.kind === 'offer-openseeface') toast(a.text, 'warn', 15000);
    else void this.startOpenSeeFace(a.text);
    this.emit('chain');
  }

  /** Follow the face with OpenSeeFace (the chain's last step, or the Tracking panel's button). */
  async startOpenSeeFace(text: string, hadEngine = true): Promise<boolean> {
    if (this.osf.running) return true;
    if (this.osfStarting || this.observer || !this.video.ready) return false;
    this.osfStarting = true;
    try {
      const ok = await this.osf.start(this.video.video, (d) => this.external.push(d, performance.now() / 1000));
      if (!ok) {
        // never silent: what went wrong, and which engine carries on (the usual tracker was not touched)
        const why = this.osf.status.text;
        const say = hadEngine ? `${why} ${SENTENCE.osfFailed}` : why;
        this.chainNote = say; toast(say, 'warn', 10000);
        if (this.trackingSource === 'openseeface' && this.osfPrev === null) this.setTrackingSource('webcam');   // picked by hand, could not start: back to the webcam
        this.emit('chain');
        return false;
      }
      if (this.trackingSource !== 'openseeface') { this.osfPrev = this.trackingSource; this.trackingSource = 'openseeface'; this.external.source = 'openseeface'; }
      this.chainNote = text;
      toast(text, 'warn', 10000);
      this.emit('status:Light face tracking');
      // the usual tracker's face model STOPS (Tracker.configure ends its worker; pose and hands carry on) and nothing solves it
      if (this.tracker.face) {
        try { await this.tracker.configure({ tier: this.tier, body: this.parts.body, hands: this.parts.hands, face: false }); }
        catch (e) { console.warn('[faceChain] could not stop the usual face model', e); }
      }
      this.emit('chain'); this.emit('tracking');
      return true;
    } finally { this.osfStarting = false; }
  }

  /**
   * Stop OpenSeeFace. `restoreFace`: the usual tracker's face model comes back first ("Try the usual tracker again"); if it
   * cannot start, OpenSeeFace keeps going and the user is told. Without it (camera stopped, another source picked) it ends at once.
   */
  endOpenSeeFace(restoreFace = true): Promise<void> | void {
    const finish = () => {
      this.osf.stop();
      if (this.osfPrev !== null) { const prev = this.osfPrev; this.osfPrev = null; if (this.trackingSource === 'openseeface') { this.trackingSource = prev; this.external.source = prev === 'webcam' ? null : prev; } }
      this.faceChain.retryMediaPipe(); this.chainInitError = undefined; this.chainAsked = false;
      this.emit('chain');
    };
    if (!restoreFace || !this.trackingOn || !this.osf.running) { finish(); return; }
    return this.tracker.configure({ tier: this.tier, body: this.parts.body, hands: this.parts.hands }, (s) => this.emit(`status:${s}`)).then(finish, (e) => {
      console.warn('[faceChain] the usual face model would not start again', e);
      // it keeps following (and drives the avatar again if the source had already been switched away)
      if (this.osf.running && this.trackingSource !== 'openseeface') { this.osfPrev = this.trackingSource; this.trackingSource = 'openseeface'; this.external.source = 'openseeface'; }
      this.chainNote = SENTENCE.osfRestoreFailed; toast(SENTENCE.osfRestoreFailed, 'warn', 10000); this.emit('chain');
    });
  }
  /** Multiplayer: up to 8 performers on one OBS scene (peer-to-peer, see src/party.ts). */
  readonly party: Party;
  /** 3D scenes: room / mode / camera / spots, host-owned (src/scene/controller.ts). */
  readonly scene: SceneController;
  speechDbg = { cam: 0, aud: 0, lvl: 0, fused: 0, fv: 0, sib: 0, voiced: false };
  readonly gestures = new GestureDetector();
  /** Food & drink fun layer (drink props, food mess) — off by default, see tracking/snackController.ts.
   *  Debug from the console: vtp.snacks.forceHold('right', 'coffee', 0.6), vtp.snacks.forceBite(5, 'spaghetti'). */
  readonly snacks = new SnackController();
  /** Personal expression recogniser (trained on the performer's own faces). */
  exprModel: ExprModel | null = loadExprModel();
  exprWeights = {} as Record<ExprClass, number>;
  private exprS = Object.fromEntries(EXPR_CLASSES.map((c) => [c, new AsymEma(10, 4)])) as Record<ExprClass, AsymEma>;
  /** Live feature vectors while a training capture is running. */
  private exprCapture: { cls: ExprClass; xs: Float32Array[] } | null = null;
  private exprSamples: { cls: ExprClass; x: Float32Array }[] = [];
  private reactions: { face: Record<string, number>; until: number; start: number }[] = [];
  private lastGestureId = 0;
  /** The VRMA emote playing (Body tab → Emotes, or the bus / MCP command `emote {name, loop?}` / `{stop:true}`):
   *  stamped into every frame, so OBS and party guests play it too (src/avatar/emotes.ts). */
  emote: EmoteState | null = null;
  private emoteSeq = 0;
  /** Play a built-in emote (EMOTES id) from its start; loop keeps it going until stopEmote(). */
  playEmote(name: string, loop?: boolean) {
    const info = EMOTES.find((e) => e.id === name);
    if (!info) return false;
    this.emote = { id: ++this.emoteSeq + Math.floor(Math.random() * 1e6) * 100, name, at: Date.now(), loop: loop ?? info.loop };
    return true;
  }
  stopEmote() { this.emote = null; }
  /** 2D avatars (src/avatar/flat): the expression / state held on + the last motion trigger, stamped into every frame
   *  (TrackingFrame.flat) so OBS pages and party guests show the same. Set by the 2D avatar panel, its hotkeys
   *  (src/ui/flatPanel.ts) and the bus / MCP command `flat {expression?: id | null, motion?: group, index?}`. */
  flatCue: FlatCue = {};
  private flatSeq = 0;
  setFlatExpression(id: string | null) { const c: FlatCue = { ...this.flatCue }; if (id) c.s = id; else delete c.s; this.flatCue = c; this.emit('flat'); }
  playFlatMotion(group: string, index = 0) { this.flatCue = { ...this.flatCue, m: { id: ++this.flatSeq + Math.floor(Math.random() * 1e6) * 1000, group, index } }; this.emit('flat'); }
  readonly clip = new ClipRecorder((name, body) => fetch(`/api/diag/${name}`, { method: 'POST', body }));
  profile: AvatarProfile | null = null;
  runtime: AvatarRuntime | null = null;
  frame: TrackingFrame = emptyFrame();
  bodyTargets: BodyTargets | null = null;
  lastRaw: RawTracking | null = null;
  private frameAt = 0;
  /** camera capture time (performance ms) of this.frame — the synced camera closure needs content times */
  private frameCapture = 0;
  tier: QualityTier;
  /** Software 3D (no graphics card for the browser): light preset + the notice (src/stage/gfx/softwareGl.ts). */
  readonly softGl: SoftGlState;
  trackingOn = false;
  stats: Stats = { fps: 0, inferMs: 0, tracked: false, delegate: '-', camera: '' };
  placing: { kind: PlaceKind; cb: (m: SurfaceMarker) => void } | null = null;
  focus: 'full' | 'bust' | 'head' = 'bust';
  private override: { face: Record<string, number>; until: number } | null = null;
  private listeners = new Set<(what: string) => void>();
  private last = performance.now();
  /** Rates over ~0.5 s windows → stats.fps / loopHz / avatarHz / rafHz. */
  private rate = { t: 0, ticks: 0, renders: 0, avatar: 0, raf: 0 };
  private gizmos = new THREE.Group();
  private loading = false;
  private sendAcc = 0;
  private hairTick = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.speech.style = this.learnMe.styleFor(this.speakingProfile?.face?.style);
    this.learnMe.onApply = () => { this.speech.style = this.learnMe.styleFor(this.speakingProfile?.face?.style); };
    this.tier = (localStorage.getItem('vtp.tier') as QualityTier) || detectTier();
    // the browser draws 3D on the processor (SwiftShader / llvmpipe): the light preset (src/stage/gfx/softwareGl.ts)
    this.softGl = detectSoftwareGl();
    if (this.softGl.active) this.tier = 'low';
    // (software 3D: no graphics card for a game to hold, the readbacks are processor work — no stall mode)
    this.tracker.stallOff = this.softGl.active;
    // (preserveDrawingBuffer stays on: turning it off measured no gain here, A/B at 2847×1473 ultra. Every reader of this
    //  canvas renders and reads in one task anyway: Stage.screenshot for thumbnails / commands, Stage.grab for diagnostics.)
    this.stage = new Stage(canvas, { transparent: false, tier: this.tier, controls: true });
    this.stage.scene.add(this.gizmos);
    // 2D avatars in overlay mode (src/avatar/flat/overlay.ts) show over this view, in a layer that follows the canvas
    { const host = canvas.parentElement; if (host) { const layer = document.createElement('div'); layer.className = 'vtp-flat-layer';
      layer.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden;z-index:1'; host.append(layer);
      const fit = () => { Object.assign(layer.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${canvas.clientWidth}px`, height: `${canvas.clientHeight}px` }); };
      new ResizeObserver(fit).observe(canvas); fit(); setFlatOverlayHost(layer); } }
    if (this.softGl.active) this.gate.maxFps = SOFT_PRESET.loopFps; // (+ the light preview: lightNow)
    canvas.addEventListener('pointerdown', (e) => this.onPointer(e));
    this.party = new Party(this.bus);
    this.party.tv.defaultMic = () => this.audio.device;   // talk-back to link guests = my real mic (not the Windows default)
    this.external.source = this.trackingSource === 'webcam' ? null : this.trackingSource;
    this.bus.on((m) => {
      if (m.type === 'ext' && this.trackingSource !== 'webcam') this.external.push(m.data, performance.now() / 1000);
      if (m.type === 'ext') this.faceModel.pushExt(m.data, performance.now()); // (a phone's ARKit scores as the face model's teacher, while a routine runs)
    });
    void this.faceModel.startupInit(); // (only when a model was adopted before: nothing is opened otherwise)
    this.bus.on((m) => {
      if (m.type === 'command') void this.onCommand(m.command, m.args);
      if (m.type === 'profile' && m.avatarId === this.profile?.id && !this.saving) void this.profileSaved(m.avatarId);
    });
    requestAnimationFrame((ts) => this.loop(ts));
    this.startBackgroundTicker();
    // can canvas / WebGL / audio reads be trusted here (anti-fingerprinting)? the mouth patch and lip sync adapt (src/core/readbackProbe.ts)
    void probeReadback();
    // ?observer=1 — a read-only studio (for debugging): never publishes frames or touches the camera
    if (isObserverTab()) { // (sticks to the tab: src/ui/observerMode.ts)
      this.observer = true;
      this.face.natural.persist = false; // natural mode learns in RAM only here (localStorage is the live studio's)
      this.audio.a2fBlocked = true;      // the GPU lip-sync sidecar serves one studio: never take it from the live one
      this.gpuVision.blocked = true;
      this.bus.send = () => {};
      this.diagAuto = false;
    }
    // GPU lip sync: an RTX 50-series card with the Audio2Face files installed gets ONE non-blocking question ("Turn it on?", src/ui/a2fPrompt.ts);
    // nothing starts by itself the first time, and never while OBS is live (the helper checks). Else the browser engine, as always.
    // (an owner who said yes but whose live state the helper can't tell: a small chip, and only its click starts the sidecar)
    if (!this.observer) { this.audio.a2f.onNeedsClick = () => { showA2fChip(this); }; setTimeout(() => void autoPickA2f(this.audio).then((c) => { if (c?.action === 'ask') showA2fPrompt(this); }), 4000); }
    this.scene = new SceneController(this.bus, this.party, this.observer);
    void mountB16({ role: 'studio', bus: this.bus, app: this });   // beta.16 stream extras: rules, items, throw ... (src/b16/mount.ts, one lazy loader)
    cacheKeep = () => this.cachePrefixes();
    // heartbeat: OBS output pages (separate browser) follow whichever avatar the studio shows
    setInterval(() => this.announceAvatar(), 2000);
    this.multicam.setParts(this.partsApplied);
    this.gpuVision.bodyWanted = this.partsApplied.body || this.partsApplied.hands;
    // another studio tab of this browser flipped a switch (an observer tab follows the real studio): follow it
    window.addEventListener('storage', (e) => {
      if (e.key !== null && e.key !== 'vtp.trackParts') return;
      this.partsSaved = loadTrackParts();
      this.syncParts();
    });
  }

  // ---------------- Hands / Body switches ----------------

  /** What the Hands / Body switches say now (every screen shows this one state). Until this browser has a choice, the
   *  avatar's old per-avatar setting (profile.tracking.trackHands / trackBody) shows; else on. */
  get parts(): TrackParts { return faceOnlyParts(resolveTrackParts(this.partsSaved, this.profile?.tracking), !!this.profile?.flat); } // (a 2D avatar on a phone: face only, src/mobile/cameraProfile.ts)

  /**
   * Flip a switch: Simple → Tracking, Advanced → Camera, Live → Me and Ctrl+K all call this. It works at once (the model
   * stops or starts, the part eases into its rest pose) and this browser remembers it for every avatar (an observer
   * sandbox keeps it in memory only: it shares storage with the real studio). With the camera off the choice is just
   * saved for when it comes on. Returns the new state.
   */
  setTrackPart(part: TrackPart, on: boolean | 'toggle'): TrackParts {
    const next = withPart(this.parts, part, on);
    this.partsSaved = { ...next }; // both parts: from now on the choice belongs to this browser, not to an avatar
    if (!this.observer) saveTrackParts(next);
    this.syncParts();
    return next;
  }

  /** One word per part for the Tracking card: off · on · starting (its model is loading) · idle (camera off). */
  partState(part: TrackPart): 'off' | 'on' | 'starting' | 'idle' {
    if (!this.parts[part]) return 'off';
    if (!this.trackingOn) return 'idle';
    const m = this.tracker.models();
    return (part === 'hands' ? m.hands : m.body) ? 'on' : 'starting';
  }

  /** Bring the tracker, camera 2, the GPU sidecar and the pose layers in line with the switches (only what changed). */
  private syncParts() {
    const before = this.partsApplied, next = this.parts;
    if (!sameParts(before, next)) {
      this.partsApplied = next;
      for (const p of TRACK_PARTS) if (before[p] !== next[p]) this.partFade.set(p, next[p]);
      // a part switched back on starts fresh: no hold / recovery from the pose it had before
      this.trackLoss.resetParts({ body: before.body !== next.body, hands: before.hands !== next.hands });
      this.multicam.setParts(next);
      this.gpuVision.bodyWanted = next.body || next.hands;
      void this.reconfigureTracker();
    }
    this.emit('tracking');
  }

  /** The avatar's tracking settings with the switches applied: what the retargeter reads (a part easing to rest still
   *  counts as drawn until it gets there). */
  private partTune(t: TrackingTuning, parts: TrackParts): TrackingTuning {
    const body = this.partFade.drawn('body', parts), hands = this.partFade.drawn('hands', parts);
    return t.trackBody === body && t.trackHands === hands ? t : { ...t, trackBody: body, trackHands: hands };
  }

  on(fn: (what: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what: string) { for (const l of this.listeners) l(what); }

  // ---------------- avatars ----------------

  /** When the performer last switched to another avatar in this studio (epoch ms; 0 = only the start-up avatar so far). */
  private switchedAt = 0;
  /** Tell the OBS pages which avatar this studio shows: every 2 s, and at once after a switch. The switch stamp lets a
   *  page follow the studio the performer works in when two studios publish (src/outputFollow.ts SourceLock). */
  private announceAvatar() {
    // (switchedAt always sent, 0 = no switch yet: the page tells this studio's stamped switches from a remote command load)
    if (this.profile) this.bus.send({ type: 'load', avatarId: this.profile.id, switchedAt: this.switchedAt });
  }

  /** `stamp` false: a remote command (it reaches every studio at once, so it must not move OBS to another studio). */
  /** `remember`: keep this as the avatar to start with next time (per mode: the helper's library and the browser version each keep their own pick, so a visit while the helper is down never overwrites the real choice). */
  async loadAvatar(id: string, keepCamera = false, stamp = true, remember = true) {
    if (this.loading) return;
    this.loading = true;
    try {
      const prev = this.profile?.id;
      const p = normalizeProfile(await api.avatar(id));
      if (prev !== p.id) this.flatCue = {};   // (a 2D avatar's held expression belongs to that avatar)
      await this.build(p);
      // a switch to another avatar (not the start-up load, not a reload of this one): OBS hears it now, not on the heartbeat
      if (prev && this.profile?.id === p.id && p.id !== prev) { if (stamp) this.switchedAt = Date.now(); this.announceAvatar(); }
      if (remember) localStorage.setItem(LAST_KEY, id);
      if (!keepCamera) this.frameCamera();
      if (!p.thumbnail) setTimeout(() => void this.captureThumbnail(), 900);
    } catch (e) {
      console.error(e);
      toast(`Couldn't load avatar: ${(e as Error).message}`, 'err');
      this.emit('avatar-failed'); // the loading screen opens the studio instead of waiting forever (src/ui/splash.ts)
    } finally { this.loading = false; }
  }

  /** Another page (or the helper) saved the avatar on show: a save that only touched thumbnails / model stats is taken in
   *  place (shared/profileBuild.ts); anything else reloads it, as before. */
  private async profileSaved(id: string) {
    const next = await api.avatar(id).then(normalizeProfile).catch(() => null);
    const shown = this.profile;
    if (next && shown && shown.id === id && !this.loading && sameAvatarBuild(shown, next)) { adoptBuildFree(shown, next); return; }
    if (this.profile?.id === id && !this.saving) await this.loadAvatar(id, true, true, false);   // (a reload of what is on screen is not a pick: a starter shown because the pick is missing must not become the pick)
  }

  /** (Re)build the runtime from a profile — used after any face/rig/physics edit. */
  private buildSeq = 0;
  /** THREE.Cache pins: the avatar being built, the one on screen (its costumes live in the same library folder), the one
   *  before it (switching back stays instant) and the current room's files (read when the cache needs to drop something). */
  private buildingId = '';
  private prevAvatarId = '';
  private cachePrefixes(): string[] {
    const out: string[] = [];
    for (const id of [this.buildingId, this.profile?.id, this.prevAvatarId]) if (id) out.push(`/library/${encodeURIComponent(id)}/`);
    const room = this.scene?.state.sceneId;
    if (room) out.push(`/api/scenes/${encodeURIComponent(room)}/`);
    return out;
  }
  async build(p: AvatarProfile) {
    const seq = ++this.buildSeq;
    this.buildingId = p.id;
    // Avatar detail (docs/PERFORMANCE.md): this PC's choice (Room -> Advanced -> Graphics quality); levels prepare in the background
    const rt = await AvatarRuntime.load(p, api.modelUrl(p), this.stage.anchor, (s) => this.emit(`status:${s}`), { detail: avatarDetailOf(this.scene.gfx.avatarDetail) });
    // a newer build started while this one loaded (e.g. rapid costume switching) → drop this one
    if (seq !== this.buildSeq) { rt.dispose(); return; }
    const old = this.runtime;
    if (old && old.profile.id !== rt.profile.id) this.prevAvatarId = old.profile.id;
    if (old) runAvatarBeforeDispose(old);   // beta.16: items hanging under the old model are taken off before its dispose walks them
    old?.dispose();
    this.runtime = rt;
    runAvatarLoaded(rt);   // beta.16 hooks (src/avatar/b16Hooks.ts)
    this.profile = rt.profile;
    // (no Hands / Body choice in this browser yet: this avatar's old per-avatar setting applies)
    if (!sameParts(this.partsApplied, this.parts)) this.syncParts();
    void this.party.setAvatar(rt.profile);
    this.scene.occupantChanged();   // (room forms: a human -> mech swap turns the desk into a docking cradle)
    // no face rig at all (typical upload / generation): place eyes + mouth automatically
    if (this.autoFace(rt)) return;
    for (const w of rt.info.warnings) toast(w, 'warn', 6000);
    this.drawGizmos();
    this.emit('avatar');
  }

  /** Model has no eye shapes / no mouth shapes or jaw → guess procedural eye + mouth markers once. */
  private autoFace(rt: AvatarRuntime): boolean {
    if (rt.flat) return false;   // (2D avatars: the picture is the face)
    const p = rt.profile;
    const { eyes: needEyes, mouth: needMouth } = autoFaceNeeds(p, { blink: rt.expressions.hasBlink || !!rt.vrm?.lookAt, mouth: !!rt.jawRig || rt.expressions.hasArkit || rt.expressions.hasVisemes });
    if (!needEyes && !needMouth) return false;
    const g = guessFaceMarkers(rt.model, collectMeshes(rt.model), rt.humanoid?.getRawBoneNode('head') ?? null, p.transform.yaw);
    // only when a NEEDED part landed: an edit that places nothing still saves + rebuilds, and comes back here forever
    const put = autoFacePlace({ eyes: needEyes, mouth: needMouth }, g);
    if (!g || !put) return false;
    this.edit((q) => {
      if (put.eyes && g.eyes) Object.assign(q.eyes, { mode: 'procedural', style: g.mascot ? 'bulb' : 'inset', left: g.eyes.left, right: g.eyes.right, size: g.eyes.size, protrusion: g.mascot ? 0.5 : 0.25 });
      if (put.mouth && g.mouth) Object.assign(q.mouth, { mode: 'procedural', style: 'cavity', center: g.mouth.center, width: g.mouth.width, openHeight: g.mouth.openHeight, influence: g.mouth.influence });
    });
    toast(`No face rig found — placed ${put.eyes && put.mouth ? 'eyes & mouth' : put.eyes ? 'eyes' : 'a mouth'} automatically. Fine-tune ${put.eyes ? 'them' : 'it'} in the Face tab.`, 'info', 7000);
    return true;
  }

  rebuild = debounce(() => { if (this.profile) void this.build(this.profile).catch((e) => toast(String(e), 'err')); }, 350);

  private saving = false;
  save = debounce(async () => {
    if (!this.profile) return;
    this.saving = true;
    try { if (!this.observer) await api.save(this.profile); } catch (e) { toast(`Save failed: ${(e as Error).message}`, 'err'); }
    setTimeout(() => (this.saving = false), 500);
  }, 600);

  /** Edit the profile: rebuild=true for structural changes (markers, sizes), false for live-only. */
  edit(fn: (p: AvatarProfile) => void, rebuild = true) {
    if (!this.profile) return;
    fn(this.profile);
    this.save();
    if (rebuild) this.rebuild();
    this.drawGizmos();
  }

  // ---------------- wardrobe ----------------

  /** Wear a costume (null = none): saves the profile (OBS follows via the 'profile' broadcast) and rebuilds. */
  async setCostume(id: string | null) {
    const p = this.profile;
    if (!p) return;
    if (id !== null && !p.costumes.some((c) => c.id === id)) { toast(`No costume '${id}'`, 'warn'); return; }
    if ((p.costume ?? null) === id && this.runtime?.costume?.def.id === (id ?? undefined)) return;
    p.costume = id;
    this.saving = true; // our own save's broadcast must not trigger a second reload here
    const saved = (this.observer ? Promise.resolve() : api.save(p)).catch((e) => toast(`Save failed: ${(e as Error).message}`, 'err'));
    try { await this.build(p); } catch (e) { toast(String(e), 'err'); }
    await saved;
    setTimeout(() => (this.saving = false), 500);
    const name = p.costumes.find((c) => c.id === id)?.name;
    this.emit(`status:${name ? `Wearing ${name}` : 'No costume'}`);
    this.emit('costume');
  }

  /** Toggle an accessory (kind 'accessory' costume) on top of the outfit: saves + rebuilds like setCostume. */
  async setAccessory(id: string, on: boolean) {
    const p = this.profile;
    if (!p || !p.costumes.some((c) => c.id === id)) return;
    const cur = new Set(p.accessories ?? []);
    if (on === cur.has(id)) return;
    if (on) cur.add(id); else cur.delete(id);
    p.accessories = [...cur];
    this.saving = true;
    const saved = (this.observer ? Promise.resolve() : api.save(p)).catch((e) => toast(`Save failed: ${(e as Error).message}`, 'err'));
    try { await this.build(p); } catch (e) { toast(String(e), 'err'); }
    await saved;
    setTimeout(() => (this.saving = false), 500);
    this.emit('costume');
  }

  /** Live label edit on the worn costume (no rebuild) + persist into the profile. */
  setCostumeLabel(costumeId: string, material: string, text: string) {
    const def = this.profile?.costumes.find((c) => c.id === costumeId);
    const label = def?.labels?.find((l) => l.material === material);
    if (!def || !label) return;
    label.text = text;
    if (this.runtime?.costume?.def.id === costumeId) this.runtime.costume.setLabelText(material, text);
    this.save();
    // party members see the new text too, once typing pauses (the shared profile carries the labels; no bytes resent)
    clearTimeout(this.labelPartyT);
    this.labelPartyT = window.setTimeout(() => { if (this.profile) void this.party.setAvatar(this.profile); }, 1500);
  }
  private labelPartyT = 0;

  /** Re-fetch the current avatar from the server (after a server-side change), waiting out any load in flight. */
  async reloadProfile() {
    while (this.loading) await new Promise((r) => setTimeout(r, 50));
    if (this.profile) await this.loadAvatar(this.profile.id, true, true, false);   // (same: a reload, not a pick)
  }

  frameCamera() {
    if (!this.runtime) return;
    const card = this.stage.frame(this.runtime.bounds(), this.focus, this.runtime.faceInfo(), this.runtime.cardBox());
    if (this.runtime.flat) this.runtime.flat.cutHidden = card;
  }

  async captureThumbnail() {
    if (!this.profile) return;
    const prev = this.stage.background;
    this.stage.setTransparent(true);
    // the library thumbnail always shows the full model (Avatar detail pinned to Full for the shot)
    const det = this.runtime?.detail ?? null;
    det?.pin('thumb', true);
    let blob: Blob;
    try { blob = await this.stage.screenshot(); } finally { det?.pin('thumb', false); }
    this.stage.background = prev; this.stage.setTransparent(prev === null);
    try {
      await api.thumbnail(this.profile.id, blob);
      this.profile.thumbnail = 'thumb.png';
      this.emit('library');
    } catch { /* builtin or offline */ }
  }

  // ---------------- tracking ----------------

  private trackingOperation = 0;

  /** `resumed`: turned back on by itself at page load (resume()), so the toast says why the camera light came on. */
  async startTracking(cam: CameraRequest, resumed = false) {
    if (this.observer) return;
    const operation = ++this.trackingOperation;
    let trackerStage = false;
    try {
      this.emit('status:Opening camera…');
      // Browsers hide device names until camera permission is granted once. Unlock them, then
      // honour the preferred camera (Elgato Facecam) if the user hasn't explicitly chosen one.
      // autopilot: no camera picked yet → the best real one (never "OBS Virtual Camera"), said in one sentence
      // (a phone: never — it asks for the front camera itself, src/mobile/cameraProfile.ts; an automatic pick could open the back one)
      if (!localStorage.getItem('vtp.camChosen') && !isPhone()) cam = { ...cam, deviceId: (await autoPickCamera(PREFERRED_CAMERA)) ?? cam.deviceId };
      if (operation !== this.trackingOperation) return;
      const info = await this.video.openCamera(cam);
      if (operation !== this.trackingOperation) return;
      this.stats.camera = `${info.label} · ${info.width}×${info.height}@${Math.round(info.fps)}`;
      this.face.metric.setCamera(info.label); // FOV for metric depth
      this.mainCam = { label: info.label, w: info.width, h: info.height, deviceId: this.video.track?.getSettings().deviceId ?? cam.deviceId ?? '' };
      // the Hands / Body switches: a part that is off never loads its model
      trackerStage = true;
      this.chainInitError = undefined; this.faceChain.reset(); this.chainAsked = false;
      await this.tracker.init({ tier: this.tier, body: this.parts.body, hands: this.parts.hands }, (s) => { if (operation === this.trackingOperation) this.emit(`status:${s}`); });
      if (operation !== this.trackingOperation) return;
      this.stats.delegate = this.tracker.delegate;
      this.trackingOn = true;
      this.startShots();
      localStorage.setItem('vtp.tracking', JSON.stringify(cam));
      this.emit('tracking');
      if (this.trackingSource === 'openseeface') void this.startOpenSeeFace('The light face tracker follows your face now.');   // (picked by hand, kept from last time)
      // clarity (owner: people thought VTube Pro was taking their camera feed): say who sees the camera, right when it starts
      if (resumed) toast('Your camera is back on because it was on last time. Viewers see your avatar, not your camera picture. Turn it off in Tracking.', 'info', 9000);
      else toast('Camera on: your avatar copies you. Viewers see your avatar, not your camera picture. Relax your face for a moment so it can calibrate.', 'ok', 6000);
      // the second camera comes back with the main one (when it was left on)
      if (this.multicam.settings.on && this.multicam.settings.deviceId && !this.observer) void this.startCamera2();
    } catch (e) {
      if (operation !== this.trackingOperation) return;
      // the camera is open but no MediaPipe path would start (fallback chain, last step): the light face tracker, if it is installed
      if (trackerStage && await this.osfAfterInitFailure(e, cam, operation)) return;
      this.stopMainTracking();
      if (this.observer || !mediaFailed('camera', e)) toast(`The camera didn’t start: ${(e as Error).message}`, 'err', 12000); // autopilot: what happened + one-click fix
      this.emit('status:');
    }
  }

  /** The tracker would not start although the camera did: ask the chain; true = OpenSeeFace took over (tracking is on). */
  private async osfAfterInitFailure(e: unknown, cam: CameraRequest, operation: number): Promise<boolean> {
    if (this.observer || !this.video.ready) return false;
    this.chainInitError = String((e as Error)?.message ?? e);
    const v = await this.osf.refresh();
    if (operation !== this.trackingOperation) return false;
    const a = this.faceChain.step({ now: performance.now(), trackingOn: true, camFps: 0, faceDelegate: '', faceHz: 0, faceInFlightMs: 0, initError: this.chainInitError, policy: this.tracker.delegatePolicy,
      osf: { installed: v ? v.installed : null, running: false, hz: 0 } });
    if (a?.kind === 'offer-openseeface') { this.chainNote = a.text; toast(a.text, 'warn', 15000); this.emit('chain'); return false; }
    if (a?.kind !== 'use-openseeface') return false;
    this.trackingOn = true;
    if (!(await this.startOpenSeeFace(a.text, false))) { this.trackingOn = false; return false; }
    this.stats.delegate = 'OpenSeeFace (CPU)';
    this.startShots();
    localStorage.setItem('vtp.tracking', JSON.stringify(cam));
    this.emit('tracking');
    return true;
  }

  /** Resume the camera (and mic) after a page reload — e.g. while an AI assistant edits the code live. */
  observer = false;
  async resume() {
    if (this.observer) return;
    const saved = localStorage.getItem('vtp.tracking');
    if (saved && !this.trackingOn) await this.startTracking(JSON.parse(saved) as CameraRequest, true);
    if (localStorage.getItem('vtp.micOn') === '1' && !this.audio.active) {
      try { await this.audio.start(localStorage.getItem('vtp.micChosen') ? localStorage.getItem('vtp.mic') ?? undefined : undefined); } catch { /* ignore */ }
    }
  }

  async startVideoFile(file: File) {
    const operation = ++this.trackingOperation;
    try {
      await this.video.openFile(file);
      if (operation !== this.trackingOperation) return;
      await this.tracker.init({ tier: this.tier, body: this.parts.body, hands: this.parts.hands }, (s) => { if (operation === this.trackingOperation) this.emit(`status:${s}`); });
      if (operation !== this.trackingOperation) return;
    } catch (e) {
      if (operation !== this.trackingOperation) return;
      this.stopMainTracking();
      throw e;
    }
    this.stats.camera = `file: ${file.name}`;
    this.stats.delegate = this.tracker.delegate;
    this.trackingOn = true;
    this.startShots();
    this.emit('tracking');
  }

  /** Open camera 2 (the multicam settings' device) next to the running main camera. */
  async startCamera2(deviceId?: string) {
    const m = this.mainCam;
    if (!m) { toast('Turn the main camera on first', 'warn'); return false; }
    const ok = await this.multicam.start(this.tier, { ...m, w: this.video.video.videoWidth || m.w, h: this.video.video.videoHeight || m.h }, deviceId);
    if (!ok && this.multicam.state === 'error' && this.multicam.error) toast(this.multicam.error, 'err', 7000);
    this.emit('multicam');
    return ok;
  }
  stopCamera2() { this.multicam.stop(); this.emit('multicam'); }

  /** A failed main-source attempt leaves camera 2 and the saved resume choice intact. */
  private stopMainTracking() {
    if (this.osf.running || this.osfPrev !== null) this.endOpenSeeFace(false);
    this.osf.stop();
    this.faceChain.reset(); this.chainInitError = undefined; this.chainAsked = false;
    this.video.stop();
    this.trackingOn = false;
    // (no camera, no face to starve: stall mode ends now — the preview, the room analysis and full drawing come back)
    this.tracker.endStall();
    this.shots.stop();
    // the arms / hands ease to their rest pose instead of freezing in the last tracked gesture
    this.bodyTargets = null;
    this.emit('tracking');
  }

  stopTracking() {
    this.trackingOperation++;
    this.multicam.stop();
    localStorage.removeItem('vtp.tracking');
    this.stopMainTracking();
    // "Keep learning me": the session is over — save it and learn (in a worker, with the camera off)
    try { this.learnMe.onTrackingStopped(this.speakingProfile?.face?.style ?? DEFAULT_STYLE, this.tune.enunciation ?? 1.3); } catch { /* optional feature */ }
  }

  async reconfigureTracker() {
    const p = this.parts;
    // (while OpenSeeFace drives the face the usual face model stays stopped: a Hands / Body / tier change must not start it again)
    if (this.tracker.face) {
      try { await this.tracker.configure({ tier: this.tier, body: p.body, hands: p.hands, face: this.osf.running ? false : undefined }, (s) => this.emit(`status:${s}`)); }
      catch (e) { console.warn('[tracker] reconfigure failed; the body / hands change is kept', e); }
    }
    this.emit('status:');
  }

  setTier(t: QualityTier) {
    this.tier = t;
    localStorage.setItem('vtp.tier', t);
    this.stage.applyTier(t);
    void this.reconfigureTracker();
  }

  get tune() {
    return this.profile?.tracking ?? normalizeProfile({ id: '_', modelFile: '' }).tracking;
  }

  preview(name: string, seconds = 2.2) {
    // (the deck's Happy / Wow / Angry keys send happy / surprised / angry: shared/showDock.ts resolveExpression maps them,
    // an unknown name still shows the neutral face as before)
    const k = resolveExpression(name, Object.keys(TEST_EXPRESSIONS)) ?? name;
    this.override = { face: TEST_EXPRESSIONS[k] ?? {}, until: performance.now() / 1000 + seconds };
  }

  // ---------------- placement ----------------

  place(kind: PlaceKind, cb: (m: SurfaceMarker) => void) {
    this.placing = { kind, cb };
    this.runtime?.setResting(true);
    this.stage.canvas.classList.add('placing');
    this.emit('placing');
  }

  cancelPlace() {
    this.placing = null;
    this.runtime?.setResting(false);
    this.stage.canvas.classList.remove('placing');
    this.emit('placing');
  }

  private onPointer(e: PointerEvent) {
    if (!this.placing || !this.runtime || e.button !== 0) return;
    const r = this.stage.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const hit = this.runtime.pick(ndc, this.stage.camera);
    if (!hit) { toast('Click on the model surface', 'warn'); return; }
    e.stopPropagation();
    const p = this.placing;
    this.cancelPlace();
    p.cb(hit);
  }

  /** Mirror a model-space marker across the model's centre plane (x = centre). */
  mirrorMarker(m: SurfaceMarker): SurfaceMarker {
    const cx = this.modelCenterX();
    return { position: [2 * cx - m.position[0], m.position[1], m.position[2]], normal: [-m.normal[0], m.normal[1], m.normal[2]] };
  }

  modelCenterX() {
    if (!this.runtime) return 0;
    const box = this.runtime.bounds();
    const c = box.getCenter(new THREE.Vector3());
    return this.runtime.model.worldToLocal(c).x;
  }

  /** Approximate model-space half-width of the surface around a marker's height (for auto sizing). */
  localHalfWidth(m: SurfaceMarker): number {
    const rt = this.runtime;
    if (!rt) return 0.1;
    const y = m.position[1];
    let lo = Infinity, hi = -Infinity;
    const v = new THREE.Vector3();
    const inv = rt.model.matrixWorld.clone().invert();
    rt.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.vtpGenerated || mesh.userData.vtpOutline) return;
      const pos = mesh.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / 30000));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
        if (Math.abs(v.y - y) > 0.02 * (rt.bounds().max.y - rt.bounds().min.y)) continue;
        lo = Math.min(lo, v.x); hi = Math.max(hi, v.x);
      }
    });
    return Number.isFinite(lo) ? (hi - lo) / 2 : 0.1;
  }

  drawGizmos() {
    this.gizmos.clear();
    const p = this.profile, rt = this.runtime;
    if (!p || !rt || !this.showGizmos) return;
    const add = (m: SurfaceMarker | null, color: number, label: string) => {
      if (!m) return;
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.008 * (rt.bounds().max.y - rt.bounds().min.y), 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      s.renderOrder = 10; s.name = label;
      s.position.copy(rt.toWorld(m.position));
      this.gizmos.add(s);
    };
    add(p.eyes.left, 0x4cc9f0, 'eyeL'); add(p.eyes.right, 0xf72585, 'eyeR'); add(p.mouth.center, 0xffd166, 'mouth');
    for (const j of p.physics.jiggle) add({ position: j.center, normal: [0, 0, 1] }, 0x80ed99, j.name);
  }
  showGizmos = false;

  // ---------------- remote commands (MCP / AI) ----------------

  private async onCommand(cmd: string, args: unknown) {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'load': if (typeof a.avatarId === 'string') await this.loadAvatar(a.avatarId, false, false); break;
      case 'expression': if (typeof a.name === 'string') this.preview(a.name, Number(a.seconds) || 2.5);
        else if (a.face) this.override = { face: a.face as Record<string, number>, until: performance.now() / 1000 + (Number(a.seconds) || 2.5) }; break;
      case 'focus': if (a.focus === 'full' || a.focus === 'bust' || a.focus === 'head') { this.focus = a.focus; this.frameCamera(); } break;
      case 'screenshot': {
        const blob = await this.stage.screenshot();
        if (this.profile) await fetch(`/api/avatars/${this.profile.id}/snapshot`, { method: 'POST', body: blob }).catch(() => {});
        break;
      }
      case 'rebuild': this.rebuild(); break;
      case 'phone-hotkey': void import('./tracking/phoneHotkeys.ts').then((m) => m.runPhoneHotkey(this, Number(a.n))); break; // VTube Studio phone buttons 1-8 (shared/phoneHotkeys.ts)
      case 'diag': await this.sendDiagnostics(); break;
      case 'gesture': this.gestures.inject((a.kind as GestureKind) ?? 'thumbs_up', a.side === 'left' ? 'left' : 'right'); break;
      case 'recordClip': await this.recordClip(); break;
      case 'costume': await this.setCostume(typeof a.id === 'string' ? a.id : null); break;
      case 'accessory': if (typeof a.id === 'string') await this.setAccessory(a.id, a.on !== false); break;
      case 'scene': this.scene.command(a); break;
      case 'slap': slapCommand(this.scene, a); break;
      case 'yacht': yachtCommand(this.scene, a); break;
      case 'voyage': voyageCommand(this.scene, a); break;
      case 'flat': if ('expression' in a) this.setFlatExpression(typeof a.expression === 'string' ? a.expression.slice(0, 64) : null);
        if (typeof a.motion === 'string') this.playFlatMotion(a.motion.slice(0, 64), Math.max(0, Math.min(255, Math.floor(Number(a.index) || 0))));
        if (typeof a.param === 'string' || typeof a.toggle === 'string') rig2dSliderCommand(this, a); break; // Pro2D model sliders / outfits (deck, MCP): src/ui/rig2dSliders.ts
      case 'emote': if (a.stop) this.stopEmote(); else if (typeof a.name === 'string') this.playEmote(a.name, typeof a.loop === 'boolean' ? a.loop : undefined); break;
      // OBS recording reminder (Set up OBS → Automation, off by default; server/obs.ts remind): one line, never a sound
      case 'obs-reminder': if (typeof a.text === 'string' && a.text.length <= 200) toast(a.text, 'info', 8000); break;
      // an AI waits for the user's OK on the helper's approval page (server/index.ts): a card until they decide
      case 'ai-approvals': showAiWaiting(Number(a.waiting) || 0, Array.isArray(a.items) ? (a.items as AiWaitingItem[]).slice(0, 5) : []); break;
    }
  }

  /** Guided expression test clip (camera + mic + per-frame tracking data) for offline tuning. */
  async recordClip() {
    if (!this.trackingOn) { toast('Start tracking first', 'warn'); return; }
    if (this.clip.active) return;
    toast('Recording a ~80 s expression test clip — follow the prompts', 'info', 5000);
    const meta = await this.clip.record(this.video.video.srcObject as MediaStream | null, this.audio.stream,
      (step, remaining, i) => this.emit(step ? `prompt:${i + 1}/${CLIP_SCRIPT.length}|${step.say}|${remaining.toFixed(1)}` : 'prompt:'));
    toast(`Test clip saved on this computer (${meta.frameCount} frames). It isn’t uploaded.`, 'ok', 6000);
  }

  /**
   * ONE guided test (~45 s) that personalises everything at once: neutral calibration, your expressions
   * (trains the recogniser), how you talk, and — with the mic on — your vowels. It's stored per PERSON,
   * not per avatar, so every avatar (built-in, generated or uploaded) is ready after a single run.
   */
  setupRunning = false;
  /** voice-activity envelope for natural mode (see tick) */
  private speakEnv = 0;
  /** Seconds the tracked face has had its mouth hidden (mic / hand in front) with no voice lip sync running. */
  private mouthHiddenFor = 0;
  private mouthHintShown = false;
  /** One tip per session: the camera can't see the mouth (something in front of it) and the mic isn't driving it. */
  private mouthHint(dt: number) {
    if (this.mouthHintShown || this.observer) return;
    const hidden = this.frame.tracked && (this.frame.face._mouthVis ?? 1) < 0.35;
    this.mouthHiddenFor = hidden && !this.audio.active ? this.mouthHiddenFor + dt : Math.max(0, this.mouthHiddenFor - dt * 0.5);
    if (this.mouthHiddenFor < 12) return;
    this.mouthHintShown = true;
    toast('Your mouth seems hidden from the camera (a mic or a hand in front of it?). Turn on Tracking → Voice lip-sync → Use microphone, and your voice moves your avatar’s mouth.', 'info', 14000);
  }
  async runSetupTest() {
    if (!this.trackingOn) { toast('Start tracking first', 'warn'); return; }
    if (this.setupRunning || this.clip.active) return;
    this.setupRunning = true;
    type Step = { say: string; secs: number; run: () => Promise<unknown> };
    const face = (cls: ExprClass, say: string, secs = 2): Step => ({ say, secs: secs + 0.45, run: () => this.captureExpression(cls, secs) });
    this.styleRec = this.audio.active ? { on: false, aud: [], cam: [] } : null;
    const vowel = (v: 'A' | 'I' | 'U' | 'E' | 'O', say: string): Step => ({ say, secs: 1.6, run: () => this.audio.calibrateVowel(v) });
    const steps: Step[] = [
      { say: 'Relax your face and look at the camera', secs: 2.5, run: () => this.face.calibrate(2.5) },
      face('neutral', 'Stay relaxed…'),
      face('happy', 'Smile (mouth closed) 🙂'),
      face('grin', 'BIG open grin 😁'),
      face('sad', 'Sad face 😢'),
      face('angry', 'Angry face 😠'),
      face('surprised', 'Surprised! 😲'),
      face('kiss', 'Kiss / pucker 😗'),
      face('puff', 'Puff your cheeks 🐡'),
      face('smirk', 'Smirk — one side only 😏'),
      face('talk', 'Talk normally: “The quick brown fox jumps over the lazy dog”', 3.5),
    ];
    if (this.audio.active) steps.push(vowel('A', 'Hold “AAAH”'), vowel('I', 'Hold “EEEE”'), vowel('U', 'Hold “OOOO”'), vowel('E', 'Hold “EHHH”'), vowel('O', 'Hold “OHHH”'));
    // held consonants → personal viseme profile (FF / L / SH / S / TH / R / W / M read right on every avatar)
    const cons = (v: Viseme, say: string): Step => ({ say, secs: 1.6, run: () => this.audio.calibrateViseme(v) });
    if (this.audio.active) steps.push(cons('FF', 'Hold “fffff” (top teeth on your lower lip)'), cons('FF', 'Hold “vvvvv”'), cons('L', 'Hold “lllll” (tongue up behind your teeth)'),
      cons('CH', 'Hold “shhhhh”'), cons('SS', 'Hold “sssss”'), cons('TH', 'Hold “thhhh” (tongue between your teeth)'), cons('RR', 'Hold “rrrrr”'),
      cons('W', 'Say “www-www-www”'), cons('PP', 'Hum “mmmmm” (lips closed)'));
    const failed: string[] = [];
    try {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        const t0 = performance.now();
        const tick = setInterval(() => this.emit(`prompt:${i + 1}/${steps.length}|${st.say}|${Math.max(0, st.secs - (performance.now() - t0) / 1000).toFixed(1)}`), 100);
        const nvStep = nvStepFor(st.say);
        if (nvStep) this.audio.neuralRecord(nvStep);
        // speaking profile: held vowels + the talk sentence (voice and camera together)
        if (this.styleRec) this.styleRec.on = !!nvStep && (nvStep.kind === 'script' || ['AA', 'IY', 'UW', 'EH', 'OW'].includes(nvStep.phone));
        try { await st.run(); } catch { failed.push(st.say); }
        if (this.styleRec) this.styleRec.on = false;
        if (nvStep) this.audio.neuralRecord(null);
        clearInterval(tick);
      }
      this.emit('prompt:');
      const n = this.trainExpressions();
      if (this.audio.active) this.audio.finishVisemeCalibration();
      if (this.audio.active) await this.audio.finishNeuralPersonal().catch(() => 0);
      const style = this.finishSpeakingProfile();
      if (!style.ok) toast(`Mouth style not learned: ${style.reason}`, 'warn', 9000);
      toast(failed.length ? `Setup done (${n} expressions) — skipped ${failed.length} step(s) with no face/voice seen` : `Setup done ✔ ${n} expressions${this.audio.active ? ' + your voice' : ''} learned — every avatar uses it`, failed.length ? 'warn' : 'ok', 6000);
      this.emit('setup');
    } finally {
      this.emit('prompt:');
      this.setupRunning = false;
    }
  }

  /** Fit + store the face part of "My speaking profile" from the setup's voice + camera pairs. */
  /** Why the last setup test did / didn't learn the mouth style (the speaking-profile card shows it). */
  speakingStyleNote: { ok: boolean; reason: string; at: string } | null = null;
  private finishSpeakingProfile(): { ok: boolean; reason: string } {
    const r = this.styleRec;
    this.styleRec = null;
    const done = (ok: boolean, reason: string) => { this.speakingStyleNote = { ok, reason, at: new Date().toISOString() }; if (!ok) console.warn('[speaking profile]', reason); return { ok, reason }; };
    if (!r) return done(false, 'the microphone was off during the test — turn it on (Tracking) and run the test again.');
    if (r.aud.length < 30) return done(false, 'heard no voice while you talked — is the mic on?');
    if (r.cam.length < 30) return done(false, 'the camera did not see your face while you talked — is tracking on and your face in view?');
    // voice and camera samples by content time. The voice stamps are NOT monotonic (the lip-sync lookahead picks
    // frames from its queue, so their age jitters by a frame or two) — a forward-only nearest-neighbour walk stalled on
    // the first step backwards and matched nothing (2026-09-26: "Mouth style" never learned with the lookahead on).
    // Sort once, then binary-search the nearest voice sample for every camera frame.
    const aud = [...r.aud].sort((x, y) => x.t - y.t);
    const samples: StyleSample[] = [];
    for (const c of r.cam) {
      let lo = 0, hi = aud.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (aud[m].t <= c.t) lo = m; else hi = m; }
      const a = Math.abs(aud[lo].t - c.t) <= Math.abs(aud[hi].t - c.t) ? aud[lo] : aud[hi];
      if (Math.abs(a.t - c.t) < 0.05) samples.push({ level: a.level, w: a.w, cam: { open: c.open, wide: c.wide, round: c.round, pucker: c.pucker } });
    }
    const loud = samples.filter((s) => s.level > 0.12).length;
    if (samples.length < 30) return done(false, `could not line up your voice with the camera (${samples.length} matching moments) — try again.`);
    const fit = fitStyle(samples, this.tune.enunciation ?? 1.3);
    if (!fit) return done(false, loud < 30 ? `heard too little voice while you talked (${loud} loud moments) — is the mic on and not muted?` : 'the fit failed — try again.');
    const ns = this.audio.neuralStatus;
    this.applySpeakingProfile({ v: 1, at: new Date().toISOString(), face: { style: fit.style, samples: samples.length, vowelsSeen: fit.vowelsSeen, fitErr: fit.fitErr },
      voice: { vowels: true, consonants: true, neural: !!ns.personal } });
    return done(true, `learned from ${samples.length} moments (${loud} with your voice)`);
  }

  // ---------------- expression training ----------------

  /** Current expression feature vector (null when no face) — used by clip-based training tools. */
  currentExprFeatures() {
    if (!this.frame.tracked || !this.lastRaw?.face) return null;
    return exprFeatures({ raw: this.face.raw, rest: this.face.restFor(), lips: this.face.lipsRaw });
  }

  /** Record ~2 s of one expression class into the personal training set. */
  async captureExpression(cls: ExprClass, seconds = 2) {
    await new Promise((r) => setTimeout(r, 450)); // give the performer a beat to settle into it
    this.exprCapture = { cls, xs: [] };
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const cap = this.exprCapture;
    this.exprCapture = null;
    if (!cap || cap.xs.length < 10) throw new Error('No face seen — is tracking on?');
    this.exprSamples = this.exprSamples.filter((s) => s.cls !== cls).concat(cap.xs.map((x) => ({ cls, x })));
    return cap.xs.length;
  }

  /** Train from the captured samples (merging in the default model's classes you didn't record). */
  trainExpressions() {
    const have = new Set(this.exprSamples.map((s) => s.cls));
    const m = trainExprModel(this.exprSamples, 'live training ' + new Date().toISOString());
    const base = DEFAULT_EXPR_MODEL as unknown as ExprModel;
    for (const c of base.classes) if (!have.has(c.name)) m.classes.push(c);
    this.exprModel = m;
    try { localStorage.setItem('vtp.exprModel', JSON.stringify(m)); } catch { /* ignore */ }
    return m.classes.length;
  }

  resetExpressions() {
    this.exprSamples = [];
    this.exprModel = DEFAULT_EXPR_MODEL as unknown as ExprModel;
    try { localStorage.removeItem('vtp.exprModel'); } catch { /* ignore */ }
  }

  // ---------------- diagnostics (lets an AI supervisor see camera + avatar + numbers) ----------------

  /** Auto-upload diagnostics every few seconds while tracking (local server only). */
  diagAuto = localStorage.getItem('vtp.diagAuto') !== '0';
  private diagT = 0;
  private diagBusy = false;
  /** An automatic cycle is due: it runs right after the next preview render (or at once when the preview isn't drawn). */
  private diagDue = false;
  /** A 'diag' command (full-resolution stage.png) came in while a cycle was running: it runs as soon as that one ends. */
  private diagFullWanted = false;
  /** The last diagnostics cycle: main-thread ms spent capturing, total ms, image bytes uploaded, stage picture kind,
   *  `extra`: the preview wasn't being drawn (studio view hidden, window covered, renderHold), so one frame was rendered
   *  for the picture. */
  diag: { syncMs: number; ms: number; bytes: number; stage: 'jpg' | 'png' | 'skipped' | 'none'; extra?: boolean } | null = null;
  /** JPEG encoder worker for the diagnostics pictures (started with the camera, see Stage.ts ShotEncoder). */
  readonly shots = new ShotEncoder();
  private startShots() {
    if (!this.diagAuto || this.observer) return;
    this.shots.start();
    // warm the whole capture path now (GPU scaling of the canvas / camera frame + the worker's JPEG encoder: a one-time
    // 50-95 ms frame hitch measured on the first use), not at the first 3-second cycle. These pictures are thrown away.
    const warm = (b: Promise<ImageBitmap> | null) => { void b?.then((x) => this.shots.encode(x), () => null); };
    warm(this.stage.grab(16));
    if (this.video.ready) try { warm(createImageBitmap(this.video.video, { resizeWidth: 16, resizeHeight: 9 })); } catch { /* not ready yet */ }
  }

  /** GPU tracking sidecars, per source: is it on, connected, how many results per second, how fresh, how much weight. */
  gpuStatus() {
    const a = this.audio.a2fStatus;
    return {
      a2f: { on: a.on, ready: a.ready, fps: a.fps, lagMs: a.lagMs, used: a.used, weight: a.weight, netMs: +a.netMs.toFixed(1), futureMs: a.futureMs, error: a.error || undefined, micOn: this.audio.active },
      ...this.gpuVision.summary(),
    };
  }
  /** One line for the studio's status bar ('' when nothing is on). */
  gpuLine(): { text: string; state: 'ok' | 'warn' | 'err' | '' } {
    const g = this.gpuStatus();
    const parts: string[] = []; let bad = 0, on = 0;
    const one = (name: string, x: { on: boolean; ready: boolean; used: boolean; fps: number }, needs: boolean) => {
      if (!x.on) return;
      on++;
      const ok = x.ready && x.used && x.fps > 5;
      if (!ok && needs) bad++;
      parts.push(`${name} ${ok ? `✓${Math.round(x.fps)}` : !x.ready ? '✗' : needs ? 'idle' : '…'}`);
    };
    one('A2F', g.a2f, this.audio.active);
    one('Maxine', g.maxine, this.trackingOn);
    one('RTMW', g.rtmw, this.trackingOn && this.gpuVision.bodyWanted); // (Hands + Body off: RTMW rests on purpose)
    if (!on) return { text: '', state: '' };
    return { text: `GPU ${parts.join(' ')}`, state: bad ? 'warn' : 'ok' };
  }
  /** camera.jpg source: a GPU-scaled 640 px copy of the camera frame plus the landmark dots (drawn by the shot worker). */
  private cameraShot(): { bitmap: Promise<ImageBitmap>; dots: ShotDots } | null {
    const v = this.video.video;
    if (!this.video.ready) return null;
    const w = Math.min(DIAG_CAMERA_W, v.videoWidth), h = Math.max(1, Math.round((w * v.videoHeight) / v.videoWidth));
    let bitmap: Promise<ImageBitmap>;
    try { bitmap = createImageBitmap(v, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' }); } catch { return null; }
    const lm = this.lastRaw?.face?.faceLandmarks?.[0];
    let face: Float32Array | undefined, pose: Float32Array | undefined;
    if (lm) {
      face = new Float32Array(Math.ceil(lm.length / 3) * 2);
      for (let i = 0, k = 0; i < lm.length; i += 3) { face[k++] = lm[i].x; face[k++] = lm[i].y; }
    }
    const pl = this.lastRaw?.pose?.landmarks?.[0];
    if (pl) {
      const vis = pl.filter((p) => (p.visibility ?? 1) > 0.5);
      pose = new Float32Array(vis.length * 2);
      vis.forEach((p, i) => { pose![2 * i] = p.x; pose![2 * i + 1] = p.y; });
    }
    return { bitmap, dots: { face, pose } };
  }

  /**
   * Upload camera.jpg, the stage picture and state.json (+ motion.bin / snacks-cap.json now and then) to /api/diag.
   * `full` (the 'diag' command, MCP request_diagnostics): a fresh full-resolution stage.png (one that comes in while a
   * cycle is running waits for it, it is never dropped). The automatic 3-second cycle passes `stageShot` instead: a
   * 960 px copy of the frame the studio just drew (Stage.grab, taken right after the normal render, or after one frame
   * rendered for it when the preview isn't being drawn: `extra`), uploaded as stage.jpg. Both pictures are encoded on
   * the shot worker: no full-canvas readback on the main thread.
   */
  async sendDiagnostics(full = true, stageShot: Promise<ImageBitmap> | null = null, grabMs = 0, extra = false) {
    if (this.diagBusy) {
      void stageShot?.then((b) => b.close(), () => {});
      if (full) this.diagFullWanted = true;
      return;
    }
    this.diagBusy = true;
    const t0 = performance.now();
    const info: NonNullable<App['diag']> = { syncMs: grabMs, ms: 0, bytes: 0, stage: 'none', ...(extra ? { extra } : {}) };
    try {
      // the tracker may have fallen back to the CPU since the camera started
      this.stats.delegate = this.tracker.delegate;
      const up = async (name: string, body: Blob | string) => {
        if (name.endsWith('.jpg') || name.endsWith('.png')) info.bytes += (body as Blob).size;
        await fetch(`/api/diag/${name}`, { method: 'POST', body }).catch(() => null);
      };
      const a = performance.now();
      // (stall mode: no camera picture either — a crop on the graphics card the game holds; state.json still goes)
      const cam = this.tracker.gameMode && !full ? null : this.cameraShot();
      info.syncMs += performance.now() - a;
      const camBlob = cam ? cam.bitmap.then((b) => this.shots.encode(b, cam.dots), () => null) : null;
      const stageBlob = stageShot ? stageShot.then((b) => this.shots.encode(b), () => null) : null;
      const cb = camBlob && await camBlob;
      if (cb) await up('camera.jpg', cb);
      if (full) {
        await up('stage.png', await this.stage.screenshot());
        info.stage = 'png';
      } else {
        const sb = stageBlob && await stageBlob;
        if (sb) await up('stage.jpg', sb);
        info.stage = sb ? 'jpg' : 'skipped';
      }
      info.ms = performance.now() - t0;
      const top = Object.entries(this.frame.face).filter(([, x]) => x > 0.05).sort((a, b) => b[1] - a[1]).slice(0, 20);
      const rawTop = Object.entries(this.face.raw).filter(([, x]) => x > 0.05).sort((a, b) => b[1] - a[1]).slice(0, 20);
      const state = {
        at: new Date().toISOString(), stats: this.stats, tier: this.tier,
        webgl: glDiag(this.stage.renderer.getContext()), // renderer, GPU vendor / class, ANGLE backend, software 3D (docs/AMD_TEST_PLAN.md)
        tracked: this.frame.tracked, head: this.frame.head, headPos: this.frame.headPos, gaze: this.frame.gaze, mouth: this.frame.mouth,
        drivenTop: Object.fromEntries(top.map(([k, x]) => [k, +x.toFixed(3)])),
        rawTop: Object.fromEntries(rawTop.map(([k, x]) => [k, +x.toFixed(3)])),
        hair: { beard: +this.face.hair.score.toFixed(2), moustache: +this.face.hair.moustache.toFixed(2), weight: +this.face.hairWeight.toFixed(2) }, glasses: { on: this.face.glasses, score: +this.face.glassesState.score.toFixed(2), forced: this.face.glassesOverride, trust: this.face.eyeTrust.trust.map((x) => +x.toFixed(2)) }, slack: { k: +this.face.slack.k.toFixed(2), talk: +this.face.slack.talk.toFixed(2) },
        geo: Object.fromEntries(Object.entries(this.face.geo).map(([k, x]) => [k, +x.toFixed(3)])),
        feats: this.face.feats ? Object.fromEntries(Object.entries(this.face.feats).map(([k, x]) => [k, +(x as number).toFixed(4)])) : null,
        lipGap: +this.face.lipGap.toFixed(3),
        // metric head model + speech lip shapes / mouth-interior image channels (faceSolver / headMetric / mouthImage)
        depth: { Zcm: +(this.face.metric.Z * 100).toFixed(1), irisZcm: +(this.face.metric.irisZ * 100).toFixed(1), fov: this.face.metric.fovDiag, fovSource: this.face.metric.fovSource, faceSizeMm: +(this.face.metric.S * 1000).toFixed(1), learned: this.face.metric.learned, posV: this.face.calib?.posV ?? null },
        lipShape: Object.fromEntries(['_lipTuck', '_lipRound', '_lipSeal', '_lipPress', '_teethGeo', '_teethShow', '_tongueOut', '_tongueUp', '_cavity'].map((k) => [k, +(this.face.lastFrame.face[k] ?? 0).toFixed(3)])),
        mouthImage: { on: this.tracker.mouthImage, active: this.tracker.mouthActive, ms: +this.tracker.timing.mouth.toFixed(2), patchMs: +this.tracker.timing.mouthPatch.toFixed(2), raw: this.face.mouthModel.last?.raw ?? null },
        // something in front of the mouth? (mouthVisibility.ts: 1 = the camera sees the lips)
        mouthVis: { on: this.face.mouthVis.enabled, checking: this.face.mouthVis.checking, pause: this.tracker.mouthVisPause, vis: +this.face.mouthVis.vis.toFixed(2), colour: +this.face.mouthVis.cue.colour.toFixed(2), hands: +this.face.mouthVis.cue.hands.toFixed(2), contrast: +(this.face.mouthVis.cue.contrast || 0).toFixed(3), base: this.face.mouthVis.base === null ? null : +this.face.mouthVis.base.toFixed(3) },
        speech: { ...this.speechDbg, closure: +(this.audio.last.closure ?? 0).toFixed(2), vowels: Object.fromEntries(Object.entries(this.audio.last.vowels).map(([k, x]) => [k, +x.toFixed(2)])) },
        expression: Object.fromEntries(Object.entries(this.exprWeights).filter(([, x]) => x > 0.1).map(([k, x]) => [k, +x.toFixed(2)])),
        roi: this.tracker.roiInfo, lipOpen: +this.face.lipOpen.toFixed(3), mouthClose: +(this.face.raw.mouthClose ?? 0).toFixed(3),
        // anti-fingerprinting changes to canvas / WebGL / audio reads (src/core/readbackProbe.ts)
        readback: { canvas: readback.canvas, webgl: readback.webgl, audio: readback.audio },
        calibrated: this.face.calib?.at ?? null,
        natural: this.face.natural.enabled ? this.face.natural.summary() : null,
        eyes: this.face.eyesTracked !== 'both' ? { tracked: this.face.eyesTracked } : this.face.oneEye.summary(),
        body: this.bodyTargets ? { torso: !!this.bodyTargets.torso, torsoEuler: this.bodyTargets.torsoEuler?.map((x) => +x.toFixed(3)), armL: !!this.bodyTargets.arms.left, armR: !!this.bodyTargets.arms.right, handL: !!this.bodyTargets.hands.left, handR: !!this.bodyTargets.hands.right, handRoi: this.tracker.handRoiInfo } : null,
        // Hands / Body switches (this browser) + the models actually running (face: its time split, GPU-free or not)
        parts: { ...this.parts, models: this.tracker.models() },
        // stall mode (a game holding the graphics card: src/tracking/stallGuard.ts), what Auto is doing, the beacon's health
        // (delegates, rates, frame in flight, starve, graphics-queue round trip, focus) and the helper's card reading
        game: this.tracker.stallInfo(), auto: this.tracker.autoState(), trackHealth: trackingHealthNow(this), gpuCard: this.tracker.gpuStat,
        audio: this.audio.active,
        // GPU sidecars (docs/GPU_TRACKING.md): per source on / connected / frames per second / latency / weight in the fusion
        gpu: this.gpuStatus(),
        voice: this.audio.active ? { filter: this.audio.voiceSettings.filter, fx: !!this.audio.fx, fxError: this.audio.fxError || undefined, vadReady: this.audio.fx?.vadReady, vadError: this.audio.fx?.vadError || undefined, vadMs: this.audio.fx ? +this.audio.fx.vadMs.toFixed(2) : undefined, stat: this.audio.fx?.stat ?? undefined, fricative: this.audio.fricative.cls ? this.audio.fricative : undefined } : undefined,
        avatar: this.profile ? { id: this.profile.id, transform: this.profile.transform, eyes: this.profile.eyes, mouth: this.profile.mouth, tracking: this.profile.tracking } : null,
        runtime: this.runtime?.info ?? null,
        camera: { position: this.stage.camera.position.toArray(), focus: this.focus },
        // jitter meters (deg / mm): trk.* = solver output per tracking frame, raw.* = unfiltered input,
        // out.* = final bones / body offset as published to OBS (see tracking/jitterMeter.ts)
        jitter: this.jitter.report(),
        stab: this.face.stabInfo(),
        multicam: this.multicam.settings.on || this.multicam.running ? this.multicam.diag() : undefined,
        bodyStab: this.body.stabInfo(),
        snacks: this.snacks.settings.enabled ? { detector: this.tracker.objectsActive, ms: +this.tracker.timing.objects.toFixed(1), error: this.tracker.objectsError || undefined, state: this.snacks.state, mess: this.snacks.mess.lv,
          looks: this.tracker.objectsLooks, look: this.snacks.lastLook, capture: !!this.snacks.capture } : undefined,
        // this cycle's pictures: main-thread ms spent capturing them, ms until uploaded, image bytes, stage picture kind
        diag: { syncMs: +info.syncMs.toFixed(2), ms: Math.round(info.ms), bytes: info.bytes, stage: info.stage, extra: info.extra },
      };
      await up('state.json', JSON.stringify(state));
      // rolling raw landmarks for offline body/head evaluation (binary, ~0.6 MB, every ~21 s)
      if ((this.motionUpT += 1) >= 7) { this.motionUpT = 0; await up('motion.bin', new Blob([this.motionRec.snapshot(this.face.metric.fovDiag)])); }
      // food & drink diagnostic capture (detector crops + raw boxes + landmark summaries), every ~20 s
      if (this.snacks.capture && (this.snackUpT += 1) >= 7) { this.snackUpT = 0; const body = await this.snacks.capture.dump(); if (body) await up('snacks-cap.json', body); }
    } finally {
      this.diagBusy = false;
      this.diag = info;
      if (this.diagFullWanted) { this.diagFullWanted = false; void this.sendDiagnostics(true); }
    }
  }

  // ---------------- jitter meters (diagnostics only) ----------------

  /** Per tracking result: solver outputs (trk.*) and their unfiltered inputs (raw.*); feeds the motion recorder. */
  private meterTracking(raw: RawTracking, mirror: boolean) {
    const J = this.jitter, D = THREE.MathUtils.RAD2DEG, t = raw.t;
    const f = this.frame;
    if (f.tracked && raw.face?.faceLandmarks?.[0]) {
      J.add('trk.headRot', t, [f.head[0] * D, f.head[1] * D, f.head[2] * D], 1.2, 2);
      J.add('trk.headPos', t, [f.headPos[0] * 1000, f.headPos[1] * 1000, f.headPos[2] * 1000], 4, 8);
      const r = this.face.relRaw;
      if (r) {
        J.add('raw.headRot', t, [r[0] * D, r[1] * D, r[2] * D], 1.2, 2);
        J.add('raw.headPos', t, [r[3] * 1000, r[4] * 1000, r[5] * 1000], 4, 8);
      }
      this.motionRec.onFace(t, r, f.head, f.headPos, this.face.measure);
    }
    const bid = raw.bodyId ?? -1;
    if (bid === this.meterBodyId) return;
    this.meterBodyId = bid;
    const tb = raw.bodyT ?? t;
    this.motionRec.onBody(tb, raw.bodyId, raw.width / raw.height, mirror, raw.pose, raw.hands);
    const b = this.bodyTargets;
    if (b?.torsoEuler) J.add('trk.torso', tb, b.torsoEuler.map((x) => x * D), 1.5, 3);
    for (const s of ['left', 'right'] as const) {
      const k = s === 'left' ? 'L' : 'R';
      const a = b?.arms[s];
      if (a) { J.addDir(`trk.arm${k}.up`, tb, a.upper, 4, 6); J.addDir(`trk.arm${k}.lo`, tb, a.lower, 5, 8); }
      const h = b?.hands[s];
      if (h) {
        const n = h.forward.clone().cross(h.side);
        J.addQuat(`trk.hand${k}`, tb, new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(h.forward, h.side, n)), 5, 8);
        J.add(`trk.fing${k}`, tb, h.curls.flat().map((x) => x * D / 3.9), 5, 8); // /√15: per-joint RMS
      }
    }
    // unfiltered MediaPipe world-landmark arm directions (anatomical sides)
    const w = raw.pose?.worldLandmarks?.[0], nl = raw.pose?.landmarks?.[0];
    if (w && nl) {
      const v = (i: number) => new THREE.Vector3(w[i].x, -w[i].y, -w[i].z);
      for (const [k, s, e, wr] of [['L', 11, 13, 15], ['R', 12, 14, 16]] as const) {
        if (Math.min(nl[s].visibility ?? 0, nl[e].visibility ?? 0, nl[wr].visibility ?? 0) < 0.35) continue;
        J.addDir(`raw.arm${k}.up`, tb, v(e).sub(v(s)).normalize(), 4, 6);
        J.addDir(`raw.arm${k}.lo`, tb, v(wr).sub(v(e)).normalize(), 5, 8);
      }
    }
  }

  /** Per published frame (≤60 Hz): the final bone rotations + body offset the viewer actually sees. */
  private meterBones(bones: Record<string, [number, number, number, number]>, frame: TrackingFrame, t: number) {
    const J = this.jitter, q = new THREE.Quaternion();
    for (const [bone, key, a, m] of [['head', 'out.head', 1.2, 2], ['chest', 'out.chest', 1.5, 3], ['spine', 'out.spine', 1.5, 3],
      ['leftUpperArm', 'out.upArmL', 4, 6], ['rightUpperArm', 'out.upArmR', 4, 6], ['leftLowerArm', 'out.loArmL', 5, 8], ['rightLowerArm', 'out.loArmR', 5, 8],
      ['leftHand', 'out.handL', 5, 8], ['rightHand', 'out.handR', 5, 8]] as const) {
      const b = bones[bone];
      if (b) J.addQuat(key, t, q.fromArray(b), a, m);
    }
    if (frame.tracked) J.add('out.headPos', t, [frame.headPos[0] * 1000, frame.headPos[1] * 1000, frame.headPos[2] * 1000], 4, 8);
  }

  // ---------------- frame loop ----------------

  private lastRaf = 0;
  /** Sequence number of the frames published to the bus. */
  private sendSeq = 0;
  /**
   * Chrome stops requestAnimationFrame and throttles timers for hidden or fully-covered tabs (e.g. OBS
   * in front of the studio). A Worker's timer isn't throttled, so it keeps tracking + publishing to OBS
   * alive while the studio isn't visible; we just skip drawing the studio's own preview then.
   */
  private startBackgroundTicker() {
    const src = 'setInterval(() => postMessage(0), 16);';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    // 45 ms (was 120): rAF stalls when OBS / a game covers the studio; the worker takes over within ~3 frames
    // instead of ~8, so the OBS avatar no longer hitches for a tenth of a second on every alt-tab
    const late = this.softGl.active ? SOFT_PRESET.tickerMs : 45; // (software 3D: one slow frame alone is longer than 45 ms)
    w.onmessage = () => { if (document.hidden || performance.now() - this.lastRaf > late) { this.bgTicked = true; this.tick(false); } };
  }

  /**
   * One vsync-aligned 60 Hz gate (FpsGate on the rAF timestamp, remainder carried) for the whole studio frame: tracking
   * intake, solvers, voice, expressions, the avatar, the OBS publish and the preview render. On a 120-240 Hz monitor
   * the other rAFs only stamp lastRaf (so the background ticker never takes over while rAF runs). Before, all of it
   * ran on every rAF and the preview gate (reset to now) drew 37-55 fps.
   */
  private readonly gate = new FpsGate(60);
  private rafTs = 0;
  /** The background ticker ran since the last gated rAF: the next tick measures its own dt. */
  private bgTicked = false;
  private loop(ts: number) {
    requestAnimationFrame((t) => this.loop(t));
    this.lastRaf = performance.now();
    this.rate.raf++;
    const dt = this.rafTs ? Math.max(0, (ts - this.rafTs) / 1000) : 1 / 60;
    this.rafTs = ts;
    const step = this.gate.tick(dt);
    if (!step) { this.takeResult(); return; }
    this.tick(true, this.bgTicked ? undefined : step);
    this.bgTicked = false;
  }

  /** Tracker results picked up on the display frames between two gated ticks, oldest first; the next tick runs every
   *  one of them through the solvers. The tracker keeps only its newest face result, so without this a face result that
   *  a newer one replaced before the tick never reached the face / body solvers, the clip recorder or the meters (5.4 %
   *  of them at ~41 results/s on a ~222 Hz display, measured; more as the face rate nears the camera's 60). */
  private rawQ: RawTracking[] = [];
  private takeResult() {
    // (worker mode only: there a result is just picked up; the main-thread tracker runs its models inside process())
    if (!this.trackingOn || !this.video.ready || this.tracker.mode !== 'worker') return;
    const r = this.tracker.process(this.video.video, performance.now());
    if (!r) return;
    if (this.rawQ.length >= RAW_QUEUE_MAX) this.rawQ.shift();
    this.rawQ.push(r);
  }

  /** Skip the studio preview render (tracking + publishing go on): a full-window game view covers it (The Trail). */
  renderHold = false;

  /** Studio preview while live (opt-in, Stream output → Studio view): 'Light' draws the studio's own preview at 30 fps
   *  with a ~2.1 MP drawing buffer while the camera tracks and an OBS output is connected, which leaves GPU time to the
   *  trackers. Only this preview changes: the OBS page and the 60 Hz frames it gets are untouched; screenshots and
   *  thumbnails stay full size. Off (Full) = unchanged. */
  previewLight = (() => { try { return localStorage.getItem('vtp.previewLight') === '1'; } catch { return false; } })();
  setPreviewLight(on: boolean) {
    this.previewLight = on;
    try { if (on) localStorage.setItem('vtp.previewLight', '1'); else localStorage.removeItem('vtp.previewLight'); } catch { /* storage off */ }
  }
  /** Light is in effect right now (selected, tracking, an OBS output connected). */
  get previewLightActive() { return this.lightOn; }
  private lightOn = false;
  private lightN = 0;
  /** OBS output pages connected (helper /api/setup/status, polled every 4 s only while Light is selected). */
  private outputs = { n: 0, at: -1e9 };
  private lightNow(now: number): boolean {
    // software 3D (src/stage/gfx/softwareGl.ts): always the light preview, at its own smaller size
    let on = this.softGl.active;
    // stall mode (a game holds the graphics card: src/tracking/stallGuard.ts): the light preview whatever the setting —
    // what OBS shows is unchanged, the studio view only gives the face its share of the card back
    on ||= this.trackingOn && this.tracker.gameMode;
    if (this.previewLight && this.trackingOn) {
      if (now - this.outputs.at > 4000) { this.outputs.at = now; void this.pollOutputs(); }
      on ||= this.outputs.n > 0;
    }
    if (on !== this.lightOn) { this.lightOn = on; this.lightN = 0; this.stage.setPreviewCap(this.softGl.active ? SOFT_PRESET.previewPixels : on ? LIGHT_PREVIEW_PIXELS : 0); }
    return on;
  }
  /** An OBS page is connected (same 4-second poll as Light uses; only asked while the studio is unfocused). */
  private obsConnected(now: number): boolean {
    if (now - this.outputs.at > 4000) { this.outputs.at = now; void this.pollOutputs(); }
    return this.outputs.n > 0;
  }
  private async pollOutputs() {
    try {
      const r = await fetch('/api/setup/status', { cache: 'no-store' });
      const s = r.ok ? (await r.json()) as { busClients?: number; outputs?: { count?: number; inObs?: number } } : null;
      // pages inside OBS (shared/obsPages.ts); an older version: every output page, or every bus page minus this studio
      this.outputs.n = typeof s?.outputs?.inObs === 'number' ? s.outputs.inObs : typeof s?.outputs?.count === 'number' ? s.outputs.count
        : typeof s?.busClients === 'number' ? s.busClients - 1 : 0;
    } catch { this.outputs.n = 0; }
  }

  /** `render` false = the background ticker (rAF stalled: hidden / covered window). `step` = the gate's dt (s). */
  private tick(render: boolean, step?: number) {
    const now = performance.now();
    const dt = Math.min(0.1, step ?? (now - this.last) / 1000);
    this.last = now;
    const R = this.rate, span = now - R.t;
    if (span >= 500) {
      if (R.t) { const k = 1000 / span; this.stats.fps = R.renders * k; this.stats.loopHz = R.ticks * k; this.stats.avatarHz = R.avatar * k; this.stats.rafHz = R.raf * k; }
      R.t = now; R.ticks = R.renders = R.avatar = R.raf = 0;
      // where tracking runs: the tracker's Auto moves models between the graphics card and the processor while it runs
      if (this.trackingOn) this.stats.delegate = this.tracker.delegate;
    }
    R.ticks++;

    const tune = this.tune;
    // Hands / Body switches: what is tracked this frame (and how far a switched-off part has eased to rest)
    const parts = this.parts;
    this.partFade.step(parts, dt);
    // every camera result of this tick for the synced lip-closure history (speech fusion below): a batched tick used to
    // pass only its newest result, so a one-frame M/B/P dip in an earlier one never got there (review of beta.9)
    const camSamples: CamSample[] = [];
    this.faceModel.tick(now); // ("My face model": the teach routine's clock; nothing when it is not running)
    if (this.trackingOn && now - this.chainT > 500) { this.chainT = now; try { this.chainStep(now); } catch (e) { console.warn('[faceChain]', e); } }
    if (this.trackingOn && this.video.ready) {
      // every tracker result since the last tick, oldest first: the ones taken on display frames between two gated
      // ticks (takeResult, from loop()) and the newest. Their smoothing steps share this tick's dt.
      const newest = this.tracker.process(this.video.video, now);
      if (newest) this.rawQ.push(newest);
      if (this.multicam.settings.on && now - this.mcWatchT > 1000) { this.mcWatchT = now; void this.multicam.watchdog(this.tier, now); }
      const batch = this.rawQ.length ? this.rawQ.splice(0) : NO_RAW;
      const rdt = dt / Math.max(1, batch.length);
      for (const raw0 of batch) {
        // second camera: stereo / close-up fusion or its body + hands (falls back to raw0 on any trouble)
        const raw = this.multicam.running ? this.multicam.step(raw0, now) : raw0;
        if (raw) {
          // GPU sidecars (Maxine face / RTMW body): send this frame, fold in their newest results before the solvers
          this.gpuVision.tick(this.video.video, raw.capture ?? raw.t * 1000, now);
          this.gpuVision.apply(raw);
          this.faceModel.post(raw, this.gpuVision.trackMapped && this.gpuVision.dbg.faceUsed ? { t: this.gpuVision.mappedT, vals: this.gpuVision.mapped } : null); // ("My face model": the teach routine's crops + the scores it would replace, Maxine's mixed in; then the net wins its channels)
          this.lastRaw = raw;
          this.clip.onFrame(raw);
          const lm = raw.face?.faceLandmarks?.[0];
          if (lm && ++this.hairTick % 30 === 1) this.face.hair.update(this.video.video, lm);
          this.stats.inferMs = this.stats.inferMs * 0.9 + raw.inferMs * 0.1;
          const tm = this.tracker.timing;
          this.stats.trackFps = tm.fps; this.stats.latencyMs = tm.latency; this.stats.bodyMs = tm.body; this.stats.trackMode = this.tracker.mode;
          // latency compensation: predict the head to when this frame reaches the viewer — measured camera
          // capture → now, plus transport + the OBS/compositor frame (OUTPUT_LAG)
          const age = Math.min(0.15, Math.max(0, (now - (raw.capture ?? raw.t * 1000)) / 1000));
          // (a starved face — sparse, late results: no lead along a velocity the gap made up, src/tracking/stallLife.ts)
          this.face.lead = (age + OUTPUT_LAG) * (1 - this.starveMeter.w);
          // natural mode: how much the performer is talking (voice level, 300 ms release) — mouth shapes while talking
          // are articulation, not expressions (naturalCapture.ts); no mic → the solver guesses from the jaw
          if (this.audio.active) { const lv = this.audio.last.level ?? 0; this.speakEnv = Math.max(THREE.MathUtils.smoothstep(lv, 0.05, 0.25), this.speakEnv - rdt / 0.3); this.face.speaking = this.speakEnv; } else this.face.speaking = -1;
          // mouth visibility (mouthVisibility.ts): hands over the lips (fresh hand results only; [] = tracked, none seen,
          // null = no hand tracking: the Hands switch is off, OR the hand model isn't running — failed to load, the hands
          // worker not up yet — so the Voice lip-sync status never claims a hand would be noticed), and the mouth-interior
          // channels only while the full 'Teeth and tongue' analysis runs.
          // Only the MAIN camera's hands (raw0): in the multicam Body role `raw` carries camera 2's, in another picture.
          this.face.hands = lipTestHands(raw0 ?? raw, parts.hands && this.tracker.models().hands);
          this.face.imageChannels = this.tracker.mouthActive;
          // (the light face tracker drives the face and the face model is off: nothing to solve; the external frame below is the face)
          if (this.osf.running && raw.face === null) { if (this.frame.tracked) this.frame = { ...this.frame, tracked: false }; }
          else this.frame = this.face.solve(raw.face, raw.t, raw.width / raw.height, tune);
          this.mouthHint(rdt);
          { const s = this.face.oneEye.takeSuggestion(); if (s && !this.observer) toast(`Only your ${s} eye seems to be visible (eye patch?). Tracking → Advanced → Camera & tracking → “Eyes tracked” can follow just that eye.`, 'info', 12000); }
          this.frameAt = now;
          this.frameCapture = raw.capture ?? raw.t * 1000;
          camSamples.push({ t: this.frameCapture / 1000, v: this.frame.face._lipOpen ?? this.frame.mouth.open, vis: this.frame.tracked ? Math.min(1, Math.max(0, this.frame.face._mouthVis ?? 1)) : 0 });
          if (this.learnMe.collecting) try {
            const bt = this.bodyTargets;
            this.learnMe.collect({ t: this.frameCapture / 1000, tracked: this.frame.tracked && !!raw.face?.faceLandmarks?.[0], quality: this.tracker.quality, eyesBoth: this.face.eyesTracked === 'both', mouthSeen: this.frame.face._mouthVis,
              mouth: this.frame.mouth, raw: this.face.raw, head: this.frame.head, headPos: this.frame.headPos, gaze: this.frame.gaze, torso: bt?.torsoEuler ?? null, arms: bt ? bt.arms : null });
          } catch { /* learning must never break tracking */ }
          // (the speaking-profile style is learned only from a mouth the camera really sees)
          if (this.styleRec?.on && this.frame.tracked && (this.frame.face._mouthVis ?? 1) >= 0.5) { const mo = this.frame.mouth; this.styleRec.cam.push({ t: this.frameCapture / 1000, open: mo.open, wide: mo.wide, round: mo.funnel, pucker: mo.pucker }); }
          this.stats.leadMs = this.face.lead * 1000;
          this.stats.quality = this.tracker.quality;
          // mask / hand / mic hiding the face: keep the head moving from the body model's head keypoints
          // (the voice keeps the mouth going, idle life keeps the eyes blinking)
          const occ = this.occlusion.step(this.frame.tracked, this.frame.head, raw.pose, raw.width / raw.height, tune.mirror, tune.headRotationScale, rdt);
          if (occ) this.frame = { ...this.frame, head: occ };
          this.occOn = !!occ;
          this.bodyTargets = parts.body || parts.hands ? this.body.solve(parts.body ? raw.pose : null, parts.hands ? raw.hands : null, raw.t, tune.mirror, tune.smoothing, raw.width / raw.height, { bodyId: raw.bodyId, bodyT: raw.bodyT, handSmoothing: tune.handSmoothing,
            // metric depth layer: camera focal + iris-scaled head distance + face position (neck)
            cam: this.multicam.bodyCam({ focal: this.face.metric.focal(raw.width / raw.height), headZ: this.face.metric.Z, headU: this.face.measure?.u ?? 0.5, headV: this.face.measure?.v ?? 0.5, tracked: this.frame.tracked }),
            lead: Math.min(0.15, Math.max(0, now / 1000 - (raw.bodyT ?? raw.t))) + OUTPUT_LAG }) : null;
          if (this.bodyTargets && parts.hands) {
            for (const side of ['left', 'right'] as const) {
              const g = this.bodyTargets.gestures[side];
              this.gestures.update(side, g?.name ?? null, g?.score ?? 0, g?.wristX ?? null, raw.t);
            }
          }
          // food & drink: the object detector only runs while the feature is on (and the tracker allows it)
          this.tracker.objects = this.snacks.wantObjects;
          this.tracker.objectsHz = this.snacks.settings.hz;
          this.tracker.objectsIdleHz = this.snacks.settings.idleHz; // fewer looks while nothing is going on
          this.tracker.objectsBoost = this.snacks.busy;
          // voice activity for the snack logic: the voice front-end's VAD once it exists (duck-typed onFrame)
          this.snacks.attachVoice(this.audio.voice);
          // diagnostic capture of the detector's inputs while the feature + auto diagnostics are on (local only;
          // localStorage vtp.snacks.capture = '0' turns it off)
          const cap = this.snacks.settings.enabled && this.diagAuto && localStorage.getItem('vtp.snacks.capture') !== '0';
          if (cap !== !!this.snacks.capture) this.snacks.setCapture(cap);
          this.tracker.objectsSnap = cap;
          if (this.snacks.settings.enabled) {
            try { this.snacks.onTracking(raw, this.frame, this.face.raw.jawOpen ?? 0, tune.mirror, this.audio.active ? this.audio.last.level : 0); }
            catch (e) { console.warn('[snacks]', e); }
          }
          // (jitter meters feed state.json / motion.bin)
          try { this.meterTracking(raw, tune.mirror); } catch { /* diagnostics must never break tracking */ }
        }
      }
    } else if (!this.trackingOn) {
      this.rawQ.length = 0;
      this.frame = { ...this.frame, tracked: false };
    }
    // phone / VMC / VTS-plugin face tracking (the webcam, if running, still gives body + hands)
    if (this.trackingSource !== 'webcam') {
      const ext = this.external.frame(now / 1000, tune, this.frame);   // null when silent for > 0.5 s → keep the webcam frame
      if (ext) {
        if (this.trackingSource === 'vts-api') this.frame = { ...this.frame, face: { ...this.frame.face, ...ext.face } };
        else this.frame = { ...ext, lips: undefined };
      }
    }
    this.stats.tracked = this.frame.tracked;
    if (this.diagAuto && this.trackingOn) {
      this.diagT += dt;
      if (this.diagT > 3) { this.diagT = 0; this.diagDue = true; } // runs after this tick's render (end of tick)
    }

    let frame = this.frame;
    // how starved the face is (results sparse / late: a game holding the graphics card), 0 while tracking runs normally
    const sw = this.starveMeter.step(this.frameAt, now, this.trackingOn && this.trackingSource === 'webcam' && this.video.ready);
    this.trackLoss.iv = this.starveMeter.iv;
    // render-rate upsampling: between tracker results (30 fps cameras, dropped frames) keep the head moving
    // along its measured velocity instead of stepping (not along a velocity a sparse sample made up: × (1 - starve))
    if (frame.tracked && frame.headVel && this.trackingOn && this.trackingSource === 'webcam') {
      const a = Math.min(0.05, (now - this.frameAt) / 1000) * (1 - sw);
      if (a > 0.002) {
        const hv = frame.headVel, pv = frame.posVel ?? [0, 0, 0];
        frame = { ...frame, head: [frame.head[0] + hv[0] * a, frame.head[1] + hv[1] * a, frame.head[2] + hv[2] * a],
          headPos: [frame.headPos[0] + pv[0] * a, frame.headPos[1] + pv[1] * a, frame.headPos[2] + pv[2] * a] };
      }
    }
    // ---- when tracking is lost: grace freeze, then hold / rest / voice life, outlier-checked eased recovery ----
    if (tune.trackLoss !== this.trackLossSrc) { this.trackLossSrc = tune.trackLoss; this.trackLoss.settings = sanitizeTrackLoss(tune.trackLoss); }
    if (this.trackingOn) try { frame = this.trackLoss.applyFace(frame, frame.tracked || this.occOn, this.frameAt, now / 1000); } catch (e) { console.warn('[trackLoss]', e); }
    // ---- a starved face (src/tracking/stallLife.ts): the head glides (critically damped follower, blended in by the
    //      starve weight) instead of jumping to each late sample; blinks / eye looks hand over to the face life; held
    //      expressions relax; no velocity is published (OBS must not extrapolate it). Untouched while it is 0. ----
    if (this.trackingOn && frame.tracked && (sw > 0 || this.starveMeter.w1 > 0)) try {
      const hf = this.headFollow.step(frame.head, frame.headPos, sw, this.starveMeter.iv, dt);
      frame = withStarve({ ...frame, head: hf.head, headPos: hf.pos, face: starveFace(frame.face, sw, this.starveMeter.w1), ...(sw > 0.5 ? { headVel: undefined, posVel: undefined } : {}) }, sw);
    } catch (e) { console.warn('[starve]', e); }
    else if (frame.tracked) this.headFollow.step(frame.head, frame.headPos, 0, 0, dt);   // (re-seeded on the live pose)
    else this.headFollow.reset();   // (face lost: re-seeded on the pose shown when it comes back, not the pre-loss one)
    // ---- audio + camera speech fusion ----
    // Camera (lip capture) gives the SHAPE; the mic gives TIMING (~20 ms vs ~80 ms camera latency) and
    // the consonants a camera can't see. Voice onsets open the mouth before the camera catches up,
    // silence snaps it shut, F/V tucks the lower lip under the teeth, S/SH shows clenched teeth.
    // (the mic is the performer's, not the avatar's: a running mic always drives the mouth. Gating this on the avatar's
    //  saved `tracking.audioLipSync` — false on every built-in avatar — silently switched voice lip sync off after any
    //  avatar switch while the mic kept running, and the setup test then learned no mouth style; 2026-09-26)
    if (this.audio.active) {
      // the instant the (lookahead-delayed) voice frame describes: neural visemes for that instant, and — when the
      // lookahead covers the camera latency — the camera's own view of it (synced lip-closure confirmation)
      const tVoice = now / 1000 - this.lookahead.age - this.lookahead.comp;
      // neural visemes: the fast model without / with a short lookahead, the full one once the lookahead covers it
      this.audio.setNeuralModel(modelForLookahead(this.lookahead.delayMs));
      const voice = this.audio.applyNeural(this.lookahead.step(this.audio.sample(dt), now / 1000), tVoice);
      if (this.learnMe.collecting) this.learnMe.pushVoice(tVoice, voice);
      if (this.styleRec?.on) this.styleRec.aud.push({ t: tVoice, level: voice.level, w: sharpen(voice.vowels, tune.enunciation ?? 1.3) });
      const sync = this.trackingSource === 'webcam' && camSyncOn() ? { camTime: this.frameCapture / 1000, voiceTime: tVoice, camSamples } : undefined;
      // a starved face: the mouth goes to the mic (a late camera mouth held a word open through silence, or a resting-lips
      // sample cut the voice: research/tracking_gpu_rca/RCA.md RC3)
      if (sw > 0) frame = { ...frame, face: { ...frame.face, _mouthVis: (frame.face._mouthVis ?? 1) * (1 - sw) }, ...(sw > 0.5 ? { lips: undefined } : {}) };
      const fused = this.speech.step(frame, voice, tune, dt, sync);
      frame = fused.frame;
      // GPU lip sync (Audio2Face-3D sidecar): its mouth for the same instant, blended by the viseme rig
      this.audio.setA2fLookahead(this.lookahead.delayMs);
      frame = this.audio.applyA2f(frame, tVoice, dt);
      this.speechDbg = fused.dbg;
    }
    // ---- personalised expression recognition → strong cartoon expressions ----
    if (this.frame.tracked && this.lastRaw?.face) {
      const rest = this.face.restFor();
      const x = exprFeatures({ raw: this.face.raw, rest, lips: this.face.lipsRaw });
      if (this.exprCapture) this.exprCapture.xs.push(x);
      if (this.exprModel && (tune.expressionBoost ?? 1) > 0) {
        const w = classifyExpr(this.exprModel, x);
        // sanity-gate each class by its core physical signal before smoothing
        // speech passes through frown/pucker/round shapes constantly — hold those expressions back
        // while talking (happy/grin still come through: people smile while they talk)
        const talking = Math.max(this.audio.active ? this.audio.last.level : 0, w.talk ?? 0, Math.min(1, this.frame.mouth.open * 1.6));
        const speechMute = 1 - THREE.MathUtils.smoothstep(talking, 0.3, 0.7);
        for (const c of EXPR_CLASSES) {
          const g = exprGate(c, this.face.raw, rest) * (SPEECH_SENSITIVE.has(c) ? speechMute : 1);
          this.exprWeights[c] = this.exprS[c].step((w[c] ?? 0) * g, dt);
        }
        const boost = tune.expressionBoost ?? 1;
        const face = { ...frame.face };
        let touched = false;
        for (const c of EXPR_CLASSES) {
          const preset = EXPR_PRESETS[c];
          if (!preset) continue;
          const k = THREE.MathUtils.smoothstep(this.exprWeights[c], 0.45, 0.85) * boost * (1 - sw);   // (a starved face: the held expression fades)
          if (k < 0.01) continue;
          touched = true;
          // smirk: mirror the preset onto whichever corner is actually lifted
          const swap = c === 'smirk' && (face.mouthSmileRight ?? 0) > (face.mouthSmileLeft ?? 0);
          for (const [ch, v] of Object.entries(preset)) {
            const key = swap ? ch.replace(/Left$/, '§').replace(/Right$/, 'Left').replace('§', 'Right') : ch;
            face[key] = Math.max(face[key] ?? 0, Math.min(1, v * k));
          }
        }
        if (touched) {
          const g = (k: string) => face[k] ?? 0;
          frame = {
            ...frame, face,
            mouth: {
              ...frame.mouth,
              open: Math.max(frame.mouth.open, g('jawOpen') * 0.9),
              smile: Math.max(frame.mouth.smile, (g('mouthSmileLeft') + g('mouthSmileRight')) / 2),
              frown: Math.max(frame.mouth.frown, (g('mouthFrownLeft') + g('mouthFrownRight')) / 2),
              pucker: Math.max(frame.mouth.pucker, g('mouthPucker')),
              funnel: Math.max(frame.mouth.funnel, g('mouthFunnel')),
            },
          };
        }
      }
    }

    // ---- gesture reactions (quick facial beats on top of tracking) ----
    const tNow = now / 1000;
    for (const e of this.gestures.events) {
      if (e.id <= this.lastGestureId) continue;
      this.lastGestureId = e.id;
      if (tune.gestureReactions !== false) this.reactions.push({ face: REACTIONS[e.kind as GestureKind] ?? {}, start: tNow, until: tNow + 1.3 });
    }
    this.reactions = this.reactions.filter((r) => r.until > tNow);
    if (this.reactions.length) {
      const face = { ...frame.face };
      for (const r of this.reactions) {
        const env = Math.min(1, (tNow - r.start) / 0.12, (r.until - tNow) / 0.35);
        for (const [k, v] of Object.entries(r.face)) face[k] = Math.max(face[k] ?? 0, v * env);
      }
      frame = { ...frame, face };
    }
    if (tune.gestureFx !== false && this.gestures.events.length) frame = { ...frame, fx: this.gestures.events.map((e) => ({ id: e.id, kind: e.kind, side: e.side })) };
    // ---- food & drink: props in hand / sip pucker / mess (travels in the frame to OBS + party) ----
    const snack = this.snacks.tick(dt, tNow);
    if (snack) frame = applySip({ ...frame, snack });

    if (this.override) {
      const t = now / 1000;
      if (t > this.override.until) this.override = null;
      else {
        const ramp = Math.min(1, (this.override.until - t) / 0.3, 1);
        const face = { ...frame.face };
        for (const [k, v] of Object.entries(this.override.face)) face[k] = Math.max(face[k] ?? 0, v * ramp);
        const g = (k: string) => face[k] ?? 0;
        frame = {
          ...frame, face, tracked: true,
          mouth: {
            open: Math.max(frame.mouth.open, g('jawOpen')), wide: (g('mouthStretchLeft') + g('mouthStretchRight')) / 2,
            smile: (g('mouthSmileLeft') + g('mouthSmileRight')) / 2, frown: (g('mouthFrownLeft') + g('mouthFrownRight')) / 2,
            pucker: g('mouthPucker'), funnel: g('mouthFunnel'), tongue: g('tongueOut'),
            fv: Math.max(frame.mouth.fv ?? 0, g('_fv')), sib: Math.max(frame.mouth.sib ?? 0, g('_sib')),
          },
        };
        // viseme previews: `_vis_*` keys become speech visemes (as if said out loud)
        const vis: Record<string, number> = {};
        let vs = 0;
        for (const [k, v] of Object.entries(this.override.face)) if (k.startsWith('_vis_')) { vis[k.slice(5)] = v * ramp; vs += v * ramp; }
        if (vs > 0) { vis.sil = Math.max(0, 1 - vs); frame = { ...frame, visemes: vis, mouth: { ...frame.mouth, speak: 1 } }; }
      }
    }

    if (this.emote) {
      const info = EMOTES.find((e) => e.id === this.emote!.name);
      if (!this.emote.loop && info && Date.now() - this.emote.at > info.dur * 1000 + 400) this.emote = null;
      else frame = { ...frame, emote: this.emote };
    }
    if (this.flatCue.s || this.flatCue.m || this.flatCue.p || this.flatCue.x?.length) frame = { ...frame, flat: this.flatCue };
    // the avatar's own per-channel range + response curves (shared/blendCurves.ts), the last step before 3D and 2D avatars see
    // the face: none saved (every avatar until someone edits one) = this very frame, untouched
    if (tune.blendCurves !== this.curvesSrc) { this.curvesSrc = tune.blendCurves; this.curvesOk = sanitizeBlendCurves(tune.blendCurves, ARKIT); }
    if (this.curvesOk) frame = applyBlendCurves(frame, this.curvesOk);
    if (this.runtime) {
      let bodyT = this.bodyTargets;
      if (this.trackingOn) try { bodyT = this.trackLoss.applyBody(bodyT, now / 1000); } catch (e) { console.warn('[trackLoss]', e); }
      // Hands / Body switches: a part that is off eases from the pose it had into the rest pose, then stays there
      bodyT = this.partFade.compose(bodyT, parts);
      const bones = this.runtime.update(frame, bodyT, this.partTune(tune, parts), dt, this.stage.camera.aspect);
      R.avatar++;
      // Avatar detail: follow the Scene tab's choice live (textures at the next load), pick the level for this view
      const det = this.runtime.detail;
      if (det) { const ch = avatarDetailOf(this.scene.gfx.avatarDetail); if (det.choice !== ch) det.setChoice(ch); det.tick(now); }
      // publish to OBS output pages at ≤60 Hz
      this.sendAcc += dt;
      // 1/61: a 60 Hz loop's dt jitters around 1/60 — a strict 1/60 gate (reset to 0) skipped every other frame
      if (this.sendAcc >= 1 / 61) {
        this.sendAcc = Math.min(this.sendAcc - 1 / 61, 1 / 61);
        // ts / seq: the OBS page times each frame by when it was sent (not when it arrived) and counts drops
        // (the runtime's voice-life frame when it has one: OBS then shows the preview's exact blinks / gaze / head;
        //  party guests get the plain frame and animate their own face life)
        this.bus.send({ type: 'frame', frame: { ...(this.runtime.lifeFrame ?? frame), bones: bones ?? undefined, emote: frame.emote, flat: frame.flat }, ts: performance.timeOrigin + performance.now(), seq: this.sendSeq++ });
        this.party.sendFrame({ ...frame, bones: bones ?? undefined });
        if (bones && this.trackingOn) try { this.meterBones(bones, frame, now / 1000); } catch { /* diagnostics only */ }
      }
    }
    // the studio preview: once per gated frame (≤60 fps: on 144/240 Hz monitors extra frames only steal GPU from the
    // face tracker). Not while the studio view is hidden (body.vp-hidden, a 192×108 canvas nobody sees: screenshots
    // render on their own), nor during renderHold. Light preview (opt-in, while live): every other frame.
    const b = document.body?.classList;
    const drawing = render && !this.renderHold && !studioViewHidden(b); // (also Live Control's studio view on Hide)
    let drew = false;
    // (stall mode with the studio unfocused — a game in front —: every 4th gated tick, ~15 fps; Light: every other.
    //  The same 15 fps also when the studio is unfocused, tracking is on and an OBS page is connected, even before stall
    //  mode: only the studio's own preview slows down, what OBS gets is untouched)
    if (drawing) {
      const lite = this.lightNow(now);
      const hold = !document.hasFocus() && (this.trackingOn && (this.tracker.gameMode || this.obsConnected(now)));
      const every = hold ? 3 : 1;
      if ((!lite && !hold) || (this.lightN++ & every) === 0) { this.stage.render(); R.renders++; drew = true; }
    }
    if (this.diagDue && (drew || !drawing)) {
      // diagnostics: a GPU-scaled copy of the frame just drawn (same task, so exactly this frame). When the preview isn't
      // being drawn (studio view hidden, window covered so the background ticker runs, renderHold) one frame is rendered
      // for the picture, once per 3-second cycle, so stage.jpg stays current (the old stage.png cycle rendered one too).
      // Light: waits for the next drawn frame.
      this.diagDue = false;
      // the previous cycle is still running (sendDiagnostics would drop this one): don't queue a GPU copy or an extra
      // render just to throw it away; the next 3-second window tries again
      if (this.diagBusy) return;
      // (a hidden studio — a game in front —, or stall mode: no studio picture on the card the game holds, just the numbers)
      if ((!drew && document.hidden) || this.tracker.gameMode) { void this.sendDiagnostics(false, null, 0, false); return; }
      const a = performance.now();
      if (!drew) this.stage.render();
      const shot = this.stage.grab(DIAG_STAGE_W);
      void this.sendDiagnostics(false, shot, performance.now() - a, !drew);
    }
  }
}

function loadExprModel(): ExprModel | null {
  try { const s = localStorage.getItem('vtp.exprModel'); if (s) return JSON.parse(s) as ExprModel; } catch { /* ignore */ }
  const d = DEFAULT_EXPR_MODEL as unknown as ExprModel;
  return d.classes?.length ? d : null;
}

function detectTier(): QualityTier {
  const cores = navigator.hardwareConcurrency || 4;
  let gpu = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = (ext && gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || '';
  } catch { /* ignore */ }
  const g = String(gpu).toLowerCase();
  if (/rtx\s?(40|50)|rx\s?(7|9)[0-9]{3}|apple m[2-9] (max|ultra)/.test(g) && cores >= 12) return 'ultra';
  if (/rtx|rx\s?[5-9][0-9]{3}|arc|apple m/.test(g) && cores >= 8) return 'high';
  if (/intel|uhd|iris|mali|adreno|swiftshader|llvmpipe/.test(g) || cores <= 4) return 'low';
  return 'medium';
}

/** Synced camera lip-closure confirmation (speechFusion.ts; only acts with the lip-sync lookahead ≥ ~60 ms). Off switch: localStorage['vtp.camSync'] = '0'. */
function camSyncOn(): boolean { try { return globalThis.localStorage?.getItem('vtp.camSync') !== '0'; } catch { return true; } }

/** Which phone / sentence a guided-setup prompt records for the personal neural visemes (neuralPersonal.ts). */
function nvStepFor(say: string): { kind: 'held'; phone: string } | { kind: 'script'; text: string } | null {
  const q = say.match(/“([^”]+)”/)?.[1]?.toLowerCase() ?? '';
  if (/quick brown fox/.test(q)) return { kind: 'script', text: q };
  const held: [RegExp, string][] = [[/^a+h+$/, 'AA'], [/^e+$/, 'IY'], [/^o+$/, 'UW'], [/^e+h+$/, 'EH'], [/^o+h+$/, 'OW'], [/^f+$/, 'F'], [/^v+$/, 'V'], [/^l+$/, 'L'],
    [/^s+h+$/, 'SH'], [/^s+$/, 'S'], [/^t+h+$/, 'TH'], [/^r+$/, 'R'], [/^m+$/, 'M'], [/^w+(-w+)*$/, 'W']];
  for (const [re, ph] of held) if (re.test(q)) return { kind: 'held', phone: ph };
  return null;
}
