# Making or adding an avatar (the easy way)

This guide is for anyone who wants a character on stream without learning 3D software. Everything here happens
inside the VTube Pro studio. If you want to build a model by hand in Blender, VRoid Studio or another 3D program,
read **[AVATARS_ADVANCED.md](AVATARS_ADVANCED.md)** instead.

You can open this guide from the studio: press **?** (top right) and pick **Guides**.

---

## The ways to get an avatar

| Way | Best for | What you need |
|---|---|---|
| **A. Import a model you already have** | VRoid Studio characters, models you bought or downloaded, anything made in Blender | The model file (`.vrm`, `.glb`, `.fbx`, `.obj`, `.blend` …) |
| **B. Describe it and let the AI make it** | "I have an idea but no model" | Blender (free) and an AI key (Claude, GPT or Grok) |
| **C. Use a sample avatar** | Trying the app out | Nothing: they come with VTube Pro |
| **D. A 2D avatar** | Your own layered drawing (PSD) in the 2D avatar maker, PNGTuber pictures, a Pro2D file, or a model from another 2D app | A `.psd`, your pictures, or the model's `.zip` / files: see [Pro2D: 2D avatars](PRO2D.md) |

The best-looking result for anime characters is still **VRoid Studio** (free) → export **VRM** → import (way A).

---

## A. Import a model you already have

Two ways in: drop the file anywhere (below), or press **Add my model** for the guided wizard ([Add my model](#add-my-model)).

## Drop a model anywhere

The easiest way: **drag your model onto VTube Pro**, anywhere on the studio window. A file, the model's whole folder
or a `.zip` all work (the `.zip` you downloaded is fine: no need to open it first). The **Import a model** window
opens, VTube Pro checks the model and fixes what it can, then shows:

- **What we did**, one sentence each. For example: *It was lying down, so we stood it up.* *It was saved at the wrong
  size, so we scaled it to a real height.* *We matched its skeleton, so your head, arms, legs and fingers move it.*
  *We matched its face shapes, so it blinks, talks and smiles.* *We found its textures, even the ones in other
  folders.* *We converted it from MMD so it works here.*
- **Good to know**: anything that is still limited, with one button that fixes it (for example **Choose the model's
  folder…** when textures are missing).
- **Details** (closed until you open it): the full check, which bones and face shapes were matched, and a switch for
  every automatic fix if you want to keep something as it was.

Press **Import**. It goes into your avatars; **Wear it now** puts it on (nothing changes on your stream before that).

**No skeleton?** VTube Pro finds the model's head, arms and legs by itself (it looks at a picture of the model with
the same body tracker that follows you) and gives it a simple skeleton right away, so it moves with you within
seconds. If Blender is on your PC, Blender then builds a more detailed skeleton in the background; VTube Pro tries
both in a few poses and keeps the one that moves more cleanly (**Undo** switches back). Creatures and objects get a
head-and-body rig that leans and nods with you. **No face shapes?** VTube Pro first looks at the face: modelled eyes are
made to blink, painted-on eyes are kept as they are, and a painted mouth is made to talk where it is. Only what is
missing gets drawn (a mouth and eyes that follow yours), so a model never ends up with two pairs of eyes.

**What it reads:** `.vrm`, `.glb`, `.gltf` (with its `.bin` and textures), MMD `.pmx` (with its textures), and,
through Blender (VTube Pro runs it for you), `.fbx`, `.obj` (with its `.mtl` and textures), `.blend` and the others in
the table below. Bone names from Mixamo, VRoid, Blender Rigify, MMD, Unreal, 3ds Max Biped, Character Creator, Daz and
Unity are matched automatically, and so are ARKit, VRM, MMD, VRChat and Oculus face shapes. Pro2D and PNG avatars
are sent to the 2D importer, and so are models from other 2D apps.

**If it can't be imported** (for example a VRoid Studio project instead of the exported `.vrm`, a Unity package, a
`.rar`, a Draco-compressed file), the window says why in one sentence and what to do, with **Show me how** and **Send
this to support** (a short report with no file names or anything personal).

The **Add my model** button in **Me** (under your avatar tiles, and in the empty list), the **Or drop your model file
here** box under it and **Settings → Guided set-ups → Add my model** open the same window. **Create a 2D avatar** next
to it opens the 2D avatar maker (a layered PSD or pictures).
**Set it up step by step…** (under **Details**) continues in **Add my model** below.

Use the **Add my model** wizard for the step-by-step version. It checks your model, then sets it up for you or walks you through it. Nothing shows
on your stream until you click **Use it now** at the end.

## Add my model

**Where to find it:** **Set it up step by step instead…** in the import window (under **Details**), the **Add my
model** box in **Create → 1 · Bring your own model**, the **Bring my own model…** button in the first-time setup, and
**Me → Advanced → Avatars → Add my model (guided)…**.

1. **Choose a file.** Drop your model on the big box, or click **Choose a file**.
2. **Check it.** A 3D preview of your model appears (it is *not* on your stream) with a check list in plain words:
   - **green ✓** = good, nothing to do
   - **yellow !** = works, but can be better (the line says how)
   - **red ✕** = missing, for example *"No mouth shapes found — we can add basic ones"*

   Press **Smile**, **Say “Ahh”**, **Blink**, **Look ←** and **Look →** under the preview to see what the face
   can already do. Then click **Next: set it up**.
3. **Set it up.** Pick one:
   - **Set it up for me** (recommended): VTube Pro does everything it can by itself and shows each change as it
     happens: it turns a model that faces away, matches face shapes with unusual names (for example a VRoid model
     saved as `.glb`), adds a drawn mouth if there is none, swaps painted-on eyes for eyes that blink and look
     around (or adds drawn eyes), picks the look (a shiny *toy* look for robots), lets hair and clothes swing, and
     frames the camera. You get a **Before / After** picture. **Fine-tune it myself** opens the walkthrough.
   - **Walk me through it**: one thing per step, with the live preview and test buttons: **Name**, **Size**,
     **Body**, **Face shapes**, **Mouth**, **Eyes**, **Look**, **Hair & clothes**, **Camera** and **Check all
     sides** (8 pictures of your model from every side). **Undo** takes back the last change, **Skip** and
     **Back** move around, and **Why?** explains each step. The steps list on the left lets you jump to any step.
4. **Save.** Click **Save it** (or **Looks good: save it**). The last screen, **Ready in VTube Pro!**, says where
   your model is kept. Click **Use it now** to wear it, or **Done** to keep your current avatar.

**Where your model is saved:** in your avatar library on your PC. Your model is never uploaded anywhere.

**Files that need Blender:** `.fbx`, `.obj`, `.blend` and the other formats in the table below are converted by
Blender on your PC, which VTube Pro runs for you. If Blender is missing, the check says so in one sentence. Install
Blender (free) and click **Try again**. Or export a `.glb` / `.vrm` from your 3D program: those open right away.
Adding a skeleton to a model without one also needs Blender (**Body** step, or "Add a skeleton" in **Set it up for
me**).

**The quick import** (for people who know their files): **Me → Advanced → Avatars → Import a model** imports
straight away and puts the model on screen, then shows the older rigging check with **Re-rig with Blender**,
**Set up the face** and **Use as is (limited tracking)**.

### Which files work?

| File | Works? | Notes |
|---|---|---|
| `.vrm` (VRoid Studio, VRM 0 and VRM 1) | ✓ best | Face, eyes, hair physics and expressions all work right away |
| `.glb` / `.gltf` | ✓ | A `.gltf` must be a single file (no separate `.bin` or textures). If you have a folder, export `.glb` instead |
| `.fbx` | ✓ with Blender | Converted automatically. Mixamo / Unity / Unreal characters are fine |
| `.obj` | ✓ with Blender | Shape only; the colours in a separate `.mtl` file are not brought along. For colours, open it in Blender and export `.glb` |
| `.blend` | ✓ with Blender | Your Blender file, as saved |
| `.dae`, `.stl`, `.ply`, `.usd` / `.usdz` / `.usda` / `.usdc`, `.abc` | ✓ with Blender | Converted; results vary (`.stl` / `.ply` have no colours; `.dae` needs a Blender version that still reads it) |

"With Blender" means Blender (free) must be installed on this PC (VTube Pro uses it). If it is not, the quick import window shows an
**Install Blender** button (it opens the official installer in a window you can watch) and a download link. After
installing, click **Check again**.

### Any style is fine

Anime, realistic, cartoon, chibi, animals, robots, blobs, a talking pizza: VTube Pro takes any shape. What matters is
whether the model has a skeleton and face shapes. The check tells you, and the buttons fix what they can.

---

## B. Describe it and let the AI make it

1. Open **Create**.
2. In **2 · Describe your character (AI)**, type what they look like, e.g. *"a sleepy purple cat wizard with a big star
   hat and a cozy hoodie"*.
3. Pick one or more **Style** buttons (Anime, Cute / chibi, Animal mascot, Robot, Fantasy, Monster).
4. Optional: add reference pictures (drawings, a character sheet, screenshots).
5. Click **Create my character**. It takes a few minutes. You can keep using the studio.
6. When it says *"Your character is ready"*, it is on screen and saved to your avatars.
7. Next: place its eyes and mouth under **Me → Fine-tune → Face** (the toast tells you).

If the button is greyed out, a yellow banner tells you what is missing (ComfyUI) with a **Set it up**
button.

More local AI 3D settings: **Create → Advanced**.

---

## Outfits and accessories

- **Change outfit**: **Me → Outfit**, click a picture. While streaming: **Ctrl+1 … Ctrl+9** (Ctrl+0 = default look).
- **Accessories** (hats, glasses, props) are switches under the outfits. Several can be on at once.
- **Make a new outfit with AI**: **Create → 3 · Make an outfit** (or **Me → Make an outfit**). Describe the clothes; the
  AI tailors and fits them to the avatar you are wearing.
- **Add an outfit file you made yourself**: **Me → Advanced → Wardrobe → Import** (a `.glb` costume). How to build one:
  [AVATARS_ADVANCED.md, section 9](AVATARS_ADVANCED.md#9-costumes-and-accessories).

---

## Real size (tiny fairies, giant robots)

Everyone human-sized is shown the same height in rooms. If your character is much smaller or bigger than a person:

1. **Me → 📏 Real size**.
2. Enter the character's real height (for example 0.3 m for a fairy, 5 m for a giant).
3. In rooms, tiny characters sit on tables and desks; giants stand at the back.

The same card shows your model's triangle count for parties. Parties show your real model up to **200,000
triangles** (the host can lower that; **37,000 or less** is safe in any party). Heavier models are shared as an
automatic lighter **party version** (preview it on the same card). Solo, any size works.

---

## Calibrate and test

1. Look straight at the camera with a relaxed face and press **C** (or **Go live → Calibrate my face (C)**). Do this
   again whenever you change seat, glasses or lighting. For the best result run the guided ~45 s personal test once
   (**Tracking → Advanced**): it learns your neutral face, expressions and how you talk, for every avatar.
2. **Test expressions without the camera**: **Me → Try your expressions** (or keys **1 … 9**).
3. **Test lip sync**: turn your mic on (**Tracking**), read a sentence out loud and watch the mouth. The mouth follows
   your voice even when your face is turned away.
4. **Emotes** (waves, dances): **Me → Emotes** (only for avatars with a full skeleton).
5. **Camera**: **Me → Camera framing** (Head, Head & shoulders, Full body). **F** re-frames.

---

## If something looks wrong

| What you see | What to do |
|---|---|
| The avatar is lying down, upside down or facing away | **Me → Advanced → Avatars → Loaded model → Transform**: rotate it. Or re-export from your 3D program with "Y up" / "+Z forward" |
| It is huge or tiny on screen | That is only framing: press **F**. In rooms, sizes are corrected automatically. For a truly tiny / huge character use **Real size** |
| Arms don't move | The model has no arm bones (the check says *"Soft rig only"*). Click **Re-rig with Blender**, or **Me → Advanced → Body → Improve rig with Blender** |
| One arm or leg doesn't move | The bone names are unusual. See [AVATARS_ADVANCED.md, section 3](AVATARS_ADVANCED.md#3-the-skeleton-humanoid-rig) or re-rig with Blender |
| The mouth doesn't open / eyes don't blink | The model has no face shapes. **Me → Fine-tune → Face** adds a drawn mouth and eyes you place with two clicks |
| Import failed: "Blender not found" | Install Blender (the button in the import window) and try again |
| Import failed: "references external .bin/texture files" | Your `.gltf` is split into several files. Export `.glb` instead |
| Colours are missing after an `.obj` import | `.obj` colours live in a separate `.mtl` file. Open it in Blender, then **File → Export → glTF (.glb)** and import that |
| It looks grey or flat | **Me → Material style** has looks like felt, plush, clay, fur; **Advanced → Face / Wardrobe** has the toon settings |
| The studio got slow after importing | Very heavy models (hundreds of thousands of triangles) cost GPU. **Room** → switch on **Advanced** (top right) → **Graphics quality** → **Avatar detail** → **Lighter** draws the body lighter (your face never changes). With no room loaded, **Avatar detail** is its own section there. Or decimate in Blender |

Still stuck? Press **?** → **Run the first-time setup**, or give the file and this page to any AI helper
([AI_CONNECT.md](AI_CONNECT.md)).
