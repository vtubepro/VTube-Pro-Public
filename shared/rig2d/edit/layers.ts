// Layered art as the rig editor sees it: named RGBA layers placed on a canvas, with the folder path they came from.
// Sources: a PSD (psd.ts), several PNGs (one per layer; full-canvas exports or pre-cropped), or the procedural test
// character (tools/rig2d/testArt.ts). Pure (no DOM).

export type LayerBlend = 'normal' | 'multiply' | 'screen' | 'add' | 'overlay';

export interface ArtLayer {
  name: string;
  /** Folder names from the outermost in ("Head", "Eyes", "Eye L"). */
  path: string[];
  /** Placement on the canvas (px, y down) and size. */
  x: number; y: number; w: number; h: number;
  /** Straight (non-premultiplied) RGBA, w*h*4. */
  rgba: Uint8ClampedArray;
  opacity: number;
  visible: boolean;
  blend: LayerBlend;
  /** Photoshop clipping mask: clipped to the nearest non-clipped layer below. */
  clipped: boolean;
  /** Hidden: what hides it — the index into `path` of every hidden folder, plus `path.length` when its own eye is off
   *  (ascending). Absent when visible or unknown (the outfit switches use it, extras.ts autoCostumes). */
  hiddenAt?: number[];
  /** Clipped to a whole FOLDER (the folder directly below it): that folder's path. Its layers' merged alpha is the
   *  clip shape. */
  clipFolder?: string[];
}

export interface ArtSet { width: number; height: number; layers: ArtLayer[]; warnings: string[] }

/** The bounding box of pixels with alpha > `thr`, or null when the layer is empty. */
export function alphaBounds(rgba: Uint8ClampedArray, w: number, h: number, thr = 0): { x: number; y: number; w: number; h: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (rgba[row + x * 4 + 3] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Crop a layer to its visible pixels (+ `pad` transparent px, kept inside the original rect). Empty layers → null. */
export function trimLayer(l: ArtLayer, pad = 2): ArtLayer | null {
  const b = alphaBounds(l.rgba, l.w, l.h, 0);
  if (!b) return null;
  const x0 = Math.max(0, b.x - pad), y0 = Math.max(0, b.y - pad), x1 = Math.min(l.w, b.x + b.w + pad), y1 = Math.min(l.h, b.y + b.h + pad);
  if (x0 === 0 && y0 === 0 && x1 === l.w && y1 === l.h) return l;
  const w = x1 - x0, h = y1 - y0, out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(l.rgba.subarray(((y + y0) * l.w + x0) * 4, ((y + y0) * l.w + x1) * 4), y * w * 4);
  return { ...l, x: l.x + x0, y: l.y + y0, w, h, rgba: out };
}

/** Several pictures → one layer set. Each picture's file name (minus extension) is its layer name; folders in the
 *  relative path become its group path. Pictures that are the size of the largest picture are treated as full-canvas
 *  exports (placed at 0,0) and trimmed; smaller ones are centred unless `place` gives their position. The array order
 *  is the paint order (first = bottom) unless names carry a numeric prefix ("03_eye_l.png"), which then sorts them. */
export function layersFromPictures(pics: { path: string; w: number; h: number; rgba: Uint8ClampedArray; place?: { x: number; y: number } }[]): ArtSet {
  const warnings: string[] = [];
  if (!pics.length) return { width: 0, height: 0, layers: [], warnings: ['no pictures'] };
  const W = Math.max(...pics.map((p) => p.w)), H = Math.max(...pics.map((p) => p.h));
  const NUM = /^(\d{1,4})[ _.-]+(.+)$/;
  const items = pics.map((p, i) => {
    const segs = p.path.replace(/\\/g, '/').split('/').filter(Boolean);
    const file = (segs.pop() ?? `layer${i}`).replace(/\.[a-z0-9]{2,5}$/i, '');
    // numeric prefixes ("02_Head/03_eye.png") give the paint order and are not part of the names
    const order: number[] = [];
    const strip = (s: string) => { const m = NUM.exec(s); if (m) { order.push(Number(m[1])); return m[2]; } return s; };
    const path = segs.map(strip);
    const name = strip(file);
    return { p, i, order, name, path };
  });
  if (items.length > 1 && items.every((it) => it.order.length)) {
    items.sort((a, b) => {
      for (let k = 0; k < Math.min(a.order.length, b.order.length); k++) if (a.order[k] !== b.order[k]) return a.order[k] - b.order[k];
      return a.order.length - b.order.length || a.i - b.i;
    });
  }
  // a common top folder (the uploaded folder itself) is not a group
  while (items.length > 1 && items[0].path.length && items.every((it) => it.path.length && it.path[0] === items[0].path[0])) for (const it of items) it.path.shift();
  const layers: ArtLayer[] = [];
  for (const it of items) {
    const { p } = it;
    const full = p.w === W && p.h === H;
    if (!full && !p.place && pics.length > 1) warnings.push(`"${it.name}" is smaller than the canvas: centred (export every layer at full canvas size to keep positions)`);
    const x = p.place ? p.place.x : full ? 0 : Math.round((W - p.w) / 2), y = p.place ? p.place.y : full ? 0 : Math.round((H - p.h) / 2);
    const t = trimLayer({ name: it.name, path: it.path, x, y, w: p.w, h: p.h, rgba: p.rgba, opacity: 1, visible: true, blend: 'normal', clipped: false });
    if (t) layers.push(t); else warnings.push(`"${it.name}" is empty: skipped`);
  }
  return { width: W, height: H, layers, warnings };
}

/** Paint layers (normal blending, straight alpha) into one RGBA canvas: thumbnails and tests. */
export function composite(set: { width: number; height: number; layers: ArtLayer[] }, onlyVisible = true): Uint8ClampedArray {
  const W = set.width, H = set.height, out = new Float32Array(W * H * 4);
  for (const l of set.layers) {
    if (onlyVisible && !l.visible) continue;
    for (let y = 0; y < l.h; y++) {
      const gy = y + l.y; if (gy < 0 || gy >= H) continue;
      for (let x = 0; x < l.w; x++) {
        const gx = x + l.x; if (gx < 0 || gx >= W) continue;
        const s = (y * l.w + x) * 4, d = (gy * W + gx) * 4;
        const a = (l.rgba[s + 3] / 255) * l.opacity;
        if (a <= 0) continue;
        const da = out[d + 3], oa = a + da * (1 - a);
        for (let k = 0; k < 3; k++) out[d + k] = (l.rgba[s + k] * a + out[d + k] * da * (1 - a)) / oa;
        out[d + 3] = oa;
      }
    }
  }
  const r = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { r[i * 4] = out[i * 4]; r[i * 4 + 1] = out[i * 4 + 1]; r[i * 4 + 2] = out[i * 4 + 2]; r[i * 4 + 3] = out[i * 4 + 3] * 255; }
  return r;
}

/** Shrink a layer set whose canvas is bigger than `maxSide` (huge PSDs): every layer is box-filtered by the same factor
 *  (premultiplied, so edges stay clean). Returns the set unchanged when it already fits. */
export function fitArt(set: ArtSet, maxSide = 4096): ArtSet {
  const k = maxSide / Math.max(set.width, set.height);
  if (k >= 1) return set;
  const layers: ArtLayer[] = [];
  for (const l of set.layers) {
    const x0 = Math.floor(l.x * k), y0 = Math.floor(l.y * k), x1 = Math.ceil((l.x + l.w) * k), y1 = Math.ceil((l.y + l.h) * k);
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), out = new Uint8ClampedArray(w * h * 4);
    const acc = new Float64Array(w * h * 5);
    for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) {
      const tx = Math.min(w - 1, Math.max(0, Math.floor((l.x + x + 0.5) * k) - x0)), ty = Math.min(h - 1, Math.max(0, Math.floor((l.y + y + 0.5) * k) - y0));
      const s = (y * l.w + x) * 4, d = (ty * w + tx) * 5, a = l.rgba[s + 3] / 255;
      acc[d] += l.rgba[s] * a; acc[d + 1] += l.rgba[s + 1] * a; acc[d + 2] += l.rgba[s + 2] * a; acc[d + 3] += a; acc[d + 4] += 1;
    }
    for (let i = 0; i < w * h; i++) {
      const a = acc[i * 5 + 3], n = acc[i * 5 + 4];
      if (!n || !a) continue;
      out[i * 4] = acc[i * 5] / a; out[i * 4 + 1] = acc[i * 5 + 1] / a; out[i * 4 + 2] = acc[i * 5 + 2] / a; out[i * 4 + 3] = (a / n) * 255;
    }
    layers.push({ ...l, x: x0, y: y0, w, h, rgba: out });
  }
  return { width: Math.round(set.width * k), height: Math.round(set.height * k), layers, warnings: [...set.warnings, `The picture was ${set.width}x${set.height}: scaled to ${Math.round(set.width * k)}x${Math.round(set.height * k)} for live use.`] };
}
