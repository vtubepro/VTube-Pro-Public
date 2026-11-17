// Town engine — the ambient crowd: Kingsmarch's iconic NPCs at their stations + townsfolk walking the quay, the
// piers and the market. Deterministic + synced like the raid (src/scene/raid/*): every NPC runs a closed LOOP of
// walks (along the room's TOWN_NAV_xx graph, Dijkstra, chamfered corners) and activities at TOWN_POI_xx /
// TOWN_HOME_<cast> (browse + haggle at a stall, look out to sea, ring the crier's bell, carry crates in pairs from the
// brig to the warehouse, hammer at the anvil, cast a line, play the lute, drink at the tavern door, sit and chat on a
// bench, cook at the fire, patrol with a spear, kids chasing each other …). The loop is built once from room data +
// a fixed seed, then SAMPLED at the town clock — so every page (studio preview, OBS, party guests) shows the same person
// at the same place without any messages, and a page opened mid-walk lands mid-walk.
// Groups (TOWN_GROUP_xx: a chat circle, a bench, the bard's audience) take turns on the ABSOLUTE town clock: the
// speaker gestures, the others listen / nod and turn their heads to him. Heads also turn to the performers now and
// then (and all at once when a support event lands: the crowd cheers, drinkers raise their mugs — onSupport()).
// Never in front of a performer's face (screen-space fade, 4×/s). Cost: pose sampling only for NPCs in view (far ones
// at half / third rate), look-at only near the camera, one skinned draw per NPC; nothing when the room has no town.
import * as THREE from 'three';
import { TownAssets, TownNpc, MODEL_H, type TownClip } from './townUnits.ts';

export interface NavNode { name: string; p: THREE.Vector3; links: string[] }
export interface Poi { name: string; p: THREE.Vector3; yaw: number; kind: string; dwell: number; extras?: Record<string, unknown> }
export interface CrowdRoom { nav: Map<string, NavNode>; pois: Poi[]; homes: Map<string, { p: THREE.Vector3; yaw: number }> }

/** a group activity: members stand (or sit) at fixed places and take turns on the absolute clock */
interface Grp { id: number; pos: THREE.Vector3[]; turn: number; talk: string[]; listen: string[]; seed: number; noSpeaker?: boolean; focus?: THREE.Vector3 }
type Seg = { t0: number; t1: number; kind: 'walk'; pts: THREE.Vector3[]; cum: number[]; len: number; clip: string; speed: number }
  | { t0: number; t1: number; kind: 'act'; p: THREE.Vector3; yaw: number; clip: string; grp?: Grp; k?: number; hold?: string | null; look?: boolean };

interface Agent { id: string; unit: string; scale: number; segs: Seg[]; period: number; offset: number; npc: TownNpc | null; prop: string | null;
  lastYaw: number; hidden: number; poseEvery: number; frame: number; iconic: boolean; lookW: number; lookT: THREE.Vector3; drinker: boolean; tag?: string }

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function hash(...n: number[]) {
  let h = 2166136261 >>> 0;
  for (const v of n) { h ^= Math.floor(v * 997) >>> 0; h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function strHash(s: string) { return s.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7); }

/** metres walked per clip loop (model units) — matches km_anims.py; fixed so plans never depend on asset loading */
const CYCLE: Record<string, number> = { walk: 0.62 / 0.6, carry: 0.54 / 0.6, walk_hold: 0.62 / 0.6, sack_walk: 0.56 / 0.6, ual_jog_fwd: 1.9, style_drunk_walk: 0.9, ual_walk_carry: 1.0 };
/** clips whose hands hold the NPC's own prop (their unit's `prop`) */
const HELD = new Set(['hold', 'walk_hold', 'bell', 'preach', 'ual_idle_lantern', 'ual_driving', 'ual_overhand_throw', 'ual_tree_chopping', 'ual_consume', 'style_drunk_idle', 'style_drunk_walk']);
/** the smith's hammer blow lands at this fraction of ual_tree_chopping */
const HAMMER_HIT = 0.36;

const TOWNSFOLK = ['sailor_a', 'fishwife', 'exile_w', 'sailor_b', 'merchant', 'kalguuran', 'exile_s', 'townswoman', 'exile_r', 'sailor_a', 'kalguuran', 'exile_w', 'fishwife', 'townswoman', 'merchant', 'sailor_b'];
const LISTEN = ['idle', 'ual_idle_fold_arms', 'style_hands_in_pockets_idle', 'style_arms_behind_back_idle', 'style_neutral_idle'];
const CHEER = ['ual_jump', 'ual_yes', 'ual_dance', 'ual_yes'];

export class Crowd {
  agents: Agent[] = [];
  private assets: TownAssets | null = null;
  private group = new THREE.Group();
  private tv = new THREE.Vector3();
  private faceT = 0;
  private grpN = 0;
  stats = { posed: 0, visible: 0, ms: 0, looks: 0 };
  /** quality: -1 = always LOD1 (Performance), 0 = LOD1 beyond 12 m (Balanced), 0.5 = 17 m (High), 1 = 24 m (Ultra); ink outlines nearer still */
  lodBias = 0;
  /** town-clock times of support cheers (onSupport) */
  cheers: number[] = [];
  /** the smith's last hammer blow (town clock) + where it landed — the sparks */
  impact = { t: -1e9, p: new THREE.Vector3(), n: 0 };

  constructor(readonly room: CrowdRoom, readonly parent: THREE.Object3D, readonly cfg: { iconic: string[]; townsfolk: number; npcHeight: number; seed: number }) {
    this.group.name = 'vtp:town:crowd';
    parent.add(this.group);
    this.plan();
  }

  setAssets(a: TownAssets) { this.assets = a; }

  // ------------------------------------------------------------------ nav
  private nearest(p: THREE.Vector3): NavNode | null {
    let best: NavNode | null = null, bd = Infinity;
    for (const n of this.room.nav.values()) {
      const d = n.p.distanceToSquared(p) + Math.abs(n.p.y - p.y) * 20;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  private route(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3[] {
    const na = this.nearest(a), nb = this.nearest(b);
    const pts: THREE.Vector3[] = [a.clone()];
    if (na && nb && na !== nb) {
      const dist = new Map<string, number>(), prev = new Map<string, string>();
      const open = new Set<string>([na.name]);
      dist.set(na.name, 0);
      while (open.size) {
        let cur = '', cd = Infinity;
        for (const k of open) { const d = dist.get(k)!; if (d < cd) { cd = d; cur = k; } }
        open.delete(cur);
        if (cur === nb.name) break;
        const cn = this.room.nav.get(cur)!;
        for (const l of cn.links) {
          const ln = this.room.nav.get(l);
          if (!ln) continue;
          const nd = cd + cn.p.distanceTo(ln.p);
          if (nd < (dist.get(l) ?? Infinity)) { dist.set(l, nd); prev.set(l, cur); open.add(l); }
        }
      }
      const chain: NavNode[] = [];
      let k: string | undefined = nb.name;
      while (k) { chain.unshift(this.room.nav.get(k)!); if (k === na.name) break; k = prev.get(k); }
      if (chain[0] === na) for (const n of chain) pts.push(n.p.clone());
    } else if (na) pts.push(na.p.clone());
    pts.push(b.clone());
    const clean: THREE.Vector3[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) if (pts[i].distanceTo(clean[clean.length - 1]) > 0.35) clean.push(pts[i]);
    if (clean.length > 2) {
      const [p0, p1, p2] = clean;
      if (p0.distanceTo(p2) < p1.distanceTo(p2)) clean.splice(1, 1);
      const n = clean.length;
      if (n > 2 && clean[n - 3].distanceTo(clean[n - 1]) < clean[n - 2].distanceTo(clean[n - 3])) clean.splice(n - 2, 1);
    }
    const out: THREE.Vector3[] = [clean[0]];
    for (let i = 1; i < clean.length - 1; i++) {
      const a0 = clean[i - 1], c = clean[i], b0 = clean[i + 1];
      const ra = Math.min(0.9, a0.distanceTo(c) * 0.4), rb = Math.min(0.9, b0.distanceTo(c) * 0.4);
      out.push(c.clone().lerp(a0, ra / Math.max(1e-3, a0.distanceTo(c))), c.clone().lerp(b0, rb / Math.max(1e-3, b0.distanceTo(c))));
    }
    out.push(clean[clean.length - 1]);
    return out;
  }

  // ------------------------------------------------------------------ programs
  private plan() {
    const R = this.room;
    const rnd = rng(this.cfg.seed);
    const byKind = (k: string) => R.pois.filter((p) => p.kind === k);
    const pois = R.pois;
    const poi = (n: string) => pois.find((p) => p.name === n) ?? null;
    const base = this.cfg.npcHeight / MODEL_H;
    const heights: Record<string, number> = { ange: 1.66, dannig: 1.86, rog: 1.74, tujen: 1.8, makoru: 1.68, hooded: 1.84, doryani: 1.82, tavakai: 1.9, kanu: 1.64,
      rhodri: 1.8, lorandis: 1.78, jacob: 1.76, urchin: 1.25, urchin_b: 1.2, fishwife: 1.62, docker: 1.84, docker_b: 1.8, kalguuran: 1.88, smith: 1.86, guard: 1.84,
      guard_b: 1.86, bard: 1.76, fisher: 1.74, drunk: 1.74, cook: 1.62, townswoman: 1.66, exile_s: 1.7 };
    const scaleOf = (u: string) => base * ((heights[u] ?? 1.76) / 1.78);
    const has = (u: string) => !this.units || this.units.has(u);
    const add = (id: string, unit: string, build: (segs: Seg[], sc: number) => void, iconic: boolean, opt: { offset?: number; drinker?: boolean; tag?: string } = {}) => {
      if (!has(unit)) unit = iconic ? unit : 'sailor_a';
      const sc = scaleOf(unit);
      const segs: Seg[] = [];
      build(segs, sc);
      if (!segs.length) return null;
      const period = segs[segs.length - 1].t1;
      const h = strHash(id) % 100000;
      const a: Agent = { id, unit, scale: sc, segs, period, offset: opt.offset ?? (h / 100000) * period, npc: null, prop: null, lastYaw: 0, hidden: 0, poseEvery: 1,
        frame: h % 2, iconic, lookW: 0, lookT: new THREE.Vector3(), drinker: !!opt.drinker, tag: opt.tag };
      this.agents.push(a);
      return a;
    };
    const walkSeg = (segs: Seg[], from: THREE.Vector3, to: THREE.Vector3, sc: number, clip = 'walk', slow = 1.0, speedAbs = 0) => {
      const pts = this.route(from, to);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const len = cum[cum.length - 1];
      const cyc = CYCLE[clip] ?? CYCLE.walk;
      const dur = ({ walk: 1.05, carry: 1.15, walk_hold: 1.05, sack_walk: 1.1 } as Record<string, number>)[clip] ?? 1.05;
      const speed = speedAbs || (cyc * sc / dur) * slow;
      const t0 = segs.length ? segs[segs.length - 1].t1 : 0;
      segs.push({ t0, t1: t0 + Math.max(0.5, len / speed), kind: 'walk', pts, cum, len, clip, speed });
    };
    const actSeg = (segs: Seg[], p: THREE.Vector3, yaw: number, clip: string, dur: number, x: Partial<Extract<Seg, { kind: 'act' }>> = {}) => {
      const t0 = segs.length ? segs[segs.length - 1].t1 : 0;
      segs.push({ t0, t1: t0 + dur, kind: 'act', p: p.clone(), yaw, clip, look: true, ...x });
    };
    const home = (c: string) => R.homes.get(c) ?? null;
    const navP = (n: string) => R.nav.get('TOWN_NAV_' + n)?.p ?? null;
    const yawTo = (a: THREE.Vector3, b: THREE.Vector3) => Math.atan2(b.x - a.x, b.z - a.z);

    // ---------------- the iconic NPCs (routines around their stations)
    const icon = new Set(this.cfg.iconic);
    const routine = (c: string, fn: (segs: Seg[], sc: number, h: { p: THREE.Vector3; yaw: number }) => void, unit = c, iconic = true, opt: { offset?: number; drinker?: boolean; tag?: string } = {}) => {
      const h = home(c);
      if (!h || (iconic && !icon.has(c))) return null;
      return add(c, unit, (segs, sc) => fn(segs, sc, h), iconic, opt);
    };
    routine('ange', (s, sc, h) => {
      actSeg(s, h.p, h.yaw, 'counter', 16); actSeg(s, h.p, h.yaw, 'ual_idle_talking', 6.4); actSeg(s, h.p, h.yaw, 'ual_yes', 2.2);
      actSeg(s, h.p, h.yaw, 'counter', 20); actSeg(s, h.p, h.yaw, 'ual_idle_no', 2.6); actSeg(s, h.p, h.yaw, 'talk', 7); actSeg(s, h.p, h.yaw, 'counter', 14); actSeg(s, h.p, h.yaw, 'idle', 5);
    });
    routine('hooded', (s, sc, h) => { actSeg(s, h.p, h.yaw, 'cross', 44, { look: false }); actSeg(s, h.p, h.yaw, 'look', 9.6, { look: false }); actSeg(s, h.p, h.yaw, 'cross', 30, { look: false }); actSeg(s, h.p, h.yaw, 'idle', 6.4); });
    routine('lorandis', (s, sc, h) => { actSeg(s, h.p, h.yaw, 'preach', 25.6); actSeg(s, h.p, h.yaw, 'ual_spell_simple_idle', 6.4); actSeg(s, h.p, h.yaw, 'preach', 19.2); actSeg(s, h.p, h.yaw, 'talk', 7.2); });
    routine('kanu', (s, sc, h) => { actSeg(s, h.p, h.yaw, 'talk', 18); actSeg(s, h.p, h.yaw, 'idle', 9.6); actSeg(s, h.p, h.yaw, 'look', 9.6); });
    routine('tujen', (s, sc, h) => {
      // the haggler: pitches with his hands, shakes his head at a low offer, nods, talks again
      actSeg(s, h.p, h.yaw, 'ual_idle_talking', 9.6); actSeg(s, h.p, h.yaw, 'ual_idle_no', 2.6); actSeg(s, h.p, h.yaw, 'talk', 10.8); actSeg(s, h.p, h.yaw, 'ual_yes', 2.2);
      actSeg(s, h.p, h.yaw, 'browse', 8); actSeg(s, h.p, h.yaw, 'ual_idle_fold_arms', 9.6); actSeg(s, h.p, h.yaw, 'ual_idle_talking', 14.4);
    });
    routine('rog', (s, sc, h) => { actSeg(s, h.p, h.yaw, 'hold', 24); actSeg(s, h.p, h.yaw, 'ual_idle_talking', 10.8); actSeg(s, h.p, h.yaw, 'hold', 15); actSeg(s, h.p, h.yaw, 'ual_interact', 3.2); });
    routine('tavakai', (s, sc, h) => {
      const end = navP('A03');
      actSeg(s, h.p, h.yaw, 'hold', 30);
      if (end) { walkSeg(s, h.p, end, sc, 'walk_hold', 0.9); actSeg(s, end, Math.PI, 'hold', 12); walkSeg(s, end, h.p, sc, 'walk_hold', 0.9); }
      actSeg(s, h.p, h.yaw, 'hold', 18);
    });
    routine('makoru', (s, sc, h) => {
      const end = poi('pier_b_end');
      actSeg(s, h.p, h.yaw, 'ual_idle_talking', 14.4); actSeg(s, h.p, h.yaw, 'idle', 9.6);
      if (end) { walkSeg(s, h.p, end.p, sc, 'style_proud_walk'); actSeg(s, end.p, end.yaw, 'look', 14.4); walkSeg(s, end.p, h.p, sc, 'style_proud_walk'); }
      actSeg(s, h.p, h.yaw, 'talk', 10.8);
    });
    routine('dannig', (s, sc, h) => {
      const hall = poi('market_hall_door');
      actSeg(s, h.p, h.yaw, 'ual_idle_talking', 12); actSeg(s, h.p, h.yaw, 'ual_sword_idle', 9.6); actSeg(s, h.p, h.yaw, 'cross', 13.6);
      if (hall) { walkSeg(s, h.p, hall.p, sc); actSeg(s, hall.p, hall.yaw, 'talk', 10.8); walkSeg(s, hall.p, h.p, sc); }
      actSeg(s, h.p, h.yaw, 'idle', 9.6);
    });
    routine('doryani', (s, sc, h) => {
      const a = navP('M02'), b = navP('M03');
      actSeg(s, h.p, h.yaw, 'ual_spell_simple_idle', 16);
      if (a && b) { walkSeg(s, h.p, a, sc, 'walk', 0.7); actSeg(s, a, 0, 'look', 9.6); walkSeg(s, a, b, sc, 'walk', 0.7); actSeg(s, b, Math.PI, 'cross', 10.2); walkSeg(s, b, h.p, sc, 'walk', 0.7); }
      actSeg(s, h.p, h.yaw, 'talk', 10.8);
    });
    routine('rhodri', (s, sc, h) => {
      const ws = poi('water_steps');
      actSeg(s, h.p, h.yaw, 'ual_idle_talking', 14.4); actSeg(s, h.p, h.yaw, 'look', 9.6);
      if (ws) { walkSeg(s, h.p, ws.p, sc, 'style_strutting_walk'); actSeg(s, ws.p, ws.yaw, 'ual_idle_rail', 14.4); walkSeg(s, ws.p, h.p, sc, 'style_strutting_walk'); }
    });
    routine('jacob', (s, sc, h) => {
      // the town crier walks the quay: rings his bell, cups his hands and shouts the news, walks on
      const stops = [navP('Q09'), navP('Q03'), h.p].filter((x): x is THREE.Vector3 => !!x);
      let at = h.p;
      actSeg(s, at, h.yaw, 'bell', 6.4); actSeg(s, at, h.yaw, 'ual_idle_rail_call', 4.8); actSeg(s, at, h.yaw, 'ual_idle_talking', 7.2);
      for (const st of stops) { walkSeg(s, at, st, sc, 'walk_hold', 0.95); actSeg(s, st, h.yaw, 'bell', 4.8); actSeg(s, st, h.yaw, 'ual_idle_rail_call', 4.2); actSeg(s, st, h.yaw, 'idle', 3.2); at = st; }
    });

    // ---------------- Kingsmarch life (each needs its TOWN_HOME_ / TOWN_GROUP_ anchors in the room)
    routine('smith', (s, sc, h) => {
      actSeg(s, h.p, h.yaw, 'ual_tree_chopping', 9.6, { look: false, hold: 'hammer', k: 1 }); actSeg(s, h.p, h.yaw, 'idle', 2.4, { hold: 'hammer' });
      actSeg(s, h.p, h.yaw, 'ual_interact', 3.2, { look: false }); actSeg(s, h.p, h.yaw, 'ual_tree_chopping', 12.8, { look: false, hold: 'hammer', k: 1 });
      actSeg(s, h.p, h.yaw, 'ual_consume', 3.0); actSeg(s, h.p, h.yaw, 'ual_tree_chopping', 9.6, { look: false, hold: 'hammer', k: 1 });
    }, 'smith', false, { tag: 'smith' });
    routine('bard', (s, sc, h) => {
      actSeg(s, h.p, h.yaw, 'ual_driving', 19.2, { hold: 'lute' }); actSeg(s, h.p, h.yaw, 'ual_dance', 6.4, { hold: 'lute' }); actSeg(s, h.p, h.yaw, 'ual_driving', 16, { hold: 'lute' });
      actSeg(s, h.p, h.yaw, 'ual_yes', 2.2, { hold: 'lute' }); actSeg(s, h.p, h.yaw, 'idle', 4, { hold: 'lute' });
    }, 'bard', false);
    for (const [c, u] of [['fisher', 'fisher'], ['fisher_b', 'fisher']] as const) {
      routine(c, (s, sc, h) => {
        for (let i = 0; i < 3; i++) { actSeg(s, h.p, h.yaw, 'ual_overhand_throw', 1.9, { hold: 'rod', look: false }); actSeg(s, h.p, h.yaw, 'hold', 14 + i * 3, { hold: 'rod' }); actSeg(s, h.p, h.yaw, 'ual_idle_rail', 6.4, { hold: 'rod' }); }
        actSeg(s, h.p, h.yaw, 'ual_pick_up_table', 2.4, { hold: null }); actSeg(s, h.p, h.yaw, 'idle', 4, { hold: 'rod' });
      }, u, false);
    }
    routine('cook', (s, sc, h) => {
      actSeg(s, h.p, h.yaw, 'ual_farm_watering', 6.4, { look: false }); actSeg(s, h.p, h.yaw, 'idle', 3.2); actSeg(s, h.p, h.yaw, 'ual_interact', 3.2, { look: false });
      actSeg(s, h.p, h.yaw, 'ual_farm_watering', 8, { look: false }); actSeg(s, h.p, h.yaw, 'ual_idle_talking', 6.4);
    }, 'cook', false);
    // drunks at the tavern door: drink, sway, a little stagger and back
    for (const [c, u] of [['drunk', 'drunk'], ['drunk_b', 'drunk']] as const) {
      routine(c, (s, sc, h) => {
        const off = h.p.clone().add(new THREE.Vector3(Math.sin(h.yaw) * 2.6 + 1.2, 0, Math.cos(h.yaw) * 2.6));
        actSeg(s, h.p, h.yaw, 'style_drunk_idle', 9.6, { hold: 'tankard' }); actSeg(s, h.p, h.yaw, 'ual_consume', 3.0, { hold: 'tankard' });
        actSeg(s, h.p, h.yaw, 'style_drunk_idle', 7.2, { hold: 'tankard' });
        walkSeg(s, h.p, off, sc, 'style_drunk_walk', 0.8); actSeg(s, off, yawTo(off, h.p), 'style_drunk_idle', 4.8, { hold: 'tankard' });
        walkSeg(s, off, h.p, sc, 'style_drunk_walk', 0.8); actSeg(s, h.p, h.yaw, 'ual_consume', 3.0, { hold: 'tankard' });
      }, u, false, { drinker: true, offset: c === 'drunk_b' ? 11 : 0 });
    }
    // guards: a pair patrols the quay end to end, spears up, pausing to look around
    const gA = navP('Q02'), gB = navP('Q10');
    if (gA && gB && home('guard_post')) {
      const post = home('guard_post')!;
      const patrol = (s: Seg[], sc: number, side: number) => {
        const shift = (p: THREE.Vector3) => p.clone().add(new THREE.Vector3(0, 0, side * 0.55));
        actSeg(s, shift(post.p), post.yaw, 'hold', 12, { hold: 'spear' });
        walkSeg(s, shift(post.p), shift(gB), sc, 'walk_hold', 0.85); actSeg(s, shift(gB), Math.PI, 'hold', 7, { hold: 'spear' }); actSeg(s, shift(gB), -Math.PI / 2, 'ual_idle_shield', 4.8, { hold: 'spear' });
        walkSeg(s, shift(gB), shift(gA), sc, 'walk_hold', 0.85); actSeg(s, shift(gA), Math.PI, 'hold', 7, { hold: 'spear' }); actSeg(s, shift(gA), Math.PI / 2, 'ual_idle_talking', 6.4, { hold: 'spear' });
        walkSeg(s, shift(gA), shift(post.p), sc, 'walk_hold', 0.85);
      };
      // both built from the same timings (same unit height), so they walk side by side
      add('guard', 'guard', (s, sc) => patrol(s, scaleOf('guard'), 1), false, { offset: 0 });
      add('guard_b', 'guard_b', (s, sc) => patrol(s, scaleOf('guard'), -1), false, { offset: 0 });
    }
    // kids: one runs a loop, the other chases 1.2 s behind; they stop to laugh / dance
    const kidLoop = ['E03', 'Q05', 'Q06', 'E04', 'Q07', 'Q06', 'E03'].map(navP).filter((x): x is THREE.Vector3 => !!x);
    if (kidLoop.length > 3 && home('kids')) {
      const k0 = home('kids')!;
      const run = (s: Seg[], sc: number) => {
        let at = k0.p;
        for (let i = 0; i < kidLoop.length; i++) {
          const nx = kidLoop[i];
          walkSeg(s, at, nx, sc, 'ual_jog_fwd', 1, 2.9);
          if (i === 2) actSeg(s, nx, 0, 'ual_yes', 2.2);
          if (i === 4) actSeg(s, nx, Math.PI, 'ual_dance', 3.2);
          at = nx;
        }
        walkSeg(s, at, k0.p, sc, 'ual_jog_fwd', 1, 2.9);
        actSeg(s, k0.p, k0.yaw, 'idle', 4.8); actSeg(s, k0.p, k0.yaw, 'ual_jump', 1.4); actSeg(s, k0.p, k0.yaw, 'idle', 6.4);
      };
      add('kid_a', 'urchin', (s) => run(s, scaleOf('urchin')), false, { offset: 0 });
      add('kid_b', 'urchin_b', (s) => run(s, scaleOf('urchin')), false, { offset: -1.2 });
    }

    // ---------------- groups: chat circles, benches, the bard's audience (TOWN_POI_* kind 'group' / 'bench')
    for (const g of [...byKind('group'), ...byKind('bench')]) {
      const e = g.extras ?? {};
      const n = Math.max(2, Math.min(5, Number(e.n ?? 3)));
      const r = Number(e.r ?? 0.75);
      const sit = g.kind === 'bench';
      const units = String(e.units ?? '').split(',').filter(Boolean);
      const pos: THREE.Vector3[] = [];
      const yaws: number[] = [];
      for (let k = 0; k < n; k++) {
        if (sit) {
          // a bench: side by side along the bench (local X), all facing the bench's front
          const off = (k - (n - 1) / 2) * Number(e.gap ?? 0.62);
          pos.push(g.p.clone().add(new THREE.Vector3(Math.cos(g.yaw) * off, 0, -Math.sin(g.yaw) * off)));
          yaws.push(g.yaw);
        } else {
          // a circle open towards the POI's facing (so the camera side sees faces)
          const a = g.yaw + Math.PI + (k - (n - 1) / 2) * (Math.PI * 1.35 / Math.max(1, n - 1));
          const p = g.p.clone().add(new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r));
          pos.push(p); yaws.push(yawTo(p, g.p));
        }
      }
      const focus = e.focus === 'home' && e.home ? home(String(e.home))?.p : undefined;
      const grp: Grp = { id: this.grpN++, pos, turn: Number(e.turn ?? 4.2), seed: strHash(g.name) % 97,
        talk: sit ? ['ual_sitting_talking'] : ['ual_idle_talking', 'talk'], listen: sit ? ['ual_sitting_idle'] : LISTEN, noSpeaker: e.audience === true || e.audience === 'true',
        focus: focus ? focus.clone().setY(focus.y + 1.5) : undefined };
      for (let k = 0; k < n; k++) {
        const unit = units[k % Math.max(1, units.length)] || TOWNSFOLK[(grp.id * 3 + k) % TOWNSFOLK.length];
        add(`grp_${g.name}_${k}`, unit, (segs) => { segs.push({ t0: 0, t1: 3600, kind: 'act', p: pos[k], yaw: yaws[k], clip: grp.listen[0], grp, k, look: true }); }, false,
          { offset: 0, drinker: String(e.drink ?? '') === 'true' });
      }
    }

    // ---------------- townsfolk
    const stalls = byKind('stall'), looks = byKind('look'), talks = byKind('talk');
    const pickups = byKind('pickup'), drops = byKind('drop');
    const navList = [...R.nav.values()];
    const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length) % arr.length];
    for (let i = 0; i < this.cfg.townsfolk; i++) {
      const unit = TOWNSFOLK[i % TOWNSFOLK.length];
      const id = `folk_${i}_${unit}`;
      add(id, unit, (segs, sc) => {
        const start = pick(navList).p.clone();
        let at = start;
        const n = 6 + Math.floor(rnd() * 4);
        const gait = ['walk', 'walk', 'style_old_walk', 'style_rushed_walk', 'style_hands_in_pockets_walk', 'style_proud_walk'][Math.floor(rnd() * 6)];
        for (let k = 0; k < n; k++) {
          const r = rnd();
          let target: { p: THREE.Vector3; yaw: number; clip: string; dur: number; then?: [string, number][] };
          if (r < 0.4 && stalls.length) {
            const s = pick(stalls);
            // browse, then haggle: a head shake or a nod, maybe a little more talk
            const then: [string, number][] = rnd() < 0.5 ? [['ual_idle_no', 2.6], ['ual_idle_talking', 4.8]] : [['ual_yes', 2.2], ['ual_interact', 3.2]];
            target = { p: s.p, yaw: s.yaw, clip: 'browse', dur: s.dwell + rnd() * 4, then };
          } else if (r < 0.6 && looks.length) { const s = pick(looks); target = { p: s.p, yaw: s.yaw, clip: rnd() < 0.5 ? 'look' : 'ual_idle_rail', dur: 4.8 * (1 + Math.floor(rnd() * 2)) }; }
          else if (r < 0.8 && talks.length) { const s = pick(talks); target = { p: s.p, yaw: s.yaw, clip: 'ual_idle_talking', dur: 7.2 * (1 + Math.floor(rnd() * 2)) }; }
          else { const nn = pick(navList); target = { p: nn.p, yaw: rnd() * Math.PI * 2, clip: pick(LISTEN), dur: 3.2 + rnd() * 3 }; }
          const jp = target.p.clone().add(new THREE.Vector3((rnd() - 0.5) * 0.9, 0, (rnd() - 0.5) * 0.9));
          walkSeg(segs, at, jp, sc, gait, 0.9 + rnd() * 0.25);
          actSeg(segs, jp, target.yaw, target.clip, target.dur);
          for (const [c, d] of target.then ?? []) actSeg(segs, jp, target.yaw, c, d);
          at = jp;
        }
        walkSeg(segs, at, start, sc, gait);
      }, false);
    }
    // ---------------- dockhands: pairs carrying crates / sacks side by side from the brig (or the crane) to the quay stores
    if (pickups.length && drops.length) {
      const pairs = [['docker', 'docker_b'], ['docker_b', 'docker']] as const;
      pairs.forEach(([ua, ub], pi) => {
        const loop = (s: Seg[], sc: number, side: number) => {
          const sh = (p: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3) => {
            const d = to.clone().sub(from).setY(0); const l = d.length() || 1;
            return p.clone().add(new THREE.Vector3(-d.z / l * side * 0.42, 0, d.x / l * side * 0.42));
          };
          const r2 = rng(this.cfg.seed + 77 * (pi + 1));
          let at = pickups[pi % pickups.length].p;
          for (let k = 0; k < 4; k++) {
            const pu = pickups[Math.floor(r2() * pickups.length) % pickups.length], dr = drops[Math.floor(r2() * drops.length) % drops.length];
            const a0 = sh(pu.p, pu.p, dr.p), b0 = sh(dr.p, pu.p, dr.p);
            walkSeg(s, sh(at, at, pu.p), a0, sc, 'walk', 1.0);
            actSeg(s, a0, pu.yaw, 'ual_pick_up_table', 2.4, { hold: null });
            actSeg(s, a0, pu.yaw, 'carry_idle', 1.2);
            walkSeg(s, a0, b0, sc, 'carry', 1.0);
            actSeg(s, b0, dr.yaw, 'carry_idle', 1.0);
            actSeg(s, b0, dr.yaw, 'ual_pick_up_table', 2.4, { hold: null });
            actSeg(s, b0, dr.yaw, pi ? 'ual_idle_talking' : 'idle', 3.2);
            at = dr.p;
          }
        };
        const sc = scaleOf('docker');
        add(`dock_${pi}_a`, ua, (s) => loop(s, sc, 1), false, { offset: pi * 37 });
        add(`dock_${pi}_b`, ub, (s) => loop(s, sc, -1), false, { offset: pi * 37 });
      });
    }
  }

  /** set before plan() by the caller? (units known after load — plans never depend on assets; unknown units fall back at render) */
  private units: Set<string> | null = null;

  // ------------------------------------------------------------------ playback
  private sampleSeg(a: Agent, t: number) {
    const u = ((t + a.offset) % a.period + a.period) % a.period;
    let lo = 0, hi = a.segs.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a.segs[m].t1 <= u) lo = m + 1; else hi = m; }
    return { seg: a.segs[lo], i: lo, u };
  }

  private posAt(s: Seg, u: number, out: THREE.Vector3): number {
    if (s.kind === 'act') { out.copy(s.p); return s.yaw; }
    const d = Math.min(s.len, (u - s.t0) * s.speed);
    let i = 1;
    while (i < s.cum.length - 1 && s.cum[i] < d) i++;
    const a = s.pts[i - 1], b = s.pts[i];
    const k = (d - s.cum[i - 1]) / Math.max(1e-4, s.cum[i] - s.cum[i - 1]);
    out.lerpVectors(a, b, Math.min(1, Math.max(0, k)));
    const ahead = Math.min(s.len, d + 0.5);
    let j = 1;
    while (j < s.cum.length - 1 && s.cum[j] < ahead) j++;
    const kk = (ahead - s.cum[j - 1]) / Math.max(1e-4, s.cum[j] - s.cum[j - 1]);
    this.tv.lerpVectors(s.pts[j - 1], s.pts[j], Math.min(1, Math.max(0, kk)));
    return Math.atan2(this.tv.x - out.x, this.tv.z - out.z);
  }

  private clipTime(a: Agent, s: Seg, u: number, clip: TownClip) {
    if (s.kind === 'walk') {
      const d = (u - s.t0) * s.speed;
      // advance by the played clip's own stride (library clips carry theirs), so feet never skate
      const cyc = (this.assets?.cycle[clip.name] ?? CYCLE[clip.name] ?? CYCLE[s.clip] ?? CYCLE.walk) * a.scale;
      return (d / cyc) * clip.dur;
    }
    return u - s.t0;
  }

  /** a group member's clip at absolute time T: speakers gesture, listeners idle / nod */
  private grpClip(g: Grp, k: number, T: number) {
    const turn = Math.floor((T + g.seed * 3.1) / g.turn);
    const n = g.pos.length;
    const speaker = g.noSpeaker ? -1 : Math.floor(hash(g.id, turn) * n) % n;
    let name: string;
    if (k === speaker) name = g.talk[Math.floor(hash(g.id, turn, 3) * g.talk.length) % g.talk.length];
    else {
      const r = hash(g.id, turn, k + 11);
      name = g.listen[Math.floor(r * g.listen.length) % g.listen.length];
      if (!g.noSpeaker && r > 0.86 && g.talk[0] !== 'ual_sitting_talking') name = 'ual_yes';
    }
    return { name, speaker, t0: turn * g.turn - g.seed * 3.1 };
  }

  update(t: number, cam: THREE.PerspectiveCamera, faces: { c: THREE.Vector3; r: number }[], dt: number) {
    const t0 = performance.now();
    const A = this.assets;
    if (!A) return;
    if (!this.units) this.units = new Set(A.templates.keys());
    cam.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const camPos = cam.getWorldPosition(new THREE.Vector3());
    this.faceT -= dt;
    const checkFaces = this.faceT <= 0;
    if (checkFaces) this.faceT = 0.25;
    let posed = 0, vis = 0, looks = 0;
    const pos = new THREE.Vector3();
    const sph = new THREE.Sphere();
    // the performers' face centre (look-at target)
    const perf = faces.length ? faces[0].c : null;
    // an active cheer window?
    let cheerAt = -1;
    for (const c of this.cheers) if (t >= c && t < c + 5.5) cheerAt = c;
    this.cheers = this.cheers.filter((c) => t < c + 30);
    for (const a of this.agents) {
      if (!a.npc) {
        const unit = A.templates.has(a.unit) ? a.unit : (A.templates.has('sailor_a') ? 'sailor_a' : A.templates.keys().next().value!);
        a.npc = new TownNpc(A, unit, this.group);
        a.npc.root.scale.setScalar(a.scale);
      }
      const n = a.npc;
      const { seg, i, u } = this.sampleSeg(a, t);
      const yaw = this.posAt(seg, u, pos);
      n.root.position.copy(pos);
      let want = yaw;
      if (seg.kind === 'act') {
        const prev = a.segs[(i - 1 + a.segs.length) % a.segs.length];
        const since = u - seg.t0;
        if (prev.kind === 'walk' && since < 0.6) {
          const py = this.posAt(prev, prev.t1 - 0.001, this.tv);
          let d = yaw - py; d = Math.atan2(Math.sin(d), Math.cos(d));
          want = py + d * (since / 0.6);
        }
      }
      n.root.rotation.y = want;
      sph.set(pos.clone().setY(pos.y + 0.9 * a.scale * MODEL_H / 1.8), 1.2);
      const inView = frustum.intersectsSphere(sph);
      if (checkFaces) {
        let over = false;
        if (inView && faces.length) {
          const h = this.tv.copy(pos).setY(pos.y + 1.55 * a.scale * MODEL_H / 1.8).project(cam);
          const dNpc = camPos.distanceTo(pos);
          for (const f of faces) {
            const fp = f.c.clone().project(cam);
            const dF = camPos.distanceTo(f.c);
            if (dNpc < dF - 0.3) continue;
            const rr = (f.r / Math.max(0.3, dF)) * 2.6;
            if (Math.abs(h.x - fp.x) < rr / cam.aspect + 0.03 && h.y < fp.y + rr * 1.4 && h.y > fp.y - rr * 3.2) { over = true; break; }
          }
        }
        a.hidden = over ? 1 : 0;
      }
      const targetO = a.hidden ? 0 : 1;
      const o = n.opacity + (targetO - n.opacity) * Math.min(1, dt * 6);
      n.setOpacity(o);
      if (!inView || o < 0.02) { n.root.visible = false; continue; }
      vis++;
      const dist = camPos.distanceTo(pos);
      a.poseEvery = dist > 40 ? 3 : dist > 22 ? 2 : 1;
      const l1 = this.lodBias >= 1 ? 24 : this.lodBias >= 0.5 ? 17 : 12, l2 = this.lodBias >= 1 ? 48 : this.lodBias >= 0.5 ? 36 : this.lodBias >= 0 ? 26 : 16;
      n.setLod(dist > l2 ? 2 : this.lodBias < 0 || dist > l1 ? 1 : 0);
      n.setInk(dist < (this.lodBias > 0 ? 16 : 11));
      a.frame++;
      if (a.frame % a.poseEvery && n.root.userData.posed) continue;
      n.root.userData.posed = true;
      // ---- which clip
      const vkey = (s: Seg, k: number) => Math.floor(a.segs[0].t1 * 1000) + (s.kind === 'walk' ? 0 : k * 7919);
      const get = (name: string, s: Seg, k: number) => A.clips.get(A.variant(name, vkey(s, k), CYCLE.walk)) ?? A.clips.get(name) ?? A.clips.get('idle')!;
      let clip: TownClip, ct: number, prevClip: TownClip | null = null, pt = 0, w = 1;
      let lookAt: THREE.Vector3 | null = null;
      const since = u - seg.t0;
      if (seg.kind === 'act' && seg.grp) {
        const g = seg.grp;
        const cur = this.grpClip(g, seg.k ?? 0, t);
        clip = A.clips.get(cur.name) ?? A.clips.get(g.listen[0]) ?? A.clips.get('idle')!;
        ct = clip.loop ? t + (seg.k ?? 0) * 1.37 : t - cur.t0;
        const ph = t - cur.t0;
        if (ph < 0.45) {
          const pc = this.grpClip(g, seg.k ?? 0, cur.t0 - 0.01);
          const pcl = A.clips.get(pc.name) ?? null;
          if (pcl && pcl !== clip) { prevClip = pcl; pt = pcl.loop ? t + (seg.k ?? 0) * 1.37 : t - pc.t0; w = ph / 0.45; }
        }
        // listeners turn to the speaker, the speaker to someone else (or the group's focus: the bard)
        const tgtK = cur.speaker === (seg.k ?? 0) ? ((seg.k ?? 0) + 1) % g.pos.length : cur.speaker;
        if (g.focus) lookAt = g.focus;
        else if (tgtK >= 0) lookAt = this.tv.copy(g.pos[tgtK]).setY(g.pos[tgtK].y + (g.talk[0] === 'ual_sitting_talking' ? 1.1 : 1.55) * a.scale).clone();
      } else {
        clip = get(seg.clip, seg, i);
        ct = this.clipTime(a, seg, u, clip);
        if (since < 0.3) {
          const pi = (i - 1 + a.segs.length) % a.segs.length;
          const prev = a.segs[pi];
          const pc = get(prev.clip, prev, pi);
          if (pc && pc !== clip) { prevClip = pc; pt = this.clipTime(a, prev, prev.t1 - 0.001, pc) + since; w = since / 0.3; }
        }
      }
      // ---- a support cheer: everyone standing near the camera celebrates (drinkers raise their mugs)
      if (cheerAt > 0 && seg.kind === 'act' && dist < 38 && clip.name.indexOf('sitting') < 0) {
        const ce = t - cheerAt;
        const cn = a.drinker ? 'ual_consume' : CHEER[Math.floor(hash(strHash(a.id), cheerAt) * CHEER.length) % CHEER.length];
        const cc = A.clips.get(cn);
        if (cc) {
          const win = Math.min(1, ce / 0.4, (5.5 - ce) / 0.5);
          const delay = hash(strHash(a.id), 5) * 0.6;
          if (ce > delay) { prevClip = clip; pt = ct; clip = cc; ct = cc.loop ? ce : Math.min(ce - delay, cc.dur - 0.01); w = Math.max(0, win); }
          if (perf) lookAt = perf;
        }
      }
      if (prevClip) n.pose(prevClip, pt, clip, ct, w); else n.pose(clip, ct, null, 0, 0);
      // ---- held prop
      const own = A.unitProp.get(a.unit) ?? null;
      const segHold = seg.kind === 'act' ? seg.hold : undefined;
      let wantProp: string | null;
      if (clip.prop === 'crate' || clip.prop === 'sack') wantProp = clip.prop;
      else if (segHold !== undefined) wantProp = segHold;
      else if (HELD.has(clip.name)) wantProp = own && own !== 'crate' && own !== 'sack' ? own : clip.prop;
      else wantProp = null;
      if (a.drinker && wantProp == null && seg.kind === 'act') wantProp = 'tankard';
      if (wantProp !== a.prop) { n.setProp(wantProp); a.prop = wantProp; }
      // ---- the smith's hammer: remember the blow (sparks)
      if (a.tag === 'smith' && clip.name === 'ual_tree_chopping' && seg.kind === 'act') {
        const ph = ((ct / clip.dur) % 1 + 1) % 1;
        let hitT = t - ph * clip.dur + HAMMER_HIT * clip.dur;
        if (hitT > t) hitT -= clip.dur;
        if (hitT > this.impact.t + 0.2 && t - hitT < 0.5) {
          this.impact.t = hitT; this.impact.n++;
          this.impact.p.set(pos.x + Math.sin(want) * 0.62, pos.y + 0.84 * a.scale, pos.z + Math.cos(want) * 0.62);
        }
      }
      // ---- heads: to a speaker / the performers now and then (near the camera only)
      if (!lookAt && perf && seg.kind === 'act' && seg.look !== false && dist < 26) {
        const slot = Math.floor((t + strHash(a.id) % 13) / 6.5);
        if (hash(strHash(a.id), slot) < 0.3) lookAt = perf;
      }
      if (!lookAt && perf && seg.kind === 'walk' && dist < 14) {
        const slot = Math.floor((t + strHash(a.id) % 7) / 5);
        if (hash(strHash(a.id), slot, 2) < 0.18) lookAt = perf;
      }
      const lw = lookAt ? 1 : 0;
      a.lookW += (lw - a.lookW) * Math.min(1, dt * 2.5 * a.poseEvery);
      if (lookAt) a.lookT.lerp(lookAt, a.lookW < 0.05 ? 1 : Math.min(1, dt * 4 * a.poseEvery));
      if (a.lookW > 0.02 && dist < 30) { n.lookAt(a.lookT, a.lookW); looks++; }
      posed++;
    }
    this.stats.posed = posed; this.stats.visible = vis; this.stats.looks = looks;
    this.stats.ms = this.stats.ms * 0.95 + (performance.now() - t0) * 0.05;
  }

  dispose() {
    for (const a of this.agents) a.npc?.dispose();
    this.agents = [];
    this.group.removeFromParent();
  }
}
