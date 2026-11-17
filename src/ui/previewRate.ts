// What the studio's frame-rate numbers mean on screen (src/app.ts Stats). stats.fps counts only the frames the studio
// PREVIEW draws: 0 while the studio view is hidden (or a game holds the renderer), about 30 with the Light preview.
// The avatar keeps updating and OBS keeps getting its frames at about 60 all the while (stats.avatarHz). So the top-bar
// chip names its number "preview" and says "hidden" instead of a 0 that reads as broken, and the Live control's
// "picture N fps" (the stream's picture) is the avatar rate, not the preview's.

/** The top-bar perf chip's rate: "preview 60 fps", or "preview hidden" while the studio view is hidden. */
export function previewRateText(fps: number, hidden: boolean): string {
  return hidden ? 'preview hidden' : `preview ${Math.round(Number.isFinite(fps) ? Math.max(0, fps) : 0)} fps`;
}

/** The chip's tooltip line: what that number measures. */
export const PREVIEW_RATE_TIP = 'preview = frames the studio view draws per second (none while it is hidden, about 30 with the Light preview). Tracking, the avatar and OBS are not affected.';

/** The studio view is hidden (body.vp-hidden, or Live Control's studio view set to Hide: body.lc-pgm-off while Live is
 *  open, body.lc-console), not in clean mode: the test src/app.ts tick() uses to skip drawing it. */
export function studioViewHidden(cl: { contains(c: string): boolean } | undefined): boolean {
  return !!cl && (cl.contains('vp-hidden') || (cl.contains('lc-console') && cl.contains('lc-pgm-off'))) && !cl.contains('clean');
}

/** The Live control's "picture N fps" (LiveStatus.fps): avatar frames per second, the rate OBS animates at. Not
 *  stats.fps, which drops to 0 while the studio view is hidden and halves in Light although the stream does not. */
export function livePictureFps(s: { avatarHz?: number }): number {
  const v = s.avatarHz;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
}
