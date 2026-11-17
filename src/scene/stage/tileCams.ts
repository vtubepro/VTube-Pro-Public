// Performer "cams" of the stage layouts (src/scene/stage/compositor.ts): one camera per performer tile, framing their
// bust (or whole body) at their seat — the same size on screen whatever their size class (a 0.3 m fairy and a 5 m kaiju
// fill their tiles alike: the framing is measured on the real face).
//
// Direction: rooms built for it (scene.json `stage.tileCams: "front"`, e.g. the Gaming Lounge) look straight at each
// seat from the front; any other room reuses the talk-shot solver's direction for that seat (validated: inside the set,
// face seen, nobody in the way — src/scene/shotSolver.ts) and dollies in along it, so the tile shows the room behind the
// performer exactly like a talk shot, just tighter. Solver shots are cached by the runtime; a new one is asked for at
// most once per frame (they cost 2–20 ms), the others use the fallback direction until theirs is known.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { lookPose, type CamPose } from '../cameraRig.ts';
import type { SpotInfo } from '../contract.ts';
import { RoomRays } from '../twoShot.ts';
import type { Framing } from '../../../shared/stage.ts';
import { FrameGuard } from '../frameGuard.ts';
import { RoomProbe } from '../shotSolver.ts';
import { FACE_BOX, rigFor, safeFor } from '../../../shared/framing.ts';
import { restTopAbove } from '../actor.ts';
import { cardLens, cardShot } from '../../../shared/flatFraming.ts';

const UP = new THREE.Vector3(0, 1, 0);
/** The steepest a 2D card's cam looks down (tan 8°): cardShot frames an upright picture from a near-level lens. */
const CARD_PITCH = Math.tan(THREE.MathUtils.degToRad(8));
/** A card cam eases this long to a new framing when the card's art is measured again (ms). */
const CARD_BLEND_MS = 500;

/** What a tile frames: the face (a TV performer's screen), its size and which way it faces. */
export interface TileSubject { center: THREE.Vector3; size: number; forward: THREE.Vector3; height: number; sit: boolean; floor: THREE.Vector3;
  /** Head top above the face centre (m): the whole head always stays in the frame. */
  top: number;
  /** A 2D card: the art it draws at the seat (world): its bottom / top, half width (it turns to the lens), the bottom
   *  centre; framed whole and bottom-anchored like a 3D body leaving the frame (shared/flatFraming.ts cardShot). */
  card?: { bottom: number; top: number; half: number; base: THREE.Vector3; bust: boolean } }

/** Hook for performer kinds without a humanoid face (walking-TV guests, S\tv\CONTRACT.md): return the SCREEN as the
 *  "face" (centre, size = screen height, facing) for that member key, or null to use the avatar's face. */
export type TileSubjectHook = (rt: SceneRuntime, key: string, spot: SpotInfo) => { center: THREE.Vector3; size: number; forward?: THREE.Vector3 } | null;
let subjectHook: TileSubjectHook | null = null;
export function setTileSubjectHook(h: TileSubjectHook | null) { subjectHook = h; }

export function tileSubject(rt: SceneRuntime, key: string): TileSubject | null {
  const a = rt.actors.get(key);
  const spot = a ? rt.seatOf(key) : null;
  if (!a || !spot) return null;
  const custom = subjectHook?.(rt, key, spot) ?? null;
  // (the DRAWN face: a mascot whose eye bones sit deep in a big head gets a tile of the face it shows — faceDepth.ts)
  const face = custom ?? a.drawnFaceAt(spot);
  const h = (a.rest?.height ?? 1.6) * a.scale;
  if (!face) return { center: spot.position.clone().setY(spot.position.y + h * (spot.pose === 'sit' ? 0.62 : 0.9)), size: Math.max(0.08, h * 0.14), forward: spot.forward.clone(), height: h, sit: spot.pose === 'sit', floor: spot.position.clone(), top: h * 0.1 };
  const r = a.rest;
  const dy = !custom && r?.drawn ? r.face.center.y - r.drawn.center.y : 0;
  const sk = custom ? 1 : a.seatedScaleAt(spot);   // (a 2D bust seated: its card grows — card.ts)
  const top = custom ? face.size * 0.6 : r ? Math.max(face.size * 1.15, (restTopAbove(r) + dy) * a.scale * sk, Math.min(((r.head?.top ?? 0) + dy) * a.scale * sk, face.size * 4)) : face.size * 1.15;
  const card = !custom ? a.cardArtAt(spot) ?? undefined : undefined;
  // (a card's head ends where its art does: a top / face box guessed from the face size reached past it, and the
  // framing guard tilted the cam up off the art's feet)
  const above = card ? Math.max(0.02, card.top - face.center.y) : 0;
  const top2 = card ? Math.min(top, above) : top, size2 = card ? Math.min(face.size, above / FACE_BOX.up) : face.size;
  return { center: face.center.clone(), size: Math.max(0.02, size2), forward: (custom?.forward ?? spot.forward).clone().setY(0).normalize(), height: h, sit: spot.pose === 'sit', floor: spot.position.clone(), top: top2, ...(card ? { card } : {}) };
}

/** A 2D card's tile pose from camera position `pos`: aim + lens solved so its art's bottom sits exactly on the bottom
 *  edge, its top under the head room and its sides in (shared/flatFraming.ts cardLens). The camera may be brought
 *  within 8 deg of level with the art and stepped back along its line when no lens there can hold it — but only to eyes
 *  `ok` accepts (the line to the art clear, not inside furniture or a person: never back through the desk that made it
 *  pull in). No such eye: it stays put and crops the art's bottom (`crop`; `cutShows`: a bust's cut edge is in view).
 *  `away` = the way back when it stands right above the art. */
function cardPose(pos: THREE.Vector3, card: NonNullable<TileSubject['card']>, aspect: number, away: THREE.Vector3 | undefined, ok: (e: { x: number; y: number; z: number }) => boolean): { pose: CamPose; crop: boolean; cutShows: boolean } {
  const L = cardLens(pos, card, aspect, card.bust, away ? { x: away.x, z: away.z } : undefined, ok);
  const eye = new THREE.Vector3(L.eye.x, L.eye.y, L.eye.z);
  const hz = new THREE.Vector3(card.base.x - eye.x, 0, card.base.z - eye.z), D = Math.max(1e-6, hz.length());
  const aim = eye.clone().addScaledVector(hz.divideScalar(D), D).add(new THREE.Vector3(0, D * Math.tan(L.pitch), 0));
  return { pose: lookPose(eye, aim, THREE.MathUtils.radToDeg(2 * Math.atan(L.tanHalf))), crop: !L.verified, cutShows: L.cutShows };
}

interface DirMemo { dir: THREE.Vector3; solved: boolean; sig: string }

export class TileCams {
  private dirs = new Map<string, DirMemo>();
  private asked = 0;
  private rays: RoomRays | null = null;
  private rt: SceneRuntime | null = null;
  private cams = new Map<string, THREE.PerspectiveCamera>();
  private clear = new Map<string, THREE.Vector3>();

  bind(rt: SceneRuntime | null) {
    if (rt === this.rt) return;
    this.rt = rt; this.dirs.clear(); this.clear.clear(); this.rays = null; this.probe = null; this.guardMemo.clear(); this.artSig.clear(); this.blend.clear(); this.lastDir.clear();
  }
  /** New frame: one uncached solver shot may be asked for. */
  frame() { this.asked = 0; }

  private front(rt: SceneRuntime) {
    const st = (rt.info as unknown as { stage?: { tileCams?: string } }).stage;
    return st?.tileCams === 'front';
  }

  /** Viewing direction (face → camera) for a performer's seat. */
  private direction(rt: SceneRuntime, key: string, s: TileSubject): THREE.Vector3 {
    const spot = rt.seatOf(key)!;
    const sig = `${spot.index}:${s.size.toFixed(3)}:${rt.rosterKey()}`;
    const m = this.dirs.get(key);
    if (m && m.sig === sig && m.solved) return m.dir;
    // fallback / 'front' rooms: straight on, turned a little towards the middle of the seats (depth, never flat)
    const toC = rt.seatsCentre().sub(s.floor).setY(0);
    const side = Math.sign(new THREE.Vector3().crossVectors(s.forward, toC).y) || 1;
    const fb = s.forward.clone().applyAxisAngle(UP, THREE.MathUtils.degToRad(this.front(rt) ? 7 : 16) * side);
    fb.y = Math.tan(THREE.MathUtils.degToRad(6));
    fb.normalize();
    if (this.front(rt)) { this.dirs.set(key, { dir: fb, solved: true, sig }); return fb; }
    if (this.asked < 1) {
      this.asked++;
      const pose = rt.talkPoseFor(key, 16 / 9);
      if (pose) {
        const d = pose.position.clone().sub(s.center);
        if (d.lengthSq() > 1e-4) { d.normalize(); this.dirs.set(key, { dir: d, solved: true, sig }); return d; }
      }
    }
    this.dirs.set(key, { dir: fb, solved: false, sig });
    return fb;
  }

  /** The camera pose for a tile of `aspect` (w / h). */
  pose(key: string, aspect: number, framing: Framing): CamPose | null {
    const rt = this.rt;
    if (!rt) return null;
    const s = tileSubject(rt, key);
    if (!s) return null;
    // (a 2D card's art measured again mid-stream — an outfit, its sliders: the cam eases to the new framing, no cut)
    if (s.card) {
      const sig = `${s.card.bottom.toFixed(3)},${s.card.top.toFixed(3)},${s.card.half.toFixed(3)}`, was = this.artSig.get(key), c = this.cams.get(key);
      if (was !== undefined && was !== sig && c) this.blend.set(key, { pos: c.position.clone(), q: c.quaternion.clone(), fov: c.fov, t0: performance.now(), checked: false });
      this.artSig.set(key, sig);
    }
    let dir = this.direction(rt, key, s);
    // (the seat's view direction changed — a re-solved shot: an outfit ease in progress ends, the cam goes there)
    const ld = this.lastDir.get(key);
    if (ld && ld.angleTo(dir) > 0.05) this.blend.delete(key);
    this.lastDir.set(key, dir.clone());
    const fov = framing === 'full' ? 32 : 28;
    const vt = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    let frameH: number, target: THREE.Vector3;
    if (s.card) {
      // a 2D card: its whole drawn art, the bottom on the frame's bottom edge (a bust's cut edge just past it), never
      // a human bust guessed from its face; a near-level lens (an upright picture seen from high up is foreshortened)
      const sh = cardShot(s.card, aspect, s.card.bust);
      frameH = sh.frameH;
      target = new THREE.Vector3(s.card.base.x, sh.centerY, s.card.base.z);
      const flat = Math.hypot(dir.x, dir.z) || 1, maxUp = CARD_PITCH;
      if (dir.y / flat > maxUp) dir = new THREE.Vector3(dir.x / flat, maxUp, dir.z / flat).normalize();
    } else if (framing === 'full') {
      const bodyTop = s.center.y + s.top + s.size * 0.25, bodyBottom = s.floor.y + (s.sit ? Math.max(0, (s.center.y - s.floor.y) * 0.05) : 0);
      frameH = Math.max((bodyTop - bodyBottom) * 1.14, (s.size * 3.2) / Math.max(0.3, aspect));
      target = new THREE.Vector3(s.center.x, (bodyTop + bodyBottom) / 2, s.center.z);
    } else {
      // bust: the whole head (top of the hair → chin) ≈ half the frame, a little head room, shoulders + upper chest;
      // bounded by the body (face measures differ wildly between models: eye-only markers vs the whole head), and narrow
      // tiles keep the shoulders in
      const head = s.top + s.size * 0.55;
      // (the upper bound never below the head itself + room: a big-headed mascot whose skeleton says "short")
      frameH = THREE.MathUtils.clamp(head / 0.5, s.height * 0.26, Math.max(s.height * 0.62, head * 1.4));
      frameH = Math.max(frameH, (head * 1.25) / Math.max(0.3, aspect));
      const frameTop = s.center.y + s.top + frameH * 0.08;
      target = new THREE.Vector3(s.center.x, frameTop - frameH / 2, s.center.z);
    }
    let dist = frameH / 2 / vt;
    this.rays ??= new RoomRays(rt.room);
    const rays = this.rays;
    // everyone else seated in the room: their head + body can stand between the face and the lens too (a big guest
    // in the next chair) — first hit distance along face → lens, room or person
    const others = [...rt.actors.keys()].filter((k) => k !== key).map((k) => tileSubject(rt, k)).filter((o): o is TileSubject => !!o);
    const hitAny = (to: THREE.Vector3) => {
      let h = rays.hit(s.center, to, 0.1);
      const d = to.clone().sub(s.center), L = d.length();
      if (L < 1e-4) return h;
      const ray = new THREE.Ray(s.center, d.divideScalar(L)), q = new THREE.Vector3();
      for (const o of others) {
        const w = o.size * 1.05;
        const sph = new THREE.Sphere(o.center.clone().addScaledVector(UP, o.size * 0.15), o.size * 0.72);
        const box = new THREE.Box3(new THREE.Vector3(o.center.x - w, o.center.y - o.size * 3.5, o.center.z - w), new THREE.Vector3(o.center.x + w, o.center.y - o.size * 0.6, o.center.z + w));
        for (const hit of [ray.intersectSphere(sph, q) ? q.distanceTo(s.center) : Infinity, ray.intersectBox(box, q) ? q.distanceTo(s.center) : Infinity]) if (hit > 0.05 && hit < L && hit < h) h = hit;
      }
      return h;
    };
    // something between the face and the lens (a desk in front of a low TV, a shelf, someone): look for a clear line
    // nearby — higher (over it), then a little to the sides — before pulling the camera in (cached per seat / distance)
    const ck = `${key}|${Math.round(dist * 20)}|${s.center.toArray().map((v) => Math.round(v * 50)).join(',')}|${rt.rosterKey()}`;
    let best = this.clear.get(ck);
    if (!best) {
      best = dir;
      if (hitAny(target.clone().addScaledVector(dir, dist)) !== Infinity) {
        let far = -1;
        const side = new THREE.Vector3().crossVectors(UP, dir).normalize();
        // (a 2D card: never steeper than CARD_PITCH — an upright picture seen from above is foreshortened and leaves its
        // shot; round the side instead, else pull in along the shallow line below)
        for (const up of s.card ? [4, 8, 0] : [10, 20, 32, 45, 0]) for (const yaw of [0, -18, 18, -32, 32, -45, 45]) {
          if (up === 0 && yaw === 0) continue;
          const d = dir.clone().applyAxisAngle(side, -THREE.MathUtils.degToRad(up)).applyAxisAngle(UP, THREE.MathUtils.degToRad(yaw)).normalize();
          if (d.y > 0.8 || (s.card && d.y / Math.max(1e-6, Math.hypot(d.x, d.z)) > CARD_PITCH + 1e-6)) continue;
          const h = hitAny(target.clone().addScaledVector(d, dist));
          if (h === Infinity) { best = d; far = Infinity; break; }
          if (h > far) { far = h; best = d; }
        }
        if (far !== Infinity && hitAny(target.clone().addScaledVector(dir, dist)) >= far) best = dir;
      }
      if (this.clear.size > 64) this.clear.clear();
      this.clear.set(ck, best);
    }
    let pos = target.clone().addScaledVector(best, dist);
    // keep the camera inside the set (a wall behind it — for a 2D card also a desk / a person in the way, as it never
    // climbs over them): pull in and widen the lens to keep the framing
    const hit = s.card ? Math.min(this.rays.hit(s.center, pos, 0.1), hitAny(pos)) : this.rays.hit(s.center, pos, 0.1);
    let f = fov;
    if (hit !== Infinity) {
      const d = Math.max(s.size * 1.2, hit - 0.12);
      if (d < dist) { f = Math.min(80, 2 * THREE.MathUtils.radToDeg(Math.atan(vt * dist / d))); dist = d; pos = target.clone().addScaledVector(best, dist); }
    }
    if (s.card) {
      const ok = this.eyeOk(rt, s, others, hitAny);
      const cp = cardPose(pos, s.card, aspect, best, ok);
      this.cropNote(rt, key, s, cp);
      return this.guarded(rt, key, s, cp.pose, aspect, framing, ok);
    }
    return this.guarded(rt, key, s, lookPose(pos, target, f), aspect, framing);
  }

  /** Where a 2D card's camera may stand: the line from it to the art (its middle and the face) clear of the room and
   *  everyone else, not inside furniture / a wall, not inside another performer. */
  private eyeOk(rt: SceneRuntime, s: TileSubject, others: TileSubject[], hitAny: (to: THREE.Vector3) => number) {
    this.rays ??= new RoomRays(rt.room);
    this.probe ??= new RoomProbe(rt.room);
    const rays = this.rays, probe = this.probe, card = s.card!;
    const mid = new THREE.Vector3(card.base.x, (card.bottom + card.top) / 2, card.base.z);
    return (e: { x: number; y: number; z: number }) => {
      const v = new THREE.Vector3(e.x, e.y, e.z);
      if (hitAny(v) !== Infinity || !rays.clear(mid, v) || probe.inside(v)) return false;
      for (const o of others) {
        const w = o.size * 1.05;
        if (v.distanceTo(o.center.clone().addScaledVector(UP, o.size * 0.15)) < o.size * 0.72) return false;
        if (Math.abs(v.x - o.center.x) < w && Math.abs(v.z - o.center.z) < w && v.y > o.center.y - o.size * 3.5 && v.y < o.center.y - o.size * 0.6) return false;
      }
      return true;
    };
  }
  /** A card cam that had to stay pulled in and crop: a bust's cut edge in view there is faded (FlatAvatar.cutFadeUntil),
   *  and it is said once in the log. */
  private cropNote(rt: SceneRuntime, key: string, s: TileSubject, cp: { crop: boolean; cutShows: boolean }) {
    if (!cp.crop) return;
    const fl = rt.actors.get(key)?.runtime?.flat as { cutFadeUntil?: number } | null | undefined;
    if (fl && cp.cutShows) fl.cutFadeUntil = performance.now() + 600;
    const sig = `${key}|${s.card!.bottom.toFixed(2)}|${s.card!.top.toFixed(2)}`;
    if (!this.cropLogged.has(sig)) { this.cropLogged.add(sig); console.info(`[tile] ${key}: no clear place far enough back for the whole 2D avatar; its cam stays close and crops the bottom${cp.cutShows ? ' (cut edge faded)' : ''}`); }
  }
  private cropLogged = new Set<string>();

  /** The framing guarantee (src/scene/frameGuard.ts): the tile's face box + head inside the tile's safe area (a narrow
   *  tile, a giant's head, a pulled-in camera); cached per pose. A 2D card (`ok`: its clearance test): the guard's pose
   *  is re-aimed for the card only from an eye that passes that test; otherwise the guard's own pose is kept (its rise
   *  may look down more than 8 deg: better than back into the desk). */
  private guarded(rt: SceneRuntime, key: string, s: TileSubject, pose: CamPose, aspect: number, framing: Framing, ok?: (e: { x: number; y: number; z: number }) => boolean): CamPose {
    if (!rt.framing.guard) return pose;
    // (the motion envelope is part of the key: a battle starting re-guards the same pose with its deck-kick margin)
    const mo = rt.motionFor('tile');
    const ck = `${key}|${pose.position.toArray().map((v) => v.toFixed(3))}|${pose.fov.toFixed(2)}|${aspect.toFixed(3)}|${framing}|${rt.motionSig('tile')}`;
    const hit = this.guardMemo.get(ck);
    if (hit) return hit;
    this.rays ??= new RoomRays(rt.room);
    this.probe ??= new RoomProbe(rt.room);
    const a = rt.actors.get(key);
    // (the tile must also SEE the face: past the room and everyone else, never into the void)
    const people = [...rt.actors.keys()].map((k) => rt.subjectFor(k)).filter((p): p is NonNullable<typeof p> => !!p);
    const depth = people.find((p) => p.key === key)?.depth;
    const g = new FrameGuard(this.rays, this.probe).guard(pose, { family: 'tile', targets: [{ key, face: { center: s.center, size: s.size }, top: s.top, forward: s.forward, ...(depth ? { depth } : {}) }], aspect, safe: safeFor('tile', rt.framing.safe).fix,
      motion: mo, rig: rigFor(a ? rt.classOf(a) : 'normal', rt.framing.rigs ?? undefined), maxFov: 80,
      ...(people.length ? { see: 0.75, people, blockers: people.filter((p) => p.key !== key), openOk: rt.openOk } : {}) });
    // (a 2D card: its shot already holds the whole art, face included — a guard that only re-aimed / re-lensed from the
    // same place is dropped; one that MOVED the camera to see past someone keeps that place, re-aimed for the art when
    // the place passes the clearance test and the re-aim needs no further move, else the guard's pose as it is)
    let out = g.step === 'best-effort' ? pose : g.pose;
    if (s.card && g.step !== 'best-effort') {
      const gp = g.pose.position;
      if (gp.distanceTo(pose.position) < 1e-3) out = pose;
      else if (ok?.(gp)) {
        const cp = cardPose(gp, s.card, aspect, s.forward, (e) => Math.hypot(e.x - gp.x, e.y - gp.y, e.z - gp.z) < 1e-6);
        out = cp.crop ? g.pose : cp.pose;
      }
    }
    if (this.guardMemo.size > 64) this.guardMemo.clear();
    this.guardMemo.set(ck, out);
    return out;
  }
  private guardMemo = new Map<string, CamPose>();
  private probe: RoomProbe | null = null;

  private artSig = new Map<string, string>();
  private blend = new Map<string, { pos: THREE.Vector3; q: THREE.Quaternion; fov: number; t0: number; checked: boolean }>();
  private lastDir = new Map<string, THREE.Vector3>();
  /** A pooled camera for a tile. */
  camera(key: string, pose: CamPose, aspect: number, far: number): THREE.PerspectiveCamera {
    let c = this.cams.get(key);
    if (!c) { c = new THREE.PerspectiveCamera(pose.fov, aspect, 0.03, far); this.cams.set(key, c); }
    c.position.copy(pose.position); c.quaternion.copy(pose.quaternion);
    c.fov = pose.fov; c.aspect = aspect; c.near = 0.02; c.far = far;
    let b = this.blend.get(key);
    // (an ease whose straight path goes through the room cuts instead — like the room camera, SceneRuntime.updateCamera)
    if (b && !b.checked) { b.checked = true; if (this.rays && b.pos.distanceTo(pose.position) > 0.05 && !this.rays.clear(b.pos, pose.position)) { this.blend.delete(key); b = undefined; } }
    if (b) {
      const u = Math.min(1, (performance.now() - b.t0) / CARD_BLEND_MS), k = 1 - (1 - u) ** 3;   // (ease-out: let a wider outfit in quickly)
      c.position.lerpVectors(b.pos, pose.position, k); c.quaternion.slerpQuaternions(b.q, pose.quaternion, k); c.fov = b.fov + (pose.fov - b.fov) * k;
      if (u >= 1) this.blend.delete(key);
    }
    c.updateProjectionMatrix(); c.updateMatrixWorld(true);
    return c;
  }
  forget(keys: Set<string>) { for (const k of [...this.cams.keys()]) if (!keys.has(k)) { this.cams.delete(k); this.blend.delete(k); this.artSig.delete(k); this.lastDir.delete(k); } }
}

/** Convenience for other modes (e.g. an interview "guest monitor"): a pose framing one performer at their seat. */
export function tilePose(rt: SceneRuntime, key: string, aspect: number, framing: Framing = 'bust'): CamPose | null {
  const t = new TileCams();
  t.bind(rt);
  return t.pose(key, aspect, framing);
}
