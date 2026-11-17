// Plays throw events on the performer's avatar (beta.16, docs/b16/THROW.md). The choreography itself is a pure function of the
// event (shared/throwables.ts planItem / itemPose / handPose), so every page that plays the same event shows the same throw.
// This file turns it into pictures in the instanced pool (pool.ts) and into hits on the head (src/avatar/hitReact.ts).
//
// Idle = zero cost: with no event playing, tick() returns on its first line; the pool (atlas + buffers) is only built at the first
// throw and let go again after IDLE_FREE_MS without one. At most THROW_LIMITS.maxInFlight items are alive at once; extra items of a
// bigger barrage are dropped, never queued.
import * as THREE from 'three';
import type { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import { faceAnchor, hitHead } from '../../avatar/hitReact.ts';
import {
  THROW_LIMITS, THROW_PROP_BY_ID, THROW_T, contactTimes, eventSecs, handPose, hitImpulse, hitTime, imgSrc, isHardProp, itemPose, planItem,
  propUrl, starHits, starPose, throwSoundName, type HandPose, type ItemPlan, type ItemPose, type StarPose, type ThrowBag, type ThrowEvent, type ThrowImg,
} from '../../../shared/throwables.ts';
import { ThrowPool } from './pool.ts';

/** The pool (atlas, buffers) is freed after this long with nothing playing. */
export const IDLE_FREE_MS = 20_000;
const DEFAULT_IMG: ThrowImg = { k: 'prop', v: 'tomato' };
const HEART_LIFE = 0.85;
const HEART_KEY = 'prop:heart';
const HEART_SRC = propUrl('heart');

type PlayBag = Pick<ThrowBag, 'stars' | 'size' | 'sound'>;
interface Active {
  ev: ThrowEvent;
  /** Epoch ms. */
  start: number;
  kind: 'throw' | 'pat' | 'boop';
  imgs: ThrowImg[];
  plans: ItemPlan[];
  hit: Uint8Array;
  starOn: boolean[];
  contacts: number[];
  contactDone: Uint8Array;
  /** Atlas cell per picture, refreshed every frame (no allocation). */
  cells: Int16Array;
  keys: string[];
  srcs: string[];
  flashSafe: boolean;
  secs: number;
  bag: PlayBag;
}

export class ThrowPlayer {
  private pool: ThrowPool | null = null;
  private act: Active[] = [];
  private idleSince = 0;
  private starTimes: number[] = [];
  private readonly face = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly ip: ItemPose = { phase: 'wait', x: 0, y: 0, z: 0, rot: 0, sx: 1, sy: 1, alpha: 0, since: -1 };
  private readonly sp: StarPose = { alive: false, x: 0, y: 0, z: 0, size: 0, alpha: 0, rot: 0 };
  private readonly hp: HandPose = { alive: false, x: 0, y: 0, z: 0, rot: 0, sx: 1, sy: 1, alpha: 0 };
  /** Set by the mount on the host's OBS page when the host switched the sound on. */
  onSound: ((name: string) => void) | null = null;

  constructor(private readonly makePool: () => ThrowPool = () => new ThrowPool()) {}

  /** Anything playing (the mount keeps its hook cheap with this). */
  get busy() { return this.act.length > 0; }
  get poolBuilt() { return !!this.pool; }
  /** Items alive right now (all events). */
  alive(now: number): number {
    let n = 0;
    for (const a of this.act) { const t = (now - a.start) / 1000; for (const p of a.plans) if (t < p.leave + p.flight + THROW_T.stick + THROW_T.fall) n++; }
    return n;
  }

  /** Start an event. `start` = epoch ms (eventStart). Returns how many items will really play (the in-flight cap). */
  play(ev: ThrowEvent, start: number, bag: PlayBag, flashSafe: boolean, now = Date.now()): number {
    const kind = ev.what === 'headpat' ? (ev.imgs[0]?.v === 'boop-finger' ? 'boop' : 'pat') : 'throw';
    const imgs = ev.imgs.length ? ev.imgs : [kind === 'throw' ? DEFAULT_IMG : { k: 'prop', v: 'pat-hand' } as ThrowImg];
    const room = Math.max(0, THROW_LIMITS.maxInFlight - this.alive(now));
    const e = { ...ev, imgs };
    const plans: ItemPlan[] = [];
    if (kind === 'throw') for (let i = 0; i < Math.min(ev.n, room); i++) plans.push(planItem(e, i, bag.size));
    if (kind === 'throw' && !plans.length) return 0;
    const hits = plans.map((p) => hitTime(p));
    const a: Active = {
      ev: e, start, kind, imgs, plans, hit: new Uint8Array(plans.length), starOn: starHits(hits, flashSafe), contacts: kind === 'throw' ? [] : contactTimes(kind),
      contactDone: new Uint8Array(kind === 'throw' ? 0 : kind === 'pat' ? 3 : 1), cells: new Int16Array(imgs.length), keys: imgs.map((i) => `${i.k}:${i.v}`), srcs: imgs.map(imgSrc), flashSafe, secs: eventSecs(ev) + 0.3, bag,
    };
    this.act.push(a);
    this.idleSince = 0;
    this.ensurePool();     // pictures start loading now (the host's lead gives them a head start)
    return plans.length || 1;
  }

  private ensurePool(): ThrowPool {
    if (!this.pool) {
      this.pool = this.makePool();
      this.pool.loadStar(propUrl('star'));
    }
    return this.pool;
  }

  /** Once a frame, from the avatar's late hook (src/scene/throw/mount.ts). `rt` is the performer's runtime. */
  tick(rt: AvatarRuntime, now = Date.now()) {
    if (!this.act.length) {
      if (this.pool && this.idleSince && now - this.idleSince > IDLE_FREE_MS) { this.pool.dispose(); this.pool = null; this.idleSince = 0; }
      return;
    }
    const S = faceAnchor(rt, this.face);
    if (S <= 0) {
      // nothing to hit (a flat avatar with no face box, no head bone): the throw is lost, and the pool play() began must not stay for good
      this.act.length = 0;
      if (this.pool) { this.pool.begin(); this.pool.end(); this.idleSince = now; }
      return;
    }
    const pool = this.ensurePool();
    if (pool.mesh.parent !== rt.anchor) rt.anchor.add(pool.mesh);
    rt.anchor.getWorldScale(this.scale);
    pool.setScale(this.scale.y || 1);
    pool.begin();
    for (let k = this.act.length - 1; k >= 0; k--) {
      const a = this.act[k], t = (now - a.start) / 1000;
      if (t > a.secs) { this.act.splice(k, 1); continue; }
      if (t < 0) continue;
      if (a.kind === 'throw') this.drawThrow(pool, a, t, S, now); else this.drawHand(pool, a, t, S, now);
    }
    pool.end();
    if (!this.act.length) this.idleSince = now;
  }


  private drawThrow(pool: ThrowPool, a: Active, t: number, S: number, now: number) {
    const f = this.face, ip = this.ip, sp = this.sp, star = pool.starCell;
    const cells = a.cells;
    for (let c = 0; c < a.imgs.length; c++) cells[c] = pool.cellFor(a.keys[c], a.srcs[c], now);
    for (let i = 0; i < a.plans.length; i++) {
      const p = a.plans[i];
      itemPose(p, t, ip);
      if (!a.hit[i] && t >= hitTime(p)) {
        a.hit[i] = 1;
        const im = hitImpulse(p);
        hitHead(im.dx, im.dy, im.power);
        if (a.bag.sound && this.onSound) { const img = a.imgs[Math.max(0, p.img)]; this.onSound(throwSoundName(a.ev.seed, i, img.k === 'prop' && isHardProp(img.v))); }
        if (a.starOn[i] && a.bag.stars && !this.starAllowed(a.flashSafe, now)) a.starOn[i] = false;
      }
      if (ip.phase !== 'wait' && ip.phase !== 'done') {
        const c = cells[Math.max(0, p.img)];
        pool.push(c, f.x + ip.x * S, f.y + ip.y * S, f.z + ip.z * S, p.size * S * ip.sx, p.size * S * ip.sy, ip.rot, ip.alpha);
      }
      if (a.starOn[i] && a.bag.stars) {
        starPose(p, t, sp, a.flashSafe);
        if (sp.alive) pool.push(star, f.x + sp.x * S, f.y + sp.y * S, f.z + sp.z * S, sp.size * S, sp.size * S, sp.rot, sp.alpha);
      }
    }
  }

  private drawHand(pool: ThrowPool, a: Active, t: number, S: number, now: number) {
    const f = this.face, hp = handPose(a.kind as 'pat' | 'boop', t, this.hp);
    const img = a.imgs[0], prop = THROW_PROP_BY_ID.get(img.v);
    for (let c = 0; c < a.contacts.length; c++) {
      if (a.contactDone[c] || t < a.contacts[c]) continue;
      a.contactDone[c] = 1;
      if (a.kind === 'pat') hitHead(0, -1, 0.3, true); else hitHead(-0.8, 0.5, 0.55, true);
    }
    if (hp.alive) {
      const w = (prop?.size ?? 1.4) * S * a.bag.size;
      pool.push(pool.cellFor(a.keys[0], a.srcs[0], now), f.x + hp.x * S, f.y + hp.y * S, f.z + hp.z * S, w * hp.sx, w * hp.sy, hp.rot, hp.alpha);
    }
    // hearts float up from every pat (slow and soft: never a flash)
    if (a.bag.stars) {
      const heart = pool.cellFor(HEART_KEY, HEART_SRC, now);
      for (let c = 0; c < a.contacts.length; c++) {
        const h = t - a.contacts[c];
        if (h < 0 || h >= HEART_LIFE) continue;
        const k = h / HEART_LIFE, w = 0.36 * S * a.bag.size;
        pool.push(heart, f.x + (0.35 + 0.12 * Math.sin(k * 5 + c)) * S * (c % 2 ? -1 : 1), f.y + (0.95 + 0.9 * k) * S, f.z + 0.75 * S, w, w, 0.25 * Math.sin(k * 6 + c), 1 - k * k);
      }
    }
  }

  /** The room's flash limit: at most THROW_T.flashPerSec stars may start in one second, across every event that is playing. */
  private starAllowed(flashSafe: boolean, now: number): boolean {
    if (!flashSafe) return true;
    while (this.starTimes.length && now - this.starTimes[0] > 1000) this.starTimes.shift();
    if (this.starTimes.length >= THROW_T.flashPerSec) return false;
    this.starTimes.push(now);
    return true;
  }

  /** Stop everything and free the pool (feature switched off, avatar switched, page closing). */
  dispose() {
    this.act.length = 0; this.starTimes.length = 0;
    this.pool?.dispose(); this.pool = null; this.idleSince = 0;
  }
}
