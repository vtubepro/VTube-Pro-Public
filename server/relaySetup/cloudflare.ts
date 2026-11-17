// "Set up my invite server": the Cloudflare REST calls the helper makes with the streamer's OWN Cloudflare key
// (Cloudflare calls it an "API token"). No wrangler, no Node packages, no relay source: the helper uploads the pre-built
// relay/dist/worker.js (tools/build_relay.mjs) exactly the way `wrangler deploy` would.
//
// Endpoints (https://developers.cloudflare.com/api/):
//   GET  /accounts                                             the accounts this key can reach
//   GET  /accounts/{a}/workers/subdomain                       the account's <name>.workers.dev
//   PUT  /accounts/{a}/workers/subdomain {subdomain}           pick one (first Worker on this account)
//   GET  /accounts/{a}/workers/scripts                         is the invite server there already? (migration_tag)
//   GET  /accounts/{a}/workers/scripts/{s}/settings            its current bindings (to keep the streamer's own values)
//   PUT  /accounts/{a}/workers/scripts/{s}                     multipart upload: metadata + worker.js (+ secrets incl. your Discord app's, migration)
//   POST /accounts/{a}/workers/scripts/{s}/subdomain           {enabled:true, previews_enabled:false}
//   POST /accounts/{a}/calls/turn_keys {name}                  optional TURN key → {uid, key}
// The key lives in memory only (server/routes/relaySetup.ts); nothing here logs, stores or echoes it.
import crypto from 'node:crypto';

export const CF_API = 'https://api.cloudflare.com/client/v4';
/** Pre-filled "Create API token" page: Workers Scripts Edit + Account Settings Read, every account, named for us.
 *  Documented: https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/ */
export const TOKEN_TEMPLATE_URL = 'https://dash.cloudflare.com/profile/api-tokens?' + new URLSearchParams({
  permissionGroupKeys: JSON.stringify([{ key: 'workers_scripts', type: 'edit' }, { key: 'account_settings', type: 'read' }]),
  accountId: '*', zoneId: 'all', name: 'VTube Pro invite server',
}).toString();

export interface RelayManifest {
  v: 1; kind: 'vtube-pro-relay'; version: string; scriptName: string; mainModule: string; bytes: number; sha256: string;
  compatibilityDate: string; durableObject: { binding: string; className: string };
  /** Every Durable Object binding when there is more than one (beta.13: + INBOXES → Inbox, the webhook inbox). */
  durableObjects?: { binding: string; className: string }[];
  migrations: { tag: string; newSqliteClasses: string[] }[]; vars: Record<string, string>;
  workersDev: boolean; previewUrls: boolean; observability: boolean;
}
export interface Account { id: string; name: string }
type Fetch = typeof fetch;
export interface CfOptions { token: string; api?: string; fetch?: Fetch; timeoutMs?: number }

/** One friendly sentence per failure (VOICE rule 7). `detail` is Cloudflare's own text, shown only under Details. */
export class CfError extends Error {
  constructor(public kind: 'bad-key' | 'no-permission' | 'network' | 'not-found' | 'conflict' | 'cloudflare' | 'need-discord', message: string, public status = 0, public detail = '') { super(message); }
}
export const FRIENDLY: Record<CfError['kind'], string> = {
  'bad-key': 'Cloudflare didn’t accept that key. Copy it again and paste it here.',
  'no-permission': 'That key can’t set up Workers. Make a new one with the Open Cloudflare button: it fills in the right boxes.',
  network: 'We couldn’t reach Cloudflare. Check your internet, then try again.',
  'not-found': 'Cloudflare couldn’t find that. Try again in a minute.',
  conflict: 'That name is taken. Try again: we’ll pick another one.',
  cloudflare: 'Cloudflare said no this time. Try again, or press Get help.',
  'need-discord': 'Your invite server needs your own Discord application first. Paste its Client ID and Client Secret (Discord Developer Portal → your app → OAuth2).',
};

const KEY_SHAPE = /^[A-Za-z0-9_-]{30,80}$/;
/** Local shape check before anything leaves the PC (also catches a pasted Global API Key / e-mail / account id). */
export function checkKeyShape(raw: unknown): { key: string } | { error: string } {
  const key = String(raw ?? '').trim().replace(/^Bearer\s+/i, '');
  if (!key) return { error: 'Paste the key Cloudflare showed you.' };
  if (/@/.test(key)) return { error: 'That looks like an e-mail address. Paste the key Cloudflare showed you instead.' };
  if (/^[a-f0-9]{32}$/.test(key)) return { error: 'That looks like an account id. Paste the key from the “Create Token” page.' };
  if (/^[a-f0-9]{37}$/.test(key)) return { error: 'That is the old “Global API Key”. Please make a new key with the Open Cloudflare button.' };
  if (!KEY_SHAPE.test(key)) return { error: 'That doesn’t look like a Cloudflare key. Copy it again with the Copy button on Cloudflare.' };
  return { key };
}

export class Cloudflare {
  private api: string; private f: Fetch; private token: string; private timeout: number;
  constructor(o: CfOptions) { this.api = (o.api ?? CF_API).replace(/\/+$/, ''); this.f = o.fetch ?? fetch; this.token = o.token; this.timeout = o.timeoutMs ?? 30_000; }

  private async call<T>(method: string, p: string, body?: unknown): Promise<T> {
    let r: Response;
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
      r = await this.f(`${this.api}${p}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
        redirect: 'error',
      });
    } catch {
      throw new CfError('network', FRIENDLY.network);
    }
    const j = (await r.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] } | null;
    if (r.ok && j && j.success !== false) return j.result as T;
    const errs = j?.errors ?? [];
    const detail = errs.map((e) => `${e.code ?? ''} ${String(e.message ?? '').slice(0, 160)}`.trim()).join('; ').replace(this.token, '[key]').slice(0, 400);
    const codes = errs.map((e) => Number(e.code));
    const kind: CfError['kind'] = r.status === 401 || codes.some((c) => c === 9109 || c === 6003 || c === 6111 || c === 1000) ? 'bad-key'
      : r.status === 403 || codes.includes(10000) ? 'no-permission'
        : r.status === 404 ? 'not-found' : r.status === 409 ? 'conflict' : 'cloudflare';
    throw new CfError(kind, FRIENDLY[kind], r.status, detail || `HTTP ${r.status}`);
  }

  async accounts(): Promise<Account[]> {
    const list = await this.call<{ id: string; name: string }[]>('GET', '/accounts?per_page=50');
    return (list ?? []).filter((a) => /^[a-f0-9]{32}$/.test(String(a.id))).map((a) => ({ id: a.id, name: String(a.name ?? '').slice(0, 80) }));
  }
  /** '' when the account has no workers.dev name yet. */
  async subdomain(account: string): Promise<string> {
    try { return String((await this.call<{ subdomain?: string }>('GET', `/accounts/${account}/workers/subdomain`))?.subdomain ?? ''); } catch (e) {
      if (e instanceof CfError && (e.kind === 'not-found' || /10007|subdomain/i.test(e.detail))) return '';
      throw e;
    }
  }
  async createSubdomain(account: string, name: string): Promise<string> {
    return String((await this.call<{ subdomain: string }>('PUT', `/accounts/${account}/workers/subdomain`, { subdomain: name })).subdomain ?? name);
  }
  /** null when the script does not exist; else its last Durable Object migration tag ('' = none). */
  async script(account: string, name: string): Promise<{ migrationTag: string } | null> {
    const list = await this.call<{ id: string; migration_tag?: string }[]>('GET', `/accounts/${account}/workers/scripts`);
    const s = (list ?? []).find((x) => x.id === name);
    return s ? { migrationTag: String(s.migration_tag ?? '') } : null;
  }
  /** The script's current bindings: plain_text values (to keep), secret names (values are never returned). */
  async bindings(account: string, name: string): Promise<{ vars: Record<string, string>; secrets: string[] }> {
    const s = await this.call<{ bindings?: { type: string; name: string; text?: string }[] }>('GET', `/accounts/${account}/workers/scripts/${name}/settings`);
    const vars: Record<string, string> = {}, secrets: string[] = [];
    for (const b of s?.bindings ?? []) {
      if (b.type === 'plain_text' && typeof b.text === 'string') vars[b.name] = b.text;
      else if (b.type === 'secret_text') secrets.push(b.name);
    }
    return { vars, secrets };
  }
  /** The `wrangler deploy` equivalent: worker.js + metadata (bindings, secrets, Durable Object migration). */
  async upload(account: string, m: RelayManifest, code: Uint8Array, o: { vars: Record<string, string>; secrets: Record<string, string>; migrateFrom: string | null; update: boolean }) {
    const last = m.migrations[m.migrations.length - 1];
    const metadata: Record<string, unknown> = {
      main_module: m.mainModule,
      compatibility_date: m.compatibilityDate,
      bindings: [
        ...(m.durableObjects?.length ? m.durableObjects : [m.durableObject]).map((d) => ({ type: 'durable_object_namespace', name: d.binding, class_name: d.className })),
        ...Object.entries(o.vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
        ...Object.entries(o.secrets).map(([name, text]) => ({ type: 'secret_text', name, text })),
      ],
      observability: { enabled: m.observability },
    };
    if (o.update) metadata.keep_bindings = ['secret_text'];      // secrets we don't resend stay as they are
    if (o.migrateFrom !== null && o.migrateFrom !== last.tag) {
      // new script: create the SQLite-backed Room class (works on the Workers Free plan); old script: catch up
      // every migration after the script's tag (a new script: all of them), as steps when there is more than one
      const from = o.migrateFrom ? m.migrations.findIndex((x) => x.tag === o.migrateFrom) : -1;
      const todo = m.migrations.slice(from + 1);
      metadata.migrations = todo.length > 1
        ? { ...(o.migrateFrom ? { old_tag: o.migrateFrom } : {}), new_tag: last.tag, steps: todo.map((x) => ({ new_sqlite_classes: x.newSqliteClasses })) }
        : { ...(o.migrateFrom ? { old_tag: o.migrateFrom } : {}), new_tag: last.tag, new_sqlite_classes: last.newSqliteClasses };
    }
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append(m.mainModule, new Blob([new Uint8Array(code)], { type: 'application/javascript+module' }), m.mainModule);
    await this.call('PUT', `/accounts/${account}/workers/scripts/${m.scriptName}`, form);
  }
  async enableWorkersDev(account: string, name: string) {
    await this.call('POST', `/accounts/${account}/workers/scripts/${name}/subdomain`, { enabled: true, previews_enabled: false });
  }
  async createTurnKey(account: string): Promise<{ uid: string; key: string }> {
    const r = await this.call<{ uid: string; key: string }>('POST', `/accounts/${account}/calls/turn_keys`, { name: 'VTube Pro invite server' });
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(r?.uid)) || !r?.key) throw new CfError('cloudflare', FRIENDLY.cloudflare, 200, 'unexpected TURN answer');
    return { uid: r.uid, key: r.key };
  }
}

// ---------------------------------------------------------------- small pure helpers (unit-tested)
const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';        // the same alphabet as relay/deploy.ps1 (no 0 O 1 I L)
/** A one-time host code like K7QF-M2XR, and its fingerprint for the HOST_CLAIM secret (relay/src/claim.ts claimHash). */
export function newClaimCode(): { code: string; hash: string } {
  const b = crypto.randomBytes(8);
  const chars = [...b].map((x) => ABC[x % ABC.length]);
  const code = `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
  return { code, hash: claimHashOf(code) };
}
export const claimHashOf = (code: string) => crypto.createHash('sha256').update(`vtp-claim-v1|${code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32)}`).digest('hex');
/** TICKET_SECRET: 32 random bytes, base64 (same as deploy.ps1). */
export const newTicketSecret = () => crypto.randomBytes(32).toString('base64');
/** A workers.dev name that says nothing about the streamer (it shows in every guest link): vtp-<7 letters/digits>. */
export function privateSubdomain(): string {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return `vtp-${[...crypto.randomBytes(7)].map((x) => a[x % a.length]).join('')}`;
}
export const workersDevUrl = (script: string, sub: string) => `https://${script}.${sub}.workers.dev`;
