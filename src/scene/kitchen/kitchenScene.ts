// Kitchen (fast-food room): the frog crew works the grill / fries / bags / drinks in the background; random food
// fights end when the manager kicks the office door open, yells and punts frogs across the kitchen; donations fill the
// unrest meter and at the top the crew riots until the freezer guy bursts out and pacifies them; then everyone mops up.
// Deterministic: the host's SceneState.kitchen (seed, epoch, events, unrest) + wall clock → the same kitchen on every
// page. Rooms opt in with KITCHEN_* anchors (kitchenRoom.ts); everything else costs nothing.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime';
import { sceneFileUrl } from '../SceneRuntime';
import type { CamPose } from '../cameraRig';
import { DEFAULT_KITCHEN_STATE, kitchenUnrestAt, type KitchenEventStamp, type RoomKitchenConfig, type SceneKitchenState } from '../../../shared/kitchen';
import { type KitchenRoom, kitchenRoomOf } from './kitchenRoom';
import { type Episode, KitchenPlanner, TAG, hash32, keyAt, rng, sampleTrack, workOf, type Sample } from './kitchenPlan';
import { KActor, loadUnit, type UnitAsset } from './kitchenUnits';
import { FOOD_SPLAT, KitchenFx } from './kitchenFx';

const LOOPED = new Set(['idle', 'flip', 'fries', 'bag', 'assemble', 'drinks', 'walk', 'run', 'duck', 'tumble', 'dazed', 'mop', 'riot', 'pound', 'seethe', 'cheer', 'cower', 'carry',
  'Idle_Loop', 'Walk_Loop', 'Walk_Formal_Loop', 'Sprint_Loop', 'Jog_Fwd_Loop', 'Idle_Talking_Loop', 'Idle_No_Loop', 'Idle_FoldArms_Loop', 'Dance_Loop', 'Slide_Loop',
  'NinjaJump_Idle_Loop', 'Yell', 'Point', 'StompIn', 'Flex']);
const loopOf = (c: string) => LOOPED.has(c);
const TINTS = ['#ffffff', '#e4ffd6', '#fff3c9', '#d8f0ff', '#f0ffe8', '#ffe8e0', '#e8ffe8', '#fffbe0'].map((h) => new THREE.Color(h));
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3();

interface Placed { ep: Episode; start: number }

export class KitchenScene {
  private rt: SceneRuntime | null = null;
  private room: KitchenRoom | null = null;
  private group = new THREE.Group();
  private frogs: KActor[] = [];
  private mgr: KActor | null = null;
  private brute: KActor | null = null;
  private fx: KitchenFx | null = null;
  private planner: KitchenPlanner | null = null;
  private eps = new Map<string, Episode>();
  private loading = false;
  private loadErr = '';
  private samples: (Sample | null)[] = [];
  private cfg: RoomKitchenConfig = {};
  private meter: { tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D; key: string } | null = null;
  private incident: { tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D; key: string } | null = null;
  private signT = 0;
  private faceT = 0;
  private hidden = new Set<KActor>();
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  private alarmMats: THREE.MeshStandardMaterial[] = [];
  private cur: Placed | null = null;
  private lastPlaced: Placed[] = [];
  protect = true;
  /** Test pages: time advances only through update(). */
  manual = false;
  clock = Date.now();
  now() { return this.manual ? this.clock : Date.now(); }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const room = kitchenRoomOf(rt.root, rt.root);
    if (!room || !room.ok) return;
    this.rt = rt; this.room = room;
    this.cfg = ((rt.info as unknown as { kitchen?: RoomKitchenConfig }).kitchen) ?? {};
    this.group = new THREE.Group(); this.group.name = 'kitchen';
    rt.root.add(this.group);
    for (const m of rt.room.emissive) if (m.group === 'alarm') this.alarmMats.push(m.material);
    // signs: canvas textures on the meter / incident planes
    const sign = (mesh: THREE.Mesh | null, w: number, h: number) => {
      if (!mesh) return null;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.flipY = false;   // glTF UV convention
      mesh.material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      // the plane's UVs cover an atlas region: remap to the full canvas
      const uv = mesh.geometry.attributes.uv as THREE.BufferAttribute | undefined;
      if (uv) {
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (let i = 0; i < uv.count; i++) { u0 = Math.min(u0, uv.getX(i)); u1 = Math.max(u1, uv.getX(i)); v0 = Math.min(v0, uv.getY(i)); v1 = Math.max(v1, uv.getY(i)); }
        const g = mesh.geometry.clone(); const u2 = g.attributes.uv as THREE.BufferAttribute;
        for (let i = 0; i < u2.count; i++) u2.setXY(i, (u2.getX(i) - u0) / Math.max(1e-6, u1 - u0), (u2.getY(i) - v0) / Math.max(1e-6, v1 - v0));
        mesh.geometry = g;
      }
      return { tex, ctx: c.getContext('2d')!, key: '' };
    };
    this.meter = sign(room.meter, 1024, 512);
    this.incident = sign(room.incident, 512, 512);
    const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
    this.prevOverride = hook.cameraOverride;
    this.myOverride = (aspect: number) => this.shot() ?? this.prevOverride?.(aspect) ?? null;
    hook.cameraOverride = this.myOverride;
    void this.load();
  }

  detach() {
    const rt = this.rt;
    if (rt) {
      const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
      if (hook.cameraOverride === this.myOverride) hook.cameraOverride = this.prevOverride;
      const r = this.room;
      if (r) {
        for (const d of [r.doorOffice, r.doorFreezer]) if (d) d.node.rotation.copy(d.baseRot);
        if (r.trash && r.trashBase) { r.trash.position.copy(r.trashBase.pos); r.trash.rotation.copy(r.trashBase.rot); }
      }
    }
    for (const a of [...this.frogs, this.mgr, this.brute]) a?.dispose();
    this.frogs = []; this.mgr = null; this.brute = null;
    this.fx?.dispose(); this.fx = null;
    this.group.removeFromParent();
    this.eps.clear(); this.alarmMats = []; this.meter = null; this.incident = null;
    this.rt = null; this.room = null; this.planner = null; this.cur = null; this.lastPlaced = [];
    this.prevOverride = null; this.myOverride = null;
  }

  private async load() {
    const rt = this.rt, room = this.room;
    if (!rt || !room || this.loading) return;
    this.loading = true;
    try {
      const dir = this.cfg.npc ?? 'npc';
      const url = (f: string) => sceneFileUrl(rt.info.id, `${dir}/${f}`);
      const [frog, mgr, brute, atlas] = await Promise.all([
        loadUnit(url('frog_crew.glb'), 'frog'), loadUnit(url('manager.glb'), 'mgr'), loadUnit(url('brute.glb'), 'brute'),
        new THREE.TextureLoader().loadAsync(url('fx_atlas.png')),
      ]);
      if (this.rt !== rt) return;
      const F = Math.min(8, room.stations.length);
      const fh = this.cfg.frogHeight ?? 1.12;
      for (let i = 0; i < F; i++) { const a = new KActor(frog, fh, TINTS[i % TINTS.length]); this.frogs.push(a); this.group.add(a.root); }
      this.mgr = new KActor(mgr, this.cfg.managerHeight ?? 1.86); this.group.add(this.mgr.root);
      this.brute = new KActor(brute, this.cfg.bruteHeight ?? 1.9); this.group.add(this.brute.root);
      this.fx = new KitchenFx(atlas); this.group.add(this.fx.group);
      const durOf = (u: UnitAsset) => (c: string) => u.clips.get(c)?.duration ?? 0;
      const dm = durOf(mgr), db = durOf(brute), df = durOf(frog);
      this.planner = new KitchenPlanner({ room, frogs: F, frogScale: fh / 1.372, dur: (who, c) => (who === 'mgr' ? dm(c) : who === 'brute' ? db(c) : df(c)) });
      try { rt.stage.renderer.compile(rt.stage.scene, rt.stage.camera); } catch { /* optional */ }
    } catch (e) {
      this.loadErr = String((e as Error)?.message ?? e);
      console.warn('[kitchen] assets failed', e);
    } finally { this.loading = false; }
  }

  private get st(): SceneKitchenState { return (this.rt?.state as unknown as { kitchen?: SceneKitchenState } | undefined)?.kitchen ?? DEFAULT_KITCHEN_STATE; }

  // ------------------------------------------------------------------------------------------ the schedule
  private episode(kind: 'foodfight' | 'riot' | 'manager', id: string): Episode {
    let ep = this.eps.get(id);
    if (!ep) {
      const seed = this.st.seed;
      ep = kind === 'riot' ? this.planner!.planRiot(id, seed) : this.planner!.planFight(id, seed, kind === 'foodfight');
      this.eps.set(id, ep);
      if (this.eps.size > 24) this.eps.delete(this.eps.keys().next().value!);
    }
    return ep;
  }

  /** Episodes around `now` (ms): events first (queued, never overlapping), then the random fights that fit between. */
  private placed(now: number): Placed[] {
    const st = this.st;
    const out: Placed[] = [];
    const evs = st.events.filter((e) => e.k === 'foodfight' || e.k === 'riot' || e.k === 'manager').sort((a, b) => a.at - b.at);
    let busyUntil = 0;
    for (const e of evs) {
      const ep = this.episode(e.k as 'foodfight' | 'riot' | 'manager', `ev:${e.id}`);
      if (e.user) ep.user = e.user; if (e.amount) ep.amount = e.amount;
      const start = Math.max(e.at, busyUntil + 800);
      out.push({ ep, start }); busyUntil = start + ep.dur * 1000;
    }
    if (st.on && st.fights && st.epoch > 0) {
      const slot = (240 / Math.max(0.25, st.freq)) * 1000;
      const k0 = Math.floor((now - st.epoch) / slot);
      for (let k = k0 - 1; k <= k0 + 1; k++) {
        if (k < 0) continue;
        const r = rng(hash32(st.seed, k, 'slot'));
        if (r() > 0.72) continue;
        const start = st.epoch + (k + 0.12 + r() * 0.5) * slot;
        const ep = this.episode('foodfight', `slot:${st.seed}:${k}`);
        const end = start + ep.dur * 1000;
        if (out.some((p) => start < p.start + p.ep.dur * 1000 + 800 && end + 800 > p.start)) continue;
        out.push({ ep, start });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number) {
    if (this.manual) this.clock += dt * 1000;
    const rt = this.rt, room = this.room;
    if (!rt || !room || !this.planner || !this.fx) return;
    const now = this.now();
    const st = this.st;
    const list = this.placed(now);
    this.lastPlaced = list;
    const cur = list.find((p) => now >= p.start && now < p.start + p.ep.dur * 1000) ?? null;
    this.cur = cur;
    const t = cur ? (now - cur.start) / 1000 : 0;
    const fx = this.fx;
    fx.begin();
    const cam = rt.stage.camera;
    const F = this.frogs.length;
    const unrest = kitchenUnrestAt(st, now);
    const level = Math.min(1, unrest / Math.max(1, st.riotAt));
    // ---- actors
    for (let i = 0; i < F; i++) {
      const s = cur ? sampleTrack(cur.ep.tracks[i], t) : this.work(i, now, level);
      this.samples[i] = s;
      if (s) this.frogs[i].apply(s, loopOf);
    }
    for (const [k, a] of [[F, this.mgr], [F + 1, this.brute]] as [number, KActor | null][]) {
      if (!a) continue;
      const s = cur ? sampleTrack(cur.ep.tracks[k], t) : null;
      this.samples[k] = s;
      if (s) a.apply(s, loopOf); else { a.root.visible = false; a.visible = false; }
    }
    // ---- doors, trash, alarm, soft-serve
    const d = (door: KitchenRoom['doorOffice'], v: number) => { if (door) { door.node.rotation.copy(door.baseRot); door.node.rotation.y += door.sign * door.angle * v; } };
    d(room.doorOffice, cur ? keyAt(cur.ep.office, t, 0) : 0);
    d(room.doorFreezer, cur ? keyAt(cur.ep.freezer, t, 0) : 0);
    if (room.trash && room.trashBase) {
      const k = cur ? keyAt(cur.ep.trash, t, 0) : 0;
      room.trash.rotation.copy(room.trashBase.rot); room.trash.rotation.x += (Math.PI / 2) * k;
      room.trash.position.copy(room.trashBase.pos); room.trash.position.y += 0.25 * k; room.trash.position.z += 0.25 * k;
    }
    const alarmOn = !!(cur?.ep.alarm && t >= cur.ep.alarm[0] && t < cur.ep.alarm[1]);
    const pulse = alarmOn ? 0.5 + 0.5 * Math.sin(now / 140) : 0;
    fx.alarm.intensity = alarmOn ? 6 + 10 * pulse : 0;
    for (const m of this.alarmMats) m.emissiveIntensity = alarmOn ? 1 + 5 * pulse : 0.3;
    for (const a of room.alarms) a.rotation.y = alarmOn ? now / 180 : 0;
    if (cur?.ep.softserve && room.softserve && t > cur.ep.softserve[0] - 0.1 && t < cur.ep.softserve[1] + 1.5) {
      const [a0, a1] = cur.ep.softserve;
      for (let k = 0; k < 150; k++) {
        const born = a0 + k * ((a1 - a0) / 150);
        const age = t - born;
        if (age < 0 || age > 1.3) continue;
        const r = rng(hash32(cur.ep.id, 'cream', k));
        const vx = (r() - 0.5) * 1.6, vz = 0.6 + r() * 1.4, vy = 2.4 + r() * 1.6;
        tv.set(room.softserve.x + vx * age, room.softserve.y + vy * age - 4.9 * age * age, room.softserve.z + vz * age);
        if (tv.y < 0.02) tv.y = 0.02;
        fx.creamAt(tv, 0.9 + r() * 0.8);
      }
    }
    // ---- throws in flight
    if (cur) {
      for (const th of cur.ep.throws) {
        if (t < th.tr || t > th.ta) continue;
        const u = (t - th.tr) / Math.max(0.01, th.ta - th.tr);
        tv.copy(th.from).lerp(th.to, u); tv.y += 4 * th.h * u * (1 - u);
        const axis = tv2.copy(th.to).sub(th.from).cross(new THREE.Vector3(0, 1, 0)).normalize();
        fx.foodAt(th.food, tv, u * 9 + th.food, axis.lengthSq() > 0 ? axis : tv2.set(1, 0, 0), 1.6);
      }
      // splats (appear, then shrink away while mopped / drip off the ceiling)
      cur.ep.splats.forEach((s, k) => {
        if (t < s.t) return;
        const grow = Math.min(1, (t - s.t) / 0.12);
        const clean = t < s.c0 ? 1 : t > s.c1 ? 0 : 1 - (t - s.c0) / Math.max(0.01, s.c1 - s.c0);
        const r = rng(hash32(cur.ep.id, 'sp', k));
        fx.splatAt(s.kind, s.pos, s.normal, s.size * grow * clean, r() * Math.PI * 2);
      });
      for (const p of cur.ep.puffs) {
        const age = t - p.t;
        if (age < 0 || age > 0.9) continue;
        const n = p.kind === 'frost' ? 9 : 4;
        for (let k = 0; k < n; k++) {
          const r = rng(hash32(cur.ep.id, 'pf', p.t, k));
          tv.set(p.pos.x + (r() - 0.5) * p.size * (0.4 + age), p.pos.y + (r() - 0.3) * p.size * 0.6 + age * 0.3, p.pos.z + (r() - 0.5) * p.size * (0.4 + age));
          if (p.kind === 'sauce') fx.bill('puff', tv, 0.25 * (1 - age), cam);
          else fx.bill('puff', tv, p.size * (0.35 + age * 0.7) * (1 - age / 0.9), cam, r() * 6);
        }
      }
      for (const b of cur.ep.bubbles) {
        if (t < b.t0 || t > b.t1) continue;
        const a = b.actor < F ? this.frogs[b.actor] : b.actor === F ? this.mgr : this.brute;
        if (!a || !a.visible || this.hidden.has(a)) continue;
        a.headTop(tv); tv.y += 0.12;
        fx.bubble(b.text, tv, !!b.loud, b.loud ? 0.42 : 0.3);
      }
    } else {
      // stir: a donation makes one frog seethe (+ a bubble with the supporter)
      for (const e of st.events) {
        if (e.k !== 'stir' || now < e.at || now > e.at + 3500 || !F) continue;
        const i = hash32(e.id) % F;
        const a = this.frogs[i];
        if (!a.visible) continue;
        a.headTop(tv); tv.y += 0.12;
        fx.bubble(e.user ? `${e.user} ${e.amount ?? ''} >:(` : '>:(', tv, false, 0.26);
      }
    }
    // ---- per-actor billboards (stars, sweat, steam, anger)
    const secs = now / 1000;
    for (let i = 0; i < F + 2; i++) {
      const s = this.samples[i]; const a = i < F ? this.frogs[i] : i === F ? this.mgr : this.brute;
      if (!s || !a || !a.visible || this.hidden.has(a)) continue;
      a.headTop(tv);
      if (s.tags & TAG.STARS) for (let k = 0; k < 3; k++) { const ang = secs * 4 + k * 2.09; fx.bill('star', tv2.set(tv.x + Math.cos(ang) * 0.22, tv.y + 0.02 + Math.sin(secs * 6 + k) * 0.03, tv.z + Math.sin(ang) * 0.22), 0.11, cam, secs * 3); }
      if (s.tags & TAG.SWEAT) fx.bill('sweat', tv2.set(tv.x + 0.2, tv.y - 0.05 - ((secs * 1.5 + i * 0.3) % 1) * 0.12, tv.z), 0.09, cam);
      if (s.tags & TAG.ANGER) fx.bill('anger', tv2.set(tv.x - 0.18, tv.y + 0.05, tv.z), 0.12 + 0.02 * Math.sin(secs * 12), cam);
      if (s.tags & TAG.RAGE || (!cur && level > 0.6 && i < F)) fx.bill('steam', tv2.set(tv.x, tv.y + 0.12 + ((secs * 0.8 + i * 0.4) % 1) * 0.1, tv.z), 0.22, cam);
    }
    fx.end();
    // ---- signs + face protection (4 Hz)
    this.signT -= dt;
    if (this.signT <= 0) { this.signT = 0.25; this.drawSigns(now, unrest, level, list, cur, t); }
    this.faceT -= dt;
    if (this.faceT <= 0) { this.faceT = 0.25; this.protectFaces(); }
    for (const a of this.hidden) a.root.visible = false;
  }

  /** The crew's normal shift (no episode): working at their stations; grumpy / seething as the meter fills. */
  private work(i: number, now: number, level: number): Sample {
    const st = this.room!.stations[i % this.room!.stations.length];
    const secs = (now - (this.st.epoch || 0)) / 1000;
    const [clip, held] = workOf(st.kind);
    let c = clip, tags = 0;
    const win = Math.floor(secs / 7);
    const r = rng(hash32(this.st.seed, i, win, 'mood'));
    if (level > 0.25 && r() < (level - 0.15) * 0.7) { c = 'seethe'; tags = TAG.ANGER; }
    else if (r() < 0.06) c = 'idle';
    for (const e of this.st.events) {
      if (e.k === 'stir' && now >= e.at && now < e.at + 3500 && hash32(e.id) % this.frogs.length === i) { c = 'seethe'; tags = TAG.ANGER; }
    }
    return { pos: st.pos, yaw: st.yaw, hidden: false, clip: c, time: secs + i * 0.37, prev: null, prevTime: 0, w: 1, over: null, overTime: 0, overW: 0,
      held: c === clip ? held : undefined, tags, spin: 0, spinAxis: null };
  }

  // ------------------------------------------------------------------------------------------ signs
  private drawSigns(now: number, unrest: number, level: number, list: Placed[], cur: Placed | null, t: number) {
    const st = this.st;
    if (this.meter) {
      const riot = cur?.ep.kind === 'riot';
      const pacified = riot && t > cur!.ep.climax;
      const lastStir = [...st.events].reverse().find((e) => e.k === 'stir' && e.at <= now && now - e.at < 60000);
      const label = riot ? (pacified ? 'PACIFIED' : 'RIOT!!!') : ['CALM', 'GRUMPY', 'SPICY', 'UNHINGED', 'RIOT'][Math.min(4, Math.floor(level * 5))];
      const blink = riot && !pacified ? Math.floor(now / 300) % 2 : 0;
      const key = `${label}|${level.toFixed(3)}|${lastStir?.id ?? ''}|${blink}|${cur?.ep.user ?? ''}`;
      if (key !== this.meter.key) {
        this.meter.key = key;
        const g = this.meter.ctx, W = 1024, H = 512;
        g.fillStyle = '#27251f'; g.fillRect(0, 0, W, H);
        g.strokeStyle = '#ffc72c'; g.lineWidth = 16; g.strokeRect(8, 8, W - 16, H - 16);
        g.fillStyle = '#ffc72c'; g.font = '900 82px Impact, "Arial Black", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
        g.fillText('FROG UNREST LEVEL', W / 2, 26);
        const cols = ['#58b83a', '#b9d433', '#ffc72c', '#ff8a1a', '#e2261c'];
        const x0 = 60, w = (W - 120) / 5;
        for (let k = 0; k < 5; k++) { g.fillStyle = cols[k]; g.globalAlpha = (k + 0.5) / 5 <= Math.max(level, riot ? 1 : 0) + 0.1 ? 1 : 0.25; g.fillRect(x0 + k * w + 5, 150, w - 10, 110); }
        g.globalAlpha = 1;
        const nx = x0 + (riot ? 1 : level) * (W - 120);
        g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(nx, 140); g.lineTo(nx - 22, 110); g.lineTo(nx + 22, 110); g.closePath(); g.fill();
        g.fillStyle = riot ? (blink ? '#ff2a1a' : '#ffffff') : cols[Math.min(4, Math.floor(level * 5))];
        g.font = '900 96px Impact, "Arial Black", sans-serif';
        g.fillText(label, W / 2, 285);
        g.font = '700 40px Arial, sans-serif'; g.fillStyle = '#ffe8b0';
        const sub = riot ? (cur?.ep.user ? `RIOT sponsored by ${cur.ep.user}${cur.ep.amount ? ' (' + cur.ep.amount + ')' : ''}` : 'THE CREW HAS SNAPPED') :
          lastStir ? `+${lastStir.amount ?? ''} from ${lastStir.user ?? 'chat'}` : `$${unrest.toFixed(2)} / $${st.riotAt.toFixed(0)} until RIOT`;
        g.fillText(sub, W / 2, 410);
        this.meter.tex.needsUpdate = true;
      }
    }
    if (this.incident) {
      const past = list.filter((p) => p.start <= now);
      const last = past.length ? past[past.length - 1].start : (st.epoch || now);
      const mins = cur ? 0 : Math.max(0, Math.floor((now - last) / 60000));
      const key = String(mins);
      if (key !== this.incident.key) {
        this.incident.key = key;
        const g = this.incident.ctx, W = 512, H = 512;
        g.fillStyle = '#1d5fa8'; g.fillRect(0, 0, W, H);
        g.strokeStyle = '#fff'; g.lineWidth = 14; g.strokeRect(7, 7, W - 14, H - 14);
        g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'top';
        g.font = '900 44px Impact, "Arial Black", sans-serif'; g.fillText('THIS KITCHEN HAS GONE', W / 2, 30);
        g.fillStyle = '#fff'; g.fillRect(106, 100, 300, 220);
        g.fillStyle = '#d81f26'; g.font = '900 180px Impact, "Arial Black", sans-serif'; g.fillText(String(Math.min(999, mins)), W / 2, 112);
        g.fillStyle = '#fff'; g.font = '900 50px Impact, "Arial Black", sans-serif';
        g.fillText('MINUTES WITHOUT', W / 2, 345); g.fillText('A FROG INCIDENT', W / 2, 410);
        this.incident.tex.needsUpdate = true;
      }
    }
  }

  // ------------------------------------------------------------------------------------------ camera (riots only)
  private shot(): { key: string; pose: CamPose; secs: number } | null {
    const rt = this.rt, cur = this.cur;
    if (!rt || !cur || cur.ep.kind !== 'riot' || !this.st.riotCam || rt.state.mode === 'react') return null;
    const t = (this.now() - cur.start) / 1000;
    const sh = cur.ep.shots.find(([a, b]) => t >= a && t < b);
    if (!sh) return null;
    const c = rt.room.cameras.get(sh[2]);
    if (!c) return null;
    return { key: `kit:${cur.ep.id}:${sh[2]}:${sh[0]}`, pose: { position: c.position.clone(), quaternion: c.quaternion.clone(), fov: c.fov }, secs: 0 };
  }

  // ------------------------------------------------------------------------------------------ never over a face / the react screen
  private protectFaces() {
    const rt = this.rt!;
    this.hidden.clear();
    if (!this.protect) return;
    const cam = rt.stage.camera; cam.updateMatrixWorld();
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
      const r = (f.size * 1.3) / (dist * tanH) / 2;
      rects.push({ x0: c.x - r / cam.aspect, x1: c.x + r / cam.aspect, y0: c.y - r * 1.1, y1: c.y + r * 1.25, d: dist, front: false });
    }
    if (rt.state.mode === 'react') {
      const r = rt.layout() === 'solo' ? rt.solo?.rect(cam) : rt.screen?.rect(cam);
      if (r) rects.push({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h, d: 99, front: true });
    }
    if (!rects.length) return;
    for (const a of [...this.frogs, this.mgr, this.brute]) {
      if (!a || !a.visible) continue;
      const feet = a.root.getWorldPosition(new THREE.Vector3());
      const top = a.headTop(new THREE.Vector3());
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(0.32 * a.scale * (a.asset.who === 'frog' ? 1.5 : 1));
      const pts = [proj(top), proj(feet), proj(tv2.copy(top).lerp(feet, 0.4).add(side)), proj(tv2.copy(top).lerp(feet, 0.4).sub(side))];
      const x0 = Math.min(...pts.map((q) => q.x)), x1 = Math.max(...pts.map((q) => q.x)), y0 = Math.min(...pts.map((q) => q.y)), y1 = Math.max(...pts.map((q) => q.y));
      const dn = camPos.distanceTo(feet);
      for (const r of rects) {
        if (x1 < r.x0 || x0 > r.x1 || y1 < r.y0 || y0 > r.y1) continue;
        if (!r.front && dn < r.d - 0.3) continue;       // in front of the performer: a real occluder, keep it
        this.hidden.add(a); break;
      }
    }
  }

  // ------------------------------------------------------------------------------------------ status
  info() {
    const cur = this.cur;
    const now = this.now();
    return {
      room: !!this.room, loaded: !!this.planner, loading: this.loading, error: this.loadErr || undefined,
      frogs: this.frogs.length, episode: cur ? { kind: cur.ep.kind, t: +((now - cur.start) / 1000).toFixed(1), dur: +cur.ep.dur.toFixed(1) } : null,
      next: this.lastPlaced.filter((p) => p.start > now).map((p) => ({ kind: p.ep.kind, in: +((p.start - now) / 1000).toFixed(0) }))[0] ?? null,
      unrest: +kitchenUnrestAt(this.st, now).toFixed(2), riotAt: this.st.riotAt,
    };
  }

  debug() {
    return { info: this.info(), hidden: this.hidden.size, eps: [...this.eps.keys()], placed: this.lastPlaced.map((p) => ({ id: p.ep.id, kind: p.ep.kind, start: p.start, dur: p.ep.dur })) };
  }

  /** Tests: plan an episode by kind and play it from `at` seconds in (manual clock). */
  testEpisode(kind: 'foodfight' | 'riot' | 'manager', at = 0, user?: string) {
    const st = this.st;
    const ev: KitchenEventStamp = { k: kind, at: this.now() - at * 1000, id: `test-${kind}-${Math.floor(this.now())}`, ...(user ? { user, amount: '$50.00' } : {}) };
    (this.rt!.state as unknown as { kitchen: SceneKitchenState }).kitchen = { ...st, events: [...st.events, ev] };
  }
}
