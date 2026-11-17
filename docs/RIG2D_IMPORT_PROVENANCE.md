# Live2D import: where the format knowledge comes from

VTube Pro converts a user's Live2D model into its own rig format (`.vtp2`, docs/RIG2D_FORMAT.md) when it is
imported. VTube Pro **never** renders `.moc3` files and **never** uses, ships, downloads, reads, decompiles or
disassembles any Live2D Cubism Core, Cubism SDK, Cubism Framework or Cubism Editor code or binaries. This file
records how each part of the conversion was learned, so the owner can judge whether the clean-room rule is met. The
owner reviewed these sources and approved their use on 2026-10-06 (relayed by the coordinator).

## 1. Plain JSON files (no reverse engineering involved)

`*.model3.json`, `*.physics3.json`, `*.motion3.json`, `*.exp3.json`, `*.pose3.json`, `*.cdi3.json` and
`*.userdata3.json` are plain, human-readable JSON. Their fields were read directly from the sample files listed in
docs/RIG2D_IMPORT_TESTS.md, for example `FileReferences`, `Groups`, `Curves[].Segments`,
`PhysicsSettings[].Vertices`, `Parameters[].Blend` and `Groups[][].Link`. The motion segment encoding was taken
from the files:

- After the first point, a segment kind is followed by its points.
- Kinds: 0 linear, 1 Bézier (with 2 control points), 2 stepped, 3 inverse stepped.
- The fade fields come from the files' `Meta` blocks.

The behaviour code (motion fades, expression blending, physics strands, part switching) is VTube Pro's own
(`shared/rig2d/animate.ts`). It was written from those field meanings, not from any Live2D code.

## 2. The binary `.moc3` file

| What | Source | Licence | How that source learned it |
|---|---|---|---|
| Header, section offset table, count table, every section's field order and types for versions 1 to 5 | The OpenL2D **moc3ingbird** project's ImHex pattern `src/moc3.hexpat` and its MOC3 format notes ([github.com/OpenL2D/moc3ingbird](https://github.com/OpenL2D/moc3ingbird)) | Free Development Public License 1.0-US (FDPL-1.0-US) | **Unknown.** The project published it alongside a crash proof-of-concept (CVE-2023-27566). Its README says no file in the repository was derived from the output of any Live2D software. It does not say how the layout was worked out, for example by analysing files or by studying the Core. |
| Deformer maths: warp lattice interpolation with its out-of-range extrapolation, rotation deformer chaining (origin through the parent, angle correction from a mapped "up" step), multilinear keyform blending, glue, draw-order groups | MahouTechnologies **moc3-rs** ([github.com/MahouTechnologies/moc3-rs](https://github.com/MahouTechnologies/moc3-rs)) | MIT or Apache-2.0 | Its README says it "uses specifications from OpenL2D's documentation" and is "a ground-up reimplementation". |
| The project's earlier reader `blender/live2d/moc3.py` (Python) | Written for the Live2D-to-3D converter (docs/LIVE2D_TO_3D.md) from the two sources above | Project code | — |
| `shared/rig2d/live2d/moc3.ts` (TypeScript) and `shared/rig2d/live2d/convert.ts` | A port of `moc3.py` plus new code | Project code | — |

**Learned in this lane by analysing the official free sample models** (black-box; the files only):

- **Art mesh flag bits:**
  - bits 0–1: blend mode (1 additive, 2 multiply);
  - bit 2: double-sided;
  - bit 3: inverted mask.
  These were cross-checked against the sample models' flag statistics (e.g. Rice: 9 single-sided meshes,
  7 inverted masks; Mao: 15 additive, 8 multiply). Single-sided meshes face clockwise in VTube Pro's y-down space,
  which was measured: Wanko's 33 single-sided meshes all survive culling with clockwise fronts and vanish with
  counter-clockwise.
- **Cubism 5 blend shapes on rotation deformers, parts and glue** (sections `bsRot` / `bsPart` / `bsGlue`): their
  keyforms index the existing `rotKF` / `partKF` / `glueKF` tables. They hold **deltas**: Mao's rotation
  blend-shape keyforms are 0 at the base key, and its scale deltas are −0.29 … +0.48. These were not in the Python
  reader.
- **Per-keyform multiply / screen colours (v5)** come from `*KF.mulBegin / scrBegin` into the colour tables. For
  **v4 (Cubism 4.2)** files, the per-object `colBegin + keyform index` reading is an assumption: no v4 sample was
  available, so it is unverified (docs/RIG2D_IMPORT_TESTS.md).
- **Version 6 files (Cubism 5.3)** read correctly through the version 5 layout (Ren, see the test results).
- **Drawing-order group totals** can exceed the number of art meshes (Ren: 222 slots for 198 meshes). The reserve is
  sized from the totals.
- **A defect in the Python reader:** `moc3.py`'s `evaluate()` writes into static rotation keyforms (a view, not a
  copy), so a second call on the same object drifts. The gate's reference runner reloads the file per pose. The
  converter is unaffected.

## 3. What was not used

- No Cubism Core, SDK, Framework or Editor code or binaries, and no decompiled or disassembled output.
- No code from decompilation-derived readers (py-moc3, moc3-reader-re and similar).
- No sample model is committed, shipped or redistributed. The sample models used for testing were downloaded by
  the main session under Live2D's Free Material License, for local testing only, with the owner's OK. They live in
  a scratch folder outside every repository.

## 4. Licences in our notices

- moc3-rs (MIT / Apache-2.0) and moc3ingbird (FDPL-1.0-US) are **knowledge sources**; no code was copied from them.
  THIRD_PARTY_NOTICES.md credits them anyway.
- Users' models remain their artists' and riggers' work. The importer shows one line: "Only use Live2D models you
  own or have the artist's permission to use."

## 5. Inochi2D import and BC7 (beta.12)

This is separate from the Live2D knowledge sources above. Inochi2D is an open
BSD-2-Clause implementation. Sources read for this lane:

- [Public INP specification](https://github.com/Inochi2D/inochi2d-docs/blob/593c657855d5679f01443ef311346298fd25e117/docs/source/spec/inp/index.rst):
  big-endian lengths, JSON, texture tags, optional vendor section.
- [Inochi2D v0.8.7 SimplePhysics](https://github.com/Inochi2D/inochi2d/blob/e2235f6f29688d4013a0eec116a37ec8af8f1fb5/source/inochi2d/core/nodes/drivers/simplephysics.d):
  top-level physics settings, lowercase model/map enum values, gravity units,
  damped pendulum and spring-pendulum differential equations, output mappings.
- [Inochi2D v0.8.7 Part](https://github.com/Inochi2D/inochi2d/blob/e2235f6f29688d4013a0eec116a37ec8af8f1fb5/source/inochi2d/core/nodes/part/package.d)
  and sibling Node: opacity/tint bindings multiply; screenTint and zSort add;
  zSort inherits through parents and higher values draw first.
- [inox2d physics](https://github.com/Inochi2D/inox2d/tree/d4dd9dd7f16b775042cbda44370570abf9a8cf81/inox2d/src/physics):
  corroborating equations and mappings. The D reference is authoritative when
  these disagree (the Rust spring damping rotation differs from D).
- [Khronos BPTC specification](https://registry.khronos.org/DataFormat/specs/1.4/dataformat.1.4.html#BPTC),
  [Microsoft BC7 modes](https://learn.microsoft.com/en-us/windows/win32/direct3d11/bc7-format-mode-reference),
  [DDS header](https://learn.microsoft.com/en-us/windows/win32/direct3ddds/dds-header),
  [DDS DX10 header](https://learn.microsoft.com/en-us/windows/win32/direct3ddds/dds-header-dxt10):
  all eight modes, partition and anchor tables, P-bits, integer endpoint expansion,
  interpolation weights, dual indices, channel rotation, dimensions and alpha mode.

The TypeScript BC7 decoder is original code from the specifications. The physics
math is a reference-derived implementation with both BSD notices retained in
THIRD_PARTY_NOTICES.md. No proprietary SDK or third-party puppet was used.

**BC7 payload limitation:** the INP specification assigns tag 2 to BC7 but does not
define how dimensions are stored. The stable D loader reads the tag but passes the
payload to its ordinary image loader; inox2d explicitly rejects BC7. Consequently
we accept a standard DDS DX10 payload containing a single BC7 2D image (UNORM or
UNORM_SRGB, base mip), and reject unframed blocks with an actionable PNG re-export
message. We do not guess dimensions or invent an INP header. Synthetic INP tests
use this documented DDS wrapper; compatibility with a Creator-produced BC7 file
is unverified. The raw decoder accepts explicit dimensions, including partial
4?4 edge blocks. INP2 (the newer 0.9 binary document format) is outside this task.

**Format integration:** the exact pending physics and material operator fields,
current `extra` adapters, runtime hooks, verification and remaining limitations
are documented in RIG2D_INOCHI_ADAPTER.md. The lane does
not alter the canonical format or JSON Schema.
