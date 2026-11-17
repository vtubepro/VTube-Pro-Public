# Quick Start

Your first show, in about 10 minutes. You need a computer with a webcam, Chrome, Edge or Firefox, and OBS Studio.
A microphone is optional, but it makes the mouth much better.

Your camera picture stays on your computer and isn't on your stream: viewers see your avatar. Your voice stays on
your computer too, unless you have guests or join a party (then they hear you). VTube Pro never streams by itself:
you go live when you press **Start Streaming** in OBS.

> **In the studio:** something not working? Press **Something wrong? Fix it** at the top: it checks your setup and
> fixes what it can in one click. **Help** (or **F1**) has every guide, and search finds any word.

## 1. Open the studio

1. Unzip VTube Pro anywhere, then double-click **`Start VTube Pro`**. The first time it gets everything ready by
   itself (a few minutes). Then the studio opens in your browser at **http://127.0.0.1:5191/**. That address only
   works on your own PC. (More: the [README](../README.md). When you are done for the day, double-click
   **`Stop VTube Pro`**.)
2. The first time, the studio asks **What do you want to do?** Pick one of four big choices (or press **1** to
   **4**):
   - **Go live now**: the first-time setup below. About 5 minutes.
   - **Use my own model**: bring your VRoid, VRM or other 3D model. We set it up for you.
   - **Pick a room**: choose a 3D place to stream from.
   - **Invite a guest**: bring a friend onto your show with one link.

   **Show me around first** starts a 1-minute tour. **Skip, I’ll look around myself** closes it. **Help** brings it
   back any time.

Your name stays off the screen: the studio shows a Display name you choose.

### Everything runs on your PC

There is nothing to download, link or sign in to. The studio, OBS, Blender, AI tools, chat, Stream Deck and guests
all run from the same program on your computer, the one `Start VTube Pro` started. If the top bar says **Studio
server offline**, VTube Pro has stopped: double-click `Start VTube Pro` again.

## 2. The first-time setup

The first time you open the studio, **Go live now** starts the **First-time setup**. It takes about 5 minutes. Every
step can be skipped with **Skip this step**. **Close** keeps your place: continue later from **Home** (**Continue
setup**) or **Settings** → **Guided set-ups**.

The camera and the microphone start only when you click their buttons. If you leave them on, they turn back on the
next time you open the studio. Turn them off in **Tracking** to stop that.

The steps are:

1. **Welcome**: what is coming. Click **Let’s go**.
2. **Avatar**: click a character to wear it. The studio comes with **Sprocket** the robot, **Mirelle** and
   **Kairo**. **Bring my own model…** opens **Add my model** (see below). **Make one with AI…** goes to **Create**.
3. **Camera**: pick your camera and the **Picture quality** (**Smooth** 720p is lighter, **Sharp** 1080p is the
   best). Click **📷 Turn on camera**. Your browser asks for permission: click **Allow**.
4. **Lighting & framing**: the checks update live. Fix anything marked. A lamp behind your screen, pointing at your
   face, helps most. Then click **Set my neutral face (2 s)** and relax your face.
5. **Microphone**: pick the microphone you stream with and click **🎤 Turn on microphone**. Say something: the bar
   should jump.
6. **Voice & expressions**:
   - **Calibrate room noise**: stay quiet for 3 seconds, so fans and keys don't move the mouth.
   - **▶ Start the test**: the 45-second test. Prompts appear over your avatar (relax, smile, sad, surprised, talk
     and more). Copy them.
   - **Find my best lip sync**: we check your model, computer, mic and camera, then set it up. More:
     [Best lip sync for me](LIP_SYNC.md).
   - **Better lip sync** and **Keep learning me** are optional. Turn **Better** on *before* the test if you want it.
7. **OBS**: **Set up OBS step by step**, or **Or add it by hand**. See step 3 below.
8. **Room**: pick a 3D room, or keep **Classic** (no room: just your avatar on a see-through background).
9. **All set**: a summary, with **Set up my chat & stream** and **Stream with friends** as next steps. **Go to
   Home** finishes.

### Bring your own model

Have a VRoid Studio model or a `.vrm` / `.glb` / `.fbx` file? Click **Add my model** in **Me** (or **Bring my own
model…** in the first-time setup).

1. **Choose a file**: drop it on the box or click **Choose a file**.
2. Read the check list: green ✓ is good, yellow ! can be better, red ✕ is missing. Try **Smile** and **Say “Ahh”**
   under the preview.
3. Click **Next: set it up**, then **Set it up for me**. VTube Pro fixes what it can and shows a before / after.
   (Prefer to do it yourself? **Walk me through it** goes one step at a time.)
4. Click **Save it**, then **Use it now**.

`.vrm` and `.glb` open straight away. `.fbx`, `.obj`, `.blend` and other files are changed into a model by VTube Pro
(it uses Blender, which is free). Details: [Avatars: the easy way → Add my model](AVATARS_SIMPLE.md#add-my-model).

## 3. Add VTube Pro to OBS

You do this once. The same OBS source then shows your avatar, your room and every change.

**The easy way:** open OBS, then press **Add to OBS** on Home's OBS lamp (or **Set up OBS**). With one click VTube Pro adds itself to your current OBS scene and says *Done*, with **Undo**.
If OBS needs you first (for example its remote control is off), the step-by-step guide opens at the right step: short
steps, each with a check that turns green by itself. Your OBS password stays on your computer.
More: [Advanced mode → OBS](ADVANCED_MODE.md#obs).

**By hand:** open **Or add it by hand** in the first-time setup's OBS step.

1. In OBS: **Sources** → **+** → **Browser**. Name it `VTube Pro` and click OK.
2. **URL**: paste the link from **Copy OBS link** (on **Home**).
3. **Width** and **Height**: your OBS canvas size (OBS → **Settings** → **Video** → **Base resolution**). For most
   people that is **1920** × **1080**.
4. Tick **Use custom frame rate** and set it to your OBS frame rate (**60** if OBS is at 60, **30** if it is at 30).
   A page that draws more frames than OBS keeps is wasted work, and fewer looks choppy. Streaming a game? Pick **Settings** → **Performance**
   to match your PC.
5. Untick **Shutdown source when not visible** and **Refresh browser when scene becomes active**. Click OK.
6. In OBS → **Settings** → **Advanced** → **Sources**, **Enable Browser Source Hardware Acceleration** must be on.
7. Back in the studio, click **Check the connection**.

The background is see-through, so the avatar sits on top of your game or camera. When OBS shows VTube Pro, the
**OBS** chip in the top bar turns green.

## 4. Pick a room

A room is a 3D place your avatar streams from. Rooms have lights, cameras and seats for guests.

1. Click **Room** in the left rail (or press **G** then **R**).
2. Click **Change room** and pick one. **Classic** means no room: your avatar floats over whatever is under it in OBS.
3. Pick **🎙 Talk** (the camera is on you) or **🖥 React** (a big screen comes down for a video or game).
4. Pick a **Lighting** state: **Preshow**, **Show**, **React**, **BRB** or **Outro** (**Shift+1** to **Shift+5**).

A few starter rooms come with the studio. Want more? Add your own (see [Rooms: the easy way](ENVIRONMENTS_SIMPLE.md))
or let an AI build one ([Make a model with Claude or Codex](MAKE_WITH_CLAUDE_OR_CODEX.md)).

Not sure? Type what you want under **✨ Describe your room** ("a cosy neon den at night"), click **Find my room**,
then **Set it up**. **↶ Undo the last set-up** puts things back.

## 5. Connect your chat (optional)

Show your chat and alerts in your room. On **Home**, click **Set up chat** on the Chat lamp (or **Settings** →
**Guided set-ups** → **Set up my chat & stream**). Pick Twitch, YouTube, Kick, Rumble or TikTok, try an alert, and
pick where chat shows. About 3 minutes. VTube Pro never posts in your chat.
More: [Chat & stream](CHAT_HUB.md).

## 6. Go live

1. Open **Home** (**G** then **H**). The headline tells you the one thing still missing. When it says
   *"You’re ready to go live."*, you are.
2. Start streaming in OBS as usual.
3. During the show, use **Live** in the rail (or **Alt+L**). It has the lights, the room, cameras, guests, privacy,
   audio, chat and your outfits on one screen. **Go Live!** there switches the lights to Show. See
   [The Live panel](LIVE_PANEL.md).
4. Need to hide something? **Ctrl+B** covers your game or window capture, from any screen. Press it again to show
   it. More: [The Live panel → Privacy](LIVE_PANEL.md#privacy).

Handy keys while you stream (they work when you are not typing in a box):

| Key | What it does |
|---|---|
| **C** | Set your neutral face again |
| **F** | Re-frame the studio camera on your avatar |
| **1**–**9** | Preview an expression |
| **Ctrl+1**–**Ctrl+9** | Wear outfit 1–9 (**Ctrl+0**: the default look) |
| **Shift+1**–**Shift+5** | Lights: Preshow, Show, React, BRB, Outro |
| **Ctrl+B** | Hide or show your screen (change the key in **Live** → **Privacy**) |
| **H** | Hide every menu (clean window capture). **H** or **Esc** brings them back |
| **Alt+L** | Open **Live** |
| **G** then a letter | Jump to an area (H Home, M Me, T Tracking, R Room, S Show, C Chat, G Games, P Party, O OBS, N Create, comma Settings) |
| **Ctrl+K** | Search every setting, or run a Live action ("BRB", "cut to guest 2") |
| **F1** | Help |
| **?** | All keyboard shortcuts |

## If something is wrong

Start with **Something wrong? Fix it** (or **Help** → **Help me**). It checks your browser, OBS, the camera and the
microphone, with one fix button per line.

| What you see | What to do |
|---|---|
| The **Camera** chip says **No face** | Face the camera and add light on your face. **Home** → **Check lighting** runs the lighting check. |
| The camera won't start | Another app (OBS, Discord, Zoom) may be using it. Close it there, or pick another camera under **Tracking**. Also check that your browser may use the camera (the camera icon in the address bar). |
| The mouth moves when you are quiet | **Tracking** → **Your voice** → **Calibrate room noise (stay quiet 3 s)**, or lower **Sensitivity**. |
| OBS shows nothing | Check that the source is visible in the current OBS scene. Then run **Set up OBS** again: it finds what is missing. |
| *Studio server offline* in the top bar | VTube Pro stopped. Double-click `Start VTube Pro` again. The [README](../README.md) has a troubleshooting table. |
| The avatar stutters | **Settings** → **Performance**: pick a lower level (**Older PC** is the lightest). Still slow? **Tracking** → turn off **Hands** (or **Body**). |
| The avatar's hands or arms glitch | **Tracking** → turn off **Hands** (or **Body**). Your avatar rests them; your face keeps tracking. |

Still stuck? **Help** → **Ask for help** opens the project's [Issues page on
GitHub](https://github.com/vtubepro/VTube-Pro-Public/issues). **Report a problem** opens a new issue. Never paste API
keys, stream keys or passwords there.

## Next steps

- [Simple mode](SIMPLE_MODE.md): every area, button by button.
- [Advanced mode](ADVANCED_MODE.md): every setting.
- [Guests & parties](GUESTS_AND_PARTIES.md): interview guests with a link, or stream with friends.
- [Avatars: the easy way](AVATARS_SIMPLE.md) and [Rooms: the easy way](ENVIRONMENTS_SIMPLE.md).
- [AI connectors](AI_CONNECT.md) and [Make a model with Claude or Codex](MAKE_WITH_CLAUDE_OR_CODEX.md): connect an AI,
  then ask it to make things for you.
- [All guides](README.md).
