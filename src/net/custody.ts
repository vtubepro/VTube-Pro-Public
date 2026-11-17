// Model custody for party members' avatars (docs/MULTIPLAYER_DISCORD.md "Model custody").
//
// A received avatar / costume / profile is:
//   1. checked (glTF 2.0 binary only, exact length, no external references),
//   2. sealed at once with AES-GCM-256 under a per-member, per-session key (WebCrypto) and the plaintext zeroed,
//   3. deposited as CIPHERTEXT in the local server's RAM vault (server/partyVault.ts: never on disk, no-store,
//      loopback + capability only, purged when the member leaves / the party ends / the studio stops heartbeating),
//   4. opened only by pages that got the key + capability over this PC's loopback bus (the OBS output): fetched
//      with `cache: 'no-store'`, decrypted in memory, parsed straight from the ArrayBuffer (no URL, no blob URL,
//      no THREE.Cache entry), then the plaintext is zeroed; three.js keeps only the parsed geometry / textures.
// Nothing here is DRM: whoever renders a model has its geometry and textures in (GPU) memory.
import type { SealedAvatarRef, VaultRef } from '../../shared/types.ts';
import { aesOpenOffThread } from './aesOpenOffThread.ts';

const b64u = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s: string) => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };
const te = new TextEncoder();

/** Overwrite a buffer we are done with (plaintext model bytes). */
export function wipe(b: ArrayBuffer | Uint8Array | null | undefined) {
  if (!b) return;
  try { (b instanceof Uint8Array ? b : new Uint8Array(b)).fill(0); } catch { /* detached */ }
}

export class SealKey {
  private constructor(readonly key: CryptoKey, readonly raw: string) {}
  static async create(): Promise<SealKey> {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const raw = b64u(bytes);
    bytes.fill(0);
    return new SealKey(key, raw);
  }
  /** The key for opening. A stream PC's OBS page over the home network is not a secure context (no crypto.subtle):
   *  it gets the raw bytes, opened by shared/aesGcm.ts (docs/TWO_PC_STREAMING.md); the caller zeroes them when done. */
  static async from(raw: string): Promise<CryptoKey | Uint8Array> {
    const bytes = unb64u(raw);
    if (bytes.length !== 32) throw new Error('bad key');
    if (!globalThis.crypto?.subtle) return bytes;
    const k = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
    bytes.fill(0);
    return k;
  }
  /** iv(12) ‖ ciphertext+tag. `aad` binds the blob to what it is (kind + member). */
  async seal(plain: Uint8Array, aad: string): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, this.key, plain as Uint8Array<ArrayBuffer>));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0); out.set(ct, 12);
    return out;
  }
  async open(sealed: Uint8Array, aad: string): Promise<Uint8Array> { return openWith(this.key, sealed, aad); }
}
async function openWith(key: CryptoKey | Uint8Array, sealed: Uint8Array, aad: string): Promise<Uint8Array> {
  if (sealed.length < 29) throw new Error('sealed blob too short');
  // Raw key = stream PC page: pure-JS AES-GCM, in a worker so a big model does not freeze the OBS picture.
  // (Every blob openSealedAvatar passes was just fetched, so handing its buffer over is safe.)
  if (key instanceof Uint8Array) return aesOpenOffThread(key, sealed, te.encode(aad));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) as Uint8Array<ArrayBuffer>, additionalData: te.encode(aad) }, key, sealed.subarray(12) as Uint8Array<ArrayBuffer>);
  return new Uint8Array(pt);
}

// ---------------------------------------------------------------- RAM vault on this PC's server
const VAULT = '/api/party/vault';
export const vault = {
  async put(session: string, sealed: Uint8Array): Promise<VaultRef> {
    const r = await fetch(VAULT, { method: 'PUT', cache: 'no-store', headers: { 'content-type': 'application/octet-stream', 'x-vtp-session': session }, body: sealed as Uint8Array<ArrayBuffer> });
    if (!r.ok) throw new Error(`vault ${r.status}`);
    return (await r.json()) as VaultRef;
  },
  async get(ref: VaultRef): Promise<Uint8Array> {
    const r = await fetch(`${VAULT}/${encodeURIComponent(ref.id)}`, { cache: 'no-store', credentials: 'same-origin', headers: { 'x-vtp-cap': ref.cap } } /* same-origin: a stream PC's page proves its pairing with its cookie (Stream PC mode); this PC's pages have none */);
    if (!r.ok) throw new Error(`vault ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  },
  drop(ref: VaultRef | null | undefined) {
    if (!ref) return;
    void fetch(`${VAULT}/${encodeURIComponent(ref.id)}`, { method: 'DELETE', cache: 'no-store', headers: { 'x-vtp-cap': ref.cap } }).catch(() => {});
  },
  alive(session: string) { return fetch(`${VAULT}/session/${session}/alive`, { method: 'POST', cache: 'no-store' }).then((r) => r.ok).catch(() => false); },
  purge(session: string, beacon = false) {
    const url = `${VAULT}/session/${session}/purge`;
    if (beacon && navigator.sendBeacon?.(url)) return;
    void fetch(url, { method: 'POST', cache: 'no-store', keepalive: true }).catch(() => {});
  },
};

// ---------------------------------------------------------------- OBS side: open a member's sealed avatar
export interface OpenedAvatar {
  profile: unknown;
  model: ArrayBuffer;
  costume: ArrayBuffer | null;
  /** Zero the plaintext once three.js has parsed it. */
  wipe(): void;
}
export async function openSealedAvatar(ref: SealedAvatarRef, member: string): Promise<OpenedAvatar> {
  const key = await SealKey.from(ref.key);
  let profile: unknown, prof: Uint8Array | null = null, model: Uint8Array | null = null, costume: Uint8Array | null = null;
  try {
    const [p, m, c] = await Promise.all([vault.get(ref.profile), vault.get(ref.model), ref.costume ? vault.get(ref.costume) : Promise.resolve(null)]);
    prof = await openWith(key, p, `profile:${member}`);
    profile = JSON.parse(new TextDecoder().decode(prof)) as unknown;
    wipe(prof); prof = null;
    model = await openWith(key, m, `model:${member}`);
    costume = c ? await openWith(key, c, `costume:${member}`) : null;
  } catch (e) {
    wipe(prof); wipe(model); wipe(costume);   // (a later open / parse failed: nothing of the plaintext already opened may stay in memory)
    throw e;
  } finally { if (key instanceof Uint8Array) key.fill(0); } // (raw key bytes: only on a stream PC page, see SealKey.from)
  const mdl = model!, cos = costume;
  return {
    profile, model: mdl.buffer as ArrayBuffer, costume: (cos?.buffer as ArrayBuffer | undefined) ?? null,
    wipe: () => { wipe(mdl); wipe(cos); },
  };
}
