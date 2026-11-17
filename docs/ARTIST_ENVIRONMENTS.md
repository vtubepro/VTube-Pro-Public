# 3D environments (rooms) for artists

This guide shows you how to build a room for VTube Pro, from an empty Blender file to a room your friends can sit in
on stream. The first part is plain words and steps. The second part is the full reference.

A **room** is a 3D place you stream from: a living room, a café, a spaceship. VTube Pro puts you and your guests on the
places you mark. Its own camera operator films you. Its light show changes the room for each moment of your show.

**First time?** Read [Start here](#start-here), then go straight to
[section 4](#4-build-it-in-blender-step-by-step). Sections 2, 3 and 5–16 are look-up pages: come back when a step
points you there. Rather let an AI build it? See [section 18](#18-let-an-ai-build-it-claude-or-codex).

Contents: [Start here](#start-here) · [0 The checklist](#0-the-short-version-checklist) ·
[1 How a room works](#1-how-a-room-works) · [2 The room contract](#2-the-room-contract) ·
[3 Scale, axes and where people stand](#3-scale-axes-and-where-people-stand) ·
[4 Build it in Blender, step by step](#4-build-it-in-blender-step-by-step) ·
[5 Light](#5-light-baked-light-light_-and-emit_) · [6 Day / night and weather](#6-day--night-and-weather) ·
[7 Screen skins](#7-screen-skins) · [8 Optional engines](#8-optional-engines-and-their-anchors) ·
[9 Performance budgets](#9-performance-budgets) · [10 Check every camera](#10-check-every-camera) ·
[11 Test it, step by step](#11-test-it-step-by-step) · [12 Worked examples](#12-worked-examples) ·
[13 Licences](#13-licences) · [14 Troubleshooting](#14-troubleshooting) ·
[15 "Add my room" and the room check](#15-add-my-room-and-the-room-check) ·
[16 scene.json reference](#16-scenejson-reference) · [17 Share your room](#17-share-your-room) ·
[18 Let an AI build it](#18-let-an-ai-build-it-claude-or-codex).

---

## Start here

### Three ways to get a room into VTube Pro

1. **Use a model you already have.** Press **Room** → **＋ Add my room** and drop the file. VTube Pro checks it, finds
   places to sit and adds cameras. It takes about 2 minutes. See [Rooms: the easy way](ENVIRONMENTS_SIMPLE.md).
2. **Build it yourself in Blender.** You choose every seat, camera, lamp and the walk-in. Section 4 walks you through
   it, step by step.
3. **Let an AI build it.** Claude or Codex can write a Blender script from this guide and save the room for you. See
   section 18, and [Make a model with Claude or Codex](MAKE_WITH_CLAUDE_OR_CODEX.md) for every step.

### What you need

- **Blender.** It's free (<https://www.blender.org/download/>). Any 3D app that saves glTF Binary (`.glb`) works too,
  but the steps here are for Blender.
- **VTube Pro running** on your computer (`Start VTube Pro`), to try a room you built by hand.

### Blender in 2 minutes

Never used Blender? These are the only things the steps below expect you to know.

- The **Outliner** is the list of objects at the top right. Double-click a name there to rename it.
- The **Properties** panel is below it, with a column of icons: orange square = **Object**, green camera or green
  triangle = **Object Data**, red ball = **Material**, printer = **Output**, camera back = **Render**, red globe =
  **World**, cone and sphere = **Scene**.
- **Turn the view:** hold the mouse wheel and drag. **Slide:** Shift + wheel-drag. **Zoom:** roll the wheel.
- **Undo:** Ctrl+Z. **Tab** switches between Object Mode (move whole objects) and Edit Mode (change their shape).
- **N** opens the sidebar on the right of the 3D view. Its **Item** tab has **Location**, **Rotation** and
  **Dimensions** boxes you can type into.
- No numpad? Use **View** → **Viewpoint** → **Front** or **Top**. On a laptop: **Edit** → **Preferences** →
  **Input**, tick **Emulate 3 Button Mouse** and **Emulate Numpad**.

### Words this guide uses

| Word | What it means |
|---|---|
| Object name | The name of an object in Blender's Outliner. VTube Pro finds your seats, cameras and lamps by these names. |
| Empty | An invisible marker in Blender (**Add** → **Empty**). You use empties to mark places, the door and the walk-in path. |
| Custom property | A small note on an object, like `pose` = `sit`. You add it in **Object Properties** → **Custom Properties**. In the exported file it's called an "extra". |
| GLB | The one-file 3D format VTube Pro reads. Blender calls it **glTF Binary (.glb)**. Your room's model is `scene.glb`. |
| scene.json | A small text file next to the model. It holds the room's name and settings. |
| Room folder | One room's folder, like `my_room`, with `scene.glb`, `scene.json` and two pictures. Its name is the room's id. |
| Scenes folder | VTube Pro's folder that holds every room folder you add. Its real name is `scenes` (1.2). |
| glTF space | Directions inside the exported file: metres, +Y up, the front of the room toward +Z. Blender uses Z up, with the front toward −Y. The exporter converts for you. |
| Origin | The small orange dot of an object. It moves and turns around this point. |
| Material | The paint on a surface. **Principled BSDF** is Blender's normal material: every new material uses it. |
| UVs | How a picture is laid onto a surface. A new plane already has the right ones: don't edit them. |
| Grey box | The room made of plain shapes, with no colours yet. Test it before you add detail. |
| Bake | Saving light and shadow into the room's colours, so it looks lit without real-time lights. |
| React mode | When you watch a video or website with your viewers. It plays on the room's `SCREEN`. |
| Triangles, draw calls | How much work the graphics card does. Fewer is faster. |
| Atlas, decal | An atlas is many small textures packed into one picture. A decal is a picture stuck on a surface, like a sticker. |
| CC0, CC-BY | CC0: free to use, no credit needed. CC-BY: free, but credit the maker. |
| HDRI | A 360° sky photo used as light. |

### Your first room in 8 steps

1. Model the room in Blender with an open front, like a TV set (4.1, 4.2).
2. Add empties `SPOT_01`, `SPOT_02` … where people sit or stand (4.3).
3. Add a camera `CAM_WIDE` that sees every place (4.4).
4. Optional: a React screen, a door and a walk-in path (4.5, 4.6).
5. Name glowing materials `EMIT_<group>` and bake the light (4.8, 4.9).
6. Make a room folder like `my_room` in your scenes folder, and export `scene.glb` into it (4.10).
7. Add a `scene.json` and two pictures to that folder (4.11).
8. In the studio, press **Room** (in the menu down the left side) → **↻ Rescan** (next to **Change room**) and test it
   (section 11). Careful: picking a room changes your stream at once. Test while you're not live.

Prefer a script? Section 4.12 builds a complete starter room in one go.

---

## 0. The short version (checklist)

1. A room folder named like `my_room` (lowercase letters, digits, `_` or `-`). Inside: `scene.glb`, `scene.json`,
   `preview.png` (1280×720) and `thumb.png` (480×270).
2. **Metres**, floor at height 0. In Blender: Z up, the open front faces **−Y**. In the file: +Y up, front = +Z.
3. Empties `SPOT_01` … `SPOT_12` on the floor where people go, facing the cameras. Custom properties: `pose` (`sit` or
   `stand`), and `seatHeight` for seats. At least 1 place; 2 or more so a friend can join.
4. A camera `CAM_WIDE` that sees every place. For React mode: a 16:9 plane `SCREEN` and a camera `CAM_REACT`.
5. `DOOR` (origin on the hinge), `DOOR_OUTSIDE` and `PATH_01` … so friends walk in.
6. Export glTF Binary with **Custom Properties**, **Cameras** and **Apply Modifiers** ticked, **+Y Up** on and
   **Punctual Lights** off.
7. **Bake the light** into vertex colours or textures. VTube Pro turns room shadows off.
8. Lamps and neon: `LIGHT_*` objects (custom properties `group`, `color`, `kind`) and materials named `EMIT_<group>`.
9. **Nothing may block a performer's face or the React screen** from any camera.
10. Stay light: about 80,000 triangles, 25 MB and 180 draw calls (section 9). To see your triangle count in Blender:
    open the **Overlays** menu (two overlapping circles, top right of the 3D view) and tick **Statistics**. Triangles
    shows at the top left. The room check (section 15) counts draw calls for you.
11. Keep the room folder in your scenes folder, press **Room** → **↻ Rescan** and test it (section 11).
12. Check every camera view by hand (section 10).
13. Quick check of any room file: drop it into **＋ Add my room**, or ask a connected AI to run `check_room`
    (section 15). **At least 1 usable place is required, 2 or more recommended.**

---

## 1. How a room works

VTube Pro reads your room **by object names**. Any `scene.glb` built to these rules just works. When you pick a room,
VTube Pro:

- puts you (the host) on `SPOT_01` and up to 11 guests on the other places. It remembers your last seat in each room;
- shows every person of normal height 1.5 m tall (scene.json `avatarHeight`), and seats or stands them as each place
  says;
- walks newcomers in from `DOOR_OUTSIDE`, along `PATH_01`, `PATH_02` …, to their place. Without a door, friends appear
  right in their seats;
- films everyone with an **automatic camera operator**: talk shots, group shots, a wide shot, React (the screen) and a
  walk-in follow shot, plus every `CAM_*` you add. It tests each shot against your room: hidden faces, empty space in
  the frame, cameras inside props, clutter in front of the lens;
- runs the **lighting states** (Preshow, Show, React, BRB, Outro) and the music light show through your `LIGHT_*`
  objects and `EMIT_<group>` materials;
- places the in-world chat monitor, the support board and the chat buddy in each shot, away from faces and the screen;
- turns **room shadows off** and adds its own stage light for the avatars. So your room's look must be baked in
  (section 5).

### 1.1 The room folder

```text
my_room/                  the folder name is the room's id
  scene.glb               the model (required)
  scene.json              name and settings (required: no readable scene.json, no room)
  thumb.png               480 × 270: the card in Change room
  preview.png             1280 × 720: the room-change card (and the card when there's no thumb.png)
  lut.png                 optional: your own colour grade on High and Ultra (a 1024 × 32 strip)
  areas/bar/thumb.png     optional, rooms with areas: each area's own thumb.png, preview.png and lut.png
```

- **The folder name is the id.** It starts with a lowercase letter or digit. Then lowercase letters, digits, `_` or
  `-`. 48 characters at most. `My Room` is ignored; `my_room` works.
- **scene.json must be valid JSON.** A typo hides the whole room, with no error message (section 14).
- The model is `scene.glb`, unless scene.json `"model"` names another file in the same folder.
- The pictures have fixed names. The card uses `thumb.png`, else `preview.png`. The room-change card uses
  `preview.png`, else the thumb. Give every room a good 16:9 `preview.png`.
- No model file yet? The room's card is greyed out ("not built yet").
- A `blender/` folder, textures or a README can stay in the folder while you work. VTube Pro doesn't load them.

### 1.2 Where rooms live

Rooms live in **your scenes folder**. Each room is one room folder inside it. In this copy of VTube Pro (run from the
folder you downloaded) that is **`assets/scenes`** inside your VTube Pro folder: the rooms that come with VTube Pro and
the rooms you add sit together there. (If you set `VTP_DATA_HOME`, rooms you add go to `<that folder>/scenes` instead.)

- **Add my room** and rooms an AI builds save rooms here.
- To open it on Windows, open your VTube Pro folder in File Explorer, then `assets`, then `scenes`. VTube Pro has no
  button that opens it.
- The rooms that come with VTube Pro are good examples. Their `scene.json` files are worth reading. Keep a copy of
  one before you change it.
- VTube Pro reads the folder each time it lists rooms. Copy a folder in, then press **Room** → **↻ Rescan**. No
  restart needed.

Two names that look alike: a **room folder** (like `my_room`) holds one room. Your **scenes folder** holds all your
room folders.

---

## 2. The room contract

These tables list every name VTube Pro looks for. Positions are in glTF space (metres, +Y up, front = +Z) unless a
line says Blender. Custom properties on Blender objects and materials become glTF `extras` when you tick
**Custom Properties** on export (4.10). An empty's "+Z" (the way it faces) is its local **−Y in Blender**.

### 2.1 Core nodes: places, cameras, screen, door

| Name | Needed? | What it is, and its custom properties |
|---|---|---|
| `SPOT_01` … `SPOT_12` | At least 1 (2 or more recommended, aim for 5–12) | An empty where a person goes. Origin on the floor: under the feet (standing) or under the hips (sitting). The person faces the empty's +Z (Blender −Y). `pose`: `"sit"` (anything else means stand). `seatHeight`: metres from the origin up to the cushion (0.15–1.4, default 0.45). `seatDepth` (default 0.5). `label`: the name the studio shows (40 characters, default "Spot N"). `approach`: a flat list of glTF points `[x, y, z, x, y, z …]` (32 points at most) to walk around furniture. `leavePathAt`: the path point where the walk turns off to this place, like `"PATH_02"`. `sizes` (2.5). The name must be exact: Blender's copy `SPOT_01.001` is ignored. |
| `SPOT_xx_CAM` | No | A talk camera for that place. VTube Pro keeps it when its own check finds it clean, else it uses its automatic shot. |
| `CAM_WIDE` | Strongly recommended | The main wide view. It should see every place. Without it, VTube Pro makes an automatic one. |
| `CAM_REACT` | With a `SCREEN` | Frames the screen at about 80 % of the picture width. At a 35° field of view that's about 1.12 × the screen width away. |
| any other `CAM_*` | No | Presets like `CAM_DESK`. They appear in the **Camera** list as "Desk (preset)" and join the slow camera tours in Preshow, BRB and Outro. `CAM_DOOR` is the entrance camera: aim it at the inside of the doorway. |
| `SCREEN` | For React mode | A flat 16:9 rectangle, UVs 0..1 and not rotated, facing the cameras, with rotation and scale applied. Where you put it is where it shows in React. `restOffsetY`: how far above that it waits the rest of the time (it drops in). The screen surface is the mesh itself, else a child with `surface` in its name, else the biggest child. Without a `SCREEN`, React uses a floating screen. |
| `SCREEN_SOLO_xx` or `SCREEN_SOLO` | No | An empty: where the solo React side screen hangs when the host sits at `SPOT_xx`. Origin = the picture's centre, +Z faces the viewer. `width`: 0.8–5 m (default 2.4). Or scene.json `soloScreens`. |
| `DOOR` | Recommended | The door leaf. **Origin on the hinge.** It turns about its local +Y (Blender Z). `openAngle` in degrees (default 95; a negative angle swings the other way). |
| `DOOR_OUTSIDE` | Recommended | An empty just outside the door, facing in. People appear here and walk in. |
| `PATH_01`, `PATH_02` … | Recommended | Empties on the floor from the door to the middle of the room, walked in number order. Keep a clear lane from the path to every place. |
| `DOOR_LOCKED` / `DOOR_UNLOCKED` | No | Small lights that follow the door: `DOOR_LOCKED` shows while it's shut. |

### 2.2 Floors, colliders, LODs

| Name | What it does |
|---|---|
| `FLOOR_*` | A hidden walk floor for risers, ramps and balconies. It counts only when every material on it is named `M_Hidden…`, or it has the custom property `walk` = true. Walkers stand on the highest one under them. Plain `FLOOR` or `FLOOR_1` objects stay visible (normal floors). |
| `COLLIDE_*` | A hidden simple box walkers go around (grown by 0.2 m). Only boxes standing on the floor count: a box is ignored when its bottom is above 0.9 m, or its top is below 0.05 m. |
| `*_LOD0` / `*_LOD1` / `*_LOD2` | Siblings: VTube Pro shows one by its size on screen (LOD0 above about 150 pixels across, LOD1 above about 55). A lone `*_LOD0` (like `DETAIL_LOD0`) is optional detail: hidden on Low and when tiny. |
| custom property `hiddenUntilBroken` = true | Hidden when the room loads (pieces for the background combat engine). |

### 2.3 Lights and glow

| Name | What it does |
|---|---|
| `LIGHT_*` | A lamp, neon strip or sign. `group`: its light group (32 characters, default `default`). `color`: hex like `#ffd9a0` (else its `EMIT_` material's glow colour). `kind`: `spot` or `point` makes a real light; anything else only glows. Optional: `range` (m; spot 9, point 6), `intensity` (×1), `angle` (full cone in degrees, default 40), `penumbra` (0.5), `target` [x, y, z] (where a spot points; else along its −Z). Night lights: `nightOn`, `nightThreshold`, `nightStagger`, `flicker`, `nightFade`, `nightDay`. |
| group names | The name decides what follows the music (docs/SCENES.md "Roles"): lamps / candles / chandeliers / fire, windows, screens and nav / alarm / status lights never dance; spots / beams / lasers move with the beat; coves, strips, neon and the rest carry the colour. Name groups for what they are (`candles`, `cove`, `spots`, `navlights`), or set `lights.roles` in scene.json, e.g. `{"cove": "practical"}` (roles: practical, window, screen, signal, deco, sign, show, accent). |
| material `EMIT_<group>` | Glow the light engine animates per group, anywhere in the room. The group is the name after `EMIT_`, without a `.001` or `_01` ending: `EMIT_neon.001` is group `neon`. It must be a Principled BSDF material. |
| `FX_BEAM_xx`, `FX_LASER_xx`, `FX_BALL` | Where the light-show effects hang: moving-head beams, laser fans and the mirror ball (5.6). Beams aim themselves with built-in sweeps. |

### 2.4 Chat, support, buddy and projector anchors

| Name | What it does |
|---|---|
| `CHAT_MONITOR[_xx]` | Where the in-world chat monitor stands when the host sits at `SPOT_xx`. Origin = the display's centre, +Z toward the camera, `width` (default 0.9 m). A name without a number counts only within 4.5 m of the host's seat. |
| `CHAT_BOARD[_xx]` | The support (donation) board. `width` default 1.4 m. |
| `GOAL_BOARD[_xx]` | The GOALS board (goals, stretch goals, the subathon timer) that winches down while goals are on stream. `width` default 1.6 m, 16:9. Or scene.json `goalBoards` keyed by `SPOT_xx`. Without one the board uses the `CHAT_BOARD` spot while the support board is off. The board never covers a live `TIMER_DISPLAY` / `timerDisplays` mesh: in any shot where it would hang in front of one it winches up (the docked card carries the goals meanwhile) and comes back when the shot no longer frames it there, so hanging the board in front of the clock you built is safe; it keeps its job in every other shot. |
| `TIMER_DISPLAY[_xx]` | A **mesh with UVs** that shows the live subathon countdown (Goals & subathon), drawn onto its UVs: big `H:MM:SS` digits, a `+10:00` pop when time is added, and small badges for happy hour, hype, sleep, paused and test mode. Use a flat plane (or any flat part of a prop) with a normal unwrap: the countdown fills the UV rectangle the mesh uses, upright, never stretched. Several are fine (`_01`, `_02`: every one shows the same clock). Optional custom properties: `style` (`digits`, `neon`, `lcd`), `color` (hex; default = the mesh's own glow colour, else the stage accent), `show` (`remaining`, `uptime`, `both`; default = what the subathon is set to show), `label` (short caption), `fit` (0.3 to 1, default 1: shrinks the glass panel and the digits about the centre of the mesh; use about 0.8 when the plane is bigger than the glowing thing it sits behind, so the clock is set into it instead of flush with its rim), `glass` (0.5 to 1, default 0.95: the panel's opacity; lower lets the mesh's own picture show through). With no subathon running (or Goals → On stream → **In the room** off) nothing is drawn and your own material shows. Or scene.json `timerDisplays` on an existing mesh, no re-export (section 16). |
| `BUDDY_SPOT[_xx]` / `CHAT_BUDDY[_xx]` | A floor or perch point for the chat buddy (a shelf or a desk top works). |
| `PROJECTOR_01` … `PROJECTOR_03` | Empties: where guests who appear on a pull-down projector screen hang (+Z toward the audience). Or scene.json `projectorScreens`. |
| scene.json `chatMonitors` / `chatBoards` / `chatBuddy` / `buddySpots` | The same places, keyed by `SPOT_xx`, without re-exporting (section 16). |

A display on furniture must stand **on** it: its centre at least half its height above the top. Never put one over a
face.

### 2.5 Size spots

Performers have size classes from their avatar's own height (how tall the model is built): `micro` (under 0.6 m), `small` (0.6–1.3 m), `normal`
(1.3–2.1 m: all shown at `avatarHeight`), `large` (2.1–2.6 m) and `macro` (over 2.6 m). Rooms need nothing for this:
tiny performers get automatic perches on furniture beside a place, giants get back-row spots with room above them. To
choose these yourself:

- the `SPOT` custom property `sizes`, like `["micro"]` for a shelf perch or `["macro"]` for a giant's place. A place
  with `sizes` takes only those classes;
- scene.json `spotSizes`, `sizeSpots` and `autoSizeSpots: false` to turn the automatic ones off (section 16). Size
  places, yours and the automatic ones together, come after `SPOT_12`: 8 at most.

### 2.6 Areas (several places in one room)

One `scene.glb` can hold several places: a lounge, a bar and a patio. Each **area** becomes its own room in the
picker, with its own chip.

1. Give every object of an area an upper-case prefix and two underscores: `<AREA>__`. So `BAR__SPOT_01`,
   `BAR__CAM_WIDE`, `BAR__SCREEN`, `BAR__DOOR`.
2. Each area needs its own places and cameras. Give it its own door and screen too. When an area loads, VTube Pro
   renames its objects to the plain names and removes the other areas' prefixed objects.
3. Objects without a prefix are shared by every area. To share an object with only some areas, give it the custom
   property `areas` = `"bar,patio"`.
4. List the areas in scene.json `areas` (keys: lowercase, 24 characters at most, up to 16 areas) and pick the
   `defaultArea`. Each area can set `bounds` and override any other scene.json key (16.3).
5. Each area's own pictures go in `areas/<area>/` in the room folder.

Every area gets the room id `<room>~<area>`; the default area keeps the plain id. The shipped **VTube Pro Hangout** is
a full example (section 12).

### 2.7 scene.json in short

The smallest useful `scene.json`:

```json
{
  "name": "My Room",
  "modes": ["talk", "react"],
  "defaultCamera": "CAM_WIDE",
  "avatarHeight": 1.5,
  "ambience": { "exposure": 1.0 },
  "lights": { "groups": { "neon": "#39ff88", "lamps": "#ffd9a0" } }
}
```

- The folder name is the room id. An `id` key is ignored.
- **To add a setting,** put a comma at the end of the line above it: `"lights": { … },` then `"environment": {}`.
  No comma after the last line.
- Every key and what it does: section 16.
- Motion (looping clips, props on a path, a battle outside the window, a room that travels, a music-reactive sky):
  [Moving rooms](MOVING_ROOMS.md#for-creators-and-ais).
- Fix a room without re-exporting: `spotOverrides` (move or turn a place), `cameraOverrides` (add, replace or remove a
  camera), `hideNodes` (hide a broken prop), `soloScreens`.
- **A build script that rewrites scene.json must keep the keys someone added by hand.** Read the old file, change your
  keys, write it back.

---

## 3. Scale, axes and where people stand

### 3.1 Directions

| | Up | Front (toward the cameras) | Units |
|---|---|---|---|
| Blender | +Z | **−Y** | metres |
| The exported file and scene.json (glTF) | +Y | **+Z** | metres |

- Blender's **Front** view (numpad 1) looks into the room from the front. If you can see into your room there, the
  front is right.
- scene.json positions are glTF space. A Blender position (x, y, z) is (x, z, −y) in glTF. A glTF position (x, y, z)
  is (x, −z, y) in Blender. In a script: `def G(x, y, z): return Vector((x, -z, y))` turns glTF into Blender.
- **Turning (yaw):** an empty with Blender **Rotation** Z = 0° faces the front. Positive angles turn it toward +X
  (the right of the picture). A scene.json `yaw` works the same way: 0 faces the front.

A starter room seen from the top in Blender (numpad 7). Up the page is +Y, the back wall:

```text
            +-----------------------------------+
            |        [ SCREEN on the wall ]     |
            |   SPOT_01    SPOT_02    SPOT_03   |  couch: these seats face down the page
            |                                   |
DOOR_OUTSIDE  DOOR  PATH_01                     |
            |          PATH_02    PATH_03       |
            |   SPOT_04               SPOT_05   |  standing places
            +- - - - - - open front - - - - - - +
                          CAM_WIDE                 looks up the page, into the room
```

### 3.2 Sizes that match the avatars

- Floor at height 0. A typical room is 6–10 m wide, 5–8 m deep and 3–3.5 m high.
- Furniture: seats 0.42–0.5 m high, desks 0.75 m, counters 0.9–1.1 m, doors 2.1 m high.
- **Build for 1.5 m people.** Every avatar built 1.3–2.1 m tall is shown at the room's `avatarHeight` (default
  1.5 m) times the host's avatar size setting.
- Faces sit about 1.38 m up when standing, and seat height + 0.75 m when sitting. Keep those heights clear in every
  camera.

### 3.3 Standing and sitting places

- **Standing:** the empty's origin on the floor, where the feet go. Leave about 0.45 m free all round and 1.8 m above.
- **Sitting:** the origin on the floor under the hips. `seatHeight` = the cushion's height above that point.
- Space places at least about 0.62 m apart for seats and 0.9 m for standing.
- Turn every place toward the cameras.
- A place only counts when the body isn't inside furniture and there's something under it. VTube Pro tests a
  body-sized tube: 0.16 m radius standing, 0.13 m sitting.

### 3.4 Cameras

- Cameras look down their local −Z. Build them looking at a target point.
- VTube Pro uses the **vertical** field of view. 35–40° suits most shots. A camera without one counts as 35°.
- In Blender: **Sensor Fit** Vertical, then type the **Field of View** (4.4).

### 3.5 Big outdoor places

Kilometre-scale exteriors: bring far scenery closer and scale it down, and keep haze thin (scene.json
`gfx.haze.density` about 0.0005).

---

## 4. Build it in Blender, step by step

These steps use Blender's own labels. Section 4.12 does all of it in one script.

### 4.1 Set up the file

1. **File** → **New** → **General**.
2. Delete the starting cube, light and camera: hover over the 3D view, press A, then X → **Delete**.
3. **Scene Properties** (the cone and sphere icon) → **Units**: keep **Unit System** Metric and **Unit Scale** 1.000.
4. **Output Properties** (the printer icon) → **Format**: **Resolution X** 1920, **Y** 1080. Your cameras then export with the angle you
   type.
5. Save the `.blend` file in a work folder, like Documents. Not in your scenes folder.

### 4.2 Block out the room

1. Plan first: where the host sits, where guests sit, where the screen hangs, where the cameras stand. Pick 3–5
   landmarks that make the place readable at a glance.
2. Make the floor at height 0. Give walls thickness (about 0.1 m): single-sided planes flicker and leak light.
3. Build walls on three sides. Leave the front (−Y) open, like a TV set. Press numpad 1: you should look straight in.
   The table below is the starter room from 3.1 as clicks. For each piece: **Add** → **Mesh** → **Cube**, press N,
   and type the numbers on the **Item** tab. Then rename it in the Outliner.

| Piece | Dimensions (X, Y, Z) | Location (X, Y, Z) |
|---|---|---|
| Floor | 8, 6, 0.1 | 0, 0, −0.05 |
| Back wall | 8, 0.1, 3.4 | 0, 3.05, 1.7 |
| Right wall | 0.1, 6, 3.4 | 4.05, 0, 1.7 |
| Left wall, in front of the doorway | 0.1, 1, 3.4 | −4.05, −2.5, 1.7 |
| Left wall, behind the doorway | 0.1, 4, 3.4 | −4.05, 1, 1.7 |
| Left wall, above the doorway | 0.1, 1, 1.3 | −4.05, −1.5, 2.75 |
| Ceiling | 8, 6, 0.1 | 0, 0, 3.45 |

The three left-wall pieces leave a **doorway** 1 m wide and 2.1 m tall. Every room with a door needs a hole like this,
or friends walk in through the wall. When the shell is done, select its pieces and press Ctrl+A → **Scale**.

4. Add a ceiling where cameras look up.
5. Put something behind every doorway and window the cameras can see: a hallway floor, a wall, a backdrop. Empty space
   looks broken on camera.
6. Export this grey box (plain shapes, no colours yet) early (4.10) and test it (section 11). Fix walks and views
   before you add detail.

### 4.3 Mark the places (`SPOT_xx`)

1. **Add** → **Empty** → **Arrows**.
2. Rename it `SPOT_01`: double-click its name in the Outliner.
3. Press N for the sidebar. On the **Item** tab, set **Location** X and Y where the person goes, and Z = 0.
4. Set **Rotation** Z: 0° faces the front (the cameras). The person faces **away** from the arrow marked Y: at 0°
   the Y arrow points at the back wall and the person faces the camera. Positive angles turn them toward the right of
   the picture.
5. **Object Properties** (the orange square icon) → **Custom Properties** → **New**. Click the gear icon next to the
   new property. Set **Type**
   to String, **Property Name** to `pose`, and the value to `sit` or `stand`.
6. For a seat, add another: **Type** Float, **Property Name** `seatHeight`, value = the cushion height in metres
   (like 0.45).
7. Optional: `label` (String), like `Couch left`.
8. Next place: **Object** → **Duplicate Objects**, move it, rename it `SPOT_02`. Custom properties come along.
9. Optional, try this last. A seat behind a desk or a bar? First add a `COLLIDE_` box over the desk and test
   (section 11). Only if walkers still clip through, add `approach` (**Type** Float Array, a multiple of 3 numbers)
   and `leavePathAt` (String, like `PATH_02`). Approach points are glTF positions: Blender (x, y, z) becomes
   (x, z, −y). Example: a point at Blender (1, −0.5, 0) is typed as 1, 0, 0.5.

### 4.4 Add the cameras

1. **Add** → **Camera**. Rename it `CAM_WIDE`. The object name is what counts.
2. **Object Data Properties** (the green camera icon): **Lens** → **Lens Unit**: Field of View. Then **Camera** →
   **Sensor Fit**: Vertical. Now set **Field of View** to 35–40°.
3. To aim it, click `CAM_WIDE` in the Outliner first. Then **View** → **Cameras** → **Set Active Object as Camera**.
   In the sidebar, **View** tab → **View Lock**, tick **Camera to View**. Now hold the mouse wheel and drag to turn,
   Shift + wheel-drag to slide, and roll the wheel to move closer: the camera follows. Untick it when you're done.
4. `CAM_WIDE`: from the open front, a little above face height (about 1.6–1.8 m), seeing every place.
5. `CAM_REACT`: square-on to the screen, at the screen's height, about 1.12 × the screen's width away.
6. `CAM_DOOR` and any other presets: `CAM_` plus capital letters, digits or `_`, like `CAM_SOFA`.

### 4.5 Add the React screen

1. **Add** → **Mesh** → **Plane**. Rename it `SCREEN`.
2. Sidebar → **Item**: **Rotation** X 90° (it stands up and faces the front). **Scale** X 1.44 and Y 0.81: that's a
   2.88 × 1.62 m screen, 16:9. Any 16:9 size works.
3. **Object** → **Apply** → **Rotation & Scale**.
4. Move it where it should show in React, like the back wall. Keep its bottom edge above seated heads (about 1.4 m).
5. Custom property `restOffsetY` (Float): how far up it waits when React is off. 2.0 hides it in a 3.4 m ceiling. 0
   keeps it in place.
6. Give it a plain dark material. Don't move, rotate or scale its UVs.

### 4.6 Add the door and the walk-in

1. The **door leaf** is the part that swings. **Add** → **Mesh** → **Cube**, set **Dimensions** 0.05, 1.0, 2.1 and
   put it in the doorway (4.2). Name it `DOOR`.
2. Put its origin on the hinge. Select `DOOR`. Press **Tab** (Edit Mode), then **2** (edge select). Click the tall
   edge on the hinge side. **Shift+S** → **Cursor to Selected**. Press **Tab** again (Object Mode). **Object** →
   **Set Origin** → **Origin to 3D Cursor**.
3. Custom property `openAngle` (Float, degrees). Try it: rotate the door about Z by that angle, check it clears the
   path, then set the rotation back to 0.
4. Add an empty `DOOR_OUTSIDE` just outside the door, turned to face into the room. Door in the left wall:
   **Rotation** Z 90°. In the right wall: −90°. In the back wall: 0°.
5. Add empties `PATH_01`, `PATH_02` … on the floor, from the doorway toward the middle of the room. 2–4 of them,
   about 1.5–2 m apart, are plenty.
6. Model a little floor and wall behind the door (a hallway). The door camera and the walk-in see it.

### 4.7 Furniture, colliders and detail

1. Furniture heights: seats 0.42–0.5 m, desks 0.75 m, counters 0.9–1.1 m.
2. **Colliders:** walkers must go around big furniture. Add a box (**Add** → **Mesh** → **Cube**), scale it over the
   furniture and name it `COLLIDE_Couch`. It must stand on the floor. VTube Pro hides it.
3. Make colliders easy to live with in Blender: **Object Properties** → **Viewport Display** → **Display As**: Wire,
   and **Visibility** → untick **Renders** (keeps them out of bakes and pictures).
4. Detail pass, within budget (section 9). Free furniture: download a CC0 kit (section 13). In Blender:
   **File** → **Import** → **glTF 2.0** (or **FBX**), then move and scale it into place. Restyle props to the room's
   colours. Keep it light: share one texture picture between many props when you can.
5. Lessons from real rooms:
   - A prop poking into a two-shot, or a tall booth hiding short performers: check every camera to every face.
   - A doorway opening onto nothing: model floor and walls beyond every opening the cameras can see.
   - Places in shadow: never bake a dark patch over a seat. Keep lamps from darkening faces.

### 4.8 Lamps and glow

1. **Glowing material:** select the object → **Material** tab (the red ball) → **New**. Double-click the name at
   the top and type `EMIT_neon` (`EMIT_` plus a group name, like `EMIT_lamps`). Scroll to **Emission**: set
   **Color** to the glow colour and **Strength** to about 3. Set **Base Color** to almost black, in the same colour
   family.
2. **The lamp object:** name it `LIGHT_<anything>`, like `LIGHT_LAMP_01`. Custom properties (all String): `group`
   (the same group as its material: `lamps`), `color` (like `#ffd9a0`) and `kind`:
   - `emissive`: it only glows;
   - `point`: it also lights people around it, like a bulb;
   - `spot`: a cone of light, like a stage spot.
3. `point` and `spot` lamps become real lights, a few per room. On stream VTube Pro uses up to 3; the studio's
   preview uses 2 (5.1). Bake the lamp's pool of light too (4.9), so the room looks right everywhere.
4. Don't export Blender lights: keep **Punctual Lights** off when you export.
5. Group names decide what the light show does (5.5). Pick them with care.

### 4.9 Bake the light

VTube Pro multiplies each surface's colour by its baked vertex colour (`COLOR_0`). Here's how to bake one in Blender.

1. **Add bake lights.** Use normal Blender lights (Sun, Area, Point) and a sky colour (**World Properties** →
   **Color** and **Strength**). They light the bake only: they don't export while **Punctual Lights** is off.
2. **Give surfaces enough points.** A vertex bake stores one colour per corner. A big floor made of 2 triangles can't
   hold a pool of light. In Edit Mode, **Edge** → **Subdivide** big faces until there's a point about every 0.3 m.
3. **Add a colour layer** to each mesh you bake: **Object Data Properties** (green triangle) → **Color Attributes** →
   **+**. Name `Col`, **Domain** Face Corner, **Data Type** Color.
4. **Render Properties** → **Render Engine**: Cycles. Then **Render Properties** → **Sampling** → **Render** →
   **Max Samples**: 64. (The default, 4096, makes the bake take a very long time.) No GPU setting is needed.
5. **Bake** panel: **Bake Type** Diffuse. Under **Contributions** tick **Direct** and **Indirect**, untick **Color**
   (you bake the light, not the paint). **Output** → **Target**: **Active Color Attribute**.
6. Select the meshes to bake. Leave out `EMIT_` glow, glass, the `SCREEN`, `COLLIDE_` boxes and hidden floors. Press
   **Bake**. Baking takes 1–5 minutes. The progress bar is at the bottom of the window. Blender may stop responding:
   wait. To see the result: at the top right of the 3D view, click the small arrow next to the shading balls, pick
   **Solid**, then **Color** → **Attribute**.
7. Too dark or too bright? Change the bake lights and bake again. Keep the places bright.
8. Export with **Use Vertex Color**: Active (4.10).

A light baked into textures works too (5.2).

### 4.10 Export `scene.glb`

First make the room folder: inside your scenes folder (1.2), make a folder named like `my_room`. Keep your
`.blend` file somewhere else, like Documents.

**File** → **Export** → **glTF 2.0 (.glb/.gltf)**. Set these, then save as `scene.glb` in that room folder:

| Where in the export window | Setting | Set it to |
|---|---|---|
| Top | **Format** | glTF Binary (.glb) |
| Top | **Remember Export Settings** | on, so Blender keeps these for this file |
| **Include** → Limit to | **Selected Objects**, **Visible Objects**, **Renderable Objects**, **Active Collection** | off, so everything exports. With them on, hidden colliders and empties can be left out. |
| **Include** → Data | **Custom Properties** | **on** (it's off at first) |
| **Include** → Data | **Cameras** | **on** (it's off at first) |
| **Include** → Data | **Punctual Lights** | off |
| **Transform** | **+Y Up** | on |
| **Data** → **Mesh** | **Apply Modifiers** | **on** (it's off at first) |
| **Data** → **Mesh** → **Vertex Colors** | **Use Vertex Color** | Active, if you baked into vertex colours (it starts on Material) |
| **Data** → **Mesh** → **Vertex Colors** | **Export All Vertex Colors** | off |
| **Data** → **Material** | **Images** | Automatic, or JPEG Format (.jpg) to make big colour textures smaller |
| **Data** → **Compression** | the tick box | off: no Draco compression |
| **Animation** | the tick box | off, unless your room has looping animation (section 8) |

These labels are Blender 5.1's. Older versions use the same names in slightly different places.

### 4.11 Add scene.json and the pictures

1. Use the room folder you exported into (4.10), like `my_room`.
2. Make `scene.json` in a plain text editor. Paste the example from 2.7 and change the name. Save it as
   `scene.json`, not `scene.json.txt`:
   - **Windows:** in Notepad, **File** → **Save As**. Set **Save as type** to **All files** (`*.*`) and type
     `scene.json`. To check it: File Explorer → **View** → **Show** → tick **File name extensions**.
   - **Mac:** in TextEdit, first open **Settings** and untick **Smart quotes** (curly quotes break the file). Use
     **Format** → **Make Plain Text**. When saving, untick "If no extension is provided, use .txt".
3. **Pictures:** select `CAM_WIDE`, then **View** → **Cameras** → **Set Active Object as Camera**. Set the resolution
   to 1280 × 720 and press **Render** → **Render Image**. In the render window: **Image** → **Save As**, name it
   `preview.png`. Do it again at 480 × 270 for `thumb.png`. A cropped 16:9 screenshot of the room in VTube Pro works
   too.
4. Test it: section 11.

### 4.12 The same room as one script

This script builds the whole starter room from the plan in 3.1: walls with an open front, a door and a walk-in path, a
couch with 3 seats, 2 standing places, a React screen, a neon strip, a floor lamp, 3 cameras, a vertex-colour bake,
both pictures and `scene.json`. We ran it in Blender 5.1 (without a window). The room check said **Ready to use**:
5 places, 3 cameras, the light baked in, 9,694 triangles, 16 draw calls, 0.5 MB.

How to run it:

1. In Blender: **File** → **New** → **General**. Don't run it in a file with work you want to keep: the script deletes
   every object in the open file.
2. Open the **Scripting** tab at the top. Press **New**. Paste the whole script into the big text area.
3. Change `ROOM_ID` and `ROOM_NAME` at the top for each new room (the same id overwrites the same room).
4. Press **Run Script** (▶). It takes a few minutes: the bake is the slow part, and Blender may stop responding
   while it bakes. Wait.
5. A message says where it saved the room: straight into your scenes folder. In VTube Pro press **Room** →
   **↻ Rescan** (next to **Change room**).

**Advanced, optional: skip this if you don't use a terminal.** Without a Blender window, save the script as
`build_my_room.py` and run `blender -b --factory-startup --python build_my_room.py -- --out <room folder>`. The last
part of `<room folder>` is the room id.

```python
"""VTube Pro starter room: built, lit and exported by one Blender script (tested with Blender 5.1).

It makes an 8 x 6 m room with an open front, a door and a walk-in path, a couch with 3 seats, 2 standing places,
a React screen, a neon strip, a floor lamp and 3 cameras. It writes scene.glb, scene.json, preview.png and
thumb.png into a room folder that VTube Pro can use straight away.

Run it in Blender:
  1. File > New > General. (This script deletes every object in the open file.)
  2. Scripting tab > New > paste this script > Run Script (the play button). It takes a few minutes (the bake).
  3. A message says where the room was saved. In VTube Pro: Room > Rescan.
Without a window:  blender -b --factory-startup --python build_my_room.py -- --out <room folder>
"""
import json
import math
import os
import re
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOM_ID = 'my_first_room'     # the folder name: lowercase letters, digits, _ or -
ROOM_NAME = 'My First Room'   # the name on the room card
OUT_DIR = ''                  # '' = straight into your VTube Pro scenes folder
BAKE = True                   # bake soft light into vertex colours (Cycles)
PICTURES = True               # render preview.png (1280x720) + thumb.png (480x270) from CAM_WIDE (needs BAKE)


def rooms_folder():
    """The per-user rooms folder. In a copy run from a downloaded folder, rooms live in `assets/scenes` of that
    folder instead: set OUT_DIR to `<your VTube Pro folder>/assets/scenes/<room id>`."""
    if sys.platform == 'win32':
        base = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~/AppData/Roaming'), 'VTube Pro')
    elif sys.platform == 'darwin':
        base = os.path.expanduser('~/Library/Application Support/VTube Pro')
    else:
        base = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'vtube-pro')
    return os.path.join(base, 'scenes')


if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,47}', ROOM_ID):
    raise ValueError('ROOM_ID: use lowercase letters, digits, _ or - (48 at most), starting with a letter or digit')
ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = ARGV[ARGV.index('--out') + 1] if '--out' in ARGV else OUT_DIR
ROOM = os.path.abspath(OUT or os.path.join(rooms_folder(), ROOM_ID))
os.makedirs(ROOM, exist_ok=True)

# ---- start clean: metres, 16:9 (camera angles then export the way VTube Pro reads them)
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
scn = bpy.context.scene
scn.unit_settings.system = 'METRIC'
scn.unit_settings.scale_length = 1.0
scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = 1920, 1080, 100


def srgb(h):
    """'#rrggbb' -> linear RGB. glTF colour factors (and Principled BSDF colour sockets) are linear."""
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def mat(name, hex_, rough=0.8, emit=None, strength=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if bpy.app.version < (5, 0, 0):
        m.use_nodes = True                      # (Blender 5 materials always have nodes)
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*srgb(hex_), 1)
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*srgb(emit), 1)
        b.inputs['Emission Strength'].default_value = strength
    m.diffuse_color = (*srgb(hex_), 1)
    return m


def link(ob):
    scn.collection.objects.link(ob)
    return ob


def box(name, center, size, material, step=0.0):
    """A box in Blender metres. step > 0 cuts its faces into a grid (about step x step m) so a bake has detail."""
    sx, sy, sz = size
    bm = bmesh.new()
    X, Y, Z = Vector((sx, 0, 0)), Vector((0, sy, 0)), Vector((0, 0, sz))
    lo = Vector((-sx / 2, -sy / 2, -sz / 2))
    for origin, u, v in ((lo + X, Y, Z), (lo, Z, Y), (lo + Y, Z, X), (lo, X, Z), (lo + Z, X, Y), (lo, Y, X)):
        nu = max(1, round(u.length / step)) if step > 0 else 1
        nv = max(1, round(v.length / step)) if step > 0 else 1
        g = [[bm.verts.new(origin + u * (i / nu) + v * (j / nv)) for j in range(nv + 1)] for i in range(nu + 1)]
        for i in range(nu):
            for j in range(nv):
                bm.faces.new((g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    ob = link(bpy.data.objects.new(name, me))
    ob.location = center
    return ob


def empty(name, loc, yaw_deg=0.0, **props):
    """A marker. yaw 0 = faces the open front (Blender -Y); positive = turned toward +X. props become glTF extras."""
    ob = link(bpy.data.objects.new(name, None))
    ob.empty_display_type = 'ARROWS'
    ob.location = loc
    ob.rotation_euler = (0, 0, math.radians(yaw_deg))
    for k, v in props.items():
        ob[k] = v
    return ob


def camera(name, loc, target, fov_deg=35.0):
    """A camera looking from loc at target. VTube Pro reads the vertical field of view."""
    cd = bpy.data.cameras.new(name)
    cd.sensor_fit = 'VERTICAL'
    cd.angle_y = math.radians(fov_deg)
    cd.clip_start, cd.clip_end = 0.05, 100
    ob = link(bpy.data.objects.new(name, cd))
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return ob


# ---- the shell: 8 x 6 x 3.4 m, walls with thickness, front (Blender -Y) open for the cameras, door in the left wall
W, D, H = 8.0, 6.0, 3.4
X0, X1, YB, YF = -W / 2, W / 2, D / 2, -D / 2
wall, floor = mat('M_Wall', '#7d8b99'), mat('M_Floor', '#8a6b4e', 0.6)
shell = [
    box('Floor', (0, 0, -0.05), (W, D, 0.1), floor, 0.3),
    box('Ceiling', (0, 0, H + 0.05), (W, D, 0.1), mat('M_Ceiling', '#a7afb8'), 0.3),
    box('WallBack', (0, YB + 0.05, H / 2), (W, 0.1, H), wall, 0.3),
    box('WallRight', (X1 + 0.05, 0, H / 2), (0.1, D, H), wall, 0.3),
]
DY, DW, DH = -1.5, 1.0, 2.1                      # doorway centre (Blender y), width, height
lo, hi = DY - DW / 2, DY + DW / 2
shell += [
    box('WallLeftFront', (X0 - 0.05, (YF + lo) / 2, H / 2), (0.1, lo - YF, H), wall, 0.3),
    box('WallLeftBack', (X0 - 0.05, (hi + YB) / 2, H / 2), (0.1, YB - hi, H), wall, 0.3),
    box('WallLeftTop', (X0 - 0.05, DY, (DH + H) / 2), (0.1, DW, H - DH), wall, 0.3),
    box('Hallway', (X0 - 1.0, DY, -0.05), (2.0, 1.6, 0.1), floor, 0.3),   # floor outside the door: no void
]

# ---- DOOR: origin on the hinge; the leaf turns about its local Z (glTF +Y)
door = box('DOOR', (0, 0, 0), (0.05, DW, DH), mat('M_Door', '#7a4a2a'), 0.25)
door.data.transform(Matrix.Translation((0, -DW / 2, DH / 2)))
shell.append(door)
door.location = (X0 - 0.05, hi, 0)
door['openAngle'] = 95.0
empty('DOOR_OUTSIDE', (X0 - 1.2, DY, 0), yaw_deg=90)                    # just outside, facing into the room (+X)
empty('PATH_01', (X0 + 0.7, DY, 0))
empty('PATH_02', (-1.5, -0.4, 0))
empty('PATH_03', (0, -0.2, 0))

# ---- couch (seat 0.45 m) against the back wall + its 3 seats; 2 standing places in front
couch = mat('M_Couch', '#3f7f5a', 0.9)
CY = 2.3
shell += [
    box('CouchBase', (0, CY + 0.05, 0.2), (3.3, 0.9, 0.4), couch, 0.15),
    box('CouchBack', (0, CY + 0.45, 0.72), (3.3, 0.22, 0.65), couch, 0.15),
]
col = box('COLLIDE_Couch', (0, CY + 0.05, 0.3), (3.3, 0.9, 0.6), couch)  # hidden by VTube Pro: walkers go round it
col.display_type, col.hide_render = 'WIRE', True                    # (and kept out of the bake and the pictures)
for i, x in enumerate((-1.0, 0.0, 1.0)):
    empty(f'SPOT_{i + 1:02d}', (x, CY - 0.05, 0), pose='sit', seatHeight=0.45, seatDepth=0.55,
          label=['Couch left', 'Couch middle', 'Couch right'][i])
empty('SPOT_04', (-1.3, -1.25, 0), yaw_deg=12, pose='stand', label='Stand left')
empty('SPOT_05', (1.3, -1.25, 0), yaw_deg=-12, pose='stand', label='Stand right')

# ---- React SCREEN: a 16:9 plane on the back wall, facing the front, UVs 0..1; it rests 2 m higher (in the ceiling)
SW, SH, SZ = 2.88, 1.62, 2.35
bm = bmesh.new()
uv = bm.loops.layers.uv.new('UVMap')
vs = [bm.verts.new((x * SW / 2, 0, z * SH / 2)) for x, z in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
f = bm.faces.new(vs)
for loop, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
    loop[uv].uv = (u, v)
me = bpy.data.meshes.new('SCREEN')
bm.to_mesh(me)
bm.free()
me.materials.append(mat('M_ScreenSurface', '#050505', 0.3))
scr = link(bpy.data.objects.new('SCREEN', me))
scr.location = (0, YB - 0.04, SZ)
scr['restOffsetY'] = 2.0

# ---- lights: a neon strip (glow only) and a floor lamp (a real point light in VTube Pro)
neon = box('LIGHT_NEON_01', (0, YB - 0.03, H - 0.12), (6.0, 0.04, 0.04),
           mat('EMIT_neon', '#0a2a16', 0.4, emit='#39ff88', strength=3.0))
neon['group'], neon['color'], neon['kind'] = 'neon', '#39ff88', 'emissive'
box('LampPole', (3.4, 1.8, 0.75), (0.05, 0.05, 1.5), mat('M_Metal', '#2b2b2b', 0.4))
shade = box('LIGHT_LAMP_01', (3.4, 1.8, 1.6), (0.35, 0.35, 0.3),
            mat('EMIT_lamps', '#2a2216', emit='#ffd9a0', strength=2.5))
shade['group'], shade['color'], shade['kind'], shade['range'] = 'lamps', '#ffd9a0', 'point', 6.0

# ---- cameras (they look down their local -Z). CAM_REACT frames the screen at ~80 % width: distance ~1.12 x width
camera('CAM_WIDE', (0, -6.2, 1.75), (0, 0.6, 1.0), 38)
camera('CAM_REACT', (0, YB - 0.04 - 1.12 * SW, SZ), (0, YB, SZ), 35)
camera('CAM_DOOR', (X0 + 2.5, -3.2, 1.7), (X0, DY, 1.2), 40)


# ---- optional: bake soft light into vertex colours (COLOR_0). VTube Pro turns room shadows off, so bake them in.
def bake(meshes):
    scn.render.engine = 'CYCLES'
    scn.cycles.device = 'CPU'
    scn.cycles.samples = 64
    world = bpy.data.worlds.new('BakeSky')
    if bpy.app.version < (5, 0, 0):
        world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (*srgb('#cfd8e6'), 1)
    bg.inputs['Strength'].default_value = 1.4
    scn.world = world
    temp = []
    sun = bpy.data.lights.new('BakeSun', 'SUN')
    sun.energy = 1.5
    temp.append(link(bpy.data.objects.new('BakeSun', sun)))
    temp[-1].rotation_euler = (math.radians(60), 0, math.radians(25))   # shines in through the open front
    fill = bpy.data.lights.new('BakeFill', 'AREA')                     # a soft key over the open front: bright seats
    fill.energy, fill.size = 400.0, 5.0
    temp.append(link(bpy.data.objects.new('BakeFill', fill)))
    temp[-1].location, temp[-1].rotation_euler = (0, -2.4, 3.1), (math.radians(60), 0, 0)
    lamp = bpy.data.lights.new('BakeLamp', 'POINT')
    lamp.energy, lamp.color = 120.0, srgb('#ffd9a0')
    temp.append(link(bpy.data.objects.new('BakeLamp', lamp)))
    temp[-1].location = (3.4, 1.8, 1.45)
    for ob in meshes:
        ca = ob.data.color_attributes
        a = ca.get('Col') or ca.new('Col', 'FLOAT_COLOR', 'CORNER')
        ca.active_color = a
        ca.render_color_index = ca.active_color_index          # the one the glTF exporter writes as COLOR_0
    bpy.ops.object.select_all(action='DESELECT')
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    scn.cycles.bake_type = 'DIFFUSE'
    rb = scn.render.bake
    rb.use_pass_direct, rb.use_pass_indirect, rb.use_pass_color = True, True, False   # light only, not the colour
    rb.target = 'VERTEX_COLORS'
    bpy.ops.object.bake(type='DIFFUSE')
    return temp


temp_lights = bake(shell) if BAKE else []

# ---- optional: the card pictures, rendered from CAM_WIDE with the bake lights
if PICTURES and BAKE:
    scn.cycles.samples = 24
    scn.camera = bpy.data.objects['CAM_WIDE']
    scn.render.resolution_x, scn.render.resolution_y = 1280, 720
    scn.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=False)
    preview = os.path.join(ROOM, 'preview.png')
    bpy.data.images['Render Result'].save_render(preview)
    img = bpy.data.images.load(preview)
    img.scale(480, 270)
    img.filepath_raw = os.path.join(ROOM, 'thumb.png')
    img.file_format = 'PNG'
    img.save()
    scn.render.resolution_x, scn.render.resolution_y = 1920, 1080

for ob in temp_lights:                                          # bake lights never go into the room file
    bpy.data.objects.remove(ob, do_unlink=True)

# ---- export: the settings VTube Pro needs (unknown options are skipped, so older Blenders work too)
kw = dict(filepath=os.path.join(ROOM, 'scene.glb'), export_format='GLB', export_yup=True, export_apply=True,
          export_extras=True, export_cameras=True, export_lights=False, export_materials='EXPORT',
          export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_animations=False,
          export_draco_mesh_compression_enable=False, use_selection=False)
ok = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in ok or k == 'filepath'})

# ---- scene.json: keeps every key you added by hand, fills in the rest
sj = os.path.join(ROOM, 'scene.json')
try:
    with open(sj, encoding='utf-8') as fh:
        info = json.load(fh)
except (OSError, ValueError):
    info = {}
info.update({'name': info.get('name') or ROOM_NAME, 'model': 'scene.glb'})
info.setdefault('modes', ['talk', 'react'])
info.setdefault('defaultCamera', 'CAM_WIDE')
info.setdefault('avatarHeight', 1.5)
info.setdefault('ambience', {'exposure': 1.0})
info.setdefault('lights', {'groups': {'neon': '#39ff88', 'lamps': '#ffd9a0'}})
with open(sj, 'w', encoding='utf-8') as fh:
    json.dump(info, fh, indent=2)

msg = f'Room saved in {ROOM}. In VTube Pro: Room > Rescan.'
print('ROOM_OK', ROOM)
if not bpy.app.background:
    bpy.context.window_manager.popup_menu(lambda self, _c: self.layout.label(text=msg), title='VTube Pro room')
```

Make it yours: change the sizes, move the `SPOT_` empties, swap the boxes for your own models. Keep the anchors, the
bake and the export step as they are.

---

## 5. Light: baked light, `LIGHT_` and `EMIT_`

### 5.1 Why bake

- Room shadows are always off.
- Real lights from `LIGHT_*` are few, at any **Graphics quality**. On stream (the OBS page) VTube Pro lights people
  with up to 3 of your lamps. The studio's preview uses 2.
- Low and Medium have no post effects (no bloom, no ambient occlusion).

So the room's look must live in its colours: soft light from the sky or windows, a key light, light spill and the
pools under lamps. **Low and Medium must look finished.** Bloom and ambient occlusion on High and Ultra are a bonus.

### 5.2 Vertex colours or textures

- **Vertex colours (`COLOR_0`).** VTube Pro multiplies each surface's colour by them. Cheap and easy to change. Big
  faces need enough points (about every 0.3 m). Steps: 4.9.
- **Light baked into textures.** Unwrap the meshes with no overlaps (**UV** → **Smart UV Project**). In each
  material, add an Image Texture node with a new image (like 2048 × 2048) and keep that node selected. Bake with
  **Bake Type** Combined and **Target** Image Textures. Then use that image as the **Base Color**: it now holds paint
  and light together.
- The room check counts a room as lit when it has `COLOR_0`, `LIGHT_*` objects or `EMIT_` materials. A texture bake
  alone shows "No lighting is baked into this room", even though it looks fine.
- **Night bake (optional):** a second colour layer exported as `COLOR_1`, with the material custom property
  `nightBake` = true. In rooms with time of day (section 6) the room fades from the day bake to the night bake as it
  gets dark. The Hangout has both. To export both layers: keep the day bake as the first colour layer and the night
  bake as the second, and in the export tick **Export All Vertex Colors** (or set **Use Vertex Color** to **Name** with
  the day layer's name). This differs from the plain-room settings in 4.10, which export the active layer only.
- **Mood:** mid-dark walls with warm pools of light flatter toon avatars. To brighten or darken the whole room, change
  scene.json `ambience.exposure`, not the bake. It never touches the performers or `EMIT_` glow.

### 5.3 Materials and textures

- Use Principled BSDF materials. Glow materials must be Principled BSDF.
- Colour textures: 2048 × 2048 atlases, 1024 × 1024 tiling textures, JPEG for colour maps. Keep each texture at
  2048 × 2048 or less.
- Image textures are sRGB. Typed colours are linear (5.7).
- Metal: **Metallic** 0.3–0.4 only on real metal, 0 everywhere else.
- **Glass:** set the Principled BSDF **Alpha** to about 0.35. It exports see-through.
- **Cut-outs** (sign letters, leaves): run the texture's alpha through a Math node set to **Round** into **Alpha**. It
  exports as a clean cut-out.
- No Draco and no KTX2 compression. VTube Pro can't open them; Blender has to unpack them first.
- Sky meshes: name their material `M_Sky…`, `GFX_SKY…` or `SKY_…` (section 6).

### 5.4 Lamps and glow fixtures

- Mark every lamp, neon strip and sign as a `LIGHT_*` object with `group`, `color` and `kind` (2.3).
- Real lights go to `spot` lamps first, then the strongest `point` lamps (`intensity` × `range`), up to the limit
  (3 on stream, 2 in the studio's preview; see 5.1). A spot points at its `target` [x, y, z] (glTF), else along its −Z.
- Give every glowing mesh a material named `EMIT_<group>`. The light engine changes its colour and brightness per
  group. The lighting states dim or boost it.
- Never export Blender lights. VTube Pro builds the few real lights it needs from your `LIGHT_*` objects.

### 5.5 Lighting states: how your room reacts

The host switches lighting states with the **Lighting** buttons (Simple), **Room** → **Lighting states** (Advanced)
or Shift+1 … Shift+5. Every room gets them for free:

| State | Keys | What happens to your room |
|---|---|---|
| Preshow | Shift+1 | House lights almost off. A full club show: beams, lasers and a mirror ball, on the music (or a built-in show). |
| Show | Shift+2 | Your room as you made it. Glow follows the **Lights** settings, and the music only if **Beat reactive** is on. |
| React | Shift+3 | House lights at 60 %, so the screen stands out. |
| BRB | Shift+4 | Dim (30 %), slow breathing lights, soft drifting spots. |
| Outro | Shift+5 | An afterparty: like Preshow, warmer and slower. |

"House lights" means every material that isn't `EMIT_` (the `SCREEN` excepted). House level 0 is a moody 16 %, never
black. Practical lamps stay on when the house goes down. By group name: lamp, bulb or practical 60 %, lava 70 %,
sign 55 %, string or fairy 55 %, on air 30 %, aqua, tank or water 45 %, firefly, star or spark 50 %.

**Make your room react, step by step:**

1. Name every glowing material `EMIT_<group>`, with a group name from the table below.
2. Mark lamps with `LIGHT_*`. Use `kind` = `point` or `spot` for the few that should light people.
3. List your groups and their colours in scene.json `lights.groups`. The **Lights** panel then shows each group with
   its colour swatch. (The real colour still comes from the lamp and the material.)
4. Optional: hang beams, lasers and a mirror ball where you want them (5.6).
5. Test it: switch through Shift+1 … Shift+5. Turn on **Beat reactive** and play music.

What each group does in the default **Room show**. The first match in this order wins, so `neon_sign` pulses like a
sign:

| The group name contains | Program |
|---|---|
| `sign` | Pulse on kick |
| `neon` | Breathe |
| `spot` | Chase |
| `firefl`, `star`, `spark`, `glow` | Drift |
| `on_air`, `onair`, `rec` | Steady |
| `accent`, `rgb`, `strip` | Colour cycle on bar |
| `board`, `led`, `panel`, `monitor` | Strobe on snare/hat |
| `lava` | Breathe (slow) |
| `aqua`, `tank`, `water` | Breathe |
| `lamp`, `practical`, `string`, `fairy` | Drop mode |
| anything else | Pulse on kick |

- The host can change any group's program, level, speed and colour in **Lights**, and pick another **SHOW preset**:
  Room show (default), All steady, Mellow glow, On air, Beat pulse, Strobe, Party, Banger (club), BRB (slow breathe),
  Afterparty.
- scene.json `lights.programs` only adds names that aren't built in, shown as "name (room)"; they play the Room show.
  Listing built-in presets there does nothing.
- An `onair` group is the ON AIR sign: Preshow → Show "slams it on".
- Scripts and Stream Deck switch states through VTube Pro's local server: `POST /api/scene/lighting` with `{"state": "brb"}`.

### 5.6 Beams, lasers and the mirror ball

The Preshow and Outro club show uses moving-head beams, laser fans and a mirror ball. VTube Pro places them:

1. at your empties `FX_BEAM_xx`, `FX_LASER_xx` and `FX_BALL` (beams aim themselves with built-in sweeps);
2. else at scene.json `lightRig` points: `{"beams": [[x, y, z], …], "lasers": [[x, y, z], …], "ball": [x, y, z]}`;
3. else on an automatic grid under the ceiling.

On stream there are 6 beams; the studio's preview shows 4. Beams fade where they would cross a performer's face.
Hang them high, at the back and sides.

### 5.7 Colours are linear

glTF colour factors are linear. A script that types an sRGB hex colour straight into a Principled BSDF socket gets
colours that are too light. Convert first:

```python
def srgb(h):  # '#rrggbb' -> linear RGB for glTF colour factors and Principled BSDF sockets
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)
```

Typing a hex code into Blender's colour picker converts it for you. Image textures stay sRGB.

---

## 6. Day / night and weather

Any room can follow a clock and the weather. Add `"environment": {}` to scene.json: you get a sky with sensible
defaults. The room card then says "Time of day & weather", and the host sets it in **Time & weather**. The sky, sun,
moon, room light, fog, rain, wet ground, wind and lightning follow, and night lights switch on.

- **Weathers:** Clear, Cloudy, Overcast, Light rain, Heavy rain, Storm and Fog (ids `clear`, `cloudy`, `overcast`,
  `rain`, `heavyrain`, `storm`, `fog`). There's no snow.
- **Two ways to light it.** Bake the room neutral (sky light and soft shadows, no sun) and let VTube Pro add the sun.
  Or bake at one time of day and set `"bakedAt": 17.5, "sun": 0`: that moment then looks exactly as you made it, and
  other times are relative to it.
- **Night lights** switch on at dusk. Groups named like lantern, lamp, street, window, brazier, torch, candle,
  campfire, fire pit, porch, neon sign, string light or fairy do it on their own (unless you list `nightLights`). Or
  set `nightOn` = true on a `LIGHT_*` object or an `EMIT_` material. By day they're off, unless you give them a `day`
  level in `nightLights`. Lit lamps throw pools of light: 0 on Low, 4 on Medium, 8 on High, 12 on Ultra.
- **Night bake:** `COLOR_1` plus `nightBake` (5.2).
- **City windows:** an `EMIT_<group>` facade material listed under `windows` lights window by window.
- **Sky:** with no sky mesh, VTube Pro draws its own. Your own sky meshes use materials named `M_Sky…`, `GFX_SKY…` or
  `SKY_…`; set `"sky": "room"` to use only yours.
- **Wind:** materials named like foliage, leaf, grass, fern, palm, bush, vine or ivy sway, and so do cloth, flag,
  banner, tarp, canvas, curtain, awning or sail. Put each mesh's origin at its base or pole side.
- **Rain** falls everywhere except inside `ENV_DRY_*` objects and scene.json `dry` boxes.
- All the keys: section 16 (`environment`). Test a time and weather on the test page with `&env=h19.2,storm`
  (11.1).

---

## 7. Screen skins

The solo React screen, the chat monitor and the support board wear the room's skin:
`"screenSkin": "studio"` (or `scrying`, `hologram`, `terragroup`, `tarp`, `bedsheet`). Or an object with `theme`,
`node`, `motion` (`drop`, `rise`, `unroll`, `swing`, `hologram`, `shimmer`), `powerOn` (`crt`, `hologram`,
`shimmer`, `fade`) and per-prop `solo` / `monitor` / `board`.

**Your own housing:** an object named `SOLO_SKIN`, `CHAT_MONITOR_SKIN` or `CHAT_BOARD_SKIN` (or any `*_SKIN` named in
`screenSkin.node`). VTube Pro hides it and copies it for each screen. Origin = the centre of the picture, +Z faces the
viewer. A child `*_RECT` mesh gives the picture's width (or the custom property `screenWidth`). Children named
`*_FIXED` stay put while the rest moves. Keep geometry in front of z = 0 outside the picture: the picture is drawn at
z = +0.012 and is never covered.

---

## 8. Optional engines and their anchors

Each engine is opt-in and costs nothing while it's off. **The rule for all of them: never in front of the show.**
Effects stay behind the performers, dim over faces and never cover the React screen.

| Engine | Turn it on with | What your room adds |
|---|---|---|
| **Interview (talk show)** | scene.json `interview`: `host`, `guests`, `desk`, `monitor`, `cutaways` (all optional) | Nothing else: VTube Pro places the desk, the guest monitor and the sidekick from the host's chair. VTube Pro Studio's scene.json has one (section 12). |
| **Celebrations** (supporter events) | scene.json `lounge` (per area too) | `EVT_*` empties. Bar: `EVT_COUNTER_START`, `EVT_COUNTER_END`, `EVT_SHOT_xx`, `EVT_POUR`, `BARTENDER`, `EVT_BOTTLEWALL`. Patio: `EVT_FIREPIT`, `EVT_SKY_xx`, `EVT_SPARKLER_xx`. Lounge: `EVT_CONFETTI_xx`, `EVT_BALLOON_NET`, `EVT_CHAMPAGNE`, `EVT_TV`, `EVT_KEEPOUT_xx`. The Hangout uses them. |
| **Room animation** | glTF animations in `scene.glb` (export with **Animation** on) | Loops forever on a shared clock, so the studio, OBS and guests all match. Make seamless loops. Moving objects and shape keys work. Don't animate `DOOR`, `SPOT_` or `CAM_` objects. |
| **Background combat** | `raid` | `BG_NAV_xx` (`links`), `BG_COVER_xx` (+Z faces the threat; `stance`), `BG_LOOT_xx`, `BG_SPAWN_xx`, `BG_EXIT_xx`, `BG_ZONE_xx`, `PATROL_PATH_xx`, `CAM_RAID_xx`, `SMASH_xx`. Keep every `BG_` point behind the performers. |
| **Warzone** (a battle outside) | `warzone` with `raid` | `WZ_ROAD_xx`, `WZ_IMPACT_xx`, `WZ_FIRE_xx`, `WZ_SKY_xx`, `WZ_FAR_xx`, `WZ_KEEPOUT_xx` and more (missing ones come from the `BG_` anchors). |
| **Space** | `space`, plus `"entrance": "cryo"` and `"exit": "droppod"` | `SPACE_VIEW`, `SPACE_PLANET`, `SPACE_SHIP_xx`, `CRYO_POD_xx`, `DROP_POD_xx`, `CAM_CRYO`, `CAM_DROPBAY`; `EMIT_alert` / `EMIT_alarm` pulse on red alert. |
| **Club**, **Town**, **Yacht life**, **Sky traffic**, **Era shifts**, **Tabletop** | `club`, `town`, `yacht`, `traffic`, `eras`, `ttrpg` | Their own named anchors. These run VTube Pro's own themed rooms; their full anchor lists aren't in a public guide yet. |

---

## 9. Performance budgets

The performer's face tracker runs on the same graphics card as the room. Every bit your room costs comes out of
tracking quality. VTube Pro's default is the **Medium** level, aimed at a GTX 1080 / RTX 3060 / RX 6600 class card.

| | Recommended | What the room check says above it |
|---|---|---|
| Visible triangles (not `COLLIDE_` or hidden `FLOOR_`; every LOD level counts) | **80,000** or less | "a bit heavy, but it should run fine on most PCs". Above 300,000: "may slow down your face tracking". |
| `scene.glb` file size | **25 MB** or less | the same. Above 120 MB: "may slow down your face tracking". **＋ Add my room** takes 300 MB at most. |
| Draw calls (one per mesh part per material) | **180** or less | "a bit heavy". |
| Textures | 2048 × 2048 or less each | not checked inside a `.glb`. |

The 80,000-triangle and 25 MB numbers are hard limits only for a room an AI sends as a creation package. For a room
you add yourself, they're the line between "light" and "a bit heavy".

**What each graphics level does to your room** (**Room** → **Graphics quality**):

| | Low | Medium (default) | High | Ultra |
|---|---|---|---|---|
| Night-light pools | 0 | 4 | 8 | 12 |
| Lone `*_LOD0` detail | hidden | by size | by size | by size |
| LOD bias | ×0.6 | ×1 | ×1.35 | ×1.8 |
| Post effects (bloom, ambient occlusion, colour grade, HDRI room light, haze, depth of field) | none | none | on | on, plus light shafts and glossy-floor reflections |

**Not set by Graphics quality:** real lights from `LIGHT_*` spot / point lamps and the club show's moving-head beams.
On stream (the OBS page) VTube Pro uses up to 3 real lamps and 6 beams, at every Graphics quality. The studio's preview
shows 2 lamps and 4 beams. The test page (11.1) with `&tier=low` shows none. So keep baking your lamp pools: the
preview and the stream differ.

High and Ultra can use a per-room look: scene.json `gfx` (16.1) and a `lut.png` colour grade.

**Measured with the room check:**

| Room | Triangles | Draw calls | Size | Places | Verdict |
|---|---|---|---|---|---|
| VTube Pro Studio | 52,542 | 84 | 3.7 MB | 12 | Ready to use, light |
| VTube Pro Hangout (3 areas in one file) | 118,347 | 270 | 13.0 MB | 3 × 12 | Ready to use, a bit heavy |
| The starter room script (4.12) | 9,694 | 16 | 0.5 MB | 5 | Ready to use, light |

**Cheap wins:** join still meshes that share a material; use texture atlases; add LOD siblings or a lone `DETAIL_LOD0`
for small clutter; delete faces nobody sees (wall backs, under furniture); keep far scenery low-poly behind haze. 

---

## 10. Check every camera

The automatic camera operator is only as good as your room lets it be. It scores each shot with rays against your
geometry: a face cut or hidden, empty space in the frame, a camera inside a prop, a prop over a face or the screen.

**Rules for the cameras you place:**

- Stand in the open front or inside the room. Never inside a wall or furniture.
- Faces stay clear at the room's `avatarHeight`.
- Head room of about 8–15 % of the picture. In a talk shot, the face sits 20–45 % down from the top.
- No empty space at the frame's edges.
- `CAM_REACT` and `SCREEN_SOLO_xx` never move on their own (someone may line up an OBS capture with them).

**Check them, step by step:**

1. Pick the room (section 11).
2. In the **Camera** list, pick Talk, Group, Wide, React, Screen and each of your presets.
3. Move the host to each place (**Who sits where**) and look at the Talk shot each time.
4. Switch to React and try the **React layout** choices: the solo side screen and **Big centre (the room’s screen)**.
5. Go through every lighting state (Shift+1 … Shift+5): beams and lasers must never cover a face.
6. With friends: check the Group and Wide shots with every place filled. Alone: use the test page with stand-in
   guests (11.1).

**Fix it without re-exporting** (scene.json, glTF space):

- `cameraOverrides`: `{"CAM_WIDE": {"pos": [0, 2.4, 6.7], "target": [0, 1.4, -1.2], "fov": 50}}` adds or replaces a
  camera. `"SPOT_03_CAM": null` removes an authored one. `fov` 5–120 (default 35). Names: `CAM_` + capitals, digits
  and `_`, or `SPOT_xx_CAM`.
- `soloScreens`, `spotOverrides` and `hideNodes`: section 16.

---

## 11. Test it, step by step

1. **Not live yet?** Picking a room shows on your stream right away. Test before you go live, or use the test page
   (11.1).
2. Your room folder must be inside your scenes folder (1.2). Built it somewhere else? Copy it in.
3. In the studio: **Room** → **↻ Rescan** (next to **Change room**).
4. **Room** → **Change room**. Your room is under its `world` heading, or under **More rooms**. Names that look like
   tests (`test`, `_v2`, `_wip`, "grey box") hide behind **Show test rooms**.
5. Pick it. Check:
   - every place: nobody inside furniture or floating;
   - every camera (section 10);
   - React mode, with the screen dropping in;
   - every lighting state (Shift+1 … Shift+5);
   - a friend walking in through the door;
   - **Room** → **Graphics quality** on Low and on High (post effects and detail change; the lamps don't).
6. Want the room check's report? Drop `scene.glb` into **＋ Add my room** and read step 2. You don't have to save it.
7. Pictures: `thumb.png` (480 × 270) and `preview.png` (1280 × 720), from `CAM_WIDE` (4.11).

### 11.1 The test page (advanced)

On the computer running VTube Pro, open `http://127.0.0.1:5191/output.html?sceneTest=<room id>` in your browser. Put
your room id in place of `<room id>`, without the angle brackets. For the starter room (4.12):
`http://127.0.0.1:5191/output.html?sceneTest=my_first_room`. It shows the room on its own and never follows your live
show. Add any of these to the address:

| Add | What it does |
|---|---|
| `&cam=wide` | The camera: `wide`, `group`, `talk`, `react` or a preset like `CAM_DESK`. |
| `&mode=react` | React mode. |
| `&spot=3` | The host on place 3. |
| `&extra=a,b` | Stand-in guests: avatar ids from your library. An id is the avatar's folder name in your library (section 18 of [For 3D artists: avatars](ARTIST_AVATARS.md)), or ask your AI to run `list_avatars`. |
| `&screen=placeholder` | A test picture on the screen. |
| `&env=h19.2,storm` | 19:12 and a storm (rooms with `environment`). |
| `&beatDemo=128` | The light show at 128 BPM, with no music. |
| `&gfx=low&tier=low` | How it looks on Low with no real lamps. The test page starts like the stream: real lamps and beams as on stream (tier High), Graphics quality Medium. |

**Close the tab when you're done.** An open 3D tab costs the streamer's graphics card.

---

## 12. Worked examples

Rooms you can open and learn from. Two of the rooms that come with VTube Pro are good examples. They are in
`assets/scenes/` (1.2). To look inside one: in Blender, **File** → **Import** →
**glTF 2.0**, pick its `scene.glb`, and read the names in the Outliner. Open its `scene.json` in Notepad to read it,
but don't save changes there (updates replace that folder).

**VTube Pro Studio** (`vtubepro_studio`): the clearest small room. 52,542 triangles, 84 draw calls, 3.7 MB, light
baked into vertex colours.
- 12 places: desk seats `SPOT_01`–`SPOT_04` (host centre-left), a gaming chair `SPOT_05`, an interview nook
  `SPOT_06`–`SPOT_08`, standing places `SPOT_09`–`SPOT_12`.
- Its scene.json shows `cams` (camera fixes, like a 57° `CAM_WIDE`), `interview`, `projectorScreens`, `gfx` (an HDRI
  and floor reflections), `screenSkin` and `world`.

**VTube Pro Hangout** (`hangout_lounge`): a penthouse with three areas side by side in one file.
- Lounge, Bar and Patio, with the prefixes `MAIN__`, `BAR__` and `PATIO__`. Each area has `SPOT_01`–`SPOT_12`,
  `CAM_WIDE`, `CAM_REACT`, `CAM_DOOR`, a `SCREEN`, a `DOOR` and its own pictures in `areas/bar/` and `areas/patio/`.
- Two bakes: the day in `COLOR_0`, the night in `COLOR_1`. `environment` with `bakedAt` 18.3 and `sun` 0.
- Celebrations (`lounge`) with `EVT_*` anchors per area, and a `lightRig` per area.
- 118,347 triangles for the whole file, 270 draw calls, 13.0 MB: "a bit heavy, but it should run fine".

**The starter room** (4.12): the smallest complete room, made by one script you can change.

To start your own from a script, copy 4.12, change the room id and the sizes, and keep the anchors, bake and export
steps.

---

## 13. Licences

- Original designs only. A homage to a game location may borrow its feel and landmarks, never its files, logos,
  textures or models.
- Free props: the CC0 kits from Poly Haven (polyhaven.com), Quaternius (quaternius.itch.io) and KayKit
  (kaylousberg.itch.io) are fine. Get them from those sites: VTube Pro doesn't include them. Restyle them to your
  room's colours. KayKit asks you not to resell unmodified copies.
- CC0 HDRIs are fine. CC-BY items need credits. No "non-commercial" assets.
- No real brands or logos you don't own.

---

## 14. Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| My room isn't in **Change room** | The folder name has capitals or spaces, `scene.json` has a typo, or the folder isn't in your scenes folder | Rename it (`my_room`). Check `scene.json` in a JSON checker: no comments, no missing commas, straight quotes. Move it to your scenes folder (1.2) and press **↻ Rescan**. |
| The card is greyed out ("not built yet") | No model file | Put `scene.glb` in the folder, or fix `"model"` in scene.json. |
| It's under **Show test rooms** | The id has `test` as a word (like `my_test_room`) or ends in `_v2` or `_wip`, or the name says "test room" or "grey box" | Rename it, or add `"test": false` to scene.json. |
| "We couldn't find any places for you to sit or stand" | No `SPOT_xx` empties, exported without **Custom Properties**, or names like `SPOT_01.001` | Name them exactly. Tick **Custom Properties** on export. |
| "places look stuck inside furniture or floating" | The origin isn't on the floor, or `seatHeight` is wrong | Move the empty onto the floor under the hips or feet. Or use `spotOverrides`. |
| People face the wall | The empty is turned the wrong way | **Rotation** Z = 0 faces the front (−Y in Blender). |
| People float above or sink into seats | `seatHeight` doesn't match the cushion | Measure the cushion height from the floor. |
| "Your room looks 100 times too big" | Exported in centimetres | Keep **Unit Scale** 1.000 and apply scale. **＋ Add my room** can fix it for you. |
| "Your room seems to be lying on its side" | **+Y Up** was off, or the room is rotated | Tick **+Y Up**. Model with Z up in Blender. |
| "The floor isn't at ground level" | The floor isn't at height 0 | Move everything so the floor is at 0. |
| My cameras don't show up | **Cameras** wasn't ticked, or the camera object isn't named `CAM_…` | Tick **Cameras**. Rename the camera object. |
| The React screen is stretched, sideways or upside down | Not 16:9, rotated UVs, or rotation and scale not applied | Rebuild the plane (4.5). **Object** → **Apply** → **Rotation & Scale**. |
| Glow doesn't follow the music or the lighting states | The material isn't named `EMIT_<group>`, or isn't Principled BSDF | Rename it. Use a Principled BSDF. |
| The room looks flat | No bake, or the bake didn't export | Bake (4.9). Export with **Use Vertex Color**: Active. |
| Too dark or washed out | Blender lights exported, or the bake is off | Untick **Punctual Lights**. Use scene.json `ambience.exposure` (0.1–3). |
| Walkers walk through furniture | No `COLLIDE_` box, a box floating above 0.9 m, or no `approach` points | Add boxes that stand on the floor. Add `approach` and `leavePathAt` to places behind furniture. |
| `COLLIDE_` boxes or empties are missing from the file | **Visible Objects** or **Renderable Objects** was ticked while they were hidden | Untick those limits (4.10). |
| A camera shows empty space | Nothing modelled beyond a door or window | Model floor and walls there, or move the camera. |
| A prop hides a face or the screen | Sightline not checked | Move the prop or the place. `hideNodes` hides it until you rebuild. |
| "Part of this room is packed in a way VTube Pro can't read" | Draco or KTX2 compression | Export without compression, or let Blender unpack it. |
| My scene.json settings vanished after **＋ Add my room** | It only takes the model and writes a new scene.json | Copy the whole room folder instead (section 17). |
| A `.gltf` file is refused | It needs separate `.bin` or texture files | Export glTF Binary (`.glb`). |
| "That room is over 300 MB" | Too heavy | Smaller textures, fewer details (section 9). |
| Face tracking slows down in this room | Too heavy for this computer | Stay within section 9. Try **Graphics quality** Low. |
| Lamps light people on stream but not in the preview (or the other way round) | The stream uses up to 3 real lamps, the studio's preview 2 (5.1) | Bake the lamp's pool of light into the room, so it looks lit everywhere. |
| My changes to a shipped room are gone | Updates replace the shipped rooms | Copy it into your scenes folder under a new folder name, and edit that. |

---

## 15. "Add my room" and the room check

The studio's **Room** → **＋ Add my room** runs the same check an AI gets, on any room file. It can also fix the most
common gap: **no places to sit or stand**. Steps for everyone: [Rooms: the easy way](ENVIRONMENTS_SIMPLE.md).

**What it takes:**
- `.glb`, or a `.gltf` with everything inside it, right away.
- `.fbx`, `.blend` and `.obj` through Blender, which VTube Pro runs for you. `.dae` isn't accepted.
- Up to 300 MB.
- A Draco or KTX2 packed `.glb` goes through Blender too: it unpacks it.

**What it keeps, and what it doesn't:**
- It imports **only the model**. It writes a fresh scene.json: the name, `modes` (`talk`, plus `react` when there's a
  `SCREEN`), `defaultCamera` and `reactCamera` when it finds `CAM_WIDE` and `CAM_REACT`, `avatarHeight` 1.5,
  `hostSpot`, and `areas` found from name prefixes.
- **Your own scene.json is not imported:** time of day, `lights.groups`, `gfx`, `interview` and every other setting.
  To keep them, copy the room folder (section 17).
- The room's name comes from the file name (`Night_Diner.glb` becomes "Night Diner"). Its id is that name in lowercase
  (32 characters at most), plus `_` and 6 random letters and digits.
- It saves `thumb.png` (480 × 270) from `CAM_WIDE` or the first talk camera. It doesn't make a `preview.png`.
- The room goes into your scenes folder. **Nothing is uploaded.**

**What it checks** (one plain sentence each in the report): that it can open the file, compression VTube Pro
can't read, **places** (required: at least one usable `SPOT_xx` in the room; an area without one gets a warning), cameras (`CAM_WIDE`), size (centimetre
exports and other unit mix-ups), which way is up, the floor's height, baked light or `LIGHT_` / `EMIT_`, the budget,
the React screen and the door. It guesses units from the room's size: about 250 m or more across means centimetres
(×0.01); under 0.6 m means ×100. It flags a floor more than 0.25 m away from height 0.

**What "Place seats for me" does** (it runs when a room has fewer than 2 usable places):
- **Seats:** surfaces facing up, 0.28–0.68 m above the floor, at least 0.36 m wide, with room above. They need a
  backrest 0.25–0.8 m above the cushion within 0.75 m: that tells a sofa from a coffee table. One seat about every
  0.7 m along a sofa, facing away from the backrest.
- **Standing places:** open floor with 0.45 m free all round, 1.8 m up and 1.4 m clear in front.
- Seats at least 0.62 m apart, standing places 0.9 m. Never within 0.8 m of the floor under the React screen.
  Inside the area's `bounds` for rooms with areas.
- A **talk camera** for every new place (35°, 1.25–2.8 m in front, a clear view of the face), and `CAM_WIDE` when the
  room has none.
- It fixes units, the up direction and the floor by wrapping the room in one parent object (`VTP_ROOM_FIX`). Your
  geometry and textures stay byte for byte, so it runs in the browser with no Blender. Running it again never doubles
  anything.
- New places carry `pose`, `seatHeight`, `seatDepth`, `label` and `placedBy` = `vtubepro-room-wizard`.

It's a best guess: a bench without a back isn't found, a bed may be. The preview shows every place, and
**Let me place them** lets you drag, turn, add or remove them. Artists should still place `SPOT_xx` by hand and check
the cameras (section 10).

**For AIs and scripts** (through VTube Pro; an AI app connected over the internet bridge gets the checklist, not
`check_room`):

| What | How |
|---|---|
| The checklist | AI tool `room_checklist`; `GET /api/rooms/checklist` |
| Check a room in your scenes folder, or a file | AI tool `check_room` with a room id or a path to a `.glb`, `.gltf`, `.fbx`, `.blend` or `.obj`; `GET /api/rooms/check/<id>` |

---

## 16. scene.json reference

All positions are glTF space (metres, +Y up, front = +Z). `yaw` is in degrees about +Y, and 0 faces the front.
VTube Pro keeps keys it doesn't know and ignores them, so notes are fine.

### 16.1 Every key

**Basics and the room card**

| Key | Type | Example | What it does |
|---|---|---|---|
| `name` | text | `"Night Diner"` | The name on the card (80 characters). Missing: the folder name. |
| `model` | text | `"scene.glb"` | The model file in this folder (letters, digits, `_`, `-`, `.`, `/`; no `..`). Default `scene.glb`. |
| `world` (or `group`) | text | `"My rooms"` | The heading the room is listed under in **Change room**. Missing: **More rooms**, unless the id starts with a game prefix (like `sc_`, `poe_`, `le_`, `eft_` or `ttrpg_`). Set `world` to be sure. |
| `test` | true / false | `false` | `true` hides it under **Show test rooms**. `false` keeps a test-looking name visible. |
| `modes` | list | `["talk", "react"]` | Card badges only. Without `"react"` the card says "Talk only (no React screen)". `"gaming"` adds "Gaming layouts". React itself works in every room. |
| `avatarHeight` | metres | `1.5` | The height every performer of normal size is shown at. Default 1.5. |
| `defaultCamera` | any | `"CAM_WIDE"` | When someone picks this room while a preset camera is showing, the camera switches to Wide. Talk, Group and React stay. The value itself isn't read: the camera named `CAM_WIDE` is the wide view. |
| `reactCamera`, `hostSpot` | text | `"CAM_REACT"` | Not used by the room itself. React uses the camera named `CAM_REACT`; the host starts on `SPOT_01`. |
| `preview`, `thumbnail` | text | | Not read. The pictures are always `thumb.png` and `preview.png`. |
| `bounds` | 6 numbers | `[-6, 0, -1, 6, 3.5, 8]` | min x, y, z then max x, y, z: what framing and screens treat as the room. In a room with areas, **Place seats for me** stays inside each area's `bounds`. Default: the whole model. |

**Look and atmosphere**

| Key | Type | Example | What it does |
|---|---|---|---|
| `ambience.background` | hex or null | `"#101218"` | The background colour. Leave it out for a see-through background in OBS. |
| `ambience.fog`, `fogNear`, `fogFar` | hex, metres | `"#101218"`, `9`, `26` | Distance fog. With only `fog` set: near 8, far 30. |
| `ambience.exposure` | 0.1–3 | `0.9` | Brightens or darkens every material that isn't `EMIT_`. Never the performers. |
| `screenSkin` | text or object | `"studio"` | The look of the generated screens (section 7). |
| `gfx` | object | `{"bloom": 0.6}` | High and Ultra look: `grade`, `lutMix` (0–1), `bloom` (0–3), `threshold` (0.4–4), `vignette` (0–0.8), `ao` (0–1), `shafts` (0–2), `dof` (0–1), `haze` {`color`, `density` 0–0.2, `glow` 0–3}, `rim` {`color`, `strength` 0–1}, `glow` (0–4), `groups` {group: brightness 0–4}, `reflect` {`strength` 0–1, `y`, `maxDist` 1–30}, `hdri`. |
| `gfx.hdri` (or `hdri`) | name, object or false | `{"name": "empty_warehouse_01", "intensity": 0.5, "rotation": 0}` | Light and reflections from a sky photo on High and Ultra. Built in: `small_harbour_sunset`, `belfast_sunset_puresky`, `empty_warehouse_01`, `hospital_room_2`, `rogland_clear_night`, `fireplace`, `abandoned_factory_canteen_01` (Poly Haven, CC0). |
| `environment` | object | `{}` | Time of day and weather (section 6). Keys: `sky` (`procedural`, `room`, `none`), `north`, `noonElevation` (62), `sunrise` (6.0), `sunset` (18.5), `climate` (`temperate`, `jungle`, `city`, `coastal`, `arid`), `weathers`, `default`, `weatherByState`, `hourByState`, `night` (0.2), `exposure`, `bakedAt`, `sun` (0 for a baked sun), `fog` {`near`, `far`, `tint`} or false, `nightLights` {group: {`threshold`, `stagger`, `flicker`, `fade`, `day`, `pools`, `radius`}}, `windows`, `wet`, `puddles`, `foliage`, `cloth`, `sway`, `dry`, `rainArea`, `performers` {`minKey`, `minFill`}, `showOwnsNightLights`. |

**Lights**

| Key | Type | Example | What it does |
|---|---|---|---|
| `lights.groups` | group → hex | `{"neon": "#39ff88"}` | The groups and colour swatches in the **Lights** panel. Doesn't change the light's real colour. |
| `lights.programs` | list | `["myshow"]` | Adds names that aren't built in, as "myshow (room)" presets that play the Room show. Built-in names do nothing here. |
| `lightGroupsOff` | list | `["warning"]` | These groups stay dark: no real light, no glow. |
| `lightRig` | object | `{"beams": [[0, 3.3, 2]], "lasers": [[-3, 3, 0]], "ball": [0, 3, 3]}` | Where beams, lasers and the mirror ball hang, when there are no `FX_` empties (5.6). |

**Places and people**

| Key | Type | Example | What it does |
|---|---|---|---|
| `spotOverrides` | object | `{"SPOT_04": {"pos": [1.2, 0, 0.8], "yaw": -15}}` | Moves or turns a place. `approach`: new walk points (`[]` = walk straight). Moving a place keeps old walk points only within 3 m. |
| `spotSizes` | object | `{"SPOT_12": ["normal", "large", "macro"]}` | Which size classes each place takes (2.5). |
| `sizeSpots` | list | `[{"position": [2, 0.9, 1], "yaw": 0, "sizes": ["micro"], "label": "Shelf"}]` | Extra places for size classes (also `pose`, `seatHeight`, `hover`). They come after `SPOT_12`, with the automatic ones: 8 at most. |
| `autoSizeSpots` | true / false | `false` | `false` turns off the automatic perches and back-row spots. |

**Cameras, screens, chat**

| Key | Type | Example | What it does |
|---|---|---|---|
| `cameraOverrides` (or `cams`) | object | `{"CAM_BOOTH": {"pos": [2, 1.6, 3.5], "target": [0.5, 1.1, 0], "fov": 40}}` | Adds or replaces cameras without re-exporting. `null` removes one. Names: `CAM_` + capitals, digits, `_`; or `SPOT_xx_CAM`. `fov` 5–120, default 35. |
| `hideNodes` | list | `["Sign_Broken"]` | These objects (and their children) are hidden and ignored by cameras. |
| `soloScreens` | object | `{"SPOT_01": {"position": [2.2, 1.6, 0.4], "yaw": -20, "width": 2.4}}` | Where the solo React screen hangs for each host place. |
| `projectorScreens` | list | `[{"position": [6.3, 2.05, -3.3], "yaw": -22, "width": 1.7}]` | Up to 3 pull-down screens for projector guests. |
| `chatMonitors`, `chatBoards`, `chatBuddy` | object | `{"SPOT_01": {"position": [-1.1, 0.8, 0.6], "yaw": 20, "width": 0.9}}` | Chat monitor, support board and chat buddy places, per host place. |
| `buddySpots` | object | `{"SPOT_01": [[0.6, 0.75, 0.2]]}` | Perch points for the chat buddy (up to 8 per place). |
| `timerDisplays` | list | `[{"node": "Clock_Face", "style": "lcd", "color": "#7dff8a", "show": "remaining", "label": "TIME LEFT"}]` | Draws the subathon countdown on existing meshes (up to 8) without re-exporting. `node` = the object's name (a mesh, or a group: its flat screen part is used); optional `style` (`digits`, `neon`, `lcd`), `color` (hex), `show` (`remaining`, `uptime`, `both`), `label` (24 characters), `material` (pick the part whose material name contains this), `fit` (0.3 to 1: shrink the panel and digits about the centre, e.g. 0.8 when the mesh is wider than the dome behind it), `glass` (0.5 to 1: panel opacity). Same as a `TIMER_DISPLAY` node (section 2.4). |

**Areas and engines**

| Key | Type | Example | What it does |
|---|---|---|---|
| `areas` | object | `{"bar": {"name": "Diner — Bar", "label": "Bar", "icon": "🍸"}}` | The areas (2.6). Keys: lowercase, 24 characters, up to 16. `name` (80), `label` (24), `icon` (8), `bounds`, and any other key to override for that area (16.3). |
| `defaultArea` | text | `"main"` | The area the plain room id opens. Default: the first one. |
| `interview` | object | `{"host": "SPOT_06", "guests": ["SPOT_07", "SPOT_08"]}` | Talk-show layout (section 8). |
| `lounge` | object | `{"on": true}` | Supporter celebrations (section 8). |
| `raid`, `warzone`, `space`, `entrance`, `exit`, `club`, `town`, `yacht`, `traffic`, `eras`, `ttrpg`, `stage` | object or text | | The optional engines (section 8). `stage` also adds the "Gaming layouts" badge. |

**Written by VTube Pro:** `importedWith` and `importedAt` (Add my room). Leave them alone.

### 16.2 A full example, explained

JSON files can't hold comments, so the notes come after the file. This is a complete, valid `scene.json`:

```json
{
  "name": "Night Diner",
  "world": "My rooms",
  "modes": ["talk", "react"],
  "defaultCamera": "CAM_WIDE",
  "avatarHeight": 1.5,
  "ambience": {
    "background": "#101218",
    "fog": "#101218", "fogNear": 9, "fogFar": 26,
    "exposure": 0.9
  },
  "lights": {
    "groups": { "neon_sign": "#ff4fd8", "lamps": "#ffd49a", "onair": "#ff3b3b" }
  },
  "screenSkin": "studio",
  "spotOverrides": { "SPOT_04": { "pos": [1.2, 0, 0.8], "yaw": -15 } },
  "cameraOverrides": { "CAM_BOOTH": { "pos": [2.0, 1.6, 3.5], "target": [0.5, 1.1, 0.0], "fov": 40 } },
  "hideNodes": ["Sign_Broken"],
  "chatMonitors": { "SPOT_01": { "position": [-1.1, 0.8, 0.6], "yaw": 20, "width": 0.9 } },
  "gfx": { "hdri": { "name": "empty_warehouse_01", "intensity": 0.5 }, "bloom": 0.6 },
  "environment": { "weathers": ["clear", "rain", "storm"] },
  "interview": { "host": "SPOT_01", "guests": ["SPOT_02", "SPOT_03"] }
}
```

What each line does:

1. `name`: "Night Diner" on the card. `world`: listed under "My rooms" in **Change room**.
2. `modes`: the card doesn't say "Talk only". `defaultCamera`: picking the room switches a preset camera to Wide.
3. `avatarHeight`: everyone of normal height is shown 1.5 m tall.
4. `ambience`: a dark blue-grey background and fog from 9 to 26 m. `exposure` 0.9 makes the room a little darker,
   never the performers. Remove `background` for a see-through background in OBS.
5. `lights.groups`: three groups with their swatch colours in **Lights**. `neon_sign` pulses (5.5); `onair` is the ON
   AIR sign.
6. `screenSkin`: the studio look for the solo screen, chat monitor and support board.
7. `spotOverrides`: place 4 moved to (1.2, 0, 0.8) and turned 15° toward −X, without re-exporting.
8. `cameraOverrides`: a new preset "Booth (preset)", 2 m to the right, 3.5 m in front, 1.6 m up, looking at the booth.
9. `hideNodes`: a broken sign is hidden until the next export.
10. `chatMonitors`: where the chat monitor stands when the host sits on place 1.
11. `gfx`: on High and Ultra, warehouse light and reflections at half strength, and a little more bloom.
12. `environment`: time of day and weather, limited to clear, rain and storm.
13. `interview`: the talk-show host chair and two guest chairs.

### 16.3 Areas example

A room with two areas side by side in one file. The Bar overrides the exposure and has its own beams:

```json
{
  "name": "Rooftop Hangout",
  "defaultArea": "main",
  "areas": {
    "main": { "name": "Rooftop Hangout — Lounge", "label": "Lounge", "bounds": [-6.6, 0, -0.3, 7.8, 3.8, 8.7] },
    "bar": {
      "name": "Rooftop Hangout — Bar", "label": "Bar",
      "bounds": [-17.3, 0, -0.3, -5.9, 3.5, 8.7],
      "ambience": { "exposure": 0.8 },
      "lightRig": { "beams": [[-14.6, 3.4, 2.6], [-8.6, 3.4, 2.6]] }
    }
  }
}
```

- The GLB has `MAIN__SPOT_01`, `MAIN__CAM_WIDE` … and `BAR__SPOT_01`, `BAR__CAM_WIDE` ….
- The room id `rooftop_hangout` opens the Lounge; `rooftop_hangout~bar` opens the Bar.
- An area entry replaces whole top-level keys: here the Bar's `ambience` replaces the room's `ambience` completely.
  It can't change `id`, `model`, `areas`, `defaultArea` or the pictures.
- Scripts and Stream Deck switch areas through VTube Pro's local server: `POST /api/scene/area` with `{"area": "bar"}` (or `next`,
  `prev`).

---

## 17. Share your room

| Way | What the other person gets | How they add it |
|---|---|---|
| **Send the room folder** (zip it) | Everything: the model, your scene.json settings, the pictures and the areas | They put the folder in their scenes folder and press **↻ Rescan**. |
| **Send just `scene.glb`** | The model only. VTube Pro writes a new scene.json, so time of day, `lights.groups`, `gfx`, `interview` and your other settings are lost | **＋ Add my room**. |

- A room folder needs no signature and no store: it's plain files.
- **Before you share:**
  - zip the folder itself, so the zip holds `my_room/scene.glb`, `my_room/scene.json` and the pictures;
  - pick a folder name that won't clash with someone else's room;
  - you can leave out `blender/`, textures and notes: VTube Pro doesn't use them;
  - check every licence (section 13), and keep personal things out of names and pictures;
  - stay under about 25 MB (section 9).
- **The other person:** open the zip, copy the room folder into their scenes folder (1.2), press **Room** →
  **↻ Rescan**, and find it in **Change room**.

---

## 18. Let an AI build it (Claude or Codex)

An AI can do most of this for you. Step by step, with Opus 5.5 and GPT-6.1 examples:
[Make a model with Claude or Codex](MAKE_WITH_CLAUDE_OR_CODEX.md). Connect your AI app first: see
[AI connectors](AI_CONNECT.md).

- **Pick the model:** see [Pick the model](MAKE_WITH_CLAUDE_OR_CODEX.md#pick-the-model) in that guide (Opus 5.5 in
  Claude Desktop or Claude Code, GPT-6.1 in Codex or the ChatGPT desktop app). The prompts below work the same with
  both.
- **What you'll see:** your AI app may ask "Allow?" before it uses a tool: say yes. The **AI connectors**
  page then shows, for example, "wants to run blender_run_python". Press **Approve once** if it's what you asked for.
  A Blender script the AI runs through VTube Pro always waits for your OK. It uses your own Claude or ChatGPT plan;
  VTube Pro adds no cost.
- **Through VTube Pro,** any AI app connected on your computer gets VTube Pro's room tools. `check_room` and
  `room_checklist` check a room. (An AI app connected over the internet bridge gets the checklist only.)
- **Claude Code and Codex** can also write files and run programs on your computer, as their own settings allow. They
  can write a Blender script like 4.12, run Blender, and save the room.

**One flow for every AI app:**

1. In **Documents**, make a work folder called **VTube Pro builds**. Start Claude Code or Codex in that folder (see
   [Never used a terminal?](MAKE_WITH_CLAUDE_OR_CODEX.md#never-used-a-terminal)). In Claude Desktop or the ChatGPT
   app, name the folder in your prompt.
2. Ask the AI to build the room folder **there**, with the prompt below.
3. Copy that room folder into your scenes folder (1.2) and press **Room** → **↻ Rescan**.
4. Simpler: ask for just a `.glb` file and add it with **＋ Add my room**. You lose only the scene.json settings
   (section 15).

If your AI says it can't open web pages, save this page as a file in that work folder and say "Read
ARTIST_ENVIRONMENTS.md" instead of the web address.

**Example prompts:**

> Read the VTube Pro room guide (call get_docs with topic environments). Write a Blender script that builds a cozy ramen bar
> for VTube Pro, following that guide exactly: an open front, 6 counter stools as SPOT_01 to SPOT_06 (pose sit,
> seatHeight 0.75), 2 standing places, CAM_WIDE, a 16:9 SCREEN with CAM_REACT, a DOOR in a doorway with DOOR_OUTSIDE
> and PATH_01 to PATH_03, EMIT_neon_sign and EMIT_lamps glow, and a vertex-colour bake. Stay under 80,000 triangles.
> Save it as a room folder called ramen_bar in this folder (Documents, VTube Pro builds), with scene.json, preview.png
> and thumb.png.

> Run check_room on the file ramen_bar/scene.glb in this folder and fix everything it reports. Then tell me what you
> changed.

> In my room ramen_bar, the wide camera cuts off SPOT_06. Add a cameraOverrides entry for CAM_WIDE to its scene.json
> that sees every place. Keep every other key in scene.json.

> Rename the glowing materials in my room so the light show drives them: EMIT_ plus a group name from section 5.5 of
> the guide. List the groups and their colours in lights.groups, then re-export scene.glb with the settings in 4.10.

**Tips:**
- Ask for one build script it can run again. Then every fix is a small change.
- Ask it never to overwrite a room folder it didn't make.
- If it says `validate_room` or a creation package needs Python, ask it to use `check_room` instead. Those tools need
  extra files your copy doesn't include.
- Test the result yourself (section 11) before you go live.
