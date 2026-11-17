// FrontlineScene — a talk show on the front line (scene.json `frontline`; first user: assets/scenes/hd_frontline).
// Sprocket defenders in Hell-Hopper armour hold the wall of a small base while an alien bug swarm pours out of the
// hives; eagles strafe and bomb, orbital barrages / lasers / railcannons land, exosuits and sentries drop in, dropships
// wait on their pads. Attached by the page (output.ts) next to the other room engines; rooms without the key cost one
// check per frame.
//
//   frontlineRoom.ts    anchors + the analytic terrain + the dropship schedule
//   frontlinePlan.ts    the swarm / kills / supports — closed-form in wall-clock time
//   frontlineUnits.ts   instanced rigid units (bugs, ships, pods, mech, sentries) + the skinned frog defenders
//   frontlineMover.ts   drop-pod join / dropship leave (AvatarMover)
//   frontlineRewards.ts Kick reward title -> support (explicit phrase / whole word / frontline.rewardPriority)
// Reuses the space battle's effect pools (../space/fx.ts SpaceFx: glows, fireballs, rings, smoke, tracers) and its face
// hold (effects dim right behind a performer's face).
//
// Chat → aggression (more bugs, bigger archetypes; decays when chat is quiet). Donations / subs / raids → supports
// scaled by the amount. Kick channel-point redemptions (Kick only for now: a system chat line with ev 'reward') →
// supports by reward title (scene.json frontline.rewards keywords). Sync: pure function of the clock + the chat feed's
// event timestamps → every page agrees.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { sceneFileUrl } from '../SceneRuntime.ts';
import { hash32, Rng } from '../raid/rng.ts';
import { SPRITE, SpaceFx } from '../space/fx.ts';
import { FACE_SLOTS, faceUniforms } from '../space/ships.ts';
import { frontlineRoomOf, SHIP, shipEvents, terrainY, type FrontlineCfg, type FrontlineRoom, type Pad } from './frontlineRoom.ts';
import { BUGS, FrontlinePlan, SUPPORT_KINDS, SUPPORT_NAME, T0, type Bug, type Support, type SupportKind } from './frontlinePlan.ts';
import { Defender, loadDefenders, UnitLib, type PartDef } from './frontlineUnits.ts';
import { activeFrontlineMover, POD } from './frontlineMover.ts';
import { rewardKindOf } from './frontlineRewards.ts';
import { safeAmp } from '../../../shared/flashGovernor.ts';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };
const UP = V(0, 1, 0);
const tv = V(), tv2 = V(), tv3 = V(), tq = new THREE.Quaternion(), te = new THREE.Euler(), tm = new THREE.Matrix4(), ts3 = V(1, 1, 1);
const SKY_DIR = V(0.35, 1, -0.5).normalize();          // where drop pods / shells come from
const ORBIT = V(-0.35, 1, -0.55).normalize();         // the destroyer (orbital strikes)
const AGGRO_NAMES = ['CALM', 'RESTLESS', 'AGITATED', 'FRENZIED', 'APOCALYPTIC'];

interface DState { clip: string; since: number; prev: string; prevT: number }
interface Stamp { k: SupportKind; at: number; id: string; user?: string; amount?: string; reward?: string }

export class FrontlineScene {
  private rt: SceneRuntime | null = null;
  room: FrontlineRoom | null = null;
  cfg: FrontlineCfg = {};
  plan: FrontlinePlan | null = null;
  lib: UnitLib | null = null;
  defenders: Defender[] = [];
  private dstate: DState[] = [];
  private group = new THREE.Group();
  private fx: SpaceFx | null = null;
  private board: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; mesh: THREE.Mesh; at: number; key: string } | null = null;
  private labels: { sprite: THREE.Sprite; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; id: string }[] = [];
  private restoreMats: (() => void)[] = [];
  private turretBase: { node: THREE.Object3D; q: THREE.Quaternion }[] = [];
  private loadErr = '';
  private pendingChat: number[] = [];
  private stamps: Stamp[] = [];
  private lastSupport: Support | null = null;
  private perf = { avg: 0, peak: 0, level: 0, slowFor: 0, goodFor: 0 };
  private shake = 0;
  private bugsNow: Bug[] = [];
  private fired = new Set<string>();
  protect = true;
  manual = false;
  clock = Date.now();
  forceLevel: number | null = null;
  now() { return this.manual ? this.clock : Date.now(); }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const cfg = (rt.info as unknown as { frontline?: FrontlineCfg }).frontline;
    if (!cfg || cfg.on === false) return;
    const room = frontlineRoomOf(rt.root);
    if (!room) return;
    this.rt = rt; this.room = room; this.cfg = cfg;
    this.plan = new FrontlinePlan(room, cfg);
    this.plan.chat = [...this.pendingChat];
    for (const s of this.stamps) this.plan.stamps.push(s);
    this.group = new THREE.Group(); this.group.name = 'vtp:frontline';
    rt.root.add(this.group);
    this.fx = new SpaceFx({ sprites: 2600, smoke: 800, streaks: 1800 }, true);
    this.group.add(this.fx.group);
    this.unlitSky(rt);
    this.makeBoard();
    for (const t of room.turrets) this.turretBase.push({ node: t, q: t.quaternion.clone() });
    const gen = () => this.rt === rt;
    UnitLib.load(sceneFileUrl(rt.info.id, cfg.units ?? 'npc/units.glb'), sceneFileUrl(rt.info.id, cfg.unitsMeta ?? 'npc/units.json')).then((lib) => {
      if (!gen()) { lib.dispose(); return; }
      this.lib = lib; this.group.add(lib.group);
    }).catch((e) => { this.loadErr = String((e as Error)?.message ?? e); console.warn('[frontline] units', e); });
    loadDefenders(sceneFileUrl(rt.info.id, cfg.defenders ?? 'npc/defenders.glb')).then((asset) => {
      if (!gen()) return;
      for (const p of room.defenders) {
        const d = new Defender(asset, cfg.defenderHeight ?? 1.45);
        d.root.position.copy(p.pos); d.root.rotation.y = p.yaw;
        this.group.add(d.root);
        this.defenders.push(d);
        this.dstate.push({ clip: 'idle', since: 0, prev: 'idle', prevT: 0 });
      }
    }).catch((e) => { this.loadErr = String((e as Error)?.message ?? e); console.warn('[frontline] defenders', e); });
  }

  detach() {
    for (const r of this.restoreMats) r();
    this.restoreMats = [];
    for (const t of this.turretBase) t.node.quaternion.copy(t.q);
    this.turretBase = [];
    this.lib?.dispose(); this.lib = null;
    for (const d of this.defenders) d.dispose();
    this.defenders = []; this.dstate = [];
    this.fx?.dispose(); this.fx = null;
    if (this.board) { this.board.tex.dispose(); this.board.mesh.geometry.dispose(); (this.board.mesh.material as THREE.Material).dispose(); this.board = null; }
    for (const l of this.labels) { l.tex.dispose(); l.sprite.material.dispose(); }
    this.labels = [];
    this.group.removeFromParent();
    if (this.plan) this.pendingChat = this.plan.chat;
    this.rt = null; this.room = null; this.plan = null;
  }

  // ------------------------------------------------------------------------------------------ chat → aggression / supports
  onChat(evs: { kind?: string; platform?: string; fkind?: string; ts?: number; id?: string; user?: string; text?: string; ev?: string; usd?: number; approxUsd?: number; display?: string; amount?: number; label?: string; test?: boolean; cue?: boolean }[], snap: boolean) {
    const nowS = Date.now() / 1000;
    let touched = false;
    for (const e of evs) {
      const ts = typeof e.ts === 'number' ? e.ts / 1000 : nowS;
      if (e.kind === 'chat' && !e.cue) {
        const list = this.plan ? this.plan.chat : this.pendingChat;
        list.push(ts - T0);
        touched = true;
        continue;
      }
      if (snap) continue;
      const at = (Math.abs(nowS - ts) < 60 ? ts : nowS) + 1.2 - T0;
      const id = `sup:${e.id ?? Math.round(ts * 1000)}`;
      if (this.stamps.some((s) => s.id === id)) continue;
      const user = (e.user ?? '').slice(0, 24);
      // Kick channel-point redemptions (Kick only for now): a system line tagged ev 'reward' ("redeemed <title>")
      if (e.kind === 'system' && (e.ev === ('reward' as string) || /^redeemed\b/i.test(e.text ?? '')) && (e.platform === 'kick' || e.platform === 'test')) {
        const title = (e.label || (e.text ?? '').replace(/^redeemed\s*/i, '')).slice(0, 60);
        this.addStamp({ k: this.rewardKind(title), at, id, user, reward: title });
        touched = true;
        continue;
      }
      if (e.kind !== 'finance') continue;
      for (const s of this.financeKinds(e.fkind ?? '', e.usd ?? e.approxUsd ?? 0, e.amount ?? 0)) this.addStamp({ k: s, at, id: `${id}:${s}`, user, amount: e.display ?? (e.usd ? `$${e.usd.toFixed(2)}` : '') });
      touched = true;
    }
    if (touched) { const p = this.plan; if (p) { p.chat.sort((a, b) => a - b); p.touch(); } else this.pendingChat.sort((a, b) => a - b); }
  }
  private addStamp(s: Stamp) {
    this.stamps.push(s);
    if (this.stamps.length > 60) this.stamps.shift();
    if (this.plan) { this.plan.stamps.push(s); this.plan.touch(); }
  }
  /** reward title -> support (scene.json frontline.rewards keywords; ties by frontline.rewardPriority: frontlineRewards.ts) */
  rewardKind(title: string): SupportKind {
    return rewardKindOf(title, this.cfg.rewards, this.cfg.rewardPriority);
  }
  /** money / subs / raids → supports (bigger money, bigger support) */
  financeKinds(fkind: string, usd: number, amount: number): SupportKind[] {
    if (fkind === 'raid') return ['mech', 'barrage'];
    if (fkind === 'giftSub' || fkind === 'giftMembership') return amount >= 5 ? ['hellbomb'] : ['barrage'];
    if (/^(sub|resub|membership|milestone)$/.test(fkind)) return ['bomb500'];
    const th = this.cfg.support ?? { strafe: 0, airstrike: 3, napalm: 8, barrage: 15, laser: 30, bomb500: 50, hellbomb: 100 };
    let best: SupportKind = 'strafe', bv = -1;
    for (const [k, v] of Object.entries(th)) if (usd >= v && v > bv && (SUPPORT_KINDS as string[]).includes(k)) { best = k as SupportKind; bv = v; }
    return usd >= 100 ? [best, 'mech'] : [best];
  }
  /** Tests (page only): kind = a support kind | tip | sub | gift | raid | reward:<title> | chat:<n> (n messages over the last minute) */
  test(kind: string, user = 'TestViewer', inSec = 0.5, usd = 10) {
    const nowS = this.now() / 1000;
    if (kind.startsWith('chat:')) {
      const n = parseInt(kind.slice(5), 10) || 20;
      this.onChat(Array.from({ length: n }, (_, i) => ({ kind: 'chat', ts: (nowS - 60 + (60 * i) / n) * 1000, id: `t${i}` })), true);
      return;
    }
    const at = nowS + inSec - T0, id = `test:${kind}:${Math.round(at * 1000)}`;
    if (kind.startsWith('reward:')) { const title = kind.slice(7); this.addStamp({ k: this.rewardKind(title), at, id, user, reward: title }); return; }
    if ((SUPPORT_KINDS as string[]).includes(kind)) { this.addStamp({ k: kind as SupportKind, at, id, user, amount: '' }); return; }
    const fk = kind === 'tip' ? 'tip' : kind === 'sub' ? 'sub' : kind === 'gift' ? 'giftSub' : 'raid';
    for (const s of this.financeKinds(fk, kind === 'tip' ? usd : 0, kind === 'gift' ? 5 : 0)) this.addStamp({ k: s, at, id: `${id}:${s}`, user, amount: kind === 'tip' ? `$${usd.toFixed(2)}` : '' });
  }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number) {
    const t0 = performance.now();
    try { this.step(dt); } catch (e) { console.warn('[frontline] frame failed', e); }
    const ms = performance.now() - t0;
    this.perf.avg = this.perf.avg * 0.97 + ms * 0.03; this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private step(dt: number) {
    const rt = this.rt, R = this.room, fx = this.fx, P = this.plan;
    if (!rt || !R || !fx || !P) return;
    if (this.manual) this.clock += dt * 1000;
    const t = this.now() / 1000 - T0;
    const cam = rt.stage.camera;
    const H = rt.stage.renderer.domElement.height || 1080;
    fx.uniforms.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / H;
    fx.begin(t);
    this.governor(dt);
    P.prune(t);
    const bugs = this.bugsNow = P.bugsAt(t);
    const sups = P.supportsIn(t - 60, t + 2);
    const titans = P.titanStrikes(t, bugs);
    const lib = this.lib;
    lib?.begin();
    const lvl = this.perf.level;
    // --- the swarm
    for (const b of bugs) this.drawBug(b, t, lvl);
    // --- defenders, turrets, sentries, the mech: who is shooting what
    this.drawDefenders(t, bugs, sups);
    this.drawTurrets(t, bugs);
    for (const s of sups) this.drawSupport(s, t, bugs);
    for (const ti of titans) this.drawRail(ti.id, ti.at, ti.p, t, true);
    // --- dropships + drop pods
    this.drawShips(t);
    this.drawPods(t);
    lib?.end();
    fx.end();
    this.drawBoard(t, bugs.length, sups);
    this.drawLabels(t, sups);
    this.protectFaces();
    this.applyShake(dt);
  }

  // ------------------------------------------------------------------------------------------ bugs
  private bugTint = new THREE.Color();
  private drawBug(b: Bug, t: number, lvl: number) {
    const P = this.plan!, lib = this.lib, fx = this.fx!;
    const spec = BUGS[b.kind];
    const age = t - b.death;
    const pos = P.pos(b, Math.min(t, b.death), tv);
    const s = P.dist(b, Math.min(t, b.death));
    // heading: along the path (a tiny look-ahead)
    const ahead = P.pos(b, Math.min(t, b.death) + 0.15, tv2);
    let yaw = Math.atan2(ahead.x - pos.x, ahead.z - pos.z);
    if (!isFinite(yaw) || ahead.distanceToSquared(pos) < 1e-6) yaw = Math.atan2(b.to.x - b.from.x, b.to.z - b.from.z);
    const emerge = spec.emerge > 0 ? clamp01((t - b.t0) / spec.emerge) : 1;
    const attacking = s >= b.stopAt - 0.01 && t < b.death;
    const titan = b.kind === 'titan';
    const dying = age >= 0;
    if (dying && !titan && age > 0.22) { this.goo(b, pos, age, lvl); return; }
    if (dying && titan && age > 3.2) { this.goo(b, pos, age - 3.2, lvl); return; }
    if (lvl >= 2 && b.kind === 'shrieker' && (b.seed & 1)) return;
    // root: sink while emerging, titans topple when they die
    let sink = (1 - smooth(emerge)) * spec.size * 0.9;
    let tilt = 0;
    if (titan && dying) { tilt = smooth(age / 2.6) * 1.2; sink += smooth((age - 1.5) / 1.7) * 4; }
    if (b.kind === 'charger' && dying) tilt = age * 3;
    const ground = terrainY(pos.x, pos.z);
    const slope = Math.atan2(terrainY(pos.x + Math.sin(yaw), pos.z + Math.cos(yaw)) - ground, 1) * 0.8;
    te.set(-slope + tilt, yaw, b.kind === 'shrieker' ? Math.sin(t * 2 + b.seed) * 0.35 : 0, 'YXZ');
    tq.setFromEuler(te);
    const pop = dying && !titan ? 1 + age * 2.2 : 1;
    ts3.setScalar(pop);
    tm.compose(tv3.set(pos.x, pos.y - sink, pos.z), tq, ts3);
    // walk phase = distance / stride; attack / idle when stopped
    const stride = Math.max(0.5, spec.size * 0.75);
    const ph = (s / stride) * Math.PI * 2 + (b.seed % 17);
    const tt = t + (b.seed % 100) * 0.13;
    const hop = b.kind === 'hunter' ? Math.max(0, Math.sin(tt * 4.2)) : 0;
    if (hop > 0) tm.elements[13] += hop * 0.7;
    if (dying && !titan) this.bugTint.setRGB(2.2, 1.6, 1.0);
    else this.bugTint.setScalar(1);
    if (!lib) return;
    lib.put(b.kind, tm, (p: PartDef, q: THREE.Quaternion, sc: THREE.Vector3) => {
      switch (p.role) {
        case 'leg': {
          const ph2 = ph + (p.idx % 2 ? Math.PI : 0) + (p.side > 0 ? 0 : Math.PI);
          const amp = titan ? 0.22 : 0.42;
          const swing = attacking ? Math.sin(tt * 9 + p.idx) * 0.08 : Math.sin(ph2) * amp;
          const lift = attacking ? 0 : Math.max(0, Math.cos(ph2)) * (titan ? 0.18 : 0.35);
          te.set(0, swing * p.side, p.side * lift, 'YXZ'); q.setFromEuler(te);
          break;
        }
        case 'arm': {
          const strike = attacking ? -1.2 * Math.abs(Math.sin(tt * 5 + p.side)) : -0.25 + 0.2 * Math.sin(tt * 2.2 + p.side);
          te.set(strike, 0, 0, 'XYZ'); q.setFromEuler(te);
          break;
        }
        case 'head': te.set(Math.sin(tt * 3) * 0.12, Math.sin(tt * 1.7) * 0.25, 0, 'YXZ'); q.setFromEuler(te); break;
        case 'sac': sc.setScalar(1 + 0.07 * Math.sin(tt * 3.2) + (attacking ? 0.08 * Math.sin(tt * 12) : 0)); break;
        case 'wing': te.set(0, 0, p.side * 0.9 * Math.sin(tt * 17), 'XYZ'); q.setFromEuler(te); break;
        default: break;
      }
    }, this.bugTint, 0.8 + 0.4 * Math.sin(tt * 3));
    // spewers spit bile at the wall while stopped; titans spew from their mouth; dust while emerging
    if (attacking && (b.kind === 'spewer' || titan) && lvl < 2) {
      const mouth = tv2.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(titan ? 6 : 1.3).add(pos).setY(pos.y + (titan ? 8.5 : 1.1));
      const k = (tt * 1.3) % 1;
      const tgt = tv3.copy(pos).multiplyScalar(this.room!.wallR / Math.max(1, Math.hypot(pos.x, pos.z)));
      tgt.y = 1.2;
      for (let i = 0; i < 5; i++) {
        const u = clamp01(k - i * 0.05);
        const p = tv.lerpVectors(mouth, tgt, u); p.y += Math.sin(u * Math.PI) * 5;
        fx.sprite(p, titan ? 1.1 : 0.45, 0.5, 1.2, 0.15, 0.8 * (1 - u), SPRITE.fire, b.seed + i);
      }
    }
    if (emerge < 1 && lvl < 2) fx.puff(tv.set(pos.x, ground + 0.3, pos.z), spec.size * 0.6 * (1 + emerge), 0.45, 0.32, 0.22, 0.5 * (1 - emerge), b.seed);
  }

  private goo(b: Bug, pos: THREE.Vector3, age: number, lvl: number) {
    const fx = this.fx!, spec = BUGS[b.kind], [r, g, bl] = spec.goo;
    const sz = spec.size * (b.kind === 'titan' ? 1.6 : 1);
    if (age > 1.6) return;
    const k = age / 1.6;
    const c = tv2.set(pos.x, pos.y + sz * 0.4, pos.z);
    if (age < 0.12) fx.sprite(c, sz * 1.4, 2.4, 2.0, 1.2, 1 - age / 0.12, SPRITE.core, b.seed);
    const n = lvl >= 1 ? 3 : 6;
    const rr = new Rng(b.seed);
    for (let i = 0; i < n; i++) {
      const a = rr.range(0, Math.PI * 2), up = rr.range(0.4, 1.4), sp = rr.range(1.5, 4) * sz * 0.5;
      const p = tv3.set(c.x + Math.cos(a) * sp * age * 1.6, c.y + up * sz * 1.2 * age * 1.5 - 4.9 * age * age, c.z + Math.sin(a) * sp * age * 1.6);
      if (p.y < terrainY(p.x, p.z)) p.y = terrainY(p.x, p.z) + 0.05;
      fx.sprite(p, sz * 0.28 * (1 - k * 0.5), r, g, bl, 1 - k, SPRITE.fire, b.seed + i);
    }
    if (age < 0.5) fx.sprite(c, sz * (0.5 + age * 3), r * 0.8, g * 0.8, bl, (1 - age / 0.5) * 0.7, SPRITE.ring, b.seed);
    if (lvl < 1) fx.puff(tv3.set(c.x, c.y + age * 1.2, c.z), sz * (0.6 + age), r * 0.35, g * 0.3, bl * 0.25, 0.45 * (1 - k), b.seed);
  }

  // ------------------------------------------------------------------------------------------ defenders
  private drawDefenders(t: number, bugs: Bug[], sups: Support[]) {
    const R = this.room!, fx = this.fx!, P = this.plan!;
    if (!this.defenders.length) return;
    // cheers after big moments: titan kills, hellbombs, supply drops
    let cheer = -1e9;
    for (const b of bugs) if (b.kind === 'titan' && t > b.death && t < b.death + 4) cheer = Math.max(cheer, b.death + 0.5);
    for (const s of sups) { if (s.k === 'hellbomb' && s.impacts[0]) cheer = Math.max(cheer, s.impacts[0].t + 1); if (s.k === 'supply') cheer = Math.max(cheer, s.at + 2.8); }
    const callers = new Map<number, Support>();
    for (const s of sups) if (t >= s.at - 0.1 && t < s.at + 1.6) callers.set(this.callerOf(s), s);
    const boost = sups.some((s) => s.k === 'supply' && s.on && t >= s.on[0] && t <= s.on[1]);
    this.defenders.forEach((d, i) => {
      const post = R.defenders[i];
      const st = this.dstate[i];
      // the bug this defender kills next (its shots) or suppressive fire on the nearest one in its sector
      let target: Bug | null = null, killShot = false;
      for (const b of bugs) if ((b.killer.k === 'def' || b.killer.k === 'at') && b.killer.i === i && t >= b.death - (b.killer.k === 'at' ? 1.2 : 1.6) && t < b.death) { target = b; killShot = true; break; }
      if (!target) {
        let bd = 70 * 70;
        for (const b of bugs) {
          if (t >= b.death) continue;
          const p = P.pos(b, t, tv);
          const dx = p.x - post.pos.x, dz = p.z - post.pos.z, d2 = dx * dx + dz * dz;
          const rel = Math.atan2(dx, dz) - post.yaw;
          if (d2 < bd && Math.abs(Math.atan2(Math.sin(rel), Math.cos(rel))) < 1.1) { bd = d2; target = b; }
        }
      }
      const burst = ((t + i * 0.77) % 2.1) < (boost ? 1.8 : 1.3);
      const reloadW = (t + i * 3.7) % 11.5;
      let clip = 'idle';
      if (t - cheer < 2.4 && t >= cheer) clip = 'cheer';
      else if (callers.has(i)) clip = 'call';
      else if (killShot) clip = 'fire';
      else if (reloadW > 9.6 && reloadW < 11.2) clip = 'reload';
      else if (target && burst) clip = 'fire';
      if (clip !== st.clip) { st.prev = st.clip; st.prevT = t - st.since; st.clip = clip; st.since = t; }
      const ct = clip === 'call' ? t - callers.get(i)!.at + 0.1 : clip === 'reload' ? reloadW - 9.6 : t - st.since;
      const w = smooth((t - st.since) / 0.22);
      d.pose(clip, clip === 'fire' || clip === 'idle' || clip === 'cheer' ? t + i * 0.31 : ct, st.prev, st.prevT + (t - st.since), w);
      // aim: turn toward the target (±70° of the post)
      let yaw = post.yaw;
      if (target && (clip === 'fire' || clip === 'idle')) {
        const p = P.pos(target, t, tv);
        const rel = Math.atan2(p.x - post.pos.x, p.z - post.pos.z) - post.yaw;
        yaw = post.yaw + THREE.MathUtils.clamp(Math.atan2(Math.sin(rel), Math.cos(rel)), -1.2, 1.2);
      }
      d.root.rotation.y += (yaw - d.root.rotation.y) * 0.25;
      d.root.updateMatrixWorld(true);
      if (clip !== 'fire' || !target) return;
      const muzzle = d.muzzle(tv2).clone();
      const tp = P.pos(target, Math.min(t, target.death), tv3).clone();
      tp.y += BUGS[target.kind].size * 0.45;
      if (target.killer.k === 'at' && killShot) { this.rocket(muzzle, tp, target.death - 0.75, target.death, t, i); return; }
      this.shots(`d${i}`, muzzle, tp, t, boost ? 0.085 : 0.12, i * 0.037, killShot ? 0.3 : 1.6, target.seed);
      void fx;
    });
  }
  private callerOf(s: Support) {
    const R = this.room!;
    const a = Math.atan2(s.target.x, -s.target.z);
    let best = 0, bd = Infinity;
    R.defenders.forEach((d, i) => { const dd = Math.abs(Math.atan2(d.pos.x, -d.pos.z) - a) + (hash32(s.id, i) % 100) * 0.002; if (dd < bd) { bd = dd; best = i; } });
    return best;
  }

  /** tracer bursts: one bullet every `every` s (phase `phase`); miss = scatter (m) at the target */
  private shots(key: string, from: THREE.Vector3, to: THREE.Vector3, t: number, every: number, phase: number, miss: number, seed: number) {
    const fx = this.fx!;
    const n = Math.floor((t + phase) / every);
    for (let k = n - 1; k <= n; k++) {
      const st = k * every - phase, age = t - st;
      if (age < 0) continue;
      const r = new Rng(hash32(key, k, seed));
      const end = tv.copy(to).add(tv3.set(r.range(-1, 1) * miss, r.range(-0.3, 1) * miss * 0.5, r.range(-1, 1) * miss));
      const dist = from.distanceTo(end);
      const flight = Math.max(0.04, dist / 260);
      const u = age / flight;
      if (u < 1.15) {
        const a = V().lerpVectors(from, end, clamp01(u - 0.45)), b = V().lerpVectors(from, end, clamp01(u));
        fx.line(a, b, 0.05, 1.4, 2.4, 1.7, 0.6, 1);
      }
      if (age < 0.05) fx.sprite(from, 0.22, 3, 2.2, 0.9, 1 - age / 0.05, SPRITE.flare, r.next());
      if (u >= 1 && u < 1.6) fx.sprite(end, 0.35, 2.4, 1.6, 0.7, 1.6 - u, SPRITE.spark, r.next());
    }
  }
  private rocket(from: THREE.Vector3, to: THREE.Vector3, t0: number, t1: number, t: number, i: number) {
    const fx = this.fx!;
    if (t < t0) return;
    if (t < t1) {
      const u = (t - t0) / (t1 - t0);
      const p = V().lerpVectors(from, to, u); p.y += Math.sin(u * Math.PI) * 3;
      const q = V().lerpVectors(from, to, Math.max(0, u - 0.08)); q.y += Math.sin(Math.max(0, u - 0.08) * Math.PI) * 3;
      fx.line(q, p, 0.12, 2, 2.4, 1.3, 0.5, 1);
      fx.sprite(p, 0.5, 3, 1.8, 0.7, 1, SPRITE.glow, i);
      fx.puff(q, 0.6, 0.5, 0.5, 0.5, 0.4, i + u);
      if (t - t0 < 0.08) fx.sprite(from, 0.8, 3, 2, 1, 1, SPRITE.flare, i);
    }
    this.boom(to, t - t1, 1.6, hash32('rk', i, Math.round(t1 * 10)));
  }

  // ------------------------------------------------------------------------------------------ turrets
  private drawTurrets(t: number, bugs: Bug[]) {
    const R = this.room!, P = this.plan!;
    R.turrets.forEach((node, i) => {
      const base = this.turretBase[i];
      const wp = node.getWorldPosition(tv2).clone();
      let target: Bug | null = null, kill = false;
      for (const b of bugs) if (b.killer.k === 'turret' && b.killer.i === i && t >= b.death - 1.8 && t < b.death) { target = b; kill = true; break; }
      if (!target) { let bd = 80 * 80; for (const b of bugs) { if (t >= b.death) continue; const p = P.pos(b, t, tv); const d = p.distanceToSquared(wp); if (d < bd && (p.z - wp.z) * Math.sign(wp.z || -1) > 0) { bd = d; target = b; } } }
      if (!target) return;
      const tp = P.pos(target, Math.min(t, target.death), tv3).clone(); tp.y += BUGS[target.kind].size * 0.4;
      const dir = tp.clone().sub(wp);
      const yaw = Math.atan2(dir.x, dir.z), pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
      // the head's model faces its local -Y in Blender = glTF +Z … its authored rest looks outward: aim with a world quaternion
      const parentQ = node.parent ? node.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion();
      tq.setFromEuler(te.set(-pitch, yaw + Math.PI, 0, 'YXZ'));
      node.quaternion.copy(parentQ.multiply(tq));
      void base;
      const fwd = V(0, 0, -1).applyQuaternion(tq);
      if (((t + i) % 3) < (kill ? 3 : 1.6)) {
        for (const s of [-1, 1]) {
          const m = wp.clone().addScaledVector(fwd, 1.9).add(V(Math.cos(yaw) * 0.14 * s, 0, -Math.sin(yaw) * 0.14 * s));
          this.shots(`t${i}${s}`, m, tp, t, 0.07, s * 0.035 + i * 0.02, kill ? 0.5 : 2.2, target.seed);
        }
      }
    });
  }

  // ------------------------------------------------------------------------------------------ explosions
  private boom(p: THREE.Vector3, age: number, size: number, seed: number) {
    const fx = this.fx!;
    if (age < 0 || age > 5) return;
    const lvl = this.perf.level;
    if (age < 0.16) fx.sprite(tv.copy(p).setY(p.y + size * 0.4), size * 1.3, 2.0, 1.45, 0.8, (1 - age / 0.16) * 0.8, SPRITE.core, seed);
    if (age < 1.3) {
      const r = new Rng(seed);
      for (let i = 0; i < (lvl ? 2 : 4); i++) {
        const q = tv.set(p.x + r.range(-1, 1) * size * 0.4, p.y + size * (0.3 + r.next() * 0.6) + age * size * 0.9, p.z + r.range(-1, 1) * size * 0.4);
        fx.sprite(q, size * (0.5 + age * 0.8), 2.0, 0.95, 0.32, (1 - age / 1.3) * 0.9, SPRITE.fire, seed + i);
      }
    }
    if (age < 0.7) fx.sprite(tv.copy(p).setY(p.y + 0.3), size * (0.5 + age * 4), 1.8, 1.2, 0.7, (1 - age / 0.7) * 0.6, SPRITE.ring, seed);
    if (lvl < 2) for (let i = 0; i < (lvl ? 1 : 3); i++) {
      const k = age / 5;
      fx.puff(tv.set(p.x + (i - 1) * size * 0.3, p.y + size * 0.5 + age * size * 0.55, p.z), size * (0.8 + age * 0.5), 0.22, 0.19, 0.17, 0.55 * (1 - k) * smooth(age / 0.3), seed + i);
    }
  }
  private kaboom(p: THREE.Vector3, t: number, at: number, size: number, key: string) {
    const age = t - at;
    this.boom(p, age, size, hash32(key));
    if (age >= 0 && age < 0.05 && !this.fired.has(key)) { this.fired.add(key); this.shake = Math.max(this.shake, Math.min(1, size / 14)); if (this.fired.size > 400) this.fired.clear(); }
  }

  // ------------------------------------------------------------------------------------------ supports
  private drawSupport(s: Support, t: number, bugs: Bug[]) {
    const fx = this.fx!, R = this.room!, lib = this.lib;
    const age = t - s.at;
    if (age < -0.2 || t > s.end + 5) return;
    if (!this.lastSupport || s.at > this.lastSupport.at) { if (t >= s.at) this.lastSupport = s; }
    const tgt = s.target;
    // the stratagem beacon: thrown from the caller's post, then a red beam on the target until the strike starts
    const first = s.impacts[0]?.t ?? (s.at + 2.8);
    if (!['mech', 'sentry', 'supply'].includes(s.k) || true) {
      const post = R.defenders[this.callerOf(s)];
      const from = post ? tv2.copy(post.pos).setY(1.6) : tv2.set(0, 2, -12);
      const land = s.k === 'mech' ? R.mech?.pos ?? tgt : s.k === 'supply' ? R.supply?.pos ?? tgt : s.k === 'sentry' ? R.sentries[0]?.pos ?? tgt : tgt;
      if (age > 0.9 && age < 1.4) { const u = (age - 0.9) / 0.5; const p = tv3.lerpVectors(from, land, u); p.y += Math.sin(u * Math.PI) * 6; fx.sprite(p, 0.35, 3, 0.4, 0.3, 1, SPRITE.glow, 1); }
      if (age >= 1.4 && t < first + 0.6) {
        const b0 = tv3.copy(land); b0.y = terrainY(b0.x, b0.z) + 0.2;
        const pulse = 0.6 + 0.4 * Math.sin(t * 12);
        fx.line(b0, V(b0.x, b0.y + 26, b0.z), 0.12, 2.2, 2.6, 0.25, 0.2, pulse);
        fx.sprite(b0, 0.7, 3, 0.4, 0.3, pulse, SPRITE.flare, 2);
      }
    }
    const up = (x: THREE.Vector3, h: number) => V(x.x, x.y + h, x.z);
    switch (s.k) {
      case 'strafe': case 'airstrike': case 'napalm': case 'bomb500': {
        const tMid = s.k === 'bomb500' ? first - 0.9 : (s.impacts[0].t + s.impacts[Math.min(5, s.impacts.length - 1)].t) / 2 - 0.5;
        const dir = s.dir.lengthSq() > 0.1 ? s.dir : V(1, 0, 0);
        const fly = (tt: number) => V(tgt.x + dir.x * (tt - tMid) * 95, tgt.y + 30 + Math.abs(tt - tMid) * 6, tgt.z + dir.z * (tt - tMid) * 95);
        if (Math.abs(t - tMid) < 3.2 && lib) {
          const p = fly(t), yawE = Math.atan2(dir.x, dir.z);
          tq.setFromEuler(te.set(0, yawE, Math.sin((t - tMid) * 1.5) * 0.3, 'YXZ'));
          tm.compose(p, tq, ts3.setScalar(1.4));
          lib.put('eagle', tm, undefined, undefined, 1.5);
          fx.line(p, fly(t - 0.25), 0.25, 1.5, 0.6, 0.9, 1.4, 0.7);
        }
        for (const [k, im] of s.impacts.entries()) {
          if (k >= 6 && s.k !== 'strafe') { // napalm burn ticks: fire along the strip
            if (t >= im.t - 0.3 && t < im.t + 0.6) for (let j = 0; j < 2; j++) fx.sprite(up(im.p, 1 + j * 1.5), 2.2, 2.6, 1.1, 0.3, 0.7, SPRITE.fire, k + j);
            continue;
          }
          if (s.k === 'strafe') {
            if (t >= im.t - 0.28 && t < im.t) { const pl = fly(im.t - 0.3); fx.line(pl, im.p, 0.08, 1.6, 2.8, 1.8, 0.6, 1); }
            this.boom(im.p, t - im.t, 1.4, hash32(s.id, k));
          } else {
            const rel = im.t - 0.85;
            if (t >= rel && t < im.t) { const u = (t - rel) / 0.85; const a = fly(rel); const p = V().lerpVectors(a, im.p, u); p.y += (1 - u) * 2 - 0; fx.sprite(p, 0.3, 0.3, 0.3, 0.3, 1, SPRITE.glow, k); }
            this.kaboom(im.p, t, im.t, s.k === 'bomb500' ? 11 : s.k === 'napalm' ? 3.8 : 4.8, `${s.id}:${k}`);
            if (s.k === 'napalm' && t > im.t && t < im.t + 9) fx.sprite(up(im.p, 1.4), 3, 2.6, 1.0, 0.25, 0.8 * (1 - (t - im.t) / 9), SPRITE.fire, k + 7);
          }
        }
        break;
      }
      case 'barrage': case 'railcannon': case 'hellbomb': {
        for (const [k, im] of s.impacts.entries()) {
          const sky = V().copy(im.p).addScaledVector(ORBIT, 420);
          if (s.k === 'barrage' && t >= im.t - 0.55 && t < im.t) { const u = (t - (im.t - 0.55)) / 0.55; fx.line(V().lerpVectors(sky, im.p, Math.max(0, u - 0.15)), V().lerpVectors(sky, im.p, u), 0.5, 2, 3, 2.2, 1.2, 1); }
          if (s.k === 'railcannon') this.drawRail(s.id, s.at, im.p, t, false);
          else this.kaboom(im.p, t, im.t, s.k === 'hellbomb' ? 34 : 7.5, `${s.id}:${k}`);
          if (s.k === 'hellbomb') {
            // the device: lands after the beacon, blinks, then the white-out
            if (lib && t > s.at + 2.4 && t < im.t) {
              const land = s.at + 2.6;
              const p = V(im.p.x, im.p.y, im.p.z);
              if (t < land) p.addScaledVector(SKY_DIR, (land - t) * 160);
              tm.compose(p, tq.identity(), ts3.setScalar(1.3));
              lib.put('supply', tm, undefined, new THREE.Color(1.2, 0.4, 0.3), Math.sin(t * (6 + (t - land) * 2)) > 0 ? 2.5 : 0.3);
            }
            const a2 = t - im.t;
            if (a2 >= 0 && a2 < 2.5) fx.sprite(up(im.p, 20), 60 * (0.4 + a2), 2.2, 1.9, 1.5, (1 - a2 / 2.5) * 0.8, SPRITE.core, 9);
            if (a2 >= 0 && a2 < 3) fx.sprite(up(im.p, 2), 20 + a2 * 45, 2.4, 1.7, 1.0, (1 - a2 / 3) * 0.7, SPRITE.ring, 9);
            if (a2 >= 0 && a2 < 9) for (let j = 0; j < 5; j++) fx.puff(up(im.p, 8 + j * 9 + a2 * 3), 14 + j * 3 + a2 * 2, 0.3, 0.24, 0.2, 0.6 * (1 - a2 / 9), j);
          }
        }
        break;
      }
      case 'laser': {
        const t0 = s.at + 3.2, t1 = t0 + 8;
        if (t > t0 - 0.4 && t < t1) {
          const u = clamp01((t - t0) / 8);
          const spot = this.plan!.laserAt(s, u, V());
          const sky = V().copy(spot).addScaledVector(ORBIT, 500);
          const warm = smooth((t - t0 + 0.4) / 0.4);
          fx.line(sky, spot, 1.4 * warm, 3, 2.2, 0.6, 0.4, 0.8, true);
          fx.line(sky, spot, 0.45 * warm, 1.6, 3, 2.6, 2.0, 1, true);
          fx.sprite(up(spot, 0.8), 4.5, 3, 1.6, 0.6, warm, SPRITE.fire, t);
          fx.sprite(up(spot, 0.3), 7, 2.6, 1, 0.4, 0.6 * warm, SPRITE.glow, 3);
          if (this.perf.level < 2) fx.puff(up(spot, 3 + ((t * 7) % 1) * 5), 4, 0.25, 0.2, 0.2, 0.5, t);
        }
        break;
      }
      case 'mech': this.drawMech(s, t, bugs); break;
      case 'sentry': this.drawSentries(s, t, bugs); break;
      case 'supply': {
        const at = s.at + 2.5, p0 = R.supply?.pos ?? V(2.8, 0.1, -3.4);
        this.pod('supply', p0, 0, at, t, s.end, 0, s.id);
        if (t > at && t < s.end) fx.sprite(up(p0, 1.8), 0.6, 0.4, 1.4, 3, 0.6 + 0.4 * Math.sin(t * 4), SPRITE.glow, 4);
        break;
      }
    }
  }

  private drawRail(id: string, at: number, p: THREE.Vector3, t: number, titan: boolean) {
    const fx = this.fx!;
    const hit = at + 3.0;
    const age = t - hit;
    if (t > at + 1.4 && t < hit) { const b0 = V(p.x, terrainY(p.x, p.z) + 0.2, p.z); fx.line(b0, V(b0.x, b0.y + 26, b0.z), 0.12, 2.2, 2.6, 0.25, 0.2, 0.6 + 0.4 * Math.sin(t * 14)); }
    if (age >= 0 && age < 0.45) {
      const sky = V().copy(p).addScaledVector(ORBIT, 500);
      fx.line(sky, p, 1.6 * (1 - age / 0.45), 4, 1.8, 2.4, 3, 1, true);
      fx.line(sky, p, 0.5, 2, 3, 3, 3, 1 - age / 0.45, true);
    }
    this.kaboom(V(p.x, p.y + (titan ? 6 : 0), p.z), t, hit, titan ? 9 : 5, `rail:${id}`);
  }

  /** a pod falling out of the sky onto p (drop pods for supports; unit 'pod' or 'supply') */
  private pod(unit: string, p: THREE.Vector3, yaw: number, land: number, t: number, until: number, door: number, key: string) {
    const fx = this.fx!, lib = this.lib;
    const fall = 2.2;
    if (t < land - fall || t > until + 1) return;
    const u = (land - t) / fall;           // 1 → 0 while falling
    const pos = V(p.x, terrainY(p.x, p.z), p.z);
    if (u > 0) pos.addScaledVector(SKY_DIR, u * u * 340);
    else pos.y -= Math.min(0.25, -u * 3);
    const fade = t > until ? 1 - (t - until) : 1;
    tq.setFromUnitVectors(UP, u > 0 ? SKY_DIR : UP);
    tq.multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
    tm.compose(pos, tq, ts3.setScalar(Math.max(0.01, fade)));
    const heat = u > 0 ? 3 : Math.max(0, 1.5 - (t - land) / 4);
    lib?.put(unit, tm, (pp, q) => { if (pp.role === 'door') q.setFromAxisAngle(UP, THREE.MathUtils.degToRad(-115) * door); }, undefined, heat);
    if (u > 0) {
      const tail = V().copy(pos).addScaledVector(SKY_DIR, 38);
      fx.line(pos, tail, 0.9, 3, 2.6, 1.1, 0.35, 0.9);
      fx.sprite(pos, 1.6, 3, 1.5, 0.5, 1, SPRITE.fire, u * 9);
      if (this.perf.level < 2) for (let i = 1; i < 6; i++) fx.puff(V().copy(pos).addScaledVector(SKY_DIR, i * 7), 1.4 + i * 0.5, 0.3, 0.26, 0.24, 0.5 - i * 0.07, i);
    } else {
      this.kaboom(V(p.x, terrainY(p.x, p.z), p.z), t, land, unit === 'pod' ? 1.3 : 1.0, `pod:${key}`);
      const a = t - land;
      if (a < 2.5 && this.perf.level < 2) for (let i = 0; i < 8; i++) { const ang = (i / 8) * Math.PI * 2, r = 0.8 + a * 3.2; fx.puff(V(p.x + Math.cos(ang) * r, terrainY(p.x, p.z) + 0.4 + a * 0.3, p.z + Math.sin(ang) * r), 1.1 + a, 0.55, 0.42, 0.32, 0.6 * (1 - a / 2.5), i); }
      if (a < 6 && a > 0) fx.puff(V(p.x, terrainY(p.x, p.z) + 2.6 + a * 0.8, p.z), 0.8 + a * 0.3, 0.8, 0.8, 0.8, 0.35 * (1 - a / 6), 11);
    }
  }

  private drawMech(s: Support, t: number, bugs: Bug[]) {
    const R = this.room!, lib = this.lib, fx = this.fx!, P = this.plan!;
    const p0 = R.mech?.pos ?? V(-4.5, 0, -9.5), yaw0 = R.mech?.yaw ?? Math.PI;
    const land = s.at + 3.4;
    if (t < land - 2.2 || t > s.end + 1) return;
    const [on0, on1] = s.on!;
    let target: Bug | null = null;
    for (const b of bugs) if (b.killer.k === 'mech' && b.killer.id === s.id && t >= b.death - 1.4 && t < b.death) { target = b; break; }
    let yaw = yaw0;
    const tp = target ? P.pos(target, t, V()) : null;
    if (tp) yaw = Math.atan2(tp.x - p0.x, tp.z - p0.z);
    const u = (land - t) / 2.2;
    const pos = V(p0.x, p0.y, p0.z);
    if (u > 0) pos.addScaledVector(SKY_DIR, u * u * 300);
    const crouch = u > 0 ? 0 : 1 - smooth((t - land) / 1.4);
    const off = t > s.end ? 1 - (t - s.end) : 1;
    tq.setFromAxisAngle(UP, yaw);
    tm.compose(V(pos.x, pos.y - crouch * 0.7, pos.z), tq, ts3.setScalar(Math.max(0.01, off)));
    const active = t >= on0 && t <= on1;
    lib?.put('mech', tm, (p, q) => {
      if (p.role === 'leg') q.setFromEuler(te.set(crouch * 0.6 + (active ? Math.sin(t * 2 + p.side) * 0.03 : 0), 0, 0));
      if (p.role === 'arm') q.setFromEuler(te.set(tp ? -Math.atan2(tp.y + 1 - 3.1 - p0.y, Math.hypot(tp.x - p0.x, tp.z - p0.z)) : 0, 0, 0));
    });
    if (u > 0) { fx.line(pos, V().copy(pos).addScaledVector(SKY_DIR, 30), 1.1, 3, 2.6, 1.1, 0.35, 0.9); fx.sprite(pos, 2.2, 3, 1.5, 0.5, 1, SPRITE.fire, 3); }
    else this.kaboom(V(p0.x, p0.y, p0.z), t, land, 3.2, `mech:${s.id}`);
    if (!active || !tp) return;
    const fwd = V(Math.sin(yaw), 0, Math.cos(yaw)), right = V(Math.cos(yaw), 0, -Math.sin(yaw));
    const gun = V(p0.x, p0.y + 3.0, p0.z).addScaledVector(right, -1.05).addScaledVector(fwd, 1.7);
    tp.y += BUGS[target!.kind].size * 0.4;
    this.shots(`m${s.id}`, gun, tp, t, 0.05, 0, 0.6, target!.seed);
    // rockets every 2.2 s from the pod arm at whoever is closest
    const k = Math.floor((t - on0) / 2.2), rt0 = on0 + k * 2.2;
    const r = new Rng(hash32(s.id, 'rk', k));
    const alive = bugs.filter((b) => b.death > rt0 + 0.9 && b.t0 < rt0);
    if (alive.length) {
      const b = alive[r.int(alive.length)];
      const to = P.pos(b, rt0 + 0.9, V());
      const pod = V(p0.x, p0.y + 3.1, p0.z).addScaledVector(right, 1.1).addScaledVector(fwd, 1.0);
      this.rocket(pod, to, rt0, rt0 + 0.9, t, 50 + k);
    }
  }

  private drawSentries(s: Support, t: number, bugs: Bug[]) {
    const R = this.room!, lib = this.lib, P = this.plan!;
    const slots = R.sentries.length ? R.sentries : [{ pos: V(-3, 0, -12.8), yaw: Math.PI, name: '', role: '' }, { pos: V(3.5, 0, -12.8), yaw: Math.PI, name: '', role: '' }];
    const base = (hash32(s.id) % Math.max(1, Math.floor(slots.length / 2))) * 2;
    for (let j = 0; j < 2; j++) {
      const sl = slots[(base + j) % slots.length];
      const land = s.at + 2.6 + j * 0.35;
      this.pod('pod', sl.pos, sl.yaw, land, t, land + 1.2, 0, `${s.id}:${j}`);
      if (t < land + 0.8 || t > s.end + 1) continue;
      let target: Bug | null = null;
      for (const b of bugs) if (b.killer.k === 'sentry' && b.killer.id === s.id && b.killer.i === j && t >= b.death - 1.4 && t < b.death) { target = b; break; }
      const tp = target ? P.pos(target, t, V()) : null;
      const yaw = tp ? Math.atan2(tp.x - sl.pos.x, tp.z - sl.pos.z) : sl.yaw + Math.sin(t * 0.7 + j) * 0.6;
      const rise = smooth((t - land - 0.8) / 0.8) * (t > s.end ? 1 - (t - s.end) : 1);
      tq.identity();
      tm.compose(V(sl.pos.x, sl.pos.y - (1 - rise) * 1.2, sl.pos.z), tq, ts3.setScalar(Math.max(0.01, t > s.end ? 1 - (t - s.end) : 1)));
      lib?.put('sentry', tm, (p, q) => { if (p.role === 'head') q.setFromAxisAngle(UP, yaw); });
      if (tp && target) {
        const m = V(sl.pos.x + Math.sin(yaw) * 1.2, sl.pos.y + 1.22, sl.pos.z + Math.cos(yaw) * 1.2);
        tp.y += BUGS[target.kind].size * 0.4;
        this.shots(`s${s.id}${j}`, m, tp, t, 0.06, j * 0.03, 0.4, target.seed);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ dropships + drop pods
  private drawShips(t: number) {
    const R = this.room!, lib = this.lib, fx = this.fx!;
    if (!lib || !R.pads.length) return;
    const mv = activeFrontlineMover;
    const evs = shipEvents(this.plan!.seed, R.pads.length, mv ? mv.departures() : [], t - 40, t + 5);
    for (const pad of R.pads) {
      let e: { at: number } | null = null;
      for (const x of evs) if (x.pad === pad.index && x.at - SHIP.close <= t && t < x.at + SHIP.open + 1) e = x;
      this.ship(pad, e ? t - e.at : -99, t, lib, fx);
    }
  }
  private ship(pad: Pad, dt: number, t: number, lib: UnitLib, fx: SpaceFx) {
    const fwd = pad.fwd;
    const pos = pad.pos.clone();
    let ramp = 1, hover = 1, glow = 0.35, pitch = 0, vis = 1;
    if (dt >= -SHIP.close && dt < 0) { ramp = 1 - smooth((dt + SHIP.close) / 1.6); glow = 0.35 + 0.65 * smooth((dt + SHIP.close) / SHIP.close); }
    else if (dt >= 0 && dt < 3) { ramp = 0; glow = 1; pos.y += 8 * smooth(dt / 3) + Math.sin(dt * 5) * 0.05; }
    else if (dt >= 3 && dt < SHIP.gone) {
      const τ = dt - 3; ramp = 0; glow = 1; hover = 1 - smooth(τ / 2);
      pos.y += 8 + 3.5 * τ + 0.5 * τ * τ; pos.addScaledVector(fwd, 2 * τ + 1.6 * τ * τ); pitch = -0.18 * smooth(τ / 2);
      vis = 1 - smooth((dt - (SHIP.gone - 1.5)) / 1.5);
    } else if (dt >= SHIP.gone && dt < SHIP.arrive) return;
    else if (dt >= SHIP.arrive && dt < SHIP.land) {
      const u = (dt - SHIP.arrive) / (SHIP.land - SHIP.arrive);
      ramp = 0; glow = 1;
      const a = smooth(Math.min(1, u / 0.75));
      const start = pad.pos.clone().addScaledVector(fwd, -170).add(V(0, 75, 0));
      const hov = pad.pos.clone().add(V(0, 7, 0));
      pos.lerpVectors(start, hov, 1 - (1 - a) * (1 - a));
      if (u > 0.75) pos.y = pad.pos.y + 7 * (1 - smooth((u - 0.75) / 0.25));
      hover = smooth((u - 0.5) / 0.3); pitch = 0.2 * (1 - hover);
      vis = smooth(u / 0.1);
    } else if (dt >= SHIP.land && dt < SHIP.open + 1) { ramp = smooth((dt - SHIP.land) / (SHIP.open - SHIP.land)); glow = 0.6; }
    tq.setFromEuler(te.set(pitch, pad.yaw, 0, 'YXZ'));
    tm.compose(pos, tq, ts3.setScalar(Math.max(0.01, vis)));
    lib.put('dropship', tm, (p, q) => {
      if (p.role === 'ramp') q.setFromAxisAngle(V(1, 0, 0), -2.09 * ramp);
      if (p.role === 'engine') q.setFromAxisAngle(V(1, 0, 0), (Math.PI / 2) * hover);
    }, undefined, glow * (0.8 + safeAmp(0.2) * Math.sin(t * 30)));   // (engine glow buzz: < 10 % with the flash limit on)
    if (glow > 0.9 && vis > 0.05) {
      const right = V(Math.cos(pad.yaw), 0, -Math.sin(pad.yaw));
      for (const sd of [-1, 1]) {
        const e = pos.clone().addScaledVector(right, 4.3 * sd).add(V(0, 2.4 - 1.2 * hover, 0)).addScaledVector(fwd, -0.6 - 1.3 * (1 - hover));
        fx.sprite(e, 1.1, 0.5, 1.2, 2.6, 0.8 * vis, SPRITE.glow, sd);
      }
      if (pos.y - pad.pos.y < 9 && this.perf.level < 2) for (let i = 0; i < 3; i++) fx.puff(V(pad.pos.x + Math.sin(t * 3 + i * 2) * 4, pad.pos.y + 0.6, pad.pos.z + Math.cos(t * 3 + i * 2) * 4), 3, 0.45, 0.35, 0.28, 0.35 * (1 - (pos.y - pad.pos.y) / 9), i);
    }
  }

  private drawPods(t: number) {
    const mv = activeFrontlineMover;
    if (!mv) return;
    for (const l of mv.pods()) {
      const door = smooth((t - (l.at + POD.door0 - POD.impact)) / (POD.door1 - POD.door0));
      this.pod('pod', l.pos, l.yaw, l.at, t, l.at + 28, door, l.id);
    }
  }

  // ------------------------------------------------------------------------------------------ board + labels
  private makeBoard() {
    const R = this.room!;
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 576;
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const w = R.board?.width ?? 1.72;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 9 / 16), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    mesh.name = 'hf:board';
    if (R.board) {
      R.board.node.updateWorldMatrix(true, false);
      const p = this.rt!.root.worldToLocal(R.board.node.getWorldPosition(V()));
      mesh.position.copy(p);
      mesh.quaternion.copy(R.board.node.getWorldQuaternion(new THREE.Quaternion()));
      mesh.translateZ(0.075);
    } else mesh.position.set(5.9, 2.15, 0.45);
    this.group.add(mesh);
    this.board = { canvas, tex, mesh, at: 0, key: '' };
  }
  private drawBoard(t: number, nBugs: number, sups: Support[]) {
    const B = this.board;
    if (!B || t - B.at < 0.5) return;
    B.at = t;
    const A = this.plan!.aggression(t);
    const lvl = Math.min(4, Math.floor(A / 0.33));
    const incoming = sups.filter((s) => !s.ambient && t >= s.at - 0.5 && t < s.at + 12).slice(-2);
    const last = this.lastSupport;
    const key = `${lvl}:${Math.round(A * 40)}:${nBugs}:${incoming.map((s) => s.id).join()}:${last?.id}:${Math.floor(t * 2) % 2}`;
    if (key === B.key) return;
    B.key = key;
    const g = B.canvas.getContext('2d')!;
    const W = 1024, H = 576;
    g.fillStyle = '#0b1318'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#f2c230'; g.lineWidth = 10; g.strokeRect(5, 5, W - 10, H - 10);
    g.fillStyle = '#f2c230'; g.fillRect(0, 0, W, 78);
    g.fillStyle = '#111'; g.font = 'bold 50px Arial Black, Arial, sans-serif'; g.fillText('FRONTLINE STATUS', 28, 58);
    g.fillStyle = '#9fe8ff'; g.font = 'bold 34px Arial, sans-serif'; g.fillText('HIVE AGGRESSION', 28, 132);
    // the meter
    const mx = 28, my = 150, mw = W - 56, mh = 54;
    g.fillStyle = '#1b262c'; g.fillRect(mx, my, mw, mh);
    const k = Math.min(1, A / 1.6);
    const grad = g.createLinearGradient(mx, 0, mx + mw, 0);
    grad.addColorStop(0, '#f2c230'); grad.addColorStop(0.55, '#ff7a1a'); grad.addColorStop(1, '#ff2a1a');
    g.fillStyle = grad; g.fillRect(mx, my, mw * k, mh);
    for (let i = 1; i < 5; i++) { g.fillStyle = '#0b1318'; g.fillRect(mx + (mw * i) / 5 - 2, my, 4, mh); }
    g.fillStyle = lvl >= 3 && Math.floor(t * 2) % 2 ? '#ff4a2a' : '#ffffff'; g.font = 'bold 40px Arial Black, Arial, sans-serif';
    g.fillText(AGGRO_NAMES[lvl], 28, 256);
    g.fillStyle = '#cfd8dc'; g.font = '30px Arial, sans-serif';
    g.fillText(`BUGS ON THE FIELD: ${nBugs}`, W - 470, 254);
    g.fillText('Chat stirs the hive. Support the stream to call in strikes.', 28, 300);
    let y = 350;
    const line = (s: string, col: string, size = 34) => { g.fillStyle = col; g.font = `bold ${size}px Arial, sans-serif`; g.fillText(s.slice(0, 52), 28, y); y += size + 12; };
    for (const s of incoming) line(`INCOMING: ${SUPPORT_NAME[s.k]}${s.user ? ` - thanks ${s.user}` : ''}${s.amount ? ` (${s.amount})` : ''}${s.reward ? ` [${s.reward}]` : ''}`, '#ff6a4a');
    if (!incoming.length && last) line(`LAST SUPPORT: ${SUPPORT_NAME[last.k]}${last.user ? ` - ${last.user}` : ''}`, '#f2c230');
    g.fillStyle = '#53fc18'; g.font = 'bold 26px Arial, sans-serif';
    g.fillText('KICK CHANNEL POINTS (Kick only for now): mech - turret - laser', 28, H - 64);
    g.fillText('supply - airstrike - 500kg - barrage - napalm - hellbomb', 28, H - 28);
    B.tex.needsUpdate = true;
  }

  private drawLabels(t: number, sups: Support[]) {
    const show = sups.filter((s) => !s.ambient && t >= s.at + 1.2 && t < s.at + 8).slice(-3);
    while (this.labels.length < show.length) {
      const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 192;
      const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
      sprite.scale.set(16, 3, 1); sprite.renderOrder = 5; this.group.add(sprite);
      this.labels.push({ sprite, canvas, tex, id: '' });
    }
    this.labels.forEach((l, i) => {
      const s = show[i];
      l.sprite.visible = !!s;
      if (!s) return;
      if (l.id !== s.id) {
        l.id = s.id;
        const g = l.canvas.getContext('2d')!;
        g.clearRect(0, 0, 1024, 192);
        g.fillStyle = 'rgba(10,16,20,0.78)'; g.fillRect(0, 20, 1024, 152);
        g.fillStyle = '#f2c230'; g.fillRect(0, 20, 14, 152);
        g.fillStyle = '#f2c230'; g.font = 'bold 58px Arial Black, Arial, sans-serif'; g.fillText(SUPPORT_NAME[s.k], 36, 88);
        g.fillStyle = '#ffffff'; g.font = 'bold 44px Arial, sans-serif';
        g.fillText(`${s.user ? `courtesy of ${s.user}` : 'Super Earth thanks you'}${s.amount ? `  ${s.amount}` : ''}${s.reward ? '  (channel points)' : ''}`.slice(0, 44), 36, 150);
        l.tex.needsUpdate = true;
      }
      const p = s.k === 'mech' ? this.room!.mech?.pos ?? s.target : s.k === 'supply' ? this.room!.supply?.pos ?? s.target : s.k === 'sentry' ? this.room!.sentries[0]?.pos ?? s.target : s.target;
      const near = p.length() < 25;
      l.sprite.position.set(p.x, p.y + (near ? 6 : 16), p.z);
      const d = near ? 0.45 : 1;
      l.sprite.scale.set(16 * d, 3 * d, 1);
      (l.sprite.material as THREE.SpriteMaterial).opacity = smooth((t - s.at - 1.2) / 0.4) * (1 - smooth((t - s.at - 7.2) / 0.8));
    });
  }

  // ------------------------------------------------------------------------------------------ sky, faces, shake, governor
  private unlitSky(rt: SceneRuntime) {
    const made = new Map<THREE.Material, THREE.Material>();
    rt.room.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (Array.isArray(mesh.material) || !/^M_(Sky|Planet)/.test(m.name)) return;
      let rep = made.get(m);
      if (!rep) { rep = new THREE.MeshBasicMaterial({ vertexColors: !!mesh.geometry.getAttribute('color'), fog: false, side: THREE.DoubleSide, depthWrite: /Planet/.test(m.name) }); rep.name = m.name; made.set(m, rep); }
      const before = mesh.material;
      mesh.material = rep;
      if (/Sky/.test(m.name)) mesh.renderOrder = -10;
      this.restoreMats.push(() => { mesh.material = before; });
    });
    this.restoreMats.push(() => { for (const m of made.values()) m.dispose(); });
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
    this.shake = Math.max(0, this.shake - dt * 1.4);
    if (this.rt!.state.mode === 'react') { this.shake = 0; return; }
    const cam = this.rt!.stage.camera, k = this.shake ** 2;
    const r = new Rng(Math.floor(this.now() / 16));
    cam.position.x += r.range(-1, 1) * 0.025 * k; cam.position.y += r.range(-1, 1) * 0.02 * k;
    cam.updateMatrixWorld();
  }
  private governor(dt: number) {
    const P = this.perf;
    const low = (this.rt?.opts.tier ?? 'high') === 'low';
    if (P.avg > 2.2) { P.slowFor += dt; P.goodFor = 0; } else { P.goodFor += dt; P.slowFor = 0; }
    if (P.slowFor > 2.5 && P.level < 2) { P.level++; P.slowFor = 0; }
    if (P.goodFor > 25 && P.level > (low ? 1 : 0)) { P.level--; P.goodFor = 0; }
    if (low && P.level < 1) P.level = 1;
    if (this.forceLevel !== null) P.level = this.forceLevel;
    if (this.fx) this.fx.level = P.level;
  }

  info() { return this.rt ? { bugs: this.bugsNow.length, ms: +this.perf.avg.toFixed(3), level: this.perf.level, aggression: +(this.plan?.aggression(this.now() / 1000 - T0) ?? 0).toFixed(2) } : null; }
  debug() {
    const t = this.now() / 1000 - T0;
    const kinds: Record<string, number> = {};
    for (const b of this.bugsNow) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
    return {
      on: !!this.rt, err: this.loadErr, t: +t.toFixed(2), aggression: +(this.plan?.aggression(t) ?? 0).toFixed(3), chat: this.plan?.chat.length ?? this.pendingChat.length,
      bugs: this.bugsNow.length, kinds, supports: this.plan?.supportsIn(t - 30, t + 30).map((s) => ({ k: s.k, in: +(s.at - t).toFixed(1), user: s.user, ambient: s.ambient })) ?? [],
      perf: { avg: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(2), level: this.perf.level }, fx: this.fx?.counts(), units: this.lib?.counts(), defenders: this.defenders.length,
      clips: this.dstate.map((d) => d.clip), mover: activeFrontlineMover ? { pods: activeFrontlineMover.pods().length, departures: activeFrontlineMover.departures().map((d) => ({ pad: d.pad, in: +(d.at - t).toFixed(1) })) } : null,
    };
  }
}
