// VTube Pro Live, W3: where the person streams to. Twitch, YouTube, Kick, TikTok and a custom RTMP(S)/SRT address, all with
// a pasted stream key (no account sign-in anywhere). The list lives in config/broadcast.json and holds NO secrets: keys are
// in the DPAPI vault (keys.ts). Every view returned here (DestinationView) is key-free.
//
// `serviceFor(id)` is the one place a secret leaves this module: it builds the ServiceSettings that Go Live hands to the
// backend (RAM only). The returned object hides `key` from JSON.stringify so an accidental serialisation cannot leak it.
// Libraries only: no routes (W2 mounts them), no logging.
import {
  type BroadcastErrorCode, type DestinationInput, type DestinationView, type DestinationsApi, type DestKeyState, type DestPlatform,
  type DestProtocol, type ServiceSettings,
} from '../../shared/broadcastTypes.ts';
import { broadcastConfig, keyStore, lazy, type BroadcastConfig, type KeyStore, type StoredDest } from './keys.ts';

/** A refusal with the machine code W2 puts in the ApiError and a plain sentence for the person. */
export class DestinationError extends Error {
  constructor(readonly code: BroadcastErrorCode, message: string) { super(message); this.name = 'DestinationError'; }
}

export const MAX_DESTINATIONS = 12;

interface PlatformInfo { label: string; protocol: DestProtocol; url: string; name: string }
/** Known ingest addresses (not secret). Kick and TikTok hand every streamer their own address, so theirs is pasted. */
export const PLATFORM_INFO: Record<DestPlatform, PlatformInfo> = {
  twitch: { label: 'My Twitch', protocol: 'rtmp', url: 'rtmp://live.twitch.tv/app', name: 'Twitch' },
  youtube: { label: 'My YouTube', protocol: 'rtmp', url: 'rtmp://a.rtmp.youtube.com/live2', name: 'YouTube' },
  kick: { label: 'My Kick', protocol: 'rtmps', url: '', name: 'Kick' },
  tiktok: { label: 'My TikTok', protocol: 'rtmp', url: '', name: 'TikTok' },
  custom: { label: 'My stream', protocol: 'rtmp', url: '', name: 'your stream' },
};
const PLATFORMS = Object.keys(PLATFORM_INFO) as DestPlatform[];
const PROTOCOLS: readonly DestProtocol[] = ['rtmp', 'rtmps', 'srt', 'whip'];

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const SCHEME: Record<string, DestProtocol> = { 'rtmp:': 'rtmp', 'rtmps:': 'rtmps', 'srt:': 'srt', 'http:': 'whip', 'https:': 'whip' };

/** An ingest address, checked: the scheme must be one we stream with and must agree with the chosen protocol. */
export function parseIngestUrl(raw: string, protocol?: DestProtocol): { url: string; protocol: DestProtocol } | { error: string } {
  const url = raw.trim();
  if (/[\s\u0000-\u001f]/.test(url)) return { error: 'The server address has spaces in it. Copy it again from the platform.' };
  if (url.length > 300) return { error: 'That server address is too long.' };
  let u: URL;
  try { u = new URL(url); } catch { return { error: 'That does not look like a server address. It starts with rtmp:// or rtmps:// (or srt://).' }; }
  const found = SCHEME[u.protocol];
  if (!found || !u.hostname) return { error: 'That does not look like a server address. It starts with rtmp:// or rtmps:// (or srt://).' };
  if (u.username || u.password) return { error: 'Leave the key out of the server address. Paste the key in its own box.' };
  const said = keyInAddress(u);
  if (said) return { error: said };
  if (protocol && protocol !== found) return { error: `That address starts with ${u.protocol}// but the protocol says ${protocol}. Make them match.` };
  return { url, protocol: found };
}

/** Query words that are harmless in an ingest address (YouTube's backup server is `...?backup=1`). Everything else after a `?` is refused. */
const HARMLESS_QUERY = new Set(['backup']);
/** SRT carries its secrets in the query. */
const SRT_SECRET_QUERY = /^(streamid|passphrase|pbkeylen|key|token|secret|password|pass|auth)$/i;
export const KEY_IN_ADDRESS_SAY = 'That looks like the address plus your key. Paste only the address here and the key in the key box.';
export const SRT_SECRET_SAY = 'That SRT address has your stream ID or password in it. Paste only the address here and put the secret part in the key box.';
/** Why an address cannot be stored: a stream key pasted after the server (`rtmp://live.twitch.tv/app/live_123_KEY`), or an SRT
 *  stream id / passphrase. The address is kept in plain text in config/broadcast.json and shown on screen, so it must hold none.
 *  The sentence never repeats the address. Null = fine. */
export function keyInAddress(u: URL): string | null {
  if (u.protocol === 'rtmp:' || u.protocol === 'rtmps:') {
    if (u.pathname.split('/').filter(Boolean).length > 1) return KEY_IN_ADDRESS_SAY;           // server/app/KEY
    if (u.hash) return KEY_IN_ADDRESS_SAY;
    for (const k of u.searchParams.keys()) if (!HARMLESS_QUERY.has(k.toLowerCase())) return KEY_IN_ADDRESS_SAY;
    return null;
  }
  if (u.protocol === 'srt:') {
    for (const k of u.searchParams.keys()) if (SRT_SECRET_QUERY.test(k)) return SRT_SECRET_SAY;
    if (u.hash) return SRT_SECRET_SAY;
  }
  return null;
}
/** True when a stored address already carries a key (a value saved before this check existed): it is never shown or published. */
export function addressCarriesKey(raw: string): boolean {
  try { return keyInAddress(new URL(raw.trim())) !== null; } catch { return false; }
}

export interface DestinationsDeps {
  keys: KeyStore;
  config: BroadcastConfig;
  now?: () => number;
  /** Random id suffix (tests pass a fake). */
  rand?: () => string;
}
export type Destinations = DestinationsApi;

export function createDestinations(deps: DestinationsDeps): Destinations {
  const { keys, config } = deps;
  const now = deps.now ?? Date.now;
  const rand = deps.rand ?? (() => Math.random().toString(36).slice(2, 8));

  const stored = (id: string): StoredDest | null => config.read().destinations.find((d) => d.id === id) ?? null;

  function view(d: StoredDest): DestinationView {
    const info = PLATFORM_INFO[d.platform];
    const pasted = keys.has(d.id);
    const noKeyNeeded = d.protocol === 'srt';          // an SRT address can carry its own stream id / passphrase
    const keyState: DestKeyState = pasted ? 'saved' : 'none';
    let needs: string | null = null;
    if (!d.url && !info.url) needs = `Paste the server address that ${info.name} shows next to your stream key.`;
    else if (keyState === 'none' && !noKeyNeeded) needs = `Paste your ${info.name} stream key.`;
    // an address saved before the key check existed may still carry a key: it is never shown, and never goes on the bus
    const leaky = d.url !== '' && addressCarriesKey(d.url);
    if (leaky) needs = KEY_IN_ADDRESS_SAY;
    return {
      id: d.id, platform: d.platform, label: d.label || info.label, protocol: d.protocol, url: leaky ? '' : d.url, keyState,
      enabled: d.enabled, title: '', category: '', needs,
    };
  }

  const validId = (id: string) => /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id);

  async function upsert(input: DestinationInput, opts?: { local?: boolean }): Promise<DestinationView> {
    if (!input || typeof input !== 'object') throw new DestinationError('bad-request', 'Tell me which service this is.');
    // keys only enter through the local page (POST /keys/:id); a body to POST /destinations that carries one is refused
    if (input.key !== undefined && input.key !== '' && opts?.local !== true) throw new DestinationError('bad-request', 'Stream keys are added in their own box, from VTube Pro on your computer.');
    if (!PLATFORMS.includes(input.platform)) throw new DestinationError('bad-request', 'Pick Twitch, YouTube, Kick, TikTok or Other.');
    if (input.protocol !== undefined && !PROTOCOLS.includes(input.protocol)) throw new DestinationError('bad-request', 'That streaming type is not one I know.');
    const info = PLATFORM_INFO[input.platform];
    const all = config.read().destinations;
    const id = input.id !== undefined && input.id !== '' ? String(input.id) : '';
    if (id && !validId(id)) throw new DestinationError('bad-request', 'That destination name is not valid.');
    const prev = id ? all.find((d) => d.id === id) ?? null : null;
    if (prev && prev.platform !== input.platform) throw new DestinationError('bad-request', 'A destination cannot change which service it is. Add a new one.');
    if (!prev && all.length >= MAX_DESTINATIONS) throw new DestinationError('bad-request', `You can keep up to ${MAX_DESTINATIONS} places to stream. Remove one first.`);

    let url = input.url !== undefined ? clean(input.url, 300).replace(/ /g, '') : prev?.url ?? '';
    let protocol: DestProtocol = input.protocol ?? prev?.protocol ?? info.protocol;
    if (url) {
      const p = parseIngestUrl(url, input.protocol);
      if ('error' in p) throw new DestinationError('bad-request', p.error);
      url = p.url; protocol = p.protocol;
    }
    const next: StoredDest = {
      id: prev?.id ?? (id || `${input.platform}-${rand()}`),
      platform: input.platform,
      label: input.label !== undefined ? clean(input.label, 60) : prev?.label ?? '',
      protocol, url,
      enabled: input.enabled !== undefined ? !!input.enabled : prev?.enabled ?? true,
      title: '',       // (a stream title and category are set on the platform's own page: nothing here can send them)
      category: '',
      createdAt: prev?.createdAt ?? now(),
    };
    if (!prev && all.some((d) => d.id === next.id)) throw new DestinationError('bad-request', 'There is already a destination with that name.');
    if (input.key !== undefined && input.key !== '') {
      try { await keys.set(next.id, input.key); } catch (e) { throw new DestinationError('bad-request', (e as Error).message); }
    }
    config.update((d) => {
      const i = d.destinations.findIndex((x) => x.id === next.id);
      if (i >= 0) d.destinations[i] = next; else d.destinations.push(next);
    });
    return view(next);
  }

  const api: Destinations = {
    list: () => config.read().destinations.map(view),
    get: (id) => { const d = stored(id); return d ? view(d) : null; },
    upsert,
    async remove(id) {
      if (!stored(id)) return false;
      config.update((d) => { d.destinations = d.destinations.filter((x) => x.id !== id); });
      try { await keys.clear(id); } catch { /* the entry is gone either way; a stale vault field is harmless */ }
      return true;
    },
    async serviceFor(id) {
      const d = stored(id);
      if (!d) return { ok: false, code: 'no-destination', say: 'I could not find that place to stream to.' };
      const info = PLATFORM_INFO[d.platform];
      const url = d.url || info.url;
      if (!url) return { ok: false, code: 'no-destination', say: `Paste the server address that ${info.name} shows next to your stream key.` };
      if (addressCarriesKey(url)) return { ok: false, code: 'no-destination', say: KEY_IN_ADDRESS_SAY };   // (saved before the check existed)
      await keys.ready().catch(() => undefined);
      const key = keys.read(id);                            // the pasted key
      if (!key && d.protocol !== 'srt') return { ok: false, code: 'no-key', say: `Paste your ${info.name} stream key.` };
      const svc: ServiceSettings = { destId: d.id, protocol: d.protocol, url, key };
      // a secret must not survive a stray JSON.stringify: hide it there (own, non-enumerable, so spread / copy keep working)
      Object.defineProperty(svc, 'toJSON', { value: () => ({ destId: svc.destId, protocol: svc.protocol, url: svc.url, key: '[hidden]' }), enumerable: false });
      return { ok: true, svc };
    },
    // (no account is linked, so a title and category are never sent to a platform: nothing to do here)
    async pushMetadata() { return { ok: true, say: '' }; },
  };
  return api;
}

/** The ready-made singleton (config/broadcast.json and the shared vault). Nothing runs until first use. */
export const destinations: Destinations = lazy(() => createDestinations({ keys: keyStore, config: broadcastConfig() }));
