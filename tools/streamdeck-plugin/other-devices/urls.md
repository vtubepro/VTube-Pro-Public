# VTube Pro — every controllable action as a URL

Generated from `shared/deck.ts` by `tools/streamdeck-plugin/make_other_devices.ts`. See docs/STREAM_DECK.md.

Send an HTTP **POST** from this PC (no key needed; tools that can only do GET: copy the per-PC URL with `key=` from VTube Pro → Stream Deck & controllers).

| Group | Action | POST URL (default parameters) | Parameters |
|---|---|---|---|
| Scene | 💡 Lighting state | `http://127.0.0.1:5191/api/deck/run/lighting?state=show` | `state`: preshow / show / react / brb / outro |
| Scene | 🎬 Stage mode | `http://127.0.0.1:5191/api/deck/run/mode?mode=talk` | `mode`: talk / react / gaming / interview |
| Scene | 🏠 Go to room | `http://127.0.0.1:5191/api/deck/run/room?sceneId=` | `sceneId` |
| Scene | 🧭 Room area | `http://127.0.0.1:5191/api/deck/run/area?area=next` | `area` |
| Scene | 🎭 Reveal room (curtain) | `http://127.0.0.1:5191/api/deck/run/curtain` | — |
| Scene | 🙈 Hide my screen (capture cover) | `http://127.0.0.1:5191/api/deck/run/cover?on=toggle&text=&style=` | `on`: toggle / true / false; `text`; `style` |
| Scene | 🎞️ Room transition | `http://127.0.0.1:5191/api/deck/run/transition?style=vtp-dark&dur=0&hold=keep` | `style`; `dur`; `hold`: keep / true / false / toggle |
| Scene | 🎥 Camera move | `http://127.0.0.1:5191/api/deck/run/camera-move?secs=0` | `secs` |
| Scene | ☕ BRB card look | `http://127.0.0.1:5191/api/deck/run/brb-card?style=keep&theme=toggle&text=&bg=` | `style`: keep / breathe / sweep / dots; `theme`: keep / dark / light / toggle; `text`; `bg` |
| Scene | 🙊 Hide chat on stream | `http://127.0.0.1:5191/api/deck/run/chat-hide?on=toggle` | `on`: toggle / true / false |
| Scene | 📺 Screen video | `http://127.0.0.1:5191/api/deck/run/video?action=toggle&slot=` | `action`: toggle / play / stop / next / restart / off / on; `slot`: "" / preshow / ambience / brb / outro |
| Scene | 📷 Scene camera | `http://127.0.0.1:5191/api/deck/run/camera?cam=auto&focus=` | `cam`: auto / talk / group / wide / screen / react; `focus` |
| Scene | 🚶 In the room / outside | `http://127.0.0.1:5191/api/deck/run/presence?who=me&on=toggle&how=` | `who`; `on`: toggle / in / out; `how`: "" / walk / instant |
| Scene | 🚪 Entrances | `http://127.0.0.1:5191/api/deck/run/entrances?walk=toggle&join=` | `walk`: toggle / true / false / ""; `join`: "" / walk / seated / outside |
| Scene | 🔊 Screen video sound | `http://127.0.0.1:5191/api/deck/run/video-audio` | — |
| Scene | 🎥 Ambient cameras | `http://127.0.0.1:5191/api/deck/run/ambcam?action=next&state=` | `action`: next / toggle / auto / orbit / pan / dolly / crane / zoom / drift / security / tour; `state`: "" / preshow / brb / outro |
| Scene | 🌦️ Weather | `http://127.0.0.1:5191/api/deck/run/weather?weather=rain` | `weather`: clear / cloudy / overcast / rain / heavyrain / storm / fog |
| Scene | 🕗 Time of day | `http://127.0.0.1:5191/api/deck/run/hour?hour=21` | `hour` |
| Scene | ⚔️ Background raid | `http://127.0.0.1:5191/api/deck/run/raid` | — |
| Scene | 💥 Warzone set piece | `http://127.0.0.1:5191/api/deck/run/warzone?event=wz_airstrike` | `event`: wz_airstrike / wz_armor / wz_assault / wz_technical / wz_mortar / wz_heli / wz_flare / wz_sniper |
| Scene | 🤫 Calm the battle | `http://127.0.0.1:5191/api/deck/run/calm` | — |
| Scene | 🪩 Club moment | `http://127.0.0.1:5191/api/deck/run/club?event=conga` | `event` |
| Scene | 🥂 Lounge celebration | `http://127.0.0.1:5191/api/deck/run/lounge?event=t3&count=5&user=` | `event`: t1 / t2 / t3 / t4 / t5 / gift / train / sub / raid / calm / toggle; `count`; `user` |
| Fun | 🖐️ Slap! | `http://127.0.0.1:5191/api/deck/run/slap?target=random` | `target` |
| Fun | 💃 Emote | `http://127.0.0.1:5191/api/deck/run/emote?name=wave` | `name` |
| Fun | 😊 Expression | `http://127.0.0.1:5191/api/deck/run/expression?name=happy&seconds=2.5` | `name`: happy / angry / sad / surprised / relaxed; `seconds` |
| Show | 🎥 Interview shot | `http://127.0.0.1:5191/api/deck/run/interview?shot=auto` | `shot`: auto / manual / establishing / host / cohost1 / cohost2 / hosts / panel / guest / guest1 / guest2 / guest3 / guest4 / ots / two / wide / audience / house / take / sidekick / push / snap / reverse / bumper / pin / turn-guest / turn-host / pace-calm / pace-normal / pace-snappy |
| Party | 🪑 Guest: studio / monitor | `http://127.0.0.1:5191/api/deck/run/guest-place?guest=1&where=toggle&peer=` | `guest`; `where`: toggle / studio / monitor; `peer` |
| Party | 🤝 Co-host / guest | `http://127.0.0.1:5191/api/deck/run/interview-role?who=guest1&role=toggle` | `who`; `role`: toggle / cohost / guest |
| Party | 🚪 Let in (knock) | `http://127.0.0.1:5191/api/deck/run/knock-approve` | — |
| Party | ⛔ Deny (knock) | `http://127.0.0.1:5191/api/deck/run/knock-deny` | — |
| Party | 👢 Kick guest | `http://127.0.0.1:5191/api/deck/run/guest-kick?guest=1&peer=&ban=false&revoke=false` | `guest`; `peer`; `ban`: false / true; `revoke`: false / true |
| Party | 🔇 Mute guest | `http://127.0.0.1:5191/api/deck/run/guest-mute?guest=1&peer=&on=toggle` | `guest`; `peer`; `on`: toggle / true / false |
| Party | 📷 Hide guest camera | `http://127.0.0.1:5191/api/deck/run/guest-cam?guest=1&peer=&on=toggle` | `guest`; `peer`; `on`: toggle / true / false |
| Party | 🔉 Guest volume | `http://127.0.0.1:5191/api/deck/run/guest-volume?guest=1&peer=&vol=100` | `guest`; `peer`; `vol` |
| Party | ⛔ Cut guest (camera + mic) | `http://127.0.0.1:5191/api/deck/run/guest-cut?guest=1&peer=&on=toggle` | `guest`; `peer`; `on`: toggle / true / false |
| Party | 🚨 Cut all guests | `http://127.0.0.1:5191/api/deck/run/guests-cut-all?on=true` | `on`: true / false / toggle |
| Party | ↩️ Undo (guest moderation) | `http://127.0.0.1:5191/api/deck/run/guest-undo` | — |
| Party | 🛋️ Cut: also to green room | `http://127.0.0.1:5191/api/deck/run/guest-cut-hold?on=toggle` | `on`: toggle / true / false |
| Party | 🎧 Link guests: voice | `http://127.0.0.1:5191/api/deck/run/guest-voice?what=hear&on=toggle&mic=` | `what`: hear / talkback / mic; `on`: toggle / true / false; `mic` |
| Party | 🛑 End party | `http://127.0.0.1:5191/api/deck/run/party-end` | — |
| Party | 🔗 Copy interview link | `http://127.0.0.1:5191/api/deck/run/guest-link?do=copy` | `do`: copy / off |
| Party | 🎬 Bring on (green room) | `http://127.0.0.1:5191/api/deck/run/greenroom-on?guest=0&peer=` | `guest`; `peer` |
| Party | 🚪 Back to green room | `http://127.0.0.1:5191/api/deck/run/greenroom-back?guest=0&peer=` | `guest`; `peer` |
| Party | ⏭️ Next guest | `http://127.0.0.1:5191/api/deck/run/greenroom-next` | — |
| Party | 💬 Message a guest | `http://127.0.0.1:5191/api/deck/run/greenroom-msg?preset=next&text=&to=next&guest=1&peer=` | `preset`: next / minute / live / hold / text; `text`; `to`: next / all / last / member; `guest`; `peer` |
| Party | 🎙️ Talk backstage | `http://127.0.0.1:5191/api/deck/run/greenroom-talk?peer=&on=toggle` | `peer`; `on`: toggle / true / false |
| Party | 🎧 Backstage voice output | `http://127.0.0.1:5191/api/deck/run/greenroom-output?sink=` | `sink` |
| Party | 🛋️ Green room: who waits | `http://127.0.0.1:5191/api/deck/run/greenroom-mode?mode=link` | `mode`: link / all / off |
| Me | 👗 Outfit | `http://127.0.0.1:5191/api/deck/run/costume?id=` | `id` |
| Me | 🎩 Accessory on / off | `http://127.0.0.1:5191/api/deck/run/accessory?id=` | `id` |
| Me | 🎚️ 2D model slider / outfit | `http://127.0.0.1:5191/api/deck/run/model-slider?slider=&do=toggle&value=1` | `slider`; `do`: toggle / step / set / reset / on / off; `value` |
| Me | 🎯 Recalibrate face | `http://127.0.0.1:5191/api/deck/run/recalibrate` | — |
| Me | 🧊 When tracking is lost | `http://127.0.0.1:5191/api/deck/run/trackloss?mode=hold&part=all` | `mode`: hold / rest / life / cycle; `part`: all / face / eyes / body / hands |
| Chat Hub | ✅ Acknowledge next | `http://127.0.0.1:5191/api/deck/run/hub-ack-next` | — |
| Chat Hub | 🙏 Thank next | `http://127.0.0.1:5191/api/deck/run/hub-thank-next` | — |
| Chat Hub | ☑️ Acknowledge all | `http://127.0.0.1:5191/api/deck/run/hub-ack-all` | — |
| Chat Hub | ⏭️ Skip read-aloud | `http://127.0.0.1:5191/api/deck/run/hub-skip` | — |
| Chat Hub | 🔁 Replay read-aloud | `http://127.0.0.1:5191/api/deck/run/hub-replay` | — |
| Chat Hub | 🗣️ Read-aloud on / off | `http://127.0.0.1:5191/api/deck/run/hub-tts` | — |
| Chat Hub | 🔔 Emote sounds on / off | `http://127.0.0.1:5191/api/deck/run/emote-sounds?on=toggle` | `on`: toggle / true / false |
| Poll | 📊 Start poll | `http://127.0.0.1:5191/api/deck/run/poll-start?template=` | `template` |
| Poll | 🏁 End poll | `http://127.0.0.1:5191/api/deck/run/poll-end` | — |
| Poll | 👁️ Show / hide poll | `http://127.0.0.1:5191/api/deck/run/poll-show?on=toggle` | `on`: toggle / show / hide |
| Goals | ⏱️ Subathon timer | `http://127.0.0.1:5191/api/deck/run/subathon?do=toggle&minutes=5&mult=2` | `do`: toggle / pause / resume / add / sub / undo / happy / happy-off / sleep / start; `minutes`; `mult` |
| Goals | 🎯 Goal | `http://127.0.0.1:5191/api/deck/run/goal?do=toggle&goal=&amount=5` | `do`: toggle / show / hide / add / newstream; `goal`; `amount` |
| Goals | 🎡 Spin the wheel | `http://127.0.0.1:5191/api/deck/run/wheel-spin` | — |
| Audience | 👏 Applause | `http://127.0.0.1:5191/api/deck/run/audience-applause` | — |
| Audience | ❓ Next question | `http://127.0.0.1:5191/api/deck/run/audience-next` | — |
| Audience | ✔️ Question done | `http://127.0.0.1:5191/api/deck/run/audience-done` | — |
| Stream extras | 🎯 Throw at my head | `http://127.0.0.1:5191/api/deck/run/throw?what=emote&count=1&item=&from=chat` | `what`: emote / prop / image / headpat; `count`; `item`; `from`: chat / raider / redeemer |
| Stream extras | 🎩 Item scene | `http://127.0.0.1:5191/api/deck/run/item-scene?name=&on=toggle` | `name`; `on`: toggle / true / false |
| Stream extras | 🏷️ Sticker on me | `http://127.0.0.1:5191/api/deck/run/sticker?op=random&item=&secs=0` | `op`: random / add / clear; `item`; `secs` |
| Stream extras | 🌧️ Emote rain | `http://127.0.0.1:5191/api/deck/run/emote-rain?op=burst&secs=8&from=chat` | `op`: burst / start / stop; `secs`; `from`: chat / raider / redeemer |
| Stream extras | 🔔 Play a sound | `http://127.0.0.1:5191/api/deck/run/sfx?id=&volume=70` | `id`; `volume` |
| Stream extras | 📼 Screen effect | `http://127.0.0.1:5191/api/deck/run/screen-fx?preset=glitch&secs=3` | `preset`: glitch / vhs / pixelate / shake / bloom / bw; `secs` |
| Stream extras | 🎞️ My recorded emote | `http://127.0.0.1:5191/api/deck/run/recorded-emote?name=` | `name` |
| Stream extras | 🤖 Co-host says | `http://127.0.0.1:5191/api/deck/run/cohost-say?text=` | `text` |
| Stream extras | 🤐 Mute co-host | `http://127.0.0.1:5191/api/deck/run/cohost-mute?on=toggle` | `on`: toggle / true / false |
| Advanced | ⚙️ Custom command | `http://127.0.0.1:5191/api/deck/run/command?command=scene&args=%7B%22lighting%22%3A%22show%22%7D` | `command`; `args` |
