# Voice front-end (noise filter, voice gate, fricatives)

> Live captions reuse this front end's 16 kHz stream and gate flag (no second mic capture): [LIVE_CAPTIONS.md](LIVE_CAPTIONS.md). DeepFilterNet was evaluated there and not added (RNNoise stays).

Everything runs locally in the studio tab. Nothing leaves the PC.

```
mic ──► high-pass 80 Hz (4th order) ──► RNNoise (48 kHz, 10 ms frames) ──► voice gate × level normaliser ──► analyser
            │                 │                    │ per-frame VAD                  ▲                           │
            │                 └─► fricative detector (raw 512-pt FFT, 10 ms) ───────┤ (raw hiss passes through)  ▼
            └─► 16 kHz decimator ─► Silero VAD v5 (worker, 32 ms windows) ──────────┘            SpeechAnalyzer (unchanged)
                                                                                                  + held-fricative merge
                                                                                                  → AudioMouth / visemes
```

| Piece | Where | Thread |
|---|---|---|
| HPF, RNNoise, gate, normaliser, fricative detector | `src/audio/voice/voice-worklet.js` | audio render thread (AudioWorklet) |
| Silero VAD | `src/audio/voice/vadWorker.ts` + `sileroVad.ts` | its own Worker; the worklet talks to it over a MessagePort (never via the main thread) |
| Graph, settings, persistence, public bus | `src/audio/voice/voiceFrontEnd.ts` | main (setup only) |
| Held-fricative merge | `src/audio/voice/fricMerge.ts` | main, inside `AudioLipSync.sample()` |
| Mic plumbing, fallback | `src/tracking/audioLipSync.ts` | main |
| UI (Tracking → Advanced → Voice lip-sync) | `src/ui/voiceFilter.ts` | main |
| Runtime files | `public/vendor/voice/` (`rnnoise.wasm`, `silero_vad_v5.onnx`, `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.{mjs,wasm}`) | — |

The existing viseme / phoneme analysis (`SpeechAnalyzer`, `VisemeClassifier`) is unchanged: it simply reads the
front-end's output, which is the denoised speech, normalised to −20 dBFS for the performer's usual level, over a
constant quiet floor (−58 dBFS) whenever the gate is shut. So the mouth can't move for anything the gate rejects.

## The gate

* **Fast attack** — RNNoise's per-frame voice probability (plus level) opens the gate. RNNoise delays its audio by one
  frame, but the gate decides on the *undelayed* input, so it has 10 ms of look-ahead: first syllables aren't clipped.
* **Silero confirms / cancels** — an opening Silero hasn't confirmed is provisional; if the next two 32 ms windows
  stay under the cancel threshold it closes (keyboard, clicks, lip smacks). Confirmed speech holds the gate with a
  120 ms hangover.
* **Speaker level** — the gate learns the performer's level (upper envelope of confirmed speech, persisted in
  `localStorage['vtp.voiceFx.state']`). With *Ignore background voices* on, a word must start within ~10 dB of it
  (Standard; 6 dB Strong; +8 dB at full sensitivity). A TV / stream on speakers / someone across the room is typically
  15–25 dB quieter at a close mic and is ignored (the meter shows “bg”). The reference never sinks because of quieter
  voices; it only follows a mic-gain change (the room floor dropping for good). *Calibrate noise* forgets it and
  relearns from the next sentence.
* **Normaliser** — gain = −20 dBFS − performer level (−12…+30 dB), so quiet and loud performers drive the mouth alike.

## Fricatives (F / V / S / Z / SH / TH)

RNNoise treats unvoiced frication as noise and Silero doesn't call a lone "fffff" speech, so a raw-signal detector runs
in parallel: hiss above ~2 kHz that dominates everything below (unvoiced), or rides on voicing with far more energy
above 5.5 kHz than any vowel (V / Z / ZH); broadband-flat (F/TH) or sharply peaked (S/SH); continuous (clicks are
single spiky frames); above its own adaptive floor (fans, white noise). In and right after words any fricative-shaped
frame counts; a standalone held sound needs 40 ms of continuous hiss at near-mic loudness. While it is on, the raw
(pre-RNNoise) signal is passed to the analysis so it hears the hiss, and once held for ≳ 50 ms its class is blended into
the visemes for as long as the sound lasts. Class: S/SH are loud (≈ 15–20 dB under your vowels) and peaked, S peaking
above ~4.5 kHz, SH lower; F/TH are weak and flat. TH vs F can't really be told apart acoustically (split 25/75; the
camera re-splits the family in `VisemeFusion`).

## Settings (`localStorage['vtp.voiceFx']`)

| Setting | Default | Notes |
|---|---|---|
| Noise filter | **Standard** | Off = the previous raw analysis, byte-for-byte. Strong = stricter gate, no dry mix under RNNoise |
| Voice sensitivity | 0.5 | shifts every VAD threshold ±0.15, the level windows, and the fricative thresholds |
| Ignore background voices | on | speaker-level window above |
| Browser noise suppression / echo cancellation / auto gain | off | measured worse (see below); changing them reopens the mic |

## Latency

* Added audio latency: **19.3 ms** (one RNNoise frame + ≤ 9.3 ms of 128-sample quantum buffering), measured by
  cross-correlation through the real worklet. The mic still leads the camera by ~60 ms.
* Silero: 0.4–0.8 ms per 32 ms window in its worker (≈ 2 % of a core). Worklet: ≈ 2 % of a core
  (0.05 ms per 128-sample quantum on average, budget 2.67 ms). Main-thread `sample()` cost unchanged (≈ 0.2 ms).
* Browser WebRTC processing (EC/NS/AGC) adds a separate processed capture path: **+36 ms** in a headless
  fake-device measurement, and with our front-end on it *raised* false mouth-opens on keyboard noise (NS 4.5 %,
  AGC 6.1 %, all three 24 % vs 0 % without). Hence off by default.

## Fallback

`VoiceFrontEnd.create()` throws if the context isn't 48 kHz or `rnnoise.wasm` / the worklet can't load →
`AudioLipSync` connects the mic straight to the analyser exactly as before (`app.audio.fxError` says why; the meter
panel shows it). If only Silero fails the gate runs on RNNoise's VAD alone.

## API for other consumers (multiplayer bridge, remote smoothing …)

```ts
const off = app.audio.voice.onFrame((f) => {
  f.t;          // performance.now() ms
  f.vad;        // 0..1 voice probability (Silero; RNNoise VAD while Silero loads; 1/0 when the filter is off)
  f.gate;       // boolean — the voice gate is open (it's the performer talking)
  f.level;      // 0..1 speech energy envelope (what opens the mouth)
  f.visemes;    // { sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, L, W, aa, E, I, O, U } — sums to 1
  f.mouth;      // { open, wide, pucker, funnel, fv, sib, closure } voice-only mouth hints
  f.fricative;  // { cls: 'FF'|'TH'|'SS'|'CH'|null, conf 0..1, voiced (V/Z/ZH), held (s), probs }
  f.filtered;   // true when the front-end is active (false = raw legacy analysis)
});
off(); // unsubscribe
app.audio.voice.latest;          // newest frame (or null)
app.audio.fx?.stat;              // raw audio-thread numbers (~50 Hz): raw / dn dBFS, vad, p, gate, bg, ref, gain, fric…
await app.audio.setVoiceSettings({ filter: 'strong', sensitivity: 0.6, ignoreBg: true });
await app.audio.calibrateNoise(3);
```

Frames are emitted from `AudioLipSync.sample()`, i.e. once per studio render tick while the mic is on (the same
cadence the local avatar uses). Visemes are the voice's own (before camera fusion). The frame is a fresh object each
tick; keep what you need.

## Measuring

The benchmark lives in `tools/eval_voice.ts` (+ `voice_sim.ts` which runs the real worklet file in a Node `vm` and the
real Silero model through onnxruntime-web, `noises.ts`, `fric_synth.ts`):

```
npx tsx tools/eval_voice.ts                         # before/after table on cache/diag/clip.webm + synthetic noises
npx tsx tools/eval_voice.ts --only keyboard,music --modes old,standard --cfg sensitivity=0.7
VTP_MUSIC=path/to/music.mp3 VTP_VOICE2=path/to/other_voice.mp3 npx tsx tools/eval_voice.ts   # adds music/TV/second-voice cases
```

## Voice pitch + voice life (mic-only face)

`SpeechFeatureExtractor` also reports **f0** (the periodicity search it already ran, octave-checked: shortest lag
peak within 8 % of the best, parabolic sub-sample lag). `SpeechAnalyzer` keeps the performer's running log-f0
median and emits `AudioMouth.f0` (Hz, 3-frame median) and `.pitch` (semitones vs that median, ±12); `SpeechFusion`
puts it on voiced frames as `frame.mouth.pitch` (absent otherwise). Cost ≈ +0.02 ms per 60 Hz frame.

`src/avatar/voiceLife.ts` (`VoiceLife`) replaces the old random idle blink / gaze whenever the face is **not tracked**
— mic-only performers, or a tracked face that is lost for a moment. From the voice envelope + pitch + time it drives
blinks (≈ 17/min listening, ≈ 25–29/min talking, gamma intervals, kept off loud syllables, ≈ 45 % of phrase-final
pauses and ≈ 20 % of utterance starts, gaze-evoked, fast close / slower open), gaze (on the viewer ≈ 77 % of the time,
aversions at utterance starts, back on emphasis / phrase ends, main-sequence saccades, micro-saccades, lids follow
the eyes down, the head helps on big shifts), head (idle sway < 1° under 0.25 Hz, breathing, a relaxed tilt / turn
per phrase, a damped beat nod on each pitch accent / stressed syllable, riding the pitch, a tilt on question-like
final rises), outer-brow raises on a share of accents, a light smile / cheek lift with lively speech and a one-sided
mouth corner. It never touches the mouth shapes, seals or timing (the viseme engine's). Presence fades in over
≈ 0.35 s when the face is lost, out over ≈ 0.15 s when it returns, and the head's jump back to the re-found pose is
eased (≈ 120 ms) instead of snapping.

* The studio's runtime applies it and publishes the result (`frame.life` = presence) to the OBS output page, which
  then shows the preview's exact blinks / gaze / head; pages that get unmarked untracked frames (party guests, a
  stalled studio) run their own. Party guests get pitch-less frames → energy-only accents.
* Per avatar: `profile.speechMotion` strengths `nod tilt turn brow blink asymmetry gaze smile sway` (1 = default,
  0 = off), `voiceLife: false` → legacy idle life. Global off switch: `localStorage['vtp.voiceLife'] = '0'`.
  (With the camera tracking, the opt-in `SpeechMotion` layer is unchanged.)
* Measure: `npx tsx tools/eval_voicelife.ts` (mic-only naturalness stats vs the legacy idle life, + face lost /
  found hand-over on the camera clip), `npx tsx tools/eval_rig_nocam.ts [--root <tree>]` (bilabial seals / F / S /
  rounding / jaw lag through the real viseme rig, camera+mic vs MIC ONLY).

## Lip-sync lookahead (optional, default off; "Better" = 60 ms since round 4)

Tracking → Advanced → Camera & tracking → Voice lip-sync → **Lip-sync lookahead** (`localStorage['vtp.lipLookahead']`, ms; `src/tracking/lipLookahead.ts`).
Delay the mic in OBS by the same amount (Audio Mixer → ⚙ on the mic → Advanced Audio Properties → **Sync Offset = D ms**;
the panel shows the exact value). The mouth is then shown D ms late — on the audio viewers hear — and uses that D ms of
future voice: lips seal before M/B/P (≤ 60 ms ahead), round before O/U/W (≤ 150 ms), part slightly before a word from
silence (not before M/B/P), and an isolated < 60 ms blip in silence is damped. It also hides the analysis envelopes'
own ~17 ms lag. Off (0) = the input passes through untouched. Discord / party guests hear the undelayed voice, so their
view of the mouth runs D ms late (within the ~185 ms "acceptable" window at 80–100 ms).
Measured (`tools/eval_rig_nocam.ts --lookahead D`): jaw lag vs the heard audio 17 → 0 ms at D = 50–117 ms; M/B/P lips
shut with the camera 10/11 → 11/11; F tuck 3/4 unchanged up to 117 ms (2/4 at 120 ms) → **80–100 ms recommended**.

## Neural lip sync evaluation (2026-09-25) — not enabled

`tools/eval_neural_lips.ts` runs wav2arkit_cpu (tools/vendor, Apache-2.0) through onnxruntime-web on the test clip, as a
teacher (whole clip) and as a live stream (1 s window every 100 ms, frame shown D ms before the window end). On this
clip it does **not** beat the viseme engine: held "aa" jawOpen 0.04–0.05 (ours 0.82), M/B/P jaw < 0.05 in 2–7/11
events (ours 11/11), no useful cheek / smile / brow detail (talk RMS ≤ 0.015), jaw↔loudness corr 0.54–0.64 (ours 0.65),
and it costs ≈ 1.5 CPU cores (148 ms per 1 s window, wasm ×2). Audio2Face-3D Claire's `network.onnx` does run on
onnxruntime-web (60 ms per frame, wasm ×2 → ≈ 1.8 cores at 30 fps), but it needs a 0.52 s window centred on the frame
(≈ 260 ms lookahead) and outputs PCA geometry that still needs the SDK's blendshape solve — offline teacher material
only. Rhubarb (MIT) is wired as a second opinion: `tools/eval_rhubarb.ts` (reference cues in `tools/fixtures/`); on the
32 hand-labelled events Rhubarb itself scores 17–18/32 vs the engine's 25/32, so the hand labels stay the primary truth.

## Round 3 (2026-09-25): synced camera closures, camera lip seals, neural visemes, personal voice model, Live Link Face

Harness tables and the full report: `tools/eval_rig_nocam.ts`, `tools/eval_neural_visemes.ts`, `tools/eval_nv_personal.ts`,
`tools/eval_mouth.ts` (its truth now comes from a solver with the new camera seal off, so trees with and without it are
scored against the same truth).

### Synced camera lip closure (on; acts only with the lookahead)
The camera is ~80 ms late, so without the lookahead it can't time a 60 ms "p". With the lip-sync lookahead ≥ ~60 ms the
voice frame being shown describes an instant the camera has **already seen**. `SpeechFusion.step(frame, a, tune, dt,
{ camTime, voiceTime })` keeps the camera's raw per-user lip gap (`face._lipOpen`) by capture time
(`requestVideoFrameCallback` captureTime) and, when its history covers `voiceTime`, looks for a quick **relative dip**
(gap vs its own last 150 ms peak, near-closed, inside speech, vetoed by F/V/S hiss): that is the lips meeting → closure +
M/B/P weight. MediaPipe rarely shows a brief bilabial fully shut (the gap bottoms out at 5–10 % of the open range), which is
why an absolute threshold never worked. Rig harness (`eval_rig_nocam.ts`, camera + mic, M/B/P events with jaw ≤ 0.03 AND seal ≥ 0.5):

| lookahead | 0 | 60 | 80 | 90 | 100 | 120 | 150 ms |
|---|---|---|---|---|---|---|---|
| PP sealed before | 7/11 | 7/11 | 7/11 | 7/11 | 7/11 | 8/11 | 7/11 |
| PP sealed now | 7/11 (no-op) | 10/11 | 10/11 | 10/11 | 10/11 | **11/11** | 10/11 |

F/V tuck, S teeth, rounding, jaw and silence unchanged (letting the synced camera also re-split the other viseme families
was tried and dropped: F/V 3/4 → 2/4).
Off switch: `localStorage['vtp.camSync'] = '0'`. Without the lookahead it is a no-op (the camera hasn't seen that instant).

### Camera lip seal (on)
`FaceSolver` runs the same relative-dip detector on the raw gap every camera frame (`face._lipSealDip`) and, while it
fires, follows the raw gap down with the (filtered, laggy) jaw channels, so camera-only and camera+mic mouths close on
M/B/P that MediaPipe's jawOpen barely registers. No added latency. `app.face.camSeal = false` turns it off. Camera only (mic off), rig harness: M/B/P mean minimum jaw 0.314 → 0.232,
lips shut 0/11 → 1/11, jaw lag vs loudness 67 → 50 ms; camera + mic without lookahead: lips shut 10/11 → 11/11;
`eval_mouth.ts` (fixed truth) talk false opens 4 % → 2 %, closing after a real closure 67 → 17 ms, missed opens 18 → 20 %;
`eval_cam_mouth.ts` talk MAE 0.260 → 0.248. `eval_face.ts` unchanged.

### Neural visemes (ON by default since round 4 — fast model without the lookahead, see the end of this file)
`src/tracking/neuralVisemes.ts`: a tiny streaming phone recogniser written in plain TypeScript (no runtime) —
16 kHz log-mel (25 ms / 10 ms, 40 bands, causal gated mean normalisation) → causal conv → dilated causal conv → GRU(192)
→ 40 phone posteriors (39 ARPAbet + silence) → 17 visemes, 301 k parameters, `public/vendor/voice/nv_visemes.json`
(1.6 MB). Trained on ~93 h of LibriSpeech train-clean-100 (augmented: mic EQ, white / pink / brown / babble / keyboard /
hum noise at 3–35 dB SNR, gain −30…+12 dB, synthetic rooms) with the Montreal-Forced-Aligner phone alignments
(`gilkeyio/librispeech-alignments`, CC-BY-4.0), each output describing the frame 60 ms in the past (it hears that
much of the future first). Recipe + exact parity check: `tools/nv/` (Python/PyTorch, GPU at a duty cycle under a
live_ok guard) and `npx tsx tools/eval_neural_visemes.ts --parity`.

* **Where it runs:** in the voice VAD worker. With it on, the voice worklet also streams its 16 kHz signal in 10 ms chunks
  (`cfg.nv`), the worker posts each frame's 17 viseme posteriors stamped with the epoch time of the instant it describes,
  and `NeuralMerge` (`src/tracking/neuralMerge.ts`) blends them into the engine's visemes for the instant the
  (lookahead-delayed) voice frame describes: vowels / approximants / fricatives are mixed (`mix`, default 0.5), M/B/P is
  `max(engine, mixed)`, and it never turns the voice gate's silence into speech (only acts within 150 ms of engine speech).
  Level / open / closure timing stay the engine's. Frames arrive ≈ 85 ms after the fact, so **it needs the lip-sync
  lookahead (≥ 80–100 ms)**; with the lookahead off it is a no-op. Needs the noise filter (Standard / Strong: its worker).
  Cost ≈ 17–22 ms of worker CPU per audio second: the model runs on every 10 ms chunk, talking or not (35–40 ms before
  the 2026-10 kernels, same output bit for bit).
  Optional **idle skip** (OFF by default: the worker option `idle`, nothing in the UI turns it on yet, because it changes
  the output): each 10 ms chunk carries the voice gate (`g`); once the gate has been shut for ≈ 0.5 s
  (`NV_IDLE_REACH` = 45 hops + the model's look-ahead: `NeuralMerge` still used frames up to ≈ 0.33 s after the gate shut
  on the test clip, plus headroom) the model stops — the log-mel front-end keeps listening — and when the gate opens
  (the worklet's `nvWake`, ahead of the next chunk) it catches up on the last 90 ms first (≈ 2 ms, once). On the test clip
  (gate shut 86 %) that is ≈ 6–7 ms per audio second instead of 17–22; someone who talks all the time saves next to
  nothing. What it changes (`tools/eval_nv_idle.ts`): after a long pause the posteriors differ from the always-on model
  by a median ≈ 0.007 (its GRU no longer hears the silent room); after `NeuralMerge` the top viseme differs on 16 (fast) /
  22 (full) of 4,319 rows and held vowels lose a few frames (fast 'oh' 20/23 → 19/23, full 'oo' 71/77 → 69/77); the 32
  labelled events score the same, and the first rows of each word after a pause still get the blend.
* **Measured:** LibriSpeech test-clean stream (23 min, 40 speakers never seen in training; frame-level viseme accuracy of what is
  on screen at each instant, lookahead 90 ms): rule engine **35.4 %** (speech frames 21.6 %, false consonants in silence
  15.2 %) → neural **79.4 %** (74.6 %, 3.3 %); the same stream in a reverberant room (RT60 0.5 s): 31.7 % → **74.2 %**.
  Per-class recall engine → neural: PP 49 → 77, FF 22 → 75, TH 0 → 56, DD 0 → 72, kk 2 → 73, nn 0 → 75, L 4 → 74,
  W 0 → 74, U 14 → 65 %. The shipped blend (auto mix 0.35) gives 67.7 %. On the ONE test clip of the author's voice (32
  hand labels) the base model alone is weaker than the engine that was tuned on that clip (19 vs 21 strict; its PP 3/11,
  held "OOOO" read as W/O), the blend is 21/32 strict, **25/32 visual** (engine 23), vowels ee/oh 87/83 % (85/61 %), rig:
  mic-only M/B/P 7 → 8/11, F/V 3 → 2/4 (borderline "fluFFy"). **The personal layer below is what makes it win on a
  specific voice.**
* **Settings / API** (for the UI): `localStorage['vtp.neuralVisemes'] = {"on":false,"mix":0.5}`;
  `app.audio.setNeural({ on, mix })`, `app.audio.neuralStatus` → `{ on, mix, ready, error, delayMs, msPerSec, personal,
  lagMs, used }` (`error` says "needs the noise filter" when it's off; `ready` = model loaded).

### Personal voice model (automatic in the guided setup when neural visemes are on)
`src/tracking/neuralPersonal.ts`. During **Setup test** the worker records the model's GRU state for each voice step:
held sounds ("AAAH", "EEEE", "fffff", "mmmmm" …) are labelled with their phone on every non-silent frame; the read sentence
("The quick brown fox …") is **force-aligned** with Viterbi over the model's own posteriors, constrained to the sentence's
phones (built-in lexicon). Then only the output layer is re-fitted (softmax regression, L2-anchored to the shipped weights,
Adam, 60 epochs; ≈ 1 s in the worker for ~1700 frames) and stored in `localStorage['vtp.nvPersonal']` (~31 KB; nothing
leaves the PC). `app.audio.resetProfile()` forgets it. Hooks: `app.audio.neuralRecord(step | null)`,
`app.audio.finishNeuralPersonal()` (the setup calls both). Measured (2-fold on the test clip, held-out events only):


  | held-out events (lookahead 90 ms) | rule engine | + neural (shipped) | + neural (personal) |
  |---|---|---|---|
  | 32 labelled events, strict / visual | 21 / 23 | 21 / 25 | **27 / 27** |
  | "talk" sentence (20 events) | 12 / 13 | 12 / 16 | **18 / 19** |
  | "mama baba papa" + "five fluffy voices" (12) | 9 / 10 | 9 / 9 | 9 / 8 |
  | rig, MIC ONLY: M/B/P sealed | 7/11 | 8/11 | **11/11** |
  | rig, camera + mic: M/B/P sealed | 10/11 | 10/11 | **11/11** |
  | rig: F/V tucked | 3/4 | 2/4 | 2/4 |

  (Held vowels reach 98–100 % with the personal layer but they are part of its training data, so not claimed.)

### Phone ARKit capture: Live Link Face receiver + eye rest
* `server/tracking/liveLinkFace.ts`: Epic **Live Link Face** (iPhone, free) UDP receiver, default port 11111, off by
  default (config key `liveLinkFace { enabled, port, bind, phoneIp, invert }` in `config/external.json`, status under
  `liveLinkFace` in the external status). Binary big-endian packets (version 6, device id, subject, frame time, 61 floats:
  52 ARKit + head / eye yaw-pitch-roll in radians) cross-checked against four open-source parsers and a real capture;
  malformed / hostile packets rejected; head/eye signs verified identical to iFacialMocap for the same motion
  (`npx tsx tools/test_livelinkface.ts`, 49 checks). Source choice `'livelinkface'` ("Live Link Face (iPhone, Epic)") is in
  `TRACKING_SOURCES`. **UI hook for the panel:** a Live Link Face section like iFacialMocap's (port, optional phone IP,
  flip toggles). Setup: app → Live Link (ARKit) mode → ⚙ → Live Link → Add Target = this PC's IP, port 11111; allow
  UDP 11111 in the Windows firewall (private); hold still a second (auto rest pose) or Recenter.
* Phone sources now learn the **rest gaze** with the rest head pose: a phone below / beside the monitor sees "looking at my
  screen" as 15–25° off-axis, which used to read as a permanent downward gaze (`tools/test_ext_gaze_rest.ts`).
* Known (not fixed): the VTube Studio phone app's hotkey buttons are parsed but not wired (`manager.create()` passes no
  `onHotkey`); iFacialMocap has no face-lost flag (freezes until the 0.5 s stale timeout); FaceMotion3D's handshake is
  untested; Live Link Face mouthLeft/Right may be swapped on some app versions (flip it if so).
* Quality vs webcam: no phone was available for a side-by-side measurement. TrueDepth phones capture tongueOut, cheekPuff,
  lip roll / funnel and low-light eyes far better than RGB webcams; reported end-to-end latency over Wi-Fi is ~40–80 ms
  (similar to the webcam path); MeowFace (Android, RGB) is webcam-grade.

## My speaking profile (voice + face, one per person)

`src/tracking/speakingProfile.ts`, card in Tracking → Advanced → Voice, phone & 2nd camera (`src/ui/speakingPanel.ts`).
The 45-second setup test (camera + mic) now also records voice + camera pairs during the held vowels and the "quick
brown fox" sentence and fits the performer's own **voice → mouth-shape style** (how wide / round the mouth actually gets
per vowel, per unit of loudness), which replaces SpeechFusion's generic constants for that person on every avatar
(the style lives in the fusion's own shape space; each avatar's viseme rig maps it as usual). The card lists every part
of the profile (mouth style, vowel / consonant templates, the personal neural layer, expressions, neutral face) and can
save / load them as one JSON file on the performer's PC.

Honest numbers (`tools/eval_speaking_profile.ts`, recorded clip, voice-only mouth vs the camera's mouth on speech the
fit never saw, mean abs error, generic → personal):

| Train on → test on | wide | round | open | pucker |
|---|---|---|---|---|
| held vowels + talk → M/B/P + F/V lines | 0.102 → **0.045** | 0.372 → **0.127** | 0.264 (kept generic) | 0.091 (kept generic) |
| held vowels + M/B/P + F/V → talk | 0.156 → **0.080** | 0.177 → **0.137** | 0.344 | 0.178 |
| held vowels only → talk + lines | 0.136 → **0.077** | 0.250 → 0.245 | 0.314 | 0.145 |

Open and pucker fits did not generalise (neutral / worse in 2 of 3 folds), so they stay generic. Not personalised yet:
asymmetry, blink / brow habits, per-consonant camera shapes — the capture already has the data; they need a held-out
recording of the same person to prove a gain first.

### Keep learning me (opt-in, off by default; `src/tracking/learnMe*.ts`, `src/ui/learnMePanel.ts`)

Learns the performer's style from their own sessions, on top of the 45-second test, for every avatar. Stays on this PC.

- **Collect** (`learnMeData.ts`): while tracking, when switched on and not paused, ≤ 30 Hz feature frames: voice level,
  vowels, closure, voiced, pitch, 17 viseme posteriors; the camera mouth (open / wide / round / pucker) and the 52 raw
  ARKit channels; head rotation / position, gaze, torso, arm directions; tracker quality and eyes-tracked. No video, no
  audio. Kept only from runs of ≥ 2 s with the face tracked at full / near-full quality and both eyes seen. Voice
  frames are paired with the camera frame of the same instant (waits ≤ 0.3 s for the lookahead). IndexedDB
  `vtp-learnme`, Uint16 per field (head ≈ 0.003° steps), ≈ 6.5 KB/s, cap 200 MB (oldest chunks rotate out). Only the
  studio's own webcam branch feeds it: party guests and `?observer=1` tabs never record.
- **Learn** (`learnMeFit.ts`, in a module Worker): when the camera stops (or "Learn now", which waits for the camera to
  stop). Frames are cut into 60-s blocks; every 4th block (1-s guards) is held out. A new setting is adopted only if it
  beats both the version in use and the standard on the held-out blocks; otherwise the old one stays and the reason
  is logged and shown.
  - lip: ridge fit of all four voice → mouth channels (open, wide, round, pucker), gated per channel (MAE vs the camera).
  - habits: blink pace quiet / talking → `voiceLife.ts` (`personalLife`), fitted by running the fallback on the
    performer's recorded voice and matching the blink rates the camera saw.
  - motion: idle sway, talking nods, tilts, turns (voiceLife multipliers), same simulation fit (log grid search).
- **Apply**: lip → `speech.style` (on top of the speaking-profile style), habits + motion → the camera-lost /
  voice-only face. Strength slider per area; last 3 versions kept, one-click back to any, or to standard.
- **Not personalised yet**: the neural viseme layer (free speech has no phone labels; the setup test still tunes it),
  brow habits and smile / jaw asymmetry (the raw camera brow / smile signals are too weak to learn from — see Natural
  mode), per-viseme consonant shapes.
- Tests: `npx tsx tools/learnme_unit.ts` (synthetic performers, `tools/learnme_synth.ts`); real clip:
  `npx tsx tools/eval_learnme.ts` (72 s: too little clear speech for the real gate; see the workstream report).

## Round 4 (2026-09-26): natural talking — fast neural visemes on by default, laughter / shouting, latency

Goal (the user): talk and emote normally, without acting for the camera. The face side is natural mode:
**[NATURAL_CAPTURE.md](NATURAL_CAPTURE.md)**. It learns your relaxed face and your own expression sizes, keeps smiles
gentle, and leaves the mouth to the voice while you talk. The voice side is below.

### Fast neural visemes (on by default; Standard mode needs no OBS change)

`public/vendor/voice/nv_visemes_fast.json` is the same network and recipe as the full model (tools/nv, LibriSpeech
train-clean-100 + MFA alignments, CC-BY-4.0). The only difference is that it hears **20 ms** of the future instead of
60 ms. It was fine-tuned from the shipped model for 45 minutes (`train.py --look 2 --init <G6>`): dev viseme accuracy
80.1 % vs 81.6 % for the full model. Every frame is ready about 35–45 ms after the sound, so:

* **Standard (lookahead 0).**
  - The fast model runs and its newest frame is used (`NeuralMerge.lagTol` = 70 ms).
  - The jaw keeps the engine's timing. The mouth *shape* trails the voice by about 40 ms.
  - Before this change, Standard was the rule engine alone: the full model was a no-op without ≥ 80 ms of lookahead.
* **Better (lookahead 60 ms, was 100).**
  - The fast model is on time.
  - Lips seal and round ahead of the sound (lookahead + synced camera closures, as before).
* **Lookahead ≥ 80 ms.**
  - The full model for the exact instant, as before.
  - Its personal layer (`vtp.nvPersonal`) is untouched, so existing "Better at 100 ms" set-ups behave exactly as before.
* **Personal layer.**
  - The fast model has its own (`vtp.nvPersonal.fast`), trained by the same 45-second setup test.
  - A personal layer only fits the model it was learned on. After updating, run the setup test once.
* **Defaults and switches.**
  - `vtp.neuralVisemes` settings from before this change are migrated to *on*. Before, "off" only meant "no lookahead", which the fast model now covers.
  - Advanced → "Turn neural off" still gives the pure rule engine.
  - Cost: about 17–22 ms of worker CPU per audio second (the optional idle skip above pauses the model while the voice gate is shut).

Measured (`tools/eval_neural_visemes.ts`):

LibriSpeech test-clean stream (23 min, 40 speakers never seen in training). Frame-level viseme accuracy of what is
on screen at each instant, with the visual-group accuracy in brackets:

| Set-up | Before this change | After |
|---|---|---|
| **Standard** (lookahead 0) | 35.4 % (46.7) rule engine only | **45.2 % (55.7)** fast model, auto mix 0.35 · 47.0 % (57.4) with the personal layer's mix 0.6 |
| **Better 60 ms** | 54.8 % (full model, mix 0.35) | **67.9 % (74.2)** mix 0.35 · **78.7 % (83.2)** mix 0.6 |
| Lookahead 90–100 ms (full model, unchanged) | 67.7 % (mix 0.35) | same (the fast model alone would give 80.1 %) |
| Reverberant room (RT60 0.5 s), Standard | 31.7 % | 38.4 % (neural alone 40.0 %) |

Fast model per-class recall @ 90 ms (engine → fast):

| PP | FF | TH | DD | kk | nn | L | W | U |
|---|---|---|---|---|---|---|---|---|
| 49 → 76 | 22 → 76 | 0 → 54 | 0 → 73 | 2 → 70 | 0 → 78 | 4 → 76 | 0 → 72 | 14 → 68 |

The user's own clip, 32 hand-labelled events (visual groups), no personal layer:

| Lookahead | Before | After |
|---|---|---|
| 0 ms | engine 23/32 | **25/32** |
| 60 ms (fast) vs 90 ms (old full) | 25/32 at 90 ms | **26/32 at 60 ms** |

Rig harness (`eval_rig_nocam.ts --nv <fast> --lagtol 0.07`, the same numbers apply with an ARKit face):

| Measure | Before (0 ms) | Fast model, 0 ms | Fast model, 60 ms |
|---|---|---|---|
| M/B/P sealed, camera + mic | 7/11 | 6/11 | 10/11 |
| M/B/P lips shut | 11/11 | 11/11 | 11/11 |
| F/V tucked | 3/4 | 3/4 | 2/4 |
| Jaw ↔ loudness correlation (cam+mic / mic only) | 0.52 / 0.65 | 0.54 / 0.67 | 0.52 / 0.66 |
| Silence jaw mean / max | 0.0012 / 0.07 | unchanged | unchanged |
| Share of talk frames sealed | 18 % | 18 % | 18 % |

The TS model reproduces PyTorch exactly (`--parity`: features 6e-6, logits 1e-5). Its dev frame accuracy is 80.1 %
(visemes), against 81.6 % for the full model.

Honest notes:

- With the old auto mix (0.35, no personal layer), Better 60 is below the fast model alone (67.9 % vs 79.6 %). The
  mix stays conservative because on the user's own clip the engine, which was tuned on his voice, ties or wins
  without the personal layer.
- After the 45-second setup test the mix goes to 0.6, and the personal layer is what made the full model win on his
  voice in round 3.
- Standard loses one M/B/P seal (7 → 6/11): the stale neural frame dilutes a P now and then. Better recovers it
  (10/11).

### Laughter and shouting (`src/tracking/vocalGestures.ts`)

* **Laughter.**
  - A train of short voiced bursts at 2.5–7 Hz on one repeated non-"oo" vowel, with no lip closures between them. "Mama baba papa" has closures, so it doesn't count.
  - Judged on the last ≤ 5 bursts; takes about 0.6–0.9 s to engage.
  - Then the mouth stays open between the "ha"s (floor ≈ 0.25; the jaw still bounces on each) and smiles gently. The voice alone never pushes the smile past 0.5.
  - The rig's "lips come together between syllables" rest is suspended while laughing.
* **Shouting.**
  - Loudness in dBFS against your own ~90th-percentile syllable level: +6 → +12 dB counts as `loud`.
  - The fusion and the rig open the jaw up to about 20 % more. The angry-shout teeth come from the existing emotive layer.
* **Frame fields and off switch.**
  - Both are optional frame fields (`frame.mouth.laugh`, `frame.mouth.loud`), so the OBS page and party guests render them too.
  - Off switch: `SpeechFusion.vocalOn = false`.
* **Measured** (`tools/eval_vocal.ts`). There is no recording of the user laughing or shouting, so both are *synthesised from his own voice*: 7 "hee"s cut from his held EEEE at 4.5 Hz with breathy onsets, and his sentence +12 dB with soft clipping.

| Synthetic test | Before | After |
|---|---|---|
| "hee-hee" laugh at 4.5 Hz: detected | no | after about 0.9 s (4–5 "hee"s) |
| Jaw mean over the laugh | 0.16 | 0.24 |
| Jaw minimum once detected | shuts every "hee" (0.01) | 0.07 |
| Smile over the laugh | 0 | 0.24 |
| Fast laugh (5.5 Hz) detected | no | weakly (0.23) |
| False laugh in speech (talk, "mama baba papa", whole recorded clip) | — | 0 % |
| Shouted sentence, jaw vs normal | ×1.01 | ×1.06 |
| Shout flag on the recorded clip (held vowels louder than talk) | — | 7 % of frames |

  Not validated on a real laugh or shout. Next step: record one (Track → Record expression test clip) and run
  `eval_vocal.ts` on it. The shout effect is deliberately small.

### Latency (audio vs mouth vs OBS)

The chain, measured or known:

- Mic → worklet: 19 ms (RNNoise frame + quantum).
- Analysis envelopes: 17 ms. The lookahead's `comp` hides these.
- Studio → OBS output page: about 22 ms (`OUTPUT_LAG`).
- OBS mic capture: 10–20 ms.

What that means:

* **Standard.** The jaw appears about 40–60 ms after the sound in OBS, and the mouth shape about 40 ms after that. That is inside the ~125 ms "video late" tolerance but visibly late on plosives. Set the mic's OBS Sync Offset to 60 ms, or use Better.
* **Better at D ms.** With Sync Offset = D, the mouth lands about 20–30 ms after the heard sound (worklet + output hop minus OBS's own capture delay), and the shapes are on time. 60 ms is the recommended D now: the fast model is on time there, and camera closure confirmation works from about 60 ms (PP sealed 10/11).
* **Camera.** The camera is 60–90 ms late. That is why the voice leads the mouth while talking and the camera only confirms closures, and why natural mode keeps the camera's mouth channels within the classic range while you speak.

## Round 5 (2026-10-03): something in front of the mouth, slower webcams, food & drink

### Mouth visibility (on; `src/tracking/mouthVisibility.ts`; off: `localStorage['vtp.mouthVis'] = '0'`)

What was wrong (measured): MediaPipe keeps tracking a face behind a boom mic, a pop filter, a mug or a hand and
**guesses a calm, closed mouth** there (behind a boom mic: jawOpen 0.00 and inner-lip gap 0.004, against 0.17 / 0.10
for the real mouth). The fusion trusted that guess: the voice-led mouth stayed at the camera-tracked gain and came
out 15–28 % too small while talking, the viseme engine read the shut lips as M/B/P, and the snack logic read a frozen
jaw.

How it is detected, per mouth-patch read:

* **Colour.** The reddest quarter of the lips themselves (the ring between the outer and inner lip contours) minus the
  reddest quarter of the patch around them (`mouthImage.ts` `ringHi − ctxHi`: the same statistic on both sides, see
  "Review fixes" below). Lips are redder than skin, stubble or beard under ordinary light; a black foam mic, a white
  mug, a pop filter mesh or a hand is not. Relative to the performer's own contrast (learned from clearly visible
  frames and from frames where the lips are seen apart, with a 20 s time constant in real time; prior 0.04): covered
  below 20 % of it, seen above 45 %.
* **Lips apart** (raw gap > 0.3) always count as seen: MediaPipe never opens a mouth it can't see. Lips that keep
  opening while colour calls them covered (dark lipstick, face paint) switch the colour cue off for that face.
* **Hands.** The share of the lip outline inside a hand's (padded) landmark hull, overruled when the patch plainly
  shows lips.
* Hidden in about 50 ms, back in about 150 ms. `face._mouthVis` (1 = seen) rides on the frame.

What it changes: FaceSolver stops learning rest / neutral / lip contour / geometry neutral from a hidden mouth and
skips the camera seal; the mouth-interior channels need the full "Teeth and tongue" feature (the patch may now arrive
for visibility alone) and are scaled by visibility. SpeechFusion treats a hidden mouth like no camera (voice gain 1.2,
the guessed open / jaw / shape scaled by visibility, no synced closure); VisemeFusion's camera cues switch off. A
one-time tip appears when the mouth stays hidden for 12 s with the mic off.

Cost: the face worker reads the 64 × 64 patch at 15 Hz (7.5 Hz once the adaptive quality has stepped down; never at
the lightest level or with face inference over 22 ms: then **Tracking → Voice lip-sync** says the mouth check is
paused). The analysis grew from ~70 to ~120 µs per read (scanline spans; Node, busy machine), ≈ 1 ms of worker time
per second; the review fixes' second chroma histogram (the context's) adds ~15–25 µs, the second review's
brightness-relative floor (a second pass over the same pixels) is within the noise (~100–115 µs per read). The
read-back itself is shown live as `mouthImage.patchMs` in the diagnostics.

Measured with `tools/occlusion/` (the test clip with synthetic occluders composited into the video, the real
FaceLandmarker on CPU in a muted headless Chrome, the live tracker's face crop) and `tools/eval_occlusion.ts`
(15 Hz patch reads; "caught" = frames with ≥ 50 % of the lips covered read as hidden). Since the review fixes the
occluders carry a webcam's colour noise and texture (see below); first run as published (grey-only noise), then the
same scenarios re-run with realistic noise (`--step 2`), before → after the review fixes:

| Scenario | Caught, first run | Caught, realistic noise: before → after | False "hidden", realistic: before → after |
|---|---|---|---|
| Clean clip (tongue out, puffed cheeks, wide "aa", head turns) | — | — | 0.00 % → 0.00 % |
| Purple RGB-LED light / cold blue light (no occluder) | — | — | 0.0 % → 0.2 % / 0.0 % → 0.0 % |
| Dim warm room, noisy webcam gain (no occluder) | — | — | 0.0 % → 0.4 % (second review: 0.0 %) |
| Boom mic in front of the mouth | 99 % | **73 % → 99 %** | — |
| … under purple light / in a dim, noisy room | — | 99 % → 99 % / 99 % → 99 % | — |
| Mic moved in front and away again | 97 % | 97 % → 97 % | 1.3 % → 1.5 % of the clear frames |
| Hand over the mouth (own skin tone) | 97 % | 96 % → 96 % | 1.3 % → 1.3 % |
| Mug raised for a sip | 72 % (the rim under the upper lip reads as seen) | 72 % → 63 % | 0.8 % → 0.8 % |
| Mic under the lips (partly covered) | 30 % | 30 % → 32 % | 0.0 % → 0.0 % |
| Two fingers across the lips (no hand landmarks in the harness) | — | 0 % → 24 % | 0.0 % → 0.3 % |

Talking behind a boom mic, against the clean run (the same voice, the camera seeing the lips). Beta.7 has no
visibility channel, so the occluder noise doesn't change its column:

| | Beta.7 | Round 5 (b3d88c1), realistic mic | After the review fixes | Mic only |
|---|---|---|---|---|
| Mouth size while talking | × 0.77 | × 1.00 | **× 1.04** | × 1.04 |
| Correlation with the clean mouth | 0.76 | 0.76 | 0.75 | 0.75 |
| Shape error (wide / funnel / pucker) | 0.060 | 0.036 | **0.032** | 0.032 |
| Viseme visual-group agreement | 92 % | 94 % | **94 %** | 94 % |
| Mean abs open error | **0.115** | 0.157 | 0.168 | 0.168 |

Honest note: the per-frame open error grows, because the old, too-small mouth had less to be wrong about. The hidden
mouth now behaves exactly like the mic-only mouth (the path tuned for "no camera"). Mic moved in and out: jaw jitter
in the silent frames while it moves 12.4 → 3.0 (× 100); mouth size × 0.75 → × 1.01.

#### Review fixes (2026-10-04)

An independent review of this round confirmed six problems; all are fixed (branch `fix/lipsync-review`):

* **Real black mics were missed.** The colour test compared the upper quartile of the lips with the MEAN of the
  context. Anything that covers both with some colour noise or texture (every real black foam mic) reads about 0.67 of
  its chroma spread "redder than its surroundings": the review's replays went from 97–99 % caught to 0–63 % with a
  webcam's measured colour noise. The harness hid this because its occluders had grey-only noise (r = g = b on every
  mic pixel). Now both regions use the same statistic (`ctxHi`, the context's upper quartile), dark pixels' chroma is
  computed with the sum floored (r − g of a black pixel is mostly noise; first at a fixed 90, since the second review
  relative to the face's own brightness, see below), and the quartiles are interpolated
  inside 0.0025-wide bins (no 0.01 steps). The visible contrast is ~20 % lower (the clip: 0.073 → 0.061), so the prior
  went 0.05 → 0.04 and the reliability ramp 0.012–0.025 → 0.010–0.020. The harness occluders now carry Cb / Cr noise
  (sd 1.5 levels, full frame: r − g ≈ 3.2, between the VP9 clip's 1.7–2.5 and a live webcam) and colour grain on the
  foam; `light_dim`'s gain noise has colour too; new scenario `mic_dim` (mic in a dim, noisy room). Tried and not
  taken: the median on both sides (the mug 96 %, the mic under the lips 56 %, but 1.7 % false "hidden" in the dim
  room) and a rank statistic (P(lip pixel redder than a context pixel); the mug 58 %); the upper quartile has the
  fewest false "hidden" on visible mouths. Cost of the trade: the mug is caught less often (72 → 63 %), because with
  the rim under the upper lip a quarter of the lip ring still shows lip colour; nobody talks while sipping, and the
  snack logic still gets the sip from the cup at the closed lips.
* **The learned contrast adapted 4–8× too slowly.** Its 20 s time constant used the camera-frame dt but only updated on
  patch reads (15 or 7.5 a second). It now uses the real time between updates (capped at 1 s). Replay of the clean run
  with the colour halved at 30 s (a webcam's colour noise reduction kicking in): in the next 30 s, false "hidden"
  5.9 % → 0.0 % and vis < 0.8 14.8 % → 0.3 % (longest hidden spell 0.87 → 0.02 s; same detector, old vs new rate).
* **The status line claimed "The camera sees your mouth" while the check wasn't running** (adaptive quality at its
  lightest level, face inference over 22 ms, the main-thread fallback). `MouthVisibility.checking` (a patch within the
  last second) and `Tracker.mouthVisPause` feed `mouthStatusText`: off / paused (busy PC) / not running / sees it /
  covered. Diagnostics gain `mouthVis.checking` and `.pause`. LIP_SYNC.md no longer says "any webcam".
* **Multicam Body role:** camera 2's hands were tested against camera 1's lips. The lip test now takes the main
  camera's own hands (`lipTestHands`).
* **Food & drink:** a real mug behind a boom mic sips again, and strict never makes a phone at closed lips a can (see
  below).

#### Second review (2026-10-04)

A second review of those fixes found one regression (fixed), one overclaim in the status line (fixed) and two
narrower points (kept in view):

* **A deeper skin tone in a dark picture read as covered (fixed).** The fixed floor (r + g + b at least 90 for the
  chroma) applied to the lips as well. Lips are darker than the skin around them, so in an under-exposed picture of a
  deeper skin tone (dim room, monitor light, a bright wall behind the streamer) it flattened the lips' redness far more
  than the skin's and the contrast fell to ~0. The review's synthetic deeper face (skin 110 / 76 / 60, lips
  80 / 48 / 46, exposure × 0.4, webcam colour noise): silent at the start 91–98 % "hidden" (b3d88c1 0 %); after
  talking the learned contrast was 0.012, which almost switches the colour test off, and a black mic then arriving was
  caught 0 % (b3d88c1 100 %). Knock-on effects: the status line said something was in front of the mouth, the camera's
  silent mouth shapes faded out, the mic-off tip fired after 12 s, and food & drink treated the mouth as "covered
  before". The floor now follows the face's own brightness (`chromaFloor`): 0.4 × the brightness where the brightest
  tenth of the patch around the lips starts (the lit skin), at most 90. A black mic much darker than the skin is still
  floored; a face that is dark all over keeps its lips' colour; a mic over nearly all of the patch lowers the floor
  for its own pixels on both sides alike, which the like-with-like contrast cancels. Under ordinary light the floor
  stays 90, so nothing else changes. Tried: 0.3 / 0.5 / 0.6 of the bright skin and no floor at all; 0.3–0.5 are within a
  frame of each other, 0.6 and no floor give more false "hidden" in the dim rooms.
  The harness's only face is the clip's (fair, bearded), so there are three new scenarios: `light_deep`, `mic_deep`,
  `mic_deep_episodes` — the frame recoloured to a deeper skin tone (cheeks ~(90, 62, 50)), the lips 15 % darker, then
  under-exposed (× 0.72) with webcam gain noise. That room light now also falls on the mic (a new `post` lighting
  stage after the occluders; the older dim / purple scenarios keep the mic at full brightness, as before).
  `tools/mouthvis_unit.ts` has the review's faces at × 0.3–0.45 (they keep > 60 % of their well-lit contrast; with the
  fixed floor 7 of the 8 cases fail, down to no contrast at all) and its whole session (silent, talking, silent, then a
  black mic: 0 / 0 / 0 % hidden, 100 % caught; with the fixed floor 98 % hidden, 0 % caught).
* **"Only a hand over your mouth is noticed" was shown whenever the Hands switch was on (fixed),** even when the hand
  model had failed to load or its worker wasn't up, so nothing was noticed. The lip test's hands now need the switch
  AND `Tracker.models().hands`; the status line follows them.
* **Kept in view: uneven, reddish skin around pale lips.** The like-with-like statistic compares the lips with the
  reddest quarter of the skin around them. Pale lips with about a third or more of that skin as red as the lips or
  redder (rosy, flushed or freshly shaved skin) can read "covered" until the lips first part (lips seen apart
  are always seen, and teach this face's own contrast). With the old mean context this case read "seen"; even skin,
  stubble and beards are equal or better than before. Not changed (a narrow, short-lived case; changing the statistic
  again would bring back the missed black mics); LIP_SYNC.md says so in plain words.
* **Kept in view: a mug held under the chin, quiet, not drinking,** reads like lips on the rim and sips about 0.3 s
  after it gets there: with the mouth in view (since beta.7) and, since the review fixes, behind a boom mic too.
  `tools/eval_snacks.ts` now prints it as a known limit, not counted in the false events per hour (3 / 3 episodes in
  view on b3d88c1 and now; behind a mic 0 / 3 on b3d88c1, 3 / 3 now).

Detector on the realistic harness runs (`tools/eval_occlusion.ts`, 15 Hz patch reads; `--step 2`; "false hidden" is
on frames with < 5 % of the lips covered, which for a fixed mic are the ~49 frames where the head comes out from
behind it):

| Scenario | b3d88c1 | Review fixes (fixed floor) | Second review |
|---|---|---|---|
| Deeper skin, under-exposed (no occluder): false "hidden" | 0.0 % | 1.5 % | **0.0 %** |
| … boom mic in front: caught (false "hidden" when the head comes out) | 1 % (0 %) | 100 % (65 %) | **99 % (18 %)** |
| … mic moved in front and away: caught (false "hidden") | 97 % (1.2 %) | 97 % (3.5 %) | **97 % (1.7 %)** |
| Dim warm room (no occluder): false "hidden" | 0.0 % | 0.4 % | **0.0 %** |
| … boom mic in front: caught (false "hidden" when the head comes out) | 99 % (18 %) | 99 % (57 %) | **99 % (18 %)** |
| Boom mic in front, ordinary light | 73 % (10 %) | 99 % (16 %) | 99 % (18 %) |
| Purple light, no occluder / boom mic | 0.0 % / 99 % | 0.2 % / 99 % | 0.2 % / 99 % |
| Mic moved in and out, hand, mug, mic under the lips, fingers: caught | 97 / 96 / 72 / 30 / 0 % | 97 / 96 / 63 / 32 / 24 % | 97 / 96 / 63 / 33 / 24 % |
| Clean clip, cold blue light: false "hidden" | 0.00 % / 0.0 % | 0.00 % / 0.0 % | 0.00 % / 0.0 % |

Talking behind the mic in the deeper-skin, under-exposed room is now the mic-only mouth (size × 1.04, shape error
0.032, viseme agreement 94 %; b3d88c1 × 0.77, 0.052, 91 %), and the visible deeper face in that room tracks the clean
mouth as closely as on b3d88c1 (open error in speech 0.015, size × 1.01; with the fixed floor 0.026, × 1.03). As
before, all of this is synthetic occluders and recolouring on one recorded face; nothing was checked on a live webcam.

### Lip closures with 30 fps webcams

The synced camera closure (with the lookahead) required the camera's newest frame to be within 30 ms of the voice's
instant. A 30 fps webcam, or a busy PC delivering 15–25 face results a second (seen live), is often a whole frame
behind that, which switched the confirmation off; and a slower camera rarely samples the single ~0.08 lip-gap frame at
the bottom of a "p". The staleness limit is now about 1.25 frame intervals, and the "near closed" bar rises with the
frame interval below ~37 Hz (unchanged at the clip's 47 Hz). FaceSolver's own camera seal gets the same bar.
`tools/eval_rig_nocam.ts --camhz N` (decimates the clip's camera), camera + mic, lookahead 60 ms:

| Camera rate | 47 Hz | 30 Hz | 20 Hz | 15 Hz |
|---|---|---|---|---|
| M/B/P sealed, before | 10/11 | 8/11 | 8/11 | 7/11 |
| M/B/P sealed, after | 10/11 | **11/11** | **9/11** | **9/11** |
| Non-bilabial sounds sealed mid-sound, after (before) | 9/21 (9/21) | 10/21 (9/21) | 9/21 (9/21) | 9/21 (9/21) |

(The extra one at 30 Hz is the S right after the P in "jumps".) Camera only, M/B/P mean minimum jaw: 30 Hz 0.294 →
0.259, 20 Hz 0.323 → 0.295 (47 Hz 0.234).

### Food & drink with mouth visibility (`snacks.ts`)

* Covered-mouth jaw samples never count as chewing (the jaw behind a cup / hand / mic is a guess).
* Lips covered at the rim count like a closed jaw for a sip, and, for look-alike drinks (a can the detector calls
  "banana"), covered lips at closed lips for 0.6 s (strict; normal 0.45, loose 0.3) count like a head tilt.
* A mouth that was already covered before the hand came (a boom mic whose foam the detector calls "donut" or "cup")
  is a fixture being touched: no hold, no sip, no bite. Exception (review fix, 2026-10-04): a drink whose hold was
  confirmed in the hand AWAY from the mouth and whose box really travelled (a mug picked up from the desk) sips behind
  the mic like before mouth visibility (jaw closed, not speaking).
* Strict: covered lips never make a box the detector calls a phone / remote a drink (review fix); it needs the full
  drinking motion (head tipped back or the face hidden), as before.
* Snack captures record the visibility; `tools/replay_snacks.ts` reads it.

`tools/eval_snacks.ts` (the synthetic episodes now carry the visibility by default, `--novis` drops it; new negatives "boom mic in front of the
mouth, talking", "… quiet, hand adjusting it", "banana held over closed lips"; new positive "can (banana), no tilt"):
strict false events 8.2 → 0.0 / h (the mic adjusted as a "cup" became a mug + sip), loose 27.2 → 10.9 / h; the
low-tilt look-alike can 17 % → 100 % (strict), all positives strict 90 % → 98 %. Without the visibility channel
(external trackers) the detector behaves exactly as before. (The first version of this note said 5.7 → 0.0 and
34.5 → 10.9: those "before" rates came from an earlier negative set; re-run on the committed one they are 8.2 and
27.2 / h.)

Review fixes (2026-10-04), with the episodes the review asked for (added after the others, so the numbers above stay
the same): "mug behind a boom mic" (the lips covered all session, a mug from the desk raised to them) and "phone
pressed to closed lips" (portrait, silent, no tilt, the lips covered), strict:

| | beta.7 (2a71946) | Round 5 (b3d88c1) | Review fixes |
|---|---|---|---|
| Mug behind a boom mic, sipped | 100 % | 0 % | **100 %** (normal and loose too) |
| Phone pressed to closed lips, false events (3 × 24 s) | 0 | 11 | **0** |
| All positives | 91 % | 90 % | **98 %** |
| Synthetic false events, strict | 7.7 / h (the mic adjusted) | 28.4 / h (the phone) | **0.0 / h** |

Normal and loose still turn the phone at closed lips into a can after 0.8 / 0.5 s ("held at closed lips" counts there,
as it did in beta.7).

Known limit, printed on its own line by `tools/eval_snacks.ts` (not counted in the false events per hour; second
review): a mug held still just under the chin, lips closed, quiet, sips about 0.3 s after it gets there, with the
mouth in view (b3d88c1 and now: 3 / 3 episodes) and behind a boom mic (b3d88c1 0 / 3, now 3 / 3: the carried mug is
judged like before mouth visibility). Everything else in the eval output is unchanged.

Not fixed: with no voice information at all (mic off, no VAD), talking still trips the chewing rhythm for 0.1–1.8 s
now and then in the archived captures (21 s in 50 min, snapshots show talking, no food). It never fired a bite there
(a bite also needs the hand at the mouth), but a real fix needs another cue than the jaw.

### Tools

* `tools/occlusion/harness.ts` (+ `occluders.ts`, `preview.ts`, `page.html`): occluder scenarios through the real face
  model; `--step k` for quick robustness passes; `--chroma <sd>` sets the occluders' colour noise (default 1.5, 0 = the
  old grey-only noise). Each scenario writes ~100 MB whatever `--step` is. A scenario's `light` runs before the
  occluders (and gets the clean face geometry: `deepSkin` darkens the lips), its `post` after them (room light that
  dims the mic too); `light_deep`, `mic_deep`, `mic_deep_episodes` use both. `tools/eval_occlusion.ts`: the scorecard
  above (`--root` scores another tree's code on the same runs, `--patchhz`, `--mouthimage`).
* `tools/eval_rig_nocam.ts --camhz N`, plus false-seal counts. `tools/eval_snacks.ts` (`--novis`: without the visibility channel).
* `tools/eval_tongue.ts`: the video / landmark alignment searched only ±233 ms and landed on its edge (r 0.15); the
  real offset (re-running the face model on the video) is −33 ms. It now searches ±0.5 s on the cavity share of the
  lip-line band (`--offset -33` skips the search; at −33 ms that band correlates r = 0.60 with the lip gap). Scored
  aligned, the mouth-interior channels barely change (they are scored on long held segments): tongue out AUC 0.984
  (was 0.986), false tongue in speech 0 % (1 %), teeth AUC 0.885 (0.912), cavity AUC 0.886 (0.902).

## Round 6 (2026-10-09): the mouth that hung open, someone else's voice, mouth styles, glasses, OBS in one click

Measured on the recorded clip through the real chain on a wide cartoon jaw (36°), `tools/eval_lipsync.ts`
(camera only / camera + mic / mic only / mic + a second voice leaking in at −14 dB). Reviewed (Grok) and revised.

### Resting mouth (on; `src/tracking/slackMouth.ts`; off: `localStorage['vtp.slackGate'] = '0'`)
Root cause of "the mouth is open in nearly every frame": many people rest with their lips a little apart (a relaxed
jaw, a beard hiding where the lips meet, looking up at a screen). The camera reads that as an opening, the amplifier
made it 0.6–0.7 (a 20–25° jaw on a frog), and nothing on the camera path tells resting from talking.
- Talking moves the lips several times a second; a resting mouth stays put. "Talking" = lip movement lasting ~0.2 s
  (a landmark blip never counts; a fast head turn neither starts nor ends it). The opening shown is measured from a
  **slack floor** that starts at the closed lips and follows closures down at once. While the lips move, and for 0.8 s
  after, it sinks back to the closed lips (mumbling and small lip travel show their whole opening); only a mouth still
  for that long creeps up to its resting opening (~2 s after the last syllable), which then reads as closed.
- The floor sits at most `max` (0.13 of the eye-corner span) above the closed lips and its share fades out by
  `max` + 0.06: a held "ee" / "ah", a long sung note or a gasp wider than a resting mouth keeps its opening; a held
  rounded shape with the lips apart keeps all of it. It scales jawOpen, mouthLowerDown / UpperUp and the lip contour;
  the raw `_lipOpen` the closure detectors read is untouched. `face._lipAct`, `face._slackK` go on the frame.

### Someone else's voice in the mic (on; off: `localStorage['vtp.foreignGate'] = '0'`)
A guest, a call or game audio leaking into the mic used to work the performer's mouth. The evidence builds (~0.35 s)
only after the camera has clearly seen the lips at rest for a full second with no syllable; any lip movement above rest
clears it within ~60 ms, so a quiet talker with small lip travel is never attenuated. Then the voice's drive fades to
10 %. No lip reading (phone / VMC source, hidden mouth) = unchanged.

### Mouth styles (`profile.mouth.rules.style`: 'human' default | 'wideCartoon', `speechJaw`)
Nothing changes by itself. For a jaw-bone mouth at least a tenth of the avatar's height wide (frogs, toads, crabs,
mascots) the studio **suggests** the cartoon mouth once ("This avatar has a wide cartoon mouth: use the cartoon mouth
style?"); Show dock → Me → **Mouth style** switches either way any time (`src/ui/mouthStyle.ts`). Cartoon: everyday
talk uses up to `speechJaw` (0.55) of the gape with a soft ceiling; a shout / laugh opens wider at once and an opening
held ~0.4 s gets the full gape; rounding is the corners pressing in (no protruding snout); "ee" needs no stretch; the
same on camera-only frames. `puff.plosive` (a throat / cheek pop on each M / B / P release) defaults to 0; choosing the
cartoon mouth sets 0.4 on an avatar's puff.
2D models: unchanged unless a rounding parameter is bound. The extended mouth sources (`jawOpen mouthFunnel
mouthPuckerWiden mouthPressLipOpen mouthShrug mouthX cheekPuff tongueOut`) are offered in the parameter mapping but
never auto-bound; with `mouthFunnel` / `mouthPuckerWiden` bound, `mouthForm` becomes the corners only (no frown on "oo").

### Glasses (auto; `src/tracking/glasses.ts`; force: `localStorage['vtp.glasses'] = 'on' | 'off'`)
Detected from thin bars at the nose bridge AND under the lower lids (clear of the lashes), on the pixels the
facial-hair check already reads ~1×/s, with hysteresis; a lash line or a crease alone stays off. With glasses AND eyes
that can't be trusted (their two blink cues disagree, or brief one-eyed "blinks" without a cheek lift keep happening)
the blink leans on the "more open" cue, a one-eyed closure must hold like a wink (≥ 0.15 s) or lift its cheek, and the
blink threshold is a little wider. Any untrusted eye eases its gaze toward the head; both unreadable > ~1 s → natural
blinks of its own. A false glasses reading on clean eyes changes nothing. No real glasses footage exists yet:
`tools/eval_glasses.ts` draws glasses onto the clip and simulates lens effects. `state.json` reports `glasses`, `slack`.

### OBS mic delay in one click
The lip-sync guide's OBS card has **Set it in OBS for me**: it lists OBS's microphones by their exact names (virtual
cables / mixers unticked), the user confirms the list, VTube Pro sets their Sync Offset to the lookahead and reads it
back. A source OBS clamps is put back as it was; Undo is offered whenever anything changed (only on mics nobody
changed since). `tools/obs_micoffset_unit.ts` runs it against the mock OBS.

### Self-test: the quiet line
"Best lip sync for me" → Try it ends with a few quiet seconds, scored on the avatar's own mouth. A mouth that hangs
open there OFFERS the performer's resting margin (shown as a share of the eye width); it is saved only on "Use it",
and a Reset puts the default back (`localStorage['vtp.slackMax']`).

### Tools
`tools/eval_lipsync.ts` (`--style`, `--root`, `--csv`, flap index, held vowels), `tools/eval_glasses.ts`,
`tools/slackmouth_unit.ts`, `tools/mouthstyle_unit.ts`, `tools/glasses_unit.ts`, `tools/obs_micoffset_unit.ts`.

## Lip-sync bus, Pro2D mouth shapes, Rhubarb, HeadAudio (lane b15-lipsync, 2026-10-23)

### One bus for every avatar kind (`shared/lipBus.ts`)

The 3D viseme rig (`src/avatar/visemeRig.ts`) and the Pro2D drive (`shared/rig2d/drive.ts`) read a frame's mouth channels
through one module:

* **Oculus 15 <-> our 17.** Our set is Meta's 15 (sil PP FF TH DD kk CH SS nn RR aa E I O U) plus L and W. `toOculus15` folds L -> nn
  and W -> U (sums kept); `fromOculus15` takes Meta's names with or without `viseme_` (and the VRM `ih oh ou ee`).
* **The vowel mix.** A I U E O (Pro2D `ParamMouthA..O`) are the same five shapes as the VRM presets aa ih ou ee oh: one table
  (`VISEME_PRESET`, a consonant leans on the nearest vowel) and one formula (`vrmPresetsFromArticulators`, moved out of the rig
  unchanged). Pro2D takes the voice-timed visemes when there are any, else the mouth summary (the camera-only case).
* **Audio2Face (`frame.a2f`)** through `readA2f`: the mouth channels, plus tongue / eye look / upper face, **camera-aware**: the
  camera keeps the gaze (A2F's eye look is carried but NOT applied until its sign is verified: dev flag `a2fDev.eyes`), the upper face may only raise what the camera
  sees (35 %), the tongue is A2F's alone.
* Tests: `npx tsx tools/lipbus_unit.ts`: the 3D vowel formula and the 2D drive's old sources equal frozen copies of the old
  code on thousands of random frames (no behaviour change), plus the mapping, the vowel mix, A2F's camera rules, the
  auto-rig's mouth shapes (they really move only the mouth: I/E widen, U/O narrow, A is tallest) and that a rig without them is
  driven exactly as before.

### Pro2D mouth shapes (Open + Form + five vowels)

The auto-rig (`shared/rig2d/edit/autorig.ts`) now also makes `ParamMouthA / I / U / E / O` (0..1) with keyforms on every mouth
part (lips, inside, teeth, tongue, the clipping opening), added on top of Open and Form: `VOWEL_SHAPES` gives each one's width
change, extra gape and upper-lip lift. `roles.bind` binds `mouthA..O` to them, so a new Pro2D avatar talks with vowel shapes;
`tools/rig2d_editor/vowelSheet.ts` renders the sheet (rest, open, A I U E O, O + smile, E turned) for review. A rig without
the parameters (every file made before) is read exactly as before; Live2D models are not changed (`ParamMouthA..O` is only
offered in the mapping panel, like the other extended mouth parameters). Format note (backward compatibility): the bindings are
written to `extra.vowelBind`, not `roles.bind`, so an older build loads the file and ignores the vowel shapes (docs/RIG2D_FORMAT.md).

### Rhubarb offline lip sync (`server/lipsync/rhubarb.ts`)

Rhubarb Lip Sync 1.14.0 (MIT; its dependencies are MIT / BSD / Boost: PocketSphinx and the CMU Sphinx model, Flite, libogg /
libvorbis, WebRTC, utf8proc, TCLAP, GSL, cppformat, utf8-cpp, and `whereami` under the WTFPL, a permissive licence; full texts
in docs/licenses/rhubarb_LICENSE.md) is run **headless on a WAV** (no audio output, no window, no network) and its cues are
mapped to our visemes. Used where the app plays **prepared speech**: the AI game master's server-rendered voice lines
(`POST /api/ttrpg/voice/line` returns `lip: [[t0, t1, viseme], ...]` for WAV lines; the studio sends it with `sayAt`; the GM's
mouth follows the real sounds, `src/ttrpg/gm/speech.ts trackFromLip`). Without Rhubarb the text-driven mouth carries on.

* Windows only (the vendored build). Found in `VTP_RHUBARB` (an unpacked folder), `tools/vendor/rhubarb/`, or the vendored zip
  (`VTP_RHUBARB_ZIP`) unpacked once into the temp folder (only `rhubarb.exe` + `res/` + the licence, by a small zip reader that
  refuses names outside the folder). The words of a line never reach a command line (a temp file at most).
* **Modes.** Default `phonetic` (language-independent): a 6 s line in 0.7 s (**0.12x real time**). `VTP_RHUBARB_MODE=pocketSphinx`
  (English recogniser, the words as `--dialogFile`): 6-9 s for 6 s of audio (about 1x), too slow to wait for.
* Provider (MP3) voice lines are not converted (Rhubarb reads WAV / OGG): they keep the text-driven mouth + level.
* **Accuracy** (`tools/eval_rhubarb.ts`, the recorded clip's 32 hand-labelled events, a shape anywhere in the event): Rhubarb
  pocketSphinx **18/32**, phonetic **17/32**, our engine **25/32**. Rhubarb is a good second opinion for *prepared* audio (no live
  engine runs on it), not a replacement for the live engine.
* Tests: `npx tsx tools/rhubarb_unit.ts` (cue parsing, segments, the zip reader on a synthetic zip, the bus clean-up, the GM's
  mouth timeline); with `VTP_RHUBARB_ZIP=<zip> VTP_RHUBARB_WAV=<wav>` it also runs the real CLI.

### HeadAudio evaluated (MIT; **not integrated**)

HeadAudio 1.0.0 (met4citizen; an AudioWorklet: MFCC + Gaussian prototypes + Mahalanobis classifier, Oculus 15 out, model trained
on four Kokoro TTS voices) was run offline through its own `Processor` on the clip's 48 kHz audio in 128-sample blocks, with the
silence calibration it asks for (`tools/eval_headaudio.ts --ha <unpacked npm package>`; the package is not in the repo).
Same scoring as the neural-viseme evaluation (32 hand-labelled events, display delay D = 60 ms):

| system | strict / visual (of 32) | PP | FF | SS | ee->I | oo->U | oh->O |
|---|---|---|---|---|---|---|---|
| engine (rules) | 21 / 23 | 8/11 | 3/4 | 4/6 | 85 % | 100 % | 61 % |
| neural (fast) | 18 / 21 | 3/11 | 1/4 | 6/6 | 84 % | 36 % | 78 % |
| ours (engine + neural, mix 0.35) | **22 / 26** | 6/11 | 3/4 | 6/6 | 87 % | 83 % | 78 % |
| HeadAudio (defaults, calibrated) | 2 / 7 | 0/11 | 0/4 | 0/6 | 0 % | 0 % | 0 % |
| HeadAudio (best of 32 settings: pitch 100-200 Hz, 4 VAD gates, calibrated or not) | 7 / 16 | | | | | | |

* Latency: HeadAudio's classifier answers about 16 ms after a frame's centre (+ 2.7 ms block), then a majority vote over six
  frames and its own 100 ms alpha ramp on the avatar (its README says 50-100 ms; the 60 ms target is only met before the
  ramp). Ours: neural visemes 33 ms + <= 32 ms chunking, A2F about 71 ms at a 60 ms look-ahead (docs/GPU_TRACKING.md).
  CPU: 2.5 ms per audio second.
* Why it loses here: it was trained on synthetic TTS voices and this is a human on a microphone, with no gain / noise front end
  (ours has RNNoise + a voice gate in front). It may do better on TTS audio, which this PC could not generate for the test (no
  sound / TTS rule). Its README says the audio-driven approach is less accurate than text-driven. Decision: our own browser
  engine stays the non-GPU path; HeadAudio is not a dependency and not bundled.

## Audio mixer (every voice: level, volume, Mute for me, noise gates)

**Where:** the show dock → **Guests** → **Audio mixer** (also in **Tools**). One row per voice. Every guest starts at
100 %, nothing muted, no gate.

**Every sound plays in the studio, never on the OBS page.** VTube Pro never sends a guest's voice to OBS (not to the OBS
page, not as a muted or volume-0 track; the OBS page even refuses one), and read-aloud, the room screen video's sound,
room sounds and the tabletop narrator play in the studio too. Your stream gets all of it the same way it gets a Discord
call: OBS's desktop or application audio capture of the studio window. The OBS page gets only pictures and how loudly
people are talking, for the cameras and talk animations, and it is structurally silent (see *Show sounds* below).

| Row | What you see | What you can change |
|---|---|---|
| **You** | your mic's level (bar = average, white tick = recent peak, **Too loud** lights up when it distorts), *Talking* / *Quiet*, a blue tick at your room's learned noise level | **Voice filter** Off / Standard / Strong (the voice front-end above), **Browser noise suppression** (the browser's own, on your mic; restarts the mic; needs the voice filter on), **Learn my room's noise** (stay quiet 3 s) |
| **Each guest** (interview link guests and VTube Pro party guests who talk in the app) | their level as it arrives, *Talking* / *Quiet* / *Muted for you* / *gate closed*, the gate threshold as a blue tick. Two guests with the same name are numbered (#1, #2) | **Volume** (the same volume as **Live → People**), **Mute for me**, **Mute for everyone**, **Noise gate** Off / Auto / Manual, **Clean up hiss**, **Gate timing** |
| **Show sounds** | read-aloud, the room screen video's sound, room sounds (air horns, slaps, the poll sting), the tabletop narrator (once it has spoken): each with its meter, *Playing* / *Quiet* | volume (read-aloud: the Chat Hub's; the video: the room's), read-aloud on / off, video sound on / off |

The room's React screen never plays the shared window's sound (the capture is picture only), so it has no row. Your own
voice isn't played by VTube Pro: your stream gets it from OBS's mic source.

### Mute for me vs Mute for everyone

* **Mute for me**: you stop hearing that guest in the studio, backstage talk included. Their voice level is still
  measured, so **the camera director still cuts to them and their speaking glow still shows**. Use it when a guest is
  also in your Discord call: you hear them in Discord, Discord reaches your stream on its own, and nobody is heard
  twice. Other guests still hear them.
* **Mute for everyone** is the moderation mute (the one in **Live → People**): nobody hears them, not you, not the
  other guests, and the cameras stop cutting to them.

### Noise gate (guests)

A gate lets a voice through only while it is louder than a threshold, and cuts the background in between words.

* **Auto** (the easy one): listens to the guest for a few seconds, finds their quietest steady sound (fan, hum, room
  noise) and sets the threshold 12 dB above it. While it listens (the first 3 seconds, after a new microphone, or after
  **Learn their background again**) everything passes; for a link guest the cameras don't take their level yet (a noisy
  room can't win a cut before the floor is known), while a VTube Pro party guest keeps their mouth (their own app's voice
  filter already gates it; closing it would cut their first words on stream). It keeps following the room: if a fan
  gets louder, the threshold follows within a few seconds.
* **Manual**: you set **Cut below** (dB). Watch the meter: put the blue tick above the bar's level when they are quiet
  and below it when they talk.
* **Gate timing**: **Fade in** (how fast it opens), **Stay open** (how long it waits after the last sound before
  closing, so the end of a word isn't cut), **Fade out**. The defaults (5 ms, 200 ms, 150 ms) suit speech.
* **Clean up hiss**: a light noise remover before the gate (steady hiss and hum go down by about 9 dB; voices keep
  their level). It adds 11 ms of delay to that guest.

What the gate decides is what you hear **and what the camera director reads**: while a guest's gate is shut, their
level counts as silence (for VTube Pro party guests: their voice samples go out silent and their camera mouth closed, so
their speaking signal stays at zero on every page, even when only frames arrive), so their
background noise can never switch the camera to them. This holds whatever **Mute for me** says. A gate cannot tell a
voice from a noise that is just as loud (a keyboard right next to the mic, a dog): it is a level gate. Your own mic
doesn't need one: the voice filter above already ignores noise and other voices.

### Where guest voices go

| Output | Gets |
|---|---|
| Your speakers / headphones (**Hear guests here**) | their voice through the mixer (gate, volume), unless muted for you or for everyone, and only while they are on the show |
| Backstage talk (green room) | their voice, unless muted for you or for everyone |
| Your OBS page | **nothing**: no guest voice, ever (only their picture and their level for the cameras) |
| The camera director, talk gestures, speaking glow | their level after the gate, whatever the volume or **Mute for me** |
| The other guests | their voice as before (the gate is only on your side) |

If the mixer can't run (the browser starts sound only after a click in the studio window, or the noise gate couldn't
load: the card says so and has **Try again**), guests still play in the studio the plain way, without a gate, and
**Mute for me** still works. They never go to OBS instead. A failed start is retried after 3, 10 and 30 seconds, then
only when you press **Try again**.

Settings are remembered in this browser per guest: by their Discord id, or by their interview link identity (the same
person on the same link in the same browser). Never by name: two guests called Alex are two people. A guest with
neither keeps their settings until they disconnect. Moving a guest's volume back to 100 % (or Undo) in **Live →
People** forgets the remembered lower volume.

### Show sounds (all in the studio)

* **Read-aloud**: every line the Chat Hub reads (your computer's voices, or the free Kokoro voice:
  docs/CHAT_HUB.md "Kokoro voice") plays in the studio window at the Chat Hub's volume (the Chat Hub window no
  longer plays it, so it is never heard twice). Keep the studio open.
* **Room screen video sound**: when the room shows a video and its sound is on, the studio plays the same file on the
  same clock (Talk mode, where the room's screen shows it). A live stream (`live:` URL, HLS or direct) plays its sound in
  the studio too, following the OBS picture: the OBS page tells the studio how far behind the live edge it plays
  (`{type:'liveclock'}`, twice a second) and the studio's sound keeps the same distance, within about 150 ms. The stream
  is downloaded twice (the picture on the OBS page, the sound in the studio). A **camera** on the screen is picture only:
  add its microphone with **Add a sound input**. The **window feed** is picture only, and VTube Pro can't hear another
  app's sound. The mixer's row says so when one of them is on the screen.
* **Sound inputs** (**Add a sound input**): any audio input device (a camera's microphone, a capture card, an interface
  channel) becomes a mixer row with a meter, volume, Mute and the noise gate, played here in the studio. Its device is
  remembered; nothing plays until you add one. If it is unplugged or blocked, the row says so with **Try again**.
  It plays through the studio's sound, so **don't also capture that device in OBS** (it would be heard twice), and wear
  headphones if the mic can hear your speakers (the row says both). **Echo cancel** is on by default (a mic that hears
  your speakers would put your guests back on stream a moment late); turn it off for a capture card or a music source.
  Automatic gain is always off (the noise gate needs steady levels) and the browser's noise suppression is off (the
  row's **Clean up hiss** does that). The device is open only in the studio window that plays the show's sounds
  (below): another window shows *In the other window*, and the device closes when a window stops playing or the mixer
  closes.
* **Games**: the Trail's sounds when you play it inside the studio. The row appears as soon as a game is open; a window
  that stops playing the show's sounds silences the game's sounds at once.
* **Only me**: the tabletop narrator's private lines (Plays on → Only me) on an output you pick, e.g. your headphones.
  On **Same as the studio** (or in a browser that can't pick an output) a window or desktop capture in OBS hears them
  too: the row says so. If the output you picked isn't there (unplugged), the lines play with the studio and the row
  says that too, instead of claiming they are private.
* **Room sounds**: the club's air horn and raid drop, the slap gag's punches, the poll winner sting. The OBS pages work
  out when they happen and send them to the studio (`{type:'showsound'}`); the studio plays each once, however many OBS
  pages there are. Previews and `?sceneTest` pages send nothing.
* **Tabletop narrator**: rendered GM lines play in the studio at their start time; the OBS pages measure them silently
  so the GM's mouth still follows the voice. A line that can't be rendered is shown as a caption only (never spoken by
  the browser's own voice, which a capture would pick up).

**Exactly one studio window plays them.** No heartbeat election decides it:
* **Two windows of the same studio** (two tabs): the browser's lock *vtp-show-sounds* (Web Locks). The window holding
  it plays; the others wait in line and the browser hands the lock to the next one the moment the holder closes,
  crashes or is discarded (sleep and background throttling can't split a lock). A page the browser keeps in its
  back-forward cache lets go when it is hidden and asks again when it comes back. A browser without Web Locks: the
  oldest open window plays; the windows ask each other every 3 s and forget one that misses two asks (crashed); a
  window alone always plays.
* **The same studio on `localhost` and `127.0.0.1`, or in two browsers** (different locks): the **server** decides. Each
  window holding its lock tells the server's bus (`{type:'soundhello', id, key}`); the server grants the sounds to
  exactly one (`{type:'soundlead', id}`). Only studios that announced themselves hear grants (OBS pages and tools
  don't). `key` is a secret the tabs of one site share in one browser: the next tab of that studio (or the same page on
  a new connection) takes over its place at once, while a socket repeating someone else's id is ignored and logged, so
  no page can take a grant. The server pings the studios every 2 s: one that misses a ping (a crashed tab whose
  connection never closed) is dropped and the next one is granted. A page can't fake a grant (the server never passes
  these messages on).
* **Nobody to ask.** A studio whose server bus drops waits a moment (a reconnect is not a dead server; meanwhile the
  server may grant another studio). After 3 s, only the studio that last had the grant plays on — or one that never
  saw anyone else get it — so two studios that both lost the server never both start.

The mixer says *Sounds play in this window*, *…in your other window of this studio*, or why this window can't. Observer tabs never play. Sounds that arrive while a window is still finding out (a moment) are
kept and played once it knows; losing the lead stops whatever was playing (a line, a horn, the narrator, a game) at
once.

**The OBS page is silent by construction** (`src/audio/silentPage.ts`, loaded first on `output.html`, previews and
`?sceneTest` pages, and the Trail's OBS view): every `<audio>` / `<video>` stays muted (it can't be unmuted), every
audio graph ends in a muted output, browser speech does nothing. Nothing to set in OBS, and no `?voice=0` /
`?videoAudio=0` needed any more.

### How it works (for developers)

* `shared/audioMix.ts`: the rules above in one place (`hostPlayGain`, `backstagePlays`, `directorLevel`), the settings
  and their per-identity store (`localStorage['vtp.audioMix']`).
* `src/audio/mixer/gate-worklet.js`: the gate + clean-up DSP on the audio thread (10 ms RMS detector, 5 dB hysteresis,
  hold, attack / release fades, closed = −60 dB; Auto = quietest 100 ms level of the last 5 s + 12 dB, ignoring digital
  silence; clean-up = 512-point STFT, minimum-tracked noise per bin, gain ≥ −14 dB; nothing allocated per block). It
  also sends the meters' numbers (~30 per second).
* `src/audio/mixer/audioMixer.ts`: one node per guest voice (always: it is how guests are played), plus your mic while
  the card is open. Hooks it answers: `TvStudio.mix` (`skipPlayer`: no fallback `<audio>` while the mixer plays them or
  they are muted for me; `mutedForMe`: backstage), `TvLinks.levelGate` (link guests' level → the director) and
  `Party.voiceGated` (app guests: silent voice samples + closed camera mouth while their gate is shut, relayed that way
  to everyone). Failed starts / node builds retry on a timer (3, 10, 30 s), a module load that hangs times out after 10 s,
  and a sync never waits for a start.
* `src/audio/mixer/showSounds.ts`: the show-sound rows (read-aloud, video incl. live streams, room, games, narrator, Only me) and
  their meters; `shared/audioLeader.ts` (the server's `SoundArbiter`, the `decideLead` table) +
  `src/audio/mixer/audioLeader.ts` (the Web Lock + the server's grant) + `server/bus.ts`: one window plays;
  `shared/showSound.ts` + `src/audio/showSoundRelay.ts`: what OBS pages send. `src/audio/silentPage.ts`: the silence
  guard. `src/net/tv/tvLocal.ts`'s receiver refuses any offer or track with audio.
* `src/audio/mixer/wireMixer.ts`: connects it to the party (used by the studio and by the e2e test, so both run the
  same wiring). `src/ui/audioMixerPanel.ts`: the card; `mountAudioMixer(app)` from `src/main.ts`.
* `src/net/tv/tvStudio.ts` sends this PC's OBS pages pictures + levels only; `src/net/tv/tvLocal.ts`'s sender drops any
  audio feed, so no code path can put a guest's voice on the OBS page.
* Tests (no sound anywhere): `npx tsx tools/audio_mixer_unit.ts` (the gate on synthetic noise and speech, the rules,
  identities, persistence, the director cutting to a muted-for-me guest, the server's choice of one studio with a fake bus
  and fake Web Locks); `node tools/audio_mixer_e2e.mjs --out <dir>`
  (a muted headless Chrome running the real routing: guest TvLinks / PartyVoice over loopback WebRTC, the host's
  TvStudio / Moderation / mixer, the OBS-page receiver and a director on its levels; a failed gate module, a suspended
  context, a reconnect, a new mic, two guests with the same name, Undo; asserts the OBS page never receives a guest
  audio track; app guests' packets through the real `Party.onRt` + smoothing; scheduled retries; the show sounds' meters;
  every test audio context verified on the "none" output or the test stops; two studio windows sharing the real Web Lock
  (close the one that plays: the other plays the next line); screenshots);
  `node tools/output_silence_e2e.mjs --out <dir>` (a private server: real OBS page, preview, `?sceneTest` in several
  rooms and the Trail's OBS view stay silent through the show's sound triggers and deliberate attempts, plus a control
  page proving the check can see a sound; and the real server bus granting the sounds to one studio).
