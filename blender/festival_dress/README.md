# festival_dress — main-stage dressing kit for fs_lib festival rooms

A big set piece on an empty deck reads as a prop, not a main stage. What sells the scale is the infrastructure
around it: wing towers with LED faces, speaker hangs, truss, real SFX hardware, layered depth behind the stage and a
dressed field. `fs_dress.py` builds those pieces from parameters, on top of the festival room toolkit `fs_lib.py`
(`assets/scenes/festival_mainstage/blender/`), so any festival room gets them in one call instead of by hand.

All designs are generic and original: lattice towers, J-curved line arrays, LED blades, delay towers, masts,
festoons. Rooms supply their own design language through callbacks (for example a tower crown) and materials.

## Pieces

| Function | What it builds |
|---|---|
| `truss_tower` | A square 4-leg lattice tower: box-truss legs, a ring every N metres, X bracing on every face |
| `line_array` | A J-curved speaker hang: cabinets with grille fronts, a header bar, two motor chains and hoists |
| `led_plane` | An `FX_LEDWALL_<GROUP>_NN` screen (UV 0..1 plane) with a dark frame; the festival engine draws on it |
| `led_fins` | A skyline of LED blades as one `FX_LEDWALL` mesh, UVs across the whole row so one image spans every blade, with steel backs |
| `led_pylon` | A wing tower: truss core, optional plinth, a portrait LED face, line arrays both sides, emissive leg strips, a crown callback |
| `delay_tower` | A field delay tower: truss legs, a deck and roof, line arrays facing away from the stage, an emissive band, a beacon |
| `wing_deck` | A deck extension with a facade and an emissive edge line |
| `sfx_housings` | Hardware under every deck-level flame / CO2 / gerb / confetti anchor; the anchor moves up to the nozzle mouth |
| `banner_mast` | A mast with a long alpha-masked vertical banner on an arm, and an optional lamp |
| `festoon` | A catenary wire with evenly spaced emissive bulbs |
| `glow_cluster` | Bioluminescent caps on stems plus reeds (swamp or forest rooms) |
| `tag_lights` | Tags every kit-made `LIGHT_<GROUP>_NN` node for the room light show (run after the room's join step) |

## Conventions

- glTF coordinates like `fs_lib`: metres, +Y up, +Z towards the crowd, yaw 0 faces +Z.
- Geometry goes into `fs_lib` buckets, so it is joined and baked with the room. A bucket named `light_<group>_01`
  becomes the emissive node `LIGHT_<GROUP>_01`; define the group with `L.define(emit={...})` first.
- Materials: `ensure_materials()` adds the kit's flat materials (`M_DressSteel`, `M_DressCab`, ...) unless the room
  already defines them. Truss uses the room's alpha-masked `M_Truss` and grilles use `M_Grille` when they exist.
- Fixture budgets: the festival engine draws an even subset of anchors per class (`shared/festival.ts`
  `FESTIVAL_BUDGET` × the room's `boost`). Count before adding beams or lasers: past the budget, new anchors thin out
  the existing ones instead of adding light. LED walls are not budgeted, but each one is a full-screen-cost shader
  where it covers the frame.
- Run the room's flash e2e after adding LED walls, strobes or flames.

## Use

```python
import fs_lib as L
import fs_dress as D            # sys.path: blender/festival_dress

L.define(emit={'pylon': ('#3cff2e', 3.0), 'deckline': ('#ff5a20', 1.6)})
D.ensure_materials()

@L.step('Stage dressing', (0, 30, 0), 300, 20, 55)
def dressing():
    D.sfx_housings('sfx_hw', min_y=2.5, max_y=3.5)                     # after the room's FX anchors exist
    D.wing_deck('wing_deck', 100, 180, -28, 6, y=3.0, edge_bucket='light_deckline_01')
    D.led_pylon('WINGR', 146, -12, 66, 16, 38, 14, light_bucket='light_pylon_01', arrays=14)
    D.delay_tower('delays', 46, 122, h=14, light_bucket='light_delay_01')
```

Then add the new walls to the room's `scene.json` `festival.walls` (for example `"WINGR": {"role": "side"}`) and,
after the join step, call `D.tag_lights()`.

Headless build as usual: `tools\blender_low.cmd -b --factory-startup --python <room script> -- --out <room dir>`.
Judge the result in the app renderer from the room's cameras (`docs/ARTIST_ENVIRONMENTS.md`), never from Blender.
