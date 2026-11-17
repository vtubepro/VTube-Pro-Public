// The chat audience: which seats a room has (the convention + order: shared/audienceSeats.ts). Read in rt.root space.
//   AUDIENCE_SEAT_xx    empties (one seat each)          AUDIENCE_AREA_xx   empties / box meshes (a block of seats)
//   CAM_AUDIENCE        optional reaction camera         scene.json `audience` the same without a GLB rebuild
// No seats + a background crowd (scene.json `crowd`) → 'crowd' mode: the names go over the crowd's own characters.
import * as THREE from 'three';
import { orderSeats, roomAudienceConfig, seatsFromArea, seatsFromPoints, type AreaSpec, type SeatPose, type SeatSpec } from '../../../shared/audienceSeats.ts';

export interface AudienceRoomInfo {
  mode: 'seats' | 'crowd' | 'none';
  /** ordered: slot i sits in seats[i] */
  seats: SeatSpec[];
  /** the stage focus (root space): the centre of the room's spots */
  focus: THREE.Vector3;
  camera: string;
  height: number;
  /** box meshes used as areas (hidden while the audience is attached) */
  areaMeshes: THREE.Object3D[];
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : d);
const tq = new THREE.Quaternion(), fwd = new THREE.Vector3();

function yawOf(o: THREE.Object3D, root: THREE.Object3D): number {
  o.getWorldQuaternion(tq);
  const rq = root.getWorldQuaternion(new THREE.Quaternion()).invert();
  fwd.set(0, 0, 1).applyQuaternion(tq).applyQuaternion(rq);
  return Math.atan2(fwd.x, fwd.z);
}

export function audienceRoomOf(root: THREE.Object3D, info: { audience?: unknown; crowd?: unknown }): AudienceRoomInfo {
  root.updateWorldMatrix(true, true);
  const cfg = roomAudienceConfig(info.audience);
  const pts: { x: number; y: number; z: number; yaw: number; pose?: SeatPose; seatHeight?: number; name: string }[] = [];
  const areas: AreaSpec[] = [];
  const areaMeshes: THREE.Object3D[] = [];
  const spots: THREE.Vector3[] = [];
  root.traverse((o) => {
    if (/^SPOT_\d{2}$/.test(o.name)) spots.push(root.worldToLocal(o.getWorldPosition(new THREE.Vector3())));
    if (/^AUDIENCE_SEAT_\d+/.test(o.name)) {
      const p = root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
      const x = o.userData ?? {};
      pts.push({ x: p.x, y: p.y, z: p.z, yaw: yawOf(o, root), pose: x.pose === 'stand' ? 'stand' : 'sit', ...(x.seatHeight !== undefined ? { seatHeight: num(x.seatHeight, 0.45) } : {}), name: o.name });
    } else if (/^AUDIENCE_AREA_\d+/.test(o.name)) {
      const x = o.userData ?? {};
      const c = root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
      let w = num(x.w, 0), d = num(x.d, 0);
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) {
        // a box mesh: its footprint in its own frame × its world scale; the floor is the box bottom
        mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox!, sc = o.getWorldScale(new THREE.Vector3());
        if (!w) w = (bb.max.x - bb.min.x) * sc.x;
        if (!d) d = (bb.max.z - bb.min.z) * sc.z;
        const bottom = root.worldToLocal(o.localToWorld(new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.min.y, (bb.min.z + bb.max.z) / 2)));
        c.copy(bottom);
        areaMeshes.push(o);
      }
      if (w <= 0 || d <= 0) { w = w || 4; d = d || 2; }
      const a: AreaSpec = { center: [c.x, c.y, c.z], yaw: yawOf(o, root), w, d, name: o.name };
      if (x.spacing !== undefined) a.spacing = num(x.spacing, 0.62);
      if (x.rowGap !== undefined) a.rowGap = num(x.rowGap, 0.9);
      if (x.rise !== undefined) a.rise = num(x.rise, 0);
      if (x.seatHeight !== undefined) a.seatHeight = num(x.seatHeight, 0.45);
      if (x.rows !== undefined) a.rows = num(x.rows, 1);
      if (x.pose === 'stand') a.pose = 'stand';
      if (x.stagger === false || x.stagger === 'false' || x.stagger === 0) a.stagger = false;
      areas.push(a);
    }
  });
  for (const s of cfg.seats) pts.push(s);
  areas.push(...cfg.areas);
  const focus = spots.length ? spots.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / spots.length) : new THREE.Vector3();
  const list: SeatSpec[] = [];
  areas.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')).forEach((a, i) => list.push(...seatsFromArea(a, i)));
  list.push(...seatsFromPoints(pts.sort((a, b) => a.name.localeCompare(b.name)), { x: focus.x, z: focus.z }));
  const seats = orderSeats(list).slice(0, cfg.max);
  const mode = !cfg.on ? 'none' : seats.length ? 'seats' : info.crowd ? 'crowd' : 'none';
  return { mode, seats, focus, camera: cfg.camera, height: cfg.height, areaMeshes };
}
