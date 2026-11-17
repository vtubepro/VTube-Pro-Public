# Local AI: which model fits my computer?

VTube Pro can recommend a free AI that runs on your own computer: a **chat model** (through Ollama or
LM Studio) and a **picture setup** (ComfyUI), with official download links and step-by-step help.

## For streamers

1. Open VTube Pro's **Local AI** page, **Find the best AI that runs on your own computer**. Any of these open it:
   - **Create** → **Use my own computer** → **Set it up** next to ComfyUI;
   - VTube Pro's **Connect an AI** page → **A model on this PC** → **Which model fits my PC?**.

   It opens only on the computer VTube Pro runs on (its address is <http://127.0.0.1:5191/local-ai>).
2. Read what it looks at, then click **Yes, scan my computer**. Or click **No thanks, I'll type in my details**.
   - It reads your graphics card (name and memory), RAM, processor, free disk space and system version.
   - It does **not** read your files, your name or serial numbers.
   - Nothing leaves your PC. The result stays in VTube Pro's memory and is forgotten when you close it, or when you
     click "Forget my scan".
3. Follow the steps under **Chat AI on your PC** and **Picture AI (ComfyUI)**. Use the Copy buttons, then click
   **Check again**. The page says you're all set when it finds the model or ComfyUI running.
   Then connect the model: [AI connections](AI_CONNECT.md), **A model on this PC**.
4. Optional: tick **Let your AI assistant use this**. AI assistants connected to VTube Pro then see a short summary
   (graphics card, its memory, RAM, system) and can suggest models and picture recipes that fit. It is off by default.
   If your assistant is a cloud service (Claude, ChatGPT, Grok), that summary goes to it.

The Local AI page never downloads anything. Want a picture recipe set up for you? Under **Things you can make**, press
**Set one up for me**. VTube Pro's [ComfyUI workflows](COMFYUI.md) page lists every file and its size first, and only
starts after you say yes there.
Every model shows its licence. The defaults only use models that allow commercial use. Make pictures when you are
**not live**: picture AI slows face tracking.

## For AIs (MCP / the built-in host)

- `local_ai_recommend {vramGB?, ramGB?, gpuVendor?, appleSilicon?, os?}`: a chat model + ComfyUI setup for the machine.
  - It uses the user's shared scan summary if they switched sharing on.
  - Otherwise it uses the facts you pass, or returns the tier table.
  - It never scans: to get a scan, ask the user to open the Local AI page.
- `comfy_workflows {task?, vramGB?}`: curated ComfyUI recipes for VTube Pro jobs (avatar textures and skins,
  character sheets, room tiles, 360 skies, posters with text, decals, thumbnails, overlays, emotes).
  - Each recipe lists the models (with licences), the custom nodes, the steps, the settings and the output size.
  - It also says how the result gets into VTube Pro (several are automated by `tools/ai_texture/*`).
- `install_comfy_workflow {workflow, tier}`: sets up one of the ready-made workflows in the user's ComfyUI. The user
  presses **Yes** on the page that opens; see [ComfyUI workflows](COMFYUI.md).
- Otherwise only suggest. Give the official links. Name the licence. GPU jobs only when the user is not live.

## For maintainers: updating the recommendations

All recommendations are data in `shared/localAi/`:

| File | What |
|---|---|
| `catalog.ts` | Dated `SOURCES`, `RUNNERS` (Ollama, LM Studio, llama.cpp), `LLM_MODELS`, `COMFY_SETUPS`, `IMAGE_MODELS`, `COMFY_NODES` |
| `recommend.ts` | The memory budget (the studio keeps ~3 GB while live), tiers and picks |
| `workflows.ts` | The curated ComfyUI recipes, best variant first, matched by `minVramGB` |

To change an entry:
1. Check its `page` and licence link.
2. Update the size / tag / licence, its `checked` date, `CATALOG_CHECKED` and the `SOURCES` row.
3. Run `npx tsx tools/local_ai_unit.ts`.
   - It covers the scan parsers (recorded Windows / macOS / Linux outputs) and the tier picks.
   - It checks that every id, source and node exists, and that workflows only use commercial-OK models.
   - It also covers the consent gate of the API.

Code:
- `server/hwScan.ts`: the read-only probes and the parsers.
- `server/routes/localAi.ts`: the API and the page route.
- `server/localAiPage.ts`: the page.
- `server/localAiTools.ts`: the MCP tools.
