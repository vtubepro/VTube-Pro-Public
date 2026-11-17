// The Trail v2 — the driven journey (DESIGN_V2.md §3–4), host side. Streams the procedural terrain around the wagon
// into Rapier (heightfield chunks + solid scatter), drives the wagon (a player on the driver bench, or the animals on
// their own along the road), follows the terrain (pitch / roll from four wheel contacts), mud / water / void / crashes /
// bogging + pushing, a floating origin in x and z, the road progress in trail miles, forks, the camp spot.
// The sim (sim.ts) owns the TRAIL layer (days, food, events, stops); this class is only the world + the vehicle.
// Coordinates: "world" = the generator's metres (procgen.ts); "local" = physics / render space = world − origin.
import { CHUNK, MILE_M, N, genChunk, heightAt, legPath, pathPoint, planJourney, roadInfo, surfaceAt, type Chunk, type Clearing, type PlanIn, type RoadPath, type WorldPlan } from '../../../../shared/trail/procgen.ts';
import type { JourneyState } from '../../../../shared/trail/types.ts';
import type { PhysWorld, PlayerPhys } from './world.ts';

/** Top speeds (m/s) per pace: the wagon is a gamey vehicle, not a realistic ox cart. */
export const PACE_SPEED: Record<string, number> = { steady: 6.2, strenuous: 7.6, grueling: 9.2 };
const REBASE_AT = 160;   // metres from the origin → rebase by whole chunks
const RING: [number, number][] = [[0, 0], [0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
export interface Drive { throttle: number; steer: number; brake: boolean; whip: boolean }

export interface JourneyEvents {
  /** Crashed into something at `speed` m/s (the sim decides: props fly, riders ragdoll, parts break). */
  crash(speed: number): void;
  /** The origin moved: everything local shifted by (dx, dz). */
  rebase(dx: number, dz: number): void;
}

export class Journey {
  readonly plan: WorldPlan;
  readonly st: JourneyState;
  /** Wagon: world position, heading (rad; 0 = +Z, + turns toward +X), speed (m/s, − = reverse), steer (rad, + = right). */
  wx = 0; wz = 0; yaw = 0; speed = 0; steer = 0;
  wy = 0; pitch = 0; roll = 0;
  /** Extra roll (tipping, a lifted corner) + a hop (meme / pothole) in metres, decaying. */
  extraRoll = 0; hop = 0; private hopV = 0;
  /** Where the wagon parks for camp (a flat clearing beside the road), when the party decided to camp. */
  campSpot: Clearing | null = null;
  private cache = new Map<string, Chunk>();
  private solids: { x: number; z: number; r: number }[] = [];
  private curPath: RoadPath | null = null;
  private pushT = 0;
  private bogT = 0;
  private bogForced = 0;
  private lastMiles = 0;
  /** Miles driven since the sim last took them (day ticks). */
  drivenMiles = 0;
  /** Push strength last step (the HUD shows it while bogged). */
  pushing = 0;
  /** Forks where the party voted for the other branch (alt path ids): the animals take it. */
  preferAlt = new Set<string>();
  private pushBuf: PlayerPhys[] = [];
  /** Seconds the wagon has been pushing against something without moving (the animals back up and go around). */
  stuckT = 0;
  private backT = 0;
  private backSteer = 0;
  private onSpur = false;

  constructor(opts: PlanIn, private phys: () => PhysWorld, private on: JourneyEvents) {
    this.plan = planJourney(opts);
    this.st = { tod: 0.3, driver: null, speed: 0, surface: 'road', bogged: false, path: null, fork: null, origin: [0, 0], next: '', nextDist: 0, camp: null, heading: 0, steer: 0, push: 0 };
  }

  // ---------------------------------------------------------------- placing
  /** Put the wagon at the start of leg `leg` (the run's start, or leaving a stop), heading down the road. */
  placeAtLeg(leg: number) {
    const path = legPath(this.plan, Math.max(0, Math.min(leg, this.plan.nodes.length - 2)));
    this.curPath = path ?? null;
    const n = this.plan.nodes[Math.max(0, Math.min(leg, this.plan.nodes.length - 1))];
    const p0 = path ? pathPoint(path, 14) : { x: n.x, z: n.z + 14, yaw: 0, h: 0 };
    this.wx = p0.x; this.wz = p0.z; this.yaw = p0.yaw; this.speed = 0; this.steer = 0;
    this.lastMiles = path ? path.m0 : n.miles; this.drivenMiles = 0;
    this.campSpot = null; this.bogT = 0; this.bogForced = 0; this.st.bogged = false; this.stuckT = 0; this.backT = 0;
    this.recentre();
  }
  /** Origin: chunk-aligned near the wagon. */
  private recentre() { this.st.origin = [Math.round(this.wx / CHUNK) * CHUNK, Math.round(this.wz / CHUNK) * CHUNK]; }
  /** A new physics world was made (after a stop): stream the terrain around the wagon + pose it. */
  attach() { this.recentre(); this.streamAll(); this.settle(true); }
  local(x: number, z: number): [number, number] { return [x - this.st.origin[0], z - this.st.origin[1]]; }
  world(lx: number, lz: number): [number, number] { return [lx + this.st.origin[0], lz + this.st.origin[1]]; }
  /** Ground height under a LOCAL point. */
  groundLocal(lx: number, lz: number): number { return heightAt(this.plan, lx + this.st.origin[0], lz + this.st.origin[1]); }
  /** A LOCAL point in the wagon's frame: `side` metres to the wagon's left (+) / right (−), `ahead` metres forward. */
  frame(side: number, ahead: number, up = 0): [number, number, number] {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const x = this.wx + c * side + s * ahead, z = this.wz - s * side + c * ahead;
    const [lx, lz] = this.local(x, z);
    return [lx, heightAt(this.plan, x, z) + up, lz];
  }
  /** The wagon position (local). */
  wagonLocal(): [number, number, number] { const [lx, lz] = this.local(this.wx, this.wz); return [lx, this.wy, lz]; }

  // ---------------------------------------------------------------- terrain streaming
  chunkAt(cx: number, cz: number): Chunk {
    const k = `${cx},${cz}`;
    let c = this.cache.get(k);
    if (!c) { c = genChunk(this.plan, cx, cz, true); this.cache.set(k, c); if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!); }
    return c;
  }
  /** Keep the 3×3 chunks around the wagon (+ the one ahead) in the physics world, at most `budget` new ones per call. */
  stream(budget = 1) {
    const ph = this.phys();
    const ccx = Math.floor(this.wx / CHUNK), ccz = Math.floor(this.wz / CHUNK);
    const want: string[] = RING.map(([dx, dz]) => `${ccx + dx},${ccz + dz}`);
    // the chunk the wagon drives into next (heading) first
    const ax = Math.floor((this.wx + Math.sin(this.yaw) * 70) / CHUNK), az = Math.floor((this.wz + Math.cos(this.yaw) * 70) / CHUNK);
    const lead = `${ax},${az}`;
    if (!want.includes(lead)) want.splice(1, 0, lead);
    const have = new Set(ph.chunkKeys());
    for (const key of have) if (!want.includes(key)) ph.removeChunk(key);
    let made = 0;
    this.solids.length = 0;
    for (const key of want) {
      const [cx, cz] = key.split(',').map(Number);
      if (!have.has(key)) {
        if (made >= budget) continue;
        // generate in one step, build the colliders in the next (each ≤ ~4 ms)
        if (!this.cache.has(key) && budget < 4) { this.chunkAt(cx, cz); made++; continue; }
        const c = this.chunkAt(cx, cz);
        const [lx, lz] = this.local(cx * CHUNK + CHUNK / 2, cz * CHUNK + CHUNK / 2);
        const solids: { x: number; z: number; y: number; r: number }[] = [];
        for (const s of c.scatter) if (s.solid) { const [sx, sz] = this.local(s.x, s.z); solids.push({ x: sx, z: sz, y: s.y, r: s.r }); }
        ph.addChunk(key, N, CHUNK, c.heights, lx, lz, solids);
        made++;
      }
      const c = this.cache.get(key);
      if (c) for (const s of c.scatter) if (s.solid) this.solids.push({ x: s.x, z: s.z, r: s.r });
    }
  }
  /** Everything around the wagon at once (a fresh world). */
  streamAll() { this.stream(12); }

  // ---------------------------------------------------------------- the vehicle
  /** The driver bench: the most forward seat anyone can use (the engine default: seat 6). */
  driverSeatIndex(): number {
    const seats = this.phys().wagonSpec.seats;
    let best = -1, bz = -Infinity;
    seats.forEach((s, i) => { if (s.sizes?.length) return; if (s.p[2] > bz) { bz = s.p[2]; best = i; } });
    return best >= 0 ? best : 0;
  }
  /** Mud event: the wagon sinks in (whatever the ground) until pushed out. */
  forceBog() { this.bogForced = 1; this.st.bogged = true; this.bogT = 2; this.pushT = 0; }
  /** The scene is over either way (the party dug it out off-screen: days lost). */
  unbog() { this.bogForced = 0; this.st.bogged = false; this.bogT = 0; this.pushT = 0; }
  jump(v: number) { this.hopV = Math.max(this.hopV, v); }
  /** Back on the road (nearest point of the current road, heading along it): the "unstuck" button / a long stuck. */
  toRoad(): boolean {
    const r = roadInfo(this.plan, this.wx, this.wz, 400);
    if (!r) return false;
    const p = this.plan.paths[r.path];
    const q = pathPoint(p, Math.min(r.s + 4, p.cum[p.cum.length - 1] - 1));
    this.wx = q.x; this.wz = q.z; this.yaw = q.yaw; this.speed = 0; this.steer = 0; this.stuckT = 0; this.backT = 0; this.farT = 0;
    this.curPath = p; this.campSpot = null; this.onSpur = false;
    this.settle(true);
    return true;
  }
  /** Park on a camp pad (the wagon "pulls in" the last metres itself): camps always happen on the flat pad. */
  parkAt(c: Clearing) {
    const d = this.distTo(c.x, c.z);
    if (d > c.r - 4) {
      const ax = c.rx ?? this.wx, az = c.rz ?? this.wz;
      const yaw = Math.atan2(c.x - ax, c.z - az);
      this.wx = c.x - Math.sin(yaw) * 3; this.wz = c.z - Math.cos(yaw) * 3; this.yaw = yaw;
    }
    this.speed = 0; this.stuckT = 0; this.backT = 0;
    this.settle(true);
  }
  /** Seconds spent off the road going nowhere (the sim offers / does toRoad). */
  farT = 0;

  /** One sim step. `drive` = the driver's controls (null: the animals follow the road, or pull into the camp spot).
   *  `cap` = speed factor from the TRAIL layer (draft animals, broken parts, weather; 0 = can't move). */
  step(dt: number, drive: Drive | null, cap: number, pace: string, night: boolean, pushersIn: Iterable<PlayerPhys>) {
    const pushers = this.pushBuf; pushers.length = 0; for (const p of pushersIn) pushers.push(p);   // (an iterator can only be walked once)
    const ph = this.phys();
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    const surf = surfaceAt(this.plan, this.wx, this.wz);
    let surfK = surf.s === 'road' ? 1 : surf.s === 'grass' ? 0.72 : surf.s === 'mud' ? 0.4 : surf.s === 'water' ? Math.max(0.25, 1 - surf.water * 0.5) : 0.5;
    if (night) surfK *= 0.8;
    const vmax = (PACE_SPEED[pace] ?? 6.2) * cap * surfK;
    const c = drive ?? this.autoDrive(cap);
    const throttle = Math.max(-1, Math.min(1, c.throttle)), steerIn = Math.max(-1, Math.min(1, c.steer));
    // bogging: deep mud at a crawl (or a mud event) — only pushing (or a strong whip) frees the wagon
    if (!this.st.bogged && surf.s === 'mud' && surf.mud > 0.93 && Math.abs(this.speed) < 1.4 && throttle !== 0) this.bogT += dt; else if (!this.st.bogged) this.bogT = Math.max(0, this.bogT - dt * 2);
    if (this.bogT > 1.4) this.st.bogged = true;
    this.pushing = 0;
    for (const p of pushers) p.pushing = false;
    if (this.st.bogged) {
      const [wlx, wlz] = this.local(this.wx, this.wz);
      for (const p of pushers) {
        if (p.seat >= 0 || p.ghost || p.downed || p.ragdoll > 0) continue;
        const b = p.body.translation();
        const dx = b.x - wlx, dz = b.z - wlz;
        const along = dx * fwdX + dz * fwdZ, across = Math.abs(dx * fwdZ - dz * fwdX);
        // trying to walk the way the wagon faces (the wagon stops them: intent, not velocity); view forward = (−sin, −cos) of yaw
        const i = p.input, sy = Math.sin(i.yaw), cy = Math.cos(i.yaw);
        const mvx = -sy * i.mz + cy * i.mx, mvz = -cy * i.mz - sy * i.mx;
        if (along > -4.4 && along < 3.5 && across < 2.6 && mvx * fwdX + mvz * fwdZ > 0.5) { this.pushing += Math.min(3, p.st.mass / 70); p.pushing = true; }
        else if (p.grab && p.grab.ent === ph.wagon?.id) this.pushing += Math.min(3, p.st.mass / 70) * 0.6;
      }
      if (c.whip && throttle > 0) this.pushing += 0.5;
      const need = this.bogForced ? 2 : 1.5;
      this.pushT = this.pushing >= need ? this.pushT + dt * this.pushing : Math.max(0, this.pushT - dt * 0.5);
      if (this.pushT > 3.2) { this.st.bogged = false; this.bogT = 0; this.bogForced = 0; this.pushT = 0; this.speed = 2.4; }
    }
    this.st.push = this.st.bogged ? Math.min(1, this.pushT / 3.2) : 0;
    // speed
    const top = (c.whip ? 1.25 : 1) * vmax * (this.st.bogged ? 0.05 : 1);
    if (c.brake) this.speed *= Math.max(0, 1 - dt * 3.5);
    else if (throttle > 0) { if (this.speed < 0) this.speed = Math.min(0, this.speed + 6 * dt); else this.speed += Math.min(2.6 * throttle * dt, Math.max(0, top * throttle - this.speed)); }
    else if (throttle < 0) { if (this.speed > 0.2) this.speed = Math.max(0, this.speed + 5 * throttle * dt); else this.speed = Math.max(-2.2 * cap, this.speed + 1.6 * throttle * dt); }
    else this.speed *= Math.max(0, 1 - dt * 0.9);
    if (this.speed > top) this.speed += (top - this.speed) * Math.min(1, dt * 2);
    if (Math.abs(this.speed) < 0.03 && throttle === 0) this.speed = 0;
    // uphill costs speed, downhill runs away a little
    if (this.speed !== 0) this.speed -= Math.sin(this.pitch) * 2.2 * dt * Math.sign(this.speed);
    // steering (bicycle model, + = right = yaw decreases)
    this.steer += (steerIn * 0.55 - this.steer) * Math.min(1, dt * 3.2);
    this.yaw -= (this.speed * Math.tan(this.steer) / 2.8) * dt;
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    // move (blocked by solid scatter + the void edge)
    const nx = this.wx + Math.sin(this.yaw) * this.speed * dt, nz = this.wz + Math.cos(this.yaw) * this.speed * dt;
    const hit = this.blocked(nx, nz);
    if (hit) {
      if (Math.abs(this.speed) > 3) this.on.crash(Math.abs(this.speed));
      this.speed = -this.speed * 0.15;
    } else { this.wx = nx; this.wz = nz; }
    // pushing into something (a tree, the edge) without getting anywhere
    if (throttle !== 0 && !this.st.bogged && cap > 0 && (hit || Math.abs(this.speed) < 0.25)) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    // off the road and not getting back onto it (stuck at a cliff, wedged in trees): the sim puts the wagon back
    this.farT = cap > 0 && !this.st.bogged && !this.campSpot && surf.s !== 'road' && surf.s !== 'mud' && surf.s !== 'water' ? this.farT + dt * (Math.abs(this.speed) < 0.6 ? 1 : 0.35) : 0;
    // hop
    if (this.hopV > 0 || this.hop > 0) { this.hop += this.hopV * dt; this.hopV -= 9.81 * dt; if (this.hop <= 0) { this.hop = 0; this.hopV = 0; } }
    this.settle(false);
    // progress along the road (miles only grow), the path + fork ahead
    const r = roadInfo(this.plan, this.wx, this.wz, 40);
    if (r) {
      const p = this.plan.paths[r.path];
      this.st.path = p.id;
      if (r.d < 6) this.curPath = p;
      if (r.miles > this.lastMiles && r.miles - this.lastMiles < 6) { this.drivenMiles += r.miles - this.lastMiles; this.lastMiles = r.miles; }
    } else this.st.path = null;
    this.st.speed = Math.round(this.speed * 10) / 10;
    this.st.surface = surf.s;
    this.st.heading = Math.round(this.yaw * 100) / 100;
    this.st.steer = Math.round(this.steer * 100) / 100;
    // floating origin
    const [lx, lz] = this.local(this.wx, this.wz);
    if (Math.abs(lx) > REBASE_AT || Math.abs(lz) > REBASE_AT) {
      const ox = Math.round(this.wx / CHUNK) * CHUNK, oz = Math.round(this.wz / CHUNK) * CHUNK;
      const dx = this.st.origin[0] - ox, dz = this.st.origin[1] - oz;
      this.st.origin = [ox, oz];
      ph.rebase(dz, dx);
      this.on.rebase(dx, dz);
      this.settle(true);
    }
    this.stream(1);
  }
  /** Miles reached along the road (the TRAIL layer's run.miles follows this). */
  get miles() { return this.lastMiles; }
  set miles(m: number) { this.lastMiles = m; }
  /** The fork coming up (for the HUD signpost + the director): labels [main, alt], distance (m), which side the alt is. */
  forkAhead(): { labels: [string, string]; dist: number; alt: -1 | 1; id: string } | null {
    for (const f of this.plan.forks) {
      const d = Math.hypot(f.x - this.wx, f.z - this.wz);
      if (d > 160 || this.lastMiles > f.m0 + 1) continue;
      const alt = this.plan.paths.find((p) => p.id === f.alt), main = this.plan.paths.find((p) => p.id === f.main);
      if (!alt || !main) continue;
      const a = pathPoint(alt, 40), mr = roadInfo(this.plan, f.x, f.z, 4), m = mr ? pathPoint(main, mr.s + 40) : a;
      // which side of the main road the shortcut leaves on (+1 = left of travel)
      const tx = m.x - f.x, tz = m.z - f.z, ox = a.x - f.x, oz = a.z - f.z;
      const side = tz * ox - tx * oz > 0 ? 1 : -1;
      return { labels: f.labels, dist: Math.max(0, Math.round(d)), alt: side as -1 | 1, id: f.alt };
    }
    return null;
  }
  /** World distance from the wagon to a world point. */
  distTo(x: number, z: number) { return Math.hypot(this.wx - x, this.wz - z); }
  /** The next camp clearing ahead on the road (within `maxAhead` miles). */
  campAhead(maxAhead = 60): Clearing | null {
    let best: Clearing | null = null, bd = Infinity;
    for (const c of this.plan.clearings) {
      if (c.kind !== 'camp') continue;   // (camp pads have a tree-free, solid driveway from the road)
      const ahead = c.miles - this.lastMiles;
      const d = this.distTo(c.x, c.z);
      if ((ahead < -3 && d > 45) || ahead > maxAhead) continue;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /** Controls when nobody drives: the animals follow the road (the main branch at forks) or pull into the camp spot. */
  autoDrive(cap: number): Drive {
    if (cap <= 0) return { throttle: 0, steer: 0, brake: true, whip: false };
    // stuck against something: back up a few metres, turned the other way, then try again
    if (this.backT > 0) { this.backT -= 1 / 60; return { throttle: -0.8, steer: this.backSteer, brake: false, whip: false }; }
    if (this.stuckT > 1.2) { this.stuckT = 0; this.backT = 1.8; this.backSteer = this.steer > 0 ? -1 : 1; return { throttle: -0.8, steer: this.backSteer, brake: false, whip: false }; }
    let tx: number, tz: number, want = 0.8;
    const spot = this.campSpot;
    if (spot && (this.onSpur || spot.rx === undefined || this.distTo(spot.rx, spot.rz!) < 9 || this.distTo(spot.x, spot.z) < 20 || spot.miles < this.lastMiles - 0.5)) {
      this.onSpur = true;
      tx = spot.x; tz = spot.z;
      const d = this.distTo(tx, tz);
      if (d < 7) return { throttle: 0, steer: 0, brake: true, whip: false };
      want = d < 25 ? 0.3 : 0.5;
    } else {
      if (!spot) this.onSpur = false;
      let p = this.curPath;
      if (!p) { const r = roadInfo(this.plan, this.wx, this.wz, 200); p = r ? this.plan.paths[r.path] : null; this.curPath = p; }
      // at a fork the party voted to leave the main road: swing onto the branch
      for (const f of this.plan.forks) if (this.preferAlt.has(f.alt) && p?.id === f.main && this.distTo(f.x, f.z) < 14) { const alt = this.plan.paths.find((x) => x.id === f.alt); if (alt) { p = alt; this.curPath = alt; } }
      if (!p) return { throttle: 0, steer: 0, brake: true, whip: false };
      const r = roadInfo(this.plan, this.wx, this.wz, 60);
      let s = r && this.plan.paths[r.path] === p ? r.s : this.nearestS(p);
      const L = p.cum[p.cum.length - 1];
      if (s > L - 12) {
        // an alt branch rejoins its leg's main road; a main road hands over to the next leg
        const next = p.kind === 'alt' ? legPath(this.plan, p.leg) : legPath(this.plan, p.leg + 1);
        if (next) { p = next; this.curPath = next; s = this.nearestS(next); }
      }
      const off = r && this.plan.paths[r.path] === p ? r.d : 0;
      const t = pathPoint(p, s + (off > 8 ? 3 : 12));   // off the road (leaving camp): straight back to it first
      tx = t.x; tz = t.z;
    }
    const wantYaw = Math.atan2(tx - this.wx, tz - this.wz);
    const d = Math.atan2(Math.sin(wantYaw - this.yaw), Math.cos(wantYaw - this.yaw));
    return { throttle: want * (Math.abs(d) > 1.2 ? 0.4 : 1), steer: Math.max(-1, Math.min(1, -d * 2.4)), brake: false, whip: false };
  }
  private nearestS(p: RoadPath): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < p.xs.length; i += 2) { const d = (p.xs[i] - this.wx) ** 2 + (p.zs[i] - this.wz) ** 2; if (d < bd) { bd = d; best = p.cum[i]; } }
    return best;
  }
  private blocked(x: number, z: number): boolean {
    const dir = this.speed >= 0 ? 1 : -1;
    const px = x + Math.sin(this.yaw) * 2.3 * dir, pz = z + Math.cos(this.yaw) * 2.3 * dir;
    for (const s of this.solids) if ((px - s.x) ** 2 + (pz - s.z) ** 2 < (s.r + 1.0) ** 2) return true;
    return heightAt(this.plan, px, pz) < -8;   // the void (sky islands): the animals won't walk off the edge
  }
  /** Body pose from four wheel contacts on the terrain → the physics wagon's next kinematic pose. */
  private settle(snap: boolean) {
    const ph = this.phys();
    const wh = Object.values(ph.wagonSpec.wheels);
    const fz = Math.max(...wh.map((w) => w[2])), rz = Math.min(...wh.map((w) => w[2])), hx = Math.max(...wh.map((w) => Math.abs(w[0])));
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // wagon-local (lx: + = left, lz: + = forward) → world
    // (a wheel over the void / a cliff edge rests at the others' height: the wagon never tips into the sky)
    const cH = heightAt(this.plan, this.wx, this.wz);
    const at = (lx: number, lz: number) => { const h = heightAt(this.plan, this.wx + c * lx + s * lz, this.wz - s * lx + c * lz); return h < cH - 2.5 ? cH - 0.3 : h; };
    const hFL = at(hx, fz), hFR = at(-hx, fz), hRL = at(hx, rz), hRR = at(-hx, rz);
    const front = (hFL + hFR) / 2, rear = (hRL + hRR) / 2, left = (hFL + hRL) / 2, right = (hFR + hRR) / 2;
    const wantPitch = Math.atan2(front - rear, fz - rz), wantRoll = Math.atan2(left - right, hx * 2) + this.extraRoll;
    const k = snap ? 1 : 0.35;
    this.pitch += (wantPitch - this.pitch) * k; this.roll += (wantRoll - this.roll) * k;
    const wy = (hFL + hFR + hRL + hRR) / 4 + this.hop;
    this.wy = snap ? wy : this.wy + (wy - this.wy) * 0.5;
    // yaw (about +Y) · pitch (nose up = rotate about −X) · roll (left side up = rotate about +Z)
    const q = qmul(qmul([0, Math.sin(this.yaw / 2), 0, Math.cos(this.yaw / 2)], [Math.sin(-this.pitch / 2), 0, 0, Math.cos(-this.pitch / 2)]), [0, 0, Math.sin(this.roll / 2), Math.cos(this.roll / 2)]);
    const [lx, lz] = this.local(this.wx, this.wz);
    ph.wagonPose = { p: [lx, this.wy, lz], q };
    ph.wagonVel = [Math.sin(this.yaw) * this.speed, 0, Math.cos(this.yaw) * this.speed];
    if (snap && ph.wagon?.body) { ph.wagon.body.setTranslation({ x: lx, y: this.wy, z: lz }, true); ph.wagon.body.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true); }
  }
}
export function qmul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
export { MILE_M };
