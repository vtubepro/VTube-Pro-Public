// Files in and out of the rig editor (browser): a PSD, several PNGs (or a folder of them), or a .vtp2 (one made
// elsewhere, like an imported model, opens as an editable copy: shared/rig2d/edit/adopt.ts); PNG
// coding through the browser's own decoder / canvas encoder. Nothing is uploaded anywhere: the user's art stays on
// their computer unless they save or use the avatar.
import { parsePsd, isPsd, PsdError, unpackBits } from '../../shared/rig2d/edit/psd.ts';
import { layersFromPictures, fitArt, type ArtSet } from '../../shared/rig2d/edit/layers.ts';
import { openRig } from '../../shared/rig2d/edit/vtp2.ts';
import { isVtp2, browserInflateRaw } from '../../shared/rig2d/container.ts';
import { RIG2D } from '../../shared/rig2d/format.ts';
import type { EdDoc, EdTexture } from '../../shared/rig2d/edit/doc.ts';
import type { PicturePixels } from '../../shared/rig2d/edit/picture.ts';

/** `unread` (an imported model): texture pages its parts use that could not be decoded; those parts are blank, so the
 *  maker never saves them over a library avatar. */
export type Opened = { kind: 'art'; art: ArtSet; name: string } | { kind: 'picture'; pic: PicturePixels; name: string } | { kind: 'rig'; doc: EdDoc; textures: EdTexture[]; name: string; adopted?: boolean; unread?: number } | { kind: 'error'; message: string };

const relPath = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

export async function openFiles(files: File[]): Promise<Opened> {
  if (!files.length) return { kind: 'error', message: 'No file was dropped.' };
  const stem = (n: string) => n.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || 'My avatar';
  const rig = files.find((f) => f.name.toLowerCase().endsWith(RIG2D.ext));
  if (rig) {
    const bytes = new Uint8Array(await rig.arrayBuffer());
    if (!isVtp2(bytes)) return { kind: 'error', message: `"${rig.name}" is not a ${RIG2D.name} file.` };
    const r = await openRig(bytes, decodePng, browserInflateRaw);
    return r.ok ? { kind: 'rig', doc: r.doc, textures: r.textures, name: r.doc.name || stem(rig.name), ...(r.adopted ? { adopted: true } : {}), ...(r.unread ? { unread: r.unread } : {}) } : { kind: 'error', message: r.error };
  }
  const psd = files.find((f) => /\.(psd|psb)$/i.test(f.name));
  if (psd) {
    const bytes = new Uint8Array(await psd.arrayBuffer());
    if (!isPsd(bytes)) return { kind: 'error', message: `"${psd.name}" is not a Photoshop file. Save it again as .psd from your paint program.` };
    try {
      const f = await parsePsd(bytes);
      if (!f.layers.length) {
        // a flattened PSD is one flat picture: the tap step (eyes, mouth), like a PNG / JPG
        const flat = flatPsdPicture(bytes);
        if (flat) return { kind: 'picture', pic: shrinkPicture(flat), name: stem(psd.name) };
        return { kind: 'error', message: 'This PSD has no layers and we could not read its flat picture. Save it again as a PNG, or with its layers kept.' };
      }
      return { kind: 'art', art: fitArt({ width: f.width, height: f.height, layers: f.layers, warnings: f.warnings }), name: stem(psd.name) };
    } catch (e) {
      return { kind: 'error', message: e instanceof PsdError ? `We could not read this PSD: ${e.message}.` : 'We could not read this PSD.' };
    }
  }
  // ONE flat picture (PNG / JPG / WebP): the editor asks for three taps (eyes, mouth), shared/rig2d/edit/picture.ts
  const images = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name) || /^image\/(png|jpeg|webp)$/.test(f.type));
  if (images.length === 1 && files.length === 1) {
    try { return { kind: 'picture', pic: await decodePicture(images[0]), name: stem(images[0].name) }; } catch { return { kind: 'error', message: `"${images[0].name}" could not be read as a picture.` }; }
  }
  const pngs = files.filter((f) => /\.png$/i.test(f.name));
  if (pngs.length) {
    const pics = [];
    for (const f of pngs) {
      try { const d = await decodePng(new Uint8Array(await f.arrayBuffer())); pics.push({ path: relPath(f), w: d.w, h: d.h, rgba: d.rgba }); } catch { /* skip unreadable */ }
    }
    if (!pics.length) return { kind: 'error', message: 'None of these pictures could be read.' };
    if (pics.length === 1) return { kind: 'error', message: 'Only one of these pictures could be read. Drop a layered PSD, one PNG per part, or a single picture.' };
    const folder = relPath(pngs[0]).includes('/') ? relPath(pngs[0]).split('/')[0] : stem(pngs[0].name);
    return { kind: 'art', art: fitArt(layersFromPictures(pics)), name: folder };
  }
  return { kind: 'error', message: 'Drop a layered PSD, several PNG layers, one picture (PNG, JPG or WebP), or a 2D avatar made here.' };
}

/** A flattened PSD's merged picture (8-bit RGB or grey, raw or RLE; a 4th channel is its transparency), or null. */
export function flatPsdPicture(b: Uint8Array): PicturePixels | null {
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 4;
    const ver = dv.getUint16(p); p += 2; p += 6;
    const nch = dv.getUint16(p); p += 2;
    const h = dv.getUint32(p); p += 4; const w = dv.getUint32(p); p += 4;
    const depth = dv.getUint16(p); p += 2; const mode = dv.getUint16(p); p += 2;
    if (depth !== 8 || (mode !== 3 && mode !== 1) || !w || !h || w * h > 64e6 || nch < (mode === 1 ? 1 : 3)) return null;
    p += 4 + dv.getUint32(p);   // colour mode data
    p += 4 + dv.getUint32(p);   // image resources
    p += ver === 2 ? 8 + Number(dv.getBigUint64(p)) : 4 + dv.getUint32(p);   // layer and mask info
    const comp = dv.getUint16(p); p += 2;
    const n = w * h, planes = Math.min(nch, mode === 1 ? 2 : 4), chan = Array.from({ length: planes }, () => new Uint8Array(n));
    if (comp === 0) { for (let c = 0; c < planes; c++) chan[c].set(b.subarray(p + c * n, p + (c + 1) * n)); }
    else if (comp === 1) {
      const cw = ver === 2 ? 4 : 2;
      let pos = p + nch * h * cw;
      for (let c = 0; c < nch; c++) for (let y = 0; y < h; y++) {
        const len = ver === 2 ? dv.getUint32(p + (c * h + y) * cw) : dv.getUint16(p + (c * h + y) * cw);
        if (c < planes) unpackBits(b.subarray(pos, pos + len), chan[c], y * w, w);
        pos += len;
      }
    } else return null;
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      if (mode === 1) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = chan[0][i]; rgba[i * 4 + 3] = planes > 1 ? chan[1][i] : 255; }
      else { rgba[i * 4] = chan[0][i]; rgba[i * 4 + 1] = chan[1][i]; rgba[i * 4 + 2] = chan[2][i]; rgba[i * 4 + 3] = planes > 3 ? chan[3][i] : 255; }
    }
    return { w, h, rgba };
  } catch { return null; }
}

/** A picture scaled down (box average, premultiplied) so its long side is at most `maxSide` px. */
export function shrinkPicture(pic: PicturePixels, maxSide = 1536): PicturePixels {
  const k = Math.min(1, maxSide / Math.max(pic.w, pic.h));
  if (k >= 1) return pic;
  const w = Math.max(1, Math.round(pic.w * k)), h = Math.max(1, Math.round(pic.h * k)), acc = new Float64Array(w * h * 5);
  for (let y = 0; y < pic.h; y++) for (let x = 0; x < pic.w; x++) {
    const tx = Math.min(w - 1, Math.floor((x + 0.5) * k)), ty = Math.min(h - 1, Math.floor((y + 0.5) * k)), s = (y * pic.w + x) * 4, d = (ty * w + tx) * 5, a = pic.rgba[s + 3] / 255;
    acc[d] += pic.rgba[s] * a; acc[d + 1] += pic.rgba[s + 1] * a; acc[d + 2] += pic.rgba[s + 2] * a; acc[d + 3] += a; acc[d + 4]++;
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const a = acc[i * 5 + 3], c = acc[i * 5 + 4]; if (!a) continue; rgba[i * 4] = acc[i * 5] / a; rgba[i * 4 + 1] = acc[i * 5 + 1] / a; rgba[i * 4 + 2] = acc[i * 5 + 2] / a; rgba[i * 4 + 3] = (a / c) * 255; }
  return { w, h, rgba };
}

/** One picture file (PNG / JPG / WebP) as straight RGBA, at most `maxSide` px on its long side (the browser resizes while it decodes). */
export async function decodePicture(file: Blob, maxSide = 1536): Promise<PicturePixels> {
  const bmp = await createImageBitmap(file, { colorSpaceConversion: 'none' });
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { w, h, rgba: ctx.getImageData(0, 0, w, h).data };
}

/** A PNG's size from its header (null = not a PNG). */
function pngSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = dv.getUint32(16, false), h = dv.getUint32(20, false);
  return w && h ? { w, h } : null;
}

/** Decode a picture to straight-alpha RGBA. `scale` < 1 = straight to that fraction of its size (shared/rig2d/edit/vtp2.ts
 *  editDecodeScale: a huge imported page never exists at full size in the studio's tab; the browser resizes while it
 *  decodes, high quality). */
export async function decodePng(png: Uint8Array, scale = 1): Promise<{ w: number; h: number; rgba: Uint8ClampedArray }> {
  const k = scale > 0 && scale < 1 ? scale : 1;
  const sz = k < 1 ? pngSize(png) : null;
  const fit = (w: number, h: number) => ({ w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) });
  const to = sz ? fit(sz.w, sz.h) : null;
  // (resized with premultiplied alpha, so transparent pixels don't bleed dark fringes into the edges; the canvas below
  // keeps premultiplied pixels anyway)
  const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }), { premultiplyAlpha: to ? 'premultiply' : 'none', colorSpaceConversion: 'none',
    ...(to ? { resizeWidth: to.w, resizeHeight: to.h, resizeQuality: 'high' as const } : {}) });
  // (not a PNG header: decoded whole, then drawn smaller)
  const out = !to && k < 1 ? fit(bmp.width, bmp.height) : { w: bmp.width, h: bmp.height };
  const c = document.createElement('canvas');
  c.width = out.w; c.height = out.h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (out.w !== bmp.width || out.h !== bmp.height) { ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bmp, 0, 0, out.w, out.h); }
  else ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { w: c.width, h: c.height, rgba: d.data };
}

export async function encodePng(w: number, h: number, rgba: Uint8ClampedArray): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Small picture of a texture for lists / questions (data: URL), fitted into size × size. */
export function thumbURL(t: EdTexture, size = 56): string {
  const k = Math.min(1, size / Math.max(t.w, t.h));
  const src = document.createElement('canvas'); src.width = t.w; src.height = t.h;
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(t.rgba), t.w, t.h), 0, 0);
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(t.w * k)); c.height = Math.max(1, Math.round(t.h * k));
  const ctx = c.getContext('2d')!; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

/** Offer bytes as a download. */
export function download(bytes: Uint8Array, name: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
