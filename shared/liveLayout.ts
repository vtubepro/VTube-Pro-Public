// live-layout: "no dead space" measurement for the Live panel (owner 2026-10-01: "what is all that dead space?").
// largestEmptyRect() is pure (unit-tested in tools/live_layout_unit.ts). measureLive() runs in a page: it collects the
// rectangles that actually SHOW something inside the Live view (text, pictures, canvases, icons, controls, the program
// monitor) — a panel's empty background does not count — clips them to their scroll boxes, and finds the biggest
// rectangle with nothing in it. tools/live_layout_e2e.mjs asks for it through vite (import('/shared/liveLayout.ts')).

export interface Rect { x: number; y: number; w: number; h: number }

/** Biggest axis-aligned rectangle inside (0,0,W,H) that touches none of `occupied` (grid of `cell` px, rounded so a
 *  cell counts as occupied when anything covers part of it). Histogram method: O(cols × rows). */
export function largestEmptyRect(W: number, H: number, occupied: Rect[], cell = 8): Rect & { area: number } {
  const cols = Math.max(1, Math.ceil(W / cell)), rows = Math.max(1, Math.ceil(H / cell));
  const full = new Uint8Array(cols * rows);
  for (const r of occupied) {
    if (r.w <= 0 || r.h <= 0) continue;
    const x0 = Math.max(0, Math.floor(r.x / cell)), x1 = Math.min(cols, Math.ceil((r.x + r.w) / cell));
    const y0 = Math.max(0, Math.floor(r.y / cell)), y1 = Math.min(rows, Math.ceil((r.y + r.h) / cell));
    for (let y = y0; y < y1; y++) full.fill(1, y * cols + x0, y * cols + x1);
  }
  const hist = new Int32Array(cols);
  let best = { x: 0, y: 0, w: 0, h: 0, area: 0 };
  const stack: number[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) hist[x] = full[y * cols + x] ? 0 : hist[x] + 1;
    stack.length = 0;
    for (let x = 0; x <= cols; x++) {
      const hgt = x < cols ? hist[x] : 0;
      while (stack.length && hist[stack[stack.length - 1]] >= hgt) {
        const top = stack.pop()!, h = hist[top];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0, w = x - left;
        const wPx = Math.min(W, (left + w) * cell) - left * cell, hPx = Math.min(H, (y + 1) * cell) - (y + 1 - h) * cell;
        const area = wPx * hPx;
        if (h > 0 && area > best.area) best = { x: left * cell, y: (y + 1 - h) * cell, w: wPx, h: hPx, area };
      }
      stack.push(x);
    }
  }
  return best;
}

const LEAF = new Set(['IMG', 'CANVAS', 'VIDEO', 'svg', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'KBD', 'PROGRESS', 'METER', 'HR']);
const isClip = (cs: CSSStyleDeclaration) => cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
const inter = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
};
const R = (d: DOMRect | DOMRectReadOnly): Rect => ({ x: d.left, y: d.top, w: d.width, h: d.height });
const transparent = (c: string) => !c || c === 'transparent' || /rgba?\([^)]*,\s*0(\.0+)?\)$/.test(c);

export interface LiveLayoutMeasure {
  viewport: { w: number; h: number };
  view: Rect;
  empty: Rect & { area: number };
  /** empty area ÷ viewport area */
  frac: number;
  /** the page (or anything around the Live view) scrolls */
  pageScroll: boolean;
  occupied: number;
}

/** Measure the mounted Live view (browser only). */
export function measureLive(root: Element | null = document.querySelector('.lc')): LiveLayoutMeasure | null {
  if (!root) return null;
  const view = R(root.getBoundingClientRect());
  const occ: Rect[] = [];
  const clipOf = new Map<Element, Rect | null>();
  /** visible box of an element after every scrolling / clipping ancestor up to the Live view */
  const clip = (e: Element): Rect | null => {
    if (clipOf.has(e)) return clipOf.get(e)!;
    let c: Rect | null = view;
    const p = e.parentElement;
    if (p && p !== root && root.contains(p)) {
      c = clip(p);
      if (c && isClip(getComputedStyle(p))) c = inter(c, R(p.getBoundingClientRect()));
    }
    clipOf.set(e, c);
    return c;
  };
  const add = (r: Rect, e: Element) => { const c = clip(e); const x = c && inter(r, c); if (x) occ.push(x); };
  const walk = (e: Element) => {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
    const r = R(e.getBoundingClientRect());
    if (LEAF.has(e.tagName) || e.classList.contains('lc-pgm-frame') || e.classList.contains('lc-health')) { add(r, e); return; }
    // small filled things (chips, badges, meters, swatches, avatars) show something; big panels' backgrounds do not
    if ((!transparent(cs.backgroundColor) || cs.backgroundImage !== 'none') && r.w * r.h < 0.012 * innerWidth * innerHeight) add(r, e);
    for (const n of e.childNodes) {
      if (n.nodeType === 3 && n.textContent!.trim()) {
        const rg = document.createRange(); rg.selectNodeContents(n);
        for (const t of rg.getClientRects()) add(R(t), e);
      } else if (n.nodeType === 1) walk(n as Element);
    }
  };
  walk(root);
  const shifted = occ.map((o) => ({ x: o.x - view.x, y: o.y - view.y, w: o.w, h: o.h }));
  const empty = largestEmptyRect(view.w, view.h, shifted, 8);
  let pageScroll = document.scrollingElement!.scrollHeight > innerHeight + 1 || document.scrollingElement!.scrollWidth > innerWidth + 1;
  for (let p = root.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1) pageScroll = true;
  }
  return { viewport: { w: innerWidth, h: innerHeight }, view, empty: { ...empty, x: empty.x + view.x, y: empty.y + view.y }, frac: empty.area / (innerWidth * innerHeight), pageScroll, occupied: occ.length };
}
