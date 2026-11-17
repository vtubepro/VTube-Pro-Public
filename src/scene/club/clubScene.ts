// The club engine (first user: a club room; docs/SCENES.md "Club"). A room opts in with a scene.json
// `club` key and CLUB_* anchors; free elsewhere. It runs:
//   · the LED wall (CLUB_LEDWALL): beat-synced LED visuals + the VTube Pro logo, supporters' names and a chat ticker
//   · background bits on a seeded schedule (crowd-surf, dance-off, conga, proposal, stage fall, bottle juggling,
//     bouncer toss, mirror-ball moment, the drop, a round of drinks) — played by the crowd (src/scene/crowd/crowdClub.ts)
//     with this engine's props / effects / lights
//   · support celebrations: tips → confetti cannons + the crowd chants the name; subs → CO2 jets + a laser burst;
//     bits / Kicks → the DJ booth air horn + a round of drinks; raids → the bass drop (everyone jumps, fireworks, the
//     stage lifts); big donations → a champagne tower, a confetti storm and a frog carrying a sign with the name
//   · the host at the DJ booth plays the decks (djPose.ts); the host's walk to the balcony gets the entrance camera
//     (hostFlow.ts); the mirror ball spins, the stage lift rises, the exit door swings for the bouncer
// Everything is a pure function of (room, club.seed, wall clock, chat support events' timestamps, host test stamps).
import { relayShowSound } from '../../audio/showSoundRelay.ts';
import { pageGovernor, SpotFlashGate } from '../../../shared/flashGovernor.ts';
import { planDropBurst, type DropBurst } from './trackDrop.ts';
import * as THREE from 'three';
import { sceneFileUrl, type SceneRuntime } from '../SceneRuntime.ts';
import type { CrowdScene } from '../crowd/crowdScene.ts';
import { bouncerDoor, floorbitOverride, type ClubBit, type ClubExt, type ClubFin } from '../crowd/crowdClub.ts';
import { hash32, rng, type PlanCtx } from '../crowd/crowdPlan.ts';
import type { CrowdActivity } from '../crowd/crowdRoom.ts';
import { crowdRoomOf } from '../crowd/crowdRoom.ts';
import { CLUB_BITS, CLUB_BIT_SECONDS, DEFAULT_CLUB_STATE, clubKindOf, clubSchedule, sanitizeClubState, type SceneClubState } from '../../../shared/club.ts';
import { beatClock, epochNow } from '../beatClock.ts';
import { musicClock } from '../musicClockRx.ts';
import { LedWall } from './ledWall.ts';
import { ClubFx } from './clubFx.ts';
import { DjPose } from './djPose.ts';
import { HostFlow } from './hostFlow.ts';
import { ClubPack } from './clubPack.ts';

interface RoomClubConfig { djSpot?: string; balconySpot?: string; bigMin?: number; on?: boolean }
const LIFT_H = 1.6;
const PALS: [string, string][] = [['#8dff3a', '#ff3fd2'], ['#35e3ff', '#b026ff'], ['#ff3fd2', '#ffd23a'], ['#4dff9a', '#35e3ff']];
const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };

export class ClubScene {
  private rt: SceneRuntime | null = null;
  private cfg: RoomClubConfig = {};
  private nodes = new Map<string, THREE.Object3D>();
  private list = (re: RegExp) => [...this.nodes.entries()].filter(([k]) => re.test(k)).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  private wall: LedWall | null = null;
  private fx: ClubFx | null = null;
  /** the show-pack rig (null: low tier / the room turned it off) */
  pack: ClubPack | null = null;
  private dj: DjPose | null = null;
  private flow: HostFlow | null = null;
  private fin: ClubFin[] = [];
  private chat: string[] = [];
  private acts = new Map<string, CrowdActivity>();
  private liftBase = 0; private ballBase = 0;
  private doorQ = new THREE.Quaternion();
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  private myEntrance: SceneRuntime['entranceCamera'] = null;
  private cueSent = new Set<string>();
  private played = new Set<string>();
  private perf = { avg: 0, peak: 0 };
  manual = false;
  clock = Date.now();
  now() { return this.manual ? this.clock : Date.now(); }

  constructor(private crowd: CrowdScene) {}

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const cfg = (rt.info as unknown as { club?: RoomClubConfig }).club;
    if (!cfg || cfg.on === false) return;
    this.rt = rt; this.cfg = cfg;
    rt.root.updateMatrixWorld(true);
    rt.root.traverse((o) => { if (/^CLUB_/.test(o.name) && !this.nodes.has(o.name)) this.nodes.set(o.name, o); });
    // the LED wall
    const lw = this.nodes.get('CLUB_LEDWALL') as THREE.Mesh | undefined;
    if (lw?.isMesh) {
      const bb = new THREE.Box3().setFromObject(lw); const sz = bb.getSize(new THREE.Vector3());
      this.wall = new LedWall(Math.max(sz.x, sz.z) / Math.max(0.01, sz.y));
      lw.userData.clubOrig = lw.material; lw.material = this.wall.material;
      // Sprocket from the room's poster atlas on the logo card (scene.json club.wallArt = {file, rect: [x, y, w, h] px})
      const art = (cfg as { wallArt?: { file: string; rect: number[] } }).wallArt;
      if (art?.file && art.rect?.length === 4) {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => { if (this.rt === rt) this.wall?.setArt(img, art.rect[0], art.rect[1], art.rect[2], art.rect[3]); };
        img.src = sceneFileUrl(rt.info.id, art.file);
      }
    }
    this.fx = new ClubFx(); rt.root.add(this.fx.group);
    this.pack = ClubPack.attach(rt);   // the show-pack rig: heads, beam bars, lasers, the pixel ceiling (clubPack.ts)
    this.liftBase = this.nodes.get('CLUB_LIFT')?.position.y ?? 0;
    this.ballBase = this.nodes.get('CLUB_BALL')?.position.y ?? 0;
    const door = this.nodes.get('CLUB_EXIT_DOOR'); if (door) this.doorQ.copy(door.quaternion);
    const room = crowdRoomOf(rt.root);
    for (const a of room?.acts ?? []) this.acts.set(a.kind, a);
    // the entrance camera
    const idx = (n: string | undefined, d: number) => { const m = /(\d+)$/.exec(n ?? ''); return m ? +m[1] - 1 : d; };
    const V = (n: string, d: [number, number, number]) => { const o = this.nodes.get(n); return o ? o.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(...d); };
    const cam = (n: string) => rt.room.cameras.get(n)?.position.clone();
    const balc = idx(cfg.balconySpot, 2);
    const bs = rt.room.spots[balc]?.position ?? new THREE.Vector3(0, 4.2, 6.3);
    this.flow = new HostFlow(rt, {
      dj: idx(cfg.djSpot, 0), balcony: balc,
      crowd: cam('CAM_CROWD') ?? V('CLUB_FLOW_CROWD', [3, 1.4, 0.5]), stairs2: cam('CAM_STAIRS') ?? V('CLUB_FLOW_STAIRS', [6, 1.7, -3]),
      booth: cam('CAM_STAGE') ?? new THREE.Vector3(-5.4, 3.5, -14.9),
      droneA: new THREE.Vector3(bs.x + 3.0, bs.y + 4.4, bs.z - 10), droneB: new THREE.Vector3(bs.x + 0.4, bs.y + 1.6, bs.z - 2.6),
      stageY: (rt.room.spots[idx(cfg.djSpot, 0)]?.position.y ?? 1.5) - 0.35, stairs: [9.6, 12.4, -1.6, 5.4], balconyY: bs.y,
    });
    this.prevOverride = rt.cameraOverride;
    this.myOverride = (aspect) => { const mine = this.state().entranceCam && this.flow ? this.flow.shot(aspect, this.moverNow()) : null; return mine ?? this.prevOverride?.(aspect) ?? null; };
    rt.cameraOverride = this.myOverride;
    // (the host's hand-picked camera silences the other directors; the host's entrance still plays: SceneRuntime.entranceCamera)
    this.myEntrance = (aspect) => (this.state().entranceCam && this.flow ? this.flow.shot(aspect, this.moverNow()) : null);
    rt.entranceCamera = this.myEntrance;
    try { rt.stage.renderer.compile(rt.stage.scene, rt.stage.camera); } catch { /* optional */ }
  }

  detach() {
    const rt = this.rt;
    if (rt) {
      if (rt.cameraOverride === this.myOverride) rt.cameraOverride = this.prevOverride;
      if (rt.entranceCamera === this.myEntrance) rt.entranceCamera = null;
      const lw = this.nodes.get('CLUB_LEDWALL') as THREE.Mesh | undefined;
      if (lw?.userData.clubOrig) lw.material = lw.userData.clubOrig as THREE.Material;
    }
    this.wall?.dispose(); this.wall = null;
    this.fx?.dispose(); this.fx = null;
    this.pack?.dispose(); this.pack = null;
    this.dj?.release(); this.dj = null;
    this.flow = null;
    this.crowd.massOverride = null; delete this.crowd.ext.club;
    this.nodes.clear(); this.acts.clear(); this.cueSent.clear();
    this.rt = null;
  }

  private state(): SceneClubState { return this.rt?.state.club ? sanitizeClubState(this.rt.state.club) : DEFAULT_CLUB_STATE; }
  private moverNow() { const m = this.rt?.mover as unknown as { now?: () => number } | undefined; return m?.now ? m.now() : Date.now() / 1000; }

  // ------------------------------------------------------------------------------------------ chat feed
  /** chat events (every page gets the same feed): support → celebrations; chat lines → the LED wall ticker */
  onChat(evs: { kind?: string; fkind?: string; ts?: number; id?: string; user?: string; usd?: number; approxUsd?: number; text?: string; test?: boolean }[], snap: boolean) {
    for (const e of evs) {
      if (e.kind === 'chat' && e.text && !snap) { this.chat.push(`${e.user ?? ''}: ${e.text}`.slice(0, 90)); if (this.chat.length > 3) this.chat.shift(); }
      if (snap || e.kind !== 'finance') continue;
      const usd = e.usd ?? e.approxUsd ?? 0;
      const k = clubKindOf(e.fkind, usd, this.state().bigMin ?? this.cfg.bigMin ?? 50);
      if (!k) continue;
      const ts = typeof e.ts === 'number' && Math.abs(Date.now() - e.ts) < 60000 ? e.ts : Date.now();
      this.addFin({ k, at: ts / 1000 + 1.2, user: (e.user ?? '').slice(0, 24), usd, id: e.id ?? String(ts) });
    }
  }
  private addFin(f: ClubFin) {
    if (this.fin.some((x) => x.id === f.id)) return;
    // a burst of gift subs = one celebration; celebrations queue ≥ 4 s apart so each one reads
    const last = this.fin[this.fin.length - 1];
    if (last && f.k === last.k && Math.abs(f.at - last.at) < 4) return;
    if (last && f.at < last.at + 4) f = { ...f, at: last.at + 4 };
    this.fin.push(f); this.fin.sort((a, b) => a.at - b.at);
    if (this.fin.length > 16) this.fin.shift();
  }
  /** Tests: a celebration `inSec` from now. */
  test(k: ClubFin['k'], user = 'NightOwl42', usd = 10, inSec = 0.6) { this.addFin({ k, at: this.now() / 1000 + inSec, user, usd, id: `t${k}${Math.floor(this.now())}` }); }
  /** Tests: a background bit now (+ inSec). */
  testBit(k: string, inSec = 0.5) { this.testBits.push({ k, at: this.now() / 1000 + inSec, seed: hash32('tb', k, Math.floor(this.now())), dur: CLUB_BIT_SECONDS[k as keyof typeof CLUB_BIT_SECONDS] ?? 15 }); }
  private testBits: ClubBit[] = [];

  // ------------------------------------------------------------------------------------------ schedule
  private bits(t: number, st: SceneClubState): ClubBit[] {
    const out: ClubBit[] = st.bits ? clubSchedule(st.seed, st.freq, t - 70, t + 5, rng, hash32) : [];
    for (const e of st.events) if ((CLUB_BITS as readonly string[]).includes(e.k)) out.push({ k: e.k, at: e.at / 1000, seed: e.seed, dur: CLUB_BIT_SECONDS[e.k as keyof typeof CLUB_BIT_SECONDS] });
    out.push(...this.testBits.filter((b) => t - b.at < 60));
    // a celebration pauses the random bits that would start during it (the crowd is busy celebrating)
    return out.sort((a, b) => a.at - b.at);
  }
  private fins(t: number, st: SceneClubState): ClubFin[] {
    const out = this.fin.filter((f) => t - f.at < 60);
    for (const e of st.events) if (!(CLUB_BITS as readonly string[]).includes(e.k)) out.push({ k: e.k as ClubFin['k'], at: e.at / 1000, user: e.user ?? 'Test', usd: e.usd ?? 10, id: `ev${e.at}` });
    return out.sort((a, b) => a.at - b.at);
  }
  private liftAt(fins: ClubFin[], t: number) {
    let v = 0;
    for (const f of fins) if (f.k === 'raid') { const a = t - f.at; if (a > 0 && a < 20) v = Math.max(v, smooth((a - 0.6) / 2.0) * (1 - smooth((a - 15) / 3))); }
    return v * LIFT_H;
  }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number) {
    if (this.manual) this.clock += dt * 1000;
    const rt = this.rt; if (!rt || !this.fx) return;
    const p0 = performance.now();
    const t = this.now() / 1000, st = this.state();
    const nowE = epochNow(), bc = beatClock;
    const music = bc.active(nowE);
    const beat = music ? bc.posAt(nowE) : t * 2;
    const energy = music ? bc.env.e : 0.5;
    const kick = music ? Math.exp(-(nowE - bc.kickAt) / 160) : Math.exp(-((beat % 1 + 1) % 1) * 5) * 0.6;
    const bits = this.bits(t, st), fins = this.fins(t, st);
    const lift = (tt: number) => this.liftAt(fins, tt);
    const sw = [this.nodes.get('CLUB_SIGNWALK_01'), this.nodes.get('CLUB_SIGNWALK_02')];
    const ext: ClubExt = { bits, fin: fins, lift, signWalk: sw[0] && sw[1] ? [this.local(sw[0]), this.local(sw[1])] : null };
    this.crowd.ext.club = ext;
    // mass dancers react to floor bits, celebrations and the mirror ball
    const floor = this.acts.get('floorbits');
    const pctx = { seed: 11, scale: 1, water: 0, support: [], party: false, ext: { club: ext } } as PlanCtx;
    const recent = (k: ClubFin['k'], w: number) => fins.find((f) => f.k === k && t >= f.at && t - f.at < w);
    const subNow = recent('sub', 4), ball = bits.find((b) => b.k === 'mirrorball' && t >= b.at && t < b.at + b.dur);
    // whoever walks across the dance floor (the host's entrance, guests walking in): the crowd parts and cheers them on
    const walkers: THREE.Vector3[] = [];
    for (const a of rt.actors.values()) if (a.shown && rt.mover.busy(a)) walkers.push(rt.root.worldToLocal(a.mount.getWorldPosition(new THREE.Vector3())));
    this.crowd.massOverride = (mi, i, tt) => {
      const d = this.crowd.mass[mi]?.dancers[i]; if (!d) return null;
      for (const w of walkers) {
        const dx = d.home.x - w.x, dz = d.home.z - w.z, dd = Math.hypot(dx, dz);
        if (dd < 1.7 && Math.abs(w.y - d.home.y) < 0.6) {
          const push = (1.7 - dd) * 0.85 / Math.max(0.2, dd);
          return { clip: dd < 1.2 ? 'cheer' : 'handsup', yaw: Math.atan2(-dx, -dz), dx: dx * push, dz: dz * push };
        }
      }
      if (floor) { const o = floorbitOverride(floor, pctx, tt, d.home); if (o) return o; }
      if (subNow) return { clip: 'handsup' };
      if (ball) return { clip: (i % 3) ? 'sway' : 'handsup', phase: (i * 0.137) % 1 };
      return null;
    };
    // drops: a raid, a 'drop' bit without music (with music the real drops drive the crowd)
    for (const f of fins) if (f.k === 'raid' && t >= f.at && f.at > this.crowd.dropAt) this.crowd.dropAt = f.at;
    for (const b of bits) if (b.k === 'drop' && !music && t >= b.at + 4 && b.at + 4 > this.crowd.dropAt) this.crowd.dropAt = b.at + 4;
    // ---- lights: celebrations + moments (each once per page)
    const L = rt.lights as unknown as { cue?: (w: string) => void; moment?: (k: string, s: number) => void };
    for (const f of fins) {
      if (t < f.at || t - f.at > 2 || this.cueSent.has(f.id)) continue;
      this.cueSent.add(f.id);
      try { L.cue?.(f.k === 'tip' ? 'donation' : f.k); if (f.k === 'raid') L.moment?.('drop', 1); if (f.k === 'sub') L.moment?.('lasers', 3); } catch { /* optional */ }
      this.sound(f.k, f.id);
    }
    for (const b of bits) {
      const id = `bit${b.k}${b.at.toFixed(2)}`;
      if (t < b.at || t - b.at > 2 || this.cueSent.has(id)) continue;
      this.cueSent.add(id);
      try { if (b.k === 'mirrorball') L.moment?.('ball', b.dur); if (b.k === 'drop' && !music) setTimeout(() => L.moment?.('drop', 1), 4000); } catch { /* optional */ }
    }
    if (this.cueSent.size > 200) this.cueSent.clear();
    // ---- props: the lift, the mirror ball, the exit door
    const liftN = this.nodes.get('CLUB_LIFT'); if (liftN) liftN.position.y = this.liftBase + lift(t);
    const ballN = this.nodes.get('CLUB_BALL');
    if (ballN) { const drop = ball ? smooth((t - ball.at) / 2) * (1 - smooth((t - ball.at - ball.dur + 2) / 2)) : 0; ballN.rotation.y = t * (0.35 + drop * 0.6); ballN.position.y = this.ballBase - 0.9 * drop; }
    const door = this.nodes.get('CLUB_EXIT_DOOR'), bouncer = this.acts.get('bouncer');
    if (door && bouncer) { const open = bouncerDoor(bouncer, pctx, t); const ang = THREE.MathUtils.degToRad(Number(door.userData.openAngle ?? -100)) * open; door.quaternion.copy(this.doorQ).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang)); }
    // ---- effects
    const fx = this.fx; fx.begin(rt.stage.camera);
    const P = (n: string) => this.nodes.get(n) ? this.local(this.nodes.get(n)!) : null;
    const confN = this.list(/^CLUB_CONFETTI_/), co2N = this.list(/^CLUB_CO2_/), sparkN = this.list(/^CLUB_SPARK_/), fwN = this.list(/^CLUB_FW_/);
    const fire = (n: THREE.Object3D, age: number, seed: number, count = 220) => {
      const at = this.local(n); const aimZ = Number(n.userData.aimZ ?? 6);
      const dir = new THREE.Vector3(-at.x * 0.08, 0.55, aimZ - at.z).normalize();
      fx.confettiBurst(at, dir, age, seed, count);
    };
    for (const f of fins) {
      const a = t - f.at; if (a < -0.1 || a > 22) continue;
      const seed = hash32(f.id);
      if (f.k === 'tip') confN.slice(0, 2).forEach((n, i) => fire(n, a, seed + i));
      if (f.k === 'sub') { co2N.forEach((n, i) => { fx.co2(this.local(n), a - (i % 2) * 0.12, seed + i); fx.co2(this.local(n), a - 1.6, seed + 10 + i); }); }
      if (f.k === 'bits') { const h = P('CLUB_HORN'); if (h) { for (let k = 0; k < 3; k++) fx.hornRings(h, new THREE.Vector3(0, 0.25, 1).normalize(), a - k * 0.45); if (a >= 0 && a < 1.6) fx.label(`horn${f.id}`, 'BWAAAP!', h.clone().add(new THREE.Vector3(0.3, 0.9 + a * 0.3, 0.6)), 0.55, { fg: '#ffd84a' }); } this.slideDrinks(a, seed); }
      if (f.k === 'raid') {
        fwN.forEach((n, i) => { const at = this.local(n); for (let k = 0; k < 3; k++) fx.firework(at, a - 0.8 - i * 0.55 - k * 1.9, seed + i * 7 + k, PALS[(i + k) % PALS.length][k % 2]); });
        sparkN.forEach((n, i) => fx.gerb(this.local(n), a - 0.6, seed + i, 5, 3.4, i % 2 ? '#ffd27a' : '#ff9ae0'));
        co2N.forEach((n, i) => fx.co2(this.local(n), a - 0.5, seed + 40 + i, 6));
        confN.forEach((n, i) => fire(n, a - 1.2, seed + 60 + i, 160));
      }
      if (f.k === 'big') {
        confN.forEach((n, i) => fire(n, a - i * 0.3, seed + i, 260));
        for (let k = 0; k < 3; k++) confN.forEach((n, i) => fire(n, a - 4 - k * 3 - i * 0.2, seed + 100 + k * 10 + i, 120));
        const ch = P('CLUB_CHAMPAGNE'); if (ch) fx.tower(ch, a, 22);
        sparkN.forEach((n, i) => fx.gerb(this.local(n), a - 0.3, seed + 200 + i, 3, 2.6, '#fff2a8'));
        this.sign(f, a);
      }
      // the crowd chants the name (tips + big ones)
      if ((f.k === 'tip' || f.k === 'big') && a > 0.4 && a < 5.5 && f.user) this.chant(f, a);
    }
    // bits with props: juggled bottles, a round of drinks
    for (const b of bits) {
      const a = t - b.at; if (a < 0 || a > b.dur) continue;
      if (b.k === 'juggle') this.juggle(a);
      if (b.k === 'bartrick') this.slideDrinks(a, b.seed);
      if (b.k === 'drop' && !music) { sparkN.forEach((n, i) => fx.gerb(this.local(n), a - 4, b.seed + i, 2, 2.8)); co2N.forEach((n, i) => fx.co2(this.local(n), a - 3.8, b.seed + i)); }
    }
    // the DJ's analysed track (Track library, src/scene/trackShowRx.ts): sparks + CO2 + confetti on the drop's EXACT downbeat
    // (planned once per drop: no per-frame allocation; Safe flashes gates each spark / CO2 emitter like the light rig)
    const td = music ? musicClock.show.lastDrop : null;
    if (td) {
      const a = (nowE - td.at) / 1000;
      if (a > -0.05 && a < 8) {
        if (this.tdrop?.at !== td.at) this.tdrop = planDropBurst(td.at, hash32('tdrop', Math.round(td.at)), { spark: sparkN.map((n) => this.local(n)), co2: co2N.map((n) => this.local(n)), conf: confN.map((n) => ({ at: this.local(n), aimZ: Number(n.userData.aimZ ?? 6) })) }, this.dropGate);
        const B = this.tdrop;
        B.spark.forEach((p, i) => fx.gerb(p, a, B.seed + i, 2, 2.8)); B.co2.forEach((p, i) => fx.co2(p, a, B.seed + 20 + i)); B.conf.forEach((c, i) => fx.confettiBurst(c.at, c.dir, a - 0.1, B.seed + 40 + i, 160));
      }
    }
    fx.end();
    this.pack?.update(dt);
    // ---- the LED wall
    if (this.wall) {
      const phrase = Math.floor(beat / 32);
      const pal = PALS[((phrase % PALS.length) + PALS.length) % PALS.length];
      const cur = fins.slice().reverse().find((f) => t >= f.at && t - f.at < 9);
      const mode = hash32('wall', phrase) % 5, next = hash32('wall', phrase + 1) % 5;
      const u = (beat % 32) / 32;
      const lines: Record<ClubFin['k'], [string, string, string]> = {
        tip: [cur?.user ?? '', 'THANK YOU!', '#ffd84a'], sub: [cur?.user ?? '', 'JUST SUBSCRIBED!', '#35e3ff'], bits: [cur?.user ?? '', 'AIR HORN!!!', '#ff9a3a'],
        raid: [`RAID: ${cur?.user ?? ''}`, 'WELCOME IN!', '#ff3fd2'], big: [cur?.user ?? '', `LEGEND · ${cur ? '$' + Math.round(cur.usd) : ''}`, '#ffd84a'],
      };
      const ticker = this.chat.length ? this.chat.join('   ✦   ') : undefined;
      // the analysed track's countdown to its drop (the last 4 bars), else the logo
      const sf = music ? musicClock.show.frame : null;
      if (cur) { const [big, small, color] = lines[cur.k]; this.wall.draw({ kind: 'shout', big, small, color, ticker }); }
      else if (sf && sf.wall === 'countdown' && Number.isFinite(sf.dropIn)) this.wall.draw({ kind: 'shout', big: `DROP IN ${Math.max(1, Math.ceil(sf.dropIn))}`, small: 'GET READY', color: '#ff3fd2', ticker });
      else this.wall.draw({ kind: 'logo', ticker });
      const logoOn = cur ? 1 : (Math.floor(beat / 16) % 3 === 0 ? 1 : 0.35);
      // (flash limit on, past 132 BPM: the bars step on half beats' worth of time — the wall itself is governed in update)
      this.wall.update({ t, beat, step: music && bc.bpm > 132 && pageGovernor().safe ? beat / 2 : beat, kick, energy, a: new THREE.Color(pal[0]), b: new THREE.Color(pal[1]), mode, next, mix: smooth((u - 0.94) / 0.06),
        text: logoOn, flash: cur && t - cur.at < 0.35 ? 1 - (t - cur.at) / 0.35 : 0 }, dt);
    }
    // ---- the DJ at the booth
    this.djPose(t, beat, music ? (nowE - bc.dropAt) / 1000 : fins.some((f) => f.k === 'raid' && t - f.at < 4 && t >= f.at) ? t - (fins.find((f) => f.k === 'raid')!.at) : 99, st);
    const ms = performance.now() - p0;
    this.perf.avg += (ms - this.perf.avg) * 0.05; this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private tdrop: DropBurst | null = null;
  private dropGate = new SpotFlashGate();
  private local(o: THREE.Object3D) { return this.rt!.root.worldToLocal(o.getWorldPosition(new THREE.Vector3())); }

  private djPose(t: number, beat: number, dropAge: number, st: SceneClubState) {
    const rt = this.rt!; const host = rt.actors.get('@host');
    const idx = /(\d+)$/.exec(this.cfg.djSpot ?? 'SPOT_01'); const dj = idx ? +idx[1] - 1 : 0;
    if (!host) { this.dj?.release(); this.dj = null; return; }
    if (this.dj && this.dj.actor !== host) { this.dj.release(); this.dj = null; }
    const at = rt.seatOf('@host')?.index === dj && !rt.mover.busy(host) && host.shown;
    if (!this.dj && at && st.djHands) this.dj = new DjPose(host);
    this.dj?.update({ t, beat, dropAge, weight: at && st.djHands && rt.state.mode !== 'react' ? 1 : 0 });
  }

  private sign(f: ClubFin, a: number) {
    const c = this.crowd as unknown as { actorsOf?: (k: string) => { root: THREE.Object3D; visible: boolean; shielded: boolean; headTop: (v: THREE.Vector3) => THREE.Vector3 }[] };
    const frogs = c.actorsOf?.('floorbits') ?? [];
    const s = frogs[frogs.length - 1];
    if (!s || !s.visible || s.shielded || a < 1) return;
    const top = s.headTop(new THREE.Vector3()); this.rt!.root.worldToLocal(top); top.y += 0.75;
    this.fx!.label(`sign${f.id}`, `${f.user.toUpperCase()} ♥`, top, 0.7, { fg: '#140a14', bg: '#fff4d6', border: '#ff3fd2', font: 'bold 64px Impact, "Arial Black", sans-serif' });
  }

  private chant(f: ClubFin, a: number) {
    const m = this.crowd.mass[0]; if (!m) return;
    const r = rng(hash32(f.id, 'chant'));
    for (let k = 0; k < 6; k++) {
      const d = m.dancers[Math.floor(r() * m.dancers.length)];
      if (!d || d.shield || d.hidden) continue;
      const on = ((a * 2 + k * 0.37) % 1) < 0.62;
      if (!on) continue;
      const p = m.headTop(d, new THREE.Vector3()); p.y += 0.35 + 0.08 * Math.sin(a * 6 + k);
      this.fx!.label(`chant${f.id}${k}`, `${f.user.toUpperCase()}!`, p, 0.26, { fg: '#8dff3a' });
    }
  }

  private slideDrinks(a: number, seed: number) {
    const bt = this.acts.get('bartender'); const flies = this.acts.get('barflies');
    if (!bt || !flies || a < 0.6 || a > 6) return;
    const top = 1.15;  // the counter top
    const r = rng(seed);
    bt.pts.forEach((p, i) => {
      const u = a - 0.6 - i * 0.7; if (u < 0 || u > 2.6) return;
      const dst = flies.pts[Math.floor(r() * flies.pts.length)]?.pos ?? p.pos;
      const k = smooth(u / 1.6);
      const x = (p.pos.x + dst.x) / 2, z = p.pos.z + (dst.z - p.pos.z) * k;
      this.fx!.cup(new THREE.Vector3(x, top, z));
    });
  }

  private juggle(a: number) {
    const c = this.crowd as unknown as { actorsOf?: (k: string) => { root: THREE.Object3D; visible: boolean }[] };
    const b = (c.actorsOf?.('bartender') ?? [])[1];
    if (!b || !b.visible) return;
    const base = this.rt!.root.worldToLocal(b.root.getWorldPosition(new THREE.Vector3()));
    const yaw = b.root.rotation.y;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    for (let k = 0; k < 3; k++) {
      if (a > 12.5 && k === 0) { const f = Math.min(1, (a - 12.5) / 0.5); this.fx!.bottle(base.clone().addScaledVector(fwd, 0.35).setY(base.y + 1.0 - 0.9 * f * f), f * 6); continue; }
      const ph = ((a / 1.1 + k / 3) % 1), leg = Math.floor(a / 1.1 + k / 3) % 2 ? 1 : -1;
      const fly = Math.min(1, ph / 0.7);
      const x = ph < 0.7 ? leg * (0.2 - 0.4 * fly) : -leg * 0.2;
      const y = 0.85 + (ph < 0.7 ? 1.0 * 4 * fly * (1 - fly) : 0);
      this.fx!.bottle(base.clone().addScaledVector(right, x).addScaledVector(fwd, 0.3).setY(base.y + y), ph * 9);
    }
  }

  // ------------------------------------------------------------------------------------------ sound: played by the studio
  // (the air horn / raid siren: src/audio/mixer/showSounds.ts); this page only reports it (output pages are silent)
  private sound(k: string, id: string) {
    if (!this.state().sound || this.played.has(id)) return;
    const q = new URLSearchParams(location.search);
    if (q.has('preview') || q.has('sceneTest') || q.has('observer')) return;
    this.played.add(id);
    if (k !== 'bits' && k !== 'raid') return;
    relayShowSound(`club:${id}`.slice(0, 80).replace(/[^\w:.-]/g, '_'), { k: 'horn', v: k });
  }

  info() {
    const t = this.now() / 1000, st = this.state();
    const bits = this.rt ? this.bits(t, st) : [];
    return {
      room: !!this.rt, wall: !!this.wall, dj: !!this.dj, flow: this.flow?.info ?? '',
      bitNow: bits.filter((b) => t >= b.at && t < b.at + b.dur).map((b) => b.k), next: bits.filter((b) => b.at > t).slice(0, 3).map((b) => `${b.k} in ${(b.at - t).toFixed(0)}s`),
      fin: this.fin.slice(-4).map((f) => `${f.k} ${f.user} ${(f.at - t).toFixed(1)}`), ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(3),
      pack: this.pack?.info() ?? null,
    };
  }
  debug() { return { info: this.info(), nodes: [...this.nodes.keys()], acts: [...this.acts.keys()] }; }
}
