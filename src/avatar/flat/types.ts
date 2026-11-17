// The 2D-avatar interface: what every kind of 2D avatar implements (built in: 'png' = PNG / APNG / GIF / WebP image
// sets, src/avatar/flat/pngSource.ts; plug-ins: Live2D, Inochi2D …). An implementation only LOADS its files and DRAWS
// the character into a canvas each frame from the tracking + voice; the display side (src/avatar/flat/FlatAvatar.ts)
// shows that canvas as a card in the room, an OBS overlay, a walking TV's screen or the room's big screen, frames,
// seats and disposes it. So every display mode works for every kind.
//
// Contract summary (details on each member):
//   load    FlatSourceFactory.load(ctx) → FlatSource   (files ONLY through ctx.files; never fetch / cache them yourself)
//   frame   source.update({ frame, voice, dt, time, cue })   → redraw source.canvas, bump source.version
//   picture source.canvas (+ width / height / premultiplied)  ← the display side uploads it when `version` changed
//   face    source.face()                                    → where the face is (talk cameras frame it)
//   states  source.expressions() / setExpression(id | null); optional motions() / playMotion(group, index)
//   free    source.dispose()   (WebGL contexts, bitmaps, object URLs, workers it made)
// Register: registerFlatSource(factory) from a module imported by src/avatar/flat/kinds.ts (one line per kind).
//
// Rules for implementations:
//   * Model custody (docs/MULTIPLAYER_DISCORD.md): a party guest's avatar arrives as bytes in RAM (ctx.files.sealed).
//     Read it only through ctx.files; never write it anywhere (disk, Cache Storage, IndexedDB, localStorage), never
//     send it on, keep no copy after dispose().
//   * Never make sound. Never bundle proprietary runtimes (Live2D Cubism Core: the user installs it, see the live2d
//     lane's plug-in); report why you can't run through FlatSourceFactory.available().
//   * update() runs once per rendered frame on OBS pages (60 fps): keep it allocation-light; skip drawing (leave
//     `version` alone) when nothing changed.
import type { AvatarProfile, TrackingFrame } from '../../../shared/types.ts';
import type { FlatAvatarConfig, FlatCue } from '../../../shared/flatAvatar.ts';

/** Where an implementation reads its files from. Own avatars: the library folder over HTTP. Party guests: a bundle
 *  in RAM (sealed: never stored). Paths are relative to the avatar folder, forward slashes. */
export interface FlatFiles {
  /** The file's bytes (a fresh ArrayBuffer the caller may keep until dispose). Rejects when missing. */
  bytes(rel: string): Promise<ArrayBuffer>;
  /** A URL the page can load the file from (library URL, or a blob: URL in RAM that the display side revokes on
   *  dispose). Prefer bytes() + createImageBitmap / ImageDecoder. */
  url(rel: string): Promise<string>;
  /** Every file name when known (party bundles), else null (library folders: ask for what your model references). */
  list(): string[] | null;
  /** true = a party guest's avatar: RAM only (see the custody rule above). */
  readonly sealed: boolean;
}

export interface FlatLoadContext {
  profile: AvatarProfile;
  /** = profile.flat (sanitised). Kind-specific settings: config.png (built in) or config.opts (plug-ins). */
  config: FlatAvatarConfig;
  files: FlatFiles;
  /** Target picture height in px (config.res, maybe lowered by the page's graphics level). */
  res: number;
  onStatus?: (s: string) => void;
}

/** One frame's input. */
export interface FlatDrive {
  /** The tracked frame (face blendshapes, head yaw/pitch/roll, gaze, mouth incl. voice-led open / visemes). Untracked
   *  frames (camera off / face lost) carry `tracked: false`: animate your own idle life then. */
  frame: TrackingFrame;
  /** 0..1 voice activity (shared/flatAvatar.ts voiceLevel: the mic, or the camera's mouth when there is no mic). */
  voice: number;
  /** Seconds since the last update (0..0.1). */
  dt: number;
  /** Seconds since load. */
  time: number;
  /** The studio's hotkey cue (expression / state held, last motion trigger): the same on every page. */
  cue?: FlatCue;
  /** "When I talk" (shared/flatTalk.ts): swap = show the talking picture / open the mouth while talking (image sets:
   *  idle ↔ talk picture; rigged kinds: their own mouth, keep it on). The motions (hop, wobble, glow …) are applied by
   *  the display side on top of the picture: a kind does not draw them. */
  talk: { swap: boolean };
}

/** A whole-picture motion the display side applies WITHOUT a redraw (cheap: an image set's hop, tilt and sway). Pivot =
 *  the bottom centre of the picture. x / y = offset in picture widths / heights (+x right, +y up), rot = radians
 *  counter-clockwise, sx / sy = scale. */
export interface FlatPose { x: number; y: number; rot: number; sx: number; sy: number; /** radians, top toward the viewer (display side only) */ lean?: number }

export interface FlatExpression { id: string; name: string; /** default hotkey (KeyboardEvent.code) */ key?: string }
export interface FlatMotion { group: string; index: number; name: string; key?: string }

export interface FlatSource {
  /** = config.kind */
  readonly kind: string;
  /** The picture, transparent background, the character standing on / filling the bottom edge (a bust: the bottom
   *  edge is the chest). 2D or WebGL canvas; its size is width × height. */
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** true when the canvas colours are premultiplied by alpha (a WebGL canvas with premultipliedAlpha: true). */
  readonly premultiplied: boolean;
  /** Bumped whenever update() redrew the canvas (the display side re-uploads only then). */
  readonly version: number;
  /** Nearest-neighbour scaling (pixel art). */
  readonly pixelated?: boolean;
  /** Optional cheap motion on top of the picture (see FlatPose: head tilt / sway); absent = none. Read after update(). */
  readonly pose?: FlatPose;
  /** The kind's own talking state (its voice gate), if it has one: the talk motions follow it. Absent = the display
   *  side's gate on the same voice level. */
  readonly talking?: boolean;
  /** The face on the picture (fractions: x from the left, y from the BOTTOM, size of the picture height), or null =
   *  unknown (the display side uses config.face or the upper middle). Optional `top` / `half`: the whole head (hair,
   *  ears, hats) above the face centre and its half width, fractions of the picture height — framing keeps all of it
   *  in a cam and the TV / monitor crop to it. */
  face(): { x: number; y: number; size: number; top?: number; half?: number } | null;
  /** Optional: EVERYTHING it can draw (every picture and animation frame, a rig's head turns, expressions, physics swing,
   *  costume layers), picture fractions (x from the left, y from the BOTTOM), as steps the display side runs in idle
   *  time (each `yield` = a slice of work); null = nothing drawn. Framing uses it so nothing the avatar does is cut off.
   *  Absent: the display side scans the canvas. `live`: start from the current state (model sliders / outfits in use). */
  contentBoundsSteps?(live?: boolean): Generator<void, { x0: number; x1: number; y0: number; y1: number } | null, void>;
  /** Optional: bump it when what it can draw changes after load (an outfit or model-slider set applied in place): the
   *  display side remeasures contentBoundsSteps(true) in idle time, off the render loop. */
  readonly boundsVersion?: number;
  /** Advance + redraw from this frame's tracking / voice / cue. */
  update(d: FlatDrive): void;
  /** Expression states / expressions the user can switch (hotkeys, the 2D avatar panel). */
  expressions(): FlatExpression[];
  /** Hold an expression on (null = back to the default look). The cue does this on every page; the panel calls it
   *  directly for a preview. */
  setExpression(id: string | null): void;
  /** One-shot motions (Live2D motion groups …), if the kind has them. */
  motions?(): FlatMotion[];
  playMotion?(group: string, index: number): void;
  /** Free everything this source made: GL contexts, textures, bitmaps, decoders, object URLs. Called once. */
  dispose(): void;
}

export interface FlatSourceFactory {
  /** = FlatAvatarConfig.kind this factory loads ('png', 'live2d', 'inochi2d' …). */
  kind: string;
  /** Shown in the UI ("PNG / GIF", "Live2D", "Inochi2D"). */
  label: string;
  /** Can this page run it now (plug-in installed / licence accepted, browser support)? Absent = always. */
  available?(): { ok: true } | { ok: false; why: string };
  load(ctx: FlatLoadContext): Promise<FlatSource>;
}
