# Streaming from a second PC

Some streamers use two computers: a **gaming PC** (your camera, the game, VTube Pro) and a **stream PC** (OBS, which
sends the stream out). VTube Pro works with that. Your avatar shows up in OBS on the stream PC over your **home
network**. Nothing goes over the internet, and nothing extra is installed on the stream PC.

## Set it up (about two minutes)

On the **gaming PC** (the one with VTube Pro and your camera):

1. Open the studio → **OBS & stream** → **Streaming from a second PC**.
2. Turn on **Let my stream PC connect**.
3. On Windows, if it asks: press **Let my stream PC through** and choose **Yes** when Windows asks. (Only once.)

On the **stream PC** (the one with OBS):

4. Open any web browser and type the address the gaming PC shows, for example `http://192.168.1.20:5191/streampc`.
5. Type the 6-letter code the gaming PC shows. Press **Connect**.
6. Press **Copy OBS link**. In OBS: **Sources → + → Browser**, paste the link as the URL, Width **1920**, Height
   **1080**, OK.

Done. Your avatar appears in OBS on the stream PC with a see-through background, exactly like on one PC.

**Even easier:** if VTube Pro already controls your OBS (scene switching), point it at the stream
PC's OBS: in the card press **Connect to OBS on my stream PC** (the address is filled in for you; on the stream PC,
OBS → Tools → WebSocket Server Settings → Enable, and Show Connect Info for the password), then **Set up OBS for me**.
VTube Pro adds the Browser Source on the stream PC by itself, already connected.

## Two ways to draw

You pick in the card under **How it draws**. You can switch any time; OBS follows by itself.

| | What happens | Pick it when |
|---|---|---|
| **On the stream PC** (recommended) | The stream PC's graphics card draws your avatar and room. The gaming PC only tracks you, so your game keeps all its power. | Almost always. |
| **On this PC, send the finished video** | The gaming PC draws everything and sends finished video to the stream PC over your network. The see-through background is kept. | The stream PC is old or has a weak graphics card. Uses more of the gaming PC's graphics card. A wired network is best. |

The OBS link is the same for both, so you never have to change it in OBS.

## Good to know

* Both PCs must be on the **same home network** (same router). A wired cable is best; Wi-Fi works.
* The **React screen** (the window you react to): with "On the stream PC", share the window in the studio as usual
  and it shows on the stream PC. The extra-fast window feed needs "On this PC, send the finished video".
* With "On this PC, send the finished video": the room, avatars, room-change transitions, polls, 2D avatars and
  your BRB picture all come through. Tabletop (TTRPG) text captions show only with "On the stream PC".
* **Party guests** show up on the stream PC too. Their avatars stay in memory only, like on one PC: nothing is saved
  on the stream PC.
* Your phone tracking, Stream Deck and everything else stay on the gaming PC as before.
* To stop: turn the switch off. To remove one stream PC: **Forget this stream PC**. Its link stops working at once.

## When something doesn't work

| What you see | What to do |
|---|---|
| The stream PC's browser says the page can't be reached | Both PCs on the same network? On the gaming PC the card must say "Ready". On Windows press **Let my stream PC through**. |
| The card says Windows treats the network as **Public** | Press **Open network settings**, click your network, choose **Private network**, then **I switched it**. |
| "That isn't the code" | Use the code shown on the gaming PC right now (codes change after 10 minutes or after use). |
| "Too many tries" | Wait a few minutes, then use the newest code. |
| OBS shows "This stream PC isn't connected to VTube Pro yet" | Do steps 4 to 6 again on the stream PC, then paste the new link into the Browser Source. |
| OBS shows "This stream PC was disconnected on your gaming PC" | Someone pressed Forget. Connect it again (steps 4 to 6) and paste the new link. |
| The avatar is there but doesn't move | Turn your camera on in the studio on the gaming PC. |
| Windows asked for permission (a prompt to allow changes) and you pressed Cancel | Press **Let my stream PC through** in the card once more and choose Yes. |
| "On this PC" mode: "needs Google Chrome or Microsoft Edge" | Install one of them on the gaming PC (Windows already has Edge), or use "On the stream PC". |
| "On this PC" mode: the picture stutters | Use a cable instead of Wi-Fi, or switch to "On the stream PC". |
| The gaming PC got a new address (after a router restart) | Nothing to do on the gaming PC. On the stream PC, connect again (steps 4 to 6). |

## How it stays safe

* **Off by default.** While the switch is off, VTube Pro only listens on the gaming PC itself, exactly as before.
* When on, it listens on your home network address only (never a VPN or the internet), and answers **only computers
  on the same home network** that were connected with the code. The code is shown only on the gaming PC, works once,
  runs out after 10 minutes and locks after too many wrong tries.
* A connected stream PC is **display only**: it can show your stream, never change it. Exactly this is open to it, and
  only for reading:
  - the OBS page itself and the app files it needs;
  - your avatars, rooms, room edits and props (read only), the show's current state, output size, polls, chat props,
    your BRB picture, room videos, your own transitions, and the 2.5D overlay you picked around a 2D avatar (the
    overlay list, adding and deleting overlays stay on the gaming PC);
  - party guests' avatars, still locked (it unlocks them in memory only, nothing is saved);
  - the live tracking, and the window share / TV / video links it receives.
  Everything else answers "only on the gaming PC": settings, keys, AI tools, installs, your library, OBS settings, the
  firewall, updates, pairing, and any address written in a tricky way (capitals, extra slashes, encoded characters).
* What a stream PC page may **say** on the live connection is limited too: "I am an OBS page", its graphics quality, a
  transition status, and its own side of a video link. It can't send tracking, change the room or the scene, send
  commands, play show sounds (horns, stings, slaps), move the live-video clock, or take the show's sound. VTube Pro
  stamps every video-link message with that stream PC's own id and only accepts its own network address in it, so it
  can't close or take over another page's window share, TV or video. Each connection gets one window share, one TV
  link and one video link at most, and a stream PC holds a few connections at most, so it can't make the gaming PC
  encode the picture over and over (saying hello again never restarts a link that works). It can watch one Spout
  picture and can't restart one other pages are watching.
* It never moves or hides anything in OBS: on a stream PC the React screen is drawn in the room.
* Chat emote pictures it asks for come only from the chat sites' own servers (no redirects) and are not saved on the
  gaming PC.
* Other websites open on the stream PC can't use the connection: the address it asks for must be this PC's (not a
  look-alike name), a page from another site is refused, and a browser that says the request comes from another site
  ("cross-site") is refused, also for live connections.
* On Windows the firewall rule covers Private networks, your own network only, VTube Pro's port and program only.
  Nothing listens on a network Windows hasn't marked Private.
* The stream PC's link is a long secret: keep it private. After the first visit OBS proves itself with a cookie, so
  the link isn't repeated in other addresses. Forget the stream PC on the gaming PC and the link stops working at once.

---

*For developers:* server/streamPc.ts (listener, gate, pairing, mode B renderer), shared/streamPc.ts (the allow-list
and checks), server/streamPcPages.ts (pairing + receiver pages), src/streamPcSend.ts (mode B sender), src/ui/streamPcCard.ts.
Tests: `npx tsx tools/streampc_unit.ts`, `node tools/streampc_e2e.mjs --out <dir>`.
