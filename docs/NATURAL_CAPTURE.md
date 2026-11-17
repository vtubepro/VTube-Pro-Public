# Natural capture: emote normally, no over-acting

Webcam face tracking usually makes performers act for the camera: big smiles, raised eyebrows, over-articulated
words. **Natural mode** learns what the performer's normal face looks like, and how big their everyday expressions are,
so a normal smile, a slight frown or a small eyebrow move reads on the avatar. Looking at chat, turning the head or
talking no longer make the avatar pull faces.

Code:

- `src/tracking/naturalCapture.ts`: the model.
- `src/tracking/faceSolver.ts`: calls `natural.observe()` and `natural.map()` inside the amplifier.
- `src/ui/naturalPanel.ts`: the Go Live card ("🙂 Natural mode") and the Track tab section.

The research behind it (why webcam pipelines push people into over-acting, and how good systems avoid it) is summarised in [VOICE.md](VOICE.md) → Round 4 and below.

**On by default** (`localStorage['vtp.natural'] = '0'` turns it off; the UI has Classic / Natural). What it learns is
stored in `localStorage['vtp.naturalCapture']` on the performer's PC. It is part of "My speaking profile", so save /
load carries it. Observer tabs learn in RAM only.

## What it does, per feature

It covers brows up, brows down, eye squint, cheek squint, eye wide, sneer, cheek puff, smile, frown, dimple, stretch,
pucker / funnel and jaw. It also covers the beard-robust lip-geometry channels (`_gSmile`, `_gFrown`, `_gStretch`,
`_gPucker`, `_gFunnel`, `_gPuff`, `_gOpen`).

1. **Relaxed face per pose.**
   - A robust recursive fit with about 70 s of memory: `neutral = θ · [1, pitch, yaw, |yaw|, |pitch|, jaw, gazeY, blink]`.
   - The jaw, gaze and blink terms only apply to brows, lids and cheeks.
   - Frames above the neutral (expressions) count at a quarter weight and are clipped to just above it. Frames below it count fully.
   - So the fit settles on the relaxed face, follows lighting drift, and removes MediaPipe's pose couplings. On the user's clip, turning the head raised `browDown` 0.17 → 0.58, and looking up raised `browInnerUp` 0.03 → 0.8.
   - It also removes the jaw coupling: brows rose on every vowel.
2. **Noise floor.**
   - The robust spread of the calm residual. Tracker wander is slow, so a frame-to-frame measure under-reads it 5–10×.
   - Dead zone = 1.5 σ, with a quadratic knee: no step, no flicker at the threshold.
3. **Typical expression size.**
   - Every sustained excursion (≥ 0.4 s, frontal pose, and for mouth channels outside speech) is an *event*. Its sustained peak is the lowest value of a 250 ms window, at its highest.
   - The range is the decay-weighted mean of the last 40 events (30-minute half-life, persisted), plus a prior worth 2 events at 40 % of the classic "full" excursion.
   - The range is clamped to 15–110 % of that full excursion, so it can never turn noise into a full expression.
   - An event that a pose or speech interrupts still counts. A held expression is cut into 4 s events.
4. **Curve.**
   - `out = 1 − exp(−k · u^γ)`, with `u = (excursion − dead zone) / range`.
   - `k` puts the typical event at a per-feature target: 0.72–0.75 for brows and eyes, 0.65 for jaw, frown and puff.
   - No hard clipping: twice the usual expression still reads bigger.
5. **Smiles stay gentle.**
   - Target 0.5 with γ = 1.3: small smiles stay small.
   - The result is never above max(classic amplifier, 0.45).
   - The user found the avatar's smile too big. On his recording the classic amplifier turned his subtle closed-mouth smile into 0.83. With natural mode, the same smile reads 0.49.
6. **Talking.**
   - Mouth channels never exceed the classic amplifier while the performer talks. Articulation isn't an expression, and the viseme engine owns the mouth.
   - The app supplies how much the performer is talking from the voice level (`FaceSolver.speaking`). Without a mic, the solver guesses it from the jaw.

## Honest numbers

Tool: `npx tsx tools/eval_natural.ts [--scale 0.45] [--passes 2]`.

The data is the user's own guided clip, replayed through the real FaceSolver. "Natural performer" is the same
performance at 45 % (and 30 %) of the facial movement, made by `tools/natural_sim.ts`: landmark and blendshape
excursions around his neutral are scaled, and the tracker's real frame noise is kept. Two passes means the solver has
seen the clip once (a couple of minutes of streaming). One pass means a cold start.

| (2 passes) | recorded, classic | 45 % performer, classic | 45 % performer, **natural** | 30 % performer, classic | 30 % performer, **natural** |
|---|---|---|---|---|---|
| Expression contrast (not smiles) vs the recorded performance | 1.00× | 0.87× | **1.00×** | 0.64× | **0.82×** |
| False expression (rest, head turns, talking) | 0.114 | 0.072 | **0.061** | 0.054 | **0.051** |
| Contrast / false | 5.1 | 7.0 | **9.5** | 6.9 | **9.3** |
| Smiles (smile, grin, smirk) vs recorded | 1.00× | 0.83× | 0.48× (gentle) | 0.69× | 0.48× |
| Rest jitter (RMS) | 0.0118 | 0.0133 | 0.0137 | 0.0119 | 0.0139 |

Per feature, for the 45 % performer (classic → natural):

| Feature | Classic | Natural |
|---|---|---|
| Angry brow-down | 0.75 | 0.86 |
| Sad frown | 0.42 | 0.66 |
| Grin jaw | 0.58 | 0.67 |
| Cheek puff | 0.90 | 0.99 |
| Closed smile | 0.66 | 0.30 |
| Grin smile | 0.85 | 0.65 |

For the recorded (over-acting) performance, switching natural mode on:

| Measure | Classic | Natural |
|---|---|---|
| Brow-down while turning the head with a neutral face | 0.318 | 0.138 |
| Brows up while talking | 0.47 | 0.40 |
| Smile while sad / angry / puffing / puckering | 0.041 | 0.011 |
| Contrast, not smiles | 1.00× | 1.04× |
| Smiles | 1.00× | 0.66× (gentler) |

**Cold start (1 pass).** Contrast for the 45 % performer 0.94× → 1.04×, but false expression is about the same
(0.087 → 0.082) and rest jitter is higher (0.017 → 0.020). The prior is close to the classic mapping, so switching it
on changes little until it has seen the performer for a minute or two.

**Not better, or not measured:**

- Eye-wide while talking went up for the recorded performance (0.04 → 0.08).
- Frown while turning the head went up slightly (0.07 → 0.10).
- The `surprised` segment isn't scored: the performer's surprise barely moved brows or lids in the recording.
- MediaPipe's blendshapes are non-linear. A truly subtle face can read even lower than the 45 % simulation, so real
  natural-performer footage is the next test. Record it with Track → Calibration → Record expression test clip, talking
  and reacting normally, then run `eval_natural.ts --clip <frames.json>`.

## Rendered before / after

`tools/natural_strip.ts` renders the sheet in an observer studio of a private tree. It needs the natural-performer
frames at `/xs/nat45.json`: `npx tsx tools/natural_sim.ts --scale 0.45 --out xs/nat45.json`. The sheets from 2026-09-26 are in the
lipsync workstream's hand-off (`natural_skyisles.jpg`, `natural_aosabi.jpg`). Camera only; the voice doesn't drive the
mouth there.

Rows: recorded / classic, 45 % / classic, 45 % / natural. Columns: relaxed, turned away, talking, smile, grin, sad,
angry, puff.

- **Turned away:** natural mode no longer drops the jaw.
- **Smile / grin:** gentler, with the grin still clearly bigger than the smile.
- **Angry and sad:** still read at 45 %.

## Tuning knobs (for developers)

- `NATURAL_SPECS` in `naturalCapture.ts`: per-feature full excursion, target, pairs and curve.
- `PRIOR_FRAC`, `R_MIN_FRAC`, `R_MAX_FRAC`, `DZ_SIGMA` (`naturalTuning.dz`) and `SMILE_CAP`.
- `FaceSolver.natural.enabled` toggles natural mode at runtime.
- `natural.summary()` / `readout()` show what it learned. They also appear in the diagnostics `state.json` as `natural`.
