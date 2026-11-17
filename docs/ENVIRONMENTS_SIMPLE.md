# Rooms (the easy way)

A **room** is the 3D place your avatar lives in on stream: a studio, a swamp lounge, a starship bridge. This guide shows
how to pick, add and make rooms from inside the VTube Pro studio, in plain words. If you want to build a room by hand in
Blender, read **[ENVIRONMENTS_ADVANCED.md](ENVIRONMENTS_ADVANCED.md)**.

You can open this guide from the studio: press **?** (top right) and pick **Guides**.

---

## Pick a room

1. Open **Room**.
2. Click **Change room**. You get picture cards, grouped by kind, with a search box and ☆ favourites.
3. Click a card. Your avatar walks in through the door and takes a seat. OBS shows the same room.
4. To go back to a plain transparent background (just your avatar), pick **No room** (transparent, avatars only) in the same list.

Some rooms have several places inside them (for example a yacht with a foyer, a bar and a deck). Their card shows small
**area** buttons; click one to move there.

Want to see what OBS will show? Click **Show the preview** at the top of the Room page. It appears in the corner, and
only you see it.

---

## Quick controls for the current room

Right under the room picker:

| Control | What it does |
|---|---|
| **Mode: 🎙 Talk / 🖥 React** | Talk = just you. React = a big screen comes down so you and your chat can watch a video or your game together |
| **Lighting: Preshow · Show · React · BRB · Outro** | Five ready-made looks. Preshow is a club light show before you start, Show is the normal look, React dims the room for the screen, BRB is a slow violet glow, Outro is a warm afterparty. Keys: **Shift+1 … Shift+5** |
| **Time and weather** (outdoor rooms) | Morning, noon, evening, night; clear, rain, storm, snow, fog |
| **Action** (battle and space rooms) | Background fights, ships, explosions: on / off / how busy |

Changes fade smoothly and show on stream right away.

---

## Describe your room

In **Room → ✨ Describe your room**, type a few words, for example *"cozy rainy jungle camp at night"*, pick style
chips if you like, then:

- **Set it up** (instant): VTube Pro picks the best matching room you have, plus the lighting, time of day, weather and
  background action that fit. It shows the plan in plain words first, and there is an **Undo**.
- **Generate new room (takes a while)**: sends your description to the AI room builder as a job. The fully automatic
  version of this button is still being finished; today the job tells you so. To make a brand-new room with AI right
  now, use **Make a room with your AI** in **Create** (below).

---

## Make a brand-new room with AI

Your Claude, ChatGPT or Grok app can build a whole room: places to sit, cameras, a screen and a door.

1. Open **Create** and connect your AI app once. The steps are on the page.
2. In **Make a room with your AI**, describe your room ("a cozy neon ramen bar with 4 stools"). Pick the
   **Places for people**, and tick **A screen for React mode** and **A door to walk in**.
3. Press **Copy the brief**. In Claude Desktop, ChatGPT Desktop or Grok Bot, start a new chat and paste it. The brief
   tells the AI every name VTube Pro looks for, so the room works the first time. **See the brief** shows it.
4. Claude and ChatGPT build it in Blender (free) on your computer. Approve it in VTube Pro when it asks. When the AI
   gives you the room file, press **＋ Add my room** and pick it.
5. Grok Bot sends a room package instead. Build it from **Check what Claude made** in **Create**.
6. Open **Room → Change room** and pick your new room.

Using a free AI on your own computer? **Use it in Ask your AI** sends the brief to the chat in **Create**.

Tip: AI-made rooms are a good start. Ask the AI to "move the couch left" or "add a plant", then add the new file again.

---

## Add a room you downloaded

A VTube Pro room is a folder with at least `scene.glb` and `scene.json` inside (usually also `preview.png` and
`thumb.png`).

1. Close nothing; you can do this while the studio is open (but not in the middle of a live show, to be safe).
2. Copy the whole folder into your scenes folder: on Windows `%APPDATA%\VTube Pro\scenes` (paste that into File
   Explorer's address bar), on a Mac `~/Library/Application Support/VTube Pro/scenes`. No `scenes` folder yet? Make one.
   The folder name must be lowercase letters, numbers, `_` or `-` (for example `neon_ramen_bar`).
3. In the studio: **Room → Change room → ↻ Rescan**. The room appears as a card.
4. If it doesn't show up or looks broken, ask the person who made it, or check it with the validator
   ([ENVIRONMENTS_ADVANCED.md, section 10](ENVIRONMENTS_ADVANCED.md#10-validate-and-test)).

Only add rooms from people you trust. A room is 3D data, not a program, but its folder may include build scripts:
don't run scripts you haven't read.

A plain 3D model of a place (a `.glb` you bought, a `.blend`) is **not** a room yet: it needs places to sit or stand
and cameras. **Add my room** (below) does that for you.

---

## Add my room

Have a 3D model of a place (a living room, a café, a spaceship) and want to stream from it? **Room → Change room →
＋ Add my room**. It takes about two minutes and nothing changes on your stream until you say so.

1. **Choose a file.** Drop your room file on the big box (or click **Choose a file**).
   - A **.glb** file works right away.
   - **.fbx**, **.blend** and **.obj** files are opened by VTube Pro on your PC (it uses Blender, which is free). No
     Blender? The wizard says so. You can also export your room from your 3D app as `.glb` and drop that instead.
2. **The check.** You see your room in a small 3D preview (only you see it) and a short report card:
   - ✓ **We found 3 places to sit or stand.** Two or more is best, so a friend can join you.
   - ✕ **We couldn't find any places for you to sit or stand in this room.** Every room needs at least one.
   - It also checks the size (a room saved in centimetres looks 100 times too big), which way is up, the camera
     views, the lighting and whether the room is light enough to run smoothly.
3. **Fix it.** If your room has no places yet, pick one of the two big buttons:
   - **Place seats for me**: VTube Pro looks for sofas, chairs and open floor, puts a place on each and points a
     camera at every place. It also fixes the size and which way is up. You see a before / after.
   - **Let me place them**: click **＋ Add a place**, then click a sofa, a chair or the floor in the 3D preview.
     Click a cushion and you get a seat; click the floor and you get a standing spot (a table top doesn't count).
     Drag a little figure to move it, use **⟲ Turn / Turn ⟳**, and **🎥 View** to see what its camera sees. Add a
     second place for a friend, then check every camera view and look at the room from all sides.
4. **Save.** "**Your room is ready in VTube Pro**". The room is saved on your PC (in your rooms
   folder). It is **never uploaded anywhere**. Click **Use it now** to switch to it (this shows on your
   stream if you are live), or **Done** and pick it later from **Change room**.

Good to know:
- The places the wizard adds are named `SPOT_01`, `SPOT_02` … inside the room file, so an artist or an AI can keep
  improving the room later. Your original file on your computer is not changed.
- If a place looks stuck inside furniture, go back, drag it a little, and press **🎥 View** again.
- An AI connected to VTube Pro can run the same check (`check_room`) and knows the room rules
  (`room_checklist`), so you can also ask it to "fix my room".

---

## Make a room your own (the room editor)

Move the cameras, the seats, the react screen and the chat screens, move or hide the room's own things (a desk, the
plants, a wall), and add props, without touching the room's files. Your changes are your own layer on top of the room;
**Reset to default** puts the original back. Your changes are kept on your PC.

1. Pick the room, then open **Room → Advanced** and press **Edit room…** (or the show dock's **Room** menu → **Edit this
   room**).
2. **What you'll see:** the room in a big window, framed like OBS frames it, with **Layouts** at the top and lists of
   **Cameras**, **Places**, **Room objects**, **Screens + chat** and **Props**. Nothing changes on stream while you work.
3. Click something, then drag it: **Move (W)**, **Turn (E)** or **Size (R)**. **Snap** keeps it neat.
4. **Look through (C)** shows a camera exactly as your viewers will see it. **+ My camera from this view** saves a new
   camera angle you can pick later.
5. **Room objects**: click any piece of the room (or find it in the list), then move, turn or resize it the same way.
   **Hide** takes it out of the room (the **Delete** key does too), **Show** brings it back, **Put back** returns it to
   where the room had it. Shadows painted into the room stay where the object stood.
6. **Add a prop**: pick one from the props library (the free CC0 props in `assets/library/`, see
   [Asset library](ASSET_LIBRARY.md)). It lands on the floor where you're looking.
7. Watch the warnings in the corner: a camera that cuts off a face, or a prop in front of someone. Each has a one-click
   fix: **Fix this camera** or **Move it out of the way**.
8. Press **Save** (**Ctrl+S**). OBS updates in place, without reloading the room. If you're on air, it asks first.

**Layouts**: **Save as new layout…** keeps the room as it looks now under a name ("Podcast", "Gaming night"). **Load**
shows a layout in the editor, then **Save** puts it on stream. **Rename**, **Delete**, and **Export** / **Import a layout
file…** (to carry one to another computer). **Reset to default** puts the room back exactly as it came (it asks first;
your layouts are kept).

**Undo** and **Redo** work for everything (**Ctrl+Z** / **Ctrl+Y**). **Reset to original** puts one thing back.

### Tweak the camera live

The show dock's **Room** menu → **Adjust this camera** gives sliders for the shot that's on air right now: **Direction**,
**Tilt**, **Distance**, **Height** and **Zoom (lens)**. They're remembered for that camera angle. **Reset this angle**
puts it back.

### The seating chart

The show dock's **Room** menu → **Seating chart** shows the room from above with every seat and who sits there. Drag a
person onto a seat, or tap the person, then the seat. While you drag, seats turn green (made for them), amber (works) or
red (doesn't fit, and it says why).

### Chat in the room

In **Chat**, choose where the chat shows: **On screen** (a chat box over your stream) or **In the room** (on screens in
the room). **Place the chat in the room…** opens the editor with the chat screens ready: **+ Add chat screen** (up to 8),
then move, turn and resize them, and set the opacity, text size and frame.

More detail: [Room editor](ROOM_EDITOR.md). Rooms that move by themselves (a battle outside, a walking ship):
[Moving rooms](MOVING_ROOMS.md).

---

## Arrange a room (the room editor bits)

Open **Room → Advanced** for:

- **Who sits where**: a map of every seat. Click a person, then a seat. Guests in a party get free seats automatically.
- **Camera**: pick a camera angle (wide, react, per-seat close-ups…) and how close it frames you. There is also an
  automatic camera tour.
- **Look**: room brightness, fog, and every light group (neon, lamps, signs, spots) with colour, level and a light
  program (steady, pulse, colour cycle, beat-reactive with your music).
- **Lighting states**: edit each of the five looks (Preshow, Show, React, BRB, Outro) and how fast they fade.
- **Time & weather, eras, graphics quality, space / battle rooms**.

Guided set-ups (in **Room**, and in **Settings → Guided set-ups**): **Set up a room (guided)** and **Set up the react screen** walk you through it step
by step.

Everything you change here is saved as your settings for that room: it never edits the room's files.

---

## If something looks wrong

| What you see | What to do |
|---|---|
| The room is black or very dark | Lighting is on **BRB** or **Preshow**: press **Shift+2** (Show). Or **Room → Advanced → Look → brightness** |
| My avatar is too big or too small in the room | Human-sized avatars are all shown the same height. For fairies or giants set **Me → 📏 Real size** |
| My avatar faces the wall or floats | The room's seat is authored wrongly. Pick another seat in **Who sits where** and tell the room's maker |
| The react screen doesn't come down | Switch **Mode** to **🖥 React**. Rooms without a screen use a floating screen instead |
| OBS shows something different from the studio | Refresh the OBS browser source once. See **OBS & stream** for setup |
| The studio got slow in a big room | **Room → Advanced → Graphics quality**: pick **Balanced** or **Performance**. Heavy rooms (space battles, moving rooms) cost the most: see [Moving rooms](MOVING_ROOMS.md#keep-it-smooth) |
| A downloaded room isn't listed | Check the folder name (lowercase, no spaces) and that `scene.json` is directly inside it, then **↻ Rescan** |
