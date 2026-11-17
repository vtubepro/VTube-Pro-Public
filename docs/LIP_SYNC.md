# Best lip sync for me

VTube Pro can pick the best lip sync for your model and your computer. It takes about two minutes.

Open it from any of these:

- **Help** (top right) → **Best lip sync for me**
- **Me** → **Find my best lip sync**
- **Tracking** → **Find my best lip sync**
- **First-time setup** → the **Voice & expressions** step → **Find my best lip sync**

It has three steps:

1. **Step 1 of 3:** we check your setup. Press **Show my best setup**.
2. **Step 2 of 3:** pick a level. Press **Use Basic**, **Use Good** or **Use Best**.
3. **Step 3 of 3:** say four short lines and get a score. Press **Try it now**.

## What it checks

1. **Your model.** Can its mouth talk, round its lips, and press them shut for M, B and P?
2. **Your computer.** Your processor, memory and graphics card.
3. **Your microphone.** Is it on? Bluetooth headset mics sound muffled, so lip sync is less exact.
4. **Your camera.** Is it on, and is face tracking keeping up?

Your browser can only tell us a little about your computer. Press **Check in detail** for a closer look, then
**Yes, check my computer** (or **Not now**). VTube Pro then reads your graphics card, memory and processor.
Nothing is saved or sent anywhere.

## The three levels

| Level | What you get | Good for |
|---|---|---|
| **Basic** | The mouth follows your voice and face. A noise filter keeps fans and keyboards out. | Any computer. Laptops while gaming. |
| **Good** | Everything in Basic. Shapes land right on time, and the 45-second test tunes it to your voice. Natural mode shows small real smiles. | Most desktops. The sweet spot. |
| **Best** | Everything in Good. The camera also sees your teeth and tongue. With an NVIDIA RTX 50-series card, your graphics card moves the whole mouth like a real face. | Strong computers with room to spare. |

With an **RTX 50-series** card and the one-time GPU setup done, VTube Pro asks once: "Your NVIDIA card can run better lip sync. Turn
it on?" Nothing starts until you press **Turn on**, and never while you are live. Your answer is kept (also if you clear your browser);
you can change it any time in **Tracking -> GPU lip sync**. An **RTX 20, 30 or 40-series** card can try it there too: it is offered
with a "not tested on this card" note and is never asked about. On any other computer the browser lip sync does the job.

We mark one level **Best for you**. Press **Use Basic**, **Use Good** or **Use Best** to switch it on. You can change
it any time.

### Good and Best need one change in OBS

Good and Best show each mouth shape a moment later, so the lips can close and round before the sound, like a real
mouth. Delay your mic in OBS by the same amount, so viewers hear you right on the mouth:

1. In OBS, open **Audio Mixer**, then the **⋮** menu on your mic.
2. Pick **Advanced Audio Properties**.
3. Set **Sync Offset** to the number the guide shows (60 ms, or 100 ms with GPU lip sync).

Friends in a party hear you without that delay, so for them the mouth runs a touch late. That is expected.
If you go back to Basic, set the Sync Offset back to 0 ms.

With Good and Best the camera also checks that your lips really close on M, B and P. This works with a normal
30 fps webcam too, and when a busy computer slows face tracking down.

## When a level is a stretch

You can always pick a higher level than we recommend. If it is more than your computer comfortably handles, we tell
you exactly what you may notice first, for example:

- "May lag on stream."
- "Uses a lot of graphics power while gaming."
- "Needs the studio server running on your computer."
- "Needs an NVIDIA RTX 50-series graphics card."

Then pick **Pick the safe option** or **Use it anyway** (or **Back**). Parts that can't run on your computer at all
are left out, and the guide says which. You can switch back any time from **Help** → **Best lip sync for me**.

## Try it: say these words

The last step shows four short lines. Say each one out loud and watch the mouth.

- A bar shows how loud your voice is. Nothing is recorded or played back.
- A small drawn mouth shows what your avatar's mouth receives. Your avatar moves too.
- Press **Start the test**. The next line comes by itself.
- At the end you get a score out of 100 and up to three tips. Press **Test again** or **Change my level**.

| Line | What it checks |
|---|---|
| “Bob bought a map” | Lips press for B, M, P; the mouth opens |
| “Five fluffy veggies” | The lower lip tucks under the teeth for F and V |
| “Who knew? Ooh!” | Round lips for OO |
| “See these cheese” | Wide lips for EE |

A low score usually means one of these: the mic is too far away, the noise filter is off, or your model has no shape
for that sound. The tips tell you which.

## Your model's mouth matters

| Your model has | What lip sync can show |
|---|---|
| Full face shapes (52, "perfect sync") | Everything, including GPU lip sync |
| Its own mouth shapes | Almost everything |
| Vowel shapes only (A I U E O) | Talking looks right; lips can't fully press for M, B and P |
| A jaw that opens | Open and close. Great for robots and puppets |
| No mouth shapes | Press **Fix my model** in the guide: **Add my model** adds a drawn mouth |

## A mic, a cup or your hand in front of your mouth

A microphone on an arm, a pop filter, a cup or your hand can hide your mouth from the camera. The camera then can't
see your lips. It guesses, and it guesses "closed".

VTube Pro notices when your lips are hidden:

- Your voice moves the mouth on its own, the same as with the camera off. It opens as wide as usual.
- When your lips show again, the camera joins back in within a moment.
- Food & drink ignores a mouth it can't see. A mic in front of your face is never taken for a drink or a snack. A mug
  you pick up from the desk and drink from behind the mic still counts.
- If your mouth is hidden for a while and the microphone is off, you get one tip: turn on **Tracking** →
  **Voice lip-sync** → **Use microphone**.
- **Tracking** → **Voice lip-sync** shows it live: "The camera sees your mouth", that something is in front of it, or
  that the mouth check is paused.

You don't need to set anything up. The check needs face tracking to have time to spare, though. On a slow computer, or
a webcam that gives fewer than about 24 pictures a second (many do in a dim room), it pauses itself. While it's paused,
only a hand over your mouth is noticed (when hand tracking is on and running), not a mic or a cup, and the status line
says so. More light on your face (so the webcam can run at full speed) or closing other heavy programs can bring it
back.

It compares the colour of your lips with the skin right around them, in your own light, so a dark room or a deeper
skin tone doesn't make your mouth read as covered. If your lips are almost the same colour as the skin around them, it
can think they are covered at first, until it sees your mouth open once. After that it knows how your lips look.

## Check my computer (other heavy features)

**Help** → **Check my computer** uses the same check for other features that need a strong computer. It's also on
the **Best lip sync for me** card in **Me** and **Tracking**. Press **Check in detail** there for VTube Pro's closer
look. It covers:

- **Lip sync**: the level we recommend.
- **High and Ultra graphics**: glow, soft shadows, colour grading. Picking High or Ultra in the graphics settings also
  shows this warning when it is a stretch.
- **GPU tracking**: your graphics card helps read your face and body (NVIDIA RTX 50-series).
- **Local AI**: AI that runs on your own computer. We tell you if it fits next to a live stream.

## Details for the curious

What each level switches on (the same settings you find under **Tracking → Advanced → Voice, phone & 2nd camera**):

| Part | Level | Setting |
|---|---|---|
| Mouth follows your voice | Basic | microphone lip sync on |
| Noise filter | Basic | voice filter Standard (only turned on if it was off) |
| Sound shapes | Basic | voice model on, automatic mix |
| Face tracking quality | Basic | Low / Medium / High to suit your computer (never lowered on Good or Best) |
| Shapes land on time | Good | lip-sync lookahead 60 ms (100 ms with GPU lip sync) |
| Tuned to your voice | Good | suggests the 45-second test |
| Natural mode | Good | on |
| Teeth and tongue | Best | mouth-interior camera analysis on (it pauses itself if face tracking slows) |
| GPU lip sync | Best | Audio2Face on (needs an RTX 50-series card and the one-time GPU setup) |
| Something in front of the mouth | All levels | mouth visibility on (a 64 × 64 look at the mouth 15 times a second; pauses itself while face tracking is busy; `localStorage vtp.mouthVis = '0'` turns it off) |

The check reads: your model's face shapes, the number of processor threads, memory,
the graphics card your browser draws with (your browser rounds memory down), whether WebGPU is available, and, only if you say yes, VTube Pro's
read-only scan. The scan result stays in VTube Pro's memory until it closes. See also [Voice & lip sync](VOICE.md) and
[GPU tracking](GPU_TRACKING.md).
