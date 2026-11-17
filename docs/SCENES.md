# VTube Pro 3D Scenes — contract

> AI builders: the end-to-end "build or modify a room" checklist + creation packages + validator are in docs/AI_CONNECT.md.

Scenes are 3D rooms the avatars (host + up to 11 party guests) live in, rendered in the studio AND the OBS
output page. Everything an engine needs is authored in the scene GLB as NAMED EMPTIES / NODES, so any room
built in Blender to this contract "just works".

Folder: `assets/scenes/<id>/` → `scene.glb`, `scene.json`, `preview.png`, `thumb.png` (+ sources/build scripts).
Units: metres, +Y up (glTF), the room's "stage front" faces +Z (towards the default camera).

## Named nodes in scene.glb

| Node name | Meaning |
|---|---|
| `SPOT_01` … `SPOT_12` | Avatar positions. Node origin = where the avatar's root (feet / hips projected to the floor) goes; the node's **+Z axis is the direction the avatar FACES**. Custom property `pose` = `"sit"` or `"stand"` (glTF extras). For `sit`: extra `seatHeight` (m, seat surface above the node origin) and optional `seatDepth`. Optional `label` ("Couch left", "DJ desk"). Optional `sizes` (size classes it takes, e.g. `["micro"]` for a shelf perch — see "Avatar size classes"). |
| `SPOT_xx_CAM` | (optional) camera node for the "talk" framing of that spot; else the engine auto-frames. Camera looks down its -Z (glTF camera convention). |
| `DOOR` | The door leaf; its origin is the HINGE, it rotates about its local +Y. extras: `openAngle` (deg, default 95). |
| `DOOR_OUTSIDE` | Where an entering avatar spawns (just outside the door). |
| `PATH_*` | (optional) waypoints `PATH_01…` from the door to the room centre; the engine walks avatars DOOR_OUTSIDE → PATH_* → nearest approach to their spot. |
| `SCREEN` | The react screen (a plane mesh, UVs 0..1, 16:9). Its node is animated by the engine: rolled up / hidden at rest, drops down in react mode. extras: `restOffsetY` (how far above its shown position it rests, m). The screen surface is rendered as a transparent "hole" in OBS output (passthrough) and optionally shows a desktop capture in the studio. |
| `CAM_WIDE`, `CAM_REACT`, `CAM_*` | Named camera presets (glTF cameras). `CAM_REACT` frames the screen so it fills ~80% of the output. A preset is a snapshot of the node at room load, unless it is **live** (`CAM_LIVE_*`, or extras `live: true`): then it follows the node every frame. See "Live (moving) cameras". |
| `LIGHT_*` | Light fixtures / emissive props the light system drives. extras: `group` (e.g. `"neon"`, `"spots"`, `"lamps"`, `"sign"`), `color` (hex), `kind` (`"spot"`, `"point"`, `"emissive"`). Emissive meshes use a material named `EMIT_<group>` so the engine can modulate emissive intensity/colour. |
| `FX_BEAM_xx`, `FX_LASER_xx`, `FX_BALL` | (optional) anchors for the lighting-state effects rig: moving-head beam apexes, laser-fan origins, the mirror ball. Empties. Alternative without a rebuild: `scene.json lightRig { beams: [[x,y,z]…], lasers: [[x,y,z]…], ball: [x,y,z] }` (glTF space). Neither = an automatic ceiling grid. |
| `COLLIDE_*` | (optional) simple meshes the walk path must avoid (not rendered). |
| `BG_*`, `EVENT_TAGILLA_*`, `SMASH_xx` | (optional) background combat + the Tagilla donation event — see "Background combat" at the end. |
| `AUDIENCE_SEAT_xx`, `AUDIENCE_AREA_xx`, `CAM_AUDIENCE` | (optional) The chat audience: single seats / blocks of seats facing the stage (+Z), filled with everyone active in chat, names above their heads — see **Chat audience** below. scene.json `audience` does the same without re-exporting the GLB. |
| `SCREEN_SOLO_xx` / `SCREEN_SOLO` | (optional) where the **solo react** side screen hangs when the host sits at SPOT_xx (`SCREEN_SOLO` = any spot within 4.5 m). Empty; origin = centre of the shown surface, +Z = the side it faces (towards the camera / host), extras `width` (m, default 2.4; height = width × 9/16). Without one the engine derives a spot beside the host (camera-right), clear of COLLIDE_* boxes and walls. scene.json `soloScreens` does the same without re-exporting the GLB. |
| `TIMER_DISPLAY[_xx]` | A **mesh with UVs** that shows the live subathon countdown (Goals & subathon), drawn onto its UVs: big `H:MM:SS` digits, a `+10:00` pop when time is added, and small badges for happy hour, hype, sleep, paused and test mode. Use a flat plane (or any flat part of a prop) with a normal unwrap: the countdown fills the UV rectangle the mesh uses, upright, never stretched. Several are fine (`_01`, `_02`: every one shows the same clock). Optional custom properties: `style` (`digits`, `neon`, `lcd`), `color` (hex; default = the mesh's own glow colour, else the stage accent), `show` (`remaining`, `uptime`, `both`; default = what the subathon is set to show), `label` (short caption), `fit` (0.3 to 1, default 1: shrinks the glass panel and the digits about the centre of the mesh; use about 0.8 when the plane is bigger than the glowing thing it sits behind, so the clock is set into it instead of flush with its rim), `glass` (0.5 to 1, default 0.95: the panel's opacity; lower lets the mesh's own picture show through). With no subathon running (or Goals → On stream → **In the room** off) nothing is drawn and your own material shows. Or scene.json `timerDisplays` on an existing mesh, no re-export (`timerDisplays`, see **In-room timer displays** below). |

## scene.json
```json
{ "id": "my_room", "name": "the VTube Pro studio", "model": "scene.glb",
  "modes": ["talk", "react"], "defaultCamera": "CAM_WIDE",
  "ambience": { "fog": "#0b1a12", "fogNear": 6, "fogFar": 30 },
  "lights": { "programs": ["swampGlow", "onAir", "beatPulse", "strobe"] } }
```

## Runtime (engine side)
- Scene state is HOST-owned and broadcast to OBS + party: `{ sceneId | null (classic), mode: 'talk'|'react', camera, spotAssignments: {peerOrSelf: spotIndex}, present: {peer: bool}, lights: {program, reactive, intensity} }`.
- Classic mode (`sceneId: null`) = today's transparent avatar-only output.
- Entrances: when an avatar becomes present it spawns at `DOOR_OUTSIDE`, the door opens, it walks the path to its spot, turns, sits/stands; exits reverse it.
- Host picks their spot first; guests are auto-assigned free spots; the host can drag people to other spots in the studio.

---

# Scene engine (implementation notes)

Code: `src/scene/` (+ `shared/scene.ts`, `server/routes/scenes.ts`, `src/ui/scenePanel.ts`). A grey-box room that
follows this contract lives in `assets/scenes/test_room/` (rebuild: `tools\blender_low.cmd -b --factory-startup
--python assets/scenes/test_room/build_test_room.py`).

| File | Role |
|---|---|
| `shared/scene.ts` | `SceneState` defaults + sanitiser (server, studio, party guests all use it) |
| `server/routes/scenes.ts` | `GET /api/scenes`, `GET /api/scenes/:id/file/*`, `GET/PUT /api/scene` (→ `cache/scene.json`, broadcasts `{type:'scene', state, self:'@host'}`) |
| `src/scene/contract.ts` | parses a scene GLB into `RoomInfo` (spots, door, path, screen, cameras, fixtures, EMIT_ materials) |
| `src/scene/SceneRuntime.ts` | renders the room in the OBS page / preview: places actors, cameras + smooth moves, modes, screen, hooks |
| `src/scene/actor.ts` | per-performer placement: height normalisation, seat drop, seated legs (under the tracking) |
| `src/scene/screen.ts` | react screen: drop animation, OBS passthrough hole, preview placeholder / window capture, OBS rect |
| `src/scene/cameraRig.ts` | eased camera transitions |
| `src/scene/mover.ts` | **AvatarMover** hook (entrances / exits / moves) + placeholder `PopMover` |
| `src/scene/walkMover.ts` | **WalkMover** (installed by `output.ts`): door, walks, sit / stand, door queue, host-timed sync |
| `src/scene/navigation.ts` | floor nav: authored lanes + COLLIDE_* box avoidance → Catmull-Rom path (arc-length baked) |
| `src/scene/locomotion.ts` | procedural pose layer: walk cycle (IK, planted feet), arm swing, head damping, idle weight shift, hop |
| `src/scene/lights.ts` | **SceneLights** hook + placeholder `SteadyLights` |
| `src/scene/controller.ts` | studio side: host-owned state, persistence, party relay, seat rules, director API |
| `src/scene/previewLink.ts` | studio ⇄ `output.html?preview=1` link (the preview never reads the bus / server scene state) |

### State flow
Host / solo studio → `PUT /api/scene` → server saves `cache/scene.json` and broadcasts to this PC's OBS pages; and
→ party wire `{t:'scene'}` → each guest studio → its local bus `{type:'scene', state, self:<guest id>}` (re-sent every
2 s) → the guest's OBS pages. `sceneId: null` = **Classic** (today's transparent avatar-only layout, party side by
side). A guest can tick "Classic on my OBS" (local only). Member keys: `'@host'` = the host, else the party id; the
host's party id travels as `state.hostId`. OBS pages render every party member at their spot.

Seat rules (controller): the host's pick always wins; guests without a seat get their remembered seat (per room, by
Discord user id — stable across reconnects — or by NAME for invite-code guests, so a reconnect with a new party id sits
in the same place) or the first free spot; moving someone onto an
occupied spot swaps the two. Presence (`present[key] === false`) takes a performer out of the room (exit via the mover).

### Cameras
`state.camera`: `talk` (medium shot of `state.focus` at their spot), `group` (everyone present), `wide` (`CAM_WIDE` or
automatic), `react` (`CAM_REACT`, or automatic so the screen fills 80% of the frame), or any `CAM_*` name. Moves ease over
`state.transition` s (0 = cut). React mode drops the screen and switches to `react`; Talk puts it away and returns to
`talk`. Director API: `app.scene.setCamera/setMode/setScene/setFocus/move/setPresent` or a bus command
`{type:'command', command:'scene', args:{camera?, mode?, sceneId?, focus?, curtain?}}` (room changes play the
room-change transition — see "Room-change transitions" at the end).

**Automatic framing** (`src/scene/shotSolver.ts`, used by `talk` and `group`): candidates around the preferred direction
(talk: 16° off the performer's facing towards the room centre, ±55°, 5 heights; group: CAM_WIDE's direction, ±36°,
3–26° down), each framed on the ACTUAL faces and head tops (measured face + height × scale — micro / macro performers
and big heads frame the same), then kept inside the set: talk cameras are pulled in front of the first wall between
the face and the camera (lens widened to keep the framing); group cameras step in past walls seen from behind and dolly
towards the group until ≥ 70% of the faces are in line of sight, then widen to fit everyone from where they stand.
Scored with room rays (BVH; the renderer's own culling — back faces don't block): faces hidden by the room or anyone
else (5 points each), out of frame, seen from behind / in profile, a neighbour's face half cut by the frame edge, the
camera inside geometry / inside a performer / behind a wall, view rays (frame edges included) that meet nothing
(void — indoors any direction; outdoor rooms with an `environment` / `town` engine draw sky, sea and horizon, so only
a steep look down into nothing counts; `epoch` / `space` rooms: the open void is the designed backdrop), clutter right
in front of the lens, distance from the preferred direction, lens widening. Cheap framing for all
candidates, rays in score order (~2–20 ms, only when the shot's inputs change: cached per focus / seats / scales /
aspect). The shot key carries a pose hash, so a re-solved shot (someone sat down in the way) moves like any other
camera change. Debug: `vtpOut.scene.shotInfo` (source, score, notes, ms).
- **Talk**: an authored `SPOT_xx_CAM` is validated with the same score and kept when clean (re-aimed + zoomed to the
  real face when it sits outside 22–50% from the top or is outside 8–30% of the frame height — avatar size classes);
  when the face is hidden / the performer is seen from behind, the solver's shot replaces it. Face ≈ 15% of the frame
  height (`talkHeight`: face × 13, bounded by 0.46–0.95 × body, and always the whole head + a little head room).
- **Group**: every present performer's head + chest in frame with margin; people in the back row must not be hidden
  by the front row (a higher camera is preferred then). When no candidate sees them together (seats behind walls from
  each other), the room's `CAM_WIDE`.
- **Solo React (Auto layout)**: when the solo two-shot can't be clean at that spot (screen or host hidden — a DJ booth,
  a podium), React uses the room's big SCREEN instead (`reactLayout: solo` still forces the side screen).
- **Moves never fly through walls**: a camera move whose straight path (or its mid-move lift / the solo arc) crosses
  the room cuts instead.
- `CAM_REACT` / `SCREEN_SOLO_xx` are never changed automatically: a manual OBS Window Capture is lined up with them.

**Authored cameras without a GLB re-export** — scene.json `cameraOverrides` (and `cams`, which some room builders
write as a mirror of their GLB cameras; `cameraOverrides` is applied last and survives a rebuild), glTF space:
```json
"cameraOverrides": { "CAM_DOOR": { "pos": [x,y,z], "target": [x,y,z], "fov": 48 },
                     "SPOT_09_CAM": { "pos": [x,y,z], "target": [x,y,z], "fov": 30 },
                     "SPOT_04_CAM": null, "note": "why" }
```
adds / replaces `CAM_*` presets and talk cameras; `null` removes an authored one (that spot then gets the automatic
framing). Rules for authored cameras: stand inside the set (in front of the fourth wall is fine only if nothing
unmodelled shows at the frame edges), never inside furniture, faces unoccluded at the room's `avatarHeight`, head room
~8–15% of the frame, the talk subject's face 20–45% from the top; `CAM_DOOR` looks at the inside of the doorway and
shows no void anywhere in the frame (the follow camera only uses it then). Chat anchors on furniture: the display
(portrait monitor = width × 4/3 tall) must stand ON it — its centre ≥ half its height above the top.

**Room fixes without a GLB re-export** (src/scene/spotOverrides.ts, applied when the room loads, before the mover):
scene.json `spotOverrides: { "SPOT_12": { "pos": [x,y,z], "yaw": deg, "approach": [x,y,z,…] } }` moves / turns an
authored spot (glTF space; a moved spot keeps only approach waypoints within 3 m unless `approach` is given), and
`hideNodes: ["NODE", …]` hides broken props (never drawn or ray-tested) until the room is rebuilt.

**The performer's own edits** (Room editor, docs/ROOM_EDITOR.md): cameras, places, the react SCREEN, solo / chat displays,
placed props and live camera tweaks are kept per user in `<data>/room-edits/<room id>.json` (never in the room folder),
listed as `userEdits` by `GET /api/scenes` and merged over scene.json when a page loads the room (`cameraOverrides`,
`spotOverrides`, `soloScreens`, `chatMonitors`, `chatBoards`, `buddySpots`, `screenEdit`, `placedProps`, `camTweaks`). A Save
is applied in place on the pages showing the room (`SceneRuntime.applyEdits`, bus `{type:'roomEdits'}`).

**Live (moving) cameras**: cockpit, chase and fly-through shots. An ordinary preset is captured once, when the room
loads. Parenting its node to a moving ship, or keying it in a room clip, doesn't move the shot. A **live** preset
re-reads its node's world pose every frame, so it rides whatever moves the node:
- room clips (ships in a baked battle, a camera keyed along a path);
- parents;
- engine-moved nodes (`BOB_xx` ships).
- **Opt in**, per camera node, in either of two ways:
  - name it `CAM_LIVE_<NAME>`;
  - or give an ordinary `CAM_*` / `SPOT_xx_CAM` / `CAM_SEAT_xx` node the extras `live: true`. In Blender that's a
    custom property on the camera object, or on its camera data. `1`, `"true"` and `"1"` also count.

  Every other camera behaves exactly as before.
- **Optional `lookAt`**: extras `lookAt: "<node name>"`. The camera keeps its own (moving) position but aims at that
  node's world origin every frame. It uses world up, so the horizon stays level. Without `lookAt` it uses the node's
  own rotation, so a cockpit camera banks with its ship. An unknown name logs a warning, and the camera then uses its
  own rotation.
- **Multiplayer sync**: room clips run on the shared room clock (see "Room animation clips"), so every OBS page, the
  studio preview and every party guest render the same shot at the same moment. The sync is automatic; nothing new
  goes in SceneState. A cut to a live camera lands wherever its clip is on the clock at that moment.
- **Using one**: a live preset is an ordinary camera choice:
  - the Scene tab camera list;
  - the bus command `{command:'scene', args:{camera:'CAM_LIVE_X'}}`;
  - scene.json `defaultCamera`;
  - the raid `CAM_RAID*` and kitchen riot shot lists;
  - the `?cam=` pin below.

  Moves into it ease over `state.transition`, as usual, towards the moving target. Once settled, the camera is exactly
  on the node every frame.
- **Priority**: the entrance follow-cam comes first. Then the `cameraOverride` directors (the raid preshow, kitchen
  riots). Then the page's `?cam=` pin (Talk mode only, see below). Then `state.camera`. A director that picks a live camera holds a copy of its
  pose, but the runtime still follows the live node for as long as that shot lasts.
- The Room editor's live camera quick-adjust (orbit / tilt / dolly / height / lens, `camTweaks`) works on a live camera too: it
  is applied on top of the moving pose every frame. Saving Room-editor edits keeps a live camera live.
- A live `SPOT_xx_CAM` is used as authored for `talk`: it isn't re-aimed or validated by the solver. The seat is
  assumed to move with it.
- A node scaled to nothing, such as a ship's pop-out scale key, keeps the camera at its last good pose.
- Passthrough react: the OBS hole never opens under a live shot, because a moving camera can't line up a fixed Window
  Capture. Use in-scene capture there.
- scene.json `cams` / `cameraOverrides` entries with the same name replace the preset with a static one.
- The camera looks down its -Z, like every glTF camera. Its FOV comes from the glTF camera (default 35); FOV is not
  animated.
- Example: the starship room. A chase camera on a baked Buccaneer, and a telephoto tracker on the deck:

  | Node | Parent | Extras |
  |---|---|---|
  | `CAM_LIVE_BUCC_CHASE` (a camera) | `BTL_G1_BUCC_A` | `{ "lookAt": "BTL_G1_BUCC_A" }` |
  | `CAM_TRACK_BUCC` (a camera) | (room root) | `{ "live": true, "lookAt": "BTL_G1_BUCC_A" }` |

- Debug: `vtpOut.scene.liveCamera` is the live preset the shot rides now, or null.

**Per-page camera pin (live OBS pages)**: `output.html?cam=CAM_X`, or `?cam=wide|group|talk|react`. That page shows
that camera instead of the host's `state.camera`, as long as the current room has it and the host is in plain **Talk**
mode. In any other room, in React, in Gaming or any other stage mode / layout, and during a raid interrupt, the page
follows the host's camera. Several OBS Browser Sources with different `?cam=` values give you several angles of the same
live room. OBS (hotkeys, Advanced Scene Switcher) can then cut between them.
- A pinned page never reports the React hole to OBS automation: there is one Window Capture, and the unpinned page owns
  it. Keep at least one page without `?cam=` (your main source) if you use passthrough React.
- Everything else a live page does, a pinned page still does: it reports its performance and transition status, and
  sends the room engines' show sounds to the studio like any other OBS page. The pin itself is page-local; nothing about
  it is sent to the host or to other pages.
- Chat props (the chat monitor, the support board) are placed for the host's camera, so on a pinned angle they may not be
  framed as well.
- Test pages (`?sceneTest`) already read `&cam=` as the test state's camera.

**Camera QA harness** (`tools/cam_eval/`, test pages only): renders every room × shot type — solo talk + solo React at
every spot, group / wide / big React for 2…12 performers, a pair at every spot, talk on every spot with the room full,
every `CAM_*` preset, and the walk-in follow camera to every spot — with the chat monitor + support board on, scores
each frame with `src/scene/camEval.ts` (`vtpOut.camEval()` on `?sceneTest` pages: faces in frame / size / head room /
hidden by what, void pixels, camera outside the set or inside geometry, lens clutter, react screen framing +
occlusion, chat props over faces / the screen / hidden) and writes contact sheets + a summary table. Run it after any
room or camera change (see `tools/cam_eval/README.md`).

### Framing guarantee — `src/scene/frameGuard.ts`, `shared/framing.ts`
Every solved shot that frames people passes a post-solve check before it is used (desert_walker/SPEC.md §2.7): each
framed face box (forehead 1.15, chin 0.8, cheeks 0.6 face sizes) inside its shot family's safe area, the head top (hair,
ears, a mascot head) in the frame, with the room's **motion envelope** taken off the edges, and the shot still showing
the faces (9 face points past the room and everyone else, never the back of a talker's head, never inside a performer).
- **Safe areas** (NDC; `EVAL_SAFE_BY` = the severe line in cam_eval `face-safe`; the guard fixes to 0.03-0.04 inside):
  talk / interview singles / TTRPG close-ups / the solo React host x 0.82, top 0.84, bottom 0.94; group / two-shot /
  establishing / wide x 0.84, top 0.86, bottom 0.94; the call-in picture (a remote guest in their panel) x 0.9, top / bottom
  0.88; gaming tiles title safe (0.9). scene.json `framing.safe` overrides (`talk`, `group`, `picture` or any family).
- **The DRAWN face** (`src/scene/faceDepth.ts`, measured once per avatar at rest in `measureRest` — the same on every
  page): the face the runtime reports is an anchor (procedural markers, VRM eye bones, the head bone). A mascot whose eye
  bones sit close together deep inside a big head (one model) reports the space between its eyes; framing that cut the real
  eyes at the frame edge. Where the profile's eye / mouth markers (any eye mode) lie outside the reported box, or the
  anchor is deep inside the head, the drawn face holds both eyes, the brows and the mouth with a chin (a robot's mouth far
  below its eyes too); no markers and an anchor more than 1.5 face sizes behind a face-wide surface: centred on that
  surface. Pinned to the head bone (it follows the live head). Human faces are left exactly as reported. Everything that
  frames or scores people uses it: `SceneActor.drawnFaceAt(spot)` (static) and `drawnFace(runtime)` (live) — the shot
  solver's subjects, the guard, the live guard, the interview set, tile cams, the TTRPG director, the remote studios,
  cam_eval. Body volumes (head sphere, torso box) go round the head's middle (`ShotSubject.head`), never in front of the
  drawn face.
- **The re-solve ladder** (the first that passes wins): 1. refit the aim + lens from the same position (the smallest
  change; never zooms in); 2. the lens at its limit: dolly back (the rig's step, up to its reach; the path clear, never
  inside / behind anything or anyone, every face still in sight; a path gives up after 3 steps in a row that still don't
  see the faces), then 8° higher; 3. the solver's next candidates (they must see the faces), `CAM_WIDE` and a front-on
  shot from the subjects' facing at the rig's elevation — each refit as it stands first; 4. the same spot raised in steps
  under the ceiling (0.35 m up to 2.5 m; a giant on the set: a tenth / 0.6 of its height); 5. the step-3 fallbacks dollied
  back; 6. a ring search round the framed faces (24 bearings × 4 distances × 5 heights, every 45° round first, then
  nearest the solved view; never from behind them; screened without rays). Nothing clean: the least bad view (faces seen
  first, then never inside / against anything, then the framing).
- **Count-bounded, never timed** (desert_walker/SPEC.md R3): a pose's quality is tested cheapest first and at most once
  per ladder (line-of-sight rays shared), the lens clearance is one distance query, and a ladder stops at its ray budget
  (`ladderBudget`: 1000 ray tests for one face, 400 more per extra face, at most 2200; the dollied fallbacks get a quarter
  of it, the ring search keeps the rest) and keeps the best framing found.
  A shot that is fine as solved costs one quality test (44 ray tests for one face indoors: 9 face points, 12 lean points,
  9 clutter and 14 void rays). **Spec deviation (R3 says <= 40 ray tests per ladder): the spec is wrong because** a
  ladder that must find a clean view for a big host and guests cannot do it in 40 tests (one quality test is already 44;
  with 2 lean points instead of 12 faces were missed - severe "33 % hidden" frames), and a ladder that gives up at 40
  shows the hidden face. What R3 protects - every page picks the same shot - holds: the budget is a COUNT (deterministic,
  `--det` 0 different). The price is a capped ladder of 40-73 ms headless (one interview shot per frame while
  `warmShots()` fills the book after a line-up change); a normal room stays at one 44-test check. The solvers' own time caps
  are gone too (the shot solver and the interview book stop on candidate counts only): a slow page picks the same shot.
  `FrameGuard.stats` / cam_eval `guardStats()` report ladders, ray tests and the slowest ladder. "Clean" =
  framed AND every framed face seen (9 points, also with the head leaned / slumped a few cm; clear glass doesn't hide a
  face, mullions do; a mech's hull is a body box that hides what is behind it), never the back of a talker's head (an
  interview single: never past 90°), never inside a performer, no view ray into the void (indoors; outdoors only steep
  looks down), the lens never against a surface (a drawn surface within 0.3 m on 3 of 9 view rays, or any surface within
  0.07 m in 14 directions: the 0.03 m near plane would cut into it and show the inside of a beam as void) and never
  looking up at a face more steeply than 42° (from under a giant the chin / collar covers the face). Line of sight aims
  at the drawn face's surface (`ShotSubject.depth` / `GuardTarget.depth`: a nose or snout in front of the drawn centre;
  cam_eval scores occlusion the same way). Live heads get a depth slack (a lean towards the lens grows the face box).
  Settled positions only: every page picks the same shot.
- **History-free**: the framing rays test the room AT REST (`snapshotRest` when the room loads: a door that swings open on
  an entrance is ray-tested closed, whenever a page solves). A room transform that SETTLES (the forms engine: desk modules,
  a table slide, the dock gantry, back in the occluders) calls `SceneRuntime.refreshRays(settled?)`: `resettleRest`
  re-takes the rest pose of what moved (the named nodes; else every snapshotted occluder except continuous movers and the
  DOOR) and the rays, probe, seat planning and shot caches are rebuilt — a desk that slid into a sight line is met by every
  solver, the guard and sizeSeat (a settled form is a closed-form pose of the state: a late page takes the same pose);
  the shot solvers and the guard skip every room part an engine
  KEEPS animating (`noteMovers`, every 0.25 s: moving at 8 checks in a row — a roaming drone, a flag, a turning ring or
  turret, battle FX; `RoomRays.skipMovers`; the cached shots re-solve once; every page converges on the same set within
  2 s of loading — walk-in planning and seating still see them where they are); set pieces an engine adds later are
  tested where they are, their boxes re-taken when they move. A walk-in operator counts as too close to a big walker in
  proportion to its height (a 4 m walker passing 1.5 m from it is out of any lens). cam_eval scores a face hidden only
  by such a part as `mover` (severity 2: a moment, not the camera); a mech's hull is its rest box at the seat (never the live bounds
  of an idle wing beat). **Big bodies get room**: a guest whose seat puts their face inside a
macro / giant / mech performer's rest box at its seat is seated at the nearest free seat that suits their size and is
clear of every big body (`SceneRuntime.clearOfBigBodies`, page-side, a pure function of the line-up + rest measures;
seats a room form's spot hook gave are left alone; nothing changes without a big performer); shot caches key on each performer's spot, size, framing class and model; manual interview cuts
  carry their subject (`InterviewBag.subject`, stamped by the host's studio; unstamped: a fixed default — a push-in on
  the host, an over-the-shoulder towards guest 1 — never whatever that page had on air). A reloaded OBS source or a
  late guest solves the same shots as the studio (cam_eval `--det` checks it).
- **Where it runs**: `ShotSolver.solve` (talk + group), the wide shot (a fringe face: the same position re-aimed / widened,
  else the group shot), the interview shot book (`talkshow/shots.ts`; pinned `interview.shots` are left alone; an OTS /
  reverse / push that can't be clean becomes the plain single of the same person; an establishing / two-shot nobody can see
  clean falls back to the room's guarded wide; the monitor's 4 corners are hard points of a two-shot with it), gaming tile
  cams, the solo React two-shot (the screen may reach the frame edge: OBS lines its capture up with it), the TTRPG table's
  seat close-ups and authored wide (no clean close-up: the room's talk shot), every walk-in follow-camera step and a room
  mover's own entrance cinematic once the performer is in the room (re-aim / widen only), and
  `SceneRuntime.guardPose(pose, keys, family)` for any engine's own camera (cutaways, exterior drones, entrance cinematics;
  `subjectFor(key)` / `openOk` for engines that frame people themselves). A solo React two-shot that can't keep the host's
  face is marked poor (React Auto uses the big screen). Every cache of a guarded shot keys on the motion envelope
  (`SceneRuntime.motionSig(family)`: talk / group / wide, the interview book, the TTRPG table's wide) — a battle starting
  re-guards with its margin. React's solo two-shot and the Gaming / React tile cams take only the room's fixed sway
  (scene.json `framing.motion`): the deck never shakes in React or Gaming and their camera never moves (an event never
  re-solves them under an open OBS hole). Debug: `vtpOut.scene.shotInfo` notes (`guard: refit | dolly |
  alternate | wide | rise | front | search`), the interview's `vtpInterview.book.info()`.
- **Giant back-row spots** (`sizeSpots.ts`, automatic macro spots): the face of any giant the spot may hold, up to its
  clearance clamp, must be in plain view from the camera side (eye and crane height) with room around the head.
- **Rigs per framing class** (`RIGS`, the spec's table; scene.json `framing.rigs.<class>` in the same format: `{ "elev":
  [-14, -4], "fov": 38, "camHeight": 0.55, "minDist": 0.35, "group": "hull" }`): `micro` 0..4° / 26° / min 0.35 m, `small` +
  `normal` the classic eye-level grid (normal = exactly the old candidates), `large` −3..6° / 30°, `macro` −14..−4° low
  hero / 38° / camera at 0.55 of the shown height (clamped into the range), `mech` (profile `body: 'mech' | 'vehicle'` or
  a `mech` block) −10..2° / 34°: a cockpit talk shot framed on the PILOT's head (`top` = the pilot's head, never the hull)
  and a hull group shot (`ShotSubject.hull`: the whole walker framed with the group; soft points for the guard).
  `FrameGuard.classHook(key)` lets an engine say better (the forms engine's occupant class).
- **Live drift guard** (`LiveGuard`; scene.json `framing.live`: `false`, or `{ "maxTurnDeg": 6, "maxZoom": 1.18, "omega":
  4 }`): on SceneRuntime's own talk / group / wide shots (or a director shot that names `subjects` in its
  `cameraOverride` result), settled, no OBS hole, not React. No timers (desert_walker/SPEC.md R4): the correction is a
  smooth function of how far a live face is past the fix area as seen from the rig's own pose — 0 inside it, in full at
  the evaluation line (`liveWeight`) — the refit that brings it back (aim at most 6°, the lens the rest, at most ×1.18),
  through one critically damped filter (ω 4, stepped exactly: `dampStep`, the same at 30 and 144 fps). Pages fed the same
  tracking end on the same camera, whatever jitter delayed a sample. Debug: `vtpOut.scene.liveGuard` (`target`, `over`).
- **Moving rooms** (a walking ship; the world scrolls in the ship frame): `SceneRuntime.motionHook(rt, family)` returns
  the worst-case motion between camera and performers for the current event (deck kick in a battle, an exterior camera
  that sees the deck sway; `{heave m, roll, pitch, yaw, kick deg}`), else scene.json `framing.motion`. Faces keep that
  much further inside (`motionInset`: pitch / kick / yaw scale with sec², roll with the distance from the centre, heave
  with 1 / distance). The envelope is rounded UP to one doubling step of a reference battle envelope
  (`quantizeMotion`, `MOTION_REF` × 0.125 … 16, covering every component): a build-up re-solves the guarded shots a few
  times, never every frame, and every page rounds alike. The scrolling world must never be in `room.occluders` (mark its
  group `userData.vtpMoving = true`; cam_eval flags `moving-occluder`, and notes `moved-occluder` for any ray-tested part
  an engine animates).
- **Call-in guests**: the remote studio's backdrop grows with the guest (a giant's head never pokes over it) and its
  bust keeps the whole head in the panel (a mech guest: the pilot's face); `TvInfo.face` (the sender's face box,
  fractions of the picture) slides the TV screen's cover window and the interview panel's cover crop to keep the face
  inside the picture's safe part (`coverOffset` / `coverCrop`; no face = the old centred crop) and frames projector
  guests on their real face; video guests take `guests[i].face` from the interview bag.
- scene.json `framing` switches: `{ "guard": false }` (off for the room), `{ "live": false }`, `{ "motion": { "roll": 0.6,
  "heave": 0.04 } }` (a deck that always sways).
- **Acceptance** (`tools/cam_eval/accept.py`, private mock API + vite, muted headless Chrome): every room × talk / group /
  wide / React solo + big / gaming tiles / interview (establishing, host, guest, two, OTS, push, reverse, monitor guest)
  / TTRPG seat + wide / Preshow-BRB-Outro ambient × micro, small, normal, large, macro, giant, mech × calm / deck sway /
  battle (motion stress: the face measured at every extreme of the envelope) and a moving room's own voyage events.
  Target: 0 severe, severity 2 at most 5 % of frames (`--sev2-max`), and with `--det` every calm talk / group / wide /
  interview shot re-solved in reverse order with every shot cache cleared must come out the same (the history check).
  Faces are scored on the drawn face; a performer's head sphere / torso box only says "maybe" — the verdict is their
  posed mesh that frame. The summary reports the severity-2 share by code and the guarantee's cost (ladders, ray tests
  per ladder, the slowest). At most 2 test browsers (machine-wide camera-QA slots), each launched / loading a room only with ≥ 8
  GB free RAM, in a job object (dies with the harness; whole-browser commit capped); between rooms the page is disposed
  and left for about:blank, a browser past its memory cap or N rooms is replaced, a dead browser (a RAM watchdog) is
  replaced and its room retried once (also a page that lost its WebGL context). Unit: `npx tsx tools/frameguard_unit.ts` (ladder, determinism, live drift, remote
  bust, webcam crop, monitor two-shot, line of sight at the drawn face, the lens clear), `npx tsx tools/framing_unit.ts`
  (the contract + a synthetic sweep), `python tools/cam_eval/qa_res_unit.py` (slots, RAM, kill job) and `python
  tools/cam_eval/harness_selftest.py` (a killed renderer, a clean close, a killed owner).

### Avatars in a room
Each avatar is built at identity, then handed to the room: normalised to `scene.json avatarHeight` (default 1.5 m) ×
`state.avatarScale`, rooted at the spot origin facing its +Z. Sit spots: humanoid legs are posed seated (thighs forward,
knees bent, feet level) on the normalized rig AFTER the tracking writes its bones and before the rig update
(`AvatarRuntime.poseHook`), and the avatar drops so its hips rest a thigh-radius above `seatHeight`; leg-less rigs
rest their bottom on the seat. Head/face/arm tracking runs unchanged; head translation is damped (seated more).
`scene.json ambience`: `background` (opaque colour behind the room; omit = transparent), `fog`, `fogNear`, `fogFar`,
`exposure` (multiplies the room's material colours — the stage lights are tuned for the toon avatars).
Only **normal-class** avatars (the default) are normalised to that height; fairies, chibis, ogres and giants keep
their real size relative to the room — next section.

### Avatar size classes (micro … macro) — `shared/avatarSize.ts`, `src/scene/sizeSpots.ts`
Every avatar profile may carry its character's intended **real height**: `profile.size = { height: <metres> }`
(Advanced → Avatars → *Real size*, Simple → Me → *📏 Real size*; party guests' height travels in their shared profile).
Missing = **auto**: an ordinary 1.7 m human, class `normal` — exactly how every avatar behaved before (so existing
profiles and rooms look the same). The class comes from the height:

| class | real height | where it goes | shown height (base = `avatarHeight` × `avatarScale`, 1.5 m by default) |
|---|---|---|---|
| `micro` | < 0.6 m (fairies, pets) | a table / desk / counter-top perch beside someone, else a hover perch | base × h / 1.3 (a 0.3 m fairy → 0.35 m) |
| `small` | 0.6 – 1.3 m (chibis, kids, goblins) | ordinary spots | base × h / 1.3 |
| `normal` | 1.3 – 2.1 m (humans) | ordinary spots | base — everyone human-sized is equalised (today's normalisation) |
| `large` | 2.1 – 2.6 m (ogres, tall robots) | ordinary spots, clamped to the spot's head room | base × h / 2.1 |
| `macro` | > 2.6 m (giants, mechs, kaiju) | back-of-the-room spots with clearance | base × h / 2.1 (a 5 m giant → 3.6 m), clamped to head room / footprint |

Outside the normal band sizes scale from the band's edge, so the mapping is continuous and monotonic (no jump at a
class boundary) and slightly compressed (a fairy stays readable, a kaiju still fits a room). A large / macro performer
is never taller than the spot's measured head room (ceiling ray from the spot; seated: (head room − seat) / 0.53), and
never smaller than a normal performer.

**Accidental "wildly sized" models are corrected when measured** (`actor.ts measureRest`): the room never uses a
model's native size for a normal avatar (it is normalised), the normalising scale is no longer clamped to 0.02…50
(a centimetre export measured ~170 units and became a 3.4 m giant), and when three.js' skinned bounding box applies a
scaled export's node scale twice (a 100× / 10× export measured 9 700 m / 160 m) the double scale is undone; a box that
disagrees with the skeleton for another reason (stray geometry) falls back to the joints; a face measure nowhere near
the head joint (the group camera then framed the whole map) is re-estimated from the head. `rest.heightFix` says what
was corrected. The studio shows the native size read as metres / centimetres / millimetres (`readNative`).

**Spot eligibility** (`spotFit(sizes, cls)`: 2 = made for it, 1 = fallback, 0 = never):
- SPOT_xx extras `sizes` (array or comma string, e.g. `["micro"]` for a shelf perch, `["normal","large","macro"]` for a
  high-ceiling stand spot) or scene.json `spotSizes: { "SPOT_12": ["macro"] }` (overrides the GLB). Unset = an
  ordinary spot: small / normal / large fit (2), micro / macro only as a fallback (1: a micro hovers at seated-face
  height on a stand spot or sits on the seat; a macro is clamped to the head room). A spot with explicit `sizes` is
  strict: other classes never take it.
- scene.json `sizeSpots: [{ position: [x,y,z] (glTF), yaw?, sizes, label?, pose?, seatHeight?, hover? }]` — extra spots
  without re-exporting the GLB. They get state indices after SPOT_12 (12, 13 …; `MAX_SPOT_INDEX` = 20).
- **Automatic size spots** for a class no authored spot takes (derived once someone of that class is in the room, or
  when the studio preview reports; `autoSizeSpots: false` turns it off). Deterministic (pure function of the room),
  so the preview, OBS and every guest's OBS derive the same spots; searched ≤ 3 ms per frame (BVH rays, RoomRays).
  - micro: a flat surface 0.5–1.25 m high beside one of the first 8 spots (4-point flatness test, 0.45 m head room),
    never in the cone in front of anyone's face, with a clear line (room + a 0.48 m column per performer) to that
    spot's talk-camera side, the group side and CAM_WIDE. Up to 3 (one per spot). None found: hover perches beside
    the first spots (`hover` = base × 0.5 seated / 0.6 standing). Labels "Perch by ‹spot›" / "Hovering by ‹spot›".
  - macro: a 0.5 m grid behind / beside the group (never on the camera side, never in anyone's front cone, ≥ 1 m from
    spots), on the floor (not on furniture), clear of COLLIDE_* boxes, head room ≥ base × 1.45, free radius ≥ 0.55 m
    (8 rays), visible from the group; prefers the back, more head room, and a front not blocked by seated people. Up
    to 2, ≥ 2.2 m apart; the measured clearance {height, radius} is stored on the spot. "Back row (giant)".
- Size spots are not on the walk graph (cameras, lights, nav, `room.spots` never see them — they live in
  `room.sizeSpots`, `spotByIndex(room, i)`): a performer going to / leaving one pops in / out (0.45 s scale-in).
- **Seats** (controller + runtime share `pickSpot`): best fit first (lowest index), the remembered seat when it fits as
  well; the host's move onto a spot that fits 0 is refused with a warning in the Scene tab ("‹name› can't take
  ‘Perch by Host mic’: it is for micro performers"); a swap that would put the other person on a spot they can't take
  gives them a free one instead; micro / macro guests seated on an ordinary spot by default (e.g. before the size spots
  were known) move up to their own spot once one is free (host picks are never overridden). Scene tab member list:
  size icon per performer, unsuitable spots disabled per member, one line per micro / macro performer.
- **Cameras** (for the `cams` work): `actor.size` ({height, cls, auto}), `actor.height` (shown standing height, m),
  `actor.perch` (hover lift), `actor.faceAt(spot)` includes all of it. The automatic talk shot uses the real shown
  height for non-normal performers (a fairy gets a close-up, not a speck). Solo-react two-shots still use the room's
  normal body height.
- Tests: `output.html?sceneTest=my_room&extra=<avatars with size set>`; `vtpOut.scene.sizeReady / sizeNotes /
  room.sizeSpots`, `vtpOut.scene.summary().sizes`; unit checks `npx tsx tools/avsize_unit.ts`.
- **Seats for every size** (`src/scene/sizeSeat.ts`, automatic for EVERY sit spot in every room and mode — interview,
  talk, react, TTRPG; no per-room edits). Each actor plans its chair from measurements: the seat surface
  (`seatHeight`), table tops in front of / beside it (room rays + generated set pieces the runtime is told about with
  `rt.setSeatSurfaces()` — the interview desk registers itself), the head room, the free floor beside it, and the
  performer's own measured face height seated / standing:
  - **small / micro** (Sprocket v2 is 0.45 m) — **visibility-driven**: they sit normally first. Then every camera
    that frames the seat is checked — the interview / talk operator positions at a seated human's eye line (1.6, 2.6 and
    4 m out, straight on and ±35°, dropped where a wall is in the way) plus the room's authored cameras in front of it
    within 10 m (`seatViews`). A view counts when the face would be ≥ 2% of its frame height; the face is *seen* in it
    when all 5 face points (centre, sides, brow, chin) have a clear line (room rays both ways + the generated desk box). The seat is fine
    when the frontal operator sees the face and ≥ 70% (weighted) of the views do (`faceSeen`). Only when not, the
    **smallest fix** that makes it seen, in this order: a small **seat raise** (6 / 12 cm cushion) → a **booster**
    (cushion ≤ 0.28 m small / 0.45 m micro, then **standing on the seat** + booster) → **standing on the desk / table
    top** in front of (or beside) the chair. Nothing clears every view → the old geometric plan. The reference is the
    Astraea lounge bar (`sc_890jump~bar`): an open sofa with nothing between it and the cameras, so Sprocket just
    sits there — no booster.
  - **large**: at a desk, the chair **scoots back** (0.08–0.3 m) so knees / belly don't go through it.
  - **macro**: never squeezes into a chair — **stands beside it** on the side with more floor (their ceiling clamp uses
    the standing height).
  - A spot authored for the class (`sizes: ["micro"]`, scene.json `spotSizes` / `sizeSpots`) is used as is.
  - **Step-up rule (stand spots)**: a standing performer (any size but macro) whose face the cameras can't see over a
    lectern / counter right in front of their stand spot (a top 0.7–1.7 m high within 0.9 m) gets the lowest step
    (0.1 m increments, ≤ 0.4 m, a dark riser prop) that shows it (`planStep`, `actor.stepFor`, used by `perchFor`, so
    `faceAt` and every shot follow it). E.g. the Helldivers bridge podium (SPOT_11).
  `actor.boost` = {mode, note, …}; `actor.faceAt(spot)` includes it, so every interview / talk shot, the keep-out
  boxes for docked chat / poll cards and the monitor placement frame the real face. Quadrupeds keep standing in front
  of the seat (micro ones still go on the desk). Unit checks: `npx tsx tools/sizeseat_unit.ts`.
- Interview monitor placement (`talkshow/layout.ts`): a place that hides a guest chair's face now costs 4 × (3 − chair
  order) per view (the first chairs fill first), tested from 10 more views on an arc in front of the whole set (where the
  establishing / two-shots look from), and a far ring (3.4 / 3.9 m, further forward / back) is searched too. If the best
  place still hides a chair the set notes say so ("monitor: hides a guest chair from N view(s)"). my_room: SPOT_03
  (2nd guest chair) is now in the clear; the 3rd chair SPOT_04 can be partly behind the monitor there.

### React screen content: in-scene capture (default) vs OBS passthrough — `state.screen`
`state.screen = { mode: 'auto' | 'inscene' | 'passthrough', scanlines, glass }`. **Auto** (default) = in-scene: the
window shared from the studio, else the server's fast window feed (a dark "connecting…" standby card while it starts,
then the picture). OBS pages use passthrough only when the feed is a definite no (`src/scene/screenFeed.ts feedVerdict`:
no ffmpeg / feed off, a setup problem it can never get past — no OBS password, no capture source, no window chosen, a
source it can't follow: 'unavailable' at once, `server/screenTarget.ts` `setup`, re-checked when those settings change
and when a page starts wanting the feed if it is older than `PROBLEM_FRESH_MS` = 2 s (fixed in OBS meanwhile) —,
an 'error' lasting > 4 s, the server unreachable > 10 s, no WebCodecs) — held as failed until the
the server says the feed is RUNNING again (`feedLatch`: an ffmpeg that keeps crashing goes error → starting → error and
used to flip the screen between the standby card and the OBS capture every ≈ 6 s) — AND an OBS box can match the
screen exactly (`SceneRuntime.passOk`: in the shot and straight-on within `EXACT_PX` = 4 px of a 1080p frame, or the
corner-pin), AND OBS automation hasn't refused that hole (`refusePass`: an angle a box can't match, no part on the OBS
canvas, no capture source set, a placement OBS failed — POST / GET `/api/obs/hole` `refused`; React Full / Medium
capture rects too); else the screen shows NO SIGNAL in the room. React entry settles ONCE: the OBS page decides
whether it wants the feed right before every frame (`output.ts syncFeed`; on a 250 ms timer alone, React's first
frames drew the hole, then the standby card, then the hole again), and the standby card is left only once the React
shot has been still for `HOLD_STILL_S` = 0.25 s (at most `HOLD_MAX_S` = 3 s after the verdict: `SceneRuntime
standbyHold`) — the camera move and the stage inset are still changing passOk when the feed's "no" comes in, which went
"connecting…" → NO SIGNAL → hole. Owner rule: never a misfit OBS box. Measured (CAM_REACT at
16:9, big SCREEN): 18 of the 29 rooms with both are within 4 px; 10 are 4.5–10.2 px off square (a slight keystone:
my_room, gaming_lounge, gzw_crimson_camp, poe2_kingsmarch, sc_area18 and five _ttrpg variants) and
helldivers_bridge is 51 px off — those always draw the window in the room (no passthrough without the corner-pin). A
CAM_REACT exactly on the screen's normal through its centre (docs/AI_CREATOR_GUIDE.md) is 0 px.

**Fast window feed transport** (`server/screenFeed.ts` → `src/scene/screenFeed.ts`). gfxcapture sends a frame only
when the window / monitor changes, so a slow window (chat, an article) is a few frames a second or fewer. Encoder
(x264): every key frame forced as an IDR (`keyFrameExpr`) — the first frame, then every 2 s of frames (fps × 2, a
steady 60 fps window: every 2 s as before) or `KEY_MAX_S` = 10 s, whichever first; rate control counts real time
(`force-cfr=0`: x264 otherwise gives every frame 1/60 s of the 25 Mbit/s budget, ≈ 52 KB, however long it stays on
screen) with a 16 Mbit (2 MB, `VBV_BUFSIZE`) buffer. Measured (`tools/react_feed_e2e.ts QUALITY=1`, Y-PSNR of every
decoded frame vs a 1080p text test page, last quarter of the run): a chat window with one new line every 1.5 s
51.9 dB (b3d88c1's settings 21.8 — every change a ≈ 50 KB frame; with a key frame every second 20.6 — every change a
starved key frame); a blinking cursor 64.8 dB (55.6 / 20.6); text scrolling at 60 fps: 6 key frames in 12 s as
before, no dip at them (worst frame 55.4 dB, was 18.6). NVENC keeps its rate control (not measurable on the PC this was tuned on). Recovery never waits for a key
frame: a joining page gets the config + every frame since the last key frame (only a whole group, ≤ 36 MB); a page
whose decoder fails, or gets stuck (frames in, no picture for `DECODE_STALL_MS` = 2 s), sends `{type:'resync'}` and
gets that group again at once (≤ every `RESYNC_SERVER_MS` = 0.4 s); a page that fell behind and waits for a key frame
asks for it after `KEY_WAIT_MS` = 2.5 s; a page whose socket is stalled (> `STALL_BYTES` = 8 MB queued: a hidden OBS
source) is skipped, then replayed the group once it has caught up. After a config the page lets a whole replayed group
queue in its decoder (`BURST_MS`). A decoder that failed before it showed a frame is replaced by a software one
(`prefer-software`: an embedded browser can offer a hardware H.264 decoder that errors on every frame or never outputs
one). A whole monitor much bigger than the picture (a 4K
desktop shrunk to 1080p) is captured at ≤ 30 fps (`feedFps`: ≈ 0.95 vs 0.28 CPU cores at 4K60 / 4K30, plus a
full-size GPU readback per frame). `tools/react_feed_e2e.ts` drives the real server side and the real page receiver in
headless Chrome with an ffmpeg test pattern instead of a capture (no screen is ever captured).

**In-scene capture** (src/scene/screenShare.ts): Scene tab → React screen → **Pick a window** (getDisplayMedia, video
only — the window's sound stays in the performer's own OBS audio routing). The studio streams it to this PC's OBS
output pages over a local WebRTC link: signalling = `{type:'screen'}` bus messages (the bus is 127.0.0.1-only), no
STUN/TURN (`iceServers: []`), one peer connection per OBS page, 30 Mbit/s cap, ≤ 60 fps, source resolution kept
(`maintain-resolution`, contentHint 'detail'), H.264 preferred then VP9, receiver jitter-buffer target 0. OBS pages say
`hello` on load (and on the sender's 2 s `avail`), so a reloaded OBS page reconnects by itself. The window is drawn ON
the screen mesh as one shared VideoTexture (sRGB, unlit — no toon shading; anisotropic so it reads at an angle;
letterboxed "contain" to the 16:9 screen, never stretched; frames are pumped by the decoder's frame count because
requestVideoFrameCallback doesn't fire in hidden / off-screen browsers). Correct perspective at any angle, while the
camera moves, occluded by performers / props, with the CRT power-on; optional faint scanlines + glass sheen. Mode
'inscene' with nothing shared (or the window closed) shows a NO SIGNAL card. Browsers can't re-open a picked window by
themselves: after a studio reload, pick it again. The Scene tab shows the link (resolution, fps, bitrate, codec per
OBS page) and the estimated window → OBS delay (capture + encode + jitter + decode + render; ≈ 60 ms measured) — set the
window audio's OBS **Sync Offset** to it if the sound runs ahead. Party guests don't receive the window (their OBS shows
passthrough / NO SIGNAL for the host's screen). Cost: ≈ 3–4 ms encode (studio) + 1–2 ms decode per OBS page, +≈0.4 ms
CPU per rendered frame for the texture upload.

**OBS passthrough** (fallback): in OBS pages the screen surface renders RGBA = 0 with depth — a true hole, exactly the
projected (perspective) quad; avatars in front still cover it. The hole only opens while the camera is still (a camera
change during React closes it, moves, and reopens it). OBS setup:
1. Browser Source `http://127.0.0.1:5191/output.html`, width/height = the OBS canvas (e.g. 1920×1080).
2. Add a **Window Capture** of the window to react to, and drag it **below** the browser source.
3. Window Capture → Transform → Edit Transform: Position = x/y and Bounding Box Size = w×h from the Scene tab's
   "OBS passthrough" box (set the OBS canvas size there first; it also lists the hole's 4 corners and warns when the
   screen is angled), Bounding Box Type "Scale to inner bounds", Alignment Top Left — or let OBS automation do it.
   OBS transforms can't skew, so an angled screen only lines up exactly with in-scene capture or the corner-pin below.

Note: OBS loads the production build from `dist/` (port 5191) — run `npm run build` once after updating the code.

### React layouts: big centre vs solo side (`state.reactLayout`: auto | solo | big)
**Auto** (default) = the **solo side screen** when exactly one performer is in the room, otherwise the room's big
SCREEN; a guest walking in while solo-reacting cross-fades to the big layout (Solo forced = stays solo; other
performers are then treated as blockers by the camera solver).
- Placement: `SCREEN_SOLO_xx` node → scene.json `soloScreens: { "SPOT_01": { "position": [x,y,z] (glTF, surface
  centre), "yaw": deg (the side it faces), "width": m } }` → automatic (src/scene/twoShot.ts `deriveSoloSteps`: candidates
  to the host's camera-right, panel + hanging bar clear of COLLIDE_* boxes, host sees every corner, nothing through a
  wall; hung with its middle ~0.2 × its height above the host's face, lifted +0.28 / +0.56 m when furniture is in the
  way; searched ~3 ms per frame so OBS never hitches). the VTube Pro studio authors SPOT_01 (behind the co-host chair).
- The rig (src/scene/soloScreen.ts, generated): ceiling plates → cables → motor housing (cyan LED strip + ON AIR lamp)
  → the screen unrolls under it with a weighted bar. Enter timeline, tied to the 1.6 s camera move: 0–0.45 s housing
  lowers · 0.3–1.15 s motor unroll · lands with a damped overshoot bounce, ON AIR flash + a 0.5 s light dip
  (`lights.cue?.('screenLand')` is called if the light engine implements it) · CRT power-on 0.55 s (dot → line →
  scanline flicker) · **the OBS hole fades open (0.3 s) only once the camera has settled**. Exit: hole closes → tube off
  → rolls up → housing up; the camera waits for the hole to close before it moves.
- Camera (`solveTwoShot`): host on the left third (face at 25% of the width, head + torso), the screen's right edge at
  95.5% (≈60–62% of the width), vertically centred on host + screen + housing but shifted within the frame's slack so the host's face sits ≤ 45%
  from the top (a screen hung high never pushes the host to the bottom edge), no view ray into the void (indoor
  rooms), 6×4 line-of-sight samples on the screen
  (room BVH + other performers) — any aspect ratio / avatar height. The move eases in/out (smootherstep) along a small
  parallax arc (sideways away from the host + up). The host turns ~30% of the way towards their screen (eyeline).
- The big centre SCREEN uses the same CRT power-on and settle-gated hole (src/scene/screenFx.ts).
- Scene tab → "React screen → OBS passthrough" lists BOTH layouts' Window Capture numbers (◀ = in use).

### Screen video — `state.video` (shared/screenVideo.ts, src/scene/screenVideo*.ts, src/ui/screenVideoPanel.ts)
The room's big SCREEN (rooms without one: the solo side screen beside the host) plays a video file IN the scene — a
starting-soon loop, BRB, an outro, or ambience while talking. It is drawn on the screen mesh like the in-scene capture
(unlit sRGB VideoTexture, letterboxed, CRT power-on, glass / scanlines), so every OBS page shows it with no OBS setup and
no passthrough hole; the screen drops / unrolls with the room's usual animation (no ON AIR light accent for it).
- **Playlists per moment** (Scene tab → *Screen video*): Preshow / BRB / Outro follow the lighting state; **Ambience**
  plays in SHOW / REACT lighting. Each: files and / or URLs, Loop (off = the screen goes away after the last one),
  Shuffle, Camera (*Keep the room camera* / *Show the screen* = the React shot of that screen while it plays).
- **Only in Talk**: React, Interview, Gaming, TTRPG and any stage layout own the screen, so the video hides then. The
  ambience playlist pauses (the host stores the position) and carries on where it was when Talk returns; the other
  playlists keep their clock running. A raid interrupt winches it up like React's screen.
- **Clock** (src/scene/screenVideoHost.ts, host / solo studio only, 2 Hz): `video.now = {slot, i, src, at}` — every
  page plays `src` at (now − at) s. A new moment starts 1.5 s ahead (the screen drop). The host measures each file's
  length (preload=metadata) and writes the state only on a change (new moment, next item, pause / resume); one looping
  video costs no state writes. Guests' studios shift `at` by the party clock offset.
- **Pages** (src/scene/screenVideo.ts, one per page, survives room / area changes): one `<video>` decoded once, the
  texture re-uploaded only when the decoder produced a new frame (frame count — works in hidden OBS sources); seek when
  > 0.6 s off, else a ±6 % playback-rate nudge; paused (no decoding) whenever no screen shows it.
- **Sound**: muted by default; *Video sound* + volume. It plays in the STUDIO (src/audio/mixer/showSounds.ts: an
  `<audio>` of the same file on the same clock, through the audio mixer's *Room screen video* row), never on an OBS page:
  output pages are silent (src/audio/silentPage.ts). A `live:` stream's sound plays in the studio too; cameras and the
  window feed have no sound anywhere (as before): the mixer row tells the user to add it in OBS directly.
- **Library**: `videos/` in the app folder (git-ignored, personal, never shipped). *Add videos…* uploads a copy
  (`POST /api/videos/upload?name=`), *Open folder*, *Refresh*. `GET /api/videos`, `GET /api/videos/file/<name>` (Range).
  MP4 (H.264/AAC) or WebM. URLs must allow CORS (WebGL can't draw a cross-origin video without it).
- **Party guests**: a `lib:` video plays on a guest's OBS only when THEIR `videos/` folder has a file of the same name
  (else their screen stays black); URLs play everywhere. Nothing is streamed to guests.
- **Stream Deck / scripts**: `POST http://127.0.0.1:5191/api/scene/video` `{"action":"play"|"stop"|"toggle"|"next"|"restart",
  "slot"?: "preshow"|"ambience"|"brb"|"outro", "audio"?: true|false|"toggle", "volume"?: 0..1, "on"?: bool}` (localhost
  only) → bus `{type:'command', command:'scene', args:{video:{…}}}`. A manual Stop or "Play <slot>" lasts until the next
  lighting-state change.
- Tests: `output.html?sceneTest=<room>` + `vtpOut.debugScene({...vtpOut.sceneState, video: {on: true, slots: {preshow:
  {list: ['lib:x.mp4'], loop: true, shuffle: false, cam: 'keep'}}, audio: false, volume: 0.8, force: null, stopped: false,
  now: {slot: 'preshow', i: 0, src: 'lib:x.mp4', at: Date.now()}}})`; `vtpOut.scene.videoInfo` (layout, status, time, drift
  rate, muted). Cost: ≈ 0.1 ms CPU per frame + one texture upload per decoded video frame (≈ 0.3–0.4 ms at 720p).

### Room skins for the screen rigs — `scene.json screenSkin` (shared/screenSkin.ts, src/scene/screenSkins.ts)
The generated rigs (solo react screen, chat monitor, support board) wear the room's skin. Whatever the skin, the
picture is the same flat rectangle (16:9 solo, 3:4 monitor, 16:9 board): in-scene capture draws on it and the OBS
passthrough hole / corner-pin quad is exactly it — frames may be any shape around it (arches, sheets, holo brackets)
and never cover it. At rest every skin's moving part is at identity, so rect / quad / two-shot maths don't change.

| theme | solo screen | chat monitor + board | rooms (built-in default) |
|---|---|---|---|
| `studio` | motorised roller + ON AIR (unroll, crt) | drop-down monitor on cables, neon board (HangingRig) | my_room, anything unlisted |
| `scrying` | rune-framed arched enchanted mirror, rises out of a floor rune circle (rise, shimmer) | carved signboard on ropes (drop, shimmer) | poe2_kingsmarch |
| `hologram` | floor emitter fans a beam, holo edges + header draw in (hologram, hologram) | ceiling emitter (hologram) | helldivers_bridge, space_test |
| `terragroup` | white rounded bezel + chin wordmark + blue strip on a ceiling mast (drop, fade) | same | eft_labs, eft_labs_rnd |
| `tarp` | tarp lashed under a rusty I-beam on two chain hoists (swing, fade) | rusty steel monitor + hazard plate on chains (swing, crt) | eft_factory |
| `bedsheet` | a bedsheet pegged on a clothesline, unfurls, edges sway (unroll, fade) | duct-taped plywood board on ropes (drop, fade) | eft_customs_dorms |

scene.json (a room's own entry wins over the built-in default):
```json
"screenSkin": "scrying"
"screenSkin": { "theme": "tarp", "motion": "drop", "board": { "theme": "studio" } }
"screenSkin": { "node": "SOLO_SKIN", "motion": "rise", "powerOn": "shimmer", "monitor": { "node": "CHAT_MONITOR_SKIN" } }
```
Top-level `theme` applies to every prop; top-level `node` / `motion` / `powerOn` are the solo screen's; `solo` /
`monitor` / `board` override per prop (a string = a theme). Motions: `drop` (from above the ceiling line, landing
bounce), `rise` (up from the floor, fading in), `unroll` (housing lowers, then the screen unrolls from its top),
`swing` (falls on its chains, damped pendulum; the picture only powers on once it has settled), `hologram` (flickers
in place), `shimmer` (floats up a little, fading in). Power-on (screenFx.ts `uStyle`): `crt`, `hologram` (scan
bands pop in, cyan until on), `shimmer` (rippling reveal from the centre with a violet rim), `fade` (dithered
projector-lamp warm-up); all end on the identical fully-on picture, then the passthrough hole opens as before.

**Own GLB housing**: a node named `SOLO_SKIN` / `CHAT_MONITOR_SKIN` / `CHAT_BOARD_SKIN` (used automatically), or
any node named in `screenSkin.node` — nodes ending in `_SKIN` are hidden in the room and never ray-tested; they are
templates cloned per rig. Contract: origin = centre of the screen rectangle, +Z faces the viewer, the rectangle's
width = a child mesh named `*_RECT` (its bounds; hidden) or `extras.screenWidth` (glTF units), else 1; the clone is
scaled uniformly so that width matches the rig's. Keep geometry in front of z = 0 outside the rectangle (the picture
is drawn at z = +0.012). Children named `*_FIXED` stay put (ceiling mounts, floor emitters); the rest moves with the
motion. Materials are cloned per rig (fades don't touch the room). The Scene tab → React screen shows the skin in
effect and any screenSkin mistakes (unknown theme / motion / node).

### OBS automation (optional, off by default) — server/obs.ts
obs-websocket v5 (OBS 28+: Tools → WebSocket Server Settings). Scene tab → "OBS automation": URL (default
ws://127.0.0.1:4455), password (stored only in `config/obs.json`, never returned / broadcast), the Window Capture
source, optionally the browser source (if it doesn't fill the canvas), the OBS scene holding the capture, and Talk /
React scene names for scene switching. When enabled: the OBS output page POSTs `/api/obs/hole` once the hole has fully
opened (only for a screen in the camera's shot; a room that goes, or a hole that closes, reports `open: false` with the
mode the hole opened in) → the server sets the capture's transform (position, OBS_BOUNDS_SCALE_INNER bounds from the
OBS canvas size read via GetVideoSettings, or the browser source's box) and shows it — only when that matches the
screen (in the picture, straight-on within 6 px, or with the corner-pin), else it keeps it hidden and says why; when
the hole has closed it hides it. A box only PARTLY off the OBS canvas (the room's browser source moved / scaled past the
canvas edge) is placed — OBS clips the capture at the edge exactly where it clips the room; one with no part on the
canvas stays hidden (`onCanvas`). When it will not show a capture for an open React hole, its answer to that POST (it
waits ≤ 2.5 s for OBS) and the page's 5 s GET carry `refused: <why>`: the page draws that shot's screen in the room
(`SceneRuntime.refusePass`, kept for that shot until the camera / layout changes or React is left) — never an empty
see-through hole. `GET /api/obs/hole` `pin` is null while the corner-pin check isn't answered yet (right after a
server restart or a changed address / password; the GET waits ≤ 1.5 s for it): the page keeps its choice and asks
again 1.5 s later. A check OBS didn't answer stays unknown and is asked again 10 s later (never "no plugin" for good). Before the automation first changes the capture (a placement or a hide) it records the
item's own transform + visibility in `cache/obs-capture.json` (it survives a server restart; a capture already at the
automation's last placement, or entirely off the canvas, is not taken as the performer's). Every mode change (2.5 s
safety net, or the page's close report first) puts the capture where that mode wants it: React = hidden until a hole
opens; Gaming and other modes with their own capture area = back at the recorded placement, shown again if it was
shown; Talk / Classic / Interview = hidden, back at the recorded placement. `PUT /api/scene` switches the program scene
on mode changes (never on the first state after a server restart; only when the new look maps to a different OBS scene
than the last one, and not when OBS is already on it). Nothing connects until enabled; "Test connection"
(`POST /api/obs/probe`) lists scenes + sources. Setup warnings (a whole-monitor Display Capture, a browser source with
OBS's `ws://` address, the capture above the browser source …) are checked about once a minute while the Scene tab is
open, also when nothing is placed.
**What the pages show** (report v3 `shows: { mode, room, hole, party }`): a party guest's studio hands the HOST's state
to its own OBS pages over the bus and never saves it (no `PUT /api/scene`), so that PC's saved state isn't what its
pages show. The server uses the pages' `shows` while they say `party` (cleared by an own-state report or a PUT): a React
hole of the host's is placed, and a close settles for the host's mode (React → hidden, Gaming → back at the own place
and shown, Talk → hidden). A late "open" (sent just before the page heard the show left React) is ignored only from
pages that show this PC's own state; pages before v3 (no `shows`): only within `LATE_OPEN_MS` (4 s) of a mode change
here. Interview's **Fit my Window Capture → guest** (`POST /api/obs/place`, a click) cancels the mode change's safety
net and is kept by settle() until the mode changes (a click right after entering Interview used to be hidden 2.5 s
later, or by a late close of React's hole). The OBS page's 5 s `GET /api/obs/hole` in React carries what its React
screen shows and why (`?shows=hole|video|window|feed|standby|nosignal&shot=&exact=&err=` or `&stage=1` for React Full /
Medium): the OBS panel's hint says "not in the camera's shot → Auto or Screen", or "seen at a slight angle (N px) → NO
SIGNAL: the fast window feed (ffmpeg) or a window picked in the studio; the corner-pin for passthrough".
The hole event also carries the hole's 4 projected corners (`quad`, TL/TR/BR/BL fractions). **Perspective corner-pin**
(option, `cornerPin`): needs the free **obs-shaderfilter** plugin (by exeldro; detected via GetSourceFilterKindList,
kind `shader_filter` — never installed by VTube Pro). The automation adds / updates a filter named
**"VTube Pro corner pin"** on the Window Capture (shader text + an inverse homography in uniforms h00…h22 and a
letterbox fit), stretches the capture over the quad's bounding box and enables the filter → the window lands exactly on
the angled screen. Without the plugin (or with the option off) a React hole is placed only when the best
OBS-expressible box (rotation + size around the quad's centre, `shared/quad.ts rotatedFit`) is within 6 px of the
corners; otherwise the capture stays hidden and the page draws that screen in the room (the fast window feed, or NO
SIGNAL). Only used in passthrough. The in-scene fast window feed reads the capture source from OBS too, but needs only a
saved password (or an OBS that asks for none), not "Automate OBS".

### Test URLs (never follow the bus / the server's scene state)
`output.html?sceneTest=<id>[&mode=react][&cam=wide|group|talk|react|CAM_x][&spot=1..12][&extra=frog,robot][&screen=placeholder][&toggles=<id>:off]`
— `extra` adds library avatars as stand-in guests. `output.html?preview=1` is the Scene-tab preview (driven by the
studio page). `?observer=1` studios are a sandbox: Scene-tab changes are never saved or sent.
Debug handles: `vtpOut.scene` (SceneRuntime), `vtpOut.step(n)` (draw frames by hand in a hidden tab),
`vtpOut.debugScene(state)` (test pages only); `vtp.scene` (controller) in the studio.
`vtpOut.arrivalTest('exit' | 'enter', key = '@host')` (test pages only) stamps a leave / join for a member the way the
host does, so the room's entrance / exit style plays (door walk, cryo, drop pod, captain's lift); `vtpOut.lift()` = the
lift mover's plan (lifts, jobs, what each platform shows) in a room that uses the lift.

## Hook: entrances (AvatarMover) — `src/scene/mover.ts`
The runtime never animates avatars between places; it calls the installed mover:
```ts
interface AvatarMover {
  enter(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent): void;   // became present → DOOR_OUTSIDE → door → PATH_* → spot → sit
  exit(actor: SceneActor, ev?: MoveEvent): void;                    // reverse, then actor.shown = false
  move(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent): void;    // host moved them while present
  tracks?(): MoverTrack[];                          // walks in progress (the follow camera reads these)
  update(dt: number): void;
  busy(actor: SceneActor): boolean;                 // while true the runtime doesn't snap the actor to its spot
  finishAll(): void;                                // jump to end states (first frame after a room loads)
  dispose(): void;
}
setMoverFactory((room: RoomInfo) => new MyWalkMover(room));   // install (e.g. from a module imported by output.ts)
```
A mover drives `actor.mount` (room-space floor position + `rotation.y` yaw), `actor.sit` (0 stand … 1 seated — the
runtime bends the legs and drops onto the seat from it), `actor.shown`, `actor.appear` (0..1 scale), and may set
`actor.extraPose = (rt, dt) => …` for a walk cycle on `rt.humanoid` normalized bones. `actor.placementAt(spot)` gives
the settled `{position, yaw, sit}`; `room.door.setOpen(0..1)`, `room.doorOutside`, `room.path[]` / `room.pathNames[]`,
`room.colliders` (COLLIDE_* nodes — hidden by the engine), `nearestWaypoint(room, p)` are there for the walk. Per spot,
`spot.leavePathAt` (index into `room.path`, from extras `leavePathAt: "PATH_02"`; null = nearest) and `spot.approach`
(world points from extras `approach: [x,y,z, …]`) route around furniture — a straight line from the path to the
host desk / DJ / bar / armchair spots clips it, so walk `path[0..leavePathAt]` → `approach[]` → the spot. `spot.extras`
holds every authored extra. `MoveEvent = {at, from}` is the host's `state.moves[key]` when its `to` matches. The
old placeholder `PopMover` is still in mover.ts (default factory until walkMover.ts is imported).

### Entrances, exits and moves (WalkMover) — `src/scene/walkMover.ts`
- **Enter**: spawns at `DOOR_OUTSIDE` (hidden behind the closed door), the `DOOR` hinge eases open (0.6 s), they walk
  through the doorway → `PATH_01…` → `PATH_[leavePathAt]` → the spot's `approach` points → the **stand point** (sit
  spots: just in front of the seat, first point clear of the COLLIDE_ boxes) → turn to the spot's facing → back up and
  sit (0.8 s, `actor.sit` 0→1 blends into the engine's seated legs). Stand spots: turn, settle, idle weight shift.
  The door starts closing once they are ~0.9 m inside.
- **Exit**: stand up (0.8 s) → turn → walk to `DOOR_OUTSIDE`; the door opens ~0.6 m before they reach it and closes
  behind them; hidden once closed. **Move**: stand up → walk → turn → sit. Neighbouring stand points (< 2.4 m, clear
  line) are linked directly; everything else uses the room's lanes. An interrupted walk re-plans from where they are.
- **Navigation** (`navigation.ts`): graph = door → doorway → PATH chain + per-spot approach chains + seat-to-seat
  shortcuts; Dijkstra; every leg that crosses a COLLIDE_* box (inflated 0.2 m; boxes above 0.9 m are ignored) is
  detoured with a visibility-graph A* over the box corners; then a centripetal Catmull-Rom curve baked to an
  arc-length table. Walls are NOT modelled — the authored lanes keep walkers inside.
- **Speed**: 1.2 m/s × (normalised height / 1.5), capped so a stride cycle is ≤ 2.2 /s (short-legged chibis and
  frogs waddle at ≈0.75 m/s); trapezoid accel / decel. They face the walking direction (0.3 m look-ahead).
- **Door queue**: several arrivals at once walk in single file — the host staggers door walks ≥ 1.2 s, and every page
  additionally spaces a queue ≥ 1.15 m and caps each walker at the speed of the one in front (order-independent, so
  all pages agree). The door is open while ANY walker's door window is.
- **Sync** (studio preview, OBS, guests' OBS): the host's controller stamps every presence / spot change as
  `state.moves[key] = {from, to, at}` (spot index, −1 = outside; `at` = start, epoch ms; +150 ms lead, +3 s for a
  guest who just joined so their model has loaded). Each page builds the same timeline from room data + event and
  samples it at wall-clock time, so a page that loads mid-walk lands mid-walk; an old event → snapped. Guests convert
  the host's clock with `state.sentAt` (party link; min of recent receive−sent offsets) before relaying to their OBS.
  A page seeing someone for the first time WITHOUT an event snaps them (no replayed entrance on every OBS refresh);
  un-stamped changes of someone already shown animate from "now". Room switches clear `moves` (everyone appears).
- **Pose** (`locomotion.ts`, the actor's `extraPose`, after tracking + seated legs, before the rig update): two-bone
  IK legs with feet planted (stride phase = distance walked, 60 % stance), foot lift / toe-off / heel-strike, hips drop
  exactly as much as the stance leg needs (the bob), sway over the stance foot, pelvis twist + roll, chest counter-twist,
  slight lean; arms counter-swing and REPLACE the tracked arms while walking (`armW`, blended back over 0.4 s after the
  final turn); tracked head / neck rotation × 0.5 while walking; tracked torso follow −70 %; head translation from the
  webcam −85 % (`actor.loco` → `SceneRuntime.tuningFor`). Face, expressions, eyes and mouth are never touched. Rigs
  whose legs don't reach the floor, or with no humanoid, **hop**: body bob + forward lean + wobble (`actor.offset` /
  `actor.tilt`). Stand spots: idle weight shift (hips over one foot, the other knee relaxes). Cost ≈ 0.005 ms per
  avatar per frame (5 walking avatars: 0.026 ms incl. the mover); path planning only happens when an event arrives.
- **Follow camera** (`state.follow = {host, guests}`, Scene tab "Camera follows my entrance" (default on) / "…and
  guests' entrances" (default off)), `src/scene/followCam.ts`: while someone walks in, a camera "operator" at a fixed
  point pans + zooms with them. Operators: CAM_WIDE's position (preferred), CAM_DOOR, the other presets within 16 m /
  4 m above the floor, the destination's SPOT_xx_CAM and solved talk shot. The walk is planned in 0.25 s steps from its
  start through the mover's own timeline (`AvatarMover.samplePath`) → identical on every page, also one that loads
  mid-walk. Each step scores every operator: 6×4 view rays (corners included) must end on something the renderer
  draws (past culled back faces — glass, the fourth wall — to the first front face; a ray into nothing in the lower
  half counts double: a hole under the floor line is the worst; outdoor / epoch / space rooms as for the framing), the operator not behind a wall, not on top of the
  walker (< 1.1 m), the walker's FACE in its frame and not hidden (room / seated people): 5 points round the drawn face
  as it rides on the walk (rest height and forward offset along the path's direction: a mascot's face sits low and well
  ahead of its feet - never a point at 0.88 x height, which a monitor or brazier can leave visible over a hidden face).
  The plan stays on its operator unless it goes BAD or loses the face for `LOST_CUT` steps (0.5 s on screen - never a
  second), holds ≥ 2 s after a cut (a lost face overrides the hold), cuts for a lost face only to an operator that sees
  it now and the next 2 steps (when none does it holds), and doesn't cut back to one it left in the last 3 s. cam_eval: a walk-in face hidden for at most 1 s in a row is
  `walk_occluded` (not severe); a longer run is severe (`accept.py` measures the run). Until the walker is through the
  doorway the camera looks at the inside of the doorway, never at them outside it. An authored CAM_DOOR is cut to for
  the door phase only when its whole view is modelled. The normal camera returns 0.4 s after they're seated (with the
  usual move, or a cut when that move would cross a wall). Debug: `vtpOut.scene.followInfo` (plan + per-step scores).
- Scene tab: **🚪 Walk in / 🚪 Leave the room** for the host; each member's "In" box walks them out / in.
- Engine additions: `SceneActor.offset / tilt / loco`, `updateSeat(spot?)` (seat of the chair being left),
  `RestMetrics.toNorm / joints` (every humanoid joint's rest position in avatar space, measured at load).
- Tests: `output.html?sceneTest=my_room&extra=guest,frog`, then in the console:
  `vtpOut.scene.mover.manual = true` (time only advances with `vtpOut.step(n, dt)`) and `vtpOut.debugScene({...})`
  with `moves` stamped at `vtpOut.scene.mover.now()*1000`.
- Known limits: walkers don't avoid each other beyond the door queue (two people swapping seats cross paths); leg
  IK assumes knees bend forward; a big costume (e.g. the FROG FINDER box) hides the legs; the DJ booth hides short
  avatars at SPOT_09 (room / avatar-size issue, not the walk).

### Per-role entrances and exits — `shared/arrivals.ts`
scene.json `entrance` / `exit` is a style for everyone (as before: `"cryo"`, `"droppod"`, `"lift"`, `"door"`) **or** an
object that gives the host and everyone else their own style:
```json
"entrance": { "host": "lift", "guests": "cryo" },
"exit":     { "host": "lift", "guests": "droppod" }
```
The host is the member key `'@host'` (on every page — the host's own OBS, the Scene-tab preview and every party
guest's OBS), everyone else is a guest. A role left out of the object gets what the room would do without the key
(its anchors: CRYO_POD_xx → cryo, DROP_POD_xx → droppod, else the door walk). The styles resolve from scene.json on every
page and the movers run from the host's move stamps exactly as before, so nothing new travels over the party link.
Movers: `SpaceMover` (cryo / drop pod) checks the style per actor; the captain's lift (below) wraps whatever mover the
room gets and takes only the actors whose role uses `lift`. A room without these keys, or with plain strings, behaves
exactly as before (the SpaceMover factory still sees `entrance: "cryo"` whenever a role uses cryo).
Movers that can be wrapped implement `MoverHandover` (`handOff(actor)` / `adopt(actor)`, `src/scene/mover.ts`);
`currentMoverFactory()` returns the installed factory; `AvatarMover.setMode?(mode)` gets the scene mode (no exit-camera cuts
in React).

### Captain's lift — `src/scene/arrivals/liftMover.ts`
The performer rises out of the floor on a platform, steps off and walks to their spot; leaving, they walk onto the
platform and sink out of sight. Room contract (glTF, all names exact; the room only gets the lift mover when a role in
scene.json uses `"lift"` **and** a `LIFT_xx` node exists):

| Node | Meaning |
|---|---|
| `LIFT_01`, `LIFT_02` … | The platform (a mesh; children move with it, e.g. a piston). Its **authored position is the TOP** — the platform flush with the floor. extras `depth` (m, default 1.6) = how far below the floor it starts (a rider taller than that goes deeper: avatar height + 0.12 m). The host always uses LIFT_01; guests the others by seat (LIFT_01 when it is the only one). |
| `LIFT_xx_hatch_L`, `LIFT_xx_hatch_R` | (optional) hatch panels over the shaft. extras `slide` `[x, y, z]` = their offset when open (glTF space); default ±0.9 m along the platform's local X (L = −X, R = +X). A single `LIFT_xx_hatch` slides +X. **With** a hatch the platform rests at the bottom under the closed hatch (sink / close after each ride); **without** one it rests at the top (it is the floor) and drops empty before a rise. Keep hatches a few mm proud of the floor so they slide over it without z-fighting. |
| `LIFT_xx_lid` | (optional) a **coffin lid** (a child of the platform, so it rises with it, or any node). It swings open after the rise and shut again before the sink (below). extras: `hinge` (`"left"` / `"right"` / `"top"`, default `left`), `openAngle` (degrees, default 110, 5–175), `open` (seconds one swing takes, default 0.6, 0.2–3). The hinge is **read from the lid's geometry**, in the platform's own right / up / forward: a lid standing in front of the rider (thin along forward) turns about its left / right vertical edge or its upper edge; a lid lying over the rider (thin along up) turns up like a chest lid about its left / right side edge, or about its far (−Z) edge for `top`. Positive angle always swings **outward** (towards +Z of a standing lid, up for a lying one); the node's own origin does not matter (a lid with no geometry turns about its origin). |
| `LIFT_xx_out` | (optional, empty) the step-off / boarding point on the floor; default 0.45 m past the platform's +Z edge. The rider faces from the platform towards it while riding. |
| `CAM_LIFT` / `CAM_LIFT_xx` | (optional camera) the shot for the rise and the descent. Without one: from CAM_WIDE (or `defaultCamera`) zoomed onto the lift when it has a clear line of sight, else an automatic shot in front of the lift (pulled in off walls). |
| `EMIT_lift*` material | (optional) pulses amber (1.6 Hz) while a lift runs — render-time only, the light engine never sees it. Without one, two small amber beacon sprites pulse at the hatch's front corners. |
| `COLLIDE_*` over the shaft | recommended: walks route round the hole while the hatch is open. |

The room must have a real hole in its floor under the hatch (and ideally a shaft: dark walls + a bottom), or the rider
is hidden by the floor. **Enter** (`at` = the host's move stamp): hatch slides open (0.7 s, hazard pulse) → the platform
rises with the performer standing on it (2.2 s, eased, ~3 cm overshoot + settle; a warm column of light and a few
sparks at the rim — pooled additive sprites, `SpaceFx`, 3 draw calls, skipped if unavailable) → 0.35 s beat → step off
to `_out` (0.8 s) → walk the room's lanes + the spot's approach points → turn → sit / settle; the platform sinks and the
hatch closes behind them. **Exit**: stand up → walk to `_out` (the hatch opens and the empty platform comes up as they
get there; they wait if it isn't up yet) → step on, turn round → sink (2.0 s) → hidden once fully below → the hatch
closes. **Older apps ignore `LIFT_xx_lid`** (it is just a mesh to them: the rider would step through a shut lid), so a room that ships one sets `minApp` to the release that
added it. **With a `LIFT_xx_lid`** the ride gains one swing at each end, and nothing else changes (a room without a lid keeps its exact timeline):
**Enter** — hatch opens → the platform rises with the lid **shut** (the rider is hidden inside) → the lid swings open (`open` s) → 0.35 s beat → step off
→ 0.1 s → the lid swings shut → 0.1 s → the platform sinks, the hatch closes. **Exit** — the hatch opens and the empty platform comes up → the lid swings
open (it is open when the rider reaches the edge) → step on, turn round → the lid swings shut → 0.2 s → sink. So the lid is never open while the platform is
below the floor. Extras on the platform: none needed. Also with a lid: **dust and dirt clods** off the platform rim on the rise and at each thud (lands, lid
stop, lid shut; the SpaceFx smoke pool, 56 pooled puffs, no extra draw calls) and a **creak + thud camera shake** on the lift shot, never more than 2 cm
(`liftShake`, a pure function of the time into the ride). No sound. Everything is deterministic from the move stamp like the rest of the lift
(`vtpOut.lift()` shows `lid: {hinge, lying, deg, open, child}` per lift). A lid that is not a child of the platform is carried up and down with it by the
mover. The lid is turned in its parent's space about its measured hinge edge and put back exactly on dispose. A cut-short entrance (the exit starts while the
rider is still on the platform) shuts the lid at once. Tests: `npx tsx tools/lift_lid_unit.ts` (hinge parse, the enter / exit timelines through a real
LiftMover with a manual clock, determinism, the shake cap, the no-lid timeline).

One rider per platform: overlapping rides on the same lift queue in (stamp, key) order — identical on every
page. Deterministic like WalkMover (a page that loads mid-rise lands mid-rise; an old stamp snaps; first sight without a
stamp snaps; room switches clear the stamps). **Camera** (`state.follow`, "Camera follows my entrance" / "…and guests'"):
the lift shot from the hatch opening until 0.3 s after the step-off (then the regular walk-follow planner takes over,
`tracks()` reports `through` = the step-off), and from 0.6 s before boarding until they are down (not in React).
Moves between spots, the other role and rooms without a lift use the wrapped mover (WalkMover / SpaceMover).
Test room: `assets/scenes/lift_test/` (test_room with a floor hatch, shaft, LIFT_01 + piston, hatches, `_out`,
COLLIDE_LIFT, EMIT_lift lamps, CAM_LIFT; host = lift, guests = door; curtains = hive-doors), rebuilt without Blender by
`node assets/scenes/lift_test/build_lift_test.mjs`. `output.html?sceneTest=lift_test&avatar=guest&extra=frog`, then
`vtpOut.scene.mover.manual = true; vtpOut.arrivalTest('exit'); vtpOut.step(600)` / `vtpOut.arrivalTest('enter')`,
`vtpOut.lift()`.

## Hook: lights (SceneLights) — `src/scene/lights.ts`
```ts
interface SceneLights {
  attach(ctx: { room: RoomInfo; scene: THREE.Scene; tier: QualityTier }): void;
  setState(s: SceneLightsState): void;   // host's { program, reactive, intensity } (Scene tab → every OBS)
  update(dt: number, t: number): void;   // every rendered frame
  dispose(): void;                       // remove lights, restore materials
}
setLightsFactory(() => new MyLightShow());
```
`room.fixtures`: every `LIGHT_*` node with `group`, `color`, `kind` and its `EMIT_*` materials; `room.emissive`: every
`EMIT_<group>` material with its authored `baseColor` / `baseIntensity` (the VTube Pro studio tints via `emissive`,
strength via `emissiveIntensity`). Fixture extras honoured by the placeholder: `range` (distance), `intensity`
(relative), spots `angle` (full cone, degrees), `penumbra`, `target` ([x,y,z], else the node's −Z). Budget: at most
`LIGHT_BUDGET[tier]` (low 0 / medium 2 / high 3 / ultra 4) real THREE lights, spot cans first — animate EMIT_
materials for the rest (bloom is off). Rooms keep their own PBR shading + baked vertex colours (COLOR_0 → three.js
`vertexColors`, automatic); only the avatars are toon.
`scene.json lights.programs` fills the Scene tab's program list. Placeholder: `SteadyLights` (still the default in `lights.ts`; the OBS page installs the real engine below).

# Lights: beat-reactive light show

The real `SceneLights` engine is `BeatLights` (`src/scene/lightShow.ts`), installed by `output.ts` importing it. It
is driven by a **beat analysis that runs in the studio** (the OBS page can't capture audio) and reaches every OBS
page + party guest as small beat packets.

| File | Role |
|---|---|
| `src/audio/beat/beatEngine.ts` | **BeatEngine v8**, ported from an earlier overlay (`public/js/beatengine.js`); since the lights overhaul with a 70–232 BPM range, an octave-up guard, downbeat tie-breakers and a −60 dBFS silence gate (tools/beat/bench.ts). DbnBeatTracker, OnsetComb, StableBeatGrid, MusicSectionTracker (drops / builds / breakdowns), GroovePredictor, SpectrumBands, PerformanceEnergy, AudioHopClock. |
| `src/audio/beat/beat-worklet.js` | the overlay's AudioWorklet `beat-feed`, **verbatim** (15 channels per 10.7 ms hop: band RMS, kick/click/snare transients, superflux) |
| `src/audio/beat/beatWorker.ts` | runs `beatAnalyzer.ts` (the engine + voice gate + arranger, see Reactive lights below) in a Web Worker (its tempo search costs a few ms every 500 ms — kept off the face tracker's main thread) and packetises |
| `src/audio/beat/beatInput.ts` | studio input: its own `AudioContext` + stream (never the lip-sync mic pipeline), worklet → worker → sinks (bus, party, preview) |
| `src/scene/beatClock.ts` | OBS side: clock-offset estimate, local phase-locked grid, free-run, envelopes, test helpers |
| `src/scene/lightShow.ts` | the programs, per-fixture material clones, capped real lights, photosensitivity gate |
| `shared/lightShow.ts` | program list, presets, `resolveGroup()`, `BeatPacket` + sanitisers |
| `src/ui/lightsPanel.ts` | Scene tab → Lights section |

### Music input (Scene tab → Lights → Music input)
Off (default) · **Tab / screen audio** (`getDisplayMedia`, tick "Share tab/system audio") · **Test beat** (built-in
128 BPM loop, never played to the speakers) · any **audio input device** (loopback, "Stereo Mix", VB-Cable, the
Focusrite's loopback channel …; same list as the mic picker, opened as a separate stream with echo cancellation /
noise suppression / AGC off). The device choice is remembered per browser. The meter shows the six bands, the beat
in the bar, a kick flash, BPM / lock / section / energy. ?observer=1 studios only feed their own preview.

### Transport
Worker → `BeatPacket` (`shared/lightShow.ts`) ~30 Hz, plus one immediately on every kick / snare / drop / downbeat:
`{sid, t (sender epoch ms), on, bpm, bi, ph, bar, cf, lk, ev (EV_* bits), ka/sa (event ages), e, lo, mi, hi, k, s, h, d, sec}`
(~200 bytes). Sent to this PC's OBS pages as bus `{type:'beat', b}`, to party guests as wire `{t:'beat', b}` (host
only; guests relay it to their own bus) and to the Scene-tab preview through the preview link. Receivers
(`BeatClock`): the fastest packets define the sender→local clock offset (same PC ≈ 1 ms; guests ≈ one-way delay);
the grid runs locally (beat = `bi + ph` advanced at the BPM) and is nudged 25 % toward each packet (snaps if > ¼ beat
off), so beats land on time even when packets are late; kick / snare / drop events are placed at their real time
(packet t − age). No packets → free-run on the last BPM for 6 s, then the show eases back to steady. Test / preview
pages ignore the bus.

### Programs (per group, `SceneLightsState.lights.groups[group] = {program, intensity 0..2, speed 0.25..4, color}`)
| Program | Behaviour |
|---|---|
| `steady` | authored colour, on |
| `pulse` | flash on every kick, decays ~170 ms/√speed (on the grid's beats while the track has no kick) |
| `chase` | the group's fixtures (sorted left → right, then back → front) light one after another, one sweep per bar × speed, soft head + tail; single fixture = beat pulse |
| `strobe` | short flash (45 ms hold) on snares (and hats at speed ≥ 2), dim base between |
| `breathe` | cosine swell locked to the grid, one breath per bar × speed |
| `cycle` | hue steps through 4 offsets from the authored colour on every bar (eased), glows on the beat |
| `flicker` | neon buzz with the odd short drop-out (ambient — runs without music) |
| `drift` | slow random per-fixture glow (fireflies; ambient, a little brighter with the music) |
| `drop` | steady; peaks (×1.9) on a detected drop and decays over ~3 beats; dims in breakdowns, rises in builds |
| `off` | dark |

A group follows the **preset** in `lights.program` unless it has an explicit entry in `lights.groups` (picking a
preset clears them). Presets: `show` (room default — by group name: sign pulse, neon breathe, spots chase, fireflies
drift, ON AIR steady, accent cycle, board strobe, lamps/string drop, aqua/lava slow breathe), `steady`, `swampGlow`,
`onAir`, `beatPulse`, `strobe`, `party`. Unknown names (a room's own `scene.json lights.programs`) use `show`.
Master: `reactive` (off, or no music → every non-ambient program eases to steady: 0.35 s in, 1.2 s out),
`intensity` 0..2, `safe` (default **on**), `delay` −500..500 ms (OBS lights later/earlier than the analysis, to match
a delayed stream audio). All of it lives in `SceneState.lights` (sanitised in `shared/scene.ts`), is saved with the
scene and reaches every OBS page / guest like the rest of the scene state.

### Rendering + budget
Fixture meshes get their own **clone** of their `EMIT_<group>` material (same shader program → no recompiles; a chase
can light them one by one); another group's EMIT_ material on a fixture (the lamp on the transmitter) keeps
following its own group; EMIT_ meshes outside any fixture follow their group's mean level. Real lights: exactly the
placeholder's picks and caps (`LIGHT_BUDGET`: low 0 / medium 2 / high 3 / ultra 4, spot cans first, created once —
only intensity / colour change per frame). No bloom / post. Measured `update()` ≈ 0.02–0.04 ms per frame for the
Studio Zone (27 fixtures, 11 groups). `contract.ts` now skips the `_1/_2` child nodes GLTFLoader splits a
multi-material `LIGHT_*` mesh into (they used to show up as extra fixtures in a `default` group).

### Photosensitivity
With `safe` on, every big flash (kick pulses, strobe hits, drop peaks — and the real lights they drive) passes ONE
room-wide gate: at most one full flash per 333 ms (≤ 3 per second; hits < 60 ms apart count as the same flash); a
gated hit still shows at 10 % depth (was 30 %; see Reactive lights below). Chases are capped at 3 fixture steps per second. Measured: 16th-note snares +
hats at 174 BPM → 2.6 full flashes/s.

### Testing (never on the live bus)
`output.html?sceneTest=my_room&cam=wide&beatDemo=128` runs a synthetic packet stream in the page;
`vtpOut.debugScene({...vtpOut.sceneState, lights: {...vtpOut.sceneState.lights, reactive: true}})` turns the show on;
`vtpOut.beat.pose({beat: 1.03, sinceKick: 15, sinceSnare: 15, sinceDrop})` freezes a musical moment for screenshots
(then `vtpOut.step(1)`); `vtpOut.lights()` = per-group levels, real-light intensities and the ms cost. In an
`?observer=1` studio, Scene tab → Music input → Test beat drives the real worklet → engine → preview end to end.

# Reactive lights (overhaul): detection, roles, the director, the rig API

What the streamer sees: Scene tab → Lights → the **Reactive lights** card (`src/ui/reactiveLightsPanel.ts`): one
switch, a look (**Room** = the room's own colours · **Calm** · **Club** · **Rave**), Brightness, **Safe flashes**, what
the lights listen to (a detected loopback such as "Stereo Mix" / VB-Cable / Voicemeeter is one click; picking an input
also turns the lights on) and a live meter: BPM, the beat in the bar, the section (intro / groove / build / drop /
breakdown), how intense the music is, and "talking — lights calm". State: `SceneState.lights.reactive`, `.mood`
(`room` default | `calm` | `club` | `rave`), `.intensity`, `.safe`. Stream Deck: `POST /api/scene/lighting`
`{"reactive":"toggle"}`, `{"mood":"club"}`, `{"mood":"next"}`, `{"safe":true}` (bus / MCP `scene {reactiveLights:
{on, mood, safe}}`).

## Detection (studio) — `src/audio/beat/beatAnalyzer.ts`
One pure class run by the worker AND by the Node bench / unit tests (so the measured code is the shipped code):
**BeatEngine v8** (tempo / phase / downbeat / onsets) + **VoiceGate** (`voiceGate.ts`) + **Arranger**.
- **Talking never fires the lights.** VoiceGate: syllabic modulation of the 190–1700 Hz envelope (speech swings
  10–25 dB at 3–8 Hz, music beds don't), the share of pauses, sub-bass share, the tracker's own periodicity and the
  lip-sync mic's voice gate (the studio polls `app.audio` every 50 ms: a loopback that also carries the host's voice
  stays calm). States silence / music / talk / mixed with hysteresis (talk after ~1 s, music again after ~1.5 s).
  Talking → packets `on:false, md:2`, no events (older OBS pages ease to steady as before).
- **Tempo** range 70–232 BPM (was 85–190): lo-fi / boom-bap stays at its own tempo, hardcore / uptempo (190–230) is
  no longer halved; an octave-up guard doubles a half-time lock when a low-band attack fills every beat AND every half
  beat. **Downbeat**: when the low band can't tell (four-on-the-floor) the backbeat parity (snare on 2 & 4), tonal
  change on the bar line and arrangement events (a drop, the kick returning) break the tie. Silence gate −60 dBFS.
- **Arranger**: stable sections on bar lines (a candidate must hold 2 bar checks, builds 1; every section ≥ 4 bars),
  kick presence per bar from the isolated 48–90 Hz transient (a snare body / riser can't fake a kick), the **drop on
  the downbeat the kick returns** after a build / breakdown (not a beat later), the first kicks after an intro start
  the groove on that downbeat, 8-bar phrases (`pid` bumps on every section change + every 8 bars, `pb` = beat in the
  phrase) and a 0..1 **intensity** relative to the track's own loud parts (`e`).
- Packet additions (all optional; older receivers ignore them): `md` audio mode, `mc` music confidence, `kp` kick
  presence, `pb` / `pid` phrase, `dc` drop counter, `src` / `srcQ` clock source (see the DJ clock below).

Bench (`npx tsx tools/beat/bench.ts [--voices <dir of WAVs>]`, synthetic tracks rendered to PCM, never played;
`--legacy <engine.ts>` runs the beta.12 worker loop for before/after). Corpus: EDM 128, hardstyle 150, hardcore 200,
uptempo 220, hip hop 90, lo-fi 78, rock 120 (tempo drift), DnB 174, trap 140, quiet (−24 dB), loudness-war limited,
streamed (low-pass + noise), speech (formant synthesis, and recorded TTS voices rendered to file offline), talking over
music. Unit gates: `npx tsx tools/beat_unit.ts`.

| (bench, 24 tracks incl. 4 recorded voices) | beta.12 | now |
|---|---|---|
| exact tempo (±2 %) / octave-tolerant | 0.80 / 0.97 | 0.90 / 0.97 |
| hardcore 200 / uptempo 220 | 100 / 110 (halved) | 200.1 / 220.0 |
| lo-fi 78 | 155.8 (doubled) | 77.9 |
| beat F (±70 ms) / downbeat F | 0.90 / 0.68 | 0.93 / 0.85 (hardstyle 0 → 0.81) |
| sections right (frames) / section changes per minute | 0.50 / 4.3 | 0.84 / 2.5 |
| drops found / false drops | 8 of 9 / 9 | 8 of 9 / 2 (the drop lands on its downbeat) |
| light events per minute on plain speech | 144–276 | 0 |
| a tempo "found" in plain speech | 39–93 % of the time | 0 % |

Known limits: a very quiet input (−24 dB under a normal master) still tracks the tempo but finds downbeats / sections
poorly (the meter says so); trap at 140 locks at its 70 BPM half-time feel; kick EVENTS stay ~55 ms late (the
lights don't use them: pulses run on the predicted grid).

## Roles — `shared/lightRoles.ts`
Every group gets a role from its name (a room overrides any group with `scene.json lights.roles: {"<group>":
"<role>"}`): **practical** (lamps, candles, chandeliers, fire, ceiling / flood / street lights — steady, flames
flicker softly), **window** (windows, viewports, engines, planet / city glow — steady), **screen** (monitors,
terminals, holo, tickers — steady), **signal** (nav / beacon / alarm / status LEDs — their own slow blink, never the
music), **mood** (`mood_*`, the TTRPG engine's), **deco** (string / fairy lights, fireflies, bottles — twinkle),
**sign** (signs, ON AIR), **show** (spots, movers, beams, lasers, strobes, washes, stage / reveal) and **accent**
(everything else: coves, strips, neon, RGB, floor, bar glow). The first five never follow the music in ANY look
(presets, music styles and the director), unless the host sets that group by hand.

## The director — `shared/lightDirector.ts` (pure, every page computes the same frame)
SHOW / REACT with Beat reactive on, a look picked (`lights.mood`) and the SHOW preset left on the room show: every group the host hasn't set by hand
follows its role through a **show** = a look per section (idle, intro, groove, build, drop, breakdown), rotating on
phrases; palettes of 2–3 designed colours (base / contrast / accent, complements on different fixtures, never mixed
on one), changed on phrase boundaries; the **Room** look uses the room's own saturated light colours. Brightness
follows the intensity; pulses run on the beat GRID (latency-free) and scale with kick presence; white and strobes only
on drops / peaks; a section change crossfades over one bar (into a drop: a cut); talking / no music = the **idle** look
(the room as authored, breathing over ~10 s). The stage hemisphere + rim light take the look's palette (Room 0.22,
Calm 0.18, Club 0.38, Rave 0.5; the rim kicks on the grid). Music styles (`lights.style`) still win where they apply.
Rooms with groups lit only by `EMIT_<group>` materials (no `LIGHT_*` nodes) get one placed fixture per mesh (2–48
meshes, moving roles), so sweeps cross the room; rooms with no light groups at all get two coloured accent washes
(real point lights within `LIGHT_BUDGET`, created once, dark until Reactive lights runs).

**Photosensitivity** (`safe`, default ON) — `shared/flashGovernor.ts`, the ONE gate every output passes before it is
drawn: each fixture, its real lights, a group's shared EMIT_ meshes, each light group as a whole (an EMIT_ wall, a row
of PARs), house lights, the stage rim, the performers' show light, every beam / laser ray and the mirror ball — whatever
made the change (programs, the director, music styles such as Police / Strobe Storm, support cues, room moments, looks
another rig registered). No author flag is trusted: it measures each output's relative luminance (and saturated-red
entry / exit, WCAG's red flash). A turn back by more than 5 % of the brighter state (strictly under the 10 % that
counts as a flash) may only happen inside a room-wide window; windows sit on the beat grid (half beats up to 166 BPM,
beats above, every 2 beats above 333; 180 ms slots of the sender's clock with no grid), at least 180 ms apart and 40 ms
long (6 × 180 − 40 ≥ 1000: never more than 6 transitions = 3 flashes in any second, for any number of lights). Outside
a window a turning light holds within 5 % of its peak / dark (colour included: a darker colour is never pushed brighter);
a group that may not turn keeps last frame's light (every fixture rolled back). Content is shaped so the governor rarely
has to act: with the limit on, hits and colour swaps that would come more than 2.2 times a second play at half time
(Room and Calm always), the drop's white hit replaces the beat pulse under it, chases ≤ 2 steps / s, the effects rig's
70 ms drop chop becomes one hit and the laser half-beat flicker stops, cue sparkles slow to 1.5 / s.
**Opt-out**: with Safe flashes off nothing is held, but any light turning more than 6 times in a second shows the
"⚠ Flashing lights" notice on the OBS page (`src/scene/flashWarning.ts`) for 8 s. Room and Calm never trigger it.
Per path (`npx tsx tools/lights/flash_paths.ts`, Node simulator, stand-in lounge; worst flashes in any 1 s):

| path (limit on) | light | group | room | beams / lasers / ball | real lights | house |
|---|---|---|---|---|---|---|
| Rave, accents + EMIT_ walls, hardcore 200 | 2 | 2 | 2 | – | 2 | 0 |
| Rave, uptempo 220 | 2 | 2 | 2 | – | 2 | 0 |
| Club build, DnB 174 | 2 | 2 | 1 | – | 2 | 0 |
| bits / sub / raid / big cheers on a 200 drop | 2 | 2 | 2 | – | 2 | 0 |
| Police style, 200 | 2 | 2 | 2 | – | 2 | 0 |
| Strobe Storm style, 220 | 2 | 2 | 2 | – | 2 | 0 |
| laser rig + mirror ball on a 200 drop | 2 | 2 | 2 | 2 | 2 | 1 |
| a saved setup without a look (old room show), 200 | 2 | 2 | 2 | – | 1 | 0 |

The same paths with the limit off reach 5–15 per light (the laser rig 29) and every one turns the notice on.
| empty room (no light groups): the automatic accent rig, Rave 200 / Room 220 | – | – | – | – | 2 / 2 | 0 |

**Every other engine that animates light steps the same page governor** (`pageGovernor()` / `setPageGovernor()`:
the room light show registers its governor; engines without one get a self-framing stand-in), scored by
`tools/lights/engine_paths.ts` (worst flashes in any second, limit on · limit off · without the governor):

| engine output | on | off | ungoverned |
|---|---|---|---|
| club LED wall (whole-frame brightness: kick multiplier per visual + text + celebration flash; `governWall`), 200 / 220 BPM, every visual | 2 | 5 | 5 |
| show sky nebula band / searchlights / laser fans (the kick through `governK`), 200 / 220 BPM drop | 2 | 4–5 | 4–5 |
| night lights: fire / lantern flicker | 1 | 2 | 2 |
| chat rig LED strip + neon during a support pulse | 1–2 | 4–5 | 4–5 |
| screen skin LED bar pulse | 2 | 5 | 5 |
| drone police bar (red / blue: WCAG red flash, colour held) | 1 | 3 | 3 |
| sky-traffic ad glitch | 1 | 4 | 4 |
| room-form light programs ('flash' at speed 2, chases) | 1 | 5 | 5 |
| crowd support sign | 2 | 2 | 2 |
| muzzle flashes, a gun at 10 rounds / s (`SpotFlashGate`: one flash per 2 m spot per 360 ms; raid + warzone) | 3 | 10 | 10 |
| raceway hull hit (9.5 Hz shimmer → one steady glow, governed per ship) | 1 | 10 | 10 |
| dreadnought main-gun charge (6.4 Hz red strobe → 1.2 Hz swell, governed, red rule) | 2 | 7 | 7 |
| space engine flames / big beam buzz / dropship glow / fire sprites (`safeAmp`: ≤ ±4 %) | 0 | 5–8 | 5–8 |
| react screen + interview monitor power-on (24 Hz random brightness / band popping → steady, `uSafe`) | 1 | 7 | 7 |
| curtain neon tubes switching on (governed) | 2 | 12 | 12 |
| light props (Room editor `LIGHT_*` lamps + their `EMIT_` glow: a pack's maximum flicker, speed 5 × amount 1; shaped, governed, shared-clock ramps: docs/ROOM_EDITOR.md, `tools/proplights_unit.ts`) | 3 | 19 | 19 |
| capture-cover neon sign, screen-skin ON AIR lamp and pulse lights (governed) | 1–2 | 4–6 | 4–6 |

Also with the limit on: the club wall's bars / hashes step on half time above 132 BPM, the warzone flare's 150 m light
pool stops flickering, the performers' mirror-ball sparkle (7 Hz cells) is off, beams and rays carry the red rule.
Time-driven sweep (every fast `sin` / `cos` / `floor(t·n) % 2` / shader `uTime` term under src/scene): the rows above, plus
small or non-luminance ones left as they are — confetti / spark sizes (club, crew), town particle alpha, the town fire
shader (dominant 1.2 Hz), the TV bad-signal tear and CRT scanline crawl (moving patterns, steady average), motion
shakes and wobbles (space mover, slap, lounge, TV greybox). Checked and under 3 a second by design (not cyclic faster flashes): space battle alarm (0.75 Hz), kitchen alarm
(1.1 Hz), raceway alarm / beacon / launch (≤ 2 Hz), lounge bottles (0.8 Hz), interview monitor lamps (~1 Hz), voyage
lamps + the one-shot horn, voyage / frontline cannon muzzle flashes (one per gun per broadside), desert lightning
(restrike ≥ 360 ms with the limit on), lighting-state crossfades and room curtains (through the fixture governor).

**Saved setups**: a scene saved before Reactive lights v2 has no `lights.mood`: it keeps its old show exactly (programs,
music styles, no roles, no per-mesh split) until the host picks a look on the card (the card says so once); new scenes
start with `mood: 'room'`. The migration never changes `safe`.

| (simulator, stand-in lounge, EDM 128 unless noted) | beta.12 (room show + reactive) | now (Room) |
|---|---|---|
| room flashes per second (room-average trace) | 1.98 | 0.14 |
| lamps / windows / screens movement (std of level) | 0.29 | 0.05 (signal blink; flame flicker < 5 %) |
| movement while someone talks (plain speech) | 1.89 | 0.006 |
| drop brightness vs breakdown | ×1.13 | ×1.59 |
| light peaks on a beat (±50 ms) | 0.28 | 0.59 (the governor holds a hit up to one window) |

## The rig API (other light rigs — e.g. a festival stage — plug in without touching the engine)
```ts
import { registerPalette, registerLook, registerShow, registerFixtureKind, evalFixture, showLook, showPalette, newOut } from 'shared/lightDirector.ts';
registerFixtureKind('beam', { role: 'show', attrs: ['dim', 'mix', 'white', 'pan', 'tilt', 'zoom'] });   // built in: emissive point spot beam wash par strobe blinder laser pixelbar ledwall
registerPalette({ id: 'festival:hard_red', mood: 'rave', colours: ['#ff1a1a', '#ffffff', '#ff8a00'] });
registerLook({ id: 'festival:hs_drop', layers: [
  { kinds: ['beam'], level: [0.3, 1.2], colour: 'split', dropHit: 1,
    effects: [{ attr: 'pan', wave: 'sine', rate: 0.25, depth: 1, spread: 1, by: 'x', wings: true },      // fan in / out once a bar
              { attr: 'dim', wave: 'pulse', rate: 1, depth: 0.8, width: 0.25, kick: true, flash: true }] }, // gated beat hits
  { roles: ['accent'], level: [0.4, 1.1], colour: 'alt', effects: [] },
] });
registerShow({ id: 'festival:hardstyle', name: 'Hardstyle', mood: 'rave', palettes: ['festival:hard_red'], rotateBars: 16,
  sections: { idle: ['idle'], intro: ['rave_break'], groove: ['rave_groove'], build: ['rave_build'], drop: ['festival:hs_drop'], breakdown: ['rave_break'] } });
// per frame, per fixture:  const pal = showPalette(show, frame), look = showLook(show, frame);
//                           evalFixture(look, fixtureInfo, frame, pal, out)  →  out.dim / r g b (linear) / white / pan / tilt / zoom
```
- Registries are page-wide and the built-ins are sealed: another rig uses namespaced ids (`'<rig>:<name>'`), replacing a
  built-in id needs `{ override: true }`, and every registration is validated (finite rates 1/64..16 cycles a beat and
  depths, real `#rrggbb` colours, known waveforms / attributes / roles, shows naming registered looks + palettes) — a bad
  one throws. Whatever a look asks for, its output still passes the flash governor.
- `FixtureInfo` = role, kind, group, normalised place (x, y, z, angle, radius, index / count, seed), authored colour.
- `MusicFrame` = beat (continuous), bar, barPos, phraseId, phraseBeat, section, intensity, kick presence, kick / drop
  ages, buildK, bpm, the photosensitivity gate (`gate(key, startedAt)` → depth) and the room palette. Build it from
  the page's `BeatClock` (`src/scene/beatClock.ts`) exactly like `BeatLights.directPrep` does.
- An `Effect` = waveform (sine / tri / saw / ramp / square / pulse / random / hold) on an attribute (dim / mix / white /
  pan / tilt / zoom), `rate` cycles per beat, phase `spread` across the selection `by` x / y / z / ang / r / index /
  random, optional `wings` (mirror), `width` (duty / decay), `kick` (scale by kick presence), `flash` (through the
  gate). Layers match fixtures by `roles`, `kinds` or `groups`; colour rules authored / base / contrast / accent /
  split / alt / sweep / roomTint, `tint` (0 = authored … 1 = palette), `dropHit`.
- **A DJ clock**: packets with `src` ≠ `'audio'` (djsync's MusicClock extends `BeatPacket`) own tempo / phase /
  phrase on every page while they are LOCKED and live (< 1.5 s old); a second DJ clock takes over only with a strictly
  higher `srcQ`; an unlocked one (`lk: false`, no BPM) is ignored and never zeroes the grid. Audio packets keep
  bringing the mode (talking), kicks, kick presence and envelopes (a DJ clock alone drives everything); when the DJ
  clock goes quiet the audio grid takes over again. The studio relays DJ packets it hears on the bus to the Scene-tab
  preview and to party guests. Signals, flame flicker and the no-grid fallback run on the sender's clock
  (`BeatClock.showTime`), so every page and guest shows them alike. Section
  names map through `dirSection()` (rekordbox up / down / chorus / verse / bridge / outro included).

# Show pack — shared/showPack/*, src/scene/club/packRig.ts + clubPack.ts

~1,700 distinct light programs built from a grammar (`shared/showPack/generate.ts`, deterministic: the same list on
every page; `tools/showpack_unit.ts`). One program is a complete look for every fixture class: moving heads (a beam
**formation**), washes / PARs / pixels, strobes / blinders, lasers (a laser **formation**), an LED wall / pixel-ceiling
**pattern** and special-effects cues, each on a **rhythm target** with a **motion** envelope and a spatial **shape**.

| Atom | Values |
|---|---|
| Beam formations (54, `forms.ts`) | fan, tunnel, cross, counter, converge, mirror, orbit, spiral, wave, grid, starburst, pendulum, lift, chevron, diamond, helix, iris, ribbon, sail, steps, vault, wings, terraces, corkscrew, crosswind, orbitals, ballyhoo, cathedral, scissor, searchlight, crown, comb, rain, zigzag, flower, pillars, vee, snap · build: funnel, rise, vortex, pinch · groove: barfan, nod, sway, box, eight, bankwave · slow: drift, liquid, skytilt, bath, ceiling, halo |
| Laser formations (25) | fan, sheet, tunnel, cone, scan, cross, grid, star, helix, chevron, liquid, burst, wall, scissor, comb, zigzag, cathedral, vortex, crown, iris, ribbon, diamond, stack, dome, split |
| Rhythm targets (`rhythm.ts`) | four, offbeat, snare (2 + 4), hat (off-16ths), eighths, sixteenths, triplets, dotted 8ths, call (left calls, right answers, swapping every bar), phrase (every 2 bars), bar, half-bar, gallop (reverse-bass 16ths), shuffle, split, hold |
| Motions | hit, swell, saw, wipe, drift, pulse, sparkle, pump (sidechain duck), gate |
| Shapes | the verbs Breath, Glints, Ascent, Chase, Impact, Counterfire, Veil, Tides, Lift, Pursuit, Detonation, Exchange, SnareBloom · chases Loop, Halves, Steps, Centre · rolls PingPong, Scatter, Banks, Fill (double their rate with the build) · breaths Glow, Ripple, Tide, Swell · Bounce, Double, Dark, KickPump |
| Wall patterns (20, `walls.ts`, GLSL + CPU mirror) | pk_bars, pk_meter, pk_rain, pk_zoom, pk_flash, pk_shock, pk_halves, pk_slabs, pk_blocks, pk_check, pk_eq, pk_stripes, pk_aurora, pk_gradient, pk_horizon, pk_nebula, pk_sunrise, pk_stars, pk_ripple, pk_matrix (+ the festival walls' own visuals) |
| Strobes / blinders / cues | strobe snare / beat / offbeat / bar / storm / lightning / roll / kick · blinders drop / bar4 / downbeat / call · flames on the kicks / answering L-R / on the bar / chase / centre / wave, CO2 through the build, gerb lines |

**Families**: grammar (formation × target × motion, a strided sample per formation), score (16 routes × 13 verbs),
build (Funnel / Pillars / Pinch / Rise / Vortex / Zigzag × Banks / Chase / Fill / PingPong / Scatter × Bars / Meter /
Rain / Zoom × Hot), drop (Burst / Crossfire / Pillars / Snap / Vee / Wall × Accent / Double / Gate / Slam / Split ×
Flash / Halves / Shock / Slabs × Half / Double × Wide), groove (BankWave / BarFan / Box / Eight / Mirror / Nod / Orbit /
Sway × Bounce / Four / Off / Pump / Shuffle × Centre / Loop / Split / Steps × Blocks / Check / EQ / Scan / Stripes ×
tempo), slow (Bath / Ceiling / Drift / Halo / Liquid / Search / SkyTilt × Breath / Glow / Ripple / Swell / Tide ×
Aurora / Gradient / Horizon / Nebula / Stars / Sunrise) and ~55 named signatures (Laser Cathedral, Laser Tunnel,
Scissor Lasers, Heartbeat Tunnel, Prism Avalanche, Lightning Strikes, Liquid Sky, Moon Beam, Euphoric Fans, Thunder
Strobe, Crowd Wave, Sunrise Breakdown, Snare Roll Riser, Flame Wall, Ice Tunnel, Laser Dome, Power Hour …).
**Dedupe**: two programs equal on 6 of the 7 visual axes (beam formation, laser formation, target, motion, shape,
wall, the lasers' rhythm) are near-identical and the lower-scored one is dropped (colour alone never makes a program).
**Rules** (`packRules`) reject what reads badly: a calm formation on 16ths, snapping heads with a slow breath, strobes /
pyro in chill looks, more than 2 hit layers, beams and lasers both on 16ths … **Tags**: energy class + energy, the
sections it suits, the genres it fits (hardstyle, rawstyle, hardcore, house, techno, trance, dubstep, dnb, bigroom,
chill), `flashy` (built on flashes: it has a Safe variant that keeps the energy with motion + colour).

**Rhythm input** (`RhythmFrame`, `rhythm.ts`): beat / bar / barPos / bpm, kick / snare / hat envelopes (`onsets: true`
when they come from detection), energy, section, build ramp, drop age, phrase beat, optional `sectionHints`. Hit
positions always come from the beat grid (latency-free); detected onsets only scale depth. Until the multi-band onset
detection lands, `gridOnsets()` stubs kick / snare / hat from the grid; `rhythmFromClock(BeatClock)` uses the clock's
kick / snare / hat events when they are fresh.

**Where it plays**
- **Every room** (the director, `shared/showPack/director.ts`, registered by `src/scene/lightShow.ts`): every program is
  a director look `pack:<id>` + its Safe variant `pack:<id>s` (`compile.ts`: formation → pan / tilt, target → rate +
  phase, shapes, strobes → gated white). The built-in **Club, Rave and Calm** shows get a `pick` hook: per 8-bar
  phrase + section the pack picks a program that fits the section, the tempo's genre and the mood (deterministic per
  phrase: every page plays the same look); every 4th phrase (Calm: 3rd) plays the show's own looks. Club and Rave also
  get more palettes. *Match the room* is unchanged. Programs are generated on the first pick and each look is compiled
  the first time it plays (page start stays light). An engine can also play the pack mirror-symmetric about the rig's
  centre (`PackFrame.sym`: every fixture plays its mirror twin, pans mirrored; off by default).
- **Festival stages** (`shared/showPack/festival.ts`): every program is a festival look `p<id>` at the END of the
  catalogue (`[shipped, the room's own palettes' looks, pack]`: every index a LOOKS_VERSION 1 curation saved before the
  pack stays put), every show — and a room's own shows (scene.json festival.shows, a themed stage) — gets a pack POOL
  per section (`Show.pack`: intro 5, groove 10, build 8, drop 14, breakdown 6, outro 4; a chill show's "drop" is its
  chorus), played in the show's palettes (unless a signature keeps its own). `PACK_SHARE` (60 %) of phrases play the
  pool; the others pick from the show's own section list exactly as before the pack (the director's `fest:<id>` shows:
  the same split through a `pick` hook). The evaluators
  hand pack looks to the pack (movers, washes / PARs / pixels, strobes with the director's countdown + drop hit,
  lasers: mode `pack` → `lasers.ts` draws the formation's rays + sheets), the LED walls draw the pack patterns (index
  19+), the director adds the program's cues (flames, CO2, answering blinders) within the usual budgets.
- **The club** (`src/scene/club/packRig.ts`, driven by `clubPack.ts`, rooms with a scene.json `club`): its own rig plays
  the program the director picked, in the show's palette - on the phrases where the show plays its own looks the rig
  stands down (fades out in 0.35 s); on *Match the room* the club pool's own pick:

  | Tier | Moving heads (trusses) | Beam bars (stage lip) | Laser origins × rays | Pixel ceiling (LEDs across) |
  |---|---|---|---|---|
  | low | – | – | – | – |
  | medium | 8 | – | 4 × 10 | 28 |
  | high | 12 | 2 × 8 | 6 × 16 | 44 |
  | ultra | 20 | 4 × 10 | 10 × 24 | 64 |

  `club.rig: { boost: 1..2, on: false }` in scene.json: a room built for a faster GPU (RTX 3080 / 4070 Ti class)
  draws up to twice the tier's heads / lasers and 1.5× the bars / rays (the festival's `boost`, the same idea). Anchors:
  the room's FX_BEAM_* / FX_LASER_*, then automatic rows from the room's inside (front truss, over the floor, the stage
  lip, the corners, the DJ booth, the side walls). 4 draw calls. The rig plays in SHOW / REACT (half) with Reactive
  lights on and music; a PRESHOW-style effects look shares the room at half level.
  **The show owns the room**: in SHOW with music the house (the room's materials: walls, floor, bar) goes down to
  6–16 % by section (intro 16, groove / build start 12, sinking through the build to the drop's 6, breakdown 10; Calm
  ×2.4, Match the room ×1.4) over ~1.4 s, through `BeatLights.showDim` (× the look's house level, before the house
  governor); the crowd's light floor goes with it and the show's wash tints them at their own brightness; the haze
  thickens a little and the heads' gain comes down (they read in the dark instead of flooding it; wide zooms spread
  their light; a head cone keeps its radius + 3 m clear of the lens). Practicals, neon, signs and the LED wall keep
  their own light. Talking (the beat clock's talk mode), REACT, BRB and no music bring the house back (0.7 s). The
  performers' stage lights (their key, faces) are never dimmed.
  Pattern time (the pixel ceiling, the festival walls) is the shared wall clock from an anchor on a shared grid
  (`sharedSec`, `shared/showPack/rhythm.ts`): every page (studio, OBS, party) plays the patterns in phase.

**Photosensitivity**: every output passes the governors (the room's `FlashGovernor`, the festival gate + governor).
With Safe flashes ON: fast targets play spatially (each fixture takes every k-th hit), hard hits soften, the strobe
patterns stand down to one soft lift a bar, colour swaps go smooth, rays dim with their swing speed (the aim's and the
formation's own rays round it: `packRaySwing`; multi-tier formations stop hopping a tier per beat) and fade in on a new
pattern, beam / laser formations cycle at most `SAFE_BEAM_RATE` / `SAFE_LASER_RATE` per motion beat (slow and bright
rather than fast and dimmed), the club's heads dim with their swing speed too, the club ceiling's pattern beat stays
under 0.75 a second and the club rig's palette crossfades at a phrase change (an instant swap against the room's own
lights changing a moment apart turned the whole frame twice), and the director plays each program's Safe variant (hits on the governor's half-beat grid, in unison,
triangles peaking on the grid; `tools/showpack_unit.ts` checks every one stays ≤ 3 flashes a second per fixture at
70–230 BPM). `tools/festival_gov_unit.ts` covers the pack walls (patches) and 63 pinned pack looks; `tools/showpack_e2e.mjs
clubflash --bpms 70,150,174,200,230` is the drawn check on the club (the dark room included: a darker baseline shows a
flash more, so it runs with the house down).

Test pages: `looklab.html?sheet=1&family=<family>&from=0&n=36` (contact sheets per family); club:
`vtpOut.club.scene.pack.pin = '<program id>'`, `vtpOut.club.scene.info().pack` (level, program, counts, rays drawn);
`vtpOut.club.scene.pack.houseTest = 0.06` (hold the house level; A/B); `tools/showpack_e2e.mjs
labsheets|club|clubperf|clubflash|ab` (`club` also shoots the house: drop, talk, react, back to the show).

# Lighting states

`SceneState.lights.state` = **preshow | show | react | brb | outro** (default `show`), host-owned, saved and sent to
OBS + guests with the rest of the scene state. `lights.states` holds the host's edits of the other looks (missing =
`DEFAULT_LOOKS` in `shared/lightShow.ts`); `lights.stateFade` = change duration (s, default 2, 0 = cut).
A look (`LightingLook`): `house` (room lighting 0..1.2), `tint`, `program` (group preset, `''` = same as SHOW) +
`groups` overrides, `fx` (effects rig 0..1), `palette` (authored / club / sunset / uv / ice), `music` (`auto` = always
animated: the music input, else a built-in 124 BPM auto show with a drop every 16 bars; `user` = the Beat reactive
toggle), `energy` (effects speed).

| State | Default look |
|---|---|
| PRESHOW | house 12 % with a cool blue tint, `banger` groups (sign pulses hard, neon/accent colour-cycle on the palette, spots chase ×2, board strobes, fireflies drift fast, ON AIR off, lamps 12 %), full effects rig, club palette (changes every 8 bars and on drops), always animated |
| SHOW | exactly the normal lighting: the Lights section settings, house 100 %, no effects (beat reactive only if turned on) |
| REACT | SHOW's groups, house 60 % |
| BRB | house 30 % violet tint, slow breathing (`brb` preset) |
| OUTRO | afterparty: like preshow, warmer (sunset palette), slower, 75 % effects |

**House lights** = every non-EMIT_ material of the room (not the react screen): colour × tint × level, environment
(IBL) intensity × level, and metalness leaned towards 1 as the level falls (dielectric specular ignores the colour, so a
dark room would otherwise stay grey). Level 1 restores the authored values exactly. Drops add one gated white hit.

**Transitions**: PRESHOW → SHOW plays the **show-open** over `stateFade` s: blackout at once (effects off), ON AIR slams
on at 15 % (flash, then settles), the house racks up in 4 steps (25/50/75/100 %) at 25/40/55/70 % while the
fixtures come on bank by bank left → right. Every other change crossfades (levels, hue, house, tint, effects).

**Effects rig** (`src/scene/fxRig.ts`): moving-head beams (additive soft cones, one InstancedMesh; unison sweep /
mirror fan / circle / wander patterns, a new one each phrase; converge + white hit on drops), laser fans (thin additive
rays, one InstancedMesh, scanning, flicking with the hats), mirror ball (faceted ball + spinning light spots projected
onto the room's interior box — ray-cast once from the spots — one Points draw). No post / bloom / shadows; depth-tested,
depth-write off. Counts by tier: low none · medium 4 beams / 6 rays / 48 spots · high 6 / 10 / 96 · ultra 8 / 16 / 160.
The real spot lights (the same capped ones) sweep like moving heads and take the palette. **Face protection**: every
beam / ray is tested against the camera → face segment of each performer (4× a second); one passing within its radius
+ 0.28 m fades out. Measured (Studio Zone, 720p, high): light-engine CPU ≈ 0.08–0.12 ms/frame in PRESHOW; whole frame
with GPU sync +0.1–0.3 ms vs SHOW. the VTube Pro studio anchors live in `scene.json lightRig`; `build_scene.py` now
keeps hand-added scene.json keys (lightRig, soloScreens …) when it regenerates the file.

**Control**
- Scene tab: five big state buttons at the top (current one highlighted), and a *Lighting states* section (change
  duration, per-look editor with house / tint / effects / palette / speed / groups / music + per-group program and level,
  "Reset this look to default").
- Studio keys: **Shift+1…5** = Preshow, Show, React, BRB, Outro.
- HTTP (Stream Deck "Website"/"API" action): `POST http://127.0.0.1:5191/api/scene/lighting` body `{"state":"preshow"}`
  (localhost only). The server asks the host studio over the bus (`{type:'command', command:'scene', args:{lighting}}`);
  the studio switches, saves and sends it on — so the studio must be open. Also the bus/MCP command `scene {lighting}`.
- OBS: with the OBS automation enabled, *Lighting states → OBS scene → lighting state* maps program scenes to states
  (`config/obs.json lightingMap`, e.g. "Starting Soon" → preshow). The server keeps a separate event-only obs-websocket
  connection (Scenes events) ONLY while a mapping exists, and switches on `CurrentProgramSceneChanged`. Tested against a
  mock obs-websocket server only.
- Engine hook: `cue('screenLand')` (called by SceneRuntime when the solo react screen lands) = an ON AIR slam + accent,
  through the photosensitivity gate.

Test pages: as above, plus `vtpOut.debugScene({...vtpOut.sceneState, lights: {...vtpOut.sceneState.lights, state: 'preshow', stateFade: 0}})`;
`vtpOut.lights()` reports `state`, `trans` (progress), `house`, `fx` (counts, anchor source, per-beam face fades).

## Lights down = low light · show presets (pass 3)

**House mapping** (`shared/lightShow.ts houseLevel`): the House slider is perceptual with a floor — 0 = lights down =
16 % of the authored room light (never black), `0.16 + 0.84·v^1.25` up to 1 = normal, above 1 brightens. Saved values
keep their meaning as "how far down" (a saved `house: 0` now renders as the low-light floor). While the house is down
the **practicals stay lit** (`PRACTICAL_FLOOR`, fading in below 75 % house): lamps ≥ 60 %, lava lamp 70 %, sign 55 %,
string lights 55 %, fireflies 50 %, tanks 45 %, ON AIR 30 % — unless the look explicitly sets that group to Off. The
night windows (self-lit backdrop) stay ≥ 45 %. The show-open blackout bottoms out at 5 %, not 0.
**Performer wash**: in effects looks the stage's hemisphere light takes the palette (sky A / ground B) and the cool rim
light becomes a brighter palette-B rim that kicks with the beat — colours only (the engine never touches their
intensity, so SceneRuntime's landing dip keeps working); restored exactly at SHOW / on dispose.

**Show presets** (`shared/lightPresets.ts`, 51 looks in 4 categories — chill 12, mid 14, banger 14, themes 11): each
is data — house level + tint, effects amount and [beams, lasers, ball] mix, palette pairs, beam-motion list, laser-look
list, colour split (odd/even, left/right, mono), mirror-ball spin, effects speed and per-group programs by group kind
(sign / neon / accent / onair / spots / fireflies / board / lamps / string / lava / aqua / other, so every room works).
A preset is registered as group preset + palette `p_<id>`; `lookFromPreset()` makes a state look (`look.preset = id`
drives the rig). `look.cycle = {cat, every}` auto-cycles the category every N phrases (8 bars) on every page from the
beat clock. Default PRESHOW = House Party, BRB = Lo-fi Rain (house 0.3), OUTRO = Sunset Sway.
Renamed presets keep loading: `PRESET_ID_ALIASES` maps the old ids (`swamp_rave` → `house_party`, `frog_disco` →
`disco_fever`, `acid_lily` → `acid_uv`, `spooky_bog` → `witching_hour`, `moonlit_bayou` → `moonlit_night`,
`bayou_sunset` → `sunset_sway`); old `p_<id>` programs / palettes in saved looks and old favourites resolve too.

**Movement** (`fxRig.ts`): beam motions sweep · fan (fan-out / in) · figure8 · ballyhoo (big random throws snapping
every 2 beats) · circle · cross (left rig ↔ right rig) · wander · still, changing every 8 bars; laser looks fan · cross ·
tunnel (a spinning cone) · sheet (flat scanning plane) · scan, changing every 16 bars; both jump on drops; palettes step
every 8 bars and on drops. Arrangement-aware: **builds** (buildup section or energy rising) speed up, widen and brighten;
**snare rolls** (≥ 4 snares / 1.2 s) turn beams into a fast one-by-one chase and lasers flutter; **drops** converge +
one white hit (still through the photosensitivity gate when it is on), then **release** into a wide fan; **breakdowns**
slow everything to ~40 %, dim the rig and the mirror ball. The built-in auto show (no music input) now plays a 64-beat
arrangement: groove · 2-bar kickless breakdown · groove · 3-bar build · 1-bar 16th snare roll · drop. Beams whose
fixture is within ~2–3.5 m of the camera fade out (they would fill the frame). Cost unchanged: light engine
≈ 0.07–0.11 ms/frame at 720p high in PRESHOW.

**Preset browser** (Scene tab → Lighting states): categories, search, ★ favourites (this browser, localStorage),
🎲 Surprise me (random preset from the category into the edited look), auto-cycle (category + every 1/2/4/8
phrases), per preset ▶ Preview / Use / ★. Preview goes only to the Scene-tab preview page(s)
(`PreviewPage.lookPreview` → `BeatLights.previewLook`) — nothing is saved, broadcast or sent to guests; Use applies
the preset to the look chosen in "Edit look" (SHOW: only its group programs, the house stays normal). Known limit: the
Studio sign is one mesh, so a letter-by-letter sign chase isn't possible without splitting it in the room build.

## The show on the performers · performance (pass 4)

**Performer lighting** (`src/scene/performerLight.ts`) — no extra real lights. Every lit material of each performer
(MToon VRMs, the studio toon / toy / realistic materials, plain standard) gets one small shader patch the first time
the performer is seen in a room (so no recompiles when states change): an additive, clamped "show light" =
3 toon-banded directional colour terms + an ambient colour + a colour rim + an optional screen-space sparkle
(mirror ball). Per frame (CPU, ~0.01–0.03 ms for 2–9 performers) every beam cone is tested against each performer's
head and chest; the 3 strongest become the directional terms (lit from the fixture), the rest + the palette wash +
drop hits go to the ambient. Clamp: the added light never exceeds ~0.85 × the surface's own colour (faces never blow
out, never darken; eyes / mouth decals that are unlit or custom shaders are left alone). MToon hook: after the final
`gl_FragColor = vec4( col, diffuseColor.a )` in main (not the debug branch, not the outline pass); three.js materials:
before `#include <tonemapping_fragment>`. All uniforms are zero in SHOW → avatars look exactly as before.
Beams also do "talent hits": the last bar of every 4 and the bars after a drop they swing onto the performers.
Face protection now only applies when a face is big on screen (talk / close shots); in wide shots beams may cross
people. `ctx.actors()` (SceneRuntime) hands the light engine the performers.

**Performance**: effect shaders are pre-compiled when the room loads (`ctx.warm()` → `renderer.compile`) — the first
PRESHOW used to compile 3 programs (≈26 ms hitch); beams draw front faces only with 12 sides; faded / off beams are
collapsed to zero size; `FxRig.setLevel(0..2)` + an auto-downgrade ladder (frame interval with effects on vs the
page's own cadence; slow for 3 s → half / quarter beams, rays, spots; recovers after 30 s); real-light count never
changes; the Scene-tab preview iframe renders at 20 fps. Measured numbers: see the lights agent's pass-4 perf table.


# Chat & events (in-world chat monitor, support board, chat buddy)

> **Host Chat Hub** (big chat window for the host, events queue with Acknowledge / Thank on stream, read-aloud of donation
> messages, Twitch + TikTok connectors, the "Connect your chats" wizard, Stream Deck URLs): see **[CHAT_HUB.md](CHAT_HUB.md)**.

Live chat + support events from **Kick, Rumble and YouTube** (+ Twitch and TikTok, CHAT_HUB.md), ported from an earlier overlay (`src/chat/*.js`,
`src/finance.js`), rendered IN the room. Read only: nothing is ever posted to a platform, nothing is moderated.

| File | Role |
|---|---|
| `server/chat/kick.ts` | Kick: channel lookup (`kick.com/api/v2/channels/<slug>`) + public Pusher socket (Overlay logic: Kicks in every payload shape, gifted-sub bursts coalesced to one attributed gift, sub/resub merge, hosts, follows) + badges, `[emote:id:name]` + 7TV emotes, deleted messages / bans |
| `server/chat/rumble.ts` | Rumble Livestream API poll (your API key): chat, Rants (amount_cents / amount_dollars, wallet tips), subs (paid value), gifted subs (`purchased_by`, `total_gifts`), followers |
| `server/chat/youtube.ts`, `youtubeGifts.ts` | YouTube InnerTube live chat (no OAuth / quota): Super Chat / Super Sticker (own currency), Jewels gifts (Overlay deep-scan), memberships, milestones, gifted memberships (+ count), redemptions, deletions, custom emoji |
| `server/chat/finance.ts` | Overlay `normalizeFinance` / 15 s dedupe (TS) + original-currency display, approximate USD (static rates, never counted), tier colours |
| `server/chat/hub.ts` | one stream of `ChatEvent`s (`shared/chat.ts`): dedupe (platform ids + persistent recent-id set, survives reconnects / restarts), ring for late pages, bus `{type:'chat'}` / `{type:'chatStatus'}`, session log `cache/chat/events-YYYY-MM-DD.jsonl`, session totals `cache/chat/totals.json` |
| `server/chat/config.ts`, `server/routes/chat.ts` | `config/chat.json` (gitignored; the Rumble key is never returned), Import from an earlier overlay (reads its `config.json`), `/api/chat/*`, emote image proxy (allow-listed CDNs → `cache/chat/img`) |
| `src/chat/feed.ts`, `chatCanvas.ts` | page-side store; canvases (monitor / tablet / board) redrawn only on change, ≤ 15 Hz while animating |
| `src/scene/chatScene.ts`, `chatRig.ts`, `chatPlace.ts`, `chatBuddy.ts`, `chatBuddyPlace.ts`, `chatBuddyRoam.ts` | the props, placement solver, drop rig + confetti, Sprocket (tablet placement, roam mode) |
| `src/chat/studioChat.ts`, `src/ui/chatPanel.ts` | studio: party relay + Scene tab "Chat & events" |

**Flow**: server → bus (this PC's OBS + preview, origin `local`) · host studio → party wire `{t:'chat'}` (sanitised,
≤ 40 KB, test events never leave the PC, a snapshot for guests who join) → guest studio → its bus (origin `party`,
+ a catch-up batch when an OBS page connects). Guests' OBS pages show the HOST's chat.

**Options** (`SceneState.chat`, host-owned, sanitised in `shared/chat.ts`): monitor, panel `off|panel|monitor`,
buddy (+ `buddyAt` walk-in stamp), buddyModel (an avatar id; default `DEFAULT_BUDDY` = `robot`, Sprocket; a saved `''` from before the picker = `LEGACY_BUDDY`, the buddy it showed then), tablet (tablet size 0.6–2.5×),
tabletText (tablet text size 0.5–1.6×), buddyMode ('roam' default | 'stay'), buddyRange ('room' | 'near'), autoDrop / idleSecs, side, size, font, hideCommands, hideBots (+ names), minAlert
($), alertSubs, converted (≈ USD), goal {on, target, label}.

**Placement** (per current shot = `resolveCamera(state.camera)`, never the walk-in follow cam): authored anchors first —
empties `CHAT_MONITOR_xx` / `CHAT_MONITOR`, `CHAT_BOARD_xx` / `CHAT_BOARD` (origin = display centre, +Z faces the
camera, extras `width`), `CHAT_BUDDY_xx` / `CHAT_BUDDY` (floor point), or scene.json `chatMonitors` / `chatBoards` /
`chatBuddy` keyed by `SPOT_xx` (`{position, yaw, width}` like `soloScreens`; an authored anchor may rest on furniture
and stand in front of a torso, never over a face; un-numbered nodes only count within 4.5 m of the host's seat, so a
far anchor goes in scene.json per spot); else automatic (depths behind the subject first, then nearer ones to the side): in frame, readable size,
near the host's depth, never over a face, the react screen or the other prop, not through walls / furniture (room
BVH), with a ceiling for the housing; the shot's subject keeps their whole body clear, a neighbour's torso may sit
behind a prop (weighted 0.4, so crowded talk shots still get their chat), faces never. A prop still good for a new shot stays; otherwise it winches up and drops at the
new place; no valid place = it stays up. Sprocket: free floor point in frame near the host (≥ 0.78 m from every
SPOT_*, clear of COLLIDE_* boxes, head + tablet visible, never over anyone / photobombing); in shots with no room for
him he waits just outside the frame. Searches run ≤ 3 ms per frame.

**Sprocket placement (tablet first, always in the shot — this replaces the older "waits just outside the frame" note above; `src/scene/chatBuddyPlace.ts`)**: per shot, (1) **world** candidates = room anchors `BUDDY_SPOT_xx` (for the host at SPOT_xx) / `BUDDY_SPOT` (within 4.5 m; may be a shelf / railing / desk top — he poofs up) / the older `CHAT_BUDDY*`, scene.json `buddySpots: { "SPOT_01": [[x,y,z], …] }` (glTF space), his current place, a camera-space floor grid and **perches found automatically** (downward BVH probes across the frame: flat furniture tops under eye level — desks, counters, crates; 4-neighbour flatness, never on a SPOT_*), each tried at his normal size and, only if nothing fits, at 80 % / 64 % of it. Each is scored with the tablet raised (chest first, a bit lower, over his head only as the last resort — never at face height): fully in frame, facing the lens, readable (the chat text ≥ 14 px at 1080p: `hfMin` follows the tablet size + text size — a bigger tablet or smaller text needs a bigger tablet on screen), off every face, his head + body off faces, the react / solo screen and the chat monitor / board, not hidden by a performer in front; the best are ray-tested (room BVH + exact mesh raycast on 9 tablet points, plus nothing cutting through his body or the tablet, and HIS face seen — not only the tablet: ≥ 3 of 4 head points unhidden, his own tablet over < 20 % of his head). **Faces are sacred** (owner rule): a plan is rejected if the tablet's screen rect touches ANY face box projected through that shot's camera — each performer's (`performerRects` + margin) and the buddy's own (`faceBand`: the measured face, grown toward a screen-head's size, capped for long hair) — and his whole head (measured head top: hair, ears) must sit inside the frame; the cheer bounce is planned too (`TabletPlan.cheer` / `hop`: full, half or none, so the top of the bounce never reaches a face). The live check also fails a tablet over a face through the live camera. Tests: `npx tsx tools/buddyface_unit.ts`. (2) No world place → the **foreground peek** (`mode 'fore'`): the real 3D buddy right in front of the lens (0.7–1.2 m) in a bottom corner, feet below the frame edge (or hidden behind the tablet), tablet toward the middle, scaled so the tablet is readable, glued to the live camera every frame, no cast shadow; rays check nothing sits between the lens and him; beside a big React screen (≈ 10 % margins) the tablet is held **upright** (3:4 — the chat re-flows into a taller column at the same text size). A tablet too big to be fully readable anywhere in the shot (e.g. 2.5× with small text) is still shown a bit smaller (text ≥ 70 % of the readable size) rather than not at all. (3) Only if the foreground is blocked too (a wall right at the lens) → **overlay**: the tablet held into the frame from a bottom corner clear of every face / screen / prop (his green arm slides in, drawn on top); no clear corner = nothing drawn (never over the react screen). The tablet is always **square to the image plane** (no tilt / keystone at the frame edges of wide or pitched shots). He waits (≤ 0.6 s) for the chat monitor / board to find their places and re-plans when they land, and the live check also fails a tablet hidden behind the monitor / board. **Cost**: the performers are capsules (never raycast skinned meshes), the shot is only re-resolved when what picks it changes (or every 2 s), searches are time-sliced ≤ 2 ms — measured ChatScene.update p95 ≤ 4 ms, mean ≤ 0.6 ms with 1 / 4 / 8 / 12 performers (was ~80 ms / frame with 8 and seconds with 11). Short hops on the floor at the same size walk, anything else is a quick poof (smoke puff, pop-in). A live check twice a second (settled shots, only while the camera IS the planned shot — never during a walk-in follow cam) marks a place bad (or the peek) and re-plans if the real tablet is hidden. Coverage harness (private test tree): tablet in frame, ≥ `hfMin`, < 35°, ≥ 4/5 points unoccluded, not over a face / the react screen — per room × shot × group size.

**Sprocket roam mode** (the default; Scene tab → Chat & events → Sprocket chat buddy → **Behaviour: Roam around / Stay put**, + **Wander range: Whole room / Near me**; `src/scene/chatBuddyRoam.ts`): he lives in the room instead of standing in one tablet spot. Per shot a time-sliced search (`planRoam`, ≤ 2 ms a frame, no per-frame rays) finds up to 14 **roam spots** in view — whole body in frame, his whole face seen (7 rays), nothing sticking through him (a ring of short rays), not over anyone's face / the react screen / the chat monitor / board, not hidden behind a performer or furniture, not a giant right in front of the lens, same candidate grid + perch probes as the tablet planner (perches are moved to their lens-side edge, with a floor point beside them he hops up from; he may sit on the edge, legs dangling) — which of them give a **readable raised tablet** (the full tablet test above, with 10 % margin), a few **show-only spots** nearer the lens when too few do, and the straight **walks** between them (room rays at knee + chest height, COLLIDE_* boxes, floor all the way, ≥ 0.6 m from performers, never passing in front of a face or vanishing behind someone) — walking-TV guests count as performers (their screen is their face); only the largest connected group is kept. His size is the normal buddy size (else 80 % / 64 % when the shot is tight), the same for the whole shot. **Timeline** (`simulate`): deterministic like the kitchen planner — 7.5 s slots counted from `buddyAt` (seed = hash(buddyAt, room)); each slot rng(seed, slot) picks wander (prefers spots 1–4 m away, readable ones ×3) / hop onto a perch / stay, then a bit (wave at the lens, peer at the host with a hand over his brow, stretch + yawn, sit down, read his own tablet, look around + scratch his head, hop, a little dance; now and then a walk has a **trip**: face-plant, the tablet flies out of his hand, he picks it up, dusts himself off, sheepish look). Windows of 8 slots start at a seeded spot, so any page simulates only from the current window's start: every OBS page (host, guests — same `buddyAt`, same room, same events) and a page opened late show the same walk. **Chat**: every visible chat / support / system event (its `ts` + 0.6 s — the same on every page) makes him hurry to the nearest readable spot (or show where he stands if it is one), face the lens and raise the tablet (0.35 s) until 7 s after the last message (≥ 4 s; after 30 s of busy chat he walks to another readable spot and keeps showing), lower it and wander on; a readable-spot live check (twice a second while it is up, as in stay mode) drops a spot whose tablet turns out hidden. Walking he carries it at his side (big tablets like a tray; stand models: floating beside him, the pole only while it is up). **Fallbacks, in order**: no readable spot in this shot (or none within a short hurry, ≈ 2.3 m) → for the display time the tablet plans above take over, planned with the same 10 % margin (a smaller world spot / the foreground peek / overlay): for the peek he walks up to the lens (≤ 1.3 m, out of the frame at the bottom) and the peek rises from the bottom edge, then sinks back and he walks in again from there; otherwise a quick poof there and back (he pops back in exactly where the timeline has him) — the tablet never goes up unreadable in the room; no roam spot at all (tight close-ups, a big react screen) → the stay-mode plans. Stage layouts that dock chat (React Full / Medium, Gaming: `src/scene/stage/compositor.ts` turns the in-world props off) → he leaves; React Big / Side → he roams the room shot (the planner works in the shot's own frame, the layout's view offset only widens it). **Camera cuts**: a jump of the camera that shows him somewhere wrong (over a face / the react screen, cut by the frame edge, a giant) hides him on the cut frame; off-screen he simply walks in from where he is; else from outside the nearest frame edge; else he pops in onto the timeline; a shot change without a cut (a smooth camera move, props landing, the solo screen landing) → he walks to where the timeline wants him. The shot key includes the react / solo screen's rect, so a screen that lands after the plan re-plans him. Debug: `vtpOut.chat.debug().buddy.roam` (set, timeline segment, joins: walk-in / edge / pop / catch-up), `vtpOut.chat.scene.roamDebug()`.

**The chat buddy** ("Who brings the chat?" — the Chat wizard's *In the room* step and Scene tab → Chat & events,
`src/ui/buddyPicker.ts`): any library / builtin avatar (`buddyModel`; Sprocket by default, then Mirelle, Kairo and the
user's own imports) — loaded with NO costume / accessories (profile copy, never saved), not a
party member, never in `spots`. The model is loaded from each page's OWN library (model custody: avatars never cross
the party link): a page that doesn't have that avatar (a guest's OBS) shows the default buddy, and a model that fails to load
falls back to it too. Size: normalised to buddy height (room avatar height × 0.72 for big-headed mascots / chibis,
× 0.86 for human proportions). Holding: tablet ≤ 1.25× one-handed at his side, bigger two-handed in front of him (head
peeks over it); the hands reach the tablet's grips by arm IK on the normalized humanoid (any VRM / humanoid-mapped
rig — `src/scene/buddyRig.ts`: a missing hand bone is taken from the finger roots or estimated, sides follow the
geometry on mirrored rigs, stub arms don't count); a model without usable arms gets the tablet on a pole stand next to
him; a free arm hangs relaxed (T-pose binds don't stick out). Hand-tuned bodies (`TUNED_BUDDIES`) keep their proportions; other models are measured from the rig + mesh (chest
height, head, arm length, the chest's FRONT and torso width: the tablet is held clear of a barrel chest even when turned
to an off-axis lens, under the chin for human proportions, and a big hand grips it from behind). **Tablet size** (`tablet`, 0.6–2.5×): the canvas
grows with it (640 × 480 at 1×, 512–1600 px wide) while the text keeps its size on the tablet (`ChatCanvas.textScale`
= tabletText / tablet) — a bigger tablet shows more lines, never blurrier ones; **Tablet text** (`tabletText`) =
smaller text / more lines or bigger text. His own WalkMover per target (shared door), angled to the camera;
deterministic look / blink schedule; mouth flap on new messages; hop + cheer on support. **Alerts**: board (or the monitor's strip) card + neon flash, confetti / sparks, Sprocket cheers, and
`lights.cue('donation')` if the light engine lists it in `cues`, else `cue('screenLand')`.

**Test**: Scene tab test buttons (`POST /api/chat/test`, local only; observer = preview only).
`output.html?sceneTest=my_room&chat=monitor,panel,buddy,goal&chatBus=1` (+ `&buddyModel=mirelle`, `&buddyMode=stay`), `vtpOut.chat.inject(events)`,
`vtpOut.chat.debug()` (placements, buddy mode / model / fallback / hold / hfMin / tablet canvas, cost). Connectors were only run against a local mock of the three platforms.


# In-room timer displays (the subathon countdown on a room mesh) — `shared/timerDisplay.ts`, `shared/timerSurface.ts`, `src/goals/timerDisplays.ts`, `src/goals/timerDraw.ts`

The goals engine's countdown (the subathon: `GoalsView.sub`; studio: Goals & subathon) can live IN the room: a mesh whose UVs the clock is drawn onto, next to
the docked card, the HUD `subathonTimer` and the winching GOALS board (`src/goals/goalsWorld.ts`). It reads the SAME goals view every page already gets
(`src/goals/goalsStore.ts`: the absolute end time + the server's clock offset), so the studio preview, every OBS page and every party guest's page show the same second; no page-local timer
runs. No new server route: it uses `/api/goals/view`.

**Declaring displays** (all optional, up to 8; every display shows the same clock):

| How | Notes |
|---|---|
| node `TIMER_DISPLAY` / `TIMER_DISPLAY_xx` | A mesh with UVs (or a group of meshes: the best flat part is used). glTF extras: `style` (`digits` · `neon` · `lcd`), `color` (`#rrggbb`), `show` (`remaining` · `uptime` · `both`), `label` (≤ 24 characters), `fit` (0.3 to 1), `glass` (0.5 to 1). The `_1` / `_2` primitives three.js splits a multi-material mesh into are not extra displays. |
| scene.json `timerDisplays: [{ "node": "<existing node name>", "style"?, "color"?, "show"?, "label"?, "material"?, "fit"?, "glass"? }]` | Points an existing room at an existing mesh without re-exporting. Wins over a node of the same name. `material` = the part of a multi-mesh node whose material name contains this. A name that matches nothing is logged and listed in `vtpOut.goals.debug().timer.missing`. |

**Which surface**: every mesh under the node is measured (`surfaceStats`): flat? one filled UV rectangle? un-sheared? The biggest flat, filled one wins (a material named like screen / display /
glass / lcd / emit / panel breaks ties; `material` forces it). A dome of faceted UV islands next to a flat halo quad (the usual glowing "throat" or "medallion" build) therefore draws on the quad.
A node with no flat part still gets the display on its best mesh, flagged (`timer.displays[i].ok = false` + `why`): the digits then follow the unwrap, so unwrap a flat `TIMER_DISPLAY` plane instead.
The picture is mapped onto the UV RECTANGLE the mesh really uses (a quad that uses 0..0.5 of an atlas works), laid upright and un-mirrored whatever the unwrap's rotation or flip (`orientation` / `uvMatrix`),
at the surface's real aspect ratio (the canvas is up to 1024 px on its long side); floor / ceiling panels read upright for someone looking toward -Z.

**How big the clock is** (`fit`, `glass`): the panel is a strip about 70 % of the width of a squarish surface and nearly the whole of a wide one. A halo quad is usually wider than the glowing thing it sits behind (the
throat room's quad is 11.2 m wide in front of an 8.7 m sac), so the default panel reads flush with that thing's rim and, from a close camera, hangs over it (a flat quad nearer the camera looks wider than the dome behind it).
`fit` (0.3 to 1, default 1) scales the panel, and with it the caption row, the digits and the small line, about the surface's centre: the throat room declares `{ "node": "THROAT_SAC_emit_throat_display", "fit": 0.8, "glass": 0.8 }`,
which puts the panel at 72 % of the sac and the digits at 67 % (the concept image has about 75 % and 69 %). `glass` (0.5 to 1, default 0.95) is the panel's opacity: lower lets the geodesic show through. Both are clamped,
numeric strings (a Blender custom property) are accepted, and a display without them is drawn exactly as before. To choose the numbers for a room, run `npx tsx tools/timer_display_room_check.ts --room <folder with scene.glb + scene.json>`
(no browser, a few seconds): it measures the panel and the digits in metres against the other meshes of the display's node and projects them through every camera of the room, and `--fit 0.7` tries another value. `vtpOut.goals.debug().timer.displays[i]`
reports `fit`, `glass`, `panelM`, `digitsM` (the widest clock, 47:59:12), `aroundM` (the node's other meshes: reach right / left / down / up of the centre, m) and `overhangM` (how far the panel reaches past them, <= 0 = inside).

**What is drawn**: a dark glass panel centred on the surface (a strip across a squarish surface, nearly the whole of a wide one; see `fit` above) with the big `H:MM:SS` digits (hours never roll into days),
a corner caption (`label`) + badges (`PAUSED`, `TIME!`, `TEST`, `HAPPY HOUR ×2`, `HYPE ×1.5`, `SLEEP`), and under the digits the other clock (`show: both` → `LIVE 5:03:12`, `uptime` → `7:25:13 LEFT`) or the
`+10:00 name` pop when time is added (eases in over 0.45 s, holds, eases out over 0.7 s; the newest pop wins). Under five minutes the digits turn a steady warm colour (never a pulse). Looks: `digits`
(clean glowing numerals), `neon` (tube outlines), `lcd` (seven segments with ghosted unlit ones). Test mode (the studio's goals sandbox) shows the sandbox with a `TEST` badge, like the card.

**Idle** (decided: the room's own material, untouched): with no subathon, with Goals & subathon → On stream → **In the room** off, on a goals-only card, or before the server's view arrives, the display is
hidden: nothing drawn, nothing uploaded, the mesh looks exactly as its artist made it. It fades in and out over about a second (never a one-frame jump of a big dark panel over a bright mesh).

**How it sits on the room**: an overlay mesh that shares the surface's geometry (a child of it, polygon-offset in front, normal alpha blending, never a ray target, no shadows, the surface's layers); the room's
own materials are never edited, so the light show, night lights and graphics tiers keep working on them. One 2D canvas texture per display, redrawn only when the picture changes (a new second, a new view,
a pop easing: about once a second, at most ~11 a second), no allocation per frame, disposed with the room (`TimerDisplays.detach`, called with the room). Free in rooms without a display (no work per frame).
OBS alpha is unaffected (it only draws on room geometry).

**Photosensitivity**: nothing pulses or flashes; a pop's brightness goes through the page flash governor (`shared/flashGovernor.ts`) like every other brightness change in the room.

**The hanging goals board never covers a live display** (`src/goals/boardShield.ts`, `goalsWorld.ts`): rooms hang the GOALS board (`GOAL_BOARD[_xx]`) wherever the performer's shot wants it, and a room that builds its clock into a set piece (a giant's throat sac, a wall clock) often hangs
it right in front of that piece. While a display is live (a subathon is running, "In the room" on, not a goals-only card) the board asks, ten times a second, whether in the CURRENT camera it hangs in front of a display's glass panel (the board's box, housing included, overlaps the
panel's box grown by 8 % each side, inside the frame, the board being the nearer of the two) and, if so, winches up; the docked card carries the goals and the clock meanwhile. It comes back only once the shot clears the panel by 16 % (a camera drifting along the edge does not make it
winch up and down). A hard camera CUT onto a covering shot has no board at all (it is not left to winch up in front of the clock for the second it takes). Every other shot is untouched: performer shots, side angles, shots that frame only one of the two keep the board and its job.
Hidden displays (no subathon, "In the room" off, goals-only card) never keep the board away, and a room without displays pays nothing. Room authors need do nothing: no scene.json key, no anchor to move. `vtpOut.goals.debug().world.yielding` says whether the board is up for a display
right now; on a test page `vtpOut.goals.world.shield = false` switches the rule off (an A/B control: the same shot with the board hung in front of the clock).

**Test**: `npx tsx tools/board_shield_unit.ts` (the board-versus-panel geometry through real cameras: head on, behind, beside, off screen, the clearance, a board in the viewer's face); `npx tsx tools/timer_display_unit.ts` (declarations, the state machine: remaining / uptime / paused / test / pops / idle, the pop's ease, the one-redraw-a-second signature, UV orientation for every flip / quarter turn,
surface picking, `fit` / `glass`, what is around the panel); `npx tsx tools/timer_display_runtime_unit.ts` (the page side on a fake room: overlay, redraw budget, fade, the painter's layout at every fit, the panel against an 8.7 m sac behind an 11.2 m quad);
`npx tsx tools/timer_display_room_check.ts --room <folder>` (a real room's panel and digits in metres and through its cameras: fails when the panel hangs over or sits flush with the thing it is set into);
`node tools/timer_display_e2e.mjs` (a private server + one muted headless Chrome: a room copy with `timerDisplays`, screenshots of CAM_CLOCK / CAM_WIDE, centring proof, the panel inside the sac in the shot, the numerals' ink measured against the digit row in the painted canvas for every style, pop, badges, styles, switches, disposal; for every `--cams` shot the board is up and the mint digits are on screen inside the panel, and with the board's yield switched off by hand the board hangs in front of the clock and the mint is gone: `<cam>_yield.png` / `<cam>_noshield.png`).
On a test page: `vtpOut.goals.debug().timer` (every display: node, surface, material, size, uv rect, orientation, canvas, redraws, the face), `vtpOut.goals.timerDisplays.setSpec(i, { style: 'lcd', show: 'both', fit: 0.8 })`, `vtpOut.goals.timerDisplays.picture(i)` (the painted canvas + its rows + the digits' colour, to measure where the numerals landed), `?goalsDemo=1` for a local fake subathon.

# Room alert reactions (support events → what the room does) — `shared/reactions.ts`, `src/scene/reactions.ts`

A room can react to support events in its own way, scaled by how much was given and with specials per platform / kind:
a Kick sub, a $5 Super Chat, a $25 Rumble Rant, 1,000 Twitch bits, a 10-sub gift bomb, a 40-viewer raid, a follow. The room declares it in
scene.json `reactions`; rooms without the block behave exactly as before (nothing is stamped, nothing runs).

**Flow** (the raid / space / kitchen pattern): the HOST studio's `SceneController.roomReactions` (host / solo only — never an
observer, never party-origin or snapshot chat) matches each new support event against the room's rules, then:
- **host-owned actions** are applied to the scene state right away: `look` (lighting state) and `camera`, plus `space` /
  `raid` events stamped with the supporter's name and amount. Look / camera are put back after `secs` — the stamp
  remembers what to restore (`rv`), so a studio reload mid-reaction still restores them; a look / camera the host changed
  by hand in the meantime wins; a newer reaction takes over the older one's restore point (a chain ends where it began).
  **Look and camera are the host's, not the room's**: a reaction never changes the look while BRB / Outro is up, and it
  changes the camera only in Talk mode (`reactionMayChange` in `shared/reactions.ts`; a skipped part is neither applied nor
  remembered, so nothing is "restored" later). The page-side actions below still play. A finished stamp is dropped 60 s
  after it ends (once its restore point is done), so an idle room goes back to the cheap early-out in `reactionTick`;
- **page-side actions** go into a stamp `SceneState.reactions: [{id, at, until, tier, platform, fkind, user, amount, clip,
  cue, groups, house, tint, smash, look, camera, rv, ev}]` (≤ 8, sanitised in `shared/scene.ts`; guests shift `at` / `until`
  by the party clock offset). Every OBS page and every party guest's OBS plays them at the same wall-clock time
  (`src/scene/reactions.ts`, attached in `output.ts` like the other layers):
  - `clip` — one-shot room clips named `ALERT_*` (see "Room animation clips": they are kept out of the forever-loop),
    posed at `now − at`, then back to the rest pose; a page that opens late lands mid-clip;
  - `cue: "alert"` — the light engine's alert cue: 4 pulses, 2 per second, photosensitivity-gated, on the ON AIR groups
    plus `reactions.cueGroups` (default: groups named `alert` / `alarm`);
  - `groups` / `house` / `tint` — a light override for `[at, until)`: those groups play their own setting in EVERY lighting
    state (on the built-in auto show clock when there is no music input), the house level / tint ease in over 0.4 s and
    out over 1 s;
  - `smash` — `SMASH_xx` props break into their pre-fractured pieces without the Tagilla event (`RaidScene.smash`), and
    stand again ~32 s later; late pages fast-forward the debris. Any room with `SMASH_xx` props can use it (the raid
    background combat does not have to be on).

**scene.json**
```json
"reactions": {
  "tiers": { "small": 1, "medium": 5, "large": 20, "huge": 100 },
  "cooldown": 4,
  "cueGroups": ["alert", "beacons"],
  "rules": [ { "on": "support", "tier": "large", "do": { "clip": "ALERT_BROADSIDE", "cue": "alert", "secs": 12 } } ]
}
```
| Key | Meaning |
|---|---|
| `tiers` | minimum USD value per tier (defaults 1 / 5 / 20 / 100). The value is `raidDonationValue` (`shared/raid.ts`) of the chat event (`usd`, else `approxUsd`): money in USD (Kicks, Twitch bits and Jewels at the payout rate — 100 bits = $1 —, TikTok coins ≈ $0.005, other currencies ≈ USD), subs / resubs / memberships / milestones = $5, gifts = $5 each (≤ 50), raids = $0 |
| `cooldown` | seconds before another reaction of the SAME or a LOWER tier may start (default 4); a bigger tier always goes through; a rule can set its own |
| `cueGroups` | light groups the `alert` cue pulses (plus every ON AIR group) |
| `rules[]` | tried in order, **the first match wins**; `"continue": true` adds that rule's actions and keeps looking (a later rule fills whatever it left out; clips / smashes add up) |
| rule `on` | `goal` (a goal or stretch goal was reached; `minAmount` = the level: 1 = the main goal, 2 = the first stretch goal …) · `timerAdd` (time was added to the subathon timer; `minAmount` = the seconds added) · `support` (any support event) · `money` (Kicks, Rants, wallet tips, Super Chats / Stickers, Jewels, Twitch bits, TikTok gifts, tips, store orders / wishlist gifts) · `sub` (subs, resubs, memberships, milestones) · `giftSub` (gift subs / memberships) · `raid` · `follow` (a follow line: a system line with `ev: "follow"`) · or one exact kind (`superchat`, `rant`, `kicks`, `bits`, `tiktokGift`, `membership`, `patron` … any `FinanceKind` of `shared/chat.ts`); a string or a list |
| rule filters | (`goal` / `timerAdd` rules only use `minAmount`: they have no platform, kind, tier or USD value, so a rule that asks for one never matches them) `platform` (`kick` / `youtube` / `rumble` / `twitch` / `tiktok`, or a support service that reaches chat as a finance line: `fourthwall`, `kofi` …), `fkind` (kinds, list), `tier` (exact), `minUsd` / `maxUsd` (USD range), `minAmount` (native: gift count, raid viewers, Kicks, bits, months) |
| `do.look` | lighting state for `secs` (`preshow` / `show` / `react` / `brb` / `outro` — the looks from the Lighting states editor); skipped while BRB / Outro is up |
| `do.camera` | camera for `secs` (`wide`, `group`, `talk`, `react` or a `CAM_*` preset); only in Talk mode (and not while BRB / Outro is up) |
| `do.secs` | how long look / camera / the light override last (1–120 s, default 8) |
| `do.groups` | light groups → `{program, intensity, speed, color}` or the short form `"program:intensity:speed:#rrggbb"` (`"pulse:1.8:1:#ff2018"`) |
| `do.house`, `do.tint` | house light level 0–1.2 and `#rrggbb` tint while it runs (a red alert: `0.35`, `#ff3020`) |
| `do.clip` | `ALERT_*` clip name(s) in the room's scene.glb (≤ 6) |
| `do.cue` | `"alert"` |
| `do.smash` | `SMASH_xx` prop name(s) (≤ 4) |
| `do.space`, `do.raid` | a space event (`barrage`, `threat`, `flyby`, `dogfight`, `laser`, `warp`, `strafe`, `hellbomb`; space rooms) or a raid event (`tagilla`, `skirmish`, `donation` …; raid rooms), with the supporter's name |

**Goals and the subathon timer** (`on: "goal"` / `on: "timerAdd"`). These two are not chat lines: the HOST studio's `SceneController` watches the server's
goals view (the bus `{type:'goals'}` the goals engine already pushes, `shared/goalsView.ts`; party copies and test-mode sandbox views are ignored) through
`GoalSignals` (`shared/reactions.ts`) and, for each **new** thing in a view, matches the same rules and stamps the same way:
- `goal`: the engine just **reached** a goal or stretch goal (a `goal` / `stretch` effect whose text says REACHED; never the silent catch-up of an edited target, and
  never "STRETCH GOAL UNLOCKED": revealing a hidden stretch goal is not reaching it). One signal per view even
  when two levels are crossed at once (the highest). `amount` = the level reached (1 = the main goal, 2 = first stretch, 3 = second …); the stamp's `amount` text is
  `Goal` / `Stretch n`. A goal **outranks every tier** in the cooldown.
- `timerAdd`: positive additions to the subathon timer (`GoalsView.sub.last`: supports, incentive `addTime`, manual adds; subtractions and undo are not adds). The
  additions in one view are summed into ONE signal; `amount` = seconds, the stamp's `user` is the biggest adder, `amount` text `+m:ss` / `+h:mm:ss`. An ended subathon adds nothing.
  **Threshold rules (`minAmount`) also see a rolling 60 s window**: separate small adds (each its own update) add up, and a rule with `minAmount: 600` fires when
  the adds of the last minute **cross** 600 s (once per crossing; it re-arms when the window has run down below it) or when one add reaches it alone (a single big
  add is still instant). A rule with no `minAmount` matches every add. Order big thresholds first, as with tiers; a `continue` rule below adds its clips.
- **Restart safety**: the server keeps a goal's effect for 30 s and the last few timer additions for good. The first goals view the host studio's feed sees (a studio
  reload, or the first view after entering a room with reactions) is only a **baseline**: what it already shows is recorded as seen and never fires (the same idea as the
  `snap` guard of the chat reactions). Only things that appear after it can fire, and only while up to 8 s old on the server's clock.
- Each of the two keeps its **own cooldown gate** (rule `cooldown` or the block's, default 4 s): a support reaction in progress never swallows a goal or a timer add,
  and they do not swallow each other. The stamp carries `ev: "goal" | "timerAdd"` and is otherwise the same stamp (clip, cue, groups, house, tint, look, camera, smash,
  `secs`; `platform` is `goals` / `subathon`), synced to every page and guest like the others. Old apps drop the unknown `on` value (the rule is ignored), so a room that
  uses them should set `minApp` accordingly. Subathon *milestone incentives* ("every 60 min added") are not goals; use `timerAdd` with `minAmount` for those.
```json
{ "on": "goal", "minAmount": 2, "do": { "clip": ["ALERT_GOAL_HAND"], "cue": "alert", "secs": 14, "groups": { "witch": "pulse:1.6:1:#7dff2a" } } },
{ "on": "goal", "do": { "clip": "ALERT_GOAL_BATS" } },
{ "on": "timerAdd", "minAmount": 600, "do": { "clip": "ALERT_TIME_BIG" } },
{ "on": "timerAdd", "do": { "clip": "ALERT_TIME_HANDS" } }
```
Remote / test: `POST /api/command {"command":"scene","args":{"reaction":{"on":"goal","amount":3}}}` or `{"on":"timerAdd","amount":900,"user":"Test"}` plays the matching rule
(the cooldowns apply); the test page (`&reactions=host`) takes `vtpOut.reactions.test({on:'goal', amount:2})` and `vtpOut.reactions.goalsView(<GoalsView>)` (the
same detector the studio uses). Tests: `npx tsx tools/reactions_unit.ts` (section 12).

These run next to the room's other engines: a space room's own support barrage (Scene tab → Space battle → support) or a
raid room's Tagilla still fire from their own toggles; switch those off if the room's reactions should be the only thing.

**Worked example — a starship bridge (the starship deck), all four platforms**. Every platform gets its own special on top
of the tier (the special rules use `"continue": true`, so the tier rule below adds the rest): Twitch bits / subs / raids,
Kick subs / gift bombs, YouTube Super Chats / members, Rumble Rants. Tiers: small = a fighter flyby, medium = a turret
barrage + a squadron launch, large = red alert + a full broadside, huge = everything. A raid gets the afterparty look and
the hero camera. (The room's own block: `assets/scenes/my_ship_room/scene.json` → `reactions`; `tools/reactions_unit.ts`
checks it against the sanitiser and the tier mapping.)
```json
"reactions": {
  "tiers": { "small": 1, "medium": 5, "large": 20, "huge": 100 },
  "cooldown": 4,
  "cueGroups": ["alert", "beacons"],
  "rules": [
    { "on": "bits", "platform": "twitch", "minAmount": 1000, "continue": true, "do": { "clip": "ALERT_BITS" } },
    { "on": ["sub", "giftSub"], "platform": "twitch", "continue": true, "do": { "clip": "ALERT_TWITCH_SUB" } },
    { "on": "raid", "platform": "twitch", "minAmount": 10, "do": { "look": "outro", "camera": "CAM_HERO_WIDE", "secs": 15, "cue": "alert", "clip": "ALERT_RAID" } },
    { "on": "giftSub", "platform": "kick", "minAmount": 5, "continue": true, "do": { "clip": "ALERT_GIFTBOMB" } },
    { "on": "sub", "platform": "kick", "continue": true, "do": { "clip": "ALERT_KICK_SUB" } },
    { "on": "superchat", "platform": "youtube", "continue": true, "do": { "clip": "ALERT_SUPERCHAT" } },
    { "on": "sub", "platform": "youtube", "do": { "clip": "ALERT_MEMBER", "cue": "alert", "camera": "CAM_OTS_PADS", "secs": 6 } },
    { "on": "rant", "platform": "rumble", "minUsd": 10, "continue": true, "do": { "clip": "ALERT_RANT" } },
    { "on": "raid", "minAmount": 10, "do": { "look": "outro", "camera": "CAM_HERO_WIDE", "secs": 15, "cue": "alert" } },
    { "on": "support", "tier": "huge", "do": { "look": "preshow", "camera": "CAM_BATTLE_WIDE", "secs": 20, "clip": "ALERT_HUGE", "cue": "alert",
      "groups": { "alert": "pulse:2:1:#ff2018", "beacons": "pulse:2:1:#ff2018" }, "house": 0.3, "tint": "#ff3020" } },
    { "on": "support", "tier": "large", "do": { "camera": "CAM_BATTLE_WIDE", "secs": 12, "clip": "ALERT_BROADSIDE", "cue": "alert",
      "groups": { "alert": "pulse:1.8:1:#ff2018", "beacons": "pulse:1.6:1:#ff2018" }, "house": 0.4, "tint": "#ff4030" } },
    { "on": "support", "tier": "medium", "do": { "clip": ["ALERT_BARRAGE", "ALERT_SQUADRON"], "cue": "alert", "secs": 8 } },
    { "on": "support", "tier": "small", "do": { "clip": "ALERT_FLYBY", "cue": "alert" } },
    { "on": "follow", "do": { "cue": "alert" } }
  ]
}
```
What that does (checked against `shared/reactions.ts`):

| Platform | Event | Value | Result |
|---|---|---|---|
| Twitch | 100 bits | $1 | small: `ALERT_FLYBY` + alert cue |
| Twitch | 1,000 bits | $10 | `ALERT_BITS` + medium (`ALERT_BARRAGE` + `ALERT_SQUADRON`) |
| Twitch | 5,000 bits | $50 | `ALERT_BITS` + large (battle camera 12 s, red alert, `ALERT_BROADSIDE`) |
| Twitch | a sub · 10 gift subs | $5 · $50 | `ALERT_TWITCH_SUB` + medium · + large |
| Twitch | raid, 40 viewers | $0 | OUTRO look + hero camera for 15 s, `ALERT_RAID`, alert cue |
| Kick | 100 Kicks · 500 Kicks | $1 · $5 | small · medium |
| Kick | a sub / resub | $5 | `ALERT_KICK_SUB` + medium |
| Kick | 10 gift subs | $50 | `ALERT_GIFTBOMB` + large |
| Kick | raid (host), 40 viewers | $0 | OUTRO look + hero camera for 15 s, alert cue |
| YouTube | $25 Super Chat | $25 | `ALERT_SUPERCHAT` + large |
| YouTube | $150 Super Chat | $150 | `ALERT_SUPERCHAT` + huge: PRESHOW look + battle camera for 20 s, deep red alert (house 0.3), `ALERT_HUGE`, then back to the look / camera from before |
| YouTube | new member | $5 | `ALERT_MEMBER`, alert cue, the pads camera for 6 s |
| Rumble | $25 Rant | $25 | `ALERT_RANT` + large |
| Rumble | $5 Rant | $5 | medium (the Rant special starts at $10) |
| any | raid of 3 · 50 Kicks ($0.50) | | nothing (below the rules) |
| any | a follow | | alert cue |

**Authoring `ALERT_*` clips** (Blender: one action per object, exported like any room clip): start and end at the rest pose
(the clip is stopped — nodes back to their authored transforms — once it has run its length); never key a node another
(looping) clip or the engine moves; several clips may play at once. A missing clip name is simply skipped.

**Content note — the shipped starship deck has no `ALERT_*` animations yet.** `assets/scenes/my_ship_room/scene.glb`
carries the parked `ALERT_*` nodes (fly-by, bridge props, `LIGHT_ALERT_0x`) and the `SMASH_GAGHONEY` / `SMASH_GAGCRATES`
props, but its 110 animations are the `BTL_*` / `LIFE_*` / `SEQ_*` / `R5_*` / `R7_*` ones, none named `ALERT_*`. So the
`clip` actions in its `reactions` block do nothing until those clips are authored (`blender/starship_alerts*.py` in the room
folder is the starting point); its looks, cameras, alert cue and light overrides work, and so do `smash` actions on the two
`SMASH_GAG*` props.

**Remote / Stream Deck**: `POST /api/command {"command":"scene","args":{"reaction":{"tier":"huge","user":"Test"}}}` (or `usd`,
`platform`, `fkind`, `amount`) plays the current room's matching reaction on the host (the cooldown applies).

**Test** (throw-away server only — **not silent**: on a live PC `/api/chat/test` plays the normal alert / read-aloud sounds
like any chat event, so never point it at the live studio): `POST /api/chat/test {"what":"superchat","amount":150,"user":"Viewer"}` (local only, marked
test; `what` = `superchat` / `rant` ($) · `kicks` · `bits` · `tiktok` (coins) · `gift` (count) · `sub` (months) · `member` · `raid` (viewers) · `follow`)
sends a sized test event through the server's chat hub. `output.html?sceneTest=<room>&reactions=host` plays the host's
part on the test page itself (same `shared/reactions.ts` code), so those test events fire the room's reactions there;
`vtpOut.reactions.debug()` (config, stamps, override, one-shot clips playing, the log of what fired), `vtpOut.reactions.test
({tier:'large'})`, `vtpOut.scene.lights.debug().alert`.


# Background combat ("raid") + raid events (Tagilla)

Stylised soldiers fight in the BACKGROUND of a room — PMCs (USEC-style / BEAR-style), scavs, raiders — shoot each
other (tracers, muzzle flashes, sparks, bullet holes, glass cracks), die, get looted and dragged off to an exit where
they are "garbage collected". Support events (and a Test button) summon the room's **donation event**: in Factory the
masked sledgehammer brute (Tagilla-style) bursts in, smashes a prop into pre-fractured pieces, taunts and walks off.
No sound. Original homage designs only (no game files, textures, logos or models). Rooms opt in with the anchors below;
everything is optional and costs nothing while off.

## Room contract (anchors in scene.glb — additive, all optional)

| Node | Meaning |
|---|---|
| `BG_NAV_xx` | Empty: a nav-graph node where NPCs walk. extras `links` = comma-separated neighbour node names (made symmetric); optional `cover: 1`. Heights come from the node (floors, catwalks, stairs all work). Other extras (`level`, `note`) are ignored. |
| `BG_COVER_xx` | Empty: a cover position. The node's **+Z (glTF) = Blender local −Y faces the threat** (the prop sits between it and the threat). extras `stance` = `stand` (peeks left / right round it) or `crouch` (rises over it; default). `threatDir` is informative. |
| `BG_LOOT_xx` | Empty: loot spot, +Z faces the thing looted. extras `kind` = `crate`, `jacket`, `weapon_box`, `safe`, `filing_cabinet` or `med`. |
| `BG_SPAWN_xx` / `BG_EXIT_xx` | Empties, off-screen: squads enter at spawns; bodies dragged to an exit (and survivors leaving) disappear there. Optional extras `nav` = the `BG_NAV_xx` to walk to first (use it when the nearest node is behind a wall). |
| `BG_ZONE_xx` | Where NPCs may be. Either a box **mesh** (hidden by the engine, like `COLLIDE_*`) or an **empty** whose scale = half extents (extras `size` = full extents also accepted). extras `visibility: "none"` or `keepOut: true` = a keep-out box (e.g. the floor right under a window sill). Nav / cover / loot points outside every zone (or inside a keep-out box) are dropped. No zones = everything allowed. |
| `BG_GLASS_xx` | Glass meshes that show bullet-hole cracks (the rounds go through). |
| `EVENT_TAGILLA_ENTER` / `EVENT_TAGILLA_EXIT` | Empties: where the brute comes in / leaves. Optional ENTER extras `path` = comma-separated waypoint node names (e.g. `EVENT_TAGILLA_PATH_01,…,EVENT_TAGILLA_ROAR`; else `EVENT_TAGILLA_PATH_xx` in order) and `door` = `DOOR`: he kicks the room's DOOR open at the waypoint whose note mentions a kick (or extras `kick: true`, else the one nearest the door). He leaves back along the same path. |
| `EVENT_TAGILLA_ROAR` | (optional) hero-pose point on the way in: he roars there facing the node's +Z. |
| `SMASH_xx` | A smashable prop: a parent node whose children are `SMASH_xx_intact` (shown) and pre-fractured `SMASH_xx_piece_*` (hidden until broken; any node with extras `hiddenUntilBroken: true` is hidden at load too, by the room parser). Where he stands to swing: `EVENT_TAGILLA_STRIKE_xx` (extras `target` = `SMASH_xx`, faces its +Z), else `SMASH_xx_stand` (empty), else SMASH extras `strikeFrom` [x,y,z] (glTF), else automatic (in front of the prop, entrance side). Props the room's main camera (`defaultCamera` / CAM_WIDE) sees are preferred. The prop stands again ~32 s later. |

scene.json (optional): `"raid": { "factions": ["usec","bear","scav"], "npcHeight": 1.62, "donationEvent": "tagilla" }` —
the room's default factions (the Scene tab can override), NPC height (default `avatarHeight × 1.08`), and which event a
support event triggers (default `tagilla` when the room has ENTER + a SMASH prop, else `skirmish`). Other keys are
ignored. A room with a `raid` key in scene.json also tells the studio "this room supports donation events".

Authoring tips: keep every BG_* point behind the performers (zones are the hard limit); link nav nodes so straight edges
don't pass through props; put covers ~0.9 m from the prop's centre; spawns on opposite sides make better fights.

## Runtime (src/scene/raid/*, shared/raid.ts)

| File | Role |
|---|---|
| `shared/raid.ts` | `SceneRaidState` (in `SceneState.raid`, host-owned + sanitised), pacing per intensity, donation value |
| `src/scene/raid/raidRoom.ts` | parses the anchors into plain numbers + a line-of-sight matrix (ray-cast once, ≤ 1 ms per frame) |
| `src/scene/raid/sim.ts` | **deterministic** planner: a whole skirmish (or Tagilla visit) as a 10 Hz timeline — positions, states, shots, deaths, loot, drags |
| `src/scene/raid/units.ts` | NPC assets + instances: `assets/raid/raid_units.glb` (13 units, 1 skeleton, 1 atlas), `raid_anims.json` (23 baked clips), cross-fades, aim / recoil layer |
| `src/scene/raid/fx.ts` | instanced tracers, flashes, puffs, sparks, decals (holes / glass cracks), blob shadows |
| `src/scene/raid/raidScene.ts` | schedule → plans → playback, smash debris, door kick, camera shake, light cue, face / screen protection, perf governor, events hook |
| `src/ui/raidPanel.ts` | Scene tab → **Raid** |

**Sync.** `raid.seed` + `raid.epoch` (host clock; re-stamped when on / intensity / frequency / factions change) define
everything: the time since the epoch is cut into slots (`RAID_PACING[intensity].slot / freq` s: chill 230, normal 165,
hot 130); slot k may hold one skirmish planned from `hash(seed, k)` at a seeded offset inside the slot. Timed events
(`raid.events`, at most 8: `{k, at, id, user?, amount?}`) queue per kind; a `skirmish` event suppresses the regular
skirmishes it overlaps. Every page (studio preview, OBS, party guests — guests convert the host clock like walk
events) plans the same episode from the same room data and samples it at wall-clock time, so a page opened mid-fight
shows mid-fight (weapons already dropped, bodies already looted, a smashed prop already in pieces). Planning runs
~1 ms per frame (resumable). The simulation never looks at the camera; only the rendering does (culling, fading).

**The fight.** Squads (sizes by intensity, at most 8 NPCs) enter from opposite spawns, run to covers facing the threat,
then cycle hide → expose (peek / rise over cover) → burst → hide; reload when dry; sometimes reposition or throw a
grenade (normal / hot); hits flinch; deaths fall away from the shooter (3 falls) and drop the weapon. A stalemate
slowly raises accuracy so someone always dies; a lone badly hurt survivor may run. Winners loot bodies (kneel +
rummage, the weapon disappears) and loot spots, drag a body by the vest backwards to the nearest exit (both vanish),
then leave; leftover bodies fade. Stray rounds crack `BG_GLASS_xx`.

**Never in front of the show.** Zones keep them in the background; on top of that, every 0.25 s each NPC's screen box
is tested against every performer's face (current camera) and, in React mode, the react / solo screen: an overlapping
background NPC fades out and holds (keeps simulating) until clear. The brute only fades when he would be in front of a
face (standing behind the host is by design).

**Tagilla.** Sprints in (kicks the DOOR open when the room says so), roars at `EVENT_TAGILLA_ROAR`, sprints to the
prop's strike point, overhead smash (impact at 0.74 s: intact → pieces with physics-lite debris, dust bursts, optional
camera shake — never in React mode, the OBS hole must not move — and `lights.cue('donation' | 'screenLand')`), taunts
towards the audience with the supporter's name + amount on a cardboard sign on his chest, walks out the way he came.
Several donations queue.

**Events hook.** `registerRaidEvent(kind, { available, plan, exclusive? })` (raidScene.ts) adds a room's own event
(`plan` may return a generator — it is run ~1 ms per frame); stamp `{k: kind}` into `raid.events`
(`app.scene.raidEvent(kind)`, or the bus / MCP command `scene {raid: {event: kind}}`). `onRaidMoment(fn)` fires on every
page for smash / death / grenade / kick moments (lights, props). Built-ins: `skirmish`, `tagilla`, `donation` (= the
room's donation event).

**Studio.** Scene tab → **Raid**: background skirmishes on / off, intensity (Chill / Normal / Hot raid), frequency
(0.25–3×), factions (room default or your own), Tagilla on donations + min amount ($; subs / memberships count as $5),
camera shake, 🔨 Test Tagilla, ⚔ Test skirmish (observer studios: preview only). The host's controller stamps a
`donation` event for every support event ≥ min while the current room supports it (`raid` in scene.json, or a
preview report). Bus command: `{type:'command', command:'scene', args:{raid:{on?, intensity?, freq?, event?}}}`.

**Performance** (private mirror, SwiftShader headless — CPU-only, so GPU figures are counts): `RaidScene.update` with 8
NPCs fighting at full quality ≈ 0.08–0.10 ms average, p95 0.2 ms; worst frame ≈ 2.3 ms (creating an NPC instance — at
most one per frame); planning ≤ 1 ms per frame (a whole Hot-raid skirmish ≈ 5–10 ms in total, spread). GPU: +17 draw
calls / +20k triangles with 8 NPCs and effects (one skinned mesh + one weapon per NPC, one instanced draw per effect
kind). Shaders are pre-compiled (`compileAsync`) when the raid first activates. Off-screen NPCs skip posing; far ones
(> 22 m) pose at half rate; under load (perf level 1–2: after 2.5 s of slow frames, back after 25 s of good ones)
everything poses at half rate with fewer sparks / tracers and no blob shadows; tier `low` starts at level 1. Off = zero
per-frame work (one cheap check). `vtpOut.raid.debug()` shows the live numbers.

**Assets.** `assets/raid/raid_units.glb` + `raid_atlas.png` + `raid_units.json` (≈ 2.1–3.2k triangles per unit,
weapons 190–480) and `raid_anims.json` (int16 quaternions, 254 KB), built by `assets/raid/blender/build_units.py` and
`build_anims.py` (`tools\blender_low.cmd -b --factory-startup --python …`; `-- --render DIR [--view side|front|q]
[--only clip,…]` renders animation strips). The animations are pose functions (FK spine, analytic two-bone IK for arms
and legs, hands driven by the weapon's grip points) baked at 30 fps: idle, walk, run, crouch_idle, crouch_walk, aim,
aim_crouch, peek_L / peek_R, reload, throw, hit, death_back / death_fwd / death_spin, loot, drag, dragged (the body),
t_idle, t_sprint, t_walk, t_smash, t_taunt.

**Test room.** `assets/scenes/raid_test/` (build_raid_test.py): an office overlooking a warehouse floor through four
BG_GLASS panes; 16 nav nodes, 14 covers, 6 loot spots, 2 spawns / exits, 2 zones, a filing-cabinet SMASH_01 with 27
pieces; CAM_WIDE / CAM_FLOOR / CAM_TAGILLA / CAM_TOP.

**Test pages** (never the live bus): `output.html?sceneTest=raid_test&cam=CAM_TOP&raid=hot&raidSeed=7` (raid on,
epoch = page load; `raid=chill|normal|hot|off`, `raidAt=<s>` starts that many seconds in). Console:
`vtpOut.raid.debug()`, `vtpOut.raid.scene.planFor('slot', k)` / `planFor('event', {k:'tagilla', at, id})`,
`vtpOut.raid.scene.manual = true; vtpOut.raid.scene.clock = <ms>; vtpOut.step(n, dt)`, `debugFollow`, `debugCam`,
`debugLineup({clip, t, at, units})`, `forceLevel`, `protect = false` (to compare the face protection).
Known limits: fights are planned by the page's JS engine — Chromium everywhere (studio, OBS / CEF) agrees; a guest on
another engine could see a slightly different fight. NPCs don't avoid each other beyond distinct covers; line of
sight is per station (nav / cover / loot point), not per exact position.

## Raid v2: iconic looks, the boss patrol, the preshow raid camera, Tagilla visibility

**Anchors (additive):**

| Node | Meaning |
|---|---|
| `PATROL_PATH_xx` | Empties: the boss squad's route, walked in number order (extras `links` accepted, informative). Put the first and last points off-screen: the squad fades in / out there over 1 s anyway. |
| `PATROL_PAUSE_xx` | Empties beside the route: the squad stops at the nearest route point and looks around, facing the node's +Z. extras `secs` (default 5). |
| `CAM_RAID_xx` | Cameras on the raid area for the preshow director (below). |

scene.json `raid` (additive): `"boss": "reshala"`, `"patrol": { "chance": 0.5, "ambush": 0.45 }` (share of skirmish
slots that are a patrol, share of patrols that PMCs ambush), `"tagillaSightline": true` (the room guarantees clear
sightlines itself, so the engine doesn't choose the smash prop by camera).

**Characters v2** (`assets/raid/blender/raid_atlas.py` + `build_units.py`): 18 units (2.7–4.6k triangles), hero proportions
(bigger head, broad shoulders, chunky limbs, big boots and gloves), a 1024 × 1408 atlas (clean anti-aliased multicam /
flora / digital / urban camo, MOLLE webbing, three-stripe tracksuits, knit, fur, readable faces, the painted welding
mask) and **ink outlines**. The outlines are an inverted hull skinned with the body, using hull normals baked into the
GLB as `_ONORMAL`. They cost one draw call per NPC, only within 28 m and at perf level 0 (not on tier `low`).
- USEC-style: FAST helmet with NVG / rails / headset.
- BEAR-style: Russian helmet with cover, balaclava, plum-coloured AK mags.
- Scavs: tracksuits with white sneakers, ushanka with the flaps up, the scav chest rig, hoodie, shades.
- Raiders: heavy visor helmet, shoulder armour.
- The brute (Tagilla-style): welding mask with a painted shark grin, dark tee + navy jumpsuit tied at the waist, knee
  pads, sledgehammer.
- New: the Reshala-style boss (brown knit sweater, shaved head, gold chain, gold TT-style pistol) and 4 guards (navy
  jacket with striped cuffs, blue camo, armour; steel helmet + round shades / balaclava + marksman rifle / cap +
  shotgun / respirator + machine gun).
- New props: `tt_gold`, `svd`, `saiga`, `pkm`.
- New clips (30 in all): a pistol set (`p_idle`, `p_walk`, `p_run`, `p_aim`, `p_crouch`, `p_aim_crouch` — any unit
  holding a pistol maps the rifle states onto them) and `scan` (the look-around at pauses).

**Boss patrol** (sim.ts `PatrolOpts`, raid event kinds `patrol` / `ambush`, Scene tab 👑 Test patrol / 💥 Test ambush):
the squad (guard, boss, 3 guards, 1.4 s apart) walks the route relaxed, stopping at the pauses. In an ambush, 2–3 PMCs
(the room's PMC factions) spawn from the BG_SPAWN nearest the squad (but at least 7 m from it) when the leader is 40 %
of the way along. The squad takes close covers or crouches where it stands. The PMCs lose (guards are tougher and
better shots). Guards loot the bodies and drag up to two of them along the rest of the route, while the others finish
the patrol. Deterministic like every other episode.

**Preshow raid camera** (Raid → Camera → "Preshow: show the raid", default on; "…and during BRB"): while the lighting
state is PRESHOW (or BRB) and something is fighting, the scene camera cuts between the normal shot and the raid.
- Segments of 5–10 s are laid out from the raid seed on the raid clock; every third one returns to the show.
- Each raid segment takes the CAM_RAID_xx that frames the action best: every NPC it can see (room ray test) counts by
  its apparent size, and fighting / running NPCs count double. The pick is spread over the good ones for variety.
- A room without CAM_RAID_xx gets an automatic telephoto from CAM_OVERLOOK / CAM_WIDE onto the action.
- The decision is made once per segment from the plans, so every page cuts at the same moment to the same shot.
- Leaving a raid shot is a cut. The camera never takes over in React mode.
- Hook: `SceneRuntime.cameraOverride` (entrance follow-cams still win).

**Tagilla visibility:**
- The chat monitor and support board winch up from 2.5 s before his visit until it ends, and during raid-camera shots
  (`ChatScene.hold`).
- A visit is never started while React mode's screen is down. The host holds donations / tests asked for during React
  and stamps them 3 s after returning to Talk, so the screen has rolled up. Pages also refuse to start one in React.
- Each event carries the host's camera (`cam`), and the smash prop is picked by what that camera (16:9, the same on
  every page) sees of the prop and of his strike point. Room geometry and the performers (capsules spot → face) block
  it. Fallback: the props CAM_WIDE sees.

**Perf v2** (hot raid, 8 NPCs with outlines, the SwiftShader harness): `RaidScene.update` 0.12 ms average, p95 0.4 ms,
worst 2.8 ms (creating an NPC instance, one per frame). GPU: +24 draw calls / +58k triangles with every outline on.


## Raid v3: formation patrols, lying-in-wait ambushes, the big-donation interrupt

This section extends the contract. Every addition is optional, and rooms built for v2 still work unchanged.

**Patrol route (`PATROL_PATH_xx` extras)**
- `formation` sets the shape on the segment that starts at the point:
  - `file`: one line. The boss is 2nd, with 1 guard ahead and the rest 1.1 m apart behind him.
  - `column`: two abreast.
  - `wedge`: the boss in the centre with the guards on a diamond around him.
- `width` is the free lateral room, which caps the column / wedge spread.
- The squad walks as one formation by arc length and eases between shapes. Members enter at the route start and fade
  out at its end.
- The guard ahead of the boss steps onto his pause slot before the boss arrives, so nobody walks through him in a
  doorway.
- Standing members never creep (no foot sliding). Turns on the spot are stepped rather than pivoted on planted feet.

**Pauses (`PATROL_PAUSE_xx` extras)**

| Extra | Meaning |
|---|---|
| `at` | The path point to pause at. Without it, the nearest point is used |
| `seconds` | How long the pause lasts |
| `lookAt` | A glTF xyz point the boss faces |
| `guardSlots` | Where the guards stand, as xyz triplets (nested or flat). They are assigned by least total walk, and each guard faces outward from the boss |
| `action` | What the boss does (see below) |

The boss's action per `action` value:

| `action` | Boss clip |
|---|---|
| `look_in` | Pistol idle. The guards wait |
| `warm_hands` | New clip `p_warm`: hands held out over the fire |
| `look_around` / `check_rear` | New clip `p_scan`: head and chest sweep |

**Route options (`scene.json raid.patrol`)**
- `walkSpeed`: in m/s.
- `reversible: true`: the squad walks the route backwards on about half of the patrols, chosen per seed.

**Covers and exits (`BG_COVER_xx` / `BG_EXIT_xx` extras)**
- `role: "pmc_ambush"`: attackers lie in wait here.
  - Their timing is planned back from the squad's own timeline: they sneak in from a PMC spawn (`faction` pmc / any)
    early enough to be crouched in cover before the squad reaches that stretch.
  - They hold fire until the squad is inside the kill zone (within 17 m with line of sight, or 8.5 m), or has
    passed it.
- `role: "guard"`: on the first shot, the squad takes the nearest free guard covers (within 12 m, with sight of an
  attacker), else a close cover, else crouches where it stands.
- `bodyDump: true` on a BG_EXIT_xx: after the fight, one or two guards search the attackers and drag them to this exit
  through the nav graph. Rooms without one drag them along the route. The boss and the rest watch for a moment, walk
  back into formation through the nav graph, then carry on along the route.
- Rooms without pmc_ambush covers keep the v2 ambush: attackers come from the spawn nearest the squad, about 40 % of
  the way down the route.

**Tagilla hints (`scene.json raid.tagilla`)**
- `liftProps: ["chatMonitor", "chatBoard"]`: only the listed chat props winch up while he is in. Without it, both do.
- `preferPropsByCamera: { CAM_x: ["SMASH_01", …] }`: restricts the sightline pick for that camera. `talk` / `wide` /
  `react` look up CAM_TALK / CAM_WIDE / CAM_REACT.

**Big-donation interrupt**
- **Settings** (Raid section, "Big donations interrupt the stream"):
  - `SceneRaidState.bigOn`, default on.
  - `bigMin`, default $100 USD. Other currencies are counted at their USD value, the same way as the minimum amount.
- **Stamp:** a support event at or above `bigMin` is stamped `{ k: 'donation', big: true }`, even during React mode.
  Normal donations are still held until Talk.
- **What happens, on every page, deterministically:**
  - While his visit plays (from its start until 0.6 s after he leaves), `SceneRuntime.interrupt` is true. React's big
    and solo screens winch up, and the OBS passthrough hole closes before the camera moves.
  - The camera cuts to CAM_TAGILLA, else the room's main camera, through the `cameraOverride` hook. That camera also
    picks the prop.
  - Red alarm glows pulse over the roar point during his entrance, and on the door kick and the hammer hit. The camera
    shake setting now applies during React too.
  - His sign shows the supporter's name and amount.
  - Afterwards the camera cuts back and the screen comes back down. The hole reopens once the camera settles, and the
    in-scene capture never stopped.
- **Rooms without Tagilla:** a big donation plays `scene.json raid.bigEvent`, else the room's non-Tagilla
  `donationEvent`, else a skirmish.
- **Space rooms:** they keep their own support mapping (`spaceSupportKind`).
- **Test:** the "Test big donation" button in the Raid section.

**Face protection** now tests the NPC silhouette (head to feet, shoulder width) against the face itself plus a small
margin, instead of a padded box around the head. A boss standing beside a performer's head stays visible; one directly
behind it still fades.

**Animation**
- Crossfades start from the last posed skeleton (a snapshot), so a state change in the middle of a blend never pops.
- Fade lengths:

| Transition | Fade |
|---|---|
| Locomotion / idle | 0.3 s |
| Aim | 0.2 s |
| Hit | 0.08 s |
| Death | 0.12 s |
| Dragged | 0.45 s |

- Walk cycles stay distance-driven (stride ÷ stance per cycle), so planted feet do not slide.
- The skeleton is unchanged, so LOD0 meshes on the same rig play every clip.

## Raid v4: bodies on the Quaternius base character, fitted gear, mocap legs

This section changes how the raid NPCs are built and animated. It does not change the room contract. The runtime API
is unchanged: the same unit ids, weapons, clip names, `Npc` and `RaidAssets`.

**Bodies** (`assets/raid/blender/ubc_body.py`, used by `build_units.py`)
- **Base mesh:** every unit starts from the Quaternius *Universal Base Characters* male (CC0). The raw pack is in
  `tools/vendor/quaternius/Universal_Base_Characters_Standard`; nothing is copied into the repo.
- **Rigging:**
  - The base body is re-skinned onto the raid skeleton. The 20 bone names and their order are unchanged.
  - The rest joints now come from the base body (`ubc_body.V3_BONES`). Only the raid builder process swaps
    `raid_lib.BONES`, so the Kingsmarch / Area18 town builders are untouched.
  - The fingers are posed into a grip before the transfer.
- **Decimation:** it runs per region, with the seams locked (`BODY_SPLIT`):
  - LOD1: head 0.3, hands 0.1, body 0.42
  - LOD0: 0.85 / 0.4 / 0.95
- **Dressing** (`ubc_body.dress`):
  - Clothing shells are grown off the body, with the anatomy smoothed away underneath.
  - Seams are clean plane cuts: collar, cuffs, waist, boot tops.
  - Cargo trousers get baggy thighs; bulk, belly and arm/leg thickness are set per unit.
  - Boots and trainers are modelled lofts. The base body is barefoot, so its feet are dropped.
- **Head:**
  - The pack's face texture (painted stubble, lips, brow tone) is flattened towards cel and placed in atlas cells `uface_1..3`.
  - The pack's eyeballs carry a painted cel eye (`eye_*` cells). The brows, buzzed or parted hair and beards come from the pack.
  - Hair goes on after the headgear (`finish_head`): none under a helmet, hood or full hat, the buzzed cut under a cap.
  - Balaclavas cut a clean eye opening along planes, and the knit is smoothed over the lips and nose.
- **Atlas:** 1024 × 1664 (13 rows). The LOD0 atlas is 2048 × 3328.

**Gear** is grown off the dressed body (`ubc_body.shell`): the body surface is relaxed, pushed out, and given a solid
rim with its boundary straightened. This covers:
- helmets (FAST, Ratnik-style, heavy with a curved visor, kiver)
- beanies, caps, boonies, ushankas, hoods
- the painted welding mask
- plate carriers (front and back plates, cummerbund, shoulder straps, collar, groin plate)
- the scav chest rig, belts, kneepads, tied sleeves, the gold chain

Hard parts are placed on those shells by ray casts and oriented to the surface: pouches, mags, radios, rails, NVGs,
counterweights, buckles and holsters. Gear designed for the v2 body goes through `MB.warp`, which maps torso
sections, the head box and limb joints from the old body to the new one.

**Weapons** are rebuilt from side-profile extrusions and faceted tubes: AK (wood and polymer, curved magazine), M4
(collapsible stock, holo sight, rails, vertical grip), SVD (skeleton stock, scope), PKM (ammo box, bipod), Saiga (box
magazine, folding stock), pump shotgun, SKS and the TT. The muzzle points were re-measured.

**Animation**
- **Authored clips:** they are re-baked on the v3 skeleton, and all rifle poses were re-tuned:
  - In the aim poses the butt sits in the shoulder pocket and the stance is bladed.
  - When a hand is out of reach, the solver protracts the clavicle automatically.
- **New clips:**
  - `idle_gear`: the support hand adjusts the headset or helmet.
  - `p_scan` and `p_warm`: Reshala looking around, and warming his hands.
- **Lower-body layer** (`Npc.play(clip, t, fade, lower)`): the hips, spine and legs come from a motion-captured
  library clip, while the authored upper body holds the weapon. Both arms and the gun hang off the chest, so the hands
  stay on the rifle. The layer is chosen in `raidScene.lowerClipFor`:

| State | Legs |
|---|---|
| Walk | UAL walk (PMCs, guards); 100STYLE neutral walk (scavs) |
| Run | UAL jog |
| Crouch-walk | UAL crouch |
| Idles | 100STYLE neutral / heavyset idle |
| Hit | UAL hit_chest |
| Reshala | 100STYLE strutting walk, proud idle |
| Tagilla | 100STYLE heavyset walk, UAL sprint |

- **Phase:** it is distance-driven with the library's `cycle` strides, so there is no foot sliding.
- **Idle variety:** on the shared clock, rifle idles sometimes switch to looking around or adjusting gear.
- **Cross-fades:** they start from the last pose shown. Durations are 0.3 s for locomotion and idle, 0.2 s for aim,
  0.08 s for hits and 0.12 s for deaths.
- **High / Ultra:** `src/stage/gfx/npcDetail.ts` adds planted feet, turn-in-place steps and pop inertialisation on top.
- **The clip library for the raid skeleton** (`assets/library/anims/npc/raid_anims_ual.json`) is re-targeted onto the
  v3 rest pose (`tools/retarget`, raid target). The town file is unchanged.

**Review:** every unit is exported posed (idle frame 0, with its weapon) and checked with `tools/review_character.py`
(17 views, failure detectors), plus in-app 8-angle lineups on the Medium (LOD1) and High (LOD0) tiers.

## Raid unit packs (extra factions on the same skeleton)

A **pack** adds units without touching the base set: `build_units.py -- --pack <id>` imports `pack_<id>.py`, which paints
its own atlas cells (`paint(A)`) and replaces UNITS / WEAPONS / LOADOUT (`register(G)`) before the build loop. Output goes to
`assets/raid/packs/<id>/` with the base file names (`raid_units.glb`, `raid_units_lod0.glb`, `raid_atlas_lod0.png`, …).
Set `RAID_ATLAS_EXTRA_ROWS=3` for the build (room for the pack's cells). The LOD0 builder takes the same `--pack` flag.
Runtime: `RAID_PACKS` in `src/scene/raid/units.ts` maps factions to packs; `RaidAssets.ensurePack(id)` loads one the first
time a room's factions need it (its NPCs appear once it is there), every pack unit uses its pack's atlas + weapons, and
`npcDetail.ts` loads the pack's LOD0 set on demand. Nothing is loaded in rooms that don't use a pack faction.

**The warzone pack** (`pack_warzone.py`): factions `frog` (heroes: skill 1.6) and `militia` (0.66): in a test of 30 hot skirmishes the frogs won 24, the militia 3.
- Frogs: `frog_rifle`, `frog_mg` (SAW-style LMG), `frog_cqb`, `frog_nvg` (NVG down: swapped in for riflemen after dark,
  render-only), `frog_sniper` (heavy rifle, boonie, scarf), `frog_officer`. The head is the built-in Riot Frog's sculpted
  head (three skin tones), re-skinned to the Head bone, with golden bulb eyes, a horizontal pupil and set lids; helmets,
  boonie and cap are shells grown off the frog cranium; everything below the neck is the v4 PMC kit (plate carriers,
  belts, kneepads, packs, gloves, boots).
- Militia: `militia_rifle`, `militia_wrap` (shemagh-style wrap with an eye slit), `militia_mg` (PKM + ammo belt),
  `militia_rpg` (RPG + rocket pack): black knee-length robes over black trousers, tan chest rigs / vests, black
  balaclavas and head wraps. Generic look: no flags, insignia, text or symbols.
- `BG_SPAWN_xx` extras `faction` = `frog` / `militia` keeps each side at its end of the street.
- The RPG doesn't fire tracers: `registerWeaponFx('rpg', …)` (raidScene.ts) lets the warzone layer draw a rocket.

# Warzone (the battle outside warzone_compound) — src/scene/warzone/*

Rooms opt in with scene.json `"warzone": { "on": true, "seed": 17, "level": 1, "anchors": { … }, "support": { … }, "rewards": { … } }`
plus `"raid": { "factions": ["frog", "militia"], "donationEvent": "wz_support", "bigEvent": "wz_airstrike" }`. The raid engine
plays the close firefights; this layer adds everything around them, as a pure function of the wall clock + the room data +
the host's stamped events (every page sees the same shell land in the same place).

**Anchors** (`WZ_*` empties in the GLB, or the same names in `warzone.anchors` as `[x,y,z]` / `{ p, yaw, size, … }`, glTF
space; all optional — missing ones are derived from the BG_* anchors and the spots): `WZ_ROAD_xx` (technical route),
`WZ_ARMOR_xx` (APC route), `WZ_IMPACT_xx` (boxes where shells land), `WZ_RPG_xx` (+Z = firing direction, extras `target`),
`WZ_SNIPER` (the rooftop frog sniper), `WZ_FIRE_xx` (burning wrecks: `size`, `smoke`), `WZ_SKY_xx` (skyline strike points),
`WZ_FAR_xx` (far firefight boxes), `WZ_DUST_xx` (ceiling cracks inside: dust after close hits), `WZ_FLY_xx` (air lane),
`WZ_KEEPOUT_xx`. Route points snap onto the street surface.

**Pacing** (`warzonePlan.ts`): ~3½-min cycles of LULL (far tracers, a drone, the odd shell) → BUILD (mortars creep in,
RPGs, a technical drives through and usually gets knocked out, the sniper starts) → PEAK (a walking barrage, a heavy
strike on the skyline, a gunship or jet pass) → AFTERMATH (burning, drifting smoke). Night adds illumination flares
(they light the street through the env light pools) and AA fire. Always on: fires at `WZ_FIRE_xx`, smoking skyline blocks.

**Set pieces** (raid event kinds; Stream Deck "Warzone set piece", MCP `scene {raid: {event}}`, the Raid panel):
`wz_airstrike` (two jets, a stick of four bombs walking down the street, mushroom plumes that drift for minutes),
`wz_armor` (the frog APC drives the armour route, its cannon hits the militia side), `wz_assault` (a real hot skirmish on
the raid engine + militia mortars/RPGs, then the frogs' answer), `wz_technical`, `wz_mortar`, `wz_heli` (gunship with rocket
runs), `wz_flare`, `wz_sniper`. Donations: `donationEvent: "wz_support"` picks by USD (`warzone.support`, default
mortar $0 / technical $3 / gunship $5 / armour $20 / assault $50; big donations = air strike). Channel-point rewards: a
reward whose title contains a keyword (air strike, tank / armour / push, mortar / artillery, heli / gunship, flare, sniper,
technical / truck, assault / attack; or `warzone.rewards` keywords) plays that set piece. Supporter set pieces show a
banner (top-left, hidden in React) and cut to the best `CAM_BREACH_xx` / `CAM_RAID_xx` for a few seconds (not in React
or calm).

**Calm** (`SceneRaidState.calm`, Stream Deck "Calm the battle", Raid panel): no new loud events start and nothing shakes /
drifts inside; far fire, fires and flares continue; supporters' set pieces still play (without shake).

**Never in front of the show**: nothing is placed in the building box or within 12 m of a spot, every effect dims over the
performers' faces and disappears inside the React screen rect (it may be an OBS hole); shake never in React.

**Cost**: five instanced pools (lit smoke, glow, streaks, scorch, debris) = 5 draw calls + the vehicles on screen; a
governor halves puffs / drops debris after 2 s over 2.4 ms. Tests: `output.html?sceneTest=<room>&warzone=airstrike@3,armor@5
&env=h22`, console `vtpOut.warzone.scene.test('airstrike' | …, inSec)`, `.testAt('mortar', [x,y,z])`, `.forceNight`,
`.manual = true; .clock = ms`, `vtpOut.warzone.debug()`. Vehicles: `assets/raid/blender/build_warzone_vehicles.py`.

# Space battle (viewport spectacle) + cryo join / drop-pod leave

A space battle outside a ship's viewport — fighters on procedural splines, warp jumps, orbital barrages and lasers,
combat on the planet, the occasional enemy dreadnought that warps in, charges its gun at *your* ship and is torn apart —
plus the Helldivers-style entrance / exit cinematics: people who join thaw out of a cryo pod and walk to the bridge;
people who leave board a drop pod that is fired at the planet (seen from the bridge as a re-entry streak). Original
homage designs only (no game files). Like the raid system it is **deterministic, host-seeded and clock-synced**:
studio preview, every OBS page and party guests draw the same sky.

| File | Role |
|---|---|
| `shared/space.ts` | `SceneSpaceState` (in `SceneState.space`, host-owned + sanitised), `RoomSpaceConfig` (scene.json `space`), pacing, support rules |
| `src/scene/space/spaceRoom.ts` | parses SPACE_* / CRYO_* / DROP_POD_* anchors (+ scene.json overrides), nominal scale + viewport compression, what the room draws itself |
| `src/scene/space/director.ts` | the acts, **closed-form in wall-clock time** (no simulation state): patrols, Pelican shuttles, flyby, dogfight, strafe, warp, barrage, laser, hellbomb, threat, drop-pod re-entry |
| `src/scene/space/backdrop.ts` | sky + stars + sun, the planet shader (continents, clouds, war zones: artillery flashes, fires, tracers, smoke, dropship lights; 48 timed impacts: shell flashes, shockwave rings, laser scars, pod landings), atmosphere, moon; on a room's own planet mesh only an additive combat overlay |
| `src/scene/space/ships.ts` | `assets/space/space_ships.glb` → instanced hulls + glow parts (cel-lit by the sun, warp stretch, heat embers, dithered fades), debris chunks |
| `src/scene/space/fx.ts` | pooled instanced additive sprites (glow / flare / fireball / ring / spark / core), smoke puffs, streaks (min pixel width) |
| `src/scene/space/spaceScene.ts` | orchestrator: attach, perf governor, face dimming, bridge red alert / flash / shake, light cues, support labels, `enemy_ship` raid hook |
| `src/scene/space/spaceMover.ts` | `SpaceMover` (AvatarMover) for rooms that declare the cinematics; wraps WalkMover for everything else; `CryoPose` layer |
| `src/ui/spacePanel.ts` | Scene tab → **Space battle** (shown for rooms with scene.json `space`) |
| `assets/space/blender/build_ships.py` | the ship builder (`tools\blender_low.cmd -b --factory-startup --python assets/space/blender/build_ships.py [-- --render DIR]`) |
| `assets/scenes/space_test/` | grey-box test bridge with the same anchors (`build_space_test.py`) |

Ships (all low-poly convex-hull builds, per-face vertex colours + separate `_glow` meshes, ≈4k triangles in total):
Super-Destroyer-style capital ship (brutalist wedge, stepped tower, ventral orbital gun, hazard chevrons, 4 engines),
frigate, Eagle-style strike fighter, Pelican-style dropship, Automaton-style dreadnought in 5 break-apart pieces (claw
prow + charge emitter, red slits, spire), Automaton drone fighter, Illuminate-style saucer. `space_ships.json` holds the
gun muzzles, engines, lights, hull explosion points and piece centres.

## Room contract (all optional; glTF space)

| Node | Meaning |
|---|---|
| `SPACE_VIEW` | the viewport: origin = glass centre, extras `normal` (outward), `width`, `height` (else +Z / the mesh size). Default: behind the spots |
| `SPACE_PLANET` | extras `radius` (+ `fxRadius`: where the combat overlay goes on a room's own planet mesh) |
| `SPACE_MOON`, `SPACE_SUN` | extras `radius` / `dir` (direction to the sun), `color` |
| `SPACE_SHIP_xx` | parked capital ships: +Z / extras `forward` = nose, `length` (m), `kind` (`destroyer` / `frigate`) |
| `SPACE_LANE_xx` | flight corridor nodes, extras `links` |
| `SPACE_WARP_xx` | warp-in points, extras `dir` (a note containing "warp out" keeps it for departures) |
| `SPACE_ENEMY_APPROACH_xx` | threat spawn, extras `dir`, `killPoint` (where it dies) |
| `SPACE_CANNON_xx` | our own ship's muzzles: barrages (always for support events) and lasers fire from here (existing nodes under other names: scene.json `space.cannonNodes`) |
| `SPACE_BATTLE_xx` | surface combat sites (extras `normal`): war zones + barrage / laser / pod targets |
| `SPACE_ZONE`, `SPACE_KEEPOUT_xx` | effect volume; boxes effects stay out of (our bow / superstructure) |
| `PLANET` (or the mesh scene.json `space.planetNode` names), `SPACE_SKY`, `MOON`, `SPACE_FLEET` (meshes) | the room draws them itself → no duplicate planet / sky / moon / parked hulls from the space layer (additive-tagged shells get `AdditiveBlending`) |
| `CRYO_POD_xx` (+ `_door` hinge with `openAngle` or extras `open: slide_up`, `_out` step-out point), `JOIN_PATH_xx`, `CAM_CRYO` | cryo join |
| `DROP_POD_xx` (movable; + `_hatch` hinge / `open`, `_board`), `LAUNCH_TUBE_xx` (extras `start`, `end`, `exitDir`, `target`), `LEAVE_PATH_xx`, `CAM_DROPBAY`, `CAM_VIEWPORT` | drop-pod leave |

scene.json: `"space": { planet: {center, radius, palette: helldive|desert|ice|toxic|lava|ocean, fxRadius}, moon, sun: {dir|position, color}, view: {center, normal, width, height}, sky: false, intensity, viewCamera }`
(object values override nodes; strings are ignored), `"entrance": "cryo"`, `"exit": "droppod"` (else inferred from the
CRYO_POD / DROP_POD anchors), or per role: `"entrance": {"host": "lift", "guests": "cryo"}` (see "Per-role entrances and
exits"; the cryo / drop-pod cinematics then play for the roles that use them). A `space` key tells the studio the room supports the Space section + support events.

**Scale.** The director is written in *nominal* units (planet radius ≈ 1800, destroyer 180 m). A room authored at
another scale (the Helldivers bridge: 40 m ships, planet 150 m) is mapped by a homothety about the glass (U = mean
ship length / 180, else radius / 1800). A far planet without its own mesh is additionally pulled in (depth precision);
angular sizes from the glass are unchanged. Small craft are drawn 1.35–1.5× true scale so they read from the bridge.

**A room's own acts** (scene.json, all optional; a room without these keys behaves exactly as before). Any SPACE_* anchor
or a `space` key turns the whole layer on, and its craft are Helldivers homages; a room from another universe (a Star
Citizen ship, say) can keep only what fits its setting and use its own meshes:

```json
"space": {
  "acts": ["pod", "barrage", "laser"],
  "planetNode": "BACKDROP_PLANET",
  "cannonNodes": ["MUZZLE_S8_BOW_L", "MUZZLE_S8_BOW_R"],
  "fireFrom": "cannons",
  "podSize": 5,
  "view": { "center": [0, 0.95, -4.0], "normal": [0, 0, -1], "width": 12, "height": 5.5 },
  "sky": false
}
```

| Key | Meaning |
|---|---|
| `acts` | the ONLY acts this room keeps: `patrol` (Eagle patrol loops), `pelican` (dropship shuttles), `flyby`, `dogfight`, `strafe`, `warp` (friendly capital ships jump in / out), `barrage`, `laser`, `hellbomb`, `threat` (the dreadnought event, also `enemy_ship` raid stamps), `pod` (the drop-pod re-entry streak), `fleet` (parked capital ships at `SPACE_SHIP_xx`: also the barrage / Pelican / strafe origin and the threat's defender), `planet` (the war-zone combat drawn on the planet: artillery flashes, fires, dropship lights). Group: `fighters` = patrol, pelican, flyby, dogfight, strafe. Case-insensitive, plurals work, unknown names are ignored; `[]` keeps nothing; missing = every act. Everything else is never planned in this room — ambient slots, timed / test events, support events and raid stamps alike — whatever the host's toggles say (the toggles still switch the kept acts). A support event at or above `threatMin` in a room without `threat` calls in a barrage instead (if kept). The Scene tab only shows the kept toggles and test buttons. Filtering happens on every page from the room's scene.json, so the host, OBS and party guests agree. |
| `planetNode` | the room's own planet mesh when it isn't named `PLANET` (e.g. `BACKDROP_PLANET`): the space layer draws no second planet and doesn't compress the view; the centre / radius come from the mesh's bounds (a sphere) unless `SPACE_PLANET` / `planet.center` / `planet.radius` give them; the room is a space room even without any SPACE_* node; the combat overlay only shows while there is something to show (impacts, or the kept `planet` act); the mesh never turns red on a red alert. |
| `cannonNodes` | existing room nodes that are our own ship's muzzles (e.g. baked turret `MUZZLE_*` nodes), used like `SPACE_CANNON_xx` (positions read once when the room loads). Missing names are skipped. |
| `fireFrom` | `"cannons"`: orbital barrages and lasers only ever fire from our cannons (never from a parked destroyer, an empty point in space or an orbital platform). Without any cannon it has no effect. Default `"any"`. |
| `podSize` | size × of the drop-pod re-entry streak (thruster, fire, trail, smoke; the impact up to 2.5×), 0.25 … 8, default 1. For an own planet kilometres away at true scale, where the default streak is a few pixels (the starship: 5). |

## Runtime

**Sync.** `space.seed` + `space.epoch` (host clock; re-stamped on on / intensity / freq / show changes, stamped when a
space room is picked). Ambient acts: one per slot (`SPACE_PACING[intensity].slot / freq` s: chill 26, normal 14, hot
7.5), kind picked from the enabled ones by `hash(seed, slot)`; threats every `threat / freq` s (chill 720, normal 420,
hot 220) with 80 % chance; hellbombs ≈ every 45 s; patrols (1/2/3) and Pelican shuttles continuous. Timed events
`space.events` (≤ 10: `{k, at, id, user?, amount?}`, kinds `threat barrage laser warp flyby dogfight strafe hellbomb`;
threats queue). Every act is a pure function of (seed, slot/event, room) sampled at `now − start` → a page opened
mid-act shows mid-act; light cues / shakes only fire for moments crossed live (never replayed). Guests convert
epoch / event times with the party clock offset (controller).

**Threat event (≈ 46 s).** Red warp-in (tunnel lines, flash, stretched slam) at an approach point the main camera sees;
RED ALERT from 1.2 s (the bridge's stage lights, house materials and `EMIT_alert` / `EMIT_alarm` pulse red at 0.75 Hz —
applied only while the frame renders, restored after, so the light engine never sees it); red bolts at a friendly
destroyer (blue shield flares); the main gun charges at the bridge (growing red core, converging energy streaks,
unstable flicker); an Eagle wing scrambles (tracers, smoky missiles, hull hits); a destroyer broadside (blue rail
shells); secondary explosions bow → stern; at 18.5 s the hull breaks into its 5 pieces tumbling apart on fire with smoke
trails, core flash + shockwave rings + 110 debris chunks, one warm flash on the bridge, camera shake (optional, never
in React mode); pieces fade over ~26 s. Close approaches shrink the dreadnought to ≤ ~half the view.
**Barrage**: from our own cannons when the room has them (else a destroyer) — 380 mm / 120 mm / walking / railcannon
patterns, shells arcing down, a red stratagem beacon on the target, surface flashes + rings + embers, a label with the
supporter's name. **Laser**: a sustained beam (from our bow cannon or an orbital platform) sweeping a burning scar.
**Warp**: a frigate / destroyer jumps in, cruises, charges and jumps out. **Flyby** through the upper window (optional
barrel roll), **dogfight** (Eagles vs drones, tracers, kills + debris), **strafe** (Eagles dive and carpet a target),
**hellbomb** (huge surface blast in a war zone).

**Never in front of the show.** Everything outside is beyond the glass (points are pushed out of the viewport plane and
the keep-out boxes); ships and effects dim (dithered / faded) right behind each performer's face (screen boxes updated
5× a second); the react screen writes depth, so nothing draws over it.

**Cryo join** (`SpaceMover`, room declares `entrance: cryo`, Scene tab "Cryo-pod join" on): frozen in a pod (the host
in the pod CAM_CRYO sees best, guests by seat) behind a frosted pane with icy light + frost sparkles → thaw (lights warm,
frost melts, steam burst, the door swings / slides open at 3.3 s) → stumble out hugging themselves and shivering →
a big stretch (legless rigs hop) → brisk walk JOIN_PATH → the room's lanes → their spot (the bridge DOOR opens as they
pass). **Drop-pod leave** (`exit: droppod`): stand up → walk LEAVE_PATH to a pod (hatch opens) → step in, turn round →
hatch closes → countdown lamps 3-2-1 → the pod drops down its LAUNCH_TUBE with a flash + smoke (reloads after 9 s) →
the space scene flies it out past our hull and down to the planet as a coasting thruster, then a growing re-entry
fireball with a trail, ending in an impact flash + ring on the target site. Deterministic like WalkMover (jobs are pure
functions of room data, avatar size, spot and the host's move stamp). Moves between spots and rooms / toggles without the
cinematics use the regular WalkMover. **Camera** (`state.follow`): CAM_CRYO through the thaw, a chase camera in
corridors (or the nearest room camera with line of sight, held ≥ 1.5 s), CAM_WIDE's operator on the bridge; exits:
the walk, CAM_DROPBAY at the pod, CAM_VIEWPORT for the re-entry (never in React mode). Engine hooks used (additive):
`MoverFactory(room, info)`, `AvatarMover.followCamera?()`.

**Support events** (controller): support ≥ `min` ($5) → an orbital barrage with the supporter's name; ≥ `threatMin`
($20, 0 = never) → a threat event (only what the room keeps: scene.json `space.acts`). The room's raid donation event `enemy_ship` (Helldivers bridge) is registered as a
no-op raid event; explicit `enemy_ship` raid stamps (bus / MCP) play as threats. Bus / MCP:
`{type:'command', command:'scene', args:{space:{on?, intensity?, freq?, event?}}}`.

**Scene tab → Space battle**: on / off, intensity, frequency, fighters / warps / barrages / lasers / threats / planet
combat, red alert, camera shake, support rules, cryo / drop-pod toggles, Test threat / barrage / warp / laser / flyby /
dogfight / strafing run / hellbomb (observer: preview only).

**Performance** (private mirror, SwiftShader headless — CPU only, JS timings are an upper bound): `SpaceScene.update`
at Hot with a threat + barrage + laser running, 1080p: avg 0.20 ms, p50 0.20, p95 0.40, worst 1.5 ms; Normal ambient
0.13–0.19 ms. GPU: +18 draw calls, +39k triangles (the planet overlay sphere is most of it; ships ≈ 4k, all
instanced; 3 effect draws whatever happens). No lights added, no post; shaders pre-compiled on attach. Governor: slow
frames for 2.5 s → level 1 (fewer planet octaves, fewer trail segments / puffs), level 2; back after 25 s; tier `low`
starts at 1. A room without SPACE_* anchors: one check per frame; Space battle off: only static parts (the combat
overlay on a room's own planet is hidden).

**Test pages** (never the live bus): `output.html?sceneTest=helldivers_bridge&cam=CAM_VIEWPORT&space=hot&spaceSeed=7`
(`space=chill|normal|hot|off`, `spaceAt=<s>`). Console: `vtpOut.space.debug()`, `vtpOut.space.scene.manual = true;
.clock = <ms>; vtpOut.step(n, dt)`, `.forceState = {on:false}`, `.forceLevel`, `.debugCam = {pos, target, fov}`, and
`vtpOut.debugScene({...vtpOut.sceneState, space: {...events: [{k:'threat', at, id}]}})`; the mover: `vtpOut.scene.mover`
(`manual`, `now()`, `spaceLaunches()`).
Known limits: acts are planned by the page's JS engine (Chromium everywhere agrees); the cryo pod for a guest is by seat
index (two guests can share a pod if there are more seats than pods); the room's own frosted door texture stays frosted
after the thaw (our frost pane clears). (Rooms using the v2 pods below get one pod per member instead.)

## Cryo pods v2: frozen occupants, the cryo exit — `shared/arrivals.ts`, `src/scene/space/cryoKit.ts`

Opt-in per room (every other room — and every room on an engine without this — behaves exactly as before):

```json
"entrance": { "host": "lift", "guests": "cryo" },
"exit":     { "host": "cryo", "guests": "cryo" },
"cryo":     { "hold": "frozen", "breathe": 0.35, "tint": "#bfe6ff", "strength": 0.8, "forward": 0.2 }
```

* **`exit: "cryo"`** (for a role, or a string for everyone): stand up → walk back to their pod (the room's lanes, then
  JOIN_PATH backwards; the bridge DOOR opens as they pass) → the pod door opens as they arrive, the pod lights go amber →
  step in, turn to face out → the door closes → the view window frosts over (an animated frost shader), frost sparkles,
  the lights go icy blue with a bright pulse and a cold hiss of vapour from the door seams → sealed. Camera (`state.follow`):
  the walk, then CAM_CRYO while the pod closes.
* **`cryo.hold`** — what the pods show for members who are in the party but NOT in the room (they left by cryo, the host
  set them "not in the room", or a guest is waiting to join: the join lead): `"frozen"` (default when a role exits by cryo)
  = they stand FROZEN in their pod, seen through its small window: a still pose (the tracked torso / head held, a very slow
  breath `breathe` 0..1), a blue-white frost tint `tint` / `strength` with an ice rim (MToon parametric rim, toon outlines),
  the face held (eyes closed, mouth shut, the rest of the tracked face frozen); a cold backlight behind them; they float
  a little so their face sits in the window (hidden behind the closed door; they settle to the floor before it opens).
  `"sealed"` = the window frosts over completely, nobody visible. `"hidden"` = the old behaviour (empty pods).
  `forward` (m, 0..0.5): occupants stand that far in front of the CRYO_POD_xx anchor, close behind the window.
* **Thaw** from the hold: the regular cryo join (frost melts with drips, steam, the door opens, stumble, stretch, walk).
  **The host keeps their own entrance** (e.g. `"lift"`) unless they are frozen in a pod (their exit is cryo and they are
  away): then they thaw out of it (`SpaceMover.claimsEnter`, asked by the lift mover first).
* **One pod per member** (`allocatePods`): a pure function of the host's `SceneState.spots` (absent members keep theirs),
  so every page — studio preview, OBS, party guests' OBS, a page that loads later — puts everyone in the same pod, and a
  member keeps their pod while they come and go. Host → the pod CAM_CRYO sees best; a guest → rank[(1 + spot) % pods];
  a taken pod passes them to the next free one. More members than pods: the extra ones walk the door instead.
* Everything is host-stamped: the cinematics run from `SceneState.moves` (the host's stamp, sampled at wall-clock time on
  every page) and the hold from `SceneState.present` / `spots`. A presence change with no stamp (a page that just loaded)
  snaps them into their pod. Engine hooks (additive, optional): `AvatarMover.setScene?(state, actors)`.
* The Scene tab's "Cryo-pod join" toggle switches the v2 pods too (off = the regular door walk, no one in the pods).

**Room contract additions** (all optional; glTF):

| node / material | what |
|---|---|
| `CRYO_POD_xx_window` | a child of `CRYO_POD_xx_door`: the small view window (a mesh; its bounding box = the frost area; extras `shape: "rect"` for a slit, else an oval / round disc). The frost shader sits 6 mm in front of it and swings with the door. Without it: the old full-door frost pane. |
| materials whose name contains `cryoglow` | the pod's own lights (status lamp, interior strips): icy blue ↔ amber while it opens, brighter while occupied, a pulse as it seals (render-time only, per pod = the nearest CRYO_POD_xx). Keep them out of the `EMIT_` groups so the light show leaves them alone. |

Test pages: `vtpOut.cryo()` = pods per member, who is held, what each pod shows (frost, melt, door, warm, level, lit),
the jobs; `vtpOut.arrivalTest('exit' | 'enter', key)` plays the cryo exit / thaw the way the host stamps them.
Checks: `npx tsx tools/arrivals_unit.ts` (config, pods per member, the window anchor).


# Raceway (space race course + station defence + a living lounge) — src/scene/space/raceway/*

First user: `assets/scenes/sc_grimhex` (the Rust Rings race deck, Grim Hex style; full notes in its README). A room opts in
with a scene.json `raceway` key; every other room pays one check per frame. Attached in `output.ts` next to the other
room engines (`racewayScene.attach(rt)` / `update(step)` / `detach()`, support events from the page's chat feed).

**Sync**: every racer, crash, fight, flyby, NPC routine, PA line and board row is a pure function of the wall clock
(T0 = 2026-01-01), the room and the stamps (support events' chat-feed `ts`, the host's raid-event stamps) — the studio
preview, every OBS page and party guests' pages show the same thing with no messages. Episodes queue one after another.

**Room contract** (glTF space; all optional except `RACE_PATH_xx`; full list in `racewayRoom.ts`):
`RACE_PATH_01…` (the closed racing line, extras `gate`), `RACE_GATE_xx` (+Z = through, extras `radius`), `RACE_LIGHTS_xx`
(the gate's light pods; its `RW_gates` / `RW_start` material is cloned per gate and flares as racers pass),
`RACE_CRASH_xx` (+Z out of the rock), `RACE_CONTROL`, `BATTLE_ENTRY_xx` / `BATTLE_LAUNCH_xx` / `BATTLE_TURRET_xx`,
`BATTLE_ZONE` (extras `size`), `STATION_PAD_xx`, `SKY_SUN`, `RACE_BOARD` + `PA_TICKER` (UV 0..1 planes the engine draws
on), `BAR_DROID` (extras `path`), `NPC_<ROLE>` (bettor, drunk, barfly, mechanic, holo_bookie; extras `path`, `sit`),
`FX_SPARKS_xx` / `FX_STEAM_xx` / `FX_CONFETTI`. Materials `RW_*` are driven by the engine (never `EMIT_*`, so the light
show never fights it); `X_*` / `M_Giant` / `M_Moon` are drawn unlit (space has no ambient). **Never name a space sky
`M_Sky`**: the graphics layer paints drifting clouds on `M_Sky` materials at High.

**scene.json `raceway`**: `ships` / `meta` (the fleet GLB + its part metadata), `npc` (the regulars GLB), `seed`,
`racers`, `speed` (m/s), `pilots`, `battle {every, raiders, defenders, armadaRaiders, armadaDefenders}`, `crashEvery`
(s), `traffic`, `support {bounty: 20, armada: 100}` (USD thresholds), `unlit`, `stars`.

**Money → what happens** (support events + raid stamps): tip < bounty → victory lap past the glass + board banner
"GG <name>"; tip ≥ bounty → a bounty skirmish (raiders jump in, brawlers launch from the hangar, tracers / missiles /
shield flashes, wrecks drift); tip ≥ armada or a raid → the ARMADA (alarm + red alert, turrets, a gunship torn apart);
sub / membership → pirate salute flyby with flares; gift subs → the busted vending machine blows confetti and the bar
cheers. Raid-event keys `pirate_raid`, `armada`, `raceway_lap`, `raceway_salute`, `raceway_confetti` play here (the raid
engine has nothing to plan for them in a raceway room). Ambient: an endless race (overtakes, heats, a crash every
~95–200 s), a skirmish every few minutes, traffic, the regulars' routines, PA chatter.

**Cost**: ships are instanced (hull + glow, one draw each per design), effects reuse the space battle's pools
(`SpaceFx`), the board / ticker canvases redraw only when their text changes. A governor drops effect detail when the
engine averages > 1.6 ms a frame (Low tier starts one level down). Cameras: `CAM_BATTLE` follows the action in talk
mode only while a fight is on (never overrides a director's pick otherwise).

**Tests** (test pages only): `output.html?sceneTest=sc_grimhex&raceway=armada@3,lap@5,salute@8,skirmish@2,confetti@4,tip@1,sub@2,gift@3,raid@4`
(events in <s> seconds); `vtpOut.raceway.scene.test(kind, user, inSec, usd)`; frame strips: `vtpOut.raceway.scene.manual
= true; vtpOut.raceway.scene.clock = <epoch ms>` + `vtpOut.step(n)`; `vtpOut.raceway.debug()` (room anchors, active
episodes, ship / fx counts, perf level, NPC state).

# Town engine (living harbour rooms) — src/scene/town/*

Rooms whose scene.json has a `town` key (first user: `assets/scenes/poe2_kingsmarch`) get a living harbour, attached by
`output.ts` next to the raid (`townScene.attach/detach/update`; zero cost for other rooms). Everything is a pure function
of the town clock (wall-clock ms since UTC midnight) → the studio preview, OBS and party guests' OBS show the same
thing without messages. Modules: `waves.ts` (Gerstner swell, identical CPU + GLSL), `water.ts` (the `SEA` mesh's
animated material: reflection, sun glint, quay / pile / hull foam), `gulls.ts` (one InstancedMesh; circling + landing on
`PERCH_xx`), `particles.ts` (stateless Points: embers, chimney smoke, wave spray, festival sky lanterns, rain),
`townUnits.ts` + `crowd.ts` (the ambient crowd: rigged units + baked clips from `<room>/town/`, deterministic loops over
`TOWN_NAV_xx` / `TOWN_POI_xx` / `TOWN_HOME_<cast>`, LOD0/LOD1, fades behind performers' faces), `townScene.ts` (boats
`BOB_xx` riding the swell, the `SHIP_SAIL` along `SHIPLANE_xx`, `SWAY_xx` banners / flags / loads, the lighthouse beam,
additive `M_Add` fog + god-ray cards, weather from the lighting state via `town.weatherByState`). Contract, anchors and
cost: see `assets/scenes/poe2_kingsmarch/README.md`. Debug: `vtpOut.town.debug()`, `vtpOut.town.scene.forceWeather`,
`vtpOut.town.scene.manual / clock`.

## Room animation clips (any room) — `src/scene/roomClips.ts`

A room's `scene.glb` may carry glTF animations (Blender: one action per object / shape-key block, exported with
`export_animation_mode='ACTIONS'`). `SceneRuntime.load` hands them to `RoomClips`, which loops **every** clip forever and
poses it each frame at a deterministic time: `clock() mod clip.duration`. The clock is `SceneRuntime.clipClock` — by
default wall-clock seconds since UTC midnight (the same base as the town engine); a town room hands in the town clock, so
test pages' `vtpOut.town.scene.manual / clock` freeze and step the clips too. Studio preview, OBS and party guests
therefore show the same pose (within their clock skew) with no messages; nothing accumulates or drifts. A room with no
animations creates no mixer (zero cost). Authoring rules:
- Author seamless loops (the last key equals the first; a whole number of frames at 24 fps). Clips of different lengths
  are fine — each wraps on its own.
- **Never key an engine-driven node** (`BOB_xx`, `SHIP_SAIL`, `SWAY_xx`, `CRANE_*`, doors, spots, cameras). Key a child:
  the engine's motion (swell, ship lane, sway) and the clip compose. Path movement stays engine-side. An ordinary
  `CAM_*` preset is a snapshot at load, so keying it does nothing. For a moving shot, make it a **live** camera
  (`CAM_LIVE_*` / extras `live: true`, see "Cameras"), key it or its parent, and the shot follows the clip.
- Node transforms (translation / rotation / scale) and morph-target weights (Blender shape keys) are supported.
  `*_LOD0 / *_LOD1` siblings under an animated node follow it (gfx/lod.ts only toggles their visibility).
- **Hide FX with a zero scale** (Blender's 0.0001 floor on all three axes) between cues: while collapsed the node is
  switched invisible (no draw call, no sort, nothing in the glow pass) and back the frame it grows — keyed in a clip or
  authored collapsed for an engine to pop. Don't flatten a single axis to hide something (a flat mesh still draws).
  Nodes hidden at load (`hideNodes`, areas, screen skins) and subtrees with lights / points / lines / sprites are left
  alone. A/B: `vtpOut.scene.clips.setHideZeroScale(false)`.
- Debug: `vtpOut.scene.clips.count`, `vtpOut.scene.clips.zeroScale` (collapsed FX managed / hidden now).
- Clips that only animate nodes inside a hidden room prop toggle are skipped while it is hidden (see "Room prop toggles").
- **One-shots**: clips named `ALERT_*` are never looped. They rest at the rest pose until a room alert reaction plays them
  (scene.json `reactions`, see "Room alert reactions"): posed at `now − stamp.at`, then stopped (nodes back to their
  authored transforms) — so they must start and end at the rest pose. `vtpOut.scene.clips.oneShots` / `.playing`.

First user: the Kingsmarch fleet (`BOB_<id>` / `SHIP_SAIL` → `BOAT_<id>` with a `rock_<id>` idle pitch / roll / heave
clip → hull LODs, rig, `sails_<id>` billow + travelling ripple, `flag_<id>` flutter, `oar_<id>_L/R` swing); see the room
README.

Life + look (2026-09-25): `crowd.ts` also runs group activities on the absolute clock (`TOWN_POI_*` extras `kind: group | bench` — speakers gesture, listeners nod and turn their heads), life routines at `TOWN_HOME_smith / bard / fisher / cook / drunk / guard_post / kids`, occasional look-at to the performers, and support-event cheers (`townScene.onSupport`, fed by the page's chat feed in output.ts); `townUnits.ts` has LOD0/1/2, near-only ink, right-hand props. `water.ts` mirrors the nearest practical lights + draws the ship's wake, `fx.ts` adds `CloudDome` (cel clouds over a painted sky), `Sparks` (anvil blows), `gulls.ts` fishing dives; `CRANE_JIB_xx / _HOOK_xx / _ROPE_xx` nodes run a crane load cycle. Details: the room README.


# Graphics quality (Performance · Balanced · High · Ultra · Auto)

Shown to users as **Low · Medium · High · Ultra** (ids unchanged: `performance` = Low, `balanced` = Medium; `?gfx=low|medium`
also work). Benchmark, render scale, MSAA, "lower quality automatically", the AMD / Intel fallbacks and the measured
per-room costs: **docs/PERFORMANCE.md**.

`SceneState.gfx = { obs, preview, autoUltra, fx }` (`shared/graphics.ts`, sanitised in `shared/scene.ts`). Host / solo: saved
with the scene (cache/scene.json) so this PC's OBS pages follow; a party guest keeps its OWN choice (`localStorage
vtp.gfx.local` — the controller swaps it into what it relays to its OBS; the host's GPU isn't the guest's). `obs` = OBS
output pages, `preview` = the Scene-tab preview (keep it cheap, it shares the GPU with the face tracker). One OBS source
can pin its own level with `output.html?gfx=high` (performance / balanced / ultra / auto). Classic (no room) is never
touched. Scene tab → **Graphics quality** (under Look): both levels, "Auto may use Ultra", Ultra warning, a live line
(preview level, passes, MB, CPU ms, face inference), and **Advanced**: every effect Default / On / Off (honoured on High /
Ultra only — Performance and Balanced are fixed presets).

| Level | What it does |
|---|---|
| Performance | no post; pixel ratio ≤ 1; room `*_LOD0`-only detail (e.g. Kingsmarch `DETAIL_LOD0`) hidden; LOD bias ×0.6; raid NPCs beyond 13 m become impostor cards (re-rendered ~10–15 Hz into one 1024² atlas, one instanced draw); town crowd `lodBias −1` |
| Balanced (default) | exactly today (the page's own tier path, zero extra work — `Graphics.render()` returns false) |
| High | HDR MSAA ×4 target → glow layer, bloom (4–5 mips), per-room LUT grade + vignette, half-res SSAO (8 taps, never on performers), glowing haze, background DOF in talk shots; toon+ rim / stepped highlights on performers + NPCs (tinted NPC ramps); performer contact shadows; water / sky shaders; detailed NPCs within 11 m; LOD bias ×1.35 |
| High / Ultra extras (2026-09-25) | **SMAA** (pmndrs/postprocessing edge + weights, premultiplied blend) replaces the optional FXAA; **N8AO** replaces the built-in SSAO (High: half res, 8 samples; Ultra: full res, 16) — same performer protection / far fade; **HDRI room light** — the room's own PBR materials get a per-room Poly Haven HDRI as image-based light + reflections (performers keep the studio environment). All three are Advanced toggles (default on) |
| Ultra | High + ×1.5 supersampling (capped at 3840×2160 of pixels), 12-tap AO, light shafts, glossy-floor SSR, a real soft shadow map for performers, detailed NPCs within 20 m, LOD bias ×1.8. Never a default; the UI warns |
| Surface styles (2026-09-25) | performer materials with a surface style (felt, scales, clay, fur… — AI_CREATOR_GUIDE §5.5) follow the level via `setSurfaceQuality()`: Performance / Balanced / Classic = cheap path, no shell fur; High = +1 noise octave, glints, shell fur 6 / 10 layers; Ultra = +2 octaves, 12 / 20 layers. Uniforms + shell visibility only; `Graphics.compile()` pre-warms hidden shells (`withSurfaceShells`) |
| Auto | starts at Balanced; climbs one level after ~12 s (Ultra: ~20 s, only with "Auto may use Ultra") of clean frames with GPU < 38 % (25 %) of the frame budget AND healthy face tracking; steps down at once when the studio's face inference rises above max(1.3 × its baseline, baseline + 4 ms, 14 ms) or tracking < 24 Hz (that level is then barred for 5 min), or after two windows of GPU > 70 % / late frames |

Code: `src/stage/gfx/` — `Graphics.ts` (per page: levels, room binding, per-frame params, render hook), `auto.ts`,
`lod.ts` (+ `gfxLod`, `gfxBudget()`), `roomLooks.ts`, `lut.ts`, `toonPlus.ts`, `shadows.ts`, `surfaces.ts` (water / sky),
`npcDetail.ts` (raid NPC LOD0 / motion / impostors), `healthBeacon.ts` (studio → bus `{type:'health', h:{inferMs, trackFps,
tracking}}` 1 Hz); `src/stage/post/Pipeline.ts` (the passes); `src/ui/gfxPanel.ts`. Hooks added: `Stage.renderHook`,
`Stage.ratioOverride`, `Stage.keyLight / rimLight`; `vtpOut.gfx` (`.info()`, `.setChoice(l)`, `.auto.info()`, `.npc`).

**No mid-show compiles.** Programs compile only at a level / effect change or room load (`renderer.compile` right there;
every post pass is compiled when its pipeline is built). Auto pre-installs every patch + pipeline it may switch to when
the room loads (with the effects' uniforms at zero, a patched material renders exactly as before), so its steps only flip
uniforms / swap render targets.

## Room contract additions (all optional)
- HDRI: `scene.json "gfx": { "hdri": "<name>" }` or `{ "hdri": { "name", "intensity" (1 = studio-env brightness), "rotation" (deg about +Y) } }`
  or `false` (none); a top-level `"hdri"` key works too. Names: `small_harbour_sunset`, `belfast_sunset_puresky`,
  `empty_warehouse_01`, `hospital_room_2`, `rogland_clear_night`, `fireplace`, `abandoned_factory_canteen_01`
  (`assets/hdri/`, 1k copies of the Poly Haven 2k maps via `tools/hdri_prep.py`; each normalised to the same mean
  luminance). Built-in mapping (`src/stage/gfx/hdri.ts`): Kingsmarch → small_harbour_sunset, Factory / raid_test →
  empty_warehouse_01, Labs / Labs R&D → hospital_room_2, Customs dorms → abandoned_factory_canteen_01, Helldivers bridge /
  space_test → rogland_clear_night, Studio → fireplace, test_room → belfast_sunset_puresky. Loaded (once per page,
  cached) only when High / Ultra with the effect on; materials named like water / sky (`M_Sea`, `M_Sky`, `GFX_*`),
  performers and NPCs are never touched. Same PMREM size as the studio environment, so switching never recompiles.
- `*_LOD0`, `*_LOD1`, `*_LOD2` sibling nodes: one shown by projected size (LOD0 ≥ 150 px, LOD1 ≥ 55 px at bias 1; ±15 %
  hysteresis, checked 5×/s). A lone `*_LOD0` = optional detail: hidden on Performance / when tiny. Other systems:
  `gfxLod.add(root)` / `gfxLod.remove(root)`; read `gfxBudget()` for `npcDensity` (0.6 / 1 / 1.25 / 1.5), `npcDetailDist`,
  `impostorDist`, `lodBias`.
- Water: materials named `M_Sea` / `M_Water` / `M_Ocean` / `M_Lake` / `M_River` / `M_Pond` / `GFX_WATER*` (MeshStandard) →
  animated world-space waves, banded fresnel sky reflection, stepped glints, crest foam. Sky: `M_Sky` / `GFX_SKY*` →
  textured skies get a drifting two-band cloud layer, plain emissive (space) skies twinkling stars. `M_Clouds*` textures
  drift (planet cloud decks turn).
- Colour grade: a room may ship `lut.png` (1024×32 strip, 32 blue slices, sRGB) in its folder; else the built-in look.
- `scene.json "gfx"` overrides the built-in look (`src/stage/gfx/roomLooks.ts`): `grade {temp, tint, lift, gamma, gain,
  shadows, shadowAmt, highlights, highlightAmt, curve, sat, satShadows}`, `lutMix`, `bloom`, `threshold`, `glow` (additive
  FX → bloom gain), `groups { <EMIT group>: gain }` (per emissive group brightness while post is on), `haze {color, density,
  glow}`, `rim {color, strength}`, `vignette`, `ao`, `reflect {strength, y, maxDist}` (glossy floor SSR; y = floor height,
  default = the stand spots' median), `shafts`, `dof`.

## How the effects work (and stay safe for OBS)
- SMAA runs on the final LDR image: the final pass writes PREMULTIPLIED sRGB into its target, SMAA blends there and the
  blend pass writes straight colour + alpha to the canvas — no dark fringes over OBS content. In an opaque room the OBS
  hole's pixels are never touched (checked: identical alpha-0 pixel set with SMAA / N8AO on and off, react mode, Factory).
- N8AO (transparency detection off — no per-frame scene walk, no extra transparency renders; enforced every frame since
  2026-10-04: n8ao's own auto-detect had been switching it back on in every room with glass) only produces the AO term,
  ignoring transparent surfaces; the final pass applies it with
  the same performer spheres and 22–38 m fade as the built-in SSAO. Classic (no room) never runs any of this.
- Alpha stays exact (premultiplied through every pass). In a room with an opaque background the only transparent pixels
  are the react screen's OBS hole: bloom / haze / shafts are never added there.
- Glow layer: every mesh whose material blends additively (tracers, muzzle flashes, beams, lasers, engines, holograms) is
  also on layer 5; they are drawn again into a buffer depth-tested against the scene's depth (their shaders untouched) and
  fed to the bloom → the light show and gunfights bloom without raising the bloom on faces.
- AO skips spheres around every performer (faces never get dirty); fades beyond 22–38 m.
- DOF only when a performer's face is in frame and ≥ 5 % of the height (talk shots), never in React mode; samples are
  weighted by their own circle of confusion so the sharp performer never bleeds into the blur.
- Shafts: the 4 brightest LIGHT_* fixtures on screen, radial blur of the half-res bright pass at quarter res (occluders
  are dark in it, so shafts are occluded).
- SSR: one floor plane (both neighbours must be on it — chair legs / feet don't reflect), 22 steps, fresnel + edge fade.
- Toon+: stepped fresnel rim (away from the key light, tinted by the room + the stage rim light, so it follows the light
  show) and a stepped Blinn highlight (avatars: hair / hard surfaces by material name; NPC LOD0: the atlas alpha = spec
  mask); additions are capped below white so lit faces never bloom.
- Performer shadows: High = soft blob quads; Ultra = performers' depth (override material, layer 7) from a mostly-overhead
  light on the key side, 1024², PCSS-lite floor receivers (sharp at the feet, soft far from the floor).

## Raid NPC LOD0 (High / Ultra)
`assets/raid/raid_units_lod0.glb` + `raid_atlas_lod0.png` (+ `.json` tris), built by
`assets/raid/blender/build_units_lod0.py` (`tools\blender_low.cmd -b --factory-startup --python
assets/raid/blender/build_units_lod0.py`). It RE-RUNS the raid agent's `build_units.py` / `raid_lib.py` / `raid_atlas.py` in
memory with more detail (never edits them — rebuild LOD0 after they change): 2048×2816 atlas (faces: iris gradient, second
highlight, lower lash, lid crease, blush; crisper camo / webbing / knit; alpha = spec mask), ~1.5–1.75× segments, 2-segment
bevels, four real fingers + knuckles, a rounder nose, pouch lids, and DGL_* dangle bones: belt strap tails, radio
antennas, a rifle sling (long guns), Tagilla's tied sleeves. 9–14k triangles per unit (LOD1 2.7–4.7k), 16.7 MB.
Runtime (`npcDetail.ts`, needs `units.ts` to tag `root.userData.npc`): LOD0 bound to the NPC's own bones (today's mesh
hides; weapons swap to LOD0 geometry), coloured ink ~2.6 px, springs on the dangles, the sling pinned to the weapon's
stock, planted feet (two-bone leg IK with small steps) in static clips, 0.2 s inertialisation of pose pops. The raid
simulation / plans are untouched, so every page still shows the same fight.


# Environment: time of day, weather, night lights — src/scene/environment/*

Any room can have a game-style clock and weather: the sky, sun / moon, room light, fog, rain, wet ground, wind and
lightning change with the time and the weather, and lanterns / street lights / windows switch themselves on when it gets
dark (and in storms). A room opts in with an `environment` key in its scene.json; rooms without it cost one check per
frame. Test room: `assets/scenes/env_test/` (`build_env_test.py`).

| File | Role |
|---|---|
| `shared/environment.ts` | `SceneEnvState` (in `SceneState.env`, host-owned + sanitised), `RoomEnvConfig` (scene.json `environment`), the clock, the weather timeline / automatic cycle, lightning schedule, sun path, darkness — all pure functions |
| `src/scene/environment/index.ts` | `EnvScene` (output.ts: `attach` / `pre` before the scene update / `post` after it): performers' lights, room uniforms, sky, fog, rain, pools, hooks |
| `src/scene/environment/materials.ts` | the room material patch (lit / wet / sky / emit / window grid / sway), installed once per material at room load, uniforms only afterwards |
| `src/scene/environment/nightLights.ts` | night lights: discovery, staggered thresholds, ignition fade, flicker, lightning power dip, the show's real lights, light pools |
| `src/scene/environment/sky.ts`, `precip.ts`, `curves.ts` | procedural sky dome · rain streaks + splashes · time-of-day colour curves |
| `src/ui/envPanel.ts` | Scene tab → **Time & weather** |
| `src/stage/gfx/shaftSources.ts` | hooks for the graphics layer: extra god-ray sources (the sun) + a haze tint |

## How a room opts in (for room builders)

1. **scene.json** — the minimum is `"environment": {}` (procedural sky, temperate climate, sensible defaults). Typical:
```json
"environment": {
  "sky": "procedural",              // or "room" (only your own sky meshes, tinted) / "none"
  "climate": "jungle",              // temperate | jungle | city | coastal | arid (automatic weather odds)
  "north": 0,                       // deg: rotates the sun path (0 = sunrise at glTF +X, sunset at −X)
  "sunrise": 6.0, "sunset": 18.5, "noonElevation": 62,
  "default": { "clock": "cycle", "hour": 16.5, "speed": 24, "weather": "cloudy", "weatherMode": "cycle" },
  "night": 0.2,                     // room light at deep night (fraction of day)
  "nightLights": { "lanterns": { "threshold": 0.45, "stagger": 0.1, "flicker": 0.25 }, "street": { "threshold": 0.4 } },
  "windows": { "windows": { "cell": [2.2, 3.2], "lit": 0.65, "threshold": 0.5, "spread": 0.2, "late": 0.35 } },
  "puddles": 0.35,
  "dry": [[-3, 0, -2, 3, 3, 2]]     // rain-free boxes (glTF min xyz, max xyz) — or ENV_DRY_* nodes
}
```
2. **Lighting**: author the room neutrally (sky fill + AO, no baked sun) and let the engine add the sun (a banded
   directional term from the real sun position, with drifting cloud shadows) — or, for a room baked at one time of
   day, set `"bakedAt": 18.9, "sun": 0`: at that hour, in clear weather, the room, its painted sky, fog and the
   performers look exactly as authored; every other moment is relative to it (Kingsmarch does this).
3. **Night lights** (switch on as it gets dark, off at dawn; also in storms): a group listed in `nightLights`, or a
   `LIGHT_*` fixture with extras `nightOn: true` (optional `nightThreshold`, `nightStagger`, `flicker`, `nightFade`,
   `nightDay`, `poolRadius`), or an `EMIT_<group>` material with extra `nightOn: true`. Without a `nightLights` key,
   groups named lantern / lamp / street / window / brazier / torch / candle / campfire / porch / neon_sign /
   string_light / fairy are night lights automatically. `threshold` is the darkness (0 day … 1 deep night) at which
   the light comes on; `stagger` spreads fixtures randomly around it (± so a street lights up lamp by lamp); `day` =
   level in daylight (1 = always on, e.g. a campfire). Lit fixtures also cast **light pools** on the room (no real THREE
   lights; the nearest / biggest to the camera: Performance 0, Balanced 4, High 8, Ultra 12). A `LIGHT_*` point / spot
   fixture's real light (from the light show's budget) is scaled with it. In PRESHOW / OUTRO the light show owns these
   groups (`showOwnsNightLights`).
4. **City windows**: give building facades an `EMIT_<group>` material (the facade colour + a warm emission) and list the
   group under `windows`: `mode "world"` (default) cuts every vertical face into window cells of `cell` [w, h] m with a
   frame (`frame`), so any box / instanced building works without UVs; `mode "uv"` uses `grid` [cols, rows] over the UVs
   of a painted window texture. Each window gets its own threshold (`threshold ± spread`), a colour (`colors`, up to 4),
   `lit` = share that ever lights, `late` = share that goes dark after ~23:00, `tv` = share with a flickering blue TV.
5. **Sky**: no sky mesh → the procedural dome (gradient, sun + moon, stars, cel-banded clouds, lightning inside them).
   Own sky meshes: materials named `M_Sky*` / `GFX_SKY*` / `SKY_*` (or extra `envSky: true`) are tinted, get stars at
   night, and blend towards the real sky colours the further the moment is from `bakedAt`.
6. **Wind**: materials whose name contains foliage / leaf / leaves / grass / fern / palm / frond / bush / shrub / vine /
   reed / canopy / ivy sway; cloth / flag / banner / tarp / canvas / curtain / awning / pennant / sail flutter (never
   names with ground / floor / terrain / path / road). Sway grows with height above the MESH ORIGIN (put tree origins at
   the base, a flag's at its pole side). Material extras: `wind` (`"foliage"`, `"cloth"`, `false`), `windAmp` (m),
   `windHeight` (m), `windFreq`, `windBase`. Extra regexes: `foliage` / `cloth` lists; overall `sway`. Other systems
   read `envWind` (`{x, z, strength, gust, active}`) from `src/scene/environment/index.ts`.
7. **Rain**: falls everywhere around the camera except inside `ENV_DRY_*` nodes (a mesh = its bounds, hidden; an empty =
   its scale as half extents, or extras `size`) and `dry` boxes; the sun and wetness stop there too. Splashes land on
   up-facing surfaces found by ray-casting the room once. Wet surfaces darken (all tiers), get glossy + puddles with
   rain ripples on High / Ultra (`puddles` = share of flat ground; water / glass materials never).
8. Other keys: `exposure`, `fog: {near, far, tint} | false` (the fog colour follows the horizon), `rainArea` (m),
   `weathers` (allowed in the automatic cycle), `weatherByState` + `hourByState` (weatherMode `state`: e.g.
   PRESHOW → storm, OUTRO → 18:30), `performers: {minKey, minFill}` (default 0.62 / 0.55 of the studio lights).

## Runtime

- **Clock** (`SceneState.env.clock`): `cycle` = accelerated game clock (`speed` game hours per real hour: 1 = real time,
  24 = a day per hour, 60 = one game hour per minute), `real` = the host's local time (their UTC offset travels in
  `tz`, so guests abroad see the host's evening), `fixed` = locked. Changing speed / clock re-anchors (`epoch` = now,
  `hour` = the hour showing) so time never jumps. **Weather** (`weatherMode`): `manual` (crossfade `fade` s from
  `weatherFrom`, stamped `weatherAt`), `cycle` (automatic like games: a seeded smoothed random walk through the room's
  climate in `cycleMins` slots of absolute time — every page computes the same weather without messages), `state`
  (the lighting state via `weatherByState`). Weathers: clear, cloudy, overcast, light rain, heavy rain, storm (lightning),
  fog; each is a parameter vector (cloud, cloud darkness, light loss, rain, fog, wind, bolts, wetness) blended during
  transitions; wetness lags (wets in ~40 s, dries over ~4 min). **Sync**: pure functions of the state + room + wall
  clock; guests convert `epoch` / `weatherAt` with the party clock offset. Page-local are only visual glides (slider
  jumps, `state`-mode changes, lamp ignition fades).
- **Layers**: the light show stays authoritative (house level, fixtures, effects compose on top). The room's own
  materials get reflected light × (room light now / at the reference) — emission untouched — plus the sun term, pools,
  wetness and flashes. **Performers**: the studio key / fill / rim follow the sun / moon (warm golden hours, cool moon
  rim) and dim at night but never below `minKey` / `minFill` (faces stay readable); intensities before the scene update
  (the screen-landing dip still works), colours multiplied after the show's palette wash. NPC materials of the town
  crowd / raid are patched too (1 Hz scan).
- **Lightning**: deterministic strikes (1.7 s slots from the seed); with the lighting's **Safe** setting ≤ 3 flashes a
  second at 72 % depth. A flash lights the clouds from inside, the sky, the room and the performers; a close strike
  dips the night lights (power flicker) and calls `lights.cue('lightning')` on engines that want it.
- **Kingsmarch**: the town engine takes storm / fog / night from the environment (`activeEnv().townWeather()`) and
  leaves the sky tint, fog and rain to it (the lighting state still picks the festival). Its default reproduces the old
  behaviour: dusk locked at 18:57 (`bakedAt`), weather following the lighting state (PRESHOW storm, BRB fog, OUTRO
  18:30 cloudy) — pick Moving / Automatic in the Scene tab for a full day with weather.
- **Graphics levels** (no recompiles; counts / uniforms only): Performance — 3 cloud octaves, ≤ 900 drops, no splashes,
  darkening-only wet, no pools; Balanced — 4 octaves, 2200 drops, 260 splashes, 4 pools; High — 5 octaves, 4000 drops,
  520 splashes, gloss + puddles + ripples, 8 pools; Ultra — 6 octaves, 6500 drops, 800 splashes, 12 pools, the sun as a
  light-shaft (god ray) source. On High / Ultra the haze takes the fog's colour and thins at night.
- **Scene tab → Time & weather** (rooms with `environment`): clock readout + day bar, on / off, time slider, Dawn / Noon
  / Sunset / Night, Match my local time, clock mode, speed, lock; weather buttons, Manual / Automatic / Follow lighting,
  average weather length, weather change time, wind, lightning; live line (weather blend, darkness, night lights,
  wetness, drops, level, cost). Bus / MCP: `{type:'command', command:'scene', args:{env:{hour?, weather?, clock?, speed?,
  on?, auto?}}}`. Switching rooms starts from the new room's defaults.
- **Cost** (env_test, 1280×720, real GPU, whole frame incl. GPU sync; env off / clear noon / storm at night with rain,
  splashes, pools, windows): Performance 3.4 / 3.6 / 3.2 ms · Balanced 3.1 / 3.1 / 3.1 · High 3.5 / 3.5 / 4.1 · Ultra
  4.8 / 4.5 / 4.7 (run-to-run noise ≈ ±0.3 ms). CPU `EnvScene` ≈ 0.07–0.12 ms / frame (Kingsmarch with the crowd scan
  ≈ 0.3–1 ms right after load, then ≈ 0.2); one extra draw each for the sky, rain and splashes.

**Test pages** (never the live bus): `output.html?sceneTest=env_test&cam=CAM_WIDE&env=h19.2,storm` (tokens: `hNN.N`
hour, a weather name, `xNN` speed (moving clock), `cycle|real|fixed`, `auto` = automatic weather, `off`; `envSeed=`).
Console: `vtpOut.env.debug()`, `vtpOut.env.scene.manual = true; .clock = <epoch ms>; .force = {clock:'fixed', hour: 21,
weather:'storm', weatherFrom:'storm'}; vtpOut.step(14, 0.5)`.
Known limits: no real shadows (the sun term ignores occluders except `ENV_DRY_*` boxes — mark roofed areas); baked
light pools in a room's vertex colours dim with the room at night (bake without them, or rely on the night lights'
pools); the generated screen / chat rigs aren't darkened at night.

# Sky traffic (landing ships, cruisers, car streams) — src/scene/traffic/*

Rooms whose scene.json has a `traffic` key get ships of every size landing on and taking off from the room's pads, big
ships cruising past, and flying car streams (first user: `assets/scenes/sc_area18`, the Area 18 overlook). Attached by
`output.ts` next to the other layers (`trafficScene.attach/detach/update`; zero cost for other rooms).
- **Modules:**
  - `config.ts`: the room config + a polyline.
  - `flights.ts`: the closed-form flight plans. Each pad runs a cycle: approach, hover + turn, gear down, touchdown,
    parked, spool, lift-off, gear up, boost away. Cruise lanes release a ship every `every` s.
  - `fleet.ts`: `traffic/ships.glb` clones, with a per-clone engine glow, the gear child scaling, landing-light sprites
    and nav blink.
  - `streams.ts`: one instanced car mesh + one additive light point cloud.
  - `trafficScene.ts`: the orchestrator. It also handles the room effects: `ADD_*` materials drawn additive, spinning
    holo props (`traffic.spin`), the smart glass that tints in React (`traffic.smartGlass`), and a mirrored second
    sliding door leaf (`traffic.doorMirror`).
- **Sync:** every ship and car is a pure function of wall-clock seconds, so the studio, OBS and party guests' OBS show
  the same sky.
- **Night:** darkness comes from the environment engine (`activeEnv().townWeather().night`). The sky, fog, sun and the
  city's window lights stay the environment's job.
- **Contract and cost:** see `assets/scenes/sc_area18/README.md`.
- **Debug:** `vtpOut.traffic.debug()`, `vtpOut.traffic.scene.manual / clock / forceNight`.
- **Pass 2 (density) additions:**
  - ship LOD0 / LOD1 by on-screen size (`SHIP_<id>_LOD1`; LOD0 above 220 / lodBias² px; Performance always LOD1)
  - `traffic.parked` ships
  - lane `vehicle` (car / tug / drone templates) and `train {cars, gap, every}` consists
  - `traffic.ads` animated billboard atlas cells
  - security drones strobe red / blue
  - car hulls only within 1.1 km (× lodBias); lights only beyond that and on Performance
- **Pass 3 (lounge) additions** (`src/scene/traffic/patrons.ts`, `trafficScene.ts`):
  - `traffic.patrons {units, scale, list: [{name, unit, clip, sit, position, facing}]}` places stationary background NPCs.
    - They use the town NPC tech (TownAssets / TownNpc) and the library clips in `town_anims_ual.json`.
    - The clip phase comes from the wall clock.
    - LOD1 is used on Performance and Balanced; LOD0 is used within about 7 m × lodBias on High and Ultra.
    - A patron fades out when its head comes within 0.14 NDC of a performer's face and is behind it.
  - `traffic.roam {<NODE>: {path, pingpong | closed, speed, bob, pause}}` moves a room node along a polyline; the
    motion is a pure function of the clock (the bar drone and the cleaning bot).
  - For km-scale rooms, use `gfx.haze.density` of about 0.00005 and fog from about 900 m for a crisp, saturated city.
    The grade LUT is baked when the room binds, so to try new grade values, edit scene.json and reload.

**Room-building notes from Area 18 (kilometre-scale exteriors):**
- Keep overlapping far geometry apart. With a 3 cm near plane, depth error is ≈ d² / 500 000 m, i.e. ≈ 4 m at 1.4 km.
  Compress the far city towards the viewer instead.
- Set `gfx.haze.density` to ~0.0005. The built-in 0.01 per metre is tuned for 30 m rooms.
- Opt the facades into `environment.windows` with `mode "uv"` and a grid matching the painted facade tile.
- Pin the window groups to `steady` in `suggestedLooks`, so the light show never strobes a skyline.

# AFK cinematic director + chatter names on ships — src/scene/afk/*, shared/afk.ts

A "be right back / starting soon" mode. While it's on, the camera tours the room on its own: the room's cinematic
cameras in a seeded rotation, cutting to **event shots** when something happens that a camera can see (a ship touching
down on a pad or lifting off, a kill in the room's baked battle). Ships carry **chatter names** from the live chat
("Skiff · Maple"). A room opts in through its scene.json (below); rooms with sky traffic and a baked battle get the most
out of it.

| File | Role |
|---|---|
| `shared/afk.ts` | `SceneAfkState` (in `SceneState.afk`, host-owned + sanitised), room config types, the shot cycle (`AfkCycle`), event selection (`takeEvents`, `afkPick`), chatter names (`crewNameFor`, `mergeCrew`, `crewNameOk`). No three.js: `npx tsx tools/afk_unit.ts` |
| `src/scene/afk/afkScene.ts` | the director (a `SceneRuntime.cameraOverride`), which cameras see which pad / moment (room rays, once per room), chase / over-the-shoulder shots, tags, the title card |
| `src/scene/afk/moments.ts` | battle moments found in the room's own clips |
| `src/scene/afk/shipTags.ts` | the name pills (billboard sprites) |
| `src/scene/afk/overlay.ts` | the "BE RIGHT BACK" / "STARTING SOON" lower third (page DOM) |
| `src/ui/afkPanel.ts` | Scene tab → **AFK / Starting soon** (+ the one-click bar at the top of the Scene tab) |

**Turning it on.** Scene tab → *🎬 Go AFK* (or Simple mode → *Away* → *AFK tour*); Stream Deck / scripts
`POST http://127.0.0.1:5191/api/scene/afk` (localhost only; no body = toggle, or
`{"on": true | false | "toggle", "overlay": "off"|"brb"|"soon"|"custom", "text": "BACK IN 5", "names": "afk"|"always"|"off",
"pace": "calm"|"normal"|"snappy", "events": bool, "hideHost": bool}`); bus / MCP `scene {afk: {...}}`. Like lighting, the
host studio owns the state, so the studio must be open. There is deliberately **no default key**: the Shift + letter keys
are the studio's and the keys people have bound to their models, so AFK takes none of them (bind the Stream Deck action
to a key of your own).

**State** (`SceneState.afk`, missing = off — existing rooms and saved states are unchanged): `on`; `seed` + `epoch`
(stamped each time it turns on); `overlay` (title card, **off by default**) + `text`; `names` (`afk` = while AFK,
default · `always` · `off`); `events` (cut to the action, default on); `pace` (calm 1.4× / normal / snappy 0.7× the
room's hold); `hideHost` (walk the host out of the room while AFK and back in when it ends — the entrance camera follows
them back in; `hostOut` remembers that AFK did it); `crew` (the names, below).

**The director** (Talk mode only). Priority: the entrance follow-cam, then the room directors in the `cameraOverride`
chain — the ones attached before it (raid, space, town …) are asked first, the ones attached after it (kitchen riots,
club / festival shows, the Slap gag … `src/output.ts` attach order) wrap it and win while they have a shot — then AFK,
then the lighting-state ambient cameras (below). React, Gaming, Interview and TTRPG aren't Talk, so AFK never competes
with their own directors; the title card still shows. Leaving AFK (or a shot of another director) is a cut.
- **The cycle**: scene.json `afk.shots`, else every `CAM_*` preset except `CAM_REACT`, `CAM_DOOR`, other systems'
  cinematic cameras (raid / cryo / drop-pod entrances, the kitchen riot, the tabletop table / dice / GM shots, game
  spectator cameras) and *tight* ones (any performer's face ≥ 12 % of the frame height — close-ups of an empty chair aren't
  cinematic). `order: 'shuffle'` (default): seeded rounds, every shot `weight` times per round, never twice in a row;
  `'list'`: in order. Each shot holds a seeded time in `hold` (default [7, 12] s) × pace, with a slow push-in, pull-out
  or pan (`drift: false` turns it off). Nearby interior shots with a clear path sometimes dolly across (the rig's
  smootherstep, ~2 s); everything else is a cut.
- **Live cameras** (presets the room flags `live`, found by that flag, never by a name): when a room has them they join
  the cycle and the event shots of their battle group (`includeLive: false` = never). Without the live-camera feature
  there are none and every camera is an ordinary preset, so AFK works whether or not it is in the build.
- **Event shots** — pure functions of room data + the clock, so every page agrees:
  - *Landings / launches* (sky traffic): the pad cycles are closed-form (`FlightPlanner.padEvents`), touchdown shown
    from 7 s before to 2.5 s after, lift-off from 2.5 s before to 6.5 s after. Shot: a room camera that sees the pad and
    the hover point above it, or a **chase camera** behind and above the ship (its cockpit when `traffic/ships.json`
    gives `cockpit: [x, y, z]`, ship-local metres, nose −Z), re-aimed every frame at the pose the fleet draws.
  - *Kills* in the room's baked battle: the frame a node named `*EXPLOSION*` / `*BOOM*` / `*BLAST*` / `*KILL*` /
    `*DEATH*` pops in (its scale key goes from ~0 to visible) in a room clip, found automatically; shown 3.2 s before
    to 3.3 s after. Shot: a room camera that sees it, an **over-the-shoulder** shot from one of our own craft in the same
    battle group (the top node it sits under), or a live camera riding that group. Moments can also be listed:
    `afk.moments: [{ "node": "BTL_G2_EXPLOSION", "at": 19.7, "kind": "kill", "cams": ["CAM_BATTLE_WIDE"], "lead": 3, "tail": 4 }]`
    (`every` = loop length, default the clip's).
  - Which camera sees what is measured once per room with room rays (glass, additive FX and everything a clip moves
    don't block; 16:9 frame, the middle 80 %, a readable size), spread over frames: about 1 ms of work per frame, and
    the one expensive step — posing every room clip at a moment's time (a big room has ~100 clips) — runs alone, once per
    frame, followed by the put-back (the clips are re-posed at the room clock before the frame is drawn, and only when the
    plan posed them). A page that just opened shows the plain cycle until that's done (a second or two).
  - Choosing: a seeded `share` of the moments is eligible (default 0.7; a kill in a loop shorter than a minute
    proportionally less often), and one is taken when it beats every eligible moment its shot would overlap (padded by
    `gap` s of ordinary shots, default 14). This rule is local — a page that opens late decides like one that ran all
    along. An ordinary shot squeezed to < 3.5 s by an event isn't shown (its neighbour holds instead).
- **Sync**: the AFK clock is the wall clock, like sky traffic and room clips — deliberately *not* converted to a guest's
  clock like raid / space epochs, so on a guest page whose clock is skewed the ships, the battle and the cuts shift
  together and every cut still lands on its moment.

**Chatter names on ships.** Sky-traffic ships (landing, cruising, parked; not tugs / carts / cars) and the room's own
craft — scene.json `shipNames.craft`, else any node named after one of the room's traffic ships (`BTL_G1_SKIFF_A` →
`skiff`; not the room's `ALERT_*` support-alert set pieces) — wear a pill "‹class› · ‹name›" while `names` says so and the crew isn't empty.
- **The crew** (`SceneState.afk.crew`, host-stamped so every page paints the same names): the display names of the
  latest ≤ 24 chatters (Kick, YouTube, Rumble — any platform the chat hub carries), newest first, restamped at most every
  8 s. Only display names already public in chat, never ids. Never on a ship: bots (the chat bot list + Scene tab bots),
  the broadcaster, links, names the built-in word filter blocks (`safeName` in `shared/audience.ts`, the filter the crowd
  name tags and question cards use: look-alike letters, spaced-out letters, links; checked when the host collects the
  names and again by the sanitiser, so the server and every page agree), names containing a word from the host's *Never show* list (this browser; matched loosely:
  0/1/3/4/5/@/$ spellings), test events, and anyone a moderator acted on — a deleted message removes its author, a ban /
  timeout (purge) removes that user (found by platform user id when the platform sends one: a Twitch ban names the login, the ship
  carries the display name), a chat clear removes everyone on that platform; removals are stamped at once and never come back
  this session. *Use test names* / *Clear names* in the Scene tab.
- **Which ship gets which name** (`crewNameFor`, the same on every page): each flight (a pad cycle, a cruise release, a
  parked ship's 5-minute turn, a craft's clip loop — at least 20 s) takes, by rendezvous hashing over the names it may
  carry, the first name no ship already in the air carries (else the least used), so ships seen together get different
  names while there are enough. A name joins 3 s after it's stamped and never renames a ship already flying; a chatter
  pushed out of the list stays on the ships that took off with them (`until`) and drops out 15 min later. In a traffic
  room names appear once its flight plans have loaded (a second or so after the page opens): a ship is named against the
  whole sky, so a page never paints a name another page wouldn't.
- **The pill**: `shipNames.style` = `{ "text": "#F5A623", "bg": "rgba(12,10,6,0.82)", "border": "rgba(245,166,35,0.55)",
  "font": "700 44px Inter", "size": 20, "upper": false }` (amber on a dark pill by default; `size` = px at 1080p, the same
  on screen at any distance). It fades in once the ship is ~20–40 px long on screen, never covers a performer's face or
  the React screen, at most 8 at once (the biggest ships win, never two on top of each other), depth-tested (the room
  hides it like the ship), not tone mapped. `shipNames: { "enabled": false }` = no tags in this room; `traffic` /
  `parked: false` leave those out; `classes: { "skiff": "Skiff" }` renames a class; `maxDistance` (m, default 1200).

**The title card** (off by default): a lower third over the room on OBS pages and the preview — "BE RIGHT BACK",
"STARTING SOON" or the host's own text, in the room's accent (`shipNames.style.text`).

**With the lighting states, BRB and ambient cameras.** AFK is its own switch: it never changes the lights, and a room
that doesn't opt in (AFK off, the default) behaves exactly as before. The **BRB** lighting state (fade to black + the
Be Right Back card, guests muted — docs/BRB_SCREENS.md) covers the whole OBS page while it is on, so the AFK tour and its
title card are simply hidden behind it and carry on underneath (use one or the other: BRB for a plain card, AFK for a
tour). **Ambient cameras** (Scene → Ambient cameras: the Preshow / BRB / Outro slots, `src/scene/ambientCam.ts`) are the
camera for those lighting states while AFK is off; while AFK is on (Talk mode) the AFK tour is asked first and takes the
camera, and the ambient cameras come back the moment AFK ends. The AFK title card is a lower third, not a replacement for
the BRB card. OBS scene switching on BRB keys off the lighting state, so going AFK does not switch OBS scenes by itself.

**Performers**: they stay in their seats by default (tracking lost → the avatar idles) and appear in the room's wider
shots; tight shots are left out of the tour. *Walk me out while AFK* sends the host out of the door instead.

scene.json (all optional; a room without them gets the defaults above):
```json
"afk": { "shots": ["CAM_FULL_SHIP", { "cam": "CAM_BATTLE_WIDE", "weight": 2, "hold": [8, 14], "drift": "push" }, "CAM_HANGAR"],
         "exclude": ["CAM_CONSOLE"], "hold": [7, 12], "order": "shuffle", "includeLive": true,
         "events": true, "share": 0.7, "gap": 14, "chase": true, "autoMoments": true, "drift": true },
"shipNames": { "enabled": true, "style": { "text": "#F5A623", "bg": "rgba(12,10,6,0.82)" },
               "craft": ["BTL_G1_SKIFF_A", { "node": "BTL_G2_FREIGHTER", "label": "Freighter" }], "classes": { "skiff": "Skiff" } }
```

**Cost**: off = one check per frame. On: the director ≈ 0.02–0.1 ms per frame; tags ≈ 0.05 ms for ~15 ships; the
visibility plan once per room (a few hundred rays, time-sliced to about 1 ms a frame); the title card is `display:none`
while no title shows (no animation, no layer) and never uses a backdrop blur; naming a ship ≈ 0.02 ms (a page that opens late resolves
≤ 1 hour of flights once: a few ms).

**Test pages** (never the live bus): `output.html?sceneTest=<room id>&afk=on,brb&afkSeed=7&crew=Maple,SkyRider`
(`afk=on,brb|soon,always|nonames,calm|snappy,noevents`, `afkAt=<s into it>`). Console: `vtpOut.afk.debug()` (shots,
crafts, pads → best cameras, moments, the shot on air, the next event, tags), `vtpOut.afk.scene.upcoming()`,
`vtpOut.afk.scene.freeze(ms)` (pins the AFK, sky-traffic and room-clip clocks to that wall time; the page's frames then
advance them together). Unit checks: `npx tsx tools/afk_unit.ts` (the state, shots, events, names) and
`npx tsx tools/afk_camera_chain_unit.ts` (the camera override chain, detach restore, tag disposal, the title card).

Known limits: event shots use room cameras, chase / over-the-shoulder shots computed from the ship or craft, and live
cameras — a moment no camera sees is skipped; the over-the-shoulder shot assumes the craft's origin is its centre; the
chat props (monitor, board, Sprocket) stay placed for the host's own shot.

# Ambient crowd (background characters doing things) — src/scene/crowd/*

A room whose scene.json has a `crowd` key and `ACTIVITY_xx` anchors gets a crowd of background characters (first user:
`assets/scenes/my_room`, a swamp full of Sprockets). Generic: any room can place activities; the unit GLB
(`crowd.units`) holds one rig, its clips, `OUTFIT_<id>` meshes (toggled per character), `PROP_<id>` nodes parented to
bones and `ROOTPROP_<id>` nodes (ride the character's root, e.g. a canoe). The swamp's unit is built by
`assets/scenes/my_room/blender/sw_frogs.py` (frog_v2 + costumes baked to vertex colours + FK-solver clips).

| Node | Meaning |
|---|---|
| `ACTIVITY_xx` | Empty. extras `activity` = `band` · `dive` · `conga` · `armwrestle` · `swim` · `hop` (lily-pad race) · `canoe` · `climb` · `juggle` · `fish` · `dj` · `sleep` (anything else = an idle / clapping crowd spot), `outfits` (comma list, one per character), `frogs` (count), `group` + `order` (a rotation group: its activities take turns and share one set of characters), `radius` / `rx` / `rz` (circles / ellipses) |
| `ACTIVITY_xx_P01…` | Ordered points (band positions, lily pads, climbing holds …; +Z = facing) |
| `ACTIVITY_xx_<NAME>` | Named points: dive `BOARD` / `SPLASH` / `LADDER` / `TOP`, fish `BOBBER`, any `WATER` (where the characters hop out of / back into the water when a group turn changes) |
| `CROWD_FX_xx` | Ambient effects: extras `fx` = `fireflies` · `bubbles` · `smoke` · `fire`, `radius`, `height`, `count` |

scene.json `crowd`: `units`, `fx` (4×4 atlas), `height` (m), `seed`, `water` (surface y), `turn` (s per group turn, default
150), `flash` (EMIT_ groups that flash on support, default `["sign","neon"]`), `max` (characters, default 14), `on`.

**Sync:** every pose is a pure function of (anchors, seed, wall-clock seconds, support events stamped with the chat
event's `ts`), so the studio preview, OBS pages and party guests' OBS pages show the same show with no messages.
**Support events** (tips, subs, memberships, raids — the chat feed): standing characters cheer / clap, the band plays
60 % faster for 25 s, the DJ jumps and shouts the supporter out, the sleeper falls out of his hammock, the next dive is a
mega cannonball, the next climb reaches the top, and the room's neon sign flashes (≤ 2.4 flashes/s). PRESHOW / OUTRO
lighting states turn it into a dance party. **Protection:** a character is hidden (≥ 1 s hysteresis) while it would
cover a performer's face from behind or the react screen. **Cost:** ≤ 14 skinned characters (LOD1 body when small, no
pose update when off screen), one instanced draw per FX cell; ≈ 0.25 ms CPU per frame.

**Test pages:** `output.html?sceneTest=my_room&crowd=support@3&crowdForce=water:hop,rocks:fish,floor:conga`.
Console: `vtpOut.crowd.debug()`, `vtpOut.crowd.scene.manual = true; .clock = <ms>`, `.force = {water: 'canoe'}`,
`.testSupport('name', inSec)`.

# Kitchen (background crew, food fights, unrest meter, riots) — src/scene/kitchen/*

A room with `KITCHEN_*` anchors gets a background NPC kitchen. The reference room is `assets/scenes/my_kitchen_room`,
and its README has the full feature list. State lives in `SceneState.kitchen` (`shared/kitchen.ts`). It is host-owned
and sanitised, and guests convert the host clock for `epoch`, `unrestAt` and `events[].at`. It is deterministic like
the raid: the planner (`kitchenPlan.ts`) turns `(seed, event id, room)` into per-actor segment tracks plus throws,
splats, bubbles, puffs and door / trash keyframes, and every page samples them at wall-clock time.

| Node | Meaning |
|---|---|
| `KITCHEN_STATION_xx` | A crew frog's work spot. Origin = feet (y = the stool top), +Z faces the work surface. extras `kind` = `grill` / `assemble` / `fries` / `bag` / `drinks`, `nav` = the `KITCHEN_NAV_xx` it steps down to |
| `KITCHEN_NAV_xx` | Floor nav node. extras `links` = comma-separated neighbours (made symmetric) |
| `KITCHEN_MANAGER_ENTER` / `_YELL` | The manager's spawn (behind `KITCHEN_DOOR_OFFICE`) and his yelling spot (+Z = facing) |
| `KITCHEN_BRUTE_ENTER` / `_ROAR` | The freezer guy's spawn (behind `KITCHEN_DOOR_FREEZER`) and his hero spot |
| `KITCHEN_DOOR_OFFICE` / `_FREEZER` | Door leaves. Origin = hinge; extras `openAngle` (deg) and `openSign` (±1) |
| `KITCHEN_SPLAT_xx` | A surface food splats on. +Z = the surface normal; extras `surface` = `wall` / `counter` / `floor` / `ceiling` |
| `KITCHEN_TRASH`, `KITCHEN_SOFTSERVE` | The trash can (tips in riots; origin = floor pivot) and the soft-serve nozzle (erupts) |
| `KITCHEN_METER`, `KITCHEN_INCIDENT` | Planes the engine draws on: the unrest meter and "minutes without a frog incident" |
| `KITCHEN_ZONE` | Empty. extras `size` = full extents where frogs may be launched to |
| `LIGHT_ALARM_xx` | Riot beacons (`EMIT_alarm`). They pulse and spin, and a red point light pulses with them |
| `CAM_MANAGER`, `CAM_FREEZER`, `CAM_KITCHEN`, `CAM_RIOT` | The riot director's shots |

scene.json `kitchen`: `frogHeight`, `managerHeight`, `bruteHeight` and `npc` (a folder holding `frog_crew.glb`,
`manager.glb`, `brute.glb` and `fx_atlas.png`). Its presence also tells the studio the room takes donations.

**Episodes:**
- **Random food fights:** slots of `240 / freq` s, ~72 % filled.
- **Events:** `foodfight`, `riot`, `manager` (an inspection) and `stir` (one frog seethes). Events queue and never
  overlap; random fights that would overlap an event are dropped.

**Donations** (`controller.kitchenSupport`):
- Each donation adds its USD value (subs = $5) to `unrest` and stamps a `stir`.
- Crossing half of `riotAt` stamps a `foodfight`.
- Reaching `riotAt` stamps a `riot` carrying the supporter's name and resets the meter.
- The meter cools by `decay` $/min.

**Protection and camera:**
- Every NPC fades while it would cover a performer's face (unless it's in front of them) or the React screen.
- Riots take the camera through `cameraOverride`, wrapping any room engine's own director, only when `riotCam` is on
  and never in React.

**Studio:** Scene tab → **Kitchen**, with the options and test buttons. Bus / MCP command:
`scene {kitchen: {on?, fights?, freq?, event?, donate?}}`.

**Test pages:** `output.html?sceneTest=<room>&kitchen=on,fight|riot|manager[,nofights]&kitchenAt=<s>&kitchenSeed=<n>&unrest=<$>`.
Debug handles:
- `vtpOut.kitchen.debug()` for the planner and schedule state.
- `vtpOut.kitchen.scene.manual = true; vtpOut.kitchen.scene.clock = <ms>` to drive the clock by hand.

# Room-change transitions ("curtains") — src/scene/transition/*, shared/curtain.ts

When the room changes (host `setScene`, a bus / MCP `scene {sceneId}` command, Classic ↔ room), every OBS page — the
host's and every party guest's — and the Scene-tab preview cover the frame with an animated card **before** the old
room is torn down, load the new room behind it, and reveal it once it is really ready. The audience never sees the
empty (transparent) frame, half-built rooms or pop-in.

**State (host-owned, `SceneState.curtain`, missing = defaults):** `{ style, dur, hold, minHold, boot, seq, confirm,
pool? }`. `style`: `vtp-light` · `vtp-dark` (default) · `bw-swamp` · `bw-hop` · `bw-lily` · `bw-standby` · `bw-neon` ·
`shuffle` (a different one per change, picked from `seq` so every page plays the same; `pool` = which) · `cut` (no
transition, the old behaviour) · `hive-doors` (a guest's set, below). `dur` = cover-in seconds (styles scale it: `inMul` / `outMul`), `minHold` = minimum time
fully covered, `boot` = also cover when an OBS page (re)loads with a room. The controller bumps `seq` on every room
change; **hold mode** (`hold: true`) keeps the card up after the room is ready until the host confirms
(`confirm = seq`). Not to be confused with `state.transition` (camera move seconds). No clocks involved, so guests
need no offset.

**Page flow (`src/output.ts` → `Curtain`):** new `sceneId` → `curtain.cover()` (the cover-in animation; it resolves only
after ≥ 2 fully opaque frames were drawn) → *then* the old room's engines detach and it is disposed →
`SceneRuntime.load` + engines attach → `curtain.loadDone()` → readiness: every asset load quiet (all three.js loaders
on `DefaultLoadingManager` + asset-looking GET fetches, counted globally by `assetWatch.ts`; no avatar mid-load) →
textures uploaded (`renderer.initTexture`) + `renderer.compileAsync` → ≥ 8 rendered frames with steady intervals →
quiet again (engines load on their first updates; up to 4 rounds) → **ready** → reveal after `minHold` (and, in hold
mode, the confirm). Caps: 25 s to get ready, 3 min waiting for a confirm; the load itself has no cap while it still
moves: the room model is fetched by SceneRuntime (per request: a newer load aborts an older one, whose late bytes count
for nothing) and its real progress shows on the cover as "Loading <room>: 23 of 125 MB" for rooms over 20 MB; only a
minute with nothing arriving (neither the model's bytes nor any other asset) gives up - and aborts the download. A room
that fails to load (an error, a stall) KEEPS the cover up with "<room> didn't load. Pick it again, or another room."
and the studio's Transitions line says so (phase `failed`, why `failed` / `stalled`): the cover never lifts onto an
empty page (an OBS Browser Source shows a transparent page as black). Picking the same room again saves a retry token
(`curtain.retry`), so every OBS page and party guest whose room failed loads it again; a load that still completes for
the current cover clears the failure and reveals. `tools/curtain_unit.ts` checks this contract. A newer change while
covered re-uses the same cover; picking the old room again during the cover-in cancels (the old room is kept). While
fully covered + ready the page skips drawing the 3D scene (GPU). A 100 ms timer keeps the phases moving when rAF is
stalled (hidden OBS source). OBS pages report `{type:'curtain', status}` on the bus (phase, load / ready / total ms).

**Per-room transitions** (`shared/curtain.ts` `roomCurtainPick` / `stampRoomCurtain`): a room's scene.json may bring its
own card — `"curtain": { "in": "hive-doors", "out": "hive-doors" }` (a string = both). `in` plays when the party arrives
in the room, `out` when it leaves it. For a change A → B the style is **B.curtain.in ?? A.curtain.out ?? the host's
style**. The host's choice still wins when it is **Cut** (no transitions at all), when *Rooms bring their own
transition* is off (`curtain.rooms: false`), and for a command that names a style together with the room. The host's
controller resolves it once, when it bumps `seq`, and stamps `curtain.room = {seq, style, side: 'in' | 'out', from}`;
every page plays the stamped style for exactly that `seq` (a page that doesn't know the style plays the host's own), so
the host's OBS, the preview and every guest's OBS show the same card with no page-local choice. `CurtainCard.side` tells
the style why it plays ('out' = leaving a room: e.g. "UNDOCKING…"). Mode-change covers and boot covers use the host's
style / the last stamp as before. Old pages ignore the stamp (they play the host's style).

**Controls:** Scene tab → **Transitions** (style cards with live mini previews — hover to play; per-style **Test** plays
in the Scene preview only, never on OBS; speed; minimum time; *Hold until I confirm* + **Confirm**; *Also when an OBS
page (re)loads*; *Rooms bring their own transition*; status of this PC's OBS pages). **Shift+Enter** = confirm.
Automation: bus / MCP `send_command scene {"curtain":{"confirm":true}}` (also `style`, `hold`, `dur`, `boot`,
`minHold`, `rooms`; a style given in the same command as a `sceneId` applies to that change, over the rooms' own) or
`POST /api/scene/curtain {"confirm":true}` (Stream Deck).

**Styles** (`kit.ts` contract: one Canvas2D draw per frame in 1080p units `u`, crisp at any output size; `'in'` p = 1,
`'hold'` and `'out'` p = 0 MUST be fully opaque; anything else may leave pixels transparent = OBS shows the layer
under the browser source): `stylesVtp.ts` — the VTube Pro brand (UI theme tokens), ships with the engine.
Everything is procedural (no images / video); the destination card shows the room's `preview.png` (else `thumb.png`). A new style = a `CurtainStyleDef` in the registry array (`styles.ts`).

**Testing (test pages only):** `output.html?sceneTest=<room>` + `vtpOut.debugScene({...vtpOut.sceneState, sceneId,
curtain: {..., seq: n}})` (add `room: {seq: n, style: 'hive-doors', side: 'out'}` to play a room stamp);
`vtpOut.curtainTest('bw-hop')` plays one without changing rooms (`vtpOut.curtainTest('hive-doors', 'out')` = the
"UNDOCKING…" card); `&curtain=boot` covers the first room too; `vtpOut.curtain.status` / `.timing` (ms per readiness stage). Measured (headless Chrome, 1280×720,
vtp-dark, `minHold` 0): every room ready 1.3–3.6 s after the switch (cover-in included), fully revealed 2.2–4.5 s; zero
uncovered or black frames while held.


## TV performers (webcam / VTube Studio guests on a walking TV) — `src/scene/tv/*`

A party member without a 3D avatar (docs/MULTIPLAYER_DISCORD.md → "TV guests") is a **scene actor like any other**: its
`actor.runtime` is a `TvRuntime` that implements the part of `AvatarRuntime` the scene uses (anchor, model, profile.size,
`humanoid === null`, poseHook, update, bounds, faceInfo, dispose). So spots, seats, size classes (from the TV's height:
the pocket handheld is micro, the arcade cabinet macro), the walk mover, follow / talk / group cameras, tile cameras and
the shot solver need no changes. What it adds:
- **Face = the screen**: `faceInfo()` is the TV_SCREEN centre + picture height, so every camera frames the picture.
- **Body**: the tvart GLB (`assets/builtin/tv_performer/tv_profile.json` → `skins/<id>.glb`, 18 named in-place clips) or,
  if not installed, the engine grey-box (`tvGreybox.ts`, procedural clips). Bounds skip `TV_ANTENNA*` (normalised height
  = set + legs). Walking plays `walk` / `run` time-scaled by the skin's clip speed (no foot sliding); the walk mover's
  leg-less hop is undone. Seats: the GLB clips carry the seat themselves (root on the floor, `sit_down` scrubbed by the
  seat blend) — the engine's leg-less seat lift / push-back is undone and fitted to the seat's real height.
- **Behaviour**: `enter_hop` on first appearing, `wave` on arrival, `talk_gesture` by the voice level (the guest's mic
  loudness, 15 Hz), `idle_bored` after 25 s of silence, `static_glitch` when the feed drops; `tvReact(actor, clip)` for
  modes / games; `tv.external = {speed, sit, airborne}` for physics games.
- **Screen**: `tvScreen.ts` — cover / contain fit, mirror, chroma key with spill removal over a themed backdrop, per-skin
  scanlines / curvature / glow / vignette / subtle glass, power-on, bad-signal tearing, NO SIGNAL + static, alpha 1
  (never a hole in the OBS output). The feed texture uploads only on new frames.
- **Elsewhere**: `tvFeedMaterial(key, {fx: 'clean' | 'tv'})` puts a member's live picture (with their key) on any mesh
  (interview monitor, strips); `tvFeedOf(key)` gives the texture / stream / state / level.
- Test pages: `vtpOut.debugParty([{id, name, slot, tv: {...}}])` + `vtpTv.feeds.inject(id, stream)`; OBS pages receive
  real feeds from this PC's studio (`&tvBus=1` on sceneTest pages). Measured cost (1080p, RTX 5090): +1.7 ms CPU /
  +0.13 ms GPU per frame for 4 TVs, +2.1 / +0.16 ms for 7.

# TTRPG tables (tabletop rooms, 3D dice, the GM) — src/ttrpg/*, shared/ttrpg/*

Every environment can have a TTRPG room `<env>_ttrpg` (scene.json `ttrpg.of = "<env>"`; the generic Game Room
`ttrpg_table` has `of: "*"`). The contract adds `TABLE`, `MAP_SURFACE`, `SEAT_01..08` (= spots, sit by default),
`GM_SEAT` (= spot 12), `GM_PROP`, `DICE_TRAY`, `HANDOUT`, `CAM_TABLE_TOP / _WIDE`, `CAM_GM`, `CAM_DICE`, `CAM_SEAT_xx`
(= that seat's talk camera) and `LIGHT_MOOD_*`. `src/scene/contract.ts` aliases SEAT_xx / GM_SEAT / CAM_SEAT_xx onto the
normal spots / talk cameras (SPOT_xx wins where both exist), so seating, walk-ins and framing need nothing new.

`SceneState.ttrpg` (host-owned) drives the table engine on every page (`src/ttrpg/scene/*`, installed by
`src/ttrpg/scene/outputHook.ts` with its own frame callback): the battle map on MAP_SURFACE, minis, dice thrown with
Rapier from each roll's seed (faces forced to the host's result), the GM figure + text-driven mouth, mood lights, the
handout, captions / roll cards / initiative overlay, and the table's auto-director (`SceneRuntime.cameraOverride`:
speaker close-ups, GM, dice cam with crit push-in, map in combat, handouts; React mode keeps its own shot). Free while no
session runs. Test page: `output.html?sceneTest=<room>&ttrpg=demo` + `vtpOut.ttrpg.debug()`.

Everything else — the full contract, the AI Game Master (keys stay on the server), dice, sheets, safety tools, VTT
bridges (Foundry / Owlbear / Roll20) — is in **[docs/TTRPG.md](TTRPG.md)**.

# Capture cover (privacy cover while a game is set up) — src/scene/capcover/*, shared/capcover.ts

While the host sets up a game or picks a window, an animated card covers **only the screen-capture area**: the React
screen (big SCREEN / solo side screen: OBS passthrough hole and in-scene capture), the React Full / Medium capture rect and
the Gaming capture rect. Performers, cams, docks and chat are never covered. It **stays up until the host turns it off**:
nothing auto-dismisses. It animates in and out; while up, the style loops.

**State (host-owned):** `SceneState.capcover = { on, style, text }` (missing = off). Every OBS page (host and guests) and
the Scene preview follow it. A page that (re)loads while it is on starts fully covered (no in-animation).
**How it draws:** one Canvas2D card per page (`cover.ts`, sized to the capture area on that page, ≤ 2560×1440, redrawn at
30 fps while holding, every frame while animating) uploaded as ONE CanvasTexture shared through `uniforms.ts`:
- 3d React screens: `ScreenFx(hole, capture = true)` (only `screen.ts` / `soloScreen.ts`, never the chat monitors) mixes the
  card over the content AND over the OBS hole (the hole turns opaque; premultiplied 'over') — depth-tested, so performers in
  front of the screen stay in front and the perspective is right.
- Composite layouts: `FrameFx.drawCover` after the solid pass: 'over' everywhere in the capture rect except a cam's picture
  (the bezel over a hole is see-through glass, so it is covered too), then 'destination-over' inside cut-out cams (the
  card goes only behind the avatar standing on the capture).
**Styles** (`kit.ts` contract like the transition kit: phases in / hold / out, 'hold' airtight, 1080p design units
centred in any capture aspect; reuses `src/scene/transition/kit.ts` helpers): `stylesVtp.ts` ships with the engine —
`cc-cartridge` (blow the cartridge, CLUNK, pixel loading bar; pixel dissolve), `cc-jackin` (neon cable jacks in, data
rain, handshake log; glowing wipe), `cc-boot` (PRESS START, spinning disc, loading tips; iris). `stylesStudio.ts` is
**personal content** (drop its import in `styles.ts` for a public build): `bw-controller` (Sprocket: wrong way BONK,
CLICK, cable too short POP, drags the console over, CLICK, READY — loops with an attempt counter; plank shutter) and
`bw-warzone` (Sprocket in a helmet over his top hat behind sandbags at dusk: mag out, CLACK, CHK-CHK, raised to the sky,
distant flashes + smoke; smoke billow in / out). Rifle points at the sky, nobody is shot.
**Controls:** Scene tab → *Capture cover* (big on / off button, card text, style cards with hover previews); studio key
the Hide my screen key (**Ctrl+B** unless changed in Live → Privacy); bus / MCP `send_command scene {"cover":{"on":true | false | "toggle", "style", "text"}}`;
`POST /api/scene/cover {"on":"toggle"}` (Stream Deck, localhost only).
**Testing (test pages only):** `output.html?sceneTest=<room>&mode=react&react=full&cover=bw-controller[&coverText=…]`
starts covered; `vtpOut.cover.set({on, style, text})` (null = follow the state), `vtpOut.cover.info()`,
`vtpOut.cover.layer` (the layer). Verified with a magenta page background (= the capture behind the hole): React Big /
Side / Full / Medium, Gaming corner / strip / cut-out: 0 uncovered pixels in the capture area for every style; pixels
outside it unchanged (only the avatars' own idle animation).

# Room prop toggles (node groups the host switches on / off live) — shared/roomToggles.ts, src/scene/roomToggles.ts

A room can mark parts of its set as **switchable**: a decor corner some platforms don't allow (drug paraphernalia on
Twitch / YouTube), a seasonal set, a sponsor shelf. The host shows or hides each one live; every page agrees.

**Declaring a toggle (content only, no code).** Either or both:
- scene.json `toggles`: `[{ "id": "420", "label": "cannaHoney corner", "nodes": ["R7_420_ROOT"], "default": true }]`
  — `id` 1–32 of `A-Z a-z 0-9 _ -`; `label` for the Scene tab (default: the id); `nodes` = glTF node names whose whole
  subtree the toggle hides; `default` = shown until the host says otherwise (default `true`). ≤ 16 toggles, ≤ 32 nodes each.
  Rooms with areas may override `toggles` per area like any other key.
- glTF node extras (Blender custom properties on the object): `toggleGroup: "<id>"` (+ optional `toggleLabel` or `label`,
  `toggleDefault: false`) declares the group in the glb alone. Both sources merge by id (scene.json wins for label /
  default; the nodes are the union). Put the whole set under **one empty root** and point the toggle at it.

**State (host-owned):** `SceneState.toggles = { "<id>": true | false }` for the CURRENT room (missing id = its default;
missing key = every toggle at its default). Stamped in the scene state like the capture cover, so the Scene-tab preview,
every OBS page of the host and every party guest's OBS show the same set; a page that loads later gets it with the room.
The host's choice is **remembered per room** (the studio's `localStorage` `vtp.scene.toggles`, by base room id, so every
area of a room shares it) and restored when the room is picked again; the current room's also survives restarts in
`cache/scene.json`. Switching to another room drops the old room's toggles.

**What "hidden" does (every page, `SceneRuntime.setState` → `RoomToggles.apply`):**
- `visible = false` on each root (its subtree stops drawing; the root's own authored visibility comes back when shown);
- its meshes leave `room.occluders` (the camera solver, the solo two-shot, auto cameras, size spots and every other
  line-of-sight test read that list) and its `COLLIDE_*` nodes leave `room.colliders`; cached shots re-solve;
- `FLOOR_*` walk data under a hidden root stops counting (`floors.ts`);
- room clips (`roomClips.ts`) whose **every** target node is under a hidden root stop being evaluated (`action.stop()`);
  shown again, they rejoin the room clock at the right pose. Clips that also move nodes outside the group keep playing.
- The walk graph (`navigation.ts`) is built once per room load, from the colliders in effect then: a toggle that is off
  when the room loads is out of it; flipping it live does not re-route walks until the next load. Keep anchors (`SPOT_*`,
  `CAM_*`, `PATH_*`, `DOOR*`) and real `LIGHT_*` spot / point fixtures **outside** toggle groups (they are placed at load
  and don't follow the toggle).
Rooms without toggles: nothing changes (no state key, no work per frame).

**Controls:** Scene tab → Room → *Room props* (one switch per toggle; only rooms that declare some) and Simple mode's
room card (*Room props* pills); `POST /api/scene/toggle {"id":"420","on":false}` (Stream Deck / scripts, localhost only;
`on` true / false / `"toggle"`, missing = flip); bus / MCP `send_command scene {"toggle":{"id":"420","on":false}}` (or a
list of them). The studio lists scene.json toggles right away and glb-only ones once its preview has loaded the room.
**Testing (test pages only):** `output.html?sceneTest=<room>&toggles=420:off` starts with the group hidden;
`vtpOut.scene.summary().toggles` (each toggle, on here, roots found) and `.clipsSkipped`; `vtpOut.scene.toggles.hidden`.
Unit checks: `npx tsx tools/toggles_unit.ts` (parsing, state stamping, clip skipping, occluder / collider lists).

# Stage modes: Talk · React window sizes · Gaming (+ registered modes) — src/scene/stage/*, shared/stage.ts

The Scene tab's **Show mode** bar switches what the stream is about: **Talk** (the room camera), **React** (watch
something together, with window-size presets) and **Gaming** (the game is the star, everyone is a live cam). Other
workstreams add modes (Interview, TTRPG …) by dropping files into a registry — see "Adding a mode" below.

| File | Role |
|---|---|
| `shared/stage.ts` | `SceneStageState` (`SceneState.stage`, host-owned, sanitised), `sanitizeModeBags` (`SceneState.modes`), the pure layout maths (`planReactFull`, `planReactMedium`, `planGaming`, `plan3d`, `resolveReact`, `resolveGaming`), room palettes |
| `src/scene/stage/modeCore.ts`, `registry.ts` | the mode registry (`registerStageMode`); `registry.ts` loads every `src/scene/stage/modes/*.ts` (import.meta.glob) |
| `src/scene/stage/modes/talk.ts`, `react.ts`, `gaming.ts` | the built-in modes |
| `src/scene/stage/compositor.ts` | the page layer (OBS pages of host + guests, Scene preview): plan → performer cams, capture rect, docks, morphs, hole reports |
| `src/scene/stage/tileCams.ts` | one camera per performer cam (bust / full body, framed on the real face + head top, any size class) |
| `src/scene/stage/frameFx.ts` | backdrop / hole / bezels / test pattern shader (two passes on the page's canvas) + the in-scene video quad |
| `src/scene/stage/stageDom.ts`, `supportStrip.ts` | name tags, docked chat (the chat monitor's canvas) + support (board canvas / wide strip), the line-up label |
| `src/scene/stage/freeSpace.ts` | 3D views: free space for the docks + the "rail" of cams, never over faces / the screen / visible chat props |
| `src/ui/stagePanel.ts`, `src/ui/stage/*` | Scene tab: mode bar, preset cards with layout thumbnails, live layout picture, docks, the capture helper (+ *Fit my capture*) |
| `shared/layoutLook.ts`, `shared/hud.ts`, `src/scene/stage/modes/fullscreen.ts`, `src/scene/stage/hud*.ts`, `src/scene/stage/hudElements/*` | the per-layout look of the screen-first layouts (cut-out / boxed cams, frame, opacities, dim, shadow + outline, size + corner) and the Full screen HUD layouts (data: capture, cams, HUD elements such as chat as text) — guide: [LAYOUTS.md](LAYOUTS.md) |

**State** (`SceneState.stage`, missing = defaults): `react` auto · full · big · medium · side; `gaming` auto · corner ·
strip-bottom · strip-top · column; `strip` s · m · l; `corner` bl · br · tl · tr; `cam` s · m · l; `framing` bust · full;
`backdrop` room · clean · cutout; `dock {chat, support}` auto · always · off; `lounge` (3+ in Gaming → the Gaming Lounge);
`loungeRoom` (default `gaming_lounge`); `order` (member keys in join order, host first — kept by the controller);
`back {sceneId, mode}` (where a room-moving mode came from); `hole` (the mode shows a passthrough hole); `test` (line-up
test until, epoch ms; guests convert the host clock); `content` (capture aspect: 16:9 default, 16:10, 21:9, 32:9, 4:3).
`SceneState.mode` accepts any registered mode id; pages that don't know it render Talk. Presets are remembered per room
(this browser).

**React window sizes** (`resolveReact`): *Auto* = 1 performer → Side, 2–4 → Big, 5+ → Medium (Big needs the room's SCREEN,
else Medium).
- *Side* / *Big*: 3D — the solo side screen / the room's big screen via CAM_REACT, the same shots as before. When chat,
  support or guests need space, the room shot is drawn at 80 % in the top-left (the camera's view is widened around it
  with `setViewOffset`, so the room continues to the edges) and the docks / cams take the free column and band. The OBS
  hole is the room screen's projected quad in that frame. Performers the React camera can't clearly see (off-frame, head
  < 3.5 % of the height, hidden by the room (BVH ray) or by someone else (capsule test), seen from behind) get a **rail**
  of cams in free space.
- *Big* never leaves an empty seat in front of the screen: the OBS page measures every performer's real bounds (big
  mascots / costumes) against the screen; anyone covering > 12 % of it gets a hint to the nearest free seat of the same
  pose where they'd cover ≤ 4 % (`stage.info().reseat`, reported to the studio). The host's controller walks them there
  (`reseatForBig`, also for the room summary's `reactBlock` spots) and remembers their own seat in `stage.reseat`; they
  walk back when React leaves Big (or the room changes). No free seat: they stay seated, the room render leaves them out
  and they get a cam (as before).
- *Medium*: the capture ≈ 63 % wide top-left, everyone clearly visible in a row under it (host first, 1.35× wider; 5+ = the
  host tall + a two-row grid), chat + support in the right column; alone: the host is the hero at the top right.
- *Full*: the capture as big as the docks allow (≈ 82 % wide), performers as cams in front of its bottom corners (host
  bottom-left; 3+ split into two clusters so the middle — subtitles — stays clear), chat + support in a column.

**Gaming** (`resolveGaming`): *Auto* = 1 → Corner cam, 2+ → Strip bottom. *Corner cam*: the game as big as the chat column
allows, the host's cam over a corner of it (corner, size S / M / L, bust or full body), a slim support ticker (76 px at
1080p) along the bottom beside the cam. *Strip bottom / top*: the game above (below) a strip of cams, host leftmost then
guests in join order, chat in the column beside the game, support a compact two-row box (112 px) at the column's end
(beside the strip with ≤ 4 cams, beside the game with 5+). Few cams don't leave the strip empty: a lone cam is wider (up
to 1.7 : 1) and few cams are centred under the game (the side column centres them vertically). *Side column*: cams
stacked down the left, the game in the middle, chat on the right, a slim support ticker right under the game. Support
alone in a column (chat off) = a card ≤ 220 px, never the whole column (`SUP_BAND / SUP_COL / SUP_CARD`). Behind the cams: *the room* (each cam
looks at its performer's seat), *Studio* (a clean gradient in the room's palette) or *Cut-out* (nothing: the avatar
stands on the game). With 3+ performers the host's controller moves the party to the **Gaming Lounge** (`enter` →
`{room, seats:'order'}`: host → SPOT_01, guests in join order) — the room-change curtain covers it; leaving Gaming
returns to `stage.back`. Entering / leaving Gaming in the same room plays the curtain too (the controller bumps
`curtain.seq`; pages cover, switch the layout under the cover, wait until warm, reveal — `output.ts coverMode`).

**Cams** (`TileCams`): one scissored render of the scene per cam (no render targets → no new shader variants, no
mid-show compiles; the light show and the environment apply as usual). Framing: the whole head (face centre + measured
head top + chin) ≈ half the cam's height, 8 % head room, bounded by 0.26–0.62 × the performer's shown height (face
measures vary between models) — micro / macro performers fill their cams alike. Direction: rooms with scene.json
`stage.tileCams: "front"` look straight at each seat (7° towards the middle, 6° down); other rooms reuse the talk
solver's direction for that seat (a validated shot, cached; at most one new solve per frame) and dolly in along it; a
desk / wall between the cam and the face first tries a slightly higher / sideways direction with a clear line (cached
per seat), else the cam is pulled in and the lens widened. Rounded bezels cover the renders' square corners; the host's
is gold with a crown on the name tag; a speaking performer's bezel glows (TV guests: their audio `runtime.level`).
**Post effects in composite frames** (Full / Medium / Gaming): at High / Ultra the cams render into the post chain's
HDR target (`Graphics.renderComposite(fill)` → `Pipeline.render(…, fill)`): bloom (emissive gain), colour grade / LUT,
HDRI lighting and SMAA apply; the depth-based passes (N8AO, DOF, haze, god rays, SSR, glow, vignette) are skipped —
every cam has its own camera, so one projection can't read the depth buffer. The backdrop, bezels, capture and the OBS
hole are drawn on the canvas after the chain, so the hole stays exactly alpha 0. Balanced / Performance / Classic draw
the cams straight onto the canvas as before; the gfx auto level still steps down on the page's GPU timer.
`stage.info().perf.post` = the last frame went through the chain.

**Chat + support always on screen**: composite layouts dock them (the in-world chat monitor / board / Sprocket step
out: `StageCompositor.runtimeState`). 3D views keep the in-world rigs; a docked panel appears only after the rig has not
been readable for 1.2 s of a settled shot (and leaves 0.6 s after it is back), in free space (right / left column for
chat, a corner card for support), never over a face, the React screen, a cam or a visible chat prop. Dock modes:
*Auto* (chat while chat is in use — events or a platform live; support also with a goal / support this session),
*Always*, *Never*. Panels: the chat monitor's canvas (text ≈ 18.5 px at 1080p × **Chat text size** — Scene tab, 60–160 %,
`stage.chatText`; the in-world chat monitor keeps its own size) and the support panel (`supportStrip.ts`, one renderer
for every dock shape): wider than 4.5 : 1 = a ticker (plate, goal bar, the latest supporters as chips; alerts take it
for 8 s); short (≤ 150 px at 1080p) = a compact two-row box (plate + goal bar, then the latest supporters; an alert =
name + amount, then label / message); else (columns, corner cards) = a card: plate, goal bar, supporters in 1–3
columns, alert card. Names shrink to 72 % before they are ever shortened (then "…"); card alert names wrap onto two lines.

**Names on screen** (Scene tab → *Names on screen*): *My name* (every room) and *In this room* (an override for the
current room) — this browser remembers them (`localStorage vtp.stage.myName`) and the host's controller puts the one in
effect into `stage.names['@host']` on every room change; the host can also rename a guest's cam tag (`stage.names[key]`,
empty = the name the guest chose). Every OBS page (host + guests) uses `stage.names` for the cam name tags in every
layout, else the party name, else the avatar's name (`output.ts stageName`).

**OBS**: the composite capture rect is an axis-aligned rectangle in the capture's aspect → a Window / Game / Display
Capture fits it exactly (Transform → Bounding Box "Scale to inner bounds", Alignment Top Left; the numbers are in the
Scene tab). The hole closes while a layout morphs and reopens once settled; OBS pages POST `/api/obs/hole` with
`layout: 'stage'` and the `mode`: the OBS automation moves the capture only for React (as before); other modes' holes
are only recorded. *Fit my capture to the layout* (Scene tab → Game / Window capture; `POST /api/obs/fit {source, rect,
fit: 'fit' | 'fill'}`) sets that one item's transform (+ crop-to-bounds for Fill) — only when clicked, also with the
automation off (needs the WebSocket password) — and reports order / hidden / aspect / 0×0 problems. `server/obs.ts` no
longer hides the capture or switches OBS scenes for modes with their own hole (Gaming). **Line-up test** (`stage.test`,
12 s): every OBS page draws a see-through grid + crosshair in the hole and a pink edge on its border.

**Control**: Scene tab mode bar; studio keys **Shift+T / R / G** (each mode's `key`), **Shift+< / Shift+>** = previous /
next preset of the current mode. Bus / MCP `scene {mode, stage: {react, gaming, strip, corner, cam, framing, backdrop,
dock, lounge}, lineup}`; `POST /api/scene/stage {mode?, react?, gaming?, …, lineup?}` (Stream Deck, localhost only).

**Adding a mode** (no edits to shared files): `src/scene/stage/modes/<id>.ts` calls `registerStageMode({id, label, icon,
order, key?, camera?, curtain?, hole?, chat?, enter?(ctx) → {room?, seats?}, exit?, page?: {plan?(ctx) → StagePlan | null,
attach?, detach?, update?}})` (import it from `../modeCore.ts`); its Scene-tab presets go in
`src/ui/stage/panels/<id>.ts` (`registerModePanel(id, (app, S) => element)`); its settings in `SceneState.modes[id]`
(plain JSON ≤ 6 KB, re-validate it when reading). Full spec: the stagemodes workstream's MODE_REGISTRY.md.

**Walking-TV guests** (`assets/builtin/tv_performer`, PERFORMER_API v2): the compositor registers a subject hook
(`setTileSubjectHook`, `tvOfActor(actor).faceInfo()`) so every cam, the rail and the Big-screen checks frame the TV's
screen like a face. Scene tab → Gaming → *Webcam / VTube Studio guests: show their picture* (`stage.tvFeed`) draws the
guest's live picture (`tvFeedMaterial(key, {fx: 'tv'})`, chroma-keyed for VTube Studio) full-cam instead of the 3D TV.

**Hooks for mode pages** (`ModePageCtx`): `performers[i].speak` (0..1, this page's last frame), `onBus(fn) → off` (the OBS
page's bus; absent on local previews), `curtain.test(target, style)` (play a title card / curtain). `page.update` runs
after every room engine's update and before the frame is drawn.
`page.keepOut?(ctx) → Rect[]` (fractions of the frame, called every frame after `update`): screen areas the docked chat /
support must NEVER cover (Interview: the monitor's picture, projector screens, the faces on the show; the show-open card =
the whole frame). The compositor adds them to the free-space search as hard keep-outs AND checks the drawn docks every
frame, moving cameras included: a dock that would touch one is re-placed at once, falls back to a ticker strip / a small
card along the top or bottom edge (`searchFreeSpace({ticker: true})`), or hides instantly (no fade over a screen); a dock
tween never sweeps across one (it snaps). `vtpOut.stage.info().keepOut` shows them.

**Gaming Lounge** (`assets/scenes/gaming_lounge`, built by `blender/gl_room.py`; `-- --live` builds it in a visible
window): eight gaming chairs in an arc (SPOT_01 = host, far left; each chair its own accent colour), a big wall SCREEN
with a backlight, hexagon light panels, acoustic foam, shelves, neon, a sofa corner (SPOT_09–12), a streaming desk, a
door on the right wall; `scene.json stage: {tileCams: "front", palette: "lounge"}`.

**Test pages**: `output.html?sceneTest=<room>&mode=gaming|react&react=…&gaming=…&strip=…&corner=…&camsize=…&framing=…
&backdrop=…&docks=…&lineup=1&content=<aspect>`; `vtpOut.stage.info()` (plan, capture, cams, rail, docks, faces, cost),
`vtpOut.shownState`.

# Interview mode (talk show) — src/scene/talkshow/*, shared/talkshow.ts

A stage mode (mode bar → 📺 **Interview**, Shift+I; registered through `src/scene/stage/modes/interview.ts`): the host
at a talk-show desk, guests on a big in-set **monitor** ("live via satellite") or in the guest chairs, Sprocket as the
sidekick / bandleader for reaction shots, a show-open title card, and an **auto-director** that cuts on whoever is
speaking. Style inspiration: late-night cartoon talk shows — nothing of any real show (names, logos, characters, music)
is used. Settings are the host's stage-mode bag `SceneState.modes.interview` (`sanitizeInterview`), so every OBS page of
the host and of every party guest shows the same show; each page runs its own director on the voices it receives.

| File | Role |
|---|---|
| `shared/talkshow.ts` | the bag (guests, layout, director, pace, cut / show-open counters, title, sidekick, video source, meter) + sanitiser, shot ids, pacing, `ROOM_SETS` (per-room theme / monitor style / guest chairs / band stand), `roomInterviewConfig` |
| `src/scene/talkshow/engine.ts` | `InterviewScene`: builds the set, places guests, panels, voices → director → shots → `SceneRuntime.cameraOverride`, the OBS hole, the show open |
| `layout.ts` | automatic set layout from the host's chair: desk in front (if the floor is free), monitor beside the host (turned ~40° to them, box free of the room / COLLIDE_* / seats, host + a front camera see it), sidekick on the other side |
| `props.ts` | generated set pieces per theme: the desk (bowed front, show-title plate, desk mic + themed props), monitor housings (retro TV on a chrome pedestal, crate-top CRT, field-radio CRT, hanging menu board, clinical terminal), band stands (keys / drums) |
| `monitor.ts` | `TalkMonitor`: the picture (up to 3 panels + overlay: lower thirds, LIVE bug, stand-by bars, a show-title 4th cell), power-on, arrival, the settle-gated OBS hole; style `skin` wears the room's own screen skin (scrying mirror, hologram, TerraGroup display, custom `SOLO_SKIN`) |
| `remote.ts` | "remote studios": a performer guest on the monitor is moved to a small themed set 2.6 km below the room and rendered into a panel texture (every other frame, only while the monitor is on screen) |
| `shots.ts` | the shot book: establishing, host single, guest on the monitor / a panel, over-the-shoulder, two-shot, sidekick, push-ins, snap zooms, reverse — solved from the set geometry, scored with room rays (key points hidden, camera in geometry / behind a wall, void, obliquity, other heads cut by the frame, clutter at the lens) |
| `director.ts` | the auto-director (pure logic; `tools/talkshow/director_sim.ts` runs it offline, `tools/talkshow/director_score.ts` scores it: see **Director v3**) |
| `cueShots.ts` | cue v3 on a page (pure): the pose of a `wide` cue (room camera / audience / asker), the crane and pull moves, a late page's move progress |
| `crowd.ts` | the crowd collector (pure): chat laughs, cheers, raids, gift trains, "Answer now", applause, the show open → the events `director.event()` takes; bursts merge |
| `src/ui/stage/interviewCrowd.ts` | studio only: listens on the bus (chat, support events, the audience engine's view) and feeds `crowd.ts` |
| `voice.ts` | voice levels: each performer's rendered `mouth.speak` (wraps the actor's runtime update on this page), video guests from the studio meter |
| `sidekick.ts` | Sprocket (or a chosen avatar) at the band stand: follows the speaker, nods, laughs on punchlines |
| `bumper.ts` | the show-open curtain style `talk-open` (marquee bulbs, the title, tonight's guests), played with `Curtain.test` |
| `src/ui/stage/panels/interview.ts` | Scene tab sub-panel, hotkeys, the Stream Deck command, the video-guest voice meter, the OBS fit button |

**Line-up** (`bag.guests`, in order; shared/talkshow.ts `planLineup` says who is where): up to **2 co-hosts** and **4 guests**.

**Co-hosts** (`role: 'cohost'`, cohost workstream): a party member (avatar, walking TV, or a `lib:` stand-in in previews) who
sits with the host — the local host is always the main host. The page seats them (SceneRuntime.spotHook, chained with the
projector hook): **at the desk beside the host** — `layout.ts planSet` scans the host's sides (10 cm steps from ~0.9 m,
scaled by the room's person height; the side away from where the monitor wants to be first) for free floor, uses a room
chair that is already there (same pose, facing the same way, never a guest chair), else a generated seat (spot index 80+,
popped in, with a themed swivel chair when the host sits — props.ts `buildChair`); the generated desk grows to seat
everyone (a mic per person) when the floor allows. No free floor: the nearest room chairs facing the same way (the host's
pose first). scene.json `interview.cohosts: ["SPOT_xx", …]` pins them. The monitor avoids standing where a co-host blocks
the host's view of it / the front camera's view; the sidekick keeps clear of co-hosts, guest chairs and the monitor. A
change in the number of co-hosts re-plans the set (the sidekick model is kept when its place is the same). A projector-
screen TV co-host has no body to seat: they show on the monitor. Shots: `cohost1` / `cohost2` (their single), `hosts`
(host + a co-host, a medium two-shot), `panel` (everyone at the desk), `ots` / `reverse` over / of a co-host
(`via`). The director cuts to a co-host who speaks (sometimes the hosts shot), hosts talking over each other → hosts /
panel, listener reactions include co-hosts. Green room: a co-host sent back remembers slot + role and comes back a co-host.

**Guests** (≤ 4; the monitor shows ≤ 3 panels — a 4th monitor guest who has a body sits in the studio, ≤ 3 video guests;
Guest N counts guests only): `performer` (a party member — their live avatar; RAM only, model custody unchanged), `video` (a webcam /
call guest: the host's shared window drawn on the panel — Scene tab → React screen → Pick a window, cropped to their tile
with `crop` — else an OBS passthrough hole), `tv` (a walking-TV performer, src/scene/tv — detected automatically: on the
monitor their live picture with their own chroma key + backdrop (`tvFeedMaterial` rendered into the panel, `tvFeed.ts`) while
their TV body waits in the remote studio; seated, the TV sits in the guest chair; their mic level (`tv.level`) drives the
director and reaction beats play their `laugh` / `react_shock` clips via `tvReact`; `registerGuestFeed(fn)` in engine.ts
lets any other kind of performer hand in a feed texture). Layouts: `monitor` (everyone on the monitor: 1 = full picture, 2 = side by
side, 3 = 2×2 with the show card in the 4th cell) or `seated` (party guests in the set's guest chairs — the mode's
`enter` / the panel's button seat them; video guests stay on the monitor).

**The OBS hole** (video guests without a shared window): a fixed Window Capture can only line up with ONE shot, so a
hole panel opens (alpha 0, after the camera settled) only in that guest's close-up; every other shot shows an "on the
line" card behind their lower third. The panel's *Fit my Window Capture → name* button (explicit click only) POSTs that
close-up's rect + corners to `/api/obs/place` (server/obs.ts `placeAt`; the corner-pin shader assumes 16:9 content, so
retro 4:3 monitors fit the box exactly and pin approximately). That close-up is turned a touch towards the host, so
without the corner-pin the capture gets the closest OBS box (unlike a React hole, it is still shown: the click asked
for it) and the answer says how many px its corners are off.

**Director** (`auto`). ONE director, in the host's studio (`src/ui/stage/interviewHost.ts`, host / solo, never an
observer studio): it measures every voice first-hand, decides, and sends each cut + a heartbeat a second as a **cue**
(`shared/talkshow.ts InterviewCue`; bus command `interview {cue}` to this PC's OBS pages, party wire `ivcue` relayed to
guests' OBS pages). Pages follow the cue (`InterviewScene.cue`, `director.follow`), so every page cuts the same shot at the
same moment and a reloaded OBS source joins the running show; without a cue for 2.5 s a page directs itself with the same
code. Two studio windows: the lower bus id leads, the other says so in its panel.
- **Who is talking** (`talkshow/activity.ts`, fixed 20 Hz steps): a performer's mic level (`speak`) against an adaptive
  noise floor (the 5 s minimum, rising over ~2 s, kept ≥ 0.2 under the peak right after real speech so a held vowel or a
  shout isn't swallowed; a fan or a music bed is absorbed in ~7 s) and an automatic gain;
  the camera mouth counts ONLY without a mic, with low confidence, and only by its movement in a syllable rhythm
  (open-close ≥ 2× a second: a head turn, wink, smirk or held vowel doesn't count), never by how open it rests (a mouth
  that rests open read as talking for 9 minutes in a real show); a mic whose envelope follows a video caller's call audio
  while the mouth stays still is the call leaking into the mic (ignored); the mixer's gate shut = silent.
- **Video callers**: their voice from an audio input the host picks per caller (the call app through a loopback / virtual
  cable, or one of the audio mixer's sound inputs); none = *voiceless*: presumed to talk while everyone with a voice has
  been quiet ≥ 1.5 s (several voiceless callers: the whole monitor, subject `gv`); the guess ends the instant a real voice
  starts, and the cut back to them comes once the voice has SOUNDED 0.45-0.7 s (scaled with the pace), not a turn lag + minimum hold; a voice that stops within a second took the camera for nothing and the presumed caller is back on air at once. A page that directed itself while the
  cues were away takes the studio's shot back on the next heartbeat; a late, older cue from the same studio is ignored. A caller behind the capture cover
  ("Jacking in…") or without the shared window it needs is not on the show yet (never the speaker).
- **Cutting**: voice hysteresis (on after 0.18 s above 0.34, off after 0.9 s below 0.17); the floor goes to whoever has
  talked ≥ `turnLag`; a new speaker is cut to once the current shot is ≥ `minHold` old (calm / normal / snappy: 3.6 / 2.6 /
  1.7 s holds, 1.6 / 1.2 / 0.8 s turn lag); overlaps (both making sound within the last 0.6 s — a turn's
  hangover after its last word is not cross-talk) → two-shot / establishing (monitor-only guests: over the host's
  shoulder towards the screen), never ping-pong; long answers → a slow push-in, a listener's reaction, another angle; a
  laugh / a beat after a ≥ 2.5 s turn → a reaction (the sidekick laughs along, the laugher, a snap zoom); silence ≥ 4.5 s →
  a wide or a cutaway (never host + guest 1). **No shot stays longer than `cap`** (18 / 13 / 9 s) without a reason: the director moves on to the next shot
  that fits, at the next gap between words (≤ 2.5 s more). With guests only on the monitor the host + screen two-shot
  (an empty armchair in the middle, both small) gives way to over-the-shoulder / the caller's screen, and the shot solver
  keeps empty guest chairs out of the middle of every frame (`SetGeom.empty`). Choices are seeded (`seed` + cut count).
- **Live controls**: a hotkey / button cut (`cutSeq`) is taken at once and held ≥ 4 s; `manual` = only the operator's
  cuts; **📌 Pin this shot** (Ctrl+Shift+P, Stream Deck `interview` shot `pin`, `{"pin":true|false}`) = the manual director
  on the shot on air; **🎤 Guest's turn** (Ctrl+Shift+G, `turn-guest` / `turn-host`, `{"floor":"guest"|"host"|"g0"…}`)
  cuts to them and keeps them as the speaker ~25 s (until someone else clearly takes over); pace (`pace-calm` …,
  `{"pace":"snappy"}`). The panel's **🎬 Live director** box shows the shot on air, WHY, how long until it moves on, and
  who it hears (mic / call audio / mouth / guess, and what it ignores: a mouth resting open, the call in your mic) —
  studio only, never on stream. Offline: `tools/talkshow/interview_vod_sim.ts` (the 2026-10-08 show as scenarios,
  `--pipeline legacy|new`), `tools/interview_director_unit.ts`.

**Director v3** (lane `ivdir`, 2026-10): the auto-director was rebuilt around what the shows measure. Every rule is a named constant at the
top of `director.ts`, every choice seeded (`seed` + cut count: `rnd(k)`; no clock, no `Math.random`), so the studio, the OBS pages and a
page that directs itself pick the same shot at the same moment. All of it is deterministic at any frame rate (fixed 20 Hz steps).
- **Hand-overs**: a *clean* hand-over (the holder silent ≥ 0.2 s after a ≥ 1 s turn, nobody else sounding, the newcomer did not talk
  over them) takes the floor after `PACE.fast` (0.5 / 0.4 / 0.3 s of talk) instead of `turnLag`; the shot on air then needs only
  `max(MIN_ON 1.2 s, 0.6 × minHold)` (or `MIN_ON + 0.3` when it went up before the newcomer began). *Anticipation*: after a host turn
  of ≥ 1.5 s `expect` = the only guest / the addressee of a chat question / the last guest who held the floor (30 s): they take the
  floor in 0.75 × fast. *Retract*: a fast cut to a voice that stops within 1 s while the holder resumes is taken back after `MIN_ON`.
  No automatic cut leaves a shot younger than `MIN_ON` (operator cuts, `floor()` and the studio's cues are exempt). A real voice
  after a *presumed* caller is a clean hand-over by definition; one that stops within 1 s sends the presumed caller back on air.
- **Rapid banter**: ≥ 2 hand-overs of lines ≤ 3 s inside 8 s hold the shot of THOSE people (host + guest → the two-shot with that
  guest, host + co-host → `hosts`, two guests → `two` with `via`, host + call-in → over the shoulder, 3+ → the table: house wide /
  establishing) instead of ping-pong; a line > 3 s or 2 s of silence ends it.
- **Laughs are reactions**: a burst from a listener while the holder sounds (or within 0.2 s of their line) is a laugh / interjection
  — never a turn, never cross-talk (cross-talk needs both voices sounding now, ≥ 60 % of the last second, both turns ≥ 1.2 s). The
  camera goes to the laugher 0.35 s after it starts (0.9 s while the holder carries on: a "mhm" never cuts), the shared shot when
  several laugh, held 1.2-3.0 s while the laughter lasts; a listener's face every 15-25 s of a turn ≥ 6 s, at a word gap. **When a
  reaction cutaway ends** the camera goes back to whoever holds the floor: the speaker while they sound, else a voice that sounds now
  and has for 0.6 s (the host who chimed in over the end of an answer), else — unless someone is just starting, or rapid banter is
  going on (the pair / the table takes over) — the speaker through the pause between two phrases (`PHRASE_PAUSE` 1.0 s since their last
  sound). Only a table with nobody talking gets the quiet wide: one put up under a voice stayed up for the rest of the sentence (3-5 s
  with the talker off screen; 35 of 57 such cuts in 36 scripted seated shows, now 6 of 17 — all of them real silences of a second or more
  before the talker resumes or a newcomer starts; scorecard M23).
- **Rhythm**: holds are jittered (minHold × 0.85-1.2, cap × 0.8-1.0, reaction lengths), the last 8 shots are remembered: a shot of
  the last 3 is not welcome, one that would repeat a 3-shot sequence seen in the last 60 s is not welcome, a key used in the last 20 s
  counts 0.3; a listener whose own single left the air < 8 s ago is shown from another angle (host: over the guest's shoulder; guest:
  over the host's; co-host: the desk). Push-ins: from the speaker's own single, turns ≥ 8 s, once per subject per 60 s, not in banter.
- **The room's cameras** (`shared/talkshow.ts roomCoverage(scene.json)`, the same answer in the studio and on every page; none → the
  room is directed as before): `house` (CAM_HOUSE), `audience` + `sections` (scene.json `audience.camera` / `sectionCams`), `broll` (=
  `interview.cutaways` minus the audience cameras and the house wide), `band` (a BAND / STAGE / SIDEKICK cutaway: the sidekick's shot
  becomes that camera), `jib`. `interview.coverage` overrides any key. A wide may be the house wide; at most one b-roll cutaway per
  45 s of conversation; the wide family (wide, establishing, cutaways, the audience) at most 20 % of the last 60 s; dead air from 4.5 s
  is a wide / cutaway, a new one every 4-8 s, never host + guest 1.
- **The crowd on camera** (`crowd.ts` + `interviewCrowd.ts`, studio only; the director stays the one decider): ≥ 3 different chatters
  laughing inside 2.5 s within 3 s of a line → the audience's reaction (`wide` + `aud: 'r'`, a section camera) 0.35 s later for 1.6-2.8 s
  (12 s apart; no audience: the sidekick or a listener); a cheer of $20+ (`cheerSize`), a raid of 10+, the 5th gift of a train (one event
  per train), crowd applause → the house applauds (`wide` + `mv: 'pull'` on the audience or the house wide, 3-4 s; one per kind per
  25 s, 5 s between kinds); never in the first 3 s of a turn, never over a laugh or another crowd shot (a plain listener's nod gives
  way), never over an operator hold or the floor. "Answer now" → the asker's close-up (`aud: 'a'`, `ak` = a hash of the asker) for
  2.5-4 s while the host reads (the audience engine rejects a stand where a prop hides more than 10 % of the head + card box — `cams.ts
  askerPoseClear`: another stand, else none, and the page then shows the audience wide), then the host; the guest the question names (display name or "guest N") is what the host's read
  expects: on camera before they speak. *The think*: after a short host turn (≤ 10 s) and `PACE.think` s of silence the person who has
  to answer is on camera before they speak (once per 30 s). *Show open*: the host's single by `mv: 'crane'` 3.5 s after the card starts
  (when the curtain clears); a guest who arrives is shown in (house wide / the two-shot, then their single).
- **Owner switches** (Interview panel, bag `crowdCuts` / `roomCams`, default on, stored only when off): *Cut to the chat audience* (laugh waves, big cheers and raids, "Answer now") and *Use the room's own cameras*
  (house wide, cutaways, band camera). `reactions` / `pushIns` / `snaps` keep their meaning. The panel / Stream Deck (`audience`,
  `house`) / Ctrl+K get **Audience** and **House wide**: a `wide` cut carrying `bag.aud` / `bag.cam`.
- **Cue v3** (`InterviewCue`; there are NO new shot ids — a v3 shot rides on an existing id
  plus optional, sanitized fields, and a field that does not fit its shot is dropped, never the cue):

  | v3 director shot | cue | v3 page | older page (e61ef210 sanitizer) |
  |---|---|---|---|
  | house wide / cutaway | `wide` + `cam` | that room camera (the room wide if the room lacks it) | the room wide |
  | audience reaction | `wide` + `aud: 'r'` (+ `cam` = a section camera) | the section camera, else the audience's reaction pose, else `cam`, else the room wide | the room wide |
  | asker close-up | `wide` + `aud: 'a'` + `ak` | the asker (only for that question), else the audience wide | the room wide (its own page-local asker close-up may still show) |
  | guest pair | `two` + subject `gA` + `via` `gB` | the two guests | host + guest A |
  | crane in | `host` + `mv: 'crane'`, secs 0 | `CRANE_SECS` 3.5 s down onto the host from 1.2 m higher and 2 m back | a plain cut to the host |
  | applause pull | `wide` + `mv: 'pull'`, secs 0 | `PULL_SECS` 2.5 s dollying back 1.5 m, 1.6× wider | a plain cut to the room wide |

  `v: 3` marks a v3 studio (room events still come first); `ac: 1` says that studio's director cues the asker's close-up itself — only
  then does a page following the cue drop the audience engine's own "Answer now" close-up (`askerStandsDown`); a room whose audience the
  studio cannot see (AUDIENCE_SEAT_xx / AUDIENCE_AREA_xx nodes in the GLB, no scene.json `audience`: three of the installed rooms) or the owner's *Cut to the chat audience* switched off sends no `ac`, and the page's own close-up shows as in v2;
  `sk` carries the studio's sidekick decision; `at` (how long ago the cut was taken) makes a page that joins late start a timed move
  that far in (`CameraRig.go(pose, secs, arc, from, t0)`), so a page reloaded 3 s into a push-in shows the pose of one that saw the cut.
  A studio that sends v2 cues (no `v`) keeps the old page behaviour exactly.
- **Subathon extras**: a gift train that reaches 10 gifts adds a **montage** (two or three of the audience's section cameras, ~1.2 s each,
  after the applause of the 5th gift; once per 60 s); a huge alert (a $100+ cheer, a raid of 50+) runs the **snappy pace for 30 s**
  (`director.pace`); **the take**: the crowd laughed, the teller stays silent 0.8 s → the host's snap zoom for 1.5 s (rare: 120 s apart;
  Stream Deck / API `take` = `{"shot":"snap","subject":"host"}`). `studioCamFor(scene.json, cam | pos)` (shared/talkshow.ts) maps a shot to
  the physical studio camera (`studioCams.cameras[]`: the preset's name, else the lens within 0.5 m) and its tally fixture
  (`LIGHT_TALLY_x`) — a pure function every page derives from the cue; **lighting the tally is NOT wired** (the lighting system has no
  per-light override; that is the lighting owner's change).
- **Game-show hooks** (`DirectorOpts.profile: 'talk' | 'game'`, default talk): the event kinds `buzz` / `reveal` / `win` / `lose` / `clock`
  are on the same event queue; only `buzz` has a rule (the contestant's single within one fixed step, 1.5 s hold); the rest are queue
  stubs for the game set. The talk profile ignores all of them (a unit proves the same cuts with and without).
- **Pages**: the director runs on the wall clock (the page clamps a frame to 0.1 s; a self-directed page under 10 fps ran the show slow —
  one held a shot for 50 s in the e2e; `InterviewScene.update` feeds the director the unclamped dt, which it caps at 2 s); a cut to the
  same person from nearly the same place (< 30°, < 1.4× the field of view, < 1.5 m) becomes a 0.6 s move (`cueShots.softCutSecs`, a
  pure function of the two poses; operator cuts stay cuts); **no flights**: a timed move that is not a named crane / pull and would carry
  the camera > 1.5 m is a cut (`cueShots.noFlight`). **Gaze (go/no-go)**: the studio has the host's head yaw and gaze
  (`TrackingFrame.head`, `.gaze`) every frame, so a "cut to who the host looks at" is possible — NO-GO tonight: which yaw means "looking
  at the guest's screen" depends on where the webcam stands, so it needs a per-set calibration step first.
- **Shot book**: the room-camera pool of the two-shot / panel / wide drops a camera that looks down on the faces > 35° or stands > 2.5 m
  above them (unless nothing else is left); the guest-pair two-shot; a screen in a two-shot faces the lens; an over-the-shoulder is not
  the guest's single camera (scored 6 for being it).
- **Scorecard** (`npx tsx tools/talkshow/director_score.ts [--assert] [--baseline] [--pace calm,normal,snappy] [--seeds 7,11,23]
  [--only seated2,video1] [--room latenight|plain] [--stage p0|p1|p2] [--why m1a,m10b] [--trace <lineup>:<pace>:<seed>:<t0>:<t1>] [--out <dir>]`):
  13 line-ups × 3 paces × 3 seeds = 117 scripted shows (`tools/talkshow/score_scripts.ts`: show open + an arriving guest, a monologue
  with crowd laugh waves, back-and-forth with addressees, a 75 s story with backchannels and a mid-story laugh, rapid banter, a group
  laugh, dead air, a chat question, a call-in, alerts, "the think") with ground truth, run through the studio's exact pipeline
  (`InterviewVoices` → `InterviewDirector` at the 10 Hz tick + the crowd events), ~25 s of CPU. It scores handover latency and
  coverage (M1), banter coverage (M2), chasing cuts (M3), flash cuts (M4), laugh coverage (M5/M6), reaction rhythm (M7), airtime per
  family and dead air (M8), hold spread and 3-shot loops (M9-M10), the two-shot partner (M11), alerts (M12), the chat question and
  the think (M13/M14), cuts per minute (M15), shot variety (M16), hold statistics (M17), false fast cuts (M18), determinism (M19: two
  runs hash alike; the cue stream followed at 30 / 60 / 144 fps and jittered gives the identical on-air sequence), v2 compatibility
  (M20: every cue through the frozen e61ef210 sanitizer, `tools/talkshow/fixtures/sanitize_v2.ts`) and no-op cuts / flights
  (M21/M22) and a wide under a voice (M23: a house / establishing wide on air while someone ≥ 1.5 s into a line is off screen; wides made
  for the room — alerts, cheers, the crane, arrivals, cutaways, the banter table, cross-talk, a long answer's other angle — are no miss).
  `--baseline` runs the frozen e61ef210 director (`fixtures/director_v2.ts`) beside it. Definitions live next to the rows in
  `director_score.ts`; the notes `--why` prints are the misses, a few lines per show.
- **Not verified in a browser yet**: the engine glue (`poseFor` for `cam` / `aud`, `resolveOnAir` moves and the jump-cut softener, the
  wall-clock dt, the asker stand-down), the
  crane's start on a real curtain, the call-in over-the-shoulder with the host's shoulder in frame, the visible caller push and the
  headroom from the avatar's bounding top — the CPU suites cover the pure parts (`tools/interview_director_unit.ts`,
  `interview_guests_unit.ts`); `interview_cam_e2e.mts` / `interview_room_probe.mts` on a COPY of a late-night set (cutaways, an audience, a house camera) are the browser gate.

**Chat + support never cover the screens**: the mode's `keepOut` hook hands the compositor the monitor's picture (its live
corners, every panel), projector screens and the faces on the show each frame (hard keep-outs, see Stage modes → Hooks);
the in-world chat monitor / board / Sprocket's tablet step out for the whole mode (`chat: 'docked'`); shots about the
monitor (guest, panels, push-ins, snap zooms) always leave ≥ 11 % of the frame height clear above or below the picture
so the ticker dock has a place; the show-open card hides the docks while it is up.

**Control**: Scene tab → mode bar → Interview (panel: title, show open, layout, the line-up — "At the desk with you"
(co-hosts) and "Guests", each with ★ Make co-host / Make guest, where (guests), ↑ / ↓ order within the role —, director,
pace, reactions, push-ins, snap zooms, shot buttons incl. each co-host / guest by name + Hosts / Panel, sidekick, video
source, per-caller voice input, OBS fit). Live Control: the camera switcher shows Host, each co-host, each guest (named),
Hosts / Panel, Two-shot, Wide; the People tile has Guest | Co-host and In studio | On monitor per person. Stream Deck:
`interview` shots `cohost1`, `cohost2`, `hosts`, `panel`, `guest1`…`guest4`; `interview-role` {who: member id / guest1 /
cohost1, role: toggle / cohost / guest}; `guest-place` takes a member id too. Ctrl+K: "cut to cohost 1", "hosts shot",
"panel", "make guest 2 co-host", "co-host 1 back to guest". Studio hotkeys
Ctrl+Shift+1…9 = establishing, host, guest, over-the-shoulder, two-shot, sidekick, push-in, snap zoom, reverse;
Ctrl+Shift+0 = auto; Ctrl+Shift+B = show open. Stream Deck / scripts: `POST http://127.0.0.1:5191/api/command`
`{"command":"interview","args":{"shot":"guest"}}` (or `{"bumper":true}`, `{"director":"auto"}`) — the host studio applies it.

**Room data** (scene.json `interview`, all optional; the built-in `ROOM_SETS` covers the shipped rooms):
```json
"interview": { "theme": "studio", "host": "SPOT_01", "desk": "room",
  "monitor": { "style": "tv", "width": 1.35, "position": [x, y, z], "yaw": -38, "side": 1 },
  "guests": ["SPOT_02", "SPOT_03"], "sidekick": { "stand": "keys", "position": [x, 0, z], "yaw": 20 },
  "cutaways": ["CAM_KITCHEN"], "shots": { "host": { "pos": [x, y, z], "target": [x, y, z], "fov": 30 } },
  "coverage": { "house": "CAM_HOUSE", "band": "CAM_BAND", "jib": ["CAM_JIB_HIGH"] } }
```
`cutaways` are the room's b-roll cameras the director may cut to (with the scene.json `audience` cameras and a `CAM_HOUSE` it forms the
room's coverage, see Director v3); `coverage` overrides a key (`house`, `audience`, `sections`, `broll`, `band`, `jib`) when the automatic
guess is wrong.
`desk`: `"room"` (the room's own desk), `"none"`, a place `{position, yaw, width}`, or missing (a generated desk when
the floor in front of the host is free). `monitor.style`: `tv`, `crt`, `fieldcrt`, `menuboard`, `terminal`, `holo`,
`skin` (the room's own screen skin). Positions left out are found automatically (layout.ts).

**Cost** (measured, private test pages): `InterviewScene.update` ≈ 0.5–0.8 ms average, ≤ 2 ms peak (after the first
frame); the set layout 10–90 ms once when the mode starts (under the transition curtain); each shot solve 1–8 ms, one per
frame ahead of time; a performer guest on the monitor = one extra small render (≤ 1024 px wide) every other frame while
the monitor is on screen. Tests: `output.html?sceneTest=<room>&mode=interview&extra=robot,skyisles`, then `vtpOut.debugScene({...vtpOut.sceneState, mode: 'interview', modes: {interview: {guests: [{kind: 'performer', key: 'lib:robot', name: 'Robo'}]}}})`;
`vtpInterview.debug()` (set notes, shot on air, director log, cost), `vtpInterview.voice.test = new Map([[key, level]])`
simulates voices on test pages — shaped like speech (uneven syllables, a gap between words: a flat level is a fan to the
speaker detector and is tuned out after ~10 s). `tools/interview_room_probe.mts` runs a room author's check (seated
avatar guests, host → guest 1 → guest 2 → overlap → quiet) with the cut log and a contact sheet.

**The set's real cameras** (`talkshow/shots.ts` lenses): a seated person's single first tries their seat's own camera
(`SPOT_xx_CAM`), the two-shot / establishing / panel the room's 10 nearest `CAM_*` presets and scene.json
`studioCams.cameras[].lens` points (a studio room's camera props) — only those in front of the talent (the 72° cone
singles keep to, also from the first framed face: never the host's back or profile), re-aimed, the lens zoomed to the shot's framing, scored like any candidate with a small preference
(−0.3). Only the best two are then checked hard (`lensClear`, count-bounded): nothing within 4 cm of the lens; nothing in
the first 0.4 m of the view (a shell / a prop right in front — a camera body behind the lens, the prop it stands in, is
fine — and the framing guarantee's 7 cm lens check, for that exact room-camera position only
(`GuardRequest.lensBehindOk`), counts just the surfaces in front of the lens, so a pedestal / PTZ body 5 cm behind it
doesn't veto it); nothing, either side of any face, between the lens and each key point (a wall the renderer culls from behind still
means the camera is outside the set); and the prop test below. **A prop in the foreground** (`foregroundBlocked`): 3+ of
a 5×5 grid of view rays meeting something above the floor in the near part of the view (≤ 45 % of the way, ≤ 3.5 m) —
the set's own desk / chairs / monitor housing don't count. The solver's own scoring is unchanged; for the wide shots its
6 best angles get the prop test (≤ 150 rays) and blocked ones sink below the clean ones (also in the pool the framing
guarantee takes alternates from). Cold solve cost, measured: within ~1-5 ms of the solver alone (wide shots 9-31 ms in a
prop-heavy studio, 9-12 ms in the kitchen).

## Projector-screen guests — `src/scene/tv/tvProjector.ts`, `projectorPlace.ts`

A TV guest whose look is `projector` (their choice, or the host's override in `SceneState.modes.tvguests.looks`) is a
`ProjectorRuntime` actor: its "body" is a pull-down screen in the room's own solo-screen skin (`rt.skins.solo`,
screenSkins.ts: unroll / drop / rise / hologram …) hanging from the ceiling above its spot, the live picture (tvScreen.ts,
fx `projector`: chroma key, no scanlines, fabric grey while off) and a name plate. It is still a performer: a synthetic
spot (index 100+) under the screen (`SceneRuntime.spotHook`), popped in (no walk), scale locked to 1, and the picture is
its face, so talk / group / tile cameras and the shot solver frame it.
- **Placement** (every page computes the same): scene.json `projectorScreens: [{ position: [x, y, z] (screen centre,
  room space), yaw (deg), width }]` → nodes `PROJECTOR_01…03` → automatic: beside the host (1.2–4 m, both sides,
  camera-left preferred because the solo react screen comes in camera-right), centre 1.62 m above the floor, facing the
  wide camera. A spot is rejected when it is outside CAM_WIDE's frame, not visible from it, cut into walls / colliders, on
  someone's spot, in front of any face or the react screen, or overlapping another projector as the camera sees it;
  several screens hang side by side. Checked in 10 rooms with 1–3 guests.
- **Modes**: Talk — `SceneRuntime.focusHook` cuts the Talk camera to a projector guest after 0.7 s of speech (held ≥ 3 s,
  back to the host's pick after 2.5 s of silence; `modes.tvguests.cut`); group shots include the screens. React presets and
  Gaming tiles show them like any performer. Interview: a projector guest listed on the show goes on talkshow's monitor
  and their screen stays up. TTRPG rooms: the screen hangs near the table.
- **Walking-TV motion** (`TvInfo.motion`, host override `modes.tvguests.motion`): calm by default — the tvart clips (v2:
  already near-still idles) with body / hips / head motion at 75 %, antennas at 50 %, talk gestures at 45 % and only on
  real speech (loud for ¼ s), no idle_bored, no entrance hop; lively = 150 % of the authored clips, full gestures, bored
  idles, the hop. The grey-box stand-in has the same two settings.

## Room picker: worlds, tables, test rooms — `src/ui/roomPicker.ts`, `src/ui/roomWorlds.ts`

The studio's room picker (Room area, Scene tab, the room helper) shows rooms as picture cards (`thumb.png`, else
`preview.png`) grouped by **world**, with search, ⭐ favourites, a Recent row and a big gallery (⤢). Optional scene.json keys:

- `"world": "Tarkov"` (or `"group"`): the group the card sits in. A known world name or alias (Studio, Kitchen,
  Gaming Lounge, Tarkov, Gray Zone, Helldivers, Star Citizen, Path of Exile, Last Epoch, Tabletop) joins that group; any
  other name makes its own group. Without it the id prefix decides (`eft_` → Tarkov, `gzw_` → Gray Zone, `poe2_` → Path
  of Exile, `sc_` → Star Citizen …), else "More rooms".
- `"test": true | false`: hide the room behind **Show test rooms** (or force it visible). By default grey boxes / test
  yards / `*_test`, `*_v2`, `*_wip` ids are test rooms.
- TTRPG tables (`ttrpg.of: "<room id>"`, or the parent's `ttrpgRoom`) never get a card of their own: they show as a
  **🎲 table** chip on their room's card, which opens the table through the TTRPG stage mode (the party walks over,
  closing the table walks everyone back). The generic table (`ttrpg.of: "*"`) is a card in Tabletop.
- Rooms with **areas** (see "Areas") are one card with area chips; picking a chip moves to that area.
- The card's name drops the world ("Gray Zone — Crimson Camp" → "Crimson Camp"; "Customs — Dorms Lounge" shows
  "Customs" small above "Dorms Lounge"), and its badges come from the room's features (`kitchen`, `space`, `raid`,
  `eras`, `environment`, `town`, `crowd`, `traffic`, the `gaming` mode).

Favourites / recents / the test switch are per browser (`vtp.rooms.*` in localStorage).

# Slap! (the host's minion knocks someone over) — src/scene/slap/*, shared/slap.ts, src/ui/slapPanel.ts

The host presses **🖐 Slap!** (Scene tab → 🖐 Slap!, **Shift+S**, or a Stream Deck / script:
`POST http://127.0.0.1:5191/api/command {"command":"slap","args":{"target":"random"}}` — target `random` (a guest when
there is one), `host`, a member key or a name; optional `"model"`): the minion runs in, winds up, jumps and slaps the
target, who is **knocked over** (≈ 2.6 s, then back on tracking), bows or dusts off its hands and runs off — ≈ 5 s.
Cooldown: the next slap can start once this one is over.

| File | Role |
|---|---|
| `shared/slap.ts` | the bag `SceneState.modes.slap` (`{model, sound, ev: {seq, at, target, seed}}`, sanitised), the clock (`SLAP_T`: impact 2.0 s, hit-stop 0.09 s, total 5.2 s, lead 0.9 s), `slapTau` (hit-stop folded in), `slapRand`, `pickSlapTarget`, `shiftSlapClock` (guests) |
| `src/scene/slap/slapScene.ts` | page side (OBS pages, preview, test pages): plan, minion choreography, knock-down, camera, effects; reports its sounds to the studio (real OBS pages only) |
| `src/scene/slap/minion.ts` | the slapper avatar (loaded like the chat buddy: own library, no costume, never saved, not a party member; missing → Sprocket), run cycle (locomotion.ts) + gag layer (crouch, jump, lean, bow, twist, arm IK, face) |
| `src/scene/slap/slapFx.ts` | SLAP! card, impact burst, stars, the dazed ring, puffs; reports punch / thud sounds to the studio (played there: CC0 Kenney, `/api/trail/sfx/…`) |
| `src/ui/slapPanel.ts` | Scene tab section (target picker, **Slapper** model: *Same as the chat buddy* / any library avatar, sounds), Shift+S, the bus command |

**Sync**: the host's studio resolves the target (random → a key) and stamps `ev` with `at = now + 0.9 s` (its clock); guests'
controllers shift `at` into their clock (like the walks). Every page plans the same choreography from (room, target,
seed) and samples it at `now − at` — a page opened mid-gag lands mid-gag; an old event (cache/scene.json) is ignored.
Pages preload the slapper once the host has used slaps (the lead covers the first load).

**Plan** (once, ≤ a few ms of room rays): everything lives in the **target's mount space** and the minion + effects hang
under the target's mount — so they show wherever that performer is drawn: the room, their **cam tile** (stage layouts
isolate a tile to its performer's mount; other tiles never show the minion) and the interview's **remote studio**.
- *Room framing*: the minion stands beside them on the camera's side (never behind them), else the other side, else in
  front; it runs in along a lane from **off-screen** (preferred) checked for floor all the way, room rays at knee +
  chest height, COLLIDE_* boxes, other performers, and never across the React screen / its OBS hole. When the slapper
  is the chat buddy's model and Sprocket is roaming in the room (or the interview sidekick is on the band stand), **he**
  runs over from where he is (he steps out of his chat job for the gag and is back when the minion returns). The side
  that has a way in wins; the minion must be **seen** (room ray from the lens to its head) and never stand in front of
  anyone's face. Floor beside them out of sight (a desk / console / bar between it and the lens) → it hops onto the
  furniture top beside them (poof), else it **leaps up beside the face** from behind the furniture (out of a puff), like
  in a cam tile. A valid floor place without a lane → a poof beside them.
- *Close framing* (bust cam tiles, guests on the interview monitor, performers the 3D React shot doesn't show — they
  are on a rail cam): the minion leaps into their frame from low at the side, slaps, bows in the frame, hops back out;
  the card sits just above their head.
- Jump height: the slapping hand reaches the cheek (capped at 1.7 × the minion's height — a giant gets it on the knee).

**Knock-down** (target): a procedural fall **on top of the tracked pose** (the actor's lift is rotated about a pivot at
the foot on the far side, after the room placed them; nothing is stored): standing → falls sideways away from the slap,
bounces, lies dazed (a ring of stars), gets up with an overshoot, back on tracking ~2.6 s after the hit; seated → tips out
of the chair onto the floor, then sits back; micro → a mid-air spin back to the perch; large / macro → a slower, heavier
fall (bigger shake); quadrupeds fall on their side. A wall / furniture / a neighbour in the way limits the fall (they lean
on it); in React the fall never sweeps over the screen. Humanoids also get a head snap + flailing / flopping arms through
their runtime's pose hook (tracked face / expressions keep running — the performer's real reaction shows). **Walking
TVs** play their `tumble` clip + a burst of static; **projector guests'** screens swing on their cables + static.

**Camera**: Talk — when the target isn't clearly in the shot, a cut to their talk shot (widened) for the gag; Interview —
a cut to the show's own shot of them (host single, their monitor close-up, their chair) — never while a video guest's
passthrough hole is open (the monitor hole stays shut during the cut); React (3D) and composite layouts — no cut. At the
impact: hit-stop, a snap zoom (−12 % fov) and a short shake — never with a React screen down or a hole open.
**Effects**: the SLAP! card sits beside the face on the minion's side — else the other side, else above the head,
whichever covers nobody's face, pulled fully into the frame, never over an OBS hole (no card rather than that) — impact
burst lines, stars off the cheek, puffs (kick-off, skid, landing, poofs); sounds (host setting): real OBS pages send
them to the studio (`{type:'showsound'}`), which plays each once (audio mixer → Room sounds).
**No hitch on a live page**: once loaded the slapper's shaders are compiled in the background (`compileAsync` with the
room's lights), its textures uploaded, and it is drawn for one frame invisibly small (the first draw builds its
morph-target / bone data, ~0.1 s) — with the room load, under its curtain, whenever the host has used slaps before (the
bag persists). Its materials are marked for the light show (performerLight.ts) so riding under a performer's mount never
triggers a recompile. Measured (RTX 5090, 1080p test page): the gag itself adds no frame over 12 ms; the very first
slap on a page that never had one loads the model during the lead (≈ 0.1 s + 0.1 s once).

**Tests** (test pages only): `output.html?sceneTest=<room>&extra=robot,skyisles` then `vtpOut.slap.test('<key>' | 'random',
seed?, delayMs?, atEpochMs?)` (two pages given the same `at` play the same gag), `vtpOut.slap.manual = true;
vtpOut.slap.clock = <epoch ms>` + `vtpOut.step(n)` for frame strips, `vtpOut.slap.debug()` (plan: kind, framing, entry,
side, jump, fall limit, cut, notes). Cost: nothing between gags; during one ≈ one extra avatar update + a few sprites.


# Music styles (room-agnostic light choreography) — shared/lightStyles.ts, src/scene/lightShow.ts, src/ui/lightStylesPanel.ts

A **style** drives every show fixture of a room (its `LIGHT_*` fixtures / `EMIT_*` groups) as ONE spatial canvas instead
of per-group pulsing: at load every fixture gets its place in the room, normalised over all fixtures (left → right,
back → front, low → high, angle + distance around the centre), so the same style reads right in any room. Each style
has a layer per music section — **groove / build / drop / breakdown** (from the beat clock: `buildup` → build,
`drop` / `chorus` / the 16 beats after a detected drop → drop, `breakdown`) — an **accent** layer for signs + neon,
its own palette (steps every 8 bars and on drops) and the effects-rig moves it wants (moving-head motion + laser look per
section). Practical groups (lamps, ON AIR, lava, aqua) keep their own programs. Every white hit / strobe goes through the
photosensitivity gate.

Patterns (`styleEval`): `sweep` (a band L → R per bar), `pingpong`, `twin` (both walls to the middle), `scanner`,
`spiral` (angle around the centre), `centerout` (rings out on every kick), `wave`, `rain` (ceiling → floor), `bounce`
(floor → ceiling), `kickstrobe`, `snarestrobe`, `blackout` (dark between hits), `callresponse` (left on 1 & 3, right on
2 & 4), `alternate` (odd / even), `stack` (fills across the bar, resets on the downbeat), `sparkle` (random fixtures on
the hats), `build` (rising level, 1/4 → 1/8 → 1/16 pulses + a quickening sweep), `breathe`, `heartbeat`, `wash`. Colour
modes: pair (A → B along the pattern), split (left A / right B), alt (odd / even swap per beat), rainbow, police
(red / blue halves swap), mono, b, phrase (A / B per phrase).

24 styles in 5 categories (Signature: Neon Rave, Neon Tide, Hopscotch · Sweeps: Laser Sweep, Ping-Pong, Twin Chase,
Scanner, Spiral Galaxy, Neon Rain · Strobes & hits: Kick Hits, Blackout → Hit, Strobe Storm, Shockwave, Heartbeat,
Police · Colour: Rainbow Roll, Phrase Wash, Call & Response, Stack & Drop, Floor to Ceiling · Moods: Half-time, Sunset
Drift, Glitter, Afterglow). **Auto** picks one every 16 bars and on every drop from the music's energy class (moods in
breakdowns / low energy, sweeps + colour in grooves, hits + shockwaves in bangers) — deterministic from the beat grid, so
every page agrees.

State (`SceneState.lights`, sanitised): `style` ('' = off / classic programs, 'auto', a style id, 'u:<n>'),
`userStyles` (≤ 12 saved: name, base style, palette, speed), `styleOpts` {speed 0.5–2, strobes, states it drives —
default preshow / show / outro}; a look may carry its own `style` ('none' = off). SHOW uses it only with Beat reactive on
(or music), PRESHOW / OUTRO always (their built-in auto show when there is no music input).

Scene tab → Lights → **Music styles**: live mini previews on a virtual 12 × 4 rig (the same maths, a 40-beat demo
arrangement), click = use, ▶ = preview in the Scene preview only, Auto / Off, speed, strobes, which states it drives,
**My styles** (save the current one with a name + palette, use, delete). Stream Deck: `POST /api/scene/lighting`
`{"style":"neon_rave"}` (also "auto", "off", "u:0"; may be combined with `"state"`); bus / MCP `scene {lightStyle}`.
Old style ids still work everywhere (`STYLE_ID_ALIASES`: `frog_rave` → `neon_rave`, `neon_swamp` → `neon_tide`,
`lily_pad` → `hopscotch`), so existing Stream Deck buttons, saved scenes and "My styles" keep loading.

**Support celebrations as lighting cues** (`BeatLights.cues`): `cue('donation' | 'tip')` two gold sweeps, `'sub'` a
rainbow roll burst, `'bits'` a sparkle burst, `'raid'` blackout → red / pink rings + a white hit, `'big'` three gold
shockwaves + a white hit (overlaid on any style or program, gated). The chat alerts call `cue('donation')`; the club
engine calls the specific ones. **Moments** (`BeatLights.moment(kind, secs)`): `'ball'` (mirror ball + its spots, house
down), `'lasers'` (a laser burst), `'drop'` (a scripted drop hit). Getters `houseLevel` / `washPalette` let background
characters dim with the room. Cost: light engine ≈ 0.1 ms / frame with a style on 140 fixtures.

# Floors: multi-level rooms — src/scene/floors.ts

Hidden meshes named `FLOOR_*` (stage tops, stair ramps, balconies, risers; contract.ts hides them, they are never drawn
or ray-tested by the cameras) give the walk mover heights: a walker stands on the highest `FLOOR_*` surface under it
(one downward ray per walker per frame), so walks climb stairs and step onto stages instead of gliding at y 0 and popping
up at an elevated spot; the follow camera's `samplePath` gets the same heights. Rooms without `FLOOR_*`: unchanged.
Keep nobody walking UNDER a floor (the highest surface wins). First user: the Studio Club.

# Chat audience (chatters in the seats, !ask questions, supporter name effects) — src/scene/audience/*, shared/audience.ts

Everyone active in chat sits in the room's audience with their **name above their head**; viewers ask questions with
`!ask` (or a paid message) that a moderator approves before they show **above the asker's name**; supporters' names get
**effects** (Patreon and other members, subs, tippers, VIPs). Works in any room that declares seats (Interview mode
included); rooms without seats but with a background crowd put the names over the crowd's dancers.

## Room convention (for room builders; glTF space: metres, +Y up, stage front +Z — all optional)

| Node / key | Meaning |
|---|---|
| `AUDIENCE_SEAT_xx` | Empty = one seat. Origin = the floor point under the sitter (a stander's feet). The node's **+Z faces the stage**. extras: `pose` `"sit"` (default) / `"stand"`, `seatHeight` (m above the origin, sit, default 0.45). |
| `AUDIENCE_AREA_xx` | Empty **or a box mesh** (hidden while the audience is attached) = a block of seats filled automatically. Origin = the centre of the block **on the floor** (a box: its bottom face); +Z faces the stage. extras: `w` (width, along local X), `d` (depth, along local Z; a box gives both from its size), `spacing` (seat pitch, 0.62 m), `rowGap` (row pitch, 0.9 m), `rise` (each row back is this much higher: bleachers, 0), `pose`, `seatHeight` (0.45), `stagger` (true: odd rows shift half a seat), `rows` (cap). The front row is the one nearest the stage (the local +Z edge); rows run backwards from there. |
| `CAM_AUDIENCE` | (optional) A camera looking at the audience from the stage: reaction shots and the director hook. Without one a pose is derived (above the stage focus, fitting the seated people). |
| scene.json `audience` | `{ "on": true, "seats": [[x, y, z, yawDeg, "sit" or "stand"], …], "areas": [{ "center": [x, y, z], "yaw": deg, "w": 6, "d": 2.7, "rise": 0.35, … }], "camera": "CAM_AUDIENCE", "height": 1, "max": 400 }` — the same without a GLB rebuild (`yaw` in degrees; 180 = facing −Z). `"on": false` turns the audience off in that room. |

**Seat order** (what makes every page seat a chatter in the same place): front row first, then outwards from each
block's centre line (stage-left before stage-right at equal distance), blocks interleaved by row; single seats are
grouped into rows by their distance to the stage focus (the centre of the room's `SPOT_xx`). The server hands out
**slots** (0 = the best seat, kept until the chatter leaves); slot *i* sits in seat *i*. A room seats at most 400.
**Fallback:** no seats + a scene.json `crowd` (ACTIVITY_xx `dancefloor` dancers) → names, bubbles and question cards
ride the crowd's dancers (ordered the same way: nearest the stage first); the setting *Names over a crowd* turns it off.
**Test fixture:** `assets/scenes/audience_test` (bleachers `AUDIENCE_AREA_01–03`, a balcony of `AUDIENCE_SEAT_01–04`,
`CAM_AUDIENCE`; built by `build_audience_test.py`). Sizes that read well: 0.62 m seat pitch, 0.9 m rows, 0.35 m rise.

## Who sits there (server: server/audience.ts; pure core: shared/audience.ts)

* Chat commands go through `server/chatCommands.ts`, a registry: `addChatCommand(name, fn)` → unsubscribe; several
  handlers per name run in registration order and the first that returns true consumes the line (false falls
  through); `addAnyChatCommand` handlers (the renamable `!ask`) run after the named ones. `!ask` only consumes a line
  it queued, and can't be renamed to `vote`, a number or another feature's command (`RESERVED_COMMANDS`).
* Every chat line (commands too, through the `server/chatCommands.ts` taps) seats its sender when the audience is on
  and they are eligible: *Who gets a seat* = everyone / subs, members + patrons / supporters; bots, *Never seat* names
  and the broadcaster are left out. *Stays in the audience* (`keep`): **The whole stream** (default, `'stream'`): nobody
  leaves over time; a new stream starts fresh (OBS going live after 30 min or more not live / closed, when OBS is set up
  in VTube Pro: people quiet for 30 min or more and every test chatter leave, `AudienceRoster.newStream` — a quick
  restart or an OBS crash keeps everyone; otherwise anyone quiet for 6 hours, `SESSION_GAP_MS`); or `'minutes'`: a
  chatter leaves `windowMin` minutes after their last message (supporters twice as long). Test chatters ("+40 test
  chatters") always leave after `windowMin`, and give up their seat first. Settings saved before `keep` existed get the
  whole stream.
* At most `max` (default 80, ≤ 200) in the audience. **Seats the room shows vs the bench**: each live OBS page (this PC,
  or a paired stream PC) posts its room's seat (or crowd place) count to `POST /api/audience/seats` on attach and every
  30 s (`AudienceScene.seatCount`); the biggest report of the last 75 s is `AudienceRoster.cap()` (none = `max`). Slots
  below it are seats the room has; slots from it up are the bench: kept in the audience, not drawn. A newcomer takes a
  free seat, else the seat of someone quiet for ≥ 90 s (who moves to the bench), else waits on the bench; a benched
  chatter who talks again comes back the same way; free seats are refilled from the bench (askers on screen first, then
  the most recent). A supporter's tier keeps lurkers off their seat only while they spoke in the last 30 min
  (`TIER_HOLD_MS`). A smaller room coming on benches people instead of dropping them; the bigger room shows them again.
* Changing *Never seat* or *Who gets a seat* unseats the people it no longer allows at the next prune (at once on save,
  else within 10 s). A full queue (`AskQueue.MAX` open questions) never evicts a question still fading out.
* **Take down** (studio panel / Chat Hub drawer, on the on-air row and on a question still fading out after Done): off
  stream at once, no fade (`skip`).
* An asker whose question is **on screen** (on air, the next `cards` approved / pinned, or fading out after Done) keeps
  their seat: never timed out, never given to a newcomer, trimmed last (`AudienceRoster.protect` = `AskQueue.stageKeys`).
  Pending questions show nothing and hold no seat.
* Support events seat their supporter too (supporting = taking part).
* Bus: `{ type: 'audience', s: AudienceView }` on change only (≤ 3 / s): members `{k, n, p, c, s (slot), j, t (tier)}`,
  the questions **on stage** (approved / pinned / answering — pending text never leaves the server), applause, every
  known supporter's tier (for the chat box) and the look settings. Pages that open mid-show `GET /api/audience/view`.
  RAM only: nothing about chatters is written to disk (the settings are: `config/audience.json`).

## Questions (!ask)

* `!ask <question>` (the command is renamable; *Who can ask*: everyone / subs, members + patrons / supporters / only
  paid / off; mods may always ask). The line is consumed (never shown in chat); one open question per chatter (a new
  `!ask` while pending replaces the text and keeps its place); a cooldown after it was answered or skipped.
* `!axe <question>` asks exactly like `!ask`: *Also works as* lists the command's other names (default `!axe`, at
  most 4, the same naming rules; empty = none). They share the queue, the filters, *Who can ask* and the cooldown.
* **Paid** (off by default): a tip / Super Chat / bits … of at least `minUsd` with a message becomes a question (only
  messages starting `Q:` when *Only "Q:" messages* is on; Twitch cheermotes are stripped); priority 100 + $. A tip from
  the same chatter within `bumpMin` minutes of their `!ask` **bumps** it (+50 + $, shows the amount). A message the
  platform hid never becomes a question.
* **Identity:** people, supporter tiers and questions are keyed by the platform's stable user id when the connector
  knows it (`ChatEvent.uid`: YouTube channel id, Twitch user-id, TikTok uniqueId, Kick user id), else by the display
  name. A tip bumps a question only when the ids match; the same name without ids is a *possible match* the moderator
  confirms ("Same person" / "Not them"). Display names go through the word filter on the server: a blocked name shows
  as "viewer" (seats and cards).
* **Moderation:** by default every question is *pending* until a moderator approves it (studio Scene tab
  "👥 Chat audience + questions", the Chat Hub's ❓ drawer, the Stream Deck); the owner can switch on **Show questions
  without approval** (a question goes up at once unless the filter held it back).
* **The filter** (`filterText`, shared/audience.ts) is structural. A SCAN copy decides: invisible / bidi characters
  out, NFKC, lower case, every combining mark (any block) out, look-alike letters folded, every dot shape a dot,
  enclosed / parenthesized / squared / negative / regional-indicator letters and digits folded (a table generated from
  the Unicode blocks), "evil (c) (o) (m)" read as "evil.com". A link
  = a chunk + any separator run (not apostrophes / hyphens / emoji) + a real-link TLD; everyday-word TLDs (gg, lol, me …)
  only after a dot shape or with a space before the dot; spoken dots (dot, punkt, punto, ponto, kropka, точка, дот);
  schemes, www, punycode; spaced-out letters joined. Words: the blocklist + a built-in slur list, leetspeak folded,
  5+ letter roots also inside words, allowed words (built-in + **Allowed words**) blank only their own span. The SHOWN
  text keeps its letters (marks capped at two), obvious links cut out; anything the scan copy still sees holds the
  question back / hides the bubble / makes the name "viewer" (**Always show these names** rescues a name). Accepted
  trade-off: "hey...lol" is held. Owner switches **Word filter** and **Remove links** (default on, never re-enabled on
  an update) turn either off for names, bubbles, questions and emote names (the panel says which, in one sentence;
  control / bidi characters are still removed for drawing safety). Switches and lists apply to what is ALREADY on
  stream: names and open questions are filtered again from what was typed (kept in RAM) on every settings save —
  switching a filter on takes a card down / turns a name into "viewer" at once, switching it off brings the typed text
  back. Fuzz-tested (tools/audience_unit.ts).
* **Filter — known limitations** (the owner has the off switches and the mod queue for the rest): it is a heuristic, not a
  guarantee. Not caught: 4-letter roots glued inside a longer word ("xxcoon"), letter-spaced 3-letter roots between
  longer words, images (emotes / stickers are pictures, never read), slurs in languages the built-in list doesn't
  cover, a link split across two messages, a domain on a TLD missing from the list, leet digits in a TLD ("evil.c0m":
  "S2.E5" and "bmw.m3" are everyday chat). Held although harmless (accepted):
  "hey...lol"-style dots straight before a TLD word, a 2+-letter dot-spelled word ending in a TLD ("n.o.p.e").
  Switching a filter off again re-shows a question that the filter took down as a plain approved card (approval off):
  its pin / "answering" state is not restored. Bubbles already on screen keep the filtering they were made with (they
  last seconds).
  A held question shows "Hidden" with **Skip / Delete**; **Show anyway…** shows its text, then **Allow** lets it be
  approved like any other. A message deleted in chat drops its pending question (an approved one comes off stream); a
  purge / ban drops the chatter's seat and questions (by platform user id when known: shared/chatRemove.ts is the one
  removal rule for the hub ring, the OBS chat feed, the studio relay and the Chat Hub).
* States: pending → approved / pinned → answering → answered, or skipped (`AskQueue`). *Next question* = pinned first,
  then priority, then oldest; *Answer now* works from any open state (it approves).
* **On stream:** approved questions (up to `cards`, default 2, plus the one on air) float as cards above the asker's
  name (paid ones in their tier colour) and the asker raises a hand. **Now answering**: the card grows ("NOW
  ANSWERING"), the asker stands in a spotlight and waves, and (setting *Close-up of the asker*, default on) the camera
  cuts to them for 7 s. *Overlay card*: a clean lower-third card on the OBS page — `auto` (default) only when the asker
  has no seat in this room, `on` always, `off` never.
* After **Done** / **Next** the answered card stays up for `AskQueue.LINGER_MS` (6 s), reading **ANSWERED** (no glow;
  full size only while nobody else is on air), and fades out over the last 1.5 s while the asker sits back down; the
  overlay card does the same only for the question it was showing. **Skip**, a chat delete, a ban or the filter holding
  it back take a fading question down at once (`AskQueue.live`). The view carries those as status `answered` (at most 2,
  newest first); the server pushes again when the linger ends; pages compare times on their own clock (`view.at` skew).

## Name effects (Patreon and others)

Tiers, strongest first: **Top patrons**, **Big patrons**, **Patrons & members** (Patreon and other membership-style
supporters: Fourthwall / Ko-fi / Buy Me a Coffee members; the ladder is monthly $ `plusUsd` 10 / `topUsd` 25 or tier
names), **Subs & channel members** (platform subs / members / founders, badges), **Tipped this stream** (≥ `tipperUsd`,
default $5), **VIPs**, **Moderators** (off by default). Per tier: on, name colour (or their own), glow, badge (crown,
diamond, gem, heart, star, bolt, shield), sparkle trail (sparkle / hearts / stars / embers; 3D only), gentle pulse (3D
only). *Picked by hand* gives anyone a tier by chat name (works before any Patreon link exists).
The supporter source is a local `SupporterLookup` (`SupporterBook`: SupportEvents + badges, session only); the support
lane's `shared/supporters.ts` `supporterOf()` plugs in with `setSupporterLookup()` (server/audience.ts) and wins where it
knows the chatter; its SupportEvents go to `audienceOnSupport(ev)` (from then on the chat 'finance' lines are not read a
second time). Effects apply on the 3D name tags AND the chat box: `src/chat/nameStyle.ts` is the one hook the chat
renderers call (`styleNameEl` in src/scene/stage/chatText.ts; `nameStyleFor` / `beginName` / `endName` in
src/chat/chatCanvas.ts); with no audience view every call is a no-op.

## Reactions (pure functions of the view, the chat events' timestamps and the wall clock: every page shows the same)

Idle sway, glances and blinks (seeded per chatter) · their message: a bob, a mouth flap and a speech bubble (links
stripped, a blocked word / hidden link hides it, a length cap, emote names filtered too — a failed emote image draws a
neutral chip, never the typed name; a message deleted in chat takes its bubble down at once; `!commands` never). Speech
bubbles are **off by default** (they are chat text with no moderator: the streamer opts in) · laughs
(LUL / KEKW / LMAO / 😂 …): lean back, shake, a "HA", and the neighbours chuckle (contagious at *Reactions* ≥ 0.7) ·
support by size (thresholds ÷ *Reactions*): the supporter jumps under confetti; under $5 their neighbours clap, $5+
everyone claps, $20+ everyone cheers arms-up and half stands, $100+ a stadium wave sweeps across the seats with room
confetti · applause (Stream Deck / panel): everyone claps for 4.6 s · a waiting question: a hand up · joins pop up from
the seat, leaves wave and shrink (a newcomer in the same seat waits for the leaver).
Names: one dark pill per chatter in their colour (or their tier's), 15–34 px tall at 1080p at any distance; *Tidy names*
hides names that would overlap (people talking, asking or supporting always win); names, cards and bodies never cover a
performer's face (bodies only when they are nearer the lens than that performer).

## Camera hook for directors (src/scene/audience/cams.ts)

```ts
import { audienceShots } from '../audience/cams.ts';
audienceShots.request()   // { kind: 'asker', key, since, until, priority: 2 } for 7 s after "answer now";
                          // { kind: 'reaction', since, until, priority } after a $20+ cheer (3.5 s) or applause (3 s); else null
audienceShots.pose(kind, aspect)   // CamPose (world) for 'asker' | 'reaction' | 'wide'; null = no audience in this room
```
The interview director (talkshow) may cut to these on its own terms (e.g. a reaction cutaway while `request()` is set
and the current shot is ≥ minHold old). Until it does, the audience engine itself takes the asker close-up through
`SceneRuntime.cameraOverride` (installed at room attach, so the interview engine — which consults the previous override
first, like a room event — shows it); the setting *Close-up of the asker* off = never.

## Studio, Stream Deck, tests, cost

* Studio: Scene tab → **👥 Chat audience + questions** (`src/ui/audiencePanel.ts`: the queue first, then ⚙ Settings,
  name-effect previews and test buttons — "+40 test chatters", "Test !ask", "Test paid question", "Test tip", "Test
  laugh": local test events through the real chat hub, never sent anywhere). Chat Hub: **❓ Questions** (the queue).
* Stream Deck (group *Audience*): Applause, Next question, Question done. HTTP: `/api/audience/*` (server/audience.ts).
* Test page: `output.html?sceneTest=audience_test&audienceDemo=80[&audienceAt=<s>]` (the scripted demo: the real
  roster + queue on the page); `vtpOut.audience.info()`, `.demo.at(s)`, `.scene.testCheer(key, usd)`,
  `.scene.testChat(key, text)`, `.look([x,y,z], target, fov)` / `.shot('asker' | 'reaction' | 'wide')`.
  Unit tests: `npx tsx tools/audience_unit.ts`; headless proof: `node tools/audience_e2e.mjs --out <dir>` (a private
  server + Vite, muted Chrome: the story shots, 8+ angles, a contact sheet, frame time with the audience off / 80 / 200).
* Cost: all instanced — the bodies ≈ 16 draws for any number of people, every name ONE draw, particles 2, + one draw per
  visible bubble / card. Measured (audience_test, 1080p, High, RTX 5090 headless, 2026-10-09): audience off / 80 / 200
  people = +0 / +9 / +6 draws, +0 / +39k / +97k triangles, the audience's own update 0.02 / 0.43 / 1.0 ms CPU (peaks
  0.1 / 0.7 / 1.5), the page's JS per frame 3.2 / 3.6 / 4.4 ms, GPU 1.2 / 1.4 / 1.5 ms. No per-frame allocations in the
  hot loop; name-tag attributes upload only when they change, the name atlas at most 4× a second. Free in rooms without seats (or a crowd) and while
  nobody is seated.

# Mass crowd + club activities — src/scene/crowd/crowdMass.ts, crowdClub.ts

- `ACTIVITY_xx` extras `activity: "dancefloor"` (+ `rx`, `rz` ellipse, `frogs` count × the graphics level's NPC density,
  `outfits`, optional named point `_FACE`, extras `keepOut: "x,z,r;…"`) = a dense instanced crowd: the unit is skinned
  once per clip frame at load (time-sliced ≤ 4 ms / frame, ~1–2 s) into half-float vertex-animation textures (body LOD1,
  face, each outfit in use), then every dancer is one instance per part (≈ 9 draws for 60 dancers, ≈ 0.04 ms CPU / frame).
  Clips (dance, jump, handsup, headbang, fistpump, shuffle, sway, cheer, clap, idle) run on the beat clock (the whole
  floor bounces in time), chosen per 4-bar phrase by energy; drops → everyone jumps; support → cheers; room engines steer
  dancers through `CrowdScene.massOverride` (push / face / clip / hide) and every dancer is hidden while it would cover
  a performer's face or the react screen.
- New activity kinds (`EXTRA_PLANS`): `bartender`, `barflies` (stools, extras `sit`), `bouncer` (`_GRAB` `_DOOR`
  `_EXIT`), `stage` (podium / lift dancers, `_EDGE` `_LAND` `_STEPS`), `floorbits` (conga loop `_P01…`, `_RING`,
  `_SURF` / `_SURF2`, the sign carrier), `vip`. They read the club engine's bit schedule + support events from
  `PlanCtx.ext.club`. Support events now carry their finance kind (`Support.kind`).
- The crowd dims with the house lights and takes the show's colour wash (club looks); restored on detach.

# Club engine — src/scene/club/*, shared/club.ts, src/ui/clubPanel.ts

A room with a scene.json `club` key (`djSpot`, `balconySpot`, `bigMin`, optional `areas: {dj: {host, guests[]},
balcony: {…}}`) and `CLUB_*` anchors (see assets/scenes/my_room/README.md) gets: the LED wall shader (LED dots,
5 beat-synced visuals, the logo / supporter names / a chat ticker from a small canvas redrawn only on change), the
background-bit schedule (`clubSchedule`: slots of 50 s / freq, seeded), support celebrations mapped from chat finance
kinds (`clubKindOf`: tip / sub / bits (Kicks, Jewels) / raid / big ≥ bigMin), effects (confetti cannons, CO2 jets, spark
gerbs, indoor fireworks, air-horn rings, sliding drinks, juggled bottles, a champagne tower, the sign + chant labels —
all pure functions of the event's age), the stage lift, the mirror ball, the exit door, the DJ pose layer at the DJ spot
(`djPose.ts`: arms on the decks, scratching / faders on the beat, a headphone cup to the ear, fists up on drops; face
tracking untouched) and the host's entrance camera (`hostFlow.ts`: booth → crowd → stairs → drone → a crane-up reveal
into the balcony talk shot, from the mover's own timeline through `cameraOverride`; never in React). Air horn / bass
drop sounds are synthesised (WebAudio, no files) in the STUDIO when `club.sound` is on: real OBS pages send each event
(`{type:'showsound'}`), the studio plays it once (audio mixer → Room sounds); output pages are silent.

State `SceneState.club` (host-owned): `bits`, `freq`, `seed`, `djHands`, `sound`, `bigMin`, `entranceCam`, `events`
(≤ 8 host stamps for tests / remote triggers). Controller: `setClub`, `clubEvent(kind)`, `clubArea('dj' | 'balcony')`
(moves the host — and present guests — between the areas; taking the balcony plays the entrance). Scene tab → **Club**.
Stream Deck: `POST /api/scene/club {"event":"raid"}` / `{"area":"balcony"}`; bus / MCP `scene {club: {…}}`.
Test pages: `&club=tip@2,conga@4`, `vtpOut.club.scene.test('big')`, `.testBit('bouncer')`, `vtpOut.club.debug()`.

# Areas: several locations in one room — shared/roomId.ts, src/scene/areas.ts

A room can hold several places the host picks between — a yacht's grand foyer, its bar, the dining room, the observation
deck — in ONE `scene.glb` + `scene.json` (first user: `assets/scenes/sc_890jump`). Each area behaves exactly like its own
room, so every system (cameras, walk-ins, chat props, stage modes React / Gaming / Interview / TTRPG, raid / space / crowd /
traffic / kitchen / yacht engines) works per area without knowing about areas.

**scene.json** (the room's own keys are shared; an area's entry overrides any top-level key for that area — shallow):
```json
"areas": {
  "foyer":       { "name": "Astraea — Grand Foyer", "label": "Foyer", "icon": "🏛", "bounds": [x0,y0,z0, x1,y1,z1] },
  "bar":         { "name": "Astraea — Lounge Bar", "label": "Bar", "icon": "🍸", "cams": {…}, "yacht": {…}, "cameraOverrides": {…} },
  "observation": { … }
},
"defaultArea": "foyer"
```
- **Room ids**: the default area is the room's own id (`sc_890jump`); the others are `<room>~<area>` (`sc_890jump~bar`).
  `SceneState.sceneId`, `stage.back`, `ttrpg.from` accept `~<area>` (`shared/roomId.ts`: `isRoomId`, `splitRoomId`,
  `baseRoomId`, `areaRoomId`, `expandAreas`). Because the id changes, everything keyed by the room id is per area for free:
  the room-change curtain plays on every area move, the host's remembered seat, stage presets, the way back from room-moving
  modes. Moving between areas of the same room keeps the time / weather (`env`) and era.
- **GLB naming**: nodes of one area carry the prefix `<AREA>__` in upper case (`BAR__SPOT_01`, `BAR__CAM_WIDE`,
  `BAR__GEO_…`, `BAR__YACHT_SERVICE`). When a page loads area X, `SceneRuntime.load` runs `applyArea` BEFORE anything reads
  node names: `X__NAME` → `NAME` (an unprefixed node already called `NAME` is parked as `~NAME`), every other area's
  `<OTHER>__…` subtree is removed (never drawn, ray-tested or uploaded), nodes with extras `areas` (`"foyer,bar"` or a list)
  stay only in those areas, everything else is shared (a hull, a sky). glTF animation tracks are retargeted / dropped the
  same way. GLTFLoader de-duplicates equal names, so areas MUST use prefixed names.
- **`bounds`** (scene.json or per area, glTF min/max): what framing, the react screen and the effects treat as "the room" —
  the camera's far plane still covers the whole model (a planet, a sky dome).
- **Server**: `/api/scenes` lists one entry per area (`area`, `areaOf`, `areaList` [{key, id, name, label, icon, thumb}],
  `roomName`); `/api/scenes/<room>~<area>/file/*` serves `assets/scenes/<room>/areas/<area>/<file>` when it exists (an
  area's own `preview.png` / `thumb.png` / `lut.png`), else the room's file.
- **Studio**: the room picker shows ONE card per room with **area chips** (on the card and under the current-room strip in
  the Scene tab); a chip moves the party there (curtain). `app.scene.setArea(key | 'next' | 'prev')`.
- **Bus / Stream Deck**: `{type:'command', command:'scene', args:{area: 'bar' | 'next' | 'prev'}}` or
  `POST http://127.0.0.1:5191/api/scene/area {"area":"bar"}` (localhost only; `{"sceneId":"sc_890jump~bar"}` works too).
- **Per-room tables** keyed by id (screen skin themes, HDRI, looks, stage palettes, talk-show sets, TTRPG tables) fall back
  to the room's base id for its areas.
- **Tests**: `output.html?sceneTest=sc_890jump~bar`; the console notes `[scene] <id>: area <key> (…)` on load.
- Older builds (and guests on them) sanitise an unknown `~area` id to Classic; update every PC in a party.


# Yacht life (sc_890jump) — src/scene/yacht/*, shared/yacht.ts, src/ui/yachtPanel.ts

A room whose scene.json has a `yacht` key comes alive as a private space yacht. The first user is `assets/scenes/sc_890jump`,
the Origin 890 Jump "ASTRAEA" in orbit of Crusader.
- **Crew:** a bartender, stewards who serve the host drinks, crew walking their rounds, and seated guests.
- **Outside the windows:** ship traffic, an escort patrol, far pirate skirmishes, and storm lightning in Crusader's clouds.
- **Support events:** drinks, champagne, fireworks, an escort flyby and a whole fleet quantum-arriving.

`output.ts` attaches the engine next to the other layers (`yachtScene.attach/detach/update`, `chatFeed.on → onSupport`).
A room without `yacht` costs one check per frame.

| File | Role |
|---|---|
| `shared/yacht.ts` | Holds the room config type (`RoomYachtConfig`) and the host's bag `SceneState.modes.yacht` (`sanitizeYacht`, `shiftYachtClock`). Also the tier maths (`yachtThresholds`, `yachtTiers`) and the pure schedule helpers (`yachtAmbient`, `yachtSchedule`, `yachtHash`, `yachtRand`). |
| `src/scene/yacht/yachtScene.ts` | Page side: the orchestrator. Handles support → schedule, the show-volume pick, the fleet cutaway (`cameraOverride`), face protection, `debug()` and tests. |
| `src/scene/yacht/yachtRoom.ts` | Reads the anchors and turns scene.json `planet` / `far` into world space. With no storms listed, it generates them. |
| `src/scene/yacht/yachtCrew.ts` | Runs the crew: bartender, route walkers, stewards with trays, and guests (via the traffic `Patrons` class). Built on TownAssets / TownNpc. |
| `src/scene/yacht/yachtProps.ts` | Draws the flutes (two instanced draws for all of them), the silver trays and the bottle. It uses the units GLB's `PROP_flute/tray/bottle` when present, else procedural ones. |
| `src/scene/yacht/yachtSky.ts` | Everything outside: its own `Fleet` (traffic/fleet.ts) plus `SpaceFx` (space/fx.ts, `faces=false`, own face boxes). Covers fireworks, flybys, the fleet, the skirmish, the patrol and lightning. |
| `src/scene/yacht/yachtFx.ts` | The champagne pop. Confetti uses `CrowdFx` billboards; flash, cork, foam and sparkles use a room-scale `SpaceFx`. |
| `src/ui/yachtPanel.ts` | The Scene tab section "🥂 Yacht life" and the bus command `yacht`. |

## Room contract

Anchors are optional and use plain names. For rooms with areas, `SceneRuntime` has already renamed `AREA__X` → `X`.

| Node | Meaning |
|---|---|
| `YACHT_SERVICE` | The service door, at floor level. +Z points into the room. Stewards fade in and out here. Keep it away from the main camera: stewards walking past the lens fade out (< 2.8 m). |
| `YACHT_BAR` | Where the bartender stands behind the counter. +Z faces the guests. |
| `YACHT_POUR` | A point on the bar top. The champagne pops here when the host has no drink table nearby. |
| `YACHT_DRINK_xx` | A table or ledge point beside seat `SPOT_xx`. Delivered flutes are set down here: at most 3, and the 4th delivery clears the table first. The champagne pops here when it is within 2.5 m of the host. |
| `YACHT_ROUTE_<A..Z>_nn` | Ordered floor points of a walk route. The points also serve as waypoints when the straight line from the service door to the host is blocked (room BVH rays at knee and chest height). |
| `YACHT_SKY_nn` | An empty in space beyond a window, 80–400 m out, extras `size` (m). This is the show volume: it is picked per the **state** camera, so every page makes the same pick. |
| `CAM_EXTERIOR`, `CAM_EXTERIOR_02…` | Exterior shots for the fleet cutaway. The one that sees the formation best is used; if none sees it, there is no cut. |

scene.json `yacht`:
- `units` / `unitsMeta` (`npc/crew_units.*`) and `fleet` / `fleetMeta` (`fleet/ships.*`). A room that lacks them falls back to the
  Area 18 patrons and traffic ships. Paths of the form `@<room>/<file>` borrow another room's file (for test configs).
- `crewHeight` (m).
- `bartender` / `steward` / `stewardess` / `pilot`: unit ids for these roles.
- `routes: [{route, who, every, speed, clip, offset}]`.
- `patrons: [{unit, clip, sit, position, facing°}]`.
- `planet: {center, radius, storms}`. Storms are points on the planet's surface in glTF space. **Omit them or set `"auto"` to get up to
  10 storms placed where the room's cameras actually see the planet** (rays through a grid of the upper frame). Listed storms
  must be on the visible side.
- `far: [[x,y,z]…]`: skirmish points. They must sit inside the room's sky dome or backdrop, or the dome hides them. The fallback
  is 600–1500 m out along the show volume.
- `support: {drink, champagne, fireworks, flyby, fleet}` (USD).
- `ambient: {flyby, skirmish, patrol}` in seconds, plus `lightning` from 0 to 10.
- `seed`.

## Behaviour

**Ambient.** Everything ambient is a pure function of the wall clock and `hash(room id, slot)`:
- **Route walkers:** one per route. Each is stride-locked (the clip advances by the distance walked) and fades in and out at the ends.
- **Bartender:** idles, polishes and folds his arms in 6.5 s slots, and works the bottle when champagne pops at the bar.
- **Flybys:** every `flyby` s slot, with an 85 % chance: a fighter pair or a Constellation, Carrack, Hercules, 890 Jump and so on,
  crossing 2–6× the show distance.
- **Escort patrol:** two fighters hold station in a slow figure-8 relative to `YACHT_SKY_01`. It is fixed to the ship, not the camera.
- **Skirmish:** every `skirmish` s, with a 65 % chance, a 32 s dogfight at a `far` point: 1–3 duels of pirates (Cutlass) against
  fighters. Blue and red laser bursts, hit flares, and a kill at 25 s (fireball, core flash, ring, debris sparks, smoke).
- **Storm lightning:** `envStrikes` / `envFlashAt` per storm with the photosensitivity-safe spacing (≤ 3 flashes/s). A wide cloud
  glow, 4 flickering cells, and a flare on near strikes.

**Support events** come from chat feed finance events (`ChatEvent.ts` + `id`), so every page builds the same schedule.
- The value is `raidDonationValue`. `fkind: 'raid'` brings the fleet only.
- Tiers are cumulative: $10 means a drink, champagne and fireworks.
- Each part starts at `ts` + 0.7 s + its own offset: drink 0, champagne 0.6 s, fireworks 2.5 s, flyby 5 s, fleet 7 s.
- `yachtSchedule` works in lanes per kind:
  - Same-kind events within 3.5 s merge.
  - Queued events start after the previous one. Drinks overlap by about half, because the two stewards alternate.
  - An event that would wait longer than 60–150 s is dropped.
- Catch-up history (`snap`) is kept only while its show could still be running (4 min), so a page opened mid-show lands mid-show.

**What each event looks like:**
- **Drink** (≈ 2 × walk + 5 s; the lead's observation deck is 40 s):
  - A steward (the steward and stewardess alternate) walks from `YACHT_SERVICE` with a silver tray and two flutes, using
    `ual_walk_carry` held between the hands.
  - At the table they turn and move the tray to the left hand. If the table already has 3 flutes, they pick up the empties first
    (`ual_pick_up_table`).
  - They offer a flute (`ual_interact`: the flute goes tray → right hand → the table), look at the host, nod (`ual_yes`), turn and
    walk back.
  - Two stewards walk on the right-hand side of their line, so they pass each other.
- **Champagne** (7 s): the bottle pops up on the host's table (or `YACHT_POUR` with the bartender) and shivers. At 1 s it goes POP:
  a flash and ring, the cork arcs away from the host, a cream foam fountain, 2.5 s of twinkling gold sparkles, and 64 confetti
  pieces that burst up and flutter down with drag.
- **Fireworks** (14 s): 10–13 rockets climb and burst in the show volume. Each burst is a flash, then a coloured bloom, then 48–96
  stars with trails and soft heads.
  - Shapes: peony, ring, crossette (splits), chrysanthemum (crackles late), and now and then a gold willow.
  - Seven palettes.
  - The finale is 3 bursts in 0.7 s.
  - Bursts are pulled into the camera's frame.
- **Escort flyby** (9 s): two fighters. Pass 1 is low and close: they scream across the window and the lead does a barrel roll.
  Pass 2 comes back the other way: both waggle their wings and flash the red and green wingtip lights. Blue engine trails.
- **Fleet** (58 s):
  - 4–8 escorts, then the capital (Idris or Javelin), quantum-drop in 0.32 s apart. Each drop is a blue-white flare with a hot
    core, a 1.2–2.4 km streak that shrinks into the hull, the ship stretched ×6 along its nose, and the last ~100 m in a blur.
  - The ships hold formation for about 40 s, placed by hull centre in the middle of the shot and drifting 5 m/s.
  - Then they spool up (engines to 2×), stretch, flash and jump out.
  - With `cutaway` on, in Talk mode only, the camera cuts to the best `CAM_EXTERIOR` for 6 s around the capital's arrival.

## Host bag

`SceneState.modes.yacht` = `{on, crew, ships, skirmish, lightning, cutaway, support: {on, raids, drink?, champagne?, fireworks?,
flyby?, fleet?}, ev: {seq, at, kind, seed, user?}}`.
- Thresholds missing from the bag fall back to the room's `support`, then to 1 / 5 / 10 / 20 / 50.
- `ev` is the latest test or bus event: one exact kind, not the cumulative tiers.
- Guests' controllers shift `ev.at` with the party clock offset, as they do for slap.

## Never in front of the show

- Crew fade (0.35 s) while their body box overlaps a performer's head box, whether in front of it or behind it. The head box is
  the whole head plus a margin, never smaller than about 4 % of the frame. They also fade over the React screen in React mode,
  and when they are within 2.8 m of the lens.
- Space effects dim to 30 % behind face boxes (SpaceFx face uniforms, updated 4× a second).
- Champagne particles that would pass in front of a face, or within 0.9 m of the lens, are skipped.
- The cutaway happens only in `mode === 'talk'`. It goes through `SceneRuntime.cameraOverride`, wrapping the previous override.
  Each closure keeps its own `prev`, so a re-attach under engines that wrapped it later can never loop.

## Studio, bus and tests

**Studio:** Scene tab → **🥂 Yacht life**. The section is shown only when the current room's info has `yacht`. It has toggles, the
support tiers ($), raids → fleet, and Test buttons. In an observer studio the tests only play in that tab's preview.

**Bus / Stream Deck:** `POST http://127.0.0.1:5191/api/command {"command":"yacht","args":{"event":"fleet"}}`
- `event`: `drink` | `champagne` | `fireworks` | `flyby` | `fleet`; optional `user`.
- Settings: `on`, `crew`, `ships`, `skirmish`, `lightning`, `cutaway` (booleans).

**Test pages:**
- `output.html?sceneTest=sc_890jump&yacht=fleet@3,fireworks@6,support:25@2,raid@4` runs events on this page only.
- `&yachtCfg=demo` gives any room without `yacht` a generated demo config with fake anchors.

**Console** (`vtpOut.yacht`):
- `.debug()`: anchors, crew, sky counts, view, drink plan, events, cut, cost.
- `.test(kind, inSec)`.
- `.debugConfig(cfg | 'demo' | null)`.
- `.nextAct('skirmish' | 'flyby')`.
- `.manual = true; .clock = <epoch ms>` then `vtpOut.step(n, dt)`.

## Cost

Measured on the private mirror (RTX, 1280×720 headless, 900 frames with a fleet, fireworks, flyby, champagne and drink all
running, plus a $60 support event): `YachtScene.update` averaged 0.05 ms, p95 0.1 ms and max 1 ms. That includes `Fleet.update`.
The timer resolution is 0.1 ms. Ambient only: 0.012 ms.
- GPU draws:
  - 3 sky effect draws and 3 room effect draws.
  - 2 flute draws.
  - Trays and bottle only while shown.
  - Ship clones: each ship adds 1–2 draws while it is shown.
  - The crew: 5 skinned NPCs (+ guests), LOD1 on Performance / Balanced.
- Shaders are compiled with `compileAsync` on attach, covering one of each ship, the NPC fade variants, the props and the effects.

**Borrowed asset:** the confetti atlas is `assets/scenes/my_room/crowd/crowd_fx.png`, referenced with
`new URL(…, import.meta.url)`. Copy it into the room folder before shipping the room on its own.

**Orbital drift** (every page, from the wall clock): Crusader's cloud texture creeps along its longitude (one turn per 90
min: `EMIT_sky_planet`'s map offset) and the star dome (`*SKY_STARS*`) turns about the ship's lateral axis at the same
rate — the slow "we are in orbit" motion through the windows. Restored on detach.



# Lounge events (donations + gifted subs in a hangout) — src/scene/lounge/*, shared/lounge.ts, src/ui/loungePanel.ts

A room (or area) whose scene.json has a `lounge` key celebrates support in the area the host is in (first user:
`hangout_lounge` — main lounge, bar, patio with a firepit). Donations (tips, Super Chats, Rants, bits, Kicks, Jewels,
TikTok gifts → their USD value) and gifted subs (by count) pick a tier; tiers add up:

| Tier (default $ / gifts) | Bar | Patio | Main lounge |
|---|---|---|---|
| T1 ($1 / 1) | a drink slides down the counter | the firepit flares up | a confetti puff + a light cue |
| T2 ($5 / 5) | + a round of shots (one per gift, ≤ 8) | + a big flare, sparklers | + champagne pops on the coffee table |
| T3 ($20 / 10) | + the bottle wall lights up (a chase of glints + the `EMIT_bottle*` glow), bar sparklers | + fireworks (night: the yacht's show; day: salute flashes + coloured smoke shells) | + the balloon drop (one per gift, 12–60), confetti cannons, the light show hits |
| T4 ($50 / 20) | + champagne at the bar, a rainbow bottle wall | + the full show, a towering flare | + sparklers, more balloons |
| T5 ($100 / 50) | + a second round, the long chase | + the finale | + a second balloon wave, a confetti storm |

- **Gift train**: N gifted subs ≥ `trainMin` (10) also run one drink / balloon / rocket per gift (≤ 60 drawn), 0.42 s
  apart; the banner counts up "GIFT TRAIN ×N". A burst of single-gift events from one gifter (Kick) within 6 s adds up.
- **Room-wide** (T4+): the other areas' signature pieces also play wherever the state camera sees their anchors (rays
  ignore `glass` / `window` / transparent meshes): from the lounge, fireworks over the patio through the glass (sky points
  hidden by the ceiling are tried lower over the skyline) and the firepit flare; the bottle wall when the bar is in view.
- **Subs** = T1, **raids** = T3. Each can be switched off.
- **Banner**: a gold card (icon, title such as "SHOTS!", "FIREWORKS!", "LEGEND", the supporter + amount) in the first
  frame corner that covers no face and not the React screen (hidden while none is free), 9 s (a train: while it runs).

**Room contract** (all optional; plain names after the area prefix is stripped; aliases `LOUNGE_*` also work): bar
`EVT_COUNTER_START` / `EVT_COUNTER_END` (the slide line on the counter top), `EVT_SHOT_xx`, `EVT_POUR`, `BARTENDER`,
`EVT_BOTTLEWALL` (extras `size` [w, h]) + an `EMIT_bottle…` material; patio `EVT_FIREPIT` (extras `radius`), `EVT_SKY` /
`EVT_SKY_xx` (extras `size`), `EVT_SPARKLER_xx`; main `EVT_CONFETTI_xx` (ceiling release points, any area),
`EVT_BALLOON_NET` (extras `size` [w, h, d]), `EVT_CHAMPAGNE`, `EVT_TV`; anywhere `EVT_KEEPOUT_xx` (extras `r`). The same
names in scene.json `lounge.anchors` (`{p: [x,y,z], yaw?, size?, radius?}`, glTF space) need no re-export; an area's
anchors are read from `areas.<key>.lounge.anchors` by the OTHER areas for the room-wide pieces. Missing main / patio
anchors are derived (balloons above the seats, confetti beside them, a sky volume ahead of CAM_WIDE); a piece whose
anchor is missing in its own zone simply doesn't play. scene.json `lounge`: `on`, `zone` (`main` | `bar` | `patio`; else
from the area key / label), `money` / `gifts` (5 ascending numbers), `trainMin`.

**Determinism**: support events come from the chat feed (ChatEvent ts + id), test / bus stamps from the host's bag
`SceneState.modes.lounge` (`evs`, ≤ 6, host clock; guests shift them). `loungeSchedule` merges gift bursts and queues
celebrations ≥ 3 s apart (a small one waiting longer than 25–90 s is dropped, big ones always play); its lengths don't
depend on the area, so moving areas lands mid-celebration. Every particle is a pure function of (start, seed, time).

**Never in front of the show**: points inside a performer's head box (nearer than the face), inside the React screen
(padded), in keep-outs or within 0.9 m of the lens are skipped; SpaceFx sprites fade out behind faces / the screen.
**Calm**: tier ≤ 2 pieces, no gift trains, no light cues, no fireworks (the banner still thanks them). **React**: no light
cues; nothing inside the screen. **Off**: nothing. **Sound**: none (on purpose — not verifiable silently in tests).

**Studio / bus / tests**: Scene tab → **🥂 Lounge events** (switches, what counts, the tier grid per area, the gift
train size, Test T1–T5 / gifts / train / sub / raid). Stream Deck action **Lounge celebration** (`t1`…`t5`, `gift`,
`train`, `sub`, `raid`, `calm`, `toggle`); bus `{command:'lounge', args:{event, n?, user?}}` or settings `on / calm /
banner / lights / roomWide`; Ctrl+K: "lounge tier 4", "gift train 25", "calm lounge". Test pages:
`output.html?sceneTest=hangout_lounge~bar&lounge=t3@2,gift:12@5,train:25@3,money:7.5@1,sub@4,raid@6&loungeNight=1`;
console `vtpOut.lounge.test('t4', inSec, user, n)`, `.clearTests()`, `.forceNight = 0…1`, `.manual = true; .clock = ms`,
`.debug()`. Unit tests: `npx tsx tools/lounge_unit.ts`.

**Cost** (borrowed engines: SpaceFx ×2, the yacht's fireworks + champagne): 0 draws and ≈ 0.02 ms when idle; while a
celebration runs 3 + 3 (sky) + up to 6 instanced draws (confetti, balloons, strings, glasses, drinks, bottle) + the
champagne's. A governor halves particles after 2 s over 2 ms. Measured numbers: see the lounge-events report.

# Room forms + the big entrance - src/scene/forms/*, shared/forms.ts, shared/occupant.ts

A room's set changes shape with WHO is at a zone of spots: the host desk becomes a booster riser for a small host, a
perch podium on the desk top for a fairy, a wider deeper desk for an ogre, a low standing console for a giant, and when
a mech or vehicle takes the host spot the desk splits and sinks while a docking cradle (clamps, ceiling petals, a
gantry, a holo desk) rises into place; it all goes back when they leave. Big performers (large / giant / mech /
vehicle) get their own entrance: hangar doors or an iris and a runway walk, a floor lift, a retro-burn or crane drop
from above, or (rooms without a big door) a power-up at their spot. Rooms without `forms` / `bigEntrance` never change
for anyone but a big mech (which powers up at its spot instead of walking through the people door).
The design contract is creations/desert_walker/SPEC.md 2.2, 2.5, 2.6 and 3.7; its normative scene.json excerpt parses
as is (`tools/forms/late_orbit_spec_excerpt.json`, checked by the unit test).

**Occupant class** (`shared/occupant.ts occupantOf(profile, rules, measuredHeight?, base?)`, profile-only):
- `cls`: micro / small / human / large / giant from the real size (shared/avatarSize.ts); mech / vehicle for
  `profile.body` 'mech' | 'vehicle' (or a `profile.mech` / `profile.vehicle` config) whose SHOWN footprint is at least
  `occupants.mechMinFootprint` (1.4 m) or whose size class is at least `occupants.mechMin` (large). The Desert Star
  Walker (1.91 m tall, 2.40 m wide) is a mech by footprint (SPEC D8).
- `shown`, `footprint`, `pilotEye`, `contactR`: the SPEC scale rule (a mech with `mech.pilotHeight` is scaled so its
  pilot stands like a human: base x heroScale / pilotHeight).
- `big`: a mech / vehicle by footprint, or size class macro (big-entrance eligibility). `kind` also knows 'tv'.

**scene.json `forms`** (parser + every rule: `shared/forms.ts parseForms`; a full example: `tools/forms/forms_lab/scene.json`):
- `zones.<id> = { spots: ["SPOT_01"], order: [form ids, first match wins], default }`. A zone may have no spots (the
  call-in screen pylon): it fits to the host zone's occupant.
- `list.<form> = { when, nodes, hide, spots, seatSurfaces, lightGroups, cams, fit, in, out, outTo, overlap, holoDesk, scaleTo }`
  - `when`: `{ cls, kind, size, minHeight, maxHeight, empty, or }` - fields must hold for ONE occupant of the zone; `{}`
    = always. `cls` takes occupant classes; the SPEC's size names 'normal' / 'macro' there mean the size class.
  - `nodes`: shown only while the form is up (or changing in / out). `hide`: room nodes hidden while it is up. A form
    node the GLB ships **collapsed** (scale 0.0001, so an engine without forms shows the default set) with its real
    scale in glTF extras `restScale` gets that scale back as its rest pose (its visibility is the form's; the room clips
    layer stops hiding it as collapsed FX and drops a room clip's `.scale` track on it). Without `restScale` a collapsed
    node stays as authored.
  - `spots.SPOT_xx`: the zone spot in this form (`pos` glTF, `yaw` deg, `pose`, `seatHeight`, `sizes`, `label`,
    `clearance {height, radius}` = no measured head-room clamp, `cam {pos, target, fov}` = its talk camera, `ride` (or the
    SPEC's `carrier`) = the spot moves with that node's animated offset: a chair rising on a riser carries the performer).
    With a carrier, `pos` is the spot at the carrier's REST pose (or leave it out: the room's own spot); the engine adds the
    carrier's move. A `pos` that is already the moved place counts the move twice (a booster sitter floats the riser's
    height above the chair) - the forms engine warns about it (console + `vtpOut.forms.debug().errors`); a `fit.*` move
    (the dock's `fit.wellY`) is checked with the zone's fit once an occupant gives it one.
  - `fit`: the SPEC's list (`["deskY", "chairY"]`, `["wellY", "clampR", "holoY"]` ...) or bindings
    `{ deskY: { node, axis, rest, min, max } }`. The host computes the zone's fit from its biggest occupant (`fitFor`: desk
    top = seat + 0.13 x shown + 0.05, chair = clamp(0.27 x shown, 0.38, 0.62), dock well = clamp(1.35 - pilot eye, -0.6,
    0.4), holo = pilot eye - 0.35, call-in screen = clamp(eye + 0.45, 1.7, 2.9), console rail, clamp radii = the foot
    contacts). A listed deskY / railY moves the form's first node to the fitted height; tween values may say
    "fit.wellY", and `to: { radial: "fit.clampR" }` slides each-nodes out from their parent's centre to the feet.
  - `in` / `out` / `outTo.<next form | '*'>`: `{ dur, tweens: [{ node, each, stagger, from, to, auto: 'rise', t: [t0, t1],
    ease (+ 'stutter') }], cues: [{ at, fx: steam | sparks | dust | flash | beam, anchor, size, color, light: drop | ball |
    lasers, cue }] }`. Tweens are offsets from the node's authored rest pose (pos m in the parent's space, rot deg, scale
    x). No `in` = the form's nodes rise out of the floor; no `out` (or `{ dur, reverse: true }`) = the in-animation
    backwards. A node both forms use never dips (its automatic rise / sink is skipped). **All form motion is tweens: no
    glTF clips** (`FORM_*` or any other) - the released beta.9 `RoomClips` loops every clip in a GLB, so a desk split
    would loop forever there (SPEC 6.1 C9, rule R0: the GLB's rest pose is the standard set). The forms engine warns
    when a room GLB carries `FORM_*` clips.
  - `lightGroups.<EMIT group> = { program: rotate | chase | pulse | steady | flash | off, color, speed, intensity }`:
    those EMIT_ groups leave the room light engine and run these programs (off while no form programs them). Only
    groups whose name starts with `form` (`EMIT_formbeacon`, `EMIT_formrunway`) can be taken over (SPEC 2.5); any other
    name is ignored, so a room's own neon never goes dark in the standard form.
  - `cams.CAM_*`: presets that exist while the form is up. `holoDesk { node, below, ahead }` (head units): a plate in
    front of the pilot's face once they are in place. `scaleTo { node, ref, min, max }`: grows with the occupant.
- `kit: [{ piece, name, at, yaw, ...params }]`: procedural set pieces (`src/scene/forms/kit.ts`: desk (halves `_L`/`_R`,
  style console), riser, podium, chair, cradle (`_CLAMP_01..`), pad, gantry, holo, petals (`_PETAL_01..`), beacon,
  runway (`_CHEV_01..`), hangar (`_L`/`_R`), iris (`_BLADE_01..`), lift (`_PLATFORM`, `_HATCH_L/R`), couch, slot,
  marker). They are named nodes like authored ones: a room may author its own instead (same names) and drop the kit.

**Sync**: the HOST picks each zone's form (`pickForm`) and stamps `SceneState.modes.forms = { v: 1, room, zones: { host:
{ id, from, at, fit } }, lock?, entrance? }` in the studio controller's commit next to the walk stamps
(`stampFormsBag`): a walk-in starts its zone's change at the walk's stamp, a big walk-out changes it back after the exit
(`bigExitHold`), an avatar swap 0.3 s from now, a room load instantly. Guests shift it to their clock
(`shiftFormsClock`). Every page plays it as a pure function of (now - at): `formPhase` + `sampleZone`. Pages without a
bag (older hosts, test pages) derive the same choice from the performers they see (changes in the first 10 s after a
room loads are instant). `controller.setFormLock(zone, form | null)` pins a form by hand; the bag's `entrance` is the
host's big-entrance style choice.

**Spots**: a form's spot replaces the zone spot for whoever sits there through `SceneRuntime.spotMaps` (same index: the
seat rules, the green room and the Live panel never see a change; big performers get the form the zone is changing TO,
so their entrance goes to the right place); zone spots take every size class. A change between two variants of the same
spot re-places the performer where they are (`SceneRuntime.hopHook`). Moving / hidden form parts leave `room.occluders`;
once every zone is settled the runtime rebuilds its rays, the framing solver's caches and the seat plans
(`SceneRuntime.refreshRays`), and kit desks register their tops as seat surfaces.

**Seat routing by body kind** (SPEC 6.1 C1; `shared/occupant.ts spotFitOcc / pickSpotOcc`, `src/scene/forms/spotKinds.ts`):
spots may name the body kinds they take - GLB extras `kinds: ["biped", "quadruped", "tv"]` or scene.json
`spotKinds: { "SPOT_02": [...] }` (wins over the extras); a form's spot variant may carry `kinds` too. The studio
controller (host seat picks, `autoAssign`, moves, React-Big re-seats) and every page's `SceneRuntime` (guests the host
has not placed) score a spot for a performer as: (1) a forms zone with a form whose `when` names them (the dock for a
mech at the host desk, a landing pad) = made for them; (2) a spot with `kinds`: never for another kind, a listed mech /
vehicle = made for it (a hull is not a size class: the Desert Star Walker is 'normal' tall but 2.4 m wide), a listed
biped / quadruped / TV then goes through the size rule; (3) the size-class rule (`spotFit`), except that a big mech
only ever falls back to a spot not made for it (like a macro giant at an ordinary spot). So a mech guest skips a couch
marked for bipeds and takes the pad. An ordinary performer in a room without `kinds` / forms scores exactly as before.

**scene.json `bigEntrance`** (`shared/forms.ts parseBigEntrance`, `src/scene/forms/bigEntrance.ts`): `{ classes (occupant
classes or the SPEC's size classes; default large, giant, mech, vehicle), kinds, doorWidth, style: walk | iris | lift |
drop | crane | powerup | instant | auto, exit (| reverse), door: { kind: hangar | iris, node, leaves, slide, turn, open,
close } or the SPEC's iris: { node, blades, bladeTurn, outside }, phases: { irisOpen, walkFrom, irisClose }, outside,
path / paths: { <zone>: prefix }, lift: { node, dur, open }, drop: { height, dur }, styles: { crane: { hook, from, dur },
lift: { node, dur, hide } }, speed, cams: { CAM_*: { pos, target, fov, use } } or the SPEC's list [{ cam | rail, from, to }]
with time marks ("alert+0.6", "walk@0.35", "dock+3.8"), modes: { camera: [...] }, runway, fx }`. The mover wraps the
installed one in EVERY room (and forwards every member of the wrapped mover it does not have itself -
`forwardInner` - so engines that talk to `rt.mover` directly still reach it: the space scene's `spaceState` /
`sceneMode` / `spaceLaunches()` land on the SpaceMover) (`AvatarMover.claims`; rooms without `bigEntrance`: only big mechs / vehicles, which power
up at their spot), times the walk so the walker arrives as the zone's form settles, drives the doors / lift / crane hook
/ runway chase, and owns the "Follow entrance" camera during its entrances except in React / Gaming (or outside
`modes.camera`): authored windows first, else a door hero shot, a tracking operator on the audience side and the dock
shot (lift / drop / power-up shots) - every pose pulled in front of walls and fitting the walker at <= 60 degrees. A big
performer swapping in mid-show rises on the lift at their spot (hidden in the steam while the model changes).

**Tests**: `npx tsx tools/forms_unit.ts` (pure logic, the SPEC excerpt, the kit in Node, mover timelines at 30 / 60 / 144
fps, every style, the wrapper's forwarding, desk fit), `npx tsx tools/occupant_unit.ts` (seat routing by body kind on
the SPEC's spots; ordinary performers score exactly as `spotFit` / `pickSpot`) and `node tools/forms_e2e.mjs` (a private
mock API + Vite on its own port, Chrome headless --mute-audio, screenshots of every form, the transform, every entrance
style, the exit, the guest pad, the generated interview desk with the elbow check, and the space room's mover API
through the wrapper). Test pages: `vtpOut.forms.debug()`, `.big()`, `.scene.lock(zone, form)`, `.scene.force.set(key, { cls:
'mech' })`, `.scene.clock` / `.mover.manual + .clock` (frozen time), `.mover.forceStyle`, `.loadHost(avatarId)`.

**Interview desks in every other room**: the generated talk-show desk is shaped for the host (`deskSpec`). A small or
large host gets the top 1 cm under their seated elbow (`seatedElbow`: hips a thigh-radius above the seat, the rest
pose's shoulder over the hips, minus the upper arm, at their scale; clamped 0.46-0.76 m small, 0.60-1.00 m large; the
class table 0.62 / 0.86 m when the rig has no arm joints): SPEC L2 elbow - top within -0.04 ... +0.06 m. A large host's
desk is also deeper (0.80 m) and wider (x1.25) and grows away from them (back edge kept + 6 cm, `deskShift`). A giant
gets a standing console (0.42 x shown, 0.9-1.6 m), a mech / vehicle a holo plate. An ordinary human (and a fairy, who
stands on the desk top) gets the desk exactly as before (0.76 m - note: about 10 cm above a 1.5 m-room human's hanging
elbow; changing it would change every existing human's desk). It is rebuilt when the host's class or (small / large)
model changes. `node tools/forms_e2e.mjs --only idesk` measures elbow - top on the posed skeleton. A grown desk (large,
giant) is kept clear of the seats the layout put around the planned desk (`clampDeskSpan`: body discs at each other
seat and its knees narrow it / pull its front back, never below the planned desk), of the room (`boxFree`, stepping
back towards the planned desk), and its top never rises over the face of a seat beside or behind it (a giant's console
stays >= 0.9 m): a 1.4 m console beside a seated guest would hide her from every camera on the far side.

**Interview in a forms room**: the set (monitor, desk front, shots) is planned from the host's spot as the room's
current form serves it (a docked mech's cradle, not the desk chair), and re-planned when that form, the host's class
or co-hosts change. The call-in screen follows `fit.monY` (SPEC 6.1 C7): a zone without spots whose form lists `monY`
(LATE ORBIT's `pylon`) fits the host zone's biggest occupant, and `InterviewScene.setMonitorLift(dy)` raises the
monitor rig to that height over its floor (eased in with the form; the shot book is solved for where it ends up). Only
a `skin` monitor (put the pylon stages and pan head INSIDE the screen-skin template, so they rise with it) or a `holo`
is lifted; a floor-standing tv / crt / terminal keeps its place (its stand cannot stretch). A picture that sits ON a
room node never self-lifts: scene.json `interview.monitor.node` names that node (the picture rect authored on the room's
own TV glass, e.g. LATE ORBIT's `TALK_MONITOR_SKIN`; the picture is placed on it - its centre, facing its +Z - unless
`position` / `yaw` pin it), else a `skin` monitor rides the skin template it is built from. It follows that node's whole
world move (XYZ, unclamped: `shared/forms.ts callInOffset`, `src/scene/talkshow/callInHousing.ts`) - put the pylon
stages ABOVE the node in the GLB and move them with the room's forms to raise it. (Self-lifted to monY, the floor probe
from inside a TV meets the TV's own cabinet: LATE ORBIT's guest picture rose 0.965 m into the CRT's frame.) Units:
`npx tsx tools/callin_lift_unit.ts`; renders + the picture's coverage and distance off its node per Interview shot:
`node tools/forms_seat_e2e.mjs --interview --glass <node>` (with a copied data folder).
`node tools/forms_e2e.mjs --only ivforms` checks both on the lab (human: desk chair, monY 1.7; mech: the dock).

# Desert world rules - shared/desert/regions.ts, src/scene/desert/marks.ts, src/scene/desert/life.ts

The procedural desert (src/scene/desert) fills itself by RULES, so there is motion at every distance and the horizon is
never empty. Everything is a pure function of (seed, integer cell along the route, biome, wall clock): host, guests, OBS
and a page opened late build the same world (tools/desert_e2e.mjs det / desync stay exact).
- **Biomes** along the route: dunes, canyon, ruins, salt flats, dried sea floor (stranded ships), rust works, oasis. The
  desert's own schedule is 2.6 km regions that never repeat a biome; a voyage maps each chapter's layout flavour onto
  biomes (`chapterBiome`; a fork vote changes a chapter's content, never what already stands in the sand).
- **Layers** (route frame, lateral metres): near roadside things 40..260 m (boulders, rock pillars, dead trees, bones,
  debris, posts, girders, palms, salt mounds); a mid band 100..650 m (boulder fields, crags, scrub, sand fences, small
  wrecks, rubble, pipe runs, tents, carts, tall pinnacles, derelict cranes, buried masts); road lines (telegraph poles every
  42 m / lattice pylons every 230 m with sagging wires); canyon cliff walls 150..330 m out, tapering at the biome's ends;
  one or two landmarks per 450 m (stranded liners, dead walkers, lighthouses, factories with smoking chimneys and lit
  windows, pylons, tank farms, aqueducts, temples, watchtowers, buttes, hoodoo clusters, arches, palm groves, wrecks);
  a gate per canyon / ruins / rust-works region that the ship walks THROUGH (rock arch, ruined gateway, girder gantry:
  inner half-width >= 44 m, 34+ m clear); horizon megastructures 2.2..8 km out (drawn distance-compressed: megatowers,
  chimney stacks, liners, colossal dead walkers, wall ruins, mesas).
- **Rules** (tools/world_rules_unit.ts): nothing but a gate within 40 m of the route; tall things keep out of the danger
  side's enemy band (88..150 m); at most two big landmarks per cell, one per side; gates only in the middle half of a
  region and inside one biome; anything inside a city / dig-site disc or a keep-out is hidden; salt regions crust the
  low ground white (terrain `uSaltZ`); far silhouettes shimmer in the heat by day.
- **Life** (one draw each): bird flocks circling thermals and the odd big glider, dust devils wandering downwind (a life
  window per period), blowing sand sheets skimming the dunes (Medium+), smoke plumes from chimneys, and other walkers
  stepping across the horizon (kit pieces, lit at night).
- **Kit** (src/scene/desert/kit.ts): unit shapes shared by every layer, instanced, one material; parts may carry their own
  colour (`aCol`) over the instance's palette material (a cream superstructure on a rust hull).
- **Cost** (measured on the dev PC, RTX 5090, Medium, deck camera): +29 instanced draws, ~+0.3 ms GPU, the 60 m re-fill
  0.3..1.1 ms (a full cold rebuild 3..4 ms), life 0.04 ms. Ranges shrink with the graphics level.
- Test pages: `vtpOut.voyage.seekBiome('canyon')` (jump to the next moment the ship walks into a biome),
  `vtpOut.voyage.world.desert.marks.stats` / `.life.stats`, `vtpOut.voyage.extPreview = {move: 'TRACK'}` (hold an exterior
  move on air in any state).

# Show sky + beam rig - shared/showSky.ts, src/scene/showSky/*

scene.json `showSky` (or `true`) gives an open-air room a music-reactive night sky and a light-show beam rig in the
lighting states it lists (default Preshow): stars (three layers, twinkling with the hats), a nebula band that breathes
with the energy and swells on the kick / drop, aurora curtains rippling with the mids, planets and moons (analytic
spheres at infinity: banded giants, cratered moons, rings with a gap and the ring's shadow, a halo pulsing with the bass),
meteors on snares (at most one per beat, direction hashed from the beat index) and pulse rings on drops. Searchlights
(`beams`, room-frame feet) lean outward from the room centre in patterns picked per phrase from the bar number (fan,
cross, circle, sweep; pillars in a breakdown; converging in a build) and laser fans (`lasers`) open in the energetic
parts. Colours follow the light show's wash palette. Music comes from the same beat analysis as the light show
(src/scene/beatClock.ts); with no music input a 120 BPM auto groove that is a pure function of the wall clock (every page
pulses on the same beat). Photosensitivity: pulses are smooth envelopes, never full-frame flashes. No sound is played or
captured. One dome draw (after the room's own sky, under everything else) + one beam draw; fades over `fade` s.
`{states, fade, stars, nebula, aurora, meteors, pulses, light: [az, el], bodies: [{kind: giant|moon|planet, az, el,
size (deg), color, color2, ring: {tilt, inner, outer, color}, glow}], beams: [{at: [x, y, z], color?}], lasers: [[x, y,
z]], beamLength, beamWidth}`; azimuth 0 = the room's -Z, 90 = +X. Test pages: `?beatDemo=124` (synthetic beat packets),
`vtpOut.showSky.force = 1`, `vtpOut.showSky.info()`.

# Voyage: the walking ship - src/scene/voyage/*, shared/voyage.ts, src/ui/voyagePanel.ts

A room whose scene.json has a `voyage` key (SPEC Appendix A) is a ship that walks across a desert. **The ship never
moves**: the room, its performers and every `CAM_*` stay where they were authored (cam_eval numbers hold); one world group
(terrain, scatter, cities, enemies, a distant mesa ring) carries the INVERSE of the ship's body pose and streams past
(`matrix = roomRoot * Body^-1`). The horizon rocks, not the deck. Rooms without the key pay one check per frame.

**Determinism.** Everything is a pure function of the host's bag `SceneState.modes.voyage` (`VoyageBag`: seed, epoch,
pacing, holds, stamps, forks, toggles; guests shift its clock stamps with `shiftVoyageClock`), the room config and the
wall clock. A page opened mid-battle lands mid-battle; two pages at the same clock print the same
`vtpOut.voyage.digest()` (timeline + feet + turrets + enemies; tested by the e2e on 8 moments).
- Voyage time `V = (now - epoch - heldMs) - held`. Host **Anchor** holds ramp speed down / up over 8 s in closed form.
  A hold that ended over a minute ago, with no stamp on air referring to an earlier moment, folds into `heldMs` (never
  evicted: V does not move for any moment a page evaluates; SPEC 11.2 S1).
- **Chapters** of 1200 s (chill 1500, hot 900) cover exactly 3200 m (3600 / 2700), so distance is O(1) at any time.
  Each chapter = cruise filler + beats with odds: encounters (alarm, approach 20 s, exchange + climax, defeat, aftermath:
  120 s), a city pass, a sandstorm (60 s haboob ahead, 40 s clearing) and a treasure stop (brake, kneel 3.0 m, crew
  sortie, rise; 60-85 s by seed). Beat speeds scale by k in [0.85, 1.15]; the cruise filler absorbs the rest.
- **Pacing** changes take effect at the first chapter boundary after every stamped episode on air or queued, through a
  `pace` anchor (voyage time, chapter, distance at that boundary): S, the chapter and the hour never jump.
- The layout depends on (seed, chapter) only. A **fork vote** (chat poll in the last 120 s, started by the host studio,
  never over a live poll, never read aloud) picks the next chapter's flavour (terrain, city kind, enemy kind), never the
  timing. The poll closes 20 s before the boundary; the host stamps the result `{ch, choice, v}` while at least 10 s
  remain, and a later stamp is ignored everywhere (SPEC 11.2 S3). Terrain biomes blend 40..540 m PAST each boundary
  (one-sided), and the voted chapter cross-fades in over 8 s of voyage time (cities sink / rise), so nothing under or
  near the ship ever changes. Shared helpers for the world provider: `voyageGroundBinding(bag, cfg, V)` (chapterAt,
  biomeOf), `FLAVOUR_BIOME`, `BIOME_IN` / `BIOME_OUT`, `forkState`.
- **Journey hour**: `dayLen` chapters per day (default 2), `nightShare` 0.3, counted in chapters (a pacing change never
  moves the sun); Preshow / BRB / Outro pin 19.6 / 22.5 / 18.4.
- Pages and the host read the bag through `voyageBagFrom` (the room's seed / pacing where the host never wrote one); the
  host materialises it once (explicit epoch, so party guests shift it onto their clocks).

**Gait** (`voyageGait.ts`): distance-phased alternating tripod {FL, MR, BL} / {FR, ML, BR}, stride 6.0 m, duty 0.55, lift
1.4 m; stance feet are fixed in the world by construction (no slide). IK is a plane two-bone, knee up, with rig.json
joint limits (hip / knee / ankle); rams aim at each other. The gait shape goes through `VoyageGaitAdapter`
(`setVoyageGait`) so the mech lane's `shared/gait.ts` can drive the ship and the walkers.

**Deck motion** (`modeGain`): Talk 1, Interview 0.6, TTRPG 0.8, React 0, Gaming 0, BRB 0; battle x2 (pure in time); still
while kneeling; master `sway` 0..1.5; never a hit kick in React or Gaming. Exterior shots see the full motion.

**Cameras.** Deck cameras are untouched. `cameraOverride` (wrapping the others, like the yacht):
- **Talk never cuts away by itself (engine default, beta.12.1).** In Talk the camera stays on the host's pick: only a
  camera change or the Preshow show moves it. Cut-aways are the HOST's choice, `talkCuts` in the bag (Studio: Scene tab ->
  Voyage -> "Cut away while I talk"; bus flag `cutaways` / `talkCuts`), off by default; beta.11's default-on `cutaways`
  key is no longer read (a stored true was never a choice), and no scene.json key can turn it on (`shared/voyage.ts`
  `voyageTalkCuts`). With it on (lighting state Show, no OBS hole): battle 5 s, defeat 4 s, sortie 6 s, city 5 s, storm
  5 s, at most one per 90 s, only after 1.2 s without speech (VoiceTap), plus the room's b-roll; a camera (or focus) pick
  by the host ends a cut on air at once and holds the next one off for 90 s. Never in React / Gaming / Interview.
- Preshow / BRB / Outro with the host's ambient cameras on (`extCams`): the exterior program (crane, dolly, push, loop,
  drive-by, foot, bow, sunset, city, storm) on the `ambcam` shot clock. Every pose is planned (below). Per-room tuning:
  `voyage.extCams.EXT_*` / `CAM_EXT_*` / `EXTCAM_*`.
- **The shot plan (beta.12.1: no terrain clipping, no pops)** (`voyageCams.ts` `planFor`). Every exterior shot (the
  director's, the program's incl. the world-fixed DRIVEBY, b-roll, cut-aways) is planned from pure inputs (move, seed,
  start, length, the desert wrap, the world; the kneel and the wreck it frames are pure in the show time too - nothing
  read from the frame the plan happens to run on): the move's lens path is sampled at 24..64 points (at most ~6 m apart) while the ship walks
  on (the voyage distance at each moment), each mapped into the world EXACTLY (`DesertWorld.rootToWorldAt`, the drawn
  world's own matrix at that distance; `DesertProvider.fromLocal` solves for the route point) and measured against
  `heightAt` (the CPU twin of the GPU terrain): the lens stays 1.4 m above the highest sand within half a sample step
  (>= 2.5 m), and the land stays 0.6 m under the lines of sight to the walker's middle, deck top, bow and stern (taken in
  the bow frame, each line stopped where it meets the hull; the middle's line and the second-worst of the four set the
  lift: the land may hide one end, never the walker). The solid things on the sand are checked at points <= 3 m apart
  with a 1.5 m pad AND on every segment between them with the same pad (a thin rib or a small rock beside the path
  counts), and on the same four lines: the near features and scatter rocks
  from the seed (`DesertWorld.solidSet`: the same set on every page, whatever its camera), the landmarks / gates / lines
  and burning wrecks the marks and ruins layers place round the ship's distance (boxes for box-like shapes, their own
  triangles for arches, ribs, lattices, cliffs, mesas, hulls). Kit drawn more than 1300 m from the ship is
  distance-compressed scenery and is not solid. UNDER is checked against the room's own geometry (the lens and 0.3 m over
  it); every other move - DRIVEBY too - against the hull box + 1.5 m. The lift becomes ONE envelope over the shot (each sample's need held a sample either side, eased on / off on a
  half cosine whose steepest slope is 4 m/s), so the lens rises over a dune like a crane, never pops. A shot that cannot
  be cleared (a low move lifted > 12 m, the lens in / a segment through a solid thing, the walker hidden, the hull) tries
  its other variants (another side / start), then high moves (ORBIT, RISE, FLYBY, CRANE, HERO); event cut-aways keep
  their move. A plan that still meets anything NEVER goes on air: the safe high view (`HOLD`: 62 m out, 30 m over the
  deck, on one of 8 bearings, each one planned like any shot) does; if even those meet something, nothing exterior airs
  and the room keeps its own camera for that shot (`VoyageCams.stale`). What airs is the same on every page whatever its
  frame rate: a shot's plan is complete on the frame it airs. The director's next shots (every pick the music can cut to
  over the next two bar lines - the auto groove is a pure clock; a live beat feed's next section is a guess) and the
  show / program's next shot are planned AHEAD while the current one runs (`prefetch`, `planBudgetMs` 2 ms a frame);
  a shot whose plan is not ready when it starts is planned in full on that frame (measured: 31 of ~640 cuts, 16 of
  them a fresh page's first frame; median 3.2 ms, max 9.7 ms; the camera's frame cost p99 2.1 ms, p99.9 4.1 ms, max
  11.7 ms). A shot is planned only once this page's desert has placed its layers for the shot's stretch (250 m behind
  to 400 m ahead of the ship: `solidsReady`, false on a page's first frame and after a seek - the room's camera until
  then) and only inside one desert wrap (a shot over the 4000 km wrap - once in about two weeks of walking - keeps the
  room's camera; plans are keyed by the wrap). Tests: a fresh page next to an established one, and the same show at
  30, 60 and 144 fps airing the same pose at every shared show time. Composition backs off ONCE per shot (sideways for passing moves) and
  keeps its third and horizon fixed for the shot. The director's key holds the shot length (a section change that keeps
  the cut bar and the move is a new shot). The per-frame net (the exact sand under the lens + 0.5 m, lifted straight
  up) is counted (`planStats.net`) and stays 0 in the sweep. After a route-polyline step in relief country the clipmap
  re-renders finest level first, 2 levels a frame: the lens's own 128 m / 256 m windows are exact on the first frame;
  far levels (beyond ~256 m) may show the previous relief for up to 3 frames. Proof: `tools/voyage/cam_sweep.ts` (every
  move x land kind x seeds + the director's timeline with the real frame budget, per frame: lens clearance on the drawn
  0.5 m mesh, sand within 1.5 m of a frame corner, line of sight, rocks by raycasting the real kit meshes, hull, pops,
  the net) - 0 bad frames (`tools/voyage_director_unit.ts`); real frames: `tools/voyage/voyagecam_e2e.py`. A world
  without exact heights ahead (the placeholder) keeps the per-frame checks.
- **Preshow exterior show (zero settings).** In the Preshow lighting state (Talk mode, no OBS hole, no stage layout) the
  cameras leave the deck by themselves and watch the ship walk from outside at night (21.3 h unless the room sets an
  hour): RISE (crane-up from the sand), ORBIT (slow orbit), TRACK (low tracking alongside), HERO (the ship small under
  the hero planet), SKYWARD (from a foot up into the sky), FLYBY, FEET (the stomping legs), 13 s each, sides alternating,
  wide shots framed to hold the ship and the show sky's hero planet (the lens widens to fit both). Pure in the clock (the
  ambient-camera cycle when the host has them on), so every page cuts the same shot. Leaving Preshow returns to the deck
  cameras at once. A ship room without a `showSky` block gets one from the ship (searchlights on the covered show deck's
  corners and the fore / aft decks, laser fans), lit by the music or the auto groove. Tune or turn off with
  `voyage.preshow {exterior, always, hour, shot, moves}` (`"preshow": false` = off). The exterior box the cameras keep out
  of is the ship's own visible meshes (not the room bounds, which can hold a ground plane).
- **The director (beta.12, default).** The Preshow show cuts on the MUSIC (src/scene/voyage/voyageCams.ts `directorPick`):
  every shot starts on a bar line and lasts 2 bars on a drop / build, 4 in the groove, 8 in a breakdown (the slow orbit
  for the light show), from the same beat clock as the light show (the studio's beat packets, else the 120 BPM auto
  groove: every page cuts the same shot). Moves: the seven above plus ESTAB (high wide track alongside), UNDER (under the
  belly between the legs, on a lane checked against the room), WRECK (the walker passing a burning wreck) and two
  performer shots, DECK (a slow arc) and PUSHIN (a push-in): src/scene/voyage/voyageDeckCam.ts rings the performer's drawn
  face with candidates, keeps those whose face, head top and chest are in sight from both ends of the move (RoomRays),
  ranks them by what lies behind (open horizon first; an angle that cannot see the chest - a head peeking over a counter
  or the hull's rail - is dropped, and a seat with no such angle gets no performer shot), frames with the solver's frameFrom (safe area) and names the
  subject (live drift guard). Never the same move twice running in a section; no performer = no performer shots.
  Exterior shots are planned against the land and the solid things on it (the shot plan, above). `voyage.preshow`: `cuts` ('music' | 'clock' = the
  fixed `shot` clock), `moves` (any of the director's moves), `performer` (share of performer shots 0..1, 0.3), `bars`
  ({drop, build, groove, breakdown} bars per shot), `storm` (the most sandstorm shown in Preshow 0..1, 0.3: the show's sky
  stays readable).
- **Show b-roll** (`voyage.broll: true | {on, every 45 s, bars 4, quiet 2.5 s, moves}`, off by default; it only plays
  when the host has also turned on "Cut away while I talk"): in Talk + Show, when the performer has been quiet `quiet` s and no cut was on air for `every` s, a `bars`-bar exterior cut starts on the
  next downbeat (ESTAB, TRACK, UNDER, WRECK, FLYBY, FEET), then the deck cameras come back.
- **The SAND look** (`voyage.world`, desert provider): `relief` 0..1.5 (1; mesas with stepped cliffs, ridged ranges and
  highlands from 260 m off the route, rock strata; 0 = the old dune sea), `haze` 0.4..2.5 (1; above 1 the air turns dusty
  ochre), `wrecks` 0..2 (1; burning wrecks with fire and leaning smoke columns, 165..330 m out), `skyline` 0..2 (1; ruined
  industrial towns 1.15..2.25 km out, smoking stacks, beacons and lit windows at night), `drift` 0..2 (1; blowing sand).
  Rules: shared/desert/ruins.ts (tools/voyage_director_unit.ts). `voyage.labels {kind: name}` renames a stamp kind for this
  room (banners + Studio buttons); `crew.lines` gives the crew its own shouts.
- **Showpiece pass 2.** Relief: mesas 150 + 90 m with scree, ridged ranges to 230 m and highlands from 220 m off the route,
  plus CANYON stretches (walls 190 m tall on both sides from 150 m out) and RIDGE-OVER-BASIN stretches (the land falls 70 m
  away on both sides from 130 m out), each 1-5 km long, about a fifth of the route each (a world noise field: pure). Aerial
  perspective in steps (`haze` > 1: mid-distance layers crisp, the far ones sink into the dust), dune faces turned from
  the sun in warm shade with a bright crest line, darker warmer rock. Night: a moonlight floor (`voyage.world.moonlight`
  0..2, 1) - a cool key from the moon, or a skylight when it is down - with a cool rim on crests and cliff edges; burning
  wrecks light the sand and wrecks round them (6 fire light pools, terrain + kit); ruined towns glow at night; the night
  haze leans towards the show sky's colours. The desert's sun runs on the room environment's sun path (a low
  `environment.noonElevation` = long golden shadows all day).
- **Composition** (`COMPOSE`): ESTAB / TRACK / FLYBY / WRECK / CRANE / DOLLY / LASERS hold the walker at a set share of
  the frame height on the third that leaves room ahead of its bow (WRECK: away from the wreck), the horizon on the lower
  third (a low lens) or the upper third, the whole walker in frame; a lens too close backs off along its line. ESTAB is
  the key-art shot: low, ahead of the bow, on the side that puts the highest land and a burning wreck behind the walker,
  at a distance with a dune crest in front of the lens. UNDER rides between the legs (a lane checked against the ship's
  own geometry). LASERS: a close HERO looking up the searchlights and lasers. Sky moves (HERO, SKYWARD, LASERS) only while
  a show sky is up. Tests: `vtpOut.voyage.shotMetrics()` (hull fill by a ray grid, projected size / centre, bow + stern
  on screen) in tools/voyage/voyage_e2e.py (UNDER <= 60 % near-black and <= 70 % hull; ESTAB / TRACK size, third, room
  ahead of the bow).
- **Bow-first.** The ship walks bow-first: the bow comes from `voyage.forward` ('-z' | '+z' | '-x' | '+x' | 'auto'), else
  the VOYAGE_BOW node, else the hull itself (`detectBow`: the end whose width takes longer to reach the beam is the prow;
  a confident call only); the legs' gait offsets and the show cameras are taken in the bow frame, so a model facing +X
  walks and is filmed like one facing -Z. The room notes say where the bow came from and warn when a setting disagrees
  with the hull. `vtpOut.voyage.directionProbe()`: travel . bow (through toShip and the rendered world), every standing
  foot planted and pushing aft, no foot backwards over the ground, footfalls advancing - checked by voyage_e2e over 42
  moments incl. the desert's wrap.
- **Erosion (polish).** Cliffs step in ledges every 13 m (a shelf, then a riser), mesa rims and canyon wall lines are
  jagged (a 140 m noise field), strata vary in thickness and colour with lit ledge lips, vertical gullies cut the faces
  (with their own shading), and rubble covers the talus at the cliffs' feet. DesertRoute.dist searches +-3.2 km of chords
  far from the route, so the CPU and GPU heights agree exactly on the relief too. FEET stands clear of the feet's dust
  (dust puffs thin out near the lens; voyage_e2e checks the walker shows through on >= 50 % of its cells). Deck shots
  in a canyon pick the camera whose view behind the performer is most open (the world's own openness at the shot's
  start).

**Combat** (pure `battlePlan`): the turrets aim exactly (blended in / out, no slew state), at least 4.2 s per gun and 1.2 s
overall, with recoil, muzzle flash, world-anchored smoke and tracers at 320 m/s. The fire-arc rule (SPEC D18 / C13,
purely geometric) skips any shot - battle salvo, salute or broadside round - whose line of fire (from the muzzle: the yaw
pivot + the rest pivot -> muzzle reach toward the target) passes within `keepOut.fireArcFromSpots` (6) m of an authored
spot, of an alongside slot node (`keepOut.fireArcSlots`) or of the canopy + wings + hatch-stage box (`keepOut.fireArcBox`
[minX, minY, minZ, maxX, maxY, maxZ] in the ship frame; else the first dry box; exact distance), or that the gun cannot
bear on (yaw limits); a broadside gun takes its own
ridge on the beam, swung fore / aft until its rounds clear the deck, or stays quiet. Enemies (Bulwark Crawler, Stilt Lancer, Gnasher
packs, sand skiffs) prowl 95-130 m out on the danger side and return fire. Near misses throw sand geysers at least 25 m
from the hull. Up to 3 hits (severity 1-3) land on `DAMAGE_xx` sites, at least 12 m from every spot; each burns until
the crew plan repairs it. The hull never drops below 35 %. Every smoke puff fades out near the performers.

**Stamps (host stamping, SPEC D10).** Support is turned into bag stamps by the host controller only (`voyageHost.ts`), so
every page plays the same thing. Tiers [1, 3, 5, 10, 20, 30, 50] map to whistle, salute, special, broadside, fireworks,
battle (summon a raider), treasure (Dig here!): the effects add up, of the two episodes only the bigger one plays. A raid
is a skiff convoy alongside, and Kick channel-point rewards map by keyword (`voyage.rewards`).
- Two rings (SPEC 11.2 S2): `stamps` holds episodes (treasure, battle, storm, city, convoy, newVoyage; at most 4, never
  evicted before the episode has ended - a full ring refuses the next one) and `fx` the effects (whistle, salute, special,
  broadside, fireworks; 8, the one closest to its end makes room). Viewer names are cleaned and capped at 24 characters.
- The queue starts a stamp at least 2 s ahead, after the running block, in a clear window: no battle in a storm or a
  stop or another battle, no stop within 90 s after a battle (SPEC 2.4), checked on a conservative voyage-time window so
  a later Anchor / Weigh anchor cannot break it. Buttons wait at most 60 s, paid episodes 4 minutes; a summoned raider
  joins a base battle that starts before its own window. One pending battle, one pending treasure, same-kind stamps
  within 3 s merge. Queued battles / storms move to a clear moment again when the timeline moves (a hold, a stop) or
  drop; drops show in the Scene tab.
- A treasure stamp adds its own hold one ramp after the last hold, or stands on an open anchor; Weigh anchor waits for a
  stop standing on it. Chat activity only drives exhaust steam.
- Support banners take the first free slot in the top band and never sit over a face, the React screen (or its hole),
  the interview monitor or Gaming tiles; nowhere free = no banner. Effects dim over the screen / monitor (SPEC 5.6).

**Environment**: `EnvScene.drive` (additive) - the voyage sets the hour (journey clock with the pins), the weather (new
`sandstorm` weather, `dust` 1; not in the climate cycles) and `north` (env north + route heading). Sandstorm fog applies
to world materials only - performers are never fogged.

**Room contract** (ship frame = the room's glTF frame; origin = show deck floor centre; bow -Z unless `VOYAGE_BOW`):
- Legs `LEG_<id>_COXA` > `_HIP` > `_KNEE` > `_ANKLE` > `_FOOT`, or the v0 naming (`_FOOT` = ankle, `_SOLE` = contact),
  with node origins on the joints. Ids are FL ML BL FR MR BR or L1.. R1... Pistons are `P<n>` / `RAM<n>_CYL` / `_ROD`.
- `TURRET_<n>` > `_GUN` > `_MUZZLE` (aliases `GUN_F_*` / `GUN_A_*`), `DAMAGE_01..08`.
- `GANGWAY` (rotates about local X by extras `lowerDeg`, default -60).
- `LANTERN_*` / `PENDULUM_*` and `voyage.below.lanterns` (e.g. `SWAY_TABLE_A/B`) swing with the hull.
- `EMIT_menorah*` materials flash on the whistle.
- `FALLBACK_DESERT` (or `voyage.nodes.fallbackGround`) and every node with extras `voyageHide` are hidden while the
  streaming world is attached, then restored.
- `VOYAGE_GROUND` gives `groundY` when the config has none.
- A room without `LEG_*` nodes gets the procedural placeholder ship.

scene.json `voyage` (Appendix A; all optional): `rig` (rig.json: limits, rams, turrets, damage, extCams), `groundY`,
`ship` (`auto` | `room` | `procedural`), `gait` {family, stride, duty, lift, speeds {cruise 3.0, city 2.2, battle 4.2,
storm 1.7}, kneel}, `body` {heave, rollDeg, pitchDeg, impulseDeg, terrainPitchMax}, `modeGain`, `chapter`,
`chapterDist`, `dangerSide`, `keepOut` {fxFromSpots, shellsFromHull, lens, fireArcFromSpots, fireArcBox, fireArcSlots}, `turrets` {TURRET_n:
{alias, yawDeg, elevDeg}}, `support` {tiers}, `rewards`, `below` {portholes, sway, lanterns, drums}, `extCams`, `nodes`,
`seed`, `far` (camera far plane, 2600), `damage` (fallback hit sites), `world` {sand, trough, crest, fogNear, fogFar,
scatter}, `pacing`.

**Studio / bus / tests**:
- Studio: Scene tab -> **Voyage (walking ship)**. It has Anchor / Weigh anchor, New voyage, stamp buttons, pacing,
  events, sky mode, day length, night share, cut away while I talk (off), exterior cams, chat votes, deck motion, helm, support and tiers.
- Bus: `{command:'voyage', args:{on | cutaways (= talkCuts) | extCams | votes (bool), sway, pacing, env, anchor, newVoyage, event:
  <stamp kind>, user}}`.
- Test pages: `output.html?sceneTest=<room>&voyage=battle|approach|salvo|hit|defeat|boom|storm|treasure|stop|kneel|city|night|day|fork|cruise`
  with `&voyageAt=<s>`. Also `&voyageEv=fireworks@3,support:25@2,raid@4,battle@1` (page-local test stamps),
  `&voyageCfg=demo` (any room) and `&voyageSeed=<n>`.
- Console: `vtpOut.voyage` (`.info()`, `.digest()`, `.seek()`, `.test()`, `.tests`, `.crewPlan()`,
  `.manual / .clock / .frozen`).
- Unit tests: `npx tsx tools/voyage_unit.ts`.
- Headless check: `python tools/voyage/voyage_e2e.py --out <dir>`. It uses private ports, the read-only mock API
  `tools/voyage/mock_api.mjs`, muted Chrome and the `voyage_test` deck room from `tools/voyage/voyage_room.mjs`.

**Cost** (placeholder world, RTX 3060 budget):
- Draws: terrain 4 (~55k vertices, heights on the GPU, ripples anchored to the sand, no uploads), scatter <= 4,
  cities <= 4, backdrop 1, effects 3 (SpaceFx), enemies 1 per body + 3 instanced, dust 1.
- Voyage CPU is ~0.5-0.8 ms per frame in battle (budget 2.5 ms).
- Effects detail drops with the graphics level, and again when the voyage itself gets expensive.

# Ship crew (the walking ship's deck crew) — src/scene/crew/*, shared/shipCrew.ts

Rooms with a scene.json `crew` key get nine Muppet-style crew: a builtin puppet avatar turned into an NPC unit
(tools/npc_crew/build_crew_units.py: the 20-bone NPC skeleton + Jaw / HeadTop puppet-mouth bones, LOD0 ~9k / LOD1 ~3.4k /
LOD2 ~0.75k tris, one 2048² atlas, a fur mask the runtime hue-shifts / tints per crew member, hats + held props). Roster (slot
order): the Cap'n at the helm, gunner + loader for the fore gun, gunner + loader for the aft gun, the stoker, the
lookout, two deckhands. `crew.helm: "performer"` hands the wheel to the host; the Cap'n then works as a deckhand.

**Assets** (room-relative, defaults): `npc/crew_units.glb`, `npc/crew_anims.json` (46 authored clips: helm hold / turn,
gun laying up / mid / down, shell carry + ram, shovel, hammer + weld standing / kneeling, spyglass, point, alarm,
cheers, catch, throw, ladder climb / slide, jump-off / fall / land, dig, lift, carry pair, swab, polish, sit, brace,
duck, flinch overlays…: tools/npc_crew/crew_anims.py) and `npc/crew_anims_ual.json` (the UAL library retargeted onto
the crew: tools/retarget/retarget_crew.json). Rebuild order: build_crew_units.py → crew_anims.py → retarget.py with
retarget_crew.json. Clip timings the planner uses are a static table (src/scene/crew/crewClips.ts; tools/crew_unit.ts
cross-checks it with `crew_clip_meta.json`).

**Room contract** (empties, room space = ship frame; everything optional — with fewer than 4 `CREW_NAV_` nodes the
built-in preset layout in crewDeck.ts is used, with any crew anchor the room does have laid over it by name):
`CREW_NAV_xx` (extras `links: "CREW_NAV_03,CREW_NAV_07"` + `kinds: "walk,stairs"`, or inline `CREW_NAV_07:stairs`; kinds
walk / stairs / ladder / door / narrow), `CREW_HELM` + `HELM_WHEEL` (a hub higher than the puppet reaches — 0.60 m above
his feet at crew height 1.25 — gets a wooden crate under the Cap'n; the crew spins the wheel about its local Z, 18 × the
voyage's yaw rate 0.4 s ahead, ±540°), turrets `TURRET_n` (SPEC 1.3: alias `GUN_F` / `GUN_A` from scene.json
`voyage.turrets` or the node's extras `alias`; older `GUN_<F|A>_YAW` too; `TURRET_n_MUZZLE` gives the barrel) with
children `GUN_x_SEAT` (the gunner's feet) / `GUN_x_BREECH` (the loader's feet, or a hand point at the breech: the fit
finds the stand within reach, with a loading step when the breech is above a puppet's reach), `GUN_x_RACK`,
`CREW_STOKER` / `CREW_FUEL` / `CREW_FIREBOX`, `CREW_LOOKOUT`, `CREW_JUMP_<P|S>_xx`, `CREW_LADDER_<P|S>` (or
`LADDER_DROP_<P|S>`), `GANGWAY_<P|S>` (the ship's own rope ladder: the crew climbs it and draws none of its own; on a page
without a voyage the crew unrolls it itself), `CREW_CATCH_<P|S>` (all +Z = outboard), `CARGO_HATCH`, `CREW_HOME_00..08`,
`SWAB_xx`, `RING_SEAT_xx`, `RAIL_xx`, `DAMAGE_nn` + `DAMAGE_nn_REPAIR` (hull hit sites and the deck stand each is
repaired from; without a stand the fit finds the walkway at the rail above the site), `TREASURE_SITE` (the default dig
site, starboard; mirrored for a port stop), `CREW_FOOT_xx` / `LEG_*_FOOT` (extras `r`), `CREW_KEEPOUT` (extras `size`)
— without it the deck area's scene.json `bounds` are the show set (SPEC Appendix A `keepOut: ["areas.deck.bounds"]`).
Areas: the deck crew lives in the room's default area (`crew.area`); the `galleyCook` area shows only the galley cook at
`GALLEY_COOK` (or `crew.cook: [x, y, z, yawDeg]`); other areas of the ship show no crew.

**Geometry fit** (crewDeck.ts `snapDeck` / `snapDeckSteps` over crewProbe.ts — BVH rays against the room GLB's own
meshes, chosen by name, never by visibility, so every page fits the same deck whatever its camera or quality preset;
rigidly skinned legs / turrets at their bind pose). Run a few ms per frame while the crew assets download (~1 s of rays
for the 40 m ship; the crew appears when it is done): every foot point stands on the walkable surface nearest its
authored height, on a patch wide enough for a body with head room, clear of walls by the body radius; points with no
such floor (past the hull edge, on a rail cap, over a stairwell, in a gangway gap, under a gun platform) move to the
nearest place that has one; nav edges that run through something get detour nodes, and stairs drawn where the geometry
has none — or a walk up a step — get a walk found on a 0.2 m grid (hops onto steps / platforms ≤ 0.95 m; a 1.25 m
puppet scrambles); islands are joined where the geometry allows; every spot is linked to the graph by a clear way (a
detour, a hop); nodes near each other are welded. Links with no way at all are dropped, or kept (and noted) when they are
the only way to a spot. At draw time feet follow the floor under them (±0.22 m; ±0.7 m for crew riding a turning
turret), and crew on the move step round each other. Everything the fit changed is in `vtpOut.crew.info().deck.notes`
(read these for a new ship: e.g. a breech no stand reaches, a hull site far from any walkway, a wall across a walkway).

**scene.json `crew`** (or `voyage.crew`, SPEC C16): `units`, `anims`, `height` (1.25 m to the fur top), `count`,
`helm`, `hues` (degrees) and `tints` ('#rrggbb', on the fur), `lod {lod0px, lod1px, lod2px, poseEvery, maxLod0}`,
`faceGuard {screenR}`, `bubbles`, `lines {alert, stations, fire, hit, repair, victory, flee, treasure, shore, catch,
aboard, cruise}`, `jumpMax` (m; higher drops slide down the rope ladder), `ground` (sand y while halted; default the
voyage's `groundY` + its `gait.kneel`, else −9.844), `digSite` ([x, z]), `area`, `galleyCook`, `cook`, `keepOut`,
`layout` (`auto` | `anchors` | `preset`), `snap` (false = no geometry fit), `seed`, `driveTurrets` (test rooms).

**Behaviour** (crewPlan.ts: decided at plan time, sampled per frame): cruise = one closed loop per crew member sampled
from the wall clock modulo its period (a page opened mid-voyage lands mid-chore). A **battle** (alert → shots → hits →
end) has the lookout point + shout ≥ 1.5 s before the first shot, the Cap'n call stations, gunners ride their turrets and
flinch on each shot, loaders run rack → shell → breech → ram (done ≥ 0.3 s before each shot; the combat engine must keep
one gun's shots ≥ 4.2 s apart), every hull hit becomes a repair job 0.8 s later picked by utility (nearest free deckhand;
the stoker only when every hand is tied up) — hammer / weld, standing or kneeling, 4 + 2 × severity s, sparks at the hull
site — then a victory (or the enemy flees) and everyone walks home and rejoins its loop at the next boundary. A
**treasure stop** (starboard unless stamped `side: 'port'`, SPEC 4.3 / C14): the lookout points, the rope ladder drops,
a shore party of three (utility: deckhands, then loaders) — two jump off the rail, one goes down the ladder (all slide
above `jumpMax`; who takes which rail point / the ladder is the assignment that gets the last of them to the X soonest)
— runs round the leg feet and the alongside size spots to the dig site (TREASURE_SITE / `digSite`, forward-starboard,
clear of the alongside giants), the first there digs, the first two there carry the big chest in pairs (the small one
alone), the last runs the coin bag back, a catcher hauls chests up on a hoist rope and catches the bag, and they climb
back one at a time in order of arrival at the ladder foot (waiting apart; the next starts when the one above is a third
of the way up; anyone with nothing to carry runs back and climbs without waiting for the hoist). A stop window (`until`)
takes the longest variant that fits: **full** (the dig site, ~100-110 s on the SPEC ship at the kneeled sand),
**quick** (the same loot from the near edge of the C14 sector, x 10.5 z −22.5: ~75-90 s), **dash** (two crew sprint
for a coin bag: ~51-57 s), **wave** (nobody goes ashore; only below ~55 s). A newer episode cuts the running one at its
start and starts from where everyone is.

**Sync**: plans are pure functions of (seed, the episode inputs, the fitted deck); randomness only from hash32 / rng;
positions and times quantised before branch decisions. Every episode is re-planned when its CONTENT changes (a hit, a
shot, the end, the outcome, a stop window added or changed under the same id) and the planner is causal, so a page that
re-plans and a page opened later agree, and nobody moves before the change. `vtpOut.crew.info().hash` is the same on
every page at the same instant. Footing, personal space and face fades are presentation only (never hashed).

**Voyage API** (`crewScene` in src/output.ts): `setFeed({episodes(fromMs, toMs), gunYaw?, gunPitch?, yawRate?, accel?,
tilt?, groundAt?})` (every function pure in wall-clock ms; a throwing or NaN feed never stops a frame), `stopDuration(stop,
prior?)` (s: hold the halt this long — the planned last-aboard + 1.5 s of the full variant, given the episodes before it;
150 before the deck is known, so call it once `info().ready`), `repairProgress(hitId)` (0..1: fade the damage decal /
fire), `phase()`, `focus()` (where the action is, for a cutaway), `onEvent(fn)` (hammer / weld / ram / toss / land /
catch moments). Update the crew AFTER whatever turns the turrets. Adapter contract:
- **Battles**: pass `synth: false` (never invent a salvo when the shot list is empty or fire-arc skipped) and the
  battle's planned `end` + `outcome` from the alert on (a null end until the defeat, or shots listed only ~30 s ahead,
  make the crew plan a placeholder and re-plan as they arrive: causal, but extra plans).
- **Treasure stops**: stamp `until = at + (8 + stopDuration + 10) s` as SPEC 2.4 / D13 say, so the full stop plays; a
  shorter window (e.g. a voyage-side 60-85 s stop) plays quick / dash instead of nobody ashore.
- **`groundAt(x, z, ms)`**: the sand height (room space, the halted ship's frame) under room (x, z) — SPEC C5 `groundAt`
  mapped into the ship frame. The shore party's feet, the loot, dust and the rope feet follow it (exactly at the plane,
  faded out 0.5-2.5 m above it, crewDeck `sandLift`); presentation only, plans and the sync hash keep the flat stop
  plane (`ground`).

**Never in front of the show**: checked every frame — a crew member whose whole screen box (feet, head and the top of
the puppet head + hat) overlaps a performer's face or the React screen fades out in 0.15 s; one between the lens and a
face is hidden at once, so is anyone within 1.4 m of the lens; bubbles hide over faces. Every clone wears a hat or a
tint, so a performer playing the puppet avatar is never taken for crew.

**Load** (SPEC P7 / P8): the room's BVHs are built one mesh per slice and the fit runs in ≤ 4 ms slices (longest step
~20 ms in the browser); the nine clones are built off-screen one per task, env-patched (`patchEnvMaterial` lit: the
crew dims with the room at night like the ship), and every program — opaque and fading, every LOD, ink, props, crate,
ropes, bubbles, sparks — is compiled with `compileAsync`, the atlas uploaded and each program's first use done before
the crew is shown: no long task ≥ 50 ms from attach to ready, no compile at the first fade, battle or treasure stop.

**Cost**: one skinned draw per crew member (+ the ink outline on the nearest LOD0s), LOD by height on screen (LOD0 ≥ 140
px, max 6; LOD1 ≥ 40; LOD2 ≥ 12; hidden below), pose rate 1 / 2 / 3 frames per LOD, 2 particle draws, one per bubble /
rope / loose item; footing one cached ray per moving crew member. Measured headless on the SPEC ship: ~0.2-0.3 ms per
frame for nine crew; the deck fit ~1.5 s of work sliced over ~230 frames at room load; planning once per event.

**Tests**: `npx tsx tools/crew_unit.ts [--npc <dir>] [--ship <room scene.glb>]` (deck, nav, cruise, battle, treasure,
sync, re-plans, supersede, anchors, sanitizers; with `--ship` the deck fit and a 10 Hz walkability audit of 18 minutes
of plans against the GLB's own meshes — tools/crew_shipgeo.ts); headless: tools/npc_crew/crew_ship_e2e.py (the real
ship) and crew_e2e.py on a private stack (see their headers); test pages
`output.html?sceneTest=<room>&crew=battle@3,treasure@40,flee@5[&crewCfg=demo]`, console `vtpOut.crew.test(kind, inSec)`,
`.gallery(['helm_hold', …], [x, y, z], yaw)`, `.manual = true; .clock = ms`, `.debug()`, `.audit(times)`.

# Festival stages - src/scene/festival/*, shared/festival*.ts, src/ui/festivalPanel.ts, looklab.html

A room with a scene.json `festival` key and `FX_<TYPE>_<GROUP>_<NN>` anchors becomes an open-air festival stage: instanced
moving heads (beam / spot / wash) with volumetric cones, PAR cans, strobes, blinders, lasers, pixel bars, LED walls, flame
columns, CO2 jets, confetti cannons, gerbs, comets and fireworks, an instanced crowd, the DJ playing the decks - driven by
a show director that picks looks per song section and counts down into drops. Every frame is a pure function of the
shared beat grid, so the studio preview, every OBS page and party guests show the same moment. Rooms without `festival`
pay nothing. The sample room is `assets/scenes/festival_mainstage` (generic, no branding).

| File | Role |
|---|---|
| `shared/festival.ts` | anchor names, tier budgets (`FESTIVAL_BUDGET`, `pickSubset`), the flash gate, scene.json `festival` + `SceneState.festival` sanitisers, `festivalPatch` |
| `shared/festivalLooks.ts` | the preset atoms (40 palettes, 25 motions, 20 rhythms, 10 spreads, 12 accent rules), the rule-filtered generator (327 looks, `LOOKS_VERSION`), 40 shows over 10 genres, `genreForBpm`, `catalogue()` |
| `shared/festivalDirector.ts` | `direct()` (section → look rotation + cross-fades, build countdown, drop sequences, phrase accents, room cues), fixture evaluators (`evalMover`, `evalFlat`, `strobeLevel`, `evalLaser`) |
| `shared/festivalQuality.ts` | the Quality team's first-pass kill list (the default curation) |
| `src/scene/festival/festivalScene.ts` | the room engine: anchors → `StageRig`, state, music → director, DJ pose, drone camera, auto-downgrade, test API |
| `src/scene/festival/stageRig.ts` | every renderer driven from one director frame (shared with the Look Lab) |
| `movers.ts` · `fixtures.ts` · `lasers.ts` · `ledWall.ts` · `pyro.ts` · `crowd.ts` | the renderers (see "Rendering") |
| `src/scene/festival/music.ts` | the music clock adapter (DJ software phrase data → audio beat engine → a 150 BPM auto show) |
| `src/ui/festivalPanel.ts` | Scene tab → 🎆 Festival stage |
| `looklab.html` + `src/scene/festival/lab/lookLab.ts` | the Look Lab (curation page) |

## Room contract

**Fixture anchors**: empties (LED walls: plane / disc meshes with 0..1 UVs) named `FX_<TYPE>_<GROUP>_<NN>`: TYPE one of
`BEAM SPOT WASH PAR STROBE BLINDER LASER PIXEL LEDWALL CO2 FLAME CONFETTI GERB COMET FIREWORK`, GROUP upper-case letters /
digits (`T1`, `DECKF`, `TOWER`, `EYES` …: cues and walls address groups), NN a 2–3 digit index. (The old two-part
`FX_BEAM_xx` of the generic effects rig is not a festival anchor.)

| Type | Extras (glTF) | Notes |
|---|---|---|
| `BEAM` / `SPOT` / `WASH` | `hung` (true = under a truss; else from the anchor's up axis) | pan 0 = towards the crowd (+Z); beams reach for the sky, spots / washes into the crowd |
| `PAR` / `STROBE` / `BLINDER` | `aim` [x, y, z] (room frame), else the anchor's +Z | PARs uplight with a short soft cone |
| `LASER` | - | modes: fan, sheet, tunnel, scan, cross, liquid (a sheet over the crowd), burst |
| `PIXEL` | `length` (m), `pixels` (count) | a bar along the anchor's local +X |
| `LEDWALL` | (the mesh) | per GROUP in scene.json `festival.walls`: `role` main / side / eye, `visual`, `mirror`; the UV orientation is measured from the mesh |
| `CO2` / `FLAME` / `GERB` / `COMET` / `FIREWORK` | `aim` optional | fire up the anchor's up axis (fireworks: up, scattered) |
| `CONFETTI` | `aim` [x, y, z] | where the cannon throws |

Also: `AUDIENCE_AREA_xx` (crowd areas: extras `rx`, `rz` half extents m, `density` people / m², `shape` box | ellipse,
`keepOut` "x,z,r;…"), `AUDIENCE_SEAT_xx` (single places other engines / chat audiences use; the crowd keeps 0.6 m
clear), `FESTIVAL_LOGO` (a hidden mesh whose texture is the emblem the LED walls show - ships inside the GLB). A room
may also use the ambient crowd engine (`crowd` + `ACTIVITY_xx dancefloor`) for animated characters up front.

**scene.json `festival`** (`true` = defaults): `djSpot` (the host there plays the decks), `floorY` / `deckY` / `deckFront`
(where beam pools land), `haze` 0..1, `states` (show level per lighting state; default preshow / show 1, react 0.35,
brb 0.25, outro 0.85), `defaultShow` ('auto'), `title` (LED wall text), `logo` (a file in the room folder; else
`FESTIVAL_LOGO`), `walls`, `palettes` + `shows` (room themes: personal palettes / shows live in room data, never in code;
`auto` prefers the room's own show for the tempo's genre), `cues` (named effect patterns: steps `{kind, group, at, dur,
power, shape}`, fired by a show's `dropCue` / `phraseCue` or by the host), `shapes` (point lists in −1..1: shaped
firework bursts, the flame skyline - a shape named `skyline` fires across the flame heads in the last bar of a drop's
kick run), `crowd` (`unit` = a GLB with meshes CROWD_BODY, ARM_L, ARM_R (origins at the shoulders), PHONE; `color`,
`density`), `drone` (`center`, `radius`, `height`, `secs`: `CAM_DRONE` becomes a slow arc over the crowd, the same on
every page). A festival room sets `ambience.exposure` ≈ 0.3 (a night set: the avatar stage lights must not light it).

More `festival` keys (all optional, sanitised in `shared/festival.ts`):

| key | what it does |
| --- | --- |
| `script` | a scripted endshow: `parts` (bars, palette, section, look hints) + `cues` (bar → effect steps; flame `order` in / out / chase / random + `span`, firework launches lead the beat by `FIREWORK_LEAD` 3.6 s). Scene tab → Play endshow; the script overrides the music's sections and drops while it runs (`shared/festivalScript.ts`) |
| `ambient` | the seeded background show (`ambientEvents`): ambience, ripples every 40–90 s, swells every 3–5 min, big moments every 8–12 min only in a pause in the talk (or on "🎆 Big moment now" / cue `big`); `key: true` adds a neutral key light that follows the speaker with two rims tinted to the show |
| `fxScale` (0.5–3) | the size of the room's pyro: flame columns (width grows with its root) and firework bursts |
| `flameWidth` (0.5–3), `flameSmoke` | fatter flame columns; a smoke puff at a column's base each time it fires (the beams light it) |
| `flameScale` (0.5–4), `flamePatterns` | the cannons' shot height (in full) and fireball size (by its root) - a mega stage's shots read from the back of the field; `flamePatterns: true`: a flame hit without its own chase fires a pattern across the row (centre-out pairs, L→R, R→L, every 4th - the bar picks it), the whole row only on a big hit (power ≥ 1.3). With Safe flashes ON a cannon fires at most one shot per 0.9 s (a held hit re-fires every 1.8 s instead of streaming a column), the stage fires in volleys at least 0.7 s apart (all on the shared page clock: any frame rate, through a stall), the billows roll at half speed, and many balls at once share a smaller light budget (src/scene/festival/flameShots.ts; checked by tools/festival_flame_unit.ts and, drawn, tools/festival_gov_unit.ts) |
| `boost` (1–3) | a room built for a faster GPU: every tier gets this many times its fixture / particle budget (see PERFORMANCE.md) |
| `beamGain` / `laserGain` (0.05–2) | how bright the moving-head beams / the lasers are (a dark set with a lot of structure to show wants less; a dimmed room's laser sheets thin out faster than its rays) |
| `fireLights` | `{groups, count ≤ 6, intensity, range}`: real point lights over the flame anchors of those groups, warm (green on a green flame), through the governor |
| `night`, `nightMetal` | how far the set is pulled into the night; `nightMetal: false` keeps metals out of the night lean (a set lit by its own baked fire) |
| `wash` | `{materials, strength, white, tint}`: the show colour on those materials; `tint` warms the wash (fire light) |
| `walls.<GROUP>.iris` | an `eye` wall's iris colour (`pupil: 'slit'` draws a slit pupil that glows) |
| `showCams` | the show's own camera director: `{cams: [...], bars: 8}` - in Talk with nobody in the room (or Wide / the room's default camera picked) the page cuts through these room cameras on the phrase grid (a cut every `bars` bars; `CAM_DRONE` flies the drone arc). A camera with a `<NAME>_END` empty (glTF extras `target` [x, y, z] in room coordinates + `fov`) MOVES to it over its shot, eased - the scripted endshow's cuts too. A performer close-up, React, Interview and a picked room camera are never taken over. Default none |
| `showCams.grammar` | `true`: that director cuts by the music-locked camera grammar (below) instead of every `bars` bars. Default off (as before) |
| `house` | `'mainstage'` / `'mainstage_magenta'`: the generic hard-dance mainstage house look (below) - 'auto' plays the house show at hardstyle / rawstyle / hardcore tempos, and `structure` + `smoke` come on with their defaults unless the room sets them `false`. Default none (as before) |
| `structure` | `true` or `{floor, intro, pulse, groups, wash}`: the structure (keylight) layer (below). Default none |
| `smoke` | `true` or `{decay, shell, volley, fan, base, low, high, width, gain, halo}`: the lit smoke ceiling + flame halos (below). Default none |
| `shows[].roles` | a room show's colour roles (`{structure: [hex …], beam, beamShare, beamGain, lasers: [hex …], laserShare: [..], blinder, strobe, crowd, quiet}`, every field optional: the house defaults fill the rest) |
| `djCam` | `true`: Talk at the DJ spot uses the room's authored `SPOT_xx_CAM` (a designed DJ shot with the stage behind) instead of the generic face close-up |
| `crowd.lit` / `crowd.rim` / `crowd.boost` / `crowd.flags` / `crowd.flagColors` | how much show light reaches the crowd, a fixed rim colour on the heads (fire light whatever the wash), a denser crowd (1–12), flags on poles held up in the front of the field (`flagsFar` 0..1: that share anywhere in the field) and their colours |

Firework mortars take a glTF extras `color` (hex: a red / green / white battery; willow / salute keep their gold / white), `shellScale` sets the burst size (default fxScale^0.9) and `shellsPerHit` (1-4) fires more mortars per hit. Laser anchors take glTF extras `yaw` / `pitch` (degrees, a fixed aim bias, also on cued fans) and `minPitch` (a high
origin never fans down over the camera's view of the stage). Field materials can be exported unlit
(`KHR_materials_unlit`): a dark mud field under grazing-angle specular reads grey otherwise.

Cue steps (room `cues`, a script's cues) also take `count`, `spread`, `tilt`, `color`, `color2` and the comet styles
`fan` (every unit of the group fires a fan of ~7 comets over 45 deg, the outer ones leaning out), `vfan` (two wings,
+-30 deg), `sunburst` (~28 comets over 170 deg from the group's centre unit), `semicircle` (~18 red-headed comets with
gold tails over 180 deg), `lattice` (each half of the group fires a row of parallel comets leaning toward the other: a
diamond net) and `curtain` (a row of comets straight up across the group). A comet cue on a group with no comet anchors
fires from that group's other effect anchors (flame heads on a roofline make a sunburst up there). Room authors: put
~75 % of the emitters on the structure (pixel bars, uplights on the set) and give the roofline an effect group.

## House look, structure layer, comet fans, lit smoke (shared/festivalRoles.ts, festivalFans.ts, festivalSmoke.ts)

The look of a hard-dance mainstage endshow, as data and tunable defaults (the research numbers are partly read off
stills - every one is a setting):

- **Colour roles per fixture class.** A show (or a room show) with `roles` gives each class its own colour job instead of
  one palette over everything: the set's outline (structure / pixel bars / the stage wash) in red / amber / gold
  (`#b8160c #e2591c #f29a28 #ffc24a`), beams cold white (`#eef2ff` at `beamGain` 0.4) in ~50 % of the peak phrases and
  the palette colour in the rest (never a saturated red: a red phrase's beams play red-orange - a rig of deep-red cones
  sweeping the sky is red-flash content no governor sees), lasers green (`#2bff5a`) in ~80 % of the laser phrases (cyan 15 %, white 5 %), warm
  blinders (`#ffb066`), 5,600 K strobes (`#ffece0`), a violet (`#7a3cff`) or magenta (`#d4207e`) wash on the crowd and
  one deep blue (`#1424a8`) on the show layer in breakdowns; a build bleaches toward white by build². A role show plays
  its own palette on every look. Colours step only on 8-bar phrase lines (and drops), eased over 2 beats. The house
  shows (`hardstyle_mainstage`, `rawstyle_mainstage`, `hardcore_mainstage` + `_magenta`) are appended after every
  generated show - no generated show, look or Look Lab curation index changes - and 'auto' never picks them unless the
  room sets `house`.
- **Structure (keylight) layer** (`structure`): the pixel bars (or the listed `groups` of pixel bars / PARs) and the
  stage wash keep the set's silhouette all show long - a slow level per section (intro / outro 35 %, breakdown ~30 %,
  groove 60 %, build 55-85 %, drop 90 %, eased ~0.6 s), a pulse of at most 15 % (the kick; a slow breath with Safe
  flashes ON), never a flash key, and a floor (7 % of the show level) that no blackout, pre-drop gap or near-dark part
  takes away. Colour: the structure role, else the look's palette spread across the rig, stepping per phrase.
- **Comet fans in one particle slot** (cue styles above): one event carries the whole fan; the spark system's particles
  of that slot are shared out among its comets (a head + an ember trail each). High: a 28-comet sunburst = 3 of the 32
  spark slots; Low draws fewer comets. No new slots or uniforms. The apex is ~1.15 x the stage height (0.8-1.5 x with
  the power), times the root of `fxScale`.
- **Lit smoke + flame halos** (`smoke`): a warm smoke CEILING above and behind the rig - never a veil in front of the
  stage: two huge soft sheets behind the set rising from below its roofline and two over it whose low edge stays above
  the rig's top (one instanced draw; a ceiling sheet seen from above - a drone over the rig - fades). The pyro builds it
  up (+0.06 a shell, +0.02 a flame volley, +0.01 a comet fan, capped at 1, thinning with tau 30 s); the smoke itself is
  dark (it hides the sky, its creases stay dark) and it is lit warm only where there is fire under it (each flame head's
  light pooled along the stage, `#ff6a1a`) or shells bursting in it (their colour pulled two thirds of the way to gold)
  - nothing else lights it; a thick finale ceiling turns orange-gold - plus a soft halo round each firing flame head
  (one additive draw). Its light holds ~3 s, rises over >= 1 s and falls over 2.5 s, then passes the stage governor. The
  sheets blend their colour over the picture with the canvas alpha untouched (an OBS page's transparent pixels only gain
  the smoke's light); it steps back with the show while a React screen is up; hidden (no draw) when there is nothing to
  see; compiled ahead, and when the show that brought it ends it thins away over a few seconds.

## Composed endshows + the camera grammar (shared/festivalCompose.ts, shared/festivalCamGrammar.ts)

**Scene tab → 🎆 Festival stage → 🎇 Endshow**: pick a kind of show (or keep the default) and press **Play an endshow**.
`composeEndshow(template, tracks, room)` builds a whole `FestivalScript` from the room's own effect groups (every anchor,
not a tier's subset: every page composes the same show from `SceneFestivalState.compose`), deterministic per seed:

| template | length | shape (effects budget) |
| --- | --- | --- |
| `main` - Full endshow | ~22 min | a cinematic intro (0.15: accent flames only) · full-force tracks (0.7: an all-unit flame volley on each drop, chases on bars 1 and 5, CO2, gerbs, roof comet fans) · a breather (0.15) · the anthem where the host puts it (0.8, one shell teaser) · premieres climbing 0.5 → 0.9 · a near-dark final break (0.05) · the finale (1.0: fans / sunbursts / curtains / lattices every phrase, a shell every 2 beats, chases every 2 bars, a last salvo) · the outro |
| `closing` - Short closing show | ~12 min | an overture · the closing theme · the finale · linger |
| `acts3` - Three acts | ~30 min | a full-force opener · a calmer look back · the convergence + an encore finale |
| `inverted` - Inverted arc | ~20 min | open at full force, cut almost to dark, rebuild to the finale |

Every drop gets a 1-bar pre-drop gap (the show layer near black, the structure on); the finale's drops step the moving
heads back to 55 % (script part field `beams`, 0..1.2, eased) so the comets and shells own the sky. Validators (`validateEndshow`, any
script): every drop is preceded within 8 bars by >= 1 bar at <= 20 % of the light, no high shells before 40 % of the
show, the finale's cue density >= 1.5 x any earlier drop run's, <= 1 flame volley a bar, shell bursts >= 2 beats apart,
every part and cue inside the show's bars. The show is laid out at the music's tempo when Play is pressed (the studio's
locked beat, else 150 BPM) and lasts the minutes picked: each track's blocks fit its bars (a short track keeps its build,
the gap and the drop), and the show's length is the blocks it walks. A composed show plays the house show
(`script.show`: hardcore from 166 BPM), brings the house look while it runs (`script.house`: the structure layer + the
lit smoke even in a room without `house`) and cuts the cameras by the grammar (`script.camGrammar`). Every effect group it
can fire here (`composeGroupKeys`) stays in every tier, so a low-tier or auto-downgraded page plays the same show. The
script caps are 128 parts / 2,000 cues / 4,000 bars.

API (`POST /api/scene/festival`): `{"compose": "main", "endshow": 1}` plays a composed show now (+ `"min"`, `"anthem"`,
`"bpm"`, `"seed"`: the same body = the same show); `{"compose": "room", "endshow": 1}` - or a plain `{"endshow": 1}` -
plays the stage's own endshow; `{"compose": "main"}` alone only sets the choice up and stops what is playing (a playing
show is never swapped mid-play); `{"endshow": 0}` stops it and ends the composed choice. Moving to another room ends it
too (it never follows the host into another room's endshow).

**The camera grammar** (parts without their own `cams` in a script with `camGrammar`, and `showCams.grammar`): roles
from the camera names - wide (`WIDE`, `FOH`, `PYRO`), aerial (`DRONE`, `CRANE`, `AERIAL`), close (`BOOTH`, `DJ`, `BEHIND`,
`SPOT_xx_CAM`), crowd (`CROWD`, `PIT`, `FACE`), side (`SIDE`, `WING`). Intros / breakdowns hold 4-6 bars; grooves cut
every 2-4 bars; builds tighten (2 bars → 1 bar → 2 beats); the bar before a drop holds a dark wide; the drop's downbeat
cuts to the widest shot and holds it 2-4 bars, then close <-> wide every 1-2 bars, most cuts on beats inside the bar
(~1 in 4 on a bar line), never the same camera twice; shells bursting hold the open shot >= 2-3 bars with short crowd /
close cutaways. A computed **pyro wide** (`PYRO_WIDE`: on the stage's centre line, the roofline at about half the frame
height, the deck at ~80 %, the effects' width in the frame, inside the room and clear of its geometry) is the drop's shot
when shells burst. **Photosensitivity**: a cut changes the whole frame and the light governor never sees it, so the
grammar spaces cuts itself - every cut ON a beat, >= 2 beats and >= 334 ms apart, with Safe flashes ON above 180 BPM only
on even beats (the stage governor's window grid) - and the drop's cut is taken on the same frame as its white hit (the
camera is picked on this frame's beat and the director takes that same number when its own read of the clock, a few ms
later in the frame, is within 1/4 beat). Re-plans (the live grammar re-plans on every section / drop change; a script's
plan is per tempo band and Safe flashes) never add a cut inside the spacing: the cut on screen is kept (`CutGuard`) until
it has been up the spacing, and the same camera under a new plan is no cut. The tempo band is latched (fast from 179.5
BPM, slow again under 177), so a clock jittering around 180 can't flip the plan. The room's `CAM_WIDE` is one of the
grammar's wides. Proven by `tools/festival_grammar_unit.ts` (whole shows at 60-240 BPM, a flapping drop, an analyser
changing its mind every 0.3-3 beats, tempo jitter around 180) and `festival_e2e.mjs dropcut` (the drawn page, every drop).

## Looks and shows (the presets)

Looks are generated like a lighting desk's busking page: palette × movement × intensity rhythm × spread × accent
(strobe / blinder / laser / pyro rules), deterministic, then filtered by rules (strobe-heavy only at energy ≥ 0.75, no
fast movement in chill looks, drop looks need contrast, ≤ 2 hit layers, beams and lasers never both on 16ths, no
movement / rhythm clashes, every layer that flashes faster than 3 Hz is a gated hit layer), scored (affinities, contrast,
novelty across the catalogue) and kept per palette and energy class: **327 named looks** (chill 87, groove 120, drop
120). Shows (what the streamer picks) map song sections (intro, groove, build, drop, breakdown, outro) to looks: **40
shows** = hardstyle, rawstyle, hardcore (170–230 BPM), house, techno, trance, dubstep, drum & bass, big room, chill × 4
palette families, each with its genre's drop sequence. `auto` picks the genre from the tempo and changes family every 4
drops. Curation: `SceneFestivalState.curation` (bitmasks over the look list, `LOOKS_VERSION`) from the Look Lab; without
it the Quality team's first pass (`shared/festivalQuality.ts`) applies.

**The director** (pure): looks rotate every 8 / 16 bars (drops cut, grooves cross-fade 1 bar, breakdowns 2); a build
with a known or predicted drop counts down: beams tighten to the centre, strobes 4 → 8 → 16 per bar over the last
4 / 2 / 1 bars, a half-beat blackout; on the drop: a white hit, blinders, CO2, flames, confetti (every 2nd drop),
fireworks (every 4th), gerbs, a comet 4 bars in, then flames on the kick pattern for 8 bars (every kick alternating
sides for 2 bars, every 2nd kick, then a crescendo, ≤ 24 hits) and the room's `dropCue`; phrase starts in a drop add a
CO2 burst + gerbs. Hardcore, edm, trance, techno, dubstep and chill have their own sequences (`DROP_SEQS`).

## Music (src/scene/festival/music.ts)

1. **DJ software** (the music-clock lane: Pro DJ Link phrases, Link, OS2L …): optional `phrase: {kind, next,
   nextInBeats, known}` fields on the beat packets (tapped on their way into the page's BeatClock - beatClock.ts and
   lightShow.ts are unchanged) or `festivalMusic.ingestClock()`; a known drop is counted down exactly.
2. **The audio beat engine** (today): tempo / phase / energy / sections; a kick-less part becomes a breakdown or (a snare
   roll, a riser near the phrase end, the engine's buildup label) a build; the drop is predicted 8 bars after the kick
   stopped and fires ON its beat once the build is confirmed (measured on a synthetic hardstyle track through the real
   engine: 1 ms from the truth; the engine's own drop event came 0.52 s late).
3. **No music**: a built-in 150 BPM hardstyle arrangement from the wall clock (groove · breakdown · build · drop ·
   groove, 48 bars), the same on every page.

## Rendering

Instanced per class: moving heads (base / head / lens + cones: a unit cylinder shaped in the vertex shader, soft edge ×
throw falloff × scrolling dust noise × haze, a gobo break-up for spots, prisms ×3 on High / Ultra, gobo pools where
spots / washes meet the deck or the floor), PARs / strobes / blinders (lenses + short cones, blinders decay ~300 ms),
pixel bars, laser rays (camera-facing ribbons with a minimum width) + sheets, LED walls (one shader: 12 visuals, an eye,
the logo, the countdown, the warning), GPU particles (pure functions of event slot + age: CO2, confetti, sparks for
gerbs / comets / shells / shaped bursts), flame cannons (real flame-jet shots: every hit fires a burst of rolling fireballs - turbulent billowed balls that shoot up with drag, cool from a yellow core to orange-red to sooty tips and end as a smoke wisp in under a second; a held hit is a column of them, a tilted anchor fires along its +Y; the balls blend premultiplied - colour and alpha One / OneMinusSrcAlpha - so a transparent OBS page keeps the fire and its soot; the warm floor pools + fire lights follow the governed level), the crowd (one
instanced draw, bounce / hands up / fist pumps / phone lights in the vertex shader). Lens glare sprites stand in for
bloom on every tier. Every effect except the flame cannons' fireballs blends ADDITIVELY on colour and leaves the canvas
ALPHA untouched, so the OBS hole and the classic transparent output stay exact; the fireballs blend premultiplied (their
alpha = their own coverage), so over the hole or a transparent page they cover what is behind them like a real flame. Beams / lasers that cross a camera → face line fade out in close shots;
crowd members between the camera and a face, or at the lens, are hidden. The generic effects rig (`vtp:fx`) is hidden
while the festival rig plays; the room's `LIGHT_*` fixtures keep their programs.

**Bloom - the scoped exception to the light show's "no post"**: festival rooms opt into the graphics pipeline's glow
layer (every festival effect is on `GLOW_LAYER`) and set `scene.json gfx` (bloom / glow / haze) for High / Ultra;
Balanced and Low stay post-free (the glare sprites carry the look). OBS transparent output is unchanged (alpha is never
written by the effects; the pipeline keeps alpha premultiplied). In React mode, while a react screen is up (the big one
or the side screen by the DJ), the show steps back to a 15 % glow so no beam, laser or glare washes over the picture or the
OBS hole.

**Photosensitivity**: every full-depth flash (strobes, blinders, the drop's white hit, the stage flash, gated hit
layers, 16th laser chops, the pyro's flash on camera) passes one room-wide gate: ≤ 3 flashes per second (WCAG 2.3.1), a held
flash shows at 10 % depth (the room light show's rule): white strobes / blinders drop to 10 %, colour chases on movers,
PARs and pixels hold steady at 70 % of the look with 10 % of their swing (`heldLevel`), so a gated drop keeps its beams;
beat pulses run half-time above 180 BPM and sparkles thin out with the tempo, so ungated layers also stay ≤ 3 Hz (unit
tested 60–230 BPM). The streamer's opt-out is the existing Lights → "Photosensitivity-safe flashes" toggle: off = real
strobes, and the LED walls show a FLASHING LIGHTS warning card for 8 s, then a badge, for as long as it is off.
Then every drawn output - each moving head, PAR, strobe group, blinder, pixel, laser, the LED walls (level, white flash,
kick pulse), the stage flash, the stage wash, the crowd light and each flame head - passes the room's photosensitivity
governor (`shared/flashGovernor.ts`, the light show's own; `src/scene/festival/gov.ts` binds to `SceneRuntime.lights.gov`
and drives it on the beat grid only when the light show doesn't). The gate shapes the content; the governor is the
guarantee on what is drawn: turns only inside the room-wide windows, so no light goes past 3 flashes a second. A SUM
of lights can still turn between windows (one column stops rising while another keeps decaying - a pulse per window),
so every festival output first passes a stage gate of its own (`FestivalGov`) whose windows are ≥ 333 ms apart on the
beat grid (beats up to 180 BPM, every 2nd beat above): the summed stage pulses at most once per window. A flame head's
drawn light grows ~ with the cube of its level (height × width × brightness), so its governor channel holds the cube;
heads rise in 30 ms (inside the window) and release towards their target.

With Safe flashes ON the stage also guarantees what is DRAWN on every region of the frame, not just per light: every
governed output changes only at a stage window (a 150 ms ramp to the value allowed there, then flat until the next), so
any sum of lights - a region of beams, a wall of PARs - turns at most at the windows; saturated-red outputs are
low-passed (WCAG's red rule is ~6 % of a full red); the movers and lasers move on a calm clock (<= 0.75 beats a second,
eased snaps / shakes / bursts), rays dim with the square of their swing speed (a tunnel's spin counts: half bright at
29 deg/s - the calm clock keeps the looks' own sweeps under ~30 deg/s - a fast sweep is a faint fan), a ray near a protected face line fades over its last 0.85 m instead of dropping
out, the rays' cores are soft and the sheets' scan lines near-flat, and a new laser pattern fades in; beam hot cores and lens
glare toward the camera are softened / low-passed; the LED walls cross-fade >= 0.6 s and their text fades; confetti
glints softly and particles at the lens fade out; the fireballs' billow noise rolls at half speed (and the stage fires in volleys >= 0.7 s apart); crowd members hidden in front of a face
change at most once a second. `tools/festival_e2e.mjs flash` measures the drawn frame (whole frame, stage block, every
1/48 tile with WCAG's luminance AND red rules, every 1/3 x 1/3 region) and lists each turn of a failing second (what
changed where, what fired, frame times); `FLASH_HIDE=<class>` hides one class for A/B, `FLASH_LOOK=<look name>` pins a
look, `FLASH_TRACE=1` adds the laser state per turn and `FLASH_SHOTS=<frames>` saves those frames. Measured under load
(CPU stress + two browsers, 30 windows at 150 / 200 / 230 BPM): luminance tiles and regions <= 2, the red rule <= 3 (29
of 30 windows <= 2), the house rule <= 2. A build without the lights lane uses the festival's own governor with the same rules
(`shared/festivalFlash.ts`) - never "as authored". `tools/festival_gov_unit.ts` models every DRAWN channel (looks, gate,
heldLevel, the strobe-rate cap, the governor, the flame heads' attack / release) through the real director at 150 / 160 /
200 / 230 BPM and fails if any light or the stage summed passes 3 flashes in a second (WCAG counter); limit off: nothing
held, the notice time set. The countdown strobe rate is capped by the gate (≤ 3 Hz with safe on), wall patterns move at
half time above 180 BPM, a room can't lock a wall to the full-field strobe card, and with Safe flashes ON the walls run at half / quarter time and half speed, breathe on a slow cosine pulse (one per four stage-gate windows) instead of the kick, scroll fire as a smooth ramp and draw soft-edged bars (the drawn patches - 1 m, 2 m, 4.2 m of a 32 x 18 m wall, every visual the generator picks, from a CPU mirror of the shader, `shared/festivalWall.ts` - stay <= 2 flashes a second in `festival_gov_unit`), and a flame head releases towards its
(held) target, never to zero. Also with Safe flashes ON (found by the drawn hunt on a composed finale's pyro wide, where
beams fill half the frame): every moving-head beam dims with the square of its swing speed (half bright at ~57 deg/s, never
below 35 %; a snap to a new position is not a sweep - a fan pumping open and shut is a stripe of light crossing a region
several times a second; the calm clock's slow sweeps stay bright), a show's role laser colour is held to a red-ray luminance budget (green is ~3.4 x the luminance of red), shell
crackle / glitter / salute twinkles do not step at all (a steady level), comet fans are dimmer, a light's change into or
out of saturated red carries its luminance through the same governor window (a governor turns a channel once per window:
the colour used to take the token and the red was drawn at the previous gold's luminance, 4-5 x its level - found by the
drawn red-flash sweep on a house-look drop), and camera cuts follow the grammar's spacing, kept across re-plans
(below). The festival's looks / shows / palettes are
registered in the light show's director as `fest:<id>` (its registries are sealed; the 'room' show is replaced with
`{ override: true }` while a festival room is on air and restored after).

**Budgets** (`FESTIVAL_BUDGET`; a room with more anchors gets an even subset per class): Low 24 beams / 160 pixels /
2×8 rays / 300 people, Medium 72 / 420 / 4×12 / 800, High (the RTX 3060 1080p target) 150 / 800 / 6×16 / 1500, Ultra
200 / 1200 / 8×20 / 2400; particle pools High: CO2 3000, confetti 4000, sparks 3000 + 2000 fireworks. Graphics
Performance → Low, Balanced / High → High, Ultra → Ultra; slow frames (under ~27 fps, so a 30 fps OBS source is fine) for 3 s step the rig down a tier (rebuilt;
back up after 60 s of good frames). Measured costs: docs/PERFORMANCE.md "Festival stages".

## Controls

Scene tab → 🎆 Festival stage: the show (Auto or any show by genre, this stage's own first), special effects on / off,
show strength, **Fire now** (💥 Drop! · flames · CO2 · confetti · fireworks · sparks · blinders · blackout - stamped
host-side, every page fires together), 🎇 Endshow (a composed show, the room's own script), the Look Lab and its picks,
the photosensitivity line. Stream Deck / DJ pad:
`POST /api/scene/festival {"cue":"drop"}` (also flames, co2, confetti, fireworks, gerbs, blinders, blackout, `cue:<room
cue>`), `{"show":"auto"}`, `{"pyro":false}`, `{"intensity":0.8}`; bus / MCP `scene {festival: {...}}`.

**The Look Lab** (`/looklab.html`, opened from the Festival section): every look plays live on a mini stage (the same
renderers); ✓ Keep / ✗ Remove / ★ (buttons, ← → ↑, or swipe the stage), filters (state, energy, show), search, a
contact sheet, save / load a file, start over from the Quality pass. "Use these looks on my stage" applies the picks in
the studio at once (a same-origin storage event → `setFestival({curation})`).

## Testing (never on the live bus, never sound)

Test pages: `output.html?sceneTest=festival_mainstage&cam=CAM_WIDE&avatar=mirelle&test=1&gfx=high`;
`vtpOut.festival.info()`, `.force = 1` (show on whatever the lighting state), `.forceTier = 'medium'`, `.noDowngrade`,
`.replay(packets)` + `.seek(ms)` (a recorded beat-packet stream, deterministic), `.dropPlan(showId)`, `.catalogue()`.
`npx tsx tools/festival_unit.ts` (generator, rules, determinism, shows, director, countdown, drops, flash gate, budgets,
anchors, sanitisers), `npx tsx tools/festival_music_unit.ts` (the synthetic hardstyle track through the worklet +
BeatEngine in Node → the adapter + director, scored against the truth), `node tools/festival_e2e.mjs
<smoke|timeline|heroes|perf|lab|sheets|all> --out <dir>` (private server, one muted headless Chrome: the track through
the stage, stills from every camera, frame times per tier, the Look Lab at desktop / phone, contact sheets). The house look
/ endshow units: `tools/festival_roles_unit.ts` (roles, house shows, the structure floor, drawn through the governor),
`festival_fans_unit.ts`, `festival_smoke_unit.ts`, `festival_compose_unit.ts`, `festival_grammar_unit.ts`; e2e modes
`composed`, `composedheroes`, `dropcut` (`--compose main|closing|acts3|inverted`; `DROPCUT_DRIFT=<ms>` moves the clock
on at every read inside a frame and `DROPCUT_PRE=<ms,...>` lands the drop that long into a frame - the camera's and the
director's reads straddle it), `smokeab` (the same frame with the lit smoke shown / hidden, each moment played into in
real time: the room governor runs on the wall clock) and `flash --compose main` (the composed finale's densest moments
with the camera cuts on; `FLASH_SWEEP=<n>` / `FLASH_AT=<epoch ms>` sweep / replay show cycles of the auto show). Test
hooks: `.forceCut = 'PYRO_WIDE'`, `.camLock`, `.cutNow`, `.keptGroups`, `.grammarCamList`, `info().house`.

**Building a festival room**: `assets/scenes/festival_mainstage/blender/fs_lib.py` (the kit: glTF-space helpers,
materials, primitives, truss beams, `fx()` anchors, cameras, the night bake, export, the live-window runner),
`fs_paint.py` (textures), `fs_mainstage.py` (the sample). Personal themed stages keep their build scripts and themes in
the owner's untracked room folder.
