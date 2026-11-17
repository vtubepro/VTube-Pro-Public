// The host studio's scene state ↔ the server (GET / PUT /api/scene), made robust (the room selection must stick, and
// the enabled state must be remembered). The server is the authority; this keeps one studio
// tab in step with it. No DOM, no app imports: it can be driven with a fake server.
//
//  • Nothing is saved before the server's state has been read. A studio used to start from the defaults (Classic, chat
//    off) and an early edit — the avatar's size check, a Stream Deck press, a preview report — saved those defaults
//    over the streamer's room; a failed first read made the defaults "loaded" for good. Now the first read is retried
//    until it answers, and edits made meanwhile are replayed on the real state (the controller's `replay`).
//  • Saves send only what this tab changed (top-level keys that differ from the last state the server confirmed), so a
//    second tab, or a tab that missed an update, can't put back an old room / chat setting it never touched. `_diff: true`
//    tells the server it is a partial body.
//  • Other tabs' saves arrive on the bus ({type:'scene'} from the server itself); keys this tab hasn't changed take
//    the server's value (a three-way merge per key), so every tab shows — and later saves on top of — the real state.
//  • A save that fails (the server restarting) is retried until it lands; the error is reported meanwhile.
import type { SceneState } from '../../shared/types.ts';
import { sanitizeSceneState } from '../../shared/scene.ts';

const J = (v: unknown) => JSON.stringify(v ?? null);

/** Top-level keys whose value differs between a and b (a key only one of them has counts). */
export function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (J(a[k]) !== J(b[k])) out.push(k);
  return out;
}

/** What to PUT: the keys `next` changed since `base` (a key `next` dropped = null: the helper's sanitiser removes it),
 *  plus rev. Empty (null) when only rev changed. */
export function sceneDiff(base: SceneState, next: SceneState): Record<string, unknown> | null {
  const keys = changedKeys(base as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>).filter((k) => k !== 'rev');
  if (!keys.length) return null;
  const n = next as unknown as Record<string, unknown>;
  const d: Record<string, unknown> = { _diff: true, rev: next.rev };
  for (const k of keys) d[k] = n[k] === undefined ? null : n[k];
  return d;
}

/** Three-way merge per top-level key: what `local` changed since `base` stays, everything else comes from `remote`. */
export function mergeScene(base: SceneState, local: SceneState, remote: SceneState): SceneState {
  const b = base as unknown as Record<string, unknown>, l = local as unknown as Record<string, unknown>, r = remote as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
    if (k === 'rev') continue;
    const v = J(l[k]) !== J(b[k]) ? l[k] : r[k];
    if (v !== undefined) out[k] = v;
  }
  out.rev = Math.max(local.rev || 0, remote.rev || 0);
  return sanitizeSceneState(out);
}

export interface SceneSyncIO {
  /** GET /api/scene (throws when the helper doesn't answer). */
  get(): Promise<unknown>;
  /** PUT /api/scene with a partial body; resolves with the state the helper stored (throws on failure). */
  put(body: Record<string, unknown>): Promise<unknown>;
  /** The studio's own state (what its UI shows) and a way to replace it. */
  local(): SceneState;
  setLocal(s: SceneState): void;
  /** The helper's state is in (first read): adopt it, then replay the edits made before (the controller re-runs them). */
  loaded(s: SceneState): void;
  /** Another tab's change was merged in (refresh the UI / previews / guests). */
  merged?(s: SceneState): void;
  /** A save landed or failed (`err`). */
  saved?(ok: boolean, err?: string): void;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(h: unknown): void;
}

export class SceneSync {
  /** The helper's state has been read (saves are allowed). */
  ready = false;
  /** The last state the helper confirmed (read, saved or broadcast). */
  base: SceneState | null = null;
  private timer: unknown = null;
  private retryTimer: unknown = null;
  private retryMs = 1000;
  private inflight = false;
  private again = false;
  private force = false;
  private stopped = false;
  private loadTries = 0;

  constructor(private io: SceneSyncIO, readonly opts: { debounceMs?: number; readOnly?: boolean } = {}) {}

  private st(fn: () => void, ms: number) { return (this.io.setTimeout ?? ((f: () => void, m: number) => setTimeout(f, m)))(fn, ms); }
  private ct(h: unknown) { if (h !== null) (this.io.clearTimeout ?? ((x: unknown) => clearTimeout(x as ReturnType<typeof setTimeout>)))(h); }

  /** Read the helper's state, retrying (0.5 s → 8 s) until it answers or something else delivered it (a bus update). */
  start() {
    if (this.ready || this.stopped) return;
    this.io.get().then((s) => { if (!this.ready && !this.stopped) this.adoptFirst(sanitizeSceneState(s)); }, () => {
      if (this.ready || this.stopped) return;
      const wait = Math.min(8000, 500 * 2 ** Math.min(4, this.loadTries++));
      this.st(() => this.start(), wait);
    });
  }
  stop() { this.stopped = true; this.ct(this.timer); this.ct(this.retryTimer); }

  private adoptFirst(s: SceneState) {
    this.ready = true;
    this.base = s;
    this.ct(this.timer); this.timer = null;            // (a save scheduled before the read held the defaults: never sent)
    this.io.loaded(s);                                  // (the controller adopts s and replays its early edits → schedule())
  }

  /** A local edit happened: save it (debounced). `force` = send even when nothing but rev changed (the helper then
   *  re-broadcasts the state: a guest who left the party puts this PC's OBS back on its own room). */
  schedule(force = false) {
    if (this.opts.readOnly || this.stopped) return;
    if (force) this.force = true;
    if (!this.ready) return;                            // (held: replayed onto VTube Pro's state once it is read)
    this.ct(this.timer);
    this.timer = this.st(() => { this.timer = null; void this.flush(); }, this.opts.debounceMs ?? 80);
  }

  private async flush() {
    if (!this.ready || !this.base || this.stopped) return;
    if (this.inflight) { this.again = true; return; }
    const snap = this.io.local();
    let body = sceneDiff(this.base, snap);
    if (!body && this.force) body = { _diff: true, rev: snap.rev };
    if (!body) return;
    this.force = false;
    this.inflight = true;
    let back: SceneState | null = null, err: string | null = null;
    try { back = sanitizeSceneState(await this.io.put(body)); } catch (e) { err = String((e as Error)?.message ?? e); }
    this.inflight = false;
    if (this.stopped) return;
    if (back) {
      this.retryMs = 1000;
      this.io.saved?.(true);
      // keys this tab changed after the snapshot stay; the rest is what the helper has (incl. other tabs' changes) —
      // unless a newer broadcast already came in meanwhile (it carries this save too, and was merged when it came)
      if (!this.base || back.rev >= this.base.rev) {
        const merged = mergeScene(snap, this.io.local(), back);
        this.base = back;
        if (J(merged) !== J(this.io.local())) { this.io.setLocal(merged); this.io.merged?.(merged); }
      }
    } else {
      this.io.saved?.(false, err ?? 'save failed');
      // keep trying (the helper restarting / updating): base is unchanged, so the next diff still carries this change
      this.ct(this.retryTimer);
      this.retryTimer = this.st(() => { this.retryTimer = null; void this.flush(); }, this.retryMs);
      this.retryMs = Math.min(15000, this.retryMs * 2);
      return;
    }
    if (this.again) { this.again = false; void this.flush(); }
  }

  /** The helper's state as broadcast after any tab's save (bus {type:'scene', self:'@host'} sent by the helper). */
  remote(raw: unknown) {
    if (this.stopped) return;
    const s = sanitizeSceneState(raw);
    if (!this.ready) { this.adoptFirst(s); return; }
    if (this.base && s.rev < this.base.rev) return;     // (older than what VTube Pro already told us)
    const local = this.io.local();
    const merged = mergeScene(this.base ?? s, local, s);
    this.base = s;
    if (J(merged) !== J(local)) { this.io.setLocal(merged); this.io.merged?.(merged); }
  }

  /** Unsaved local changes (the UI may say "saving…"). */
  get dirty(): boolean { return !!this.base && !!sceneDiff(this.base, this.io.local()); }
}
