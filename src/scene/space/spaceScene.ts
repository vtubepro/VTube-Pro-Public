// SpaceScene: the space battle outside a ship's viewport for the current room (SceneState.space — host-owned, so the
// studio preview, every OBS page and party guests show the SAME battle). Attached to the SceneRuntime by the page
// (output.ts), like RaidScene / ChatScene. Rooms opt in with SPACE_* anchors (src/scene/space/spaceRoom.ts); other
// rooms cost one check per frame.
//
//   backdrop.ts  sky + stars + sun, planet (continents, clouds, war zones, timed impacts), atmosphere, moon
//   ships.ts     instanced ships / hull pieces / debris (cel-lit by the sun, warp stretch, heat, dithered fades)
//   fx.ts        additive sprites, smoke puffs, streaks (tracers, shells, beams, trails, warp lines)
//   director.ts  the deterministic acts (closed-form in wall-clock time, planned from seed + epoch + room)
//
// On the bridge: a threat event turns the lights red (a slow ≤ 1 Hz pulse on the stage lights, the room's house
// materials and any EMIT_alert / EMIT_alarm material), the dreadnought's death flashes the bridge once, optional camera
// shake (never in React mode — the OBS hole must not move). The bridge changes are applied only while the frame
// renders (scene.onBeforeRender → onAfterRender restores), so the light engine's own values are never disturbed.
// Light cues: lights.cue('spaceAlert' | 'spaceBoom') when the engine lists them in `cues`, else 'screenLand' on the
// explosion (like the raid's hammer hit).
import * as THREE from 'three';
import { DEFAULT_SPACE_STATE, spaceActOn, type SceneSpaceState } from '../../../shared/space.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { hash32, Rng } from '../raid/rng.ts';
import { Backdrop } from './backdrop.ts';
import { SpaceDirector, SpaceGeo, type Frame, type PodLaunch } from './director.ts';
import { SpaceFx } from './fx.ts';
import { FACE_SLOTS, faceUniforms, ShipSet } from './ships.ts';
import { spaceRoomOf, type SpaceRoom } from './spaceRoom.ts';
import { registerRaidEvent } from '../raid/raidScene.ts';

// A space room's scene.json may name `enemy_ship` as its raid donation event (the Helldivers bridge does): the raid
// engine has nothing to plan for it — the space scene plays those stamps as threat events (see `state`). Support
// events themselves are handled by the Space section's own rules (controller.spaceSupport), so raid stamps from
// support ('sup:…') are ignored here; explicit ones (bus / MCP `scene {raid: {event: 'enemy_ship'}}`) play.
registerRaidEvent('enemy_ship', { available: () => false, plan: () => null });

/** Implemented by the cryo / drop-pod mover: drop-pod launches (for the re-entry streak). */
export interface LaunchSource { spaceLaunches(): PodLaunch[] }

const tv = new THREE.Vector3();

export class SpaceScene {
  private rt: SceneRuntime | null = null;
  room: SpaceRoom | null = null;
  private group = new THREE.Group();
  private backdrop: Backdrop | null = null;
  ships: ShipSet | null = null;
  private fx: SpaceFx | null = null;
  director: SpaceDirector | null = null;
  private geoSeed = -1;
  private loading = false;
  private loadErr = '';
  private savedFar = 0;
  private label: { mesh: THREE.Mesh; key: string; tex: THREE.CanvasTexture } | null = null;
  private frame: Frame | null = null;
  private faceT = 0;
  private shake = 0;
  private shakeSeed = 1;
  private bridge = { alert: 0, flash: 0, col: new THREE.Color(1, 0.9, 0.7) };
  private restore: (() => void) | null = null;
  private prevHooks: { before: THREE.Scene['onBeforeRender']; after: THREE.Scene['onAfterRender'] } | null = null;
  private house: THREE.MeshStandardMaterial[] = [];
  private alarms: THREE.MeshStandardMaterial[] = [];
  private warmed = false;
  /** Test pages: time advances only through update(). */
  manual = false;
  clock = Date.now();
  /** Tests: override the state (null = the room state). */
  forceState: Partial<SceneSpaceState> | null = null;
  /** Tests: pin the perf level (null = automatic). */
  forceLevel: number | null = null;
  /** Tests: a fixed camera. */
  debugCam: { pos: [number, number, number]; target: [number, number, number]; fov?: number } | null = null;
  private perf = { avg: 0, peak: 0, dtAvg: 1 / 60, dtBase: 1 / 60, level: 0, slowFor: 0, goodFor: 0 };
  cues: string[] = [];

  now() { return this.manual ? this.clock : Date.now(); }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.rt = rt;
    this.room = spaceRoomOf(rt.room, rt.info);
    // the mover reads the host's cryo / drop-pod toggles through this
    (rt.mover as unknown as { spaceState?: () => SceneSpaceState }).spaceState = () => this.state;
    if (!this.room?.hasSpace) return;
    const R = this.room;
    this.group.name = 'vtp:space';
    this.group.position.copy(R.view.center).multiplyScalar(1 - R.k);
    this.group.scale.setScalar(R.k);
    rt.root.add(this.group);
    // stand-in meshes a room may carry at the anchors (planet / ships) are drawn by us
    rt.room.root.traverse((o) => { if (/^SPACE_(PLANET|MOON|SUN|SHIP_\d+)$/.test(o.name)) o.visible = false; });
    const cam = rt.stage.camera;
    this.savedFar = cam.far;
    const far = Math.max(cam.far, (R.reach * R.k + R.view.center.length()) * 1.25 + 200);
    cam.far = far; cam.updateProjectionMatrix();
    this.backdrop = new Backdrop(R, this.group, rt.root, far * 0.9);
    if (!R.sky) { this.backdrop.sky.visible = false; }
    this.fx = new SpaceFx();
    this.fx.uniforms.uK.value = R.k;
    this.group.add(this.fx.group);
    // a room's own self-lit shells tagged additive (e.g. the bridge's PLANET_ATMOSPHERE: extras blending: additive)
    rt.room.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) {
        const tag = (mt.userData as Record<string, unknown>)?.blending ?? (o.userData as Record<string, unknown>)?.blending ?? (o.parent?.userData as Record<string, unknown> | undefined)?.blending;
        if (tag === 'additive' && mt.blending !== THREE.AdditiveBlending) { mt.blending = THREE.AdditiveBlending; mt.transparent = true; mt.depthWrite = false; mt.needsUpdate = true; }
      }
    });
    // bridge: house materials + alarm strips (red alert), scene render hooks
    const seen = new Set<THREE.Material>();
    rt.room.root.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!(o as THREE.Mesh).isMesh || !m) return;
      for (const mt of Array.isArray(m) ? m : [m]) {
        const sm = mt as THREE.MeshStandardMaterial;
        if (seen.has(sm) || !sm.isMeshStandardMaterial) continue;
        seen.add(sm);
        if (/^EMIT_(alert|alarm|redalert)/i.test(sm.name)) this.alarms.push(sm);
        else if (!/^EMIT_/.test(sm.name) && !(rt.room.screen && isUnder(o, rt.room.screen.node)) && !outside(o, R.own.planetNode)) this.house.push(sm);
      }
    });
    const sc = rt.stage.scene;
    this.prevHooks = { before: sc.onBeforeRender, after: sc.onAfterRender };
    const self = this;
    sc.onBeforeRender = function (...args) { self.prevHooks?.before.apply(this, args); self.beforeRender(); };
    sc.onAfterRender = function (...args) { self.afterRender(); self.prevHooks?.after.apply(this, args); };
    this.ensureAssets();
  }

  detach() {
    const rt = this.rt;
    if (rt && this.prevHooks) { rt.stage.scene.onBeforeRender = this.prevHooks.before; rt.stage.scene.onAfterRender = this.prevHooks.after; }
    this.afterRender();
    this.prevHooks = null;
    if (rt && this.savedFar) { rt.stage.camera.far = this.savedFar; rt.stage.camera.updateProjectionMatrix(); }
    this.savedFar = 0;
    this.backdrop?.dispose(); this.backdrop = null;
    this.fx?.dispose(); this.fx = null;
    if (this.ships) { this.ships.group.removeFromParent(); }
    if (this.label) { this.label.mesh.removeFromParent(); this.label.tex.dispose(); this.label.mesh.geometry.dispose(); (this.label.mesh.material as THREE.Material).dispose(); this.label = null; }
    this.group.removeFromParent();
    this.group.clear();
    this.director = null; this.geoSeed = -1;
    this.house = []; this.alarms = [];
    this.rt = null; this.room = null;
    this.warmed = false;
  }

  get state(): SceneSpaceState {
    let s = this.rt?.state.space ?? DEFAULT_SPACE_STATE;
    const raid = this.rt?.state.raid?.events;
    if (raid?.length) {
      const donation = this.rt?.info.raid?.donationEvent === 'enemy_ship';
      const extra = raid.filter((e) => (e.k === 'enemy_ship' || (donation && e.k === 'donation')) && !e.id.startsWith('sup:') && !s.events.some((x) => x.id === e.id))
        .map((e) => ({ k: 'threat', at: e.at, id: `raid:${e.id}`, ...(e.user ? { user: e.user } : {}), ...(e.amount ? { amount: e.amount } : {}) }));
      if (extra.length) s = { ...s, events: [...s.events, ...extra] };
    }
    return this.forceState ? { ...s, ...this.forceState, show: { ...s.show, ...(this.forceState.show ?? {}) } } : s;
  }

  private ensureAssets() {
    if (this.ships || this.loading || this.loadErr) return;
    this.loading = true;
    ShipSet.load().then((s) => {
      this.ships = s;
      if (this.room) s.setSun(this.room.sun.pos.clone().sub(this.room.view.center).normalize(), this.room.sun.color);
      if (this.rt && this.room?.hasSpace) this.group.add(s.group);
    }).catch((e) => { this.loadErr = String((e as Error)?.message ?? e); console.warn('space ships', e); }).finally(() => { this.loading = false; });
  }

  // ---------------------------------------------------------------- per frame
  update(dt: number) {
    const t0 = performance.now();
    this.step(dt);
    const ms = performance.now() - t0;
    this.perf.avg = this.perf.avg * 0.97 + ms * 0.03;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private step(dt: number) {
    const rt = this.rt, R = this.room;
    if (rt) (rt.mover as unknown as { sceneMode?: string }).sceneMode = rt.state.mode;
    if (!rt || !R?.hasSpace || !this.backdrop || !this.fx) return;
    if (this.manual) this.clock += dt * 1000;
    const now = this.now();
    const st = this.state;
    if (this.ships && !this.ships.group.parent) this.group.add(this.ships.group);
    if (!this.director || this.geoSeed !== st.seed) {
      if (!this.ships) { this.drawBackdropOnly(now, st); return; }
      this.director = new SpaceDirector(new SpaceGeo(R, this.ships.meta, st.seed));
      this.geoSeed = st.seed;
      this.backdrop.setZones(this.director.g.zones);
    }
    if (!this.warmed) this.warm();
    this.governor(dt);
    const cam = rt.stage.camera;
    if (this.debugCam) { cam.position.set(...this.debugCam.pos); cam.lookAt(new THREE.Vector3(...this.debugCam.target)); if (this.debugCam.fov && cam.fov !== this.debugCam.fov) { cam.fov = this.debugCam.fov; cam.updateProjectionMatrix(); } cam.updateMatrixWorld(); }
    const H = rt.stage.renderer.domElement.height || 1080;
    const detail = this.perf.level === 0 ? 1 : 0;
    const F: Frame = this.frame ??= { now, t: 0, ships: this.ships!, fx: this.fx, impacts: [], alert: 0, flash: 0, flashCol: new THREE.Color(), shake: 0, moments: [], labels: [], detail };
    F.now = now; F.t = (now / 1000) % 100000; F.impacts.length = 0; F.alert = 0; F.flash = 0; F.shake = 0; F.moments.length = 0; F.labels.length = 0; F.detail = detail;
    this.ships!.begin(F.t);
    this.fx.begin(F.t);
    this.fx.level = this.perf.level;
    const pods = (rt.mover as unknown as Partial<LaunchSource>).spaceLaunches?.() ?? [];
    this.director.frame(st, now, F, pods);
    this.ships!.end();
    this.fx.end();
    this.backdrop.setImpacts(F.impacts);
    const combat = st.on && st.show.planet && spaceActOn(R.acts, 'planet') ? 1 : 0;
    this.backdrop.update(cam, now / 1000, detail, combat, H);
    // a room's own planet: our combat overlay only draws while there is something to show
    if (R.own.planet) this.backdrop.planet.visible = combat > 0 || F.impacts.length > 0;
    this.fx.uniforms.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / H;
    // the bridge
    this.bridge.alert = st.alert ? F.alert : 0;
    this.bridge.flash = F.flash; this.bridge.col.copy(F.flashCol);
    if (F.shake > 0 && st.shake && rt.state.mode !== 'react' && F.shake > this.shake) { this.shake = F.shake * 0.9; this.shakeSeed = hash32(now, 'shake'); }
    this.applyShake(dt);
    this.faceT -= dt;
    if (this.faceT <= 0) { this.faceT = 0.2; this.protectFaces(); }
    this.drawLabel(F);
    for (const m of F.moments) this.moment(m.what);
  }

  private drawBackdropOnly(now: number, st: SceneSpaceState) {
    const rt = this.rt!;
    this.backdrop!.update(rt.stage.camera, now / 1000, 1, st.show.planet && spaceActOn(this.room?.acts, 'planet') ? 1 : 0, rt.stage.renderer.domElement.height || 1080);
  }

  private moment(what: string) {
    const L = this.rt?.lights as unknown as { cue?: (w: string) => void; cues?: string[] } | undefined;
    this.cues.push(what); if (this.cues.length > 20) this.cues.shift();
    if (!L?.cue) return;
    try {
      if (what === 'alert' && L.cues?.includes('spaceAlert')) L.cue('spaceAlert');
      else if (what === 'destroyed') L.cue(L.cues?.includes('spaceBoom') ? 'spaceBoom' : L.cues?.includes('donation') ? 'donation' : 'screenLand');
    } catch { /* optional hook */ }
  }

  /** Compile every space shader once, off the first real frame (no hitch when the first threat warps in). */
  private warm() {
    this.warmed = true;
    const rt = this.rt!;
    const far = this.room!.view.center.clone().add(new THREE.Vector3(0, -1e5, 0));
    this.ships!.begin(0); this.ships!.warmAll(far); this.ships!.end();
    const r = rt.stage.renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> };
    try { void (r.compileAsync ? r.compileAsync(this.group, rt.stage.camera, rt.stage.scene) : Promise.resolve(r.compile(this.group, rt.stage.camera, rt.stage.scene))).catch(() => {}); } catch { /* optional */ }
  }

  private governor(dt: number) {
    const P = this.perf;
    P.dtAvg = P.dtAvg * 0.95 + Math.min(0.2, dt) * 0.05;
    P.dtBase = Math.min(P.dtBase * 1.0005, P.dtAvg);
    const low = (this.rt?.opts.tier ?? 'high') === 'low';
    const slow = P.avg > 1.5 || (P.dtAvg > P.dtBase * 1.35 && P.dtAvg > 1 / 45);
    if (slow) { P.slowFor += dt; P.goodFor = 0; } else { P.goodFor += dt; P.slowFor = 0; }
    if (P.slowFor > 2.5 && P.level < 2) { P.level++; P.slowFor = 0; }
    if (P.goodFor > 25 && P.level > (low ? 1 : 0)) { P.level--; P.goodFor = 0; }
    if (low && P.level < 1) P.level = 1;
    if (this.forceLevel !== null) P.level = this.forceLevel;
  }

  // ---------------------------------------------------------------- faces: the battle dims right behind a face
  protect = true;
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
    this.shake = Math.max(0, this.shake - dt * 1.1);
    if (this.rt!.state.mode === 'react') { this.shake = 0; return; }
    const cam = this.rt!.stage.camera;
    const k = this.shake ** 2;
    const r = new Rng(this.shakeSeed + Math.floor(this.shake * 60));
    cam.position.x += r.range(-1, 1) * 0.04 * k;
    cam.position.y += r.range(-1, 1) * 0.035 * k;
    cam.rotation.z += r.range(-1, 1) * 0.008 * k;
    cam.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- support label (who summoned it)
  private drawLabel(F: Frame) {
    const l = F.labels[0];
    if (!l) { if (this.label) this.label.mesh.visible = false; return; }
    if (!this.label || this.label.key !== l.key) {
      const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
      const g = c.getContext('2d')!;
      g.fillStyle = 'rgba(8,10,14,0.72)'; g.fillRect(0, 40, 1024, 176);
      g.fillStyle = '#f2c230'; g.fillRect(0, 40, 14, 176); g.fillRect(1010, 40, 14, 176);
      for (let i = 0; i < 20; i++) { g.fillStyle = i % 2 ? '#111' : '#f2c230'; g.fillRect(i * 52, 216, 52, 10); }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#f2c230'; g.font = "900 58px Impact, 'Arial Black', sans-serif";
      let fs = 58; while (g.measureText(l.text).width > 960 && fs > 26) { fs -= 2; g.font = `900 ${fs}px Impact, 'Arial Black', sans-serif`; }
      g.fillText(l.text, 512, 100);
      g.fillStyle = '#ffffff'; g.font = "700 50px 'Arial Black', sans-serif"; g.fillText(l.sub, 512, 170);
      if (this.label) { this.label.tex.dispose(); this.label.mesh.geometry.dispose(); (this.label.mesh.material as THREE.Material).dispose(); this.label.mesh.removeFromParent(); }
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.25), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
      mesh.name = 'vtp:space:label'; mesh.renderOrder = 5;
      this.group.add(mesh);
      this.label = { mesh, key: l.key, tex };
    }
    const m = this.label.mesh;
    m.visible = true;
    m.position.copy(l.pos);
    const cam = this.rt!.stage.camera;
    m.quaternion.copy(cam.quaternion);
    const camA = cam.position.clone().sub(this.room!.view.center).multiplyScalar(1 / this.room!.k).add(this.room!.view.center);
    m.scale.setScalar(Math.max(20, l.pos.distanceTo(camA) * 0.42));
    (m.material as THREE.MeshBasicMaterial).opacity = l.alpha;
  }

  // ---------------------------------------------------------------- bridge red alert / flash (render-time only)
  private beforeRender() {
    const a = this.bridge.alert, f = this.bridge.flash;
    if (a < 0.002 && f < 0.002) return;
    const t = this.now() / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.75);       // 0.75 Hz — well under the photosensitivity limits
    const red = a * (0.35 + 0.65 * pulse);
    const undo: (() => void)[] = [];
    const sc = this.rt!.stage.scene;
    for (const o of sc.children) {
      const l = o as THREE.Light;
      if (!l.isLight) continue;
      const c0 = l.color.clone(), i0 = l.intensity;
      l.color.lerp(new THREE.Color(1, 0.12, 0.08), red * 0.75);
      l.intensity = i0 * (1 + f * 1.6) * (1 - red * 0.2);
      if (f > 0) l.color.lerp(this.bridge.col, f * 0.5);
      undo.push(() => { l.color.copy(c0); l.intensity = i0; });
    }
    for (const m of this.house) {
      const c0 = m.color.clone();
      m.color.multiply(new THREE.Color(1, 1 - red * 0.7, 1 - red * 0.72));
      if (f > 0) m.color.lerp(this.bridge.col, f * 0.22);
      undo.push(() => m.color.copy(c0));
    }
    for (const m of this.alarms) {
      const e0 = m.emissive.clone(), i0 = m.emissiveIntensity;
      m.emissive.setRGB(1, 0.1, 0.06); m.emissiveIntensity = Math.max(i0, 0.3 + 5 * red);
      undo.push(() => { m.emissive.copy(e0); m.emissiveIntensity = i0; });
    }
    this.restore = () => { for (const u of undo) u(); };
  }
  private afterRender() { this.restore?.(); this.restore = null; }

  // ---------------------------------------------------------------- UI / debug
  info() {
    const R = this.room;
    if (!this.rt || !R) return null;
    const st = this.state;
    return { space: R.hasSpace, cryo: R.cryoPods.length, droppod: R.dropPods.length, entrance: R.entrance, exit: R.exit, active: this.director?.active.length ?? 0, next: this.director?.nextThreat(st, this.now()) ?? null, ms: +this.perf.avg.toFixed(3), level: this.perf.level };
  }

  debug() {
    const R = this.room;
    return {
      perf: { avg: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(2), level: this.perf.level, dtAvg: +(this.perf.dtAvg * 1000).toFixed(1) },
      room: R ? { k: +R.k.toFixed(3), reach: Math.round(R.reach), ships: R.ships.length, warps: R.warps.length, approaches: R.approaches.length, lanes: R.lanes.pts.length, cryo: R.cryoPods.length, drop: R.dropPods.length, join: R.joinPath.length, leave: R.leavePath.length, targets: this.director?.g.targets.length ?? 0, zones: this.director?.g.zones.length ?? 0, cams: Object.fromEntries(Object.entries(R.cams).map(([k, v]) => [k, v?.name ?? null])) } : null,
      assets: this.ships ? { tris: this.ships.tris } : this.loadErr || (this.loading ? 'loading' : 'idle'),
      active: this.director?.active ?? [],
      counts: { ships: this.ships?.counts() ?? {}, fx: this.fx?.counts() ?? null, impacts: this.frame?.impacts.length ?? 0 },
      bridge: { alert: +this.bridge.alert.toFixed(2), flash: +this.bridge.flash.toFixed(2), shake: +this.shake.toFixed(2) },
      cues: this.cues.slice(-8),
      info: this.info(),
    };
  }
}

/** The room's own view of space (planet — also one named by scene.json space.planetNode —, sky, fleet, our hull
 *  outside) never turns red. */
function outside(o: THREE.Object3D, planetNode?: string | null) { for (let x: THREE.Object3D | null = o; x; x = x.parent) if (/^(PLANET|SPACE_|MOON|SHIP_HULL|SHIP_BAYS|SKY)/.test(x.name) || (planetNode && x.name === planetNode)) return true; return false; }

function isUnder(o: THREE.Object3D, p: THREE.Object3D) { for (let x: THREE.Object3D | null = o; x; x = x.parent) if (x === p) return true; return false; }
