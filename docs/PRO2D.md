# Pro2D: 2D avatars

**Pro2D** is VTube Pro's own 2D avatar system. Make a 2D avatar from your own layered drawing in the built-in **2D avatar
maker**, which rigs it for you in seconds, or use simple picture avatars ("PNGTubers"), right in the studio, with no
other app and no licence to buy. Your 2D avatar follows your face and voice, sits in 3D rooms next to 3D friends, and
shows in OBS like any other avatar.

Already have a rigged model from another 2D app? You can bring it over too: see
[Moving from another 2D app](#moving-from-another-2d-app).

This guide is in plain words. Creators who want the file format: [RIG2D_FORMAT.md](RIG2D_FORMAT.md).

---

## What you can bring

| You have | What happens |
|---|---|
| A **layered drawing** (`.psd` / `.psb` from Photoshop, GIMP, Krita, Clip Studio…) | Opens the **2D avatar maker**, which rigs it for you |
| **One flat picture** (PNG, JPG, WebP): a character, an animal, a mascot | Opens the **2D avatar maker**: you tap the eyes and the mouth, and it comes to life ([Just one picture](#just-one-picture)) |
| **Pictures** (PNG, GIF, WebP, JPEG): mouth closed, mouth open, maybe eyes closed | A picture avatar that talks and blinks |
| A **Pro2D file** (`.vtp2`) | Loaded as it is |
| A rigged model from **another 2D app** | Converted to Pro2D. See [Moving from another 2D app](#moving-from-another-2d-app) |

> **Only use models you own or have the artist's permission to use.** VTube Pro shows this reminder when you bring in a
> model from another app.

---

## Make a 2D avatar from your own drawing

You don't need any rigging software. Draw your character with each part on its own layer, and the maker rigs
it for you in seconds.

**No Photoshop? Use GIMP.** [GIMP](https://www.gimp.org/) is free and open source, and saves layered `.psd` files
(**File → Export As…**, name it `mychar.psd`). Krita and Clip Studio work too.

### Prepare your drawing

- One part per layer works best: **eyes**, **eyebrows**, **mouth**, **front hair**, **back hair**, **face**, **body**.
  More parts (eye whites, irises, lashes, side hair, ears, accessories) move better.
- Names like "eye L", "mouth" or "前髪" help, but the maker also looks at the pictures. Left and right come from where
  the part is, not its name.
- Folders named **Outfits/Casual**, **Hat** or **Glasses** become outfit switches by themselves. Folders named
  **Front**, **3/4** and **Side** become head-turn views.
- Text layers, adjustment layers and layer effects (shadows, strokes, glows) are not drawn: merge or rasterize them
  first. The maker tells you if it skipped one.

### Rig it

1. Open the maker: **Me** → **Create a 2D avatar**, or **Tools** → **Create a 2D avatar** (or drop a `.psd` anywhere).
2. Press **Choose your art** (or **Try the sample** to see how it works).
3. **What you'll see:** *Reading your art…*, then *Rigging your avatar…*, then *Your avatar is ready*. It moves with a
   demo motion. Switch **What moves the preview** to **My camera** to try it on.
4. The **Check** tab shows what it understood. If it isn't sure about a part, it asks with a picture: *Which of these
   is your left eye?* Click the answer.
5. Press **Use this avatar**. It goes into your library and on. **Save .vtp2** keeps a file copy.

The maker builds blinking, looking around, a talking mouth (it paints the inside of the mouth if your art has none),
a gentle head turn, breathing and hair physics by itself. The other tabs are optional:

| Tab | What you can do |
|---|---|
| **Sliders** | Try every movement by hand |
| **Bones** | Swinging hair, ears and hanging accessories: per part **Swing amount** (0 = still, 100 % = as made, up to 200 %) calms or livens everything it does; **Stiffness**, **Calms down**, **Hangs down (gravity)**, **How far it can swing**, **Wind** shape the motion |
| **Lighting** | Let the room's light fall on your art (**Use room light**, **Rim light**, **Outline**) |
| **Effects** | **Sparkles**, **Tears**, **Sweat drop**, **Steam**, **Hearts**, set off by your face, your voice, a chat word, a follow, a sub or a key |
| **Moods** | Faces that switch by themselves (happy on happy chat, a talking face) |
| **Outfits** | Which outfits and accessories start on or off |
| **Physics** | How long and bouncy the hair swing is (the same part cards as **Bones**) |
| **Expressions** | Save looks you can switch with a key |

You can open the maker again any time to change your avatar.

### Change a 2D avatar you already made

**Me** → **2D avatar options** (or **Avatars**, the pencil on its picture) → **Edit rig in the 2D avatar maker**. The
maker opens on your avatar as it is: its parts, bones, sliders, swing and expressions. Change what you like, then press
**Save to my avatar**. It stays the same avatar in your library, with all your settings (keys, sliders, how much each
part moves), and the stream switches to the new version once, when you save, never while you edit. Changed your mind?
**Undo my last edit** brings the version before your last save back (press it again to bring the edit back).

An imported model (one you brought in rather than made in the maker) opens the same way, as an editable copy: its
parts, pictures, sliders, the way it moves, its swing, outfits and expressions all come over. If anything couldn't come
over exactly, the maker says so when it opens and on its **Check** tab. When you save, it becomes a maker avatar. Until
you save it a second time, **Undo my last edit** brings the imported model back exactly as it was. Very large pictures
open a little smaller so your studio keeps running smoothly (the maker says so). A model whose artist doesn't allow
changes doesn't open in the maker.

---

## Just one picture

Only have one picture of your character, with no layers? That is enough. Open the maker (**Choose your art**, or drop the
picture on it) and pick your PNG, JPG or WebP. It works for anime and cartoon people, animals and mascots, and runs
in your browser: nothing is uploaded and no extra download is needed.

1. **Tap the eye on the LEFT of the picture**, then **the other eye**, then **the mouth**. Tap right on the middle of
   each. If your character has none (a mascot with no eyes, say), press **There isn't one**.
2. **Drag the dots** if one is not quite right, then press **Looks right**.
3. **What you'll see:** *Bringing your picture to life…*, then one sentence about what was done, for example *We cut out
   the background and gave it blinking eyes and a talking mouth.* Your character now turns, nods and tilts its head with
   your face, breathes, blinks and opens its mouth with your voice.

If the picture has a plain background (white, grey, a smooth gradient, even a grainy one), it is cut out for you; a busy one (a photo) is kept as it is, and the maker says so. A PNG with its own transparent background
is kept as it is, and works best. If the maker can't find the character against the background, it keeps the whole
picture and tells you. Eyes and mouth are cut out of the picture and the skin under them is filled in, so a closed eye
shows skin and a lid line. A mouth drawn open works too: when you are quiet it shows a plain closed mouth, and your own open mouth appears as you talk. The picture you dropped is never changed on your computer. Because it is one flat picture, hair and
clothes move along with the head and body instead of swinging by themselves; for hair that swings, use a layered drawing.

---

## Add pictures or a Pro2D file

1. Open **Me** and press **Add my model** (or just drop the file or folder anywhere on the studio).
2. Pick your `.vtp2` file, your pictures, or a folder or `.zip` of them.
3. **What you'll see:** VTube Pro notices it's a 2D avatar and opens **Add a 2D avatar**. It shows *Adding your 2D
   avatar…*, then *&lt;name&gt; is ready*.
4. Press **Done**. Your avatar is on, and it says: *It moves with you: its head, eyes, mouth and hair follow your face
   and voice by themselves.*

**Picture avatars:** drop two pictures of your character, one with the mouth closed and one with it open (add one with
the eyes closed if you have it). Names like `idle.png`, `talk.png` and `blink.png` help, but VTube Pro also works it out
from the pictures. GIFs move.

---

## Moving from another 2D app

Already have a rigged model from another 2D app? VTube Pro can convert models exported from Live2D Cubism or Inochi2D
into Pro2D, so you can keep using your character here. It is a one-way move: you get a Pro2D copy in your library, and
your original files are not changed.

| You have | What happens |
|---|---|
| A model folder or `.zip` with a `.model3.json`, a `.moc3` and its pictures | Converted to Pro2D. It moves with your face and voice by itself |
| The same model with its `.vtube.json` (VTube Studio settings) | The same, plus your VTube Studio face mapping and hotkey expressions |
| A puppet file (`.inx` or `.inp`) | Converted to Pro2D |

1. Open **Me** and press **Add my model** (or just drop the folder or file anywhere on the studio).
2. Pick the model's `.zip`, its folder, or all of its files.
3. **What you'll see:** the same *Adding your 2D avatar…*, then *&lt;name&gt; is ready*, with a reminder to use only
   models you own or have the artist's permission to use.

From a model with VTube Studio settings you'll also see *Your VTube Studio settings came along*. If one of its hotkeys
was a key the studio already uses, the message tells you which expressions need a new key (see
[Keys](#keys-for-your-expressions)).

What it can't read: old Cubism 2 models (`.moc`), editor project files (`.cmo3`), and Inochi2D INP2 files. It tells you
in one sentence if you drop one.

---

## Show it

**Me** → the **2D avatar** section (or the show dock's **Me** → **2D avatar options**) → **Show it**:

- **Standing in the room**: your 2D avatar stands, sits or rests on a pedestal in 3D rooms, lit by the room.
- **Flat over the stream**: a flat layer over your OBS picture. **Overlay around me** puts scenery behind you and a desk
  in front, moving with your head; bring your own from OBS, a PSD or pictures (2.5D overlays).
- **On a walking TV**: a TV body walks in and sits, with your avatar on its screen.
- **On a monitor at my spot**.

**How much each part moves.** In the same **2D avatar options**, under **Mouth** and **Head movement**: **Brows up** and
**Brows down (frown)** set how far the brows go each way (100 % = as your face does it). If the brows drop too far when
you frown, turn **Brows down** to about 40 %: raising them is not affected. **Fine-tune each part** has the same for the
eyes (open wide / close), where the eyes look, head turn, nod up / down and tilt, body sway, mouth smile / frown and blush.
The thin line under each part is what your face does right now, the coloured bar is what your avatar does, so you can see
a frown reach its limit. It changes on stream at once, without reloading, and works for every 2D model, including ones brought in from another app.

**Framing just works.** Only your drawn character counts (empty canvas round it is ignored), so every camera, React and
Gaming corner cam, party tile and full-screen cut-out shows your whole character, never clipped at the sides. When you
switch an outfit or move a slider that makes your art wider, the camera widens with it; your art keeps its size.

---

## Expressions, sliders and keys

### Keys for your expressions

Press an expression's key in the studio to switch it on, and again to switch it off. On Pro2D models **several
expressions can be on together** (like VTube Studio): blush plus tears plus a hat.

**To change a key:** in the **2D avatar** options, find the expression in **Expressions**, click its key button (*Press a key… (Esc =
cancel)*), then press the new key. **Delete** removes the key.

**Keys the studio keeps for itself.** Some keys already do something in the studio or the browser, so a model can't use
them. If you pick one, it says why in one sentence (for example *H hides the studio menus — pick another key*):

- **H**, **C**, **F**, **Esc**, **F1**, **F3**, **F5**, **F6**, **F7**, **F10**, **F11**, **F12**
- **Shift + 1 to 5** (lighting) and **Shift + T, R, G, I, P, S, Y** (show modes, Slap, tabletop)
- **Ctrl** or **Alt** with a number (outfits), and most **Ctrl** + letter keys (the browser's own)

Free for your model: the other letters and numbers, **F2**, **F4**, **F8**, **F9**, and the other **Shift** + letter keys.

### Model sliders

Many models have parts your face doesn't move: a jacket open or closed, a tail, sleeves, a prop. They're in **Model
sliders**. Drag a slider to set it; it's kept with this avatar.

Avatars made in the 2D avatar maker also get a **"… swing"** slider for every part that swings (side hair, back hair,
an ahoge, earrings): drag it down to calm that part live (0 = still), up to make it livelier. Side hair starts calm.

**Make a key or a chat word move a slider:** press **Keys and chat** on a slider, then pick:

- **When**: **Press a key…**, **or a chat word** (at least 3 letters), or a stream event (**A follow**, **A sub /
  membership**, **A raid**, **Bits / cheer**, **A donation / Super Chat**, **Any channel-point redeem**).
- **Does**: **Switch to a value and back**, or **Step through values**.
- **Smoothly over (seconds)**, **Back after (seconds)**, and **Chat / events at most every (seconds)** so chat can't spam
  it.

Keys, chat and the Stream Deck change the look for this stream only. Dragging the slider is what gets saved.

### Outfits and accessories

Outfits from your model (or from PSD folders) are switches under **Outfits** in the **2D avatar** options. Give each one a key
with **Add key**. When you wear a costume in **Me** whose name matches an outfit, that outfit switches on, and taking the
costume off puts things back. Accessories (a hat, glasses) switch on and off on their own, on top of any outfit.

### When I talk

Picture avatars (and rigged ones, if you like) can do something while you talk: **Hop**, **Squash and stretch**,
**Wobble**, **Shake**, **Pulse bigger**, **Lean forward**, **Nod**, **Glow**, **Brighten (others dim)**, **Sparkles**, or
**Nothing**. Louder talking makes a bigger action, up to a limit. **For** gives one expression its own action (an angry
face shakes instead of hopping).

---

## High-quality models (8K and 16K)

Big commissioned models load as they are: texture pages of 8K or 16K, several pages, up to about 1 GB. Just drop them.

- **The model works at once.** In the background VTube Pro makes lighter copies of its pictures (*Making your model
  sharper and lighter… you can use it now.*) and switches to them by itself.
- **Each picture at the size your shot needs**, compressed for your graphics chip (GPU texture compression, stored as
  KTX2 / Basis Universal), and kept within your device's graphics-memory budget (much smaller on a phone than on a
  desktop). A big model that would fill hundreds of MB of graphics memory as it is typically needs a small fraction of
  that in a normal shot.
- **Close-ups get sharper** before the camera cuts to them, and go back to the light version a couple of seconds after
  the shot is wide again.
- **Your original pictures stay untouched** in the file; the light copies are a cache that VTube Pro can always make
  again. Party guests receive the lighter versions.

**What you'll see:** in **Me** → the **2D avatar** section, **Picture quality** says in one line what is happening, for
example *Sharp and light: its textures are compressed for this device*, with the graphics memory it uses. If fine lines
or the eyes look damaged, turn on **Keep full quality** (the original pictures, uncompressed: more graphics memory) or
just **Keep the face at full quality**.

Technical details: [RIG2D_FORMAT.md](RIG2D_FORMAT.md) (texture tiers) and Performance.

---

## Turn your 2D avatar into 3D with your AI

Your own Claude or ChatGPT app, connected to VTube Pro, builds a 3D version of your Pro2D avatar in Blender (free) on
your computer, compares it with your 2D model and improves it round by round. The result is added to your library as a
**new** avatar (never put on by itself); your 2D avatar isn't changed.

1. In the **2D avatar** section, press **Make a 3D version with my AI**.
2. **The checklist**: one line and one button per row. **Set it all up for me** does every row at once.
   - **Your AI app**: Claude or ChatGPT, connected to VTube Pro.
   - **Blender**: 4.2 or newer (**Install Blender**, or get it yourself).
   - **Blender MCP (lets your AI work in Blender)**: recommended, not required (**Install it for me**, **Add to Claude**
     / **Add to ChatGPT**, **Open Blender for me**).
   - **3D toolkit**: a one-time download you approve.
   - **Base body**: VTube Pro's own bases (Mirelle, Kairo) are already included, nothing to download; or **Use my own
     base**.
   - **Not live right now**: never blocks, but while you stream nothing is installed and Blender waits until after your
     stream. Nothing is installed while a Blender window is open either.
3. Tick **This is my model, or its artist allows me to make a 3D version of it.**
4. Start in your AI app and let it work (usually 30 to 90 minutes). The drawer shows each round's 2D / 3D pictures, and
   reminds you when your AI paused (in Claude, click **Continue**).
5. When your AI asks to add the result, **Your AI is waiting for your OK**: press **Open the approval page** and
   approve. Each request waits up to 40 seconds; an OK that comes later is used for your AI's next request.
6. **Wear it**, or **Keep improving**. **Stop** and **Delete this job’s files** are always there.

Pictures of your model go to your own AI company as part of your chat; VTube Pro uploads nothing itself. The full guide:
[Pro2D → 3D with your own AI](PRO2D_TO_3D.md). The older converter, for models brought from another 2D app: [2D model to 3D](LIVE2D_TO_3D.md).

---

## Free tools and AI add-ons

**Make your AI better** (in **Create** → **Connect your AI**) recommends add-ons for the AI app you use, each installed
only after you tick its own consent sheet (**Add it**):

- **VTube Pro Creator skill**: our build instructions for your AI app.
- **Blender MCP**: lets your AI work in Blender.
- **GIMP** + **GIMP MCP**: offered when Photoshop isn't installed. GIMP is a free, open-source alternative to Photoshop
  for drawing layered `.psd` files for the 2D avatar maker, and the GIMP MCP lets your AI make that art with you.
- More, as links: ComfyUI, Frontend Design, Playwright and others.

**GIMP** and **Blender** are also in **Tools & add-ons**, with an **Install** button and the steps to get them yourself.
**Set up AI creation** (at the top of **Tools & add-ons**) finds or installs Blender and connects your AI apps in one go.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| *This is an old Cubism 2 model (.moc)* | VTube Pro reads Cubism 3 and newer. Ask the artist for a newer export |
| A PSD with no layers (a flattened one) | It opens as one flat picture: tap the eyes and the mouth ([Just one picture](#just-one-picture)). For hair and clothes that move on their own, save it again with the layers kept |
| *We couldn't find an eye (or a mouth) where you tapped* | Tap the middle of it, or press **There isn't one**. Nothing is made for a tap that was not on an eye or a mouth, and the sentence at the end only says what was made |
| *Your picture has a busy background, so we kept it* | The maker could not tell the character from the background, so the whole picture is used. A PNG with a transparent background works best |
| A part doesn't move right after the maker rigs it | Open the **Check** tab and answer its questions, or press **Rig again** |
| The brows (or the eyes, the mouth …) move too far one way | **2D avatar options** → **Brows down (frown)** / **Fine-tune each part**: lower that direction |
| An expression has no key after a VTube Studio import | Its key belonged to the studio. Click its key button and pick a free one |
| My avatar is cut off or tiny in a camera | Tell us with **Fix it** → **Ask a person**: framing is automatic and that's a bug |

---

## For creators and AIs

- The Pro2D file format (`.vtp2`): [RIG2D_FORMAT.md](RIG2D_FORMAT.md). A `.vtp2` is a ZIP with a `rig.json` and the
  pictures. Its JSON schema: `docs/rig2d.schema.json`.
- How Live2D and Inochi2D models are converted (clean room: no Live2D Cubism code is used, shipped or decompiled):
  [RIG2D_IMPORT_PROVENANCE.md](RIG2D_IMPORT_PROVENANCE.md), [RIG2D_IMPORT_TESTS.md](RIG2D_IMPORT_TESTS.md).
- Picture avatars, the 2D display modes and flat 2D rooms: [FLAT_AVATARS.md](FLAT_AVATARS.md).
- 2.5D overlays (the format `overlay.json`, layer order, depths, effects, imports): OVERLAYS_2D.md.
