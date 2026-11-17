// Automatic interview set layout for ANY room (a room's scene.json `interview` / the built-in table only pins what it
// wants): from the host's chair it finds
//   · the desk: in front of the host's knees, if that floor is free (no coffee table / wall there) — else no desk;
//   · the guest monitor: beside the host (the side with more room first), turned ~35–45° towards the host so the host
//     can talk to it and a front camera still reads it; its whole box must be free of room geometry and COLLIDE_* boxes,
//     on the floor, away from every seat, the host must see all four corners, and a front camera must see the picture
//     and the host's face together;
//   · the sidekick's place: the other side, a free floor circle away from the seats, visible from the front.
// Deterministic (a pure function of the room + host), a few thousand BVH rays at most, run once when the mode starts
// (under the transition curtain).
import * as THREE from 'three';
import type { RoomInfo, SpotInfo } from '../contract.ts';
import { RoomProbe } from '../shotSolver.ts';
import type { RoomRays } from '../twoShot.ts';

const UP = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;

/** A co-host's seat: a room chair (`spot`) or a generated place at the desk (`spot` null: the engine makes a spot there,
 *  with a generated chair when the host sits). */
export interface CoSeat { position: THREE.Vector3; yaw: number; spot: SpotInfo | null; how: 'desk' | 'room' | 'pinned' }

export interface SetLayout {
  /** `seats`: where the people behind it sit, as offsets along the desk (m, desk-local x; the host + co-hosts). */
  desk: { position: THREE.Vector3; yaw: number; width: number; seats?: number[] } | null;
  monitor: { center: THREE.Vector3; yaw: number; width: number; score: number } | null;
  sidekick: { position: THREE.Vector3; yaw: number } | null;
  /** Co-hosts' seats, co-host 1 first (fewer than asked when the room has no place for them). */
  cohosts: CoSeat[];
  notes: string[];
}

export interface LayoutInput {
  room: RoomInfo;
  rays: RoomRays;
  host: SpotInfo;
  face: THREE.Vector3;
  /** Picture width + aspect of the monitor style, and its housing extra size (cabinet around the picture). */
  width: number; aspect: number; cabinet: { w: number; h: number; d: number; floor: boolean };
  wantDesk: boolean;
  /** Side preference: +1 = the host's right, -1 = left, 0 = the side with more room / towards the room centre. */
  side?: number;
  roomCenter: THREE.Vector3;
  /** Head points of the guest chairs: the monitor must not stand in the front camera's view of them. */
  guestSeats?: THREE.Vector3[];
  /** The room's wide camera (CAM_WIDE), if any: another view the guest chairs must stay visible from. */
  wide?: THREE.Vector3 | null;
  /** Skip the monitor / sidekick search (authored in the room's config). */
  haveMonitor?: boolean; haveSidekick?: boolean;
  /** Co-hosts to seat beside the host (0…2), the room's person height (spacing), chairs pinned in the room's config,
   *  and the guest chairs (never given to a co-host). */
  cohosts?: number; personH?: number; pinnedCohosts?: SpotInfo[]; guestChairs?: SpotInfo[];
}

/** Is an oriented box (centre, yaw, half sizes) free of room geometry (double-sided rays along its edges + diagonals)
 *  and of COLLIDE_* boxes? */
export function boxFree(probe: RoomProbe, rays: RoomRays, c: THREE.Vector3, yaw: number, hx: number, hy: number, hz: number): boolean {
  const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x * hx, y * hy, z * hz).applyQuaternion(q).add(c);
  const corners = [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]].map(([x, y, z]) => P(x, y, z));
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7], [0, 6], [1, 7], [2, 4], [3, 5]];
  for (const [a, b] of edges) {
    const A = corners[a], B = corners[b], d = B.clone().sub(A), L = d.length();
    // (bottom edges ride 3 cm above the floor)
    const lift = a < 4 && b < 4 ? new THREE.Vector3(0, 0.03, 0) : new THREE.Vector3();
    if (probe.first(A.clone().add(lift), d.divideScalar(L), L)) return false;
  }
  const bb = new THREE.Box3().setFromPoints(corners);
  if (rays.colliders.some((k) => k.intersectsBox(bb))) return false;
  return true;
}

/** Does segment a → b pass within r of point p (not counting the last 0.2 m before b)? */
function segNear(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3, r: number): boolean {
  const d = b.clone().sub(a), L = d.length();
  if (L < 1e-4) return false;
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(d) / (L * L), 0, 1);
  if (t * L > L - 0.2 || t <= 0) return false;
  return a.clone().addScaledVector(d, t).distanceTo(p) < r;
}

export function planSet(inp: LayoutInput): SetLayout {
  const { room, rays, host } = inp;
  const probe = new RoomProbe(room);
  const notes: string[] = [];
  const F = host.forward.clone().setY(0).normalize();
  const R = new THREE.Vector3().crossVectors(F, UP).normalize();          // the host's right (seen from behind)
  const floorY = host.position.y;
  const seats = [...room.spots, ...room.sizeSpots].filter((s): s is SpotInfo => !!s && s !== host);
  // (generated co-host seats count as seats too: the monitor / sidekick keep clear of them)
  const extraSeats: THREE.Vector3[] = [];
  const nearSeat = (p: THREE.Vector3, r: number) => seats.some((s) => Math.hypot(s.position.x - p.x, s.position.z - p.z) < r) || extraSeats.some((s) => Math.hypot(s.x - p.x, s.z - p.z) < r);
  const H = inp.face;
  // a rough "front camera" (where the establishing shot will be): out along the host's facing, turned to the room
  const front = (toward: THREE.Vector3) => H.clone().addScaledVector(F.clone().add(toward.clone().sub(H).setY(0).normalize().multiplyScalar(0.6)).normalize(), 3.6).addScaledVector(UP, 0.35);
  const yawF = Math.atan2(F.x, F.z);

  // ---- co-hosts: beside the host at the desk (a room chair right there, else a generated seat on free floor), the
  // side away from where the monitor will want to be first; else the nearest room chairs facing the same way
  const cohosts: CoSeat[] = [];
  let desk0: SetLayout['desk'] = null;
  const want = Math.max(0, Math.min(2, inp.cohosts ?? 0));
  const headY = H.y - host.position.y;                                   // the host's face height above their spot
  if (want) {
    const guestChairs = new Set(inp.guestChairs ?? []);
    const pinned = (inp.pinnedCohosts ?? []).filter((s) => s !== host && !guestChairs.has(s)).slice(0, want);
    for (const s of pinned) cohosts.push({ position: s.position.clone(), yaw: s.yaw, spot: s, how: 'pinned' });
    const need = want - cohosts.length;
    if (need > 0) {
      // (the spacing of people at a desk, scaled by the room's person size; a wide armchair pushes the first seat out)
      const gap = THREE.MathUtils.clamp(0.88 * (inp.personH ?? 1.5) / 1.5, 0.8, 1.25);
      const monSide = inp.side ? Math.sign(inp.side) : (inp.roomCenter.clone().sub(host.position).setY(0).dot(R) >= 0 ? 1 : -1);
      const away = -monSide;
      const used = new Set<SpotInfo>(cohosts.map((c) => c.spot).filter((s): s is SpotInfo => !!s));
      // a room chair at (about) this place, facing the way the host faces, not a guest chair / taken
      const roomChair = (p: THREE.Vector3, taken: SpotInfo[]) => seats.find((s) => s.index < 12 && !guestChairs.has(s) && !used.has(s) && !taken.includes(s) && Math.hypot(s.position.x - p.x, s.position.z - p.z) < 0.45 && s.forward.dot(F) > 0.8 && s.pose === host.pose) ?? null;
      const seatOk = (p: THREE.Vector3) => {
        if (nearSeat(p, 0.55)) return false;
        const fl = rays.floorBelow(p.clone().setY(floorY + 0.5), 1.5);
        if (fl === null || Math.abs(fl - floorY) > 0.12) return false;
        // a seated person + a chair (or a standing person): free of the room
        return boxFree(probe, rays, p.clone().setY(floorY + 0.62), yawF, 0.3, 0.58, 0.34);
      };
      // the nearest free place on side s from `from` m out (10 cm steps, ≤ 75 cm further): a room chair there, else a seat
      const scan = (s: number, from: number, taken: SpotInfo[]): { d: number; spot: SpotInfo | null; sc: number } | null => {
        for (let d = from; d <= from + 0.75 + 1e-6; d += 0.1) {
          const p = host.position.clone().addScaledVector(R, s * d).setY(floorY);
          const rc = roomChair(p, taken);
          if (rc) return { d: Math.abs(rc.position.clone().sub(host.position).dot(R)), spot: rc, sc: (d - from) };
          if (!seatOk(p)) continue;
          const head = p.clone().setY(floorY + headY);
          return { d, spot: null, sc: (d - from) * 1.5 + (rays.clear(front(head), head) ? 0 : 2) };
        }
        return null;
      };
      // sides of co-host 1, 2: both away from the monitor's side first (the host sits nearest the monitor / guests),
      // then one each side, then both on the monitor's side
      // (two co-hosts and room for only one beside the host: co-host 1 at the desk, co-host 2 in a room chair)
      const plans: number[][] = need === 1 ? [[away], [-away]] : [[away, away], [away, -away], [-away, -away], [away], [-away]];
      let pick: { offs: number[]; spots: (SpotInfo | null)[]; desk: SetLayout['desk'] | null; sc: number } | null = null;
      for (const [ai, sides] of plans.entries()) {
        const spots: (SpotInfo | null)[] = [], offs: number[] = [];
        let ok = true, sc = ai * 0.5 + (sides.length < need ? 8 : 0);
        for (const s of sides) {
          const prev = offs.filter((o) => Math.sign(o) === s).map(Math.abs);
          const r = scan(s, prev.length ? Math.max(...prev) + gap : gap, spots.filter((x): x is SpotInfo => !!x));
          if (!r) { ok = false; break; }
          offs.push(s * r.d); spots.push(r.spot); sc += r.sc;
        }
        if (!ok) continue;
        // the desk grows to seat everyone (the host + co-hosts behind it), centred on them
        let dk: SetLayout['desk'] | null = null;
        if (inp.wantDesk) {
          const xs = [0, ...offs], x0 = Math.min(...xs), x1 = Math.max(...xs);
          for (const d of [0.66, 0.72, 0.6, 0.8]) {
            const w = Math.min(4.2, x1 - x0 + 1.35), mid = (x0 + x1) / 2;
            const c = host.position.clone().addScaledVector(F, d).addScaledVector(R, mid);
            if (nearSeat(c, 0.55)) continue;
            if (!boxFree(probe, rays, c.clone().setY(floorY + 0.4), yawF, w / 2, 0.36, 0.3)) continue;
            // (desk-local x runs along -R: the desk's +Z faces the audience, so its +X is the host's left)
            dk = { position: c.setY(floorY), yaw: yawF, width: w, seats: xs.map((x) => -(x - mid)) };
            break;
          }
          if (!dk) sc += 3;
        }
        if (!pick || sc < pick.sc) pick = { offs, spots, desk: dk, sc };
        if (sc < 0.1) break;
      }
      if (pick) {
        pick.offs.forEach((o, k) => {
          const s = pick!.spots[k];
          const p = s ? s.position.clone() : host.position.clone().addScaledVector(R, o).setY(floorY);
          cohosts.push({ position: p, yaw: s ? s.yaw : yawF, spot: s, how: s ? 'room' : 'desk' });
          if (!s) extraSeats.push(p);
          if (s) used.add(s);
        });
        notes.push(`co-hosts: ${pick.offs.map((o, k) => `${o > 0 ? 'right' : 'left'} ${Math.abs(o).toFixed(2)} m${pick!.spots[k] ? ` (${pick!.spots[k]!.name})` : ' (desk seat)'}`).join(', ')}${inp.wantDesk ? pick.desk ? `, desk ${pick.desk.width.toFixed(2)} m` : ', no room for a wider desk' : ''}`);
        if (pick.desk) desk0 = pick.desk;
      }
      const rest = want - cohosts.length;
      if (rest > 0) {
        // no (more) free floor beside the host: the nearest room chairs facing the same way (never a guest chair); a seat
        // like the host's (sit / stand) first
        const cands = seats.filter((s) => s.index < 12 && !guestChairs.has(s) && !used.has(s) && s.forward.dot(F) > 0.55 && s.position.distanceTo(host.position) < 4.5)
          .sort((a, b) => (a.pose === host.pose ? 0 : 3) + a.position.distanceTo(host.position) - (b.pose === host.pose ? 0 : 3) - b.position.distanceTo(host.position));
        for (const s of cands.slice(0, rest)) { cohosts.push({ position: s.position.clone(), yaw: s.yaw, spot: s, how: 'room' }); used.add(s); }
        notes.push(`co-hosts: no free floor beside the host for ${rest} — room chair(s) ${cands.slice(0, rest).map((s) => s.name).join(', ') || 'none'}`);
      }
    }
  }
  const coHeads = cohosts.map((c) => c.position.clone().setY(c.position.y + headY));
  // where the establishing / two-shots will look from: an arc (±40°, like the shot solver's yaw spread) in front of
  // the whole set (host + co-hosts + guest chairs), 3.5 / 5 m out — a monitor that hides a chair from any of them is a
  // broken set
  const seen = [...coHeads, ...(inp.guestSeats ?? [])];
  const setC = seen.reduce((a, p) => a.add(p), H.clone()).multiplyScalar(1 / (1 + seen.length));
  const setViews: THREE.Vector3[] = [];
  for (const deg of [-40, -20, 0, 20, 40]) for (const dist of [3.5, 5]) setViews.push(setC.clone().addScaledVector(F.clone().applyAxisAngle(UP, deg * D2R), dist).addScaledVector(UP, 0.5));

  // ---- desk
  let desk: SetLayout['desk'] = desk0;
  if (inp.wantDesk && !desk) {
    for (const [d, w] of [[0.66, 1.45], [0.72, 1.3], [0.6, 1.2], [0.8, 1.1]] as const) {
      const c = host.position.clone().addScaledVector(F, d);
      if (nearSeat(c, 0.55)) continue;
      if (!boxFree(probe, rays, c.clone().setY(floorY + 0.4), yawF, w / 2, 0.36, 0.3)) continue;
      desk = { position: c.setY(floorY), yaw: yawF, width: w };
      break;
    }
    if (!desk) notes.push('desk: no free floor in front of the host chair (no desk)');
  }


  // ---- monitor
  let monitor = null as SetLayout['monitor'];
  if (!inp.haveMonitor) {
    const toC = inp.roomCenter.clone().sub(host.position).setY(0);
    const sides = inp.side ? [inp.side, -inp.side] : (toC.dot(R) >= 0 ? [1, -1] : [-1, 1]);
    const W = inp.width, Hp = W / inp.aspect, cab = inp.cabinet;
    let best = null as SetLayout['monitor'], bestHid = 0;
    for (const s of sides) {
      // (the far ring — 3.4 / 3.9 m out, further forward / back — only matters when every near place is bad, e.g. it
      // would hide a guest chair: the scoring's distance cost keeps the near places first)
      for (const L of [2.1, 1.8, 2.5, 2.9, 1.5, 3.4, 3.9]) for (const fo of [0.35, 0.8, -0.1, 1.3, 1.9, -0.6]) for (const ang of [40, 30, 52]) for (const dy of [0.3, 0.45, 0.15]) {
        const base = host.position.clone().addScaledVector(R, s * L).addScaledVector(F, fo);
        const center = base.clone().setY(H.y + dy);
        // facing: the room's front turned towards the host by `ang`
        const n = F.clone().multiplyScalar(Math.cos(ang * D2R)).addScaledVector(R, -s * Math.sin(ang * D2R)).normalize();
        const yaw = Math.atan2(n.x, n.z);
        if (nearSeat(base, 0.95) || (desk && base.distanceTo(desk.position) < desk.width / 2 + 0.7)) continue;
        // the housing box (behind the picture plane) + the pedestal down to the floor
        const bc = center.clone().addScaledVector(n, -cab.d / 2);
        const bottom = cab.floor ? floorY + 0.05 : center.y - cab.h / 2;
        const top = center.y + cab.h / 2;
        const boxC = bc.clone().setY((bottom + top) / 2);
        if (!boxFree(probe, rays, boxC, yaw, cab.w / 2, (top - bottom) / 2, cab.d / 2)) continue;
        if (cab.floor) { const fl = rays.floorBelow(center, 3); if (fl === null || Math.abs(fl - floorY) > 0.25) continue; }
        // the host sees every corner, a front camera sees the picture + the host's face
        const right = new THREE.Vector3().crossVectors(UP, n).normalize();
        const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => center.clone().addScaledVector(right, x * W * 0.45).addScaledVector(UP, y * Hp * 0.45).addScaledVector(n, 0.02));
        let sc = 0, hid = 0;
        for (const c of corners) if (!rays.clear(H, c)) sc += 2;
        const cam = front(center);
        for (const c of [center, ...corners]) if (!rays.clear(cam, c)) sc += 1;
        // a co-host's head between the host and the picture / between the front camera and it
        for (const hd of coHeads) {
          if (segNear(H, center, hd, 0.28)) sc += 2;
          if (segNear(cam, center, hd, 0.3)) sc += 1.5;
        }
        if (!rays.clear(cam, H)) sc += 3;
        // the guest chairs' faces seen from the front must not be behind the monitor
        {
          const inv = new THREE.Matrix4().compose(boxC, new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1)).invert();
          const box = new THREE.Box3(new THREE.Vector3(-cab.w / 2, -(top - bottom) / 2, -cab.d / 2), new THREE.Vector3(cab.w / 2, (top - bottom) / 2, cab.d / 2));
          // chairs fill in order (the first guest takes the first chair): hiding an early chair costs more
          for (const [gi, gs] of seen.entries()) {
            const wgt = Math.max(1, 3 - gi);
            const c0 = front(gs);
            for (const from of [cam, c0, ...(inp.wide ? [inp.wide] : []), inp.roomCenter.clone().addScaledVector(F, 4).setY(H.y + 0.4), ...setViews]) {
              const a = from.clone().applyMatrix4(inv), b = gs.clone().applyMatrix4(inv);
              const d = b.clone().sub(a), L = d.length(), q = new THREE.Vector3();
              // (a guest chair hidden behind the monitor is a broken set, not a small cost: guestlink found SPOT_03 in
              // the room behind it — any free place that hides nobody wins)
              if (new THREE.Ray(a, d.divideScalar(L)).intersectBox(box, q) && q.distanceTo(a) < L) { sc += 4 * wgt; hid++; }
            }
          }
        }
        // the picture must face the front camera enough to read
        const view = cam.clone().sub(center).setY(0).normalize();
        if (view.dot(n) < 0.35) sc += 3;
        sc += Math.abs(L - 2.1) * 0.6 + Math.abs(fo - 0.35) * 0.4 + Math.abs(ang - 40) / 30 + (s === sides[0] ? 0 : 0.8) + Math.abs(dy - 0.3) * 2;
        if (!best || sc < best.score) { best = { center, yaw, width: W, score: sc }; bestHid = hid; }
        if (best.score < 0.3) break;
      }
      if (best && best.score < 2) break;
    }
    monitor = best;
    if (best && bestHid) notes.push(`monitor: hides a guest chair from ${bestHid} view(s) (no better free place)`);
    if (!monitor) notes.push('monitor: no free place beside the host (use scene.json interview.monitor)');
  }

  // ---- sidekick
  let sidekick: SetLayout['sidekick'] = null;
  if (!inp.haveSidekick) {
    const mSide = monitor ? Math.sign(monitor.center.clone().sub(host.position).dot(R)) || 1 : 1;
    let best: { p: THREE.Vector3; yaw: number; sc: number } | null = null;
    for (const s of [-mSide, mSide]) for (const L of [1.9, 2.4, 1.5, 2.9]) for (const fo of [0.6, 1.1, 0.1, 1.6]) {
      const p = host.position.clone().addScaledVector(R, s * L).addScaledVector(F, fo).setY(floorY);
      if (nearSeat(p, 0.9) || (desk && p.distanceTo(desk.position) < desk.width / 2 + 0.9) || Math.hypot(p.x - host.position.x, p.z - host.position.z) < 1.45) continue;
      if (monitor && Math.hypot(p.x - monitor.center.x, p.z - monitor.center.z) < 1.2) continue;
      const fl = rays.floorBelow(p.clone().setY(floorY + 1), 2);
      if (fl === null || Math.abs(fl - floorY) > 0.15) continue;
      if (!boxFree(probe, rays, p.clone().setY(floorY + 0.6), 0, 0.42, 0.55, 0.42)) continue;
      const head = p.clone().setY(floorY + 0.85);
      const cam = front(head);
      let sc = (rays.clear(cam, head) ? 0 : 4) + (rays.clear(H, head) ? 0 : 1) + Math.abs(L - 1.9) * 0.5 + Math.abs(fo - 0.6) * 0.4 + (s === -mSide ? 0 : 1);
      // (co-hosts beside the host: the sidekick stands clear of them — not in front of them seen from the front, and
      // not right beside them, where a co-host's single would have him filling the corner)
      for (const hd of coHeads) {
        const hf = front(hd);
        if (segNear(hf, hd, head, 0.6) || segNear(hf, hd, p.clone().setY(floorY + 0.45), 0.55)) sc += 5;
        if (Math.hypot(p.x - hd.x, p.z - hd.z) < 1.6) sc += 2;
      }
      // (…and never in front of a guest chair seen from the front: a studio guest hidden behind the band stand)
      for (const gs of inp.guestSeats ?? []) {
        const hf = front(gs);
        if (segNear(hf, gs, head, 0.55) || segNear(hf, gs, p.clone().setY(floorY + 0.45), 0.5)) sc += 4;
      }
      // (not beside the monitor's picture: every monitor close-up would have him in its corner)
      if (monitor) { const dm = Math.hypot(p.x - monitor.center.x, p.z - monitor.center.z); if (dm < 2.2) sc += (2.2 - dm) * 2; }
      // (the establishing / two-shot views of the whole set: nobody seated behind him)
      for (const hd of seen) for (const v of setViews) if (segNear(v, hd, head, 0.5) || segNear(v, hd, p.clone().setY(floorY + 0.45), 0.45)) sc += 0.8;
      const toCam = cam.clone().sub(p).setY(0).normalize(), toHost = host.position.clone().sub(p).setY(0).normalize();
      const face = toCam.multiplyScalar(0.6).add(toHost.multiplyScalar(0.4)).normalize();
      if (!best || sc < best.sc) best = { p, yaw: Math.atan2(face.x, face.z), sc };
      if (sc < 0.2) break;
    }
    sidekick = best ? { position: best.p, yaw: best.yaw } : null;
    if (!sidekick) notes.push('sidekick: no free floor beside the set');
  }
  return { desk, monitor, sidekick, cohosts, notes };
}
