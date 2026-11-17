// The table's auto-director (SceneRuntime.cameraOverride while a TTRPG session runs): cuts on who is speaking
// (performers' voice levels on this page, the GM's line), cuts to CAM_DICE for every throw (crits push in), shows the
// map in combat, the handout when one appears, and rests on the wide shot. The host can pin a shot (state.cam).
// Each OBS page directs from what it hears — cuts on a guest's page may differ by a few frames; throws are exact.
import * as THREE from 'three';
import type { SceneRuntime } from '../../scene/SceneRuntime.ts';
import type { CamPose } from '../../scene/cameraRig.ts';
import { lookPose } from '../../scene/cameraRig.ts';
import { FrameGuard, targetOf, type GuardTarget } from '../../scene/frameGuard.ts';
import { RoomProbe } from '../../scene/shotSolver.ts';
import { RoomRays } from '../../scene/twoShot.ts';
import { rigFor, safeFor } from '../../../shared/framing.ts';
import type { SceneTtrpgState } from '../../../shared/ttrpg/state.ts';
import type { TtrpgAnchors } from './anchors.ts';

export interface DirectorInput {
  st: SceneTtrpgState;
  now: number;
  /** Member key → voice level 0..1 (this page's view of everyone's mouth / voice). */
  speaking: Map<string, number>;
  gmSpeaking: boolean;
  gmLineAge: number;
  gmFace: THREE.Vector3;
  gmFaceSize: number;
  /** Height (m) the GM close-up should show. */
  gmShotH: number;
  diceActive: boolean;
  diceCrit: 'hi' | 'lo' | null;
  diceSettled: number;
  diceCenter: THREE.Vector3 | null;
  handoutAge: number;
  combat: boolean;
}
export type Shot = { key: string; pose: CamPose; secs: number };

const MIN_HOLD = 2200, SPEAK_ON = 0.35, SPEAK_MIN = 450;

export class TableDirector {
  shot = 'wide';
  since = 0;
  private talk = new Map<string, number>();
  private lastSpeaker = '';
  /** Debug: why the current shot was chosen. */
  why = '';

  constructor(private rt: SceneRuntime, private a: TtrpgAnchors) {}

  private pose(name: 'wide' | 'map' | 'gm' | 'dice' | 'handout', i: DirectorInput, aspect: number): CamPose | null {
    const c = this.a.cams;
    switch (name) {
      case 'wide': {
        // the room's wide shot, unless someone sits / stands right in front of its lens (a big performer in the front
        // row, a kibitzer) — then the framing solver's group shot, which keeps everyone's face clear; a face on the
        // fringe of the authored wide: re-aimed / widened from the same spot (framing guarantee), else the group shot
        if (c.wide && !this.crowded(c.wide, aspect)) return this.guardTable(c.wide, aspect) ?? this.rt.resolveCamera('group', aspect).pose;
        return this.rt.resolveCamera('group', aspect).pose;
      }
      case 'map': {
        if (c.top) return c.top;
        const m = this.a.map; if (!m) return null;
        const ctr = m.at(0.5, 0.5), span = Math.max(m.width, m.height * aspect);
        const fov = 40, d = (span * 0.6) / Math.tan(THREE.MathUtils.degToRad(fov / 2)) / aspect * 1.05;
        const back = m.dv.clone().multiplyScalar(-d * 0.25);
        return lookPose(ctr.clone().addScaledVector(m.normal, d).add(back), ctr, fov);
      }
      case 'gm': {
        // framed on the GM as it actually is (a prop on the table edge, a figure in the chair, a glow): CAM_GM only
        // gives the side to look from, the distance comes from the GM's size
        const f = i.gmFace;
        const from = c.gm?.position ?? this.a.table?.position ?? f.clone().add(new THREE.Vector3(0, 0, 1));
        const dir = from.clone().sub(f); dir.y = Math.max(-0.2, Math.min(0.45, dir.y / Math.max(0.01, dir.length())));
        dir.normalize();
        const fov = 30;
        const dist = THREE.MathUtils.clamp(i.gmShotH / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2))), 0.7, 3.5);
        return lookPose(f.clone().addScaledVector(dir, dist), f.clone().add(new THREE.Vector3(0, -i.gmFaceSize * 0.15, 0)), fov);
      }
      case 'dice': {
        const t = this.a.tray; if (!t) return null;
        const ctr = i.diceCenter ?? t.position;
        if (c.dice) return this.overRim(c.dice, t.position, Math.min(t.w, t.d));
        const d = Math.max(t.w, t.d) * 1.6;
        const side = t.forward.clone().negate();
        return lookPose(ctr.clone().addScaledVector(side, d * 0.7).add(new THREE.Vector3(0, d * 0.95, 0)), ctr, 34);
      }
      case 'handout': {
        if (c.handout) return c.handout;
        const h = this.a.handout; if (!h) return null;
        const ctr = h.at(0.5, 0.5), d = Math.max(h.width, h.height) * 1.5;
        return lookPose(ctr.clone().addScaledVector(h.normal, d), ctr, 35);
      }
    }
  }

  private crowd = { key: '', at: 0, v: false };
  /** A performer's head (with hair / ears: ~1.8 × the face) fills the middle of this camera's frame (≥ 40 % of the
   *  frame height, centre third)? Re-checked ~1 s. */
  private crowded(p: CamPose, aspect: number): boolean {
    const now = performance.now();
    const sig = [...this.rt.actors.values()].map((a) => `${a.key}:${a.spot?.index ?? '-'}`).join(',');
    if (this.crowd.key === sig && now - this.crowd.at < 1000) return this.crowd.v;
    const cam = new THREE.PerspectiveCamera(p.fov, aspect, 0.05, 100);
    cam.position.copy(p.position); cam.quaternion.copy(p.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    let v = false;
    for (const a of this.rt.actors.values()) {
      if (!a.shown || !a.spot) continue;
      const f = a.drawnFaceAt(a.spot);
      if (!f) continue;
      const d = f.center.distanceTo(p.position), q = f.center.clone().project(cam);
      const span = (f.size * 1.8) / Math.max(0.05, d) / Math.tan(THREE.MathUtils.degToRad(p.fov / 2));   // (NDC half-heights)
      if (q.z < 1 && span > 0.4 && Math.abs(q.x) < 0.6 && Math.abs(q.y) < 0.8) { v = true; break; }
    }
    this.crowd = { key: sig, at: now, v };
    return v;
  }

  private seatCache = new Map<string, { sig: string; at: number; pose: CamPose | null; how: string }>();
  /** Debug: how the last seat close-ups were found (room / solver shot, or a clear angle the table director picked). */
  seatInfo: Record<string, string> = {};
  /** A performer's close-up: the room's talk shot (CAM_SEAT_xx / SPOT_xx_CAM / the framing solver) when their face is
   *  clear from it; else a clear angle from the table side (people at a crowded table — a kibitzer standing behind
   *  the chairs, a walking-TV guest whose "face" is its screen). Re-checked when people move / every 2 s. */
  private seat(key: string, aspect: number): CamPose | null {
    const a = this.rt.actors.get(key);
    if (!a?.spot) return null;
    const now = performance.now();
    // (their shown size too: a performer who grows / shrinks in the chair needs a new close-up at once)
    const sig = [...this.rt.actors.values()].map((x) => `${x.key}:${x.spot?.index ?? '-'}:${x.shown ? 1 : 0}:${x.scale.toFixed(3)}:${this.rt.classOf(x)}`).join(',') + `|${aspect.toFixed(2)}`;
    const c = this.seatCache.get(key);
    if (c && c.sig === sig && now - c.at < 2000) return c.pose;
    // the room's own talk shot for that performer (validated, or the automatic bust)
    const saved = this.rt.state;
    let base: CamPose | null;
    try { this.rt.state = { ...saved, focus: key }; base = this.rt.resolveCamera('talk', aspect).pose; }
    finally { this.rt.state = saved; }
    // (the DRAWN face at the seat: a mascot whose eye bones sit deep in a big head is framed on the face it shows, and
    // every page frames the same — src/scene/faceDepth.ts)
    const f0 = a.drawnFaceAt(a.spot);
    const f = f0 ? { center: f0.center, size: f0.size } : null;
    let pose = base, how = 'room';
    // (a close-up: the room's shot is fine when it sees the face and isn't from across the room)
    const near = f && base ? base.position.distanceTo(f.center) <= Math.max(2.4, f.size * 8) && this.lensClear(base.position, f.center) : true;
    if (f && base && (!near || !this.faceClear(base.position, f, a))) {
      how = near ? 'blocked' : 'far';
      // from the front of the performer (the way their spot faces: the table for a seat, maybe the room for a kibitzer)
      const toT = a.spot.forward.clone().setY(0);
      if (toT.lengthSq() < 1e-4) toT.copy((this.a.table?.position ?? this.rt.room.bounds.getCenter(new THREE.Vector3())).clone().sub(f.center).setY(0));
      toT.normalize();
      const fov = 30, dist = THREE.MathUtils.clamp((f.size * 3.6) / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2))), 0.6, 1.9);
      const up = new THREE.Vector3(0, 1, 0);
      // the most visible angle from the front half (never the side / back of a TV), closest to straight-on first
      let bestSeen = -1;
      search: for (const k of [1, 0.72, 0.5]) for (const lift of [0.12, 0.4, 0.75, 1.1]) for (const ang of [0, 20, -20, 40, -40]) {
        const dir = toT.clone().applyAxisAngle(up, THREE.MathUtils.degToRad(ang));
        const P = f.center.clone().addScaledVector(dir, dist * k).add(new THREE.Vector3(0, lift, 0));
        if (!this.roomClear(f.center, P) || !this.lensClear(P, f.center)) continue;
        const seen = this.faceSeen(P, f, a);
        if (seen > bestSeen) { bestSeen = seen; pose = lookPose(P, f.center.clone().add(new THREE.Vector3(0, -f.size * 0.35, 0)), fov); how = `clear ${ang}° +${lift}${k < 1 ? ' close' : ''} (${seen}/7)`; }
        if (seen === 7) break search;
      }
      if (bestSeen < 4) { pose = base; how += ' → room shot'; }
    }
    // (framing guarantee: the close-up's face box + head inside the safe area — a clear angle aims at the face only; the
    // drawn face at the seat, never the live one: every page (and a reloaded OBS source) must solve the same close-up;
    // the guard's lean / depth slack covers a head a few cm off its rest pose)
    if (pose && f && this.rt.framing.guard) {
      const people = this.people();
      const g = this.guard().guard(pose, { family: 'ttrpg', targets: [this.targetOf(key, f)], aspect, motion: this.rt.motionFor('ttrpg'), rig: rigFor(this.rt.classOf(a), this.rt.framing.rigs ?? undefined),
        safe: safeFor('ttrpg', this.rt.framing.safe).fix, see: 0.75, away: 100, people, blockers: people.filter((p) => p.key !== key), openOk: this.rt.openOk });
      if (g.step !== 'ok' && g.step !== 'best-effort') { pose = g.pose; how += ` · guard ${g.step}`; }
      // (no clean close-up from the table side — a giant's head too big for the gap: the room's own talk shot, which the
      // solver frames from anywhere in the room)
      else if (g.step === 'best-effort' && base && pose !== base) { pose = base; how += ' · guard: the room talk shot'; }
    }
    this.seatInfo[key] = how;
    this.seatCache.set(key, { sig, at: now, pose, how });
    return pose;
  }

  private fg: FrameGuard | null = null;
  /** Everyone at the table as the framing solver sees them (who can hide a face, a mech's hull). */
  private people() { return [...this.rt.actors.values()].filter((x) => x.shown && x.spot).map((x) => this.rt.subjectFor(x.key)).filter((s): s is NonNullable<typeof s> => !!s); }
  private guard(): FrameGuard { return (this.fg ??= new FrameGuard(new RoomRays(this.rt.room), new RoomProbe(this.rt.room))); }
  private targetOf(key: string, f: { center: THREE.Vector3; size: number }): GuardTarget {
    // (the runtime's own subject: real head, a mech framed on its pilot — with the face given here)
    const sub = this.rt.subjectFor(key);
    if (sub) { const t = targetOf(sub); return { ...t, face: f, top: Math.max(f.size * 1.15, t.top) }; }
    const a = this.rt.actors.get(key), r = a?.rest;
    const top = r && a ? Math.max(f.size * 1.15, Math.min((r.head?.top ?? (r.floorY + r.height - r.face.center.y)) * a.scale, f.size * 4)) : f.size * 1.15;
    return { key, face: f, top, ...(r?.head && a ? { half: Math.min(r.head.half * a.scale, f.size * 3) } : {}) };
  }
  private wideMemo = new Map<string, CamPose | null>();
  /** The table's authored wide with every seated face inside the wide safe area (cached per roster). null = it can't be
   *  fixed from there (the caller uses the group shot). */
  private guardTable(p: CamPose, aspect: number): CamPose | null {
    if (!this.rt.framing.guard) return p;
    const people = [...this.rt.actors.values()].filter((a) => a.shown && a.spot);
    const sig = `${people.map((a) => `${a.key}:${a.spot!.index}:${a.scale.toFixed(3)}:${this.rt.classOf(a)}`).join(',')}|${aspect.toFixed(3)}|${p.position.toArray().map((v) => v.toFixed(2))}|${this.rt.motionSig('ttrpg')}`;
    if (this.wideMemo.has(sig)) return this.wideMemo.get(sig)!;
    const targets = people.map((a) => { const f = a.drawnFaceAt(a.spot!); return f ? this.targetOf(a.key, { center: f.center, size: f.size }) : null; }).filter((t): t is GuardTarget => !!t);
    const ppl = this.people();
    const g = this.guard().guard(p, { family: 'wide', targets, aspect, motion: this.rt.motionFor('ttrpg'), maxFov: 75, safe: safeFor('wide', this.rt.framing.safe).fix, see: 0.75, people: ppl, blockers: ppl, openOk: this.rt.openOk });
    // (someone hidden from the authored wide — a giant in the front row — or no clean frame: the solver's group shot)
    const out = g.step === 'best-effort' || !g.clean ? null : g.pose;
    if (this.wideMemo.size > 32) this.wideMemo.clear();
    this.wideMemo.set(sig, out);
    return out;
  }

  private rim = new Map<CamPose, CamPose>();
  /** The dice shot must see the tray floor: when the tray's own wall (a crate, a pot) hides it from CAM_DICE, the camera
   *  rises around the tray to a steeper angle until it does (≤ 70°). Cached per preset. */
  private overRim(p: CamPose, floor: THREE.Vector3, size: number): CamPose {
    const hit = this.rim.get(p);
    if (hit) return hit;
    const f = floor.clone().add(new THREE.Vector3(0, 0.025, 0));
    // the floor's centre and the strip along the near wall (where dice often come to rest)
    const toCam = p.position.clone().sub(f).setY(0).normalize(), side = new THREE.Vector3(-toCam.z, 0, toCam.x);
    const pts = [f, f.clone().addScaledVector(toCam, size * 0.32), f.clone().addScaledVector(toCam, size * 0.32).addScaledVector(side, size * 0.3), f.clone().addScaledVector(toCam, size * 0.32).addScaledVector(side, -size * 0.3)];
    const seen = (P: THREE.Vector3) => pts.every((q) => this.roomClear(q, P));
    let out = p;
    if (!seen(p.position)) {
      const d = p.position.clone().sub(f), L = d.length(), flat = Math.hypot(d.x, d.z) || 1;
      for (let deg = Math.asin(THREE.MathUtils.clamp(d.y / L, -1, 1)) / (Math.PI / 180) + 8; deg <= 70; deg += 6) {
        const el = THREE.MathUtils.degToRad(deg);
        const pos = f.clone().add(new THREE.Vector3((d.x / flat) * Math.cos(el) * L, Math.sin(el) * L, (d.z / flat) * Math.cos(el) * L));
        out = lookPose(pos, floor, p.fov);
        if (seen(pos)) break;
      }
    }
    this.rim.set(p, out);
    return out;
  }
  /** Nothing right against the lens (a camera inside a shelf of bottles, behind a bar): 5 rays from P towards the
   *  subject (centre + a cone of ±12°) meet no room mesh within 0.35 m. */
  private lensClear(P: THREE.Vector3, target: THREE.Vector3): boolean {
    if (!this.roomMeshes) this.roomClear(P, target);
    const fwd = target.clone().sub(P).normalize(), up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    this.ray.near = 0; this.ray.far = 0.35;
    for (const [x, y] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const d = fwd.clone().addScaledVector(right, x * 0.21).addScaledVector(up, y * 0.21).normalize();
      this.ray.set(P, d);
      if (this.ray.intersectObjects(this.roomMeshes!, false).length) return false;
    }
    return true;
  }
  private handoutVis = { at: 0, v: true };
  /** The handout easel / board isn't hidden behind performers (else the handout stays a 2D card on the overlay). */
  private handoutSeen(i: DirectorInput, aspect: number): boolean {
    const now = performance.now();
    if (now - this.handoutVis.at < 1500) return this.handoutVis.v;
    const h = this.a.handout, p = this.pose('handout', i, aspect);
    const v = !h || !p || this.faceSeen(p.position, { center: h.at(0.5, 0.5), size: Math.min(h.width, h.height) * 0.9 }, { key: '' }) >= 5;
    this.handoutVis = { at: now, v };
    return v;
  }
  private ray = new THREE.Raycaster();
  private roomMeshes: THREE.Object3D[] | null = null;
  /** Nothing of the room (walls, furniture, props — every visible mesh) between two points. Tested both ways: rooms
   *  are built from one-sided faces, so a wall seen from outside only counts on the way back in. */
  private roomClear(a: THREE.Vector3, b: THREE.Vector3): boolean {
    if (!this.roomMeshes) { const out: THREE.Object3D[] = []; this.rt.room.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible) out.push(o); }); this.roomMeshes = out; }
    const d = b.clone().sub(a), L = d.length();
    if (L < 0.1) return true;
    d.divideScalar(L);
    this.ray.near = 0.05; this.ray.far = L - 0.05;
    this.ray.set(a, d);
    if (this.ray.intersectObjects(this.roomMeshes, false).length) return false;
    this.ray.set(b, d.negate());
    return this.ray.intersectObjects(this.roomMeshes, false).length === 0;
  }
  /** How many of 7 points of the face (centre, cheeks, brow, chin, lower corners — a TV's whole screen) are seen from P
   *  past the room and the other
   *  performers (head sphere + torso box each, a little wider than the solver's so big avatars count). */
  private faceClear(P: THREE.Vector3, f: { center: THREE.Vector3; size: number }, self: { key: string }): boolean { return this.faceSeen(P, f, self) >= 6; }
  private faceSeen(P: THREE.Vector3, f: { center: THREE.Vector3; size: number }, self: { key: string }): number {
    const others: { head: THREE.Sphere; body: THREE.Box3 }[] = [];
    for (const o of this.rt.actors.values()) {
      if (o.key === self.key || !o.shown || !o.spot) continue;
      const of = o.faceAt(o.spot);
      if (!of) continue;
      const w = Math.max(of.size * 1.3, 0.2 * o.scale);
      const top = of.center.y - of.size * 0.55, bot = o.spot.pose === 'sit' ? top - o.height * 0.38 : o.spot.position.y;
      others.push({ head: new THREE.Sphere(of.center, of.size * 0.8), body: new THREE.Box3(new THREE.Vector3(of.center.x - w, bot, of.center.z - w), new THREE.Vector3(of.center.x + w, top, of.center.z + w)) });
    }
    let seen = 0;
    const hit = new THREE.Vector3();
    const right = new THREE.Vector3().crossVectors(f.center.clone().sub(P), new THREE.Vector3(0, 1, 0)).normalize();
    for (const [x, y] of [[0, 0], [-0.4, 0], [0.4, 0], [0, 0.4], [0, -0.45], [-0.4, -0.45], [0.4, -0.45]]) {
      const q = f.center.clone().addScaledVector(right, x * f.size).add(new THREE.Vector3(0, y * f.size, 0));
      const d = q.clone().sub(P), L = d.length();
      const r = new THREE.Ray(P, d.clone().divideScalar(L));
      const blocked = others.some((o) => (r.intersectSphere(o.head, hit) && hit.distanceTo(P) < L - 0.05) || (r.intersectBox(o.body, hit) && hit.distanceTo(P) < L - 0.05));
      if (!blocked && this.roomClear(q, P)) seen++;
    }
    return seen;
  }

  decide(i: DirectorInput, aspect: number): Shot | null {
    const now = i.now;
    // who is speaking (debounced: ≥ 0.45 s above the threshold)
    for (const [k, v] of i.speaking) { if (v > SPEAK_ON) { if (!this.talk.has(k)) this.talk.set(k, now); } else this.talk.delete(k); }
    for (const k of [...this.talk.keys()]) if (!i.speaking.has(k)) this.talk.delete(k);
    const talkers = [...this.talk.entries()].filter(([, t0]) => now - t0 > SPEAK_MIN).sort((a, b) => a[1] - b[1]);
    const held = now - this.since;
    let want = 'wide', why = 'idle';
    const pin = i.st.cam;
    if (pin && pin !== 'auto') { want = pin === 'seat' ? `seat:${i.st.camWho ?? '@host'}` : pin; why = 'pinned'; }
    else if (i.diceActive) { want = i.diceCrit && i.diceSettled > 0.1 ? 'dice:crit' : 'dice'; why = 'dice'; }
    else if (i.handoutAge >= 0 && i.handoutAge < 5 && (this.a.cams.handout || this.a.handout) && this.handoutSeen(i, aspect)) { want = 'handout'; why = 'handout'; }
    else if (talkers.length) {
      // keep the current speaker while they talk; else the one who started first
      const cur = this.shot.startsWith('seat:') ? this.shot.slice(5) : '';
      const pick = talkers.find(([k]) => k === cur)?.[0] ?? talkers.find(([k]) => k !== this.lastSpeaker)?.[0] ?? talkers[0][0];
      want = `seat:${pick}`; why = 'speaker';
    } else if (i.gmSpeaking) {
      // GM narration: the GM first, then the table / map so long lines aren't one static shot
      const phase = Math.floor(Math.max(0, i.gmLineAge - 4.5) / 6);
      want = i.gmLineAge < 4.5 ? 'gm' : (phase % 2 === 0 ? (i.combat ? 'map' : 'wide') : 'gm');
      why = 'gm';
    } else if (i.combat) { want = Math.floor(now / 8000) % 2 ? 'map' : 'wide'; why = 'combat'; }
    // hold shots a moment (dice + pins cut at once)
    if (want !== this.shot && why !== 'dice' && why !== 'pinned' && held < MIN_HOLD && !this.shot.startsWith('dice')) want = this.shot;
    if (want !== this.shot) { if (this.shot.startsWith('seat:')) this.lastSpeaker = this.shot.slice(5); this.shot = want; this.since = now; this.why = why; }
    return this.resolve(this.shot, i, aspect);
  }

  private resolve(shot: string, i: DirectorInput, aspect: number): Shot | null {
    if (shot.startsWith('seat:')) { const p = this.seat(shot.slice(5), aspect); return p ? { key: `ttrpg:${shot}`, pose: p, secs: 0 } : this.resolve('wide', i, aspect); }
    if (shot === 'dice:crit') {
      const base = this.pose('dice', i, aspect);
      if (!base) return null;
      const target = i.diceCenter ?? this.a.tray!.position;
      // push in from above (a steep angle keeps the tray's walls / lid out of the way)
      const d = base.position.clone().sub(target), L = d.length() * 0.8, flat = Math.hypot(d.x, d.z) || 1;
      const el = Math.max(Math.asin(THREE.MathUtils.clamp(d.y / Math.max(1e-3, d.length()), -1, 1)), THREE.MathUtils.degToRad(58));
      const pos = target.clone().add(new THREE.Vector3((d.x / flat) * Math.cos(el) * L, Math.sin(el) * L, (d.z / flat) * Math.cos(el) * L));
      return { key: 'ttrpg:dice:crit', pose: lookPose(pos, target, base.fov * 0.85), secs: 1.1 };
    }
    const p = this.pose(shot as 'wide', i, aspect);
    if (!p) return shot === 'wide' ? null : this.resolve('wide', i, aspect);
    // the GM ↔ wide ↔ map alternation eases; everything else cuts
    const secs = (shot === 'wide' || shot === 'map') && this.why === 'gm' ? 1.4 : 0;
    return { key: `ttrpg:${shot}`, pose: p, secs };
  }
}
