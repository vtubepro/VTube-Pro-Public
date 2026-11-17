// Performer shots for the walking ship's director (voyageCams.ts DECK / PUSHIN): a medium shot of a performer on the
// deck, framed so the moving world (the horizon, the sky, the light show) is BEHIND them. The room never moves (the
// world streams past the ship), so these cameras live in the room frame and ride with the deck like the authored ones.
// Candidates are found once per performer seat on a ring round the drawn face (azimuth off their facing, distance,
// height), and every one is checked against the room itself (RoomRays: BVH rays on the occluders + the collider boxes):
//   * the face is in sight from the camera (from its drawn surface, so a snout / a hat brim counts), at both ends of the
//     shot's move, and the move's path is clear (never through a rail, a post or the awning);
//   * the camera is outside every collider and not inside a person;
//   * what lies behind the performer: a ray from the camera through the face runs on for 60 m - open (the horizon,
//     the sky) scores high, the deli's back wall scores low.
// The lens comes from the framing solver's own frameFrom (shotSolver.ts): the face, head top and chest inside the
// safe area, so the framing guarantee's safe lines hold by construction; the shot names its subject so the live drift
// guard keeps a leaning performer in frame. Pure in (room, seat, rest pose, shot seed, u): every page cuts the same shot.
import * as THREE from 'three';
import type { CamPose } from '../cameraRig.ts';
import { frameFrom, type ShotSubject } from '../shotSolver.ts';
import { RoomRays } from '../twoShot.ts';
import type { RoomInfo } from '../contract.ts';

const UP = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;
const AZ = [8, 16, 24, 36, 48, 60, 72];
const DIST = [2.5, 3.2, 4.2];
const DH = [-0.45, -0.2, 0.15];

export interface DeckCand { az: number; dist: number; dh: number; a: THREE.Vector3; b: THREE.Vector3; open: number; score: number; chest: boolean; far: THREE.Vector3 | null }
export interface DeckShot { pose: CamPose; key: string; open: number; cand: number }

export class DeckCams {
  private rays: RoomRays | null = null;
  private room: RoomInfo | null = null;
  private plans = new Map<string, DeckCand[]>();
  private picks = new Map<string, number>();
  /** tests / debug: the last plan's size and the rays it cost */
  stats = { plans: 0, cands: 0, rays: 0 };

  /** The room's rays (null = no room). */
  get roomRays(): RoomRays | null { return this.rays; }
  /** The room changed (load, edit): forget every plan. */
  reset(room: RoomInfo | null) { this.room = room; this.rays = room ? new RoomRays(room) : null; this.plans.clear(); this.picks.clear(); }

  /** The ranked camera candidates for one performer at their seat (cached by key + the seat's rounded position). */
  plan(s: ShotSubject): DeckCand[] {
    if (!this.room || !this.rays) return [];
    const F = s.face.center;
    const sig = `${s.key}:${F.toArray().map((v) => Math.round(v * 20)).join(',')}`;
    const hit = this.plans.get(sig);
    if (hit) return hit;
    const rays = this.rays;
    const r0 = rays.count;
    const fw = s.forward.clone().setY(0);
    if (fw.lengthSq() < 1e-6) fw.set(0, 0, 1);
    fw.normalize();
    const surf = F.clone().addScaledVector(fw, Math.max(0.06, s.depth ?? 0.08));
    const inCollider = (p: THREE.Vector3) => rays.colliders.some((b) => b.containsPoint(p));
    const out: DeckCand[] = [];
    const at = (az: number, dist: number, dh: number) => F.clone().addScaledVector(fw.clone().applyAxisAngle(UP, az * D2R), dist).addScaledVector(UP, dh);
    for (const side of [1, -1]) for (const az0 of AZ) for (const dist of DIST) for (const dh of DH) {
      const az = side * az0;
      // the move: an 8 deg arc round the performer (a push-in uses the same line, further out at the start)
      const a = at(az - side * 4, dist * 1.15, dh), b = at(az + side * 4, dist, dh);
      if (inCollider(a) || inCollider(b)) continue;
      if (!rays.clearSee(surf, a) || !rays.clearSee(surf, b) || !rays.clear(a, b)) continue;
      // (the head top must be in sight too: a low camera under an awning edge)
      if (!rays.clearSee(F.clone().addScaledVector(UP, s.top ?? s.face.size * 1.1), b)) continue;
      // (the chest too, from BOTH ends of the move: a camera low behind a counter or the hull's rail shows a head floating
      // on its top - one end clear is not enough)
      const chestP = F.clone().addScaledVector(UP, -Math.max(0.28, s.face.size * 3.2));
      const chest = rays.clearSee(chestP, a) && rays.clearSee(chestP, b) ? 1 : 0;
      // (a push-in starts 1.6x out on the same line: kept only when that start is clear and sees the face and the chest)
      const fp = F.clone().add(b.clone().sub(F).multiplyScalar(1.6));
      const far = !inCollider(fp) && rays.clear(fp, b) && rays.clearSee(surf, fp) && rays.clearSee(chestP, fp) ? fp : null;
      const dir = F.clone().sub(b).normalize();
      const beyond = rays.hit(F.clone().addScaledVector(dir, 0.7), F.clone().addScaledVector(dir, 60));
      const open = Math.min(1, (Number.isFinite(beyond) ? beyond : 60) / 60);
      const score = 2.2 * open + 1.4 * chest + 1.2 * (1 - Math.abs(az0 - 30) / 48) - 1.6 * Math.max(0, Math.min(1, (az0 - 40) / 30)) + (dh === -0.2 ? 0.35 : dh < 0 ? 0.15 : 0) + (dist === 3.2 ? 0.2 : 0);
      out.push({ az, dist, dh, a, b, open, score, chest: chest === 1, far });
    }
    // a performer shot shows the chest: a head peeking over a counter / the hull's rail, the rest of the frame the
    // counter in front of the lens, is never a shot (Preshow showed a frog's eyes over a wall of deck); no angle that
    // sees the chest = no performer shot for this seat (the director takes an exterior move)
    for (let i = out.length - 1; i >= 0; i--) if (!out[i].chest) out.splice(i, 1);
    out.sort((x, y) => y.score - x.score || x.az - y.az || x.dist - y.dist || x.dh - y.dh);
    // (the ranking's best 8, plus the best near-frontal ones: in a canyon only a view along it stays open behind them)
    const keep = out.slice(0, 8);
    for (const c of out) if (keep.length < 11 && Math.abs(c.az) <= 16 && !keep.includes(c) && c.open >= 0.5) keep.push(c);
    this.plans.set(sig, keep);
    this.stats = { plans: this.plans.size, cands: keep.length, rays: rays.count - r0 };
    return keep;
  }

  /** The performer shot at u (0..1) of a shot with this seed: 'arc' (a slow 8 deg arc) or 'push' (a push-in from 1.6x
   *  out). null = no clean candidate (the director picks another move). */
  shot(s: ShotSubject, u: number, seed: number, kind: 'arc' | 'push', aspect: number, world?: (dir: THREE.Vector3) => number): DeckShot | null {
    const P = this.plan(s);
    if (!P.length) return null;
    // the best few by score, the seed picks one (open backgrounds first: the top of the ranking); with the moving world's
    // own openness (`world`: 0 = a canyon wall right behind them .. 1 = horizon / sky), chosen once per shot, the most
    // open of them wins when it is clearly more open (in a canyon: the view down its open end, or up at the sky)
    let top = P.filter((c) => c.open >= P[0].open - 0.25).slice(0, 4);
    let ci = seed % top.length;
    if (world) {
      const k = `${seed}:${s.key}`;
      let pick = this.picks.get(k);
      if (pick === undefined) {
        // (every planned candidate competes on the world's openness; ties keep the seed's pick among the top four)
        const F = s.face.center, sc = P.map((c) => world(F.clone().sub(c.b).normalize()));
        pick = P.indexOf(top[ci]);
        let best = sc[pick];
        sc.forEach((v, i) => { if (v > best + 0.12) { best = v; pick = i; } });
        if (this.picks.size > 64) this.picks.clear();
        this.picks.set(k, pick);
      }
      top = P; ci = pick;
    }
    const c = top[ci];
    const e = u * u * (3 - 2 * u);
    const F = s.face.center;
    let pos: THREE.Vector3;
    if (kind === 'push') {
      // the push starts further out on the SAME line when that start was planned clear (face + chest in sight), else at a
      pos = (c.far ? c.far.clone() : c.a.clone()).lerp(c.b, e);
    } else pos = c.a.clone().lerp(c.b, e);
    const top0 = F.clone().addScaledVector(UP, s.top ?? s.face.size * 1.1);
    const chest = F.clone().addScaledVector(UP, -Math.max(0.28, s.face.size * 3.2));
    const right = new THREE.Vector3().crossVectors(F.clone().sub(pos), UP).normalize();
    const half = s.headHalf ?? s.face.size * 0.9;
    const pts = [top0, chest, F.clone().addScaledVector(right, half * 1.6), F.clone().addScaledVector(right, -half * 1.6)];
    const pose = frameFrom(pos, pts, aspect, { minFov: 16, maxFov: 58 });
    if (!pose) return null;
    return { pose, key: `${c.az}:${c.dist}:${c.dh}`, open: c.open, cand: ci };
  }
}
