// Spout2 performers (a model rendered by ANOTHER app — VSeeFace, VTube Studio, Warudo, VNyan, Animaze … — shared on
// Windows as a GPU texture WITH ALPHA) as TV-style performers in VTube Pro rooms. Pure data + math (studio, OBS pages,
// Node tests, the relay's guest page). Design + limits: docs/MULTIPLAYER_DISCORD.md → "Spout2 performers".
//
//  * native (this PC runs VTube Pro): the server's Spout receiver (server/spout.ts + tools/spout/spout_rx.py, stdlib
//    Python + Windows' own Direct3D 11 — no installs) streams the sender's RGBA over a localhost WebSocket (wire format
//    below). The studio turns it into ONE video frame that carries the alpha: premultiplied colour on the left, the
//    alpha as grey on the right ("side by side", PACK_GUTTER px apart) — so it survives every video link (loopback
//    WebRTC to the OBS pages, the party's tvLink to other PCs) and every renderer unpacks it in its shader.
//  * bridge (a browser link guest, or no helper): a Spout → webcam bridge (SpoutCam, OBS Virtual Camera) has NO alpha:
//    the app puts the model on a solid key colour and every renderer keys it (SPOUT_BRIDGE_KEY, a softer preset).
// No DOM / three.js here.
import type { TvChroma } from './tv.ts';

// ---------------------------------------------------------------- side-by-side alpha packing
/** Pixels between the colour half and the alpha half: video codecs' deblocking / chroma subsampling blur across block
 *  edges; the gutter keeps the two halves from bleeding into each other (≥ 3 px survive a 0.5× downscale). */
export const PACK_GUTTER = 16;
/** A packed frame: colour in u ∈ [0, c), alpha in u ∈ [a, 1] (both the same width). Fractions of the frame width, so a
 *  downscaled copy (the host's forwards) unpacks the same. */
export interface TvPack { l: 'sbs'; c: number; a: number }

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
/** The packed frame for a w×h picture: frame size + the TvPack fractions. */
export function packLayout(w: number, h: number): { fw: number; fh: number; cw: number; ax: number; pack: TvPack } {
  const cw = even(w), fh = even(h);
  const fw = cw * 2 + PACK_GUTTER;
  return { fw, fh, cw, ax: cw + PACK_GUTTER, pack: { l: 'sbs', c: cw / fw, a: (cw + PACK_GUTTER) / fw } };
}
/** The picture aspect (colour half) of a packed frame of aspect `frameAspect`. */
export const packedAspect = (frameAspect: number, p: TvPack) => frameAspect * p.c;
/** Anything → a TvPack (or null). The alpha half must be as wide as the colour half and sit to its right. */
export function sanitizePack(v: unknown): TvPack | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const c = typeof o.c === 'number' && Number.isFinite(o.c) ? o.c : NaN, a = typeof o.a === 'number' && Number.isFinite(o.a) ? o.a : NaN;
  if (o.l !== 'sbs' || !(c > 0.3 && c < 0.5) || !(a >= c && a < 0.7) || Math.abs(1 - a - c) > 0.02) return null;
  return { l: 'sbs', c: Math.round(c * 1e5) / 1e5, a: Math.round(a * 1e5) / 1e5 };
}

// ---------------------------------------------------------------- the math every renderer does (GLSL mirrors this)
/** Codec noise lifts alpha 0 to a few levels and pulls 1 down: remap [lo, hi] → [0, 1] (8-bit: 6 … 249). */
export const ALPHA_LO = 6 / 255, ALPHA_HI = 249 / 255;
export const alphaRemap = (v: number, lo = ALPHA_LO, hi = ALPHA_HI) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
/** A premultiplied colour channel can never exceed its alpha: clamping kills codec noise in the transparent area
 *  (no haze) and any colour bleed at the edges (no fringe). Linear values. */
export const premulClamp = (c: number, a: number) => Math.min(Math.max(c, 0), a);
/** Premultiplied "over": what the TV / projector screen shows (the picture over its backdrop). Linear values. */
export const over = (premul: number, a: number, bg: number) => premul + bg * (1 - a);
/** sRGB transfer (IEC 61966-2-1), for tests and the CPU side. */
export const srgbToLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const linToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
/** What the packer writes for one straight-alpha sRGB pixel: premultiply in LINEAR light, then encode (so the receiver's
 *  decode gives back exactly colour × alpha). `premultiplied` = the sender already did it (encoded values ≤ alpha). */
export function packPixel(r: number, g: number, b: number, a: number, premultiplied: boolean): [number, number, number, number] {
  const f = (v: number) => (premultiplied ? Math.min(v, a) : linToSrgb(srgbToLin(v) * a));
  return [f(r), f(g), f(b), a];
}
/** Receiver side for one pixel: packed colour (sRGB 0..1) + packed alpha (0..1, raw) → linear premultiplied colour +
 *  alpha. The colour was premultiplied by the RAW alpha: it is rescaled by the same factor as the remapped alpha, then
 *  clamped ≤ alpha. */
export function unpack(rgb: [number, number, number], aRaw: number): { c: [number, number, number]; a: number } {
  const a = alphaRemap(aRaw);
  const k = aRaw > 1e-4 ? a / aRaw : 0;
  return { c: rgb.map((v) => premulClamp(srgbToLin(v) * k, a)) as [number, number, number], a };
}
/** … composited over a linear backdrop (what the TV / projector screen shows). */
export function unpackOver(rgb: [number, number, number], aRaw: number, bg: [number, number, number]): [number, number, number] {
  const u = unpack(rgb, aRaw);
  return u.c.map((v, i) => over(v, u.a, bg[i])) as [number, number, number];
}

// ---------------------------------------------------------------- what the sender app gives us
export type AlphaMode = 'straight' | 'premultiplied' | 'opaque' | 'empty';
/** Guess how the sender stored its alpha from a frame (RGBA or BGRA bytes — the test is channel-order free):
 *  opaque = every alpha 255 (transparency is off in the app); empty = nothing visible; premultiplied = every colour
 *  channel ≤ its alpha (+2 for rounding); straight = otherwise (most Unity apps: full colour on soft edges, and often
 *  garbage colour under alpha 0 — the classic green / black fringe when it's filtered without premultiplying). */
export function detectAlphaMode(px: Uint8Array | Uint8ClampedArray, w: number, h: number, step = 3): { mode: AlphaMode; coverage: number; partial: number } {
  let seen = 0, solid = 0, partial = 0, visible = 0, bad = 0, zeroColour = 0;
  const sx = Math.max(1, step | 0);
  for (let y = 0; y < h; y += sx) {
    let i = y * w * 4;
    for (let x = 0; x < w; x += sx, i += sx * 4) {
      const a = px[i + 3];
      seen++;
      if (a === 255) { solid++; visible++; continue; }
      const m = Math.max(px[i], px[i + 1], px[i + 2]);
      if (a > 0) { partial++; visible++; }
      if (m > a + 2) { bad++; if (a === 0) zeroColour++; }
    }
  }
  const coverage = seen ? visible / seen : 0;
  if (seen && solid === seen) return { mode: 'opaque', coverage: 1, partial: 0 };
  if (!visible) return { mode: 'empty', coverage: 0, partial: 0 };
  // colour under alpha 0 or brighter-than-alpha edges on more than a sliver of the non-solid pixels: straight alpha
  const nonSolid = seen - solid;
  const mode: AlphaMode = bad > Math.max(2, nonSolid * 0.01) || zeroColour > 2 ? 'straight' : 'premultiplied';
  return { mode, coverage, partial: seen ? partial / seen : 0 };
}

/** Bounding box (pixels, x1 / y1 exclusive) of everything with alpha > thr, sampled every `step` px; null = empty. */
export function alphaBox(px: Uint8Array | Uint8ClampedArray, w: number, h: number, thr = 8, step = 2): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const s = Math.max(1, step | 0);
  for (let y = 0; y < h; y += s) {
    const row = y * w * 4;
    for (let x = 0; x < w; x += s) {
      if (px[row + x * 4 + 3] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1: Math.min(w, x1 + s), y1: Math.min(h, y1 + s) };
}

/** Auto-framing to the model: a crop that follows the model's alpha box without breathing. Grows at once (a raised arm
 *  is never cut off), shrinks only after the model stayed smaller for `holdMs`, snaps to a 16 px grid with a margin —
 *  so the sent picture (and the standee's size) changes rarely. */
export class ModelFramer {
  box: { x: number; y: number; w: number; h: number } | null = null;
  private smallerSince = 0;
  constructor(public margin = 0.04, public holdMs = 1500, public grid = 16) {}
  update(b: { x0: number; y0: number; x1: number; y1: number } | null, w: number, h: number, now: number): { x: number; y: number; w: number; h: number } {
    const full = { x: 0, y: 0, w: even(w), h: even(h) };
    if (!b) { this.smallerSince = 0; return this.box ?? full; }
    const m = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * this.margin) + 2;
    const g = this.grid;
    const want = { x0: Math.max(0, Math.floor((b.x0 - m) / g) * g), y0: Math.max(0, Math.floor((b.y0 - m) / g) * g), x1: Math.min(w, Math.ceil((b.x1 + m) / g) * g), y1: Math.min(h, Math.ceil((b.y1 + m) / g) * g) };
    const cur = this.box;
    const toBox = (r: typeof want) => ({ x: r.x0 & ~1, y: r.y0 & ~1, w: even(r.x1 - (r.x0 & ~1)), h: even(r.y1 - (r.y0 & ~1)) });
    const clampBox = (r: { x: number; y: number; w: number; h: number }) => ({ x: Math.min(r.x, Math.max(0, even(w) - r.w)), y: Math.min(r.y, Math.max(0, even(h) - r.h)), w: Math.min(r.w, even(w)), h: Math.min(r.h, even(h)) });
    if (!cur) { this.box = clampBox(toBox(want)); return this.box; }
    const c = { x0: cur.x, y0: cur.y, x1: cur.x + cur.w, y1: cur.y + cur.h };
    const outside = want.x0 < c.x0 || want.y0 < c.y0 || want.x1 > c.x1 || want.y1 > c.y1;
    if (outside) {
      // grow (union): never cut the model
      this.box = clampBox(toBox({ x0: Math.min(want.x0, c.x0), y0: Math.min(want.y0, c.y0), x1: Math.max(want.x1, c.x1), y1: Math.max(want.y1, c.y1) }));
      this.smallerSince = 0;
      return this.box;
    }
    // inside: shrink only when clearly smaller (> 12 % of the area) for holdMs
    const area = (r: typeof want) => (r.x1 - r.x0) * (r.y1 - r.y0);
    if (area(want) < area(c) * 0.88) {
      if (!this.smallerSince) this.smallerSince = now;
      else if (now - this.smallerSince > this.holdMs) { this.box = clampBox(toBox(want)); this.smallerSince = 0; }
    } else this.smallerSince = 0;
    return this.box!;
  }
}

// ---------------------------------------------------------------- the server → studio wire (ws /ws/spout)
// ---------------------------------------------------------------- what the packer uploads to the GPU
/** The part of the frame the packer can read: the crop clipped to the frame (w = 0 when nothing is left). Only this is
 *  uploaded; the shader clamps every fetch into the crop, so texels outside it are never read. */
export function uploadRect(crop: { x: number; y: number; w: number; h: number }, w: number, h: number): { x: number; y: number; w: number; h: number } {
  // (the shader clamps to ivec2(crop.xy) .. ivec2(crop.xy + crop.wh) - 1, i.e. floor, so floor here too)
  const x0 = Math.max(0, Math.floor(crop.x)), y0 = Math.max(0, Math.floor(crop.y)), x1 = Math.min(w, Math.floor(crop.x + crop.w)), y1 = Math.min(h, Math.floor(crop.y + crop.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}
/** Texture size to hold an upload of `need`: kept while it still fits and is not more than ~2x too big, else rounded up
 *  to 128 px (never above the frame), so a crop that wobbles by a few px does not reallocate the texture every frame. */
export function texCapacity(cur: { w: number; h: number }, need: { w: number; h: number }, frame: { w: number; h: number }): { w: number; h: number } {
  const fits = need.w <= cur.w && need.h <= cur.h && cur.w <= 2 * need.w + 128 && cur.h <= 2 * need.h + 128 && cur.w <= frame.w && cur.h <= frame.h;
  if (fits) return cur;
  return { w: Math.min(frame.w, Math.max(1, Math.ceil(need.w / 128) * 128)), h: Math.min(frame.h, Math.max(1, Math.ceil(need.h / 128) * 128)) };
}

/** Binary frame: 32-byte little-endian header + w×h×4 bytes (rows packed, top row first). */
export const SPOUT_MAGIC = 0x31505356;      // 'VSP1'
export const SPOUT_HEADER = 32;
/** Pixel order of a frame: 0 RGBA, 1 BGRA, 2 BGRX (no alpha: treat as opaque). */
export type SpoutFmt = 0 | 1 | 2;
export interface SpoutFrameHead { w: number; h: number; fmt: SpoutFmt; seq: number; senderFrame: number; senderFps: number; flags: number }
export function writeSpoutHead(dv: DataView, f: SpoutFrameHead) {
  dv.setUint32(0, SPOUT_MAGIC, true); dv.setUint32(4, f.w, true); dv.setUint32(8, f.h, true); dv.setUint32(12, f.fmt, true);
  dv.setUint32(16, f.seq >>> 0, true); dv.setUint32(20, f.senderFrame >>> 0, true); dv.setUint32(24, Math.round(f.senderFps * 100), true); dv.setUint32(28, f.flags, true);
}
/** A binary message → its header + pixels (null = not a valid frame). */
export function parseSpoutFrame(buf: ArrayBuffer | Uint8Array): { head: SpoutFrameHead; px: Uint8Array } | null {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < SPOUT_HEADER) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== SPOUT_MAGIC) return null;
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true), fmt = dv.getUint32(12, true);
  if (!w || !h || w > 8192 || h > 8192 || fmt > 2 || u8.byteLength < SPOUT_HEADER + w * h * 4) return null;
  return {
    head: { w, h, fmt: fmt as SpoutFmt, seq: dv.getUint32(16, true), senderFrame: dv.getUint32(20, true), senderFps: dv.getUint32(24, true) / 100, flags: dv.getUint32(28, true) },
    px: u8.subarray(SPOUT_HEADER, SPOUT_HEADER + w * h * 4),
  };
}

/** One Spout sender as the server lists it. */
export interface SpoutSender { name: string; w: number; h: number; format: number; ok: boolean; why?: string; app?: string }
/** GET /api/spout: is the receiver available here, and who is sending. */
export interface SpoutStatus {
  available: boolean;
  /** Why not (no Windows / no Python / helper missing / D3D11 failed …) + what to do. */
  reason?: string;
  python?: string;
  senders: SpoutSender[];
  /** Senders being received right now (name → fps actually delivered, clients). */
  active: { name: string; fps: number; clients: number; w: number; h: number; error?: string }[];
}
/** Text messages on /ws/spout (server → studio). */
export type SpoutMsg = { type: 'status'; state: 'waiting' | 'live' | 'lost' | 'error'; sender: string; w?: number; h?: number; format?: number; error?: string };

/** DXGI formats the receiver can read (8-bit per channel). Others (16-bit float HDR, 10-bit) are reported, not shown. */
export const DXGI_OK: Record<number, { fmt: SpoutFmt; name: string }> = {
  27: { fmt: 0, name: 'R8G8B8A8_TYPELESS' }, 90: { fmt: 1, name: 'B8G8R8A8_TYPELESS' }, 92: { fmt: 2, name: 'B8G8R8X8_TYPELESS' },
  28: { fmt: 0, name: 'R8G8B8A8_UNORM' }, 29: { fmt: 0, name: 'R8G8B8A8_UNORM_SRGB' },
  87: { fmt: 1, name: 'B8G8R8A8_UNORM' }, 91: { fmt: 1, name: 'B8G8R8A8_UNORM_SRGB' },
  88: { fmt: 2, name: 'B8G8R8X8_UNORM' }, 93: { fmt: 2, name: 'B8G8R8X8_UNORM_SRGB' },
  0: { fmt: 1, name: 'unknown (assumed BGRA)' },
};
export const spoutFormatOk = (f: number) => f in DXGI_OK;

// ---------------------------------------------------------------- bridges (no alpha): cameras + key presets
export type CamClass = 'spoutcam' | 'obs' | 'vtscam' | 'ndi' | 'virtual' | 'camera';
/** What a camera device label is (labels only — never opens a stream). */
export function classifyCamera(label: string): CamClass {
  const l = label.toLowerCase();
  if (/spout\s*cam|spoutcam/.test(l)) return 'spoutcam';
  if (/obs[\s-]*(virtual\s*camera|camera)|obs-camera/.test(l)) return 'obs';
  if (/vtube\s*studio|vtubestudiocam/.test(l)) return 'vtscam';
  if (/\bndi\b/.test(l)) return 'ndi';
  if (/virtual|snap camera|xsplit|droidcam|nvidia broadcast|unity video capture|warudo|vseeface|vnyan|animaze/.test(l)) return 'virtual';
  return 'camera';
}
/** Is this camera a Spout → webcam bridge (the ones the Spout2 setup recommends)? */
export const isSpoutBridge = (label: string) => { const c = classifyCamera(label); return c === 'spoutcam' || c === 'obs'; };

/** The key for a model that comes through a bridge on a solid colour: a bit softer + stronger spill removal than the
 *  VTube Studio preset — the picture has been through a webcam driver and a video codec (softer, noisier edges). */
export const SPOUT_BRIDGE_KEY: Record<'green' | 'magenta' | 'blue', TvChroma> = {
  green: { color: [0, 1, 0], similarity: 0.3, smoothness: 0.1, spill: 0.75 },
  magenta: { color: [1, 0, 1], similarity: 0.28, smoothness: 0.1, spill: 0.6 },
  blue: { color: [0, 0, 1], similarity: 0.3, smoothness: 0.1, spill: 0.7 },
};

/** Where each app hides its "Spout2 output" and its "solid background colour" (the guest page + the setup show these,
 *  as "In <name>: <spout>." / "In <name>: <colour>."). Menu names follow each app's docs / UI as of 2026; apps rename
 *  things — the wording says what to look for. */
export interface SpoutApp { id: string; name: string; spout: string; colour: string }
export const SPOUT_APPS: readonly SpoutApp[] = [
  { id: 'vseeface', name: 'VSeeFace', spout: 'General settings → turn on “Spout2 output”, and tick “Transparent background” (the alpha)', colour: 'untick “Transparent background” and set the background colour (bottom-right colour button) to pure green (0, 255, 0)' },
  { id: 'vtubestudio', name: 'VTube Studio', spout: 'Settings (gear) → Spout2 → activate the Spout2 output, with a transparent background', colour: 'Background → “Color Picker Background” → pure green (0, 255, 0), with “Transparent in capture / OBS” off' },
  { id: 'warudo', name: 'Warudo', spout: 'your Camera asset → Output → enable Spout output (transparent background on)', colour: 'your Camera asset → Background → Color → pure green (0, 255, 0)' },
  { id: 'vnyan', name: 'VNyan', spout: 'Settings → Output → enable Spout2 (transparent background)', colour: 'Settings → set the background colour to pure green (0, 255, 0)' },
  { id: 'animaze', name: 'Animaze', spout: 'Settings → enable the Spout2 / “Virtual camera: Spout” output with a transparent background', colour: 'Backgrounds → a solid pure-green colour' },
  { id: 'other', name: 'your app', spout: 'turn on its Spout2 (“Spout output”) with a transparent background', colour: 'set a solid pure-green (0, 255, 0) background' },
];
/** A short app label from a Spout sender name ("VSeeFace", "VTubeStudioSpout" …); '' = unknown. */
export function guessApp(sender: string): string {
  const s = sender.toLowerCase();
  if (/vseeface/.test(s)) return 'VSeeFace';
  if (/vtube\s*studio|vtubestudio/.test(s)) return 'VTube Studio';
  if (/warudo/.test(s)) return 'Warudo';
  if (/vnyan/.test(s)) return 'VNyan';
  if (/animaze/.test(s)) return 'Animaze';
  if (/obs/.test(s)) return 'OBS';
  return '';
}

/** Health line for UIs: "Spout2 · alpha · 30 fps" (fps 0 = unknown). */
export function spoutHealth(o: { native: boolean; alpha: boolean; fps?: number }): string {
  return `Spout2${o.native ? '' : ' via webcam bridge'} · ${o.alpha ? 'real alpha' : 'colour key'}${o.fps ? ` · ${Math.round(o.fps)} fps` : ''}`;
}
