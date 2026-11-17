# AI_CONNECT: connect any AI to VTube Pro and build rooms with it

This is the one document for connecting an AI (Claude, ChatGPT, Grok, a local model, or anything else) to VTube Pro. It
is also the reference an AI follows to build or modify a room from start to finish. It does not repeat the full
contracts. Those stay in their own documents and are linked here:
- **docs/SCENES.md**: every room node and scene.json key.
- **docs/AI_CREATOR_GUIDE.md**: characters, costumes, rooms and review (sections 10 and 10.7 cover rooms).
- **docs/BLENDER_PLAYBOOK.md**: running Blender safely.

If you are an AI reading this: read "Build or modify a room" and "Creation package" first.

Any MCP client can read this document through `get_docs {topic:"connect"}` (or the older
`get_creator_guide {doc:"connect"}`) or the resource `vtube-pro://docs/AI_CONNECT.md`. `get_docs` with no arguments
lists every guide (including the artist guides **docs/ARTIST_AVATARS.md** and **docs/ARTIST_ENVIRONMENTS.md**) and the
house rules every AI follows; the full list of tools and resources is in docs/mcp.md. Every connection below (MCP,
the remote connector, the built-in host, the instruction pack) gets the same house rules from `server/aiKnowledge.ts`.

## 0. Start here: connect an AI in 3 steps

You don't need to know anything technical for this part. Every AI connects to VTube Pro **running on your own
computer**. That is on purpose: VTube Pro holds no AI account and no API key, and it never calls a cloud AI service.
Your own AI app (Claude, ChatGPT, Grok ...) talks to VTube Pro's tools, with its own login, in its own app. A free model
on your PC can answer inside VTube Pro.

**How to get there:** in the studio, click **AI connectors** (or Settings → **Connect an AI in 3 steps**). A page called
**Connect an AI** opens from VTube Pro on your PC (its address starts with `http://127.0.0.1:5191`). Pick the AI you use.
Every AI gets one page with three steps and a big **Test** button. When the test passes you see **"You're all set!"**.

| Your AI | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| **Claude Desktop** (Windows, Mac) | Get the Claude app | Tick "Yes, add VTube Pro", click **Add VTube Pro** (we keep a backup of Claude's settings) | Click **Test**, then quit Claude fully and open it again |
| **Claude Code** (terminal or code editor; Windows, Mac, Linux) | Get Claude Code | Tick "Yes", click **Add VTube Pro**. We back up `~/.claude.json`, then run Claude Code's own `claude mcp add --scope user` (or add the same entry ourselves when the `claude` program isn't found) | Click **Test**, then start a new Claude Code session (or type `/mcp`) |
| **ChatGPT Desktop** (the app, not the website) | Get the ChatGPT app | Tick "Yes", click **Add VTube Pro** | Click **Test**, then restart ChatGPT |
| **Codex** (OpenAI's terminal / editor agent) | Get Codex | Tick "Yes", click **Add VTube Pro** (the same `~/.codex/config.toml` as ChatGPT Desktop, so both see it) | Click **Test**, then start a new Codex session |
| **Grok Build** | Get Grok Build | Tick "Yes", click **Add VTube Pro** | Click **Test**, then start a new Grok Build session |
| **LM Studio** (0.3.17 or newer; Windows, Mac, Linux) | Get LM Studio (free, no account) | Tick "Yes", click **Add VTube Pro** (we keep a backup of LM Studio's `mcp.json`) | Click **Test**. Nothing to restart: LM Studio loads it by itself. Chat with a model that can use tools, and allow each tool when LM Studio asks |
| **A free model on your PC** (Ollama, LM Studio, llama.cpp …) | Install Ollama and download one model (the page has a Copy button) | Click **Find my model**, pick it, click **Use this one** | Click **Test** (your model says "OK") |
| **Grok Bot** or Grok on grok.com | Switch on the **internet bridge** | Click **Make my address**, then **Copy the address** | Paste it into Grok (Connectors → New Connector → Custom), click **Test** |

**Good to know (plain answers):**
- **Does VTube Pro need an AI key?** No. VTube Pro never asks for, stores or sends an AI key. Your AI app signs in to
  its own service by itself; VTube Pro only gives it tools. Pages from other websites can't read or change anything
  here (section 8).
- **Does it cost money?** VTube Pro is free. What your AI app costs is between you and its maker. Models on your own PC
  are free.
- **Which one should I pick?** Already use Claude, ChatGPT or Grok Build in their app? Use that. Want free and private?
  A model on your PC.
- **LM Studio works two ways.** Its own chat can use VTube Pro's tools (the LM Studio row). Or the chat inside VTube Pro
  can use LM Studio's model (A free model on your PC: switch LM Studio's server on).
- **ChatGPT in a web browser** can't start programs on your PC. Use the ChatGPT **desktop app** or the internet bridge.
- **Grok Bot** works on a computer in the cloud, not on your PC, so it can't start VTube Pro by itself. The internet
  bridge lets it look at your avatars and rooms, check them and send room plans to your Inbox. It can **never** run
  Blender, change your stream or edit your library. Switch the bridge off when you are done. **Grok Build** on your PC
  is easier and can do more.
- **Big changes always wait for you.** Running Blender or changing what's on your stream needs your OK on VTube Pro's
  AI page on your PC, whichever AI asks.
- **Chat from the studio:** with a model on your PC, click **Ask your AI** (Home → Chat & donations) to chat right in
  the studio.

**Do it yourself instead (Claude Code / Codex):** each page has "I'd rather do it myself" with the exact command:
- Claude Code: `claude mcp add --env "VTP_MCP_CLIENT=Claude Code" --transport stdio --scope user vtube-pro -- <node> <VTube Pro's mcp entry>`.
  `--env` comes first because it takes several values. For one project only, the page also shows a `.mcp.json` to save in
  that project's folder (Claude Code's "project" scope).
- Codex: `codex mcp add vtube-pro --env VTP_MCP_CLIENT=Codex -- <node> <VTube Pro's mcp entry>`, or the
  `[mcp_servers.vtube-pro]` block for `~/.codex/config.toml` (with `startup_timeout_sec = 30` and `tool_timeout_sec = 900`, so a call can wait for your OK and a Blender build).

**Create asks first (lane create-gating).** The studio's **Create** area opens with **How do you want to create?**:
*Use an AI app I already have* (the apps above, through this same connection), *Use my own
computer* (ComfyUI and / or a model on your PC, see `docs/LOCAL_AI.md`), or *Do it by hand* (Blender guides). Each choice
shows what it needs and a **Connect** button that opens the matching 3-step page (in the side drawer). Nothing to describe or create appears until one of them works; the
page re-checks every few seconds. With an AI app linked, Create shows **Your AI is ready** with copyable prompts to paste
into that app (for example "Make me a cozy cafe room for VTube Pro") and the progress of whatever your AI is making
(`GET /api/jobs`). The gate is `shared/createGate.ts` (tested by `tools/create_gate_unit.ts`).

**If a test fails**, the page says what went wrong and the one thing to do next, with **Try again** and **Get help**.
The most common fixes: start your model app (in LM Studio switch "Start server" on); quit and reopen Claude / ChatGPT
after adding VTube Pro.

**For AIs and developers:** what every connected AI gets is the same everywhere: the house rules, the room contract
(`get_docs {topic:"environments"}`), the avatar guidelines (`get_docs {topic:"avatars"}`) and the check tools
(`validate_room`, `validate_creation_package`, and `check_room` / `check_avatar` when installed). MCP clients get them
through `get_docs` and the `vtube-pro://` resources; a model on this PC gets them in VTube Pro's system prompt
(`server/aiAgent.ts` `knowledgeBlock()`). What other web pages may do is in section 8.

## 1. Which way to connect (quick start)

The user opens **Settings → AI connectors**. Beginners land on the 3-step pages at `http://127.0.0.1:5191/aiconnect/connect`
(section 0); everything below is on the full page `http://127.0.0.1:5191/aiconnect`, with copy buttons and status checks.
Both pages exist only on this PC (a request from another website gets `403 local-only`).

| Client | How | What it can do |
|---|---|---|
| **Claude Desktop** | Click **Add to Claude Desktop**. The page writes a `vtube-pro` entry into `claude_desktop_config.json` and backs up the old file first. Then quit Claude Desktop from the tray and reopen it. | All tools (local stdio MCP). Gated tools wait for an Approve click. |
| **Claude Code** | Inside the repo it already works (`.mcp.json`). Anywhere else, run the `claude mcp add --scope user vtube-pro -- node …\tsx\dist\cli.mjs …\server\mcp.ts` line shown on the page. | All tools. |
| **Grok Build (CLI)** | `grok mcp add vtube-pro -- node …` (line on the page), or `[mcp_servers.vtube-pro]` in `~/.grok/config.toml`. Inside the repo it also reads `.mcp.json`. | All tools (local stdio). |
| **LM Studio** (0.3.17+) | The 3-step page writes a `vtube-pro` entry (Cursor's `mcpServers` notation) into `~/.lmstudio/mcp.json` (Windows `%USERPROFILE%\.lmstudio\mcp.json`), backing it up first. LM Studio loads it as soon as the file is saved (no restart) and asks before each tool call. By hand: Program tab → Install → Edit mcp.json, paste the snippet from the page. | All tools (local stdio). Pick a model that supports tool use. |
| **Cursor** | The page writes a `vtube-pro` entry (`"type": "stdio"`) into `~/.cursor/mcp.json` (every project), backing it up first. Cursor Settings → MCP shows it. | All tools (local stdio). |
| **VS Code** (Copilot agent mode) | The page writes it into the user profile's `mcp.json` under `"servers"` (Windows `%APPDATA%\Code\User\mcp.json`, macOS `~/Library/Application Support/Code/User/mcp.json`, Linux `~/.config/Code/User/mcp.json`), backing it up first. A file with comments is left alone (copy box instead). | All tools (local stdio). |
| **Gemini CLI** | The page writes `mcpServers.vtube-pro` (with a 15 min `timeout`) into `~/.gemini/settings.json`, keeping every other setting; same as `gemini mcp add -s user vtube-pro …`. | All tools (local stdio). |
| **Antigravity** (Google; app + `agy` CLI) | The page writes `mcpServers.vtube-pro` into `~/.gemini/config/mcp_config.json` (Antigravity 2.x: one file for every surface; an older `~/.gemini/antigravity/mcp_config.json` that is now a link to it is followed, never replaced), backing it up first. Then MCP Servers > Manage > Refresh, or restart Antigravity. | All tools (local stdio). |
| **ChatGPT Desktop** (the app) | The 3-step page writes `[mcp_servers.vtube-pro]` (command, args, env, `startup_timeout_sec = 30`, `tool_timeout_sec = 900`) into `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), backing it up first: the ChatGPT desktop app, Codex CLI and the IDE extension share that MCP config and run local STDIO servers. Same as `codex mcp add vtube-pro -- node …`. | All tools (local stdio). |
| **ChatGPT** (web, developer mode) | ChatGPT on the web only accepts a remote HTTPS MCP URL; local stdio does not work there. Two options: (a) the **Remote connector** plus a tunnel (section 4), or (b) the **Instruction pack** (section 5), which needs no setup. | (a) Safe tools only: read, render, validate, and submitting packages to the inbox. (b) Writes a package that you paste back into VTube Pro. |
| **grok.com / Grok apps** | The **Custom** connector at grok.com/connectors also needs a public URL, so use the Remote connector plus a tunnel, or the Instruction pack. | Same as ChatGPT. |
| **Grok Bot** | Grok Bot runs on a persistent cloud computer (Cursor's cloud), not on the user's PC; its stdio MCP servers run on THAT computer, and its connectors come from the Grok / Cursor connector policy. So it cannot start `server/mcp.ts` here. Real path: the internet bridge (the Remote connector + a Cloudflare quick tunnel, started from the 3-step page) where Grok allows a custom MCP connector, or the Instruction pack. | Safe tools only (remote). |
| **Agent frameworks on this PC** (LangChain, OpenAI Agents SDK, LM Studio MCP …) | Streamable HTTP at `http://127.0.0.1:5191/mcp` with the header `Authorization: Bearer <local token>` (shown on the page). | All tools, the same gates. |
| **No app at all** (a model on this PC) | **Create with AI** on the page (section 6). | All tools, the same gates. |
| **Any other chat AI** | The **Instruction pack**. | Writes a package. |

The VTube Pro server must be running for any of these (START_HERE.bat or `npm run dev`).

## 2. Permissions (scopes) and the approval click

Every host uses the same table (`server/mcpScopes.ts`).

| Scope | Tools | Default |
|---|---|---|
| read | `get_docs`, `get_creator_guide`, `get_instruction_pack`, `status`, `list_avatars`, `get_avatar`, `list_costumes`, `list_rooms`, `get_job`, `wait_for_job`, `validate_room`, `check_room`, `room_checklist`, `validate_creation_package` | allow |
| render | `render_avatar` | allow |
| create | `generate_avatar`, `generate_room`, `submit_creation_package` (puts it in the inbox; nothing runs) | allow |
| library | `update_avatar`, `import_model`, `import_costume`, `autorig`, `import_room` (adds a room file as a new room, like "Add my room") | ask |
| live | `set_costume`, `send_command` | **always ask** (can be set to deny, never to allow) |
| python | `blender_run_python`, `install_creation_package` | **always ask** (can be set to deny, never to allow) |
| diag | `get_diagnostics`, `request_diagnostics` | allow locally, **never remote** |

An **ask** call waits until the user clicks *Approve once*, *Approve all … calls for 30 min (any arguments)* or *Deny* on the AI connectors page.
The page shows the full script or arguments. If the page is not open, VTube Pro opens it. AI apps cancel a tool call
after about 60 s (Claude Desktop, not configurable), so an MCP call waits at most 40 s: still waiting, it answers
`{"status":"waiting_for_ok"}` (not an error) and the request stays on the page; the AI calls the same tool again with
the same arguments and it runs once approved (the request is denied after 10 minutes without an answer). A refused call
returns an error that tells the AI not to retry. `wait_for_job` likewise waits at most 45 s per call.

## 3. Setup automation the page does for you

**"Set up AI creation"** (VTube Pro's `tools.html?view=ai-setup`, a card at the top of the Tools list; code
`server/aiSetup.ts`, `shared/blenderSetup.ts`, `src/tools/aiSetup.ts`) does Blender and every AI app in one flow:
- **Blender**: looks everywhere people really have it: the installer and winget (`%ProgramFiles%`, `%LOCALAPPDATA%\Programs`),
  Steam (and its other libraries from `libraryfolders.vdf`), Scoop, an extracted download (Downloads / Desktop / a drive
  root), installs on other drives (the uninstall registry's `InstallLocation`), the Microsoft Store copy (found, and
  explained: other programs are refused when they start it, so install the blender.org one beside it), macOS
  `/Applications` + `~/Applications` + Spotlight + a `.dmg` never dragged out, Linux Snap, Flatpak (its
  `exports/bin/org.blender.Blender`), distro packages, Nix and tarballs in `~/Applications`. Each copy runs `--version`;
  4.2 is the minimum, 5.1 is tested, newer is "not tested yet". The best copy is saved in `settings.blenderPath`, which
  the Blender bridge uses first. Missing: Windows `winget install -e --id BlenderFoundation.Blender` in a visible window
  or the blender.org page; macOS `brew install --cask blender` in Terminal or the page; Linux: per distro (Ubuntu Snap,
  Fedora dnf, Arch pacman, openSUSE zypper, NixOS nix; read-only systems such as Bazzite, SteamOS, Fedora Atomic and
  openSUSE Aeon get Flatpak `--user` or the official tarball, never sudo), copy-only. While an install runs the page
  looks every 5 s and saves Blender as soon as it appears. The **Blender check** runs `blender/selftest.py` headless at
  low priority through the real bridge (cube → glTF into VTube Pro's cache folder).
- **AI apps**: Claude Desktop, Claude Code, ChatGPT Desktop, Codex, Grok Build, LM Studio, Cursor, VS Code, Gemini CLI.
  "Add VTube Pro" first shows the file, what changes (create / add / update / same), the exact entry and the names of
  the other servers that stay; after the tick it backs the file up (`<file>.vtp-backup-<time>`), merges (the same
  function made the preview), then starts the server exactly as the file says and does `initialize`, `tools/list` and
  the read-only `status` call (so it also proves the server reaches VTube Pro and sees Blender). **Backups** restores
  one (the current file is backed up first). **Copy the settings** is the do-it-yourself box. A damaged / commented
  JSON file is never written.
- **The launch** written into the apps: `<node> node_modules/tsx/dist/cli.mjs server/mcp.ts` (a Homebrew node is written as
  its stable `opt/` link), and `VTP_PORT` travels in the entry when VTube Pro is not on 5191. `node … --self-test`
  prints one `VTP_MCP_SELFTEST {...}` line (tools, server reached, Blender) for support.
- Unit tests: `npx tsx tools/ai_setup_unit.ts`; the page in a private muted browser: `tools/ai_setup_e2e.mjs`.

The older 3-step pages (below) still do the same per app:
- **Blender**: detected like everywhere else in the app (`server/blender.ts`). If it is missing, *Install Blender* opens
  a visible `winget install -e --id BlenderFoundation.Blender` window, where the user answers the prompts. A download link
  is also shown.
- **Claude Desktop**: finds `%APPDATA%\Claude\claude_desktop_config.json`. For Microsoft Store installs it uses
  `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\…`. On macOS it uses
  `~/Library/Application Support/Claude/`. The page says whether the entry is already there. The entry starts
  `node <repo>\node_modules\tsx\dist\cli.mjs <repo>\server\mcp.ts` with absolute paths, so no working directory is needed.
- **Ollama / LM Studio / ComfyUI**: the page checks `127.0.0.1:11434`, `:1234` and the ComfyUI URL from Settings
  (default `:8188`). It lists the installed models and flags the ones without tool calling.
- **Validation**: every package and every built room goes through `tools/aiconnect_package.py`. Each problem comes with its fix.

### 3.1 "Connect your AI" and "Make your AI better" (lane aiskills, beta.12)

`/aiconnect/connect` is THE connect page. Its home view (`server/connectHome.ts`) shows, top to bottom:
- **The recommended model.** The agreed advice is kept as data (`shared/aiAddons.ts` `MODEL_ADVICE`) and has a "Why?"
  with its sources and the date it was checked.
- **"On this computer".** The AI apps found here, each with one button: **Connect**, **Restart, then test**, or
  **Copy the first message**. The first message tells the AI to call `get_instruction_pack` / `get_docs` first.
- **"Other ways".** Grok Bot through the bridge, a free model on this PC, and ComfyUI as the picture maker
  every connected AI can use. The free-model card carries the honest note and a **Can it use tools?** check
  (`POST /api/ai-addons/local-tools`).
- **"Make your AI better".** The add-ons for the chosen app.

The per-app 3-step pages and the full `/aiconnect` page are unchanged. The full page and the Blender checks are linked
as "Advanced".

Add-ons come from ONE catalog, `shared/aiAddons.ts`; the to3d lane reads its Blender entries from there. The server
half is `server/aiAddons.ts`, at `/api/ai-addons/*`, local only. Nothing installs without a tick on the add-on's own
consent sheet. After the tick, the page asks `POST /api/ai-addons/consent` for a one-time token (issued only on a
click, which sends `x-vtp-user-action: 1`, and only to VTube Pro's own page, never another port or another website).
The token is tied to that action, add-on, apps and page, lasts 2 minutes and works once. Every install or remove call
needs it. Every app config is backed up before a write, other servers are kept, and a server VTube Pro didn't
add (it carries no `VTP_ADDON` tag) is never changed or removed.

The add-ons:
- **VTube Pro Creator skill.**
  - One Agent Skills folder (`shared/creatorSkill.ts`), written with an ownership marker to:
    - `~/.claude/skills` (Claude Code);
    - `~/.agents/skills` (ChatGPT desktop + Codex);
    - `~/.grok/skills` (Grok Build);
    - `~/.gemini/skills` (Antigravity / Gemini CLI).
  - Claude Desktop gets a zip to upload in Customize > Skills (with Code execution on).
- **MCP for Blender 2.1.9 (the default).**
  - Pinned, with an absolute `uvx` path, `DISABLE_TELEMETRY=true` and `BLENDER_MCP_SAFE_MODE=1`.
  - Its Blender add-on is installed by its own pinned `install-addon` command.
  - Its 3D generators are off-limits in our skill.
- **Blender Lab MCP (advanced).** Blender's warning is quoted on the consent sheet. Its `.mcpb` comes from Blender's
  releases page, is checked against its SHA-256, and is opened with Claude Desktop.
- **GIMP + GIMP MCP.** Recommended when Photoshop isn't installed: "GIMP is a free, open-source alternative to
  Photoshop".
  - VTube Pro downloads `maorcc/gimp-mcp` at a reviewed commit from GitHub and checks every file's SHA-256 before
    writing it.
  - It copies the plug-in into GIMP's profile, runs `uv sync --frozen`, then adds the `gimp` server.
  - The user starts it in GIMP with Tools > MCP > Start MCP Server.
- **Optional, links or copy commands only:** Adobe for creativity (shown by default when Photoshop is found), the
  ComfyUI MCP, Frontend Design, Playwright, OpenAI's Game Studio, built-in image making and the VRM
  add-on.

GIMP and uv are also in the Tools list (winget `GIMP.GIMP.3`, `astral-sh.uv`). AIs ask `ai_addons_status` (read, not
remote) what is ready.

Tests: `npx tsx tools/ai_addons_unit.ts`. The page runs in a private muted browser with
`node tools/ai_addons_e2e.mjs --out <dir>`.

## 4. Remote connector (ChatGPT, grok.com): optional, off by default
1. Switch **Remote connector** on in the page. This creates a long random token.
2. Start the listener with `npx tsx server/mcpRemote.ts`. It is its own process on `127.0.0.1:5193`. The app server and
   its loopback guard (`server/localGuard.ts`) are untouched.
3. Start a tunnel yourself: `cloudflared tunnel --url http://127.0.0.1:5193` or `ngrok http 5193`.
4. Connector URL: `https://<tunnel-host>/t/<token>/mcp`. Use authentication "none", because the token is in the path.
   Clients that can send a header can use `https://<tunnel-host>/mcp` with
   `Authorization: Bearer <token>` instead.
   - **ChatGPT**: Settings → Security and login → Developer mode on. Then Plugins/Connectors → **+** and paste the URL.
     Available on the web where ChatGPT offers developer mode.
   - **grok.com**: grok.com/connectors → New Connector → Custom, then paste the URL.

Only these tools are exposed remotely: read, render, validate and `submit_creation_package`. Blender Python, live,
library and diagnostics tools are never exposed. Anyone with the full URL can read your avatar list and fill your
inbox, so keep it private and switch it off when you are done. Quick tunnel URLs change each time the tunnel restarts.

## 5. Instruction pack + import (works with ANY AI, no connection)
1. On the page, click **Copy instruction pack**. The pack is `GET /api/aiconnect/pack`: the house rules, the sections
   "Instruction pack", "Creation package" and "Build or modify a room" from this document, the room contract from
   docs/ARTIST_ENVIRONMENTS.md, plus the two worked-example scripts.
2. Paste the pack into any AI together with your request ("a cosy neon ramen bar with 4 stools").
3. The AI replies with ONE JSON creation package. Paste it into the page, click **Validate** and fix anything it
   reports, then click **Build + install**.
4. VTube Pro stages the package and paints any `comfy` textures locally. It then runs the build script in headless
   Blender (low priority), writes scene.json, validates the room and installs it into `assets/scenes/<id>/` one file at
   a time. A modified room is backed up to `cache/aiconnect/backups/` first. Then open Scene tab → Room (use Rescan if
   the room is not listed).

Packages sent by connected AIs (`submit_creation_package`) land in the **Inbox** on the same page, with Review and
Build buttons.

## 6. No app? Use VTube Pro's built-in AI host ("Create with AI")
VTube Pro runs the conversation itself (`server/aiAgent.ts`) with a model that runs **on this PC**. It works with any
model server that speaks the OpenAI chat-completions API on a loopback address. VTube Pro refuses any other address: the
built-in host never talks to the internet, and it needs no account and no key.

| Server | Base URL (default) |
|---|---|
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| llama.cpp server / vLLM | `http://127.0.0.1:8080/v1` |
| A model on this PC (the one you picked in **Connect an AI → A model on this PC**) | your `http://127.0.0.1:...` address |

- The model gets the house rules and the room and avatar contracts as its system context, is told to read
  `get_docs {topic:"avatars"}` / `{topic:"environments"}` before building, and gets the same tool table as MCP, with
  the same scopes and approval clicks. Tool results, renders and token counts show in the chat.
- **JSON-plan mode**: local models without native tool calling answer with `{"tool": "...", "args": {...}}` or
  `{"final": "..."}` instead. VTube Pro picks this mode automatically for local models outside the known tool-calling
  families (Qwen2.5/3, Llama 3.1+, Mistral, Hermes, …). It also switches to it when a server rejects `tools`.
- Models this size are often too small to build avatars and rooms well. For the strongest results use your own AI app
  (sections 0 and 1).

## 7. Local setup (no cloud, no keys)
| What | Official download | Notes |
|---|---|---|
| Ollama | https://ollama.com/download | then `ollama pull <the model /local-ai recommends>` |
| LM Studio | https://lmstudio.ai/download | load a Qwen2.5 Instruct model, start the server (port 1234) |
| ComfyUI | https://www.comfy.org/download · https://github.com/comfyanonymous/ComfyUI | port 8188 |
| SDXL base 1.0 (texture model, free) | https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0 (`sd_xl_base_1.0.safetensors` → `ComfyUI/models/checkpoints/`) | used by `tools/comfy/vtp_texture_sdxl.json` |
| Blender 5.x | https://www.blender.org/download/ | or the page's winget button |

**Which model?** It depends on your graphics card and changes every few months, so it lives in one place:
**docs/LOCAL_AI.md** and VTube Pro's **Local AI** page (`http://127.0.0.1:5191/local-ai`). It asks first, checks
the PC locally and recommends a chat model + a ComfyUI setup with official download links. Leave 2–3 GB of VRAM free
for VTube Pro's own tracking. Then connect the model in **Connect an AI → A model on this PC** (section 0).

SDXL in ComfyUI needs about 8 GB, and it runs one texture at a time. Don't run a big LLM and SDXL together on an 8–12 GB card.

**The end-to-end local workflow:**
1. Describe a room in **Create with AI** with Ollama and a Qwen model.
2. The model plans the room with this guide and writes a creation package. Its textures use `"source": "comfy"` with a prompt.
3. `validate_creation_package` runs, and the model fixes what it reports.
4. `install_creation_package` asks for your click. ComfyUI then paints the textures into `VTP_ASSETS`, Blender builds the
   room, the room is validated and installed.
5. Preview it: Scene tab → Room, or `output.html?sceneTest=<id>`.

More example workflows coming soon.

**Setup instructions for a local AI.** Give this block to a local agent that can run commands:
```text
Set up VTube Pro's local AI path on this Windows PC. Ask me before every install or download.
1. Install Ollama from https://ollama.com/download (or: winget install -e --id Ollama.Ollama). Check: http://127.0.0.1:11434/api/tags answers.
2. Pick the model that fits this PC from http://127.0.0.1:5191/local-ai (or docs/LOCAL_AI.md). Run: ollama pull <that model>.
3. Optional textures: install ComfyUI Desktop from https://www.comfy.org/download, put sd_xl_base_1.0.safetensors from
   https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0 into ComfyUI/models/checkpoints, start it (port 8188),
   and set VTube Pro Settings -> ComfyUI URL to http://127.0.0.1:8188. Test with tools/comfy/vtp_texture_sdxl.json.
4. Blender: install from https://www.blender.org/download/ (or winget install -e --id BlenderFoundation.Blender).
5. Open http://127.0.0.1:5191/aiconnect and press Re-check: Ollama, ComfyUI and Blender must show as running/installed.
6. In "Create with AI" choose Ollama and the model you pulled. Never change my avatar or scene while I am live.
```

## 8. What other websites may do: nothing

The AI pages and routes answer only on this PC. A request that comes from another website (any non-loopback origin) gets
`403 local-only` for any change: `POST|DELETE /api/ai/setup/:id`, `POST /api/ai/local/use`, `/api/ai/bridge*`,
`/aiconnect*`, `/api/aiconnect/*` and `/mcp` (`server/localGuard.ts`; there is no CORS answer, so a page also cannot
read one). Approvals for Blender Python and live changes are answered only on this PC.

## Instruction pack
You are building content for **VTube Pro**, a VTuber studio that renders rooms with three.js in a browser and in OBS.
A room is a folder `assets/scenes/<id>/` containing `scene.glb` (glTF binary), `scene.json`, and optionally
`preview.png` and `thumb.png`. You never write files yourself. You return ONE **creation package**: JSON holding a
Blender Python build script that VTube Pro runs locally. Units are metres. glTF is +Y up. The stage front faces glTF
+Z, which is Blender −Y. Keep it original: no game files, logos or copyrighted textures.

## Creation package
```json
{
  "format": "vtube-pro.creation/1",
  "kind": "room",
  "action": "create",                 // or "modify" (changes an installed room; it is backed up first)
  "id": "neon_ramen_bar",             // lowercase a-z 0-9 _, 2-48 chars = the folder name
  "scene": { "name": "Neon Ramen Bar", "model": "scene.glb", "modes": ["talk","react"], "defaultCamera": "CAM_WIDE",
             "ambience": { "background": "#120e16", "fog": "#120e16", "fogNear": 8, "fogFar": 24, "exposure": 0.85 },
             "avatarHeight": 1.5, "lights": { "programs": ["steady","show"] } },
  "build": { "script": "<complete bpy source>" },
  "assets": [ { "path": "textures/wood.png", "source": "comfy", "prompt": "dark stained wood planks" },
              { "path": "textures/logo.png", "source": "inline", "dataBase64": "<png base64>" } ],
  "notes": "free text for the user"
}
```
- **create**: `scene` is the full scene.json. The installer adds `id` and keeps `model` = `scene.glb`.
- **modify**: `scene` is a *patch* that is deep-merged into the existing scene.json, so hand-added keys survive.
  The script gets `VTP_BASE_GLB` (the installed scene.glb) to import and change.
- The **build script** runs as `blender -b --factory-startup --python build.py` with these environment variables:
  - `VTP_OUT`: export `VTP_OUT/scene.glb` here. It may also write `preview.png` / `thumb.png` here.
  - `VTP_ASSETS`: the package assets, e.g. `VTP_ASSETS/textures/wood.png`.
  - `VTP_ROOM_ID`
  - `VTP_BASE_GLB`: modify only.

  Print `STEP <what>` lines (they show in the job log) and end with `ROOM_OK`.
- **Script policy** (checked before the approval prompt). Allowed: `bpy`, `bmesh`, `mathutils`, `math`, `random`,
  `json`, `os.path` and `os.environ`. Not allowed: `subprocess`, `socket`, `urllib`/`requests`/`http`, `ctypes`,
  `importlib`, `shutil`, `exec`/`eval`/`compile`/`__import__`, `os.system`/`remove`/`rename`, add-on installs and
  preference changes. Write only inside `VTP_OUT`. Assets are `inline` (base64) or `comfy` (painted locally by ComfyUI).
  Nothing is downloaded.
- Use `validate_creation_package` (or the page's Validate button) until it reports `ok: true`.

## Build or modify a room
This is the checklist the validator and the engine enforce. The full contract is in docs/SCENES.md and
docs/AI_CREATOR_GUIDE.md section 10.

**1. Scale and axes.** Metres. The floor is at z = 0 (Blender), which is glTF y = 0. Avatars are about 1.5 m tall
(`avatarHeight`). A typical room is 6–10 m wide, 5–8 m deep and 3–3.5 m high. Build the shell with an open front on
Blender −Y, the side the camera sees.

**2. Required and expected nodes.** Names must match exactly. Export with `export_extras=True` so custom properties
become glTF extras.

| Node | Required | Rule |
|---|---|---|
| `SPOT_01`…`SPOT_12` | at least 1 (aim for 5–12) | Empty, origin on the floor where the feet or seat go. Local −Y in Blender (glTF +Z) = the way the avatar faces, so turn them toward the camera. Extras: `pose` `"sit"`/`"stand"`. For sit: `seatHeight` (0.15–1.4, default 0.45) and `seatDepth`. Optional: `label`, `approach` (flat glTF points to route around furniture), `leavePathAt`, `sizes`. |
| `CAM_WIDE` | yes (= `defaultCamera`) | Blender camera, vertical fov about 35–40°, seeing every spot. |
| `SCREEN` + `CAM_REACT` | yes if `modes` has `react` | SCREEN: a 16:9 plane, UVs 0..1, facing the camera, `restOffsetY` extra. CAM_REACT frames it at about 80% of the width (vfov 35 → distance ≈ 1.12 × screen width). |
| `DOOR`, `DOOR_OUTSIDE`, `PATH_01…` | expected | DOOR origin = the hinge, the leaf swings outward (`openAngle`). DOOR_OUTSIDE faces in. PATH_* leads from the door to the room centre. |
| `CAM_DOOR`, `SPOT_xx_CAM`, `CAM_*` | optional | Entrance follow cam, per-spot talk cams, extra presets. |
| `LIGHT_*` | expected | Fixtures with extras `group` (neon/sign/lamps/spots), `color` hex, `kind` spot/point/emissive. At most 0–4 real lights per graphics tier; everything else glows through `EMIT_<group>` materials. |
| `COLLIDE_*` | for furniture in walk lanes | Simple boxes (hidden). Walkers avoid them. |
| `FLOOR_*` | for stages and stairs | Hidden walkable surfaces. Walkers stand on the highest one under them. |
| `CHAT_MONITOR`, `CHAT_BOARD`, `CHAT_BUDDY`, `SCREEN_SOLO_xx` | optional | In-world chat and the solo screen (docs/SCENES.md). Keep them away from faces and screens. |

**3. Materials and textures.** Use Principled BSDF with base colour and roughness. Emissive materials are named
`EMIT_<group>`. Keep atlases at 2048² or less and tiling textures at 1024² or less, with PNG/JPEG in `textures/`.
Toon avatars look best in rooms with mid-dark walls and warm pools of light. Tune `ambience.exposure` (0.1–3) rather
than darkening the whole room.

**4. Budgets** (hard errors are marked ✖).
- ✖ 80,000 visible triangles or fewer.
- ✖ scene.glb of 25 MB or less.
- About 170–180 draw calls at most, so join static meshes that share a material.
- About 20–40 materials.

**5. Lighting states.** The engine turns room shadows off, so bake AO and gradients into vertex colours (`COLOR_0`) or
textures. The lighting states (preshow/show/react/brb/outro) drive `LIGHT_*` groups and `EMIT_*` materials
automatically (docs/SCENES.md "Lighting states"). Set `lights.programs` in scene.json.

**6. Collision and walking.** Keep a clear lane from DOOR_OUTSIDE along PATH_* to every spot. Furniture in the lane
gets a `COLLIDE_*` box, which is ignored when taller than 0.9 m. Spots behind counters or desks get `approach` points.

**7. Sightlines.** Nothing may block the SCREEN or any performer's face from CAM_WIDE, CAM_REACT or the talk cameras.
Check this from each camera.

**8. Preview and thumb.** `preview.png` is 1280×720 from CAM_WIDE and `thumb.png` is 480×270. If the build script does
not render them, the validator warns. Take them later in the app (docs/BLENDER_PLAYBOOK.md section 11.4).

**9. Validate.** Run `validate_creation_package` before building and `validate_room {roomId}` after. Locally, run
`python tools/aiconnect_package.py room assets/scenes/<id>`. Fix every ERROR. Warnings are quality items.

**10. Common failures.**

| Symptom | Cause | Fix |
|---|---|---|
| Spot `pose` missing | export without `export_extras=True` | Pass `export_extras=True` |
| Avatars face the wall | spot rotated the wrong way | Blender −Y is the facing direction. yaw 0 = toward the camera |
| No room shown / default camera error | camera not named `CAM_WIDE` or not exported | Pass `export_cameras=True`; name the camera *object* |
| Screen stretched or upside down | plane not 16:9 or UVs rotated | 16:9 plane, rotated 90° about X, transforms applied |
| Everything floats or sinks | floor not at z = 0, or `seatHeight` wrong | Put the floor at 0 and measure the seat surface |
| Glow doesn't animate | material not named `EMIT_<group>` | Rename the material |
| Room too dark or washed out | real lights exported / exposure | `export_lights=False`; tune `ambience.exposure` |
| Build did not write scene.glb | wrong output path | `os.path.join(os.environ['VTP_OUT'], 'scene.glb')` |
| Validation over budget | subdivided or duplicated props | Decimate, join, fewer bevel segments |

**11. Worked example: create.** `tools/aiconnect_examples/neon_ramen_bar.package.json` is a complete, validated
package. Its script is `tools/aiconnect_examples/build_ramen_bar.py`, which the instruction pack includes in full. It
builds a shell with an open front and a door on the left with a hallway, then DOOR / DOOR_OUTSIDE / PATH_01-03. It adds
a counter (COLLIDE_Counter) with 4 stools as SPOT_01-04 (sit, seatHeight 0.7, `approach` around the counter's end) and a
booth as SPOT_05-07 (sit, turned 60° toward the room). It also adds a SCREEN over the counter, LIGHT_NEON_01 /
LIGHT_SIGN_01 (emissive) plus LIGHT_LAMP_01 (point), and CAM_WIDE / CAM_REACT / CAM_DOOR. It exports with the flags
above and prints `ROOM_OK`.

**12. Worked example: modify.** `tools/aiconnect_examples/neon_ramen_bar.modify.package.json` (script
`modify_add_plant.py`) imports `VTP_BASE_GLB`, adds a potted plant and a second neon strip (`LIGHT_NEON_02`, material
`EMIT_neon`), and re-exports. Its `scene` patch raises `exposure` to 0.95 and adds `beatPulse` to the light programs.
The old room is backed up before the install. To edit a room that has a Blender source (`assets/scenes/<id>/blender/`),
prefer changing that script and rebuilding (docs/BLENDER_PLAYBOOK.md section 6).

## Sources (checked 2026-10-01 for section 0 and the 3-step pages; the rest 2026-09-28)
- Claude Desktop config + logs (`%APPDATA%\Claude\claude_desktop_config.json`, `~/Library/Application Support/Claude/…`, "available for macOS and Windows", logs `mcp-server-<name>.log`): https://modelcontextprotocol.io/docs/develop/connect-local-servers
- ChatGPT desktop app MCP (STDIO + Streamable HTTP, shares the Codex MCP config `~/.codex/config.toml` `[mcp_servers.<name>]` command / args / env / `startup_timeout_sec`): https://learn.chatgpt.com/docs/extend/mcp · https://learn.chatgpt.com/docs/extend/mcp?surface=cli · https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex
- Grok Bot (a persistent cloud computer; desktop / mobile apps are thin clients; connectors follow the Cursor connector policy; stdio servers run on the Bot's computer): https://docs.x.ai/grok-bot · https://docs.x.ai/grok-bot/teams-and-enterprises
- grok.com custom connectors must be reachable from the public internet (no localhost / private networks); quick tunnels: https://docs.x.ai/grok/connectors/custom-mcp-tunneling
- Claude Desktop local MCP + config locations: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- Claude Desktop extensions (.mcpb): https://www.anthropic.com/engineering/desktop-extensions (not shipped yet; the config writer is the one-click path)
- ChatGPT developer mode (web; SSE + streaming HTTP; OAuth / no auth / mixed; write confirmations): https://developers.openai.com/api/docs/guides/developer-mode · https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt · https://developers.openai.com/plugins/deploy/connect-chatgpt
- Grok Build MCP (`grok mcp add`, `~/.grok/config.toml`, reads `.mcp.json`): https://docs.x.ai/build/features/mcp-servers
- LM Studio MCP (checked 2026-10-02; 0.3.17+): `~/.lmstudio/mcp.json` (Windows `%USERPROFILE%/.lmstudio/mcp.json`) in Cursor's `mcpServers` notation, loaded automatically when saved, each tool call confirmed (once / always): https://lmstudio.ai/docs/app/mcp · https://lmstudio.ai/blog/mcp
- Claude Code MCP (checked 2026-10-01): `claude mcp add [options] <name> -- <command> [args...]`, `--transport stdio`, `--env KEY=value`, `--scope local | project | user`; local + user scope live in `~/.claude.json`, project scope in `.mcp.json` (`{"mcpServers":{...}}`); `claude mcp list / get / remove / add-json`: https://code.claude.com/docs/en/mcp
- `~/.claude.json` is a file "that it writes for itself" holding MCP server configurations (so we prefer the CLI and always back it up): https://code.claude.com/docs/en/settings
- Codex MCP (checked 2026-10-01): `codex mcp add <server-name> --env VAR1=VALUE1 -- <stdio server-command>`; `~/.codex/config.toml` `[mcp_servers.<name>]` `command`, `args`, `env`, `cwd`, `startup_timeout_sec` (default 10), `tool_timeout_sec`, `enabled`; "The ChatGPT desktop app, Codex CLI, and IDE extension ... share MCP configuration": https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- grok.com custom connectors + tunnelling: https://docs.x.ai/grok/connectors · https://docs.x.ai/grok/connectors/custom-mcp-tunneling
- Cursor MCP (checked 2026-10-06): "Create `~/.cursor/mcp.json` in your home directory for tools available everywhere", `mcpServers` with `type` / `command` / `args` / `env`: https://cursor.com/docs/context/mcp
- VS Code MCP (checked 2026-10-06): "MCP: Open User Configuration" opens the user profile's `mcp.json`; top-level `"servers"`, stdio entries `type` / `command` / `args` / `env`; `code --add-mcp`: https://code.visualstudio.com/docs/copilot/customization/mcp-servers · https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- Gemini CLI MCP (checked 2026-10-06): user scope `~/.gemini/settings.json` `mcpServers.<name>` `command` / `args` / `env` / `cwd` / `timeout` (default 600,000 ms); `gemini mcp add -s user <name> <command> [args...]`: https://geminicli.com/docs/tools/mcp-server/
- Microsoft Store Blender started by another program fails with "Access is denied" (`C:\Program Files\WindowsApps\BlenderFoundation.Blender_<ver>_x64__ppwjx1n5r4v9t\Blender\blender.exe`): https://github.com/BlenderKit/BlenderKit/issues/1143
