// Entrances / exits / spot changes — the hook the ENTRANCES engineer replaces.
//
// The SceneRuntime never animates an avatar between places itself; it asks the active AvatarMover:
//   enter(actor, spot)  – the performer became present (joined, or the host toggled them "in the room").
//                         Target behaviour: spawn at room.doorOutside, open room.door, walk room.path
//                         (PATH_01…) to the spot, turn to spot.forward, sit (actor.sit 0→1) / stand.
//   exit(actor)         – no longer present: reverse it (stand up, walk out, close the door), then hide.
//   move(actor, spot)   – the host moved them to another spot while present.
//   update(dt)          – every rendered frame.
//   busy(actor)         – true while the mover owns the actor; the runtime then leaves actor.mount /
//                         actor.sit / actor.shown alone. When not busy, the runtime keeps the actor settled
//                         at actor.spot (eases actor.sit to the spot's pose).
//
// What a mover may touch on a SceneActor (src/scene/actor.ts):
//   actor.mount     – THREE.Group in room space: position = floor point under the avatar, rotation.y = facing
//                     yaw (0 = facing +Z). Animate it along the walk path.
//   actor.sit       – 0 standing … 1 seated (the runtime bends the legs + drops onto the seat from it).
//   actor.shown     – visible at all (false while "outside").
//   actor.appear    – 0..1 extra scale factor (the placeholder "pop").
//   actor.extraPose – optional (rt, dt) => void pose layer, e.g. a walk cycle on the leg bones
//                     (rt.humanoid normalized bones; runs after the seated legs, before humanoid.update()).
//   actor.placementAt(spot) → { position, yaw, sit }  the settled pose at a spot.
// And on the RoomInfo (src/scene/contract.ts): door.setOpen(0..1), doorOutside, path[] / pathNames[], spots[],
// colliders (COLLIDE_* nodes, hidden). Per spot: spot.leavePathAt (index into room.path where the walk leaves the
// PATH_* chain, null = nearest) + spot.approach (world points to walk from there to the spot) - spots behind
// furniture (Studio: host desk, DJ, bar, armchair) clip on a straight line, so honour them.
import * as THREE from 'three';
import type { SceneActor } from './actor.ts';
import type { CamPose } from './cameraRig.ts';
import type { RoomInfo, SpotInfo } from './contract.ts';
import type { SceneInfo, SceneState } from '../../shared/types.ts';

/** The host-broadcast event behind a call (SceneState.moves[key], when its `to` matches): every page
 *  simulates the same walk from it. `at` = start, epoch ms (this page's clock); `from` = spot index or -1 (outside). */
export interface MoveEvent { at?: number; from?: number }

/** An entrance / exit / move in progress (for the follow camera). Times in seconds since the walk started. */
export interface MoverTrack {
  actor: SceneActor;
  kind: 'enter' | 'exit' | 'move';
  t: number;
  /** Through the doorway (entrances). */
  through: number;
  /** Seated / settled at the spot. */
  arrive: number;
}

export interface AvatarMover {
  enter(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent): void;
  exit(actor: SceneActor, ev?: MoveEvent): void;
  move(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent): void;
  /** Optional: walks in progress (follow camera). */
  tracks?(): MoverTrack[];
  update(dt: number): void;
  busy(actor: SceneActor): boolean;
  /** Optional: this mover plays this performer's entrances / exits / moves itself, wherever the spot is (the big
   *  entrance: src/scene/forms/bigEntrance.ts) - the runtime then never pops them in at a size spot. */
  claims?(actor: SceneActor, spot: SpotInfo): boolean;
  /** Optional: forget any walk of this actor now (the runtime places them itself, e.g. size spots: sizeSpots.ts). */
  release?(actor: SceneActor): void;
  /** Snap everything to its end state (scene switch, first frame, tab was hidden). */
  finishAll(): void;
  /** Optional: the room's own objects were hidden / moved in place (the Room editor's layer, SceneRuntime.applyEdits):
   *  forget anything cached from the room's meshes (ground under a walking foot …). */
  roomChanged?(): void;
  dispose(): void;
  /** Optional: the mover's own camera for its cinematics (e.g. the cryo bay / drop bay / viewport cuts of a space
   *  room). undefined = no opinion (the runtime's door-follow logic runs), null = none. */
  followCamera?(follow: SceneState['follow'], aspect: number, present: (a: SceneActor) => boolean): { key: string; pose: CamPose; secs: number } | null | undefined;
  /** Optional: where a walker is `t` s into their current walk (null = not walking) — the follow camera plans ahead. */
  samplePath?(actor: SceneActor, t: number): THREE.Vector3 | null;
  /** Optional: the scene mode ('talk' / 'react' / …) whenever the state changes (e.g. no exit camera cuts in React). */
  setMode?(mode: string): void;
  /** Optional: the host's whole scene state whenever it changes (before the enter / exit / move calls it causes), for
   *  movers whose picture depends on members who are NOT in the room — e.g. the cryo pods' frozen occupants
   *  (src/scene/space/spaceMover.ts). Read-only. */
  setScene?(state: SceneState, actors?: () => Iterable<SceneActor>): void;
}

/** roomChanged() on a mover and every mover it wraps (`inner`: the big entrance, the front line, space rooms). */
export function roomChangedAll(m: AvatarMover | null | undefined) {
  const seen = new Set<unknown>();
  for (let x = m as (AvatarMover & { inner?: AvatarMover }) | null | undefined; x && !seen.has(x); x = x.inner) { seen.add(x); x.roomChanged?.(); }
}

/** `info` = the room's scene.json (movers pick their entrance style from it, e.g. entrance: 'cryo'). */
export type MoverFactory = (room: RoomInfo, info?: SceneInfo) => AvatarMover;

type Job = { actor: SceneActor; t: number; steps: { dur: number; run: (k: number) => void; end?: () => void }[] };

/**
 * Placeholder: no walking — avatars pop in/out at their spot (scale ease). Replace via `setMoverFactory`.
 */
export class PopMover implements AvatarMover {
  private jobs = new Map<SceneActor, Job>();
  constructor(_room: RoomInfo) {}

  private start(actor: SceneActor, steps: Job['steps']) { this.jobs.set(actor, { actor, t: 0, steps }); }

  enter(actor: SceneActor, spot: SpotInfo) {
    actor.place(actor.placementAt(spot));
    actor.shown = true;
    actor.appear = 0;
    this.start(actor, [{ dur: 0.35, run: (k) => { actor.appear = easeOutBack(k); } }]);
  }

  exit(actor: SceneActor) {
    const a0 = actor.appear;
    this.start(actor, [{ dur: 0.25, run: (k) => { actor.appear = a0 * (1 - k); }, end: () => { actor.shown = false; actor.appear = 1; } }]);
  }

  move(actor: SceneActor, spot: SpotInfo) {
    this.start(actor, [
      { dur: 0.2, run: (k) => { actor.appear = 1 - k; }, end: () => actor.place(actor.placementAt(spot)) },
      { dur: 0.3, run: (k) => { actor.appear = easeOutBack(k); } },
    ]);
  }

  update(dt: number) {
    for (const [a, j] of this.jobs) {
      j.t += dt;
      while (j.steps.length) {
        const s = j.steps[0];
        const k = Math.min(1, j.t / s.dur);
        s.run(k);
        if (k < 1) break;
        s.end?.();
        j.t -= s.dur;
        j.steps.shift();
      }
      if (!j.steps.length) this.jobs.delete(a);
    }
  }

  busy(actor: SceneActor) { return this.jobs.has(actor); }
  finishAll() { for (const j of this.jobs.values()) for (const s of j.steps) { s.run(1); s.end?.(); } this.jobs.clear(); }
  dispose() { this.jobs.clear(); }
}

function easeOutBack(k: number) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}

let factory: MoverFactory = (room) => new PopMover(room);
/** The entrances engineer calls this (e.g. from src/scene/walkMover.ts) to install the real mover. */
export function setMoverFactory(f: MoverFactory) { factory = f; }
/** The installed factory (a room-specific mover can wrap it: src/scene/frontline/frontlineMover.ts, src/scene/arrivals/liftMover.ts). */
export function currentMoverFactory(): MoverFactory { return factory; }

/** Optional on movers that another mover may wrap (WalkMover, SpaceMover): hand an actor over and take it back. */
export interface MoverHandover {
  /** Forget any walk / cinematic of this actor now: another mover drives it. */
  handOff(actor: SceneActor): void;
  /** Take it back, settled wherever the other mover left it (install the pose layer; no first-sight snap). */
  adopt(actor: SceneActor): void;
}
export function createMover(room: RoomInfo, info?: SceneInfo): AvatarMover { return factory(room, info); }

/** Helper for movers: nearest PATH_* waypoint index to a point. */
export function nearestWaypoint(room: RoomInfo, p: THREE.Vector3): number {
  let best = -1, bd = Infinity;
  room.path.forEach((w, i) => { const d = w.distanceToSquared(p); if (d < bd) { bd = d; best = i; } });
  return best;
}
