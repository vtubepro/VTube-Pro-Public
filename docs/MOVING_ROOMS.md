# Moving rooms

Some VTube Pro rooms don't sit still. A battle rages outside the window, ships land on pads, a harbour bobs on the
swell, the whole set walks across a desert, or the room changes era around you. This guide is in two parts:

- **[For streamers](#for-streamers)**: what a moving room is, how to pick one, what the cameras do, and how to keep it
  smooth. No technical words.
- **[For creators and AIs](#for-creators-and-ais)**: how to build your own moving room, with a small worked example
  and safe ways to test it.

---

## For streamers

### What is a moving room?

A normal room is a set: you sit in it and it looks the same all show. A moving room has a show of its own going on
around you. There are four kinds:

| Kind | What you'll see |
|---|---|
| **A world outside** | Something big happens beyond the windows: a space battle, ships landing and taking off, a race, a busy harbour. Your room stays where it is |
| **A room that travels** | Your whole set rides on something that moves, like a walking ship crossing an endless desert. The land streams past; your deck stays steady |
| **A room that changes** | The time of day and the weather change, or the whole set shifts to a different era with a ripple of light |
| **Moving entrances** | You and your guests arrive in style: walk in through the door, thaw out of a cryo pod, or leave in a drop pod fired at a planet |

You never have to drive any of it. It runs by itself, and you can turn the action up, down or off.

> **Everyone sees the same thing.** Your studio preview, your OBS and every guest's OBS show the same battle, the same
> ship and the same weather at the same moment, without sending video. A page you open late lands in the middle of
> whatever is happening.

> **Your face always comes first.** Ships, explosions, smoke and background characters never pass in front of a
> performer's face or the React screen. They fade or stay behind.

### Get a moving room

The moving-room engine is built into VTube Pro. No ready-made moving room ships in this repository, so you make one
(or have your AI make one) and add it. Rooms built with the engine can have, for example:

| What moves | Example |
|---|---|
| A space battle outside the viewport | Fighters, warp jumps, orbital barrages, a planet at war. Guests can arrive by cryo pod and leave by drop pod |
| An endless ship race | A ring of gates, skirmishes, a bar full of regulars |
| Traffic | Ships landing on and leaving pads, big ships cruising past, streams of flying cars |
| A living harbour | Boats on the swell, a sailing ship, gulls, townsfolk, weather |
| Time and place | A swirling void, time rifts that open and close, and era shifts |

1. Build one (see [For creators and AIs](#for-creators-and-ais)) or get a room file from a friend.
2. In **Room** → **Change room** press **＋ Add my room** and pick it ([Rooms: the easy way](ENVIRONMENTS_SIMPLE.md)).
3. Press **Use it now**.

### Pick a moving room

1. Open **Room** → **Change room**.
2. Look at the small badges on each card. Moving rooms show things like **Space battle outside**, **Traffic**,
   **Town life**, **Era shifts** or **Time of day & weather**.
3. Click the card. Your avatar walks in and takes a seat. OBS shows the same room.

**What you'll see:** the room loads like any other, then the action starts on its own. A space battle starts with the
odd patrol; a walking ship starts walking; a harbour starts bobbing.

### Turn the action up, down or off

Each moving room adds its own section to the **Room** page (turn on the **Advanced** switch at the top of the page if
you don't see it). You only see the sections the room supports.

| Section | What you can change |
|---|---|
| **Space battle** | **Intensity** (Chill, Normal, Hot), **Frequency**, which parts play (**Fighters & dropships**, **Warp jumps**, **Orbital barrages**, **Orbital lasers**, **Combat on the planet**), **Red alert on the bridge**, **Camera shake on explosions**, and **Cryo-pod join** / **Drop-pod leave** |
| **Voyage (walking ship)** | **Anchor** (the ship slows to a stop) and **Weigh anchor** (it walks on), **New voyage**, the pace (**Chill**, **Normal**, **Hot**), which events play (**Battles**, **Sandstorms**, **Treasure sorties**, **Cities**), **Deck motion**, **Cutaways (Talk)**, **Exterior cams**, **Chat votes the route** |
| **Yacht life** | The crew, the ships outside and the shows |
| **Time & weather** | Morning, noon, evening, night; clear, rain, storm, snow, fog (outdoor rooms) |
| **Eras** | Which era the room is in, and how often it shifts |

Only the host steers. Guests' OBS pages follow the host automatically.

### Tips and chat can set things off

Many moving rooms react to your stream's support (tips, Super Chats, subs, memberships, Kicks):

- In a space room, a tip can call in an **orbital barrage** with the supporter's name, and a big one brings a
  **threat**: an enemy warship warps in, charges its gun at you, and is torn apart.
- On a walking ship, small tips fire a **Steam whistle** or a **Salute shot**; bigger ones bring **Fireworks**, a
  **Broadside**, a raider to fight (**Summon a raider**) or a treasure stop (**Dig here!**). A raid brings a convoy
  alongside. Chat can vote which way the ship goes next (**Chat votes the route**).
- In the yacht, race and harbour rooms, support brings drinks, salutes, fireworks or cheers.

You set the amounts in each room's **Support events** part. Every page plays the same thing, so your guests' streams
show it too.

### What the cameras do

You don't need to do anything: the cameras are planned for you.

- **While you talk**, the normal room cameras are used. On a walking ship the deck cameras stay steady; only the
  horizon rocks. **Deck motion** sets how much (0 = still). In **React** and **Gaming** the deck is always still.
- **Your camera choice sticks**: while you talk the camera stays where you put it. It only changes when you pick another camera (or switch to
  **Preshow**). If you want the odd outside shot of a big moment, turn on **Cut away while I talk** (Scene tab ->
  **Voyage**, off by default): then the camera may cut outside for a few seconds when something big happens (a battle, a
  city, a storm), at most once every 90 seconds and only after you've stopped talking for a moment; picking a camera
  ends a cut at once. Never in React, Gaming or Interview.
- **Preshow**: in a walking-ship room, switch the lighting to **Preshow** and the cameras leave the deck by themselves:
  wide establishing shots, crane shots, slow orbits, low tracking shots, flybys, shots under the walking legs and past
  burning wrecks, plus the odd slow shot of you on the deck, all at night under a sky that pulses with your music. The
  cuts land on the beat: quick on a drop, slow in a breakdown. Switch to **Show** and you're back on the deck at once.
- **Ambient cameras**: in any room, **Show** → **Ambient cameras** gives slow pans, orbits and crane moves during
  **Preshow**, **BRB** and **Outro**.
- **Entrances**: with **Camera follows my entrance** on (**Room** → **Camera**), a camera follows you from the door
  (or the cryo pod) to your seat, then goes back. **…and guests’ entrances** does the same for guests.

### The Preshow light show

Some open-air rooms (and every walking-ship room) have a **show sky** for **Preshow**: stars that twinkle with the hi-hats,
a nebula that swells on the drop, aurora curtains, planets and moons, meteors on the snares, and searchlights and laser
fans that move with your music.

- It follows the same music as the room's light show. With no music input it plays a gentle built-in groove, so it
  still looks alive.
- It never flashes the whole screen: pulses are smooth (safe for viewers sensitive to flashing light).
- No sound is played or recorded by it.

### Keep it smooth

Moving rooms draw more than still ones. VTube Pro picks a sensible quality for your computer by itself, but if your
stream stutters:

1. Open **Room** → **Graphics quality** and pick a lower level (**Performance** is the lightest). Effects, smoke and
   far details are trimmed first; your avatar keeps its look.
2. Turn the action down: a lower **Intensity**, or switch off the parts you don't need (for example **Combat on the
   planet**).
3. Close extra studio tabs and preview windows. Even hidden, they draw the room too.
4. A walking ship's effects get lighter by themselves when the voyage gets expensive.

### If something looks wrong

| What you see | What to do |
|---|---|
| Nothing moves | Check the room's own section in **Room** is on (for example **Space battle** or **Voyage (walking ship)**). A message like *"This room has no viewport onto space"* means that room doesn't have that feature |
| The battle or ship is in a different place in my guest's OBS | Ask them to refresh their OBS page. Every page follows the host's clock, so it lines up again |
| The camera never leaves the deck in Preshow | Preshow exterior shots need **Talk** mode and no game capture or layout on screen |
| It stutters | See [Keep it smooth](#keep-it-smooth) |

---

## For creators and AIs

This part is for people (and AI agents) who build rooms. Read **[For 3D artists: rooms](ARTIST_ENVIRONMENTS.md)** first:
a moving room is a normal room (places, cameras, screen, door) plus one or more motion layers switched on by keys in its
`scene.json`.

### The four rules every moving room follows

1. **Everything is a function of the clock.** No layer keeps a running state: each motion is computed from the wall
   clock (and the host's stamped events), so the preview, every OBS page and party guests agree with no messages. When
   you author motion, make it a loop or a path the engine samples, never something that accumulates.
2. **Never key an engine-driven node.** If an engine moves a node (a bobbing boat, a ship on a lane, a door, a spot, a
   camera), animate a child of it instead. The engine's motion and yours then add up.
3. **Faces and the React screen stay clear.** Engines fade things behind faces and keep effects outside keep-out boxes.
   Don't put a path, a lane or a flight corridor between a camera and a performer's spot.
4. **A room without the key pays nothing.** Every engine checks its `scene.json` key once and does nothing otherwise, so
   adding motion to one room never slows another.

### The building blocks

<!-- Verified against the code on lane/b12-docs (integrate/beta12 479a857 merged, 2026-10-06). Sources: src/scene/roomClips.ts,
     src/scene/traffic/{config,trafficScene}.ts, src/scene/space/{spaceRoom,spaceMover}.ts, shared/space.ts,
     src/scene/voyage/{voyageScene,voyageRoom,voyageShip,voyageCams,voyageDeckCam}.ts, shared/voyage.ts, shared/desert/*, shared/showSky.ts,
     src/scene/showSky/*, src/scene/environment/index.ts, src/scene/epoch/eras.ts, shared/forms.ts,
     src/scene/walkMover.ts, src/scene/followCam.ts, shared/ambientCam.ts, src/output.ts (test URL params). -->

| What you want | How | Details |
|---|---|---|
| Parts that loop (fans, radar dishes, flags, flickering signs) | glTF animations in `scene.glb`: no `scene.json` key needed | [Moving parts](#moving-parts-room-clips) |
| A prop that travels a path (a drone, a cleaning bot) or spins | `traffic.roam` / `traffic.spin` | [Props on a path](#props-on-a-path) |
| A world outside the window (space battle) | `space` + `SPACE_*` anchors | [A world outside](#a-world-outside-the-window) |
| Ships, cars and trains in the sky | `traffic` (pads, lanes, a ships GLB) | [A world outside](#a-world-outside-the-window) |
| The whole room travels | `voyage` | [A room that travels](#a-room-that-travels-voyage) |
| A music-reactive night sky with searchlights | `showSky` | [Music-reactive sky](#music-reactive-sky-and-lights) |
| Time of day, weather, night lights, wind | `environment` | [Light that changes](#light-that-changes) |
| The set changes era | `eras` | [Light that changes](#light-that-changes) |
| Seats that rise or move with the set | `forms` spots with `ride` | [Spots that ride along](#spots-that-ride-along) |
| Arrivals and departures | `DOOR` / `PATH_xx`, or cryo / drop pods | [Moving entrances](#moving-entrances) |

### Moving parts (room clips)

Any animation exported in `scene.glb` loops forever. The engine poses every clip at *room clock mod clip length* (the
room clock is the seconds since midnight UTC), so all pages show the same pose.

- In Blender, make one action per object (or shape-key block) and export with **Animation → Actions**. Make each a
  seamless loop: the last key equals the first, a whole number of frames at 24 fps. Clips of different lengths are fine.
- Node position, rotation, scale and shape-key weights all work.
- **Hide effects with a zero scale.** To pop a flash or a puff now and then, scale it to 0.0001 on all three axes
  between cues. While collapsed it isn't drawn at all (no cost). Don't flatten just one axis: a flat mesh still draws.
- Never key a node an engine moves (see rule 2). Key its child.
- A room with no animations creates nothing (zero cost).

### Props on a path

The sky-traffic engine also moves single room nodes. Put this in `scene.json`:

```json
"traffic": {
  "roam": {
    "DRONE_01": { "path": [[-3, 2.6, -2], [3, 2.6, -2], [3, 2.6, 2], [-3, 2.6, 2]], "closed": 1, "speed": 0.6, "bob": 0.05 }
  },
  "spin": { "RADAR_DISH": 0.1 }
}
```

- `roam.<NODE>`: `path` (at least 2 points, in metres in the node's parent space: room space for a top-level node),
  `closed` (1 = a loop) or `pingpong` (1 = there and back; an open path without it stops at its end), `speed` (m/s,
  default 0.4), `bob` (m of up-and-down), `pause` (s at each end for pingpong). On a loop or a pingpong path the node's
  front (+Z) turns to face along the path.
- `spin.<NODE>`: turns per second about the node's own up axis.
- The `traffic` key also tries to load landing ships (`traffic/ships.glb` + `traffic/ships.json`). Without those files
  you only get a harmless note in the browser console; roaming and spinning still work.

### A world outside the window

**Space battle** (`space` key, or any `SPACE_*` anchor): a battle beyond a viewport, deterministic and host-seeded.

| Node | Meaning |
|---|---|
| `SPACE_VIEW` | The window: origin at the glass centre, extras `normal` (outward), `width`, `height` |
| `SPACE_PLANET` | Extras `radius`. Or name your own planet mesh `PLANET` (or `space.planetNode`) |
| `SPACE_SHIP_xx` | Parked capital ships (extras `kind`: `destroyer` / `frigate`, `length`) |
| `SPACE_LANE_xx`, `SPACE_WARP_xx` | Flight corridors (extras `links`) and warp-in points |
| `SPACE_CANNON_xx` | Your own ship's guns: barrages and lasers fire from here |
| `SPACE_BATTLE_xx` | Surface targets on the planet |
| `SPACE_KEEPOUT_xx` | Boxes effects never enter (your bow, your superstructure) |

`scene.json`: `"space": { "acts": [...], "planetNode", "cannonNodes", "fireFrom": "cannons", "podSize", "view", "sky": false }`.
`acts` keeps only the acts that fit your setting: `patrol`, `pelican`, `flyby`, `dogfight`, `strafe`, `warp`,
`barrage`, `laser`, `hellbomb`, `threat`, `pod`, `fleet`, `planet` (or the group `fighters`). Missing = all of them.

**Sky traffic** (`traffic` key): landing pads, cruise lanes, car streams and trains, with a ships GLB. Every ship is a
function of the clock. Use `pads`, `lanes` (`points`, `closed`, `cars`, `speed`, `ships`, `every`, `vehicle`, `train`),
`busy`, `cars`, `parked`, `ads`. For rooms kilometres wide, keep far geometry apart and compress the far city towards the
viewer (depth precision).

### A room that travels (voyage)

A room with a `voyage` key is a ship that walks across an endless procedural desert. **The ship never moves.** Your
room, its spots and every `CAM_*` stay exactly where you authored them; the world (terrain, rocks, cities, enemies) carries
the inverse of the ship's motion and streams past. So your cameras, your framing checks and your spots all keep working.

**The ship.**
- Your own walker: model the legs as `LEG_<id>_COXA` > `_HIP` > `_KNEE` > `_ANKLE` > `_FOOT` (ids `FL ML BL FR MR BR`, or
  `L1…` / `R1…`), with each node's origin on its joint. Turrets are `TURRET_<n>` > `_GUN` > `_MUZZLE`; hull hit sites
  `DAMAGE_01…08`; a hinged ramp `GANGWAY`; `LANTERN_*` / `PENDULUM_*` swing with the hull.
- No legs? The engine draws a stand-in walking ship under your floor (`"ship": "procedural"`). Your room's floor
  becomes its deck. It's a good way to start; replace it with your own legs later.
- Frame: origin = the show deck floor centre, +Y up, the bow towards −Z. A ship modelled facing another way: set
  `forward`, or add a `VOYAGE_BOW` empty ahead of the origin. The ship always walks bow-first.

**What moves, and how** (`voyage` keys, all optional):

| Key | Meaning |
|---|---|
| `ship` | `"auto"` (default: your `LEG_*` rig, else the stand-in), `"room"`, `"procedural"` |
| `groundY` | Where the sand is, below the deck (m, negative). Or a `VOYAGE_GROUND` node |
| `gait` | `stride` (m, default 6), `duty`, `lift` (m), `kneel` (m), `speeds` `{cruise 3.0, city 2.2, battle 4.2, storm 1.7}` m/s |
| `body` | How the hull rides: `heave`, `rollDeg`, `pitchDeg`, `impulseDeg`, `terrainPitchMax` |
| `modeGain` | Deck motion per show mode (defaults: Talk 1, Interview 0.6, TTRPG 0.8, React 0, Gaming 0) |
| `pacing` | `"chill"` (25 min chapters), `"normal"` (20), `"hot"` (15), until the host picks one |
| `dangerSide` | Where enemies prowl: `"port"`, `"starboard"`, `"aft-port"`, `"aft-starboard"` |
| `keepOut` | How far effects and shells stay from spots, the hull and the lens; `fireArcFromSpots`, `fireArcBox`, `fireArcSlots` keep gunfire lines away from people |
| `turrets` | `{ "TURRET_1": { "yawDeg": [min, max], "elevDeg": [min, max] } }` |
| `below` | `lanterns` (node names that swing), `sway`, `portholes` |
| `forward` | Which way the model's bow faces: `"-z"` (default), `"+z"`, `"-x"`, `"+x"`, or `"auto"` (the `VOYAGE_BOW` node, else the hull's pointed end) |
| `preshow` | The Preshow exterior show, or `false`: `exterior`, `always`, `hour`; `cuts` (`"music"`, the default: shots start on bar lines, `bars` per shot by section `{drop, build, groove, breakdown}`; or `"clock"`: a fixed `shot` length in s); `moves` (any of `RISE ORBIT TRACK HERO SKYWARD FLYBY FEET ESTAB UNDER WRECK DECK PUSHIN LASERS`); `performer` (share of shots on a performer, 0–1, default 0.3); `storm` (the most sandstorm shown in Preshow, 0–1, default 0.3) |
| `broll` | Short exterior cuts during the show (Talk mode, **Show** lighting) while the performer is quiet: `true` or `{ "every", "bars", "quiet", "moves" }`. Off by default, and only plays when the streamer has turned on **Cut away while I talk** |
| `extCams` | Tune the exterior camera moves (`CAM_EXT_CRANE`, `CAM_EXT_DOLLY`, `CAM_EXT_PUSH`, `CAM_EXT_LOOP`, `CAM_EXT_DRIVEBY`, `CAM_EXT_BATTLE`) |
| `world` | `provider` (`"desert"`, the default, or `"placeholder"`). The desert's look: `relief` (mesas, cliffs and ridges away from the route, 0–1.5), `haze` (0.4–2.5), `wrecks` (burning wrecks, 0–2), `skyline` (distant ruined towns, 0–2), `drift` (blowing sand, 0–2), `moonlight` (how well the land reads at night, 0–2); all default 1. The placeholder world takes colours and fog |
| `labels` | The room's own names for event kinds, shown on banners and Studio buttons, e.g. `{ "special": "The cook's special" }` (40 characters at most) |
| `rewards` | Kick channel-point reward keywords → an event kind |
| `support` | `{ "tiers": [1, 3, 5, 10, 20, 30, 50] }`: the amounts for the whistle, salute, special, broadside, fireworks, battle and treasure |
| `nodes` | `ground` (default `VOYAGE_GROUND`), `fallbackGround` (default `FALLBACK_DESERT`): a static ground mesh hidden while the world streams |
| `seed`, `far` | The route's seed, the camera far plane while it runs (m, default 2600) |

Any node with the glTF extra `voyageHide: true` is hidden while the voyage runs (a placeholder floor you only want in the
editor, say), and shown again when it stops.

**Spots that ride along.** On a voyage everything on the deck rides by definition: the world moves, not the room. Keep
spots on the deck, inside the hull, and out of the gunfire lines (`keepOut`).

**Cameras.** Deck cameras are yours and never move. The engine adds Talk-only cutaways, optional b-roll, the Preshow
exterior show (cut on the music's bar lines) and, with the host's ambient cameras on, an exterior program for Preshow, BRB
and Outro. In Talk the engine never cuts away unless the streamer turns on **Cut away while I talk**. Every exterior
shot is planned before it starts: the whole move is checked against the sand, the rocks, landmarks and wrecks on it and
the hull while the ship walks on; the lens rises smoothly over dunes (never through them, never a jump) and keeps the
walker in sight, and a shot that can't be cleared is swapped for another angle. The performer shots (`DECK`, `PUSHIN`) only use angles that keep the performer's face
and chest in view; a room with no performer gets none.

**Light.** Add `"environment": {}` (or a fuller block, below) and the voyage drives it: the journey's hour (day and
night pass with the chapters; Preshow, BRB and Outro keep their own hours), sandstorm weather, and the sun's direction
as the route turns. Performers are never fogged.

### Music-reactive sky and lights

`"showSky": true` gives an open-air room the default night sky (a ringed giant and two moons) in **Preshow**. Or set it
up:

```json
"showSky": {
  "states": ["preshow", "outro"],
  "stars": 1, "nebula": 1, "aurora": 0.8, "meteors": 1, "pulses": 1,
  "bodies": [{ "kind": "giant", "az": -25, "el": 26, "size": 22, "color": "#d9a066", "color2": "#7a4a3a", "ring": true }],
  "beams": [{ "at": [2.4, 3.2, -3.9] }, { "at": [-2.4, 3.2, -3.9] }],
  "lasers": [[0, 6.5, -6.3]]
}
```

- `states`: any of `show`, `preshow`, `brb`, `outro` (default Preshow). Strengths are 0–2 (0 = off).
- `bodies` (up to 6): `kind` `giant` / `moon` / `planet`; `az` 0 = the room's −Z, 90 = +X; `el` above the horizon;
  `size` in degrees; optional `ring` and `glow`.
- `beams` (up to 12): searchlight feet in room metres; they lean outward and change pattern with the music's phrases.
  `lasers` (up to 3): laser fan origins.
- It reacts to the room's music analysis (the same as the light show), or a built-in 120 BPM groove with no music. No
  full-frame flashes.

The room's own lights react to music through the light show: give fixtures `LIGHT_*` nodes and emissive materials named
`EMIT_<group>`, as in [For 3D artists: rooms](ARTIST_ENVIRONMENTS.md).

### Light that changes

- **`environment`**: time of day, weather, night lights, wind and rain. The minimum is `"environment": {}`. Typical keys:
  `sky` (`procedural` / `room` / `none`), `climate` (`temperate`, `jungle`, `city`, `coastal`, `arid`), `north`,
  `sunrise`, `sunset`, `default` (`clock`, `hour`, `speed`, `weather`), `night`, `nightLights`, `dry` (rain-free boxes, or
  `ENV_DRY_*` nodes). Lamps named lantern, lamp, street, window, torch, candle and similar switch on at dusk by themselves.
  Foliage and cloth materials sway in the wind by name.
- **`eras`**: a list of backdrop sets (a node in the room, or its own GLB) with their own sky, fog, light and weather. A
  shift grows a time crystal, then a ripple dissolves the old set and builds the new one. The stage itself never changes.
- **Lighting states** (Preshow, Show, React, BRB, Outro) are the host's; rooms can pin weather and hour per state
  (`environment.weatherByState`, `hourByState`).

### Spots that ride along

Room **forms** (`forms` key) reshape the set for who is sitting there (a booster riser for a small host, a docking cradle
for a mech). A form's spot can `ride` a node: the spot moves with that node's animated offset, so a chair rising on a
riser carries the performer with it. All form motion is tweens from the node's rest pose. The full rules are in
`shared/forms.ts`.

### Moving entrances

- **Walk in** (every room): `DOOR` (a hinge), `DOOR_OUTSIDE` (where people wait), `PATH_01…` (the lane in), and optional
  `COLLIDE_*` boxes to walk round. Everyone's OBS shows the same walk.
- **Cryo pod join** (`"entrance": "cryo"`, or any `CRYO_POD_xx`): pods with a `_door` hinge (or extras `open: slide_up`)
  and an `_out` step-out point, `JOIN_PATH_xx` to the main room, `CAM_CRYO` to watch the thaw.
- **Drop pod leave** (`"exit": "droppod"`, or any `DROP_POD_xx`): pods with a `_hatch` and `_board` point, a
  `LAUNCH_TUBE_xx` (extras `start`, `end`, `exitDir`, `target`), `LEAVE_PATH_xx`, `CAM_DROPBAY`, and `CAM_VIEWPORT` for
  the re-entry streak seen through the window.
- **Follow camera**: during a walk-in a camera operator (from `CAM_WIDE`, `CAM_DOOR` and the other cameras) pans with
  the walker and cuts only when it loses their face. Make sure at least one camera sees the whole path.

### Worked example: a desert skiff deck

A small open deck that rides a walking ship, with a spinning radar dish, a swinging lantern, a night sky with
searchlights for Preshow, and day and night passing. Everything here is sample content you can copy.

**In Blender** (metres, +Y up in glTF, stage front +Z): a 6 × 4 m deck floor at height 0 with a rail, two seats, and the
usual anchors from [For 3D artists: rooms](ARTIST_ENVIRONMENTS.md): `SPOT_01`, `SPOT_02`, `CAM_WIDE`, `SPOT_01_CAM`,
`SPOT_02_CAM`, a 16:9 `SCREEN` with `CAM_REACT`, and a deck hatch as the door: `DOOR`, `DOOR_OUTSIDE`, `PATH_01`. Then
the moving parts:

1. `RADAR_DISH` on a mast: give it a 10-second action (240 frames at 24 fps) that turns it 0° → 360° about its up
   axis, with **linear** interpolation so the loop has no ease at the seam. Export with **Animation → Actions**.
2. `LANTERN_01`: a lantern hanging from the rail, origin at its hook (it swings about that point).
3. `BEAM_L` and `BEAM_R`: two small searchlight housings on the rail behind the seats, on the bow side (−Z) the
   cameras look towards (just meshes; the beams come from `showSky`).

**`scene.json`** (only the moving parts shown; keep your usual `name`, `spots`, `cams` and so on):

```json
{
  "environment": { "sky": "procedural", "climate": "arid" },
  "voyage": {
    "ship": "procedural",
    "groundY": -12.844,
    "pacing": "chill",
    "dangerSide": "aft-port",
    "gait": { "speeds": { "cruise": 2.6 } },
    "below": { "lanterns": ["LANTERN_01"], "sway": 0.6 },
    "preshow": { "hour": 21.3 }
  },
  "showSky": {
    "beams": [{ "at": [2.6, 1.4, -1.9] }, { "at": [-2.6, 1.4, -1.9] }],
    "bodies": [{ "kind": "giant", "az": -30, "el": 24, "size": 20, "color": "#d9a46c", "ring": true }]
  }
}
```

What each part does:
- `voyage` puts the deck on the stand-in walking ship 12.8 m above the sand, walking slowly with long chapters. Enemies
  come from behind on the left. The lantern swings with the hull.
- `environment` lets the journey move the sun and bring sandstorms.
- `showSky` gives Preshow a sky with a ringed planet behind the seats and two searchlights from the rail, both moving to
  the music.
  Their feet match the `BEAM_L` / `BEAM_R` housings.
- The radar dish needs no key: its clip loops by itself.

### Test safely (never on your live stream)

Test pages draw the room on their own and never touch the live studio, OBS or your library. They work on VTube Pro's
own address (`http://127.0.0.1:5191/`).

1. Put the room folder in your rooms (**Room** → **Change room** → **＋ Add my room**), or test from a private copy.
2. Open `http://127.0.0.1:5191/output.html?sceneTest=<room id>` in a browser tab (mute the tab). Add `&cam=CAM_WIDE`
   (or any camera) and `&gfx=low` / `&gfx=high` to compare quality levels.
3. Jump to moments:
   - Walking ship: `&voyage=battle` (also `approach`, `storm`, `treasure`, `kneel`, `city`, `night`, `day`, `fork`,
     `cruise`) with `&voyageAt=<seconds after it>`; test events `&voyageEv=fireworks@3,battle@1`; a different route
     `&voyageSeed=<n>`. Try the stand-in ship under any room with `&voyageCfg=demo`.
   - Space: `&space=hot&spaceSeed=7&cam=CAM_VIEWPORT` (`chill`, `normal`, `hot`, `off`; `&spaceAt=<s>`).
   - Race and lounge rooms: `&raceway=armada@3,lap@5`; the yacht: `&yacht=fireworks@3`.
   - Preshow sky with a fake beat (silent): `&beatDemo=124`.
4. In the browser console: `vtpOut.voyage.info()`, `vtpOut.space.debug()`, `vtpOut.showSky.info()`,
   `vtpOut.scene.clips.count` (room clips), `vtpOut.traffic.debug()`.
5. Close the tab when you're done: even hidden, a test page draws every frame and can slow live tracking.

AI agents: use the `check_room` tool and the [room checklist](ARTIST_ENVIRONMENTS.md) first, follow the house rules in
[AGENTS.md](../AGENTS.md) (never the live bus, never sound), and judge the result from 8+ camera angles in the app's
renderer, at Performance and at High.

### Checklist before you share a moving room

- [ ] Every motion is a loop, a path or an engine key: nothing that only looks right on one page.
- [ ] No engine-driven node is keyed in a clip.
- [ ] Nothing moving passes between a camera and a face, or over the React screen.
- [ ] The room looks right with every motion layer off (a host can switch them off).
- [ ] Frame time measured at **Performance** and **High** on the cameras people will use.
- [ ] No game files, no personal content, licences respected ([RESOURCES.md](RESOURCES.md) section 7).
