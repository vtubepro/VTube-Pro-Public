// "Add my room": the room check (report card), the machine-readable room checklist every AI gets, and the automatic
// fix ("Place seats for me"). Pure TypeScript, shared by the browser (works without the server), the server
// (server/routes/roomImport.ts, MCP check_room) and the tests.
// The rules are the room contract of docs/ARTIST_ENVIRONMENTS.md / docs/SCENES.md, written for people who are
// "allergic to technology": every report line is one plain sentence, every problem says what we'll do about it.
//
//   analyzeRoom(bytes, { sceneJson, soup })   → { facts, report, glb, grid }
//   planFix(analysis, { want })               → what "Place seats for me" would add (spots, talk cameras, CAM_WIDE,
//                                               a units / up-axis / floor correction)
//   applyFix(analysis, plan)                  → the fixed GLB bytes (a lossless glTF-JSON edit) + scene.json
//   ROOM_CHECKLIST                            → the same rules as data (MCP room_checklist, vtube-pro://checklist/room)
import { addRoomNodes, apply, areaPrefix, compose, dirNegZ, identity, localMatrix, mul, parseGlb, stripArea, triangleSoup, worldMatrices, wrapRoot, writeGlb, type Glb, type GltfJson, type Mat4, type NewNode, type TriangleSoup } from './roomGlb.ts';
import { autoPlace, buildGrid, guessScaleAndUp, spotProblems, talkCamera, type AutoPlan, type CamPlace, type RoomGrid, type SeatPlace, type V3 } from './roomSeats.ts';
import { chatScreenBox, checkEditView, propBox, type CheckCam, type CheckProp, type CheckSpot, type CheckView } from './roomEditCheck.ts';
import type { RoomEdits } from './roomEdits.ts';

export type Level = 'ok' | 'warn' | 'bad';
/** One line of the report card (the onboarding shell's ReportLine + the AI fields). */
export interface RoomLine {
  id: string;                 // = a ROOM_CHECKLIST id
  level: Level;
  text: string;               // one plain sentence for the performer
  detail?: string;            // a second, still plain, sentence
  fix?: string;               // what an artist / AI should change (contract words allowed here)
  needsHelper?: boolean;      // the fix needs VTube Pro (Blender on the PC)
  autoFix?: boolean;          // "Place seats for me" fixes it
}
export interface SpotFact {
  name: string; area: string; index: number;
  position: V3; yawDeg: number; pose: 'sit' | 'stand'; seatHeight?: number; label?: string;
  hasCam: boolean; problems: string[];
}
export interface AreaFact { key: string; prefix: string; spots: SpotFact[]; usable: number; cams: string[]; hasWide: boolean; hasReactCam: boolean; screen: boolean; screenBox: [number, number, number, number, number] | null; door: boolean; doorOutside: boolean; paths: number }
export interface RoomFacts {
  bytes: number;
  generator: string;
  extensionsUsed: string[];
  compression: { draco: boolean; meshopt: boolean; ktx2: boolean };
  unreadableMeshes: number;
  triangles: number; drawCalls: number; meshes: number; materials: number; images: number;
  color0: boolean; lightFixtures: number; emitGroups: string[];
  size: V3; core: V3; scaleGuess: number; upGuess: string; upWhy: string;
  floorY: number | null;
  areas: AreaFact[];
  spotsTotal: number; usableSeats: number;
  sceneJsonAreas: string[];
}
export interface RoomReport { ok: boolean; seats: number; lines: RoomLine[]; summary: string }
export interface RoomAnalysis { glb: Glb; facts: RoomFacts; report: RoomReport; grid: RoomGrid | null; soup: TriangleSoup; fix: Mat4 | null; sceneJson: Record<string, unknown> | null }

export const BUDGET = { tris: 80_000, mb: 25, drawCalls: 180, heavyTris: 300_000, heavyMb: 120 };

// ---------------------------------------------------------------- the checklist (machine readable; one copy)
export interface ChecklistItem { id: string; required: boolean; rule: string; how: string; fix: string; auto: string; doc: string }
/** Every rule the room check runs, as data. The AI gets this verbatim (MCP `room_checklist`, resource
 *  vtube-pro://checklist/room, GET /api/rooms/checklist). Keep in sync with checkRoom() below (the unit test does). */
export const ROOM_CHECKLIST: readonly ChecklistItem[] = [
  { id: 'file', required: true, rule: 'One self-contained glTF binary (.glb), or .gltf with everything embedded. FBX / .blend / OBJ / DAE are converted to GLB by Blender inside VTube Pro.', how: 'The file starts with "glTF" and its JSON chunk parses.', fix: 'Export glTF Binary (.glb): export_format="GLB", export_yup=True, export_extras=True, export_cameras=True, export_lights=False, export_apply=True.', auto: 'VTube Pro converts other formats with Blender.', doc: 'ARTIST_ENVIRONMENTS.md §0, §2' },
  { id: 'compression', required: false, rule: 'Mesh compression the studio can decode: none, EXT_meshopt_compression or KHR_mesh_quantization. Not Draco, not KTX2 / Basis textures.', how: 'extensionsUsed of the GLB.', fix: 'Re-export without Draco; use WebP / PNG / JPEG textures.', auto: 'VTube Pro re-exports Draco / KTX2 rooms through Blender.', doc: 'portal CONTRACT.md §7' },
  { id: 'seats', required: true, rule: 'At least 1 usable place: an empty SPOT_01..SPOT_12 (per area: <AREA>__SPOT_xx) with its origin on the floor under the hips, +Z = the way the performer faces (Blender -Y), extras pose "sit" | "stand", sit: seatHeight 0.15-1.4 m (cushion above the origin). 2 or more recommended (a guest can join); aim for 5-12.', how: 'Counts SPOT_xx nodes; a spot is unusable when its body capsule (r 0.16 m) is inside geometry or nothing is under it.', fix: 'Add SPOT_xx empties on seats / open floor, facing the cameras, with pose + seatHeight extras.', auto: '"Place seats for me" finds sofa / chair cushions (a seat 0.3-0.65 m up with a backrest) and open floor, and adds SPOT_xx + SPOT_xx_CAM.', doc: 'ARTIST_ENVIRONMENTS.md §2.1' },
  { id: 'cameras', required: false, rule: 'CAM_WIDE (the default camera) sees every spot; SPOT_xx_CAM talk cameras optional (the automatic camera operator makes its own); vertical FOV 35-40°, inside the set, never inside furniture.', how: 'Camera nodes named CAM_* / SPOT_xx_CAM.', fix: 'Add a camera object CAM_WIDE (export_cameras=True).', auto: 'Adds CAM_WIDE + a talk camera per new place, each with a clear line of sight to the face.', doc: 'ARTIST_ENVIRONMENTS.md §2.1, §10' },
  { id: 'scale', required: false, rule: 'Metres. A room is about 3-60 m across; seats 0.42-0.5 m, doors 2.1 m.', how: 'Size of the 5th-95th percentile box of triangle centres.', fix: 'Export in metres (apply scale).', auto: 'Wraps the room in a scale node (×0.01 for centimetres, ×10 / ×100 for tiny exports).', doc: 'ARTIST_ENVIRONMENTS.md §3' },
  { id: 'axes', required: false, rule: '+Y up, stage front = +Z (Blender: Z up, open front faces -Y).', how: 'Which way the biggest flat area (the floor) faces.', fix: 'Export with export_yup=True; rotate the room so its floor faces up.', auto: 'Wraps the room in a rotation node.', doc: 'ARTIST_ENVIRONMENTS.md §3' },
  { id: 'floor', required: false, rule: 'The floor at height 0.', how: 'Most common lowest upward surface.', fix: 'Move the room so its floor is at 0.', auto: 'Wraps the room in a translation node.', doc: 'ARTIST_ENVIRONMENTS.md §3' },
  { id: 'lights', required: false, rule: 'Bake the light into COLOR_0 vertex colours or textures (room shadows are off); lamps = LIGHT_* empties (extras group, color, kind) + EMIT_<group> materials; never export punctual lights.', how: 'COLOR_0 on any primitive, LIGHT_* nodes, EMIT_* materials.', fix: 'Bake AO + key light into COLOR_0; name glowing materials EMIT_<group>.', auto: 'Not automatic (art work): an AI with Blender can do it from the guide.', doc: 'ARTIST_ENVIRONMENTS.md §5' },
  { id: 'budget', required: false, rule: '≤ 80,000 visible triangles, ≤ 25 MB, ≈ ≤ 180 draw calls, textures ≤ 2048².', how: 'Counted from the GLB (COLLIDE_ / FLOOR_ excluded).', fix: 'Join static meshes per material, LODs, atlases, JPEG colour maps.', auto: 'Not automatic: heavy rooms still load, they cost face-tracking time on older PCs.', doc: 'ARTIST_ENVIRONMENTS.md §9' },
  // (owner 2026-10-02: a new room gets its screen and door the first time — "Recommended", never "Not needed")
  { id: 'screen', required: false, rule: 'Recommended for React mode: a 16:9 plane named SCREEN + CAM_REACT. Without it React falls back to a floating screen.', how: 'A SCREEN node.', fix: 'Add a 16:9 plane SCREEN (UVs 0..1) facing the camera, CAM_REACT framing it at ~80 % width.', auto: 'Not added for you: until the room has a SCREEN, React uses a floating solo screen.', doc: 'ARTIST_ENVIRONMENTS.md §2.1' },
  { id: 'door', required: false, rule: 'Recommended: DOOR (origin at the hinge) + DOOR_OUTSIDE + PATH_01.. so performers walk in.', how: 'Named nodes.', fix: 'Add a real doorway with DOOR, DOOR_OUTSIDE and PATH_xx empties (a clear lane to every SPOT).', auto: 'Not added for you: until the room has a door, performers appear in their seats.', doc: 'ARTIST_ENVIRONMENTS.md §2.1' },
  { id: 'edits', required: false, rule: 'Your own Room editor changes (cameras, places, the react screen, props) keep every face inside its camera\'s safe area, CAM_REACT showing the whole react screen, and props off the places, the faces and the react screen.', how: 'The room as merged with the user\'s edits (<data>/room-edits/<room>.json): faces projected through each edited camera, props as boxes on the camera-to-face lines.', fix: 'Open the Room editor and move the camera / prop the line names (or Reset it).', auto: 'Nothing is blocked: on air VTube Pro re-aims a camera that loses a face; the warning says where your own choice is not used as is.', doc: 'ROOM_EDITOR.md' },
];

// ---------------------------------------------------------------- facts
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const yawOf = (m: Mat4) => { const fx = m[8], fz = m[10]; return Math.round((Math.atan2(fx, fz) * 180) / Math.PI); };
const SPOT = /^SPOT_(\d{1,2})$/, SPOT_CAM = /^SPOT_(\d{1,2})_CAM/;

/** Facts about a room file. `grid` is in FIXED space (after `fix`: units / up axis / floor), spot positions are reported
 *  as authored. */
export function roomFacts(glb: Glb, bytes: number, soup: TriangleSoup, grid: RoomGrid | null, sceneJson?: Record<string, unknown> | null, avatarHeight = 1.5, fix: Mat4 | null = null): RoomFacts {
  const json = glb.json;
  const nodes = json.nodes ?? [];
  const { world, reached } = worldMatrices(json);
  const ext = json.extensionsUsed ?? [];
  const acc = json.accessors ?? [];
  // triangles + draw calls like tools/aiconnect_package.py glb_stats
  const meshTris = (json.meshes ?? []).map((m) => m.primitives.reduce((a, p) => a + ((p.mode ?? 4) !== 4 ? 0 : p.indices !== undefined ? Math.floor((acc[p.indices]?.count ?? 0) / 3) : Math.floor((acc[p.attributes?.POSITION]?.count ?? 0) / 3)), 0));
  let triangles = 0, drawCalls = 0, color0 = false;
  nodes.forEach((n, i) => {
    if (n.mesh === undefined || !reached[i]) return;
    drawCalls += json.meshes?.[n.mesh]?.primitives.length ?? 0;
    if (!/^(COLLIDE_|FLOOR_)/.test(stripArea(n.name ?? ''))) triangles += meshTris[n.mesh] ?? 0;
  });
  for (const m of json.meshes ?? []) for (const p of m.primitives) if (p.attributes && 'COLOR_0' in p.attributes) color0 = true;
  const emitGroups = [...new Set((json.materials ?? []).map((m) => /^EMIT_([^.]+)/.exec(m.name ?? '')?.[1]).filter((x): x is string => !!x))];
  // areas: prefixes used by contract nodes (+ the scene.json areas)
  const sjAreas = sceneJson && typeof sceneJson.areas === 'object' && sceneJson.areas && !Array.isArray(sceneJson.areas) ? Object.keys(sceneJson.areas as object) : [];
  const prefixes = new Set<string>(['']);
  for (const n of nodes) { const p = areaPrefix(n.name ?? ''); if (p && /^(SPOT_|CAM_|SCREEN|DOOR|PATH_)/.test(stripArea(n.name ?? ''))) prefixes.add(p); }
  for (const a of sjAreas) prefixes.add(a.toUpperCase());
  const areas: AreaFact[] = [];
  for (const prefix of prefixes) {
    const mine = nodes.map((n, i) => ({ n, i })).filter(({ n, i }) => reached[i] && areaPrefix(n.name ?? '') === prefix);
    const base = (n: { name?: string }) => stripArea(n.name ?? '');
    const cams = mine.filter(({ n }) => n.camera !== undefined).map(({ n }) => base(n));
    const camSpots = new Set(cams.map((c) => SPOT_CAM.exec(c)?.[1]).filter(Boolean).map((s) => +s!));
    const spots: SpotFact[] = [];
    for (const { n, i } of mine) {
      const m = SPOT.exec(base(n));
      if (!m || +m[1] < 1 || +m[1] > 12) continue;
      const ex = (n.extras ?? {}) as Record<string, unknown>;
      const pose = ex.pose === 'sit' ? 'sit' : 'stand';
      const seatHeight = pose === 'sit' ? Math.max(0.15, Math.min(1.4, typeof ex.seatHeight === 'number' ? ex.seatHeight : 0.45)) : undefined;
      const position = apply(world[i], 0, 0, 0).map((v) => round(v, 3)) as V3;
      const s: SpotFact = { name: n.name ?? '', area: prefix.toLowerCase(), index: +m[1], position, yawDeg: yawOf(world[i]), pose, seatHeight, label: typeof ex.label === 'string' ? ex.label.slice(0, 60) : undefined, hasCam: camSpots.has(+m[1]), problems: [] };
      if (ex.pose !== 'sit' && ex.pose !== 'stand') s.problems.push('no-pose');
      if (grid) s.problems.push(...spotProblems(grid, { ...s, position: fix ? apply(fix, ...position) : position }, avatarHeight));
      spots.push(s);
    }
    spots.sort((a, b) => a.index - b.index);
    // a prefix only counts as an area when it has contract nodes (or scene.json lists it)
    if (prefix && !spots.length && !cams.length && !sjAreas.map((a) => a.toUpperCase()).includes(prefix)) continue;
    const names = new Set(mine.map(({ n }) => base(n)));
    areas.push({
      key: prefix.toLowerCase(), prefix, spots,
      usable: spots.filter((s) => !s.problems.includes('inside') && !s.problems.includes('floating')).length,
      cams, hasWide: cams.includes('CAM_WIDE'), hasReactCam: cams.includes('CAM_REACT'),
      screen: names.has('SCREEN'), screenBox: screenBox(json, world, mine.find(({ n }) => base(n) === 'SCREEN')?.i), door: names.has('DOOR'), doorOutside: names.has('DOOR_OUTSIDE'), paths: [...names].filter((x) => /^PATH_\d+$/.test(x)).length,
    });
  }
  // an unprefixed "area" with nothing in it is just the shared nodes of a room with areas: drop it
  const real = areas.filter((a) => a.prefix === '' ? a.spots.length > 0 || a.cams.length > 0 || areas.length === 1 : true);
  const su = guessScaleAndUp(soup);
  return {
    bytes, generator: String(json.asset?.generator ?? '').slice(0, 80), extensionsUsed: ext,
    compression: { draco: ext.includes('KHR_draco_mesh_compression'), meshopt: ext.includes('EXT_meshopt_compression'), ktx2: ext.includes('KHR_texture_basisu') },
    unreadableMeshes: soup.unreadable.length,
    triangles, drawCalls, meshes: json.meshes?.length ?? 0, materials: json.materials?.length ?? 0, images: json.images?.length ?? 0,
    color0, lightFixtures: nodes.filter((n) => /^LIGHT_/.test(stripArea(n.name ?? ''))).length, emitGroups,
    size: su.size.map((v) => round(v, 1)) as V3, core: su.core.map((v) => round(v, 1)) as V3, scaleGuess: su.scale, upGuess: su.up, upWhy: su.why,
    floorY: grid ? round(grid.floorY, 2) : null,
    areas: real.length ? real : areas.slice(0, 1),
    spotsTotal: real.reduce((a, r) => a + r.spots.length, 0), usableSeats: real.reduce((a, r) => a + r.usable, 0),
    sceneJsonAreas: sjAreas,
  };
}

/** Floor-plan box + bottom (x0, z0, x1, z1, y0; file space) of a node and its child meshes (accessor min / max, transformed). */
function screenBox(json: GltfJson, world: Mat4[], i: number | undefined): [number, number, number, number, number] | null {
  if (i === undefined) return null;
  const nodes = json.nodes ?? [], acc = json.accessors ?? [];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y0 = Infinity;
  const visit = (k: number, depth: number) => {
    const n = nodes[k]; if (!n || depth > 6) return;
    if (n.mesh !== undefined) for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
      const a = acc[p.attributes?.POSITION];
      if (!a?.min || !a.max) continue;
      for (const cx of [a.min[0], a.max[0]]) for (const cy of [a.min[1], a.max[1]]) for (const cz of [a.min[2], a.max[2]]) {
        const [x, y, z] = apply(world[k], cx, cy, cz); y0 = Math.min(y0, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
    }
    for (const c of n.children ?? []) visit(c, depth + 1);
  };
  visit(i, 0);
  return Number.isFinite(x0) ? [x0, z0, x1, z1, y0].map((v) => round(v, 2)) as [number, number, number, number, number] : null;
}

// ---------------------------------------------------------------- the report card
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nice = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function checkRoom(f: RoomFacts, opts: { fileName?: string; helper?: boolean } = {}): RoomReport {
  const lines: RoomLine[] = [];
  const C = (id: string) => ROOM_CHECKLIST.find((c) => c.id === id)!;
  const made = /blender/i.test(f.generator) ? 'Made in Blender.' : /sketchfab/i.test(f.generator) ? 'From Sketchfab.' : /unity/i.test(f.generator) ? 'Made in Unity.' : /unreal/i.test(f.generator) ? 'Made in Unreal.' : undefined;
  lines.push({ id: 'file', level: 'ok', text: 'We can open your room.', detail: made });
  if (f.compression.draco || f.compression.ktx2 || f.unreadableMeshes) {
    lines.push({ id: 'compression', level: 'warn', text: 'Part of this room is packed in a way the browser can\'t read.', detail: 'VTube Pro on your PC unpacks it for you with Blender.', fix: C('compression').fix, needsHelper: true });
  }
  // seats, per area
  const seats = f.usableSeats;
  const multi = f.areas.length > 1;
  const blocked = f.areas.flatMap((a) => a.spots.filter((s) => s.problems.includes('inside') || s.problems.includes('floating')));
  if (seats === 0) {
    lines.push({ id: 'seats', level: 'bad', text: 'We couldn\'t find any places for you to sit or stand in this room.', detail: f.spotsTotal ? 'The places in the file are stuck inside furniture or floating in the air.' : 'Rooms need at least one spot where you can sit or stand. We can add them for you.', fix: C('seats').fix, autoFix: true });
  } else if (seats === 1) {
    lines.push({ id: 'seats', level: 'warn', text: 'We found 1 place for you to sit or stand.', detail: 'That works on your own. Add a second one so a friend can join you.', fix: C('seats').fix, autoFix: true });
  } else {
    lines.push({ id: 'seats', level: 'ok', text: `We found ${seats} places to sit or stand.`, detail: multi ? f.areas.map((a) => `${nice(a.key || 'main')}: ${a.usable}`).join(' · ') : undefined });
  }
  if (multi) for (const a of f.areas) if (!a.usable) lines.push({ id: 'seats', level: 'warn', text: `The "${nice(a.key || 'main')}" part of your room has no places to sit or stand yet.`, fix: `Add ${a.prefix ? `${a.prefix}__` : ''}SPOT_01.. in that area.`, autoFix: false });
  if (blocked.length && seats > 0) lines.push({ id: 'seats', level: 'warn', text: `${plural(blocked.length, 'place')} ${blocked.length === 1 ? 'looks' : 'look'} stuck inside furniture or floating.`, detail: blocked.map((s) => s.label || stripArea(s.name)).slice(0, 4).join(', '), fix: 'Move those SPOT_xx onto the seat / floor (scene.json spotOverrides works without re-exporting).', autoFix: false });
  // cameras
  const camCount = f.areas.reduce((a, r) => a + r.cams.length, 0);
  const hasWide = f.areas.every((a) => a.hasWide);
  lines.push(camCount
    ? { id: 'cameras', level: hasWide ? 'ok' : 'warn', text: `${plural(camCount, 'camera view')} found.`, detail: hasWide ? 'VTube Pro also films you automatically from good angles.' : 'There\'s no main wide view; we\'ll add one.', fix: hasWide ? undefined : C('cameras').fix, autoFix: !hasWide }
    : { id: 'cameras', level: 'warn', text: 'No camera views in the file yet.', detail: 'We\'ll add one for each seat plus a wide view of the room.', fix: C('cameras').fix, autoFix: true });
  // scale + axes + floor
  const w = Math.max(f.core[0], f.core[2]), d = Math.min(f.core[0], f.core[2]);
  if (f.scaleGuess === 0.01) lines.push({ id: 'scale', level: 'warn', text: 'Your room looks 100 times too big.', detail: 'It was probably saved in centimetres. We can shrink it to the right size.', fix: C('scale').fix, autoFix: true });
  else if (f.scaleGuess > 1) lines.push({ id: 'scale', level: 'warn', text: `Your room looks ${f.scaleGuess} times too small.`, detail: 'We can grow it to the right size.', fix: C('scale').fix, autoFix: true });
  else if (w > 120) lines.push({ id: 'scale', level: 'ok', text: `This is a big place (about ${Math.round(w)} m across).`, detail: 'Huge outdoor rooms work, they just take longer to load.' });
  else lines.push({ id: 'scale', level: 'ok', text: `The size looks right (about ${Math.max(1, Math.round(w))} × ${Math.max(1, Math.round(d))} m).` });
  if (f.upGuess !== 'y') lines.push({ id: 'axes', level: 'warn', text: 'Your room seems to be lying on its side.', detail: 'We can stand it up the right way.', fix: C('axes').fix, autoFix: true });
  if (f.floorY !== null && Math.abs(f.floorY) > 0.25 && f.upGuess === 'y' && f.scaleGuess === 1) lines.push({ id: 'floor', level: 'warn', text: 'The floor isn\'t at ground level.', detail: `It sits ${Math.abs(f.floorY).toFixed(1)} m ${f.floorY > 0 ? 'up in the air' : 'below ground'}. We can move it.`, fix: C('floor').fix, autoFix: true });
  // lights
  const lit = f.color0 || f.lightFixtures > 0 || f.emitGroups.length > 0;
  lines.push(lit
    ? { id: 'lights', level: 'ok', text: f.color0 ? 'The lighting is baked in, so it looks good on every PC.' : 'Your room has lamps VTube Pro can light up.', detail: f.lightFixtures || f.emitGroups.length ? `${plural(f.lightFixtures + f.emitGroups.length, 'light')} the light show can use.` : undefined }
    : { id: 'lights', level: 'warn', text: 'No lighting is baked into this room, so it may look a bit flat.', detail: 'It still works. An AI or artist can bake the light later (the guide explains how).', fix: C('lights').fix });
  // budget
  const mb = f.bytes / 1048576;
  if (f.triangles > BUDGET.heavyTris || mb > BUDGET.heavyMb) lines.push({ id: 'budget', level: 'warn', text: 'This room is very detailed and may slow down your face tracking.', detail: `${f.triangles.toLocaleString('en-US')} triangles, ${mb.toFixed(0)} MB. Try it on the Low graphics setting first.`, fix: C('budget').fix });
  else if (f.triangles > BUDGET.tris || mb > BUDGET.mb || f.drawCalls > BUDGET.drawCalls) lines.push({ id: 'budget', level: 'ok', text: 'This room is a bit heavy, but it should run fine on most PCs.', detail: `${f.triangles.toLocaleString('en-US')} triangles, ${mb.toFixed(1)} MB.` });
  else lines.push({ id: 'budget', level: 'ok', text: 'It\'s light enough to run smoothly.', detail: `${f.triangles.toLocaleString('en-US')} triangles, ${mb.toFixed(1)} MB.` });
  // screen + door: never a problem for the performer, just say what will happen
  const screen = f.areas.some((a) => a.screen), door = f.areas.some((a) => a.door && a.doorOutside);
  lines.push({ id: 'screen', level: 'ok', text: screen ? 'It has a big TV screen for React mode.' : 'No TV screen: React mode will use a floating screen.' });
  lines.push({ id: 'door', level: 'ok', text: door ? 'Friends walk in through the door.' : 'No door: friends appear right in their seats.' });
  void opts;
  const bad = lines.some((l) => l.level === 'bad');
  return { ok: !bad, seats, lines, summary: bad ? 'Needs a fix before you can use it' : seats >= 2 ? 'Ready to use' : 'Works, a quick fix makes it better' };
}

// ---------------------------------------------------------------- analysis (one call)
/** The correction matrix for a units / up-axis guess (floor offset added once the grid is known). */
export function fixRotation(up: string, scale: number): Mat4 | null {
  if (up === 'y' && scale === 1) return null;
  const s = Math.SQRT1_2;
  const q = up === 'z' ? [-s, 0, 0, s] : up === '-z' ? [s, 0, 0, s] : up === 'x' ? [0, 0, s, s] : up === '-x' ? [0, 0, -s, s] : up === '-y' ? [1, 0, 0, 0] : [0, 0, 0, 1];
  return compose([0, 0, 0], q, [scale, scale, scale]);
}

function transformSoup(soup: TriangleSoup, m: Mat4): TriangleSoup {
  const t = new Float32Array(soup.tris.length);
  for (let i = 0; i < soup.tris.length; i += 3) { const [x, y, z] = apply(m, soup.tris[i], soup.tris[i + 1], soup.tris[i + 2]); t[i] = x; t[i + 1] = y; t[i + 2] = z; }
  return { tris: t, count: soup.count, unreadable: soup.unreadable };
}

/** An on/off flag in a file or a query: false / 0 / "false" / "off" / "no" = off, true / 1 / "true" / "on" / "yes" = on,
 *  anything else = no say (undefined). */
export function parseAutoFixFlag(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1) return v === 1;
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase();
  return ['false', '0', 'off', 'no'].includes(t) ? false : ['true', '1', 'on', 'yes'].includes(t) ? true : undefined;
}

/** The room's own say on the import auto-fix (units / up axis / floor / added places): `autoFix` in its scene.json (an
 *  installed room being updated; the owner's word wins), else in the GLB's scene extras (Blender: a scene custom property
 *  "autoFix" = False, exported with export_extras=True). An authored room with areas whose show floor isn't its lowest
 *  floor (a 40 m walker ship: deck at 0, cabin at -7, sand at -12.8) says false so nothing lifts it. undefined = no say. */
export function declaredAutoFix(json: GltfJson, sceneJson?: Record<string, unknown> | null): boolean | undefined {
  const fromJson = sceneJson ? parseAutoFixFlag(sceneJson.autoFix) : undefined;
  if (fromJson !== undefined) return fromJson;
  const sc = json.scenes?.[typeof json.scene === 'number' ? json.scene : 0];
  const ex = sc?.extras;
  return ex && typeof ex === 'object' ? parseAutoFixFlag((ex as Record<string, unknown>).autoFix) : undefined;
}

export interface AnalyzeOpts { sceneJson?: Record<string, unknown> | null; soup?: TriangleSoup; avatarHeight?: number; maxTris?: number }
/** Read + check a room file. `soup` = triangles from elsewhere (the browser's three.js loader for meshopt rooms). */
export function analyzeRoom(bytes: ArrayBuffer | Uint8Array, opts: AnalyzeOpts = {}): RoomAnalysis {
  const glb = parseGlb(bytes);
  const len = bytes instanceof Uint8Array ? bytes.length : bytes.byteLength;
  return analyzeParsed(glb, len, opts);
}

export function analyzeParsed(glb: Glb, byteLength: number, opts: AnalyzeOpts = {}): RoomAnalysis {
  const raw = opts.soup ?? triangleSoup(glb.json, glb.bin, { maxTris: opts.maxTris ?? 600_000 });
  const su = guessScaleAndUp(raw);
  const rot = fixRotation(su.up, su.scale);
  let fix = rot, soup = rot ? transformSoup(raw, rot) : raw;
  let grid = buildGrid(soup, contractBox(glb.json, rot));
  const floor = grid?.floorY ?? 0;
  if (grid && Math.abs(floor) > 0.25) {
    fix = mul(compose([0, -floor, 0]), rot ?? identity());
    soup = transformSoup(raw, fix);
    grid = buildGrid(soup, contractBox(glb.json, fix));
  }
  const facts = roomFacts(glb, byteLength, raw, grid, opts.sceneJson, opts.avatarHeight, fix);
  facts.floorY = grid ? round(floor, 2) : null;
  const report = checkRoom(facts);
  // the user's own Room editor layer (merged into sceneJson by the helper: shared/roomEdits.ts mergeRoomEdits)
  if (opts.sceneJson && opts.sceneJson.userEdits) report.lines.push(...editLines(glb.json, opts.sceneJson, opts.avatarHeight));
  return { glb, facts, report, grid, soup, fix, sceneJson: opts.sceneJson ?? null };
}

/** The middle of the authored contract nodes (cameras, spots, screen, door), in fixed space: where the analysis box goes
 *  (and how big it must be to hold them all). */
function contractBox(json: GltfJson, fix: Mat4 | null): { center: V3 | null; span?: number } {
  const { world, reached } = worldMatrices(json);
  const pts: V3[] = [];
  (json.nodes ?? []).forEach((n, i) => { if (reached[i] && /^(SPOT_\d|CAM_|SCREEN$|DOOR$|PATH_)/.test(stripArea(n.name ?? ''))) { const p = apply(world[i], 0, 0, 0); pts.push(fix ? apply(fix, ...p) : p); } });
  if (!pts.length) return { center: null };
  const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  return { center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], span: Math.max(16, Math.max(hi[0] - lo[0], hi[2] - lo[2]) + 6) };
}

/** Where an area's new places may go (x0, z0, x1, z1 in fixed space): scene.json areas.<key>.bounds, else the box of
 *  the area's own contract nodes (+1.5 m); null = anywhere (a room without areas). */
export function areaRegion(a: RoomAnalysis, area: AreaFact | undefined): [number, number, number, number] | null {
  if (!area?.prefix) return null;
  const sa = (a.sceneJson?.areas as Record<string, { bounds?: unknown }> | undefined)?.[area.key];
  const b = sa?.bounds;
  if (Array.isArray(b) && b.length === 6 && b.every((v) => typeof v === 'number')) {
    const lo = a.fix ? apply(a.fix, b[0], b[1], b[2]) : [b[0], b[1], b[2]], hi = a.fix ? apply(a.fix, b[3], b[4], b[5]) : [b[3], b[4], b[5]];
    return [Math.min(lo[0], hi[0]), Math.min(lo[2], hi[2]), Math.max(lo[0], hi[0]), Math.max(lo[2], hi[2])];
  }
  const { world, reached } = worldMatrices(a.glb.json);
  const pts: V3[] = [];
  // the area's own in-room anchors (not cameras, which may look in from outside, not DOOR_OUTSIDE, not far sky / event
  // anchors): their 10th-90th percentile box + 1 m
  (a.glb.json.nodes ?? []).forEach((n, i) => {
    const nm = n.name ?? '', b = stripArea(nm);
    if (!reached[i] || areaPrefix(nm) !== area.prefix || n.camera !== undefined || !/^(SPOT_|SCREEN|DOOR$|PATH_|LIGHT_|CHAT_|FLOOR_|COLLIDE_|BUDDY_)/.test(b)) return;
    const p = apply(world[i], 0, 0, 0); pts.push(a.fix ? apply(a.fix, ...p) : p);
  });
  if (!pts.length) return null;
  const q = (k: 0 | 2, f: number) => { const v = pts.map((p) => p[k]).sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * f)))]; };
  return [q(0, 0.1) - 1, q(2, 0.1) - 1, q(0, 0.9) + 1, q(2, 0.9) + 1];
}

// ---------------------------------------------------------------- "Place seats for me"
/** One place the fix adds (or the manual editor holds): a SPOT_xx + its talk camera. */
export interface PlannedSpot extends SeatPlace { name: string; area: string; cam: CamPlace | null }
export interface FixPlan {
  /** Correction for units / up axis / floor (null = none). Everything below is in fixed space. */
  fix: Mat4 | null;
  spots: PlannedSpot[];
  /** CAM_WIDE (per area that has none and gets new spots), named with the area prefix. */
  wides: CamPlace[];
  front: [number, number];
}

const spotName = (prefix: string, n: number) => `${prefix ? `${prefix}__` : ''}SPOT_${String(n).padStart(2, '0')}`;

/** Decide what to add: for every area without a usable seat (or the room itself), up to `want` places with talk
 *  cameras, numbered after the area's existing SPOTs, plus CAM_WIDE where the area has none. */
export function planFix(a: RoomAnalysis, opts: { want?: number; avatarHeight?: number; areas?: string[] } = {}): FixPlan {
  const out: FixPlan = { fix: a.fix, spots: [], wides: [], front: [0, 1] };
  if (!a.grid) return out;
  const need = a.facts.areas.filter((x) => (opts.areas ? opts.areas.includes(x.key) : x.usable < 2));
  const targets = need.length ? need : [];
  const taken: V3[] = a.facts.areas.flatMap((x) => x.spots.filter((s) => !s.problems.includes('inside')).map((s) => (a.fix ? apply(a.fix, ...s.position) : s.position)));
  for (const area of targets) {
    const used = new Set(area.spots.map((s) => s.index));
    const free: number[] = [];
    for (let n = 1; n <= 12; n++) if (!used.has(n)) free.push(n);
    const want = Math.min(free.length, Math.max(2 - area.usable, opts.want ?? 4));
    if (want <= 0) continue;
    const avoid = a.facts.areas.map((x) => x.screenBox).filter((b): b is [number, number, number, number, number] => !!b).map((b) => fixedBox(a, b));
    const plan: AutoPlan = autoPlace(a.grid, { want, existing: taken, firstIndex: 1, needWide: !area.hasWide, avatarHeight: opts.avatarHeight, region: areaRegion(a, area), avoid });
    plan.places.forEach((p, i) => {
      const name = spotName(area.prefix, free[i]);
      const cam = plan.cams[i] ? { ...plan.cams[i], name: `${name}_CAM` } : null;
      out.spots.push({ ...p, name, area: area.key, cam });
      taken.push(p.position);
    });
    if (plan.wide) out.wides.push({ ...plan.wide, name: `${area.prefix ? `${area.prefix}__` : ''}CAM_WIDE` });
    out.front = plan.front;
  }
  return out;
}

/** A file-space floor box in fixed space. */
function fixedBox(a: RoomAnalysis, b: [number, number, number, number, number]): [number, number, number, number, number] {
  if (!a.fix) return b;
  const p = apply(a.fix, b[0], b[4], b[1]), q = apply(a.fix, b[2], b[4], b[3]);
  return [Math.min(p[0], q[0]), Math.min(p[2], q[2]), Math.max(p[0], q[0]), Math.max(p[2], q[2]), Math.min(p[1], q[1])];
}

/** A place added by hand ("Let me place them"): the next free SPOT number of `area`, a talk camera when one fits. */
export function manualSpot(a: RoomAnalysis, plan: FixPlan, at: V3, opts: { area?: string; pose?: 'sit' | 'stand'; seatHeight?: number; yawDeg?: number; avatarHeight?: number } = {}): PlannedSpot | null {
  const area = a.facts.areas.find((x) => x.key === (opts.area ?? a.facts.areas[0]?.key)) ?? a.facts.areas[0];
  const prefix = area?.prefix ?? '';
  const used = new Set([...(area?.spots.map((s) => s.index) ?? []), ...plan.spots.filter((s) => s.area === (area?.key ?? '')).map((s) => +(/SPOT_(\d\d)$/.exec(s.name)?.[1] ?? 0))]);
  let n = 1;
  while (used.has(n) && n <= 12) n++;
  if (n > 12) return null;
  const yawDeg = opts.yawDeg ?? Math.round((Math.atan2(plan.front[0], plan.front[1]) * 180) / Math.PI);
  const p: SeatPlace = { position: at, yawDeg, pose: opts.pose ?? 'stand', seatHeight: opts.pose === 'sit' ? opts.seatHeight ?? 0.45 : undefined, seatDepth: opts.pose === 'sit' ? 0.5 : undefined, label: opts.pose === 'sit' ? 'My seat' : 'My spot', score: 0, source: 'manual' };
  const name = spotName(prefix, n);
  return { ...p, name, area: area?.key ?? '', cam: a.grid ? talkCamera(a.grid, p, `${name}_CAM`, opts.avatarHeight) : null };
}

/** Re-aim a planned spot's camera after it was dragged / turned (null when no clear view fits: the engine's automatic
 *  camera operator then frames it). */
export function refreshSpotCam(a: RoomAnalysis, s: PlannedSpot, avatarHeight?: number): PlannedSpot {
  return { ...s, cam: a.grid ? talkCamera(a.grid, s, `${s.name}_CAM`, avatarHeight) : null };
}

/** Problems of a planned spot (empty = fine): 'inside' furniture / a wall, 'floating' in the air. */
export const plannedProblems = (a: RoomAnalysis, s: Pick<SeatPlace, 'position' | 'pose' | 'seatHeight' | 'yawDeg'>, avatarHeight?: number) => (a.grid ? spotProblems(a.grid, s, avatarHeight) : []);

/** The nodes a plan writes. Positions are in FIXED space: the wrapper is applied to the room itself, the new nodes
 *  sit next to it at the scene root. */
export function planNodes(plan: Pick<FixPlan, 'spots' | 'wides'>): NewNode[] {
  const out: NewNode[] = [];
  for (const p of plan.spots) {
    const extras: Record<string, unknown> = { pose: p.pose, label: p.label, placedBy: 'vtubepro-room-wizard' };
    if (p.pose === 'sit') { extras.seatHeight = round(p.seatHeight ?? 0.45); extras.seatDepth = round(p.seatDepth ?? 0.5); }
    out.push({ kind: 'empty', name: p.name, position: p.position, yawDeg: p.yawDeg, extras });
    if (p.cam) out.push({ kind: 'camera', name: p.cam.name, position: p.cam.position, target: p.cam.target, yfovDeg: p.cam.yfovDeg });
  }
  for (const w of plan.wides) out.push({ kind: 'camera', name: w.name, position: w.position, target: w.target, yfovDeg: w.yfovDeg });
  return out;
}

/** A starter scene.json for an imported room (keeps every key of `prev`, only fills what's missing). */
export function sceneJsonFor(name: string, a: RoomAnalysis, prev?: Record<string, unknown> | null, added: NewNode[] = []): Record<string, unknown> {
  const j: Record<string, unknown> = { ...(prev ?? {}) };
  j.name = typeof j.name === 'string' && j.name ? j.name : name.slice(0, 80);
  j.model = 'scene.glb';
  const hasScreen = a.facts.areas.some((x) => x.screen);
  if (!Array.isArray(j.modes)) j.modes = hasScreen ? ['talk', 'react'] : ['talk'];
  const names = new Set([...(a.glb.json.nodes ?? []).map((n) => stripArea(n.name ?? '')), ...added.map((n) => stripArea(n.name))]);
  if (!j.defaultCamera && names.has('CAM_WIDE')) j.defaultCamera = 'CAM_WIDE';
  if (!j.reactCamera && names.has('CAM_REACT')) j.reactCamera = 'CAM_REACT';
  if (typeof j.avatarHeight !== 'number') j.avatarHeight = 1.5;
  if (!j.hostSpot) j.hostSpot = 'SPOT_01';
  // areas found by node prefix but not declared: declare them, so each area works as its own room
  const pre = a.facts.areas.map((x) => x.prefix).filter(Boolean);
  if (pre.length && !j.areas) {
    j.areas = Object.fromEntries(pre.map((p) => [p.toLowerCase(), { name: `${j.name} – ${nice(p.toLowerCase())}`, label: nice(p.toLowerCase()) }]));
    j.defaultArea = pre[0].toLowerCase();
  }
  j.importedWith = 'vtubepro-room-wizard/1';
  return j;
}

/** Apply a plan to the room: wrapper (units / axes / floor) + new nodes → GLB bytes + scene.json. */
export function applyFix(a: RoomAnalysis, plan: Pick<FixPlan, 'fix' | 'spots' | 'wides'>, name: string, prevSceneJson?: Record<string, unknown> | null): { glb: Uint8Array; sceneJson: Record<string, unknown>; added: string[] } {
  const json = JSON.parse(JSON.stringify(a.glb.json)) as GltfJson;
  if (plan.fix) wrapRoot(json, plan.fix);
  const nodes = planNodes(plan);
  const added = addRoomNodes(json, nodes);
  json.asset = { ...(json.asset ?? { version: '2.0' }), version: '2.0' };
  const bytes = writeGlb(json, a.glb.bin);
  return { glb: bytes, sceneJson: sceneJsonFor(name, a, prevSceneJson, nodes), added };
}

/** For AIs (MCP check_room): the report, the suggested fix as plain data, and the checklist ids that failed. */
export function aiRoomReport(a: RoomAnalysis, plan: FixPlan | null) {
  return {
    ok: a.report.ok, seats: a.report.seats, summary: a.report.summary,
    lines: a.report.lines.map((l) => ({ id: l.id, level: l.level, text: l.text, ...(l.detail ? { detail: l.detail } : {}), ...(l.fix ? { fix: l.fix } : {}), ...(l.needsHelper ? { needsHelper: true } : {}), ...(l.autoFix ? { autoFix: true } : {}) })),
    facts: { ...a.facts, areas: a.facts.areas.map((x) => ({ ...x, spots: x.spots.map((s) => ({ ...s })) })) },
    suggestion: plan ? {
      note: 'glTF space (metres, +Y up, +Z front). Add these as empties / cameras (Blender: G(x,y,z) = (x,-z,y); empties face -Y), or let the studio\'s "Add my room" wizard / POST /api/rooms/import?autoSeats=1 write them.',
      correction: plan.fix ? Array.from(plan.fix, (v) => round(v, 5)) : null,
      nodes: planNodes(plan),
    } : null,
    checklist: ROOM_CHECKLIST.map((c) => c.id),
  };
}


// ---------------------------------------------------------------- the user's own edits (Room editor)
/** Euler (deg, three.js order YXZ) → quaternion [x, y, z, w]. */
export function quatYXZ(rotDeg: number[]): [number, number, number, number] {
  const [x, y, z] = rotDeg.map((d) => (d * Math.PI) / 360);
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
}

/** The room as the user's edits leave it (spots, cameras, the react screen, props: glTF space) — the same data the
 *  editor's live warnings use (shared/roomEditCheck.ts). `sceneJson` = the merged scene.json (cameraOverrides,
 *  spotOverrides, screenEdit, placedProps, userEdits). Area rooms: the edits' area picks that area's anchors. */
export function editViewFromGlb(json: GltfJson, sceneJson: Record<string, unknown>, avatarHeight?: number): CheckView {
  const ed = sceneJson.userEdits as RoomEdits | undefined;
  const area = (ed?.room ?? '').split('~')[1] ?? '';
  const areaKeys = sceneJson.areas && typeof sceneJson.areas === 'object' ? Object.keys(sceneJson.areas as object) : [];
  const mine = (area || (typeof sceneJson.defaultArea === 'string' ? sceneJson.defaultArea : areaKeys[0] ?? '')).toUpperCase();
  const { world, reached } = worldMatrices(json);
  const spots = new Map<string, CheckSpot>(), cams = new Map<string, CheckCam>();
  let screen: { m: Mat4; corners: V3[] } | null = null;
  const nodes = json.nodes ?? [];
  const meshBox = (i: number): [number[], number[]] | null => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const visit = (k: number, m: Mat4, d: number) => {
      const n = nodes[k];
      if (!n || d > 6) return;
      if (n.mesh !== undefined) for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
        const acc = json.accessors?.[p.attributes?.POSITION as number];
        if (!acc?.min || !acc.max) continue;
        for (let c = 0; c < 8; c++) {
          const q = apply(m, c & 1 ? acc.max[0] : acc.min[0], c & 2 ? acc.max[1] : acc.min[1], c & 4 ? acc.max[2] : acc.min[2]);
          for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]); }
        }
      }
      for (const c of n.children ?? []) visit(c, mul(m, localMatrix(nodes[c])), d + 1);
    };
    visit(i, identity(), 0);
    return lo.every(Number.isFinite) ? [lo, hi] : null;
  };
  nodes.forEach((n, i) => {
    if (!reached[i]) return;
    const pre = areaPrefix(n.name ?? '');
    if (pre && areaKeys.length && pre !== mine) return;
    const name = stripArea(n.name ?? '');
    const w = world[i];
    let m: RegExpExecArray | null;
    if ((m = /^(?:SPOT|SEAT)_(\d{1,2})$/.exec(name)) && +m[1] >= 1 && +m[1] <= 12) {
      const key = `SPOT_${m[1].padStart(2, '0')}`;
      if (spots.has(key) && !pre) return;
      const ex = (n.extras ?? {}) as Record<string, unknown>;
      const pose: 'sit' | 'stand' = /^SEAT_/.test(name) ? (ex.pose === 'stand' ? 'stand' : 'sit') : ex.pose === 'sit' ? 'sit' : 'stand';
      spots.set(key, { key, label: typeof ex.label === 'string' ? ex.label.slice(0, 40) : undefined, pos: apply(w, 0, 0, 0) as V3, yawDeg: yawOf(w), pose, seatHeight: pose === 'sit' ? Math.max(0.15, Math.min(1.4, typeof ex.seatHeight === 'number' ? ex.seatHeight : 0.45)) : undefined });
    } else if ((m = /^(CAM_[A-Z0-9_]+)$|^SPOT_(\d{1,2})_CAM$/.exec(name))) {
      const key = m[1] ?? `SPOT_${m[2].padStart(2, '0')}_CAM`;
      if (cams.has(key) && !pre) return;
      const pos = apply(w, 0, 0, 0) as V3, f = dirNegZ(w);
      const yfov = n.camera !== undefined ? json.cameras?.[n.camera]?.perspective?.yfov : undefined;
      cams.set(key, { name: key, pos, target: [pos[0] + f[0], pos[1] + f[1], pos[2] + f[2]], fov: yfov ? (yfov * 180) / Math.PI : 35 });
    } else if (name === 'SCREEN' && (!screen || pre)) {
      const bx = meshBox(i);
      if (!bx) return;
      const [lo, hi] = bx, size = [0, 1, 2].map((k) => hi[k] - lo[k]);
      const thin = size.indexOf(Math.min(...size)), [a, c] = [0, 1, 2].filter((k) => k !== thin);
      const mid = (lo[thin] + hi[thin]) / 2;
      const corner = (ua: number, uc: number): V3 => { const p: V3 = [0, 0, 0]; p[thin] = mid; p[a] = ua; p[c] = uc; return p; };
      screen = { m: w, corners: [corner(lo[a], lo[c]), corner(hi[a], lo[c]), corner(hi[a], hi[c]), corner(lo[a], hi[c])] };
    }
  });
  // scene.json cams + cameraOverrides (incl. the user's)
  for (const k of ['cams', 'cameraOverrides']) {
    const o = sceneJson[k];
    if (!o || typeof o !== 'object') continue;
    for (const [name, v] of Object.entries(o as Record<string, unknown>)) {
      if (!/^(CAM_[A-Z0-9_]+|SPOT_\d\d_CAM)$/.test(name)) continue;
      if (v === null) { cams.delete(name); continue; }
      const c = v as { pos?: number[]; target?: number[]; fov?: number };
      if (Array.isArray(c.pos) && Array.isArray(c.target) && c.pos.length === 3 && c.target.length === 3) cams.set(name, { name, pos: c.pos as V3, target: c.target as V3, fov: typeof c.fov === 'number' ? c.fov : 35 });
    }
  }
  const so = sceneJson.spotOverrides as Record<string, { pos?: number[]; yaw?: number }> | undefined;
  if (so && typeof so === 'object') for (const [k, o] of Object.entries(so)) {
    const s = spots.get(k);
    if (!s || !o) continue;
    if (Array.isArray(o.pos) && o.pos.length === 3) s.pos = o.pos as V3;
    if (typeof o.yaw === 'number') s.yawDeg = o.yaw;
  }
  // the react screen (the user's screenEdit: room-space position / rotation, scale on top of the authored size)
  let sc: CheckView['screen'] = null;
  const S = screen as { m: Mat4; corners: V3[] } | null;
  if (S) {
    let m = S.m;
    const se = sceneJson.screenEdit as { pos?: number[]; rot?: number[]; scale?: number } | undefined;
    if (se && Array.isArray(se.pos) && Array.isArray(se.rot)) {
      const k = typeof se.scale === 'number' ? se.scale : 1;
      const sx = Math.hypot(m[0], m[1], m[2]) * k, sy = Math.hypot(m[4], m[5], m[6]) * k, sz = Math.hypot(m[8], m[9], m[10]) * k;
      m = compose(se.pos, quatYXZ(se.rot), [sx, sy, sz]);
    }
    const corners = S.corners.map((p) => apply(m, p[0], p[1], p[2]) as V3) as [V3, V3, V3, V3];
    sc = { corners, center: [0, 1, 2].map((k) => corners.reduce((s, q) => s + q[k], 0) / 4) as V3 };
  }
  const props: CheckProp[] = [];
  const pp = sceneJson.placedProps;
  if (Array.isArray(pp)) for (const p of pp as { uid?: string; src?: string; pos?: V3; rot?: V3; scale?: number; box?: [number, number, number, number, number, number] }[]) {
    if (!p || !Array.isArray(p.pos) || !Array.isArray(p.rot)) continue;
    const b = propBox(p.box, p.pos, p.rot, p.scale ?? 1);
    props.push({ uid: String(p.uid ?? ''), name: nice(String(p.src ?? 'prop').split('/').pop() ?? 'prop'), min: b.min, max: b.max });
  }
  const cs = sceneJson.chatScreens;
  if (Array.isArray(cs)) for (const c of cs as { uid?: string; pos?: V3; yaw?: number; pitch?: number; width?: number; height?: number; face?: string }[]) {
    if (!c || !Array.isArray(c.pos) || typeof c.width !== 'number' || typeof c.height !== 'number') continue;
    const b = chatScreenBox({ pos: c.pos, yaw: c.yaw ?? 0, pitch: c.pitch, width: c.width, height: c.height, face: c.face });
    props.push({ uid: String(c.uid ?? ''), name: 'The chat screen', min: b.min, max: b.max });
  }
  return {
    spots: [...spots.values()], cams: [...cams.values()], screen: sc, props,
    avatarHeight: avatarHeight ?? (typeof sceneJson.avatarHeight === 'number' ? sceneJson.avatarHeight : 1.5),
    edited: { cams: Object.keys(ed?.cameras ?? {}), spots: Object.keys(ed?.spots ?? {}), screen: !!ed?.screen },
  };
}

/** Report lines (id "edits") for the user's own Room editor changes. */
export function editLines(json: GltfJson, sceneJson: Record<string, unknown>, avatarHeight?: number): RoomLine[] {
  const ws = checkEditView(editViewFromGlb(json, sceneJson, avatarHeight));
  const fix = ROOM_CHECKLIST.find((c) => c.id === 'edits')!.fix;
  if (!ws.length) return [{ id: 'edits', level: 'ok', text: 'Your own changes keep every face and the react screen in view.' }];
  return ws.slice(0, 12).map((w) => ({ id: 'edits', level: 'warn' as const, text: w.text, detail: `(${w.anchor})`, fix }));
}
