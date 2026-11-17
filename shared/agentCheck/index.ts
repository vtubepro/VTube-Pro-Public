// The agent file check: one entry point. Give it the files (a model folder, a zip's entries, one file) and optionally
// the kind; it works out what the files are the way the studio's drop zone does and runs that kind's check.
// MCP: check_creation (server/creationCheck.ts).
import { pictureRole } from '../flatImport.ts';
import type { InflateRaw } from '../rig2d/container.ts';
import { checkAvatar3d } from './avatar3d.ts';
import { checkPro2dPsd, checkPro2dPictures } from './pro2d.ts';
import { checkLive2d, checkInochi, checkVtp2 } from './live2d.ts';
import { checkPngtuber, checkFlat2dRoom } from './flat.ts';
import { checkRoom3d } from './room.ts';
import { CHECK_KINDS, finish, type CheckFile, type CheckKind, type CheckResult } from './types.ts';

export * from './types.ts';
export { AVATAR_BUDGET } from './avatar3d.ts';
export { PSD_CANVAS } from './pro2d.ts';
export { LIVE2D_INPUTS, MOC3_VERSIONS } from './live2d.ts';
export { PNG_SIZE } from './flat.ts';
export { ROOM_TEX_MAX } from './room.ts';

const base = (p: string) => (p.split('/').pop() ?? p).toLowerCase();
const PIC = /\.(png|webp|jpe?g|gif|apng)$/i;
const MODEL3D = /\.(glb|gltf|vrm|fbx|obj|blend|dae|stl|ply|usdz?|abc|pmx|pmd)$/i;

/** What the files are (null = nothing this check reads). `why` = one line on how it was decided. */
export function detectKind(files: readonly CheckFile[]): { kind: CheckKind; why: string } | null {
  const paths = files.map((f) => f.path).filter((p) => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i.test(p));
  const has = (re: RegExp) => paths.some((p) => re.test(p));
  if (has(/\.vrm$/i)) return { kind: 'avatar3d', why: 'a .vrm file' };
  if (has(/\.model3\.json$/i) || has(/\.moc3$/i)) return { kind: 'live2d', why: 'a Live2D model (.model3.json / .moc3)' };
  if (has(/\.(inp|inx)$/i)) return { kind: 'inochi2d', why: 'an Inochi2D puppet' };
  if (has(/\.vtp2$/i)) return { kind: 'vtp2', why: 'a VTube Pro 2D rig' };
  if (has(/\.(psd|psb)$/i)) return { kind: 'pro2d-psd', why: 'a layered PSD (the 2D avatar maker)' };
  const sj = files.find((f) => base(f.path) === 'scene.json');
  if (sj) {
    const t = new TextDecoder().decode(sj.bytes);
    if (/"flat2d"\s*:/.test(t)) return { kind: 'flat2d-room', why: 'a scene.json with "flat2d" layers' };
    if (has(/\.glb$/i)) return { kind: 'room3d', why: 'a scene.json next to a .glb' };
  }
  const m3d = files.find((f) => MODEL3D.test(f.path));
  if (m3d) {
    // a room or an avatar? the room contract names (SPOT_ / CAM_WIDE) say room; a skin says avatar
    const head = new TextDecoder('utf-8', { fatal: false }).decode(m3d.bytes.subarray(0, Math.min(m3d.bytes.length, 4 << 20)));
    if (/"name"\s*:\s*"(?:[A-Z0-9_]+__)?(SPOT_\d{1,2}|CAM_WIDE)"/.test(head)) return { kind: 'room3d', why: `${base(m3d.path)} has room nodes (SPOT_xx / CAM_WIDE)` };
    return { kind: 'avatar3d', why: `${base(m3d.path)} is a 3D model` };
  }
  const pics = paths.filter((p) => PIC.test(p));
  if (pics.length) {
    const roles = pics.filter((p) => pictureRole(p)).length;
    const scenery = pics.filter((p) => /(^|[^a-z])(sky|background|backdrop|bg|hills?|mountains?|clouds?|ground|floor|layer)([^a-z]|$)/i.test(base(p)) || /^\d+[_ -]/.test(base(p))).length;
    if (roles && roles >= pics.length / 2) return { kind: 'pngtuber', why: 'pictures named idle / talk / blink' };
    if (scenery >= Math.max(1, pics.length / 2)) return { kind: 'flat2d-room', why: 'numbered / scenery pictures (2D room layers)' };
    if (pics.length >= 4) return { kind: 'pro2d-pictures', why: 'several part pictures (eyes, mouth, hair …) for the 2D avatar maker' };
    return { kind: 'pngtuber', why: 'one or a few pictures' };
  }
  return null;
}

export interface RunOpts { kind?: CheckKind; name?: string; /** Node's zlib.inflateRawSync (zipped .vtp2 entries) */ inflateRaw?: InflateRaw }

export async function runCheck(files: CheckFile[], o: RunOpts = {}): Promise<CheckResult> {
  const name = o.name ?? (files[0]?.path.split('/')[0] || 'upload');
  const d = o.kind ? { kind: o.kind, why: 'asked for' } : detectKind(files);
  if (!d) return finish('avatar3d', name, [{ id: 'file', level: 'error', what: 'Nothing here that VTube Pro reads.', fix: `Check a 3D model (.vrm / .glb), a layered .psd, a Live2D folder, PNGTuber pictures or a room. Kinds: ${CHECK_KINDS.join(', ')}.` }], {}, 'Upload');
  const one = (re: RegExp) => files.find((f) => re.test(f.path));
  let r: CheckResult;
  switch (d.kind) {
    case 'avatar3d': r = await checkAvatar3d(files, name); break;
    case 'pro2d-psd': { const f = one(/\.(psd|psb)$/i); r = f ? await checkPro2dPsd(f) : finish('pro2d-psd', name, [{ id: 'file', level: 'error', what: 'No .psd file.' }], {}, 'Pro2D PSD'); break; }
    case 'pro2d-pictures': r = await checkPro2dPictures(files.filter((f) => /\.png$/i.test(f.path)), name); break;
    case 'live2d': r = await checkLive2d(files, name, o.inflateRaw); break;
    case 'inochi2d': { const f = one(/\.(inp|inx)$/i); r = f ? await checkInochi(f) : finish('inochi2d', name, [{ id: 'file', level: 'error', what: 'No .inp file.' }], {}, 'Inochi2D puppet'); break; }
    case 'vtp2': { const f = one(/\.vtp2$/i); r = f ? await checkVtp2(f, o.inflateRaw) : finish('vtp2', name, [{ id: 'file', level: 'error', what: 'No .vtp2 file.' }], {}, 'VTube Pro 2D rig'); break; }
    case 'pngtuber': r = checkPngtuber(files, name); break;
    case 'flat2d-room': r = checkFlat2dRoom(files, name); break;
    case 'room3d': r = checkRoom3d(files, name); break;
  }
  r.facts = { detected: d.why, ...r.facts };
  return r;
}
