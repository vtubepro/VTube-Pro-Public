// VTube Pro Live, W3: the key store. A thin wrapper over server/support/vault.ts (unchanged): pasted stream keys
// live ONLY in the DPAPI vault, scope BROADCAST_VAULT_SCOPE, fields from vaultField. Nothing here logs, returns through a GET
// or writes a secret anywhere else. `config/broadcast.json` (below) holds NO secrets.
//
// Vault rules kept (support/vault.ts): until a key is saved there is no vault file and the system key store (on Windows a
// hidden PowerShell) is never asked. `has/read` on an empty vault never unlock it; only the first `set` makes the key.
// The singleton shares the SUPPORT HUB'S Vault instance (two Vault objects over one support-secrets.json would overwrite each
// other's scopes), resolved lazily with a dynamic import the first time it is needed.
//
// This file also hosts the tiny non-secret config file (config/broadcast.json) that destinations.ts reads.
import fs from 'node:fs';
import path from 'node:path';
import {
  BROADCAST_VAULT_SCOPE, SECRET_FIELDS, vaultField,
  type BroadcastErrorCode, type DestPlatform, type DestProtocol, type IntentCheckInput, type KeyStoreApi,
} from '../../shared/broadcastTypes.ts';
import { CONFIG_DIR } from '../paths.ts';
import { writeAtomic } from '../support/vault.ts';

// ---------------------------------------------------------------- the vault seam

/** What this file needs from server/support/vault.ts `Vault` (structural, so tests inject fakes). */
export interface KeyVault {
  readonly empty: boolean;
  ready(): Promise<void>;
  get(scope: string, field: string): string;
  set(scope: string, fields: Record<string, string | null | undefined>): Promise<void>;
}
export type VaultSource = KeyVault | (() => Promise<KeyVault>);

/** KeyStoreApi (stream keys only: this build keeps no account tokens) plus what the other W3 files need. */
export interface KeyStore extends KeyStoreApi {
  /** Unlock the vault if (and only if) something was ever saved. Never calls the system key store on an empty vault. */
  ready(): Promise<void>;
}

const MAX_KEY = 600;
/** A pasted stream key, cleaned. Throws a plain-words Error when it cannot be one. */
export function cleanKey(raw: unknown): string {
  const k = String(raw ?? '').trim();
  if (!k) throw new Error('Paste your stream key first.');
  if (/^(rtmps?|srt|https?|whip):\/\//i.test(k)) throw new Error('That looks like a server address, not a stream key. The key is the secret code the platform shows next to it.');
  if (k.length > MAX_KEY) throw new Error('That is too long to be a stream key.');
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(k)) throw new Error('A stream key has no spaces. Copy it again from the platform.');
  return k;
}

export function createKeyStore(source: VaultSource): KeyStore {
  let vault: KeyVault | null = typeof source === 'function' ? null : source;
  let loaded = false;
  let loading: Promise<void> | null = null;

  const resolve = async (): Promise<KeyVault> => {
    if (!vault) vault = await (source as () => Promise<KeyVault>)();
    return vault;
  };
  const warm = (): Promise<void> => {
    if (!loading) {
      loading = (async () => {
        const v = await resolve();
        if (!v.empty) await v.ready();      // keys saved: unlock; none saved: leave the system key store alone
        loaded = true;
      })().catch((e) => { loading = null; throw e; });
    }
    return loading;
  };
  /** Sync read of memory. Before the vault is unlocked this is '' and it starts unlocking in the background. */
  const peek = (field: string): string => {
    if (!vault) { void warm().catch(() => undefined); return ''; }
    if (!loaded && !vault.empty) void warm().catch(() => undefined);
    return vault.get(BROADCAST_VAULT_SCOPE, field);
  };
  const write = async (fields: Record<string, string | null>) => {
    const v = await resolve();
    await v.set(BROADCAST_VAULT_SCOPE, fields);   // vault.set unlocks / makes the key itself
    loaded = true;
  };

  return {
    ready: warm,
    has: (destId) => peek(vaultField.destKey(destId)) !== '',
    read: (destId) => peek(vaultField.destKey(destId)),
    async set(destId, key) { await write({ [vaultField.destKey(destId)]: cleanKey(key) }); },
    async clear(destId) {
      await warm();
      if (vault && vault.empty) return;           // nothing was ever saved: nothing to clear, no system key store call
      await write({ [vaultField.destKey(destId)]: null });
    },
  };
}

/** The ready-made singleton: shares the support hub's Vault, resolved on first use. */
export const keyStore: KeyStore = createKeyStore(async () => (await import('../support/index.ts')).supportHub.vault);

// ---------------------------------------------------------------- who may write keys

/** Stream keys: only the Helper's own page on this PC (403 `local-only` for every web origin, paired or not, and for
 *  tools without an Origin). W2's routes call this before POST /keys/:id. */
export function keyWriteAllowed(origin: IntentCheckInput['origin']): { ok: true } | { ok: false; status: 403; code: BroadcastErrorCode; error: string } {
  if (origin === 'local-page') return { ok: true };
  return { ok: false, status: 403, code: 'local-only', error: 'Stream keys can only be added from VTube Pro on your own computer, not by another program.' };
}

// ---------------------------------------------------------------- redaction

/** Replace every secret VALUE in `text` (given by the caller: the key just pasted, a token just received) so an error
 *  sentence or a log line can never carry it. Also hides `Bearer x` / `OAuth x` / `field=value` shaped leftovers. */
export function redactSecrets(text: string, values: Iterable<string | null | undefined> = []): string {
  let out = String(text);
  for (const v of values) if (v && v.length >= 4) out = out.split(v).join('[hidden]');
  out = out.replace(/\b(Bearer|OAuth)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [hidden]');
  const names = SECRET_FIELDS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  out = out.replace(new RegExp(`("?(?:${names})"?\\s*[:=]\\s*)("[^"]*"|[^\\s,&;]+)`, 'gi'), '$1"[hidden]"');
  return out;
}

// ---------------------------------------------------------------- config/broadcast.json (NO secrets)

export interface StoredDest {
  id: string;
  platform: DestPlatform;
  label: string;
  protocol: DestProtocol;
  /** '' = use the platform default */
  url: string;
  enabled: boolean;
  title: string;
  category: string;
  createdAt: number;
}
export interface ConfigData {
  v: 1;
  destinations: StoredDest[];
}
export interface BroadcastConfig {
  readonly file: string;
  read(): ConfigData;
  update(fn: (d: ConfigData) => void): void;
}

const PLATFORMS: readonly DestPlatform[] = ['twitch', 'youtube', 'kick', 'tiktok', 'custom'];
const PROTOCOLS: readonly DestProtocol[] = ['rtmp', 'rtmps', 'srt', 'whip'];
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

function sanitize(raw: unknown): ConfigData {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dests: StoredDest[] = [];
  if (Array.isArray(o.destinations)) {
    for (const d0 of o.destinations) {
      const d = (d0 && typeof d0 === 'object' ? d0 : {}) as Record<string, unknown>;
      const id = str(d.id, 40);
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id) || dests.some((x) => x.id === id)) continue;
      if (!PLATFORMS.includes(d.platform as DestPlatform)) continue;
      dests.push({
        id, platform: d.platform as DestPlatform, label: str(d.label, 60),
        protocol: PROTOCOLS.includes(d.protocol as DestProtocol) ? d.protocol as DestProtocol : 'rtmp',
        url: str(d.url, 300), enabled: d.enabled !== false, title: str(d.title, 140), category: str(d.category, 100),
        createdAt: Number.isFinite(d.createdAt) ? Number(d.createdAt) : 0,
      });
    }
  }
  return { v: 1, destinations: dests };
}

/** The shared non-secret config. Cached in memory, written through atomically on every update. A missing or broken file
 *  reads as empty (never throws). */
export function createBroadcastConfig(file: string): BroadcastConfig {
  let cur: ConfigData | null = null;
  const load = (): ConfigData => {
    if (cur) return cur;
    try { cur = sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { cur = sanitize({}); }
    return cur;
  };
  return {
    file,
    read: () => JSON.parse(JSON.stringify(load())) as ConfigData,
    update(fn) {
      const next = JSON.parse(JSON.stringify(load())) as ConfigData;
      fn(next);
      const clean = sanitize(next);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(file, JSON.stringify(clean, null, 2));
      cur = clean;
    },
  };
}

let sharedConfig: BroadcastConfig | null = null;
/** The config of this install (config/broadcast.json under the data folder). Created on first use. */
export function broadcastConfig(): BroadcastConfig {
  return (sharedConfig ??= createBroadcastConfig(path.join(CONFIG_DIR, 'broadcast.json')));
}

/** A lazily created singleton: `make` runs on first property access, never at import. */
export function lazy<T extends object>(make: () => T): T {
  let inst: T | null = null;
  const get = () => (inst ??= make());
  return new Proxy({} as T, {
    get: (_t, k) => { const v = (get() as Record<PropertyKey, unknown>)[k]; return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(get()) : v; },
  });
}
