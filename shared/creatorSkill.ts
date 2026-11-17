// Our own add-on (lane aiskills, beta.12): the "VTube Pro Creator" Agent Skill. ONE folder that works in Claude Code,
// Claude Desktop / claude.ai (zip upload), the ChatGPT desktop app + Codex (~/.agents/skills), Grok Build and
// Antigravity / Gemini CLI: the Agent Skills format (agentskills.io/specification: SKILL.md with name + description,
// optional references/, agents/openai.yaml for Codex's display name). It routes the AI to VTube Pro's own MCP tools first,
// then to the helper's recommended add-ons (Blender MCP, GIMP MCP, ComfyUI workflows) and carries the house rules.
// Pure (no node / DOM): server/aiAddons.ts writes the files (with the house rules from server/aiKnowledge.ts) and zips them.
import { CREATOR_SKILL_NAME, GIMP_MCP_PORT, BLENDER_MCP_PORT } from './aiAddons.ts';
import { HUNYUAN_AI_FOR, HUNYUAN_AI_RULE, HUNYUAN_RECIPE } from './comfyWorkflows/models.ts';

/** Bump when the text changes: installed copies with an older version get "Update" in the panel. */
export const CREATOR_SKILL_VERSION = '1.3.1';

const DESCRIPTION =
  'Make and fix things for VTube Pro, the VTuber studio, including 3D avatars (VRM), Pro2D layered 2D avatars (PSD), costumes, rooms, ' +
  'textures, overlays, sounds and stream assets. Use whenever the user mentions VTube Pro, their VTuber avatar, model, room, ' +
  'outfit, overlay, emote or stream art, or asks you to build something with Blender, GIMP or ComfyUI for their stream.';

const SKILL_MD = `---
name: ${CREATOR_SKILL_NAME}
description: ${DESCRIPTION}
license: VTube Pro (free for non-commercial use). See https://github.com/vtubepro/VTube-Pro-Public
metadata:
  version: "${CREATOR_SKILL_VERSION}"
  author: VTube Pro
---

# VTube Pro Creator

You are building for a VTuber who may be **live on stream right now**. Work through VTube Pro's own tools and keep their
show safe. Read this whole file before the first tool call.

## 1. Connect first (every new chat)

1. Call the \`vtube-pro\` MCP tool \`status\`. If there is no \`vtube-pro\` tool, stop and tell the user in one sentence:
   "Open VTube Pro, go to Create > Connect your AI, press Connect for this app, then restart this app."
2. Call \`get_instruction_pack\` (or \`get_docs\` with no arguments) and follow it. Before a job also call
   \`get_docs\` with the topic: \`avatars\` (avatars and costumes), \`environments\` (rooms), \`connect\` (room recipe and
   creation packages), \`blender\`, \`faces\`, \`examples\`.
3. Call \`ai_addons_status\` to see which helpers are ready (Blender MCP, GIMP MCP, ComfyUI). If one you need is missing or
   not running, tell the user the ONE step it names (for example "Open GIMP, then Tools > MCP > Start MCP Server") or
   "Open VTube Pro > Create > Connect your AI > Make your AI better and press Set it up". Never install anything yourself.

## 2. House rules (short; the full list is in references/house-rules.md)

- **The user may be live.** Change the stream, the current avatar, costume or room only when they ask for exactly that.
  Test only in \`?observer=1\` studios or \`output.html?sceneTest=<room>\` pages, and close them when done.
- **Never make sound.** No playback, TTS, test tones. Sounds you make are saved as files, never played.
- **Big steps wait for the user's OK** in VTube Pro (Blender Python, library and live changes). When a call says it is
  waiting, tell the user to press **Approve** in VTube Pro, then continue.
- **Licences:** no Mixamo redistribution, no NC assets, VRoid CC0 bases only, no game rips. ${HUNYUAN_AI_RULE} Check every
  downloaded asset's licence (Poly Haven and ambientCG are CC0; Sketchfab often is NOT). Never save another performer's model.
- **Style:** anime mouths are carved into the face with flat drawn teeth (never 3D teeth); faces are drawn, never
  projected photos; glTF colour factors are linear; humans start from a proper base (VRoid CC0 / VTube Pro's face kit),
  never from Tripo / Meshy / Rodin / Hunyuan3D meshes or primitives.
- **Rooms:** metres, +Y up, front +Z; SPOT_xx places, CAM_WIDE + SPOT_xx_CAM, a 16:9 SCREEN + CAM_REACT, DOOR +
  DOOR_OUTSIDE + PATH_xx; nothing blocks faces or the react screen. Run \`check_room\`.
- **Review** every creation from 8+ angles in VTube Pro's own renderer (\`render_avatar\`, room checks), then say exactly
  what you verified and what you did not.

## 3. Which tool for which job

| Job | Use, in this order |
|---|---|
| 3D avatar / costume / accessory | VTube Pro tools (\`generate_avatar\` runs ComfyUI on the user's PC, \`import_model\`, \`import_costume\`, \`autorig\`, \`render_avatar\`); headless Blender through \`blender_run_python\`; the **Blender MCP** (port ${BLENDER_MCP_PORT}) only when the user wants to watch Blender work. See references/3d.md |
| Any avatar or room you make | Read \`get_docs {topic:"agents"}\` first (the agent guide: every kind's contract) and run \`check_creation {path}\` on the file before you hand it over; fix what it reports. Rules as data: \`creation_spec\` |
| Room | \`get_docs {topic:"environments"}\`, \`room_checklist\`, a creation package (\`validate_creation_package\` then \`submit_creation_package\`), \`check_room\`. See references/rooms.md |
| Pro2D (2D avatar from layered art) | Layered PSD made in **GIMP through the GIMP MCP** (port ${GIMP_MCP_PORT}) or Photoshop; layer names from references/pro2d-layers.md; the user imports the PSD in VTube Pro (Pro2D maker auto-rigs it). |
| 3D version of a Pro2D avatar | The user starts it with **Make a 3D version with my AI** (the avatar's 2D panel), which gives you a job id. Then \`get_instruction_pack {pack:"pro2d_to_3d", jobId}\` and follow it exactly with the \`to3d_*\` tools (\`to3d_job\` says the next step). Never start your own 3D build of a Pro2D avatar. |
| Textures, posters, emotes, overlays, thumbnails | \`comfy_workflows\` and \`install_comfy_workflow\` (ComfyUI on the user's PC; they press Yes), or your app's own image tool. See references/art-and-sound.md |
| Sound effects | VTube Pro's CC0 library first; generated sounds are saved as files and never played. |
| Checking an overlay page | Only VTube Pro's test pages, muted, closed right after. |

## 4. Blender MCP rules
- Save the user's file before any change. One Blender job at a time.
- Do not use its own 3D generators (\`generate_3d\`: Hunyuan3D, Tripo, Rodin) for VTube Pro work: they send the user's words or
  pictures to someone else's service under that service's terms. For ${HUNYUAN_AI_FOR} use VTube Pro's Character 3D recipe
  (\`${HUNYUAN_RECIPE}\`, in the user's own ComfyUI) instead. Asset search is fine for CC0 Poly Haven items; check every other licence.
- Its safe mode blocks file and internet access from your scripts: export through VTube Pro's tools instead.

## 5. GIMP MCP rules (Pro2D art; verified recipe in references/pro2d-layers.md)
- \`check_server\` first; not connected = ask the user: open GIMP, then Tools > MCP > Start MCP Server.
- \`list_images\`: NEVER close, save, flatten or edit the user's own images. Work only in the image you made.
- Build groups and layers with \`call_api\` exec (the simple layer tools only see top-level layers).
- Keep EVERY exec call under about 8 seconds: the MCP client gives up at 10 s while GIMP keeps running the code. After a
  timeout, check progress with a quick exec (count the layers). NEVER send the same batch again (duplicate layers).
- \`export_image\` flattens and cannot write a PSD: save with \`Gimp.file_save\` to a \`.psd\` path (and a \`.xcf\` copy).
- Name layers and folders the way the Pro2D maker reads them (references/pro2d-layers.md), then look at the result
  (\`get_state_snapshot\` / \`get_image_bitmap\`) before you say it is done.

## 6. When something fails
Say what happened in one plain sentence and give the user ONE next step. No error codes, no stack traces.
`;

const OPENAI_YAML = `interface:
  display_name: "VTube Pro Creator"
  short_description: "Build avatars, Pro2D art, rooms and costumes for VTube Pro"
policy:
  allow_implicit_invocation: true
`;

const REF_3D = `# 3D avatars, costumes and accessories (VTube Pro)

- Read \`get_docs {topic:"avatars"}\` first; for Blender work also \`get_docs {topic:"blender"}\` and \`{topic:"examples"}\`.
- Humans and anime humans: start from a VRoid CC0 base or VTube Pro's face kit. Never from an AI mesh (Tripo, Meshy,
  Rodin, Hunyuan3D) and never from primitives. Mascots, creatures, robots and props can be built from scratch, or (from a
  picture) with the Character 3D recipe (\`${HUNYUAN_RECIPE}\`: Hunyuan3D in the user's own ComfyUI, see the licences rule).
- Faces: own 2K face texture, flat cel tones, hard shadow shapes, crisp dark-warm lines (never pure black or grey).
  Mouths are carved into the face; teeth are a flat drawn white band.
- Hair: clumped cards / ribbons with strand-direction shading and one angel ring; every hanging lock on a spring chain.
- glTF colour factors are linear (an sRGB value typed into baseColorFactor renders too light).
- Rig: VRM humanoid bones, ARKit 52 blendshapes + visemes where the guide asks for them.
- Costumes: skinned to the avatar's bones, nothing poking through the body; build the GLB with \`blender_run_python\`, add it with
  \`import_costume\`, and only call \`set_costume\` (it PUTS IT ON, live) when the user asked to wear it now.
- Review with \`render_avatar\` from 8+ angles (front, back, both sides, 3/4 views, top) before saying it is good.
`;

const REF_ROOMS = `# Rooms (VTube Pro)

- Read \`get_docs {topic:"environments"}\` and \`{topic:"connect"}\` (the end-to-end room recipe).
- Units are metres, +Y is up, +Z is the stage front.
- Every room needs: SPOT_xx places (1+, 2+ recommended), CAM_WIDE and a SPOT_xx_CAM per spot, a 16:9 SCREEN with
  CAM_REACT (the react screen must look like a real screen in the room), DOOR + DOOR_OUTSIDE + PATH_xx entrance.
- Nothing may block the performers' faces or the react screen.
- Build as a creation package: \`validate_creation_package\`, fix what it reports, then \`submit_creation_package\` (the
  user installs it). Run \`check_room\` and \`room_checklist\` on the result.
- Props, HDRIs and textures: VTube Pro's CC0 library first, then CC0 sources (Poly Haven, ambientCG). No NC assets.
`;

const REF_PRO2D = `# Pro2D layered art (2D avatars)

VTube Pro's Pro2D maker auto-rigs a layered PSD: it reads each layer's NAME to know what it is. Use these names (add
" L" / " R" for the avatar's left / right; folders are fine):

| Part | Layer name |
|---|---|
| Face (skin, no features) | face |
| Nose / blush / ears | nose, blush, ear L, ear R |
| Eyes | eye white L, iris L, highlight L, upper lash L, lower lash L (same for R); optional closed eye L |
| Brows | brow L, brow R |
| Mouth | upper lip, lower lip, inside of mouth, teeth, tongue |
| Hair | front hair, side hair L, side hair R, back hair, ahoge |
| Body | neck, body, arm L, arm R, hand L, hand R |
| Accessories | head accessory (hats, bows), body accessory |

Rules:
- Canvas 2048-4096 px on the long side (3000 x 4000 is a good bust / half body; bigger is scaled down to 4096), 8-bit
  RGB, transparent background, the character centred, facing the viewer. Left / right come from where a part is on the
  canvas, so draw both eyes, brows and ears as separate layers.
- Paint each part WHOLE: the face under the hair, the eye white under the lashes, the inside of the mouth (the rig opens it).
- Teeth are flat drawn shapes. Line colour dark-warm, never pure black.
- A layer named exactly "background" is left out. Hide or delete guide and sketch layers before saving: a visible guide
  at full opacity is kept as art.
- Text layers, adjustment layers, layer effects and masks are not drawn: rasterize / apply them first.

How the maker reads names and folders:
- A HIDDEN layer is kept only if its name or folder says it is another state: closed, blink, wink, open, talk, smile,
  outfit, costume, clothes, alt, variant, expression (and similar). Anything else hidden is left out. Hats, glasses
  and other toggles go in folders named after them (Hat, Glasses, Headphones …): the folder name makes the switch.
- A folder named outfit / costume / clothes / uniform / dress with 2 or more subfolders = outfits worn one at a time.
- Folders named hat / cap / glasses / mask / headphone / accessory / ribbon = things the user can switch on and off.
- Layer names containing ribbon, bow, earring, charm, tassel, chain, strap, tail, scarf, tie, necklace, pendant, bell or
  feather get a swinging chain. Avoid those words for things worn tight round the neck.

## Layered PSD through GIMP and the GIMP MCP (verified 2026-10-06: GIMP 3.2.4, 98 layers / 60 groups, accepted unchanged)

1. \`check_server\` must say connected. If not, the user opens GIMP and picks Tools > MCP > Start MCP Server.
2. \`list_images\`: note what is already open. Never close, save, flatten or edit the user's images; image 0 is not
   necessarily yours.
3. \`new_canvas(width=W, height=H, name="<title>", color_mode="RGBA", fill="transparent")\`. It opens a window and adds
   one full-canvas layer named after the title. Its answer has \`image_id\`: KEEP IT. That id is the only way you find your
   image. Never pick an image by its size or its place in the list: the user may have one just like it open.
4. \`call_api(api_path="exec", args=["pyGObject-console", [ ...lines... ]])\`. Each list element is one statement (a
   multi-line def is ONE element with newlines inside). The context stays between calls, so define helpers once:

\`\`\`python
import json, os
from gi.repository import Gimp, Gio
IMG_ID = 123                          # the image_id new_canvas answered (yours; never search by size or index)
IMG = Gimp.Image.get_by_id(IMG_ID)
FIRST = IMG.get_layers()              # right after new_canvas: exactly its one default layer, named after your title
assert len(FIRST) == 1 and FIRST[0].get_name() == '<title>', 'not the fresh image new_canvas made: stop'
DEFAULT_LAYER_ID = FIRST[0].get_id()
GROUPS = {}
def grp(path):                       # "Head/Eyes" -> nested group layers, made the first time they are needed
    if not path: return None
    if path in GROUPS: return GROUPS[path]
    parent = grp('/'.join(path.split('/')[:-1]))
    g = Gimp.GroupLayer.new(IMG, path.split('/')[-1])
    IMG.insert_layer(g, parent, 0)   # 0 = top of its parent
    GROUPS[path] = g
    return g
def add(folder, name, png, x, y, visible=True):
    lay = Gimp.file_load_layer(Gimp.RunMode.NONINTERACTIVE, IMG, Gio.File.new_for_path(png))
    lay.set_name(name)
    IMG.insert_layer(lay, grp(folder), 0)   # add bottom-first: each new one goes on top = the right paint order
    lay.set_offsets(x, y)                   # AFTER insert_layer (it loads at 0,0)
    lay.set_visible(visible)
IMG.remove_layer(Gimp.Layer.get_by_id(DEFAULT_LAYER_ID))   # ONLY new_canvas's own default layer, by its id
\`\`\`

5. Then one exec per batch of about 15-20 layers (each call under ~8 s), with \`Gimp.displays_flush()\` at the end so
   the user sees it grow. On a timeout: poll with a quick exec that prints a count. Never re-send the batch.
6. Save in one exec (the extension picks the exporter):

\`\`\`python
P = r'C:/path/to/avatar'
Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, IMG, Gio.File.new_for_path(P + '.xcf'), None)
ok = Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, IMG, Gio.File.new_for_path(P + '.psd'), None)
IMG.clean_all()        # only on YOUR image, never on the user's
print(ok, os.path.getsize(P + '.psd'))
\`\`\`

Kept in the PSD: groups (as folders, nested), paint order, layer offsets and sizes (cropped layers stay small), hidden
flags, names (Unicode is fine), 8-bit RGBA.

Pitfalls:
- \`export_image\` / \`batch_export\` flatten a copy and only write PNG / JPEG / WEBP / TIFF (anything else becomes PNG).
- \`create_layer\`, \`reorder_layer\`, \`set_layer_properties\` and \`list_layers\` see only top-level, full-canvas layers;
  \`IMG.get_layers()\` is top level only: use \`group.get_children()\`.
- \`new_canvas(fill="white")\` leaves an opaque bottom layer: delete it.
- A long exec freezes GIMP's window for that long: keep batches short.

Then tell the user to open VTube Pro > Avatars > Make a 2D avatar and pick the PSD.
`;

const REF_ART = `# Textures, overlays, emotes, thumbnails and sounds

- ComfyUI on the user's PC: \`comfy_workflows\` lists VTube Pro's ready recipes (thumbnails, emotes, overlays, posters,
  stickers, room textures, skies, outfits) per graphics-card size; \`install_comfy_workflow\` sets one up after the user
  presses Yes; \`comfy_workflow_status\` follows it. Every model in them allows commercial use.
- Your app's own image tool is fine for concept art and overlays. Never put a real person's photo on a face.
- Overlays: transparent PNG / WebM, safe margins, readable at 1080p, the performer's face never covered.
- Fonts: check the licence (Google Fonts are OFL). Palettes: match the avatar.
- Sounds: VTube Pro's CC0 library first (get_docs lists it); generated sounds are saved as files.
  **Never play a sound**: the user may be live.
`;

/** Every file of the skill (relative path -> text). `houseRules` = the full list from the helper (server/aiKnowledge.ts). */
export function creatorSkillFiles(houseRules: string): Record<string, string> {
  return {
    'SKILL.md': SKILL_MD,
    'agents/openai.yaml': OPENAI_YAML,
    'references/house-rules.md': houseRules.endsWith('\n') ? houseRules : `${houseRules}\n`,
    'references/3d.md': REF_3D,
    'references/rooms.md': REF_ROOMS,
    'references/pro2d-layers.md': REF_PRO2D,
    'references/art-and-sound.md': REF_ART,
  };
}

/** Agent Skills frontmatter rules (agentskills.io/specification), used by the unit test. */
export function checkSkillFrontmatter(md: string): string[] {
  const out: string[] = [];
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return ['no YAML frontmatter'];
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1].trim() ?? '';
  const desc = /^description:\s*(.+)$/m.exec(m[1])?.[1].trim() ?? '';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) out.push('name must be lowercase letters, digits and single hyphens (max 64)');
  if (name !== CREATOR_SKILL_NAME) out.push('name must equal the folder name');
  if (!desc || desc.length > 1024) out.push('description must be 1-1024 characters');
  // a plain YAML scalar must not hold ": " or " #" (it would end the value)
  if (/: | #/.test(desc)) out.push('description must not contain ": " or " #" (plain YAML)');
  if (md.split('\n').length > 500) out.push('SKILL.md should stay under 500 lines');
  return out;
}
