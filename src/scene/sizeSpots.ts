// Size-class spots (docs/SCENES.md → "Avatar size classes"): where micro performers (fairies, pets) and macro
// performers (giants) go in a room that was built for people.
//
//  * Authored: any SPOT_xx with extras `sizes: ["micro"]` / scene.json `spotSizes`, or scene.json `sizeSpots`
//    (extra spots in glTF space, indices 12…).
//  * Automatic (only for a class no authored spot takes; scene.json `autoSizeSpots: false` turns it off):
//      micro  a flat table / desk / counter top (0.5–1.25 m) beside a performer's spot — never in front of anyone's
//             face, visible from that spot's talk-camera side; else a HOVER perch beside a spot (they float at
//             seated-face height).
//      macro  behind the group (away from the camera side), on the floor, with the most head room: ceiling ray,
//             8 horizontal clearance rays, clear of COLLIDE_* boxes, and a clear line to the group (not behind a
//             wall). The clearance is stored on the spot: a giant is clamped to it, never through the ceiling.
//  Deterministic (pure function of the room), so the studio preview, OBS and every guest's OBS derive the same spots.
//  The search is a generator: the runtime runs it a few ms per frame (BVH ray tests, src/scene/twoShot.ts RoomRays).
import * as THREE from 'three';
import type { SceneInfo } from '../../shared/types.ts';
import { MAX_SPOTS, SIZE_SPOTS } from '../../shared/scene.ts';
import { parseSizes, type SizeClass } from '../../shared/avatarSize.ts';
import type { RoomInfo, SpotInfo } from './contract.ts';
import type { RoomRays } from './twoShot.ts';

const UP = new THREE.Vector3(0, 1, 0);
const flat = (v: THREE.Vector3) => new THREE.Vector3(v.x, 0, v.z);

function makeSpot(index: number, name: string, pos: THREE.Vector3, yaw: number, sizes: SizeClass[], label: string, o: { pose?: 'sit' | 'stand'; seatHeight?: number; hover?: number; src: 'auto' | 'json'; clearance?: { height: number; radius: number } }): SpotInfo {
  const node = new THREE.Object3D();
  node.name = name; node.position.copy(pos); node.rotation.y = yaw; node.updateMatrixWorld(true);
  const pose = o.pose === 'sit' ? 'sit' : 'stand';
  return {
    index, name, node, pose, seatHeight: pose === 'sit' ? THREE.MathUtils.clamp(o.seatHeight ?? 0.45, 0.15, 1.4) : 0, seatDepth: 0.5, label,
    position: pos.clone(), forward: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), yaw, cam: null, leavePathAt: null, approach: [],
    extras: { sizes, sizeSpot: o.src, ...(o.hover ? { hover: o.hover } : {}) }, sizes, sizeSpot: o.src,
    ...(o.hover ? { hover: o.hover } : {}), ...(o.clearance ? { clearance: o.clearance } : {}),
  };
}

/** scene.json `spotSizes` → SPOT_xx.sizes (overrides the GLB extras). */
export function applySpotSizes(room: RoomInfo, info: SceneInfo) {
  const o = info.spotSizes;
  if (!o || typeof o !== 'object') return;
  for (const s of room.spots) if (s && s.name in o) { const p = parseSizes(o[s.name]); if (p) s.sizes = p; }
}

/** scene.json `sizeSpots` (glTF space) → spots 12, 13 … */
export function jsonSizeSpots(room: RoomInfo, info: SceneInfo): SpotInfo[] {
  const out: SpotInfo[] = [];
  for (const j of Array.isArray(info.sizeSpots) ? info.sizeSpots : []) {
    if (out.length >= SIZE_SPOTS) break;
    const sizes = parseSizes(j?.sizes);
    if (!sizes || !Array.isArray(j.position) || j.position.length !== 3 || !j.position.every((v) => Number.isFinite(v))) continue;
    const pos = room.root.localToWorld(new THREE.Vector3(...j.position));
    const yaw = THREE.MathUtils.degToRad(Number(j.yaw) || 0);
    const i = MAX_SPOTS + out.length;
    out.push(makeSpot(i, `SIZE_SPOT_${i + 1}`, pos, yaw, sizes, typeof j.label === 'string' ? j.label.slice(0, 40) : `${sizes.join('/')} spot`,
      { pose: j.pose, seatHeight: j.seatHeight, hover: Number.isFinite(j.hover) ? THREE.MathUtils.clamp(Number(j.hover), 0, 3) : undefined, src: 'json' }));
  }
  return out;
}

/** Free height above a spot and free radius around it (m). */
export function measureClearance(s: SpotInfo, rays: RoomRays): { height: number; radius: number } {
  if (s.clearance) return s.clearance;
  const foot = s.position.clone().add(new THREE.Vector3(0, 0.3 + (s.pose === 'sit' ? s.seatHeight : 0), 0));
  const ceil = rays.ceilingAbove(foot, 40);
  const height = ceil === null ? 40 : ceil - s.position.y;
  const c = s.clearance = { height, radius: radiusAt(s.position, Math.min(1.0, height * 0.4), rays) };
  return c;
}

function radiusAt(p: THREE.Vector3, h: number, rays: RoomRays, max = 4): number {
  let r = max;
  const o = p.clone().add(new THREE.Vector3(0, h, 0));
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const d = rays.hit(o, o.clone().add(new THREE.Vector3(Math.sin(a) * max, 0, Math.cos(a) * max)), 0.01);
    if (d < r) r = d;
  }
  return r;
}

/** Room-level facts both searches share. */
function layout(room: RoomInfo) {
  const spots = room.spots.filter((s): s is SpotInfo => !!s);
  const c = spots.reduce((a, s) => a.add(flat(s.position)), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, spots.length));
  let f = spots.reduce((a, s) => a.add(s.forward), new THREE.Vector3()).setY(0);
  const wide = room.cameras.get('CAM_WIDE');
  if (f.lengthSq() < 0.04 * spots.length * spots.length) f = wide ? wide.position.clone().sub(c).setY(0) : new THREE.Vector3(0, 0, 1);
  if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
  f.normalize();
  const ys = spots.map((s) => s.position.y).sort((a, b) => a - b);
  const floorY = ys.length ? ys[Math.floor(ys.length / 2)] : 0;
  return { spots, center: c.setY(floorY), front: f, floorY };
}

/** Is `p` in the cone in front of any performer's face (it would block them)? */
function blocksSomeone(p: THREE.Vector3, spots: SpotInfo[]): boolean {
  for (const t of spots) {
    const d = flat(p).sub(flat(t.position));
    if (d.lengthSq() > 2.6 * 2.6) continue;
    const ahead = d.dot(t.forward);
    const lat = Math.abs(d.x * t.forward.z - d.z * t.forward.x);
    if (ahead > 0.12 && lat < 0.34 + ahead * 0.28) return true;
  }
  return false;
}

/** Does the segment a→b pass through where a performer sits / stands (a 0.48 m column — puppets and frogs are wide —
 *  up to their head)? */
function throughSomeone(a: THREE.Vector3, b: THREE.Vector3, spots: SpotInfo[], base: number, skip: SpotInfo | null = null): boolean {
  const p = new THREE.Vector3();
  for (let i = 1; i < 12; i++) {
    p.lerpVectors(a, b, i / 12);
    for (const t of spots) {
      if (t === skip) continue;
      const top = t.position.y + (t.pose === 'sit' ? t.seatHeight + base * 0.55 : base * 1.02);
      if (p.y < top && Math.hypot(p.x - t.position.x, p.z - t.position.z) < 0.48) return true;
    }
  }
  return false;
}

/** Roughly where a spot's talk camera sits (for line-of-sight tests). */
function talkEye(s: SpotInfo, base: number): THREE.Vector3 {
  const faceY = s.position.y + (s.pose === 'sit' ? s.seatHeight + base * 0.45 : base * 0.9);
  return s.position.clone().setY(faceY).addScaledVector(s.forward, 2.2);
}

export interface SizeSpotResult { spots: SpotInfo[]; notes: string[] }

/** Automatic micro / macro spots for the classes no authored spot takes (generator: yields between probes). */
export function* deriveSizeSpots(room: RoomInfo, rays: RoomRays, base: number, have: { micro: boolean; macro: boolean }, first: number): Generator<void, SizeSpotResult, void> {
  const out: SpotInfo[] = [], notes: string[] = [];
  const L = layout(room);
  if (!L.spots.length) return { spots: out, notes: ['no SPOT_xx in this room'] };
  let next = first;
  const free = () => next < MAX_SPOTS + SIZE_SPOTS;
  // camera points for the visibility tests, pulled inside the room when a wall is in the way (small rooms, cutaways)
  const mid = L.center.clone().setY(L.floorY + base * 0.8);
  const inside = (e: THREE.Vector3, from = mid) => { const d = rays.hit(from, e, 0.05); return d === Infinity ? e : from.clone().lerp(e, Math.max(0.2, (d - 0.3) / from.distanceTo(e))); };
  const groupEye = inside(L.center.clone().setY(L.floorY + base * 0.95).addScaledVector(L.front, 4));
  // the group / wide shots look from CAM_WIDE when the room has one
  const wideEye = inside(room.cameras.get('CAM_WIDE')?.position.clone() ?? groupEye);
  const talkEyes = new Map<SpotInfo, THREE.Vector3>();
  const talkOf = (s: SpotInfo) => { let e = talkEyes.get(s); if (!e) { const t = talkEye(s, base); e = inside(t, t.clone().addScaledVector(s.forward, -2.2)); talkEyes.set(s, e); } return e; };
  const seen = (head: THREE.Vector3, s: SpotInfo) => [talkOf(s), groupEye, wideEye].every((e, i) => rays.clear(head, e) && !throughSomeone(head, e, L.spots, base, i === 0 ? s : null));
  // ---------------------------------------------------------------- micro: table tops beside people, else hover perches
  if (!have.micro) {
    type Cand = { p: THREE.Vector3; anchor: SpotInfo; score: number };
    const cands: Cand[] = [];
    const anchors = L.spots.slice(0, 8);
    for (const s of anchors) {
      const right = new THREE.Vector3().crossVectors(UP, s.forward).normalize();
      for (const side of [1, -1]) for (const lat of [0.55, 0.75, 0.95, 1.15]) for (const fw of [0.2, 0.45, -0.05, 0.7]) {
        yield;                                                                  // (each probe is ≤ 12 ray tests)
        const p = s.position.clone().addScaledVector(right, side * lat).addScaledVector(s.forward, fw);
        const top = p.clone().setY(s.position.y + 1.6);
        const y = rays.floorBelow(top, 1.75);
        if (y === null) continue;
        const h = y - s.position.y;
        if (h < 0.5 || h > 1.25) continue;
        const surf = p.clone().setY(y);
        // flat enough for a tiny performer to stand (no armrests, sofa backs, lamp shades)
        let flatOk = true;
        for (const [dx, dz] of [[0.12, 0], [-0.12, 0], [0, 0.12], [0, -0.12]]) {
          const q = rays.floorBelow(top.clone().add(new THREE.Vector3(dx, 0, dz)), 1.75);
          if (q === null || Math.abs(q - y) > 0.03) { flatOk = false; break; }
        }
        if (!flatOk) continue;
        const above = rays.ceilingAbove(surf.clone().add(new THREE.Vector3(0, 0.03, 0)), 0.7);
        if (above !== null && above - y < 0.45) continue;
        if (L.spots.some((t) => flat(t.position).distanceTo(flat(p)) < 0.45)) continue;
        if (blocksSomeone(p, L.spots)) continue;
        // the fairy's head must be visible from the anchor's talk camera side and from the group camera side,
        // past the room AND past whoever sits nearby
        if (!seen(surf.clone().add(new THREE.Vector3(0, 0.22, 0)), s)) continue;
        const score = -Math.abs(h - 0.82) * 2 - Math.abs(lat - 0.75) * 0.8 - Math.abs(fw - 0.3) * 0.6 - s.index * 0.25;
        cands.push({ p: surf, anchor: s, score });
      }
      yield;
    }
    cands.sort((a, b) => b.score - a.score);
    const picked: Cand[] = [];
    for (const c of cands) {
      if (picked.length >= 3) break;
      if (picked.some((q) => q.p.distanceTo(c.p) < 0.7 || q.anchor === c.anchor)) continue;
      picked.push(c);
    }
    for (const c of picked) {
      if (!free()) break;
      out.push(makeSpot(next, `SIZE_MICRO_${out.length + 1}`, c.p, c.anchor.yaw, ['micro'], `Perch by ${c.anchor.label}`, { src: 'auto' }));
      next++;
    }
    if (!picked.length) {
      // nothing flat nearby: hover perches beside the first spots (fairies fly)
      let n = 0;
      for (const s of anchors) {
        if (n >= 2 || !free()) break;
        const right = new THREE.Vector3().crossVectors(UP, s.forward).normalize();
        const hv = base * (s.pose === 'sit' ? 0.5 : 0.6);
        for (const side of [1, -1]) {
          const p = s.position.clone().addScaledVector(right, side * 0.62).addScaledVector(s.forward, 0.08);
          const y = rays.floorBelow(p.clone().setY(s.position.y + 1.6), 1.75);
          if (y !== null && y - s.position.y > 0.3 && y - s.position.y < hv - 0.05) continue;   // furniture right there
          if (blocksSomeone(p, L.spots) || L.spots.some((t) => flat(t.position).distanceTo(flat(p)) < 0.45)) continue;
          if (!seen(p.clone().setY(s.position.y + hv + 0.2), s)) continue;
          out.push(makeSpot(next, `SIZE_MICRO_${out.length + 1}`, p.setY(s.position.y), s.yaw, ['micro'], `Hovering by ${s.label}`, { src: 'auto', hover: hv }));
          next++; n++;
          break;
        }
        yield;
      }
      notes.push(n ? 'micro: no free table top beside a spot — hover perches' : 'micro: no perch found (micro performers use ordinary spots, hovering)');
    }
  }
  // ---------------------------------------------------------------- macro: the back of the room, most head room
  if (!have.macro && free()) {
    const back = L.front.clone().negate();
    const minH = base * 1.45;
    type Cand = { p: THREE.Vector3; h: number; r: number; score: number };
    const cands: Cand[] = [];
    const inBounds = (p: THREE.Vector3) => room.bounds.isEmpty() || (p.x > room.bounds.min.x + 0.3 && p.x < room.bounds.max.x - 0.3 && p.z > room.bounds.min.z + 0.3 && p.z < room.bounds.max.z - 0.3);
    // (framing guarantee: a giant never stands between the React camera and the big screen — the screen stays whole in
    // the React shot. Sight lines from CAM_REACT, else from in front of the screen, to 9 points of the shown screen.)
    const sight: [THREE.Vector3, THREE.Vector3][] = [];
    if (room.screen) {
      const sb = new THREE.Box3().setFromObject(room.screen.surface);
      if (!sb.isEmpty()) {
        sb.translate(new THREE.Vector3(0, -room.screen.restOffsetY, 0));
        const sc = sb.getCenter(new THREE.Vector3()), ss = sb.getSize(new THREE.Vector3());
        const toRoom = flat(L.center).sub(flat(sc)).normalize();
        const from = room.cameras.get('CAM_REACT')?.position.clone() ?? sc.clone().addScaledVector(toRoom, Math.max(3, ss.x * 1.6)).setY(L.floorY + base);
        const side = new THREE.Vector3(-toRoom.z, 0, toRoom.x);
        const half = Math.max(ss.x, ss.z) / 2;
        for (const u of [-0.9, 0, 0.9]) for (const v of [-0.9, 0, 0.9]) sight.push([from, sc.clone().addScaledVector(side, u * half).add(new THREE.Vector3(0, (v * ss.y) / 2, 0))]);
      }
    }
    const blocksScreen = (p: THREE.Vector3, top: number) => sight.some(([a, b]) => {
      for (let k = 1; k < 24; k++) { const q = a.clone().lerp(b, k / 24); if (q.y < top && Math.hypot(q.x - p.x, q.z - p.z) < 0.75) return true; }
      return false;
    });
    // a 0.5 m grid over the lived-in part of the room (spots + 4 m): behind / beside the group, never in front of anyone
    const area = new THREE.Box3().setFromPoints(L.spots.map((s) => flat(s.position))).expandByScalar(4);
    for (let x = area.min.x; x <= area.max.x + 1e-6; x += 0.5) {
      for (let z = area.min.z; z <= area.max.z + 1e-6; z += 0.5) {
        yield;
        const p = new THREE.Vector3(x, L.floorY, z);
        if (!inBounds(p)) continue;
        const rel = flat(p).sub(flat(L.center));
        if (rel.dot(L.front) > 0.3) continue;                                   // the camera side of the group
        if (L.spots.some((t) => flat(t.position).distanceTo(flat(p)) < 1.0)) continue;
        if (L.spots.some((t) => { const d = flat(p).sub(flat(t.position)); const ahead = d.dot(t.forward); return ahead > 0.2 && Math.abs(d.x * t.forward.z - d.z * t.forward.x) < 0.8 + ahead * 0.35; })) continue;
        const dd = rel.dot(back);
        const fy = rays.floorBelow(p.clone().setY(L.floorY + 1.2), 2.5);
        if (fy === null || Math.abs(fy - L.floorY) > 0.25) continue;          // off the floor / on furniture
        p.y = fy;
        if (rays.insideCollider(p.clone().setY(fy + 0.5), 0.3) || rays.insideCollider(p.clone().setY(fy + 1.4), 0.3)) continue;
        const ceil = rays.ceilingAbove(p.clone().setY(fy + 0.5), 40);
        const h = (ceil === null ? 40 : ceil - fy) - 0.12;
        if (h < minH) continue;
        const r = radiusAt(p, Math.min(1.0, h * 0.4), rays);
        if (r < 0.55) continue;
        // visible from the group (not behind a wall / pillar)
        const eye = p.clone().setY(fy + Math.min(h * 0.75, base * 2.2));
        if (!rays.clear(eye, L.center.clone().setY(L.floorY + base * 0.8).addScaledVector(L.front, 1.5))) continue;
        // (framing guarantee: the face of ANY giant this spot may hold — up to the clearance clamp — must be in plain view
        // from the camera side and not inside foliage / a lamp / a beam: faces at a few heights, seen from the front at
        // eye and crane height, with room around the head)
        const faceYs = [base * 1.35, Math.min(h - 0.12, base * 2.4) * 0.92, Math.min(h - 0.12, base * 3.6) * 0.9].map((y) => fy + y).filter((y, i, a) => a.indexOf(y) === i);
        const fronts = [L.center.clone().setY(L.floorY + base * 0.9).addScaledVector(L.front, 3), L.center.clone().setY(L.floorY + base * 1.8).addScaledVector(L.front, 4)];
        if (!faceYs.every((y) => fronts.some((f) => rays.clear(p.clone().setY(y), f)) && radiusAt(p, y - fy, rays, 1.5) >= 0.45)) continue;
        if (blocksScreen(p, fy + Math.min(h - 0.12, base * 3.6))) continue;
        // someone sitting between the giant and the camera side hides them in their talk shot: prefer a clear front
        const hidden = L.spots.some((t) => { const d = flat(t.position).sub(flat(p)); const ahead = d.dot(L.front); return ahead > 0.3 && ahead < 3.5 && Math.abs(d.x * L.front.z - d.z * L.front.x) < 0.5 + ahead * 0.3; });
        cands.push({ p, h, r, score: dd * 0.6 + Math.min(h, 6) * 0.4 + Math.min(r, 2.5) * 0.5 - rel.length() * 0.15 - (hidden ? 2 : 0) });
      }
      yield;
    }
    cands.sort((a, b) => b.score - a.score);
    const picked: Cand[] = [];
    for (const c of cands) { if (picked.length >= 2) break; if (!picked.some((q) => q.p.distanceTo(c.p) < 2.2)) picked.push(c); }
    for (const c of picked) {
      if (!free()) break;
      const yaw = Math.atan2(L.front.x, L.front.z);
      out.push(makeSpot(next, `SIZE_MACRO_${out.length + 1}`, c.p, yaw, ['macro'], picked.length > 1 ? `Back row (giant) ${picked.indexOf(c) + 1}` : 'Back row (giant)', { src: 'auto', clearance: { height: c.h, radius: c.r } }));
      next++;
    }
    if (!picked.length) notes.push(`macro: no floor space behind the group with ≥ ${minH.toFixed(1)} m head room (giants use ordinary spots, clamped to the ceiling)`);
  }
  return { spots: out, notes };
}
