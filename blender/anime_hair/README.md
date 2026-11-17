# anime_hair — anime hair toolkit (Blender, headless)

Gacha-style hair as layered **clumps**, not strands. Run Blender only through `tools/blender_low.cmd`.

| file | what |
|---|---|
| `hairkit.py` | `HeadFrame` (scalp ellipsoid + head BVH, mask "pressers"), `Clump` (guide curve, width, `shape='flame'` broad-then-wedge needle tips, shell cross-section with thickness), `HairBuilder`, scalp shell, **proxy normals** (`clean_normals`: inflate -> voxel remesh -> smooth -> Data-Transfer custom normals, so cel shading makes big clean shapes), textures (`Palette(style='clean')`: flat colour, one form band, ink edges + interior ink lines, zig-zag angel ring), `chain_weights` (spring chains). |
| `styles.py` | style library. `locks()` = hand-laid clumps from head-local control points `(s, f, u)` (s = character's right, f = front, u = up; radii of the scalp ellipsoid, eyes ~ u -0.33, chin ~ u -1.3). `wild_mop` is the reference example (swept layers + crest spikes + fringe + under-mask locks + back). |
| `build.py` | `build()` (mesh + gap fillers + scalp + normals + material), `ink_hull()` (exportable inverted-hull ink outline pushed along GEOMETRIC normals; the MToon outline can't be used with proxy normals), `export_npz()` (stage-2 part dumps: `Hair.npz` hair+scalp in ONE primitive, `Hair_Ink.npz`, `hair_bones.json`). |
| `fit.py` | fit/preview harness on a real VRM: `blender ... --python fit.py -- <vrm> <style> <out_prefix> [parts=<npz>] [press=<mask_frame.json>] [views=front,tq,side,back,bust,top] [export=<dir>] [texout=<dir>] [geo=1]` (style `none` = bald reference renders). Preview shading = MToon formula with the app's key light. |
| `contact_sheet.py` | the whole style library on a CC0 VRoid base head. |

Workflow for a new character: `fit.py <vrm> none <p> geo=1` (head frame numbers + bald renders), overlay the head-local grid on the
reference art, write a `locks()` spec (5 swept / crest / fringe / side / back layers), iterate `fit.py`, then `export=` and assemble.
Judge in the APP renderer (MToon + exposure), not only Blender: the hull line weight and the shade colour read very differently.

VRM materials: hair = MToon, `_OutlineWidth 0`, `_ShadeColor` = palette `shade_mul`; ink hull = black lit/shade + ink **emission**
(constant), normal back-face culling (the hull's winding is flipped). One VRM0 spring group per layer (stiff fringe, looser back).

## `style='drawn'` (additive mode for drawn-art pipelines, e.g. `blender/live2d/`)
`build.build(..., style='drawn')`. The default (`style=None`) path is unchanged: same geometry, winding and
Data-Transfer normals (checked: `fit.py <shibu> wild_mop export=` before / after gives the same vertex, normal, UV and
weight sets; only the vertex ORDER differs, and it already differed between two runs of the old code).
- **Winding**: `HairBuilder.orient = 'volume'` — each clump's closed shell is oriented by its own signed volume instead
  of one `recalc_face_normals` over the whole overlapping mesh (twisted / overlapping locks never come out inside-out).
- **Normals**: `hk.drawn_normals(hair, builder, proxy)` — every vertex of a lock ring (outer face, sides, underside,
  tip) takes the smooth proxy normal found by casting from the ring's guide point along the lock's outward frame normal
  to the proxy's OUTER surface (barycentric proxy vertex normals, 12 % of the lock's own frame mixed in). A lock's whole
  cross-section is one flat cel tone following the smooth mass: no dark undersides / side walls on hanging locks (the
  nearest-surface transfer picks the far side of a thin lock's proxy tube there). `hk.shell_normals(scalp, proxy)` does
  the same for the scalp / under-shell along its own normals (nearest-surface gave it the proxy's inner side).
- `HairBuilder._tube` records per vertex its ring's guide point and frame normal (`part['c']`, `part['n']`) and the
  part's faces; nothing else reads them.
Clump parameters used by the Live2D pipeline for drawn locks: `shape='flame'`, `tip_start` 0.25–0.35, `tip_curve` 1.2
(concave wedge = needle point), `thick` 0.22–0.24, `wave` ≈ 0.1 × width at 0.7–0.8 waves (gentle S), `twist` ±0.25–0.35.

Review note: `tools/review_character.py` counts the ink hull's culled back faces (they cover every lock by design) as
"unknown" pixels, so hair R7 / R9 "?" / R3 on any inverted-hull build mostly measure the hull, not the shading
(Live2D samples: Haru goes from FAIL to WARN with 0 high findings when only the hull is removed). Judge hair shading
with the hull removed, or in the app.

Optional `Clump` fields (additive, default `None` = unchanged behaviour): `rings` (explicit ring count; long helices
need more than the automatic 10..40), `centers` ((n,3) per-guide-point frame centres: a coil's radial frame centred on
its own axis point instead of the head), `width_mul` (width multiplier curve along the clump, e.g. one swell per drawn
ringlet), `keep_normals` (style='drawn': the clump keeps its own smooth tube normals), `ring_z` + `ring_v` (the angel
ring at a WORLD height: a hanging lock's texture v is remapped piecewise so the palette ring (at v = `ring_v`) lands
where the lock crosses `ring_z` -- one coherent ring round the head; rising / low-rooted locks keep t). `round_back` (a closed
round / elliptic section instead of the lock's flat underside: tubes such as drill curls). The Live2D drills are one
round tube with `rings`, `width_mul` (a swell per curl) and a twist (`blender/live2d/hair_blender.py` `drill_coils`).
