// The webhook inbox, helper side (beta.13, research A13). Services that can only PUSH (Ko-fi, Throne) or push faster than
// we poll (Fourthwall, Patreon, Stripe, Buy Me a Coffee) post to a secret address on the relay:
//     <relay>/in/<inboxId>/<service>/<secret>
// The relay stores the raw delivery (7 days) and answers 200 at once; this helper keeps ONE outbound WebSocket to its
// inbox, gets everything not yet acknowledged (in order), checks each service's signature with the secret kept on THIS
// PC (server/support/connectors/*), then acknowledges it. Secrets never reach the relay; the relay can't forge events.
// The relay stores each delivery ENCRYPTED to this helper's RSA-OAEP public key (made here, sent once with /inbox/new;
// the private key never leaves the vault), so the relay's storage holds no readable supporter data or Ko-fi token.
// The inbox's own keys (its id, the pull key, the address secret, the private key) sit in the vault next to the services' keys.
// Relay: ONLY the streamer's own invite server (the one they deployed: config/discord.json relayUrl, or Settings →
// "Webhook inbox" for another relay of theirs). There is no default and no shared server: with none, webhook services
// say so in plain words and the services that poll with a pasted key keep working.
import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { SupportService } from '../../shared/supportConfig.ts';
import type { SupportHub } from './hub.ts';

/** Said when the streamer has no invite server (relay) of their own yet. */
export const NO_RELAY_MSG = 'Webhooks need your own invite server first: set it up in Settings → Invite server, then press this again. Services with a key to paste (Fourthwall, Patreon, Stripe, Buy Me a Coffee, StreamElements, Streamlabs) already work without it.';
export interface InboxCreds { relay: string; inboxId: string; pullKey: string; secret: string }

export class InboxClient {
  private ws: WebSocket | null = null;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private ping: NodeJS.Timeout | null = null;
  private retry = 2000;
  private connectedAt = 0;
  /** Deliveries handled this session (tests / diagnostics). */
  handled = 0;
  rejected = 0;

  constructor(private hub: SupportHub, private relayDefault: () => string, private fetcher: typeof fetch = fetch, private WS: typeof WebSocket = WebSocket) {}

  /** The streamer's own relay ('' = none set up yet). */
  relay(): string { return this.hub.settings.inboxRelay || this.relayDefault() || ''; }
  creds(): InboxCreds | null {
    const v = this.hub.vault;
    const c = { relay: v.get('inbox', 'relay'), inboxId: v.get('inbox', 'inboxId'), pullKey: v.get('inbox', 'pullKey'), secret: v.get('inbox', 'secret') };
    return c.inboxId && c.pullKey && c.secret && c.relay && c.relay === this.relay() ? c : null;
  }
  addressOf(service: SupportService): string { const c = this.creds(); return c ? `${c.relay}/in/${c.inboxId}/${service}/${c.secret}` : ''; }

  private set(state: 'off' | 'connecting' | 'connected' | 'unsupported' | 'error', detail: string) {
    this.hub.inboxState = { state, relay: this.relay(), detail };
    this.hub.pushStatus();
  }

  /** Make (once) this PC's inbox on the relay and return the address for `service`. */
  async ensure(service: SupportService): Promise<string> {
    let c = this.creds();
    if (!c) {
      const relay = this.relay();
      if (!relay) {
        this.set('unsupported', NO_RELAY_MSG);
        throw Object.assign(new Error(NO_RELAY_MSG), { status: 409 });
      }
      let health: Record<string, unknown> = {};
      try { health = (await (await this.fetcher(`${relay}/health`, { signal: AbortSignal.timeout(10000) })).json()) as Record<string, unknown>; } catch {
        this.set('error', 'We couldn’t reach your invite server. Check your internet, then try again.');
        throw Object.assign(new Error('We couldn’t reach your invite server. Check your internet, then try again.'), { status: 502 });
      }
      if (health.inbox !== 1) {
        this.set('unsupported', 'Your invite server has no webhook inbox yet.');
        throw Object.assign(new Error('Your invite server needs an update for webhooks: Settings → Invite server → Update.'), { status: 409 });
      }
      // a key pair for this inbox: the relay encrypts every stored delivery to the public half
      const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const pub = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const r = await this.fetcher(`${relay}/inbox/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pub }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw Object.assign(new Error(r.status === 429 ? 'Too many tries. Wait a minute and press it again.' : 'The invite server said no. Try again in a minute.'), { status: 502 });
      const j = (await r.json()) as { inboxId?: string; pullKey?: string; secret?: string };
      if (!j.inboxId || !j.pullKey || !j.secret) throw Object.assign(new Error('The invite server gave an odd answer. Try again.'), { status: 502 });
      await this.hub.vault.set('inbox', { relay, inboxId: j.inboxId, pullKey: j.pullKey, secret: j.secret, privKey: priv });
      c = this.creds();
    }
    if (!this.hub.settings.inboxServices.includes(service)) this.hub.saveSettings({ inboxServices: [...this.hub.settings.inboxServices, service] });
    await this.pushConfig();
    this.start();
    return this.addressOf(service);
  }

  /** Tell the relay what it may check at the edge (Throne: this creator's id only). No secrets. */
  async pushConfig() {
    const c = this.creds();
    if (!c) return;
    const throne = this.hub.settings.services.throne.creatorId ?? '';
    try { await this.fetcher(`${c.relay}/inbox/${c.inboxId}/config`, { method: 'POST', headers: { authorization: `Bearer ${c.pullKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ throne: { creator: throne } }), signal: AbortSignal.timeout(10000) }); } catch { /* next time */ }
  }

  /** A new address secret (the old addresses stop working: paste the new ones into each service). */
  async rotate(): Promise<void> {
    const c = this.creds();
    if (!c) return;
    const r = await this.fetcher(`${c.relay}/inbox/${c.inboxId}/rotate`, { method: 'POST', headers: { authorization: `Bearer ${c.pullKey}` }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw Object.assign(new Error('The invite server said no. Try again in a minute.'), { status: 502 });
    const j = (await r.json()) as { secret?: string };
    if (j.secret) await this.hub.vault.set('inbox', { secret: j.secret });
  }

  start() {
    if (!this.relay()) { this.set(this.hub.settings.inboxServices.length ? 'unsupported' : 'off', this.hub.settings.inboxServices.length ? NO_RELAY_MSG : ''); return; }
    if (!this.creds() || !this.hub.settings.inboxServices.length) { this.set('off', ''); return; }
    if (this.ws) return;
    this.stopped = false;
    this.connect();
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.ping) clearInterval(this.ping); try { this.ws?.close(); } catch { /* */ } this.ws = null; }

  private connect() {
    const c = this.creds();
    if (this.stopped || !c) return;
    this.set('connecting', 'Connecting to your inbox…');
    const ws = new this.WS(`${c.relay.replace(/^http/, 'ws')}/inbox/${c.inboxId}/ws`, { headers: { authorization: `Bearer ${c.pullKey}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.connectedAt = Date.now(); this.retry = 2000;
      this.set('connected', 'Connected ✓ Webhooks arrive here, even the ones sent while VTube Pro was closed (7 days).');
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => { try { ws.send('ping'); } catch { /* */ } }, 30_000);
    });
    ws.on('message', (raw) => void this.onItem(ws, String(raw)));
    ws.on('unexpected-response', (_req, res) => { if (res.statusCode === 401 || res.statusCode === 404) { this.set('error', 'Your inbox was removed on the invite server. Press “Get my address” again.'); this.stopped = true; } });
    ws.on('close', () => {
      if (this.ping) clearInterval(this.ping);
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.set('connecting', 'Reconnecting to your inbox…');
      this.timer = setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 60_000);
    });
    ws.on('error', () => { /* close follows */ });
  }

  private async onItem(ws: WebSocket, raw: string) {
    if (raw === 'pong') return;
    // the relay's item: { t:'item', seq, p: service, at: received (ms), x: { k, iv, c } } = {h, b} encrypted to us (relay/src/inbox.ts)
    let m: { t?: string; seq?: number; p?: string; at?: number; x?: { k?: string; iv?: string; c?: string } };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t !== 'item' || typeof m.seq !== 'number') return;
    const ack = (ok: boolean) => { try { ws.send(JSON.stringify({ t: 'ack', seq: m.seq, ok })); } catch { /* the relay re-sends it next time */ } };
    try {
      const at = typeof m.at === 'number' ? m.at : Date.now();
      const open = openSealed(m.x, this.hub.vault.get('inbox', 'privKey'));
      if (!open) { this.rejected++; ack(false); return; } // not for our key: it can never be read
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(open.h ?? {})) if (typeof v === 'string') headers[k.toLowerCase()] = v;
      const r = await this.hub.hook(String(m.p ?? ''), { seq: m.seq, provider: String(m.p ?? ''), at, headers, body: Buffer.from(String(open.b ?? ''), 'base64') }, at < this.hub.startedAt - 5_000 || Date.now() - at > 120_000);
      if (r.ok) this.handled++; else this.rejected++;
      // a delivery we reject (bad signature, unknown) is still acknowledged: it would never verify later either
      ack(r.ok);
    } catch (e) {
      // the helper itself failed (disk full ...): leave it on the relay, it comes back on the next connect
      console.warn('[support] inbox item not handled:', (e as Error).message);
    }
  }
}

/** Open a stored delivery: RSA-OAEP-SHA256 unwraps the one-time AES-256-GCM key (WebCrypto's ciphertext ends with the
 *  16-byte tag). null = not sealed to this key / damaged. */
export function openSealed(x: { k?: string; iv?: string; c?: string } | undefined, privPem: string): { h?: Record<string, string>; b?: string } | null {
  if (!x?.k || !x.iv || !x.c || !privPem) return null;
  try {
    const key = crypto.privateDecrypt({ key: privPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(x.k, 'base64'));
    const all = Buffer.from(x.c, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(x.iv, 'base64'));
    d.setAuthTag(all.subarray(all.length - 16));
    const text = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8');
    return JSON.parse(text) as { h?: Record<string, string>; b?: string };
  } catch { return null; }
}
