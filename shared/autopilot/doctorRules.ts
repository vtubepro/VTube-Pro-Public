// "Something wrong? Fix it": the doctor's rules. Plain facts in, one plain sentence + one button per row out (no DOM, no
// network), so tools/autopilot_unit.ts checks every state and the voice rules (short sentences, no jargon, never an error
// code). src/ui/autopilot/doctor.ts gathers the facts, draws the rows and runs the fixes.
//
// Owner rule (beta.12): only REAL problems count (the amber badge / "Fix it (n)"): the camera or
// mic blocked or busy, tracking failing, the avatar or room failed to load, the OBS connection broken, 3D without the
// graphics card, Blender / AI tools broken after the user set them up. Things simply not set up yet (camera off, mic off,
// not in OBS yet, no room) are NOT problems: mark 'todo', and the first one is the calm
// "Next step: …" line (doctor + show dock). "Fix everything" still does every automatic fix, set-up steps included.
import type { MediaProblem, PermState } from './media.ts';

/** ok = works · bad / warn = a real problem (counted) · todo = not set up yet (never counted) · skip = optional / can't tell */
export type Mark = 'ok' | 'warn' | 'bad' | 'todo' | 'skip';
export type DoctorAction =
  | 'camera' | 'cameraFix' | 'mic' | 'micFix' | 'light'
  | 'obs' | 'obsGl' | 'gpu' | 'tools' | 'avatar' | 'room' | 'reload';
export interface DoctorRow {
  id: string; title: string; mark: Mark; says: string;
  fix?: { label: string; action: DoctorAction; auto?: boolean };
  /** a 'todo' row's short words for the dock's "Next step" button (e.g. "Turn on camera") */
  next?: string;
}

export interface DoctorFacts {
  /** error: why the last start failed (null = it didn't fail / wasn't tried) */
  camera: { perm: PermState; on: boolean; devices: number; label: string; error?: MediaProblem | null };
  mic: { perm: PermState; on: boolean; devices: number; label: string; error?: MediaProblem | null };
  /** face tracking: seen / lost (camera on, no face for a while) / off (camera off) */
  face: 'seen' | 'lost' | 'off';
  /** broken = OBS remote control was set up and its connection fails now */
  /** noGl = an OBS page is attached but can't draw 3D (no WebGL 2 in OBS's browser) */
  obs: 'inObs' | 'tab' | 'none' | 'broken' | 'noGl' | 'unknown';
  gpu: { software: boolean; webgl2: boolean };
  /** null = can't ask (the server did not answer). blenderSaved: the user set Blender up before; aiOld: AI apps whose VTube Pro entry is out of date */
  tools: { blender: 'ready' | 'unsaved' | 'outdated' | 'blocked' | 'missing'; blenderSays: string; aiConnected: string[]; aiInstalled: string[]; blenderSaved?: boolean; aiOld?: string[] } | null;
  avatar: { loaded: boolean; name: string; failed: boolean };
  room: { id: string | null; name: string; missing: boolean };
}

const BLOCKED: (MediaProblem | null | undefined)[] = ['browser', 'system', 'busy'];

/** The rows, in the order a beginner fixes them. */
export function doctorRows(f: DoctorFacts): DoctorRow[] {
  const rows: DoctorRow[] = [];
  // 2. camera + face
  const cam = f.camera;
  if (cam.on) rows.push({ id: 'camera', title: 'Camera', mark: 'ok', says: `Your camera works${cam.label ? ` (${cam.label})` : ''}. Viewers see your avatar, not your camera.` });
  else if (cam.perm === 'denied' || cam.error === 'browser') rows.push({ id: 'camera', title: 'Camera', mark: 'bad', says: 'Your browser blocks the camera for this site.', fix: { label: 'Fix it', action: 'cameraFix' } });
  else if (cam.error === 'system') rows.push({ id: 'camera', title: 'Camera', mark: 'bad', says: 'Your computer’s privacy setting blocks the camera.', fix: { label: 'Fix it', action: 'cameraFix' } });
  else if (cam.error === 'busy') rows.push({ id: 'camera', title: 'Camera', mark: 'bad', says: 'Another app is using your camera.', fix: { label: 'Fix it', action: 'cameraFix' } });
  else if (cam.devices === 0) rows.push({ id: 'camera', title: 'Camera', mark: 'todo', says: 'We can’t find a camera. Plug one in, then check again.', fix: { label: 'Check again', action: 'cameraFix' }, next: 'Plug in a camera' });
  else rows.push({ id: 'camera', title: 'Camera', mark: 'todo', says: 'Your camera is off, so your avatar holds still.', fix: { label: 'Turn on camera', action: 'camera', auto: true }, next: 'Turn on camera' });
  if (cam.on) {
    if (f.face === 'lost') rows.push({ id: 'face', title: 'Face tracking', mark: 'warn', says: 'We can’t see your face. Sit in front of the camera with a light on your face.', fix: { label: 'Help me with light', action: 'light' } });
    else rows.push({ id: 'face', title: 'Face tracking', mark: 'ok', says: 'Your avatar follows your face.' });
  }

  // 3. microphone (optional)
  const mic = f.mic;
  if (mic.on) rows.push({ id: 'mic', title: 'Microphone', mark: 'ok', says: `Your avatar’s mouth follows your voice${mic.label ? ` (${mic.label})` : ''}.` });
  else if (mic.perm === 'denied' || BLOCKED.includes(mic.error)) rows.push({ id: 'mic', title: 'Microphone', mark: 'warn', says: mic.error === 'busy' ? 'Another app is using your microphone. It’s optional: it moves your avatar’s mouth.' : mic.error === 'system' ? 'Your computer’s privacy setting blocks the microphone. It’s optional: it moves your avatar’s mouth.' : 'Your browser blocks the microphone. It’s optional: it moves your avatar’s mouth.', fix: { label: 'Fix it', action: 'micFix' } });
  else if (mic.devices === 0) rows.push({ id: 'mic', title: 'Microphone', mark: 'skip', says: 'No microphone found. That’s fine: it only moves your avatar’s mouth.' });
  else rows.push({ id: 'mic', title: 'Microphone', mark: 'todo', says: 'Your microphone is off. Turn it on so the mouth follows your voice.', fix: { label: 'Turn on mic', action: 'mic', auto: true }, next: 'Turn on mic' });

  // 4. avatar + room
  if (f.avatar.failed) rows.push({ id: 'avatar', title: 'Avatar', mark: 'bad', says: `${f.avatar.name || 'Your avatar'} didn’t load. We can put a starter avatar on instead.`, fix: { label: 'Use a starter avatar', action: 'avatar', auto: true } });
  else if (!f.avatar.loaded) rows.push({ id: 'avatar', title: 'Avatar', mark: 'todo', says: 'No avatar on screen yet.', fix: { label: 'Use a starter avatar', action: 'avatar', auto: true }, next: 'Pick an avatar' });
  else rows.push({ id: 'avatar', title: 'Avatar', mark: 'ok', says: `${f.avatar.name} is on screen.` });
  if (f.room.missing) rows.push({ id: 'room', title: 'Room', mark: 'bad', says: 'Your room isn’t on this computer any more. We can put you in the starter room.', fix: { label: 'Use the starter room', action: 'room', auto: true } });
  else if (!f.room.id) rows.push({ id: 'room', title: 'Room', mark: 'todo', says: 'No room: your avatar stands on a see-through background.', fix: { label: 'Use the starter room', action: 'room', auto: true }, next: 'Pick a room' });
  else rows.push({ id: 'room', title: 'Room', mark: 'ok', says: `You’re in ${f.room.name}.` });

  // 5. OBS
  if (f.obs === 'broken') rows.push({ id: 'obs', title: 'OBS', mark: 'bad', says: 'VTube Pro can’t reach OBS any more. Is OBS open?', fix: { label: 'Connect OBS again', action: 'obs' } });
  else if (f.obs === 'noGl') rows.push({ id: 'obs', title: 'OBS', mark: 'bad', says: 'OBS can’t draw your avatar: its browser has no 3D graphics. In OBS, set the renderer to Direct3D 11 and restart OBS.', fix: { label: 'Show me how', action: 'obsGl' } });
  else if (f.obs === 'inObs') rows.push({ id: 'obs', title: 'OBS', mark: 'ok', says: 'OBS shows your avatar. You go live with Start Streaming in OBS.' });
  else if (f.obs === 'tab') rows.push({ id: 'obs', title: 'OBS', mark: 'todo', says: 'VTube Pro shows in a browser tab, not in OBS yet.', fix: { label: 'Add to OBS', action: 'obs', auto: true }, next: 'Add to OBS' });
  else if (f.obs === 'none') rows.push({ id: 'obs', title: 'OBS', mark: 'todo', says: 'OBS doesn’t show VTube Pro yet. One click adds it.', fix: { label: 'Add to OBS', action: 'obs', auto: true }, next: 'Add to OBS' });
  else rows.push({ id: 'obs', title: 'OBS', mark: 'skip', says: 'We couldn’t ask about OBS right now. Check again in a moment.' });

  // 6. graphics
  if (!f.gpu.webgl2) rows.push({ id: 'gpu', title: 'Graphics', mark: 'bad', says: 'Your browser can’t draw 3D right now. Turn on graphics acceleration, then restart the browser.', fix: { label: 'Show me where', action: 'gpu' } });
  else if (f.gpu.software) rows.push({ id: 'gpu', title: 'Graphics', mark: 'warn', says: 'Your browser draws 3D without your graphics card, so it’s slow. Turn on graphics acceleration.', fix: { label: 'Show me where', action: 'gpu' } });
  else rows.push({ id: 'gpu', title: 'Graphics', mark: 'ok', says: 'Your graphics card draws the 3D.' });

  // 7. AI creation tools (optional: a problem only once the user set them up and they broke)
  if (f.tools) {
    const t = f.tools, old = t.aiOld ?? [];
    const ai = t.aiConnected.length ? `${t.aiConnected.join(', ')} can build for you.` : t.aiInstalled.length ? `${t.aiInstalled[0]} isn’t connected yet.` : '';
    if (old.length) rows.push({ id: 'tools', title: 'AI creation', mark: 'warn', says: `${old.join(', ')} still points at an old VTube Pro. Connect it again in one click.`, fix: { label: 'Fix it', action: 'tools' } });
    else if (t.blenderSaved && t.blender !== 'ready' && t.blender !== 'unsaved') rows.push({ id: 'tools', title: 'AI creation', mark: 'warn', says: t.blender === 'missing' ? 'The Blender you set up is gone (moved or uninstalled).' : (t.blenderSays || 'Blender doesn’t start any more.'), fix: { label: 'Fix it', action: 'tools' } });
    else if (t.blender === 'ready') rows.push({ id: 'tools', title: 'AI creation (optional)', mark: 'ok', says: `Blender is ready.${ai ? ` ${ai}` : ''}`, ...(t.aiConnected.length || !t.aiInstalled.length ? {} : { fix: { label: 'Connect my AI app', action: 'tools' as const } }) });
    else rows.push({ id: 'tools', title: 'AI creation (optional)', mark: 'skip', says: `${t.blender === 'unsaved' ? 'Blender is on this computer: one click in Set it up and VTube Pro uses it.' : t.blenderSays || 'Blender isn’t set up yet.'} You only need it to make avatars and rooms with AI.`, fix: { label: 'Set it up', action: 'tools' } });
  }
  return rows;
}

/** Real problems only (the badge + the dock's "Fix it (n)"). */
export const isProblem = (r: DoctorRow) => r.mark === 'bad' || r.mark === 'warn';
export const problemCount = (rows: DoctorRow[]) => rows.filter(isProblem).length;
/** The first thing not set up yet: the calm "Next step" (null = nothing left to set up). */
export function nextStep(rows: DoctorRow[]): { id: string; says: string; short: string } | null {
  const r = rows.find((x) => x.mark === 'todo');
  return r ? { id: r.id, says: r.says, short: r.next ?? r.fix?.label ?? r.title } : null;
}

/** The headline: the first real problem; else the calm next step; else "all good". */
export function doctorHeadline(rows: DoctorRow[]): { done: boolean; tone: 'problem' | 'next' | 'ok'; says: string } {
  const r = rows.find((x) => x.mark === 'bad') ?? rows.find((x) => x.mark === 'warn');
  if (r) return { done: false, tone: 'problem', says: r.says };
  const n = nextStep(rows);
  if (n) return { done: false, tone: 'next', says: `Next step: ${n.says}` };
  return { done: true, tone: 'ok', says: 'Everything we can check works. You’re ready to go live.' };
}
/** What "Fix everything" will do, in order: real problems and set-up steps alike. */
export const autoFixes = (rows: DoctorRow[]) => rows.filter((r) => r.fix?.auto && r.mark !== 'ok').map((r) => r.fix!.action);

/** Software 3D (no graphics card): SwiftShader, llvmpipe, Microsoft Basic Render Driver, Apple software renderer. */
export const isSoftwareRenderer = (renderer: string) => /swiftshader|llvmpipe|softpipe|basic render|software|lavapipe/i.test(renderer);
