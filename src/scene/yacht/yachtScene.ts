// Yacht life engine (docs/SCENES.md → "Yacht life") — rooms whose scene.json has a `yacht` key (first user: sc_890jump,
// the Origin 890 Jump "ASTRAEA" over Crusader). Crew (yachtCrew.ts), ships + space effects (yachtSky.ts) and the
// champagne pop (yachtFx.ts), orchestrated from:
//   · the wall clock (ambient: walkers, the bartender, flybys, the patrol, skirmishes, storm lightning — yachtAmbient)
//   · support events from the chat feed (ChatEvent ts + id → tiers → yachtSchedule: identical on every page)
//   · the host's bag SceneState.modes.yacht (toggles, thresholds, the latest test / bus event `ev`)
// No Math.random anywhere visible; a page opened mid-event lands mid-event.
// Never in front of the show: crew fade while they would cover a performer's face or the React screen; space effects
// dim behind faces; the fleet cutaway (CAM_EXTERIOR, 6 s) only in Talk mode, through SceneRuntime.cameraOverride
// (wrapping whatever was there before, like the kitchen riot cam).
// Cost: rooms without `yacht` → one check per frame.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { sceneFileUrl } from '../SceneRuntime.ts';
import type { CamPose } from '../cameraRig.ts';
import { RoomRays } from '../twoShot.ts';
import { gfxBudget } from '../../stage/gfx/lod.ts';
import type { ShipMeta } from '../traffic/config.ts';
import { HOST_KEY } from '../../../shared/scene.ts';
import { raidDonationValue } from '../../../shared/raid.ts';
import {
  DEFAULT_YACHT_AMBIENT, YACHT_BAG, yachtAmbient, YACHT_DUR, YACHT_KINDS, YACHT_LEAD, YACHT_OFFSET, isYachtKind, sanitizeYacht, yachtHash, yachtSchedule, yachtThresholds, yachtTiers,
  type RoomYachtConfig, type YachtBag, type YachtEventIn, type YachtItem, type YachtKind,
} from '../../../shared/yacht.ts';
import { yachtRoomOf, type YachtRoom } from './yachtRoom.ts';
import { YachtCrew, type DrinkPlan } from './yachtCrew.ts';
import { YachtSky, type SkyView } from './yachtSky.ts';
import { CHAMPAGNE_DUR, YachtRoomFx } from './yachtFx.ts';

const FALLBACK_ROOM = 'sc_area18';
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3();
const tmpCam = new THREE.PerspectiveCamera();

interface Support { id: string; ts: number; usd: number; raid: boolean; user: string }

const PLANET_TURN = 5400;      // s per full turn of the cloud texture (90 min: a low orbit)
const STAR_TURN = 5400;        // s per turn of the star dome
const DRIFT_AX = new THREE.Vector3(1, 0, 0);
const DRIFT_Q = new THREE.Quaternion();

export class YachtScene {
  private rt: SceneRuntime | null = null;
  private cfg: RoomYachtConfig | null = null;
  private room: YachtRoom | null = null;
  private group = new THREE.Group();
  private crew: YachtCrew | null = null;
  private sky: YachtSky | null = null;
  private fx: YachtRoomFx | null = null;
  private rays: RoomRays | null = null;
  private gen = 0;
  private seed = 0;
  private support: Support[] = [];
  private tests: YachtEventIn[] = [];
  private bagSrc: unknown = undefined;
  private bag: YachtBag = sanitizeYacht({});
  private sched: { key: string; items: YachtItem[] } = { key: '', items: [] };
  private views = new Map<string, { v: SkyView; seen: number }>();
  private cur: { key: string; v: SkyView | null; at: number } = { key: '', v: null, at: -1 };
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  private cut: { key: string; pose: CamPose; from: number; to: number } | null = null;
  private protectT = 0;
  private frame = 0;
  private perf = { avg: 0, peak: 0 };
  private host: { pos: THREE.Vector3; fwd: THREE.Vector3; spot: number; face: THREE.Vector3 | null } | null = null;
  private plan: DrinkPlan | null = null;
  private drinks: { it: YachtItem; plan: DrinkPlan }[] = [];
  private notes: string[] = [];
  /** a config injected by a test page (vtpOut.yacht.debugConfig) — replaces the room's `yacht` key */
  private debugCfg: RoomYachtConfig | null = null;
  private lastRt: SceneRuntime | null = null;
  private origin = new THREE.Vector3();
  private amb: Record<keyof typeof DEFAULT_YACHT_AMBIENT, number> = { ...DEFAULT_YACHT_AMBIENT };
  protect = true;
  /** Orbital drift (a pure function of the wall clock, identical on every page): Crusader's cloud bands creep along
   *  (texture offset, one full turn per PLANET_TURN s) and the star dome turns about the ship's lateral axis (one turn
   *  per STAR_TURN s) — the slow "we are in orbit" motion through the windows. */
  private drift: { maps: { tex: THREE.Texture; x: number }[]; stars: { o: THREE.Object3D; q: THREE.Quaternion }[] } = { maps: [], stars: [] };
  /** Test pages: time advances only through update(). ms */
  manual = false;
  clock = Date.now();
  now() { return this.manual ? this.clock : Date.now(); }

  // ------------------------------------------------------------------------------------------ lifecycle
  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.lastRt = rt;
    const cfg = this.debugCfg ?? (rt.info as unknown as { yacht?: RoomYachtConfig }).yacht ?? (this.demoOn ? demoConfig(rt) : null);
    if (!cfg || typeof cfg !== 'object') return;               // not a yacht room: nothing at all
    this.rt = rt; this.cfg = cfg;
    this.room = yachtRoomOf(rt.room.root, rt.room.cameras, cfg);
    this.drift = { maps: [], stars: [] };
    rt.room.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if ((o as THREE.Mesh).isMesh && m && !Array.isArray(m) && m.name === 'EMIT_sky_planet' && m.map && !this.drift.maps.some((d) => d.tex === m.map)) {
        m.map.wrapS = THREE.RepeatWrapping; m.map.needsUpdate = true;
        this.drift.maps.push({ tex: m.map, x: m.map.offset.x });
      }
      if (/SKY_STARS/.test(o.name) && !this.drift.stars.some((d) => d.o === o)) this.drift.stars.push({ o, q: o.quaternion.clone() });
    });
    this.seed = cfg.seed ?? yachtHash(rt.info.id.split('~')[0]);
    this.amb = { ...DEFAULT_YACHT_AMBIENT, ...(cfg.ambient ?? {}) };
    this.origin.copy(rt.room.spots.find((s) => s)?.position ?? rt.room.bounds.getCenter(new THREE.Vector3()));
    this.group = new THREE.Group(); this.group.name = 'vtp:yacht';
    rt.root.add(this.group);
    this.crew = new YachtCrew(this.room, cfg);
    this.sky = new YachtSky(this.room);
    this.fx = new YachtRoomFx();
    this.group.add(this.crew.group, this.sky.group, this.fx.group);
    try { this.rays = new RoomRays(rt.room); } catch { this.rays = null; }
    const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
    const prev = hook.cameraOverride;
    this.prevOverride = prev;
    // (each closure keeps its own `prev`: a stale one — after a re-attach under engines that wrapped us — just passes through)
    const mine: SceneRuntime['cameraOverride'] = (aspect: number) => (this.myOverride === mine ? this.shot() : null) ?? prev?.(aspect) ?? null;
    this.myOverride = mine;
    hook.cameraOverride = mine;
    const gen = ++this.gen;
    void this.load(rt, cfg, gen);
  }

  detach() {
    this.gen++;
    const rt = this.rt;
    if (rt) {
      const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
      if (hook.cameraOverride === this.myOverride) hook.cameraOverride = this.prevOverride;
    }
    for (const d of this.drift.maps) d.tex.offset.x = d.x;
    for (const d of this.drift.stars) d.o.quaternion.copy(d.q);
    this.drift = { maps: [], stars: [] };
    this.crew?.dispose(); this.crew = null;
    this.sky?.dispose(); this.sky = null;
    this.fx?.dispose(); this.fx = null;
    for (const o of this.room?.debugNodes ?? []) o.removeFromParent();
    this.group.removeFromParent();
    this.rt = null; this.cfg = null; this.room = null; this.rays = null; this.plan = null; this.host = null;
    this.prevOverride = null; this.myOverride = null; this.cut = null;
    this.views.clear(); this.cur = { key: '', v: null, at: -1 }; this.sched = { key: '', items: [] }; this.drinks = [];
  }

  private async fileOk(url: string) { const ac = new AbortController(); try { const r = await fetch(url, { signal: ac.signal }); ac.abort(); return r.ok; } catch { return false; } }

  private async load(rt: SceneRuntime, cfg: RoomYachtConfig, gen: number) {
    const alive = () => gen === this.gen && this.rt === rt;
    const id = rt.info.id;
    // ('@<room>/<file>' = another room's file: test configs borrowing a room's assets)
    const file = (rel: string) => { const m = /^@([a-z0-9][a-z0-9_-]{0,47})\/(.+)$/.exec(rel); return m ? sceneFileUrl(m[1], m[2]) : sceneFileUrl(id, rel); };
    // the room's own crew / fleet, else Area 18's patrons / traffic ships (same formats) until the room ships its own
    const unitsOwn = file(cfg.units ?? 'npc/crew_units.glb');
    const units = (await this.fileOk(unitsOwn)) ? unitsOwn : (this.notes.push('crew: using sc_area18 patrons'), sceneFileUrl(FALLBACK_ROOM, 'patrons/patron_units.glb'));
    let fleetGlb = file(cfg.fleet ?? 'fleet/ships.glb'), fleetMeta = file(cfg.fleetMeta ?? 'fleet/ships.json');
    if (!(await this.fileOk(fleetGlb)) || !(await this.fileOk(fleetMeta))) {
      this.notes.push('fleet: using sc_area18 traffic ships');
      fleetGlb = sceneFileUrl(FALLBACK_ROOM, 'traffic/ships.glb'); fleetMeta = sceneFileUrl(FALLBACK_ROOM, 'traffic/ships.json');
    }
    if (!alive()) return;
    const root = rt.room.root;
    root.updateMatrixWorld(true);
    const toWorld = (p: THREE.Vector3) => root.localToWorld(p);
    const jobs: Promise<unknown>[] = [
      this.crew!.load(units, units, toWorld, alive),
      this.fx!.load(alive),
      (async () => {
        const meta = ((await (await fetch(fleetMeta)).json()) as { ships: ShipMeta[] }).ships ?? [];
        if (!alive()) return;
        await this.sky!.load(fleetGlb, meta);
      })().catch((e) => { this.notes.push(`fleet failed: ${e}`); }),
    ];
    await Promise.all(jobs);
    if (!alive()) return;
    this.warm(rt);
  }

  /** Compile every shader once in the background (ships, NPC fades, props, effects): no hitch on the first event. */
  private warm(rt: SceneRuntime) {
    const sky = this.sky, crew = this.crew;
    // make every variant exist for one compile: one ship of each kind, NPCs both opaque + fading, the props shown
    const far = tv.copy(rt.stage.camera.position).add(tv2.set(0, -1e4, 0));
    const poses = sky?.ready ? [...sky.fleet.templates.keys()].slice(0, 20).map((ship, i) => ({ key: `warm${i}`, ship, pos: far.clone().add(new THREE.Vector3(i * 300, 0, 0)), quat: new THREE.Quaternion(), gear: 0, thrust: 1, phase: 'cruise' as const, landing: 0 })) : [];
    if (sky?.ready) sky.fleet.update(poses, 0.7, 0, rt.stage.camera, 720);
    const shown: THREE.Object3D[] = [];
    this.group.traverse((o) => { if (!o.visible) { o.visible = true; shown.push(o); } });
    const npcMats: THREE.MeshToonMaterial[] = [];
    crew?.group.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshToonMaterial | undefined; if (m?.isMeshToonMaterial && m.name === 'vtp:town:npc') npcMats.push(m); });
    npcMats.forEach((m, i) => { m.transparent = i % 2 === 1; m.needsUpdate = true; });
    const r = rt.stage.renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> };
    const done = () => {
      for (const o of shown) o.visible = false;
      for (const m of npcMats) { m.transparent = false; m.needsUpdate = true; }
      if (sky?.ready) sky.fleet.update([], 0.7, 0, rt.stage.camera, 720);
    };
    try {
      const p = r.compileAsync ? r.compileAsync(this.group, rt.stage.camera, rt.stage.scene) : Promise.resolve(r.compile(this.group, rt.stage.camera, rt.stage.scene));
      void p.catch(() => {}).finally(done);
    } catch { done(); }
  }

  // ------------------------------------------------------------------------------------------ inputs
  /** Chat feed → support events (finance). snap = catch-up history: kept only while its show could still be running. */
  onSupport(evs: { kind?: string; fkind?: string; ts?: number; id?: string; user?: string; usd?: number; approxUsd?: number; amount?: number }[], snap: boolean) {
    const now = Date.now();
    for (const e of evs) {
      if (e.kind !== 'finance' || typeof e.ts !== 'number' || !Number.isFinite(e.ts)) continue;
      const id = String(e.id ?? e.ts);
      if (snap && now - e.ts > 4 * 60_000) continue;
      if (Math.abs(now - e.ts) > 6 * 3600_000) continue;
      if (this.support.some((s) => s.id === id)) continue;
      this.support.push({ id, ts: e.ts, usd: raidDonationValue(e), raid: e.fkind === 'raid', user: String(e.user ?? '').slice(0, 32) });
    }
    this.support.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    if (this.support.length > 80) this.support.splice(0, this.support.length - 80);
  }

  /** Tests (this page only): an event of `kind` in `inSec` seconds (kind 'support:<usd>' = a support event of that value). */
  test(kind: YachtKind | `support:${number}` | 'raid' = 'fireworks', inSec = 1, user = 'TestViewer') {
    const at = this.now() + inSec * 1000;
    const n = this.tests.length + this.support.length;
    if (typeof kind === 'string' && kind.startsWith('support:')) { this.support.push({ id: `test-sup-${n}-${at}`, ts: at - YACHT_LEAD, usd: parseFloat(kind.slice(8)) || 5, raid: false, user }); return; }
    if (kind === 'raid') { this.support.push({ id: `test-raid-${n}-${at}`, ts: at - YACHT_LEAD, usd: 0, raid: true, user }); return; }
    if (!isYachtKind(kind)) return;
    this.tests.push({ id: `test-${kind}-${n}-${at}`, at, kind, seed: yachtHash(kind, at), user });
  }

  private demoOn = false;
  /** Test pages (&yachtCfg=demo): rooms without a `yacht` key get a generated demo config (fake anchors). */
  get demo() { return this.demoOn; }
  set demo(v: boolean) { this.demoOn = v; if (v && !this.rt && this.lastRt) this.attach(this.lastRt); }

  /** Test pages: replace the room's `yacht` config (fake anchors in `debugAnchors`) and re-attach. null = the room's own;
   *  'demo' = generated from the room's cameras / spots. */
  debugConfig(cfg: RoomYachtConfig | 'demo' | null) {
    const r0 = this.rt ?? this.lastRt;
    if (cfg === 'demo') { if (!r0) return 'no room loaded'; cfg = demoConfig(r0); }
    this.debugCfg = cfg;
    const rt = this.rt ?? this.lastRt;
    if (!rt) return 'no room loaded';
    this.detach();
    this.attach(rt);
    return this.rt ? 'attached' : 'no config';
  }

  private readBag(rt: SceneRuntime) {
    const src = (rt.state.modes ?? {})[YACHT_BAG];
    if (src !== this.bagSrc) { this.bagSrc = src; this.bag = sanitizeYacht(src); }
    return this.bag;
  }

  /** support + bag + test events → the schedule (recomputed only when an input changes) */
  private schedule(bag: YachtBag, drinkDur: number): YachtItem[] {
    const thr = yachtThresholds(bag, this.cfg);
    const last = this.support[this.support.length - 1];
    const key = `${this.support.length}|${last?.id ?? ''}|${bag.ev?.seq ?? -1}|${bag.ev?.at ?? 0}|${this.tests.length}|${bag.support.on}|${bag.support.raids}|${YACHT_KINDS.map((k) => thr[k]).join(',')}|${drinkDur.toFixed(1)}`;
    if (key === this.sched.key) return this.sched.items;
    const evs: YachtEventIn[] = [];
    if (bag.support.on) for (const s of this.support) {
      if (s.raid && !bag.support.raids) continue;
      for (const k of yachtTiers(s.usd, thr, s.raid)) evs.push({ id: `${s.id}:${k}`, at: s.ts + YACHT_LEAD + YACHT_OFFSET[k], kind: k, seed: yachtHash(s.id, k), user: s.user });
    }
    if (bag.ev) evs.push({ id: `ev:${bag.ev.seq}:${bag.ev.at}`, at: bag.ev.at, kind: bag.ev.kind, seed: bag.ev.seed, user: bag.ev.user });
    evs.push(...this.tests);
    const dur = { ...YACHT_DUR, drink: drinkDur * 1000 };
    this.sched = { key, items: yachtSchedule(evs, dur) };
    return this.sched.items;
  }

  // ------------------------------------------------------------------------------------------ the show volume
  /** The YACHT_SKY anchor best in view of a camera pose (the state camera → the same on every page). */
  private viewFrom(pose: CamPose, aspect: number): SkyView | null {
    const R = this.room!;
    tmpCam.fov = pose.fov; tmpCam.aspect = aspect; tmpCam.near = 0.1; tmpCam.far = 1e6;
    tmpCam.position.copy(pose.position); tmpCam.quaternion.copy(pose.quaternion);
    tmpCam.updateProjectionMatrix(); tmpCam.updateMatrixWorld(true);
    let best = -1, bestS = -Infinity;
    R.sky.forEach((s, i) => {
      tv.copy(s.pos).project(tmpCam);
      if (tv.z > 1 || tv.z < -1) { return; }
      const m = Math.max(Math.abs(tv.x), Math.abs(tv.y));
      const score = (m < 0.9 ? 1 : 0) - m * 0.5 + (tv.y > -0.2 ? 0.1 : 0);
      if (score > bestS) { bestS = score; best = i; }
    });
    const fwd = tv2.set(0, 0, -1).applyQuaternion(pose.quaternion);
    let P: THREE.Vector3, size = 70, d: number;
    if (best >= 0) { P = R.sky[best].pos; size = R.sky[best].size; }
    else if (R.sky.length) {
      // none in the frame: the one closest to the view direction
      let bd = -2;
      R.sky.forEach((s, i) => { const c = tv.copy(s.pos).sub(pose.position).normalize().dot(fwd); if (c > bd) { bd = c; best = i; } });
      P = R.sky[best].pos; size = R.sky[best].size;
    } else P = tv.copy(pose.position).addScaledVector(fwd, 160);
    const D = P.clone().sub(pose.position);
    d = Math.max(20, D.length()); D.normalize();
    const Rt = new THREE.Vector3().crossVectors(D, new THREE.Vector3(0, 1, 0));
    if (Rt.lengthSq() < 1e-6) Rt.set(1, 0, 0);
    Rt.normalize();
    const U = new THREE.Vector3().crossVectors(Rt, D).normalize();
    const tanH = Math.tan(THREE.MathUtils.degToRad(pose.fov) / 2) * aspect;
    const CR = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion), CU = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
    return { C: pose.position.clone(), D, R: Rt, U, d, size, tanH, anchor: best, F: fwd.clone(), CR, CU, tanV: Math.tan(THREE.MathUtils.degToRad(pose.fov) / 2), aspect };
  }

  private currentView(t: number): SkyView | null {
    const rt = this.rt!;
    // (the state camera, not the live one: a walk-in follow cam or our own cutaway must not move the show)
    if (t - this.cur.at < 1 && this.cur.at >= 0) return this.cur.v;
    const aspect = rt.stage.camera.aspect || 16 / 9;
    const { key, pose } = rt.resolveCamera(rt.state.camera, aspect);
    const k = `${key}|${aspect.toFixed(3)}|${pose.position.x.toFixed(2)},${pose.position.y.toFixed(2)},${pose.position.z.toFixed(2)}`;
    if (k !== this.cur.key) this.cur = { key: k, v: this.viewFrom(pose, aspect), at: t };
    else this.cur.at = t;
    return this.cur.v;
  }
  /** a view locked for one act (its first frame decides): camera changes mid-act never teleport it */
  private lockedView(key: string, t: number): SkyView | null {
    const hit = this.views.get(key);
    if (hit) { hit.seen = this.frame; return hit.v; }
    const v = this.currentView(t);
    if (v) this.views.set(key, { v, seen: this.frame });
    return v;
  }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number) {
    const rt = this.rt;
    if (!rt) return;
    const t0 = performance.now();
    if (this.manual) this.clock += dt * 1000;
    this.frame++;
    const nowMs = this.now(), t = nowMs / 1000;
    // orbital drift (runs whether or not the crew / events are on)
    for (const d of this.drift.maps) d.tex.offset.x = d.x + ((t / PLANET_TURN) % 1);
    if (this.drift.stars.length) {
      DRIFT_Q.setFromAxisAngle(DRIFT_AX, ((t / STAR_TURN) % 1) * Math.PI * 2);
      for (const d of this.drift.stars) d.o.quaternion.copy(d.q).multiply(DRIFT_Q);
    }
    const bag = this.readBag(rt);
    this.group.visible = bag.on;
    if (!bag.on || !this.crew || !this.sky || !this.fx) return;
    const cam = rt.stage.camera;
    const H = rt.stage.renderer.domElement.height || 1080;
    // the host (the drinks go to them)
    const a = rt.actors.get(HOST_KEY) ?? [...rt.actors.values()].find((x) => x.shown && x.spot) ?? null;
    if (a?.spot) {
      const sp = a.spot;
      if (!this.host || this.host.spot !== sp.index || !this.host.pos.equals(sp.position)) {
        const f = a.faceAt(sp);
        this.host = { pos: sp.position.clone(), fwd: sp.forward.clone(), spot: sp.index, face: f ? f.center.clone() : null };
        this.plan = null;
      }
    }
    if (!this.plan && this.host && this.crew.ready) this.plan = this.crew.planDrink(this.host, this.rays);
    const drinkDur = this.plan ? this.plan.durClear : YACHT_DUR.drink / 1000;
    const items = this.schedule(bag, drinkDur);
    // what is running (items are few; lanes never grow past ~40)
    this.drinks.length = 0;
    let pourAt: number | null = null;
    let champ: YachtItem | null = null;
    const sky = this.sky;
    sky.begin(t);
    this.fx.begin(t);
    const V = this.currentView(t);
    const H2 = rt.stage.renderer.domElement.height || 720;
    // ambient
    const amb = this.amb;
    if (sky.ready) {
      if (bag.lightning) sky.lightning(nowMs, amb.lightning, this.seed);
      if (bag.ships) {
        sky.patrol(t, amb.patrol, this.origin);
        sky.ambientFlyby(t, Math.max(20, amb.flyby), this.seed, (k) => this.lockedView(k, t));
      }
      if (bag.skirmish) {
        const sk = sky.skirmish(t, Math.max(40, amb.skirmish), this.seed, V);
        void sk;
      }
    }
    let cutFrom = 0, cutF: THREE.Vector3 | null = null;
    for (const it of items) {
      const s = it.start / 1000, e = it.end / 1000;
      if (it.kind === 'drink') {
        if (this.plan && t >= s - 1 && s < t + 600) this.drinks.push({ it, plan: this.plan });
        continue;
      }
      if (t < s - 1.5 || t > e + 0.5) continue;
      if (it.kind === 'champagne') { champ = it; continue; }
      if (!sky.ready) continue;
      const v = this.lockedView(`ev:${it.id}`, t);
      if (!v) continue;
      if (it.kind === 'fireworks') sky.fireworks(it, t, v);
      else if (it.kind === 'flyby') sky.flyby(it, t, v);
      else if (it.kind === 'fleet') {
        const F = tv.set(0, 0, 0);
        const r = sky.fleetEvent(it, t, v, F);
        if (r && bag.cutaway) { cutFrom = r.capitalAt; cutF = F; this.planCut(it, cutFrom, F); }
      }
    }
    if (!cutF) this.cut = null;
    // champagne: at the host's table when it is next to the host, else on the bar
    if (champ) {
      const R = this.room!;
      const near = this.plan?.anchor && this.host && Math.hypot(this.plan.anchor.x - this.host.pos.x, this.plan.anchor.z - this.host.pos.z) < 2.5 ? this.plan.anchor : null;
      const at = near ? tv.copy(near).add(this.plan!.slots.length > 2 ? tv2.copy(this.plan!.slots[2]).sub(near).multiplyScalar(-2.2) : tv2.set(0.18, 0, 0)) : R.pour ? tv.copy(R.pour) : R.bar ? tv.copy(R.bar.pos).addScaledVector(R.bar.fwd, -0.55).setY(R.bar.pos.y + 1.05) : null;
      if (!near) pourAt = champ.start / 1000 + 1.0;
      if (at) {
        const away = tv2.set(at.x - (this.host?.pos.x ?? at.x - 1), 0, at.z - (this.host?.pos.z ?? at.z));
        if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
        away.normalize();
        this.fx.champagne(champ, t, at, away, this.crew.props?.bottle ?? null, cam);
      }
    } else if (this.crew.props) this.crew.props.bottle.visible = false;
    // the crew
    this.protectT -= dt;
    if (this.protectT <= 0) { this.protectT = 0.25; this.protectFaces(cam, H); }
    const faces: THREE.Vector3[] = [];
    for (const x of rt.actors.values()) { if (!x.shown || !x.spot) continue; const f = x.faceAt(x.spot); if (f) faces.push(f.center); }
    this.crew.update(t, dt, cam, gfxBudget().lodBias ?? 1, bag.crew, this.drinks, pourAt, faces);
    sky.end(t, cam, H2);
    this.fx.end(cam, H2);
    for (const [k, v] of this.views) if (this.frame - v.seen > 120) this.views.delete(k);
    const ms = performance.now() - t0;
    this.perf.avg += (ms - this.perf.avg) * 0.05;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  // ------------------------------------------------------------------------------------------ the fleet cutaway (Talk only)
  private planCut(it: YachtItem, capitalAt: number, F: THREE.Vector3) {
    const rt = this.rt!, R = this.room!;
    const key = `yacht:${it.id}`;
    if (this.cut?.key === key) return;
    this.cut = null;
    if (!R.exteriors.length) return;
    const aspect = rt.stage.camera.aspect || 16 / 9;
    let best: string | null = null, bs = 0.85;
    for (const n of R.exteriors) {
      const c = rt.room.cameras.get(n);
      if (!c) continue;
      tmpCam.fov = c.fov; tmpCam.aspect = aspect; tmpCam.near = 0.1; tmpCam.far = 1e6;
      tmpCam.position.copy(c.position); tmpCam.quaternion.copy(c.quaternion); tmpCam.updateProjectionMatrix(); tmpCam.updateMatrixWorld(true);
      tv2.copy(F).project(tmpCam);
      if (tv2.z > 1) continue;
      const m = Math.max(Math.abs(tv2.x), Math.abs(tv2.y));
      if (m < bs) { bs = m; best = n; }
    }
    if (!best) return;
    const c = rt.room.cameras.get(best)!;
    this.cut = { key, pose: { position: c.position.clone(), quaternion: c.quaternion.clone(), fov: c.fov }, from: capitalAt - 1.2, to: capitalAt + 4.8 };
  }

  private shot(): { key: string; pose: CamPose; secs: number } | null {
    const rt = this.rt, c = this.cut;
    if (!rt || !c || !this.bag.on || !this.bag.cutaway) return null;
    if (rt.state.mode !== 'talk') return null;                    // never in React / Gaming / Interview / other stage modes
    const t = this.now() / 1000;
    if (t < c.from || t > c.to) return null;
    return { key: c.key, pose: c.pose, secs: 0 };
  }

  // ------------------------------------------------------------------------------------------ never in front of the show
  private protectFaces(cam: THREE.PerspectiveCamera, H: number) {
    const rt = this.rt!;
    cam.updateMatrixWorld();
    const rects: { x0: number; y0: number; x1: number; y1: number; d: number }[] = [];
    const W = rt.stage.renderer.domElement.width || 1920;
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const U = this.sky?.fx.uniforms as unknown as { uFaces: { value: THREE.Vector4[] }; uFaceN: { value: number } } | undefined;
    let n = 0;
    if (this.protect) for (const a of rt.actors.values()) {
      if (!a.shown || !a.spot) continue;
      const f = a.faceAt(a.spot);
      if (!f) continue;
      const d = cam.position.distanceTo(f.center);
      tv.copy(f.center).project(cam);
      if (tv.z > 1) continue;
      const r = Math.max(0.022, (f.size * 1.8) / (d * tanH) / 2);      // the whole head + a margin (small / far faces too)
      const x = (tv.x + 1) / 2, y = (1 - tv.y) / 2;
      rects.push({ x0: x - r / cam.aspect, x1: x + r / cam.aspect, y0: y - r * 1.1, y1: y + r * 1.25, d });
      if (U && n < U.uFaces.value.length) {
        const px = x * W, py = (1 - y) * H, rp = r * H;
        U.uFaces.value[n++].set(px - rp * 1.5 / cam.aspect * (W / H), py - rp * 1.7, px + rp * 1.5 / cam.aspect * (W / H), py + rp * 1.9);
      }
    }
    if (U) U.uFaceN.value = n;
    const crewRects = rects.slice();
    if (this.protect && rt.state.mode === 'react') {
      const r = rt.layout() === 'solo' ? rt.solo?.rect(cam) : rt.screen?.rect(cam);
      if (r) crewRects.push({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h, d: 0 });
    }
    this.crew?.protect(cam, crewRects);
    if (this.fx) this.fx.rects = rects;
  }

  // ------------------------------------------------------------------------------------------ status
  info() {
    const t = this.now();
    const items = this.sched.items.filter((i) => i.end > t - 5000).slice(0, 12).map((i) => ({ kind: i.kind, in: +((i.start - t) / 1000).toFixed(1), dur: +((i.end - i.start) / 1000).toFixed(1), user: i.user || undefined, n: i.n }));
    return {
      on: !!this.rt, room: this.rt?.info.id ?? null, bag: this.rt ? this.bag : null,
      anchors: this.room ? { service: !!this.room.service, bar: !!this.room.bar, pour: !!this.room.pour, drinks: [...this.room.drinks.keys()].map((k) => k + 1), routes: [...this.room.routes.keys()], sky: this.room.sky.length, exteriors: this.room.exteriors, planet: !!this.room.planet, storms: this.room.planet?.storms.length ?? 0, far: this.room.far.length } : null,
      crew: this.crew?.info() ?? null, sky: this.sky ? { ready: this.sky.ready, error: this.sky.error || undefined, ...this.sky.counts, lod: this.sky.fleet.counts } : null,
      view: this.cur.v ? { anchor: this.cur.v.anchor, d: +this.cur.v.d.toFixed(1), size: this.cur.v.size } : null,
      drink: this.plan ? { L: +this.plan.L.toFixed(2), dur: +this.plan.durClear.toFixed(1), anchor: !!this.plan.anchor, via: this.plan.path.length } : null,
      events: items, support: this.support.length, cut: this.cut ? { key: this.cut.key, in: +(this.cut.from - t / 1000).toFixed(1) } : null,
      notes: this.notes, ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(3),
    };
  }
  debug() { return this.info(); }
  /** Tests: the next start (epoch ms) of an ambient act ('skirmish' | 'flyby') after `from` (set .clock a little past it). */
  nextAct(kind: 'skirmish' | 'flyby', from = this.now()): number | null {
    const every = kind === 'skirmish' ? Math.max(40, this.amb.skirmish) : Math.max(20, this.amb.flyby);
    const dur = kind === 'skirmish' ? 32 : Math.min(every - 2, 30);
    for (let t = Math.ceil(from / 1000); t < from / 1000 + 7200; t++) {
      const a = yachtAmbient(this.seed, kind === 'skirmish' ? 57 : 41, every, dur, t, kind === 'skirmish' ? 0.65 : 0.85);
      if (a && a.start >= from / 1000) return Math.round(a.start * 1000);
    }
    return null;
  }
}

export { CHAMPAGNE_DUR };

/** A demo `yacht` config for any room (test pages): the show volume ahead of CAM_WIDE, the service door at the entrance
 *  path, a bar and a drink table beside the host, one walk route, a planet with storms far ahead. glTF space. */
export function demoConfig(rt: SceneRuntime): RoomYachtConfig {
  const root = rt.room.root;
  root.updateMatrixWorld(true);
  const L = (v: THREE.Vector3) => { const p = root.worldToLocal(v.clone()); return [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)] as [number, number, number]; };
  const cam = rt.room.cameras.get('CAM_WIDE') ?? [...rt.room.cameras.values()][0];
  const cp = cam ? cam.position.clone() : new THREE.Vector3(0, 1.6, 6);
  const fwd = cam ? new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).setY(0).normalize() : new THREE.Vector3(0, 0, -1);
  const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const host = rt.room.spots.find((s) => s) ?? null;
  const hp = host ? host.position.clone() : cp.clone().addScaledVector(fwd, 3).setY(0);
  const hf = host ? host.forward.clone() : fwd.clone().negate();
  const hs = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), hf).normalize();
  const floor = hp.y;
  const service = rt.room.path[0]?.clone() ?? hp.clone().addScaledVector(hs, 4).addScaledVector(hf, -2);
  service.y = floor;
  const facing = (from: THREE.Vector3, to: THREE.Vector3) => +THREE.MathUtils.radToDeg(Math.atan2(to.x - from.x, to.z - from.z)).toFixed(1);
  const bar = hp.clone().addScaledVector(hs, -2.6).addScaledVector(hf, -1.2);
  const drink = hp.clone().addScaledVector(hf, 0.5).addScaledVector(hs, 0.6); drink.y = floor + 0.74;
  const pour = bar.clone().addScaledVector(hf, 0.45); pour.y = floor + 1.05;
  const sky1 = cp.clone().addScaledVector(fwd, 150).add(new THREE.Vector3(0, 18, 0));
  const sky2 = cp.clone().addScaledVector(fwd, 240).addScaledVector(side, -90).add(new THREE.Vector3(0, 30, 0));
  const pc = cp.clone().addScaledVector(fwd, 24000).add(new THREE.Vector3(0, -7000, 0));
  const R = 9000;
  const storm = (a: number, b: number) => { const n = new THREE.Vector3().subVectors(cp, pc).normalize(); const t1 = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize(); const t2 = new THREE.Vector3().crossVectors(t1, n); return L(pc.clone().addScaledVector(n.clone().multiplyScalar(Math.cos(a)).addScaledVector(t1, Math.sin(a) * Math.cos(b)).addScaledVector(t2, Math.sin(a) * Math.sin(b)).normalize(), R)); };
  const rA = hp.clone().addScaledVector(hf, -2.2).addScaledVector(hs, 3.5); rA.y = floor;
  const rB = hp.clone().addScaledVector(hf, -2.4).addScaledVector(hs, -3.5); rB.y = floor;
  return {
    crewHeight: 1.6,
    // the yacht room's own crew / fleet when the private mirror has them (else the engine falls back to Area 18's)
    units: '@sc_890jump/npc/crew_units.glb', fleet: '@sc_890jump/fleet/ships.glb', fleetMeta: '@sc_890jump/fleet/ships.json',
    patrons: [
      { unit: 'guest_gown', clip: 'ual_idle_talking', position: L(rA.clone().addScaledVector(hf, -0.8)), facing: facing(rA, rB) + 90 },
      { unit: 'guest_tux', clip: 'ual_idle_talking', position: L(rA.clone().addScaledVector(hf, -0.8).addScaledVector(hs, -0.9)), facing: facing(rB, rA) + 90 },
    ],
    debugAnchors: {
      YACHT_SERVICE: { position: L(service), facing: facing(service, hp) },
      YACHT_BAR: { position: L(bar), facing: facing(bar, hp) },
      YACHT_POUR: { position: L(pour) },
      [`YACHT_DRINK_${String((host?.index ?? 0) + 1).padStart(2, '0')}`]: { position: L(drink) },
      YACHT_ROUTE_A_01: { position: L(rA) }, YACHT_ROUTE_A_02: { position: L(rB) },
      YACHT_SKY_01: { position: L(sky1), size: 70 }, YACHT_SKY_02: { position: L(sky2), size: 110 },
    },
    routes: [{ route: 'A', every: 40, speed: 1.0 }],
    planet: { center: L(pc), radius: R, storms: [storm(0.35, 0.4), storm(0.5, 2.2), storm(0.2, 4)] },
    ambient: { flyby: 45, skirmish: 90, lightning: 8, patrol: 45 },
  };
}
