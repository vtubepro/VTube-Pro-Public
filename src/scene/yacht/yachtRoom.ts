// Yacht life — the room's anchors (docs/SCENES.md → "Yacht life"). Plain names (areas were already renamed by the
// SceneRuntime): YACHT_SERVICE, YACHT_BAR, YACHT_POUR, YACHT_DRINK_xx, YACHT_ROUTE_<A..Z>_nn, YACHT_SKY_nn (extras
// `size`), CAM_EXTERIOR / CAM_EXTERIOR_02…, and scene.json `yacht.planet` / `yacht.far` (glTF space). Everything is read
// once on attach into world space (the SceneRuntime root is the world). All anchors are optional.
import * as THREE from 'three';
import type { RoomYachtConfig } from '../../../shared/yacht.ts';

export interface YPoint { pos: THREE.Vector3; fwd: THREE.Vector3 }
export interface YachtRoom {
  service: YPoint | null;
  bar: YPoint | null;
  pour: THREE.Vector3 | null;
  /** YACHT_DRINK_xx → spot index (SPOT_01 = 0) */
  drinks: Map<number, THREE.Vector3>;
  /** route letter → ordered floor points */
  routes: Map<string, THREE.Vector3[]>;
  sky: { name: string; pos: THREE.Vector3; size: number }[];
  exteriors: string[];
  planet: { center: THREE.Vector3; radius: number; storms: THREE.Vector3[] } | null;
  far: THREE.Vector3[];
  /** fake anchors added for a test config (removed on detach) */
  debugNodes: THREE.Object3D[];
}

const fwdOf = (o: THREE.Object3D, out = new THREE.Vector3()) => {
  const q = o.getWorldQuaternion(new THREE.Quaternion());
  out.set(0, 0, 1).applyQuaternion(q); out.y = 0;
  if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
  return out.normalize();
};

export function yachtRoomOf(root: THREE.Object3D, cams: Map<string, unknown>, cfg: RoomYachtConfig): YachtRoom {
  root.updateMatrixWorld(true);
  const debugNodes: THREE.Object3D[] = [];
  for (const [name, a] of Object.entries(cfg.debugAnchors ?? {})) {
    if (!/^YACHT_[A-Z0-9_]{1,40}$/.test(name) || root.getObjectByName(name) || !Array.isArray(a?.position)) continue;
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(a.position[0], a.position[1], a.position[2]);
    o.rotation.y = THREE.MathUtils.degToRad(a.facing ?? 0);
    if (a.size) o.userData.size = a.size;
    root.add(o); debugNodes.push(o);
  }
  root.updateMatrixWorld(true);
  const R: YachtRoom = { service: null, bar: null, pour: null, drinks: new Map(), routes: new Map(), sky: [], exteriors: [], planet: null, far: [], debugNodes };
  const routePts = new Map<string, [number, THREE.Vector3][]>();
  root.traverse((o) => {
    const n = o.name;
    if (!n.startsWith('YACHT_')) return;
    const p = o.getWorldPosition(new THREE.Vector3());
    if (n === 'YACHT_SERVICE') R.service = { pos: p, fwd: fwdOf(o) };
    else if (n === 'YACHT_BAR') R.bar = { pos: p, fwd: fwdOf(o) };
    else if (n === 'YACHT_POUR') R.pour = p;
    else {
      let m = /^YACHT_DRINK_(\d{1,2})$/.exec(n);
      if (m) { R.drinks.set(parseInt(m[1], 10) - 1, p); return; }
      m = /^YACHT_ROUTE_([A-Z])_(\d{1,2})$/.exec(n);
      if (m) { const l = routePts.get(m[1]) ?? []; l.push([parseInt(m[2], 10), p]); routePts.set(m[1], l); return; }
      m = /^YACHT_SKY_(\d{1,2})$/.exec(n);
      if (m) R.sky.push({ name: n, pos: p, size: Math.min(400, Math.max(10, Number((o.userData as Record<string, unknown>).size) || 60)) });
    }
  });
  for (const [k, l] of [...routePts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    l.sort((a, b) => a[0] - b[0]);
    if (l.length >= 2) R.routes.set(k, l.map((x) => x[1]));
  }
  R.sky.sort((a, b) => (a.name < b.name ? -1 : 1));
  R.exteriors = [...cams.keys()].filter((k) => /^CAM_EXTERIOR(_\d{2})?$/.test(k)).sort();
  const w = (v: [number, number, number]) => root.localToWorld(new THREE.Vector3(v[0], v[1], v[2]));
  const pl = cfg.planet;
  if (pl && Array.isArray(pl.center) && pl.radius > 0) {
    const s = root.getWorldScale(new THREE.Vector3()).x || 1;
    R.planet = { center: w(pl.center), radius: pl.radius * s, storms: Array.isArray(pl.storms) ? pl.storms.filter((x) => Array.isArray(x)).slice(0, 12).map(w) : [] };
    // no storms listed (or storms: "auto"): up to 10 where the room's cameras see the planet (rays from CAM_WIDE / the
    // other presets through a grid across the frame, hit on the sphere) — deterministic, always on the visible side
    if (!R.planet.storms.length) {
      const P = R.planet;
      const ray = new THREE.Ray(), hit = new THREE.Vector3(), sph = new THREE.Sphere(P.center, P.radius * 0.999);
      const list = [...cams.entries()].sort((a, b) => (a[0] === 'CAM_WIDE' ? -1 : b[0] === 'CAM_WIDE' ? 1 : a[0] < b[0] ? -1 : 1));
      for (const [, c] of list) {
        const cp = c as { position?: THREE.Vector3; quaternion?: THREE.Quaternion; fov?: number };
        if (!cp.position || !cp.quaternion) continue;
        const tv = Math.tan(THREE.MathUtils.degToRad(cp.fov ?? 40) / 2), th = tv * 16 / 9;
        for (let k = 0; k < 24 && P.storms.length < 10; k++) {
          const x = ((k * 0.618034) % 1) * 1.6 - 0.8, y = ((k * 0.414214) % 1) * 0.7 - 0.15;             // (the upper part of the frame: the windows)
          const d = new THREE.Vector3(x * th, y * tv, -1).normalize().applyQuaternion(cp.quaternion);
          ray.set(cp.position, d);
          if (!ray.intersectSphere(sph, hit)) continue;
          if (P.storms.every((q) => q.distanceTo(hit) > P.radius * 0.06)) P.storms.push(hit.clone());
        }
        if (P.storms.length >= 6) break;
      }
    }
  }
  R.far = (cfg.far ?? []).filter((x) => Array.isArray(x)).slice(0, 8).map(w);
  return R;
}
