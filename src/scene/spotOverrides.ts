// scene.json `spotOverrides` (docs/SCENES.md → Spots): move / turn an authored SPOT_xx without re-exporting the GLB —
// a QA fix for a spot whose performer clips into room geometry (a slide tube through the head) or is hidden from every
// camera, kept in scene.json so a room rebuild doesn't lose it. glTF space, like `cameraOverrides`:
//
//   "spotOverrides": { "SPOT_12": { "pos": [x, y, z], "yaw": 180, "approach": [], "note": "why" } }
//
//   pos       new root position (glTF / room-local metres); omitted = unchanged
//   yaw       new facing in degrees about +Y (0 = +Z, the glTF front); omitted = unchanged
//   approach  entrance waypoints (flat x,y,z list, glTF space) replacing the node's extras.approach; [] = walk straight
//             from the path. When `pos` moves the spot and `approach` is omitted, the old waypoints are kept only if
//             they are still within 3 m of the new position.
//
// Applied once when the room loads (before the mover, size spots and cameras use the spots).
import * as THREE from 'three';
import type { RoomInfo } from './contract.ts';

const v3 = (a: unknown) => (Array.isArray(a) && a.length === 3 && a.every((x) => typeof x === 'number' && Number.isFinite(x)) ? new THREE.Vector3(a[0], a[1], a[2]) : null);

export function applySpotOverrides(room: RoomInfo, raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const done: string[] = [];
  const rootQ = room.root.getWorldQuaternion(new THREE.Quaternion());
  for (const [name, o] of Object.entries(raw as Record<string, unknown>)) {
    const m = /^SPOT_(\d{1,2})$/.exec(name);
    if (!m || !o || typeof o !== 'object') continue;
    const s = room.spots[+m[1] - 1];
    if (!s) continue;
    const x = o as { pos?: unknown; yaw?: unknown; approach?: unknown };
    const p = v3(x.pos);
    if (p) s.position.copy(room.root.localToWorld(p));
    if (typeof x.yaw === 'number' && Number.isFinite(x.yaw)) {
      const f = new THREE.Vector3(Math.sin(THREE.MathUtils.degToRad(x.yaw)), 0, Math.cos(THREE.MathUtils.degToRad(x.yaw))).applyQuaternion(rootQ).setY(0);
      if (f.lengthSq() > 1e-6) { f.normalize(); s.forward.copy(f); s.yaw = Math.atan2(f.x, f.z); }
    }
    if (Array.isArray(x.approach)) {
      const pts: THREE.Vector3[] = [];
      const a = x.approach as unknown[];
      for (let i = 0; i + 2 < a.length; i += 3) {
        const q = v3([a[i], a[i + 1], a[i + 2]]);
        if (q) pts.push(room.root.localToWorld(q));
      }
      s.approach = pts;
    } else if (p) s.approach = s.approach.filter((q) => q.distanceTo(s.position) < 3);
    done.push(name);
  }
  return done;
}

/** scene.json `hideNodes`: room nodes (exact names, with their children) never drawn or ray-tested — a broken prop in a
 *  room GLB (a sign whose lettering is on the wrong face) hidden until the room is rebuilt. */
export function applyHideNodes(room: RoomInfo, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 80));
  const done: string[] = [];
  const hits: THREE.Object3D[] = [];
  room.root.traverse((o) => { if (names.has(o.name)) { hits.push(o); done.push(o.name); } });
  hideFromRoom(room, ...hits);
  return done;
}

/** Hide room nodes (with their children) from drawing AND from every ray test (room.occluders) — `hideNodes`, screen
 *  skin templates. */
export function hideFromRoom(room: RoomInfo, ...nodes: THREE.Object3D[]) {
  const gone = new Set<THREE.Object3D>();
  for (const n of nodes) { n.visible = false; n.traverse((c) => gone.add(c)); }
  if (!gone.size) return;
  const keep = room.occluders.filter((m) => !gone.has(m));
  room.occluders.length = 0;
  room.occluders.push(...keep);
}

/** scene.json `lightGroupsOff` (Creator Console "light groups" toggles): those LIGHT_ / EMIT_ groups stay dark — their
 *  fixtures leave the light engine (no real light, no show program) and their EMIT_ materials stop glowing. */
export function applyLightGroupsOff(room: RoomInfo, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const off = new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 32));
  if (!off.size) return [];
  const keepF = room.fixtures.filter((f) => !off.has(f.group));
  const dark = [...room.fixtures.filter((f) => off.has(f.group)).flatMap((f) => f.materials), ...room.emissive.filter((e) => off.has(e.group)).map((e) => e.material)];
  const keepE = room.emissive.filter((e) => !off.has(e.group));
  room.fixtures.length = 0; room.fixtures.push(...keepF);
  room.emissive.length = 0; room.emissive.push(...keepE);
  for (const m of new Set(dark)) m.emissiveIntensity = 0;
  return [...off];
}
