// A layered PNGTuber save (PNGTuber Plus; PNGTuber Remix and any save with the same kind of sprite list) -> the few flat
// pictures a VTube Pro PNGTuber set needs: for every costume, "mouth closed", "mouth open", "eyes closed" and "both".
//
// What a save holds (names as the Godot apps write them; matched ignoring case, spaces and underscores): a list of
// sprites, each with its picture (base64 / bytes), id and parent id, position, offset, rotation, scale, z-index, the
// costumes it shows in (a row of 0/1), "show when talking" and "show when blinking" (0 = always). We stack the sprites
// the way the app does, once per look, on ONE canvas (so the character never jumps when the picture changes).
//
// Not carried: wobble / bounce / drag physics and blend modes (VTube Pro's own "When I talk" motion replaces them) and
// the app's own key letters (the looks come on the number keys, see docs/b16/PNGTUBER.md).
// [unknown] Written from the format as described, without a sample save: the meaning of the 1 and 2 in "show when
// talking / blinking" is settled from the sprites' own file names (see `settleShow`), and every layout guess is
// listed in docs/b16/PNGTUBER.md under "Needs a real save".
import { sniffImageMime } from '../gltf.ts';
import { bytesOf, norm, num, vec2, type Json } from './godot.ts';
import { apply, blank, decodePng, drawOver, firstFrame, hasInk, isPng, mul, encodePng, type Mat, type Raster } from './png.ts';

export type Role = 'idle' | 'talk' | 'blink' | 'talkBlink';
export const ROLES: readonly Role[] = ['idle', 'talk', 'blink', 'talkBlink'];
export interface Pic { bytes: Uint8Array; ext: 'png' | 'gif' | 'webp' | 'jpg' }
export interface Look { name: string; pics: Partial<Record<Role, Pic>> }
export interface Converted { source: 'plus' | 'remix' | 'veadotube'; looks: Look[]; warnings: string[]; notes: string[] }
export interface LayerDeps {
  /** Decode a non-PNG picture (the studio supplies this from a canvas); without it such layers are skipped with a note. */
  decodeImage?: (bytes: Uint8Array) => Promise<Raster | null>;
  /** Let the page breathe between pictures. */
  tick?: () => Promise<void>;
}

type Rec = Record<string, Json>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

/** Field names a sprite may use, by the normalised name (norm()). First hit wins. */
const F = {
  id: ['identification', 'id', 'spriteid', 'uid'],
  parent: ['parentid', 'parent'],
  image: ['imagedata', 'image', 'img', 'texture', 'png', 'imagebytes'],
  name: ['path', 'spritename', 'name', 'file', 'filename', 'label'],
  pos: ['pos', 'position'],
  offset: ['offset', 'off'],
  rot: ['rot', 'rotation'],
  scale: ['scale'],
  z: ['zindex', 'z'],
  costumes: ['costumelayers', 'costumes', 'costume'],
  talk: ['showtalk', 'showmouth', 'mouth'],
  blink: ['showblink', 'showeyes', 'eyes'],
  frames: ['frames', 'hframes', 'framecount'],
};
function get(r: Rec, names: string[]): Json | undefined {
  const keys = new Map<string, string>();
  for (const k of Object.keys(r)) keys.set(norm(k), k);
  for (const n of names) { const k = keys.get(n); if (k !== undefined && r[k] !== undefined && r[k] !== null) return r[k]; }
  return undefined;
}
const imageExt = (b: Uint8Array): Pic['ext'] | null => {
  const m = sniffImageMime(b);
  return m === 'image/png' ? 'png' : m === 'image/jpeg' ? 'jpg' : m === 'image/gif' ? 'gif' : m === 'image/webp' ? 'webp' : null;
};

interface Layer {
  index: number; id: string; parent: string; name: string; img: Uint8Array | null; folder: boolean;
  pos: [number, number]; off: [number, number]; rot: number; sc: [number, number]; z: number;
  costumes: boolean[] | null; talk: number; blink: number; frames: number;
}

/** Every sprite-like record in the save, in file order. */
function findSprites(root: Json): Rec[] {
  const out: Rec[] = [], seen = new Set<unknown>();
  const walk = (v: Json, depth: number) => {
    if (depth > 8 || !v || typeof v !== 'object' || v instanceof Uint8Array || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const imgV = get(v, F.image);
    const b = imgV !== undefined ? bytesOf(imgV) : null;
    const hasImg = !!b && !!imageExt(b);
    const folder = !hasImg && get(v, F.id) !== undefined && get(v, F.parent) !== undefined;
    if (hasImg || folder) out.push(v);
    for (const [k, x] of Object.entries(v)) if (!F.image.includes(norm(k))) walk(x, depth + 1);
  };
  walk(root, 0);
  return out;
}

function costumeRow(v: Json | undefined): boolean[] | null {
  let a: unknown = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { a = v.match(/\d+/g)?.map(Number) ?? null; } }
  if (!Array.isArray(a) || !a.length) return null;
  return a.slice(0, 10).map((x) => x === true || num(x) > 0);
}

function readLayers(root: Json): Layer[] {
  return findSprites(root).map((r, index): Layer => {
    const img = bytesOf(get(r, F.image));
    const nameV = get(r, F.name);
    const sc = get(r, F.scale);
    return {
      index, id: String(get(r, F.id) ?? `#${index}`), parent: String(get(r, F.parent) ?? ''),
      name: typeof nameV === 'string' ? (nameV.split(/[\\/]/).pop() ?? '') : '',
      img: img && imageExt(img) ? img : null, folder: !(img && imageExt(img)),
      pos: vec2(get(r, F.pos)), off: vec2(get(r, F.offset)), rot: num(get(r, F.rot)),
      sc: sc === undefined ? [1, 1] : vec2(sc, [1, 1]), z: num(get(r, F.z)),
      costumes: costumeRow(get(r, F.costumes)), talk: Math.round(num(get(r, F.talk))), blink: Math.round(num(get(r, F.blink))),
      frames: Math.max(1, Math.min(64, Math.round(num(get(r, F.frames), 1)))),
    };
  });
}

/** Local matrix of a node: translate(pos) * rotate(rot) * scale(sc). */
const local = (l: Layer): Mat => {
  const c = Math.cos(l.rot), s = Math.sin(l.rot);
  return [c * l.sc[0], s * l.sc[0], -s * l.sc[1], c * l.sc[1], l.pos[0], l.pos[1]];
};

/** Whether a layer shows for a state. `mode` 0 = always; 1 / 2 = only while the state is on / only while it is off
 *  (swapped when `flip`). */
const shows = (mode: number, on: boolean, flip: boolean) => mode === 0 || mode > 2 || ((mode === 1) !== flip ? on : !on);

const TALK_ON = /open|talk|speak|shout|yell|loud|scream|\bah\b|\boh\b/i, TALK_OFF = /clos|shut|quiet|idle|silent|rest|neutral|\bm\b/i;
const BLINK_ON = /blink|clos|shut|sleep|wink|squint/i, BLINK_OFF = /open|awake|wide/i;
/** Which way round "1" and "2" mean: the sprites' file names tell (mouth_open.png on 1 = talking). True = swap. */
export function settleShow(layers: Layer[], field: 'talk' | 'blink'): boolean {
  const on = field === 'talk' ? TALK_ON : BLINK_ON, off = field === 'talk' ? TALK_OFF : BLINK_OFF;
  let sum = 0;
  for (const l of layers) {
    const m = field === 'talk' ? l.talk : l.blink;
    if (m !== 1 && m !== 2 || !l.name) continue;
    const a = on.test(l.name), b = off.test(l.name);
    if (a === b) continue;
    sum += (m === 1) === a ? 1 : -1;
  }
  return sum < 0;
}

const sameBytes = (a: Raster, b: Raster) => { if (a.data.length !== b.data.length) return false; for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false; return true; };
const nap = () => new Promise<void>((r) => setTimeout(r, 0));

/** Flatten the save. Returns an error sentence instead of looks when there is nothing to draw. */
export async function flattenLayered(root: Json, source: Converted['source'], deps: LayerDeps = {}): Promise<Converted | { error: string }> {
  const layers = readLayers(root);
  const warnings: string[] = [], notes: string[] = [];
  if (!layers.some((l) => l.img)) return { error: 'There are no pictures inside this save.' };
  const tick = deps.tick ?? nap;
  const byId = new Map<string, Layer>();
  for (const l of layers) if (!byId.has(l.id)) byId.set(l.id, l);

  // world matrices and stacking order (a child sits in its parent's space; z adds up the parent chain, as in the engine)
  const world = new Map<Layer, Mat>(), zsum = new Map<Layer, number>();
  const chain = (l: Layer, depth = 0): Mat => {
    const got = world.get(l);
    if (got) return got;
    const p = l.parent && l.parent !== l.id && depth < 32 ? byId.get(l.parent) : undefined;
    const m = p && p !== l ? mul(chain(p, depth + 1), local(l)) : local(l);
    world.set(l, m); zsum.set(l, (p && p !== l ? (zsum.get(p) ?? 0) : 0) + l.z);
    return m;
  };
  for (const l of layers) chain(l);

  // pictures -> pixels
  const ras = new Map<Layer, Raster>();
  let skipped = 0;
  for (const l of layers) {
    if (!l.img) continue;
    try {
      let r: Raster | null = null;
      if (isPng(l.img)) r = decodePng(l.img);
      else if (deps.decodeImage) r = await deps.decodeImage(l.img);
      if (!r) { skipped++; continue; }
      ras.set(l, firstFrame(r, l.frames));
    } catch (e) { skipped++; warnings.push(`One picture was skipped: ${(e as Error).message}.`); }
    await tick();
  }
  if (skipped) warnings.push(`${skipped} picture${skipped > 1 ? 's' : ''} in the save couldn’t be read and ${skipped > 1 ? 'are' : 'is'} left out.`);
  const drawn = layers.filter((l) => ras.has(l)).sort((a, b) => (zsum.get(a) ?? 0) - (zsum.get(b) ?? 0) || a.index - b.index);
  if (!drawn.length) return { error: 'None of the pictures in this save could be read.' };
  if (layers.some((l) => l.rot && Math.abs(l.rot) > 6.4)) warnings.push('Some layers are rotated by large angles; check the result looks right.');

  // costumes
  const n = Math.min(10, Math.max(1, ...drawn.map((l) => l.costumes?.length ?? 1)));
  const inCostume = (l: Layer, c: number) => !l.costumes || !!l.costumes[c];
  const used = Array.from({ length: n }, (_, c) => c).filter((c) => drawn.some((l) => inCostume(l, c) && hasInk(ras.get(l)!)));
  if (!used.length) used.push(0);
  const flipTalk = settleShow(drawn, 'talk'), flipBlink = settleShow(drawn, 'blink');

  // one canvas for every picture: the box all the stacked sprites of all looks fit in, at most 2048 tall
  const matOf = (l: Layer): Mat => { const r = ras.get(l)!; return mul(world.get(l)!, [1, 0, 0, 1, -r.w / 2 + l.off[0], -r.h / 2 + l.off[1]]); };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of drawn) {
    if (!used.some((c) => inCostume(l, c)) || !hasInk(ras.get(l)!)) continue;
    const r = ras.get(l)!, m = matOf(l);
    for (const [x, y] of [[0, 0], [r.w, 0], [0, r.h], [r.w, r.h]]) { const [X, Y] = apply(m, x, y); minX = Math.min(minX, X); maxX = Math.max(maxX, X); minY = Math.min(minY, Y); maxY = Math.max(maxY, Y); }
  }
  if (!Number.isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) return { error: 'The pictures in this save are empty.' };
  const k = Math.min(1, 2048 / (maxY - minY), 4096 / (maxX - minX));
  const W = Math.max(1, Math.ceil((maxX - minX) * k - 1e-6)), H = Math.max(1, Math.ceil((maxY - minY) * k - 1e-6));
  const to: Mat = [k, 0, 0, k, -minX * k, -minY * k];
  if (k < 1) notes.push(`The pictures were scaled down to ${H} px tall.`);

  const render = async (c: number, talking: boolean, blinking: boolean): Promise<Raster> => {
    const out = blank(W, H);
    for (const l of drawn) {
      if (!inCostume(l, c) || !shows(l.talk, talking, flipTalk) || !shows(l.blink, blinking, flipBlink)) continue;
      drawOver(out, ras.get(l)!, mul(to, matOf(l)));
    }
    await tick();
    return out;
  };

  const looks: Look[] = [];
  for (const c of used) {
    const vis = drawn.filter((l) => inCostume(l, c));
    const idle = await render(c, false, false);
    if (!hasInk(idle)) continue;
    const pics: Look['pics'] = { idle: { bytes: encodePng(idle), ext: 'png' } };
    let talk: Raster | null = null, blink: Raster | null = null;
    if (vis.some((l) => l.talk)) { const t = await render(c, true, false); if (!sameBytes(t, idle)) talk = t; }
    if (vis.some((l) => l.blink)) { const b = await render(c, false, true); if (!sameBytes(b, idle)) blink = b; }
    if (talk) pics.talk = { bytes: encodePng(talk), ext: 'png' };
    if (blink) pics.blink = { bytes: encodePng(blink), ext: 'png' };
    if (talk && blink) pics.talkBlink = { bytes: encodePng(await render(c, true, true)), ext: 'png' };
    looks.push({ name: `Look ${c + 1}`, pics });
  }
  if (!looks.length) return { error: 'The pictures in this save are empty.' };
  if (!looks[0].pics.talk) warnings.push('This save has no “mouth open” layer, so the picture will hop while you talk.');
  if (looks.length < n && used.length < n) notes.push('Costumes with nothing in them were left out.');
  if (layers.some((l) => l.talk > 2 || l.blink > 2)) warnings.push('Some layers use a “show when” setting this version doesn’t know; they are shown all the time.');
  return { source, looks, warnings, notes };
}
