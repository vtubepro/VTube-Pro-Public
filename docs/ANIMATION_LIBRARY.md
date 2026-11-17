# Animation library (NPC clips + VRMA emotes)

Shipped, license-clean clips for the raid NPCs, the Kingsmarch townsfolk and VRM / humanoid avatars. It is built by one
Blender headless step from raw downloads in `tools/vendor/`:

```
tools\blender_low.cmd -b --factory-startup --python tools/retarget/retarget.py -- tools/retarget/retarget.json
```

| Source | License | Raw files | Used for |
|---|---|---|---|
| Quaternius **Universal Animation Library 1 + 2** (Standard) | CC0 1.0 | `tools/vendor/quaternius/Universal_Animation_Library*_Standard/…/Unreal-Godot/UAL*_Standard.glb` (+ `_RM` root-motion GLBs, only read for stride lengths) | `ual_*` NPC clips, all `.vrma` emotes |
| **100STYLE** (Ian Mason) — walk (`_FW`) + idle (`_ID`) takes of 12 styles | CC BY 4.0 — credit **"The 100STYLE Dataset – Ian Mason"** (Setup tab → Credits, THIRD_PARTY_NOTICES.md) | `tools/vendor/100style/<Style>_FW.bvh`, `_ID.bvh`, `Frame_Cuts.csv` | `style_*` NPC clips |

Outputs (`assets/library/anims/`):

| File | Format | Consumer |
|---|---|---|
| `npc/raid_anims_ual.json` | exactly `assets/raid/raid_anims.json` (30 fps, int16 quaternions, `Hips` offset, + `cycle`) | `src/scene/raid/units.ts` — `RaidAssets.addClips()` merges it after the raid's own clips load |
| `npc/town_anims_ual.json` | exactly `town_anims.json` (+ `cycle`) | `src/scene/town/townUnits.ts` — `TownAssets.addClips()` (+ the render-time variety table) |
| `vrma/*.vrma` + `vrma/index.json` | VRM Animation 1.0 (`VRMC_vrm_animation`), T-posed humanoid, 30 fps | `src/avatar/emotes.ts` (Body tab → Emotes) |
| `retarget_report.json` | every clip: duration, loop, source take, stride | docs / tooling |

Neither file ever replaces a clip of the room / raid (same names are skipped), and loading them never blocks a room:
they arrive a moment after the NPCs. Plans pick clips by name, so every clip below is available as
`assets.clips.get('<name>')` (raid) or through the town's `VARIANTS` table.

## Method (why one path fits every skeleton)

All sources and both NPC targets are T-posed at rest and face the same way. For every source bone `b` the step samples
its world rotation and takes the **world delta from rest** `D_b(t) = R_b(t) · R_b(rest)⁻¹`. A target bone mapped to `b`
gets the same delta; its local pose in the target's own glTF bone frame is

    q = W0⁻¹ · (D_parent⁻¹ · D_b) · W0          (W0 = the target bone's rest world rotation)

which is what `units.ts` / `townUnits.ts` apply (`bone.quaternion = rest · q`). Unmapped target bones (the `Gun` socket)
follow their parent. The hips translation is rescaled by the hip-height ratio (UAL 0.917 m / 100STYLE 0.978 m → NPC
0.98 m). Loops are in place; `cycle[name]` = metres walked per loop at the NPC's 1.8 m model scale (from the UAL `_RM`
takes, or the 100STYLE take's own travel), so the samplers can drive the phase by distance (no foot sliding).

**100STYLE takes** are long mocap runs at 60 fps. The step searches the take (inside `Frame_Cuts.csv`'s usable range)
for the best loop: pose match of legs / arms / spine between frame i and i+L, on a straight stretch (heading change
< 8°, path within 12 cm of the chord) for walks; 3–5.5 s for idles. It removes the facing (circular mean of the hips
heading → faces +Z), the root drift, centres the sway, cross-fades a 16-frame seam and resamples to 30 fps.

**VRMA**: the clip's humanoid is written T-posed with identity rest rotations, so its tracks are the VRM
*normalized* local rotations (relative to the VRM humanoid parent) — three-vrm-animation reads them as-is. At play time
`emotes.ts` corrects for avatars whose rest is not a T-pose (A-posed arms on our mapped humanoids): per bone the swing
from the T-pose direction to the model's rest direction is removed (`W = D · S⁻¹`), so the same file works on VRM 0.x,
VRM 1.0 and humanoid-mapped GLBs.

## Bone mapping

Our NPC skeleton (raid + town, 20 bones) ← UAL (UE-mannequin names) / 100STYLE BVH:

| NPC bone | UAL | 100STYLE |
|---|---|---|
| Hips | pelvis | Hips |
| Spine | spine_02 | Chest2 |
| Chest | spine_03 | Chest4 |
| Neck | neck_01 | Neck |
| Head | Head | Head |
| Shoulder_L / _R | clavicle_l / _r | LeftCollar / RightCollar |
| UpperArm_L / _R | upperarm_l / _r | LeftShoulder / RightShoulder |
| LowerArm_L / _R | lowerarm_l / _r | LeftElbow / RightElbow |
| Hand_L / _R | hand_l / _r | LeftWrist / RightWrist |
| UpperLeg_L / _R | thigh_l / _r | LeftHip / RightHip |
| LowerLeg_L / _R | calf_l / _r | LeftKnee / RightKnee |
| Foot_L / _R | foot_l / _r | LeftAnkle / RightAnkle |
| Gun (prop socket) | — (follows Chest) | — |

VRM humanoid ← UAL: hips←pelvis, spine←spine_01, chest←spine_02, upperChest←spine_03, neck←neck_01, head←Head,
{left,right}Shoulder←clavicle, UpperArm←upperarm, LowerArm←lowerarm, Hand←hand, UpperLeg←thigh, LowerLeg←calf,
Foot←foot, Toes←ball, ThumbMetacarpal/Proximal/Distal←thumb_01/02/03, Index/Middle/Ring/Little
Proximal/Intermediate/Distal←index/middle/ring/pinky_01/02/03.

## Clips

NPC files (same 108 names in both): `ual_<snake_case UAL name without _Loop>` and `style_<style>_walk` / `_idle`.

* **Locomotion** (in place, with `cycle`): `ual_walk`, `ual_walk_formal`, `ual_walk_carry`, `ual_jog_fwd`, `ual_sprint`,
  `ual_crouch_fwd`, `ual_zombie_walk_fwd`, `ual_swim_fwd`, `style_{neutral,proud,old,drunk,hands_in_pockets,depressed,
  strutting,tiptoe,heavyset,on_phone_right,arms_behind_back,rushed}_walk`.
* **Idles**: `ual_idle`, `ual_idle_talking`, `ual_idle_fold_arms`, `ual_idle_no`, `ual_idle_rail`, `ual_idle_rail_call`,
  `ual_idle_talking_phone`, `ual_idle_lantern`, `ual_idle_torch`, `ual_idle_shield`, `ual_crouch_idle`, `ual_zombie_idle`,
  `ual_sitting_idle`, `ual_sitting_talking`, `ual_swim_idle`, `ual_sword_idle`, `ual_pistol_idle`, `ual_spell_simple_idle`,
  `style_*_idle` (12 styles).
* **Gestures / one-shots**: `ual_yes`, `ual_dance`, `ual_interact`, `ual_pick_up_table`, `ual_consume`, `ual_chest_open`,
  `ual_push`, `ual_fixing_kneeling`, `ual_farm_*`, `ual_tree_chopping`, `ual_overhand_throw`, `ual_punch_jab`,
  `ual_punch_cross`, `ual_melee_hook*`, `ual_sword_*`, `ual_shield_*`, `ual_spell_simple_*`, `ual_pistol_*`.
* **Reactions**: `ual_hit_chest`, `ual_hit_head`, `ual_hit_knockback`, `ual_death01`, `ual_roll`, `ual_jump*`,
  `ual_ninja_jump_*`, `ual_slide*`, `ual_climb_up_1m`, `ual_lay_to_idle`, `ual_sitting_enter` / `_exit`, `ual_driving`,
  `ual_zombie_scratch`.

Strides come from the pack's own root-motion takes (m/s × loop length): walks ≈ 1.0 m/s, but UAL's jog (≈ 5.4 m/s) and
sprint (≈ 8 m/s) are authored fast — drive them by distance (as the samplers do) and they stay foot-locked at any speed.

Pistol / sword clips place the hands for a held item, but the NPC's `Gun` socket stays on the chest — attach props per
clip if a system uses them.

### Where the systems pick them up

* **Raid** (`units.ts`): the clips are merged into `RaidAssets.clips` and their strides into `CYCLE`. The deterministic
  planner (`sim.ts`) is unchanged — it can reference any name above (e.g. `ual_crouch_idle` for waiting in cover,
  `ual_hit_head`, `ual_death01`, `ual_zombie_walk_fwd` for a zombie event). `vtpOut.raid.scene.debugLineup({ clip:
  'ual_dance', units: [...] , at, t })` previews one on real units.
* **Town** (`townUnits.ts` `VARIANTS`, used by `crowd.ts` at pose time only — plans and timings are unchanged, every page
  still shows the same crowd): `idle` → room idle or `ual_idle`, `ual_idle_fold_arms`, `style_{neutral,hands_in_pockets,
  arms_behind_back,heavyset,proud,old}_idle` (varies per activity); `talk` → room talk or `ual_idle_talking`; `walk` →
  one style per NPC among the room walk, `style_{neutral,proud,hands_in_pockets,heavyset,arms_behind_back,strutting,
  depressed}_walk`, `ual_walk_formal` — only styles whose stride is within 0.8–1.45× the room walk (the phase follows
  the variant's own stride). Edit the table to add more.
* **Avatars** (`emotes.ts`): Body tab → Emotes (VRMA), or `POST /api/command {command: "emote", args: {name, loop?}}` (`{stop: true}` stops).
  Built-in: dance, yes, idle_no, idle_fold_arms, idle_talking, idle_talking_phone, consume, punch_jab,
  spell_simple_shoot, idle_rail_call, interact. Users' own `.vrma` files: `loadVrma(url | bytes)` +
  `registerEmote(name, anim)`.

Rebuild after changing sources, maps or the NPC skeletons (`build_units.py` / `km_units.py`): re-run the command above.
Preview strips of sample clips on real units: add `"render": {"dir": "<out dir>", "clips": [names]}` to the config.

**Raid NPCs (v4 bodies):** the `raid` target is retargeted onto the v4 raid rest pose (joints taken from the Quaternius base body, same 20 bone names). The town target is unchanged. The raid plays library clips as a *lower-body layer* (hips, spine and legs) under its authored rifle / pistol upper body; see docs/SCENES.md, "Raid v4", and `raidScene.lowerClipFor`. Re-run only the raid target after changing `ubc_body.V3_BONES`.
