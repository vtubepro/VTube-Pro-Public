// "Bring your overlay": whatever a creator already has → one 2.5D overlay (shared/overlayStage.ts), planned in the
// browser and sent to the helper as a stored .zip (POST /api/overlays/import):
//   * an OBS scene collection export (.json) + the pictures / videos it uses (or the folder / a zip with them);
//   * a layered PSD / PSB (a layer or folder named avatar / model / vtuber / me … marks where the performer stands);
//   * loose pictures / animated GIFs / WebM or MP4 loops (a VTube Studio background, an overlay pack, a numbered set);
//   * a VTube Pro overlay (.zip or folder with overlay.json).
// Zero settings: sides, order, depth, the performer's place and the layers' life come from the files themselves.
import { unzipSync, zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import {
  OVERLAY_FILE, OVERLAY_FORMAT, OVERLAY_LIMITS, canvasFit, isObsCollection, isOverlayVideo, matchObsPath, overlayFiles, overlayMediaType,
  planOverlayFromMedia, planOverlayFromObs, planOverlayFromPsd, sanitizeOverlay, type OverlayConfig, type OverlayMediaInfo,
} from '../../../shared/overlayStage.ts';
import { isPsd, parsePsd } from '../../../shared/rig2d/edit/psd.ts';

export interface OverlayInFile { path: string; blob: Blob }
export interface OverlayPlan { config: OverlayConfig; files: Map<string, Blob>; notes: string[]; thumb: Blob | null }

const junk = (p: string) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(p) || /(^|\/)\._/.test(p);
const base = (p: string) => (p.split(/[\\/]/).pop() ?? p);

/** Files as path → blob, zips opened (one level, plus a zip inside the zip). */
export async function expandOverlayFiles(files: File[]): Promise<OverlayInFile[]> {
  const out: OverlayInFile[] = [];
  const add = async (path: string, blob: Blob, depth: number) => {
    if (junk(path)) return;
    if (/\.zip$/i.test(path) && depth < 2) {
      let entries: Record<string, Uint8Array>;
      try { entries = unzipSync(new Uint8Array(await blob.arrayBuffer())); } catch { throw new Error(`${base(path)} could not be opened (a damaged zip?).`); }
      for (const [p, b] of Object.entries(entries)) if (!p.endsWith('/')) await add(p, new Blob([b.slice().buffer as ArrayBuffer]), depth + 1);
      return;
    }
    out.push({ path: path.replace(/\\/g, '/'), blob });
  };
  for (const f of files) await add((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, f, 0);
  return out;
}

/** Measure a picture / video: size, how opaque, where its art is, whether it is a frame (see OverlayMediaInfo). */
export async function measureMedia(path: string, blob: Blob): Promise<OverlayMediaInfo | null> {
  const video = isOverlayVideo(path);
  let src: CanvasImageSource, w: number, h: number, close = () => {};
  try {
    if (video) {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      const url = URL.createObjectURL(blob);
      // set before the wait: a video Chrome can't play (ProRes .mov) or a slow one lets go of its bytes too
      close = () => { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); };
      v.src = url;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error('video')); timer = setTimeout(() => rej(new Error('timeout')), 8000); });
      } finally { clearTimeout(timer); }
      w = v.videoWidth; h = v.videoHeight; src = v;
    } else {
      const b = await createImageBitmap(blob);
      w = b.width; h = b.height; src = b; close = () => b.close();
    }
  } catch { close(); return null; }
  try {
    const k = Math.min(1, 256 / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return { path, w, h, opaque: video ? 1 : 0.5, bbox: [0, 0, 1, 1], frame: false, ...(video ? { video } : {}) };
    g.drawImage(src, 0, 0, cw, ch);
    const d = g.getImageData(0, 0, cw, ch).data;
    c.width = c.height = 0;
    let op = 0, x0 = cw, y0 = ch, x1 = -1, y1 = -1, edge = 0, edgeOp = 0, mid = 0, midOp = 0;
    const bx = cw * 0.08, by = ch * 0.08;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const a = d[(y * cw + x) * 4 + 3];
      if (a > 200) op++;
      if (a > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const isEdge = x < bx || x >= cw - bx || y < by || y >= ch - by;
      const isMid = x > cw * 0.25 && x < cw * 0.75 && y > ch * 0.25 && y < ch * 0.75;
      if (isEdge) { edge++; if (a > 200) edgeOp++; }
      if (isMid) { mid++; if (a > 20) midOp++; }
    }
    const n = cw * ch;
    const bbox: [number, number, number, number] = x1 < 0 ? [0, 0, 1, 1] : [x0 / cw, y0 / ch, (x1 + 1) / cw, (y1 + 1) / ch];
    return { path, w, h, opaque: op / n, bbox, frame: edge > 0 && edgeOp / edge > 0.6 && mid > 0 && midOp / mid < 0.05, ...(video ? { video } : {}) };
  } finally { close(); }
}

/** One picture's straight RGBA → a PNG blob. */
async function pngOf(rgba: Uint8ClampedArray, w: number, h: number): Promise<Blob> {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const b = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  c.width = c.height = 0;
  if (!b) throw new Error('This browser could not save a layer picture.');
  return b;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'layer';

/** Plan an overlay from dropped / picked files (see the top of this file). Throws a plain sentence when it can't. */
export async function planOverlayUpload(input: File[], name?: string): Promise<OverlayPlan> {
  const files = await expandOverlayFiles(input);
  if (!files.length) throw new Error('Nothing to use in that drop.');
  const guessName = name || (((input[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '').split('/')[0]) || base(input[0].name).replace(/\.[^.]+$/, '') || 'My overlay';
  const media = files.filter((f) => overlayMediaType(f.path));
  const jsons = files.filter((f) => /\.json$/i.test(f.path));
  let config: OverlayConfig | null = null, notes: string[] = [];
  const out = new Map<string, Blob>();

  // 1. a VTube Pro overlay as it is
  for (const j of jsons) {
    if (base(j.path) !== OVERLAY_FILE) continue;
    let raw: unknown; try { raw = JSON.parse(await j.blob.text()); } catch { continue; }
    const c = sanitizeOverlay(raw);
    if (!c || (raw as { format?: string }).format !== OVERLAY_FORMAT) continue;
    const root = j.path.slice(0, j.path.length - OVERLAY_FILE.length);
    for (const rel of overlayFiles(c)) { const f = files.find((x) => x.path === root + rel) ?? files.find((x) => base(x.path) === base(rel)); if (f) out.set(rel, f.blob); }
    c.layers = c.layers.filter((l) => !l.file || out.has(l.file));
    config = sanitizeOverlay(c);
    if (config) break;
  }
  // 2. an OBS scene collection
  if (!config) for (const j of jsons) {
    if (j.blob.size > 32 << 20) continue;
    let raw: unknown; try { raw = JSON.parse(await j.blob.text()); } catch { continue; }
    if (!isObsCollection(raw)) continue;
    const measured: OverlayMediaInfo[] = [];
    for (const m of media) { const info = await measureMedia(m.path, m.blob); if (info) measured.push(info); }
    const r = planOverlayFromObs(raw, (p) => matchObsPath(measured, p));
    if ('error' in r) throw new Error(r.error);
    for (const [target, from] of r.files) { const f = files.find((x) => x.path === from); if (f) out.set(target, f.blob); }
    config = r.config; notes = r.notes;
    break;
  }
  // 3. a layered PSD
  const psd = !config ? files.find((f) => /\.(psd|psb)$/i.test(f.path)) : undefined;
  if (psd) {
    const bytes = new Uint8Array(await psd.blob.arrayBuffer());
    if (!isPsd(bytes)) throw new Error(`${base(psd.path)} is not a Photoshop file.`);
    const p = await parsePsd(bytes, { keepBackdrop: true });
    const names: string[] = [];
    const layers = p.layers.map((l, i) => {
      let op = 0; for (let k = 3; k < l.rgba.length; k += 4) if (l.rgba[k] > 200) op++;
      names[i] = `layers/${String(i + 1).padStart(3, '0')}_${slug(l.name)}.png`;
      return { name: l.name, path: l.path, x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity, visible: l.visible, blend: l.blend, opaque: op / Math.max(1, l.w * l.h) };
    });
    const r = planOverlayFromPsd({ width: p.width, height: p.height, layers }, guessName, (i) => names[i]);
    if ('error' in r) throw new Error(r.error);
    for (let i = 0; i < p.layers.length; i++) {
      if (r.skip.has(i)) continue;
      const l = p.layers[i];
      out.set(names[i], await pngOf(l.rgba, l.w, l.h));
    }
    config = r.config; notes = [...r.notes, ...p.warnings.slice(0, 3)];
  }
  // 4. loose pictures / videos
  if (!config) {
    if (!media.length) throw new Error(jsons.length ? 'That JSON is not an OBS scene collection or a VTube Pro overlay.' : 'Drop pictures, a PSD, a video loop or your OBS scene collection export.');
    const infos: OverlayMediaInfo[] = [];
    for (const m of media.slice(0, OVERLAY_LIMITS.layers)) { const i = await measureMedia(m.path, m.blob); if (i) infos.push(i); }
    const r = planOverlayFromMedia(infos, guessName);
    if ('error' in r) throw new Error(r.error);
    // flatten names: keep the file name (unique)
    const rename = new Map<string, string>();
    for (const l of r.config.layers) {
      if (!l.file) continue;
      let n = base(l.file).replace(/[^A-Za-z0-9_. -]/g, '_'), k = 2;
      while ([...rename.values()].includes(n)) n = n.replace(/(\.[^.]+)?$/, `_${k++}$1`);
      rename.set(l.file, n);
      const f = media.find((x) => x.path === l.file);
      if (f) out.set(n, f.blob);
      l.file = n;
    }
    config = sanitizeOverlay(r.config); notes = r.notes;
  }
  if (!config) throw new Error('None of those files could be used as a layer.');
  if (name) config.name = name;
  let total = 0;
  for (const b of out.values()) { if (b.size > OVERLAY_LIMITS.file) throw new Error(`One layer file is ${Math.ceil(b.size / 1048576)} MB; at most ${OVERLAY_LIMITS.file >> 20} MB each.`); total += b.size; }
  if (total > OVERLAY_LIMITS.total) throw new Error(`This overlay is ${Math.ceil(total / 1048576)} MB; at most ${OVERLAY_LIMITS.total >> 20} MB.`);
  return { config, files: out, notes, thumb: await overlayThumb(config, out) };
}

/** A small preview picture of the overlay (pictures and colour panels; videos as their first frame when they load). */
export async function overlayThumb(c: OverlayConfig, files: Map<string, Blob>, w = 480, h = 270): Promise<Blob | null> {
  try {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); if (!g) return null;
    g.fillStyle = '#1b2026'; g.fillRect(0, 0, w, h);
    const f = canvasFit(c.canvas, c.fit, w, h);
    const draw = async (l: OverlayConfig['layers'][number]) => {
      const r = l.rect ?? [0, 0, c.canvas[0], c.canvas[1]];
      const x = f.ox + r[0] * f.s, y = f.oy + r[1] * f.s, ww = r[2] * f.s, hh = r[3] * f.s;
      g.globalAlpha = l.opacity ?? 1;
      if (l.color) { g.fillStyle = l.color; g.fillRect(x, y, ww, hh); }
      else if (l.file && !isOverlayVideo(l.file)) { const b = files.get(l.file); if (b) { const bm = await createImageBitmap(b); g.drawImage(bm, x, y, ww, hh); bm.close(); } }
      g.globalAlpha = 1;
    };
    for (const l of c.layers.filter((x) => x.side === 'back' && !x.hidden)) await draw(l);
    // the performer's place: a soft silhouette
    const a = c.avatar;
    if (a) {
      const ph = a.scale * h, pw = ph * 0.55, cx = w / 2 + a.x * w, bottom = h + a.y * h;
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.beginPath(); g.ellipse(cx, bottom - ph * 0.78, pw * 0.3, ph * 0.17, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(cx, bottom - ph * 0.22, pw * 0.5, ph * 0.34, 0, 0, Math.PI * 2); g.fill();
    }
    for (const l of c.layers.filter((x) => x.side === 'front' && !x.hidden)) await draw(l);
    const b = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/jpeg', 0.86));
    cv.width = cv.height = 0;
    return b;
  } catch { return null; }
}

/** Send a planned overlay to the helper → its id. */
export async function uploadOverlay(p: OverlayPlan): Promise<{ id: string; name: string; layers: number; missing?: string[] }> {
  const entries: Record<string, Uint8Array> = { [OVERLAY_FILE]: new TextEncoder().encode(JSON.stringify(p.config, null, 2)) };
  for (const [rel, b] of p.files) entries[rel] = new Uint8Array(await b.arrayBuffer());
  if (p.thumb) entries['thumb.jpg'] = new Uint8Array(await p.thumb.arrayBuffer());
  const z = zipSync(entries, { level: 0 });
  const r = await fetch(`/api/overlays/import?name=${encodeURIComponent(p.config.name)}`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: new Blob([z.slice().buffer as ArrayBuffer], { type: 'application/zip' }) });
  const j = await r.json().catch(() => ({})) as { error?: string; id?: string; name?: string; layers?: number; missing?: string[] };
  if (!r.ok || !j.id) throw new Error(j.error ?? `VTube Pro said ${r.status}.`);
  return j as { id: string; name: string; layers: number; missing?: string[] };
}
