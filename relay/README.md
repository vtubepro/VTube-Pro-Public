# VTube Pro relay (Cloudflare Worker + Durable Object)

The signalling relay for VTube Pro's Discord multiplayer. It carries only the WebRTC handshake (SDP + ICE) and room
control; avatars and tracking go peer-to-peer. Full guide and the Discord steps: `../docs/MULTIPLAYER_DISCORD.md`.

**It is entirely yours.** You deploy this Worker on your own Cloudflare account and you create your own Discord
application (a free bot) for sign-in. Nothing here talks to anyone else's server, Discord app or website: no shared
sign-in, no hosted link shortener, no hosted phone server.

## Sign-in (your own Discord application)

Make an application at <https://discord.com/developers/applications> (New Application, then OAuth2). The relay needs
these values, and nothing else signs people in:

| Setting | Where | What |
|---|---|---|
| `DISCORD_CLIENT_ID` | `wrangler.local.toml` `[vars]` | the application's Client ID (OAuth2 page) |
| `DISCORD_CLIENT_SECRET` | secret (`wrangler secret put`) | the application's Client Secret (OAuth2, Reset Secret) |
| `TICKET_SECRET` | secret | at least 32 random chars; signs tickets and sessions (the setup makes it for you) |
| `HOST_CLAIM` | secret | hash of the one-time claim code the setup shows (see below) |
| `DISCORD_BOT_TOKEN` | secret, optional | your application's bot token: posts the "is live, Join" message in your server |

Add `https://<your relay>/cb` and `http://127.0.0.1:5191/api/discord/callback` as OAuth2 Redirects in the Developer
Portal. Sign-in is the classic code flow with PKCE (`/j` then `/cb`, and `/oauth/exchange` with the secret); access
tokens are used once and dropped. There is no built-in or shared Discord application and no Google sign-in: while
`DISCORD_CLIENT_ID` or `DISCORD_CLIENT_SECRET` is missing, the sign-in routes answer in plain words that the person who
runs this invite server must set them. Guests who use a no-sign-in guest link (`/g/<token>`) need neither.

**Claim your relay** (`src/claim.ts`): the setup shows a one-time code (8 chars, no 0/O/1/I/L) and stores
`HOST_CLAIM` = hex SHA-256 of `"vtp-claim-v1|" + code` (uppercase, letters/digits only). A Discord user who isn't a
host gets `403 {error:"claim-needed", claim:<10-min signed ticket>}` from `/oauth/exchange`; `POST /claim {claim, code}`
(5/min per IP, ≤ 20 wrong codes an hour per relay) stores that one Discord id in the `host-signin` Durable Object's
storage (the only lasting stored value; a room keeps one record of its own only while it runs)
and returns the host session. The owner is bound to the claim hash: a new code (setup → "Make a NEW claim code") hands the relay to whoever types it. `HOST_USER_IDS` stays an
advanced override (`-HostIds`). 

Routes: `GET /j/<room>[?as=tv]` (guest sign-in with your Discord app), `GET /cb` (its callback),
`GET /oauth2/authorize` (the desktop app's host sign-in; forwarded to Discord with your app) and `POST /oauth/exchange`.

## Deploy (you run this; it uses YOUR Cloudflare account)

Beginner guide, every click: `../docs/HOSTING_SETUP.md` (in the studio: Help → Hosting setup).

0. **The easy way: the studio does it.** The page
   `http://127.0.0.1:5191/invite-server` (`server/routes/relaySetup.ts`, local-only) builds `relay/dist/worker.js` from
   this folder (`node tools/build_relay.mjs`: esbuild, no network) and uploads it through the
   Cloudflare REST API with a user-made API token (Workers Scripts Edit + Account Settings Read, pre-filled link):
   workers.dev name (random `vtp-…` for new accounts), script + `ROOMS`/`Room` SQLite migration `v1`, `TICKET_SECRET`
   + `HOST_CLAIM` secrets (`keep_bindings: ["secret_text"]` on updates), workers.dev on, optional TURN key. It saves the
   address into `config/discord.json` and uses the host code automatically on the next Discord sign-in. It only
   ever talks to the Cloudflare account that API token belongs to: yours.
   The steps below are for the source tree (developers, the owner).
1. Windows: double-click **Set up my relay.cmd** (= `powershell -ExecutionPolicy Bypass -File deploy.ps1`). Mac / Linux:
   `sh deploy.sh`. It asks for your Discord application's `DISCORD_CLIENT_ID`, optional `PUBLIC_NAME` / `TURN_KEY_ID` / a custom
   domain (the `DISCORD_CLIENT_SECRET` and the optional bot token go into wrangler's hidden prompt), writes them into `wrangler.local.toml` (git-ignored, never shipped; the previous one is kept as
   `wrangler.local.toml.bak`), signs in (`wrangler login`), deploys, sets the secrets (`TICKET_SECRET` is generated and
   piped to `wrangler secret put`; the others go into wrangler's hidden prompt) and prints the relay URL + the OAuth
   redirects to paste. Run it again any time: Enter keeps each saved value; existing secrets are only replaced on request.
   `deploy.ps1 -DryRun` (alias `-WhatIf`) / `sh deploy.sh --dry-run`: practice run, no sign-in, no network, nothing
   written in this folder. Non-interactive: `-NoPrompt -ClientId … -HostIds … [-PublicName …] [-TurnKeyId …]
   [-Domain join.example.com -WorkersDev keep|off]`; `-SecretsOnly` only (re)sets secrets.
2. Or by hand: copy `wrangler.toml` to `wrangler.local.toml`, fill its `[vars]`, then

```
npx wrangler login
npx wrangler deploy -c wrangler.local.toml
npx wrangler secret put TICKET_SECRET -c wrangler.local.toml          # ≥ 32 random chars
npx wrangler secret put DISCORD_CLIENT_SECRET -c wrangler.local.toml  # your own Discord app's client secret (required)
npx wrangler secret put DISCORD_BOT_TOKEN -c wrangler.local.toml      # optional: the "is live — Join" post
npx wrangler secret put TURN_KEY_API_TOKEN -c wrangler.local.toml     # optional: Cloudflare Realtime TURN
```

3. Add `https://<your relay>/cb` and `http://127.0.0.1:5191/api/discord/callback` as OAuth2 Redirects in your Discord
   application (Developer Portal), then paste the relay URL and the Client ID into VTube Pro's **Set up multiplayer
   (Discord)** helper.

`wrangler.toml` is the shipped TEMPLATE: keep `DISCORD_CLIENT_ID`, `HOST_USER_IDS`, `PUBLIC_NAME`, `TURN_KEY_ID` empty
and no active `[[routes]]` in it. Secrets are never in this
folder or the repo. Rotating `TICKET_SECRET` revokes every ticket and host session.

### Private links (custom domain)

Every link the relay makes (`/j/…`, `/g/…`, `/cb`, `/tv`) is built from the request origin, so serving the Worker on
your own hostname gives clean links automatically. In `wrangler.local.toml` (deploy.ps1 writes this):

```
workers_dev = true          # keep the old address until the new one works, then false
[[routes]]
pattern = "join.example.com"
custom_domain = true
```

The zone must be active on the same Cloudflare account. Then add `https://join.example.com/cb` to the Discord
redirects and use `https://join.example.com` as the studio's relay URL. Note: with `[[routes]]` present and no explicit
`workers_dev`, wrangler turns workers.dev OFF on deploy; the template sets it explicitly. `preview_urls = false` keeps
per-version preview URLs (which also carry the account subdomain) off. `PUBLIC_NAME` replaces the host's Discord
display name on guest pages, in the bot post and in the guest welcome; no-sign-in link guests never receive the
host's Discord id or avatar.

## Updating (rooms that sleep, 2026-10-04)

Rooms use the WebSocket Hibernation API: an idle party bills (almost) no Durable Object duration. Redeploy with
no party running (a new version restarts the rooms); no new secrets or settings.

## Updating (TV guests, 2026-09-26)

**guestlink update** (interview links `/g/…`, `?as=tv`, voice over the link): redeploy once from `relay/` with
`node ../tools/build_tv_guest.mjs && npx wrangler deploy` (or `deploy.ps1`). No new secrets. Until then the app says
“Your relay is older than this feature”.

The `/tv` page (browser-only TV guests) is new: after updating VTube Pro, redeploy once from `relay/`:
`node ../tools/build_tv_guest.mjs && npx wrangler deploy` (or `deploy.ps1`). No new secrets or settings. Until then
everything else keeps working; the sign-in page just doesn't offer *Join with my webcam instead*.

## Routes

| Route | |
|---|---|
| `GET /j/<room>` | guest clicked Join → Discord OAuth (identify, + guilds.members.read when the room is server-only) |
| `GET /cb` | OAuth callback → guild / role / ban checks → 10-min single-use ticket → opens the guest's VTube Pro (after 3 s), or *Join with my webcam instead* → `/tv` |
| `GET /g/<token>` · `POST /g/ticket` | guestlink: the **no-sign-in interview link** (same page as `/tv` + a name box). The token is a signed `gi` invite (room, generation, max guests, ≤ 12 h); the room keeps the current generation, so a new link / *Turn link off* / ending the party revokes it. `/g/ticket` (same-origin JSON, 12/min/IP) trades it + the guest's name + a per-tab key for a 10-min guest ticket with a relay-made `link…` id and `nv` (not verified) |
| `POST /api/rooms/<id>/guestlink` | (host session) mint `{max, hours}` → `{url, discordUrl, expiresAt, max}`, or `{revoke:true}` |
| `GET /j/<room>?as=tv` | the Discord sign-in link that lands straight on `/tv` (verified name, skips the VTube Pro page) |
| `GET /tv` | no VTube Pro? join in this browser as a **walking TV** (webcam / VTube Studio). The ticket stays in the `#fragment`; the page is `src/tvGuestPage.gen.ts`, built from `tvguest/main.ts` + the app's `src/net/tv/*` by `node tools/build_tv_guest.mjs` (repo root) — rebuild it before deploying when that code changed. CSP: scripts by nonce only, network only to this relay; `Permissions-Policy` camera / microphone / display-capture for this page only |
| `POST /oauth/exchange` | host sign-in (desktop loopback code + PKCE verifier) → identity + host session |
| `GET /api/channels`, `POST /api/rooms`, `POST /api/rooms/<id>/ticket`, `POST /api/rooms/<id>/end` | host API (Bearer host session, `HOST_USER_IDS` only) |
| `GET /room/<id>/ws` | signalling WebSocket (Durable Object) |

## Develop / test without an account

`src/` is platform-neutral: `app.ts` (HTTP), `room.ts` (the room), `tickets.ts`, `discord.ts`, `turn.ts`; `index.ts` is
the Worker/DO wrapper. Typecheck from the repo root:

```
npx tsc --noEmit -p relay                                             # typecheck (no Cloudflare types needed)
```
