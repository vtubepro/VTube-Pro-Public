// "Use my phone for face tracking" (ZERO-EFFORT RULE). The listeners live in the helper (/api/external,
// server/tracking/*); this is the friendly front: a Go Live card with a live light, and a wizard:
//   pick the app → connect: the steps for the phone, then ONE button "Use this now" turns the listener on AND makes the
//   phone drive the avatar (nothing is switched on or over by itself: the user may be live). VTube Studio / iFacialMocap
//   find the phone without typing an IP; Live Link Face / Waidayo get ONE address of this PC + a QR code; the phone that
//   connects first is kept ("Phone: <IP>", "That's not my phone"); Windows firewall + Public network get a one-click fix
//   (from a page on this PC only) → phone buttons (VTube Studio) → rest pose.
// Android: any VMC app (AndroidMoCap) or "no app" = this phone's browser (src/phone/, labelled fallback): both track ON the
// phone. The phone as a webcam (Iriun / DroidCam / Camo / Windows Phone Link) is only a camera: tracking stays on this PC,
// and the wizard says so (people pick a phone to take load off the PC).
//
// VTube Studio's five-minute note: the VTube Studio FAQ lists "being able to stream to your PC for longer than five
// minutes" as a PRO feature (https://github.com/DenchiSoft/VTubeStudio/wiki/FAQ) but the third-party protocol README
// (https://github.com/DenchiSoft/VTubeStudioBlendshapeUDPReceiverTest) says nothing about a limit, and VSeeFace's page
// (https://github.com/DenchiSoft/VTubeStudio/wiki/Sending-data-to-VSeeFace) calls third-party sending free. Sources
// disagree, so the studio words it as "may".
import type { App } from '../app.ts';
import { externalApi, type ExternalPatch, type ExternalView, type PhoneNetView, type SourceStatus } from '../externalApi.ts';
import type { TrackingSourceChoice } from '../tracking/externalSource.ts';
import { MEOWFACE_NOTE, PHONE_APP_HINT, diagnose, type Diagnosis } from '../../shared/phoneNet.ts';
import { DEFAULT_3D_EXPRESSIONS, PHONE_HOTKEY_COUNT, PHONE_HOTKEY_PRESETS, hotkeyLabel, hotkeyProblem, type PhoneHotkey } from '../../shared/phoneHotkeys.ts';
import { comboOf, keyLabel } from '../../shared/rig2d/userParams.ts';
import { cameraKind, friendlyCameraLabel } from '../../shared/autopilot/media.ts';
import { lastPhoneHotkey, loadPhoneHotkeys, savePhoneHotkeys } from '../tracking/phoneHotkeys.ts';
import { button, h, toast, toggle } from './dom.ts';
import { add, card, item, live } from './bits.ts';
import { cameras, copyRow, startCamera } from './liveOps.ts';
import { qrSvg } from './inviteQr.ts';
import { wizHead, type WizCtx, type WizDef } from './wizard.ts';

type ListenKey = 'vtsPhone' | 'ifacialmocap' | 'liveLinkFace' | 'vmc';
type PhoneKey = ListenKey | 'webcam' | 'meowface';
/** `listen`: the helper listener an app uses when its own key is not one (MeowFace speaks VTube Studio's phone protocol). */
export interface PhoneApp { key: PhoneKey; source: TrackingSourceChoice; name: string; device: string; icon: string; blurb: string; listen?: ListenKey }
export const PHONE_APPS: PhoneApp[] = [
  { key: 'vtsPhone', source: 'vts-phone', name: 'VTube Studio', device: 'iPhone / iPad with Face ID', icon: '🤳', blurb: 'Free app. The phone tracks; VTube Pro finds your iPhone by itself.' },
  { key: 'meowface', source: 'vts-phone', listen: 'vtsPhone', name: 'MeowFace', device: 'Android phone (older free app, from itch.io)', icon: '🐱', blurb: 'No longer updated: may not work on newer Android phones. If it won’t connect, use VTube Studio or another phone app.' },
  { key: 'ifacialmocap', source: 'ifacialmocap', name: 'iFacialMocap / FaceMotion3D', device: 'iPhone (paid app)', icon: '📲', blurb: 'Very good for 3D avatars. No typing needed.' },
  { key: 'liveLinkFace', source: 'livelinkface', name: 'Live Link Face', device: 'iPhone 12 or newer (free, by Epic)', icon: '📱', blurb: 'Apple’s face capture, free.' },
  { key: 'vmc', source: 'vmc', name: 'Waidayo or any VMC app', device: 'iPhone (Waidayo) or Android (AndroidMoCap)', icon: '🛰️', blurb: 'The phone tracks and sends “VMC” to this PC.' },
  { key: 'webcam', source: 'webcam', name: 'Android: phone as a webcam', device: 'Iriun, DroidCam, Camo or Windows Phone Link', icon: '🎥', blurb: 'Only a camera: this PC still does the tracking work.' },
];
const bySource = (s: string) => PHONE_APPS.find((p) => p.source === s && p.key !== 'webcam') ?? null;
const isListen = (k: PhoneKey): k is ListenKey => k !== 'webcam' && k !== 'meowface';
/** The listener this app uses (null = none: a phone webcam). */
const listenOf = (a: PhoneApp | undefined | null): ListenKey | null => (a ? a.listen ?? (isListen(a.key) ? a.key : null) : null);
/** VTube Studio's free app: sources disagree whether its five-minute limit covers third-party PC apps (see the header). */
export const VTS_LIMIT_NOTE = 'VTube Studio’s free app may stop sending after 5 minutes; its PRO upgrade removes that.';

// ---------------------------------------------------------------- polling (one shared view, cheap)
let view: ExternalView | null = null, viewAt = 0, viewGot = 0;
let net: PhoneNetView | null = null, netAt = 0;
const everReceived = new Set<string>();
function poll(force = false) {
  if (force || Date.now() - viewAt > 1500) {
    viewAt = Date.now();
    void externalApi.get().then((v) => {
      view = v; viewGot = Date.now();
      for (const [k, s] of Object.entries(v.status)) if (s && typeof s === 'object' && 'lastSeen' in s && s.lastSeen) everReceived.add(k);
    }).catch(() => {});
  }
  if (force || Date.now() - netAt > 6000) { netAt = Date.now(); void externalApi.phoneNet(force).then((v) => { net = v; }).catch(() => {}); }
  return view;
}
/** The plain light for one source (shared/phoneNet.ts diagnose: one sentence + at most one fix). */
export function receiving(s: SourceStatus | undefined, key?: string): Diagnosis {
  // judged at the moment the helper answered (the view is up to 1.5 s old); a view older than 5 s = the helper is gone
  const now = viewGot && Date.now() - viewGot < 5000 ? viewGot : Date.now();
  return diagnose(s, { now, firewall: net?.firewall ?? null, profile: net?.profile ?? null, everReceived: key ? everReceived.has(key) : false, hint: key ? PHONE_APP_HINT[key] : undefined });
}
async function put(app: App, patch: ExternalPatch) {
  if (app.observer) { toast('Observer sandbox: phone listeners are not changed here.', 'warn'); return false; }
  try { view = await externalApi.update(patch); viewAt = Date.now(); return true; } catch (e) { toast(`Phone tracking: ${(e as Error).message}`, 'err', 8000); return false; }
}

async function allowFirewall(app: App, b?: HTMLButtonElement) {
  if (app.observer) { toast('Observer sandbox: nothing is changed here.', 'warn'); return; }
  if (b) { b.disabled = true; b.textContent = 'Windows is asking you…'; }
  toast('Windows will ask “Do you want to allow this app to make changes?”. Choose Yes.', 'info', 9000);
  try { const r = await externalApi.allowFirewall(); net = r.view; netAt = Date.now(); toast(r.says, r.ok ? 'ok' : 'warn', 8000); }
  catch (e) { toast(`Couldn’t ask Windows: ${(e as Error).message}`, 'err', 8000); }
  if (b) { b.disabled = false; b.textContent = 'Let phones connect'; }
}
async function openNetwork() {
  try { const r = await externalApi.openNetworkSettings(); toast(r.says, r.ok ? 'info' : 'warn', 9000); } catch (e) { toast((e as Error).message, 'err'); }
}
/** The one fix button a diagnosis asks for (null when none). */
function fixButton(app: App, d: Diagnosis): HTMLElement | null {
  if (d.fix === 'firewall') { const b = button('Let phones connect', () => void allowFirewall(app, b), 'primary') as HTMLButtonElement; return b; }
  if (d.fix === 'network') return button('Open network settings', () => void openNetwork(), 'primary');
  return null;
}

// ---------------------------------------------------------------- Go Live card
export function phoneCard(app: App, openWizard: () => void, refresh: () => void): HTMLElement {
  poll();
  const cur = bySource(app.trackingSource);
  const light = h('div');
  let lastText = '';
  const paint = () => {
    poll();
    const r = listenOf(cur) ? receiving(view?.status[listenOf(cur)!], listenOf(cur)!) : null;
    const text = r ? `${r.state}|${r.text}|${r.fix ?? ''}` : 'webcam';
    if (text === lastText) return;
    lastText = text;
    light.replaceChildren(item(cur ? r!.state : '', cur ? cur.icon : '📷', cur ? `Face from ${cur.name}` : 'Face from the webcam', cur ? r!.text : 'You can use a phone instead: often steadier, great in the dark.',
      cur ? h('div', { class: 's-row' }, r ? fixButton(app, r) : null, button('Use webcam', () => void backToWebcam(app, cur).then(refresh), 'ghost')) : null));
  };
  paint();
  live(() => { if (!light.isConnected) return false; paint(); return true; });
  return card('📱 Phone face tracking', null, light, h('div', { class: 's-row', style: 'margin-top:8px' },
    button(cur ? 'Change phone set-up' : 'Use my phone for face tracking', openWizard, cur ? '' : 'primary'),
    cur ? button('Re-centre (hold still)', () => { app.external.recenter(0.8, true); toast('Look at your screen and hold still… rest pose set.', 'ok', 3000); }, 'ghost') : null),
    listenOf(cur) ? flipRow(app, listenOf(cur)!) : null);
}

/**
 * "Head turns the wrong way? Flip it": ONE switch for the phone source in use (turn and tilt together), saved per source in the
 * helper's config (config/external.json invert, applied before the avatar sees the packet). Needed because the head axes of some
 * apps could not be proven without a device: iFacialMocap's head Y/Z are the open question (server/tracking/ifacialmocap.ts).
 */
export function flipRow(app: App, key: ListenKey): HTMLElement {
  const box = h('div', { style: 'margin-top:8px' });
  let last = '';
  const paint = () => {
    const c = poll()?.config[key] as unknown as { invert?: { yaw: boolean; roll: boolean } } | undefined;
    const on = !!c?.invert?.yaw && !!c?.invert?.roll;
    const sig = `${key}|${on}|${c ? 1 : 0}`;
    if (sig === last) return;
    last = sig;
    box.replaceChildren(toggle('Head turns the wrong way? Flip it', on, (v) => {
      void put(app, { [key]: { invert: { yaw: v, roll: v } } } as ExternalPatch).then((ok) => { if (ok) toast(v ? 'Flipped: turning and tilting your head now go the other way for this phone app.' : 'Back to the usual direction.', 'ok', 5000); });
    }, 'Turns the left / right turn and the tilt around for this app only. Saved; your other sources are not touched.'));
  };
  paint();
  live(() => { if (!box.isConnected) return false; paint(); return true; });
  return box;
}

// ---------------------------------------------------------------- bits of the wizard
/** This PC's ONE address, big, with Copy and a QR code (the phone's camera reads it into the app's address box). */
function addressBlock(port: number | null): HTMLElement {
  const ip = net?.lan.address ?? view?.lan?.[0] ?? null;
  if (!ip) return h('div', { class: 's-banner warn' }, 'This PC isn’t on a network yet. Connect it to the same Wi-Fi (or router) as your phone.');
  const qr = qrSvg(ip, { logo: false, margin: 2, label: `QR code: this PC's address ${ip}` });
  const box = h('div', { style: 'display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:6px 0' });
  const pic = h('div', { style: 'width:120px;height:120px;flex:none;border-radius:8px;overflow:hidden;background:#fff', title: 'Point the phone’s camera here to read the address' });
  pic.innerHTML = qr.svg;
  add(box, pic, h('div', { style: 'flex:1;min-width:180px' }, copyRow('This PC', ip, 'Address'), port ? copyRow('Port', String(port)) : null,
    net && net.lan.hidden.some((x) => /virtual|VPN|another/.test(x.why)) ? h('p', { class: 'note' }, 'We hid this PC’s VPN / virtual network addresses: phones can’t use them.') : null));
  return box;
}

/** The live light + its one fix, repainted 4× a second without rebuilding. Shows which phone is locked in, with
 *  "That's not my phone" (forget it: the next phone that sends is taken instead). */
function lightRow(app: App, key: ListenKey, firewallBelow = false): HTMLElement {
  const box = h('div', { class: 'wiz-checks', 'aria-live': 'polite' });
  let last = '';
  const paint = () => {
    const s = poll()?.status[key];
    const r = receiving(s, key);
    const info = (s?.info ?? {}) as { phone?: string | null; name?: string | null; candidate?: string | null };
    const who = s?.enabled && info.phone ? `Phone: ${info.name ? `${info.name} (${info.phone})` : info.phone}` : '';
    const knock = s?.enabled && info.candidate ? info.candidate : '';
    const sig = `${r.state}|${r.text}|${r.fix ?? ''}|${who}|${knock}`;
    if (sig === last) return;
    last = sig;
    const fix = firewallBelow && r.fix === 'firewall' ? null : fixButton(app, r);
    const notMine = who ? button('That’s not my phone', () => {
      if (app.observer) { toast('Observer sandbox: nothing is changed here.', 'warn'); return; }
      void externalApi.forgetPhone(key).then(() => { toast('Forgotten. The next phone that sends is used instead.', 'ok', 5000); poll(true); }).catch((e) => toast((e as Error).message, 'err'));
    }, 'ghost') : null;
    box.replaceChildren(h('div', { class: `wiz-check ${r.state}` }, h('span', { class: 'ic' }, r.state === 'ok' ? '✓' : r.state ? '!' : '·'),
      h('div', null, h('b', null, r.state === 'ok' ? 'Receiving your face' : 'Phone connection'), h('span', null, r.text),
        who ? h('div', { class: 'note', style: 'margin-top:6px', 'data-phone-who': '1' }, who, ' ', notMine) : null,
        // another device is sending while this phone is held: never switched silently, the person decides
        knock ? h('div', { class: 'note warn', style: 'margin-top:6px', 'data-phone-knock': knock }, `Another phone is sending (${knock}) — use it? `, button('Use it', () => {
          if (app.observer) { toast('Observer sandbox: nothing is changed here.', 'warn'); return; }
          void externalApi.switchPhone(key).then((o) => { toast(o.ok ? 'Switched to that phone.' : 'It stopped sending.', o.ok ? 'ok' : 'warn', 5000); poll(true); }).catch((e) => toast((e as Error).message, 'err'));
        }, 'primary')) : null,
        fix ? h('div', { style: 'margin-top:8px' }, fix) : null)));
  };
  paint();
  live(() => { if (!box.isConnected) return false; paint(); return true; });
  return box;
}

/** Windows firewall line: ✓ / "Let phones connect" (hidden on macOS / Linux; the Public network is the light's job). */
function firewallRow(app: App, key: ListenKey): HTMLElement {
  const box = h('div', { style: 'margin-top:10px' });
  let last = '';
  const paint = () => {
    const f = net?.firewall, p = net?.profile;
    // the phone's face is arriving: evidently nothing blocks it, so no firewall talk
    const through = receiving(view?.status[key], key).state === 'ok';
    // before "Use this now" there is no light yet: the Public network is said here (after it, the light says it)
    const publicNet = p?.category === 'Public' && !(view?.config[key] as { enabled?: boolean } | undefined)?.enabled;
    const sig = `${f?.supported}|${f?.ok}|${through}|${publicNet}`;
    if (sig === last) return;
    last = sig;
    const rows: Node[] = [];
    if (publicNet) rows.push(h('div', { class: 'wiz-check warn' }, h('span', { class: 'ic' }, '!'),
      h('div', null, h('b', null, 'Your network is set to Public'), h('span', null, 'Windows treats this network as Public, so it blocks phones. Switch it to Private (one setting; we don’t change it for you).'),
        h('div', { style: 'margin-top:8px' }, button('Open network settings', () => void openNetwork())))));
    if (f && f.supported && !through) {
      const b = f.ok ? null : button('Let phones connect', () => void allowFirewall(app, b!)) as HTMLButtonElement | null;
      rows.push(h('div', { class: `wiz-check ${f.ok ? 'ok' : ''}`, style: 'margin-top:8px' }, h('span', { class: 'ic' }, f.ok ? '✓' : '🛡'),
        h('div', null, h('b', null, 'Windows firewall'), h('span', null, f.ok ? 'Phones on your home Wi-Fi may connect.' : 'Windows may block your phone. One click asks Windows to let phones on your home Wi-Fi reach VTube Pro (only its phone ports). Windows asks you to confirm.'),
          b ? h('div', { style: 'margin-top:8px' }, b) : null)));
    }
    box.replaceChildren(...rows);
  };
  paint();
  live(() => { if (!box.isConnected) return false; paint(); return true; });
  return box;
}

/** "Doesn't find it? Type the phone's IP" (a fold; empty = find it by itself). */
function phoneIpFold(app: App, key: ListenKey, cur: string): HTMLElement {
  // VTube Studio / iFacialMocap: the PC calls that phone; Live Link Face / VMC: only that phone is accepted ("pinned")
  const calls = key === 'vtsPhone' || key === 'ifacialmocap';
  const input = h('input', { type: 'text', value: cur, placeholder: calls ? 'e.g. 192.168.1.23 (empty = find it by itself)' : 'e.g. 192.168.1.23 (empty = the first phone that sends)', 'aria-label': 'Phone IP', inputmode: 'decimal' }) as HTMLInputElement;
  const patch = (ip: string): ExternalPatch => (key === 'vtsPhone' ? { vtsPhone: { phoneIp: ip } } : key === 'ifacialmocap' ? { ifacialmocap: { phoneIp: ip } } : key === 'liveLinkFace' ? { liveLinkFace: { phoneIp: ip } } : { vmc: { phoneIp: ip } });
  const save = () => void put(app, patch(input.value.trim()))
    .then((ok) => { if (ok) toast(input.value.trim() ? (calls ? 'Saved: VTube Pro talks to that phone.' : 'Saved: only that phone is accepted.') : 'VTube Pro takes the first phone that sends again.', 'ok'); });
  return h('details', { style: 'margin-top:8px' }, h('summary', null, calls ? 'Doesn’t find your phone? Type its IP address' : 'Only accept one phone: type its IP address'),
    h('p', { class: 'note' }, calls ? 'The app shows it (VTube Studio: Settings → “Show IP list”). Use the one that starts like this PC’s address.'
      : 'Find it in the phone’s Wi-Fi settings (tap your network). Other phones and apps on your Wi-Fi are then ignored.'),
    h('div', { class: 's-row' }, input, button('Save', save)));
}

/** Phone webcams this PC sees right now (Android choice). */
function phoneCams(app: App): HTMLElement {
  const box = h('div', { style: 'margin-top:8px' });
  const draw = async (refresh: boolean) => {
    const list = (await cameras(refresh)).filter((c) => cameraKind(c.label) === 'phone');
    box.replaceChildren(list.length
      ? h('div', null, ...list.map((c) => item('ok', '🎥', friendlyCameraLabel(c.label.replace(/^Your phone \([^)]*\) · /, '')), 'Found on this PC.', button('Use this camera', async () => {
        if (app.trackingSource !== 'webcam') app.setTrackingSource('webcam');
        if (await startCamera(app, c.deviceId)) toast('Your phone is the camera now. Keep its screen on and the app open.', 'ok', 6000);
      }, 'primary'))))
      : item('', '🔎', 'No phone camera yet', 'Start the app on the phone (and its PC part, if it has one); it shows up here.', button('Look again', () => void draw(true))));
  };
  void draw(false);
  return box;
}

// ---------------------------------------------------------------- phone buttons (VTube Studio 1-8)
export function phoneButtonsEditor(app: App): HTMLElement {
  const box = h('div');
  const draw = () => {
    const list = loadPhoneHotkeys();
    const flat = app.runtime?.flat?.expressions() ?? null;
    const rows = list.map((hk, i) => {
      const n = i + 1;
      const ex = flat ? (flat.find((x) => (/^(?:Digit|Numpad)(\d)$/.exec(x.key ?? '')?.[1]) === String(n)) ?? flat[i]) : null;
      const exprLabel = !flat ? `Face: ${DEFAULT_3D_EXPRESSIONS[i]}` : ex ? `Expression: ${ex.name}` : `Nothing yet (your model has ${flat.length} expression${flat.length === 1 ? '' : 's'})`;
      const opts: [string, string][] = [['expression', exprLabel], ...PHONE_HOTKEY_PRESETS.map((p, j) => [`p${j}`, p.label] as [string, string]), ['key', 'A key of my model…'], ['none', 'Nothing']];
      const curVal = hk.kind === 'expression' ? 'expression' : hk.kind === 'none' ? 'none' : hk.kind === 'key' ? 'key'
        : `p${PHONE_HOTKEY_PRESETS.findIndex((p) => hotkeyLabel(p.hk) === hotkeyLabel(hk))}`;
      const sel = h('select', { 'aria-label': `Phone button ${n}` }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === curVal }, l))) as HTMLSelectElement;
      const keyIn = h('input', { type: 'text', readonly: true, placeholder: 'press a key', value: hk.kind === 'key' ? keyLabel(hk.combo) : '', style: `width:110px;${hk.kind === 'key' ? '' : 'display:none'}`, 'aria-label': `Key for phone button ${n}` }) as HTMLInputElement;
      const setAt = (v: PhoneHotkey) => { const l = loadPhoneHotkeys(); l[i] = v; savePhoneHotkeys(l); };
      sel.onchange = () => {
        const v = sel.value;
        keyIn.style.display = v === 'key' ? '' : 'none';
        if (v === 'key') { keyIn.focus(); return; }
        setAt(v === 'none' ? { kind: 'none' } : v === 'expression' ? { kind: 'expression' } : PHONE_HOTKEY_PRESETS[Number(v.slice(1))].hk);
      };
      keyIn.onkeydown = (e) => {
        if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(e.code)) return;
        e.preventDefault();
        const combo = comboOf(e);
        const bad = hotkeyProblem({ kind: 'key', combo });
        if (bad) { toast(bad, 'warn', 5000); return; }
        keyIn.value = keyLabel(combo);
        setAt({ kind: 'key', combo });
      };
      return h('div', { style: 'display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:8px;margin:4px 0' }, h('b', { style: 'text-align:right' }, String(n)), sel, keyIn);
    });
    const tapped = h('p', { class: 'note' });
    live(() => { if (!tapped.isConnected) return false; const t = lastPhoneHotkey; tapped.textContent = t.at && Date.now() - t.at < 4000 ? `You tapped button ${t.n}${t.did ? `: ${t.did}` : ''}.` : 'Tap a number on the phone’s screen to try it.'; return true; });
    box.replaceChildren(...rows.slice(0, PHONE_HOTKEY_COUNT), tapped);
  };
  draw();
  return box;
}

// ---------------------------------------------------------------- "Find my phone" (every known port at once)
/** The wizard's app card for something the detector heard (server/tracking/phoneDetect.ts). */
export function appForDetected(f: { app: string; label: string }): PhoneApp | null {
  if (f.app === 'vtsPhone') return PHONE_APPS.find((p) => p.key === (/meow/i.test(f.label) ? 'meowface' : 'vtsPhone')) ?? null;
  return PHONE_APPS.find((p) => p.key === f.app) ?? null;
}
/**
 * "Not sure which app it is? Find my phone": the helper listens on every phone port at once and asks the LAN the way each
 * app expects (VTube Studio, iFacialMocap, FaceMotion3D); the user only opens the app on the phone. What it hears is named
 * ("Live Link Face on 192.168.1.23") with one button that picks that app. Nothing drives the avatar from here; it stops by
 * itself after two minutes, when the user picks, or when the page is left.
 */
function findBlock(app: App, onPick: (a: PhoneApp) => void): HTMLElement {
  const box = h('div', { style: 'margin-top:14px', 'data-phone-find': '1' });
  let on = false, last = '', lastGet = 0, busy = false, view: Awaited<ReturnType<typeof externalApi.detect>> | null = null;
  const set = async (v: boolean) => {
    if (app.observer) { toast('Observer sandbox: nothing is listening here.', 'warn'); return; }
    if (busy) return;
    busy = true;
    try { view = await externalApi.detectSet(v); on = view.on; lastGet = Date.now(); } catch (e) { toast(`Find my phone: ${(e as Error).message}`, 'err', 7000); on = false; } finally { busy = false; last = ''; paint(); }
  };
  const paint = () => {
    const now = Date.now();
    const rows = (view?.found ?? []).filter((f) => now - f.lastSeen < 8000 || f.via === 'source');
    const sig = `${on}|${rows.map((f) => `${f.app}${f.ip}${f.faceFound}${f.label}`).join(',')}|${view?.skipped.length ?? 0}|${view?.unknown ?? 0}`;
    if (sig === last) return;
    last = sig;
    const kids: Node[] = [];
    if (!on) {
      kids.push(h('div', { class: 's-row', style: 'align-items:center' }, button('Not sure which app? Find my phone', () => void set(true), 'ghost'),
        h('span', { class: 'note' }, 'Open the face-tracking app on the phone first. VTube Pro listens on all the usual ports at once and tells you which one it hears.')));
    } else {
      kids.push(h('div', { class: 'wiz-check', 'aria-live': 'polite' }, h('span', { class: 'ic' }, rows.length ? '✓' : '…'),
        h('div', null, h('b', null, rows.length ? 'Found it' : 'Listening…'),
          h('span', null, rows.length ? 'Pick it to carry on.' : 'Open the app on the phone now (same Wi-Fi as this PC) and start its face tracking. This can take a few seconds.'))));
      for (const f of rows) {
        const a = appForDetected(f);
        kids.push(item(f.faceFound ? 'ok' : 'warn', a?.icon ?? '📱', `${f.label}${f.ip ? ` on ${f.ip}` : ''}`, `${f.detail}${f.faceFound ? '' : ' (it can’t see a face yet)'}`,
          a ? button(`Use ${a.name}`, () => { void externalApi.detectSet(false).catch(() => {}); on = false; onPick(a); }, 'primary') : null));
      }
      if (view?.skipped.length) kids.push(h('p', { class: 'note' }, `Not listening on port${view.skipped.length === 1 ? '' : 's'} ${view.skipped.map((s) => s.port).join(', ')}: another program (or a source you already turned on) is using ${view.skipped.length === 1 ? 'it' : 'them'}.`));
      if (!rows.length && (view?.unknown ?? 0) > 0) kids.push(h('p', { class: 'note' }, 'Something is sending to this PC, but it is not a phone app we know. Pick your app from the list instead.'));
      kids.push(h('div', { class: 's-row' }, button('Stop looking', () => void set(false), 'ghost')));
    }
    box.replaceChildren(...kids);
  };
  paint();
  live(() => {
    if (!box.isConnected) { if (on) void externalApi.detectSet(false).catch(() => {}); on = false; return false; }
    if (on && !busy && Date.now() - lastGet > 1000) {
      lastGet = Date.now();
      void externalApi.detect().then((v) => { view = v; if (!v.on) on = false; paint(); }).catch(() => {});
    }
    return true;
  });
  return box;
}

// ---------------------------------------------------------------- the wizard
const APP_KEY = 'vtp.phone.app';
const listenPatch = (k: ListenKey, on: boolean): ExternalPatch => (k === 'vtsPhone' ? { vtsPhone: { enabled: on } } : k === 'ifacialmocap' ? { ifacialmocap: { enabled: on } } : k === 'liveLinkFace' ? { liveLinkFace: { enabled: on } } : { vmc: { enabled: on } });
/** "Use this now": the user's one explicit step: turn the chosen phone source on and let it drive the avatar. */
async function useNow(app: App, a: PhoneApp): Promise<boolean> {
  if (app.observer) { toast('Observer sandbox: nothing is switched on here.', 'warn'); return false; }
  if (listenOf(a)) {
    if (!(await put(app, listenPatch(listenOf(a)!, true)))) return false;
    app.setTrackingSource(a.source);
    poll(true);
  } else return false;
  toast(`Your avatar follows ${a.name} now. If the phone goes quiet, the webcam takes over.`, 'ok', 7000);
  return true;
}
/** "Back to the webcam": the avatar follows the webcam again and that phone source is turned off. */
async function backToWebcam(app: App, a: PhoneApp) {
  app.setTrackingSource('webcam');
  if (listenOf(a)) await put(app, listenPatch(listenOf(a)!, false));
}
function useRow(app: App, a: PhoneApp, ctx: WizCtx): HTMLElement {
  const on = app.trackingSource === a.source;
  return h('div', { class: 's-row', style: 'margin:12px 0' },
    on ? h('span', { class: 's-badge ok' }, `✓ ${a.name} drives your avatar`) : button('Use this now', () => void useNow(app, a).then(() => ctx.refresh()), 'primary'),
    on ? button('Back to the webcam', () => void backToWebcam(app, a).then(() => ctx.refresh()), 'ghost') : null);
}

/** Is this phone really sending to this PC right now? 'unknown' = a phone used as a plain webcam (nothing to listen for). */
function phoneSignal(app: App, a: PhoneApp): 'yes' | 'no' | 'unknown' {
  const key = listenOf(a);
  if (!key) return 'unknown';
  const s = view?.status[key];
  const now = viewGot && Date.now() - viewGot < 5000 ? viewGot : Date.now();
  return s?.enabled && s.running && s.lastSeen !== null && now - s.lastSeen < 1200 ? 'yes' : 'no';
}

export function phoneWizard(app: App): WizDef {
  // the app picked last time (the wizard may reopen on its Connect step), else the one driving the avatar now
  const saved = (() => { try { return localStorage.getItem(APP_KEY); } catch { return null; } })();
  const d = { key: (PHONE_APPS.find((p) => p.key === saved)?.key ?? bySource(app.trackingSource)?.key) } as { key?: PhoneKey };
  const app_ = () => PHONE_APPS.find((p) => p.key === (d.key ?? 'vtsPhone'))!;
  let lastSig = '';
  return {
    id: 'phone', title: 'Use my phone for face tracking', blurb: 'An iPhone app (best), or any phone as a camera.',
    steps: [
      {
        id: 'pick', title: 'Pick your app',
        render: (ctx, el) => {
          poll(true);
          add(el, ...wizHead('Which phone app?', 'Install one of these on your phone. Phone and PC on the same Wi-Fi.'),
            h('div', { class: 'wiz-choice', style: 'grid-template-columns:repeat(auto-fill,minmax(210px,1fr))' }, ...PHONE_APPS.map((p) => h('button', { class: `wiz-opt ${(d.key ?? '') === p.key ? 'on' : ''}`, 'data-phone-app': p.key, onClick: () => { d.key = p.key; try { localStorage.setItem(APP_KEY, p.key); } catch { /* storage off */ } ctx.next(); } },
              h('b', null, `${p.icon} ${p.name}`), h('span', null, p.device), h('span', null, p.blurb)))),
            h('p', { class: 'note', style: 'margin-top:10px' }, 'iPhone apps track best (Face ID depth camera). Android: the browser page or a VMC app takes the tracking off this PC; as a webcam, this PC still tracks.'),
            findBlock(app, (p) => { d.key = p.key; try { localStorage.setItem(APP_KEY, p.key); } catch { /* storage off */ } ctx.next(); }),
            app.observer ? h('div', { class: 's-banner warn', style: 'margin-top:12px' }, 'Observer sandbox: nothing is switched on here.') : null);
        },
      },
      {
        id: 'connect', title: 'Connect',
        // Next waits for a real connection (Skip always works: the last step then says plainly it is not connected yet)
        blocker: () => (phoneSignal(app, app_()) === 'no' ? 'Waiting for your phone… Press “Use this now”, or skip this step and finish later.' : null),
        live: (ctx) => { const sig = phoneSignal(app, app_()); if (sig !== lastSig) { lastSig = sig; ctx.refresh(); } },
        render: (ctx, el) => {
          const a = app_(), v = poll();
          if (!listenOf(a)) {
            add(el, ...wizHead('Use your phone as a webcam', 'Pick one app; it makes the phone a camera on this PC. VTube Pro then tracks your face from it on this PC, so this saves no PC work. To take the tracking off this PC, go back and pick this phone’s browser or a VMC app.'),
              h('ol', { class: 's-steps' },
                h('li', null, h('span', null, h('b', null, 'Iriun'), ', ', h('b', null, 'DroidCam'), ' or ', h('b', null, 'Camo'), ': install the app on the phone and its PC part on this computer, then open both.')),
                h('li', null, h('span', null, h('b', null, 'Windows Phone Link'), ' (no install on Android): Settings → Bluetooth & devices → Mobile devices → turn on “Use as a connected camera”. Keep the phone’s screen on.')),
                h('li', null, h('span', null, 'Prop the phone at eye level, just below your screen. A USB cable is steadier than Wi-Fi.'))),
              phoneCams(app),
              h('p', { class: 'note', style: 'margin-top:10px' }, 'Have an app that sends “VMC” (AndroidMoCap, XR Animator)? Go back and pick “Waidayo or any VMC app”.'));
            return;
          }
          const key = listenOf(a)!;
          const cfg = v?.config[key] as unknown as { enabled: boolean; port?: number; listenPort?: number; phoneIp?: string } | undefined;
          const port = key === 'vtsPhone' ? null : cfg?.port ?? null;
          const steps: (string | Node)[][] = a.key === 'meowface' ? [
            ['On the Android phone open ', h('b', null, 'MeowFace'), ' and start tracking; keep the app open and the screen on.'],
            ['Same Wi-Fi as this PC, then press “Use this now”. If MeowFace works on your phone, VTube Pro finds it by itself (it speaks VTube Studio’s phone protocol).'],
            ['Nothing yet? MeowFace shows the phone’s IP address: type it under “Type its IP address” below.'],
          ] : key === 'vtsPhone' ? [
            ['On the iPhone, open ', h('b', null, 'VTube Studio'), ' → Settings (first tab) → turn on ', h('b', null, '3rd Party PC Clients'), '.'],
            ['Keep VTube Studio open and the phone unlocked, then press “Use this now”. VTube Pro finds your iPhone by itself.'],
          ] : key === 'ifacialmocap' ? [
            ['Open ', h('b', null, 'iFacialMocap'), ' or ', h('b', null, 'FaceMotion3D'), ' (either mode works), then press “Use this now”. VTube Pro calls the phone by itself.'],
            ['Nothing yet? Type this PC’s address into the app’s destination / PC IP box:', addressBlock(port)],
          ] : key === 'liveLinkFace' ? [
            ['Open ', h('b', null, 'Live Link Face'), ' → pick ', h('b', null, 'Live Link (ARKit)'), '.'],
            ['Tap ', h('b', null, '⚙ Settings'), ' → ', h('b', null, 'Live Link'), ' → ', h('b', null, 'Add Target'), ' and type this address and port:', addressBlock(port ?? 11111)],
            ['Keep ', h('b', null, 'Stream Head Rotation'), ' on, then press “Use this now”.'],
          ] : [
            ['Open ', h('b', null, 'Waidayo'), ' (iPhone) or your VMC app (Android: AndroidMoCap, from its GitHub releases page). Choose sending to a PC / VMC.'],
            ['Type this PC’s address. Port ', h('b', null, String(port ?? 39539)), view?.config.vmc.port2 ? ` (${view.config.vmc.port2} works too)` : '', ':', addressBlock(port ?? 39539)],
            ['Then press “Use this now”.'],
          ];
          add(el, ...wizHead(`Connect ${a.name}`, 'Do this on the phone:'),
            a.key === 'meowface' ? h('div', { class: 's-banner warn', 'data-meowface-note': '1' }, MEOWFACE_NOTE) : null,
            h('ol', { class: 's-steps' }, ...steps.map((s) => h('li', null, h('span', null, ...s)))),
            a.key === 'vtsPhone' ? h('p', { class: 'note' }, VTS_LIMIT_NOTE) : null,
            useRow(app, a, ctx),
            cfg?.enabled ? lightRow(app, key, true) : null,
            firewallRow(app, key),
            phoneIpFold(app, key, cfg?.phoneIp ?? ''));
        },
      },
      {
        id: 'buttons', title: 'Phone buttons',
        hidden: () => d.key !== 'vtsPhone',
        render: (_ctx, el) => add(el, ...wizHead('The number buttons on the phone', 'VTube Studio shows buttons 1–8 on the phone’s screen. Pick what each one does. Out of the box, button 1 is your model’s expression 1, and so on.'),
          phoneButtonsEditor(app)),
      },
      {
        id: 'rest', title: 'Rest pose',
        hidden: () => !listenOf(app_()),
        render: (_ctx, el) => add(el, ...wizHead('Set your rest pose', 'Look at your screen (not the phone) and hold still for a second. Your avatar then looks at the camera when you look at your screen.'),
          h('div', { class: 's-row' }, button('Re-centre now (hold still 1 s)', () => { app.external.recenter(0.8, true); toast('Hold still… rest pose set ✓', 'ok', 2500); }, 'primary')),
          listenOf(app_()) ? flipRow(app, listenOf(app_())!) : null,
          h('p', { class: 'note', style: 'margin-top:10px' }, 'It also happens by itself when a face first arrives. Turn your head to your left: the avatar should follow to its left. If it goes the other way, flip it above. (Nod and tilt have their own switches under Tracking → Advanced → Camera & tracking → External tracking.)')),
      },
      {
        id: 'done', title: 'Done',
        render: (_ctx, el) => {
          const sig = phoneSignal(app, app_());
          if (sig === 'no') {
            // not connected: never say it is set up
            add(el, ...wizHead('Not connected yet — you can finish later', 'Your phone has not sent anything to this PC. Nothing is broken: open Tracking → “Change phone set-up” when the phone app is open, press “Use this now”, and this window picks up where you left off. Until then your webcam keeps tracking.'),
              listenOf(app_()) && app.trackingSource === app_().source ? lightRow(app, listenOf(app_())!) : null);
            return;
          }
          add(el, ...wizHead(sig === 'yes' ? 'Phone tracking is set up 📱' : 'Phone camera chosen 📱', sig === 'yes'
            ? 'The Tracking area shows a live light. If the phone sleeps or the Wi-Fi drops and the webcam is on, the webcam takes over by itself. To take the tracking work off this PC, turn this PC’s camera off: the phone keeps driving your avatar.'
            : 'If your phone shows up as a camera under Tracking, pick it there. This PC still does the tracking work with it; the phone is only the camera.'),
            listenOf(app_()) && app.trackingSource === app_().source ? lightRow(app, listenOf(app_())!) : null);
        },
        nextLabel: 'Finish',
      },
    ],
  };
}
export type { WizCtx };
