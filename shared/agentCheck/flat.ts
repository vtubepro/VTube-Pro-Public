// Flat pictures: a PNGTuber set (idle / talk / blink … pictures, shared/flatImport.ts planPictures: the same names the
// studio's import reads) and a 2D room made of picture layers (shared/flat2dRoom.ts: the "make a 2D room from
// pictures" route and the scene.json `flat2d` key). The pictures themselves are read too: same size across a set (or
// the character jumps when the picture changes), a transparent background, big enough for a 1080p stream.
import { planPictures, pictureRole, sniffImage, FLAT_LIMITS, FLAT_IMAGE_EXT } from '../flatImport.ts';
import { planFlat2dLayers, sanitizeFlat2d, type Flat2dConfig } from '../flat2dRoom.ts';
import { readPngRows } from '../rig2d/gpu/png.ts';
import { DOC, finish, type CheckFile, type CheckItem, type CheckResult } from './types.ts';

/** PNGTuber picture size: the tallest side (px). Below `min` it is soft on a 1080p canvas. */
export const PNG_SIZE = { min: 800, good: 1200, max: 4096 };

const base = (p: string) => p.split('/').pop() ?? p;
const ext = (p: string) => (/\.[^./]+$/.exec(p.toLowerCase()) ?? [''])[0];

export interface PictureFacts { path: string; format: string; w: number; h: number; alpha: 'transparent' | 'opaque' | 'unknown'; edgeAlpha: number; bytes: number }

/** Size and transparency of a picture (PNG fully; other formats: the header only). `edgeAlpha` = share of border
 *  pixels that are not fully transparent (a "background box" shows as 1). */
export function pictureFacts(f: CheckFile): PictureFacts | null {
  const fmt = sniffImage(f.bytes);
  if (!fmt) return null;
  const out: PictureFacts = { path: f.path, format: fmt, w: 0, h: 0, alpha: 'unknown', edgeAlpha: 0, bytes: f.bytes.byteLength };
  if (fmt === 'png') {
    let opaque = true, edge = 0, edgeN = 0, w = 0, h = 0;
    try {
      const hdr = readPngRows(f.bytes, (y, row) => {
        const W = row.length >> 2;
        for (let x = 0; x < W; x++) {
          const a = row[x * 4 + 3];
          if (a < 255) opaque = false;
          if (y === 0 || x === 0 || x === W - 1) { edgeN++; if (a > 8) edge++; }
        }
      });
      w = hdr.w; h = hdr.h;
    } catch { return { ...out, format: 'png (damaged)' }; }
    return { ...out, w, h, alpha: opaque ? 'opaque' : 'transparent', edgeAlpha: edgeN ? edge / edgeN : 0 };
  }
  const b = f.bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (fmt === 'gif' && b.length >= 10) { out.w = dv.getUint16(6, true); out.h = dv.getUint16(8, true); }
  if (fmt === 'jpeg') {
    out.alpha = 'opaque';
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) break;
      const m = b[i + 1], len = dv.getUint16(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { out.h = dv.getUint16(i + 5); out.w = dv.getUint16(i + 7); break; }
      i += 2 + len;
    }
  }
  if (fmt === 'webp' && b.length >= 30) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8X') { out.w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16)); out.h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16)); out.alpha = b[20] & 0x10 ? 'transparent' : 'opaque'; }
    else if (chunk === 'VP8L') { const v = dv.getUint32(21, true); out.w = 1 + (v & 0x3fff); out.h = 1 + ((v >> 14) & 0x3fff); out.alpha = (v >> 28) & 1 ? 'transparent' : 'opaque'; }
    else if (chunk === 'VP8 ') { out.w = dv.getUint16(26, true) & 0x3fff; out.h = dv.getUint16(28, true) & 0x3fff; out.alpha = 'opaque'; }
  }
  return out;
}

// ---------------------------------------------------------------- PNGTuber
export function checkPngtuber(files: CheckFile[], name: string): CheckResult {
  const items: CheckItem[] = [];
  const pics = files.filter((f) => FLAT_IMAGE_EXT.includes(ext(f.path)));
  const plan = planPictures(pics.map((f) => f.path));
  if ('error' in plan) {
    items.push({ id: 'roles', level: 'error', what: plan.error, fix: 'Name the pictures idle.png (mouth closed) and talk.png (mouth open); add blink.png and talk_blink.png for blinking.', doc: DOC.pngtuber });
    return finish('pngtuber', name, items, {}, 'PNGTuber set');
  }
  // what goes where
  const roles: Record<string, string> = { idle: plan.idle, ...(plan.talk ? { talk: plan.talk } : {}), ...(plan.blink ? { blink: plan.blink } : {}), ...(plan.talkBlink ? { talkBlink: plan.talkBlink } : {}) };
  items.push({ id: 'roles', level: 'ok', what: `Default look: ${Object.entries(roles).map(([r, f]) => `${r} = ${base(f)}`).join(', ')}.` });
  if (plan.states.length) items.push({ id: 'states', level: 'ok', what: `${plan.states.length} extra look${plan.states.length === 1 ? '' : 's'} (keys 1-9): ${plan.states.map((s) => s.name).join(', ')}.` });
  for (const w of plan.warnings) items.push({ id: 'roles', level: /No talking picture/.test(w) ? 'warn' : /Not used|Two /.test(w) ? 'warn' : 'info', what: w, fix: 'Name each picture by its role: idle, talk, blink, talk_blink; extra looks as <look>_idle.png, <look>_talk.png.', doc: DOC.pngtuber });
  if (!plan.blink) items.push({ id: 'roles.blink', level: 'info', what: 'No blink picture: the avatar never blinks.', fix: 'Add blink.png (idle with eyes closed) and talk_blink.png.', doc: DOC.pngtuber });
  // names that read as another role ("eyes_open" says "open" = talk)
  for (const f of pics) {
    const n = base(f.path).toLowerCase();
    if (/eyes?[_ -]?open|open[_ -]?eyes?/.test(n) && pictureRole(f.path) === 'talk') items.push({ id: 'roles.names', level: 'warn', what: `${base(f.path)} is read as a TALK picture ("open" means the mouth).`, fix: `Rename it: idle.png for eyes open + mouth closed, talk.png for mouth open.`, doc: DOC.pngtuber });
  }
  // the pictures themselves
  const used = new Set([plan.idle, plan.talk, plan.blink, plan.talkBlink, ...plan.states.flatMap((s) => [s.idle, s.talk, s.blink, s.talkBlink])].filter(Boolean) as string[]);
  const facts = pics.filter((f) => used.has(f.path)).map(pictureFacts).filter((x): x is PictureFacts => !!x);
  judgePictures(facts, items, 'pngtuber');
  const idle = files.find((f) => f.path === plan.idle), talk = plan.talk ? files.find((f) => f.path === plan.talk) : undefined;
  if (idle && talk && idle.bytes.length === talk.bytes.length && idle.bytes.every((v, i) => v === talk.bytes[i])) items.push({ id: 'roles.same', level: 'warn', what: 'The idle and talk pictures are the same file: the mouth never moves.', fix: 'Draw the talk picture with the mouth open.', doc: DOC.pngtuber });
  return finish('pngtuber', name, items, { roles, states: plan.states.map((s) => s.name), pictures: facts }, 'PNGTuber set');
}

function judgePictures(facts: PictureFacts[], items: CheckItem[], kind: 'pngtuber' | 'flat2d-room') {
  const doc = kind === 'pngtuber' ? DOC.pngtuber : DOC.flat2d;
  for (const p of facts) {
    if (p.bytes > FLAT_LIMITS.image) items.push({ id: 'pictures.size', level: 'error', what: `${base(p.path)} is ${Math.round(p.bytes / 1048576)} MB (at most ${FLAT_LIMITS.image >> 20} MB).`, fix: 'Save it smaller (PNG at a smaller size, or WebP).', doc });
    if (/damaged/.test(p.format)) items.push({ id: 'pictures', level: 'error', what: `${base(p.path)} is a damaged PNG.`, fix: 'Save it again.', doc });
  }
  if (kind === 'pngtuber') {
    const sizes = new Set(facts.filter((p) => p.w).map((p) => `${p.w}×${p.h}`));
    if (sizes.size > 1) items.push({ id: 'pictures.match', level: 'warn', what: `The pictures are different sizes (${[...sizes].join(', ')}): the character jumps when the picture changes.`, fix: 'Export every picture from the same canvas, same size, character in the same place.', doc });
    const small = facts.filter((p) => p.h && Math.max(p.w, p.h) < PNG_SIZE.min);
    if (small.length) items.push({ id: 'pictures.res', level: 'warn', what: `${small.map((p) => `${base(p.path)} (${p.w}×${p.h})`).join(', ')}: too small, soft on a 1080p stream.`, fix: `Make them at least ${PNG_SIZE.good} px tall.`, doc });
    const huge = facts.filter((p) => Math.max(p.w, p.h) > PNG_SIZE.max);
    if (huge.length) items.push({ id: 'pictures.res', level: 'info', what: `${huge.length} picture${huge.length === 1 ? ' is' : 's are'} over ${PNG_SIZE.max} px: more memory for no visible gain.`, fix: `About ${PNG_SIZE.good}-2048 px tall is plenty.`, doc });
    const opaque = facts.filter((p) => p.alpha === 'opaque' || p.edgeAlpha > 0.9);
    if (opaque.length) items.push({ id: 'pictures.alpha', level: 'warn', what: `${opaque.map((p) => base(p.path)).join(', ')}: no transparent background, so a box shows around the character.`, fix: 'Save as PNG with a transparent background (not JPEG; no white or checkerboard fill).', doc });
    if (!items.some((i) => i.id.startsWith('pictures') && i.level !== 'ok' && i.level !== 'info')) items.push({ id: 'pictures', level: 'ok', what: `${facts.length} picture${facts.length === 1 ? '' : 's'}, ${[...sizes].join(', ') || 'size unknown'}, transparent.` });
  }
}

// ---------------------------------------------------------------- 2D rooms (picture layers)
/** A 2D room: a scene.json with a `flat2d` key (+ its pictures), or just the pictures (POST /api/rooms/import-flat2d
 *  orders them by name: 1_sky.png, 2_hills.png …). */
export function checkFlat2dRoom(files: CheckFile[], name: string): CheckResult {
  const items: CheckItem[] = [];
  const sj = files.find((f) => base(f.path).toLowerCase() === 'scene.json');
  const pics = files.filter((f) => /\.(png|webp|jpe?g|gif)$/i.test(f.path) && !/^(preview|thumb)\.png$/i.test(base(f.path)));
  let cfg: Flat2dConfig | null = null;
  const facts: Record<string, unknown> = {};
  if (sj) {
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(new TextDecoder().decode(sj.bytes)); } catch { /* below */ }
    const fl = raw?.flat2d as { layers?: unknown[] } | undefined;
    if (!raw || !fl) {
      items.push({ id: 'scene', level: 'error', what: raw ? 'scene.json has no "flat2d" key.' : 'scene.json is not valid JSON.', fix: 'A 2D room’s scene.json has "flat2d": { "layers": [...] } (shared/flat2dRoom.ts). Or hand over only the numbered pictures and let VTube Pro build the room.', doc: DOC.flat2d });
      return finish('flat2d-room', name, items, facts, '2D room');
    }
    cfg = sanitizeFlat2d(fl);
    const rawLayers = Array.isArray(fl.layers) ? fl.layers : [];
    if (!cfg) { items.push({ id: 'layers', level: 'error', what: 'No usable layer in flat2d.layers.', fix: 'Each layer needs a "file" (or a drawn kind: gradient, sky, clouds, hills, trees, grass, frame) and a "depth" in metres.', doc: DOC.flat2d }); return finish('flat2d-room', name, items, facts, '2D room'); }
    if (cfg.layers.length < Math.min(rawLayers.length, 20)) items.push({ id: 'layers', level: 'warn', what: `${rawLayers.length - cfg.layers.length} layer${rawLayers.length - cfg.layers.length === 1 ? ' was' : 's were'} dropped (no file / kind, bad colour, or over 20 layers).`, fix: 'Colours are "#rrggbb"; every layer has exactly one of file / gradient / sky / clouds / hills / trees / grass / frame.', doc: DOC.flat2d });
    rawLayers.forEach((l) => {
      const o = (l ?? {}) as Record<string, unknown>;
      if (typeof o.depth === 'number' && o.depth < 0.5 && !o.grass && !o.frame) items.push({ id: 'layers.front', level: 'warn', what: `Layer ${typeof o.file === 'string' ? o.file : '(drawn)'} has depth ${o.depth}: picture layers can’t stand in front of the performers, so it is pushed back to 0.5 m.`, fix: 'Only grass and frame layers may have a negative depth. A desk or prop in front of a 2D avatar is a 2.5D overlay (see the guide), not a room layer.', doc: DOC.flat2d });
      if (typeof o.file === 'string' && !files.some((f) => f.path.endsWith(o.file as string))) items.push({ id: 'layers.file', level: 'error', what: `Layer picture ${o.file} is not in the folder.`, fix: 'Put every picture scene.json names next to it (relative paths).', doc: DOC.flat2d });
    });
  } else {
    const p = planFlat2dLayers(pics.map((f) => f.path));
    if ('error' in p) { items.push({ id: 'layers', level: 'error', what: p.error, fix: 'Hand over 1 to 12 pictures named far to near: 1_sky.png, 2_mountains.png, 3_trees.png …; ground.png (optional) becomes the floor.', doc: DOC.flat2d }); return finish('flat2d-room', name, items, facts, '2D room'); }
    cfg = p;
    items.push({ id: 'layers', level: 'ok', what: `Layers far → near: ${p.layers.map((l) => `${base(l.file!)} (${l.depth} m)`).join(', ')}${p.ground?.file ? `; floor ${base(p.ground.file)}` : ''}.` });
  }
  facts.layers = cfg.layers.map((l) => ({ file: l.file, depth: l.depth, kind: l.file ? 'picture' : Object.keys(l).find((k) => ['gradient', 'sky', 'clouds', 'hills', 'trees', 'grass', 'frame'].includes(k)) }));
  // the pictures: every layer but the farthest needs a transparent top (or the layers behind it never show)
  const layerPics = cfg.layers.filter((l) => l.file).map((l) => ({ l, f: files.find((x) => x.path.endsWith(l.file!)) })).filter((x) => x.f);
  const pf = layerPics.map(({ l, f }) => ({ l, p: pictureFacts(f!) })).filter((x) => x.p) as { l: Flat2dConfig['layers'][number]; p: PictureFacts }[];
  judgePictures(pf.map((x) => x.p), items, 'flat2d-room');
  const farthest = Math.max(...cfg.layers.map((l) => l.depth));
  const blockers = pf.filter((x) => x.l.depth < farthest && x.p.alpha === 'opaque');
  if (blockers.length) items.push({ id: 'layers.alpha', level: 'warn', what: `${blockers.map((x) => base(x.p.path)).join(', ')} ${blockers.length === 1 ? 'has' : 'have'} no transparency, so every layer behind ${blockers.length === 1 ? 'it' : 'them'} is hidden.`, fix: 'Only the farthest layer (the sky / backdrop) is a full picture; nearer layers are transparent PNGs with just their shapes.', doc: DOC.flat2d });
  const narrow = pf.filter((x) => x.p.w && x.p.w < 1920 && !x.l.repeat);
  if (narrow.length) items.push({ id: 'layers.res', level: 'warn', what: `${narrow.map((x) => `${base(x.p.path)} (${x.p.w} px)`).join(', ')}: narrower than a 1080p frame, soft on stream.`, fix: 'Make layers at least 1920 px wide (2560-3840 for the far ones, which the wide camera crops least).', doc: DOC.flat2d });
  if (!items.some((i) => i.level === 'warn' || i.level === 'error')) items.push({ id: 'layers', level: 'ok', what: `${cfg.layers.length} layer${cfg.layers.length === 1 ? '' : 's'} far → near (${(facts.layers as { kind?: string }[]).map((l) => l.kind).join(', ')}), ${pf.length} of them pictures.` });
  return finish('flat2d-room', name, items, facts, '2D room');
}
