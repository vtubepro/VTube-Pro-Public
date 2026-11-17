// The rule list as the studio sees it: loaded from the server (config/rules.json), saved back on every change. One instance per
// page (rulesRuntime), shared by the engine (reads `rules`) and the Rules screen (edits them). Plain fetch with an injectable
// transport, so it can run against a fake server.
import { MAX_RULES, sanitizeRules, type StreamRule } from '../../shared/streamRules.ts';
import type { RuleEngine } from './engine.ts';

export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class RulesStore {
  rules: StreamRule[] = [];
  /** The first load finished (successfully or not). */
  loaded = false;
  /** The last problem, in plain words ('' = none). */
  error = '';
  private subs = new Set<() => void>();
  private saving: Promise<void> = Promise.resolve();
  /** Saves not answered yet, and when the last one finished: a `rules-changed` echo of our own save must not undo a quick second click. */
  private pending = 0;
  lastSaveAt = 0;

  constructor(private f: Fetcher = (url, init) => fetch(url, init)) {}

  onChange(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private emit() { for (const fn of [...this.subs]) { try { fn(); } catch { /* a screen redraw must never break the store */ } } }
  /** Cheap check for the chat hot path: with no rule on, chat lines are not even looked at. */
  anyEnabled(): boolean { return this.rules.some((r) => r.enabled); }

  /** The helper says the list changed. Our own saves echo back: those are ignored (the list in memory is already newer). */
  externalChange(now = Date.now()): Promise<void> {
    if (this.pending > 0 || now - this.lastSaveAt < 2500) return Promise.resolve();
    return this.load();
  }

  async load(): Promise<void> {
    try {
      const r = await this.f('/api/rules');
      if (!r.ok) { this.error = 'VTube Pro did not answer. Rules are paused until it does.'; }
      else {
        const j = await r.json() as { rules?: unknown };
        if (this.pending === 0) this.rules = sanitizeRules(j.rules);   // (a save in flight is newer than what VTube Pro still has)
        this.error = '';
      }
    } catch { this.error = 'VTube Pro did not answer. Rules are paused until it does.'; }
    this.loaded = true;
    this.emit();
  }

  /** Replace the whole list (what the screen edits). Returns once the helper has it. */
  save(next: StreamRule[]): Promise<void> {
    this.rules = sanitizeRules(next).slice(0, MAX_RULES);
    this.emit();
    const body = JSON.stringify({ rules: this.rules });
    this.pending++;
    // saves go one after the other so a quick double click can never land out of order
    this.saving = this.saving.then(async () => {
      try {
        const r = await this.f('/api/rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
        if (!r.ok) throw new Error(String(r.status));
        this.error = '';
      } catch { this.error = 'Could not save your rules. Check that VTube Pro is running.'; }
      this.pending--; this.lastSaveAt = Date.now();
      this.emit();
    });
    return this.saving;
  }

  update(id: string, patch: Partial<StreamRule>): Promise<void> {
    return this.save(this.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  remove(id: string): Promise<void> { return this.save(this.rules.filter((r) => r.id !== id)); }
  /** A new id that is not taken ("my-rule", "my-rule-2" ...). */
  freshId(base = 'rule'): string {
    const stem = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'rule';
    let id = stem, n = 2;
    while (this.rules.some((r) => r.id === id)) id = `${stem}-${n++}`;
    return id;
  }
}

/** Names the studio knows, so the editor can offer a list instead of asking for an id (all optional: a missing list = a text box). */
export interface RulesEnv {
  rooms(): { id: string; name: string }[];
  outfits(): { id: string; name: string }[];
  accessories(): { id: string; name: string }[];
  emotes(): { id: string; name: string }[];
}

/** Page-wide singletons, set by src/rules/mount.ts. */
export const rulesRuntime: { store: RulesStore; engine: RuleEngine | null; observer: boolean; env: RulesEnv | null } = { store: new RulesStore(), engine: null, observer: false, env: null };
