// novice-proofing: the "Help me" checker's rules, as plain data in, plain words out (no DOM, no network), so
// every state and the voice rules (VOICE.md: short sentences, no jargon) can be tested.
// src/ui/guide/helpCheck.ts gathers the facts and draws the dialog.

export type Mark = 'ok' | 'warn' | 'bad' | 'skip';
export type FixAction = 'connectObs' | 'camera' | 'mic' | 'guide' | 'reload';
export interface Row { id: string; title: string; mark: Mark; says: string; fix?: { label: string; action: FixAction; anchor?: string } }

export interface Facts {
  browser: 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';
  mobile: boolean;
  /** 'inObs' = OBS shows VTube Pro; 'tab' = only a browser tab shows it; 'none' = not added; 'unknown' = can't ask. */
  obs: 'inObs' | 'tab' | 'none' | 'unknown';
  camera: 'granted' | 'prompt' | 'denied' | 'nodevice' | 'unknown';
  mic: 'granted' | 'prompt' | 'denied' | 'nodevice' | 'unknown';
}

/** Turn the facts into rows, in the order a beginner fixes them. */
export function diagnose(f: Facts): Row[] {
  const rows: Row[] = [];
  // 1. browser
  if (f.browser === 'safari') rows.push({ id: 'browser', title: 'Your browser', mark: 'warn', says: 'We test VTube Pro in Chrome, Edge and Firefox, not Safari. Open this page in one of those if something looks wrong.', fix: { label: 'How to switch', action: 'guide', anchor: 'i-use-safari' } });
  else if (f.mobile) rows.push({ id: 'browser', title: 'Your browser', mark: 'warn', says: 'You’re on a phone or tablet. The studio works best on a computer.' });
  else if (f.browser === 'other') rows.push({ id: 'browser', title: 'Your browser', mark: 'warn', says: 'We test VTube Pro in Chrome, Edge and Firefox. Try one of those if something looks wrong.' });
  else rows.push({ id: 'browser', title: 'Your browser', mark: 'ok', says: 'Your browser works with VTube Pro.' });

  // 2. OBS
  if (f.obs === 'inObs') rows.push({ id: 'obs', title: 'OBS', mark: 'ok', says: 'OBS is showing your avatar.' });
  else if (f.obs === 'tab') rows.push({ id: 'obs', title: 'OBS', mark: 'warn', says: 'VTube Pro is open in a browser tab, not in OBS. Paste the link into OBS instead.', fix: { label: 'Connect OBS', action: 'connectObs' } });
  else if (f.obs === 'none') rows.push({ id: 'obs', title: 'OBS', mark: 'warn', says: 'OBS isn’t showing VTube Pro yet. It takes about 2 minutes.', fix: { label: 'Connect OBS', action: 'connectObs' } });
  else rows.push({ id: 'obs', title: 'OBS', mark: 'skip', says: 'We couldn’t ask about OBS right now. Try again in a moment.' });

  // 3. camera
  if (f.camera === 'granted') rows.push({ id: 'camera', title: 'Camera', mark: 'ok', says: 'Your browser lets the studio use your camera. It only moves your avatar: the picture stays on this computer.' });
  else if (f.camera === 'denied') rows.push({ id: 'camera', title: 'Camera', mark: 'bad', says: 'Your browser blocks the camera. Click the camera icon in the address bar, then Allow.', fix: { label: 'Show me how', action: 'guide', anchor: 'my-camera-is-black-or-my-avatar-wont-move' } });
  else if (f.camera === 'nodevice') rows.push({ id: 'camera', title: 'Camera', mark: 'bad', says: 'We can’t see a camera. Plug one in, then check again.' });
  else rows.push({ id: 'camera', title: 'Camera', mark: 'warn', says: 'Your camera isn’t on yet. Press Turn on camera, then Allow.', fix: { label: 'Turn on camera', action: 'camera' } });

  // 4. microphone (optional)
  if (f.mic === 'granted') rows.push({ id: 'mic', title: 'Microphone', mark: 'ok', says: 'Your avatar’s mouth can follow your voice.' });
  else if (f.mic === 'denied') rows.push({ id: 'mic', title: 'Microphone', mark: 'warn', says: 'Your browser blocks the microphone. It’s optional: it only moves your avatar’s mouth.' });
  else if (f.mic === 'nodevice') rows.push({ id: 'mic', title: 'Microphone', mark: 'skip', says: 'No microphone found. That’s fine: it’s optional.' });
  else rows.push({ id: 'mic', title: 'Microphone', mark: 'skip', says: 'Optional. Turn it on so your avatar’s mouth follows your voice.', fix: { label: 'Turn on mic', action: 'mic' } });
  return rows;
}

/** The one thing to do next: the first red row, else the first amber row with a fix, else "all good". */
export function nextStep(rows: Row[]): { done: boolean; says: string; row?: Row } {
  const r = rows.find((x) => x.mark === 'bad') ?? rows.find((x) => x.mark === 'warn' && x.fix);
  if (!r) return { done: true, says: 'Everything we can check looks good. You’re ready to go live.' };
  return { done: false, says: r.says, row: r };
}

/** Which browser this is, from the user agent (Edge and Opera say "Chrome" too, so check them first). */
export function browserOf(ua: string): Facts['browser'] {
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/OPR\/|SamsungBrowser\//.test(ua)) return 'other';
  if (/Chrome\/|Chromium\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}
