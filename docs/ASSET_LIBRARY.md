# Local asset library (`assets/library/`)

CC0 props, sounds and the animation library, staged for future room building. **Nothing here is loaded by the app
yet** except `anims/` (see docs/ANIMATION_LIBRARY.md). Existing rooms are not modified. (Not to be confused with the
top-level `library/`, which is the user's avatar library.)

```
assets/library/
  index.json                      kits + sound packs (counts, index paths)
  props/<kit>/index.json          items: id, file (.gltf), category, thumb, tris, size [x, y(up), z] m
  props/<kit>/<id>.gltf + .bin    glTF 2.0, textures shared in props/<kit>/textures/
  props/<kit>/thumbs/<id>.png     256² transparent 3/4 view
  props/<kit>/LICENSE.txt
  sounds/<pack>/index.json        items: id, file (.ogg), category (file name without the number), bytes
  sounds/<pack>/*.ogg, LICENSE.txt
  anims/                          NPC clips + VRMA emotes (docs/ANIMATION_LIBRARY.md)
```

| Kit / pack | Items | Size | Licence | Source |
|---|---|---|---|---|
| `props/polyhaven_harbour` — modular_wooden_pier, wooden_barrels_01, wooden_crate_02, wooden_lantern_01 (1k) | 4 | 21 MB | CC0 | polyhaven.com |
| `props/quaternius_fantasy_props` — Fantasy Props MegaKit (Standard) | 94 | 43 MB | CC0 | quaternius.itch.io/fantasy-props-megakit |
| `props/quaternius_scifi_megakit` — Modular Sci-Fi MegaKit (Standard): Aliens, Columns, Decals, Platforms, Props, Walls | 190 | 32 MB | CC0 | quaternius.itch.io/modular-sci-fi-megakit |
| `props/kaykit_dungeon` — KayKit Dungeon Remastered 1.1 (free) | 211 | 6.5 MB | CC0 | kaylousberg.itch.io/kaykit-dungeon-pack |
| `sounds/kenney_impact` — Impact Sounds (footsteps, impacts: metal, wood, glass, plate, punch, soft, mining …) | 130 | 1.4 MB | CC0 | kenney.nl/assets/impact-sounds |
| `sounds/kenney_ui` — UI Audio (clicks, switches, rollovers) | 51 | 0.4 MB | CC0 | kenney.nl/assets/ui-audio |

Intended uses: harbour / fantasy / dungeon / sci-fi set dressing for new rooms (Blender room builds can import the
glTFs directly), throwables (crates, barrels, bottles + `kenney_impact` hits), UI feedback sounds. Restyle to the room's
toon ramp when used; KayKit asks not to resell unmodified copies.

Rebuild (idempotent):

```
python tools/library/stage_library.py                 # copy + rewrite paths, write index.json files
tools\blender_low.cmd -b --factory-startup --python tools/library/thumbs.py -- assets/library [--force]
```

Provenance: raw downloads (unmodified) in `tools/vendor/{polyhaven,quaternius,kaykit,kenney,100style}/`, each pack
with its licence file; every download is listed with its size, licence and SHA-256 in the 2026-09-25 download manifest
(kept with the integration report) and summarised in THIRD_PARTY_NOTICES.md. The Quaternius Universal Base Characters
pack is kept raw in `tools/vendor/quaternius/` for future NPC bodies (not staged).
