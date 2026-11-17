# Sound on your stream (the audio mixer)

Since beta.12, every sound VTube Pro makes plays in **your studio window**: your guests' voices, read-aloud, the room
screen's video, air horns, the tabletop narrator, game sounds. **The OBS page is always silent.** This guide shows how
your stream hears all of it, and how to control every voice from one place: the **Audio mixer**.

The full details (every switch, how it works inside) are in [Voice & lip sync](VOICE.md#audio-mixer-every-voice-level-volume-mute-for-me-noise-gates).

---

## How your stream hears the studio

Think of the studio like a Discord call: it plays its sounds on your computer, and OBS records your computer's sound.
Your own voice still reaches the stream through your microphone source in OBS, as before.

**On Windows, most people have nothing to do.** OBS's **Desktop Audio** (on by default) already hears everything your
computer plays, the studio included.

**On a Mac**, OBS needs a source for your computer's sound (names as in OBS's own guide):
- **OBS 30 or newer on macOS 13 (Ventura) or newer:** add a **macOS Audio Capture** source (all desktop audio, or just
  your browser).
- **OBS 28 or 29 on macOS 13 or newer:** a **macOS Screen Capture** source also captures audio.
- **Older macOS:** a virtual audio device (VB-CABLE, Loopback or Sound Siphon) is needed.

**Check it in 20 seconds:**
1. Open the Chat Hub → **Read support messages aloud** → **Settings** and press **Test voice** (or play anything in the
   studio).
2. Watch OBS's audio mixer. The **Desktop Audio** bar (on a Mac: your audio capture source's bar) should move.
3. It moves: you're done. It doesn't: see below.

<!-- OBS source names checked 2026-10-06 against OBS's own guides: https://obsproject.com/kb/application-audio-capture-guide,
     https://obsproject.com/kb/macos-desktop-audio-capture-guide -->
**Only want the studio, not every sound on your PC?** (OBS's own words, not VTube Pro's)
- **Windows 10 (version 2004 or newer) / 11:** turn Desktop Audio off, then in OBS add a source → **Application Audio
  Capture (BETA)** → pick the browser the studio runs in. Note: that captures every tab of that browser, so play your
  own music in a different browser.
- **Mac (OBS 30+, macOS 13+):** in the **macOS Audio Capture** source, pick just your browser instead of all desktop
  audio.
- **Linux:** this guide doesn't cover it yet; capture your desktop's sound in OBS as you would for any app.

> **Never** tick OBS's "Control audio via OBS" on the VTube Pro browser source expecting sound from it: the OBS page has
> nothing to play. Leave it unticked.

**Only one studio window plays.** If you open the studio twice (two tabs, or two browsers), only one of them plays sounds, so nothing is heard twice. The mixer tells you which: *Sounds play in this
window* or *Sounds play in your other window of this studio*. Close the other window and this one takes over.

---

## Open the mixer

- The show dock → **Guests** → **Audio mixer**, or
- **Tools** → **Audio mixer**.

**What you'll see:** one row per voice, each with a level bar. Everyone starts at 100 %, nothing muted, no gate.

### Your row

- A level bar for your mic. **Too loud** lights up if it distorts: turn your mic gain down.
- **Voice filter** (Off, Standard, Strong): removes background noise from your voice for lip sync.
- **Learn my room’s noise**: stay quiet for 3 seconds and it learns your fan, hum or keyboard.

### A guest's row

| Control | What it does |
|---|---|
| **Volume** | How loud they are for you and your stream |
| **Mute for me** | You stop hearing them here. The cameras still cut to them when they talk. Use it for a guest you already hear in Discord, so they're never heard twice |
| **Mute for everyone** | Nobody hears them, and the cameras stop cutting to them (host only) |
| **Noise gate** | Cuts their background noise between words. **Auto** is the easy one: it listens for a few seconds, then cuts anything quieter than their voice. **Manual** lets you set **Cut below** yourself |
| **Clean up hiss** | Takes steady hiss and hum down a little (adds a tiny delay) |

**Hear guests here** turns all guest voices on or off in your studio.

### Show sounds

Read-aloud, the room screen's video, room sounds (air horns, slaps, poll stings, and the emote sounds you set up in
Chat → Emotes & emote sounds), games and the tabletop narrator each get a row with a meter and a volume. They appear
once they've played something.

---

## Add a sound input (a camera mic, a capture card, a second mic)

1. In the mixer, pick the device from the list and press **Add a sound input**.
2. It becomes a row with a meter, **Volume**, **Mute**, **Noise gate** and **Echo cancel**.
3. **Don't also add that device in OBS** (it would be heard twice), and wear headphones if that mic can hear your
   speakers. The row reminds you.
4. **Echo cancel** is on by default. Turn it off for a capture card or a music source.

The browser asks for permission the first time. If it's blocked, the row says so and has **Try again**.

---

## Sounds only you hear (the narrator's "Only me")

The tabletop narrator can whisper private lines to you only (**Plays on** → **Only me**). Pick your headphones as the
output on the **Only me** row. If you leave it on **Same as the studio**, OBS hears those lines too, and the row tells
you so.

---

## Read-aloud with the free Kokoro voice (optional)

Read-aloud uses your computer's free voices. You can also pick **Kokoro**, a natural-sounding free voice that runs on
your own computer (no account, no key):

1. Chat Hub → **Read support messages aloud** → **Settings** → **Voice** → **Kokoro (free, natural)**.
2. Press **Install the Kokoro voice** the first time (nothing downloads until you press it).
3. Pick a voice and press **Test voice**.

If Kokoro isn't ready, your computer's voice reads the line, so nothing is skipped.
Every detail: [Chat & stream → Kokoro voice](CHAT_HUB.md#kokoro-voice-optional-free-on-this-computer).

---

## If something sounds wrong

| What you hear | What to do |
|---|---|
| My stream doesn't hear guests or read-aloud | Check OBS's **Desktop Audio** (or your Application Audio Capture / macOS Audio Capture) is on and its bar moves. Check the mixer says *Sounds play in this window* in the studio you have open |
| A guest is heard twice | They're also in your Discord call: press **Mute for me** on their row |
| A sound input is heard twice | Remove that device from OBS: the studio already plays it |
| No sound plays at all | Click once anywhere in the studio window (browsers start sound only after a click). If the mixer shows an error, press **Try again** |
| A guest's fan or keyboard keeps switching the camera to them | Set their **Noise gate** to **Auto** |
