# ComfyUI workflows

Ready-made recipes for your stream: a 3D character maker (picture to 3D), thumbnails, emotes, overlays, posters, stickers,
room textures, skies and new outfits for your avatar. They run in ComfyUI, a free picture AI on your own computer.

Each recipe comes in three sizes, one for each kind of graphics card. Every picture model in them allows commercial use.
The 3D character maker uses Hunyuan3D, whose licence does not cover the EU, the UK or South Korea: see "Models and licences" below.

## The easy way: ask your AI

1. Open ComfyUI on your computer. Don't have it yet? VTube Pro's [Local AI page](LOCAL_AI.md) shows you how.
2. Tell your AI, for example: **"Set up the VTube Pro thumbnail workflow in ComfyUI"**.
3. A VTube Pro page opens on your computer. It lists every download and its size. Press **Yes, set it up**.
4. When it says **You're all set!**, press **Open ComfyUI**, then press **W** and pick the workflow. Change the
   green boxes, then press **Run**.

Nothing downloads until you press **Yes, set it up**. If there is something to download, the button says how much.
Every file comes from its official page, and VTube Pro checks each one.
Your AI can't press Yes for you.

This works with any AI connected to VTube Pro (Claude, ChatGPT, Grok or a local AI). See [AI connections](AI_CONNECT.md).

## Or set it up yourself

1. Open ComfyUI.
2. Open VTube Pro's [ComfyUI workflows](http://127.0.0.1:5191/comfyui) page.
3. Pick your graphics card size, then press **Set it up for me** on the recipe you want.
4. Check the list and press **Yes, set it up**.

Just want the workflow in ComfyUI, without the models? Press **Add it to ComfyUI for me** on the recipe. It lands in ComfyUI's
Workflows list (press **W** in ComfyUI). The page also tells you the folder: `ComfyUI/user/default/workflows`.
If a workflow with that name is already in the list (for example you changed it and saved it), we leave it as it is and say so.
Press **Replace it with the original** only if you want the original back.

## Or by hand

1. Download a workflow file from the list below, or press **Download the file** on VTube Pro's ComfyUI workflows
   page. It lands in your **Downloads** folder, and its name starts with "VTube Pro".
2. Open ComfyUI and drag the file onto its window. Or open ComfyUI's **Workflow** menu, choose **Open** and pick the file.
   (To keep it for later, put the file in ComfyUI's workflows folder, `ComfyUI/user/default/workflows`.)
3. If ComfyUI says models are missing, let it download them. The links are also in the **Start here** note inside the
   workflow.
4. Change the green boxes, then press **Run**. Your pictures land in ComfyUI's `output/VTubePro` folder.

## Which size do I pick?

| Your graphics card memory | Pick | What it uses |
|---|---|---|
| 8 to 11 GB | **8 GB** | SDXL. Most gaming PCs from the last 5 years. Can't write words in pictures: add text in any editor. |
| 12 to 23 GB | **16 GB** | Z-Image-Turbo + FLUX.2 klein 4B. Fast and sharp. Writes short words. Works from 12 GB, a bit slower. |
| 24 GB or more | **24 GB** | Qwen-Image 2512 + Qwen-Image-Edit 2511. Best quality and the best words in pictures. Uses fp8 weights: an NVIDIA RTX card is best. |

Not sure how much you have? VTube Pro's [Local AI page](LOCAL_AI.md) checks for you (only with your OK).
Make pictures when you are not live: picture AI slows face tracking.

## The recipes

### Character 3D

A picture of your character (whole body, facing front) turned into a 3D model on your own computer. The model is plain grey: it has the shape, not the colours.

1. Load a picture of your character in "Your character picture": whole body, facing the front, one character.
2. Press Run. It takes a few minutes, so do it when you are not live.

**You get:** A .glb 3D model in ComfyUI's output/VTubePro folder.

**In VTube Pro:** The Create tab's "Create my character" runs this for you. Or add the .glb with "Add my model", then paint it (Create tab, "Paint with AI") or finish it in Blender. VTube Pro adds the eyes and mouth.

**Ask your AI:** "Set up the VTube Pro character 3D workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/character-3d/small.workflow.json) (downloads 5.4 GB) · [16 GB](../public/comfy-workflows/character-3d/medium.workflow.json) (downloads 7.8 GB) · [24 GB](../public/comfy-workflows/character-3d/large.workflow.json) (downloads 7.8 GB)

- Original characters only: no existing characters, logos or game art.
- A plain background and even light give the cleanest shape.
- The Hunyuan3D licence does not cover the EU, the UK or South Korea: if you live there, use another way to make your character.

### Avatar texture repaint

Your model's texture sheet repainted in the colours and materials of a character picture. Every seam stays where it is.

1. Load your texture sheet (the PNG from your model) in "Your texture".
2. Load a picture of the character in "Your reference".
3. Change the words if you like, then press Run.

**You get:** A PNG the same size as your texture. Save it as a new file; keep the original.

**In VTube Pro:** Open your model in Blender (or the costume editor), swap the texture for the new PNG and check it from every side. For whole-model paint by camera views, VTube Pro's own painter (Create tab, "Paint with AI") does more.

**Ask your AI:** "Set up the VTube Pro avatar texture repaint workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/avatar-texture-repaint/small.workflow.json) (downloads 12.8 GB) · [16 GB](../public/comfy-workflows/avatar-texture-repaint/medium.workflow.json) (downloads 16.1 GB) · [24 GB](../public/comfy-workflows/avatar-texture-repaint/large.workflow.json) (downloads 31.0 GB)

- Faces stay hand-drawn: repaint clothes and hair, then fix the face by hand.
- If a seam moved, lower "denoise" (small) or say "keep every line" (medium, large).
- Run it when you are not live.

### Outfit or skin variant

A recolour or restyle of a texture (a winter jacket, a red version) that still fits your model.

1. Load the texture in "Your texture".
2. Say the change in words, like "make the jacket dark green wool".
3. Press Run. Try a few times and keep the best.

**You get:** A PNG the same size as the original texture.

**In VTube Pro:** Add it as a new costume or texture set (the Costumes tab, or import_costume for AIs). Never overwrite the original.

**Ask your AI:** "Set up the VTube Pro outfit variant workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/avatar-skin-variant/small.workflow.json) (downloads 9.5 GB) · [16 GB](../public/comfy-workflows/avatar-skin-variant/medium.workflow.json) (downloads 16.1 GB) · [24 GB](../public/comfy-workflows/avatar-skin-variant/large.workflow.json) (downloads 31.0 GB)

- Name what must not change: "keep the emblem and every seam".
- Picture size stays the same as the original, so it fits your model.

### Character reference sheet

Front, side and back views of an original character, to model from or to paint textures with.

1. Describe your character in "Your prompt": hair, eyes, outfit, colours.
2. Press Run a few times and keep the most consistent sheet.

**You get:** One wide sheet, 2048x1024 PNG, plain background.

**In VTube Pro:** Use it as the reference for the texture repaint workflow and for your model maker.

**Ask your AI:** "Set up the VTube Pro character sheet workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/character-concept-sheet/small.workflow.json) (downloads 7.0 GB) · [16 GB](../public/comfy-workflows/character-concept-sheet/medium.workflow.json) (downloads 20.8 GB) · [24 GB](../public/comfy-workflows/character-concept-sheet/large.workflow.json) (downloads 31.0 GB)

- Original designs only: no existing characters, logos or game outfits.
- A neutral A-pose and even light make modelling easier.

### Seamless room tiles

Square textures that repeat with no visible seam: wood floor, brick, carpet, tiles, fabric.

1. Say the material in "Your prompt" (keep "flat, even lighting").
2. Press Run. The workflow swaps the halves and repaints the seams for you.

**You get:** 1024x1024 PNG that tiles in both directions.

**In VTube Pro:** Use it in your room's material in Blender (or the room creation package). 1024 px fits VTube Pro's texture budget.

**Ask your AI:** "Set up the VTube Pro seamless tile workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/room-seamless-tiles/small.workflow.json) (downloads 6.9 GB) · [16 GB](../public/comfy-workflows/room-seamless-tiles/medium.workflow.json) (downloads 20.7 GB) · [24 GB](../public/comfy-workflows/room-seamless-tiles/large.workflow.json) (downloads 30.9 GB)

- Baked shadows repeat badly: ask for flat, even light.
- Check it: put four copies side by side in any editor.

### 360 sky

A wrap-around sky or far backdrop (sunset city, space, forest) for outside your windows.

1. Describe the place in "Your prompt". Keep "horizon in the middle".
2. Press Run. The left and right edges are joined for you.

**You get:** 4096x2048 PNG (2:1, wraps left to right).

**In VTube Pro:** Put it on your room's sky mesh with a material named M_Sky (or SKY_...) so the room's lighting tints it.

**Ask your AI:** "Set up the VTube Pro 360 sky workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/room-skybox-360/small.workflow.json) (downloads 7.0 GB) · [16 GB](../public/comfy-workflows/room-skybox-360/medium.workflow.json) (downloads 20.8 GB) · [24 GB](../public/comfy-workflows/room-skybox-360/large.workflow.json) (downloads 31.0 GB)

- Plain sky at the top and plain ground at the bottom hide the stretching.
- Keep people out of panoramas.

### Poster or sign with text

Wall posters, shop signs, menu boards and banners with readable words.

1. Write the words in quotes inside "Your prompt", like the title "LATE NIGHT RAMEN".
2. Press Run. Small: add the words in any editor afterwards.

**You get:** 1024x2048 PNG (portrait poster). Power-of-two, so it works as a texture.

**In VTube Pro:** Put it on a poster or sign in your room (Blender), or use it as the in-room screen picture.

**Ask your AI:** "Set up the VTube Pro poster workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/room-screen-posters/small.workflow.json) (downloads 7.0 GB) · [16 GB](../public/comfy-workflows/room-screen-posters/medium.workflow.json) (downloads 20.8 GB) · [24 GB](../public/comfy-workflows/room-screen-posters/large.workflow.json) (downloads 31.0 GB)

- No real brands or logos: make your own designs.
- Short titles come out best (2-4 words).

### Decals and stickers

Graffiti, stickers, patches and your own emblems for walls and costumes.

1. Describe the sticker in "Your prompt" (keep "plain white background").
2. Press Run. The background is removed for you.

**You get:** 1024x1024 PNG with a transparent background.

**In VTube Pro:** Use it as a decal in your room or a patch on a costume. Pack several into one 2048 sheet to save memory.

**Ask your AI:** "Set up the VTube Pro sticker workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/decals-stickers/small.workflow.json) (downloads 7.4 GB) · [16 GB](../public/comfy-workflows/decals-stickers/medium.workflow.json) (downloads 21.1 GB) · [24 GB](../public/comfy-workflows/decals-stickers/large.workflow.json) (downloads 31.4 GB)

- A plain background gives the cleanest cut-out.
- Thick outlines read well from far away.

### Stream thumbnail

A 16:9 thumbnail: a generated background, a big title, and your avatar cut out on top.

1. Load a picture of your avatar in "Your avatar".
2. Change the theme and the title words in "Your prompt".
3. Press Run. Your avatar is cut out and placed on the right.

**You get:** 1280x720 PNG (YouTube and Twitch size).

**In VTube Pro:** Take a picture of your avatar in the studio (a clean background helps), load it as "Your avatar", run, upload the result.

**Ask your AI:** "Set up the VTube Pro thumbnail workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/stream-thumbnail/small.workflow.json) (downloads 7.4 GB) · [16 GB](../public/comfy-workflows/stream-thumbnail/medium.workflow.json) (downloads 21.1 GB) · [24 GB](../public/comfy-workflows/stream-thumbnail/large.workflow.json) (downloads 31.4 GB)

- 3-4 big words at most. Strong contrast.
- Your avatar's face should be large.
- Don't use other creators' art or game key art.

### Overlays and screens

A full-screen "Starting soon" or "Be right back" picture, or a panel background, in your style.

1. Describe the scene in "Your prompt" (medium and large can write the words).
2. Press Run.

**You get:** 1920x1080 PNG.

**In VTube Pro:** Add it in OBS as an Image source, or use it as the in-room screen picture.

**Ask your AI:** "Set up the VTube Pro overlay workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/stream-overlay/small.workflow.json) (downloads 7.0 GB) · [16 GB](../public/comfy-workflows/stream-overlay/medium.workflow.json) (downloads 20.7 GB) · [24 GB](../public/comfy-workflows/stream-overlay/large.workflow.json) (downloads 31.0 GB)

- Keep the middle calm if your avatar or a game goes there.

### Chat emotes

Little expressive faces of your character for Twitch, YouTube and Discord chat.

1. Load a close-up picture of your avatar in "Your avatar".
2. Change the emotion in "Your prompt" (laughing, crying, love...).
3. Press Run. You get four sizes with see-through backgrounds.

**You get:** Transparent PNGs: 1024 px master plus 112, 56 and 28 px (Twitch sizes).

**In VTube Pro:** Pose your avatar's face in the studio, take a picture, load it as "Your avatar". The emotes then match your model.

**Ask your AI:** "Set up the VTube Pro emote workflow in ComfyUI"

**Workflow files:** [8 GB](../public/comfy-workflows/chat-emotes/small.workflow.json) (downloads 10.8 GB) · [16 GB](../public/comfy-workflows/chat-emotes/medium.workflow.json) (downloads 16.6 GB) · [24 GB](../public/comfy-workflows/chat-emotes/large.workflow.json) (downloads 31.5 GB)

- Check the 28 px one: if you can't read it that small, simplify.
- Big expressions and thick outlines survive shrinking.
- Each platform has its own emote rules: read them before uploading.

## Models and licences

Checked 2026-10-16. All of them allow commercial use of what you make by default, except the two Hunyuan3D files
(below the table). VTube Pro only downloads these exact files, from these pages, and checks each one's SHA-256
fingerprint. Each workflow's `.manifest.json` lists its files with the address, size and SHA-256.

| File | Size | Licence | Official page |
|---|---|---|---|
| sd_xl_base_1.0.safetensors | 6.9 GB | CreativeML Open RAIL++-M | <https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0> |
| animagine-xl-4.0-opt.safetensors | 6.9 GB | CreativeML Open RAIL++-M | <https://huggingface.co/cagliostrolab/animagine-xl-4.0> |
| controlnet-union-sdxl-promax.safetensors | 2.5 GB | Apache-2.0 | <https://huggingface.co/xinsir/controlnet-union-sdxl-1.0> |
| ip-adapter-plus_sdxl_vit-h.safetensors | 848 MB | Apache-2.0 | <https://huggingface.co/h94/IP-Adapter> |
| CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors | 2.5 GB | Apache-2.0 (h94/IP-Adapter repo; the OpenCLIP ViT-H-14 weights are MIT) | <https://huggingface.co/h94/IP-Adapter> |
| RealESRGAN_x4plus.safetensors | 67 MB | BSD-3-Clause | <https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged> |
| birefnet.safetensors | 444 MB | MIT | <https://huggingface.co/Comfy-Org/BiRefNet> |
| z_image_turbo_bf16.safetensors | 12.3 GB | Apache-2.0 | <https://huggingface.co/Comfy-Org/z_image_turbo> |
| qwen_3_4b.safetensors | 8.0 GB | Apache-2.0 | <https://huggingface.co/Comfy-Org/z_image_turbo> |
| ae.safetensors | 335 MB | Apache-2.0 | <https://huggingface.co/Comfy-Org/z_image_turbo> |
| flux-2-klein-4b.safetensors | 7.8 GB | Apache-2.0 (the 4B only; FLUX.2 klein 9B is non-commercial) | <https://huggingface.co/Comfy-Org/flux2-klein> |
| flux2-vae.safetensors | 336 MB | Apache-2.0 | <https://huggingface.co/Comfy-Org/flux2-klein> |
| qwen_image_2512_fp8_e4m3fn.safetensors | 20.4 GB | Apache-2.0 | <https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI> |
| qwen_2.5_vl_7b_fp8_scaled.safetensors | 9.4 GB | Apache-2.0 | <https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI> |
| qwen_image_vae.safetensors | 254 MB | Apache-2.0 | <https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI> |
| Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors | 850 MB | Apache-2.0 | <https://huggingface.co/lightx2v/Qwen-Image-2512-Lightning> |
| qwen_image_edit_2511_fp8mixed.safetensors | 20.5 GB | Apache-2.0 | <https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI> |
| Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors | 850 MB | Apache-2.0 | <https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning> |
| hunyuan3d-dit-v2_fp16.safetensors | 4.9 GB | Tencent Hunyuan 3D 2.0 Community (not for use in the EU, UK or South Korea) | <https://huggingface.co/Comfy-Org/hunyuan3D_2.0_repackaged> |
| hunyuan_3d_v2.1.safetensors | 7.4 GB | Tencent Hunyuan 3D 2.1 Community (not for use in the EU, UK or South Korea) | <https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged> |

Background removal uses ComfyUI's own **Remove Background** node with BiRefNet (MIT). We never use RMBG-2.0
(non-commercial), FLUX dev or FLUX.2 klein 9B (non-commercial).

**Hunyuan3D (Character 3D only).** Licence: Tencent Hunyuan 3D Community. It does not cover the EU, the UK or South Korea. If you live there, don't download it. A company with over 1 million monthly users needs Tencent's OK first. VTube Pro never bundles these weights and never makes them a
default: VTube Pro's page shows this notice above the Yes button, and only your Yes downloads them. The licence also bans
using the model or its outputs to train another AI model.

**Add-on (custom node):**
- [ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus) at version `a0f451a5113cf9becb0847b92884cb10cbdec0ef` (GPL-3.0 (the node code; it runs inside your ComfyUI, VTube Pro does not ship it)). Only the 8 GB texture and emote recipes need it.

Tested with ComfyUI 0.22.3. Pack 2026.10.01.

## If something goes wrong

| You see | Do this |
|---|---|
| "ComfyUI isn't open" | Open ComfyUI, wait until it shows its node graph, then press **Check again**. |
| "A different file called ... is already there" | You have another file with that name. Rename or move it, then press **Set it up for me** again. |
| "Not enough free space" | Free up space on that drive, or pick a smaller size. |
| A red box in ComfyUI | Update ComfyUI to its newest version. After an add-on was added, close ComfyUI and open it again. |
| It stopped halfway | Press **Try again**. It continues where it left off. |
| You press **Yes** and it stops | The page stays on "Setting it up" and says why, with a **Try again** button. |
| "Couldn't reach Hugging Face" or "stopped downloading part way" | Check your internet, then press **Try again**. It continues where it left off. |
| "ComfyUI doesn't have the 3D model yet" (when you press Create my character) | Press **Set it up for me** next to it, or open VTube Pro's ComfyUI workflows page and set up **Character 3D**. |

## For AIs

- ComfyUI workflows (VTube Pro): 11 ready-made recipes (a 3D character maker, and pictures), each for 3 graphics-card sizes: small = 8 GB, medium = 16 GB (works from 12), large = 24 GB.
- Workflows (pass the exact id; when the user names one, use that one): character-3d = "Character 3D": A picture of your character (whole body, facing front) turned into a 3D model on your own computer. The model is plain grey: it has the shape, not the colours. | avatar-texture-repaint = "Avatar texture repaint": Your model's texture sheet repainted in the colours and materials of a character picture. Every seam stays where it is. | avatar-skin-variant = "Outfit or skin variant": A recolour or restyle of a texture (a winter jacket, a red version) that still fits your model. | character-concept-sheet = "Character reference sheet": Front, side and back views of an original character, to model from or to paint textures with. | room-seamless-tiles = "Seamless room tiles": Square textures that repeat with no visible seam: wood floor, brick, carpet, tiles, fabric. | room-skybox-360 = "360 sky": A wrap-around sky or far backdrop (sunset city, space, forest) for outside your windows. | room-screen-posters = "Poster or sign with text": Wall posters, shop signs, menu boards and banners with readable words. | decals-stickers = "Decals and stickers": Graffiti, stickers, patches and your own emblems for walls and costumes. | stream-thumbnail = "Stream thumbnail": A 16:9 thumbnail: a generated background, a big title, and your avatar cut out on top. | stream-overlay = "Overlays and screens": A full-screen "Starting soon" or "Be right back" picture, or a panel background, in your style. | chat-emotes = "Chat emotes": Little expressive faces of your character for Twitch, YouTube and Discord chat.
- avatar-texture-repaint needs the texture sheet AND a reference picture of the character; avatar-skin-variant changes a texture from words only (no picture). Never swap one for the other.
- character-3d turns ONE picture of an original character (whole body, facing front) into a plain grey 3D model with ComfyUI's built-in Hunyuan3D nodes. It needs a picture: there is no words-only version. Its licence does not cover the EU, the UK or South Korea (and a company with over 1 million monthly users needs Tencent's OK): tell the user before you set it up, and don't offer it to someone who lives there. The weights are never bundled: the user's own Yes downloads them, after VTube Pro page shows that notice. Hunyuan3D is never bundled. It comes only through VTube Pro's Character 3D recipe (`character-3d`, set up with install_comfy_workflow) in the USER's own ComfyUI, as the user's own download after the user's own Yes, with the Tencent Hunyuan 3D Community Licence shown first: it does not cover the EU, the UK or South Korea, so never offer it to someone who lives there. You may suggest or use it for props, creatures, mascots and non-human characters. Humans and anime humans never come from it: they start from a proper base (a VRoid CC0 sample or blender/face_kit).
- To set one up for the user: call install_comfy_workflow {workflow, tier}. If you don't know their graphics memory, ask (or let the tool use their shared scan).
- VTube Pro then opens a page on their computer listing every download with its size and licence. Tell them to check it and press Yes there. You cannot press Yes for them, and nothing downloads before they do.
- Then follow with comfy_workflow_status {request}. When it says done: tell them to open ComfyUI, press W (Workflows), open "VTube Pro - <name>", change the green boxes and press Run. If it says restart: close and reopen ComfyUI first.
- ComfyUI must be open on their computer. If it isn't: tell them to open it (Desktop app or run_nvidia_gpu.bat), or set it up first with local_ai_recommend / the Local AI page.
- By hand: the files are in the `public/comfy-workflows/<id>/<tier>.workflow.json` folder of your VTube Pro folder (drag one into ComfyUI).
- Every picture model allows commercial use (character-3d's Hunyuan3D weights are the one exception, see above). Pictures and 3D models are made when the user is not live (GPU jobs slow face tracking).

Tools (through VTube Pro's MCP server):
- `comfy_workflows {task?, vramGB?}`: the recipes in words, with models and licences.
- `install_comfy_workflow {workflow, tier? | vramGB?}`: asks VTube Pro to set one up. It opens VTube Pro's page on the
  user's computer with the full download list. Only the user's **Yes** there starts anything.
- `comfy_workflow_status {request}`: waiting, working (with progress), done, or what went wrong.
- `local_ai_recommend`: which tier fits their computer, and how to install ComfyUI.

Workflow ids: `character-3d`, `avatar-texture-repaint`, `avatar-skin-variant`, `character-concept-sheet`, `room-seamless-tiles`, `room-skybox-360`, `room-screen-posters`, `decals-stickers`, `stream-thumbnail`, `stream-overlay`, `chat-emotes`. Tiers: `small` (8 GB), `medium` (16 GB), `large` (24 GB).

## For maintainers

| File | What |
|---|---|
| `shared/comfyWorkflows/models.ts` | Every model file: repo, pinned revision, size, SHA-256, licence (`node tools/comfy/pin_models.mjs` prints fresh values) |
| `shared/comfyWorkflows/nodes.ts` | Custom nodes, pinned to a commit |
| `shared/comfyWorkflows/catalog.ts` | The 11 recipes x 3 sizes as graphs, manifests |
| `shared/comfyWorkflows/nodeSchema.json` | ComfyUI's node definitions, captured by `tools/comfy/capture_schema.ts` (the nodes in `handWritten` were typed from ComfyUI's own Hunyuan3D template: confirm them with `validate_live.ts` and a fresh capture against a real ComfyUI) |
| `server/comfyInstall.ts`, `server/routes/comfyWorkflows.ts`, `server/comfyWorkflowsPage.ts` | Plan, consent, verified downloads, the /comfyui page and its API |
| `server/providers/comfy.ts`, `server/comfyCharacter.ts` | "Create my character" with ComfyUI: runs the Character 3D recipe (or your own file), says what is missing |

After a change: `npx tsx tools/comfy/build_workflows.ts` (rewrites `public/comfy-workflows/` and this guide), then
`npx tsx tools/comfy_workflows_unit.ts`. To check the graphs against a real ComfyUI: start a throwaway one with
`--cpu --base-directory <empty folder>` and run `npx tsx tools/comfy/validate_live.ts --url <its address> --placeholders <that folder>`.
The Hunyuan3D licence policy for Character 3D (the AI house rules, the docs and this catalogue say the same): `npx tsx tools/hunyuan_policy_unit.ts`.
The character provider: `npx tsx tools/comfy_provider_unit.ts`. In a muted headless browser (a private server and a pretend ComfyUI,
nothing downloaded): `tools/comfy_setup_e2e.mjs` (the /comfyui page) and `tools/comfy_create_e2e.mjs` (the studio's Create tab).
