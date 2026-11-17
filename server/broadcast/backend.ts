// The broadcast backend seam (VTube Pro Live, Phase 1, workstream W2; plan graft G14).
//
// `BroadcastBackend` (shared/broadcastTypes.ts) knows nothing about OBS internals. Today there is one implementation:
// ObsBackend (stock OBS over obs-websocket v5, server/broadcast/obsBackend.ts). The VTube Pro Live Engine (EngineBackend)
// comes in Phase 2. This file holds WHICH one the person streams with ("Which one do you stream with?") and persists
// that choice in W2's own file, config/broadcast-choice.json (never in W3's config/broadcast.json).
//
// The person's choice:
//   * stored 'obs' / 'engine' / 'none' wins;
//   * nothing stored: an existing OBS setup stays the default ('obs' when VTube Pro can already read OBS), else 'none';
//   * 'engine' cannot be chosen until Phase 2 (engineAvailable false): the UI says "coming soon".
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../paths.ts';
import type { BackendChoice, BackendKind, BroadcastBackend } from '../../shared/broadcastTypes.ts';

export type { BroadcastBackend } from '../../shared/broadcastTypes.ts';

/** Phase 1: only stock OBS exists. Phase 2 flips this with the EngineBackend. */
export const ENGINE_AVAILABLE = false;

/** Backends that can put the stream service they overwrote back after a private test (stock OBS keeps the service in its
 *  own profile: a dry run to the local sink must not leave the person's real Twitch settings replaced). Optional. */
export interface ServiceRestorer {
  /** Remember the service the backend holds right now (RAM only, never logged, never returned). */
  snapshotService(): Promise<void>;
  /** Put it back. Resolves false when there was nothing to restore. */
  restoreService(): Promise<boolean>;
}
export const canRestoreService = (b: BroadcastBackend): b is BroadcastBackend & ServiceRestorer =>
  typeof (b as Partial<ServiceRestorer>).snapshotService === 'function' && typeof (b as Partial<ServiceRestorer>).restoreService === 'function';

export interface BackendHolderDeps {
  /** The stock-OBS backend (and nothing else in Phase 1). */
  obs: BroadcastBackend;
  /** Can VTube Pro read OBS at all (a saved password, or the automation on)? Decides the default for existing OBS setups. */
  obsConfigured: () => boolean;
  file?: string;
}

export interface BackendHolder {
  /** The effective choice (stored, else the OBS default, else 'none'). */
  choice(): BackendChoice;
  /** Was a choice ever stored? (false = the default applies). */
  stored(): BackendChoice | null;
  /** Persist the choice. 'engine' is refused until it exists. */
  setChoice(c: BackendChoice): { ok: true; choice: BackendChoice } | { ok: false; say: string };
  /** The backend that carries the show, or null for 'none' / 'engine' (not available yet). */
  active(): BroadcastBackend | null;
  /** The backend of a kind (null for the engine in Phase 1). */
  of(kind: BackendKind): BroadcastBackend | null;
}

const CHOICES: readonly BackendChoice[] = ['obs', 'engine', 'none'];
export const choiceFile = () => path.join(CONFIG_DIR, 'broadcast-choice.json');

export function createBackendHolder(d: BackendHolderDeps): BackendHolder {
  const file = d.file ?? choiceFile();
  let cached: BackendChoice | null | undefined;
  const read = (): BackendChoice | null => {
    if (cached !== undefined) return cached;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { choice?: unknown };
      cached = CHOICES.includes(j.choice as BackendChoice) ? (j.choice as BackendChoice) : null;
    } catch { cached = null; }
    return cached;
  };
  const holder: BackendHolder = {
    stored: read,
    choice() {
      const s = read();
      if (s === 'engine' && !ENGINE_AVAILABLE) return d.obsConfigured() ? 'obs' : 'none';   // (only reachable by a hand-edited file)
      if (s) return s;
      return d.obsConfigured() ? 'obs' : 'none';
    },
    setChoice(c) {
      if (!CHOICES.includes(c)) return { ok: false, say: 'Pick My OBS or the VTube Pro Live Engine.' };
      if (c === 'engine' && !ENGINE_AVAILABLE) return { ok: false, say: 'The VTube Pro Live Engine is coming soon. For now, stream with your OBS.' };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ v: 1, choice: c }, null, 2));
      } catch { return { ok: false, say: 'I could not save that choice on this computer.' }; }
      cached = c;
      return { ok: true, choice: c };
    },
    of: (kind) => (kind === 'obs' ? d.obs : null),
    active() { const c = holder.choice(); return c === 'obs' ? d.obs : null; },
  };
  return holder;
}

// ---------------------------------------------------------------- the shared holder

let shared: BackendHolder | null = null;
/** The route hub registers the holder it built, so other parts of the server can ask
 *  which backend carries the show without importing the hub. */
export function registerBackendHolder(h: BackendHolder | null): void { shared = h; }
/** The backend that carries the show right now, or null (none chosen, or the hub has not started yet). */
export function activeBackend(): BroadcastBackend | null { return shared?.active() ?? null; }
