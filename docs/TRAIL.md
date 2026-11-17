# The Trail — an Oregon-Trail party game inside VTube Pro

1–8 performers (their own face-tracked avatars, at their real size) haul one ridiculous wagon across a hostile,
meme-filled country. Two layers: the **TRAIL** (map, days, rations / pace, group votes, 40 events per theme) and the
**STOPS** (3D physics scenes: the general store, river crossings, hunting, landmarks, camp, physical event scenes).
Everything is a floppy physics object — supplies, animals, the wagon and you. Win by reaching the destination; the
graveyard (everyone who ever died on this PC, with the epitaphs they wrote) haunts every later run.

## Playing
- **Host**: **Friends** → *Party games — The Trail* (also OBS → Browser Source & output) → theme + run length → **Start**. The game opens full-window in the studio
  (✕ Studio goes back; tracking never stops). OBS switches to the game's spectator view automatically while a game runs.
- **Guests** (party members with this update) get a "join the game" prompt. Walking-TV guests (webcam / VTube Studio)
  play as their TV set (the tvart skin, live picture on the stream view) at their set's height.
- **Food**: the store shows how many days the food in the wagon lasts. Below ~6 days the game offers a hunt every few
  days, below ~4 it asks to cut the rations; a starving party loses health slowly at first and scrounges a little food.
  Balance curve: `npx tsx tools/trail_balance.ts` (a party that never hunts with ~4 crates usually makes the short run;
  with 2 crates it's a coin flip; the first deaths come around day 26, not day 20).
- Controls: WASD, mouse (click to capture), Space jump, Shift sprint, LMB grab + hold (hunting: shoot), Q grab while
  hunting, RMB throw, wheel = hold distance, E interact (talk, sit, revive, hammer, paddle), 1–5 vote, H halt (trail
  menu), V first / third person, Tab party / store catalogue, M map, Enter ready / continue, T epitaph, Esc release mouse.

## Code map
| Path | What |
|---|---|
| `shared/trail/types.ts` | Game types (deck, run state, game state, votes, cards, stops) |
| `shared/trail/rules.ts` | The TRAIL layer as pure, deterministic functions (day tick, food, health, conditions, event roll + tier weights, choices / effects, votes, rivers, score) |
| `shared/trail/deck.ts` | Deck overlay merge (`extends`) + validation |
| `shared/trail/autoplay.ts` | Bot policy + a card-only whole-run simulator (balance checks) |
| `shared/trail/sizes.ts` | Size class → gameplay (speed, jump, lift, appetite, wade depth, mass, capsule) |
| `shared/trail/wire.ts` | Protocol: `{t:'game', d}` ctl messages, binary snapshot (0x54) / input (0x49) codecs, sanitisers |
| `shared/trail/levels.ts` | LevelDesc + grey-box level builders, wagon + prop physics specs |
| `shared/trail/glbLevel.ts` | Reads a level GLB's node contract (COL_ / ZONE_ / SPAWN_ / PATH_ / WATER_ …) into a LevelDesc — no three.js |
| `src/game/trail/sim/*` | Host simulation: `world.ts` (Rapier: players, grabbing, ragdolls, water, cargo), `sim.ts` (director: phases, votes, stops, events, bots), `worker.ts` (60 Hz Worker) |
| `src/game/trail/session.ts` | Studio-side host / guest session: Worker ⇄ party ⇄ local views ⇄ this PC's OBS (bus `{type:'trail'}`) |
| `src/game/trail/client/*` | `trail.html`: renderer, level + entities (snapshot interpolation), performers (SceneActor + Locomotion walk cycle, carry pose, ragdoll flop, big heads, ghosts), cameras + spectator director, input, HUD |
| `src/ui/trailPanel.ts` | Studio launcher |
| `server/routes/trail.ts` | Theme packs (`/api/trail/*`), graveyard + run history (`saves/trail/`) |
| `assets/games/trail/<theme>/` | Content: `deck.json`, `theme.json`, GLBs (`wagon.glb`, `props.glb`, `animals/*.glb`, `levels/*.glb`, `ui/*`) |

## Networking (inside the existing party)
Authoritative host (the sim runs in a Worker on the host's studio). Cap-gated (`'trail1'`): reliable JSON over the
party's `ctl` channel (`{t:'game', d}`: hello + deck subset, state ≤ 5 Hz to guests, level, spawn / despawn, one-shot
events; guest → host: join, commands) and unreliable binary over `rt` (snapshots 20 Hz, ≤ 4 kB packets, cm / smallest-
three quaternions; inputs 30 Hz with 3-frame redundancy). Guests render ~100 ms behind with interpolation; the own
player renders from the newest snapshot. Custody is unchanged: the game only knows each player's size + name; avatars
reach the game pages through the party's sealed RAM-vault flow exactly like OBS pages.

## Content packs
A theme is a folder with `theme.json` + `deck.json`. A deck `extends` the neutral `frontier` deck (which ships) and
overrides names / texts / numbers / events by id (choices by id, outcomes by index). Events are data: tier (mild /
hilarious / hard / insane), kind (card / stop / trail3d / voice / modifier), trigger, target, choices with requirements,
weighted outcomes (perk / size / item weight mods) and effects (food, money, items, health, conditions, days, miles,
draft, morale, broken parts, flags, modifiers, ghosts, revives, soul swap, chains, rewind…). Physical scenes implemented:
wheel repair, singing (voice), talent show (faces), pothole launch, dysentery run, photo, mud push, search, ghost race,
chase; every other scene resolves through its card outcomes. Check a deck: `npx tsx tools/trail_rules_test.ts`.
Art contract for theme GLBs: named nodes (`COL_*` colliders, `ZONE_*`, `SPAWN_*`, `WAGON_PARK`, `PATH_WAGON_*`,
`WATER_*` with depth / flow / cloud / color extras, `SEAT_*`, `GRAB_*`, `ITEM_*`, `NPC_*`, `CAM_SPECT_*`, `KILL_*` fall-out
zones, `ANIMAL_SPAWN_*` with kinds / radius / air, `LIGHT_*` point lights, `FX_fireflies_*` / `FX_sparks`, `FIRE` /
`EMIT_fire` / `EMIT_bluefire` flames), metres, +Y up, +Z forward. Per-stop levels: `levels/<route node id>.glb` wins over
the kind's generic level (`levels/landmark_1.glb`, `river.glb`, `store.glb`, `hunt.glb`, `camp.glb`, `destination.glb`).
The road: `levels/trail_road.glb` (60 m `LEVEL_trail_road[_<biome>]` tiles + a `SCENERY_*` kit). NPC models:
`npcs/<id>.glb` (`idle` / `talk`). Animals: `animals/<id>.glb` (`idle` / `walk` / `run` / `flee` / `attack` / `die`, a
wyvern's `swoop`; root `extras.trail.variants` = per-instance tints); a deck animal with `grabs: 'micro'` carries micro
players off. UI: `ui/logo.png`, `ui/map.png` + `map.json`, `ui/card_frame.png`, `ui/tombstone_bg.png`, `ui/icons/*.png`.

## Tests
- `npx tsx tools/trail_rules_test.ts [--decks <dir>]` — rules, decks (30–40 events per theme, all tiers), determinism,
  card-only balance sweep.
- `npx tsx tools/trail_sim_test.ts [--levels <dir>] [--river ford]` — a headless bot party plays the whole slice on the
  real sim (Rapier in Node): phases, step time, snapshot / state sizes, a log.
- `npx tsx tools/trail_balance.ts [--theme skyisles] [--full]` — the food-balance curve (party × crates × hunting policy).
- `trail.html?test=duo&auto=1` (`&theme=skyisles`, `&tv=1` for a walking-TV guest) on a PRIVATE vite (never the live studio): two Party instances in one page over loopback
  WebRTC, a host + a guest session, two views side by side.

## Persistence
`saves/trail/graveyard.json` (≤ 500 graves: theme, seed, mile, name, cause, epitaph) and `saves/trail/runs.json`
(≤ 200 runs) on the host PC only — names + text, never model data. Old graves appear by the road at their mile.
