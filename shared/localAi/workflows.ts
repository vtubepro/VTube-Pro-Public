// Curated ComfyUI workflows for VTube Pro jobs, matched to hardware tiers. This is KNOWLEDGE for AIs (served by the MCP
// tools in server/localAiTools.ts and the helper's Local AI page). The real, shareable graphs for the same ids live in
// shared/comfyWorkflows/ (public/comfy-workflows/, install_comfy_workflow); this file stays the recipe text: each recipe
// names the models,
// nodes, settings and the VTube Pro hand-off, so an AI can suggest the right one and walk the user through it, or
// build the graph in ComfyUI's own template browser. Where VTube Pro already has an automated tool (tools/ai_texture/*),
// the workflow points to it first.
//
// Update rules: model ids must exist in ./catalog.ts IMAGE_MODELS and node ids in COMFY_NODES (the unit test checks).
// Every variant lists only commercial-OK weights, except a recipe that sets `restricted` (Character 3D: Hunyuan3D, with
// a territory notice). Keep recipes short and concrete (node names as ComfyUI shows them).

import { HUNYUAN_AI_FOR, HUNYUAN_PLACES } from '../comfyWorkflows/models.ts';

export type TaskId =
  | 'character-3d' | 'avatar-texture' | 'avatar-skin' | 'concept-sheet' | 'room-tiles' | 'skybox' | 'room-art'
  | 'decal' | 'thumbnail' | 'overlay' | 'emote';

export interface WorkflowVariant {
  /** Short name of this variant, e.g. "SDXL + ControlNet (12 GB)". */
  label: string;
  minVramGB: number;
  models: string[];
  nodes: string[];
  recipe: string[];
  settings?: string;
}
export interface ComfyWorkflow {
  id: string;
  task: TaskId;
  title: string;
  /** What the user gets, in plain words. */
  forWhat: string;
  /** Size / format VTube Pro (or the platform) wants. */
  output: string;
  /** How the result gets into VTube Pro. */
  vtp: string;
  /** Best variant first. matchWorkflows picks the first whose minVramGB fits. */
  variants: WorkflowVariant[];
  tips: string[];
  licenceNote: string;
  /** Set when a weight in this recipe is not "commercial use OK by default": the warning to show first. */
  restricted?: string;
}

const LIVE_RULE = 'Run it when you are not live (GPU jobs slow face tracking).';

export const WORKFLOWS: ComfyWorkflow[] = [
  {
    id: 'character-3d', task: 'character-3d', title: 'Character 3D: a picture turned into a 3D model',
    forWhat: 'A picture of an original character (whole body, facing front) turned into a plain grey 3D model on the user\'s own computer, ready to rig and paint.',
    output: 'A .glb in ComfyUI\'s output/VTubePro folder (shape only, no colours).',
    vtp: 'Ready-made ComfyUI recipe: install_comfy_workflow "character-3d" (needs a picture; there is no words-only version). The Create tab\'s "Create my character" uses it when ComfyUI is set up for it. Then add the .glb with "Add my model" and paint it (Paint with AI) or finish it in Blender; VTube Pro adds the eyes and mouth.',
    variants: [
      { label: 'Hunyuan3D 2.1, finer detail (24 GB)', minVramGB: 20, models: ['hunyuan', 'birefnet'], nodes: [],
        recipe: ['Cut the character out (BiRefNet) and put it on plain white, centred in a square.', 'ComfyUI\'s built-in Image Only Checkpoint Loader (hunyuan_3d_v2.1.safetensors) -> CLIP Vision Encode -> Hunyuan3Dv2Conditioning -> KSampler with an Empty Latent Hunyuan3Dv2.', 'VAE Decode Hunyuan3D (detail 384) -> VoxelToMesh -> Save GLB.'],
        settings: '50 steps, CFG 5, euler, shape detail 384.' },
      { label: 'Hunyuan3D 2.1 (16 GB)', minVramGB: 12, models: ['hunyuan', 'birefnet'], nodes: [],
        recipe: ['Same graph, 30 steps and shape detail 256.', 'Works from 12 GB, a bit slower.'],
        settings: '30 steps, CFG 5, euler, shape detail 256.' },
      { label: 'Hunyuan3D 2.0 (8 GB)', minVramGB: 7, models: ['hunyuan', 'birefnet'], nodes: [],
        recipe: ['Same graph with hunyuan3d-dit-v2_fp16.safetensors (4.9 GB), 20 steps.', 'A plain background and even light in the picture matter most.'],
        settings: '20 steps, CFG 8, euler, shape detail 256.' },
    ],
    tips: ['Original characters only: no existing characters, logos or game art.', 'The result is grey: colour it afterwards.', 'Never make an avatar of a real person without their OK.', LIVE_RULE],
    licenceNote: `Restricted: the Hunyuan3D weights are not "commercial use OK by default". Their licence does not cover ${HUNYUAN_PLACES}. VTube Pro never bundles them: VTube Pro shows this notice and the user's own Yes downloads them. BiRefNet is MIT.`,
    restricted: `Hunyuan3D's licence does not cover ${HUNYUAN_PLACES} (and a company with over 1 million monthly users needs Tencent's OK). Tell the user before they set it up; do not offer it to someone who lives there. You may suggest or use it for ${HUNYUAN_AI_FOR}; humans and anime humans start from a proper base (a VRoid CC0 sample or blender/face_kit), never from it.`,
  },
  {
    id: 'avatar-texture-repaint', task: 'avatar-texture', title: 'Repaint an avatar\'s textures from a reference picture',
    forWhat: 'Your 3D model\'s colours repainted to match a character drawing, view by view, so it lines up with the UVs.',
    output: 'The model\'s own texture sizes (usually 1024-2048 px squares, PNG). A new model file in a job folder; the original is never overwritten.',
    vtp: 'Ready-made ComfyUI recipe: install_comfy_workflow "avatar-texture-repaint" (the texture sheet AND a reference picture; not the outfit variant). Automated in VTube Pro: tools/ai_texture/run.py (or POST /api/ai/texture, the Create tab\'s "Paint with AI" when wired). ComfyUI only needs to be running; VTube Pro builds the graphs itself. Check the result from 8+ angles in the app before applying.',
    variants: [
      { label: 'Qwen-Image-Edit-2509 + Lightning (24 GB) - VTube Pro\'s bake-off winner', minVramGB: 20, models: ['qwen-image'], nodes: [],
        recipe: ['Install the Qwen-Image-Edit-2509 fp8 model, its text encoder, VAE and the Lightning 8-step LoRA (folders in the model list).', 'Start ComfyUI, then run VTube Pro\'s painter with engine "qwen" (the default): it sends one edit per camera view with the reference crop + a geometry render.', 'Review the before / after sheet and the scores; apply only if it looks better from every angle.'],
        settings: '8 steps (Lightning), CFG 1. Workflows: tools/ai_texture/workflows/qwen_edit_view.api.json, qwen_edit_geometry_paint.api.json.' },
      { label: 'SDXL anime + ControlNet Union + IP-Adapter (12 GB)', minVramGB: 10.5, models: ['animagine-xl-4', 'controlnet-union-sdxl', 'ipadapter-plus-sdxl'], nodes: ['ipadapter'],
        recipe: ['Install Animagine XL 4.0, ControlNet Union ProMax and IP-Adapter Plus SDXL + CLIP-ViT-H (folders in the model list) and the IPAdapter plus node.', 'Run VTube Pro\'s painter with the SDXL engine (tools/ai_texture/workflows/sdxl_controlnet_ipadapter_paint.api.json): depth + lineart ControlNet keep the paint on the geometry, IP-Adapter copies the reference look, Differential Diffusion protects already-good texels.', 'Review and apply as above.'],
        settings: '896x1152 views, 25 steps, CFG 5, denoise 0.55-0.75, ControlNet 0.6-0.8.' },
      { label: 'SDXL + ControlNet, low-VRAM (8 GB)', minVramGB: 7, models: ['animagine-xl-4', 'controlnet-union-sdxl'], nodes: [],
        recipe: ['Start ComfyUI with --lowvram.', 'Run the SDXL engine at 768 px views without IP-Adapter (describe the colours in the prompt instead).', 'Expect softer results; repaint only the parts that need it.'],
        settings: '768x960 views, 20 steps, CFG 5.' },
    ],
    tips: ['Faces are drawn, never projected from a photo or render (house rule). Keep the face material protected and fix faces by hand or with the face kit.', 'Name materials by part (Hair, Skin, Eyes ...): the painter and the toon shader key on them.', LIVE_RULE],
    licenceNote: 'All weights commercial-OK (Apache-2.0 / Open RAIL++-M). Your reference art must be yours or licensed.',
  },
  {
    id: 'avatar-skin-variant', task: 'avatar-skin', title: 'New outfit colours / skin variant for an existing texture',
    forWhat: 'A recolour or restyle of an existing texture atlas (e.g. a winter version of a jacket) that still fits the UVs.',
    output: 'Same size as the original texture (PNG). Save it as a new costume / texture set, not over the original.',
    vtp: 'Ready-made ComfyUI recipe: install_comfy_workflow "avatar-skin-variant" (the texture + the change in words, no picture). tools/ai_texture/atlas.py repaints atlas regions with Qwen-Image-Edit and colour-matches each region; or do it in ComfyUI and import the costume (import_costume / the Costumes tab).',
    variants: [
      { label: 'Qwen-Image-Edit "change the colours" (24 GB)', minVramGB: 20, models: ['qwen-image'], nodes: [],
        recipe: ['Load the texture as the input image in the Qwen-Image-Edit template.', 'Prompt the change in words ("make the jacket dark green wool, keep every seam, emblem and shape exactly where it is").', 'Save; check the UV borders still line up in the app.'] },
      { label: 'FLUX.2 klein 4B edit (16 GB)', minVramGB: 14.5, models: ['flux2-klein-4b'], nodes: [],
        recipe: ['Open ComfyUI\'s FLUX.2 klein template (Templates browser), switch to the edit / reference-image graph.', 'Feed the texture as the reference image and describe the change.', '4 steps; generate a few seeds and keep the cleanest.'] },
      { label: 'SDXL img2img, low denoise (8 GB)', minVramGB: 7, models: ['sdxl', 'controlnet-union-sdxl'], nodes: [],
        recipe: ['Load Image (the texture) -> VAE Encode -> KSampler (denoise 0.35-0.5) with an SDXL checkpoint.', 'Add ControlNet Union (lineart / canny of the same texture) at 0.8 so shapes stay put.', 'Upscale back to the original size if you worked smaller.'],
        settings: 'denoise 0.35-0.5, 25 steps, CFG 6.' },
    ],
    tips: ['Keep the image size identical to the original texture.', 'Colours in glTF factors are linear; texture PNGs are sRGB - don\'t mix them up.', LIVE_RULE],
    licenceNote: 'Commercial-OK weights only. Don\'t repaint someone else\'s model or a game asset (house rules).',
  },
  {
    id: 'character-concept-sheet', task: 'concept-sheet', title: 'Character reference / turnaround sheet',
    forWhat: 'Front, side and back views of an original character, to model from or to paint textures with.',
    output: 'One wide sheet (e.g. 2048x1024) or separate 1024x1536 views, plain light background.',
    vtp: 'Use it as the reference for the avatar recipes (get_docs topic "creator" section "recipes") and as the input to the texture painter.',
    variants: [
      { label: 'Qwen-Image / Edit multiple angles (24 GB)', minVramGB: 20, models: ['qwen-image'], nodes: [],
        recipe: ['Generate the front view with Qwen-Image (it follows long descriptions well).', 'Feed it to Qwen-Image-Edit: "same character, side view, same outfit, neutral A-pose", then "back view".', 'Put the views side by side.'] },
      { label: 'Z-Image-Turbo (12 GB+)', minVramGB: 12, models: ['z-image-turbo'], nodes: [],
        recipe: ['Prompt "character turnaround sheet, front view, side view, back view, full body, A-pose, plain white background, <your character>".', 'Generate several seeds, keep the most consistent sheet.'], settings: '8 steps, CFG 1, 1536x768 or 2048x1024.' },
      { label: 'Animagine XL (8 GB)', minVramGB: 7, models: ['animagine-xl-4'], nodes: [],
        recipe: ['Tag prompt "character sheet, multiple views, front, side, back, full body, simple background, <tags>".', 'Use 1536x768; upscale with Real-ESRGAN anime_6B.'] },
    ],
    tips: ['Original designs only: no existing characters, logos or game outfits.', 'A neutral A-pose and even lighting make modelling and texture painting easier.'],
    licenceNote: 'Commercial-OK weights. You own an original design; don\'t prompt named artists or franchises.',
  },
  {
    id: 'room-seamless-tiles', task: 'room-tiles', title: 'Seamless material tiles for rooms (floors, walls, fabric)',
    forWhat: 'Square textures that repeat without visible seams: wood floor, brick, carpet, tiles, fabric.',
    output: '1024x1024 (VTube Pro budget: 1024 px tiling textures, JPEG for colour maps).',
    vtp: 'Automated: tools/ai_texture/tiles.py "tiles" (txt2img -> roll by half -> repaint the cross band -> colour-match). Or make it in ComfyUI and use it in the room\'s Blender material / creation package (get_docs topic "environments").',
    variants: [
      { label: 'Z-Image-Turbo + roll-and-repaint (12 GB+)', minVramGB: 12, models: ['z-image-turbo'], nodes: [],
        recipe: ['Generate the flat texture (8 steps).', 'Run VTube Pro\'s tiles.py on it (or offset by half and inpaint the cross band) to remove seams.'] },
      { label: 'SDXL + seamless tiling (8 GB, the classic)', minVramGB: 7, models: ['sdxl'], nodes: ['tiling'],
        recipe: ['Install the ComfyUI-seamless-tiling node.', 'Load Checkpoint -> "Seamless Tile" (both X and Y) on the model -> KSampler -> "Make Circular VAE" -> VAE Decode -> Save Image.', 'Prompt "top-down flat texture of <material>, even lighting, no shadows, no perspective".', 'Check with the "Offset Image" node: no seam should show in the middle.'],
        settings: '1024x1024, 25 steps, CFG 6.' },
    ],
    tips: ['Ask for "flat, even lighting": baked shadows in a tile repeat badly.', 'Match the room\'s value balance (tiles.py colour-matches to the tile being replaced).', LIVE_RULE],
    licenceNote: 'Commercial-OK weights; the tiling node is GPL-3.0 (fine for local use; VTube Pro doesn\'t ship it).',
  },
  {
    id: 'room-skybox-360', task: 'skybox', title: '360 sky / backdrop panorama',
    forWhat: 'A wrap-around sky or far backdrop (sunset city, space, forest) for outside the windows.',
    output: '2:1 equirectangular, 4096x2048 (generate 2048x1024, upscale 2x). Must wrap left-right.',
    vtp: 'Automated: tools/ai_texture/tiles.py "sky" (wraps in X + a 2x detail pass). Use it on a sky mesh with a material named M_Sky* / SKY_* so the room\'s environment engine tints it (docs/ARTIST_ENVIRONMENTS.md section 6).',
    variants: [
      { label: 'Qwen-Image wide panorama (24 GB)', minVramGB: 20, models: ['qwen-image', 'realesrgan'], nodes: ['tiling'],
        recipe: ['Prompt "equirectangular 360 panorama of <scene>, horizon in the middle, no people".', 'Generate 2048x1024 with X-only seamless tiling (or roll + repaint the seam).', 'Upscale 2x with Real-ESRGAN.'] },
      { label: 'SDXL + X-axis tiling (8 GB)', minVramGB: 7, models: ['sdxl', 'realesrgan'], nodes: ['tiling'],
        recipe: ['Seamless Tile with X only (Y off, the top and bottom don\'t wrap).', 'Empty Latent 2048x1024 (or 1536x768 on 8 GB), prompt as above.', 'Upscale with Real-ESRGAN; keep the poles (top / bottom rows) plain sky or ground so stretching doesn\'t show.'] },
    ],
    tips: ['Keep the horizon on the middle line.', 'Plain zenith and floor hide the equirectangular stretching.', LIVE_RULE],
    licenceNote: 'Commercial-OK weights.',
  },
  {
    id: 'room-screen-posters', task: 'room-art', title: 'Posters, signs and screen art inside rooms (with text)',
    forWhat: 'Wall posters, shop signs, a channel banner on the in-room screen, menu boards: art with readable words.',
    output: 'Power-of-two sizes for textures (1024x2048 poster, 2048x1024 banner); keep inside the 2048 px budget.',
    vtp: 'Put it on a plane / sign mesh in the room (Blender) or as a screen skin picture (screenSkin, docs/ARTIST_ENVIRONMENTS.md section 7).',
    variants: [
      { label: 'Qwen-Image (24 GB) - best text', minVramGB: 20, models: ['qwen-image'], nodes: [],
        recipe: ['Put the exact words in quotes in the prompt: poster with the title "LATE NIGHT RAMEN".', 'Generate at the final aspect ratio; 8 steps with the Lightning LoRA.'] },
      { label: 'Z-Image-Turbo (12 GB+) - short text', minVramGB: 12, models: ['z-image-turbo'], nodes: [],
        recipe: ['Same prompt pattern; keep the text to a few words.', 'If a letter is wrong, fix it in an image editor.'] },
      { label: 'SDXL art + add the text yourself (8 GB)', minVramGB: 7, models: ['sdxl'], nodes: [],
        recipe: ['Generate the picture with "blank space for a title" in the prompt (SDXL can\'t write).', 'Add the words in any image editor.'] },
    ],
    tips: ['No real brands, logos or game art (house rules): make original homage designs.'],
    licenceNote: 'Commercial-OK weights.',
  },
  {
    id: 'decals-stickers', task: 'decal', title: 'Decals, stickers and emblems with a transparent background',
    forWhat: 'Graffiti, logos for your own brand, stickers, patches, props on walls.',
    output: 'PNG with transparency, 512-1024 px square (or a 2048 px decal atlas).',
    vtp: 'Use as an alpha-blended decal plane in the room, or a patch on a costume. Pack several into one atlas to stay in budget.',
    variants: [
      { label: 'Z-Image-Turbo + BiRefNet cut-out (12 GB+)', minVramGB: 12, models: ['z-image-turbo', 'birefnet'], nodes: ['rmbg'],
        recipe: ['Prompt "<sticker / emblem>, flat vector style, thick outline, centered, plain white background".', 'Feed the result to the RMBG node with model BiRefNet -> Save Image (PNG keeps the alpha).'] },
      { label: 'SDXL + BiRefNet (8 GB)', minVramGB: 7, models: ['sdxl', 'birefnet'], nodes: ['rmbg'],
        recipe: ['Same prompt on SDXL at 1024x1024.', 'RMBG node -> BiRefNet -> Save Image.'] },
    ],
    tips: ['A plain background makes the cut-out clean.', 'Choose BiRefNet (MIT) in the RMBG node; RMBG-2.0 is non-commercial.'],
    licenceNote: 'Commercial-OK: Z-Image / SDXL + BiRefNet (MIT). The RMBG node is GPL-3.0 (local use).',
  },
  {
    id: 'stream-thumbnail', task: 'thumbnail', title: 'Stream / VOD thumbnails',
    forWhat: 'A 16:9 thumbnail with a big title and your avatar.',
    output: '1280x720 or larger 16:9 (YouTube: JPG / PNG, min width 640, up to 3840x2160).',
    vtp: 'Grab your avatar with a clean background from the studio (an observer / output page screenshot) and composite it over the generated background.',
    variants: [
      { label: 'Qwen-Image with the title text (24 GB)', minVramGB: 20, models: ['qwen-image'], nodes: ['rmbg'],
        recipe: ['Generate the background + title: \'YouTube thumbnail background, <theme>, bold title text "ZOMBIE NIGHT"\'.', 'Cut out your avatar screenshot with BiRefNet and place it on top (Image Composite Masked, or any editor).'] },
      { label: 'Z-Image-Turbo background (12 GB+)', minVramGB: 12, models: ['z-image-turbo'], nodes: ['rmbg'],
        recipe: ['Generate 1344x768 (16:9-ish), 8 steps; short title in quotes or add it later.', 'Composite the avatar cut-out.'] },
      { label: 'SDXL background + text in an editor (8 GB)', minVramGB: 7, models: ['sdxl', 'realesrgan'], nodes: [],
        recipe: ['Generate 1344x768 with "empty space on the left for text".', 'Upscale, add the title and your avatar in any editor.'] },
    ],
    tips: ['Big readable words (3-4 max), strong contrast, your avatar\'s face large.'],
    licenceNote: 'Commercial-OK weights. Don\'t use other creators\' art or game key art.',
  },
  {
    id: 'stream-overlay', task: 'overlay', title: 'Overlays, frames, BRB / Starting soon screens',
    forWhat: 'A webcam / chat frame, a "Be right back" or "Starting soon" screen in your style.',
    output: '1920x1080 PNG (frames with a transparent window), or JPG for full-screen backgrounds.',
    vtp: 'Add it in OBS as an Image source above the VTube Pro output, or use it as the in-room screen picture.',
    variants: [
      { label: 'Z-Image-Turbo (12 GB+)', minVramGB: 12, models: ['z-image-turbo'], nodes: ['rmbg'],
        recipe: ['Generate a 1920x1088 background ("cozy pixel-art bedroom, starting soon screen, soft lights").', 'For a frame: generate the border art, then cut the middle out in an editor (or mask it) to leave a transparent window.'] },
      { label: 'SDXL (8 GB)', minVramGB: 7, models: ['sdxl', 'realesrgan'], nodes: [],
        recipe: ['Generate 1344x768, upscale to 1920x1080 with Real-ESRGAN.', 'Add text in an editor.'] },
    ],
    tips: ['Leave the centre calm where your avatar or the game goes.'],
    licenceNote: 'Commercial-OK weights.',
  },
  {
    id: 'chat-emotes', task: 'emote', title: 'Chat emotes and badges',
    forWhat: 'Little expressive faces of your character for Twitch / Discord / YouTube chat.',
    output: 'Transparent PNG; draw at 1024 px, deliver 112x112, 56x56 and 28x28 (Twitch, each under 1 MB).',
    vtp: 'Tip: pose your avatar in the studio (expressions), screenshot it, and use that as the reference so emotes match the model.',
    variants: [
      { label: 'Qwen-Image-Edit from your avatar screenshot (24 GB)', minVramGB: 20, models: ['qwen-image', 'birefnet'], nodes: ['rmbg'],
        recipe: ['Input: a studio screenshot of your avatar\'s face.', 'Edit prompt: "chibi chat emote of this character, laughing, thick outline, simple shading, white background".', 'BiRefNet cut-out -> downscale to 112 / 56 / 28.'] },
      { label: 'Animagine XL + IP-Adapter (12 GB)', minVramGB: 10.5, models: ['animagine-xl-4', 'ipadapter-plus-sdxl', 'birefnet'], nodes: ['ipadapter', 'rmbg'],
        recipe: ['IP-Adapter with your character sheet / screenshot as the reference (weight 0.6-0.8).', 'Tags: "chibi, emote, <emotion>, thick outline, simple background".', 'BiRefNet cut-out, downscale.'] },
      { label: 'Animagine XL (8 GB)', minVramGB: 7, models: ['animagine-xl-4', 'birefnet'], nodes: ['rmbg'],
        recipe: ['Describe the character in tags (hair colour, eyes, outfit) + "chibi, emote, <emotion>".', 'Cut out with BiRefNet and downscale.'] },
    ],
    tips: ['Check each emote at 28x28: if it isn\'t readable that small, simplify.', 'Exaggerate the expression; thick outlines survive downscaling.'],
    licenceNote: 'Commercial-OK weights. Platforms have their own emote rules: read them before uploading.',
  },
];

export interface WorkflowPick { workflow: ComfyWorkflow; variant: WorkflowVariant }

/** The best variant of each workflow (or of one task) that fits `vramGB`. Workflows with no fitting variant are left out. */
export function matchWorkflows(o: { vramGB: number; task?: string }): WorkflowPick[] {
  const out: WorkflowPick[] = [];
  for (const w of WORKFLOWS) {
    if (o.task && w.task !== o.task && w.id !== o.task) continue;
    const v = w.variants.find((x) => x.minVramGB <= o.vramGB);
    if (v) out.push({ workflow: w, variant: v });
  }
  return out;
}

export const TASK_IDS: TaskId[] = [...new Set(WORKFLOWS.map((w) => w.task))];

/** Markdown for AIs: one workflow in full, or the index. */
export function workflowsMarkdown(o: { vramGB?: number; task?: string; modelName?: (id: string) => string; nodeName?: (id: string) => string }): string {
  const mn = o.modelName ?? ((id: string) => id);
  const nn = o.nodeName ?? ((id: string) => id);
  const list = WORKFLOWS.filter((w) => !o.task || w.task === o.task || w.id === o.task);
  if (!list.length) return `No workflow for "${o.task}". Tasks: ${TASK_IDS.join(', ')}.`;
  const lines: string[] = [`# ComfyUI workflows for VTube Pro${o.vramGB !== undefined ? ` (for ~${o.vramGB} GB of graphics memory)` : ''}`,
    'Suggest these only when the user wants them. Each one is also a ready-made ComfyUI workflow file in 3 sizes (8 / 16 / 24 GB). To set one up, call install_comfy_workflow {workflow, tier}: VTube Pro lists every download and the USER presses Yes on its page (never you). Otherwise give the steps and official links (comfy_workflows / local_ai_recommend list them). GPU jobs only when the user is not live.', ''];
  for (const w of list) {
    const variants = o.vramGB === undefined ? w.variants : w.variants.filter((v) => v.minVramGB <= o.vramGB!);
    lines.push(`## ${w.title} (\`${w.id}\`, task \`${w.task}\`)`, ...(w.restricted ? [`**Licence warning: ${w.restricted}**`] : []), w.forWhat, `- Output: ${w.output}`, `- In VTube Pro: ${w.vtp}`, `- Ready-made: install_comfy_workflow {workflow: "${w.id}"} (or drag /comfy-workflows/${w.id}/<small|medium|large>.workflow.json into ComfyUI)`);
    if (!variants.length) lines.push(`- Needs at least ${Math.min(...w.variants.map((v) => v.minVramGB))} GB of graphics memory: not for this machine.`);
    for (const v of variants) {
      lines.push(`### ${v.label}`, `Models: ${v.models.map(mn).join(', ')}${v.nodes.length ? `. Custom nodes: ${v.nodes.map(nn).join(', ')}` : '. No extra nodes'}.`);
      v.recipe.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
      if (v.settings) lines.push(`Settings: ${v.settings}`);
      if (o.vramGB !== undefined) break; // the best fitting variant only
    }
    lines.push(`Tips: ${w.tips.join(' ')}`, `Licence: ${w.licenceNote}`, '');
  }
  return lines.join('\n');
}
