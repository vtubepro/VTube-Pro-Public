# External tracking sources (phones, VMC apps, VTube Studio plugins)

VTube Pro can take face tracking from outside the browser and drive the avatar with it (3D and Pro2D 2D alike), then
stream it to OBS exactly like webcam tracking. Sources:

| Source | Apps | Who connects | Default ports |
|---|---|---|---|
| VTube Studio phone protocol | VTube Studio for iPhone / iPad ("3rd Party PC Clients"; the Android app has no such setting and only streams to VTube Studio on a PC), older MeowFace | VTube Pro finds the phone (broadcast) or uses a typed phone IP | phone listens on UDP 21412; VTube Pro listens on UDP 21413 |
| iFacialMocap | iFacialMocap, FaceMotion3D (iFacialMocap-compatible mode or its own handshake) | Either way: VTube Pro calls the phone (broadcast / typed IP), or the phone pushes to this PC's address | UDP 49983 both ways; FaceMotion3D's own handshake to the phone's UDP 49993 |
| Live Link Face | Epic's Live Link Face (iPhone, "Live Link (ARKit)" mode) | The phone sends to this PC's address (Add Target) | UDP 11111 |
| VMC protocol (receive) | Waidayo (iPhone), AndroidMoCap (Android, APK from its GitHub releases), XR Animator, VSeeFace, Warudo, any VMC sender | The phone / app sends to this PC's address | UDP 39539 and 39540 (face-only senders often use 39540) |
| VMC protocol (send) | VSeeFace, Warudo, VNyan … receiving VTube Pro's tracking | – | to 127.0.0.1:39540 |
| VTube Studio Public API | VBridger-style plugins injecting parameters | Plugins connect to VTube Pro | WebSocket 8001 on 127.0.0.1 |
| Phone as a webcam | Iriun, DroidCam, Camo, iVCam, Windows Phone Link ("Windows Virtual Camera"), NDI Webcam Input, Continuity Camera (Mac) | It is a normal camera: VTube Pro's own tracker runs on it. All are labelled "Your phone (…)"; only Camo, Iriun, DroidCam, iVCam and Continuity are preferred over a built-in camera (and only when the user hasn't picked a camera); NDI and Windows Virtual Camera never are | – |

**Where the tracking runs.** Every receiving source above except the last row runs the face tracker somewhere else (the
phone, or another app) and sends only numbers, so this PC does almost no tracking work. **Phone as a webcam does not**: the phone only
replaces the camera, and VTube Pro's own tracker still runs on this PC (the same load as a USB webcam, plus the webcam
app's decoding). When someone asks to take face tracking off their PC with an Android phone, point them at a VMC app
(AndroidMoCap), not at DroidCam / Iriun / Camo, and have them turn the PC's camera off afterwards:
while `app.trackingOn`, the webcam face model keeps running under a phone source (backup + hands / body; see the tick in
`src/app.ts`).

Every listener is **off by default**. Settings and VTS plugin token hashes live in `<data>/config/external.json`.

## How it is wired

- **Server.** `server/routes/external.ts` `createExternal()` is mounted in `server/index.ts`
  (`app.use(external.routes)`, `external.start(attachBus(server))`). `server/tracking/manager.ts` owns the receivers
  (`vtsPhone.ts`, `ifacialmocap.ts`, `liveLinkFace.ts`, `vmc.ts`, `vtsApi.ts`), restarts only the ones whose config
  changed, and publishes normalised `ExternalTracking` (`shared/types.ts`) on the bus as `{type:'ext', data}` (≤ 60 Hz per
  source, newest value last). The bus tap is read-only: it reads the studio's `frame` messages for the VTS API and the
  VMC sender.
- **Studio (client).** `src/app.ts` has `app.external` (`src/tracking/externalSource.ts` `ExternalFaceSource`) and
  `app.setTrackingSource(kind)` (kept in `localStorage vtp.trackSource`). `ExternalFaceSource.frame()` returns exactly
  what `FaceSolver.solve()` returns (units, signs, mirror, smoothing, expressiveness, gains), so retargeting, speech
  fusion, expressions, Pro2D parameters and the OBS output all work unchanged. Phones learn their rest pose in the first
  0.8 s; `app.external.recenter()` re-zeroes. A source silent for 0.5 s falls back to the webcam frame (or decays).
- **UI.** `src/ui/phonePanel.ts`: the "📱 Phone face tracking" card (Simple → Camera & tracking, Advanced → Tracking →
  Voice, phone & 2nd camera) and the wizard. `src/ui/externalPanel.ts`: the expert section (every source, ports, flips,
  VMC sender, VTS plugin approvals, "Drive the avatar from", Recenter).

## Zero-effort connection (the wizard does this)

- **Nothing turns on or switches over by itself** (the user may be live). The wizard shows the steps for the phone;
  ONE button, **"Use this now"**, turns that listener on AND makes the phone drive the avatar. "Back to the webcam"
  switches back and turns that source off. Reopening the wizard (it resumes on Connect) changes nothing. A source that
  is off never publishes (the manager drops its frames even in the moment it is being turned off).
- **No IP typing for VTube Studio / iFacialMocap.** With no phone IP set, VTube Pro broadcasts the VTube Studio request
  (`{"messageType":"iOSTrackingDataRequest",…}`) to UDP 21412 and the iFacialMocap handshake to UDP 49983 (plus
  FaceMotion3D's `FACEMOTION3D_OtherStreaming` to 49993) on this PC's subnet broadcast and 255.255.255.255, once a
  second / every 2 s while silent. The first phone that answers is locked in while it keeps sending, and the lock is HELD
  across silence (Live Link Face and VMC lock their first sender too); every other sender is ignored (see the lock note below). The light shows **"Phone: <IP>"** (Live
  Link Face: its name too) with **"That's not my phone"** (`POST /api/external/forget-phone {source}`), which drops the
  lock and ignores that address until a different phone sends (pressing it again keeps ignoring it). Every source can also be pinned to one phone's IP in
  the wizard ("Only accept one phone"; VMC has a `phoneIp` too). iFacialMocap may also push without a handshake (the user typed this PC's address into the app). A typed phone
  IP (the "Doesn't find your phone?" fold) still works as before.
- **ONE address of this PC.** `shared/phoneNet.ts pickLanAddress()` picks a private (home / office) IPv4, the
  default-route one first (found with a connected UDP socket, which sends nothing; a non-private default route never
  beats a private Wi-Fi / Ethernet address), and hides VPN / Hyper-V / WSL / VirtualBox / VMware / Tailscale / Docker /
  link-local / IPv6 addresses. It is shown big, with Copy and a QR code (the phone's camera reads it into the app's
  address box; this QR code holds only this PC's address), for Live Link Face, Waidayo / VMC apps and iFacialMocap's push mode.
- **Windows firewall: "Let phones connect".** `GET /api/external/phone-net` reads (no elevation) whether a rule named
  **"VTube Pro"** exists, is enabled, allows inbound on the **Private** profile and covers the phone receivers' UDP
  ports. The button (`POST /api/external/firewall`) runs ONE elevated PowerShell: Windows shows
  its UAC prompt; on "Yes" the rules named "VTube Pro" are replaced by one inbound allow, Private profile, exactly those
  ports. Nothing else is touched; "No" changes nothing. macOS / Linux: the step is skipped. Only a click on a page on
  THIS PC can start it: the route (and `/network-settings`) is local-only and needs the `x-vtp-user-action: 1` header,
  which the studio sends only while `navigator.userActivation.isActive`.
- **Public network.** The same query reads the adapter's network profile. On a Public network the wizard says so in
  one sentence and opens Windows' network settings (`POST /api/external/network-settings`); it never changes the
  profile itself. When the adapter's name doesn't match any profile, a connected Public network still gets the
  sentence.
- **One plain sentence** (`shared/phoneNet.ts diagnose()`): "Your phone isn't sending yet: open the app, keep it on
  screen, same Wi-Fi as this PC" / Public network / firewall / port in use / phone connected but no face / phone went
  quiet (screen locked, app in the background), with at most one fix button.

## Phone buttons (VTube Studio 1–8)

VTube Studio shows buttons 1–8 on the phone. `vtsPhone.ts` reports each tap; the manager broadcasts
`{type:'command', command:'phone-hotkey', args:{n}}`; the studio (`src/tracking/phoneHotkeys.ts`, planned by
`shared/phoneHotkeys.ts`) runs what the performer picked in the wizard's "Phone buttons" step (kept per browser in
`vtp.phoneKeys`):

- default: the model's own expression N (a Pro2D model: the expression saved on number key N,
  row or keypad, else its Nth one; a 3D avatar: Smile, Surprised, Angry, Sad, Wink, Tongue, Puff, Big grin), toggled
  (held until the next tap, no time limit);
- one of the model's own keys, matched by combo, modifiers included (never a key `shared/studioKeys.ts` reserves: those
  are refused in one sentence);
- a Stream Deck action (`shared/deck.ts`: recalibrate (re-centres the phone), lights, expressions, emote, hide my
  screen, slap);
- nothing.

## VMC

- **Receive**: `/VMC/Ext/Blend/Val` + `/Apply` (Perfect-Sync ARKit names or VRM presets), `/VMC/Ext/Bone/Pos` Head (+
  Neck), eyes, `/VMC/Ext/OK`. Listens on `port` (39539) and `port2` (39540, best effort: skipped when busy, e.g. VSeeFace
  is running, or when our own VMC sender targets it on this PC).
- **Send** (no client wiring; fed by the studio's frames, ≤ 60 Hz): Perfect-Sync blend values + VRM presets
  Blink_L/R, A/I/U/O, Joy, `/Apply`, `/VMC/Ext/Bone/Pos Head`, `/VMC/Ext/OK`, `/VMC/Ext/T`.
- A stream that carries 20+ ARKit-named shapes is read from those alone: the VRM presets in it are approximations built
  from the same shapes and used to be max-combined back in (a round trip through our own sender came back up to 0.15 too
  high on jawOpen / smile / blink). VRM-preset-only senders are unchanged.
- **Recorded round trip** (`npx tsx tools/vmc_roundtrip_unit.ts`, headless): `tools/vmc_fixtures/clip.vmcrec` = what
  `VmcSender.encode()` emits for a deterministic 3 s clip (`--record` rewrites it); the test checks the fixture still equals
  the sender's output, replays it into `VmcReceiver` at the recorded pace and over a real loopback socket (head angles,
  all 52 shapes, the lost-face flag, order) and mixes damaged datagrams into the stream.

## Live Link Face

`server/tracking/liveLinkFace.ts`: Unreal's AppleARKit Live Link packet, big-endian: u8 version (6), i32 + UTF-8
device id, i32 + UTF-8 subject name, frame number / subframe / fps numerator / denominator, u8 count (61), then 61 f32:
the 52 ARKit shapes in UE's `EARFaceBlendShape` order, then head yaw / pitch / roll and both eyes' yaw / pitch / roll,
in radians. A header-only packet = no face. Head yaw > 0 = turn to the performer's left, pitch > 0 = nod up; roll is
the least certain axis (flip switch). No head position is sent. Checked against three open-source parsers and a real
capture (file header). The Android Live Link Face beta streams MetaHuman data, not this packet.

## REST reference

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/external` | – | `{ config, status, lan: [the ONE address], lanPick }` |
| PUT | `/api/external` | deep-partial config, e.g. `{ vtsPhone: { enabled: true } }` | same as GET; only changed listeners restart |
| GET | `/api/external/phone-net[?fresh=1]` | – | `{ platform, lan, firewall, profile, ports }` |
| POST | `/api/external/firewall` | – | `{ ok, says, view }` (UAC prompt; `VTP_TOOLS_DRYRUN=1` = plan only) |
| POST | `/api/external/network-settings` | – | `{ ok, says, url }` |
| GET | `/api/external/vts/pending` | – | plugins waiting for approval |
| POST | `/api/external/vts/approve` | `{ id, allow }` | `{ ok }` |
| GET | `/api/external/vts/tokens` | – | approved plugins (no secrets) |
| DELETE | `/api/external/vts/tokens/:id` | – | `{ ok }` |

Mutating routes need a request from this PC (`requireLocal`); other sites don't pass (server/localGuard.ts).

Config fields worth knowing: `vtsPhone.discover` / `ifacialmocap.discover` (broadcast when no IP, default on),
`ifacialmocap.fm3dPort` (49993, 0 = off), `vmc.port2` (39540, 0 = off), per-source `bind` and `invert` (flip yaw /
pitch / roll). Test switches: `VTP_PHONE_DISCOVERY_TARGETS=127.0.0.1` (where broadcasts go), `VTP_PHONE_FAKE_NET=<json>`
(the firewall / profile query's answer), `VTP_TOOLS_DRYRUN=1`.

## Tests

```
npx tsx tools/phonecap_unit.ts            # address picker, discovery targets, firewall rule, profiles, diagnosis, cameras, phone buttons
npx tsx tools/testExternalConventions.ts  # ExternalFaceSource vs FaceSolver signs/units, mirror, staleness, NaN safety
npx tsx tools/testExternalServer.ts       # fake phone / iFacialMocap / VMC senders + VTS API client + REST (test ports 45xxx)
npx tsx tools/test_livelinkface.ts        # Live Link Face parser on a real capture + live receiver (test ports 41111/41112)
PLAYWRIGHT_CORE=… CHROME=… node tools/phonecap_e2e.mjs --out <dir> [--port 6081]   # private server + muted studio + OBS page, fake phones end to end
```

## Known convention assumptions

Taken from the reference receivers cited in each file's header; every phone source has per-axis flip switches.

- VTS phone `Rotation`: x = yaw (+ performer's right), y = pitch (+ down), z = roll (+ tilt to the performer's left);
  `Position` ≈ cm.
- iFacialMocap `head#`: X = pitch (+ down), Y = yaw (+ performer's right), Z = roll (+ performer's left); position in
  metres. Pitch is consistent with the vendors' frames (the eyes counter-rotate); yaw and roll are **unproven** (ARKit geometry and the talking-head-anime-3 converter suggest yaw + = the performer's left, VTube-IFacial-Link's mapping suggests the opposite), so the phone card carries one switch, "Head turns the wrong way? Flip it" (turn + tilt, saved per source, also for VMC).
  `rightEye#` / `leftEye#`: ARKit eye eulers, X + = down, **Y + = toward the performer's left** (not negated). This one is
  checked: the vendors' own sample frames (ifacialmocap.com/for-developer, facemotion3d.net/english/for-developer) carry the
  eye angles and the `eyeLook*` shapes of the same frame, and all four eyes agree (`tools/phone_apps_unit.ts`). Before
  beta.15 the yaw was negated, so the eyes looked the wrong way sideways.
- MeowFace (Android) speaks the VTube Studio phone protocol (same request on :21412, same JSON, plus a `VNyanPos` field we
  ignore): it uses the VTube Studio listener and has its own card in the phone wizard.
- A phone found by discovery (no IP typed) is locked in and **held across silence** (`server/tracking/common.ts SenderLock`):
  a different device on the Wi-Fi can never take the avatar over just because the phone paused (an earlier version released
  the lock after 20 s of silence, which let any LAN device drive the avatar mid-stream). Another sender takes over only when
  the person says so: **"That's not my phone"** (drops the lock and ignores that address), **"Another phone is sending — use it?"
  [Use it]** (`POST /api/external/switch-phone {source}`; the chip shows while a different device sends and goes away when it stops;
  the status `info.candidate` carries its address), or while the **"Find my phone"** search is running. A phone that came back with a
  new Wi-Fi address therefore shows the offer chip (one click) instead of being taken silently.
- FaceMotion3D's own mode may answer to the PC's port 49993 instead of 49983 (its developer page says both): the
  iFacialMocap listener also listens on 49993 (best effort), and the firewall rule covers it.
- **Find my phone** (`server/tracking/phoneDetect.ts`, `GET|POST /api/external/detect`, the phone wizard's first step):
  listens on every known phone port at once (21413 VTube Studio reply, 49983, 49993, 11111, 39539, 39540), sends the same
  discovery requests the sources send, and names the app from its first packet (VTube Studio / MeowFace, iFacialMocap,
  FaceMotion3D, Live Link Face, a VMC app, "Waidayo" when 20+ ARKit shapes arrive). It never drives the avatar, stops by
  itself after two minutes and skips a port something else holds.
- Fixtures: `tools/phone_fixtures/` = the vendors' sample frames (iFacialMocap, FaceMotion3D developer pages) and the real
  Live Link Face capture; the rest of `tools/phone_apps_unit.ts` is handmade in each app's documented convention.
- VTS API `FaceAngleX/Y/Z`: + when the performer turns right / looks up / tilts right; `MouthSmile`, `Brows`,
  `BrowLeftY/RightY` rest at 0.5.
- Still to check on real phones: each app's axis signs, whether every iFacialMocap / FaceMotion3D version answers a
  broadcast handshake, and whether VTube Studio's free app limits third-party sending (the studio says it "may").

## Light face tracker (OpenSeeFace) and the fallback chain

Face tracking has three steps, in order (`src/tracking/faceChain.ts`): **1** MediaPipe on the graphics card, **2** MediaPipe on the
processor (tasks-vision's CPU delegate, or `src/tracking/cpuFace/` when a game holds the card), **3** OpenSeeFace on the processor
(`src/tracking/openSeeFace/`: two small networks on onnxruntime-web's WebAssembly backend, no Python, no WebGL). Steps 1 -> 2 are the
Tracker's own (Auto delegate, stall mode, a failed GPU start); the chain WATCHES them, says them in one sentence, and takes step 3 when
no MediaPipe path starts (init failure, at once) or the processor path stays under 10 results a second for 7 s while the camera delivers
12+ (or one run hangs for 4 s). It never switches back by itself ("Try the usual tracker again" is the user's button); a user who has
not installed step 3 gets one offer (repeated at most every 10 minutes). The sentences are in `SENTENCE` (tested for plainness).

OpenSeeFace output goes into the same `ExternalFaceSource` as the phones (`source: 'openseeface'`, so it comes out in exactly FaceSolver's
units; the rest pose is learned on the first second like a phone's): head pose by a perspective fit of the stable landmarks to
OpenSeeFace's 66-point reference face (`fitPose`, recovers a known pose to < 0.001° without noise, < 0.5° with ±0.6 px noise),
position in metres, and 17 ARKit channels (blinks, wide eyes, jaw, smiles / frowns per side, pucker, stretch, brows) read from the
landmarks turned back to the camera (`frontalLandmarks`: yaw / pitch / roll and perspective cancel out). No gaze and none of the other 35
channels: a 2D landmark tracker does not see them. Models: `GET|POST|DELETE /api/openseeface` (`server/tracking/openSeeFace.ts`): 5.4 MB
from a pinned commit, fetched only on the user's click, size + git blob id checked, never bundled, local-only. Tests with no real model:
`tools/osf_unit.ts` (codec, pose, conventions vs FaceSolver, ratios, tracker loop, real onnxruntime-web on synthetic ONNX),
`tools/osf_install_unit.ts` (installer + routes on a fetch mock), `tools/face_chain_unit.ts`.

**Measured (2026-10-23, headless, AMD Ryzen 9 9950X3D, Node, one WebAssembly thread; a top-end CPU, so a mid-range one is slower).**
- Step 2, MediaPipe on the processor (`tools/bench_cpuface_node.ts` on the QA team's 640x480 talking-head clip): 11-13 ms a frame
  (mean; p90 12-15, p99 14-21) = 79-90 frames a second sustained.
- Motion to avatar on the recorded 72.7 s expression clip (3385 frames, `tools/eval_latency.ts --clip …/clip-frames.json`, the
  tool's assumed 45 ms capture + inference + transport included): head yaw lag -2 ms and pitch 12 ms after the app's lead
  compensation; expression channels 48-64 ms (jawOpen 54, smile 52, brows 64, blink 48): the head meets "under 50 ms", the
  expressions sit at the edge of it. The recorded tracker delivered 46.6 results a second.
- Step 3, OpenSeeFace: everything around the two networks (crop sampling, decode, pose fit, features) costs 0.67-0.75 ms a frame
  (median; p95 1.4-1.5). The networks themselves were NOT run (the models are fetched on the user's click and none is downloaded
  on the build PC): OpenSeeFace's own README quotes 59 fps for model 1 on one core of its author's CPU, not verified here.
  Whether a mid-range CPU reaches 30 fps with either engine is therefore not measured.

## Expression range & curves (the 52 ARKit channels)

`shared/blendCurves.ts`, the editor in Tracking → *Expression range & curves* (`src/ui/blendCurvesPanel.ts`): for each ARKit
channel an input range (where "nothing" and "all the way" are on this face), a response curve (gamma 0.25..4) and an output
range (cap, floor, or swap to invert). Stored in `profile.tracking.blendCurves` (sparse: only channels you changed; defaults
are never stored), so it is saved with the avatar and travels with it. `src/app.ts` applies it ONCE, as the last step before
the avatar runtime, to `frame.face` and to the `frame.mouth` summaries that stand for those channels (a left / right pair
takes the mean of its two shaped channels): VRM / GLB avatars (`src/avatar/expressions.ts`) and rigged 2D / Pro2D avatars
(`shared/rig2d/drive.ts`, which reads both) see the same shaped values. No curves = the very same frame object, so every
existing avatar behaves exactly as before. `tools/blend_curves_unit.ts`.
