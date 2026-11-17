// Camera + microphone, decided for the user (ZERO-EFFORT RULE): which device is the best guess (and one sentence why),
// what exactly went wrong when the browser refused, and where the fix lives. Plain data in, plain words out: no DOM, no
// network, so tools/autopilot_unit.ts tests every case. The UI is src/ui/autopilot/media.ts; the helper side (it opens
// the browser's and the OS's settings pages, which a web page can't) is server/routes/autopilot.ts.

export type MediaKind = 'camera' | 'mic';
export interface Device { deviceId: string; label: string }

// ---------------------------------------------------------------- the best guess
/** Cameras that only re-broadcast something else: never the default (the avatar would freeze on OBS's own output).
 *  Phone-webcam apps are NOT in here any more (PHONE_CAMERAS below): they film the performer, so they are real cameras. */
export const VIRTUAL_CAMERA = /virtual|obs[- ]?cam|obs\b|snap ?camera|manycam|xsplit|splitcam|e2esoft|vcam|camtwist|youcam|screen capture|v4l2 ?loopback|vtube ?studio/i;
/** Phone-as-webcam apps (the phone films you; tracking runs on this PC) → the app's name for "Your phone (…)". Checked
 *  BEFORE VIRTUAL_CAMERA (some of their drivers say "virtual" / "e2eSoft"). Windows' own Phone Link "connected camera"
 *  shows as "Windows Virtual Camera" (pureinfotech.com/use-phone-camera-as-webcam-windows-11; some guides write
 *  "Virtual Windows Camera"); Apple Continuity Camera as "<name>'s iPhone Camera" (Mac). */
export const PHONE_CAMERAS: [RegExp, string][] = [
  [/droidcam/i, 'DroidCam'], [/\bcamo\b/i, 'Camo'], [/iriun/i, 'Iriun'], [/ivcam/i, 'iVCam'], [/epoccam/i, 'EpocCam'],
  [/windows virtual camera|virtual windows camera|phone link/i, 'Phone Link'], [/\bndi\b/i, 'NDI'],
  [/iphone.*camera|continuity camera/i, 'iPhone'], [/android webcam/i, 'Android'],
];
/** The phone-webcam apps the automatic pick may PREFER over a laptop's built-in camera (installed on purpose, and they
 *  only ever show the phone's camera). NDI (its webcam input can carry any NDI source, OBS's own output included),
 *  Windows' "Windows Virtual Camera", EpocCam and the rest are only labelled: never picked over a built-in camera. */
const PREFERRED_PHONE_APPS = new Set(['DroidCam', 'Camo', 'Iriun', 'iVCam', 'iPhone']);
export const preferredPhoneCamera = (label: string) => PREFERRED_PHONE_APPS.has(phoneCameraApp(label) ?? '');
/** Which phone app a camera label belongs to, or null (a real webcam or a virtual one). */
export function phoneCameraApp(label: string): string | null {
  for (const [re, name] of PHONE_CAMERAS) if (re.test(label)) return name;
  return null;
}
export type CameraKind = 'phone' | 'virtual' | 'real';
export function cameraKind(label: string): CameraKind {
  return phoneCameraApp(label) ? 'phone' : VIRTUAL_CAMERA.test(label) ? 'virtual' : 'real';
}
/** The camera's name as the user should read it: "Your phone (Camo)" for phone webcams, else the device's own label. */
export function friendlyCameraLabel(label: string): string {
  const app = phoneCameraApp(label);
  return app ? `Your phone (${app})` : label;
}
/** Microphones that are really speakers / mixers / cables: never the default. */
export const VIRTUAL_MIC = /stereo mix|what u hear|wave out|loopback|virtual|vb-?audio|cable output|voicemeeter|blackhole|soundflower|monitor of|obs\b|nvidia broadcast.*speaker|steam streaming/i;
/** Built-in or external real devices that are usually the one people mean (a dedicated webcam beats a laptop's). */
const EXTERNAL_CAMERA = /logitech|logi |c9[0-9]{2}|brio|streamcam|elgato|facecam|razer|kiyo|anker|insta360|obsbot|avermedia|microsoft lifecam|hd pro webcam|emeet|nexigo|usb/i;
const BUILT_IN = /integrated|built-?in|facetime|internal|front|hd user facing|webcam/i;
const GOOD_MIC = /focusrite|scarlett|clarett|shure|rode|røde|yeti|blue |audio-technica|at2020|hyperx|quadcast|elgato wave|wave:?\d|razer seiren|fifine|maono|usb|headset|headphones/i;

export interface Pick { device: Device | null; why: string; skipped: string[] }
const short = (l: string) => l.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').replace(/^Default - /i, '').trim() || 'your camera';

/** The camera to use when the user hasn't chosen one: the saved one, a matching preferred one, else the best real one. */
export function pickCamera(list: Device[], saved?: string | null, prefer?: RegExp): Pick {
  const named = list.filter((d) => d.label);
  const real = named.filter((d) => cameraKind(d.label) !== 'virtual');
  const skipped = named.filter((d) => cameraKind(d.label) === 'virtual').map((d) => short(d.label));
  const s = saved ? list.find((d) => d.deviceId === saved) : undefined;
  if (s) return { device: s, why: `Using ${short(s.label)}, the camera you picked before.`, skipped: [] };
  if (!list.length) return { device: null, why: 'We can’t see a camera on this computer.', skipped: [] };
  const p = prefer ? real.find((d) => prefer.test(d.label)) : undefined;
  const ext = real.find((d) => EXTERNAL_CAMERA.test(d.label) && !BUILT_IN.test(d.label) && cameraKind(d.label) === 'real');
  // a phone webcam app was installed on purpose: it beats the laptop's built-in camera (a plug-in webcam still wins)
  // a phone webcam app (Camo, Iriun, DroidCam, iVCam, Continuity) was installed on purpose: it beats a built-in camera.
  // Other phone-class devices (NDI, Windows Virtual Camera …) come after every ordinary camera.
  const phone = real.find((d) => preferredPhoneCamera(d.label));
  const plain = real.find((d) => cameraKind(d.label) === 'real');
  const pick = p ?? ext ?? phone ?? plain ?? real[0] ?? list[0];
  const isPhone = cameraKind(pick.label) === 'phone';
  const name = isPhone ? friendlyCameraLabel(pick.label) : short(pick.label);
  const phoneTip = isPhone ? ' Keep the phone’s screen on and its app open.' : '';
  const skip = skipped.length ? ` We skipped ${skipped.join(' and ')}: ${skipped.length > 1 ? 'they only show' : 'it only shows'} other apps, not you.` : '';
  if (!real.length) return { device: pick, why: `${short(pick.label)} is the only camera we found. If your avatar doesn’t move, plug in a webcam.`, skipped };
  if (real.length === 1) return { device: pick, why: `Using ${name}, the only ${isPhone ? 'camera' : 'real camera'} on this computer.${phoneTip}${skip}`, skipped };
  return { device: pick, why: `Using ${name}${pick === ext && !p ? ', your plug-in webcam' : ''}. You have ${real.length} cameras; pick another one in Tracking.${phoneTip}${skip}`, skipped };
}

/** The microphone: the saved one, a matching preferred one, the system default unless it is a mixer / cable, else the best real one. */
export function pickMic(list: Device[], saved?: string | null, prefer?: RegExp): Pick {
  const s = saved ? list.find((d) => d.deviceId === saved) : undefined;
  if (s) return { device: s, why: `Using ${short(s.label)}, the microphone you picked before.`, skipped: [] };
  if (!list.length) return { device: null, why: 'We can’t see a microphone. That’s fine: it only moves your avatar’s mouth.', skipped: [] };
  // Chrome lists "default" and "communications" aliases first; their labels say which real device they are
  const real = list.filter((d) => d.label && !VIRTUAL_MIC.test(d.label) && d.deviceId !== 'communications');
  const skipped = list.filter((d) => d.label && VIRTUAL_MIC.test(d.label) && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => short(d.label));
  const p = prefer ? real.find((d) => prefer.test(d.label)) : undefined;
  const def = real.find((d) => d.deviceId === 'default');
  const good = real.find((d) => GOOD_MIC.test(d.label) && d.deviceId !== 'default');
  const pick = p ?? def ?? good ?? real[0] ?? list[0];
  const why = pick === def ? `Using ${short(pick.label)}, your computer’s main microphone.` : `Using ${short(pick.label)}${pick === good ? ', your plug-in microphone' : ''}.`;
  return { device: pick, why: skipped.length ? `${why} We skipped ${skipped.slice(0, 2).join(' and ')}: ${skipped.length > 1 ? 'they carry' : 'it carries'} your computer’s sound, not your voice.` : why, skipped };
}

// ---------------------------------------------------------------- what went wrong
/** prompt = the browser will ask; browser = blocked for this site; system = the OS privacy switch is off; busy = another app
 *  holds the camera; none = no device; constraint = the size / rate asked for isn't possible (retry plain); insecure = the
 *  page can't use devices at all here; unknown = anything else. */
export type MediaProblem = 'ok' | 'prompt' | 'browser' | 'system' | 'busy' | 'none' | 'constraint' | 'insecure' | 'unknown';
export type PermState = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * Classify a getUserMedia failure. Chrome reports an OS-level block (Windows "Let apps access your camera" off, macOS
 * Privacy & Security unticked for the browser) as NotAllowedError "Permission denied by system", or with the site still
 * allowed (permission state 'granted'); a site block is NotAllowedError "Permission denied" with state 'denied'.
 * A camera held by another app is NotReadableError ("Could not start video source", Firefox: AbortError / "in use").
 */
export function classifyMediaError(err: { name?: string; message?: string } | null | undefined, perm: PermState = 'unknown', devices = -1): MediaProblem {
  if (!err) return 'ok';
  const name = String(err.name ?? ''), msg = String(err.message ?? '');
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    if (/by system|system denied|os/i.test(msg) && !/dismiss/i.test(msg)) return 'system';
    if (perm === 'granted') return 'system';
    if (perm === 'prompt' || /dismiss/i.test(msg)) return 'prompt';
    return 'browser';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || devices === 0) return 'none';
  if (name === 'NotReadableError' || name === 'TrackStartError' || (name === 'AbortError' && /in use|busy|start/i.test(msg)) || /could not start (video|audio) source|device in use|busy/i.test(msg)) return 'busy';
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return 'constraint';
  if (name === 'SecurityError' || name === 'TypeError' && /secure|https/i.test(msg)) return 'insecure';
  return 'unknown';
}

// ---------------------------------------------------------------- which browser / OS, and where the switch is
export type BrowserKind = 'chrome' | 'edge' | 'brave' | 'opera' | 'vivaldi' | 'firefox' | 'safari' | 'other';
export type OsKind = 'win' | 'mac' | 'linux' | 'other';
export function browserKind(ua: string, brave = false): BrowserKind {
  if (brave) return 'brave';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Vivaldi\//.test(ua)) return 'vivaldi';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}
export function osKind(ua: string): OsKind {
  if (/Windows/.test(ua)) return 'win';
  if (/Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua)) return 'mac';
  if (/Linux|X11|CrOS/.test(ua) && !/Android/.test(ua)) return 'linux';
  return 'other';
}
export const BROWSER_NAME: Record<BrowserKind, string> = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi', firefox: 'Firefox', safari: 'Safari', other: 'your browser' };

/** The browser's own page with this site's camera / microphone switches (null: the browser has no such page we can name). */
export function siteSettingsUrl(b: BrowserKind, origin: string): string | null {
  const site = encodeURIComponent(origin.replace(/\/$/, ''));
  switch (b) {
    case 'chrome': return `chrome://settings/content/siteDetails?site=${site}`;
    case 'edge': return `edge://settings/content/siteDetails?site=${site}`;
    case 'brave': return `brave://settings/content/siteDetails?site=${site}`;
    case 'vivaldi': return `vivaldi://settings/content/siteDetails?site=${site}`;
    case 'opera': return `opera://settings/content/siteDetails?site=${site}`;
    case 'firefox': return 'about:preferences#privacy';
    default: return null;
  }
}
/** The OS page with the camera / microphone privacy switch. Linux has none we can open (portals / Flatpak). */
export function osPrivacyUrl(o: OsKind, kind: MediaKind): string | null {
  if (o === 'win') return kind === 'camera' ? 'ms-settings:privacy-webcam' : 'ms-settings:privacy-microphone';
  if (o === 'mac') return `x-apple.systempreferences:com.apple.preference.security?Privacy_${kind === 'camera' ? 'Camera' : 'Microphone'}`;
  return null;
}
/** The browser's graphics switch (hardware acceleration), for "3D runs without your graphics card". */
export function gpuSettingsUrl(b: BrowserKind): string | null {
  switch (b) {
    case 'chrome': return 'chrome://settings/system';
    case 'edge': return 'edge://settings/system';
    case 'brave': return 'brave://settings/system';
    case 'vivaldi': return 'vivaldi://settings/system';
    case 'opera': return 'opera://settings/system';
    case 'firefox': return 'about:preferences#general';
    default: return null;
  }
}

// ---------------------------------------------------------------- the words
const what = (k: MediaKind) => (k === 'camera' ? 'camera' : 'microphone');
export interface Advice {
  problem: MediaProblem;
  /** One plain sentence: what happened. */
  title: string;
  /** One or two plain sentences: what to do. */
  says: string;
  /** Click-by-click, for when nothing can open the page for them. */
  steps: string[];
  /** What the main button does. */
  action: 'ask' | 'open-site-settings' | 'open-os-settings' | 'retry' | 'none';
  actionLabel: string;
}
/** What to tell the user, for each problem (the helper's busy-app guess goes in `busyApp`). */
export function adviceFor(kind: MediaKind, p: MediaProblem, b: BrowserKind, o: OsKind, opts: { busyApp?: string | null; linuxFlatpak?: boolean; helper?: boolean } = {}): Advice {
  const w = what(kind), bn = BROWSER_NAME[b];
  const icon = b === 'firefox' ? 'the camera icon (or the slider icon)' : 'the icon left of the web address (a slider or a lock)';
  const siteSteps = b === 'safari'
    ? [`Click Safari in the menu bar, then Settings for This Website.`, `Set ${w === 'camera' ? 'Camera' : 'Microphone'} to Allow.`, 'Come back and press Try again.']
    : [`Click ${icon}.`, b === 'firefox' ? `Next to “Blocked temporarily” or “Blocked”, click the × to clear it.` : `Click “Site settings”.`, `Set ${w === 'camera' ? 'Camera' : 'Microphone'} to “Allow”.`, 'Come back and press Try again.'];
  switch (p) {
    case 'ok': return { problem: p, title: `Your ${w} works.`, says: '', steps: [], action: 'none', actionLabel: '' };
    case 'prompt': return { problem: p, title: `Your browser will ask to use your ${w}.`, says: kind === 'camera' ? 'Click “Allow”. Your camera only moves your avatar: viewers never see your camera picture.' : 'Click “Allow”. Your voice only moves your avatar’s mouth; nothing is recorded.', steps: [], action: 'ask', actionLabel: `Turn on my ${w}` };
    case 'browser': return { problem: p, title: `${bn} is blocking your ${w} for this site.`, says: opts.helper && b !== 'safari' && b !== 'other' ? `We can open ${bn}’s setting for you: set ${w === 'camera' ? 'Camera' : 'Microphone'} to “Allow”, then come back.` : `Allow it in a few clicks, then come back.`, steps: siteSteps, action: 'open-site-settings', actionLabel: opts.helper && b !== 'safari' && b !== 'other' ? `Open ${bn}’s setting` : 'Show me where' };
    case 'system': {
      if (o === 'win') return { problem: p, title: `Windows is blocking your ${w}.`, says: `Turn on “Let apps access your ${w}” and “Let desktop apps access your ${w}”, then come back.`, steps: [`Open Windows Settings → Privacy & security → ${w === 'camera' ? 'Camera' : 'Microphone'}.`, `Turn on “${w === 'camera' ? 'Camera' : 'Microphone'} access” and “Let desktop apps access your ${w}”.`, 'Come back and press Try again.'], action: 'open-os-settings', actionLabel: `Open Windows’ ${w} setting` };
      if (o === 'mac') return { problem: p, title: `macOS is blocking your ${w} for ${bn}.`, says: `Tick ${bn} in the list, then quit and reopen ${bn}.`, steps: [`Open System Settings → Privacy & Security → ${w === 'camera' ? 'Camera' : 'Microphone'}.`, `Turn on ${bn}.`, `Quit ${bn} (Cmd+Q) and open it again.`], action: 'open-os-settings', actionLabel: `Open the Mac’s ${w} setting` };
      return { problem: p, title: `Your computer is blocking the ${w} for ${bn}.`, says: opts.linuxFlatpak ? `${bn} is a Flatpak: allow “Devices” for it in Flatseal (or run: flatpak override --user --device=all ${b === 'firefox' ? 'org.mozilla.firefox' : 'com.google.Chrome'}), then restart it.` : `Check that no other app holds the ${w}, and that your desktop’s privacy settings allow ${bn} to use it, then restart ${bn}.`, steps: [], action: 'retry', actionLabel: 'Try again' };
    }
    case 'busy': return { problem: p, title: opts.busyApp ? `${opts.busyApp} is probably using your ${w}.` : `Another app is using your ${w}.`, says: opts.busyApp ? `Close ${opts.busyApp} (or turn its ${w} off), then press Try again.` : `Close the other app that uses your ${w} (a video call, OBS, Discord), then press Try again.`, steps: [], action: 'retry', actionLabel: 'Try again' };
    case 'none': return { problem: p, title: `We can’t find a ${w}.`, says: kind === 'camera' ? 'Plug in a webcam (or turn on your laptop’s camera), then press Try again.' : 'That’s fine: the microphone only moves your avatar’s mouth. Plug one in and press Try again.', steps: [], action: 'retry', actionLabel: 'Try again' };
    case 'constraint': return { problem: p, title: `Your ${w} can’t do the size we asked for.`, says: 'We’ll try again with its own settings.', steps: [], action: 'retry', actionLabel: 'Try again' };
    case 'insecure': return { problem: p, title: `This page can’t use your ${w}.`, says: 'Open VTube Pro with the “Start VTube Pro” shortcut, in Chrome, Edge or Firefox.', steps: [], action: 'none', actionLabel: '' };
    default: return { problem: p, title: `Your ${w} didn’t start.`, says: `Unplug it and plug it back in, close other apps that use it, then press Try again.`, steps: [], action: 'retry', actionLabel: 'Try again' };
  }
}

// ---------------------------------------------------------------- who holds the camera (helper: process names)
/** Apps that commonly hold a webcam, by process name (lower-case, no .exe) → the name people know. */
export const CAMERA_APPS: [RegExp, string][] = [
  [/^obs(64|32)?$|^obs-studio$/, 'OBS'], [/^discord(canary|ptb)?$/, 'Discord'], [/^zoom$|^zoom\.us$/, 'Zoom'], [/^(ms-)?teams$|^msteams$/, 'Microsoft Teams'],
  [/^skype$/, 'Skype'], [/^slack$/, 'Slack'], [/^webex|^ciscowebex/, 'Webex'], [/^streamlabs ?(obs|desktop)?$/, 'Streamlabs'], [/^xsplit/, 'XSplit'],
  [/^nvidia broadcast$|^nvbroadcast/, 'NVIDIA Broadcast'], [/^camera ?hub$|^elgato camera hub$/, 'Elgato Camera Hub'], [/^lghub$|^logi ?tune$|^logioptionsplus/, 'Logitech software'],
  [/^camo$|^camo studio$/, 'Camo'], [/^vtube studio$/, 'VTube Studio'], [/^vseeface$/, 'VSeeFace'], [/^warudo$/, 'Warudo'], [/^windowscamera$/, 'the Windows Camera app'], [/^facetime$|^photo booth$/, 'FaceTime'],
];
/** Running process names → the apps that probably hold the camera, most likely first (OBS last: it often shares). */
export function cameraUsers(processes: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of processes) {
    const n = raw.toLowerCase().replace(/\.exe$/, '').trim();
    for (const [re, name] of CAMERA_APPS) if (re.test(n)) seen.add(name);
  }
  return [...seen].sort((a, b) => (a === 'OBS' ? 1 : 0) - (b === 'OBS' ? 1 : 0));
}
