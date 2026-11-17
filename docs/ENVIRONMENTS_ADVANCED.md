# Building a room by hand (in-depth)

For people who build 3D environments in Blender (or any tool that exports glTF) and want them to work as VTube Pro
rooms: seats, walk-ins, cameras, a react screen, lighting states. If you only want to pick or generate rooms in the
studio, read **[ENVIRONMENTS_SIMPLE.md](ENVIRONMENTS_SIMPLE.md)**.

This is the tutorial version of the room contract. The full reference is **[SCENES.md](SCENES.md)** (every node, every
scene.json key, every engine system), the short checklist the validator enforces is
**[AI_CONNECT.md "Build or modify a room"](AI_CONNECT.md#build-or-modify-a-room)**, and the Blender workflow is
**[BLENDER_PLAYBOOK.md](BLENDER_PLAYBOOK.md)** (section 6: rooms). The creator guide has a minimal template:
[AI_CREATOR_GUIDE.md §10.7](AI_CREATOR_GUIDE.md).

Contents: 1 What a room is · 2 Units, axes, scale · 3 The shell · 4 Seats (SPOT_) · 5 Door and walk-in ·
6 Cameras (CAM_) · 7 The react screen · 8 Floors, colliders, chat anchors · 9 Lights and lighting states ·
10 Validate and test · 11 scene.json · 12 Fixing a room without re-exporting · 13 Areas · 14 Budgets and baking ·
15 Worked example: the VTube Pro Studio.

---

## 1. What a room is

A folder `assets/scenes/<id>/` (id: lowercase letters, digits, `_`, `-`, up to 48 characters) containing:

```
scene.glb      the room: meshes plus NAMED empties / cameras that tell the engine where things go
scene.json     name, modes, default camera, ambience, light groups, optional systems
preview.png    1280×720 from CAM_WIDE          thumb.png   480×270
blender/       (recommended) the build script, so the room can be rebuilt and edited
textures/      (optional) source textures
```

The server lists every such folder (`GET /api/scenes`); **Room → Change room → ↻ Rescan** picks up a new one without
a restart. The engine reads everything by node **name**, so any room built to the contract "just works".

## 2. Units, axes, scale

- **Metres.** The floor is at height 0.
- glTF: +Y up, the **stage front faces +Z** (towards the default camera). In Blender: Z up, the open front of the
  room faces **−Y**. A helper that takes glTF-style coordinates and returns Blender ones is handy:
  `G(x, y, z) = Vector((x, -z, y))` (from `vtubepro_studio/blender/vs_lib.py`).
- Avatars are shown ~1.5 m tall (`scene.json avatarHeight`). A typical room is 6–10 m wide, 5–8 m deep, 3–3.5 m
  high. Seats are 0.42–0.5 m high, desks 0.75 m, counters 0.9–1.1 m, doors 2.1 m.

## 3. The shell

Build walls on three sides and leave the front (Blender −Y) open, like a TV set: the cameras live there. Give walls
thickness (single-sided planes flicker and let light through), keep ceilings if cameras look up, and put something
behind every window (a backdrop plane or a sky), because the camera tour looks around.

## 4. Seats: `SPOT_01` … `SPOT_12`

Each seat is an **empty** named `SPOT_01`…`SPOT_12` (at least 1, aim for 5–12). Its origin is on the floor where the
feet (standing) or the seat's footprint (sitting) go. **It faces its local −Y in Blender** (glTF +Z): turn it
towards the camera. Custom properties become glTF extras (export with `export_extras=True`):

| Property | Meaning |
|---|---|
| `pose` | `"sit"` or `"stand"` (required) |
| `seatHeight` | sit only: seat surface above the node, metres (0.15–1.4; default 0.45) |
| `seatDepth` | sit only: how far back the hips go |
| `label` | "Couch left", "DJ desk": shown in **Who sits where** |
| `approach` | flat list of glTF points `[x,y,z, x,y,z…]` the walker follows before sitting (around a desk end) |
| `leavePathAt` | which `PATH_xx` the walker joins when leaving |
| `sizes` | size classes this spot takes, e.g. `["micro"]` for a desk-top perch, `["macro"]` for a giant's back-row spot |

`SPOT_01` is the host's default (`scene.json hostSpot` can change that). Optional `SPOT_xx_CAM` cameras give each seat
its own talk framing; otherwise the engine frames automatically.

## 5. Door and walk-in

| Node | Meaning |
|---|---|
| `DOOR` | the door leaf; **origin at the hinge**, rotates about its local up axis; extra `openAngle` (deg, default 95) |
| `DOOR_OUTSIDE` | where entering avatars spawn, just outside, facing in |
| `PATH_01`, `PATH_02` … | waypoints from the door to the room centre |
| `CAM_DOOR` | optional entrance camera, looking at the inside of the doorway |

Keep a clear lane from `DOOR_OUTSIDE` along the `PATH_*` points to every spot.

## 6. Cameras: `CAM_*`

Real Blender cameras (export with `export_cameras=True`; name the camera **object**). Vertical FOV 35–40°
(`sensor_fit = 'VERTICAL'`). Cameras look down their local −Z.

- `CAM_WIDE` (required, the `defaultCamera`): sees every spot.
- `CAM_REACT` (required with the react mode): frames the SCREEN at ~80 % of the width (at vfov 35°: distance ≈
  1.12 × screen width).
- Any other `CAM_*` (`CAM_DESK`, `CAM_CRANE`, `CAM_LEFT`…) becomes a preset and joins the ambient camera tour.
- Rules the camera QA enforces: never inside furniture, faces unoccluded at `avatarHeight`, head room 8–15 % of the
  frame, no void (unmodelled space) in frame.

## 7. The react screen: `SCREEN`

A **16:9 plane mesh** named `SCREEN`, UVs 0..1 unrotated, facing the camera, transforms applied. The engine rolls it up
when hidden and drops it in react mode (`restOffsetY` extra = how far above its shown position it rests). In OBS it is
rendered as a transparent hole (your capture shows through) or as in-scene capture. Optional `SCREEN_SOLO_xx` empties
say where a side screen hangs when the host sits at `SPOT_xx`. Details: [SCENES.md "React screen content"](SCENES.md).

## 8. Floors, colliders, chat anchors

| Node | Meaning |
|---|---|
| `FLOOR_*` | hidden meshes the walkers stand on: stage risers, stair ramps, balconies (the highest one under a walker wins) |
| `COLLIDE_*` | simple hidden boxes the walk path avoids (furniture in the lane; ignored when taller than 0.9 m) |
| `CHAT_MONITOR`, `CHAT_BOARD` | where the in-world chat monitor and support board stand (they must stand ON furniture) |
| `CHAT_BUDDY`, `BUDDY_SPOT` | the chat buddy's tablet and its spot |
| `FX_BEAM_xx`, `FX_LASER_xx`, `FX_BALL` | anchors for the light show's moving heads, laser fans and mirror ball (else an automatic ceiling grid) |

Keep chat props away from faces and the screen. More (raid / space / kitchen engines, NPCs): [SCENES.md](SCENES.md).

## 9. Lights and lighting states

The engine turns room shadows off and caps real lights (0–4 per graphics tier), so rooms are **lit by baking and by
glowing materials**:

- Fixtures are nodes `LIGHT_*` with extras `group` (`neon`, `sign`, `lamps`, `spots`, or your own), `color` (hex) and
  `kind` (`spot`, `point`, `emissive`).
- Glowing meshes use a material named **`EMIT_<group>`** (e.g. `EMIT_neon`). The engine animates their emissive colour
  and intensity per group.
- Export with `export_lights=False`; the engine creates the few real lights it needs from `LIGHT_*` of kind
  `spot`/`point`.
- `scene.json lights.programs` lists the light programs offered; `lights.groups` gives each group its default colour.
- The five **lighting states** (Preshow, Show, React, BRB, Outro) work on every room automatically: they scale the
  "house" (every non-`EMIT_` material), drive the `EMIT_` groups and the effects rig. Nothing to author beyond good
  group names. See [SCENES.md "Lighting states"](SCENES.md#lighting-states).

## 10. Validate and test

1. **Validator** (errors must be zero; warnings are quality items):
   ```
   python tools/aiconnect_package.py room assets/scenes/<id>
   ```
   (MCP: `validate_room {roomId}`; also `node tools/gltf_validate.mjs assets/scenes/<id>/scene.glb`.)
2. **Look at it without touching the live show**: open the OBS page in test mode, which never follows the live scene
   state: `http://127.0.0.1:5191/output.html?sceneTest=<id>` (or through the dev port). Close it when done: an open
   render tab costs the streamer's GPU.
3. In an observer studio (`http://localhost:5190/?observer=1`), check every camera, React mode, each lighting state and
   the walk-in.
4. Take `preview.png` / `thumb.png` from `CAM_WIDE` if your build didn't render them (BLENDER_PLAYBOOK §11.4).

**Common failures**

| Symptom | Cause | Fix |
|---|---|---|
| Spot `pose` missing | exported without extras | `export_extras=True` |
| Avatars face the wall | spot rotated the wrong way | Blender −Y is the facing direction |
| "No default camera" | camera not named `CAM_WIDE` / not exported | name the object, `export_cameras=True` |
| Screen stretched / upside down | not 16:9, UVs rotated, transforms not applied | rebuild the plane, apply transforms |
| Avatars float or sink | floor not at 0, `seatHeight` wrong | measure the seat surface |
| Glow doesn't animate | material not named `EMIT_<group>` | rename |
| Room too dark / washed out | real lights exported, exposure | `export_lights=False`; tune `ambience.exposure` |

## 11. scene.json

Minimal:

```json
{ "id": "my_room", "name": "My Room", "model": "scene.glb",
  "preview": "preview.png", "thumbnail": "thumb.png",
  "modes": ["talk", "react"], "defaultCamera": "CAM_WIDE", "reactCamera": "CAM_REACT",
  "avatarHeight": 1.5, "hostSpot": "SPOT_01",
  "ambience": { "fog": "#0b0d12", "fogNear": 18, "fogFar": 44, "background": "#0b0d12", "exposure": 1.0 },
  "lights": { "programs": ["show", "steady", "beatPulse", "party"], "groups": { "neon": "#ff4fd8", "lamps": "#ffd49a" } } }
```

Optional systems (all additive): `environment` (time of day, weather), `screenSkin`, `interview`, `club`, `areas`,
`lightRig`, `soloScreens`, `cameraOverrides`, `raid`, `space`… each is documented in [SCENES.md](SCENES.md). Build
scripts should **keep hand-added keys** when they rewrite scene.json (see §15).

## 12. Fixing a room without re-exporting

In `scene.json` (applied at load, before anything else reads the room):

```json
"spotOverrides": { "SPOT_12": { "pos": [2.9, 0, 2.35], "yaw": -18, "approach": [2.0, 0, 3.0] } },
"hideNodes": ["BrokenLamp", "Plant_03"],
"cameraOverrides": { "CAM_WIDE": { "pos": [0, 1.6, 9], "target": [0, 1.1, 0], "fov": 38 } }
```

`spotOverrides` moves or turns a seat (glTF space), `hideNodes` hides props (never drawn or ray-tested). Good for quick
fixes; fold them into the build script when you rebuild. Size-specific seating (`sizes` on spots, perches for micro
avatars, back-row spots for macro ones): [SCENES.md "Avatar size classes"](SCENES.md).

## 13. Areas (several places in one room)

One `scene.glb` can hold a foyer, a bar and a deck. Prefix every area's nodes with `<AREA>__` in upper case
(`BAR__SPOT_01`, `BAR__CAM_WIDE`); unprefixed nodes are shared. List them in scene.json:

```json
"areas": { "foyer": { "name": "Grand Foyer", "label": "Foyer", "icon": "🏛" },
           "bar":   { "name": "Lounge Bar",  "label": "Bar",   "icon": "🍸" } },
"defaultArea": "foyer"
```

Each area then behaves as its own room (`<room>~<area>` ids). First user: `assets/scenes/sc_890jump`. Details:
[SCENES.md "Areas"](SCENES.md).

## 14. Budgets and baking

| | Limit |
|---|---|
| Visible triangles | **≤ 80,000** (validator error above) |
| `scene.glb` size | **≤ 25 MB** (error above) |
| Draw calls | ≤ ~170–180 (join static meshes that share a material) |
| Materials | ~20–40 |
| Textures | atlases ≤ 2048², tiling textures ≤ 1024², PNG/JPEG |

Room shadows are off, so **bake** ambient occlusion and light pools into vertex colours (`COLOR_0`, exported with
`export_vertex_color='ACTIVE'`) or into textures. Mid-dark walls with warm pools of light flatter toon avatars; tune
`ambience.exposure` (0.1–3) instead of darkening everything. Performance notes: PERFORMANCE.md.

## 15. Worked example: the VTube Pro Studio

`assets/scenes/vtubepro_studio/` is the shipped sample room: 100 % scripted in Blender, safe to copy.
52.6k triangles, 3.6 MB, ~84 draw calls, lighting baked into vertex colours. Read its `README.md`, then the scripts:

| File | What to learn from it |
|---|---|
| `blender/vs_paint.py` | paints the texture atlas with Pillow (no downloaded art) and writes `layout.json` |
| `blender/vs_lib.py` | the toolkit: `G()` coordinate helper, `mat()` materials from the atlas, `box`/`cyl`/`lathe`/`quad` bmesh primitives, `add_bm()` buckets, `join()` per material, `bake()` vertex-colour AO + light pools |
| `blender/vs_room.py` | the room itself, as `@step(...)` functions: floors → walls → screen wall → desk → truss → gaming corner → nook → door → LEDs → **anchors** → bake → **export** |

The steps that matter for the contract, in order:

1. **Constants first.** Half width `XW = 8`, back wall `ZB = -4.5`, ceiling `YC = 5.2`, stage riser `STG = 0.14`,
   screen `SCR_W = 5.2` (height = width × 9/16). Every later position derives from these, so resizing is one edit.
2. **Floors** (`floors()`): the visible floor, the round riser, and a hidden `floor_stage` prism that becomes
   `FLOOR_STAGE`, so walkers step up onto the riser.
3. **Anchors** (`anchors()`): an `empty(name, x, y, z, yaw, **props)` helper creates each node with its extras, e.g.
   `empty('SPOT_01', x, STG, z, yaw, pose='sit', seatHeight=0.5, seatDepth=0.46, label='Talk desk (host)',
   approach=flat(path, STG), leavePathAt='PATH_03')`. A `cam(name, loc, target, fov)` helper creates cameras that
   look at a target (`to_track_quat('-Z', 'Y')`).
4. **Bake** (`bake_step()`): joins buckets per material, builds a BVH and bakes a key direction, fill, ambient and a
   list of coloured light pools into vertex colours. Colliders, `SCREEN`, `LIGHT_*` and `FLOOR_*` are skipped.
5. **Export** (`export()`): glTF with `export_cameras=True, export_lights=False, export_extras=True,
   export_vertex_color='ACTIVE'`, then a small post-pass on the GLB JSON that sets `EMIT_*` emissive colour and
   strength and group extras, and makes `M_Hidden` invisible. It counts triangles, then writes `scene.json`
   **keeping hand-added keys** (`cameraOverrides`, `soloScreens`, `interview`…), saves the `.blend` and prints
   `ROOM_OK <tris> <bytes>`.

Rebuild it (from its folder; Blender at low priority):

```text
python blender\vs_paint.py
tools\blender_low.cmd -b --factory-startup --python <abs path>\blender\vs_room.py          # headless
blender.exe --factory-startup --python <abs path>\blender\vs_room.py -- --live             # watch it build
```

Set `VTP_ROOM_OUT=<folder>` to write somewhere else, so you can experiment without touching the shipped room. To start
your own room, copy the folder under a new id, change `ROOM_ID` and the constants, delete the parts you don't need and
keep `anchors()`, `bake_step()` and `export()`.

A smaller, fully validated example that an AI can also produce: `tools/aiconnect_examples/build_ramen_bar.py`
(a ramen bar with 4 stools, a booth, a door with a hallway, a screen, neon; [AI_CONNECT.md §11](AI_CONNECT.md)).
