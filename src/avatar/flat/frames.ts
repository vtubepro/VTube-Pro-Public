// Picture decoding for 2D avatars: PNG / APNG / GIF / WebP / JPEG → ImageBitmap frames + durations. Animated files are
// decoded with WebCodecs' ImageDecoder (Chromium / OBS's browser source, Firefox 133+); without it (older Safari) the
// first frame is used (the picture then stands still). Big pictures are scaled down to the render height while
// decoding, and long animations are capped, so a 4K 300-frame GIF can't eat the GPU.
import { sniffImage } from '../../../shared/flatImport.ts';

export interface DecodedPicture {
  frames: ImageBitmap[];
  /** ms per frame (same length as frames). */
  durations: number[];
  /** ms for one loop (0 = a still picture). */
  total: number;
  width: number;
  height: number;
}

/** At most this many frames per picture, and this many decoded megapixels across its frames. */
export const MAX_FRAMES = 360;
const MAX_MPIX = 96;

const MIME = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpeg: 'image/jpeg' } as const;

interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number; animated: boolean } | null };
  completed: Promise<void>;
  decode(o: { frameIndex: number }): Promise<{ image: VideoFrame & { duration: number | null } }>;
  close(): void;
}
type ImageDecoderCtor = { new (o: { data: ArrayBuffer | ReadableStream; type: string }): ImageDecoderLike; isTypeSupported(t: string): Promise<boolean> };
const ImageDecoderC = (globalThis as unknown as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;
export const canDecodeAnimation = () => !!ImageDecoderC;

/** Size that fits `maxH` (never upscaled). */
function fit(w: number, h: number, maxH: number): { w: number; h: number } {
  if (h <= maxH) return { w, h };
  const k = maxH / h;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Decode a picture. `maxH`: frames taller than this are scaled down to it. */
export async function decodePicture(bytes: ArrayBuffer, maxH = 2048): Promise<DecodedPicture> {
  const fmt = sniffImage(new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength)));
  if (!fmt) throw new Error('not a PNG / GIF / WebP / JPEG picture');
  const type = MIME[fmt];
  if (ImageDecoderC && fmt !== 'jpeg') {
    let dec: ImageDecoderLike | null = null;
    try {
      if (await ImageDecoderC.isTypeSupported(type)) {
        dec = new ImageDecoderC({ data: bytes, type });
        await dec.tracks.ready;
        const tr = dec.tracks.selectedTrack;
        // (frameCount can grow while a progressive decode completes)
        await dec.completed.catch(() => {});
        const n = Math.min(MAX_FRAMES, Math.max(1, tr?.frameCount ?? 1));
        if (n > 1) {
          const frames: ImageBitmap[] = [], durations: number[] = [];
          let size: { w: number; h: number } | null = null;
          for (let i = 0; i < n; i++) {
            const r = await dec.decode({ frameIndex: i });
            const vf = r.image;
            try {
              if (!size) {
                size = fit(vf.displayWidth, vf.displayHeight, maxH);
                // many frames: shrink further so the whole animation stays within the pixel budget
                const mp = (size.w * size.h * n) / 1e6;
                if (mp > MAX_MPIX) { const k = Math.sqrt(MAX_MPIX / mp); size = { w: Math.max(1, Math.round(size.w * k)), h: Math.max(1, Math.round(size.h * k)) }; }
              }
              frames.push(await createImageBitmap(vf, { resizeWidth: size.w, resizeHeight: size.h, resizeQuality: 'high' }));
              // (browsers treat ≤ 10 ms GIF delays as 100 ms; VideoFrame.duration is µs)
              const d = (vf.duration ?? 0) / 1000;
              durations.push(d > 10 ? d : 100);
            } finally { vf.close(); }
          }
          return { frames, durations, total: durations.reduce((a, b) => a + b, 0), width: size!.w, height: size!.h };
        }
      }
    } catch (e) { console.warn('[flat] animated decode failed, using the first frame', e); }
    finally { try { dec?.close(); } catch { /* closed */ } }
  }
  const blob = new Blob([bytes], { type });
  const probe = await createImageBitmap(blob);
  const s = fit(probe.width, probe.height, maxH);
  if (s.w === probe.width && s.h === probe.height) return { frames: [probe], durations: [0], total: 0, width: s.w, height: s.h };
  probe.close();
  const bmp = await createImageBitmap(blob, { resizeWidth: s.w, resizeHeight: s.h, resizeQuality: 'high' });
  return { frames: [bmp], durations: [0], total: 0, width: s.w, height: s.h };
}

/** The frame to show at `ms` (looping). */
export function frameAt(p: DecodedPicture, ms: number): number {
  if (p.frames.length < 2 || p.total <= 0) return 0;
  let t = ((ms % p.total) + p.total) % p.total;
  for (let i = 0; i < p.durations.length; i++) { t -= p.durations[i]; if (t < 0) return i; }
  return p.frames.length - 1;
}

export function closePicture(p: DecodedPicture) { for (const f of p.frames) { try { f.close(); } catch { /* closed */ } } p.frames.length = 0; }
