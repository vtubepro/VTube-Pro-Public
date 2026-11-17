// Fast window feed (Windows): the server captures a window with Windows.Graphics.Capture (ffmpeg's gfxcapture, an
// optional external tool), encodes it at ultra-low latency and streams it over ws://…/ws/screen to the OBS output pages,
// which decode it with WebCodecs and draw it ON the room's 3D screen. The window comes from the performer's own OBS
// capture source (read with obs-websocket, read-only) or from a window picked in the studio.
//
//   GET /api/capture          → CaptureStatus            PUT /api/capture  → CaptureSettings (localhost only)
//   GET /api/capture/windows  → { windows: CaptureWindow[] }
//   GET /api/obs/diagnose     → ObsDiagnosis (read-only look at the OBS setup, plain words)
//
// ws /ws/screen (binary, server → page): [u8 flags (bit0 key frame)][f64 server time ms][H.264 Annex-B access unit]
//               (text, server → page): FeedConfig JSON · FeedStatusMsg JSON (on join + on change) · {type:'stop'}
//               (text, page → server): FeedRxStats JSON

/** Where the fast feed takes its window from. */
export type CaptureSourceMode = 'obs' | 'window' | 'off';

export interface CaptureSettings {
  /** 'obs' (default) = the window/monitor the OBS capture source (OBS automation → Capture source) shows. */
  source: CaptureSourceMode;
  /** 'window' mode: OBS-style "title:class:exe" of the picked window. */
  window: string;
  /** Optional ffmpeg.exe path (else PATH / winget / common folders; looked at instead while this path is gone). */
  ffmpeg: string;
  /** Longest side cap (px). */
  maxWidth: number;
  fps: number;
  /** Also use an AMD (AMF) / Intel (Quick Sync) GPU encoder when NVENC can't be used: ≈ 0.5 of a CPU core less than x264,
   *  but the picture arrives one frame later and a window that stops changing shows its last change late (FFmpeg 8.1).
   *  Off (default) = NVENC, else x264, as always. */
  anyGpu?: boolean;
}

export interface CaptureWindow { value: string; title: string; exe: string }

export interface FeedConfig { type: 'config'; codec: string; width: number; height: number; label: string; encoder: string }
/** One OBS page's report (every second). `fps` = frames decoded and shown, `rx` = access units received; `error` = this
 *  page can't decode at all (it stops counting as a viewer); `decErr` = the decoder's last failure while it still tries
 *  (cleared by the next good frame), `decErrors` = how many so far. */
export interface FeedRxStats { type: 'stats'; fps: number; decodeMs: number; ageMs: number; hw: boolean; error?: string; rx?: number; decErr?: string; decErrors?: number }
/** The helper's feed state for the OBS pages (they keep the React screen in the room unless it is a definite no). */
export interface FeedStatusMsg { type: 'status'; state: CaptureStatus['state']; message: string }

export interface CaptureStatus {
  settings: CaptureSettings;
  /** 'running' = frames flowing · 'idle' = no OBS page needs it (Talk mode / passthrough) · 'starting' · 'error'. */
  state: 'running' | 'idle' | 'starting' | 'error' | 'unavailable';
  /** Plain-words one-liner for the Scene tab. */
  message: string;
  /** What is captured (e.g. OBS “Window Capture” → [blender.exe] Area 18). */
  label: string;
  obsSource: string | null;
  obsKind: string | null;
  target: string | null;
  /** encoder: 'NVENC (GPU)' | 'x264 (CPU)' | 'AMF (GPU)' | 'Quick Sync (GPU)' (the last two with anyGpu, or without x264).
   *  gpuNote: why a GPU encoder was skipped (e.g. 'GPU encoder off: NVIDIA driver 610+ needed (found API 13.0)'), null
   *  when none failed (an encoder whose maker's card is not in this PC, e.g. NVENC on an AMD-only PC, does not count).
   *  gpuOptIn: a GPU encoder that works here but waits for anyGpu (e.g. 'AMF (GPU)'), else null.
   *  note: the saved ffmpeg path is gone (a winget upgrade moves it) and another ffmpeg is used, else null. */
  ffmpeg: { path: string | null; version: string | null; gfxcapture: boolean; encoder: string | null; gpuNote?: string | null; gpuOptIn?: string | null; note?: string | null };
  width: number;
  height: number;
  fps: number;
  kbps: number;
  /** OBS pages receiving the feed + what they report. */
  receivers: FeedRxStats[];
  /** Estimated window → OBS delay (ms), null when unknown. */
  latencyMs: number | null;
  error: string | null;
}

export interface ObsFinding { level: 'ok' | 'warn' | 'err' | 'info'; text: string; fix?: string }
export interface ObsDiagnosis { ok: boolean; connected: boolean; scene: string | null; findings: ObsFinding[] }
