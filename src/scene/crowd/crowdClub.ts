// Club activities for the ambient crowd (registered into crowdPlan's EXTRA_PLANS; first user: a club room).
//
//   bartender   ACTIVITY_xx_P01..  stations behind the bar (+Z = facing the counter): shake / pour / wave, slide a round
//               of drinks on 'bits' support and 'bartrick' bits, juggle bottles on 'juggle' bits
//   barflies    ACTIVITY_xx_P01..  stools (extras sit = seat height): drink / flirt / laugh / lean, cheer on support
//   bouncer     frog 0 = the bouncer at the anchor (arms crossed); 'bouncer' bits: walks to _GRAB, lifts frog 1 over
//               his head, carries him to _DOOR (the exit opens), tosses him out towards _EXIT, dusts off, walks back
//   stage       ACTIVITY_xx_P01.. podium / riser dancers (the stage lift raises P03+); 'stagefall' bits: one walks to
//               _EDGE, falls off to _LAND (stars), limps to _STEPS and fades backstage; raids = everyone jumps
//   floorbits   frogs that step out of the mass crowd for a bit: 'conga' (P01..P06 loop), 'danceoff' (two at _RING,
//               taking turns: spin / shuffle / flex), 'crowdsurf' (one rides the hands from _SURF to _SURF2),
//               'proposal' (one kneels, the other swoons, hearts), plus the big-support sign carrier (CLUB_SIGNWALK)
//   vip         ACTIVITY_xx_P01.. VIP frogs: sway with champagne, spray it on 'big' support
//
// Everything is a pure function of (anchors, seed, wall clock, ctx.ext.club: the club engine's bit schedule and
// support events), like every other crowd activity — the same on every page.
import * as THREE from 'three';
import type { CrowdActivity } from './crowdRoom';
import { EXTRA_PLANS, TAG, hash32, rng, type ActivityPlan, type FxOut, type PlanCtx, type Pose } from './crowdPlan';

/** What the club engine hands the planner (ctx.ext.club). Times are wall seconds. */
export interface ClubBit { k: string; at: number; seed: number; dur: number }
export interface ClubFin { k: 'tip' | 'sub' | 'bits' | 'raid' | 'big'; at: number; user: string; usd: number; id: string }
export interface ClubExt { bits: ClubBit[]; fin: ClubFin[]; lift: (t: number) => number; signWalk?: [THREE.Vector3, THREE.Vector3] | null }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => { const k = clamp01(x); return k * k * (3 - 2 * k); };
const yawTo = (a: THREE.Vector3, b: THREE.Vector3) => Math.atan2(b.x - a.x, b.z - a.z);
const club = (ctx: PlanCtx): ClubExt | null => (ctx.ext?.club as ClubExt | undefined) ?? null;
export const bitAt = (ctx: PlanCtx, t: number, kinds: string[]): ClubBit | null => {
  const c = club(ctx); if (!c) return null;
  for (let i = c.bits.length - 1; i >= 0; i--) { const b = c.bits[i]; if (kinds.includes(b.k) && t >= b.at && t < b.at + b.dur) return b; }
  return null;
};
export const finAt = (ctx: PlanCtx, t: number, kinds: ClubFin['k'][], win: number): ClubFin | null => {
  const c = club(ctx); if (!c) return null;
  for (let i = c.fin.length - 1; i >= 0; i--) { const f = c.fin[i]; if (kinds.includes(f.k) && t >= f.at && t < f.at + win) return f; }
  return null;
};
const outfitOf = (act: CrowdActivity, i: number) => (act.outfits.length ? act.outfits[i % act.outfits.length] : '');
function reset(o: Pose, p: THREE.Vector3, yaw: number, clip = 'idle', time = 0) {
  o.pos.copy(p); o.yaw = yaw; o.pitch = 0; o.roll = 0; o.clip = clip; o.time = time; o.hidden = false; o.busy = false; o.cheer = true; o.tags = 0; o.props = []; o.clip2 = undefined; o.w2 = 0;
}
/** walk a polyline at speed from t0; returns [pos, yaw, done] at time t */
function along(pts: THREE.Vector3[], t0: number, speed: number, t: number, out: THREE.Vector3): { yaw: number; done: boolean; dist: number } {
  let d = Math.max(0, t - t0) * speed;
  for (let i = 0; i < pts.length - 1; i++) {
    const L = pts[i].distanceTo(pts[i + 1]);
    if (d <= L || i === pts.length - 2) { const k = L > 1e-4 ? Math.min(1, d / L) : 1; out.lerpVectors(pts[i], pts[i + 1], k); return { yaw: yawTo(pts[i], pts[i + 1]), done: d >= L && i === pts.length - 2, dist: (t - t0) * speed }; }
    d -= L;
  }
  out.copy(pts[pts.length - 1]); return { yaw: 0, done: true, dist: 0 };
}
const pathLen = (pts: THREE.Vector3[]) => pts.reduce((s, p, i) => s + (i ? p.distanceTo(pts[i - 1]) : 0), 0);

// ------------------------------------------------------------------------------------------ bartender
function bartender(act: CrowdActivity): ActivityPlan {
  const pts = act.pts.length ? act.pts : [act.anchor];
  const n = Math.min(pts.length, act.frogs);
  return {
    act, n, outfit: (i) => outfitOf(act, i), water: () => null,
    sample(ctx, t, out) {
      const slide = bitAt(ctx, t, ['bartrick']) ?? (() => { const f = finAt(ctx, t, ['bits'], 8); return f ? { k: 'bartrick', at: f.at, seed: hash32(f.id), dur: 8 } : null; })();
      const jug = bitAt(ctx, t, ['juggle']);
      for (let i = 0; i < n; i++) {
        const o = out[i], p = pts[i];
        reset(o, p.pos, p.yaw);
        o.cheer = false;
        if (slide) {
          const a = t - slide.at - i * 0.7;
          if (a >= 0 && a < 1.0) { o.clip = 'slidedrink'; o.time = a; o.props = ['cup']; continue; }
          if (a >= 1.0 && a < 3.2) { o.clip = 'point'; o.time = a; continue; }
          if (a < 0) { o.clip = 'pour'; o.time = t; o.props = ['bottle']; continue; }
        }
        if (jug && i === 1 % n) {
          const a = t - jug.at;
          if (a > 12.5 && a < 14.5) { o.clip = 'shock'; o.time = a - 12.5; o.tags = TAG.BANG; continue; }     // drops one
          o.clip = 'juggle'; o.time = t; o.tags = a > 13 ? TAG.SWEAT : 0; continue;
        }
        const CY = 9, k = Math.floor((t + i * 3.1) / CY), u = t + i * 3.1 - k * CY;
        const r = rng(hash32(ctx.seed, act.id, i, k))();
        if (r < 0.45) { o.clip = u < 5 ? 'shake' : 'pour'; o.props = u < 5 ? ['shaker'] : ['bottle']; o.time = t; }
        else if (r < 0.7) { o.clip = u < 4 ? 'pour' : 'idle'; o.props = u < 4 ? ['bottle'] : []; o.time = t; }
        else if (r < 0.85) { o.clip = u < 2 ? 'wave' : 'idle'; o.time = u; }
        else { o.clip = 'shake'; o.props = ['shaker']; o.time = t * 1.3; }
        // side steps along the counter between drinks
        o.pos.z += 0.18 * Math.sin((t + i * 5) * 0.4);
      }
    },
  };
}

// ------------------------------------------------------------------------------------------ barflies (seated at the counter)
function barflies(act: CrowdActivity): ActivityPlan {
  const pts = act.pts.length ? act.pts : [act.anchor];
  const n = Math.min(pts.length, act.frogs);
  return {
    act, n, outfit: (i) => outfitOf(act, i), water: () => null,
    sample(ctx, t, out) {
      const round = bitAt(ctx, t, ['bartrick']) ?? (() => { const f = finAt(ctx, t, ['bits'], 8); return f ? { k: 'bartrick', at: f.at, seed: 0, dur: 8 } : null; })();
      for (let i = 0; i < n; i++) {
        // spread the flies over the stools (every stool index is stable per seed)
        const si = (i * 2 + (hash32(ctx.seed, act.id) % 2)) % pts.length;
        const p = pts[si];
        const seat = Number(p.extras.sit ?? act.extras.sit ?? 0.76);
        const hipH = 0.42 * ctx.scale;
        const o = out[i];
        reset(o, p.pos, p.yaw);
        o.pos.y = p.pos.y + seat - hipH;
        const CY = 11, k = Math.floor((t + i * 2.3) / CY), u = t + i * 2.3 - k * CY;
        const r = rng(hash32(ctx.seed, act.id, i, k))();
        if (round) {
          const a = t - round.at - i * 0.7 - 1.0;
          if (a > 0 && a < 4) { o.clip = a < 1.2 ? 'cheer' : 'drink'; o.time = a; o.props = a >= 1.2 ? ['cup'] : []; continue; }
        }
        if (r < 0.35) { o.clip = 'drink'; o.time = u; o.props = ['cup']; }
        else if (r < 0.55) { o.clip = 'flirt'; o.time = t; o.yaw = p.yaw + (i % 2 ? 0.6 : -0.6); }
        else if (r < 0.7) { o.clip = 'laugh'; o.time = t; }
        else if (r < 0.85) { o.clip = 'sway'; o.time = t; o.props = ['cup']; }
        else { o.clip = 'idle'; o.time = t; }
        o.cheer = true;
      }
    },
  };
}

// ------------------------------------------------------------------------------------------ bouncer
function bouncer(act: CrowdActivity): ActivityPlan {
  const post = act.anchor.pos, grab = act.named.get('GRAB')?.pos ?? post, door = act.named.get('DOOR')?.pos ?? post, exit = act.named.get('EXIT')?.pos ?? door;
  return {
    act, n: 2, outfit: (i) => outfitOf(act, i), water: () => null,
    sample(ctx, t, out) {
      const b = bitAt(ctx, t, ['bouncer']);
      const o = out[0], v = out[1];
      reset(o, post, act.anchor.yaw, 'crossarms', t); o.cheer = false;
      reset(v, grab, act.named.get('GRAB')?.yaw ?? 0, 'dance', t); v.hidden = true;
      if (!b) return;
      const a = t - b.at;
      const sp = 1.15;
      const go = [post, grab], back = [door, post];
      const tGo = pathLen(go) / sp;
      const tCarry = tGo + 1.2, tDoor = tCarry + door.distanceTo(grab) / 0.9;
      // the victim dances at the grab point from the start (stepping out of the crowd), then gets carried
      v.hidden = false; v.clip = a < tGo ? 'dance' : 'shock'; v.time = a;
      if (a < tGo) {
        const r = along(go, 0, sp, a, o.pos); o.yaw = r.yaw; o.clip = 'walk'; o.time = a * 1.3;
        if (a > tGo - 1.5) v.tags = TAG.BANG;
      } else if (a < tCarry) {
        o.pos.copy(grab); o.yaw = yawTo(grab, door); o.clip = 'carry'; o.time = a;
        const k = smooth((a - tGo) / 1.2);
        v.pos.copy(grab); v.pos.y += 1.05 * ctx.scale * k + 0.1; v.pitch = -Math.PI / 2 * k; v.yaw = o.yaw + Math.PI / 2; v.clip = 'surf'; v.time = a; v.busy = true; v.tags = TAG.SWEAT;
      } else if (a < tDoor) {
        const r = along([grab, door], tCarry, 0.9, a, o.pos); o.yaw = r.yaw; o.clip = 'carry'; o.time = a;
        v.pos.copy(o.pos); v.pos.y += 1.05 * ctx.scale + 0.1; v.pitch = -Math.PI / 2; v.yaw = o.yaw + Math.PI / 2; v.clip = 'surf'; v.time = a; v.busy = true; v.tags = TAG.SWEAT;
      } else if (a < tDoor + 1.2) {
        o.pos.copy(door); o.yaw = yawTo(door, exit); o.clip = 'toss'; o.time = a - tDoor;
        const k = clamp01((a - tDoor - 0.45) / 0.75);
        v.pos.lerpVectors(door, exit, k); v.pos.y += (1.05 * ctx.scale + 0.1) * (1 - k) + 1.4 * Math.sin(Math.PI * k); v.pitch = -Math.PI / 2 - Math.PI * 2 * k; v.yaw = o.yaw; v.clip = 'fall'; v.time = a; v.busy = true;
        v.hidden = k >= 1;
      } else if (a < tDoor + 3.2) {
        o.pos.copy(door); o.yaw = yawTo(exit, door); o.clip = 'flex'; o.time = a; o.tags = a < tDoor + 2 ? TAG.BANG : 0; v.hidden = true;
      } else {
        const r = along(back, tDoor + 3.2, sp, a, o.pos); o.yaw = r.done ? act.anchor.yaw : r.yaw; o.clip = r.done ? 'crossarms' : 'walk'; o.time = a * 1.3; v.hidden = true;
      }
    },
  };
}
/** the exit door's opening (0..1) for a bouncer bit at wall time t (the club engine swings CLUB_EXIT_DOOR with it) */
export function bouncerDoor(act: CrowdActivity, ctx: PlanCtx, t: number): number {
  const b = bitAt(ctx, t, ['bouncer']); if (!b) return 0;
  const post = act.anchor.pos, grab = act.named.get('GRAB')?.pos ?? post, door = act.named.get('DOOR')?.pos ?? post;
  const tDoor = post.distanceTo(grab) / 1.15 + 1.2 + door.distanceTo(grab) / 0.9;
  const a = t - b.at;
  return smooth((a - (tDoor - 1.2)) / 0.6) * (1 - smooth((a - (tDoor + 2.0)) / 0.8));
}

// ------------------------------------------------------------------------------------------ stage dancers (+ the lift)
function stage(act: CrowdActivity): ActivityPlan {
  const pts = act.pts.length ? act.pts : [act.anchor];
  const n = Math.min(pts.length, act.frogs);
  const edge = act.named.get('EDGE')?.pos ?? pts[0].pos, land = act.named.get('LAND')?.pos ?? edge, steps = act.named.get('STEPS')?.pos ?? land;
  const liftY = pts.length > 2 ? pts[2].pos.y : Infinity;
  return {
    act, n, outfit: (i) => outfitOf(act, i), water: () => null,
    sample(ctx, t, out, fx) {
      const c = club(ctx);
      const lift = c ? c.lift(t) : 0;
      const raid = finAt(ctx, t, ['raid'], 12);
      const fall = bitAt(ctx, t, ['stagefall']);
      const beat = t * 2;
      for (let i = 0; i < n; i++) {
        const o = out[i], p = pts[i];
        reset(o, p.pos, p.yaw);
        if (Math.abs(p.pos.y - liftY) < 0.05 && i >= 2) o.pos.y += lift;
        const phrase = Math.floor(beat / 16);
        const r = rng(hash32(ctx.seed, act.id, i, phrase))();
        o.clip = r < 0.3 ? 'headbang' : r < 0.55 ? 'fistpump' : r < 0.75 ? 'handsup' : r < 0.9 ? 'shuffle' : 'dance';
        o.time = t;
        if (raid && t - raid.at < 8) { o.clip = 'jump'; o.time = t - raid.at; }
        if (fall && i === 0) {
          const a = t - fall.at;
          const w = [p.pos, edge];
          const tW = pathLen(w) / 0.9;
          if (a < tW) { const q = along(w, 0, 0.9, a, o.pos); o.yaw = q.yaw; o.clip = 'dance'; o.time = a; }
          else if (a < tW + 0.8) { const k = clamp01((a - tW) / 0.8); o.pos.lerpVectors(edge, land, k); o.pos.y += 0.6 * Math.sin(Math.PI * k); o.pitch = 1.3 * k; o.clip = 'fall'; o.time = a; o.busy = true; o.yaw = yawTo(edge, land);
            if (k > 0.95) fx.push({ kind: 'sparks', pos: land.clone(), age: 0, size: 0.6 }); }
          else if (a < tW + 3.6) { o.pos.copy(land); o.clip = 'dazed'; o.time = a; o.tags = TAG.STARS; o.busy = true; o.yaw = yawTo(edge, land); }
          else { const q = along([land, steps], tW + 3.6, 0.8, a, o.pos); o.yaw = q.yaw; o.clip = 'walk'; o.time = a * 1.2; o.tags = TAG.SWEAT; o.hidden = q.done; }
        }
      }
    },
  };
}

// ------------------------------------------------------------------------------------------ floor bits (step out of the mass crowd)
function floorbits(act: CrowdActivity): ActivityPlan {
  const loop = act.pts.map((p) => p.pos);
  const ring = act.named.get('RING')?.pos ?? act.anchor.pos;
  const surfA = act.named.get('SURF')?.pos ?? act.anchor.pos, surfB = act.named.get('SURF2')?.pos ?? act.anchor.pos;
  const n = Math.max(6, act.frogs);
  return {
    act, n, outfit: (i) => outfitOf(act, i), water: () => null,
    sample(ctx, t, out, fx) {
      for (let i = 0; i < n; i++) { reset(out[i], act.anchor.pos, 0); out[i].hidden = true; }
      const c = club(ctx);
      const big = finAt(ctx, t, ['big'], 16);
      if (big && c?.signWalk) {                                    // the sign carrier marches across the front of the floor
        const [a, b] = c.signWalk; const o = out[n - 1];
        const q = along([a, b], big.at + 1.0, 0.85, t, o.pos);
        o.hidden = t < big.at + 1.0 || q.done; o.yaw = q.yaw; o.clip = 'sign'; o.time = t; o.cheer = false; o.busy = true;
      }
      const b = bitAt(ctx, t, ['conga', 'danceoff', 'crowdsurf', 'proposal']);
      if (!b) return;
      const a = t - b.at;
      const fade = (o: Pose) => { if (a < 0.4 || a > b.dur - 0.4) o.hidden = true; };
      if (b.k === 'conga' && loop.length > 2) {
        const L = pathLen([...loop, loop[0]]), per = L / 0.55;
        const m = Math.min(6, n - 1);
        for (let i = 0; i < m; i++) {
          const o = out[i]; o.hidden = false;
          const d = ((a * 0.55 - i * 0.95) % L + L) % L;
          const q = along([...loop, loop[0]], 0, 1, d, o.pos); o.yaw = q.yaw;
          const beatU = (a % 30);
          o.clip = beatU > 22 && beatU < 25 ? 'dance' : 'conga'; o.time = a; o.cheer = false;
          if (a < i * 1.7) o.hidden = true;                       // they join the line one by one
          fade(o);
          void per;
        }
      } else if (b.k === 'danceoff') {
        const r = rng(b.seed);
        const moves = ['spin', 'shuffle', 'headbang', 'flex', 'fistpump'];
        for (let i = 0; i < 2; i++) {
          const o = out[i]; o.hidden = false; o.cheer = false;
          const turn = Math.floor(a / 4) % 2 === i;               // 4 s turns
          const side = i ? 1 : -1;
          o.pos.copy(ring).add(new THREE.Vector3(side * (turn ? 0.25 : 0.75), 0, 0));
          o.yaw = turn ? (moves[Math.floor(a / 4 + i) % moves.length] === 'spin' ? a * 9 : Math.atan2(-side, 0.4)) : Math.atan2(-side, 0);
          o.clip = turn ? moves[(Math.floor(a / 8) + i + Math.floor(r() * 5)) % moves.length] : 'clap'; o.time = a;
          if (a > b.dur - 3) { o.clip = i === (b.seed & 1) ? 'cheer' : 'laugh'; o.tags = i === (b.seed & 1) ? TAG.CONFETTI : 0; }
          fade(o);
        }
      } else if (b.k === 'crowdsurf') {
        const o = out[0]; o.hidden = false; o.busy = true; o.cheer = false;
        const k = smooth(clamp01((a - 1) / (b.dur - 3)));
        o.pos.lerpVectors(surfA, surfB, k); o.pos.y += 1.9 * ctx.scale + 0.08 * Math.sin(a * 5);
        o.pitch = -Math.PI / 2; o.roll = 0.15 * Math.sin(a * 2.3); o.yaw = yawTo(surfA, surfB) + Math.PI / 2 + 0.2 * Math.sin(a * 0.9); o.clip = 'surf'; o.time = a;
        if (a < 1) { o.pos.y = surfA.y + (1.9 * ctx.scale) * a; }
        fade(o);
      } else if (b.k === 'proposal') {
        const at = act.pts[2]?.pos ?? act.anchor.pos;
        const o = out[0], v = out[1]; o.hidden = false; v.hidden = false; o.cheer = false; v.cheer = false;
        v.pos.copy(at); o.pos.copy(at).add(new THREE.Vector3(0.75, 0, 0.1)); o.yaw = yawTo(o.pos, v.pos); v.yaw = yawTo(v.pos, o.pos);
        if (a < 2.5) { o.clip = 'walk'; o.time = a; o.pos.x += 1.2 * (1 - a / 2.5); v.clip = 'dance'; v.time = a; }
        else if (a < 9) { o.clip = 'propose'; o.time = a; o.props = ['ringbox']; v.clip = a < 5 ? 'shock' : 'swoon'; v.time = a; v.tags = a > 5 ? TAG.HEART : TAG.BANG; }
        else { o.clip = 'cheer'; o.time = a; v.clip = 'swoon'; v.time = a; o.tags = TAG.HEART | (a < 11 ? TAG.CONFETTI : 0); v.tags = TAG.HEART; }
        fade(o); fade(v);
        if (a > 9 && a < 9.1) fx.push({ kind: 'confetti', pos: at.clone().setY(at.y + 2), age: 0, size: 1.2 });
      }
    },
  };
}
/** Mass dancers near a floor bit react (the club engine feeds this into CrowdScene.massOverride). */
export function floorbitOverride(act: CrowdActivity, ctx: PlanCtx, t: number, pos: THREE.Vector3): { clip?: string; yaw?: number; dx?: number; dz?: number; hide?: boolean } | null {
  const b = bitAt(ctx, t, ['conga', 'danceoff', 'crowdsurf', 'proposal']);
  if (!b) return null;
  const a = t - b.at;
  const ease = smooth(a / 1.2) * (1 - smooth((a - (b.dur - 1.2)) / 1.2));
  if (b.k === 'danceoff' || b.k === 'proposal') {
    const c = b.k === 'danceoff' ? (act.named.get('RING')?.pos ?? act.anchor.pos) : (act.pts[2]?.pos ?? act.anchor.pos);
    const dx = pos.x - c.x, dz = pos.z - c.z, d = Math.hypot(dx, dz);
    const R = b.k === 'danceoff' ? 1.9 : 1.6;
    if (d > R + 1.3) return null;
    if (d < 0.35) return { hide: true };
    const push = Math.max(0, R - d) * ease;
    return { clip: b.k === 'proposal' && a > 9 ? 'cheer' : 'clap', yaw: Math.atan2(-dx, -dz), dx: (dx / d) * push, dz: (dz / d) * push };
  }
  if (b.k === 'crowdsurf') {
    const A = act.named.get('SURF')?.pos ?? act.anchor.pos, B = act.named.get('SURF2')?.pos ?? act.anchor.pos;
    const k = smooth(clamp01((a - 1) / (b.dur - 3)));
    const sx = A.x + (B.x - A.x) * k, sz = A.z + (B.z - A.z) * k;
    const d = Math.hypot(pos.x - sx, pos.z - sz);
    return d < 1.6 ? { clip: 'handsup', yaw: Math.atan2(sx - pos.x, sz - pos.z) } : null;
  }
  if (b.k === 'conga') {
    const loop = act.pts.map((p) => p.pos);
    for (let i = 0; i < loop.length; i++) {
      const p0 = loop[i], p1 = loop[(i + 1) % loop.length];
      const l = new THREE.Line3(p0, p1).closestPointToPoint(pos, true, new THREE.Vector3());
      if (l.distanceTo(pos) < 0.55) return { hide: true };
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------ VIP frogs
function vip(act: CrowdActivity): ActivityPlan {
  const pts = act.pts.length ? act.pts : [act.anchor];
  const n = Math.min(pts.length, act.frogs);
  return {
    act, n, outfit: (i) => outfitOf(act, i), water: () => null,
    sample(ctx, t, out) {
      const big = finAt(ctx, t, ['big'], 10);
      for (let i = 0; i < n; i++) {
        const o = out[i]; reset(o, pts[i].pos, pts[i].yaw);
        const r = rng(hash32(ctx.seed, act.id, i, Math.floor(t / 12)))();
        o.clip = r < 0.5 ? 'sway' : r < 0.75 ? 'drink' : 'laugh'; o.time = t + i; o.props = ['champagne'];
        if (big && t - big.at > 1) { o.clip = 'spray'; o.time = t; o.tags = TAG.CONFETTI; }
      }
    },
  };
}

EXTRA_PLANS.bartender = bartender;
EXTRA_PLANS.barflies = barflies;
EXTRA_PLANS.bouncer = bouncer;
EXTRA_PLANS.stage = stage;
EXTRA_PLANS.floorbits = floorbits;
EXTRA_PLANS.vip = vip;

export type { FxOut };
