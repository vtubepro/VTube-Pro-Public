# Tutorials

Step-by-step walkthroughs for the things people set up most. In the studio, open **Help → Tutorials** (or the
**Tools** menu): the studio points at each button, says what to do in one sentence and waits while you do it. You can
stop any time; it remembers where you were. These are the same steps, written down.

- Start here: [First-time setup](#first-time-setup) · [Add your own model](#add-your-own-model) · [Show your avatar in OBS](#show-your-avatar-in-obs)
- Your look: [Outfits and costumes](#outfits-and-costumes) · [Pick and change your room](#pick-and-change-your-room)
- Your show: [Go live with your show](#go-live-with-your-show) · [Watch videos together](#watch-videos-together) · [Invite a guest](#invite-a-guest) · [BRB and hide my screen](#brb-and-hide-my-screen) · [Show your chat and alerts](#show-your-chat-and-alerts)
- Make things: [Make things with AI](#make-things-with-ai)

## First-time setup

Turn on your camera and microphone so your avatar copies you. About 2 minutes.

1. **Start VTube Pro.** Double-click `Start VTube Pro`. The studio opens in your browser at http://127.0.0.1:5191/. Everything (OBS, files, AI, chat) runs from this one program on your PC.
2. **Turn on your camera.** Press Start camera & mic. If your browser asks, press Allow. This is in **Tracking**. Any webcam works. Nobody sees your camera picture: viewers only see your avatar.
3. **Look at the camera.** Look at your screen. Face found turns green when the camera sees you.
4. **Turn on your microphone.** Press the button to turn on your microphone. Your avatar’s mouth then follows your voice.
5. **Your status lights.** The lights at the top show your camera, mic, OBS and room. Green means it works. Next: pick your avatar in **Me**, then do **Show your avatar in OBS**.

**If something goes wrong**

- *The camera won’t start:* Close other apps that use the camera, like Zoom, Discord or OBS. Then press Start again.
- *The browser blocked the camera:* Click the camera icon in the address bar, pick Allow, then reload the page.
- *It says “Looking for your face”:* Put more light on your face and sit a little further back.
- *The wrong camera or microphone:* Tracking, then the Advanced switch: pick the right one under Camera or Microphone.

More: [the full guide](QUICK_START.md).

## Add your own model

Bring your VRoid, VRM, GLB or FBX model. We check it and fix what we can. About 3 minutes.

1. **Choose your model file.** In **Me**, press **Add my model**, then click the big box and pick your model file. Or drop the file anywhere on the studio. VRM (from VRoid Studio) works best. GLB, GLTF and PMX open straight away; FBX, OBJ, BLEND and other 3D files are converted by VTube Pro with Blender (free). A folder or a .zip works too.
2. **We checked it.** We fixed what we could. Press Import to add it to your avatars. Want to set it up yourself? **Details** shows every fix with a switch, and **Set it up step by step instead** walks you through it.
3. **Wear it.** It’s in your avatars. Press Wear it now to put it on.

**If something goes wrong**

- *“We can’t open this kind of file”:* Export your model again as .vrm or .glb. Most 3D programs can save a .glb.
- *An FBX, OBJ or BLEND file won’t convert:* these are converted with Blender. Install Blender (free), or export a .glb instead.
- *“This file is over 300 MB”:* Make a lighter copy: fewer triangles and 2K textures. Then try again.
- *It moves as one piece:* It has no skeleton yet. With Blender installed, we add one after you save it.
- *The mouth or eyes don’t move:* Pick Set it up for me: it adds mouth shapes and fixes painted-on eyes.

More: [the full guide](AVATARS_SIMPLE.md).

## Show your avatar in OBS

Put VTube Pro into OBS once. Your avatar shows with a see-through background. About 3 minutes.

1. **Copy your OBS link.** Press Copy OBS link. You paste it into OBS next. It is in **OBS** on the left. VTube Pro must be running: OBS can only show the studio while it runs.
2. **Add it in OBS.** In OBS, press + under Sources and pick Browser. Paste the link into URL. Name the source **VTube Pro**.
3. **Size it and press OK.** Set Width 1920 and Height 1080. Leave the two boxes at the bottom unticked. They are “Shutdown source when not visible” and “Refresh browser when scene becomes active”: ticked, your avatar reloads every time you switch scenes. Use your OBS canvas size if it is different. The background is already see-through: no green screen needed.
4. **Check the light.** When OBS shows you, the OBS light at the top of the studio says **In OBS**.
5. **Want it done for you?** In **Live → OBS**, press **Set up OBS automation**. It adds VTube Pro to OBS for you. It also makes your stream scenes (Talk, React, Gaming, Interview, BRB) and switches them as you change what you are doing.

**If something goes wrong**

- *OBS shows nothing:* Keep VTube Pro running. In OBS, open the source and press Refresh cache of current page.
- *A black or white box behind your avatar:* Don’t add a chroma key. In OBS, turn on Browser Source Hardware Acceleration (Settings → Advanced).
- *Your avatar reloads when you switch scenes:* Untick both boxes at the bottom of the source’s settings.
- *It is too big or cut off:* Set the source to your canvas size, like 1920 by 1080. Then right-click it and pick Transform, Fit to screen.

More: [the full guide](QUICK_START.md).

## Outfits and costumes

Change clothes, switch outfits live with a key, and make new ones. About 3 minutes.

1. **Put an outfit on.** In **Me**, click an outfit under **Outfit** to wear it (all of them, with more options: the **Advanced** switch, then **Outfits**). While you stream, Ctrl+1 to Ctrl+9 switch outfits. Ctrl+0 takes the outfit off. The ✕ on a card moves that outfit to the trash.
2. **Describe a new outfit.** Type what you want, like “a red hoodie with cat ears”. Then press Generate costume. You can add reference pictures. It needs Blender and an AI key (Settings). No key? Ask the Claude, ChatGPT or Grok app to make it (the **Make things with AI** tutorial).
3. **Or bring an outfit file.** Have an outfit as a .glb file? Drop it on **Import costume GLB…**. It must be rigged to the same skeleton as your avatar.
4. **Change the words.** Some outfits have words on them, like a sign or a shirt. Type new words under **Labels**.
5. **Back to the short view.** All done? Turn Advanced off again for the short, simple view.

**If something goes wrong**

- *This avatar has no outfits:* Make one with Generate costume, or ask your AI app to make one.
- *Generate costume fails:* It needs Blender and an AI key. Settings shows what is missing.
- *The new outfit looks wrong:* Try clearer words or a reference picture. Remove the bad one with ✕.
- *Ctrl+number does nothing:* Click the studio once first, so the keys go to it. Number 1 is the first outfit.

More: [the full guide](AVATARS_SIMPLE.md).

## Pick and change your room

Choose a 3D room to stream from, then set its light, time and weather. About 2 minutes.

1. **See every room.** Press Change room. A list of rooms opens. It is in **Room** on the left.
2. **Pick a room.** Click a room to use it. It changes on stream right away. **No room** keeps just your avatar on a see-through background: good over a game. **Get more free rooms** at the bottom adds rooms with one click.
3. **Set the mood.** Show is your normal light. BRB dims the room while you’re away. Preshow (before you start), Show, React (dimmed for videos), BRB (be right back) and Outro (the end). Shift+1 to Shift+5 switch them.
4. **Time and weather.** Some rooms have time of day and weather. Night turns the lamps on. Who sits where, the cameras and every light are under **Advanced** at the bottom of Room.
5. **Your own room.** Have a room file? Press Add my room, or describe one for your AI below.

**If something goes wrong**

- *The room doesn’t change in OBS:* Check that OBS shows VTube Pro: the OBS light at the top must be green.
- *The room is slow or choppy:* Pick a lighter graphics setting in Settings, or a smaller room.
- *Change room is greyed out:* You joined someone’s party: the host picks the room.

More: [the full guide](ENVIRONMENTS_SIMPLE.md).

## Go live with your show

What “live” means here, the show modes, and the lights from start to end. About 2 minutes.

1. **You go live in OBS.** You start streaming in OBS, like always: **Live** (Alt+L) is your show’s remote control. The light at its top says IN OBS when OBS shows you; NOT IN OBS means viewers can’t see you yet (do **Show your avatar in OBS** first).
2. **What are you doing?** Pick Talk, React, Gaming, Interview or Tabletop. The cameras and layout follow. **Talk**: just chatting in your room. **React**: a video or stream on a big screen. **Gaming**: your game big, you in a corner. **Interview**: guests, with a camera switcher. **Tabletop game**: a game night at the table.
3. **The lights.** Preshow before you start, Show while you’re on. BRB for breaks, Outro at the end. **Preshow**: house lights off, a light show. **Show**: your normal lights. **React**: dimmed, facing the screen. **BRB**: fades to black, mutes guests, shows your Be Right Back card. **Outro**: warm afterparty lights. Shift+1 to Shift+5 switch them.
4. **Start the show.** Press Start show for the main lights. Then press Start Streaming in OBS.
5. **At the end.** Press End show twice for the outro lights. Then stop streaming in OBS.

**If something goes wrong**

- *It says Not in OBS:* Add VTube Pro to OBS first: the Show your avatar in OBS tutorial.
- *Start show didn’t start my stream:* That’s right: it only changes the lights. Press Start Streaming in OBS.
- *The lights don’t change:* The lights belong to a room. Pick a room first (the Pick and change your room tutorial).

More: [the full guide](LIVE_PANEL.md).

## Watch videos together

Put a video, stream or game on the big screen in your room. About 2 minutes.

1. **Pick a room first.** The react screen lives in a room. Press Change room and pick one.
2. **Pick what to show.** In **Room**, press **Set up the react screen**, then **Pick a window**. Choose the browser or game, then press **Share**. Its sound stays in OBS as usual: capture the game or browser audio in OBS like you always do.
3. **Which way?** Press Next. Then pick In-scene, the best choice, and press Next again. **In-scene** draws your window on the screen in the room. **OBS passthrough** is the old way: an OBS Window Capture under VTube Pro.
4. **Try it.** Press React. The screen comes down and the camera turns to it. Then press **Next** and **Finish**.
5. **Switch while you stream.** During your show, switch between Talk and React in Live (What you’re doing). Shift+R works too.

**If something goes wrong**

- *The screen stays black:* Some apps and sites block sharing. Try a different browser window or the game window.
- *My window isn’t in the list:* Open it first and don’t minimise it. Then press Pick a window again.
- *Viewers can’t hear the video:* Sound goes through OBS. Add the game or browser sound in OBS as usual.
- *After a restart it says No signal:* Browsers forget the window. Press Pick a window again.

More: [the full guide](SIMPLE_MODE.md#the-react-screen).

## Invite a guest

Send one link. Your guest joins from any browser, even a phone. About 3 minutes.

1. **Set up hosting once.** Only you, the host, do this once. Press Set up and follow the steps. It is in **Party**. It connects your own Discord app and your own free invite server (on your own Cloudflare account). About 15 minutes, one time. Guests need nothing. Full steps: [Hosting setup](HOSTING_SETUP.md).
2. **Invite someone.** Press Invite someone. We make a link just for your guest.
3. **Send the link.** Copy the link and send it to your guest. They need nothing installed. Guest on a phone next to you? **Show QR code for a phone** shows a code to scan.
4. **Let them in.** When your guest arrives, they knock. Press Let in. The knock shows in Party and in Live Control (Guests). New guests can wait in the green room until you bring them on.
5. **Interview mode.** In Live, pick **Interview**. You get a camera button for each guest.

**If something goes wrong**

- *“Connect Discord first”:* Finish the one-time Set up in Party, and sign in with Discord.
- *The guest can’t join:* Links expire. Make a new link and send it again.
- *There is an echo:* Both of you should wear headphones.

More: [the full guide](GUESTS_AND_PARTIES.md).

## BRB and hide my screen

Show a Be Right Back card, or cover your screen when something private is on it. About 2 minutes.

1. **Be right back.** In **Live → Privacy**, press **Be right back**. Your stream fades to your BRB card and guests are muted.
2. **Pick a card.** Pick the animation viewers see. You can use your own picture or video too.
3. **You’re back.** Press it again to fade back in. Shift+4 does the same.
4. **Hide my screen.** Press Hide my screen to cover your game or shared window. Your avatar stays. Use it when a password, a message or anything private is on screen.
5. **Show it again.** Press it again to show your screen. Ctrl+B works from anywhere.

**If something goes wrong**

- *Shift+4 or Ctrl+B does nothing:* Click the studio once first, so the keys go to it.
- *My game still shows:* It covers the screen in your room and the game in Gaming mode. A game added straight in OBS stays visible.
- *Nothing happens on stream:* Check that OBS shows VTube Pro: the OBS light at the top must be green.

More: [the full guide](BRB_SCREENS.md).

## Show your chat and alerts

Connect Twitch, YouTube, Kick, Rumble or TikTok. Chat and alerts show in your room. About 3 minutes.

1. **Where do you stream?** In **Chat**, press **Set up my chat & stream**. Click every place you stream. VTube Pro only reads your chat. It never posts in your chat and never needs your password.
2. **Connect.** Press the green button. Each platform shows its own short steps (no sign-in), then **Send a test message** checks it works.
3. **Try your alerts.** Press Try it to see each alert. Only your own OBS shows test alerts.
4. **Where should chat show?** Pick where viewers see your chat. Then press Finish. Later, the test buttons in **Chat** send pretend chat and alerts (never to your real chat), and **Open Chat Hub** shows every chat in one panel beside your stage.

**If something goes wrong**

- *It says waiting:* Your chat connects when you are live on that platform. Go live, then look again.
- *Alerts don’t show in OBS:* Check that OBS shows VTube Pro, and that you picked a room.

More: [the full guide](CHAT_HUB.md#set-up-my-chat--stream).

## Make things with AI

Connect the Claude, ChatGPT or Grok app. Then ask it for an avatar, outfit or room. About 4 minutes.

1. **Open Create.** AI making runs inside VTube Pro on your PC. Press **Create** on the left.
2. **How do you use AI?** Pick one. The Claude, ChatGPT or Grok app is the easiest. It is in **Create** on the left. No AI yet? **I don’t have an AI app** shows free choices.
3. **Connect your AI app.** Open your app’s row and press Connect. Then restart the app.
4. **Say hello, then ask.** Under **What do I say?**, press **Copy** and paste it into a new chat in your AI app. Then ask in plain words, like “make me an outfit with a pirate hat”.
5. **Press Approve.** When your AI wants to change something, the studio asks you. Press Approve. The studio shows **Your AI is waiting for your OK**. Nothing changes on your stream until you say so. What it is making shows up in Create.

**If something goes wrong**

- *My AI app doesn’t see VTube Pro:* Restart the AI app after pressing Connect, then start a new chat.
- *Nothing happens after I ask:* Look for “Your AI is waiting for your OK” and press Approve.
- *It says VTube Pro isn’t running:* Start VTube Pro (`Start VTube Pro`), then press Check again.

More: [the full guide](MAKE_WITH_CLAUDE_OR_CODEX.md).
