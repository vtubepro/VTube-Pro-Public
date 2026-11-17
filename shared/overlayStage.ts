// 2.5D overlays: a stack of flat layers AROUND a 2D avatar shown "flat over the stream" (layering only: scenery and a
// room behind the performer, a desk / plants / a frame in front of them), the way VTubers build their scene in OBS:
// background picture, the VTube Studio capture, the desk on top. Each layer has a depth, so the stack moves like a real
// space (motion parallax pivoting on the performer) when the performer's head moves, plus a slow idle drift; engine-drawn
// effects (fireflies, motes, rain, snow, fog, light rays) add life. A creator's existing overlay just works: loose
// pictures / animated GIF / WebM, a layered PSD, an OBS scene collection export (+ its pictures) or a .zip of any of
// those become one overlay (src/avatar/flat/overlayImport.ts plans it in the browser with the pure rules below).
//
// On disk (the helper's data folder `overlays/<id>/`, shipped samples in `assets/overlays/<id>/`): `overlay.json`
// (OverlayConfig, the format below) + the layer files. Selected per avatar: profile.flat.display.overlay.stage = <id>.
// Drawn by src/avatar/flat/overlayStage.ts. Served by server/routes/overlayStages.ts. Docs: docs/OVERLAYS_2D.md.
// Pure (tests: tools/overlay_stage_unit.ts).

/** The config file name inside an overlay folder / zip, and the format tag inside it (one place to rename). */
export const OVERLAY_FILE = 'overlay.json';
export const OVERLAY_FORMAT = 'vtp-overlay';
export const OVERLAY_VERSION = 1;
/** The performer's plane: metres from the virtual viewer. Layers deeper than this are behind them, nearer in front. */
export const AVATAR_DEPTH = 2.5;
/** Default depth per side (metres). */
export const BACK_DEPTH = 8, FRONT_DEPTH = 1.6;
/** The usual stream canvas. */
export const DEFAULT_CANVAS: [number, number] = [1920, 1080];
/** Pictures and videos an overlay layer can show (extension → content type). */
export const OVERLAY_MEDIA: Record<string, string> = {
  '.png': 'image/png', '.apng': 'image/apng', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};
export const OVERLAY_ACCEPT = '.zip,.psd,.psb,.json,' + Object.keys(OVERLAY_MEDIA).join(',');
/** Limits: layers per overlay, bytes per file, bytes per overlay. */
export const OVERLAY_LIMITS = { layers: 40, file: 200 << 20, total: 600 << 20 };

export type OverlaySide = 'back' | 'front';
export type OverlayBlend = 'normal' | 'screen' | 'multiply' | 'add' | 'overlay' | 'soft-light';
export const OVERLAY_BLENDS: readonly OverlayBlend[] = ['normal', 'screen', 'multiply', 'add', 'overlay', 'soft-light'];
/** Engine-drawn effects (no pictures needed). */
export type OverlayFxKind = 'fireflies' | 'motes' | 'embers' | 'rain' | 'snow' | 'fog' | 'rays' | 'bubbles';
export const OVERLAY_FX: readonly OverlayFxKind[] = ['fireflies', 'motes', 'embers', 'rain', 'snow', 'fog', 'rays', 'bubbles'];
export interface OverlayFx {
  kind: OverlayFxKind;
  /** '#rrggbb' */
  color: string;
  /** 0..1 how much of it (particle count / fog thickness / ray strength). */
  amount: number;
  /** Size multiplier 0.2..4 (1 = the kind's natural size). */
  size?: number;
  /** Speed multiplier 0..4. */
  speed?: number;
  seed?: number;
}

export interface OverlayLayer {
  /** Stable id inside the overlay ([a-z0-9_-]). */
  id: string;
  /** What the creator called it (shown in the studio). */
  name: string;
  /** A picture (PNG / APNG / GIF / WebP / JPEG, animated ones play) or a video (WebM with alpha / MP4, always muted, looped). */
  file?: string;
  /** A solid colour panel (OBS colour sources) ... */
  color?: string;
  /** ... or an engine-drawn effect. Exactly one of file / color / fx. */
  fx?: OverlayFx;
  /** Behind the performer or in front of them. Order inside a side = the array order (first = farthest back). */
  side: OverlaySide;
  /** Place on the overlay canvas, canvas pixels [x, y, w, h]; missing = the whole canvas. */
  rect?: [number, number, number, number];
  /** Metres from the viewer (the performer stands at AVATAR_DEPTH = 2.5). Far = small parallax, near = big. */
  depth: number;
  /** Screen-locked: never moves (a stream frame, a logo, a chat box). */
  pin?: boolean;
  opacity?: number;
  blend?: OverlayBlend;
  /** Mirror the picture. */
  flip?: boolean;
  /** Clockwise rotation in degrees (OBS items can be rotated). */
  rot?: number;
  /** 0..1 a gentle wind sway of the layer (hanging moss, plants, lanterns), pivoting on its top or bottom edge. */
  sway?: number;
  /** Which edge the sway pivots on: 'bottom' (plants growing up, default) or 'top' (hanging things). */
  pivot?: 'top' | 'bottom';
  /** 0..1 slow up/down float (a floating island, a boat on water). */
  bob?: number;
  /** 0..1 light flicker (candles, lanterns, a screen glow). */
  flicker?: number;
  /** 0..1 slow breathing glow (pulsing light) — brightness up and down. */
  pulse?: number;
  /** Starts hidden (a creator's spare layer; the studio can switch it on). */
  hidden?: boolean;
}

export interface OverlayAvatarPlace {
  /** Same meaning as FlatOverlayDisplay: the corner the performer hangs from, offsets as fractions of the output. */
  anchor: 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';
  x: number;
  y: number;
  /** Performer's picture height as a fraction of the output height. */
  scale: number;
}

export interface OverlayConfig {
  format: typeof OVERLAY_FORMAT;
  v: number;
  name: string;
  /** The overlay's design size (px): the layer rects are in these pixels. */
  canvas: [number, number];
  /** How the canvas fills an output of another shape: 'cover' (fills it, crops the edges) or 'contain' (whole canvas). */
  fit: 'cover' | 'contain';
  /** Where the performer goes in this overlay (set when it is picked; the performer can move it after). */
  avatar?: OverlayAvatarPlace;
  /** 0..2 how strongly the layers follow the performer's head (motion parallax). 1 = natural, 0 = still. */
  parallax: number;
  /** 0..1 slow idle drift (parallax even when the performer holds still). */
  drift: number;
  /** Colour wash on the performer to sit them in the scene's light: colour + strength 0..1 (missing = none). */
  light?: { color: string; strength: number };
  layers: OverlayLayer[];
  /** Who made it / the art licence (shown in the studio). */
  credits?: string;
}

// ---------------------------------------------------------------- sanitising
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z0-9_-]{1,40}$/;
const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const col = (v: unknown): string | null => (typeof v === 'string' && COLOR.test(v) ? v.toLowerCase() : null);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max) : '');
/** A file inside the overlay folder: relative, forward slashes, no '..' / dot parts / drive letters, a media extension. */
export function overlayRel(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > 200) return null;
  const s = v.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || /[\x00-\x1f<>:"|?*]/.test(s)) return null;
  if (s.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
  return overlayMediaType(s) ? s : null;
}
export const overlayExt = (p: string) => { const m = /\.[^./]+$/.exec(p.toLowerCase()); return m ? m[0] : ''; };
export const overlayMediaType = (p: string): string | null => OVERLAY_MEDIA[overlayExt(p)] ?? null;
export const isOverlayVideo = (p: string) => /^video\//.test(overlayMediaType(p) ?? '');
/** Overlay ids: user overlays are slugs; shipped samples too (no collisions: user ids get a random suffix). */
export const OVERLAY_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const slugId = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'overlay';

function sanitizeFx(v: unknown): OverlayFx | null {
  const o = obj(v);
  if (!o || !OVERLAY_FX.includes(o.kind as OverlayFxKind)) return null;
  const fx: OverlayFx = { kind: o.kind as OverlayFxKind, color: col(o.color) ?? FX_DEFAULT_COLOR[o.kind as OverlayFxKind], amount: num(o.amount, 0, 1, 0.5) };
  if (typeof o.size === 'number') fx.size = num(o.size, 0.2, 4, 1);
  if (typeof o.speed === 'number') fx.speed = num(o.speed, 0, 4, 1);
  if (typeof o.seed === 'number') fx.seed = Math.round(num(o.seed, 0, 1e6, 1));
  return fx;
}
export const FX_DEFAULT_COLOR: Record<OverlayFxKind, string> = {
  fireflies: '#d8ff7a', motes: '#fff3c8', embers: '#ff9a3c', rain: '#b8c8dc', snow: '#ffffff', fog: '#c8d4cc', rays: '#fff2c0', bubbles: '#cfeee6',
};

/** A clean OverlayConfig, or null when `v` isn't one. Unknown keys are dropped; numbers are clamped. */
export function sanitizeOverlay(v: unknown): OverlayConfig | null {
  const b = obj(v);
  if (!b || (b.format !== undefined && b.format !== OVERLAY_FORMAT)) return null;
  const cv = Array.isArray(b.canvas) && b.canvas.length === 2 ? b.canvas : DEFAULT_CANVAS;
  const canvas: [number, number] = [Math.round(num(cv[0], 64, 16384, 1920)), Math.round(num(cv[1], 64, 16384, 1080))];
  const layers: OverlayLayer[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(b.layers) ? b.layers.slice(0, OVERLAY_LIMITS.layers) : []) {
    const o = obj(raw);
    if (!o) continue;
    const side: OverlaySide = o.side === 'front' ? 'front' : 'back';
    const file = overlayRel(o.file), color = col(o.color), fx = file || color ? null : sanitizeFx(o.fx);
    if (!file && !color && !fx) continue;
    let id = typeof o.id === 'string' && ID.test(o.id) ? o.id : `layer_${layers.length + 1}`;
    while (ids.has(id)) id = `${id}_${layers.length + 1}`.slice(0, 40);
    ids.add(id);
    const l: OverlayLayer = { id, name: str(o.name, 60) || id, side, depth: num(o.depth, 0.3, 1000, side === 'back' ? BACK_DEPTH : FRONT_DEPTH) };
    if (file) l.file = file; else if (color) l.color = color; else l.fx = fx!;
    // (a back layer can't be in front of the performer, nor a front one behind them: the side decides the drawing order)
    if (side === 'back' && l.depth < AVATAR_DEPTH) l.depth = AVATAR_DEPTH;
    if (side === 'front' && l.depth > AVATAR_DEPTH) l.depth = AVATAR_DEPTH;
    if (Array.isArray(o.rect) && o.rect.length === 4 && o.rect.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      const r = o.rect as number[];
      const w = num(r[2], 1, 65536, canvas[0]), h = num(r[3], 1, 65536, canvas[1]);
      l.rect = [num(r[0], -65536, 65536, 0), num(r[1], -65536, 65536, 0), w, h];
    }
    if (o.pin === true) l.pin = true;
    if (typeof o.opacity === 'number') l.opacity = num(o.opacity, 0, 1, 1);
    if (OVERLAY_BLENDS.includes(o.blend as OverlayBlend) && o.blend !== 'normal') l.blend = o.blend as OverlayBlend;
    if (o.flip === true) l.flip = true;
    if (typeof o.rot === 'number' && o.rot) l.rot = num(o.rot, -360, 360, 0);
    for (const k of ['sway', 'bob', 'flicker', 'pulse'] as const) if (typeof o[k] === 'number' && (o[k] as number) > 0) l[k] = num(o[k], 0, 1, 0);
    if (o.pivot === 'top') l.pivot = 'top';
    if (o.hidden === true) l.hidden = true;
    layers.push(l);
  }
  if (!layers.length) return null;
  const out: OverlayConfig = {
    format: OVERLAY_FORMAT, v: OVERLAY_VERSION, name: str(b.name, 80) || 'Overlay', canvas,
    fit: b.fit === 'contain' ? 'contain' : 'cover',
    parallax: num(b.parallax, 0, 2, 1), drift: num(b.drift, 0, 1, 0.3), layers: orderLayers(layers),
  };
  const a = obj(b.avatar);
  if (a) out.avatar = { anchor: ANCHORS.includes(a.anchor as never) ? a.anchor as OverlayAvatarPlace['anchor'] : 'bottom', x: num(a.x, -1, 1, 0), y: num(a.y, -1, 1, 0), scale: num(a.scale, 0.05, 2, 0.8) };
  const li = obj(b.light);
  if (li && col(li.color)) out.light = { color: col(li.color)!, strength: num(li.strength, 0, 1, 0.25) };
  const cr = str(b.credits, 300);
  if (cr) out.credits = cr;
  return out;
}

/** Back layers first, then front layers; inside a side the given order is kept (stable). */
export function orderLayers(layers: OverlayLayer[]): OverlayLayer[] {
  return [...layers.filter((l) => l.side === 'back'), ...layers.filter((l) => l.side === 'front')];
}
/** Every file the overlay needs. */
export const overlayFiles = (c: OverlayConfig) => [...new Set(c.layers.flatMap((l) => (l.file ? [l.file] : [])))];

// ---------------------------------------------------------------- 2.5D: parallax
/** How far a layer at `depth` moves, relative to the performer's plane, when the virtual viewer moves by 1:
 *  1 at 1 m (very near), 0 at the performer, −2/3 at infinity (the far sky moves the other way, a little). */
export function parallaxFactor(depth: number): number {
  const d = Math.max(0.3, depth);
  return (1 / d - 1 / AVATAR_DEPTH) / (1 - 1 / AVATAR_DEPTH);
}
/** The largest shift (px) any layer of this config can make on a host `hostW` px wide: used to overscan layers that
 *  touch the canvas edges so no edge ever shows. `cam` is clamped to ±1 per axis. */
export const PARALLAX_PX = 0.022; // × host width × parallax at factor 1 and cam 1
export const PARALLAX_Y = 0.4;    // vertical moves are smaller than sideways ones
export function maxShift(depth: number, parallax: number, hostW: number, pin?: boolean): { x: number; y: number } {
  if (pin) return { x: 0, y: 0 };
  const k = Math.abs(parallaxFactor(depth)) * PARALLAX_PX * hostW * parallax;
  // (+ the idle drift adds up to 0.35 of a full head move: covered by the same clamp in cam)
  return { x: k, y: k * PARALLAX_Y };
}

/** The virtual viewer's offset (−1..1 per axis) from the performer's head (yaw / pitch radians, position metres-ish)
 *  plus the idle drift. Pure: the stage smooths it. */
export function viewerOffset(head: readonly number[] | undefined, headPos: readonly number[] | undefined, drift: number, t: number): [number, number] {
  const yaw = head?.[0] ?? 0, pitch = head?.[1] ?? 0, px = headPos?.[0] ?? 0, py = headPos?.[1] ?? 0;
  // looking / leaning to one side moves the "window" the other way (as if the viewer stood where the performer looks from)
  let x = -yaw * 1.6 + px * 6;
  let y = pitch * 1.2 - py * 6;
  x += drift * (0.55 * Math.sin(t * 0.21) + 0.25 * Math.sin(t * 0.077 + 1.3));
  y += drift * (0.35 * Math.sin(t * 0.13 + 0.7));
  const c = (v: number) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
  return [c(x), c(y)];
}

/** Where the overlay canvas sits in a host of hw × hh px (cover / contain): scale + offset. */
export function canvasFit(canvas: readonly [number, number], fit: 'cover' | 'contain', hw: number, hh: number): { s: number; ox: number; oy: number } {
  const s = fit === 'contain' ? Math.min(hw / canvas[0], hh / canvas[1]) : Math.max(hw / canvas[0], hh / canvas[1]);
  return { s, ox: (hw - canvas[0] * s) / 2, oy: (hh - canvas[1] * s) / 2 };
}

/** Layer box in host px plus the overscan scale + pivot that hides its edges while it moves. */
export function layerBox(c: Pick<OverlayConfig, 'canvas' | 'fit' | 'parallax'>, l: OverlayLayer, hw: number, hh: number) {
  const f = canvasFit(c.canvas, c.fit, hw, hh);
  const r = l.rect ?? [0, 0, c.canvas[0], c.canvas[1]];
  const box = { left: f.ox + r[0] * f.s, top: f.oy + r[1] * f.s, width: r[2] * f.s, height: r[3] * f.s };
  const m = maxShift(l.depth, c.parallax, hw, l.pin || !!l.fx);
  const tol = 2 / Math.max(1e-6, f.s);
  const touch = { l: r[0] <= tol, t: r[1] <= tol, r: r[0] + r[2] >= c.canvas[0] - tol, b: r[1] + r[3] >= c.canvas[1] - tol };
  let over = 1, ox = 50, oy = 50;
  if ((touch.l || touch.r || touch.t || touch.b) && (m.x > 0 || m.y > 0)) {
    over = 1 + 2 * Math.max(touch.l || touch.r ? m.x / box.width : 0, touch.t || touch.b ? m.y / box.height : 0) + 0.004;
    // grow away from the edges it touches only when it touches one side (a desk on the bottom edge grows from there)
    ox = touch.l && !touch.r ? 0 : touch.r && !touch.l ? 100 : 50;
    oy = touch.t && !touch.b ? 0 : touch.b && !touch.t ? 100 : 50;
  }
  return { ...box, over, origin: `${ox}% ${oy}%`, shift: m };
}

// ---------------------------------------------------------------- planning an overlay from what a creator has
/** What the browser measured about one picture / video (overlayImport.ts measures; tests fake it). */
export interface OverlayMediaInfo {
  /** Path inside the upload. */
  path: string;
  w: number;
  h: number;
  /** Fraction of the picture that is fully opaque (alpha > 200). */
  opaque: number;
  /** Bounding box of the visible pixels, fractions of the picture [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  /** Opaque border with a see-through middle (a stream frame / webcam frame). */
  frame: boolean;
  video?: boolean;
}

const FRONT_WORDS = /(^|[^a-z])(desk|table|counter|keyboard|keys|mouse|mic|microphone|mike|foreground|fore|front|fg|frame|border|overlay|railing|rail|bar|cup|mug|plants?[_ -]?front|lamp[_ -]?front|top|over|nearest|near|ledge|sill|podium|bench|chair[_ -]?front)([^a-z]|$)/i;
const BACK_WORDS = /(^|[^a-z])(background|backdrop|bg|back|behind|wall|walls|sky|room|scenery|scene|landscape|far|distance|window|bed|shelf|shelves|floor|ceiling|base|under|bottom)([^a-z]|$)/i;
const AVATAR_WORDS = /(^|[^a-z])(avatar|model|vtuber|vtube|vts|live2d|character|chara|streamer|me|myself|placeholder|you[_ -]?here|person|body)([^a-z]|$)/i;
const PIN_WORDS = /(^|[^a-z])(frame|border|logo|watermark|chat|alert|alerts|webcam|cam[_ -]?frame|socials?|hud|ui|text|title|label|name[_ -]?plate|nameplate|banner)([^a-z]|$)/i;
const FX_WORDS: [RegExp, Partial<OverlayLayer>][] = [
  [/(^|[^a-z])(lantern|candle|torch|fire|flame|glow|neon|lamp|light)([^a-z]|$)/i, { flicker: 0.35 }],
  [/(^|[^a-z])(moss|vine|vines|hanging|curtain|banner|flag)([^a-z]|$)/i, { sway: 0.4, pivot: 'top' }],
  [/(^|[^a-z])(plant|plants|grass|reed|reeds|cattail|cattails|leaves|leaf|bush|bushes|flower|flowers|fern)([^a-z]|$)/i, { sway: 0.35 }],
  [/(^|[^a-z])(cloud|clouds|mist|fog|smoke|steam)([^a-z]|$)/i, { bob: 0.3 }],
  [/(^|[^a-z])(boat|float|floating|island|lily|lilypad|lilypads|water)([^a-z]|$)/i, { bob: 0.25 }],
];
/** A layer / file name says it is the performer's place (a placeholder in a PSD, the VTS capture in OBS). */
export const isAvatarName = (name: string) => AVATAR_WORDS.test(name.replace(/\.[a-z0-9]+$/i, ''));
/** 'front' / 'back' from a name, null = the name doesn't say. */
export function sideFromName(name: string): OverlaySide | null {
  const n = name.replace(/\.[a-z0-9]+$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const f = FRONT_WORDS.test(n), b = BACK_WORDS.test(n);
  if (f && !b) return 'front';
  if (b && !f) return 'back';
  if (f && b) return /(^|[^a-z])(fore|front|fg|desk|table|counter)/i.test(n) ? 'front' : 'back';
  return null;
}
/** Life a layer's name suggests (lanterns flicker, moss sways from the top, clouds bob). */
export function lifeFromName(name: string): Partial<OverlayLayer> {
  for (const [rx, life] of FX_WORDS) if (rx.test(name)) return { ...life };
  return {};
}
export const isPinName = (name: string) => PIN_WORDS.test(name.replace(/\.[a-z0-9]+$/i, ''));
const leadNum = (p: string) => { const m = /^(\d{1,4})[ _.-]/.exec(p.split('/').pop() ?? p); return m ? +m[1] : null; };
const baseName = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '');
const prettyName = (p: string) => baseName(p).replace(/^\d{1,4}[ _.-]+/, '').replace(/[_-]+/g, ' ').trim() || baseName(p);

/** Depths spread over the layers of each side: the first back layer is the farthest (BACK far → near), the front
 *  layers go from just in front of the performer to nearest. */
export function spreadDepths(layers: OverlayLayer[]): void {
  const back = layers.filter((l) => l.side === 'back' && !l.pin && !l.fx), front = layers.filter((l) => l.side === 'front' && !l.pin && !l.fx);
  back.forEach((l, i) => { l.depth = back.length === 1 ? BACK_DEPTH : +(30 * Math.pow(3.6 / 30, i / (back.length - 1))).toFixed(2); });
  front.forEach((l, i) => { l.depth = front.length === 1 ? FRONT_DEPTH : +(1.9 - 0.75 * (i / (front.length - 1))).toFixed(2); });
  for (const l of layers) if (l.pin) l.depth = AVATAR_DEPTH;
}

/** Loose pictures / videos (a folder, a zip, a VTube Studio background, a stream overlay pack) → an overlay.
 *  Order: numbered names first (1_sky, 2_room …), then the rest; sides from names, else from the pictures themselves:
 *  an opaque picture is a background, a see-through picture whose art sits in the lower part is a desk / foreground,
 *  a frame shape is a screen-locked frame in front. Once a layer goes in front, every layer after it does too (the
 *  order the creator painted them in is kept). */
export function planOverlayFromMedia(media: OverlayMediaInfo[], name: string): { config: OverlayConfig; notes: string[] } | { error: string } {
  const notes: string[] = [];
  const items = media.filter((m) => overlayMediaType(m.path) && m.w > 0 && m.h > 0 && !isAvatarName(baseName(m.path)));
  if (!items.length) return { error: 'Add at least one picture or video for your overlay (PNG, GIF, WebP, JPEG, WebM or MP4).' };
  if (items.length > OVERLAY_LIMITS.layers) return { error: `At most ${OVERLAY_LIMITS.layers} layers in one overlay.` };
  // the canvas: the biggest picture that looks like a full scene (most pictures in an overlay pack are full-canvas)
  const sorted = [...items].sort((a, b) => {
    const na = leadNum(a.path), nb = leadNum(b.path);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    if ((na === null) !== (nb === null)) return na === null ? 1 : -1;
    // un-numbered: backgrounds (named, then opaque) first, then the rest, then named front things
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.path.localeCompare(b.path, 'en', { numeric: true });
  });
  const canvas = guessCanvas(items);
  const layers: OverlayLayer[] = [];
  let front = false;
  for (const m of sorted) {
    const nm = baseName(m.path);
    const byName = sideFromName(nm);
    const pin = m.frame || isPinName(nm);
    const lowerArt = m.bbox[1] > 0.38 && m.bbox[2] - m.bbox[0] > 0.45 && m.opaque < 0.6;
    const side: OverlaySide = byName ?? (pin || lowerArt ? 'front' : 'back');
    if (side === 'front') front = true;
    const l: OverlayLayer = { id: slugId(prettyName(m.path)).slice(0, 40), name: prettyName(m.path), file: m.path, side: front ? 'front' : 'back', depth: 0, ...lifeFromName(nm) };
    if (pin) l.pin = true;
    // a picture smaller than the canvas and not the same shape: placed as it was drawn (centred) unless it is a full
    // scene of another size, which is scaled to the canvas
    const full = Math.abs(m.w / m.h - canvas[0] / canvas[1]) < 0.02;
    if (!full) {
      const k = Math.min(1, canvas[0] / m.w, canvas[1] / m.h);
      const w = m.w * k, h = m.h * k;
      // things with their art at the bottom (desks) sit on the bottom edge; the rest are centred
      l.rect = [Math.round((canvas[0] - w) / 2), Math.round(lowerArt || side === 'front' ? canvas[1] - h : (canvas[1] - h) / 2), Math.round(w), Math.round(h)];
    }
    if (m.video) notes.push(`${prettyName(m.path)} is a video: it loops, always muted.`);
    layers.push(l);
  }
  spreadDepths(layers);
  if (!layers.some((l) => l.side === 'back')) notes.push('Nothing goes behind you: every picture has see-through parts, so they all go in front. Number your files (1_back.png, 2_desk.png) to set the order.');
  const config = sanitizeOverlay({ format: OVERLAY_FORMAT, v: OVERLAY_VERSION, name, canvas, layers, parallax: 1, drift: 0.3, avatar: defaultAvatarPlace(layers, canvas) });
  if (!config) return { error: 'None of those files could be used as a layer.' };
  return { config, notes };
}
function rank(m: OverlayMediaInfo): number {
  const s = sideFromName(baseName(m.path));
  if (s === 'back') return 0;
  if (s === 'front') return 3;
  if (m.frame || isPinName(baseName(m.path))) return 4;
  return m.opaque > 0.9 ? 1 : 2;
}
function guessCanvas(items: OverlayMediaInfo[]): [number, number] {
  const full = items.filter((m) => m.opaque > 0.9 || m.frame).sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? [...items].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const r = full.w / full.h;
  // a 16:9 picture of any size designs a 1920 × 1080 overlay (rects are scaled from it)
  if (Math.abs(r - 16 / 9) < 0.02) return [1920, 1080];
  return [Math.round(full.w), Math.round(full.h)];
}

/** Where the performer goes when the overlay doesn't say: centred on the bottom edge, 85 % of the height (behind a
 *  desk, their hands hide). */
export function defaultAvatarPlace(layers: OverlayLayer[], canvas: readonly [number, number]): OverlayAvatarPlace {
  const desk = layers.find((l) => l.side === 'front' && !l.pin && l.rect && l.rect[1] > canvas[1] * 0.4);
  return { anchor: 'bottom', x: 0, y: desk ? 0.02 : 0, scale: 0.85 };
}

// ---------------------------------------------------------------- PSD layers → an overlay
export interface OverlayPsdLayer { name: string; path: string[]; x: number; y: number; w: number; h: number; opacity: number; visible: boolean; blend: string; opaque: number }
/** A layered PSD (bottom → top) → layers: the layer (or folder) named for the performer (avatar / model / vtuber /
 *  character / me / placeholder …) splits it: below = behind, above = in front, and its box places the performer.
 *  Without one, names decide (desk / foreground / frame in front, background / wall / sky behind) and, once a layer
 *  is in front, the layers above it are too. `file(i)` = the file the caller wrote for layer i. */
export function planOverlayFromPsd(psd: { width: number; height: number; layers: OverlayPsdLayer[] }, name: string, file: (i: number) => string): { config: OverlayConfig; notes: string[]; skip: Set<number> } | { error: string } {
  const notes: string[] = [];
  const skip = new Set<number>();
  const isMarker = (l: OverlayPsdLayer) => isAvatarName(l.name) || l.path.some((p) => isAvatarName(p));
  const markers = psd.layers.map((l, i) => (isMarker(l) ? i : -1)).filter((i) => i >= 0);
  let place: OverlayAvatarPlace | undefined;
  let split = -1;
  if (markers.length) {
    split = markers[0];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of markers) { const l = psd.layers[i]; skip.add(i); x0 = Math.min(x0, l.x); y0 = Math.min(y0, l.y); x1 = Math.max(x1, l.x + l.w); y1 = Math.max(y1, l.y + l.h); }
    place = placeFromBox([x0, y0, x1 - x0, y1 - y0], [psd.width, psd.height]);
    notes.push(`Your performer goes where "${psd.layers[markers[0]].path.concat(psd.layers[markers[0]].name).find((p) => isAvatarName(p)) ?? 'the placeholder'}" was; that layer itself is left out.`);
  }
  const layers: OverlayLayer[] = [];
  let front = false;
  psd.layers.forEach((l, i) => {
    if (skip.has(i)) return;
    if (!l.visible) { skip.add(i); return; }
    const label = [...l.path, l.name].join(' ');
    let side: OverlaySide;
    if (split >= 0) side = i > split ? 'front' : 'back';
    else {
      const s = sideFromName(l.name) ?? sideFromName(l.path.join(' '));
      const lowerArt = l.y > psd.height * 0.38 && l.w > psd.width * 0.45;
      side = s ?? (lowerArt && l.opaque < 0.95 ? 'front' : 'back');
      if (side === 'front') front = true;
      if (front) side = 'front';
    }
    const pin = isPinName(l.name);
    const lay: OverlayLayer = { id: slugId(l.name), name: l.name, file: file(i), side, depth: 0, rect: [l.x, l.y, l.w, l.h], ...lifeFromName(label) };
    if (pin) lay.pin = true;
    if (l.opacity < 0.999) lay.opacity = +l.opacity.toFixed(3);
    const bl = ({ screen: 'screen', multiply: 'multiply', add: 'add', overlay: 'overlay' } as Record<string, OverlayBlend>)[l.blend];
    if (bl) lay.blend = bl;
    layers.push(lay);
  });
  if (!layers.length) return { error: 'This PSD has no visible layers to use.' };
  spreadDepths(layers);
  const config = sanitizeOverlay({ format: OVERLAY_FORMAT, v: OVERLAY_VERSION, name, canvas: [psd.width, psd.height], layers, parallax: 1, drift: 0.3, avatar: place ?? defaultAvatarPlace(layers, [psd.width, psd.height]) });
  if (!config) return { error: 'None of the layers could be used.' };
  return { config, notes, skip };
}

/** A box on the canvas (px) where the performer should stand → the avatar placement (bottom-anchored, full height
 *  of the box). */
export function placeFromBox(box: [number, number, number, number], canvas: readonly [number, number]): OverlayAvatarPlace {
  const [x, y, w, h] = box;
  const cx = (x + w / 2) / canvas[0], bottom = (y + h) / canvas[1];
  return { anchor: 'bottom', x: +(cx - 0.5).toFixed(4), y: +(bottom - 1).toFixed(4), scale: +Math.max(0.1, Math.min(1.6, h / canvas[1])).toFixed(4) };
}

// ---------------------------------------------------------------- OBS scene collection → an overlay
/** OBS alignment flags (obs-defs.h). */
const AL = { LEFT: 1, RIGHT: 2, TOP: 4, BOTTOM: 8 };
interface ObsItem { name?: string; source_uuid?: string; pos?: { x: number; y: number }; scale?: { x: number; y: number }; rot?: number; align?: number; bounds_type?: number; bounds?: { x: number; y: number }; bounds_align?: number; crop_left?: number; crop_top?: number; crop_right?: number; crop_bottom?: number; visible?: boolean; blend_type?: string }
interface ObsSource { id?: string; versioned_id?: string; name?: string; uuid?: string; settings?: Record<string, unknown>; mixers?: number }
/** Does this JSON look like an OBS scene collection export? */
export function isObsCollection(j: unknown): boolean {
  const o = obj(j);
  return !!o && Array.isArray(o.sources) && ('current_scene' in o || 'scene_order' in o || (o.sources as unknown[]).some((s) => obj(s)?.id === 'scene'));
}
/** The source kinds that ARE the performer (a VTube Studio / VTube Pro / Live2D capture). */
function isAvatarSource(s: ObsSource): boolean {
  const id = String(s.id ?? ''), nm = String(s.name ?? ''), st = s.settings ?? {};
  const win = String(st.window ?? st.capture_window ?? ''), url = String(st.url ?? ''), spout = String(st.spoutsenders ?? st.spout_sender ?? '');
  if (/vtube|vts|live2d|veadotube|vseeface|warudo|prprlive|animaze|pngtuber|vnyan|vtuber/i.test(`${nm} ${win} ${spout}`)) return true;
  if (id === 'browser_source' && /(127\.0\.0\.1|localhost):\d+\/(output\.html|studio\/output)/i.test(url)) return true;
  if (/^(game_capture|window_capture|spout_capture|ndi_source|syphon-input|xcomposite_input|pipewire-window-capture-source)$/.test(id) && isAvatarName(nm)) return true;
  return isAvatarName(nm) && /capture|spout|ndi|browser/.test(id);
}
const fileOf = (s: ObsSource): string | null => {
  const st = s.settings ?? {};
  const f = typeof st.file === 'string' ? st.file : typeof st.local_file === 'string' ? st.local_file : null;
  return f && f.trim() ? f.trim() : null;
};
/** OBS colours are 0xAABBGGRR. */
const obsColor = (v: unknown): { color: string; alpha: number } | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = v >>> 0, r = n & 255, g = (n >>> 8) & 255, b = (n >>> 16) & 255, a = (n >>> 24) & 255;
  return { color: `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`, alpha: a / 255 };
};

/** An OBS scene collection (Scene Collection → Export) + the sizes of the pictures the user dropped with it →
 *  an overlay of the chosen scene (the current one, else the first): image / media / colour sources in OBS's stacking
 *  order (bottom first), their exact place and size, the VTube Studio (or other avatar) capture as the split between
 *  behind and in front and as the performer's place. Browser sources, text and other captures can't be copied; the
 *  notes say which were left out. `media(path)` = what was measured for the dropped file at that path (matchObsPath:
 *  same file name, the most matching folders win), null = not dropped. */
export function planOverlayFromObs(j: unknown, media: (obsPath: string) => OverlayMediaInfo | null, o: { canvas?: [number, number]; scene?: string } = {}): { config: OverlayConfig; notes: string[]; files: Map<string, string>; scenes: string[] } | { error: string } {
  if (!isObsCollection(j)) return { error: 'That JSON is not an OBS scene collection. In OBS: Scene Collection → Export, then drop that file with your overlay pictures.' };
  const root = j as { sources: ObsSource[]; current_scene?: string; scene_order?: { name?: string }[]; groups?: ObsSource[] };
  const all = [...root.sources, ...(Array.isArray(root.groups) ? root.groups : [])].filter((s) => obj(s));
  const byName = new Map(all.map((s) => [String(s.name ?? ''), s]));
  const byUuid = new Map(all.filter((s) => s.uuid).map((s) => [String(s.uuid), s]));
  const scenes = all.filter((s) => s.id === 'scene').map((s) => String(s.name ?? ''));
  if (!scenes.length) return { error: 'This OBS scene collection has no scenes.' };
  // the scene to copy: asked, else the one that shows the performer (the current one first), else the current one
  const showsAvatar = (sc: ObsSource, depth = 0): boolean => depth < 5 && itemsOf(sc).some((it) => { const s = resolve(it); return !!s && (isAvatarSource(s) || ((s.id === 'scene' || s.id === 'group') && showsAvatar(s, depth + 1))); });
  const resolve = (it: ObsItem) => (it.source_uuid && byUuid.get(it.source_uuid)) || byName.get(String(it.name ?? ''));
  const cur = String(root.current_scene ?? '');
  const order = [cur, ...(root.scene_order ?? []).map((s) => String(s.name ?? '')), ...scenes].filter((s, i, a) => s && scenes.includes(s) && a.indexOf(s) === i);
  const pick = (o.scene && scenes.includes(o.scene) ? o.scene : null) ?? order.find((s) => showsAvatar(byName.get(s)!)) ?? order[0];
  const scene = byName.get(pick)!;
  const notes: string[] = [];
  const files = new Map<string, string>(); // file in the overlay ← the dropped file's path
  const layers: OverlayLayer[] = [];
  let avatarBox: [number, number, number, number] | null = null;
  let seenAvatar = false;
  const missing: string[] = [], skipped: string[] = [];
  // canvas: given, else the biggest full-scene picture in the scene, else 1920 × 1080
  let canvas: [number, number] = o.canvas ?? DEFAULT_CANVAS;
  type Xf = { x: number; y: number; sx: number; sy: number };
  const walk = (sc: ObsSource, xf: Xf, depth: number) => {
    for (const it of itemsOf(sc)) {
      if (it.visible === false) continue;
      const s = resolve(it);
      if (!s) continue;
      const kind = String(s.id ?? '');
      const label = String(s.name ?? it.name ?? kind);
      if (kind === 'scene' || kind === 'group') {
        if (depth >= 4) continue;
        // a nested scene / group: its items are placed in its own space, then by this item's transform
        const nx = (it.pos?.x ?? 0), ny = (it.pos?.y ?? 0), nsx = it.scale?.x ?? 1, nsy = it.scale?.y ?? 1;
        walk(s, { x: xf.x + nx * xf.sx, y: xf.y + ny * xf.sy, sx: xf.sx * nsx, sy: xf.sy * nsy }, depth + 1);
        continue;
      }
      if (isAvatarSource(s)) {
        const size: [number, number] = canvas;
        const b = itemBox(it, size, xf);
        if (!seenAvatar) avatarBox = b;
        seenAvatar = true;
        continue;
      }
      let layer: OverlayLayer | null = null;
      if (kind === 'image_source' || kind === 'ffmpeg_source' || kind === 'slideshow' || kind === 'slideshow_v2') {
        const f = fileOf(s) ?? (Array.isArray((s.settings ?? {}).files) ? String(((s.settings!.files as { value?: string }[])[0] ?? {}).value ?? '') : null);
        if (!f) { skipped.push(label); continue; }
        const m = media(f);
        if (!m) { missing.push(f.split(/[\\/]/).pop() ?? f); continue; }
        const b = itemBox(it, [m.w, m.h], xf);
        const target = uniqueFile(files, m.path);
        files.set(target, m.path);
        layer = { id: slugId(label), name: label, file: target, side: seenAvatar ? 'front' : 'back', depth: 0, rect: b, ...lifeFromName(label) };
        if (m.video) notes.push(`${label} is a video: it loops, always muted.`);
        if (m.frame || isPinName(label)) layer.pin = true;
      } else if (/^color_source/.test(kind)) {
        const c = obsColor((s.settings ?? {}).color);
        if (!c || c.alpha < 0.02) continue;
        const w = Number((s.settings ?? {}).width) || canvas[0], h = Number((s.settings ?? {}).height) || canvas[1];
        layer = { id: slugId(label), name: label, color: c.color, side: seenAvatar ? 'front' : 'back', depth: 0, rect: itemBox(it, [w, h], xf), ...(c.alpha < 0.999 ? { opacity: +c.alpha.toFixed(3) } : {}) };
      } else { skipped.push(label); continue; }
      // flips + rotation: OBS mirrors with a negative scale and turns the item about its alignment point (pos); the
      // stage mirrors the picture and turns the layer about its centre, so the box's centre is turned about pos here
      const fx = (it.scale?.x ?? 1) * xf.sx < 0, fy = (it.scale?.y ?? 1) * xf.sy < 0;
      if (fx !== fy) layer.flip = true;
      const turn = (Number(it.rot) || 0) * (xf.sx * xf.sy < 0 ? -1 : 1); // (a mirrored nested scene turns the other way)
      if (turn && layer.rect) {
        const [x, y, w, h] = layer.rect;
        const px = xf.x + (it.pos?.x ?? 0) * xf.sx, py = xf.y + (it.pos?.y ?? 0) * xf.sy;
        const a = (turn * Math.PI) / 180, dx = x + w / 2 - px, dy = y + h / 2 - py;
        layer.rect = [+(px + dx * Math.cos(a) - dy * Math.sin(a) - w / 2).toFixed(2), +(py + dx * Math.sin(a) + dy * Math.cos(a) - h / 2).toFixed(2), w, h];
      }
      const rot = (((turn + (fy ? 180 : 0)) % 360) + 540) % 360 - 180; // a vertical flip = a mirror turned half a turn
      if (Math.abs(rot) > 1e-3) layer.rot = +rot.toFixed(2);
      const bt = String(it.blend_type ?? '');
      const bl = ({ OBS_BLEND_SCREEN: 'screen', OBS_BLEND_MULTIPLY: 'multiply', OBS_BLEND_ADDITIVE: 'add', OBS_BLEND_LIGHTEN: 'screen', OBS_BLEND_DARKEN: 'multiply' } as Record<string, OverlayBlend>)[bt];
      if (bl) layer.blend = bl;
      layers.push(layer);
    }
  };
  if (!o.canvas) {
    // the first full-scene picture fixes the canvas (pos 0,0, scale 1): most overlays are drawn at the stream size
    for (const it of itemsOf(scene)) {
      const s = resolve(it); const f = s ? fileOf(s) : null; const m = f ? media(f) : null;
      if (m && m.opaque > 0.9 && !(it.pos?.x) && !(it.pos?.y) && Math.abs((it.scale?.x ?? 1) - 1) < 1e-3 && !(it.bounds_type)) { canvas = [m.w, m.h]; break; }
    }
  }
  walk(scene, { x: 0, y: 0, sx: 1, sy: 1 }, 0);
  if (!layers.length) {
    if (missing.length) return { error: `Drop the pictures this scene uses together with the scene collection: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` and ${missing.length - 4} more` : ''}.` };
    return { error: `The scene "${pick}" has no pictures or videos VTube Pro can copy.` };
  }
  if (!seenAvatar) notes.push(`No VTube Studio (or other avatar) capture in "${pick}": everything goes behind you except pictures named desk / foreground / frame.`);
  if (!seenAvatar) for (const l of layers) { const s = sideFromName(l.name); if (s === 'front' || l.pin) l.side = 'front'; }
  // fix the order: OBS order inside each side (first = bottom)
  spreadDepths(layers);
  if (missing.length) notes.push(`Not found in what you dropped (left out): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`);
  if (skipped.length) notes.push(`Left out (not pictures: browser sources, text, captures): ${[...new Set(skipped)].slice(0, 5).join(', ')}${skipped.length > 5 ? ' …' : ''}. VTube Pro has its own chat, alerts and screen share.`);
  if (scenes.length > 1) notes.push(`Copied the scene "${pick}" (of ${scenes.length}).`);
  const config = sanitizeOverlay({ format: OVERLAY_FORMAT, v: OVERLAY_VERSION, name: pick || 'OBS overlay', canvas, layers, parallax: 0.8, drift: 0.25, avatar: avatarBox ? placeFromBox(avatarCharacterBox(avatarBox, canvas), canvas) : defaultAvatarPlace(layers, canvas) });
  if (!config) return { error: 'Nothing in that scene could be used.' };
  return { config, notes, files, scenes };
}
/** The dropped file an OBS path means: same file name (any case, / or \), and of those the one whose folders match
 *  the most from the end (packs reuse names per scene: Live/background.webm, BRB/background.webm); null = none. */
export function matchObsPath<T extends { path: string }>(dropped: readonly T[], obsPath: string): T | null {
  const parts = (p: string) => p.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const o = parts(obsPath);
  let best: T | null = null, bestN = 0;
  for (const d of dropped) {
    const p = parts(d.path);
    let n = 0;
    while (n < p.length && n < o.length && p[p.length - 1 - n] === o[o.length - 1 - n]) n++;
    if (n > bestN) { bestN = n; best = d; } // n ≥ 1: the file name matches; more matching folders win
  }
  return best;
}
function itemsOf(sc: ObsSource | undefined): ObsItem[] {
  const it = (sc?.settings as { items?: unknown } | undefined)?.items;
  return Array.isArray(it) ? it.filter((x) => obj(x)) as ObsItem[] : [];
}
function uniqueFile(files: Map<string, string>, path: string): string {
  const b = (path.split('/').pop() ?? path).replace(/[^A-Za-z0-9_. -]/g, '_') || 'layer.png';
  let n = b, k = 2;
  while (files.has(n) && files.get(n) !== path) { n = b.replace(/(\.[^.]+)?$/, `_${k++}$1`); }
  return n;
}
/** An OBS scene item's box on the canvas (px) from its source size, scale, crop, alignment and bounds. */
export function itemBox(it: ObsItem, size: readonly [number, number], xf: { x: number; y: number; sx: number; sy: number } = { x: 0, y: 0, sx: 1, sy: 1 }): [number, number, number, number] {
  const cw = Math.max(1, size[0] - (it.crop_left ?? 0) - (it.crop_right ?? 0)), ch = Math.max(1, size[1] - (it.crop_top ?? 0) - (it.crop_bottom ?? 0));
  let w: number, h: number;
  const bt = it.bounds_type ?? 0;
  if (bt && it.bounds && it.bounds.x > 0 && it.bounds.y > 0) {
    const bw = it.bounds.x, bh = it.bounds.y;
    const kIn = Math.min(bw / cw, bh / ch), kOut = Math.max(bw / cw, bh / ch);
    // 1 stretch, 2 scale inner, 3 scale outer, 4 to width, 5 to height, 6 max only
    if (bt === 1) { w = bw; h = bh; }
    else if (bt === 3) { w = cw * kOut; h = ch * kOut; }
    else if (bt === 4) { w = bw; h = ch * (bw / cw); }
    else if (bt === 5) { h = bh; w = cw * (bh / ch); }
    else if (bt === 6) { const k = Math.min(1, kIn); w = cw * k; h = ch * k; }
    else { w = cw * kIn; h = ch * kIn; }
    // (inside its bounds box the picture sits by bounds_align; the box itself by align)
    const ba = it.bounds_align ?? 0;
    const bx = ba & AL.LEFT ? 0 : ba & AL.RIGHT ? bw - w : (bw - w) / 2;
    const by = ba & AL.TOP ? 0 : ba & AL.BOTTOM ? bh - h : (bh - h) / 2;
    // (a flipped item stays in its bounds box: OBS moves its origin by the flip)
    const [ax, ay] = alignOff(it.align ?? 5, bw, bh);
    const x = (it.pos?.x ?? 0) - ax + bx, y = (it.pos?.y ?? 0) - ay + by;
    return xfBox(xf, x, y, w, h);
  }
  // OBS keeps a flip as a negative scale and aligns the signed size: top-left with scale.x −1 spans [pos.x − w, pos.x]
  const sw = cw * (it.scale?.x ?? 1), sh = ch * (it.scale?.y ?? 1);
  const [ax, ay] = alignOff(it.align ?? 5, sw, sh);
  let x = (it.pos?.x ?? 0) - ax, y = (it.pos?.y ?? 0) - ay;
  if (sw < 0) x += sw;
  if (sh < 0) y += sh;
  return xfBox(xf, x, y, Math.abs(sw), Math.abs(sh));
}
/** A box in a nested scene's space → the canvas (a flipped nested scene flips the box too). */
function xfBox(xf: { x: number; y: number; sx: number; sy: number }, x: number, y: number, w: number, h: number): [number, number, number, number] {
  const X = xf.x + x * xf.sx, Y = xf.y + y * xf.sy, W = w * xf.sx, H = h * xf.sy;
  return [Math.min(X, X + W), Math.min(Y, Y + H), Math.abs(W), Math.abs(H)];
}
function alignOff(a: number, w: number, h: number): [number, number] {
  return [a & AL.LEFT ? 0 : a & AL.RIGHT ? w : w / 2, a & AL.TOP ? 0 : a & AL.BOTTOM ? h : h / 2];
}
/** A capture window shows more than the character (VTube Studio's window is the whole canvas, the model in it is
 *  smaller): the character is taken as the box's lower-middle 86 % of its height, standing on its bottom edge. */
function avatarCharacterBox(b: [number, number, number, number], canvas: readonly [number, number]): [number, number, number, number] {
  const [x, y, w, h] = b;
  const x1 = Math.max(0, x), y1 = Math.max(0, y), x2 = Math.min(canvas[0], x + w), y2 = Math.min(canvas[1], y + h);
  const vw = Math.max(1, x2 - x1), vh = Math.max(1, y2 - y1);
  const ch = vh * 0.86;
  return [x1 + vw / 2 - ch * 0.3, y2 - ch, ch * 0.6, ch];
}
