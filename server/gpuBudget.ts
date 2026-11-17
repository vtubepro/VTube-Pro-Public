// How much of a 2D model's texture tier build fits this computer's free memory right now (HQ decision #10, review fix):
// a 16384 px texture is 1 GiB of pixels at full size, so the full tier is built only when the free memory (less a
// margin for the live studio) holds that picture, its halvings, the mip chain of its repacked pages, the pages waiting
// for the encoder and the encoder threads' own work memory. Otherwise the sharpest tiers are left out (the model uses
// the best tier that fits, and says so in one sentence) and the build decodes straight to the first tier it makes
// (shared/rig2d/gpu/image.ts RowShrinker: the full-size picture is then never in memory). Pure: tools/hiq_safety_unit.ts.
import { PAGE } from '../shared/rig2d/gpu/layout.ts';

const MB = 1 << 20;
/** Kept free for the studio and everything else running (the build runs beside a live show). */
export const BUILD_MARGIN = 1536 * MB;
/** One Basis encoder thread's own memory at its largest strip (12 Mi px in, UASTC + zstd work buffers: measured ~110 MB). */
const THREAD_BYTES = 160 * MB;
/** The process itself, the .vtp2 in memory, layouts, Node. */
const BASE_BYTES = 256 * MB;
/** Image data inflated whole by Node only up to this size (server/gpuTiersChild.ts); bigger pictures stream. */
const FAST_INFLATE_MAX = 256 * MB;

export interface BuildPlan {
  tiers: number[]; skipped: number[];
  threads: number; inflight: number; inflightBytes: number;
  peak: number; margin: number;
  /** one plain sentence when tiers were left out */
  note?: string;
  /** not even the smallest tier fits (less than half the margin would be left): no build now; the model keeps
   *  drawing from its original pictures, and the sentence says so */
  refuse?: string;
}

const side = (n: number, k: number) => Math.ceil(n / 2 ** k);

/** The tiers of `ks` to build with `free` bytes of free memory and up to `threads` encoder threads. */
export function buildPlan(textures: readonly { width: number; height: number; interlaced?: boolean }[], ks: readonly number[], o: { free: number; threads: number; margin?: number }): BuildPlan {
  const margin = o.margin ?? BUILD_MARGIN, avail = o.free - margin;
  const all = [...new Set(ks)].sort((a, b) => a - b);
  const page = PAGE * PAGE * 4 * 4 / 3;   // one page with its mip chain
  const peakFor = (k0: number, threads: number) => {
    // (one texture at a time: its picture at k0, its halvings, the mip chain of a tier cut into pages, the whole-buffer
    //  inflate when the image data is small enough for it)
    let pic = 0;
    for (const t of textures) {
      const w = side(t.width, k0), h = side(t.height, k0), d = w * h * 4;
      const repacked = all.filter((k) => k >= k0 && (side(t.width, k) > PAGE || side(t.height, k) > PAGE));
      const chain = repacked.length ? (side(t.width, repacked[0]) * side(t.height, repacked[0]) * 4) / 3 : 0;
      // an interlaced (Adam7) PNG is read whole at full size whatever tier it is shrunk to: its unpacked data and the
      // rebuilt picture (shared/rig2d/gpu/png.ts), so it costs that at every tier
      const raw = t.interlaced ? t.width * t.height * 4 * 2 : k0 === 0 && t.width * t.height * 4 <= FAST_INFLATE_MAX ? t.width * t.height * 4 : 0;
      pic = Math.max(pic, d * 4 / 3 + chain + raw);
    }
    // pages in flight: each page and its strips' copies (×2), at least one page
    const inflightBytes = Math.max(page * 2, Math.min(1024 * MB, Math.max(0, avail - pic - BASE_BYTES - threads * THREAD_BYTES) / 2));
    const inflight = Math.max(1, Math.min(threads * 2, Math.floor(inflightBytes / (page * 2))));
    return { peak: BASE_BYTES + pic + threads * THREAD_BYTES + inflight * page * 2, inflight, inflightBytes: inflight * page * 2 };
  };
  for (const k0 of all) {
    for (let t = Math.max(1, o.threads); t >= 1; t = t > 2 ? Math.ceil(t / 2) : t - 1) {
      const p = peakFor(k0, t);
      if (p.peak <= avail) {
        const tiers = all.filter((k) => k >= k0), skipped = all.filter((k) => k < k0);
        return { tiers, skipped, threads: t, ...p, margin, ...(skipped.length ? { note: NOTE } : {}) };
      }
    }
  }
  // nothing fits: the smallest tier alone, one thread (a phone-size picture: a few MB), unless even that would leave
  // less than half the margin free
  const k = all[all.length - 1], p = peakFor(k, 1);
  return { tiers: [k], skipped: all.slice(0, -1), threads: 1, ...p, margin, note: NOTE, ...(p.peak > o.free - margin / 2 ? { refuse: REFUSE } : {}) };
}

export const REFUSE = 'This computer is too short on free memory to make the lighter versions right now; the model keeps working from its original pictures.';
export const NOTE = 'This computer was short on free memory while making the lighter versions, so the sharpest one was left out; the model uses the next sharpest.';
