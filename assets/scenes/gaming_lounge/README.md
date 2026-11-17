# Gaming Lounge (`gaming_lounge`)

The party's room for **Gaming** mode with three or more performers (docs/SCENES.md → "Stage modes"). A streamer den:
eight gaming chairs in a gentle arc facing the camera, a big wall screen behind them with an LED backlight, hexagon light
panels, acoustic foam, shelves with collectibles, neon, a sofa corner, a streaming desk and a snack fridge. Everything is
scripted (no textures): flat materials + baked vertex light + emissive LED groups the light show drives.

Build (Blender 5.1):
```
tools\blender_low.cmd -b --factory-startup --python assets/scenes/gaming_lounge/blender/gl_room.py          (headless)
"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" --factory-startup --python assets/scenes/gaming_lounge/blender/gl_room.py -- --live
```
`--live` builds step by step in a visible window (the view orbits each new part, the header shows the step), then
exports. `VTP_ROOM_OUT=<folder>` writes scene.glb / scene.json elsewhere (review builds). Hand-added scene.json keys
(ambience, lights, gfx, screenSkin, soloScreens, stage …) survive a rebuild.

## Contract
| Node | What |
|---|---|
| `SPOT_01` … `SPOT_08` | the gaming chairs, left → right seen from the camera (SPOT_01 = the host; Gaming seats guests in join order); sit, seatHeight 0.5 |
| `SPOT_09` … `SPOT_12` | the sofa along the left wall, facing into the room |
| `SCREEN` | the big wall screen (restOffsetY 0: it powers on in place) |
| `CAM_WIDE`, `CAM_REACT`, `CAM_LEFT`, `CAM_RIGHT`, `CAM_SOFA`, `CAM_DOOR` | presets |
| `DOOR` / `DOOR_OUTSIDE` / `PATH_01..03` | the entrance on the right wall |
| `COLLIDE_*` | chair-row side tables, sofa, desk, fridge, console |
| `CHAT_MONITOR`, `CHAT_BOARD`, `BUDDY_SPOT` | chat props for Talk in here |
| `LIGHT_*` | LED strips / cove / hex panels / neon / ON AIR / RGB / screens (emissive groups `led`, `led2`, `hex`, `neon`, `sign`, `rgb`, `screens`, `lamps`, `glow`, `onair`) + two spot cans and a sofa lamp |

scene.json `stage: { tileCams: "front", palette: "lounge" }`: the Gaming strip's cams look straight at each chair (every
chair has its own accent colour and its own slice of the back wall), and the docked panels / backdrop use the lounge
palette (magenta / cyan).
