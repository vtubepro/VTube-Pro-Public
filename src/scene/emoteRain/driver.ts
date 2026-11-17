// Emote rain, the OBS-page brain (docs/b16/EMOTE_RAIN.md). No DOM in this file: the page's picture-maker is passed in as a
// `RainPainter` and the clock / frame timer as a `RainEnv`, so tools/emote_rain_unit.ts drives it with a fake painter.
//
// What it does, in this order of care:
//   * IDLE = ZERO COST. Nothing ticks until something falls: the frame timer is asked for only while there is a picture
//     in the air, a burst waiting to start or a chat line flying. A bus message in the "off" mode is two comparisons.
//   * ONLY WHAT MAY BE SHOWN. Chat lines are read from the same chat the page already shows (local chat only: never the
//     party relay) and go through the chat filters (bots, !commands) and Live -> Privacy -> Hide chat. A deleted line or a
//     banned person takes their emotes off again. Pictures are public emote images, never saved.
//   * THE HOST'S PAGE ONLY. A party guest's OBS page shows the host's room, but the rain belongs to the host's chat and
//     avatar, so a page whose performer is not '@host' draws nothing.
import { sanitizeChatEvent, sanitizeChatState, type ChatEvent, type SceneChatState } from '../../../shared/chat.ts';
import { removedBy } from '../../../shared/chatRemove.ts';
import { HOST_KEY } from '../../../shared/scene.ts';
import {
  BURST_GAP_MS, EMOTE_RAIN_BAG, FALLBACK_GLYPHS, FlyLane, RAIN_RADIUS, RainBudget, RainPool, RainWorld, STEADY_RATE,
  anchorOk, burstPlan, defaultAnchor, easeAnchor, laneLineOf, rainEventFresh, rainSourcesOf, raidOf, raidPlan, sanitizeEmoteRain, srcOf,
  DEFAULT_EMOTE_RAIN, type EmoteRainBag, type LaneLine, type RainAnchor, type RainEvent, type RainFrom, type RainKey, type RainSrc,
} from '../../../shared/emoteRain.ts';

/** The page's picture-maker (src/scene/emoteRain/painter.ts). Every callback must come back, also on failure. */
export interface RainPainter {
  /** Get a picture ready; `done(id)` later, id >= 0, or -1 when it can't be shown. Emoji keys ('g:') are ready at once. */
  load(key: RainKey, done: (id: number) => void): void;
  /** Forget a picture the driver no longer uses. */
  free(id: number): void;
  /** Draw a chat line into a picture; `done(handle, w, h)` with its size in frame heights, handle -1 = failed. */
  loadLine(line: LaneLine, done: (handle: number, w: number, h: number) => void): void;
  freeLine(handle: number): void;
  /** One frame. `behind` = the chat lane goes on the canvas behind the 3D picture. */
  draw(world: RainWorld, lane: FlyLane, behind: boolean): void;
  /** Nothing is showing any more: take the canvases away. */
  idle(): void;
  dispose(): void;
}

export interface RainEnv {
  now(): number;
  raf(cb: (ts: number) => void): number;
  caf(id: number): void;
  rng(): number;
  /** Width / height of the page. */
  aspect(): number;
  /** The avatar's head and shoulders in frame units (null = can't tell). */
  measure(aspect: number): RainAnchor | null;
  painter: RainPainter;
}

interface Job { kind: 'burst' | 'steady'; left: number; until: number; gap: number; next: number; from: RainFrom; user?: string }
const SRC_RING = 128;
const MAX_SPRITES = 48;

export class RainDriver {
  bag: EmoteRainBag = { ...DEFAULT_EMOTE_RAIN };
  chat: SceneChatState = sanitizeChatState(undefined);
  /** This page belongs to the host's performer (a party guest's page does not play the rain). */
  hostPage = true;
  hasRoom = false;
  readonly world: RainWorld;
  readonly lane: FlyLane;
  readonly budget = new RainBudget();
  readonly pool = new RainPool();
  private anchor: RainAnchor;
  private anchorSet = false;
  private jobs: Job[] = [];
  private sprites = new Map<RainKey, number>();
  private loading = new Map<RainKey, ((id: number) => void)[]>();
  private srcs: (RainSrc | null)[] = new Array(SRC_RING).fill(null);
  private srcN = 0;
  private lineSrc = new Map<number, RainSrc>();
  private laneLoading = 0;
  private removed: { rm: ChatEvent; at: number }[] = [];
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private lastSeq = -1;
  private seeded = false;
  private lastBurstAt = -1e12;
  private rafId = 0;
  private last = 0;
  private disposed = false;
  /** A Try it stamp keeps the rain 'on' until then, also while the setting is Off. */
  private testUntil = 0;

  constructor(private env: RainEnv) {
    this.world = new RainWorld(env.rng);
    this.lane = new FlyLane(env.rng);
    this.anchor = defaultAnchor('center', env.aspect());
  }

  /** Rain may show on this page right now. */
  get on() { return !this.disposed && this.hostPage && (this.bag.mode !== 'off' || this.env.now() < this.testUntil); }
  /** Something is in the air, queued or loading. */
  busy() { return this.world.active > 0 || this.jobs.length > 0 || this.lane.active > 0 || this.loading.size > 0 || this.laneLoading > 0; }

  // ---------------------------------------------------------------- the bus

  /** Every bus message of the page. Cheap for the ones it does not want. */
  onBus(m: { type?: string; [k: string]: unknown }) {
    if (this.disposed) return;
    if (m.type === 'chat') { if (m.origin !== 'party') this.onChat(m.evs, m.snap === true); return; }
    if (m.type === 'scene') this.onScene(m.state, m.self);
  }

  /** The scene state (from the bus, or the first read at page start). */
  onScene(state: unknown, self: unknown) {
    const st = (state && typeof state === 'object' ? state : {}) as Record<string, unknown>;
    const wasOn = this.on, wasHidden = this.chat.hidden === true;
    this.hostPage = self === undefined || self === HOST_KEY;
    this.hasRoom = typeof st.sceneId === 'string' && st.sceneId.length > 0;
    this.chat = sanitizeChatState(st.chat);
    const modes = (st.modes && typeof st.modes === 'object' ? st.modes : {}) as Record<string, unknown>;
    this.bag = sanitizeEmoteRain(modes[EMOTE_RAIN_BAG]);
    this.budget.limit = this.bag.perMin;
    this.world.pile = this.bag.pile;
    // the stamp: play it once, and never an old one from before this page opened
    const ev = this.bag.ev, now = this.env.now();
    if (this.hostPage && ev && ev.seq !== this.lastSeq) {
      const first = !this.seeded;
      this.lastSeq = ev.seq;
      if (!first || rainEventFresh(ev, now)) { if (ev.test) this.testUntil = now + 9000; this.play(ev); }
    }
    this.seeded = true;
    if (!this.on) { if (wasOn || this.busy()) this.shutdown(0.4); return; }
    if (this.chat.hidden === true && !wasHidden) this.shutdown(0.3);
    if (this.bag.lane === 'off' && this.lane.active) this.clearLane();
    this.ensureLoop();
  }

  /** Play a stamp (or a test): burst / steady rain / stop. */
  play(ev: RainEvent) {
    if (!this.on) return;
    const now = this.env.now();
    if (ev.op === 'stop') { this.jobs = []; this.world.clear(0.5); this.ensureLoop(); return; }
    if (ev.op === 'burst') {
      if (now - this.lastBurstAt < BURST_GAP_MS) return;
      this.lastBurstAt = now;
      const p = burstPlan(ev.secs);
      this.addJob({ kind: 'burst', left: p.count, until: 0, gap: (p.over * 1000) / p.count, next: Math.max(now, ev.at), from: ev.from, user: ev.user });
    } else {
      this.addJob({ kind: 'steady', left: 0, until: ev.at + ev.secs * 1000, gap: 1000 / STEADY_RATE, next: Math.max(now, ev.at), from: ev.from, user: ev.user });
    }
    this.ensureLoop();
  }

  private addJob(j: Job) { if (this.jobs.length >= 4) this.jobs.shift(); this.jobs.push(j); }

  // ---------------------------------------------------------------- chat

  private onChat(evs: unknown, snap: boolean) {
    if (snap || !this.on || !Array.isArray(evs)) return;
    const now = this.env.now();
    for (const raw of evs.slice(0, 60)) {
      const e = sanitizeChatEvent(raw);
      if (!e) continue;
      if (e.kind === 'delete' || e.kind === 'purge') { this.remove(e, now); continue; }
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id); this.seenOrder.push(e.id);
      if (this.seenOrder.length > 400) for (const id of this.seenOrder.splice(0, 200)) this.seen.delete(id);
      const raid = raidOf(e);
      if (raid) {
        if (this.bag.raid && now - this.lastBurstAt >= BURST_GAP_MS) {
          this.lastBurstAt = now;
          const p = raidPlan(raid.viewers);
          this.addJob({ kind: 'burst', left: p.count, until: 0, gap: (p.over * 1000) / p.count, next: now, from: 'raider', user: raid.user });
        }
        continue;
      }
      if (e.kind !== 'chat') continue;
      const keys = rainSourcesOf(e, this.chat);
      if (keys.length) {
        const src = srcOf(e);
        this.pool.add(keys, src, now);
        if (this.bag.mode === 'all') {
          const n = this.budget.take(now, keys.length);
          if (n > 0) { const si = this.noteSrc(src); for (let i = 0; i < n; i++) this.want(keys[i], si); }
        }
      }
      if (this.bag.lane !== 'off') {
        const line = laneLineOf(e, this.chat);
        if (line) this.addLine(line, srcOf(e), now);
      }
    }
    this.ensureLoop();
  }

  private remove(rm: ChatEvent, now: number) {
    this.removed.push({ rm, at: now });
    if (this.removed.length > 24) this.removed.shift();
    this.pool.drop(rm);
    this.world.fadeWhere((i) => i >= 0 && !!this.srcs[i] && removedBy(rm, this.srcs[i]!));
    this.lane.removeWhere((h) => { const s = this.lineSrc.get(h); return !!s && removedBy(rm, s); }, (h) => this.lineGone(h));
  }
  private wasRemoved(src: RainSrc, since: number) { return this.removed.some((r) => r.at >= since && removedBy(r.rm, src)); }

  private noteSrc(src: RainSrc | null): number {
    if (!src) return -1;
    const i = this.srcN++ % SRC_RING;
    this.srcs[i] = src;
    return i;
  }

  // ---------------------------------------------------------------- pictures

  /** Drop one picture of `key` (loading it first if need be). */
  private want(key: RainKey, srcIdx: number) {
    const id = this.sprites.get(key);
    if (id !== undefined) {
      if (id < 0) return;
      this.sprites.delete(key); this.sprites.set(key, id);   // (most recently used last)
      this.drop(id, srcIdx);
      return;
    }
    const wait = this.loading.get(key);
    const then = (i: number) => { if (i >= 0 && this.on) this.drop(i, srcIdx); };
    if (wait) { wait.push(then); return; }
    this.loading.set(key, [then]);
    this.env.painter.load(key, (i) => {
      const cbs = this.loading.get(key) ?? [];
      this.loading.delete(key);
      this.sprites.set(key, i);
      this.trimSprites();
      for (const cb of cbs) cb(i);
      this.ensureLoop();
    });
  }

  private trimSprites() {
    if (this.sprites.size <= MAX_SPRITES) return;
    const live = new Set<number>();
    for (let i = 0; i < this.world.cap; i++) if (this.world.state[i]) live.add(this.world.sprite[i]);
    for (const [k, id] of this.sprites) {
      if (this.sprites.size <= MAX_SPRITES) break;
      if (id >= 0 && live.has(id)) continue;
      this.sprites.delete(k);
      if (id >= 0) this.env.painter.free(id);
    }
  }

  private drop(spriteId: number, srcIdx: number) {
    const rad = RAIN_RADIUS[this.bag.size] * Math.min(1.5, Math.max(0.6, this.anchor.ry / 0.1));
    this.world.spawn(spriteId, rad, srcIdx);
  }

  // ---------------------------------------------------------------- the chat lane

  private addLine(line: LaneLine, src: RainSrc, since: number) {
    if (this.lane.active + this.laneLoading >= this.lane.cap) return;
    this.laneLoading++;
    this.env.painter.loadLine(line, (handle, w, h) => {
      this.laneLoading = Math.max(0, this.laneLoading - 1);
      if (handle < 0) return;
      if (!this.on || this.bag.lane === 'off' || this.chat.hidden === true || this.wasRemoved(src, since)) { this.env.painter.freeLine(handle); return; }
      const behind = this.laneBehind();
      const a = this.anchor, avoid = behind ? null : { y0: a.y - a.ry - 0.03, y1: a.y + a.ry + 0.03 };
      if (!this.lane.add(handle, w, h, this.env.aspect(), avoid)) { this.env.painter.freeLine(handle); return; }
      this.lineSrc.set(handle, src);
      this.ensureLoop();
    });
  }
  private lineGone(handle: number) { this.lineSrc.delete(handle); this.env.painter.freeLine(handle); }
  private clearLane() { this.lane.clear((h) => this.lineGone(h)); }
  /** "Behind" only exists with the see-through background; in a room the room would hide it, so it flies in front. */
  laneBehind() { return this.bag.lane === 'behind' && !this.hasRoom; }

  // ---------------------------------------------------------------- the frame loop

  /** Everything fades out (settings went off, chat got hidden, the page is leaving). */
  shutdown(secs = 0.4) {
    this.jobs = [];
    this.world.clear(secs);
    this.clearLane();
    this.ensureLoop();
  }

  private ensureLoop() {
    if (this.rafId || this.disposed || !this.busy()) return;
    this.rafId = this.env.raf(this.frame);
  }

  private runJobs(now: number) {
    for (let k = this.jobs.length - 1; k >= 0; k--) {
      const j = this.jobs[k];
      let guard = 0;
      while (now >= j.next && guard++ < 8 && (j.kind === 'burst' ? j.left > 0 : now < j.until)) {
        this.emit(j, now);
        if (j.kind === 'burst') j.left--;
        j.next += j.gap * (0.5 + this.env.rng());
      }
      if (j.kind === 'burst' ? j.left <= 0 : now >= j.until) this.jobs.splice(k, 1);
    }
  }

  /** One picture for a job: from the pool (that person's, for raider / redeemer), else an emoji. */
  private emit(j: Job, now: number) {
    if (this.world.active >= this.world.cap - 2) return;
    const hidden = this.chat.hidden === true;
    const pick = hidden ? null : this.pool.pick(j.from, j.user, now, this.env.rng);
    if (pick) { this.want(pick.key, this.noteSrc(pick.src)); return; }
    this.want('g:' + FALLBACK_GLYPHS[Math.floor(this.env.rng() * FALLBACK_GLYPHS.length)], -1);
  }

  private updateAnchor(dt: number) {
    const aspect = this.env.aspect();
    this.world.aspect = aspect;
    let target: RainAnchor | null = null;
    if (this.bag.where === 'avatar') { const m = this.env.measure(aspect); if (anchorOk(m, aspect)) target = m; }
    if (!target) target = defaultAnchor(this.bag.where === 'avatar' ? 'center' : this.bag.where, aspect);
    if (!this.anchorSet) { Object.assign(this.anchor, target); this.anchorSet = true; }
    else easeAnchor(this.anchor, target, 1 - Math.exp(-10 * dt));
    this.world.anchor = this.anchor;
  }

  private frame = (ts: number) => {
    this.rafId = 0;
    if (this.disposed) return;
    const dt = this.last ? Math.min(0.05, Math.max(0, (ts - this.last) / 1000)) : 1 / 60;
    this.last = ts;
    this.updateAnchor(dt);
    this.runJobs(this.env.now());
    this.world.step(dt);
    this.lane.step(dt, (h) => this.lineGone(h));
    if (this.busy()) {
      this.env.painter.draw(this.world, this.lane, this.laneBehind());
      this.ensureLoop();
    } else {
      this.env.painter.idle();
      this.last = 0; this.anchorSet = false;
    }
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId) this.env.caf(this.rafId);
    this.rafId = 0;
    this.world.reset();
    this.clearLane();
    this.env.painter.dispose();
  }
}
