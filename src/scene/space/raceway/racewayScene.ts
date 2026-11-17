// RacewayScene — a space race course + station defence + a living lounge for rooms with a scene.json `raceway` key
// (first user: assets/scenes/sc_grimhex, the Grim-Hex-style race deck). Attached by the page (output.ts) next to the
// other room engines; rooms without the key cost one check per frame.
//
//   racewayRoom.ts   the anchors (RACE_*, BATTLE_*, STATION_*, NPC_*, FX_*, RACE_BOARD, PA_TICKER, BAR_DROID, RW_* glows)
//   race.ts          the endless race (closed-form racers, overtakes, heats, crashes into rocks)
//   battle.ts        episodes: bounty-hunter skirmishes, the armada (a gunship torn apart), salute flybys, victory laps
//   racewayShips.ts  the fleet (instanced, liveries, cel-lit by the room's sun)
//   lounge.ts        the lounge: flickering tube, the dying I, alarms, droid, sparks / steam / confetti, RACE BOARD + PA
//   npcs.ts          the regulars (bettor, drunk, barfly, mechanic, hologram bookie)
// Reuses the space battle's effect pools (../fx.ts SpaceFx) and face hold (../ships.ts faceUniforms).
//
// Sync: everything is a pure function of the wall clock + the room + support events (the chat feed's event `ts`, the
// same on every page) + the host's raid-event stamps (Raid panel test buttons, bus / MCP `scene {raid: {event}}`):
// the studio preview, every OBS page and party guests' OBS pages show the same race, fights and bar.
import * as THREE from 'three';
import type { SceneRuntime } from '../../SceneRuntime.ts';
import { sceneFileUrl } from '../../SceneRuntime.ts';
import { gfxBudget } from '../../../stage/gfx/lod.ts';
import { hash32, Rng } from '../../raid/rng.ts';
import { registerRaidEvent } from '../../raid/raidScene.ts';
import { SPRITE, SpaceFx } from '../fx.ts';
import { FACE_SLOTS, faceUniforms } from '../ships.ts';
import { racewayRoomOf, type RacewayCfg, type RacewayRoom } from './racewayRoom.ts';
import { RacewayShips } from './racewayShips.ts';
import { Course, HEAT, Race, type RacerState } from './race.ts';
import { Battles, boom, debris, type BFrame, type Episode } from './battle.ts';
import { Lounge, type BoardData, type BoardRow } from './lounge.ts';
import { LoungeNpcs } from './npcs.ts';
import { safeAmp } from '../../../../shared/flashGovernor.ts';

// the raid engine has nothing to plan for these in a raceway room (no BG_* anchors): its stamps play here instead
for (const k of ['pirate_raid', 'armada', 'raceway_lap', 'raceway_salute', 'raceway_confetti']) registerRaidEvent(k, { available: () => false, plan: () => null });

const T0 = 1767225600;          // 2026-01-01 (s): keeps the clock numbers small
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const tv = new THREE.Vector3();
const SUPPORT_KINDS = new Set(['finance', 'sub', 'giftSub', 'membership', 'raid']);

interface SupportEv { at: number; id: string; user: string; usd: number; fkind: string; display: string }
interface Stamp { kind: string; at: number; id: string; user?: string; amount?: string }

export class RacewayScene {
  private rt: SceneRuntime | null = null;
  room: RacewayRoom | null = null;
  cfg: RacewayCfg = {};
  private group = new THREE.Group();
  private fx: SpaceFx | null = null;
  ships: RacewayShips | null = null;
  race: Race | null = null;
  battles: Battles | null = null;
  lounge: Lounge | null = null;
  npcs: LoungeNpcs | null = null;
  private stars: THREE.Points | null = null;
  private restoreMats: (() => void)[] = [];
  private loading = false;
  private loadErr = '';
  private racerSt: RacerState[] = [];
  private support: SupportEv[] = [];
  private tests: Stamp[] = [];
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  private camShot: { key: string; name: string } | null = null;
  private house: THREE.MeshStandardMaterial[] = [];
  private prevHooks: { before: THREE.Scene['onBeforeRender']; after: THREE.Scene['onAfterRender'] } | null = null;
  private restore: (() => void) | null = null;
  private alert = { alarm: 0, flash: 0 };
  private shake = 0; private shakeSeed = 1;
  private faceT = 0;
  private lapCache = new Map<number, { t: number; v: number | null }>();
  private active: string[] = [];
  private F: BFrame | null = null;
  private perf = { avg: 0, peak: 0, level: 0, slowFor: 0, goodFor: 0 };
  private warmed = false;
  private fired = new Set<string>();
  protect = true;
  /** Test pages: time advances only through update(). */
  manual = false;
  clock = Date.now();
  forceLevel: number | null = null;
  now() { return this.manual ? this.clock : Date.now(); }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const cfg = (rt.info as unknown as { raceway?: RacewayCfg }).raceway;
    if (!cfg || cfg.on === false) return;
    const eye = rt.room.screen?.node?.getWorldPosition(new THREE.Vector3()) ?? rt.room.cameras.get('CAM_WIDE')?.position.clone() ?? V(0, 2, 0);
    const room = racewayRoomOf(rt.root, rt.root.worldToLocal(eye.clone()));
    if (!room) return;
    this.rt = rt; this.room = room; this.cfg = cfg;
    this.group = new THREE.Group(); this.group.name = 'vtp:raceway';
    rt.root.add(this.group);
    this.fx = new SpaceFx({ sprites: 1600, smoke: 360, streaks: 1500 }, true);
    this.group.add(this.fx.group);
    this.unlit(rt, cfg);
    this.makeStars(cfg);
    // light cones + glass grime are see-through: never let them hide a face from the camera solver / camEval
    const occ = rt.room.occluders;
    for (let i = occ.length - 1; i >= 0; i--) if (/^(LIGHT_SHAFTS|GLASS_DIRT|ATMOS)/.test(occ[i].name) || /^(LIGHT_SHAFTS|GLASS_DIRT|ATMOS)/.test(occ[i].parent?.name ?? '')) occ.splice(i, 1);
    const course = new Course(room);
    this.race = new Race(course, cfg.seed ?? 23, cfg.racers ?? 8, cfg.speed ?? 92, cfg.pilots ?? ['RACER'], cfg.crashEvery ?? [95, 200]);
    this.lounge = new Lounge(room);
    rt.root.add(this.lounge.group);
    this.npcs = new LoungeNpcs(room.npcs);
    rt.root.add(this.npcs.group);
    const gen = () => this.rt === rt;
    void this.npcs.load(sceneFileUrl(rt.info.id, cfg.npc ?? 'raceway/pirates.glb'), gen);
    // house materials (the red alert tints them at render time only; restored right after)
    const seen = new Set<THREE.Material>();
    rt.room.root.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!(o as THREE.Mesh).isMesh || !m) return;
      for (const mt of Array.isArray(m) ? m : [m]) {
        const sm = mt as THREE.MeshStandardMaterial;
        if (seen.has(sm) || !sm.isMeshStandardMaterial) continue;
        seen.add(sm);
        if (!/^(EMIT_|RW_|X_|M_Giant|M_Moon|ADD_|SCREEN)/.test(sm.name)) this.house.push(sm);
      }
    });
    const sc = rt.stage.scene;
    this.prevHooks = { before: sc.onBeforeRender, after: sc.onAfterRender };
    const self = this;
    sc.onBeforeRender = function (...args) { self.prevHooks?.before.apply(this, args); self.beforeRender(); };
    sc.onAfterRender = function (...args) { self.afterRender(); self.prevHooks?.after.apply(this, args); };
    const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
    this.prevOverride = hook.cameraOverride;
    this.myOverride = (aspect: number) => this.shot() ?? this.prevOverride?.(aspect) ?? null;
    hook.cameraOverride = this.myOverride;
    this.loading = true;
    RacewayShips.load(sceneFileUrl(rt.info.id, cfg.ships ?? 'raceway/ships.glb'), sceneFileUrl(rt.info.id, cfg.meta ?? 'raceway/ships.json')).then((s) => {
      if (this.rt !== rt) { s.dispose(); return; }
      this.ships = s;
      s.setSun(room.sun);
      this.group.add(s.group);
      this.battles = new Battles(room, s.meta, cfg.seed ?? 23);
    }).catch((e) => { this.loadErr = String((e as Error)?.message ?? e); console.warn('[raceway] ships', e); }).finally(() => { this.loading = false; });
  }

  detach() {
    const rt = this.rt;
    if (rt) {
      const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
      if (hook.cameraOverride === this.myOverride) hook.cameraOverride = this.prevOverride;
      if (this.prevHooks) { rt.stage.scene.onBeforeRender = this.prevHooks.before; rt.stage.scene.onAfterRender = this.prevHooks.after; }
    }
    this.afterRender();
    this.prevHooks = null;
    for (const r of this.restoreMats) r();
    this.restoreMats = [];
    this.ships?.dispose(); this.ships = null;
    this.fx?.dispose(); this.fx = null;
    this.lounge?.dispose(); this.lounge = null;
    this.npcs?.dispose(); this.npcs = null;
    if (this.stars) { this.stars.geometry.dispose(); (this.stars.material as THREE.Material).dispose(); this.stars = null; }
    this.group.removeFromParent();
    this.rt = null; this.room = null; this.race = null; this.battles = null; this.house = []; this.warmed = false;
    this.lapCache.clear(); this.racerSt = [];
  }

  // ------------------------------------------------------------------------------------------ outside: unlit, stars
  private unlit(rt: SceneRuntime, cfg: RacewayCfg) {
    const pre = cfg.unlit ?? ['X_', 'M_Giant', 'M_Moon'];
    const made = new Map<THREE.Material, THREE.Material>();
    rt.room.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const out = list.map((mt) => {
        const sm = mt as THREE.MeshStandardMaterial;
        const nm = sm.name.replace(/\.\d+$/, '');
        let rep = made.get(sm);
        if (!rep && pre.some((p) => nm.startsWith(p))) {
          const b = new THREE.MeshBasicMaterial({ map: sm.map ?? sm.emissiveMap ?? null, vertexColors: !!mesh.geometry.getAttribute('color'), side: sm.side, transparent: sm.transparent, alphaTest: sm.alphaTest, depthWrite: sm.depthWrite, fog: nm !== 'X_Space' && sm.fog });
          b.name = sm.name; b.userData = { ...sm.userData, raceway: 'unlit' };
          if (nm === 'X_Space') { b.depthWrite = false; b.color.setScalar(0.72); }
          rep = b;
        } else if (!rep && /^ADD_.*glow$/.test(nm)) {
          rep = atmosphere(sm.emissive.clone(), this.room!.sun);
        } else if (!rep && /^ADD_/.test(nm)) {
          // light cones / glow cards: additive, unlit, never written to depth
          const b = new THREE.MeshBasicMaterial({ map: sm.emissiveMap ?? sm.map ?? null, color: sm.emissive.clone().multiplyScalar(0.07), blending: THREE.AdditiveBlending,
            transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
          b.name = sm.name; b.userData = { ...sm.userData, raceway: 'additive' };
          rep = b;
        }
        if (rep) { made.set(sm, rep); return rep; }
        return mt;
      });
      if (out.some((m, i) => m !== list[i])) {
        const before = mesh.material;
        mesh.material = Array.isArray(mesh.material) ? out : out[0];
        if (/SKY_DOME/.test(mesh.name)) mesh.renderOrder = -10;
        this.restoreMats.push(() => { mesh.material = before; });
      }
    });
    this.restoreMats.push(() => { for (const m of made.values()) m.dispose(); });
  }

  private makeStars(cfg: RacewayCfg) {
    const n = cfg.stars?.count ?? 2600, R = cfg.stars?.radius ?? 50000;
    const r = new Rng(hash32(cfg.seed ?? 23, 'stars'));
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = V(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1));
      if (d.lengthSq() > 1 || d.lengthSq() < 0.01) { i--; continue; }
      d.normalize().multiplyScalar(R);
      pos.set([d.x, d.y, d.z], i * 3);
      const k = r.next();
      const c = k < 0.12 ? [1, 0.8, 0.6] : k < 0.3 ? [0.75, 0.85, 1] : [1, 1, 1];
      const b = 0.35 + r.next() ** 3 * 1.4;
      col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
      size[i] = 1.0 + r.next() ** 4 * 2.6; ph[i] = r.next() * 6.283;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1)); g.setAttribute('ph', new THREE.BufferAttribute(ph, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPr: { value: 1 } },
      vertexShader: `attribute float size; attribute float ph; attribute vec3 color; uniform float uTime; uniform float uPr; varying vec3 vC; varying float vA;
        void main() { vC = color; vA = 0.75 + 0.25 * sin(uTime * (1.3 + ph) + ph * 7.0); vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = size * uPr; }`,
      fragmentShader: `varying vec3 vC; varying float vA; void main() { vec2 p = gl_PointCoord - 0.5; float d = length(p); if (d > 0.5) discard; float a = smoothstep(0.5, 0.0, d) * vA; gl_FragColor = vec4(vC * a, 1.0);
        #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    m.name = 'vtp:raceway:stars';
    this.stars = new THREE.Points(g, m);
    this.stars.name = 'vtp:raceway:stars'; this.stars.frustumCulled = false; this.stars.renderOrder = -9;
    this.group.add(this.stars);
  }

  // ------------------------------------------------------------------------------------------ support events
  /** chat feed events (bus / party relay): tips, subs, gifts, raids → laps, salutes, confetti, bounties, the armada. */
  onSupport(evs: { kind?: string; fkind?: string; ts?: number; id?: string; user?: string; usd?: number; approxUsd?: number; display?: string }[], snap: boolean) {
    if (snap) return;
    for (const e of evs) {
      if (e.kind !== 'finance' && !SUPPORT_KINDS.has(e.kind ?? '')) continue;
      const ts = typeof e.ts === 'number' && Math.abs(Date.now() - e.ts) < 60000 ? e.ts : Date.now();
      const id = e.id ?? String(ts);
      if (this.support.some((s) => s.id === id)) continue;
      this.support.push({ at: ts / 1000 + 1.2 - T0, id, user: (e.user ?? '').slice(0, 24), usd: e.usd ?? e.approxUsd ?? 0, fkind: e.fkind ?? e.kind ?? '', display: e.display ?? (e.usd ? `$${e.usd.toFixed(2)}` : '') });
      this.support.sort((a, b) => a.at - b.at);
      if (this.support.length > 24) this.support.shift();
    }
  }
  /** Tests (page only): an event `inSec` from now. kind: lap | salute | confetti | skirmish | armada | tip | sub | gift | raid */
  test(kind: string, user = 'TestViewer', inSec = 0.5, usd = 5) {
    const at = this.now() / 1000 + inSec - T0;
    if (['tip', 'sub', 'gift', 'raid'].includes(kind)) {
      const fk = kind === 'tip' ? 'tip' : kind === 'sub' ? 'sub' : kind === 'gift' ? 'giftSub' : 'raid';
      this.support.push({ at, id: `test-${kind}-${Math.floor(at * 1000)}`, user, usd: kind === 'tip' ? usd : 0, fkind: fk, display: kind === 'tip' ? `$${usd.toFixed(2)}` : kind === 'raid' ? '42 raiders' : '' });
      return;
    }
    this.tests.push({ kind, at, id: `test-${kind}-${Math.floor(at * 1000)}`, user });
  }

  /** the support + raid stamps → timed episodes (battles queue one after another; laps / salutes too). */
  private stamps(): Stamp[] {
    const out: Stamp[] = [...this.tests];
    const b = this.cfg.support ?? {};
    const bounty = b.bounty ?? 20, armada = b.armada ?? 100;
    for (const s of this.support) {
      const who = s.user || 'someone';
      if (s.fkind === 'raid') out.push({ kind: 'armada', at: s.at, id: s.id, user: who, amount: s.display });
      else if (/^(sub|resub|membership|milestone)$/.test(s.fkind)) out.push({ kind: 'salute', at: s.at, id: s.id, user: who });
      else if (/^(giftSub|giftMembership)$/.test(s.fkind)) out.push({ kind: 'confetti', at: s.at, id: s.id, user: who, amount: s.display });
      else if (s.usd >= armada) out.push({ kind: 'armada', at: s.at, id: s.id, user: who, amount: s.display });
      else if (s.usd >= bounty) out.push({ kind: 'skirmish', at: s.at, id: s.id, user: who, amount: s.display });
      else out.push({ kind: 'lap', at: s.at, id: s.id, user: who, amount: s.display });
    }
    // the host's raid-event stamps (Raid panel tests, bus / MCP): support stamps ('sup:…') are the chat feed's job
    const rs = this.rt?.state.raid?.events ?? [];
    for (const e of rs) {
      if (e.id.startsWith('sup:')) continue;
      const big = (e as { big?: boolean }).big;
      const k = e.k === 'armada' || big ? 'armada' : /^(pirate_raid|skirmish|donation|tagilla)$/.test(e.k) ? 'skirmish' : e.k.replace(/^raceway_/, '');
      if (!['armada', 'skirmish', 'lap', 'salute', 'confetti'].includes(k)) continue;
      out.push({ kind: k, at: e.at / 1000 - T0, id: `raid:${e.id}`, user: e.user, amount: e.amount });
    }
    return out.sort((a, b2) => a.at - b2.at || a.id.localeCompare(b2.id));
  }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number) {
    const t0 = performance.now();
    try { this.step(dt); } catch (e) { console.warn('[raceway] frame failed', e); }
    const ms = performance.now() - t0;
    this.perf.avg = this.perf.avg * 0.97 + ms * 0.03; this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private step(dt: number) {
    const rt = this.rt, R = this.room, fx = this.fx;
    if (!rt || !R || !fx || !this.race || !this.lounge) return;
    if (this.manual) this.clock += dt * 1000;
    const t = this.now() / 1000 - T0;
    const cam = rt.stage.camera;
    const H = rt.stage.renderer.domElement.height || 1080;
    fx.uniforms.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / H;
    this.lounge.fx.uniforms.uPx.value = fx.uniforms.uPx.value;
    this.governor(dt);
    if (this.stars) { const m = this.stars.material as THREE.ShaderMaterial; m.uniforms.uTime.value = t % 3600; m.uniforms.uPr.value = Math.max(1, H / 1080) * rt.stage.renderer.getPixelRatio(); }
    this.faceT -= dt;
    if (this.faceT <= 0) { this.faceT = 0.2; this.protectFaces(); }
    const S = this.ships;
    const detail = this.perf.level === 0 ? 1 : 0;
    const F: BFrame = this.F ??= { t, ships: S!, fx, alarm: 0, flash: 0, shake: 0, pa: [], labels: [], moments: [], cam: null, detail };
    F.t = t; F.alarm = 0; F.flash = 0; F.shake = 0; F.pa.length = 0; F.labels.length = 0; F.moments.length = 0; F.cam = null; F.detail = detail;
    fx.begin(t % 3600);
    // the sun (a hard white star + a soft corona)
    // (only when it is in front of the lens: a billboard behind the camera projects inverted across the whole frame)
    const sunP = R.sun.clone().multiplyScalar(30000);
    const camFwd = tv.set(0, 0, -1).applyQuaternion(cam.quaternion);
    if (camFwd.dot(R.sun) > 0.15) {
      fx.sprite(sunP, 420, 1.6, 1.5, 1.35, 1, SPRITE.core, 0);
      fx.sprite(sunP, 1900, 1.2, 1.0, 0.85, 0.55, SPRITE.glow, 0);
      fx.sprite(sunP, 900, 1.2, 1.1, 1.0, 0.5, SPRITE.flare, 0.1);
    }
    const gateHeat = new Map<number, number>();
    let launch = 0;
    const turretFire: number[] = [];
    if (S && this.battles) {
      F.ships = S;
      S.begin(t % 3600);
      // ---- the race
      const st = this.race.sample(t, R, this.racerSt);
      const C = this.race.course;
      for (const r of this.race.racers) {
        const o = st[r.i];
        if (o.crash && t >= o.crash.tc && t < o.crash.tc + 9) {
          boom(F, o.crash.hit, t - o.crash.tc, 9, hash32(o.crash.tc, 'crash'));
          debris(F, o.crash.hit, o.crash.n, t - o.crash.tc, 18, hash32(o.crash.tc, 'cdeb'));
          if (t - o.crash.tc < 0.5) F.pa.push({ key: `crash:${o.crash.tc}`, text: `${r.pilot} JUST FOUND A ROCK - THE BOOKIE THANKS YOU`, tone: 'alert' });
        }
        if (!o.alive || o.fade <= 0.01) continue;
        S.push({ kind: r.kind, pos: o.pos, quat: o.quat, c1: r.c1, c2: r.c2, heat: o.heat, fade: o.fade });
        engine(F, S.meta[r.kind], o.pos, o.quat, r.c1);
        // light trail (racers: long, coloured ribbons)
        const fw = V(0, 0, 1).applyQuaternion(o.quat);
        const segs = detail ? 7 : 3;
        for (let k = 0; k < segs; k++) fx.line(o.pos.clone().addScaledVector(fw, -5 - (k + 1) * 9), o.pos.clone().addScaledVector(fw, -5 - k * 9), 0.55 * (1 - k / (segs + 1)), 1.2, r.c1.r * 1.3, r.c1.g * 1.3, r.c1.b * 1.3, 0.55 * (1 - k / segs) * o.fade, false);
        for (const g of C.gateS) {
          const d = ((o.s - g.s) % C.L + C.L) % C.L;
          if (d < 120) gateHeat.set(g.g, Math.max(gateHeat.get(g.g) ?? 0, 1 - d / 120));
        }
      }
      // gates flare as racers thread them (a ring of light in the gate's colour)
      for (const g of R.gates) {
        const h = gateHeat.get(g.g) ?? 0;
        if (h < 0.05) continue;
        const start = g.g === 1;
        fx.sprite(g.pos, g.r * 1.1, start ? 1.2 : 1.4, start ? 1.2 : 0.7, start ? 1.2 : 0.28, h * 0.28, SPRITE.ring, g.g * 0.13);
        fx.sprite(g.pos, g.r * 0.6, start ? 0.9 : 1.1, start ? 0.9 : 0.55, start ? 0.9 : 0.2, h * 0.05, SPRITE.glow, 0);
      }
      // ---- episodes: ambient skirmishes + support / stamped events
      const eps: { ep: Episode; tau: number }[] = [];
      const stamps = this.stamps();
      const evBattles = stamps.filter((s) => s.kind === 'skirmish' || s.kind === 'armada').map((s) => s.at);
      const every = this.cfg.battle?.every ?? [240, 420];
      const slot = (every[0] + every[1]) / 2;
      const k0 = Math.floor(t / slot);
      for (let k = k0 - 1; k <= k0; k++) {
        const r = new Rng(hash32(this.cfg.seed ?? 23, k, 'sk'));
        if (!r.chance(0.72)) continue;
        const start = k * slot + r.range(10, slot - 120);
        if (evBattles.some((a) => a > start - 150 && a < start + 130)) continue;     // a summoned fight owns the sky
        const ep = this.battles.plan('skirmish', `amb${k}`, start);
        if (ep && t >= start && t < start + ep.dur) eps.push({ ep, tau: t - start });
      }
      let battleEnd = -Infinity;
      const confetti: { at: number; seed: number }[] = [];
      let cheer = 0;
      for (const s of stamps) {
        if (s.kind === 'confetti') { confetti.push({ at: s.at, seed: hash32(s.id) }); if (t >= s.at && t < s.at + 8) { cheer = Math.max(cheer, s.at); F.pa.push({ key: `conf:${s.id}`, text: `${(s.user ?? 'SOMEONE').toUpperCase()} BUSTED THE VOID FIZZ MACHINE! ${s.amount ? '(' + s.amount + ') ' : ''}DRINKS FOR EVERYONE`, tone: 'cheer' }); } continue; }
        let start = s.at;
        if (s.kind === 'skirmish' || s.kind === 'armada') start = Math.max(start, battleEnd);
        const ep = this.battles.plan(s.kind, s.id, start, { user: s.user, amount: s.amount });
        if (!ep) continue;
        if (s.kind === 'skirmish' || s.kind === 'armada') battleEnd = start + ep.dur - 20;
        if (t >= start && t < start + ep.dur) eps.push({ ep, tau: t - start });
        if (t >= s.at && t < s.at + 7) cheer = Math.max(cheer, s.at);
      }
      this.lounge.confetti = confetti;
      this.active = eps.map((e) => e.ep.kind);
      for (const { ep, tau } of eps) {
        this.battles.sample(ep, tau, F);
        if ((ep.kind === 'skirmish' || ep.kind === 'armada') && tau < 20) launch = 1;
        for (const ts of ep.turretShots) if (tau > ts.t && tau < ts.t + 0.3) turretFire[ts.turret] = 1;
        if (ep.kind === 'lap' && tau > 0.3 && tau < 17) this.bannerFor(ep, tau, F);
      }
      // ---- ambient traffic: pirate bricks landing on / leaving the pads
      this.traffic(t, F);
      this.cheer = cheer;
      S.end();
    }
    fx.end();
    // ---- the lounge
    const cheerAt = this.cheer && t - this.cheer < 7 ? this.cheer : 0;
    this.lounge.update(t, dt, { alarm: F.alarm, cheer: cheerAt ? clamp01(1 - (t - cheerAt) / 3) : 0, gateHeat, launch, turretFire });
    const lastSparks = Math.floor(t / 11.1) * 11.1;
    this.npcs?.update(t, dt, cam, this.faces(), gfxBudget().lodBias, cheerAt, lastSparks);
    this.board(t, dt, F);
    const pa = this.paLine(t, F);
    this.lounge.drawTicker(t, dt, pa.text, pa.tone);
    // ---- the lounge reacts: red alert, explosion flashes, shake
    this.alert.alarm += (F.alarm - this.alert.alarm) * Math.min(1, dt * 3);
    this.alert.flash = Math.max(this.alert.flash * Math.exp(-dt * 6), F.flash);
    if (F.shake > 0 && rt.state.mode !== 'react' && F.shake > this.shake) { this.shake = F.shake; this.shakeSeed = hash32(t, 'sh'); }
    this.applyShake(dt);
    this.camShot = F.cam;
    for (const m of F.moments) this.moment(m.key, m.what);
    if (!this.warmed && S) this.warm();
  }

  private cheer = 0;
  private moment(key: string, what: string) {
    if (this.fired.has(key)) return;
    this.fired.add(key);
    if (this.fired.size > 200) this.fired = new Set([...this.fired].slice(-100));
    const L = this.rt?.lights as unknown as { cue?: (w: string) => void; cues?: string[] } | undefined;
    if (!L?.cue) return;
    try { if (what === 'destroyed') L.cue(L.cues?.includes('spaceBoom') ? 'spaceBoom' : L.cues?.includes('donation') ? 'donation' : 'screenLand'); } catch { /* optional */ }
  }

  private bannerFor(ep: Episode, tau: number, F: BFrame) {
    const s = ep.ships[0];
    if (!s || !this.battles) return;
    const p = V(), q = new THREE.Quaternion();
    const fwd = this.battles.pose(s as never, tau, p, q);
    if (!fwd) return;
    const up = V(0, 1, 0).applyQuaternion(q);
    F.labels.push({ key: ep.key, text: `GG ${(ep.user ?? '').toUpperCase()}!`, sub: ep.amount ? `THANKS FOR THE ${ep.amount}` : 'THE HOUSE PAYS OUT', pos: p.clone().addScaledVector(fwd, -20).addScaledVector(up, 1.5), alpha: clamp01(tau / 0.8) * clamp01((16.5 - tau) / 1), kind: 'banner', fwd });
    this.drawBanner(F);
  }

  // a cloth banner trailing the showboat: one quad, canvas text, faces the camera around the tow line
  private banner: { mesh: THREE.Mesh; key: string; tex: THREE.CanvasTexture } | null = null;
  private drawBanner(F: BFrame) {
    const l = F.labels.find((x) => x.kind === 'banner');
    if (!l) return;
    if (!this.banner || this.banner.key !== l.key) {
      const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
      const g = c.getContext('2d')!;
      g.fillStyle = '#f2c230'; g.fillRect(0, 0, 1024, 256);
      for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#111' : '#f2c230'; g.fillRect(i * 64, 0, 64, 18); g.fillRect(i * 64 + 32, 238, 64, 18); }
      g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
      let fs = 118; g.font = `900 ${fs}px Impact, 'Arial Black', sans-serif`;
      while (g.measureText(l.text).width > 980 && fs > 40) { fs -= 4; g.font = `900 ${fs}px Impact, 'Arial Black', sans-serif`; }
      g.fillText(l.text, 512, 112);
      g.font = "700 44px 'Arial Black', sans-serif"; g.fillText(l.sub, 512, 200);
      if (this.banner) { this.banner.tex.dispose(); this.banner.mesh.geometry.dispose(); (this.banner.mesh.material as THREE.Material).dispose(); this.banner.mesh.removeFromParent(); }
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.25, 16, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false }));
      mesh.name = 'vtp:raceway:banner'; mesh.frustumCulled = false; mesh.renderOrder = 4;
      this.group.add(mesh);
      this.banner = { mesh, key: l.key, tex };
    }
    const m = this.banner.mesh;
    m.visible = l.alpha > 0.01;
    m.position.copy(l.pos);
    const cam = this.rt!.stage.camera;
    m.quaternion.copy(cam.quaternion);
    m.scale.setScalar(26);
    (m.material as THREE.MeshBasicMaterial).opacity = l.alpha;
    const pa = (m.geometry as THREE.PlaneGeometry).getAttribute('position');
    for (let i = 0; i < pa.count; i++) { const x = pa.getX(i); pa.setZ(i, Math.sin(x * 9 + this.now() / 180) * 0.03); }
    pa.needsUpdate = true;
  }

  private traffic(t: number, F: BFrame) {
    const R = this.room!, S = this.ships!;
    R.pads.forEach((pad, i) => {
      const parked = typeof pad.extras.parked === 'string' ? String(pad.extras.parked).toUpperCase() : null;
      const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), V(pad.fwd.x, 0, pad.fwd.z).normalize());
      if (parked) { S.push({ kind: parked, pos: pad.pos.clone().add(V(0, 3.2, 0)), quat: q, c1: new THREE.Color('#c9a227'), c2: new THREE.Color('#2a2d31') }); return; }
      const per = 150 + i * 23, k = Math.floor((t + i * 41) / per), u = (t + i * 41) - k * per;
      const r = new Rng(hash32(k, i, 'pad'));
      const from = pad.pos.clone().add(V(r.range(-600, 600), r.range(80, 260), -r.range(400, 900)));
      const hover = pad.pos.clone().add(V(0, 26, 0));
      const land = pad.pos.clone().add(V(0, 3.2, 0));
      let p: THREE.Vector3, fwd: THREE.Vector3, power = 0.6, fade = 1;
      if (u < 22) { const a = u / 22, e = 1 - (1 - a) ** 2; p = from.clone().lerp(hover, e); fwd = hover.clone().sub(from).normalize(); fade = clamp01(u / 2); power = 1; }
      else if (u < 30) { const a = (u - 22) / 8; p = hover.clone().lerp(land, a * a * (3 - 2 * a)); fwd = V(pad.fwd.x, 0, pad.fwd.z).normalize(); }
      else if (u < 110) { p = land; fwd = V(pad.fwd.x, 0, pad.fwd.z).normalize(); power = 0.1; }
      else if (u < 118) { const a = (u - 110) / 8; p = land.clone().lerp(hover, a * a); fwd = V(pad.fwd.x, 0, pad.fwd.z).normalize(); power = 0.8; }
      else if (u < 140) { const a = (u - 118) / 22; const to = pad.pos.clone().add(V(r.range(-700, 700), r.range(100, 300), -r.range(500, 1000))); p = hover.clone().lerp(to, a * a); fwd = to.clone().sub(hover).normalize(); fade = clamp01((140 - u) / 3); power = 1; }
      else return;
      const qq = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), fwd.clone().normalize());
      S.push({ kind: 'BRICK', pos: p, quat: qq, c1: new THREE.Color(['#c9a227', '#b8621e', '#8a8a3a'][k % 3]), c2: new THREE.Color('#2a2d31'), fade });
      engine(F, S.meta.BRICK, p, qq, new THREE.Color(1.3, 0.75, 0.35), power);
    });
  }

  // ------------------------------------------------------------------------------------------ board + PA
  private board(t: number, dt: number, F: BFrame) {
    const race = this.race!, R = this.room!;
    const st = this.racerSt;
    if (!st.length) return;
    const order = race.standings(t, st);
    const lead = st[order[0]];
    const rows: BoardRow[] = order.map((i, k) => {
      const o = st[i], r = race.racers[i];
      let last = '--:--.--';
      const c = this.lapCache.get(i);
      if (!c || t - c.t > 2) { const v = race.lastLap(i, t); this.lapCache.set(i, { t, v }); }
      const lv = this.lapCache.get(i)!.v;
      if (lv) last = `${Math.floor(lv / 60)}:${(lv % 60).toFixed(2).padStart(5, '0')}`;
      const gap = k === 0 ? 'LEADER' : `+${((lead.s - o.s) / race.v).toFixed(2)}s`;
      const state: BoardRow['state'] = !o.alive ? 'dnf' : o.crash && t >= o.crash.rejoin && t < o.crash.rejoin + 6 ? 'rejoin' : 'ok';
      return { pos: k + 1, pilot: r.pilot, c1: `#${r.c1.getHexString()}`, gap, last, odds: r.odds, state };
    });
    const heat = race.heatOf(t);
    const lap = Math.floor(((t % HEAT) / HEAT) * 5) + 1;
    let banner: BoardData['banner'] = null;
    // (1) a supporter just paid in: BET PAID OUT (10 s)
    const sup = [...this.support].reverse().find((s) => t >= s.at && t < s.at + 10);
    if (sup) banner = { title: sup.fkind === 'raid' ? 'RAID! ALL HANDS' : /sub|member/i.test(sup.fkind) ? 'NEW CREW MEMBER' : 'BET PAID OUT', sub: `${sup.user.toUpperCase()} ${sup.display ? '+' + sup.display : ''}`.trim(), tone: 'gold' };
    else if (this.active.includes('armada')) banner = { title: 'RACE SUSPENDED', sub: 'HOSTILES IN THE RINGS', tone: 'red' };
    else if (t % HEAT < 8 && heat > 0) banner = { title: `HEAT ${race.heatLabel(heat - 1)} WINNER`, sub: race.racers[race.winner(heat - 1, R)].pilot, tone: 'cyan' };
    else { const cr = st.find((o) => o.crash && t >= o.crash.tc && t < o.crash.tc + 6); if (cr) banner = { title: 'CRASH!', sub: `${race.racers[st.indexOf(cr)].pilot} MET A ROCK`, tone: 'red' }; }
    const ticker = `BETS OPEN  -  ${race.racers.map((r) => `${r.pilot} ${r.odds}`).join('   *   ')}   -   ALL BETS FINAL   -   NO REFUNDS   -   THE HOUSE ALWAYS WINS`;
    this.lounge!.drawBoard(t, dt, { heat: race.heatLabel(heat), lap, rows, banner, ticker, live: true });
    void F;
  }

  private static AMBIENT_PA = [
    'WELCOME TO THE RUST RINGS - PLEASE KEEP YOUR WEAPONS HOLSTERED AND YOUR BETS UNHOLSTERED',
    'WOULD THE OWNER OF THE ORANGE HAULER ON PAD 2 PLEASE COME AND MOVE IT - IT IS ON FIRE',
    'REMINDER: THE AIRLOCK IS NOT A SHORTCUT TO THE HANGAR',
    'THE CLINIC IS OPEN - NO QUESTIONS ASKED - SOME ANSWERS GIVEN',
    'DEAD STICK HAPPY HOUR: EVERY HOUR, IF YOU ARE BRAVE ENOUGH',
    'LOST AND FOUND: ONE LEFT BOOT, ONE PET RAT, ONE (1) SMALL MOON. PLEASE CLAIM THE RAT',
    'RACE CONTROL REMINDS PILOTS: THE BIG ROCK DOES NOT MOVE. YOU DO',
    'DO NOT FEED THE DROID. IT HAS BEEN FED.',
    'VOID FIZZ - TASTES LIKE ZERO-G - NOW WITH 30% LESS HULL CORROSION',
    'BOUNTY HUNTERS: THE STATION RESERVES THE RIGHT TO SHOOT YOU',
  ];
  private paLine(t: number, F: BFrame): { text: string; tone: 'alert' | 'info' | 'cheer' } {
    const ev = F.pa[F.pa.length - 1];
    if (ev) return { text: ev.text, tone: ev.tone };
    const k = Math.floor(t / 36);
    const heat = this.race?.heatOf(t) ?? 0;
    if (t % HEAT < 12 && heat > 0 && this.race && this.room) return { text: `RACE CONTROL: HEAT ${this.race.heatLabel(heat - 1)} GOES TO ${this.race.racers[this.race.winner(heat - 1, this.room)].pilot} - HEAT ${this.race.heatLabel(heat)} IS LIVE`, tone: 'info' };
    return { text: RacewayScene.AMBIENT_PA[hash32(k, 'pa') % RacewayScene.AMBIENT_PA.length], tone: 'info' };
  }

  // ------------------------------------------------------------------------------------------ camera, faces, alarm
  private shot(): { key: string; pose: { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number }; secs: number } | null {
    const rt = this.rt, s = this.camShot;
    if (!rt || !s || rt.state.mode !== 'talk') return null;
    const c = rt.room.cameras.get(s.name);
    if (!c) return null;
    return { key: `rw:${s.key}`, pose: { position: c.position.clone(), quaternion: c.quaternion.clone(), fov: c.fov }, secs: 0 };
  }

  private faces(): THREE.Vector3[] {
    const rt = this.rt!;
    const out: THREE.Vector3[] = [];
    for (const a of rt.actors.values()) { if (!a.shown || !a.spot) continue; const f = a.faceAt(a.spot); if (f) out.push(f.center.clone()); }
    return out;
  }

  private protectFaces() {
    const rt = this.rt!;
    const cam = rt.stage.camera;
    cam.updateMatrixWorld();
    const W = rt.stage.renderer.domElement.width || 1920, H = rt.stage.renderer.domElement.height || 1080;
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const faces = faceUniforms.uFaces.value;
    let n = 0;
    if (this.protect) for (const a of rt.actors.values()) {
      if (!a.shown || !a.rest || n >= FACE_SLOTS) continue;
      const c = a.lift.localToWorld(tv.copy(a.rest.face.center));
      const d = c.distanceTo(cam.position);
      c.project(cam);
      if (c.z > 1 || c.z < -1) continue;
      const px = ((c.x + 1) / 2) * W, py = ((c.y + 1) / 2) * H;
      const r = ((a.rest.face.size * a.scale) / (d * tanH)) * (H / 2);
      faces[n++].set(px - r * 1.5, py - r * 1.7, px + r * 1.5, py + r * 1.9);
    }
    faceUniforms.uFaceN.value = n;
  }

  private applyShake(dt: number) {
    if (this.shake <= 0) return;
    this.shake = Math.max(0, this.shake - dt * 1.2);
    if (this.rt!.state.mode === 'react') { this.shake = 0; return; }
    const cam = this.rt!.stage.camera;
    const k = this.shake ** 2;
    const r = new Rng(this.shakeSeed + Math.floor(this.shake * 60));
    cam.position.x += r.range(-1, 1) * 0.03 * k; cam.position.y += r.range(-1, 1) * 0.025 * k;
    cam.rotation.z += r.range(-1, 1) * 0.006 * k;
    cam.updateMatrixWorld();
  }

  private beforeRender() {
    const a = this.alert.alarm, f = this.alert.flash;
    if (a < 0.003 && f < 0.003) return;
    const t = this.now() / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.9);
    const red = a * (0.3 + 0.7 * pulse);
    const undo: (() => void)[] = [];
    for (const o of this.rt!.stage.scene.children) {
      const l = o as THREE.Light;
      if (!l.isLight) continue;
      const c0 = l.color.clone(), i0 = l.intensity;
      l.color.lerp(new THREE.Color(1, 0.14, 0.08), red * 0.6);
      l.intensity = i0 * (1 + f * 1.2);
      if (f > 0) l.color.lerp(new THREE.Color(1, 0.85, 0.65), f * 0.4);
      undo.push(() => { l.color.copy(c0); l.intensity = i0; });
    }
    for (const m of this.house) {
      const c0 = m.color.clone();
      m.color.multiply(new THREE.Color(1, 1 - red * 0.55, 1 - red * 0.58));
      if (f > 0) m.color.lerp(new THREE.Color(1, 0.9, 0.75), f * 0.18);
      undo.push(() => m.color.copy(c0));
    }
    this.restore = () => { for (const u of undo) u(); };
  }
  private afterRender() { this.restore?.(); this.restore = null; }

  private governor(dt: number) {
    const P = this.perf;
    const low = (this.rt?.opts.tier ?? 'high') === 'low';
    const slow = P.avg > 1.6;
    if (slow) { P.slowFor += dt; P.goodFor = 0; } else { P.goodFor += dt; P.slowFor = 0; }
    if (P.slowFor > 2.5 && P.level < 2) { P.level++; P.slowFor = 0; }
    if (P.goodFor > 25 && P.level > (low ? 1 : 0)) { P.level--; P.goodFor = 0; }
    if (low && P.level < 1) P.level = 1;
    if (this.forceLevel !== null) P.level = this.forceLevel;
    if (this.fx) this.fx.level = P.level;
  }

  private warm() {
    this.warmed = true;
    const rt = this.rt!, S = this.ships!;
    S.begin(0); S.warmAll(V(0, -1e5, 0)); S.end();
    const r = rt.stage.renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> };
    try { void (r.compileAsync ? r.compileAsync(this.group, rt.stage.camera, rt.stage.scene) : Promise.resolve(r.compile(this.group, rt.stage.camera, rt.stage.scene))).catch(() => {}); } catch { /* optional */ }
  }

  // ------------------------------------------------------------------------------------------ UI / debug
  info() {
    if (!this.rt || !this.room) return null;
    return { racers: this.race?.racers.length ?? 0, active: this.active, ms: +this.perf.avg.toFixed(3), level: this.perf.level };
  }
  debug() {
    const t = this.now() / 1000 - T0;
    return {
      perf: { avg: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(2), level: this.perf.level },
      room: this.room ? { path: this.room.path.length, gates: this.room.gates.length, crash: this.room.crash.length, turrets: this.room.turrets.length, launch: this.room.launch.length, entries: this.room.entries.length, pads: this.room.pads.length, npcs: this.room.npcs.length, fx: this.room.fx.length, rw: [...this.room.rw.keys()], lap: this.race ? Math.round(this.race.course.L) : 0 } : null,
      assets: this.ships ? { tris: this.ships.tris, kinds: this.ships.kinds() } : this.loadErr || (this.loading ? 'loading' : 'idle'),
      counts: { ships: this.ships?.counts() ?? {}, fx: this.fx?.counts() ?? null, lounge: this.lounge?.fx.counts() ?? null },
      active: this.active, alarm: +this.alert.alarm.toFixed(2), heat: this.race?.heatOf(t) ?? null,
      standings: this.race && this.racerSt.length ? this.race.standings(t, this.racerSt).map((i) => this.race!.racers[i].pilot) : [],
      npcs: this.npcs?.debug() ?? [], npcErr: this.npcs?.error ?? '',
      support: this.support.length, tests: this.tests.length,
    };
  }
}

function engine(F: BFrame, meta: { engines: number[][]; engineR: number } | undefined, pos: THREE.Vector3, q: THREE.Quaternion, col: THREE.Color, power = 1) {
  if (!meta) return;
  for (let i = 0; i < meta.engines.length; i++) {
    const e = V(meta.engines[i][0], meta.engines[i][1], meta.engines[i][2]).applyQuaternion(q).add(pos);
    const fl = 0.85 + safeAmp(0.15) * Math.sin(F.t * 29 + i * 1.9);   // (engine flicker: < 10 % with the flash limit on)
    F.fx.sprite(e, meta.engineR * (2.2 + power), 0.6 + col.r * 0.8, 0.6 + col.g * 0.8, 0.6 + col.b * 0.8, 0.8 * fl * power, SPRITE.glow, i * 0.1);
    F.fx.sprite(e, meta.engineR * 0.9, 1.2, 1.2, 1.2, 0.8 * fl * power, SPRITE.core, 0);
  }
}

/** an additive fresnel atmosphere shell (lit side brighter) for ADD_*glow materials. */
function atmosphere(col: THREE.Color, sun: THREE.Vector3): THREE.ShaderMaterial {
  const c = col.r + col.g + col.b > 0.01 ? col : new THREE.Color(1, 0.8, 0.7);
  const m = new THREE.ShaderMaterial({
    uniforms: { uCol: { value: c.clone() }, uSun: { value: sun.clone().normalize() } },
    vertexShader: `varying vec3 vN; varying vec3 vW; void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 uCol; uniform vec3 uSun; varying vec3 vN; varying vec3 vW;
      void main() { vec3 V = normalize(cameraPosition - vW); float f = 1.0 - abs(dot(vN, V)); float rim = pow(f, 3.2); float lit = 0.25 + 0.75 * smoothstep(-0.25, 0.4, dot(vN, uSun));
        gl_FragColor = vec4(uCol * rim * lit * 1.4, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  m.name = 'vtp:raceway:atmos';
  return m;
}
