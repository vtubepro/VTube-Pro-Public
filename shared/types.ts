// Shared contract between the web client, the local server, Blender scripts, and the MCP server.
// Everything that persists about an avatar lives in AvatarProfile (library/<id>/profile.json).
// All positions are in the MODEL's local space after the profile transform is NOT applied
// (i.e. raw glTF scene space, Y-up, metres, +Z = the model's front after `transform.yaw`).

export type Vec3 = [number, number, number];

/** A point picked on the model surface. */
export interface SurfaceMarker {
  position: Vec3;
  /** Outward surface normal at the point (unit). */
  normal: Vec3;
}

export type EyeMode = 'procedural' | 'model' | 'none';
export type EyeStyle =
  | 'bulb'      // protruding sphere eyes (frogs, cartoon critters) — sits ON the surface
  | 'inset'     // spheres pushed into the head (humanoid)
  | 'decal'     // flat anime/cartoon eyes painted onto the surface
  | 'led'       // glowing screen / LED eyes (robots): emissive shapes, shutter blink, emote shapes
  | 'anime';    // modern gacha-style anime eyes painted on the surface: tall almond, winged lash line,
                // gradient iris with streaks + limbal ring, shaped pupil, layered highlights

export type PupilShape = 'round' | 'star' | 'heart' | 'slit';

export interface EyeConfig {
  mode: EyeMode;
  style: EyeStyle;
  left: SurfaceMarker | null;
  right: SurfaceMarker | null;
  /** Eye radius in metres (bulb/inset) or decal half-height. */
  size: number;
  /** How far the eye protrudes along the surface normal, as a fraction of size (bulb). */
  protrusion: number;
  /** The performer picked this Source by hand (Face tab / "Add my model"): the automatic face setup
   *  (shared/autoFace.ts) never switches it back to generated eyes. Missing = not picked yet. */
  picked?: boolean;
  /** Eye depth: moves the eyes in (−) / out (+) along the face normal, model units like size (default 0). Bulb /
   *  inset eyes and model eye bones (VRM, leftEye / rightEye); painted eyes ignore it. Limits: shared/eyeDepth.ts */
  depth?: number;
  /** Which eyes are shown (shared/eyeLayout.ts): unset = both; 'left' / 'right' = only that eye (the other is hidden,
   *  optionally under `patch`); 'center' = one cyclops eye on the face midline (generated eyes only). */
  layout?: import('./eyeLayout.ts').EyeLayout;
  /** 'center' layout: the single eye's size, × `size` (default 1.4). */
  centerScale?: number;
  /** Generated eye patch + strap over the hidden eye ('left' / 'right' layouts), for any avatar. */
  patch?: import('./eyeLayout.ts').EyePatchConfig | null;
  scleraColor: string;
  irisColor: string;
  /** Iris radius as fraction of eye radius. */
  irisSize: number;
  /** Pupil radius as fraction of iris radius. */
  pupilSize: number;
  /** Eyelid colour — defaults to sampled skin colour at the marker (replaceBaked: the skin just around each eye). */
  lidColor: string | null;
  /** Replace eyes painted into the model's texture (or static eye meshes) with the generated, tracked eyes:
   *  shared/bakedEyes.ts. Unset / off = untouched. */
  replaceBaked?: import('./bakedEyes.ts').BakedEyesConfig | null;
  /** Adds an outline shell (toon look). */
  outline: boolean;
  /** Max gaze rotation (degrees). */
  gazeRange: number;
  /** Rest openness 0..1 (1 = wide). Lets sleepy/grumpy characters rest half-lidded. */
  restOpen: number;
  /** Specular highlight dot. */
  highlight: boolean;
  /** Resting scowl 0..1: the lids keep an angry tilt (grumpy characters); surprise / joy release it. */
  restAngry?: number;
  // ---- 'anime' style only (all optional; defaults in eyes.ts) ----
  /** Pupil shape (default 'star'). */
  pupilShape?: PupilShape;
  /** Bottom glow colour of the iris gradient (null/unset = a brighter version of irisColor). */
  irisColor2?: string | null;
  /** Upper/lower lash line colour (default '#1b1116'). */
  lashColor?: string;
  /** Winged flick + lash spikes at the outer corner, 0..1 (default 0.7). */
  lashWing?: number;
  /** Upper lash line thickness multiplier (default 1). */
  lashThickness?: number;
  /** Lower lash accent on the outer third, 0..1 (default 0.7). */
  lowerLash?: number;
  /** Glowing pupil colour (unset = the usual dark pupil). "Hollow" glowing eyes: dark sclera + bright pupil. */
  pupilColor?: string | null;
  /** Bulb / inset eyes only: puppet eyes instead of drawn eyes — 'button' (sewn-on button: irisColor = button,
   *  scleraColor = thread), 'googly' (loose pupil that rolls with gravity + head motion), 'felt' (flat felt disc
   *  + felt pupil). Unset / null = the normal eye. */
  puppet?: 'button' | 'googly' | 'felt' | null;
}

/** Surface look of non-VRM models. */
export interface LookConfig {
  /** 'anime' = albedo-tinted cel shadows + soft rim light; 'classic' = the original grey 3-band toon ramp;
   *  'realistic' = the model's own PBR materials (no outlines) with wrapped subsurface-style skin lighting;
   *  'toy' = stylised PBR for robots / props / toys: the model's own materials with studio reflections, a banded
   *  key light, crisp toon highlights and outlines. Unset in a saved profile → 'toy' for mechanical rigs, else
   *  'anime'. In 'anime', metallic materials (metalness ≥ 0.3) automatically get the stylised-PBR treatment. */
  shading: 'anime' | 'classic' | 'realistic' | 'toy';
  /** Glow (bloom) strength on emissive parts — LED eyes, grilles, flames. 0 = off, default 0.7. */
  bloom?: number;
  /** Final colour grade: saturation (default 1.04) and contrast (default 1.03); 1 = untouched. */
  saturation?: number;
  contrast?: number;
  /** Crisp toon highlights on glossy materials (roughness < ~0.7), 0..1 (default 1; anime + toy). */
  gloss?: number;
  /** 'realistic' only: 0 = photoreal .. 1 = semi-stylised (softly banded diffuse, less skin detail). */
  stylize?: number;
  /** Rim light strength 0..1 (anime). */
  rim: number;
  /** Shadow tint (sRGB hex) multiplied into the saturated albedo in shadow (anime). */
  shadowTint: string;
  /** Light/shadow terminator softness 0..1 (anime). */
  softness: number;
  /** Angel-ring highlight strength on hair 0..1 (0 = off; anime). */
  hairShine: number;
  /** Explicit hair mesh/material names; unset = auto-detect /hair|bang|fringe|ponytail|twintail/i. */
  hairMeshes?: string[];
  /** Small specular dot on the nose (needs both eye markers + the mouth marker). Unset = on for 'anime' eyes. */
  noseHighlight?: boolean;
  /** VRM only: MToon brightness under the studio lights (VRoid / MToon are authored for dimmer scenes). */
  vrmExposure?: number;
  /** Surface render style for the whole avatar (felt puppet, dragon scales, clay, plush, fur…); unset / 'none' =
   *  the plain look above. Works on GLB (all shadings) and VRM (MToon). Costumes / accessories keep their own look
   *  (CostumeDef.surface, glTF material extras `vtpStyle`, or `@style` in a material name). src/avatar/surfaceStyles.ts */
  surface?: SurfaceStyle | SurfaceStyleId;
  /** Per-material overrides, keyed by material or mesh name (exact, or a `/regex/i`); 'none' opts a part out. */
  surfaces?: Record<string, SurfaceStyle | SurfaceStyleId>;
}

/** Procedural material render styles (src/avatar/surfaceStyles.ts — every id has sensible defaults). */
export type SurfaceStyleId =
  | 'none'
  // fabric / puppet
  | 'felt' | 'sock' | 'fleece' | 'plush' | 'knit' | 'crochet'
  // toy / craft
  | 'clay' | 'plastic' | 'vinyl' | 'rubber' | 'porcelain' | 'paper' | 'cardboard'
  // hard / special
  | 'metal_brushed' | 'metal_painted' | 'glass' | 'crystal' | 'slime' | 'stone'
  // creature
  | 'scales_lizard' | 'scales_dragon' | 'scales_snake' | 'scales_fish' | 'scutes' | 'keratin' | 'wet_skin'
  | 'fur_short' | 'fur_long';

/**
 * One surface style + optional tweaks (all optional: unset = the style's preset). Sizes are metres at the avatar's
 * authored size; multipliers are 1 = preset.
 */
export interface SurfaceStyle {
  style: SurfaceStyleId;
  /** Re-colour (sRGB hex): replaces the hue, keeps the texture's light/dark detail. null/unset = model colours. */
  tint?: string | null;
  /** Secondary colour (sRGB): stitches / spots / belly / scale edges / exposed metal / cracks / horn tips. */
  color2?: string | null;
  /** Sheen / fuzz colour (sRGB, default white-ish from the surface colour). */
  sheenColor?: string | null;
  /** Pattern size multiplier (fibres, stitches, scales, cells). */
  scale?: number;
  /** Relief (bump) multiplier; 0 = flat. */
  relief?: number;
  /** Fuzzy rim / velvet sheen multiplier (fibre styles; 0 = off). */
  fuzz?: number;
  /** Per-fibre / per-stitch / per-scale colour variation 0..1. */
  variation?: number;
  /** Thin-film iridescence 0..1 (scales, crystal, beetle / fish shine). */
  iridescence?: number;
  /** Fake subsurface / light bleed 0..1 (slime, vinyl, porcelain, wet skin, jelly). */
  translucency?: number;
  /** Pattern variant: scales 'hex' | 'overlap' | 'cycloid' | 'keeled' | 'diamond'; knit 'stockinette' | 'rib' |
   *  'rib2' | 'garter'; fur / fleece 'straight' | 'curly'. */
  pattern?: string;
  /** Belly plates (scutes) on the front of the torso 0..1 (scale styles), or a lighter belly (wet skin). */
  belly?: number;
  /** Sewn seams: 'auto' (authored `_STITCH` vertex attribute, else UV seams + open borders when the mesh has
   *  few), 'seams', 'authored', 'none'. Default 'auto' on fabric styles, 'none' elsewhere. */
  stitches?: 'auto' | 'seams' | 'authored' | 'none';
  /** Stitch thread colour (sRGB). */
  stitchColor?: string;
  /** Stitch thread width in metres (default ~2.5 mm). */
  stitchWidth?: number;
  /** Fur / fleece length in metres (shell layers on High / Ultra; fibre shading on every tier). */
  furLength?: number;
  /** Strand coverage 0..1 (fur / fleece shells). */
  furDensity?: number;
  /** Shell fur: 'auto' (High / Ultra only), 'always' (also Balanced / Classic — costs GPU), 'off'. */
  shells?: 'auto' | 'always' | 'off';
  /** Hanging / droop of long fur 0..1 (gravity), wind sway 0..1 (both: shells only). */
  droop?: number;
  wind?: number;
  /** Stop-motion "boil" (clay): the surface detail re-sculpts itself 12×/s. 0..1. */
  boil?: number;
  /** Jelly wobble 0..1 (slime): the surface ripples. */
  wobble?: number;
  /** Edge wear / chipped paint 0..1 (metal_painted, plastic, porcelain). */
  wear?: number;
  /** Gloss override 0..1 (0 = matte … 1 = mirror-like cel highlight). */
  gloss?: number;
  /** Outline width multiplier (engine toon outlines; 0 = no outline on this part). */
  outline?: number;
  /** Pattern mapping: 'object' (default: seam-free, projected in the avatar's rest space) or 'uv'
   *  (the model's UVs; `scale` then = repeats per UV unit / 10). */
  mapping?: 'object' | 'uv';
}

/** Cheek blush decals (procedural faces). */
export interface BlushConfig {
  enabled: boolean;
  color: string;
  /** Blush amount at rest 0..1 (smiles / happy / cheek squint add to it). */
  rest: number;
  /** Diagonal anime hatch lines over the blush. */
  hatch: boolean;
  /** Blush half-width as a multiple of the eye size (default 1.1). */
  size?: number;
  /** Explicit cheek markers; unset = derived from the eye + mouth markers. */
  left?: SurfaceMarker | null;
  right?: SurfaceMarker | null;
}

export type MouthMode = 'procedural' | 'model' | 'none';
export type MouthStyle =
  | 'toon'   // conforming surface patch with a shader-drawn mouth (any mesh, zero topology changes)
  | 'cavity' // toon + real geometric jaw displacement of the surrounding skin
  | '3d'; // cavity + the opening is carved into the face (stencil portal) revealing a real 3D mouth
         // interior — back wall, hinged jaw, 3D tongue; teeth stay the flat drawn anime band. Opt-in.

export interface MouthConfig {
  mode: MouthMode;
  /** The performer picked this Source by hand (Face tab / "Add my model"): the automatic face setup
   *  (shared/autoFace.ts) never switches it back to a generated mouth. Missing = not picked yet. */
  picked?: boolean;
  style: MouthStyle;
  center: SurfaceMarker | null;
  /** Mouth half-width in metres at rest. */
  width: number;
  /** Max open height in metres. */
  openHeight: number;
  /** Radius (metres) of skin affected by jaw displacement / patch extraction. */
  influence: number;
  lipColor: string;
  interiorColor: string;
  tongueColor: string;
  teethColor: string;
  showTeeth: boolean;
  showTongue: boolean;
  lineWidth: number;
  /** Resting curve: -1 frown .. 0 flat .. 1 smile. The frog reference rests slightly frowny. */
  restCurve: number;
  /** Physical mouth: bones that open a MODELLED mouth (mouth seam, robot jaw, hand puppet). Works with
   *  mode 'model' (bones only) or 'procedural' (bones + drawn mouth). */
  rig?: JawRig;
  /** Per-avatar mouth behaviour rules (resting corner bias, jaw opening per viseme, voice puff): src/avatar/mouthRules.ts.
   *  Unset = the engine's defaults. */
  rules?: MouthRules;
}

/** Per-avatar mouth behaviour rules (all optional; src/avatar/mouthRules.ts). */
export interface MouthRules {
  /** Resting mouth-corner bias for avatars with their own smile / frown shapes: 0..1 = a content smile at rest, -1..0 = a
   *  frown. Added to the tracked corners (a real smile / frown still goes all the way; the bias gives way to the opposite
   *  expression). Typical 0.1..0.2. */
  cornerBias?: number;
  /** Jaw opening per speech viseme (×, 0..2; 1 = the engine's own amount), keyed by viseme id (sil PP FF TH DD kk CH SS nn
   *  RR L W aa E I O U). A very wide cartoon mouth reads better with a small "I" / "E" and a big "aa", e.g.
   *  {"I": 0.5, "E": 0.7, "aa": 1.1}. */
  visemeOpen?: Record<string, number>;
  /** A shape that swells with LOUD speech (a frog's throat sac, puffed cheeks), plus an optional idle breathing pulse.
   *  Automatic when the model has a morph named throatPuff / throatSac / vocalSac; null = off. */
  puff?: MouthPuffRule | null;
  /** How speech maps onto this mouth. 'human' (default) = human articulation (pucker / stretch / a jaw per syllable).
   *  'wideCartoon' = a very wide cartoon mouth (frog, toad, mascot, Pac-Man jaw): a small jaw for everyday talk (the full
   *  gape only for shouts / laughs / a held "aah"), rounding as corners pressing in instead of a protruding pucker,
   *  spreading as a thin slit instead of a stretch. Unset / 'auto' = 'human'; the studio SUGGESTS 'wideCartoon' for a
   *  jaw-bone mouth at least a tenth of the avatar's height wide (src/ui/mouthStyle.ts), the user switches. */
  style?: 'auto' | 'human' | 'wideCartoon';
  /** Highest jaw opening for everyday talk, 0..1 (wideCartoon default 0.55): louder speech, laughs and held vowels open
   *  further, up to the full gape. */
  speechJaw?: number;
}

/** profile.mouth.rules.puff: driven by the voice envelope (frame.mouth.loud / open / speak), so mic-less = idle only. */
export interface MouthPuffRule {
  /** The model's own morph target name (e.g. 'throatPuff') or an ARKit channel ('cheekPuff'). */
  shape: string;
  /** Peak weight 0..1 at full loudness (default 0.8). */
  amount?: number;
  /** Loudness 0..1 where the puff starts (default 0.5; everyday talk peaks around 0.4..0.55). */
  threshold?: number;
  /** Swell / settle time constants in seconds (default 0.08 / 0.35). */
  attack?: number;
  release?: number;
  /** Idle breathing pulse while quiet: peak weight 0..1 (default 0 = off) and rate in Hz (default 0.35). */
  idle?: number;
  idleRate?: number;
  /** Pulse on each M / B / P release (the lips parting after a seal), as a share of `amount` (default 0 = off; the
   *  cartoon mouth style suggestion sets 0.4). */
  plosive?: number;
}

/**
 * Bone-driven mouth. The runtime works out each bone's hinge axis (the avatar's left-right axis in the
 * bone's space) and which way is "open" (jaw tip down, upper head up), so a model only has to name
 * the bones. Speech timing, F/V, M/B/P closures and expressions drive it like any other mouth.
 */
export interface JawRig {
  /** 'jaw': the lower jaw hinges down (frog mouth seam, robot jaw).
   *  'puppet': hand-puppet mouth — the upper head tips back and the lower jaw drops a little. */
  kind: 'jaw' | 'puppet';
  /** Lower jaw bone (hinge at its head). */
  jawBone: string;
  /** Degrees the jaw drops at full open. */
  openAngle: number;
  /** Puppet: bone holding everything above the mouth (eyes, nose, hat); tips back when talking. */
  upperBone?: string;
  /** Degrees the upper head tips back at full open. */
  upperAngle?: number;
  /** Degrees of jaw yaw for jawLeft / jawRight (default 6). */
  sideAngle?: number;
  /** What shows speech (one or the other): 'motion' (default) = the jaw moves, *VoiceGlow* parts stay
   *  steadily lit; 'light' = the jaw stays shut and the *VoiceGlow* parts (speaker grille, chest light)
   *  pulse with the voice instead. */
  drive?: 'motion' | 'light';
  /** Cartoon follow-through 0..1 (default 0): the jaw springs past its target on fast opens and settles (0 = the plain
   *  smoothed jaw). It never swings past closed. */
  bounce?: number;
}

export interface BrowConfig {
  enabled: boolean;
  color: string;
  thickness: number;
}

export type RigKind = 'vrm' | 'humanoid' | 'soft' | 'none';

/**
 * Soft rig: a procedural skeleton generated for meshes that come with no rig at all.
 * Heights are normalized over the model bbox (0 = feet, 1 = top).
 */
export interface SoftRigConfig {
  neck: number;
  chest: number;
  hips: number;
  /** Arm roots as normalized [u,v,w] in bbox space (u=x, v=y, w=z). Null = no arms detected. */
  leftShoulder: Vec3 | null;
  rightShoulder: Vec3 | null;
  leftHand: Vec3 | null;
  rightHand: Vec3 | null;
  /** Width of the weight blend around each joint (normalized height units). */
  blend: number;
  /** Every joint found on the model itself (the import renders the model and runs body tracking on the picture:
   *  src/avatar/poseJoints.ts), [u,v,w] in bbox space like the shoulders / hands. When present they place the soft
   *  rig and Blender's autorig (elbows, knees, feet included) instead of the height-slice guesses. */
  joints?: Partial<Record<SoftJoint, Vec3>>;
  /** Where the joints came from: 'pose' = body tracking on a render, 'shape' = the silhouette guess. */
  jointSource?: 'pose' | 'shape';
}

export type SoftJoint = 'hips' | 'spine' | 'chest' | 'neck' | 'head' | 'headTop'
  | 'leftUpperArm' | 'leftLowerArm' | 'leftHand' | 'rightUpperArm' | 'rightLowerArm' | 'rightHand'
  | 'leftUpperLeg' | 'leftLowerLeg' | 'leftFoot' | 'rightUpperLeg' | 'rightLowerLeg' | 'rightFoot';

export interface JiggleRegion {
  id: string;
  name: string;
  /** Centre in model space. */
  center: Vec3;
  radius: number;
  /** 0..1 — springiness. */
  stiffness: number;
  /** 0..1 — how fast motion settles. */
  damping: number;
  /** How much the region lags gravity/inertia (0..2). */
  amount: number;
  /** Bone name this region rides on (auto-resolved if empty). */
  parentBone?: string;
}

export interface SpringChainConfig {
  /** Root bone name; the chain follows its descendants. */
  rootBone: string;
  stiffness: number;
  drag: number;
  gravity: number;
  radius: number;
}

export interface TrackingTuning {
  /** Global expression intensity multiplier. */
  expressiveness: number;
  /** Per-ARKit-channel gain overrides, e.g. { jawOpen: 1.4 }. */
  gains: Record<string, number>;
  /** 0 = raw/jittery .. 1 = very smooth/laggy. */
  smoothing: number;
  headRotationScale: number;
  bodyFollow: number;
  mirror: boolean;
  trackHands: boolean;
  trackBody: boolean;
  /** Blend audio lip-sync into the mouth. */
  audioLipSync: boolean;
  /**
   * Facial-hair compensation: how much to trust direct lip geometry over MediaPipe's mouth
   * blendshapes. −1 = auto (detected from the camera image), 0..1 = manual.
   */
  facialHair: number;
  /**
   * How far the avatar follows your head through space (×: left/right, up/down, toward/away from the
   * camera). 1 = your real movement 1:1 in metres; 0 = pinned in place.
   */
  translate: Vec3;
  /** Cartoon amplification of arm motion (1 = 1:1). */
  armExaggeration: number;
  /** Springy follow-through on arms (0 = stiff, 1 = very bouncy). */
  armBounce: number;
  /** Keep the hands and forearms out of the body (bulky armour, a big chest): src/avatar/bodyGuard.ts. Off when unset. */
  bodyGuard?: boolean;
  /** How far the body reaches out in front for that: 1 = measured from the skeleton, up to 2 for thick armour. */
  bodyDepth?: number;
  /** Untracked arms (no body tracking, or the arm out of view) hang this many degrees below horizontal: shared/idleArm.ts.
   *  Unset = the built-in ~73 degrees. Lower it (about 50) for wide characters whose hands would rest inside the body. */
  idleArmDown?: number;
  /** What the arms do (shared/armPose.ts, "Arms" in the Tracking panel): unset = 'follow' (the tracked arms, a relaxed rest when
   *  unseen: exactly as before), 'sides' = the resting pose always, 'front' = forearms forward, hands together / on a desk. */
  armPose?: 'sides' | 'front';
  /** With armPose 'front': how the hands sit. Unset = 'together'. */
  armFront?: 'clasped' | 'desk' | 'controller';
  /** With armPose 'front': false = the pose never gives way to a tracked gesture. Unset = big gestures come through. */
  armFrontReact?: false;
  /** Finger + wrist smoothing (0 = snappy .. 1 = smooth). Unset = follows `smoothing`. */
  handSmoothing?: number;
  /** Hand gestures spawn emoji effects / trigger facial reactions. */
  gestureFx: boolean;
  gestureReactions: boolean;
  /** How strongly recognised expressions (your trained smile/angry/sad/…) push the avatar's face. 0 = off. */
  expressionBoost: number;
  /** Cartoon squash & stretch (eye pops, head stretch with the jaw). 0 = realistic. */
  cartoon: number;
  /** Speech crispness: how distinct/exaggerated voice-driven mouth shapes are (1 = natural, 1.5 = cartoon). */
  enunciation: number;
  /** When tracking is lost: per part hold / rest / voice life + transition times (shared/trackLoss.ts; missing = defaults). */
  trackLoss?: import('./trackLoss.ts').TrackLossSettings;
  /** Per ARKit channel input range + response curve + output range, saved with this avatar (shared/blendCurves.ts). Missing or
   *  a channel at its defaults = exactly the tracked value. Applied once before the frame reaches the avatar (3D and 2D). */
  blendCurves?: import('./blendCurves.ts').BlendCurves;
}

/**
 * A costume: a GLB whose skinned meshes are rigged to the SAME bone names as the base avatar
 * (plus optional extra bones parented to base bones — feathers, cane, sash tails get springs).
 * Built with blender/costume_kit.py so its bind pose matches the base exactly.
 */
export interface CostumeDef {
  id: string;
  name: string;
  /** GLB path relative to the avatar folder, e.g. "costumes/pimp.glb". */
  file: string;
  thumbnail?: string;
  /** Base-model mesh names hidden while this costume is worn (e.g. the default outfit). */
  hides: string[];
  /** 'accessory' pieces (glasses, hats, cigars, face paint…) layer on top of any outfit; default 'outfit'. */
  kind?: 'outfit' | 'accessory';
  /** Face tweaks while worn (e.g. gold sclera for the pimp look). */
  eyes?: Partial<EyeConfig>;
  /**
   * Editable text painted at runtime onto a costume material (hat bands, signs, T-shirts).
   * The material's UVs span the label area 0..1.
   */
  labels?: CostumeLabel[];
  /**
   * Load-time anti-clip pass (runs for every costume). margin: body↔cloth clearance as a fraction
   * of avatar height (default 0.006; 0 disables the push-out). hideBody: drop base-body triangles
   * the costume fully covers (default true).
   */
  fit?: {
    margin?: number; hideBody?: boolean;
    /** Spheres whose body vertices the hide pass always treats as covered — e.g. a mask's mouth cavity, so a
     *  puckering moustache can't poke out of the mouth slit. center: base-model space (glTF metres, like the
     *  face markers), carried to the render frame through `bone`'s skin transform (default 'head'). */
    hideInside?: { center: Vec3; radius: number; bone?: string }[];
  };
  prompt?: string;
  /** Surface render style for every material of this costume / accessory (see LookConfig.surface). */
  surface?: SurfaceStyle | SurfaceStyleId;
  /** Held prop (bat, cane, brass knuckles): while worn, that hand (character's side) closes into a grip when it isn't
   *  tracked; tracked fingers can still curl further, never open past the grip. */
  grip?: 'left' | 'right' | 'both';
  source?: 'builtin' | 'blender-ai' | 'import';
}

export interface CostumeLabel {
  /** Material name on the costume mesh that shows the label. */
  material: string;
  text: string;
  color?: string;
  background?: string;
  /** CSS font family / weight, e.g. "900 Impact", "700 'Permanent Marker'". */
  font?: string;
  /** Label aspect (width/height) of the UV area. */
  aspect?: number;
}

export interface AvatarProfile {
  version: 1;
  id: string;
  name: string;
  /** Model filename relative to the avatar's library folder (glb/gltf/vrm/fbx/obj). */
  modelFile: string;
  thumbnail?: string;
  /** 'builtin-test': internal test avatars (e.g. fan remakes) that must not ship. */
  source: 'import' | 'tripo' | 'meshy' | 'blender-ai' | 'comfy' | 'builtin' | 'builtin-test';
  /** Computed by the helper on every list / get, never stored: true = comes with VTube Pro (protected, never deleted),
   *  false = the user's own avatar, whatever its profile's "source" says. An older version sends nothing. */
  shipped?: boolean;
  createdAt: string;
  prompt?: string;
  transform: { scale: number; offset: Vec3; yaw: number };
  eyes: EyeConfig;
  mouth: MouthConfig;
  brows: BrowConfig;
  /** Surface look (non-VRM). Optional for old profiles; normalizeProfile fills it in. */
  look?: LookConfig;
  /** Cheek blush (procedural faces). */
  blush?: BlushConfig;
  rig: {
    kind: RigKind;
    soft?: SoftRigConfig;
    /** Rigid/mechanical body (robots): no squash & stretch or flesh jiggle, parts move as solid pieces
     *  with a snappy servo feel. Materials named *VoiceGlow* light up with the voice. */
    mechanical?: boolean;
    /** Which bone of the model's own skeleton is which humanoid bone (three.js node name → VRM bone name, e.g.
     *  "左腕" → "leftUpperArm"), found by the "just drop a model" import (shared/modelImport/bones.ts). Used before the
     *  studio's own name matching (src/avatar/humanoid.ts). Missing = matched by name at load. */
    boneMap?: Record<string, string>;
    /** Which bone follows what on a 3D auto-rig of an animal, a bird, a snake or a thing (shared/rigMap.ts, written by the
     *  auto-rig, read by src/avatar/rigMap.ts): head / neck / back from the face tracker, legs and tail on their own,
     *  wings and loose ends moving by themselves. */
    retarget?: import('./rigMap.ts').RigRetargetMap;
  };
  physics: {
    enabled: boolean;
    jiggle: JiggleRegion[];
    chains: SpringChainConfig[];
    /** Auto-create spring chains for bones named hair/tail/ear/skirt/ribbon/etc. */
    autoChains: boolean;
    wind: number;
  };
  tracking: TrackingTuning;
  /** Wardrobe. */
  costumes: CostumeDef[];
  /** Active costume id (null = base model as-is). */
  costume: string | null;
  /** Accessory costume ids worn on top of the outfit (kind 'accessory'). */
  accessories?: string[];
  /** Speech-driven talking body language (src/avatar/speechMotion.ts). Unset / enabled false = off. */
  speechMotion?: SpeechMotionConfig;
  /** Intended real-world size of the character (shared/avatarSize.ts): its size class (micro … macro) decides how big
   *  it is in a room and which spots it may take. Missing = auto (an ordinary 1.7 m human, class normal). */
  size?: import('./avatarSize.ts').AvatarSizeConfig;
  /** Neck length + head motion for long necks (shared/neck.ts: length, sway, tilt, stiffness, maxTurn, smoothing). Missing /
   *  unset fields = auto from the measured neck (human necks: no change). */
  neck?: import('./neck.ts').NeckConfig;
  /** Body plan: 'quadruped' = on four legs (llama, giraffe, dog…): face / head / neck tracked, no arm / hand / leg
   *  retargeting, planted legs + idle life + walk gait (src/avatar/quadruped.ts), stands at seats. 'mech' = a pilot in a
   *  walking machine (src/avatar/mech.ts): legs walk only while travelling, hands on the sticks, stands at seats.
   *  'object' = a thing (lamp, plant): planted, no gait, no hip sway, only its bend chain and spring bones move.
   *  'serpent' = a snake / worm: planted, no gait, a slither runs down the body (shared/bodyKind.ts). Missing = biped. */
  body?: 'biped' | 'quadruped' | 'mech' | 'object' | 'serpent';
  /** Walking machine with a seated pilot (body 'mech'; shared/mech.ts: gait, hydraulic bob, pilot grips, rig names; runtime
   *  src/avatar/mech.ts). Missing = found by the rig naming contract, every setting at its default. */
  mech?: import('./mech.ts').MechConfig;
  /** Triangles / vertices / meshes of the model file (shared/modelStats.ts). Filled in by the server when it lists the
   *  library; never saved. Party limits: docs/MULTIPLAYER_DISCORD.md → "Polycount limit". */
  modelStats?: import('./modelStats.ts').ModelStats;
  /** The performer's own face-shape picks (the "Add my model" wizard): morph target name → an ARKit channel
   *  ('mouthSmileLeft' …) or a named preset ('aa', 'blink', 'happy' …); '' = ignore that shape. Only for names the
   *  automatic matching (shared/morphNames.ts) gets wrong or misses, e.g. VRoid 'Fcl_MTH_A' in a plain GLB. */
  faceMap?: Record<string, string>;
  /** Chat-buddy hand tuning that travels with the model (shared/buddyTune.ts): tablet hold, size, cartoon arm. Missing =
   *  measured from the rig (or the app's own preset for this id). */
  buddy?: import('./buddyTune.ts').BuddyTune;
  /** 2D avatar (shared/flatAvatar.ts): an image set (PNG / GIF …) or a plug-in kind (Live2D, Inochi2D …) shown as a card in
   *  the room, an OBS overlay, a walking TV's screen or the room's screen. Missing = a 3D model. */
  flat?: import('./flatAvatar.ts').FlatAvatarConfig;
}

/** Per-avatar strengths (1 = default amount, 0 = off) of the speech-driven motion layer. */
export interface SpeechMotionConfig {
  enabled: boolean;
  /** head dip on stressed syllables */
  nod?: number;
  /** slow conversational head tilt (roll) while talking */
  tilt?: number;
  /** slow small head turn drift while talking */
  turn?: number;
  /** brow lifts on emphasis */
  brow?: number;
  /** blink at phrase ends */
  blink?: number;
  /** one-sided mouth corner while talking */
  asymmetry?: number;
  /** voice life (mic-only / face lost, src/avatar/voiceLife.ts): gaze aversions + saccades */
  gaze?: number;
  /** voice life: light smile / cheek lift with lively speech */
  smile?: number;
  /** voice life: idle postural sway + breathing */
  sway?: number;
  /** voice life on/off for this avatar (default on: synthesised face life whenever the face isn't tracked) */
  voiceLife?: boolean;
}

// ---------- server API ----------

/** The only generator that ships is the local one: ComfyUI on this PC (server/providers/comfy.ts). */
export type GenerateProvider = 'comfy';

export interface GenerateRequest {
  provider: GenerateProvider;
  /** Text description (optional when images are provided). */
  prompt?: string;
  /** Reference images as data URLs (PNG/JPEG). */
  images?: string[];
  name?: string;
  /** Strip/ignore eyes & mouth in the generated model (we add procedural ones). */
  faceless?: boolean;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Job {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number; // 0..1
  log: string[];
  /** Latest preview image URL (e.g. Blender render between refine rounds). */
  preview?: string;
  result?: { avatarId?: string; [k: string]: unknown };
  error?: string;
  /** With `error`: a VTube Pro page path that fixes it ("/comfyui?workflow=character-3d&tier=medium"). The studio shows a
   *  "Set it up for me" button that opens it in VTube Pro. */
  fixUrl?: string;
  createdAt: string;
}

/** Can this ComfyUI make a 3D character right now (the Character 3D workflow's model files are in its folders)?
 */
export interface ComfyCharacterStatus {
  ready: boolean;
  /** The size that is ready (small / medium / large), or null. */
  tier: 'small' | 'medium' | 'large' | null;
  /** Helper page that sets it up ("/comfyui?workflow=character-3d&tier=medium"), tier chosen from the graphics card. */
  setupUrl: string;
  /** The user's own ComfyUI workflow file (Settings "comfyWorkflow") will run, so the 3D model files are not needed and a
   *  picture is only needed if that file asks for one. `ready` is then true. Absent = VTube Pro's built-in Character 3D runs. */
  own?: boolean;
}

export interface ServerStatus {
  blender: { available: boolean; path?: string; version?: string };
  comfy: { url: string; reachable: boolean; character?: ComfyCharacterStatus };
}

// ---------- live bus (WebSocket /ws) ----------
// The studio page publishes tracking frames; the OBS output page and remote controllers subscribe.

export interface TrackingFrame {
  t: number;
  /** ARKit-52 blendshape name -> 0..1, already filtered + amplified. */
  face: Record<string, number>;
  /** Head rotation (radians, avatar-space, mirror already applied): yaw, pitch, roll. */
  head: Vec3;
  /** Head translation relative to calibrated neutral (metres-ish). */
  headPos: Vec3;
  /** Head angular / linear velocity (per second, same spaces as head / headPos) for render-rate extrapolation. */
  headVel?: Vec3;
  posVel?: Vec3;
  /** Gaze in radians: yaw, pitch. */
  gaze: [number, number];
  /** Humanoid bone local rotations as quaternions [x,y,z,w], keyed by VRM humanoid bone name. */
  bones?: Record<string, [number, number, number, number]>;
  /** Normalized mouth shape for procedural mouths (derived from face). */
  mouth: { open: number; wide: number; smile: number; frown: number; pucker: number; funnel: number; tongue: number; fv?: number; sib?: number;
    /** 0..1 how much the performer is currently speaking (voice-led shapes take over from camera capture). */
    speak?: number;
    /** 0..1 lips closing for M/B/P articulation (from the voice). */
    closure?: number;
    /** 0..1 a sudden short drop of the voice inside speech (the silent hold of a P / B / T / K) — fast, unsmoothed. */
    gap?: number;
    /** Voice pitch, semitones vs the performer's own running median (present only on voiced frames) — prosody
     *  for the talking-face layer (src/avatar/voiceLife.ts). */
    pitch?: number;
    /** 0..1 laughter ("ha-ha-ha" burst train, src/tracking/vocalGestures.ts): the mouth stays open and smiles. */
    laugh?: number;
    /** 0..1 louder than the performer usually talks (shouting): bigger jaw, more teeth. */
    loud?: number };
  /**
   * Captured inner-lip contour: heights of the upper (u) and lower (l) inner lip at 7 points across
   * the mouth (t = −0.75…+0.75 along the corner line, + = avatar-left), in units of the neutral
   * half-width, relative to the corner line. Drives procedural mouths shape-for-shape.
   */
  lips?: { u: number[]; l: number[] };
  /**
   * Speech visemes (voice-timed, camera-confirmed), weights summing to 1: sil PP FF TH DD kk CH SS nn RR L W
   * aa E I O U. Absent when the mic is off — avatars then derive a viseme from `mouth` (see visemeRig.ts).
   */
  visemes?: Record<string, number>;
  /** GPU lip sync (Audio2Face-3D sidecar, src/tracking/a2fMerge.ts): gained ARKit mouth channels for the shown
   *  instant + `k` = blend weight 0..1. Absent when it is off / not running. The viseme rig blends it in. */
  a2f?: Record<string, number>;
  /** Recent gesture events (ids increase; viewers spawn effects for ids they haven't seen). */
  fx?: { id: number; kind: string; side: 'left' | 'right' }[];
  /** Food & drink fun layer (drink props in the hands, food mess on the face) — absent when the feature is off. */
  snack?: SnackFrame;
  /** A VRMA emote playing on the avatar (src/avatar/emotes.ts): viewers play the same clip from `at` (Date.now() ms). */
  emote?: { id: number; name: string; at: number; loop?: boolean };
  /** Face life (src/avatar/voiceLife.ts) already applied by the studio — its presence weight 0..1. Pages that
   *  render the frame (OBS output) then show exactly the studio's blinks / gaze / head instead of their own. */
  life?: number;
  /** Tracking-loss layer (src/tracking/trackLoss.ts): 0..1 how much face life may act while untracked (hold / rest = 0,
   *  voice life = its eased loss weight). Absent = 1 (the old behaviour). */
  lifeGain?: number;
  /** The face is STARVED (src/tracking/stallLife.ts StarveMeter): 0..1, its results come sparse / late (a game holding
   *  the graphics card). The face life acts by it on top of the held pose (blinks, gaze, sway, breathing instead of a
   *  statue) and viewers stop extrapolating the head along a velocity a sparse sample made up. Absent = 0. */
  starve?: number;
  /** 2D avatars: the studio's expression / motion hotkey cue (shared/flatAvatar.ts FlatCue) — absent when none. */
  flat?: import('./flatAvatar.ts').FlatCue;
  tracked: boolean;
}

/** Drink prop shown in an avatar hand. */
export type SnackProp = 'coffee' | 'mug' | 'can' | 'bottle' | 'glass';
/** Food-mess look. */
export type MessStyle = 'crumbs' | 'spaghetti' | 'cheeto' | 'chocolate' | 'sugar';
export interface SnackHand {
  k: SnackProp;
  /** 0..1 shown (pop-in / pop-out animation). */
  a: number;
  /** 0..1 sip: the prop tilts to the mouth, lips pucker on it. */
  sip: number;
}
/** Food & drink state as the studio decided it (viewers only render it). Sides are AVATAR sides. */
export interface SnackFrame {
  l?: SnackHand;
  r?: SnackHand;
  /** Mess levels 0..1: face (f), left hand (hl), right hand (hr). */
  m?: { s: MessStyle; f: number; hl: number; hr: number };
  /** Bite counter — viewers puff a few crumbs when it changes. */
  b?: number;
}

export type BusMessage =
  | { type: 'frame'; frame: TrackingFrame; peer?: string; ts?: number; seq?: number; net?: PartyNetStamp } // peer: a party guest's frame (else the local performer); ts: send time (epoch ms), seq: per-sender counter (OBS output timing / drop count)  (net: a party member's own sender clock + sequence, src/net/remoteSmoother.ts)
  | { type: 'pvoice'; peer: string; v: VoiceSample[] }  // party member's voice-derived mouth samples (~50 Hz, src/net/remoteSmoother.ts)
  | { type: 'party'; members: PartyMember[]; tvSelf?: (import('./tv.ts').TvInfo & { id: string; name?: string }) | null } // local studio → its OBS outputs: who is in the party (tvSelf: this PC's own performer is a TV; id = its feed id)
  | { type: 'profile'; avatarId: string }            // an avatar was (re)saved — reload it
  | { type: 'load'; avatarId: string; switchedAt?: number } // ask viewers to switch avatar (switchedAt: epoch ms of the performer's last avatar switch in that studio, 0 = none yet, absent = an older studio: an OBS page moves to a studio whose stamp goes up, src/outputFollow.ts)
  | { type: 'command'; command: string; args?: unknown } // remote control from MCP / API
  | { type: 'hello'; role: 'studio' | 'output' | 'control';
      /** Output pages only (shared/obsPages.ts): what kind of page this is, whether it runs inside OBS (window.obsstudio),
       *  and its size in CSS px = the Browser Source's Width/Height. The helper tracks these for "OBS is connected". */
      page?: 'obs' | 'browser' | 'preview' | 'test' | 'engine'; obs?: boolean; w?: number; h?: number; obsVersion?: string }
  | { type: 'ext'; data: ExternalTracking }           // phone / VMC / VTS-plugin tracking, relayed by the server
  | { type: 'output'; settings: OutputSettings }       // OBS output layout (size / position), live
  | { type: 'scene'; state: SceneState; self: string } // 3D scene (room / mode / camera / spots) — `self` = the member key of this PC's performer
  | { type: 'roomEdits'; id: string; rev: number; apply: boolean } // Room editor: the user's edits of room `id` were saved (apply = the pages showing it apply them now; else they only refresh their room list) — docs/ROOM_EDITOR.md
  | { type: 'beat'; b: import('./lightShow.ts').BeatPacket } // studio beat analysis → OBS lights (shared/lightShow.ts)
  | { type: 'health'; h: import('./graphics.ts').TrackingHealth } // studio → this PC's OBS pages (~1 Hz): face-tracking health for Auto graphics quality
  | { type: 'gfxlower'; from: import('./graphics.ts').GfxLevel; to: import('./graphics.ts').GfxLevel; why: string } // OBS page → studio: "Lower quality automatically" stepped down (the studio shows OK / Undo)
  | { type: 'gpustat'; s: import('./gpuStat.ts').GpuStat } // helper → this PC's pages (every few seconds while an OBS page is connected): the graphics card's memory + utilisation (server/gpuWatch.ts)
  | { type: 'obsstarve'; level: 0 | 1 | 2; why: string; fps: number; acted: boolean } // OBS page → studio: frames seconds apart (a game holding the card); `acted` = it switched to the lightest look (src/stage/gfx/starve.ts)
  | { type: 'obsperf'; p: import('./gpuStat.ts').ObsPerfReport } // OBS page → studio / helper diagnostics, every 5 s
  // live chat + support events (shared/chat.ts): server → this PC's pages (origin 'local'); a guest's studio relays the
  // host's (origin 'party'); `snap` = a catch-up batch for a page that just connected; `tot` = session support totals
  | { type: 'chat'; evs: import('./chat.ts').ChatEvent[]; tot?: import('./chat.ts').ChatTotals; origin?: 'local' | 'party'; snap?: boolean }
  | { type: 'chatStatus'; status: import('./chat.ts').ChatStatus }
  | { type: 'poll'; s: import('./poll.ts').PollView | null } // chat poll standings (server/poll.ts): this PC's pages — the OBS poll card, Chat Hub, studio
  | { type: 'djdeck'; s: import('./djDeck/reader.ts').DeckSnapshot; origin?: 'party' } // DJ decks: the controller's physical controls (server/music/deckRig.ts, listen-only); a guest studio relays its host's (origin 'party')
  | { type: 'goals'; s: import('./goalsView.ts').GoalsView; origin?: 'party' } // goals, stretch goals + the subathon timer (server/goals.ts): every page draws this view; a guest studio relays its host's (origin 'party')
  | { type: 'audience'; s: import('./audience.ts').AudienceView } // the chat audience (server/audience.ts): seated chatters, approved questions, applause, supporter tiers — this PC's pages
  | { type: 'chathub'; m: import('./chathub.ts').ChatHubBus } // host Chat Hub (server/chat/hostHub.ts): events queue, TTS lines (played by the studio) — this PC only
  | { type: 'showsound'; id: string; s: import('./showSound.ts').ShowSound } // an OBS page's room sound → the studio plays it, once per id (output pages are silent: shared/showSound.ts)
  | import('./audioLeader.ts').SoundHello | import('./audioLeader.ts').SoundBye | import('./audioLeader.ts').SoundLead // VTube Pro picks the ONE studio that plays the show's sounds (shared/audioLeader.ts)
  | { type: 'liveclock'; src: string; lag: number } // an OBS page's live-stream player: seconds behind its live edge (the studio's sound follows: shared/showSound.ts liveSteer)
  | { type: 'curtain'; status: import('./curtain.ts').CurtainStatus } // OBS page → studio: room-change transition progress (src/scene/transition)
  | { type: 'ttrpg'; m: import('./ttrpg/wire.ts').TtrpgBus } // TTRPG table (src/ttrpg): speech timing, images, VTT bridge relays — this PC only, never secrets
  // react screen share (src/scene/screenShare.ts): the host studio streams its picked window to this PC's OBS pages
  // over a localhost WebRTC link; these are its signalling messages (never leave this PC — the bus is 127.0.0.1)
  | { type: 'screen'; k: 'hello' | 'avail' | 'offer' | 'answer' | 'ice' | 'bye' | 'stats' | 'want'; from: string; to?: string; sdp?: string; cand?: RTCIceCandidateInit | null; stats?: import('./screenShare.ts').ScreenRxStats; label?: string; /** 'want': does this page draw the window right now? (no message = yes: older pages never send it) */ on?: boolean }
  // TV performers (shared/tv.ts, src/net/tv/tvLocal.ts): the studio streams every TV feed (its own + the party's) to this
  // PC's OBS pages over localhost WebRTC — signalling + voice levels (`lv`: feed id → 0..1, ~15 Hz). Never leaves this PC.
  | { type: 'tvfeed'; k: 'hello' | 'avail' | 'offer' | 'answer' | 'ice' | 'bye' | 'lvl' | 'stats'; from: string; to?: string; sdp?: string; cand?: RTCIceCandidateInit | null; map?: Record<string, string>; lv?: Record<string, number>; /** guestlink: browser guests' voice volume 0..1.5 on the OBS page */ vol?: Record<string, number>; stats?: Record<string, unknown> }
  // party games (src/game/trail): this PC's studio → its OBS pages ('on' / 'off' mount the spectator view; 'ctl' = a
  // reliable game message, 'snap' = a realtime snapshot; 'sync' = a spectator page asking for a catch-up)
  | { type: 'trail'; k: 'on' | 'off' | 'ctl' | 'snap' | 'sync'; d?: unknown; from?: string }
  // room favourites + recent rooms changed (server/routes/roomPrefs.ts): every studio tab of this PC follows
  | { type: 'roomPrefs'; prefs: import('./roomPrefs.ts').RoomPrefs }
  // Support & store (beta.13, server/support/*): every accepted support event (tips, merch, patrons ...), moderation of
  // their messages, the product showcase, the services' status and the supporters list. This PC only, never a key.
  | import('./support.ts').SupportBusMessage | import('./support.ts').SupportModerationMessage
  | { type: 'supportShow'; v: import('./supportConfig.ts').ShowcaseView }
  | { type: 'supportStatus'; s: import('./supportConfig.ts').SupportStatus } | import('./supportConfig.ts').SupportVoidMessage
  | import('./supporters.ts').SupportersBusMessage
  // DJ sync (server/music, shared/musicClock.ts): the helper's music clock ~30 Hz + DMX universes from the DJ's light show
  | import('./musicClock.ts').MusicClockMsg | import('./dmxIn.ts').MusicDmxMsg
  // Track library (server/music/trackSync.ts): a track's pre-built light show, once per track (src/scene/trackShowRx.ts)
  | { type: 'trackshow'; show: import('./trackShow.ts').TrackShow }
  // VTube Pro Live (docs/BROADCAST_PROTOCOL.md): page stamps (page -> helper only, never relayed) + the helper's state / health / notice / stampstats
  | import('./broadcastTypes.ts').BroadcastBusMessage;


// ---------------------------------------------------------------- external tracking sources
/**
 * Tracking that arrives from outside the browser (the server listens on UDP / WebSocket and relays it
 * over the bus): iPhone/Android ARKit apps speaking the VTube Studio phone protocol (VTube Studio iOS,
 * MeowFace), iFacialMocap / FaceMotion3D, Epic's Live Link Face (iPhone), the VMC protocol (VSeeFace, XR Animator, Webcam Motion
 * Capture, Warudo…), and VTube Studio API plugins injecting parameters.
 */
export type ExternalSourceKind = 'vts-phone' | 'ifacialmocap' | 'livelinkface' | 'vmc' | 'vts-api' | 'openseeface';

export interface ExternalTracking {
  source: ExternalSourceKind;
  /** Seconds (sender clock not trusted — this is the server receive time). */
  t: number;
  /** Face found this packet. */
  found: boolean;
  /** ARKit-named blendshapes 0..1 (eyeBlinkLeft, jawOpen, mouthSmileLeft …), already in the performer's
   *  left/right (NOT mirrored). */
  blendshapes?: Record<string, number>;
  /** Head rotation, degrees: pitch (+ down), yaw (+ performer's left), roll (+ tilt to performer's left). */
  head?: Vec3;
  /** Head position in metres relative to the sensor, if known: x (+ performer's left), y (+ up), z (+ toward camera). */
  headPos?: Vec3;
  /** Eye rotations, degrees [pitch, yaw] (+ down, + performer's left). */
  eyeLeft?: [number, number];
  eyeRight?: [number, number];
  /** Which head axes the helper flipped (bit 1 yaw, 2 pitch, 4 roll; absent = none): a change means the rest pose is stale. */
  inv?: number;
  /** VMC full-body bones (Unity humanoid names → local position + rotation quaternion xyzw, Unity space). */
  bones?: Record<string, { p: Vec3; q: [number, number, number, number] }>;
}

/** OBS output page layout, set from the studio (OBS tab) and applied live to every output page. */
export interface OutputSettings {
  /** Avatar size multiplier (1 = auto-framed). */
  scale: number;
  /** Screen-space offset in fractions of the frame: x (+ right), y (+ up). */
  offset: [number, number];
  /** Camera framing. */
  focus: 'full' | 'bust' | 'head';
  /** Multiplayer: how party members are laid out. */
  layout?: 'row' | 'grid' | 'free';
}

// ---------------------------------------------------------------- multiplayer (party) — docs/MULTIPLAYER_DISCORD.md
/**
 * A remote performer shown next to you (up to 7 guests + you). Their avatar is NEVER stored on disk: it lives
 * AES-GCM-sealed in the local server's RAM vault (/api/party/vault, see server/partyVault.ts) and only the pages
 * that got `sealed` (this PC's studio → its OBS pages over the loopback bus) can open it.
 */
export interface PartyMember {
  id: string;
  name: string;
  /** Layout slot (0 = you). */
  slot: number;
  /** Discord identity, verified by the relay when they joined through a Discord invite. */
  discord?: DiscordIdentity | null;
  /** Joined through the Discord relay with a signed ticket (false = manual invite code). */
  verified?: boolean;
  /** Owner's re-share rule for their avatar ('party' | 'guild' | 'host'). */
  share?: SharePolicy;
  /** They agreed to share their avatar this session. */
  avatar?: boolean;
  /** Local only (bus → this PC's OBS pages, never sent to peers): how to open their sealed avatar. */
  sealed?: SealedAvatarRef | null;
  /** Local only: extra lip delay (ms) so their mouth lines up with their Discord voice. */
  lipDelay?: number;
  /** A TV performer (webcam / VTube Studio on a walking TV, shared/tv.ts): no model, a live video feed instead. */
  tv?: import('./tv.ts').TvInfo | null;
}

export interface DiscordIdentity {
  /** Discord user id (snowflake) — the stable key (seat memory, bans). */
  id: string;
  /** Display name (global name or username). */
  name: string;
  username?: string;
  /** Avatar hash (cdn.discordapp.com/avatars/<id>/<hash>.png) or null. */
  avatar: string | null;
}

/** Who may see MY avatar besides the host: everyone in the party, only members verified in the room's Discord
 *  server/role, or nobody but the host. */
export type SharePolicy = 'party' | 'guild' | 'host';

/** One item in the local RAM vault: id + capability (both random; the server only keeps a hash of the cap). */
export interface VaultRef { id: string; cap: string }
/** Everything an OBS page needs to open a party member's avatar (sent only on this PC's loopback bus). */
export interface SealedAvatarRef {
  /** AES-GCM-256 key, base64url (per member, per session; never leaves this PC). */
  key: string;
  profile: VaultRef;
  model: VaultRef;
  costume: VaultRef | null;
  /** Bumps whenever any of the above changes (OBS reloads that member). */
  rev: number;
}

/** Sender timing of a party frame: sender clock ms (performance.now, mod 2^32) + sequence number. */
export interface PartyNetStamp { s: number; q: number }

/** Voice-derived mouth sample (voice front-end `voice.onFrame({t, vad, level, visemes})` + the camera mouth).
 *  t = sender clock ms; vis = top-3 [visemeIndex (VISEMES order), weight 0..1]. */
export interface VoiceSample { t: number; vad: number; level: number; open: number; closure: number; vis: [number, number][] }


// ---------------------------------------------------------------- 3D scenes (docs/SCENES.md)
/** Scene mode: 'talk' | 'react' | 'gaming' built in; other registered modes (src/scene/stage/registry.ts) use their own id
 *  (shared/stage.ts MODE_ID). Pages that don't know a mode render it like Talk. */
export type SceneMode = 'talk' | 'react' | 'gaming' | (string & {});
/** React layout: 'auto' = solo side screen when exactly one performer is in the room, else the big centre screen. */
export type ReactLayout = 'auto' | 'solo' | 'big';
export type ScreenMode = 'auto' | 'inscene' | 'passthrough';
/** `glassV` 2 = the glass sheen was chosen after it became opt-in (older saved states with glass on read as off). */
export interface ScreenSettings { mode: ScreenMode; scanlines: boolean; glass: boolean; glassV?: 2 }

/** Per light group (LIGHT_* extras.group / EMIT_<group>) program — see shared/lightShow.ts. */
export type LightProgram = 'steady' | 'pulse' | 'chase' | 'strobe' | 'breathe' | 'cycle' | 'flicker' | 'drift' | 'drop' | 'off';
export interface LightGroupSetting {
  program: LightProgram;
  /** 0..2 on top of the master intensity. */
  intensity: number;
  /** null = the authored colour, else '#rrggbb'. */
  color: string | null;
  /** 0.25..4 (chase sweeps per bar, breaths per bar, flicker rate …). */
  speed: number;
}

/** Lights settings (src/scene/lightShow.ts). */
export interface SceneLightsState {
  /** Preset ("show") the groups follow unless set explicitly in `groups` (shared/lightShow.ts LIGHT_PRESETS). */
  program: string;
  /** Follow the music (the studio's beat analysis). Off (or no music) = every beat program eases to steady. */
  reactive: boolean;
  /** 0..2 master intensity. */
  intensity: number;
  /** Per-group overrides of the preset. */
  groups?: Record<string, LightGroupSetting>;
  /** Photosensitivity-safe flashes (≤ 3 big flashes per second). Default true. */
  safe?: boolean;
  /** With `safe` off: show a "Flashing lights" notice on stream (the OBS corner pill, the festival walls' card / badge)
   *  while the show flashes faster than 3 a second. Default false (owner: every notice can be turned off). */
  warnOnStream?: boolean;
  /** ms the OBS lights lag (+) or lead (−) the analysed audio, to line up with the stream's audio. */
  delay?: number;
  /** Lighting state (default 'show' = the settings above). */
  state?: LightingStateId;
  /** The host's edits to the other states' looks (missing = shared/lightShow.ts DEFAULT_LOOKS). */
  states?: Partial<Record<LightingStateId, LightingLook>>;
  /** State change duration in seconds (0 = cut; PRESHOW → SHOW plays the show-open over it). Default 2. */
  stateFade?: number;
  /** Music lighting style (shared/lightStyles.ts): a style id, 'auto' (follows the music's energy), 'u:<n>' (one of
   *  the host's saved styles) or ''/missing = none (the classic per-group programs). Applies to music-driven looks. */
  style?: string;
  /** The host's saved styles (≤ 12). */
  userStyles?: import('./lightStyles.ts').UserLightStyle[];
  /** Style options: speed 0.5..2, strobes allowed, which lighting states the style drives. */
  styleOpts?: import('./lightStyles.ts').LightStyleOpts;
  /** Reactive lights look (shared/lightDirector.ts): 'room' (default: the room's own colours) | 'calm' | 'club' | 'rave'.
   *  Drives SHOW / REACT when Beat reactive is on and the SHOW preset is the room show. */
  mood?: 'room' | 'calm' | 'club' | 'rave';
}

/** Lighting states (src/scene/lightShow.ts): PRESHOW club show, SHOW = the normal studio lighting, BRB, REACT, OUTRO. */
export type LightingStateId = 'preshow' | 'show' | 'brb' | 'react' | 'outro';
export interface LightingLook {
  /** Room ("house") lighting 0..1.2 — the room's own materials / baked vertex lighting. 1 = as authored. */
  house: number;
  /** Colour of the house light ('#rrggbb'), null = neutral. */
  tint: string | null;
  /** Group preset (LIGHT_PRESETS) + per-group overrides; '' = the same as SHOW. */
  program: string;
  groups?: Record<string, LightGroupSetting>;
  /** 0..1 procedural effects rig: moving-head beams, laser fans, mirror ball. */
  fx: number;
  /** Colour palette for the effects / colour cycles: 'authored' | 'club' | 'sunset' | 'uv' | 'ice'. */
  palette: string;
  /** 'auto' = always animated (the music input if any, else a built-in auto show); 'user' = the Beat reactive toggle. */
  music: 'auto' | 'user';
  /** 0.25..2 speed of the effects. */
  energy: number;
  /** The show preset this look came from (shared/lightPresets.ts): its motion styles, laser looks, colour split,
   *  mirror-ball speed and effects mix drive the rig. */
  preset?: string;
  /** Auto-cycle: switch to the next preset of this category every `every` phrases (8 bars). */
  cycle?: { cat: string; every: number };
  /** Music lighting style for this look (shared/lightStyles.ts) — '' / missing = the global `lights.style`, 'none' = off. */
  style?: string;
}

/**
 * The 3D scene everyone's OBS shows. HOST-owned: the host's studio persists it (/api/scene) and sends it to
 * its OBS pages (bus `scene`) and to party guests, whose studios relay it to their own OBS pages.
 * Member keys: `'@host'` = the host (also the solo performer), anything else = a party member id.
 */
export interface SceneState {
  /** null = Classic: today's transparent avatar-only layout (no room). */
  sceneId: string | null;
  mode: SceneMode;
  /** 'talk' (bust framing of the `focus` performer: SPOT_xx_CAM or automatic), 'group' (everyone present),
   *  'wide' (CAM_WIDE / automatic), 'react' (CAM_REACT / automatic, the screen ≈ 80% of the frame), or any CAM_* name. */
  camera: string;
  /** When the host last PICKED `camera` by hand (Live panel, Stream Deck, MCP, Scene tab; epoch ms). Set = the pick wins over
   *  every automatic camera (room directors, AFK, ambient, TTRPG table, screen-video cam, reactions): only entrances (walk-in
   *  follow cam, the club's entrance shots) still play, then hand back to it. Cleared by Auto, a mode / room change, and
   *  by turning ambient cameras or AFK on. Missing = nobody picked: directors may cut (shared/camPick.ts). */
  camPick?: number;
  /** Member key the 'talk' camera frames (default '@host'). */
  focus: string;
  /** Spot index per member key (0 = SPOT_01 … 11 = SPOT_12). */
  spots: Record<string, number>;
  /** In the room? (missing = present). */
  present: Record<string, boolean>;
  lights: SceneLightsState;
  /** The host's party id, so guests' OBS pages can tell which party member '@host' is. */
  hostId?: string;
  /** Avatar size on top of the room's real-world height normalisation (1 = scene.json avatarHeight). */
  avatarScale: number;
  /** Camera move duration in seconds (0 = hard cut). */
  transition: number;
  /** React layout (default 'auto'). */
  reactLayout?: ReactLayout;
  /** React screen content: 'auto' (in-scene when the host shares a window, else OBS passthrough), 'inscene', 'passthrough';
   *  plus the in-scene look (subtle scanlines / glass sheen). */
  screen?: ScreenSettings;
  /** Bumps on every host change. */
  rev: number;
  /** Entrance / exit / spot-change events (src/scene/walkMover.ts): the LAST change per member key. Every
   *  page simulates the same walk from the same room data + this event, so studio preview, OBS and guests'
   *  OBS show the same thing and late-joining pages land mid-walk. */
  moves: Record<string, SceneMove>;
  /** Scene camera follows entrances (cuts to CAM_DOOR, follows the walk, returns once seated). */
  follow: { host: boolean; guests: boolean };
  /** Entrances (Live panel → People): `walk` false = presence changes are instant (people appear / vanish in their
   *  seats, no door walk); `join` = how a new party member arrives (walk in, already seated, or wait outside until
   *  the host brings them in). Missing = walk + walk. */
  entrances?: { walk: boolean; join: 'walk' | 'seated' | 'outside' };
  /** Host wall clock (ms) when this state was sent over the party link (guests derive a clock offset). */
  sentAt?: number;
  /** In-world chat monitor / support board / chat buddy (shared/chat.ts; missing = all off). */
  chat?: import('./chat.ts').SceneChatState;
  /** Background combat + raid events (shared/raid.ts; missing = off). */
  raid?: import('./raid.ts').SceneRaidState;
  /** Kitchen (fast-food room): crew, food fights, unrest meter, riots (shared/kitchen.ts). */
  kitchen?: import('./kitchen.ts').SceneKitchenState;
  /** The club engine (src/scene/club): background bits, celebrations, the DJ pose, the entrance camera (shared/club.ts). */
  club?: import('./club.ts').SceneClubState;
  /** Festival stages (scene.json `festival`, src/scene/festival/*): the show, pyro, intensity, the Look Lab curation, manual cues (shared/festival.ts). */
  festival?: import('./festival.ts').SceneFestivalState;
  /** AFK / starting-soon cinematic director + chatter names on ships (shared/afk.ts, src/scene/afk/*); missing = off. */
  afk?: import('./afk.ts').SceneAfkState;
  /** Scene graphics quality for this PC's OBS pages / the studio preview (shared/graphics.ts; missing = Balanced). */
  gfx?: import('./graphics.ts').SceneGfxState;
  /** Space battle outside a ship's viewport + cryo / drop-pod entrances (shared/space.ts; missing = defaults). */
  space?: import('./space.ts').SceneSpaceState;
  /** Time of day + weather for rooms with scene.json `environment` (shared/environment.ts; missing = the room's defaults). */
  env?: import('./environment.ts').SceneEnvState;
  /** Era shifts for rooms with scene.json `eras` (shared/era.ts; missing = no shifts until the host stamps one). */
  era?: import('./era.ts').SceneEraState;
  /** Room-change transition card (shared/curtain.ts, src/scene/transition/*; missing = the defaults: VTube Pro Dark, automatic). */
  curtain?: import('./curtain.ts').SceneCurtainState;
  /** Capture cover: an animated card over ONLY the screen-capture area while the host sets up a game (shared/capcover.ts,
   *  src/scene/capcover/*; missing = off). */
  capcover?: import('./capcover.ts').SceneCaptureCover;
  /** Be Right Back card look (shared/brb.ts; BRB itself = lights.state 'brb'; missing = the defaults). */
  brb?: import('./brb.ts').SceneBrbState;
  /** Stage layouts (shared/stage.ts): react window size, gaming layout, docked chat / support, the strip order, the
   *  room a room-moving mode came from (missing = the defaults). */
  stage?: import('./stage.ts').SceneStageState;
  /** Registered modes' own settings (src/scene/stage/registry.ts), one JSON bag per mode id (shared/stage.ts sanitizeModeBags). */
  modes?: Record<string, unknown>;
  /** TTRPG table (shared/ttrpg/state.ts, src/ttrpg/*): map, tokens, initiative, dice throws, the GM's current line, mood; missing = off. */
  ttrpg?: import('./ttrpg/state.ts').SceneTtrpgState;
  /** Screen video: the room's screen plays a video file / playlist per moment (shared/screenVideo.ts; missing = off). */
  video?: import('./screenVideo.ts').SceneVideoState;
  /** Ambient cameras for Preshow / BRB / Outro (shared/ambientCam.ts, src/scene/ambientCam.ts; missing = off). */
  ambcam?: import('./ambientCam.ts').SceneAmbientCam;
  /** DJ decks at the DJ spot, copying the DJ's controller; the performer's hands play it (shared/djDeck/state.ts, src/scene/djdeck/*; missing = off). */
  djdeck?: import('./djDeck/state.ts').SceneDjDeckState;
  /** Room prop toggles: the host's on / off per toggle id of the CURRENT room (shared/roomToggles.ts; missing id = the
   *  toggle's default; missing = every toggle at its default). */
  toggles?: import('./roomToggles.ts').SceneToggles;
  /** Room alert reactions in play (shared/reactions.ts, src/scene/reactions.ts): the host stamps one per matched support
   *  event (≤ 8, newest last) so every OBS page and party guest plays the same clip / light cue / smash at the same time. */
  reactions?: import('./reactions.ts').ReactionStamp[];
}

/** One walk: spot index -> spot index (-1 = outside the door). `at` = start, epoch ms on the receiving page's clock. */
export interface SceneMove { from: number; to: number; at: number }

/** assets/scenes/<id>/scene.json (+ what the server adds). */
export interface SceneInfo {
  id: string;
  name: string;
  model: string;
  modes?: SceneMode[];
  defaultCamera?: string;
  ambience?: { background?: string | null; fog?: string; fogNear?: number; fogFar?: number; exposure?: number };
  /** Standing height (m) every avatar is normalised to (default 1.5). */
  avatarHeight?: number;
  /** Size classes (shared/avatarSize.ts, docs/SCENES.md → "Avatar size classes"): which classes each SPOT_xx takes
   *  (overrides the GLB extras `sizes`), e.g. { "SPOT_12": ["normal", "large", "macro"] }. */
  spotSizes?: Record<string, string[] | string>;
  /** Extra spots for size classes without re-exporting the GLB (glTF space): a fairy perch on the bar, a giant's
   *  place at the back. They get indices after SPOT_12 (13, 14 …). */
  sizeSpots?: { position: [number, number, number]; yaw?: number; sizes: string[] | string; label?: string; pose?: 'sit' | 'stand'; seatHeight?: number; hover?: number }[];
  /** false = never derive automatic micro / macro spots for this room (default: derived when none is authored). */
  autoSizeSpots?: boolean;
  lights?: { programs?: string[] };
  /** Solo react screen placements per host spot (instead of a SCREEN_SOLO_xx node): centre of the shown surface
   *  in glTF space, yaw (deg) of the side it faces, width (m). Unlisted spots get an automatic placement. */
  soloScreens?: Record<string, { position: [number, number, number]; yaw?: number; width?: number }>;
  /** Room skin of the generated screen rigs (solo screen / chat monitor / support board): a built-in theme or the
   *  room's own GLB nodes + arrival motion + power-on (shared/screenSkin.ts). Missing = the room's built-in default. */
  screenSkin?: import('./screenSkin.ts').ScreenSkinConfig;
  /** Background combat defaults (shared/raid.ts RoomRaidConfig). */
  raid?: import('./raid.ts').RoomRaidConfig;
  /** Kitchen room defaults (shared/kitchen.ts RoomKitchenConfig). */
  kitchen?: import('./kitchen.ts').RoomKitchenConfig;
  /** AFK cinematic director: the shot cycle, holds, event shots (shared/afk.ts RoomAfkConfig; docs/SCENES.md). */
  afk?: import('./afk.ts').RoomAfkConfig;
  /** Chatter name tags on ships: style, which craft (shared/afk.ts RoomShipNamesConfig). */
  shipNames?: import('./afk.ts').RoomShipNamesConfig;
  /** High / Ultra look overrides for this room (src/stage/gfx/roomLooks.ts: grade, bloom, haze, rim, reflect, shafts …). */
  gfx?: Record<string, unknown>;
  /** Space rooms (shared/space.ts RoomSpaceConfig) + the entrance / exit cinematics ('cryo' / 'droppod' / 'lift'; default =
   *  the door walk). A string = everyone; `{ host, guests }` = per role (shared/arrivals.ts; '@host' uses `host`). */
  space?: import('./space.ts').RoomSpaceConfig;
  entrance?: string | { host?: string; guests?: string };
  exit?: string | { host?: string; guests?: string };
  /** This room's own room-change transition (shared/curtain.ts roomCurtainPick): `in` plays when the party arrives here,
   *  `out` when it leaves for another room (a string = both). The host's Cut / "Rooms bring their own transition" off win. */
  curtain?: string | { in?: string; out?: string };
  /** Time of day, weather, night lights (shared/environment.ts RoomEnvConfig; docs/SCENES.md → Environment). */
  environment?: import('./environment.ts').RoomEnvConfig;
  /** Era shifts: the eras the time crystal cycles through (src/scene/epoch/eras.ts RoomErasConfig). */
  eras?: { list?: { id: string; name?: string }[]; every?: number; build?: number; shift?: number; support?: { min?: number } };
  /** TTRPG room (docs/TTRPG.md, the TTRPG room contract): which environment it belongs to, its GM styles, map / dice looks. */
  ttrpg?: import('./ttrpg/state.ts').RoomTtrpgConfig;
  /** Optional: this environment's TTRPG room id (else found by the rooms' ttrpg.of). */
  ttrpgRoom?: string;
  /** Areas (shared/roomId.ts, docs/SCENES.md → "Areas"): several places in one room, each its own room id
   *  `<room>~<area>`; an area's entry overrides any top-level key. The server adds area / areaOf / areaList / roomName. */
  areas?: Record<string, Record<string, unknown>>;
  defaultArea?: string;
  area?: string;
  areaOf?: string;
  areaList?: import('./roomId.ts').RoomAreaInfo['areaList'];
  roomName?: string;
  /** Room prop toggles: node groups the host switches on / off live (shared/roomToggles.ts; docs/SCENES.md → "Room prop
   *  toggles"). glTF node extras `toggleGroup` declare more. */
  toggles?: { id: string; label?: string; nodes?: string[] | string; default?: boolean }[];
  /** Area bounds (glTF min xyz, max xyz): what the framing / screens treat as the room (default: every mesh). */
  bounds?: [number, number, number, number, number, number];
  /** Added by the server: the user's own Room editor layer (shared/roomEdits.ts, <data>/room-edits/<id>.json) — pages merge it
   *  over this scene.json when they load the room (src/scene/roomEdits.ts). */
  userEdits?: import('./roomEdits.ts').RoomEdits;
  /** Alert reactions (shared/reactions.ts RoomReactionsConfig, docs/SCENES.md "Room alert reactions"): support events →
   *  look / camera / light override / one-shot ALERT_* clips / smash / space or raid events, by USD tier and platform. */
  reactions?: unknown;
  /** Added by the server: model file present, preview/thumb URLs. */
  ready?: boolean;
  thumb?: string | null;
}
