// The Trail — the host's authoritative game director (DESIGN.md §2–§11): lobby → store → travel (days, votes,
// events) → stops (river / hunt / landmark / camp / event scenes) → finish / wipe. Physics in world.ts, pure rules in
// shared/trail/rules.ts. No DOM / no wall clock: `step(dt)` at a fixed 60 Hz; runs in the host's Worker or in Node.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { Rng, seedCode } from '../../../../shared/trail/rng.ts';
import { sizeStats } from '../../../../shared/trail/sizes.ts';
import {
  addMember, applyEffects, choiceBlocked, dayTick, everyone, fill, fireEvent, hasRole, kill, living, milesPerDay, newRun, pickTarget, priceOf,
  resolveChoice, revive, riverAt, routeOf, score, speedFactor, tally, type Ctx, type Resolution,
} from '../../../../shared/trail/rules.ts';
import { botChoice, buyList, shoppingList } from '../../../../shared/trail/autoplay.ts';
import { ROAD_REBASE, ROAD_SPEED, WAGON, buildJourney, buildLevel, cargoSlot, cargoSlotCount, inZone, type LevelDesc, type V3, type WagonSpec } from '../../../../shared/trail/levels.ts';
import { viewDesc } from '../../../../shared/trail/glbLevel.ts';
import { ANIM, BTN, emptyInput, type EntInfo, type InputFrame, type TrailCmd, type TrailCtl, type TrailEvent } from '../../../../shared/trail/wire.ts';
import {
  ITEM_IDS, ROLE_IDS, type CardState, type Deck, type DeckEvent, type GameState, type Grave, type ItemId, type PlayerInfo, type RiverChoice,
  type RoleId, type RouteNode, type RunState, type StopKind, type StopState, type VoteOption, type VoteState,
} from '../../../../shared/trail/types.ts';
import { GROUP_GHOST, GROUP_PLAYER, PhysWorld, quatYaw, rotV, yawQ, type Ent, type PlayerPhys } from './world.ts';
import { Journey, type Drive } from './journey.ts';
import { Camp } from './camp.ts';
import { genStopFor } from './stops.ts';
import { MemeDirector } from './memes.ts';
import type { SimCtx } from './ctx.ts';

type R = typeof RAPIER_NS;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const COLORS = ['#7cff4f', '#ff4fd8', '#39d9ff', '#ffd23f', '#ff7a3d', '#b48cff', '#4fffc3', '#ff4f6d'];
/** Physical event scenes this build implements (everything else resolves through its card fallback). */
export const PHYSICAL_STOPS = new Set(['wheel', 'voice:sing', 'voice:talent', 'trail3d:pothole', 'runs', 'photo', 'mud', 'search', 'ghostrace', 'chase', 'stampede', 'thieves']);
const DAY_LEN = 2.2;
/** v2 journey: seconds per TRAIL day (food, health, events) and per visual day (the sky: 3 trail days). */
export const TRAIL_DAY = 30, VISUAL_DAY = 180;
/** Emotes (G wheel). */
export const EMOTES = ['wave', 'dance', 'point', 'facepalm', 'cheer', 'laugh', 'sit', 'soundbite'] as const;
/** Max physical props per item kind in the wagon (the rest is represented by larger values per prop). */
const CARGO_CAP: Record<string, number> = { food: 8, ammo: 3, clothes: 4, medicine: 3, wheel: 2, axle: 2, tongue: 1, meme: 1 };
const ITEM_PROP: Record<string, string> = { food: 'crate_food', ammo: 'ammo_box', clothes: 'clothes_bundle', medicine: 'medicine', wheel: 'spare_wheel', axle: 'spare_axle', tongue: 'spare_tongue', meme: 'meme_frog', draft: 'draft' };

export interface SimOpts { deck: Deck; R: R; hostId: string; seed?: string; slice?: boolean; graves?: Grave[]; log?: (s: string) => void;
  /** Levels from the theme pack (trailart's GLBs, read by glbLevel.ts) by kind; missing kinds use the grey-box builders. */
  levels?: Record<string, LevelDesc>;
  /** Bots' river choice (tests). */
  botRiver?: string;
  /** The theme's wagon (from its wagon.glb). */
  wagon?: WagonSpec;
  /** Tests: the first bot takes the driver bench and drives (instead of the animals' autopilot). */
  botDrive?: boolean }
interface VoteCb { done: (result: string, how: string) => void; minVoters: number }
interface EventCtx { e: DeckEvent; target: string | null; volunteer: string | null; extra: Record<string, string | number>; backup?: string }
interface Mini {
  kind: string; t: number; dur: number; progress: number; goal: number; ev?: EventCtx; choice?: string;
  data: Record<string, number | string | boolean>; goalZone?: { p: V3; he: V3 };
}

const DEBUG_BOTS = typeof process !== 'undefined' && !!(process as { env?: Record<string, string | undefined> }).env?.TRAIL_BOT_DEBUG;

export class TrailSim {
  readonly deck: Deck;
  readonly R: R;
  private levels: Record<string, LevelDesc>;
  private botRiver: string;
  private wagonSpec: WagonSpec;
  state: GameState;
  run: RunState | null = null;
  phys: PhysWorld;
  level: LevelDesc;
  private levelSeq = 0;
  private rng: Rng; private misc: Rng;
  private out: TrailCtl[] = [];
  private dirty = true;
  private time = 0;
  private tick = 0;
  private dayAcc = 0;
  private voteCb: VoteCb | null = null;
  private cardQueue: { card: Omit<CardState, 'until'>; secs: number; then?: () => void }[] = [];
  private cardThen: (() => void) | null = null;
  private mini: Mini | null = null;
  private pendingEv: EventCtx | null = null;
  private stopTimer = 0;
  private stopData: Record<string, unknown> = {};
  private afterStop: (() => void) | null = null;
  private downed = new Map<string, { t: number; cause: string; revive: number }>();
  private graves: Grave[];
  private bots = new Map<string, { t: number; task: string; target: number; voteAt: number; talk: number; key?: string; chase?: number; skip?: Set<number>; last?: V3; still?: number; dodge?: number; dodgeDir?: number }>();
  voice: Record<string, { vad: number; expr: number }> = {};
  readonly log: (s: string) => void;
  /** Deaths / run end for the host's persistence (session reads + clears). */
  readonly persist: { graves: Grave[]; runEnd: RunState | null } = { graves: [], runEnd: null };
  perf = { stepMs: 0, maxStepMs: 0, bodies: 0 };
  /** v2: the driven procedural journey (made when the run starts). */
  journey: Journey | null = null;
  private camp: Camp | null = null;
  private memes: MemeDirector | null = null;
  private botDrive = false;
  /** Seconds into the current trail day; the leg to place the wagon at on the next enterTravel (-1: stay put). */
  private jDay = 0;
  private jLeg = -1;
  private vday = 0;
  private duskAsked = -1;
  private nightDrive = false;
  private crashCd = 0;
  private campStill = 0;
  private forkAsked = '';
  private driverIdle = 0;
  private emoteAt = new Map<string, number>();
  /** trailstops: the theme pack's fixed stop maps instead of generated ones (lobby key 'classicMaps'); hunts so far. */
  private classicMaps = false;
  private huntN = 0;

  constructor(o: SimOpts) {
    this.deck = o.deck; this.R = o.R; this.log = o.log ?? (() => {});
    this.levels = o.levels ?? {};
    this.botRiver = o.botRiver ?? '';
    this.botDrive = !!o.botDrive;
    this.wagonSpec = o.wagon ?? WAGON;
    this.graves = o.graves ?? [];
    const seed = o.seed ?? seedCode(o.deck.id);
    this.rng = new Rng(`${seed}:events`); this.misc = new Rng(`${seed}:misc`);
    this.state = {
      v: 1, rev: 1, phase: 'lobby', theme: o.deck.id, seed, now: 0, players: [], run: null, vote: null, card: null, stop: null, rolling: false, paused: false, dayLen: DAY_LEN,
      lobby: { slice: o.slice ?? true, modifiers: [], chatVotes: false, chaosConsent: true, daily: false }, epitaphs: {},
    };
    this.level = this.makeLevel('store', { lobby: true });
    this.phys = new PhysWorld(this.R, this.level);
    this.phys.wagonSpec = this.wagonSpec;
    this.phys.addWagon(this.level.wagon.p, this.level.wagon.yaw);
    this.wirePhys();
    this.sendLevel('lobby');
  }

  // ================================================================ public API (session / worker)
  join(p: { id: string; name: string; height: number; role?: RoleId; host?: boolean; bot?: boolean }) {
    let info = this.state.players.find((x) => x.id === p.id);
    if (!info) {
      const st = sizeStats(p.height);
      info = { id: p.id, name: p.name.slice(0, 40), role: p.role ?? ROLE_IDS[this.state.players.length % ROLE_IDS.length], height: st.height, cls: st.cls, color: COLORS[this.state.players.length % COLORS.length], ready: !!p.bot, connected: true, host: !!p.host, bot: p.bot };
      this.state.players.push(info);
      if (this.run) { const m = addMember(this.run, this.deck, info, true); this.toast(`${m.name} joined the ${this.deck.text.wagon} as a late pilgrim (+${this.deck.currency.sym}${Math.round((this.deck.roles[m.role]?.money ?? 300) / 2)})`, 'good'); }
      else this.toast(`${info.name} joined`, 'info');
    } else { info.connected = true; info.name = p.name.slice(0, 40); }
    if (p.bot) this.bots.set(p.id, { t: 0, task: '', target: 0, voteAt: 0, talk: 0 });
    if (!this.phys.players.has(p.id)) this.spawnPlayer(info);
    this.dirty = true;
  }
  leave(id: string) {
    const info = this.state.players.find((x) => x.id === id);
    if (!info) return;
    info.connected = false;
    this.phys.removePlayer(id);
    this.bots.delete(id);
    if (this.state.vote) delete this.state.vote.votes[id];
    this.toast(`${info.name} left`, 'info');
    this.dirty = true;
  }
  input(id: string, f: InputFrame) { this.phys.setInput(id, f, this.time * 1000); }
  chatVote(opt: string) { const v = this.state.vote; if (!v || !this.state.lobby.chatVotes || !v.options.some((o) => o.id === opt)) return; v.chat ??= {}; v.chat[opt] = (v.chat[opt] ?? 0) + 1; this.dirty = true; }

  cmd(id: string, c: TrailCmd) {
    const me = this.state.players.find((x) => x.id === id);
    if (!me) return;
    const host = me.host;
    switch (c.c) {
      case 'vote': this.castVote(id, c.opt); break;
      case 'role': if (this.state.phase === 'lobby' && ROLE_IDS.includes(c.role)) { me.role = c.role; this.dirty = true; } break;
      case 'ready': me.ready = c.on; this.dirty = true; if (this.state.phase === 'stop') this.markReady(id, c.on); break;
      case 'start': if (host && this.state.phase === 'lobby') this.startRun(); break;
      case 'lobby': if (host && this.state.phase === 'lobby') this.setLobby(c.key, c.val); break;
      case 'buy': this.catalogueBuy(id, c.item, c.n); break;
      case 'epitaph': this.setEpitaph(id, c.text); break;
      case 'halt': if (this.state.phase === 'travel' && !this.state.vote && !this.mini) this.trailMenu(me.name); break;
      case 'continue': this.onContinue(id, host); break;
      case 'force': if (host && this.state.vote) this.endVote(c.opt); break;
      case 'pause': if (host) { this.state.paused = c.on; this.dirty = true; } break;
      case 'pace': if (this.run && ['steady', 'strenuous', 'grueling'].includes(c.v) && host) { this.run.pace = c.v as RunState['pace']; this.dirty = true; } break;
      case 'rations': if (this.run && ['filling', 'meager', 'bare'].includes(c.v) && host) { this.run.rations = c.v as RunState['rations']; this.dirty = true; } break;
      case 'emote': if ((EMOTES as readonly string[]).includes(c.id) && this.time - (this.emoteAt.get(id) ?? -9) > 1) { this.emoteAt.set(id, this.time); this.emit({ e: 'emote', who: id, id: c.id }); } break;
      case 'seat': { const p = this.phys.players.get(id); if (p && p.seat < 0) this.phys.sit(p, this.phys.freeSeat(p)); break; }
      case 'drive': { const p = this.phys.players.get(id); if (p && this.journey && this.level.kind === 'journey') this.takeWheel(p); break; }
      case 'unstuck': if (this.journey && this.level.kind === 'journey' && this.state.phase === 'travel' && Math.abs(this.journey.speed) < 0.5 && this.journey.toRoad()) this.toast(`${me.name} got the ${this.deck.text.wagon} back on the road.`, 'info'); break;
      case 'respawn': { const p = this.phys.players.get(id); if (p && !p.downed) this.respawnNearWagon(p); break; }
    }
  }
  setVoice(levels: Record<string, { vad: number; expr: number }>) { this.voice = levels; }

  /** One fixed step (1/60 s). */
  step(dt = 1 / 60) {
    if (this.state.paused) { this.state.now = this.time * 1000; return; }
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.time += dt; this.tick++;
    this.state.now = Math.round(this.time * 1000);
    this.driveBots(dt);
    this.phys.step(dt, this.time * 1000);
    this.stepAnimals(dt);
    this.stepPlayersGame(dt);
    this.stepPhase(dt);
    this.stepLoading(dt);
    this.stepVote();
    this.stepCard();
    this.stepEpitaphs();
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    this.perf.stepMs = this.perf.stepMs * 0.95 + ms * 0.05;
    this.perf.maxStepMs = Math.max(this.perf.maxStepMs * 0.999, ms);
    this.perf.bodies = this.phys.world.bodies.len();
  }
  /** The live state (JSON-safe). rev increases when anything changed. */
  getState(): GameState {
    if (this.dirty) { this.state.rev++; this.dirty = false; this.state.run = this.run; }
    return this.state;
  }
  get stateDirty() { return this.dirty; }
  /** Reliable messages to broadcast (levels, spawns, despawns, one-shot events). */
  drain(): TrailCtl[] {
    const out = this.out; this.out = [];
    if (this.phys.spawned.length) { out.push({ k: 'spawn', ents: this.phys.spawned.map((i) => this.infoOf(i)) }); this.phys.spawned = []; }
    if (this.phys.despawned.length) { out.push({ k: 'despawn', ids: this.phys.despawned }); this.phys.despawned = []; }
    return out;
  }
  snapshot(delta = true) { const o = this.journey && this.level.kind === 'journey' ? this.journey.st.origin : null; return { tick: this.tick, ack: 0, time: this.time, ents: this.phys.snapshot(delta), ...(o ? { origin: [o[0], o[1]] as [number, number] } : {}) }; }
  /** Full level message (for a view that joins late). */
  levelMsg(): TrailCtl { return { k: 'level', id: `${this.level.id}#${this.levelSeq}`, stop: this.level.kind, ents: this.phys.allInfos().map((i) => this.infoOf(i)), desc: viewDesc(this.level), theme: this.deck.id, seed: this.state.seed }; }

  // ================================================================ plumbing
  private emit(e: TrailEvent) { this.out.push({ k: 'ev', e }); }
  private toast(text: string, tone: 'info' | 'good' | 'bad' | 'meme' = 'info', who?: string) { this.emit({ e: 'toast', text, tone, ...(who ? { who } : {}) }); }
  private fx(fx: Extract<TrailEvent, { e: 'fx' }>['fx'], at: V3, n?: number) { this.emit({ e: 'fx', fx, at, ...(n ? { n } : {}) }); }
  private infoOf(i: EntInfo): EntInfo {
    const e = this.phys.ents.get(i.id);
    return e ? { ...i, owned: e.owned, price: e.price, value: Math.round(e.value * 10) / 10, label: e.info.label } : i;
  }
  private wirePhys() {
    this.phys.onImpact = (id, k, cause) => this.hurt(id, k, cause);
    this.phys.onRelease = (p, e, thrown) => this.onRelease(p, e, thrown);
  }
  private makeLevel(kind: string, o: { lobby?: boolean; event?: string } = {}): LevelDesc {
    const run = this.run;
    const node = run ? routeOf(run, this.deck)[Math.max(0, run.node - 1)] : null;
    // a level made for this very stop (levels/<node id>.glb) wins over the kind's generic one
    const own = node && kind !== 'road' && kind !== 'hunt' && kind !== 'camp' ? this.levels[`node:${node.id}`] : undefined;
    const glb = own ?? this.levels[kind === 'road' ? 'trail_road' : kind];
    // v2 (trailstops): stops are generated per seed + route node; the theme pack's fixed maps only with 'classicMaps'
    const gen = this.classicMaps ? null : genStopFor(kind, { seed: this.state.seed, deck: this.deck, run, node, lobby: !!o.lobby, hunts: this.huntN });
    const d = gen ?? (glb ? adaptLevel(structuredClone(glb), kind, run) : buildLevel(kind, {
      theme: this.deck.id, palette: this.deck.palette, seed: this.misc.u32(), depth: run?.river?.depth, swift: run?.river?.swift,
      animals: Object.fromEntries(Object.entries(this.deck.animals).map(([k, a]) => [k, { count: a.count }])), event: o.event,
    }));
    if (o.lobby) d.items = [];
    void node;
    return d;
  }
  private sendLevel(stop: string) {
    this.levelSeq++;
    this.phys.spawned = [];
    this.out.push(this.levelMsg());
    void stop;
  }
  private worldAt = 0;
  private newWorld(desc: LevelDesc, kinematicWagon = true) {
    this.worldAt = this.time;
    this.grabCount.clear();
    this.phys.dispose();
    this.level = desc;
    this.phys = new PhysWorld(this.R, desc);
    this.phys.wagonSpec = this.wagonSpec;
    this.wirePhys();
    this.phys.addWagon(desc.wagon.p, desc.wagon.yaw, kinematicWagon);
    for (const info of this.state.players) if (info.connected) this.spawnPlayer(info);
    if (this.run) this.spawnCargo();
    for (const n of desc.npcs) {
      const def = this.deck.npcs[n.id];
      this.phys.addNpc(n.id, def?.name ?? n.id, n.p, n.yaw);
    }
  }
  private spawnPlayer(info: PlayerInfo) {
    const i = this.state.players.indexOf(info);
    const sp = this.level.spawns[i % Math.max(1, this.level.spawns.length)] ?? { p: [0, 0, 0] as V3, yaw: 0 };
    const m = this.run?.party[info.id];
    const p = this.phys.addPlayer(info.id, this.heightOf(info.id), sp.p, sp.yaw);
    p.ghost = !!m?.ghost;
    if (p.ghost) this.makeGhost(p);
    this.applyMods(p);
    return p;
  }
  /** The height a player plays at (body-swapped players play at their partner's height). */
  private heightOf(id: string): number {
    const sw = this.run?.mods.find((m) => m.startsWith('swap:'));
    if (sw) { const [, a, b] = sw.split(':'); const other = id === a ? b : id === b ? a : null; if (other) return this.state.players.find((x) => x.id === other)?.height ?? 1.7; }
    return this.state.players.find((x) => x.id === id)?.height ?? 1.7;
  }
  private makeGhost(p: PlayerPhys) {
    p.ghost = true;
    // ghosts only touch the level itself (they float through people, props and the wagon)
    p.col.setCollisionGroups(GROUP_GHOST);
  }
  private applyMods(p: PlayerPhys) {
    const mods = this.run?.mods ?? [];
    p.inverted = mods.includes('inverted') || (mods.includes('inverted_half') && (hashStr(p.id) & 1) === 1);
    const m = this.run?.party[p.id];
    p.speedMul = m?.conds.some((c) => c.id === 'broken_leg') ? 0.6 : 1;
    p.strengthMul = m?.role === 'hunter' && this.state.stop?.kind === 'hunt' ? 1.5 : 1;
  }

  // ================================================================ lobby → run
  private setLobby(key: string, val: unknown) {
    const L = this.state.lobby;
    if (key === 'slice') L.slice = val === true;
    else if (key === 'chatVotes') L.chatVotes = val === true;
    else if (key === 'chaosConsent') L.chaosConsent = val === true;
    else if (key === 'daily') L.daily = val === true;
    else if (key === 'classicMaps') this.classicMaps = val === true;
    else if (key === 'modifiers' && Array.isArray(val)) L.modifiers = val.filter((x) => typeof x === 'string').slice(0, 2) as string[];
    else if (key === 'seed' && typeof val === 'string' && /^[A-Z0-9-]{3,40}$/.test(val)) { this.state.seed = val; this.rng = new Rng(`${val}:events`); this.misc = new Rng(`${val}:misc`); }
    this.dirty = true;
  }
  startRun() {
    const L = this.state.lobby;
    this.run = newRun(this.deck, { seed: this.state.seed, slice: L.slice, modifiers: L.modifiers, players: this.state.players.filter((p) => p.connected), oldGraves: this.graves });
    this.run.flags.chaosConsent = L.chaosConsent ? 1 : 0;
    this.state.run = this.run;
    this.makeJourney();
    for (const b of this.state.players.filter((p) => p.bot)) void b; // bots shop through the catalogue (below)
    this.toast(`${this.deck.text.title} — seed ${this.state.seed}. Good luck.`, 'meme');
    this.enterStore(true);
  }

  // ================================================================ cargo: the wagon's physical inventory
  private bedSlot(i: number): V3 { return cargoSlot(this.wagonSpec, i).p; }
  private freeBedSlot(): number {
    const w = this.phys.wagon?.body;
    if (!w) return 0;
    const used: V3[] = [...this.phys.ents.values()].filter((e) => e.stowed && e.stowLocal && e.info.kind === 'prop' && e.item !== 'draft').map((e) => e.stowLocal!);
    const n = cargoSlotCount(this.wagonSpec);
    for (let i = 0; i < n; i++) { const s = this.bedSlot(i); if (!used.some((u) => Math.hypot(u[0] - s[0], u[2] - s[2]) < 0.3 && Math.abs(u[1] - s[1]) < 0.3)) return i; }
    return n - 1;
  }
  private addCargoProp(item: string, value: number) {
    const w = this.phys.wagon?.body;
    if (!w) return;
    const slot = this.bedSlot(this.freeBedSlot());
    const wp = this.phys.pos(w);
    const off = rotV(slot, w.rotation());
    const e = this.phys.addProp(ITEM_PROP[item] ?? 'crate_food', [wp[0] + off[0], wp[1] + off[1] + 0.05, wp[2] + off[2]], { yaw: quatYaw(w.rotation()) + cargoSlot(this.wagonSpec, 0).yaw, value, owned: true, item });
    this.phys.stow(e);
  }
  private spawnCargo() {
    const run = this.run!;
    for (const item of ['food', ...ITEM_IDS] as const) this.syncItem(item);
    // hitched draft animals ride at the animal slots in front of the wagon
    this.syncDraft(run.draft);
  }
  private syncDraft(n: number) {
    const w = this.phys.wagon?.body;
    if (!w) return;
    const cur = [...this.phys.ents.values()].filter((e) => e.item === 'draft' && e.hitched !== undefined);
    for (const e of cur.slice(Math.min(4, n))) this.phys.remove(e);
    for (let i = cur.length; i < Math.min(4, n); i++) {
      const slot = this.wagonSpec.animalSlots[i];
      const wp = this.phys.pos(w), off = rotV([slot[0], 0.7, slot[2]], w.rotation());
      const e = this.phys.addProp('draft', [wp[0] + off[0], wp[1] + off[1], wp[2] + off[2]], { yaw: quatYaw(w.rotation()), owned: true, item: 'draft', value: 1 });
      e.hitched = i;
      this.phys.stow(e);
    }
  }
  /** Props of an item that count as "in the wagon" right now. */
  private aboard(item: string): Ent[] {
    const out: Ent[] = [];
    for (const e of this.phys.ents.values()) {
      if (e.gone || e.info.kind !== 'prop' || e.item !== item || !e.body) continue;
      if (item === 'draft') { if (e.hitched !== undefined) out.push(e); continue; }
      if (!e.owned) continue;
      const p = this.phys.pos(e.body);
      const holder = [...this.phys.players.values()].find((pl) => pl.grab?.ent === e.id);
      if (e.stowed || this.phys.inCargo(p) || (holder && this.phys.nearWagon(this.phys.feet(holder), 3.5))) out.push(e);
    }
    return out;
  }
  private runValue(item: string): number {
    const run = this.run!;
    return item === 'food' ? run.food : item === 'draft' ? run.draft : run.items[item as ItemId] ?? 0;
  }
  private setRunValue(item: string, v: number) {
    const run = this.run!;
    if (item === 'food') run.food = Math.max(0, Math.round(v * 10) / 10);
    else if (item === 'draft') run.draft = Math.max(0, Math.round(v));
    else run.items[item as ItemId] = Math.max(0, Math.round(v));
  }
  /** Make the physical props of `item` match the run's number (after abstract effects: food eaten, cards). */
  private syncItem(item: string) {
    if (!this.run || item === 'draft') { if (item === 'draft' && this.run) this.syncDraft(this.run.draft); return; }
    const target = this.runValue(item);
    const props = this.aboard(item);
    const unit = item === 'food' ? 50 : item === 'ammo' ? 20 : 1;
    const want = target <= 0 ? 0 : Math.min(CARGO_CAP[item] ?? 3, Math.max(1, Math.ceil(target / unit)));
    // remove extras (stowed first), then add missing
    const rm = [...props].sort((a, b) => Number(b.stowed) - Number(a.stowed));
    while (rm.length > want) { const e = rm.shift()!; this.phys.remove(e); props.splice(props.indexOf(e), 1); }
    for (let i = props.length; i < want; i++) this.addCargoProp(item, 0);
    const now = this.aboard(item);
    for (const e of now) e.value = now.length ? target / now.length : 0;
  }
  /** Physical → run: what is aboard now IS the inventory. Returns what changed (for the end card). */
  private recount(): { item: string; before: number; after: number }[] {
    if (!this.run) return [];
    const changes: { item: string; before: number; after: number }[] = [];
    for (const item of ['food', ...ITEM_IDS] as const) {
      const before = this.runValue(item);
      const after = this.aboard(item).reduce((a, e) => a + e.value, 0);
      if (Math.abs(after - before) > 0.05) changes.push({ item, before, after });
      this.setRunValue(item, after);
    }
    this.dirty = true;
    return changes;
  }
  private itemName(item: string, n = 2) {
    const d = this.deck.items[item as ItemId];
    if (item === 'food') return 'lbs of food';
    if (item === 'draft') return n === 1 ? this.deck.text.draftOne : this.deck.text.draft;
    const name = d?.name ?? item;
    if (n === 1 || /s$| of |^the /i.test(name)) return name;
    return `${name}s`;
  }
  private describeChanges(ch: { item: string; before: number; after: number }[]): string {
    const lost = ch.filter((c) => c.after < c.before).map((c) => `${Math.round(c.before - c.after)} ${this.itemName(c.item, Math.round(c.before - c.after))}`);
    const got = ch.filter((c) => c.after > c.before).map((c) => `${Math.round(c.after - c.before)} ${this.itemName(c.item, Math.round(c.after - c.before))}`);
    return [lost.length ? `Lost: ${lost.join(', ')}.` : '', got.length ? `Gained: ${got.join(', ')}.` : ''].filter(Boolean).join(' ') || 'Nothing lost.';
  }

  // ================================================================ STOP: general store
  private enterStore(first: boolean) {
    this.state.phase = 'stop';
    const node = routeOf(this.run!, this.deck)[Math.max(0, this.run!.node - 1)];
    const desc = this.makeLevel('store');
    this.newWorld(desc);
    const run = this.run!;
    for (const it of desc.items) {
      const item = it.item === 'crate_food' ? 'food' : ITEM_PROP_INV[it.item] ?? it.item;
      const price = priceOf(run, this.deck, item as ItemId);
      const e = this.phys.addProp(it.item, it.p, { yaw: it.yaw, owned: false, price, item, value: item === 'food' ? (this.deck.items.food.unit ?? 50) : item === 'ammo' ? (this.deck.items.ammo.unit ?? 20) : 1 });
      e.owned = false;
    }
    this.setStop({ kind: 'store', level: 'store', title: `${this.deck.text.storeName}${node && !first ? ` — ${node.name}` : ''}`, endsAt: 0, objective: { label: 'Carry what you want to buy into the wagon', progress: 0, goal: 0 }, ready: [], notes: [`${this.deck.currency.sym}${run.money} to spend`] });
    this.sendLevel('store');
    this.toast(`${this.deck.npcs.shopkeeper?.name ?? 'The shopkeeper'}: "${fill(this.deck.npcs.shopkeeper?.lines[0] ?? 'Welcome!', run, this.deck)}"`, 'meme');
    this.stopData = { first };
    this.afterStop = () => (first ? this.enterTravel() : this.enterCamp());
  }
  private storeTotals(): { owe: number; items: Ent[] } {
    const items = [...this.phys.ents.values()].filter((e) => !e.gone && e.info.kind === 'prop' && !e.owned && e.body && (e.item === 'draft' ? e.hitched !== undefined : this.phys.inCargo(this.phys.pos(e.body)) || e.stowed));
    return { owe: items.reduce((a, e) => a + e.price, 0), items };
  }
  private stepStore() {
    const run = this.run!;
    // draft animals led near the hitch snap into a free slot
    const w = this.phys.wagon!.body!;
    const hitch = rotV(this.wagonSpec.hitch, w.rotation()), wp = this.phys.pos(w);
    const hp: V3 = [wp[0] + hitch[0], 0, wp[2] + hitch[2]];
    const hitched = [...this.phys.ents.values()].filter((e) => e.item === 'draft' && e.hitched !== undefined);
    for (const e of this.phys.ents.values()) {
      if (e.item !== 'draft' || e.hitched !== undefined || !e.body || e.gone) continue;
      const p = this.phys.pos(e.body);
      if (Math.hypot(p[0] - hp[0], p[2] - hp[2]) < 2.6 && hitched.length < 4) {
        const slot = [0, 1, 2, 3].find((i) => !hitched.some((h) => h.hitched === i)) ?? 0;
        e.hitched = slot;
        for (const pl of this.phys.holders(e.id)) pl.grab = null;
        const off = rotV([this.wagonSpec.animalSlots[slot][0], 0.7, this.wagonSpec.animalSlots[slot][2]], w.rotation());
        e.body.setTranslation({ x: wp[0] + off[0], y: wp[1] + off[1], z: wp[2] + off[2] }, true);
        e.body.setRotation(w.rotation(), true);
        this.phys.stow(e);
        hitched.push(e);
        this.toast(`A ${this.deck.text.draftOne} is hitched! (${hitched.length}/4)`, 'good');
      }
    }
    // shoplifting through the cat flap
    for (const e of this.phys.ents.values()) {
      if (e.owned || !e.body || e.item === 'draft') continue;
      if (this.phys.inZoneNamed('catflap', this.phys.pos(e.body))) { e.owned = true; e.price = 0; run.flags.heat = (run.flags.heat ?? 0) + 1; this.toast('Shoplifted through the cat flap! (heat +1)', 'meme'); this.dirty = true; }
    }
    const { owe } = this.storeTotals();
    const st = this.state.stop!;
    const note = `${this.deck.currency.sym}${run.money} · in the wagon: ${this.deck.currency.sym}${owe}${owe > run.money ? ' (too much!)' : ''} · ${this.deck.text.draft}: ${hitched.length + run.draft}`;
    const eat = living(run).reduce((a, m) => a + (m.ghost ? 0 : 2 * sizeStats(m.height).appetite), 0);
    const trip = Math.round((routeOf(run, this.deck).at(-1)?.miles ?? 400) / 15 * 1.15);
    const aboardFood = [...this.phys.ents.values()].filter((e) => e.item === 'food' && e.body && this.phys.inCargo(this.phys.pos(e.body))).reduce((a, e) => a + (e.value || 0), 0);
    const foodNote = `food in the ${this.deck.text.wagon}: ${Math.round(aboardFood)} lbs ≈ ${Math.floor(aboardFood / Math.max(1, eat))} days (the trip takes ~${trip})`;
    if (st.notes[1] !== foodNote) { st.notes[1] = foodNote; this.dirty = true; }
    if (st.notes[0] !== note) { st.notes = [note, foodNote]; st.objective = { label: 'Carry what you want into the wagon · lead the animals to the front', progress: owe, goal: run.money, unit: this.deck.currency.sym }; this.dirty = true; }
  }
  private settleStore(): string {
    const run = this.run!;
    const { items } = this.storeTotals();
    items.sort((a, b) => b.price - a.price);
    let owe = items.reduce((a, e) => a + e.price, 0);
    const yanked: string[] = [];
    while (owe > run.money && items.length) {
      const e = items.shift()!;
      owe -= e.price;
      yanked.push(this.itemName(e.item ?? 'item', 1));
      if (e.hitched !== undefined) { e.hitched = undefined; this.phys.unstow(e); }
      if (e.body) { e.body.setTranslation({ x: e.spawn[0], y: e.spawn[1] + 0.3, z: e.spawn[2] }, true); e.body.setLinvel({ x: 0, y: 0, z: 0 }, true); }
      if (e.stowed) this.phys.unstow(e);
    }
    for (const e of items) { e.owned = true; e.price = 0; }
    run.money -= owe;
    const draftBefore = run.draft;
    const hitched = [...this.phys.ents.values()].filter((e) => e.item === 'draft' && e.hitched !== undefined && e.owned).length;
    const ch = this.recount();
    run.draft = Math.max(draftBefore, hitched);
    this.syncItem('food');
    return `${owe ? `Paid ${this.deck.currency.sym}${owe}. ` : ''}${yanked.length ? `${this.deck.text.shopkeeper} took back: ${yanked.join(', ')} ("No money, no ${yanked[0]}!"). ` : ''}${this.describeChanges(ch)}`;
  }
  /** Catalogue order: n units dropped on the porch (still to be carried). */
  private catalogueBuy(id: string, item: string, n: number) {
    if (this.state.stop?.kind !== 'store' || !this.run) return;
    const prop = ITEM_PROP[item];
    if (!prop) return;
    const z = this.phys.zone('porch');
    if (item === 'draft') {
      // the shopkeeper's kid leads ordered animals straight to the hitch (still paid for when you leave)
      const w = this.phys.wagon!.body!;
      const wp = this.phys.pos(w);
      const taken = [...this.phys.ents.values()].filter((e) => e.item === 'draft' && e.hitched !== undefined).map((e) => e.hitched!);
      let k = 0;
      for (let slot = 0; slot < 4 && k < n; slot++) {
        if (taken.includes(slot)) continue;
        const off = rotV([this.wagonSpec.animalSlots[slot][0], 0.7, this.wagonSpec.animalSlots[slot][2]], w.rotation());
        const e = this.phys.addProp('draft', [wp[0] + off[0], wp[1] + off[1], wp[2] + off[2]], { owned: false, price: priceOf(this.run, this.deck, 'draft'), item: 'draft', value: 1 });
        e.owned = false; e.hitched = slot; this.phys.stow(e); k++;
      }
      const who = this.state.players.find((x) => x.id === id)?.name ?? '';
      if (k) this.toast(`${who} ordered ${k} ${this.deck.text.draft} — hitched and waiting.`, 'info');
      else if (n > 0) this.toast(`Every hitch is taken — no room for more ${this.deck.text.draft}.`, 'bad');
      return;
    }
    for (let i = 0; i < Math.min(8, n); i++) {
      const p: V3 = z ? [z.p[0] + (this.misc.next() - 0.5) * z.he[0] * 1.6, 0.6 + i * 0.5, z.p[2] + (this.misc.next() - 0.5) * z.he[2] * 1.6] : [0, 1, 0];
      const price = priceOf(this.run, this.deck, item as ItemId);
      const ord = this.phys.addProp(prop, p, { owned: false, price, item, value: item === 'food' ? (this.deck.items.food.unit ?? 50) : item === 'ammo' ? (this.deck.items.ammo.unit ?? 20) : 1 });
      ord.owned = false; ord.ordered = true;
    }
    const who = this.state.players.find((x) => x.id === id)?.name ?? '';
    if (n <= 0) return;
    const what = item === 'food' ? `${n} × ${this.deck.items.food.unit ?? 50} lbs of food` : `${n} × ${this.itemName(item, n)}`;
    this.toast(`${who} ordered ${what} — ${n === 1 ? "it's" : "they're"} on the porch.`, 'info');
  }

  // ================================================================ generic stop plumbing
  private setStop(s: StopState) { this.state.stop = s; this.state.rolling = false; this.dirty = true; }
  private markReady(id: string, on: boolean) {
    const st = this.state.stop;
    if (!st) return;
    st.ready = on ? [...new Set([...st.ready, id])] : st.ready.filter((x) => x !== id);
    this.dirty = true;
    const humans = this.state.players.filter((p) => p.connected && !p.bot);
    const need = humans.length ? humans : this.state.players.filter((p) => p.connected);
    if (need.length && need.every((p) => st.ready.includes(p.id))) this.finishStopByPlayers();
  }
  private onContinue(id: string, host: boolean) {
    if (this.state.card) { if (host || this.state.players.length === 1) this.state.card.until = 0; return; }
    if (this.state.phase === 'stop' && !this.state.vote) {
      if (host) this.finishStopByPlayers();
      else this.markReady(id, true);
    }
    if (this.state.phase === 'end' && host) { this.state.phase = 'lobby'; this.run = null; this.state.run = null; this.state.stop = null; this.newWorld(this.makeLevel('store', { lobby: true })); this.sendLevel('lobby'); this.dirty = true; }
  }
  /** "We're done here" (everyone ready / the host's Continue). */
  private finishStopByPlayers() {
    const k = this.state.stop?.kind;
    if (!k || this.state.vote) return;
    if (k === 'camp' && this.camp) { this.camp.hurry(); if (this.state.stop) this.state.stop.ready = []; this.dirty = true; return; }
    if (k === 'store') {
      const draft = this.run!.draft + [...this.phys.ents.values()].filter((e) => e.item === 'draft' && e.hitched !== undefined && !e.owned).length;
      this.openVote({ id: 'store_leave', title: 'Ready to leave?', text: draft ? `Everything in the ${this.deck.text.wagon} will be paid for.` : `You have no ${this.deck.text.draft}! The ${this.deck.text.wagon} won't move.`, kind: 'store',
        options: [{ id: 'leave', label: this.deck.text.leaveStore, hint: 'pay and go', disabled: draft ? undefined : `needs ${this.deck.text.draft}` }, { id: 'stay', label: 'Keep shopping' }] }, 12, (r) => {
        if (r !== 'leave') return;
        const note = this.settleStore();
        this.endStop(note);
      });
      return;
    }
    if (k === 'landmark' || k === 'camp' || k === 'finish') { this.endStop(''); return; }
    // timed stops end on their timer; the host can skip ahead
    this.stopTimer = 0.01;
  }
  private endStop(note: string, title?: string) {
    // anyone still down gets dragged along by the party (back up, barely)
    for (const [id] of this.downed) { const p = this.phys.players.get(id); if (p) { p.downed = false; p.ragdoll = 0.3; } const m = this.run?.party[id]; if (m) m.health = 10; this.toast(`${this.nameOf(id)} was dragged along, barely alive.`, 'info'); }
    this.downed.clear();
    const then = this.afterStop;
    this.afterStop = null;
    this.mini = null;
    for (const p of this.phys.players.values()) { p.inverted = false; }
    this.state.stop = null;
    this.dirty = true;
    const go = () => { if (this.run?.outcome === 'wiped') return this.endRun(); then?.(); };
    if (note) this.showCard({ id: `stop_${this.tick}`, title: title ?? 'Onward', text: note }, 6, go); else go();
  }

  // ================================================================ TRAVEL
  private enterTravel() {
    if (this.journey) { this.enterJourney(); return; }
    const run = this.run!;
    this.state.phase = 'travel';
    this.state.stop = null;
    this.mini = null;
    if (this.level.kind !== 'road') {
      const desc = this.makeLevel('road');
      this.newWorld(desc, true);
      this.sendLevel('road');
      for (const p of this.phys.players.values()) this.phys.sit(p, this.phys.freeSeat(p));
    }
    this.state.rolling = true;
    this.dayAcc = 0;
    this.dirty = true;
    void run;
  }
  private rolling(): boolean { return this.state.phase === 'travel' && !this.state.vote && !this.state.card && !this.mini && !this.state.paused && (this.run?.outcome === 'playing'); }
  private stepTravel(dt: number) {
    if (this.journey && this.level.kind === 'journey') { this.stepJourney(dt); return; }
    const run = this.run!;
    const roll = this.rolling();
    if (this.state.rolling !== roll) { this.state.rolling = roll; this.dirty = true; }
    const canMove = speedFactor(run, this.deck) > 0;
    const v = roll && canMove ? ROAD_SPEED * (run.pace === 'grueling' ? 1.25 : run.pace === 'strenuous' ? 1.12 : 1) * (run.limp ? 0.7 : 1) : this.mini?.kind === 'trail3d:pothole' ? ROAD_SPEED * 0.5 : 0;
    this.phys.wagonVel = [0, 0, v];
    // floating origin
    const w = this.phys.wagon?.body;
    if (w) {
      const z = w.translation().z;
      if (z > ROAD_REBASE / 2) { this.phys.rebase(-ROAD_REBASE); this.emit({ e: 'rebase', dz: -ROAD_REBASE }); }
      // things left behind on the road are lost; players who fell far behind catch a ride
      const wz = this.phys.pos(w)[2];
      for (const e of [...this.phys.ents.values()]) {
        if (e.info.kind !== 'prop' || !e.body || e.stowed) continue;
        if (wz - this.phys.pos(e.body)[2] > 45 && !this.phys.holders(e.id).length) {
          this.phys.remove(e, 'left behind');
          if (e.owned) { this.toast(`You left ${e.item === 'food' ? 'a crate of food' : `a ${this.itemName(e.item ?? 'thing', 1)}`} behind on the road.`, 'bad'); this.recount(); }
        }
      }
      for (const p of this.phys.players.values()) {
        if (p.seat >= 0) continue;
        if (wz - this.phys.pos(p.body)[2] > 60 || this.phys.pos(p.body)[1] < -20) { this.respawnNearWagon(p); this.toast(`${this.nameOf(p.id)} caught a ride back to the ${this.deck.text.wagon}.`, 'info'); }
      }
    }
    if (!roll) return;
    this.dayAcc += dt;
    const len = DAY_LEN * (run.modifiers.includes('speedrun') ? 0.7 : 1);
    if (this.dayAcc < len) return;
    this.dayAcc -= len;
    this.recount();
    this.dayOver(dayTick(run, this.deck, this.rng, canMove, false));
  }
  /** A trail day passed (classic: every DAY_LEN; v2: every TRAIL_DAY). Callers recount the cargo BEFORE dayTick. */
  private dayOver(d: ReturnType<typeof dayTick>) {
    const run = this.run!;
    this.syncItem('food');
    this.syncDraft(run.draft);
    for (const n of d.notes) this.toast(fill(n, run, this.deck), 'info');
    this.handleDeaths(d.deaths);
    if (run.outcome === 'wiped') return this.endRun();
    this.dirty = true;
    if (d.arrived) { this.arrive(d.arrived); return; }
    if (d.event && !this.state.vote && !this.mini) { this.startEvent(d.event); return; }
    if (this.state.vote || this.mini) return;
    // offers: a hunt when food is short (once per leg), and in the slice once after the first river
    const foodDays = run.food / Math.max(1, living(run).reduce((a, m) => a + (m.ghost ? 0 : 2 * sizeStats(m.height).appetite), 0));
    // food short: every few days the game asks again (a hunt, or cutting the rations)
    if (foodDays < 4 && run.rations !== 'bare' && run.day - (run.flags.rationAsk ?? -99) >= 6) {
      run.flags.rationAsk = run.day;
      const to = run.rations === 'filling' ? 'meager' : 'bare';
      this.openVote({ id: 'ration_offer', title: 'Food is running low', text: `${Math.round(run.food)} lbs left (${Math.max(0, Math.round(foodDays))} days). Cut the rations to ${to}?`, kind: 'travel',
        options: [{ id: 'cut', label: `Rations → ${to}`, hint: 'food lasts longer, health suffers' }, { id: 'keep', label: `Keep eating ${run.rations}` }] }, 12, (r) => { if (r === 'cut') { run.rations = to; this.toast(`Rations: ${to}.`); this.dirty = true; } });
      return;
    }
    if ((run.slice && run.node >= 2 && !run.flags.huntOffered) || (foodDays < 6 && run.day - (run.flags.huntDay ?? -99) >= 5)) {
      run.flags.huntOffered = 1; run.flags.huntLeg = run.node; run.flags.huntDay = run.day;
      this.openVote({ id: 'hunt_offer', title: `Go hunting?`, text: `${Math.round(run.food)} lbs of food left (${Math.max(0, Math.round(foodDays))} days). ${this.deck.items.ammo.name}: ${run.items.ammo}.`, kind: 'travel',
        options: [{ id: 'hunt', label: this.deck.text.hunt, hint: 'hunting stop', disabled: run.items.ammo > 0 ? undefined : 'no ammo' }, { id: 'go', label: 'Keep rolling' }] }, 12, (r) => { if (r === 'hunt') this.enterHunt(); });
    }
  }
  // ================================================================ v2: loading the wagon (drop-to-load, load-all, ramp, gauge)
  /** Anything carried to the wagon and let go of (or thrown at it) goes in: no precise placement. */
  private onRelease(p: PlayerPhys, e: Ent, thrown: boolean) {
    if (e.info.kind !== 'prop' || !e.body || e.stowed || !e.item || e.item === 'draft' || this.camp?.owns(e.id)) return;
    const w = this.phys.wagon?.body;
    if (!w) return;
    const ep = this.phys.pos(e.body), wp = this.phys.pos(w);
    const c = rotV(this.wagonSpec.cargo.p, w.rotation());
    const d = Math.hypot(ep[0] - wp[0] - c[0], ep[2] - wp[2] - c[2]);
    const reach = Math.max(this.wagonSpec.cargo.he[0], this.wagonSpec.cargo.he[2]) + (thrown ? 2.6 : 1.9);
    if (d > reach || Math.abs(ep[1] - wp[1] - c[1]) > 3.5) return;
    if (this.loadProp(e)) { this.fx('sparkle', this.phys.pos(e.body)); this.emit({ e: 'sound', s: 'load', at: this.phys.pos(e.body) }); void p; }
  }
  /** Into the next free bed slot (auto-stacked), stowed. False when the bed is full. */
  private loadProp(e: Ent): boolean {
    const w = this.phys.wagon?.body;
    if (!w || !e.body) return false;
    const used = [...this.phys.ents.values()].filter((x) => x.stowed && x.info.kind === 'prop' && x.item !== 'draft').length;
    if (used >= cargoSlotCount(this.wagonSpec)) { this.toast(`The ${this.deck.text.wagon} is full.`, 'bad'); return false; }
    const wp = this.phys.pos(w);
    const slot = cargoSlot(this.wagonSpec, this.freeBedSlot());
    const off = rotV(slot.p, w.rotation());
    e.body.setTranslation({ x: wp[0] + off[0], y: wp[1] + off[1] + 0.05, z: wp[2] + off[2] }, true);
    e.body.setRotation(yawQ(quatYaw(w.rotation()) + slot.yaw), true);
    e.body.setLinvel({ x: 0, y: 0, z: 0 }, true); e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    e.held = 0;
    this.phys.stow(e);
    this.dirty = true;
    return true;
  }
  /** Hold E at the tailgate: everything of ours (and anything ordered at the store) within 10 m goes in. */
  private loadAll(p: PlayerPhys): number {
    const w = this.phys.wagon?.body;
    if (!w) return 0;
    const wp = this.phys.pos(w);
    let n = 0;
    for (const e of [...this.phys.ents.values()]) {
      if (e.gone || !e.body || e.stowed || e.info.kind !== 'prop' || !e.item || e.item === 'draft' || this.phys.holders(e.id).length || this.camp?.owns(e.id)) continue;
      if (!e.owned && !e.ordered) continue;
      const ep = this.phys.pos(e.body);
      if (Math.hypot(ep[0] - wp[0], ep[2] - wp[2]) > 10) continue;
      if (!this.loadProp(e)) break;
      n++;
    }
    if (n) { this.toast(`${this.nameOf(p.id)} loaded ${n} thing${n > 1 ? 's' : ''} into the ${this.deck.text.wagon}.`, 'good'); this.emit({ e: 'sound', s: 'load' }); }
    return n;
  }
  private tailHold = new Map<string, number>();
  private stepLoading(dt: number) {
    const w = this.phys.wagon?.body;
    if (!w || !this.run) return;
    // the ramp: down whenever the wagon stands at a stop (store / camp / hunt / events), up while rolling
    const still = (this.state.phase === 'stop' && this.state.stop?.kind !== 'event') || (this.journey && Math.abs(this.journey.speed) < 0.2 && this.level.kind === 'journey' && !!this.camp);
    if (still !== this.phys.rampDown && this.level.kind !== 'river') { this.phys.setRamp(!!still); this.dirty = true; }
    // hold E at the tailgate (behind the wagon) for 0.8 s: load everything nearby
    let rear = -2;
    for (const c of this.wagonSpec.cols) { const he = c.he ?? [c.r ?? 0.5, c.hh ?? 0.5, c.r ?? 0.5]; if (c.p[2] - he[2] < rear) rear = c.p[2] - he[2]; }
    const t = rotV([0, 0, rear - 1.2], w.rotation()), wp = this.phys.pos(w);
    for (const p of this.phys.players.values()) {
      const f = this.phys.feet(p);
      const at = Math.hypot(f[0] - wp[0] - t[0], f[2] - wp[2] - t[2]) < 1.8 && p.seat < 0 && !p.grab && (p.input.buttons & BTN.use);
      const h = at ? (this.tailHold.get(p.id) ?? 0) + dt : 0;
      this.tailHold.set(p.id, h);
      if (h > 0.8) { this.tailHold.set(p.id, -5); this.loadAll(p); }
    }
    // the gauge (2 Hz)
    if (this.tick % 30 === 0) {
      const aboard = [...this.phys.ents.values()].filter((e) => e.stowed && e.info.kind === 'prop' && e.item !== 'draft');
      const items: Record<string, number> = {};
      for (const e of aboard) items[e.item ?? e.info.sub] = (items[e.item ?? e.info.sub] ?? 0) + 1;
      const kg = Math.round(aboard.reduce((a, e) => a + (e.info.mass ?? 10), 0));
      const cap = cargoSlotCount(this.wagonSpec);
      const prev = this.state.cargo;
      if (!prev || prev.used !== aboard.length || prev.kg !== kg || prev.ramp !== this.phys.rampDown) { this.state.cargo = { used: aboard.length, cap, kg, maxKg: 900, ramp: this.phys.rampDown, items }; this.dirty = true; }
    }
  }
  /** Small folks hop onto a big friend's shoulders (E next to them). */
  private tryMount(p: PlayerPhys): boolean {
    if (p.st.cls !== 'micro' && p.st.cls !== 'small') return false;
    const f = this.phys.feet(p);
    for (const o of this.phys.players.values()) {
      if (o === p || o.ghost || o.downed || o.seat >= 0 || (o.st.cls !== 'large' && o.st.cls !== 'macro')) continue;
      const g = this.phys.feet(o);
      if (Math.hypot(g[0] - f[0], g[2] - f[2]) > o.st.radius + 1.3) continue;
      if (this.phys.mountOn(p, o)) { this.toast(`${this.nameOf(p.id)} climbs onto ${this.nameOf(o.id)}'s shoulders.`, 'meme'); return true; }
    }
    return false;
  }

  // ================================================================ v2: THE JOURNEY (driven wagon, procedural road)
  private makeJourney() {
    const run = this.run!;
    const route = routeOf(run, this.deck).map((n) => ({ id: n.id, kind: n.kind, name: n.name, miles: n.miles }));
    this.journey = new Journey({ seed: this.state.seed, theme: this.deck.id, route, biomes: this.deck.biomes }, () => this.phys, {
      crash: (v) => this.onCrash(v),
      rebase: () => { /* views follow the origin in every snapshot header (no event: it could overtake / trail the snapshots) */ },
    });
    this.jLeg = 0; this.jDay = 0; this.vday = 0; this.duskAsked = -1;
    this.state.journey = this.journey.st;
    this.memes = new MemeDirector(this.simCtx());
  }
  /** What camp.ts / memes.ts may touch (getters: the physics world changes at every stop). */
  private simCtx(): SimCtx {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const s = this;
    return {
      get phys() { return s.phys; }, get run() { return s.run!; }, get deck() { return s.deck; }, get journey() { return s.journey!; }, get time() { return s.time; },
      get misc() { return s.misc; }, get rng() { return s.rng; },
      emit: (e) => this.emit(e), toast: (t, tone, who) => this.toast(t, tone, who), fx: (f, at, n) => this.fx(f, at, n), nameOf: (id) => this.nameOf(id),
      markDirty: () => { this.dirty = true; }, isBot: (id) => this.bots.has(id), recount: () => { this.recount(); }, syncAll: () => this.syncAll(), packUp: (r) => this.packUp(r),
      active: () => [...this.phys.players.values()].filter((p) => !p.ghost && !p.downed && this.run?.party[p.id]?.alive !== false),
    };
  }
  /** A point in the wagon's frame (+side = left, +ahead = forward), on the ground (+up). Classic treadmill: +Z forward. */
  private wf(side: number, ahead: number, up: number): V3 {
    if (this.journey && this.level.kind === 'journey') return this.journey.frame(side, ahead, up);
    const w = this.phys.wagon?.body, wp = w ? this.phys.pos(w) : [0, 0, 0] as V3;
    return [wp[0] + side, up, wp[2] + ahead];
  }
  /** Owned cargo props within `radius` m of the wagon (not held, not aboard) go back into free bed slots. */
  private packUp(radius: number): number {
    const w = this.phys.wagon?.body;
    if (!w) return 0;
    const wp = this.phys.pos(w);
    let n = 0;
    for (const e of this.phys.ents.values()) {
      if (e.gone || !e.body || e.stowed || !e.owned || e.info.kind !== 'prop' || !e.item || e.item === 'draft' || this.phys.holders(e.id).length) continue;
      const p = this.phys.pos(e.body);
      if (this.phys.inCargo(p) || Math.hypot(p[0] - wp[0], p[2] - wp[2]) > radius) continue;
      const off = rotV(this.bedSlot(this.freeBedSlot()), w.rotation());
      e.body.setTranslation({ x: wp[0] + off[0], y: wp[1] + off[1] + 0.05, z: wp[2] + off[2] }, true);
      e.body.setLinvel({ x: 0, y: 0, z: 0 }, true); e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.phys.stow(e);
      n++;
    }
    return n;
  }
  /** Everyone off the wagon and onto the ground beside it (a scene / camp starts): not into the bed. */
  private dismountAll() {
    const J = this.journey;
    if (!J || this.level.kind !== 'journey') { for (const p of this.phys.players.values()) if (p.seat >= 0) this.phys.unseat(p); return; }
    let x1 = 1.2, z0 = -2;
    for (const c of this.wagonSpec.cols) { const he = c.he ?? [c.r ?? 0.5, c.hh ?? 0.5, c.r ?? 0.5]; x1 = Math.max(x1, Math.abs(c.p[0]) + he[0]); z0 = Math.min(z0, c.p[2] - he[2]); }
    let k = 0;
    for (const p of this.phys.players.values()) {
      if (p.seat < 0 || p.downed) continue;
      this.phys.unseat(p, false);
      const side = (k % 2 ? -1 : 1) * (x1 + 0.6 + p.st.radius), ahead = 1.2 - Math.floor(k / 2) * 1.3;
      const at = ahead < z0 ? J.frame(0.9 * (k % 2 ? -1 : 1) * (k - 4), z0 - 1.2 - p.st.radius, 0) : J.frame(side, ahead, 0);
      p.body.setTranslation({ x: at[0], y: at[1] + p.st.height / 2 + 0.15, z: at[2] }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      k++;
    }
  }
  private setTilt(r: number) { this.phys.wagonRoll = r; if (this.journey) this.journey.extraRoll = r; }
  private enterJourney() {
    const run = this.run!, J = this.journey!;
    this.state.phase = 'travel';
    this.state.stop = null;
    this.mini = null;
    if (this.jLeg >= 0) { J.placeAtLeg(this.jLeg); this.jLeg = -1; }
    if (this.level.kind !== 'journey') {
      J.attach();
      const [lx, , lz] = J.wagonLocal();
      const desc = buildJourney({ theme: this.deck.id, palette: this.deck.palette }, { p: [lx, J.groundLocal(lx, lz), lz], yaw: J.yaw }, (x, z) => J.groundLocal(x, z));
      this.newWorld(desc, true);
      this.phys.driverSeat = J.driverSeatIndex();
      J.attach();
      this.sendLevel('journey');
      for (const p of this.phys.players.values()) this.phys.sit(p, this.phys.freeSeat(p));
    }
    this.state.rolling = true;
    this.dirty = true;
    void run;
  }
  private nearBench(f: V3): boolean {
    const s = this.phys.seatPose(this.phys.driverSeat);
    return !!s && Math.hypot(s.p[0] - f[0], s.p[2] - f[2]) < 2.4;
  }
  /** Take the driver's bench (E at the front of the wagon / the Drive button). */
  private takeWheel(p: PlayerPhys) {
    const i = this.phys.driverSeat;
    if (i < 0 || p.ghost || p.downed) return;
    const cur = [...this.phys.players.values()].find((o) => o.seat === i);
    if (cur === p) return;
    if (cur) { if (!this.bots.has(cur.id)) { this.toast(`${this.nameOf(cur.id)} is driving.`, 'info', p.id); return; } this.phys.unseat(cur); this.phys.sit(cur, this.phys.freeSeat(cur)); }
    if (p.seat >= 0) this.phys.unseat(p, false);
    this.phys.sit(p, i);
    this.toast(`${this.nameOf(p.id)} takes the reins.`, 'info');
    this.dirty = true;
  }
  private stepJourney(dt: number) {
    const run = this.run!, J = this.journey!, st = J.st;
    const inCamp = !!this.camp;
    // who drives + with what
    const driver = [...this.phys.players.values()].find((p) => p.seat === this.phys.driverSeat && p.seat >= 0) ?? null;
    if ((st.driver ?? null) !== (driver?.id ?? null)) { st.driver = driver?.id ?? null; this.dirty = true; }
    const m = this.mini;
    const moving = !inCamp && run.outcome === 'playing' && !this.state.paused && !(m && !['trail3d:pothole', 'voice:sing', 'voice:talent', 'chase', 'stampede', 'thieves'].includes(m.kind));
    // (the animals see a stampede coming and stop on their own; a player at the reins has to brake)
    const cap = moving && !(m?.kind === 'stampede' && (!driver || this.bots.has(driver.id))) ? speedFactor(run, this.deck) : 0;
    let drive: Drive | null = null;
    // a driver who has let go of the reins for a while (AFK, reading chat): the animals carry on by themselves
    this.driverIdle = driver && !inCamp && driver.input.mz === 0 && driver.input.mx === 0 && !(driver.input.buttons & (BTN.jump | BTN.sprint)) ? this.driverIdle + dt : 0;
    if (driver && !inCamp && this.driverIdle < 10) {
      const i = driver.input;
      drive = { throttle: i.mz, steer: i.mx, brake: (i.buttons & BTN.jump) !== 0, whip: (i.buttons & BTN.sprint) !== 0 };
      if (drive.whip && J.speed > 1 && cap > 0) run.draftHealth = Math.max(0, run.draftHealth - dt * 0.12);
    } else if (inCamp) drive = { throttle: 0, steer: 0, brake: true, whip: false };
    const night = st.tod > 0.8 || st.tod < 0.2;
    J.step(dt, drive, cap, run.pace, night && !inCamp, this.phys.players.values());
    const rolling = Math.abs(J.speed) > 0.3;
    if (this.state.rolling !== rolling) { this.state.rolling = rolling; this.dirty = true; }
    this.crashCd = Math.max(0, this.crashCd - dt);
    if (inCamp) return;
    // the TRAIL layer follows the road
    const route = routeOf(run, this.deck);
    const next = route[run.node];
    if (next) run.miles = Math.max(run.miles, Math.min(next.miles, Math.round(J.miles * 10) / 10));
    // sky + days
    const prevTod = st.tod;
    st.tod = (st.tod + dt / VISUAL_DAY) % 1;
    if (st.tod < prevTod) this.vday++;
    if (prevTod < 0.2 && st.tod >= 0.2 && this.nightDrive) {
      this.nightDrive = false;
      for (const mm of Object.values(run.party)) if (mm.alive && !mm.ghost) mm.health = Math.max(1, mm.health - 6);
      run.morale = Math.max(0, run.morale - 8);
      this.toast('Dawn. Nobody slept. Everyone looks terrible.', 'bad');
    }
    this.jDay += dt * (run.modifiers.includes('speedrun') ? 1.4 : 1);
    if (this.jDay >= TRAIL_DAY && run.outcome === 'playing') {
      this.jDay -= TRAIL_DAY;
      const driven = J.drivenMiles; J.drivenMiles = 0;
      this.recount();
      this.dayOver(dayTick(run, this.deck, this.rng, driven > 0.5, false, driven));
      if (run.outcome !== 'playing' || this.state.phase !== 'travel') return;
      // driving on in the dark: raiders
      if ((st.tod > 0.8 || st.tod < 0.2) && !this.state.vote && !this.mini && run.food > 40 && this.rng.chance(0.35)) { const ev = this.deck.events.find((e) => e.id === 'thief_night'); if (ev) { this.startEvent(ev, null); return; } }
    }
    // arrival at the next route node
    if (next) {
      const n = J.plan.nodes[run.node];
      const d = n ? J.distTo(n.x, n.z) : 1e9;
      st.next = next.name; st.nextDist = Math.round(d);
      if (n) st.goal = Math.round(Math.atan2(n.x - J.wx, n.z - J.wz) * 100) / 100;
      if (n && (d < 16 || (J.miles >= next.miles - 0.3 && d < 45)) && !this.state.vote && !this.mini) { this.arrive(next); return; }
    }
    st.fork = J.forkAhead();
    st.weather = run.weather;
    // a fork with nobody at the reins: the animals stop and look back — a quick group decision
    if (st.fork && st.fork.id && !st.driver && st.fork.dist < 55 && this.forkAsked !== st.fork.id && !this.state.vote && !this.mini) {
      const f = st.fork, alt = f.id!;
      this.forkAsked = alt;
      this.openVote({ id: 'fork', title: 'A fork in the road', text: 'Nobody is driving: the animals look back at you. Which way? (Or grab the reins and steer yourself.)', kind: 'travel',
        options: [{ id: 'main', label: f.labels[0] }, { id: 'alt', label: f.labels[1], hint: 'shorter, riskier' }] }, 7, (r) => { if (r === 'alt') J.preferAlt.add(alt); else J.preferAlt.delete(alt); });
    }
    // dusk: make camp? (a group decision — the only kind of vote left while driving)
    if (st.tod >= 0.72 && st.tod < 0.8 && this.duskAsked !== this.vday && !this.state.vote && !this.mini && !J.campSpot) {
      this.duskAsked = this.vday;
      this.openVote({ id: 'dusk', title: 'The sun is going down', text: 'Pull into the next clearing and make camp? (Camp: tasks that heal you + a watched night. Driving on in the dark is slower and riskier.)', kind: 'camp',
        options: [{ id: 'camp', label: 'Make camp', hint: 'next clearing' }, { id: 'push', label: 'Push on into the night', hint: 'no sleep' }] }, 9, (r) => {
        if (r === 'push') { this.nightDrive = true; this.toast('Pushing on into the night…', 'meme'); } else this.headForCamp();
      });
    }
    if (J.campSpot) {
      const d = J.distTo(J.campSpot.x, J.campSpot.z);
      st.campDist = Math.round(d);
      st.goal = Math.round(Math.atan2(J.campSpot.x - J.wx, J.campSpot.z - J.wz) * 100) / 100;
      this.campStill = Math.abs(J.speed) < 0.5 && d < 45 ? this.campStill + dt : 0;
      if ((d < 12 && Math.abs(J.speed) < 1) || this.campStill > (st.driver ? 3 : 6)) this.startCamp();
      else if (d > 260) { J.campSpot = J.campAhead(); if (!J.campSpot) this.startCamp(); }
    } else if (st.campDist !== undefined) st.campDist = undefined;
    // stuck off the road for a long time (the animals give up): back onto the road
    if (J.farT > (st.driver && !this.bots.has(st.driver) ? 25 : 12)) { if (J.toRoad()) { this.toast(`The ${this.deck.text.draft} dragged the ${this.deck.text.wagon} back onto the road.`, 'info'); this.fx('dust', J.wagonLocal(), 10); } }
    // stragglers + lost props
    if (this.tick % 30 === 0) {
      const wl = J.wagonLocal();
      for (const e of [...this.phys.ents.values()]) {
        if (e.info.kind !== 'prop' || !e.body || e.stowed || e.hitched !== undefined) continue;
        const p = this.phys.pos(e.body);
        if (Math.hypot(p[0] - wl[0], p[2] - wl[2]) > 80 && !this.phys.holders(e.id).length) {
          this.phys.remove(e, 'left behind');
          if (e.owned) { this.toast(`You left ${e.item === 'food' ? 'a crate of food' : `a ${this.itemName(e.item ?? 'thing', 1)}`} behind.`, 'bad'); this.recount(); }
        }
      }
      for (const p of this.phys.players.values()) {
        if (p.seat >= 0) continue;
        const f = this.phys.feet(p);
        if (Math.hypot(f[0] - wl[0], f[2] - wl[2]) > 110) { this.respawnNearWagon(p); this.toast(`${this.nameOf(p.id)} caught up with the ${this.deck.text.wagon}.`, 'info'); }
      }
    }
    this.memes?.step(dt, !!this.mini?.kind.startsWith('voice') || !!this.state.card?.big, this.voice);
    if (this.tick % 12 === 0) this.dirty = true;
  }
  /** Dusk vote said camp: the animals (or the driver) head for the next clearing; the HUD points at it. */
  private headForCamp() {
    const J = this.journey!;
    J.campSpot = J.campAhead();
    if (!J.campSpot) { this.startCamp(); return; }
    this.toast(`Camp spot ${Math.round(J.distTo(J.campSpot.x, J.campSpot.z))} m ahead. Pull in and stop there.`, 'info');
    this.dirty = true;
  }
  private startCamp() {
    const J = this.journey!, run = this.run!;
    if (this.camp || this.state.phase !== 'travel') return;
    if (J.campSpot && J.distTo(J.campSpot.x, J.campSpot.z) < 60) J.parkAt(J.campSpot);
    J.campSpot = null; J.speed = 0; J.st.campDist = undefined;
    this.nightDrive = false;
    const lateNight = J.st.tod < 0.25 || J.st.tod > 0.86;
    if (!lateNight) J.st.tod = Math.max(J.st.tod, 0.74);
    // body swaps / temporary ghosts / mods end at camp (as the classic camp)
    if (run.mods.some((mm) => mm.startsWith('swap:'))) { this.emit({ e: 'unswap' }); run.mods = run.mods.filter((mm) => !mm.startsWith('swap:')); this.respawnSwapped(); }
    run.mods = run.mods.filter((mm) => mm === 'hat_of_shame');
    for (const k of Object.keys(run.flags)) if (k.startsWith('tempGhost:')) { const id = k.slice(10); const mm = run.party[id]; if (mm && mm.alive) mm.ghost = false; delete run.flags[k]; const p = this.phys.players.get(id); if (p) { p.ghost = false; p.col.setCollisionGroups(GROUP_PLAYER); } }
    this.dismountAll();
    this.camp = new Camp(this.simCtx());
    J.st.camp = this.camp.state;
    if (lateNight) this.camp.hurry();   // (making camp in the middle of the night: straight to the night)
    this.state.phase = 'stop';
    this.setStop({ kind: 'camp', level: 'journey', title: 'Camp', endsAt: this.camp.state.endsAt, objective: { label: 'Camp tasks: firewood · cook · tents · animals · repairs · watch', progress: 0, goal: 0 }, ready: [], notes: [] });
    this.afterStop = null;
  }
  private stepCamp2(dt: number) {
    const c = this.camp!, st = this.state.stop!;
    const over = c.step(dt);
    st.endsAt = c.state.endsAt;
    const tasks = c.state.tasks;
    st.objective = { label: c.state.night ? 'Night: guard the camp (watch post), keep the fire going' : 'Camp tasks: firewood · cook · tents · animals · repairs · watch', progress: Math.round(tasks.reduce((a, t) => a + t.progress, 0) / tasks.length * 100), goal: 100, unit: '%' };
    this.memes?.step(dt, false, this.voice);
    if (!over || this.state.vote || this.state.card) return;
    const res = c.finish();
    this.handleDeaths(res.deaths);
    this.camp = null;
    const J = this.journey!;
    J.st.camp = null;
    J.st.tod = 0.26;
    this.vday++;
    this.memes?.reset();
    this.state.stop = null;
    this.state.phase = 'travel';
    for (const p of this.phys.players.values()) if (!p.downed) this.phys.sit(p, this.phys.freeSeat(p));
    this.dirty = true;
    if (this.run?.outcome === 'wiped') { this.endRun(); return; }
    this.showCard({ id: `dawn_${this.tick}`, title: 'Morning', text: res.lines.join(' ') }, 7);
  }
  /** The wagon hit a tree / rock: things fly, riders tumble, sometimes a wheel breaks (a world event). */
  private onCrash(v: number) {
    const J = this.journey!, run = this.run;
    if (this.crashCd > 0 || !run) return;
    this.crashCd = 2.5;
    const at = J.frame(0, 2.6, 0.8);
    this.emit({ e: 'shake', k: Math.min(1.5, v / 5) });
    this.fx('impact', at, 12);
    this.emit({ e: 'sound', s: 'crash', at });
    if (v > 5) for (const p of this.phys.players.values()) {
      if (p.ghost || (p.seat >= 0 && p.seat !== this.phys.driverSeat && !this.misc.chance(0.5))) continue;
      if (p.seat >= 0) this.phys.unseat(p, false);
      this.phys.ragdoll(p, 1.4, [this.misc.range(-1, 1) * p.st.mass * 2, p.st.mass * 4, Math.sin(J.yaw) * p.st.mass * 4]);
    }
    for (const e of [...this.phys.ents.values()]) if (e.stowed && e.item !== 'draft' && this.misc.chance(v > 6 ? 0.35 : 0.15)) { const mass = e.info.mass ?? 10; this.phys.unstow(e, [Math.sin(J.yaw) * mass * 3, mass * 4, Math.cos(J.yaw) * mass * 3]); }
    this.toast(v > 6.5 ? `CRASH! The ${this.deck.text.wagon} slammed into something.` : 'Bonk.', v > 6.5 ? 'bad' : 'meme');
    if (v > 6.5 && this.misc.chance(0.4) && !run.broken.includes('wheel') && !this.state.vote && !this.mini) {
      const ev = this.deck.events.find((e) => e.id === 'broken_wheel');
      if (ev) this.startEvent(ev, null);
    }
  }
  private trailMenu(who: string) {
    const run = this.run!;
    const paces = ['steady', 'strenuous', 'grueling'] as const, rats = ['filling', 'meager', 'bare'] as const;
    const nextPace = paces[(paces.indexOf(run.pace) + 1) % 3], nextRat = rats[(rats.indexOf(run.rations) + 1) % 3];
    this.openVote({ id: 'halt', title: `${who} called a halt`, text: `Pace: ${run.pace}. Rations: ${run.rations}. Health: ${Math.round(living(run).reduce((a, m) => a + m.health, 0) / Math.max(1, living(run).length))}.`, kind: 'travel',
      options: [{ id: 'go', label: 'Keep going' }, { id: 'hunt', label: this.deck.text.hunt, disabled: run.items.ammo > 0 ? undefined : 'no ammo' },
        this.journey ? { id: 'camp', label: 'Make camp here', hint: 'tasks + a night' } : { id: 'rest', label: 'Rest a day', hint: '+health' },
        { id: 'pace', label: `Pace → ${nextPace}` }, { id: 'rations', label: `Rations → ${nextRat}` }] }, this.journey ? 8 : 12, (r) => {
      if (r === 'hunt') this.enterHunt();
      else if (r === 'camp') this.headForCamp();
      else if (r === 'rest') { const res = applyEffects(run, this.deck, [{ k: 'rest', n: 1 }], { target: null, volunteer: null, cause: 'exhaustion' }, this.rng); this.handleDeaths(res.deaths); this.syncItem('food'); this.toast('You rest for a day.', 'good'); }
      else if (r === 'pace') { run.pace = nextPace; this.toast(`Pace: ${nextPace}.`); }
      else if (r === 'rations') { run.rations = nextRat; this.toast(`Rations: ${nextRat}.`); }
      this.dirty = true;
    });
  }
  private arrive(n: RouteNode) {
    const run = this.run!;
    // v2: stops that load their own place restart the drive at the start of the next leg afterwards
    if (this.journey && ['river', 'fort', 'start', 'landmark'].includes(n.kind)) this.jLeg = run.node;
    run.miles = Math.max(run.miles, n.miles);
    run.node++;
    this.dirty = true;
    this.toast(`You have reached ${n.name}.`, 'good');
    if (n.kind === 'river') {
      run.river = riverAt(run, n, this.rng);
      this.riverVote(n);
    } else if (n.kind === 'fort' || n.kind === 'start') this.showCard({ id: `arr_${n.id}`, title: n.name, text: `A fort with a store. Time to restock.` }, 4, () => this.enterStore(false));
    else if (n.kind === 'landmark') this.showCard({ id: `arr_${n.id}`, title: n.name, text: fill(n.talk?.[0] ?? 'A famous landmark. Take a look around.', run, this.deck), big: true }, 4, () => this.enterLandmark(n));
    else if (n.kind === 'end') this.enterFinish(n);
    else this.showCard({ id: `arr_${n.id}`, title: n.name, text: 'The trail gets rough from here.' }, 4);
  }

  // ================================================================ votes + cards
  private openVote(v: Omit<VoteState, 'votes' | 'endsAt' | 'boss'>, secs: number, done: (r: string, how: string) => void) {
    const run = this.run;
    const bossId = run ? run.order[run.bossIdx % Math.max(1, run.order.length)] : this.state.players[0]?.id ?? null;
    this.state.vote = { ...v, options: v.options.slice(0, 5), votes: {}, endsAt: Math.round((this.time + secs) * 1000), boss: bossId };
    this.voteCb = { done, minVoters: 0 };
    this.state.rolling = false;
    this.dirty = true;
    for (const b of this.bots.values()) b.voteAt = this.time + 1 + this.misc.next() * 2.5;
  }
  private castVote(id: string, opt: string) {
    const v = this.state.vote;
    if (!v || !v.options.some((o) => o.id === opt && !o.disabled)) return;
    v.votes[id] = opt;
    this.dirty = true;
    const voters = this.state.players.filter((p) => p.connected);
    if (voters.every((p) => v.votes[p.id])) v.endsAt = Math.min(v.endsAt, Math.round((this.time + 0.8) * 1000));
  }
  private stepVote() {
    const v = this.state.vote;
    if (!v || this.time * 1000 < v.endsAt) return;
    const t = tally(v, this.run, this.rng);
    this.endVote(t.result, t.how);
  }
  private endVote(result: string, how = 'forced') {
    const v = this.state.vote;
    if (!v) return;
    v.result = result;
    const cb = this.voteCb;
    this.voteSnapshot = { ...v.votes };
    this.state.vote = null; this.voteCb = null;
    this.dirty = true;
    const label = v.options.find((o) => o.id === result)?.label ?? result;
    if (how === 'boss') this.toast(`${this.deck.text.bossTie} → ${label}`, 'meme');
    else if (how === 'dice') this.toast(`${this.deck.text.diceTie} → ${label}`, 'meme');
    else this.toast(`Vote: ${label}`, 'info');
    cb?.done(result, how);
  }
  private showCard(c: Omit<CardState, 'until'>, secs = 6, then?: () => void) {
    if (this.state.card) { this.cardQueue.push({ card: c, secs, then }); return; }
    this.state.card = { ...c, until: Math.round((this.time + secs) * 1000) };
    this.cardThen = then ?? null;
    this.state.rolling = false;
    this.dirty = true;
  }
  private stepCard() {
    const c = this.state.card;
    if (!c || this.time * 1000 < c.until) return;
    this.state.card = null;
    this.dirty = true;
    const then = this.cardThen;
    this.cardThen = null;
    const next = this.cardQueue.shift();
    if (next) this.showCard(next.card, next.secs, next.then);
    then?.();
  }

  // ================================================================ EVENTS
  private startEvent(e: DeckEvent, forcedTarget?: string | null) {
    const run = this.run!;
    const target = forcedTarget !== undefined ? forcedTarget : pickTarget(e, run, this.rng);
    const others = living(run).filter((m) => !m.ghost && m.id !== target);
    const volunteer = others.length ? this.rng.pick(others).id : null;
    const extra: Record<string, string | number> = {};
    if (e.id === 'grave_found' || e.id === 'ghost_convoy') {
      const g = [...run.oldGraves].sort((a, b) => Math.abs(a.mile - run.miles) - Math.abs(b.mile - run.miles))[0];
      if (g) { extra.graveName = g.name; extra.graveCause = g.cause; extra.graveEpitaph = g.epitaph || this.rng.pick(this.deck.epitaphs); }
    }
    const ctx: EventCtx = { e, target, volunteer, extra, backup: JSON.stringify(run) };
    this.pendingEv = ctx;
    if (e.id !== 'time_loop') this.prevEv = ctx;
    const fired = fireEvent(run, this.deck, e, this.ctx(ctx), this.rng);
    if (fired) { for (const n of fired.notes) this.toast(n, 'bad'); this.handleDeaths(fired.deaths); this.syncAll(); }
    const f = (s: string) => fill(s, run, this.deck, this.ctx(ctx));
    const options: VoteOption[] = e.choices.map((c) => {
      const blocked = choiceBlocked(run, this.deck, c);
      const phys = c.stop && PHYSICAL_STOPS.has(c.stop);
      return { id: c.id, label: f(c.label), hint: c.hint ? f(c.hint) + (c.stop && !phys ? ' (card)' : '') : undefined, disabled: blocked ?? undefined };
    });
    if (options.every((o) => o.disabled)) options[options.length - 1].disabled = undefined;
    // v2: hands, not menus — an event with a playable scene just happens in the world (ignore it and it goes badly)
    const world = this.journey && this.level.kind === 'journey' && !this.camp ? e.choices.find((c) => c.stop && PHYSICAL_STOPS.has(c.stop) && !choiceBlocked(run, this.deck, c)) : undefined;
    if (world) {
      this.emit({ e: 'sound', s: e.tier === 'insane' ? 'insane' : e.tier === 'hard' ? 'hard' : 'event' });
      this.showCard({ id: `ev_${e.id}_${this.tick}`, title: f(e.name), text: f(e.text), tier: e.tier, icon: e.icon }, 4);
      this.startMini(world.stop!, ctx, world.id);
      return;
    }
    const secs = this.journey ? (e.choices.length === 1 ? 5 : 9) : e.choices.length === 1 ? 5 : 15;
    this.openVote({ id: `ev_${e.id}`, title: f(e.name), text: f(e.text), tier: e.tier, icon: e.icon, kind: e.id === 'body_swap' ? 'consent' : 'event', options }, secs, (r) => this.resolveEvent(ctx, r));
    this.emit({ e: 'sound', s: e.tier === 'insane' ? 'insane' : e.tier === 'hard' ? 'hard' : 'event' });
  }
  private ctx(c: EventCtx): Ctx { return { target: c.target, volunteer: c.volunteer, cause: c.e.name, extra: c.extra }; }
  private resolveEvent(c: EventCtx, choiceId: string) {
    const run = this.run!;
    if (c.e.id === 'body_swap' && choiceId === 'agree') {
      // consent: EVERY connected human must have voted "agree"
      const humans = this.state.players.filter((p) => p.connected && !p.bot);
      const v = this.lastVotes;
      if (!humans.every((p) => v[p.id] === 'agree')) choiceId = 'refuse';
    }
    const choice = c.e.choices.find((x) => x.id === choiceId);
    if (choice?.stop && PHYSICAL_STOPS.has(choice.stop) && !choiceBlocked(run, this.deck, choice)) { this.startMini(choice.stop, c, choiceId); return; }
    this.finishEvent(c, choiceId);
  }
  private get lastVotes(): Record<string, string> { return (this.voteSnapshot ?? {}) as Record<string, string>; }
  private voteSnapshot: Record<string, string> | null = null;
  private finishEvent(c: EventCtx, choiceId: string, stopResult?: 'success' | 'partial' | 'fail', extra?: Record<string, string | number>) {
    const run = this.run!;
    this.recount();
    if (extra) Object.assign(c.extra, extra);
    const res = resolveChoice(run, this.deck, c.e, choiceId, this.ctx(c), this.rng, stopResult);
    this.afterResolution(c, res);
  }
  private afterResolution(c: EventCtx, res: Resolution) {
    const run = this.run!;
    this.syncAll();
    for (const n of res.notes) this.toast(n, 'info');
    for (const m of res.mods) this.toast(`Modifier: ${m.replace(/_/g, ' ')}`, 'meme');
    if (res.swap) { this.emit({ e: 'swap', a: res.swap[0], b: res.swap[1] }); this.respawnSwapped(); }
    this.handleDeaths(res.deaths);
    for (const p of this.phys.players.values()) this.applyMods(p);
    const then = () => {
      if (run.outcome === 'wiped') return this.endRun();
      if (res.rewind && c.backup) { this.rewind(c); return; }
      if (res.chain) { const ch = this.deck.events.find((x) => x.id === res.chain); if (ch) { this.startEvent(ch); return; } }
      if (res.hunt) { this.enterHunt(); return; }
      if (this.state.phase === 'stop' && (this.level.kind === 'road' || this.level.kind === 'journey') && !this.camp) { this.state.phase = 'travel'; this.state.stop = null; }
      if (this.afterCampEvent && this.state.stop?.kind === 'camp') { this.afterCampEvent = false; this.state.stop.endsAt = Math.round((this.time + 20) * 1000); }
    };
    this.showCard({ id: `res_${c.e.id}_${this.tick}`, title: fill(c.e.name, run, this.deck, this.ctx(c)), text: res.text, tier: c.e.tier, icon: c.e.icon }, 6, then);
  }
  /** time_loop: yesterday again — the run as it was before the last event, which is drawn again. */
  private rewind(c: EventCtx) {
    const prev = this.pendingPrev;
    if (!prev?.backup) { this.toast('Nothing to relive.', 'meme'); return; }
    const restored = JSON.parse(prev.backup) as RunState;
    // keep who is here now (late joiners) but everything else rolls back
    for (const id of Object.keys(this.run!.party)) if (!restored.party[id]) restored.party[id] = this.run!.party[id];
    this.run = restored; this.state.run = restored;
    this.syncAll();
    this.toast('It\'s yesterday. Again.', 'meme');
    this.startEvent(prev.e, prev.target);
    void c;
  }
  private get pendingPrev(): EventCtx | null { return this.prevEv; }
  private prevEv: EventCtx | null = null;
  private syncAll() { for (const item of ['food', ...ITEM_IDS] as const) this.syncItem(item); if (this.run) this.syncDraft(this.run.draft); this.dirty = true; }

  // ---------------------------------------------------------------- physical event scenes on the road ("minis")
  private startMini(kind: string, ev: EventCtx, choice: string) {
    const run = this.run!;
    if (kind === 'chase' && this.journey && this.level.kind === 'journey' && Math.abs(this.journey.speed) > 1.5) kind = 'thieves';   // (on the move: they chase the wagon)
    const w = this.phys.wagon!.body!;
    const wp = this.phys.pos(w);
    const m: Mini = { kind, t: 0, dur: 45, progress: 0, goal: 1, ev, choice, data: {} };
    let label = '';
    switch (kind) {
      case 'wheel': m.dur = 90; m.goal = 3; label = 'Lift the front-left corner, fit the spare wheel, hold E to hammer it in'; this.setTilt(-0.12); break;
      case 'voice:sing': m.dur = 20; m.goal = 6; label = 'SING! (everyone, into your mics)'; break;
      case 'voice:talent': m.dur = 16; m.goal = 1; label = 'Make your best faces! The crowd is judging'; break;
      case 'trail3d:pothole': m.dur = 20; m.goal = 1; label = `Get back on the ${this.deck.text.wagon}!`; this.pothole(); break;
      case 'runs': m.dur = 20; m.goal = 1; label = `${this.nameOf(ev.target ?? '')}: RUN to the bush!`; m.goalZone = { p: this.wf(14, 30, 1), he: [2, 2, 2] }; this.fxAtZone(m.goalZone.p); break;
      case 'photo': m.dur = 16; m.goal = 2; label = 'Everyone into the photo spot!'; m.goalZone = { p: this.wf(6, 0, 1), he: [3, 2, 3] }; break;
      case 'mud': m.dur = this.journey ? 60 : 40; m.goal = this.journey ? 1 : 3; label = 'PUSH the wagon from behind (combined strength)'; if (this.journey && this.level.kind === 'journey') { this.journey.forceBog(); m.data.bog = 1; } break;
      case 'search': m.dur = 45; m.goal = 1; label = 'Search the area (find it, press E)'; {
        const ang = this.misc.range(-1, 1), d = this.misc.range(18, 30);
        m.goalZone = { p: this.wf(Math.sin(ang) * d * (this.misc.chance(0.5) ? 1 : -1), Math.cos(ang) * d * 0.5 + 8, 0.6), he: [1.2, 1.2, 1.2] };
        const e = this.phys.addProp(ev.e.id === 'ox_wanders' ? 'draft' : 'barrel', [m.goalZone.p[0], 0.8, m.goalZone.p[2]], { owned: true, label: ev.e.id === 'ox_wanders' ? 'LOST!' : 'SEARCH' });
        m.data.ent = e.id;
      } break;
      case 'ghostrace': m.dur = 40; m.goal = 1; label = 'Race to the finish line!'; m.goalZone = { p: this.wf(0, 70, 1), he: [12, 3, 2] }; break;
      case 'chase': m.dur = 40; m.goal = 1; label = 'Tackle the thieves (grab them)!'; this.spawnThieves(m, ev); break;
      case 'stampede': m.dur = 16; m.goal = 1; label = 'STAMPEDE! Stop the wagon and get out of the way!'; this.spawnHerd(m); break;
      case 'thieves': m.dur = 35; m.goal = 3; label = 'Thieves are chasing the wagon! Grab them before they reach the cargo (or outrun them)'; this.spawnRaiders(m); break;
    }
    if (kind !== 'trail3d:pothole' && !this.journey) this.phys.wagonVel = [0, 0, 0];
    if (kind === 'trail3d:pothole' && this.journey) this.journey.jump(4.5);
    void wp;
    if (m.goalZone) this.phys.zones.push({ name: 'mini_goal', p: m.goalZone.p, he: m.goalZone.he });
    this.mini = m;
    this.state.phase = 'stop';
    this.setStop({ kind: 'event', level: 'road', title: fill(ev.e.name, run, this.deck, this.ctx(ev)), endsAt: Math.round((this.time + m.dur) * 1000), objective: { label, progress: 0, goal: m.goal }, event: ev.e.id, choice, ready: [], notes: m.goalZone ? [`goal:${m.goalZone.p.map((x) => x.toFixed(1)).join(',')}`] : [] });
    // everyone off the wagon for the scene (except the trail3d scene, which happens while riding)
    if (kind !== 'trail3d:pothole' && !kind.startsWith('voice') && kind !== 'stampede' && kind !== 'thieves') this.dismountAll();
  }
  private fxAtZone(p: V3) { this.fx('sparkle', p); }
  private pothole() {
    const w = this.phys.wagon!;
    this.emit({ e: 'shake', k: 1 });
    this.fx('dust', this.phys.pos(w.body!));
    for (const p of this.phys.players.values()) {
      if (p.ghost) continue;
      const small = p.st.cls === 'micro' || p.st.cls === 'small';
      if (p.seat >= 0 && !small) continue;
      if (p.seat >= 0) this.phys.unseat(p, false);
      const side = this.misc.chance(0.5) ? 1 : -1;
      this.phys.ragdoll(p, 1.6, [side * p.st.mass * this.misc.range(1.5, 3.5), p.st.mass * (small ? 8 : 5.5), -p.st.mass * this.misc.range(1, 3)]);
    }
    for (const e of [...this.phys.ents.values()]) if (e.stowed && e.item !== 'draft' && this.misc.chance(0.25)) { const m = e.info.mass ?? 10; this.phys.unstow(e, [this.misc.range(-1, 1) * m * 2, m * 5, -m * 2]); }
  }
  /** Three raiders come running from behind the wagon (night ambushes, snack thieves on the move). */
  private spawnRaiders(m: Mini) {
    const J = this.journey && this.level.kind === 'journey' ? this.journey : null;
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const p = this.wf((i - 1) * 7 + this.misc.range(-2, 2), -24 - i * 4, 0.9);
      if (J) p[1] = J.groundLocal(p[0], p[2]) + 0.9;
      const e = this.phys.addAnimal(this.phys.wagonPose ? 'bandit' : 'thief', p, { kg: 40, speed: 8.3, danger: 0, flee: 0, name: 'bandit' });
      e.animal!.state = 'wander';
      ids.push(e.id);
    }
    m.data.raiders = ids.join(',');
    this.emit({ e: 'sound', s: 'hard' });
  }
  /** A herd of the theme's biggest animal comes across the road ~35 m ahead of the wagon. */
  private spawnHerd(m: Mini) {
    const kinds = Object.entries(this.deck.animals).sort((a, b) => b[1].kg - a[1].kg);
    const [kind, a] = kinds.find(([, x]) => x.danger < 0.5) ?? kinds[0];
    const side = this.misc.chance(0.5) ? 1 : -1;
    const J = this.journey && this.level.kind === 'journey' ? this.journey : null;
    const start = this.wf(side * 26, 34, 1.2), end = this.wf(-side * 26, 34, 1.2);
    const dx = end[0] - start[0], dz = end[2] - start[2], l = Math.hypot(dx, dz) || 1;
    m.data.dx = dx / l; m.data.dz = dz / l;
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const p: V3 = [start[0] - dx / l * this.misc.range(0, 14) + this.misc.range(-5, 5) * dz / l, start[1] + 0.8, start[2] - dz / l * this.misc.range(0, 14) - this.misc.range(-5, 5) * dx / l];
      if (J) p[1] = J.groundLocal(p[0], p[2]) + 1;
      const e = this.phys.addAnimal(kind, p, { ...a, flee: 0 });
      e.animal!.state = 'flee';
      ids.push(e.id);
    }
    m.data.herd = ids.join(',');
    this.emit({ e: 'shake', k: 0.8 });
    this.emit({ e: 'sound', s: 'hard' });
  }
  private spawnThieves(m: Mini, ev: EventCtx) {
    const w = this.phys.wagon!.body!;
    const wp = this.phys.pos(w);
    const goose = ev.e.id === 'goose_chase';
    const n = goose ? 1 : 3;
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = this.phys.addAnimal(goose ? 'goose' : 'thief', [wp[0] + this.misc.range(-3, 3), 0.3, wp[2] + this.misc.range(-2, 2)], { kg: goose ? 6 : 12, speed: goose ? 6.2 : 5, danger: 0, flee: 30, name: goose ? 'goose' : 'thief' });
      a.animal!.state = 'flee';
      ids.push(a.id);
    }
    m.data.thieves = ids.join(',');
    m.goal = n;
  }
  private stepMini(dt: number) {
    const m = this.mini!;
    const run = this.run!;
    m.t += dt;
    const st = this.state.stop!;
    const liv = [...this.phys.players.values()].filter((p) => !p.ghost && !p.downed && run.party[p.id]?.alive);
    let done = false;
    const w = this.phys.wagon!.body!;
    switch (m.kind) {
      case 'wheel': {
        // corner lift: summed strength of players holding the wagon near the front-left corner, pulling up
        const wp = this.phys.pos(w), corner = rotV(this.wagonSpec.slotWheel, w.rotation());
        const cp: V3 = [wp[0] + corner[0], wp[1] + corner[1], wp[2] + corner[2]];
        let lift = 0;
        for (const p of this.phys.holders(this.phys.wagon!.id)) {
          const e = this.phys.eye(p), d = this.phys.aimDir(p);
          const hold: V3 = [e[0] + d[0] * p.grab!.dist, e[1] + d[1] * p.grab!.dist, e[2] + d[2] * p.grab!.dist];
          if (Math.hypot(hold[0] - cp[0], hold[2] - cp[2]) < 2.2) lift += p.st.lift * p.strengthMul;
        }
        const lifted = lift >= 110;
        this.setTilt(lifted ? 0.03 : -0.12);
        const spare = [...this.phys.ents.values()].find((e) => e.item === 'wheel' && e.body && !e.gone && Math.hypot(this.phys.pos(e.body)[0] - cp[0], this.phys.pos(e.body)[2] - cp[2]) < 1.1);
        const fitted = lifted && !!spare;
        let hammer = 0;
        if (fitted) for (const p of liv) if (!p.grab && (p.input.buttons & BTN.use) && Math.hypot(this.phys.feet(p)[0] - cp[0], this.phys.feet(p)[2] - cp[2]) < 2) hammer += dt * (run.party[p.id]?.role === 'carpenter' ? 2 : 1);
        m.data.hammer = Math.min(4, Number(m.data.hammer ?? 0) + hammer);
        m.progress = (lifted ? 1 : 0) + (fitted ? 1 : 0) + Number(m.data.hammer) / 4;
        st.notes = [`lift ${Math.round(lift)}/110 kg`, fitted ? 'wheel in place' : lifted ? 'bring the spare wheel' : 'lift the corner', `hammer ${Math.round(Number(m.data.hammer) / 4 * 100)}%`];
        if (Number(m.data.hammer) >= 4) {
          if (spare) this.phys.remove(spare, 'fitted');
          done = true;
        }
        break;
      }
      case 'voice:sing': {
        const ids = liv.map((p) => p.id);
        const loud = ids.filter((id) => (this.voice[id]?.vad ?? 0) > 0.3).length;
        const need = Math.max(1, Math.ceil(ids.length * 0.6));
        if (loud >= need) m.progress += dt * (hasRole(run, 'whisperer') ? 2 : 1) * (hasRole(run, 'streamer') ? 1.25 : 1);
        st.notes = [`${loud}/${ids.length} singing (need ${need})`];
        if (m.progress >= m.goal) done = true;
        break;
      }
      case 'voice:talent': {
        const sc = (m.data as Record<string, number>);
        for (const p of liv) sc[`s:${p.id}`] = (Number(sc[`s:${p.id}`]) || 0) + (this.voice[p.id]?.expr ?? 0) * dt;
        const best = liv.map((p) => [p.id, Number(sc[`s:${p.id}`]) || 0] as const).sort((a, b) => b[1] - a[1])[0];
        if (best) { m.data.winner = this.nameOf(best[0]); m.progress = Math.min(1, best[1] / 3); }
        st.notes = best ? [`leader: ${m.data.winner}`] : [];
        break;
      }
      case 'trail3d:pothole': {
        const on = liv.filter((p) => p.seat >= 0 || this.phys.inCargo(this.phys.feet(p)) || this.phys.inRevive(this.phys.feet(p))).length;
        m.progress = liv.length ? on / liv.length : 1;
        st.notes = [`${on}/${liv.length} back on the ${this.deck.text.wagon}`];
        break;
      }
      case 'runs': {
        const t = m.ev?.target ? this.phys.players.get(m.ev.target) : null;
        if (!t || !m.goalZone) { done = true; break; }
        if (inZone({ p: m.goalZone.p, he: m.goalZone.he }, ...this.phys.feet(t))) { m.progress = 1; done = true; }
        break;
      }
      case 'photo': {
        const inIt = liv.filter((p) => m.goalZone && inZone({ p: m.goalZone.p, he: m.goalZone.he }, ...this.phys.feet(p))).length;
        if (inIt === liv.length && liv.length) m.progress += dt; else m.progress = Math.max(0, m.progress - dt * 0.5);
        st.notes = [`${inIt}/${liv.length} in the frame`];
        if (m.progress >= m.goal) { this.emit({ e: 'photo', names: liv.map((p) => this.nameOf(p.id)) }); done = true; }
        break;
      }
      case 'mud': {
        if (m.data.bog && this.journey) {
          const J = this.journey;
          m.progress = J.st.bogged ? J.st.push : 1;
          st.notes = [`push ${Math.round(J.pushing * 70)}/${Math.round((J.st.bogged ? 2 : 1.5) * 70)} kg`, 'walk into the back of the wagon'];
          if (!J.st.bogged) done = true;
          break;
        }
        const wp = this.phys.pos(w);
        let push = 0;
        for (const p of liv) {
          const f = this.phys.feet(p);
          const behind = f[2] < wp[2] - 1.6 && f[2] > wp[2] - 3.6 && Math.abs(f[0] - wp[0]) < 1.6;
          if (behind && p.input.mz > 0.5 && Math.abs(Math.sin(p.input.yaw)) < 0.6) push += p.st.lift * (run.party[p.id]?.role === 'carpenter' ? 1.5 : 1);
          else if (p.grab?.ent === this.phys.wagon!.id) push += p.st.lift * 0.6;
        }
        if (push >= 300) { m.progress += dt; this.phys.wagonVel = [0, 0, 0.6]; } else this.phys.wagonVel = [0, 0, 0];
        st.notes = [`push ${Math.round(push)}/300 kg`];
        if (m.progress >= m.goal) done = true;
        break;
      }
      case 'search': {
        const e = this.phys.ents.get(Number(m.data.ent));
        if (!e?.body) { done = true; break; }
        const ep = this.phys.pos(e.body);
        for (const p of liv) if ((p.input.buttons & BTN.use) && Math.hypot(this.phys.feet(p)[0] - ep[0], this.phys.feet(p)[2] - ep[2]) < 2.2) { m.progress = 1; done = true; this.fx('sparkle', ep); }
        break;
      }
      case 'ghostrace': {
        const inIt = liv.filter((p) => m.goalZone && inZone({ p: m.goalZone.p, he: m.goalZone.he }, ...this.phys.feet(p))).length;
        m.progress = liv.length ? inIt / liv.length : 1;
        st.notes = [`${inIt}/${liv.length} across the line`];
        if (inIt === liv.length) done = true;
        break;
      }
      case 'thieves': {
        // raiders run the wagon down; a grab catches one, reaching the wagon = a stolen crate (the deck's outcome takes it)
        const J = this.journey && this.level.kind === 'journey' ? this.journey : null;
        const wl = J ? J.wagonLocal() : this.phys.pos(this.phys.wagon!.body!);
        const ids = String(m.data.raiders ?? '').split(',').map(Number).filter(Boolean);
        let left = 0;
        for (const id of ids) {
          const e = this.phys.ents.get(id);
          if (!e?.body) continue;
          const p = this.phys.pos(e.body);
          if (this.phys.holders(id).length) { m.data.caught = Number(m.data.caught ?? 0) + 1; this.fx('confetti', p); this.toast(`${this.nameOf(this.phys.holders(id)[0].id)} tackled a thief!`, 'good'); this.phys.remove(e, 'caught'); continue; }
          const fled = !!m.data[`f${id}`];
          let tx = wl[0], tz = wl[2], sp = 8.3;
          if (fled) { const dx = p[0] - wl[0], dz = p[2] - wl[2], l = Math.hypot(dx, dz) || 1; tx = p[0] + dx / l * 10; tz = p[2] + dz / l * 10; sp = 9; if (l > 45) { this.phys.remove(e, 'escaped'); continue; } }
          else if (Math.hypot(p[0] - wl[0], p[2] - wl[2]) < 2.8) { m.data[`f${id}`] = 1; m.data.stolen = Number(m.data.stolen ?? 0) + 1; this.fx('dust', p); this.toast('A thief snatched something off the wagon!', 'bad'); }
          left++;
          const dx = tx - p[0], dz = tz - p[2], l = Math.hypot(dx, dz) || 1, v = e.body.linvel();
          e.body.setLinvel({ x: v.x + (dx / l * sp - v.x) * Math.min(1, dt * 4), y: v.y, z: v.z + (dz / l * sp - v.z) * Math.min(1, dt * 4) }, true);
          e.body.setRotation({ x: 0, y: Math.sin(Math.atan2(dx, dz) / 2), z: 0, w: Math.cos(Math.atan2(dx, dz) / 2) }, true);
          e.animal!.state = fled ? 'flee' : 'wander';
        }
        const stolen = Number(m.data.stolen ?? 0), caught = Number(m.data.caught ?? 0);
        st.notes = [`${caught} caught`, `${stolen} got to the cargo`];
        m.progress = Math.max(0, m.goal - stolen);
        if (!left) { if (stolen === 0) done = true; else m.t = m.dur; }
        break;
      }
      case 'stampede': {
        // the herd runs across the road; the wagon must be (nearly) stopped when it crosses, and nobody in the way
        const ids = String(m.data.herd ?? '').split(',').map(Number).filter(Boolean);
        const dirx = Number(m.data.dx), dirz = Number(m.data.dz);
        const J = this.journey;
        const wl = J && this.level.kind === 'journey' ? J.wagonLocal() : this.phys.pos(this.phys.wagon!.body!);
        for (const id of ids) {
          const e = this.phys.ents.get(id);
          if (!e?.body) continue;
          const v = e.body.linvel(), sp = 7.5;
          e.body.setLinvel({ x: v.x + (dirx * sp - v.x) * Math.min(1, dt * 5), y: v.y, z: v.z + (dirz * sp - v.z) * Math.min(1, dt * 5) }, true);
          const p = this.phys.pos(e.body);
          if (!m.data.hit && J && Math.hypot(p[0] - wl[0], p[2] - wl[2]) < 3.2 && Math.abs(J.speed) > 1.5) { m.data.hit = 1; this.onCrash(Math.max(6.6, Math.abs(J.speed) + 3)); this.toast(`The herd smashed into the ${this.deck.text.wagon}!`, 'bad'); }
          for (const pl of liv) {
            const f = this.phys.feet(pl);
            if (pl.ragdoll > 0 || Math.hypot(f[0] - p[0], f[2] - p[2]) >= 1.3 + pl.st.radius) continue;
            // a macro stands like a rock (the herd splits around them) and shields whoever stands right behind them
            if (pl.st.cls === 'macro') { const v = e.body.linvel(); e.body.setLinvel({ x: -v.x * 0.3 + dirz * 6, y: v.y + 2, z: -v.z * 0.3 - dirx * 6 }, true); continue; }
            const shield = liv.some((o) => o.st.cls === 'macro' && o !== pl && (() => { const g = this.phys.feet(o); const bx = f[0] - g[0], bz = f[2] - g[2]; return bx * dirx + bz * dirz > 0 && bx * dirx + bz * dirz < 3 && Math.abs(bx * dirz - bz * dirx) < 1.4; })());
            if (shield) continue;
            this.phys.ragdoll(pl, 1.8, [dirx * pl.st.mass * 6, pl.st.mass * 4, dirz * pl.st.mass * 6]); m.data.trampled = Number(m.data.trampled ?? 0) + 1; this.hurt(pl.id, 6, 'a stampede');
          }
        }
        st.notes = [J ? `speed ${Math.abs(J.speed).toFixed(1)} m/s` : '', `${Number(m.data.trampled ?? 0)} trampled`];
        m.progress = m.t / m.dur;
        if (m.t >= m.dur - 0.1) { done = !m.data.hit && Number(m.data.trampled ?? 0) === 0; if (!done && !m.data.hit) m.progress = 0.6; else if (m.data.hit) m.progress = 0.2; }
        break;
      }
      case 'chase': {
        const ids = String(m.data.thieves ?? '').split(',').map(Number).filter(Boolean);
        let caught = 0;
        for (const id of ids) {
          const e = this.phys.ents.get(id);
          if (!e) { caught++; continue; }
          if (this.phys.holders(id).length) { caught++; e.animal!.state = 'dead'; this.fx('confetti', this.phys.pos(e.body!)); this.phys.remove(e, 'caught'); }
        }
        m.progress = caught;
        st.notes = [`${caught}/${ids.length} caught`];
        if (caught >= ids.length) done = true;
        break;
      }
    }
    st.objective = { ...(st.objective ?? { label: '' }), progress: m.progress, goal: m.goal };
    this.dirty = true;
    if (done || m.t >= m.dur || this.stopTimer > 0) { this.stopTimer = 0; this.endMini(done); }
  }
  private endMini(done: boolean) {
    const m = this.mini!;
    this.mini = null;
    this.setTilt(0);
    if (m.data.bog && this.journey) this.journey.unbog();
    this.phys.zones = this.phys.zones.filter((z) => z.name !== 'mini_goal');
    for (const e of [...this.phys.ents.values()]) if (e.animal && (e.animal.kind === 'thief' || e.animal.kind === 'goose')) this.phys.remove(e, 'escaped');
    for (const id of String(m.data.herd ?? '').split(',').map(Number).filter(Boolean)) { const e = this.phys.ents.get(id); if (e) this.phys.remove(e, 'gone'); }
    for (const id of String(m.data.raiders ?? '').split(',').map(Number).filter(Boolean)) { const e = this.phys.ents.get(id); if (e) this.phys.remove(e, 'escaped'); }
    if (m.data.ent) { const e = this.phys.ents.get(Number(m.data.ent)); if (e) this.phys.remove(e); }
    const frac = m.goal ? m.progress / m.goal : 0;
    const result: 'success' | 'partial' | 'fail' = done ? (m.kind === 'trail3d:pothole' ? (frac >= 1 ? 'success' : frac >= 0.5 ? 'partial' : 'fail') : 'success')
      : m.kind === 'voice:talent' ? (m.progress >= 0.35 ? 'success' : 'fail') : m.kind === 'trail3d:pothole' ? (frac >= 1 ? 'success' : frac >= 0.5 ? 'partial' : 'fail') : frac >= 0.5 ? 'partial' : 'fail';
    this.state.stop = null;
    this.state.phase = 'travel';
    for (const p of this.phys.players.values()) if (p.seat < 0 && !p.downed && p.ragdoll <= 0 && this.phys.nearWagon(this.phys.feet(p), 3)) this.phys.sit(p, this.phys.freeSeat(p));
    this.dirty = true;
    this.finishEvent(m.ev!, m.choice!, result, m.data.winner ? { winner: String(m.data.winner) } : undefined);
  }

  // ================================================================ STOP: river crossing
  private riverVote(n: RouteNode) {
    const run = this.run!;
    const rv = run.river!;
    const T = this.deck.text;
    const cost = n.ferry ?? 5;
    const text = fill(T.riverCard, run, this.deck, { extra: { depth: rv.depth.toFixed(1), width: rv.width, swift: rv.swift ? T.swift : '' } });
    this.openVote({ id: `river_${n.id}`, title: n.name, text, kind: 'river', options: [
      { id: 'ford', label: T.ford, hint: rv.depth > 3 ? 'deep: risky' : 'free' },
      { id: 'caulk', label: T.caulk, hint: 'float across' },
      { id: 'ferry', label: fill(T.ferry, run, this.deck, { extra: { cost: `${this.deck.currency.sym}${cost}` } }), hint: 'safe', disabled: run.money >= cost ? undefined : `needs ${this.deck.currency.sym}${cost}` },
      { id: 'wait', label: T.wait, hint: 'depth changes' },
      { id: 'ask', label: T.ask, hint: 'a tip', disabled: run.flags[`asked_${n.id}`] ? 'already asked' : undefined },
    ] }, 18, (r) => {
      const choice = r as RiverChoice;
      if (choice === 'wait') { const res = applyEffects(run, this.deck, [{ k: 'days', n: 1 }], { target: null, volunteer: null, cause: 'waiting' }, this.rng); this.handleDeaths(res.deaths); run.river = riverAt(run, n, this.rng); this.syncItem('food'); this.riverVote(n); return; }
      if (choice === 'ask') {
        run.flags[`asked_${n.id}`] = 1;
        const npc = this.deck.npcs.talker_1;
        const tip = rv.depth > 3.3 ? 'Too deep to ford. Take the ferry or caulk it.' : rv.depth < 2.5 ? 'Shallow enough to ford this week.' : rv.swift ? 'The current is strong. I\'d caulk it.' : 'You could ford it, if you\'re careful.';
        this.showCard({ id: 'ask', title: npc?.name ?? 'A local', text: `"${tip}"` }, 5, () => this.riverVote(n));
        return;
      }
      if (choice === 'ferry') run.money -= cost;
      this.enterRiver(choice as 'ford' | 'caulk' | 'ferry', n);
    });
  }
  private enterRiver(mode: 'ford' | 'caulk' | 'ferry', n: RouteNode) {
    const run = this.run!;
    this.state.phase = 'stop';
    const desc = this.makeLevel('river');
    this.newWorld(desc, true);
    const T = this.deck.text;
    const prep = mode === 'ford' ? 35 : mode === 'ferry' ? 20 : 12;
    const data: Record<string, unknown> = { mode, phase: 'prep', t: 0, prep, pathI: 0, tipped: 0, lostBefore: 0, node: n.id };
    if (mode === 'ferry') {
      const f = desc.paths.ferry[0];
      const plat = this.phys.addPlatform([f[0], f[1] - 0.15, f[2]], [2.2, 0.15, 3.6]);
      data.plat = plat.id;
      this.phys.setWagon([f[0], f[1], f[2]], desc.wagon.yaw);
      if (!desc.npcs.some((n) => n.id === 'ferryman')) this.phys.addNpc('ferryman', this.deck.npcs.ferryman?.name ?? 'Ferryman', [f[0] - 1.6, f[1], f[2] + 2.8], 0);
    }
    if (mode === 'caulk') { const c = desc.paths.caulk?.[0] ?? desc.wagon.p; this.phys.setWagon([c[0], c[1], c[2]], desc.wagon.yaw); }
    this.stopData = data;
    this.stopTimer = 0;
    this.setStop({ kind: 'river', level: 'river', title: `${n.name} — ${mode === 'ford' ? T.ford : mode === 'caulk' ? T.caulk : 'Ferry'}`, endsAt: Math.round((this.time + prep) * 1000), river: mode,
      objective: { label: mode === 'ford' ? `Carry what you can't risk across by hand — the ${T.wagon} fords in ${prep} s` : mode === 'ferry' ? `Everyone onto the ferry!` : `Get aboard — then hold E to paddle across`, progress: 0, goal: 1 }, ready: [], notes: [`depth ${run.river?.depth.toFixed(1)} ft${run.river?.swift ? ', swift' : ''}`] });
    this.sendLevel('river');
    this.afterStop = () => this.enterTravel();
    for (const p of this.phys.players.values()) if (mode === 'ferry' || mode === 'caulk') this.phys.sit(p, this.phys.freeSeat(p));
  }
  private stepRiver(dt: number) {
    const run = this.run!;
    const d = this.stopData as { mode: string; phase: string; t: number; prep: number; pathI: number; tipped: number; plat?: number };
    d.t += dt;
    const st = this.state.stop!;
    const w = this.phys.wagon!;
    const wb = w.body!;
    const path = this.level.paths[d.mode === 'ferry' ? 'ferry' : d.mode === 'caulk' ? 'caulk' : 'ford'];
    // swept things past the rapids: props are lost, players wash up at the catch net
    for (const e of [...this.phys.ents.values()]) {
      if (!e.body) continue;
      const p = this.phys.pos(e.body);
      if (this.lostDownstream(e, p)) {
        if (e.info.kind === 'prop') { this.phys.remove(e, 'swept away'); if (e.owned) this.toast(`${e.item === 'food' ? 'A crate of food' : `${/^[aeiou]/i.test(this.itemName(e.item ?? 'thing', 1)) ? 'An' : 'A'} ${this.itemName(e.item ?? 'thing', 1)}`} was swept away!`, 'bad'); }
        else if (e.info.kind === 'player') {
          const pl = this.phys.playerOfEnt(e.id)!;
          // wash up at the catch net — unless the art put the net inside the rapids (then the near bank), and get a few
          // seconds' grace so nobody loops "swept → caught → swept" every second
          const rz = this.phys.zone('rapids'), catchZ = this.phys.zone('catch');
          const inRapids = (z: typeof catchZ) => !!(z && rz && inZone({ ...rz, he: [rz.he[0], 20, rz.he[2]] }, z.p[0], z.p[1], z.p[2]));
          const c = catchZ && !inRapids(catchZ) ? catchZ : this.phys.zone('nearbank') ?? catchZ;
          pl.body.setTranslation({ x: c?.p[0] ?? 20, y: (c?.p[1] ?? 0) + 2, z: c?.p[2] ?? -12 }, true);
          this.rapidT.set(e.id, -5);
          pl.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          const m = run.party[pl.id];
          if (m) m.stats.swept++;
          this.toast(fill(this.deck.text.swept, run, this.deck, { extra: { name: this.nameOf(pl.id) } }), 'bad');
          this.hurt(pl.id, 10, 'drowning');
        }
      }
    }
    if (d.phase === 'prep') {
      st.objective!.progress = d.t / d.prep;
      if (d.t >= d.prep || this.stopTimer > 0) { this.stopTimer = 0; d.phase = 'cross'; d.t = 0; d.pathI = 0; st.endsAt = Math.round((this.time + 60) * 1000); this.toast(d.mode === 'ford' ? `The ${this.deck.text.wagon} starts across!` : d.mode === 'ferry' ? 'The ferry casts off!' : 'Launch!', 'info'); if (d.mode === 'caulk') this.launchRaft(); }
      this.dirty = true;
      return;
    }
    if (d.mode === 'ford' || d.mode === 'ferry') {
      const target = path[Math.min(path.length - 1, d.pathI + 1)];
      const body = d.mode === 'ferry' ? this.phys.ents.get(d.plat!)?.body ?? wb : wb;
      const p = this.phys.pos(body);
      const dx = target[0] - p[0], dy = (target[1] + (d.mode === 'ferry' ? -0.15 : 0)) - p[1], dz = target[2] - p[2];
      const dist = Math.hypot(dx, dy, dz);
      const sp = d.mode === 'ferry' ? 0.75 : 1.1;
      if (dist < 0.1) d.pathI++;
      else {
        const k = Math.min(1, (sp * dt) / dist);
        let sink = 0;
        if (d.mode === 'ferry') {
          // overloaded ferry sinks (a macro alone is 600 kg)
          const load = [...this.phys.players.values()].filter((pl) => { const f = this.phys.feet(pl); return Math.abs(f[0] - p[0]) < 2.4 && Math.abs(f[2] - p[2]) < 3.8 && f[1] > p[1] - 0.5; }).reduce((a, pl) => a + pl.st.mass, 0);
          const over = Math.max(0, load - 900);
          d.tipped = Math.min(1.2, d.tipped + over / 100 * 0.012 * dt * 60 / 60);
          sink = -d.tipped;
          if (over > 0 && this.tick % 120 === 0) this.toast(`${this.deck.npcs.ferryman?.name ?? 'The ferryman'}: "TOO HEAVY! We're sinking!"`, 'meme');
        }
        const next = { x: p[0] + dx * k, y: p[1] + dy * k + (sink - (p[1] - (target[1] - 0.15))) * (d.mode === 'ferry' ? 0.02 : 0), z: p[2] + dz * k };
        if (d.mode === 'ferry') {
          const plat = this.phys.ents.get(d.plat!)!.body!;
          plat.setNextKinematicTranslation(next);
          this.phys.wagonVel = [(next.x - p[0]) / dt, (next.y - p[1]) / dt, (next.z - p[2]) / dt];
          if (d.tipped > 0.55 && !d.phase.includes('wet')) { d.phase = 'cross-wet'; for (const e of [...this.phys.ents.values()]) if (e.stowed && e.item !== 'draft') this.phys.unstow(e, [0, 20, 0]); this.toast('The ferry is under water — the cargo is floating off!', 'bad'); }
        } else {
          this.phys.wagonVel = [(next.x - p[0]) / dt, (next.y - p[1]) / dt, (next.z - p[2]) / dt];
          // tipping risk while in deep water (depth, current, load, macro riders)
          const inWater = p[1] < (this.level.water[0]?.level ?? 0) - 0.2;
          if (inWater && !d.tipped) {
            const depthM = (run.river?.depth ?? 3) * 0.3048;
            const cargo = [...this.phys.ents.values()].filter((e) => e.stowed && e.item !== 'draft').reduce((a, e) => a + (e.info.mass ?? 10), 0);
            const riders = [...this.phys.players.values()].filter((pl) => pl.seat >= 0).reduce((a, pl) => a + pl.st.mass, 0);
            const risk = Math.pow(depthM / 1.1, 2.2) * (run.river?.swift ? 1.6 : 1) * (0.4 + cargo / 250 + riders / 400) * 0.012;
            if (this.misc.chance(risk * dt * 60 / 60)) { d.tipped = 1; this.tipWagon(); }
          }
        }
      }
      if (d.tipped === 1 && d.mode === 'ford') { this.phys.wagonRoll = Math.min(1.25, this.phys.wagonRoll + dt * 1.8); d.t += 0; if (this.phys.wagonRoll >= 1.25) d.tipped = 2; }
      else if (d.tipped >= 2 && d.mode === 'ford') { d.tipped += dt; if (d.tipped > 6) { this.phys.wagonRoll = Math.max(0, this.phys.wagonRoll - dt * 1.2); if (this.phys.wagonRoll <= 0) d.tipped = -1; } }
      const arrived = d.pathI >= path.length - 1;
      st.objective = { label: d.mode === 'ford' ? `The ${this.deck.text.wagon} is fording — grab anything floating away!` : 'Crossing…', progress: d.pathI / (path.length - 1), goal: 1 };
      if (arrived && !d.phase.endsWith('landed')) { d.phase = 'landed'; d.t = 0; this.phys.wagonVel = [0, 0, 0]; this.toast('Made it to the far bank! Collect anything that floated off (10 s).', 'good'); st.endsAt = Math.round((this.time + 12) * 1000); }
      if (d.phase === 'landed' && (d.t > 12 || this.stopTimer > 0)) return this.endRiver();
    } else {
      // caulk & float: a buoyant dynamic raft; paddlers (hold E aboard) push toward the far bank against the current
      const p = this.phys.pos(wb);
      let paddle = 0;
      for (const pl of this.phys.players.values()) if ((pl.input.buttons & BTN.use) && (pl.seat >= 0 || this.phys.inCargo(this.phys.feet(pl)))) paddle += Math.min(1.5, pl.st.lift / 45);
      const m = this.wagonSpec.mass;
      // paddle toward the far bank, against the current
      const fb = this.phys.zone('farbank');
      const tx = (fb?.p[0] ?? p[0]) - p[0], tz = (fb?.p[2] ?? p[2] + 10) - p[2], tl = Math.hypot(tx, tz) || 1;
      const flow = this.level.water[0]?.flow ?? [1.6, 0];
      const k = Math.min(2.5, paddle) / 2.5 * 3.6 * m * dt;
      wb.applyImpulse({ x: (tx / tl) * k - flow[0] * 0.35 * m * Math.min(1, paddle / 2) * dt, y: 0, z: (tz / tl) * k - flow[1] * 0.35 * m * Math.min(1, paddle / 2) * dt }, true);
      const q = wb.rotation();
      const up = rotV([0, 1, 0], q);
      const tilt = Math.acos(clamp(up[1], -1, 1));
      const farZ = this.phys.zone('farbank'), nearZ = this.phys.zone('nearbank');
      const span = farZ && nearZ ? Math.hypot(farZ.p[0] - nearZ.p[0], farZ.p[2] - nearZ.p[2]) : 22;
      const left = farZ ? Math.hypot(farZ.p[0] - p[0], farZ.p[2] - p[2]) : 11;
      st.objective = { label: `Paddle! (${paddle.toFixed(1)} paddlers) — don't all stand on one side`, progress: clamp(1 - left / span, 0, 1), goal: 1 };
      if (tilt > 0.75 && !d.tipped) { d.tipped = 1; this.tipWagon(true); }
      const landed = this.onFarBank(p);
      const rz = this.phys.zone('rapids');
      const rapids = !!rz && inZone({ ...rz, he: [rz.he[0], 20, rz.he[2]] }, p[0], p[1], p[2]);
      if (landed || rapids || d.t > 70 || this.stopTimer > 0) {
        if (rapids && !d.tipped) { d.tipped = 1; this.tipWagon(true); this.toast('The raft hit the rapids!', 'bad'); }
        // haul the wagon out onto the far bank (the end of the crossing path)
        const end = this.level.paths.ford?.at(-1) ?? this.level.paths.caulk?.at(-1) ?? [p[0], 0, p[2]];
        this.phys.wagon!.body!.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
        this.phys.setWagon([end[0], end[1], end[2]], this.level.wagon.yaw);
        return this.endRiver();
      }
    }
    this.dirty = true;
  }
  /** On the far bank of the current river level (the farbank zone; a generous vertical range). */
  private onFarBank(pt: V3): boolean { const z = this.phys.zone('farbank'); return !!z && inZone({ ...z, he: [z.he[0], 50, z.he[2]] }, pt[0], pt[1], pt[2]); }
  /** Swept past the rapids / out of the level: things are lost, people wash up at the catch net. */
  private rapidT = new Map<number, number>();
  private lostDownstream(e: Ent, p: V3): boolean {
    if (e.info.kind === 'player' && this.phys.playerOfEnt(e.id)?.ghost) return false;
    if (e.hitched !== undefined || e.info.kind === 'wagon' || e.info.kind === 'platform' || e.info.kind === 'npc') return false; // harnessed animals ride with the wagon
    if (p[1] < -12) return true;
    const L = this.level.size;
    if (Math.abs(p[0]) > L[0] / 2 + 6 || Math.abs(p[2]) > L[1] / 2 + 6) return true;
    const rz = this.phys.zone('rapids');
    if (rz && inZone({ ...rz, he: [rz.he[0], 20, rz.he[2]] }, p[0], p[1], p[2])) { const t = (this.rapidT.get(e.id) ?? 0) + 1 / 60; this.rapidT.set(e.id, t); return t > 1.2; }
    const t = this.rapidT.get(e.id);
    if (t !== undefined) { if (t < 0) this.rapidT.set(e.id, t + 1 / 60); else this.rapidT.delete(e.id); }
    return false;
  }
  private launchRaft() {
    const w = this.phys.wagon!.body!;
    w.setBodyType(this.R.RigidBodyType.Dynamic, true);
    w.setLinearDamping(0.6); w.setAngularDamping(1.2);
    // the raft floats: buoyancy on the bed (the world's water forces don't treat the wagon, so do it here each step)
    this.stopData.raft = true;
  }
  private raftBuoyancy() {
    const w = this.phys.wagon?.body;
    if (!w || w.bodyType() !== this.R.RigidBodyType.Dynamic) return;
    const water = this.level.water[0];
    if (!water) return;
    // four floats at the bed corners: stable unless the load is lopsided
    for (const c of [[-0.9, 0.7, -1.7], [0.9, 0.7, -1.7], [-0.9, 0.7, 1.7], [0.9, 0.7, 1.7]] as V3[]) {
      const off = rotV(c, w.rotation()), t = w.translation();
      const y = t.y + off[1];
      const sub = clamp((water.level + 0.35 - y) / 0.7, 0, 1);
      if (sub <= 0) continue;
      const pv = w.linvel();
      w.applyImpulseAtPoint({ x: this.wagonSpec.mass * water.flow[0] * 0.15 * sub / 60, y: (this.wagonSpec.mass * 9.81 * 0.55 * sub - pv.y * 180 * sub) / 60, z: 0 }, { x: t.x + off[0], y, z: t.z + off[2] }, true);
    }
  }
  private tipWagon(raft = false) {
    const w = this.phys.wagon!.body!;
    this.fx('tip', this.phys.pos(w));
    this.emit({ e: 'shake', k: 1.4 });
    this.toast(fill(this.deck.text.tipped, this.run!, this.deck), 'bad');
    for (const e of [...this.phys.ents.values()]) if (e.stowed && e.item !== 'draft') this.phys.unstow(e, [this.misc.range(0.5, 3) * (e.info.mass ?? 10), (e.info.mass ?? 10) * 3, this.misc.range(-1, 1) * (e.info.mass ?? 10)]);
    for (const p of this.phys.players.values()) if (p.seat >= 0 && this.misc.chance(0.7)) { this.phys.unseat(p, false); this.phys.ragdoll(p, 2, [p.st.mass * 3, p.st.mass * 3, 0]); }
    if (raft) w.applyTorqueImpulse({ x: 0, y: 0, z: -this.wagonSpec.mass * 2 }, true);
  }
  private endRiver() {
    const run = this.run!;
    const d = this.stopData as { mode: string };
    // anyone still on the near bank / in the water swims over (players far from the wagon are fetched)
    for (const p of this.phys.players.values()) if (!this.onFarBank(this.phys.feet(p))) { this.respawnNearWagon(p); if (p.st.cls !== 'macro') this.hurt(p.id, 4, 'drowning'); }
    this.phys.wagonRoll = 0;
    // things dropped on the far bank right next to the wagon get loaded (a kindness)
    const wpos = this.phys.pos(this.phys.wagon!.body!);
    for (const e of this.phys.ents.values()) {
      if (e.info.kind !== 'prop' || !e.owned || !e.body || e.stowed || this.phys.holders(e.id).length) continue;
      const pp = this.phys.pos(e.body);
      if (this.onFarBank(pp) && Math.hypot(pp[0] - wpos[0], pp[2] - wpos[2]) < 6) this.phys.stow(e);
    }
    const ch = this.recount();
    this.syncAll();
    run.river = null;
    const lost = ch.some((c) => c.after < c.before);
    this.endStop(`${d.mode === 'ford' ? 'You forded the river.' : d.mode === 'ferry' ? 'The ferry got you across.' : 'You floated across.'} ${this.describeChanges(ch)}`, lost ? 'Soggy, but across' : 'Across!');
  }

  // ================================================================ STOP: hunting
  private enterHunt() {
    const run = this.run!;
    this.state.phase = 'stop';
    this.huntN++;
    const desc = this.makeLevel('hunt');
    this.newWorld(desc, true);
    // animals from the theme's list
    // (ANIMAL_SPAWN_ nodes may name their kinds: each animal starts at a spawn that lists it, ground spawns first)
    const kinds = Object.entries(this.deck.animals);
    let si = 0;
    for (const [kind, a] of kinds) for (let i = 0; i < a.count; i++) {
      const own = desc.animals.filter((s) => s.kinds.includes(kind));
      const pool = own.filter((s) => !s.air).length ? own.filter((s) => !s.air) : own.length ? own : desc.animals.filter((s) => !s.kinds.length || !s.air);
      const sp = pool.length ? pool[(si++ + i) % pool.length] : desc.animals[si++ % Math.max(1, desc.animals.length)];
      if (!sp) break;
      const r = Math.min(3, sp.radius ?? 3);
      this.phys.addAnimal(kind, [sp.p[0] + this.misc.range(-r, r), sp.p[1], sp.p[2] + this.misc.range(-r, r)], a);
    }
    this.stopData = { shot: 0, dur: 90 };
    this.stopTimer = 0;
    this.setStop({ kind: 'hunt', level: 'hunt', title: `Hunting — ${this.deck.text.huntTool}`, endsAt: Math.round((this.time + 90) * 1000), objective: { label: `Shoot (LMB), then carry the meat back to the ${this.deck.text.wagon}`, progress: 0, goal: 0, unit: 'lbs' }, ready: [], notes: [`${this.deck.items.ammo.name}: ${run.items.ammo}`] });
    this.sendLevel('hunt');
    for (const p of this.phys.players.values()) this.applyMods(p);
    this.afterStop = () => this.enterTravel();
  }
  private shoot(p: PlayerPhys) {
    const run = this.run!;
    if (p.fireCd > 0 || p.ghost || p.downed || p.ragdoll > 0) return;
    if (run.items.ammo <= 0) { if (this.tick % 30 === 0) this.toast(`${this.nameOf(p.id)} is out of ${this.deck.text.ammoUnit}!`, 'bad', p.id); p.fireCd = 0.5; return; }
    p.fireCd = 0.55;
    run.items.ammo--;
    this.syncItem("ammo");
    const m = run.party[p.id];
    if (m) m.stats.shots++;
    const o = this.phys.eye(p), d = this.phys.aimDir(p);
    const R = this.R;
    let hit = this.phys.world.castRay(new R.Ray({ x: o[0], y: o[1], z: o[2] }, { x: d[0], y: d[1], z: d[2] }), 70, true, undefined, undefined, p.col, p.body, (c) => !c.isSensor());
    let target = hit ? this.phys.entOfCollider(hit.collider) : null;
    // aim assist (Hunters more): the nearest live animal within a small cone
    if (!target || target.info.kind !== 'animal') {
      const cone = m?.role === 'hunter' ? 0.11 : 0.05;
      let best: Ent | null = null, bestA = cone;
      for (const e of this.phys.ents.values()) {
        if (!e.animal || e.animal.state === 'dead' || !e.body) continue;
        const ep = this.phys.pos(e.body), v: V3 = [ep[0] - o[0], ep[1] - o[1], ep[2] - o[2]];
        const len = Math.hypot(...v);
        if (len > 60) continue;
        const ang = Math.acos(clamp((v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) / len, -1, 1));
        if (ang < bestA) { bestA = ang; best = e; }
      }
      if (best) { target = best; hit = null; }
    }
    const at: V3 = target?.body ? this.phys.pos(target.body) : [o[0] + d[0] * 40, o[1] + d[1] * 40, o[2] + d[2] * 40];
    this.emit({ e: 'fx', fx: 'shot', at, by: p.id });
    this.dirty = true;
    if (!target) return;
    if (target.animal && target.animal.state !== 'dead') {
      if (target.animal.state === 'carry') this.dropCarried(target, `${this.nameOf(p.id)} made the ${this.deck.animals[target.animal.kind]?.name ?? target.animal.kind} let go!`);
      target.animal.hp--;
      target.animal.state = target.animal.danger > 0.5 ? 'attack' : 'flee';
      target.animal.target = p.id;
      this.fx('hit', at);
      if (target.animal.hp <= 0) {
        target.animal.state = 'dead';
        const b = target.body!;
        b.setEnabledRotations(true, true, true, true);
        b.setAngularDamping(4); b.setLinearDamping(2.5);
        b.applyTorqueImpulse({ x: (target.info.mass ?? 30) * 0.8, y: 0, z: 0 }, true);
        target.info.sub = `carcass:${target.animal.kind}`;
        target.item = 'meat';
        (this.stopData as { shot: number }).shot += target.animal.kg * 2.2;
        if (m) m.stats.hits++;
        const an = this.deck.animals[target.animal.kind]?.name ?? target.animal.kind;
        this.toast(`${this.nameOf(p.id)} got ${/^[aeiou]/i.test(an) ? 'an' : 'a'} ${an}! (${Math.round(target.animal.kg * 2.2)} lbs)`, 'good');
        this.phys.spawned.push({ ...target.info });
      }
    } else if (target.info.kind === 'player') {
      const other = this.phys.playerOfEnt(target.id);
      if (other && !other.ghost) { this.phys.ragdoll(other, 1.3, [d[0] * 80, 60, d[2] * 80]); this.hurt(other.id, 5, 'friendly fire'); this.toast(`${this.nameOf(p.id)} shot ${this.nameOf(other.id)}. Friendly fire!`, 'meme'); }
    }
  }
  private stepHunt() {
    const run = this.run!;
    const d = this.stopData as { shot: number };
    for (const p of this.phys.players.values()) if ((p.input.buttons & BTN.fire) && !p.grab) this.shoot(p);
    let carried = 0;
    for (const e of this.phys.ents.values()) if (e.animal?.state === 'dead' && e.body && (this.phys.inCargo(this.phys.pos(e.body)) || this.phys.inRevive(this.phys.pos(e.body)))) carried += e.animal.kg * 2.2;
    const st = this.state.stop!;
    const notes = [`${this.deck.items.ammo.name}: ${run.items.ammo}`, `shot ${Math.round(d.shot)} lbs`, `at the ${this.deck.text.wagon}: ${Math.round(carried)} lbs`];
    if (st.notes.join() !== notes.join()) { st.notes = notes; st.objective = { ...st.objective!, progress: Math.round(carried), goal: Math.round(d.shot) }; this.dirty = true; }
    if (this.time * 1000 >= st.endsAt || this.stopTimer > 0) {
      this.stopTimer = 0;
      this.recount();
      run.food += Math.round(carried);
      const txt = fill(this.deck.text.shotMeat, run, this.deck, { extra: { shot: Math.round(d.shot), carried: Math.round(carried) } });
      this.syncAll();
      this.endStop(txt, 'The hunt is over');
    }
  }
  private stepAnimals(dt: number) {
    // animals only act during their scene (the hunt, a chase); afterwards they just stand around
    if (this.state.stop?.kind !== "hunt" && !(this.mini && this.mini.kind === "chase")) return;
    const players = [...this.phys.players.values()].filter((p) => !p.ghost && !p.downed);
    for (const e of this.phys.ents.values()) {
      const a = e.animal;
      if (!a || !e.body || a.state === 'dead') continue;
      a.t -= dt; a.atkCd = Math.max(0, a.atkCd - dt);
      const pos = this.phys.pos(e.body);
      if (a.state === 'carry') { this.stepCarry(e, pos, dt); continue; }
      // senses: nearest visible player (micro in tall grass is invisible; macro / sprinting are noticed from further)
      let near: PlayerPhys | null = null, nd = 1e9;
      for (const p of players) {
        const f = this.phys.feet(p);
        const hidden = p.st.cls === 'micro' && this.level.zones.some((z) => z.name.startsWith('grass') && inZone(z, f[0], f[1] + 0.2, f[2]));
        if (hidden) continue;
        const k = (p.st.cls === 'macro' ? 2 : p.st.cls === 'large' ? 1.4 : 1) * ((p.input.buttons & BTN.sprint) ? 1.5 : 1);
        const dd = Math.hypot(f[0] - pos[0], f[2] - pos[2]) / k;
        if (dd < nd) { nd = dd; near = p; }
      }
      const thief = a.kind === 'thief' || a.kind === 'goose';
      if (a.danger > 0.5 && near && nd < 14 && a.state !== 'flee' && a.atkCd < 4) { a.state = 'attack'; a.target = near.id; }
      else if (a.state !== 'attack' && near && nd < (thief ? 12 : a.flee)) { a.state = 'flee'; a.t = 3; }
      else if (a.t <= 0 && a.state !== 'attack') { a.state = 'wander'; a.t = 2 + Math.random() * 3; a.dir += (Math.random() - 0.5) * 2; }
      let vx = 0, vz = 0;
      if (a.state === 'flee' && near) {
        const f = this.phys.feet(near);
        let dx = pos[0] - f[0], dz = pos[2] - f[2];
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        // zig-zag (geese / thieves are slippery)
        const zig = thief ? Math.sin(this.time * 3 + e.id) * 0.6 : 0;
        vx = (dx + dz * zig) * a.speed; vz = (dz - dx * zig) * a.speed;
      } else if (a.state === 'attack') {
        const t = a.target ? this.phys.players.get(a.target) : null;
        if (!t || t.ghost) { a.state = 'wander'; }
        else {
          const f = this.phys.feet(t);
          const dx = f[0] - pos[0], dz = f[2] - pos[2], l = Math.hypot(dx, dz) || 1;
          vx = dx / l * a.speed; vz = dz / l * a.speed;
          if (l < 1.6 + (e.info.size[2] ?? 1) / 2 && a.atkCd <= 0 && this.canGrab(a.kind, t)) { this.grab(e, t); continue; }
          if (l < 1.6 + (e.info.size[2] ?? 1) / 2 && a.atkCd <= 0) {
            a.atkCd = 2.2;
            this.phys.ragdoll(t, 2, [dx / l * t.st.mass * 5, t.st.mass * 4, dz / l * t.st.mass * 5]);
            this.hurt(t.id, 18 * a.danger, `a ${this.deck.animals[a.kind]?.name ?? a.kind}`);
            this.fx('impact', f);
            // big animals are scared off by macros (they bounce)
            if (t.st.cls === 'macro') { a.state = 'flee'; a.t = 4; }
          }
        }
      } else if (a.state === 'wander') {
        const hx = a.home[0] - pos[0], hz = a.home[2] - pos[2];
        const back = Math.hypot(hx, hz) > 10;
        const dir = back ? Math.atan2(hx, hz) : a.dir;
        vx = Math.sin(dir) * a.speed * 0.25; vz = Math.cos(dir) * a.speed * 0.25;
      }
      const v = e.body.linvel();
      e.body.setLinvel({ x: v.x + (vx - v.x) * Math.min(1, dt * 4), y: v.y, z: v.z + (vz - v.z) * Math.min(1, dt * 4) }, true);
      if (Math.hypot(vx, vz) > 0.2) e.body.setRotation({ x: 0, y: Math.sin(Math.atan2(vx, vz) / 2), z: 0, w: Math.cos(Math.atan2(vx, vz) / 2) }, true);
    }
  }

  // ---------------------------------------------------------------- grabbing animals (deck `grabs`: the wyvern takes micros)
  private canGrab(kind: string, t: PlayerPhys): boolean {
    const g = this.deck.animals[kind]?.grabs;
    if (!g || t.ghost || t.downed) return false;
    const order = ['micro', 'small', 'normal', 'large', 'macro'];
    return order.indexOf(t.st.cls) <= order.indexOf(g) && ![...this.phys.ents.values()].some((x) => x.animal?.carry?.pid === t.id)
      && (this.grabCount.get(t.id) ?? 0) < 2;   // twice per stop is funny, a third time is a chore
  }
  private grabCount = new Map<string, number>();
  private grab(e: Ent, t: PlayerPhys) {
    const a = e.animal!;
    this.grabCount.set(t.id, (this.grabCount.get(t.id) ?? 0) + 1);
    a.state = 'carry';
    a.carry = { pid: t.id, t: 0, hp: a.hp };
    e.body!.setGravityScale(0, true);
    this.phys.ragdoll(t, 1.5);
    this.toast(`The ${this.deck.animals[a.kind]?.name ?? a.kind} snatched ${this.nameOf(t.id)}! Shoot it to make it let go!`, 'bad', t.id);
    this.fx('impact', this.phys.feet(t));
  }
  /** Flies up and circles with its catch; lets go after a while (a long fall) or when shot. */
  private stepCarry(e: Ent, pos: V3, dt: number) {
    const a = e.animal!, c = a.carry!;
    const t = this.phys.players.get(c.pid);
    c.t += dt;
    if (!t || t.ghost || t.downed) { this.dropCarried(e); return; }
    const alt = 7 + Math.min(3, c.t);
    const ang = c.t * 0.6 + e.id;
    const vx = Math.cos(ang) * a.speed * 0.8 + (a.home[0] - pos[0]) * 0.15, vz = Math.sin(ang) * a.speed * 0.8 + (a.home[2] - pos[2]) * 0.15;
    const vy = (alt - pos[1]) * 1.5;
    e.body!.setLinvel({ x: vx, y: vy, z: vz }, true);
    e.body!.setRotation({ x: 0, y: Math.sin(Math.atan2(vx, vz) / 2), z: 0, w: Math.cos(Math.atan2(vx, vz) / 2) }, true);
    // the catch dangles under the talons
    const hang = (e.info.size[0] ?? 0.5) + t.st.height * 0.5 + 0.15;
    t.body.setTranslation({ x: pos[0], y: pos[1] - hang, z: pos[2] }, true);
    t.body.setLinvel({ x: vx, y: vy, z: vz }, true);
    t.ragdoll = Math.max(t.ragdoll, 0.5);
    // lets go after ~7 s — over solid ground if it can (floating islands), at the latest after 12 s
    if (c.t > 7 && (c.t > 12 || this.phys.groundAlong([pos[0], pos[1] - hang, pos[2]], [pos[0], pos[1] - hang, pos[2]], 14))) this.dropCarried(e, `The ${this.deck.animals[a.kind]?.name ?? a.kind} dropped ${this.nameOf(t.id)}!`);
  }
  private dropCarried(e: Ent, msg = '') {
    const a = e.animal!;
    const t = a.carry ? this.phys.players.get(a.carry.pid) : null;
    a.carry = undefined;
    a.state = 'flee'; a.t = 12; a.atkCd = 20;
    e.body?.setGravityScale(1, true);
    if (t) this.phys.ragdoll(t, 2);
    if (msg) this.toast(msg, 'info');
  }

  // ================================================================ STOP: landmark
  private enterLandmark(n: RouteNode) {
    this.state.phase = 'stop';
    const desc = this.makeLevel('landmark');
    this.newWorld(desc, true);
    this.stopData = { node: n.id, summit: [] as string[], photo: 0, photoT: 0 };
    this.setStop({ kind: 'landmark', level: 'landmark', title: n.name, endsAt: Math.round((this.time + 150) * 1000), objective: { label: 'Talk to people (E) · climb to the top · everyone into the photo spot', progress: 0, goal: 0 }, ready: [], notes: [] });
    this.sendLevel('landmark');
    this.afterStop = () => this.enterCamp();
  }
  private stepLandmark(dt: number) {
    const run = this.run!;
    const d = this.stopData as { node: string; summit: string[]; photo: number; photoT: number };
    const st = this.state.stop!;
    for (const p of this.phys.players.values()) {
      const f = this.phys.feet(p);
      if (this.phys.inZoneNamed('summit', [f[0], f[1] + 0.5, f[2]]) && !d.summit.includes(p.id)) {
        d.summit.push(p.id); run.morale = Math.min(100, run.morale + 3);
        this.toast(`${this.nameOf(p.id)} reached the top and signed the wall!`, 'good'); this.fx('confetti', f); this.dirty = true;
      }
    }
    const liv = [...this.phys.players.values()].filter((p) => run.party[p.id]?.alive || p.ghost);
    const inPhoto = liv.filter((p) => this.phys.inZoneNamed('photo', this.phys.feet(p).map((v, i) => (i === 1 ? v + 0.5 : v)) as V3)).length;
    if (!d.photo && liv.length && inPhoto === liv.length) { d.photoT += dt; if (d.photoT > 1.5) { d.photo = 1; this.emit({ e: 'photo', names: liv.map((p) => this.nameOf(p.id)) }); run.morale = Math.min(100, run.morale + 5); this.toast('Party photo! 📸', 'good'); } }
    else d.photoT = 0;
    const notes = [`summit ${d.summit.length}/${liv.length}`, d.photo ? 'photo taken' : `photo spot ${inPhoto}/${liv.length}`];
    if (st.notes.join() !== notes.join()) { st.notes = notes; this.dirty = true; }
    if (this.time * 1000 >= st.endsAt || this.stopTimer > 0) { this.stopTimer = 0; this.endStop(`You leave ${routeOf(run, this.deck).find((x) => x.id === d.node)?.name ?? 'the landmark'}.`); }
  }
  private talk(p: PlayerPhys, npc: Ent) {
    const run = this.run;
    if (!npc.npc) return;
    const def = this.deck.npcs[npc.npc.id];
    const node = run ? routeOf(run, this.deck)[Math.max(0, run.node - 1)] : null;
    const lines = [...(def?.lines ?? []), ...(node?.talk ?? [])];
    if (!lines.length) return;
    const line = fill(lines[Math.floor(this.misc.next() * lines.length)], run ?? ({} as RunState), this.deck);
    this.emit({ e: 'talk', npc: npc.npc.id, name: def?.name ?? npc.npc.name, line, to: p.id });
  }

  // ================================================================ STOP: camp / night
  private enterCamp() {
    if (this.journey) { this.enterTravel(); return; }
    const run = this.run!;
    this.state.phase = 'stop';
    const desc = this.makeLevel('camp');
    this.newWorld(desc, true);
    // body swaps / temporary ghosts / mods end at camp
    if (run.mods.some((m) => m.startsWith('swap:'))) { this.emit({ e: 'unswap' }); run.mods = run.mods.filter((m) => !m.startsWith('swap:')); this.respawnSwapped(); }
    run.mods = run.mods.filter((m) => m === 'hat_of_shame');
    for (const k of Object.keys(run.flags)) if (k.startsWith('tempGhost:')) { const id = k.slice(10); const m = run.party[id]; if (m && m.alive) m.ghost = false; delete run.flags[k]; const p = this.phys.players.get(id); if (p) { p.ghost = false; p.col.setCollisionGroups(GROUP_PLAYER); } }
    // repair with spares automatically overnight
    for (const part of [...run.broken]) if (run.items[part] > 0) { run.items[part]--; run.broken = run.broken.filter((x) => x !== part); run.limp = false; this.toast(`Fixed the ${part} overnight with a spare.`, 'good'); }
    this.syncAll();
    this.setStop({ kind: 'camp', level: 'camp', title: 'Camp', endsAt: 0, objective: { label: 'Sit by the fire (E) · vote on the night', progress: 0, goal: 0 }, ready: [], notes: [] });
    this.sendLevel('camp');
    const T = this.deck.text;
    this.openVote({ id: 'night', title: 'Night falls', text: 'What does the party do tonight?', kind: 'camp', options: [
      { id: 'rest', label: T.rest, hint: '+health' }, { id: 'watch', label: T.watch, hint: 'no thieves' }, { id: 'stories', label: T.stories, hint: '+morale' }, { id: 'trade', label: T.trade, hint: 'a random trade' },
    ] }, 20, (r) => this.resolveNight(r));
    this.afterStop = () => this.enterTravel();
  }
  private resolveNight(r: string) {
    const run = this.run!;
    let text = '';
    if (r === 'rest') { const res = applyEffects(run, this.deck, [{ k: 'rest', n: 1 }], { target: null, volunteer: null, cause: 'exhaustion' }, this.rng); this.handleDeaths(res.deaths); text = 'A good night\'s sleep. Everyone feels better.'; }
    else if (r === 'watch') { run.flags.watch = 1; text = 'You take turns on watch. Nothing gets past you.'; }
    else if (r === 'stories') { run.morale = Math.min(100, run.morale + 10); text = 'Stories by the fire. Morale is up.'; }
    else { const got = this.rng.pick([['food', 40], ['medicine', 1], ['ammo', 20], ['clothes', 1]] as const); applyEffects(run, this.deck, got[0] === 'food' ? [{ k: 'food', n: got[1] }, { k: 'money', n: -20 }] : [{ k: 'item', id: got[0], n: got[1] }, { k: 'money', n: -20 }], { target: null, volunteer: null, cause: '' }, this.rng); text = `Strangers trade you ${got[1]} ${this.itemName(got[0], got[1])} for ${this.deck.currency.sym}20.`; }
    this.syncAll();
    // night event (thieves unless watched)
    const thief = this.deck.events.find((e) => e.id === 'thief_night');
    const night = !run.flags.watch && thief && run.food > 40 && this.rng.chance(0.3);
    run.flags.watch = 0;
    this.showCard({ id: 'night', title: 'The night', text }, 5, () => {
      if (night && thief) { this.startEvent(thief); this.afterCampEvent = true; }
      else this.showCard({ id: 'morning', title: 'Morning', text: 'The sun comes up. Press Continue when everyone is ready to roll (or wait).' }, 3, () => { const st = this.state.stop; if (st) st.endsAt = Math.round((this.time + 25) * 1000); this.dirty = true; });
    });
  }
  private afterCampEvent = false;
  private stepCamp() {
    const st = this.state.stop!;
    if (st.endsAt && this.time * 1000 >= st.endsAt && !this.state.vote && !this.state.card) this.endStop('');
  }

  // ================================================================ STOP: finish / end
  private enterFinish(n: RouteNode) {
    const run = this.run!;
    this.state.phase = 'stop';
    const desc = this.makeLevel('finish');
    this.newWorld(desc, true);
    this.setStop({ kind: 'finish', level: 'finish', title: n.name, endsAt: Math.round((this.time + 25) * 1000), objective: { label: 'Cross the finish line!', progress: 0, goal: 0 }, ready: [], notes: [] });
    this.sendLevel('finish');
    this.fx('confetti', [0, 3, 6], 3);
    run.outcome = 'won';
    this.afterStop = () => this.endRun();
  }
  private stepFinish() { const st = this.state.stop!; if (this.time * 1000 >= st.endsAt) this.endStop(''); }
  private endRun() {
    const run = this.run!;
    if (run.outcome === 'playing') run.outcome = living(run).length ? 'won' : 'wiped';
    run.score = score(run, this.deck);
    this.state.phase = 'end';
    this.state.stop = null; this.state.vote = null; this.mini = null;
    this.persist.runEnd = JSON.parse(JSON.stringify(run)) as RunState;
    this.dirty = true;
    this.emit({ e: 'sound', s: run.outcome === 'won' ? 'win' : 'wipe' });
  }

  // ================================================================ health, downed, deaths, epitaphs
  private hurt(id: string, hp: number, cause: string) {
    const run = this.run;
    const m = run?.party[id];
    if (!run || !m || !m.alive || m.ghost || hp <= 0 || this.downed.has(id)) return;
    if (this.state.phase === 'lobby' || this.state.phase === 'end') return;
    m.health = Math.max(0, Math.round((m.health - hp) * 10) / 10);
    this.dirty = true;
    if (m.health > 0) return;
    const p = this.phys.players.get(id);
    if (!p || run.modifiers.includes('hardcore')) { kill(run, id, cause); this.handleDeaths([{ id, cause }]); return; }
    m.health = 1;
    p.downed = true;
    this.phys.ragdoll(p, 2);
    this.downed.set(id, { t: 45, cause, revive: 0 });
    this.toast(`${m.name} is DOWN! Drag them to the ${this.deck.text.wagon} or hold E next to them (45 s).`, 'bad');
  }
  private stepPlayersGame(dt: number) {
    const run = this.run;
    for (const p of this.phys.players.values()) {
      const pressed = p.input.buttons & ~p.gamePrev;
      p.gamePrev = p.input.buttons;
      if (!run) { if (pressed & BTN.use) this.useLobby(p); continue; }
      // interact (E): talk / sit / stand
      if ((pressed & BTN.use) && !p.downed && p.ragdoll <= 0) this.use(p);
    }
    if (!run) return;
    // downed: revive by the wagon's revive zone or a friend holding E next to them
    for (const [id, d] of [...this.downed]) {
      const p = this.phys.players.get(id);
      if (!p) { this.downed.delete(id); continue; }
      d.t -= dt;
      const f = this.phys.feet(p);
      let rev = this.phys.inRevive(f) ? dt * 2 : 0;
      for (const o of this.phys.players.values()) {
        if (o === p || o.downed || o.ghost || !(o.input.buttons & BTN.use)) continue;
        if (Math.hypot(this.phys.feet(o)[0] - f[0], this.phys.feet(o)[2] - f[2]) < 1.8) rev += dt * (run.party[o.id]?.role === 'medic' ? 2 : 1);
      }
      d.revive += rev;
      if (d.revive >= 3) {
        this.downed.delete(id); p.downed = false; p.ragdoll = 0.5;
        const m = run.party[id]; if (m) m.health = 25;
        for (const o of this.phys.players.values()) if (o !== p && (o.input.buttons & BTN.use)) { const om = run.party[o.id]; if (om) om.stats.revives++; }
        this.toast(`${this.nameOf(id)} is back up!`, 'good'); this.fx('sparkle', f); this.dirty = true;
      } else if (d.t <= 0 || (this.state.phase !== 'stop' && this.level.kind !== 'road' && this.level.kind !== 'journey')) {
        this.downed.delete(id); p.downed = false;
        this.handleDeaths([{ id, cause: d.cause === 'drowning' ? d.cause : d.cause || 'being left behind' }], true);
      }
    }
  }
  private useLobby(p: PlayerPhys) { if (p.seat >= 0) this.phys.unseat(p); else if (this.phys.nearWagon(this.phys.feet(p), 3.2)) this.phys.sit(p, this.phys.freeSeat(p)); }
  private use(p: PlayerPhys) {
    const f = this.phys.feet(p);
    // an NPC within reach → talk
    for (const e of this.phys.ents.values()) {
      if (e.info.kind !== 'npc' || !e.body) continue;
      const ep = this.phys.pos(e.body);
      if (Math.hypot(ep[0] - f[0], ep[2] - f[2]) < 2.6) { this.talk(p, e); return; }
    }
    // camp logs
    if (this.level.kind === 'camp' && p.seat < 0) {
      let best = -1, bd = 1.8;
      this.level.seats.forEach((s, i) => { const d = Math.hypot(s.p[0] - f[0], s.p[2] - f[2]); if (d < bd && ![...this.phys.players.values()].some((o) => o.seat === 100 + i)) { bd = d; best = i; } });
      if (best >= 0) { this.sitCamp(p, best); return; }
    }
    if (p.mount) { this.phys.dismount(p); return; }
    if (p.seat >= 0) { this.phys.unseat(p); return; }
    if (this.run && this.tryMount(p)) return;
    if (this.journey && this.level.kind === 'journey' && this.state.phase === 'travel' && this.nearBench(f)) { this.takeWheel(p); return; }
    if (this.phys.nearWagon(f, 3.2) && (this.state.phase === 'travel' || this.state.phase === 'lobby' || this.state.stop?.kind === 'river')) this.phys.sit(p, this.phys.freeSeat(p));
  }
  private sitCamp(p: PlayerPhys, i: number) {
    const s = this.level.seats[i];
    p.seat = 100 + i;
    p.body.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
    p.body.setTranslation({ x: s.p[0], y: s.p[1] + p.st.height / 2, z: s.p[2] }, true);
    p.body.setRotation({ x: 0, y: Math.sin(s.yaw / 2), z: 0, w: Math.cos(s.yaw / 2) }, true);
  }
  private handleDeaths(list: { id: string; cause: string }[], killNow = false) {
    const run = this.run;
    if (!run) return;
    for (const d of list) {
      if (killNow) kill(run, d.id, d.cause);
      const m = run.party[d.id];
      if (!m) continue;
      const cause = m.diedOf ?? d.cause;
      this.emit({ e: 'death', id: d.id, name: m.name, cause });
      this.showCard({ id: `death_${d.id}_${this.tick}`, title: fill(this.deck.text.death, run, this.deck, { extra: { name: m.name, cause } }), text: 'Write your epitaph (you have 30 seconds)…', big: true, death: { name: m.name, cause } }, 6);
      this.state.epitaphs[d.id] = Math.round((this.time + 32) * 1000);
      const p = this.phys.players.get(d.id);
      if (p) { p.downed = false; this.makeGhost(p); }
      this.persist.graves.push(run.graves[run.graves.length - 1]);
      this.dirty = true;
    }
    if (run.outcome === 'wiped' && this.state.phase !== 'end') this.showCard({ id: 'wipe', title: this.deck.text.wipe, text: 'The graveyard grows.', big: true }, 5, () => this.endRun());
  }
  private setEpitaph(id: string, text: string) {
    const run = this.run;
    if (!run || !(id in this.state.epitaphs)) return;
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
    this.applyEpitaph(id, clean || this.rng.pick(this.deck.epitaphs));
  }
  private applyEpitaph(id: string, text: string) {
    const run = this.run!;
    const m = run.party[id];
    delete this.state.epitaphs[id];
    if (!m) return;
    m.epitaph = text;
    const g = [...run.graves].reverse().find((x) => x.name === m.name && !x.epitaph);
    if (g) g.epitaph = text;
    const pg = [...this.persist.graves].reverse().find((x) => x.name === m.name);
    if (pg) pg.epitaph = text;
    this.toast(`Here lies ${m.name}: "${text}"`, 'meme');
    this.dirty = true;
  }
  private stepEpitaphs() {
    for (const [id, until] of Object.entries(this.state.epitaphs)) if (this.time * 1000 >= until) this.applyEpitaph(id, this.rng.pick(this.deck.epitaphs));
  }

  // ================================================================ phase dispatch
  /** KILL_ zones (and falling far out of the world): people come back at the wagon a bit bruised, things are lost. */
  private stepFalls() {
    const kills = this.level.zones.filter((z) => z.name === 'kill');
    const river = this.state.stop?.kind === 'river';
    for (const e of [...this.phys.ents.values()]) {
      if (!e.body || e.stowed || e.hitched !== undefined || e.info.kind === 'wagon' || e.info.kind === 'platform' || e.info.kind === 'npc') continue;
      const p = this.phys.pos(e.body);
      const fell = p[1] < (this.level.kind === 'journey' ? -20 : -30) || (!river && kills.some((z) => inZone({ ...z, he: [z.he[0], Math.max(z.he[1], 2), z.he[2]] }, p[0], p[1], p[2])));
      if (!fell) continue;
      if (e.info.kind === 'player') {
        const pl = this.phys.playerOfEnt(e.id);
        if (!pl) continue;
        // back on solid ground: the level's spawn points (next to the wagon can be over the edge on floating islands)
        const sp = this.level.spawns.length ? this.level.spawns[this.state.players.findIndex((x) => x.id === pl.id) % this.level.spawns.length] : null;
        if (sp && this.state.phase === 'stop') {
          if (pl.seat >= 0) this.phys.unseat(pl, false);
          pl.body.setTranslation({ x: sp.p[0], y: sp.p[1] + pl.st.height / 2 + 0.4, z: sp.p[2] }, true);
          pl.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        } else this.respawnNearWagon(pl);
        // whatever knocked them off loses interest for a while (no knock-off loops at the spawn)
        for (const x of this.phys.ents.values()) if (x.animal && x.animal.target === pl.id && x.animal.state === 'attack') { x.animal.state = 'wander'; x.animal.target = undefined; x.animal.atkCd = 8; x.animal.t = 6; }
        const hpNow = this.run?.party[pl.id]?.health ?? 0;
        if (!pl.ghost) { this.hurt(pl.id, Math.min(8, Math.max(0, hpNow - 10)), 'falling off the world'); this.toast(`${this.nameOf(pl.id)} fell off the world and limped back to the ${this.deck.text.wagon}.`, 'bad'); }
      } else if (e.animal && e.animal.state !== 'dead') {
        e.body.setTranslation({ x: e.animal.home[0], y: e.animal.home[1] + 1, z: e.animal.home[2] }, true);
        e.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      } else {
        this.phys.remove(e, 'fell');
        if (e.owned || e.item === 'meat') this.toast(`${e.item === 'meat' ? 'Some meat' : `A ${this.itemName(e.item ?? 'thing', 1)}`} fell off the world.`, 'bad');
      }
    }
  }

  private stepPhase(dt: number) {
    if (this.tick % 10 === 0 && this.time - this.worldAt > 1.5) this.stepFalls();
    if (this.stopData.raft) this.raftBuoyancy();
    if (this.state.phase === 'travel') { this.stepTravel(dt); return; }
    if (this.state.phase !== 'stop' || !this.state.stop) return;
    if (this.mini) { this.stepTravel(dt); if (this.mini) this.stepMini(dt); return; }
    if (this.camp && this.journey && this.level.kind === 'journey') this.stepJourney(dt);
    switch (this.state.stop.kind) {
      case 'store': this.stepStore(); break;
      case 'river': this.stepRiver(dt); break;
      case 'hunt': this.stepHunt(); break;
      case 'landmark': this.stepLandmark(dt); break;
      case 'camp': if (this.camp) this.stepCamp2(dt); else this.stepCamp(); break;
      case 'finish': this.stepFinish(); break;
    }
  }

  // ================================================================ misc
  private nameOf(id: string) { return this.state.players.find((p) => p.id === id)?.name ?? this.run?.party[id]?.name ?? 'someone'; }
  private respawnNearWagon(p: PlayerPhys) {
    const w = this.phys.wagon?.body;
    if (p.seat >= 0) this.phys.unseat(p, false);
    if (p.ragdoll > 0) { p.ragdoll = 0.01; }
    const wp = w ? this.phys.pos(w) : [0, 0, 0] as V3;
    const at: V3 = this.journey && this.level.kind === 'journey' ? this.journey.frame(2.8, -1.5, 0) : [wp[0] + 2.2, wp[1], wp[2]];
    p.body.setTranslation({ x: at[0], y: at[1] + p.st.height / 2 + 0.3, z: at[2] }, true);
    p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    if (this.state.phase === 'travel' && w) { const s = this.phys.freeSeat(p); if (s >= 0) this.phys.sit(p, s); }
  }
  private respawnSwapped() {
    for (const info of this.state.players) {
      const old = this.phys.players.get(info.id);
      if (!old) continue;
      const pos = this.phys.pos(old.body);
      const yaw = old.input.yaw;
      const seat = old.seat;
      this.phys.removePlayer(info.id);
      const p = this.phys.addPlayer(info.id, this.heightOf(info.id), [pos[0], pos[1] - old.st.height / 2, pos[2]], yaw);
      if (this.run?.party[info.id]?.ghost) this.makeGhost(p);
      if (seat >= 0 && seat < 100) this.phys.sit(p, this.phys.freeSeat(p));
      this.applyMods(p);
    }
  }

  // ================================================================ bots (tests / filling a party)
  /** A level wall between two floor points (chest height)? */
  private blocked(a: V3, b: V3): boolean {
    const dx = b[0] - a[0], dz = b[2] - a[2], len = Math.hypot(dx, dz);
    if (len < 0.3) return false;
    const R = this.R;
    const hit = this.phys.world.castRay(new R.Ray({ x: a[0], y: a[1] + 0.9, z: a[2] }, { x: dx / len, y: 0, z: dz / len }), len - 0.3, true, undefined, undefined, undefined, undefined, (c) => !c.isSensor() && !this.phys.entOfCollider(c));
    return !!hit;
  }
  private driveBots(dt: number) {
    if (!this.bots.size) return;
    for (const [id, b] of this.bots) {
      const p = this.phys.players.get(id);
      b.t += dt;
      const key = `${this.state.phase}:${this.state.stop?.kind ?? ""}:${this.levelSeq}`;
      if (b.key !== key) { b.key = key; b.t = 0; b.target = 0; b.talk = 0; }
      // votes
      const v = this.state.vote;
      if (v && !v.votes[id] && this.time > b.voteAt) {
        let opt = v.options.find((o) => !o.disabled)?.id ?? v.options[0].id;
        if (v.id.startsWith('ev_') && this.pendingEv && this.run) opt = botChoice(this.run, this.deck, this.pendingEv.e, this.misc);
        if (v.kind === 'river') opt = this.botRiver && v.options.some((o) => o.id === this.botRiver && !o.disabled) ? this.botRiver : v.options.find((o) => o.id === 'ferry' && !o.disabled) ? 'ferry' : 'ford';
        if (v.id === 'store_leave') opt = 'leave';
        if (v.kind === 'consent') opt = 'agree';
        this.castVote(id, opt);
      }
      if (!p) continue;
      const inp: InputFrame = { ...emptyInput(), seq: (p.lastSeq + 1) & 0xffff, yaw: p.input.yaw, pitch: 0 };
      const st = this.state.stop;
      let detour = false;
      const goTo = (t: V3, near = 1, sprint = false) => {
        const f = this.phys.feet(p);
        const d = Math.hypot(t[0] - f[0], t[2] - f[2]);
        // walls in the way: go via the level's walk graph (door → aisles)
        let goal = t;
        detour = false;
        const nav = this.level.paths.nav;
        if (nav?.length && d > near && this.blocked(f, t)) {
          let best: V3 | null = null, bs = 1e9;
          for (const n of nav) { if (Math.hypot(n[0] - f[0], n[2] - f[2]) < 0.6 || this.blocked(f, n)) continue; const s = Math.hypot(n[0] - f[0], n[2] - f[2]) + Math.hypot(t[0] - n[0], t[2] - n[2]) * 1.2 + (this.blocked(n, t) ? 6 : 0); if (s < bs) { bs = s; best = n; } }
          if (best) { goal = best; detour = true; }
        }
        const dx = goal[0] - f[0], dz = goal[2] - f[2];
        inp.yaw = Math.atan2(-dx, -dz);
        if (d > near) {
          inp.mz = 1; if (sprint) inp.buttons |= BTN.sprint;
          // walking into a tree / rock (no nav graph out on the journey): sidestep for a moment
          const moved = b.last ? Math.hypot(f[0] - b.last[0], f[2] - b.last[2]) : 1;
          b.still = moved < 0.02 ? (b.still ?? 0) + dt : 0;
          if ((b.still ?? 0) > 0.8) { b.dodge = 1.1; b.dodgeDir = this.misc.chance(0.5) ? 1 : -1; b.still = 0; }
          if ((b.dodge ?? 0) > 0) { b.dodge! -= dt; inp.mx = b.dodgeDir ?? 1; inp.mz = 0.3; }
        }
        b.last = f;
        return d;
      };
      const aimAt = (t: V3) => { const e = this.phys.eye(p); const dx = t[0] - e[0], dy = t[1] - e[1], dz = t[2] - e[2]; if (!detour) inp.yaw = Math.atan2(-dx, -dz); inp.pitch = Math.atan2(dy, Math.hypot(dx, dz)); };
      const w = this.phys.wagon?.body;
      const wp = w ? this.phys.pos(w) : [0, 0, 0] as V3;
      if (this.state.phase === 'travel' && !st) {
        const drv = this.botDrive && this.journey && this.level.kind === 'journey' && [...this.bots.keys()][0] === id;
        const J = this.journey && this.level.kind === 'journey' ? this.journey : null;
        if (J?.st.bogged && !drv) {
          // stuck in the mud: everyone off and push from behind
          if (p.seat >= 0) this.phys.unseat(p);
          const k = this.state.players.findIndex((x) => x.id === id);
          const d = goTo(J.frame((k % 3 - 1) * 0.9, -3.3), 0.4);
          if (d < 0.7) { inp.yaw = J.yaw + Math.PI; inp.mz = 1; }
          this.phys.setInput(id, inp, this.time * 1000);
          continue;
        }
        if (p.seat < 0 && w) { if (goTo(wp, 2.5, true) < 2.6) { if (drv) this.takeWheel(p); else this.phys.sit(p, this.phys.freeSeat(p)); } }
        else if (drv && p.seat >= 0 && p.seat !== this.phys.driverSeat) this.takeWheel(p);
        if (drv && p.seat === this.phys.driverSeat && this.journey) { const c = this.journey.autoDrive(1); inp.mz = c.throttle; inp.mx = c.steer; if (c.brake) inp.buttons |= BTN.jump; }
      }
      if (st?.kind === 'store' && this.run && !b.task) {
        b.task = 'shop'; b.t = 0;
        if ([...this.bots.keys()][0] === id) {
          // the first bot orders a sensible list from the catalogue (drops on the porch; draft animals come hitched)
          const run = this.run;
          let money = run.money;
          for (const { item, n } of shoppingList(run, this.deck)) {
            const price = priceOf(run, this.deck, item);
            const k = Math.min(n, Math.floor(money / price), 8);
            if (k > 0) { this.catalogueBuy(id, item, k); money -= k * price; }
          }
        }
      }
      if (st?.kind !== 'store' && b.task === 'shop') b.task = '';
      if (st?.kind === 'store' && b.t > 150 && !st.ready.includes(id)) this.markReady(id, true);   // loading takes a while (nothing left → ready sooner, below)
      if (this.state.phase === 'lobby' || this.state.phase === 'end') { /* idle */ }
      else if (st?.kind === 'store' || st?.kind === 'hunt') {
        // fetch loop: grab something worth having, bring it to the wagon
        const carrying = p.grab ? this.phys.ents.get(p.grab.ent) : null;
        if (carrying?.body && w) {
          // walk up beside the wagon, hold the thing over the bed, let go once it's inside
          const wq = w.rotation();
          const inv = { x: -wq.x, y: -wq.y, z: -wq.z, w: wq.w };
          const f = this.phys.feet(p);
          const lp = rotV([f[0] - wp[0], 0, f[2] - wp[2]], inv);
          const cz = this.wagonSpec.cargo;
          const side = lp[0] >= 0 ? 1 : -1;   // over the side rim (a closed tub has no tailgate)
          const standL: V3 = [cz.p[0] + side * (cz.he[0] + 0.45 + p.st.radius), 0, clamp(lp[2], cz.p[2] - cz.he[2] * 0.3, cz.p[2] + cz.he[2] * 0.3)];
          const so = rotV(standL, wq), bo = rotV([cz.p[0] + side * 0.1, cz.p[1] - cz.he[1] + 1.15, clamp(lp[2], cz.p[2] - cz.he[2] * 0.3, cz.p[2] + cz.he[2] * 0.3)], wq);
          const stand: V3 = [wp[0] + so[0], 0, wp[2] + so[2]], bed: V3 = [wp[0] + bo[0], wp[1] + bo[1], wp[2] + bo[2]];
          const d = goTo(stand, 0.45);
          inp.buttons |= BTN.grab;
          inp.hold = 1.1;
          if (d < 1.2) { aimAt(bed); const e = this.phys.eye(p); inp.hold = clamp(Math.hypot(bed[0] - e[0], bed[1] - e[1], bed[2] - e[2]), 0.7, 2.5); }
          b.talk += dt;
          // stuck against the rim for a while: yeet it in (REPO style)
          if (b.talk > 4 && d < 1.4) { inp.pitch = Math.max(inp.pitch, 0.45); if ((this.tick % 40) < 2) inp.buttons |= BTN.throw; }
          const loaded = this.phys.inCargo(this.phys.pos(carrying.body));
          if (DEBUG_BOTS && (loaded || b.talk > 14)) console.error(`[bot ${id}] ${loaded ? 'loaded' : 'gave up on'} ${carrying.item ?? carrying.info.sub}#${carrying.id} t=${b.t.toFixed(1)}`);
          if (!loaded && b.talk > 14) (b.skip ??= new Set()).add(carrying.id);
          if (loaded || b.talk > 14) { inp.buttons &= ~BTN.grab; b.target = 0; b.talk = 0; }
        } else {
          let tgt = b.target ? this.phys.ents.get(b.target) : null;
          if (!tgt?.body || tgt.gone || (st.kind === 'store' && (this.phys.inCargo(this.phys.pos(tgt.body)) || tgt.stowed)) || (st.kind === 'hunt' && tgt.animal?.state !== 'dead' && tgt.animal?.state !== undefined && false)) tgt = null;
          if (!tgt) {
            const f = this.phys.feet(p);
            if (b.t < 0.1) b.skip = new Set();
            const cands = [...this.phys.ents.values()].filter((e) => e.body && !e.gone && !e.stowed && !b.skip?.has(e.id) && (st.kind === 'store' ? e.info.kind === 'prop' && !e.owned && e.item !== 'draft' && (e.info.mass ?? 10) <= p.st.lift && !this.phys.inCargo(this.phys.pos(e.body)) && e.price <= (this.run?.money ?? 0) : e.animal?.state === 'dead' && !this.phys.inCargo(this.phys.pos(e.body)) && (e.info.mass ?? 10) <= p.st.lift * 1.6));
            // food first (then ammo, then the rest), nearest first within a class — a party that shops hoodies starves
            const pri = (e: Ent) => (st.kind !== 'store' ? 0 : e.item === 'food' ? 0 : e.item === 'ammo' ? 0.5 : 2) * 25;
            const dist = (e: Ent) => { const q = this.phys.pos(e.body!); return Math.hypot(q[0] - f[0], q[2] - f[2]) + (w ? 0.6 * Math.hypot(q[0] - wp[0], q[2] - wp[2]) : 0); };
            cands.sort((a, c) => pri(a) + dist(a) - pri(c) - dist(c));
            tgt = cands[0] ?? null;
            b.target = tgt?.id ?? 0;
            b.chase = 0;
          }
          // can't reach it (behind a counter, wedged on a shelf): give up on that one after a while
          b.chase = (b.chase ?? 0) + dt;
          if (tgt && b.chase > 9) { if (DEBUG_BOTS) console.error(`[bot ${id}] can't reach ${tgt.item ?? tgt.info.sub}#${tgt.id}`); (b.skip ??= new Set()).add(tgt.id); b.target = 0; tgt = null; }
          if (tgt?.body && st.kind === 'hunt' && !this.phys.groundAlong(this.phys.feet(p), this.phys.pos(tgt.body))) { (b.skip ??= new Set()).add(tgt.id); b.target = 0; tgt = null; }
          if (tgt?.body) {
            const tp = this.phys.pos(tgt.body);
            const d = goTo(tp, 0.7);
            aimAt(tp);
            if (d < 1.6) { inp.buttons |= BTN.grab; p.grabWant = tgt.id; }
          } else if (st.kind === 'hunt') {
            // hunt: go after the nearest live animal and shoot it
            const f = this.phys.feet(p);
            const live = [...this.phys.ents.values()].filter((e) => e.animal && e.animal.state !== 'dead' && e.body && e.animal.danger < 0.5).sort((a, c) => Math.hypot(this.phys.pos(a.body!)[0] - f[0], this.phys.pos(a.body!)[2] - f[2]) - Math.hypot(this.phys.pos(c.body!)[0] - f[0], this.phys.pos(c.body!)[2] - f[2]))[0];
            if (live?.body) {
              const lp = this.phys.pos(live.body);
              // only walk over solid ground (floating islands); else shoot from here
              const d = this.phys.groundAlong(f, lp) ? goTo(lp, 12) : Math.hypot(lp[0] - f[0], lp[2] - f[2]);
              aimAt(lp); if (d < 28 && this.misc.chance(0.2)) inp.buttons |= BTN.fire;
            }
          } else if (st.kind === 'store' && b.t > 20 && !st.ready.includes(id)) this.markReady(id, true);
        }
      } else if (st?.kind === 'river') {
        const d = this.stopData as { mode: string };
        if (d.mode === 'ford') { const fz = this.phys.zone('farbank'); goTo(fz ? [fz.p[0] + (p.st.cls === 'micro' ? -6 : 0), 0, fz.p[2]] : [0, 0, 16], 1.5); }
        else if (d.mode === 'caulk') inp.buttons |= BTN.use;
      } else if (st?.kind === 'landmark') {
        const z = this.phys.zone('photo');
        if (z) goTo(z.p, 1.2);
        if (b.t > 8 && !st.ready.includes(id)) this.markReady(id, true);
      } else if (st?.kind === 'camp' && this.camp) {
        // v2 camp: carry something useful, else work a hold task in the rhythm
        const idx = this.state.players.findIndex((x) => x.id === id);
        const carrying = p.grab ? this.phys.ents.get(p.grab.ent) : null;
        const goal = carrying ? this.camp.target(carrying) : null;
        if (carrying?.body && goal) { inp.buttons |= BTN.grab; inp.hold = 1; if (goTo(goal, 0.9) < 1.3) inp.buttons &= ~BTN.grab; }
        else if (idx % 2 === 0 && !this.camp.state.night) {
          const f = this.phys.feet(p);
          const e = this.camp.carryables().filter((x) => this.camp!.target(x) && (x.info.mass ?? 10) <= p.st.lift).sort((a, c) => Math.hypot(this.phys.pos(a.body!)[0] - f[0], this.phys.pos(a.body!)[2] - f[2]) - Math.hypot(this.phys.pos(c.body!)[0] - f[0], this.phys.pos(c.body!)[2] - f[2]))[0];
          if (e?.body) { const tp = this.phys.pos(e.body); const d = goTo(tp, 0.7); aimAt(tp); if (d < 1.6) { inp.buttons |= BTN.grab; p.grabWant = e.id; } }
          else { const plan = this.camp.botPlan(p, idx); if (plan) { goTo(plan.to, 0.8); if (plan.hold) inp.buttons |= BTN.use; } }
        } else { const plan = this.camp.botPlan(p, idx); if (plan) { goTo(plan.to, 0.8); if (plan.hold) inp.buttons |= BTN.use; } }
        if (b.t > 75 && !st.ready.includes(id)) this.markReady(id, true);
      } else if (st?.kind === 'camp') {
        if (p.seat < 0 && this.level.seats.length) { const s = this.level.seats[this.state.players.findIndex((x) => x.id === id) % this.level.seats.length]; if (goTo(s.p, 1.2) < 1.4) inp.buttons |= (this.tick % 20 < 10 ? BTN.use : 0); }
      } else if (st?.kind === 'finish') { const z = this.phys.zone('finish'); if (z) goTo(z.p, 0.8, true); }
      else if (st?.kind === 'event' && this.mini) {
        const m = this.mini;
        if (m.goalZone) goTo(m.goalZone.p, 0.8, true);
        if (m.kind === 'wheel' && w) {
          const corner = rotV(this.wagonSpec.slotWheel, w.rotation());
          const cp: V3 = [wp[0] + corner[0], wp[1] + 0.9, wp[2] + corner[2]];
          const idx = this.state.players.findIndex((x) => x.id === id);
          if (idx % 2 === 0) { goTo([cp[0] - 1.2, 0, cp[2]], 0.5); aimAt([cp[0], cp[1], cp[2]]); inp.buttons |= BTN.grab; inp.pitch = Math.max(inp.pitch, 0.35); }
          else {
            const spare = [...this.phys.ents.values()].find((e) => e.item === 'wheel' && e.body && !e.gone);
            if (spare?.body && (!p.grab || p.grab.ent === spare.id)) {
              const sp = this.phys.pos(spare.body);
              if (p.grab) { goTo([cp[0] - 1.4, 0, cp[2] + 0.6], 0.6); aimAt([cp[0], 0.6, cp[2]]); inp.buttons |= BTN.grab; if (Math.hypot(sp[0] - cp[0], sp[2] - cp[2]) < 0.9) inp.buttons &= ~BTN.grab; }
              else { const d = goTo(sp, 1); aimAt(sp); if (d < 1.6) inp.buttons |= BTN.grab; }
            } else { goTo([cp[0] - 1, 0, cp[2] + 1], 0.6); inp.buttons |= BTN.use; }
          }
        }
        if (m.kind === 'mud' && w) { const J = this.journey && this.level.kind === 'journey' ? this.journey : null; const d = goTo(J ? J.frame((this.state.players.findIndex((x) => x.id === id) % 3 - 1) * 0.8, -3.2) : [wp[0], 0, wp[2] - 2.6], 0.4); if (d < 0.6) { inp.yaw = J ? J.yaw + Math.PI : Math.PI; inp.mz = 1; } }
        if (m.kind === 'search' && m.goalZone) { const d = goTo(m.goalZone.p, 1.5, true); if (d < 2) inp.buttons |= BTN.use; }
        if (m.kind === 'trail3d:pothole' && w) { if (p.seat < 0) { const d = goTo(wp, 2, true); if (d < 2.8) this.phys.sit(p, this.phys.freeSeat(p)); } }
        if (m.kind === 'chase') {
          const ids = String(m.data.thieves ?? '').split(',').map(Number);
          const th = ids.map((i) => this.phys.ents.get(i)).find((e) => e?.body);
          if (th?.body) { const tp = this.phys.pos(th.body); const d = goTo(tp, 0.5, true); aimAt(tp); if (d < 1.8) inp.buttons |= BTN.grab; }
        }
        if (m.kind.startsWith('voice')) this.voice[id] = { vad: 0.8, expr: 0.3 + this.misc.next() * 0.4 };
      }
      if (st?.kind === 'hunt' && this.misc.chance(0.002)) inp.buttons |= BTN.jump;
      this.phys.setInput(id, inp, this.time * 1000);
    }
  }
}

const ITEM_PROP_INV: Record<string, string> = Object.fromEntries(Object.entries(ITEM_PROP).map(([k, v]) => [v, k]));
function hashStr(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h >>> 0; }
void clamp; void milesPerDay; void revive; void everyone; void buyList;

/** A theme-pack level (from its GLB) adapted to this run: the river bed deepened / raised to today's depth. */
function adaptLevel(d: LevelDesc, kind: string, run: RunState | null): LevelDesc {
  if (kind === 'river' && run?.river && d.water[0]) {
    const w = d.water[0];
    const want = Math.max(0.3, run.river.depth * 0.3048), k = want / Math.max(0.1, w.depth);
    for (const c of d.cols) if (c.shape === 'trimesh' && c.verts && /riverbed/i.test(c.name ?? '')) for (let i = 1; i < c.verts.length; i += 3) if (c.verts[i] < w.level) c.verts[i] = w.level - (w.level - c.verts[i]) * k;
    w.depth = want; w.p = [w.p[0], w.level - want / 2, w.p[2]]; w.he = [w.he[0], want / 2 + 0.02, w.he[2]];
    if (run.river.swift) w.flow = [w.flow[0] * 1.3, w.flow[1] * 1.3];
    const ford = d.paths.ford;
    if (ford) for (const pt of ford) if (pt[1] < w.level) pt[1] = w.level - (w.level - pt[1]) * k;
  }
  return d;
}
