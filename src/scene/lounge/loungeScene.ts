// Lounge events engine (docs/SCENES.md → "Lounge events") — rooms / areas whose scene.json has a `lounge` key (first
// user: hangout_lounge: main lounge, bar, patio with a firepit). Donations (tips / Super Chats / bits / Kicks … → USD)
// and gifted subs (by count) become celebrations, tiered, in the area the host is in:
//   bar   : a drink slides down the counter → a round of shots → the bottle wall lights up + bar sparklers → champagne
//   patio : the firepit flares up → sparklers → fireworks over the patio (daytime: salute flashes + smoke shells)
//   main  : a confetti puff + a light cue → champagne on the coffee table → the balloon drop + confetti cannons
//   gifts : N shots / balloons / rockets for N gifts; ≥ trainMin = the GIFT TRAIN (one drink / balloon / rocket each)
//   big   : tier 4+ adds the other areas' signatures where this camera can see them (fireworks through the glass …)
// plus a supporter banner (loungeBanner.ts) and a light-show cue. Inputs, all deterministic:
//   · support events from the chat feed (ChatEvent ts + id → loungeSchedule: identical on every page)
//   · the host's bag SceneState.modes.lounge (switches, tier lines, the last few test / bus stamps)
// No Math.random anywhere visible; a page opened mid-celebration lands mid-celebration; moving to another area keeps
// the same schedule (the area only changes which pieces play).
// Never in front of the show: see loungeFx.ts (faces, the React screen, keep-outs, the lens). Calm = small pieces only,
// no light cues, no flashes; React = no light cues, nothing inside the screen. No sound (on purpose: see the docs).
// Cost: rooms without `lounge` → one check per frame.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import type { CamPose } from '../cameraRig.ts';
import { RoomRays } from '../twoShot.ts';
import type { RoomInfo } from '../contract.ts';
import { activeEnv, envWind } from '../environment/index.ts';
import { EU, MAX_POOLS } from '../environment/materials.ts';
import type { SkyView } from '../yacht/yachtSky.ts';
import {
  LOUNGE_BAG, LOUNGE_LEAD, loungeBannerText, loungeHash, loungeLines, loungePieces, loungeSchedule, loungeSupportOf, sanitizeLounge,
  type LoungeBag, type LoungeIn, type LoungeItem, type LoungePiece, type LoungeSource, type LoungeTier, type LoungeZone, type RoomLoungeConfig,
} from '../../../shared/lounge.ts';
import { loungeRoomOf, type LoungeRoom, type LoungeZoneAnchors } from './loungeRoom.ts';
import { LoungeFx, type FxRect } from './loungeFx.ts';
import { LoungeBanner, type BannerSpec } from './loungeBanner.ts';

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();
const tmpCam = new THREE.PerspectiveCamera();
const BANNER_SECS = 9;

interface Support { id: string; ts: number; src: LoungeSource; usd: number; n: number; user: string; amount: string }

export class LoungeScene {
  private rt: SceneRuntime | null = null;
  private lastRt: SceneRuntime | null = null;
  private cfg: RoomLoungeConfig | null = null;
  private room: LoungeRoom | null = null;
  private group = new THREE.Group();
  private fx: LoungeFx | null = null;
  private banner: LoungeBanner | null = null;
  private rays: RoomRays | null = null;
  private gen = 0;
  private support: Support[] = [];
  private tests: LoungeIn[] = [];
  private bagSrc: unknown = undefined;
  private bag: LoungeBag = sanitizeLounge({});
  private sched: { key: string; items: LoungeItem[] } = { key: '', items: [] };
  private views = new Map<string, { v: SkyView | null; seen: number }>();
  private vis = new Map<string, { ok: boolean; seen: number }>();
  private cur: { key: string; v: SkyView | null; pose: CamPose | null; at: number } = { key: '', v: null, pose: null, at: -1 };
  private cueSent = new Set<string>();
  private bottleOrig = new Map<THREE.MeshStandardMaterial, { c: THREE.Color; i: number }>();
  private rects: FxRect[] = [];
  private faceRects: FxRect[] = [];
  private protectT = 0;
  private frame = 0;
  private perf = { avg: 0, peak: 0, slowFor: 0, goodFor: 0 };
  private notes: string[] = [];
  protect = true;
  /** Tests: pin the night factor (0 day … 1 night); null = from the room's environment. */
  forceNight: number | null = null;
  /** Test pages: time advances only through update(). ms */
  manual = false;
  clock = Date.now();
  now() { return this.manual ? this.clock : Date.now(); }

  // ------------------------------------------------------------------------------------------ lifecycle
  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.lastRt = rt;
    const info = rt.info as unknown as { lounge?: RoomLoungeConfig; area?: string; areaList?: { key: string; label: string }[]; areas?: Record<string, { label?: string; lounge?: RoomLoungeConfig }>; defaultCamera?: string };
    const cfg = info.lounge;
    if (!cfg || typeof cfg !== 'object' || cfg.on === false) return;          // not a lounge room: nothing at all
    this.rt = rt; this.cfg = cfg;
    const label = info.areaList?.find((a) => a.key === info.area)?.label;
    this.room = loungeRoomOf({
      root: rt.room.root, cfg, area: info.area, label, areas: info.areas, spots: rt.room.spots.filter((s) => !!s), bounds: rt.room.bounds,
      cameras: rt.room.cameras as never, defaultCamera: info.defaultCamera,
    });
    this.notes = [...this.room.notes];
    for (const m of this.room.bottleMats) this.bottleOrig.set(m, { c: m.emissive.clone(), i: m.emissiveIntensity });
    this.group = new THREE.Group(); this.group.name = 'vtp:lounge';
    rt.root.add(this.group);
    this.fx = new LoungeFx();
    this.fx.keepouts = this.room.own.keepouts;
    this.banner = new LoungeBanner();
    this.group.add(this.fx.group, this.banner.sprite);
    // rays for "can this camera see the patio sky / the bar from here": glass and windows don't block
    try {
      const opaque = rt.room.occluders.filter((m) => {
        const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshPhysicalMaterial | undefined;
        if (!mat) return true;
        if (/glass|window|pane|glazing/i.test(`${m.name} ${mat.name}`)) return false;
        return !(mat.transparent && mat.opacity < 0.6) && !((mat.transmission ?? 0) > 0.2);
      });
      this.rays = new RoomRays({ ...rt.room, occluders: opaque, colliders: [] } as RoomInfo);
    } catch { this.rays = null; }
    const gen = ++this.gen;
    void this.fx.load(() => gen === this.gen && this.rt === rt).then(() => { if (gen === this.gen && this.rt === rt) this.warm(rt); });
  }

  detach() {
    this.gen++;
    this.restoreBottles();
    this.bottleOrig.clear();
    this.fx?.dispose(); this.fx = null;
    this.banner?.dispose(); this.banner = null;
    this.group.removeFromParent();
    this.rt = null; this.cfg = null; this.room = null; this.rays = null;
    this.views.clear(); this.vis.clear(); this.cur = { key: '', v: null, pose: null, at: -1 }; this.sched = { key: '', items: [] };
  }

  /** Compile the effect programs once in the background: no hitch on the first celebration. */
  private warm(rt: SceneRuntime) {
    const shown: THREE.Object3D[] = [];
    this.group.traverse((o) => { if (!o.visible) { o.visible = true; shown.push(o); } });
    const r = rt.stage.renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> };
    const done = () => { for (const o of shown) o.visible = false; };
    try {
      const p = r.compileAsync ? r.compileAsync(this.group, rt.stage.camera, rt.stage.scene) : Promise.resolve(r.compile(this.group, rt.stage.camera, rt.stage.scene));
      void p.catch(() => {}).finally(done);
    } catch { done(); }
  }

  // ------------------------------------------------------------------------------------------ inputs
  /** Chat feed → support events. snap = catch-up history: kept only while its celebration could still be running. */
  onSupport(evs: { kind?: string; fkind?: string; ts?: number; id?: string; user?: string; usd?: number; approxUsd?: number; amount?: number; display?: string }[], snap: boolean) {
    const now = Date.now();
    for (const e of evs) {
      if (e.kind !== 'finance' || typeof e.ts !== 'number' || !Number.isFinite(e.ts)) continue;
      const s = loungeSupportOf(e);
      if (!s) continue;
      const id = String(e.id ?? e.ts);
      if (snap && now - e.ts > 3 * 60_000) continue;
      if (Math.abs(now - e.ts) > 6 * 3600_000) continue;
      if (this.support.some((x) => x.id === id)) continue;
      this.support.push({ id, ts: e.ts, ...s, user: String(e.user ?? '').slice(0, 32), amount: String(e.display ?? '').slice(0, 24) });
    }
    this.support.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    if (this.support.length > 80) this.support.splice(0, this.support.length - 80);
  }

  /** Tests (this page only): 't1'…'t5' (a donation at that tier's line), 'money:<usd>', 'gift' / 'train' (n gifts),
   *  'sub', 'raid' — `inSec` seconds from now. */
  test(kind = 't3', inSec = 1, user = 'TestViewer', n = 5) {
    const at = this.now() + inSec * 1000;
    const id = `test-${kind}-${this.tests.length}-${Math.round(at)}`;
    const L = loungeLines(this.bag, this.cfg);
    let m = /^t([1-5])$/.exec(kind);
    if (m) { const usd = L.money[+m[1] - 1]; this.tests.push({ id, at, src: 'money', usd, n: 0, user, amount: `$${usd.toFixed(2)}` }); return id; }
    m = /^money:([\d.]+)$/.exec(kind);
    if (m) { const usd = parseFloat(m[1]); this.tests.push({ id, at, src: 'money', usd, n: 0, user, amount: `$${usd.toFixed(2)}` }); return id; }
    if (kind === 'gift' || kind === 'train') { const c = kind === 'train' ? Math.max(n, L.trainMin) : n; this.tests.push({ id, at, src: 'gift', usd: 0, n: c, user, amount: `${c} subs` }); return id; }
    if (kind === 'sub' || kind === 'raid') { this.tests.push({ id, at, src: kind, usd: 0, n: kind === 'raid' ? 42 : 1, user }); return id; }
    return null;
  }

  private readBag(rt: SceneRuntime) {
    const src = (rt.state.modes ?? {})[LOUNGE_BAG];
    if (src !== this.bagSrc) { this.bagSrc = src; this.bag = sanitizeLounge(src); }
    return this.bag;
  }

  /** support + bag stamps + tests → the schedule (recomputed only when an input changes) */
  private schedule(bag: LoungeBag): LoungeItem[] {
    const L = loungeLines(bag, this.cfg);
    const last = this.support[this.support.length - 1];
    const sup = bag.support;
    const key = `${this.support.length}|${last?.id ?? ''}|${bag.evs.map((e) => `${e.seq}@${e.at}`).join(',')}|${this.tests.length}|${sup.on}${sup.gifts}${sup.subs}${sup.raids}|${L.money}|${L.gifts}|${L.trainMin}`;
    if (key === this.sched.key) return this.sched.items;
    const evs: LoungeIn[] = [];
    if (sup.on) for (const s of this.support) {
      if ((s.src === 'gift' && !sup.gifts) || (s.src === 'sub' && !sup.subs) || (s.src === 'raid' && !sup.raids)) continue;
      evs.push({ id: s.id, at: s.ts + LOUNGE_LEAD, src: s.src, usd: s.usd, n: s.n, user: s.user, amount: s.amount, seed: loungeHash(s.id) });
    }
    for (const e of bag.evs) evs.push({ id: `ev:${e.seq}:${e.at}`, at: e.at, src: e.src, usd: e.usd, n: e.n, user: e.user, amount: e.amount, seed: e.seed });
    evs.push(...this.tests);
    this.sched = { key, items: loungeSchedule(evs, L) };
    return this.sched.items;
  }

  // ------------------------------------------------------------------------------------------ views (state camera)
  private stateView(t: number): { pose: CamPose; aspect: number; key: string } | null {
    const rt = this.rt!;
    if (this.cur.pose && t - this.cur.at < 0.5) return { pose: this.cur.pose, aspect: rt.stage.camera.aspect || 16 / 9, key: this.cur.key };
    const aspect = rt.stage.camera.aspect || 16 / 9;
    const { key, pose } = rt.resolveCamera(rt.state.camera, aspect);
    const k = `${key}|${aspect.toFixed(3)}|${pose.position.x.toFixed(2)},${pose.position.y.toFixed(2)},${pose.position.z.toFixed(2)}`;
    if (k !== this.cur.key) { this.cur = { key: k, v: null, pose, at: t }; this.views.clear(); this.vis.clear(); }
    else this.cur.at = t;
    return { pose, aspect, key: k };
  }
  /** the show volume for one item's fireworks: the sky anchor best in view of the state camera (the same on every page) */
  private skyView(id: string, sky: { pos: THREE.Vector3; size: number }[], t: number): SkyView | null {
    const hit = this.views.get(id);
    if (hit) { hit.seen = this.frame; return hit.v; }
    const sv = this.stateView(t);
    if (!sv || !sky.length) return null;
    const { pose, aspect } = sv;
    tmpCam.fov = pose.fov; tmpCam.aspect = aspect; tmpCam.near = 0.1; tmpCam.far = 1e6;
    tmpCam.position.copy(pose.position); tmpCam.quaternion.copy(pose.quaternion); tmpCam.updateProjectionMatrix(); tmpCam.updateMatrixWorld(true);
    let best = -1, bestS = -Infinity;
    sky.forEach((s, i) => {
      tv.copy(s.pos).project(tmpCam);
      if (tv.z > 1 || tv.z < -1) return;
      const m = Math.max(Math.abs(tv.x), Math.abs(tv.y));
      const score = (m < 0.9 ? 1 : 0) - m * 0.5 + (tv.y > -0.2 ? 0.1 : 0);
      if (score > bestS) { bestS = score; best = i; }
    });
    let v: SkyView | null = null;
    if (best >= 0) {
      const P = sky[best].pos;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
      const D = P.clone().sub(pose.position); const d = Math.max(15, D.length()); D.normalize();
      // bursts big enough to read: a burst ~¼ of the frame height at that distance
      const size = Math.max(sky[best].size, d * Math.tan(THREE.MathUtils.degToRad(pose.fov) / 2));
      const R = new THREE.Vector3().crossVectors(D, new THREE.Vector3(0, 1, 0)); if (R.lengthSq() < 1e-6) R.set(1, 0, 0); R.normalize();
      const U = new THREE.Vector3().crossVectors(R, D).normalize();
      const tanV = Math.tan(THREE.MathUtils.degToRad(pose.fov) / 2);
      v = { C: pose.position.clone(), D, R, U, d, size, tanH: tanV * aspect, anchor: best, F: fwd, CR: new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion), CU: new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion), tanV, aspect };
    }
    this.views.set(id, { v, seen: this.frame });
    return v;
  }
  /** Room-wide fireworks from another area: the sky points this camera sees (through the glass). A point hidden by the
   *  ceiling is also tried lower — over the skyline, just above the horizon of this view — so a big one still shows. */
  private visibleSky(key: string, sky: { pos: THREE.Vector3; size: number }[], t: number) {
    const sv = this.stateView(t);
    if (!sv) return [];
    const C = sv.pose.position;
    const pitch = Math.asin(THREE.MathUtils.clamp(new THREE.Vector3(0, 0, -1).applyQuaternion(sv.pose.quaternion).y, -1, 1));
    const out: { pos: THREE.Vector3; size: number }[] = [];
    sky.forEach((s, i) => {
      const flat = Math.hypot(s.pos.x - C.x, s.pos.z - C.z);
      for (const [j, el] of [[0, NaN], [1, pitch + THREE.MathUtils.degToRad(sv.pose.fov) * 0.3], [2, pitch + THREE.MathUtils.degToRad(sv.pose.fov) * 0.12]] as [number, number][]) {
        const p = Number.isNaN(el) ? s.pos : s.pos.clone().setY(Math.min(s.pos.y, C.y + flat * Math.tan(el)));
        if (p.y < C.y + 4) continue;
        if (this.sees(`${key}:sky${i}:${j}`, p, t)) { out.push({ pos: p, size: s.size }); break; }
      }
    });
    return out;
  }
  /** can the state camera see this point (in frame, not behind an opaque wall)? cached per key */
  private sees(key: string, p: THREE.Vector3, t: number): boolean {
    const hit = this.vis.get(key);
    if (hit) { hit.seen = this.frame; return hit.ok; }
    const sv = this.stateView(t);
    let ok = false;
    if (sv) {
      const { pose, aspect } = sv;
      tmpCam.fov = pose.fov; tmpCam.aspect = aspect; tmpCam.near = 0.1; tmpCam.far = 1e6;
      tmpCam.position.copy(pose.position); tmpCam.quaternion.copy(pose.quaternion); tmpCam.updateProjectionMatrix(); tmpCam.updateMatrixWorld(true);
      tv.copy(p).project(tmpCam);
      ok = tv.z < 1 && Math.abs(tv.x) < 1.05 && Math.abs(tv.y) < 1.05;
      if (ok && this.rays) ok = this.rays.hit(pose.position, p, 0.3) === Infinity;
    }
    this.vis.set(key, { ok, seen: this.frame });
    return ok;
  }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number) {
    const rt = this.rt;
    if (!rt) return;
    const t0 = performance.now();
    if (this.manual) this.clock += dt * 1000;
    this.frame++;
    const nowMs = this.now(), t = nowMs / 1000;
    const bag = this.readBag(rt);
    const fx = this.fx!, R = this.room!;
    this.group.visible = bag.on;
    if (!bag.on) { this.restoreBottles(); this.banner?.update(null, t, rt.stage.camera, []); return; }
    const cam = rt.stage.camera;
    const H = rt.stage.renderer.domElement.height || 1080;
    const react = rt.state.mode === 'react';
    this.protectT -= dt;
    if (this.protectT <= 0) { this.protectT = 0.25; this.protectFaces(cam, H); }
    const items = this.schedule(bag);
    const night = this.forceNight ?? activeEnv()?.townWeather()?.night ?? 0;
    const wind = tv2.set(envWind.x, 0, envWind.z).multiplyScalar(envWind.active ? 0.12 : 0);
    fx.level = this.perf.slowFor > 2 ? 1 : 0;
    fx.begin(t, cam);
    let bottleK = 0, active = false;
    let bannerSpec: BannerSpec | null = null;
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii];
      const s = it.start / 1000, e = it.end / 1000;
      if (t < s - 1 || t > e + 2) continue;
      active = true;
      const tier = (bag.calm ? Math.min(it.tier, 2) : it.tier) as LoungeTier;
      // the banner: this item's, until the next one starts
      const next = items[ii + 1];
      // (a gift train keeps its banner while the train runs: ×N counts up with the cars)
      const hold = it.train ? Math.min(30, 3 + Math.min(it.n, 60) * 0.42 + 3) : BANNER_SECS;
      const bTo = Math.min(s + Math.min(hold, e - s), next ? next.start / 1000 : Infinity);
      if (bag.banner && t >= s - 0.1 && t < bTo + 0.7) {
        const b = loungeBannerText(it, R.zone);
        let title = b.title, bkey = it.id;
        if (it.train && !bag.calm) {
          const cars = Math.max(1, Math.min(it.n, Math.floor((t - s - 2.5) / 0.42) + 1));
          title = `GIFT TRAIN  ×${cars}`; bkey = `${it.id}:${cars}`;
        }
        bannerSpec = { key: bkey, title, who: b.who, icon: b.icon, tier: it.tier, from: s, to: bTo };
      }
      const pieces = loungePieces(R.zone, tier, it.n, it.train && !bag.calm, bag.roomWide && !bag.calm);
      pieces.forEach((p, pi) => {
        const u = t - s - p.at;
        if (u < -0.5 || u > p.dur + 2.5) return;
        const own = p.z === R.zone;
        const A: LoungeZoneAnchors | undefined = own ? R.own : R.other[p.z];
        if (!A) return;
        const key = `${it.id}:${pi}`;
        const visible = (q: THREE.Vector3) => own || this.sees(key, q, t);
        const seed = (it.seed + pi * 7919) >>> 0;
        switch (p.k) {
          case 'lights': if (u >= 0 && u < 2) this.cue(it, tier, bag, react); break;
          case 'slide': if (A.slide && visible(A.slide[1])) fx.slide(p, u, seed, A.slide[0], A.slide[1], this.sideOf(A.slide)); break;
          case 'shots': {
            const slots = A.shots.length ? A.shots : this.shotSlots(A);
            if (slots.length && visible(slots[0])) fx.shots(p, u, seed, slots, Math.min(p.n, 16) * 0.12 + 1.6);
            break;
          }
          case 'bottles': if (A.bottles && visible(A.bottles.pos)) bottleK = Math.max(bottleK, fx.bottles(p, u, seed, A.bottles)); break;
          case 'sparklers': {
            const pts = A.sparks.length ? A.sparks : p.z === 'bar' && A.slide ? [A.slide[0], A.slide[1]] : [];
            if (pts.length && visible(pts[0])) fx.sparklers(p, u, seed, pts);
            break;
          }
          case 'champagne': {
            const at = p.z === 'bar' ? (A.pour ?? (A.slide ? A.slide[0].clone().lerp(A.slide[1], 0.5) : null)) : A.champagne;
            if (at && visible(at)) fx.champagne(p, u, seed, at, this.hostPos() ?? cam.position, t);
            break;
          }
          case 'confetti': if (A.confetti.length && visible(A.confetti[0].pos)) fx.confettiDrop(p, u, seed, A.confetti, A.floor); break;
          case 'balloons': if (A.balloons && visible(A.balloons.pos)) { const [rgt, fw] = this.netAxes(); fx.balloonDrop(p, u, seed, A.balloons, A.floor, rgt, fw); } break;
          // (from another area: is the column above the fire in view — the fire bowl itself may hide behind a sofa)
          case 'flare': if (A.firepit && visible(tv3.copy(A.firepit.pos).setY(A.firepit.pos.y + 1.4))) fx.flare(p, u, seed, A.firepit, wind); break;
          case 'fireworks': case 'rockets': {
            if (!A.sky.length) break;
            const sky = own ? A.sky : this.visibleSky(key, A.sky, t);
            const V = sky.length ? this.skyView(`${key}:sky`, sky, t) : null;
            if (!V) break;
            const n = bag.calm ? 0 : night;
            if (p.k === 'fireworks') fx.fireworks(p, u, seed, V, n);
            else fx.rockets(p, u, seed, V, A.sparks, n);
            if (n > 0.4 && u > 1 && u < 13) this.skyPool(V, u, seed);
            break;
          }
        }
      });
    }
    // the bottle wall's own glow (EMIT_bottle* materials, restored when nothing plays)
    this.pulseBottles(bottleK, t);
    fx.end(cam, H);
    // idle: nothing to traverse / bind (the effect meshes stay warm, just hidden)
    fx.group.visible = active;
    this.banner!.update(bag.banner ? bannerSpec : null, t, cam, this.faceRects.concat(this.screenRect(cam)));
    this.lightPools();
    for (const [k, v] of this.views) if (this.frame - v.seen > 240) this.views.delete(k);
    for (const [k, v] of this.vis) if (this.frame - v.seen > 240) this.vis.delete(k);
    if (this.cueSent.size > 200) this.cueSent.clear();
    if (this.tests.length > 40) this.tests.splice(0, this.tests.length - 40);
    const ms = performance.now() - t0;
    const P = this.perf;
    P.avg += (ms - P.avg) * 0.05; P.peak = Math.max(P.peak * 0.995, ms);
    if (ms > 2.0) { P.slowFor += dt; P.goodFor = 0; } else { P.goodFor += dt; if (P.goodFor > 10) P.slowFor = 0; }
  }

  private cue(it: LoungeItem, tier: LoungeTier, bag: LoungeBag, react: boolean) {
    if (!bag.lights || bag.calm || react || this.cueSent.has(it.id)) return;
    this.cueSent.add(it.id);
    const L = this.rt!.lights as unknown as { cue?: (w: string) => void; moment?: (k: string, s: number) => void };
    const what = tier >= 4 ? 'big' : it.src === 'raid' ? 'raid' : it.src === 'gift' || it.src === 'sub' ? 'sub' : 'tip';
    try { L.cue?.(what); if (tier >= 4) L.moment?.('lasers', 4); } catch { /* optional */ }
  }

  private hostPos(): THREE.Vector3 | null {
    const a = this.rt!.actors.get('@host') ?? [...this.rt!.actors.values()].find((x) => x.shown && x.spot);
    return a?.spot?.position ?? null;
  }
  /** the counter's customer side (towards the seats) */
  private sideOf(s: [THREE.Vector3, THREE.Vector3]) {
    const d = tv.copy(s[1]).sub(s[0]).setY(0).normalize();
    const side = new THREE.Vector3(-d.z, 0, d.x);
    const h = this.hostPos();
    if (h && side.dot(tv2.copy(h).sub(s[0])) < 0) side.negate();
    return side;
  }
  /** shot glasses along the counter near the pour point (no EVT_SHOT_xx) */
  private shotSlots(A: LoungeZoneAnchors): THREE.Vector3[] {
    if (!A.slide) return [];
    const mid = A.pour ? A.pour.clone() : A.slide[0].clone().lerp(A.slide[1], 0.5);
    if (A.pour) { const d0 = A.slide[0].clone(), dir = A.slide[1].clone().sub(d0).normalize(); mid.copy(d0).addScaledVector(dir, mid.clone().sub(d0).dot(dir)); mid.y = A.slide[0].y; }
    const dir = A.slide[1].clone().sub(A.slide[0]).normalize();
    const side = this.sideOf(A.slide);
    return Array.from({ length: 8 }, (_, i) => mid.clone().addScaledVector(dir, (i - 3.5) * 0.12).addScaledVector(side, 0.06));
  }
  private netAxes(): [THREE.Vector3, THREE.Vector3] {
    const cam = this.rt!.stage.camera;
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
    return [r, new THREE.Vector3(-r.z, 0, r.x)];
  }

  private pulseBottles(k: number, t: number) {
    if (k <= 0.001) { this.restoreBottles(); return; }
    let i = 0;
    for (const [m, o] of this.bottleOrig) {
      const w = 0.5 + 0.5 * Math.sin(t * 5 + i++);
      m.emissive.copy(o.c);
      if (m.emissive.r + m.emissive.g + m.emissive.b < 0.05) m.emissive.setRGB(0.9, 0.55, 0.2);
      if (k > 1.2) m.emissive.lerp(new THREE.Color().setHSL((t * 0.15) % 1, 0.8, 0.55), 0.6);
      m.emissiveIntensity = (o.i || 1) * (1 + k * (1.6 + 0.6 * w));
    }
  }
  private restoreBottles() {
    for (const [m, o] of this.bottleOrig) { if (m.emissiveIntensity !== o.i) { m.emissive.copy(o.c); m.emissiveIntensity = o.i; } }
  }

  /** a firework lighting up the patio (env light pool) */
  private skyPool(V: SkyView, u: number, seed: number) {
    const k = Math.max(0, Math.sin(u * 2.3 + (seed % 7))) ** 4;
    if (k < 0.05 || !this.fx) return;
    const p = V.C.clone().addScaledVector(V.D, Math.min(V.d, 30)).setY(V.C.y + 6);
    const c = [[1, 0.6, 0.3], [0.5, 0.7, 1], [1, 0.4, 0.7], [0.6, 1, 0.6]][Math.floor(u / 1.4 + seed) % 4];
    this.fx.pools.push({ p, r: 26, c: new THREE.Color(c[0] * 0.5 * k, c[1] * 0.5 * k, c[2] * 0.5 * k) });
  }
  private lightPools() {
    if (!activeEnv() || !this.fx?.pools.length) return;
    let n = EU.uEnvPoolN.value;
    for (const p of this.fx.pools) {
      if (n >= MAX_POOLS) break;
      EU.uEnvPool.value[n].set(p.p.x, p.p.y, p.p.z, p.r);
      EU.uEnvPoolCol.value[n].set(p.c.r, p.c.g, p.c.b);
      n++;
    }
    EU.uEnvPoolN.value = n;
  }

  // ------------------------------------------------------------------------------------------ never in front of the show
  private screenRect(cam: THREE.PerspectiveCamera): FxRect[] {
    const rt = this.rt!;
    if (rt.state.mode !== 'react') return [];
    const r = rt.layout() === 'solo' ? rt.solo?.rect(cam) : rt.screen?.rect(cam);
    // (padded: a balloon centred just outside the screen must not hang over its edge)
    return r ? [{ x0: r.x - 0.035, y0: r.y - 0.05, x1: r.x + r.w + 0.035, y1: r.y + r.h + 0.05, d: Infinity }] : [];
  }
  private protectFaces(cam: THREE.PerspectiveCamera, H: number) {
    const rt = this.rt!;
    cam.updateMatrixWorld();
    const rects: FxRect[] = [];
    const W = rt.stage.renderer.domElement.width || 1920;
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const px: THREE.Vector4[] = [];
    if (this.protect) for (const a of rt.actors.values()) {
      if (!a.shown || !a.spot) continue;
      const f = a.faceAt(a.spot);
      if (!f) continue;
      const d = cam.position.distanceTo(f.center);
      tv.copy(f.center).project(cam);
      if (tv.z > 1) continue;
      const r = Math.max(0.022, (f.size * 1.8) / (d * tanH) / 2);          // the whole head + a margin
      const x = (tv.x + 1) / 2, y = (1 - tv.y) / 2;
      rects.push({ x0: x - r / cam.aspect, x1: x + r / cam.aspect, y0: y - r * 1.15, y1: y + r * 1.3, d });
      const cx = x * W, cy = (1 - y) * H, rp = r * H;
      px.push(new THREE.Vector4(cx - rp * 1.3 / cam.aspect * (W / H), cy - rp * 1.6, cx + rp * 1.3 / cam.aspect * (W / H), cy + rp * 1.5));
    }
    this.faceRects = rects;
    const scr = this.protect ? this.screenRect(cam) : [];
    for (const s of scr) px.push(new THREE.Vector4(s.x0 * W, (1 - s.y1) * H, s.x1 * W, (1 - s.y0) * H));
    this.rects = rects.concat(scr);
    if (this.fx) {
      this.fx.rects = this.rects;
      for (const f of [this.fx.fx, this.fx.sky.fx]) {
        const U = f.uniforms as unknown as { uFaces: { value: THREE.Vector4[] }; uFaceN: { value: number } };
        let n = 0;
        for (const v of px) if (n < U.uFaces.value.length) U.uFaces.value[n++].copy(v);
        U.uFaceN.value = n;
      }
    }
  }

  // ------------------------------------------------------------------------------------------ status
  info() {
    const t = this.now();
    const items = this.sched.items.filter((i) => i.end > t - 5000).slice(0, 10).map((i) => ({ src: i.src, tier: i.tier, n: i.n || undefined, train: i.train || undefined, user: i.user || undefined, in: +((i.start - t) / 1000).toFixed(1), len: +((i.end - i.start) / 1000).toFixed(1) }));
    const A = this.room?.own;
    return {
      on: !!this.rt, room: this.rt?.info.id ?? null, zone: this.room?.zone ?? null, bag: this.rt ? this.bag : null,
      anchors: A ? { slide: !!A.slide, shots: A.shots.length, pour: !!A.pour, bottles: !!A.bottles, bottleMats: this.room!.bottleMats.length, firepit: !!A.firepit, sky: A.sky.length, sparks: A.sparks.length, confetti: A.confetti.length, balloons: !!A.balloons, champagne: !!A.champagne, keepouts: A.keepouts.length, floor: +A.floor.toFixed(2) } : null,
      other: this.room ? Object.fromEntries(Object.entries(this.room.other).map(([k, v]) => [k, { firepit: !!v!.firepit, sky: v!.sky.length, bottles: !!v!.bottles, confetti: v!.confetti.length }])) : null,
      events: items, support: this.support.length, banner: this.banner?.corner || null,
      counts: this.fx?.counts ?? null, notes: this.notes, ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(3),
    };
  }
  debug() { return this.info(); }
  /** Tests: forget this page's test celebrations. */
  clearTests() { this.tests.length = 0; this.sched.key = ''; }
  /** Test pages without a lounge room: re-attach (after changing the room info). */
  reattach() { const rt = this.rt ?? this.lastRt; if (rt) { this.detach(); this.attach(rt); } return !!this.rt; }
}

export type { LoungePiece, LoungeZone };
