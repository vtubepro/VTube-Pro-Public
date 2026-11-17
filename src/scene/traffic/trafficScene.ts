// Sky traffic engine — for rooms whose scene.json has a `traffic` key (first user: assets/scenes/sc_area18, the Area 18
// overlook). Ships of every size land on and take off from the room's pads (approach → hover + turn → gear down →
// touchdown → parked → spool → lift-off → gear up → boost away), big ships cruise past on their lanes, flying car
// streams run on the lanes (hulls by day, head / tail lights by night), plus the room's small effects: additive ADD_
// materials, spinning holo props, the smart glass that tints behind the react screen, and a mirrored second door leaf.
//
// Sync: every ship and car is a pure function of the TRAFFIC CLOCK = wall-clock seconds (Date.now() / 1000), so the
// studio preview, every OBS page and party guests' OBS show the same sky (to their clock skew). Nothing is event-driven.
// Day / night comes from the environment engine (src/scene/environment: activeEnv().townWeather().night) when the room
// has one; the sky, fog, rain, sun and the city's window lights are the environment's job, not ours.
//
// Cost: rooms without `traffic` → one check per frame. With it: ≤ ~16 ship clones (shared geometry), 1 instanced draw
// for the cars + 1 point draw for their lights; CPU ≈ 0.1–0.2 ms / frame (see vtpOut.traffic.debug()).
// Tests: vtpOut.traffic.scene.manual = true; .clock = <s>; vtpOut.step(n, dt). `.forceNight = 0…1`.
import * as THREE from 'three';
import { govChannel, pageGovernor, type GovChannel } from '../../../shared/flashGovernor.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { sceneFileUrl } from '../SceneRuntime.ts';
import { activeEnv } from '../environment/index.ts';
import { gfxBudget } from '../../stage/gfx/lod.ts';
import type { ShipMeta, TrafficCfg } from './config.ts';
import { FlightPlanner, type ShipPose } from './flights.ts';
import { Fleet } from './fleet.ts';
import { Streams, vehicleTemplate, type VehicleTemplate } from './streams.ts';
import { Patrons, type PatronCfg } from './patrons.ts';
import { Polyline } from './config.ts';

const tq = new THREE.Quaternion(), TAN = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

export class TrafficScene {
  private rt: SceneRuntime | null = null;
  private cfg: TrafficCfg | null = null;
  private group = new THREE.Group();
  private fleet: Fleet | null = null;
  private planner: FlightPlanner | null = null;
  private streams: Streams | null = null;
  private poses: ShipPose[] = [];
  private pool = new Map<string, ShipPose>();
  private spin: { o: THREE.Object3D; rate: number; rest: THREE.Quaternion }[] = [];
  private glass: { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; base: number; k: number; want: number; color: THREE.Color | null } | null = null;
  private doorB: { node: THREE.Object3D; rest: THREE.Quaternion; angle: number } | null = null;
  private addMats: THREE.Material[] = [];
  private hullMats: { m: THREE.MeshStandardMaterial; base: THREE.Color }[] = [];
  private perf = { avg: 0, peak: 0 };
  private lastLod = { lod0: 0, lod1: 0 };
  private patrons: Patrons | null = null;
  private roam: { node: THREE.Object3D; line: Polyline; speed: number; bob: number; pingpong: boolean; pause: number; rest: THREE.Vector3; restQ: THREE.Quaternion }[] = [];
  private ads: { mats: THREE.MeshStandardMaterial[]; cells: [number, number][]; period: number; grid: [number, number]; ph: number; cur: number }[] = [];
  private gen = 0;
  /** Test pages: time advances only through update(). */
  manual = false;
  clock = 0;
  /** Tests: pin the darkness (null = the environment's). */
  forceNight: number | null = null;
  /** Called at the end of every update once the ships are posed (time t in s, this frame's poses): camera directors
   *  that follow a ship and name tags read the SAME poses the fleet draws (src/scene/afk). */
  onFrame: ((t: number, poses: readonly ShipPose[]) => void) | null = null;

  now() { return this.manual ? this.clock : Date.now() / 1000; }
  /** The flight plans (null until the ships loaded, or not a traffic room). */
  get flights(): FlightPlanner | null { return this.planner; }
  /** Ship drawn scale (scene.json traffic.shipScale). */
  get shipScale(): number { return this.fleet?.scale ?? 1; }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const cfg = (rt.info as unknown as { traffic?: TrafficCfg }).traffic;
    if (!cfg) return;                 // not a traffic room: nothing at all
    this.rt = rt; this.cfg = cfg;
    this.clock = Date.now() / 1000;
    this.group.name = 'vtp:traffic';
    rt.root.add(this.group);
    try { this.roomFx(rt, cfg); } catch (e) { console.warn('traffic: room fx failed', e); }
    const gen = ++this.gen;
    void this.load(rt, cfg, gen);
  }

  private async load(rt: SceneRuntime, cfg: TrafficCfg, gen: number) {
    try {
      const metaRes = await fetch(sceneFileUrl(rt.info.id, cfg.shipsMeta ?? 'traffic/ships.json'));
      const meta = ((await metaRes.json()) as { ships: ShipMeta[] }).ships ?? [];
      const fleet = new Fleet();
      fleet.scale = Math.min(2, Math.max(0.5, cfg.shipScale ?? 1.2));
      await fleet.load(sceneFileUrl(rt.info.id, cfg.ships ?? 'traffic/ships.glb'), meta);
      if (gen !== this.gen || this.rt !== rt) { fleet.dispose(); return; }
      this.fleet = fleet;
      this.group.add(fleet.group);
      const root = rt.room.root;
      root.updateMatrixWorld(true);
      const toWorld = (p: THREE.Vector3) => root.localToWorld(p);
      this.planner = new FlightPlanner(cfg, meta, toWorld);
      // vehicle templates for the streams (hover cars, pad tugs, drones, CityLink maglev cars): flattened ship-GLB nodes
      const tpls: Record<string, VehicleTemplate> = {};
      for (const m of meta) {
        const root = fleet.templates.get(m.id);
        if (root && (m.cls === 'T' || m.id === 'shuttle')) tpls[m.id] = vehicleTemplate(root, m.length, m.id === 'car' ? 1.5 : m.id === 'tram' ? 1 : 1.3);
      }
      const dens = Math.max(0, Math.min(1.5, (cfg.cars ?? 1) * (gfxBudget().npcDensity ?? 1)));
      const lb0 = gfxBudget().lodBias ?? 1;
      this.streams = new Streams(cfg.lanes ?? [], toWorld, tpls, dens, cfg.seed ?? 18, lb0 < 0.8 ? 0 : 1100 * Math.min(1.4, lb0));
      this.group.add(this.streams.group);
      // hull materials darken with the night (the city around them does, through the environment)
      const seen = new Set<THREE.Material>();
      fleet.group.parent?.updateMatrixWorld();
      for (const tpl of (fleet as unknown as { templates: Map<string, THREE.Object3D> }).templates.values()) {
        tpl.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          for (const mt of Array.isArray(m.material) ? m.material : [m.material]) {
            const sm = mt as THREE.MeshStandardMaterial;
            if (seen.has(sm) || !sm.isMeshStandardMaterial || /^EMIT_/.test(sm.name)) continue;
            seen.add(sm); this.hullMats.push({ m: sm, base: sm.color.clone() });
          }
        });
      }
    } catch (e) {
      console.warn('traffic: assets failed', e);
    }
  }

  private roomFx(rt: SceneRuntime, cfg: TrafficCfg) {
    const root = rt.room.root;
    const seen = new Set<THREE.Material>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (seen.has(m) || !/^ADD_/.test(m.name)) continue;
        seen.add(m);
        m.blending = THREE.AdditiveBlending; m.transparent = true; m.depthWrite = false; m.needsUpdate = true;
        this.addMats.push(m);
      }
    });
    for (const [name, rate] of Object.entries(cfg.spin ?? { HOLO_GLOBE: 0.04 })) {
      const o = root.getObjectByName(name);
      if (o) this.spin.push({ o, rate, rest: o.quaternion.clone() });
    }
    const sg = cfg.smartGlass ?? {};
    const gn = root.getObjectByName(sg.node ?? 'GLASS_SMART') as THREE.Mesh | undefined;
    const gm = gn?.isMesh ? gn : (gn?.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined);
    if (gm && (gm.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      const mat = (gm.material as THREE.MeshStandardMaterial).clone();
      mat.transparent = true; mat.depthWrite = false; mat.opacity = 0;
      if (sg.color) mat.color.set(sg.color);
      gm.material = mat;
      gm.visible = false;
      this.glass = { mesh: gm, mat, base: Math.min(0.95, Math.max(0.2, sg.opacity ?? 0.82)), k: 0, want: 0, color: null };
    }
    for (const [name, spec] of Object.entries(cfg.ads ?? {})) {
      const o = root.getObjectByName(name);
      if (!o || !spec.cells?.length) continue;
      const mats: THREE.MeshStandardMaterial[] = [];
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh) return;
        const mt = (m.material as THREE.MeshStandardMaterial).clone();
        for (const k of ['map', 'emissiveMap'] as const) { const tx = mt[k]; if (tx) { const c2 = tx.clone(); c2.needsUpdate = true; mt[k] = c2; } }
        m.material = mt; mats.push(mt);
      });
      this.ads.push({ mats, cells: spec.cells, period: Math.max(2, spec.period ?? 7), grid: spec.grid ?? [4, 4], ph: (name.length * 1.7) % 5, cur: -1 });
    }
    for (const [name, r] of Object.entries((cfg as TrafficCfg & { roam?: Record<string, { path: [number, number, number][]; closed?: number; pingpong?: number; speed?: number; bob?: number; pause?: number }> }).roam ?? {})) {
      const o = root.getObjectByName(name);
      if (!o || !r.path || r.path.length < 2) continue;
      this.roam.push({ node: o, line: new Polyline(r.path, !!r.closed), speed: r.speed ?? 0.4, bob: r.bob ?? 0, pingpong: !!r.pingpong, pause: r.pause ?? 0, rest: o.position.clone(), restQ: o.quaternion.clone() });
    }
    const pc = (cfg as TrafficCfg & { patrons?: PatronCfg }).patrons;
    if (pc?.list?.length) {
      const P = new Patrons(pc);
      this.patrons = P;
      this.group.add(P.group);
      const g0 = this.gen;
      root.updateMatrixWorld(true);
      void P.load(sceneFileUrl(rt.info.id, pc.units ?? 'patrons/patron_units.glb'), (p) => root.localToWorld(p), () => this.gen === g0 + 1 && this.rt === rt);
    }
    const db = root.getObjectByName(cfg.doorMirror ?? 'DOOR_B');
    if (db) this.doorB = { node: db, rest: db.quaternion.clone(), angle: Number((db.userData as Record<string, unknown>).openAngle ?? -1.72) };
  }

  detach() {
    this.gen++;
    for (const s of this.spin) s.o.quaternion.copy(s.rest);
    this.spin = [];
    if (this.doorB) this.doorB.node.quaternion.copy(this.doorB.rest);
    this.doorB = null;
    if (this.glass) { this.glass.mesh.visible = false; }
    this.glass = null;
    for (const h of this.hullMats) h.m.color.copy(h.base);
    this.hullMats = [];
    this.fleet?.dispose(); this.fleet = null;
    this.streams?.dispose(); this.streams = null;
    this.planner = null; this.poses = []; this.pool.clear();
    this.addMats = []; this.ads = [];
    for (const r of this.roam) { r.node.position.copy(r.rest); r.node.quaternion.copy(r.restQ); }
    this.roam = [];
    this.patrons?.dispose(); this.patrons = null;
    this.group.removeFromParent();
    this.group = new THREE.Group();
    this.rt = null; this.cfg = null;
  }

  /** darkness 0 (day) … 1 (deep night) */
  night(): number {
    if (this.forceNight !== null) return this.forceNight;
    const w = activeEnv()?.townWeather();
    return w ? w.night : 0.3;
  }

  update(dt: number) {
    const rt = this.rt;
    if (!rt) return;
    const t0 = performance.now();
    if (this.manual) this.clock += dt;
    const t = this.now();
    const night = this.night();
    for (const s of this.spin) s.o.quaternion.copy(s.rest).multiply(tq.setFromAxisAngle(Y, (t * s.rate * Math.PI * 2) % (Math.PI * 2)));
    // the second lift leaf mirrors DOOR (fraction read back from the hinge like the raid / space movers do)
    const door = rt.room.door;
    if (this.doorB && door) {
      const cur = (2 * Math.acos(Math.min(1, Math.abs(door.node.quaternion.dot(door.rest))))) / THREE.MathUtils.degToRad(Math.abs(door.openAngle) || 95);
      this.doorB.node.quaternion.copy(this.doorB.rest).multiply(tq.setFromAxisAngle(Y, THREE.MathUtils.degToRad(this.doorB.angle) * Math.min(1, cur)));
    }
    for (const r of this.roam) {
      const L = r.line.length, v = r.speed;
      let s: number, dir = 1;
      if (r.pingpong) {
        const leg = L / v, cyc = 2 * (leg + r.pause), x = ((t % cyc) + cyc) % cyc;
        if (x < leg) s = x * v; else if (x < leg + r.pause) s = L; else if (x < 2 * leg + r.pause) { s = L - (x - leg - r.pause) * v; dir = -1; } else s = 0;
      } else s = t * v;
      r.line.at(s, r.node.position, TAN);
      r.node.position.y += r.bob * Math.sin(t * 2.1);
      if (r.line.closed || r.pingpong) r.node.rotation.set(0, Math.atan2(TAN.x * dir, TAN.z * dir), 0);
    }
    if (this.patrons) {
      const faces: THREE.Vector3[] = [];
      for (const a of rt.actors.values()) { if (!a.shown || !a.spot) continue; const f = a.faceAt(a.spot); if (f) faces.push(f.center); }
      this.patrons.update(t, dt, rt.stage.camera, faces, gfxBudget().lodBias ?? 1);
    }
    for (const a of this.ads) {
      const x = t / a.period + a.ph;
      const i = Math.floor(x) % a.cells.length;
      const fr = x - Math.floor(x);
      if (i !== a.cur) {
        a.cur = i;
        const [c0, r0] = a.cells[0], [c, r] = a.cells[i];
        for (const m of a.mats) for (const tx of [m.map, m.emissiveMap]) if (tx) tx.offset.set((c - c0) / a.grid[0], (r - r0) / a.grid[1]);
      }
      // a holo glitch as the ad changes: flicker for the first 0.25 s
      const gl = fr * a.period < 0.25 ? (Math.sin(t * 90) > 0 ? 0.25 : 1.2) : 1 + 0.06 * Math.sin(t * 7);
      // (photosensitivity: the 14 Hz glitch is an output on the page's governor)
      const gk = pageGovernor(performance.timeOrigin + performance.now()).step((a as unknown as { gch?: GovChannel }).gch ??= govChannel('ad glitch'), gl);
      for (const m of a.mats) m.emissiveIntensity = (m.userData.baseI ??= m.emissiveIntensity || 1) * gk;
    }
    if (this.glass) {
      const g = this.glass;
      g.want = rt.state.mode === 'react' ? 1 : 0;
      g.k += Math.sign(g.want - g.k) * Math.min(Math.abs(g.want - g.k), dt / 1.2);
      g.mat.opacity = g.base * g.k * g.k * (3 - 2 * g.k);
      g.mesh.visible = g.k > 0.002;
    }
    if (this.planner && this.fleet) {
      this.planner.sample(t, this.poses, this.pool);
      const lb = gfxBudget().lodBias ?? 1;
      this.fleet.lod0Px = lb < 0.8 ? Infinity : 220 / (lb * lb);
      this.fleet.update(this.poses, night, t, rt.stage.camera, rt.stage.renderer.domElement.height || 720);
      this.lastLod = this.fleet.counts;
      const f = 1 - 0.5 * night;           // the pads' floodlights keep a parked hull readable at night
      for (const h of this.hullMats) h.m.color.copy(h.base).multiplyScalar(f);
    }
    this.streams?.update(t, night, rt.stage.renderer.domElement.height || 720);
    if (this.onFrame && this.planner) try { this.onFrame(t, this.poses); } catch (e) { console.warn('traffic: onFrame', e); }
    const ms = performance.now() - t0;
    this.perf.avg += (ms - this.perf.avg) * 0.05;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  info() {
    return {
      on: !!this.rt, ships: this.fleet?.count ?? 0, loaded: !!this.fleet?.ready, pads: this.planner?.pads.length ?? 0,
      cruiseLanes: this.planner?.cruise.length ?? 0, cars: this.streams?.count ?? 0, parked: this.planner?.parked.length ?? 0, lod: this.lastLod, ads: this.ads.length,
      patrons: this.patrons?.count ?? 0, patronErr: this.patrons?.error || undefined, roam: this.roam.length,
      trains: this.streams?.countOf('tram') ?? 0, hulls: this.streams?.hulls ?? 0, tugs: this.streams?.countOf('tug') ?? 0, night: +this.night().toFixed(2),
      glass: +(this.glass?.k ?? 0).toFixed(2), phases: this.poses.map((p) => `${p.key}:${p.ship}:${p.phase}`),
      ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(3), error: this.fleet?.error || undefined,
    };
  }
  debug() { return this.info(); }
}
