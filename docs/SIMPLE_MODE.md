# Simple mode

Simple mode is how the studio opens. Each area shows only the things most people need, with big clear buttons.
Everything else is one click away under **Advanced** (see [Advanced mode](ADVANCED_MODE.md)).

This guide walks through every area in the order of the left rail, button by button.

## How the studio is laid out

- The left rail has the areas: **Home**, **Live**, **Me**, **Tracking**, **Room**, **Show**, **Chat**, **Games**,
  **Party**, **OBS** and **Create**. Near the bottom is **Settings**. Small labels group them: **You** (Me, Tracking), **Stream** (Room, Show, Chat,
  Games, Party) and **Set up** (OBS, Create). In a short window the labels shrink to thin lines, so every button still fits.
- The top bar shows your avatar (click it to go to **Me**) and four status chips:
  - **Tracking** / **No face** / **Camera off**: your camera. Click it to open **Tracking**.
  - **Mic** / **Mic off**: lip sync from your microphone.
  - **In OBS** / **Not in OBS**: whether OBS shows VTube Pro. Click it for **OBS & stream**.
  - The room name, or **No room**. Click it for **Room**.
  - If the studio loses its server, the first chip says *Studio server offline*. Close VTube Pro and open
    **`Start VTube Pro`** again.
  - On a narrow window the chips hide to make room. Home shows the same lamps.
- On the right of the top bar:
  - The studio view buttons: beside the options, a small floating monitor, hidden (tracking and OBS keep running),
    and a pop-out of exactly what OBS shows.
  - **Simple** / **Advanced**: the menu level for every area at once.
  - The sun / moon button: light or dark theme.
  - **Help**: help for the screen you're on, a tour, **Help me** and every guide. See [Help](#help).
  - **Tools** (the four squares): Chat Hub, Stream Deck & controllers, AI connectors, Tools & add-ons, Guides,
    Check my setup and the keyboard shortcuts, in one list. They open beside the stage or as a page here.
  - **The bell**: one place for notices and messages. The red number counts what you haven't seen: the update notice
    (with **Reload** when reloading gets it), the open-beta note, guests knocking (**Let in** / **Deny**) and the
    studio's warnings and errors. Every message that popped up is listed under **Recent messages**. Opening the bell
    marks everything read.
  - **Something wrong? Fix it**: checks your camera, face tracking, mic, avatar, room, OBS, graphics card and AI
    tools, one plain line each, with one fix button per problem (**Fix everything** fixes them all). A number on it
    counts real problems only. A set-up step you haven't done yet shows as a calm **Next step** instead.
- The show dock: a bar along the bottom of every area with the show one click away: the status light, **Lights**,
  **Mode**, **Camera**, **Hide screen** and **Hide chat**. Its menus hold the rest in two clicks: **Room** (rooms and
  areas, **Edit this room**, **Adjust this camera**, **Seating chart**), **Me** (expressions, emotes, outfits, **2D avatar
  options**), **Guests** (knocks, mute, **Copy guest link**, **Audio mixer**), **Chat**, **Events** and **Screen**. The
  arrow at its end folds it to a slim strip. Every dock button runs the same action as Live and the Stream Deck.
- On a phone or a narrow window (under 900 pixels), the top bar keeps your avatar, the on-air light, **Fix it** and the bell;
  everything else is in **More**. The studio stacks the view on top and the options under it.
- The top bar can also show your **Display name** (your real name stays hidden) and an **Open beta** note: VTube Pro
  is in open beta, so things may change.
- The area header shows the area's name, a small help button that opens the right part of this guide, the
  **Advanced** switch for just this area, and a search box (**Ctrl+K**) that finds any setting in any area.
- Under the title, a **Next** line says what to do here, in one sentence. **Got it** hides it.
- Cards fold: click a card's title (or the arrow on its right) to fold it to one line. The studio remembers it for
  that area, also after a restart.

> Prefer the old layout? **Settings → Look & feel → Layout → Classic** puts everything back exactly as it was:
> no group labels, no bell or Tools button (the notices sit in the area header again), cards that don't fold and the
> six Home lamps. Nothing is removed in either layout.

> **Simple or Advanced, per area.** The **Simple** / **Advanced** switch in the top bar sets every area. Each area's
> own **Advanced** switch overrides it for that area only. **Show**, **Chat** and **OBS** always show all their
> settings, and **Home** and **Live** have only one view.

Hover over anything for a tooltip. Words with a dotted underline (like *Browser Source* or *latency*) explain
themselves when you hover. When something goes wrong, the message says how to fix it.

## Help

Press **Help** at the top (or **F1**). The menu starts with *You’re in* and the area you're on, plus one line on
what to do there. Then:

- **Help me**: opens the same check as **Something wrong? Fix it**: your browser, OBS, the camera, the
  microphone and more, then what to do next. Each line has one fix button. It never turns anything on by itself.
- **Help for this screen**: opens the guide right at this part.
- **Show me around**: a 1-minute tour. One thing at a time, with **Back**, **Next** and **Skip tour**. **Esc**
  closes it.
- **What do you want to do?**: the four big choices from your first visit (go live, add your model, pick a room,
  invite a guest).
- **Best lip sync for me** and **Check my computer**: see [Best lip sync for me](LIP_SYNC.md).
- **All guides**: every guide, with search.
- **Ask for help**: the project's [Issues page on GitHub](https://github.com/vtubepro/VTube-Pro-Public/issues), in a
  new tab. **Report a problem**: tell us what broke (it opens a new issue; you need a free GitHub account). Never share
  passwords, keys or secrets.
- **Keyboard shortcuts**: or press **?** any time.

## Home

**Home** answers one question: what stands between you and going live? Nothing on Home starts, switches or saves
anything by itself.

- The headline says the next thing to do, with one button that does it:
  1. No avatar → **Choose an avatar** (opens **Me**).
  2. Camera off → **Turn on camera**.
  3. Camera on but no face found → **Check my lighting** (the lighting check from the first-time setup).
  4. OBS not showing VTube Pro yet → *"Next: add VTube Pro to OBS."* and **Copy the OBS link**.
  5. All good → *"You’re ready to go live."* and a **Show & layout** button. You go live when you press **Start
     Streaming** in OBS.
  - **Copy OBS link** is always there. Paste it into an OBS Browser Source.
- **Status**: six lamps, each with its own fix button. The new layout adds three more: **Avatar** (who you are
  wearing, **Change**), and **Show mode** (Talk, React, Gaming … switch right here once you're in a room). **Notifications** shows
  what's new under the bell.

| Lamp | Shows | Button |
|---|---|---|
| **Face tracking** | **Camera off**, **Looking for you** or **Tracking you** (updates per second and delay) | **Turn on camera** / **Check lighting** |
| **Microphone** | **Mic off** or **Listening**, with a level meter | **Turn on mic** |
| **OBS** | **Not in OBS yet** or **In OBS** (OBS is showing VTube Pro) | **Set up OBS** |
| **Room** | **No room** or the room's name | **Pick a room** / **Change** |
| **Party** | **Solo**, **Hosting** or who you are with | **Invite friends** / **Manage**, and **✉ Invite a guest** |
| **Chat** | **Not connected**, **Waiting** or the connected platforms | **Set up chat** / **Chat Hub** |

- **Jump in**: big shortcuts to **Avatar & outfits**, **Pick a room**, **Show & layout**, **Chat Hub**,
  **Games**, **Stream together**, **OBS & stream** and **Create**.
- **Tools** (new layout): the same list as the top bar's Tools button, as big buttons.
- **Finish setting up**: the first-time checklist (pick an avatar, turn on your camera, check your microphone, add
  VTube Pro to OBS, choose a room). Click a line to jump to that step. **Start the 5-minute setup** (or **Continue
  setup**) runs the whole thing. The list goes away when everything is done.
- **A tip** at the bottom. **Another tip** shows the next one.

The first time OBS shows VTube Pro in a session while you are on Home, the studio switches to **Live** for you.
Turning on your camera doesn't do that: it only moves your avatar, and nobody sees it until you stream from OBS.

**✉ Invite a guest** sends one guest a link for an interview. They need nothing installed. See
[Guests & parties](GUESTS_AND_PARTIES.md#interview-guests-with-a-link).

## Live

**Live** (also **Alt+L**) is the console for the show itself, one click each. It has its own guide:
[The Live panel](LIVE_PANEL.md).

- Its tabs: **Show**, **Cameras**, **Transitions**, **Privacy**, **Guests**, **Audio**, **Chat & alerts**, **Me**
  and **OBS**.
- **Start show** switches the lights to Show. It changes the lights only: you go live with **Start Streaming** in OBS.
- **Privacy** hides your screen, chat or guests in one click. **Hide my screen** is also **Ctrl+B** from any screen,
  and you can change the key there. See [The Live panel → Privacy](LIVE_PANEL.md#privacy).
- **Focus mode** fades the set-up areas in the rail while you perform. They stay one click away. It doesn't start or
  stop your stream.
- The status light says what it refers to: **IN OBS** (OBS is showing VTube Pro), **CAMERA ON** (only your camera is
  on: nobody sees anything) or **NOT IN OBS**.

While your camera is on or OBS is showing VTube Pro, every other area shows a slim bar at the top with the same light,
the five **Lights** buttons and your pinned quick actions, so you never have to leave the area you are in.

## Me

Your avatar, your outfit and your look. Press **G** then **M** to get here.

- **Your avatar**: every avatar in your library as a picture tile. Click one to wear it. It shows on your stream
  right away.
  - **Add my model** (button, or drop a model file on **Or drop your model file here**): the guided model importer. It
    opens your file in its own 3D preview (not on your stream) and shows a plain-words check list, with test
    buttons (**Smile**, **Say “Ahh”**, **Blink**, **Look ←**, **Look →**). Then **Set it up for me** (automatic, with
    a before / after) or **Walk me through it** (one step at a time: **Name**, **Size**, **Body**, **Face shapes**,
    **Mouth**, **Eyes**, **Look**, **Hair & clothes**, **Camera**, **Check all sides**; with **Undo**, **Skip**,
    **Back** and **Why?**). **Save it**, then **Use it now** to wear it.
  - VRM (from VRoid Studio), GLB and single-file glTF open right away. FBX, OBJ, BLEND,
    DAE, STL, PLY, USD/USDA/USDC/USDZ and ABC are changed into a model by Blender (free) on your PC, which VTube Pro
    runs for you. Without Blender, the check says so. See [Avatars: the easy way](AVATARS_SIMPLE.md).
  - The quick import (no guided screens) is still under **Me** → **Advanced** → **Avatars** → **Import a model**,
    with the older rigging check (**Re-rig with Blender**, **Set up the face**, **Use as is (limited tracking)**).
  - More: [Avatars: the easy way → Add my model](AVATARS_SIMPLE.md#add-my-model).
  - **Create a 2D avatar** turns a layered drawing (PSD) into a moving 2D avatar. Pictures, Pro2D files and models
    from other 2D apps go in the same way as any other model. See [Pro2D: 2D avatars](PRO2D.md).
- **Outfit**: tiles for **Default look** and each outfit, with their shortcuts (**Ctrl+1** to **Ctrl+9**,
  **Ctrl+0** for the default look). **Accessories** are pills you switch on and off. With no outfits yet,
  **Make an outfit** opens the AI outfit maker.
- **✨ Material style**: make the avatar look like a felt puppet, a plush toy, clay, scales or fur, without new
  textures. Some styles add a **Pattern** choice and a **Colour** choice (**Model colours** or **My colour**).
- **📏 Real size**: how tall the character really is. Pick **🧚 Fairy**, **🐾 Pet**, **🧒 Chibi**, **🧍 Human**,
  **🧌 Ogre**, **🗿 Giant** or **🦖 Kaiju**, or type a **Real height (m)**. Empty means an ordinary human. In rooms,
  tiny characters perch on a table and giants stand at the back. The card also shows the model's triangle count
  against the party limit (see [Guests & parties](GUESTS_AND_PARTIES.md#avatar-size-limits-in-parties)).
- **Try your expressions**: preview faces without the camera. Keys **1**–**9** do the same.
- **Emotes** (VRM and humanoid avatars): little animations on top of your tracking, such as a wave. **■ Stop**
  ends one. They show on stream too.
- **Camera framing**: how close the studio camera shows you: **Head**, **Head & shoulders** or **Full body**. (The
  OBS page has its own framing under **OBS**.)
- **Best lip sync for me**: **Find my best lip sync** checks your model, computer, mic and camera, then sets up the
  best lip sync. **Check my computer** shows which heavy features fit. See [Best lip sync for me](LIP_SYNC.md).
- **Fine-tune** opens **Me** → **Advanced** → **Face**: eyes, mouth, blush, physics and more.

## Tracking

Your camera, face and body tracking, and your microphone. The rail says **Tracking**; the area is called
**Camera & tracking**. Press **G** then **T**. Turning on your camera here doesn't put you on stream: it moves your
avatar, and viewers see your avatar, not your camera picture.

- **Ready to go live?**: a checklist that updates live: camera, face found, microphone, avatar, room and OBS. Each
  line has its own button (**Turn off**, **Turn on**, **Change**, **Show me**).
  - **▶ Start camera & mic** starts both. If only the camera is on, **🎤 Turn on the microphone too**.
  - When everything is on: *"✓ You’re ready to stream"* and **Calibrate my face (C)**: relax your face for a
    moment so small movements read correctly.
- **Hand and body tracking**: two big switches. Your face is always tracked.
  - **Hands**: turn it off if your hands keep glitching or you want more speed.
  - **Body**: turn it off to track only your face.
  - A switch works right away, even mid-stream. The camera stops looking for that part, so your computer has
    more power to spare. Your avatar's arms or hands ease into a relaxed pose. They never freeze mid-wave.
  - This browser remembers your choice for every avatar. You can flip the switches with the camera off too.
  - The same switches are in **Tracking** → **Advanced** (**Track hands & fingers**, **Track body**) and in
    **Live** → **Me** (**Track**). Or press **Ctrl+K** and type *hand tracking off* or *body tracking off*.
- **Your voice** (while the microphone is on): talk and the bar jumps.
  - **Sensitivity**: low means only clear speech moves the mouth; high means whispers do too (and more noise).
  - **Calibrate room noise (stay quiet 3 s)**: learns your fan, keyboard and room hum.
- **🙂 Natural mode**: **Classic** (big faces) or **Natural** (learns you). Natural learns your relaxed face and the
  size of your everyday expressions, so small real smiles show, and looking at chat or talking no longer pulls
  faces. **Relearn my face** starts over.
- **Best lip sync for me**: the same card as in **Me**.
- **🗣 Better lip sync** (experimental): **Standard** needs no OBS change. **Better** reads the sounds you make more
  precisely, and asks you to delay the microphone in OBS a little (it shows the exact steps). **Reset voice
  profile** forgets what it learned.
- **📱 Phone face tracking**: use an iPhone or Android phone instead of the webcam (Live Link Face, iFacialMocap /
  FaceMotion3D, or the VTube Studio app / MeowFace). **Use my phone for face tracking** opens a guided set-up.
  While a phone drives the avatar, **Re-centre (hold still)** and **Use webcam** appear. Step by step, with Windows
  firewall help: [Use your phone for face tracking](PHONE_TRACKING.md).
- **📷📷 Second webcam**: add a second USB webcam for **Stereo (two angles)**, a **Close-up mouth** camera, or
  **Body & hands**. **Use two webcams** opens a guided set-up. More in [Two webcams](MULTICAM.md).
- **Show it in OBS**: the **Browser Source URL** with a copy button, **Step-by-step OBS guide** and **Open the
  output page** (a preview window of what OBS shows).
- **How it feels**:
  - **Expressiveness**: how strongly the avatar copies your face.
  - **Smoothness**: low is snappy, high is buttery (with a little more delay).
  - **Run the 45-second expression test**: the test from the first-time setup.
- **Chat & donations**: shows which chats are connected. Buttons:
  - **Set up my chat & stream** (or **Change my chat set-up**). See
    [Your chat & stream](CHAT_HUB.md#set-up-my-chat--stream).
  - **Open Chat Hub** and **Twitch / TikTok…**: all your chats in one window.
  - **Stream Deck & controllers**: see [Stream Deck & controllers](STREAM_DECK.md).
  - **AI connectors** and **Ask your AI**: see [AI connectors](AI_CONNECT.md).
  - **Tools & add-ons**: optional programs such as Blender and FFmpeg. Each one is added only if you say so.
- **Advanced** opens **Tracking** → **Advanced**: camera resolution, phone tracking, expression training, the
  voice filter and more.

## Room

Where you stream from. Press **G** then **R**.

- **Show the preview** / **Hide the preview**: a small picture of what OBS will show, in the corner of the 3D view,
  labelled *Preview · only you see this*. **⤢** makes it bigger, **✕** hides it.
- The current room strip: the room's picture and name (or **Classic** and *No room — transparent*).
  - **Change room** opens the room list: search (*"Search rooms, worlds, features…"*), filter by world, your
    **Recent** rooms and favourites, and **No room** at the top. Click a room to switch. **F** marks a favourite.
    Arrow keys move, **Enter** switches, **Esc** closes.
  - **↻ Rescan** looks for rooms you added. **⤢** opens a big gallery over the 3D view.
  - Rooms with several areas show area chips. Click one to move there (a transition covers the move).
  - Rooms with a game table show a **🎲** chip that opens the tabletop game there.
  - In a party, only the host picks the room. Guests see *"You are a guest: the host picks the room."*
- The room card (when a room is on):
  - **Mode**: **🎙 Talk** (just you) or **🖥 React** (the screen comes down).
  - **Lighting**: **Preshow**, **Show**, **React**, **BRB** and **Outro** (**Shift+1** to **Shift+5**).
  - Rooms with a real sky add **Time of day** (**🌅 Dawn**, **☀️ Day**, **🌇 Sunset**, **🌙 Night**,
    **⏱ Real time**) and **Weather** (clear, cloudy, rain, storm, fog, or **🔄 Changing**).
  - Rooms with background action add **Background action** or **Space battle outside**: **Off**, **Now & then**,
    **Regular** or **Non-stop**. It always stays behind you, never in front of your face. Rooms that travel or have a
    world outside: [Moving rooms](MOVING_ROOMS.md).
- The room editor (**Edit room…** in **Room** → **Advanced**, or **Edit this room** in the show dock's **Room** menu): move the cameras, seats, the react screen and chat screens, move or hide the room's own objects, add props, and keep named **Layouts** (with **Reset to default**). It is
  your own layer of changes; the room's files are never touched. **Adjust this camera** (in the show dock's **Room**
  menu) gives live sliders for the camera you're on, and **Seating chart** shows who sits where from above. Details:
  [Room editor](ROOM_EDITOR.md).
- **✨ Describe your room**: type what you want ("a cosy neon den at night"), pick a **Style**, **Time of day**,
  **Weather** and how **Calm** or **Busy**, then **Find my room**. VTube Pro picks the best room you have and the
  lights, time and weather that fit, and shows the plan. Nothing changes until you click **Set it up**, and **↶ Undo the last set-up**
  puts things back.
  - **Generate new room (takes a while)** saves your description as a request for the AI room builder. AI room
    building is not in this version yet: the request is kept for a later update.
- **Guided set-ups**: **Set up a room (guided)** and **Set up the react screen**.
- **Show, chat and OBS**: buttons to the **Show & layout**, **Chat & events** and **OBS & stream** areas.
- **Advanced** opens **Room** → **Advanced**: who sits where, cameras, every light, weather, graphics quality.

### The react screen

In **React** mode a big screen comes down in the room and the camera turns to it. The **Set up the react screen**
guided set-up walks you through it:

1. **How it works**: **In-scene (recommended)** draws your window on the 3D screen, so it looks right from every
   camera angle. **OBS passthrough** is the old way: a hole in the room that an OBS Window Capture fills.
2. **Pick a window**: click **🪟 Pick a window…**, choose a browser tab, video or game, and click **Share**. The
   window's sound stays in OBS as usual. After restarting the studio, pick it again: browsers can't re-open a
   shared window by themselves.
3. **In-scene or passthrough**: choose. For passthrough, add a **Window Capture** *below* the VTube Pro Browser
   Source in OBS. The exact numbers are under **Show** (**OBS passthrough (fallback)**).
4. **Try it**: switch between **🎙 Talk** and **🖥 React**. The **React** lighting state (**Shift+3**) dims the room
   for watching.

## Show, Chat and OBS

These three areas always show all their settings, so they are described in [Advanced mode](ADVANCED_MODE.md):

- **Show** ([Show & layout](ADVANCED_MODE.md#show)): the show mode (**Talk**, **React**, **Gaming**,
  **Interview**, **Tabletop game**), the drag-and-drop layout editor, names on screen, game capture, the capture cover,
  room transitions, chat polls, the screen video and the react screen. Show modes and the layout editor need a room.
- **Chat** ([Chat & events](ADVANCED_MODE.md#chat)): chat connections, the chat monitor and support board in the
  room, alerts, background combat and the slap. The in-room props need a room; the Chat Hub works without one.
- **OBS** ([OBS & stream](ADVANCED_MODE.md#obs)): the Browser Source address, the output size and position, and
  OBS automation.

## Games

Games you play with your tracked avatar. Press **G** then **G**. Games need a room (the Gaming Lounge or a room with
a game table works best).

- **The Trail**: coming soon. An Oregon-Trail-style party game with your real avatar. You can't play it yet: its
  card says **Coming soon** until it arrives.
- **Tabletop RPG**: everyone walks to the game table in your room and sits down. Your avatar is your character.
  - Pick **Where to play** and the **Game master**: **Nobody** (free play with dice, a map and initiative), you, or
    an AI game master (needs an AI key or a local model, set in the TTRPG panel's set-up).
  - **Play solo** or **👥 Play with friends**. While the table is open: **Open the TTRPG panel** (**Shift+Y**) and
    **Close the table**.
  - Guests can **Make my character** before the host opens the table.

## Party

Stream together: up to 8 friends in one room. Press **G** then **P**. Everything about guests and parties is in
[Guests & parties](GUESTS_AND_PARTIES.md).

- **👯 Stream together**: whether you are hosting, a guest or solo, and whether Discord is set up. Only the host sets
  up Discord (once, about 15 minutes). **Set up** opens the guided set-up. Guests need nothing.
- **Games**: a shortcut to the party games.
- When Discord is set up (or you are in a party), the full party controls show here.
- Not hosting? *"Joining a friend?"* explains it: click **Join** on their Discord post while VTube Pro is running.
- **Advanced**: invite codes without Discord, TURN / hide my IP, allow-lists and bans.

> **Just one guest for an interview?** You don't need a party set-up for that. Use **✉ Invite a guest** on
> Home: the guest opens it in any browser. See
> [Guests & parties](GUESTS_AND_PARTIES.md#interview-guests-with-a-link). (Interview links and parties need your own
> invite server: [Hosting setup](HOSTING_SETUP.md).)

## Create

Make a new avatar, outfit or room with an AI, or by hand. Press **G** then **N**.

Then one question: **How do you use AI?** Pick one; your answer is remembered, and **Change** picks another.

- **I use an AI app (Claude, ChatGPT, Grok ...)** (**Recommended**): you talk to the AI in its own app, and VTube Pro gives
  it tools to build your stuff. VTube Pro never asks for an AI account or key. Each app (Claude Desktop, ChatGPT Desktop,
  LM Studio, Claude Code, Codex, Grok Build) shows **Found**, **Not found**, **Connected** or **Needs restart**, and
  four steps: get the app, **Connect**, restart the app (LM Studio says **Nothing to restart**), then
  **Start a new chat** with *"I have VTube Pro installed. Find it and connect, so I can create with
  it."* and ask for anything. **Test the connection** checks the link;
  **Check again** looks again. **Grok Bot**, the Grok app, runs in the cloud: its row shows how to connect it through
  VTube Pro's internet bridge (**Set it up**).
- **I don’t have an AI app**: get an AI app such as Claude, ChatGPT or Grok (recommended), or **Set up free AI** (a free
  AI on your own computer; it needs a strong graphics card). With a free AI running, **Ask your AI** appears right here
  in Create.

**What’s the difference?** shows where you chat, what you pay and what you need for each.
**Or make it yourself in Blender** shows Blender and our step-by-step guides (**Open guide**), then
**Add my finished model**.

**What do I say?** gives a first request to copy ("Make me a cozy cabin room for VTube Pro.") and more ideas.
**Check what Claude made** looks for rooms and models your AI sent that aren't in your studio yet, each with
**Import**. Big changes wait for your OK in VTube Pro. More: [Make a model with Claude or Codex](MAKE_WITH_CLAUDE_OR_CODEX.md)
and [AI connectors](AI_CONNECT.md).

Below that:

1. **Bring your own model**: the same import box as in **Me**. A VRoid Studio model (free) or any .vrm / .glb is
   the best-looking, fastest way.
2. **Describe your character**: say what they look like, pick **Style** pills (**✨ Anime**, **🧸 Cute /
   chibi**, **🐾 Animal mascot**, **🤖 Robot**, **🧝 Fantasy**, **👾 Monster**), and add reference pictures if you
   have them. **Create my character** builds a 3D model and adds eyes and a mouth that follow yours. It takes a few
   minutes and is saved to your avatars.
   - It uses ComfyUI on your computer (the Character 3D recipe: it turns a picture into a 3D model). If something is
     missing, the card says what in one sentence, with a button to fix it (**Set it up for me** or **Ask your AI
     instead**).
   - With only an AI app linked, this card stays hidden: ask your app instead.
   - When it is done, place the eyes and mouth in **Me** → **Advanced** → **Face**.
3. **Make a room with your AI**: describe the room, pick the **Places for people**, **A screen for React mode** and
   **A door to walk in**, then **Copy the brief** and paste it into a new chat in Claude Desktop, ChatGPT Desktop or
   Grok Bot. The brief names everything VTube Pro reads (places, cameras, the screen, the door). **＋ Add my room** adds
   the file your AI makes; **See the brief** shows it. **Describe a room** picks a ready-made room instead.

**Advanced** adds local AI 3D (ComfyUI) and auto-rig. Outfits: ask your AI app, or import one in **Me** → **Outfits**.

## Settings

Press **G** then **,** (comma).

- **Look & feel**:
  - **Theme**: **🌙 Dark**, **☀️ Light** or **🖥 Like Windows**.
  - **Menus**: **Simple** or **Advanced** for every area. Each area also has its own switch.
  - **Layout**: **New** (grouped menu, the bell, the Tools button, folding cards) or **Classic** (the studio exactly
    as it was before). Every button and setting is in both.
  - **Open tools in**: **In app** (a panel beside the stage) or **New window** (for a second monitor or an OBS dock).
    This is for the Chat Hub, Stream Deck & controllers and AI connectors. Each tool also has **Pop out ↗** and
    **Dock back**.
- **Guided set-ups**: every guided set-up, with **Start**, **Continue** (with where you paused) or **Run again**:
  - **First-time setup**: camera, lighting, mic, voice, avatar and OBS.
  - **Add my model**: bring your own model; we check it and set it up with you.
  - **Set up a room**: room, mode, lights, sky and background action.
  - **Set up my chat & stream**: Twitch, YouTube, Kick, Rumble or TikTok, your alerts and chat on screen.
  - **Set up the react screen**.
  - **Use my phone for face tracking**.
  - **Use two webcams**.
  - **Set up multiplayer (Discord)**.
- **Performance**: how hard face and body tracking work. **Older PC**, **Balanced**, **Fast** or **Gaming PC**.
  Still slow? Turn off **Hands** or **Body** under [Tracking](#tracking).
  Lower it if the avatar stutters.
- **Your computer**: whether the studio server is running, whether Blender was found, and whether ComfyUI is running.
  **Tools & settings** opens where you set them.
- **Keyboard shortcuts**: the short list. Press **?** for all of them.
- **Advanced** opens ComfyUI, the Blender path, local AI models and credits.

## Guided set-ups

Every guided set-up works the same way:

- **Next** and **Back** move between steps; **Skip this step** skips one. Skipped steps are marked *"Skipped —
  click to do it now"*.
- **Close** (or **Esc**) keeps your place. You can continue later from **Settings** → **Guided set-ups**.
- Nothing starts, switches or goes live unless you click it.

**Add my model** (also in **Settings** → **Guided set-ups**) is laid out the same way but has four big steps:
**Choose a file**, **Check it**, **Set it up**, **Save**. Closing it before **Save** asks *"Leave without saving?"*
(your file stays on your computer). See [Me](#me).

**Set up my chat & stream** and **Set up OBS** open in their own big window, one step at a time. Each step has a check
that turns green by itself. See [Chat & stream](CHAT_HUB.md) and [Advanced mode → OBS](ADVANCED_MODE.md#obs).

## Observer tabs

If the top bar shows an **Observer** chip, you are in a read-only sandbox studio. It never saves, never sends anything
to OBS, and the camera and microphone stay off. It exists for testing; use the normal studio to stream.
