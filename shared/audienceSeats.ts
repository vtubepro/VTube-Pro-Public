// Audience seats (docs/SCENES.md "Chat audience"): the room convention + the pure seat planner, shared by the pages
// (src/scene/audience/audienceRoom.ts reads the anchors) and the unit tests (tools/audience_unit.ts).
//
// Room convention (glTF space: metres, +Y up, stage front +Z; all optional, a room may mix them):
//   AUDIENCE_SEAT_xx   an empty = one seat. Origin = the floor point under the sitter (or where a stander's feet go);
//                      the node's +Z faces the stage. extras: pose "sit" | "stand" (default sit), seatHeight (m, sit,
//                      default 0.45).
//   AUDIENCE_AREA_xx   an empty (or a box mesh, hidden at run time) = a block of seats filled automatically. Origin = the
//                      centre of the block on the floor; +Z faces the stage. extras: w (width m, along local X), d (depth
//                      m, along local Z; a box mesh gives both from its size), spacing (seat pitch, 0.62), rowGap (row
//                      pitch, 0.9), rise (each row back steps up this much: bleachers, 0), pose, seatHeight, stagger
//                      (true: odd rows shift half a seat), rows (cap).
//   CAM_AUDIENCE       (optional) a camera looking at the audience (reaction shots); else one is derived.
//   scene.json `audience` { on, seats: [[x,y,z,yawDeg,"sit"|"stand"]…], areas: [{center:[x,y,z], yaw: deg, w, d, …}],
//                      camera: "CAM_AUDIENCE", height (body scale, 1), max (seat cap) } — the same without a GLB rebuild.
// Rooms with none of these but a background crowd (scene.json `crowd`) put chat names over the crowd's characters.
//
// Seat ORDER is what makes every page seat a chatter in the same place: the helper hands out slots (0 = best seat), the
// page sorts its seats front row first, centre outwards (left before right at equal distance), areas interleaved by
// row; slot i sits in seat i.

export type SeatPose = 'sit' | 'stand';
export interface SeatSpec {
  x: number; y: number; z: number;
  /** yaw (rad) about +Y that turns +Z onto the facing direction */
  yaw: number;
  pose: SeatPose;
  /** seat surface above the origin (sit) */
  seatHeight: number;
  /** ordering keys: row (0 = front) and signed lateral offset (m) from the block's centre line */
  row: number; lat: number;
  /** which area / seat group it came from */
  group: number;
  name: string;
}
export interface AreaSpec {
  center: [number, number, number];
  /** yaw (rad) */
  yaw: number;
  w: number; d: number;
  spacing?: number; rowGap?: number; rise?: number; pose?: SeatPose; seatHeight?: number; stagger?: boolean; rows?: number;
  name?: string;
}
export interface RoomAudienceConfig {
  on?: boolean;
  seats?: [number, number, number, number?, SeatPose?][];
  areas?: (Omit<AreaSpec, 'yaw'> & { yaw?: number })[];
  camera?: string;
  height?: number;
  max?: number;
}

export const SEAT_DEFAULTS = { spacing: 0.62, rowGap: 0.9, rise: 0, seatHeight: 0.45 };
export const MAX_SEATS = 400;

const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : d);

/** Seats of one area block: rows from the front (+Z edge, nearest the stage) backwards, seats across each row. */
export function seatsFromArea(a: AreaSpec, group = 0): SeatSpec[] {
  const spacing = Math.max(0.35, fin(a.spacing, SEAT_DEFAULTS.spacing)), rowGap = Math.max(0.4, fin(a.rowGap, SEAT_DEFAULTS.rowGap));
  const w = Math.max(0, fin(a.w, 0)), d = Math.max(0, fin(a.d, 0));
  const pose: SeatPose = a.pose === 'stand' ? 'stand' : 'sit';
  const seatHeight = pose === 'sit' ? Math.max(0, fin(a.seatHeight, SEAT_DEFAULTS.seatHeight)) : 0;
  const rise = fin(a.rise, SEAT_DEFAULTS.rise);
  let rows = Math.max(1, Math.floor(d / rowGap + 1e-6));
  if (a.rows !== undefined) rows = Math.max(1, Math.min(rows, Math.round(fin(a.rows, rows))));
  const per = Math.max(1, Math.floor(w / spacing + 1e-6));
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  const out: SeatSpec[] = [];
  for (let r = 0; r < rows; r++) {
    const odd = a.stagger !== false && r % 2 === 1 && per > 1;
    const n = odd ? per - 1 : per;
    const lz = d / 2 - rowGap / 2 - r * rowGap;          // front row nearest the stage (+Z)
    for (let i = 0; i < n; i++) {
      const lx = (i - (n - 1) / 2) * spacing;
      out.push({
        x: a.center[0] + lx * c + lz * s, y: a.center[1] + r * rise, z: a.center[2] - lx * s + lz * c, yaw: a.yaw, pose, seatHeight,
        // +lat = the sitters' right (facing +Z local, their right is local -X)
        row: r, lat: -lx, group, name: `${a.name ?? `AREA_${group}`}:${r}:${i}`,
      });
      if (out.length >= MAX_SEATS) return out;
    }
  }
  return out;
}

/** Single seats: rows / lateral offsets measured from the stage focus (the room's spots), 0.9 m per row. */
export function seatsFromPoints(pts: { x: number; y: number; z: number; yaw: number; pose?: SeatPose; seatHeight?: number; name: string }[], focus: { x: number; z: number }, group = 1000): SeatSpec[] {
  if (!pts.length) return [];
  const near = Math.min(...pts.map((p) => Math.hypot(p.x - focus.x, p.z - focus.z)));
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cz = pts.reduce((a, p) => a + p.z, 0) / pts.length;
  // the block's facing: from its centre towards the stage
  const fx = focus.x - cx, fz = focus.z - cz, fl = Math.hypot(fx, fz) || 1;
  const rx = -fz / fl, rz = fx / fl;   // right-hand side when facing the stage (facing -Z → right is +X)
  return pts.map((p) => {
    const pose: SeatPose = p.pose === 'stand' ? 'stand' : 'sit';
    return {
      x: p.x, y: p.y, z: p.z, yaw: p.yaw, pose, seatHeight: pose === 'sit' ? (p.seatHeight ?? SEAT_DEFAULTS.seatHeight) : 0,
      row: Math.round((Math.hypot(p.x - focus.x, p.z - focus.z) - near) / SEAT_DEFAULTS.rowGap), lat: (p.x - cx) * rx + (p.z - cz) * rz, group, name: p.name,
    };
  });
}

/** The seat order every page uses: row, then distance from the centre line, left before right, then group, then name. */
export function orderSeats(seats: SeatSpec[]): SeatSpec[] {
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return [...seats].sort((a, b) => a.row - b.row || r3(Math.abs(a.lat)) - r3(Math.abs(b.lat)) || Math.sign(a.lat) - Math.sign(b.lat) || a.group - b.group || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, MAX_SEATS);
}

/** scene.json `audience`, checked (yaw in degrees in the file → radians here). */
export function roomAudienceConfig(raw: unknown): { on: boolean; seats: { x: number; y: number; z: number; yaw: number; pose: SeatPose; name: string }[]; areas: AreaSpec[]; camera: string; height: number; max: number } {
  const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const D2R = Math.PI / 180;
  const v3 = (v: unknown): [number, number, number] | null => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] as [number, number, number] : null);
  const seats = (Array.isArray(x.seats) ? x.seats : []).slice(0, MAX_SEATS).map((s, i) => {
    const p = v3(s); if (!p) return null;
    const a = s as unknown[];
    return { x: p[0], y: p[1], z: p[2], yaw: fin(a[3], 0) * D2R, pose: (a[4] === 'stand' ? 'stand' : 'sit') as SeatPose, name: `json:${String(i).padStart(3, '0')}` };
  }).filter((s): s is NonNullable<typeof s> => !!s);
  const areas = (Array.isArray(x.areas) ? x.areas : []).slice(0, 24).map((r, i) => {
    const a = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const c = v3(a.center); if (!c) return null;
    const out: AreaSpec = { center: c, yaw: fin(a.yaw, 0) * D2R, w: fin(a.w, 4), d: fin(a.d, 2), name: `json_area_${i}` };
    if (a.spacing !== undefined) out.spacing = fin(a.spacing, SEAT_DEFAULTS.spacing);
    if (a.rowGap !== undefined) out.rowGap = fin(a.rowGap, SEAT_DEFAULTS.rowGap);
    if (a.rise !== undefined) out.rise = fin(a.rise, 0);
    if (a.seatHeight !== undefined) out.seatHeight = fin(a.seatHeight, SEAT_DEFAULTS.seatHeight);
    if (a.rows !== undefined) out.rows = fin(a.rows, 1);
    if (a.pose === 'stand') out.pose = 'stand';
    if (a.stagger === false) out.stagger = false;
    return out;
  }).filter((a): a is AreaSpec => !!a);
  return {
    on: x.on !== false, seats, areas, camera: typeof x.camera === 'string' && /^[A-Za-z0-9_]{1,48}$/.test(x.camera) ? x.camera : 'CAM_AUDIENCE',
    height: Math.min(1.6, Math.max(0.5, fin(x.height, 1))), max: Math.round(Math.min(MAX_SEATS, Math.max(1, fin(x.max, MAX_SEATS)))),
  };
}
