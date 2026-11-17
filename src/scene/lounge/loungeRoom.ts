// Lounge events — the room's anchors (docs/SCENES.md → "Lounge events", T\lounge\CONTRACT.md). Plain names (areas were
// already renamed by the SceneRuntime), each with an alias so either naming works:
//   bar   : EVT_COUNTER_START / _END (LOUNGE_SLIDE_01 / _02) the drink-slide line · EVT_SHOT_xx (LOUNGE_SHOT_xx) shot
//           glasses · EVT_POUR (LOUNGE_BAR) · BARTENDER (LOUNGE_BARTENDER) · EVT_BOTTLEWALL (LOUNGE_BOTTLES, extras size
//           [w, h] | w, h) + any EMIT_bottle* material
//   patio : EVT_FIREPIT (LOUNGE_FIREPIT, extras radius | r) · EVT_SKY / EVT_SKY_xx (LOUNGE_SKY_xx, extras size) ·
//           EVT_SPARKLER_xx (LOUNGE_SPARK_xx)
//   main  : EVT_CONFETTI_xx (LOUNGE_CONFETTI_xx, any area) · EVT_BALLOON_NET (LOUNGE_BALLOONS, extras size [w, h, d] |
//           rx, rz) · EVT_CHAMPAGNE (LOUNGE_CHAMPAGNE) · EVT_TV (LOUNGE_TV) · EVT_KEEPOUT_xx (LOUNGE_KEEPOUT_xx, extras r)
// Sources, first wins: GLB nodes of the loaded area → scene.json `lounge.anchors` of the area → (room-wide extras only)
// the OTHER areas' scene.json `areas.<key>.lounge.anchors` (the lounge is one building in one glTF space). Everything is
// read once on attach into world space (the SceneRuntime root is the world).
import * as THREE from 'three';
import type { LoungeAnchorSpec, LoungeZone, RoomLoungeConfig } from '../../../shared/lounge.ts';
import { loungeZoneOf } from '../../../shared/lounge.ts';

export interface LPoint { pos: THREE.Vector3; fwd: THREE.Vector3 }
export interface LoungeZoneAnchors {
  slide: [THREE.Vector3, THREE.Vector3] | null;
  shots: THREE.Vector3[];
  pour: THREE.Vector3 | null;
  bartender: LPoint | null;
  bottles: { pos: THREE.Vector3; fwd: THREE.Vector3; w: number; h: number } | null;
  firepit: { pos: THREE.Vector3; r: number } | null;
  sky: { pos: THREE.Vector3; size: number }[];
  sparks: THREE.Vector3[];
  confetti: LPoint[];
  balloons: { pos: THREE.Vector3; rx: number; rz: number } | null;
  champagne: THREE.Vector3 | null;
  tv: THREE.Vector3 | null;
  keepouts: { pos: THREE.Vector3; r: number }[];
  /** floor height (m, world) near the area's seats */
  floor: number;
}
export interface LoungeRoom {
  zone: LoungeZone;
  /** the loaded area's own anchors (+ derived fallbacks for its own zone) */
  own: LoungeZoneAnchors;
  /** the other zones' anchors from scene.json (room-wide extras; drawn only where the camera sees them) */
  other: Partial<Record<LoungeZone, LoungeZoneAnchors>>;
  /** EMIT_bottle* materials (any area: the building is shared) */
  bottleMats: THREE.MeshStandardMaterial[];
  notes: string[];
}

const ALIAS: [RegExp, string][] = [
  [/^(EVT_COUNTER_START|LOUNGE_SLIDE_01)$/, 'slideA'], [/^(EVT_COUNTER_END|LOUNGE_SLIDE_02)$/, 'slideB'],
  [/^(EVT|LOUNGE)_SHOT_\d{1,2}$/, 'shot'], [/^(EVT_POUR|LOUNGE_BAR)$/, 'pour'], [/^(LOUNGE_)?BARTENDER$/, 'bartender'],
  [/^(EVT_BOTTLEWALL|LOUNGE_BOTTLES)$/, 'bottles'], [/^(EVT|LOUNGE)_FIREPIT$/, 'firepit'], [/^(EVT_SKY|(EVT|LOUNGE)_SKY_\d{1,2})$/, 'sky'],
  [/^(EVT_SPARKLER|LOUNGE_SPARK)_\d{1,2}$/, 'spark'], [/^(EVT|LOUNGE)_CONFETTI_\d{1,2}$/, 'confetti'], [/^(EVT_BALLOON_NET|LOUNGE_BALLOONS)$/, 'balloons'],
  [/^(EVT|LOUNGE)_CHAMPAGNE$/, 'champagne'], [/^(EVT|LOUNGE)_TV$/, 'tv'], [/^(EVT|LOUNGE)_KEEPOUT_\d{1,2}$/, 'keepout'],
];
const roleOf = (n: string) => ALIAS.find(([re]) => re.test(n))?.[1] ?? null;
const empty = (): LoungeZoneAnchors => ({ slide: null, shots: [], pour: null, bartender: null, bottles: null, firepit: null, sky: [], sparks: [], confetti: [], balloons: null, champagne: null, tv: null, keepouts: [], floor: 0 });

interface Raw { name: string; pos: THREE.Vector3; fwd: THREE.Vector3; x: Record<string, unknown> }
const numOf = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const sizeOf = (x: Record<string, unknown>, i: number) => (Array.isArray(x.size) ? numOf(x.size[i], NaN) : i === 0 ? numOf(x.size, NaN) : NaN);

/** (`seen`: names already filled — a GLB node and its scene.json mirror count once, the GLB first) */
function fill(A: LoungeZoneAnchors, raws: Raw[], seen = new Set<string>()) {
  const sorted = [...raws].sort((a, b) => a.name.localeCompare(b.name));
  let sA: THREE.Vector3 | null = null, sB: THREE.Vector3 | null = null;
  for (const r of sorted) {
    const role = roleOf(r.name);
    if (!role || seen.has(r.name)) continue;
    seen.add(r.name);
    const x = r.x;
    switch (role) {
      case 'slideA': sA ??= r.pos; break;
      case 'slideB': sB ??= r.pos; break;
      case 'shot': A.shots.push(r.pos); break;
      case 'pour': A.pour ??= r.pos; break;
      case 'bartender': A.bartender ??= { pos: r.pos, fwd: r.fwd }; break;
      case 'bottles': A.bottles ??= { pos: r.pos, fwd: r.fwd, w: Math.max(0.5, numOf(x.w, sizeOf(x, 0)) || 4), h: Math.max(0.3, numOf(x.h, sizeOf(x, 1)) || 2) }; break;
      case 'firepit': A.firepit ??= { pos: r.pos, r: Math.min(2, Math.max(0.15, numOf(x.radius, numOf(x.r, 0.5)))) }; break;
      case 'sky': A.sky.push({ pos: r.pos, size: Math.min(400, Math.max(8, numOf(x.size, 60))) }); break;
      case 'spark': A.sparks.push(r.pos); break;
      case 'confetti': A.confetti.push({ pos: r.pos, fwd: r.fwd }); break;
      case 'balloons': {
        const w = sizeOf(x, 0), d = sizeOf(x, 2);
        A.balloons ??= { pos: r.pos, rx: Math.max(0.4, numOf(x.rx, Number.isFinite(w) ? w / 2 : 2.5)), rz: Math.max(0.4, numOf(x.rz, Number.isFinite(d) ? d / 2 : 1.6)) };
        break;
      }
      case 'champagne': A.champagne ??= r.pos; break;
      case 'tv': A.tv ??= r.pos; break;
      case 'keepout': A.keepouts.push({ pos: r.pos, r: Math.min(10, Math.max(0.2, numOf(x.r, numOf(x.radius, 1)))) }); break;
    }
  }
  if (sA && sB && !A.slide) A.slide = [sA, sB];
}

/** scene.json anchors (glTF space) → raws in world space */
function jsonRaws(anchors: RoomLoungeConfig['anchors'], root: THREE.Object3D): Raw[] {
  const out: Raw[] = [];
  for (const [name, a] of Object.entries(anchors ?? {})) {
    const spec: LoungeAnchorSpec | null = Array.isArray(a) ? { p: a as [number, number, number] } : a && typeof a === 'object' && Array.isArray((a as LoungeAnchorSpec).p) ? a as LoungeAnchorSpec : null;
    if (!spec || spec.p.length !== 3 || !spec.p.every((v) => Number.isFinite(v))) continue;
    const pos = root.localToWorld(new THREE.Vector3(spec.p[0], spec.p[1], spec.p[2]));
    const yaw = THREE.MathUtils.degToRad(numOf(spec.yaw, 0));
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).transformDirection(root.matrixWorld).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    out.push({ name, pos, fwd: fwd.normalize(), x: spec as unknown as Record<string, unknown> });
  }
  return out;
}

const fwdOf = (o: THREE.Object3D, out = new THREE.Vector3()) => {
  out.set(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
  if (Math.abs(out.y) > 0.98) return out.normalize();
  out.y = 0; return out.lengthSq() < 1e-6 ? out.set(0, 0, 1) : out.normalize();
};

export interface LoungeRoomInput {
  root: THREE.Object3D;
  cfg: RoomLoungeConfig;
  area?: string; label?: string;
  /** other areas' scene.json entries (info.areas) */
  areas?: Record<string, { label?: string; lounge?: RoomLoungeConfig }>;
  spots: { position: THREE.Vector3; forward: THREE.Vector3 }[];
  bounds: THREE.Box3;
  cameras: Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number }>;
  defaultCamera?: string;
}

export function loungeRoomOf(I: LoungeRoomInput): LoungeRoom {
  const root = I.root;
  root.updateMatrixWorld(true);
  const zone = loungeZoneOf(I.cfg, I.area, I.label);
  const notes: string[] = [];
  const raws: Raw[] = [];
  const bottleMats: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    if (roleOf(o.name)) raws.push({ name: o.name, pos: o.getWorldPosition(new THREE.Vector3()), fwd: fwdOf(o), x: (o.userData ?? {}) as Record<string, unknown> });
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
    if ((o as THREE.Mesh).isMesh && m) for (const mm of Array.isArray(m) ? m : [m]) if (mm && 'emissive' in mm && /^EMIT_bottle/i.test(mm.name) && !bottleMats.includes(mm)) bottleMats.push(mm);
  });
  const own = empty();
  const seen = new Set<string>();
  fill(own, raws, seen);
  fill(own, jsonRaws(I.cfg.anchors, root), seen);
  // the floor: the seats' lowest root (spots stand / sit on the floor)
  const ys = I.spots.map((s) => s.position.y);
  own.floor = ys.length ? Math.min(...ys) : I.bounds.min.y;
  // fallbacks for the area's own zone (never another zone's piece in the wrong place)
  const centre = I.spots.length ? I.spots.reduce((a, s) => a.add(s.position), new THREE.Vector3()).divideScalar(I.spots.length) : I.bounds.getCenter(new THREE.Vector3());
  const top = Number.isFinite(I.bounds.max.y) ? Math.min(I.bounds.max.y, own.floor + 4.2) : own.floor + 3.4;
  const cam = I.cameras.get(I.defaultCamera ?? 'CAM_WIDE') ?? [...I.cameras.values()][0];
  if (zone === 'main') {
    if (!own.balloons) { own.balloons = { pos: centre.clone().setY(top - 0.35), rx: 2.6, rz: 1.8 }; notes.push('balloons: derived above the seats'); }
    if (!own.confetti.length && cam) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
      for (const s of [-1, 1]) own.confetti.push({ pos: centre.clone().addScaledVector(right, s * 2.6).setY(top - 0.3), fwd: right.clone().multiplyScalar(-s) });
      notes.push('confetti: derived (2 points)');
    }
  }
  if (zone === 'patio' && !own.sky.length && cam) {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).setY(0).normalize();
    own.sky.push({ pos: cam.position.clone().addScaledVector(f, 110).setY(cam.position.y + 38), size: 70 });
    notes.push('sky: derived ahead of CAM_WIDE');
  }
  if (zone === 'bar' && !own.slide && own.pour) {
    // a counter line through the pour point, across the camera
    const r = cam ? new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize() : new THREE.Vector3(1, 0, 0);
    own.slide = [own.pour.clone().addScaledVector(r, -2.6), own.pour.clone().addScaledVector(r, 2.6)];
    notes.push('slide: derived through the pour point');
  }
  // the other areas (scene.json only — their GLB nodes were removed with their prefixes)
  const other: LoungeRoom['other'] = {};
  for (const [k, a] of Object.entries(I.areas ?? {})) {
    if (!a || k === I.area || !a.lounge?.anchors) continue;
    const z = loungeZoneOf(a.lounge, k, a.label);
    if (z === zone) continue;
    const A = other[z] ?? empty();
    fill(A, jsonRaws(a.lounge.anchors, root));
    A.floor = own.floor;
    other[z] = A;
  }
  return { zone, own, other, bottleMats, notes };
}
