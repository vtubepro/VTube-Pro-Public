// The Trail — host physics world (Rapier): level colliders, the wagon, props, players (velocity-steered capsules with
// ragdoll), REPO-style grabbing (spring forces capped by each holder's lift strength, summed over holders), water
// (buoyancy + current + sweeping), stowed cargo riding the wagon, snapshots. No DOM: runs in a Worker and in Node.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { PROPS, WAGON, inZone, type ColDesc, type LevelDesc, type PropSpec, type V3, type WagonSpec, type WaterDesc, type ZoneDesc } from '../../../../shared/trail/levels.ts';
import { jumpVelocity, sizeStats, type SizeStats } from '../../../../shared/trail/sizes.ts';
import { terrainGrid } from '../../../../shared/trail/stopgen.ts';
import { ANIM, BTN, F, emptyInput, type EntInfo, type EntSnap, type InputFrame } from '../../../../shared/trail/wire.ts';

type R = typeof RAPIER_NS;
/** Collision groups (membership << 16 | filter): the level, dynamic things, ghosts (touch the level only). */
export const GROUP_LEVEL = 0x0001ffff, GROUP_DYN = 0x0002ffff, GROUP_GHOST = 0x00080001;
/** Players: everything but each other (capsule-vs-capsule contacts made the solver fight the movement controller every
 *  step — the "lag when players collide"); `softPush` keeps them apart instead. */
export const GROUP_PLAYER = 0x0010ffef;
type Body = RAPIER_NS.RigidBody;
type Col = RAPIER_NS.Collider;
const G = 9.81;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface Grab { ent: number; local: V3; dist: number }
export interface PlayerPhys {
  id: string; ent: number; st: SizeStats; body: Body; col: Col;
  input: InputFrame; prevButtons: number; lastSeq: number; lastInputAt: number;
  ragdoll: number; grounded: boolean; groundEnt: number; air: number; jumpCd: number;
  seat: number; grab: Grab | null; downed: boolean; ghost: boolean;
  inWater: number; swept: boolean; anim: number; speed: number; fallV: number;
  /** Seconds holding 'use' (revive / repair / paddle). */
  useHold: number; fireCd: number; stun: number;
  /** Gameplay modifiers (big head, inverted, broken leg…). */
  speedMul: number; inverted: boolean; strengthMul: number;
  /** Director-side button edge tracking. */
  gamePrev: number;
  /** Bots: only grab this entity (0 = anything). */
  grabWant?: number;
  /** v2: pushing the bogged wagon this step (the push animation). */
  pushing?: boolean;
  /** v2: riding on a bigger player's shoulders (their id). */
  mount?: string;
}
export interface Ent {
  id: number; info: EntInfo; body: Body | null; cols: Col[];
  prop?: PropSpec; item?: string; value: number; owned: boolean; price: number;
  /** Stowed in the wagon: kinematic, riding at `stowLocal` (wagon space). */
  stowed: boolean; stowLocal?: V3; stowQ?: [number, number, number, number]; restT: number;
  gone: boolean; spawn: V3; held: number; hitched?: number; buoy: number;
  /** v2: ordered from the store catalogue (load-all at the tailgate takes it; paid when you leave). */
  ordered?: boolean;
  animal?: { kind: string; state: 'idle' | 'wander' | 'flee' | 'attack' | 'dead' | 'carry'; carry?: { pid: string; t: number; hp: number }; hp: number; t: number; dir: number; target?: string; home: V3; speed: number; danger: number; flee: number; kg: number; atkCd: number };
  npc?: { id: string; name: string };
  last?: { p: V3; q: [number, number, number, number]; t: number };
  /** carried off (bird), lost downstream… */
  lost?: string;
}

export class PhysWorld {
  world: RAPIER_NS.World;
  queue: RAPIER_NS.EventQueue;
  ents = new Map<number, Ent>();
  players = new Map<string, PlayerPhys>();
  private colEnt = new Map<number, number>();
  private nextId = 1;
  level: LevelDesc | null = null;
  wagon: Ent | null = null;
  /** The wagon's physics + anchors (engine default, or the theme's wagon.glb). */
  wagonSpec: WagonSpec = WAGON;
  /** Wagon kinematic motion (travel / ford / ferry): velocity + a tilt (roll) for tipping. */
  wagonVel: V3 = [0, 0, 0];
  wagonRoll = 0;
  /** v2 journey: the wagon's next pose is driven from outside (position + full orientation), else velocity + roll. */
  wagonPose: { p: V3; q: [number, number, number, number] } | null = null;
  /** v2 journey: the driver bench (movement keys steer the wagon instead of hopping off; freeSeat never picks it). */
  driverSeat = -1;
  /** v2 journey: terrain chunk colliders (heightfield + solid scatter) by chunk key. */
  private chunks = new Map<string, { body: Body; cols: Col[] }>();
  zones: ZoneDesc[] = [];
  waters: WaterDesc[] = [];
  time = 0;
  /** Impact notifications for the director (ragdoll causes, fall damage). */
  onImpact: (id: string, k: number, cause: string) => void = () => {};
  /** A player let go of (or threw) something: the director may load it into the wagon. */
  onRelease: (p: PlayerPhys, e: Ent, thrown: boolean) => void = () => {};
  onLost: (e: Ent, why: string) => void = () => {};
  spawned: EntInfo[] = [];
  despawned: number[] = [];

  constructor(readonly R: R, level: LevelDesc) {
    this.world = new R.World({ x: 0, y: -G, z: 0 });
    this.world.timestep = 1 / 60;
    this.queue = new R.EventQueue(true);
    this.load(level);
  }

  // ---------------------------------------------------------------- level
  private load(level: LevelDesc) {
    this.level = level;
    this.zones = level.zones;
    this.waters = level.water;
    const R = this.R;
    const fixed = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    for (const c of level.cols) this.world.createCollider(this.colDesc(c).setFriction(c.friction ?? (c.tag === "mud" ? 1.2 : 0.8)).setCollisionGroups(GROUP_LEVEL), fixed);
    // generated stops (stopgen.ts): the heightfield ground, rebuilt from its spec
    const t = level.terrain;
    if (t) this.addChunk('stop', t.n, t.size, terrainGrid(t), t.cx, t.cz, []);
  }
  private colDesc(c: ColDesc): RAPIER_NS.ColliderDesc {
    const R = this.R;
    if (c.shape === 'trimesh' && c.verts && c.idx) return R.ColliderDesc.trimesh(Float32Array.from(c.verts), Uint32Array.from(c.idx));
    const d = c.shape === 'box' ? R.ColliderDesc.cuboid(...(c.he ?? [0.5, 0.5, 0.5])) : c.shape === 'cylinder' ? R.ColliderDesc.cylinder(c.hh ?? 0.5, c.r ?? 0.5) : R.ColliderDesc.ball(c.r ?? 0.5);
    d.setTranslation(...c.p);
    if (c.q) d.setRotation({ x: c.q[0], y: c.q[1], z: c.q[2], w: c.q[3] });
    return d;
  }

  // ---------------------------------------------------------------- entities
  private addEnt(info: Omit<EntInfo, 'id'>, body: Body | null, cols: Col[], extra: Partial<Ent> = {}): Ent {
    const id = this.nextId++;
    const e: Ent = { id, info: { ...info, id }, body, cols, value: 1, owned: true, price: 0, stowed: false, restT: 0, gone: false, spawn: [0, 0, 0], held: 0, buoy: 1, ...extra };
    for (const c of cols) this.colEnt.set(c.handle, id);
    this.ents.set(id, e);
    this.spawned.push(e.info);
    return e;
  }
  entOfCollider(c: Col | null | undefined): Ent | null { const id = c ? this.colEnt.get(c.handle) : undefined; return id ? this.ents.get(id) ?? null : null; }

  addWagon(p: V3, yaw: number, kinematic = true): Ent {
    const R = this.R;
    const bd = (kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic()).setTranslation(...p).setRotation(yawQ(yaw));
    const body = this.world.createRigidBody(bd);
    const cols: Col[] = [];
    const W = this.wagonSpec;
    for (const c of W.cols) cols.push(this.world.createCollider(this.colDesc(c).setDensity(0).setMass(W.mass / W.cols.length).setFriction(0.9).setCollisionGroups(GROUP_DYN), body));
    if (!W.ownWheels) for (const w of Object.values(W.wheels)) cols.push(this.world.createCollider(R.ColliderDesc.cylinder(0.08, 0.6).setTranslation(...w).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }).setMass(10).setCollisionGroups(GROUP_DYN), body));
    const e = this.addEnt({ kind: 'wagon', sub: 'wagon', size: [1.1, 1.3, 2.1], shape: 'box', mass: W.mass }, body, cols);
    this.wagon = e;
    return e;
  }

  addProp(sub: string, p: V3, o: { yaw?: number; value?: number; owned?: boolean; price?: number; item?: string; label?: string; mass?: number; shape?: PropSpec['shape']; size?: V3; color?: string } = {}): Ent {
    const R = this.R;
    const spec = PROPS[sub] ?? { shape: o.shape ?? 'box', size: o.size ?? [0.3, 0.3, 0.3], mass: o.mass ?? 20, buoy: 1, color: o.color ?? '#aa8866', label: '' };
    const size = o.size ?? spec.size, mass = o.mass ?? spec.mass, shape = o.shape ?? spec.shape;
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(...p).setRotation(yawQ(o.yaw ?? 0)).setLinearDamping(0.15).setAngularDamping(0.4).setCcdEnabled(mass < 6));
    const cd = shape === 'box' ? R.ColliderDesc.cuboid(...size) : shape === 'cylinder' ? R.ColliderDesc.cylinder(size[1], size[0]) : shape === 'capsule' ? R.ColliderDesc.capsule(size[1], size[0]) : R.ColliderDesc.ball(size[0]);
    const col = this.world.createCollider(cd.setMass(mass).setFriction(0.7).setRestitution(0.1).setCollisionGroups(GROUP_DYN).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(mass * 90), body);
    return this.addEnt({ kind: 'prop', sub, size, shape, mass, price: o.price, owned: o.owned ?? true, value: o.value ?? 1, label: o.label ?? spec.label, color: o.color ?? spec.color, ...(o.item ?? spec.item ? { item: o.item ?? spec.item } : {}) }, body, [col],
      { prop: spec, item: o.item ?? spec.item, value: o.value ?? 1, owned: o.owned ?? true, price: o.price ?? 0, spawn: [...p], buoy: spec.buoy });
  }

  addNpc(id: string, name: string, p: V3, yaw: number, h = 1.6): Ent {
    const R = this.R;
    const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(p[0], p[1] + h / 2, p[2]).setRotation(yawQ(yaw)));
    const col = this.world.createCollider(R.ColliderDesc.capsule(h / 2 - 0.3, 0.3).setCollisionGroups(GROUP_DYN), body);
    return this.addEnt({ kind: 'npc', sub: id, size: [0.3, h / 2 - 0.3, 0], shape: 'capsule', label: name }, body, [col], { npc: { id, name } });
  }

  addAnimal(kind: string, p: V3, a: { kg: number; speed: number; danger: number; flee: number; name: string }): Ent {
    const R = this.R;
    const len = clamp(Math.cbrt(a.kg / 60) * 1.3, 0.35, 6), r = clamp(len * 0.28, 0.15, 1.4);
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p[0], p[1] + r + 0.05, p[2]).lockRotations().setLinearDamping(0.5));
    // a capsule lying along Z (the body's forward)
    const col = this.world.createCollider(R.ColliderDesc.capsule(Math.max(0.01, len / 2 - r), r).setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }).setMass(a.kg).setFriction(0.6).setCollisionGroups(GROUP_DYN).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(a.kg * 60), body);
    const hp = a.kg < 30 ? 1 : a.kg < 100 ? 2 : a.kg < 250 ? 4 : 6;
    return this.addEnt({ kind: 'animal', sub: kind, size: [r, len / 2 - r, len], shape: 'capsule', mass: a.kg, label: a.name }, body, [col],
      { animal: { kind, state: 'wander', hp, t: 0, dir: Math.random() * 6.28, home: [...p], speed: a.speed, danger: a.danger, flee: a.flee, kg: a.kg, atkCd: 0 }, spawn: [...p], value: a.kg, buoy: 1.1 });
  }

  /** A kinematic moving platform (the ferry). */
  addPlatform(p: V3, he: V3, sub = 'ferry'): Ent {
    const R = this.R;
    const body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(...p));
    const col = this.world.createCollider(R.ColliderDesc.cuboid(...he).setFriction(1).setCollisionGroups(GROUP_DYN), body);
    return this.addEnt({ kind: 'platform', sub, size: he, shape: 'box' }, body, [col]);
  }

  remove(e: Ent, why = '') {
    if (e.gone) return;
    e.gone = true;
    if (why) e.lost = why;
    for (const p of this.players.values()) if (p.grab?.ent === e.id) p.grab = null;
    if (e.body) { for (const c of e.cols) this.colEnt.delete(c.handle); this.world.removeRigidBody(e.body); e.body = null; }
    this.ents.delete(e.id);
    this.despawned.push(e.id);
  }

  // ---------------------------------------------------------------- players
  addPlayer(id: string, height: number, p: V3, yaw = 0): PlayerPhys {
    const old = this.players.get(id);
    if (old) this.removePlayer(id);
    const R = this.R;
    const st = sizeStats(height);
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p[0], p[1] + st.height / 2 + 0.02, p[2]).setRotation(yawQ(yaw)).lockRotations().setLinearDamping(0.05).setCcdEnabled(false));
    const col = this.world.createCollider(R.ColliderDesc.capsule(st.half, st.radius).setMass(st.mass).setFriction(0.0).setFrictionCombineRule(R.CoefficientCombineRule.Min).setCollisionGroups(GROUP_PLAYER)
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(st.mass * 80), body);
    const e = this.addEnt({ kind: 'player', sub: id, size: [st.radius, st.half, 0], shape: 'capsule', mass: st.mass }, body, [col]);
    const pl: PlayerPhys = {
      id, ent: e.id, st, body, col, input: { ...emptyInput(), yaw }, prevButtons: 0, lastSeq: -1, lastInputAt: 0,
      ragdoll: 0, grounded: false, groundEnt: 0, air: 0, jumpCd: 0, seat: -1, grab: null, downed: false, ghost: false,
      inWater: 0, swept: false, anim: ANIM.idle, speed: 0, fallV: 0, useHold: 0, fireCd: 0, stun: 0, speedMul: 1, inverted: false, strengthMul: 1, gamePrev: 0,
    };
    this.players.set(id, pl);
    return pl;
  }
  removePlayer(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    const e = this.ents.get(p.ent);
    if (e) this.remove(e);
    for (const o of this.players.values()) if (o.grab && o.grab.ent === p.ent) o.grab = null;
    this.players.delete(id);
  }
  playerOfEnt(ent: number): PlayerPhys | null { for (const p of this.players.values()) if (p.ent === ent) return p; return null; }
  pos(b: Body): V3 { const t = b.translation(); return [t.x, t.y, t.z]; }
  feet(p: PlayerPhys): V3 { const t = p.body.translation(); return [t.x, t.y - p.st.height / 2, t.z]; }
  eye(p: PlayerPhys): V3 { const t = p.body.translation(); return [t.x, t.y - p.st.height / 2 + p.st.eye, t.z]; }
  aimDir(p: PlayerPhys): V3 { const { yaw, pitch } = p.input; const c = Math.cos(pitch); return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c]; }

  setInput(id: string, f: InputFrame, now: number) {
    const p = this.players.get(id);
    if (!p) return;
    // sequence numbers wrap at 16 bits; accept newer (or a fresh start)
    const d = (f.seq - p.lastSeq) & 0xffff;
    if (p.lastSeq >= 0 && (d === 0 || d > 0x8000)) return;
    p.lastSeq = f.seq;
    p.input = f;
    p.lastInputAt = now;
  }

  ragdoll(p: PlayerPhys, secs: number, impulse?: V3) {
    if (p.ghost) return;
    if (p.seat >= 0) this.unseat(p);
    p.ragdoll = Math.max(p.ragdoll, secs);
    p.body.enableCcd(true);   // (only while flying around: CCD on every walking capsule cost every step)
    p.body.setEnabledRotations(true, true, true, true);
    p.body.setAngularDamping(1.2);
    if (impulse) p.body.applyImpulse({ x: impulse[0], y: impulse[1], z: impulse[2] }, true);
    p.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * p.st.mass * 0.6, y: 0, z: (Math.random() - 0.5) * p.st.mass * 0.6 }, true);
    if (p.grab && Math.random() < 0.7) p.grab = null; // butterfingers
  }
  private standUp(p: PlayerPhys) {
    p.body.enableCcd(false);
    p.body.setEnabledRotations(false, false, false, true);
    p.body.setRotation(yawQ(p.input.yaw), true);
    p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    p.body.setAngularDamping(0);
    const t = p.body.translation();
    p.body.setTranslation({ x: t.x, y: t.y + 0.15, z: t.z }, true);
  }

  // ---------------------------------------------------------------- seats (wagon)
  seatPose(i: number): { p: V3; yaw: number } | null {
    const w = this.wagon?.body;
    if (!w) return null;
    const s = this.wagonSpec.seats[i];
    if (!s) return null;
    const kin = w.bodyType() === this.R.RigidBodyType.KinematicPositionBased;
    const t = kin && w.nextTranslation ? w.nextTranslation() : w.translation(), wq = kin && w.nextRotation ? w.nextRotation() : w.rotation();
    const p = rotV(s.p, wq);
    const wyaw = quatYaw(wq);
    return { p: [t.x + p[0], t.y + p[1], t.z + p[2]], yaw: wyaw + s.yaw };
  }
  freeSeat(p: PlayerPhys): number {
    const taken = new Set([...this.players.values()].filter((o) => o !== p && o.seat >= 0).map((o) => o.seat));
    const seats = this.wagonSpec.seats;
    const fits = (i: number) => { const s = seats[i]; return !s.sizes || s.sizes.includes(p.st.cls); };
    const idx = seats.map((_, i) => i);
    // big people ride on the roof / standing spots first; a macro only fits there
    const order = p.st.cls === 'macro' || p.st.cls === 'large' ? [...idx.filter((i) => seats[i].sizes), ...idx.filter((i) => !seats[i].sizes)] : idx;
    for (const i of order) { if (taken.has(i) || !fits(i) || i === this.driverSeat) continue; if (p.st.cls === 'macro' && !seats[i].sizes) continue; return i; }
    return -1;
  }
  sit(p: PlayerPhys, i: number) {
    if (i < 0 || p.downed) return;
    if (p.grab) p.grab = null;
    p.seat = i;
    p.ragdoll = 0;
    p.body.setEnabledRotations(false, false, false, true);
    p.body.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
    this.followSeat(p, true);
  }
  unseat(p: PlayerPhys, hop = true) {
    if (p.seat < 0) return;
    const seat = p.seat;
    p.seat = -1;
    // v2 journey: step off to the side of your seat onto the ground (not into the bed of a rolling wagon)
    const w = this.wagon?.body;
    if (this.wagonPose && w && seat < 100) {
      const sp = this.wagonSpec.seats[seat]?.p ?? [0, 0, 0];
      let hw = 1.2;
      for (const c of this.wagonSpec.cols) { const he = c.he ?? [c.r ?? 0.5, c.hh ?? 0.5, c.r ?? 0.5]; hw = Math.max(hw, Math.abs(c.p[0]) + he[0]); }
      const side = sp[0] >= 0 ? 1 : -1;
      const off = rotV([side * (hw + 0.5 + p.st.radius), 0.2, sp[2]], w.rotation());
      const t = w.translation();
      p.body.setTranslation({ x: t.x + off[0], y: t.y + off[1] + p.st.height / 2 + 0.3, z: t.z + off[2] }, true);
    }
    p.body.setBodyType(this.R.RigidBodyType.Dynamic, true);
    p.body.setRotation(yawQ(p.input.yaw), true);
    const v = this.wagonVel;
    p.body.setLinvel({ x: v[0], y: hop ? 3 : 0, z: v[2] }, true);
  }
  private followSeat(p: PlayerPhys, snap = false) {
    const s = this.seatPose(p.seat);
    if (!s) return;
    const y = s.p[1] + p.st.height / 2;
    const q = yawQ(s.yaw);
    if (snap) { p.body.setTranslation({ x: s.p[0], y, z: s.p[2] }, true); p.body.setRotation(q, true); }
    else { p.body.setNextKinematicTranslation({ x: s.p[0], y, z: s.p[2] }); p.body.setNextKinematicRotation(q); }
  }

  // ---------------------------------------------------------------- stowing cargo into the wagon
  stow(e: Ent) {
    const w = this.wagon?.body;
    if (!w || !e.body || e.stowed || (e.held && this.time - e.held < 0.3)) return;   // (held = last time someone held it)
    const wp = this.pos(w), wq = w.rotation();
    const inv = { x: -wq.x, y: -wq.y, z: -wq.z, w: wq.w };
    const p = this.pos(e.body);
    e.stowLocal = rotV([p[0] - wp[0], p[1] - wp[1], p[2] - wp[2]], inv);
    const q = e.body.rotation();
    e.stowQ = qmul([inv.x, inv.y, inv.z, inv.w], [q.x, q.y, q.z, q.w]);
    e.stowed = true;
    e.body.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
  }
  unstow(e: Ent, impulse?: V3) {
    if (!e.stowed || !e.body) return;
    e.stowed = false;
    e.restT = 0;
    e.body.setBodyType(this.R.RigidBodyType.Dynamic, true);
    const v = this.wagonVel;
    e.body.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
    if (impulse) e.body.applyImpulse({ x: impulse[0], y: impulse[1], z: impulse[2] }, true);
  }
  inCargo(pt: V3): boolean {
    const w = this.wagon?.body;
    if (!w) return false;
    const wp = this.pos(w), wq = w.rotation();
    const l = rotV([pt[0] - wp[0], pt[1] - wp[1], pt[2] - wp[2]], { x: -wq.x, y: -wq.y, z: -wq.z, w: wq.w });
    const c = this.wagonSpec.cargo;
    return Math.abs(l[0] - c.p[0]) <= c.he[0] + 0.1 && Math.abs(l[1] - c.p[1]) <= c.he[1] + 0.35 && Math.abs(l[2] - c.p[2]) <= c.he[2] + 0.1;
  }
  nearWagon(pt: V3, r = 4): boolean { const w = this.wagon?.body; if (!w) return false; const wp = this.pos(w); return Math.hypot(pt[0] - wp[0], pt[2] - wp[2]) < r; }
  inRevive(pt: V3): boolean {
    const w = this.wagon?.body;
    if (!w) return false;
    const wp = this.pos(w), wq = w.rotation();
    const l = rotV([pt[0] - wp[0], pt[1] - wp[1], pt[2] - wp[2]], { x: -wq.x, y: -wq.y, z: -wq.z, w: wq.w });
    const z = this.wagonSpec.revive;
    return Math.abs(l[0] - z.p[0]) <= z.he[0] && Math.abs(l[1] - z.p[1]) <= z.he[1] && Math.abs(l[2] - z.p[2]) <= z.he[2];
  }
  zone(name: string): ZoneDesc | undefined { return this.zones.find((z) => z.name === name); }
  inZoneNamed(name: string, pt: V3): boolean { const z = this.zone(name); return !!z && inZone(z, pt[0], pt[1], pt[2]); }

  // ---------------------------------------------------------------- the step
  step(dt: number, now: number) {
    this.time += dt;
    this.moveWagon(dt);
    for (const p of this.players.values()) this.stepPlayer(p, dt, now);
    this.softPush(dt);
    for (const p of this.players.values()) this.stepGrab(p, dt);
    for (const e of this.ents.values()) {
      if (!e.body || e.gone) continue;
      if (e.stowed) { this.followStow(e); continue; }
      if (e.info.kind === 'prop' || e.info.kind === 'animal') this.waterForces(e.body, e.buoy, e.prop?.size ?? e.info.size, dt);
    }
    this.world.step(this.queue);
    this.queue.drainContactForceEvents((ev) => {
      const a = this.entOfCollider(this.world.getCollider(ev.collider1())), b = this.entOfCollider(this.world.getCollider(ev.collider2()));
      const f = ev.totalForceMagnitude();
      for (const [x, y] of [[a, b], [b, a]] as const) {
        if (!x || x.info.kind !== 'player') continue;
        const p = this.playerOfEnt(x.id);
        if (!p || p.ghost) continue;
        const other = y?.info.kind ?? 'world';
        const acc = f / p.st.mass;
        if (other !== 'world' && other !== 'player' && acc > 260 && p.ragdoll <= 0) { this.ragdoll(p, 1.6); this.onImpact(p.id, Math.min(25, acc / 40), other === 'animal' ? 'an angry animal' : 'a flying crate'); }
      }
    });
    // stowed props: settle back in when they come to rest inside the wagon
    for (const e of this.ents.values()) {
      if (!e.body || e.stowed || (e.held && this.time - e.held < 0.3) || e.info.kind !== 'prop' || !this.wagon) continue;
      const v = e.body.linvel(), wv = this.wagonVel;
      const rel = Math.hypot(v.x - wv[0], v.y - wv[1], v.z - wv[2]);
      if (rel < 0.25 && this.inCargo(this.pos(e.body))) { e.restT += dt; if (e.restT > 0.8 && (this.wagonVel[2] !== 0 || this.wagonRoll === 0)) this.stow(e); }
      else e.restT = 0;
    }
  }

  /** Players overlapping each other drift apart (the heavier one moves less) — no solver contacts, no jitter. */
  private softPush(dt: number) {
    const list = this.pushList;
    list.length = 0;
    for (const p of this.players.values()) if (!p.ghost && p.seat < 0 && p.ragdoll <= 0 && !p.downed) list.push(p);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const ta = a.body.translation(), tb = b.body.translation();
      const dx = tb.x - ta.x, dz = tb.z - ta.z, d2 = dx * dx + dz * dz, rr = a.st.radius + b.st.radius;
      if (d2 >= rr * rr || Math.abs(tb.y - ta.y) > a.st.half + b.st.half + a.st.radius + b.st.radius) continue;
      const d = Math.sqrt(d2) || 1e-3, over = rr - d;
      const nx = d2 > 1e-8 ? dx / d : 1, nz = d2 > 1e-8 ? dz / d : 0;
      const push = Math.min(4, over * 10);                        // m/s of separation, gentle
      const wa = b.st.mass / (a.st.mass + b.st.mass), wb = 1 - wa;
      const va = a.body.linvel(), vb = b.body.linvel();
      a.body.setLinvel({ x: va.x - nx * push * wa, y: va.y, z: va.z - nz * push * wa }, true);
      b.body.setLinvel({ x: vb.x + nx * push * wb, y: vb.y, z: vb.z + nz * push * wb }, true);
    }
    void dt;
  }
  private pushList: PlayerPhys[] = [];

  /** Kinematic wagon motion: velocity integration + roll (tipping). */
  private moveWagon(dt: number) {
    const w = this.wagon?.body;
    if (!w || w.bodyType() !== this.R.RigidBodyType.KinematicPositionBased) return;
    if (this.wagonPose) {
      const { p, q } = this.wagonPose;
      w.setNextKinematicTranslation({ x: p[0], y: p[1], z: p[2] });
      w.setNextKinematicRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
      return;
    }
    const t = w.translation();
    const yaw = quatYaw(w.rotation());
    w.setNextKinematicTranslation({ x: t.x + this.wagonVel[0] * dt, y: t.y + this.wagonVel[1] * dt, z: t.z + this.wagonVel[2] * dt });
    const qy = yawQ(yaw), qr: [number, number, number, number] = [0, 0, Math.sin(this.wagonRoll / 2), Math.cos(this.wagonRoll / 2)];
    const q = qmul([qy.x, qy.y, qy.z, qy.w], qr);
    w.setNextKinematicRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
  }
  setWagon(p: V3, yaw: number) {
    const w = this.wagon?.body;
    if (!w) return;
    w.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
    w.setRotation(yawQ(yaw), true);
    for (const e of this.ents.values()) if (e.stowed) this.followStow(e, true);
    for (const pl of this.players.values()) if (pl.seat >= 0) this.followSeat(pl, true);
  }
  private followStow(e: Ent, snap = false) {
    const w = this.wagon?.body;
    if (!w || !e.body || !e.stowLocal || !e.stowQ) return;
    // the wagon's NEXT kinematic pose (props must move with it this step, not one behind)
    const wt = w.nextTranslation ? w.nextTranslation() : w.translation();
    const wq = w.nextRotation ? w.nextRotation() : w.rotation();
    const p = rotV(e.stowLocal, wq);
    const q = qmul([wq.x, wq.y, wq.z, wq.w], e.stowQ);
    if (snap) { e.body.setTranslation({ x: wt.x + p[0], y: wt.y + p[1], z: wt.z + p[2] }, true); e.body.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true); }
    else { e.body.setNextKinematicTranslation({ x: wt.x + p[0], y: wt.y + p[1], z: wt.z + p[2] }); e.body.setNextKinematicRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }); }
  }

  /** Solid ground all along the straight line a→b (bots: don't walk off floating islands)? Samples every 1.5 m. */
  groundAlong(a: V3, b: V3, drop = 4): boolean {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 1.5));
    for (let i = 1; i <= n; i++) {
      const t = i / n, x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t, y = Math.max(a[1], b[1]) + 2;
      const hit = this.world.castRay(new this.R.Ray({ x, y, z }, { x: 0, y: -1, z: 0 }), drop + 2 + Math.abs(a[1] - b[1]), true, undefined, 0x00010001); // level geometry only
      if (!hit) return false;
    }
    return true;
  }
  private groundProbe(p: PlayerPhys): { hit: boolean; ent: number; dist: number } {
    const t = p.body.translation();
    const R = this.R;
    const from = { x: t.x, y: t.y - p.st.half, z: t.z };
    const ray = new R.Ray(from, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, p.st.radius + 0.12 + p.st.height * 0.02, true, undefined, undefined, p.col, p.body, (c) => !c.isSensor());
    if (!hit) return { hit: false, ent: 0, dist: 1e9 };
    const e = this.entOfCollider(hit.collider);
    return { hit: true, ent: e?.id ?? 0, dist: hit.toi };
  }

  // ---------------------------------------------------------------- shoulder rides (v2: small folks ride big ones)
  /** `p` climbs onto `carrier`'s shoulders (kinematic, follows them; jump / E to hop off). */
  mountOn(p: PlayerPhys, carrier: PlayerPhys) {
    if (p === carrier || p.seat >= 0 || carrier.mount || [...this.players.values()].some((o) => o.mount === carrier.id)) return false;
    if (p.grab) p.grab = null;
    p.mount = carrier.id;
    p.ragdoll = 0;
    p.body.setEnabledRotations(false, false, false, true);
    p.body.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
    this.followMount(p, true);
    return true;
  }
  dismount(p: PlayerPhys) {
    if (!p.mount) return;
    const c = this.players.get(p.mount);
    p.mount = undefined;
    p.body.setBodyType(this.R.RigidBodyType.Dynamic, true);
    const v = c ? c.body.linvel() : { x: 0, y: 0, z: 0 };
    p.body.setLinvel({ x: v.x, y: 3, z: v.z }, true);
  }
  private followMount(p: PlayerPhys, snap = false) {
    const c = p.mount ? this.players.get(p.mount) : null;
    if (!c || c.ragdoll > 0 || c.downed || c.seat >= 0 || c.ghost) { this.dismount(p); return; }
    const t = c.body.translation();
    const y = t.y + c.st.half + c.st.radius * 0.6 + p.st.height * 0.32;
    const q = yawQ(c.input.yaw);
    if (snap) { p.body.setTranslation({ x: t.x, y, z: t.z }, true); p.body.setRotation(q, true); }
    else { p.body.setNextKinematicTranslation({ x: t.x, y, z: t.z }); p.body.setNextKinematicRotation(q); }
  }

  private stepPlayer(p: PlayerPhys, dt: number, now: number) {
    const b = p.body;
    if (p.mount) {
      this.followMount(p);
      if (p.mount) {
        p.anim = ANIM.sit; p.speed = 0; p.grounded = true;
        const pressed = p.input.buttons & ~p.prevButtons;
        if (pressed & BTN.jump) this.dismount(p);
        p.prevButtons = p.input.buttons;
        return;
      }
    }
    if (p.seat >= 0) {
      this.followSeat(p);
      p.anim = p.seat === this.driverSeat ? ANIM.drive : ANIM.sit; p.speed = 0; p.grounded = true;
      const pressed = p.input.buttons & ~p.prevButtons;
      if (p.seat !== this.driverSeat && (pressed & BTN.jump || p.input.mz > 0.6 || p.input.mz < -0.6 || Math.abs(p.input.mx) > 0.6)) this.unseat(p);
      p.prevButtons = p.input.buttons;
      return;
    }
    const inp = now - p.lastInputAt > 1500 ? { ...p.input, mx: 0, mz: 0, buttons: 0 } : p.input;
    const pressed = inp.buttons & ~p.prevButtons;
    p.prevButtons = inp.buttons;
    p.jumpCd = Math.max(0, p.jumpCd - dt);
    p.fireCd = Math.max(0, p.fireCd - dt);
    p.stun = Math.max(0, p.stun - dt);
    const v = b.linvel();
    // water
    const water = this.waterAt(this.feet(p));
    p.inWater = water ? water.depth : 0;
    const wade = p.st.wade;
    p.swept = !p.ghost && !!water && water.depth > wade && (Math.abs(water.w.flow[0]) + Math.abs(water.w.flow[1]) > 0.5);
    if (water && !p.ghost) this.waterForces(b, p.st.cls === 'micro' ? 1.3 : p.swept ? 1.05 : 0.6, [p.st.radius, p.st.height / 2, p.st.radius], dt, p.swept ? 1.4 : 0.6);
    if (p.swept && p.ragdoll <= 0 && Math.random() < dt * 0.35) this.ragdoll(p, 1.5);
    // ragdoll: no control; stand up when slow
    if (p.ragdoll > 0) {
      p.ragdoll -= dt;
      p.anim = ANIM.ragdoll;
      p.speed = Math.hypot(v.x, v.z);
      if (p.ragdoll <= 0) { if (Math.hypot(v.x, v.y, v.z) < 2.5 && !p.downed) this.standUp(p); else p.ragdoll = 0.3; }
      return;
    }
    if (p.downed) { p.anim = ANIM.dead; return; }
    // ground
    const g = this.groundProbe(p);
    const wasAir = !p.grounded;
    p.grounded = g.hit;
    p.groundEnt = g.ent;
    if (p.grounded && wasAir && p.fallV < -9.5 && !p.ghost) {
      this.onImpact(p.id, (-p.fallV - 9.5) * 5, 'a long fall');
      this.ragdoll(p, 1.2);
      p.fallV = 0;
      return;
    }
    p.fallV = p.grounded ? 0 : Math.min(p.fallV, v.y);
    // movement: view-relative intent → world velocity target
    let mx = inp.mx, mz = inp.mz;
    if (p.inverted) { mx = -mx; mz = -mz; }
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    const yaw = inp.yaw;
    const fwd: V3 = [-Math.sin(yaw), 0, -Math.cos(yaw)], right: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const sprint = (inp.buttons & BTN.sprint) !== 0;
    let speed = (sprint ? p.st.sprint : p.st.walk) * p.speedMul * (p.swept ? 0.18 : water && water.depth > wade * 0.6 ? 0.6 : 1) * (p.grab ? this.carrySlow(p) : 1) * (p.stun > 0 ? 0.3 : 1);
    if (p.ghost) speed *= 1.1;
    const tx = (right[0] * mx + fwd[0] * mz) * speed, tz = (right[2] * mx + fwd[2] * mz) * speed;
    // standing on something moving (the rolling wagon, the ferry) carries you
    let gvx = 0, gvz = 0;
    if (p.grounded && g.ent) {
      const ge = this.ents.get(g.ent);
      if (ge?.body && (ge.info.kind === 'wagon' || ge.info.kind === 'platform' || ge.stowed)) { const gv = ge === this.wagon || ge.stowed ? { x: this.wagonVel[0], z: this.wagonVel[2] } : ge.body.linvel(); gvx = gv.x; gvz = gv.z; }
    }
    const acc = (p.grounded ? 34 : p.ghost ? 20 : 9) * dt;
    const dvx = clamp(tx + gvx - v.x, -acc, acc), dvz = clamp(tz + gvz - v.z, -acc, acc);
    let vy = v.y;
    if (p.ghost) { vy = vy * 0.9 + (Math.sin(this.time * 2) * 0.3 + (this.floorBelow(p) + 0.6 - this.feet(p)[1]) * 2) * 0.1; }
    if ((pressed & BTN.jump) && (p.grounded || (p.ghost && p.air < 0.5)) && p.jumpCd <= 0) { vy = jumpVelocity(p.st.jump) * (p.inWater > 0.3 ? 0.6 : 1); p.jumpCd = 0.35; }
    b.setLinvel({ x: v.x + dvx, y: vy, z: v.z + dvz }, true);
    p.air = p.grounded ? 0 : p.air + dt;
    p.speed = Math.hypot(v.x - gvx, v.z - gvz);
    const held = p.grab ? this.ents.get(p.grab.ent) : null;
    const heavy = !!held && (held.info.kind === 'wagon' || (held.info.mass ?? 10) > p.st.lift * p.strengthMul * 0.75);
    p.anim = !p.grounded ? (v.y > 0.5 ? ANIM.jump : ANIM.fall) : p.inWater > p.st.height * 0.45 ? ANIM.swim : p.grab ? (heavy ? ANIM.strain : ANIM.carry) : p.pushing ? ANIM.push : p.speed > p.st.walk * 1.6 ? ANIM.sprint : p.speed > p.st.walk * 1.15 ? ANIM.run : p.speed > 0.3 ? ANIM.walk : ANIM.idle;
    // body faces the view yaw (rotations are locked; set the pose directly)
    b.setRotation(yawQ(yaw), true);
    // grab / throw
    if (inp.buttons & BTN.grab) { if (!p.grab) this.tryGrab(p); }
    else if (p.grab) { const e = this.ents.get(p.grab.ent); p.grab = null; if (e) this.onRelease(p, e, false); }
    if ((pressed & BTN.throw) && p.grab) this.throwHeld(p);
    if (inp.hold > 0 && p.grab) p.grab.dist = clamp(inp.hold, 0.6, this.reach(p) + 1.5);
  }
  private floorBelow(p: PlayerPhys): number {
    const t = p.body.translation();
    const hit = this.world.castRay(new this.R.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 }), 30, true, undefined, undefined, p.col, p.body, (c) => !c.isSensor());
    return hit ? t.y - hit.toi : -2;
  }
  private carrySlow(p: PlayerPhys): number {
    const e = p.grab ? this.ents.get(p.grab.ent) : null;
    const m = e?.info.mass ?? 10;
    return clamp(1 - (m / (p.st.lift * p.strengthMul)) * 0.35, 0.45, 1);
  }
  reach(p: PlayerPhys) { return Math.max(1.8, p.st.height * 1.15) + (p.st.cls === "micro" ? 0.6 : 0); }

  // ---------------------------------------------------------------- grabbing
  tryGrab(p: PlayerPhys) {
    const R = this.R;
    const o = this.eye(p), d = this.aimDir(p);
    const hit = this.world.castRay(new R.Ray({ x: o[0], y: o[1], z: o[2] }, { x: d[0], y: d[1], z: d[2] }), this.reach(p), true, undefined, undefined, p.col, p.body, (c) => !c.isSensor());
    if (!hit) return;
    const e = this.entOfCollider(hit.collider);
    if (!e?.body || e.gone) return;
    if (e.info.kind === 'npc' || e.info.kind === 'platform') return;
    if (p.grabWant && e.id !== p.grabWant) return;
    if (e.info.kind === 'animal' && e.animal?.state !== 'dead') return;
    if (e.info.kind === 'player') {
      const other = this.playerOfEnt(e.id);
      if (!other || other.ghost) return;
      // standing people can't be picked up — unless they're tiny, ragdolled or downed (then: carry them!)
      if (!(other.ragdoll > 0 || other.downed || other.st.cls === 'micro' || (other.st.mass * 3 < p.st.lift * p.strengthMul))) return;
      if (other.ragdoll <= 0 && !other.downed) this.ragdoll(other, 2.5);
      other.ragdoll = Math.max(other.ragdoll, 0.5);
    }
    if (p.ghost && (e.info.mass ?? 10) > 5) return; // ghosts: only light things
    if (e.stowed) this.unstow(e);
    const pt: V3 = [o[0] + d[0] * hit.toi, o[1] + d[1] * hit.toi, o[2] + d[2] * hit.toi];
    const bp = this.pos(e.body), bq = e.body.rotation();
    const local = rotV([pt[0] - bp[0], pt[1] - bp[1], pt[2] - bp[2]], { x: -bq.x, y: -bq.y, z: -bq.z, w: bq.w });
    p.grab = { ent: e.id, local, dist: clamp(hit.toi, 0.7, this.reach(p)) };
  }
  private stepGrab(p: PlayerPhys, dt: number) {
    if (!p.grab) return;
    const e = this.ents.get(p.grab.ent);
    if (!e?.body || e.gone || p.ragdoll > 0 || p.downed || p.seat >= 0) { p.grab = null; return; }
    if (e.stowed) this.unstow(e);
    const b = e.body;
    const bq = b.rotation(), bp = this.pos(b);
    const off = rotV(p.grab.local, bq);
    const pt: V3 = [bp[0] + off[0], bp[1] + off[1], bp[2] + off[2]];
    const o = this.eye(p), d = this.aimDir(p);
    const tgt: V3 = [o[0] + d[0] * p.grab.dist, o[1] + d[1] * p.grab.dist, o[2] + d[2] * p.grab.dist];
    // lost grip: the point is far from the hands (a stuck heavy object)
    const gap = Math.hypot(tgt[0] - pt[0], tgt[1] - pt[1], tgt[2] - pt[2]);
    if (gap > this.reach(p) + 1.4) { p.grab = null; return; }
    const m = e.info.kind === 'wagon' ? this.wagonSpec.mass : b.mass();
    const vel = pointVel(b, pt);
    const pv = p.body.linvel();
    const k = 70, c = 13;
    // spring toward the hold point + damping (relative to the holder) + gravity compensation
    let fx = m * (k * (tgt[0] - pt[0]) - c * (vel[0] - pv.x)), fy = m * (k * (tgt[1] - pt[1]) - c * (vel[1] - pv.y) + G), fz = m * (k * (tgt[2] - pt[2]) - c * (vel[2] - pv.z));
    const maxF = p.st.lift * p.strengthMul * G * 1.35 + 60;
    const mag = Math.hypot(fx, fy, fz);
    if (mag > maxF) { const s = maxF / mag; fx *= s; fy *= s; fz *= s; }
    if (e.info.kind !== 'wagon' || b.bodyType() === this.R.RigidBodyType.Dynamic) {
      b.applyImpulseAtPoint({ x: fx * dt, y: fy * dt, z: fz * dt }, { x: pt[0], y: pt[1], z: pt[2] }, true);
      // tame spin on held things
      const av = b.angvel();
      b.setAngvel({ x: av.x * 0.9, y: av.y * 0.9, z: av.z * 0.9 }, true);
    }
    // reaction on the holder (heavy things drag you around; capped so you don't fly)
    const rk = clamp(m / (p.st.mass * 4), 0, 0.5);
    p.body.applyImpulse({ x: -fx * rk * dt, y: 0, z: -fz * rk * dt }, true);
    e.held = this.time;
  }
  private throwHeld(p: PlayerPhys) {
    const e = p.grab ? this.ents.get(p.grab.ent) : null;
    p.grab = null;
    if (!e?.body) return;
    this.onRelease(p, e, true);
    if (e.stowed) return;   // (thrown into the wagon: loaded)
    const d = this.aimDir(p);
    const m = e.body.mass();
    const imp = Math.min(p.st.lift * p.strengthMul * 0.32, m * 9);
    e.body.applyImpulse({ x: d[0] * imp, y: (d[1] + 0.25) * imp, z: d[2] * imp }, true);
    const other = e.info.kind === 'player' ? this.playerOfEnt(e.id) : null;
    if (other) this.ragdoll(other, 2.2);
  }
  /** Holders of an entity (multi-person lifts, repair checks). */
  holders(ent: number): PlayerPhys[] { return [...this.players.values()].filter((p) => p.grab?.ent === ent); }

  // ---------------------------------------------------------------- water
  waterAt(pt: V3): { w: WaterDesc; depth: number; sub: number } | null {
    for (const w of this.waters) {
      if (Math.abs(pt[0] - w.p[0]) > w.he[0] || Math.abs(pt[2] - w.p[2]) > w.he[2]) continue;
      const bed = w.level - w.depth;
      if (pt[1] > w.level + 0.05 || pt[1] < bed - 3) continue;
      return { w, depth: w.level - Math.max(bed, this.bedAt(pt, w)), sub: w.level - pt[1] };
    }
    return null;
  }
  /** Riverbed height under a point (the ramps near the banks make the depth vary). */
  private bedAt(pt: V3, w: WaterDesc): number {
    const hit = this.world.castRay(new this.R.Ray({ x: pt[0], y: w.level + 0.5, z: pt[2] }, { x: 0, y: -1, z: 0 }), w.depth + 3, true, undefined, undefined, undefined, undefined, (c) => {
      const e = this.entOfCollider(c); return !e && !c.isSensor();
    });
    return hit ? w.level + 0.5 - hit.toi : w.level - w.depth;
  }
  private waterForces(b: Body, buoy: number, size: V3 | [number, number, number], dt: number, flowK = 1) {
    if (!this.waters.length) return;
    const t = b.translation();
    const hy = size[1] || 0.3;
    for (const w of this.waters) {
      if (Math.abs(t.x - w.p[0]) > w.he[0] || Math.abs(t.z - w.p[2]) > w.he[2]) continue;
      const sub = clamp((w.level - (t.y - hy)) / (2 * hy), 0, 1);
      if (sub <= 0) return;
      const m = b.mass();
      const v = b.linvel();
      const lift = m * G * buoy * sub;
      const cur = 2.2 * flowK * sub;
      b.applyImpulse({ x: m * (cur * (w.flow[0] - v.x)) * dt, y: (lift - m * v.y * 1.4 * sub) * dt, z: m * (cur * (w.flow[1] - v.z)) * dt }, true);
      const av = b.angvel();
      b.setAngvel({ x: av.x * (1 - 0.8 * sub * dt), y: av.y * (1 - 0.8 * sub * dt), z: av.z * (1 - 0.8 * sub * dt) }, true);
      return;
    }
  }

  // ---------------------------------------------------------------- snapshots
  /** Entities to send: every player + anything that moved (> 1 cm / ~1°) since last sent + a keyframe every 1.5 s. */
  /** `delta` (the network channel): only what moved since the last delta snapshot; else everything (this PC's views). */
  snapshot(delta = true): EntSnap[] {
    const out: EntSnap[] = [];
    const t = this.time;
    for (const e of this.ents.values()) {
      if (!e.body) continue;
      const tr = e.body.translation(), r = e.body.rotation();
      const p: V3 = [tr.x, tr.y, tr.z], q: [number, number, number, number] = [r.x, r.y, r.z, r.w];
      const pl = e.info.kind === 'player' ? this.playerOfEnt(e.id) : null;
      const last = e.last;
      const moved = !last || Math.hypot(p[0] - last.p[0], p[1] - last.p[1], p[2] - last.p[2]) > 0.01 || Math.abs(q[0] * last.q[0] + q[1] * last.q[1] + q[2] * last.q[2] + q[3] * last.q[3]) < 0.99996 || t - last.t > 1.5;
      if (delta && !pl && !moved && !e.animal) continue;
      let flags = 0;
      if (e.held && t - e.held < 0.1) flags |= F.held;
      if (pl) {
        if (pl.ragdoll > 0) flags |= F.ragdoll;
        if (pl.seat >= 0 || pl.mount) flags |= F.seated;
        if (pl.downed) flags |= F.downed;
        if (pl.ghost) flags |= F.ghost;
        if (pl.inWater > 0.2) flags |= F.water;
        if (pl.swept) flags |= F.swept;
      }
      const s: EntSnap = { id: e.id, flags, p, q };
      if (pl) { s.yaw = pl.input.yaw; s.pitch = pl.input.pitch; s.anim = pl.anim; s.speed = pl.speed; s.hold = pl.grab?.ent ?? 0; s.ack = pl.lastSeq & 0xff; }
      else if (e.animal) { s.anim = e.animal.state === 'dead' ? ANIM.dead : e.animal.state === 'flee' ? ANIM.flee : e.animal.state === 'attack' ? ANIM.attack : e.animal.state === 'carry' ? ANIM.fly : e.body.linvel() && Math.hypot(e.body.linvel().x, e.body.linvel().z) > 0.4 ? ANIM.walk : ANIM.idle; s.speed = Math.hypot(e.body.linvel().x, e.body.linvel().z); }
      if (delta) e.last = { p, q, t };
      out.push(s);
    }
    return out;
  }
  /** Everything (a keyframe for late joiners / the OBS page). */
  allInfos(): EntInfo[] { return [...this.ents.values()].map((e) => ({ ...e.info, owned: e.owned, price: e.price, value: e.value })); }

  /** Shift everything along Z (the travel treadmill's floating origin). */
  rebase(dz: number, dx = 0) {
    for (const e of this.ents.values()) {
      if (!e.body) continue;
      const t = e.body.translation();
      e.body.setTranslation({ x: t.x + dx, y: t.y, z: t.z + dz }, true);
      if (e.body.bodyType() === this.R.RigidBodyType.KinematicPositionBased) e.body.setNextKinematicTranslation({ x: t.x + dx, y: t.y, z: t.z + dz });
      if (e.animal) { e.animal.home[0] += dx; e.animal.home[2] += dz; }
      e.spawn[0] += dx; e.spawn[2] += dz;
      if (e.last) { e.last.p[0] += dx; e.last.p[2] += dz; }
    }
    if (this.wagonPose) { this.wagonPose.p[0] += dx; this.wagonPose.p[2] += dz; }
    for (const c of this.chunks.values()) { const t = c.body.translation(); c.body.setTranslation({ x: t.x + dx, y: t.y, z: t.z + dz }, true); }
  }

  // ---------------------------------------------------------------- the loading ramp (v2: at stops, heavy things roll in)
  private ramp: Col | null = null;
  /** A plank from the wagon's tailgate down to the ground (a collider on the wagon body), or none. */
  setRamp(on: boolean) {
    const w = this.wagon?.body;
    if (!w) return;
    if (!on) { if (this.ramp) { this.world.removeCollider(this.ramp, true); this.ramp = null; } return; }
    if (this.ramp) return;
    let rear = -2, bed = 0.85;
    for (const c of this.wagonSpec.cols) { const he = c.he ?? [c.r ?? 0.5, c.hh ?? 0.5, c.r ?? 0.5]; if (c.p[2] - he[2] < rear) rear = c.p[2] - he[2]; }
    bed = this.wagonSpec.cargo.p[1] - this.wagonSpec.cargo.he[1];
    const len = Math.hypot(bed, 1.9), ang = Math.atan2(bed, 1.9);
    const R = this.R;
    this.ramp = this.world.createCollider(R.ColliderDesc.cuboid(0.55, 0.035, len / 2).setTranslation(0, bed / 2, rear - 0.95).setRotation({ x: Math.sin(-ang / 2), y: 0, z: 0, w: Math.cos(-ang / 2) }).setFriction(0.9).setCollisionGroups(GROUP_DYN), w);
  }
  get rampDown() { return !!this.ramp; }

  // ---------------------------------------------------------------- v2 journey terrain (heightfield chunks)
  /** A 64 m chunk: `heights` row-major N×N (z rows), centred at local (cx, cz); `solids` = trees / rocks as cylinders. */
  addChunk(key: string, n: number, size: number, heights: Float32Array, cx: number, cz: number, solids: { x: number; z: number; y: number; r: number }[]) {
    if (this.chunks.has(key)) return;
    const R = this.R;
    const hf = new Float32Array(n * n);
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) hf[iz + ix * n] = heights[iz * n + ix];   // (rapier: column-major, rows along z)
    const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(cx, 0, cz));
    const cols: Col[] = [this.world.createCollider(R.ColliderDesc.heightfield(n - 1, n - 1, hf, { x: size, y: 1, z: size }).setFriction(0.8).setCollisionGroups(GROUP_LEVEL), body)];
    for (const s of solids) cols.push(this.world.createCollider(R.ColliderDesc.cylinder(1.6, Math.max(0.2, s.r)).setTranslation(s.x - cx, s.y + 1.5, s.z - cz).setCollisionGroups(GROUP_LEVEL), body));
    this.chunks.set(key, { body, cols });
  }
  removeChunk(key: string) { const c = this.chunks.get(key); if (!c) return; this.world.removeRigidBody(c.body); this.chunks.delete(key); }
  chunkKeys(): string[] { return [...this.chunks.keys()]; }

  dispose() { try { this.world.free(); this.queue.free(); } catch { /* already freed */ } }
}

// ---------------------------------------------------------------- tiny math (no three.js in the sim)
export const yawQ = (y: number) => ({ x: 0, y: Math.sin(y / 2), z: 0, w: Math.cos(y / 2) });
export function quatYaw(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}
export function rotV(v: V3, q: { x: number; y: number; z: number; w: number }): V3 {
  const { x, y, z, w } = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
export function qmul(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
function pointVel(b: Body, pt: V3): V3 {
  const v = b.linvel(), w = b.angvel(), c = b.translation();
  const r: V3 = [pt[0] - c.x, pt[1] - c.y, pt[2] - c.z];
  return [v.x + w.y * r[2] - w.z * r[1], v.y + w.z * r[0] - w.x * r[2], v.z + w.x * r[1] - w.y * r[0]];
}
