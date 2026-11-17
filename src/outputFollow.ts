// Which studio an OBS page follows, and avatar loads where the newest request wins (src/output.ts; the lock also
// src/dj.ts). Pure logic, no DOM: tools/obsfollow_unit.ts drives it directly, tools/obsfollow_e2e.ts in the real page.
//
// Owner live issue 2026-10-02: the OBS page kept showing the old avatar after a switch, until it was refreshed.
// Reproduced on a private helper (tools/obsfollow_e2e.ts, and with two real studio tabs): with a 2nd publishing studio
// on the bus (a 2nd studio tab, a second studio window, an observer tab that had lost its
// ?observer), the page's one-publisher lock moved to that other studio while the performer's studio was silent for
// > 2.5 s - which is what switching to a heavy avatar does to it (GLTF parse, texture cap, shader compile block its
// main thread) - and it never came back: every `load` the performer's studio repeated afterwards was dropped as
// "another publisher". A page that had locked onto the other studio from the start ignored every switch the same way.
// And a switch while the previous load was still running showed the overtaken avatar when its load landed (until the
// next 2 s heartbeat), as did switching back to the shown avatar while another one was loading.

/** A studio silent this long loses the page's lock to another publishing studio (it was closed / crashed). */
export const SOURCE_TIMEOUT_MS = 2500;
/** A studio that lost the lock only by going silent gets it back when it resumes within this long (it was stalled). */
export const HANDBACK_MS = 30_000;

/** The fields of a bus message the lock reads (`src` = the sending page's bus id, src/bus.ts). */
export interface SourceMsg { src?: string; type?: string; switchedAt?: unknown; avatarId?: unknown }

/** A `load` message's switch stamp: epoch ms of the performer's last avatar switch in that studio (src/app.ts), else 0. */
export function switchStamp(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0; }

/** A studio's last avatar announcement heard here: the avatar + its switch stamp. */
interface Heard { avatar: string; sw: number }

/**
 * One publisher at a time: if two studios publish (frames + the 2 s avatar heartbeat), the page follows one of them
 * and drops the other's messages, so the output never flickers between the two. Who it follows:
 *  1. the first studio that talks;
 *  2. a studio where the performer switches avatar while this page listens, at once: its switch stamp
 *     (`load.switchedAt`, newer studios) went up, or (older studios, no stamp field) the avatar it announces changed
 *     to one the studio followed does not show (a remote command load reaches every studio: never a reason to move);
 *  3. else the one it follows, as long as it keeps talking;
 *  4. a studio that went silent for SOURCE_TIMEOUT_MS loses the lock to the next one that talks, and gets it back if
 *     it resumes within HANDBACK_MS (a stall, not a closed tab) unless the performer switched in the new one meanwhile.
 * Only switches HEARD count, compared with the studio's own previous announcement: a stamp from before (an avatar only
 * tried in a 2nd tab, a refreshed OBS page) never ranks one studio over another, so it cannot pin the page to a studio
 * the performer is not in. Server-originated messages (no `src`) always pass.
 */
export class SourceLock {
  /** The studio (bus `src`) this page follows; null = none yet. */
  source: string | null = null;
  /** Times the lock moved, why the last move happened, messages dropped (diagnostics). */
  moves = 0;
  lastMove = '';
  rejected = 0;
  private lastAt = -Infinity;
  /** Each studio's last avatar announcement (a switch = a change from it). */
  private readonly heard = new Map<string, Heard>();
  /** Last message per studio (performance ms): how many studios publish. */
  private readonly seen = new Map<string, number>();
  /** The studio that lost the lock by going silent, and until when its next message takes it back. */
  private prev: string | null = null;
  private prevUntil = 0;

  constructor(readonly timeoutMs = SOURCE_TIMEOUT_MS, readonly handbackMs = HANDBACK_MS) {}

  /** Act on this message? `now` = performance.now(). */
  accept(m: SourceMsg, now: number): boolean {
    const src = m.src;
    if (!src) return true;
    this.seen.set(src, now);
    if (this.seen.size > 16) this.prune(now);
    const switched = m.type === 'load' && this.switched(src, m);
    if (src === this.source) { if (switched) this.prev = null; } // the performer works here: no hand-back any more
    else if (!this.source) this.move(src, 'first', null, now);
    else if (switched) this.move(src, 'switch', null, now);
    else if (src === this.prev && now <= this.prevUntil) this.move(src, 'hand back', null, now);
    else if (now - this.lastAt > this.timeoutMs) this.move(src, 'silent source', this.source, now);
    else { this.rejected++; return false; }
    this.lastAt = now;
    return true;
  }

  /** Diagnostics (vtpOut.follow): who is followed, how many studios published in the last 5 s, the last move. */
  info(now: number) {
    let studios = 0;
    for (const t of this.seen.values()) if (now - t < 5000) studios++;
    const h = this.source ? this.heard.get(this.source) : undefined;
    return { source: this.source, studios, moves: this.moves, lastMove: this.lastMove, rejected: this.rejected, avatar: h?.avatar ?? '', stamp: h?.sw ?? 0, handBackTo: this.prev && now <= this.prevUntil ? this.prev : null };
  }

  /** A `load` from `src`: did the performer switch avatar there since its previous announcement? (records this one) */
  private switched(src: string, m: SourceMsg): boolean {
    const before = this.heard.get(src);
    const sw = switchStamp(m.switchedAt), avatar = typeof m.avatarId === 'string' ? m.avatarId : '';
    this.heard.set(src, { avatar, sw: Math.max(sw, before?.sw ?? 0) });
    if (!before) return false;                                  // its first announcement heard: nothing to compare with
    if (m.switchedAt !== undefined) return sw > before.sw;      // newer studio: stamped switches only (not remote loads)
    // older studio (no stamp field): the avatar it announces changed, to one the followed studio does not announce (a
    // remote command load reaches every studio: once the followed one announces it, the others' change moves nothing)
    return !!avatar && avatar !== before.avatar && (src === this.source || !this.source || avatar !== this.heard.get(this.source)?.avatar);
  }
  private move(src: string, why: string, prev: string | null, now: number) {
    this.source = src;
    this.prev = prev;
    this.prevUntil = prev ? now + this.handbackMs : 0;
    this.moves++;
    this.lastMove = why;
  }
  private prune(now: number) {
    for (const [k, t] of this.seen) if (now - t > 60_000 && k !== this.source && k !== this.prev) { this.seen.delete(k); this.heard.delete(k); }
  }
}

/** What a slot does to load an avatar (src/output.ts Slot). R = a finished build (the runtime + its avatar space). */
export interface LoadSteps<R> {
  /** The avatar id the slot shows now (undefined = none). */
  shown(): string | undefined;
  /** true = park this request instead of loading it (this PC's performer is a TV right now). */
  divert?(id: string): boolean;
  /** Build the avatar (may take seconds). `stale()` turns true once a newer request overtook this one: the build may
   *  stop early then (src/avatar/loadSlicer.ts LoadCancelled) — it is never shown either way. */
  build(id: string, stale: () => boolean): Promise<R>;
  /** Show a finished build: it is the newest request. */
  show(r: R, id: string): void;
  /** A finished build a newer request overtook: release it, it is never shown. */
  drop(r: R, id: string): void;
  fail?(id: string, e: unknown): void;
  /** Diagnostics: 'busy' | 'cancel' | 'divert' | 'start' | 'restart' | 'shown' | 'stale' | 'fail'. */
  trace?(ev: string, id: string): void;
}

/**
 * A slot's avatar loads, the newest request wins. A request while another load runs starts at once (following a switch
 * never waits for the overtaken load); the overtaken build is told it is stale (it stops at its next step) and is
 * dropped if it lands anyway, never shown. Asking for the avatar the slot already shows calls off a load that is still
 * running. A forced reload (the profile was saved: a costume change) of the avatar that is loading right now restarts
 * it with the newest profile (rapid costume hotkeys build only the last one).
 */
export class LatestLoads<R> {
  /** The newest request while it is still loading ('' = none). */
  loadingId = '';
  private turn = 0;
  private wanted = 0;

  constructor(private readonly steps: LoadSteps<R>) {}

  async load(id: string, force = false): Promise<void> {
    const s = this.steps;
    if (this.loadingId === id && !force) { s.trace?.('busy', id); return; }
    if (this.loadingId === id) s.trace?.('restart', id);
    // (before the switch-back check: the studio's heartbeat for the avatar shown must not call off the TV load that
    // replaces it when this PC's performer becomes a TV - it is parked like any other avatar request then)
    if (s.divert?.(id)) { s.trace?.('divert', id); return; }
    if (!force && s.shown() === id) {
      if (this.loadingId) { s.trace?.('cancel', this.loadingId); this.wanted = ++this.turn; this.loadingId = ''; }
      return;
    }
    const t = this.wanted = ++this.turn;
    this.loadingId = id;
    s.trace?.('start', id);
    try {
      const r = await s.build(id, () => t !== this.wanted);
      if (t !== this.wanted) { s.trace?.('stale', id); try { s.drop(r, id); } catch (e) { s.fail?.(id, e); } return; }
      s.show(r, id);
      s.trace?.('shown', id);
    } catch (e) {
      // (an overtaken build that stopped early is not a failure)
      if (t !== this.wanted) s.trace?.('stale', id);
      else { s.trace?.('fail', id); s.fail?.(id, e); }
    } finally {
      if (t === this.wanted) this.loadingId = '';
    }
  }
}
