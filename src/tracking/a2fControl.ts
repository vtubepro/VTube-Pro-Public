// GPU lip sync control (the decisions around the Audio2Face sidecar, no audio, no DOM: unit-tested in tools/lipengine_unit.ts).
//   · the saved settings (on / mix / opt-out) and the owner's answer, which is ALSO kept on the helper (config/gpu.json), so a cleared
//     browser cannot flip it;
//   · pick(): what the helper says about this PC -> ask once / on again (accepted before) / nothing (src/tracking/lipEngine.ts). Asking
//     starts NOTHING; only the owner's "Turn on" (or an on they set earlier) asks the helper to start the sidecar, and the helper
//     still refuses while OBS is streaming, on a card that can't run it, and for any start nobody asked for (server/gpuSidecars.ts);
//   · the start requests and why the helper refused one (shown in the status line).
import { loadA2f, saveA2f, type A2fSettings } from './a2fMerge.ts';
import { chooseLipEngine, type GpuStatusLike, type LipEngineChoice } from './lipEngine.ts';

export interface A2fIo { fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }> }

export class A2fControl {
  settings: A2fSettings = loadA2f();
  /** the helper says it was accepted before: switch on once the mic is on */
  wantAuto = false;
  /** why the helper refused the last start ('' = none) */
  refusal = '';
  /** the helper can't tell whether OBS is live: the studio shows "GPU lip sync is ready - Start" and only that click starts it */
  needsClick = false;
  /** called (once per refusal streak) when the helper wants the owner's click: the studio shows the chip */
  onNeedsClick: (() => void) | null = null;
  choice: LipEngineChoice | null = null;
  constructor(private io: A2fIo = { fetch: (u, i) => fetch(u, i) }) {}

  private post(url: string, body: unknown) {
    try { return this.io.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch { return Promise.resolve(null); }
  }
  /** A start / stop request. `user` = a REAL click of the owner's just now (never a restart from a saved setting: a saved "on" restarts as a
   *  studio start): the helper starts those unless OBS is live; any other start needs the owner's saved "accepted" and a live signal that
   *  says idle (or was idle earlier this session), else it answers needsClick. The refusal text comes back for the status line. */
  ask(on: boolean, why = 'studio', user = false) {
    void Promise.resolve(this.post('/api/gpu/a2f', { on, why, user })).then(async (r) => {
      const j = on && r && !r.ok ? ((await r.json().catch(() => ({}))) as { error?: unknown; needsClick?: unknown }) : null;
      this.refusal = j ? String(j.error ?? '') : '';
      const need = !!j && j.needsClick === true;
      if (need && !this.needsClick) this.onNeedsClick?.();
      this.needsClick = need;
    }).catch(() => { this.refusal = ''; });
  }
  /** The click on "GPU lip sync is ready - Start": the owner's own start (the helper starts it even when it can't tell if OBS is live; it still refuses a live stream). */
  startByClick() { this.ask(true, 'start chip', true); }
  private postChoice(choice: 'accepted' | 'declined') { void Promise.resolve(this.post('/api/gpu/a2f/choice', { choice })).catch(() => {}); }

  /** What the helper says about this PC: decides (never starts anything itself). */
  pick(status: GpuStatusLike | null): LipEngineChoice {
    const c = chooseLipEngine(this.settings, status);
    this.choice = c;
    // an "on" the owner set by hand before the helper kept answers: tell it once, so their restarts keep working (as accepted starts)
    if (status?.gpu && this.settings.on && !this.settings.autoPicked && !status.choice) this.postChoice('accepted');
    if (c.action === 'enable') this.wantAuto = true;
    else if (c.action === 'disable') this.set({ on: false }, true, false);
    return c;
  }
  /** Per tick: an "accepted before" switch-on waits for the mic. Returns true when it just switched on. */
  tick(micOn: boolean, blocked: boolean): boolean {
    if (this.wantAuto && micOn && !blocked && !this.settings.on && !this.settings.optOut) { this.wantAuto = false; this.set({ on: true }, true, blocked); return true; }
    return false;
  }
  /** on / off, mix, url ... `auto` = the studio's own doing (an accepted choice coming back); a user's on / off is their answer and is
   *  kept on the helper too (turning it off keeps it off: optOut). */
  set(patch: Partial<A2fSettings>, auto: boolean, blocked: boolean) {
    if ('on' in patch) {
      patch = { ...patch, optOut: auto ? false : !patch.on, autoPicked: auto && !!patch.on };
      this.wantAuto = false;
      if (!auto) this.postChoice(patch.on ? 'accepted' : 'declined');
    }
    this.settings = { ...this.settings, ...patch };
    saveA2f(this.settings);
    if (blocked) return;
    if ('on' in patch) this.ask(this.settings.on, 'studio', !auto && !!patch.on);
  }
  /** "Turn on" on the one-time question: the owner's yes. */
  accept(blocked: boolean) { this.set({ on: true }, false, blocked); }
  /** "Not now": the owner's no, kept on the helper (never asked again). */
  decline() { this.postChoice('declined'); this.settings = { ...this.settings, optOut: true }; saveA2f(this.settings); }
}
