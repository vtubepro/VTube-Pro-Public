// Animated emotes on the canvas chat screens (src/chat/chatCanvas.ts: the chat monitor, the chat buddy's tablet, the
// docked chat panel). A canvas drawImage() of an animated GIF / WebP shows only its first frame, so the frames are
// decoded once with the browser's ImageDecoder (WebCodecs: Chrome / Edge / OBS's browser) into small bitmaps and the
// screen picks the frame for "now". Browsers without ImageDecoder keep the still picture (as before).
// Budget: at most 60 frames per emote at ≤ 96 px, the 40 most recently drawn emotes (~ 35 MB worst case, a few MB
// typical); decoding runs one emote at a time, off the draw path (the screen shows the still meanwhile).

interface Anim { frames: ImageBitmap[]; times: number[]; total: number; w: number; h: number; used: number }
type State = Anim | 'static' | 'loading';

const MAX_FRAMES = 60, MAX_PX = 96, MAX_ANIMS = 40;
const cache = new Map<string, State>();
const queue: string[] = [];
let busy = false;
const wakers = new Set<() => void>();

type DecoderCtor = new (o: { data: ArrayBuffer; type: string }) => {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number; animated: boolean } | null };
  decode(o: { frameIndex: number }): Promise<{ image: VideoFrame & { duration: number | null } }>;
  close(): void;
};
const Decoder = (globalThis as unknown as { ImageDecoder?: DecoderCtor }).ImageDecoder;
/** Can this browser animate emotes on the canvas screens? */
export const canAnimateEmotes = typeof Decoder === 'function' && typeof createImageBitmap === 'function';

/** Call `fn` when an animation finished decoding (the screen redraws). */
export function onEmoteAnimReady(fn: () => void): () => void { wakers.add(fn); return () => wakers.delete(fn); }

/** The frame of `src` (the proxied image URL) to draw at `now` (ms), or null = draw the still image. */
export function emoteFrame(src: string, now: number): { img: ImageBitmap; w: number; h: number } | null {
  if (!canAnimateEmotes) return null;
  const st = cache.get(src);
  if (st === undefined) { cache.set(src, 'loading'); queue.push(src); void pump(); return null; }
  if (st === 'static' || st === 'loading') return null;
  st.used = now;
  let t = now % st.total, i = 0;
  while (i < st.times.length - 1 && t >= st.times[i]) { t -= st.times[i]; i++; }
  return { img: st.frames[i], w: st.w, h: st.h };
}
/** Is `src` a decoded animation (the screen keeps redrawing while one is on it)? */
export const isAnimatedEmote = (src: string) => { const s = cache.get(src); return !!s && typeof s === 'object'; };

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const src = queue.shift()!;
      try { cache.set(src, (await decode(src)) ?? 'static'); } catch { cache.set(src, 'static'); }
      if (typeof cache.get(src) === 'object') { evict(); for (const f of wakers) try { f(); } catch { /* one screen */ } }
    }
  } finally { busy = false; }
}

async function decode(src: string): Promise<Anim | null> {
  const r = await fetch(src);
  if (!r.ok) return null;
  const type = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\/(gif|webp|png|apng|avif)$/.test(type)) return null;
  const data = await r.arrayBuffer();
  const dec = new Decoder!({ data, type });
  try {
    await dec.tracks.ready;
    const tr = dec.tracks.selectedTrack;
    if (!tr || !tr.animated || tr.frameCount <= 1) return null;
    const n = Math.min(MAX_FRAMES, tr.frameCount);
    const frames: ImageBitmap[] = [], times: number[] = [];
    let w = 0, h = 0;
    for (let i = 0; i < n; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      try {
        const k = Math.min(1, MAX_PX / Math.max(image.displayWidth, image.displayHeight));
        w = Math.max(1, Math.round(image.displayWidth * k)); h = Math.max(1, Math.round(image.displayHeight * k));
        frames.push(await createImageBitmap(image, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' }));
        // (GIF frames of 0 / 10 ms play at 100 ms in every browser)
        const ms = (image.duration ?? 0) / 1000;
        times.push(ms >= 20 ? ms : 100);
      } finally { image.close(); }
    }
    const total = times.reduce((a, b) => a + b, 0);
    return total > 0 ? { frames, times, total, w, h, used: Date.now() } : null;
  } finally { dec.close(); }
}

function evict() {
  const anims = [...cache.entries()].filter((e): e is [string, Anim] => typeof e[1] === 'object');
  if (anims.length <= MAX_ANIMS) return;
  anims.sort((a, b) => a[1].used - b[1].used);
  for (const [k, a] of anims.slice(0, anims.length - MAX_ANIMS)) { for (const f of a.frames) f.close(); cache.delete(k); }
}
