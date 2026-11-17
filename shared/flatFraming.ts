// 2D avatars: what a picture shows, read from its alpha — where the character is (its opaque bounds) and whether it is
// a whole body (feet at the bottom) or head and shoulders (a "bust": cut off at the chest). The display side sizes and
// grounds the card from this (src/avatar/flat/card.ts): full bodies stand on the floor, busts sit on a seat or on a
// pedestal. Pure: tests in tools/flat_unit.ts.

export interface ContentInfo {
  /** Opaque bounds as fractions of the picture: x from the left, y from the BOTTOM (x0 < x1, y0 < y1). */
  x0: number; x1: number; y0: number; y1: number;
  /** Content height / width (in picture pixels). */
  aspect: number;
  /** Share of the content width covered at its bottom edge, and how many separate pieces cover it (two feet = 2). */
  bottomCover: number;
  bottomRuns: number;
  /** The widest gap between those pieces, as a share of the content width. */
  bottomGap: number;
  /** The content reaches the picture's bottom edge (cut off there). */
  touchesBottom: boolean;
  framing: 'full' | 'bust';
  /** A whole body: how far below its feet anything else it draws hangs (a tail, a prop in another picture), fraction
   *  of the picture height — framing shows it, the feet still stand on the floor (withUnion). */
  hang?: number;
  /** How sure (0..1), for the UI ("looks like head and shoulders"). */
  confidence: number;
}

/** Read an alpha mask (`alpha[y * w + x]`, row 0 = TOP, 0..255). null = nothing opaque. */
export function analyzeContent(alpha: ArrayLike<number>, w: number, h: number, threshold = 24): ContentInfo | null {
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > threshold) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  // the bottom band of the content: its lowest 3 % of rows (at least one row), merged
  const band = Math.max(1, Math.round(ch * 0.03));
  const cov = new Uint8Array(cw);
  for (let y = y1 - band + 1; y <= y1; y++) for (let x = x0; x <= x1; x++) if (alpha[y * w + x] > threshold) cov[x - x0] = 1;
  let covered = 0, runs = 0, gap = 0, cur = 0, inRun = false, seen = false;
  for (let i = 0; i < cw; i++) {
    if (cov[i]) { covered++; if (!inRun) { runs++; if (seen) gap = Math.max(gap, cur); } inRun = true; seen = true; cur = 0; }
    else { if (inRun) inRun = false; if (seen) cur++; }
  }
  const aspect = ch / cw, bottomCover = covered / cw, bottomGap = gap / cw;
  const touchesBottom = y1 >= h - 1 - Math.max(1, Math.round(h * 0.015));
  // score > 0.5 = bust: squat content, a wide single cut at the bottom, cut off at the picture's edge; tall content or
  // two feet with a gap = a whole body
  let s = aspect < 1.6 ? 1 : aspect < 2.2 ? 0 : -2;
  s += bottomCover > 0.6 ? 1 : bottomCover < 0.4 ? -1 : 0;
  if (runs >= 2 && bottomGap > 0.08) s -= 1;
  s += touchesBottom ? 0.5 : -0.5;
  const framing = s > 0.5 ? 'bust' : 'full';
  return {
    x0: x0 / w, x1: (x1 + 1) / w, y0: (h - 1 - y1) / h, y1: (h - y0) / h,
    aspect, bottomCover, bottomRuns: runs, bottomGap, touchesBottom, framing,
    confidence: Math.min(1, Math.abs(s - 0.5) / 2),
  };
}

/** A box on a picture, fractions: x from the left, y from the BOTTOM (x0 < x1, y0 < y1). */
export interface ContentRect { x0: number; x1: number; y0: number; y1: number }

/** The box of every pixel with alpha above `minA` (row 0 = TOP), as a ContentRect; null = nothing there. minA 0: any
 *  coverage at all (a one-pixel mark in a downscaled picture keeps a little alpha). */
export function alphaRect(alpha: ArrayLike<number>, w: number, h: number, minA = 0, stride = 1, offset = 0): ContentRect | null {
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[(y * w + x) * stride + offset] > minA) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0: x0 / w, x1: (x1 + 1) / w, y0: (h - 1 - y1) / h, y1: (h - y0) / h };
}

export const unionRect = (a: ContentRect | null, b: ContentRect | null): ContentRect | null =>
  !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) };

/** The content a card is built from: what the resting picture shows (whole body / bust, its feet) widened to everything
 *  the avatar can draw (`all`: every picture / animation frame, a rig's head turns, expressions, physics swing, costume
 *  layers) — sides and top from the union; a whole body's feet stay the resting picture's (they stand on the floor) and
 *  anything drawn lower is `hang` (framed below the feet); a bust's cut edge is the lowest of all. */
export function withUnion(c: ContentInfo, all: ContentRect | null): ContentInfo {
  if (!all) return c;
  const u = unionRect(c, all)!;
  const hang = c.framing === 'bust' ? 0 : Math.max(0, c.y0 - u.y0);
  return { ...c, x0: u.x0, x1: u.x1, y1: u.y1, y0: c.framing === 'bust' ? u.y0 : c.y0, ...(hang > 1e-4 ? { hang } : {}) };
}

/** Body plan in units of the virtual person's height (what a bust card stands in for). Standing: the bust shows the
 *  top 40 % of a person and stands on a pedestal at chest height; seated: it rests on the seat, a little larger, its
 *  head where a seated person's head is. */
export const BUST_PLAN = { standBottom: 0.6, standContent: 0.4, seatContent: 0.5, seatLift: 0.02 };

/** Head room above a 2D card in its own shot (cams, cut-outs, the classic stage; 8 %: the art's top inside the cams'
 *  safe area, src/scene/frameGuard.ts), and where its bottom goes: a whole
 *  body's feet just above the frame's bottom edge, a bust's cut edge just past it (like a 3D body leaving the frame). */
export const CARD_SHOT = { headroom: 0.08, feet: 0.015, cut: 0.01, side: 0.06 };

/** A shot of a 2D card (world units, the card facing the lens): the frame height and its centre so the WHOLE drawn art
 *  is in view, its bottom anchored on the frame's bottom edge and no side clipped (a wide picture in a narrow cam gets
 *  a taller frame, the extra room above the head). `half` = half the art's width, `aspect` = the frame's width / height. */
export function cardShot(art: { bottom: number; top: number; half: number }, aspect: number, bust: boolean): { frameH: number; centerY: number } {
  const K = CARD_SHOT, edge = bust ? -K.cut : K.feet;
  const h = Math.max(1e-4, art.top - art.bottom);
  const frameH = Math.max(h / (1 - K.headroom - edge), (2 * art.half * (1 + 2 * K.side)) / Math.max(0.1, aspect));
  return { frameH, centerY: art.bottom - edge * frameH + frameH / 2 };
}

type Eye = { x: number; y: number; z: number };
type CardArt = { bottom: number; top: number; half: number; base: { x: number; z: number } };
/** The widest lens a card shot may use (tan of half the vertical field: 100 deg). */
export const CARD_LENS_MAX_TAN = Math.tan((50 * Math.PI) / 180);
/** The steepest a card shot may look at the art (8 deg): an upright picture seen from far above / below is
 *  foreshortened and leaves its frame. */
export const CARD_MAX_PITCH = (8 * Math.PI) / 180;
const CARD_MAX_SPAN = (80 * Math.PI) / 180;

/** Where the art lands in a lens (NDC: x / y in -1..1 are in frame): its bottom / top centre's y, its widest |x|. */
export function cardProject(eye: Eye, art: CardArt, aspect: number, L: { pitch: number; tanHalf: number }): { bottom: number; top: number; side: number; front: boolean } {
  const D = Math.hypot(art.base.x - eye.x, art.base.z - eye.z);
  const depth = (y: number) => D * Math.cos(L.pitch) + (y - eye.y) * Math.sin(L.pitch);
  const up = (y: number) => (y - eye.y) * Math.cos(L.pitch) - D * Math.sin(L.pitch);
  const db = depth(art.bottom), dt = depth(art.top);
  const front = db > 1e-6 && dt > 1e-6;
  return { bottom: up(art.bottom) / Math.max(1e-9, db) / L.tanHalf, top: up(art.top) / Math.max(1e-9, dt) / L.tanHalf,
    side: art.half / Math.max(1e-9, Math.min(db, dt)) / (L.tanHalf * Math.max(0.1, aspect)), front };
}

/** The lens from `eye` exactly (no moving): null when no lens there holds the art — the eye inside the art's height
 *  too close (it subtends 80 deg or more), an edge behind the lens, or wider than CARD_LENS_MAX_TAN. */
function solveCardLens(eye: Eye, art: CardArt, aspect: number, bust: boolean): { pitch: number; tanHalf: number } | null {
  const K = CARD_SHOT, D = Math.hypot(art.base.x - eye.x, art.base.z - eye.z);
  if (D < 1e-3) return null;
  const a = Math.atan2(art.bottom - eye.y, D), b = Math.atan2(art.top - eye.y, D);
  if (b - a >= CARD_MAX_SPAN) return null;
  const kb = bust ? 1 + 2 * K.cut : 1 - 2 * K.feet, kt = 1 - 2 * K.headroom;
  // both edges placed: tan(b - p) / kt = -tan(a - p) / kb, solved for the pitch p by bisection (monotonic in p on (a, b))
  let lo = a, hi = b;
  for (let i = 0; i < 60; i++) { const p = (lo + hi) / 2; if (Math.tan(b - p) / kt + Math.tan(a - p) / kb > 0) lo = p; else hi = p; }
  let pitch = (lo + hi) / 2, t = Math.tan(b - pitch) / kt;
  // the sides: a wider need opens the lens and keeps the bottom where it is (room above the head)
  for (let i = 0; i < 4; i++) {
    const pr = cardProject(eye, art, aspect, { pitch, tanHalf: t });
    if (!pr.front) return null;
    if (pr.side <= 1 / (1 + 2 * K.side) + 1e-9) break;
    t *= pr.side * (1 + 2 * K.side);
    pitch = a + Math.atan(kb * t);
  }
  const L = { pitch, tanHalf: t }, pr = cardProject(eye, art, aspect, L);
  if (!(t > 0) || t > CARD_LENS_MAX_TAN || !pr.front || pr.side > 1 + 1e-6 || pr.top > 1 + 1e-6 || pr.bottom < -(kb + 1e-6)) return null;
  return L;
}

/** The lens for a card's shot from a camera that is NOT level with it (a tile cam a few degrees above, pulled in past a
 *  desk, moved by the framing guard): pitch (radians, + = looking up) and tan(half vertical fov) so that the art's bottom
 *  lands on the frame's bottom edge (CARD_SHOT: feet just above, a bust's cut just past), its top under the head room and
 *  its sides inside (`aspect` = width / height; extra room goes above the head). `base`: the art's bottom centre (the
 *  card turns to face the lens).
 *  Where the camera may go: it is first brought within CARD_MAX_PITCH of the art's middle (lowered / raised at its
 *  distance), then, if no lens there holds the art (inside its height and too close), stepped back along its line —
 *  every such eye must pass `ok` (the caller's clearance test: the line to the art clear, not inside furniture or a
 *  person). The first eye that fails `ok` ends the walk (anything further back is past the obstacle). No verified eye:
 *  the camera stays where it was (`verified` false) with a lens that keeps the TOP of the art — the widest lens, the
 *  bottom cropped (`cutShows`: a bust's cut edge is in view from there, the caller fades it). Never an unchecked lens.
 *  Pure: exact for an upright card. `away`: the horizontal way back when the eye stands right above / below the art. */
export function cardLens(eye: Eye, art: CardArt, aspect: number, bust: boolean, away: { x: number; z: number } = { x: 0, z: 1 }, ok: (e: Eye) => boolean = () => true):
  { pitch: number; tanHalf: number; eye: Eye; moved: number; verified: boolean; cutShows: boolean } {
  const midY = (art.bottom + art.top) / 2;
  let hx = eye.x - art.base.x, hz = eye.z - art.base.z, D = Math.hypot(hx, hz);
  if (D < 1e-3) { const n = Math.hypot(away.x, away.z) || 1; hx = away.x / n; hz = away.z / n; D = 0; } else { hx /= D; hz /= D; }
  const h = Math.max(0.05, art.top - art.bottom);
  let d = Math.max(D, 0.05 * h);
  const at = (dist: number): Eye => {
    const lim = dist * Math.tan(CARD_MAX_PITCH);
    return { x: art.base.x + hx * dist, y: Math.min(midY + lim, Math.max(midY - lim, eye.y)), z: art.base.z + hz * dist };
  };
  const moved = (e: Eye) => Math.hypot(e.x - eye.x, e.y - eye.y, e.z - eye.z);
  for (let i = 0; i < 60; i++) {
    const e = at(d);
    if (moved(e) > 1e-6 && !ok(e)) break;   // (behind the desk / the person that made the camera pull in: no further)
    const L = solveCardLens(e, art, aspect, bust);
    if (L) return { ...L, eye: e, moved: moved(e), verified: true, cutShows: false };
    d *= 1.12;
  }
  // where it stands, as it is (no pitch cap): when that holds the art, fine
  const L0 = D >= 1e-3 ? solveCardLens(eye, art, aspect, bust) : null;
  if (L0) return { ...L0, eye: { ...eye }, moved: 0, verified: true, cutShows: false };
  // the crop: the widest lens, the art's top under the head room, the bottom cut off by the frame
  const Dh = Math.max(1e-3, D), b = Math.atan2(art.top - eye.y, Dh), t = CARD_LENS_MAX_TAN;
  const pitch = b - Math.atan((1 - 2 * CARD_SHOT.headroom) * t);
  const pr = cardProject(eye, { ...art, base: { x: eye.x - hx * Dh, z: eye.z - hz * Dh } }, aspect, { pitch, tanHalf: t });
  return { pitch, tanHalf: t, eye: { ...eye }, moved: 0, verified: false, cutShows: bust && pr.front && pr.bottom > -1 };
}
