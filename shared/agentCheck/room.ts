// 3D rooms (.glb + optional scene.json): the studio's own "Add my room" check (shared/roomCheck.ts analyzeRoom: seats,
// cameras, scale, axes, floor, lights, budget), then the agent bar = what an AI-made room package must pass
// (tools/aiconnect_package.py validate_room, ported): two-digit SPOT_01..SPOT_12 with pose / seatHeight extras, the
// default camera, a SCREEN when React mode is on, DOOR + DOOR_OUTSIDE + PATH_xx, LIGHT_* / EMIT_* / baked COLOR_0,
// ≤ 80,000 visible triangles and ≤ 25 MB, textures ≤ 2048.
import { analyzeRoom, BUDGET, type RoomAnalysis } from '../roomCheck.ts';
import { stripArea } from '../roomGlb.ts';
import { DOC, finish, type CheckFile, type CheckItem, type CheckResult } from './types.ts';

export const ROOM_TEX_MAX = 2048;
const base = (p: string) => p.split('/').pop() ?? p;
const lvl = (l: string): CheckItem['level'] => (l === 'bad' ? 'error' : l === 'warn' ? 'warn' : 'ok');

/** Width × height from a PNG / JPEG / WebP header (no decoding). */
export function imageHeaderSize(b: Uint8Array): [number, number] | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return [dv.getUint32(16), dv.getUint32(20)];
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1], len = dv.getUint16(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [dv.getUint16(i + 7), dv.getUint16(i + 5)];
      i += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b[8] === 0x57 && b[9] === 0x45) {
    const c = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (c === 'VP8X') return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
    if (c === 'VP8L') { const v = dv.getUint32(21, true); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
    if (c === 'VP8 ') return [dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff];
  }
  return null;
}

export function checkRoom3d(files: CheckFile[], name: string): CheckResult {
  const items: CheckItem[] = [];
  const sjFile = files.find((f) => base(f.path).toLowerCase() === 'scene.json');
  let sceneJson: Record<string, unknown> | null = null;
  if (sjFile) {
    try { sceneJson = JSON.parse(new TextDecoder().decode(sjFile.bytes)); } catch { items.push({ id: 'scene', level: 'error', what: 'scene.json is not valid JSON.', fix: 'Fix the JSON (docs/ARTIST_ENVIRONMENTS.md has a full example).', doc: DOC.room3d }); }
  }
  const model = typeof sceneJson?.model === 'string' ? sceneJson.model : null;
  const glbFile = (model ? files.find((f) => f.path.endsWith(model)) : undefined) ?? files.find((f) => /\.glb$/i.test(f.path));
  if (!glbFile) {
    const other = files.find((f) => /\.(gltf|fbx|blend|obj|dae)$/i.test(f.path));
    items.push({ id: 'file', level: 'error', what: other ? `${base(other.path)}: the check reads .glb rooms (VTube Pro converts other formats with Blender in VTube Pro).` : 'No .glb room file found.',
      fix: 'Export glTF Binary (.glb): export_format="GLB", export_yup=True, export_extras=True, export_cameras=True, export_lights=False, export_apply=True.', doc: DOC.room3d });
    return finish('room3d', name, items, {}, '3D room');
  }
  let a: RoomAnalysis;
  try { a = analyzeRoom(glbFile.bytes, { sceneJson }); }
  catch (e) {
    items.push({ id: 'file', level: 'error', what: `${base(glbFile.path)} can’t be read (${(e as Error).message}).`, fix: 'Export it again as glTF Binary (.glb).', doc: DOC.room3d });
    return finish('room3d', name, items, {}, '3D room');
  }
  // 1. the studio's own report card (what the performer sees)
  for (const l of a.report.lines) {
    if (l.id === 'budget' || l.id === 'screen' || l.id === 'door' || l.id === 'edits') continue;   // judged below on the agent bar
    items.push({ id: `room.${l.id}`, level: lvl(l.level), what: [l.text, l.detail].filter(Boolean).join(' '), ...(l.fix ? { fix: l.fix } : {}), doc: DOC.room3d });
  }
  // 2. the agent bar
  const f = a.facts, json = a.glb.json, nodes = json.nodes ?? [];
  if (f.compression.draco || f.compression.ktx2) items.push({ id: 'compression', level: 'error', what: `Uses ${[f.compression.draco && 'Draco mesh', f.compression.ktx2 && 'KTX2 / Basis texture'].filter(Boolean).join(' and ')} compression, which the studio can’t read without VTube Pro re-exporting it.`, fix: 'Export without compression (or with EXT_meshopt_compression); textures as PNG / JPEG / WebP.', doc: DOC.room3d });
  const short = nodes.map((n) => stripArea(n.name ?? '')).filter((n) => /^SPOT_\d$/.test(n));
  if (short.length) items.push({ id: 'spots.names', level: 'error', what: `Spot names need two digits: ${short.slice(0, 4).join(', ')}.`, fix: `Rename to ${short.slice(0, 4).map((n) => n.replace(/_(\d)$/, '_0$1')).join(', ')} (the room package check only accepts SPOT_01..SPOT_12).`, doc: DOC.room3d });
  const areasCfg = (sceneJson?.areas && typeof sceneJson.areas === 'object' ? sceneJson.areas : {}) as Record<string, Record<string, unknown>>;
  for (const area of f.areas) {
    const tag = area.key ? `Area "${area.key}": ` : '';
    const cfg = (area.key && areasCfg[area.key]) || {};
    if (area.spots.length > 12) items.push({ id: 'spots.count', level: 'error', what: `${tag}${area.spots.length} spots (at most 12).`, fix: 'Keep SPOT_01..SPOT_12.', doc: DOC.room3d });
    for (const s of area.spots) {
      const node = nodes.find((n) => n.name === s.name);
      const ex = (node?.extras ?? {}) as Record<string, unknown>;
      if (ex.pose !== 'sit' && ex.pose !== 'stand') items.push({ id: 'spots.pose', level: 'warn', what: `${s.name} has no pose extra.`, fix: `Set the custom property pose = "sit" or "stand" on ${s.name} and export with export_extras=True.`, doc: DOC.room3d });
      if (ex.pose === 'sit' && typeof ex.seatHeight === 'number' && !(ex.seatHeight >= 0.15 && ex.seatHeight <= 1.4)) items.push({ id: 'spots.seatHeight', level: 'error', what: `${s.name} seatHeight ${ex.seatHeight} is outside 0.15-1.4 m.`, fix: 'seatHeight = the seat cushion height above the spot origin, in metres (a sofa is about 0.45).', doc: DOC.room3d });
      if (Math.abs(s.position[1]) > 3) items.push({ id: 'spots.height', level: 'warn', what: `${s.name} is ${s.position[1].toFixed(1)} m off the floor.`, fix: 'Spot origins sit on the floor (y = 0) unless on a FLOOR_* stage.', doc: DOC.room3d });
    }
    const defCam = String(cfg.defaultCamera ?? sceneJson?.defaultCamera ?? 'CAM_WIDE');
    if (!area.cams.includes(defCam)) items.push({ id: 'cameras.default', level: 'error', what: `${tag}the default camera ${defCam} is not a camera in the file.`, fix: `Add a camera object named ${defCam} that sees every spot (vertical FOV 35-40°) and export with export_cameras=True.`, doc: DOC.room3d });
    const modes = (Array.isArray(cfg.modes) ? cfg.modes : Array.isArray(sceneJson?.modes) ? sceneJson.modes : ['talk', 'react']) as unknown[];
    if (modes.includes('react')) {
      if (!area.screen) items.push({ id: 'screen', level: 'error', what: `${tag}React mode is on but there is no SCREEN.`, fix: 'Add a 16:9 plane named SCREEN (UVs 0..1, facing the camera), or set "modes": ["talk"] in scene.json.', doc: DOC.room3d });
      else if (!area.hasReactCam) items.push({ id: 'screen.cam', level: 'warn', what: `${tag}no CAM_REACT camera.`, fix: 'Add CAM_REACT framing the screen at about 80% of the picture width.', doc: DOC.room3d });
    }
    const missing = [!area.door && 'DOOR', !area.doorOutside && 'DOOR_OUTSIDE', !area.paths && 'PATH_01'].filter(Boolean);
    if (missing.length) items.push({ id: 'door', level: 'warn', what: `${tag}no ${missing.join(', ')}: guests pop into their seats instead of walking in.`, fix: 'Add a doorway: DOOR (the door leaf, origin at the hinge), an empty DOOR_OUTSIDE just outside facing in, PATH_01.. waypoints to the room centre.', doc: DOC.room3d });
  }
  if (!f.lightFixtures) items.push({ id: 'lights.fixtures', level: 'warn', what: 'No LIGHT_* fixtures: the light show has nothing to switch.', fix: 'Mark lamps / neon with LIGHT_* empties (extras: group, color, kind).', doc: DOC.room3d });
  if (!f.emitGroups.length) items.push({ id: 'lights.emit', level: 'warn', what: 'No EMIT_<group> materials: nothing glows with the lighting.', fix: 'Name glowing materials EMIT_neon, EMIT_sign … so the light engine animates them.', doc: DOC.room3d });
  if (f.meshes && !f.color0) items.push({ id: 'lights.baked', level: 'warn', what: 'No baked vertex colours (COLOR_0): room shadows are off in the studio, so the room looks flat.', fix: 'Bake ambient occlusion + the key light into a colour attribute (Blender: Bake → Color Attribute) and export it.', doc: DOC.room3d });
  // budget
  const mb = f.bytes / 1048576;
  if (f.triangles > BUDGET.tris) items.push({ id: 'budget.tris', level: 'error', what: `${f.triangles.toLocaleString('en-US')} visible triangles (budget ${BUDGET.tris.toLocaleString('en-US')}).`, fix: 'Decimate far / hidden geometry, delete faces no camera sees, use simpler props.', doc: DOC.room3d });
  if (mb > BUDGET.mb) items.push({ id: 'budget.mb', level: 'error', what: `${mb.toFixed(1)} MB (budget ${BUDGET.mb} MB).`, fix: 'Use 2048 atlases / 1024 tiling textures, JPEG for colour maps, fewer unique images.', doc: DOC.room3d });
  if (f.drawCalls > BUDGET.drawCalls) items.push({ id: 'budget.draws', level: 'warn', what: `About ${f.drawCalls} draw calls (aim for ${BUDGET.drawCalls} or fewer).`, fix: 'Join static meshes that share a material.', doc: DOC.room3d });
  const big: string[] = [];
  for (const [i, img] of (json.images ?? []).entries()) {
    const bv = typeof img.bufferView === 'number' ? json.bufferViews?.[img.bufferView] : undefined;
    if (!bv || !a.glb.bin) continue;
    const off = bv.byteOffset ?? 0;
    const sz = imageHeaderSize(a.glb.bin.subarray(off, off + Math.min(bv.byteLength, 1 << 16)));
    if (sz && Math.max(...sz) > ROOM_TEX_MAX) big.push(`${(img as { name?: string }).name ?? `image ${i}`} ${sz[0]}×${sz[1]}`);
  }
  if (big.length) items.push({ id: 'budget.textures', level: 'warn', what: `${big.length} texture${big.length === 1 ? ' is' : 's are'} over ${ROOM_TEX_MAX} px (${big.slice(0, 3).join(', ')}${big.length > 3 ? ' …' : ''}).`, fix: `Keep room textures at or below ${ROOM_TEX_MAX}×${ROOM_TEX_MAX}.`, doc: DOC.room3d });
  if (!items.some((i) => i.id.startsWith('budget'))) items.push({ id: 'budget', level: 'ok', what: `${f.triangles.toLocaleString('en-US')} triangles, ${mb.toFixed(1)} MB, about ${f.drawCalls} draw calls: within budget.` });
  if (sjFile && !files.some((x) => /(^|\/)preview\.png$/i.test(x.path))) items.push({ id: 'preview', level: 'info', what: 'No preview.png (1280×720) / thumb.png (480×270).', fix: 'Render them from CAM_WIDE; the room picker shows them.', doc: DOC.room3d });
  const facts = { triangles: f.triangles, mb: +mb.toFixed(2), drawCalls: f.drawCalls, materials: f.materials, size: f.core, seats: f.usableSeats, spots: f.spotsTotal,
    areas: f.areas.map((x) => ({ key: x.key, spots: x.spots.map((s) => ({ name: s.name, pose: s.pose, problems: s.problems })), cams: x.cams, screen: x.screen, door: x.door })),
    lights: f.lightFixtures, emit: f.emitGroups, color0: f.color0, up: f.upGuess, scale: f.scaleGuess };
  return finish('room3d', name, items, facts, '3D room');
}
