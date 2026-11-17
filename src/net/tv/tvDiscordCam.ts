// guestlink — "Use their Discord camera instead": the HOST captures the Discord call window (one window share), drags a
// crop box over each guest's video tile, names it, and that tile becomes a local projector / TV guest in the scene —
// exactly like a remote TV guest (same TvInfo, same OBS-page feed path src/net/tv/tvLocal.ts), with no action from the
// guest. Live only: frames exist in this studio tab and the OBS pages' WebRTC stacks — never recorded, never on disk.
// Crops are remembered per window size (localStorage), so the same call layout comes back ready.
import type { TvInfo } from '../../../shared/tv.ts';
import type { LocalFeed } from './tvLocal.ts';

/** Crop in fractions of the window: x, y, w, h. */
export type CamRect = [number, number, number, number];
export interface CamGuest { id: string; name: string; rect: CamRect; out: MediaStream; aspect: number; look: 'projector' | 'tv'; stop: () => void }

const KEY = 'vtp.gl.crops';
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const clampRect = (r: CamRect): CamRect => {
  const x = Math.min(0.98, Math.max(0, r[0])), y = Math.min(0.98, Math.max(0, r[1]));
  return [x, y, Math.max(0.02, Math.min(1 - x, r[2])), Math.max(0.02, Math.min(1 - y, r[3]))];
};

export class DiscordCams {
  /** The shared Discord call window (null = none picked). */
  window: MediaStream | null = null;
  label = '';
  error = '';
  readonly list: CamGuest[] = [];
  onChange: () => void = () => {};
  private n = 0;

  /** Window size key for the remembered crops. */
  get sizeKey(): string { const s = this.window?.getVideoTracks()[0]?.getSettings(); return s?.width && s.height ? `${s.width}x${s.height}` : ''; }

  /** Ask for the Discord call window (must come from a click). */
  async pickWindow(): Promise<boolean> {
    this.error = '';
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false } as DisplayMediaStreamOptions);
      this.stopWindow();
      this.window = s;
      const tr = s.getVideoTracks()[0];
      try { tr.contentHint = 'motion'; } catch { /* */ }
      this.label = tr.label || 'a window';
      tr.addEventListener('ended', () => { if (this.window === s) { this.error = 'The shared window was closed'; this.stopWindow(); this.onChange(); } });
      // re-crop the guests we already had from the new window
      for (const g of this.list) this.rebuild(g);
      this.onChange();
      return true;
    } catch (e) {
      this.error = (e as Error).name === 'NotAllowedError' ? 'Window sharing was cancelled' : `Couldn’t share the window: ${(e as Error).message}`;
      this.onChange();
      return false;
    }
  }

  /** Crops remembered for this window size. */
  saved(): { name: string; rect: CamRect }[] {
    try { const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, { name: string; rect: CamRect }[]>; return (all[this.sizeKey] ?? []).slice(0, 8); } catch { return []; }
  }
  private save() {
    const k = this.sizeKey;
    if (!k) return;
    try {
      const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
      all[k] = this.list.map((g) => ({ name: g.name, rect: g.rect }));
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch { /* storage off */ }
  }

  add(name: string, rect: CamRect, look: 'projector' | 'tv' = 'projector'): CamGuest | null {
    if (!this.window || this.list.length >= 4) return null;
    const g: CamGuest = { id: `dcam${++this.n}${Math.random().toString(36).slice(2, 6)}`, name: name.trim().slice(0, 32) || `Guest ${this.list.length + 1}`, rect: clampRect(rect), out: new MediaStream(), aspect: 16 / 9, look, stop: () => {} };
    this.rebuild(g);
    this.list.push(g);
    this.save();
    this.onChange();
    return g;
  }
  update(id: string, patch: Partial<Pick<CamGuest, 'name' | 'rect' | 'look'>>) {
    const g = this.list.find((x) => x.id === id);
    if (!g) return;
    if (patch.name !== undefined) g.name = patch.name.trim().slice(0, 32) || g.name;
    if (patch.look) g.look = patch.look;
    if (patch.rect) g.rect = clampRect(patch.rect);   // the crop pipeline reads g.rect every frame
    this.save();
    this.onChange();
  }
  remove(id: string) {
    const i = this.list.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.list[i].stop();
    this.list.splice(i, 1);
    this.save();
    this.onChange();
  }
  stopAll() { for (const g of this.list) g.stop(); this.list.length = 0; this.stopWindow(); this.onChange(); }
  private stopWindow() { this.window?.getTracks().forEach((t) => t.stop()); this.window = null; this.label = ''; }

  /** The cropped track for one guest: VideoFrame views of the rect (zero copy), else a canvas on a timer. */
  private rebuild(g: CamGuest) {
    g.stop();
    const tr = this.window?.getVideoTracks()[0];
    if (!tr) return;
    const W = window as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }; MediaStreamTrackGenerator?: new (o: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> } };
    if (W.MediaStreamTrackProcessor && W.MediaStreamTrackGenerator) {
      const proc = new W.MediaStreamTrackProcessor({ track: tr.clone() });
      const gen = new W.MediaStreamTrackGenerator({ kind: 'video' });
      let stop = false;
      const ts = new TransformStream<VideoFrame, VideoFrame>({
        transform(frame, ctl) {
          if (stop) { frame.close(); return; }
          const vr = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
          const [fx, fy, fw, fh] = g.rect;
          const cx = even(vr.x + fx * vr.width), cy = even(vr.y + fy * vr.height);
          const cw = Math.min(even(fw * vr.width), even(vr.x + vr.width - cx)), ch = Math.min(even(fh * vr.height), even(vr.y + vr.height - cy));
          g.aspect = (fw * frame.displayWidth) / Math.max(1, fh * frame.displayHeight);
          try { ctl.enqueue(new VideoFrame(frame, { visibleRect: { x: cx, y: cy, width: cw, height: ch }, displayWidth: cw, displayHeight: ch })); } catch { /* odd size */ }
          frame.close();
        },
      });
      void proc.readable.pipeThrough(ts).pipeTo(gen.writable).catch(() => {});
      g.out = new MediaStream([gen]);
      g.stop = () => { stop = true; try { gen.stop(); } catch { /* */ } };
      return;
    }
    const v = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true, srcObject: this.window });
    void v.play().catch(() => {});
    const cv = document.createElement('canvas');
    const c2 = cv.getContext('2d', { alpha: false })!;
    const cap = cv.captureStream(30);
    const t = window.setInterval(() => {
      if (v.readyState < 2) return;
      const [fx, fy, fw, fh] = g.rect;
      const sw = fw * v.videoWidth, sh = fh * v.videoHeight;
      const oh = Math.min(720, Math.round(sh)), ow = Math.round(oh * (sw / Math.max(1, sh)));
      if (cv.width !== ow || cv.height !== oh) { cv.width = ow; cv.height = oh; }
      c2.drawImage(v, fx * v.videoWidth, fy * v.videoHeight, sw, sh, 0, 0, ow, oh);
      g.aspect = ow / Math.max(1, oh);
    }, 33);
    g.out = cap;
    g.stop = () => { clearInterval(t); cap.getTracks().forEach((x) => x.stop()); v.srcObject = null; };
  }

  /** What these guests announce (a TV guest's TvInfo: webcam picture, projector screen by default). */
  info(g: CamGuest): TvInfo {
    return { v: 1, kind: 'webcam', skin: 'retro80', height: 1.3, aspect: Math.round(Math.min(3, Math.max(0.4, g.aspect)) * 1000) / 1000, mirror: false, chroma: null, bg: 'studio', fit: 'cover', look: g.look, motion: 'calm' };
  }
  /** Feeds for this PC's OBS pages. */
  feeds(): LocalFeed[] {
    const out: LocalFeed[] = [];
    for (const g of this.list) { const tr = g.out.getVideoTracks()[0]; if (tr && tr.readyState === 'live') out.push({ id: g.id, stream: g.out, track: tr, level: 0 }); }
    return out;
  }
}
