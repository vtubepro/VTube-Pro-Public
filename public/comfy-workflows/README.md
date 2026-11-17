# VTube Pro ComfyUI workflows

Pack 2026.10.01. Tested with ComfyUI 0.22.3. Free to share.

Ready-made ComfyUI workflows for streamers: a 3D character maker (picture to 3D), textures, outfits, character sheets,
room tiles, 360 skies, posters, stickers, thumbnails, overlays and emotes. Each comes in three sizes, by graphics-card memory:

- **8 GB** (small): SDXL. Most gaming PCs from the last 5 years. Can't write words in pictures: add text in any editor.
- **16 GB** (medium): Z-Image-Turbo + FLUX.2 klein 4B. Fast and sharp. Writes short words. Works from 12 GB, a bit slower.
- **24 GB** (large): Qwen-Image 2512 + Qwen-Image-Edit 2511. Best quality and the best words in pictures. Uses fp8 weights: an NVIDIA RTX card is best.

Every picture model allows commercial use. The 3D character maker uses Hunyuan3D, whose licence does not cover the EU, the UK
or South Korea: it is never bundled, and the helper shows that notice before you download it. Each workflow lists its models with the official link, size,
SHA-256 and licence in `<name>/<size>.manifest.json`.

## The easy way: ask your AI

With the free VTube Pro Helper on your computer and your AI connected to it, say for example:

> Set up the VTube Pro thumbnail workflow in ComfyUI

The helper shows every file it will download and its size. Nothing downloads until you press **Yes**. It downloads
from the official pages only, checks every file, and adds the workflow to ComfyUI's Workflows list.

## By hand

1. Open ComfyUI.
2. Drag the `<name>/<size>.workflow.json` file onto the ComfyUI window.
3. If ComfyUI says models are missing, let it download them (or use the links in the "Start here" note).
4. Change the green boxes, then press **Run**.

`<name>/<size>.api.json` is the same workflow in API format, for scripts and apps.

## Workflows

| Workflow | What it makes | Sizes |
|---|---|---|
| `character-3d` | A picture of your character (whole body, facing front) turned into a 3D model on your own computer. The model is plain grey: it has the shape, not the colours. | small, medium, large |
| `avatar-texture-repaint` | Your model's texture sheet repainted in the colours and materials of a character picture. Every seam stays where it is. | small, medium, large |
| `avatar-skin-variant` | A recolour or restyle of a texture (a winter jacket, a red version) that still fits your model. | small, medium, large |
| `character-concept-sheet` | Front, side and back views of an original character, to model from or to paint textures with. | small, medium, large |
| `room-seamless-tiles` | Square textures that repeat with no visible seam: wood floor, brick, carpet, tiles, fabric. | small, medium, large |
| `room-skybox-360` | A wrap-around sky or far backdrop (sunset city, space, forest) for outside your windows. | small, medium, large |
| `room-screen-posters` | Wall posters, shop signs, menu boards and banners with readable words. | small, medium, large |
| `decals-stickers` | Graffiti, stickers, patches and your own emblems for walls and costumes. | small, medium, large |
| `stream-thumbnail` | A 16:9 thumbnail: a generated background, a big title, and your avatar cut out on top. | small, medium, large |
| `stream-overlay` | A full-screen "Starting soon" or "Be right back" picture, or a panel background, in your style. | small, medium, large |
| `chat-emotes` | Little expressive faces of your character for Twitch, YouTube and Discord chat. | small, medium, large |

## Custom nodes

- ComfyUI_IPAdapter_plus: https://github.com/cubiq/ComfyUI_IPAdapter_plus at commit `a0f451a5113cf9becb0847b92884cb10cbdec0ef` (GPL-3.0 (the node code; it runs inside your ComfyUI, VTube Pro does not ship it)).
Everything else, background removal included, is built into ComfyUI.
