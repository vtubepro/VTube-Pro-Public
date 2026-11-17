// The "pro2d_to_3d" instruction pack (lane to3d): served by get_instruction_pack {pack:"pro2d_to_3d", jobId?}. ONE source
// for the recipe an AI follows (Claude, GPT/Codex or any MCP client) and the tool allow-list the unit test checks against
// the real tool table. A job-filled header (the avatar, the route, the Blender MCP's real tool names) is LOCAL ONLY.
import { CHECKLIST, ANGLES, TO3D_LIMITS } from './job.ts';
import { OVERRIDES } from './overrides.ts';
import type { McpKind } from './blenderMcp.ts';

/** The ONLY vtube-pro tools this recipe may call. */
export const TO3D_TOOL_NAMES = ['to3d_jobs', 'to3d_job', 'to3d_bundle', 'to3d_parts', 'to3d_references', 'to3d_baseline', 'to3d_wait', 'to3d_rebuild',
  'to3d_graft', 'to3d_check', 'to3d_note', 'to3d_revert', 'to3d_open_blender', 'to3d_submit', 'to3d_vision'] as const;
export const PACK_ALLOWED_VTP = [...TO3D_TOOL_NAMES, 'get_docs', 'get_instruction_pack'] as const;
/** vtube-pro tools this recipe must never call (live stream, the library, the camera, other generators, our own Blender). */
export const PACK_FORBIDDEN_VTP = ['update_avatar', 'set_costume', 'send_command', 'import_model', 'import_costume', 'import_room', 'autorig',
  'generate_avatar', 'generate_room', 'render_avatar', 'blender_run_python', 'install_creation_package', 'submit_creation_package', 'get_diagnostics',
  'request_diagnostics', 'install_comfy_workflow'] as const;

export interface PackJob {
  id: string; avatarName: string; route: 'vtp2' | 'image'; phase: string; best: number | null; rounds: number;
  base: { kind: string; key: string | null };
  blenderMcp: { kind: McpKind | null; run: string | null; look: string | null; scene: string | null; forbidden: string[] } | null;
  paths: { work: string; parts: string; blend: string } | null;
}

const fixTable = (image: boolean) => `| Order | Region | Lever (first choice) | Acceptance: Pro2D route${image ? ' | Acceptance: picture route (no head turns)' : ''} |
|---|---|---|---|${image ? '---|' : ''}
| a | Proportions (head size, eye line, neck, shoulders) | \`to3d_rebuild\` with \`creator.face.*\`, \`creator.body.*\` | eye line and chin within 0.08 IPD at the front; head width within 0.1 IPD (\`lm.headWidth\`); review has no G1 / G2${image ? ' | the same at the front only' : ''} |
| b | Face: drawn eyes, carved mouth, flat drawn teeth | \`to3d_rebuild\` with \`face.*\`, \`eyes.*\`, \`mouth.*\`, \`creator.face.eyeSize / eyeTilt\` | the eye opening, tilt and iris tuck read like the 2D at 0° AND ±45°; closed mouth = one short crisp line (~0.6 eye width on girls); blink fully closed with no iris through the lid; aa / oo / ee / PP read (PP lips sealed); teeth a flat drawn band; checklist lines 2–10 = yes${image ? ' | the same (there is no drawn blink or open mouth to copy: use the house defaults)' : ''} |
| c | Hair: locks from the drawn ink lines, spring chains | \`to3d_rebuild\` with \`hair.*\`; Blender MCP only for a shape the settings can't make (a unique ahoge, a braid, a bun), exported to \`parts/\` + \`to3d_graft\` | hair coverage ≥ 0.85 at the front and ≥ 0.75 on both turns; the fringe covers the forehead as drawn; no R5 stripes; one angel ring; locks taper to points; no R9 poke-through at the face or shoulders${image ? ' | coverage ≥ 0.75 at the front only; the back of the head is invented: judge it at 135° / 180° by eye (full, rounded, no bald patch)' : ''} |
| d | Outfit | \`to3d_rebuild\` with \`creator.outfit.*.color\`; Blender MCP for a missing piece (hat, big bow, cape) skinned to the avatar's bones → \`to3d_graft\` | top / bottom colours dE ≤ 8; no G2 floating straps; no R9 body through clothes${image ? ' | the same' : ''} |
| e | Colours / MToon | \`to3d_rebuild\` with \`creator.colors.*\`, \`face.iris.*\`, \`look.vrmExposure\` | skin, hair, eyes dE ≤ 6 in the APP renderer; shadows warm, never grey; no pure-black lines${image ? ' | the same' : ''} |
| f | Expressions / visemes (ARKit 52) | the bundle's \`expressions\` section (\`vrmPreset\`, \`arkitMix\`) → \`mouth.restSmile\` and the face settings; the ARKit 52 set stays complete | the expression sheet reads like the 2D sheet at the same framing; every 2D expression has a counterpart (happy / angry / sad / surprised / relaxed)${image ? ' | the house expression set only' : ''} |
| g | Spring bones | \`to3d_rebuild\` with \`springs.<fringe|side|back|ahoge>.*\` (the bundle's \`physics.suggest\`) | hair swings and settles within ~1 s; no lock folds into the face at ±45°${image ? ' | the same' : ''} |`;

const leverRows = `| worst region (from to3d_check) | try first |
|---|---|
| hair silhouette (coverage low at the front) | \`hair.backLengthScale\` (longer / shorter), \`hair.mode\` (down / ponytail / twintails) |
| hair silhouette (turns only) | \`hair.silfit: true\`; a lock built in Blender for the far side |
| head shape | \`creator.face.faceWidth\`, \`creator.face.jaw\`, \`creator.face.chin\` |
| crown too low / high | \`creator.body.head\`; a crown lock built in Blender for spiky tops |
| eyes too round / too narrow | \`eyes.lidBake\` (more = narrower), \`eyes.drawnLid\`, \`creator.face.eyeSize\` |
| eyes the wrong tilt | \`creator.face.eyeTilt\` |
| skin too pale / grey in the app | \`creator.colors.skin\` warmer, then \`look.vrmExposure\` |
| hair colour | \`creator.colors.hair\`, \`creator.colors.hairTip\` |
| eye colour | \`face.iris.color\`, \`face.iris.top\`, \`face.iris.bottom\` |
| outfit colour | \`creator.outfit.tops.color\`, \`creator.outfit.bottoms.color\` |
| mouth looks sad / flat | \`mouth.restSmile\` |
| lashes too light / heavy | \`face.eye.lineMax\`, \`face.eye.wing\` |
| brows | \`face.brow.height\`, \`face.brow.width\`, \`face.brow.color\` |`;

export function buildPack(job: PackJob | null): string {
  const id = job?.id ?? '<jobId>';
  const image = job?.route === 'image';
  const bm = job?.blenderMcp;
  const run = bm?.run ?? 'execute_blender_code', look = bm?.look ?? (bm?.kind === 'official' ? 'get_screenshot_of_window_as_image' : 'look');
  const head = job ? [
    `## This job`,
    `- Job: \`${job.id}\`. Avatar: "${job.avatarName}". Route: **${image ? 'picture route (the rig has no usable head turn: front only)' : 'Pro2D route (front + the rig\'s own ±30 turns)'}**. Phase now: ${job.phase}. Rounds so far: ${job.rounds}${job.best !== null ? `, best round ${job.best}` : ''}.`,
    `- Base body: ${job.base.kind === 'user' ? 'the user\'s OWN VRoid base (keep it: never switch \`creator.base\` away from "user")' : 'VTube Pro\'s own bundled base picked from the drawing: Mirelle (female) or Kairo (male); \`creator.base\` may switch between "mirelle" and "kairo"'}.`,
    bm?.kind ? `- Blender MCP: **${bm.kind === 'official' ? 'Blender Lab MCP (official)' : 'MCP for Blender'}**. Run code with \`${run}\`; quick looks with \`${look}\`${bm.scene ? `; the scene with \`${bm.scene}\`` : ''}. Never: ${bm.forbidden.map((f) => `\`${f}\``).join(', ')}.` : '- Blender MCP: none connected. Work with `to3d_rebuild` only (parametric); skip every Blender MCP step below and tell the user once that Blender edits need the Blender MCP.',
    job.paths ? `- Paths: open \`${job.paths.blend}\` in Blender; write ONLY inside \`${job.paths.work}\`; export parts into \`${job.paths.parts}\`.` : '',
    '',
  ].filter(Boolean).join('\n') : '';
  return `# Pro2D → 3D: the recipe (VTube Pro)

You are making a 3D VTuber avatar (VRM) from the user's own 2D (Pro2D) avatar, on their computer, with VTube Pro's tools
(\`vtube-pro\`) and their Blender MCP. The user may be live: never touch their current avatar, costume, scene or library
except through \`to3d_submit\`. Never make sound. Follow the steps in order; every step has checks. Don't move on until
they pass, or until the step says how to record a gap. If anything is unclear, call \`to3d_job {"jobId":"${id}"}\` and
do its \`nextStep\`. If a tool says the job is stopped, stop and tell the user.

${head}
## Tools you may use (nothing else)
- vtube-pro: ${PACK_ALLOWED_VTP.map((t) => `\`${t}\``).join(', ')}.
- The Blender MCP: its run-Python tool and its look / screenshot tool (named above) only.
- Never: ${PACK_FORBIDDEN_VTP.map((t) => `\`${t}\``).join(', ')}; any Blender MCP tool that generates models, downloads assets or starts a second Blender.

## Frames and units (read once)
- 2D (the bundle, the references): canvas pixels, **x right, y DOWN**; measurements are in **IPD units** (the distance
  between the drawn eye centres), y measured from the eye line.
- Blender: **Z up**, metres, the avatar faces **−Y**. glTF / VRM: **Y up**, faces −Z (VRM 0); the Blender glTF exporter
  converts (\`export_yup=True\`).
- Colours you type into a glTF or a Principled BSDF are **linear**: convert sRGB hex first (the bundle's \`colours\`
  section gives both). Override colours (\`creator.colors.*\` …) take sRGB hex: the pipeline converts them.
- The 2D "±30" head turn moves the eyes like a ~20° rotation: the compare puts 2D ±30 next to 3D ±20.

## Step 1: setup checks
1. \`to3d_job {"jobId":"${id}"}\`. Check: the phase isn't \`stopped\` / \`done\`. If \`readiness.blenderMcp.running\` is
   false: say once, "Click 'Open Blender for me' in VTube Pro (after your stream if you're live)", or call
   \`to3d_open_blender\` (it returns \`waiting_for_ok\` until the user approves; poll \`to3d_job\` every 30 s, ≤ 10 times).
2. If \`to3d_job\` shows \`vision.ok\` = null: call \`to3d_vision {"jobId":"${id}"}\`, read the code word in the picture and
   call it again with \`"answer"\`. If you can't see pictures, say so: the pack switches you to **numbers-only mode**
   (parametric levers only, at most 4 rounds, and the user judges the pictures at Approve).
3. Read the house rules once: \`get_docs {"topic":"rules"}\`.
4. Blender MCP smoke test (skip without one): run a 3-line script that prints \`bpy.app.version_string\` and the
   object count. It must answer in under 20 s.

## Step 2: the baseline (round 0)
1. \`to3d_baseline {"jobId":"${id}"}\` (no overrides: the pipeline chooses), then \`to3d_wait\` until it is built. Each
   wait returns within 40 s; just call it again. The baseline takes 2–8 minutes.
2. \`to3d_check {"jobId":"${id}","round":0}\` then \`to3d_wait\`: ONE call renders 8 angles (${ANGLES.join(', ')}°) + the
   expression sheet in the app renderer, compares with the 2D and runs the automatic review. The answer has the scores,
   the worst region and 3 pictures (compare, angles, expressions).
3. If the baseline failed: \`nextStep\` tells you (once the picture route; if that fails too, stop and tell the user the
   one sentence from the error).

## Step 3: look before you change anything
1. \`to3d_bundle\` sections \`summary\`, \`parts\`, \`measure\`, \`colours\`, \`physics\`, \`expressions\`, \`layers\`.
2. \`to3d_references\` (the reference sheet), \`to3d_parts\` for anything unclear (hair clips, ahoge, ribbons).
3. **Sex and base check (before round 1):** \`summary.sex\` / \`summary.base\` came from the drawing's proportions. If the
   character is clearly the other sex, fix it NOW with \`to3d_rebuild {"overrides":{"sex":"…","creator":{"base":"…"}}}\`
   (female = "mirelle", male = "kairo": VTube Pro's own bases, already included): everything after builds on it.
4. \`to3d_note\` for round 0: the character in 5 lines (sex, age, hairstyle, outfit, signature details) and the 3
   biggest differences at identical framing. "Looks similar" is not a difference.

## Step 4: fix in this order (one region, one lever per round)
${fixTable(image)}

Each round: pick the worst region from the newest check, **never skipping ahead in the order above**; choose ONE lever;
make the round (\`to3d_rebuild\` / Blender MCP + \`to3d_graft\`); \`to3d_wait\`; \`to3d_check\`; \`to3d_wait\`; \`to3d_note\`.

Levers by worst region:
${leverRows}

All override keys (anything else is refused, with the nearest real key): ${OVERRIDES.map((o) => `\`${o.path}\``).join(', ')}.

## Step 5: the loop and when to stop
- **Look at ALL the pictures** of every check (the 8 angles incl. ±90, ±135 and 180, and the expressions), not only
  the front. The scores only GUIDE and catch regressions; silhouette overlap is not quality. Acceptance = the review
  (PASS, or WARN with a written reason per warning) + the 11 checklist lines + pass / fail at every angle.
- **Every \`to3d_note\`** carries: what you changed, \`checklist\`: ${CHECKLIST.length} booleans in this order —
${CHECKLIST.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}
  — \`angles\`: a pass / fail for each of ${ANGLES.join(', ')}, and \`gaps\`: what you could not match.
- **Revert rule:** a round whose review FAILS, or that makes ANY checklist line worse than the best round, is reverted
  (\`to3d_revert\` to the best round; \`nextStep\` says so). A lower score alone never throws away a better face.
- **Stuck rule:** a region still the worst after 3 rounds on it → write it in \`gaps\` in plain words and move on.
- **Same lever, same direction, more than 3 times in a row:** don't.
- **Stop** when every region passes or is a written gap, the review isn't FAIL, all 11 lines are yes, every angle
  passes and the last two rounds improved the total by < 1 point. **Hard limits:** ${TO3D_LIMITS.maxRounds} rounds after the baseline,
  or 2 hours since the baseline was built. Then submit the best round with its gaps. If NO round passes the review by
  then, \`nextStep\` names the least-bad round: write every review problem as a gap and submit it; the user sees the
  problems and the pictures on the approval page and decides.
- Each tool call returns in under 45 s. Claude stops after about 20 tool calls and shows "Continue": the user clicks it
  (VTube Pro reminds them). Use few calls: \`to3d_check\` already renders + compares + reviews.

## Using the Blender MCP (when a setting can't make it)
- One small step per call, finishing in < 30 s. Print \`STEP <what>\` first and \`OK\` last.
- Open the job's \`candidate.blend\` (it is the current best round, imported from its VRM). Never open the user's own files.
- Name every new object \`TO3D_<part>\`. Skin it to the avatar's existing bones (vertex groups named exactly like the
  bones, e.g. \`J_Bip_C_Head\`) or parent it to one bone. Keep it light (≤ 20,000 triangles a part).
- Save \`work/round_<n>.blend\`; export ONLY the new / changed parts:
  \`bpy.ops.export_scene.gltf(filepath=r"<parts>/<part>.glb", export_format="GLB", use_selection=True, export_yup=True, export_skins=True, export_morph=True, export_apply=False)\`,
  then \`to3d_graft {"jobId":"${id}","parts":["<part>.glb"]}\`. To hide a base piece your part replaces, pass \`"hide":["<mesh name>"]\` (never the Face or the Body).
- Never in Blender: install add-ons or pip packages, touch the network, write outside \`work/\`, change preferences,
  render with the GPU, or start another Blender.

## Never (each one fails the job)
- Projecting the 2D art, a reference render or any picture onto the face or the body (faces are drawn, never projected;
  the outfit's drawn front is stamped by the pipeline's own garment step, not by you).
- Side / back views from an image generator, the turnaround generator, AI mesh generators (Tripo, Meshy, Hunyuan3D, Rodin,
  the Blender MCP's generate tools), downloaded models or assets, a human built from primitives or from scratch. This job
  makes a human, and humans start from a proper base: the body stays on the base the job uses (VTube Pro's own Mirelle /
  Kairo, or the user's own VRoid base).
- 3D teeth geometry (teeth are a flat drawn band; \`mouth.teeth\` only picks flat or pointed drawing); a mouth stuck on
  top of the skin (it is carved).
- Deleting or renaming ARKit shapes or VRM bones; removing spring chains to hide clipping.
- Pure-black lines, grey shadows, sRGB values typed into glTF / Principled colours.
- Changing anything live or in the library, or submitting on approximate renders, or hiding a known gap.

## Step 6: export the VRM and submit
- \`to3d_submit {"jobId":"${id}","round":<best>}\`: it makes the final VRM + profile, checks it (rest pose, budgets,
  ARKit names, springs), and returns \`waiting_for_ok\` at once. Tell the user in one sentence: "It's ready: press
  **Approve** in VTube Pro to add '<name> (3D)' to your library." Poll \`to3d_job\` every 30 s, at most 10 minutes.
- Done: tell the user what you made, the score vs the baseline and the gaps in plain words. Never wear it for them.
  Denied: ask what they'd like changed; the job stays open.

## Resuming in a new chat
\`to3d_jobs\` (or \`to3d_job {"jobId":"…"}\`), read \`notes\` and \`knownGaps\`, then do \`nextStep\`. Never restart the
baseline when rounds exist.
`;
}
