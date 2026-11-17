# Room editor, live camera sliders, seating chart, prop packs

The performer's own changes to a room — camera angles, places, the react screen, chat displays, placed props, the room's
own objects (hidden / moved), live camera tweaks and named layouts — without ever touching the room's files. Works in the
VTube Pro on your PC; the layer is kept in VTube Pro's data folder.
Code: `shared/roomEdits.ts` (format, validation, merge), `shared/roomLayouts.ts` (layouts), `src/scene/roomObjects.ts`
(the room's own objects), `src/scene/roomEdit/layouts.ts` (Layouts panel),
`shared/roomEditCheck.ts` (warnings), `shared/propPacks.ts` (prop packs), `server/roomEditStore.ts` +
`server/routes/roomEdits.ts` (storage + API), `src/scene/roomEdits.ts` (applied on the room), `src/scene/roomEdit/editor.ts`
(the editor), `src/ui/roomEditor.ts`, `src/ui/cameraTweaks.ts`, `src/ui/seatingChart.ts` (studio mounts).

## 1. The override layer (`vtp-room-edits/1`)

One JSON file per room id in **`<data>/room-edits/<room id>.json`** (`<data>` = VTube Pro's data folder: the project root
in a source install, `%APPDATA%\VTube Pro` / `~/Library/Application Support/VTube Pro` / `~/.config/vtube-pro` in a
release; an area is its own id `<room>~<area>`). Shipped rooms, rooms an update replaces and hand-authored `scene.json`
files stay byte-for-byte as they are. **Reset** deletes the file (the last one is kept as `<id>.reset.json`).

Everything is in the room's glTF space (metres, +Y up, stage front +Z), like scene.json `cameraOverrides`:

```json
{
  "schema": "vtp-room-edits/1", "room": "vtubepro_studio", "rev": 3, "savedAt": "2026-10-06T12:00:00.000Z",
  "cameras":      { "CAM_WIDE": { "pos": [0, 2.2, 6.5], "target": [0, 1.2, 0], "fov": 40 },
                    "SPOT_02_CAM": { "pos": [...], "target": [...], "fov": 30 }, "CAM_MY_1": { ... } },
  "spots":        { "SPOT_03": { "pos": [-1.6, 0.14, -0.2], "yaw": 170 } },
  "screen":       { "pos": [0, 2.8, -4.3], "rot": [0, 0, 0], "scale": 1.1 },
  "soloScreens":  { "SPOT_01": { "position": [x, y, z], "yaw": -20, "width": 2.2 } },
  "chatMonitors": { "SPOT_01": { "position": [x, y, z], "yaw": 15, "width": 0.9 } },
  "chatBoards":   { "SPOT_01": { "position": [x, y, z], "yaw": 15, "width": 1.4 } },
  "buddySpots":   { "SPOT_01": [[x, y, z]] },
  "props": [ { "uid": "p7k2a", "src": "pack:harbour_bits/crate_small", "pos": [2, 0, 1], "rot": [0, 90, 0], "scale": 1,
               "box": [-0.3, 0, -0.3, 0.3, 0.6, 0.3] } ],
  "camTweaks":    { "talk:SPOT_01": { "orbit": -12, "tilt": 4, "dolly": 0.3, "height": 0.1, "fov": -3 } },
  "chatScreens":  [ { "uid": "c1x9a", "pos": [1.4, 1.7, -2], "yaw": -20, "pitch": 0, "width": 1.2, "height": 1.5,
                      "opacity": 1, "frame": true, "face": "fixed", "text": 1 } ],
  "hiddenObjects": [ "PLANTS", "DESK_PROPS" ],
  "movedObjects":  { "GAMING_CHAIR": { "pos": [2.4, 0, 1.1], "rot": [0, 35, 0], "scale": 1 } }
}
```

| Key | What | Rules |
|---|---|---|
| `cameras` | camera presets: the room's `CAM_*`, talk cameras `SPOT_xx_CAM`, your own `CAM_MY_1…8` | `{pos, target, fov}`, fov 10–100°, pos ≠ target; only cameras the room has (or `CAM_MY_n`, or a talk camera of an existing spot) |
| `spots` | a place moved / turned | `{pos?, yaw?}` (yaw ° about +Y, 0 = facing +Z); a moved spot drops scene.json approach waypoints (GLB ones within 3 m stay) |
| `screen` | the react `SCREEN` | room-space `pos`, `rot` (° Euler YXZ = [pitch, yaw, roll]), `scale` 0.25–4 on top of the authored size |
| `soloScreens` / `chatMonitors` / `chatBoards` | flat displays per host spot | `{position, yaw, width}`: solo 0.8–5 m, monitor / board 0.3–4 m. They win over the room's own `SCREEN_SOLO_xx` / `CHAT_MONITOR_xx` / `CHAT_BOARD_xx` nodes for that spot |
| `buddySpots` | where the chat buddy stands for a spot | 1–8 points |
| `props` | placed props | ≤ 200; `src` = `lib:<kit>/<item>` or `pack:<pack>/<item>` (installed); scale 0.05–20; `rot` ° YXZ; `box` = the prop's own bounds (for the room check) |
| `chatScreens` | in-world chat screens (≤ 8 per room, anywhere) | `pos` (centre), `yaw` / `pitch` (±60°) °, `width` 0.3–6 m, `height` 0.2–4 m, `opacity` 0.3–1, `frame` on / off, `face` `fixed` \| `camera` (turns upright to the camera), `text` 0.6–2 |
| `camTweaks` | live camera quick-adjust per angle | angle = `talk:SPOT_xx`, `solo:SPOT_xx`, `group`, `wide`, `react`, or a preset name; orbit ±90°, tilt ±30°, dolly ±3 m, height ±1.5 m, fov ±25° |
| `hiddenObjects` | the room's own objects taken out (not drawn, not ray-tested) | node names (§1b), ≤ 300, never an engine node (`ENGINE_NODE`: anchors, cameras, lights, colliders, the screen, FX, engine-moved parts, `*_SKIN`, area prefixes) |
| `movedObjects` | the room's own objects moved / turned / resized | node name → `{pos, rot, scale}` like `screen`: room-space position of its origin, `rot` ° YXZ, `scale` 0.05–20 on top of its authored size; ≤ 300 |

Validation (`checkRoomEdits`, on the server before every save): finite numbers, the ranges above, known anchor ids
(read from the GLB's JSON chunk + scene.json), installed props, positions within the room's bounds + 8 m (|x| ≤ 500 m when
the bounds are unknown), ≤ 256 KB. A bad save is refused with `422 {errors}`; a file written by another version still
loads with its valid part.

**Merge** (`mergeRoomEdits(sceneJson, edits)`, never mutates the room): `cameras` → `cameraOverrides`, `spots` →
`spotOverrides`, displays / buddy points → the scene.json keys of the same name (per spot, the edit wins), `screen` →
`screenEdit`, `props` → `placedProps`, `camTweaks` → `camTweaks`, `chatScreens` → `chatScreens`, plus `userEdits` (the layer itself). `GET /api/scenes`
carries each room's layer as `userEdits`; every page merges it when it loads the room (`SceneRuntime.load`), the room
check (`GET /api/rooms/check/<id>`, MCP `check_room`) checks the merged room.

## 1b. The room's own objects (`src/scene/roomObjects.ts`)

`listRoomObjects(room)` decides what the editor offers as "objects": nodes of the loaded room that are **named**, **drawn**
(data nodes, colliders, walk floors, screen-skin templates and scene.json `hideNodes` are not), **not an engine node**
(`ENGINE_NODE` in `shared/roomEdits.ts`; their whole subtree belongs to the engine), contain a (non-skinned) mesh, and are
at least 0.15 m across. A node that holds an engine anchor (a couch with `SPOT_01` in it), an unnamed group, or a
room-wide container (a group over 60 % of the room's size) is opened up and its children are offered instead. At most 250;
parts that move by themselves (a room clip, an engine, a moving parent: the world matrix changed while the object's own
edit did not) are dropped from the list 2 s after the room loads — one the layer already holds stays listed, tagged
"moves by itself", with Show / Put back but no handle. Names are the node names as three.js loads the room (GLTFLoader
makes them unique), so every page finds the same node; a rebuilt room whose names changed simply ignores entries it no
longer has. An **LOD group** (siblings `<base>_LOD0 … _LODn`, `src/stage/gfx/lod.ts`) is ONE object, named by its first
level and labelled by its base ("Tree"): listed once, picked from whichever level is drawn, every level snapshotted,
moved by the same transform and hidden together; the LOD system never shows a level the layer hid (`gfxLod.hold`) and
measures a moved group where it stands now (`gfxLod.refit`).

Applying (`applyRoomExtras` → `applyRoomObjects`): the authored transform + visibility of each touched node is
snapshotted first — every moved node before any is placed, so a moved parent never changes the size a moved child is
taken at; a moved node is placed like the react screen (room-space pose, size × its authored room-space size — taken by
`decompose`, so a mirrored mesh keeps its negative axis and never flips; parents before children); the room's glTF clips stop driving moved nodes (`RoomClips.freeze`, before placing: else the mixer
puts an animated object back every frame) and drive them again once they are put back; a hidden node gets `visible = false` and its meshes leave `room.occluders` (the cameras, the
framing guarantee and the chat props stop seeing it). `restoreRoom` puts every snapshotted node back exactly (and the
occluders back in), so Show / Put back / Undo / Reset are exact, and scene.json `hideNodes` stay hidden whatever the layer
says. A hot apply re-takes the ray rest pose of exactly the nodes it moved or put back (`SceneRuntime.refreshRays`), so
a page that applies a Save in place tests them where a page that loads with the layer does. The editor's handle math
(`objectTarget`: handle → node origin at the AUTHORED size × the gizmo's size, from `authoredRoomMatrix`) is the same for
its drag preview and its Save, so a child of a resized parent never jumps on mouse-up. The walk mover forgets
the ground it cached under walking feet (`AvatarMover.roomChanged`, through every wrapped mover). Moving an object never moves
light baked into the room: its painted-in shadow stays where it stood (the editor says so once).

## 2. API (the local server)

| Call | |
|---|---|
| `GET /api/rooms/:id/edits` | `{ roomId, edits \| null, anchors: {spots, cams, screen, bounds}, objects: true, presets: true }` — `objects` / `presets` say this server keeps the room's own objects and layouts |
| `PUT /api/rooms/:id/edits` `{edits, apply?: "now" \| "later", live?: "ok"}` | localhost only. Validates, saves, sends ONE bus message `{type:'roomEdits', id, rev, apply}`. **On air** (OBS streaming / recording, read-only `GetStreamStatus` through VTube Pro's OBS link) and `apply: "now"` without `live: "ok"` → `409 {live: true}` and nothing is saved: the editor asks "Apply now on stream / Save for later / Cancel". The live camera tweaks are kept from the stored file (only the tweak route writes them). |
| `PUT /api/rooms/:id/edits/tweak` `{angle, tweak \| null}` | localhost only. One angle's live tweak, merged on the server (writes are queued per room), applied at once (a deliberate live action). |
| `DELETE /api/rooms/:id/edits?apply=now\|later` | Reset (same on-air rule). |
| `GET /api/props` | `{ items: PropItem[], kits, budgets }`: the CC0 library kits (`assets/library/props/<kit>/index.json`) + installed prop packs (`<data>/props/<pack>/props.json`) |
| `GET /api/props/file/lib\|pack/:kit/*` | a prop's model / texture / thumbnail |
| `GET /api/rooms/:id/presets` | `{ roomId, presets: [{slug, name, savedAt, changes}] }` newest first (§2b) |
| `GET /api/rooms/:id/presets/:slug` | `{ roomId, preset: {schema, room, slug, name, savedAt, edits} }` |
| `POST /api/rooms/:id/presets` `{name, edits}` | localhost only. A new layout → `201 {ok, preset, dropped, note?}`: what fits this room is kept, entries that don't (another room's places, a prop not installed here, an object this room hasn't got) are left out and counted, `note` says so in plain words; only a body that isn't a layer at all → `400`; ≤ 30 per room → `409` |
| `PUT /api/rooms/:id/presets/:slug` `{name?, edits?}` | localhost only. Rename and / or replace it (trimmed like POST) |
| `DELETE /api/rooms/:id/presets/:slug` | localhost only. `{ok, removed}` |

## 2b. Layouts (named presets, `shared/roomLayouts.ts`)

A layout is a saved copy of a room's layer under a name ("Podcast", "Gaming night"):
`<data>/room-edits/<room id>/presets/<slug>.json` =
`{ "schema": "vtp-room-layout/1", "room", "slug", "name", "savedAt", "edits": {…a vtp-room-edits/1 layer…} }`.
Names are cleaned (≤ 40 characters); the slug comes from the name (`gaming-night`, then `gaming-night-2` …). A layout never
holds the live camera tweaks (those belong to the room). **Loading a layout never reaches OBS by itself**: the editor puts
it in its view as one undo step, and its Save goes through `PUT …/edits` with the usual on-air question. A layout made for
another room or another PC (an imported file) is kept with what is valid for this one, and the editor says how many things
were left out (both stores: `shared/roomLayouts.ts` `trimLayout`; the editor posts the file's own layer, so that trim is
the only one and its count is right). After **Reset to default**, Undo / Redo or any later
Save that isn't that reset leave it: only a Save right after it removes the saved layer (and its live camera tweaks).

## 3. Live safety

- The editor runs in **`output.html?roomEdit=<room>`**: a private page of that room (like `?sceneTest`): the room comes
  from the URL, it never follows the bus' scene state, never applies a bus `roomEdits` message, never publishes frames,
  never saves profiles. Dragging in it changes nothing anywhere else. It opens on every build; a page without `?roomEdit` never imports the editor code.
- **Save** is the only thing that reaches OBS: one bus message. OBS / preview pages that show that room apply it **in
  place** (`SceneRuntime.applyEdits`: no room reload, no curtain): cameras / places / the screen / displays / props go
  where the layer says, performers at a moved place are re-placed there, the solo screen retracts and drops at its new
  place, the framing rays are refreshed and the camera eases to the new shot with the normal transition (a move through
  a wall cuts, as always). `apply: "later"` only makes pages drop their cached room list: the edits show the next time
  the room loads.
- Pages showing another room ignore the message.

## 4. The editor (`src/scene/roomEdit/editor.ts`)

Opened by `openRoomEditor(roomId)` (studio: Room → **Edit room…**) as a full-window frame. The view is letterboxed to
16:9 (what OBS frames).

- **Select** in the list (Cameras · Places · Screens + chat · Props) or click in the view. **Move (W) / Turn (E) / Size (R)**
  gizmo (three.js TransformControls; places and displays turn about +Y only, cameras without roll), or type exact
  numbers (position, yaw / pitch / roll, lens, width, size). **Snap**: off · 5 cm / 5° · 25 cm / 15°.
- **Look through (C)**: the selected camera exactly as on stream, with title safe, the face-safe area of that shot family
  (talk 0.82 / 0.84 / 0.94, group 0.84 / 0.86 / 0.94: `shared/framing.ts`) and every place's face box (green inside, red
  outside). In that view the mouse flies the camera itself (orbit round its aim, pan, wheel = dolly); the change is one
  undo step when the move ends.
- **+ My camera from this view** (`CAM_MY_1…8`: they appear in every camera menu), talk cameras for places.
- **Screens + chat**: pick a place, then **+ Solo screen / + Chat monitor / + Support board / + Chat buddy spot** puts one
  in front of it to move. Without one VTube Pro keeps placing them automatically per shot.
- **Add a prop**: thumbnails from installed packs (first) and the CC0 library, search + pack filter; a prop lands on the
  floor where the view looks, facing the camera. Delete, Ctrl+D duplicate, Drop to floor.
- **Room objects**: the room's own things (§1b) in a searchable list, or **click one in the view** (a click, not a drag;
  a yellow box shows the selection). The same gizmo moves / turns / sizes it, or type numbers; **Hide** / **Show** (the
  Delete key hides), **Drop to floor**, **Put back** (where the room had it).
- **Layouts** (top of the panel): **Save as new layout…** (type a name; the name of an existing layout asks to replace
  it), and per layout **Load** (into the editor; Save puts it on stream), **Rename**, **Export** (a `.vtplayout.json`
  file), **Delete** (asked first); **Import a layout file…**; **Reset to default** (asked first): the room exactly as it
  came — its Save removes the saved layer (live camera tweaks included, a copy kept), layouts are kept.
- **Reset to original** (one thing), **Undo / Redo** (Ctrl+Z / Ctrl+Y, 100 steps), **Save** (Ctrl+S).
- **Warnings** (bottom right, live; `shared/roomEditCheck.ts`): a camera you moved that cuts a face off / no longer sees
  its place, CAM_REACT that loses the react screen or shows it small, a prop standing on a place, hiding a face from a
  camera, or in front of the react screen. Nothing is blocked: on air the framing guarantee still re-aims a talk / group
  shot that loses a face; the warning says where your own choice won't be used as is. The same warnings are `edits`
  lines in the room check.

Debug: `window.vtpRoomEdit` on the editor page (`edits`, `items()`, `objects()`, `warnings`, `select(id)`, `save()`,
`store`, `layouts`).

## 4b. Chat in the room (`src/scene/chatScreens.ts`, `src/ui/chatWhere.ts`)

The chat shows **On screen** (the docked chat box: `shared/chatBox.ts`, `src/ui/chatBoxPanel.ts`) or **In the room**, **Both** or
**Hidden** — one choice in Chat & events (`chatWhereChoice(app)`, saved per key through the scene sync: `chat.monitor` +
`stage.dock.chat`; `shared/chatBox.ts` `chatWhereOf`).

- In the room without any edit: the automatic chat monitor (placed per shot, never over a face or the react screen).
- **+ Add chat screen** (editor, or "Place the chat in the room…" next to the choice: the editor opens with the chat
  screens up front) puts a chat screen where the view looks, facing the camera. Drag it anywhere, turn it, **resize** it
  with the gizmo (Size, R) or Width / Height / Small · Medium · Large · Wide; Opacity, Text size, Frame on / off,
  **Turns to the camera** or **Stays where it is**. Up to 8 per room; they replace the automatic monitor in that room.
- Readable at any size: each screen's canvas is sized to the panel (640 px per metre, ≤ 1600 px) and the text keeps its
  size in metres (a bigger screen shows more lines, never stretched text); `text` scales it. A bigger screen never sinks
  into the floor (its bottom stays ≥ 0.3 m up).
- They show while the chat is In the room (and, with "only while chat is active", while it is), fade in / out, and are
  hidden while an event holds the chat monitor (a raid interrupt). Saved in the layer like everything else: per room,
  through reloads, restarts and room switches; OBS follows on Save with the same live rules.
- The checker treats a chat screen like furniture: it warns when it stands on a place, hides a performer's face from a
  spot / wide / own camera, or stands in front of the react screen in the React shot.

## 4c. One-click fixes

Every warning has a button: **Fix this camera** (a talk camera re-aimed at its place's face with a head-and-shoulders
lens; a wide / own camera aimed at the middle of the places with a lens that fits every face; CAM_REACT aimed at the
react screen so it fills ~80 % of the width) or **Move it out of the way** (a prop / chat screen moved to the nearest
spot within 4 m where it raises no warning). One undo step each; "Fixed. Undo (Ctrl+Z) puts it back."

## 5. Live camera sliders (`mountCameraTweaks(el, app)`)

While the show runs: **Direction** (orbit round the subject ±90°), **Tilt** (from lower / higher ±30°), **Distance**
(dolly ±3 m), **Height** (±1.5 m, aim kept level), **Zoom** (lens ±25°), and **Reset this angle**. The tweak is stored for
the angle on air — the talk shot of the focus' place, the solo React shot, group / wide / react, or a preset camera — in
`camTweaks`, and re-applied every time that angle is used (`SceneRuntime`: `tweakPose` on the resolved shot; the tweak is
part of the shot key, so a change eases like any camera change; director / follow-cam / screen-video shots are never
tweaked). The pivot is the framed face (talk / solo) or the middle of the places along the view. Sliders send ≤ ~8
changes a second; the last always goes.

## 6. Seating chart (`mountSeatingChart(el, app)`)

A top-down map of the room's places (SPOT_xx + size spots: label, stand / sit, size icons, facing tick; stage front
down) with who sits where. Drag a person onto a place, or tap the person then the place. While dragging, each place shows
whether it suits that performer (green made for them, amber works, red never — `SceneController.spotFitFor`: size
classes + body kinds + room forms). A refused seat says why (`SceneController.sizeWarning`). Seats are remembered per
room by the scene controller (the host's own pick per room; guests by Discord id or name).

## 7. Prop packs (`vtp-props/1`)

A folder `<data>/props/<pack id>/` with `props.json`, one self-contained `.glb` per prop and optional thumbnails:

```json
{ "schema": "vtp-props/1", "id": "harbour_bits", "name": "Harbour bits", "version": "2026.10.06-1",
  "author": "Who made it (credit for CC-BY)", "license": "CC0-1.0", "source": "https://…",
  "items": [ { "id": "crate_small", "name": "Small crate", "file": "crate_small.glb", "thumb": "thumbs/crate_small.png",
               "category": "crates", "tris": 412, "meshes": 1, "size": [0.6, 0.6, 0.6], "place": "floor", "scale": 1 } ] }
```

- Ids `a-z 0-9 _ -`; version `YYYY.MM.DD-n`; licence `CC0-1.0`, `CC-BY-4.0` (credit in `author`) or `own` — never NC / ND,
  never game rips (docs/RESOURCES.md §7).
- Per prop: ≤ 20,000 triangles, ≤ 8 meshes, `size` in metres; metres, +Y up, origin at the bottom centre, front +Z;
  textures ≤ 1024². `place` = floor | surface | wall | ceiling | free (a hint; the editor drops floor props to the floor).
- **Delivery:** put the pack's folder in `<data>/props/<id>/` (`props.json` required). `GET /api/props` lists every
  installed pack next to the CC0 library kits. There is no store: the packs are files you or a friend made.
- The CC0 kits in `assets/library/props/` (docs/ASSET_LIBRARY.md) are listed as `lib:<kit>/<item>` (items over the
  triangle limit are left out).

### Light props (`shared/propLights.ts`)

A prop can carry its own lamp, marked the same way as in a room (docs/ARTIST_ENVIRONMENTS.md §2.3, §4.8; never export
Blender lights):

- an empty named **`LIGHT_<anything>`** with glTF extras (Blender custom properties, export with *Include → Custom
  Properties*): `kind` `point` | `spot` | `emissive`, `color` `#rrggbb`, `group` (the pack id), optional `range` (m),
  `intensity` (×1), `angle` / `penumbra` (spot, aimed along the empty's −Z);
- prop-only animation: **`effect`** `flicker` (fire) | `pulse` (magic) | `strobe` (club; one lamp never asks for more
  than 3 flashes a second, whatever the speed) | `steady`, `speed` (×1, 0.1–5), `amount` (how deep it dips, 0–1). With
  **Safe flashes** on (the default) the room never shows more than 3 flashes a second from light props, whatever a pack
  sets: see *Photosensitivity* below;
- the glowing mesh uses a Principled material named **`EMIT_<group>`** (near-black base, emission ~3): it glows on every
  PC and follows the effect of the lamp whose `group` matches (else the prop's first lamp), in step with that lamp's
  real light and for every copy of that model;
- `"tags": ["light"]` on the item in props.json (the editor and the store can show it as a light).
- Also read: the same keys in a nested `vtpLight` extras object, and a `LIGHT_*` node exported as a glTF
  KHR_lights_punctual light (its kind, colour, range and cone are the defaults; its glTF intensity is ignored, use
  `intensity`). A spot aims along the node's −Z, or at `target` [x, y, z] in the prop's own space.

Runtime (`PlacedProps` in `src/scene/roomEdits.ts`, ticked by `SceneRuntime.update`): each placed copy's lamps become
real THREE point / spot lights (no shadows, the room light engine's units) up to **`PROP_LIGHT_BUDGET`** per room —
Performance 0, Balanced 1, High 2, Ultra 4, on top of the room's own lamps — spots first, then the strongest; the rest
glow only. A lamp's phase comes from its model (+ 0.37 per lamp): the glow is one material shared by every copy, so
every copy's real light plays in step with the glow it sits in, while different lamps and different props stay out of
step. The real lights are a pool that only grows while the room is up, so a Save that moves, adds within the pool or
removes a light prop never changes the scene's light count (that would recompile every shader on stream); unused pool
lights sit at intensity 0. `info.lights` / `info.lightsOver` say how many got a real light. Tests:
`npx tsx tools/proplights_unit.ts`.

**Photosensitivity (Safe flashes, Scene tab → Lights).** Every animated lamp of a prop model is ONE output on the page's
flash governor (`shared/flashGovernor.ts`, docs/SCENES.md "Photosensitivity"): every copy's real light and the `EMIT_`
glow show that one governed level, so a bulb and the light it casts never flash out of step, and steady lamps never touch the governor.
With Safe flashes **on** (the default), no light prop and no group of them lighting one area flashes more than 3 times
a second, whatever a pack sets (speed 5, amount 1, any number of lamps or copies, saturated red included):

- each effect plays at most at `SAFE_SPEED`: a flicker keeps its full depth on its two slow swells (×0.6 speed at
  most; the fast ripples of a deep flicker would count as flashes), a pulse breathes and a strobe flashes at most 1.5
  times a second. A lamp then asks for no more than the limit on its own, so the governor only delays its turns;
- the governor holds every turn to its room-wide windows (180 ms apart, or on the beat grid) and applies the red rule;
- the governed levels are redrawn as straight ramps on one shared 180 ms clock, so the lamps of several props summed
  over one area also turn at most once a slot (each governed light alone can't pass 3; two moving opposite ways
  between windows could, summed). A light shows its change up to ~180 ms later and a short flash softer.

With Safe flashes **off** nothing is held or slowed: every effect plays as authored, and anything over 3 a second (one
lamp, or the animated lamps summed) turns on the OBS "Flashing lights" notice (when the streamer switched it on).
`tools/proplights_unit.ts` scores what is drawn (every real light, every glow and the lot summed, through the real
`PlacedProps`): with Safe flashes on, every shipped lamp, the most a pack may set and 40 random rooms stay at ≤ 3
flashes a second (without the limit: the club sparkler 14, a pack at the maximum 19, two strobe props out of step 6).

**Budgets** (all placed props of a room together, after instancing; `PROP_TRI_BUDGET` / `PROP_DRAW_BUDGET`):

| Graphics | Low | Medium | High | Ultra |
|---|---|---|---|---|
| triangles | 40,000 | 90,000 | 180,000 | 300,000 |
| draw calls | 40 | 80 | 140 | 200 |

Copies of one model are drawn **instanced** (one draw call per mesh of the model, whatever the number of copies). Props
over the budget of a PC's graphics level are not drawn on that PC (in placing order; the editor says how many). Every
copy gets an invisible ray proxy in the room's occluders (sharing the model's geometry + BVH), so the camera solver, the
framing guarantee, the chat props and the chat buddy treat it like furniture.

## 8. Tests

- `npx tsx tools/roomedits_unit.ts` — validation, merge, budgets, the warnings (pure + on the merged sample room through
  the room check), prop packs, the store, the tweak math.
- `npx tsx tools/roomed_layouts_unit.ts` — the room-object keys (validation, merge), the runtime on a synthetic room (LOD groups, a moved parent + child, clips frozen on moved objects, walk feet, trimmed layouts)
  (which nodes are objects; hide / move / restore exactly, occluders included; author `hideNodes` stay), layouts (names,
  slugs, format) and the server's layout store.
- `node tools/roomedit_e2e.mjs --out <dir> [--kit <assets/library/props folder>]` (PLAYWRIGHT_CORE / CHROME set) — a
  private server + Vite on 5811 / 5812, muted headless Chrome: the editor on the sample room (move CAM_WIDE + a place, add
  / move / turn a prop, undo / redo, Save, reload and check), an OBS-style page applying a second Save in place and easing
  to a live tweak, validation over HTTP, check_room on the merged room, Reset; screenshots at 1920×1080 and 390×844.
- `node tools/proplights_e2e.mjs --out <dir> [--runs on:wide,on:close,off:wide,off:close] [--gfx high] [--bypass raw]`
  (PLAYWRIGHT_CORE / CHROME set) — light props on RENDERED frames: a private server + Vite on 6486 / 6487, the sample room
  with shipped light props (sparkler bucket, wall torches, candelabra, firefly lantern, mirror ball, beacon) and a test
  pack at the maximum (strobe + flicker speed 5 × amount 1, a #ff0000 strobe) around the performer, 1920×1080, CAM_WIDE
  and the performer's close shot, Safe flashes on and off; counted with `festival_e2e.mjs flash`'s drawn-flash counter
  (full / stage / WCAG tiles / red / WCAG area, limit 3) + whether the "Flashing lights" notice fired; results.json and a
  contact sheet. `--bypass raw` (sanity only) runs the page without the governor: the counter must see > 3.

## Known limits

- Room objects are found by node name: a room rebuilt with renamed nodes drops those entries (nothing breaks). Objects an
  engine reads by name outside the anchor list may still be listed; moving them moves only what is drawn.
- Baked light (lightmaps, painted-in shadows, baked vertex light) does not follow a moved object.

- Party guests' OBS pages render the room with THEIR own edits (each PC keeps its own layer); the host's edits are not
  sent over the party link yet.
- Entrance walks (DOOR / DOOR_OUTSIDE / PATH_xx) are not editable yet; a moved place drops its scene.json approach
  waypoints (GLB ones within 3 m stay). Automatic size spots are derived when the room loads (a Save that moves places
  re-derives them on the next load).
- Ambient (Preshow / BRB / Outro) camera moves are generated from the room; edit CAM_WIDE to steer them.
- Chat screens are not ray occluders (the automatic cameras don't route round them): the warnings + "Move it out of the
  way" cover that. The chat buddy does not yet avoid standing in front of a placed chat screen.
