# TTRPG mode — tabletop games at the table, with an AI or human Game Master

Every environment gets a table. The host presses **Tabletop game** (the 🎲 button at the bottom right of the studio, **Shift+P** in the mode bar; Shift+Y toggles the panel,
or the TTRPG entry in the stage-mode bar). The room-change curtain covers the switch, and the whole party walks into that
environment's TTRPG room and sits down. From there you get:
- 3D dice thrown into the tray (the same throw on every OBS page);
- a battle map with minis;
- initiative and HP;
- handouts and mood lighting;
- a Game Master: an AI model, a person at the table, or nobody (free play).

The GM appears as a talking d20, a spellbook, a skull lantern, a field radio, a holo orb, the room's own themed figure,
or any avatar from your library.

- Code: `src/ttrpg/*` (OBS engine, studio session, panel), `shared/ttrpg/*` (rules, dice, GM protocol, wire),
  `server/ttrpg/*` and `server/routes/ttrpg.ts` (AI calls, campaigns, VTT bridge), `tools/ttrpg/vtt/*` (bridge add-ons).
- Rooms: `assets/scenes/<env>_ttrpg/`, which follows the **TTRPG room contract** below. The generic **Game Room**
  (`assets/scenes/ttrpg_table`, `ttrpg.of = "*"`) is used by any environment that has no room of its own.

## 1. Playing
| Who | Where | What |
|---|---|---|
| Host | TTRPG drawer → **Table** | Open the table (5e-compatible or rules-light) or load a campaign. The same Table tab then has roll requests, the dice tray, the story log, and "What does your character do or say?" (type, or **Hold to talk**). |
| Everyone | **Character** | Make a character. 5e: ancestry + class build a level-1 sheet from the SRD with the standard array. Rules-light: four stats. You can also import a sheet: VTube Pro JSON, a Foundry VTT dnd5e actor export, or `{name, hp, ac, stats}`. Click a stat, skill or attack to roll it. HP ±, conditions, inventory. |
| Host / human GM | **Game master** | Choose who runs the game (AI / a person / nobody) and how the GM appears. The story: Start / Continue / Recap / Skip line / Stop / Redo / Undo / Pause, "approve every line", and the adventure seed + GM notes. Table tools: new scene (13 map types), add monsters (SRD 5.1 creatures or setting-free archetypes), mood, camera pins, initiative, NPC lines, handouts (text or an image). |
| Host | **Setup** | Rules, content rating, lines and veils; overlay toggles (captions, roll cards, initiative); the AI GM server, model, "Test connection", token budget and rate limit; voice and push-to-talk; the VTT bridge; campaigns; the SRD attribution. |
| Guests | their own TTRPG drawer | The same Table and Character tabs. Actions, rolls, sheet edits and the X-card go to the host. Guests hear the GM through their own browser voice (switch off in Game master → voice on the host, or per guest). Guests never need anything extra. |

**Dice**: `d20+5`, `2d6+3`, `d20 adv +4`, `d20 dis`, `4d6kh3`, `8d6`, `3d8+2d6-1`, `d100` / `d%`, plus sheet words
(`d20+dex`). The host rolls with `crypto.getRandomValues`. The roll is stamped on the table with a seed. Every OBS page
(the host's and every guest's) simulates the same Rapier throw from that seed into `DICE_TRAY`. The visual die is then
turned by one of its own symmetries so the rolled number ends up on top: the audience sees the real result, and it looks
identical everywhere (tested: identical final-pose hashes on two pages, and in Node vs the browser).

Throws queue about 2.8 s apart, so every roll lands and can be read. A natural 20 gets a gold burst and a NAT 20 card;
a natural 1 gets a red puff. GM secret rolls are never thrown on stream.

**Cameras** (the table's auto-director on each OBS page):
- **Who is speaking:** that performer's close-up.
  - First choice is the room's talk shot (`CAM_SEAT_xx`, or the room's validated talk shot).
  - It is checked against the other performers and the room. If their face (or a TV's screen) is hidden, or the shot
    is from across the room, the director picks the clearest angle from the front half, facing the table.
  - This matters for kibitzers standing behind the chairs and for walking-TV guests.
  - Why each close-up was chosen: `vtpOut.ttrpg.debug().director.seats`.
- **The AI GM's line:** the GM close-up, then the table or the map during long narration.
- **Every throw:** `CAM_DICE`. Crits push in.
- **A new handout:** `CAM_HANDOUT`, unless performers stand in front of it. Then it stays a card on the overlay.
- **Combat:** alternates between map and wide.
- **Otherwise:** `CAM_TABLE_WIDE`. When a performer's head fills the middle of it (a big avatar in the front row), the
  framing solver's group shot is used instead.
- **Clear view** for the table shots: see `CAM_*` in §4.
- **A dice tray that stands on the map** (part of the `MAP_SURFACE` under the tray): the map, grid and minis move to
  the biggest free part of the surface. `vtpOut.ttrpg.debug()` reports it with the aspect to put in scene.json.
- The host (or the AI's `camera` action) can pin a shot for a while.

Chat monitors and Sprocket keep working. With the stage-mode bar installed, its docked chat panels apply as well.

**On the stream (2D overlay)**: captions of the GM and NPC lines, revealed word by word; a roll card after each throw
(who, what, the dice, the total, success or fail vs the DC, crits); initiative order; the newest handout.

## 2. The AI Game Master
**The model** (Setup → AI Game Master). The GM is a model that runs **on this PC**. All calls are made by this PC's
server to a loopback address (`127.0.0.1` or `localhost`): VTube Pro refuses any other address, so nothing is sent to the
internet, and there is no account and no key.

| Server | Default address | Notes |
|---|---|---|
| Ollama | `http://127.0.0.1:11434/v1` | "Find models" lists what you pulled; "Test connection" asks the model for a short reply. |
| LM Studio | `http://127.0.0.1:1234/v1` | Start its server first (Developer tab). |
| llama.cpp server | `http://127.0.0.1:8080/v1` | |
| KoboldCpp | `http://127.0.0.1:5001/v1` | |
| Other OpenAI-compatible server on this PC | your `http://127.0.0.1:...` address | |

Free. Quality depends on the model (8B or bigger is recommended). Measured on this PC: `gemma4` 8B through Ollama, first
words after ≈ 4 s.

**What stays private**:
- The bridge pairing code (Setup → VTT bridge) is stored in `config/ttrpg.json`, which is git-ignored.
- It is never in `SceneState`, OBS pages, the bus, party messages, campaign saves or logs, and error text is scrubbed of it.
- A website open in your browser can't read the config, list models or drive the model: those endpoints need a
  loopback socket AND a loopback / no `Origin`.

**The loop**:
1. The host's studio sends the GM a structured view of the table. That includes the party's sheets, the monsters with
   their stat blocks and HP, the map (in words and cell coordinates), initiative, the adventure seed, the GM's notes and
   remembered facts, the last 24 lines of table talk, and "engine feedback" (what was wrong with its last actions).
2. The model answers in one provider-neutral format: narration, a line `[[ACTIONS]]`, then a JSON array.
3. The narration streams back sentence by sentence. The first sentence is spoken while the rest is still being written.
4. The actions are parsed leniently. The parser handles fences, trailing commas, smart quotes, unquoted keys, a cut-off
   array and JSON-only answers. Each object is parsed on its own. Actions are validated twice: their schema on the
   server, then against the real table on the host (names, cells, stat blocks). Rejects go back to the model on its next
   turn.

Actions: `request_roll`, `npc_roll`, `set_scene`, `spawn_token`, `move_token`, `remove_token`, `damage`, `heal`,
`condition`, `start_combat`, `next_turn`, `end_combat`, `npc_say`, `show_handout`, `mood_light`, `camera`, `give_item`,
`remember`, `award_luck`, `end_session` (+ aliases).

Player rolls wait for the players, who roll from their roll request cards (the host can "Roll for them" or "go on
without"). NPC rolls and initiative are rolled at once. When the dice have landed and the voice is done, the GM
narrates the result. After three automatic turns it waits for a player.

Players' actions within 1.5 s are batched into one GM turn. Long sessions stay in context: every ~50 lines, a short
separate call folds the story into the GM's notes (editable in Game master → Adventure). Campaigns save to
`saves/ttrpg/<id>.json` on the host every minute and when the table closes.

**Stream safety**:
- Content rating: Family / PG-13 / Mature. Mature still means no sexual content, no hate, no real people as targets.
- Lines and veils, written into every prompt.
- The **X-card**: anyone taps ✕ and the voice stops. The captions grey out, the log records it, and the GM retcons with
  one in-world line.
- "Approve every GM line": the host edits the line, unticks actions, "Speak it" / "Ask again" / "Throw away".
- Stop / Skip line / Redo / Undo / Pause.
- Rate limit: minimum gap and turns per minute.
- A per-session token budget, with a live meter (tokens in and out).

**Voice**:
- The browser's Web Speech voices are free and local. Pick a voice, rate and pitch. NPC lines shift pitch and rate.
- Optionally a voice server on this PC (Setup → Voice server): any OpenAI-compatible local TTS such as Kokoro-FastAPI
  (`/audio/speech` on a loopback address).

**The GM on stream** (Game master → voice → *Plays on*; the old *Both* choice is gone: it now meant the same as *On stream*):

| Setting | Where the GM is heard |
|---|---|
| **On stream** (host default) | Your viewers hear it: the studio plays the rendered line through the audio mixer (*Tabletop narrator*), and your stream picks it up from the studio window. The OBS page stays silent. |
| **Only me** (guest default) | Only you hear it: the rendered line plays on the Audio mixer's *Only me* output. Pick your headphones there: on *Same as the studio* a window or desktop capture in OBS hears it too. |
| Muted | No sound; captions and the mouth keep the pace. |

- **How On stream works:** each line is rendered on this PC's server, then the studio plays the file
  (`src/audio/mixer/showSounds.ts`) and this PC's OBS pages run it silently at the same moment, only to measure its
  loudness for the GM's mouth (`src/ttrpg/gm/voicePlayer.ts`; output pages are silent).
  - The render uses this PC's **Windows voices** (Microsoft David / Zira …, through a PowerShell worker; free and
    offline) or the voice server you set up on this PC.
  - Why not just the browser voice: its sound goes straight to the speakers and never passes through the page.
  - The next line is rendered while the current one plays.
- **In OBS:** nothing to set on the browser source: it never makes a sound. Your stream gets the GM from the studio
  window, like your guests. Several OBS pages can't double it.
- **When rendering fails** (no Windows voices, e.g. on macOS / Linux, or the voice server is down), the line is shown as a
  caption only (the GM's mouth and the pacing go on) and the panel says why. It is never spoken by the browser's own
  voice instead: a capture of the studio window would put it on stream.
- **Lip sync is unchanged:** the text visemes are re-timed to the real start and length of the audio (`sayAt`). The OBS
  page measures the line (silently) and feeds its loudness to the GM's mouth.
- **Guests:** On stream plays the GM in their own studio from their own server. The default stays *Only me*.

The GM's mouth on every OBS page is driven from the line's text: 17 visemes timed over the spoken duration, re-timed on
this PC's pages when the voice really starts (`sayAt`). A voice server's audio also streams its loudness (`mouth`).
Library-avatar GMs use the app's viseme path (`TrackingFrame.visemes`). Talking objects open their jaw, cover or grille,
and their glow follows.

**Push-to-talk**: the browser's speech recognition (Chrome / Edge send the audio to their vendor's service: the panel
says so), or a recording sent to a local whisper server on this PC.

## 3. The GM's look
| Style | What |
|---|---|
| `d20` | A floating d20 with cartoon eyes and a drawn mouth (no 3D teeth); spins on crits. |
| `tome` | A floating spellbook whose cover lifts like a jaw; the pages glow when it speaks. |
| `skull` | A skull lantern: the jaw drops, the eye sockets burn. |
| `radio` | A field radio (Tarkov / GZW): the speaker cone pulses, the dial needle shivers, the antenna blinks. |
| `orb` | A holo orb with spinning rings (sci-fi rooms). |
| `voice` | Just a glow over the GM chair. |
| `room:<id>` | The room's own themed figure or prop (scene.json `ttrpg.gmStyles`: a GLB with `GM_JAW` / mouth morphs / `EMIT_gm`, or a character). |
| `avatar:<id>` | Any avatar in THIS PC's library, loaded like the chat buddy (no costume, never saved). Guests' OBS pages that don't have it show the room default (model custody: avatars never cross the party link). |

Objects float at `GM_PROP` (or above the GM chair) and turn towards the camera. Characters sit in the GM chair (spot 12).
A human GM who sits in the GM chair replaces the AI's figure.

## 4. TTRPG room contract (v2.2) — for room builders
On top of docs/SCENES.md. The full text with examples is kept by the `ttrpgcore` workstream; this is the reference.

| Node | Meaning |
|---|---|
| `TABLE` | centre of the play surface (extras `w`, `d`, `shape`) |
| `MAP_SURFACE` | a plane mesh on the table, UVs 0..1, drawn like a glTF texture (top of image = map north); the engine draws the map on it and restores the authored material when no map is shown. extras `aspect`, `grid`, `look` (paper / felt / chalk / holo / crt / blueprint), `mini` |
| `SEAT_01`..`08` | seats = the room's spots (sit by default; SPOT_xx duplicates allowed, SPOT_xx wins). SEAT_01 = host |
| `GM_SEAT` | spot 12. **Kept for the GM:** automatic seating never puts a performer there while an AI GM runs the table, and puts the human GM there. Otherwise it is the last spot filled (`shared/ttrpg/state.ts gmSeatRule`). A host's own drag onto it still works. extras `pose` (`sit` / `stand`), `seatHeight`, `style_hint`, `gmHeight` |
| `SPOT_09`..`11` | kibitzers: standing spots for performers 9–11 (without them, a 10th performer waits off-set rather than taking the GM's chair) |
| `GM_PROP` | optional: where talking objects float (+Z towards the players) |
| `GM_SCREEN` | optional GM screen (extras `aiHide: true` hides it for an AI GM) |
| `DICE_TRAY` | tray floor centre (+Z = throw direction): extras `w`, `d`, `rim` / `wall`, `floorY`, `die` |
| `DICE_SPAWN` | optional throw origin |
| `HANDOUT` | optional vertical plane (UV 0..1) |
| `MINI_SHELF` | optional |
| `CAM_TABLE_TOP`, `CAM_TABLE_WIDE`, `CAM_GM`, `CAM_DICE`, `CAM_SEAT_01..08`, `CAM_HANDOUT` | the director's shots (CAM_SEAT_xx doubles as that seat's talk camera; CAM_GM gives the side the GM is filmed from — the distance follows the GM's size). **Clear view:** during the map, dice and handout shots, any room mesh between the camera and the surface is hidden for that shot only. That covers a pendant lamp, a banner, candles, books, and the talking-object GM; pieces touching them go too. Meshes wider than 2.2 m and performers are never hidden (`src/ttrpg/scene/clearShot.ts`, listed in `vtpOut.ttrpg.debug().cleared`). |
| `LIGHT_TABLE`, `LIGHT_MOOD_*` (+ `EMIT_mood*`) | key light; mood fixtures (extras `group: mood*`, optional `mood`) — the engine tints / brightens them per mood |

scene.json:
```json
"ttrpg": { "of": "<env id or *>", "theme": "…", "seats": 8, "persona": "…", "gmStyles": ["radio", {"id": "…", "kind": "object", "model": "gm/x.glb", "height": 0.35, "mouth": {"node": "GM_JAW", "open": 25, "glow": "EMIT_gm"}}],
           "map": { "look": "blueprint", "ink": "#d8f0ff", "paper": "#1d3a5c", "aspect": 1.84, "grid": 22 },
           "dice": { "style": "brass", "color": "#c9a24a", "ink": "#2a1a05", "size": 0.045 }, "seeds": ["factory_extract"] }
```
`map.aspect` (= MAP_SURFACE width / height) lets the host lay out the grid exactly like the pages draw it. Test your
room: `output.html?sceneTest=<room>&ttrpg=demo` (a self-running demo table; `&ttrpgGm=skull|tome|radio|orb|voice`) and
`vtpOut.ttrpg.debug()` (anchors found, contract problems, the current shot, the last throw).

## 5. VTT bridges ("Roll20 if people want that")
What is possible, honestly:
- **Roll20** has no public API for outside apps. Its Mod (API) scripts need a Pro subscription and run sandboxed on
  Roll20's servers, with no outbound connections.
- **Foundry VTT** modules and **Owlbear Rodeo** extensions run in the user's browser and CAN talk to a local socket.

So VTube Pro offers a local, read-only **bridge**: `ws://127.0.0.1:5191/ws/vtt`. It is off until the host enables it
(Setup → VTT bridge). Every client must present the pairing code shown there, messages are sanitised and rate-limited,
and nothing is ever sent back to the VTT. No login is automated. The add-ons are served by VTube Pro itself:

| VTT | Install | Mirrors | Limits |
|---|---|---|---|
| Foundry VTT (v11–v13) | Add-on Modules → Install Module → Manifest URL `http://127.0.0.1:5191/vtt/foundry/vtube-pro-bridge/module.json` (Foundry on the same PC). For a hosted Foundry, download `…/vtube-pro-bridge.zip` and install it by hand. Enable it in the world; Module Settings → pairing code. | public dice rolls (dice + total + flavour), chat, the combat tracker, token positions + HP of the viewed scene, the scene name; right-click an actor → **Send sheet to VTube Pro** (dnd5e sheets import) | Only the GM's browser relays (or one player's when no GM is online). Whispers, blind rolls and hidden tokens are never sent. |
| Owlbear Rodeo | Extensions → Add Custom Extension → `http://127.0.0.1:5191/vtt/owlbear/manifest.json`; open the VTube Pro panel, paste the code, Connect | character tokens (names + positions), the room; rolls made in the extension's own panel | Owlbear has no built-in dice API: rolls from other dice extensions aren't visible to it. The panel loads the Owlbear SDK from esm.sh in your browser. |
| Roll20 | Tampermonkey / Violentmonkey → install `http://127.0.0.1:5191/vtt/roll20/vtube-pro-roll20.user.js`; userscript menu → Set VTube Pro pairing code | chat rolls (dice tray, `/roll`, inline rolls, sheet roll templates), chat, the turn tracker | Reads the editor page you have open, so it depends on Roll20's page structure (it may need an update when Roll20 changes it). Token positions live on Roll20's canvas and are not readable. Whispers are skipped. |

Chrome may ask to "allow access to apps on your device" the first time an https VTT connects to 127.0.0.1: allow it for
that site. The mirrored table works in both directions of play: VTT dice animate in the 3D tray, the VTT's initiative
shows in the overlay, tokens mirror on the map, and imported sheets become characters.

## 6. Commands
Bus / MCP `send_command ttrpg {...}`:
- `{"open": true}`
- `{"start": true}` / `{"stop": true}`
- `{"roll": "d20+5", "label": "Stealth"}`
- `{"say": "…"}`
- `{"continue": true}`
- `{"xcard": true}`

The table itself is `SceneState.ttrpg` (`shared/ttrpg/state.ts`): host-owned, broadcast like the rest of the scene.
Guests convert the host clock for every `at`.

## 7. Tests (private test tree only)
- `npx tsx tools/ttrpg_unit.ts`: dice notation, GM output parsing (malformed / truncated / JSON-only), action validation,
  13 map templates, 108 SRD builds, the Foundry import, the sanitisers, the VTT sanitiser.
- `npx tsx tools/ttrpg_dice_test.ts`: every die's symmetry group and numbering, forced faces, determinism, dice stay in
  the tray, settle times, sim cost.
- `npx tsx tools/ttrpg_devserver.ts`: a private server with the real TTRPG routes and bus.

## 8. Licences and release scope
- 5e-compatible content comes only from the **System Reference Document 5.1**:

  > This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and
  > available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative
  > Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.

  No other Wizards of the Coast content is included.
- Original VTube Pro content: the rules-light archetypes, maps, seeds, dice and GM figures.
- Physics: Rapier (`@dimforge/rapier3d-compat`, Apache-2.0).
- Public release: the engine, the generic Game Room and the generic seeds. The environment rooms and their seeds (Studio,
  the kitchen, the game-world homages) are the streamer's own content and don't ship.
