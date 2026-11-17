// Avatar detail (docs/PERFORMANCE.md "Avatar detail"): very detailed avatars are drawn with fewer triangles only where
// the difference is under about a pixel, and a little more when OBS starts dropping frames. Per PC, like the graphics
// quality (SceneGfxState.avatarDetail, shared/graphics.ts). The runtime lives in src/avatar/lod/* (index-only levels
// built in a Web Worker after the avatar is built; the face is never simplified). Keep this file ASCII-only.

export type AvatarDetailChoice = 'auto' | 'full' | 'lighter' | 'lightest';
export const AVATAR_DETAIL_CHOICES: AvatarDetailChoice[] = ['auto', 'full', 'lighter', 'lightest'];

/** The default for new AND existing installs. 'auto' only once every acceptance gate passed (docs/PERFORMANCE.md);
 *  until then Full (today's exact behaviour) with Auto selectable. */
export const DEFAULT_AVATAR_DETAIL: AvatarDetailChoice = 'full';

export const AVATAR_DETAIL_NAMES: Record<AvatarDetailChoice, string> = { auto: 'Auto', full: 'Full', lighter: 'Lighter', lightest: 'Lightest' };
export const AVATAR_DETAIL_TIPS: Record<AvatarDetailChoice, string> = {
  auto: 'Draws very detailed models lighter in wider shots, where the difference is tiny (bent elbows and knees can show a few pixels), and a little more if OBS starts dropping frames. Normal models keep every triangle; only a model whose textures need over 1 GB gets its non-face textures over 4K made smaller.',
  full: 'Your model exactly as made. Uses the most GPU.',
  lighter: 'Simpler body, clothes and hair (about 1.5 pixels; bent elbows and knees can show a few more), textures over 2K made smaller. Never your face.',
  lightest: 'For older GPUs: simplest body, clothes and hair (up to about 4 pixels; a deeply bent knee or elbow can show a small notch), textures over 1K made smaller. Never your face.',
};
export const AVATAR_DETAIL_LINE = 'For very detailed models. Your face, expressions and lip sync never change.';
export const AVATAR_DETAIL_TEX_NOTE = 'Texture changes apply the next time your avatar loads.';

/** Absolute simplification error of the levels L1..L3, in millimetres at a 1.7 m avatar (scaled to the avatar's height). */
export const DETAIL_MM: readonly number[] = [0.5, 1.5, 4];
/** The reference height (mm) the DETAIL_MM values are given for. */
export const DETAIL_REF_MM = 1700;
/** Head (non-face) and hair triangles get this fraction of the error. */
export const DETAIL_HEAD_HAIR_K = 0.5;
/** A level is kept only if the whole avatar has at most this share of the previous level's triangles (else it aliases it). */
export const DETAIL_KEEP = 0.85;
/** Primitives under this many triangles are kept whole (eyes, lids, teeth). Same as server/partyLod.ts. */
export const DETAIL_TINY_TRIS = 400;
/** A geometry needs at least this many non-face triangles to get levels. */
export const DETAIL_MIN_FREE_TRIS = 2000;
/** Face protection sphere: centred on the face, radius FACE_SPHERE_K x the face size (AvatarRuntime.faceInfo()). */
export const FACE_SPHERE_K = 0.75;

/** Levels are only built when the avatar (model + costume + accessories, after the costume fit) has at least this many
 *  triangles: Auto leaves normal models exactly as they are. */
export const DETAIL_GATE_TRIS: Record<AvatarDetailChoice, number> = { auto: 150_000, full: Infinity, lighter: 50_000, lightest: 50_000 };

/** Allowed on-screen error (pixels). Auto: by OBS pressure 0 / 1 / 2. */
export const DETAIL_T_AUTO: readonly number[] = [0.5, 1, 2];
export const DETAIL_T_FIXED: Record<'lighter' | 'lightest', number> = { lighter: 1.5, lightest: 4 };

/** Auto's OBS pressure is a lever (it holds the render scale back for a window) only when the step takes at least this
 *  share off the avatar triangles the page draws (all avatars on the page, guests included). A smaller step (e.g. a
 *  270k-triangle test avatar's L2 -> L3: 15 % of its drawn triangles, about 4 % of the frame's GPU time) would only delay
 *  the render scale, so the scale reacts as it does without Avatar detail. */
export const DETAIL_LEVER_MIN_SHARE = 0.25;

/** Is a pressure step that takes `saved` triangles off the `pageAvatarTris` avatar triangles the page draws worth acting
 *  on (and holding the render scale back for)? */
export function leverWorthIt(saved: number, pageAvatarTris: number): boolean {
  return saved > 0 && saved >= DETAIL_LEVER_MIN_SHARE * Math.max(0, pageAvatarTris);
}

/** Non-face texture caps (longest side, px) applied at the next load. Auto caps only when the estimated decoded size is
 *  over AUTO_TEX_BUDGET. 0 = no cap. */
export const DETAIL_TEX_CAP: Record<AvatarDetailChoice, number> = { auto: 4096, full: 0, lighter: 2048, lightest: 1024 };
export const AUTO_TEX_BUDGET = 1024 * 1024 * 1024;

/** Selection / switching timing (ms). */
export const DETAIL_PICK_MS = 500;
export const DETAIL_COARSEN_HOLD_MS = 1000;
export const DETAIL_COARSEN_K = 0.8;
export const DETAIL_NO_CAMERA_MS = 1000;

export const isAvatarDetailChoice = (v: unknown): v is AvatarDetailChoice => typeof v === 'string' && (AVATAR_DETAIL_CHOICES as string[]).includes(v);

/** Stored value (scene state) -> a choice, or undefined (= the default). */
export function sanitizeAvatarDetail(v: unknown): AvatarDetailChoice | undefined {
  return isAvatarDetailChoice(v) ? v : undefined;
}

/** The choice in effect for a stored value (missing = DEFAULT_AVATAR_DETAIL). */
export function avatarDetailOf(v: unknown): AvatarDetailChoice {
  return sanitizeAvatarDetail(v) ?? DEFAULT_AVATAR_DETAIL;
}

/** ?avatarDetail= on an OBS source: auto | full | lighter | lightest; L0..L3 pins a level (L0 =
 *  Full, L1..L3 = Auto's levels held at that level, built from 50,000 triangles, textures as Auto, no OBS pressure).
 *  A real OBS source honours L0..L3 too: harmless (it only holds a level). */
export function parseAvatarDetailParam(v: string | null | undefined): { choice: AvatarDetailChoice; pin?: number } | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (isAvatarDetailChoice(s)) return { choice: s };
  const m = /^l([0-3])$/.exec(s);
  if (m) return m[1] === '0' ? { choice: 'full', pin: 0 } : { choice: 'auto', pin: Number(m[1]) };
  return null;
}

/** Levels are wanted for this avatar (choice + triangle count; a pinned test level builds from the lowest gate). */
export function detailWanted(choice: AvatarDetailChoice, tris: number, pinned = false): boolean {
  if (choice === 'full') return false;
  return tris >= (pinned ? DETAIL_GATE_TRIS.lighter : DETAIL_GATE_TRIS[choice]);
}

/** Allowed on-screen error in pixels for a choice (Auto: by pressure 0..2). */
export function detailThreshold(choice: AvatarDetailChoice, pressure = 0): number {
  if (choice === 'full') return 0;
  if (choice === 'auto') return DETAIL_T_AUTO[Math.max(0, Math.min(DETAIL_T_AUTO.length - 1, Math.round(pressure)))];
  return DETAIL_T_FIXED[choice];
}

/** Longest-side cap for non-face textures at load (0 = none). `estBytes` = estimated decoded size of the avatar's textures. */
export function textureCapFor(choice: AvatarDetailChoice, estBytes: number): number {
  if (choice === 'auto') return estBytes > AUTO_TEX_BUDGET ? DETAIL_TEX_CAP.auto : 0;
  return DETAIL_TEX_CAP[choice];
}

/** Halve (keeping the aspect ratio) until the longest side fits under the cap. */
export function cappedSize(w: number, h: number, cap: number): [number, number] {
  if (!(cap > 0)) return [w, h];
  let a = w, b = h;
  while (Math.max(a, b) > cap) { a = Math.max(1, Math.round(a / 2)); b = Math.max(1, Math.round(b / 2)); }
  return [a, b];
}

/** Estimated decoded GPU size of an RGBA8 texture with mips. */
export const texBytes = (w: number, h: number) => Math.round(w * h * 4 * 4 / 3);

/** World-space error (same units as the avatar's height) of each level, L0 = 0. */
export function levelErrors(restHeight: number, levels = DETAIL_MM.length): number[] {
  const out = [0];
  for (let k = 0; k < levels; k++) out.push((DETAIL_MM[k] / DETAIL_REF_MM) * restHeight);
  return out;
}

/** The coarsest level whose error, seen at `pxPerUnit` pixels per world unit, is at most `T` pixels. `err[0]` = 0. */
export function coarsestWithin(err: readonly number[], pxPerUnit: number, T: number): number {
  let best = 0;
  for (let k = 1; k < err.length; k++) if (err[k] * pxPerUnit <= T) best = k;
  return best;
}
