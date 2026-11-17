# Guests & parties

VTube Pro can bring other people into your show in three ways:

| Way | Your guest needs | You need | Good for |
|---|---|---|---|
| **Interview guest link** | Only a browser (phones work too). No account, no download | Your own invite server, set up once | Interviews, call-ins, a co-host for one show |
| **Party** | VTube Pro on their own computer, and a Discord account | Your own invite server and your own Discord app, set up once | Streaming together as avatars, up to 8 people |
| **Invite codes** | VTube Pro on their own computer | Nothing extra | A quick party without Discord (no TURN, so strict networks may fail) |

Everyone's OBS in a party shows the whole party. Avatars, outfits, accessories and tracking go directly from PC to PC,
encrypted. Accessories need everyone on VTube Pro 1.0.0-beta.5 or newer; older apps still see the outfit.
Your invite server (the *relay*) only helps the PCs find each other. Nobody's avatar is ever saved on anyone else's PC (see
[Model custody](#model-custody)).

Being the guest yourself, on a show that doesn’t use VTube Pro? See [Be a guest on someone else’s show](#be-a-guest-on-someone-elses-show).

## The one-time set-up: your invite server and your Discord app

The interview link and parties both run on **your own** invite server (the technical name is *relay*): a tiny free
program on your own Cloudflare account. You and your guests sign in with **your own Discord app**, which you make for
free at discord.com/developers. Only the host does this, once. Nobody else's server or app is involved.

Follow [Hosting setup](HOSTING_SETUP.md). It explains every click for people who have never done this, what it
costs (nothing on the free plans), and how to keep your links private. In short:

1. Make a free Cloudflare account ([Step 1](HOSTING_SETUP.md#step-1-make-a-free-cloudflare-account)).
2. Make your own Discord app and copy its Client ID and Client Secret
   ([Step 2](HOSTING_SETUP.md#step-2-make-your-own-discord-app)).
3. Put your invite server online, with the **Set up my invite server** page or by double-clicking
   `relay\Set up my relay.cmd` ([Step 3](HOSTING_SETUP.md#step-3-put-your-invite-server-online)).
4. Add the two redirects to your Discord app, paste the address and Client ID in **Party** → **Discord setup (one
   time)**, press **Connect Discord** and type your claim code
   ([Step 4](HOSTING_SETUP.md#step-4-tell-the-studio-and-connect)).
5. **Optional**: let guests on any network connect ([Step 5](HOSTING_SETUP.md#step-5-let-every-guest-connect)).

You can change the address later in **Party** → **Discord setup (one time)**.

> **Set up TURN too.** Without TURN, guests on mobile data, work or school Wi-Fi, VPNs or strict routers cannot
> connect. See [TURN](#turn-so-everyone-can-connect). It is free on Cloudflare and takes a few minutes.

> **Private links.** A relay on a free *workers.dev* address shows your Cloudflare account's workers.dev name in every
> guest link. Pick a neutral name (never your e-mail name), or use your own domain: see [Hosting setup → Private links](HOSTING_SETUP.md#private-links).

## Interview guests with a link

Your guest opens a link in any browser, types their name, allows camera and microphone, and presses **Join the show**.
You let them in. They appear on a projector screen or the show's monitor in your room, and you talk over the link: no Discord
call needed.

### Send the link

Any of these gets you a fresh link:

- **Home** → **Invite a guest**, or the **Party** card → **✉ Invite a guest**. This opens the *Your guest link is
  ready* sheet: the link is already copied, with **Share…** and **Show QR code for a phone** (a scannable picture of the guest link, so a guest can open it on their phone).
- **Live** → **People** → **Copy guest link**.
- **Party** → the **🎙 Interview guests (no VTube Pro needed)** box → **✉ Invite someone…** (the same sheet), or
  **🔗 Just copy the link**. The box shows once you're signed in to host.

If you are not hosting a party yet, copying a link opens one quietly for you (nothing is posted in Discord).

In the guest box you also find:

- **Guests per link**: **1 person**, **2 people**, **3 people** (the default) or **5 people**. Reconnecting doesn't
  count as a new person.
- **Link works for**: **10 min**, **30 min** (the default) or **1 hour**, remembered in this browser. Every guest link
  expires: after that time nobody new can join with it (guests already in stay in). A link also ends with the
  party. Need longer? Make a new link.
- After you copy a link: the link, how long it has left (for example **Expires in 24 min**), **New link (old one stops
  working)** and **Turn link off**. In the sheet these are **Make a new link** and **Turn link off now**.
- **Copy Discord sign-in link (verified)**: the same, but the guest signs in with Discord first, so their
  name is verified. The plain link shows their typed name as *not verified*. This link isn't on the timer: it works
  while your party is open.
- **🎥 Use their Discord camera instead…**: ask your guest first, because their Discord video goes on your stream.
  They install nothing. You share your Discord call window, drag a box over their video tile and name them. They appear in your room like a webcam guest. Up to 4. (No voice level comes
  with it, so no talk gestures or automatic cuts for them.)

### What your guest sees

The page is titled *Join Alex’s show* (with your show name instead of Alex). Your guest:

1. Types their name under **Your name, as everyone will see it**.
2. Clicks **Turn on my camera** (or **No camera? Join with a name card instead**; *More options* has **Share a window
   instead** and **My model is in a Spout2 app**).
3. Checks the **Camera** and **Microphone**. **Talk through this page** is on by default; they turn it off only if
   they are also in your Discord call.
4. Presses **Join the show** and waits for you to let them in.

Under **More options** they can choose to appear as a **📽 Projector screen** (the default), a **🚶 Walking TV**, or
(with a Spout2 model) **🧍 My model standing in the room**, and pick a quality and a TV style.

While they wait in your green room, their page says so, and they can press **✋ I’m ready** and send you a short
message. They have a **🎙 Mute** button and a mute hotkey (**M** by default, **Set hotkey** changes it, with a
push-to-talk option). A browser tab only hears its hotkey while it is in front, so **⧉ Pop out a mute button (stays on
top)** gives them a small always-on-top mute button.

Their picture and voice go only to you and your other guests, encrypted, and are on your stream once you bring them
on. VTube Pro doesn't record or store them; if you record, or your platform saves the stream, they're in that video.
Their page says *You're on Alex's show* and that viewers see them only while you stream. They need no account, and
the name they type reaches only you. If the link can't be used, their page says why in plain words: **This invite link
has expired** or **This link is full**. Send them a new link.

### Let them in

In **Live** → **People**, a *"… is knocking"* row appears: **Let in** or **Deny**. If you use a green room (link
guests wait there by default), they wait there until you click **Bring on**. See
[The Live panel → The green room](LIVE_PANEL.md#the-green-room).

## Talking with guests (no Discord needed)

- **Link guests** talk over the link by default. You hear them in the studio (**Hear them**), and they hear you
  (**They hear me** turns on by itself when one arrives).
- **App guests** (party members running VTube Pro) have **Talk in VTube Pro (no Discord)** on by default. They pick
  **My microphone**, **Play the call on** and a **Call volume**, and mute with the **🎙 Mute** button or **Alt+M**
  (changeable, with push-to-talk). If they are already in your Discord call, they tick **Using Discord voice
  instead** so nobody hears them twice.
- **Guests hear each other** too: everyone on air hears you and every other guest, but never themselves. Guests
  waiting in the green room hear nothing and nobody hears them (except backstage talk with you).

### How guest voices reach your stream

Like a Discord call: you hear guests in the studio window, and OBS picks them up the same way it picks up Discord
(your desktop or application audio capture). VTube Pro never sends a guest's voice to the OBS page: guests play only in
the studio. The controls are in the **Live** panel's **Audio** tab (**People** has an **Open Audio** button): **Hear
them**, **They hear me**, and the microphone guests hear. See [The Live panel → Guest voice](LIVE_PANEL.md#guest-voice).

- **Audio mixer** (the show dock → **Guests** → **Audio mixer**): every guest's level, their volume, **Mute for me**
  (you don't hear them, the cameras still follow them: for a guest who is also in your Discord call) and a noise gate
  for each guest. See [Voice → Audio mixer](VOICE.md#audio-mixer-every-voice-level-volume-mute-for-me-noise-gates).
- **Use headphones.** Otherwise guests hear themselves echo.
- If you see **⚠ Guests can’t hear each other — click to start**, click once anywhere in the studio window. Browsers
  only start sound after a click.

## Parties with Discord

A party is up to 8 people (you plus 7 guests) streaming together as avatars. Everyone runs VTube Pro on their own PC;
everyone's OBS shows the whole party.

### Host a party

In **Party** (Advanced shows every option):

1. Signed in? If not, **Connect Discord (hosts only)**.
2. **Post invite in**: pick the channel for the **Join** post (click **Load my channels** first), or *don't post*
   and share the link yourself.
3. **Who may join**: **Anyone with the link (Discord sign-in only)**, or only members of your server. With a server
   picked, **Required role** limits it to members with certain roles (right-click a role in Discord → **Copy Role
   ID**).
4. **Auto-approve**: let allowed people straight in. Off means you approve each knock.
5. **My avatar goes to**: **Everyone I let in**, or **Only verified server members**.
6. **Go live · post invite**. If you gave your invite server **your own bot's token** (optional, see
   [Hosting setup → Step 2](HOSTING_SETUP.md#step-2-make-your-own-discord-app)), the bot posts *"🎙 … is live in
   VTube Pro"* with a **Join** button. No bot? Click **Copy join link** and paste it in your Discord channel
   yourself.

While live: **Copy join link**, knock rows (**Let in** / **Deny**), and **New guests wait in the green room**
(**Link guests (default)**, **Everyone** or **Nobody: straight in**). Reloading the studio does not end the party;
**End party** does.

### Join a friend's party

You need nothing set up. Keep VTube Pro running on your PC, then:

1. Click **Join** on your friend's post (or the link they sent you). A page asks you to sign in with Discord, on
   Discord's own page, for your friend's Discord app. Only your name, picture and Discord id go to your friend's
   invite server, never your e-mail.
2. Your studio asks *"Join …’s party?"*. Choose how you **Appear as** (your avatar, or your webcam / VTube Studio
   model on a walking TV or projector screen), whether to **Share my avatar** with the host for this session, and
   **Who else sees it**. Then **Join**.
3. Wait to be let in.

If the browser page couldn't reach VTube Pro, paste the link from that page into **Party** → **Joining someone?
(paste a join link)** → **Join**.

In the party, **Share my avatar** off makes everyone drop your model at once (you stay in the party).

### How you appear

At the top of the party section, **How you appear**:

- **🧍 My VTube Pro avatar**: your normal avatar.
- **🎥 My webcam** or **🎥 VTube Studio**: your live picture on a **🚶 Walking TV** or a **📽 Projector
  screen** that comes down beside the host. VTube Studio's virtual webcam shows up as *VTubeStudioCam*. A colour key
  cuts out the background.
- **✨ Spout2 (VSeeFace / VTube Studio / Warudo…)**: your model from another VTuber app, see [Spout2 guests](#spout2-guests).

The host can override how each TV guest appears.

### Invite codes (no Discord)

**Party** → **Advanced** → **Advanced: invite codes (no Discord)**:

1. Both people type **Your name**.
2. The host clicks **Host with codes**. The invite code is copied: send it to your friend.
3. The friend pastes it, ticks **Share my avatar with the host for this session** if they like, and clicks **Join
   with invite**. A reply code is copied: they send it back.
4. The host pastes the reply and clicks **Connect reply**.

Codes connect directly, with no TURN: very strict networks can block them, and peers see each other's IP address.

### Avatar size limits in parties

Everyone renders everyone, so the host sets a limit:

- **Most detailed avatar allowed** (host): from 20,000 to 500,000 triangles. The default is 200,000.
- **Automatic party version** (on by default): an avatar over the limit is shared as a lighter copy. The face, eyes,
  mouth shapes, rig and textures are kept; the body and clothes are simplified first. Your original file never
  changes. **Preview** shows the party version; **Regenerate** makes it again.
- A model file over 256 MB can't be sent at all.

**Me** → **📏 Real size** shows your triangle count against the limit.

## Spout2 guests

Bring a model from another VTuber app (VSeeFace, VTube Studio, Warudo, VNyan, Animaze) into the party or your own
rooms. **Party** → **How you appear** → **✨ Spout2 (VSeeFace / VTube Studio / Warudo…)**, then pick **Your app**.

Two ways:

- **✨ Real alpha (this PC)**: VTube Pro reads the Spout2 picture directly, transparency included.
  - **Needs:** Windows, and **Python 3** (any version from python.org or the Microsoft Store; nothing else to
    install). Your VTuber app and VTube Pro must run on the same graphics card (on laptops with two GPUs, set both to
    the same one in Windows graphics settings).
  - Steps: in your app, turn on its Spout2 output with a transparent background. In VTube Pro, **Refresh senders**,
    pick it under **Spout2 sender**, **Start**. Choose **🧍 Standing in the room** and set **Your model’s height**.
  - **Show me in my own rooms without a party** (on by default) shows your Spout2 model in your own rooms too.
- **🎥 Webcam bridge (SpoutCam / OBS)**: turns the Spout2 picture into a webcam, for when real alpha isn't available
  (or for browser guests). It needs **SpoutCam** (free, from the official Spout project) or OBS's **Start Virtual
  Camera**. There is no transparency, so a colour key (green, magenta or blue) cuts out the background.

If real alpha isn't available, the panel says why (for example *"Needs Python 3"*) and suggests the bridge.

## Be a guest on someone else’s show

You are the guest, and the streamer whose show you join **doesn’t use VTube Pro**. You make one link and send it; they
paste it into OBS (or Streamlabs, Meld, XSplit: any app with a browser source). Your avatar then shows up in their OBS on
a see-through background, moving with your face, like any other source they can move and resize.

- *They install nothing and sign in to nothing.*
- *Your avatar file never leaves your PC.* Only the finished picture is sent, like a normal stream.
- *The link is silent.* Talk to them on Discord as usual.
- *Your game comes first.* Nothing is drawn while their OBS isn’t showing the source. If your graphics card gets busy,
  the picture gets simpler (540p, 15 frames a second) instead of slowing your tracking or your game; the card says so.

**Needs:** VTube Pro running on the computer with your camera, your own invite server, and Google Chrome or Microsoft
Edge on that computer (Edge comes with Windows).

### Send the link

1. **Party** → **Be a guest on someone else’s show** → **Turn on**.
2. Press **Copy link** and send it to the other streamer (Discord is fine). The link is hidden on the card so it can’t
   show on stream; **Show the link** opens it if you want to read it.
3. They add it in OBS: under **Sources** press **+**, choose **Browser**, paste the link as the **URL**, set **Width** to
   1280 and **Height** to 720 (1920 and 1080 for **Picture quality** 1080p), leave **Shutdown source when not visible**
   off, and press OK. The card shows the same steps.

While it connects, their OBS shows a plain sentence: “Waiting for Hana’s PC…”, “Waiting for Hana to say yes…”, “Your OBS
is too old to show this”, or a hint to turn on hardware acceleration if their OBS can’t draw the picture.

### The settings

- **Picture quality**: 720p at 30 frames a second (the default) or 1080p at 30 (sharper, uses more of your PC). Changing
  it doesn’t need a new link.
- **Delay my picture**: holds your picture back in their OBS (0 to 600 milliseconds). Your voice comes over Discord and
  usually arrives a little later than the picture, so raise this until your mouth lines up with your voice. It applies at
  once; no new link.
- **Your name**: optional, shown in their OBS while it connects (“Waiting for Hana’s PC…”).
- **Turn off by itself**: never, or after 1, 2, 4 or 8 hours of nobody watching. It never turns off during a show. A link
  nobody used for a day turns itself off, and the card says so.

### Who may use the link

The first OBS that opens the link owns it. If any other OBS opens it, the card asks **Allow** or **Block**, and a
notification pops up with the same two buttons while the Party area is open. **Allow** lets it in; **Block** refuses
it for 10 minutes; no answer for 30 seconds counts as **Block**. One link shows in two places at most.

**New link** and **Turn off** are always on the card while a link exists. **New link** stops the old link at once and
forgets who was allowed. **Turn off** kills the link; **Turn on** later makes a new one. Don’t show the link on stream: if
it leaks, press **New link**.

### Your internet address

When your invite server has a relay, your home internet address stays hidden: the picture goes through it and neither
side sees the other’s address. If only a basic connection server is available, the card says so in plain words: the other
person’s OBS can see your home internet address while it is connected. The card’s last line before the steps tells you
which one you have. To get relay support, set up [TURN](#turn-so-everyone-can-connect).

## TURN: so everyone can connect

Many networks (mobile data, work and school Wi-Fi, VPNs, some home routers) block direct connections. A TURN server
passes the connection along when that happens. Without it, those guests see *"couldn’t connect"*.

**Option A: Cloudflare (free tier):** the first 1,000 GB each month are free. Step by step:
[Hosting setup → Step 5](HOSTING_SETUP.md#step-5-let-every-guest-connect). In short: make a TURN key in Cloudflare
→ **Realtime** → **TURN Server** → **Create**, then give its **Turn Token ID** and **API Token** to your invite server
(run `relay\Set up my relay.cmd` again, or use the **Set up my invite server** page).

**Option B: your own TURN server** (for example coturn with a shared secret). Cloudflare dashboard → **Workers &
Pages** → **vtube-pro-relay** → **Settings** → **Variables and Secrets** → **Add**:

- `TURN_URLS`, type *Text*: your server's addresses, for example `turn:host:3478?transport=udp,turns:host:5349`;
- `TURN_SHARED_SECRET`, type *Secret*: the shared secret.

Save.

To check: open your relay address followed by `/health` in a browser. `"turn":true` under `ready` means TURN is on.

**Hide my internet address from guests** (in **Party** → **Discord setup (one time)**): every connection goes through TURN, so peers never see
your IP address. It adds a little delay and needs TURN set up; without TURN it is ignored.

## Model custody

What happens to avatars in a party, in plain words:

- Your avatar travels encrypted, only to the people you allow.
- It is kept in memory only: never saved to anyone's disk, never exportable.
- It is deleted the moment you leave, stop sharing, are removed, or the party ends.
- **Honest limit:** this is not DRM. A PC that shows your avatar has it in memory while it draws it, so a determined
  person with GPU capture tools could still copy it. Only share with people you trust.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| *"couldn’t connect — their network needs TURN"*, or **⚠ No TURN on your relay** | The guest's network blocks direct connections | Set up [TURN](#turn-so-everyone-can-connect) |
| *"couldn’t connect even through TURN"* | Their network blocks TURN too | Ask them to try another network (home Wi-Fi, no VPN) |
| *"Connect Discord first"* when copying a guest link | The link runs on your invite server | Do the [one-time set-up](#the-one-time-set-up-your-invite-server-and-your-discord-app) |
| *"Your relay is older than this feature"* | Your relay was deployed before guest links existed | Update it once: run `relay\Set up my relay.cmd` again (Enter keeps your values) |
| Discord says *Invalid OAuth2 redirect_uri* | A redirect is missing from your Discord app | Add your relay address + `/cb` (and `http://127.0.0.1:5191/api/discord/callback`) under Discord → **OAuth2** → **Redirects** |
| *"Can’t host yet"* | You haven't become the host of your relay yet | Sign in with **Connect Discord**, then type your claim code in **Party** and press **Make me the host**. Lost it? See [Hosting setup → Step 4](HOSTING_SETUP.md#step-4-tell-the-studio-and-connect) |
| A guest sees *"The host is still setting up"* | A relay secret is missing (the ticket secret, or your Discord app's Client ID or Client Secret) | Run the setup again and give all of them; see [Hosting setup → Troubleshooting](HOSTING_SETUP.md#troubleshooting) |
| *"Members only"* | The guest isn't in your server or lacks the role | Check **Who may join** and **Required role** |
| *"You can’t join this party"* | The guest is banned | **Banned** → **Unban** |
| *"This join link has expired"* | Join links last 10 minutes and work once | Click **Join** in Discord again |
| A link guest sees *"This invite link has expired"* or *"This link is full"* | The link's time ran out, you made a new one, or everyone it was made for joined | Send a new link |
| Nothing is posted in Discord | Your invite server has no bot token (optional), or your bot isn't in your server | Copy the join link and paste it yourself, or add a bot ([Hosting setup → Step 2](HOSTING_SETUP.md#step-2-make-your-own-discord-app)) |
| Someone can't see your avatar | It didn't arrive | **Resend my avatar** on your own row; the host can **Ask them to resend** |
| *"… app is outdated"* | Different VTube Pro versions | Update everyone to the same version |
| Guests echo or play twice on stream | Speakers, or a guest is also in your Discord call | Headphones; **Mute for me** on that guest in the Audio mixer |
| **⚠ Guests can’t hear each other — click to start** | The browser waits for a click | Click once in the studio window |
| Mouth out of sync with a friend's Discord voice | Discord's voice delay | **Lip delay** on their row in the party list |
| A TV shows *NO SIGNAL* | Their camera stopped, or their upload is too slow | Ask them to restart the camera or pick a lower **Quality** |

When asking someone for help: **Copy diagnostics** in the party list copies the connection and avatar-transfer state
of everyone. It contains no keys, links or models.

Setting up the relay went wrong? See [Hosting setup → Troubleshooting](HOSTING_SETUP.md#troubleshooting).
