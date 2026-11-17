# Advanced mode

Advanced mode shows every setting. This guide goes through them area by area, in the order they appear on screen,
and says what each one does and when you would touch it. For the everyday controls, start with
[Simple mode](SIMPLE_MODE.md).

## Turning Advanced on

- **For every area:** the **Simple** / **Advanced** switch in the top bar (or **Settings** → **Look & feel** →
  **Menus**).
- **For one area:** the **Advanced** switch next to the area's title. It overrides the top-bar choice for that area
  only. The subtitle then reads *"Every setting. Switch Advanced off for the essentials."*
- **Show**, **Chat** and **OBS** always show every setting. **Home** and **Live** have no Advanced view.
- Areas with several pages show tabs under the title (for example **Me** → **Avatars**, **Outfits**, **Face**,
  **Body & physics**).

In Advanced mode the top bar also shows the performance chip: frames per second, tracking rate and delay. With
Advanced on for every area, the **Next** lines under the area titles are hidden. Everything else in the top bar, the
rail and **Help** is the same as in [Simple mode](SIMPLE_MODE.md#how-the-studio-is-laid-out).

### Working with sliders

Every slider has a number box and a **↺** reset button:

- Type an exact value in the box. **Enter** applies, **Esc** undoes, **↑** / **↓** step (**Shift** = ×10).
- **↺** (or a double-click on the slider) puts the setting back to its default.
- Some boxes accept values past the slider's ends when you type them.

### Finding a setting

**Ctrl+K** searches every setting in every area, including the Advanced ones, and jumps to it. In the area you are
in, it hides the cards that don't match.

## Me

### Avatars

- **Import a model**: drop any 3D model here, or click. VRM, GLB and single-file glTF load directly; FBX, OBJ, BLEND,
  DAE, STL, PLY, USD and ABC are converted with Blender, which VTube Pro runs for you. After the import, the rigging check offers **Re-rig with
  Blender**, **Set up the face** or **Use as is (limited tracking)**. See [Avatars: the easy way](AVATARS_SIMPLE.md).
- Your library: click a card to load it. **✕** moves an avatar to the trash (not for built-in avatars). Each card
  shows its triangle count: orange above 170,000, red above the party limit.
- **Loaded model** (when an avatar is loaded): the rig, triangles, meshes, bones, spring joints and the face shapes it
  has, with warnings.
  - **Scale**: the avatar's size. Touch it if a model was exported tiny or huge.
  - **Turn (yaw°)**: set **180** if the model faces away from you.
  - **Raise**: moves the model up or down.
- **Real size**: how tall the character really is, as in Simple mode (**Real height (m)** and the 🧚 to 🦖 presets),
  plus the triangle count against the party limit and **Preview party version** when it is over.

### Outfits

(The same page is **Create** → **Outfit maker**.)

- The outfit grid: **None** (the base model) and each outfit. Click to wear. **Ctrl+1** to **Ctrl+9** (or **Alt**) put
  on the first nine; **Ctrl+0** takes them off. **✕** moves an outfit to the trash. **📷** renders a missing
  thumbnail with Blender.
- **Accessories**: click to wear or remove.
- **Labels**: for outfits with text on them (a name tag, a sign): edit the text. It fits itself to the label.
- **Import**: **Import costume GLB…**, a costume rigged to the same bone names as this avatar.
- **Make a new costume**: ask your AI app (see [AI connectors](AI_CONNECT.md)). It builds the outfit in Blender with
  `blender/costume_kit.py` and adds it here. Or build it yourself in Blender and use **Import**.

### Face

Placing markers turns on clickable helpers on the 3D view.

- **Test expressions**: preview poses without a camera (keys **1**–**9** for the first nine).
- **Eyes**:
  - **Source**: **Generate eyes (any model)**, **Model's own eyes** (VRM and models with eye shapes), or **None**.
  - **Replace the model’s painted eyes (tracked eyes)**: for models whose eyes are painted on the texture. It covers
    the painted eyes in memory (your file never changes) and draws eyes that follow your gaze, blinks and smiles.
    **Cover size**, **Cover ↔** and **Cover ↕** adjust the patch; **Fit to the painted eyes** fits it again.
  - **Eyes**: **Both eyes**, **Left eye only (right one hidden)**, **Right eye only (left one hidden)**, or **One
    centre eye (cyclops)** (generated eyes only). One-eyed characters can wear an **Eye patch** (**Patch colour**,
    **Strap**, **Patch size**).
  - **Eye depth** (the model's own eyes, if it has eye bones): push the eyes into or out of the face.
  - With generated eyes:
    - **Style**: **Bulb** (sits on the surface: frogs, critters), **Inset** (set into the head), **Painted** (flat
      cartoon / anime), **Anime** (gacha-style with winged lashes and a glowing iris), or **LED screen** (robot eyes).
    - **Place left eye** / **Place right eye**: click the model where the eye goes (**Esc** cancels). **Mirror left
      → right** places the right one for you. *Left* is the character's own left (on screen right).
    - **Size**, **Protrusion**, **Iris size**, **Pupil size**, **Rest openness** (lower looks sleepy), **Resting
      scowl** (a grumpy lid tilt), **Gaze range°**, the **Iris**, **Sclera** and **Eyelid** colours, **Outline** and
      **Highlights**.
    - **Anime eyes** (Anime style): **Pupil** shape (star, round, heart, cat slit), **Iris glow (bottom)**,
      **Lashes**, **Lash wing**, **Lash thickness**, **Lower lashes**.
    - **Blush**: **Cheek blush** (pink cheeks that deepen when you smile) with **Blush colour**, **Blush at rest**,
      **Blush size** and **Hatch lines**.
- **Mouth**:
  - **Source**: **Generate mouth (any model)**, **Model's own mouth**, or **None**.
  - Models with a jaw bone: **Jaw opening** (how far the jaw opens), or for glowing robots **Speech shows as** (the jaw
    moves, or the lights pulse with your voice).
  - Generated mouth: **Style** (**Sculpted** skin that moves with the jaw, **Carved** with real depth and flat anime
    teeth, or **Drawn** flat cartoon), **Place mouth**, then **Width**, **Open height**, **Jaw influence**, **Line
    width**, **Rest curve** (frown to smile), the **Lip line**, **Inside** and **Tongue** colours, and **Teeth** and
    **Tongue** on or off.
- **Look**:
  - Non-VRM models: **Shading** (**Anime** colour-tinted cel shadows with a rim light, or **Classic** grey toon), and
    for Anime: **Shadow tint**, **Rim light**, **Shadow softness**, **Hair shine** and **Nose highlight**.
  - VRM models: **Brightness**. Lower it if skin or white clothes look blown out.
- **Surface style**: the material style for the whole avatar (costumes keep theirs): fabric and puppet, toy and craft,
  hard and special, and creature styles (scales, fur). Each style shows only the controls it uses: **Pattern**,
  **Re-colour**, colours, **Pattern size**, **Relief**, **Fuzz / sheen**, **Gloss**, **Stop-motion boil**, **Fur
  length (m)** and more. **Shells** controls fur on lower graphics levels (it costs GPU). **Per part** styles single
  materials differently.

### Body & physics

- **Rig**: which skeleton the avatar uses. Unrigged models get a *soft rig* made instantly.
- **Emotes (VRMA)**: animations that play on top of your tracking (VRM or humanoid-rigged avatars). **Loop** and
  **■ Stop emote**.
- **Soft rig** (unrigged models only): **Neck height**, **Chest height**, **Hips height**, **Blend**, optional arms
  (click a shoulder, then its hand), **Re-guess**, and **Improve rig with Blender (bone heat)** for a real skeleton
  (needs Blender).
- **Physics**:
  - **Enabled**, and **Auto hair/tail/accessory springs** (bones named hair, tail, ear, skirt, ribbon, hat… swing by
    themselves).
  - **Wind**.
  - **Jiggle regions**: **Add jiggle region**, click the centre of a soft area (belly, chest, cheeks), then set its
    **Radius**, **Stiffness**, **Damping** and **Amount**. **Remove** deletes it.

## Tracking

### Camera & tracking

- **Camera**: the **Camera**, the **Resolution** (1920×1080 is recommended; 1280×720 for weaker PCs) and the **Frame
  rate** (30 or 60). **Start tracking** / **Stop**. **Use a video file…** drives the avatar from a recorded video.
  - **Track hands & fingers** and **Track body**: the **Hands** and **Body** switches of
    [Simple mode → Tracking](SIMPLE_MODE.md#tracking), not a second copy. Off stops that part's tracking right away
    (more speed) and eases it into a relaxed pose. Your face is always tracked. This browser remembers the choice
    for every avatar; it no longer changes when you switch avatars.
- **External tracking**: drive the avatar from another source instead of the webcam. **Drive the avatar from**:
  the webcam, the VTube Studio phone app or MeowFace, iFacialMocap / FaceMotion3D, Live Link Face (iPhone), the VMC
  protocol (VSeeFace, XR Animator, Warudo…) or VTube Studio API plugins. Each source has its own **Enabled** switch,
  address and port, and a live status line. Phone sources can flip turn, nod and tilt. **VMC protocol (send)** sends
  your tracking to another app. External sources fall back to the webcam if they go quiet.
  More: [Phone & external tracking](INTEGRATION.md).
- **One-step setup**: **Run expression setup test**, the 45-second test.
- **Calibration**:
  - **Calibrate neutral (2 s)**: teaches the app your face at rest. Do it whenever tracking feels off (or press **C**).
  - **Expression range wizard**: learns *your* biggest smile, frown and open mouth.
  - **Reset**.
  - **Natural mode**: on or off, and **Relearn my face** (see [Simple mode → Tracking](SIMPLE_MODE.md#tracking)).
  - **Record expression test clip (65 s)**: records your face and mic to a file on this computer, for troubleshooting.
- **Eyes tracked**: **Both eyes**, or only your left or right eye (if one is covered, for example by an eye patch).
  The visible eye then drives both avatar eyes.
- **Depth & mouth detail**:
  - **Camera field of view**: only changes how far leaning in and out moves the avatar. **Auto** is fine for most
    webcams.
  - **Tongue & teeth detection (beta)** and **Camera tongue moves the avatar tongue**.
- **Feel** (saved per avatar):
  - **Expressiveness**: how strongly all expressions show.
  - **Smoothing**: low is snappy, high is buttery (more delay).
  - **Head motion**, **Body follow** (how much the torso sways with you).
  - **Facial hair**: tell it about a beard or moustache so the lips read correctly.
  - **Mirror (like a mirror)**.
  - **Follow ←→**, **Follow ↑↓**, **Follow depth**: how much the avatar moves when you move.
  - (**Track body** and **Track hands & fingers** moved up to **Camera**.)
- **When tracking is lost**: what the avatar does when the camera loses you, separately for **Head & face**,
  **Eyes**, **Body & arms** and **Hands & fingers**: hold the last pose, return to rest, or (face and eyes) **Voice
  life**. **Loss transition** and **Recovery transition** set how gently it eases; **Grace period** waits before
  anything moves; **Ignore first frames** throws away shaky frames when tracking comes back.
- **Neck & head** (models with a neck rig): **Body** (two legs or four legs), **Neck length** (with **Short**,
  **Normal**, **Long**, **Extra long**), and **Head sway**, **Head tilt**, **Neck stiffness**, **Max head turn**,
  **Head smoothing** (each on *auto* until you move it).
- **Expressions**: **Expression boost**, **Cartoon squash & stretch** (eyes pop on surprise, the head stretches with
  the jaw), and teach buttons (hold a face for 2 seconds) with **Train on my faces** and **Reset to default**.
- **Arms & hands**: **Arm exaggeration**, **Bouncy arms**, **Finger smoothing**, **Gesture effects** (emoji bursts for
  👍 ✌️ 🤟 ✊ ☝️ 👎 and waving) and **Gesture reactions**.
  **Keep hands out of the body** (per avatar, off by default) is for bulky armour or a big chest: your hands and
  forearms rest on the body instead of passing through it, even when you touch your chest or bring your hands together.
  If they still sink in, raise **Body depth** until they rest on the armour.
- **Food & drinks (fun)**: **Detect drinks & food** (off by default) shows a matching prop when you drink and a little
  mess when you eat. **Sensitivity**, **Show props**, which drinks and foods, **Drink prop**, **Food mess**, **Mess
  style**, **Max messiness**, **Mess fades in (min)**, and preview buttons (**🧻 Clean face** wipes it).
- **Voice lip-sync**:
  - **Microphone**, **Use microphone**, **Mic sensitivity**.
  - **Noise filter**: **Standard (recommended)**, **Strong (noisy room)** or **Off (raw mic, as before)**. It runs on
    this computer.
  - **Voice sensitivity**, **Ignore background voices**, and live meters.
  - **Calibrate noise (stay quiet 3 s)**.
  - **Lip-sync lookahead**: delays your mic so mouth shapes land exactly on the sound. It shows the matching OBS
    **Sync Offset** for your mic.
  - **Browser mic processing (advanced)**: the browser's own noise suppression, echo cancellation and auto gain
    (all off by default; the noise filter above is better).
  - **Enunciation**, the **Train** buttons that teach your vowels (AAH, EEE, OOO, EH, OH), and **Reset voice**.
- **Fine tuning**: **Per-expression gain (advanced)** for single face shapes, **Performance** (the tracking level,
  the same as **Settings** → **Performance**), and **Save camera snapshots for AI help** (while your camera is on, it
  saves a camera picture, a render and numbers in VTube Pro's folder every 3 seconds; an AI app you connected to VTube
  Pro can look at them and sends them to its own company; they are never on your stream).

### Voice, phone & 2nd camera

- **Neural lip sync (experimental)**: **Turn neural on**, **Use the recommended set-up** (neural on, 60 ms lookahead
  and the noise filter), **Automatic mix** or a manual **Neural mix**, the **Lip-sync lookahead** with the OBS steps
  and a **Copy** button, and **Reset voice profile**.
- **GPU tracking**: optional extras for **NVIDIA RTX 50-series** cards only. **Set up GPU tracking** downloads a
  private Python runtime with CUDA (about 2.1 GB) and the models; **+ NVIDIA AR SDK (Maxine)** is a separate 1.35 GB
  NVIDIA installer that needs administrator rights and NVIDIA's licence. Then **GPU lip sync (Audio2Face)** and **Face
  expressions (NVIDIA Maxine)** and **Whole-body & finger pose (RTMW)** each turn on separately (RTMW is downloaded from OpenMMLab on your click; its weights were trained on research-licensed datasets). **Remove GPU files**
  removes them. More: [GPU tracking](GPU_TRACKING.md).
- **📱 Phone face tracking**: as in Simple mode.
- **🗣 My speaking profile**: what VTube Pro has learned about you (mouth style, vowels, consonants, the voice layer,
  expressions, neutral face). **Learn it now (45-second test)**, **Save a copy…**, **Load…** and **Reset mouth style**.
- **🌱 Keep learning me (optional)**: **Help VTube Pro learn how you talk and move (stays on this PC)**. Off unless
  you turn it on. **Pause** / **Resume**, **Learn now**, **Delete everything**, how much it uses for **Lip sync**,
  **Face habits** and **Motion style**, and the last versions with **Use this** / **Use standard**.
- **📷📷 Second webcam (advanced)**: **Use camera 2**, its **Role**, **Camera 2 picture**, **Camera 2 frame rate**,
  **Camera 2 face model rate (per second)**, **Keep my face when only camera 2 sees it**, **Open the two-camera
  wizard** and **Forget calibration**. More: [Two webcams](MULTICAM.md).

## Room

The **Room, seats & lights** page. Most cards need a room; with **No room** the page shows only the room picker. In a
party, only the host can change these: guests see *"You are a guest: the host runs the room"*, and can switch on
**Classic on my OBS** to show their own OBS without the room.

- **Lighting states**: the five big buttons at the top (**Shift+1** to **Shift+5**).
- **Preview**: a live picture of what OBS shows. **Big** puts it over the 3D view, **Pop out** opens a window.
- **Room**: the room picker, as in Simple mode, plus **Show test rooms** at the bottom of the list.
- **Camera**:
  - **Camera**: what the room camera frames: **Talk** (one person), **Group** (everyone present), **Wide** (the room),
    **React** (the screen), **Screen** (centred on the video), or a camera the room's maker placed.
  - **Talk frames**: who the Talk camera frames.
  - **Camera move (s)**: how long a camera change takes. **0** is a hard cut.
  - **Camera follows my entrance** and **…and guests’ entrances**.
- **Who sits where**: a map of the room's seats. Drag people onto seats (or click a person, then a seat), or use the
  **Spot** list. Seats made for another size of character are greyed out. **In** puts someone in the room or walks
  them out; **🚪 Leave the room** / **🚪 Walk in** does it for you.
- **Look**: **Avatar size**: everyone is shown at a real-world height for the room; this scales that.
- **Time & weather** (rooms with a real sky):
  - **Time of day** (type `14:30` or `2:30 pm`), quick buttons from **🌅 Dawn** to **⏱ Match my local time**.
  - **Clock**: **Moving (game clock)**, **Real local time** or **Locked (time stands still)**, and the **Speed** of
    the game clock.
  - **Weather**: buttons from clear to fog, and the mode: manual, **Automatic (changes by itself, like games)**, or
    following the lighting state (where the room supports it). **Average weather length**, **Weather change** (how
    long a change takes), **Wind**, **Lightning in storms**.
- **Eras** (rooms with eras): **Era shifts** every few minutes, **Support events shift time**, **⏳ Shift now**.
- **Graphics quality**:
  - **Avatar detail**: **Auto**, **Full**, **Lighter** or **Lightest**. For very detailed avatars (hundreds of
    thousands of triangles): the body, clothes and hair are drawn with fewer triangles where the difference is tiny
    (bent elbows and knees can show a few pixels in full-body shots); your face, expressions and lip sync never
    change. Auto keeps every triangle of normal models and gives a little more when OBS drops frames (only when that
    takes a real share off your avatar's triangles; otherwise OBS lowers its render scale as before); Lighter /
    Lightest also make non-face textures over 2K / 1K smaller, and Auto non-face textures over 4K
    when a model's textures need over 1 GB (next time the avatar loads). Applies to your own avatar only, also without
    a room (then it is a section of its own).
  - **OBS output**: **Auto**, **Low**, **Medium**, **High** or **Ultra ⚠**. This is what your viewers see. Auto picks
    a level for you (up to High unless **Auto may use Ultra** is on). Ultra is heavy: it shares the GPU with your face
    tracking, so if tracking slows down, use High or Auto.
  - **Performance options**: **Run benchmark** (about 10 seconds, needs the preview with a room), **OBS render
    scale**, **Preview render scale**, **Anti-aliasing (High / Ultra)**, **Lower quality automatically to keep the stream smooth**
    (on by default; it says so with **OK** / **Undo** when it steps down) with a **Target fps**.
  - **Auto may use Ultra**: off means Auto stops at High.
  - **Studio preview**: the same levels for the studio's own view (keep it lower than OBS to save GPU).
  - **Advanced — individual effects (High / Ultra only)**: switch single effects (bloom, ambient occlusion, light
    shafts, floor reflections, shadows, background blur…) on or off.
  - Tip: add `?gfx=high` to a Browser Source address to pin that source's level.
  - When to touch it: the avatar or room stutters in OBS → lower **OBS output** or the render scale. 
- **Lights**:
  - **Beat reactive**: lights follow the music. **Master level**.
  - **SHOW preset**: the look of the normal Show lighting.
  - **Photosensitivity-safe flashes** (on by default): at most 3 big flashes per second. Keep it on.
  - **Light delay (ms)**: line the lights up with the music.
  - **Music input**: what the lights listen to: **Off**, **Tab / screen audio…**, a built-in **Test beat**, or an
    audio input (a loopback device such as Stereo Mix or VB-Cable). Nothing is played: the lights only measure it.
  - **Music styles**: light shows that follow the music, with **Style speed**, **Strobe / white hits**, which
    lighting states they drive, and **My styles** to save your own.
  - **Groups** (the room's `LIGHT_` fixtures): each light group in the room, with its own program, **Level**, **Speed** and
    **Colour**.
- **Lighting states**: how each state looks: **Change duration (s)**, **Edit look** (pick Preshow, React, BRB or
  Outro), **House lights**, **House tint**, **Effects rig**, **Palette**, **Effects speed**, **Groups**, **Music**, and
  **Reset this look to default**. A preset browser (**🎲 Surprise me**, favourites, **Auto-cycle**) and, with OBS
  automation on, OBS scene → lighting state mappings.
- Room-specific cards appear only in rooms built for them, for example a **Space battle** (intensity, which
  battle events happen, red alert, support events that call in the fleet, test buttons) or a **Club** (DJ booth,
  background bits, celebrations). Background combat for rooms that have it is under **Chat** → **Raid**.

## Show

**Show & layout**: the show mode and where every camera, the game and the chat sit. Show modes and the layout editor
need a room.

- **Preview**, **Big**, **Pop out**: as in Room.
- **Layout editor**:
  - **Auto** or **Custom** layout for the current preset.
  - **Edit on the preview** shows boxes on the preview: drag them (hold **Alt** to place freely), or pick an element
    and use the **X / Y / W / H** sliders and the align buttons. Arrow keys move a selected box (**Shift** = 10 px),
    **Alt** + arrows resize, **Delete** puts it back to automatic.
  - **Safe margin** keeps everything away from the edges. **↺ Reset to Auto**.
- **Show mode**: **Talk** (**Shift+T**), **React** (**Shift+R**), **Gaming** (**Shift+G**), **Interview**
  (**Shift+I**), **Tabletop game** (**Shift+P**). **Shift+<** and **Shift+>** step through the current mode's layouts.
  - **React**: **Window size** (Auto, Full, Big, Medium, Side).
  - **Gaming**: **Layout** (Auto, Corner cam, Strip bottom, Strip top, Side column), the cam corner, size and
    framing, **Behind the cams** (the room, studio or cut-out), whether webcam guests show their picture, and
    **Gaming Lounge for 3+ players**.
  - **Interview** (host only):
    - **The show**: **Show title**, **🎬 Show open (Ctrl+Shift+B)**, and **Set all: 🪑 in studio** / **Set all: 📺 on
      the monitor**.
    - The line-up: up to 2 co-hosts (**★ Make co-host**) at the desk with you and up to 4 guests. For each: a name for
      the lower third, **Where** (in the studio or on the monitor; the monitor shows up to 3 people), and order. **Add
      a party member** and **+ Video guest** (someone from a call window you capture).
    - The interview guest-link box (see [Guests & parties](GUESTS_AND_PARTIES.md#interview-guests-with-a-link)).
    - **Director**: **Auto — cuts on who is speaking** or **Manual — only my cuts**, the **Pace**, and optional
      reaction cutaways, slow push-ins and snap zooms.
    - Shot buttons 1–9 (also **Ctrl+Shift+1**–**9**).
  - The **Chat panel** and **Support panel**: docked on screen automatically when the room can't show them, always,
    or never. **Chat text size**.
- **Names on screen**: **My name**, the name of this room, and (host) each guest's name.
- **Window capture** / **Game capture** (React or Gaming, with a room): one OBS step to line your capture up with the
  layout: the numbers to copy, a 12-second line-up test, and with OBS automation, **Fit my capture to the layout**.
  **Capture aspect** for ultrawide games.
- **Hide my screen (capture cover)**: **🙈 Hide my screen** (or **Ctrl+B**, the key you set in **Live** → **Privacy**) hides your
  game capture behind a card (with your text and a style), for example while you set something up. It works from
  any screen. See [The Live panel → Privacy](LIVE_PANEL.md#privacy).
- **Transitions**: the curtain that covers a room change. Pick a style (**Test** previews it), **Speed: cover-in
  (s)**, **Minimum time on screen (s)**, **Hold until I confirm** (reveal with **Shift+Enter** or **Live** →
  **Reveal**), and **Also when an OBS page (re)loads**.
- **📊 Chat poll** (host): the full poll editor: question, options with keywords, duration (up to **Until I end
  it**), **Subs / members ×2**, **Donation votes**, **Read aloud on stream**, templates (**Save as template**), live
  standings (**End now**, **Hide on stream**, **+5 test votes**) and past **Results**. VTube Pro never posts in your
  chat: viewers vote by typing.
- **Screen video**: videos on the room's screen.
  - **Screen video** on or off, **▶ Play**, **■ Stop**, **⏭ Next**, **↺ Restart**, **Video sound** and
    **Volume** (the sound plays in the studio, never on the OBS page).
  - Your video library: **Add videos…**, **Open folder**, **Refresh**.
  - A playlist for each moment (**Preshow**, **Ambience (Talk)**, **BRB**, **Outro**): add your videos, a URL, a live
    stream link, **+ OBS Virtual Camera** or **+ Window feed**; **Loop**, **Shuffle**, and whether the camera turns
    to the screen.
- **Ambient cameras**: slow camera moves during Preshow, BRB and Outro (pans, orbits, dolly, crane, handheld drift,
  a security-cam look), with **Seconds per shot**, **Motion** and **Between shots**.
- **React screen**:
  - **Screen shows**: **Auto** (recommended), **In-scene capture (always)**, or **OBS passthrough** (a hole plus your
    OBS Window Capture). With **Automate OBS** on and OBS answering, Auto lets OBS show your capture itself on a screen
    that faces the camera straight on (or with the corner-pin). That stays smooth next to a heavy game, where the
    in-room window feed can stutter on stream. A screen at an angle, one with **Glass sheen** or **Subtle scanlines**,
    or Auto without Automate OBS draws the window on the screen in the room with the fast window feed. A screen the
    camera can't see is never covered with a crooked OBS box: it shows **NO SIGNAL** in the room instead. With
    **OBS passthrough** chosen, a screen at an angle (without the corner-pin) is drawn in the room too, with your
    window from the fast window feed.
  - If the camera can't see the React screen (for example **Me**, a close-up), Live → Camera says so. Press **Auto**
    or **Screen** to bring it into the shot.
  - **Fast window feed** (Windows): a faster way to get a window onto the screen. It **needs ffmpeg** installed.
    It uses your NVIDIA graphics card (NVENC) when its driver is new enough, else your processor. When the status
    says **GPU encoder off: NVIDIA driver 610+ needed**, updating the graphics driver moves that work off your processor.
    If a setting stops it (no OBS password saved, no capture source, no window picked), the screen doesn't wait 4
    seconds on the dark "connecting…" card each time you go to React: once the camera has reached the React shot it
    switches, once, to OBS passthrough (only on a screen that faces the camera straight on) or NO SIGNAL, and the
    feed's status line says what to set. If you fix it in OBS itself (for example you pick the window in the source's
    Properties), it is checked again the next time you go to React. A whole monitor bigger than the picture (for
    example a 4K Display Capture) is sent at 30 frames a second to spare your computer.
  - **Pick a window…**, **Stop**, **Glass sheen**, **Subtle scanlines**.
- **OBS passthrough (fallback)**: your **OBS canvas** size and the exact numbers for the Window Capture under the
  hole.

## Chat

**Chat & events**: your live chat and support inside the room. The cards below need a room; without one, the area
explains that the Chat Hub, docked chat and donation read-aloud work anyway.

- **Chat & events**:
  - **Set up my chat & stream**: the guided set-up (platforms, the "I can see your chat ✔" check, alerts, chat on
    screen). See [Your chat & stream](CHAT_HUB.md#set-up-my-chat--stream).
  - **Open Chat Hub (chat + events)**: all your chats and support events in one window. See [Chat Hub](CHAT_HUB.md#the-chat-hub).
  - The connection state of Twitch, YouTube, Kick, Rumble and TikTok, and the session totals.
  - Where the chat shows: **On screen** (a chat box over your stream), **In the room** (chat screens inside the 3D
    room), **Both** (the room's chat screen, and the box whenever that screen isn't in the shot) or **Hidden**.
    **Place the chat in the room…** opens the room editor with the chat screens ready to place and resize (see
    [Rooms: the easy way](ENVIRONMENTS_SIMPLE.md#chat-in-the-room)).
  - **Chat box on stream**: when it shows (**Off**, **When active**, **Always**: every mode), where it sits (a corner,
    a side, **Bottom**, or drag it anywhere on the live picture of your stream; drag any corner to resize; it snaps to
    the edges and the middle, hold Alt to place it freely), **Applies to** (**Every room**, **This room**, or **Only in**
    the show mode you're in), its size (**Small**, **Medium**, **Large**), opacity and text size. The line under the
    picture always says which place your stream uses right now. It stays where you put it, through reloads and server
    restarts. See [Choose where your chat is](CHAT_HUB.md#choose-where-your-chat-is).
  - **Emotes & emote sounds**: your channels' emotes and optional sounds for them. See
    [Emotes and emote sounds](CHAT_HUB.md#emotes-and-emote-sounds).
  - **In the room**: **Chat monitor** (a monitor drops down where the camera sees it), **Support board** (**Off**,
    **Neon SUPPORT board** or **On the chat monitor**), the **chat buddy** (a character that walks in holding a tablet
    with your chat; **Behaviour**, **Who brings the chat?**, tablet sizes), **Place on**, **Monitor size**, **Text size**, and
    **Only drop while chat is active**.
  - **Filters & alerts**: **Hide !commands**, **Hide bots**, **Min alert $**, alerts for subs, members and gifts,
    **Show ≈ USD for other currencies**, and a **Goal bar** (**Goal label**, **Goal $**, **Reset session totals**).
  - **Test** buttons: test messages and events show only on your computer (your OBS and preview), never in your real chat.
  - **Connections**: **Kick** (**Channel**), **YouTube** (**Handle**, or a channel or video id; no Google sign-in),
    **Rumble** (**API key**, from Rumble → Account → Live Stream API), **Save + connect** and **Disconnect all**. Twitch and TikTok connect in the set-up or the Chat
    Hub. Read only: VTube Pro never posts in your chat. Keys stay on your computer.
- **Raid** (rooms with background combat): **Background skirmishes** far behind you (never in front of your face),
  their **Intensity** and **Frequency**, which factions, camera options for Preshow and BRB, and a **Donation event**
  with a minimum amount. Test buttons included.
- **🖐 Slap!** (host): **🖐 Slap! (Shift+S)** sends a character to slap someone in the room; **Who**, **Slapper**, and
  **Slap sounds** (played in the studio: Audio mixer → Room sounds).

## Games

The same game cards as in Simple mode (see [Simple mode → Games](SIMPLE_MODE.md#games)). The full tabletop panel
opens with **🎲 Tabletop game** or **Shift+Y**.

## Party

Everything for streaming together. The full guide is [Guests & parties](GUESTS_AND_PARTIES.md); this is the map of the
page.

- **How you appear**: your avatar, your webcam, VTube Studio, or a Spout2 model, and their options
  (**Show me as**, **TV motion**, **Camera**, **Quality**, the TV style, **Mirror my picture**, **Fit**, the colour
  key for VTube Studio, **Talk gestures from**).
- **Host, signed in**: **Sign out**, **Post invite in**, **Load my channels**, **Who may join**, **Required role**,
  **Auto-approve**, **My avatar goes to**, **Go live · post invite**, the interview guest-link box, **Banned** with
  **Unban**.
- **While live**: **Copy join link**, *"Guests can’t get in? Check this"*, the green room setting, and knock rows.
- **Guest**: **Share my avatar**, **Who else sees it**, the **🎙 Voice** box (**Talk in VTube Pro (no Discord)**,
  **Using Discord voice instead**, **My microphone**, **Play the call on**, **Call volume**, the mute hotkey and
  **Push-to-talk**), and the green-room card (**✋ I’m ready**, messages).
- **Most detailed avatar allowed** (host) and **Automatic party version**.
- **In the party**: each member with their connection numbers and avatar state; **Lip delay** (line their mouth up
  with their Discord voice), **Ask them to resend**, **Kick**, **Ban**, **Resend my avatar**, TV guest controls,
  **Copy diagnostics**, and **End party** / **Leave party**.
- **Advanced: invite codes (no Discord)**.
- **Discord setup (one time)**: **Your invite server address**, **Your Discord app’s Client ID**, **Save**, and **Hide my internet
  address from guests**. The easy way
  is **Party** → **Set up** or `relay\Set up my relay.cmd`: both put your invite server online on your own Cloudflare account. You also need your own Discord app. See [Hosting setup](HOSTING_SETUP.md).
- **What happens to shared avatars**.

## OBS

### Browser Source & output

The quickest way to get VTube Pro into OBS is **Set up OBS**: eight short steps that add it for you and make your
stream scenes (it is also in the first-time setup and on Home's OBS lamp). This page has every setting by hand.

- **Your OBS link**: the address for OBS, **Copy OBS link**, **See what OBS shows**, and **Framing** (**Bust (head &
  shoulders)**, **Head close-up**, **Full body**), which changes the `focus=` part of the address. **For power
  users** has the address options.
- **Output size & position** (applies to every OBS page at once): **Avatar size**, **Move ←→**, **Move ↑↓**,
  **Framing**, **Party layout** (one row, or two rows for 5+ people) and **Reset layout**. Use these when you stream
  without a room and want the avatar in a corner.
- **Party settings**: Party and Discord settings are in the **Party** area; this button opens them.
- **Party games — The Trail**: coming soon. The Trail isn't in the studio yet, so this section says **Coming soon**.
- **Studio view**: the framing of the studio's own view, and **Transparent studio background** (for capturing the
  studio window itself; **H** hides the menus). For Zoom, Meet or Discord video, use OBS **Start Virtual Camera**.

Browser Source address options (add them after `output.html?`, joined with `&`):

| Option | Does |
|---|---|
| `focus=head`, `focus=bust`, `focus=full` | Framing without a room |
| `avatar=<id>` | Pin one avatar to this source |
| `fps=30` | A lighter source for weaker PCs |
| `scale=`, `x=`, `y=` | Size and position (the studio's sliders win once you move them) |
| `gfx=low` … `gfx=ultra` | Pin this source's graphics level |

### OBS automation

Optional: VTube Pro can switch OBS scenes and line up the react screen for you. **It needs a room** (without one, this
page shows only the set-up help). **Set up OBS** connects it for you; these are the same settings by hand.

1. In OBS: **Tools** → **WebSocket Server Settings** → **Enable WebSocket server** (OBS 28 or newer). **Show Connect
   Info** shows the password.
2. Here: **Automate OBS** on, then the **Password**. You type the **WebSocket URL** and the
   password here. It stays on your computer.
3. Pick your **Window Capture**, **Browser source** and **OBS scene** (the lists fill after **Test connection**).
4. Optional: **Switch OBS scenes** with a **Talk scene** and a **React scene**, and **Perspective corner-pin** for
  angled screens (needs the free *obs-shaderfilter* plugin). If Talk and React use the same OBS scene, nothing is
  switched. A scene you pick by hand in OBS is kept until a look with a different scene comes up.
5. **Save**, then **Test OBS automation**.

**Automate OBS** only moves your Window Capture (OBS passthrough) and switches scenes. The fast window feed reads your
OBS capture source with the saved password (or with none, if your OBS asks for none), so it keeps working with
**Automate OBS** off. When you leave React, the capture goes back to where you had it (for example your Gaming
**Fit my capture** place). In Gaming it shows again if it was showing before; in Talk it stays hidden. VTube Pro
remembers your own place even if VTube Pro restarts. Problems in your OBS setup (a whole-monitor Display Capture, a
browser source with OBS's `ws://` address) show in this section even when nothing has been placed.

This section also says why your capture isn't placed. If the React screen isn't in the camera's shot, press **Auto**
or **Screen** under Camera. If the React screen is seen at a slight angle, OBS can't tilt a box to match it, so VTube
Pro draws your window on the screen in the room instead. If that screen shows **NO SIGNAL**, turn on the fast window
feed (it needs ffmpeg) or pick a window in the studio. For OBS passthrough on an angled screen, install the free
*obs-shaderfilter* plugin and tick **Perspective corner-pin**.

If your VTube Pro browser source in OBS reaches past the edge of the OBS canvas, the capture is still placed: OBS
cuts it off at the edge, just like the room. Whenever Automate OBS can't show your capture on a React screen, that
screen is drawn in the room instead (your window, or NO SIGNAL) within a few seconds. That covers a screen at an angle
a box can't match, a screen that would sit outside the OBS picture, no capture source set, and OBS failing to place
it (for example your capture source isn't in that OBS scene, or OBS doesn't answer). It doesn't stay an empty
see-through hole. With Automate OBS off, VTube Pro doesn't place anything: the capture under the hole is the one you
set up yourself (the numbers are under **OBS passthrough (fallback)** in the Scene tab).

As a guest in someone's party, Automate OBS follows the host's room: your Window Capture goes onto the host's React
screen and comes off again when the host leaves React. Interview's "Fit my Window Capture" stays where you put it until
the show changes mode.

## Create

The Simple view of Create starts with **How do you want to create?** and stays locked until an AI (or Blender) works.
See [Simple mode → Create](SIMPLE_MODE.md#create). The Advanced pages below have every builder setting.

### Avatar builder

- **What to make**: describe the character and add reference pictures (front, side, back, character sheets).
- **How** → **Builder**:
  - **Local AI 3D (ComfyUI, from a picture)**: a ComfyUI you run yourself (set its address in **Settings**). It turns ONE picture
    of your character into a plain grey 3D model with VTube Pro's **Character 3D** workflow. ComfyUI needs the Hunyuan3D model
    first. Under **Run**, the note "ComfyUI needs its 3D model first" has a **Set it up for me** button: it opens VTube Pro's
    ComfyUI workflows page on Character 3D, which lists the download and the licence notice (Tencent Hunyuan 3D Community
    Licence: not for the EU, the UK or South Korea) and downloads nothing until you press Yes. The weights are your own
    download into your own ComfyUI; VTube Pro never ships them. There is no words-only version.
    Your own ComfyUI workflow file still works: name it in `settings.json` (`"comfyWorkflow": "<file name without .json>"`, the
    file goes in the `config/comfy_workflows` folder, an API-format workflow with `{{PROMPT}}` and `{{IMAGE}}` placeholders).
    That file runs instead of Character 3D, needs none of the Hunyuan3D files, and can work from words alone. Create then shows no
    "Set it up for me".
  - **Let VTube Pro make eyes & mouth**: builds a blank face so the generated eyes and mouth animate perfectly.
- **Generate**. When it is done, the avatar loads; place its eyes and mouth in **Me** → **Advanced** → **Face**.

More: [Avatars: the easy way](AVATARS_SIMPLE.md) and [Avatars by hand](AVATARS_ADVANCED.md).

### Outfit maker

The same page as **Me** → **Outfits**.

## Settings

**Tools & credits**:

- **Status**: whether Blender and ComfyUI were found.
- **AI apps and local AI**: VTube Pro holds no AI account and no key. **Connect an AI in 3 steps** opens VTube Pro's
  guided page for your own AI app or a model on this computer.
- **Models & tools**: the **ComfyUI URL** and the **Blender path** (empty = find it automatically).
- **Save settings**.
- **Credits** for the free assets and libraries VTube Pro uses.

AI connectors (letting Claude, ChatGPT and other AI apps drive the studio) have their own guides:
[AI connectors](AI_CONNECT.md) and [Make a model with Claude or Codex](MAKE_WITH_CLAUDE_OR_CODEX.md).

## What needs an extra account, key or install

| Feature | Needs |
|---|---|
| Importing FBX / OBJ / BLEND and other non-VRM formats, re-rigging, avatars and outfits built by your AI app | **Blender** (free, from <https://www.blender.org/download/>) |
| AI avatars and outfits | Your own AI app connected to VTube Pro, or ComfyUI on your computer (see [AI connectors](AI_CONNECT.md)) |
| Local AI 3D | **ComfyUI** with its built-in Hunyuan3D nodes (Character 3D), run by you |
| OBS automation, **Fit my capture**, starting the virtual camera | **OBS 28+** with its WebSocket server on |
| Angled react screens in passthrough | The **obs-shaderfilter** OBS plugin |
| Fast window feed | **ffmpeg** (Windows) |
| GPU lip sync, Maxine faces | An **NVIDIA RTX 50-series** card; downloads of about 2–3.5 GB; Maxine needs admin rights and NVIDIA's licence |
| Interview links and Discord parties | A free **Cloudflare** account for your own invite server **and** your own free **Discord application** (see [Hosting setup](HOSTING_SETUP.md)) |
| Spout2 real alpha | Windows and **Python 3** |
| Spout2 webcam bridge | **SpoutCam** or OBS **Virtual Camera** |
| Phone tracking | Live Link Face, iFacialMocap / FaceMotion3D, the VTube Studio app or MeowFace on your phone |
| Rumble chat | Your Rumble **Live Stream API key** |
