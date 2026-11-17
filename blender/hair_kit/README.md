# hair_kit — stylised hair toolkit v2 (Blender 5.1, headless)

Replaces sculpt-cut hair ribbons (Aosabi v5: flat stripey ribbons) with hair built the way game artists build
real-time stylised hair: **block the hair mass -> lay guide curves on it -> strands -> clumped lock meshes ->
paint -> clean toon normals -> spring chains -> LODs**, then `tools/review_character.py --focus hair`.
Background and the reasons for each step: `docs/SCULPT_AND_HAIR.md`.

```
tools\blender_low.cmd -b --factory-startup --python blender/hair_kit/build.py -- <avatar.glb> <out_dir>
    --style wild_swept_back_mass [--profile in_profile.json] [--drop Hair,HairClumps]
    [--ref assets/reference/aosabi/aosabi_v2_turnaround.png --ref-cal back:<axis_px>,<skull_top_px>,<chin_px>]
    [--eye-z 1.7626] [--chin-z 1.64] [--head-bone head] [--shine 0.0] [--seed 7] [--no-gn]
python tools/review_character.py <out_dir>/avatar_hair.glb <review_dir> --profile <out_dir>/profile.json --focus hair
```

About 10 s to build and 2–3 min to review, both on the CPU at low priority. Outputs: `avatar_hair.glb` (the avatar
with the new hair, skinned to spring chains), `profile.json` (hairMeshes, physics chains, hairShine),
`hair_lod1.glb` (about 55 % of the triangles), `hair_lod2.glb` (one card per lock, about 2 k triangles),
`hair_atlas.png`, `hair_build.blend` (includes the guide curves as a Curves object, for artists), `guides.npz`,
`stats.json`.

| module | what |
|---|---|
| `core.py` | `Head`: cranium ellipsoid fit, head BVH, `Envelope` (smooth cylindrical outer envelope of the neck, collar and shoulders; obstacles cast 40° upward cones, so there are no ledges). **`HairMass`**: the hair SHAPE as an implicit surface: the head (and the real head mesh, so ears and sideburns stay inside) offset by the layer thickness plus top volume, smooth-unioned with a curtain behind the ears that drapes over the envelope. **`streamline()`**: a guide from a scalp root. It rises onto the mass (quiff), is combed back along the meridian (up the forehead, over the crown), falls down the curtain and slides back off the shoulders, until it reaches the tip height. Also: flow-field `grow()` with collision (older, for short hair), `add_wave`, `flick`, `hairline_ph`, `poisson_roots`, reference-silhouette tools (`hair_mask`, `RefView`, `fit_width_to_ref`, `fit_lengths_to_ref`), and **`guides_on_shell()`**: guides traced over a SCULPTED hair or lock mesh (tested on the v5 sculpt: 30 of 40 seeds, median 17 cm). |
| `strands.py` | child strands: roots in an ellipse across the flow, shape interpolated from the 3 nearest guides, clumped to the own guide with a tip fan, length variation. `curves_object()` builds a Blender Curves (new hair) object. `gn_stack()` runs the **bundled Essentials hair node groups** (Smooth, Frizz, Trim, Curl, Hair Curves Noise, … from `datafiles/assets/nodes/procedural_hair_node_assets.blend`) as geometry-nodes modifiers and reads the result back. |
| `locks.py` | `lock_from_strands()` measures each clump (PCA of the strands' spread gives width and lateral axis). `build_mesh()` makes **crescent shell locks**: a curved outer arc with a flatter inner side and edges curled toward the head, so a lock never reads as a flat ribbon or a pipe. It adds broad-then-wedge tips, optional 2–3 forked sub-tips, and root caps. An **anti-fold** pass narrows a lock where it bends tighter than its half width, because inside-out shells show as holes. Every lock gets a **unique-UV atlas** strip (u across, v root to tip; the glTF bitangent is the strand direction, for anisotropic shading). Also `ribbons()` (flyaways), `cards()` (LOD2) and `to_object()` (attributes `hair_t`, `hair_lock`, `hair_layer`). |
| `finish.py` | `paint_atlas()`: flat layer tones with ±3.5 % per-lock jitter, root to tip gradient, edge darkening, 1–2 tapered strand lines, and an **angel-ring band painted at one world height on every lock**, so the bands line up into one ring with a jagged lower edge. `hair_material()` writes the `vtpShadeShift` extra and is double-sided, like VRoid hair. `scalp_shell()`: an under-shell 2.5 mm off the skin inside the hairline, with each triangle oriented outward. `proxy_normals()`: inflate, voxel remesh, smooth, then transfer the custom normals, giving one clean cel terminator. `chains()`: six azimuth groups of 4-bone spring chains on the head bone, weighted along `hair_t`; the specs go to `profile.physics.chains`. |
| `styles.py` | `wild_swept_back_mass` (Aosabi: layers under0/under1 → mid → top → crown → wild accents on nested masses, coherent azimuth-phased waves, small tip flicks). `wild_swept_back` is the earlier collision-grown version, kept for short hair and experiments. |
| `build.py` | the one-shot pipeline CLI (above). |

## Design rules learned while building the demo (every one was a visible failure first)

1. **Hair is a mass first, locks second.** Growing each lock independently with collisions gave crossing locks,
   stalls on the jacket collar, hair inside the jacket, and locks over the face. Laying streamlines on nested offset
   masses fixed all of these at once.
2. **Comb along the meridian, not "toward the back".** Projecting a "back" vector onto the forehead's tangent plane
   leaves "down", which puts hair over the face. The meridian tangent `-x × n` goes up the forehead, back over the
   crown, then down.
3. **No flat ledges in the colliders.** A max-filtered collar envelope still had a shelf, and the hair stalled and
   crumpled there. A slope-limited (40°) upward cone from every obstacle removes it.
4. **Wide locks fold at tight bends.** Detect it (a ring vertex moving backward along the centreline) and narrow the
   lock locally.
5. **Keep hair off the shoulders.** Swept-back hair slides back off the shoulders; if it drapes down the arms it
   reads as tentacles or a cape.
6. **Tips are broad-then-wedge (tip_start about 0.7), never long needles. Keep flicks small.** Big flicks become
   sideways spikes, which review detector R11 now flags.
7. **Align the highlight band to one world height,** or it reads as random blotches.
8. **Colour:** a dark reddish brown base (`#4a2615` top, `#2f170d` under) and warm light tips. The studio shade tint
   darkens further, so keep the albedo a little lighter than the reference's lit colour.
