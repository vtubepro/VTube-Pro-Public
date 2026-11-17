// Ambient crowd (src/scene/crowd): background characters doing things at ACTIVITY_xx anchors — a band on a stump
// stage, a diving contest, a conga line, arm wrestling, synchronised swimming, a lily-pad race, a canoe, a climber, a
// fire juggler, a fisher who falls in, a DJ, a sleeper in a hammock — plus ambient FX (fireflies, bubbles, smoke, fire).
// Rooms opt in with a scene.json `crowd` key (crowdRoom.ts). Deterministic: seed + wall clock + support events → every
// page shows the same show with no messages. Support events (tips, subs, raids …) make everyone cheer, the band speed
// up, the DJ drop, the sleeper fall out of his hammock, the next dive a mega cannonball, the climber reach the top,
// and the room's neon sign flash. Characters never cover a performer's face or the react screen.
import * as THREE from 'three';
import { govChannel, pageGovernor } from '../../../shared/flashGovernor.ts';
import type { SceneRuntime } from '../SceneRuntime';
import { sceneFileUrl } from '../SceneRuntime';
import { gfxBudget } from '../../stage/gfx/lod';
import { type CrowdActivity, type CrowdRoom, type RoomCrowdConfig, crowdRoomOf } from './crowdRoom';
import { type ActivityPlan, type FxOut, type PlanCtx, type Pose, type Support, TAG, fishBobber, groupTurn, hash32, juggleTorches, newPose, planFor, Rng32, rng, turnWrap } from './crowdPlan';
import { CActor, type CrowdAsset, loadCrowdUnit } from './crowdUnits';
import { CrowdFx } from './crowdFx';
import { CrowdMass, type MassOverride } from './crowdMass';
import './crowdClub';
import { beatClock, epochNow } from '../beatClock';
import { safeAmp } from '../../../shared/flashGovernor.ts';

const TINTS = ['#ffffff', '#e4ffd6', '#fff3c9', '#d8f0ff', '#f0ffe8', '#e8ffd0', '#fffbe0', '#e0fff4'].map((h) => new THREE.Color(h));
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3();
const SUPPORT_KINDS = new Set(['finance', 'sub', 'giftSub', 'membership', 'raid']);

interface Slot { plan: ActivityPlan; role: number; actor: CActor; pose: Pose; groupKey: string | null }
interface Group { key: string; plans: ActivityPlan[]; actors: CActor[] }

export class CrowdScene {
  private signCh = govChannel('support sign');
  private rt: SceneRuntime | null = null;
  private room: CrowdRoom | null = null;
  private cfg: RoomCrowdConfig = {};
  private group = new THREE.Group();
  private fx: CrowdFx | null = null;
  private asset: CrowdAsset | null = null;
  private solo: { plan: ActivityPlan; actors: CActor[] }[] = [];
  private groups: Group[] = [];
  private slots: Slot[] = [];
  private loading = false;
  private loadErr = '';
  private support: Support[] = [];
  private fxOut: FxOut[] = [];
  private faceT = 0;
  private lodT = 0;
  private flashMats: { m: THREE.MeshStandardMaterial; last: number; base: number }[] = [];
  private flashScanned = false;
  private torchBuf: { x: number; y: number; spin: number; lit: boolean }[] = [];
  private perf = { avg: 0, peak: 0 };
  private shieldHold = new Map<CActor, number>();
  /** dense instanced dancers (ACTIVITY_xx activity 'dancefloor', src/scene/crowd/crowdMass.ts) */
  mass: CrowdMass[] = [];
  /** extra planner inputs from room engines (PlanCtx.ext; src/scene/club sets `club`) */
  ext: Record<string, unknown> = {};
  /** room engines steer mass dancers (dance-off rings, crowd-surf hands …): (mass index, dancer index, wall s) */
  massOverride: ((m: number, i: number, t: number) => MassOverride | null) | null = null;
  /** when the last drop was (wall s) — room engines may add their own (a raid's bass drop) */
  dropAt = -Infinity;
  /** the crowd dims with the room's house lights (lighting states) and picks up the show's colour wash */
  private shadeMats: { m: THREE.MeshToonMaterial; base: THREE.Color }[] | null = null;
  private shadeKey = '';
  protect = true;
  /** Test pages: time advances only through update(). */
  manual = false;
  clock = Date.now();
  /** Tests / screenshots: force a rotation group's activity, e.g. { water: 'hop' }. */
  force: Record<string, string> = {};
  now() { return this.manual ? this.clock : Date.now(); }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const cfg = (rt.info as unknown as { crowd?: RoomCrowdConfig }).crowd;
    if (!cfg || cfg.on === false) return;
    const room = crowdRoomOf(rt.root);
    if (!room) return;
    this.rt = rt; this.room = room; this.cfg = cfg;
    this.group = new THREE.Group(); this.group.name = 'crowd';
    rt.root.add(this.group);
    void this.load();
  }

  detach() {
    for (const s of this.slots) s.actor.dispose();
    for (const g of this.groups) for (const a of g.actors) a.dispose();
    for (const s of this.solo) for (const a of s.actors) a.dispose();
    for (const m of this.mass) m.dispose();
    for (const x of this.shadeMats ?? []) x.m.color.copy(x.base);
    this.shadeMats = null; this.shadeKey = ''; this.shadeN = -1; this.shadeRaw[0] = NaN; this.ambSeeds.clear();
    this.slots = []; this.groups = []; this.solo = []; this.mass = [];
    this.fx?.dispose(); this.fx = null;
    this.restoreFlash();
    this.group.removeFromParent();
    this.rt = null; this.room = null; this.asset = null; this.flashMats = []; this.flashScanned = false; this.shieldHold.clear();
  }

  private async load() {
    const rt = this.rt, room = this.room;
    if (!rt || !room || this.loading) return;
    this.loading = true;
    try {
      const url = (f: string) => sceneFileUrl(rt.info.id, f);
      const [asset, atlas] = await Promise.all([
        loadCrowdUnit(url(this.cfg.units ?? 'crowd/frog_crowd.glb')),
        new THREE.TextureLoader().loadAsync(url(this.cfg.fx ?? 'crowd/crowd_fx.png')),
      ]);
      if (this.rt !== rt) return;
      this.asset = asset;
      this.fx = new CrowdFx(atlas);
      this.fx.palette('confetti', ['#ff4fd8', '#9dff3f', '#35e3ff', '#ffd23a']);
      this.fx.palette('note', ['#ffe066', '#9dff8a', '#ff9ae0']);
      this.fx.palette('glow', ['#d8ff5a', '#c6ff7a', '#fff2a0']);
      this.fx.palette('mist', ['#9fb8c8', '#8fa8b8', '#a8c4c0']);
      this.group.add(this.fx.group);
      const h = this.cfg.height ?? 1.0;
      let tintI = 0;
      const mk = () => { const a = new CActor(asset, h, TINTS[tintI++ % TINTS.length]); this.group.add(a.root); return a; };
      // activities without a group run all the time; grouped ones share one set of characters (turns)
      const max = Math.max(1, this.cfg.max ?? 14);
      const byGroup = new Map<string, ActivityPlan[]>();
      const plans = room.acts.filter((a) => a.kind !== 'dancefloor').map((a: CrowdActivity) => planFor(a));
      // dense dancers: GPU instances with baked vertex animation (baked a slice per frame in update())
      for (const a of room.acts.filter((x) => x.kind === 'dancefloor')) {
        const x = a.extras;
        const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
        const keep = typeof x.keepOut === 'string' ? x.keepOut.split(';').map((s) => s.split(',').map(Number)).filter((v) => v.length === 3 && v.every(Number.isFinite)).map(([kx, kz, kr]) => ({ x: kx, z: kz, r: kr })) : [];
        const face = a.named.get('FACE')?.pos ?? a.anchor.pos.clone().add(new THREE.Vector3(Math.sin(a.anchor.yaw), 0, Math.cos(a.anchor.yaw)).multiplyScalar(-20));
        const m = new CrowdMass(asset, { center: a.anchor.pos, rx: n(x.rx, 3), rz: n(x.rz, 2), count: Math.round(n(x.frogs, 30) * Math.max(0.6, Math.min(1.4, gfxBudget().npcDensity))), outfits: a.outfits, seed: hash32(this.cfg.seed ?? 7, a.id), height: this.cfg.height ?? 1, face, keepOut: keep });
        this.mass.push(m); this.group.add(m.group);
      }
      for (const p of plans) {
        if (p.act.group) { const l = byGroup.get(p.act.group) ?? []; l.push(p); byGroup.set(p.act.group, l); }
      }
      let used = 0;
      for (const p of plans.filter((x) => !x.act.group)) {
        if (used + p.n > max) continue;
        this.solo.push({ plan: p, actors: Array.from({ length: p.n }, mk) }); used += p.n;
      }
      for (const [key, ps] of byGroup) {
        ps.sort((a, b) => a.act.order - b.act.order);
        const n = Math.max(...ps.map((p) => p.n));
        if (used + n > max) continue;
        this.groups.push({ key, plans: ps, actors: Array.from({ length: n }, mk) }); used += n;
      }
      try { rt.stage.renderer.compile(rt.stage.scene, rt.stage.camera); } catch { /* optional */ }
    } catch (e) {
      this.loadErr = String((e as Error)?.message ?? e);
      console.warn('[crowd] assets failed', e);
    } finally { this.loading = false; }
  }

  // ------------------------------------------------------------------------------------------ support events
  /** chat feed events (bus / party relay): tips, subs, memberships, raids → the crowd reacts (same on every page: ts-based) */
  onSupport(evs: { kind?: string; ts?: number; id?: string; user?: string; usd?: number; approxUsd?: number; test?: boolean }[], snap: boolean) {
    if (snap) return;
    for (const e of evs as { kind?: string; fkind?: string; ts?: number; id?: string; user?: string; usd?: number; approxUsd?: number }[]) {
      if (!e.kind || !SUPPORT_KINDS.has(e.kind)) continue;
      const ts = typeof e.ts === 'number' && Math.abs(Date.now() - e.ts) < 60000 ? e.ts : Date.now();
      this.addSupport(ts / 1000 + 1.2, e.id ?? String(ts), e.user ?? '', e.usd ?? e.approxUsd ?? 0, e.fkind ?? e.kind);
    }
  }
  private addSupport(at: number, id: string, user: string, usd: number, kind?: string) {
    if (this.support.some((s) => s.id === id)) return;
    // events closer than 4 s merge (a burst of gift subs = one big cheer)
    if (this.support.some((s) => Math.abs(s.at - at) < 4)) return;
    this.support.push({ at, id, user: user.slice(0, 24), usd, kind });
    this.support.sort((a, b) => a.at - b.at);
    if (this.support.length > 24) this.support.shift();
  }
  /** Tests: a support event `inSec` seconds from now. */
  testSupport(user = 'TestViewer', inSec = 0.5, kind?: string, usd = 5) { this.addSupport(this.now() / 1000 + inSec, `test-${Math.floor(this.now())}`, user, usd, kind); }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number) {
    if (this.manual) this.clock += dt * 1000;
    const rt = this.rt, fx = this.fx;
    if (!rt || !fx || !this.asset) return;
    const t0 = performance.now();
    const t = this.now() / 1000;
    const party = ((rt.state as unknown as { lights?: { state?: string } }).lights?.state ?? '') ;
    const ctx: PlanCtx = { seed: this.cfg.seed ?? 7, scale: (this.cfg.height ?? 1) / this.asset.height, water: this.cfg.water ?? 0, support: this.support, party: party === 'preshow' || party === 'outro', ext: this.ext };
    this.fxOut.length = 0;
    fx.begin();
    const cam = rt.stage.camera;
    const turnLen = Math.max(30, this.cfg.turn ?? 150);
    const mid = 0.5 * ctx.scale * this.asset.height / 1.17;
    const lodBias = gfxBudget().lodBias;
    // ---- cull + LOD (5 Hz)
    this.lodT -= dt;
    const doLod = this.lodT <= 0; if (doLod) this.lodT = 0.2;
    const frustum = doLod ? new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)) : null;
    const camPos = cam.getWorldPosition(tv2);
    const tanH = Math.tan(THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov ?? 40) / 2);
    const H = rt.stage.renderer.domElement.height || 720;
    const cull = (a: CActor) => {
      if (!frustum) return;
      a.root.getWorldPosition(tv); tv.y += 0.5;
      const inView = frustum.intersectsSphere(new THREE.Sphere(tv, 1.4));
      a.culled = !inView;
      const px = (1.1 * (this.cfg.height ?? 1)) / (camPos.distanceTo(tv) * tanH * 2) * H * lodBias;
      a.setLod(px > 70 ? 0 : 1);
    };
    // ---- pose every character
    const party2 = ctx.party;
    const poseAll = (plan: ActivityPlan, actors: CActor[], wrap: ((o: Pose, i: number) => void) | null) => {
      const poses = actors.map((_, i) => this.poseBuf(plan, i));
      plan.sample(ctx, t, poses.slice(0, plan.n), this.fxOut);
      for (let i = 0; i < actors.length; i++) {
        const o = poses[i], a = actors[i];
        if (i >= plan.n) { o.hidden = true; }
        else {
          if (wrap) wrap(o, i);
          this.reactions(ctx, t, o, i, party2);
        }
        a.dress(i < plan.n ? plan.outfit(i) : '', o.hidden ? [] : o.props);
        cull(a);
        a.apply(o, mid);
        this.tagFx(a, o, t, i, cam);
      }
    };
    for (const s of this.solo) poseAll(s.plan, s.actors, null);
    for (const g of this.groups) {
      const fi = this.force[g.key] !== undefined ? g.plans.findIndex((p) => p.act.kind === this.force[g.key] || p.act.id === this.force[g.key]) : undefined;
      const gt = groupTurn(ctx.seed, g.key, g.plans.length, t, turnLen, fi);
      const plan = g.plans[gt.active];
      poseAll(plan, g.actors, (o, i) => turnWrap(o, i, gt, plan.water(i), ctx.water, ctx.scale, this.fxOut));
      // extras: juggling torches + the fisher's line
      if (plan.act.kind === 'juggle' && g.actors[0]?.visible && !g.actors[0].shielded) this.torches(ctx, t, g.actors[0], cam);
      if (plan.act.kind === 'fish' && g.actors[0]?.visible && !g.actors[0].shielded && gt.u > 4.5 && gt.u < turnLen - 4.5) {
        if (fishBobber(plan.act, t, tv)) { const tip = g.actors[0].rodTip ? this.group.worldToLocal(g.actors[0].rodTip.getWorldPosition(new THREE.Vector3())) : null; fx.bobber(tv, tip); }
      }
    }
    for (const s of this.solo) {
      if (s.plan.act.kind === 'juggle' && s.actors[0]?.visible) this.torches(ctx, t, s.actors[0], cam);
      if (s.plan.act.kind === 'fish' && s.actors[0]?.visible && fishBobber(s.plan.act, t, tv)) fx.bobber(tv, s.actors[0].rodTip ? this.group.worldToLocal(s.actors[0].rodTip.getWorldPosition(new THREE.Vector3())) : null);
    }
    // ---- support: the DJ's shout-out bubble
    const last = this.support.length ? this.support[this.support.length - 1] : null;
    if (last && t >= last.at && t - last.at < 4.5 && last.user) {
      const dj = this.find('dj');
      if (dj && dj.visible && !dj.shielded) { dj.headTop(tv); tv.y += 0.25; fx.bubble(`BIG UP ${last.user.toUpperCase()}!`, this.group.worldToLocal(tv), 0.42); }
    }
    this.shade(rt);
    // ---- the mass crowd (bake a slice until ready, then one instanced update)
    if (this.mass.length) {
      const now = epochNow(), bc = beatClock;
      const beat = bc.active(now) ? bc.posAt(now) : NaN;
      if (bc.active(now) && bc.dropAt > now - 60000 && bc.dropAt / 1000 > this.dropAt) this.dropAt = bc.dropAt / 1000;
      const lastS = this.support.length ? this.support[this.support.length - 1] : null;
      let budget = 4;
      this.mass.forEach((m, mi) => {
        if (!m.ready) { const b0 = performance.now(); m.bakeStep(Math.max(0.5, budget)); budget -= performance.now() - b0; if (m.ready) { try { rt.stage.renderer.compile(rt.stage.scene, rt.stage.camera); } catch { /* optional */ } } return; }
        m.update({ t, beat: this.manual ? t * 2 : beat, energy: bc.active(now) ? bc.env.e : 0.45, dropAge: t - this.dropAt, cheerAge: lastS ? t - lastS.at : -1, party: ctx.party,
          override: this.massOverride ? (i) => this.massOverride!(mi, i, t) : undefined });
      });
    }
    this.fxRender(t, cam);
    this.ambient(t, cam);
    fx.end();
    this.flash(t);
    // ---- protection (4 Hz)
    this.faceT -= dt;
    if (this.faceT <= 0) { this.faceT = 0.25; this.protectFaces(t); }
    const ms = performance.now() - t0;
    this.perf.avg += (ms - this.perf.avg) * 0.05; this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private shade(rt: SceneRuntime) {
    const L = rt.lights as unknown as { houseLevel?: number; washPalette?: [THREE.Color, THREE.Color]; showDim?: number };
    const house = typeof L.houseLevel === 'number' ? L.houseLevel : 1;
    // a room engine's show taking the room (the club's pack rig, BeatLights.showDim): the crowd's light floor goes
    // with the house - the show's wash lights them, not the room
    const sd = typeof L.showDim === 'number' ? 1 - Math.min(1, Math.max(0, L.showDim)) : 0;
    const lv = Math.min(1, 0.4 - 0.24 * sd + 0.6 * house);
    const wash = L.washPalette && house < 0.8 ? L.washPalette[0] : null;
    const w = wash ? Math.min(0.35, (0.8 - house) * 0.6) + 0.4 * sd : 0;
    let ready = 0;
    for (const m of this.mass) if (m.ready) ready++;
    const n = ready * 1000 + this.solo.length + this.groups.length;
    const sr = this.shadeRaw, wr = wash ? wash.r : 0, wg = wash ? wash.g : 0, wb = wash ? wash.b : 0;
    if (sr[0] === lv && sr[1] === w && sr[2] === n && sr[3] === wr && sr[4] === wg && sr[5] === wb && sr[6] === (wash ? 1 : 0)) return;
    sr[0] = lv; sr[1] = w; sr[2] = n; sr[3] = wr; sr[4] = wg; sr[5] = wb; sr[6] = wash ? 1 : 0;
    const key = `${lv.toFixed(3)}|${wash ? wash.getHexString() : ''}|${w.toFixed(2)}|${n}`;
    if (key === this.shadeKey) return;
    this.shadeKey = key;
    if (!this.shadeMats || this.shadeN !== n) {
      this.shadeN = n;
      const seen = new Set<THREE.Material>(this.shadeMats?.map((x) => x.m) ?? []); const list = this.shadeMats ?? [];
      this.group.traverse((o) => {
        const mm = (o as THREE.Mesh).material; if (!mm) return;
        for (const m of Array.isArray(mm) ? mm : [mm]) if (!seen.has(m) && (m as THREE.MeshToonMaterial).isMeshToonMaterial) { seen.add(m); list.push({ m: m as THREE.MeshToonMaterial, base: (m as THREE.MeshToonMaterial).color.clone() }); }
      });
      this.shadeMats = list;
    }
    // (the show's wash: multiplied into the base colour; under a show that took the room, a tint at the base's
    //  brightness instead - a magenta wash on green frogs reads magenta-lit, not mud)
    for (const s of this.shadeMats) {
      s.m.color.copy(s.base).multiplyScalar(lv);
      if (!wash) continue;
      if (sd > 0) { const y = 0.2126 * s.base.r + 0.7152 * s.base.g + 0.0722 * s.base.b, wy = Math.max(0.05, 0.2126 * wash.r + 0.7152 * wash.g + 0.0722 * wash.b); this.washTmp.copy(wash).multiplyScalar((y * lv) / wy).lerp(this.washTmp2.copy(wash).multiply(s.base), 1 - sd); }
      else this.washTmp.copy(wash).multiply(s.base);
      s.m.color.lerp(this.washTmp, w);
    }
  }
  private shadeN = -1;
  /** shade()'s inputs as last seen (lv, w, n, wash r, g, b, wash?): equal inputs give the same key, so the strings are only built when one moved */
  private shadeRaw = [NaN, 0, 0, 0, 0, 0, 0];
  private ambSeeds = new Map<object, number[]>();
  private ambRng = new Rng32();
  private washTmp = new THREE.Color(); private washTmp2 = new THREE.Color();

  private poseBufs = new Map<string, Pose>();
  private poseBuf(plan: ActivityPlan, i: number) {
    const k = plan.act.id + ':' + i;
    let p = this.poseBufs.get(k);
    if (!p) { p = newPose(); this.poseBufs.set(k, p); }
    p.clip2 = undefined; p.w2 = 0;
    return p;
  }

  /** the characters of a (non-group) activity kind, e.g. the club engine's sign carrier / juggler */
  actorsOf(kind: string): CActor[] {
    for (const s of this.solo) if (s.plan.act.kind === kind) return s.actors;
    return [];
  }

  private find(kind: string): CActor | null {
    for (const s of this.solo) if (s.plan.act.kind === kind) return s.actors[0] ?? null;
    return null;
  }

  /** support cheers + the party (PRESHOW / OUTRO lighting states): standing characters join in */
  private reactions(ctx: PlanCtx, t: number, o: Pose, i: number, party: boolean) {
    if (o.hidden || o.busy || !o.cheer) return;
    for (let k = ctx.support.length - 1; k >= 0; k--) {
      const e = ctx.support[k]; const a = t - e.at;
      if (a >= 0 && a < 3.4) { o.clip = (hash32(e.id, i) % 3) === 0 ? 'clap' : 'cheer'; o.time = a + i * 0.13; o.clip2 = undefined; o.w2 = 0; o.props = o.props.filter((p) => p !== 'jug'); o.tags |= TAG.CONFETTI * (i === 0 ? 1 : 0); return; }
    }
    if (party && o.clip !== 'conga' && o.clip !== 'banjo' && o.clip !== 'washboard' && o.clip !== 'jug') { o.clip = 'dance'; o.time = t + i * 0.23; o.clip2 = undefined; o.w2 = 0; }
  }

  // ------------------------------------------------------------------------------------------ fx
  private tagFx(a: CActor, o: Pose, t: number, i: number, cam: THREE.Camera) {
    const fx = this.fx!;
    if (o.hidden || !a.visible || a.shielded || !o.tags) return;
    a.headTop(tv); this.group.worldToLocal(tv);
    const k = hash32(a.root.id) % 97;
    if (o.tags & TAG.NOTES) {
      const per = 1.1, off = (k % 11) * 0.1;
      for (let n = 0; n < 2; n++) {
        const birth = Math.floor((t - off) / per - n) * per + off, age = t - birth;
        if (age < 0 || age > 2.0) continue;
        const r = rng(hash32(k, Math.round(birth * 20)));
        const side = r() < 0.5 ? -1 : 1;
        const pop = Math.min(1, age / 0.25) * (1 - Math.max(0, (age - 1.4) / 0.6));
        fx.bill(r() < 0.5 ? 'note' : 'note2', tv2.set(tv.x + side * (0.18 + age * 0.22) + 0.06 * Math.sin(age * 5), tv.y + 0.05 + age * 0.42, tv.z + (r() - 0.5) * 0.25), 0.34 * pop, cam, side * 0.25 + 0.2 * Math.sin(age * 4), fx.color('note', Math.floor(r() * 3)));
      }
    }
    if (o.tags & TAG.ZZZ) {
      for (let n = 0; n < 3; n++) {
        const birth = Math.floor(t / 1.4 - n) * 1.4, age = t - birth;
        fx.bill('zzz', tv2.set(tv.x + 0.25 + age * 0.12, tv.y + age * 0.28, tv.z), 0.16 + age * 0.08, cam, 0.15 * Math.sin(age * 2));
      }
    }
    if (o.tags & TAG.STARS) for (let n = 0; n < 3; n++) { const ang = t * 4 + n * 2.09; fx.bill('star', tv2.set(tv.x + Math.cos(ang) * 0.24, tv.y + 0.04 + Math.sin(t * 6 + n) * 0.03, tv.z + Math.sin(ang) * 0.24), 0.12, cam, t * 3); }
    if (o.tags & TAG.SWEAT) fx.bill('sweat', tv2.set(tv.x + 0.24, tv.y - 0.1 - ((t * 1.5 + i * 0.3) % 1) * 0.14, tv.z), 0.1, cam);
    if (o.tags & TAG.BANG) fx.bill('bang', tv2.set(tv.x - 0.12, tv.y + 0.22, tv.z), 0.22 + 0.03 * Math.sin(t * 14), cam);
    if (o.tags & TAG.CARD) fx.bill('card', tv2.set(tv.x, tv.y + 0.3, tv.z), 0.34, cam, 0.1 * Math.sin(t * 5));
    if (o.tags & TAG.HEART) fx.bill('heart', tv2.set(tv.x, tv.y + 0.3 + 0.05 * Math.sin(t * 6), tv.z), 0.3, cam);
    if (o.tags & TAG.CONFETTI) this.confetti(tv2.copy(tv).setY(tv.y + 0.9), t, 0.9, cam, k);
  }

  private confetti(at: THREE.Vector3, t: number, r: number, cam: THREE.Camera, seed: number, n = 14, age0?: number) {
    const fx = this.fx!;
    for (let j = 0; j < n; j++) {
      const rr = rng(hash32(seed, j));
      const ph = age0 !== undefined ? age0 : (t * 0.6 + rr()) % 1;
      const fall = ph * 1.6;
      fx.bill('confetti', tv.set(at.x + (rr() - 0.5) * r * 2 + 0.1 * Math.sin(t * 3 + j), at.y - fall, at.z + (rr() - 0.5) * r * 2), 0.14, cam, t * (2 + rr() * 3), fx.color('confetti', j));
    }
  }

  private fxRender(t: number, cam: THREE.Camera) {
    const fx = this.fx!;
    for (const f of this.fxOut) {
      const a = f.age;
      if (f.kind === 'splash' || f.kind === 'bigsplash') {
        const S = f.size * (f.kind === 'bigsplash' ? 1.4 : 1);
        if (a < 0.6) fx.bill('burst', tv.set(f.pos.x, f.pos.y + 0.35 * S * (0.5 + a), f.pos.z), S * (0.7 + a * 1.4) * (1 - a / 0.7), cam);
        const nd = f.kind === 'bigsplash' ? 18 : 9;
        for (let j = 0; j < nd; j++) {
          const r = rng(hash32(Math.round(f.pos.x * 100), Math.round(f.pos.z * 100), j));
          const ang = r() * Math.PI * 2, sp = (0.8 + r() * 1.4) * S, up = (2.2 + r() * 2.2) * Math.sqrt(S);
          const y = f.pos.y + up * a - 4.9 * a * a;
          if (y < f.pos.y - 0.05 || a > 1.4) continue;
          fx.bill('drop', tv.set(f.pos.x + Math.cos(ang) * sp * a, y, f.pos.z + Math.sin(ang) * sp * a), 0.1 * Math.sqrt(S), cam);
        }
        fx.ring(tv.set(f.pos.x, f.pos.y + 0.012, f.pos.z), S * (0.4 + a * 1.6));
        if (a > 0.3) fx.ring(tv.set(f.pos.x, f.pos.y + 0.013, f.pos.z), S * (a - 0.3) * 1.6);
      } else if (f.kind === 'ripple') fx.ring(tv.set(f.pos.x, f.pos.y, f.pos.z), f.size * (0.5 + a));
      else if (f.kind === 'confetti') this.confetti(f.pos, t, f.size, cam, hash32(Math.round(f.pos.x * 10), Math.round(f.pos.z * 10)), 22, Math.min(0.99, a / 1.6));
    }
  }

  private torches(ctx: PlanCtx, t: number, a: CActor, cam: THREE.Camera) {
    const fx = this.fx!;
    juggleTorches(ctx, t, this.torchBuf);
    const yaw = a.root.rotation.y, s = a.scale * this.asset!.height / 1.17;
    const right = tv2.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    for (const b of this.torchBuf) {
      const p = new THREE.Vector3().copy(a.root.position).addScaledVector(right, b.x * s).addScaledVector(fwd, 0.28 * s);
      p.y += b.y * s;
      const q = new THREE.Quaternion().setFromAxisAngle(right.clone().normalize(), b.spin);
      fx.torch(p, q);
      const tip = new THREE.Vector3(0, 0.27, 0).applyQuaternion(q).add(p);
      fx.bill('fire', tip.setY(tip.y + 0.05), 0.28 * (1 + safeAmp(0.18) * Math.sin(t * 23 + b.x * 10)), cam, Math.sin(t * 9 + b.y) * 0.3);
      fx.bill('glow', tip, 0.55, cam, 0, new THREE.Color(1, 0.55, 0.2));
    }
  }

  /** ambient CROWD_FX_xx emitters: fireflies, bubbles in a glass, smoke wisps, fire */
  private ambient(t: number, cam: THREE.Camera) {
    const fx = this.fx!, room = this.room!;
    const dens = Math.max(0.5, Math.min(1.3, gfxBudget().npcDensity));
    room.fx.forEach((e, ei) => {
      let seeds = this.ambSeeds.get(e); if (!seeds) this.ambSeeds.set(e, seeds = []);   // (hash32(ei, j, kind) is fixed per emitter: once)
      const n = Math.round(e.count * (e.kind === 'fireflies' ? dens : 1));
      for (let j = 0; j < n; j++) {
        const R = this.ambRng; R.seed((seeds[j] ??= hash32(ei, j, e.kind)));
        const a0 = R.next() * Math.PI * 2, rr = Math.sqrt(R.next()) * e.radius, y0 = R.next() * e.height;
        if (e.kind === 'fireflies') {
          const sp = 0.15 + R.next() * 0.25, ph = R.next() * 100;
          const x = e.pos.x + Math.cos(a0) * rr + Math.sin(t * sp + ph) * 0.6;
          const z = e.pos.z + Math.sin(a0) * rr + Math.cos(t * sp * 1.3 + ph) * 0.6;
          const y = e.pos.y + y0 - e.height / 2 + Math.sin(t * sp * 2.1 + ph) * 0.3;
          const blink = Math.max(0, Math.sin(t * (0.8 + R.next() * 1.2) + ph)) ** 3;
          if (blink < 0.05) continue;
          fx.bill('glow', tv.set(x, y, z), 0.09 + 0.12 * blink, cam, 0, fx.color('glow', j));
        } else if (e.kind === 'bubbles') {
          const per = 1.6 + R.next() * 1.4, ph = fract((t + R.next() * 10) / per);
          fx.bill('ring', tv.set(e.pos.x + Math.cos(a0) * rr * 0.9 + 0.03 * Math.sin(t * 5 + j), e.pos.y + ph * e.height, e.pos.z + Math.sin(a0) * rr * 0.9), 0.08 + 0.1 * R.next(), cam);
        } else if (e.kind === 'smoke') {
          const per = 5 + R.next() * 3, ph = fract((t + R.next() * 10) / per);
          fx.bill('smoke', tv.set(e.pos.x + Math.cos(a0) * rr * 0.5 + ph * 0.6 * Math.sin(j), e.pos.y + ph * e.height, e.pos.z + Math.sin(a0) * rr * 0.5), (0.5 + ph * 1.6) * (1 - ph * 0.6), cam, ph * 2 + j);
        } else if (e.kind === 'mist') {
          // low drifting fog banks over the water (big, faint, slow)
          const sp = 0.05 + R.next() * 0.05, ph = R.next() * 100;
          const x = e.pos.x + Math.cos(a0) * rr + Math.sin(t * sp + ph) * 1.5;
          const z = e.pos.z + Math.sin(a0) * rr + Math.cos(t * sp * 0.7 + ph) * 1.2;
          fx.bill('mist', tv.set(x, e.pos.y + y0 * 0.3, z), e.height * (0.8 + 0.5 * R.next()), cam, ph, fx.color('mist', j));
        } else if (e.kind === 'fire') {
          const per = 0.55 + R.next() * 0.3, ph = fract((t + R.next() * 3) / per);
          fx.bill('fire', tv.set(e.pos.x + Math.cos(a0) * rr, e.pos.y + ph * e.height, e.pos.z + Math.sin(a0) * rr), (0.35 + 0.25 * R.next()) * (1 - ph * 0.7) * Math.max(0.3, e.height * 1.4), cam, Math.sin(t * 7 + j) * 0.4);
          if (j === 0) fx.bill('glow', tv.set(e.pos.x, e.pos.y + e.height * 0.3, e.pos.z), 0.9 + 0.1 * Math.sin(t * 17), cam, 0, new THREE.Color(1, 0.5, 0.15));
        }
      }
    });
  }

  // ------------------------------------------------------------------------------------------ the neon sign flashes on support (≤ 2.5 flashes / s)
  private flash(t: number) {
    const e = this.support.length ? this.support[this.support.length - 1] : null;
    const a = e ? t - e.at : 99;
    const on = a >= 0 && a < 2.6;
    if (on && !this.flashScanned) {
      this.flashScanned = true;
      const groups = new Set(this.cfg.flash ?? ['sign', 'neon']);
      const seen = new Set<THREE.Material>();
      this.rt!.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!m || Array.isArray(m) || seen.has(m) || !m.emissive) return;
        const g = /^EMIT_([A-Za-z0-9_-]+?)(?:\.\d+)?$/.exec(m.name)?.[1];
        if (g && groups.has(g)) { seen.add(m); this.flashMats.push({ m, last: NaN, base: m.emissiveIntensity }); }
      });
    }
    if (!this.flashMats.length) return;
    const k = pageGovernor(performance.timeOrigin + performance.now()).step(this.signCh, on ? 1 + 1.8 * (Math.sin(a * Math.PI * 2 * 2.4) > 0 ? 1 : 0.15) * (1 - a / 2.6) : 1);   // (governed)
    for (const f of this.flashMats) {
      if (f.m.emissiveIntensity !== f.last) f.base = f.m.emissiveIntensity;   // the light engine rewrote it this frame
      f.m.emissiveIntensity = f.base * k; f.last = f.m.emissiveIntensity;
    }
  }
  private restoreFlash() { for (const f of this.flashMats) if (f.m.emissiveIntensity === f.last) f.m.emissiveIntensity = f.base; }

  // ------------------------------------------------------------------------------------------ never over a face / the react screen
  private protectFaces(t: number) {
    const rt = this.rt!;
    const all = [...this.solo.flatMap((s) => s.actors), ...this.groups.flatMap((g) => g.actors)];
    if (!this.protect) { for (const a of all) a.shielded = false; return; }
    const cam = rt.stage.camera as THREE.PerspectiveCamera; cam.updateMatrixWorld();
    const camPos = cam.getWorldPosition(new THREE.Vector3());
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const proj = (v: THREE.Vector3) => { tv.copy(v).project(cam); return { x: (tv.x + 1) / 2, y: (1 - tv.y) / 2, ok: tv.z < 1 }; };
    const rects: { x0: number; y0: number; x1: number; y1: number; d: number; front: boolean }[] = [];
    for (const a of rt.actors.values()) {
      if (!a.shown || !a.spot) continue;
      const f = a.faceAt(a.spot);
      if (!f) continue;
      const c = proj(f.center);
      if (!c.ok) continue;
      const dist = camPos.distanceTo(f.center);
      const r = (f.size * 1.45) / (dist * tanH) / 2;
      rects.push({ x0: c.x - r / cam.aspect, x1: c.x + r / cam.aspect, y0: c.y - r * 1.15, y1: c.y + r * 1.3, d: dist, front: false });
    }
    if (rt.state.mode === 'react') {
      const r = rt.layout() === 'solo' ? rt.solo?.rect(cam) : rt.screen?.rect(cam);
      if (r) rects.push({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h, d: 99, front: true });
    }
    for (const a of all) {
      let hit = false;
      if (rects.length && a.visible) {
        const feet = a.root.getWorldPosition(new THREE.Vector3());
        const top = a.headTop(new THREE.Vector3());
        const side = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(0.45 * (this.cfg.height ?? 1));
        const mid = tv2.copy(top).lerp(feet, 0.45);
        const pts = [proj(top.clone().setY(top.y + 0.25)), proj(feet), proj(mid.clone().add(side)), proj(mid.clone().sub(side))];
        const x0 = Math.min(...pts.map((q) => q.x)), x1 = Math.max(...pts.map((q) => q.x)), y0 = Math.min(...pts.map((q) => q.y)), y1 = Math.max(...pts.map((q) => q.y));
        const dn = camPos.distanceTo(feet);
        for (const r of rects) {
          if (x1 < r.x0 || x0 > r.x1 || y1 < r.y0 || y0 > r.y1) continue;
          if (!r.front && dn < r.d - 0.3) continue;        // in front of the performer: a real occluder, keep it
          hit = true; break;
        }
      }
      // hysteresis: stay hidden ≥ 1 s once hidden (no flicker at the edge of a face)
      if (hit) this.shieldHold.set(a, t + 1.0);
      a.shielded = hit || (this.shieldHold.get(a) ?? 0) > t;
      if (a.shielded) a.root.visible = false;
    }
    // mass dancers: the same test on their feet / head boxes
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(0.45 * (this.cfg.height ?? 1));
    const wf = new THREE.Vector3(), wt = new THREE.Vector3();
    for (const m of this.mass) for (const d of m.dancers) {
      let hit = false;
      if (rects.length && !d.hidden) {
        wf.copy(d.pos); this.group.localToWorld(wf);
        m.headTop(d, wt); this.group.localToWorld(wt);
        const mid = tv2.copy(wt).lerp(wf, 0.45);
        const pts = [proj(wt.clone().setY(wt.y + 0.2)), proj(wf), proj(mid.clone().add(side)), proj(mid.clone().sub(side))];
        const x0 = Math.min(...pts.map((q) => q.x)), x1 = Math.max(...pts.map((q) => q.x)), y0 = Math.min(...pts.map((q) => q.y)), y1 = Math.max(...pts.map((q) => q.y));
        const dn = camPos.distanceTo(wf);
        for (const r of rects) {
          if (x1 < r.x0 || x0 > r.x1 || y1 < r.y0 || y0 > r.y1) continue;
          if (!r.front && dn < r.d - 0.3) continue;
          hit = true; break;
        }
      }
      const key = d as unknown as CActor;
      if (hit) this.shieldHold.set(key, t + 1.0);
      d.shield = hit || (this.shieldHold.get(key) ?? 0) > t;
    }
  }

  // ------------------------------------------------------------------------------------------ status
  info() {
    const all = [...this.solo.flatMap((s) => s.actors), ...this.groups.flatMap((g) => g.actors)];
    const t = this.now() / 1000;
    return {
      room: !!this.room, loaded: !!this.asset, loading: this.loading, error: this.loadErr || undefined,
      characters: all.length, visible: all.filter((a) => a.visible && !a.shielded).length, shielded: all.filter((a) => a.shielded).length,
      lod1: all.filter((a) => a.lodLevel === 1).length, culled: all.filter((a) => a.culled).length,
      activities: this.solo.map((s) => s.plan.act.kind),
      mass: this.mass.map((m) => m.info()),
      groups: this.groups.map((g) => { const gt = groupTurn(this.cfg.seed ?? 7, g.key, g.plans.length, t, Math.max(30, this.cfg.turn ?? 150)); return { group: g.key, now: g.plans[gt.active].act.kind, in: +(gt.turn - gt.u).toFixed(0), acts: g.plans.map((p) => p.act.kind) }; }),
      support: this.support.slice(-3).map((s) => ({ at: +(s.at - t).toFixed(1), user: s.user })),
      ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(3),
    };
  }
  debug() { return { info: this.info(), force: this.force, anchors: this.room?.acts.map((a) => ({ id: a.id, kind: a.kind, group: a.group, pts: a.pts.length, named: [...a.named.keys()] })) }; }
}

function fract(x: number) { return x - Math.floor(x); }
