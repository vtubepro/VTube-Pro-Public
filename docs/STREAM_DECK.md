# Stream Deck & controllers

Design your buttons once in VTube Pro, and use them on an Elgato Stream Deck, a "virtual deck" window, Touch Portal,
Bitfocus Companion, Loupedeck, Streamer.bot, a macro pad or any tool that can send a web request.

> **Hardware status:** the plugin was built with Elgato's official SDK (`@elgato/streamdeck` 3.0.1), passes
> `streamdeck validate`, packs into a `.streamDeckPlugin`, and was run end to end against a *simulated* Stream Deck
> (keys drawn, presses, live on / off state, pages). It has **not yet been tried on a physical Stream Deck**, and the
> Touch Portal / Companion files have not been tried in those apps. If something looks wrong on real hardware, the
> virtual deck (below) shows what the plugin should be doing.

## 1. Design the buttons (in VTube Pro)

Open **Stream Deck & controllers**: **Tracking** (Simple) → *Chat & donations* card → **Stream Deck & controllers** (it opens beside the studio; **Pop out ↗** gives it its own window), or go to
`http://127.0.0.1:5191/deck.html`.

- **Device**: pick your model (Mini 3×2, MK.2 5×3, + 4×2, XL 8×4, macro pad 4×4) or type any columns × rows. Resizing
  keeps every key where it was (keys that no longer fit are dropped).
- **Pages**: `+ Page`, rename, delete. Put **Next page / Previous page / Go to page** keys on a page to flip pages on
  the device (each device keeps its own page).
- **Drag** an action from the left onto a key (or click an empty key and pick one). Drag keys to move / swap them.
- Click a key to set its **title, emoji or image icon (≤ 60 KB, 144×144 PNG is ideal), colour** and the action's
  options (which lighting state, which room, which emote …).
- **Green ring** = that thing is on right now (lighting state, stage mode, room, capture cover, screen video, weather,
  raid, Chat Hub read-aloud). It follows what the studio actually saved, whoever changed it.
- **▶ Test press** (or double-click a key) runs it for real.
- **Export / Import** saves the whole layout as a `.vtpdeck.json` file (share it, back it up, move it to a new PC).
- The layout is stored on this PC in `config/deck.json`.

Scene actions are carried out by the open studio (like the studio's own buttons): with the studio closed the page
shows **studio closed** and those keys do nothing. Chat Hub keys work without the studio.

## 2. Elgato Stream Deck

1. Install the plugin: double-click `tools/streamdeck-plugin/release/com.vtubepro.deck.streamDeckPlugin`
   (needs the Stream Deck app **7.1 or newer**, Windows 10+ / macOS 12+).
   **Already installed the plugin in beta.15 or earlier? Install it again to get the new keys** (for example the
   **VTube Pro Go Live** key, see `docs/GO_LIVE.md`): double-click the same file once more. The plugin is now version
   1.1.0, so the Stream Deck app treats it as an update. The plugin does not update on its own, so until you
   do this the new keys are missing from the VTube Pro category.
2. In the Stream Deck app, find the **VTube Pro** category and drag **VTube Pro Page key** onto *every* key of a
   profile (drag it onto one key, then copy / paste it onto the others).
3. That's it: each key shows whatever is at the same row / column of your VTube Pro layout, lights up when it is on,
   and changes as soon as you edit the layout in VTube Pro. A bigger device than the layout leaves the extra keys black.
   In a key's settings, **Page** can pin that key to one page instead of following the page keys.
4. For a single fixed button (also inside Stream Deck multi-actions), use **VTube Pro action** and pick the action and
   its options from the list.
5. VTube Pro not running? Keys show *offline* and come back by themselves when it starts. Different port? Change
   **Port** in any VTube Pro key's settings.

Building it yourself (developers): `cd tools/streamdeck-plugin && npm install && npm run pack` (the packages are only
installed in that folder, never in the app). `npm run validate` runs Elgato's manifest checks.

## 3. No Stream Deck? The virtual deck

`http://127.0.0.1:5191/deck.html?virtual=1` (or **Virtual deck ↗** on the design screen) is a window that behaves
exactly like the plugin: same connection, same key pictures, same pages and lit keys. Put it on a touch screen or a
second monitor, or use it to check a layout before trying hardware.

## 4. Other devices and tools

Every action is also a plain web request from this PC:

| Tool | How |
|---|---|
| **Stream Deck without the plugin** | System → **Website**, tick "GET request in background", paste the URL from **Copy action URL (GET)** (contains your private key). |
| **Touch Portal** | Settings (gear) → **Import plug-in** → `tools/streamdeck-plugin/other-devices/touchportal/VTubePro.tpp` (the same `entry.json` zipped). Its actions run `curl -X POST …` (curl ships with Windows 10+ / macOS). |
| **Bitfocus Companion** | Add the **Generic: HTTP Requests** connection, then for each button add the action **POST** with a URL from `other-devices/companion/vtube-pro-http.json` (body empty). This file is a button list, not a `.companionconfig` import. |
| **Loupedeck / Razer / Streamer.bot / SAMMI / AutoHotkey / macro keyboards** | Any "HTTP request" / "run program" action: `POST http://127.0.0.1:5191/api/deck/run/<action>?<option>=<value>` (see `other-devices/urls.md`), or a GET URL with the key. |

`other-devices/*` is generated from the app's action list: `npx tsx tools/streamdeck-plugin/make_other_devices.ts`. It also re-zips `VTubePro.tpp`, and `tools/streamdeck_pkg_unit.ts` fails when any list misses an action. Touch Portal and Companion keep no link to the app: after an update, import the new `.tpp` (or the new button list) again to get the newest actions.

## 5. Safety

- Everything listens on **127.0.0.1 only** and refuses requests from websites (Origin / Sec-Fetch-Site / Host
  checks), like the Chat Hub. POST from this PC needs no key; the GET URLs (for tools that can only do GET) carry the
  per-PC key (the same one as the Chat Hub Stream Deck URLs). Never share those URLs.
- The Stream Deck plugin talks to VTube Pro from its own background process; its settings panels never connect to
  VTube Pro directly.
- A **Custom command** key can send any studio bus command except `screenshot`, `diag`, `recordClip`, `rebuild`.
  Keys can switch costume / avatar / room: that is the point, so design them with care.

## 6. API reference (developers)

| Route | What |
|---|---|
| `GET /api/deck/actions` | every action: `{id, label, group, icon, hint, params[], stateful, local}` + the live state |
| `GET /api/deck/layout` / `PUT /api/deck/layout` | the layout (`{v:1, name, cols, rows, pages:[{name, keys:[{action, params, title, icon, color} \| null]}]}`), resolved faces, live state, key, port |
| `POST /api/deck/run/:id` | run; params as JSON `{params:{…}}` or in the query string |
| `GET /api/deck/run/:id?key=…&…` | same, for GET-only tools |
| `POST /api/deck/press/:page/:index` (`GET …?key=`) | press a key of the layout |
| `WS /ws/deck` | server → `hello {actions, layout, resolved, live}`, `layout`, `state`, `result`; client → `{t:'press', page, index, id}` or `{t:'run', action, params, id}` |

## 7. Chat polls

Viewers vote in chat on every connected platform at once: a number (`1`), `!vote 2`, or an option's keyword. One vote
per viewer per platform (the latest counts); optional subs / members ×2 and "donation votes" (a tip that names an
option adds 1 vote per $X). Votes never show in the chat display; the poll card shows a "+N votes" pulse. Create polls
in the Chat Hub (📊 Poll) or the studio's Show tab (📊 Chat poll); save them as templates for buttons.

- Stream Deck actions (group **Poll**): *Start poll* (saved poll name; empty = the last saved one), *End poll*,
  *Show / hide poll*.
- Streamer.bot / Touch Portal / scripts (this PC only): `POST /api/poll/start` with `{"template":"name"}` or
  `{"question":"…","options":["A","B"],"durationSec":60}` · `POST /api/poll/end` · `POST /api/poll/hide`
  (`{"shown":false}`, no body = toggle) · `POST /api/poll/show` · `GET /api/poll/state`.
- On stream: the card sits on the room's chat monitor / support board when that prop is in the shot, else it docks in
  a free corner that never covers a face, a cam, the capture or an interview screen. The end-of-poll result is posted
  back to chat only on platforms whose connector can send (none today: every connector is read-only, so it is skipped).
- Code: `shared/poll.ts` (tally, parsing, anti-spam, placement), `server/poll.ts` (state, routes), `src/poll/`
  (card + controls); tests: `npx tsx tools/poll_unit.ts`.

## 8. Goals, stretch goals + the subathon timer

Goals (money, subs, bits, members, points or supporters) with ordered stretch goals, a subathon timer and incentives
("when someone gifts 5 subs, spin the wheel") live in VTube Pro's server, so every OBS page, the studio and party guests show the
same numbers and the same second. Set them up in the studio's Show tab (🎯 Goals & subathon): a template is one click.

- Stream Deck actions (group **Goals**): *Subathon timer* (pause / resume, add or take off N minutes, undo the last
  change, happy hour ×N for N minutes, sleep mode, start a new one), *Goal* (show / hide, add an amount, new stream: the
  every-stream goals start over) and *Spin the wheel*.
- Mods in chat (any platform; moderators and the broadcaster only, per the platform's badges): `!addtime 5m`,
  `!subtime 10m`, `!happyhour 2x 30m` (`off` ends it), `!pausetimer`, `!resumetimer`, `!undotime 2`, `!sleepmode on`, `!spin`.
- Scripts (this PC only): `POST /api/goals/sub/add {"text":"5m"}` · `/api/goals/sub/pause {"on":true}` ·
  `/api/goals/sub/undo {"n":1}` · `/api/goals/sub/happy {"mult":2,"ms":1800000}` · `/api/goals/wheel/spin` ·
  `/api/goals/goal/<id>/adjust {"delta":5,"note":"PayPal"}` · `GET /api/goals/view`.
- On stream: a card in a free corner (never over a face, a cam, the react screen or the chat), celebrations and the
  wheel over the frame, the Full screen layouts' `goalBar` / `goalLadder` / `subathonTimer` elements, and a GOALS board
  in rooms with a `GOAL_BOARD_xx` / `GOAL_BOARD` node or `goalBoards` in scene.json (else the room's chat board spot), and, in rooms that declare one (a `TIMER_DISPLAY` node or `timerDisplays` in scene.json), the countdown drawn on a mesh of the room.
- Code: `shared/goals.ts`, `shared/subathon.ts`, `shared/goalsView.ts` (pure), `server/goalsEngine.ts` + `server/goals.ts`
  (the engine, its files `config/goals.json`, `cache/goals/`), `src/goals/` (drawing, board, panel, party relay); tests:
  `npx tsx tools/goals_unit.ts`, `npx tsx tools/goals_relay_unit.ts`, `node tools/goals_e2e.mjs --out <dir>`.

## 9. Chat audience + questions

Viewers in chat sit in the room's audience with their names over their heads, ask with `!ask <question>` (`!axe`
works too, or a paid message when you turn that on), and every question waits for your OK (docs/SCENES.md "Chat
audience").

- Stream Deck actions (group **Audience**): *Applause* (the whole audience claps and cheers), *Next question* (the next
  approved one goes on air: pinned first, then paid / tipped, then oldest), *Question done*.
- Scripts (this PC only): `POST /api/audience/applause` · `POST /api/audience/next` · `POST /api/audience/done` ·
  `POST /api/audience/q/<id>/approve|skip|pin|unpin|answer` · `GET /api/audience/state`.
- The queue lives in the studio (Scene tab → 👥 Chat audience + questions) and the Chat Hub (❓ Questions).

## Files

`shared/deck.ts` (registry, layout, state → lit keys, pure) · `server/deck.ts` (routes, `/ws/deck`, `config/deck.json`) ·
`deck.html` + `src/deck/main.ts` (design screen + virtual deck) · `src/ui/deckOpen.ts` + a button in `src/ui/simple.ts` ·
`tools/streamdeck-plugin/` (plugin source `src/`, `com.vtubepro.deck.sdPlugin/` manifest + inspectors + icons, `release/`
the packed plugin, `other-devices/`) · `tools/deck_unit.ts` (unit tests: `npx tsx tools/deck_unit.ts`).
Adding an action = one entry in `DECK_ACTIONS` + a case in `planRun` (+ `keyActive` if it has a state), then rerun
`make_other_devices.ts`.
