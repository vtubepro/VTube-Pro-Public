// The host's entrance in the club (src/scene/club): the host leaves the DJ booth (or walks in through the artist door),
// crosses the club, climbs the grand staircase and takes the balcony — and the camera tells it like a music video:
//   1. booth close-up while they step away from the decks
//   2. a crowd-level operator follows them past the dancers (pans + zooms on their head)
//   3. looking up the grand staircase as they climb
//   4. a drone over the dance floor pushing towards the balcony as they walk to the rail
//   5. the REVEAL once they are at the rail: a low close-up on the face cranes up and back in an arc into the balcony
//      talk shot, the whole club — dance floor, stage, LED wall, lasers — rising into view behind them
// Everything is a function of the mover's own walk timeline (host-timed, identical on every page) and the room's
// anchors; it runs through SceneRuntime.cameraOverride (wrapping any other room director) and never in React mode.
import * as THREE from 'three';
import { lookPose, type CamPose } from '../cameraRig.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';
import type { SceneActor } from '../actor.ts';

const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
const smoother = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * k * (k * (k * 6 - 15) + 10); };
export const REVEAL_SECS = 6.5;

export interface FlowAnchors {
  /** spot indices: the DJ booth and the balcony host spot */
  dj: number; balcony: number;
  /** operator positions (room space): crowd follow, stair cam, drone start + end */
  crowd: THREE.Vector3; stairs2: THREE.Vector3; droneA: THREE.Vector3; droneB: THREE.Vector3;
  /** operator behind the DJ (stage side), the stage height, the stairs box [x0, x1, z0, z1], the balcony height */
  booth: THREE.Vector3; stageY: number; stairs: [number, number, number, number]; balconyY: number;
}

export class HostFlow {
  private walk: { id: string; start: number; arrive: number; from: number; to: number } | null = null;
  private reveal: { at: number; id: string } | null = null;
  info = '';
  constructor(private rt: SceneRuntime, private a: FlowAnchors) {}

  private head(actor: SceneActor, out: THREE.Vector3) {
    const h = (actor.rest?.height ?? 1.6) * actor.scale;
    return out.copy(actor.mount.position).setY(actor.mount.position.y + h * 0.9);
  }

  /** the camera for this frame, or null (normal camera) */
  shot(aspect: number, now: number): { key: string; pose: CamPose; secs: number } | null {
    const rt = this.rt;
    if (rt.state.mode === 'react') return null;
    const host = rt.actors.get('@host');
    if (!host || !host.shown) return null;
    const mv = rt.mover as unknown as { tracks?: () => { actor: SceneActor; kind: string; t: number; arrive: number }[] };
    const tr = mv.tracks?.().find((x) => x.actor === host && (x.kind === 'move' || x.kind === 'enter'));
    const target = rt.seatOf('@host');
    const toBalcony = target?.index === this.a.balcony;
    const ev = rt.state.moves?.['@host'];
    if (!tr && this.walk && toBalcony && !this.reveal && now - (this.walk.start + this.walk.arrive) < 1.5) this.reveal = { at: this.walk.start + this.walk.arrive, id: this.walk.id };
    if (tr && toBalcony) {
      const id = `${ev?.at ?? 0}:${tr.kind}`;
      this.walk = { id, start: now - tr.t, arrive: tr.arrive, from: ev?.from ?? -1, to: this.a.balcony };
      // the follow cam owns walk-ins from the door until they are through it; after that we direct
      if (tr.kind === 'enter' && rt.state.follow?.host !== false && tr.t < tr.arrive * 0.35) return null;
      if (tr.t >= tr.arrive) { this.reveal ??= { at: this.walk.start + tr.arrive, id }; }
      else return this.follow(host, tr.t, tr.arrive, aspect);
    }
    // the reveal: after arriving at the rail
    if (this.reveal && toBalcony) {
      const u = (now - this.reveal.at) / REVEAL_SECS;
      if (u >= 0 && u < 1) return this.revealShot(host, u, aspect);
      if (u >= 1) this.reveal = null;
    }
    if (!tr) this.walk = null;
    return null;
  }

  private follow(host: SceneActor, t: number, arrive: number, aspect: number): { key: string; pose: CamPose; secs: number } {
    const h = this.head(host, new THREE.Vector3());
    const p = host.mount.position;
    const A = this.a;
    let phase = 'crowd', from: THREE.Vector3;
    const onStairs = p.x > A.stairs[0] - 0.3 && p.x < A.stairs[1] + 0.3 && p.z > A.stairs[2] - 0.2 && p.z < A.stairs[3] + 0.2;
    if (p.y > A.stageY - 0.05 && t < 9) { phase = 'booth'; from = A.booth.clone(); }
    else if (p.y >= A.balconyY - 0.3 && !onStairs) {
      phase = 'drone';
      const k = smooth((A.stairs[0] - p.x) / 9);
      from = A.droneA.clone().lerp(A.droneB, k);
    } else if (onStairs) { phase = 'stairs'; from = A.stairs2.clone(); }
    else from = A.crowd.clone();
    this.info = `${phase} t ${t.toFixed(1)}/${arrive.toFixed(1)}`;
    const d = from.distanceTo(h);
    const fov = Math.min(58, Math.max(20, 2 * Math.atan((1.9 * host.scale) / (2 * d)) * 180 / Math.PI * (phase === 'drone' ? 3.2 : phase === 'booth' ? 3.0 : 2.0)));
    // aim slightly ahead of the walker (the direction they walk), eased per phase
    const pose = lookPose(from, h, fov);
    void aspect;
    return { key: `club:flow:${phase}:${Math.round(t * 30)}`, pose, secs: 0 };
  }

  private revealShot(host: SceneActor, u: number, aspect: number): { key: string; pose: CamPose; secs: number } {
    const rt = this.rt;
    const end = rt.talkPoseFor('@host', aspect);
    const face = this.head(host, new THREE.Vector3()).add(new THREE.Vector3(0, -0.06, 0));
    const yaw = host.mount.rotation.y;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const k = smoother(u);
    // an arc: 50° to the host's left, low and close → the talk camera's bearing, height and distance
    const endPos = end ? end.position.clone() : face.clone().addScaledVector(fwd, 2.6).setY(face.y + 0.05);
    const endRel = endPos.clone().sub(face);
    const endR = Math.hypot(endRel.x, endRel.z), endA = Math.atan2(endRel.dot(right), endRel.dot(fwd));
    const a0 = endA + 0.9, r0 = 1.25, y0 = face.y - 0.45;
    const ang = a0 + (endA - a0) * k, r = r0 + (endR - r0) * k, y = y0 + (endPos.y - y0) * k;
    const pos = face.clone().addScaledVector(fwd, Math.cos(ang) * r).addScaledVector(right, Math.sin(ang) * r).setY(y);
    const endTarget = end ? end.position.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(end.quaternion).multiplyScalar(endR)) : face.clone();
    const tgt = face.clone().lerp(endTarget, k);
    const fov = 30 + ((end?.fov ?? 38) - 30) * k;
    this.info = `reveal ${(u * 100).toFixed(0)}%`;
    return { key: `club:reveal:${Math.round(u * 400)}`, pose: lookPose(pos, tgt, fov), secs: 0 };
  }
}
