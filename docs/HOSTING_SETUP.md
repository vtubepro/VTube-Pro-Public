# Set up your own invite server (Cloudflare) and your own Discord app

To host *Discord parties* or send *interview guest links*, you need your own **invite server**. Your guests join
your show through it. It only introduces the computers to each other: avatars, video and voice go straight between
them, encrypted, never through it.

Everything here is **yours**. There is no shared server and no shared Discord app:

- the invite server runs on **your own free Cloudflare account**;
- you and your guests sign in with **your own Discord application** (a free app you make in two minutes).

*Only the host does this, once.* Friends who join you need nothing. If you only join other people's parties, skip
this guide. (Interview guests who join from a web link need nothing either.)

| Step | What you do | Time |
|---|---|---|
| [Before you start](#before-you-start) | Check what you need | 1 min |
| [Step 1](#step-1-make-a-free-cloudflare-account) | Make a free Cloudflare account | 3 min |
| [Step 2](#step-2-make-your-own-discord-app) | Make your own Discord app and copy two values | 5 min |
| [Step 3](#step-3-put-your-invite-server-online) | Put your invite server online | 5 min |
| [Step 4](#step-4-tell-the-studio-and-connect) | Add the redirects, paste the address in the studio, connect | 3 min |
| [Step 5](#step-5-let-every-guest-connect) | Optional, recommended: let guests on any network connect | 5 min |
| [Check that it works](#check-that-it-works) | Two quick tests | 2 min |
| [Private links](#private-links) | Optional: links that don't show your account name | 5 to 30 min |

## Before you start

You need:

1. VTube Pro running on your PC (double-click `Start VTube Pro`; the studio opens at `http://127.0.0.1:5191/`).
2. A Discord account (to make the app and to host).
3. An e-mail address for a free Cloudflare account. No credit card is needed for the invite server.
4. For the double-click setup ([Way B in Step 3](#way-b-double-click-set-up-my-relaycmd)): **Node.js** (the LTS
   version from <https://nodejs.org>; click Next until Finish). It brings a tool called `npx` that the setup uses.

## What it costs

Nothing, for one streamer and their friends. Here is exactly what could ever cost money (checked against Cloudflare's
pricing pages on 2026-10-01; prices can change, so look again if you read this much later):

| Part | Free amount | When the free amount runs out | Could it cost money? |
|---|---|---|---|
| The invite server (a Cloudflare *Worker*) | 100,000 requests a day | Further requests fail with an error until 00:00 UTC. No charge | Only if you choose to upgrade to the Workers Paid plan ($5 a month minimum). You never need to |
| Party rooms (Cloudflare *Durable Objects*) | 13,000 GB-seconds a day. One open party room uses 0.128 GB, so that is about 28 hours of open party rooms a day | Same: errors until 00:00 UTC, no charge | Same as above |
| Connect from anywhere (optional, [Step 5](#step-5-let-every-guest-connect)) | The first 1,000 GB each month | $0.05 per GB after that | Yes, past 1,000 GB in a month. Only guests whose network blocks a direct connection use it. A webcam guest at about 2 Mbit/s uses about 0.9 GB an hour, so 1,000 GB is roughly 1,100 guest-hours a month |
| Your Discord app | Free | | No |
| Your own domain (optional, [Private links](#private-links)) | | | Yes: a domain costs money every year (often around $10 to $20 for a `.com`). Using a domain you already own costs nothing extra |

A party room is open while you host. It closes when you click **End party**, 3 minutes after your studio
disconnects, or after 12 hours at most.

## How sign-in works

When you click **Connect Discord** in VTube Pro, or a guest clicks your **Join** link:

1. The browser goes to **Discord's own sign-in page**, for **your** Discord app. The guest sees your app's name and
   clicks **Authorize**.
2. Discord sends the browser back to **your invite server** (the `/cb` address you add as a *redirect* in Step 4).
3. Your invite server swaps the code for the person's name with Discord, using your app's **Client Secret**, then lets
   the guest knock. The one-time token Discord gives is used once and dropped.

What that means:

- *Nobody else is in the middle.* Not even VTube Pro's authors: there is no shared app, no shared server.
- *Nobody gets your guests' e-mail address.* Only the name, the profile picture and the Discord id reach your invite
  server (Discord sign-in asks for `identify`, plus server membership only for members-only parties).
- *Your Client Secret lives only inside your Cloudflare account.* Never paste it into VTube Pro, a chat or a
  screenshot.
- *Interview guests* who use a no-sign-in link (`/g/…`) don't sign in at all and don't need your Discord app.
- If the Client ID or Client Secret is missing on your invite server, sign-in says so in plain words
  (*"Discord sign-in is not set up on this invite server yet…"*). See [Troubleshooting](#troubleshooting).

## Step 1: Make a free Cloudflare account

*About 3 minutes.*

1. Open <https://dash.cloudflare.com/sign-up>. Type your e-mail and a password, and confirm the e-mail Cloudflare
   sends you. (Already have an account? Just sign in.)
2. Only the first time: in the left menu open **Workers & Pages**. If Cloudflare asks you to choose a **subdomain**
   (your *workers.dev* name), pick a neutral one: only lowercase letters, digits and dashes, and never your e-mail
   name or real name. **Every guest link shows it.** See [Private links](#private-links).

That's all for now. You do not need a credit card, a domain or anything to install on Cloudflare.

## Step 2: Make your own Discord app

*About 5 minutes.* You and your guests sign in with it. It's free, and it's not a bot you have to run.

1. Open <https://discord.com/developers/applications> and sign in to Discord (that's Discord's own site).
2. Press **New Application**, type a name (guests see it when they sign in, so something like *My Show*), tick the
   box and press **Create**.
3. In the left menu press **OAuth2**.
4. Next to **Client ID** press **Copy**. Paste it somewhere safe for a moment (a note, not a chat). It is only
   digits, 17 to 20 of them.
5. Next to **Client Secret** press **Reset Secret** (confirm), then **Copy**. Discord shows it only once. It is a
   long mix of letters and digits. *This is a password. Don't share it or put it in a screenshot.*
6. Leave this page open. You will come back to add the **Redirects** in [Step 4](#step-4-tell-the-studio-and-connect),
   once you know your invite server's address.

**Optional: a bot that posts "is live · Join" in your server.** Skip it if you are happy to copy the Join link and
paste it in Discord yourself.

1. Left menu **Bot**. Press **Reset Token**, then **Copy**. This is a password too.
2. Left menu **OAuth2 → URL Generator**. Tick the scope **bot**. Under bot permissions tick **View Channels**, **Send
   Messages** and **Embed Links**. Open the address it shows at the bottom, pick your server and press **Authorize**.
3. You paste the bot token in Step 3. Without it, nothing is ever posted for you.

## Step 3: Put your invite server online

*About 5 minutes.* Pick **one** way. You will give it the Client ID and Client Secret from Step 2.

### Way A: the "Set up my invite server" page

In VTube Pro: **Party → Discord setup (one time)**, or **Settings → Guided set-ups → Set up multiplayer**, then press
**Set up my invite server**. A page opens in your browser (`http://127.0.0.1:5191/invite-server`; it only opens on
the computer where VTube Pro runs, on purpose). It has big buttons:

1. **Open Cloudflare**: a *Create API Token* page opens, already filled in. Sign in if asked, scroll down, press
   **Continue to summary**, then **Create Token**, then **Copy**. Paste it into the page and press **Connect**.
   (Cloudflare calls this key an *API token*. The page keeps it in memory for this setup only, and forgets it when you
   are done. You can delete it on Cloudflare any time: **My Profile → API Tokens**.)
2. Paste your Discord app's **Client ID** and **Client Secret** (and the bot token, if you made one) and press
   **Build my invite server**. Each step gets a tick. A brand-new address can take a minute: press **Check again**.
3. The page then shows a **host code** in big letters, like `K7QF-M2XR`. First add the redirects
   ([Step 4](#step-4-tell-the-studio-and-connect), part 1: the page shows both lines), then press **Sign in with
   Discord**. The page uses the code for you.
4. Optionally it offers TURN ([Step 5](#step-5-let-every-guest-connect)).
5. When it says **Your invite server is ready**, the address and Client ID are already saved in VTube Pro. You can
   skip to [Check that it works](#check-that-it-works).

*If it says "VTube Pro is missing its invite server files" or "look damaged", this copy of VTube Pro does not
include the ready-made invite server file. Use Way B.* (We could not confirm from the code that every copy ships it.)

### Way B: double-click "Set up my relay.cmd"

The *relay* is the technical name of the invite server. Its files are in the `relay` folder of your VTube Pro folder.

- **Windows:** double-click `relay\Set up my relay.cmd`.
- **Mac / Linux:** open a terminal in the `relay` folder and run `sh deploy.sh`.
- Want to look first? Add `-DryRun` (Windows: `powershell -ExecutionPolicy Bypass -File deploy.ps1 -DryRun`) or
  `--dry-run` (`sh deploy.sh --dry-run`). A practice run signs in nowhere, uploads nothing and saves nothing.

It asks questions. **Enter keeps the value shown in [brackets]**, so you can run it again any time.

1. **Your Discord app's CLIENT ID**: paste the digits from Step 2.
2. **Show name guests see** (optional): a name for your show. Empty means your Discord display name. Type `-` to clear.
3. **Cloudflare TURN key id** (optional): skip for now; see [Step 5](#step-5-let-every-guest-connect).
4. **Your own address**, like `join.example.com` (optional): skip for now; see [Private links](#private-links).
5. A browser window opens: sign in to **your** Cloudflare account and press **Allow**. Come back to the window.
6. It uploads the relay and prints the address (it ends in `.workers.dev`).
7. **Secrets** (passwords) are typed into a hidden prompt and never saved in a file:
   - `TICKET_SECRET`: made for you (it signs tickets).
   - `DISCORD_CLIENT_SECRET`: paste the Client Secret from Step 2 at the hidden prompt, press Enter. (Right-click
     pastes in the Windows window.)
   - `DISCORD_BOT_TOKEN`: only if you made a bot; otherwise answer no.
   - `HOST_CLAIM`: it shows a one-time **claim code** like `K7QF-M2XR`. **Keep that window open** until VTube Pro
     says you are the host. (Only a fingerprint of the code goes to your server.)
8. At the end it prints **what to paste where**: your relay address, your Client ID and the two redirect lines for
   Discord. It also checks the address answers and copies it to your clipboard (Windows).

If it stops with a red message: *"Node.js is needed"* → install it (see [Before you start](#before-you-start)) and run
it again. *"Register a workers.dev subdomain"* → do the second part of [Step 1](#step-1-make-a-free-cloudflare-account),
then run it again.

*What it saves:* your values (never passwords) go in `relay\wrangler.local.toml`, a file that stays on your PC.

### The settings, by name

You don't type these by hand with either way. This is the list, for checking.

| Name | What | Where it lives | Needed? |
|---|---|---|---|
| `DISCORD_CLIENT_ID` | Your Discord app's Client ID | A plain setting (a *variable*) | **Yes** |
| `DISCORD_CLIENT_SECRET` | Your Discord app's Client Secret | A secret, inside Cloudflare only | **Yes** |
| `TICKET_SECRET` | 32 or more random characters; signs tickets and sign-ins | A secret (made for you) | **Yes** |
| `HOST_CLAIM` | Fingerprint of the one-time claim code | A secret (made for you) | **Yes**, to become the host |
| `DISCORD_BOT_TOKEN` | Your bot's token, for the "is live · Join" post | A secret | Optional |
| `PUBLIC_NAME` | The show name guests see instead of your Discord name | A plain setting | Optional |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | Cloudflare's pass-through for guests on strict networks | A setting and a secret | Optional ([Step 5](#step-5-let-every-guest-connect)) |
| `TURN_URLS`, `TURN_SHARED_SECRET` | Another TURN server of your own (for example coturn) | A setting and a secret | Optional |
| `HOST_USER_IDS` | Discord user ids that may always host (advanced; normally empty, the claim code decides) | A plain setting | Optional |

## Step 4: Tell the studio and connect

*About 3 minutes.*

**1. Add the two redirects to your Discord app.** Discord only sends people back to addresses you listed. Open your
app at <https://discord.com/developers/applications> → **OAuth2 → Redirects → Add Redirect**, and add both (the
setup printed them for you):

```
http://127.0.0.1:5191/api/discord/callback
https://vtube-pro-relay.<your-name>.workers.dev/cb
```

The first one is for you, the host (it points at VTube Pro on your PC). The second one is for your guests: it is
your own relay address plus `/cb`. Press **Save Changes**. Without them Discord says *"Invalid OAuth2
redirect_uri"*.

**2. Paste the address and Client ID in the studio.** (Way A did this for you. Skip this part if it did.)
In VTube Pro: **Party → Discord setup (one time)**.

1. **Your invite server address**: the relay address from Step 3 (like `https://vtube-pro-relay.<your-name>.workers.dev`).
2. **Your Discord app's Client ID**: the digits from Step 2.
3. Press **Save**.

(The multiplayer setup page does the same in its **Paste & test** step, with a **Test the relay** button.)
*Never paste the Client Secret or the bot token here.* They go only into your invite server.

**3. Connect Discord and become the host.**

1. Press **Connect Discord (hosts only)**. A browser tab opens on Discord's page: press **Authorize**.
2. VTube Pro asks for the **claim code** (the one the setup printed, or the page's host code). Type it (capitals and
   dashes don't matter) and press **Make me the host**.
3. It says **You're the host of your relay ✓**. The code works once; nobody else can host on your server.

Now in **Party** you can pick a channel and press **Go live · post invite** (needs the optional bot; without a bot,
press **Copy join link** and paste it in Discord yourself).

## Step 5: Let every guest connect

*About 5 minutes. Optional, but recommended.*

Some networks block direct video connections between computers: mobile data, work or school Wi-Fi, VPNs, some home
routers. Guests on those networks see *"couldn't connect"* unless your invite server offers a pass-through that
forwards the (still encrypted) connection. Cloudflare calls it **TURN**; it's free for the first 1,000 GB each month,
see [What it costs](#what-it-costs).

1. Cloudflare dashboard → **Realtime → TURN Server → Create** (the search box at the top finds it). Give it any name.
   Cloudflare may ask for a payment method first, depending on your account; you are only charged past the free
   amount.
2. Copy the **Turn Token ID** and the **API Token**.
3. Give them to your invite server:
   - *Way A page:* its optional last step has two boxes for them (or **Turn it on** does it for you if your Cloudflare
     key allows it).
   - *Way B:* run the setup again. Paste the **Turn Token ID** at *Cloudflare TURN key id*, then paste the **API
     Token** at the hidden prompt for `TURN_KEY_API_TOKEN`. Enter keeps everything else.

You're done when your relay's `/health` page shows `"turn":true` (see below) and VTube Pro no longer shows
**No TURN on your relay**.

Then you can switch on **Hide my internet address from guests** in **Party → Discord setup (one time)**: everything
goes through TURN, so guests never see your IP address (a little extra delay).

Have your own TURN server instead (for example coturn)? See
[Guests & parties → TURN](GUESTS_AND_PARTIES.md#turn-so-everyone-can-connect).

## Check that it works

**Test 1: your relay answers.** Open your relay address with `/health` on the end in a browser, for example
`https://vtube-pro-relay.<your-name>.workers.dev/health`. You should see something like:

```
{"ok":true,"service":"vtube-pro-relay", … "ready":{"clientId":true,"clientSecret":true,"ticketSecret":true,"bot":false,"claim":"claimed","turn":false}, "signIn":{"discord":"own"} …}
```

- `ok` is `true`: it is online.
- `clientId`, `clientSecret`, `ticketSecret` are all `true`, and `signIn` says `"own"`: sign-in is set up.
- `claim` is `"claimed"`: you are the host. (`"open"` = nobody typed the code yet; `"off"` = no code was made.)
- `bot` and `turn` are optional (`true` if you set them up).

The page never shows a password, only true or false. In VTube Pro, **Test the relay** (in the multiplayer setup page)
checks the same thing.

**Test 2: a real join.** In **Party**, press **🔗 Just copy the link** (an interview guest link) and open it on your
phone or in a private browser window. You should see the guest page for your show, with no sign-in. Then try a party
link: press **Go live · post invite**, open the Join link in a private window, and sign in with Discord. You should see
your own Discord app's name, then **Authorize**. Press **End party** when you are done. (A friend who joins a party
needs VTube Pro running on their own PC.)

If something fails, see [Troubleshooting](#troubleshooting).

## Private links

### What your links show today

A guest link looks like this:

`https://vtube-pro-relay.`**`my-show`**`.workers.dev/g/eyJr…`

| Part | What it is | Private? |
|---|---|---|
| `vtube-pro-relay` | The invite server's name | Yes |
| *`my-show`* | Your Cloudflare account's workers.dev name, which you chose (or Cloudflare made from your e-mail) | *No, if it's your name* |
| `/g/eyJr…` | A random, signed invite. It contains the room, the expiry and your show name | Yes (nothing else) |

VTube Pro warns you when your address shows a name: **Discord setup (one time)** and the interview link box show
*"Your guest links show …"* with a **Private links** button.

### Quick fix: a neutral workers.dev name

*About 5 minutes, free.*

1. Cloudflare dashboard → **Workers & Pages** → **Change** next to **Your subdomain** → type a neutral name (only
   lowercase letters, digits and dashes; your show or something random, never your e-mail name) → save.
2. Your relay's address changed. Add the new `/cb` redirect to your Discord app ([Step 4](#step-4-tell-the-studio-and-connect),
   part 1), and save the new address in VTube Pro. Links you sent before stop working; make new ones.

### Best: your own domain

*About 30 minutes, plus waiting.* Your links become `https://join.example.com/g/…`: your brand, no account name at
all. You need a domain whose DNS is on Cloudflare (Cloudflare's rule for Workers custom domains). Use a
**sub-domain** like `join.` or `live.` so your main website keeps working.

#### A. Your domain is already on Cloudflare

Go straight to [Turn it on](#turn-it-on).

#### B. Your domain is at another company (GoDaddy, Namecheap, Squarespace, …)

You move only the domain's **DNS** (the address book) to Cloudflare. The domain stays registered where it is, and
your website and e-mail keep working, as long as you check the records in step 3.

1. Cloudflare dashboard → **Domains** (or **Websites**) → **Onboard a domain** (or **Add a domain**). Type your
   domain without `www` (for example `example.com`) → **Continue**.
2. Pick the **Free** plan → **Continue**.
3. Cloudflare scans your current DNS records and lists them. *Check this list carefully* against the DNS page at
   your current company:
   - your website's records (for the main domain and `www`). If your website host asks for *DNS only*, click the
     orange cloud on that record so it turns grey;
   - your e-mail records (`MX`, and `TXT` records containing `spf` or `dkim`);
   - any `TXT` records used to verify your domain with other services.
   Add anything that's missing with **Add record**, then **Continue**.
4. Cloudflare shows two nameservers, like `ada.ns.cloudflare.com` and `bob.ns.cloudflare.com`. Keep this page open.
5. At your current company, change the nameservers to those two. (Look for **Nameservers** or **DNS** in the
   domain's settings and choose *custom nameservers*.) If **DNSSEC** is turned on there, turn it off first.
6. Wait. It usually takes minutes, sometimes up to 24 hours. Cloudflare e-mails you and the domain shows **Active**.
7. Check that your website and e-mail still work.

#### Turn it on

1. Run the Way B setup again (Step 3) and type your sub-domain, like `join.example.com`, at *Your own address*. It adds
   the `[[routes]]` block for you, and asks whether to switch the old workers.dev address off: say no for now.
   (By hand: Cloudflare dashboard → **Workers & Pages** → your relay → **Settings → Domains & Routes → Add → Custom
   domain**.) Cloudflare makes a certificate, which can take a few minutes. Open `https://join.example.com/health`
   until it shows `"ok":true`.
2. Discord → your app → **OAuth2 → Redirects → Add Redirect** `https://join.example.com/cb` → **Save Changes**.
3. VTube Pro → **Party → Discord setup (one time)**: **Your invite server address** `https://join.example.com` →
   **Save** → **Connect Discord** again.
4. Copy a new interview link and check it starts with `https://join.example.com/`. Open it on your phone to test.

#### Switch off the workers.dev address

Once everything works with the new address: run the Way B setup again and answer **yes** to *Switch it off now?*, or
Cloudflare dashboard → **Workers & Pages** → your relay → **Settings → Domains & Routes** → turn **workers.dev** off.

### What else guests can see

| Where | What a guest sees | How to keep it private |
|---|---|---|
| The link's address | Your workers.dev name, or your domain | [Private links](#private-links) |
| The guest page title and heading | *Join Alex's show · VTube Pro*, where Alex is your Discord display name | Set a **show name** (`PUBLIC_NAME`). It also replaces your name in the bot's post and on the waiting screen |
| The sign-in page | Discord's page with your Discord app's name | Name your app as you like |
| The bot's post | *"Alex is live in VTube Pro"* (with your name) | Show name, as above |
| Party guests who use VTube Pro | Your Discord display name, avatar and Discord user id (they signed in with Discord to join you, as in any Discord call) | Show name hides the name and avatar on pages |
| Interview-link guests (no sign-in) | Your show name only. They never receive your Discord user id or avatar | Nothing to do |
| `/health` on your invite server | Whether each setting is present (true / false). Never a secret | Nothing to do |
| Your IP address | Peers in a direct connection can see each other's IP address | **Hide my internet address from guests**, after [Step 5](#step-5-let-every-guest-connect) |

Your e-mail address, your Cloudflare account id and your secrets are never shown to anyone.

## Updating it later

When you update VTube Pro and the app says *"Your relay is older than this feature"*, put the new relay online
again: run the Way B setup again (press **Enter** at every question to keep your values; it keeps the secrets unless
you answer yes to replacing them) or press **Update my invite server** on the Way A page. Same address, same host:
nobody is signed out. Redeploy when no party is running (a new version restarts open rooms).

To change one thing: run the setup again and type the new value. To change the Client Secret, press **Reset Secret** in
Discord, then run the setup again and answer yes to replacing `DISCORD_CLIENT_SECRET`. To make a **new claim code**
(you lost it, or someone else should host), answer yes to *Make a NEW claim code*: the old host stops being the host.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| *"Discord sign-in is not set up on this invite server yet"* | `DISCORD_CLIENT_ID` or `DISCORD_CLIENT_SECRET` is missing | Run the setup again and give both ([Step 3](#step-3-put-your-invite-server-online)). `/health` shows which one is `false` |
| Discord says *Invalid OAuth2 redirect_uri* | A redirect is missing or mistyped | Discord → your app → **OAuth2 → Redirects**: add `http://127.0.0.1:5191/api/discord/callback` and your relay address + `/cb`, **Save Changes** |
| *"Node.js is needed"* (Way B) | Node.js isn't installed | Install the LTS version from <https://nodejs.org>, then run the setup again |
| *"register a workers.dev subdomain"* (Way B) | A new Cloudflare account has no workers.dev name yet | Cloudflare dashboard → **Workers & Pages** → choose your subdomain, then run it again |
| *"Authentication error"* (Way B) | Signed in to the wrong Cloudflare account, or the window was closed | Run it again and press **Allow** for the right account |
| The Way A page says *"Open this page on this computer"* | It was opened from another device | Open `http://127.0.0.1:5191/invite-server` on the PC where VTube Pro runs |
| The Way A page says *"missing its invite server files"* | This copy has no ready-made invite server file | Use Way B |
| *"Cloudflare didn't accept that key"* (Way A) | A copy mistake, or the key was deleted | **Open Cloudflare**, make a new key, paste it |
| *"Your invite server is starting"* for more than 5 minutes | A brand-new workers.dev name is still spreading, or your network blocks it | Wait, press **Check again**; try another network |
| `/health` shows `"claim":"open"` after Step 4 | Nobody has typed the claim code yet | [Step 4](#step-4-tell-the-studio-and-connect), part 3 |
| `/health` shows `"claim":"off"` | No claim code was made | Run the setup again and answer yes to making a claim code |
| *"This relay already has its host"* | The claim code was already used | Run the setup again and make a **new** claim code, then **Connect Discord** again |
| *"That code doesn't match"* / *"Too many wrong codes"* | A typo / 20 wrong tries in an hour | Type it again (capitals and dashes don't matter) / wait an hour or make a new code |
| A guest sees *"This sign-in expired"* | They took over 10 minutes, or used the back button | Click the Join link again |
| *"Could not reach it"* after **Test the relay** | The address has a typo, or it isn't online yet | Open the address + `/health` in a browser |
| A new custom domain doesn't answer | Its certificate is still being made, or the domain isn't **Active** yet | Wait 10 minutes; check the domain shows **Active** in Cloudflare |
| Guests see *"couldn't connect"* | Their network needs TURN | [Step 5](#step-5-let-every-guest-connect) |
| *"Your relay is older than this feature"* | Your invite server predates your VTube Pro version | [Updating it later](#updating-it-later) |

Still stuck? In **Party**, **Copy diagnostics** copies the connection state of everyone. It contains no keys, links
or models, so it's safe to share. You can ask in the project's
[Issues](https://github.com/vtubepro/VTube-Pro-Public/issues) (never paste a Client Secret, bot token or API key).
