// Quad maths for the react screen passthrough (server/obs.ts) and the Scene tab: a projected screen is a general
// quadrilateral; OBS source transforms are affine (position / rotation / scale / bounds, no skew), so exact placement
// needs a perspective corner-pin (obs-shaderfilter), else the best rotated box.
export type Pt = [number, number];

/** 3×3 homography (row-major, h22 = 1) mapping src[i] → dst[i] for 4 point pairs. */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

/** Inverse of a 3×3 (row-major), normalised so m[8] = 1. */
export function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const r = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det);
  return r.map((x) => x / r[8]);
}

export function applyH(m: number[], p: Pt): Pt {
  const w = m[6] * p[0] + m[7] * p[1] + m[8];
  return [(m[0] * p[0] + m[1] * p[1] + m[2]) / w, (m[3] * p[0] + m[4] * p[1] + m[5]) / w];
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const k = M[r][c] / d; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

/** Best OBS-expressible box for a quad (TL, TR, BR, BL): centre, rotation (deg, clockwise on screen), width, height,
 *  and how far (same units) the real corners are from it. */
export function rotatedFit(q: Pt[]) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const top: Pt = [q[1][0] - q[0][0], q[1][1] - q[0][1]], bot: Pt = [q[2][0] - q[3][0], q[2][1] - q[3][1]];
  const ang = Math.atan2(top[1] + bot[1], top[0] + bot[0]);
  const w = (Math.hypot(...top) + Math.hypot(...bot)) / 2;
  const h = (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const box: Pt[] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
  const err = Math.max(...q.map((p, i) => Math.hypot(p[0] - box[i][0], p[1] - box[i][1])));
  return { cx, cy, rotation: (ang * 180) / Math.PI, w, h, err };
}

/** Order 4 projected points as TL, TR, BR, BL (by angle around their centre, starting top-left). */
export function orderQuad(p: Pt[]): Pt[] {
  const cx = p.reduce((a, q) => a + q[0], 0) / p.length, cy = p.reduce((a, q) => a + q[1], 0) / p.length;
  const s = [...p].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));   // y down: TL, TR, BR, BL… cyclic
  let k = 0, best = Infinity;
  s.forEach((q, i) => { const d = q[0] + q[1]; if (d < best) { best = d; k = i; } });
  return [0, 1, 2, 3].map((i) => s[(k + i) % 4]);
}

// ---------------------------------------------------------------- is the React screen really in the shot?
// Owner rule: the React window always looks like a real screen IN the room. OBS passthrough (a Window Capture under a
// see-through hole) is only allowed when OBS can line it up exactly: the screen is in the shot, and either OBS can warp
// the capture (corner-pin) or a plain (rotated) OBS box matches its corners. The page (src/scene/SceneRuntime.ts) and
// the server (server/obs.ts) use the same tests, so a hole the page opens is always one OBS will fill.

/** A projected corner: x, y = fractions of the frame (top-left origin), z = NDC depth (−1 near … 1 far; anything else
 *  = behind the camera or past the far plane). */
export type PCorner = [number, number, number];
/** How far (fraction of the frame) a corner may stick out and still count as in the shot. */
export const SHOT_MARGIN = 0.02;
/** Smallest screen (fraction of the frame's width and height) that counts as in the shot. */
export const SHOT_MIN = 0.03;
/** A plain OBS box matches a screen when no corner is further off than this (px of a 1080-high frame). */
export const EXACT_PX = 4;
export type ShotWhy = 'ok' | 'behind' | 'outside' | 'small' | 'bad';
export interface FracRect { x: number; y: number; w: number; h: number }
export interface ShotCheck { inShot: boolean; why: ShotWhy; rect: FracRect }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Is a projected screen (its 4 corners, any order) in the shot: all in front of the camera, inside the frame (±margin),
 *  and not a sliver? `rect` is the corners' bounding box. */
export function shotCheck(c: PCorner[], margin = SHOT_MARGIN, min = SHOT_MIN): ShotCheck {
  if (c.length !== 4 || !c.every((p) => p.length === 3 && p.every(finite))) return { inShot: false, why: 'bad', rect: { x: 0, y: 0, w: 0, h: 0 } };
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const why: ShotWhy = c.some((p) => !(p[2] > -1 && p[2] < 1)) ? 'behind'
    : x0 < -margin || y0 < -margin || x1 > 1 + margin || y1 > 1 + margin ? 'outside'
    : rect.w < min || rect.h < min ? 'small' : 'ok';
  return { inShot: why === 'ok', why, rect };
}

/** The same test for what an OBS page reported (a flat rect + its quad, fractions; no depth). The server is a little
 *  more lenient than the page (rounding, a camera nudge between the page's test and its report). */
export function holeInFrame(rect: FracRect, quad: Pt[] | null, margin = SHOT_MARGIN * 2): ShotWhy {
  const pts: Pt[] = quad && quad.length === 4 ? quad : [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]];
  if (!pts.every((p) => p.length === 2 && finite(p[0]) && finite(p[1])) || ![rect.x, rect.y, rect.w, rect.h].every(finite)) return 'bad';
  return shotCheck(pts.map(([x, y]) => [x, y, 0] as PCorner), margin, SHOT_MIN * 0.5).why;
}

/** Worst corner error (px of a 1080-high frame with this aspect) of the best plain OBS box for a quad (fractions,
 *  ordered TL, TR, BR, BL). 0 = a straight-on (or only rotated) screen. */
export function boxErrorPx(quad: Pt[], aspect: number): number {
  const H = 1080, W = 1080 * (finite(aspect) && aspect > 0 ? aspect : 16 / 9);
  return rotatedFit(quad.map(([x, y]) => [x * W, y * H] as Pt)).err;
}

export interface PassVerdict extends ShotCheck { /** box error, px of a 1080-high frame (Infinity when not in shot) */ err: number; /** a plain OBS box matches it */ exact: boolean; quad: Pt[] }
/** Everything the page needs to decide hole-or-picture for one screen as a camera sees it. */
export function judgeSurface(c: PCorner[], aspect: number): PassVerdict {
  const s = shotCheck(c);
  const quad = s.why === 'bad' ? [] : orderQuad(c.map((p) => [p[0], p[1]] as Pt));
  const err = s.inShot ? boxErrorPx(quad, aspect) : Infinity;
  return { ...s, err, exact: err <= EXACT_PX, quad };
}

/** Plain words for why a screen isn't in the shot (logs, status). */
export function shotLabel(why: ShotWhy): string {
  return why === 'behind' ? 'behind the camera' : why === 'outside' ? 'outside the picture' : why === 'small' ? 'too small in the picture' : why === 'bad' ? 'not measurable' : 'in the shot';
}

/** 'contain' fit of a source aspect inside a target aspect: content uv = (uv − o) / s. */
export function containFit(srcAspect: number, dstAspect: number): { sx: number; sy: number; ox: number; oy: number } {
  const r = srcAspect / dstAspect;
  if (!Number.isFinite(r) || r <= 0) return { sx: 1, sy: 1, ox: 0, oy: 0 };
  return r > 1 ? { sx: 1, sy: 1 / r, ox: 0, oy: (1 - 1 / r) / 2 } : { sx: r, sy: 1, ox: (1 - r) / 2, oy: 0 };
}
