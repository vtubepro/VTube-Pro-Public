# Going live

VTube Pro can put you on air with one click. This guide says how, what it checks first, and why nothing can start
your stream behind your back.

## The one rule

**A stream starts only when you click.** You press **Go Live**, you read the card that opens, and you press **Start**.
That is the only way. (A Stream Deck key works too, but you still confirm on screen. See [The Stream Deck key](#the-stream-deck-key).)

These can never start a stream, a recording or a test:

- an AI helper or any AI tool
- a timer or a schedule
- a Stream Deck key you did not confirm on screen
- a message from a friend, a guest or the relay
- an update, a restart or a crash
- a command typed in a window

A crash is no exception. If VTube Pro or your computer's streaming engine crashes in the middle of **your** show, VTube
Pro does not put you back on air. When you open it again, it asks: "You were live; go live again?" You answer with a click.
If your stream kept running in OBS the whole time, VTube Pro simply picks the show up again. It starts nothing.

Go Live also only works in a VTube Pro window of its own. If another website frames the studio inside its page, VTube Pro
refuses to ask for a Go Live or a recording, and the studio refuses to load inside that page.

## Before your first show

1. Open **Live** and find the **Go Live** tab.
2. Under **Which one do you stream with?** pick **My OBS**. (The VTube Pro Live Engine says "coming soon".)
3. Add where you stream. Pick its chip:
   - **Twitch, YouTube, Kick, TikTok or your own server**: paste your stream key once. The page tells you where to
     find it. The key is kept locked on your computer and is never shown again. There is no account sign-in: VTube Pro
     never asks you to log in to Twitch or any other site, and it does not set your stream title or category for
     you (set those on the site itself).
4. Press **Check my setup**.

## Check my setup

**Check my setup** is a short list. Each row is green, amber or red. A red or amber row has one **Fix** button.
Press it and VTube Pro does the fix, or opens the one place you need.

- Green: nothing to do.
- Amber: you can still go live. Go Live asks you to accept it.
- Red: Go Live waits until you fix it.

## Go Live

1. Press **Go Live**.
2. A card shows exactly where you are going, with your title and category. Read it.
3. Press **Start**. You are on air.

A timer shows how long you have been live. The **health** tile uses plain words, for example "Smooth", "Your network
is struggling", "Your graphics card is busy" or "A source went black". It never shows numbers. If it says something
is wrong, it also says what to do.

Your OBS sends to one place at a time, so you pick one place to stream to. If the connection drops, OBS tries again on
its own timing. The tile says "Trying again" and shows a wait that counts 2, 4, 8, 15 and then 30 seconds. That wait is a
guide for you, not a promise of when OBS tries.

You cannot change **Which one do you stream with?** while you are live. End the show first.

## Test it first

Not sure it looks right? Run the 10-second private test. The picture and the mic meters go to a file on your
computer only. Nobody sees it, and no platform is touched.

The test needs a small test receiver on your computer. The **Try a 10 second private test** button is shown only
when VTube Pro finds one (a set-up made for testing). A normal install has none, so the button is not shown there.
Use **Check my setup** instead.

## While you are live

- **End Show** needs two presses. The first press turns the button into **Press again to end the show**. The second press stops the stream in about 2 seconds. If you wait too long, the button goes back and nothing stops.
- **Record** saves a copy on your computer. Starting a recording needs your click too.
- **Save last 60 s** keeps the last minute as a clip, when OBS has its replay buffer on.

## The Stream Deck key

Add the **VTube Pro Go Live** key from the VTube Pro plugin in the Stream Deck app. Installed the plugin before beta.16? Install it again
from Stream Deck and controllers to get this key (see [Stream Deck and controllers](STREAM_DECK.md)).

1. Press the key. It says **Confirm on screen**.
2. The VTube Pro studio opens its Go Live tab with a card: **Your Stream Deck asked to go live**. Press **Go Live now**
   within 10 seconds. The card appears in VTube Pro on this computer. It only appears when the VTube Pro studio is open.
3. If you do not, the key goes back and nothing starts.

The key can ask. Only your click on the screen can start. If VTube Pro is closed, the key says so and does nothing.
A key inside a Stream Deck multi-action is not offered, so it cannot sit in a chain with other keys.

## What this protects, and what it does not

The rule stops websites, other devices, AI tools, timers, macros, messages and updates. It does not stop a program that
you installed or let run on this computer under your own account and that deliberately pretends to be the VTube Pro
page: that program can already read your files and control OBS directly. Only run programs you trust.

## Your stream key is safe

A stream key is a password for your channel. VTube Pro:

- keeps it in an encrypted vault on this computer, locked to your Windows account
- never shows it again after you save it
- never puts it in a log, a support file, a message to another person or a web page
- only hands it to your streaming program at the moment you press **Start**

Keys and a changed stream address are accepted only from the VTube Pro page on your own computer.
No other program can add or change keys: a script, a Stream Deck or Companion HTTP action or an AI tool that talks to
VTube Pro without being that page is refused with "local only". Do it in VTube Pro on your computer.

Honest limit: OBS keeps its own copy of the key in its settings. The Go Live tab says this in one line. When you
Go Live, VTube Pro first remembers what your OBS was set to stream to (in memory only, never on disk) and puts it
back when the show ends: after **End Show**, or when the stream stops. If OBS cannot hand that over, VTube Pro says "I could
not save your OBS stream settings first, so I changed nothing" and does not start. Your OBS stays as it was. If VTube Pro itself restarts in the middle of
a show, that memory is gone, so OBS keeps the show's settings. The VTube Pro Live Engine will keep the key in memory
only.

## Updates wait

VTube Pro never restarts itself for an update while you are live, recording, or while a show it started is running. The
update waits until you press **End Show**.

## If something goes wrong

| You see | What it means | What to do |
|---|---|---|
| "Paste your Twitch stream key" (or another site's) | There is no key saved for that place yet, or you removed it. | Press **Finish setup** on its chip and paste the key. |
| It says another program is already live | OBS or the engine is already streaming. | End that stream first, or pick that one under **Which one do you stream with?**. |
| Go Live stays grey | A row in **Check my setup** is red. | Press its **Fix** button. |
| The key says "Open VTube Pro" | The studio is closed. | Open VTube Pro, then press the key again. |

More: [The Live panel](LIVE_PANEL.md), [Stream Deck and controllers](STREAM_DECK.md).
