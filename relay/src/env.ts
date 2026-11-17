// Worker configuration. Secrets are set with `npx wrangler secret put <NAME>` (never in the repo); plain vars live
// in wrangler.toml [vars]. The *_API / *_AUTHORIZE overrides exist only for the local mock (tools/mock_relay.ts).
export interface Env {
  /** Durable Object namespace (wrangler.toml [[durable_objects.bindings]]). */
  ROOMS: DurableObjectNamespace;
  /** The webhook inbox (inbox.ts, beta.13): one object per streamer's inbox + the Kick router. Absent = no inbox here. */
  INBOXES?: DurableObjectNamespace;
  /** Tests only: replace Throne's / Kick's public webhook key (PEM). */
  THRONE_PUBLIC_KEY?: string;
  KICK_PUBLIC_KEY?: string;
  /** Tests only: a smaller inbox size (default 2000 deliveries). */
  INBOX_MAX?: string;
  /** REQUIRED: the Client ID of YOUR OWN Discord application (Discord developer portal → your app → OAuth2). */
  DISCORD_CLIENT_ID?: string;
  /** SECRET, REQUIRED: that same application's client secret. Discord sign-in runs the code exchange here, with your app. */
  DISCORD_CLIENT_SECRET?: string;
  /** SECRET: Discord bot token (posts / edits the "is live — Join" invite). Optional: without it no bot posts. */
  DISCORD_BOT_TOKEN?: string;
  /** SECRET: ≥ 32 random chars; signs tickets, host sessions and OAuth state. Rotate it to revoke everything. */
  TICKET_SECRET: string;
  /** Advanced override: comma-separated Discord user ids that may always HOST. Normally empty: the first person who
   *  signs in and types the setup's claim code becomes the host (HOST_CLAIM, claim.ts). */
  HOST_USER_IDS?: string;
  /** SECRET: hex SHA-256 of "vtp-claim-v1|" + the one-time claim code the setup script showed (never the code itself). */
  HOST_CLAIM?: string;
  /** Loopback redirect URIs the desktop app may use for host sign-in (default http://127.0.0.1:5191/api/discord/callback). */
  LOCAL_REDIRECTS?: string;
  /** Where the guest's browser is sent after Join (their own VTube Pro). Default http://127.0.0.1:5191/join */
  APP_JOIN_URL?: string;
  /** Cloudflare Realtime / Calls TURN key id + SECRET API token (optional). */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Any other TURN server with a shared REST secret (coturn `use-auth-secret`): comma-separated turn: URLs + SECRET. */
  TURN_URLS?: string;
  TURN_SHARED_SECRET?: string;
  /** TURN credential lifetime in seconds (default 14400 = 4 h). */
  TURN_TTL?: string;
  /** Room lifetime cap in hours (default 12). */
  ROOM_TTL_H?: string;
  /** Optional show name guests see instead of the host's Discord display name (guest pages, the bot's post, the
   *  waiting screen). Empty = the host's Discord display name. Not a secret. docs/HOSTING_SETUP.md#private-links */
  PUBLIC_NAME?: string;
  /** Mock / testing overrides. */
  DISCORD_API?: string;
  DISCORD_AUTHORIZE?: string;
  CF_TURN_API?: string;
}

export const discordApi = (env: Env) => env.DISCORD_API || 'https://discord.com/api/v10';
export const discordAuthorize = (env: Env) => env.DISCORD_AUTHORIZE || 'https://discord.com/oauth2/authorize';
export const hostIds = (env: Env) => new Set(String(env.HOST_USER_IDS ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d{5,25}$/.test(s)));
export const localRedirects = (env: Env) => new Set(String(env.LOCAL_REDIRECTS || 'http://127.0.0.1:5191/api/discord/callback').split(',').map((s) => s.trim()).filter(Boolean));
/** The name guests see for the host: PUBLIC_NAME when set, else the host's Discord display name. */
export const shownHostName = (env: Env, discordName: unknown) => (cleanName(env.PUBLIC_NAME) || String(discordName ?? 'Host')).slice(0, 40);
const cleanName = (s: unknown) => String(s ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().split('').filter((c) => c >= ' ').join('');
const CID = /^[A-Za-z0-9._-]{4,200}$/;
/** The Client ID of the deployer's own Discord application ('' = not set). There is no built-in default. */
export const discordClientId = (env: Env) => { const id = String(env.DISCORD_CLIENT_ID ?? '').trim(); return CID.test(id) ? id : ''; };
/** Discord sign-in needs the deployer's OWN app: its Client ID and its client secret. */
export const discordReady = (env: Env) => !!discordClientId(env) && !!String(env.DISCORD_CLIENT_SECRET ?? '').trim();
/** Plain words shown (and returned as JSON) when sign-in is asked for before the deployer set their own Discord app. */
export const DISCORD_MISSING = 'Discord sign-in is not set up on this invite server yet. The person who runs it must set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET to the values of their own Discord application (see relay/README.md or docs/HOSTING_SETUP.md).';
export const appJoinUrl = (env: Env) => env.APP_JOIN_URL || 'http://127.0.0.1:5191/join';
