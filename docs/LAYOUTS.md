# Screen layouts, cut-outs and HUD elements

How VTube Pro lays out the OBS picture when your **game or window is the main view** and you are a cam in a box or a
corner, how to make yourself a **cut-out** (just the character, no box), how to change the look of every layout, how to
show **chat as plain text** (no panel), and how to add **HUD elements** (alerts, a goal bar, a text label, a logo, a
webcam frame) — by hand, by pasting JSON, or by asking an AI. The last part shows how a developer adds a new kind of HUD element.

> **Most people need none of this.** Pick a layout by its picture in the Scene tab → **Show mode** and you are done:
> every layout already looks right (you stand on your game as a cut-out where that suits, chat goes where it doesn't
> cover you). This guide is for people who want to fine-tune or build their own layouts.

Contents: [The layouts](#the-layouts) · [Set up OBS](#set-up-obs) · [Layout look](#layout-look) ·
[Chat as plain text](#chat-as-plain-text) · [Full screen layouts](#full-screen-layouts) · [HUD elements](#hud-elements) · [A layout as data](#a-layout-as-data) ·
[Ask an AI for a layout](#ask-an-ai-for-a-layout) · [Add a new element type](#add-a-new-element-type-developers) ·
[Limits and safety](#limits-and-safety) · [Testing](#testing)

## The layouts

The Scene tab → **Show mode** bar picks how the frame is shared. These layouts are *screen-first*: the capture (your
game, a window, a video) is the star and the performers are cams on top of it or beside it.

| Mode → layout | What it looks like | Cams can be |
|---|---|---|
| React → Full | the window as big as it gets, cams in front of its bottom corners, chat + support docked beside it | boxed or cut-out, resized, moved to a corner |
| React → Medium | the window about ⅔ wide, everyone under it, chat + support on the right | boxed or cut-out (positions: Layout editor) |
| Gaming → Corner cam | the game big, you as a cam in one of its corners | boxed or cut-out, resized, moved to a corner |
| Gaming → Strip bottom / Strip top / Side column | the game with a strip / column of cams | boxed or cut-out (positions: Layout editor) |
| Full screen → Full screen + cut-out | the game / window fills the whole frame, you stand bottom-left as a cut-out | cut-out or boxed, resized, any corner |
| Full screen → Full screen + cut-out + text chat | the same, plus chat as plain outlined text over the game (no panel) | as above |

Everything else (Talk, React Big / Side, Interview …) is a 3D room shot and keeps the room's own look.

## Set up OBS

1. Put your **Game Capture / Window Capture / Display Capture** in the OBS scene and stretch it over the whole canvas
   (right-click → Transform → Fit to screen).
2. Put the VTube Pro **Browser Source** (`http://127.0.0.1:5191/output.html`, the canvas size) **above** it.
3. Pick a layout. Where the page is see-through, OBS shows your capture. React / Gaming layouts also offer
   *Fit my capture to the layout* (Scene tab) to place the capture exactly in their window; the Full screen layouts
   need nothing: the capture already fills the canvas.

A window shared from the studio (instead of an OBS capture) is drawn by the page itself, behind cut-outs too.

### A game that shows black in Game Capture

Some games can't be hooked by OBS's Game Capture: games with anti-cheat, Microsoft Store (UWP) games, some Vulkan
titles and emulators. OBS then shows nothing (the source is 0×0) or a black picture, and the game plays fine for you.
You don't have to find out why:

1. Scene tab → Show mode → **Game capture** (Gaming or React). VTube Pro looks at the Game Capture that OBS is showing
   (read-only, through OBS's remote control). If it stays empty for about 8 seconds while a game is running, the card
   says **"This game blocks Game Capture. Switch to Display Capture?"** (**Window Capture** when the game runs in a
   window). A line like "Games with anti-cheat protection often block Game Capture" is only a hint: what OBS shows decides.
2. **Yes, switch** adds a **Display Capture** of the monitor the game is on (with two monitors it picks the right one, and
   says so when it can only guess), or a **Window Capture** with the Windows 10+ capture method for a windowed game, puts
   it exactly where the Game Capture was (scaled into the same box, below the VTube Pro browser source) and **hides** the
   Game Capture. Nothing is deleted. A windowed game on a Display Capture is cropped to its window.
3. **Undo** removes only the capture it made and shows the Game Capture again.
4. VTube Pro remembers the choice **per game program** (config/obs-gaming.json on this PC). The next time that game shows
   nothing in Game Capture, with OBS automation on and the show in Gaming or React, it switches by itself. Undo forgets
   the choice, and "Not now" stops the question for 30 minutes.

A 4K monitor on a 1080p stream is shrunk by OBS on every frame; the card says so and offers the cheaper setting (see
Gaming at 60 FPS). Gaming always shows the capture through the
OBS hole (OBS's own capture, never a copy drawn by the page); React does too with the React screen on **Auto**, OBS
automation on and Glass sheen / Scanlines off.

## Layout look

Scene tab → Show mode → **🎨 Look** appears for every screen-first layout; open **Adjust the look (optional)** to change
only the layout on screen right now (each layout remembers its own look). OBS follows as you move a control;
**Reset to default** puts the layout back.

| Control | What it does | Range (default) |
|---|---|---|
| Avatar | Layout (the layout's own choice), Box: room (the room behind you), Box: studio (a clean backdrop), Cut-out (just the character) | (Cut-out where you stand on the game — React Full, Gaming corner cam, Full screen; boxes in strips, columns and Medium) |
| Size | the cams bigger / smaller, kept in their corner — layouts whose cams stand on the capture | 50–180 % (100 %) |
| Corner | move your cam to another corner of the capture; *Layout's* = where the layout puts it | (Layout's) |
| Cam opacity | see-through cams: the capture shows through | 10–100 % (100 %) |
| Name tags | name tag opacity; 0 = no tags | 0–100 % (100 %; Full screen: off) |
| Drop shadow | a soft shadow behind a cut-out | 0–100 % (45 % on the default cut-outs, else 0) |
| Outline | a solid outline around a cut-out (px at 1080p) + its colour | 0–16 px (0), white |
| Borders | None · Thin · Bezel · Glow — the frame of boxed cams and of the capture window | (Bezel; Full screen: None) |
| Cam corners / Screen corners | corner radius of boxed cams / of the capture window (px at 1080p) | 0–60 (16 / 10; Full screen: 0) |
| Backdrop | opacity of the styled backdrop around the capture; 0 = see-through (OBS shows what is under the browser source) | 0–100 % (100 %) |
| Backdrop dim / blur | a darker / plainer backdrop (blur fades its pattern and light sweep) | 0–90 % / 0–100 % (0) |
| Panels | opacity of the docked chat / support panels | 20–100 % (100 %) |
| Screen dim | a dark veil over the game / window — makes the avatar and text pop | 0–80 % (0) |
| Chat box | Chat box's (its own Look), Panel, or Text only — for this layout | (Chat box's; Full screen + text chat: Text only) |
| Safe margin | keeps everything this far from the frame edges (for platforms that crop) | 0–8 % (the Layout editor's) |

**Exact positions:** Show → **Layout editor** → Custom, then drag / resize any cam, the capture, a docked panel or a
HUD element on the preview (snapping to edges, centre lines and the safe margin). Custom boxes are per room.

**Honest limits.** A cut-out's shadow and outline are drawn inside its cam's box (an avatar cut by the box edge gets
no outline along that edge — anchor the cam to the frame edge, as the Full screen layouts do). The page cannot blur
the OBS capture itself (it never sees it): add a Blur filter to the capture source in OBS if you want that.

## Chat as plain text

Chat on stream is always **the chat box** (Chat & events → **Chat box on stream**): when it shows (Off · When active ·
Always), where it sits (Auto, a corner, an edge, or Free: dragged on your stream's picture; for every room, one room or
one room in one show mode) and its size, opacity and text size. Dragging **Docked chat** in the Layout editor sets that
same chat box for this room in this mode. Its **Look** is
**Panel** (the chat card in the room's colours) or **Text only**: the messages as outlined, shadowed text right on the
stream, readable over any game, fading out after a while. A layout can force one or the other (Look → Adjust the look → Chat
box). Text only options:

| Option | What it does | Range (default) |
|---|---|---|
| Lines | how many messages at most | 1–20 (8) |
| Fade after | seconds before a message fades out; 0 = never | 0–600 (30) |
| Text size | × the chat box's text size | 0.4–3 (1) |
| Font | Clean · Rounded · Serif · Mono · Heavy (system fonts only) | (Clean) |
| Text colour · Coloured names | the message colour; names in their chat colour (dark colours are lifted) | white · on |
| Text outline · Text shadow | the outline (px at 1080p) and the soft drop shadow that keep it readable | 3 px · 0.7 |
| Order · Align | newest at the bottom or the top; left or right aligned | bottom · left |
| Dark backing | a soft dark band behind each line | 0–80 % (0) |
| Platform dot · Support messages too | a coloured dot per platform; Super Chats / tips as lines too | off · on |

The chat filters (hide bots, hide !commands) and Live → Privacy → Hide chat apply. When the chat box changes to a
place far away it fades out and in again (it never slides across your face). In the Full screen layouts the chat box
and the HUD items move to the mirrored side by themselves when they would cover you (move yourself to another corner
and the chat follows out of the way). The text options sit under **Text options (optional)**, with **Reset to default**.

## Full screen layouts

Scene tab → Show mode → **Full screen**:

- **Layout** cards: the built-ins and your own. Picking one is all most people do; everything below sits under
  **Customize this layout (optional)**.
- **You stand**: corner, Bust / Full body, height, gaps to the edges (0 = standing on the frame edge, the usual look).
- **Chat box in this layout**: where the chat box sits in this layout while it shows (when its place is Auto; a place
  of your own in Chat box on stream wins everywhere).
- **Capture**: Fill the frame (default) or Keep its shape (a 16:9 game on an ultrawide canvas stays 16:9, centred).
- **On screen**: the layout's HUD elements. Each one turns on / off, has a corner, a width / height, an opacity and its
  own options (below). **Add element** adds a new one with sensible defaults.
- **Save as my layout** copies the current layout into one of your own (up to 6). Changing a built-in stores an edited
  copy; **Reset to default** drops it.
- **JSON**: copy the layout, edit it, or paste one (from a friend or an AI) → **Check** → **Import**.

## HUD elements

Every element has these fields (positions are fractions of the frame, so they fit any canvas size):

| Field | Meaning |
|---|---|
| `id` | a name for it: lower-case letters, digits, `-` (up to 24), unique in the layout |
| `type` | one of the types below |
| `on` | shown or not |
| `anchor` | which point of the frame it is measured from: `tl` `t` `tr` `l` `c` `r` `bl` `b` `br` |
| `x`, `y` | the gap to the anchored edges (`bl` with x 0.02, y 0.05 = 2 % from the left, 5 % above the bottom; centre anchors: an offset from the centre) |
| `w`, `h` | width and height (0.02–1) |
| `opacity` | 0–1 |

The types and their options (the table lives in code in `shared/hud.ts` `HUD_TYPES`; the studio builds its controls
from it):

| Type | What it shows | Options |
|---|---|---|
| `alerts` 🎉 | tips, subs, raids as one big outlined line + their message, one at a time | `duration` s (7), `size`, `font` (heavy), `color`, `accent` (amount colour; empty = the event's tier colour), `outline`, `shadow`, `message` |
| `goalBar` 🎯 | a goal of Goals & subathon (the first shown one, or the one named in `goal`) as a slim bar filling towards its next stretch goal; otherwise the chat goal (Chat & events → goal) | `label` (empty = the goal's), `color` (empty = the room's accent), `size`, `font`, `amount`, `always` (show while the goal is off), `goal` (a name or 1, 2 …) |
| `goalLadder` 🪜 | a goal and its stretch goals as a ladder: reached, next, hidden ones as ??? | `goal`, `style` (auto · neon · clean · bold) |
| `subathonTimer` ⏱️ | the subathon countdown: "+5:00" pops, happy hour / hype / sleep badges, how to add time | `style`, `board` (the top 5 "time added by" under it) |
| `text` 🔤 | any short text: a schedule, !commands, "now playing" | `text` (≤ 120), `size`, `font`, `color`, `outline`, `shadow`, `align`, `bold` |
| `logo` 🖼 | an image VTube Pro serves | `src` (a path starting with `/`, e.g. a file in your room's folder: `/api/scenes/<room id>/file/logo.png`), `fit` (contain · cover), `radius` %, `shadow` |
| `webcamFrame` 📷 | a frame with a see-through middle: put a real webcam source under it in OBS | `style` (thin · bezel · glow · neon), `color`, `width` px, `radius` px, `label` (a name tag) |

Chat itself is not a HUD element: it is the chat box (above). The minimum alert amount and the subs switch (Chat &
events) apply to `alerts`. "Now playing": there is no music source in VTube Pro yet — use a `text` element and
change its text.

The subathon countdown can also live IN the room: a room that declares a `TIMER_DISPLAY` node (or `timerDisplays` in its scene.json) draws it onto a mesh,
from the same goals data (see docs/SCENES.md, "In-room timer displays"). It is separate from the `subathonTimer` element: use either or both.

## A layout as data

A layout is one JSON object. This is the built-in "Full screen + cut-out + text chat" with a text label added:

```json
{
 "id": "full-cutout-chat",
 "label": "Full screen + cut-out + text chat",
 "capture": "full",
 "cams": { "anchor": "bl", "x": 0.012, "y": 0, "h": 0.46, "framing": "bust", "guests": 0.8 },
 "chat": { "anchor": "tl", "x": 0.015, "y": 0.04, "w": 0.3, "h": 0.44 },
 "look": { "avatar": "cutout", "screenRadius": 0, "tags": 0, "shadow": 0.45, "frame": "none", "chat": "text" },
 "hud": [
  { "id": "sched", "type": "text", "on": true, "anchor": "tr", "x": 0.015, "y": 0.03, "w": 0.3, "h": 0.06, "opacity": 1,
    "text": "Mon / Wed / Fri 8pm", "size": 1.2, "font": "sans", "color": "#ffffff", "outline": 3, "shadow": 0.7,
    "align": "right", "bold": true }
 ]
}
```

| Field | Meaning |
|---|---|
| `id`, `label`, `sub` | name (same rules as element ids), title, one line under the card |
| `capture` | `full` (fills the frame) or `fit` (keeps the content's shape, centred) |
| `chat` | where the chat box sits in this layout while it shows and its own place is Auto: `{ anchor, x, y, w, h }` like an element (absent = no chat box here unless placed) |
| `cams` | `anchor` (the host's corner: `bl` `br` `tl` `tr`; guests line up beside them), `x` / `y` gaps, `h` the cam height (share of the frame height), `framing` `bust` / `full`, `guests` (guests' size × the host's) |
| `look` | this layout's defaults for the [Layout look](#layout-look) (field names: `avatar`, `frame`, `radius`, `screenRadius`, `camOpacity`, `tags`, `backdrop`, `dim`, `blur`, `screenDim`, `panels`, `shadow`, `outline`, `outlineColor`, `scale`, `anchor`, `chat`, `safe`) |
| `hud` | the elements, drawn in this order (later = on top) |

Missing options take their defaults; numbers outside a range are clamped; unknown fields are dropped. **Check** in the
studio (or `validateHudLayout` in code) lists exactly what would change: a wrong id, an unknown type, an option out of
range, an element off the frame or over the host's cam.

## Ask an AI for a layout

Copy this into Claude, ChatGPT, Grok or any assistant, change the wish, then paste its answer into Full screen → JSON →
**Check** → **Import**:

> Make a VTube Pro Full screen HUD layout as one JSON object (format: docs/LAYOUTS.md "A layout as data"; element types
> alerts, goalBar, text, logo, webcamFrame with the options listed there; chat is the layout's "chat" place, drawn as
> text with look.chat "text"). I want: my game full screen, me as a cut-out bottom-right, chat as text on the left,
> alerts at the top centre, and a small text "Mon/Wed/Fri 8pm" top right. Positions are fractions of the frame from each element's anchor. Only JSON, no comments.

## Add a new element type (developers)

Adding an element *to a layout* is data. Adding a new *kind* of element is two small pieces of code — a row in the type
table and a renderer file — and the studio's editor, the validator and the JSON import pick it up by themselves.
Worked example: the goal bar (`goalBar`).

**1. Describe it** in `shared/hud.ts` → `HUD_TYPES` (pure data: label, icon, a one-line hint, the default placement and
every option with its default and range):

```ts
goalBar: {
  label: 'Goal bar', icon: '🎯', hint: 'The chat goal (Chat & events → Goal) as a slim bar with the amount',
  anchor: 'b', x: 0, y: 0.03, w: 0.34, h: 0.05,
  props: {
    label: { kind: 'text', def: '', max: 40, label: 'Label (empty = the chat goal’s)' },
    color: { kind: 'color', def: '', label: 'Bar colour', auto: 'the room’s accent' },
    size: SIZE(1), font: FONT,
    amount: { kind: 'bool', def: true, label: 'Show the amount' },
    always: { kind: 'bool', def: false, label: 'Show while the chat goal is off' },
  },
},
```

Option kinds: `num` (min / max / step / unit), `bool`, `enum` (options + labels), `color` (`#rrggbb`; `auto` allows
empty = automatic), `text` (max length; `path: true` = an image path on this server only). Option names must not clash
with the base fields (`id type on anchor x y w h opacity`). Values stay flat (strings, numbers, booleans): the layout is
stored in a JSON bag with a depth limit.

**2. Draw it**: a new file `src/scene/stage/hudElements/goalBar.ts` (every file in that folder is loaded
automatically). It registers a renderer whose `mount` returns a view: an element `el` (the layer positions and fades
it — draw inside it, sized in em / %), `update(e, f)` every frame, `dispose()`:

```ts
import { HUD_FONTS, prop, registerHudElement, textShadow, type HudEnv, type HudFrame, type HudPlaced, type HudView } from '../hudCore.ts';

class GoalBarView implements HudView {
  readonly el = document.createElement('div');
  // … build the label, the amount and the bar once in the constructor …
  constructor(private env: HudEnv) { /* env.feed = the chat feed (events, totals), env.chat() = the chat settings */ }
  update(e: HudPlaced, f: HudFrame) {
    const p = e.props, k = f.frameH / 1080;              // p = this element's options; k = scale for 1080p sizes
    const goal = f.chat.goal;
    this.el.style.visibility = goal.on || prop.bool(p.always, false) ? '' : 'hidden';
    this.el.style.fontSize = `${(22 * prop.num(p.size, 1) * k).toFixed(2)}px`;
    this.el.style.fontFamily = HUD_FONTS[prop.str(p.font, 'sans')];
    this.el.style.textShadow = textShadow(2.5, 0.7, k);  // readable on any game
    const usd = this.env.feed.totals?.usd ?? 0;
    // … set the texts (textContent, never innerHTML) and the bar width from usd / goal.target,
    //   colour: prop.str(p.color, '') || f.palette.accent …
  }
  dispose() { /* unsubscribe anything you subscribed to */ }
}
registerHudElement({ type: 'goalBar', mount: (env) => new GoalBarView(env) });
```

Rules for renderers: text only through `textContent` (chat and labels come from strangers); images only from this
server (`safeImagePath`); system fonts only (`HUD_FONTS`: an OBS page must never wait for a web font); no sound; cheap
`update` (it runs every frame — change the DOM only when a value changed).

**3. Use and test it**: add it to a layout (studio → Add element, or JSON), and add a check to
`tools/layouts_unit.ts` (the type table is checked automatically: defaults in range, a default element validates and
sits inside the frame).

## Limits and safety

- Everything is stored in the scene state's `hud` bag (`SceneState.modes.hud`): the picked layout, your layouts (up to
  6, 12 elements each), every layout's look and the Text only chat options; the chat box's place and Look are part of
  the stage settings (`SceneState.stage.chatBox`). The studio saves them through the scene sync (only what changed). The bag is capped at 6 KB; the studio says how much is used.
- Party guests' OBS pages follow the host's layout and look, like every stage setting.
- Text is always text (never HTML); a logo is only ever loaded from this computer's VTube Pro, never from an address
  typed into a layout (a guest's page must not contact a server the host chose).
- Cut-outs never punch see-through holes into the backdrop: around the character you see the capture (or the backdrop
  where the cam stands beside the capture), never the OBS scene behind the browser source.

## Testing

- `npx tsx tools/layouts_unit.ts` — the data side: built-ins and every type validate, the validator catches common
  mistakes, geometry (anchors, cams, corners, sizes), the look on every screen-first layout, the bag survives the
  server's generic mode-bag sanitiser and fits its size limit.
- `node tools/layouts_e2e.mjs --out <folder>` — a private server + muted headless Chrome: every screen-first layout
  boxed vs cut-out, the Full screen layouts, a test-pattern "game", and alpha checks on the page's pixels (see-through
  where OBS must show the capture, opaque on the backdrop and the character).
