// Ambient crowd: the room contract. Rooms opt in with a scene.json `crowd` key and ACTIVITY_xx anchors (empties).
//
//   ACTIVITY_01                 extras: activity = band | dive | conga | armwrestle | swim | hop | canoe | climb | juggle | fish | dj | sleep
//                               (anything else = a generic 'idle' crowd spot), outfits = "cowboy,tophat" (one per frog),
//                               frogs = count, group = rotation group (activities in a group take turns), order = turn order,
//                               radius / rx / rz (circles, ellipses), note (free text)
//   ACTIVITY_01_P01 … _P12      ordered points (band positions, lily pads, climbing holds …); +Z = facing
//   ACTIVITY_01_<NAME>          named points (BOARD, SPLASH, LADDER, TOP, WATER, BOBBER …)
//   CROWD_FX_xx                 ambient effects: extras fx = fireflies | bubbles | smoke | fire, radius, height, count
//
// Positions are read in rt.root space (the crowd group lives under rt.root).
import * as THREE from 'three';

export interface CrowdPoint { name: string; pos: THREE.Vector3; yaw: number; extras: Record<string, unknown> }
export interface CrowdActivity {
  id: string; kind: string; group: string | null; order: number; outfits: string[]; frogs: number;
  anchor: CrowdPoint; pts: CrowdPoint[]; named: Map<string, CrowdPoint>; extras: Record<string, unknown>;
}
export interface CrowdFxSpot { kind: string; pos: THREE.Vector3; radius: number; height: number; count: number }
export interface CrowdRoom { acts: CrowdActivity[]; fx: CrowdFxSpot[] }

/** scene.json `crowd` */
export interface RoomCrowdConfig {
  /** GLB with the rig, clips, OUTFIT_* / PROP_* / ROOTPROP_* meshes (room-relative). */
  units?: string;
  /** 4x4 FX atlas (room-relative). */
  fx?: string;
  /** Frog height in metres (default 1.0). */
  height?: number;
  seed?: number;
  /** Water surface y (swimming, splashes). */
  water?: number;
  /** Seconds per turn in a rotation group (default 150). */
  turn?: number;
  /** EMIT_ groups that flash on support events (default sign, neon). */
  flash?: string[];
  /** Hard cap on simultaneous background characters (default 14). */
  max?: number;
  /** false = the crowd is off in this room. */
  on?: boolean;
}

const DEFAULT_FROGS: Record<string, number> = { band: 3, dive: 2, conga: 3, armwrestle: 2, swim: 3, hop: 2, canoe: 1, climb: 1, juggle: 1, fish: 1, dj: 1, sleep: 1 };

const tv = new THREE.Vector3(), tq = new THREE.Quaternion(), fwd = new THREE.Vector3();

function point(o: THREE.Object3D, root: THREE.Object3D): CrowdPoint {
  o.updateWorldMatrix(true, false);
  const pos = root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
  // +Z of the node in root space
  o.getWorldQuaternion(tq);
  const rq = root.getWorldQuaternion(new THREE.Quaternion()).invert();
  fwd.set(0, 0, 1).applyQuaternion(tq).applyQuaternion(rq);
  return { name: o.name, pos, yaw: Math.atan2(fwd.x, fwd.z), extras: { ...(o.userData ?? {}) } };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : d);

export function crowdRoomOf(root: THREE.Object3D): CrowdRoom | null {
  const acts = new Map<string, CrowdActivity>();
  const subs: [string, string, THREE.Object3D][] = [];
  const fx: CrowdFxSpot[] = [];
  root.traverse((o) => {
    const m = /^(ACTIVITY_\d{1,3})(?:_(.+))?$/.exec(o.name);
    if (m) {
      if (!m[2]) {
        const p = point(o, root);
        const x = p.extras;
        const kind = typeof x.activity === 'string' ? x.activity.toLowerCase() : 'idle';
        const outfits = typeof x.outfits === 'string' ? x.outfits.split(',').map((s) => s.trim()).filter(Boolean) : [];
        acts.set(m[1], {
          id: m[1], kind, group: typeof x.group === 'string' && x.group ? x.group : null, order: num(x.order, 0), outfits,
          frogs: Math.max(1, Math.min(6, Math.round(num(x.frogs, DEFAULT_FROGS[kind] ?? 1)))), anchor: p, pts: [], named: new Map(), extras: x,
        });
      } else subs.push([m[1], m[2], o]);
      return;
    }
    const f = /^CROWD_FX_\d+/.exec(o.name);
    if (f) {
      const p = point(o, root); const x = p.extras;
      fx.push({ kind: typeof x.fx === 'string' ? x.fx : 'fireflies', pos: p.pos, radius: num(x.radius, 2), height: num(x.height, 1), count: Math.max(1, Math.min(160, Math.round(num(x.count, 20)))) });
    }
  });
  for (const [id, sub, o] of subs) {
    const a = acts.get(id);
    if (!a) continue;
    const p = point(o, root);
    if (/^P\d+$/.test(sub)) a.pts.push(p); else a.named.set(sub.toUpperCase(), p);
  }
  for (const a of acts.values()) a.pts.sort((x, y) => x.name.localeCompare(y.name));
  if (!acts.size && !fx.length) return null;
  const list = [...acts.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { acts: list, fx };
}

export { tv as _tv };
