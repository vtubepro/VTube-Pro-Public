// Layered art in: a small, dependency-free Photoshop (.psd / .psb) layer reader written from Adobe's public file format
// specification. It reads what a 2D rig needs and nothing else: every pixel layer's name (Unicode name when present),
// bounds, opacity, visibility, blend mode, clipping flag and RGBA pixels, plus the group (folder) path it sits in.
// Supported: RGB and Grayscale, 8 / 16 / 32 bits per channel, raw / RLE (PackBits) / ZIP / ZIP-with-prediction channels,
// PSD and PSB. Solid-colour shape / fill layers (vector paths, no stored pixels) are rasterised; vector masks and
// user (raster) masks are applied to alpha. Every layer is cropped to the canvas and trimmed to its visible pixels
// (GIMP / Krita save full-canvas layers; artists leave paint off-canvas), empty layers are left out, and a plain backdrop at the bottom (Photoshop's "Background", a full-canvas
// opaque picture or colour fill) is left out because an avatar needs a see-through background. Not drawn (each named in
// `warnings` in plain words): adjustment layers, layer effects (stroke / shadow / glow), gradient / pattern fills,
// smart-object contents beyond their stored pixels, CMYK / Lab colour (converted approximately).
//
// Pure: no DOM. ZIP channels use the platform's DecompressionStream (browsers, Node >= 18), hence async.
import { trimLayer, type ArtLayer, type LayerBlend } from './layers.ts';

export class PsdError extends Error {}

/** Hard limits so a hostile file cannot exhaust memory. */
export const PSD_LIMITS = { side: 30000, layers: 4000, pixels: 400e6 };

export interface PsdFile {
  width: number;
  height: number;
  /** Layers bottom → top (the order they are painted), groups flattened into `path`. */
  layers: ArtLayer[];
  warnings: string[];
}

class Reader {
  p = 0;
  constructor(public b: Uint8Array, public dv = new DataView(b.buffer, b.byteOffset, b.byteLength)) {}
  need(n: number) { if (n < 0 || this.p + n > this.b.length) throw new PsdError('the file ends early (truncated or not a PSD)'); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p); this.p += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.p); this.p += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p); this.p += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.p); this.p += 4; return v; }
  u64() { const hi = this.u32(), lo = this.u32(); return hi * 4294967296 + lo; }
  str(n: number) { this.need(n); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p + i]); this.p += n; return s; }
  bytes(n: number) { this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  skip(n: number) { this.need(n); this.p += n; }
}

const BLEND: Record<string, LayerBlend> = {
  'norm': 'normal', 'pass': 'normal', 'diss': 'normal', 'mul ': 'multiply', 'scrn': 'screen', 'lddg': 'add', 'lgdg': 'add', 'over': 'overlay',
  'dark': 'multiply', 'lite': 'screen', 'idiv': 'multiply', 'lbrn': 'multiply', 'dkCl': 'multiply', 'lLit': 'screen', 'sLit': 'overlay', 'hLit': 'overlay',
};

interface RawLayer {
  top: number; left: number; bottom: number; right: number;
  channels: { id: number; len: number }[];
  blend: string; opacity: number; clipping: number; flags: number;
  name: string; section: number; // 0 none, 1/2 folder (open / closed), 3 end-of-folder marker
  mask: { top: number; left: number; bottom: number; right: number; def: number; disabled: boolean } | null;
  hasPixelsKeys: string[];
  /** Raw data of the additional-info blocks we interpret (vector mask / shape path, solid colour fill). */
  blocks: Map<string, Uint8Array>;
}

/** Additional-info keys of Photoshop adjustment layers (they change the look of what is below; nothing to draw). */
const ADJUSTMENT_KEYS = new Set(['levl', 'curv', 'brit', 'hue ', 'hue2', 'blnc', 'blwh', 'phfl', 'mixr', 'clrL', 'nvrt', 'post', 'thrs', 'grdm', 'selc', 'expA', 'vibA', 'CgEd']);
const EFFECT_KEYS = new Set(['lfx2', 'lrFX', 'lmfx']);
const KEEP_BLOCKS = new Set(['vmsk', 'vsms', 'SoCo']);
/** Vector shapes / masks are rasterised on canvases up to this many pixels (8k x 8k). */
const VECTOR_MAX_PX = 64e6;
const listNames = (names: string[]) => names.slice(0, 3).map((n) => `"${n}"`).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');

/** Does this look like a PSD / PSB file? */
export const isPsd = (b: Uint8Array | undefined | null) => !!b && b.length > 26 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53;

/** Parse a .psd / .psb into layers. Throws PsdError with a human sentence on files it cannot read. */
export async function parsePsd(buf: ArrayBuffer | Uint8Array, opts: { /** keep a full-canvas backdrop (2.5D overlays: it IS the scene) */ keepBackdrop?: boolean } = {}): Promise<PsdFile> {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(b);
  if (r.str(4) !== '8BPS') throw new PsdError('not a Photoshop file (no 8BPS signature)');
  const version = r.u16();
  if (version !== 1 && version !== 2) throw new PsdError(`unknown PSD version ${version}`);
  const psb = version === 2;
  r.skip(6);
  r.u16(); // merged-image channel count
  const height = r.u32(), width = r.u32(), depth = r.u16(), mode = r.u16();
  if (!width || !height || width > PSD_LIMITS.side || height > PSD_LIMITS.side) throw new PsdError(`canvas ${width}x${height} is too big`);
  if (depth !== 8 && depth !== 16 && depth !== 32) throw new PsdError(`${depth}-bit images are not supported (use 8 or 16 bits per channel)`);
  const warnings: string[] = [];
  if (mode !== 3 && mode !== 1) {
    if (mode === 4) warnings.push('CMYK file: colours converted approximately; save as RGB for exact colours');
    else throw new PsdError(`colour mode ${['Bitmap', 'Grayscale', 'Indexed', 'RGB', 'CMYK', '', '', 'Multichannel', 'Duotone', 'Lab'][mode] ?? mode} is not supported: convert to RGB`);
  }
  r.skip(r.u32()); // colour mode data
  r.skip(r.u32()); // image resources
  const lmLen = psb ? r.u64() : r.u32();
  const lmEnd = r.p + lmLen;
  if (!lmLen) return { width, height, layers: [], warnings: [...warnings, 'no layers: the file is a flat picture (use a layered PSD or several PNGs)'] };
  let liLen = psb ? r.u64() : r.u32();
  // Photoshop stores 16/32-bit layers in the 'Lr16' / 'Lr32' block of the global additional info, with an empty layer
  // info section here; handle both.
  let liStart = r.p;
  if (!liLen) {
    r.p = liStart;
    r.skip(r.u32()); // global layer mask info
    let found = false;
    while (r.p + 12 <= lmEnd) {
      const sig = r.str(4), key = r.str(4);
      if (sig !== '8BIM' && sig !== '8B64') break;
      const len = psb && ['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'].includes(key) ? r.u64() : r.u32();
      if (key === 'Lr16' || key === 'Lr32' || key === 'Layr') { liStart = r.p; liLen = len; found = true; break; }
      r.skip(len + (len & 1 ? 0 : 0));
    }
    if (!found) return { width, height, layers: [], warnings: [...warnings, 'no layers found'] };
    r.p = liStart;
  }
  const liEnd = liStart + liLen;
  let count = r.i16();
  count = Math.abs(count);
  if (count > PSD_LIMITS.layers) throw new PsdError(`${count} layers is too many`);
  const raws: RawLayer[] = [];
  for (let i = 0; i < count; i++) {
    const L: RawLayer = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), channels: [], blend: 'norm', opacity: 255, clipping: 0, flags: 0, name: '', section: 0, mask: null, hasPixelsKeys: [], blocks: new Map() };
    const nch = r.u16();
    if (nch > 56) throw new PsdError('corrupt layer record (channel count)');
    for (let c = 0; c < nch; c++) L.channels.push({ id: r.i16(), len: psb ? r.u64() : r.u32() });
    if (r.str(4) !== '8BIM') throw new PsdError('corrupt layer record (blend signature)');
    L.blend = r.str(4); L.opacity = r.u8(); L.clipping = r.u8(); L.flags = r.u8(); r.u8();
    const extra = r.u32();
    const exEnd = r.p + extra;
    const mLen = r.u32();
    if (mLen >= 20) {
      const m0 = r.p;
      const mt = r.i32(), ml = r.i32(), mb = r.i32(), mr = r.i32(), def = r.u8(), mflags = r.u8();
      L.mask = { top: mt, left: ml, bottom: mb, right: mr, def, disabled: (mflags & 2) !== 0 };
      r.p = m0 + mLen;
    } else r.skip(mLen);
    r.skip(r.u32()); // blending ranges
    const nameLen = r.u8();
    L.name = decodeLatin(r.bytes(nameLen));
    r.skip((4 - ((nameLen + 1) % 4)) % 4);
    while (r.p + 12 <= exEnd) {
      const sig = r.str(4);
      if (sig !== '8BIM' && sig !== '8B64') { r.p = exEnd; break; }
      const key = r.str(4);
      const len = psb && ['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'].includes(key) ? r.u64() : r.u32();
      const dEnd = r.p + len;
      if (dEnd > exEnd) break;
      if (key === 'luni' && len >= 4) {
        const n = r.u32();
        let s = '';
        for (let k = 0; k < n && r.p + 2 <= dEnd; k++) s += String.fromCharCode(r.u16());
        L.name = s.replace(/\0+$/, '');
      } else if ((key === 'lsct' || key === 'lsdk') && len >= 4) {
        L.section = r.u32();
      } else {
        L.hasPixelsKeys.push(key);
        if (KEEP_BLOCKS.has(key)) L.blocks.set(key, r.b.subarray(r.p, dEnd));
      }
      r.p = dEnd;
    }
    r.p = exEnd;
    raws.push(L);
  }
  // channel image data, in record order
  const layers: ArtLayer[] = [];
  const stack: { name: string; hidden: boolean; opacity: number }[] = [];
  const pending: { raw: RawLayer; data: Map<number, Uint8Array> }[] = [];
  for (const L of raws) {
    const data = new Map<number, Uint8Array>();
    for (const ch of L.channels) {
      const start = r.p;
      const isUserMask = ch.id === -2 || ch.id === -3;
      const rect = isUserMask && L.mask ? L.mask : L;
      const w = Math.max(0, rect.right - rect.left), h = Math.max(0, rect.bottom - rect.top);
      if (ch.len < 2) { r.p = start + ch.len; continue; }
      const comp = r.u16();
      try {
        if (w * h > 0 && w * h <= PSD_LIMITS.pixels) {
          const plane = await readChannel(r, comp, w, h, depth, psb, start + ch.len);
          if (plane) data.set(ch.id, plane);
        }
      } catch (e) {
        if (e instanceof PsdError) warnings.push(`layer "${L.name}": ${e.message}`);
        else throw e;
      }
      r.p = start + ch.len;
    }
    pending.push({ raw: L, data });
  }
  if (r.p > liEnd + 4) warnings.push('layer data ran past its section');

  // Build layers + group paths. Records run bottom → top; a group is "end marker (3) … children … folder (1 / 2)".
  const groupStack: { hidden: boolean; opacity: number }[] = [];
  // Walk top → bottom so we see the folder record before its children.
  const topDown = pending.slice().reverse();
  const out: ArtLayer[] = [];
  /** Output layers that are Photoshop's locked "Background" (no transparency channel). */
  const noAlpha = new Set<ArtLayer>();
  const adjustments: string[] = [], effects: string[] = [], gradients: string[] = [];
  for (let ti = 0; ti < topDown.length; ti++) {
    const { raw: L, data } = topDown[ti];
    if (L.section === 1 || L.section === 2) {
      const hidden = (L.flags & 2) !== 0;
      stack.push({ name: L.name || 'Group', hidden, opacity: L.opacity / 255 });
      groupStack.push({ hidden, opacity: L.opacity / 255 });
      continue;
    }
    if (L.section === 3) { stack.pop(); groupStack.pop(); continue; }
    if (L.hasPixelsKeys.some((k) => ADJUSTMENT_KEYS.has(k))) { adjustments.push(L.name || 'adjustment'); continue; }
    if (L.hasPixelsKeys.some((k) => EFFECT_KEYS.has(k))) effects.push(L.name || 'layer');
    let x = L.left, y = L.top, w = L.right - L.left, h = L.bottom - L.top;
    let rgba: Uint8ClampedArray;
    const R = data.get(0), G = mode === 1 ? data.get(0) : data.get(1), B = mode === 1 ? data.get(0) : data.get(2), A = data.get(-1);
    const vmask = L.blocks.get('vmsk') ?? L.blocks.get('vsms');
    if (w > 0 && h > 0 && R) {
      rgba = new Uint8ClampedArray(w * h * 4);
      const K = mode === 4 ? data.get(3) : undefined;
      for (let i = 0, n = w * h; i < n; i++) {
        let rr = R[i], gg = G ? G[i] : rr, bb = B ? B[i] : rr;
        if (mode === 4) { const k = K ? K[i] : 255; rr = (rr * k) / 255; gg = (gg * k) / 255; bb = (bb * k) / 255; }
        rgba[i * 4] = rr; rgba[i * 4 + 1] = gg; rgba[i * 4 + 2] = bb; rgba[i * 4 + 3] = A ? A[i] : 255;
      }
      const M = data.get(-2);
      if (M && L.mask && !L.mask.disabled) applyUserMask(rgba, L, M, L.mask);
      if (vmask && !L.blocks.has('SoCo') && width * height <= VECTOR_MAX_PX) applyVectorMask(rgba, x, y, w, h, vmask, width, height);
    } else if (L.blocks.has('SoCo') && width * height <= VECTOR_MAX_PX) {
      // a solid-colour shape (vector path) or fill layer: Photoshop stores no pixels for it, so draw it here
      const col = solidColour(L.blocks.get('SoCo')!);
      const cov = vmask ? pathCoverage(vmask, width, height) : null;
      x = 0; y = 0; w = width; h = height;
      rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, n = w * h; i < n; i++) { rgba[i * 4] = col[0]; rgba[i * 4 + 1] = col[1]; rgba[i * 4 + 2] = col[2]; rgba[i * 4 + 3] = cov ? Math.round(cov[i] * 255) : 255; }
      const M = data.get(-2);
      if (M && L.mask && !L.mask.disabled) applyUserMask(rgba, { left: 0, top: 0, right: width, bottom: height }, M, L.mask);
    } else {
      if (L.hasPixelsKeys.some((k) => ['TySh', 'tySh'].includes(k))) warnings.push(`text layer "${L.name}" has no pixels: rasterize it`);
      else if (L.hasPixelsKeys.some((k) => k === 'GdFl' || k === 'PtFl')) gradients.push(L.name || 'fill');
      else if (w > 0 && h > 0 && !R) warnings.push(`layer "${L.name}" has no colour data: skipped`);
      continue;
    }
    const groupsHidden = groupStack.some((g) => g.hidden);
    const hiddenAt = [...groupStack.flatMap((g, i) => (g.hidden ? [i] : [])), ...((L.flags & 2) !== 0 ? [stack.length] : [])];
    const groupOpacity = groupStack.reduce((a, g) => a * g.opacity, 1);
    const layer: ArtLayer = {
      name: L.name || `Layer ${out.length + 1}`,
      path: stack.map((s) => s.name),
      x, y, w, h, rgba,
      opacity: (L.opacity / 255) * groupOpacity,
      visible: (L.flags & 2) === 0 && !groupsHidden,
      blend: BLEND[L.blend] ?? 'normal',
      clipped: L.clipping === 1,
      ...(hiddenAt.length ? { hiddenAt } : {}),
    };
    // a clipping layer directly above a folder clips to the whole folder (Photoshop: the record below is the folder's)
    const below = topDown[ti + 1]?.raw;
    if (layer.clipped && below && (below.section === 1 || below.section === 2)) layer.clipFolder = [...layer.path, below.name || 'Group'];
    out.push(layer);
    if (!A && !L.blocks.has('SoCo')) noAlpha.add(layer);
    if (!(L.blend in BLEND)) warnings.push(`layer "${L.name}": blend mode '${L.blend.trim()}' drawn as normal`);
  }
  out.reverse(); // back to bottom → top
  // Trim every layer to its visible pixels; leave out empty ones silently (nothing to see; unless something is clipped
  // to them).
  for (let i = 0; i < out.length; i++) {
    const t = trimLayer(cropToCanvas(out[i], width, height), 2);
    if (t) { if (t !== out[i] && noAlpha.has(out[i])) noAlpha.add(t); out[i] = t; continue; }
    if (out[i + 1]?.clipped) { out[i] = { ...out[i], w: 1, h: 1, rgba: new Uint8ClampedArray(4) }; continue; }
    out.splice(i--, 1);
  }
  // A plain backdrop at the bottom (Photoshop's "Background", a full-canvas opaque picture or colour fill) is not part of
  // the character: an avatar needs a see-through background. Kept only when nothing else would be left.
  const dropped: string[] = [];
  while (!opts.keepBackdrop && out.length > 1 && isBackdrop(out[0], width, height, noAlpha.has(out[0]))) dropped.push(out.shift()!.name);
  for (const l of out) layers.push(l);
  if (dropped.length) warnings.unshift(`Left out the background (${listNames(dropped)}): a 2D avatar needs a see-through background, so only the character is used.`);
  if (adjustments.length) warnings.push(`Colour adjustment layers (${listNames(adjustments)}) are not applied: the parts keep their painted colours. To keep the look, merge them into the layers in your paint program.`);
  if (effects.length) warnings.push(`Layer effects (stroke, shadow, glow) on ${listNames(effects)} are not drawn. To keep them, rasterize the layer style in your paint program.`);
  if (gradients.length) warnings.push(`Gradient or pattern fill layers (${listNames(gradients)}) are not drawn: rasterize them in your paint program.`);
  return { width, height, layers, warnings };
}

/** Pixels outside the canvas are invisible in the artwork (stray paint, parts moved off-canvas, oversized pastes):
 *  crop them away so the auto-rig measures what the artist sees. Layers fully outside become empty (left out). */
function cropToCanvas(l: ArtLayer, W: number, H: number): ArtLayer {
  const x0 = Math.max(0, l.x), y0 = Math.max(0, l.y), x1 = Math.min(W, l.x + l.w), y1 = Math.min(H, l.y + l.h);
  if (x0 === l.x && y0 === l.y && x1 === l.x + l.w && y1 === l.y + l.h) return l;
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0), out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(l.rgba.subarray(((y + y0 - l.y) * l.w + (x0 - l.x)) * 4, ((y + y0 - l.y) * l.w + (x1 - l.x)) * 4), y * w * 4);
  return { ...l, x: x0, y: y0, w, h, rgba: out };
}

/** Bottom layer that is a backdrop: covers (almost) the whole canvas, opaque. Photoshop's locked Background layer (no
 *  transparency channel, full canvas) always counts. */
function isBackdrop(l: ArtLayer, W: number, H: number, noAlpha: boolean): boolean {
  if (l.clipped) return false;
  if (noAlpha && l.x <= 0 && l.y <= 0 && l.x + l.w >= W && l.y + l.h >= H) return true;
  if (l.w * l.h < W * H * 0.98) return false;
  let opaque = 0;
  for (let i = 3; i < l.rgba.length; i += 4) if (l.rgba[i] >= 250) opaque++;
  return opaque >= W * H * 0.98;
}

/** The colour of a solid-colour fill ('SoCo' block: version + action descriptor holding 'Clr ' as RGBC doubles; newer
 *  files may use 0..1 'redFloat' / 'greenFloat' / 'blueFloat'). Grey when the colour is in another model. */
function solidColour(b: Uint8Array): [number, number, number] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const find = (key: string) => {
    const pat = [...key, 'd', 'o', 'u', 'b'].map((c) => c.charCodeAt(0));
    for (let i = 0; i + pat.length + 8 <= b.length; i++) {
      let ok = true;
      for (let k = 0; k < pat.length && ok; k++) ok = b[i + k] === pat[k];
      if (ok) return dv.getFloat64(i + pat.length);
    }
    return null;
  };
  const r8 = find('Rd  '), g8 = find('Grn '), b8 = find('Bl  ');
  if (r8 !== null && g8 !== null && b8 !== null) return [r8, g8, b8].map((v) => Math.max(0, Math.min(255, Math.round(v)))) as [number, number, number];
  const rf = find('redFloat'), gf = find('greenFloat'), bf = find('blueFloat');
  if (rf !== null && gf !== null && bf !== null) return [rf, gf, bf].map((v) => Math.max(0, Math.min(255, Math.round(v * 255)))) as [number, number, number];
  return [128, 128, 128];
}

/** Vector path ('vmsk' / 'vsms' block: version, flags, then 26-byte path records) → coverage 0..1 over the canvas.
 *  Knots are 8.24 fixed-point fractions of the canvas (vertical first); sub-paths combine by their operation
 *  (union / subtract / intersect / xor). */
function pathCoverage(b: Uint8Array, W: number, H: number): Float32Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flags = b.length >= 8 ? dv.getUint32(4) : 0;
  const total = new Float32Array(W * H);
  if (flags & 4) { total.fill(1); return total; } // the mask is switched off
  const fx = (o: number) => dv.getInt32(o) / 16777216;
  type Knot = { pre: [number, number]; a: [number, number]; post: [number, number] };
  const subs: { knots: Knot[]; closed: boolean; op: number }[] = [];
  let cur: { knots: Knot[]; closed: boolean; op: number } | null = null;
  for (let o = 8; o + 26 <= b.length && subs.length < 64; o += 26) {
    const sel = dv.getUint16(o);
    if (sel === 0 || sel === 3) { cur = { knots: [], closed: sel === 0, op: dv.getInt16(o + 4) }; subs.push(cur); }
    else if (cur && cur.knots.length < 4096 && (sel === 1 || sel === 2 || sel === 4 || sel === 5)) {
      const pt = (k: number): [number, number] => [fx(o + 2 + k * 8 + 4) * W, fx(o + 2 + k * 8) * H];
      cur.knots.push({ pre: pt(0), a: pt(1), post: pt(2) });
    }
  }
  let first = true;
  for (const sp of subs) {
    const n = sp.knots.length;
    if (n < 2) continue;
    const poly: [number, number][] = [];
    for (let i = 0; i < (sp.closed ? n : n - 1); i++) {
      const k0 = sp.knots[i], k1 = sp.knots[(i + 1) % n];
      for (let s = 0; s < 16; s++) {
        const t = s / 16, u = 1 - t;
        poly.push([u * u * u * k0.a[0] + 3 * u * u * t * k0.post[0] + 3 * u * t * t * k1.pre[0] + t * t * t * k1.a[0],
          u * u * u * k0.a[1] + 3 * u * u * t * k0.post[1] + 3 * u * t * t * k1.pre[1] + t * t * t * k1.a[1]]);
      }
    }
    if (!sp.closed) poly.push(sp.knots[n - 1].a);
    const cov = fillPolygon(poly, W, H);
    const op = first ? 1 : sp.op;
    for (let i = 0; i < total.length; i++) {
      const a = total[i], c = cov[i];
      total[i] = op === 2 ? a * (1 - c) : op === 3 ? Math.min(a, c) : op === 0 ? Math.abs(a - c) : Math.max(a, c);
    }
    first = false;
  }
  if (flags & 1) for (let i = 0; i < total.length; i++) total[i] = 1 - total[i]; // inverted
  return total;
}

/** Non-zero polygon fill → coverage 0..1 (W*H): 4 sub-rows per pixel, exact horizontal span coverage. */
function fillPolygon(poly: [number, number][], W: number, H: number): Float32Array {
  const cov = new Float32Array(W * H);
  if (poly.length < 3) return cov;
  let y0 = Infinity, y1 = -Infinity;
  for (const p of poly) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const SUB = 4;
  const xs: { x: number; d: number }[] = [];
  for (let py = Math.max(0, Math.floor(y0)); py < Math.min(H, Math.ceil(y1)); py++) {
    for (let s = 0; s < SUB; s++) {
      const sy = py + (s + 0.5) / SUB;
      xs.length = 0;
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
        if ((ay <= sy) === (by <= sy)) continue;
        xs.push({ x: ax + ((sy - ay) / (by - ay)) * (bx - ax), d: by > ay ? 1 : -1 });
      }
      xs.sort((p, q) => p.x - q.x);
      let wind = 0;
      const row = py * W;
      for (let i = 0; i + 1 < xs.length; i++) {
        wind += xs[i].d;
        if (!wind) continue;
        const xa = Math.max(0, xs[i].x), xb = Math.min(W, xs[i + 1].x);
        for (let px = Math.floor(xa); px < xb; px++) {
          const c = Math.min(px + 1, xb) - Math.max(px, xa);
          if (c > 0) cov[row + px] += c / SUB;
        }
      }
    }
  }
  for (let i = 0; i < cov.length; i++) if (cov[i] > 1) cov[i] = 1;
  return cov;
}

/** A vector mask on a pixel layer: multiply its alpha by the path's coverage. */
function applyVectorMask(rgba: Uint8ClampedArray, x: number, y: number, w: number, h: number, vm: Uint8Array, W: number, H: number) {
  const cov = pathCoverage(vm, W, H);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const gx = x + i, gy = y + j;
    rgba[(j * w + i) * 4 + 3] *= gx >= 0 && gy >= 0 && gx < W && gy < H ? cov[gy * W + gx] : 0;
  }
}

function decodeLatin(b: Uint8Array) { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; }

function applyUserMask(rgba: Uint8ClampedArray, L: { left: number; top: number; right: number; bottom: number }, M: Uint8Array, m: { top: number; left: number; bottom: number; right: number; def: number }) {
  const w = L.right - L.left, h = L.bottom - L.top, mw = m.right - m.left;
  for (let y = 0; y < h; y++) {
    const gy = y + L.top;
    for (let x = 0; x < w; x++) {
      const gx = x + L.left;
      const v = gx >= m.left && gx < m.right && gy >= m.top && gy < m.bottom ? M[(gy - m.top) * mw + (gx - m.left)] : m.def;
      const i = (y * w + x) * 4 + 3;
      rgba[i] = (rgba[i] * v) / 255;
    }
  }
}

/** One channel → an 8-bit plane w*h. */
async function readChannel(r: Reader, comp: number, w: number, h: number, depth: number, psb: boolean, end: number): Promise<Uint8Array | null> {
  const bpc = depth / 8, rowBytes = w * bpc;
  let raw: Uint8Array;
  if (comp === 0) raw = r.bytes(rowBytes * h);
  else if (comp === 1) {
    const counts: number[] = [];
    for (let y = 0; y < h; y++) counts.push(psb ? r.u32() : r.u16());
    raw = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      const src = r.bytes(counts[y]);
      unpackBits(src, raw, y * rowBytes, rowBytes);
    }
  } else if (comp === 2 || comp === 3) {
    raw = await inflate(r.bytes(end - r.p));
    if (raw.length < rowBytes * h) throw new PsdError('ZIP channel too short');
    if (comp === 3) unpredict(raw, w, h, bpc);
  } else throw new PsdError(`unknown channel compression ${comp}`);
  if (bpc === 1) return raw;
  const out = new Uint8Array(w * h);
  if (bpc === 2) for (let i = 0; i < w * h; i++) out[i] = raw[i * 2];
  else {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < w * h; i++) { const f = dv.getFloat32(i * 4); out[i] = Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, f), 1 / 2.2) * 255))); }
  }
  return out;
}

/** PackBits (Apple RLE) decode into dst[off .. off + n). */
export function unpackBits(src: Uint8Array, dst: Uint8Array, off: number, n: number) {
  let i = 0, o = off;
  const end = off + n;
  while (i < src.length && o < end) {
    const c = src[i++];
    if (c < 128) { const k = c + 1; for (let j = 0; j < k && o < end && i < src.length; j++) dst[o++] = src[i++]; }
    else if (c > 128) { const k = 257 - c, v = src[i++]; for (let j = 0; j < k && o < end; j++) dst[o++] = v; }
  }
}

function unpredict(b: Uint8Array, w: number, h: number, bpc: number) {
  if (bpc === 1) { for (let y = 0; y < h; y++) { const o = y * w; for (let x = 1; x < w; x++) b[o + x] = (b[o + x] + b[o + x - 1]) & 255; } return; }
  if (bpc === 2) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { const o = (y * w + x) * 2; dv.setUint16(o, (dv.getUint16(o) + dv.getUint16(o - 2)) & 0xffff); }
    return;
  }
  // 32-bit: byte-plane delta per row, then the planes are interleaved big-endian
  const row = w * 4, tmp = new Uint8Array(row);
  for (let y = 0; y < h; y++) {
    const o = y * row;
    for (let x = 1; x < row; x++) b[o + x] = (b[o + x] + b[o + x - 1]) & 255;
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) tmp[x * 4 + k] = b[o + k * w + x];
    b.set(tmp, o);
  }
}

async function inflate(z: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new PsdError('ZIP-compressed layers need a newer browser');
  const stream = new Blob([z as BlobPart]).stream().pipeThrough(new DS('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
