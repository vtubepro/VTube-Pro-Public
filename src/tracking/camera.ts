// Any webcam (or a video file) as a tracking source. No depth sensor needed.
import { phoneCameraRequest } from '../mobile/cameraProfile.ts';
import { phoneCameraApp } from '../../shared/autopilot/media.ts';

export interface CameraOption { deviceId: string; label: string }

export async function listCameras(): Promise<CameraOption[]> {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs
    .filter((d) => d.kind === 'videoinput')
    // phone-webcam apps read as "Your phone (Camo) · Reincubate Camo" (the device's own name stays in, for matching)
    .map((d, i) => { const app = d.label ? phoneCameraApp(d.label) : null; return { deviceId: d.deviceId, label: app ? `Your phone (${app}) · ${d.label}` : d.label || `Camera ${i + 1}` }; });
}

/** Pick the user's preferred device by label (e.g. /elgato|facecam/i), else the first. */
export function preferred<T extends { label: string }>(list: T[], re: RegExp): T | undefined {
  return list.find((d) => re.test(d.label)) ?? list[0];
}

export async function listMics(): Promise<CameraOption[]> {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter((d) => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

export const PREFERRED_CAMERA = /elgato|facecam/i;
export const PREFERRED_MIC = /focusrite|scarlett|clarett/i;

export interface CameraRequest {
  deviceId?: string;
  width: number;
  height: number;
  fps: number;
}

export const RESOLUTIONS: { label: string; width: number; height: number }[] = [
  { label: '640×480 (fastest)', width: 640, height: 480 },
  { label: '1280×720 (weaker PCs)', width: 1280, height: 720 },
  { label: '1920×1080 (recommended)', width: 1920, height: 1080 },
  { label: '3840×2160 (4K)', width: 3840, height: 2160 },
];

/**
 * Any-camera latency tuning. Tracking latency is dominated by the frame interval, so frame rate beats
 * resolution: if the camera can't deliver the requested fps at this resolution (many webcams do 1080p30 but
 * 720p60), step down to 720p at full fps. Then ask for ≥30 fps so drivers don't stretch exposure to 15 fps
 * in dim rooms (ignored where unsupported). Every step is best-effort: a camera that refuses keeps working.
 */
async function tuneForLatency(track: MediaStreamTrack, req: CameraRequest) {
  const fps = () => track.getSettings().frameRate ?? req.fps;
  try {
    if (fps() < req.fps * 0.8 && req.height > 720) {
      const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities;
      if ((caps.frameRate?.max ?? 0) >= req.fps * 0.95) {
        const before = track.getSettings();
        await track.applyConstraints({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: req.fps } });
        if (fps() < (before.frameRate ?? 0) + 5) await track.applyConstraints({ width: { ideal: before.width }, height: { ideal: before.height }, frameRate: { ideal: req.fps } });
        else console.info(`[camera] ${before.width}x${before.height}@${before.frameRate} → ${track.getSettings().width}x${track.getSettings().height}@${fps()} for lower latency`);
      }
    }
  } catch { /* keep what we have */ }
  try {
    const cur = track.getSettings();
    await track.applyConstraints({ width: { ideal: cur.width }, height: { ideal: cur.height }, frameRate: { min: Math.min(30, req.fps), ideal: req.fps } });
  } catch { /* camera can't guarantee a floor — fine */ }
}

export class VideoSource {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private operation = 0;
  kind: 'none' | 'camera' | 'file' = 'none';

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
  }

  /** The live camera track (null for files / when stopped). */
  get track(): MediaStreamTrack | null { return this.stream?.getVideoTracks()[0] ?? null; }

  get ready() {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  async openCamera(req: CameraRequest): Promise<{ width: number; height: number; fps: number; label: string }> {
    this.stop();
    const operation = this.operation;
    // a phone (src/mobile/cameraProfile.ts): the FRONT camera unless you picked one yourself (Android often lists the
    // back camera first), about 720p at 30 fps (face tracking needs no more; less heat and battery)
    const phone = phoneCameraRequest(req);
    if (phone) req = phone.req;
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        deviceId: req.deviceId ? { exact: req.deviceId } : undefined,
        ...(phone?.facing ? { facingMode: { ideal: 'user' } } : {}),
        width: { ideal: req.width },
        height: { ideal: req.height },
        frameRate: phone ? { ideal: 30, max: 30 } : { ideal: req.fps },
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const current = () => {
      if (operation !== this.operation) {
        stream.getTracks().forEach((t) => t.stop());
        throw new DOMException('Camera start cancelled', 'AbortError');
      }
    };
    try {
      current();
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (!phone) await tuneForLatency(track, req);
      current();
      this.video.srcObject = stream;
      await this.video.play();
      current();
      this.kind = 'camera';
      const s = track.getSettings();
      return { width: s.width ?? this.video.videoWidth, height: s.height ?? this.video.videoHeight, fps: s.frameRate ?? req.fps, label: track.label };
    } catch (e) {
      if (operation === this.operation) this.stop();
      throw e;
    }
  }

  /** Play a recorded clip as the tracking source — handy for testing and tuning without a live face. */
  async openFile(file: File) {
    this.stop();
    const operation = this.operation;
    this.video.srcObject = null;
    this.video.src = URL.createObjectURL(file);
    this.video.loop = true;
    try {
      await this.video.play();
      if (operation !== this.operation) throw new DOMException('Video start cancelled', 'AbortError');
      this.kind = 'file';
    } catch (e) {
      if (operation === this.operation) this.stop();
      throw e;
    }
  }

  stop() {
    this.operation++;
    this.video.pause();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video.src.startsWith('blob:')) URL.revokeObjectURL(this.video.src);
    this.video.removeAttribute('src');
    this.video.srcObject = null;
    this.kind = 'none';
  }
}
