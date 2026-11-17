// WarzoneScene — the battle outside a warzone room (scene.json `warzone`; first user: warzone_compound). Layered on the
// raid engine (src/scene/raid/*), which keeps playing the close firefights between frog soldiers and the masked militia
// (units from the "warzone" pack). This layer adds everything around them, deterministic on the wall clock:
//   mortar / artillery impacts (flash, fireball, shock ring, dust column, skirt, debris, sparks, scorch, a light pool on
//   the room), RPGs (backblast, motor, smoke trail, blast — also every RPG the militia fires in the raid fights), tracer
//   exchanges on the far blocks, air strikes on the skyline (mushroom plumes that drift for minutes), jets, a frog gunship
//   with rocket runs, a recon drone, a militia technical that drives through and gets knocked out (then burns), a frog
//   APC push with its cannon, the rooftop frog sniper, burning wrecks and skyline fires, and at night illumination flares
//   (they light the whole street) + AA tracer fire. A pacing curve makes lulls and big moments (warzonePlan.ts).
// Set pieces: raid events `wz_*` (Stream Deck / MCP `scene {raid: {event}}`), donations (tiers by USD), channel-point
// rewards (reward title keywords). Never in front of the show: nothing is placed inside the building or near a spot,
// every effect dims over faces and is removed inside the React screen, shake / interior dust stop in "calm" and React.
import * as THREE from 'three';
import { SpotFlashGate, pageGovernor } from '../../../shared/flashGovernor.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { SceneRuntime } from '../SceneRuntime.ts';
import type { CamPose } from '../cameraRig.ts';
import { activeEnv, envWind } from '../environment/index.ts';
import { EU, MAX_POOLS } from '../environment/materials.ts';
import { hash32, Rng } from '../raid/rng.ts';
import { registerRaidEvent, registerWeaponFx, setRaidUnitAlias, type RaidScene } from '../raid/raidScene.ts';
import { Npc } from '../raid/units.ts';
import type { RaidEventStamp } from '../../../shared/raid.ts';
import { GLOW, WarzoneFx } from './warzoneFx.ts';
import { parseWarzoneRoom, type WarzoneCfg, type WzAnchors } from './warzoneRoom.ts';
import { DEFAULT_SUPPORT, SET_PIECES, WarzonePlan, type Ev } from './warzonePlan.ts';

const VEH_URL = new URL('../../../assets/raid/packs/warzone/vehicles.glb', import.meta.url).href;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const tv = V(), tv2 = V(), tv3 = V(), tq = new THREE.Quaternion(), te = new THREE.Euler();
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };
const G = 9.8;

// the room's raid events → set pieces: which raid event kinds are ours
const REWARD_WORDS: [RegExp, string][] = [
  [/air ?strike|bomb|jet|napalm|nuke/i, 'wz_airstrike'], [/tank|armou?r|apc|push|convoy/i, 'wz_armor'], [/mortar|artillery|barrage|shell/i, 'wz_mortar'],
  [/heli|gunship|chopper|apache/i, 'wz_heli'], [/flare|illum|light/i, 'wz_flare'], [/sniper|snipe|headshot/i, 'wz_sniper'], [/technical|truck|pickup/i, 'wz_technical'],
  [/assault|attack|wave|ambush|raid/i, 'wz_assault'],
];

interface VehLib { tmpl: Map<string, THREE.Object3D> }
interface VehInst { obj: THREE.Object3D; kind: string; wheels: THREE.Object3D[]; rotors: THREE.Object3D[]; turret: THREE.Object3D | null; mats: THREE.MeshToonMaterial[]; seen: number; crew: Npc | null }
interface Label { sprite: THREE.Sprite; id: string; tex: THREE.CanvasTexture }

export class WarzoneScene {
  private rt: SceneRuntime | null = null;
  A: WzAnchors | null = null;
  plan: WarzonePlan | null = null;
  cfg: WarzoneCfg = {};
  private fx: WarzoneFx | null = null;
  private veh: VehLib | null = null;
  private vehLoading = false;
  private insts = new Map<string, VehInst>();
  private labels = new Map<string, Label>();
  private sniper: Npc | null = null;
  private rockets: { from: THREE.Vector3; to: THREE.Vector3; t0: number; seed: number }[] = [];
  private localStamps: Ev[] = [];
  private stampCache = new Map<string, Ev | null>();
  private pools: { p: THREE.Vector3; r: number; c: THREE.Color }[] = [];
  private flash = new THREE.Color();
  private shake = 0;
  private shakeSeed = 1;
  private holdT = 0;
  private calmSince: number | null = null;
  private night = 0;
  private offs: (() => void)[] = [];
  private prevOverride: ((aspect: number) => { key: string; pose: CamPose; secs: number } | null) | null = null;
  private perf = { avg: 0, peak: 0, level: 0, slowFor: 0, goodFor: 0 };
  private evCount = 0;
  manual = false;
  clock = Date.now();
  /** Tests: pin the perf level (null = automatic) / the night factor. */
  forceLevel: number | null = null;
  forceNight: number | null = null;
  /** Tests: no camera cuts for set pieces. */
  cuts = true;

  constructor(private raid: RaidScene) {}
  now() { return this.manual ? this.clock : Date.now(); }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const cfg = (rt.info as unknown as { warzone?: WarzoneCfg }).warzone;
    if (!cfg || cfg.on === false) return;
    this.rt = rt; this.cfg = cfg;
    const h = rt.info.raid?.npcHeight ?? (rt.info.avatarHeight ?? 1.5) * 1.08;
    this.A = parseWarzoneRoom(rt.room, cfg, Math.max(1.2, Math.min(2.2, h)), rt.info.defaultCamera ?? 'CAM_WIDE');
    this.plan = new WarzonePlan(this.A, (cfg.seed ?? 17) | 0);
    this.plan.level = Math.min(2, Math.max(0.25, cfg.level ?? 1));
    this.fx = new WarzoneFx();
    rt.root.add(this.fx.group);
    // the militia's RPGs in the raid fights: a rocket with a smoke trail instead of a tracer
    this.offs.push(registerWeaponFx('rpg', (s) => { this.rockets.push({ from: s.muzzle.clone(), to: s.end.clone(), t0: s.t / 1000, seed: s.seed }); if (this.rockets.length > 16) this.rockets.shift(); return true; }));
    // after dark the riflemen wear their night-vision units
    setRaidUnitAlias((u) => (this.night > 0.55 && u === 'frog_rifle' ? 'frog_nvg' : u));
    // set-piece camera cuts: wrap whatever the raid director put there
    const hook = rt as unknown as { cameraOverride?: ((aspect: number) => { key: string; pose: CamPose; secs: number } | null) | null };
    this.prevOverride = hook.cameraOverride ?? null;
    hook.cameraOverride = (aspect) => this.cut() ?? this.prevOverride?.(aspect) ?? null;
    this.loadVehicles();
  }

  detach() {
    if (!this.rt) return;
    const hook = this.rt as unknown as { cameraOverride?: unknown };
    hook.cameraOverride = this.prevOverride;
    this.prevOverride = null;
    for (const f of this.offs) f();
    this.offs = [];
    setRaidUnitAlias(null);
    for (const v of this.insts.values()) { v.crew?.dispose(); v.obj.removeFromParent(); for (const m of v.mats) m.dispose(); }
    this.insts.clear();
    for (const l of this.labels.values()) { l.sprite.removeFromParent(); l.tex.dispose(); (l.sprite.material as THREE.Material).dispose(); }
    this.labels.clear();
    this.sniper?.dispose(); this.sniper = null;
    this.fx?.dispose(); this.fx = null;
    this.rt = null; this.A = null; this.plan = null;
    this.rockets = []; this.stampCache.clear();
  }

  private loadVehicles() {
    if (this.veh || this.vehLoading) return;
    this.vehLoading = true;
    new GLTFLoader().loadAsync(VEH_URL).then((g) => {
      const tmpl = new Map<string, THREE.Object3D>();
      for (const o of g.scene.children) { const m = /^VEH_([a-z0-9]+)$/.exec(o.name); if (m) tmpl.set(m[1], o); }
      this.veh = { tmpl };
      this.warmVehicles();
    }).catch((e) => { console.warn('[warzone] vehicles unavailable', e); this.veh = { tmpl: new Map() }; }).finally(() => { this.vehLoading = false; });
  }

  /** Compile the vehicle + effect programs off the critical path, so the first technical / strike never hitches. */
  private warmVehicles() {
    const rt = this.rt;
    if (!rt || !this.veh) return;
    const seen = new Set<string>();
    const tmp: VehInst[] = [];
    for (const k of this.veh.tmpl.keys()) { const v = this.inst(`warm:${k}`, k, seen); if (v) { v.obj.position.set(0, -800, 0); tmp.push(v); } }
    const r = rt.stage.renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> };
    let done: Promise<unknown>;
    try { done = r.compileAsync ? r.compileAsync(rt.root, rt.stage.camera, rt.stage.scene) : Promise.resolve(r.compile(rt.root, rt.stage.camera, rt.stage.scene)); } catch { done = Promise.resolve(); }
    void done.catch(() => {}).finally(() => { for (const v of tmp) { v.crew?.dispose(); v.obj.removeFromParent(); for (const m of v.mats) m.dispose(); this.insts.delete(`warm:${v.kind}`); } });
  }

  // ------------------------------------------------------------------------------------------ support hooks
  /** Channel-point rewards (a system chat line "redeemed <title>", Kick today; any bridge can post one): keyword → set piece. */
  onChat(evs: { kind?: string; platform?: string; ts?: number; id?: string; user?: string; text?: string; ev?: string; label?: string }[], snap: boolean) {
    if (snap || !this.plan) return;
    const nowS = this.now() / 1000;
    for (const e of evs) {
      if (!(e.kind === 'system' && (e.ev === 'reward' || /^redeemed\b/i.test(e.text ?? '')))) continue;
      const title = (e.label || (e.text ?? '').replace(/^redeemed\s*/i, '')).slice(0, 60);
      const kind = this.rewardKind(title);
      if (!kind) continue;
      const ts = typeof e.ts === 'number' ? e.ts / 1000 : nowS;
      const at = (Math.abs(nowS - ts) < 60 ? ts : nowS) + 1.5;
      const id = `rw:${e.id ?? Math.round(ts * 1000)}`;
      if (this.localStamps.some((s) => s.id === `sp:${id}`)) continue;
      const ev = this.plan.setPiece(kind, at, id, { user: (e.user ?? '').slice(0, 24) });
      if (ev) { this.localStamps.push(ev); if (this.localStamps.length > 24) this.localStamps.shift(); }
    }
  }
  rewardKind(title: string): string | null {
    const map = this.cfg.rewards ?? {};
    const t = title.toLowerCase();
    for (const k of Object.keys(map).sort((a, b) => b.length - a.length)) if (t.includes(k.toLowerCase()) && (SET_PIECES as readonly string[]).includes(map[k])) return map[k];
    for (const [re, k] of REWARD_WORDS) if (re.test(title)) return k;
    return null;
  }
  /** The set piece a support of this size buys (scene.json warzone.support tiers). */
  tierFor(usd: number, big: boolean): string {
    if (big) return 'wz_airstrike';
    const tiers = Object.entries({ ...DEFAULT_SUPPORT, ...(this.cfg.support ?? {}) }).filter(([k]) => (SET_PIECES as readonly string[]).includes(k)).sort((a, b) => a[1] - b[1]);
    let pick = 'wz_mortar';
    for (const [k, min] of tiers) if (usd >= min) pick = k;
    return pick;
  }
  /** Tests (this page only): one effect of a plan kind ('mortar', 'skystrike', 'flare' …) at a point, in `inSec` seconds. */
  testAt(kind: string, p: [number, number, number], inSec = 0.5, mag = 1, q?: [number, number, number]) {
    const t0 = this.now() / 1000 + inSec;
    const ev = { id: `ta:${kind}:${Math.round(t0 * 1000)}`, kind: kind as Ev['kind'], t0, dur: 180, seed: hash32(kind, Math.round(t0 * 1000)), mag, p: V(...p), ...(q ? { q: V(...q) } : {}) } as Ev;
    this.localStamps.push(ev);
    return ev;
  }
  /** Tests (this page only): a set piece in `inSec` seconds. */
  test(kind: string, inSec = 1, user = 'TestViewer', amount = '') {
    if (!this.plan) return null;
    const k = kind.startsWith('wz_') ? kind : `wz_${kind}`;
    const ev = this.plan.setPiece(k, this.now() / 1000 + inSec, `test:${k}:${Math.round(this.now())}`, { user, amount });
    if (ev) this.localStamps.push(ev);
    return ev;
  }

  /** The host's stamped raid events that are ours (wz_* / donations in a warzone room) → set pieces. */
  private stamps(): Ev[] {
    const st = this.rt?.state.raid;
    const out: Ev[] = [...this.localStamps];
    if (!st || !this.plan) return out;
    const don = this.rt!.info.raid?.donationEvent;
    for (const e of st.events) {
      const key = `${e.k}:${e.id}:${e.at}`;
      let ev = this.stampCache.get(key);
      if (ev === undefined) {
        let kind: string | null = (SET_PIECES as readonly string[]).includes(e.k) ? e.k : null;
        if (e.k === 'donation' && (don === 'wz_support' || don?.startsWith('wz_'))) kind = this.tierFor(e.usd ?? parseUsd(e.amount), !!e.big);
        if (e.k === 'wz_support') kind = this.tierFor(e.usd ?? parseUsd(e.amount), !!e.big);
        ev = kind ? this.plan.setPiece(kind, e.at / 1000 + 0.6, e.id, { user: e.user, amount: e.amount, big: e.big }) : null;
        this.stampCache.set(key, ev);
        if (this.stampCache.size > 64) this.stampCache.delete(this.stampCache.keys().next().value!);
      }
      if (ev) out.push(ev);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number) {
    if (!this.rt || !this.fx || !this.plan) return;
    const t0 = performance.now();
    try { this.step(dt); } catch (e) { console.warn('[warzone] frame failed', e); }
    const ms = performance.now() - t0;
    const P = this.perf;
    P.avg = P.avg * 0.97 + ms * 0.03; P.peak = Math.max(P.peak * 0.995, ms);
    if (ms > 2.4) { P.slowFor += dt; P.goodFor = 0; } else { P.goodFor += dt; P.slowFor = 0; }
    if (P.slowFor > 2 && P.level < 2) { P.level++; P.slowFor = 0; }
    if (P.goodFor > 20 && P.level > ((this.rt?.opts.tier ?? 'high') === 'low' ? 1 : 0)) { P.level--; P.goodFor = 0; }
    if (this.forceLevel !== null) P.level = this.forceLevel;
  }

  private step(dt: number) {
    const rt = this.rt!, fx = this.fx!, plan = this.plan!, A = this.A!;
    if (this.manual) this.clock += dt * 1000;
    const t = this.now() / 1000;
    const cam = rt.stage.camera;
    const st = rt.state.raid;
    // calm (the streamer is talking): remember when it started on this page
    const calm = st?.calm === true;
    if (calm && this.calmSince === null) this.calmSince = t; else if (!calm) this.calmSince = null;
    // light + night from the room's environment
    const w = activeEnv()?.townWeather() ?? null;
    this.night = this.forceNight ?? (w ? w.night : 0);
    const night = this.night > 0.5;
    const u = fx.u;
    const H = rt.stage.renderer.domElement.height || 1080, W = rt.stage.renderer.domElement.width || 1920;
    u.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / H;
    u.uRes.value.set(W, H);
    const sun = EU.uEnvSunDir.value, sc = EU.uEnvSunCol.value, lit = EU.uEnvLit.value;
    if (w) {
      u.uSunV.value.copy(sun).transformDirection(cam.matrixWorldInverse);
      const sk = Math.max(sc.x, sc.y, sc.z) > 0.01 ? 1 : 0;
      u.uSunCol.value.setRGB(sc.x, sc.y, sc.z).multiplyScalar(0.55 * sk);
      u.uAmb.value.setRGB(lit.x, lit.y, lit.z).multiplyScalar(0.62).addScalar(0.03);
    } else {
      u.uSunV.value.set(0.4, 0.8, 0.3).normalize().transformDirection(cam.matrixWorldInverse);
      u.uSunCol.value.setRGB(0.55, 0.5, 0.42); u.uAmb.value.setRGB(0.55, 0.53, 0.5);
    }
    const fog = rt.stage.scene.fog as THREE.Fog | null;
    if (fog && (fog as THREE.Fog).isFog) { u.uFogCol.value.copy(fog.color); u.uFog.value.set(fog.near, fog.far); } else u.uFog.value.set(1e5, 2e5);
    fx.level = this.perf.level;
    fx.begin(t);
    this.pools.length = 0;
    this.flash.setRGB(0, 0, 0);
    // everything that happens now
    const stamps = this.stamps();
    // the ambient battle follows the Raid panel's "Background skirmishes" switch; set pieces + fires always play
    const evs = plan.active(t, night, this.calmSince, stamps, st?.on !== false);
    this.evCount = evs.length;
    const seen = new Set<string>();
    for (const e of evs) this.draw(e, t, seen);
    for (let i = this.rockets.length - 1; i >= 0; i--) { const r = this.rockets[i]; if (t - r.t0 > 30) { this.rockets.splice(i, 1); continue; } this.rocket(r.from, r.to, t - r.t0, r.seed, 75, 0.6); }
    this.fires(t);
    this.sniperNpc(t, dt, evs);
    // vehicles no longer in any event go away
    for (const [id, v] of this.insts) if (!seen.has(id)) { v.crew?.dispose(); v.obj.removeFromParent(); for (const m of v.mats) m.dispose(); this.insts.delete(id); }
    for (const [id, l] of this.labels) if (!seen.has(`label:${id}`)) { l.sprite.removeFromParent(); l.tex.dispose(); (l.sprite.material as THREE.Material).dispose(); this.labels.delete(id); }
    fx.end();
    this.lights();
    this.holdT -= dt;
    if (this.holdT <= 0) { this.holdT = 0.25; this.holds(); }
    this.applyShake(dt);
  }

  // ------------------------------------------------------------------------------------------ drawing
  private draw(e: Ev, t: number, seen: Set<string>) {
    const age = t - e.t0;
    switch (e.kind) {
      case 'mortar': this.blast(e.p, age, e.mag, e.seed, true); break;
      case 'cannon': {
        if (e.q && age < 0.4 && age >= 0) this.muzzle(e.q, tv.copy(e.p).sub(e.q).normalize(), 1.6, e.seed);
        if (e.q && age >= 0 && age < 0.25) this.fx!.line(tv2.copy(e.q).lerp(e.p, clamp01(age / 0.25) * 0.8), tv3.copy(e.q).lerp(e.p, clamp01(age / 0.25)), 0.08, 2, 3, 1.8, 0.8, 1);
        this.blast(e.p, age - 0.25, e.mag, e.seed, true);
        break;
      }
      case 'rpg': if (e.q) this.rocket(e.p, e.q, age, e.seed, 70, 0.75); break;
      case 'rocket': if (e.q) this.rocket(e.q, e.p, age, e.seed, 130, 1.1); break;
      case 'burst': this.burst(e, age); break;
      case 'skystrike': this.skystrike(e.p, age, e.mag, e.seed); break;
      case 'aaa': this.aaa(e, age); break;
      case 'flare': this.flare(e, age); break;
      case 'sniper': this.sniperShots(e, age); break;
      case 'jet': this.jets(e, age, seen, 1); break;
      case 'airstrike': this.jets(e, age, seen, 2); break;
      case 'heli': this.heli(e, age, seen); break;
      case 'drone': this.drone(e, age, seen); break;
      case 'technical': this.technical(e, age, seen); break;
      case 'armor': this.armor(e, age, seen); break;
      case 'barrage': case 'assault': break;
    }
    if ((e.user || e.big) && e.label && age > -1 && age < 12) { seen.add(`label:${e.id}`); this.label(e, age); }
  }

  /** A shell / bomb / rocket hitting the ground: every layer of a real-feeling blast, then it burns down to a scorch. */
  private blast(p: THREE.Vector3, age: number, mag: number, seed: number, ground: boolean) {
    if (age < 0 || age > 45) return;
    const fx = this.fx!, r = new Rng(seed);
    const m = mag, lvl = this.perf.level;
    const wind = V(envWind.x || 1.2, 0, envWind.z || 0.4);
    if (age < 0.12) fx.sprite(p.clone().addScaledVector(UP, 0.6 * m), 3.2 * m, 2.2, 1.8, 1.3, 1 - age / 0.12, GLOW.core, seed);
    if (age < 1.2) {
      for (let i = 0; i < 6; i++) {
        const d = V(r.range(-1, 1), r.range(0.2, 1), r.range(-1, 1)).normalize();
        const k = 1 - Math.exp(-age * 5);
        fx.sprite(tv.copy(p).addScaledVector(d, (0.4 + 2.4 * k) * m).addScaledVector(UP, age * 2.5 * m), (0.9 + 2.2 * k) * m * r.range(0.8, 1.2), 1.45, 1.0, 0.62, Math.pow(1 - age / 1.2, 1.6), GLOW.fire, r.next());
      }
    } else r.next();
    if (age < 0.5) fx.sprite(tv.copy(p).addScaledVector(UP, 0.4), (1.5 + age * 30) * m, 0.9, 0.8, 0.7, (1 - age / 0.5) * 0.45, GLOW.ring, seed);
    // sparks
    if (age < 1.4 && lvl < 2) {
      const r2 = new Rng(seed ^ 0x77);
      for (let i = 0; i < 16; i++) {
        const v = V(r2.range(-1, 1), r2.range(0.6, 1.6), r2.range(-1, 1)).multiplyScalar(r2.range(7, 18) * Math.sqrt(m));
        const a = age * r2.range(0.8, 1.1);
        tv.set(p.x + v.x * a, p.y + 0.3 + v.y * a - 0.5 * G * a * a, p.z + v.z * a);
        if (tv.y > p.y) fx.sprite(tv, 0.09 * m, 3, 1.9, 0.9, (1 - age / 1.4), GLOW.spark, r2.next());
      }
    }
    // the dust column
    const r3 = new Rng(seed ^ 0x1234);
    const dustN = lvl >= 1 ? 7 : 12;
    for (let i = 0; i < dustN; i++) {
      const v = V(r3.range(-0.5, 0.5), r3.range(0.7, 1.3), r3.range(-0.5, 0.5)).multiplyScalar(r3.range(5, 11) * Math.sqrt(m));
      const life = r3.range(24, 42), a = age - i * 0.02;
      if (a <= 0 || a > life) continue;
      const k = (1 - Math.exp(-1.7 * a)) / 1.7;
      tv.set(p.x + v.x * k + wind.x * a * 0.8, p.y + v.y * k + a * 0.35, p.z + v.z * k + wind.z * a * 0.8);
      const hgt = clamp01((tv.y - p.y) / (6 * m));
      const g = 0.56 - hgt * 0.26 + r3.range(-0.04, 0.04);
      fx.puff(tv, (0.8 + 2.3 * (1 - Math.exp(-a * 0.7)) + a * 0.06) * m * r3.range(0.85, 1.2), g, g * 0.84, g * 0.64, 0.85 * smooth(a / 0.15) * Math.pow(1 - a / life, 1.3), Math.max(0, 1 - a / 1.3), r3.next());
    }
    // skirt: the ground surge
    if (ground) for (let i = 0; i < (lvl >= 1 ? 5 : 8); i++) {
      const ang = (i / 8) * Math.PI * 2 + r3.range(-0.3, 0.3), a = age;
      if (a > 18) continue;
      const d = (7 * m * (1 - Math.exp(-2 * a))) / 1.2;
      tv.set(p.x + Math.cos(ang) * d + wind.x * a * 0.5, p.y + 0.35 + a * 0.08, p.z + Math.sin(ang) * d + wind.z * a * 0.5);
      fx.puff(tv, (0.9 + 1.6 * (1 - Math.exp(-a))) * m, 0.5, 0.44, 0.35, 0.7 * smooth(a / 0.1) * (1 - a / 18), 0, r3.next());
    }
    // smoulder
    if (age > 1.5 && age < 40) for (let i = 0; i < 3; i++) {
      const life = 9, a = ((age + i * 3) % life);
      tv.set(p.x + wind.x * a * 0.6 + (i - 1) * 0.4, p.y + 0.3 + a * 0.9, p.z + wind.z * a * 0.6);
      fx.puff(tv, (0.3 + a * 0.18) * m, 0.2, 0.19, 0.18, 0.45 * smooth(a / 1.2) * (1 - a / life) * (1 - age / 40), 0, i * 0.37 + seed * 1e-9);
    }
    // debris
    if (lvl < 2) {
      const r4 = new Rng(seed ^ 0xbeef);
      for (let i = 0; i < 14; i++) {
        const vy = r4.range(3.5, 9) * Math.sqrt(m), vh = r4.range(2, 6.5) * Math.sqrt(m), ang = r4.range(0, 6.283);
        const tl = (2 * vy) / G, a = Math.min(age, tl);
        const sz = r4.range(0.07, 0.3) * m;
        const shade = r4.range(0.16, 0.34);
        const sink = age > 20 ? (age - 20) * 0.02 : 0;
        tv.set(p.x + Math.cos(ang) * vh * a, p.y + vy * a - 0.5 * G * a * a + sz * 0.3 - sink, p.z + Math.sin(ang) * vh * a);
        te.set(a * r4.range(-9, 9), a * r4.range(-9, 9), a * r4.range(-9, 9));
        if (age < 26) fx.chunk(tv, sz, tq.setFromEuler(te), shade);
      }
    }
    if (ground) fx.scorch(p, 2.2 * m, 0.8 * (1 - age / 45), Math.max(0, 1 - age / 6), seed * 1e-9);
    if (age < 0.8) this.pools.push({ p: p.clone().addScaledVector(UP, 2.5), r: 26 * m, c: new THREE.Color(1.9, 0.9, 0.35).multiplyScalar(Math.pow(1 - age / 0.8, 2) * 1.6) });
    this.shakeFrom(p, age, 0.35 * m);
    this.interiorDust(p, age, m);
  }

  /** A distant heavy strike on the skyline: flash, a rising fireball, a mushroom that drifts and thins for minutes. */
  private skystrike(p: THREE.Vector3, age: number, mag: number, seed: number) {
    if (age < 0 || age > 170) return;
    const fx = this.fx!, r = new Rng(seed);
    // (heavier look on the far skyline, where it must read at 300–600 m; a bomb down the street stays street-sized)
    const dist = Math.min(...this.A!.spots.map((q) => q.distanceTo(p)));
    const M = mag * (1.5 + 3.5 * clamp01((dist - 40) / 260));
    const wind = V(envWind.x || 1.5, 0, envWind.z || 0.5).multiplyScalar(1.6);
    if (dist < 150) this.blast(p, age, mag * 1.4, seed ^ 0x3c, true);
    if (age < 0.25) fx.sprite(tv.copy(p).addScaledVector(UP, M), 6 * M, 2.4, 1.7, 1.0, 1 - age / 0.25, GLOW.core, seed);
    if (age < 0.9) fx.sprite(tv.copy(p).addScaledVector(UP, M * 0.6), (3 + age * 90) * M * 0.2, 1, 0.85, 0.7, (1 - age / 0.9) * 0.4, GLOW.ring, seed);
    if (age < 4) for (let i = 0; i < 7; i++) {
      const d = V(r.range(-1, 1), r.range(0.3, 1.2), r.range(-1, 1)).normalize();
      const k = 1 - Math.exp(-age * 2);
      fx.sprite(tv.copy(p).addScaledVector(d, (0.5 + 1.6 * k) * M).addScaledVector(UP, age * 1.8 * M), (1.0 + 1.4 * k) * M, 1.5, 0.95, 0.55, Math.pow(1 - age / 4, 1.5), GLOW.fire, r.next());
    }
    // stem + cap (the mushroom)
    const top = Math.min(1, 1 - Math.exp(-age / 9)) * 11 * M;
    const n = this.perf.level >= 1 ? 9 : 16;
    const r2 = new Rng(seed ^ 0x99);
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const cap = f > 0.7;
      const ang = r2.range(0, 6.283), rad = cap ? (0.6 + 1.6 * (1 - Math.exp(-age / 12))) * M * r2.range(0.5, 1) : r2.range(0, 0.4) * M;
      const h = f * top;
      tv.set(p.x + Math.cos(ang) * rad + wind.x * age * (0.3 + f), p.y + h, p.z + Math.sin(ang) * rad + wind.z * age * (0.3 + f));
      const g = 0.22 + (cap ? 0.12 : 0.05) + r2.range(-0.03, 0.03);
      const size = ((cap ? 1.4 : 0.9) + age * 0.035) * M * r2.range(0.8, 1.2);
      fx.puff(tv, size, g * 1.05, g, g * 0.92, 0.9 * smooth(age / 0.8) * Math.pow(1 - age / 170, 1.2), Math.max(0, 1 - age / 5) * (1 - f * 0.6), r2.next());
    }
    if (age < 1.2) { const k = Math.pow(1 - age / 1.2, 2) * Math.min(1, mag / 2) * clamp01(1.4 - p.distanceTo(this.A!.battle) / 700); this.flash.r += k * 0.2; this.flash.g += k * 0.11; this.flash.b += k * 0.04; }
    if (age < 1.5) this.pools.push({ p: p.clone().addScaledVector(UP, M * 2), r: 30 * M, c: new THREE.Color(2.4, 1.2, 0.45).multiplyScalar(Math.pow(1 - age / 1.5, 2)) });
    this.shakeFrom(p, age - p.distanceTo(this.rt!.stage.camera.position) / 340, 0.7 * mag);
  }

  /** A rocket: launch flash + backblast, the motor + a smoke trail that lingers, then a blast where it lands. */
  private rocket(from: THREE.Vector3, to: THREE.Vector3, age: number, seed: number, speed: number, mag: number) {
    if (age < 0) return;
    const fx = this.fx!, r = new Rng(seed);
    const dir = tv3.copy(to).sub(from);
    const L = dir.length();
    if (L < 0.5) return;
    dir.divideScalar(L);
    const T = L / speed;
    const wind = V(envWind.x || 1.2, 0, envWind.z || 0.4);
    if (age < 0.12) this.muzzle(from, dir, 1.4, seed);
    if (age < 7) for (let i = 0; i < 5; i++) {         // backblast
      const a = age, d = (3 * (1 - Math.exp(-3 * a))) / 1;
      tv.copy(from).addScaledVector(dir, -d * r.range(0.6, 1.1)).add(V(r.range(-0.6, 0.6), r.range(-0.2, 0.6) + a * 0.3, r.range(-0.6, 0.6)));
      fx.puff(tv, (0.4 + a * 0.35) * r.range(0.8, 1.2), 0.72, 0.7, 0.66, 0.6 * (1 - a / 7), Math.max(0, 1 - a * 5), r.next());
    }
    const arc = (s: number) => Math.sin(Math.PI * s) * Math.min(3, L * 0.03);
    const flown = Math.min(age, T) * speed;
    // trail: a puff every 0.9 m of flight, each ageing from when the rocket passed
    const step = this.perf.level >= 1 ? 1.8 : 0.9;
    for (let s = 1; s < flown; s += step) {
      const pa = age - s / speed;
      if (pa > 9) continue;
      const f = s / L;
      tv.copy(from).addScaledVector(dir, s).addScaledVector(UP, arc(f)).addScaledVector(wind, pa * 0.4);
      fx.puff(tv, 0.18 + pa * 0.14, 0.82, 0.8, 0.76, 0.55 * (1 - pa / 9) * smooth(pa / 0.08), Math.max(0, 1 - pa * 6), (s * 0.137 + seed * 1e-9) % 1);
    }
    if (age < T) {
      tv.copy(from).addScaledVector(dir, flown).addScaledVector(UP, arc(flown / L));
      fx.sprite(tv, 0.35, 3, 2.2, 1.2, 1, GLOW.core, 0.3);
      fx.line(tv2.copy(tv).addScaledVector(dir, -1.4), tv, 0.06, 2.2, 2.8, 1.6, 0.6, 1, false);
      this.pools.push({ p: tv.clone(), r: 6, c: new THREE.Color(1.4, 0.8, 0.3) });
    }
    this.blast(to, age - T, mag, seed ^ 0x51, true);
  }

  /** photosensitivity: with the flash limit on, one muzzle flash per spot every 360 ms (the DShK's 5 Hz bursts slow down) */
  private flashGate = new SpotFlashGate();
  private muzzle(p: THREE.Vector3, dir: THREE.Vector3, size: number, seed: number) {
    const fx = this.fx!;
    if (!this.flashGate.allow(p.x, p.y, p.z, performance.now())) return;
    fx.sprite(p, 0.35 * size, 3, 2.2, 1.1, 1, GLOW.flare, seed);
    fx.sprite(tv2.copy(p).addScaledVector(dir, 0.3 * size), 0.25 * size, 2.6, 1.6, 0.6, 0.9, GLOW.fire, seed * 1e-9);
  }

  /** A burst of tracers between two far blocks (red-orange from the frogs, green from the militia). */
  private burst(e: Ev, age: number) {
    if (!e.q || age < 0) return;
    const fx = this.fx!, r = new Rng(e.seed);
    const n = 3 + r.int(8);
    const frog = e.side === 'frog';
    const col = frog ? [3, 1.1, 0.35] : [0.9, 2.6, 0.8];
    const from = e.p, dir = tv3.copy(e.q).sub(from);
    const L = dir.length(); dir.divideScalar(L);
    const nightK = 0.6 + this.night * 0.8;
    for (let i = 0; i < n; i++) {
      const a = age - i * 0.09;
      if (a < 0) continue;
      if (a < 0.05) fx.sprite(from, 0.5, 3, 2.2, 1.2, 0.8 * nightK, GLOW.flare, i * 0.1);
      const d = a * 340;
      if (d > L + 10) continue;
      const sp = r.range(-1, 1) * 0.02;
      tv.copy(from).addScaledVector(dir, Math.min(L, d)).add(V(sp * d, sp * d * 0.5, -sp * d));
      tv2.copy(tv).addScaledVector(dir, -Math.min(d, 16));
      fx.line(tv2, tv, 0.05, 1.3, col[0], col[1], col[2], 0.9 * nightK, false);
      if (d >= L && d < L + 10 && r.chance(0.4)) fx.sprite(e.q, 0.3, 2.5, 2, 1.2, 0.7, GLOW.spark, i * 0.2);
    }
  }

  /** Night: AA fire from the far blocks, a wavering stream of tracers and flak bursts up high. */
  private aaa(e: Ev, age: number) {
    if (age < 0) return;
    const fx = this.fx!, r = new Rng(e.seed);
    const base = e.p;
    const az = r.range(0, 6.283), el = r.range(0.9, 1.25);
    for (let i = 0; i < 16; i++) {
      const a = age - i * 0.14;
      if (a < 0 || a > 2.2) continue;
      const wob = Math.sin((i * 0.14 + e.t0) * 2.3) * 0.12;
      const d = V(Math.cos(az + wob) * Math.cos(el), Math.sin(el), Math.sin(az + wob) * Math.cos(el));
      tv.copy(base).addScaledVector(d, a * 260); tv.y -= 0.5 * G * a * a;
      tv2.copy(tv).addScaledVector(d, -14);
      fx.line(tv2, tv, 0.08, 1.4, 2.8, 1.0, 0.4, 0.9, false);
      if (a > 1.9 && r.chance(0.35)) { fx.sprite(tv, 3, 2.6, 2, 1.2, (2.2 - a) / 0.3, GLOW.flare, i); fx.puff(tv, 2.5, 0.2, 0.2, 0.2, 0.5, 0.6, i * 0.3); }
    }
  }

  /** An illumination flare: launched, pops high, drifts down under its parachute lighting the whole street. */
  private flare(e: Ev, age: number) {
    if (age < 0) return;
    const fx = this.fx!, r = new Rng(e.seed);
    const ground = V(e.p.x + r.range(-20, 20), this.A!.floorY, e.p.z + r.range(-20, 20));
    const climb = 1.8;
    if (age < climb) {
      tv.copy(ground).lerp(e.p, smooth(age / climb));
      fx.line(tv2.copy(tv).addScaledVector(UP, -6), tv, 0.06, 1.4, 2.6, 1.8, 1.0, 0.8, false);
      return;
    }
    const a = age - climb, life = e.dur - climb;
    const sway = V(Math.sin(a * 0.7 + e.seed % 7) * 3, 0, Math.cos(a * 0.5 + e.seed % 5) * 2);
    const p = tv.copy(e.p).addScaledVector(UP, -a * 1.1).add(sway).addScaledVector(V(envWind.x || 1, 0, envWind.z || 0.3), a * 0.8);
    const k = smooth(a / 0.6) * (1 - smooth((a - life + 4) / 4));
    // (the flare's flicker lights a 150 m pool: steady while the flash limit is on)
    const fl = pageGovernor().safe ? 1 : 0.85 + 0.15 * Math.sin(a * 23 + e.seed) * Math.sin(a * 7.3);
    const c = 0.6 + this.night * 0.8;
    fx.sprite(p, 1.1 * e.mag, 4, 3.8, 3.2, k * fl, GLOW.flare, a * 0.01);
    fx.sprite(p, 16 * e.mag, 1, 0.9, 0.7, k * 0.28 * c, GLOW.soft, 0);
    for (let i = 0; i < 8; i++) {                        // the smoke it leaves above it
      const s = i * 1.6 + 1;
      const pa = s / 2.4;
      if (pa > a) break;
      tv2.copy(p).addScaledVector(UP, s).add(V(Math.sin(i) * 0.4, 0, Math.cos(i) * 0.4));
      fx.puff(tv2, 0.6 + pa * 0.25, 0.75, 0.74, 0.72, 0.35 * k * (1 - i / 8), 0.4 * (1 - i / 8), i * 0.13);
    }
    this.pools.push({ p: p.clone(), r: 150 * e.mag, c: new THREE.Color(1.0, 0.95, 0.82).multiplyScalar(1.5 * k * fl * c) });
  }

  // ---- vehicles ---------------------------------------------------------------------------------------------------
  private inst(id: string, kind: string, seen: Set<string>): VehInst | null {
    seen.add(id);
    let v = this.insts.get(id);
    if (v) return v;
    const tp = this.veh?.tmpl.get(kind);
    if (!tp) return null;
    const obj = tp.clone(true);
    const mats: THREE.MeshToonMaterial[] = [];
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const src = m.material as THREE.MeshStandardMaterial;
      const mt = new THREE.MeshToonMaterial({ color: src.color?.clone() ?? new THREE.Color(1, 1, 1), map: src.map ?? null, vertexColors: !!m.geometry.getAttribute('color'), transparent: false });
      mt.color.multiplyScalar(0.82);        // (the toon ramp lifts flat paint: keep the vehicles from reading white in the sun)
      mt.userData.base = mt.color.clone();
      m.material = mt; mats.push(mt);
    });
    const find = (re: RegExp) => { const out: THREE.Object3D[] = []; obj.traverse((o) => { if (re.test(o.name)) out.push(o); }); return out; };
    v = { obj, kind, wheels: find(/wheel/i), rotors: find(/rotor|prop/i), turret: find(/turret/i)[0] ?? null, mats, seen: 0, crew: null };
    // the technical's gunner stands behind the pedestal gun (turns with it)
    const A = this.raid.assets;
    if (kind === 'technical' && v.turret && A?.templates.has('militia_mg')) {
      const n = new Npc(A, 'militia_mg', '', v.turret);
      n.root.scale.setScalar(this.A!.raid.sim.scale / Math.max(0.01, v.turret.getWorldScale(tv).x));
      n.root.position.set(0, 0.02, -0.72);
      const c = A.clips.get('aim');
      if (c) { n.play(c, 0.4, 0); n.pose(0, 0.1, 0); }
      v.crew = n;
    }
    obj.name = `vtp:warzone:${kind}`;
    this.rt!.root.add(obj);
    this.insts.set(id, v);
    return v;
  }
  private place(v: VehInst, p: THREE.Vector3, dir: THREE.Vector3, bank = 0, pitch = 0) {
    v.obj.position.copy(p);
    v.obj.rotation.set(pitch, Math.atan2(dir.x, dir.z), bank, 'YXZ');
  }

  private technical(e: Ev, age: number, seen: Set<string>) {
    if (age < 0) return;
    const plan = this.plan!, path = e.path ?? this.A!.road;
    const T = plan.routeTime(e);
    const kill = e.kill ?? -1;
    const tk = kill > 0 ? kill * T : Infinity;
    const u = Math.min(age, tk) / T;
    if (u >= 1) return;
    const dir = V();
    const p = plan.along(path, u, V(), dir);
    const v = this.inst(e.id, 'technical', seen);
    const dead = age >= tk;
    if (v) {
      this.place(v, p, dir, dead ? 0.06 : Math.sin(age * 3) * 0.01);
      for (const wh of v.wheels) wh.rotation.x = -(Math.min(age, tk) * 9) / 0.4;
      for (const m of v.mats) m.color.copy(m.userData.base as THREE.Color).multiplyScalar(dead ? 0.07 : 1);
      if (v.turret && !dead) { const tgt = (this.A!.sideA[0] ?? this.A!.battle); tv.copy(tgt).sub(p); v.turret.rotation.y = Math.atan2(tv.x, tv.z) - v.obj.rotation.y; }
      if (v.crew) { v.crew.root.visible = !dead || age - tk < 0.08; if (!dead) { v.crew.pose(0.016, 0.1, (age % 2.2) < 0.8 && (age % 0.12) < 0.05 ? 1 : 0); } }
    }
    const fx = this.fx!;
    if (!dead) {
      // the DShK-style gun in the bed: short heavy bursts at the frog side
      const cyc = (age % 2.2);
      if (cyc < 0.8 && age > 3) {
        const gun = tv.copy(p).addScaledVector(UP, 2.1);
        const tgt = (this.A!.sideA[hash32(e.seed, Math.floor(age / 2.2)) % Math.max(1, this.A!.sideA.length)] ?? this.A!.battle).clone().addScaledVector(UP, 1.2);
        const d = tv2.copy(tgt).sub(gun).normalize();
        if ((cyc * 10) % 1 < 0.5) this.muzzle(gun, d, 1.2, age);
        const shot = (cyc % 0.12) / 0.12;
        const L = gun.distanceTo(tgt);
        fx.line(tv3.copy(gun).addScaledVector(d, L * shot), V().copy(gun).addScaledVector(d, Math.min(L, L * shot + 10)), 0.07, 1.6, 0.9, 2.7, 0.8, 0.9, false);
        this.pools.push({ p: gun.clone(), r: 7, c: new THREE.Color(1.3, 0.9, 0.4).multiplyScalar(0.8) });
      }
      // dust kicked up behind it
      if (this.perf.level < 2) for (let i = 0; i < 5; i++) {
        const back = i * 1.3;
        fx.puff(tv.copy(p).addScaledVector(dir, -2.2 - back).addScaledVector(UP, 0.4 + back * 0.15), 0.5 + back * 0.35, 0.72, 0.66, 0.55, 0.45 * (1 - i / 5), 0, i * 0.2);
      }
    } else this.burning(p, age - tk, 1.3, e.seed, Math.max(0, 1 - (age - tk - 70) / 20));
  }

  private armor(e: Ev, age: number, seen: Set<string>) {
    if (age < 0) return;
    const plan = this.plan!, path = e.path ?? this.A!.armor;
    const T = plan.pathLen(path) / 5.5;
    const u = Math.min(1, age / T);      // (it holds at the end of its route and keeps firing)
    const dir = V();
    const p = plan.along(path, u, V(), dir);
    const v = this.inst(e.id, 'apc', seen);
    if (v) {
      this.place(v, p, dir);
      for (const wh of v.wheels) wh.rotation.x = -(Math.min(age, T) * 5.5) / 0.55;
      if (v.turret) { const tgt = this.A!.sideB[Math.floor(age / 6) % Math.max(1, this.A!.sideB.length)] ?? this.A!.battle; tv.copy(tgt).sub(p); v.turret.rotation.y = Math.atan2(tv.x, tv.z) - v.obj.rotation.y; }
    }
    const fx = this.fx!;
    if (u < 1) for (let i = 0; i < 6; i++) fx.puff(tv.copy(p).addScaledVector(dir, -3 - i * 1.1).addScaledVector(UP, 0.5 + i * 0.2), 0.7 + i * 0.35, 0.3, 0.29, 0.28, 0.35 * (1 - i / 6), 0, i * 0.3);
  }

  private heli(e: Ev, age: number, seen: Set<string>) {
    if (age < 0 || !e.path) return;
    const plan = this.plan!;
    const u = age / e.dur;
    const dir = V();
    const p = plan.along(e.path, u, V(), dir);
    p.y += Math.sin(age * 0.8) * 0.8;
    const v = this.inst(e.id, 'heli', seen);
    if (v) { this.place(v, p, dir, Math.sin(age * 0.4) * 0.12, 0.12); for (const r of v.rotors) r.rotation[/tail/i.test(r.name) ? 'x' : 'y'] = age * 40; }
    this.navLights(p, dir, age, 2.5);
  }

  private jets(e: Ev, age: number, seen: Set<string>, n: number) {
    if (!e.path || age < -1 || age > 9) return;
    const plan = this.plan!;
    const L = plan.pathLen(e.path);
    for (let j = 0; j < n; j++) {
      const a = age - j * 0.6;
      const u = (a * 190) / L;
      if (u < 0 || u > 1) continue;
      const dir = V();
      const p = plan.along(e.path, u, V(), dir).add(V(j * 14, j * 6 - 4, j * 10));
      const v = this.inst(`${e.id}:${j}`, 'jet', seen);
      if (v) this.place(v, p, dir, j ? -0.2 : 0.15, 0);
      this.fx!.sprite(tv.copy(p).addScaledVector(dir, -6), 1.2, 3, 1.6, 0.6, 0.9, GLOW.flare, j);
      this.fx!.line(tv2.copy(p).addScaledVector(dir, -60), tv3.copy(p).addScaledVector(dir, -7), 0.25, 1.2, 0.5, 0.5, 0.55, 0.35, false);
    }
  }

  private drone(e: Ev, age: number, seen: Set<string>) {
    if (age < 0) return;
    const R = 26, w = 0.28;
    const k = smooth(age / 6) * (1 - smooth((age - e.dur + 6) / 6));
    const a = age * w + (e.seed % 100) * 0.06;
    const p = V(e.p.x + Math.cos(a) * R, e.p.y + Math.sin(age * 0.3) * 2, e.p.z + Math.sin(a) * R);
    p.addScaledVector(this.A!.out, (1 - k) * 200);
    const dir = V(-Math.sin(a), 0, Math.cos(a));
    const v = this.inst(e.id, 'drone', seen);
    if (v) { this.place(v, p, dir, 0.25, 0.08); for (const r of v.rotors) r.rotation.y = age * 60; }
    this.navLights(p, dir, age, 0.6);
  }

  private navLights(p: THREE.Vector3, dir: THREE.Vector3, age: number, span: number) {
    const fx = this.fx!, side = V(-dir.z, 0, dir.x);
    const k = 0.4 + this.night * 1.2;
    fx.sprite(tv.copy(p).addScaledVector(side, span), 0.25, 3, 0.3, 0.2, k, GLOW.flare, 0);
    fx.sprite(tv.copy(p).addScaledVector(side, -span), 0.25, 0.3, 3, 0.4, k, GLOW.flare, 0);
    if ((age % 1.2) < 0.1) fx.sprite(tv.copy(p).addScaledVector(UP, -0.4), 0.45, 3, 3, 3, k, GLOW.flare, 0.5);
  }

  /** Fire + smoke column: burning wrecks (WZ_FIRE_xx) and a knocked-out technical. */
  private burning(p: THREE.Vector3, age: number, size: number, seed: number, fade = 1) {
    if (fade <= 0.01) return;
    const fx = this.fx!, t = age;
    const wind = V(envWind.x || 1.2, 0, envWind.z || 0.4);
    const r = new Rng(seed);
    for (let i = 0; i < 5; i++) {
      const fl = 0.75 + 0.25 * Math.sin(t * (7 + i * 1.7) + i) * Math.sin(t * 3.1 + i * 2);
      tv.set(p.x + r.range(-0.5, 0.5) * size, p.y + (0.3 + r.range(0, 0.6)) * size, p.z + r.range(-0.5, 0.5) * size);
      fx.sprite(tv, r.range(0.5, 0.9) * size * fl, 2.3, 1.4, 0.7, 0.85 * fade, GLOW.fire, (t * 0.3 + i * 0.21) % 1);
    }
    if (this.perf.level < 2) for (let i = 0; i < 6; i++) {
      const a = ((t * 0.6 + i / 6) % 1) * 3;
      tv.set(p.x + Math.sin(i * 3 + a) * 0.5 * size + wind.x * a * 0.4, p.y + size * 0.5 + a * 1.6, p.z + Math.cos(i * 5 + a) * 0.5 * size + wind.z * a * 0.4);
      fx.sprite(tv, 0.05 * size, 3, 1.6, 0.5, (1 - a / 3) * fade, GLOW.spark, i * 0.1);
    }
    const n = this.perf.level >= 1 ? 6 : 11, life = 16;
    for (let i = 0; i < n; i++) {
      const a = (t + (i * life) / n) % life;
      tv.set(p.x + wind.x * a * 1.1, p.y + size * 0.9 + a * 1.9, p.z + wind.z * a * 1.1);
      fx.puff(tv, (0.5 + a * 0.3) * size, 0.12, 0.115, 0.11, 0.8 * smooth(a / 1.2) * (1 - a / life) * fade, Math.max(0, 1 - a / 1.5) * 0.8, (i * 0.173 + (seed % 97) * 0.01) % 1);
    }
    this.pools.push({ p: p.clone().addScaledVector(UP, size), r: 9 * size, c: new THREE.Color(1.5, 0.75, 0.3).multiplyScalar((0.7 + 0.3 * Math.sin(t * 9) * Math.sin(t * 3.3)) * fade) });
  }

  private fires(t: number) {
    const A = this.A!;
    A.fires.forEach((f, i) => this.burning(f.p, t + i * 37, f.size, hash32('fire', i)));
    // skyline: a few big burning blocks always smoking in the distance
    const fx = this.fx!;
    for (let j = 0; j < Math.min(3, A.sky.length); j++) {
      const p = A.sky[(j * 3) % A.sky.length];
      const life = 70, n = this.perf.level >= 1 ? 6 : 10;
      for (let i = 0; i < n; i++) {
        const a = (t + (i * life) / n + j * 11) % life;
        tv.set(p.x + (envWind.x || 1.5) * a * 2, p.y + 4 + a * 2.6, p.z + (envWind.z || 0.5) * a * 2);
        fx.puff(tv, 5 + a * 0.45, 0.14, 0.13, 0.125, 0.75 * smooth(a / 4) * (1 - a / life), Math.max(0, 1 - a / 5) * 0.7, ((i + j * 5) * 0.137) % 1);
      }
      fx.sprite(tv.copy(p).addScaledVector(UP, 3), 6, 2, 1.1, 0.45, 0.6 + 0.4 * this.night, GLOW.fire, (t * 0.2 + j * 0.3) % 1);
    }
  }

  // ---- the rooftop sniper ---------------------------------------------------------------------------------------
  private sniperNpc(t: number, dt: number, evs: Ev[]) {
    const A = this.A!, S = A.sniper;
    const assets = this.raid.assets;
    if (!S || !assets || !assets.templates.has('frog_sniper')) return;
    if (!this.sniper) {
      this.sniper = new Npc(assets, 'frog_sniper', 'barrett', this.rt!.root);
      this.sniper.root.scale.setScalar(A.raid.sim.scale);
      this.sniper.root.position.copy(S.p);
      this.sniper.root.rotation.y = Math.atan2(S.dir.x, S.dir.z);
      const c = assets.clips.get('aim_crouch') ?? assets.clips.get('crouch_idle');
      if (c) this.sniper.play(c, 0, 0);
    }
    const n = this.sniper;
    let recoil = 0;
    for (const e of evs) if (e.kind === 'sniper') { const a = t - e.t0; for (let i = 0; i < e.mag; i++) { const s = a - i * 2.6; if (s >= 0 && s < 0.2) recoil = Math.max(recoil, 1 - s / 0.2); } }
    if (n.cur) n.cur.t = (t % 4);
    n.pose(dt, 0.02, recoil);
  }
  private sniperShots(e: Ev, age: number) {
    if (!e.q || age < 0) return;
    const fx = this.fx!;
    const from = this.sniper ? this.sniper.muzzleWorld(V()) : e.p.clone().addScaledVector(UP, 0.6);
    for (let i = 0; i < e.mag; i++) {
      const a = age - i * 2.6;
      if (a < 0 || a > 2) continue;
      const tgt = e.q.clone().add(V(Math.sin(i * 3.1) * 1.5, 0, Math.cos(i * 2.3) * 1.5));
      const d = tgt.clone().sub(from); const L = d.length(); d.divideScalar(L);
      if (a < 0.08) { this.muzzle(from, d, 1.8, e.seed + i); this.pools.push({ p: from.clone(), r: 6, c: new THREE.Color(1.6, 1.1, 0.6) }); }
      if (a < 1.2) fx.puff(tv.copy(from).addScaledVector(d, -0.3).addScaledVector(UP, a * 0.4), 0.3 + a * 0.8, 0.7, 0.66, 0.58, 0.5 * (1 - a / 1.2), 0, i * 0.2);
      const T = L / 900;
      if (a < T + 0.05) fx.line(tv.copy(from).addScaledVector(d, Math.max(0, a * 900 - 30)), tv2.copy(from).addScaledVector(d, Math.min(L, a * 900)), 0.03, 1.4, 3, 2.2, 1.3, 0.9, false);
      if (a >= T && a < T + 1.4) { const k = a - T; fx.puff(tv.copy(tgt).addScaledVector(UP, k * 0.6), 0.3 + k * 0.7, 0.7, 0.64, 0.55, 0.6 * (1 - k / 1.4), 0, i * 0.3); if (k < 0.1) fx.sprite(tgt, 0.5, 3, 2.4, 1.4, 1, GLOW.spark, i); }
    }
    // the scope glint (to the camera) while he's on the gun
    if (this.sniper && age < e.mag * 2.6) fx.sprite(this.sniper.headWorld(V()).addScaledVector(UP, -0.02), 0.25, 3, 3, 2.6, 0.5 + 0.5 * Math.sin(age * 5), GLOW.flare, 0.1);
  }

  // ---- label for supporters ------------------------------------------------------------------------------------
  private label(e: Ev, age: number) {
    let l = this.labels.get(e.id);
    if (!l) {
      const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
      const g = c.getContext('2d')!;
      g.fillStyle = 'rgba(20,18,14,0.72)'; g.fillRect(0, 40, 1024, 176);
      g.fillStyle = '#e8c440'; g.fillRect(0, 40, 14, 176); g.fillRect(1010, 40, 14, 176);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#f2ecdc'; g.font = `900 72px Impact, 'Arial Black', sans-serif`;
      g.fillText(e.label ?? '', 512, 100);
      const who = [e.user, e.amount].filter(Boolean).join('  ·  ');
      if (who) { let fs = 58; g.font = `800 ${fs}px Impact, 'Arial Black', sans-serif`; while (g.measureText(who).width > 960 && fs > 26) { fs -= 4; g.font = `800 ${fs}px Impact, 'Arial Black', sans-serif`; } g.fillStyle = '#e8c440'; g.fillText(who, 512, 172); }
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false }));
      sp.renderOrder = 10; sp.name = 'vtp:warzone:label';
      this.rt!.root.add(sp);
      l = { sprite: sp, id: e.id, tex };
      this.labels.set(e.id, l);
    }
    // a banner in the top-left corner of the frame (never over a face; hidden in React, where the screen owns the frame)
    const cam = this.rt!.stage.camera;
    const d = 4;
    const dir = tv.set(-0.6, 0.78, 0.5).unproject(cam).sub(cam.position).normalize();
    const h = 2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * 0.085;
    l.sprite.position.copy(cam.position).addScaledVector(dir, d);
    l.sprite.scale.set(h * 4, h, 1);
    l.sprite.visible = this.rt!.state.mode !== 'react';
    (l.sprite.material as THREE.SpriteMaterial).opacity = smooth((age + 1) / 0.6) * (1 - smooth((age - 9) / 3));
  }

  // ---- lights, holds, shake, dust ------------------------------------------------------------------------------
  private lights() {
    if (!activeEnv()) return;
    // the brightest few of this frame's light pools join the room's own (lanterns etc.) — lit room materials pick them up
    let n = EU.uEnvPoolN.value;
    const cam = this.rt!.stage.camera.position;
    const list = this.pools.map((p) => ({ p, s: (p.c.r + p.c.g + p.c.b) * p.r / Math.max(10, p.p.distanceTo(cam)) })).sort((a, b) => b.s - a.s);
    for (const { p } of list) {
      if (n >= MAX_POOLS) break;
      EU.uEnvPool.value[n].set(p.p.x, p.p.y, p.p.z, p.r);
      EU.uEnvPoolCol.value[n].set(p.c.r, p.c.g, p.c.b);
      n++;
    }
    EU.uEnvPoolN.value = n;
    if (this.flash.r + this.flash.g > 0.001) EU.uEnvFlash.value.x += Math.min(0.22, this.flash.r), EU.uEnvFlash.value.y += Math.min(0.12, this.flash.g), EU.uEnvFlash.value.z += Math.min(0.05, this.flash.b);
  }

  private holds() {
    const rt = this.rt!, cam = rt.stage.camera;
    cam.updateMatrixWorld();
    const rects: { x: number; y: number; w: number; h: number; k: number }[] = [];
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    for (const a of rt.actors.values()) {
      if (!a.shown || !a.spot) continue;
      const f = a.faceAt(a.spot);
      if (!f) continue;
      tv.copy(f.center).project(cam);
      if (tv.z >= 1) continue;
      const r = (f.size * 1.6) / (cam.position.distanceTo(f.center) * tanH) / 2;
      rects.push({ x: (tv.x + 1) / 2 - r / cam.aspect, y: (tv.y + 1) / 2 - r * 1.25, w: (2 * r) / cam.aspect, h: r * 2.5, k: 0.8 });
    }
    if (rt.state.mode === 'react' && !(this.raid as unknown as { interrupt?: boolean }).interrupt) {
      const r = rt.layout() === 'solo' ? rt.solo?.rect(cam) : rt.screen?.rect(cam);
      if (r) rects.push({ x: r.x, y: 1 - r.y - r.h, w: r.w, h: r.h, k: 1 });
    }
    this.fx!.setHolds(rects);
  }

  private shakeFrom(p: THREE.Vector3, age: number, strength: number) {
    if (age < 0 || age > 0.05) return;
    const rt = this.rt!;
    if (rt.state.raid?.calm || rt.state.raid?.shake === false || rt.state.mode === 'react') return;
    const d = Math.min(...this.A!.spots.map((s) => s.distanceTo(p)), rt.stage.camera.position.distanceTo(p));
    const k = strength * clamp01(1 - d / 140);
    if (k > this.shake) { this.shake = Math.min(0.6, k); this.shakeSeed = hash32(p.x, p.z, 'sh'); }
  }
  private applyShake(dt: number) {
    if (this.shake <= 0) return;
    this.shake = Math.max(0, this.shake - dt * 0.9);
    const cam = this.rt!.stage.camera;
    const k = this.shake * this.shake;
    const r = new Rng(this.shakeSeed + Math.floor(this.shake * 90));
    cam.position.x += r.range(-1, 1) * 0.05 * k; cam.position.y += r.range(-1, 1) * 0.04 * k;
    cam.rotation.z += r.range(-1, 1) * 0.008 * k;
    cam.updateMatrixWorld();
  }
  /** A close hit shakes dust out of the ceiling cracks (WZ_DUST_xx) — subtle, never in calm. */
  private interiorDust(p: THREE.Vector3, age: number, m: number) {
    const A = this.A!;
    if (!A.dust.length || age < 0.1 || age > 4 || this.rt!.state.raid?.calm) return;
    if (Math.min(...A.spots.map((s) => s.distanceTo(p))) > 45 * m) return;
    const fx = this.fx!, r = new Rng(hash32(p.x, p.z, 'dust'));
    for (const d of A.dust) for (let i = 0; i < 4; i++) {
      const a = age - 0.1 - i * 0.25;
      if (a < 0) continue;
      tv.set(d.x + r.range(-0.15, 0.15), d.y - a * a * 1.4, d.z + r.range(-0.15, 0.15));
      fx.puff(tv, 0.05 + a * 0.12, 0.8, 0.74, 0.62, 0.35 * (1 - a / 3.5), 0, i * 0.2);
    }
  }

  // ---- set-piece camera cuts -------------------------------------------------------------------------------------
  private cutCache: { key: string; pose: CamPose | null } | null = null;
  private cut(): { key: string; pose: CamPose; secs: number } | null {
    const rt = this.rt, A = this.A, plan = this.plan;
    if (!rt || !A || !plan || !this.cuts || !A.cams.length || rt.state.mode === 'react' || rt.state.raid?.calm) return null;
    const t = this.now() / 1000;
    for (const e of this.stamps()) {
      const win = e.kind === 'airstrike' ? [0.4, 10] : e.kind === 'armor' ? [8, 26] : e.kind === 'heli' ? [8, 20] : e.kind === 'technical' ? [4, 16] : e.kind === 'assault' ? [2, 14] : null;
      // (a non-finite start would compare false both ways and hold the cut forever: skip it)
      if (!win || !(e.user || e.big) || !Number.isFinite(e.t0) || t < e.t0 + win[0] || t > e.t0 + win[1]) continue;
      const key = `wz:${e.id}`;
      if (this.cutCache?.key !== key) {
        // the breach camera that best sees where it happens (identical on every page: room data only)
        const target = e.kind === 'airstrike' ? plan.children(e)[1]?.p ?? A.battle : A.battle;
        let best: { s: number; pose: CamPose } | null = null;
        for (const name of A.cams) {
          const pr = rt.room.cameras.get(name);
          if (!pr) continue;
          const c = new THREE.PerspectiveCamera(pr.fov, 16 / 9, 0.1, 2000);
          c.position.copy(pr.position); c.quaternion.copy(pr.quaternion); c.updateMatrixWorld(); c.updateProjectionMatrix();
          const v = target.clone().project(c);
          if (v.z >= 1 || Math.abs(v.x) > 0.95 || Math.abs(v.y) > 0.95) continue;
          const s = 2 - Math.hypot(v.x, v.y) + (hash32(e.id, name) % 100) / 1000;
          if (!best || s > best.s) best = { s, pose: { position: pr.position.clone(), quaternion: pr.quaternion.clone(), fov: pr.fov } };
        }
        this.cutCache = { key, pose: best?.pose ?? null };
      }
      if (this.cutCache.pose) return { key, pose: this.cutCache.pose, secs: 0 };
    }
    return null;
  }

  // ---- debug ----------------------------------------------------------------------------------------------------
  info() {
    if (!this.plan) return null;
    const t = this.now() / 1000;
    return { phase: this.plan.phase(t).name, intensity: +this.plan.intensity(t).toFixed(2), night: +this.night.toFixed(2), calm: this.calmSince !== null, events: this.evCount, ms: +this.perf.avg.toFixed(3) };
  }
  debug() {
    const t = this.now() / 1000;
    return {
      ...this.info(), perf: { avg: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(2), level: this.perf.level }, fx: this.fx?.counts() ?? null,
      vehicles: [...this.insts.values()].map((v) => v.kind), sniper: !!this.sniper,
      active: this.plan ? this.plan.active(t, this.night > 0.5, this.calmSince, this.stamps()).map((e) => `${e.kind}@${(t - e.t0).toFixed(1)}`) : [],
      anchors: this.A ? { road: this.A.road.length, impacts: this.A.impacts.length, rpg: this.A.rpg.length, fires: this.A.fires.length, sky: this.A.sky.length, far: this.A.far.length, dust: this.A.dust.length, sniper: !!this.A.sniper, cams: this.A.cams, sideA: this.A.sideA.length, sideB: this.A.sideB.length } : null,
    };
  }
}

function parseUsd(s?: string): number {
  if (!s) return 0;
  const m = /([\d.,]+)/.exec(s);
  return m ? parseFloat(m[1].replace(/,/g, '')) || 0 : 0;
}

// ------------------------------------------------------------------------------------------ raid events of the warzone
// The militia assault is a real fight on the raid engine (a hot skirmish, frogs vs militia); the others are drawn by
// the warzone layer from the same stamps (plan = null: the raid engine plays nothing for them).
registerRaidEvent('wz_assault', {
  available: (c) => c.room.canFight && !!c.room.sim.los,
  plan: (c, ev) => c.planSkirmishSteps(c.room.sim, { factions: ['frog', 'militia'], intensity: 'hot', seed: hash32(c.state.seed, ev.id, 'wz'), maxSecs: 170, kind: 'wz_assault' }),
  exclusive: true,
});
registerRaidEvent('wz_support', {
  available: (c) => c.room.canFight && !!c.room.sim.los,
  plan: (c, ev: RaidEventStamp) => {
    const usd = ev.usd ?? parseUsd(ev.amount);
    const tiers = { ...DEFAULT_SUPPORT };
    return usd >= tiers.wz_assault && !ev.big ? c.planSkirmishSteps(c.room.sim, { factions: ['frog', 'militia'], intensity: 'hot', seed: hash32(c.state.seed, ev.id, 'wz'), maxSecs: 170, kind: 'wz_assault' }) : null;
  },
  exclusive: true,
});
for (const k of SET_PIECES) if (k !== 'wz_assault') registerRaidEvent(k, { available: () => true, plan: () => null });
