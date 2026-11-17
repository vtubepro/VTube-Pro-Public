// Free-space search for 3D views (Talk, React Big / Side, modes without a composition): where the docked chat /
// support panels and the "rail" of performer cams can go in the current shot without covering a face, the React
// screen (the capture), an in-world chat prop, or each other. Pure 2D maths in design px (1080 high).
import type { Rect } from '../../../shared/stage.ts';

export interface Box { x0: number; y0: number; x1: number; y1: number; /** 3 = never cover (faces, capture), 1 = avoid. */ w: number }
const P = 20, G = 12;

const toBox = (r: Rect, W: number, w = 3): Box => ({ x0: r.x * W, y0: r.y * 1080, x1: (r.x + r.w) * W, y1: (r.y + r.h) * 1080, w });
const toRect = (b: { x0: number; y0: number; x1: number; y1: number }, W: number): Rect => ({ x: b.x0 / W, y: b.y0 / 1080, w: (b.x1 - b.x0) / W, h: (b.y1 - b.y0) / 1080 });
function overlap(a: { x0: number; y0: number; x1: number; y1: number }, b: Box, pad = 6) {
  const w = Math.min(a.x1, b.x1 + pad) - Math.max(a.x0, b.x0 - pad), h = Math.min(a.y1, b.y1 + pad) - Math.max(a.y0, b.y0 - pad);
  return w > 0 && h > 0 ? w * h * b.w : 0;
}
const cost = (r: { x0: number; y0: number; x1: number; y1: number }, keep: Box[]) => keep.reduce((s, b) => s + overlap(r, b), 0);

export interface FreeSpaceInput {
  aspect: number;
  /** Keep-out rects (fractions): faces + the capture = hard, props = soft. */
  hard: Rect[];
  soft: Rect[];
  rail: string[];
  /** Try a row along the bottom first (the room shot is inset: the band under it is free). */
  preferRow?: boolean;
  chat: boolean;
  support: boolean;
  /** The previous result (kept while it still fits: no jumping around). */
  prev?: FreeSpaceResult | null;
  /** Last resort before hiding (modes with hard keep-outs): a chat ticker strip / a small support card anywhere along
   *  the top / bottom edge. */
  ticker?: boolean;
}
export interface FreeSpaceResult { rail: { key: string; rect: Rect }[]; chat: Rect | null; support: Rect | null }

/** Rail cams in a column (left edge first, then right) or a row (bottom, then top); then chat (right / left column),
 *  then support (corners). Everything shrinks to its minimum before giving up. */
export function searchFreeSpace(inp: FreeSpaceInput): FreeSpaceResult {
  const W = 1080 * inp.aspect;
  const keep: Box[] = [...inp.hard.map((r) => toBox(r, W, 3)), ...inp.soft.map((r) => toBox(r, W, 1))];
  const inFrame = (b: { x0: number; y0: number; x1: number; y1: number }) => b.x0 >= P - 0.5 && b.y0 >= P - 0.5 && b.x1 <= W - P + 0.5 && b.y1 <= 1080 - P + 0.5;
  // keep the previous placement while it still collides with nothing hard
  const prevOk = (r: Rect | null | undefined) => !!r && cost(toBox(r, W), keep.filter((k) => k.w >= 3)) === 0;
  const out: FreeSpaceResult = { rail: [], chat: null, support: null };
  const placed: Box[] = [];
  const take = (b: { x0: number; y0: number; x1: number; y1: number }) => placed.push({ ...b, w: 3 });
  const all = () => [...keep, ...placed];

  // ---- rail
  const n = inp.rail.length;
  if (n) {
    const prev = inp.prev?.rail;
    if (prev && prev.length === n && prev.every((t, i) => t.key === inp.rail[i] && prevOk(t.rect))) {
      out.rail = prev; for (const t of prev) take(toBox(t.rect, W));
    } else {
      let best: { cost: number; boxes: { x0: number; y0: number; x1: number; y1: number }[] } | null = null;
      for (const tw of [230, 200, 170, 150, 130, 112]) {
        const th = tw / 0.82;
        const cols: { x0: number; y0: number; x1: number; y1: number }[][] = [], rows: typeof cols = [];
        // columns (host at the top), both edges, top- and bottom-aligned
        const colH = n * th + (n - 1) * G;
        if (colH <= 1080 - 2 * P) for (const x of [P, W - P - tw]) for (const top of [true, false]) {
          const y0 = top ? P : 1080 - P - colH;
          cols.push(Array.from({ length: n }, (_, i) => ({ x0: x, y0: y0 + i * (th + G), x1: x + tw, y1: y0 + i * (th + G) + th })));
        }
        // rows (host on the left), bottom then top
        const rowW = n * tw + (n - 1) * G;
        // (left, right, then slid along the edge in 10 steps: a face near one end doesn't cost the whole row)
        if (rowW <= W - 2 * P) for (const y of [1080 - P - th, P]) for (const x0 of [P, W - P - rowW, ...Array.from({ length: 9 }, (_, k) => P + (W - 2 * P - rowW) * (k + 1) / 10)]) {
          rows.push(Array.from({ length: n }, (_, i) => ({ x0: x0 + i * (tw + G), y0: y, x1: x0 + i * (tw + G) + tw, y1: y + th })));
        }
        const cands = inp.preferRow ? [...rows, ...cols] : [...cols, ...rows];
        for (const c of cands) {
          const k = c.reduce((s, b) => s + cost(b, keep), 0);
          if (!best || k < best.cost) best = { cost: k, boxes: c };
          if (k === 0) break;
        }
        if (best && best.cost === 0) break;
      }
      if (best) { out.rail = best.boxes.map((b, i) => ({ key: inp.rail[i], rect: toRect(b, W) })); for (const b of best.boxes) take(b); }
    }
  }

  // ---- chat: a column at the right (then left) edge, tall to short, wide to narrow
  if (inp.chat) {
    if (prevOk(inp.prev?.chat) && cost(toBox(inp.prev!.chat!, W), placed) === 0) { out.chat = inp.prev!.chat!; take(toBox(out.chat, W)); }
    else {
      let best: { c: number; b: { x0: number; y0: number; x1: number; y1: number } } | null = null;
      outer: for (const hk of [0.6, 0.48, 0.38]) for (const cw of [340, 300, 260, 220, 190, 170]) {
        const ch = hk * 1080;
        for (const x of [W - P - cw, P]) for (const y of [P, 1080 - P - ch]) {
          const b = { x0: x, y0: y, x1: x + cw, y1: y + ch };
          if (!inFrame(b)) continue;
          const c = cost(b, all());
          if (!best || c < best.c) best = { c, b };
          if (c === 0) break outer;
        }
      }
      // no column anywhere: a landscape chat box (a few lines) along the bottom / top edge
      if (!best || best.c >= 1) for (const bh of [220, 180, 150]) for (const bw of [720, 560, 420]) for (const y of [1080 - P - bh, P]) for (const x of [W - P - bw, P, (W - bw) / 2]) {
        const b = { x0: x, y0: y, x1: x + bw, y1: y + bh };
        if (!inFrame(b)) continue;
        const c = cost(b, all());
        if (!best || c < best.c) best = { c, b };
      }
      // modes with hard keep-outs: a thin ticker strip (2–4 lines) slid along the bottom / top edge
      if (inp.ticker && (!best || best.c >= 1)) for (const bh of [110, 88, 66]) for (const bw of [900, 720, 560, 420]) for (const y of [1080 - P - bh, P]) for (let k = 0; k <= 10; k++) {
        const x = P + (W - 2 * P - bw) * (k / 10);
        const b = { x0: x, y0: y, x1: x + bw, y1: y + bh };
        if (!inFrame(b)) continue;
        const c = cost(b, all());
        if (!best || c < best.c) best = { c, b };
        if (c === 0) break;
      }
      if (best && best.c < 1) { out.chat = toRect(best.b, W); take(best.b); }
    }
  }
  // ---- support: a landscape card in a corner (or under / over the chat)
  if (inp.support) {
    if (prevOk(inp.prev?.support) && cost(toBox(inp.prev!.support!, W), placed) === 0) { out.support = inp.prev!.support!; take(toBox(out.support, W)); }
    else {
      let best: { c: number; b: { x0: number; y0: number; x1: number; y1: number } } | null = null;
      const cands: { x0: number; y0: number; x1: number; y1: number }[] = [];
      for (const sw of [420, 360, 300, 250, 210, 180]) {
        const sh = Math.max(96, sw * 0.42);
        for (const [x, y] of [[P, P], [W - P - sw, P], [P, 1080 - P - sh], [W - P - sw, 1080 - P - sh]]) cands.push({ x0: x, y0: y, x1: x + sw, y1: y + sh });
      }
      if (out.chat) {
        const c = toBox(out.chat, W);
        for (const sh of [200, 150, 110]) { cands.push({ x0: c.x0, y0: c.y1 + G, x1: c.x1, y1: c.y1 + G + sh }, { x0: c.x0, y0: c.y0 - G - sh, x1: c.x1, y1: c.y0 - G }); }
      }
      if (inp.ticker) for (const [sw, sh] of [[200, 80], [170, 68], [150, 60]]) for (const y of [P, 1080 - P - sh]) for (let k = 0; k <= 10; k++) {
        const x = P + (W - 2 * P - sw) * (k / 10);
        cands.push({ x0: x, y0: y, x1: x + sw, y1: y + sh });
      }
      for (const b of cands) {
        if (!inFrame(b)) continue;
        const c = cost(b, all());
        if (!best || c < best.c) best = { c, b };
        if (c === 0) break;
      }
      if (best && best.c < 1) { out.support = toRect(best.b, W); take(best.b); }
    }
  }
  return out;
}
