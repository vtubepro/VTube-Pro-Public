// The Trail v2 — camp as a playable space (DESIGN_V2.md §5). At dusk the wagon parks; tasks appear around it in the
// world. Every task is physical (carry logs / tent bundles / feed into place) or a timing hold (E inside the rhythm
// band — mashing does nothing, holding through the off-beat undoes work), so idling and spamming both lose to play.
// Separate stats (fire, meals, tents, animals, repair, watch) reward spreading out. Night: a raid (fewer with a watch).
// Dawn: the report applies the stats to the run and the wagon rolls again.
import { applyEffects } from '../../../../shared/trail/rules.ts';
import type { V3 } from '../../../../shared/trail/levels.ts';
import type { CampState, CampTask } from '../../../../shared/trail/types.ts';
import { BTN } from '../../../../shared/trail/wire.ts';
import type { SimCtx } from './ctx.ts';
import type { Ent, PlayerPhys } from './world.ts';

/** Seconds of dusk (tasks) before night falls; the night's length. */
export const CAMP_DUSK = 85, CAMP_NIGHT = 40;
const BAND_PERIOD = 1.6;
/** The rhythm band: on for ~43 % of each period (a task's phase offsets it). */
export const bandOn = (t: number, ph: number) => Math.sin((t / BAND_PERIOD + ph) * Math.PI * 2) > 0.22;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

interface Thief { id: number; loot: number; fleeing: boolean }
interface HoldTask { task: CampTask; stat: 'meals' | 'repair' | 'animals' | 'tent'; rate: number; need?: () => string | null; tent?: number }

export class Camp {
  readonly state: CampState;
  private fireP: V3; private troughP: V3; private watchP: V3; private benchP: V3;
  private tentSpots: { p: V3; stage: number; progress: number }[] = [];
  private props = new Set<number>();
  private hold = new Map<string, number>();
  private holds: HoldTask[] = [];
  private thieves: Thief[] = [];
  private raidAt = -1;
  private raided = { stole: 0, caught: 0, came: 0 };
  private nightAt = CAMP_DUSK;
  private rear = -2; private hw = 1.2;
  private endAt = CAMP_DUSK + CAMP_NIGHT;
  done = false;

  constructor(private c: SimCtx) {
    const J = c.journey;
    // the wagon's footprint (theme wagons differ): half width + rear end
    let hw = 1.2, rear = -2;
    for (const col of c.phys.wagonSpec.cols) { const he = col.he ?? [col.r ?? 0.5, col.hh ?? 0.5, col.r ?? 0.5]; hw = Math.max(hw, Math.abs(col.p[0]) + he[0]); rear = Math.min(rear, col.p[2] - he[2]); }
    this.rear = rear; this.hw = hw;
    // a spot you can walk to from the wagon (islands: no void or cliff on the way), else pulled in closer
    const walkable = (side: number, ahead: number) => this.walkable(side, ahead);
    const safe = (side: number, ahead: number): V3 => { for (let k = 1; k >= 0.2; k -= 0.1) if (walkable(side * k, ahead * k)) return J.frame(side * k, ahead * k, 0.1); return J.frame(side * 0.2, ahead * 0.2, 0.1); };
    this.fireP = safe(hw + 5, 1);
    this.troughP = safe(-(hw + 1.6), 5.5);
    this.benchP = J.frame(-(hw + 0.9), -0.4, 0.1);
    this.watchP = safe(-9, -7);
    this.tentSpots = [safe(11, -3), safe(13, 3.5), safe(10.5, 9)].map((p) => ({ p, stage: 0, progress: 0 }));
    const tasks: CampTask[] = [
      { id: 'fire', label: 'Firewood', icon: 'fire', p: this.fireP, r: 2.2, progress: 0.1, who: [], hint: 'Carry logs from the trees and toss them into the fire' },
      { id: 'cook', label: 'Cook', icon: 'food', p: [this.fireP[0] + 1.2, this.fireP[1], this.fireP[2]], r: 1.7, progress: 0, who: [], hint: 'Hold E at the pot in the rhythm (needs a fire)' },
      ...this.tentSpots.map((s, i): CampTask => ({ id: `tent${i}`, label: `Tent ${i + 1}`, icon: 'tent', p: s.p, r: 1.7, progress: 0, who: [], hint: 'Bring a tent bundle, then hold E in the rhythm' })),
      { id: 'animals', label: this.c.deck.text.draft ?? 'Animals', icon: 'draft', p: this.troughP, r: 2.2, progress: 0, who: [], hint: 'Carry feed to the trough, then hold E to brush them' },
      { id: 'repair', label: 'Repairs', icon: 'wheel', p: this.benchP, r: 1.8, progress: 0, who: [], hint: 'Hold E at the wagon in the rhythm' },
      { id: 'watch', label: 'Night watch', icon: 'watch', p: this.watchP, r: 2.4, progress: 0, who: [], hint: 'After dark: stand at the lantern post' },
    ];
    tasks.forEach((t, i) => { t.ph = (i * 0.37) % 1; });
    this.state = { fire: 10, meals: 0, tents: 0, repair: 0, animals: 0, watch: 0, night: false, t: 0, endsAt: Math.round((c.time + this.endAt) * 1000), tasks };
    const T = (id: string) => tasks.find((t) => t.id === id)!;
    this.holds = [
      { task: T('cook'), stat: 'meals', rate: 6.5, need: () => (this.state.fire < 25 ? 'The fire is too small to cook' : null) },
      { task: T('animals'), stat: 'animals', rate: 3.5 },
      { task: T('repair'), stat: 'repair', rate: 4 },
      ...this.tentSpots.map((_, i): HoldTask => ({ task: T(`tent${i}`), stat: 'tent', rate: 9, tent: i, need: () => (this.tentSpots[i].stage ? null : 'Bring a tent bundle first') })),
    ];
    this.spawnProps();
    c.toast('Camp! Split up: firewood, cooking, tents, the animals, repairs, and someone on watch after dark.', 'good');
  }

  private spawnProps() {
    const J = this.c.journey, ph = this.c.phys, r = this.c.misc;
    const add = (sub: string, p: V3, yaw = 0) => { const e = ph.addProp(sub, p, { yaw, owned: false }); this.props.add(e.id); return e; };
    // firewood in a ring 12–26 m out (away from the wagon side), one big log for two people or a big one
    for (let i = 0; i < 9; i++) {
      const a = r.range(-1.9, 1.9), d = r.range(12, 26);
      const side = 6.5 + Math.cos(a) * d, ahead = 1 + Math.sin(a) * d;
      if (!this.walkable(side, ahead)) continue;   // not over the void / down a cliff
      const p = J.frame(side, ahead, 0.4);
      add('log', p, r.range(0, 6.28));
    }
    add('log_big', J.frame(r.chance(0.5) ? 22 : -14, r.range(-10, 12), 0.6), r.range(0, 6.28));
    // tent bundles + feed at the wagon's tail
    for (let i = 0; i < this.tentSpots.length; i++) add('tent_bundle', J.frame(-1.2 + i * 1.1, this.rear - 1.6, 0.4));
    for (let i = 0; i < 2; i++) add('feed_sack', J.frame(-(this.hw + 1.2), this.rear - 0.4 - i * 0.8, 0.4));
  }

  /** One sim step. Returns true when the camp is over (dawn). */
  step(dt: number): boolean {
    const c = this.c, st = this.state, t = (st.t += dt);
    const ps = c.active();
    st.fire = clamp(st.fire - dt * (st.night ? 0.35 : 0.55), 0, 100);
    // things carried into place
    for (const id of [...this.props]) {
      const e = c.phys.ents.get(id);
      if (!e?.body || e.gone) { this.props.delete(id); continue; }
      const p = c.phys.pos(e.body);
      const sub = e.info.sub;
      if ((sub === 'log' || sub === 'log_big') && this.near(p, this.fireP, 2)) {
        st.fire = clamp(st.fire + (sub === 'log_big' ? 40 : 16), 0, 100);
        c.fx('fire', this.fireP, sub === 'log_big' ? 12 : 5);
        this.consume(e, sub === 'log_big' ? 'A whole tree into the fire!' : '');
      } else if (sub === 'feed_sack' && this.near(p, this.troughP, 2.2)) {
        st.animals = clamp(st.animals + 40, 0, 100);
        c.fx('sparkle', this.troughP);
        this.consume(e, `The ${c.deck.text.draft ?? 'animals'} dig in.`);
      } else if (sub === 'tent_bundle') {
        const s = this.tentSpots.find((x) => !x.stage && this.near(p, x.p, 1.9));
        if (s) { s.stage = 1; s.progress = Math.max(s.progress, 0.25); c.fx('dust', s.p); this.consume(e, ''); }
      }
    }
    // hold-E tasks (rhythm)
    for (const h of this.holds) h.task.who = [];
    for (const p of ps) {
      const holding = (p.input.buttons & BTN.use) !== 0 && !p.grab && p.seat < 0;
      const ht = holding ? (this.hold.get(p.id) ?? 0) + dt : 0;
      this.hold.set(p.id, ht);
      if (!holding || ht < 0.25) continue;                                // a tap / mash does nothing
      const f = c.phys.feet(p);
      const h = this.holds.find((x) => this.near(f, x.task.p, x.task.r + 0.4));
      if (!h) continue;
      h.task.who.push(p.id);
      const why = h.need?.();
      if (why) { if (Math.floor(t * 2) !== Math.floor((t - dt) * 2) && Math.floor(t) % 4 === 0) c.toast(why, 'info', p.id); continue; }
      const k = (bandOn(c.time, h.task.ph ?? 0) ? 1 : -0.5) * h.rate * dt * this.roleK(p, h.stat);
      if (h.stat === 'tent') { const s = this.tentSpots[h.tent!]; s.progress = clamp(s.progress + k / 100, 0.25, 1); }
      else st[h.stat] = clamp(st[h.stat] + k, 0, 100);
    }
    // watch (night): standing at the post
    const watchT = st.tasks.find((x) => x.id === 'watch')!;
    watchT.who = ps.filter((p) => this.near(c.phys.feet(p), this.watchP, 2.6)).map((p) => p.id);
    // a small lookout on a big friend's shoulders sees twice as far
    const lookout = ps.some((p) => p.mount && watchT.who.includes(p.mount));
    if (st.night && watchT.who.length) st.watch = clamp(st.watch + dt * 100 / 14 * (lookout ? 2 : 1), 0, 100);
    // firewood carriers
    const fireT = st.tasks.find((x) => x.id === 'fire')!;
    fireT.who = ps.filter((p) => { const e = p.grab ? c.phys.ents.get(p.grab.ent) : null; return !!e && (e.info.sub === 'log' || e.info.sub === 'log_big'); }).map((p) => p.id);
    // progress for the HUD
    st.tents = Math.round(this.tentSpots.reduce((a, s) => a + s.progress, 0) / this.tentSpots.length * 100);
    for (const task of st.tasks) {
      task.band = bandOn(c.time, task.ph ?? 0);
      if (task.id === 'fire') task.progress = st.fire / 100;
      else if (task.id === 'cook') task.progress = st.meals / 100;
      else if (task.id === 'animals') task.progress = st.animals / 100;
      else if (task.id === 'repair') task.progress = st.repair / 100;
      else if (task.id === 'watch') task.progress = st.watch / 100;
      else if (task.id.startsWith('tent')) task.progress = this.tentSpots[Number(task.id.slice(4))].progress * (this.tentSpots[Number(task.id.slice(4))].stage ? 1 : 0);
    }
    // night falls (the timer, or everything done early)
    const allDone = st.fire > 60 && st.meals > 85 && st.tents > 85 && st.animals > 85 && st.repair > 85;
    if (!st.night && (t >= this.nightAt || allDone)) this.nightfall();
    if (st.night) this.stepRaid(dt);
    if (Math.floor(t * 4) !== Math.floor((t - dt) * 4)) c.markDirty();
    return st.night && t >= this.endAt && !this.thieves.length;
  }
  /** Everyone pressed Continue: skip ahead (dusk → night, night → dawn once the raid is over). */
  hurry() {
    const st = this.state;
    if (!st.night) this.nightfall();
    else if (!this.thieves.length) this.endAt = Math.min(this.endAt, st.t + 1);
  }
  private nightfall() {
    const c = this.c, st = this.state;
    st.night = true;
    this.nightAt = st.t;
    this.endAt = st.t + CAMP_NIGHT;
    st.endsAt = Math.round((c.time + CAMP_NIGHT) * 1000);
    c.journey.st.tod = 0.88;
    this.raidAt = st.t + c.misc.range(7, 14);
    c.toast('Night falls. Keep the fire going, and put someone on watch.', 'info');
    c.markDirty();
  }
  private stepRaid(dt: number) {
    const c = this.c, st = this.state;
    if (this.raidAt >= 0 && st.t >= this.raidAt) {
      this.raidAt = -1;
      const chance = c.run.food < 30 ? 0 : 0.55 * (1 - (st.watch / 100) * 0.8);
      if (c.misc.chance(chance)) {
        const n = c.misc.int(2, 3);
        const watched = st.watch > 30;
        for (let i = 0; i < n; i++) {
          const a = c.misc.range(0, Math.PI * 2), d = watched ? 34 : 24;
          const w = c.journey.wagonLocal();
          const p: V3 = [w[0] + Math.sin(a) * d, 0, w[2] + Math.cos(a) * d];
          p[1] = c.journey.groundLocal(p[0], p[2]) + 0.5;
          const e = c.phys.addAnimal('thief', p, { kg: 12, speed: 4.3, danger: 0, flee: 30, name: 'thief' });
          e.animal!.state = 'wander';
          this.thieves.push({ id: e.id, loot: 0, fleeing: false });
        }
        this.raided.came = n;
        c.toast(watched ? 'The lookout spots thieves sneaking in! Grab them!' : 'Thieves in the camp! Grab them before they take the food!', 'bad');
        c.emit({ e: 'sound', s: 'hard' });
      }
    }
    // thieves: sneak to the wagon, grab food, run; a player close by scares them; grabbed = caught
    const w = c.journey.wagonLocal();
    for (const th of [...this.thieves]) {
      const e = c.phys.ents.get(th.id);
      if (!e?.body || e.gone) { this.thieves = this.thieves.filter((x) => x !== th); continue; }
      const pos = c.phys.pos(e.body);
      if (c.phys.holders(th.id).length) {
        this.raided.caught++;
        if (th.loot) { c.run.food += th.loot; c.syncAll(); c.toast(`Caught one with ${th.loot} lbs of food. Got it back!`, 'good'); }
        c.fx('confetti', pos); c.phys.remove(e, 'caught');
        this.thieves = this.thieves.filter((x) => x !== th);
        c.markDirty();
        continue;
      }
      let tx = w[0], tz = w[2], speed = 3.2;
      let scared: PlayerPhys | null = null, sd = 3.8;
      for (const p of c.active()) { const f = c.phys.feet(p); const d = Math.hypot(f[0] - pos[0], f[2] - pos[2]); if (d < sd) { sd = d; scared = p; } }
      if (th.fleeing || scared) {
        const from = scared ? c.phys.feet(scared) : w;
        const dx = pos[0] - from[0], dz = pos[2] - from[2], l = Math.hypot(dx, dz) || 1;
        tx = pos[0] + dx / l * 10; tz = pos[2] + dz / l * 10; speed = th.fleeing ? 4.6 : 5;
        if (th.fleeing && Math.hypot(pos[0] - w[0], pos[2] - w[2]) > 38) {
          this.raided.stole += th.loot;
          c.phys.remove(e, 'escaped');
          this.thieves = this.thieves.filter((x) => x !== th);
          continue;
        }
      } else if (Math.hypot(pos[0] - w[0], pos[2] - w[2]) < 2.6) {
        th.loot = Math.min(c.run.food, c.misc.int(15, 30));
        c.run.food = Math.max(0, c.run.food - th.loot);
        th.fleeing = true;
        c.toast(`A thief grabbed ${th.loot} lbs of food and ran!`, 'bad');
        c.syncAll(); c.markDirty();
      }
      const dx = tx - pos[0], dz = tz - pos[2], l = Math.hypot(dx, dz) || 1;
      const v = e.body.linvel();
      const zig = Math.sin(c.time * 3 + th.id) * 0.5;
      const vx = (dx / l + dz / l * zig) * speed, vz = (dz / l - dx / l * zig) * speed;
      e.body.setLinvel({ x: v.x + (vx - v.x) * Math.min(1, dt * 4), y: v.y, z: v.z + (vz - v.z) * Math.min(1, dt * 4) }, true);
      e.body.setRotation({ x: 0, y: Math.sin(Math.atan2(vx, vz) / 2), z: 0, w: Math.cos(Math.atan2(vx, vz) / 2) }, true);
      e.animal!.state = th.fleeing || scared ? 'flee' : 'wander';
    }
  }
  /** Dawn: apply the stats to the run. Returns the morning report lines. */
  finish(): { lines: string[]; deaths: { id: string; cause: string }[] } {
    const c = this.c, run = c.run, st = this.state, lines: string[] = [], deaths: { id: string; cause: string }[] = [];
    const packed = c.packUp(30);   // the party packs up: cargo lying around the camp goes back in
    c.recount();   // what is physically aboard now IS the inventory (before the night's effects)
    for (const id of this.props) { const e = c.phys.ents.get(id); if (e) c.phys.remove(e); }
    this.props.clear();
    for (const th of this.thieves) { const e = c.phys.ents.get(th.id); if (e) c.phys.remove(e, 'escaped'); }
    const ctx = { target: null, volunteer: null, cause: 'exhaustion' };
    // sleep: a rest day (tents make it a good one)
    const rest = applyEffects(run, c.deck, [{ k: 'rest', n: 1 }], ctx, c.rng);
    deaths.push(...rest.deaths);
    const heal = (n: number) => { for (const m of Object.values(run.party)) if (m.alive && !m.ghost) m.health = clamp(m.health + n, 0, 100); };
    if (st.tents >= 70) { heal(4); lines.push('Tents up: everyone slept well.'); }
    else if (st.tents < 35) { heal(-3); lines.push('Half the party slept in the dirt.'); }
    if (st.meals >= 60) { heal(5); run.morale = clamp(run.morale + 8, 0, 100); lines.push('A hot meal. Morale up.'); }
    else if (st.meals >= 30) { heal(2); lines.push('Something like dinner happened.'); }
    else { run.morale = clamp(run.morale - 5, 0, 100); lines.push('Nobody cooked. Cold rations and sad faces.'); }
    const cold = (c.deck.weather.find((w) => w.id === run.weather)?.health ?? 0) < -1;
    if (st.fire >= 40) { heal(2); lines.push('The fire kept everyone warm.'); }
    else if (cold) { heal(-4); lines.push('The fire died in the cold night.'); }
    if (st.animals >= 50) { run.draftHealth = clamp(run.draftHealth + Math.round(st.animals / 4), 0, 100); lines.push(`The ${c.deck.text.draft ?? 'animals'} are fed and happy.`); }
    // repairs: a broken part is fixed with a spare; with good work and no spare, it's jury-rigged
    if (run.broken.length) {
      const part = run.broken[0];
      if (st.repair >= 70 && run.items[part] > 0) { run.items[part]--; run.broken = run.broken.filter((x) => x !== part); run.limp = false; lines.push(`Fixed the ${part} with a spare.`); }
      else if (st.repair >= 70) { run.limp = true; lines.push(`Jury-rigged the ${part}. It'll hold (slowly).`); }
      else lines.push(`The ${part} is still broken.`);
    } else if (st.repair >= 70) { run.draftHealth = clamp(run.draftHealth + 4, 0, 100); lines.push('The wagon is greased and tight.'); }
    if (packed) lines.push(`Packed ${packed} stray thing${packed > 1 ? 's' : ''} back into the wagon.`);
    if (this.raided.came) lines.push(this.raided.stole ? `Thieves got away with ${this.raided.stole} lbs of food (${this.raided.caught} caught).` : `Thieves came, and left with nothing (${this.raided.caught} caught).`);
    else if (st.watch > 30) lines.push('A quiet night on watch.');
    c.syncAll();
    this.done = true;
    return { lines, deaths };
  }
  /** A bot's camp job: where to stand + whether to hold E now (bots keep to the rhythm, like a good player). */
  botPlan(p: PlayerPhys, idx: number): { to: V3; hold: boolean } | null {
    const st = this.state;
    if (st.night) return { to: this.watchP, hold: false };
    const open = this.holds.filter((h) => !h.need?.() && (h.stat === 'tent' ? this.tentSpots[h.tent!].progress < 1 : st[h.stat] < 95));
    if (!open.length) return null;
    const h = open[idx % open.length];
    const f = this.c.phys.feet(p);
    const at = this.near(f, h.task.p, h.task.r);
    return { to: h.task.p, hold: at && bandOn(this.c.time + 0.1, h.task.ph ?? 0) };
  }
  /** Props of this camp (logs, bundles, feed): bots carry them. */
  carryables(): Ent[] { return [...this.props].map((id) => this.c.phys.ents.get(id)).filter((e): e is Ent => !!e?.body); }
  target(e: Ent): V3 | null {
    const s = e.info.sub;
    if (s === 'log' || s === 'log_big') return this.fireP;
    if (s === 'feed_sack') return this.troughP;
    if (s === 'tent_bundle') return this.tentSpots.find((x) => !x.stage)?.p ?? null;
    return null;
  }
  /** Can you walk from the wagon to (side, ahead) in its frame (no void / cliff on the way)? */
  private walkable(side: number, ahead: number): boolean {
    const J = this.c.journey, n = Math.ceil(Math.hypot(side, ahead));
    for (let i = 1; i <= n; i++) if (J.frame(side * i / n, ahead * i / n)[1] < J.wy - 2) return false;
    return true;
  }
  /** Camp props (logs, bundles, feed) are not cargo. */
  owns(id: number) { return this.props.has(id); }
  private consume(e: Ent, msg: string) { this.props.delete(e.id); this.c.phys.remove(e, 'used'); if (msg) this.c.toast(msg, 'good'); this.c.markDirty(); }
  private near(a: V3, b: V3, r: number) { return (a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2 < r * r && Math.abs(a[1] - b[1]) < 3; }
  private roleK(p: PlayerPhys, stat: string): number {
    const role = this.c.run.party[p.id]?.role;
    if (stat === 'repair' && role === 'carpenter') return 2;
    if (stat === 'animals' && role === 'whisperer') return 2;
    const size = p.st.cls === 'macro' ? (stat === 'tent' ? 1.8 : 0.8) : p.st.cls === 'micro' || p.st.cls === 'small' ? (stat === 'meals' || stat === 'repair' ? 1.3 : 1) : 1;   // big hands raise tents, tiny hands cook + tinker
    if (stat === 'meals' && role === 'medic') return 1.4 * size;
    return size;
  }
}
