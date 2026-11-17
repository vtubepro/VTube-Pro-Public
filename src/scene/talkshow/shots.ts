// Interview camera coverage: every shot the director cuts to, solved from the set's geometry (host face + desk, the
// monitor's picture / panels, seated guests, the sidekick) and kept inside the modelled room.
//
// Each shot = targets that must fit the frame + a preferred direction; candidates around it (yaw ± 45°, three
// elevations) are framed (fit distance), pulled in front of walls (the lens widens to keep the framing), then scored
// with room rays: key points hidden (faces, picture corners), the camera inside furniture / behind a wall, view rays
// into the void (indoor rooms), distance from the preferred direction and lens widening. Scene.json `interview.shots`
// can pin any shot by hand. Results are cached per set geometry + aspect; solving one shot costs a few ms.
import * as THREE from 'three';
import { lookPose, type CamPose } from '../cameraRig.ts';
import type { RoomInfo } from '../contract.ts';
import { RoomProbe, fitDistance, fitFov, frameFrom } from '../shotSolver.ts';
import type { RoomRays } from '../twoShot.ts';
import { FrameGuard, type GuardTarget } from '../frameGuard.ts';
import { RIGS, safeFor, type MotionEnvelope, type ShotFamily } from '../../../shared/framing.ts';

const UP = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;
/** The room's own cameras offered to the wide / two-shot / panel solves: none that looks DOWN on the faces more than this many
 *  degrees, or stands more than this many metres above them (a straight-down ceiling camera, a high jib: the top of people's heads
 *  is no way to see a conversation) - unless no other room camera is left, or the shot cannot be made clean without them. */
const LENS_DOWN_MAX = 35, LENS_ABOVE_MAX = 2.5;
/** An over-the-shoulder within this distance and this angle of the guest's own single is "the same shot". */
const SAME_POS = 0.3, SAME_DEG = 10;

export interface Head { face: THREE.Vector3; size: number; forward: THREE.Vector3; top: number;
  /** The head's horizontal half-extent (hair, a mascot head), m, when measured. */
  half?: number;
  /** The whole occupant as a world box (a mech's hull): it hides what is behind it (framing guarantee). */
  body?: THREE.Box3;
  /** The drawn face surface in front of the face centre, m (src/scene/faceDepth.ts). */
  depth?: number;
  /** The middle of the head (body volumes go round it; default `face`): a drawn face sits on the head's front. */
  head?: THREE.Vector3;
  /** The floor under them and whether they sit (the body volume reaches the floor when they stand — a giant standing
   *  beside a guest chair hides the guest behind its legs too). Unknown: seated. */
  floorY?: number;
  sit?: boolean;
  /** Their seat's own camera in the room (SPOT_xx_CAM: where the room's real camera for that seat stands), if any. */
  cam?: THREE.Vector3;
  /** Their standing height at their scale (m), when measured: with the head (crown to chin) it gives the avatar's
   *  proportions — how many heads tall — which set how much of them a single shows (singleFrame). */
  tall?: number }

/** The face box's height from the REAL head (shared/framing.ts FACE_BOX: up 1.15, down 0.8, side 0.6 face sizes): a
 *  mascot's drawn face measured from its wide-set eyes (a frog) gets a face size so big that the box reaches far above
 *  the head's real top — every single round it was a medium-wide of the set. When the measured head (every vertex above
 *  the chin) ends below the box top, the size follows the head (never under 45 % of the drawn size) and the face's
 *  width is kept as the head's half-width. Unmeasured head: unchanged. */
export function fitFaceBox(size: number, headTop: number | null, headHalf: number | null): { size: number; half: number | null } {
  if (headTop === null || !(headTop > 0) || headTop >= size * 1.15) return { size, half: headHalf };
  return { size: Math.max(size * 0.45, headTop / 1.15), half: Math.max(headHalf ?? 0, size * 0.6) };
}

/** How much of someone a single shows, from their proportions: the head (crown to chin: `top` + 0.8 face sizes) takes
 *  ~38 % of the frame height for a person (6+ heads tall: chest-up) up to ~55 % for a mascot / chibi (≤ 2.5 heads tall:
 *  head + upper body). Returns the drop from the face centre to the frame's bottom target (the solver adds its margin:
 *  ~12 %) and the head share asked for. `tight` < 1 = a push-in (a tighter frame). Unknown height: null. */
export function singleFrame(h: Pick<Head, 'size' | 'top' | 'tall'>, tight = 1): { below: number; share: number } | null {
  if (!h.tall || !(h.tall > 0)) return null;
  const headH = h.top + h.size * 0.8;
  const heads = h.tall / Math.max(0.05, headH);
  const share = THREE.MathUtils.clamp(0.55 - 0.17 * (heads - 2.5) / 3.5, 0.38, 0.55);
  const frameH = (headH / share) * (tight < 1 ? 0.35 + 0.65 * tight : 1);
  return { below: Math.max(h.size * 1.6, frameH / 1.12 - h.top - 0.04), share };
}
export interface SetGeom {
  host: Head | null;
  /** Monitor picture: centre, facing, size, corners (TL TR BR BL) and its panels (by panel index). */
  monitor: { center: THREE.Vector3; normal: THREE.Vector3; width: number; height: number; corners: THREE.Vector3[]; panels: { center: THREE.Vector3; width: number; height: number }[] } | null;
  /** Per guest (guest order: Guest 1, 2 …): seated in the room (their head) or on monitor panel `panel` (-1 = neither). */
  guests: { seat: Head | null; panel: number }[];
  /** Per co-host (Co-host 1, 2): at the desk / their chair (their head), or on a monitor panel (a projector TV). */
  cohosts?: { seat: Head | null; panel: number }[];
  sidekick: Head | null;
  /** Front of the desk (for establishing / two-shots). */
  desk: THREE.Vector3 | null;
  aspect: number;
  skyOk: boolean;
  voidOk: boolean;
  /** Guest chairs nobody sits in (seat centres): a shot keeps them out of the middle of the frame — a video caller's
   *  show must not be framed around the empty armchair between the host and the screen (the VOD of 2026-10-08). */
  empty?: THREE.Vector3[];
}

export interface ShotResult { pose: CamPose; score: number; notes: string[] }

interface Spec {
  targets: THREE.Vector3[];
  look: THREE.Vector3;
  prefer: THREE.Vector3;          // horizontal unit: from the subject towards the camera
  elev: number;                   // preferred elevation (deg, + = camera above looking down)
  fov: number;
  margin: number;
  must: THREE.Vector3[];
  mustW?: number;
  yawSpread?: number;
  /** Forced position (over-the-shoulder / reverse): only small offsets are searched. */
  from?: THREE.Vector3;
  /** Several fixed positions to choose from (over the shoulder), each pulled in front of walls from `pullFrom`. */
  fromList?: THREE.Vector3[];
  pullFrom?: THREE.Vector3;
  /** The subject surface should face the camera (a monitor / a face): penalty when seen too obliquely. */
  facing?: { c: THREE.Vector3; n: THREE.Vector3; min: number };
  /** Other people's heads: never cut by the frame edge, never looming right in front of the lens. */
  avoid?: Head[];
  tight?: boolean;
  /** Several people: their key points kept out of the outer edge of the frame (not merely inside it). */
  safe?: boolean;
  /** Everyone on the set (their head + body can hide a key point from the lens). */
  people?: Head[];
  /** (internal: the search already retried from higher up) */
  lifted?: boolean;
  /** Framing guarantee (src/scene/frameGuard.ts): the heads this shot frames, extra points that must be in the frame
   *  (the monitor's picture), and the family's safe area. */
  framed?: Head[];
  hardPts?: THREE.Vector3[];
  family?: ShotFamily;
  /** (internal: every scored candidate, for the guard's fallbacks) */
  pool?: { pose: CamPose; score: number }[];
  /** The hard points must sit inside the family's own safe area (the monitor's 4 corners in a two-shot), not the
   *  looser default. */
  hardStrict?: boolean;
  /** The room's own camera positions to try first (a seat's SPOT_xx_CAM for a single; every CAM_* / studio camera for
   *  the wide shots): re-aimed and the lens re-fitted, preferred when they frame it clean — the director cuts between the
   *  set's real cameras where it can. */
  lenses?: THREE.Vector3[];
  /** How far round from a framed face's facing the camera may stand (deg; default: 72 for a single, 115 for the rest). */
  away?: number;
  /** A camera this shot must not be (an over-the-shoulder that is the guest's own single camera makes every "another angle" cut a
   *  no-op): position + the way it looks; within SAME_POS m and SAME_DEG deg of it costs 6. */
  differ?: { pos: THREE.Vector3; dir: THREE.Vector3 };
  /** A seated guest's own single: someone in front of them / big and near in the foreground is searched round once more
   *  (wider, a little higher) — a crowded couch, a big guest in the chair in front. */
  crowd?: boolean;
}

/** Whose key point this is (the nearest face / head top). */
function ownerOf(m: THREE.Vector3, people: Head[]): Head | null {
  let best: Head | null = null, bd = Infinity;
  for (const h of people) { const d = Math.min(m.distanceTo(h.face), m.distanceTo(h.face.clone().addScaledVector(UP, h.top))); if (d < bd) { bd = d; best = h; } }
  return bd < 0.5 + (best?.top ?? 0) ? best : null;
}

/** Segment a → b passes through a seated / standing person (head sphere + torso box, sized by the head). */
function behindPerson(a: THREE.Vector3, b: THREE.Vector3, h: Head): boolean {
  const d = b.clone().sub(a), L = d.length();
  if (L < 1e-4) return false;
  const ray = new THREE.Ray(a, d.divideScalar(L)), q = new THREE.Vector3();
  const hc = h.head ?? h.face;
  if (ray.intersectSphere(new THREE.Sphere(hc.clone().addScaledVector(UP, h.size * 0.15), h.size * 0.72), q) && q.distanceTo(a) < L - 0.03) return true;
  // (a mech's hull: the whole box hides what is behind it)
  if (h.body && !h.body.isEmpty() && ray.intersectBox(h.body, q) && q.distanceTo(a) < L - 0.03 && !h.body.containsPoint(b)) return true;
  const w = h.size * 1.05, c = hc;
  const box = new THREE.Box3(new THREE.Vector3(c.x - w, c.y - h.size * 3.5, c.z - w), new THREE.Vector3(c.x + w, c.y - h.size * 0.6, c.z + w));
  return !!ray.intersectBox(box, q) && q.distanceTo(a) < L - 0.03;
}

export class ShotBook {
  readonly probe: RoomProbe;
  private cache = new Map<string, ShotResult>();
  /** The room's motion envelope for interview shots (SceneRuntime.motionFor('interview'), set by the engine each frame):
   *  faces keep that much further inside the safe area. Part of the cache key. */
  motion: MotionEnvelope | null = null;
  /** Shots that can't be made (or can't be made clean: an establishing / two-shot with someone hidden behind a giant —
   *  the engine then uses the room's own guarded wide shot), cached like the poses. */
  private misses = new Set<string>();
  /** Off = no framing guarantee (scene.json framing.guard false). */
  guardOn = true;
  /** scene.json framing.safe of the room (set by the engine with `motion`). */
  safeRoom: Record<string, unknown> | null = null;
  /** The room's camera positions (every CAM_* preset + scene.json studioCams lenses), world — set by the engine. */
  lenses: THREE.Vector3[] = [];
  constructor(readonly room: RoomInfo, readonly rays: RoomRays, readonly overrides: Record<string, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {}) {
    this.probe = new RoomProbe(room);
    // (the set's shots never depend on where a room part an engine keeps animating happened to be)
    rays.skipMovers = true; this.probe.skipMovers = true;
  }

  clear() { this.cache.clear(); this.misses.clear(); }
  get size() { return this.cache.size; }
  info() { return [...this.cache.entries()].map(([k, r]) => ({ key: k, score: +r.score.toFixed(2), notes: r.notes.slice(0, 4) })); }

  /** Pose for a shot id + subject ('host' | 'c0'… | 'g0'… | 'sidekick'; over-the-shoulder: 'g0@c0' = towards guest 1 over
   *  co-host 1's shoulder), or null when the set lacks what it frames. */
  get(shot: string, subject: string, g: SetGeom, sig: string): ShotResult | null {
    const m = this.motion;
    const key = `${shot}|${subject}|${sig}|${g.aspect.toFixed(3)}${m ? `|m${[m.heave * 1000, m.roll * 100, m.pitch * 100, m.yaw * 100, m.kick * 100].map((v) => Math.round(v)).join('.')}` : ''}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.misses.has(key)) return null;
    const ov = this.overrides[shot === 'guest' || /^guest\d$/.test(shot) ? shot : subject && shot !== 'establishing' && shot !== 'two' ? `${shot}:${subject}` : shot] ?? this.overrides[shot];
    let res: ShotResult | null;
    if (ov && Array.isArray(ov.pos) && Array.isArray(ov.target)) {
      const p = this.room.root.localToWorld(new THREE.Vector3(...ov.pos)), t = this.room.root.localToWorld(new THREE.Vector3(...ov.target));
      res = { pose: lookPose(p, t, THREE.MathUtils.clamp(Number(ov.fov) || 35, 10, 90)), score: 0, notes: ['scene.json interview.shots'] };
    } else { const t0 = performance.now(); res = this.solve(shot, subject, g); if (res) res.notes.push(`${(performance.now() - t0).toFixed(1)} ms`); }
    if (res) { if (this.cache.size > 160) this.cache.clear(); this.cache.set(key, res); }
    else { if (this.misses.size > 160) this.misses.clear(); this.misses.add(key); }
    return res;
  }

  private head(id: string, g: SetGeom): Head | null {
    if (id === 'host') return g.host;
    if (id === 'sidekick') return g.sidekick;
    const c = /^c(\d)$/.exec(id);
    if (c) return g.cohosts?.[+c[1]]?.seat ?? null;
    const m = /^g(\d)$/.exec(id);
    return m ? g.guests[+m[1]]?.seat ?? null : null;
  }

  private solve(shot: string, subjectIn: string, g: SetGeom, highLenses = false): ShotResult | null {
    const H = g.host, M = g.monitor;
    let droppedHigh = false;
    // 'g0@c0': the subject + whose shoulder / point of view (over-the-shoulder from a co-host)
    const [subject, via] = subjectIn.split('@') as [string, string | undefined];
    const coHeads = (g.cohosts ?? []).map((x) => x.seat).filter((x): x is Head => !!x);
    // (head top, chest and both shoulders of each: a two-shot that only fits the faces leaves a shoulder cut off)
    // (scaled by the head: a giant's chest / shoulders are further down and out than a person's)
    const body = (h: Head) => { const hw = h.half ?? h.size * 0.62, w = Math.max(0.22, h.size * 1.5, hw), sh = -Math.max(0.28, h.size * 1.3);
      return [h.face.clone().addScaledVector(UP, h.top + Math.max(0.05, h.size * 0.1)), h.face.clone().addScaledVector(UP, -Math.max(0.5, h.size * 1.9)),
        ...[[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([x, z]) => [h.face.clone().add(new THREE.Vector3(x * w, sh, z * w)), h.face.clone().add(new THREE.Vector3(x * hw, 0, z * hw))])]; };
    // people side by side at the desk (hosts / panel): a medium shot — hair / ears / pigtails wider than the measured
    // head, the chest and hands on the desk in the frame (a heads-only fit crowds the frame and cuts the outer heads)
    const deskBody = (h: Head) => { const r = Math.max(0.3, (h.half ?? h.size * 0.62) * 1.9, h.size * 1.6);
      return [...body(h), ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => h.face.clone().add(new THREE.Vector3(x * r, 0.02, z * r))), h.face.clone().addScaledVector(UP, -Math.max(0.72, h.size * 3.2))]; };
    const onMonitor = [...g.guests, ...(g.cohosts ?? [])].filter((x) => x.panel >= 0).length;
    const side = (h: Head, toward: THREE.Vector3 | null, deg: number) => {
      // rotate the facing by `deg` towards (+) / away from (−) a point
      if (!toward) return h.forward.clone();
      const to = toward.clone().sub(h.face).setY(0).normalize();
      const s = Math.sign(new THREE.Vector3().crossVectors(h.forward, to).y) || 1;
      return h.forward.clone().applyAxisAngle(UP, deg * D2R * s).setY(0).normalize();
    };
    // (a push-in still keeps 3 face sizes of chest under the face: the face box never more than ~45 % of the frame height)
    // (never below what they stand / sit on: a small host — a frog on a desk — gets a real close-up of themselves, not
    // half a metre of the furniture under them)
    const single = (h: Head, prefer: THREE.Vector3, tight = 1): Spec => {
      // (from their proportions when their height is known: chest-up for a person, head + upper body for a mascot —
      // never a fixed number of face sizes, which for a big drawn face reached the floor)
      const fr = singleFrame(h, tight);
      let below = fr ? fr.below : Math.max(Math.max(0.36, h.size * 4.2) * tight, h.size * 3);
      if (h.floorY !== undefined) below = Math.min(below, Math.max(h.size * 1.6, h.face.y - h.floorY + 0.02));
      return {
        ...(h.cam ? { lenses: [h.cam] } : {}),
        targets: [h.face.clone().addScaledVector(UP, h.top + 0.04), h.face.clone().addScaledVector(UP, -below)],
        // (proportioned: aimed at the middle of what it frames, so the head gets the share asked for — aimed near the face,
        // a big head's frame grew by its whole crown again below)
        look: fr ? h.face.clone().addScaledVector(UP, (h.top + 0.04 - below) / 2) : h.face.clone().addScaledVector(UP, -Math.min(h.size * 1.1 * tight, below * 0.45)), prefer, elev: 3, fov: tight < 1 ? 24 : 30, margin: 0.06 * tight, must: [h.face],
      };
    };
    const gi = (id: string) => { const m = /^g(\d)$/.exec(id); return m ? +m[1] : -1; };
    const firstSeat = () => g.guests.find((x) => x.seat)?.seat ?? null;
    // what the host talks to: the first seated guest, else the monitor
    const hostOther = () => firstSeat()?.face ?? M?.center ?? null;
    const monitorSpec = (i: number, tight = 1, panel?: number): Spec | null => {
      if (!M) return null;
      const pi = panel ?? (i >= 0 ? g.guests[i]?.panel ?? -1 : -1);
      const pn = pi >= 0 && onMonitor > 1 ? M.panels[pi] ?? null : null;
      const c = pn ? pn.center : M.center, w = (pn ? pn.width : M.width) * tight, h = (pn ? pn.height : M.height) * tight;
      const right = new THREE.Vector3().crossVectors(UP, M.normal).normalize();
      const pts = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => c.clone().addScaledVector(right, x * w / 2).addScaledVector(UP, y * h / 2));
      // square-on, turned a touch towards the host so the frame reads as "in the set"
      let prefer = M.normal.clone().setY(0).normalize();
      if (H) { const toH = H.face.clone().sub(M.center).setY(0).normalize(); prefer = prefer.multiplyScalar(0.88).addScaledVector(toH, 0.12).normalize(); }
      return { targets: pts, look: c, prefer, elev: 2, fov: 28, margin: Math.max(0.05, h * 0.12), must: [c, ...pts.map((p) => p.clone().lerp(c, 0.12))], yawSpread: 30, facing: { c, n: M.normal, min: 0.7 } };
    };
    let spec: Spec | null = null;
    const sub = subject || 'host';
    // the host's side of the desk: the host and the co-hosts
    const hostSide = sub === 'host' || /^c\d$/.test(sub);
    // (every guest's numbered single — Guest 1 … Guest N, however many the line-up allows — is the same solve: a missing
    // case here once sent Guest 4's every close-up to the establishing wide)
    switch (/^guest\d+$/.test(shot) ? 'guestN' : shot) {
      case 'host': case 'push': case 'reverse': {
        if (gi(sub) >= 0 && !this.head(sub, g)) return this.solve(shot === 'push' ? 'guestPush' : 'guest', sub, g);
        if (/^c[0-9]$/.test(sub) && !this.head(sub, g)) {
          // a co-host on the monitor (a projector-screen TV): their panel
          const pc = g.cohosts?.[+sub.slice(1)]?.panel ?? -1;
          if (pc < 0) return null;
          spec = monitorSpec(-1, shot === 'push' ? 0.82 : 1, pc);
          if (spec) { spec.family = 'monitor'; spec.hardPts = spec.must; }
          break;
        }
        const h = this.head(sub, g);
        if (!h) return null;
        if (shot === 'reverse') {
          // the other side's point of view (the guest's view of the host / a co-host: from the monitor / their seat)
          const seat = hostSide ? firstSeat() : null;
          const o = hostSide ? (seat ? seat.face.clone() : M ? M.center.clone().addScaledVector(M.normal, 0.3).addScaledVector(UP, -0.1) : null) : H?.face.clone() ?? null;
          if (!o) return null;
          if (hostSide && !seat) {
            // monitor guests: "the host turned to the guest" — a 3/4 single from the monitor's side of the room
            spec = { ...single(h, side(h, o, 34)), framed: [h], family: 'single' };
            break;
          }
          const back = o.clone().sub(h.face).setY(0).normalize();
          const right = new THREE.Vector3().crossVectors(UP, back).normalize();
          // over the other person's shoulder (both shoulders, three distances), pulled in front of walls towards them
          const rad = seat ? Math.max(seat.size * 1.6, seat.top * 0.9) : 0.2;
          const fromList: THREE.Vector3[] = [];
          for (const sd of [1, -1]) for (const k of [1, 0.7, 1.3]) fromList.push(o.clone().addScaledVector(back, (0.55 + rad * 3) * k).addScaledVector(right, sd * (0.3 + rad * 2)).addScaledVector(UP, 0.06 + rad * 0.5));
          spec = { ...single(h, back), fromList, pullFrom: o.clone(), fov: 30, facing: { c: h.face, n: h.forward, min: 0.1 }, framed: [h], family: 'single' };
        } else spec = { ...single(h, side(h, hostSide ? hostOther() : H?.face ?? null, hostSide ? -10 : 14), shot === 'push' ? 0.62 : 1), framed: [h], family: 'single' };
        break;
      }
      case 'guest': case 'guestN': case 'guestPush': {
        // (several callers we can't tell apart — subject 'all': the whole monitor)
        if (sub === 'all' && M) { spec = monitorSpec(-1, shot === 'guestPush' ? 0.82 : 1); if (spec) { spec.family = 'monitor'; spec.hardPts = spec.must; } break; }
        const i = /^guest\d+$/.test(shot) ? +shot.slice(5) - 1 : Math.max(0, gi(sub));
        const seat = g.guests[i]?.seat;
        if (!seat && (g.guests[i]?.panel ?? -1) < 0) return null;
        if (seat) { spec = { ...single(seat, side(seat, H?.face ?? null, 16), shot === 'guestPush' ? 0.62 : 1), framed: [seat], family: 'single', crowd: true }; break; }
        if (!M) return null;
        spec = monitorSpec(i, shot === 'guestPush' ? 0.82 : 1);
        if (spec) { spec.family = 'monitor'; spec.hardPts = spec.must; }
        break;
      }
      case 'ots': {
        // over the host's (or a co-host's: via) shoulder towards the guest (their seat / the monitor picture)
        const Hs = via ? this.head(via, g) : H;
        if (!Hs) return null;
        const i = Math.max(0, gi(sub));
        const seat = g.guests[i]?.seat ?? (M ? null : firstSeat());
        const tgt = seat ? seat.face : M?.center ?? null;
        if (!tgt) return null;
        const H0 = Hs;
        const back = H0.face.clone().sub(tgt).setY(0).normalize();
        const right = new THREE.Vector3().crossVectors(UP, back).normalize();
        // behind + beside the host's head (scaled by the head: big-headed avatars need more room), a touch above it,
        // on the side away from the host's facing so the head sits at the frame edge, not across the guest
        // the head's real radius (fluffy / big-headed avatars): the larger of the face and the head top
        const rad = Math.max(H0.size * 1.6, H0.top * 0.9);
        // behind + beside the host's head, both shoulders and three distances; the best keeps the guest's picture
        // facing the lens and the camera inside the set (pulled in front of walls towards the host's head)
        const fromList: THREE.Vector3[] = [];
        for (const sd of [1, -1]) for (const k of [1, 0.75, 1.35]) fromList.push(H0.face.clone().addScaledVector(back, (0.55 + rad * 3) * k).addScaledVector(right, sd * (0.28 + rad * 2.2)).addScaledVector(UP, 0.05 + rad * 0.6));
        const pts = seat ? [tgt.clone().addScaledVector(UP, seat.top + 0.05), tgt.clone().addScaledVector(UP, -0.45)] : M!.corners.map((p) => p.clone());
        // frame the guest; the host's head is left to fall at the frame edge (soft foreground)
        // (towards the screen: the picture itself must be clear — a prop between the lens and the screen hides the caller)
        const pic = seat ? [] : M!.corners.map((p) => p.clone().lerp(M!.center, 0.3));
        spec = { targets: pts, look: tgt.clone(), prefer: back, elev: 2, fov: 34, margin: seat ? 0.12 : M!.width * 0.14, must: [tgt, ...pic], fromList, pullFrom: H0.face.clone(),
          facing: seat ? { c: seat.face, n: seat.forward, min: 0.2 } : { c: M!.center, n: M!.normal, min: 0.45 },
          ...(seat ? { framed: [seat], family: 'single' as const } : { hardPts: [M!.center], family: 'monitor' as const }) };
        // (not the guest's own single camera: the cut to "another angle" would change nothing - a room camera at the host's shoulder
        // is both)
        if (!via) {
          const one = this.solve('guest', sub || 'g0', g);
          if (one) spec.differ = { pos: one.pose.position.clone(), dir: new THREE.Vector3(0, 0, -1).applyQuaternion(one.pose.quaternion) };
        }
        break;
      }
      case 'two': {
        // the host + a guest (seat / the monitor) — or, subject 'c0' / 'c1', the host + a co-host (the 'hosts' shot) — or, a
        // guest as subject and another (`via` 'g1', subject 'g0@g1') as the second person: the two guests, the host not in it
        if (!H) return null;
        const i = gi(sub);
        if (via && /^g\d$/.test(via) && i >= 0) {
          const A = g.guests[i]?.seat, B = g.guests[gi(via)]?.seat;
          if (!A || !B || A === B) return null;
          const pts = [...body(A), ...body(B)], must = [A.face, B.face];
          // (whoever sits between them - the host, a co-host, a third guest - is in the shot, whole)
          const d = B.face.clone().sub(A.face).setY(0), L2 = d.lengthSq();
          const between = [H, ...coHeads, ...g.guests.map((x) => x.seat)].filter((h): h is Head => !!h && h !== A && h !== B);
          const inside: Head[] = [];
          for (const h of between) {
            const t = L2 > 1e-4 ? h.face.clone().sub(A.face).setY(0).dot(d) / L2 : -1;
            const lat = A.face.clone().addScaledVector(d, t).setY(h.face.y).distanceTo(h.face);
            if (t > 0.03 && t < 0.97 && lat < 1.1) { pts.push(...deskBody(h)); must.push(h.face); inside.push(h); }
          }
          if (inside.length) pts.push(...deskBody(A), ...deskBody(B));
          const mid = A.face.clone().lerp(B.face, 0.5), pref = A.forward.clone().add(B.forward).setY(0).normalize();
          spec = { targets: pts, look: mid.addScaledVector(UP, -0.08), prefer: pref, elev: 5, fov: 34, margin: 0.16, must, yawSpread: 40, safe: true, framed: [A, B, ...inside], family: 'two' };
          break;
        }
        const co = /^c\d$/.test(sub) ? this.head(sub, g) : null;
        if (/^c\d$/.test(sub) && !co) return null;
        const o = co ?? (i >= 0 ? g.guests[i]?.seat : null) ?? (M && onMonitor ? null : firstSeat());
        const pts: THREE.Vector3[] = co ? deskBody(H) : body(H);
        let mid: THREE.Vector3, pref: THREE.Vector3;
        if (o) { pts.push(...(co ? deskBody(o) : body(o))); mid = H.face.clone().lerp(o.face, 0.5); pref = H.forward.clone().add(o.forward).setY(0).normalize(); }
        else if (M) { pts.push(...M.corners); mid = H.face.clone().lerp(M.center, 0.5); pref = H.forward.clone().add(M.normal).setY(0).normalize(); }
        else return null;
        // co-hosts sitting between the two (the host's desk runs towards the guest): in the shot, whole — a two-shot
        // that fits only the ends cuts the host at the frame edge
        const far = o ? o.face : M!.center, must = [H.face, far];
        if (!co) {
          const d = far.clone().sub(H.face).setY(0), L2 = d.lengthSq();
          for (const h of coHeads) {
            const t = L2 > 1e-4 ? h.face.clone().sub(H.face).setY(0).dot(d) / L2 : -1;
            const lat = H.face.clone().addScaledVector(d, t).setY(h.face.y).distanceTo(h.face);
            if (t > 0.03 && t < 0.97 && lat < 1.1) { pts.push(...deskBody(h)); must.push(h.face); }
          }
          // (three or more people in a row: everyone gets the roomier medium-shot outline)
          if (must.length > 2) { pts.push(...deskBody(H)); if (o) pts.push(...deskBody(o)); }
        }
        const twoHeads = [H, ...(o ? [o] : []), ...coHeads.filter((h) => must.includes(h.face))];
        // (host + the screen: the picture faces the lens, not edge-on)
        spec = { targets: pts, look: mid.addScaledVector(UP, -0.08), prefer: pref, elev: 5, fov: 34, margin: 0.16, must, yawSpread: 40, safe: true,
          framed: twoHeads, family: 'two', ...(o ? {} : { hardPts: M!.corners.map((c) => c.clone()), hardStrict: true, facing: { c: M!.center, n: M!.normal, min: 0.45 } }) };
        break;
      }
      case 'panel': {
        // every host at the desk: the host + the co-hosts (whole heads + shoulders, from the front)
        if (!H) return null;
        if (!coHeads.length) return this.solve('host', 'host', g);
        const hs = [H, ...coHeads];
        const pts = hs.flatMap(deskBody);
        const mid = hs.reduce((a, h) => a.add(h.face), new THREE.Vector3()).multiplyScalar(1 / hs.length);
        const pref = hs.reduce((a, h) => a.add(h.forward), new THREE.Vector3()).setY(0).normalize();
        if (g.desk) pts.push(g.desk.clone());
        spec = { targets: pts, look: mid.addScaledVector(UP, -0.12), prefer: pref, elev: 6, fov: 36, margin: 0.16, must: [H.face, ...coHeads.map((h) => h.face), ...hs.map((h) => h.face.clone().addScaledVector(UP, h.top))], yawSpread: 32, safe: true,
          framed: hs, family: 'two' };
        break;
      }
      case 'establishing': {
        if (!H) return null;
        const pts: THREE.Vector3[] = [H.face.clone().addScaledVector(UP, H.top + 0.1), H.face.clone().addScaledVector(UP, -1.1)];
        const must = [H.face];
        let pref = H.forward.clone();
        if (M && (onMonitor || !firstSeat())) { pts.push(...M.corners); must.push(M.center); pref.add(M.normal); }
        for (const h of coHeads) { pts.push(h.face.clone().addScaledVector(UP, h.top + 0.1), h.face.clone().addScaledVector(UP, -0.9)); must.push(h.face); }
        for (const x of g.guests) if (x.seat) { pts.push(x.seat.face.clone().addScaledVector(UP, x.seat.top + 0.1), x.seat.face.clone().addScaledVector(UP, -0.9)); must.push(x.seat.face); pref.add(x.seat.forward); }
        if (g.sidekick) { pts.push(g.sidekick.face.clone().addScaledVector(UP, g.sidekick.top + 0.05), g.sidekick.face.clone().addScaledVector(UP, -0.7)); }
        if (g.desk) pts.push(g.desk.clone());
        // (the whole width of every head: hair, a mascot head, a costume box)
        for (const h of [H, ...coHeads, ...g.guests.map((x) => x.seat)]) if (h) for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4, r = h.half ?? h.size * 0.62; pts.push(h.face.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r))); }
        pref = pref.setY(0).normalize();
        const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
        // whole heads, not just faces: a giant's head top must stay in the frame too (after the faces: must[0] = host)
        must.push(H.face.clone().addScaledVector(UP, H.top), ...coHeads.map((h) => h.face.clone().addScaledVector(UP, h.top)), ...g.guests.filter((x) => x.seat).map((x) => x.seat!.face.clone().addScaledVector(UP, x.seat!.top)));
        spec = { targets: pts, look: c, prefer: pref, elev: 9, fov: 42, margin: 0.2, must, yawSpread: 40, safe: true,
          framed: [H, ...coHeads, ...g.guests.map((x) => x.seat).filter((x): x is Head => !!x)], family: 'establishing',
          ...(M && (onMonitor || !firstSeat()) ? { hardPts: M.corners.map((p) => p.clone().lerp(M.center, 0.08)) } : {}) };
        break;
      }
      case 'sidekick': {
        const s = g.sidekick;
        if (!s) return null;
        spec = { ...single(s, side(s, H?.face ?? null, 12), 1.1), framed: [s], family: 'single' };
        spec.fov = 32;
        break;
      }
      default: return null;
    }
    if (!spec) return null;
    // (the 10 room cameras nearest the shot, 1.5-20 m away: a bounded number of extra candidates, same on every page)
    if ((shot === 'two' || shot === 'establishing' || shot === 'panel') && this.lenses.length) {
      const L = spec.look;
      const near = this.lenses.filter((v) => { const d = v.distanceTo(L); return d > 1.5 && d < 20; }).sort((a, b) => a.distanceTo(L) - b.distanceTo(L) || a.x - b.x || a.z - b.z);
      // (no camera that looks down on the faces: pitched more than LENS_DOWN_MAX deg, or LENS_ABOVE_MAX m above them)
      const faceY = spec.must.reduce((a, p) => a + p.y, 0) / Math.max(1, spec.must.length);
      const flat = highLenses ? near : near.filter((v) => Math.atan2(v.y - L.y, Math.hypot(v.x - L.x, v.z - L.z)) / D2R <= LENS_DOWN_MAX && v.y - faceY <= LENS_ABOVE_MAX);
      droppedHigh = !highLenses && flat.length < near.length;
      spec.lenses = (flat.length ? flat : near).slice(0, 10);
    }
    // everyone the shot isn't about: kept whole or out of frame
    const heads = [H, g.sidekick, ...coHeads, ...g.guests.map((x) => x.seat)].filter((x): x is Head => !!x);
    // (over-the-shoulder / reverse: the foreground head is the point of the shot)
    const fg = shot === 'ots' ? (via ? this.head(via, g) : H) : null;
    const shoot = (sp: Spec, name: string) => {
      sp.people = name === 'ots' || name === 'reverse' ? undefined : heads;
      sp.avoid = heads.filter((h) => !(name === 'ots' && h === fg) && !(name === 'reverse' && h === g.guests.find((x) => x.seat)?.seat) && !sp.must.some((m) => m.distanceTo(h.face) < 0.05));
      sp.pool = [];
      return this.guarded(this.search(sp, g, name), sp, g, heads);
    };
    const res = shoot(spec, shot);
    // an over-the-shoulder past a giant, a reverse that sees the back of the head, a push-in that can't be clean: the plain
    // single of the same person (clean by the same guarantee) instead
    const plain = shot === 'ots' ? ['guest', subject.split('@')[0]] : shot === 'reverse' || shot === 'push' ? ['host', sub] : shot === 'guestPush' ? ['guest', sub] : null;
    const dirty = res.notes.some((n) => n.startsWith('guard:') && n.endsWith('(not clean)'));
    // (an over-the-shoulder / reverse the guard had to move is no longer one — past a giant it ends up a tight odd
    // angle: the plain single reads better)
    const moved = (shot === 'ots' || shot === 'reverse') && res.notes.some((n) => /^guard: (alternate|front|wide|dolly|rise|search)/.test(n));
    // (a push-in on a seated guest that still cuts the face beside them in half, or still has someone in front of them /
    // looming: their single instead — clean of it, or the tight two-shot the single falls back to; a push-in pairs
    // whenever the talking single does)
    const pushCut = shot === 'guestPush' && !!spec.crowd && this.sideCuts(res.pose, spec.avoid ?? [], g.aspect).length > 0;
    const pushCrowd = shot === 'guestPush' && !!spec.crowd && this.score(res.pose, spec, g).notes.some((n) => n === 'someone in front of the subject' || n === 'someone looming in the foreground');
    if (plain && this.guardOn && (dirty || moved || pushCut || pushCrowd)) {
      // (the plain single of the same person: clean, or — nothing clean from anywhere, a guest hidden behind a giant
      // from every over-the-shoulder spot — still the better of the two: a single never puts the giant in front)
      const alt = this.solve(plain[0], plain[1], g);
      const altClean = !!alt && !alt.notes.some((n) => n.startsWith('guard:') && n.endsWith('(not clean)'));
      if (alt && (altClean || dirty) && !((pushCut || pushCrowd) && !dirty && !moved && !alt.notes.some((n) => n.includes('a tight two-shot')) && this.sideCuts(alt.pose, spec.avoid ?? [], g.aspect).length >= this.sideCuts(res.pose, spec.avoid ?? [], g.aspect).length && (!pushCrowd || this.score(alt.pose, spec, g).score >= this.score(res.pose, spec, g).score))) return { ...alt, notes: [...alt.notes, `${shot} could not be clean: the ${plain[0]} single`] };
    }
    // a seated guest's own single that can't be clean from anywhere (boxed in by the people beside them on a crowded
    // couch), or that still has someone big looming in front of them from every angle (a giant in the chair in front): a
    // tight two-shot of them + that person (else the one nearest them), from their front — a guest who talks is never
    // left on the establishing wide. Neither better: the single as it stands (it still frames them).
    const looming = !dirty && !!spec.crowd && this.score(res.pose, spec, g).notes.includes('someone looming in the foreground');
    // (or the person beside them still half in the frame — two big mascot heads side by side on a couch: no single
    // leaves the other face whole or out — the two of them)
    // (a guest / host / co-host: pairing with the sidekick beside the desk is no shot of anybody)
    const cutBy = !dirty && !looming && spec.crowd ? this.sideCuts(res.pose, (spec.avoid ?? []).filter((h) => h !== g.sidekick), g.aspect)[0]?.h ?? null : null;
    if ((dirty || looming || cutBy) && spec.crowd && (shot === 'guest' || /^guest\d+$/.test(shot))) {
      const me = g.guests[Math.max(0, /^guest\d+$/.test(shot) ? +shot.slice(5) - 1 : gi(sub))]?.seat;
      const near = me ? heads.filter((h) => h !== me && h !== g.sidekick).map((h) => ({ h, d: h.face.clone().sub(me.face).setY(0).length() }))
        .filter((x) => x.d < Math.max(1.8, (me.size + x.h.size) * 5)).sort((a, b) => a.d - b.d) : [];
      // (the one in the way: nearer the lens than them, the biggest as the lens sees it)
      const P = res.pose.position;
      const inWay = me && looming ? near.filter((x) => P.distanceTo(x.h.face) < P.distanceTo(me.face) - 0.3).sort((a, b) => b.h.size / P.distanceTo(b.h.face) - a.h.size / P.distanceTo(a.h.face))[0]?.h : null;
      const nb = inWay ?? (cutBy && near.some((x) => x.h === cutBy) ? cutBy : null) ?? near[0]?.h ?? null;
      if (me && nb) {
        const pts = [...body(me), ...body(nb)];
        const pref = me.forward.clone().multiplyScalar(0.65).addScaledVector(nb.forward, 0.35).setY(0).normalize();
        // (the subject first: their face is the one the lens must see; no further round than a three-quarter view of either)
        const pr = shoot({ targets: pts, look: me.face.clone().lerp(nb.face, 0.5).addScaledVector(UP, -0.08), prefer: pref, elev: 4, fov: 30, margin: 0.12,
          must: [me.face, nb.face], yawSpread: 32, safe: true, framed: [me, nb], family: 'two', away: 80 }, 'pair');
        if (!pr.notes.some((n) => n.startsWith('guard:') && n.endsWith('(not clean)')) && (dirty || pr.score < res.score + (cutBy ? 1.5 : 0)) && (!cutBy || !this.sideCuts(pr.pose, (spec.avoid ?? []).filter((h) => h !== nb), g.aspect).length)) return { ...pr, notes: [...pr.notes, `${shot} could not be clean: a tight two-shot with the person beside them`] };
      }
    }
    // an over-the-shoulder towards the screen with part of the picture hidden (a prop between the lens and the screen):
    // the caller's own close-up instead, a touch tighter than their plain single (so it still reads as a new angle)
    if (shot === 'ots' && !g.guests[Math.max(0, gi(subject.split('@')[0]))]?.seat && res.notes.some((n) => /^key point \d+ (hidden|behind someone)/.test(n))) {
      const alt = this.solve('guestPush', subject.split('@')[0] || 'g0', g);
      if (alt) return { ...alt, notes: [...alt.notes, 'ots: the screen was partly hidden, so the caller close-up'] };
    }
    // a multi-person shot nobody can see clean (a guest behind a giant host from every angle): none — the engine falls
    // back to the establishing shot, then to the room's own (guarded) wide shot
    if (this.guardOn && dirty && (shot === 'establishing' || shot === 'two' || shot === 'panel')) {
      // (nothing clean without the high cameras: they may be all there is)
      if (droppedHigh) return this.solve(shot, subjectIn, g, true);
      return null;
    }
    return res;
  }

  /** The framing guarantee (src/scene/frameGuard.ts) on a solved shot: the framed heads inside the family's safe area,
   *  the monitor's picture in the frame; the search's next-best candidates as fallbacks. */
  private guarded(res: ShotResult, s: Spec, g: SetGeom, people: Head[]): ShotResult {
    if (!this.guardOn || !s.family || (!s.framed?.length && !s.hardPts?.length)) return res;
    const framed = s.framed ?? [];
    const tgt = (h: Head, i: number): GuardTarget => ({ key: `h${i}`, face: { center: h.face, size: h.size }, top: h.top, forward: h.forward, ...(h.half ? { half: h.half } : {}), ...(h.depth ? { depth: h.depth } : {}) });
    const targets = framed.map(tgt);
    // everyone on the set as bodies (head sphere + torso): a guest hidden behind the host's giant head in an OTS, the
    // camera inside a giant in a reverse — the guard falls back to a clean single then
    const body = (h: Head, key: string) => ({ key, face: { center: h.face, size: h.size }, floor: h.face.clone().setY(h.floorY ?? h.face.y - Math.max(h.size * 3.5, h.top * 2.6)), height: h.floorY !== undefined ? Math.max(h.size * 2, h.face.y - h.floorY + h.top) : Math.max(h.size * 7, h.top * 5), forward: h.forward, sit: h.sit ?? true, ...(h.half ? { headHalf: h.half } : {}), ...(h.body ? { body: h.body } : {}), ...(h.head ? { head: h.head } : {}) });
    const everyone = people.map((h, i) => body(h, framed.includes(h) ? `h${framed.indexOf(h)}` : `b${i}`));
    const blockers = everyone.filter((b) => b.key.startsWith('b'));
    const alts = (s.pool ?? []).filter((x) => x.pose !== res.pose).sort((a, b) => a.score - b.score).map((x) => x.pose);
    const big = (s.framed ?? []).some((h) => h.top > 0.9 || h.size > 0.6);
    const fg = new FrameGuard(this.rays, this.probe);
    const sf = safeFor(s.family, this.safeRoom);
    // (a room's own camera: its body behind the lens is not in the picture — src/scene/frameGuard.ts lensBehindOk)
    const roomCam = res.notes.some((x) => x.startsWith('room camera'));
    const r = fg.guard(res.pose, { ...(roomCam ? { lensBehindOk: res.pose.position.clone() } : {}), family: s.family, targets: targets.length ? targets : [], hard: s.hardPts, aspect: g.aspect, blockers, motion: this.motion, safe: sf.fix, ...(s.hardStrict ? { hardSafe: sf.fix } : {}),
      rig: big ? RIGS.macro : RIGS.normal, alternates: alts, facing: framed.map((h) => h.forward), front: framed.length === 1 ? framed[0].forward : null, maxFov: 72,
      // (a single never further round than 72 deg — past that cam_eval calls it a profile; 100+ the back of the head)
      see: 0.75, away: s.away ?? (s.family === 'single' ? 72 : 115), people: everyone, openOk: g.voidOk ? 'all' : g.skyOk ? 'sky' : 'none' });
    if (r.step === 'ok' && r.clean) return res;
    return { pose: r.pose, score: res.score + (r.clean ? 0.2 : 3), notes: [...res.notes, `guard: ${r.step}${r.clean ? '' : ' (not clean)'}`, ...r.notes] };
  }

  /** Candidate search + ray scoring. */
  private search(s: Spec, g: SetGeom, shot: string): ShotResult {
    const froms = s.fromList ?? null;
    if (froms) {
      let best: ShotResult | null = null;
      for (const f0 of froms) {
        let f = f0;
        if (s.pullFrom) { const d = this.rays.hit(s.pullFrom, f0, 0.05); if (d !== Infinity) f = s.pullFrom.clone().lerp(f0, Math.max(0.35, d - 0.15) / s.pullFrom.distanceTo(f0)); }
        const r = this.search({ ...s, from: f, fromList: undefined, pullFrom: undefined }, g, shot);
        if (!best || r.score < best.score) best = r;
      }
      return best!;
    }
    const yaws = s.from ? [0] : [0, -10, 10, -20, 20, -32, 32, ...(s.yawSpread && s.yawSpread > 32 ? [-45, 45] : [])].filter((y) => Math.abs(y) <= (s.yawSpread ?? 45));
    const elevs = [s.elev, s.elev + 8, s.elev - 5];
    let best: ShotResult | null = null;
    // the room's own cameras first: those in front of the talent (the 72° cone singles keep to) scored like any candidate
    // with a small preference, then only the best two are checked hard (lensClear) — a camera
    // inside / against a prop, looking through a wall or past a camera / flight case never airs
    if (!s.from && s.lenses?.length) {
      const cands: { pose: CamPose; total: number; notes: string[]; L: THREE.Vector3 }[] = [];
      const pref = s.prefer.clone().setY(0).normalize();
      for (const L of s.lenses) {
        const dd = L.distanceTo(s.look);
        if (dd < 0.6 || dd > 25) continue;
        let pose: CamPose;
        if (s.safe) { const fp = frameFrom(L, s.targets, g.aspect, { aim: s.look, minFov: 14, maxFov: 72 }); if (!fp) continue; pose = fp; }
        // (the lens zooms to the shot's own framing from where the camera stands — a far camera is a long lens)
        else pose = lookPose(L.clone(), s.look, Math.max(8, Math.min(72, fitFov(L, s.look, s.targets, g.aspect, s.margin, 4))));
        // (a single from a far room camera that would need a longer lens than its 8° limit: the frame comes out loose — a
        // small guest seen small; scored down by how much looser, so a nearer camera frames them as asked)
        const loose = s.safe ? 0 : Math.max(0, 8 - fitFov(L, s.look, s.targets, g.aspect, s.margin, 1)) / 2;
        // (from the talent's front only — the same 72° cone singles keep to; a camera behind them, re-aimed back at
        // the set, is never a room camera's shot)
        const bear = L.clone().sub(s.look).setY(0);
        if (bear.lengthSq() < 1e-6 || bear.normalize().dot(pref) < Math.cos(72 * D2R)) continue;
        // (and from the front of the shot's first face — the host in a two-shot / the wide: never their back or profile)
        const f0 = s.framed?.[0];
        if (f0) { const b0 = L.clone().sub(f0.face).setY(0).normalize(), fw = f0.forward.clone().setY(0).normalize(); if (b0.dot(fw) < Math.cos(72 * D2R)) continue; }
        const sc = this.score(pose, s, g);
        cands.push({ pose, total: sc.score - 0.3 + loose + (pose.fov > 58 ? (pose.fov - 58) / 3 : 0) + (pose.fov < 12 ? (12 - pose.fov) / 2 : 0), notes: sc.notes, L });
      }
      cands.sort((x, y) => x.total - y.total || x.L.x - y.L.x || x.L.z - y.L.z);
      for (const c of cands.slice(0, 2)) {
        const why = this.lensClear(c.pose, s, g);
        if (why) continue;
        s.pool?.push({ pose: c.pose, score: c.total });
        if (!best || c.total < best.score) best = { pose: c.pose, score: c.total, notes: [shot, ...c.notes, `room camera at ${c.L.toArray().map((v) => v.toFixed(1)).join(',')}`] };
      }
    }
    // (count-bounded only — at most 9 yaws × 3 elevations, never timed: a slow page must pick the same shot, R3)
    for (const dy of yaws) for (const de of elevs) {
      let pose: CamPose, pulled = 0;
      if (s.from) {
        // fixed-ish position (over the shoulder / reverse): raise / lower a little, fit the lens
        const pos = s.from.clone().addScaledVector(UP, (de - s.elev) * 0.02);
        pose = lookPose(pos, s.look, fitFov(pos, s.look, s.targets, g.aspect, s.margin, s.fov));
      } else {
        const hz = s.prefer.clone().applyAxisAngle(UP, dy * D2R);
        const e = de * D2R;
        const dir = hz.multiplyScalar(Math.cos(e)).addScaledVector(UP, Math.sin(e)).normalize();
        const dist = fitDistance(s.targets, s.look, dir, s.fov, g.aspect, s.margin);
        let pos = s.look.clone().addScaledVector(dir, dist);
        let fov = s.fov;
        const hit = this.rays.hit(s.look, pos, 0.3);
        if (hit !== Infinity) {
          const d = Math.max(0.5, hit - 0.15);
          pos = s.look.clone().addScaledVector(dir, d);
          // (pulled in: what fits every target from HERE — people nearer the lens than the look point need more than the
          // proportional widening)
          fov = Math.min(72, Math.max(2 * Math.atan(Math.tan((s.fov * D2R) / 2) * (dist / d)) / D2R, fitFov(pos, s.look, s.targets, g.aspect, s.margin * 0.6)));
          pulled = fov - s.fov;
        }
        pose = lookPose(pos, s.look, fov);
        // several people: aim + lens re-fitted exactly (everyone inside the safe area, centred)
        if (s.safe) { const fp = frameFrom(pos, s.targets, g.aspect, { aim: s.look, minFov: 14, maxFov: 72 }); if (fp) { pose = fp; pulled = Math.max(0, fp.fov - s.fov); } }
      }
      const sc = this.score(pose, s, g);
      const total = sc.score + Math.abs(dy) / 30 + Math.abs(de - s.elev) / 20 + pulled / 5 + (pose.fov > 58 ? (pose.fov - 58) / 3 : 0);
      s.pool?.push({ pose, score: total });
      if (!best || total < best.score) best = { pose, score: total, notes: [shot, ...sc.notes, ...(pulled > 0 ? [`pulled +${pulled.toFixed(0)}°`] : []), `yaw ${dy} elev ${de}`] };
      if (best.score < 0.2) break;
    }
    // a wide shot's best angles looking past a prop (a studio camera, a flight case — the set's own desk / chairs /
    // monitor don't count): the best clean one instead, and the blocked ones sink in the pool the framing guarantee
    // takes its alternates from; at most 6 checked (≤ 150 rays, count-bounded)
    if (best && !s.from && s.safe && s.pool?.length) {
      const order = [...s.pool].sort((a, b) => a.score - b.score).slice(0, 6);
      let clean: { pose: CamPose; score: number } | null = null;
      for (const c of order) {
        if (this.foregroundBlocked(c.pose, s, g)) c.score += 10;
        else if (!clean) clean = c;
      }
      if (clean && clean.pose !== best.pose && order.some((c) => c.pose === best!.pose && c.score >= 10)) best = { pose: clean.pose, score: clean.score, notes: [...best.notes.filter((n) => !/^yaw |^room camera/.test(n)), 'the best angle looked past a prop: the next clean one'] };
    }
    // a seated guest's single with the person beside them half in the frame: panned off them / a touch tighter
    if (best) best = this.unCut(best, s, g);
    // someone sits in front of someone else (a big guest in the front chair): look over them from higher up, once
    if (best && !s.from && !s.lifted && best.notes.some((n) => n.endsWith('behind someone'))) {
      const up = this.search({ ...s, elev: s.elev + 16, lifted: true }, g, shot);
      if (up.score + 0.8 < best.score) {
        const lifted = { ...up, score: up.score + 0.8, notes: [...up.notes, 'lifted over someone'] };
        // (a seated guest's single goes on to the crowd retry below with it: lifted over one person, still looming
        // behind another)
        if (!s.crowd) return lifted;
        best = lifted;
      }
    }
    // a seated guest with someone in front of them / big and near in the foreground (a guest in the chair in front of the
    // couch, a neighbour leaning out): once more from further round and a little higher, and once from closer in on a
    // wider lens (in front of the person in the way); the better kept when clearly better than the first
    if (best && !s.from && s.crowd && !s.lifted && best.notes.some((n) => n === 'someone looming in the foreground' || n === 'someone in front of the subject')) {
      const round = this.search({ ...s, elev: s.elev + 6, yawSpread: 46, lifted: true }, g, shot);
      const close = this.search({ ...s, fov: Math.min(48, s.fov * 1.6), lifted: true }, g, shot);
      const r2 = close.score < round.score ? { ...close, notes: [...close.notes, 'closer in, in front of the person in the way'] } : { ...round, notes: [...round.notes, 'round the person in front of them'] };
      if (r2.score + 0.4 < best.score) return { ...r2, score: r2.score + 0.4 };
    }
    // someone's head cut by the frame edge: try a tighter lens once (a clean single beats a crowded one)
    if (best && !s.from && !s.tight && best.notes.includes('a head cut by the frame')) {
      const t = this.search({ ...s, fov: s.fov * 0.72, margin: s.margin * 0.7, tight: true }, g, shot);
      if (t.score < best.score) return t;
    }
    return best!;
  }

  /** A seated guest's single with someone else's FACE cut by a side edge of the frame (the neighbour on the couch half in
   *  frame — their face box: 0.6 face sizes / their head's half-width either side): from the SAME camera position, turn
   *  away from them (20-50 % of the half-width: they leave the frame) or towards them (their whole face in at the edge),
   *  and / or tighten the lens a touch (×0.85, ×0.72). The subject's face stays inside the middle 60 % and nearer the
   *  middle than anyone else's, their head top in the frame, and the shot no worse by the solver's own score apart from
   *  its coarse head-cut term. 18 poses at most (count-bounded). */
  private unCut(best: ShotResult, s: Spec, g: SetGeom): ShotResult {
    if (s.from || !s.crowd || s.safe) return best;
    const camOf = (pose: CamPose) => { const c = new THREE.PerspectiveCamera(pose.fov, g.aspect, 0.03, 500); c.position.copy(pose.position); c.quaternion.copy(pose.quaternion); c.updateMatrixWorld(); c.updateProjectionMatrix(); return c; };
    const cuts = (pose: CamPose) => this.sideCuts(pose, s.avoid ?? [], g.aspect).map((x) => x.side);
    const c0 = cuts(best.pose);
    if (!c0.length) return best;
    const side = Math.sign(c0.reduce((a, b) => a + b, 0)) || c0[0];
    const coarse = (sc: { score: number; notes: string[] }) => sc.score - 3 * sc.notes.filter((n) => n === 'a head cut by the frame').length;
    const b0 = this.score(best.pose, s, g), extra = best.score - b0.score, ref = coarse(b0) + extra;
    const P = best.pose.position, fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(best.pose.quaternion);
    const me = s.framed?.[0] ?? null, safeX = safeFor('single', this.safeRoom).fix.x - 0.03;
    let out: ShotResult | null = null;
    for (const k of [1, 0.85, 0.72]) for (const pan of [0.2, 0.35, 0.5, -0.2, -0.35, -0.5]) {
      const fov = best.pose.fov * k;
      // (+ turns the view to the left: a face cut at the right edge slides out to the right)
      const ang = Math.atan(pan * Math.tan((fov * D2R) / 2) * g.aspect) * side;
      const pose = lookPose(P.clone(), P.clone().add(fwd.clone().applyAxisAngle(UP, ang)), fov);
      const c = camOf(pose);
      const vm = s.must[0]?.clone().project(c);
      if (!vm || Math.abs(vm.x) > 0.6 || Math.abs(vm.y) > 0.8) continue;
      // (their face box inside the single's safe area: the framing guarantee would re-aim it back otherwise)
      if (me && Math.abs(vm.x) + Math.max(me.half ?? 0, me.size * 0.6) / Math.max(0.05, me.face.distanceTo(P)) / (Math.tan((fov * D2R) / 2) * g.aspect) > safeX) continue;
      const top = s.targets[0]?.clone().project(c);
      if (!top || top.z > 1 || Math.abs(top.x) > 0.95 || top.y > 0.95) continue;
      const off = Math.hypot(vm.x, vm.y);
      if ((s.avoid ?? []).some((h) => { const v = h.face.clone().project(c); return v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && Math.hypot(v.x, v.y) < off; })) continue;
      if (cuts(pose).length) continue;
      const sc = this.score(pose, s, g);
      const cost = Math.abs(pan) * 0.6 + (1 - k) * 1.2;
      const total = coarse(sc) + extra + cost;
      if (total > ref + 1.2) continue;
      if (!out || total < out.score) out = { pose, score: total, notes: [best.notes[0], ...sc.notes.filter((n) => n !== 'a head cut by the frame'), ...best.notes.filter((n) => /^(room camera|yaw |pulled )/.test(n)), `turned off the person beside them${k < 1 ? ', tighter' : ''}`] };
    }
    return out ?? best;
  }

  /** The faces straddling a side edge of the frame (their face box: 0.6 face sizes / their head's half-width either
   *  side), with the side (+1 right, -1 left). */
  sideCuts(pose: CamPose, heads: Head[], aspect: number): { h: Head; side: number }[] {
    const c = new THREE.PerspectiveCamera(pose.fov, aspect, 0.03, 500);
    c.position.copy(pose.position); c.quaternion.copy(pose.quaternion); c.updateMatrixWorld(); c.updateProjectionMatrix();
    const th = Math.tan((pose.fov * D2R) / 2) * aspect, out: { h: Head; side: number }[] = [];
    for (const h of heads) {
      const v = h.face.clone().project(c);
      if (v.z > 1 || Math.abs(v.y) > 1) continue;
      const rn = Math.max(h.half ?? 0, h.size * 0.6) / Math.max(0.05, h.face.distanceTo(pose.position)) / th;
      if (Math.abs(v.x) > 1 - rn && Math.abs(v.x) < 1 + rn) out.push({ h, side: Math.sign(v.x) });
    }
    return out;
  }

  /** A room camera's hard checks ('' = clean, else why not): nothing within 4 cm of the lens; nothing in the first 0.4 m
   *  of the view (9 rays: a shell / a prop right in front — the camera's own body behind the lens is fine); nothing at all
   *  — either side of any face — between the lens and each key point (a wall the renderer would cull from behind still
   *  means the camera is outside the set); and foregroundBlocked (the near view past a camera prop / a flight case). The
   *  set's own pieces (desk, chairs, the monitor housing: `setPieces`) don't count — a two-shot across the desk is the
   *  shot. Count-bounded. */
  lensClear(pose: CamPose, s: Spec, g: SetGeom): string {
    const pr = this.probe, P = pose.position;
    pr.skip = new Set(this.setPieces());
    try {
      if (pr.nearest(P, 0.04) !== null) return 'touching geometry';
      // (a shell / prop right in front of the lens: 9 rays across the view, 0.4 m — a camera body BEHIND the lens, the
      // prop the room's camera stands in, is fine)
      {
        const f0 = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
        const r0 = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion), u0 = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
        const tv = Math.tan((pose.fov * D2R) / 2), th = tv * g.aspect;
        for (const [a, b] of [[0, 0], [-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9], [0, -0.9], [0, 0.9], [-0.9, 0], [0.9, 0]]) {
          if (pr.first(P, f0.clone().addScaledVector(r0, a * th).addScaledVector(u0, b * tv).normalize(), 0.4)) return 'a shell / a prop right in front of the lens';
        }
      }
      for (const m of [...s.must, ...(s.hardPts ?? [])].slice(0, 12)) {
        const v = m.clone().sub(P), L = v.length();
        if (L < 0.2) continue;
        if (pr.first(P, v.divideScalar(L), L - 0.12)) return 'something between the lens and a key point';
      }
      return this.foregroundBlocked(pose, s, g) ? 'a prop in the foreground' : '';
    } finally { pr.skip = null; }
  }

  /** 3+ of a 5×5 grid of view rays meet something above the floor in the near part of the view (≤ 45 % of the way to the
   *  subject, ≤ 3.5 m) that isn't one of the set's own pieces: the shot is looking past a camera prop / a flight case /
   *  a speaker stack. 25 rays at most. */
  private foregroundBlocked(pose: CamPose, s: Spec, g: SetGeom): boolean {
    const pr = this.probe, P = pose.position;
    const own = !pr.skip;
    if (own) pr.skip = new Set(this.setPieces());
    try {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
      const vt = Math.tan((pose.fov * D2R) / 2), ht = vt * g.aspect;
      const subj = s.look.distanceTo(P);
      const floorY = s.framed?.[0]?.floorY ?? s.look.y - 1.6;
      let blocked = 0;
      for (const u of [-0.8, -0.4, 0, 0.4, 0.8]) for (const w of [-0.8, -0.5, -0.2, 0.15, 0.5]) {
        const d = fwd.clone().addScaledVector(right, u * ht).addScaledVector(up, w * vt).normalize();
        // (the near part of the view: ≤ 45 % of the way and ≤ 3.5 m — a wide shot's own furniture further in is the set)
        const h = pr.first(P, d, Math.max(0.3, Math.min(subj * 0.45, 3.5)));
        if (h && P.y + d.y * h.d > floorY + 0.3 && ++blocked >= 3) return true;
      }
      return false;
    } finally { if (own) pr.skip = null; }
  }
  /** The set's own pieces (set by the engine): ignored by the room-camera checks. */
  setPieces: () => Iterable<THREE.Object3D> = () => [];

  score(pose: CamPose, s: Spec, g: SetGeom): { score: number; notes: string[] } {
    const notes: string[] = [];
    let sc = 0;
    const p = pose.position;
    const cam = new THREE.PerspectiveCamera(pose.fov, g.aspect, 0.03, 500);
    cam.position.copy(p); cam.quaternion.copy(pose.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    s.must.forEach((m, i) => {
      const v = m.clone().project(cam);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) { sc += 6; notes.push(`key point ${i} out of frame`); return; }
      // (multi-person shots: a face in the outer ~15 % of the frame reads as someone half out of the shot)
      if (s.safe) { const e = Math.max(0, Math.abs(v.x) - 0.78) + Math.max(0, Math.abs(v.y) - 0.85); if (e > 0) { sc += e * 14; notes.push(`key point ${i} near the edge`); } }
      if (this.rays.hit(p, m, 0.08) !== Infinity) { sc += i === 0 ? 7 : 3; notes.push(`key point ${i} hidden`); }
      // (someone else in front of it: a big guest between the lens and the host)
      else if (s.people && s.people.some((h) => h !== ownerOf(m, s.people!) && behindPerson(p, m, h))) { sc += i === 0 ? 7 : 3; notes.push(`key point ${i} behind someone`); }
    });
    if (this.probe.inside(p)) { sc += 12; notes.push('camera inside geometry'); }
    else if (this.probe.outside(p, 5) >= 5) { sc += 9; notes.push('camera behind a wall'); }
    if (!g.voidOk) {
      let voids = 0;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
      const vt = Math.tan((pose.fov * D2R) / 2), ht = vt * g.aspect;
      for (const u of [-0.95, 0, 0.95]) for (const v of [-0.95, 0, 0.95]) {
        const d = fwd.clone().addScaledVector(right, u * ht).addScaledVector(up, v * vt).normalize();
        if (g.skyOk && d.y > -0.25) continue;                       // outdoor: the sky / horizon is drawn
        if (this.probe.drawn(p, d, 80) === null) voids += v < 0 ? 2 : 1;
      }
      if (voids) { sc += voids * 0.8; notes.push(`void ×${voids}`); }
    }
    // clutter right in front of the lens (a bean bag, a chair back, a lamp)
    {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
      const vt = Math.tan((pose.fov * D2R) / 2), ht = vt * g.aspect;
      let near = 0;
      for (const [u, v] of [[0, 0], [-0.6, -0.6], [0.6, -0.6], [-0.6, 0.5], [0.6, 0.5]]) {
        const d = fwd.clone().addScaledVector(right, u * ht).addScaledVector(up, v * vt).normalize();
        const h = this.probe.first(p, d, 0.8);
        if (h && !h.back) near++;
      }
      if (near) { sc += near * 2; notes.push(`clutter at the lens ×${near}`); }
    }
    // an empty guest chair in the middle of the frame (not hidden): the eye goes to it — keep it to the side / out
    for (const e of g.empty ?? []) {
      const v = e.clone().project(cam);
      if (v.z > 1 || Math.abs(v.x) > 0.95 || Math.abs(v.y) > 0.95) continue;
      if (this.rays.hit(p, e, 0.08) !== Infinity) continue;
      const mid = Math.max(0, 1 - Math.abs(v.x) / 0.55) * Math.max(0, 1 - Math.abs(v.y) / 0.9);
      if (mid > 0.05) { sc += mid * (s.family === 'two' ? 4 : 2.5); notes.push(`empty chair in frame ${mid.toFixed(2)}`); }
    }
    if (s.facing) {
      const dot = p.clone().sub(s.facing.c).normalize().dot(s.facing.n);
      if (dot < s.facing.min) { sc += (s.facing.min - dot) * 8; notes.push(`oblique ${dot.toFixed(2)}`); }
    }
    if (s.differ && p.distanceTo(s.differ.pos) < SAME_POS && Math.acos(Math.min(1, Math.max(-1, new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion).dot(s.differ.dir)))) / D2R < SAME_DEG) { sc += 6; notes.push('the same camera as the single'); }
    for (const h of s.avoid ?? []) {
      const rad = Math.max(h.size * 1.6, h.top);
      if (h.face.distanceTo(p) < rad * 1.3) { sc += 12; notes.push('camera inside a head'); continue; }
      const key = s.must[0];
      if (key) {
        const ray = new THREE.Ray(p, key.clone().sub(p).normalize()), q = new THREE.Vector3();
        const hit = ray.intersectSphere(new THREE.Sphere(h.face, rad), q);
        if (hit && q.distanceTo(p) < key.distanceTo(p) - 0.05) { sc += 7; notes.push('someone in front of the subject'); continue; }
      }
      // (a seated guest's single: someone's BODY big in the frame and well in front of them — a giant in the chair in front
      // of the couch, their head above the top edge — is a foreground blob too; the neighbour beside them is not)
      if (s.crowd) {
        const bc = h.face.clone().addScaledVector(UP, -h.size * 2.05), bd = bc.distanceTo(p), bv = bc.clone().project(cam);
        const br = (h.size * 1.45 / Math.max(0.05, bd)) / Math.tan((pose.fov * D2R) / 2);
        if (bv.z < 1 && br > 0.4 && Math.abs(bv.x) < 1 + br / g.aspect * 0.5 && Math.abs(bv.y) < 1 + br * 0.5 && bd < (s.must[0]?.distanceTo(p) ?? 99) - 0.5) { sc += 4; notes.push('someone looming in the foreground'); continue; }
      }
      const v = h.face.clone().project(cam);
      const dist = h.face.distanceTo(p);
      if (v.z > 1 || dist < 0.05) continue;
      // the head's radius in NDC
      const rn = (Math.max(h.size * 1.6, h.top) / dist) / Math.tan((pose.fov * D2R) / 2);
      const inX = Math.abs(v.x) - rn * 0.5 / g.aspect * 2, inY = Math.abs(v.y) - rn;
      const inside = Math.abs(v.x) < 1 + rn / g.aspect && Math.abs(v.y) < 1 + rn;
      if (!inside) continue;
      if (dist < 0.9 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1) { sc += 3; notes.push('a head right at the lens'); continue; }
      // (someone big and near — the sidekick beside the desk — filling a corner of a single: a foreground blob)
      if (rn > 0.32 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1.2 && h.face.distanceTo(p) < (s.must[0]?.distanceTo(p) ?? 99) - 0.3) { sc += 4; notes.push('someone looming in the foreground'); continue; }
      const cut = (Math.abs(v.x) > 1 - rn / g.aspect && Math.abs(v.x) < 1 + rn / g.aspect) || (Math.abs(v.y) > 1 - rn && Math.abs(v.y) < 1 + rn);
      if (cut) { sc += 3; notes.push('a head cut by the frame'); }
      void inX; void inY;
    }
    return { score: sc, notes };
  }
}

/** Tighter version of a pose around a point (snap zooms): same position, narrower lens, aimed at `at`. */
export function snapPose(from: CamPose, at: THREE.Vector3, k = 0.5): CamPose {
  return lookPose(from.position.clone(), at, Math.max(8, from.fov * k));
}
