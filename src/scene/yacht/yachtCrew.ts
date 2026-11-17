// Yacht life — the crew: the bartender at YACHT_BAR (idles, polishes, pours), ambient walkers on the YACHT_ROUTE_* lines
// (fade in at _01, out at the last point), seated / standing guests (scene.json `yacht.patrons`, the traffic Patrons
// class) and two stewards who carry a tray of flutes from YACHT_SERVICE to the host, offer one (ual_interact), set it on
// YACHT_DRINK_<host spot> (≤ 3 flutes; the 4th delivery first clears the table) and walk back.
// Built on the town NPC tech (TownAssets / TownNpc: shared skeleton, toon atlas, LOD1, ink) + the retargeted UAL clips.
// Every pose is a pure function of (room, wall-clock s, the drink schedule): walks are stride-locked (the clip advances
// by distance walked, no foot sliding), so every page shows the same crew.
import * as THREE from 'three';
import { TownAssets, TownNpc, MODEL_H, type TownClip } from '../town/townUnits.ts';
import { Patrons } from '../traffic/patrons.ts';
import type { RoomRays } from '../twoShot.ts';
import type { YachtRoom } from './yachtRoom.ts';
import { YachtProps } from './yachtProps.ts';
import { yachtHash, yachtRand, type RoomYachtConfig, type YachtItem } from '../../../shared/yacht.ts';

const ANIMS_URL = new URL('../../../assets/library/anims/npc/town_anims_ual.json', import.meta.url).href;

/** crew roles → unit ids tried in order (the room's crew_units.glb first, the Area 18 patrons as a fallback) */
const ROLE_UNITS: Record<string, string[]> = {
  bartender: ['bartender', 'exec', 'tech'],
  steward: ['steward', 'courier', 'tech'],
  stewardess: ['stewardess', 'steward', 'tourist', 'courier'],
  pilot: ['pilot'],
  captain: ['captain', 'exec'],
  walker: ['captain', 'pilot', 'guest_tux', 'guest_gown', 'guest_exec', 'stewardess', 'steward', 'chef', 'exec', 'tourist', 'merc', 'pilot', 'tech'],
};
const BAR_IDLES = ['ual_idle', 'ual_interact', 'style_proud_idle', 'ual_idle_fold_arms', 'ual_interact', 'style_arms_behind_back_idle', 'ual_idle'];

// drink timeline (s)
const TURN = 0.5, CLEAR = 1.1, OFFER = 2.0, NOD = 1.3, FADE = 0.5, XF = 0.25;

export interface DrinkPlan {
  path: THREE.Vector3[]; cum: number[]; L: number; v: number;
  stand: THREE.Vector3; faceYaw: number; target: THREE.Vector3;
  anchor: THREE.Vector3 | null; slots: THREE.Vector3[]; tableYaw: number;
  /** duration (s) without / with a table clear */ dur: number; durClear: number;
  key: string;
}

interface Member {
  npc: TownNpc; unit: string; fade: number; protect: number; handL: THREE.Object3D | null; handR: THREE.Object3D | null; shown: boolean; walk: number;
}

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3(), tv4 = new THREE.Vector3(), tv5 = new THREE.Vector3(), tv6 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const TRAY_SLOTS: [number, number][] = [[0.07, 0.06], [-0.07, 0.06], [0.0, -0.08], [0.09, -0.04], [-0.09, -0.04]];
const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
const lerpAngle = (a: number, b: number, k: number) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * k; };

function along(path: THREE.Vector3[], cum: number[], d: number, out: THREE.Vector3, tan: THREE.Vector3) {
  const L = cum[cum.length - 1];
  d = Math.min(L, Math.max(0, d));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const a = path[i - 1], b = path[i];
  const k = (d - cum[i - 1]) / Math.max(1e-4, cum[i] - cum[i - 1]);
  out.lerpVectors(a, b, Math.min(1, Math.max(0, k)));
  tan.subVectors(b, a).setY(0);
  if (tan.lengthSq() < 1e-8) tan.set(0, 0, 1);
  tan.normalize();
  return out;
}
function cumOf(pts: THREE.Vector3[]) { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + pts[i].distanceTo(pts[i - 1])); return c; }

export class YachtCrew {
  readonly group = new THREE.Group();
  assets: TownAssets | null = null;
  props: YachtProps | null = null;
  private bartender: Member | null = null;
  private stewards: Member[] = [];
  private walkers: { m: Member; pts: THREE.Vector3[]; cum: number[]; every: number; speed: number; clip: TownClip | null; offset: number }[] = [];
  patrons: Patrons | null = null;
  private all: Member[] = [];
  scale = 0.9;
  error = '';
  ready = false;
  private barSlot = -1;
  private nextProtect = 0;
  plans = new Map<string, DrinkPlan>();
  counts = { posed: 0, visible: 0 };

  constructor(private room: YachtRoom, private cfg: RoomYachtConfig) { this.group.name = 'yacht:crew'; }

  async load(unitsUrl: string, patronUnitsUrl: string, toWorld: (p: THREE.Vector3) => THREE.Vector3, alive: () => boolean) {
    try {
      const assets = await TownAssets.load(unitsUrl, ANIMS_URL);
      if (!alive()) return;
      this.assets = assets;
      this.scale = Math.min(1.15, Math.max(0.7, (this.cfg.crewHeight ?? 1.62) / MODEL_H));
      const unit = (role: string, want?: string) => {
        for (const u of [want, ...(ROLE_UNITS[role] ?? [])]) if (u && assets.templates.has(u)) return u;
        return assets.templates.keys().next().value as string;
      };
      const mk = (u: string): Member => {
        const npc = new TownNpc(assets, u, this.group);
        npc.root.scale.setScalar(this.scale);
        npc.root.visible = false;
        const m: Member = { npc, unit: u, fade: 0, protect: 1, handL: npc.root.getObjectByName('Hand_L') ?? null, handR: npc.root.getObjectByName('Hand_R') ?? null, shown: false, walk: 1 };
        this.all.push(m);
        return m;
      };
      if (this.room.bar) {
        this.bartender = mk(unit('bartender', this.cfg.bartender));
        this.bartender.npc.root.position.copy(this.room.bar.pos);
        this.bartender.npc.root.rotation.y = Math.atan2(this.room.bar.fwd.x, this.room.bar.fwd.z);
      }
      if (this.room.service) {
        this.stewards.push(mk(unit('steward', this.cfg.steward)));
        this.stewards.push(mk(unit('stewardess', this.cfg.stewardess)));
      }
      // ambient walkers: one per route (scene.json `routes` entries override the defaults)
      const seed = yachtHash('yacht-routes', this.cfg.seed ?? 0);
      let wi = 0;
      for (const [letter, pts] of this.room.routes) {
        const rc = (this.cfg.routes ?? []).find((r) => r.route === letter);
        const h = yachtHash(seed, letter);
        const pool = ROLE_UNITS.walker.filter((u) => assets.templates.has(u));
        const who = rc?.who && assets.templates.has(rc.who) ? rc.who : rc?.who ? unit(rc.who) : pool[h % Math.max(1, pool.length)] ?? unit('walker');
        const m = mk(who);
        const every = Math.max(20, rc?.every ?? 60 + (h % 60));
        const speed = Math.min(1.8, Math.max(0.5, rc?.speed ?? 1.05));
        const clipName = rc?.clip && assets.clips.has(rc.clip) ? rc.clip : assets.clips.has('ual_walk_formal') ? assets.variant('walk', h, assets.cycle.walk ?? 1.39) : 'ual_walk';
        const clip = assets.clips.get(clipName) ?? assets.clips.get('ual_walk') ?? null;
        this.walkers.push({ m, pts, cum: cumOf(pts), every, speed, clip, offset: rc?.offset ?? yachtRand(h, 5) * every + wi * 17 });
        wi++;
      }
      // guests (the traffic Patrons: same units, stationary, clip phase from the clock, face fade)
      const pl = (this.cfg.patrons ?? []).filter((p) => Array.isArray(p.position)).slice(0, 12);
      if (pl.length) {
        const P = new Patrons({ scale: this.scale, list: pl.map((p, i) => {
          const a = THREE.MathUtils.degToRad(p.facing ?? 0);
          return { name: `YACHT_GUEST_${i}`, unit: assets.templates.has(p.unit) ? p.unit : unit('walker', undefined), clip: p.clip ?? (p.sit ? 'ual_sitting_idle' : 'ual_idle_talking'), sit: p.sit ? 1 : 0, position: p.position, facing: [Math.sin(a), 0, Math.cos(a)] as [number, number, number] };
        }) });
        this.patrons = P;
        this.group.add(P.group);
        await P.load(patronUnitsUrl, toWorld, alive);
      }
      // props: the crew GLB's PROP_flute / PROP_tray / PROP_bottle when it has them
      const atlasMat = assets.atlas ? new THREE.MeshToonMaterial({ map: assets.atlas }) : null;
      this.props = new YachtProps(atlasMat, { flute: assets.props.get('flute'), tray: assets.props.get('tray'), bottle: assets.props.get('bottle') });
      this.group.add(this.props.group);
      this.ready = true;
    } catch (e) {
      this.error = String(e);
      console.warn('[yacht] crew failed to load', e);
    }
  }

  // ---------------------------------------------------------------- drink plans (pure functions of room + host seat)
  /** host = the host's spot (floor position + facing), face = their face centre; spot = SPOT index */
  planDrink(host: { pos: THREE.Vector3; fwd: THREE.Vector3; spot: number; face: THREE.Vector3 | null }, rays: RoomRays | null): DrinkPlan | null {
    const S = this.room.service;
    if (!S) return null;
    const key = `${host.spot}|${host.pos.x.toFixed(2)},${host.pos.z.toFixed(2)}`;
    const hit = this.plans.get(key);
    if (hit) return hit;
    // the table point: the host's own YACHT_DRINK_xx, else the nearest one within 2.5 m
    let anchor = this.room.drinks.get(host.spot) ?? null;
    if (!anchor) {
      let best = 2.5;
      for (const p of this.room.drinks.values()) { const d = Math.hypot(p.x - host.pos.x, p.z - host.pos.z); if (d < best) { best = d; anchor = p; } }
    }
    const floorY = S.pos.y;
    const stand = new THREE.Vector3();
    const away = new THREE.Vector3();
    if (anchor) {
      away.set(anchor.x - host.pos.x, 0, anchor.z - host.pos.z);
      if (away.lengthSq() < 1e-4) away.copy(host.fwd);
      away.normalize();
      stand.set(anchor.x, floorY, anchor.z).addScaledVector(away, 0.42);
    } else {
      const side = tv.crossVectors(UP, host.fwd).normalize();
      stand.copy(host.pos).setY(floorY).addScaledVector(host.fwd, 0.85).addScaledVector(side, 0.45);
    }
    // the walk: straight from the service door, else via one route point with both legs clear (knee + chest rays)
    const clear = (a: THREE.Vector3, b: THREE.Vector3) => {
      if (!rays) return true;
      for (const hgt of [0.45, 1.2]) if (!rays.clear(tv2.copy(a).setY(floorY + hgt), tv3.copy(b).setY(floorY + hgt))) return false;
      return true;
    };
    let path = [S.pos.clone(), stand.clone()];
    if (!clear(S.pos, stand)) {
      let best = Infinity, via: THREE.Vector3 | null = null;
      const cands: THREE.Vector3[] = [];
      for (const r of this.room.routes.values()) cands.push(...r);
      for (const w of cands) {
        const d = S.pos.distanceTo(w) + w.distanceTo(stand);
        if (d < best && clear(S.pos, w) && clear(w, stand)) { best = d; via = w; }
      }
      if (via) path = [S.pos.clone(), via.clone().setY(floorY), stand.clone()];
    }
    // step out of the door first (0.6 m along its +Z) so the first leg reads as "coming in"
    const door = S.pos.clone().addScaledVector(S.fwd, 0.6);
    if (door.distanceTo(path[1]) > 0.8) path.splice(1, 0, door);
    const cum = cumOf(path);
    const L = cum[cum.length - 1];
    const v = 1.05 * (this.scale / 0.9);
    const target = host.face ? host.face.clone() : host.pos.clone().setY(host.pos.y + 1.2);
    const faceTo = anchor ? tv4.set(anchor.x - stand.x, 0, anchor.z - stand.z) : tv4.set(target.x - stand.x, 0, target.z - stand.z);
    const faceYaw = Math.atan2(faceTo.x, faceTo.z);
    const slots: THREE.Vector3[] = [];
    let tableYaw = 0;
    if (anchor) {
      const side = new THREE.Vector3().crossVectors(UP, away).normalize();
      tableYaw = Math.atan2(away.x, away.z);
      for (const k of [0, -1, 1]) slots.push(anchor.clone().addScaledVector(side, 0.085 * k).addScaledVector(away, k ? -0.03 : 0.02));
    }
    const base = 2 * (L / v) + 2 * TURN + OFFER + NOD;
    const plan: DrinkPlan = { path, cum, L, v, stand, faceYaw, target, anchor, slots, tableYaw, dur: base, durClear: base + CLEAR, key };
    if (this.plans.size > 16) this.plans.clear();
    this.plans.set(key, plan);
    return plan;
  }

  // ---------------------------------------------------------------- per frame
  /** t = clock (s); drinks = the drink items (with their plans) near now; pourAt = champagne start at the bar (s) or null */
  update(t: number, dt: number, cam: THREE.PerspectiveCamera, lodBias: number, crewOn: boolean, drinks: { it: YachtItem; plan: DrinkPlan }[], pourAt: number | null, faces: THREE.Vector3[]) {
    if (!this.ready || !this.assets) return;
    const A = this.assets;
    this.counts.posed = 0; this.counts.visible = 0;
    for (const m of this.all) m.shown = false;
    const props = this.props!;
    props.begin();
    for (const tr of props.trays) tr.visible = false;
    if (crewOn) {
      this.updateBartender(t, pourAt);
      this.updateWalkers(t);
      this.updateDrinks(t, drinks);
    }
    // LOD, fades (protect is refreshed 4× / s by the scene), visibility
    for (const m of this.all) {
      const want = m.shown ? m.protect : 0;
      m.fade += Math.sign(want - m.fade) * Math.min(Math.abs(want - m.fade), dt / 0.35);
      if (!m.shown && m.fade <= 0.001) { if (m.npc.root.visible) m.npc.root.visible = false; continue; }
      const d = m.npc.root.position.distanceTo(cam.position);
      m.npc.setLod(lodBias < 1.2 ? 1 : d < 7 * lodBias ? 0 : 1);
      m.npc.setInk(d < 6);
      m.npc.setOpacity(m.fade * m.walk);
      if (m.npc.root.visible) this.counts.visible++;
    }
    props.end();
    this.patrons?.update(t, dt, cam, crewOn ? faces : faces, lodBias);
    if (this.patrons) this.patrons.group.visible = crewOn;
  }

  private show(m: Member, fade: number) { m.shown = true; m.walk = Math.max(0, Math.min(1, fade)); this.counts.posed++; }

  private clip(name: string): TownClip | null { return this.assets!.clips.get(name) ?? this.assets!.clips.get('ual_idle') ?? null; }

  private updateBartender(t: number, pourAt: number | null) {
    const b = this.bartender;
    if (!b) return;
    this.show(b, 1);
    const SLOT = 6.5;
    const s = Math.floor(t / SLOT);
    const pick = (k: number) => { const n = BAR_IDLES[yachtHash('bar', k) % BAR_IDLES.length]; return this.clip(n); };
    let a = pick(s), ta = t - s * SLOT;
    let bb: TownClip | null = pick(s - 1), tb = SLOT + ta, w = 1 - smooth(ta / 0.6);
    if (pourAt !== null && t > pourAt - 1 && t < pourAt + 3.2) {
      const u = t - (pourAt - 1);
      a = this.clip('ual_interact'); ta = Math.min(u, 2.0) * 1.0;
      bb = pick(s); tb = t - s * SLOT; w = 1 - smooth(u / 0.4);
      if (u > 3.6) w = smooth((u - 3.6) / 0.6);
    }
    if (!a) return;
    const loopT = (c: TownClip, x: number) => (c.loop ? x : x % Math.max(0.1, c.dur));
    b.npc.pose(a, loopT(a, ta), bb, bb ? loopT(bb, tb) : 0, bb ? Math.max(0, w) : 0);
    b.npc.root.updateMatrixWorld(true);
    if (s !== this.barSlot) this.barSlot = s;
  }

  private updateWalkers(t: number) {
    for (const w of this.walkers) {
      const L = w.cum[w.cum.length - 1];
      const dur = L / w.speed;
      const u = ((t + w.offset) % w.every + w.every) % w.every;
      if (u >= dur || !w.clip) continue;
      const d = u * w.speed;
      const p = along(w.pts, w.cum, d, w.m.npc.root.position, tv);
      void p;
      w.m.npc.root.rotation.y = Math.atan2(tv.x, tv.z);
      const cyc = (this.assets!.cycle[w.clip.name] ?? 1.39) * this.scale;
      w.m.npc.pose(w.clip, (d / cyc) * w.clip.dur, null, 0, 0);
      this.show(w.m, Math.min(1, u / 0.6, (dur - u) / 0.6));
    }
  }

  private timeline(it: YachtItem, plan: DrinkPlan) {
    const clears = !!plan.anchor && it.n > 0 && it.n % 3 === 0;
    const tA = plan.L / plan.v;
    const tTurn = tA + TURN;
    const tClear = tTurn + (clears ? CLEAR : 0);
    const tOffer = tClear + OFFER;
    const tNod = tOffer + NOD;
    const tBack = tNod + TURN;
    const tEnd = tBack + tA;
    return { clears, tA, tTurn, tClear, tOffer, tNod, tBack, tEnd, place: tClear + 1.35 };
  }

  private updateDrinks(t: number, drinks: { it: YachtItem; plan: DrinkPlan }[]) {
    const props = this.props!;
    // table flutes (persist between deliveries); a running clear takes them onto its tray
    let table = 0, tablePlan: DrinkPlan | null = null, lastN = -1;
    for (const { it, plan } of drinks) {
      if (!plan.anchor) continue;
      const tl = this.timeline(it, plan);
      if (t >= it.start / 1000 + tl.place && it.n > lastN) { lastN = it.n; table = (it.n % 3) + 1; tablePlan = plan; }
    }
    let tableShown = table;
    for (const { it, plan } of drinks) {
      const u = t - it.start / 1000;
      const tl = this.timeline(it, plan);
      if (u < 0 || u >= tl.tEnd) continue;
      const m = this.stewards[it.n % this.stewards.length];
      if (!m) continue;
      const npc = m.npc, root = npc.root;
      const A = this.assets!;
      const walk = A.clips.get('ual_walk_carry') ?? A.clips.get('ual_walk') ?? null;
      const idle = this.clip('ual_idle')!;
      const cyc = walk ? (A.cycle[walk.name] ?? 1.39) * this.scale : 1;
      let carry = 1;                 // 1 = tray between both hands (walking), 0 = tray on the left hand
      let onTray = 2;                // flutes on the tray: 2 going in (one for the host + a spare)
      let cleared = 0;               // empties picked up from the table
      let handFlute = -1;            // 0…1 progress of the offered flute (tray → hand → table), -1 = none
      const side = (dir: number, d: number, L: number) => {
        // walk on the right of the line (steward pairs pass each other); pinned at both ends
        const k = Math.min(1, d / 1.0, (L - d) / 1.0);
        tv2.crossVectors(tv, UP).normalize().multiplyScalar(-0.22 * k * dir);
        root.position.add(tv2);
      };
      if (u < tl.tA) {
        const d = u * plan.v;
        along(plan.path, plan.cum, d, root.position, tv);
        side(1, d, plan.L);
        root.rotation.y = Math.atan2(tv.x, tv.z);
        if (walk) npc.pose(walk, (d / cyc) * walk.dur, null, 0, 0);
      } else if (u < tl.tBack) {
        root.position.copy(plan.stand);
        along(plan.path, plan.cum, plan.L, tv3, tv);
        const inYaw = Math.atan2(tv.x, tv.z), outYaw = inYaw + Math.PI;
        let yaw = plan.faceYaw;
        let a: TownClip = idle, ta = u - tl.tA, b: TownClip | null = walk, tb = walk ? (plan.L / cyc) * walk.dur : 0, w = 1 - smooth((u - tl.tA) / XF);
        if (u < tl.tTurn) yaw = lerpAngle(inYaw, plan.faceYaw, smooth((u - tl.tA) / TURN));
        else if (u < tl.tClear) {
          const c = this.clip('ual_pick_up_table')!; const k = (u - tl.tTurn) / CLEAR;
          a = c; ta = k * c.dur; b = idle; tb = u - tl.tA; w = 1 - smooth((u - tl.tTurn) / XF);
          const took = smooth((k - 0.35) / 0.3);
          cleared = took > 0.5 ? 3 : 0;
          if (took > 0.5) tableShown = 0;
        } else if (u < tl.tOffer) {
          const c = this.clip('ual_interact')!; const k = (u - tl.tClear) / OFFER;
          a = c; ta = k * c.dur; b = tl.clears ? this.clip('ual_pick_up_table') : idle; tb = b === idle ? u - tl.tA : (b?.dur ?? 0); w = 1 - smooth((u - tl.tClear) / XF);
          handFlute = k;
          cleared = tl.clears ? 3 : 0;
        } else if (u < tl.tNod) {
          const c = A.clips.get('ual_yes') ?? idle; const k = u - tl.tOffer;
          a = c; ta = Math.min(k, c.dur - 0.01); b = this.clip('ual_interact'); tb = b?.dur ?? 0; w = 1 - smooth(k / XF);
          cleared = tl.clears ? 3 : 0;
          onTray = 1;
        } else {
          yaw = lerpAngle(plan.faceYaw, outYaw, smooth((u - tl.tNod) / TURN));
          const c = A.clips.get('ual_yes') ?? idle;
          a = idle; ta = u; b = c; tb = c.dur - 0.01; w = 1 - smooth((u - tl.tNod) / XF);
          cleared = tl.clears ? 3 : 0; onTray = 1;
        }
        if (u >= tl.tOffer) onTray = 1;
        root.rotation.y = yaw;
        npc.pose(a, a.loop ? ta : Math.min(ta, a.dur - 0.01), b, b ? (b.loop ? tb : Math.min(tb, b.dur - 0.01)) : 0, b ? Math.max(0, w) : 0);
        carry = u < tl.tA + 0.35 ? 1 - smooth((u - tl.tA) / 0.35) : u > tl.tBack - 0.35 ? smooth((u - tl.tBack + 0.35) / 0.35) : 0;
        if (u >= tl.tClear) cleared = tl.clears ? 3 : 0;
        // look at the host while offering
        if (u > tl.tTurn && u < tl.tNod + 0.3) { root.updateMatrixWorld(true); npc.lookAt(plan.target, smooth((u - tl.tTurn) / 0.5) * (1 - smooth((u - tl.tNod) / 0.3))); }
      } else {
        const d = (u - tl.tBack) * plan.v;
        along(plan.path, plan.cum, plan.L - d, root.position, tv);
        tv.negate();
        side(1, d, plan.L);
        root.rotation.y = Math.atan2(tv.x, tv.z);
        if (walk) npc.pose(walk, ((plan.L + d) / cyc) * walk.dur, null, 0, 0);
        onTray = 1; cleared = tl.clears ? 3 : 0;
      }
      const fade = Math.min(1, u / FADE, (tl.tEnd - u) / FADE);
      this.show(m, fade);
      // the tray: between the hands while walking, on the left hand while standing
      root.updateMatrixWorld(true);
      const tray = props.trays[it.n % 2];
      if (tray && m.handL && m.handR) {
        const l = m.handL.getWorldPosition(tv2), r = m.handR.getWorldPosition(tv3);
        const mid = tv4.addVectors(l, r).multiplyScalar(0.5);
        const fwd = tv.set(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
        mid.addScaledVector(fwd, 0.06 * this.scale).y += 0.035 * this.scale;
        const left = tv5.copy(l).addScaledVector(fwd, 0.1 * this.scale).addScaledVector(tv6.crossVectors(UP, fwd).normalize(), 0.08 * this.scale);
        left.y += 0.05 * this.scale;
        tray.position.lerpVectors(left, mid, carry);
        tray.rotation.set(0, root.rotation.y, 0);
        tray.scale.setScalar(this.scale / 0.9);
        tray.visible = fade * m.fade > 0.5;
        if (tray.visible) {
          const nOn = onTray + cleared;
          const cy = Math.cos(root.rotation.y), sy = Math.sin(root.rotation.y);
          for (let i = 0; i < nOn && i < TRAY_SLOTS.length; i++) {
            const si = i === 0 && handFlute >= 0 ? -1 : i;       // slot 0 = the one being offered
            if (si < 0) continue;
            const [x, z] = TRAY_SLOTS[si];
            tv2.set(tray.position.x + (x * cy + z * sy) * (this.scale / 0.9), tray.position.y + 0.013, tray.position.z + (-x * sy + z * cy) * (this.scale / 0.9));
            props.flute(tv2, root.rotation.y, this.scale / 0.9);
          }
        }
        // the offered flute: tray → right hand → the table (or stays in the hand with no table)
        if (handFlute >= 0 && m.handR) {
          const [x, z] = TRAY_SLOTS[0];
          const cy = Math.cos(root.rotation.y), sy = Math.sin(root.rotation.y);
          const from = tv2.set(tray.position.x + x * cy + z * sy, tray.position.y + 0.013, tray.position.z - x * sy + z * cy);
          const hand = m.handR.getWorldPosition(tv3); hand.y -= 0.09 * this.scale;
          const slot = plan.slots.length ? plan.slots[Math.min(2, it.n % 3)] : null;
          const k1 = smooth(handFlute / 0.3), k2 = slot ? smooth((handFlute - 0.55) / 0.2) : 0;
          const p = tv4.lerpVectors(from, hand, k1);
          if (slot) p.lerp(slot, k2);
          if ((handFlute < 0.75 || !slot) && m.fade > 0.5) props.flute(p, root.rotation.y, this.scale / 0.9);
        }
      }
    }
    // table flutes
    if (tablePlan && tablePlan.anchor) for (let i = 0; i < Math.min(3, tableShown); i++) props.flute(tablePlan.slots[i], tablePlan.tableYaw + i * 1.3, this.scale / 0.9);
  }

  /** Face / React-screen protection: 1 = shown, 0 = fading out (the scene refreshes this 4× / s). */
  protect(cam: THREE.PerspectiveCamera, rects: { x0: number; y0: number; x1: number; y1: number }[]) {
    for (const m of this.all) {
      m.protect = 1;
      if (!m.shown) continue;
      const root = m.npc.root;
      // never a body right in front of the lens (a steward walking past a close camera)
      if (Math.hypot(root.position.x - cam.position.x, root.position.z - cam.position.z) < 2.8 * this.scale) { m.protect = 0; continue; }
      if (!rects.length) continue;
      m.npc.headWorld(tv); tv.y += 0.12 * this.scale;
      tv2.copy(root.position);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      const side = tv3.set(1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(0.3 * this.scale);
      for (const p of [tv, tv2, tv4.copy(tv).lerp(tv2, 0.4).add(side), tv4.copy(tv).lerp(tv2, 0.4).sub(side)]) {
        const q = p.clone().project(cam);
        if (q.z > 1) continue;
        const x = (q.x + 1) / 2, y = (1 - q.y) / 2;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (x0 === Infinity) continue;
      for (const r of rects) if (!(x1 < r.x0 || x0 > r.x1 || y1 < r.y0 || y0 > r.y1)) { m.protect = 0; break; }
    }
  }

  get count() { return this.all.length + (this.patrons?.count ?? 0); }

  info() {
    return { units: this.all.map((m) => m.unit), walkers: this.walkers.length, stewards: this.stewards.length, bartender: !!this.bartender, patrons: this.patrons?.count ?? 0,
      posed: this.counts.posed, visible: this.counts.visible, flutes: this.props?.count ?? 0, faded: this.all.filter((m) => m.shown && m.protect === 0).length, error: this.error || this.patrons?.error || undefined };
  }

  dispose() {
    for (const m of this.all) m.npc.dispose();
    this.all = []; this.walkers = []; this.stewards = []; this.bartender = null;
    this.patrons?.dispose(); this.patrons = null;
    this.props?.dispose(); this.props = null;
    this.group.removeFromParent();
    this.ready = false;
  }
}
