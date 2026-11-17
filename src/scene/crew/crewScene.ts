// The deck crew of a walking ship (docs/SCENES.md -> "Ship crew"): rooms whose scene.json has a `crew` key.
// Nine Muppet-style crew (a builtin puppet avatar turned into an NPC unit: tools/npc_crew/*) run the walking ship:
// the Cap'n at the helm (the wheel turns with the voyage), two gunners riding the turrets, two loaders feeding them,
// a stoker, a lookout and two deckhands who swab in cruise and run to every hull hit with a hammer or a torch.
// Treasure stops send a shore party over the rail onto the sand, dig up the loot, carry / hoist / throw it aboard and
// climb back up the rope ladder.
//
// Driven by:
//   * the VOYAGE engine (src/scene/voyage, another lane) through setFeed(): battles (alert, shots, hull hits, outcome),
//     treasure stops, the turret yaw / pitch, the ship's yaw rate (helm), deck tilt + acceleration (upright lean, brace);
//   * test pages: vtpOut.crew.test('battle' | 'treasure' | 'flee', inSec) / ?crew=battle@3,treasure@40.
// Everything is planned once per episode and sampled at wall-clock time (crewPlan.ts): every page shows the same crew.
// Never in front of the show: a crew member (or a bubble) whose body, puppet head or hat would cover a performer's face
// or the React screen fades out (checked every frame; one standing between the lens and a face is hidden at once), and
// nobody walks the show floor (CREW_KEEPOUT). The deck is fitted to the room's own meshes at attach (crewDeck.snapDeck:
// feet on the real floor, bodies out of rails and bulwarks). Cost: rooms without `crew` -> one check / frame.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { sceneFileUrl } from '../SceneRuntime.ts';
import { gfxBudget } from '../../stage/gfx/lod.ts';
import { sanitizeCrewConfig, sanitizeCrewEpisode, type CrewEpisodeIn, type CrewStopIn, type RoomCrewConfig, type CrewBattleIn } from '../../../shared/shipCrew.ts';
import { PRESET_GROUND, SAND_BAND, boundsBox, deckFromRoom, floorUnder, presetDeck, sandLift, snapDeckSteps, type CrewDeck, type SnapReport } from './crewDeck.ts';
import {
  activeEpisode, crewCount, crewStopDuration, cruiseLoop, cruiseTime, framesFor, gunFrame, hash32, inputsKey, planEpisodes, repairProgress, roleOf, stateHash,
  type CrewEpisode, type CruiseLoop, type PlanCtx, type ItemTrack,
} from './crewPlan.ts';
import { sampleTrack, TB, type FrameFn, type Sample } from './crewTrack.ts';
import { RoomDeckProbe, bvhSteps, probeMeshes } from './crewProbe.ts';
import { patchEnvMaterial } from '../environment/materials.ts';
import { crewScreenRect, guardVerdict, type Rect } from './crewGuard.ts';
import { CrewAssets, CrewNpc, type Layer, type CrewClip } from './crewUnits.ts';
import { CrewFx, type Burst } from './crewFx.ts';
import { clipMeta } from './crewClips.ts';

/** What the voyage engine tells the crew. Every function must be a pure function of wall-clock ms (every page agrees). */
export interface CrewFeed {
  /** Battles / treasure stops overlapping [fromMs, toMs] (the crew asks for [now - 20 min, now + 2 min]). */
  episodes(fromMs: number, toMs: number): CrewEpisodeIn[];
  /** The BARREL's room-space yaw (rad, 0 = +Z) of turret `gun` ('F' = TURRET_1, 'A' = TURRET_2) at wall ms: the
   *  combat engine's closed form. Give it whenever the voyage turns the turrets: the gunner and loader plans ride it.
   *  Without it the plans assume the rest yaw and seated crew follow the turret node's live yaw. */
  gunYaw?(gun: string, ms: number): number;
  /** Barrel pitch (rad, + = up): the gunner's crank pose. */
  gunPitch?(gun: string, ms: number): number;
  /** The ship's heading rate (rad/s, + = turning left): the helm wheel leads it by 0.4 s. */
  yawRate?(ms: number): number;
  /** |deck acceleration| (m/s^2): above 2.5 the crew braces. */
  accel?(ms: number): number;
  /** Deck tilt against the world (rad): the crew leans 70 % back to world-upright. */
  tilt?(ms: number): { pitch: number; roll: number };
  /** The sand's height (room space, the crew's frame) under room-space (x, z) at wall ms: SPEC C5 groundAt mapped into
   *  the halted ship's frame. Give it whenever a treasure stop is on: the shore party's feet, the loot, the dust and
   *  the rope feet follow it (+-2 cm, SPEC 4.4); without it they stay on the flat stop plane. Presentation only: the
   *  plans, stopDuration and the sync hash keep the flat plane (every page agrees regardless). */
  groundAt?(x: number, z: number, ms: number): number;
}

/** vtpOut.crew.test() options (test pages) */
export interface TestOpts { alert?: number; end?: number; bearing?: number; shots?: CrewBattleIn['shots']; hits?: CrewBattleIn['hits']; haul?: CrewStopIn['haul']; loot?: CrewStopIn['loot']; groundY?: number }

export interface CrewEvent { kind: 'hammer' | 'weld' | 'ram' | 'toss' | 'land' | 'catch' | 'shout'; crew: number; pos: THREE.Vector3; at: number }

const DEFAULT_HUES = [0, -95, 55, -150, 120, 180, -45, 90, -120];
/** stopDuration before the room's deck is known: above any stop the planner makes on the SPEC ship (~85-112 s), so a
 *  voyage that asks too early only waits longer (it should ask again once info().ready) */
const STOP_BOUND = 150;
const HATS: Record<string, string | null> = { captain: 'hat_captain', gunner_f: 'hat_beanie', gunner_a: 'hat_beanie', loader_f: 'hat_sailor', loader_a: 'hat_sailor', stoker: 'hat_beanie', lookout: 'hat_sailor', deckhand: null };
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();
const UPQ = new THREE.Quaternion(), TQ = new THREE.Quaternion(), EU = new THREE.Euler();

interface Member { npc: CrewNpc; i: number; role: string; fade: number; protect: number; s: Sample | null; hat: string | null; px: number; lastEv: Map<string, number>; foot?: { kx: number; ky: number; kz: number; y: number }; sand?: number }

/** scene.json hideNodes (names the room never draws) */
const hideList = (rt: SceneRuntime): string[] => { const h = (rt.info as unknown as { hideNodes?: unknown }).hideNodes; return Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string') : []; };

/** Resolve on the next task (MessageChannel: unlike timers, not throttled to 1 Hz in a hidden tab / OBS source). */
const taskQ: (() => void)[] = [];
let taskCh: MessageChannel | null = null;
function nextTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  if (!taskCh) { taskCh = new MessageChannel(); taskCh.port1.onmessage = () => { taskQ.shift()?.(); }; }
  return new Promise((r) => { taskQ.push(r); taskCh!.port2.postMessage(0); });
}

/** finite number from a feed call (a throwing / NaN feed never stops the frame) */
function safeNum(f: (() => number | undefined) | null | undefined): number | undefined {
  if (!f) return undefined;
  try { const v = f(); return typeof v === 'number' && Number.isFinite(v) ? v : undefined; } catch { return undefined; }
}


export class CrewScene {
  private rt: SceneRuntime | null = null;
  private cfg: RoomCrewConfig = {};
  private deck: CrewDeck | null = null;
  private group = new THREE.Group();
  private assets: CrewAssets | null = null;
  private crew: Member[] = [];
  private fx: CrewFx | null = null;
  private cruise: CruiseLoop[] = [];
  private ctx: PlanCtx | null = null;
  private cache = new Map<string, CrewEpisode>();
  private eps: CrewEpisode[] = [];
  private epsKey = '';
  private tests: CrewEpisodeIn[] = [];
  private feed: CrewFeed | null = null;
  /** the gen a load is in flight for (-1 = none): a re-attach while loading starts its own load */
  private loadingGen = -1;
  private error = '';
  private frame = 0;
  private assetKey = '';
  private inputs: CrewEpisodeIn[] = [];
  private stopCache = new Map<string, CrewEpisode>();
  private probe: RoomDeckProbe | null = null;
  private fit: { report: SnapReport; ms: number; wall: number; slices: number; meshes: number; tris: number; worst: number; worstIn: string } | null = null;
  private crate: THREE.Mesh | null = null;
  private wheel: { node: THREE.Object3D; base: THREE.Quaternion } | null = null;
  /** the ship's own rope ladders (GANGWAY_<P|S>) the crew unrolls itself on pages without a voyage */
  private gangways: { node: THREE.Object3D; base: THREE.Vector3; x: number }[] = [];
  private turrets = new Map<string, { node: THREE.Object3D; base: THREE.Quaternion; restYaw: number }>();
  private listeners: ((e: CrewEvent) => void)[] = [];
  private perf = { avg: 0, peak: 0, plan: 0 };
  private scale = 1;
  private gen = 0;
  /** a config injected by a test page (vtpOut.crew.debugConfig): the room needs no `crew` key */
  debugCfg: RoomCrewConfig | null = null;
  protect = true;
  /** Test pages: time advances only through update(). ms */
  manual = false;
  clock = Date.now();
  now() { return this.manual ? this.clock : Date.now(); }

  // ------------------------------------------------------------------------------------------ lifecycle
  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    // scene.json `crew`, or nested as `voyage.crew` (SPEC C16)
    type VoyageJson = { crew?: unknown; groundY?: unknown; gait?: { kneel?: unknown }; turrets?: Record<string, { alias?: string }> };
    const info = rt.info as unknown as { crew?: unknown; voyage?: VoyageJson };
    const vg = info.voyage && typeof info.voyage === 'object' ? info.voyage : null;
    const raw = this.debugCfg ?? info.crew ?? vg?.crew;
    if (raw === undefined || raw === null || raw === false) return;
    const cfg = sanitizeCrewConfig(raw);
    // areas (SPEC 1.5 / 4.5): the deck crew lives in its own area (crew.area, else the room's default area); the
    // `galleyCook` area shows the galley cook alone; any other area of the ship shows no crew
    const ai = rt.info as unknown as { area?: string; defaultArea?: string };
    const deckArea = cfg.area ?? ai.defaultArea ?? null;
    const cookMode = !this.debugCfg && !!ai.area && !!cfg.galleyCook && ai.area === cfg.galleyCook;
    if (!this.debugCfg && ai.area && deckArea && ai.area !== deckArea && !cookMode) return;
    this.rt = rt;
    this.cfg = cfg;
    if (cookMode) { this.attachCook(rt); return; }
    // the sand under the halted ship: config, else the voyage's ground + its kneel, else the SPEC ship's
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const vGround = num(vg?.groundY);
    const ground = this.cfg.ground ?? (vGround !== null ? vGround + (num(vg?.gait?.kneel) ?? 3.0) : PRESET_GROUND);
    const height = this.cfg.height ?? 1.25;
    const deck = deckFromRoom(rt.root, rt.root, this.cfg.layout ?? 'auto', ground, { turrets: vg?.turrets, height }) ?? presetDeck(ground);
    this.probe = null; this.fit = null;
    // the alongside size spots down on the sand (scene.json sizeSpots, static room data): the shore party keeps clear of
    // a giant standing there (SPEC C14)
    const ss = (rt.info as unknown as { sizeSpots?: unknown }).sizeSpots;
    if (Array.isArray(ss)) for (const sp of ss) {
      const p = (sp as { position?: unknown })?.position;
      if (Array.isArray(p) && p.length === 3 && p.every((v) => typeof v === 'number' && Number.isFinite(v)) && p[1] < ground + 2.5) deck.avoid.push({ pos: new THREE.Vector3(p[0], ground, p[2]), r: 3.5 });
    }
    // the show set: CREW_KEEPOUT, else (SPEC Appendix A keepOut ['areas.deck.bounds']) the deck area's bounds box
    if (!deck.keepout && (this.cfg.keepOut ?? ['areas.deck.bounds']).length) {
      const ri = rt.info as unknown as { bounds?: unknown; areas?: Record<string, { bounds?: unknown }> };
      deck.keepout = boundsBox(ri.areas?.[deckArea ?? '']?.bounds) ?? boundsBox(ri.bounds);
      if (deck.keepout) deck.notes.push('keep-out: the deck area bounds');
    }
    // (the deck as authored until the geometry fit - load() - has run; nobody is drawn before that)
    this.deck = deck;
    this.group = new THREE.Group(); this.group.name = 'vtp:crew';
    rt.root.add(this.group);
    this.fx = new CrewFx();
    this.group.add(this.fx.group);
    void this.load();
  }

  /** The fitted deck is in: its crates and loading steps, the plan context, the cruise loops, the nodes it drives. */
  private useDeck(rt: SceneRuntime, deck: CrewDeck) {
    const height = this.cfg.height ?? 1.25;
    this.deck = deck;
    if (deck.helmCrate) {
      // a plain wooden crate under the Cap'n (the wheel hub is above a puppet's reach)
      const k = height / 1.25, c = deck.helmCrate;
      const box = new THREE.BoxGeometry(0.62 * k, c.h, 0.5 * k);
      this.crate = new THREE.Mesh(box, new THREE.MeshToonMaterial({ color: 0x7a4a26 }));
      this.crate.name = 'vtp:crew:helmCrate';
      this.crate.position.set(c.pos.x, c.pos.y + c.h / 2, c.pos.z);
      this.crate.rotation.y = c.yaw;
      this.crate.visible = false;           // (shown with the crew, after the warm-up compiled it)
      this.group.add(this.crate);
    }
    for (const g of deck.guns) {
      if (!g.step) continue;
      const k = height / 1.25;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.5 * k, g.step.h, 0.42 * k), new THREE.MeshToonMaterial({ color: 0x6d4223 }));
      m.name = `vtp:crew:step${g.id}`;
      m.visible = false;
      this.group.add(m);
      this.steps.push({ mesh: m, gun: g.id });
    }
    const seed = this.cfg.seed ?? hash32(rt.info.id, 'crew') % 100000;
    this.ctx = { deck: this.deck, cfg: this.cfg, seed, gunYaw: (g, ms) => this.gunYaw(g, ms) };
    this.cruise = Array.from({ length: crewCount(this.cfg) }, (_, i) => cruiseLoop(this.ctx!, i));
    // engine-driven nodes the crew owns (the wheel) / test-drives (turrets) / unrolls without a voyage (its gangways)
    if (this.deck.wheel?.node) this.wheel = { node: this.deck.wheel.node, base: this.deck.wheel.node.quaternion.clone() };
    rt.root.updateMatrixWorld(true);
    rt.room.root.traverse((o) => { if (/^GANGWAY(_[PS])?$/.test(o.name)) this.gangways.push({ node: o, base: o.scale.clone(), x: rt.root.worldToLocal(o.getWorldPosition(new THREE.Vector3())).x }); });
    for (const g of this.deck.guns) if (g.node) this.turrets.set(g.id, { node: g.node, base: g.node.quaternion.clone(), restYaw: g.restYaw });
  }

  /** The deck fit (crewDeck.snapDeckSteps) a few ms at a time between frames - a 40 m ship takes ~1 s of rays, and the
   *  show never stalls for it. A task queue (MessageChannel), not timers: a hidden OBS source still finishes it. */
  private async fitDeck(rt: SceneRuntime, deck: CrewDeck, gen: number): Promise<CrewDeck | null> {
    if (this.cfg.snap === false) return deck;
    const t0 = performance.now();
    let work = 0;
    try {
      const meshes = probeMeshes(rt.room.root, hideList(rt));
      if (!meshes.length) return deck;
      // (the BVHs one mesh at a time, sliced like the fit: 274k triangles in one go was a 55-62 ms task on air)
      const bv = bvhSteps(meshes);
      for (let done = false; !done;) {
        await nextTask();
        if (gen !== this.gen) return null;
        const b0 = performance.now();
        do { done = !!bv.next().done; } while (!done && performance.now() - b0 < 4);
        work += performance.now() - b0;
      }
      await nextTask();
      if (gen !== this.gen) return null;
      const w0 = performance.now();
      const probe = new RoomDeckProbe(meshes, rt.root);
      work += performance.now() - w0;
      const g = snapDeckSteps(deck, probe, 0.22 * ((this.cfg.height ?? 1.25) / 1.25));
      let slices = 0, worst = 0, worstIn = '', phase = 'start';
      for (;;) {
        await nextTask();
        if (gen !== this.gen) return null;
        const s0 = performance.now();
        let a = s0, v = g.next();
        const note = () => { const d = performance.now() - a; if (d > worst) { worst = d; worstIn = phase; } if (typeof v.value === 'string') phase = v.value; };
        note();
        while (!v.done && performance.now() - s0 < 4) { a = performance.now(); v = g.next(); note(); }
        work += performance.now() - s0;
        slices++;
        if (v.done) {
          this.probe = probe;
          this.fit = { report: v.value.report, ms: +work.toFixed(1), wall: +(performance.now() - t0).toFixed(0), slices, meshes: probe.size, tris: probe.tris, worst: +worst.toFixed(1), worstIn };
          return v.value.deck;
        }
      }
    } catch (e) { console.warn('[crew] deck fit failed', e); return gen === this.gen ? deck : null; }
  }

  detach() {
    for (const m of this.crew) m.npc.dispose();
    this.crew = [];
    this.fx?.dispose(); this.fx = null;
    if (this.crate) { this.crate.geometry.dispose(); (this.crate.material as THREE.Material).dispose(); this.crate = null; }
    for (const st of this.steps) { st.mesh.geometry.dispose(); (st.mesh.material as THREE.Material).dispose(); st.mesh.removeFromParent(); }
    this.steps = []; this.cook = false;
    if (this.wheel) this.wheel.node.quaternion.copy(this.wheel.base);
    for (const t of this.turrets.values()) t.node.quaternion.copy(t.base);
    for (const g of this.gangways) g.node.scale.copy(g.base);
    this.wheel = null; this.turrets.clear(); this.live.clear(); this.gangways = [];
    this.group.removeFromParent();
    this.rt = null; this.deck = null; this.ctx = null; this.cruise = []; this.eps = []; this.epsKey = ''; this.cache.clear(); this.stopCache.clear(); this.inputs = []; this.seen.clear();
    this.probe = null;
    // (the crew assets stay cached a while: back to this room -> no reload; disposed 5 min after the last user)
    if (this.assetKey) { CrewAssets.release(this.assetKey); this.assetKey = ''; }
    this.assets = null; this.gen++;
  }

  private async load() {
    const rt = this.rt;
    if (!rt) return;
    const gen = this.gen;
    // (one load per attach: a re-attach while an earlier load is still in flight starts its own instead of bailing)
    if (this.loadingGen === gen) return;
    this.loadingGen = gen;
    try {
      const url = (f: string) => sceneFileUrl(rt.info.id, f);
      const units = url(this.cfg.units ?? 'npc/crew_units.glb'), anims = (this.cfg.anims ?? ['npc/crew_anims.json', 'npc/crew_anims_ual.json']).map(url);
      const key = CrewAssets.keyOf(units, anims);
      CrewAssets.retain(key);
      this.assetKey = key;
      const pending = CrewAssets.load(units, anims);
      pending.catch(() => { /* reported below */ });
      if (!this.cook) {
        const fitted = await this.fitDeck(rt, this.deck!, gen);
        if (!fitted || gen !== this.gen || this.rt !== rt) return;
        this.useDeck(rt, fitted);
      }
      const assets = await pending;
      if (gen !== this.gen || this.rt !== rt) return;
      this.assets = assets;
      this.scale = (this.cfg.height ?? 1.25) / assets.furTop;
      const hues = this.cfg.hues ?? DEFAULT_HUES;
      // (SPEC P7 / P8: built off-screen one per task - a skeleton clone each, no long task - lit by the room's
      // environment like the rest of the ship, every program compiled with compileAsync, THEN shown: nothing compiles
      // on air, not even at the first fade or the first rope / bubble)
      const hold = new THREE.Group();
      hold.name = 'vtp:crew:warm';
      hold.visible = false;
      this.group.add(hold);
      const built: Member[] = [];
      const abort = () => { for (const m of built) m.npc.dispose(); hold.removeFromParent(); };
      for (let i = 0; i < this.cruise.length; i++) {
        if (i) { await nextTask(); if (gen !== this.gen || this.rt !== rt) { abort(); return; } }
        const tints = this.cfg.tints;
        const npc = new CrewNpc(assets, hold, hues[i % hues.length] ?? 0, tints?.length ? tints[i % tints.length] : undefined);
        npc.root.scale.setScalar(this.scale);
        const role = this.cook ? 'cook' : roleOf(i, this.cfg);
        let hat = this.cook ? 'hat_beanie' : role === 'deckhand' ? (hash32(i, 'hat') & 1 ? 'hat_sailor' : null) : HATS[role] ?? null;
        // (SPEC R6: a performer playing the puppet avatar is never mistaken for crew - an untinted clone always wears a hat)
        if (!hat && !(hues[i % hues.length] ?? 0)) hat = 'hat_sailor';
        built.push({ npc, i, role, fade: 1, protect: 1, s: null, hat, px: 0, lastEv: new Map() });
      }
      await this.warm(rt, hold, built);
      if (gen !== this.gen || this.rt !== rt) { abort(); return; }
      for (const m of built) this.group.add(m.npc.root);
      hold.removeFromParent();
      if (this.crate) this.crate.visible = true;
      for (const st of this.steps) st.mesh.visible = true;
      this.crew = built;
    } catch (e) {
      if (gen === this.gen) this.error = String((e as Error)?.message ?? e);
      console.warn('[crew] assets failed', e);
    } finally { if (this.loadingGen === gen) this.loadingGen = -1; }
  }

  /** The voyage engine plugs in here (null = standalone: test episodes only). */
  setFeed(feed: CrewFeed | null) { this.feed = feed; this.epsKey = ''; }
  /** The feed in use (output.ts hands the voyage's over only when it changes: setFeed re-plans). */
  get feedRef(): CrewFeed | null { return this.feed; }
  /** The crew is loaded and on deck (cheap; info() has the full picture). */
  get ready(): boolean { return !!this.rt && !!this.assets && this.crew.length > 0; }
  /** Cosmetic hooks (impact sparks / sounds in the voyage): hammer hits, welds, rams, shovel tosses, landings, catches. */
  onEvent(fn: (e: CrewEvent) => void) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }

  // ------------------------------------------------------------------------------------------ the pure bits (voyage API)
  /** How long the ship must stay halted for a treasure stop (s): the planned last-aboard time + 1.5 s. Pure: every page
   *  computes the same. `prior` = the episodes before it (default: the ones this page plans with now, feed + tests). */
  stopDuration(stop: CrewStopIn, prior?: CrewEpisodeIn[]): number {
    // (before the room's deck is known - not attached yet, or another area - a safe upper bound: a stop held longer
    // than the plan needs only waits; call it once info().ready for the exact figure)
    if (!this.ctx || this.cook) return STOP_BOUND;
    const s = sanitizeCrewEpisode(stop);
    if (!s || s.k !== 'treasure') return 60;
    let src = prior;
    if (!src) {
      // the feed's episodes before the stop (a voyage asking from inside its own episodes(): only what is planned now)
      src = [];
      if (this.feed && !this.inFeed) {
        this.inFeed = true;
        try { src = [...this.feed.episodes(s.at - 20 * 60e3, s.at)]; } catch { src = this.inputs; } finally { this.inFeed = false; }
      } else src = this.inputs;
      src = [...src, ...this.tests];
    }
    const pr = this.remember(src.map((e) => sanitizeCrewEpisode(e)).filter((e): e is CrewEpisodeIn => !!e), false);
    if (this.stopCache.size > 32) this.stopCache.clear();
    return crewStopDuration(this.ctx, this.cruise, s, pr, this.stopCache);
  }
  private inFeed = false;
  /** Shots / hits seen per battle id (a feed that only lists the next ~30 s keeps adding; nothing ever drops out, so a
   *  re-plan only ever ADDS - causal - and a shot that left the feed's window is still the loader's past). */
  private seen = new Map<string, { at: number; shots: Map<string, { gun: string; at: number }>; hits: Map<string, CrewBattleIn['hits'][number]> }>();
  private remember(list: CrewEpisodeIn[], store = true): CrewEpisodeIn[] {
    return list.map((e) => {
      if (e.k !== 'battle' || e.id.startsWith('test-')) return e;
      let m = this.seen.get(e.id);
      if (!m || m.at !== e.alert) { m = { at: e.alert, shots: new Map(), hits: new Map() }; if (store) this.seen.set(e.id, m); }
      const shots = new Map(m.shots), hits = new Map(m.hits);
      for (const s of e.shots) shots.set(`${s.gun}@${Math.round(s.at)}`, s);
      for (const h of e.hits) hits.set(h.id ?? `h${Math.round(h.at).toString(36)}`, h);
      if (store) { m.shots = shots; m.hits = hits; }
      if (shots.size === e.shots.length && hits.size === e.hits.length) return e;
      return { ...e, shots: [...shots.values()].sort((a, b) => a.at - b.at), hits: [...hits.values()].sort((a, b) => a.at - b.at || (String(a.id) < String(b.id) ? -1 : 1)) };
    });
  }
  /** Repair progress 0..1 of a hull hit (fade its decal / fire with it). */
  repairProgress(hitId: string, ms = this.now()): number { return repairProgress(this.eps, hitId, ms); }
  /** The current phase ('CRUISE' | 'ALERT' | 'COMBAT' | 'VICTORY' | 'FLEE' | 'TREASURE' | 'DEPART') + the active episode. */
  phase(ms = this.now()): { phase: string; episode: string | null } {
    for (let k = this.eps.length - 1; k >= 0; k--) {
      const e = this.eps[k];
      const t = (ms - e.start) / 1000;
      if (t < 0 || t > Math.max(...e.resume)) continue;
      let ph = 'CRUISE';
      for (const [pt, name] of e.phases) if (t >= pt) ph = name;
      return { phase: ph, episode: e.id };
    }
    return { phase: 'CRUISE', episode: null };
  }
  /** Where the action is (room space), e.g. for a sortie cutaway: the shore party / the busiest repair. */
  focus(): THREE.Vector3 | null {
    const g = this.deck?.ground ?? PRESET_GROUND;
    const pts = this.crew.filter((m) => m.s && (m.s.air || m.s.pos.y < g + 1)).map((m) => m.s!.pos);
    if (!pts.length) return null;
    return pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  }

  // ------------------------------------------------------------------------------------------ feed defaults
  /** The turret FRAME's yaw (room, rad) of gun g at wall ms (pure: plans + the sync hash). The feed gives the barrel's
   *  yaw; a TURRET_n node's +Z need not run along its barrel (DeckGun.aimOff). */
  private gunYaw(g: string, ms: number): number {
    const gun = this.deck?.guns.find((x) => x.id === g);
    const rest = gun?.restYaw ?? 0;
    const f = this.feed?.gunYaw;
    if (f) { let b = NaN; try { b = f(g, ms); } catch { /* feed */ } return Number.isFinite(b) ? b - (gun?.aimOff ?? 0) : rest; }
    // (only a real turret node is ever turned: a turret baked into the hull mesh stays put, and so do its seats)
    if (!this.cfg.driveTurrets || !gun?.node) return rest;
    // test rooms: swing to the bearing of a running test battle
    for (const e of this.tests) {
      if (e.k !== 'battle' || ms < e.alert || ms > e.end + 4000) continue;
      const k = Math.min(1, Math.max(0, (ms - e.alert - 2000) / 3000)) * Math.min(1, Math.max(0, (e.end + 4000 - ms) / 3000));
      let d = e.bearing - gun.aimOff + 0.12 * Math.sin(ms / 2300 + g.charCodeAt(0)) - rest;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      return rest + d * k * k * (3 - 2 * k);
    }
    return rest;
  }
  /** Frames for DRAWING at `now`: the plans' frames, except that with no feed yaw and no test drive a turret someone
   *  else turns (the voyage) is read live, so seated crew ride it. */
  private drawFrames(ctx: PlanCtx, start: number): FrameFn {
    const base = framesFor(ctx, start);
    if (this.feed?.gunYaw || this.cfg.driveTurrets || !this.live.size) return base;
    return (id, t) => { const m = id.startsWith('GUN_') ? this.live.get(id.slice(4)) : null; return m ?? base(id, t); };
  }
  private live = new Map<string, THREE.Matrix4>();
  private liveTurrets() {
    this.live.clear();
    if (!this.deck || !this.rt || this.feed?.gunYaw || this.cfg.driveTurrets) return;
    const q = new THREE.Quaternion(), rq = this.rt.root.getWorldQuaternion(new THREE.Quaternion()).invert(), f = new THREE.Vector3();
    for (const g of this.deck.guns) {
      if (!g.node) continue;
      f.set(0, 0, 1).applyQuaternion(rq.clone().multiply(g.node.getWorldQuaternion(q)));
      const yaw = Math.atan2(f.x, f.z);
      if (Math.abs(Math.atan2(Math.sin(yaw - g.restYaw), Math.cos(yaw - g.restYaw))) < 1e-3) continue;
      this.live.set(g.id, gunFrame(g, yaw));
    }
  }
  private wheelAngle(ms: number): number {
    const yr = this.feed?.yawRate;
    const rate = (yr ? safeNum(() => yr(ms + 400)) : undefined) ?? (yr ? 0 : 0.05 * Math.sin(ms / 7000) + 0.03 * Math.sin(ms / 2900));
    // (SPEC 1.3: wheel angle = clamp(18 x the yaw rate 0.4 s ahead, +-540 deg): the wheel turns before the ship does)
    return THREE.MathUtils.clamp(rate * 18, -Math.PI * 3, Math.PI * 3);
  }

  // ------------------------------------------------------------------------------------------ tests
  /** Test pages: a local episode in `inSec` s ('battle' | 'flee' | 'treasure' (starboard) | 'treasure:port' | 'treasure:quick'). */
  test(kind: string, inSec = 2, opts: TestOpts = {}) {
    const t = this.now() + inSec * 1000;
    const id = `test-${kind.replace(/[^a-z]/g, '')}-${Math.round(t)}`;
    if (kind === 'battle' || kind === 'flee') {
      const D = (opts.end && opts.alert ? (opts.end - opts.alert) : 60_000);
      // (hits on the room's own hull sites when it has them - DAMAGE_nn - else three on the built-in hull)
      const sites = this.deck?.repairs.length ? this.deck.repairs.map((r) => r.pos.toArray() as [number, number, number]) : [[-5.1, -5.0, -1.0], [4.95, -4.4, 2.6], [-4.7, -2.4, 7.0]] as [number, number, number][];
      const hits = opts.hits ?? [0.3, 0.48, 0.55].map((f, k) => ({ id: `${id}-h${k + 1}`, at: t + D * f, pos: sites[(k * 3) % sites.length], severity: ((k + 2) % 3 + 1) as 1 | 2 | 3 }));
      const e = sanitizeCrewEpisode({ k: 'battle', id, alert: t, end: t + D, outcome: kind === 'flee' ? 'flee' : 'win', bearing: opts.bearing ?? -2.3, shots: opts.shots ?? [], hits });
      if (e) this.tests.push(e);
    } else if (kind.startsWith('treasure')) {
      const side = kind.includes('starboard') ? 'starboard' : kind.includes('port') ? 'port' : undefined;
      const e = sanitizeCrewEpisode({ k: 'treasure', id, at: t, ...(side ? { side } : {}), ...(kind.includes('quick') ? { until: t + 45_000 } : {}), ...(opts.haul ? { haul: opts.haul } : {}), ...(opts.loot ? { loot: opts.loot } : {}), ...(opts.groundY !== undefined ? { groundY: opts.groundY } : {}) });
      if (e) this.tests.push(e);
    }
    if (this.tests.length > 12) this.tests.shift();
    this.epsKey = '';
    return id;
  }
  /** Test pages: a clip gallery (review every clip in the app renderer): the crew stand in a row at `at` (room space,
   *  default the stern deck) facing `yaw`, each playing one of `clips` (null = back to the plans). */
  gallery(clips: string[] | null, at?: [number, number, number], yaw = 0, spacing = 0.95, talk = false) {
    this.galleryCfg = clips ? { clips: clips.slice(0, 9), at: new THREE.Vector3(...(at ?? [0, -1.5, 13.6])), yaw, spacing, talk } : null;
  }
  private galleryCfg: { clips: string[]; at: THREE.Vector3; yaw: number; spacing: number; talk: boolean } | null = null;
  /** Test pages: a config for a room without a `crew` key ('demo' = the built-in preset layout), re-attaches. */
  debugConfig(cfg: RoomCrewConfig | 'demo' | null) {
    this.debugCfg = cfg === 'demo' ? { layout: 'preset', driveTurrets: true } : cfg;
    const rt = this.rt ?? null;
    if (rt) { this.detach(); this.attach(rt); }
  }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number) {
    if (this.manual) this.clock += dt * 1000;
    const rt = this.rt, ctx = this.ctx;
    if (!rt || !ctx || !this.assets || !this.fx || !this.crew.length) return;
    const t0 = performance.now();
    const now = this.now();
    this.frame++;
    // ---- episodes (re-planned only when the input list changes; the galley cook has none)
    const inputs: CrewEpisodeIn[] = [];
    let planMs = 0;
    if (!this.cook) {
      if (this.feed) { try { for (const e of this.feed.episodes(now - 20 * 60e3, now + 120e3)) inputs.push(e); } catch (e) { this.error = String(e); } }
      for (const e of this.tests) inputs.push(e);
      // (re-planned whenever the CONTENT changes - hits, shots, end, outcome, stop window - not just the id list: every
      // page then plans the same final input, and the planner is causal, so a re-plan never moves anyone before now)
      const clean = this.remember(inputs.map((e) => sanitizeCrewEpisode(e)).filter((e): e is CrewEpisodeIn => !!e));
      if (this.seen.size > 24) for (const [id, m] of this.seen) if (m.at < now - 25 * 60e3) this.seen.delete(id);
      const key = inputsKey(clean);
      if (key !== this.epsKey) {
        const p0 = performance.now();
        this.eps = planEpisodes(ctx, this.cruise, clean, this.cache);
        this.inputs = clean;
        this.epsKey = key;
        planMs = performance.now() - p0;
        this.perf.plan = Math.max(this.perf.plan * 0.5, planMs);
      }
    }
    // ---- engine-driven nodes
    const wheelA = this.wheelAngle(now);
    if (this.wheel) this.wheel.node.quaternion.copy(this.wheel.base).multiply(TQ.setFromAxisAngle(tv.set(0, 0, 1), wheelA));
    if (this.cfg.driveTurrets && !this.feed?.gunYaw) for (const [g, tr] of this.turrets) {
      tr.node.quaternion.copy(tr.base).multiply(TQ.setFromAxisAngle(tv.set(0, 1, 0), this.gunYaw(g, now) - tr.restYaw));
    }
    this.liveTurrets();
    if (this.steps.length) {
      const fr = this.drawFrames(ctx, now);
      for (const st of this.steps) {
        const g = this.deck!.guns.find((x) => x.id === st.gun);
        const M = g?.step ? fr(`GUN_${g.id}`, 0) : null;
        if (!g?.step || !M) continue;
        st.mesh.position.set(g.step.pos.x, g.step.pos.y + g.step.h / 2, g.step.pos.z).applyMatrix4(M);
        st.mesh.quaternion.setFromRotationMatrix(M).multiply(TQ.setFromAxisAngle(tv.set(0, 1, 0), g.step.yaw));
      }
    }
    // ---- sample everyone
    const cam = rt.stage.camera;
    const H = rt.stage.renderer.domElement.height || 1080;
    const pxK = H / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const bias = gfxBudget().lodBias ?? 1;
    const L = this.cfg.lod ?? {};
    const lod0 = (L.lod0px ?? 140) / bias, lod1 = (L.lod1px ?? 40) / bias, lod2 = (L.lod2px ?? 12) / bias;
    const every = L.poseEvery ?? [1, 2, 3];
    let tilt: { pitch: number; roll: number } | undefined;
    try { const tl = this.feed?.tilt?.(now); if (tl && Number.isFinite(tl.pitch) && Number.isFinite(tl.roll)) tilt = tl; } catch { /* feed */ }
    const accel = safeNum(this.feed?.accel ? () => this.feed!.accel!(now) : null) ?? 0;
    const brace = THREE.MathUtils.smoothstep(accel, 2.5, 3.5);
    const crewH = (this.cfg.height ?? 1.25);
    const bursts: Burst[] = [];
    const bubbles: { at: THREE.Vector3; text: string; loud: boolean; scale: number }[] = [];
    for (const m of this.crew) {
      const ep = activeEpisode(this.eps, m.i, now);
      let s: Sample | null;
      let localT: number;
      if (ep) { localT = (now - ep.start) / 1000; s = sampleTrack(ep.tracks[m.i], localT, this.drawFrames(ctx, ep.start), m.s ?? undefined); }
      else { const c = this.cruise[m.i]; localT = cruiseTime(c, now); s = sampleTrack(c.track, localT, this.drawFrames(ctx, now - localT * 1000), m.s ?? undefined); }
      if (this.galleryCfg) s = this.gallerySample(m.i);
      m.s = s;
      if (!s) { m.npc.root.visible = false; continue; }
      // feet on the real floor under them (SPEC 4.4: the geometry, not the anchors' straight lines between stairs / sheer)
      if (!this.galleryCfg) this.footing(m, s);
      m.sand = ep?.ground;
    }
    // personal space: crew on the move step round each other (presentation only: the plans and the hash are untouched)
    if (!this.galleryCfg) this.separate();
    // on the sand: onto the voyage's ground where they stand after stepping aside
    if (!this.galleryCfg && this.feed?.groundAt) for (const m of this.crew) if (m.s && m.sand !== undefined) this.onSand(m.s.pos, m.sand, now);
    for (const m of this.crew) {
      const s = m.s, npc = m.npc;
      if (!s) continue;
      // root: deck position + yaw, leaning back toward world-upright on a tilted deck
      npc.root.position.copy(s.pos);
      npc.root.quaternion.setFromAxisAngle(tv.set(0, 1, 0), s.yaw);
      if (tilt && !s.ladder) { UPQ.setFromEuler(EU.set(-tilt.pitch * 0.7, 0, -tilt.roll * 0.7, 'YXZ')); npc.root.quaternion.premultiply(UPQ); }
      // LOD by height on screen
      const d = Math.max(0.1, cam.position.distanceTo(s.pos));
      m.px = (crewH / d) * pxK;
    }
    // at most maxLod0 at full detail (the nearest)
    const order = this.crew.slice().sort((a, b) => b.px - a.px);
    const maxL0 = L.maxLod0 ?? 6;
    order.forEach((m, k) => {
      const l = m.px >= lod0 && k < maxL0 ? 0 : m.px >= lod1 ? 1 : m.px >= lod2 ? 2 : 3;
      m.npc.setLod(l);
    });
    // ---- face guard (every frame, SPEC P14: a 4 Hz guard let a crew member cover a face for up to 250 ms)
    this.protectFaces(cam);
    // ---- pose + props + mouth + events
    for (const m of this.crew) {
      const s = m.s, npc = m.npc;
      if (!s) continue;
      const lod = npc.lod;
      const fadeTarget = s.hidden ? 0 : Math.max(0, m.protect);
      // (out in 0.15 s, back in 0.4 s; protect < 0 = between the lens and a face: gone at once)
      if (m.protect < 0) m.fade = 0;
      else m.fade += Math.sign(fadeTarget - m.fade) * Math.min(Math.abs(fadeTarget - m.fade), dt * (fadeTarget < m.fade ? 1 / 0.15 : 2.5));
      npc.setOpacity(lod === 3 ? 0 : m.fade);
      if (lod === 3 || m.fade < 0.01) continue;
      const k = every[Math.min(2, lod)] ?? 1;
      const doPose = k <= 1 || (this.frame + m.i) % k === 0;
      if (doPose) {
        const base = this.layers(s, now, wheelA);
        if (brace > 0.01 && !s.air && !s.ladder) { const bc = this.clip('brace'); if (bc) { for (const Lr of base) Lr.w *= 1 - brace * 0.7; base.push({ clip: bc, t: 0.3, w: brace * 0.7 }); } }
        let over: Layer | null = null;
        if (s.over && s.overW > 0) { const oc = this.clip(s.over); if (oc) over = { clip: oc, t: s.overTime, w: s.overW }; }
        if (base.length) npc.pose(base, over);
      }
      const prop = s.held === '' ? null : (s.held ?? clipMeta(s.clip)?.prop ?? null);
      npc.setProps([prop, m.hat]);
      npc.setInk(lod === 0 && m.px > 220);
      // speech: the plan's bubbles (jaw flaps while one is up)
      let speaking = false;
      if (this.galleryCfg?.talk && !this.galleryCfg.clips[m.i]?.startsWith('#')) {
        speaking = true;
        npc.headWorld(tv);
        if (m.i % 3 === 0) bubbles.push({ at: tv.clone().add(tv2.set(0, 0.62 * this.scale, 0)), text: 'OY! TEST LINE!', loud: m.i === 0, scale: this.scale });
      } else if (ep(this.eps, m.i, now)) {
        const e = ep(this.eps, m.i, now)!;
        const t = (now - e.start) / 1000;
        const b = e.bubbles.find((x) => x.crew === m.i && t >= x.t0 && t <= x.t1);
        if (b && this.cfg.bubbles !== false) {
          speaking = true;
          npc.headWorld(tv);
          bubbles.push({ at: tv.clone().add(tv2.set(0, 0.62 * this.scale, 0)), text: b.text, loud: !!b.loud, scale: this.scale });
        }
      }
      npc.mouth(speaking && lod <= 1 ? 0.35 + 0.65 * Math.abs(Math.sin(now / 1000 * 13 + m.i * 1.7)) : 0);
      // clip events -> sparks / dust / hooks
      this.clipEvents(m, prop, now, bursts);
    }
    // ---- episode FX, ropes, loose items
    const ropes: { key: string; kind: 'ladder' | 'hoist'; top: THREE.Vector3; bottom: THREE.Vector3; k: number; yaw: number; tilt: number }[] = [];
    const items: { key: string; geo: THREE.BufferGeometry; mat: THREE.Material; pos: THREE.Vector3; yaw: number; tilt?: number }[] = [];
    // (no voyage on this page: the crew lets the ship's own rope ladder down itself - local -Y unrolls, SPEC 1.3)
    const unroll = new Map<{ node: THREE.Object3D; base: THREE.Vector3; x: number }, number>();
    for (const e of this.eps) {
      const t = (now - e.start) / 1000;
      if (t < -1 || t > Math.max(...e.resume0) + 5) continue;
      for (const f of e.fx) if (t >= f.t && t - f.t < 1.6) bursts.push({ t0: f.t + e.start / 1000, pos: this.sandPt(f.pos, e.ground, now), kind: f.kind === 'coins' ? 'coins' : f.kind === 'sparks' ? 'spark' : f.kind, seed: hash32(e.id, f.t), size: f.size });
      e.ropes.forEach((r, k) => {
        if (r.ship && t >= r.t0 && t <= r.t1) { const kk = Math.min(1, (t - r.t0) / Math.max(0.05, r.unroll)); for (const g of this.gangways) if (Math.sign(g.x) === Math.sign(r.top.x)) unroll.set(g, Math.max(unroll.get(g) ?? 0, kk)); }
        if (t < r.t0 || t > r.t1 || r.ship) return;
        const kk = Math.min(1, (t - r.t0) / Math.max(0.05, r.unroll));
        const bot = this.sandPt(r.bottom, e.ground, now);
        const hx = bot.x - r.top.x, hz = bot.z - r.top.z;
        ropes.push({ key: `${e.id}:${k}`, kind: r.kind, top: r.top, bottom: bot, k: kk, yaw: Math.atan2(hx, hz), tilt: Math.atan2(Math.hypot(hx, hz), Math.max(0.01, r.top.y - bot.y)) });
      });
      for (const it of e.items) { const pr = this.assets.props.get(it.kind); const p = pr ? this.itemPose(it, t) : null; if (p && e.ground !== undefined && !this.between(it, t)) this.onSand(p.pos, e.ground, now); if (p && pr) items.push({ key: `${e.id}:${it.id}`, geo: pr.geo, mat: this.crew[0].npc.mat, ...p }); }
    }
    if (!this.feed) for (const g of this.gangways) {
      const k = unroll.get(g) ?? 0;
      if (k > 0) g.node.scale.set(1, Math.max(1e-4, k), 1); else g.node.scale.copy(g.base);
    }
    const fx = this.fx;
    fx.begin();
    const tNow = now / 1000;
    for (const b of bursts) fx.burst(b, tNow);
    fx.end(cam, H);
    fx.setBubbles(bubbles, cam);
    fx.setRopes(ropes);
    fx.setItems(items.filter((x) => !!x.geo));
    const ms = performance.now() - t0 - planMs;          // (planning is reported on its own: once per new event)
    this.perf.avg = this.perf.avg * 0.95 + ms * 0.05;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private clip(name: string): CrewClip | null { return this.assets?.clips.get(name) ?? null; }

  private gallerySample(i: number): Sample | null {
    const g = this.galleryCfg!;
    const name = g.clips[i];
    if (!name) return null;
    const c = this.clip(name);
    const n = Math.min(9, g.clips.length);
    const pos = g.at.clone().add(new THREE.Vector3((i - (n - 1) / 2) * g.spacing, 0, 0));   // (a row across +X; each turns to `yaw`)
    const t = this.now() / 1000;
    const dur = c?.dur ?? 1;
    const time = c && !c.loop ? t % (dur + 0.8) : t;
    return { pos, yaw: g.yaw, hidden: false, clip: name, time, prev: null, prevTime: 0, w: 1, over: null, overTime: 0, overW: 0, seg: 0, segT: time, air: false, ladder: false };
  }

  /** The base layers for a sample (cross-fade from the previous segment; the feed-resolved helm / gun-laying poses). */
  private layers(s: Sample, now: number, wheelA: number): Layer[] {
    const out: Layer[] = [];
    const push = (name: string, t: number, w: number, dyn?: string, dynArg?: string) => {
      if (w < 0.001) return;
      if (dyn === 'helm') {
        // hold, or hand-over-hand locked to the wheel angle (120 deg per loop)
        const a1 = this.wheelAngle(now - 120);
        const rate = (wheelA - a1) / 0.12;
        const turning = Math.abs(rate) > 0.25;
        const c = this.clip(turning ? (rate > 0 ? 'helm_turn_l' : 'helm_turn_r') : 'helm_hold');
        if (!c) return;
        const tt = turning ? (Math.abs(wheelA) / (Math.PI * 2 / 3)) * c.dur * (rate > 0 ? 1 : -1) : t;
        out.push({ clip: c, t: tt, w });
        return;
      }
      if (dyn === 'gunlay') {
        const gp = this.feed?.gunPitch;
        const pitch = (gp ? safeNum(() => gp(dynArg ?? 'F', now)) : undefined) ?? 0;
        const mid = this.clip('gun_lay_mid');
        if (!mid) return;
        const up = pitch > 0, k = Math.min(1, Math.abs(pitch) / THREE.MathUtils.degToRad(up ? 22 : 14));
        const other = this.clip(up ? 'gun_lay_up' : 'gun_lay_down');
        // the crank turns while the barrel is moving
        const p1 = (gp ? safeNum(() => gp(dynArg ?? 'F', now - 150)) : undefined) ?? 0;
        const moving = Math.abs(pitch - p1) > 0.002 || !this.feed?.gunPitch;
        const tt = moving ? t : Math.floor(t);
        out.push({ clip: mid, t: tt, w: w * (1 - k) });
        if (other && k > 0.001) out.push({ clip: other, t: tt, w: w * k });
        return;
      }
      const c = this.clip(name);
      if (c) out.push({ clip: c, t, w });
    };
    if (s.prev && s.w < 1) push(s.prev, s.prevTime, 1 - s.w);
    push(s.clip, s.time, s.prev ? s.w : 1, s.dyn, s.dynArg);
    if (!out.length) { const idle = this.clip('idle'); if (idle) out.push({ clip: idle, t: now / 1000, w: 1 }); }
    // the anchor (first) layer must carry weight
    if (out.length > 1 && out[0].w < 0.001) out.shift();
    return out;
  }

  /** Hammer hits (sparks at the hammer face), welding (sparks at the nozzle), rams, shovel tosses, landings. */
  private clipEvents(m: Member, prop: string | null, now: number, bursts: Burst[]) {
    const s = m.s!;
    const meta = clipMeta(s.clip);
    if (!meta) return;
    const tNow = now / 1000;
    const ev = meta.events ?? {};
    const rate = 1;
    const emit = (kind: CrewEvent['kind'], occ: number, age: number, pos: THREE.Vector3, burst: Burst['kind'] | null, size = 1) => {
      const key = `${kind}:${s.seg}`;
      if (burst) bursts.push({ t0: tNow - age, pos: pos.clone(), kind: burst, seed: hash32(m.i, s.seg, occ, kind), size });
      if ((m.lastEv.get(key) ?? -1) < occ && age < 0.2) {
        m.lastEv.set(key, occ);
        if (m.lastEv.size > 16) m.lastEv.delete(m.lastEv.keys().next().value!);
        for (const f of this.listeners) { try { f({ kind, crew: m.i, pos: pos.clone(), at: now - age * 1000 }); } catch { /* listener */ } }
      }
    };
    const occurrences = (evT: number, life: number, cb: (occ: number, age: number) => void) => {
      const dur = meta.dur;
      if (!meta.loop) { const age = (s.time - evT) / rate; if (age >= 0 && age < life) cb(0, age); return; }
      const k0 = Math.floor((s.time - evT) / dur);
      for (let k = k0; k > k0 - 2; k--) { const age = s.time - (k * dur + evT); if (age >= 0 && age < life) cb(k, age); }
    };
    if (ev.hit !== undefined && prop === 'hammer') occurrences(ev.hit, 0.55, (k, age) => { const p = m.npc.propTip('hammer', tv3); if (p) emit('hammer', k, age, p, 'spark'); });
    if (ev.arc !== undefined && prop === 'torch') {
      const p = m.npc.propTip('torch', tv3);
      if (p) { const step = 0.09; const k0 = Math.floor(s.time / step); for (let k = k0; k > k0 - 4; k--) { const age = s.time - k * step; bursts.push({ t0: tNow - age, pos: p.clone(), kind: 'weld', seed: hash32(m.i, s.seg, k), size: 1 }); } emit('weld', Math.floor(s.time / 1.0), 0, p, null); }
    }
    if (ev.ram !== undefined) occurrences(ev.ram, 0.3, (k, age) => emit('ram', k, age, m.npc.headWorld(tv3), null));
    if (ev.toss !== undefined) occurrences(ev.toss, 0.5, (k, age) => { const f = this.deck?.spots.get('CREW_FIREBOX'); if (f) emit('toss', k, age, tv3.copy(f.pos).add(tv2.set(0, 0.5, 0)), 'spark', 0.7); });
    if (s.clip === 'land') occurrences(0, 1.4, (k, age) => emit('land', k, age, s.pos, 'dust', 0.9));
    if (ev.catch !== undefined) occurrences(ev.catch, 0.2, (k, age) => emit('catch', k, age, m.npc.headWorld(tv3), null));
  }

  /** A loose item's pose at episode time t. */
  private itemPose(it: ItemTrack, t: number): { pos: THREE.Vector3; yaw: number; tilt?: number } | null {
    let seg = null;
    for (const s of it.segs) if (t >= s.t0 && t < s.t1) seg = s;
    if (!seg) { const last = it.segs[it.segs.length - 1]; if (last && t >= last.t1 && last.mode === 'at') seg = last; else return null; }
    const u = Math.min(1, Math.max(0, (t - seg.t0) / Math.max(1e-4, seg.t1 - seg.t0)));
    const lift = it.kind === 'coinbag' ? 0.13 * this.scale : 0;
    switch (seg.mode) {
      case 'hidden': return null;
      case 'at': return { pos: seg.a!.clone().add(tv.set(0, lift + (it.kind === 'chest' ? 0.1 * this.scale : 0), 0)), yaw: seg.yaw ?? 0 };
      case 'rise': return { pos: seg.a!.clone().lerp(seg.b!, u * u * (3 - 2 * u)), yaw: seg.yaw ?? 0, tilt: 0.25 * (1 - u) };
      case 'line': return { pos: seg.a!.clone().lerp(seg.b!, u), yaw: (seg.yaw ?? 0) + Math.sin(t * 2.1) * 0.15 };
      case 'arc': { const p = seg.a!.clone().lerp(seg.b!, u); p.y += 4 * (seg.h ?? 0.5) * u * (1 - u); return { pos: p, yaw: t * 5, tilt: t * 3 }; }
      case 'between': {
        const a = this.crew[seg.crew![0]]?.s, b = this.crew[seg.crew![1]]?.s;
        if (!a || !b) return null;
        const p = a.pos.clone().lerp(b.pos, 0.5);
        p.y += 0.06 * this.scale;
        return { pos: p, yaw: Math.atan2(b.pos.x - a.pos.x, b.pos.z - a.pos.z) + Math.PI / 2 };
      }
    }
    return null;
  }

  /** SPEC 4.4 / C5: on the sand, follow the voyage's ground (feed.groundAt) instead of the flat stop plane (sandLift). */
  private onSand(p: THREE.Vector3, ground: number, now: number) {
    const f = this.feed?.groundAt;
    if (!f || p.y > ground + SAND_BAND) return;
    let gy: number;
    try { gy = f.call(this.feed, p.x, p.z, now); } catch { return; }
    p.y = sandLift(p.y, ground, gy);
  }
  /** A point of an episode on the sand, lifted (a copy; the plan's own point when there is nothing to do). */
  private sandPt(p: THREE.Vector3, ground: number | undefined, now: number): THREE.Vector3 {
    if (ground === undefined || !this.feed?.groundAt || p.y > ground + SAND_BAND) return p;
    const q = p.clone();
    this.onSand(q, ground, now);
    return q;
  }
  /** Is a loose item carried between two crew at t (its pose comes from their already-lifted samples)? */
  private between(it: ItemTrack, t: number) { for (const s of it.segs) if (t >= s.t0 && t < s.t1) return s.mode === 'between'; return false; }

  /** Compile every program the crew draws before it is shown: the crew material opaque AND fading (transparent is part
   *  of the program key: the first fade compiled on air), every LOD and the ink (compile walks hidden objects too),
   *  props / loose items (the same material unskinned), the crate / steps, ropes, bubbles and sparks. compileAsync:
   *  KHR_parallel_shader_compile, the page keeps drawing meanwhile. */
  private async warm(rt: SceneRuntime, hold: THREE.Group, built: Member[]) {
    if (!built.length || !this.fx) return;
    const r = rt.stage.renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Object3D) => Promise<unknown> };
    const mats = built.map((m) => m.npc.mat);
    // lit by the room's environment (day / night, weather) like the ship around them (SPEC P8)
    for (const m of [...mats, ...this.fx.litMaterials(), ...(this.crate ? [this.crate.material as THREE.Material] : []), ...this.steps.map((st) => st.mesh.material as THREE.Material)]) {
      try { patchEnvMaterial(m, { lit: true }); } catch { /* unpatched: lit as before */ }
    }
    const undo = this.fx.prewarm();
    const prop = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), mats[0]);
    hold.add(prop);
    const run = async () => {
      try { await (r.compileAsync ? r.compileAsync(this.group, rt.stage.camera, rt.stage.scene) : Promise.resolve(r.compile(this.group, rt.stage.camera, rt.stage.scene))); } catch { /* optional */ }
    };
    try {
      await run();
      for (const m of mats) { m.transparent = true; m.needsUpdate = true; }
      await run();
      // (the atlas / ramp upload and each program's first use - uniform lookup + error check, ~5-25 ms each - on tasks
      // of their own, not inside the first frame that shows the crew)
      await nextTask();
      try { for (const t of [mats[0].map, mats[0].gradientMap]) if (t) r.initTexture(t); } catch { /* optional */ }
      const progs = new Set<{ getUniforms(): unknown }>();
      const props = (r as unknown as { properties?: { get(m: THREE.Material): { programs?: Map<string, { getUniforms(): unknown }> } } }).properties;
      this.group.traverse((o) => {
        const mm = (o as THREE.Mesh).material;
        for (const m of mm ? (Array.isArray(mm) ? mm : [mm]) : []) for (const p of props?.get(m)?.programs?.values() ?? []) progs.add(p);
      });
      for (const p of progs) { await nextTask(); try { p.getUniforms(); } catch { /* reported by three */ } }
      await nextTask();
    } finally {
      for (const m of mats) { m.transparent = false; m.needsUpdate = true; }
      prop.removeFromParent(); prop.geometry.dispose();
      undo();
    }
  }

  // ------------------------------------------------------------------------------------------ never in front of the show
  /** A foot point on the real floor: the walkable surface nearest the planned height (+-0.22 m; +-0.7 m riding a
   *  turret), cached per 2 cm; not
   *  in the air, on a ladder, on the sand or on a crate / loading step (those are exact by construction). */
  private footing(m: Member, s: Sample) {
    const d = this.deck, probe = this.probe;
    if (!d || !probe || s.air || s.ladder || s.hidden || s.pos.y < d.ground + 0.6) return;
    const helm = d.spots.get('CREW_HELM');
    if (d.helmCrate && helm && Math.hypot(s.pos.x - helm.pos.x, s.pos.z - helm.pos.z) < 0.1 && Math.abs(s.pos.y - helm.pos.y) < 0.05) return;
    if (s.frame?.startsWith('GUN_')) { const g = d.guns.find((x) => `GUN_${x.id}` === s.frame); if (g?.step && Math.abs(s.pos.y - (g.pivot.y + g.breech.pos.y)) < 0.03) return; }
    const kx = Math.round(s.pos.x * 50), ky = Math.round(s.pos.y * 50), kz = Math.round(s.pos.z * 50);
    // (a gunner / loader riding a turning turret sweeps over whatever deck is under it: a step either way up to 0.7 m)
    if (!m.foot || m.foot.kx !== kx || m.foot.ky !== ky || m.foot.kz !== kz) m.foot = { kx, ky, kz, y: floorUnder(probe, s.pos.x, s.pos.z, s.pos.y, s.frame?.startsWith('GUN_') ? 0.7 : 0.22) };
    s.pos.y = m.foot.y;
  }
  /** Crew closer than a body width on the same level: whoever is walking steps aside (both halve it when both walk),
   *  never into a wall. Pure in this frame's samples (every page draws the same). */
  private separate() {
    const k = (this.cfg.height ?? 1.25) / 1.25, min = 0.42 * k;
    const loco = (c: string) => c === 'walk' || c === 'run' || c.startsWith('carry');
    const free = (p: THREE.Vector3, dx: number, dz: number, far: number) => (this.probe ? this.probe.free(tv3.set(p.x, p.y + 0.5 * k, p.z), dx, dz, far + 0.2) - 0.2 : far);
    const ok = (s: Sample | null): s is Sample => !!s && !s.hidden && !s.air && !s.ladder && !s.frame;
    for (let a = 0; a < this.crew.length; a++) for (let b = a + 1; b < this.crew.length; b++) {
      const A = this.crew[a].s, B = this.crew[b].s;
      if (!ok(A) || !ok(B) || Math.abs(A.pos.y - B.pos.y) > 0.4) continue;
      const la = loco(A.clip), lb = loco(B.clip);
      if (!la && !lb) continue;
      const dx = B.pos.x - A.pos.x, dz = B.pos.z - A.pos.z, d = Math.hypot(dx, dz);
      if (d >= min) continue;
      const ux = d > 1e-4 ? dx / d : (a % 2 ? 1 : -1), uz = d > 1e-4 ? dz / d : 0;
      const push = Math.min(0.25, min - d), wa = la && lb ? 0.5 : la ? 1 : 0;
      if (wa > 0) { const st = Math.max(0, Math.min(push * wa, free(A.pos, -ux, -uz, push * wa))); A.pos.x -= ux * st; A.pos.z -= uz * st; }
      if (wa < 1) { const st = Math.max(0, Math.min(push * (1 - wa), free(B.pos, ux, uz, push * (1 - wa)))); B.pos.x += ux * st; B.pos.z += uz * st; }
    }
  }
  /** The galley cook (SPEC 1.5): one crew unit at GALLEY_COOK (or crew.cook [x, y, z, yawDeg]) in the galley area, a
   *  closed loop of wiping the counter, stirring / slicing, a taste and a laugh; no deck crew there. */
  private attachCook(rt: SceneRuntime) {
    const a = (() => { let o: THREE.Object3D | undefined; rt.root.traverse((n) => { if (!o && n.name === 'GALLEY_COOK') o = n; }); return o; })();
    const c = this.cfg.cook;
    if (!a && !c) { this.rt = null; return; }
    rt.root.updateMatrixWorld(true);
    const pos = a ? rt.root.worldToLocal(a.getWorldPosition(new THREE.Vector3())) : new THREE.Vector3(c![0], c![1], c![2]);
    let yaw = c ? THREE.MathUtils.degToRad(c[3] ?? 0) : 0;
    if (a) { const f = new THREE.Vector3(0, 0, 1).applyQuaternion(a.getWorldQuaternion(new THREE.Quaternion())); yaw = Math.atan2(f.x, f.z); }
    this.cook = true;
    this.cfg = { ...this.cfg, count: 1 };
    const deck = presetDeck(pos.y - 5);
    deck.spots.set('GALLEY_COOK', { name: 'GALLEY_COOK', pos: pos.clone(), yaw });
    this.deck = { ...deck, guns: [], repairs: [], helmCrate: null, wheel: null };
    try {
      const meshes = probeMeshes(rt.room.root, hideList(rt));
      if (meshes.length) this.probe = new RoomDeckProbe(meshes, rt.root);
    } catch { /* no footing */ }
    this.group = new THREE.Group(); this.group.name = 'vtp:crew';
    rt.root.add(this.group);
    const tb = new TB(0, pos.clone(), yaw);
    tb.hold(6.6, 'polish'); tb.hold(2.0, 'ual_interact'); tb.hold(1.33, 'ual_consume'); tb.hold(1.4, 'laugh'); tb.hold(4.2, 'idle_b'); tb.hold(4.8, 'polish', { rate: 1.4 });
    const period = Math.ceil(tb.t);
    tb.until(period, 'idle_b');
    this.ctx = { deck: this.deck, cfg: this.cfg, seed: hash32(rt.info.id, 'cook'), gunYaw: () => 0 };
    this.cruise = [{ track: { segs: tb.segs, overlays: [] }, period, offset: (hash32(rt.info.id, 'cookT') % 1000) / 100, home: { name: 'GALLEY_COOK', pos, yaw }, homeClip: 'idle_b' }];
    this.fx = new CrewFx();
    this.group.add(this.fx.group);
    void this.load();
  }
  private steps: { mesh: THREE.Mesh; gun: string }[] = [];
  private cook = false;

  private protectFaces(cam: THREE.PerspectiveCamera) {
    const rt = this.rt!;
    cam.updateMatrixWorld();
    const rects: (Rect & { depth?: number })[] = [];
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const sr = this.cfg.faceGuard?.screenR ?? 0.14;
    if (this.protect) for (const a of rt.actors.values()) {
      if (!a.shown || !a.spot) continue;
      const f = a.faceAt(a.spot);
      if (!f) continue;
      const d = cam.position.distanceTo(f.center);
      tv.copy(f.center).project(cam);
      if (tv.z > 1) continue;
      const r = Math.max(sr * 0.5, (f.size * 1.8) / (d * tanH) / 2);
      const x = (tv.x + 1) / 2, y = (1 - tv.y) / 2;
      rects.push({ x0: x - r / cam.aspect, x1: x + r / cam.aspect, y0: y - r * 1.1, y1: y + r * 1.25, depth: d });
    }
    const crewRects = rects.slice();
    if (this.protect && rt.state.mode === 'react') {
      const r = rt.layout() === 'solo' ? rt.solo?.rect(cam) : rt.screen?.rect(cam);
      if (r) crewRects.push({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
    }
    if (this.fx) this.fx.faceRects = rects;
    for (const m of this.crew) {
      m.protect = 1;
      const s = m.s;
      if (!s) continue;
      // never a body right in front of the lens
      if (Math.hypot(s.pos.x - cam.position.x, s.pos.z - cam.position.z) < 1.4 * this.scale && Math.abs(s.pos.y + 0.6 - cam.position.y) < 1.6) { m.protect = -1; continue; }
      if (!crewRects.length || !this.protect) continue;
      // the whole crew member: feet, the head joint and the top of the puppet head (+ hat) above HeadTop
      const head = m.npc.headWorld(tv).clone();
      const top = m.npc.headTopWorld(tv2).clone();
      top.y += (0.36 + (m.hat ? 0.26 : 0.06)) * this.scale;
      const v = guardVerdict(crewScreenRect(cam, s.pos, head, top, 0.34 * this.scale), crewRects);
      this.guardLog[m.i] = v;
      if (v === 'hide') m.protect = -1;
      else if (v === 'fade') m.protect = 0;
    }
  }
  /** last face-guard verdict per crew member (tests) */
  private guardLog: string[] = [];

  // ------------------------------------------------------------------------------------------ status
  info() {
    const now = this.now();
    const ph = this.phase(now);
    return {
      on: !!this.rt, room: this.rt?.info.id ?? null, ready: !!this.assets && this.crew.length > 0, loading: this.loadingGen >= 0, error: this.error || undefined,
      deck: this.deck ? {
        source: this.deck.source, nav: this.deck.nav.length, guns: this.deck.guns.map((g) => g.id), wheel: !!this.wheel, turrets: [...this.turrets.keys()],
        ground: this.deck.ground, helmCrate: this.deck.helmCrate ? +this.deck.helmCrate.h.toFixed(2) : 0, repairs: this.deck.repairs.length,
        gangways: [this.deck.gangways.port ? 'P' : '', this.deck.gangways.starboard ? 'S' : ''].join(''), notes: this.deck.notes,
        fit: this.fit ? { ms: this.fit.ms, wallMs: this.fit.wall, slices: this.fit.slices, worstStepMs: this.fit.worst, worstStepIn: this.fit.worstIn, meshes: this.fit.meshes, tris: this.fit.tris, moved: this.fit.report.moved, points: this.fit.report.points, maxDy: +this.fit.report.maxDy.toFixed(3), maxPush: +this.fit.report.maxPush.toFixed(3), noFloor: this.fit.report.noFloor } : null,
      } : null,
      phase: ph.phase, episode: ph.episode,
      episodes: this.eps.map((e) => ({ id: e.id, kind: e.kind, in: +((e.start - now) / 1000).toFixed(1), allAboard: e.allAboard, variant: e.variant, repairs: e.repairs.length, shots: e.shots.length })),
      crew: this.crew.map((m) => ({ i: m.i, role: m.role, clip: m.s?.clip ?? null, dyn: m.s?.dyn, held: m.s?.held, lod: m.npc.lod, px: Math.round(m.px), fade: +m.fade.toFixed(2), guard: this.guardLog[m.i] ?? 'ok', pos: m.s ? m.s.pos.toArray().map((x) => +x.toFixed(2)) : null })),
      lods: [0, 1, 2, 3].map((l) => this.crew.filter((m) => m.npc.lod === l).length),
      fx: this.fx?.counts ?? null,
      perf: { avgMs: +this.perf.avg.toFixed(3), peakMs: +this.perf.peak.toFixed(3), planMs: +this.perf.plan.toFixed(2) },
      hash: this.ctx ? stateHash(this.ctx, this.cruise, this.eps, now) : 0,
    };
  }
  debug() { const i = this.info(); console.table(i.crew); return i; }
  /** Test pages: where everyone stands at each wall ms vs the room's geometry (the deck fit's probe): floor offset of
   *  the feet (+ = floating), the nearest wall / rail at shin and waist height, show-floor keep-out entries. Crew in the
   *  air, on a ladder or on the sand are skipped for the floor test. */
  audit(times: number[]) {
    const ctx = this.ctx, deck = this.deck, probe = this.probe;
    if (!ctx || !deck) return null;
    const rows: { ms: number; i: number; clip: string; pos: number[]; dy: number | null; free: number; keepout: boolean }[] = [];
    for (const ms of times.slice(0, 2000)) for (let i = 0; i < this.cruise.length; i++) {
      const ep = activeEpisode(this.eps, i, ms);
      const s = ep ? sampleTrack(ep.tracks[i], (ms - ep.start) / 1000, framesFor(ctx, ep.start)) : sampleTrack(this.cruise[i].track, cruiseTime(this.cruise[i], ms), framesFor(ctx, ms - cruiseTime(this.cruise[i], ms) * 1000));
      if (!s || s.hidden) continue;
      const onSand = s.pos.y < deck.ground + 0.6;
      let dy: number | null = null, free = Infinity;
      if (probe && !s.air && !s.ladder && !onSand) {
        const f = probe.floors(s.pos.x, s.pos.z, s.pos.y + 0.6, s.pos.y - 0.9);
        dy = f.length ? +(s.pos.y - f[0]).toFixed(3) : null;
        for (const h of [0.25, 0.7]) for (let k = 0; k < 8; k++) free = Math.min(free, probe.free(new THREE.Vector3(s.pos.x, s.pos.y + h, s.pos.z), Math.sin(k * Math.PI / 4), Math.cos(k * Math.PI / 4), 1));
      }
      rows.push({ ms, i, clip: s.clip, pos: s.pos.toArray().map((x) => +x.toFixed(3)), dy, free: Number.isFinite(free) ? +free.toFixed(3) : 9, keepout: !!deck.keepout?.containsPoint(s.pos) && !onSand });
    }
    return rows;
  }
  /** The planned episodes (tests / the voyage's timeline view). */
  episodes() { return this.eps; }
}

const ep = (eps: CrewEpisode[], i: number, ms: number) => activeEpisode(eps, i, ms);
