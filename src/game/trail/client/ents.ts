// The Trail — client entity views: the host's entities (wagon, props, animals, NPCs, platforms, players) with snapshot
// interpolation (render ~100 ms behind the newest snapshot, lerp / slerp; own player: newest + extrapolation).
import * as THREE from 'three';
import type { EntInfo, EntSnap, Snapshot } from '../../../../shared/trail/wire.ts';
import { F } from '../../../../shared/trail/wire.ts';
import { buildAnimal, buildNpc, buildProp, buildWagon, type WagonArt } from './art.ts';
import { disposeTree, labelSprite, toon, unitBox } from './kit.ts';
import { loadThemeGlb, loadThemePart } from './assets.ts';
import type { World3D } from './world3d.ts';

export interface Sample { t: number; p: THREE.Vector3; q: THREE.Quaternion; flags: number; yaw: number; pitch: number; anim: number; speed: number; hold: number }
export class EntView {
  obj: THREE.Object3D | null = null;
  buf: Sample[] = [];
  cur: Sample;
  wagon?: WagonArt;
  tag?: THREE.Sprite;
  lastSpin = 0;
  /** trailart's animated models (draft animals, hunting animals). */
  mixer?: THREE.AnimationMixer; actions?: Map<string, THREE.AnimationAction>; clip = '';
  wheelBase?: Map<THREE.Object3D, THREE.Quaternion>;
  constructor(public info: EntInfo) {
    this.cur = { t: 0, p: new THREE.Vector3(), q: new THREE.Quaternion(), flags: 0, yaw: 0, pitch: 0, anim: 0, speed: 0, hold: 0 };
  }
  push(t: number, s: EntSnap, ox = 0, oz = 0) {
    const smp: Sample = { t, p: new THREE.Vector3(s.p[0] + ox, s.p[1], s.p[2] + oz), q: new THREE.Quaternion(...s.q), flags: s.flags, yaw: s.yaw ?? 0, pitch: s.pitch ?? 0, anim: s.anim ?? 0, speed: s.speed ?? 0, hold: s.hold ?? 0 };
    const b = this.buf;
    if (b.length && t <= b[b.length - 1].t) { if (t === b[b.length - 1].t) b[b.length - 1] = smp; return; }
    b.push(smp);
    if (s.ack !== undefined) this.ack = s.ack;
    if (b.length > 24) b.shift();
    if (!this.cur.t) { this.cur.p.copy(smp.p); this.cur.q.copy(smp.q); setFrom(this.cur, smp.t, smp, smp, 0); }
  }
  /** Sample at host time `t` (interpolate; hold the last beyond the buffer, short extrapolation for `lead`). No allocations. */
  sample(t: number, lead = false) {
    const b = this.buf;
    if (!b.length) return;
    const c = this.cur;
    if (lead || t >= b[b.length - 1].t) {
      const a = b[b.length - 1], p = b.length > 1 ? b[b.length - 2] : null;
      c.p.copy(a.p); c.q.copy(a.q);
      if (lead && p && a.t > p.t) { const k = Math.min(0.12, Math.max(0, t - a.t)); c.p.addScaledVector(v1.copy(a.p).sub(p.p).divideScalar(a.t - p.t), k); }
      setFrom(c, t, a, a, 0);
      return;
    }
    if (b.length === 1 || t <= b[0].t) { const a0 = b[0]; c.p.copy(a0.p); c.q.copy(a0.q); setFrom(c, t, a0, a0, 0); return; }
    let i = b.length - 2;
    while (i > 0 && b[i].t > t) i--;
    const a = b[i], z = b[i + 1];
    const k = z.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (z.t - a.t))) : 1;
    if (a.p.distanceToSquared(z.p) > 9) { c.p.copy(z.p); c.q.copy(z.q); }
    else { c.p.lerpVectors(a.p, z.p, k); c.q.slerpQuaternions(a.q, z.q, k); }
    setFrom(c, t, a, z, k);
  }
  /** Newest host velocity estimate (m/s) from the last two samples. */
  velocity(out: THREE.Vector3): THREE.Vector3 {
    const b = this.buf;
    if (b.length < 2) return out.set(0, 0, 0);
    const a = b[b.length - 2], z = b[b.length - 1];
    return out.copy(z.p).sub(a.p).divideScalar(Math.max(1e-3, z.t - a.t));
  }
  /** Players: the low byte of the last input seq the host applied (from the newest sample). */
  ack = -1;
}
function setFrom(c: Sample, t: number, a: Sample, z: Sample, k: number) {
  const yawD = Math.atan2(Math.sin(z.yaw - a.yaw), Math.cos(z.yaw - a.yaw));
  c.t = t; c.flags = k < 0.5 ? a.flags : z.flags; c.yaw = a.yaw + yawD * k; c.pitch = a.pitch + (z.pitch - a.pitch) * k;
  c.anim = z.anim; c.speed = a.speed + (z.speed - a.speed) * k; c.hold = z.hold;
}
const v1 = new THREE.Vector3();
const qx = new THREE.Quaternion(), X = new THREE.Vector3(1, 0, 0);

export class Ents {
  readonly map = new Map<number, EntView>();
  /** Host-clock estimate: offset = host time − local time (s), min-filtered. */
  private offset = NaN;
  private offsets: number[] = [];
  /** Interpolation delay (s): adapts to how often + how evenly snapshots arrive (60 Hz local ≈ 30 ms, 20 Hz net ≈ 100 ms). */
  delay = 0.1;
  private lastArrive = 0;
  private gap = 0.05;
  private gapJit = 0.01;
  private byPlayer = new Map<string, EntView>();
  onPlayerEnt: (v: EntView, added: boolean) => void = () => {};

  constructor(private world: World3D, public theme: string) {}

  clear() { for (const v of [...this.map.values()]) this.remove(v); }
  setAll(ents: EntInfo[]) { this.clear(); this.spawn(ents); this.origin = null; this.originTick = -1; }
  /** v2 journey: the floating origin this view's positions are relative to (null: not on the journey). */
  origin: [number, number] | null = null;
  private originTick = -1;
  /** The origin moved: everything local shifted by (dx, dz) — the view shifts avatars, camera, terrain. */
  onRebase: ((dx: number, dz: number) => void) | null = null;
  spawn(ents: EntInfo[]) {
    for (const info of ents) {
      const old = this.map.get(info.id);
      if (old) { old.info = info; this.refreshLabel(old); if (info.kind === 'animal' && info.sub.startsWith('carcass:') && old.obj) old.obj.userData.dead = true; continue; }
      const v = new EntView(info);
      this.map.set(info.id, v);
      if (info.kind === 'player') { this.byPlayer.set(info.sub, v); this.onPlayerEnt(v, true); continue; }
      v.obj = this.build(v);
      if (v.obj) { this.world.entRoot.add(v.obj); void this.upgrade(v); }
    }
  }
  despawn(ids: number[]) { for (const id of ids) { const v = this.map.get(id); if (v) this.remove(v); } }
  private remove(v: EntView) {
    this.map.delete(v.info.id);
    if (v.info.kind === 'player') { if (this.byPlayer.get(v.info.sub) === v) this.byPlayer.delete(v.info.sub); this.onPlayerEnt(v, false); }
    if (v.obj) { this.world.entRoot.remove(v.obj); disposeTree(v.obj); }
  }
  private build(v: EntView): THREE.Object3D | null {
    const i = v.info, th = this.theme;
    const g = new THREE.Group();
    switch (i.kind) {
      case 'wagon': { const w = buildWagon(th); v.wagon = w; g.add(w.root); break; }
      case 'prop': { const p = buildProp(i.sub, th, i.size, i.label, i.color); g.add(p); break; }
      case 'animal': { const len = i.size[2] || 1; const a = buildAnimal(i.sub.replace('carcass:', ''), len); g.add(a); break; }
      case 'npc': { const n = buildNpc(i.sub, th, i.label ?? i.sub); n.position.y = -(i.size[1] + i.size[0]); g.add(n); break; }
      case 'platform': {
        const [x, y, z] = i.size;
        for (let k = -3; k <= 3; k++) { const m = new THREE.Mesh(unitBox(), toon(k % 2 ? '#8a6a44' : '#7a5a3a')); m.scale.set(x * 2, y * 2, z * 2 / 7 * 0.92); m.position.z = k * z * 2 / 7; m.castShadow = m.receiveShadow = true; g.add(m); }
        break;
      }
      default: return null;
    }
    this.refreshLabel(v, g);
    return g;
  }
  /** Swap the placeholder for the theme pack's model when trailart delivered it (ASSET_SPEC.md). */
  private async upgrade(v: EntView) {
    const i = v.info, th = this.theme;
    let art: THREE.Object3D | null = null, dy = 0;
    if (i.kind === 'wagon') art = await loadThemeGlb(th, 'wagon.glb');
    else if (i.kind === 'prop' && i.sub === 'draft') { art = await loadThemeGlb(th, 'animals/draft.glb'); dy = -i.size[1]; }
    else if (i.kind === 'prop') {
      art = await loadThemePart(th, 'props.glb', `PROP_${i.sub}`); dy = -i.size[1];
      // v2 kits: camp firewood (camp_kit LOG_small / LOG_big) + meme props (meme_kit PROP_meme_*)
      if (!art && (i.sub === 'log' || i.sub === 'log_big')) { art = await loadThemePart(th, 'camp_kit.glb', i.sub === 'log' ? 'LOG_small' : 'LOG_big'); if (art) { art.rotation.x = Math.PI / 2; dy = 0; } }
      if (!art && i.sub === 'rubber_duck') { art = await loadThemePart(th, 'meme_kit.glb', 'PROP_meme_rubber_duck'); if (art) art.scale.setScalar(3.2); }
    }
    else if (i.kind === 'animal') {
      // the camp thief / the goose use the theme's own critter (bayou raccoon, skyisles imp; a duck for the goose)
      const kind = i.sub.replace('carcass:', '');
      for (const f of ANIMAL_ALIAS[kind] ?? [kind]) if ((art = await loadThemeGlb(th, `animals/${f}.glb`))) break;
      dy = -(i.size[0] + 0.05);
    }
    else if (i.kind === 'npc' && /^[a-z0-9_]+$/.test(i.sub)) {
      // npcs/<id>.glb (NPC_talker_2 → talker_2.glb, else the shared talker.glb)
      art = await loadThemeGlb(th, `npcs/${i.sub}.glb`) ?? (/_\d+$/.test(i.sub) ? await loadThemeGlb(th, `npcs/${i.sub.replace(/_\d+$/, '')}.glb`) : null);
      dy = -(i.size[1] + i.size[0]);
    }
    if (!art || this.map.get(i.id) !== v || !v.obj) return;
    const g = v.obj as THREE.Group;
    // NPCs keep their name label (a sprite inside the placeholder): hide the placeholder's meshes instead
    art.position.y = dy;
    await this.world.compileHidden(art);   // (link its shaders before it replaces the placeholder: no first-draw stall)
    if (this.map.get(i.id) !== v || !v.obj) return;
    if (i.kind === 'npc') g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.visible = false; });
    else for (const c of [...g.children]) if (c !== v.tag) { g.remove(c); disposeTree(c); }
    g.add(art);
    // colour variants (extras.trail.variants, e.g. slimes): each instance gets its own tint (materials cloned per instance)
    applyVariant(art, i.id);
    // (ART_NOTES #6) only one of the four toads keeps its tiny bucket hat
    if (i.sub === 'draft' && i.id % 4 !== 0) { const hat = art.getObjectByName('ACC_bucket_hat'); if (hat) hat.visible = false; }
    if (i.kind === 'wagon') {
      const wheels: Record<string, THREE.Object3D> = {};
      v.wheelBase = new Map();
      for (const k of ['FL', 'FR', 'RL', 'RR']) { const n = art.getObjectByName(`WHEEL_${k}`); if (n) { wheels[k] = n; v.wheelBase.set(n, n.quaternion.clone()); } }
      // damage states: inside wagon.glb or trailart's separate wagon_damage.glb (roots in wagon space)
      const extra = await loadThemeGlb(th, 'wagon_damage.glb');
      if (extra) for (const c of [...extra.children]) { c.visible = false; art.add(c); }
      const dmg = { wheel: art.getObjectByName('WHEEL_FL_broken') ?? undefined, body: art.getObjectByName('BODY_dmg1') ?? undefined, raft: art.getObjectByName('RAFT') ?? undefined };
      for (const o of Object.values(dmg)) if (o) o.visible = false;
      v.wagon = { root: art as THREE.Group, wheels, body: (art.getObjectByName('BODY') as THREE.Group) ?? (art as THREE.Group), dmg };
    }
    const clips = (art.userData.clips as THREE.AnimationClip[] | undefined) ?? [];
    if (clips.length) {
      v.mixer = new THREE.AnimationMixer(art);
      v.actions = new Map(clips.map((c) => [c.name, v.mixer!.clipAction(c)]));
      this.playClip(v, i.sub.startsWith('carcass:') ? 'dead' : 'idle');
    }
  }
  playClip(v: EntView, name: string) {
    if (!v.actions || v.clip === name) return;
    const A = v.actions;
    const next = A.get(name) ?? (name === 'pull' ? A.get('walk') : name === 'flee' ? A.get('run') ?? A.get('walk') : name === 'run' ? A.get('walk') : name === 'dead' ? A.get('die')
      : name === 'fly' ? A.get('swoop') ?? A.get('run') : name === 'talk' ? A.get('idle') : null);
    if (next && v.clip && A.get(v.clip) === next) { v.clip = name; return; }
    if (!next) return;
    const prev = v.clip ? v.actions.get(v.clip) : null;
    next.reset().fadeIn(0.25).play();
    if (name === 'die' || name === 'dead') { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
    prev?.fadeOut(0.25);
    v.clip = name;
  }
  private refreshLabel(v: EntView, g = v.obj) {
    if (!g || v.info.kind !== 'prop') return;
    const want = !v.info.owned && v.info.price ? `${v.info.price}` : '';
    if ((v.tag?.userData.text ?? '') === want) return;
    if (v.tag) { g.remove(v.tag); v.tag.material.map?.dispose(); v.tag.material.dispose(); v.tag = undefined; }
    if (want) { v.tag = labelSprite(`${this.currency}${want}`, { fg: '#1a1a1a', bg: '#ffe066', height: 0.2 }); v.tag.userData.text = want; v.tag.position.y = v.info.size[1] + 0.22; g.add(v.tag); }
  }
  currency = '$';

  /** Feed a snapshot (host time `snap.time`, received at local `now` s). */
  push(snap: Snapshot, now: number) {
    const off = snap.time - now;
    this.offsets.push(off);
    if (this.offsets.length > 60) this.offsets.shift();
    let best = -Infinity;
    for (const o of this.offsets) if (o > best) best = o;   // the least-delayed arrival
    this.offset = Number.isNaN(this.offset) ? best : this.offset + (best - this.offset) * 0.05;
    // jitter buffer: ~1.2 × the arrival gap + 2 × its jitter
    if (this.lastArrive) {
      const g = Math.min(0.5, now - this.lastArrive);
      this.gap += (g - this.gap) * 0.05;
      this.gapJit += (Math.abs(g - this.gap) - this.gapJit) * 0.05;
      this.delay = Math.min(0.25, Math.max(0.03, this.gap * 1.2 + this.gapJit * 2 + 0.008));
    }
    this.lastArrive = now;
    let ox = 0, oz = 0;
    if (snap.origin) {
      const o = snap.origin;
      if (!this.origin) this.origin = [o[0], o[1]];
      else if ((o[0] !== this.origin[0] || o[1] !== this.origin[1]) && snap.tick > this.originTick) {
        // a newer snapshot moved the origin: re-express everything buffered in the new frame
        const dx = this.origin[0] - o[0], dz = this.origin[1] - o[1];
        for (const v of this.map.values()) { for (const s of v.buf) { s.p.x += dx; s.p.z += dz; } v.cur.p.x += dx; v.cur.p.z += dz; }
        this.origin = [o[0], o[1]];
        this.onRebase?.(dx, dz);
      }
      if (snap.tick > this.originTick) this.originTick = snap.tick;
      ox = o[0] - this.origin[0]; oz = o[1] - this.origin[1];   // (a late packet still in the old frame)
    }
    for (const s of snap.ents) this.map.get(s.id)?.push(snap.time, s, ox, oz);
  }
  hostNow(now: number) { return Number.isNaN(this.offset) ? 0 : now + this.offset; }
  rebase(dz: number) {
    for (const v of this.map.values()) { for (const s of v.buf) s.p.z += dz; v.cur.p.z += dz; }
  }
  /** Interpolate + place every non-player entity. `selfEnt` renders ahead (no delay). */
  update(now: number, dt: number, selfEnt = -1) {
    const t = this.hostNow(now) - this.delay;
    let wagonSpeed = 0;
    const people = this.people;
    people.length = 0;
    for (const v of this.byPlayer.values()) people.push(v.cur.p);
    for (const v of this.map.values()) {
      v.sample(v.info.id === selfEnt ? this.hostNow(now) : t, v.info.id === selfEnt);
      if (!v.obj) continue;
      const c = v.cur;
      v.obj.position.copy(c.p);
      v.obj.quaternion.copy(c.q);
      v.obj.visible = (c.flags & F.gone) === 0;
      const sp = v.buf.length > 1 ? v.buf[v.buf.length - 1].p.distanceTo(v.buf[v.buf.length - 2].p) / Math.max(1e-3, v.buf[v.buf.length - 1].t - v.buf[v.buf.length - 2].t) : 0;
      if (v.wagon) {
        // wheels spin with ground speed
        v.lastSpin += sp * dt / 0.6;
        for (const w of Object.values(v.wagon.wheels)) { const base = v.wheelBase?.get(w); if (base) w.quaternion.copy(base).multiply(qx.setFromAxisAngle(X, v.lastSpin)); else w.rotation.x = v.lastSpin; }
        wagonSpeed = sp;
      }
      if (v.mixer) {
        const s = v.info.kind === 'prop' ? (wagonSpeed > 0.3 ? 'pull' : 'idle')
          : v.info.kind === 'npc' ? (people.some((p) => p.distanceTo(c.p) < 3.5) ? 'talk' : 'idle')
          : v.info.sub.startsWith('carcass:') ? 'dead' : c.anim === 13 ? 'fly' : c.anim === 10 ? 'attack' : c.anim === 11 ? 'flee' : sp > 3 ? 'run' : sp > 0.3 ? 'walk' : 'idle';
        this.playClip(v, s);
        v.mixer.update(dt);
      }
    }
  }
  /** Players' interpolated samples by player id. */
  /** Players' interpolated samples by player id (a live map — don't keep it across frames). */
  players(): Map<string, EntView> { return this.byPlayer; }
  private people: THREE.Vector3[] = [];
  wagon(): EntView | null { for (const v of this.map.values()) if (v.info.kind === 'wagon') return v; return null; }
  /** Break the wagon's front-left wheel visually (the Wheel's Off! scene). */
  setBrokenWheel(on: boolean) { const w = this.wagon()?.wagon; if (w?.wheels.FL) w.wheels.FL.visible = !on; if (w?.dmg?.wheel) w.dmg.wheel.visible = on; }
  /** Damage looks: `battered` = a part is broken (BODY_dmg1 over BODY_LOD0), `raft` = caulked + floating (RAFT). */
  setWagonLook(battered: boolean, raft: boolean) {
    const w = this.wagon()?.wagon;
    if (!w?.dmg) return;
    if (w.dmg.body) { w.dmg.body.visible = battered; const b0 = w.root.getObjectByName('BODY_LOD0'); if (b0) b0.visible = !battered; }
    if (w.dmg.raft) w.dmg.raft.visible = raft;
  }
}

/** extras.trail.variants (hex colours) on a model's root: tint its skin materials per instance (id-picked). */
function applyVariant(art: THREE.Object3D, id: number) {
  let variants: string[] | null = null;
  art.traverse((o) => { const v = (o.userData?.trail as { variants?: unknown } | undefined)?.variants; if (!variants && Array.isArray(v) && v.length) variants = v.map(String); });
  if (!variants) return;
  const list: string[] = variants;
  const col = new THREE.Color(list[id % list.length]);
  art.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || /^COL_/.test(o.name)) return;
    const tint = (mat: THREE.Material) => {
      if (/^M_(Ink|Collider)/i.test(mat.name)) return mat;
      const c = mat.clone() as THREE.MeshToonMaterial;
      if (c.color) c.color.copy(col);
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(tint) : tint(m.material);
  });
}

/** Sim animal kinds → theme model files to try (first found wins). */
const ANIMAL_ALIAS: Record<string, string[]> = { thief: ['thief', 'raccoon', 'imp'], goose: ['goose', 'duck'] };
