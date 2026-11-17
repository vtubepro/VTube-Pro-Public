# VTube Pro Live: broadcast protocol (v1)

Status: contract frozen at Stage 1.0 (contract rev 1). The types are in [shared/broadcastTypes.ts](../shared/broadcastTypes.ts);
this file is the prose and the wire formats. Both are the future published spec of the VTube Pro Live Engine
(text released CC0 when the engine ships). Workstreams W1 to W7 (docs/broadcast/OWNERSHIP.md) code
against them and do not edit them. A change goes to the integrator, who edits both files together and bumps
`BROADCAST_CONTRACT_REV`.

Plan: `VTube Pro Release/broadcaster/design/PLAN.md` (sections 3, 4.3 and 5, Phase 1).

Tags: **[today]** works in Phase 1 against stock OBS (any OBS with obs-websocket v5). **[engine]** is the VTube Pro Live
Engine, Phase 2 and later; the server must work without it. **[verify]** is an OBS fact still to be checked against
the 33.0.1 source in Phase 0 (P0-B).

## 1. The Go Live rule (graft G1)

A stream starts **only** when a person deliberately clicks Go Live in the studio, or presses a Stream Deck key **and**
confirms it on screen. Never from an AI connector or MCP tool, autopilot, a schedule, a macro, a relay message, a
command-line flag, an update or a crash recovery. A crash recovery only ever asks ("You were live; go live again?"): it is a
click path. (`recover` holds a guarded auto-resume branch, window 90 s, at most 3 per rolling hour, notice shown. It runs only
when the server starts with `VTP_BROADCAST_AUTORESUME=1`, a test switch that no installer, launcher or config sets. Off by
default; the user guide does not promise it.)

The click is also only asked for in a window that owns itself: the studio HTML is sent with `Content-Security-Policy: frame-ancestors`
(index.html and live.html: `'self'` plus `X-Frame-Options: SAMEORIGIN`; the other studio pages: the four loopback studio origins on
ports 5190 and 5191; the Vite dev server: the same allowlist) so a website cannot frame it under an overlay, and
`goLiveTab` asks for no token (`POST /intent`) when `window.top` is another origin (`framedByStranger`).

### 1.1 Sources

| Source (`IntentSource`) | May start? |
|---|---|
| `click` | Yes: the studio on this PC. |
| `deck-confirmed` | Yes: the deck key was pressed, then the studio's confirm toast was clicked within `DECK_CONFIRM_MS` (10 s). |
| `crash-resume` | Only through the resume rule (section 1.4). |
| `deck-unconfirmed`, `mcp`, `autopilot`, `schedule`, `relay`, `update`, `cli`, `macro`, `unknown` | **Never.** `INTENT_REFUSED_SOURCES`. |

The source is decided by the connection and the route, not by trusting the body. A request is origin `local-page` only when
it has an `Origin` of this PC AND carries the three headers a browser stamps on every fetch (`Sec-Fetch-Site` same-origin or
same-site, `Sec-Fetch-Mode` cors or same-origin, `Sec-Fetch-Dest` empty). A request with no `Origin` (curl, tools, MCP,
Stream Deck HTTP), or with an `Origin` typed by hand and no such headers, is origin `tool`: it can never get a token.
A real click carries `gesture.trusted = event.isTrusted` from the page.

**Honest limit (threat model).** None of this is a lock against a program that runs on this PC as you and forges the
browser headers, the `Origin` and the `gesture` body together: it is then indistinguishable from the studio page, and
could ask for a token and start. Such a program can already read your files and drive OBS directly, so Go Live does not
pretend to stop it. What the rule does guarantee: no website, no other device, no MCP tool or scope, no
Stream Deck key without an on-screen click, no schedule, macro, relay message, update, command-line flag or crash can start
a stream, and a script that does not impersonate a browser cannot. `tools/broadcast_api_e2e.ts` pins both halves: the
forged-`Origin`-only request is refused, and the fully forged one is accepted (the "DOCUMENTED LIMIT" check), so this text
cannot drift from the code.

A `deck-confirmed` request is proven by the server's own record of the key press (`server/deck.ts` `deckGoLive.confirm`): the
route redeems the press once, and only the exact press time the server remembered, inside `DECK_CONFIRM_MS`, is accepted.
The page's own number is never enough; a request with no real key press behind it gets `not-confirmed`.

### 1.2 Sequence

1. **Check my setup**: `POST /preflight` returns green, amber and red rows, each with a one-click fix. The server fills the rows from
   facts it already has, without new polling and without any outside speed test: tracking and the graphics card from the studio's
   `cache/diag/state.json`; microphone, video encoder and doubled sound from a few read-only OBS requests
   (`ObsBackend.setupProbe`); the internet row from the best bitrate a real show held for 30 s without dropped frames. A row with
   no facts is left out of the answer (`hideNoDataRows`); the verdict is the full one. See `server/broadcast/setupFacts.ts`.
2. The person presses **Go Live**. The confirm card opens and the page calls `POST /intent` with the exact plan
   the card shows (destinations, title, category). The server answers a single-use token valid for
   `INTENT_TTL_MS` (30 s), bound to `planHash` of that plan.
3. The person presses **Start** on the card. The page calls `POST /start { token, plan }`.
4. The server redeems the token (once), checks it against the plan, refuses if the other broadcaster is live, writes
   `live.json`, reads each destination's key from the vault, remembers the person's own stream service in RAM
   (`ServiceRestorer.snapshotService`, OBS: `GetStreamServiceSettings`; if that fails the start stops with `backend-unreachable` and
   nothing is changed, same for the dry run), calls `BroadcastBackend.setServiceInRam` (OBS:
   `SetStreamServiceSettings`) and then `startOutput('stream')` (OBS: `StartStream`). Exactly one start call per click.
5. **End Show**: `POST /stop`. It stops the output and finishes within 2 s. Stopping needs no token. Once OBS reports the
   output off (after End Show, or when the stream ended by itself, or when a start failed after the snapshot) the server
   puts the remembered service back (`restoreService`). The snapshot lives in the server's RAM only; a server that
   restarted mid-show has none, and crash resume (`recover`) takes no snapshot because OBS already holds the show's service.

A dry run (`POST /dry-run`, "10 s private test") uses the same token but its plan has `dryRun: true`: the program goes
only to the local sink and can never start a real destination. It needs the local test receiver (`VTP_BROADCAST_SINK`,
the dev tool `tools/broadcast_sink.ts`); `BroadcastStatus.dryRunAvailable` says whether one is set up, and the studio
shows the test button only then. Its 3 to 30 s timer belongs to one run id: it ends that test only, never a later test
or a real show, and is cancelled when the test output ends by itself.

### 1.3 Refusals

Every refusal is `{ ok:false, code, error }` with a plain-words `error`. HTTP status in brackets.

| `code` | Meaning |
|---|---|
| `no-token` [403] | No token presented. |
| `token-expired` [403] | Older than `INTENT_TTL_MS`. |
| `token-replayed` [403] | Already redeemed. |
| `token-mismatch` [403] | The plan sent with `/start` differs from the plan the token was issued for. |
| `source-not-allowed` [403] | A refused source. |
| `not-confirmed` [403] | Deck key without the on-screen confirm inside `DECK_CONFIRM_MS`. |
| `foreign-origin` [403] | A web page that is not this PC's studio. |
| `local-only` [403] | Keys and a changed stream address from anything but VTube Pro's own page on this PC: a program with no browser Origin (curl, a Stream Deck or Companion HTTP action, a script, an AI tool) is refused too. |
| `other-live` [409] | The other broadcaster (stock OBS vs the engine) already has an output running. |
| `already-live` / `not-live` / `busy` [409] | State conflicts. |

Zero `StartStream` calls happen on any refusal.

### 1.4 Crash resume

`live.json` (`LiveJournal`) records the click that started the show, the plan, a heartbeat (`lastAliveAt`) and the
times of earlier resumes. After a server or engine crash the server may restart the stream itself, only when started with `VTP_BROADCAST_AUTORESUME=1` (off by default), and only if all hold:
the journal says a person started this show (`source` is `click` or `deck-confirmed`) and did not end it, the
heartbeat is at most `RESUME_WINDOW_MS` (90 s) old (the heartbeat is kept in memory every second but written to `live.json` asynchronously and at most every 5 s, `BEAT_WRITE_EVERY_MS`), fewer than `RESUME_MAX_PER_HOUR` (3) resumes in the last hour. The
studio shows a notice. Otherwise `GoLiveState.resumeOffer` is set and the studio asks "You were live; go live again?"
(a normal click path). Resume never applies after a reboot, an update, or when the journal says it ended cleanly.

### 1.5 What may never start a stream

A unit test (W7, `tools/golive_guard_unit.ts`) lists every MCP tool, autopilot action, deck command, relay message and
CLI flag, and fails if any of them can reach `BroadcastBackend.startOutput`/`startRecord` without the section 1.2
path. `server/mcpScopes.ts` has no `golive` capability. Recording follows the same rule: `POST /record { action:"start" }`
needs a fresh intent token (a plan with `record: true`), Go Live starts a recording only when `plan.record` is true, and
stopping never needs a token.

## 2. Transport and security

- **Server API** [today]: `http://127.0.0.1:5191/api/broadcast/*` (section 7). Behind `server/localGuard.ts`. Reads
  and writes: this PC's pages. Keys (`/keys/*`): VTube Pro's own page on this PC only (403 `local-only` for any web
  origin and for a request with no browser Origin: `keyWriteAllowed`, server/broadcast/keys.ts), registered with
  `webLocalOnly()` by the routes file. `POST /destinations` that sets a typed stream address (a new destination, or a
  changed one) follows the same rule: a stored key must not be pointed at another
  address by anyone but the person's own page. Elsewhere a destination keeps its address or uses the platform's own ingest.
- **Engine control** [engine]: obs-websocket v5 on `127.0.0.1:<random 44000-44999>` (never 4455), per-launch password
  on a command line the server owns, plus the vendor `vtube-pro-live`. The server re-adopts a running engine from
  `engine.json` and the password in the vault (`vaultField.enginePassword`).
- **Engine side channels** [engine]: `/pcm` (studio show audio to the engine) and `/preview.mjpg` (engine to the studio),
  proxied through the server with per-session tokens (Chrome local-network prompts, risk R14).
- **Secrets.** No GET returns a key or token. They never appear in logs, diagnostics, support bundles, the relay, the
  bus or the browser. `SECRET_FIELDS` in the types file is the list tests grep for. Keys sit in the DPAPI vault scope
  `broadcast` (`server/support/vault.ts`, via W3's `keys.ts`); the engine gets them in RAM at Go Live only
  (`service.set`). **Stock OBS stores the key in its own profile**: the UI says so in one plain line
  (`BroadcastStatus.keyNote`).
- **Test discipline.** Tests use `tools/mock_obs.ts`, `tools/mock_twitch.ts` and a local RTMP sink on private ports.
  Never the real OBS (4455), never 5190/5191, never a real platform.

## 3. Vendor requests [engine]

All are obs-websocket v5 `CallVendorRequest` with `vendorName: "vtube-pro-live"` [verify: P0-B item 4]. Request and
response bodies are JSON. Every response has `ok: boolean` and, on failure, `say` (one plain sentence). Unknown
requests answer `{ ok:false, say:"unsupported" }`. `vtp.hello` is the version handshake.

| `requestType` | Request data | Response data |
|---|---|---|
| `vtp.hello` | `{ protocol: 1, client: string }` | `{ protocol: 1, engine: string, capabilities: BackendCapabilities }` |
| `look.apply` | `{ spec: ShowSpec, version: 1 }` | `{ applied: number, snapshotId: string }`. Atomic and journaled; on failure nothing changes. `{ undo: snapshotId }` restores. |
| `room.set` | `{ cameras: RoomData["cameras"], quad: RoomData["quad"], fit: RoomData["fit"] }` | `{}`. Changes room data only; never creates or removes sources. |
| `place.capture` | `{ itemId: string, quad: [[x,y],[x,y],[x,y],[x,y]], fit: "fit" \| "fill" }` | `{}`. The native hole: corner-pin from four corners. |
| `avatar.ensure` | `{ url: string, w: number, h: number, fps: number }` | `{ present: boolean }`. Makes sure the avatar page is loaded as the engine's page source. |
| `audio.tap.open` | `{}` | `{ pcmUrl: string, token: string, sampleRate: 48000, channels: 2 }`. Studio show audio goes to `pcmUrl` as 48 kHz PCM. |
| `audio.calibrateLipsync` | `{ source?: string }` | `{ offsetMs: number }` |
| `service.set` | `{ destId: string, url: string, key: string }` | `{}`. **RAM only.** Never persisted, never echoed, never logged. |
| `output.start` / `output.stop` | `{ id: OutputId }` | `{ state: OutputState }`. `output.start` is called only by the server's Go Live service. |
| `replay.save` | `{}` | `{ file: string \| null }` |
| `governor.set` | `GovernorSettings` | `{}` |
| `preview.subscribe` | `{ on: boolean, fps?: number, w?: number }` | `{ url: string }`. Starts or stops the JPEG preview and the 30 Hz `meters` events. |
| `diag.snapshot` | `{}` | `{ ... }`. Redacted: no key, no password, no full path. |

For [today] stock OBS the server maps the `BroadcastBackend` methods to standard obs-websocket v5 requests:

| Method | OBS request |
|---|---|
| `status` | `GetStreamStatus`, `GetRecordStatus`, `GetReplayBufferStatus`, `GetVideoSettings`, `GetVersion` |
| `setServiceInRam` | `SetStreamServiceSettings` (OBS keeps the key in its profile) |
| `snapshotService` / `restoreService` | `GetStreamServiceSettings` (held in RAM) / `SetStreamServiceSettings` when the show ends |
| `startOutput('stream')` / `stopOutput` | `StartStream` / `StopStream` |
| `startRecord` / `stopRecord` | `StartRecord` / `StopRecord` |
| `saveReplay` | `SaveReplayBuffer` |
| `stats` | `GetStats` + `GetStreamStatus` |
| `subscribe` | obs-websocket events (`StreamStateChanged`, `RecordStateChanged`, `ReplayBufferSaved`) |

## 4. Events [engine; today for OBS via the mapping above]

obs-websocket vendor events, `eventType` below, data is the JSON shown.

| Event | Rate | Data |
|---|---|---|
| `stats` | 1 Hz | `BackendStats`: fps, render-skipped, encoder-skipped, dropped, bitrate, per-output state, pose age p95, duplicate ratio |
| `meters` | 30 Hz, only while subscribed | `{ inputs: { name: string, peakDb: number[], rmsDb: number[] }[] }` |
| `health` | on edge | `{ id: HealthId }` |
| `notice` | on event | `{ say: string }` (one plain sentence) |
| `captureBlank` | on edge | `{ source: string, blank: boolean }` |
| `output` | on state change | `OutputStatus` |

## 5. Avatar page stamps (graft G4)

The avatar page (`output.html`, any browser or the engine's embedded page) measures itself and tells the server over
the existing bus. No shared memory.

- Message: `{ type:"broadcast", k:"stamps", from:<pageId>, s:Stamp[] }`, 1 to 4 stamps per message, at **20 Hz or more** in
  total (`STAMP_MIN_HZ`). The server never relays it to other pages.
- `Stamp = { seq, poseQpc, renderQpc, renderMs, mouthOpen, dup, quad? }`. Times are the page's `performance.now()` in
  ms (the page clock, so ages never mix clocks). **Pose age** = `renderQpc - poseQpc`. `dup` is the cumulative count of
  frames drawn from a pose identical to the previous frame's (the "55 fps but same pose" signal).
  `renderQpc` is an addition to the plan's field list, needed to compute the age.
- The page says hello with `page: "engine"` (`ENGINE_PAGE_KIND`) when it runs inside the engine. Other kinds are
  unchanged (`obs`, `browser`, `preview`, `test`).
- Aggregation (`StampStats`, `server/broadcast/stamps.ts`): hz, pose age p50 and p95, duplicate ratio, the longest
  frozen run, and the count of **frozen intervals** longer than `FROZEN_INTERVAL_MS` (500 ms). No stamps for 3 s means
  "Avatar paused" (the health machine) and, with the engine, an input refresh and a fallback cover.
- Cost: at most 0.1 ms per frame in the page.

## 6. Health, in plain words

`HealthId`: `idle`, `smooth`, `network-struggling`, `graphics-busy`, `source-black`, `reconnecting`, `avatar-paused`.
Titles and sentences are `HEALTH_TEXT` in the types file and are the only text the studio shows for health: no
percentages, no frame counts. W1's state machine uses hysteresis (a state must hold before it is entered or left) and
`reconnectDelayS` follows `RECONNECT_BACKOFF_S` = 2, 4, 8, 15, 30 s; it only fills the `retryInS` countdown the tile shows (the reconnect itself is OBS's own). Only the engine can drop the stream; a frozen
avatar page, a closed studio tab or a crashed server never stops it (plan section 4.2).

## 7. Server HTTP API (`/api/broadcast`)

Every answer is `ApiResult<T>`: `{ ok:true, ...T }` or `{ ok:false, code, error }`. Types for every body are in the
types file (`BROADCAST_ROUTES` lists access).

| Route | Access | Body in | Body out |
|---|---|---|---|
| `GET /status` | read | | `BroadcastStatus` (incl. `dryRunAvailable`: a test receiver is set up) |
| `GET /preflight` | read | | `{ report: PreflightReport \| null }` (last run) |
| `POST /preflight` | write | `{ acceptAmber? }` | `{ report }` (fresh run) |
| `POST /fix` | write | `{ fixId, destId? }` | `{ done, say, next }` |
| `POST /intent` | write | `IntentRequest` | `{ token, expiresAt, planHash }` |
| `POST /start` | write | `{ token, plan }` | `{ state: GoLiveState }` |
| `POST /dry-run` | write | `{ token, seconds? }` | `{ state, sinkUrl }` |
| `POST /stop` | write | `{ reason? }` | `{ state, tookMs }` |
| `GET /destinations` | read | | `{ destinations: DestinationView[] }` |
| `POST /destinations` | write (setting a typed address, new or changed: **local**) | `{ destination: DestinationInput }` (no `key`) | `{ destination }` |
| `DELETE /destinations/:id` | write | | `{}` |
| `POST /keys/:id` | **local** | `{ key }` | `{ destination }` (never the key) |
| `DELETE /keys/:id` | **local** | | `{ destination }` |
| `POST /record` | write | `{ action:"start", token, plan }` or `{ action:"stop" }` | `{ record: RecordStatus }` |
| `POST /replay` | write | `{}` | `{ result, replay }` |
| `POST /backend` | write | `{ choice }` | `{ choice }`. `409 busy` while a show, test or stop is in progress (`goLive.isActive()`). |

`POST /destinations` with a `key` field from any origin is rejected (`bad-request`): keys only enter through
`POST /keys/:id`. The bus carries `{ type:"broadcast", k:"state"|"health"|"notice"|"stampstats", ... }` server to this PC's
studio pages on change (state and notices) or at most 1 Hz (health, stamp stats). Pages that are hidden do not poll.

## 8. Destinations and Twitch

- `DestPlatform`: `twitch`, `youtube`, `kick`, `tiktok`, `custom`. Protocols: `rtmp`, `rtmps`, `srt`, `whip` (RTMP(S) in Phase 1).
- **Twitch, YouTube, Kick, TikTok, custom**: guided paste of the stream key. The key goes into the vault. There is no
  Twitch sign-in: VTube Pro never fetches a key or sets a title for you.
- The key is read from the vault only at Go Live and only for the destinations the person confirmed.

## 9. Show specs (graft G5)

`ShowSpec` v1 (`v: 1`) describes a show template (`just-chatting`, `gaming`, `react`, `interview`, `brb`): canvas, **topology**
(sources, scenes, audio, program scene) and, separately, **room data** (cameras, react screen quad, fit). A room
switch changes only `room`: the diff never creates or removes sources for it. `diffShowSpec(spec, shape)` returns an
ordered list of obs-websocket v5 requests (`SpecOp`) that makes the backend match; applying it twice gives zero ops. Only
objects whose name starts with "VTube Pro " are ever removed. In Phase 1 only the pure diff exists; applying it
through the engine's `look.apply` is Phase 2. A `.vtpshow` file is a ShowSpec JSON.

## 10. Versioning

`BROADCAST_PROTOCOL_VERSION` (1) is the engine handshake; `BROADCAST_CONTRACT_REV` (1) is this repository's contract. Additive
fields are allowed within a version; removing or retyping a field bumps the protocol version and the engine refuses a
client of another major protocol.
