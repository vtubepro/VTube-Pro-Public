// The Trail — one view of the game: a player's own first / third-person view (studio overlay) or the stream spectator
// (OBS). Consumes the host's reliable messages + snapshots, renders the world, the performers (their own avatars,
// tracked), the HUD, and sends this player's input.
import * as THREE from 'three';
import type { LevelDesc } from '../../../../shared/trail/levels.ts';
import { ROAD_SPEED } from '../../../../shared/trail/levels.ts';
import type { GameState } from '../../../../shared/trail/types.ts';
import { milesPerDay } from '../../../../shared/trail/rules.ts';
import { ANIM, F, emptyInput, type InputFrame, type Snapshot, type TrailCmd, type TrailCtl } from '../../../../shared/trail/wire.ts';
import type { TrackingFrame } from '../../../../shared/types.ts';
import { PlayerAvatar, type AvatarSource } from './avatars.ts';
import { sanitizeLite, type DeckLite } from './decklite.ts';
import { Ents, type EntView } from './ents.ts';
import { Hud } from './hud.ts';
import { GameInput } from './input.ts';
import { World3D } from './world3d.ts';
import { CameraRig } from './camera.ts';
import { LEVEL_FILES } from '../../../../shared/trail/levels.ts';
import { sizeStats } from '../../../../shared/trail/sizes.ts';
import { Sfx } from './sfx.ts';
import { JourneyTerrain } from './terrain.ts';
import { JourneyHud } from './hudJourney.ts';
import { WeatherFx } from './weather.ts';
import { WeightMeters } from './weight.ts';
import { CampView } from './campView.ts';

export interface ViewLink { myId: string; isHost: boolean; sendInput(f: InputFrame): void; sendCmd(c: TrailCmd): void }
export interface ViewOpts {
  link: ViewLink;
  spectator?: boolean;
  /** Where each player's avatar comes from (self: the studio's; party: the sealed vault; test: library stand-ins). */
  avatarFor(playerId: string): AvatarSource;
  /** Test harness: scripted input instead of keyboard + mouse. */
  script?: (v: GameView) => InputFrame | null;
  shadows?: boolean;
  transparent?: boolean;
  /** Esc (mouse already free) / the halt card: the game menu (leave / end). */
  menu?: () => void;
}
type CamMode = 'third' | 'first' | 'spect';

export class GameView {
  readonly world: World3D;
  readonly ents: Ents;
  readonly hud: Hud;
  readonly input: GameInput | null;
  readonly avatars = new Map<string, PlayerAvatar>();
  readonly sfx = new Sfx();
  private lastVoteId = ''; private lastCardId = '';
  state: GameState | null = null;
  deck: DeckLite | null = null;
  camMode: CamMode;
  private canvas: HTMLCanvasElement;
  private last = performance.now();
  private raf = 0;
  private lastInputSent = 0;
  private running = false;
  private camPos = new THREE.Vector3(0, 3, 8);
  private camLook = new THREE.Vector3();
  private shot = { kind: 'wide', target: '', until: 0, since: 0 };
  private levelKey = '';
  private shake = 0;
  stats = { fps: 0, frames: 0, t0: performance.now(), renderMs: 0 };
  readonly rig: CameraRig;
  // frame-time record (for the perf report) + adaptive resolution
  private ft = new Float32Array(1200);
  private ftN = 0;
  private slowT = 0; private fastT = 0;
  // own-player prediction: input send times by seq (low byte), recent input velocities, measured input → host latency
  private sentAt = new Float64Array(256);
  private lastAck = -1;
  latency = 0.05;
  private hist: { t: number; vx: number; vz: number }[] = [];
  private lead = new THREE.Vector3();
  private tmpV = new THREE.Vector3();
  private tgt = new THREE.Vector3();
  /** v2: the journey's terrain (while the host runs the procedural journey) + its HUD. */
  terrain: JourneyTerrain | null = null;
  readonly jhud: JourneyHud;
  private todShown = -1;
  private memeBig = new Map<string, number>();
  private weather = new WeatherFx();
  /** Strain meters over held things + the look-at weight tag (weight.ts, trailbodies). */
  readonly weights: WeightMeters;
  readonly campView: CampView;
  private tick = 0;
  private solidPool: THREE.Vector3[] = [];
  private shotAnchor = new THREE.Vector3();
  private tmpP = new THREE.Vector3();

  constructor(readonly container: HTMLElement, readonly o: ViewOpts) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    // (only when static: trail.html's #game is absolutely positioned — forcing 'relative' collapsed it to 0 px high)
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.append(this.canvas);
    this.world = new World3D(this.canvas, { shadows: o.shadows ?? true, transparent: o.transparent });
    this.rig = new CameraRig(this.world.camera);
    this.ents = new Ents(this.world, 'frontier');
    this.ents.onPlayerEnt = (v, added) => this.onPlayerEnt(v, added);
    this.ents.onRebase = (dx, dz) => this.onRebase(dx, dz);
    this.weights = new WeightMeters(this.world.entRoot);
    this.campView = new CampView(this.world.scene);
    this.camMode = o.spectator ? 'spect' : 'third';
    this.sfx.enabled = !o.spectator && !o.script;
    this.hud = new Hud(container, { cmd: (c) => this.o.link.sendCmd(c), myId: () => this.o.link.myId, isHost: () => this.o.link.isHost, menu: () => this.o.menu?.() }, !!o.spectator);
    this.jhud = new JourneyHud(container, { cmd: (c) => this.o.link.sendCmd(c), myId: () => this.o.link.myId, spectator: !!o.spectator });
    this.input = o.spectator || o.script ? null : new GameInput(this.canvas, {
      vote: (i) => { const v = this.state?.vote; const opt = v?.options[i]; if (opt && !opt.disabled) { this.o.link.sendCmd({ c: 'vote', opt: opt.id }); this.sfx.play('cast', 0.6); } },
      halt: () => this.o.link.sendCmd({ c: 'halt' }),
      camera: () => { this.camMode = this.camMode === 'third' ? 'first' : 'third'; },
      ready: () => this.onEnter(),
      tab: (on) => this.hud.setTab(on),
      map: () => this.hud.toggleMap(),
      epitaph: () => this.hud.openEpitaph(),
      escape: () => { if (this.input?.pointerLocked) this.input.release(); else this.o.menu?.(); },
      typing: () => this.hud.typing,
      hunting: () => this.state?.stop?.kind === 'hunt',
      emote: (on) => { this.jhud.emoteWheel(on); if (this.input) this.input.frozen = this.jhud.wheelActive; },
      unstuck: () => { if (this.state?.journey) this.o.link.sendCmd({ c: 'unstuck' }); },
    });
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();
  }
  private resize() { const r = this.container.getBoundingClientRect(); this.world.resize(Math.max(1, r.width), Math.max(1, r.height)); }
  private onEnter() {
    const st = this.state;
    if (!st) return;
    if (st.card && this.o.link.isHost) { this.o.link.sendCmd({ c: 'continue' }); return; }
    if (st.phase === 'stop' && st.stop) { if (this.o.link.isHost) this.o.link.sendCmd({ c: 'continue' }); else this.o.link.sendCmd({ c: 'ready', on: true }); }
    else if (st.phase === 'lobby') this.o.link.sendCmd({ c: 'ready', on: !st.players.find((p) => p.id === this.o.link.myId)?.ready });
  }

  // ---------------------------------------------------------------- host messages
  onCtl(m: TrailCtl) {
    switch (m.k) {
      case 'hello': {
        const d = sanitizeLite(m.deck);
        if (d) this.setDeck(d);
        const th = m.theme;
        if (th && th !== this.preloaded) {
          this.preloaded = th;
          const rels = ['wagon.glb', 'props.glb', 'animals/draft.glb', 'levels/trail_road.glb', ...Object.values(LEVEL_FILES).map((f) => `${f[0]}.glb`)];
          void this.world.preload(th, rels);
        }
        break;
      }
      case 'state': {
        this.state = m.s; this.syncPlayers();
        const vid = m.s.vote?.id ?? '', cid = m.s.card?.id ?? '';
        if (vid && vid !== this.lastVoteId) this.sfx.play('vote', 0.7);
        if (cid && cid !== this.lastCardId) this.sfx.play(m.s.card?.tier === 'insane' ? 'insane' : 'card', 0.7);
        this.lastVoteId = vid; this.lastCardId = cid;
        break;
      }
      case 'level': {
        const desc = m.desc as LevelDesc;
        this.levelKey = m.id;
        this.ents.theme = desc?.theme ?? this.ents.theme;
        this.world.roadSeed = hash(m.seed ?? 'x');
        if (desc) void this.world.setLevel(m.id, desc);
        if (desc?.kind !== 'journey' && this.terrain) { this.terrain.dispose(); this.terrain = null; this.world.blockers.ground = null; this.weather.set('clear'); }
        this.rig.resetChase();
        this.ents.setAll(m.ents);
        this.shot.until = 0;
        break;
      }
      case 'spawn': this.ents.spawn(m.ents); break;
      case 'despawn': this.ents.despawn(m.ids); break;
      case 'ev': {
        const e = m.e;
        if (e.e === 'rebase') { this.ents.rebase(e.dz); this.world.rebase(e.dz); for (const a of this.avatars.values()) a.pivot.position.z += e.dz; this.camPos.z += e.dz; this.camLook.z += e.dz; this.rig.shift(e.dz); }
        else if (e.e === 'shake') this.shake = Math.max(this.shake, e.k);
        else if (e.e === 'death' && this.o.spectator) { this.shot = { kind: 'face', target: e.id, until: performance.now() + 6000, since: performance.now() }; }
        this.hud.event(e);
        this.jhud.event(e, (id) => this.state?.players.find((p) => p.id === id)?.name ?? '');
        if (e.e === 'emote') this.avatars.get(e.who)?.playEmote(e.id);
        if (e.e === 'meme' && this.o.spectator && e.tier !== 'common' && e.who) this.shot = { kind: 'face', target: e.who, until: performance.now() + 5000, since: performance.now() };
        if (e.e === 'meme' && e.k === 'bighead' && e.who) { this.memeBig.set(e.who, performance.now() + (e.dur ?? 10) * 1000); this.syncPlayers(); }
        if (e.e === 'meme' && e.k === 'kaiju') this.shake = Math.max(this.shake, 1.2);
        this.sfx.event(e);
        break;
      }
      case 'end': break;
    }
  }
  private preloaded = '';
  /** The floating origin moved (the journey): shift everything this view keeps in local space. */
  private onRebase(dx: number, dz: number) {
    for (const a of this.avatars.values()) { a.pivot.position.x += dx; a.pivot.position.z += dz; }
    this.camPos.x += dx; this.camPos.z += dz; this.camLook.x += dx; this.camLook.z += dz;
    this.shotAnchor.x += dx; this.shotAnchor.z += dz;
    this.campView.shift(dx, dz);
    this.rig.shift(dz, dx);
    if (this.terrain && this.ents.origin) this.terrain.setOrigin(this.ents.origin);
  }
  /** v2 journey: terrain streaming, the sky's time of day, the camera's ground. */
  private updateJourney(dt: number) {
    const st = this.state, lv = this.world.level;
    if (lv?.kind !== 'journey' || !st?.run || !this.deck) return;
    if (!this.terrain) {
      const d = this.deck;
      const route = (st.run.slice && d.slice?.length ? d.slice : d.route).map((n) => ({ id: n.id, kind: n.kind, name: n.name, miles: n.miles }));
      this.terrain = new JourneyTerrain(d.id, { seed: st.seed, theme: d.id, route, biomes: d.biomes });
      this.world.scene.add(this.terrain.root);
      const t = this.terrain;
      void t.warm(this.world.renderer, this.world.camera, this.world.lights());
      this.world.blockers.ground = (x, z) => t.groundLocal(x, z);
    }
    const o = this.ents.origin;
    if (o && (o[0] !== this.terrain.origin[0] || o[1] !== this.terrain.origin[1])) this.terrain.setOrigin(o);
    const cam = this.world.camera.position;
    this.terrain.update(dt, cam.x, cam.z, st.run.oldGraves, st.run.miles);
    const J = st.journey;
    if (J) {
      // ease the displayed time of day (the host sends it a few times a second)
      if (this.todShown < 0) this.todShown = J.tod;
      let d = J.tod - this.todShown; if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
      this.todShown = (this.todShown + d * Math.min(1, dt * (Math.abs(d) > 0.05 ? 3 : 1)) + 1) % 1;
      this.world.setTod(this.todShown, this.deck.id === 'bayou' ? '#07100c' : this.deck.id === 'skyisles' ? '#101a3a' : '#0d1020');
      if (!this.weather.obj.parent) this.world.scene.add(this.weather.obj);
      this.weather.set(J.weather ?? 'clear');
      this.weather.update(dt, this.world.camera.position, () => { this.sfx.play('insane', 0.5); this.shake = Math.max(this.shake, 0.4); });
      this.world.weatherLook(J.weather ?? 'clear', this.weather.flash);
    }
  }
  setDeck(d: DeckLite) { this.deck = d; this.hud.setDeck(d); this.ents.currency = d.currency.sym; }
  onSnap(s: Snapshot) { this.ents.push(s, performance.now() / 1000); }
  /** A tracking frame for a player (self from this PC's studio; party members' are smoothed by partyView). */
  pushFrame(playerId: string, f: TrackingFrame, ts?: number, seq?: number) { this.avatars.get(playerId)?.pushFrame(f, performance.now(), ts, seq); }

  private onPlayerEnt(v: EntView, added: boolean) {
    const id = v.info.sub;
    // (a level load removes + re-adds every player entity at once: keep the body, drop it only if they really left)
    if (!added) { const a = this.avatars.get(id); if (a) { a.pivot.visible = false; this.dropAvatarAt.set(id, performance.now()); } return; }
    this.dropAvatarAt.delete(id);
    let a = this.avatars.get(id);
    if (a) a.pivot.visible = true;
    if (!a) {
      const info = this.state?.players.find((p) => p.id === id);
      a = new PlayerAvatar(id, info?.name ?? id, info?.color ?? '#ffffff');
      this.avatars.set(id, a);
      this.world.entRoot.add(a.pivot);
    }
    a.setHeight((v.info.size[1] + v.info.size[0]) * 2);
    void a.load(this.o.avatarFor(id));
  }
  private dropAvatarAt = new Map<string, number>();
  private reapAvatars(now: number) {
    for (const [id, t] of this.dropAvatarAt) if (now - t > 4000) { this.dropAvatarAt.delete(id); const a = this.avatars.get(id); if (a) { a.dispose(); this.avatars.delete(id); } }
  }
  private syncPlayers() {
    const st = this.state;
    if (!st) return;
    for (const p of st.players) {
      const a = this.avatars.get(p.id);
      if (!a) continue;
      a.setName(p.name, p.color);
      a.bigHead = st.run?.mods.includes('big_head') || (this.memeBig.get(p.id) ?? 0) > performance.now() ? 2.2 : 1;
    }
    this.world.biome = st.run?.biome ?? '';
    this.world.biomeIdx = Math.max(0, this.deck?.biomes.findIndex((b) => b.id === this.world.biome) ?? 0);
    this.ents.setBrokenWheel(st.stop?.event === 'broken_wheel' || st.stop?.event === 'broken_axle');
    this.ents.setWagonLook(!!st.run?.broken.length, st.stop?.kind === 'river' && (st.stop as { river?: string }).river === 'caulk');
  }
  /** Re-resolve avatar sources (the party's sealed avatars changed / the studio switched avatar). */
  refreshAvatars(force = false) { for (const [id, a] of this.avatars) void a.load(this.o.avatarFor(id), force); }

  // ---------------------------------------------------------------- loop
  /** Frame cap (the studio overlay shares the GPU with face tracking; OBS runs 60). */
  maxFps = Number(new URLSearchParams(location.search).get('fps') ?? 60);
  private lastDrawn = 0;
  start() {
    if (this.running) return;
    this.running = true; this.last = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      if (t - this.lastDrawn < 1000 / (this.maxFps + 2)) return;
      this.lastDrawn = t;
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf); }
  /** One frame (also callable by hand from tests: hidden tabs pause rAF). */
  frame(dtIn?: number) {
    const now = performance.now();
    const dt = dtIn ?? Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const t0 = performance.now();
    const me = this.o.link.myId;
    const myView = this.ents.players().get(me);
    this.ents.update(now / 1000, dt, myView?.info.id ?? -1);
    // input → host (the host's own worker: every frame; guests: 30 Hz over the party)
    const inp = this.o.script ? this.o.script(this) : this.input?.frame() ?? null;
    if (inp && now - this.lastInputSent > (this.o.link.isHost ? 14 : 33)) { this.lastInputSent = now; this.sentAt[inp.seq & 0xff] = now; this.o.link.sendInput(inp); }
    if (myView && !this.o.spectator) this.predictSelf(myView, inp, dt, now);
    this.recordFrame(dt);
    if (this.dropAvatarAt.size) this.reapAvatars(now);
    this.hud.root.classList.toggle('v2drive', this.world.level?.kind === 'journey');
    // performers
    const aspect = this.world.camera.aspect;
    const players = this.ents.players();
    for (const [id, a] of this.avatars) {
      const v = players.get(id);
      if (!v) continue;
      a.firstPerson = id === me && this.camMode === 'first';
      a.isSelf = id === me;
      a.update(dt, now, v.cur, aspect);
    }
    this.world.update(dt);
    this.updateJourney(dt);
    this.nightLights(dt);
    this.campView.update(this.deck?.id ?? '', this.world.level?.kind === 'journey' ? this.state?.journey?.camp : null);
    this.updateCamera(dt, inp);
    if (this.state?.run && this.world.level?.kind === 'road') {
      const w = this.ents.wagon();
      const perMile = (ROAD_SPEED * (this.state.dayLen || 2.2)) / Math.max(1, this.deck ? milesPerDay(this.state.run, this.deck as never) || 15 : 15);
      this.world.streamRoad(w ? w.cur.p.z : this.camLook.z, this.state.run.miles, this.state.run.oldGraves, perMile);
    }
    this.updatePrompt(myView ?? null);
    this.updateCargoHints(myView ?? null);
    this.weights.update(this, dt);
    if (this.memeBig.size && this.tick++ % 30 === 0) { for (const [id, t] of this.memeBig) if (t < now) this.memeBig.delete(id); this.syncPlayers(); }
    if (this.state) this.hud.update(this.state, now, this.ents.hostNow(now / 1000) * 1000);
    {
      const cam = this.world.camera, dir = cam.getWorldDirection(this.tmpP);
      const bearing = Math.atan2(dir.x, dir.z);
      const r = this.container.getBoundingClientRect();
      const project = (p: THREE.Vector3) => { const v = this.tmpV.copy(p).project(cam); if (v.z > 1 || v.z < -1) return null; return { x: (v.x * 0.5 + 0.5) * r.width, y: (-v.y * 0.5 + 0.5) * r.height }; };
      const headOf = (id: string) => { const a = this.avatars.get(id); return a ? this.tgt.copy(a.pivot.position).setY(a.pivot.position.y + a.height * 0.6) : null; };
      this.jhud.update(this.state, now, bearing, project, headOf, this.ents.hostNow(now / 1000));
    }
    this.world.render();
    this.stats.renderMs = this.stats.renderMs * 0.9 + (performance.now() - t0) * 0.1;
    this.stats.frames++;
    if (now - this.stats.t0 > 1000) { this.stats.fps = Math.round(this.stats.frames * 1000 / (now - this.stats.t0)); this.stats.frames = 0; this.stats.t0 = now; }
  }

  // ---------------------------------------------------------------- own-player prediction
  /** Your own player never waits for the host: the newest host position (extrapolated between packets) plus the
   *  movement of the inputs the host hasn't applied yet (the last `latency` seconds of input velocity, minus what the
   *  host is already doing). Off while seated / ragdolled / swept / riding the rolling wagon. */
  private predictSelf(v: EntView, inp: InputFrame | null, dt: number, now: number) {
    if (v.ack >= 0 && v.ack !== this.lastAck) {
      this.lastAck = v.ack;
      const sent = this.sentAt[v.ack];
      const lat = (now - sent) / 1000;
      if (sent > 0 && lat > 0 && lat < 1.5) this.latency += (lat - this.latency) * 0.15;
    }
    const f = v.cur.flags;
    const st = this.state;
    const on = !!inp && !(f & (F.seated | F.ragdoll | F.downed | F.swept)) && (st?.phase !== 'travel' || this.world.level?.kind === 'journey');
    const tau = Math.min(0.35, Math.max(0.016, this.latency));
    if (on) {
      const info = st?.players.find((p) => p.id === this.o.link.myId);
      const ss = sizeStats(info?.height ?? 1.7);
      let mx = inp!.mx, mz = inp!.mz;
      const l = Math.hypot(mx, mz); if (l > 1) { mx /= l; mz /= l; }
      const sp = (inp!.buttons & 2) ? ss.sprint : ss.walk;
      const yaw = inp!.yaw;
      this.hist.push({ t: now, vx: (Math.cos(yaw) * mx - Math.sin(yaw) * mz) * sp, vz: (-Math.sin(yaw) * mx - Math.cos(yaw) * mz) * sp });
    }
    while (this.hist.length && this.hist[0].t < now - tau * 1000) this.hist.shift();
    const hv = v.velocity(this.tmpV);
    let lx = 0, lz = 0;
    if (on) for (let i = 0; i < this.hist.length; i++) { const h = this.hist[i], d = Math.min(dt, ((i + 1 < this.hist.length ? this.hist[i + 1].t : now) - h.t) / 1000 || dt); lx += (h.vx - hv.x) * d; lz += (h.vz - hv.z) * d; }
    const ll = Math.hypot(lx, lz);
    if (ll > 1.2) { lx *= 1.2 / ll; lz *= 1.2 / ll; }
    // ease toward the wanted lead (no pops when prediction switches on / off)
    const k = 1 - Math.exp(-dt * 25);
    this.lead.x += (lx - this.lead.x) * k; this.lead.z += (lz - this.lead.z) * k;
    v.cur.p.x += this.lead.x; v.cur.p.z += this.lead.z;
    if (inp && !(f & (F.ragdoll | F.downed))) { v.cur.yaw = inp.yaw; v.cur.pitch = inp.pitch; }
  }

  // ---------------------------------------------------------------- frame times + adaptive resolution
  private recordFrame(dt: number) {
    this.ft[this.ftN++ % this.ft.length] = dt * 1000;
    // sustained slow frames (< ~45 fps for 2 s): lower the resolution a notch; fast again for 6 s: raise it
    if (dt > 0.022) { this.slowT += dt; this.fastT = 0; } else if (dt < 0.018) { this.fastT += dt; this.slowT = Math.max(0, this.slowT - dt); }
    if (this.slowT > 2 && this.world.dprScale > 0.6) { this.world.dprScale = Math.max(0.6, this.world.dprScale - 0.15); this.slowT = 0; this.resize(); }
    else if (this.fastT > 6 && this.world.dprScale < 1) { this.world.dprScale = Math.min(1, this.world.dprScale + 0.1); this.fastT = 0; this.resize(); }
  }
  /** Frame-time percentiles (ms) over the last ~1200 frames + hitches (> 50 ms). */
  perfReport() {
    const n = Math.min(this.ftN, this.ft.length);
    const a = Array.from(this.ft.subarray(0, n)).sort((x, y) => x - y);
    const q = (p: number) => (n ? Math.round(a[Math.min(n - 1, Math.floor(n * p))] * 10) / 10 : 0);
    return { frames: n, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: n ? Math.round(a[n - 1]) : 0, hitches: a.filter((x) => x > 50).length, dpr: this.world.dprScale, delay: Math.round(this.ents.delay * 1000), latency: Math.round(this.latency * 1000) };
  }

  // ---------------------------------------------------------------- cameras
  private updateCamera(dt: number, inp: InputFrame | null) {
    const cam = this.world.camera;
    const me = this.avatars.get(this.o.link.myId);
    const yaw = inp?.yaw ?? this.input?.yaw ?? 0, pitch = inp?.pitch ?? this.input?.pitch ?? 0;
    this.gatherBlockers(false);
    if (this.camMode !== 'spect' && me) {
      const h = me.height;
      if (this.input) this.rig.zoom = this.input.zoom;
      if (this.camMode === 'first') me.eyeWorld(this.tgt), this.rig.first(this.tgt, yaw, pitch);
      else {
        const selfV = this.ents.players().get(this.o.link.myId);
        const seated = ((selfV?.cur.flags ?? 0) & F.seated) !== 0;
        this.gatherBlockers(seated);
        const J = this.state?.journey, w = this.ents.wagon();
        if (seated && J && J.driver === this.o.link.myId && w && this.world.level?.kind === 'journey') {
          const q = w.cur.q, fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
          this.rig.chase({ at: w.cur.p, heading: Math.atan2(fx, fz), speed: J.speed, steer: J.steer, whip: !!inp && (inp.buttons & 2) !== 0, lookOff: 0, dt }, this.world.blockers);
          this.camPos.copy(cam.position);
          this.world.focus(w.cur.p);
          if (this.shake > 0) { cam.position.x += (Math.random() - 0.5) * this.shake * 0.25; cam.position.y += (Math.random() - 0.5) * this.shake * 0.2; this.shake = Math.max(0, this.shake - dt * 2.5); }
          cam.updateProjectionMatrix();
          return;
        }
        this.tgt.copy(me.pivot.position); this.tgt.y += h * 0.38 + 0.15 + (seated ? 0.9 : 0);
        this.rig.third({ target: this.tgt, yaw, pitch, h, riding: seated && this.state?.phase === 'travel', dt }, this.world.blockers);
        this.camPos.copy(cam.position);
        this.markOccluders(this.camPos, this.tgt);
      }
      this.world.focus(me.pivot.position);
    } else this.director(dt);
    if (this.shake > 0) { cam.position.x += (Math.random() - 0.5) * this.shake * 0.25; cam.position.y += (Math.random() - 0.5) * this.shake * 0.2; this.shake = Math.max(0, this.shake - dt * 2.5); }
    cam.updateProjectionMatrix();
  }
  /** The camera's per-frame blockers: the wagon (unless riding it) + big animals as spheres. */
  private sphPool: { c: THREE.Vector3; r: number }[] = [];
  private dirPool: { c: THREE.Vector3; r: number }[] = [];
  private gatherBlockers(riding: boolean) {
    const b = this.world.blockers;
    b.extra.length = 0; b.spheres.length = 0;
    const wg = riding ? null : this.ents.wagon()?.obj;
    if (wg) b.extra.push(wg);
    let n = 0;
    for (const v of this.ents.map.values()) {
      if (v.info.kind !== 'animal' && !(v.info.kind === 'prop' && v.info.sub === 'draft')) continue;
      const s = this.sphPool[n] ?? (this.sphPool[n] = { c: new THREE.Vector3(), r: 0 });
      s.c.copy(v.cur.p); s.r = Math.max(v.info.size[0], v.info.size[1], v.info.size[2]) * 0.9;
      b.spheres.push(s); n++;
    }
    if (this.terrain) this.terrain.solidsNear(this.world.camera.position.x, this.world.camera.position.z, 16, b.spheres, this.solidPool);
  }

  /** Other bodies between the third-person camera and me (a macro friend) are hidden while they block the view. */
  private occA = new THREE.Vector3(); private occB = new THREE.Vector3(); private occC = new THREE.Vector3();
  private markOccluders(camPos: THREE.Vector3, target: THREE.Vector3) {
    const me = this.o.link.myId;
    const seg = this.occA.copy(target).sub(camPos);
    const len2 = Math.max(1e-6, seg.lengthSq());
    for (const [id, a] of this.avatars) {
      if (id === me) { a.occluding = false; continue; }
      const h = a.height, r = Math.max(0.25, h * 0.28);
      let block = false;
      for (let k = -1; k <= 1 && !block; k++) {
        const c = this.occB.copy(a.pivot.position); c.y += h * 0.3 * k;
        const t = Math.max(0, Math.min(1, this.occC.copy(c).sub(camPos).dot(seg) / len2));
        this.occC.copy(camPos).addScaledVector(seg, t);
        if (this.occC.distanceTo(c) < r) block = true;
      }
      a.occluding = block;
    }
  }

  /** Spectator director (OBS): cut between a wide, a follow and face close-ups by "interest". */
  private director(dt: number) {
    const cam = this.world.camera;
    const now = performance.now();
    const st = this.state;
    const alive = [...this.avatars.values()];
    const level = this.world.level;
    const players = this.ents.players();
    const interest = (a: PlayerAvatar) => {
      const v = players.get(a.id)?.cur;
      if (!v) return 0;
      let s = 1;
      if (v.flags & F.ragdoll) s += 6;
      if (v.flags & F.downed) s += 8;
      if (v.flags & F.swept) s += 5;
      if (v.hold) s += 2;
      if (v.anim === ANIM.run) s += 1;
      if ((a.frame.mouth?.speak ?? 0) > 0.4 && now - a.lastFrameAt < 500) s += 3;
      return s;
    };
    if (now > this.shot.until) {
      const best = [...alive].sort((a, b) => interest(b) - interest(a))[0];
      const journey = level?.kind === 'journey';
      const kinds = st?.vote ? ['wide', 'wide', 'follow'] : st?.phase === 'travel' ? (journey ? ['wagon', 'wagon', 'wagon', 'follow'] : ['wagon', 'wagon', 'follow', 'face']) : ['wide', 'follow', 'follow', 'face'];
      const k = best && interest(best) > 5 ? 'follow' : kinds[Math.floor(Math.random() * kinds.length)];
      this.shot = { kind: k, target: best?.id ?? '', until: now + 4500 + Math.random() * 4000, since: now };
    }
    const a = this.avatars.get(this.shot.target) ?? alive[0];
    let pos = new THREE.Vector3(), look = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    for (const x of alive) centroid.add(x.pivot.position);
    if (alive.length) centroid.divideScalar(alive.length);
    const w = this.ents.wagon();
    if (this.shot.kind === 'wagon' && w && level?.kind === 'journey') {
      // drive-by: a camera set up at the roadside ahead of the wagon, panning as it rolls past
      const wp = w.cur.p, q = w.cur.q, fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y), fl = Math.hypot(fx, fz) || 1;
      if (now - this.shot.since < 60 || this.shotAnchor.distanceTo(wp) > 45) {
        const side = (Math.floor(this.shot.since / 1000) % 2 ? 1 : -1) * 6.5;
        this.shotAnchor.set(wp.x + fx / fl * 22 + fz / fl * side, 0, wp.z + fz / fl * 22 - fx / fl * side);
        this.shotAnchor.y = (this.terrain?.groundLocal(this.shotAnchor.x, this.shotAnchor.z) ?? wp.y) + 1.6;
        this.shot.since = now - 60;
      }
      pos.copy(this.shotAnchor); look.set(wp.x, wp.y + 1.5, wp.z);
    } else if (this.shot.kind === 'wagon' && w) {
      const wp = w.cur.p;
      pos.set(wp.x + 7.5, wp.y + 3.2, wp.z + 5.5); look.set(wp.x, wp.y + 1.4, wp.z + 1);
    } else if (this.shot.kind === 'face' && a) {
      const face = a.pivot.position.clone().add(new THREE.Vector3(0, a.height * 0.4, 0));
      const yaw = players.get(a.id)?.cur.yaw ?? 0;
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      pos.copy(face).addScaledVector(fwd, Math.max(0.9, a.height * 0.9)).add(new THREE.Vector3(0, a.height * 0.05, 0)); look.copy(face);
    } else if (this.shot.kind === 'follow' && a) {
      const yaw = players.get(a.id)?.cur.yaw ?? 0;
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const t = a.pivot.position.clone().add(new THREE.Vector3(0, a.height * 0.3, 0));
      pos.copy(t).addScaledVector(fwd, -Math.max(3, a.height * 2.4)).add(new THREE.Vector3(1.2, Math.max(1.2, a.height * 0.6), 0)); look.copy(t);
    } else {
      const preset = level?.cams.CAM_SPECT_WIDE;
      if (preset && level?.kind !== 'road') { pos.set(...preset.p); look.set(...preset.look); }
      else { pos.copy(centroid).add(new THREE.Vector3(8, 6, 9)); look.copy(centroid).add(new THREE.Vector3(0, 1, 0)); }
    }
    if (!Number.isFinite(pos.x)) pos = new THREE.Vector3(0, 5, 10);
    // other performers block the shot too (a close-up never sits inside someone's head)
    let k = 0;
    for (const x of alive) { if (x === a) continue; const sp = this.dirPool[k] ?? (this.dirPool[k] = { c: new THREE.Vector3(), r: 0 }); sp.c.copy(x.pivot.position); sp.c.y += x.height * 0.5; sp.r = Math.max(0.35, x.height * 0.35); this.world.blockers.spheres.push(sp); k++; }
    this.rig.unblock(pos, look, this.world.blockers);   // never film through a wall, a hill or the wagon
    const cut = now - this.shot.since < 50;
    this.camPos.lerp(pos, cut ? 1 : Math.min(1, dt * 2.2));
    this.camLook.lerp(look, cut ? 1 : Math.min(1, dt * 3));
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
    cam.fov = this.shot.kind === 'face' ? 38 : 50;
    this.world.focus(centroid);
  }

  /** Carrying cargo near the wagon: the wagon glows ("drop it here"); the load panel shows near the wagon. */
  private cargoGlow: THREE.Mesh | null = null;
  private cargoGlowFor: THREE.Object3D | null = null;
  private updateCargoHints(me: EntView | null) {
    const w = this.ents.wagon();
    let near = false, carrying = false;
    if (me && w && !this.o.spectator) {
      near = w.cur.p.distanceTo(me.cur.p) < 7;
      const held = me.cur.hold ? this.ents.map.get(me.cur.hold) : null;
      carrying = !!held && held.info.kind === 'prop' && !!held.info.item && held.info.item !== 'draft';
    }
    this.jhud.cargoShown = near || carrying;
    if (w?.obj && this.cargoGlowFor !== w.obj) {
      this.cargoGlow?.removeFromParent();
      const box = new THREE.Box3().setFromObject(w.obj, true);
      const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      w.obj.worldToLocal(c);
      const m = new THREE.Mesh(new THREE.BoxGeometry(Math.min(4, size.x) + 0.5, Math.min(3.2, size.y) + 0.3, Math.min(8, size.z) + 0.5), new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.position.copy(c); m.renderOrder = 3; m.visible = false;
      w.obj.add(m);
      this.cargoGlow = m; this.cargoGlowFor = w.obj;
    }
    if (this.cargoGlow) {
      this.cargoGlow.visible = carrying && !!me && !!w && w.cur.p.distanceTo(me.cur.p) < 12;
      (this.cargoGlow.material as THREE.MeshBasicMaterial).opacity = 0.12 + Math.sin(performance.now() / 180) * 0.06;
    }
  }

  /** Night lights: the campfire (flickers, brightness = the fire stat) + a lantern on the wagon after dark (the two
   *  always-present point lights of the world: only their intensity changes, no shader recompiles). */
  private nightLights(dt: number) {
    const [fire, lantern] = this.world.extraLights;
    const J = this.state?.journey;
    const fireT = J?.camp?.tasks.find((t) => t.id === 'fire');
    if (fireT && J?.camp) {
      fire.position.set(fireT.p[0], fireT.p[1] + 1.2, fireT.p[2]);
      fire.intensity = (4 + J.camp.fire * 0.28) * (0.85 + Math.sin(performance.now() / 70) * 0.08 + Math.sin(performance.now() / 23) * 0.05);
    } else fire.intensity = 0;
    const night = !!J && (J.tod > 0.76 || J.tod < 0.24);
    const w = this.ents.wagon();
    if (night && w && this.world.level?.kind === 'journey') { lantern.position.set(0, 2.6, 1.6).applyQuaternion(w.cur.q).add(w.cur.p); lantern.intensity = 9; }
    else lantern.intensity = 0;
    void dt;
  }

  // ---------------------------------------------------------------- prompts + crosshair
  private updatePrompt(me: EntView | null) {
    if (this.o.spectator || !me) { this.hud.setPrompt(''); this.hud.setCrosshair(''); return; }
    const st = this.state;
    const p = me.cur.p;
    let prompt = '';
    const seated = (me.cur.flags & F.seated) !== 0;
    if (st?.epitaphs[this.o.link.myId]) prompt = 'T — write your epitaph';
    else if (seated && st?.journey?.driver === this.o.link.myId) prompt = 'Driving — E to hand over the reins' + (Math.abs(st.journey.speed) < 0.3 && st.journey.surface !== 'road' ? ' · R: back onto the road' : '');
    else if (seated) prompt = st?.phase === 'travel' ? (st.journey ? 'E / WASD — hop off' : 'WASD / Space — hop off') : 'Space — stand up';
    else {
      for (const v of this.ents.map.values()) {
        if (v.info.kind !== 'npc') continue;
        if (v.cur.p.distanceTo(p) < 2.8) { prompt = `E — talk to ${v.info.label ?? 'them'}`; break; }
      }
      const w = this.ents.wagon();
      if (!prompt && w && st?.journey && st.phase === 'travel' && !st.journey.driver) {
        // the driver's bench is at the front of the wagon
        const q = w.cur.q, fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
        if (Math.hypot(w.cur.p.x + fx * 1.2 - p.x, w.cur.p.z + fz * 1.2 - p.z) < 2.4) prompt = 'E — take the reins (drive!)';
      }
      // small folks: a big friend's shoulders
      const meInfo = st?.players.find((x) => x.id === this.o.link.myId);
      if (!prompt && st?.run && (meInfo?.cls === 'micro' || meInfo?.cls === 'small')) {
        for (const [id, v] of this.ents.players()) {
          const inf = st.players.find((x) => x.id === id);
          if (id === this.o.link.myId || !inf || (inf.cls !== 'large' && inf.cls !== 'macro') || (v.cur.flags & F.seated)) continue;
          if (v.cur.p.distanceTo(p) < 2.2) { prompt = `E — ride on ${inf.name}'s shoulders`; break; }
        }
      }
      if (!prompt && me.cur.hold && w && w.cur.p.distanceTo(p) < 5) { const held = this.ents.map.get(me.cur.hold); if (held?.info.kind === 'prop' && held.info.item && held.info.item !== 'draft') prompt = 'Let go here — it loads itself'; }
      if (!prompt && st?.journey?.bogged && (meInfo?.cls === 'large' || meInfo?.cls === 'macro')) prompt = 'You are HUGE — walk into the back of the wagon and push (you count ×3)';
      if (!prompt && w && w.cur.p.distanceTo(p) < 3.4 && (st?.phase === 'travel' || st?.phase === 'lobby')) prompt = 'E — climb aboard';
      if (!prompt && st?.stop?.kind === 'camp' && !st.journey?.camp) prompt = 'E near a log — sit by the fire';
      if (!prompt && st?.journey?.camp) { for (const t of st.journey.camp.tasks) if (Math.hypot(t.p[0] - p.x, t.p[2] - p.z) < t.r + 0.6) { prompt = t.hint; break; } }
    }
    if (me.cur.flags & F.downed) prompt = 'You are DOWN — a friend can drag you to the wagon or hold E next to you';
    this.hud.setPrompt(prompt);
    this.hud.setCrosshair(st?.stop?.kind === 'hunt' ? 'aim' : me.cur.hold ? 'grab' : this.camMode === 'first' || this.camMode === 'third' ? 'dot' : '');
  }

  dispose() { this.stop(); for (const a of this.avatars.values()) a.dispose(); this.terrain?.dispose(); this.jhud.dispose(); this.weights.dispose(); this.world.dispose(); this.container.replaceChildren(); }
}
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export { emptyInput };
