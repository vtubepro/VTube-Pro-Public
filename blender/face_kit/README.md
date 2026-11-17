# face_kit — appealing anime + comic faces (numpy; Blender only for the MakeHuman base)

The rules behind every number here are in `docs/FACE_CREATION.md`. Faces are **drawn** as vector shapes at full
texture resolution (never projected from a reference), shaded with **clean normals**, and judged in the **app
renderer** next to a reference at identical framing.

| file | what |
|---|---|
| `raster.py` | `posmap` (texel -> 3D rest position / normal of any mesh part in its UV space), `zraster` (front z-buffer of triangles), `dilate` (seam padding), `grow`. |
| `sdf.py` | anti-aliased vector shapes: ellipse SDF, variable-width polyline strokes, Beziers, taper profiles, alpha-over, colour helpers, noise. |
| `vroid_face.py` | `VFace`: VRoid (VRM0) face repaint. Landmarks from geometry (eye-hole loops of the skin, painted iris extents, nose tip, mouth slit, chin). Repaints iris (3-stop gradient, lid-shadow band, caustic glow, streaks, pupil + ring, limbal ring), highlights (main + dot + sparkles, toward the key light), sclera (lid shadow), upper lash line (thickness profile, wing), lash spikes, brows (female arch / male thick), skin (flatten VRoid gradients, crease, lower lash hint, lid pink, blush + hatch, nose tick/dot/wedge, drawn mouth line, freckles, fringe shadow band), all at 2x VRoid resolution. `proxy_normals` (fitted head ellipsoid, blended to the originals at the mesh border, morph normal deltas zeroed), `mtoon` (crisp cel settings, matcap + face normal map removed, warm shade colour on face and body skin), `design_view` (flat frontal composite for quick looks). |
| `anime_face.py` | CLI: `anime_creator` build (CC0 VRoid bases, hair / colours / face shape / body) -> `VFace` -> VRM + profile. |
| `human_face.py` | `HFace`: comic / semi-real finishing for MakeHuman (MPFB) GLBs from `blender/human_creator`. Landmarks from geometry (eyeball meshes -> visible openings via z-buffer, midline profile -> nose tip / lip notch / chin). `split_face` (head front -> own primitive + material + 2K texture, cylindrical UV linear in face space), `paint` (flat skin, flush, socket shadow, lash lines + spikes, lid crease, bags, brows, nose shapes, folds, lips (male / full female), mouth cavity + flat drawn teeth, scars, beard base), `shading_normals` (Laplacian-smoothed, border-blended), `beard_shell` (skin shell with strands + jagged alpha fringe), `patch_cap` + `strap_ribbon` (rigid eyepatch), `paint_eyes`, `hair_toon`, `tint_meshes`, `finish`. |
| `comic_face.py` | CLI: human_creator base (headless Blender via `tools/blender_low.cmd`) -> `HFace` -> GLB + profile (anime toon look). |
| `presets/` | `gacha_girl`, `vtuber_girl`, `anime_boy`, `chibi` (anime_face) · `comic_bearded_man`, `comic_woman` (comic_face). |
| `anime_eyes.py` | Parametric anime eyes, **female / male presets** with every construction knob exposed (opening height + tilt + lid shapes, iris size / aspect / tuck / gradient / crescent / ring, pupil incl. ring pupils, highlight list, lash thickness profile + wing + spikes, lower lash, sclera lid shadow, crease, brow). `preset(name, **overrides)`, `blend(a, b, t)`, `design(p, inner, outer)` (places the eye by its corners in any pixel frame), `mirror`, `render` (cv2, anti-aliased), `preview`. Research + table: `docs/FACE_CREATION.md` 2.1. Used by the Skyisles build (texture + lid / gaze / brow rig) and the Live2D -> 3D pipeline. `python anime_eyes.py <dir>` writes F / M / blend preview sheets. |

## Usage

Run from any directory except `blender/` (`blender/inspect.py` shadows the stdlib module). Both CLIs lower their
own priority (below normal) so a live studio keeps its CPU.

```
python blender/face_kit/anime_face.py gacha_girl <out_dir> [--textures]          # ~40 s
python blender/face_kit/comic_face.py comic_bearded_man <out_dir>                # ~35 s (Blender base + finish)
python blender/face_kit/comic_face.py comic_bearded_man <out_dir> --raw <dir>    # re-finish an existing base (~15 s)
```

Outputs: `<id>.vrm|.glb`, `profile.json`, `face_params.json`, `design.png` (anime) / `face_texture.png` (comic).

## Presets

Anime (`anime_face.py`): `{"id", "name", "creator": {anime_creator params}, "face": {VFace params}, "proxy": 0..1,
"profile": {...}}` — `face` keys: `skin`, `eye`, `iris`, `hl`, `brow`, `mtoon` (see `vroid_face.DEFAULTS`).
Colours default from the creator block (iris = `colors.eyes`, brows = `colors.brows`).

Comic (`comic_face.py`): `{"id", "name", "human": {human_creator params}, "face": {HFace params}, "hair":
{"color", "shade"}, "normals": {"iters"}, "tint": {"<mesh prefix>": "#rrggbb"}, "profile": {...}}` — face
coordinates are `(a, b)`: `a` = arc length around the head / eye distance (+ = character's LEFT = viewer's right),
`b` = height above the mouth line / eye distance (eyes at b ~ 1, nose tip ~ 0.4, chin ~ -0.85). Scars and the
strap are Bezier control points in `(a, b)`.

## Judging

Render in the app renderer (Stage + AvatarRuntime), front + 3/4 + expression/viseme sheet (smile, blink,
surprise, angry, aa, oo, ee, ff), next to the reference at the same crop. Self-review checklist: section 8 of
`docs/FACE_CREATION.md`.
