# Multiplayer through Discord

Up to 8 performers, each on their own PC with VTube Pro, show up together in every member's OBS. People **talk in
Discord voice as usual**. VTube Pro carries each person's **avatar + worn outfit + accessories** (once, with their
consent) and their **tracking** (continuously). Nobody's model is ever stored on anyone else's PC.

- [How it works](#how-it-works)
- [Model custody](#model-custody-the-hard-requirement) (and its honest limits)
- [Polycount limit](#polycount-limit-party-max-triangles--sharedmodelstatsts) · [Avatar transfers (the resolver)](#avatar-transfers-the-resolver--sharedpartyxferts)
- [Network smoothing](#network-smoothing)
- [Voice front-end contract](#voice-front-end-contract)
- [TV guests (webcam / VTube Studio on a walking TV)](#tv-guests-webcam--vtube-studio-on-a-walking-tv)
- [Setup checklist (you do this once)](#setup-checklist-you-do-this-once)
- [Using it](#using-it)
- [Security notes](#security-notes) · [Files](#files) · [Tests](#tests) · [Troubleshooting](#troubleshooting)

---

## How it works

```
 Guest's Discord ──Join button──► relay /j/<room> ──Discord OAuth (identify [+ guilds.members.read])──► relay /cb
                                    (your Cloudflare Worker)       guild / role / ban checks, 10-min single-use ticket
                                                                          │
 guest's browser ◄── "Opening VTube Pro…" ──────────────────────────────────┘
        │  http://127.0.0.1:5191/join#relay=…&t=<ticket>   (fragment: never sent in any request or log)
        ▼
 guest's VTube Pro ──consent screen──► WebSocket to the relay room (Durable Object) ──knock──► host (approve / auto)
        ▲                                        SDP + ICE ONLY                                    │
        └──────────────── WebRTC (DTLS) peer-to-peer, or via TURN (still DTLS) ◄─────────────────┘
                 'ctl' reliable JSON · 'rt' unreliable binary frames + voice · 'bin' model / costume (≤ 256 MB, with receipts)
```

- **Star topology**: guests connect only to the host; the host relays everyone to everyone (and enforces each
  owner's sharing rule, below).
- **The relay** (`relay/`, a Cloudflare Worker with one Durable Object per room) only carries the WebRTC handshake
  (SDP offers/answers, ICE candidates) and room control (knock / approve / deny / kick / ban / roster). Messages that
  aren't SDP/ICE are dropped, max 20 kB, rate-limited. No logs. So an idle room can sleep, a running room keeps one
  small record of its own (who may join, bans, invite-link counts; never SDP/ICE, IP addresses or models) that is deleted
  when the party ends. It mints short-lived TURN credentials per participant so connections
  work behind strict NATs.
- **The bot** posts "🎙 *Host* is live in VTube Pro — **Join**" (a link button) in the channel you pick, lists who's in
  (edited as people join/leave) and flips to "party has ended" when you end it. Its token lives only in the Worker.
- **Identity**: guests' Discord names/avatars/ids are verified by the relay at sign-in and vouched for by the host; the
  party list and the Scene member list show them. Seats in 3D rooms are remembered by **Discord user id** (invite-code
  guests: by name).
- **Advanced: invite codes** — the original copy/paste INVITE/REPLY codes still work (no relay, no Discord, public
  STUN only), under *Party → Advanced*.

## Model custody (the hard requirement)

> **Never stored, never exportable, deleted when you leave. Not DRM.**

What happens to a guest's avatar on every PC that receives it (the host, and other members' PCs it's relayed to):

1. **In transit**: WebRTC data channel = DTLS. The relay never sees model bytes (it's not even possible to send
   them through it). TURN only forwards encrypted DTLS packets.
2. **Received** → checked (`glbProblem`: glTF 2.0 binary only, exact length, **no external URIs** — a hostile GLB can't
   make viewers fetch URLs), then immediately **sealed with AES-GCM-256** under a per-member, per-session key
   (WebCrypto, `src/net/custody.ts`) and the plaintext buffer is **zeroed**.
3. **Parked as ciphertext in the local server's RAM vault** (`server/partyVault.ts`): no disk, no temp file. An item is
   readable only from this machine (loopback socket, no foreign `Origin`, no cross-site fetch) **and** with its random
   256-bit capability (sent in a header — never in a URL; the server keeps only its SHA-256). Responses are
   `Cache-Control: no-store` + `Pragma: no-cache` + `Cross-Origin-Resource-Policy: same-origin`, so neither the browser
   nor OBS's CEF writes them to their disk cache.
4. **Opened only by this PC's OBS pages**, which receive the key + capabilities over the loopback bus (`{type:'party',
   members:[{sealed}]}`; the bus now refuses non-loopback `Origin`s so websites can't listen in). The page fetches with
   `cache: 'no-store'`, decrypts in memory, parses the GLB **straight from the ArrayBuffer** (`GLTFLoader.parseAsync`: no
   URL, no blob URL of the model, no `THREE.Cache` entry; GLTFLoader revokes its internal texture blob URLs itself),
   then zeroes the plaintext. three.js keeps only the parsed geometry and textures (GPU).
5. **Purged**: when the member leaves, is kicked, or stops sharing (everyone drops it at once — the vault items are
   deleted and OBS unloads them), when the party ends, when the studio tab closes (beacon), when the studio stops
   heart-beating for 60 s (crash), and of course when the app/server restarts (it was only ever in RAM). The old
   disk store `cache/party/` is deleted at server start.
6. **No export path**: party avatars never enter the library, the wardrobe, the MCP tools or any download UI.
7. **2D avatars** (pictures, plug-in kinds: docs/FLAT_AVATARS.md) travel the same way: the sender packs the files into
   one mesh-less glTF binary (the files in its BIN chunk, so `glbProblem` applies and it counts 0 triangles); the OBS
   page unpacks it in memory (`src/avatar/flat/files.ts bundleFiles`: blob URLs revoked and copies zeroed on dispose)
   and the 2D kind reads its files only through that interface (`ctx.files.sealed`): never stored, never re-sent.

**Consent** (guest side, per session): the join screen says *"Share my avatar with ‹host› for this session"* (untick
= join without sending your model or tracking) and *Who else sees it*:

| Rule | Who receives your avatar |
|---|---|
| Everyone in this party | the host + every member |
| Only people verified in ‹host›'s Discord server / role | the host + members the relay verified as in the room's server (and role). Invite-code guests never get it. |
| Only ‹host› | the host's PC only |

You can switch sharing off mid-session (*Share my avatar* toggle): the host and everyone else drop it immediately.
The host has the same toggle for their own avatar (*My avatar goes to*). Every member row shows an owner tag:
"🔒 Alice's model · on your OBS · server members only".

## Polycount limit (party max triangles) — `shared/modelStats.ts`

Everyone renders everyone, so every triangle is paid on every OBS in the party. The limit is **200,000 triangles per
avatar (model + worn costume)** by default (the user's decision, 2026-09-26: raised from 37,000 so most models go
through untouched) — for the sender, the receiver, the UI and these docs. The **host** may change it for their party:
*Multiplayer → Most detailed avatar allowed* (20,000 … 500,000 in the menu, 10,000 … 2,000,000 accepted;
`localStorage vtp.mp.maxTris`). From **170,000** owners get a softer "heavy" warning.

- Counted from the glTF JSON only (`glbStats`: per mesh use, TRIANGLES = count/3, strips/fans = count−2), so a 150 MB
  VRM costs one small parse. The library shows the count on every card (server `modelStatsOf`, cached by size + mtime,
  never saved in profile.json) and a toast right after an import.
- **Owner check before sending**: `party.ensureModel / ensureCostume` count the files. Over the limit, the studio
  shares the automatic **party version** (next section). Without one (switched off / failed) the model is not sent,
  the hello / profile say `avatar: false, why: 'tris:<count>'` and the owner reads *"Your model has 214,000 triangles —
  the party limit is 200,000; decimate it or pick a lighter model"* (status, the *Multiplayer* polycount line, Avatars →
  *Real size*). A costume that pushes a model over (or back under) the limit re-announces the avatar.
- **Host → guests**: `{t:'limits', maxTris}` right after `welcome` and whenever the host changes it. Guests then make a
  party version for that limit (or go back to the original) and re-announce. Lowering the limit drops members already
  over it (everyone gets `drop` + the reason); the host's own model follows the same rule. **Raising** it asks every
  member that was refused for its polycount (and now fits) to send again (`xneed`), host and guests alike.
- **Receiver check** (host and every guest, before anything is sealed): an over-limit model or model + costume is
  wiped and refused (`refuseTris`): nothing kept, the reason goes to everyone, the host's status says *"Refused
  ‹name›'s avatar: 214,000 triangles — the party limit is 200,000"*, and the owner's receipt says *"rejected: 214k
  triangles > 200k limit"*. This catches older or modified clients.
- The member list shows the reason instead of "avatar not shared": *their model has 214,000 triangles — the party limit
  is 200,000; they need this update (automatic party version) or a lighter model*.
- For reference (2026-09-26, model + worn costume): frog 30,828, robot 37,894, frog_v2 67,038 (46k + gentleman suit
  21k), puppet 54,250, gasfrog 82,258, guest 101,122, aosabi 137,971, skyisles 139,868, elias 146,255, robot
  180,340 (heavy-warning band), frogsuit 273,040 — at 200,000 every one of them goes through untouched except
  frogsuit, which parties get as its party version. (A host who sets 37,000 gets the old behaviour back.)

## Party version (automatic, over the limit) — `server/partyLod.ts`, `tools/party_lod.ts`

When — and only when — a performer's model (+ worn costume) is over the party's limit, the studio asks its server for a **party version**
(`POST /api/avatars/:id/party-lod {max, costume}`; `GET` = status only) and shares that instead. On by default
(*Multiplayer → Automatic party version*, `localStorage vtp.mp.autoLod`). The UI says *"Your model has 142,300
triangles — parties use an automatic 36,900-triangle version. [Preview] [Regenerate]"*; Preview opens
`output.html?avatar=<id>&partyLod=1` (the exact file parties get, driven by your tracking); Avatars → *Real size* has
*Preview party version* too.

- **Where**: the avatar's own folder, `library/<id>/party/lod-<costume|base>.glb|.vrm` (+ `lod-<costume>.costume.glb`)
  and `party/lod.json` (freshness key: generator version, limit, source size + mtime). The original model is never
  touched; a new limit, model or costume makes a new one. Your own avatar only — party guests' models are never
  reduced or stored (custody).
  (The same holds for **Avatar detail**, docs/PERFORMANCE.md: it only ever draws YOUR avatar lighter on your own
  pages; guests' avatars are always drawn at Full.)
- **How** (index-only, meshoptimizer — MIT, installed with the three.js types): every vertex stays exactly as authored
  and only the triangle lists are rebuilt, so **shape keys (ARKit / visemes / VRM expressions), skin weights, UVs,
  materials and every glTF / VRM extension survive byte-identical** (Blender is deliberately not used: its glTF export
  drops the VRM extensions and Decimate can't be applied to meshes with shape keys, so no Blender run / lock is needed).
  1. **Hidden geometry first**: triangles under another surface (the body under clothes, a shirt under a jacket,
     anything under the worn costume: 9 rays from the outside all hit within ~2–3.4 cm, scaled to the model) are dropped.
     Body / clothes only — never face, head or hair.
  2. **Regions** from the skin: FACE (every vertex a shape key moves + face-named parts), HEAD (the rest of the head
     bone: skull, hat), HAIR (hair bones / names), BODY (clothes, limbs). The budget is split with weights 6 : 2.5 : 2 : 1
     (bisection), so body and clothing give up triangles first; every group keeps ≥ 40 % (up to 1,500) / 60.
  3. **Locked**: shape-key vertices in the face (expressions keep full density), vertices shared with another primitive /
     region (no cracks). Eyes, lids, teeth (< 400 triangles) and drawn face plates / mouths (< 5,000) are kept whole.
  4. Seams kept first (UV / normal splits stay put; quality-bounded, then unbounded). Only if that can't reach the limit
     (AI-mesh atlases with seams everywhere), the missing triangles are taken from the biggest body groups with UV
     seams allowed to move — that can leave small texture flecks there, and the warning says so.
  5. **Automatic review**: triangle count ≤ limit, the custody checks (`glbProblem`), and the same meshes / primitives /
     shape keys / skins / images / materials / extensions as the source — else it fails and nothing is shared.
- **Cost**: 0.1–8 s per avatar (ray tests dominate), in a below-normal-priority child process (`tools/party_lod.ts
  --json`) so the server's bus never stalls. By hand: `npx tsx tools/party_lod.ts <model> <out> [--max 200000]
  [--costume <c.glb> <c_out.glb>]` prints the per-region report.
- **Measured at a 37,000 limit** (the old default; a host can still pick it): frog_v2 + suit 67,038 → 36,897 (identical from 8 angles, faint green specks at the suit hem);
  robot VRM 180,340 → 36,891 (41k hidden triangles dropped; face, expressions, hair identical; the open jacket over
  the tee is visibly simpler); skyisles 139,868 → 36,788 and aosabi 137,971 → 36,887 (AI-mesh atlases: faces / hair /
  hats identical, **small texture flecks on the clothes** — raise the limit for them if that matters); frogsuit 273,040
  → 36,991. At the 200,000 default only frogsuit needs one.

## Avatar transfers (the resolver) — `shared/partyXfer.ts`

"Someone's model wasn't shared even though they were sharing it" (the user, 2026-09-26). A model used to be streamed as
raw chunks + an end marker and **nobody ever confirmed it arrived**: any failure left the member on *"waiting for
avatar"* forever while the owner's panel said *"sharing your avatar"*. Root causes found and reproduced (mpfix
HANDOFF.md has the evidence; loopback tests below):

1. **The RAM vault refused every model over ~72 MB.** The party carried models up to 256 MB (raised from 64 MB in
   e372c6a) but `server/partyVault.ts` still had a 72 MB item limit: the model arrived, was checked and sealed, then
   the vault answered **413** — the host's status flashed *"Couldn't use X's avatar: vault 413"* and the member stayed
   *waiting* forever; guests it was relayed to hit the same wall. (Custom VRMs with 4K textures are often 70–150 MB.)
   Now both limits come from one constant (`PARTY_MAX_MODEL`, 256 MB; vault item = that + 1 MB, total 2.5 GB).
2. **A guest who joined while someone's model was still on its way to the host never got it**: the host told the
   newcomer "no profile" (it had no sealed copy yet), the newcomer then threw the relayed model away as unannounced.
   Same for anyone who joined during the relay window (the sealed copy was stored only after every relay finished).
3. **The host's own OBS waited for the slowest guest, and a guest whose connection closed during a relay hung it for
   good** (the relay pump never resolved when its channel closed): the host never showed the owner's avatar, and
   every later transfer from that owner queued behind it.
4. **Chunks that beat the hello were dropped.** 'bin' and 'ctl' are separate SCTP streams: nothing orders them. If
   the guest's hello (ctl) was delayed (a retransmit), the host dropped the first model chunks (it didn't know the
   link's owner yet), glued the rest together and refused the result as a broken GLB. Guests had the same race for
   the host's 'profile' vs its model.
5. **Half a transfer from a dropped connection was glued onto the next one** when the guest came back within the 10 s
   grace (rejoin rebind): refused as broken, forever.
6. Smaller ones: the host announced "sharing" while its own model hadn't loaded (guests waited forever); a guest whose
   sharing rule excluded someone showed that someone a bare "avatar not shared"; the 'limits' message made every
   guest send its model twice; joining + the share toggle fetched the model twice in parallel.

**The protocol** (both peers advertise the `xf1` capability in hello / welcome; older peers keep the legacy format):

| channel | message | meaning |
|---|---|---|
| bin | `X` {x, k, n, h, c, o} | begin: transfer id, kind (m / c), size, CRC-32 of the file, costume id, resume offset |
| bin | `D` u32 x, u32 offset, bytes | a 16 kB chunk (offset checked: a gap is reported at once) |
| bin | `E` {x} | end |
| ctl | `xprog` {owner, k, x, got} | receiver → sender, ≤ 1/s (the sender sees it moving) |
| ctl | `xack` {owner, k, x, ok, why?, retry?, got?} | the receipt: checked (size, CRC-32, GLB, polycount), sealed, shown — or the exact failure |
| ctl | `xneed` {owner, k, have?} | "I don't have it — (re)send it" (+ what I have: resume) |
| ctl | `xwhy` {owner, k, why} | the answer when it can't come (sharing off, sharing rule, still at the host, over the limit…) |
| ctl | `xstat` {owner, to[]} | host → owner: where their avatar got to on everyone's PC |

**Outfit + accessories (costume sets, cap `acc1`, 1.0.0-beta.5).** Between `acc1` apps the `c` transfer is a costume
set: the worn outfit and every worn accessory in one file (`'VTPS'` · version · pieces · per piece id, kind, length ·
the GLBs; at most 16 pieces, one outfit; `shared/partyXfer.ts` `packSet` / `unpackSet`), so they arrive together:
one checksum, one resume, one OBS reload. Its costume id is the set's (`s-` + CRC-32), announced in the profile as
`set` next to the sanitised `accessories` defs. Every piece is checked like a model (`glbProblem`), the polycount counts
all of them, and the owner leaves the accessories out (and says so) when they would go over the party's limit. Apps
before `acc1` keep getting the plain outfit GLB: the host seals the set's outfit on its own for them
(`Remote.setOutfit`). Receivers keep each piece's `fit` / `grip` / `surface` (they used to fall back to the default
fit), label edits re-send only the profile, a costume that never came is asked for again (`xneed` k `c`), and while an
announced outfit / set is on its way OBS keeps the member's last look (≤ 15 s), so a costume switch reloads them once.
Tests: `tools/party_dress_unit.ts`.

- **Receiver**: bytes land in one preallocated buffer, strictly in order, CRC-32 computed as they arrive (no second
  pass, no extra copy); packets that beat the hello / profile are **held and replayed** instead of dropped; a model
  that arrives before the owner's "sharing" message is held 10 s for it; a reconnect wipes half transfers.
- **Sender**: waits for the receipt. No progress for 20 s = stalled; a stall or a retryable failure (checksum, gap,
  size, vault, closed) is resent — resumed from the receiver's `got` when the checksum matches — after 2, 4, 8, 16,
  30 s, 5 tries. A newer transfer of the same model supersedes a queued / running one (e.g. the party version replacing
  the original). Rule failures (polycount, not a GLB, sharing rule) are final and shown.
- **"Sharing but no model"**: a studio that sees a member sharing, the link up and nothing arriving for 25 s asks for
  it (`xneed`) — the host for its guests, guests for anyone through the host — with the same backoff, 5 rounds, then
  says so. The host keeps every sealed copy before relaying, relays in the background (≤ 2 plaintext copies at once)
  and answers guests' requests from it.
- **Panel** (Multiplayer → In the party), both sides: *receiving 42 MB / 118 MB*, *checking avatar*, *stalled —
  retrying (2/5)*, *rejected: 214k triangles > 200k limit*, *waiting — the host is still receiving it*, *their app is
  outdated — ask them to update VTube Pro* (chip "older app"), *→ Bob: avatar delivered ✔ · Cleo: sending 12 MB / 60 MB*.
  Buttons: **Resend my avatar** (your row), **Ask them to resend** (host, every guest row) / **Ask again** (guests,
  when someone is stuck), **Copy diagnostics** (a JSON dump of links, channels, transfers, states and the last 120 log
  lines — no keys, capabilities, join links or model bytes; paste it to whoever helps).
- **Old / new mixes**: everything keeps working in both directions (an old peer gets and sends the legacy format; the
  new side still holds early packets and wipes stale halves, so even an old sender's model arrives more reliably at an
  updated host). What an old peer can't do is confirm or resend: the new side shows *"their app is outdated"* after
  25 s instead of waiting silently. **Update the host AND every guest.**
- `party.debugNet = {loss, delay, jitter, binKBps?, binDrop?, binCorrupt?, binStallAt?}` (test hook): the bin* fields
  throttle / drop / corrupt / stall the avatar transfers this studio sends.

## Real size in the shared profile

A guest's `profile.size = {height}` (their character's real height, `shared/avatarSize.ts`) travels in the shared
profile subset (`shareProfile()`), is sanitised on receipt (`sanitizeGuestProfile`: a clean number 0.03–100 m or
nothing) and decides their size class in every room (micro perches, macro back row — docs/SCENES.md → "Avatar size
classes"). The host's controller seats members by class (`SceneMember.size`).

**Host AND guests need this update** for the multiplayer parts: an older guest has no party version and doesn't check
its own polycount (the host's receiver check refuses its model when it is over the limit, with the reason shown), and its
OBS pages drop size-spot indices (≥ 12) from the scene state, seating those performers on an ordinary spot; an older
host never sends `limits` (updated guests then use the 200,000 default), never refuses heavy models and never seats by
size class. Studios from before the resolver (2026-09-26 mpfix) keep the 37,000 default, can't confirm or resend
avatar transfers and show as "older app"; an old HOST still has the 72 MB vault limit, so models over ~72 MB never
show at an old host no matter what the guests run.

### Honest limits (also said in the app)

- **Not DRM.** A PC that renders your avatar has its geometry and textures in (GPU) memory. Someone determined, on a
  PC you shared with, could capture them with GPU debugging tools, a debugger on the OBS page / studio at the moment
  of decryption, or a modified VTube Pro. Custody here means *never stored, never exportable, deleted when you leave* —
  it stops casual copying and accidental retention, not a determined attacker. **Only share with people you trust.**
- **The host is trusted with every guest's model** (the host's PC decrypts DTLS in order to relay) and **enforces the
  sharing rules**; a modified host app could ignore them. Choosing "Only ‹host›" limits exposure to that one PC.
- RAM can reach disk through the OS page file / hibernation — outside any app's control. Plaintext is zeroed as soon
  as possible to keep that window short, but JavaScript engines can keep internal copies until garbage collection.
- Anyone who can run programs on the receiving PC can read its loopback bus (the keys). That's the owner of that PC.
- The relay is **your** Worker: it sees who joins which room (Discord ids/names) and the SDP (which contains IP
  candidates and DTLS fingerprints). Like any WebRTC signalling server it could in theory tamper with the handshake;
  it's code you deploy to your own account.
- Peers see each other's IP address (as in any voice call) unless you turn on **Hide my internet address from guests**.
- The stream itself obviously shows the avatar (2D video).

## Network smoothing

`src/net/remoteSmoother.ts` (pure TS, used by every OBS page for remote members, and by the studio for link stats):

- **Timestamps + clock offset**: every frame/voice packet carries the sender's clock (ms) and a sequence number.
  `arrival − sent` = one-way delay + clock difference; its sliding **minimum** over ~8 s is the base, the rest is jitter.
- **Adaptive jitter buffer**: frames play out at sender time `now − base − delay`, `delay = p95(jitter) + ½ frame
  interval`, clamped **40–120 ms**, rising fast after late bursts and falling slowly.
- **Interpolation** between buffered frames (numbers lerp, bone quaternions nlerp); **damped constant-velocity
  (α-β / steady-state Kalman) extrapolation** of head, position, gaze and bones through gaps (bounded — it can't fling),
  face held.
- **Graceful degradation**: nothing new for **500 ms → ease to neutral** over 600 ms; after 3 s the member is marked
  untracked and the idle animation takes over.
- **Mouth follows the voice**: guests send compact **voice samples at ~50–60 Hz** (VAD, level, jaw open, lip closure,
  top-3 visemes; 48 bytes with 3× redundancy so a lost packet costs nothing). They have their own shorter buffer
  (25–90 ms) and override the frame's visemes/jaw/closure, so mouths stay crisp even when head frames are late. A voice
  gap > 150 ms closes the mouth fast. Per-member **Lip delay** (ms, Multiplayer list) lines a mouth up with that
  person's Discord audio.
- **Transport**: tracking now goes over an **unreliable, unordered** data channel as **binary** (a full-body frame is
  ~600 B instead of ~2.9 kB of JSON, one packet): a lost packet costs one frame instead of stalling everything behind
  it for a retransmit. Receivers rate-limit with token buckets (bursts from jitter are fine, floods are not).

Measured (see [Tests](#tests)): remote head error at the best-fit latency drops from 0.45–1.04° to **0.08–0.28°**, frame
judder (jerk) drops **4–5×**, for **+10–30 ms** latency; mouths match the spoken viseme **96–98 %** of the time even
with 10 % packet loss.

## Voice front-end contract

For the voice front-end (RNNoise + Silero VAD) being built in `src/audio/`: nothing to change in party code — call

```ts
app.party.attachVoice(voice);                 // voice.onFrame(cb) → cb({ t, vad, level, visemes })
// or per analysis frame:
app.party.voiceFrame({ vad, level, visemes }); // vad/level 0..1, visemes: Record<VISEMES name, weight> (src/tracking/visemes.ts)
```

`t` is ignored (the party stamps samples with `performance.now()`); jaw open and lip closure are taken from the latest
tracking frame. While `voiceFrame` is being called, the party stops deriving voice samples from the tracking frame
(`frame.mouth.speak` / `frame.visemes`), which is what it does today. On the wire each sample becomes
`{t, vad, level, open, closure, vis:[[visemeIndex, weight]×3]}` (`shared/partyWire.ts` `encodeVoice`), and OBS pages get
them on the bus as `{type:'pvoice', peer, v:[samples]}`.

## TV guests (webcam / VTube Studio on a walking TV)

People without a 3D VTube Pro avatar still join as full performers: a **walking television** (little legs, cartoon
gloves, antennas) whose screen shows their **live webcam** — or their **VTube Studio model**, chroma-keyed over
a themed backdrop. It walks in through the door, sits in seats, talks with gestures (driven by their voice level), and
works in every mode like any other performer (engine API for modes / games: `S\tv\PERFORMER_API.md` in the build notes;
asset contract: `assets/builtin/tv_performer/`, manifest `tv_profile.json` — deliberately not `profile.json`).

**Joining as a TV** — *Multiplayer → How you appear*: *My VTube Pro avatar* · *Webcam on a TV* · *VTube Studio
on a TV*. Pick the camera (virtual cameras such as **VTubeStudioCam** or **OBS Virtual Camera** are marked 🟢), or *Share
the VTube Studio window*; quality preset (360p/20 · 480p/24 · 720p/30 ≈ 0.35 / 0.7 / 1.5 Mbit/s); the TV body (80s console,
90s portable, flat panel, pocket handheld = micro size class, giant arcade cabinet = macro); mirror; fit. VTube Studio
kind: key colour (green / blue / magenta / custom), similarity / smoothness / spill, backdrop, and **Zoom / Left-right /
Up-down**: only that crop is sent (sharper face for the same bandwidth). A live preview shows you on your TV with the exact
body + screen shader every OBS page uses. The join consent dialog has *Appear as* too.

**VTube Studio setup** (explained in the panel, verified against VTube Studio's wiki *Recording/Streaming with OBS*):
Background → **Color Picker Background** → pure green (0, 255, 0) with **"Transparent in capture / OBS" OFF** (browsers
drop alpha: a transparent background would turn black) → Settings → camera settings → **Virtual Webcam → Enable** → pick
**"VTubeStudioCam"**. Alternatives: share the VTube Studio window; or, if VTube Studio already goes into OBS via Spout2 /
Game Capture, put a green Color Source behind it and use OBS's **Start Virtual Camera** → "OBS Virtual Camera". (A browser
can't read Spout2 directly — see **Spout2 performers** below: VTube Pro's own receiver keeps the alpha.)

**No VTube Pro at all?** The relay's sign-in page (`/cb`) now offers *Join with my webcam instead*: a plain browser page
on the relay (`/tv`, relay/tvguest/ bundled into relay/src/tvGuestPage.gen.ts) that joins as a TV (camera / window share,
TV body, VTube Studio key, zoom). It's a "lite" guest: it tells the host (`hello.lite`) never to send it avatars or
tracking — it only sends its picture + voice level. The VTube Pro link still opens by itself after 3 s unless you click
the webcam option. **Needs the relay redeployed** (see relay/README.md).

**Projector screen instead of a walking TV** (2026-09-26): *How you appear → Show me as: 🚶 Walking TV · 📽 Projector
screen*. A projector guest's picture appears on a pull-down screen that comes down beside the host in EVERY room — the
room's own screen rig (the studio's motorised projector that unrolls from the ceiling, the Helldivers hologram emitter,
Kingsmarch's framed mirror, the Factory's hoisted tarp …), a name plate under it, 2–3 projector guests side by side. It
powers on once it has landed. The Discord join dialog offers *Appear as: avatar / walking TV / projector screen*; the
relay's browser page (*Join with my webcam instead*) defaults to the projector: the camera opens right away and one
click on *Join as a projector screen* joins. The host can switch any TV guest between walking TV and projector
(*Multiplayer → In the party → TV guests*), set *TV motion* for everyone, and turn off *Talk camera cuts to projector
guests*. These host settings travel in the scene state (`SceneState.modes.tvguests`), so every OBS page (host + guests)
shows the same. Details: docs/SCENES.md → "Projector-screen guests".

**TV motion**: walking TVs are *calm* by default — tvart's v2 clips (near-still idle) toned down a little more, soft
antennas, talk gestures small and only on real speech (loud for ¼ s), no bored idles, no entrance hop. *Lively* makes
them bouncier (1.5× the clips, full gestures). The guest picks it (*TV motion*); the host can override it for everyone.

**How the video travels** (src/net/tv/*):

```
 guest (TV) ──'up' RTCPeerConnection: its picture (+ 'lvl' voice level)──────────► host
 host ──'down' RTCPeerConnection: every OTHER TV's picture, forwarded + levels──► each guest
 each studio ──localhost WebRTC (bus-signalled, no STUN/TURN)──► this PC's OBS pages (+ the Scene preview)
```

- Separate media PeerConnections, **never tracks on the party link** (that link is never renegotiated and may be an
  invite-code link without signalling). Their SDP / ICE travel on the party's reliable 'ctl' channel as `{t:'tvsig'}`
  between peers that both announced capability **`tv1`**; the guest always offers 'up', the host always offers 'down'
  (no glare) and renegotiates 'down' when TVs come or go (mid → owner map in each offer). Same TURN servers as the party.
- **Consent**: a TV feed goes where the owner's avatar would (their sharing rule: everyone / verified server members /
  host only). Appearing as a TV is the consent; a TV shares no model and sends no tracking frames.
- **Bandwidth**: the guest sends at its preset (WebRTC congestion control lowers it on bad links; VTube Studio pictures
  keep resolution, webcams trade resolution + fps). The host forwards each feed downscaled by tier —
  ≤ 3 feeds per guest: 360p / 24 fps / 450 kbit/s · 4–5: 270p / 20 / 300 · 6–7: 216p / 15 / 200 · one tier lower while
  its encoders report CPU limits. A TV screen is a small part of the frame, so this is barely visible.
- **OBS pages** (a separate browser — OBS's CEF): each studio streams every feed it has to its OBS pages over a
  loopback WebRTC link signalled on the local bus (`{type:'tvfeed'}`), like the react screen share; one connection per
  page, one transceiver per feed, high bitrate, no downscale. Voice levels go on the bus at 15 Hz. The page uploads a feed
  to the GPU only when a new frame arrives (THREE.VideoTexture's requestVideoFrameCallback).
- **Health**: no new frame for 1.2 s → *stalled* (frozen picture, tearing / chroma-shift "bad signal", LED amber, a
  static_glitch shake) → 6 s → *lost* (static + NO SIGNAL card, LED red). A link that fails or stays 'disconnected' for 5 s
  is rebuilt (1, 2, 4 … 30 s backoff; the host tells the guest to re-offer at once).
- **Custody**: frames exist only inside the browsers' WebRTC stacks, `<video>` elements and GPU textures — never recorded,
  never written to disk, gone when the member leaves.

**Measured** (2026-09-26, private harness: host + TV guests as separate headless Chromes with fake cameras on ONE PC,
RTX 5090; tools: S\tvguests):
- Walk-in, sit, talk camera, feed on the screen with correct orientation / aspect / key: host OBS + both guests' OBS pages
  show the same TVs (webcam guest, VTube Studio guest with green key + crop) — contact sheets in the build notes.
- OBS render cost (1080p): no TVs 1.75 ms CPU / 0.38 ms GPU per frame; 4 TVs 3.5 / 0.51 ms; 7 TVs 3.8 / 0.54 ms; 58 fps.
- Party of host + 7 TV guests (8 feeds): host forwards 49 copies ≈ 8.8 Mbit/s up, ≈ 4.7 Mbit/s in; each guest ≈ 0.7 up /
  1.3 Mbit/s down. Without the forward tiers the host's encoders saturated (guests' uploads fell to 7–16 fps); with
  them the uploads stayed at 20–24 fps. The host's own studio used ≈ 1.4 CPU cores for 8 feeds (4 feeds: ≈ 0.8).
- Drop test: frames stop → stalled at 1.2 s, NO SIGNAL at 6 s, live again 0.6 s after frames resume; media link killed
  → guest noticed at ~6 s, rebuilt, picture back at ~13 s.

Honest limits: loopback tests only (no real TURN / two real PCs); the host's forwarding is software VP8 — a weak host
PC with 5+ TV guests should use the Low preset for guests or accept the lower tiers; the host's OWN size class ignores a
TV host's chosen skin height (guests' TVs are sized correctly); VTube Studio transparency can't cross a virtual webcam
into a browser (hence the key).

## Spout2 performers (a model rendered by another app: VSeeFace, VTube Studio, Warudo, VNyan, Animaze …)

A performer whose model lives in ANOTHER app that outputs **Spout2** (Windows GPU texture sharing, usually with a
transparent background) appears in rooms like any TV performer — the host themselves, a VTube Pro party guest, or a
browser link guest. *Multiplayer → How you appear → ✨ Spout2 (VSeeFace / VTube Studio / Warudo…)*. The point is the
alpha: the model **stands in the room** (look `standee`: a cut-out that always faces the camera, feet on the floor, a
soft contact shadow, the performer's height) with clean edges — or on a walking TV / projector screen over its backdrop.

**Real alpha (VTube Pro on this PC)** — `server/spout.ts` + `tools/spout/spout_rx.py`:

    the app ─Spout2 (D3D11 shared texture)─► spout_rx.py (stdlib Python + Windows' d3d11.dll, NOTHING to install)
      ─stdout: raw RGBA/BGRA frames─► server ─ws /ws/spout (localhost)─► studio: WebGL2 packer (src/net/tv/spoutSource.ts)
      ─canvas.captureStream─► a TV feed: loopback WebRTC to this PC's OBS pages / the party tvLink to other PCs

- `GET /api/spout` lists senders (and why real alpha is unavailable, if it is). One helper per sender, shared by every
  page, stopped 4 s after the last one leaves; it exits by itself when the server dies. Formats: 8-bit RGBA / BGRA / BGRX
  (+ typeless / sRGB variants); 16-bit float (HDR) and 10-bit senders are reported, not shown. Keyed-mutex and named
  access mutex honoured; the sender's frame counter gives its real fps.
- Python: `VTP_SPOUT_PYTHON`, the GPU extras' venv, then `py -3` / `python` — any Python ≥ 3.8 (stdlib only). No Python
  → the panel says so and offers the webcam bridge.
- **Alpha over video** (`shared/spout.ts`): every video link drops alpha, so the packer draws ONE frame laid out
  `[premultiplied colour | 16 px gutter | alpha as grey]` (TvInfo.pack = fractions, so the host's downscaled forwards
  unpack the same). Premultiplication happens per texel in linear light BEFORE any filtering (manual bilinear), so a
  straight-alpha sender's garbage colour under alpha 0 (often pure green or black) never reaches an edge. Every renderer
  (`tvScreen.ts`) samples both halves half a texel inside, remaps alpha 6…249 → 0…1 (codec noise), rescales the colour
  by the same factor and clamps colour ≤ alpha (no haze, no fringe), then composites premultiplied — decoding the colour
  with `needsVideoDecode` (never twice) and reading the alpha raw.
- **Auto-framing**: the packer crops to the model's alpha box (grows at once, shrinks after 3 s, 16 px grid) — only the
  model travels and a standing model's feet are the picture's bottom edge. Off = whole picture / manual crop.
- **Who can unpack**: party capability `tva1` (TV_ALPHA_CAP). A guest packs only when its host has it; otherwise the
  model is composited over pure green and announced with the bridge key (keyed like a VTube Studio picture). Older
  GUESTS of a new host would see both halves of someone's packed feed side by side (mixed-version parties only).
- **Solo host**: *Show me in my own rooms without a party* (default on for Spout2) — the host's Spout2 model replaces
  their avatar on this PC's OBS pages with no party (`TvStudio.soloShow` → `tvSelf`).

**Webcam bridge (browser link guests, or no helper)**: the relay guest page (*My model is in a Spout2 app…*) and the
studio both offer it: the app sets a **solid pure-green background**, SpoutCam (official Spout project) or OBS Virtual
Camera turns the Spout2 picture into a webcam (detected by device LABEL only — `classifyCamera`), and the bridge key
preset (`SPOUT_BRIDGE_KEY`: softer edge, stronger spill than the VTube Studio preset) cuts it out; the model can still
stand in the room. Per-app 3-step instructions follow the picked app (`SPOUT_APPS`).

**Health**: the Multiplayer panel's member line (`✨ Spout2 · real alpha · 30 fps · …`), the setup panel (sender size,
sent size, straight / premultiplied alpha, warnings: app sends no transparency, empty picture, host too old), the Live
panel's People tile tag `SPOUT2 α 30` (tooltip: alpha on / off, fps, live).

Measured 2026-09-29 (synthetic 1280×720 BGRA sender `tools/spout/spout_test_sender.py`, private sender list):
30.1 fps end to end; helper 3–17 % of one core (mostly kernel: readback + pipe), server relay ≈ 18 % of one core at
110 MB/s (raw frames over loopback), studio packer 0.35 ms / frame; after H.264 at 1.5 Mbit/s the standee's colours are
within 1–4 / 255 of the source, 0 green edge pixels, the transparent area stays exactly transparent.

Honest limits: Windows only; the app and VTube Pro must run on the same GPU (hybrid laptops); no HDR Spout; tested with
a synthetic sender (no real VSeeFace / Warudo on the test PC); link guests get a key, not alpha; the standee is a flat
billboard (no self-shadowing, lit by its own app, not the room).

## Interview guests (no VTube Pro, no avatar) — guestlink

For interviews: the guest needs **only a browser** (desktop or phone). Three ways, all from **Multiplayer**, the **Home**
party card (🔗 Interview guest link) or the **Interview** panel (Scene → Interview → Guests):

1. **✉ Invite someone…** / **🔗 Just copy the link** (no sign-in — the default for interviews). Opens your party (without posting) if
   needed, then the relay mints `https://<relay>/g/<token>`: valid **10 min / 30 min / 1 hour** (the host's choice, default 30 min; the relay refuses more than an hour and never
   past the party), for **N different
   people** (Guests per link: 1 / 2 / 3 / 5 — reconnecting from the same tab doesn't count), **revoked** by *New link*,
   *Turn link off* or ending the party. The guest opens it, types a name, allows camera + mic, presses **Join the show**;
   you still **let them in** — the knock and the member list say **“link guest · name not verified”** (their id is a
   relay-made `link…` id, never a Discord account, so it can't impersonate a Discord user; sharing rule “verified server
   members only” never includes them). Rate-limited (12 ticket requests / min / IP), same-origin JSON only, no logging,
   same CSP as `/tv`.
2. **Copy Discord sign-in link (verified)** = `/j/<room>?as=tv`: Discord sign-in, then straight to the browser page (no
   “Open VTube Pro” page) with a verified Discord name.
3. **🎥 Use their Discord camera instead…** (the guest does nothing): share the Discord call window, drag a box over
   their video tile, name them → a local **projector screen** (or walking TV) guest in your scene, placed and shot like
   a remote TV guest, on every OBS page of this PC. Works with or without a party. Up to 4; crops are remembered per
   window size (`localStorage vtp.gl.crops`). Live only, never recorded. Honest limits: no voice level from Discord →
   no talk gestures / auto-cuts on their speech; party guests don't see them (host-local).

**The guest page** (`relay/tvguest/main.ts`, served at `/tv` and `/g/<token>`): big preview, camera + microphone pickers,
live mic meter, “You’re on <host>’s show” LIVE status, phone layout (≥ 44 px targets, no sideways scroll; tested at
390 px), and **reconnect**: a link guest whose connection drops rejoins by itself (2 → 30 s backoff) and the host lets
the same tab straight back in (no second knock). A Discord-ticket guest is told to click Join in Discord again (tickets
are single use). “More options” keeps the TV / VTube Studio settings.

**Voice over the link** — “I’m not in Discord voice” (ON by default for no-sign-in links, OFF for Discord guests): the
guest's echo-cancelled mic goes to the host on the same WebRTC link (an extra `sendrecv` audio transceiver on their
'up' connection), and the host's voice comes back on it when **Send my voice to them** is on (Multiplayer → Interview
guests → Guest voices). The host's STUDIO plays each guest's voice through the audio mixer (docs/VOICE.md → Audio mixer)
at the per-guest volume; the OBS page never receives or plays a guest's voice (its receiver refuses audio). Your stream
hears guests from the studio window, like a Discord call (headphones — else echo). Guests who are also in the Discord
call: **Mute for me** in the mixer (the cameras still follow them).

**Interview placement per guest** (Scene → Interview → Guests → *Where*): **🪑 In studio** (seated in the room as their
avatar / walking TV — walks to a free guest chair) or **📺 On the monitor** (a TV's live picture, an avatar rendered from
its remote mini set). Default = their own choice (a projector-screen TV → monitor, a walking TV → studio, avatars → the
“Set all” layout). *Set all: in studio / on the monitor* only sets everyone at once. Stored per guest in
`SceneState.modes.interview.guests[i].place` (`shared/talkshow.ts guestPlace`), so every OBS page agrees; shots, seats
and the chat / support keep-out follow the mix (e.g. 1 in studio + 2 on the monitor).

**When a link guest can't get in (guestconn)** — what each side sees, so nobody is left guessing:
- *Waiting*: the guest page says “Waiting for <host> to let you in…” (or “their VTube Pro isn't connected right now”
  when the host's studio is closed — the knock waits for them). The host sees the knock in the Live panel (Guests →
  *Let in* / *Deny*, per person) and in Multiplayer.
- *Connecting*: after *Let in*, the Live panel / guest-link box keep a row per person — “connecting…”, then either they
  become a member or “couldn't connect — their network needs TURN” (no TURN on the relay) / “… try another network”
  (TURN present). Rows of failures stay 3 minutes. The guest page says the same in guest words and stops auto-retrying
  after 2 attempts that never connected (each retry is a new knock; the room allows 40 per 10 min) — *Try again*.
- **TURN is what makes every network work.** Without it (STUN only) guests on mobile data / CGNAT, work or school
  Wi-Fi, VPNs or symmetric-NAT routers fail, whatever the app does. The studio says “No TURN on your relay” in the
  guest-link box, the Live panel and a toast after copying a link. Setup: step 3 below.
- *No camera* (none, denied, or busy because Discord / Zoom / OBS holds it): the page says so and offers **Join with a
  name card** (a 16:9 card with their name and a talking ring) — they can still talk and be on the show.
- *No / denied mic*: they still **hear the host** (a receive-only voice line), and the host's talk-back starts for
  listeners too; the host's talk-back mic is released again when the last link guest leaves (unless switched on by
  hand).
- *Phones*: one mic capture per page (iOS mutes the older capture if a page opens the mic twice — the host heard
  silence), audio contexts resumed on the first tap (the meter read 0 before any click), and a **Tap to hear <host>**
  button if the browser blocks playback.
- *Drops*: a dropped relay socket before the video link is up now starts over (it used to wait forever); a failed join
  resets the page (it used to stay on “Joining…”). There is no ICE restart: a dropped link is rebuilt by rejoining (link
  guests are let straight back in).
- Cloudflare TURN's port-53 URLs are dropped by the relay (Cloudflare: browsers block port 53; those URLs only time out).
  Test: `npx tsx tools/guestconn_unit.ts`.

Files: `relay/src/{app,room,tickets}.ts` (`/g/<token>`, `POST /g/ticket`, `POST /api/rooms/<id>/guestlink`, `?as=tv`),
`server/routes/discord.ts` (`POST /api/discord/room/:id/guestlink`), `src/ui/guestLink.ts`, `src/net/tv/tvDiscordCam.ts`,
`src/net/tv/{tvLink,tvLocal,tvLiteGuest,tvStudio}.ts` (voice), `src/scene/tv/tvFeeds.ts` (OBS playback),
`shared/talkshow.ts` + `src/scene/talkshow/engine.ts` + `src/scene/stage/modes/interview.ts` +
`src/ui/stage/panels/interview.ts` (placement). Test: `npx tsx tools/guestlink_unit.ts` (mock relay: mint / verify /
expiry / max guests / revoke / end / rate limit / `?as=tv`). **Needs a relay redeploy** (`relay/README.md`).

## Green room (waiting room) + messages + the guest's mute hotkey — greenroom

**What the host gets.** Live panel → People → **Green room** (and Multiplayer → “New guests wait in the green room”).
- *Who waits*: **Link guests** (default: everyone who joins with the no-sign-in link), **Everyone**, or **Nobody**.
  Setting `vtp.gr.mode`; deck action `greenroom-mode`.
- A waiting guest is **fully connected** (you approved their knock as usual) so you can tech-check them: a live thumbnail
  of their camera (a small JPEG refreshed every 2 s, RAM only, travels in the local bus `liveStatus` to the pop-out), their
  mic level, their connection (round trip, their picture's size / fps / bitrate as it arrives), READY, their messages,
  their mute state, how long they've waited.
- While waiting they are **not a scene member**: not in the room, no seat, no walk-in, not in the Interview line-up / on
  the monitor, not in the roster other members get, not on this PC's OBS pages (no `party` entry, no TV feed), their TV
  feed is never forwarded to other members, and **their voice reaches nobody** (not the studio speakers, not the OBS
  page). They don't hear the show either: your talk-back isn't sent to them (and isn't even started for them).
- **Bring on** (per guest, or *Bring on next*: READY guests first, then who has waited longest): they become a member
  with your **Entrances** setting — walk in through the door when walk-ins are on, appear in their seat when they're off
  (or Joiners = Seated); Joiners = *Outside* is ignored for them (you just brought them on). In Interview mode they join
  the line-up by themselves, back in their old slot and place (studio / monitor) if they were on before.
- **Back to green room**: with walk-ins on they walk out first (their voice goes backstage at once), then leave the
  scene; with walk-ins off they vanish. **Next guest**: the guest brought on last goes back, the next one comes on.
- **Remove**: kicks them and forgets their place (if they get back in they start in the green room again).
- **Messages**: one-click *Up next* / *In 1 min* / *You're live* / *Hang tight* or your own text (≤ 140 characters).
  On-air guests have a message button too.
- **Talk backstage** (per waiting guest, off by default): two-way voice between you and that guest only. Their voice
  plays on the **Backstage output** you pick (`HTMLMediaElement.setSinkId`, Chromium; `vtp.gr.sink`) — pick headphones
  that OBS does **not** capture: the default output is usually in OBS *Desktop Audio*. Your voice to them is your
  talk-back mic (or its own capture of it while talk-back is off) — that mic is probably on stream too, so mute it
  there while you talk. Browsers without `setSinkId` play it on the default output (the panel says so).

**Stable identity (reconnects).** A link guest gets a new party id whenever their page reloads, so the green room keys
people by `shared/greenroom.ts stableKey`: the Discord user id for Discord guests; for link guests the relay's per-tab
id (`link` + 20 hex = a hash of the invite generation and a random key their page keeps in `sessionStorage`); guests with
neither (manual invite codes) by their party id. The same tab rejoining keeps its place — **on air stays on air, waiting
stays waiting** (link guests are let straight back in, as before). A new tab / browser / a new invite link is a new guest
and waits again. Remembered for 30 minutes after they drop; kept in `sessionStorage` (`vtp.gr.book`) so a studio
reload that resumes the same party room keeps who was on air.

**What the guest gets** (the browser page, `relay/tvguest/main.ts`): a “You're in <host>'s green room — you're NOT on
stream yet” card (or “You're on the show”), the host's messages as a banner at the top with a soft visual pulse (no
sound) and a “● message” tab title until they look, a message history, an **I'm ready** toggle + an optional short
message (≤ 100 characters), and — when their voice goes over the link — a big **Mute / Unmute** button, a **MUTED**
badge on their preview, a **mute hotkey** they set themselves (any key or combo, e.g. `M` or `Ctrl+Shift+M`; saved in
their `localStorage`; a plain key is ignored while they type in a box), optional **push-to-talk** (hold the key or the
button; releasing — or the window losing focus — mutes). The page says honestly that a tab only hears its hotkey while
it's focused, and offers **Pop out a mute button**: a tiny always-on-top Document Picture-in-Picture window (Chromium
116+) with Mute + I'm ready + the latest message; the hotkey works there too while it's focused. Other browsers get the
honest note instead. Mute = the voice track is disabled (silence is sent; their level reads 0) and the host sees a
muted-mic badge.
**VTube Pro app guests**: the same messages (toast + history in Multiplayer), READY and a short message. They talk in
Discord, so muting is Discord's own keybind (works in any window) — no hotkey was added to the app.

**Wire** (`ctl` channel, JSON, both kinds of guest; capability `gr1` — older pages / apps can still be held in the green
room, they just don't see messages): host → guest `{t:'gr',k:'state',wait,talk}` · `{t:'gr',k:'msg',text,at,p?}`;
guest → host `{t:'gr',k:'ready',on,text}` · `{t:'gr',k:'note',text}` · `{t:'gr',k:'mute',on}`. Plain text only
(control / bidi / zero-width characters and `<>` stripped, capped by code points), rendered with `textContent`.
Rate-limited on both ends: guest notes / READY 5 at once then 1 per 3 s, mute 20 then 4 per s (the page sends at most
~3 per s, last state always), host → one guest 6 at once then 1 per 2 s. No new relay endpoints.

**Deck / Ctrl+K**: `greenroom-on` (member # / id, empty = next), `greenroom-back` (empty = the last one brought on),
`greenroom-next`, `greenroom-msg` (preset or own text; to the next guest / everyone waiting / the last one on / a
member), `greenroom-talk`, `greenroom-mode`, `greenroom-output`. Ctrl+K understands “bring on next guest”, “next guest”,
“back to green room”, “up next”, “in 1 minute”, “you're live”, “hang tight”.

Files: `shared/greenroom.ts` (rules, wire, rate limits, the book, line-up helpers, hotkeys), `src/net/greenRoom.ts`
(party side, thumbnails, connection text), `src/party.ts` (admit before the roster, per-member roster, OBS / forward /
voice gates, `ctl` routing), `src/net/tv/{tvStudio,tvLink,tvLiteGuest}.ts` (voice routing, backstage output + mic,
per-guest return voice; the guest side), `src/scene/controller.ts` (scene members, line-up, entrances),
`src/ui/live/{liveStudio,liveControl}.ts`, `shared/liveControl.ts`, `shared/deck.ts`, `src/ui/multiplayerPanel.ts`,
`relay/tvguest/main.ts`. Tests: `npx tsx tools/greenroom_unit.ts`, `tools/deck_unit.ts`. The guest page changes need
`node tools/build_tv_guest.mjs` + a **relay redeploy**.

## In-app voice for VTube Pro app guests (no Discord) — partyvoice

Before this, only browser *link* guests could talk in the app; VTube Pro **app** guests (the party) were assumed to be in
a Discord call, so without one there was no audio at all. Now anyone on the call talks in VTube Pro:

```
 app guest ──'vox' RTCPeerConnection (ONE audio transceiver, sendrecv; the guest offers)──► host
     up:   the guest's mic (echoCancellation + noiseSuppression + autoGainControl)
     down: the host's mix-minus for THAT guest = the host's talk-back mic + every other on-air voice, never their own
 link guest ── the existing TV 'up' link voice; its return becomes the same kind of mix-minus when others are on the call
```

- **Negotiation**: a separate media PeerConnection signalled over the party's `ctl` channel as `{t:'vsig'}`
  (`shared/partyVoice.ts`), like the TV links — the party link is never renegotiated (code rooms have no signalling
  path). Capability **`vox1`** in hello / welcome; older apps never see a `vsig`. Voice on later = a fresh offer; off =
  `bye`; new mic / mute = `replaceTrack` / `track.enabled` (no SDP). No relay change.
- **Mix-minus** (`mixPlan()`, pure, `tools/partyvoice_unit.ts`): each listener hears the host (when *They hear me* is on) +
  every on-air guest that sends and isn't muted, **never themselves**. A waiting guest (green room) is in nobody's mix and
  hears nothing, except the host's backstage voice while **Talk backstage** is on. Host **Mute** (People) takes them out
  of every mix too. `planProblems()` re-checks every plan before it is applied (a feedback loop is refused).
- **Mixing** (`src/net/voice/voiceMixer.ts`): one AudioContext on the host (48 kHz, and on Chromium no output device at
  all: `sinkId {type:'none'}`), one source per voice, one MediaStreamDestination per listener (+ a gentle limiter). A
  1-to-1 call sends the host's mic track as is (no mixing). Mixing, not forwarding: browsers re-encode every forwarded
  track anyway, so forwarding costs N×(N−1) Opus encodes and N−1 streams per guest; mixing costs N encodes and one
  ~32 kbit/s stream per guest. For 6 guests: 6 encodes instead of 30. Extra guest↔guest latency ≈ the host's jitter
  buffer (measured 44–51 ms on loopback) + a 20 ms Opus frame + a few ms of WebAudio ≈ 70–90 ms; host↔guest is unchanged.
- **Host UI**: app guests get the same controls as link guests (Hear them / They hear me / talk-back mic /
  per-guest Mute + volume) and a tag in Live → People: **VOICE** (talking in VTube Pro), **VOICE…** (connecting),
  **DISCORD** / **NO VOICE** (their choice), **OLD APP · USE DISCORD** (their app is too old for in-app voice).
  Guest voices (app and link guests) are never sent to the OBS page: they play only in the studio, through the audio
  mixer (docs/VOICE.md → Audio mixer).
- **Guest UI** (Multiplayer → Voice): **Talk in VTube Pro (no Discord)** (default on when the host supports it), **Using
  Discord voice instead** (turns it off: no double audio), mic + output pickers, call volume, **Mute** button + hotkey
  (**Alt+M** by default, changeable, push-to-talk option — the link page's approach; the Trail uses plain M). An old host:
  "The host's app is too old for in-app voice — use Discord". The guest's own OBS pages never get the call audio.

Code: `shared/partyVoice.ts`, `src/net/voice/{partyVoice,voiceMixer}.ts`, `src/party.ts` (caps, `vsig` routing,
`voxOf`), `src/net/tv/{tvStudio,tvLink,tvLocal}.ts` (shared hear / mute / OBS / talk-back, link-guest mix returns),
`src/ui/partyVoicePanel.ts`, `src/ui/live/{liveStudio,liveControl}.ts`. Tests: `npx tsx tools/partyvoice_unit.ts`.

## Host moderation (camera off / mute / volume / cut / cut all) — `shared/moderation.ts`, `src/net/moderation.ts`

Live → People: every guest row has **Camera on / hidden**, **Mic on / Muted**, a **volume** slider and **Cut** (camera AND
mic at once). The header has **Cut all** (everyone, one click). All of them are instant (no confirm) and go into one
**Undo** strip at the top of People (also Ctrl+Z in the panel, the deck action *Undo (guest moderation)* and Ctrl+K
"undo"). After a cut the row offers what next: *Bring back*, *Hold in green room*, *Remove*, *Remove + block* (confirm
twice) and, for link guests, *Turn link off*. *When I cut → Send to green room* also holds cut guests off the show.

- **Enforced on the host, never by the guest.** Camera hidden = a "Camera off" card (a real video track drawn on a canvas:
  same aspect, pre-mirrored, Spout2-packed, neutral under a chroma key) replaces their picture on this PC's OBS pages and
  in every forward to other guests (`replaceTrack`, no renegotiation, ~0.1 s). A 3D-avatar guest has no picture: they are
  held out of the room instead. Muted = their voice leaves the studio speakers (the OBS page never plays guests) and every other guest's
  mix-minus; their speaking level reads 0 (no talk gestures, no auto cuts) and an app guest's mouth samples are dropped.
  A muted guest still hears the show.
- **Stable identity**: kept by Discord id / per-tab link id, so a guest who reconnects comes back exactly as moderated.
- **The guest is told** (`{t:'mod'}` on 'ctl' for `mod1` peers, plus the relay as a backup path): their page shows a
  plain-words card, marks their own preview "Hidden from the show" and locks their unmute ("🔒 Muted by the host") until
  the host lifts it. When it's lifted they stay muted until they unmute themselves.
- **Not covered**: voices that go through Discord voice (server-mute them in Discord; the panel says so) and the host's own
  "Discord camera" crops (remove them in the Multiplayer panel).
- Deck / Ctrl+K: `guest-cam`, `guest-mute`, `guest-volume`, `guest-cut`, `guests-cut-all`, `guest-undo`, `guest-cut-hold`,
  `guest-kick` (`ban`, `revoke`), `guest-link` (`do: off`); "cut all", "panic", "hide camera 2", "mute 2", "cut off guest 2",
  "volume 2 40", "ban 2", "undo".
- Tests: `npx tsx tools/moderation_unit.ts`, `npx tsx tools/test_relay_mod.ts`.

## Setup checklist (you do this once)

> Beginner version with every click, costs and private links: [Hosting setup](HOSTING_SETUP.md). On Windows the
> whole of step 2 is one double-click: `relay/Set up my relay.cmd`.

This is all **yours**: your own Discord application and your own Cloudflare account. Nothing goes through anyone
else's server or app. You need: a Discord account (with a server you manage, if you want the bot to post), and a free
Cloudflare account. Nothing here is automated — no tool creates accounts or logs into anything for you.

### 1. Discord application + bot
1. <https://discord.com/developers/applications> → **New Application** (e.g. "VTube Pro Party").
2. **OAuth2** page → copy the **Client ID** → **Reset Secret** and keep the **Client Secret** for step 3 (don't paste it
   into VTube Pro or anywhere in this repo).
3. **OAuth2 → Redirects** → add both:
   - `http://127.0.0.1:5191/api/discord/callback` (your own sign-in, loopback)
   - `https://vtube-pro-relay.<your-subdomain>.workers.dev/cb` (guests; you'll know the exact URL after step 2.4 —
     come back and add it)
4. *Optional (the "is live · Join" post):* **Bot** page → **Reset Token** → keep the **bot token** for step 2. No
   privileged intents are needed. Without a bot, copy the join link and paste it in Discord yourself.
5. *Optional:* invite the bot: **OAuth2 → URL Generator** → scope **bot** → permissions **View Channels, Send Messages,
   Embed Links** → open the generated URL → pick your server.
6. Nobody types a user id: the setup makes a one-time **claim code** and the first person who signs in and types it
   becomes the host (step 4). (Advanced: `HOST_USER_IDS` lists Discord ids that may always host. To find an id:
   Discord → User Settings → Advanced → **Developer Mode** on → right-click yourself → **Copy User ID**. Server / role
   ids for the allow-list: right-click the server icon / a role → Copy ID.)

### 2. Relay Worker on Cloudflare (free plan is enough)
1. Create a free account at <https://dash.cloudflare.com/sign-up> (you, in your browser). Choose a neutral *workers.dev* subdomain
   (Workers & Pages → Change next to Your subdomain): it is part of every guest link. Install Node.js LTS (for `npx`).
2. The deploy scripts write `relay/wrangler.local.toml` for you (git-ignored — your ids stay on your PC) from the
   template `relay/wrangler.toml`: `DISCORD_CLIENT_ID = "<Client ID>"` and the optional `PUBLIC_NAME`, `TURN_KEY_ID`.
   These are not secrets. (By hand: copy the template to `wrangler.local.toml` and fill its `[vars]`.)
3. Windows: double-click `relay/Set up my relay.cmd`. Mac / Linux: `cd relay` then `sh deploy.sh`. It asks for the
   Client ID, runs `npx wrangler login` (browser sign-in to your Cloudflare), deploys, and sets each secret in
   wrangler's own hidden prompt: `TICKET_SECRET` (made for you), `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`
   (optional), and `HOST_CLAIM` (the fingerprint of the one-time claim code it shows you). Manual equivalent (the
   claim code and its hash are then yours to make; the script does it for you):
   ```
   npx wrangler login
   npx wrangler deploy -c wrangler.local.toml
   npx wrangler secret put TICKET_SECRET -c wrangler.local.toml
   npx wrangler secret put DISCORD_CLIENT_SECRET -c wrangler.local.toml
   npx wrangler secret put DISCORD_BOT_TOKEN -c wrangler.local.toml     # optional
   npx wrangler secret put HOST_CLAIM -c wrangler.local.toml            # hex SHA-256 of "vtp-claim-v1|" + CODE
   ```
4. Note the printed URL `https://vtube-pro-relay.<your-subdomain>.workers.dev` → add `<that URL>/cb` as a Redirect in
   Discord (step 1.3). Opening the URL in a browser shows `{"ok":true,"service":"vtube-pro-relay", …}` with a `ready`
   block that says which settings are present (true / false, never a value).

### 3. TURN (recommended: makes every network work)
- **Cloudflare Realtime TURN**: dashboard → *Realtime* → *TURN Server* → create a key → put its **Turn Token ID** in
  `relay/wrangler.local.toml` `TURN_KEY_ID = "<id>"`, then in `relay/`:
  `npx wrangler secret put TURN_KEY_API_TOKEN -c wrangler.local.toml` (paste its API token) and
  `npx wrangler deploy -c wrangler.local.toml`. Check: `https://<relay>/health` shows `"turn":true`. It has a free
  allowance — check Cloudflare's current pricing page.
- **Or any TURN server** with the standard REST shared secret (e.g. coturn `use-auth-secret`): set `TURN_URLS`
  (`turn:host:3478?transport=udp,turns:host:5349`) in `wrangler.toml` and `npx wrangler secret put TURN_SHARED_SECRET`.
- Without TURN everything still works on most home networks (STUN only); some strict NATs will fail to connect.

### 4. VTube Pro
1. **Party → Discord setup (one time)**: paste **Your invite server address** and **Your Discord app’s Client ID** →
   **Save**.
2. **Connect Discord (hosts only)** → a Discord window opens → authorize → type the **claim code** the setup showed →
   **Make me the host** → "You’re the host of your relay ✓".
3. **Load my channels** → pick **Post invite in**; optionally **Who may join** (your server) + **Required role**;
   **Auto-approve** on/off; **Hide my IP** if you set up TURN.
4. After updating VTube Pro while **not live**, run `npm run build` once so the OBS Browser Source (`dist/`) gets the
   new party code (until then OBS can't show guests).

Guests only need VTube Pro running (its server on port 5191). No Discord setup on their side.

## Using it

- **Host**: **Go live · post invite** → the bot posts the Join button → knocks appear ("Bob wants to join · server
  member") → **Let in** / **Deny** (or auto-approve). The member list shows Discord names, owner tags, who's speaking,
  link quality (rtt / jitter / loss / buffer), per-member **Lip delay**, **Kick** and **Ban** (bans are remembered in
  `config/discord.json` and enforced by the relay at sign-in). **End party** edits the bot post to "ended".
- **Guest**: click **Join** in Discord → sign in with Discord (first time only) → the page opens your VTube Pro →
  the consent screen → **Join**. If the page can't reach VTube Pro, start it and click again, or paste the link into
  *Multiplayer → Joining someone?*. The first time you join through a given relay you're told so.
- Voice stays in Discord. Everyone's OBS shows everyone (Classic side by side, or the host's 3D room).

## Security notes

- **Tickets**: HMAC-SHA256, bound to one room + Discord user, **≤ 10 min, single use**; host sessions ≤ 7 days, only
  for the person who claimed the relay with the claim code (or ids in `HOST_USER_IDS`). Rotating `TICKET_SECRET` revokes everything (the app then asks you to Connect again).
- **OAuth**: guests' flow runs entirely on the Worker (state = signed + bound to an HttpOnly cookie, PKCE); access
  tokens are used once and dropped. The desktop app never holds a client secret: its loopback code + PKCE verifier are
  exchanged by the Worker, which only accepts the loopback redirect URIs in `LOCAL_REDIRECTS`.
- **Local server**: `/api/discord/*` and the vault only answer loopback callers without a foreign `Origin`; `/join`
  pushes a pending invite only from its own origin, and the studio still asks before joining. The host session token
  stays in `config/discord.json` (gitignored) and is never sent to pages.
- **Relay limits**: 24 sockets and 7 guests per room, 40 msg/s (bursts 200), 20 kB messages, 40 knocks / 10 min,
  auth within 8 s, per-IP limits on join / OAuth / API routes, room TTL 12 h (host away 3 min → closed). Logs off.
- The room survives Cloudflare taking its Durable Object out of memory while it is idle (WebSocket hibernation): the
  sockets stay open and the room carries on where it was. It ends when the host ends it, the host is away 3 min, or its
  TTL runs out; then its stored record is deleted.

## Files

| File | What |
|---|---|
| `src/party.ts` | the party: codes + Discord relay signalling, channels, consent/sharing rules, custody pipeline, link stats |
| `src/net/custody.ts` | AES-GCM sealing, RAM-vault client, OBS-side opener |
| `src/net/remoteSmoother.ts` | jitter buffer, clock offset, extrapolation, voice-led mouth, link stats |
| `src/net/partyView.ts` | OBS page hooks (sealed avatars + smoothing) used by `src/output.ts` |
| `src/net/relayClient.ts`, `src/net/discordClient.ts` | relay WebSocket client; studio ↔ local server Discord calls |
| `src/ui/multiplayerPanel.ts`, `src/ui/joinConsent.ts` | the Party panel and the consent dialog |
| `shared/partyWire.ts` | binary frame / voice codecs, GLB checks, guest-profile sanitiser (incl. `size`) |
| `shared/modelStats.ts` | triangle / vertex counts from the glTF JSON, party limit defaults (200,000 / warn 170,000), `tris:<count>` reasons |
| `shared/partyXfer.ts` | the avatar-transfer resolver: packet codec, CRC-32, retry / stall timings, reason texts (`PARTY_MAX_MODEL`) |
| `server/partyLod.ts`, `tools/party_lod.ts` | the automatic party version (hidden-geometry removal + region-weighted index-only simplification + review) |
| `shared/avatarSize.ts` | real height → size class, shown height, spot fit (seats) |
| `server/partyVault.ts` (+ routes in `server/routes/live.ts`) | the RAM vault |
| `server/routes/discord.ts` | host sign-in (loopback + PKCE), relay proxy, `/join` deep link |
| `relay/` | the Cloudflare Worker + Durable Object (`wrangler.toml`, `deploy.ps1`, `deploy.sh`, `README.md`) |
| `tools/mock_relay.ts` | local mock of the relay + Discord (OAuth, REST, bot) + TURN — runs the real relay code |
| `shared/tv.ts` | TV performers: `TvInfo` (kind, skin, height, aspect, mirror, chroma, backdrop, fit) + sanitisers, skins, presets, forward tiers, `tvsig` + level codecs |
| `src/net/tv/tvSource.ts`, `tvLink.ts`, `tvLocal.ts`, `tvStudio.ts`, `tvLiteGuest.ts` | picture source (camera / window, crop, mic level) · party media links (up / down, forwarding, reconnection, stats) · loopback to OBS pages · "how you appear" · the browser-only guest |
| `src/scene/tv/*` | OBS side: TvRuntime (the walking TV as a performer), grey-box + tvart GLB bodies, clips, screen shader, feed registry, public API (`tvApi.ts`) |
| `src/ui/tvSetup.ts` | Multiplayer → How you appear (+ live preview) |
| `relay/tvguest/main.ts`, `tools/build_tv_guest.mjs`, `relay/src/tvGuestPage.gen.ts` | the relay's `/tv` page (browser-only TV guest) |

## Tests

All offline, never against real Discord / Cloudflare, never against the live studio:

- `npx tsx tools/spout_unit.ts` — Spout2: packing layout, pack → 8-bit → unpack = the true composite, no fringe (green
  under alpha 0), no haze under codec noise, alpha-mode detection, auto-framing, the frame wire, bridge camera labels,
  TvInfo pack / spout / standee. End to end: `python tools/spout/spout_test_sender.py` (needs numpy; a PRIVATE sender
  list) + `npx tsx tools/spout_harness.ts` (the server's SpoutHub on :5217) + a test page importing
  `src/net/tv/spoutSource.ts` with `url: 'ws://127.0.0.1:5217/ws/spout'`.

- `npx tsx tools/test_party_net.ts` — codecs + a simulated remote performer through LAN / wifi / bad wifi / awful
  (10 % loss) networks, old path vs new. Quality gates (judder halved, < 5 % stalls, ≤ 60 ms added latency, voice mouth ≥
  frame mouth, stream loss → hold → neutral).
- `npx tsx tools/avsize_unit.ts` — size classes (thresholds, continuity), spot fit / seat picks, scene-state spot
  indices, guest-profile `size` sanitising, model stats (instancing, strips, bounded numbers) + every builtin's count,
  party versions of frog_v2 + suit and the robot VRM in memory (at a 37,000 host limit, shape keys + VRM extensions
  intact).
- `npx tsx tools/mpfix_unit.ts` — the resolver's pure parts: limits (200,000 / 170,000, vault ≥ party model size),
  packet codecs + bounds, CRC-32 (check value, chunked = whole, slicing = bitwise), backoff, final vs retryable reasons,
  the panel's lines, gap detection + resume.
- Loopback party harness (mpfix, private tree, headless Chrome): 2–3 studios in one page over invite codes, each on
  the new or the ORIGINAL party code, a synthetic 2–250 MB GLB per member. 2026-09-26, final code, all pass: 3 studios
  with a 250 MB model 26 s; hello / profile delayed 1.5 s; a newcomer during a 120 MB upload; a guest cut mid-relay;
  a rejoin mid-upload; a stalled pump (resumed at 40 %); corrupted chunks (CRC → resent); dropped chunks (gap →
  resumed); a 2 MB/s uplink; share toggled mid-upload; old host / old guest mixes; the 200k limit (214k refused with the
  reason on both sides, 190k + 150k untouched, 160k refuses / 200k brings back); frogsuit's party version 273k → 199.9k;
  a sharing rule shown as its reason; "sharing but no model" (asked 5×, gave up with a message, "Ask them to resend"
  fixed it); an old guest that never sends → "outdated" in 26 s. The same scenarios on the ORIGINAL code: 120 MB model
  → "vault 413", newcomer → "avatar not shared", cut mid-relay → host waits forever, rejoin → "Refused … only GLB",
  host profile vs model race → "Refused" (happened without injection).
- `npx tsx tools/test_relay.ts` — spawns the mock on a private port: tickets (tamper / expiry / single use), host
  loopback sign-in + PKCE, `HOST_USER_IDS`, channel list, room + bot invite, guild + role allow-list, CSRF cookie,
  SDP/ICE-only signalling, size + rate limits, kick + ban, roster edits, end.
- `tools/test_party_server.ts` — against a **private** server (`VTP_TEST_SERVER=http://127.0.0.1:<not 5191>`): vault
  capabilities / Origin / no-store / purge, the old disk routes gone, bus Origin check, `/join`, host sign-in via the
  mock.
- Manual mock: `npx tsx tools/mock_relay.ts --port 8788 --app http://127.0.0.1:<your server port>`; mock users
  host / alice / bob / cleo (server + role), dave (no role), mallory (not in the server).

Results of the 2026-09-24 run (one host + 4 guests — three via the Discord mock with injected delay/jitter/loss of
40/30 ms/2 %, 70/60 ms/5 %, 110/80 ms/10 %, one via invite codes; 60 ms signalling delay):
join flow incl. `/join` deep link + consent + manual approval ✔; avatars + costume delivered and byte-identical
(SHA-256) in ~3 s, **distributed exactly per owner rules** (guild-only avatar withheld from the invite-code guest,
host-only avatar only on the host); private OBS page rendered all 5 performers from the vault; unshare / kick+ban /
end purged every vault item (0/35 readable afterwards), bot post updated and ended; banned user refused at sign-in;
**custody audit: 0 hits** for any guest-model marker or ciphertext prefix across every file written during the test
(private tree, the browser profile incl. its HTTP cache, %TEMP%, Chrome/Edge profiles — ~1,300 files); Cache Storage
and IndexedDB empty on the studio and OBS pages.

- `npx tsx tools/tv_unit.ts` — TV performers: TvInfo / tvsig sanitisers (hostile input), voice-level codec, crop maths,
  forward tiers, skins → size classes.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Can't host yet" / "This relay already has its host" | type the claim code after **Connect Discord** (**Make me the host**). Lost it or used already: run `relay/Set up my relay.cmd` again and make a new claim code. See [Hosting setup → Troubleshooting](HOSTING_SETUP.md#troubleshooting) |
| Discord sign-in says it is "not set up on this invite server" | the relay is missing `DISCORD_CLIENT_ID` or the secret `DISCORD_CLIENT_SECRET` (your own Discord app): run the setup again |
| Discord says "Invalid OAuth2 redirect_uri" | add `http://127.0.0.1:5191/api/discord/callback` and `<your relay>/cb` under your Discord app → OAuth2 → Redirects |
| "Discord sign-in expired" | click **Connect Discord** again (sessions last 7 days; rotating `TICKET_SECRET` ends them) |
| Guest: "Members only" | they aren't in the server / lack the role you set under *Who may join* |
| Guest page says it couldn't hand over the invite | their VTube Pro isn't running — start it, click Join again (or paste the link) |
| "Connection failed (strict firewall / NAT)" | set up TURN on the Worker; turn on *Hide my IP* to force it |
| Interview guest “couldn't connect — their network needs TURN” | the relay has no TURN (`/health` → `"turn":false`): step 3, then redeploy. Until then they try home Wi-Fi |
| App guest: nobody hears them / they hear nothing (no Discord call) | their Multiplayer → Voice must say *Connected*. "Too old for in-app voice": update VTube Pro on both PCs (or use Discord). Mic blocked: they still hear you. Waiting in the green room = no voice until you bring them on (or *Talk backstage*) |
| Interview guest joins but you / they hear nothing | they ticked off voice (they're in Discord), or their mic is busy / denied (their page says so; they still hear you). You: *They hear me* on (Live → Guests) |
| Interview guest “camera is busy” | Discord / Zoom / OBS holds their webcam: close it there, or *Join with a name card* |
| Guests missing in OBS but fine in the studio | run `npm run build` (OBS uses `dist/`), refresh the Browser Source |
| "Waiting for avatar" / someone's model never shows although they share it | read their row: it says what's happening (receiving / stalled — retrying / rejected: why / their app is outdated). Update everyone (host AND guests). Press **Ask them to resend** (host) or **Resend my avatar** (the owner). Still stuck: **Copy diagnostics** on both PCs and send them |
| Mouth ahead/behind their Discord voice | adjust that member's **Lip delay** (ms) |
| A TV shows NO SIGNAL | their camera stopped / is used by another app, or their upload is too slow — they pick a lower Quality; the link rebuilds itself |
| VTube Studio TV shows a green / black box | green: raise Similarity; black: turn "Transparent in capture / OBS" OFF in VTube Studio |
| "The host's VTube Pro can't show TV guests" | the host needs this update (capability `tv1`) |
