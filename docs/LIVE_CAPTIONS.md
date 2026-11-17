# Live captions, Kokoro alert voice and the event feed

Free, local, on your user's demand. Nothing here downloads, starts or listens until the user presses a button, and
nothing leaves the PC. Lane #194 of the tech-stack brief (`research/IMPLEMENT-BRIEF-tech-stack.md`, item 5).

| Piece | What it is | Where |
|---|---|---|
| Live captions | faster-whisper (MIT) + a stable-prefix policy, an OBS overlay page and `.srt` / `.vtt` files | `server/captions/*`, `captions.html`, `src/captions/overlay.ts`, `tools/voice/whisper_sidecar.py` |
| Alert voice | Kokoro-82M (Apache-2.0 weights) as a third read-aloud engine | `server/kokoro.ts`, `tools/voice/kokoro_sidecar.py`, `tools/voice/kokoro_g2p.py` |
| Install | pinned, sha256-checked, on the button | `tools/voice/voice_setup.ts`, `server/voice/*` |

## Live captions

**For the user:** Tracking → Advanced → Voice lip-sync → **Live captions**. Press **Install live captions** (about
0.6 GB: a private Python 3.12, faster-whisper, one speech model; Base English by default), switch **Show live
captions** on, copy the **OBS address** (`http://127.0.0.1:5191/captions.html`) into an OBS Browser Source (1920 × 1080,
transparent). Every session also writes `captions-YYYYMMDD-HHMMSS.srt` and `.vtt` into `cache/captions/` (downloadable
from the card). **My recording starts now** opens a new pair whose time zero is that moment (the files use seconds
since the pair started; `offsetSec` shifts both).

**No second microphone.** The studio's voice front end (RNNoise + Silero gate, [VOICE.md](VOICE.md)) already makes a
16 kHz stream for the neural visemes and GPU lip sync. With captions on, the voice worker sends that same stream, in
100 ms binary frames with the per-10-ms "performer is speaking" gate flag, to the server (`/ws/captions-in`,
`src/audio/voice/captionLink.ts`). The tap is the high-passed mic *before* RNNoise (Whisper copes with noise better
than with RNNoise's artefacts); the gate flag decides *when* to listen: a TV or a guest below your level never reaches
the recogniser, and a word the recogniser puts where the gate was shut is dropped (Whisper's "Thank you." on silence).
Added cost on the audio path: one 160-sample copy per 10 ms in the worker (the worklet's chunk post already existed).
Only the real studio streams (never an observer window or a scene-test page).

**Overlay options** (in the OBS address): `size=44` (px) · `lines=2` · `chars=38` (per line) · `color=ffffff` · `bg=0.5`
(line background opacity) · `font=sans|serif|mono|rounded` · `align=left|center|right` · `valign=bottom|top` ·
`margin=5` (%) · `idle=4500` (ms until the text fades) · `tentative=1` (also show the dimmed, not-yet-final words).
Centred captions (the default) sit in a fixed-width block in the middle of the screen with every line starting at the block's
left edge, so a word already on screen never slides sideways as more words arrive; when the lines scroll up, the line that
now says something else fades in over 0.2 s. A page opened (or reloaded) in OBS is told only the words said in the last
4.5 s, never an older sentence; the captions are forgotten when they are switched off.

### The policy: no flicker, ≤ 2 s

A Whisper-style model cannot stream; you re-run it on a growing window and every run may word the same stretch
differently. `server/captions/agreement.ts` implements the LocalAgreement idea (Macháček, Dabre, Bojar 2023,
"Turning Whisper into Real-Time Transcription System"): a word is **committed** only when two runs in a row agree on it
(longest common prefix; case and punctuation ignored); a committed word is never changed, removed or re-timed; the
uncommitted tail of the newest run is *tentative* (shown only if the user asks). A word older than 1.1 s that still hasn't agreed is committed as the newest run worded it (so one flip-flopping word
cannot hold the caption back; still no rewrite). The session (`session.ts`) windows the audio (trimmed at sentence ends,
≤ 14 s), starts a run every 0.3–1.5 s (adapts to the recogniser's own speed), needs 0.55 s of audio after the last speech
before it trusts the final word, ends an utterance after 0.7 s of silence (the tail becomes final), and feeds the last ~200
characters back as the prompt. The overlay (`CaptionView`) only ever appends words to the newest line or scrolls finished
lines up.

**Slow machines (quick mode).** "Two runs must agree" costs one whole extra run of lag, which is fine at 0.2 s a run and
not at 0.7 s. When the smoothed run time passes 0.35 s the session switches itself to quick mode: runs go back to back,
the window is cut after every commit (only uncommitted audio is re-run), a word the model is ≥ 85 % sure of (faster-whisper's
own word probability) is committed after ONE run once 0.4 s of audio follows it, and the lag bound stretches to
0.5 s + 1.6 x the run time so it cannot fire before a word could settle. The price: a rare wrong word the model was
confident about is final one run earlier. Words are still only ever appended. A window that cuts through an
already-final word can hand back a fragment of it; a low-confidence word that overlaps the final one at the window's
edge is dropped instead of being committed twice.

*SimulStreaming (ufal) is MIT-licensed* (checked at https://github.com/ufal/SimulStreaming, `LICENCE.txt`, 2026-10-23), but
its AlignAtt policy decodes with Whisper's cross-attention, which faster-whisper / CTranslate2 does not expose, so the
policy here is the LocalAgreement idea re-implemented from the paper; no code was copied.

### Numbers (mock recogniser, **not** a real model)

`tools/captions_unit.ts` replays transcripts with timings through a mock that behaves like a re-run Whisper (words
unreliable until 0.25–0.45 s of audio follow, word times jitter ±10–60 ms, hallucinated "Thank you." on silence, a word
that flips spelling on every run, a confidence per word) and **asserts** the lag (it is no longer just printed):

| Check (all asserted) | Result |
|---|---|
| committed words rewritten / re-ordered, over every commit (also flip-flopping words, 60 s without a pause, slow machines) | **0** |
| fuzz, normal machine: 200 random scripts, run 0.08–0.2 s + 0.01–0.03 s per second of window | every word right; per-script p95 ≤ 2.0 s (worst 1.56 s); pooled p50 **1.10 s**, p95 **1.39 s**, max 1.67 s |
| fuzz, slow machine: 150 random scripts, run **0.4–0.8 s** a pass (base 0.3–0.6 s + 0.02–0.04 s per second of window) | every word right; per-script p95 ≤ 2.0 s (worst 1.78 s); pooled p50 **1.18 s**, p95 **1.58 s**, max 1.81 s |
| 21 s of speech, run 0.12 s + 0.02 s/s | p95 1.36 s |
| same, run 0.45 s + 0.06 s/s (before quick mode this was p95 2.2 s, max 2.5 s) | p95 **1.56 s** |
| same, run 0.7 s + 0.04 s/s (about 0.8 s a pass) | p95 **1.94 s**, max 1.99 s, word-perfect |

**What lag to expect.** Lag ≈ 0.3–0.45 s (the model has to hear what follows a word) + waiting for the next run + the run
itself. On a computer where a run takes about 0.2 s: words show up around **1 s** after they are said, almost always
within 1.5 s. Where a run takes 0.4–0.8 s (a modest CPU with `small` models, or a busy PC): quick mode keeps 95 % of words
**under 2 s** (typically 1.2–1.6 s). Above about 0.8 s a run the target cannot be met, because a word cannot appear before
one full run after it settled: the Captions card then says so in plain words ("captions are about N seconds behind ... pick a
smaller model, or use your graphics card"). The card always shows the measured delay ("words appear about 1.2 seconds after
you say them, almost always within 1.7 s"), so this does not have to be guessed.

**Unverified on a real model and a real CPU:** nothing here ran faster-whisper (no model download on the dev PC), so how
long a run really takes is the one number this document cannot give. Expect `base.en` int8 on a mid-range 6-core CPU to run
a short window in roughly 0.3–0.6 s (its encoder cost is fixed per run, so shortening the window helps the decoder only);
a GPU is far faster.

### Install, pins, licences

`tools/voice/voice_setup.ts` (CLI: `npx tsx tools/voice/voice_setup.ts --dry-run`, `--parts runtime,captions,kokoro,gpu`,
`--model tiny.en|base.en|small.en|small`, `--status`, `--uninstall`): uv 0.12.19 (sha256 from the release) → Python 3.12
venv in `.voice/` (override `VTP_VOICE_DIR`) → onnxruntime 1.30.0, numpy 2.5.3, websockets 16.1.1 → ctranslate2 4.8.3,
tokenizers 0.23.3, huggingface-hub 1.24.0, tqdm 4.69.0, PyYAML 6.0.3 → `faster-whisper==1.2.1 --no-deps` → the model's four files from
`huggingface.co/Systran/faster-whisper-<model>` at a pinned commit, each refused unless its sha256 matches.

* **PyAV is not installed.** faster-whisper lists it, and PyAV's wheels bundle an FFmpeg built with x264 / x265 (GPL),
  which the brief forbids. The sidecar passes float arrays and never decodes files; it installs an empty `av` stand-in.
  Three layers: `tools/voice_setup_unit.ts` fails if `av`, torch, espeak, phonemizer or kokoro-onnx ever enter a package
  list (static); at every start the sidecar refuses to run (exit 3, "reinstall the voice pack") if a real PyAV is importable
  in its environment, imports faster-whisper with the stand-in, then proves `sys.modules['av']` and `faster_whisper.audio.av`
  are still that empty stand-in (runtime; `--check` prints `"av": "absent", "av_stub_verified": true`);
  `tools/voice/test_av_guard.py` runs the real sidecar against fake faster-whisper / PyAV packages to show each outcome.
* Whisper weights: MIT (OpenAI), converted by SYSTRAN, model cards `license: mit`. faster-whisper, CTranslate2: MIT.
* Every package is pinned to one exact version. The extra pins (numpy, huggingface-hub, tqdm, PyYAML and the CUDA 12 pair
  `nvidia-cublas-cu12==12.8.4.1`, `nvidia-cudnn-cu12==9.10.2.21`) were picked offline from versions seen working on the
  development PC and from PyTorch's CUDA 12.8 pins; run `--verify-pins` (below) to prove each is still published.
  The one-click install fetches `uv` itself on Windows only; on macOS / Linux it asks you to install `uv` first.
* Uninstall (`--uninstall`, the studio's Uninstall button) deletes only a folder that carries the `.vtube-pro-voice`
  marker (written by the setup; installs from before it are recognised by holding nothing but our own folders). A
  `VTP_VOICE_DIR` that points at a folder with other files is refused, nothing deleted.
* Optional GPU libraries (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`): NVIDIA's licence, downloaded from PyPI onto the
  user's PC only when asked, never bundled. CUDA failing to load falls back to the CPU. **Not verified** (no GPU path was run).
* Full table: `THIRD_PARTY_NOTICES.md` → "Local voice pack".
* **Checking that the pins exist** (a person runs this; the tests never touch the network):
  `npx tsx tools/voice/voice_setup.ts --verify-pins` asks PyPI whether every `name==version` pin is still published,
  asks Hugging Face (a HEAD on the pinned-commit URL: `x-linked-size`, and `x-linked-etag` = the file's sha256) whether
  every model file still has the pinned size and sha256, checks the misaki wheel's sha256 against PyPI's JSON and that the
  uv release answers; exit 1 and a `FAIL` line per problem otherwise. The logic is unit-tested with a fake `fetch`.

**VTube Pro restarted while you are live.** Captions that were on come back at start. If OBS says it is streaming or
recording, or VTube Pro cannot tell, the speech model starts on the processor even when the graphics card is chosen (loading
it onto the card mid-stream stalls the game / encoder), and the card says so; switching captions off and on (your own click)
uses the card as chosen. The sidecars run at below-normal priority, and the supervisor never adopts a program that already
holds port 5200 / 5201: ours starts on a free port instead.

The sidecar binds `127.0.0.1` only, refuses any browser Origin that is not this PC (403), sets `HF_HUB_OFFLINE=1`, dies with
the server (`--parent-pid`) and is supervised (restart with back-off; exit code 2 = no model installed = no restart).

### Files and endpoints

`GET /api/captions/status` · `PUT /api/captions/config {on, model, lang, device, showTentative, offsetSec}` ·
`POST /api/captions/mark` · `GET /api/captions/files[/<name>]` · `POST /api/voice/setup {parts, model, dryRun}` ·
`/api/voice/setup/cancel` · `/api/voice/uninstall` · `GET /api/voice/status` · sockets `/ws/captions-in` (audio, this PC
only) and `/ws/captions` (the overlay). **One studio page owns the audio: the first one that is live.** A second page
(another tab, an old window) is turned away with code 4002 and waits (retry every 20 s); it takes over only when the
owner has sent nothing for 5 s (tab closed, mic off), and the old owner is then the passive one. Before, the newest page
always won, so two tabs with captions on swapped the stream every 15 s. All are this-PC-only (`webLocalOnly` + `requireLocal`; a web
page is refused, a stream PC cannot reach them).

### Tests (headless, no sound, no model)

```
npx tsx tools/captions_unit.ts          # policy, session, cues, SRT/VTT, overlay model, lag asserted incl. slow-machine fuzz (41)
npx tsx tools/captions_overlay_unit.ts  # the OBS page script on a fake DOM (13)
npx tsx tools/captions_link_unit.ts     # the studio-side frames, retry / passive-tab behaviour (17)
npx tsx tools/captions_server_unit.ts   # manager + routes + sockets + two-tab ownership + the sidecar in --fake mode (32)
npx tsx tools/voice_sidecars_unit.ts    # both sidecars' protocol, origin guard, WAV, Kokoro front end incl. other scripts, the PyAV runtime guard (69)
npx tsx tools/voice_setup_unit.ts       # pins, licence guard, dry run, sha256 download refusal, verify-pins logic (24)
npx tsx tools/kokoro_server_unit.ts     # engine, routes, read-aloud fallback, skipped lines (31)
npx tsx tools/chat_ingest_unit.ts       # every platform's fixture payloads -> the merged feed (99)
```
The sidecar tests need a Python with `websockets` and `numpy` (`VTP_TEST_PYTHON`); without one they print SKIP.

## Noise suppression: RNNoise stays; DeepFilterNet was **not** added

The brief asks for DeepFilterNet (MIT / Apache-2.0, checked: the repo is dual-licensed MIT or Apache-2.0) only "where it
fits ≤ 20 ms on CPU", and this lane's rule is to add it only if a measurement on recorded WAVs supports it. **No
measurement was possible**: its CPU build is a 27 MB program with the model inside (`deep-filter-0.5.6-…-msvc.exe`; the
ONNX models are 8–36 MB), and this lane may not download models on the dev PC. What is known without running it:
the repository's defaults are a 48 kHz STFT with a 960-sample (20 ms) window and 480-sample (10 ms) hop (`df/config.py`);
the released models also use convolutional lookahead frames on top (not verified here), and there is a "low-latency" ONNX
variant (`DeepFilterNet3_ll_onnx.tar.gz`, 36 MB). RNNoise in the front end today measures **19.3 ms** added audio latency
(one 10 ms frame + ≤ 9.3 ms of audio-worklet buffering, [VOICE.md](VOICE.md)) at ≈ 2 % of a core. A model with a 20 ms
window cannot come in under that with the same worklet buffering, so on the documented figures it does not clearly fit the
≤ 20 ms budget; it would be an optional "higher quality, more delay" choice at best. (Unmeasured: treat this as the reason
for not adding it blind, not as a result.) To settle it: with the owner's OK, fetch `DeepFilterNet3_ll_onnx.tar.gz`, run it through
onnxruntime on the recorded clips `tools/eval_voice.ts` already uses (cross-correlation delay, per-frame CPU time,
keyboard / fan / music rejection), and compare with the RNNoise rows. Until then RNNoise stays the only suppressor.

## Kokoro alert voice

Chat Hub → Read support messages aloud → Settings → Voice → **Kokoro (free, natural)** (see [CHAT_HUB.md](CHAT_HUB.md)).
Kokoro-82M v1.0, int8 ONNX (92 MB) on onnxruntime CPU, 8 American-English voices, 24 kHz, `POST /api/kokoro/say` returns a
`audio/wav` buffer (nothing is played by the server; the studio plays it through its mixer like any read-aloud line).
Started on the first line, stopped after 5 idle minutes (≈ 300 MB). Any failure → this computer's voice for that line, and a
30 s rest.

* **Licence check (weights card, 2026-10-23):** Kokoro-82M `license: apache-2.0`; "trained exclusively on
  permissive/non-copyrighted audio data": public domain, Apache / MIT audio, synthetic audio from closed TTS providers;
  two CC BY sets named (Koniwa `tnc` CC BY 3.0, SIWIS CC BY 4.0), attribution in `THIRD_PARTY_NOTICES.md`.
  The "synthetic audio from closed providers" line is the card's own statement; it is not independently checkable.
* **The GPL trap:** Kokoro's usual front end (`misaki[en]`, `kokoro-onnx`) needs espeak-ng and phonemizer (GPL-3.0). They are
  never installed. `tools/voice/kokoro_g2p.py` is a small own G2P over misaki's two Apache-2.0 dictionaries (90k + 93k
  words): inflections (-s, -ed, -ing, 's, 'm, 'll …), numbers and years as words, names split at case / digit / underscore
  boundaries, anything still unknown spelled letter by letter. **Other scripts** (`tools/voice/translit.py`, our own small
  tables): accents are folded (José → Jose, Łukasz → Lukasz, straße → strasse), kana → romaji (ナイト → naito, Hepburn, っ and ー
  handled), Cyrillic → Latin (Привет → privet) and Greek → Latin, and romanised text is read by plain letter rules
  (naito → "nigh-toe"). Han, Hangul, Arabic, Thai … and emoji have no table: that word is skipped silently. A line with
  nothing speakable at all (😀😀, 田中) is **skipped as a line**: the sidecar answers `unspeakable`, no other voice reads it,
  the engine is not rested and the "isn't ready (install it)" note is not shown (that is only for a real failure). No part-of-speech tagging: heteronyms ("read") take the
  dictionary's default. **Unverified by ear:** no audio was played; the phoneme strings were checked against the dictionary
  and Kokoro's vocabulary, not listened to, and no real inference was run (no model download). The first real listen is
  the owner's.

## Event feed: what was checked

`tools/chat_ingest_unit.ts` feeds hand-written payloads in each platform's documented shape (not captures from a live
stream) to the real connectors and the real `ChatHub`:

* **Twitch** IRC, read anonymously with no sign-in (chat + emotes, cheers, sub, resub, mystery gift with recipients,
  raid, announcement, deletion).
* **YouTube** (chat, Super Chat in $ and €, Super Sticker, new member, milestone, gifted memberships, gift redemption,
  deletion), **Kick** (chat + emote, Kicks, host, reward, follow, sub, resub, gifted-sub burst, deletion), **Rumble**
  (two polls of the Livestream API: chat, Rant, sub, gifted subs, follower), **TikTok** (chat, gift streak counted once,
  subscribe, follow, share, LIVE end).
* One merged feed holds all five platforms with unique ids and every support kind.

Completeness findings: YouTube covers Super Chats, Stickers, new members, milestones, gifted memberships and Jewels;
Kick covers Kicks, subs, resubs, gifted subs, hosts, rewards and follows; Twitch follows, channel-point redeems and
hype trains would need a Twitch sign-in, so they are not shown. Kick's *official* API (webhooks) would need a public URL
and a sign-in app, so it is not used; the local Pusher path is the default.
