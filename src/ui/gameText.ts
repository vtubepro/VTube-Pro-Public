// Plain words and small decisions of the game-mode work, kept free of the DOM so they are unit-tested
// (tools/gamefps_unit.ts): the studio's notice (src/ui/gameMode.ts), the "Where tracking runs" line
// (src/ui/trackProcessorCard.ts) and when the room's analysis needs a hidden preview (src/ui/logicPreview.ts).
import { gpuBusy, vramFull, vramText, type GpuStat } from '../../shared/gpuStat.ts';

/** The notice's one sentence (pure: tools/gamefps_unit.ts). 'tracking' = still slow 20 s after stall mode did its
 *  automatic steps (research/tracking_gpu_rca/RCA.md P3); 'obs' = an OBS page switched to a lighter look. `waited` =
 *  stall mode measured a wait on the graphics card (stallGuard.ts StallState.gpu; default yes): without it, or a helper
 *  reading that says the card is busy or full, the tracking notice does not blame the graphics card (beta.14.1: a user
 *  read "almost all of your graphics card" next to a card at 36 %). */
export function gameNoticeText(kind: 'tracking' | 'obs', s: { gpu: GpuStat | null; now?: number; waited?: boolean }): string {
  const now = s.now ?? Date.now();
  const full = vramFull(s.gpu, now), busy = gpuBusy(s.gpu, now);
  const mem = full && s.gpu ? ` (${vramText(s.gpu)} of its memory)` : busy && s.gpu ? ` (${s.gpu.util} %)` : '';
  if (kind === 'obs') return `A game is using almost all of your graphics card${mem}, so OBS was only getting a picture every few seconds; VTube Pro switched OBS to a lighter look, and limiting the game to 60 fps brings the full look back.`;
  if (!cardNamed(s.waited !== false, s.gpu, now)) return 'Something on your PC (often a game) is keeping your face tracking slow; limiting the game to 60 fps or closing what you don’t need usually fixes it.';
  return `A game is using almost all of your graphics card${mem}, so your face tracking is slow; limiting the game to 60 fps fixes it.`;
}

/** Whether the studio's texts may name a game on the graphics card (pure): stall mode measured a wait there
 *  (StallState.gpu), or a fresh helper reading says the card is busy or its memory full. The notice, the preview's line,
 *  "Where tracking runs" and the tracking chip all use this one test, so they never disagree on screen. */
export function cardNamed(waited: boolean, gpu: GpuStat | null, now = Date.now()): boolean {
  return waited || !!vramFull(gpu, now) || !!gpuBusy(gpu, now);
}

/** The tracking chip while stall mode lasts (pure; src/ui/shell.ts). */
export function stallChipText(s: { named: boolean; faceCpu: boolean }): string {
  return `${s.named ? 'Game mode' : 'Catching up'}${s.faceCpu ? ': tracking on the processor' : ''}`;
}

/** The line in place of the room preview while stall mode lasts (src/ui/previewFrame.ts; pure). `gpu` = cardNamed(). */
export function previewPausedText(gpu: boolean): string {
  return gpu ? 'The preview is paused while a game needs your graphics card. It comes back by itself.'
    : 'The preview is paused while face tracking catches up. It comes back by itself.';
}

/** [Show me how]: three short steps (the in-game limiter, NVIDIA, AMD) + where tracking can move. */
export const CAP_STEPS = [
  'In the game’s own settings, set a frame-rate limit (often “Max FPS” or “Frame rate cap”) of 60.',
  'NVIDIA: NVIDIA Control Panel → Manage 3D settings → Program settings → your game → Max Frame Rate → 60.',
  'AMD: AMD Software → Gaming → your game → Frame Rate Target Control (or Radeon Chill) → 60.',
  'Still slow? Tracking → Where tracking runs → For games.',
];

/** Still slow after stall mode's automatic steps: under 80 % of the face goal (stallGuard.ts: the camera's rate up to 30;
 *  not the camera's own rate — a 60 fps camera's face lands at 30-45 and read as slow for ever), the face still starved,
 *  or one graphics-queue round trip over 100 ms (pure). */
export function stillSlow(s: { hz: number; goal: number; starve: number; gpuSyncMs: number }): boolean {
  return (s.goal > 0 && s.hz < 0.8 * s.goal) || s.starve > 0.3 || s.gpuSyncMs > 100;
}

/** What the line under the switch says (pure: tools/gamefps_unit.ts). */
export function processorStatus(s: { tracking: boolean; face: { delegate: string } | null; gameMode: boolean; gpu?: boolean /* cardNamed() */ }): string {
  if (!s.tracking || !s.face) return 'Starts with your camera.';
  const where = s.face.delegate === 'CPU' ? 'on the processor' : 'on the graphics card';
  if (!s.gameMode) return `Your face is tracked ${where} now.`;
  return s.gpu === false ? `Your PC is busy: your face is tracked ${where} until tracking catches up.` : `A game is using your graphics card: your face is tracked ${where} until it lets go.`;
}

/** The room's seats are known from its report (pure: tools/gamefps_unit.ts): the report is there, and its automatic size
 *  seats are derived — or not needed: the room derives them only once a micro / macro performer is in it, so with none
 *  `sizes.ready` stays false for good (waiting for it kept the hidden analysis preview open 40 s per room; e2e round 3). */
export function roomSeatsKnown(r: { sizes?: { ready: boolean; actors?: { cls: string }[] } } | null | undefined, memberNeedsSizes = false): boolean {
  if (!r) return false;
  if (r.sizes?.ready !== false) return true;
  // (a current micro / macro member - known from the studio's own member list, so one whose model was still loading in
  //  the report, or who joined after it, still counts - keeps it unknown until the size seats exist: Grok final review)
  if (memberNeedsSizes) return false;
  return !(r.sizes.actors ?? []).some((a) => a.cls === 'micro' || a.cls === 'macro');
}

/** Pure decision (tools/gamefps_unit.ts). */
export function logicPreviewWanted(i: { now: number; sceneId: string | null; canEdit: boolean; observer: boolean; gameMode: boolean; userPreview: boolean;
  roomKnown: boolean; gaveUp: boolean; reactUntil: number }): boolean {
  if (i.observer || !i.canEdit || i.gameMode || i.userPreview || !i.sceneId) return false;
  return (!i.roomKnown && !i.gaveUp) || i.now < i.reactUntil;
}

