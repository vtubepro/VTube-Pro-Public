// The relay's /tv page: join a VTube Pro party WITHOUT VTube Pro — as a webcam (or VTube Studio) on a walking TV.
// guestlink: the same page serves the no-sign-in interview link /g/<token> (window.VTP_INVITE): the guest types a name,
// the page trades the invite for a guest ticket (POST /g/ticket) and can rejoin by itself after a dropped connection.
// Bundled by tools/build_tv_guest.mjs into relay/src/tvGuestPage.gen.ts (a string the Worker serves with a CSP nonce).
// Everything runs in this tab: camera → WebRTC → the host's VTube Pro. The relay only carries the handshake.
import { TvLiteGuest } from '../../src/net/tv/tvLiteGuest.ts';
import { listCameras, listMics } from '../../src/net/tv/tvSource.ts';
import { CHROMA_PRESETS, TV_PRESETS, TV_SKINS } from '../../shared/tv.ts';
import { SPOUT_APPS, SPOUT_BRIDGE_KEY } from '../../shared/spout.ts';
import { peekTicket } from '../../src/net/relayClient.ts';
import { DEFAULT_COMBO, GUEST_MSG_MAX, comboFrom, comboLabel, comboMatch, comboTypes, readCombo, type Combo } from '../../shared/greenroom.ts';
import { modStatus } from '../../shared/moderation.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const G = new TvLiteGuest();
(window as unknown as { G: TvLiteGuest }).G = G;
const INVITE = (window as unknown as { VTP_INVITE?: boolean }).VTP_INVITE === true;
const hash = new URLSearchParams(location.hash.slice(1));
const ticket = hash.get('t') ?? '';
const relay = hash.get('relay') || location.origin;
if (!INVITE) history.replaceState(null, '', location.pathname);            // the ticket never stays in the address bar / history
// (invite-experience: the page puts the host's shown name in data-host; the old title parse stays as a fallback)
const t: { hn?: string; n?: string } = INVITE ? { hn: document.getElementById('title')?.dataset.host || (document.getElementById('title')?.textContent ?? '').replace(/^Join (.*)’s show$/, '$1') } : peekTicket(ticket);
const invTok = INVITE ? location.pathname.replace(/^\/g\//, '') : '';
const store = (k: string, v?: string) => { try { if (v === undefined) return localStorage.getItem(k) ?? ''; localStorage.setItem(k, v); } catch { /* storage off */ } return ''; };
// this tab's key: the link counts DISTINCT guests, so a reconnect from this tab never uses it up
let gk = ''; try { gk = sessionStorage.getItem('vtp.gl.gk') ?? ''; } catch { /* */ }
if (!/^[a-z0-9]{24}$/.test(gk)) { gk = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join(''); try { sessionStorage.setItem('vtp.gl.gk', gk); } catch { /* */ } }
let wantIn = false, retryN = 0, retryT = 0, retryAt = 0;
/** guestlink: attempts in a row that never connected (the networks can't reach each other). After 2 the page stops
 *  retrying by itself (each retry is a new knock on the host's room) and says what to do instead. */
let iceFails = 0, cardOn = false;
// extra controls (made here so the relay's page markup stays the same): "join without a camera" + "tap to hear the host"
const nocam = Object.assign(document.createElement('button'), { id: 'nocam', textContent: 'No camera? Join with a name card instead', type: 'button', className: 'linkbtn' });
const hear = Object.assign(document.createElement('button'), { id: 'hear', type: 'button', className: 'btn' });
$('start').after(nocam);
$('status').before(hear);
const myName = () => (INVITE ? (($('name') as HTMLInputElement).value || '').trim() : t.n ?? '') || 'Guest';

// ---------------------------------------------------------------- greenroom: waiting room, messages, READY, mute hotkey
const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const { style, ...rest } = props;
  const e = Object.assign(document.createElement(tag), rest);
  if (typeof style === 'string') e.style.cssText = style;
  e.append(...kids);
  return e;
};
// (invite-experience: the green room / mute styles moved to the page itself: relay/src/guestUi.ts GUEST_CSS)
const grbar = mk('div', { id: 'grbar', hidden: true, role: 'alert' });
const grText = mk('div', { className: 't' });
const grOk = mk('button', { type: 'button', textContent: 'Got it', className: 'btn' });
grbar.append(grText, grOk);
document.querySelector('main')?.prepend(grbar);   // (above everything: the intro is hidden once you're in)
const grcard = mk('div', { className: 'grcard panel', hidden: true, role: 'status' });
const readyBtn = mk('button', { id: 'ready', type: 'button', textContent: '✋ I’m ready', className: 'btn' });
const noteIn = mk('input', { type: 'text', id: 'grnote', maxLength: GUEST_MSG_MAX, placeholder: 'Short message to the host (optional)', autocomplete: 'off' });
const noteSend = mk('button', { type: 'button', textContent: 'Send', className: 'btn secondary' });
const readyRow = mk('div', { className: 'grrow', hidden: true }, readyBtn, noteIn, noteSend);
const grNote = mk('p', { className: 'note', hidden: true, style: 'text-align:center' });
const grhist = mk('details', { id: 'grhist', hidden: true, className: 'help' });
const grList = mk('ol');
grhist.append(mk('summary', { textContent: 'Messages from the host' }), mk('div', {}, grList));
// mute: big button, hotkey (+ push-to-talk), honest note, the always-on-top pop-out
const muteBtn = mk('button', { id: 'mute', type: 'button', className: 'btn' });
const keyLbl = mk('span', { className: 'kbd' });
const setKey = mk('button', { type: 'button', textContent: 'Set hotkey', className: 'btn secondary small' });
const pttBox = mk('input', { type: 'checkbox', id: 'ptt' });
const pipBtn = mk('button', { type: 'button', textContent: '⧉ Pop out a mute button (stays on top)', className: 'btn secondary small' });
const keyNote = mk('p', { className: 'note' });
const muteBox = mk('div', { id: 'mutebox', hidden: true, className: 'forjoined' }, muteBtn,
  mk('details', { className: 'help' }, mk('summary', { textContent: 'Mute shortcut and pop-out button' }), mk('div', {},
    mk('div', { className: 'grrow' }, mk('span', { className: 'note', textContent: 'Mute hotkey:' }), keyLbl, setKey),
    mk('label', { className: 'check' }, pttBox, mk('span', { textContent: 'Push-to-talk: stay muted, hold the hotkey (or the button) to talk' })),
    mk('div', { className: 'grrow' }, pipBtn), keyNote)));
const mutedTag = mk('span', { className: 'mutedtag', textContent: '🔇 MUTED', hidden: true });
// moderation: the host hid my camera from the show → my own preview says so (the host still enforces it on their side)
const hidTag = mk('div', { className: 'hidtag', hidden: true, role: 'status' });
document.querySelector('.stage')?.append(mutedTag, hidTag);
const svg = (d: string) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON_WAVE = svg('<path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11M10 10V5a1.5 1.5 0 0 1 3 0v5M13 10V6a1.5 1.5 0 0 1 3 0v6"/><path d="M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-12.2 4.7L4.5 15.5a1.5 1.5 0 0 1 2.3-1.9L8 15"/>');
const ICON_MICOFF = svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/>');
const ICON_AIR = svg('<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>');
const ICONS: Record<string, string> = {
  door: svg('<path d="M5 21V4.5A1.5 1.5 0 0 1 6.5 3h9A1.5 1.5 0 0 1 17 4.5V21M3 21h18"/><circle cx="13.5" cy="12.5" r=".9"/>'),
  ended: svg('<path d="M12 3l2.3 4.8 5.2.7-3.8 3.6.9 5.2L12 14.8l-4.6 2.5.9-5.2L4.5 8.5l5.2-.7z"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  users: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2A4.5 4.5 0 0 1 21 18.5"/>'),
  wifi: svg('<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.6 16a5 5 0 0 1 6.8 0"/><circle cx="12" cy="19.4" r="1"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  link: svg('<path d="M9 15l6-6"/><path d="M11 6l1-1a4.2 4.2 0 0 1 6 6l-1 1M13 18l-1 1a4.2 4.2 0 0 1-6-6l1-1"/>'),
  cam: svg('<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/>'),
  camoff: svg('<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3M3 3l18 18"/>'),
};
// one card for the moments with a single message (knocking, show over, couldn't connect …): drawn by stateDraw()
const stateCard = mk('div', { className: 'panel stateCard', hidden: true, role: 'status' });
// moderation: what the host decided about me, in plain words, for as long as it lasts
const modcard = mk('div', { className: 'panel modcard', hidden: true, role: 'status' });
$('status').after(stateCard, modcard, grcard, readyRow, grNote, grhist, muteBox);
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } };
let combo: Combo = readCombo(lsGet('vtp.gl.muteKey')) ?? DEFAULT_COMBO;
let ptt = lsGet('vtp.gl.ptt') === '1', capturing = false, pttHeld = false;
const baseTitle = document.title;
/** Document Picture-in-Picture (Chromium 116+): a tiny always-on-top window with the mute button. */
const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
let pip: { w: Window; mute: HTMLButtonElement; st: HTMLElement; ready: HTMLButtonElement; msg: HTMLElement } | null = null;
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(el.type)));
function onKeyDown(e: KeyboardEvent) {
  if (capturing) {
    e.preventDefault(); e.stopPropagation();
    if (e.code === 'Escape') { capturing = false; draw(); return; }
    const c = comboFrom(e);
    if (!c) return;                                   // (a modifier alone: wait for the key)
    combo = c; lsSet('vtp.gl.muteKey', JSON.stringify(c)); capturing = false; draw();
    return;
  }
  if (!G.voice || !comboMatch(combo, e) || (comboTypes(combo) && typing(e.target))) return;
  e.preventDefault();
  if (e.repeat) return;
  if (ptt) { pttHeld = true; G.setMuted(false); } else G.setMuted(!G.muted);
}
function onKeyUp(e: KeyboardEvent) { if (ptt && pttHeld && comboMatch(combo, e, true)) { pttHeld = false; G.setMuted(true); } }
// (a push-to-talk key held while the window loses focus never sends its key-up: mute on blur)
const onBlur = () => { if (ptt && pttHeld) { pttHeld = false; G.setMuted(true); } };
window.addEventListener('keydown', onKeyDown, true); window.addEventListener('keyup', onKeyUp, true); window.addEventListener('blur', onBlur);
const muteClick = () => { if (ptt) return; G.setMuted(!G.muted); };
const pttDown = () => { if (ptt) { pttHeld = true; G.setMuted(false); } };
const pttUp = () => { if (ptt && pttHeld) { pttHeld = false; G.setMuted(true); } };
muteBtn.addEventListener('click', muteClick);
muteBtn.addEventListener('pointerdown', pttDown); muteBtn.addEventListener('pointerup', pttUp); muteBtn.addEventListener('pointerleave', pttUp);
setKey.addEventListener('click', () => { capturing = !capturing; draw(); });
pttBox.checked = ptt;
pttBox.addEventListener('change', () => { ptt = pttBox.checked; lsSet('vtp.gl.ptt', ptt ? '1' : '0'); pttHeld = false; if (ptt) G.setMuted(true); draw(); });
readyBtn.addEventListener('click', () => { const err = G.setReady(!G.ready, noteIn.value); if (err) { G.status = err; } else if (G.ready) noteIn.value = ''; draw(); });
const sendNote = () => { const err = G.note(noteIn.value); if (!err) noteIn.value = ''; else G.status = err; draw(); };
noteSend.addEventListener('click', sendNote);
noteIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendNote(); } });
grOk.addEventListener('click', () => { grbar.hidden = true; G.markRead(); document.title = baseTitle; });
const seen = () => { if (!document.hidden) { document.title = baseTitle; } };
document.addEventListener('visibilitychange', seen); window.addEventListener('focus', seen);
G.onMod = (text) => {
  const on = G.hostMod.cam || G.hostMod.mic;
  grText.replaceChildren(text, mk('small', { textContent: `${on ? 'Only the host can turn it back on' : 'You’re back on the show'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }));
  grbar.hidden = false;
  grbar.classList.toggle('mod', on);
  grbar.classList.remove('new'); void grbar.offsetWidth; grbar.classList.add('new');
  if (document.hidden || !document.hasFocus()) document.title = `● ${text.slice(0, 40)} — ${baseTitle}`;
  if (pip) { pip.msg.textContent = text; pip.msg.hidden = false; }
  draw();
};
G.onMessage = (text) => {
  grText.replaceChildren(text, mk('small', { textContent: `from ${G.hostName || 'the host'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }));
  grbar.hidden = false; grbar.classList.remove('mod');
  // a soft visual cue, no sound: the banner pulses 3×, the tab title shows it until you look
  grbar.classList.remove('new'); void grbar.offsetWidth; grbar.classList.add('new');
  if (document.hidden || !document.hasFocus()) document.title = `● ${text.slice(0, 40)} — ${baseTitle}`;
  if (pip) { pip.msg.textContent = text; pip.msg.hidden = false; }
};
pipBtn.addEventListener('click', async () => {
  if (pip) { pip.w.close(); return; }
  if (!dpip) return;
  try {
    const w = await dpip.requestWindow({ width: 280, height: 190 });
    const d = w.document;
    d.head.append(Object.assign(d.createElement('style'), { textContent: 'body{margin:0;font:15px system-ui,sans-serif;background:#111318;color:#e8e8ef;display:flex;flex-direction:column;gap:8px;padding:10px;box-sizing:border-box;height:100vh}button{font:inherit;font-weight:700;border:0;border-radius:10px;color:#fff;cursor:pointer;padding:10px}#m{flex:1;font-size:22px;background:#39405a}#m.muted{background:#ed4245}#r{background:#39405a}#r.on{background:#3ba55d}#s{font-size:12px;color:#aab}#g{font-size:13px;font-weight:700;color:#ffe2a8;background:#2b2412;border-radius:8px;padding:6px 8px}' }));
    const st = Object.assign(d.createElement('div'), { id: 's' });
    const mute = Object.assign(d.createElement('button'), { id: 'm', type: 'button' });
    const ready = Object.assign(d.createElement('button'), { id: 'r', type: 'button' });
    const msg = Object.assign(d.createElement('div'), { id: 'g', hidden: true });
    d.body.append(msg, st, mute, ready);
    mute.addEventListener('click', muteClick); mute.addEventListener('pointerdown', pttDown); mute.addEventListener('pointerup', pttUp); mute.addEventListener('pointerleave', pttUp);
    ready.addEventListener('click', () => { G.setReady(!G.ready); draw(); });
    msg.addEventListener('click', () => { msg.hidden = true; grbar.hidden = true; G.markRead(); });
    // (the pop-out has its own focus: the hotkey works there too)
    w.addEventListener('keydown', onKeyDown, true); w.addEventListener('keyup', onKeyUp, true); w.addEventListener('blur', onBlur);
    w.addEventListener('pagehide', () => { pip = null; draw(); });
    pip = { w, mute, st, ready, msg };
    draw();
  } catch (e) { G.status = `Couldn’t open the pop-out: ${(e as Error).message}`; draw(); }
});
function grDraw() {
  const g = G.green, joined = G.role === 'guest' && /✔/.test(G.status), host = G.hostName || t.hn || 'the host';
  const knows = joined && g.known;
  grcard.hidden = !knows;
  if (knows) {
    grcard.className = `grcard panel${g.wait ? '' : ' on'}`;
    const badge = mk('div', { className: 'badge-ico' });
    badge.innerHTML = g.wait ? ICON_WAVE : ICON_AIR;
    grcard.replaceChildren(mk('div', { className: 'row' }, badge, mk('div', {},
      // (clarity: this page can't know whether the host is streaming: say who sees you for sure, and when viewers do)
      mk('h2', { textContent: g.wait ? `You’re in ${host}’s green room` : `You’re on ${host}’s show` }),
      mk('p', { className: 'note', style: 'margin:0', textContent: g.wait
        ? `You’re not on stream yet. ${host} can see your camera and mic level to check them. ${g.talk ? `Backstage voice is on: you and ${host} can talk (only you two).` : 'You won’t hear the show while you wait; messages appear at the top.'} Press “I’m ready” when you are.`
        : G.hostMod.cam || G.hostMod.mic ? `You’re on ${host}’s show. ${host} turned something off for now (see above).`
        : `${host} can see${G.voice ? ' and hear' : ''} you now${G.voice && G.muted ? ' — your mic is MUTED' : ''}. If ${host} is streaming, viewers can too. Have fun!` }))));
  }
  readyRow.hidden = !knows;
  readyBtn.hidden = !g.wait;
  readyBtn.className = G.ready ? 'btn on' : 'btn';
  readyBtn.textContent = G.ready ? '✔ Ready — tap to take it back' : '✋ I’m ready';
  readyBtn.setAttribute('aria-pressed', String(G.ready));
  grNote.hidden = !(joined && !g.known);
  grNote.textContent = `${host}’s VTube Pro doesn’t have the green room yet (no messages / “I’m ready”).`;
  grhist.hidden = !g.msgs.length;
  (grhist.firstElementChild as HTMLElement).textContent = `Messages from the host (${g.msgs.length})`;
  grList.replaceChildren(...g.msgs.slice().reverse().map((m) => mk('li', {}, m.text, mk('time', { textContent: new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }))));
  // moderation: the host's decision (camera hidden / muted) — a card that says it plainly, my preview marked, unmute locked
  const hm = G.hostMod, modOn = joined && (hm.cam || hm.mic);
  modcard.hidden = !modOn;
  if (modOn) {
    const k = `${hm.cam}|${hm.mic}|${host}`;
    if (modcard.dataset.k !== k) {
      modcard.dataset.k = k;
      const b = mk('div', { className: 'badge-ico err' }); b.innerHTML = hm.cam ? ICONS.camoff : ICON_MICOFF;
      modcard.replaceChildren(mk('div', { className: 'row' }, b, mk('div', {},
        mk('h2', { textContent: hm.cam && hm.mic ? 'Your camera and mic are off' : hm.cam ? 'Your camera is off the show' : 'You’re muted by the host' }),
        mk('p', { className: 'note', style: 'margin:0', textContent: modStatus(hm, host) }))));
    }
  }
  hidTag.hidden = !(joined && hm.cam);
  if (joined && hm.cam && !hidTag.childElementCount) hidTag.replaceChildren(mk('b', { textContent: 'Hidden from the show' }), mk('span', { textContent: 'Viewers see a “Camera off” card' }));
  document.querySelector('.stage')?.classList.toggle('modhid', joined && hm.cam);
  // mute
  muteBox.hidden = !G.voice;
  const locked = hm.mic;
  muteBtn.className = locked ? 'btn muted locked' : G.muted ? 'btn muted' : 'btn';
  muteBtn.disabled = locked;
  muteBtn.textContent = locked ? '🔒 Muted by the host' : ptt ? (G.muted ? `🔇 Hold to talk (${comboLabel(combo)})` : '🎙 Talking…') : G.muted ? '🔇 Unmute — you’re muted' : '🎙 Mute';
  muteBtn.setAttribute('aria-pressed', String(G.muted));
  mutedTag.hidden = !(G.voice && G.muted);
  mutedTag.textContent = locked ? '🔒 MUTED BY HOST' : '🔇 MUTED';
  keyLbl.textContent = capturing ? 'press keys…' : comboLabel(combo);
  setKey.textContent = capturing ? 'Cancel (Esc)' : 'Set hotkey';
  pipBtn.hidden = !dpip;
  pipBtn.textContent = pip ? 'Close the pop-out' : '⧉ Pop out a mute button (stays on top)';
  keyNote.textContent = `${capturing ? 'Press the key or combo you want (e.g. M, or Ctrl+Shift+M). Esc cancels. ' : ''}A browser tab only hears your hotkey while it’s focused (in front and clicked into)${comboTypes(combo) ? ', and not while you type in a box here' : ''}. `
    + (dpip ? 'To mute while you’re in another app, use the pop-out: it stays on top of every window (click it, then the hotkey works there too).' : 'This browser can’t keep a button on top: keep this tab in front, or mute in your mic / headset.');
  if (pip) {
    pip.mute.className = G.muted ? 'muted' : '';
    pip.mute.disabled = hm.mic;
    pip.mute.textContent = hm.mic ? '🔒 Muted by the host' : ptt ? (G.muted ? '🔇 Hold to talk' : '🎙 Talking…') : G.muted ? '🔇 MUTED — tap to unmute' : '🎙 Mute';
    pip.st.textContent = G.role !== 'guest' ? 'Not connected' : g.known ? (g.wait ? `Green room · ${host}` : `ON the show · ${host}`) : `${host}’s show`;
    pip.ready.hidden = !knows;
    pip.ready.className = G.ready ? 'on' : '';
    pip.ready.textContent = G.ready ? '✔ Ready' : '✋ I’m ready';
  }
}
async function inviteTicket(): Promise<string> {
  const name = (($('name') as HTMLInputElement).value || '').trim();
  const r = await fetch('/g/ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inv: invTok, name, gk }) });
  const b = (await r.json().catch(() => ({}))) as { ticket?: string; error?: string };
  if (!r.ok || !b.ticket) throw new Error(b.error ?? `relay ${r.status}`);
  return b.ticket;
}
async function joinNow() {
  G.unlockAudio();
  const tk = INVITE ? await inviteTicket() : ticket;
  await G.join(relay, tk);
}

function opt(sel: HTMLSelectElement, list: [string, string][], value: string) {
  sel.replaceChildren(...list.map(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; o.selected = v === value; return o; }));
}

let bridges: string[] = [];
async function fillDevices() {
  const cams = await listCameras(), mics = await listMics();
  bridges = cams.filter((c) => c.bridge).map((c) => c.label);
  // Spout2 (via a bridge): pick SpoutCam / OBS Virtual Camera by itself when nothing was chosen yet (labels only)
  const s = G.source.settings;
  if (s.via === 'bridge' && !cams.some((c) => c.id === s.deviceId && c.bridge)) { const b = cams.find((c) => c.bridge); if (b) G.source.update({ deviceId: b.id }); }
  opt($('cam'), [['', 'Default camera'], ...cams.map((c): [string, string] => [c.id, `${c.bridge ? '🟢 Spout2 bridge: ' : c.virtual ? '🟢 ' : ''}${c.label}`])], G.source.settings.deviceId);
  opt($('mic'), [['', 'Default microphone'], ...mics.map((m): [string, string] => [m.id, m.label]), ['none', 'No microphone']], G.source.settings.mic);
}

// ---------------------------------------------------------------- invite-experience: one clear screen per moment
// body[data-step] = setup (name + camera check + Join) → knock (waiting to be let in) → green (green room) → live → over
// (ended / declined / removed / couldn't connect / link full / link expired). The page CSS (relay/src/guestUi.ts) shows
// only what belongs to the step; this draws the words.
let joinErr = '';   // the last failed Join itself (link full / expired / …): a dead end gets its own friendly screen
const ua = navigator.userAgent;
/** Camera blocked: where to click, for the browser the guest is actually in. */
function permHelp(): string {
  if (/iPhone|iPad|iPod/.test(ua)) return 'Tap <b>aA</b> in the address bar → <b>Website Settings</b> → set <b>Camera</b> and <b>Microphone</b> to <b>Allow</b>. Then tap <b>Try again</b>.';
  if (/Android/.test(ua)) return 'Tap the icon left of the address → <b>Permissions</b> → turn on <b>Camera</b> and <b>Microphone</b>. Then tap <b>Try again</b>.';
  if (/Firefox\//.test(ua)) return 'Click the crossed-out <b>camera</b> icon in the address bar and remove the block. Then click <b>Try again</b>.';
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return 'Menu bar: <b>Safari → Settings for this website</b> → <b>Camera</b> and <b>Microphone</b>: <b>Allow</b>. Then click <b>Try again</b>.';
  return 'Click the <b>camera</b> icon (or the lock) at the left of the address bar → <b>Allow</b>. Then click <b>Try again</b>.';
}
interface Over { icon: string; tone?: string; title: string; text: string; action?: [string, () => void] }
const knockAgain = () => { joinErr = ''; G.status = ''; G.lastFail = ''; void doJoin(); };
function overState(host: string): Over | null {
  if (!INVITE && !ticket) return { icon: 'link', tone: 'warn', title: 'This join link has expired', text: 'Go back to Discord and click Join again. It works right away.' };
  if (joinErr && G.role === 'none') {
    if (/maximum number/i.test(joinErr)) return { icon: 'users', tone: 'warn', title: 'This link is full', text: `Everyone this link was made for has already joined. Ask ${host} to send you a new link.` };
    if (/expired/i.test(joinErr)) return { icon: 'clock', title: 'This invite link has expired', text: `The show may have ended, or ${host} made a new link. Ask them for a fresh one.` };
  }
  if (G.role !== 'none') return null;
  const st = G.status;
  if (/ended the party|party has ended/i.test(st)) return { icon: 'ended', title: 'That’s a wrap!', text: `${host}’s show has ended. Thanks for joining! You can close this tab.` };
  if (/declined/i.test(st)) return { icon: 'door', tone: 'warn', title: `${host} didn’t let you in this time`, text: 'They may be busy right now. You can knock again in a moment.', action: ['Knock again', knockAgain] };
  if (/removed you/i.test(st)) return { icon: 'door', title: 'You’ve left the show', text: `${host} moved you out of the show. Thanks for stopping by!` };
  if (G.lastFail === 'ice' && !wantIn && !retryAt) return { icon: 'wifi', tone: 'warn', title: 'We couldn’t connect you', text: st, action: ['Try again', knockAgain] };
  return null;
}
const card = (iconHtml: string, tone: string, title: string, text: string, action?: [string, () => void], extra: Node[] = []) => {
  const b = mk('div', { className: `badge-ico ${tone}` }); b.innerHTML = iconHtml;
  const kids: Node[] = [b, mk('h2', { textContent: title }), mk('p', { className: 'note', textContent: text }), ...extra];
  if (action) { const btn = mk('button', { type: 'button', className: 'btn', textContent: action[0] }); btn.addEventListener('click', action[1]); kids.push(mk('div', { className: 'btns' }, btn)); }
  return kids;
};
let lastKey = '';
function stateDraw(step: string, host: string, over: Over | null, live: boolean) {
  const reconnecting = retryAt > Date.now();
  let key = '', kids: Node[] = [];
  if (over) { key = `over:${over.title}:${over.text}`; kids = card(ICONS[over.icon] ?? ICONS.door, over.tone ?? '', over.title, over.text, over.action); }
  else if (step === 'knock') {
    const spin = mk('div', { className: 'spin' }); spin.innerHTML = ICONS.door;
    const detail = reconnecting ? `${G.lastFail === 'ice' ? G.status : 'The connection dropped.'} Trying again in ${Math.ceil((retryAt - Date.now()) / 1000)} s…`
      : /isn’t connected|dropped off/.test(G.status) ? G.status : /let you in —/.test(G.status) ? `${host} let you in. Connecting…` : `${host} will let you in in a moment. Keep this tab open.`;
    key = `knock:${detail}`;
    kids = [spin, mk('h2', { textContent: reconnecting ? 'Reconnecting…' : /let you in —/.test(G.status) ? 'You’re in! Connecting…' : `Knocking on ${host}’s door…` }), mk('p', { className: 'note', textContent: detail })];
  } else if (live && !G.green.known) {
    key = `live:${G.voice}:${G.hearingHost}`;
    kids = card(ICON_AIR, '', `You’re on ${host}’s show`, G.voice ? (G.hearingHost ? `You and ${host} can hear each other here.` : `${host} can hear you.`) : 'Talk in Discord as usual.');
  }
  stateCard.hidden = !kids.length;
  if (key !== lastKey) { lastKey = key; stateCard.replaceChildren(...kids); }
}

function draw() {
  const s = G.source.settings;
  const host = G.hostName || t.hn || 'the host';
  const live = G.role === 'guest' && /✔/.test(G.status);
  if (live) { iceFails = 0; retryN = 0; joinErr = ''; }
  const over = overState(host);
  const step = over ? 'over' : live ? (G.green.known && G.green.wait ? 'green' : 'live') : G.role === 'guest' || retryAt > Date.now() ? 'knock' : 'setup';
  document.body.dataset.step = step;
  const camOn = G.source.live, camErr = G.source.error;
  const named = !INVITE || !!(($('name') as HTMLInputElement).value || '').trim();
  $('who').textContent = INVITE ? `Type your name, check your camera, and ${host} lets you in. It takes about a minute.`
    : t.hn ? `Signed in${t.n ? ` as ${t.n}` : ''}. Check your camera, then join ${t.hn}’s party.` : '';
  // progress: Name → Camera check → Join
  const steps: [string, boolean][] = [...(INVITE ? [['Your name', named] as [string, boolean]] : []), ['Camera check', camOn], ['Join', false]];
  const cur = steps.findIndex(([, d]) => !d);
  $('progress').replaceChildren(...steps.map(([l, d], i) => mk('li', { className: d ? 'done' : i === cur ? 'on' : '', textContent: l })));
  // the stage: camera off / blocked / busy says what to do, right where the picture would be
  const off = $('camoff');
  off.hidden = camOn;
  if (!camOn) {
    const blocked = /denied|permission/i.test(camErr), busy = /busy/i.test(camErr), none = /No camera/i.test(camErr);
    const k = `${camErr}|${cardOn}`;
    if (off.dataset.k !== k) {
      off.dataset.k = k;
      off.className = camErr ? 'off bad' : 'off';
      const ico = mk('span'); ico.innerHTML = camErr ? ICONS.camoff : ICONS.cam;
      const help = mk('p', { className: camErr ? 'permhelp' : 'note' });
      if (blocked) help.innerHTML = permHelp(); else help.textContent = camErr ? (busy ? 'Close Discord, Zoom or OBS if they’re using your camera, then try again.' : none ? 'Plug one in and try again, or join with a name card instead.' : camErr) : 'Your browser will ask to use your camera and microphone. Tap Allow.';
      off.replaceChildren(ico.firstElementChild ?? ico, mk('b', { textContent: blocked ? 'Your camera is blocked' : busy ? 'Your camera is busy' : none ? 'No camera found' : camErr ? 'Your camera didn’t start' : 'Your camera will show up here' }), help);
    }
  }
  $('michint').hidden = !camOn || G.source.settings.mic === 'none';
  // one big button at a time: Turn on my camera → Join the show
  const start = $('start') as HTMLButtonElement, join = $('join') as HTMLButtonElement;
  start.hidden = camOn && !cardOn;
  start.className = cardOn ? 'btn secondary' : 'btn';
  start.lastChild!.textContent = cardOn ? 'Use my camera instead' : camErr ? 'Try again' : 'Turn on my camera';
  join.hidden = !camOn;
  join.disabled = (!INVITE && !ticket) || G.role === 'guest' || !camOn || !named;
  join.textContent = G.role === 'guest' ? (live ? 'Joined ✔' : 'Joining…') : INVITE ? 'Join the show' : `Join as a ${s.look === 'tv' ? 'walking TV' : s.look === 'standee' ? 'model standing in the room' : 'projector screen'}`;
  $('joinhint').textContent = camOn ? (named ? `${host} gets a knock and lets you in.` : 'Type your name above to join.') : '';
  nocam.hidden = camOn || G.role === 'guest';
  (document.querySelector('.devices') as HTMLElement).hidden = !camOn && !cardOn;
  // the status line: only what no card already says
  const st = $('status');
  const camMsg = !!camErr && G.status === camErr;
  st.className = /failed|declined|removed|ended|Couldn’t|expired|denied|lost/i.test(G.status) ? 'bad' : '';
  st.textContent = step === 'setup' && !camMsg ? (/You left the party/.test(G.status) ? 'You left the show. Join again whenever you like.' : G.status) : '';
  if (G.voiceError && !(/denied|permission/i.test(camErr) && /permission/i.test(G.voiceError))) { st.className = 'bad'; st.textContent = G.voiceError + (G.hearHost ? ` (you can still hear ${host})` : ''); }
  stateDraw(step, host, over, live);
  hear.hidden = !G.earBlocked;
  hear.textContent = `🔊 Tap to hear ${host}`;
  ($('voice') as HTMLInputElement).checked = G.voice || G.hearHost;
  ($('leave') as HTMLButtonElement).hidden = G.role !== 'guest';
  $('leave').textContent = step === 'knock' ? 'Cancel' : 'Leave the show';
  $('vtsbox').style.display = s.kind === 'vts' ? '' : 'none';
  $('vtsnote').style.display = s.via ? 'none' : '';
  $('spoutbox').style.display = s.via ? '' : 'none';
  if (s.via) {
    const A = SPOUT_APPS.find((a) => a.id === ($('spoutapp') as HTMLSelectElement).value) ?? SPOUT_APPS[0];
    $('spoutfound').textContent = bridges.length ? `Found: ${bridges.join(', ')} — pick it as your camera above.` : 'No SpoutCam or OBS Virtual Camera found yet (step 2). Allow the camera once, then this list fills in.';
    $('spoutfound').className = bridges.length ? 'note' : 'note warn';
    const li = (t: string) => { const e = document.createElement('li'); e.textContent = t; return e; };
    $('spoutsteps').replaceChildren(
      li(`In ${A.name}: ${A.colour}. Turn its Spout2 output on (transparency doesn’t matter here).`),
      li('Install SpoutCam (free, from the official Spout project: github.com/leadedge/SpoutCam) → SpoutCamSettings → pick your app’s sender → Register. Or in OBS: add the Spout2 source, then Start Virtual Camera.'),
      li('Pick “SpoutCam” / “OBS Virtual Camera” as your camera above, keep Key out on Green (Magenta if your model is green), and Join.'));
  }
  $('skinrow').style.display = s.look === 'tv' ? '' : 'none';
  const v = $('preview') as HTMLVideoElement;
  if (v.srcObject !== G.source.out) v.srcObject = G.source.out;
  v.style.transform = s.mirror ? 'scaleX(-1)' : '';
  $('members').textContent = live && G.members.length ? `On the show: ${G.members.map((m) => m.name + (m.tv ? ' 📺' : '')).join(', ')}` : '';
  grDraw();
}
async function doJoin() {
  ($('join') as HTMLButtonElement).disabled = true;
  wantIn = true; retryN = 0; iceFails = 0; joinErr = '';
  try { await joinNow(); } catch (e) { joinErr = (e as Error).message; G.status = `Couldn’t join: ${joinErr}`; draw(); }
}
G.onChange = draw;

function init() {
  const s = G.source.settings;
  // the browser page defaults to the projector screen (no TV body to pick — the simplest way in)
  if (!localStorage.getItem('vtp.tv.lookChosen')) G.source.update({ look: 'projector' });
  const looks = (): [string, string][] => [['projector', '📽 Projector screen (beside the host)'], ['tv', '🚶 Walking TV'], ...(G.source.settings.via ? [['standee', '🧍 My model standing in the room (cut out by the key)'] as [string, string]] : [])];
  opt($('look'), looks(), G.source.settings.look);
  opt($('kind'), [['webcam', 'My webcam'], ['vts', 'VTube Studio (VTubeStudioCam or a window)'], ['spout', 'A Spout2 model: VSeeFace / VTube Studio / Warudo… (SpoutCam or OBS Virtual Camera)']], s.via ? 'spout' : s.kind);
  opt($('spoutapp'), SPOUT_APPS.map((a): [string, string] => [a.id, a.id === 'other' ? 'Another app' : a.name]), 'vseeface');
  $('spoutapp').addEventListener('change', () => { G.source.update({ spout: { ...G.source.settings.spout, app: SPOUT_APPS.find((a) => a.id === ($('spoutapp') as HTMLSelectElement).value)?.name ?? '' } }); draw(); });
  const toSpout = () => {
    // one click: a keyed model standing in the room, the bridge camera picked, the key matched to a pure-green background
    G.source.update({ kind: 'vts', via: 'bridge', input: 'camera', chroma: { ...SPOUT_BRIDGE_KEY.green }, look: 'standee', height: 1.6, mirror: false, spout: { ...G.source.settings.spout, app: 'VSeeFace' } });
    opt($('look'), looks(), 'standee'); opt($('kind'), [['webcam', 'My webcam'], ['vts', 'VTube Studio (VTubeStudioCam or a window)'], ['spout', 'A Spout2 model: VSeeFace / VTube Studio / Warudo… (SpoutCam or OBS Virtual Camera)']], 'spout');
    opt($('key'), [['green', 'Green'], ['magenta', 'Magenta'], ['blue', 'Blue'], ['off', 'Off']], 'green');
    ($('more') as HTMLDetailsElement).open = true;
    void fillDevices().then(() => { if (G.source.live) void start(); draw(); });
  };
  $('spoutbtn').addEventListener('click', toSpout);
  opt($('skin'), TV_SKINS.map((k): [string, string] => [k.id, k.name]), s.skin);
  opt($('preset'), TV_PRESETS.map((p): [string, string] => [p.id, p.name]), s.preset);
  opt($('key'), [['green', 'Green'], ['magenta', 'Magenta'], ['blue', 'Blue'], ['off', 'Off']], s.chroma ? (s.chroma.color[0] > 0.5 && s.chroma.color[2] > 0.5 ? 'magenta' : s.chroma.color[2] > 0.5 ? 'blue' : 'green') : 'off');
  ($('mirror') as HTMLInputElement).checked = s.mirror;
  ($('zoom') as HTMLInputElement).value = String(s.crop.zoom);
  const on = (id: string, ev: string, fn: (el: HTMLInputElement) => void) => $(id).addEventListener(ev, (e) => fn(e.target as HTMLInputElement));
  on('kind', 'change', (el) => { if (el.value === 'spout') { toSpout(); return; } G.source.update({ kind: el.value as 'webcam' | 'vts', via: '', ...(G.source.settings.look === 'standee' ? { look: 'projector' as const } : {}), ...(el.value === 'vts' ? { chroma: { ...CHROMA_PRESETS.green } } : { chroma: null }) }); opt($('look'), looks(), G.source.settings.look); draw(); });
  on('skin', 'change', (el) => G.source.update({ skin: el.value }));
  on('look', 'change', (el) => { try { localStorage.setItem('vtp.tv.lookChosen', '1'); } catch { /* */ } G.source.update({ look: el.value === 'tv' ? 'tv' : el.value === 'standee' ? 'standee' : 'projector' }); draw(); });
  on('preset', 'change', (el) => G.source.update({ preset: el.value }));
  on('cam', 'change', (el) => { G.source.update({ input: 'camera', deviceId: el.value }); if (!G.source.live) void start(); });
  on('mic', 'change', (el) => { G.source.update({ mic: el.value }); if (G.voice) void G.setVoice(el.value !== 'none'); });
  on('voice', 'change', (el) => void G.setVoice(el.checked));
  on('name', 'input', (el) => { store('vtp.gl.name', el.value); if (cardOn && G.role !== 'guest') G.source.startCard(myName()); draw(); });
  ($('name') as HTMLInputElement).value = INVITE ? store('vtp.gl.name').slice(0, 32) : '';
  on('mirror', 'change', (el) => G.source.update({ mirror: el.checked }));
  // (a Spout2 bridge uses the softer bridge preset: webcam driver + codec edges)
  on('key', 'change', (el) => G.source.update({ chroma: el.value === 'off' ? null : { ...(G.source.settings.via ? SPOUT_BRIDGE_KEY : CHROMA_PRESETS)[el.value as 'green' | 'blue' | 'magenta'] } }));
  on('zoom', 'input', (el) => G.source.update({ crop: { ...G.source.settings.crop, zoom: Number(el.value) } }));
  $('start').addEventListener('click', () => void start());
  nocam.addEventListener('click', () => { cardOn = true; G.source.startCard(myName()); void fillDevices(); draw(); });
  hear.addEventListener('click', () => { G.unlockAudio(); draw(); });
  $('window').addEventListener('click', () => void start('window'));
  $('join').addEventListener('click', () => void doJoin());
  // Enter in the name box = Join (when the camera is ready)
  $('name').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' && !($('join') as HTMLButtonElement).disabled && !$('join').hidden) { e.preventDefault(); void doJoin(); } });
  $('leave').addEventListener('click', () => { wantIn = false; clearTimeout(retryT); retryAt = 0; G.leave(); });
  // reconnect on a dropped connection: the no-sign-in link can mint a new ticket (the host lets a returning guest straight
  // back in); a Discord ticket works once, so that guest clicks Join in Discord again
  G.onLost = () => {
    if (!wantIn) return;
    if (!INVITE) { G.status = G.lastFail === 'ice' ? `${G.status} Then click Join in Discord again.` : 'Connection lost — click Join in Discord again to come back.'; draw(); return; }
    // never connected twice in a row: retrying won't help (and every retry knocks on the host's room again)
    if (G.lastFail === 'ice' && ++iceFails >= 2) { wantIn = false; retryAt = 0; clearTimeout(retryT); draw(); return; }
    const wait = Math.min(30, 2 ** Math.min(5, ++retryN)) * 1000;
    retryAt = Date.now() + wait;
    clearTimeout(retryT);
    retryT = window.setTimeout(async () => { retryAt = 0; if (!wantIn || G.role === 'guest') return; try { await joinNow(); } catch (e) { G.status = `Couldn’t rejoin: ${(e as Error).message}`; G.onLost?.(''); } draw(); }, wait);
    draw();
  };
  // the mic meter + the reconnect countdown
  const meter = $('meter');
  const tick = () => { meter.style.width = `${Math.round(Math.min(1, G.micLevel() * 1.4) * 100)}%`; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => { if (retryAt) draw(); }, 1000);
  draw();
}
async function start(input: 'camera' | 'window' = 'camera') {
  cardOn = false;
  G.source.update({ input });
  await G.source.start();
  if (G.source.error) G.status = G.source.error;
  await fillDevices();
  draw();
}
init();
// no-sign-in link guests aren't in Discord voice: voice over the link starts ON (they can switch it off)
if (INVITE) void G.setVoice(true);
// one click: the camera opens right away (the browser asks once); pick another camera from the list if needed, then Join
void (ticket || INVITE ? start() : fillDevices());
