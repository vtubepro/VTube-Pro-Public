// The frontline planner: the swarm, who kills which bug and the supports — all CLOSED-FORM in wall-clock time.
//
// Time = seconds since T0 (2026-01-01). Everything is a pure function of (room, seed, chat timestamps, support stamps):
// the studio preview, every OBS page and party guests' pages draw the same horde, the same kills, the same strikes.
//
//  - Aggression A(t) = base + Σ weight·exp(−(t − ts)/tau) over chat messages (read with a 4 s lag so a late-arriving
//    message never rewrites a slot another page already drew), capped at 1.6. It decays when chat goes quiet.
//  - Spawn slots of 1 s: slot k spawns groups of bugs whose number and archetypes grow with A(k): scavengers +
//    warriors always, hunters from 0.25, spewers from 0.4, chargers from 0.55, bile titans from 0.8 (and a rare one
//    anytime); shrieker flocks; hive "breaches" at high aggression.
//  - Each bug walks from its hive toward the wall; it dies at a planned point (defenders / turrets / sentries / the mech
//    shoot it) or earlier when a support's impact catches it. The base never falls: a bug that reaches the wall dies
//    there within 2.5 s.
//  - Supports: donations / subs / raids / Kick channel-point rewards (stamped with the chat event's ts) + ambient ones
//    every ~20 s. A support = timed impacts (kill radius) + what the scene draws.
import * as THREE from 'three';
import { hash32, Rng } from '../raid/rng.ts';
import { terrainY, type FrontlineCfg, type FrontlineRoom } from './frontlineRoom.ts';

export const T0 = 1767225600;
export type BugKind = 'scav' | 'warrior' | 'hunter' | 'spewer' | 'charger' | 'titan' | 'shrieker';
export type SupportKind = 'strafe' | 'airstrike' | 'napalm' | 'bomb500' | 'barrage' | 'laser' | 'railcannon' | 'hellbomb' | 'mech' | 'sentry' | 'supply';
export const SUPPORT_KINDS: SupportKind[] = ['strafe', 'airstrike', 'napalm', 'bomb500', 'barrage', 'laser', 'railcannon', 'hellbomb', 'mech', 'sentry', 'supply'];
export const SUPPORT_NAME: Record<SupportKind, string> = {
  strafe: 'EAGLE STRAFING RUN', airstrike: 'EAGLE AIRSTRIKE', napalm: 'EAGLE NAPALM', bomb500: 'EAGLE 500KG BOMB', barrage: 'ORBITAL 380MM BARRAGE',
  laser: 'ORBITAL LASER', railcannon: 'ORBITAL RAILCANNON', hellbomb: 'HELLBOMB', mech: 'EXOSUIT DROP', sentry: 'SENTRY TURRETS', supply: 'SUPPLY DROP',
};

export const BUGS: Record<BugKind, { speed: number; emerge: number; life: [number, number]; group: [number, number]; fly?: boolean; goo: [number, number, number]; size: number }> = {
  scav: { speed: 5.4, emerge: 0.6, life: [0.3, 0.8], group: [2, 5], goo: [1.3, 0.75, 0.2], size: 0.9 },
  warrior: { speed: 4.0, emerge: 0.9, life: [0.35, 0.85], group: [1, 3], goo: [1.4, 0.7, 0.18], size: 1.6 },
  hunter: { speed: 6.6, emerge: 0.5, life: [0.3, 0.85], group: [2, 3], goo: [1.0, 1.1, 0.25], size: 1.2 },
  spewer: { speed: 2.3, emerge: 1.2, life: [0.4, 1.0], group: [1, 2], goo: [0.7, 1.4, 0.2], size: 2.2 },
  charger: { speed: 6.2, emerge: 1.4, life: [0.45, 0.8], group: [1, 1], goo: [1.5, 0.6, 0.15], size: 3.4 },
  titan: { speed: 1.9, emerge: 2.4, life: [0.45, 0.62], group: [1, 1], goo: [1.2, 1.4, 0.25], size: 9 },
  shrieker: { speed: 9.5, emerge: 0.0, life: [0.35, 0.85], group: [4, 7], fly: true, goo: [1.4, 0.8, 0.3], size: 1.0 },
};

export type Killer = { k: 'def' | 'turret' | 'sentry' | 'mech' | 'support' | 'at' | 'wall'; i: number; id?: string };

export interface Bug {
  id: string; kind: BugKind; t0: number; seed: number;
  from: THREE.Vector3; to: THREE.Vector3; len: number; speed: number; weave: number; fly: number;
  natural: number;          // planned natural death time (s)
  death: number; killer: Killer;
  /** Spewers stop short and spit; walls: the end of the path. */
  stopAt: number;
}

export interface Impact { t: number; p: THREE.Vector3; r: number }
export interface Support {
  id: string; k: SupportKind; at: number; user: string; amount: string; reward?: string; seed: number;
  target: THREE.Vector3; dir: THREE.Vector3; impacts: Impact[]; end: number; ambient: boolean;
  /** mech / sentry / supply: active window */
  on?: [number, number];
}
export interface SupportStamp { k: SupportKind; at: number; id: string; user?: string; amount?: string; reward?: string }

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const LAG = 4;

export class FrontlinePlan {
  readonly seed: number;
  chat: number[] = [];                  // chat message times (s, T0-based), sorted
  stamps: SupportStamp[] = [];          // explicit supports (donations, rewards, tests)
  private slots = new Map<number, Bug[]>();
  private supCache = new Map<string, Support>();
  private rev = 0; private deathRev = -1;
  private cfgChat: { weight: number; tau: number; base: number };
  readonly maxLife = 70;

  constructor(readonly room: FrontlineRoom, readonly cfg: FrontlineCfg) {
    this.seed = cfg.seed ?? 23;
    this.cfgChat = { weight: cfg.chat?.weight ?? 0.045, tau: cfg.chat?.tau ?? 120, base: cfg.chat?.base ?? 0.14 };
  }

  touch() { this.rev++; }

  // ------------------------------------------------------------------------------------------ aggression
  aggression(t: number): number {
    const { weight, tau, base } = this.cfgChat;
    let a = base;
    const lim = t - LAG;
    for (let i = this.chat.length - 1; i >= 0; i--) {
      const ts = this.chat[i];
      if (ts > lim) continue;
      const d = lim - ts;
      if (d > tau * 6) break;
      a += weight * Math.exp(-d / tau);
    }
    return Math.min(1.6, a);
  }

  // ------------------------------------------------------------------------------------------ supports
  /** Ambient supports: one chance per 21 s window (none while an explicit support starts within 6 s). */
  private ambient(win: number): Support | null {
    const every = this.cfg.ambientEvery ?? 21;
    if (every <= 0) return null;
    const r = new Rng(hash32(this.seed, 'amb', win));
    const at = win * every + r.range(2, every - 6);
    const A = this.aggression(at);
    if (!r.chance(0.5 + 0.3 * Math.min(1, A))) return null;
    const k = r.pick(['strafe', 'strafe', 'airstrike', 'airstrike', 'napalm', 'barrage', 'bomb500', 'laser'] as SupportKind[]);
    return this.build({ k, at, id: `amb:${win}` }, true);
  }

  supportsIn(t0: number, t1: number): Support[] {
    const out: Support[] = [];
    const every = this.cfg.ambientEvery ?? 21;
    if (every > 0) for (let w = Math.floor((t0 - 60) / every); w <= Math.floor(t1 / every); w++) { const s = this.ambientCached(w); if (s && s.end >= t0 && s.at <= t1) out.push(s); }
    for (const st of this.stamps) {
      if (st.at > t1 || st.at < t0 - 70) continue;
      const s = this.buildCached(st);
      if (s.end >= t0) out.push(s);
    }
    return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }
  private ambientCached(w: number) {
    const key = `amb:${w}`;
    if (this.supCache.has(key)) return this.supCache.get(key)!;
    const s = this.ambient(w);
    this.supCache.set(key, s as Support);
    return s;
  }
  private buildCached(st: SupportStamp) {
    let s = this.supCache.get(st.id);
    if (!s) { s = this.build(st, false); this.supCache.set(st.id, s); }
    return s;
  }
  prune(t: number) {
    for (const [k, s] of this.supCache) if (!s || s.end < t - 120) this.supCache.delete(k);
    for (const k of this.slots.keys()) if (k < t - this.maxLife - 10) this.slots.delete(k);
    this.stamps = this.stamps.filter((s) => s.at > t - 200);
    const lim = t - this.cfgChat.tau * 6;
    if (this.chat.length && this.chat[0] < lim) this.chat = this.chat.filter((x) => x >= lim);
  }

  private fieldPoint(r: Rng): THREE.Vector3 {
    const a = THREE.MathUtils.degToRad(r.range(-58, 58)), rad = r.range(28, 58);
    const x = Math.sin(a) * rad, z = -Math.cos(a) * rad;
    return V(x, terrainY(x, z), z);
  }

  build(st: SupportStamp, ambient: boolean): Support {
    const r = new Rng(hash32(this.seed, 'sup', st.id));
    const target = this.fieldPoint(r);
    const ang = r.range(0, Math.PI * 2);
    const dir = V(Math.cos(ang), 0, Math.sin(ang));
    const s: Support = { id: st.id, k: st.k, at: st.at, user: st.user ?? '', amount: st.amount ?? '', reward: st.reward, seed: r.int(1e9), target, dir, impacts: [], end: st.at + 12, ambient };
    const I = (t: number, x: number, z: number, rad: number) => s.impacts.push({ t, p: V(x, terrainY(x, z), z), r: rad });
    const a0 = st.at;
    switch (st.k) {
      case 'strafe': {
        // perpendicular to the line of fire: sweeps across the lanes
        const side = V(-target.z, 0, target.x).normalize();
        s.dir.copy(side);
        for (let i = 0; i < 18; i++) { const u = -16 + i * 1.9; I(a0 + 3.0 + i * 0.06, target.x + side.x * u, target.z + side.z * u, 2.4); }
        s.end = a0 + 7; break;
      }
      case 'airstrike': case 'napalm': {
        const side = V(-target.z, 0, target.x).normalize();
        s.dir.copy(side);
        for (let i = 0; i < 6; i++) { const u = -14 + i * 5.6; I(a0 + 3.3 + i * 0.13, target.x + side.x * u, target.z + side.z * u, 5.5); }
        if (st.k === 'napalm') for (let j = 1; j <= 16; j++) for (let i = 0; i < 6; i += 1) { const u = -14 + i * 5.6; I(a0 + 3.4 + j * 0.55, target.x + side.x * u, target.z + side.z * u, 4.2); }
        s.end = a0 + (st.k === 'napalm' ? 14 : 8); break;
      }
      case 'bomb500': I(a0 + 3.6, target.x, target.z, 12); s.end = a0 + 12; break;
      case 'barrage':
        for (let i = 0; i < 15; i++) { const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * 17; I(a0 + 3.5 + i * 0.6 + r.range(0, 0.3), target.x + Math.cos(a) * d, target.z + Math.sin(a) * d, 6.5); }
        s.end = a0 + 16; break;
      case 'laser':
        for (let i = 0; i < 32; i++) { const u = i / 31; const p = this.laserAt(s, u); I(a0 + 3.2 + u * 8, p.x, p.z, 3.8); }
        s.end = a0 + 13; break;
      case 'railcannon': I(a0 + 3.0, target.x, target.z, 3.5); s.end = a0 + 8; break;
      case 'hellbomb': I(a0 + 10.5, target.x, target.z, 46); s.end = a0 + 22; break;
      case 'mech': s.on = [a0 + 5.0, a0 + 52]; s.end = a0 + 56; break;
      case 'sentry': s.on = [a0 + 3.8, a0 + 46]; s.end = a0 + 48; break;
      case 'supply': s.on = [a0 + 3.2, a0 + 34]; s.end = a0 + 36; break;
    }
    return s;
  }
  laserAt(s: Support, u: number, out = V()): THREE.Vector3 {
    const side = V(-s.target.z, 0, s.target.x).normalize();
    const w = Math.sin(u * Math.PI * 2.2 + s.seed % 7) * 9;
    out.set(s.target.x + side.x * (u - 0.5) * 34 + s.dir.x * w, 0, s.target.z + side.z * (u - 0.5) * 34 + s.dir.z * w);
    out.y = terrainY(out.x, out.z);
    return out;
  }

  // ------------------------------------------------------------------------------------------ the swarm
  private spawnSlot(k: number): Bug[] {
    const out: Bug[] = [];
    const r = new Rng(hash32(this.seed, 'slot', k));
    const A = this.aggression(k);
    const R = this.room;
    const nGroups = Math.min(7, Math.floor((0.7 + 3.6 * A) / 1.6 + r.next()));
    const W: [BugKind, number][] = [['scav', 1.0], ['warrior', 0.85], ['hunter', A > 0.25 ? 0.55 : 0.12], ['spewer', A > 0.4 ? 0.32 : 0.04],
      ['charger', A > 0.55 ? 0.16 + 0.1 * (A - 0.55) : A > 0.35 ? 0.03 : 0]];
    const tot = W.reduce((s, w) => s + w[1], 0);
    const kinds: BugKind[] = [];
    for (let g = 0; g < nGroups; g++) {
      let u = r.next() * tot, kind: BugKind = 'scav';
      for (const [kk, w] of W) { if ((u -= w) <= 0) { kind = kk; break; } }
      const [a, b] = BUGS[kind].group;
      const n = a + r.int(b - a + 1);
      for (let i = 0; i < n; i++) kinds.push(kind);
    }
    // bile titans: every 40 s window, one slot may bring one (likely at high aggression, rare when calm)
    const tw = Math.floor(k / 40), tr = new Rng(hash32(this.seed, 'titan', tw));
    const tSlot = tw * 40 + tr.int(40);
    if (k === tSlot && tr.chance(A > 0.8 ? 0.8 : A > 0.5 ? 0.3 : 0.08)) kinds.push('titan');
    // shrieker flocks
    if (r.chance(0.03 + 0.05 * A)) { const n = 4 + r.int(4); for (let i = 0; i < n; i++) kinds.push('shrieker'); }
    // hive breach: a burst out of one hive
    const bw = Math.floor(k / 45), br = new Rng(hash32(this.seed, 'breach', bw));
    const bSlot = bw * 45 + br.int(40);
    const breach = k >= bSlot && k < bSlot + 3 && br.chance(A > 0.7 ? 0.65 : A > 0.45 ? 0.2 : 0) ? br.int(R.spawns.length) : -1;
    if (breach >= 0) for (let i = 0; i < 5; i++) kinds.push(r.chance(0.6) ? 'scav' : 'warrior');
    kinds.forEach((kind, i) => {
      const spec = BUGS[kind];
      const sp = breach >= 0 && i >= kinds.length - 5 ? R.spawns[breach] : R.spawns[r.int(R.spawns.length)];
      const home = V(sp.pos.x, 0, sp.pos.z);
      const dirIn = home.clone().multiplyScalar(-1).setY(0).normalize();
      const from = home.clone().addScaledVector(dirIn, 7.5).add(V(r.range(-2.5, 2.5), 0, r.range(-2.5, 2.5)));
      const ang = Math.atan2(from.x, -from.z) + THREE.MathUtils.degToRad(r.range(-14, 14));
      const endR = R.wallR + (kind === 'titan' ? 22 : kind === 'charger' ? 4 : 2.2);
      const to = V(Math.sin(ang) * endR, 0, -Math.cos(ang) * endR);
      const len = from.distanceTo(to);
      const t0 = k + r.next();
      const speed = spec.speed * r.range(0.85, 1.15);
      const stopAt = kind === 'spewer' ? Math.max(4, len - r.range(12, 22)) : len;
      const natural = t0 + spec.emerge + (stopAt / speed) * r.range(spec.life[0], spec.life[1]) + (kind === 'spewer' ? r.range(0, 5) : 0);
      out.push({ id: `${k}:${i}`, kind, t0, seed: r.int(1e9), from, to, len, speed, weave: kind === 'titan' ? 0.4 : r.range(0.4, 2.2), fly: spec.fly ? r.range(6, 13) : 0,
        natural, death: natural, killer: { k: 'def', i: 0 }, stopAt });
    });
    return out;
  }

  /** Distance along the path at time t (emerging bugs are at 0). */
  dist(b: Bug, t: number) {
    const spec = BUGS[b.kind];
    const tt = t - b.t0 - spec.emerge;
    if (tt <= 0) return 0;
    let s = b.kind === 'charger' ? b.speed * (tt < 2 ? tt * tt / 4 : tt - 1) : b.kind === 'hunter' ? b.speed * (tt + 0.18 * Math.sin(tt * 4.2)) : b.speed * tt;
    if (s > b.stopAt) s = b.stopAt;
    return s;
  }
  pos(b: Bug, t: number, out = V()): THREE.Vector3 {
    const s = this.dist(b, t);
    const u = b.len > 0 ? s / b.len : 0;
    out.lerpVectors(b.from, b.to, u);
    const side = Math.sin(s * 0.18 + (b.seed % 100)) * b.weave;
    const dx = b.to.x - b.from.x, dz = b.to.z - b.from.z, n = Math.hypot(dx, dz) || 1;
    out.x += (-dz / n) * side; out.z += (dx / n) * side;
    out.y = terrainY(out.x, out.z) + b.fly;
    return out;
  }

  /** Death times: natural (a shooter) or the first impact that catches the bug; the wall ends every survivor. */
  private resolve(b: Bug, sups: Support[]) {
    const spec = BUGS[b.kind];
    const r = new Rng(b.seed);
    let death = b.natural;
    const reach = b.t0 + spec.emerge + b.stopAt / b.speed;
    let killer: Killer;
    if (b.kind === 'spewer') death = Math.min(death, reach + 6);
    else if (death > reach + 2.5) death = reach + 2.5;
    // who shoots it
    const t = death;
    const shooters: Killer[] = [];
    const R = this.room;
    const ang = Math.atan2(b.to.x, -b.to.z);
    let bi = 0, bd = Infinity;
    R.defenders.forEach((d, i) => { const a = Math.atan2(d.pos.x, -d.pos.z); const dd = Math.abs(a - ang); if (dd < bd) { bd = dd; bi = i; } });
    const nd = R.defenders.length;
    const atPosts = R.defenders.map((d, i) => (d.role === 'at' ? i : -1)).filter((i) => i >= 0);
    if ((b.kind === 'charger' || b.kind === 'titan') && atPosts.length) shooters.push({ k: 'at', i: atPosts[r.int(atPosts.length)] });
    else {
      shooters.push({ k: 'def', i: bi }, { k: 'def', i: (bi + nd + (r.chance(0.5) ? 1 : -1)) % nd }, { k: 'def', i: r.int(nd) });
      if (R.turrets.length) shooters.push({ k: 'turret', i: r.int(R.turrets.length) });
      if (b.kind === 'shrieker' && R.turrets.length) shooters.push({ k: 'turret', i: r.int(R.turrets.length) }, { k: 'turret', i: r.int(R.turrets.length) });
      for (const s of sups) if (s.on && t >= s.on[0] && t <= s.on[1]) {
        if (s.k === 'mech') shooters.push({ k: 'mech', i: 0, id: s.id }, { k: 'mech', i: 0, id: s.id });
        if (s.k === 'sentry') shooters.push({ k: 'sentry', i: 0, id: s.id }, { k: 'sentry', i: 1, id: s.id });
      }
    }
    killer = shooters[r.int(shooters.length)];
    if (b.kind === 'titan') killer = { k: 'support', i: -1, id: `titan:${b.id}` };      // an orbital railcannon (drawn by the scene)
    // support impacts (only flying-free bugs; flyers die by guns)
    if (!b.fly) {
      const P = V();
      for (const s of sups) {
        if (s.at > death || s.end < b.t0) continue;
        for (const im of s.impacts) {
          if (im.t >= death || im.t < b.t0 + spec.emerge * 0.5) continue;
          this.pos(b, im.t, P);
          const rr = im.r + spec.size * 0.3;
          if ((P.x - im.p.x) ** 2 + (P.z - im.p.z) ** 2 < rr * rr) { death = im.t; killer = { k: 'support', i: 0, id: s.id }; break; }
        }
      }
    }
    b.death = death; b.killer = killer;
  }

  private slot(k: number, now: number): Bug[] | null {
    if (k > now) return null;
    let s = this.slots.get(k);
    if (!s) {
      s = this.spawnSlot(k);
      if (k < now - 1) this.slots.set(k, s);       // (fresh slots are re-planned next frame: late chat can still land)
    }
    return s;
  }

  /** Every bug alive (or dying: up to 1.5 s after death) at time t. */
  bugsAt(t: number): Bug[] {
    const out: Bug[] = [];
    const k1 = Math.floor(t);
    const sups = this.supportsIn(t - this.maxLife - 20, t + 90);
    for (let k = k1 - this.maxLife; k <= k1; k++) {
      const s = this.slot(k, t);
      if (!s) continue;
      const tagged = s as Bug[] & { rev?: number };
      if (tagged.rev !== this.rev) { for (const b of s) this.resolve(b, sups); tagged.rev = this.rev; }
      for (const b of s) if (t >= b.t0 && t < b.death + (b.kind === 'titan' ? 4 : 1.5)) out.push(b);
    }
    return out;
  }

  /** Titans die to an orbital railcannon: the strike (call at death − 3 s). */
  titanStrikes(t: number, bugs = this.bugsAt(t)): { id: string; at: number; p: THREE.Vector3 }[] {
    const out: { id: string; at: number; p: THREE.Vector3 }[] = [];
    for (const b of bugs) if (b.kind === 'titan' && b.killer.k === 'support' && b.killer.id === `titan:${b.id}` && t >= b.death - 3) out.push({ id: b.id, at: b.death - 3, p: this.pos(b, b.death) });
    return out;
  }
}
