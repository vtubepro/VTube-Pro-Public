# The Live panel

**Live** is the console for the show itself. Everything you change mid-show is on one screen, one click each: what
you're doing, the lights, the room, the camera, guests, polls, your outfit and emotes.

Open it with **Live** in the left rail, or press **Alt+L** from anywhere in the studio. The first time OBS shows VTube
Pro while you are on **Home**, the studio opens Live for you.

> **VTube Pro never streams by itself.** You go live only when you press **Go Live** and then confirm on the card
> that opens, or when you press your Stream Deck's Go Live key and confirm on screen within 10 seconds. Nothing else can
> start a stream: not an AI helper, not a schedule, not an update, not a message from another person. (Streaming from OBS
> itself still works the old way: press **Start Streaming** in OBS.) Turning on your camera doesn't put you on stream
> either: it moves your avatar, and viewers see your avatar, not your camera picture. How it works:
> [Going live](GO_LIVE.md).

> **Every button is a Stream Deck action.** A button on screen and a key on a Stream Deck (or any controller) run
> the same action and light up the same way. Hover over a button: the tooltip shows its Stream Deck key (if you put it
> on one) and the words that run it from **Ctrl+K**.

## How the panel is laid out

Three things are always on screen:

- The studio view (top left): a small picture of your avatar as the studio draws it. OBS adds your room. The switch
  above it picks its size: **Small** (the default), **Large** (the big picture of earlier versions) or **Hide** (not
  drawn at all, so your graphics card works for OBS only; OBS and tracking keep running).
- **Camera** (under the picture): which shot the camera shows.
- **Show** (top right): what you're doing and your lighting, in two rows of big buttons, plus **Hide my screen** and
  **Start show**.

Everything else sits in tabs next to **Show**:

| Tab | What it is for |
|---|---|
| **Rooms** | Switch rooms. A card covers the change. |
| **Guests** | Let people in, seat them, and control their camera and mic. |
| **Chat & polls** | Read chat, thank supporters, run polls, hide chat. |
| **Me** | Your outfit, emotes and face tracking. |
| **Privacy** | Hide your screen, BRB, hide chat or guests. One click each way. |
| **Transitions** | How the picture changes when you switch rooms or cameras. |
| **Audio** | What you and your guests hear, and your mic level. |
| **OBS** | Check that OBS can see VTube Pro, and switch OBS scenes. |

The layout follows the size of your window:

- Big window: **Rooms**, **People**, **Chat & polls** and **Me** sit side by side along the bottom. The tabs only
  hold **Privacy**, **Transitions**, **Audio** and **OBS**.
- Smaller window: all eight are tabs, in one or two rows.
- Narrow window (a pop-out under 760 pixels wide): one column, with all eight tabs in one place.

Good to know:

- Pickers you rarely change start folded (the hide-screen and BRB card styles, some transition pickers). Click a
  section's title to open or fold it; a folded section still says what is in use. Live remembers each one.
- **Rooms** puts your favourite rooms first. Click the ☆ on a room card (**Add to favourites**); click it again to
  remove it. The ★ button above the cards shows only your favourites, **All** shows every room. Favourites are kept by
  VTube Pro on your PC, so they are the same in the show dock and in **Room** → **Change room**.
- Live remembers the tab you were on.
- A tab shows a badge when something needs you. **Guests**: how many people are there, red when someone is waiting to
  come in. **Privacy**: how many things are hidden. **Transitions**: a room is waiting for you. **Chat & polls**: a
  poll is running. **OBS**: OBS isn't showing VTube Pro yet.
- With a tab selected, **←** and **→** (or **Home** and **End**) move between tabs.
- **Ctrl+K** opens a tab by name. Type *transitions*, *hide my screen* or *obs*, then pick **Live → …**.

## The header

From left to right:

- The status light (not a button). It says what it refers to:
  - **IN OBS** (red, pulsing): OBS is showing VTube Pro. You're live only while OBS is streaming.
  - **CAMERA ON**: your camera is on, but OBS isn't showing VTube Pro. Nobody sees anything.
  - **NOT IN OBS**: the camera is off and OBS isn't showing VTube Pro.
- **Live**: the title.
- The status line, for example *Now: Talking · Lights: Show*. Click it to jump to **Show**. Next to it are small
  chips for anything viewers can't see right now: *Screen hidden*, *Chat hidden*, *BRB card up*, *2 guests hidden*,
  *Room waiting* or *1 waiting*. Click a chip to open the tab it belongs to.
- **Pinned**: your quick bar, with the buttons you use most. By default: **Show**, **BRB**, **Cover**, **Auto cam**,
  **Read-aloud**, **Ack next**, **Poll Y/N** and **Recalibrate**. Up to 12.
- **Show preset**: switch the console for a kind of show. A preset sets the quick bar and what you're doing. Built in:
  - **Just chatting**: Talk.
  - **Interview night**: Interview, with **Auto cam**, **Host**, **Guest 1**, **Two-shot**, **Let in**, **Ack next**
    and **BRB** pinned.
  - **Gaming**: Gaming, with **Cover**, **BRB**, **Read-aloud**, **Ack next**, **Poll 1–4** and **End poll** pinned.
- **Save preset** (the pin icon): keeps the quick bar, what you're doing and the tab you're on as your own preset.
- **Customise** / **Done**: while it's on, click any button to pin it to the quick bar, or click again to unpin it.
  Pinned buttons get a dashed outline. **Reset** puts the default quick bar back.
- **Focus mode**: the set-up areas in the left rail (**Create**, **Settings**, **OBS** and **Games**) fade back, so you
  don't click them by mistake. Nothing is removed: they still work. It doesn't start or stop your stream.
- **Pop out** (icon): opens Live in its own window. See [The pop-out window](#the-pop-out-window).

> **Careful buttons ask twice.** Buttons that remove someone or end something (**Remove**, **End party**,
> **End show**) need two clicks. The first click turns the button into *Confirm …?* for 3 seconds.

## The program picture

The picture is the studio's view of your avatar, marked **STUDIO VIEW**. It is small unless you pick **Large**. Next to it, the status light again:
**IN OBS**, **CAMERA ON** or **NOT IN OBS**. Its frame turns red only while OBS is showing VTube Pro. Your room is drawn
by OBS (**OBS ADDS YOUR ROOM**), and your camera self-view is hidden here: it never goes to OBS. In the studio it is the
studio's own picture, not a second copy, so it costs nothing extra.

The caption under it says which shot is on, what you're doing, the room and the lights. For example:
*Host · Auto director* and *Interview · Classic (no room) · Lights: Show*.

While **BRB** is on, the picture fades to black and shows your BRB card, just like your viewers see it.

## Show

The **Show** tile is always on screen.

- **Hide my screen** / **Show my screen**: covers your game or shared window with an animated card. See
  [Privacy](#privacy).
- **Start show** switches your lights to **Show**. While the lights are **Show** or **React**, it becomes **End show**
  (two clicks), which switches them to **Outro**. These change the lights only: you start and stop the stream itself in
  OBS.
- **What you're doing**: **Talk** (the default), **React**, **Gaming**, **Interview** or **Tabletop game**.
- **Lighting**: **Preshow**, **Show**, **React**, **BRB** or **Outro**.
- **Background video**: the video on your room's screen. See [Background video](#background-video).

### What you're doing and lighting: the difference

These are two separate choices. You can mix them any way you like.

**What you're doing** is the kind of show. It changes the layout and the cameras.

| What you're doing | Means |
|---|---|
| **Talk** | Just chatting in your room. The default. |
| **React** | Watching a video or stream together on a big screen. |
| **Gaming** | Your game big, you in a corner. |
| **Interview** | Guests on the show, with a camera switcher. |
| **Tabletop game** | A tabletop game night. |

**Lighting** is the moment in your show. It changes the room's lights and the background video.

| Lighting | Means | Key |
|---|---|---|
| **Preshow** | Before you start: house lights off, a light show | **Shift+1** |
| **Show** | Normal studio lights while you're on | **Shift+2** |
| **React** | The room a little dimmed, towards the screen | **Shift+3** |
| **BRB** | Be right back: fade to black, guests muted, your BRB card | **Shift+4** |
| **Outro** | Wrap up: warm afterparty lights | **Shift+5** |

For example: **Gaming** with **Preshow** lights while your stream starts, then **Show** lights when you begin. The
**React** lighting only dims the room. It doesn't switch you to **React**.

The keys **Shift+1** to **Shift+5** work while you're in a room. The buttons work anywhere.

### Background video

The video on the room's screen, from your playlists (Starting soon, Talk ambience, Be right back, Ending). It follows
the lights.

- **On** / **Off**. **Off** stays off through lighting changes, until you turn it back on.
- **Next**: the next video (only while it's on).
- **Frame it**: points the camera at the screen the video plays on. **Auto** (in **Camera**) puts the normal camera
  back.
- **Sound**: the video's sound, on or off. It plays in your studio window (never on the OBS page), so your stream
  hears it the same way it hears your guests: see [Sound on your stream](SOUND.md).

You set up the playlists under **Show** → **Screen video** (see
[Advanced mode → Show](ADVANCED_MODE.md#show)).

## Camera

The **Camera** tile is always on screen, under the program picture.

### Outside Interview

The heading says **Camera** and what you're doing, for example *Camera · Talk*. These buttons move the room's camera:

- **Auto**: the camera that fits what you're doing. Talk: a close-up of you. React: the react shot. Gaming: the
  group. TTRPG: wide.
- **Me**: a close-up of you.
- One button per guest (up to 4): a close-up of them. It's dimmed while they are outside the room.
- **Group**: everyone in the room, framed together.
- **Wide**: the whole room.
- **Screen**: centred on the screen that shows the video or your React window.
- **Room cameras**: extra buttons for cameras the room's maker placed (for example *Desk left*). Only in rooms that
  have them.
- **Interview cams** switches to Interview.

The camera showing now is marked **NOW**.

### In Interview

A camera switcher for a talk show.

- Numbered buttons: **Host**, your co-hosts (up to 2), then **Guest 1** to **Guest 4** (with their names). With
  co-hosts you also get a shot of you together (**Hosts**), and **Panel** with two co-hosts. Then **Two-shot** and
  **Wide**.
  - The shot showing now has a red bar and **NOW**. The shot the auto director will likely cut to next (whoever is
    talking) has a green bar and **NEXT**.
- **Auto on** / **Auto off**: the auto director cuts to whoever is speaking. Click a camera while it's on, and it holds
  that shot for about 4 seconds, then takes over again. With it off, you cut by hand and the shot stays.
- More shots in the heading: **Establishing**, **Over shoulder**, **Push-in** and **Show open** (plays your show-open
  clip).
- Who is in a shot: right-click a camera button, press and hold it, or click its **⋯**. A small panel lists each person
  in that shot, with **Guest** / **Co-host**, **In studio** / **On monitor**, **Mute** and **Kick**. At the bottom:
  **Cut to …** and **Manage group** (opens **Guests**). **Esc** closes it.

Keys in Interview (host only): **Ctrl+Shift+1** to **Ctrl+Shift+9** cut to the numbered shots. **Ctrl+Shift+0** gives
control back to the auto director. **Ctrl+Shift+B** plays the show open.

## Rooms

- One card per room, plus **Classic** (no room: your avatar on a see-through background). The room you're in has a
  green ring and an **IN USE** badge. Click a card to switch: the room-change card covers the swap.
- **Prev area** / **Next area** (arrow buttons): move between the areas of a room that has several.
- **Reveal**: if room changes wait for you (**Transitions** → **Wait for me**), this shows the new room. **Shift+Enter**
  does the same.

## People

The **Guests** tab (called **People** in its heading) shows everyone in your show, and everyone waiting to join.

At the top:

- **Copy guest link**: a link a guest opens in any browser. No install, no Discord on their side. It works for 10
  minutes, 30 minutes or 1 hour (you pick in Invite someone). See
  [Guests & parties](GUESTS_AND_PARTIES.md).
- **Cut all** (when you host guests): every guest's camera and mic off at once, right now. Press **Bring all back** to
  undo it.
- **End party**: everyone leaves (asks twice).

In the list:

- Knocking: *"… is knocking"* rows with **Let in** and **Deny**. **LINK** marks someone who came in with your link.
- People still connecting show how far they are, for example *"still connecting"*.
- **You**: your own row.
- Each guest: their name, tags (see below), and bars that move while they talk.
- With nobody there: **No guests yet**, the **Copy guest link** button and three steps: send the link, they open
  it (no install), bring them on. Once you bring a guest on, they are on your stream.

### Keeping your show safe

When you host, each guest's row has these controls. They are instant. Your guest is told what happened.

- **Camera on** / *Camera hidden* (for avatar guests: *Avatar on* / *Avatar hidden*).
- **Mic on** / **Muted**: off the stream, your speakers and every other guest.
- A volume slider, 0 to 100 %.
- **Cut**: camera and mic off at once. After a cut you can **Hold in green room**, **Remove**, **Remove + block** or
  **Turn link off**.
- **Remove** (the icon at the end of the row, asks twice).
- An **Undo** strip shows your last change. **Ctrl+Z** in the panel does the same.
- **When I cut**: **Keep in place**, or **Send to green room** as well.

Everything about guests: [Guests & parties](GUESTS_AND_PARTIES.md).

### In Interview

Each guest also gets **Guest** / **Co-host** (co-hosts sit with you at the desk, up to 2), and guests get **In studio**
/ **On monitor**.

### Tags on a guest

| Tag | Means |
|---|---|
| **TV** | Their own camera picture, shown on the studio TV |
| **LINK** | Talks over your interview link (in their browser) |
| **VOICE** | Talks in VTube Pro, no Discord needed |
| **VOICE…** | Their in-app voice is connecting |
| **DISCORD** | They chose to talk in your Discord call instead |
| **NO VOICE** | They switched in-app voice off |
| **OLD APP · USE DISCORD** | Their VTube Pro is too old for in-app voice |
| **READY** | They pressed *I'm ready* |
| **MUTED** | They muted their own mic |

### In the room or outside

In a room, each person (you too) shows **● In room** or **○ Outside**.

- In the room, with walk-ins on: **Walk out** (they leave through the door) or **Gone** (they vanish now). With
  walk-ins off: **Leave**.
- Outside, with walk-ins on: **Walk in** (they come in and sit down) or **Already here** (they're already in their
  seat). With walk-ins off: **Come in**.

Under the list:

- **Walk-ins**: **On** (people walk in through the door and out again) or **Off** (people appear in their seats and
  vanish from them).
- **Joiners**: what happens when someone joins: **Walk in**, **Seated**, or **Outside** (in the party, but not in the
  room until you press **Walk in** or **Already here**).

### The green room

A waiting area, so guests don't land on stream the moment they connect. Only the host has one.

- **Who waits**: **Link guests wait** (the default), **Everyone waits** or **Nobody waits**.
- **Bring on next**: brings on the next guest. Guests who pressed *I'm ready* go first, then whoever waited longest.
- **Next guest**: a swap. The guest you brought on last goes back, the next one comes on.
- A card for each waiting guest: their camera (only you see it), their mic level, their connection, how long they
  have waited, and what they said.
  - **Bring on**: they come on with your walk-in setting and take their place in Interview.
  - **Talk backstage** / **Stop backstage voice**: two-way voice with just this guest. It never plays on stream.
  - **Remove** (asks twice).
  - Messages: **Up next**, **In 1 min**, **You’re live**, **Hang tight**, or type your own (up to 140 characters) and
    press **Send**. It shows as a banner on their page, with no sound.
- **Backstage output**: where backstage voice plays. Pick headphones that OBS doesn't record. If OBS records your
  desktop sound, backstage talk can reach your stream.

Waiting guests are not in the room and not on stream, and they don't hear the show.

On a guest who is on the show, **Green room** sends them back to wait, and the message button sends them a message.

### Guest voice

These controls are in the **Audio** tab. (The **Guests** tab has an **Open Audio** button.) They appear when a guest
talks over the link or in VTube Pro.

- **Hear them**: you hear your guests here in the studio. Wear headphones, or they echo into your mic. This is the
  only place VTube Pro plays guests: never the OBS page. Your stream gets them the same way it gets a Discord call,
  through the desktop sound OBS records.
- **They hear me**: sends your microphone to your guests. It turns on by itself when a link guest arrives.
- **Mic: same as lip sync** / **Mic: …**: which microphone your guests hear. **Sending: …** shows a level bar. If it
  stays still, your guests hear silence.
- **⚠ Guests can’t hear each other — click to start**: browsers only start the guest-to-guest sound after a click in
  the studio window. Click once anywhere in the studio window. (The pop-out can't start it.)

## Chat & polls

- **Chat Hub**: opens the Chat Hub beside the console: all your chats, support and events.
- **Set up chat & alerts**: the step-by-step chat set-up. See
  [Set up my chat & stream](CHAT_HUB.md#set-up-my-chat--stream).
- **Hide chat** / **Show chat**: hides your chat from viewers. The same switch is in **Privacy**.
- **Read-aloud**: a voice reads donation messages on stream, on or off.
- **Ack next**, **Thank**, **Skip**: work through the support queue. Acknowledge the next one, thank the next one, or
  skip the message being read.

### Polls

Chat votes by typing an option (or its number).

- **New poll…**: type your question (up to 120 characters) and 2 to 8 options (**+ Option**, or **Enter** in the last
  box). Pick a **Length** from 30 seconds to 5 minutes, then press **Start**. **Save** keeps it as a saved poll.
- **Yes / No**: a quick yes-or-no poll.
- Saved polls: pick one from the list and press **Start**.
- While a poll runs: the question, the votes and a bar per option, **End poll**, and **Card on stream** / **Card
  hidden** for the poll card in your room.
- The full poll editor is under **Show** → **📊 Chat poll**.

## Me

- **Recalibrate**: hold a neutral face for 2.5 seconds. (Tracking must be on.)
- **Outfits**: **Default** and each of your outfits. The one you wear has a tick.
- **Tracking lost**: what your avatar does when the camera loses you. **Hold** (keep the last pose), **Rest** (go back
  to the rest pose) or **Voice life** (keep moving with your voice). These buttons don't light up. The current choice
  is under **Tracking** → **Advanced** → **When tracking is lost**.
- **Track**: **Hands** and **Body** on or off, right away. A lit button is tracked. These are the same switches as in
  **Tracking**: off stops that part's tracking and your avatar rests it. Your face is always tracked. (Only in the
  studio window: the pop-out doesn't show them.)
- **Extras**: accessories on and off (only if your avatar has some).
- **Emotes**: one button per emote, and a stop button.
- The size class and height of your avatar show in the heading.

## Privacy

Big on / off cards. Each one says what viewers see.

- **Hide my screen**: an animated card covers your game or shared window. Your avatar stays on screen.
  - **Pick the animation**: **Blow the cartridge**, **Jacking in** or **Press Start**. They play right there. Click
    one to use it. **Preview** under a card plays it from the start, only for you.
  - **What viewers see**: the line on the card. Type it and press **Save**.
  - **Shortcut**: **Ctrl+B** hides and shows your screen from anywhere in VTube Pro. Click **Change** to pick other
    keys.
- **Be right back**: the picture fades to black, your BRB card appears and your guests go quiet. Click again to fade
  back in. **The BRB card** picks the animation (**Breathe**, **Light sweep** or **Bouncing dots**), **Dark** or
  **Light**, your words, and **Your own screen** (a picture or short video). Everything about it:
  [BRB screens](BRB_SCREENS.md).
- **Hide chat**: the chat screen, the chat buddy and the chat box disappear for viewers. Donation alerts still show.
- **Hide all guests** (when you host guests): every guest's camera and mic go off at once. **Undo** is in **Guests**.
- **My microphone**: your stream mic is in OBS, so mute it there. *Mute from here* is coming soon. When link guests
  talk with you, **Guests hear me** turns your voice to them on or off.

## Transitions

- **When you switch rooms**: pick the card that covers the screen while the new room loads. Hover a card to play it.
  **No transition** swaps the room at once, so viewers may see it load.
  - **Preview** plays it in the panel only. Viewers and OBS never see a preview.
  - **Speed**: **Quick**, **Normal**, **Slow** or **Very slow**.
  - **Wait for me**: **On** keeps the card up until you press **Show the room now** (or **Shift+Enter**). Good for a
    big reveal.
- **When the camera changes shot**: **Cut** jumps straight to the new shot. **Quick glide**, **Smooth glide** (the
  default) and **Slow glide** move the camera there. **Preview** shows a little drawing of the move.
- **When OBS switches scenes**: pick one of OBS's own transitions and a length, then press **Use in OBS**. An **Undo**
  button puts OBS back. This needs OBS set up first (**Set up OBS**).
- **Moving cameras on breaks**: slow camera moves during the **Preshow**, **BRB** and **Outro** lighting. **On** or
  **Off**.

## Audio

- **Your mic**: the mic VTube Pro listens to for lip sync, with a level bar. Your stream hears the mic you added in
  OBS. *Mute from here* is coming soon.
- **Your guests’ voices**: see [Guest voice](#guest-voice).
- **Show sounds**: **Background video sound** and **Read chat aloud** (reads donation messages on stream).

## OBS

- **Set up OBS automation**: the step-by-step OBS set-up. It adds VTube Pro to OBS, makes your stream scenes and
  switches them for you. See [Advanced mode → OBS](ADVANCED_MODE.md#obs).
- **Is OBS showing VTube Pro?** says *Yes: OBS is showing VTube Pro*, or *Not yet* with **Copy OBS link**. If the OBS
  link is only open in a normal browser tab, it says so: that is not OBS. It also says whether VTube Pro can control
  OBS.
- **Switch OBS scene**: one button per OBS scene, once VTube Pro can control OBS.

## The health strip

Along the bottom. It updates four times a second.

| Item | Shows |
|---|---|
| **Tracking** | *on*, *no face found* or *off* (hover for how fast it runs) |
| **Mic** | A level bar, or *off* |
| **OBS** | *shows you* while OBS is showing VTube Pro, or *not added yet* |
| **Party** | How many people are there and how many are knocking, or *off* |
| **Server** | *ok*, *studio closed*, or *not running* |
| **Delay** | How fast your clicks get an answer. It has nothing to do with your stream. |
| **Picture** | The picture quality OBS gets, and the studio's |

A warning appears when the studio window is closed (*buttons reach nobody*), or in a read-only tab.

## The on-air bar

While your camera is on or OBS is showing VTube Pro, every other area of the studio shows a slim bar at the top: the
status light (**CAMERA ON** or **IN OBS**; it opens Live), the five **Lights** buttons, up to 8 of your pinned buttons
(hover one to see what it does), **Focus mode**, and **Live**.

## Ctrl+K: run anything by typing

Press **Ctrl+K** and type. With 3 or more letters, matching Live actions appear. **Enter** runs the first one; the
arrow keys move. Actions that remove someone ask first. Some examples:

| Type | Does |
|---|---|
| `brb`, `show`, `preshow`, `outro` | Lighting |
| `brb light`, `brb dark`, `brb dots` | The BRB card's look |
| `talk mode`, `react mode`, `gaming mode`, `interview mode` | What you're doing |
| `cut to guest 2`, `cut to host`, `two shot`, `wide` | Interview cut |
| `auto cam`, `manual cam` | Auto director on / off |
| `camera group`, `camera screen`, `camera auto` | Room camera (outside Interview) |
| `hide my screen`, `show my screen`, `hide chat` | Privacy |
| `video off`, `reveal` | Background video, show the waiting room |
| `let in`, `deny`, `kick 2`, `cut all`, `undo` | People |
| `bring on`, `next guest`, `up next`, `1 minute` | Green room |
| `go to <room name>` | Switch room |
| `poll yes/no`, `poll 1-4`, `end poll` | Polls |
| `read aloud`, `ack`, `thank` | Chat Hub |
| `recalibrate` | Neutral face |
| `hand tracking off`, `body tracking off`, `hand tracking on` | The **Hands** / **Body** switches |
| `wear <outfit>`, `emote <name>`, `stop emote` | Me |

Ctrl+K also finds every setting in every area.

## The pop-out window

**Pop out** opens Live in its own window, for a second monitor.

- The buttons work the same. They need the studio window to stay open: the studio does the work. With the studio
  closed, the pop-out says *Studio window closed* and its buttons reach nobody.
- It doesn't show a second copy of the studio view. It shows your room's picture and says *Your picture is in the
  studio tab*: this window is a remote control.
- The **Hide my screen** shortcut works in the pop-out too.
- **Dock back** (when the studio opened it) puts Live back in the studio and closes the window.

## Stream extras

The **Stream extras** button (bottom right of the Live area) opens the small screens that make a stream feel alive: reactions
to redeems and chat, things thrown at your head, stickers on your avatar, keys and pads, emote rain, your own recorded emote,
sounds and screen effects and an AI co-host. Each screen has a **?** that explains it.

Everything about them: [Stream extras](STREAM_EXTRAS.md).

## Stream Deck and other controllers

Every Live action can go on a physical button. Open the editor from **Tracking** → **Chat & donations** →
**Stream Deck & controllers**. Drag actions onto keys, then test a key right there.

Everything about it: [Stream Deck & controllers](STREAM_DECK.md).
