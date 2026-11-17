# Face creation guide (anime + comic/semi-real, male + female)

Faces are what viewers look at for hours. A bad face sinks an avatar no matter how good the body, hair or
tracking is. This guide is the house rulebook for every face VTube Pro builds or repaints; the reusable code
lives in `blender/face_kit/` (usage at the end). It is opinionated on purpose: follow it, then judge the result
against a reference at identical framing (section 8) before anyone else sees it.

> The two failures that got us here (Aosabi v1): a ~60 px face crop was **projected** onto the mesh (blotchy,
> smeared mush with baked photo lighting) and quality was judged by **silhouette IoU** instead of looks. Never
> again: faces are drawn as clean vector shapes at full texture resolution, shading comes from clean normals, and
> the judge is a human-style side-by-side critique in the app renderer.

---

## 1. Proportions

All numbers are fractions of **head height H** (crown to chin, hair excluded) seen from the front, and of
**face width W** at the cheekbones. Eye width = one eye, measured corner to corner.

### 1.1 Anime (by sub-style)

| | gacha / Genshin-like | VTuber / VRoid | shonen | seinen / realistic-anime | chibi |
|---|---|---|---|---|---|
| eye line (from crown) | 0.55–0.60 H (eyes LOW, big cranium) | 0.55 H | 0.52 H | 0.50 H | 0.62–0.66 H |
| eye height / eye width | F 0.85–1.0 · M 0.55–0.7 | F 0.8–0.9 · M 0.6 | F 0.7 · M 0.45–0.55 | F 0.5 · M 0.35–0.45 | 1.0–1.2 |
| eye width / W | F 0.24–0.27 · M 0.22 | 0.24 | 0.21 | 0.19 | 0.28–0.30 |
| gap between eyes | 1.0–1.1 eye widths | 1.0 | 1.0 | 1.0 | 1.1–1.3 |
| nose (from eye line to chin) | tiny tick at 0.40 | tick / dot at 0.40 | small wedge at 0.45 | shadow shape at 0.5 | none or a dot |
| mouth | 0.72 of eye→chin, width ≈ 0.6 eye width | 0.70, 0.6 | 0.68, 0.8 | 0.66, 1.0–1.2 | 0.55, 0.5 |
| chin | F small rounded point, short · M longer, squarer | F round point | M angular, strong | M square jaw, visible cheekbone plane | round, almost none |
| jaw | F soft S-curve from ear to chin · M straight line + corner under the ear | F soft | M sharp corner | M wide, corner at ear lobe | none, a circle |

Rules that hold across anime styles:

* **Eyes sit at or below the middle of the head.** Moving them up is the fastest way to make a face look old or
  weird. Bigger cranium + lower eyes = younger/cuter; this is the main "age slider".
* **The lower face is short.** Eye line → chin is only ~0.40–0.45 H on gacha girls. The nose and mouth crowd
  toward the chin, the mouth ends up closer to the chin than to the nose on young female characters.
* **Female vs male** is mostly: eye height (F tall, M narrow), lash weight (F heavy wing, M thin line), brow
  (F thin high arch far above the eye, M thick straight low brow close to the eye), jaw (F soft curve, M corner),
  chin length (M longer), neck (M thicker, Adam's apple hint). Do not make males with female eyes "smaller" —
  make them *narrower* and more horizontal with a flatter upper lid.
* **Age**: child = eyes lower + rounder + wider apart, no jaw corner. Adult = narrower eyes, longer chin, cheek
  plane appears. Middle age = eye bags (one short line), nasolabial fold line, thinner lips, heavier brow.

### 1.2 Comic / semi-real (Loomis-based)

* Eye line at **0.50 H**; brow line at 0.37 H; nose base at 0.66 H; mouth at 0.75 H; chin 1.0. The face splits
  into thirds (hairline→brow, brow→nose base, nose base→chin) — comics keep the thirds but **exaggerate the side
  plane corner**: sharp male jaws, soft female jaws, both with more visible bone than realism.
* Head is **five eyes wide**; the gap between the eyes = one eye; the nose base ≈ one eye wide (male a bit wider);
  mouth corners line up with the pupils (F) or the inner iris edges (M, stern).
* Ears span brow line → nose base.
* **Male cues**: heavy brow ridge that shadows the eye socket, brows low and straight close to the upper lid,
  square jaw with a corner under the ear, broad chin (often cleft), thicker neck, visible cheekbone → jaw plane
  change, nose bridge wide. **Female cues**: brow higher with an arch, smaller jaw and shorter chin, fuller lips
  (lower lip ~1.5× upper), softer sphere→side-plane transition, lashes as a dark upper lid line, no stubble shading.
* Planes (Asaro head): the front plane of the face is an inverted trapezoid narrowing toward the chin; side
  planes turn at the outer brow → cheekbone → jaw corner. **Cel shadows must follow these plane breaks** — that
  is what makes a comic face read as a solid head instead of a sticker.

---

## 2. Anime eye construction (the thing that makes or breaks an anime face)

Build every eye from these layers, back to front (VRoid has exactly this material stack: `EyeWhite`, `EyeIris`,
`EyeHighlight`, `FaceEyeline`, `FaceEyelash`, `FaceBrow` + the skin's double-lid line):

1. **Sclera**: never pure white on its own — a white with a **soft cool shadow band under the upper lid**
   (the lid casts it; 15–25 % of sclera height, lavender/blue-grey `#c9c6dd` on light skins). Without it the eye
   looks pasted on.
2. **Iris**: tall ellipse (height ≈ 1.1–1.25 × width for girls), clipped by the lids (the top ~15 % always hides
   under the upper lid in a relaxed eye — a fully visible iris = shocked/crazy look).
   * Vertical gradient: **dark at the top → base colour → bright, more saturated at the bottom**. The top 30 % is
     darkened by the lid shadow (a second, hard-edged dark band). Gacha eyes add a lighter "caustic" crescent in
     the lower third, often a warmer/complementary hue (blue iris → cyan/teal lower glow; red → orange).
   * Thin **dark limbal ring** (outline) around the iris, 4–7 % of the iris radius, darker than the top band.
   * Optional radial streaks (fine, low contrast) in gacha styles; VRoid style keeps it smoother.
3. **Pupil**: vertical ellipse 30–45 % of iris width, slightly above centre, dark version of the iris hue
   (never pure black on light irises; black is OK for dark irises). Gacha: a thin lighter ring around the pupil.
4. **Highlights** (catchlights) — they must be the **brightest, sharpest thing in the face**:
   * one **main** highlight: a clean white ellipse/teardrop at the upper-outer area of the iris, overlapping the
     iris edge, same side in both eyes (light-consistent);
   * one **secondary** small dot on the lower opposite side;
   * gacha adds a few tiny sparkles or a soft horizontal reflection bar across the bottom;
   * highlights are unlit/emissive (MToon: they live on `EyeHighlight`), so they stay white in shadow.
5. **Upper lash line** (`FaceEyeline`): the heaviest line in the whole face. Thickness: F 8–12 % of eye height at
   the thickest point (outer third), tapering to ~2 % at the inner corner; M 4–6 %, nearly uniform. Female eyes
   get a **wing** — the line extends past the outer corner and flicks down-and-out (gacha) or out-and-up (cat eye);
   2–4 short lash spikes off the outer end. Colour: very dark warm brown/plum, not pure black (`#2a1a22`);
   pure black reads as "sticker".
6. **Lower lash hint**: a short, thin, *broken* line on the outer third of the lower lid (F) or nothing (M); the
   inner lower lid is a pinkish/warm line, not dark. Full dark lower rims = heavy makeup / tired.
7. **Double-eyelid crease**: one thin line parallel to the lash line, 25–40 % of eye height above it, only on the
   middle-outer part. Skin colour darkened, not black.
8. **Brows**: F thin, tapering, a gentle arch whose peak sits above the outer iris edge, **far above the eye**
   (≈ 0.9–1.3 eye heights), can be hidden by the fringe (render them over hair in styles that do that);
   M thicker (2–3×), straighter, closer to the eye (0.4–0.6 eye heights), inner ends slightly lower (stern).
   Brow colour = hair shade colour.

**Expression readability**: the lid shapes carry emotion, not the iris. Smile = lower lid pushes up into a
curve (VRoid `Fcl_EYE_Joy`), angry = upper lid straight + tilted down to the nose, sad = inner upper lid lifts.

### Eyes that don't look dead (all styles)

Dead eyes come from: no catchlight, catchlight in different places in the two eyes, iris fully visible (no lid
overlap), no lid shadow on the sclera, pupil too small, eyes looking slightly different directions, or a flat
iris without gradient. Semi-real eyes also need: a **visible upper lid thickness** (a skin-coloured band above the
lash line, catching light), a **wet line** (a thin pale pink line on the lower lid rim), a **tear-duct** pink
wedge at the inner corner, and the upper lid line thicker than the lower.

### 2.1 Anime eyes: female vs male (research summary + the `face_kit.anime_eyes` presets)

What separates a female from a male anime eye is **shape language**, not just size. Consensus of the drawing
guides (AnimeOutline female / male eye tutorials, AnimeFaceLab, Corel's anime-eye guide) and of how gacha /
VTuber 3D models are built (VRoid's layer stack, Genshin-style face rigs, Live2D eye parts):

| knob | female (gacha / VTuber) | male (shonen / bishonen) |
|---|---|---|
| opening height / width | tall **0.75–0.95** (round, big) | narrow **0.45–0.6** (horizontal) |
| corner tilt | outer corner **raised** (+0.04…+0.1 eye widths) | level or slightly **lowered** (0…−0.03) |
| upper lid | round arch, peak a bit outside the middle | **flatter top** with angled ends; the lid overlaps the iris more |
| lower lid | deep, round U; iris may touch it | shallow; more white under the iris is OK |
| iris | **tall ellipse** (h/w 1.15–1.3), ~0.6–0.65 of the eye width, top ~10 % under the lid | smaller, rounder (h/w 1.0–1.1), ~0.5 eye width, top ~20 % under the lid (heavier, cooler gaze) |
| pupil | 0.4–0.45 of the iris, tall | 0.35, rounder |
| highlights | **2–3+**: a big main catchlight toward the light, a small secondary on the opposite low side, sparkle dots; gacha adds a lower reflection crescent | **1–2**, smaller; no sparkles |
| upper lash line | heaviest mark in the face; thickness ramps from ~3 % (inner) to **15–20 %** of the eye width at the outer third; a **wing / flick** past the outer corner; 2 spikes outer + 1–2 inner | thin (**5–8 %**), nearly uniform, tiny or no wing, no spikes |
| lower lash | short broken hint under the outer / middle iris | none, or a short thin line at the outer third |
| lid shadow on the sclera | 10–15 % of the width, lavender | 15–20 % (deeper-set eye) |
| crease | thin line close above the lash (0.03–0.07) on the inner two thirds | closer and longer |
| brow | thin, arched, **far above** the eye, often hidden by the fringe | **thick** (2–3×), straight, **low** (0.25–0.5 eye heights), inner end lower (stern) |

Younger males are drawn with (nearly) female eyes; "androgynous" = blend 30–50 % toward male. Keep both eyes
built from the same construction, highlights on the **same side** in both eyes (never mirrored), and the lash line
never pure black (dark warm plum / maroon).

**How 3D anime games / VTuber models build eyes** (what our rig copies):
* **Layers, not paint**: eye white, iris, highlight and lash / eyeline are separate layers (VRoid materials
  `EyeWhite`, `EyeIris`, `EyeHighlight`, `FaceEyeline`, `FaceEyelash`; Live2D parts eye-white / iris / highlight /
  upper + lower lash). The iris layer moves for gaze **inside a fixed eye-white / lid outline**; the highlight is its
  own layer that ideally stays put relative to the light (VRoid moves it with the iris; high-end rigs counter-move it).
* **Flat or slightly concave eye planes** instead of a spherical eyeball: the iris plane sits a few mm behind the
  lash line so it never pokes out at 3/4 views; gaze = iris translation (bones or UV offset), small range (±10–15°).
* **Blink = lid shape keys that carry the lash line down**, closing in the lower third of the eye (a ‿ closed-eye
  line); squint = lower lid up + upper lid down; "happy ^^" = a separate closed shape; the lash spikes and wing ride
  the upper lid. Never squash the painted eye (the lash smears into a thick band).
* **Parallax / refraction** shaders (layered iris depth) are a luxury; the essential reads are the lid shadow on
  the sclera, the dark top of the iris, the bright bottom and crisp catchlights.
* Faces use **proxy / SDF shading** so no terminator crosses the eyes (section 4).

**Code** — `blender/face_kit/anime_eyes.py` (numpy; cv2 only for the preview/renderer). Eye space: `u` 0 = inner
corner … 1 = outer corner, `v` up, in eye widths. Every knob above is a preset key:
```python
from face_kit import anime_eyes as AE
p = AE.preset('female', iris={'mid': '#c41c42'}, lash={'wing': 0.08})   # deep-merged overrides
p = AE.blend(AE.preset('female'), AE.preset('male'), 0.4)                 # in between
d = AE.design(p, inner=(x0, y0), outer=(x1, y1))   # place by the two corners in any pixel frame (y down)
d2 = AE.mirror(d, axis_x)                            # the other eye
AE.render(img_rgb_float, d, ss=2)                    # draw it (sclera, lid shadow, iris gradient, pupil, highlights, lash, ...)
AE.preview(p, 'eye.png')                             # one-eye review sheet; `python anime_eyes.py <dir>` writes F / M / blends
```
The design dict (upper / lower lid lines, lash top, iris / pupil ellipses, highlights, crease, brow) is also the
geometry source for the 3D eye rig: the Skyisles build (`(an internal build)`) drives its lid membranes,
gaze inserts and brow ribbons from it, and the Live2D → 3D pipeline reuses it for converted eyes.

**Skyisles (female preset, fitted to her art)** — `(an internal build)` `eye_preset`:
opening 0.79 / tilt 0.086 / upper_rise 0.38 (her lids sit high: most of the opening is below the corner line),
iris 1.22 tall with a ring pupil, two horizontal pill catchlights at pupil height + a violet upper-right glow,
lash max 0.2 with a descending outer wing. Rig pattern for AI / fused meshes (the fringe is welded into the face):
the face surface never moves — `EyeInsert*` (a copy of the eye opening, iris rigid on `leftEye`/`rightEye`, white
stretching), `LidUpper*/LidLower*` membranes (skin + drawn lash edge, zero-area at rest) and `Brow*` ribbons carry
all eye / brow ARKit shapes.

---

## 3. Nose, mouth, cheeks

* **Anime nose**: minimal. Gacha/VTuber girl = a small tick or dot of *shadow colour* (not a line) at the tip,
  optionally a tiny highlight dot above; boys = the same plus a short shadow on the shaded side of the bridge.
  Never draw nostrils on anime girls. In 3D the nose must be **nearly flat** in the mesh or the cel terminator
  will slice across the face; its read comes from the painted tick + the outline.
* **Semi-real / comic nose**: shape it with **shadow shapes**, not outlines: the underside plane (always in
  shadow), the shaded side plane of the bridge, the nostril wings as small dark crescents, a single line for the
  outer nostril edge on the lit side. The bridge top may carry a highlight.
* **Anime mouth**: small (≈ 0.6 eye width closed for girls). Closed = one short line, slightly thicker in the
  middle or with a tiny dip; the corners do the expression. Open mouths are carved into the face (house rule:
  interior depth OK, **teeth are a flat drawn white band, never 3D geometry**), interior dark warm red, tongue
  a flat lighter shape. Shapes: `a` tall rounded D, `i` wide flat slot, `u` small round, `e` wide trapezoid,
  `o` rounded O; smile = corners up + wider; cat mouth `ω` for playful. Lips are *not* drawn on anime girls —
  at most a faint lower-lip highlight line.
* **Comic mouth**: upper lip is a shadow shape (it faces down), lower lip is lit with a shadow underneath it
  (the chin dimple / mentolabial fold). Men: a thin upper lip, a clear lower-lip shadow, corners with small
  deepening lines. Women: fuller, a soft lip colour with a small highlight on the lower lip; no hard outline.
* **Blush**: anime = soft horizontal ellipses under the outer eye, 1.2–1.6 eye widths wide, pink/peach with
  ~20–40 % opacity, optional 3–5 diagonal hatch lines for "embarrassed". Comic = warm redness on cheeks, nose tip
  and ears (thin skin), very subtle for men.

---

## 4. Cel-shaded face shadows

A face shaded straight from its mesh normals gets noisy terminators: blotches around the nose, lips and eye
sockets, and shadows that crawl while talking. Anime/comic faces want **big, simple, designed shadow shapes**.
Three production techniques, from cheapest to best:

1. **Lit face (VRoid default)**: push the face's terminator far into the side (MToon `_ShadeShift` −0.6…−0.9,
   `_ShadeToony` ~0.9 for a crisp edge). The face is lit from every normal angle, shadows only appear at extreme
   angles. Clean but flat.
2. **Normal transfer from a smooth proxy** (Guilty Gear Xrd, Arc System Works; the "Anime Face Proxy" /
   Abnormal / *aVersion of Reality* workflow): copy the shading normals from a smooth ellipsoid/sphere-like proxy
   onto the face (Blender Data Transfer → custom normals, face-projected interpolation). The terminator then
   becomes one clean curve across the cheek; nose, lips and sockets stop creating noise. Mix factors: 100 % proxy
   on cheeks/forehead, 60–80 % around the nose (keep a small nose shadow), 100 % on the mouth region (so talking
   doesn't flicker), eye sockets 100 % proxy. Keep the proxy rigged to the jaw (or transfer on the rest pose and
   let morph targets carry their own normal deltas = zero) so shading doesn't jump when the jaw opens.
3. **SDF face shadow map** (Genshin Impact, Honkai: Star Rail, Uma Musume-style; NiloCat / kaze-mio /
   ASP shaders): hand-design the shadow shape for ~9 light angles on one half of the face, bake each mask to a
   signed distance field and merge them into one greyscale texture where each texel stores **the light angle at
   which it goes into shadow**. The shader ignores the face normals entirely:
   `F = head forward (xz)`, `R = head right (xz)`, `L = light dir (xz)`; `u' = dot(R,L) > 0 ? u : 1-u`
   (mirror the map for light from the other side); `t = acos(dot(F,L))/π` (0 = light in front, 1 = behind);
   `lit = step(t, sdf(u',v))` (with a small smoothstep for AA). The shadow slides across the face exactly as the
   artist designed: triangle of light on the shaded cheek (Rembrandt), nose shadow pointing down-and-out, no
   blotches ever. Requires a **symmetric face UV** (mirror around u = 0.5) or a dedicated second UV set.

VTube Pro uses **(2) for every generated face** (automatic, deformation-safe): an ellipsoid proxy on VRoid faces,
Laplacian-smoothed normals (optionally blended toward an ellipsoid) on MakeHuman faces, plus a per-material
terminator shift on GLB faces (see "Engine support"). **(3)** is the documented upgrade path. Additionally:

* **Fringe shadow on the forehead** (hair-face interaction): anime key art always has a hard-edged shadow band
  under the fringe. Real-time shadow maps are too soft/noisy for this; paint it (a jagged band following the
  fringe tips, 1–2 % of H below them, shade colour) or rely on the key-light shadow on high tiers. Painting is
  deterministic and cheap — do it when the hairstyle is known at build time.
* **Neck shadow**: a hard shadow under the jaw on the neck, always present. Paint it on the neck top.
* **Eye socket / upper-lid shadow** on semi-real faces: a soft warm-dark band under the brow ridge.
* Shadow colour = skin shade tone (section 5), **never grey**: saturated, hue shifted toward red/magenta.

### Outlines (inverted hull)

* Silhouette = inverted-hull outline, **constant pixel width** (the engine does this), 1–2 px at 1080p bust.
* **Thickness by vertex colour** (ASW): alpha 0.5 = default, 0 = no line, 1 = double. On faces: 0 on eyelids,
  lashes, inside the mouth, around the nose (outline there draws a black blob when turning); thin (0.3) on the
  cheek/jaw contour; normal on chin/ears. MToon's equivalent is `_OutlineWidthTexture` (VRoid face uses one:
  it kills the outline around the nose/mouth/eyes).
* Push the hull along **smoothed/averaged** normals (the proxy normals are ideal) or it tears at UV seams.
* Line colour: a dark saturated version of the surface colour (the engine's "coloured lineart"), not pure black.
* Interior lines (nose line, lid crease, lip line, cheek line, wrinkles, scars) are **painted into the texture**
  with a consistent line weight — see section 7.

### MToon settings that work (VRM faces)

| material | ShadeShift | ShadeToony | Receive shadow | Outline | notes |
|---|---|---|---|---|---|
| Face skin | −0.35 … −0.6 (with proxy normals), −0.9 (flat lit) | 0.9 | 1 (hair shadow) | width 0.05–0.08 world, mask texture | shade colour = skin shade tone, not the default grey-pink |
| Eye white / iris | −0.9 | 0.9 | 0 | 0 | the sclera shadow is painted |
| Highlight | emissive / unlit | – | 0 | 0 | always white |
| Eyeline / lash / brow | −0.9 | 0.9 | 0 | 0 | colour dark warm brown |
| Mouth | −0.6 | 0.9 | 0 | 0 | rim off (cavities never get fresnel) |

`_IndirectLightIntensity` 0.1, `_RimFresnelPower` high or rim off on the face (rim on faces looks like sweat),
`_ShadingGradeRate` 1. The app applies `look.vrmExposure` on top (≈ 0.6).

---

## 5. Skin painting in cel / comic style

* **2–3 tones only**: light (base), shade (the cel shadow — comes from the shader), and a **deep accent** for the
  darkest occlusions (under the nose, inner mouth corners, ear holes, under the jaw) painted into the texture.
  Plus warm "blood" accents: cheeks, nose tip, ears, knuckles.
* **Shadows are warm and saturated**: skin `#f3d5c0` → shade `#d99a8c` (hue shifts toward red, saturation up,
  value down ~20 %). Darker skin `#9a6444` → shade `#6b3a2e`. A thin saturated red-orange band right at the
  terminator is the stylised subsurface hint (the engine's anime shader already does this for GLB toon faces).
* **No baked lighting** in the albedo — the texture must look right when the light comes from either side. Only
  occlusion-type darks (always dark regardless of light: nostrils, mouth corners, lid crease) are painted.
* **Comic faces carry designed lines**: nasolabial fold (a single tapered line from the nose wing down toward the
  mouth corner — shorter and fainter on women/young), under-eye bag line (one short arc, men/age), brow furrow
  (1–2 vertical tapered lines between the brows for stern men), cheekbone line (a short diagonal under the
  cheekbone on the shaded side), chin cleft/dimple. Lines taper at both ends (`width = w·sin(πt)^0.6`), are
  dark shade colour (not black), and are few — every line must describe a plane change.
* **Stubble / beard**: base the shape on the jaw/chin/upper-lip region; a beard is a **flat mid-dark hair-colour
  shape with a jagged, chipped outer edge** (saw-tooth / clumped strands pointing downward and outward), a
  darker inner layer, a few lighter clump highlights; the moustache is a separate shape over the upper lip with
  strands flowing down-and-out, leaving the lower lip visible; a small soul patch/chin clump under the lower lip.
  Stubble = a flat, slightly darker/cooler skin tone in the beard region (5–15 % toward hair colour) with a soft
  edge, never noise/dots. Sideburns connect beard to hair.
* **Scars**: a thin dark line with a lighter pink edge on one side; a crossing short line reads as "cut"; vertical
  scar through the eye = the classic "battle-worn" read. Keep them crisp.
* **Freckles**: small irregular dots in a band across the nose bridge and upper cheeks, a darker version of skin
  with ~50 % opacity, vary the sizes (1–3 px at 2K).

---

## 6. Topology for animation

* **Edge loops**: 2–3 concentric loops around each eye (lid rim, lid crease, orbital rim) and 3–4 around the mouth
  (lip line, lip border, outer lip, nasolabial boundary). Loops must be continuous rings — no poles on the rims.
* **Density**: the eyelid rims and lips need ~16–24 edges around; the cheek and forehead can be sparse. A good
  animatable anime face is 1.5–4 k tris (VRoid face ≈ 2.3 k verts); semi-real 5–12 k.
* **Where blendshapes need loops**: upper and lower lid (blink needs the lid to slide over the eyeball/eye decal
  without the lash line folding — the closed lid line must land slightly *below* the eye centre, anime closed eyes
  curve downward = "happy closed" or straight = neutral blink), mouth corners (a pole-free corner with 2 loops
  around it so smile/frown don't pinch), jaw line (for jawOpen), nose wings (sneer), cheeks (squint/puff).
* **Eyelid closure without clipping**: sculpt the closed shape along the eyeball/eye-decal curvature, then move
  lash line + eyeline + eyelash parts with the lid (VRoid does this: all eye parts carry the `Fcl_EYE_Close`
  morph). Test blink at 3/4 view — clipping hides at front view.
* **The ARKit 52 set** (perfect sync): eyeBlink/LookDown/LookIn/LookOut/LookUp/Squint/Wide ×L/R (14), jawForward
  /Left/Right/Open (4), mouthClose, mouthFunnel, mouthPucker, mouthLeft/Right, mouthSmile ×2, mouthFrown ×2,
  mouthDimple ×2, mouthStretch ×2, mouthRollLower/Upper, mouthShrugLower/Upper, mouthPress ×2, mouthLowerDown ×2,
  mouthUpperUp ×2 (23), browDown ×2, browInnerUp, browOuterUp ×2 (5), cheekPuff, cheekSquint ×2 (3),
  noseSneer ×2 (2), tongueOut (1). `mouthClose` is relative to `jawOpen` (lips together while the jaw is open).
* **VRoid shapes** (`Fcl_*`): `ALL_*` (full emotions), `BRW_*`, `EYE_*` (Natural, Angry, Close(+L/R), Joy(+L/R),
  Sorrow, Surprised, Extra), `MTH_*` (A I U E O, Up, Down, Angry, Neutral, Fun, Joy, Sorrow, Surprised),
  `HA_*` (fangs), `EyeExtra`. `blender/anime_creator/arkit.py` derives the ARKit 52 from them; the MPFB path
  (`blender/human_creator/face.py`) synthesises them from MakeHuman expression units.
* **Mouth corners**: keep a tiny amount of geometry *inside* the lip line (the carved mouth interior) so opening
  shows depth instead of a hole; anime mouths want the corners to stay sharp (2 loops, no bevel).

---

## 7. Texture technique (clean results in Blender / numpy)

**Rule: faces are drawn, not projected.** Every face mark is a vector shape evaluated per texel at full
resolution. The face_kit painter does it like this:

1. **Bake a position map** of the face UVs (each texel → its 3D rest position + normal) once per base mesh.
2. Map positions into a **face-local 2D frame** (x = side, y = up, measured from landmarks: eye centres, nose
   tip, mouth centre, chin) — a frontal projection that is stable across UV seams.
3. Describe every mark as a signed distance function in that frame: ellipses, tapered polylines/Béziers,
   jagged-edge regions (beard), bands following a curve (fringe shadow). Anti-alias by the texel footprint
   (`coverage = clamp(0.5 - d/px, 0, 1)` with `px` = face-space size of one texel).
4. **Flat fills + hard edges**: composite layers with alpha-over in sRGB order: base skin → accents (blush,
   stubble) → occlusion darks → lines → beard/brows. No airbrush noise, no photo textures.
5. Paint features that live on separate parts (VRoid iris / eyeline / lash / brow / mouth textures) directly in
   those parts' own UV space, detecting the part's coverage by rasterising its triangles (paint only where the
   mesh actually samples).
6. **Resolution**: 2K (2048²) for a face-only texture = ~1 px per 0.1 mm at avatar scale — lines 3–8 px wide.
   A 4K body atlas usually gives the face < 600 px — **too low**; give the head its own 2K texture/material.
   Iris textures: ≥ 256 px per iris.
7. **Seams**: pad (dilate) every painted texture by 8–16 px past its UV islands; place UV seams behind the ears
   and under the chin where lines never cross; evaluate marks in 3D face space (step 2) so lines crossing a
   seam stay continuous.

Failure modes we have hit and the fix:

| symptom | cause | fix |
|---|---|---|
| blotchy mush, smeared features | projecting a low-res reference crop onto the mesh | draw vector marks at texture res (above); a reference is for *measuring*, never for pixels |
| face looks lit from one side forever | baked lighting in the albedo (photo / AI image projection) | albedo carries only colour + occlusion darks |
| black blobs at nose/mouth when turning | outline on high-curvature detail | outline width mask 0 around nose, mouth, eyes |
| terminator crawls over lips while talking | shading normals from the deforming mesh | proxy normal transfer (section 4.2) |
| visible lines across the face | UV seams + unpadded texture / torn outline hull | dilate textures, averaged hull normals |
| eyes look dead | no catchlight / no lid shadow / iris fully visible | section 2 |
| sticker look | pure black lines, grey shadows | dark warm line colour, saturated warm shade tone |

---

## 8. What makes a face appealing (vs uncanny)

Appeal is **clarity + consistency + youthful ratios within the chosen style**:

* one clear read at thumbnail size: eyes (the focal point), then mouth, then hair silhouette;
* **symmetry of construction** with a controlled asymmetry of expression (a smirk, one brow raised);
* consistent line weight family (lash line heaviest, brows next, face interior lines thinnest);
* shapes from one design language (all rounded for cute, angular for cool) — mixing a realistic nose with anime
  eyes is the #1 uncanny cause;
* soft, **saturated, warm** shadows; no grey; highlights bright and few;
* eyes: correct lid overlap, both catchlights on the same side, looking at the same point;
* nothing "almost real": either stylise fully (anime) or commit to comic structure (planes + designed lines).

### Self-review checklist (answer every line with yes before showing anyone)

1. At 128 px thumbnail, can you tell the sex, age, and mood?
2. Are the eyes at/below the head midline (anime) / on the midline (comic)?
3. Does each eye have lid overlap, a lid shadow on the sclera, an iris gradient, and matching catchlights?
4. Is the upper lash line the darkest, heaviest mark, tapering correctly (wing on F)?
5. Brows: F thin + high, M thick + low, colour = hair shade?
6. Is the nose minimal (anime) / built from shadow shapes (comic)?
7. Mouth small (anime) / lip planes (comic)? Teeth flat and drawn?
8. Are shadows single clean shapes following plane breaks? Any blotch around nose/mouth/sockets?
9. Is any line black? Any shadow grey? (both = no)
10. Blink, smile, surprise, aa / oo / ee / ff: clean at front AND 3/4? No lid clipping, no lash folding, no
    torn outline, no terminator flicker?
11. Side by side with the reference **at identical framing** (below): list the 3 biggest differences. Fix, repeat.

### Judging against a reference at identical framing

* Same camera: front view with the camera at eye height, field of view ~28° (the app's), crop so the head
  (crown→chin) fills the same fraction of the frame as in the reference; for 3/4, match the yaw by the position
  of the far eye relative to the nose bridge.
* Put them next to each other in the **app renderer** (the harness below), not Blender — MToon exposure, outline
  weight and shadow tint read very differently.
* Compare in this order: head shape/proportions → eye shape/size/spacing → brow → nose/mouth placement → shadow
  shapes → colour → line weight → details (scars, stubble). Silhouette IoU is not a quality metric.

---

## 9. Style recipes (`blender/face_kit/presets/`, all proven in the app renderer)

| preset | base | eyes | lashes | brows | shading |
|---|---|---|---|---|---|
| `gacha_girl` | VRoid Shino (long hair), eyes x1.2 | tall iris, navy top -> blue -> cyan bottom, caustic glow, streaks, main + dot + 2 sparkles | heavy winged line (0.32 eh) + 3 spikes, lower hint | thin high arch | ellipsoid proxy normals, warm shade, matcap off |
| `vtuber_girl` | VRoid HairSample female (twintails), eyes x1.18 | magenta iris with gold glow, big soft highlight | medium wing + 2 spikes | thin | proxy normals, hatched blush, dot nose |
| `anime_boy` | VRoid Fumiriya | amber iris, heavy lid band, one highlight | thin flat line, no lower, no wing | thick straight low, inner end lower | proxy normals, wedge nose |
| `chibi` | VRoid Shibu, head x1.45, eyes x1.4 lower, chin -1 | huge round iris, big highlight pair | medium | small, high | proxy normals, strong round blush |
| `comic_bearded_man` | MakeHuman male (MPFB), male_strong + longer face | comic green/yellow iris on the eyeball, thin lash line on the lid margin | thin | heavy, low, angled to the nose | Laplacian-smoothed normals + 20 % ellipsoid, shade shift -0.1, beard shell, eyepatch cap + strap ribbon, clump hair |
| `comic_woman` | MakeHuman female (MPFB), stylised | blue iris x1.32 on the eyeball | winged line + 3 spikes | arched, thin | smoothed normals + 55 % ellipsoid, shade shift -0.5 (mostly lit), polygon lips, clump hair with side-swept bangs |

---

## 10. Toolkit (`blender/face_kit/`, full reference in its README.md)

```
# anime faces on CC0 VRoid bases (numpy only; ~40 s)
python blender/face_kit/anime_face.py gacha_girl <out_dir>
# comic / semi-real faces on MakeHuman (headless low-priority Blender for the base + hair; ~60 s one-shot)
python blender/face_kit/comic_face.py comic_bearded_man <out_dir>
```

Both write `<id>.vrm|.glb` + `profile.json` ready for the app. Everything is automatic from the preset: landmarks are
found from geometry, so the same preset works on other bodies of the same base family.

### Engine support

* VRM faces: MToon (three-vrm). face_kit sets crisp cel values per part, removes the VRoid matcap rim and face
  normal map (they fight clean shading) and gives face + body skin a warm shade colour.
* GLB faces (comic): the engine's anime toon shader (`src/avatar/toon.ts`) reads the exported custom normals, and
  since 2026-09-25 honours a per-material glTF extra **`vtpShadeShift`** (-1..1, MToon-style; negative = lit further
  round the form). face_kit writes it on the face + body skin (same value -> no neck seam). Also read: `vtpRim`.
* SDF face shadow maps (Genshin-style, section 4.3) are NOT needed for the current looks — proxy/smoothed normals +
  shade shift give clean shapes on every angle the tracker produces. They remain the upgrade path if a style needs
  art-directed nose / cheek shadow shapes; they need a symmetric face UV (the comic face UV already is).

### Replacing eyes painted into a model (`profile.eyes.replaceBaked`)

Uploaded / AI-made models (Tripo, Meshy, hand-painted GLBs) often have their eyes **painted into the face texture** —
they can't blink or look around. Face tab → Eyes → **Replace the model's painted eyes (tracked eyes)** turns them into
generated eyes that track (code: `shared/bakedEyes.ts`, `src/avatar/bakedEyes.ts`, `src/avatar/inpaint.ts`):

* The painted eye is **erased from a copy of the texture in memory** (the model file is never touched): the face
  triangles around each eye marker are rasterised in UV space with their position in the eye frame; texels inside the
  erase area are filled from the skin just around it (push-pull + harmonic smoothing, the skin's own fine grain, a
  short feather); texels no face triangle near the eye maps to are never touched, so atlases stay intact. Texture bytes
  are read back exactly (WebGL2 readback, no premultiplied-alpha damage to hair cards in the same atlas).
* **The painted eye is found automatically** (eye white + dark lines crowding together, beside the marker, on its own
  side of the face: brows, scars, teeth and the other eye are skipped). The erase area wraps it (`cover` scales it,
  `nudge` moves it). "Fit to the painted eyes" (and turning the option on the first time) moves the markers onto the
  painted eyes and sets the eye size + the painted iris colour.
* Separate eye meshes near the markers (iris / sclera / lid / lash parts) are hidden; eyeballs set into a **hole** in
  the face are kept and turned into plain skin (the drawn eye sits on them). The model's own eye shapes are held still.
  VRM eyes (real eye geometry that already tracks) are left alone.
* **The eyelid**: auto = the skin measured in a ring just outside each erased eye (linear-light average, outliers
  such as hair strands and lash tips dropped) — the closing lid is simply that skin, lit by the face's own material.
  A custom `lidColor` is drawn by a second pass that MULTIPLIES the lit skin by lid ÷ skin (blend dst × 2·src), so the
  lid keeps the face's cel shadows, rim light and tier post effects instead of glowing flat in shadow. The lid covers
  what the rest-open eye covers and the current lids don't (blink, squint, the ^^ smile arch, angry / sad drops), with
  a soft rounding shade under the lash line.
* Cost: once per model + setup (RAM cache): ~0.4–1 s on a 2K face texture in the app (readback 24 ms, upload 4 ms),
  4K readback 35 ms / upload 15 ms; the per-eye CPU work is ~60 ms (2K) / ~150 ms (4K) — `tools/baked_eyes_unit.ts`.
* Limits: a painted face with heavy socket shading keeps that shading around the new eye; eyeballs in a socket show
  a faint seam at the socket rim with a custom lid colour; the drawn eye is the anime / painted style, so on a
  semi-real face it reads as an anime eye.

### Lessons from building the six test faces (bake these into any new face work)

1. **Draw, don't project.** Every face mark is an SDF evaluated per texel (`raster.posmap` + `sdf.py`).
2. **Give the head its own texture.** MakeHuman's atlas gives the face ~340 px; `split_face` gives it ~1700 px.
3. **Cylindrical face UVs overlap where the surface folds** (mouth cavity, nostrils, sockets, ear backs): move the
   triangles hidden behind the surface (radial z-buffer) to flat materials (cavity, flat drawn teeth, dark skin).
   Make those double-sided or the outline hull shows through the holes as black blobs.
4. **The upper lash line must straddle the lid margin and stay thin** (~1 mm on a human head). A thick line painted
   onto the lid skin becomes a black blob when the eye closes.
5. **glTF colour factors are linear.** A "black" eyepatch written as sRGB 0.07 renders mid-grey.
6. **Rigid props don't ride skin morphs.** A painted strap kinks with browDown; build it as a rigid ribbon
   (`strap_ribbon`), and an eyepatch as a membrane cap over a max-filtered depth (`patch_cap`), morphs zeroed.
7. **Beards need volume.** A skin shell (3-8 mm, thick at the chin) with a jagged clumped alpha fringe, strands as
   sparse strokes; normals lifted up/forward so the beard is mostly lit; the painted skin under it matches.
8. **Hair makes or breaks appeal as much as the face.** MakeHuman card hair recoloured flat reads as a helmet;
   clump hair (anime_hair toolkit, `face_kit/hair_styles.py`, rooted with `hang()` and swept with flow vectors)
   reads as a character. Hand-laid `locks()` must stay at ~1.05-1.08 skull radii or the top balloons.
   **Since 2026-09-25 use `blender/hair_kit` (mass -> streamline guides -> strands -> crescent-shell locks) and review
   every build with `tools/review_character.py` (17 studio-look views + failure detectors); see `docs/SCULPT_AND_HAIR.md`.**
9. **VRoid skins carry soft painted gradients + a matcap rim** that look like grey mud under cel light:
   flatten the front of the face to one tone and drop the matcap.
10. **Judge in the app renderer, at the reference's framing, every iteration.** Several "fixes" looked right in the
    texture and wrong on the model (cavity paint, lash thickness, patch colour).

## Sources

* Guilty Gear Xrd GDC 2015 talk (J. C. Motomura, Arc System Works) and "Guilty Gear Toon Line Control
  Techniques" (ASW Academy): inverted hull, vertex-colour line width, custom lighting normals.
* aVersion of Reality — "A Custom Normals Workflow for Clean, Stylized Toon Shading"; Blender NPR wiki
  (Abnormal normal spherizing); 80.lv / Fondant "clean normals" tools; Xelabo normal-editing mini tutorial.
* Genshin-style face shadow: kaze-mio/UnityGenshinToonShader, NoiRC256/URPSimpleGenshinShaders (NiloCat-based),
  ChiliMilk/URP_Toon, EricHu33 Anime Shading Plus (face shadow SDF baking workflow).
* MToon reference: vrm.dev MToon docs, VirtualCast wiki MToon reference, Santarh/MToon source.
* ARKit 52 / perfect sync: VMagicMirror perfect sync tips, VSeeFace manual, ARKit→FACS cheat sheet
  (melindaozel.com), arkit.miniface.org.
* Anime proportions and eyes: animeoutline.com (face structure, girl head), animefacelab.com, gvaat.com,
  Xencelabs anime head guide, maryliart.com; semi-real planes: Loomis method, Asaro head (gridmakerpro.com).
