// VTube Pro Live, W1: "Check my setup", pure. Implements BroadcastPreflightApi (shared/broadcastTypes.ts).
//
// W2 gathers PreflightFacts (nothing secret in them); this turns them into one row per PreflightId, in a fixed order, each
// green (ok) / amber (warn) / red (bad) / unknown, with a plain sentence and at most one one-click fix id. Plain words, no
// jargon. The verdict:
//   blocked  at least one red row: Go Live stays off.
//   check    amber rows (or a critical row that could not be checked): the person may accept them and go on.
//   ready    everything fine (rows that could not be checked and do not matter are ignored).
// canGoLive is true for ready, and for check only when the person accepted the amber rows.

import { FIX_LABEL } from './broadcastTypes.ts';
import type {
  BroadcastPreflightApi, DestinationView, FixId, PreflightFacts, PreflightId, PreflightReport, PreflightRow, PreflightStatus,
  PreflightVerdict,
} from './broadcastTypes.ts';

/** Rows whose "could not check" matters: the person is asked to look (amber) instead of getting a silent pass. */
const CRITICAL_IF_UNKNOWN: ReadonlySet<PreflightId> = new Set<PreflightId>(['backend', 'other-broadcaster', 'destination', 'key']);

/** The rows, in the order the UI lists them. */
export const PREFLIGHT_ORDER: readonly PreflightId[] = [
  'backend', 'other-broadcaster', 'destination', 'key', 'avatar-page', 'avatar-gl', 'tracking', 'mic', 'game', 'canvas',
  'encoder', 'upload', 'disk', 'double-audio',
];

export const DISK_BAD_GB = 5;
export const DISK_WARN_GB = 20;

type RowBody = { status: PreflightStatus; title: string; say: string; fixId?: FixId | null };
const row = (id: PreflightId, b: RowBody): PreflightRow => {
  const fixId = b.fixId ?? null;
  return { id, status: b.status, title: b.title, say: b.say, fixId, fixLabel: fixId ? FIX_LABEL[fixId] : null };
};
const unknown = (title: string, say: string): RowBody => ({ status: 'unknown', title, say });

const engineName = (f: PreflightFacts) => (f.backend.kind === 'engine' ? 'The VTube Pro Live engine' : 'OBS');
const enabledDests = (f: PreflightFacts): DestinationView[] => f.destinations.filter((d) => d.enabled);

function backendRow(f: PreflightFacts): RowBody {
  const b = f.backend;
  const t = b.kind === 'engine' ? 'The Live Engine' : 'OBS';
  if (b.kind === 'none') {
    return { status: 'bad', title: 'What you stream with', say: 'Pick what you stream with: your own OBS or the VTube Pro Live Engine.' };
  }
  if (b.reachable === false) {
    return b.kind === 'engine'
      ? { status: 'bad', title: t, say: 'The Live Engine is not running yet.', fixId: 'start-backend' }
      : { status: 'bad', title: t, say: 'VTube Pro cannot reach OBS. Open OBS and turn on its connection, and I will find it.', fixId: 'open-obs-help' };
  }
  if (b.authOk === false) {
    return { status: 'bad', title: t, say: 'OBS did not accept the connection password. Check it in OBS.', fixId: 'open-obs-help' };
  }
  if (b.reachable === null) return unknown(t, 'I have not checked the connection yet.');
  return { status: 'ok', title: t, say: `${engineName(f)} is connected.` };
}

function otherRow(f: PreflightFacts): RowBody {
  const t = 'Not live twice';
  if (f.otherBroadcasterLive === true) {
    return { status: 'bad', title: t, say: 'Your other broadcaster is already live. Stop it first so you are not live twice.', fixId: 'wait-other-broadcaster' };
  }
  if (f.otherBroadcasterLive === null) return unknown(t, 'I cannot tell if your other broadcaster is live.');
  return { status: 'ok', title: t, say: 'Nothing else is live.' };
}

function destinationRow(f: PreflightFacts): RowBody {
  const t = 'Where you stream';
  const on = enabledDests(f);
  if (on.length === 0) return { status: 'bad', title: t, say: 'Add where you want to stream, like Twitch or YouTube.', fixId: 'add-destination' };
  const names = on.map((d) => d.label || d.platform).join(', ');
  return { status: 'ok', title: t, say: on.length === 1 ? `You will stream to ${names}.` : `You will stream to ${on.length} places: ${names}.` };
}

function keyRow(f: PreflightFacts): RowBody {
  const t = 'Your stream key';
  const on = enabledDests(f);
  if (on.length === 0) return unknown(t, 'Add where you stream first.');
  for (const d of on) {
    const name = d.label || d.platform;
    if (d.keyState === 'none') return { status: 'bad', title: t, say: `${name} needs your stream key. Paste it once and I will remember it.`, fixId: 'paste-key' };
  }
  return { status: 'ok', title: t, say: 'Your stream keys are saved.' };
}

function avatarPageRow(f: PreflightFacts): RowBody {
  const t = 'Your avatar in the show';
  const a = f.avatarPages;
  if (!a) return unknown(t, 'I cannot see if your avatar is in the show.');
  if (a.inBackend === 0) {
    return { status: 'bad', title: t, say: 'VTube Pro is not in your show yet, so viewers would see no avatar.', fixId: 'add-avatar-page' };
  }
  if (a.count === 0) {
    return { status: 'warn', title: t, say: 'Your avatar is in the show, but the VTube Pro studio is not open, so it will stand still.', fixId: 'wake-avatar' };
  }
  return { status: 'ok', title: t, say: 'Your avatar is in the show.' };
}

function avatarGlRow(f: PreflightFacts): RowBody {
  const t = 'Avatar can draw';
  const a = f.avatarPages;
  if (!a) return unknown(t, 'I cannot tell if your avatar can draw.');
  if (a.noGl > 0) {
    return { status: 'bad', title: t, say: 'Your avatar cannot draw because graphics acceleration is off in OBS. Turn it on in OBS.', fixId: 'open-obs-help' };
  }
  return { status: 'ok', title: t, say: 'Your avatar can draw.' };
}

function trackingRow(f: PreflightFacts): RowBody {
  const t = 'Face tracking';
  const k = f.tracking;
  if (!k || k.running === null) return unknown(t, 'I cannot tell if your camera is tracking you.');
  if (!k.running) return { status: 'warn', title: t, say: 'Your camera is off, so your avatar will not follow you.', fixId: 'turn-on-tracking' };
  if (k.fps !== null && k.fps < 15) return { status: 'warn', title: t, say: 'Tracking is running slowly, so your avatar may look choppy.', fixId: 'turn-on-tracking' };
  return { status: 'ok', title: t, say: 'Your camera is tracking you.' };
}

function micRow(f: PreflightFacts): RowBody {
  const t = 'Microphone';
  if (!f.mic || f.mic.present === null) return unknown(t, 'I cannot tell if a microphone is in the show.');
  if (!f.mic.present) return { status: 'warn', title: t, say: 'No microphone is in the show, so viewers will not hear you.', fixId: 'add-mic' };
  return { status: 'ok', title: t, say: 'Your microphone is in the show.' };
}

function gameRow(f: PreflightFacts): RowBody {
  const t = 'Your game';
  const g = f.game;
  if (!g || !g.set) return { status: 'ok', title: t, say: 'No game is set up, so there is nothing to check.' };
  if (g.blank === true) return { status: 'bad', title: t, say: 'The picture from your game is black. Pick your whole screen instead.', fixId: 'rescue-capture' };
  if (g.captured === false) return { status: 'warn', title: t, say: 'I do not see your game yet. Start it, or pick your whole screen.', fixId: 'rescue-capture' };
  if (g.blank === null && g.captured === null) return unknown(t, 'I cannot tell if your game is showing.');
  return { status: 'ok', title: t, say: 'Your game is showing.' };
}

function canvasRow(f: PreflightFacts): RowBody {
  const t = 'Picture size';
  const v = f.canvas;
  if (!v) return unknown(t, 'I cannot see your picture size.');
  const px = v.width * v.height;
  if (px > 1920 * 1080 * 1.01 || v.fps > 60) {
    return { status: 'warn', title: t, say: 'Your picture is bigger or faster than most streaming sites accept. A lower setting streams more smoothly.', fixId: 'lower-quality' };
  }
  if (v.fps < 24 || v.height < 480) {
    return { status: 'warn', title: t, say: 'Your picture is quite small or slow, so it may look rough to viewers.' };
  }
  return { status: 'ok', title: t, say: 'Your picture size is good for streaming.' };
}

function encoderRow(f: PreflightFacts): RowBody {
  const t = 'Video speed';
  if (f.encoders === null) return unknown(t, 'I have not tested your graphics card for streaming yet.');
  if (f.encoders.some((e) => e !== 'x264')) return { status: 'ok', title: t, say: 'Your graphics card handles the video, so your game stays fast.' };
  const hasGpu = f.gpu !== null && f.gpu.tier !== 'none';
  return {
    status: 'warn', title: t,
    say: 'Your graphics card is not doing the video work, so your computer will run in slow mode with a smaller picture.',
    fixId: hasGpu ? 'use-hardware-encoder' : null,
  };
}

/** Rough video bitrate a canvas wants, kbps (matches the ladder's rungs). */
export function neededVideoKbps(v: { width: number; height: number; fps: number } | null): number {
  if (!v) return 6000;
  if (v.height >= 1000 && v.fps > 30) return 6000;
  if (v.height >= 1000 || (v.height >= 700 && v.fps > 30)) return 4500;
  return 3000;
}

function uploadRow(f: PreflightFacts): RowBody {
  const t = 'Your internet';
  const u = f.upload;
  if (!u || u.mbps === null) return unknown(t, 'Not measured yet. I learn it from a show that went well; the 10 second private test also checks that your computer keeps up.');
  const places = f.backend.kind === 'engine' ? Math.max(1, enabledDests(f).length) : 1;
  const needKbps = (neededVideoKbps(f.canvas) + 160) * places;
  const haveKbps = u.mbps * 1000;
  if (haveKbps < needKbps) {
    return { status: 'bad', title: t, say: 'Your internet is too slow for this picture quality. Lower the quality a little.', fixId: 'lower-quality' };
  }
  if (haveKbps < needKbps * 1.5) {
    return { status: 'warn', title: t, say: 'Your internet barely covers this picture quality, and it may stutter. Lowering the quality a little helps.', fixId: 'lower-quality' };
  }
  return { status: 'ok', title: t, say: 'Your internet is fast enough.' };
}

function diskRow(f: PreflightFacts): RowBody {
  const t = 'Room to record';
  if (!f.recordRequested) return { status: 'ok', title: t, say: 'You are not recording, so space does not matter.' };
  if (f.diskFreeGb === null) return unknown(t, 'I cannot tell how much space is left.');
  if (f.diskFreeGb < DISK_BAD_GB) return { status: 'bad', title: t, say: 'There is almost no space left to record. Free some up first.', fixId: 'free-disk' };
  if (f.diskFreeGb < DISK_WARN_GB) return { status: 'warn', title: t, say: 'Space is getting low for a long recording.', fixId: 'free-disk' };
  return { status: 'ok', title: t, say: 'There is plenty of space to record.' };
}

function doubleAudioRow(f: PreflightFacts): RowBody {
  const t = 'Sound';
  if (f.showSoundsHeardTwice === null) return unknown(t, 'I cannot tell if your show sounds play twice.');
  if (f.showSoundsHeardTwice) return { status: 'warn', title: t, say: 'Your show sounds would be heard twice by viewers.', fixId: 'mute-desktop-audio' };
  return { status: 'ok', title: t, say: 'Your sounds play once.' };
}

const BUILDERS: Record<PreflightId, (f: PreflightFacts) => RowBody> = {
  'backend': backendRow, 'other-broadcaster': otherRow, 'destination': destinationRow, 'key': keyRow, 'avatar-page': avatarPageRow,
  'avatar-gl': avatarGlRow, 'tracking': trackingRow, 'mic': micRow, 'game': gameRow, 'canvas': canvasRow, 'encoder': encoderRow,
  'upload': uploadRow, 'disk': diskRow, 'double-audio': doubleAudioRow,
};

export function preflightVerdict(rows: PreflightRow[]): PreflightVerdict {
  if (rows.some((r) => r.status === 'bad')) return 'blocked';
  if (rows.some((r) => r.status === 'warn' || (r.status === 'unknown' && CRITICAL_IF_UNKNOWN.has(r.id)))) return 'check';
  return 'ready';
}

export function evaluatePreflight(facts: PreflightFacts, opts?: { acceptAmber?: boolean }): PreflightReport {
  const rows = PREFLIGHT_ORDER.map((id) => row(id, BUILDERS[id](facts)));
  const verdict = preflightVerdict(rows);
  const canGoLive = verdict === 'ready' || (verdict === 'check' && opts?.acceptAmber === true);
  return { at: facts.at, rows, verdict, canGoLive };
}

/** Rows that stay on the list even when nothing is known about them: they decide whether Go Live may start (a critical row that
 *  could not be checked turns the verdict amber), and the internet row, which says when it will be measured. */
const KEEP_WHEN_NO_DATA: ReadonlySet<PreflightId> = new Set<PreflightId>([...CRITICAL_IF_UNKNOWN, 'upload']);

/** The report the person sees: rows the Helper has no facts for ("I can't tell") are left out instead of listed. The verdict and
 *  canGoLive stay as evaluatePreflight made them (an unknown row that is not critical never changed them). Pure. */
export function hideNoDataRows(report: PreflightReport): PreflightReport {
  return { ...report, rows: report.rows.filter((r) => r.status !== 'unknown' || KEEP_WHEN_NO_DATA.has(r.id)) };
}

const _api: BroadcastPreflightApi = { evaluatePreflight };
void _api;
