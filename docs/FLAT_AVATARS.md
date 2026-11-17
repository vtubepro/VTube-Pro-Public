# 2D avatars and 2D environments

VTube Pro shows 2D avatars next to 3D ones: a set of pictures ("PNGTuber": PNG, APNG, GIF, WebP, JPEG) is built in;
other kinds (rigged 2D formats) plug into the same interface. Every 2D avatar can be shown four ways, and any avatar (2D or
3D) can stand in a flat, layered 2D environment.

Rigged 2D models (made from your own layered PSD in the 2D avatar maker, or moved over from another 2D app), their
expressions, sliders, outfits and the phone studio are explained in plain words in **[Pro2D: 2D avatars](PRO2D.md)**.

## For performers

**Add a 2D avatar**: Avatars tab → *Add a 2D avatar (PNG / GIF)…*, or drop pictures, a folder of pictures or a .zip on
the model drop zone. Nothing to set: VTube Pro works out which picture is which and says so in one sentence.

- Pictures named for what they show are used that way:

  | File | Shows |
  |---|---|
  | `idle.png` | mouth closed |
  | `talk.png` | mouth open, while you talk |
  | `blink.png`, `talk_blink.png` | eyes closed (with the camera on, your own blinks; else a blink timer) |
  | `happy_idle.png`, `happy_talk.png`, … | an expression state; each state gets a hotkey (1, 2, 3 …) |

- Pictures with any other names (`me1.png`, `me2.png` …): compared with each other — the one whose mouth area is darker
  is the talking one, the one with lighter, flatter eyes is the blinking one (shared/flatSimilarity.ts).
- Animated GIF / APNG / WebP pictures play (all on one clock, so idle and talk stay in step). One picture: it hops while
  you talk.

**How it stands in a room** (found from the picture itself: where it is opaque, how tall, how the bottom edge looks):

- A **whole body** stands on the floor by its own feet (empty space under them in the picture is skipped), with a soft
  shadow.
- **Head and shoulders** is the top of a person: on a **seat** it sits on the cushion (a little larger, its cut edge
  softened into it); at a **standing place** it rests on a **pedestal**, its cut edge hidden in the pedestal's cap; on
  the classic stage (no room) it is shown as is. Rooms size, frame and seat it like anyone else.
- **Framed like a 3D avatar, everywhere**: only the drawn character counts (empty canvas round a picture or a rigged
  model is ignored). Classic, every performer cam (React, Gaming corner / strip, party slots) and the Full screen
  cut-out show the whole character with its feet (or a bust's cut edge) on the frame's bottom edge, never clipped at
  the sides; talk shots show it from the top of its head down, like a 3D performer's head and chest.
- *More…* → *Picture shows* overrides the detection; *Head and shoulders* picks the pedestal always, a fading bottom edge
  (for pictures with their own desk) or as is; *Pedestal colour*.

**How it shows** (Avatars tab → *2D avatar → Show it*): **standing in the room** (above), **flat over the stream** (an
overlay layer in the OBS output, corner / size / offset / mirror under *More…*), **on a walking TV** (the TV body walks
in, sits and gestures when you talk), **on a monitor at my spot**.

**When I talk** (Avatars tab, live animated tiles — each shows your own picture doing it): the **talk picture** plus any
of **hop, squash and stretch, wobble, shake, pulse bigger, lean forward, nod, glow, brighten** (the others dim a little:
good in group shows) and **sparkles**, or **nothing**. Louder talking makes a bigger action, up to a limit. **Strength**,
**speed** and **Reset**; *For* picks an expression to give it its own action (e.g. angry shakes instead of hopping). The
default is the talk picture and a small hop. Rigged kinds (plug-ins) keep their own mouth and add only the motions you
pick. Saved per avatar (profile.flat.talk); the room card shows every action, the overlay all but sparkles, a walking TV
uses its own gestures.

*More…* also holds the talk switch (with a live meter of your voice), hold, delay, blink timer, head tilt / sway, outline,
drop shadow, room light and pixel art.

**Expressions**: press a state's key in the studio (again for the default look). OBS and party guests see the same.
Remote control: the bus / MCP command `flat` with `{ "expression": "<id>" | null }` or `{ "motion": "<group>", "index": 0 }`.

**High-quality models** (Pro2D models with 8192 or 16384 px texture pages, several pages, deliveries up to
about 1 GB): just drop them. The model works at once. In the background the studio makes lighter, compressed versions
of its textures (*Making your model sharper and lighter… you can use it now.*) and switches to them by itself: each
texture at the size your picture needs, compressed for your graphics chip (BC7 on Windows / Linux desktops, ASTC on
phones and Macs), so a 2 × 8192 model takes about 11 MB of graphics memory in a normal shot instead of 683 MB. The
picture follows its size on screen: a room's close-up makes it sharper before the cut (up to 4096 px tall, about 110 MB),
and it goes back to the light version 2 s after the shot is wide again; 4K output and the overlay count too. Textures
over 4096 px are repacked into pages every graphics chip takes; each piece of the model is drawn from one page, so there
are no seams (measured, docs/RIG2D_FORMAT.md §11). The original pictures stay in the model untouched. *Picture quality* (Avatars tab →
2D avatar) says what is happening and has the one choice that is yours: **Keep full quality** (the original pictures,
uncompressed) or **Keep the face at full quality**, for art that shows damage. Party guests get the small versions with
the model. Details: docs/RIG2D_FORMAT.md §11, numbers: docs/PERFORMANCE.md.

**Overlay around me** (2.5D overlays): scenery behind you and a desk, plants or a frame in front of you while you show
*flat over the stream*, moving with your head like a real room. Bring the overlay you already stream with (an OBS scene
collection export with its pictures, a layered PSD, pictures / GIFs / WebM loops): **2.5D overlays**.

**Make a 2D room**: Avatars tab → *Make a 2D room…*: layer pictures numbered from far to near (`1_sky.png`,
`2_mountains.png`, `3_trees.png`; transparent PNG / WebP for all but the farthest), optionally `ground.png` (tiled) and
`clouds.png` (scrolls). The room appears in Scene → Rooms. The far layers move less than the near ones whenever the
camera moves, and a slow sway gives depth even on a still camera. The shipped sample is **2D Park** (drawn entirely by
the engine, no pictures or third-party art): a golden-hour sky with a low sun, drifting clouds, hazy mountains, hills and
two tree lines fading with distance (atmospheric perspective), a meadow, grass blades swaying at the performers' feet, a
tree and bushes framing the wide shot (always outside the outermost places), pollen in the air.

## For developers

| What | Where |
|---|---|
| Profile contract (`AvatarProfile.flat`), sanitising, voice gate, blink timer, the hotkey cue | `shared/flatAvatar.ts` |
| Whole body vs head-and-shoulders from the alpha; the bust body plan | `shared/flatFraming.ts` |
| "When I talk" actions (talk motor: loudness-scaled, capped) | `shared/flatTalk.ts`, UI tiles `src/ui/flatTalkTiles.ts` |
| Roles of unnamed pictures from how they look | `shared/flatSimilarity.ts` |
| Upload checks (paths, sizes, picture sniffing, picture roles, the importer registry) | `shared/flatImport.ts`, `shared/flatKinds.ts` |
| **The 2D-avatar interface** every kind implements | `src/avatar/flat/types.ts` (+ `registry.ts`, `kinds.ts`) |
| Kind `png` | `src/avatar/flat/pngSource.ts`, decoding `frames.ts` (ImageDecoder, first-frame fallback) |
| Display side: card / overlay / walking TV / monitor | `src/avatar/flat/FlatAvatar.ts`, `card.ts`, `overlay.ts`, `flatTv.ts` |
| Files: library over HTTP, party bundles in RAM | `src/avatar/flat/files.ts`, `pack.ts` |
| Import routes | `POST /api/avatars/import-flat`, `GET /api/avatars/:id/files` (`server/flatImport.ts`) |
| 2.5D overlays around a flat-over-the-stream avatar | `shared/overlayStage.ts`, `src/avatar/flat/overlayStage.ts`, `overlayImport.ts`, `server/routes/overlayStages.ts`, `src/ui/overlayStagePanel.ts`; docs/OVERLAYS_2D.md |
| 2D environments | `shared/flat2dRoom.ts`, `src/scene/flat2d/flat2dScene.ts`, `POST /api/rooms/import-flat2d` (`server/routes/flat2dRooms.ts`), sample `assets/scenes/flat2d_park` (`tools/flat2d_room.ts`) |
| Studio UI (one entry point) | `src/ui/flatPanel.ts`: `flatPanel(app)`, `openFlatImport`, `openFlat2dRoom`, `flatHotkey` |
| High-quality textures (tiers, pages, KTX2, picking, the builder) | `shared/rig2d/gpu/*`, `src/avatar/flat/rig2d/textureTier.ts` (+ `gpuTextures.ts`, `gpuTexWorker.ts`, `tierBuildWeb.ts`, `partyTiers.ts`), `server/gpuTiers.ts` + `server/gpuTiersChild.ts`, routes `GET` / `POST /api/avatars/:id/gpu`, UI `src/ui/hiqPanel.ts`; docs/RIG2D_FORMAT.md §11 |
| Framing: the art's box, its own shot (Classic, cams, cut-outs), talk shots | `FlatAvatar.contentBox`, `AvatarRuntime.bounds()` / `cardBox()`, `RestMetrics.card`, `SceneActor.cardArtAt`; `shared/flatFraming.ts cardShot` (used by `Stage.frame` and `src/scene/stage/tileCams.ts`); `ShotSubject.art` (`src/scene/shotSolver.ts talkHeight / talkTarget`) |
| Tests | `tools/flat_unit.ts`, `tools/flat_import_unit.ts`, `tools/flat_e2e.mts` (private server, muted headless Chrome), `tools/frame2d_e2e.mts` (every layout x 3D / PNG / .vtp2: the 2D avatar's on-screen box per layout); high-quality textures: `tools/hiq_layout_unit.ts`, `tools/hiq_pick_unit.ts`, `tools/hiq_quality_unit.ts`, `tools/hiq_e2e.mts` (test models: `tools/hiq_models.ts`) |

### Adding a kind (another rigged 2D format)

1. Implement `FlatSourceFactory` (`src/avatar/flat/types.ts`): `load(ctx)` reads files **only** through `ctx.files`
   (a party guest's avatar is `ctx.files.sealed`: RAM only, never stored or re-sent) and returns a `FlatSource` that draws
   into its `canvas` on `update({ frame, voice, dt, time, cue })`, bumps `version` when it redraws, reports `face()`,
   `expressions()` / `setExpression()`, optional `motions()` / `playMotion()`, and frees everything in `dispose()`.
   `available()` says why it can't run (plug-in not installed, licence not accepted) — the avatar then shows a
   placeholder card instead of breaking the page.
   Optional, for framing: `contentBoundsSteps(live)` = everything it can draw (all poses / pictures / frames / outfits) in
   idle-time steps, and `boundsVersion` — bump it when an outfit or slider set changes what it can draw, and the card
   is measured again off the render loop (`FlatAvatar.remeasure()` does the same on demand).
2. Register it with one import line in `src/avatar/flat/kinds.ts` (`registerFlatSource` in the module).
3. Import check: register a `FlatImporter` (`shared/flatImport.ts registerFlatImporter`) from a shared module imported
   by one line in `shared/flatKinds.ts`. Kind settings live in `profile.flat.opts` (plain JSON ≤ 32 KB; validate them).
4. Every display mode, seats, cameras, parties, the hotkey cue and disposal come for free.

### How it plugs into the engine

`AvatarRuntime.load` builds a `FlatAvatar` when `profile.flat` is set: its group is the runtime's `model`, so the
classic stage, rooms, spots, size normalisation, spot / talk / group cameras, stage-layout performer cams, entrances and
parties all work unchanged. `faceInfo()` is the picture's face box (or the TV / monitor screen). Seats: a full-body card
stands in front of the seat, a bust drops to a seated person's height (`src/scene/actor.ts`). The card turns to each
camera per render pass (`onBeforeRender`), so every camera sees it front-on. Disposal frees the picture texture, halo /
depth materials, geometry, the source's canvas / bitmaps and the party bundle's copies (`gpuDispose` rules; the floor
shadow texture is `markShared`).

### Model custody

A party guest's 2D avatar is sent like any model, sealed: the sender packs its files into one bundle (a mesh-less glTF
binary whose BIN chunk holds the files — it passes the party wire's GLB checks and counts 0 triangles). Receivers unpack
it in memory, hand the kind `bundleFiles` (blob URLs revoked, buffers zero-filled on dispose) and never write it
anywhere. The hotkey cue travels in the frame's snack JSON (`fl`), like emotes.

### Licences

No third-party code is bundled for 2D avatars: the picture decoding uses the browser (ImageDecoder / createImageBitmap),
zips use fflate as shipped inside three.js (MIT). Live2D and Inochi2D models are converted on import into VTube Pro's
own format (`.vtp2`, docs/RIG2D_FORMAT.md) by VTube Pro's own clean-room importer: no Live2D Cubism Core, SDK, Framework
or Editor code is used, shipped, downloaded or decompiled (docs/RIG2D_IMPORT_PROVENANCE.md). Live2D Cubism Core is
proprietary and must never be committed or bundled. The import tells every user to use only models they own or have the
artist's permission to use. The open licence questions are tracked in docs/LIVE2D_TO_3D.md.
