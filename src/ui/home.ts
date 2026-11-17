// Home (premium UX pass): the first thing the studio shows. A headline that says, in one sentence, what stands between
// you and going live (and a button that does exactly that), a tally board with six live status lamps — camera
// tracking, microphone, OBS, room, party, chat — each with its own one-click fix, big shortcuts to the things people
// use most, the first-time checklist until it is done, and a tip. Status updates in place (bits.ts live(), 350 ms), so
// the view never re-renders while you look at it. Nothing here starts, switches or saves anything by itself.
import type { App } from '../app.ts';
import { api } from '../api.ts';
import { h, toast } from './dom.ts';
import { icon } from './icons.ts';
import { add, live, observerNote } from './bits.ts';
import { OBS_URL, copyText, micLevel, startCamera, startMic } from './liveOps.ts';
import { openChatHub } from './chatPanel.ts';
import { wizardStatus } from './wizards.ts';
import { pollObs, type Nav } from './simple.ts';
import { openInvite } from './guestLink.ts';
import { stageModeDef, stageModeList } from '../scene/stage/registry.ts';
import { isClassic } from './layoutMode.ts';
import { openTray, trayUnread } from './notifyTray.ts';
import { toolItems } from './toolsMenu.ts';
import { isPhone } from '../mobile/device.ts';

/** Copy the OBS link. */
function copyObsLink() {
  copyText(OBS_URL, 'OBS link copied');
}

type Lamp = 'on' | 'wait' | 'off' | 'err';
interface Act { label: string; run(): void; primary?: boolean; /** guestlink: a second button on the card */ more?: Act; /** guest browser source: a third button (the Party tile) */ also?: Act }
/** UX redesign: a row of small choice buttons on a tile (the Show mode tile: Talk · React · Gaming …). */
interface Choice { id: string; label: string; on: boolean; disabled: boolean; title: string; run(): void }
interface Tally { id: string; label: string; icon: string; read(): { s: Lamp; text: string; detail: string; act: Act | null; choices?: Choice[] } }

const PLATFORM: Record<string, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', rumble: 'Rumble', tiktok: 'TikTok' };
const TIPS: [string, string][] = [
  ['Press G, then a letter', 'G then R opens Room, G then S opens Show & layout, G then H comes back here. Press ? for the full list.'],
  ['Hide the menus for a clean capture', 'Press H and only your avatar is left in this window. Press H or Esc to bring the menus back.'],
  ['Good light beats a better camera', 'A lamp behind your screen, pointing at your face, makes tracking steadier than any setting.'],
  ['Outfits on a key', 'Ctrl+1 to Ctrl+9 put on your outfits; Ctrl+0 goes back to the default look.'],
  ['Change the mood in one key', 'Shift+1 to Shift+5 switch the room lights: Preshow, Show, React, BRB and Outro.'],
  ['Find any setting', 'Ctrl+K searches every area, including Advanced settings, and jumps straight to it.'],
  ['Your chat on a second screen', 'Chat Hub puts every platform’s chat, donations and alerts in one big window.'],
  ['Friends need nothing to set up', 'Only the host sets up Discord once. Guests click Join and their avatar shows in your room.'],
];
let tipIx = Math.floor(Date.now() / 864e5) % TIPS.length;
let booted = false;

function tallies(app: App, nav: Nav): Tally[] {
  const S = app.scene;
  return [
    { id: 'track', label: 'Face tracking', icon: 'track', read: () => {
      const s = app.stats;
      if (!app.trackingOn) return { s: 'off', text: 'Camera off', detail: 'Your avatar is holding still.', act: app.observer ? { label: 'Open Tracking', run: () => nav.go('live') } : { label: 'Turn on camera', run: () => { void startCamera(app); }, primary: true } };
      if (!s.tracked) return { s: 'wait', text: 'Looking for you', detail: 'Face the camera. More light on your face helps.', act: { label: 'Check lighting', run: () => nav.wizard('firstRun', 'light') } };
      return { s: 'on', text: 'Tracking you', detail: `${Math.round(s.trackFps ?? 0)} updates/s · ${Math.round(s.latencyMs ?? s.inferMs)} ms delay`, act: null };
    } },
    { id: 'mic', label: 'Microphone', icon: 'mic', read: () => app.audio.active
      ? { s: 'on', text: 'Listening', detail: app.audio.deviceLabel || 'Lip sync follows your voice.', act: null }
      : { s: 'off', text: 'Mic off', detail: 'Optional: the mouth also follows your voice.', act: app.observer ? null : { label: 'Turn on mic', run: () => { void startMic(app); } } } },
    { id: 'obs', label: 'OBS', icon: 'stream', read: () => {
      const n = pollObs();
      // (clarity: "In OBS" is not "live": you go live with Start Streaming in OBS)
      return n > 0 ? { s: 'on', text: 'In OBS', detail: 'OBS is showing VTube Pro. You go live with Start Streaming in OBS.', act: null }
        : { s: 'off', text: 'Not in OBS yet', detail: 'One click adds VTube Pro to OBS, the free app you stream with.', act: { label: 'Add to OBS', run: () => void import('./obsWizard.ts').then((m) => m.openObsWizard()) } }; // autopilot: one click (src/ui/autopilot/obsOneClick.ts)
    } },
    { id: 'room', label: 'Room', icon: 'room', read: () => {
      const sid = S.effective.sceneId;
      const name = sid ? S.scenes.find((x) => x.id === sid)?.name ?? sid : '';
      return sid ? { s: 'on', text: name, detail: S.effective.mode === 'react' ? 'React mode: the big screen is down.' : 'Your avatar is in a 3D room.', act: { label: 'Change', run: () => nav.go('room') } }
        : { s: 'off', text: 'No room', detail: 'Just your avatar on a see-through background.', act: { label: 'Pick a room', run: () => nav.go('room') } };
    } },
    { id: 'party', label: 'Party', icon: 'friends', read: () => {
      const P = app.party;
      const guestLink: Act = { label: '✉ Invite a guest', run: () => void openInvite(app) };
      // being the guest on a show that does not use VTube Pro (the card in Party, src/ui/guestFeedCard.ts); Home itself asks the helper for nothing
      const beGuest: Act | undefined = app.observer ? undefined : { label: 'Guest on another show', run: () => nav.advanced('friends', 'party') };
      if (P.role === 'host') return { s: 'on', text: `Hosting · ${P.remotes.size} guest${P.remotes.size === 1 ? '' : 's'}`, detail: 'Every OBS in the party shows the whole room.', act: { label: 'Manage', run: () => nav.go('friends'), more: P.via === 'discord' ? guestLink : undefined, also: beGuest } };
      if (P.role === 'guest') return { s: 'on', text: `With ${P.hostInfo?.name ?? 'a friend'}`, detail: 'The host runs the room.', act: { label: 'Manage', run: () => nav.go('friends'), also: beGuest } };
      return { s: 'off', text: 'Solo', detail: 'Up to 8 friends in one room, or send a guest a link. Your guest installs nothing.', act: { label: 'Invite friends', run: () => nav.go('friends'), more: app.observer ? undefined : guestLink, also: beGuest } };
    } },
    { id: 'chat', label: 'Chat', icon: 'chat', read: () => {
      const cs = S.chat.status;
      const on = cs ? Object.entries(cs.platforms).filter(([, p]) => p?.enabled) : [];
      const liveP = on.filter(([, p]) => p?.state === 'live').map(([k]) => PLATFORM[k] ?? k);
      if (!on.length) return { s: 'off', text: 'Not connected', detail: 'Show chat and donation alerts in your room.', act: { label: 'Set up chat', run: () => nav.wizard('chat') } };
      if (!liveP.length) return { s: 'wait', text: 'Waiting', detail: `${on.map(([k]) => PLATFORM[k] ?? k).join(', ')}: connects when you go live.`, act: { label: 'Chat Hub', run: () => openChatHub() } };
      return { s: 'on', text: liveP.join(', '), detail: 'Chat and alerts are coming in.', act: { label: 'Chat Hub', run: () => openChatHub() } };
    } },
  ];
}

/** UX redesign (new layout only): three more tiles after the six lamps - your avatar, the show mode (switch it right here;
 *  testers asked to "keep show modes visible") and the notification tray. */
function moreTallies(app: App, nav: Nav): Tally[] {
  const S = app.scene;
  return [
    { id: 'avatar', label: 'Avatar', icon: 'me', read: () => {
      const p = app.profile;
      if (!p) return { s: 'off', text: 'No avatar yet', detail: 'Pick one of ours or bring your own model.', act: { label: 'Choose an avatar', run: () => nav.go('me'), primary: true } };
      const outfit = p.costume ? p.costumes.find((c) => c.id === p.costume)?.name ?? 'an outfit' : 'the default look';
      return { s: 'on', text: p.name, detail: `Wearing ${outfit}.`, act: { label: 'Change', run: () => nav.go('me') } };
    } },
    { id: 'mode', label: 'Show mode', icon: 'show', read: () => {
      const room = !!S.effective.sceneId, cur = stageModeDef(S.effective.mode);
      const choices: Choice[] = stageModeList().map((m) => ({ id: m.id, label: `${m.icon} ${m.label}`, on: S.effective.mode === m.id, disabled: !room || !S.canEdit,
        title: `${m.hint ?? m.label}${m.key ? ` (Shift+${m.key})` : ''}`, run: () => { S.setMode(m.id); toast(`${m.icon} ${m.label}`, 'ok', 1100); } }));
      if (!room) return { s: 'off', text: cur?.label ?? 'Talk', detail: 'Show modes work inside a room.', act: { label: 'Pick a room', run: () => nav.go('room') }, choices };
      return { s: 'on', text: cur?.label ?? String(S.effective.mode), detail: 'Switch it here, or set the layout in Show.', act: { label: 'Layout', run: () => nav.go('show') }, choices };
    } },
    { id: 'notes', label: 'Notifications', icon: 'bell', read: () => {
      const n = trayUnread();
      return n ? { s: 'wait', text: `${n} new`, detail: 'Updates, guests knocking and messages.', act: { label: 'Open', run: () => openTray(), primary: true } }
        : { s: 'on', text: 'All read', detail: 'Updates, guests knocking and messages collect under the bell.', act: { label: 'Open', run: () => openTray() } };
    } },
  ];
}

/** The one thing to do next (drives the headline and the big button). */
function nextStep(app: App, nav: Nav): { title: string; line: string; act: Act | null } {
  const p = app.profile, name = p?.name ?? 'your avatar';
  if (!p) return { title: 'Pick an avatar to get started.', line: 'Choose one of ours, bring your own VRoid model, or make one with AI.', act: { label: 'Choose an avatar', run: () => nav.go('me') } };
  if (!app.trackingOn) return { title: `Turn on your camera to wake ${name}.`, line: 'Any webcam works. Your camera only moves your avatar: viewers see your avatar, not your camera picture.', act: app.observer ? { label: 'Open Tracking', run: () => nav.go('live') } : { label: 'Turn on camera', run: () => { void startCamera(app); } } };
  if (!app.stats.tracked) return { title: `${name} is looking for you.`, line: 'Sit in front of the camera with light on your face.', act: { label: 'Check my lighting', run: () => nav.wizard('firstRun', 'light') } };
  // a phone streams by sharing its screen: Pro2D show mode, not OBS (src/mobile/showMode.ts)
  if (isPhone()) return { title: 'You’re ready to go live.', line: 'Go live puts your avatar on the whole screen. Then share your screen in TikTok, YouTube or Twitch.', act: { label: 'Go live', run: () => { void import('../mobile/showMode.ts').then((m) => m.openShowMode(app)); } } };
  // (clarity: adding a Browser Source doesn't make anyone live; Start Streaming in OBS does)
  if (pollObs() === 0) return { title: 'Next: add VTube Pro to OBS.', line: 'One Browser Source with this link. Then press Start Streaming in OBS to go live.', act: { label: 'Copy the OBS link', run: copyObsLink } };
  return { title: 'You’re ready to go live.', line: 'Press Start Streaming in OBS when you’re ready. Everything below updates live.', act: { label: 'Show & layout', run: () => nav.go('show') } };
}

export function homeView(app: App, el: HTMLElement, nav: Nav) {
  add(el, observerNote(app) ?? '');
  const root = h('div', { class: `hm${booted ? '' : ' boot'}` });
  booted = true;
  el.append(root);

  // ---------------------------------------------------------------- headline
  const portrait = h('button', { class: 'hm-portrait', title: 'Change your avatar', 'aria-label': 'Change your avatar', onClick: () => nav.go('me') });
  const who = h('div', { class: 'hm-who' });
  let avSig = '-';
  const paintAvatar = () => {
    const p = app.profile, sig = p ? `${p.id}|${p.name}|${p.thumbnail ?? ''}` : '';
    if (sig === avSig) return;
    avSig = sig;
    portrait.replaceChildren(p?.thumbnail ? h('img', { src: api.fileUrl(p, p.thumbnail), alt: '' }) : h('span', null, '☺'));
    who.textContent = p ? `Wearing ${p.name}` : 'No avatar yet';
  };
  const title = h('h1', null), line = h('p', { class: 'hm-line' });
  const cta = h('button', { class: 'btn primary hm-cta' });
  const copyBtn = h('button', { class: 'btn hm-copy', title: 'The link you paste into OBS (Sources → + → Browser)', onClick: copyObsLink }, icon('copy', 16), 'Copy OBS link');
  let ctaAct: Act | null = null;
  cta.addEventListener('click', () => ctaAct?.run());
  const paintHead = () => {
    paintAvatar();
    const n = nextStep(app, nav);
    if (title.textContent !== n.title) title.textContent = n.title;
    if (line.textContent !== n.line) line.textContent = n.line;
    ctaAct = n.act;
    const lbl = n.act?.label ?? '';
    if (cta.dataset.l !== lbl) { cta.dataset.l = lbl; cta.replaceChildren(lbl, icon('arrow', 16)); }
    cta.style.display = n.act ? '' : 'none';
  };
  add(root, h('header', { class: 'hm-head' }, portrait,
    h('div', { class: 'hm-words' }, who, title, line,
      h('div', { class: 'hm-ctas' }, cta, copyBtn))));

  // ---------------------------------------------------------------- tally board
  const board = h('div', { class: 'hm-board', role: 'list', 'aria-label': 'Studio status' });
  const cells: { t: Tally; el: HTMLElement; text: HTMLElement; detail: HTMLElement; act: HTMLElement; sig: string; meter?: HTMLElement }[] = [];
  (isClassic() ? tallies(app, nav) : [...tallies(app, nav), ...moreTallies(app, nav)]).forEach((t, i) => {
    const text = h('b'), detail = h('span', { class: 'd' }), act = h('div', { class: 'a' });
    const meter = t.id === 'mic' ? h('i', { class: 'lvl' }) : undefined;
    const cell = h('div', { class: 'hm-cell off', role: 'listitem', style: `--i:${i}` },
      h('div', { class: 'top' }, h('span', { class: 'lamp', 'aria-hidden': 'true' }), h('span', { class: 'lb' }, t.label), icon(t.icon, 16)),
      text, detail, meter ? h('div', { class: 'meter' }, meter) : null, act);
    board.append(cell);
    cells.push({ t, el: cell, text, detail, act, sig: '', meter });
  });
  const paintBoard = () => {
    for (const c of cells) {
      const r = c.t.read();
      const cls = `hm-cell ${r.s}`;
      if (c.el.className.replace(' boot', '') !== cls) c.el.className = cls;
      if (c.text.textContent !== r.text) c.text.textContent = r.text;
      if (c.detail.textContent !== r.detail) c.detail.textContent = r.detail;
      c.el.setAttribute('aria-label', `${c.t.label}: ${r.text}. ${r.detail}`);
      const sig = (r.act ? `${r.act.label}|${r.act.primary ? 1 : 0}|${r.act.more?.label ?? ''}|${r.act.also?.label ?? ''}` : '') + (r.choices ? `#${r.choices.map((x) => `${x.id}:${x.on ? 1 : 0}${x.disabled ? 'd' : ''}`).join(',')}` : '');
      if (sig !== c.sig) {
        c.sig = sig;
        c.act.replaceChildren(
          ...(r.choices?.length ? [h('div', { class: 'hm-modes', role: 'group', 'aria-label': c.t.label }, ...r.choices.map((x) => h('button', { class: `btn hm-mode${x.on ? ' on' : ''}`, disabled: x.disabled, 'aria-pressed': String(x.on), title: x.title, onClick: () => c.t.read().choices?.find((y) => y.id === x.id)?.run() }, x.label)))] : []),
          ...(r.act ? [h('button', { class: `btn ${r.act.primary ? 'primary' : ''}`, onClick: () => c.t.read().act?.run() }, r.act.label)] : []),
          ...(r.act?.more ? [h('button', { class: 'btn', onClick: () => c.t.read().act?.more?.run() }, r.act.more.label)] : []),
          ...(r.act?.also ? [h('button', { class: 'btn', onClick: () => c.t.read().act?.also?.run() }, r.act.also.label)] : []));
      }
      if (c.meter) c.meter.parentElement!.style.visibility = app.audio.active ? '' : 'hidden';
      if (c.meter) c.meter.style.transform = `scaleX(${app.audio.active ? Math.min(1, micLevel(app)).toFixed(2) : 0})`;
    }
  };
  add(root, h('section', { class: 'hm-sec' }, h('h2', null, 'Status'), board));

  // ---------------------------------------------------------------- big shortcuts
  const go = (icn: string, t: string, d: string, run: () => void) => h('button', { class: 'hm-go', onClick: run }, h('span', { class: 'ic' }, icon(icn, 22)), h('span', null, h('b', null, t), h('span', null, d)));
  add(root, h('section', { class: 'hm-sec' }, h('h2', null, 'Jump in'), h('div', { class: 'hm-grid' },
    go('me', 'Avatar & outfits', 'Wear, switch or dress up', () => nav.go('me')),
    go('room', 'Pick a room', 'Where you stream from', () => nav.go('room')),
    go('show', 'Show & layout', 'Talk, React or Gaming', () => nav.go('show')),
    go('chat', 'Chat Hub', 'All chats in one window', () => openChatHub()),
    go('games', 'Games', 'The Trail, tabletop RPG', () => nav.go('games')),
    go('friends', 'Stream together', 'Up to 8 friends', () => nav.go('friends')),
    go('stream', 'OBS & stream', 'Put your avatar in OBS', () => nav.go('stream')),
    go('create', 'Create', 'New avatar, outfit or room', () => nav.go('create')))));
  // UX redesign (new layout only): every tool / helper page in one row, opened inside the studio (src/ui/toolsMenu.ts)
  if (!isClassic()) {
    const tl = toolItems({ shortcuts: () => nav.shortcuts?.() }).map((t) => { const b: HTMLButtonElement = go(t.icon, t.title, t.short, () => t.run(b)); b.dataset.tool = t.id; return b; });
    add(root, h('section', { class: 'hm-sec', 'data-ui': 'home-tools' }, h('h2', null, 'Tools'), h('div', { class: 'hm-grid' }, ...tl)));
  }

  // ---------------------------------------------------------------- first-time checklist (until it is all done)
  const fr = wizardStatus('firstRun');
  const steps: [string, () => boolean, string][] = [
    ['Pick an avatar', () => !!app.profile, 'avatar'], ['Turn on your camera', () => app.trackingOn, 'camera'],
    ['Check your microphone', () => app.audio.active, 'mic'], ['Add VTube Pro to OBS', () => pollObs() > 0, 'obs'],
    ['Choose a room (optional)', () => !!S().effective.sceneId, 'room'],
  ];
  function S() { return app.scene; }
  if (!fr.finished || !steps.every(([, d]) => d())) {
    const list = h('ol', { class: 'hm-steps' });
    const bar = h('i'), count = h('span', { class: 'n' });
    const rows = steps.map(([t, , at]) => { const li = h('li', null, h('span', { class: 'ck', 'aria-hidden': 'true' }, icon('check', 14)), h('button', { class: 'btn link', onClick: () => nav.wizard('firstRun', at) }, t)); list.append(li); return li; });
    const paintSteps = () => {
      let n = 0;
      steps.forEach(([, done], i) => { const d = done(); if (d) n++; rows[i].classList.toggle('done', d); });
      const txt = `${n} of ${steps.length} done`;
      if (count.textContent !== txt) count.textContent = txt;
      bar.style.width = `${Math.round((n / steps.length) * 100)}%`;
    };
    add(root, h('section', { class: 'hm-sec hm-setup' },
      h('div', { class: 'hm-setup-head' }, h('h2', null, 'Finish setting up'), count),
      h('div', { class: 's-meter' }, bar), list,
      h('div', { class: 's-row' }, h('button', { class: 'btn primary', onClick: () => nav.wizard('firstRun') }, fr.started ? 'Continue setup' : 'Start the 5-minute setup'),
        fr.started && fr.stepTitle ? h('span', { class: 'note', style: 'margin:0' }, `Paused at “${fr.stepTitle}”.`) : null)));
    live(() => { if (!list.isConnected) return false; paintSteps(); return true; });
    paintSteps();
  }

  // ---------------------------------------------------------------- tip
  const tipT = h('b'), tipD = h('span');
  const paintTip = () => { const [t, d] = TIPS[tipIx % TIPS.length]; tipT.textContent = t; tipD.textContent = d; };
  add(root, h('aside', { class: 'hm-tip' }, h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('keys', 18)), h('div', null, tipT, tipD),
    h('button', { class: 'btn ghost', onClick: () => { tipIx++; paintTip(); } }, 'Another tip')));
  paintTip();

  paintHead(); paintBoard();
  live(() => { if (!root.isConnected) return false; paintHead(); paintBoard(); return true; });
}

export const HOME_CSS = `
.hm { display: grid; gap: 22px; max-width: 1080px; }
.hm-head { display: grid; grid-template-columns: auto 1fr; gap: 20px; align-items: center; padding: 6px 2px 2px; }
.hm-portrait { width: 112px; height: 112px; border-radius: 26px; overflow: hidden; border: 1px solid var(--line2); background: radial-gradient(circle at 50% 35%, var(--card3), var(--card)); display: grid; place-items: center; font-size: 42px; color: var(--faint); cursor: pointer; padding: 0; transition: border-color var(--dur) var(--ease); }
.hm-portrait:hover { border-color: var(--accent); }
.hm-portrait img { width: 100%; height: 100%; object-fit: cover; }
.hm-who { color: var(--dim); font-size: var(--fs-s); font-weight: 600; }
.hm-head h1 { margin: 2px 0 4px; font: 650 var(--fs-3xl)/1.12 var(--font-display); letter-spacing: -.022em; max-width: 22ch; text-wrap: balance; }
.hm-line { margin: 0; color: var(--dim); font-size: var(--fs-m); line-height: 1.5; max-width: 60ch; }
.hm-ctas { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.hm-cta { min-height: 40px !important; padding: 8px 16px; font-size: var(--fs-l); border-radius: 12px; display: inline-flex; gap: 8px; align-items: center; }
.hm-copy { min-height: 40px !important; display: inline-flex; gap: 7px; align-items: center; border-radius: 12px; }
.hm-sec > h2 { margin: 0 0 10px; font-size: var(--fs-l); font-weight: 650; color: var(--text); }

/* the tally board: a broadcast console strip, dark in both themes */
.hm-board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--console-line); border: 1px solid var(--console-line); border-radius: 16px; overflow: hidden; }
.hm-cell { background: var(--console); color: #e9edf4; padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 3px; min-height: 124px; }
.hm-cell .top { display: flex; align-items: center; gap: 8px; color: #8d96a8; font-size: var(--fs-xs); font-weight: 600; margin-bottom: 6px; }
.hm-cell .top .lb { flex: 1; }
.hm-cell .top svg { opacity: .7; }
.hm-cell .lamp { width: 12px; height: 12px; border-radius: 50%; background: var(--tally-off); box-shadow: inset 0 -2px 3px #0006; transition: background 240ms var(--ease), box-shadow 240ms var(--ease); }
.hm-cell.on .lamp { background: var(--tally-on); box-shadow: 0 0 0 3px #3ddc8424, 0 0 14px #3ddc84aa, inset 0 -2px 3px #0003; }
.hm-cell.wait .lamp { background: var(--tally-wait); box-shadow: 0 0 0 3px #ffb45424, 0 0 12px #ffb45499; }
.hm-cell.err .lamp { background: var(--tally-err); box-shadow: 0 0 0 3px #ff5d5d24, 0 0 12px #ff5d5daa; }
.hm-cell b { font-size: var(--fs-l); font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-cell.off b { color: #b9c0cd; }
.hm-cell .d { color: #8d96a8; font-size: 12px; line-height: 1.4; }
.hm-cell .meter { height: 4px; border-radius: 4px; background: #ffffff14; overflow: hidden; margin-top: 4px; }
.hm-cell .meter .lvl { display: block; height: 100%; background: var(--tally-on); transform-origin: left; transform: scaleX(0); transition: transform 90ms linear; }
.hm-cell .a { margin-top: auto; padding-top: 8px; min-height: 0; }
.hm-cell .a .btn { min-height: 28px; padding: 4px 11px; font-size: 12.5px; background: #ffffff10; color: #e9edf4; border-color: #ffffff22; }
.hm-cell .a .btn:hover { background: #ffffff1c; }
.hm-cell .a .btn.primary { background: var(--tally-on); color: #06210f; border-color: transparent; }
/* UX redesign: the Show mode tile's mode buttons */
.hm-cell .a .hm-modes { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.hm-cell .a .btn.hm-mode { min-height: 26px; padding: 3px 8px; font-size: 12px; }
.hm-cell .a .btn.hm-mode.on { background: #ffffff26; border-color: var(--tally-on); color: #fff; }
.hm-cell .a .btn.hm-mode:disabled { opacity: .45; cursor: not-allowed; }
/* the one orchestrated moment: lamps light up in turn when the studio opens */
.hm.boot .hm-cell .lamp { animation: hm-lamp 520ms var(--ease) both; animation-delay: calc(var(--i) * 90ms + 150ms); }
@keyframes hm-lamp { from { background: var(--tally-off); box-shadow: none; transform: scale(.7); } 60% { transform: scale(1.15); } to { transform: scale(1); } }

.hm-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.hm-go { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; text-align: left; padding: 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: inherit; cursor: pointer; transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease); }
.hm-go:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--card)); }
.hm-go .ic { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
.hm-go b { display: block; font-size: var(--fs-m); font-weight: 650; }
.hm-go span > span { display: block; color: var(--dim); font-size: 12px; margin-top: 2px; line-height: 1.35; }


.hm-setup { border: 1px solid var(--line); border-radius: 16px; padding: 16px; background: var(--card); }
.hm-setup-head { display: flex; align-items: baseline; gap: 12px; }
.hm-setup-head h2 { margin: 0; flex: 1; font-size: var(--fs-l); }
.hm-setup-head .n { color: var(--dim); font-size: var(--fs-s); }
.hm-setup .s-meter { height: 6px; margin: 10px 0 12px; }
.hm-steps { list-style: none; margin: 0 0 12px; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px 16px; }
.hm-steps li { display: flex; align-items: center; gap: 8px; }
.hm-steps .ck { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--line2); display: grid; place-items: center; color: transparent; flex: none; }
.hm-steps li.done .ck { background: var(--accent); border-color: transparent; color: var(--accent-ink); }
.hm-steps li.done .btn.link { color: var(--dim); text-decoration: line-through; text-decoration-color: var(--faint); }
.hm-steps .btn.link { color: var(--text); font-weight: 600; min-height: 0; }

.hm-tip { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 12px 14px; border-radius: 14px; border: 1px dashed var(--line2); color: var(--dim); font-size: var(--fs-s); line-height: 1.45; }
.hm-tip .ic { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--card2); color: var(--text); }
.hm-tip b { display: block; color: var(--text); font-size: var(--fs-m); }

@media (max-width: 820px) { .hm-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 620px) { .hm-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hm-head { grid-template-columns: 1fr; } .hm-portrait { width: 84px; height: 84px; } .hm-head h1 { font-size: var(--fs-2xl); } }
`;
