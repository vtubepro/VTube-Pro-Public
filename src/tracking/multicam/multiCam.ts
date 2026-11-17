// "Two cameras" — a second webcam next to the main one. Roles:
//   stereo  both cameras see the face from different angles → self-calibrated stereo fusion (stereoFuse.ts): true
//           depth, steadier head, and the face keeps tracking when one camera can't see it (hand over the mouth,
//           head turned far away from the main camera)
//   mouth   a camera closer / lower, aimed at the mouth → the same fusion with the mouth region trusted to it (it sees
//           the lips / teeth from a better angle); works uncalibrated too (mouth blendshapes only)
//   body    a wider camera for the body and hands while the main camera stays tight on the face
// The second camera runs its OWN tracker (worker, GPU delegate) with a face-rate cap and a gate that only feeds it
// while the main camera's face model is idle, so the main camera's face latency doesn't grow. Any trouble (camera
// unplugged, stalled, worker crash, resolution change that breaks the calibration) falls back to the main camera
// alone on the very next frame; the second camera is re-opened automatically when it comes back.
import { Tracker, type QualityTier, type RawTracking } from '../Tracker.ts';
import { VideoSource, listCameras } from '../camera.ts';
import { DEFAULT_FOV, fovForLabel } from '../headMetric.ts';
import { StereoCalibrator, type CamInfo, type FaceObs, type StereoCalib } from './stereoCalib.ts';
import { StereoFuser, type FuseInfo, type MpFace } from './stereoFuse.ts';
import { glToCv, quatFromM, rotFromMpMatrix } from './mcMath.ts';

export type McRole = 'stereo' | 'mouth' | 'body';
export interface McSettings {
  on: boolean;
  deviceId: string;
  label: string;
  role: McRole;
  /** requested height of camera 2 (480 / 720 / 1080) */
  res: 480 | 720 | 1080;
  fps: 30 | 60;
  /** max face-model runs per second on camera 2 */
  hz: number;
  /** keep the face when only camera 2 sees it */
  bOnly: boolean;
  calib: StereoCalib | null;
}
const KEY = 'vtp.multicam';
export const MC_DEFAULTS: McSettings = { on: false, deviceId: '', label: '', role: 'stereo', res: 720, fps: 30, hz: 30, bOnly: true, calib: null };
function load(): McSettings {
  try { const s = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (s && typeof s === 'object') return { ...MC_DEFAULTS, ...s }; } catch { /* storage off */ }
  return { ...MC_DEFAULTS };
}
export type McState = 'off' | 'starting' | 'live' | 'dropped' | 'error';

export class MultiCam {
  settings: McSettings = load();
  readonly video = new VideoSource();
  state: McState = 'off';
  error = '';
  /** camera 2 as opened */
  cam: { label: string; w: number; h: number; fps: number; deviceId: string } | null = null;
  /** live stats: camera-2 results/s, its face ms, age of the frame used, fusion mode */
  stats = { fps: 0, ms: 0, ageMs: 0, mode: 'off' as string, faceB: false, fuseMs: 0 };
  /** last camera-2 result (UI overlays) */
  lastB: RawTracking | null = null;
  lastA: RawTracking | null = null;
  info: FuseInfo | null = null;
  calibrator: StereoCalibrator | null = null;
  calibrating = false;
  compare: CompareMeter | null = null;
  private operation = 0;
  private tracker: Tracker | null = null;
  private fuser: StereoFuser | null = null;
  private bsOnly = new MouthBsFuser();
  private lastBAt = 0;
  private cnt = 0; private cntT = 0;
  private reopenT = 0;
  private mainInfo: { label: string; w: number; h: number } = { label: '', w: 0, h: 0 };
  /** Hands / Body switches (shared/trackParts.ts; the app sets them): what camera 2 tracks in the Body role. */
  private parts = { hands: true, body: true };
  private tier: QualityTier = 'high';

  constructor(private main: Tracker) {}

  /** The Hands / Body switches changed: camera 2 (Body role) stops / starts the same models as the main camera. */
  setParts(p: { hands: boolean; body: boolean }) {
    this.parts = { hands: !!p.hands, body: !!p.body };
    if (this.tracker && this.settings.role === 'body') void this.tracker.configure({ tier: this.tier, body: this.parts.body, hands: this.parts.hands, face: false }).catch(() => {});
    this.lastBAt = performance.now(); // a model (re)starting is not a camera that dropped out
  }
  /** Body role with Hands and Body both off: camera 2 has nothing to track (and that is not a fault). */
  private get idle() { return this.settings.role === 'body' && !this.parts.body && !this.parts.hands; }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch { /* storage off */ } }
  set(p: Partial<McSettings>) { Object.assign(this.settings, p); this.save(); if ('calib' in p || 'role' in p) this.makeFuser(); }
  get running() { return this.state === 'live' || this.state === 'dropped'; }
  /** Fusion actually changing the face right now. */
  get fusing() { return this.settings.on && this.state === 'live' && this.stats.mode !== 'mono' && this.stats.mode !== 'off'; }
  get calibrated() { return !!this.settings.calib && this.calibFits(); }

  /** Cameras other than the main one (the main camera's deviceId is excluded). */
  async candidates(mainDeviceId: string) {
    return (await listCameras().catch(() => [])).filter((c) => c.deviceId !== mainDeviceId);
  }

  /** Open camera 2 and its tracker. `main` = the main camera (label/size for the calibration). */
  async start(tier: QualityTier, main: { label: string; w: number; h: number; deviceId?: string }, deviceId = this.settings.deviceId, testFile?: File) {
    this.stop();
    const operation = this.operation;
    this.mainInfo = { label: main.label, w: main.w, h: main.h };
    if (!deviceId && !testFile) { this.state = 'error'; this.error = 'Pick camera 2 first'; return false; }
    if (main.deviceId && deviceId === main.deviceId) { this.state = 'error'; this.error = 'Camera 2 is the same camera as the main one'; return false; }
    this.state = 'starting'; this.error = '';
    try {
      const h = this.settings.res, w = Math.round((h * 16) / 9);
      if (testFile) {
        // recorded second view (tools/multicam_render.py) — end-to-end tests without a second physical camera
        await this.video.openFile(testFile);
        if (operation !== this.operation) return false;
        await new Promise((r) => setTimeout(r, 300));
        if (operation !== this.operation) return false;
        this.cam = { label: `file: ${testFile.name}`, w: this.video.video.videoWidth, h: this.video.video.videoHeight, fps: 60, deviceId: '' };
      } else {
        const info = await this.video.openCamera({ deviceId, width: w, height: h, fps: this.settings.fps });
        if (operation !== this.operation) return false;
        this.cam = { label: info.label, w: info.width, h: info.height, fps: info.fps, deviceId };
        if (this.settings.deviceId !== deviceId || this.settings.label !== info.label) { this.settings.deviceId = deviceId; this.settings.label = info.label; this.save(); }
      }
      const tr = new Tracker();
      this.tracker = tr; // Stop also closes a tracker whose initialization is still pending.
      tr.allowMain = false; // never a second main-thread tracker (it would stall rendering)
      tr.mouthVisPatch = false; // mouth visibility reads the main camera's patch only
      const body = this.settings.role === 'body';
      tr.faceHz = body ? 0 : this.settings.hz;
      // feed camera 2 while the main face model is idle
      let lastGate = 0;
      // (a busy main model only waits for camera 2 when camera 2 is overdue: ≥ ~2/3 of its target rate is guaranteed)
      const overdue = 1500 / Math.max(10, this.settings.hz);
      // (main camera in stall mode — a game holds the graphics card: camera 2 only in the main face model's idle moments,
      //  never forced in when overdue: the main face gets all the card gives; beta.13.5)
      tr.gate = () => { const n = performance.now(); if (this.main.faceIdle || (!this.main.gameMode && n - lastGate > overdue)) { lastGate = n; return true; } return false; };
      this.tier = tier;
      await tr.init({ tier: body ? tier : 'medium', body: body && this.parts.body, hands: body && this.parts.hands, face: !body });
      if (operation !== this.operation) return false;
      // (kept so stop() can remove it: it stayed on the track, closing over this object, after the camera was stopped)
      const track = this.video.track, onEnded = () => {
        if (operation === this.operation) this.onDrop('Camera 2 was unplugged or turned off');
      };
      track?.addEventListener('ended', onEnded);
      this.endedOff = () => track?.removeEventListener('ended', onEnded);
      this.state = 'live';
      this.lastBAt = performance.now();
      this.makeFuser();
      return true;
    } catch (e) {
      if (operation !== this.operation) return false;
      this.stop();
      this.state = 'error';
      this.error = (e as Error).name === 'NotReadableError' ? 'Camera 2 is busy (another app or a USB bandwidth limit) — try 720p or another USB port' : `Camera 2 failed: ${(e as Error).message}`;
      return false;
    }
  }

  private endedOff: (() => void) | null = null;

  stop() {
    this.operation++;
    this.endedOff?.(); this.endedOff = null;
    this.tracker?.close(); this.tracker = null;
    this.video.stop();
    this.fuser?.dropB();
    this.state = 'off'; this.error = '';
    this.stats.mode = 'off';
    this.lastB = null;
    this.calibrating = false;
  }

  private onDrop(why: string) {
    if (this.state === 'off') return;
    this.state = 'dropped'; this.error = why;
    this.fuser?.dropB();
  }

  private calibFits(): boolean {
    const c = this.settings.calib;
    if (!c || !this.cam) return !!c;
    const same = (a: string, b: string) => a.replace(/\s*\([0-9a-f:]+\)\s*$/i, '') === b.replace(/\s*\([0-9a-f:]+\)\s*$/i, '');
    return same(c.B.label, this.cam.label) && (!this.mainInfo.label || same(c.A.label, this.mainInfo.label));
  }
  private makeFuser() {
    const c = this.settings.calib;
    this.fuser = null;
    if (!c || this.settings.role === 'body' || !this.calibFits()) return;
    this.fuser = new StereoFuser(c, this.mainInfo.w ? this.mainInfo : undefined, this.cam ? { w: this.cam.w, h: this.cam.h } : undefined);
    this.fuser.bOnly = this.settings.bOnly;
  }

  // ---------------------------------------------------------------- per frame
  /**
   * Called with every main-camera result. Polls camera 2, feeds the calibration while it runs, and returns the result
   * the rest of the app should use (the fused face, or camera 2's body / hands in the Body role). Never throws.
   */
  step(raw: RawTracking, now: number): RawTracking {
    this.lastA = raw;
    if (!this.tracker || !this.running) return raw;
    if (this.idle) { this.lastBAt = now; this.stats.mode = 'mono'; return raw; } // Hands + Body off: nothing to add, never "dropped"
    try {
      if (this.tracker.failed) { this.onDrop('Camera 2 tracking stopped'); this.tracker.close(); this.tracker = null; this.reopenT = now; return raw; }
      const b = this.tracker.process(this.video.video, now);
      if (b) {
        this.lastB = b; this.lastBAt = now; this.cnt++;
        this.stats.ms = this.tracker.timing.face || this.tracker.timing.body;
        this.stats.faceB = !!b.face;
        if (this.state === 'dropped') { this.state = 'live'; this.error = ''; }
        if (this.settings.role !== 'body') {
          this.fuser?.pushB(b.face as unknown as MpFace | null, (b.capture ?? b.t * 1000) / 1000);
          if (this.calibrating && b.face) this.calibrator?.addB(obs(b));
        }
      }
      if (now - this.cntT > 1000) { this.stats.fps = (this.cnt * 1000) / (now - this.cntT); this.cnt = 0; this.cntT = now; }
      if (now - this.lastBAt > 1500 && this.state === 'live') this.onDrop('Camera 2 stopped delivering frames');
      if (this.calibrating && raw.face) this.calibrator?.addA(obs(raw));
      if (!this.settings.on || this.state !== 'live') { this.stats.mode = 'mono'; return raw; }
      // ---- body role: camera 2's pose + hands (ids offset so the body solver never mixes them up with camera 1's)
      if (this.settings.role === 'body') {
        const lb = this.lastB;
        if (!lb || now - this.lastBAt > 300 || (!lb.pose && !lb.hands)) { this.stats.mode = 'mono'; return raw; }
        this.stats.mode = 'body';
        return { ...raw, pose: lb.pose, hands: lb.hands, bodyId: (lb.bodyId ?? 0) + 1e7, bodyT: lb.bodyT };
      }
      const t0 = performance.now();
      const tA = (raw.capture ?? raw.t * 1000) / 1000;
      let face = raw.face as unknown as MpFace | null;
      if (this.fuser) {
        if (this.cam && raw.width && (raw.width !== this.mainInfo.w || raw.height !== this.mainInfo.h)) {
          this.mainInfo = { ...this.mainInfo, w: raw.width, h: raw.height };
          if (!this.fuser.setResolution(this.mainInfo, { w: this.cam.w, h: this.cam.h })) { this.fuser = null; this.error = 'A camera changed its picture shape — calibrate again'; }
        }
      }
      if (this.fuser) {
        face = this.fuser.fuse(face, tA, { role: this.settings.role === 'mouth' ? 'mouth' : 'stereo', handsA: raw.hands?.landmarks ?? null });
        this.info = this.fuser.info;
        this.stats.mode = this.info.mode; this.stats.ageMs = this.info.ageMs;
      } else if (this.settings.role === 'mouth') {
        face = this.bsOnly.fuse(face, this.lastB?.face as unknown as MpFace | null, now - this.lastBAt);
        this.stats.mode = this.bsOnly.used ? 'mouth (uncalibrated)' : 'mono';
      } else this.stats.mode = 'mono (not calibrated)';
      this.stats.fuseMs += (performance.now() - t0 - this.stats.fuseMs) * 0.1;
      this.compare?.add(tA, raw.face as unknown as MpFace | null, face);
      return face === (raw.face as unknown) ? raw : { ...raw, face: face as unknown as RawTracking['face'] };
    } catch (e) {
      console.warn('[multicam] fusion error, using the main camera alone', e);
      this.stats.mode = 'mono';
      return raw;
    }
  }

  /** Re-open a dropped camera 2 every few seconds (unplug → plug back in). Call ~1×/s. */
  async watchdog(tier: QualityTier, now: number) {
    if (!this.settings.on || (this.state !== 'dropped' && this.state !== 'error') || now - this.reopenT < 5000 || (this.cam && !this.cam.deviceId)) return;
    const tr = this.video.track;
    if (this.state === 'dropped' && tr && tr.readyState === 'live' && this.tracker) return; // just stalled: results may resume
    this.reopenT = now;
    const operation = this.operation;
    const cams = await listCameras().catch(() => []);
    if (operation !== this.operation || !this.settings.on) return;
    if (!cams.some((c) => c.deviceId === this.settings.deviceId)) return;
    await this.start(tier, { ...this.mainInfo });
  }

  // ---------------------------------------------------------------- calibration
  startCalibration() {
    if (!this.cam) return false;
    const fov = (l: string) => fovForLabel(l) ?? DEFAULT_FOV;
    const a: CamInfo = { label: this.mainInfo.label, w: this.mainInfo.w, h: this.mainInfo.h, fovDiag: fov(this.mainInfo.label) };
    const b: CamInfo = { label: this.cam.label, w: this.cam.w, h: this.cam.h, fovDiag: fov(this.cam.label) };
    this.calibrator = new StereoCalibrator(a, b);
    this.calibrating = true;
    return true;
  }
  calibProgress() { return this.calibrator?.progress() ?? { p: 0, pairs: 0, yawDeg: 0, pitchDeg: 0, hint: '' }; }
  cancelCalibration() { this.calibrating = false; this.calibrator = null; }
  /** Solve in a worker; stores the result on success. */
  async finishCalibration(): Promise<StereoCalib> {
    const c = this.calibrator;
    this.calibrating = false;
    if (!c) throw new Error('No calibration running');
    const d = c.dump();
    const w = new Worker(new URL('./calibWorker.ts', import.meta.url), { type: 'module', name: 'vtp-calib' });
    try {
      const r = await new Promise<{ ok: boolean; calib?: StereoCalib; error?: string }>((res, rej) => {
        const timer = setTimeout(() => rej(new Error('calibration timed out')), 30000);
        w.onmessage = (e) => { clearTimeout(timer); res(e.data); };
        w.onerror = (e) => { clearTimeout(timer); rej(new Error(e.message || 'calibration worker failed')); };
        w.postMessage({ camA: c.camA, camB: c.camB, A: d.A, B: d.B });
      });
      if (!r.ok || !r.calib) throw new Error(r.error ?? 'calibration failed');
      this.set({ calib: r.calib });
      this.calibrator = null;
      return r.calib;
    } finally { w.terminate(); }
  }
  forgetCalibration() { this.set({ calib: null }); }

  /** Body role: camera 2's focal for the body solver's depth layer (no head distance: it assumes ~0.6 m then). */
  bodyCam(fallback: { focal: number; headZ: number; headU: number; headV: number; tracked: boolean }) {
    if (this.settings.role !== 'body' || this.stats.mode !== 'body' || !this.cam) return fallback;
    const aspect = this.cam.w / this.cam.h, fov = fovForLabel(this.cam.label) ?? DEFAULT_FOV;
    const tanH = Math.tan((fov * Math.PI) / 360) * aspect / Math.hypot(aspect, 1);
    return { focal: 0.5 / tanH, headZ: 0, headU: 0.5, headV: 0.5, tracked: false };
  }

  diag() {
    const c = this.settings.calib;
    return {
      on: this.settings.on, role: this.settings.role, state: this.state, error: this.error || undefined, cam: this.cam, stats: { ...this.stats, fps: +this.stats.fps.toFixed(1), ms: +this.stats.ms.toFixed(1), ageMs: +this.stats.ageMs.toFixed(0), fuseMs: +this.stats.fuseMs.toFixed(2) },
      calib: c ? { grade: c.grade, rmsPx: +c.rmsPx.toFixed(2), baselineMm: Math.round(c.baselineMm), angleDeg: Math.round(c.angleDeg), offsetMs: Math.round(c.offsetMs), at: c.at, fits: this.calibFits() } : null,
      fuse: this.info ? { mode: this.info.mode, residPx: +this.info.residPx.toFixed(2), zCm: +(this.info.zM * 100).toFixed(1), shareA: this.info.shareA, occludedA: this.info.occludedA, inconsistent: this.info.inconsistent } : null,
    };
  }
}

function obs(r: RawTracking): FaceObs {
  const lm = r.face!.faceLandmarks[0];
  const a = new Float32Array(lm.length * 3);
  for (let i = 0; i < lm.length; i++) { a[i * 3] = lm[i].x; a[i * 3 + 1] = lm[i].y; a[i * 3 + 2] = lm[i].z; }
  return { t: (r.capture ?? r.t * 1000) / 1000, lm: a, mat: r.face!.facialTransformationMatrixes?.[0]?.data ?? null, w: r.width, h: r.height };
}

/**
 * Close-up mouth camera WITHOUT calibration: only the mouth / jaw blendshapes are fused (camera 2's values mapped onto
 * the main camera's scale by an online linear fit, weighted up), everything else stays the main camera's.
 */
class MouthBsFuser {
  used = false;
  private m = new Map<string, { n: number; mx: number; my: number; sxx: number; sxy: number }>();
  fuse(a: MpFace | null, b: MpFace | null, ageMs: number): MpFace | null {
    this.used = false;
    const ca = a?.faceBlendshapes?.[0]?.categories, cb = b?.faceBlendshapes?.[0]?.categories;
    if (!a || !ca || !cb || ageMs > 80) return a;
    const bv = new Map(cb.map((c) => [c.categoryName, c.score]));
    const wB = 0.6 * Math.exp(-ageMs / 40);
    const cats = ca.map((c) => {
      const n = c.categoryName;
      if (!(n.startsWith('mouth') || n.startsWith('jaw'))) return c;
      const x = bv.get(n);
      if (x === undefined) return c;
      let s = this.m.get(n);
      if (!s) { s = { n: 0, mx: 0, my: 0, sxx: 0, sxy: 0 }; this.m.set(n, s); }
      const k = 1 / Math.min(600, ++s.n);
      s.mx += (x - s.mx) * k; s.my += (c.score - s.my) * k; s.sxx += ((x - s.mx) ** 2 - s.sxx) * k; s.sxy += ((x - s.mx) * (c.score - s.my) - s.sxy) * k;
      const slope = s.n < 60 || s.sxx < 1e-4 ? 1 : Math.min(2.5, Math.max(0.4, (s.sxy + 0.01) / (s.sxx + 0.01)));
      const mapped = s.n < 60 ? x : s.my + (x - s.mx) * slope;
      return { ...c, score: Math.min(1, Math.max(0, c.score * (1 - wB) + mapped * wB)) };
    });
    this.used = true;
    return { ...a, faceBlendshapes: [{ ...a.faceBlendshapes![0], categories: cats }] };
  }
}

/**
 * Before / after meter for the wizard: jitter of the main camera alone vs the fused result over the same frames
 * (high-frequency residual vs a zero-phase 5-tap average: head rotation in degrees, landmarks in pixels).
 */
export class CompareMeter {
  private rows: { a: number[] | null; f: number[] | null }[] = [];
  constructor(public seconds = 12) {}
  add(_t: number, a: MpFace | null, f: MpFace | null) {
    const v = (r: MpFace | null) => {
      const lm = r?.faceLandmarks?.[0], mat = r?.facialTransformationMatrixes?.[0]?.data;
      if (!lm || !mat) return null;
      const o: number[] = [];
      for (let j = 0; j < 468; j += 6) o.push(lm[j].x * 1280, lm[j].y * 720);
      const q = quatFromM(glToCv(rotFromMpMatrix(mat))); const s = q[3] < 0 ? -1 : 1;
      o.push(q[0] * s * 114.59, q[1] * s * 114.59, q[2] * s * 114.59);
      return o;
    };
    this.rows.push({ a: v(a), f: v(f) });
    if (this.rows.length > this.seconds * 60) this.rows.shift();
  }
  get frames() { return this.rows.length; }
  result() {
    const j = (k: 'a' | 'f') => {
      let lm = 0, rot = 0, n = 0;
      for (let i = 2; i < this.rows.length - 2; i++) {
        const c = this.rows[i][k], nb = [-2, -1, 1, 2].map((d) => this.rows[i + d][k]);
        if (!c || nb.some((x) => !x)) continue;
        const L = c.length - 3; let e = 0, er = 0;
        for (let q = 0; q < c.length; q++) { const m = (c[q] * 2 + nb[0]![q] + nb[1]![q] * 2 + nb[2]![q] * 2 + nb[3]![q]) / 8; const d = (c[q] - m) ** 2; if (q < L) e += d; else er += d; }
        lm += e / L; rot += er / 3; n++;
      }
      return n ? { lmPx: Math.sqrt(lm / n), rotDeg: Math.sqrt(rot / n), n } : null;
    };
    const faceA = this.rows.filter((r) => r.a).length, faceF = this.rows.filter((r) => r.f).length;
    return { mono: j('a'), fused: j('f'), faceFramesMono: faceA, faceFramesFused: faceF, frames: this.rows.length };
  }
}
