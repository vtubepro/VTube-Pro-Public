// The in-app "set it up for me" job for the local voice features (live captions, Kokoro alert voice): one at a time, with
// the steps kept for the card to show. The installer itself is tools/voice/voice_setup.ts (pinned, sha256-checked,
// on the user's click only). POST /api/voice/setup · /cancel · /uninstall, GET /api/voice/status (server/voice/routes.ts).
import { DEFAULT_DIR, inspect, paths, runSetup, uninstall, type Part, type Progress, type VoiceInspect, type WhisperModelId } from '../../tools/voice/voice_setup.ts';

export interface SetupState { running: boolean; ok: boolean | null; steps: Progress[]; startedAt: number }

export class VoiceSetupJob {
  private abort: AbortController | null = null;
  state: SetupState = { running: false, ok: null, steps: [], startedAt: 0 };
  /** Called when a job ends (the managers re-read what is installed). */
  onDone: (() => void) | null = null;
  /** Things to stop before files are removed (a running sidecar holds its model open). */
  readonly beforeRemove: (() => Promise<void> | void)[] = [];

  constructor(public dir: string = DEFAULT_DIR) {}

  private push(p: Progress) {
    const i = this.state.steps.findIndex((x) => x.step === p.step);
    if (i >= 0 && p.step !== 'done') this.state.steps[i] = p; else this.state.steps.push(p);
  }

  start(parts: Part[], model: WhisperModelId | undefined, dryRun: boolean): boolean {
    if (this.state.running) return false;
    this.state = { running: true, ok: null, steps: [], startedAt: Date.now() };
    this.abort = new AbortController();
    runSetup({ dir: this.dir, parts, model, dryRun, onProgress: (p) => this.push(p), signal: this.abort.signal })
      .then((ok) => { this.state.ok = ok; })
      .catch((e) => { this.state.ok = false; this.push({ step: 'error', state: 'error', msg: `${(e as Error).message ?? e}. Press the button again to retry: finished parts are kept.` }); })
      .finally(() => { this.state.running = false; this.abort = null; try { this.onDone?.(); } catch { /* listener */ } });
    return true;
  }

  cancel() { this.abort?.abort(); }

  async remove(part?: 'captions' | 'kokoro'): Promise<boolean> {
    if (this.state.running) return false;
    for (const f of this.beforeRemove) { try { await f(); } catch { /* best effort */ } }
    this.state.steps = [];
    const done = uninstall(this.dir, (p) => this.push(p), part);
    try { this.onDone?.(); } catch { /* listener */ }
    return done;
  }

  inspect(): VoiceInspect { return inspect(this.dir); }
  paths() { return paths(this.dir); }
}
