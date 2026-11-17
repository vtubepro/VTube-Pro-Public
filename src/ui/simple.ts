// The Simple views: what each area shows by default (plain words, the few things people actually need, big clear
// actions, guidance when something is missing). Everything else stays one click away under "Advanced" (the original
// panels, untouched). Builders are plain "build the DOM from the current state" functions like the legacy panels, so
// the shell re-renders them through dom.ts rerender() (scroll, focus and typing survive).
import type { App } from '../app.ts';
import { TEST_EXPRESSIONS } from '../app.ts';
import { expressionLabel } from './meWords.ts';
import { trackProcessorCard } from './trackProcessorCard.ts';
import { closePreviewFrame, mountPreviewFrame, parkPreviewFrame, previewShowsFrom, previewWanted, setPreviewWanted } from './previewFrame.ts';
import { api, waitJob } from '../api.ts';
import type { AvatarProfile, Job, ServerStatus } from '../../shared/types.ts';
import { LIGHTING_STATES } from '../../shared/lightShow.ts';
import { EMOTES } from '../avatar/emotes.ts';
import { discord, type DiscordStatus } from '../net/discordClient.ts';
import { multiplayerSection } from './multiplayerPanel.ts';
import { trailSection } from './trailPanel.ts';
import { button, h, slider, toast, tut } from './dom.ts';
import { safeName } from './streamSafe.ts';
import { brandMark } from './brandMark.ts';
import { openChatHub } from './chatPanel.ts';
import { openDeck } from './deckOpen.ts';
import { openTool, setToolDefault, toolDefault } from './dockTools.ts';
import { openAiChat } from './aiChat.ts';
import { DEFAULT_VOICE } from '../audio/voice/voiceFrontEnd.ts';
import { defaultProfile } from '../../shared/defaults.ts';
import { OBS_URL, copyRow, micLevel, startCamera, startMic, stopMic } from './liveOps.ts';
import { isTestRoom, roomPrompter } from './prompter.ts';
import { guidedSetupsCard, performanceCard, shortcutList, tagCard, type SettingsNav } from './settingsCards.ts';
import { setTheme, themeChoice, type ThemeChoice } from './theme.ts';
import { isClassic, setClassic } from './layoutMode.ts';
import { surfaceSimpleCard } from './surfacePanel.ts';
import { sizeSimpleCard } from './sizePanel.ts';
import { betterLipSyncCard } from './voicePanel.ts';
import { bestLipSyncCard } from './lipsyncGuide.ts';
import { naturalCard } from './naturalPanel.ts';
import { trackPartsCard } from './trackPartsPanel.ts';
import { phoneCard } from './phonePanel.ts';
import { multicamCard } from './multicamPanel.ts';
import { roomPicker } from './roomPicker.ts';
import { gamesHub, gamesTeaser } from './gamesHub.ts';
import { homeView } from './home.ts';
import { createGate, guideLink, openArtistAvatars, openArtistRooms } from './createGate.ts';
import { runGateFix } from './gateFix.ts';
import { SETUP_FIX_LABEL } from '../../shared/createGate.ts';
import { roomMakerCard } from './roomMaker.ts';

export type AreaId = 'home' | 'onair' | 'me' | 'live' | 'room' | 'show' | 'chat' | 'stream' | 'games' | 'create' | 'friends' | 'settings';
export interface Nav {
  go(area: AreaId): void;
  advanced(area: AreaId, sub?: string): void;
  wizard(id: string, at?: string): void;
  refresh(): void;
  setGlobalAdvanced(on: boolean): void;
  globalAdvanced(): boolean;
  /** The keyboard shortcuts sheet (UX redesign: Home's Tools row). */
  shortcuts?(): void;
}

import { actionQuick, add, card, envQuick, heroCard, item, live, more, observerNote, seg } from './bits.ts';
import { IMPORT_ACCEPT } from '../../shared/importCheck.ts';
import { installImportTestHook } from './importDialog.ts';
import { installModelWizardTestHook } from './modelWizard.ts';
import { avatarMakerButton, importModelButtonLazy } from './laneWiring.ts';
import { avatarTileMenu, recentlyDeletedLine } from './avatarDelete.ts';

let status: ServerStatus | null = null, statusAt = 0;
function serverStatus(nav: Nav) {
  if (Date.now() - statusAt > 15000) { statusAt = Date.now(); void api.status().then((s) => { const changed = JSON.stringify(s) !== JSON.stringify(status); status = s; if (changed) nav.refresh(); }).catch(() => {}); }
  return status;
}

// ---------------------------------------------------------------- avatars library cache
let lib: AvatarProfile[] | null = null, libAt = 0, libStamp = Date.now(), libFailed = false;
export function invalidateSimpleLibrary() { libAt = 0; libStamp = Date.now(); }
function library(nav: Nav) {
  if (Date.now() - libAt > 20000) {
    libAt = Date.now();
    void api.avatars().then((l) => { const ch = JSON.stringify(l) !== JSON.stringify(lib) || libFailed; lib = l; libFailed = false; if (ch) nav.refresh(); })
      // (the list never loaded: say so, instead of "Loading your avatars…" for ever)
      .catch(() => { if (lib === null && !libFailed) { libFailed = true; nav.refresh(); } });
  }
  return lib;
}
const thumbOf = (p: AvatarProfile) => (p.thumbnail ? `${api.fileUrl(p, p.thumbnail)}?t=${libStamp}` : null);

function importDrop(app: App, label: string, sub: string, nav?: Nav) {
  const file = h('input', { type: 'file', accept: IMPORT_ACCEPT, style: 'display:none' }) as HTMLInputElement;
  // the drop box opens the drop-anywhere importer (src/ui/dropImport.ts). ("Add my model (guided)", src/ui/modelWizard.ts, and the older quick import
  // dialog, src/ui/importDialog.ts, stay under Me → Advanced → Avatars.)
  installImportTestHook(app); // observer pages only (window.vtpImportTest): screenshots of the dialog states
  installModelWizardTestHook(app); // observer pages only (window.vtpModelWizardTest)
  const go = (f: File) => { file.value = ''; void import('./dropImport.ts').then((m) => m.openModelImport(app, [f], { onDone: () => invalidateSimpleLibrary() })); };
  const drop = h('div', { class: 'drop', role: 'button', tabindex: 0, onClick: () => file.click(), onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } }, h('b', null, label), h('br'), h('span', { class: 'note' }, sub));
  file.onchange = () => { if (file.files?.[0]) void go(file.files[0]); };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) void go(f); };
  return h('div', null, drop, file);
}

// ================================================================ ME
function me(app: App, el: HTMLElement, nav: Nav) {
  const p = app.profile;
  add(el, observerNote(app) ?? '');
  const list = (library(nav) ?? []).filter((a) => a.source !== 'builtin-test');
  const added = () => { invalidateSimpleLibrary(); app.emit('library'); };
  const retry = () => { libAt = 0; libFailed = false; nav.refresh(); };
  // --- avatar picker
  const tiles = list.map((a) => {
    const t = thumbOf(a);
    const on = p?.id === a.id;
    return avatarTileMenu(app, a, h('button', { class: `s-tile ${on ? 'on' : ''}`, title: on ? `${a.name} (on screen)` : `Switch to ${a.name}`, 'aria-pressed': String(on), onClick: () => { if (!on) void app.loadAvatar(a.id); } },
      t ? h('img', { class: 'img', src: t, alt: '', loading: 'lazy' }) : h('div', { class: 'img' }, '☺'),
      on ? h('span', { class: 'check' }, '✓') : null,
      h('span', { class: 'nm' }, a.name)));   // (⋯ → Delete…: src/ui/avatarDelete.ts)
  });
  add(el, card(h('span', null, 'Your avatar'), p ? h('span', null, 'On screen now: ', h('b', null, p.name), '. Click another one to switch. It changes here and in OBS right away.') : 'Pick who you want to be.',
    lib === null ? (libFailed ? h('p', { class: 'note' }, 'Your avatars didn’t load. ', button('Try again', retry, 'ghost')) : h('p', { class: 'note' }, 'Loading your avatars…'))
      : list.length ? h('div', null, h('div', { class: 's-grid' }, ...tiles), recentlyDeletedLine(app))
      : h('div', { class: 's-empty' }, h('div', { class: 'big', style: 'display:flex;justify-content:center' }, brandMark('mark', 32)), h('b', null, 'No avatars yet'), 'Bring your own model, 3D or 2D: we check it and set it up for you.',
        h('div', { class: 's-row', style: 'margin-top:8px;justify-content:center' }, importModelButtonLazy(app, 'Add my model', added), avatarMakerButton(app, 'Create a 2D avatar', 'ghost'))),
    // beta.12: the drop-anywhere importer (src/ui/dropImport.ts) + the 2D avatar maker; the guided wizard stays in Advanced → Avatars
    list.length ? h('div', { class: 's-row', style: 'margin-top:10px' }, importModelButtonLazy(app, 'Add my model', added), avatarMakerButton(app, 'Create a 2D avatar'),
      h('span', { class: 'note' }, 'Any 3D model, a Pro2D avatar, 2D pictures or a 2D model from another app. We check it and fix what we can.')) : null,
    h('div', { style: 'margin-top:10px' }, importDrop(app, 'Or drop your model file here', 'Any 3D model: .vrm (VRoid Studio), .glb, .fbx, .obj, .blend. We check it, then set it up with you.', nav)),
  ));
  if (!p) return;
  // --- outfit
  const outfits = p.costumes.filter((c) => c.kind !== 'accessory');
  const accs = p.costumes.filter((c) => c.kind === 'accessory');
  const worn = p.costume ?? null;
  const oTile = (id: string | null, name: string, thumb: string | null, i: number) => h('button', { class: `s-tile ${worn === id ? 'on' : ''}`, 'aria-pressed': String(worn === id), title: i ? `${name} (Ctrl+${i})` : `${name} (Ctrl+0)`, onClick: () => void app.setCostume(id) },
    thumb ? h('img', { class: 'img', src: thumb, alt: '', loading: 'lazy' }) : h('div', { class: 'img' }, id ? '👕' : '∅'),
    worn === id ? h('span', { class: 'check' }, '✓') : null, i <= 9 ? h('span', { class: 'tag' }, `Ctrl+${i}`) : null, h('span', { class: 'nm' }, name));
  add(el, card('Outfit', outfits.length ? 'Tap to change clothes. Shortcut: Ctrl+1…9 while streaming (Ctrl+0 = none).' : null,
    outfits.length ? h('div', { class: 's-grid' }, oTile(null, 'Default look', null, 0), ...outfits.map((c, i) => oTile(c.id, c.name, c.thumbnail ? api.pathUrl(p.id, c.thumbnail) : null, i + 1)))
      : h('div', { class: 's-empty' }, h('div', { class: 'big' }, '👕'), h('b', null, 'No outfits for this avatar yet'), 'Describe one and the AI tailors it for you.', h('div', { style: 'margin-top:8px' }, button('Make an outfit', () => nav.advanced('me', 'wardrobe'), 'primary'), ((w) => w ? button(`Or wear ${w.name} (${w.costumes.filter((c) => c.kind !== 'accessory').length} outfits)`, () => void app.loadAvatar(w.id), 'ghost') : null)(list.find((a) => a.id !== p.id && a.costumes.some((c) => c.kind !== 'accessory'))))), // autopilot: never a dead end
    accs.length ? h('div', { class: 's-field' }, h('span', null, 'Accessories'), h('div', { class: 's-pills' }, ...accs.map((c) => {
      const on = (p.accessories ?? []).includes(c.id);
      return h('button', { class: `s-pill ${on ? 'on' : ''}`, 'aria-pressed': String(on), onClick: () => void app.setAccessory(c.id, !on).then(() => nav.refresh()) }, on ? '✓ ' : '', c.name);
    }))) : null));
  // --- material style (felt, plush, clay, scales, fur…)
  add(el, surfaceSimpleCard(app, () => nav.refresh()));
  // --- real size (size class: micro perches / macro back row in rooms) + polycount for parties
  add(el, sizeSimpleCard(app, () => nav.refresh()));
  // --- try it
  const names = Object.keys(TEST_EXPRESSIONS);
  add(el, card('Try your expressions', 'Preview faces without the camera. Keys 1–9 work too.',
    h('div', { class: 's-pills' }, ...names.slice(0, 12).map((n, i) => h('button', { class: 's-pill', onClick: () => app.preview(n) }, expressionLabel(n), i >= 1 && i <= 9 ? h('span', { class: 'k' }, String(i)) : null)))));
  const rt = app.runtime;
  if (rt && (rt.info.rig === 'vrm' || rt.info.rig === 'humanoid')) {
    add(el, card('Emotes', 'Little animations on top of your tracking. They show in OBS too.',
      h('div', { class: 's-pills' }, ...EMOTES.slice(0, 10).map((e) => h('button', { class: 's-pill', onClick: () => app.playEmote(e.id, e.loop) }, `▶ ${e.label}`)),
        h('button', { class: 's-pill', onClick: () => app.stopEmote() }, '■ Stop'))));
  }
  add(el, card('Camera framing', 'How close the studio camera shows you. OBS has its own Framing setting in OBS & stream.',
    seg([['head', 'Head'], ['bust', 'Head & shoulders'], ['full', 'Full body']], app.focus, (v) => { app.focus = v; app.frameCamera(); nav.refresh(); })));
  // --- lip sync for this avatar + this computer (src/ui/lipsyncGuide.ts)
  add(el, bestLipSyncCard(app, { go: (a) => nav.go(a as AreaId), advanced: (a, s) => nav.advanced(a as AreaId, s), wizard: (id, at) => nav.wizard(id, at) }));
  add(el, more('Fine-tune', 'eyes, mouth, blush, physics, jiggle, emotes', () => nav.advanced('me', 'face')));
}

// ================================================================ GO LIVE
function goLive(app: App, el: HTMLElement, nav: Nav) {
  add(el, observerNote(app) ?? '');
  const S = app.scene;
  const room = S.effective.sceneId ? S.scenes.find((x) => x.id === S.effective.sceneId) : null;
  const statusBox = h('div', { class: 's-list', 'data-tut': 'live-status' });
  const bigBtn = h('div', { 'data-tut': 'live-start' });
  const paint = () => {
    const on = app.trackingOn, face = app.stats.tracked, mic = app.audio.active;
    const obs = obsClients;
    statusBox.replaceChildren();
    add(statusBox,
      item(on ? 'ok' : '', '📷', on ? 'Camera on' : 'Camera off', on ? (app.stats.camera || 'running') : 'Your webcam drives the avatar. Any webcam works.',
        on ? button('Turn off', () => { app.stopTracking(); nav.refresh(); }, 'ghost') : null),
      on ? item(face ? 'ok' : 'warn', '🙂', face ? 'Face found' : 'Looking for your face…', face ? 'Your avatar copies your face.' : 'Look at the camera. More light helps.') : null,
      item(mic ? 'ok' : '', '🎤', mic ? 'Microphone on' : 'Microphone off', mic ? (app.audio.deviceLabel || 'lip-sync from your voice') : 'Optional: the mouth also follows your voice.',
        mic ? button('Turn off', () => { stopMic(app); nav.refresh(); }, 'ghost') : on ? button('Turn on', () => void startMic(app).then(() => nav.refresh())) : null),
      item(app.profile ? 'ok' : 'warn', '☺', app.profile ? `Avatar: ${app.profile.name}` : 'No avatar yet', app.profile ? 'Change it in Me.' : 'Pick one in Me.', button('Change', () => nav.go('me'), 'ghost')),
      item('ok', '🏠', room ? `Room: ${room.name}` : 'No room (just you, transparent)', room ? `${S.effective.mode === 'react' ? 'React' : 'Talk'} mode.` : 'Perfect for putting yourself over a game.', button('Change', () => nav.go('room'), 'ghost')),
      item(obs > 0 ? 'ok' : 'warn', '📺', obs > 0 ? 'OBS is connected' : 'OBS not connected yet', obs > 0 ? `${obs} output page${obs > 1 ? 's' : ''} listening.` : 'Add the Browser Source below (2 minutes, once).', obs > 0 ? null : button('Show me', () => nav.wizard('firstRun', 'obs'))),
    );
    bigBtn.replaceChildren();
    add(bigBtn,
      !on ? button(app.observer ? 'Start camera & mic (off in observer)' : '▶  Start camera & mic', async () => {
        const ok = await startCamera(app);
        if (ok && !app.audio.active) await startMic(app);
        nav.refresh();
      }, 'primary big')
        : !mic ? button('🎤  Turn on the microphone too', () => void startMic(app).then(() => nav.refresh()), 'primary big')
          : h('div', { class: 's-row between' }, h('b', null, '✓ You’re ready to stream'), button('Calibrate my face (C)', async () => { toast('Relax your face and look at the screen…'); await app.face.calibrate(2); toast('Calibrated ✓ — your neutral face is set', 'ok'); })),
    );
  };
  paint();
  let sig = '';
  live(() => {
    if (!statusBox.isConnected) return false;
    const s = `${app.trackingOn}|${app.stats.tracked}|${app.audio.active}|${obsClients}|${app.stats.camera}`;
    if (s !== sig) { sig = s; paint(); }
    return true;
  });
  add(el, heroCard('', h('h3', null, 'Ready to go live?'), h('p', { class: 'lead' }, 'Turn on your camera, check the list, then start streaming in OBS as usual.'), statusBox, h('div', { style: 'margin-top:10px' }, bigBtn)));
  // Hands / Body switches, near the top (src/ui/trackPartsPanel.ts): work at once, this browser remembers them
  add(el, trackPartsCard(app, () => nav.refresh()));
  add(el, trackProcessorCard(app));   // where tracking runs (gamers: the processor), src/ui/trackProcessorCard.ts

  // mic meter (while on)
  if (app.audio.active) {
    const bar = h('i', { style: 'width:0%' });
    live(() => { if (!bar.isConnected) return false; bar.style.width = `${Math.round(micLevel(app) * 100)}%`; return true; });
    const A = app.audio;
    add(el, card('Your voice', 'Talk — the bar should jump. If the mouth moves when you are quiet, calibrate the room noise.',
      h('div', { class: 's-meter' }, bar),
      slider('Sensitivity', A.voiceSettings.sensitivity, 0, 1, 0.05, (v) => void A.setVoiceSettings({ sensitivity: v }).catch(() => {}), 'Low: only clear speech moves the mouth. High: whispers do too (and more noise).', { def: DEFAULT_VOICE.sensitivity }),
      h('div', { class: 's-row' }, button('Calibrate room noise (stay quiet 3 s)', async (e) => {
        const b = e.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = 'Stay quiet…';
        try { const r = await A.calibrateNoise(3); toast(`Room noise learned (${Math.round(r.rawFloor)} dB).${r.pP90 > 0.5 ? ' I heard a voice — try again when it’s quiet.' : ''}`, r.pP90 > 0.5 ? 'warn' : 'ok', 6000); }
        catch (err) { toast((err as Error).message, 'err'); }
        b.disabled = false; b.textContent = 'Calibrate room noise (stay quiet 3 s)';
      }))));
  }
  add(el, naturalCard(app, () => nav.refresh()));
  add(el, betterLipSyncCard(app, () => nav.refresh()));
  add(el, bestLipSyncCard(app, { go: (a) => nav.go(a as AreaId), advanced: (a, s) => nav.advanced(a as AreaId, s), wizard: (id, at) => nav.wizard(id, at) }));
  add(el, phoneCard(app, () => nav.wizard('phone'), () => nav.refresh()));
  add(el, multicamCard(app, () => nav.wizard('multicam'), () => nav.refresh()));
  // OBS
  add(el, card('Show it in OBS', 'In OBS: Sources → + → Browser, paste this address, set 1920 × 1080. The background is transparent.',
    copyRow('Browser Source URL', OBS_URL, 'The OBS address'),
    h('div', { class: 's-row', style: 'margin-top:6px' }, button('Step-by-step OBS guide', () => nav.wizard('firstRun', 'obs')), button('Open the output page', () => window.open('/output.html?preview=1', 'vtp-output-preview', 'width=960,height=540'), 'ghost'))));
  // feel
  const t = app.tune;
  const tune = (fn: (x: typeof t) => void) => app.edit((p) => fn(p.tracking), false);
  add(el, card('How it feels', null,
    slider('Expressiveness', t.expressiveness, 0.5, 2, 0.01, (v) => tune((x) => (x.expressiveness = v)), 'How strongly the avatar copies your face', { def: defaultProfile('_', '_', '_').tracking.expressiveness, unit: '×' }),
    slider('Smoothness', t.smoothing, 0, 1, 0.01, (v) => tune((x) => (x.smoothing = v)), 'Low = snappy, high = buttery (a little more delay)', { def: defaultProfile('_', '_', '_').tracking.smoothing }),
    h('div', { class: 's-row' }, button('Run the 45-second expression test', () => nav.wizard('firstRun', 'voice'), 'ghost'))));
  // chat
  const cs = S.chat.status;
  const plat = (['twitch', 'youtube', 'kick', 'rumble', 'tiktok'] as const).map((k) => { const s = cs?.platforms[k]; return { k, on: !!s?.enabled, live: s?.state === 'live' }; });
  const any = plat.some((x) => x.on);
  add(el, card('Chat & donations', any ? null : 'Show your chat and donation alerts inside the room.',
    any ? h('div', { class: 's-pills' }, ...plat.filter((x) => x.on).map((x) => h('span', { class: `chip ${x.live ? 'ok' : 'warn'}` }, h('span', { class: 'dot' }), `${({ twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', rumble: 'Rumble', tiktok: 'TikTok' } as const)[x.k]} ${x.live ? 'connected' : 'waiting'}`))) : null,
    h('div', { class: 's-row', style: 'margin-top:8px' }, button(any ? 'Change my chat set-up' : 'Set up my chat & stream', () => nav.wizard('chat'), any ? '' : 'primary'),
      button('Open Chat Hub', () => openChatHub(), 'ghost'), button('Twitch / TikTok…', () => openChatHub(true), 'ghost'),
      button('Stream Deck & controllers', () => openDeck(), 'ghost'),
      button('AI connectors', () => openTool('aiconnect'), 'ghost'), button('Ask your AI', () => void openAiChat(), 'ghost'),
      button('Tools & add-ons', () => openTool('tools'), 'ghost')),
    h('p', { class: 'note' }, 'Chat Hub: all your chats in one place (a panel beside the stage, or “Pop out ↗” for a second screen), support + stream events to acknowledge, read-aloud of donation messages.')));
  add(el, more('Advanced', 'camera resolution, phone tracking, expression training, snacks, voice filter', () => nav.advanced('live', 'tracking')));

}
let obsClients = 0, obsAt = 0;
/** Output pages inside OBS right now (OBS is showing VTube Pro). clarity (live audit): a page open in a normal browser
 *  tab used to count too, so the studio said "OBS" / "ON AIR" with OBS nowhere. The helper tells them apart
 *  (outputs.inObs, shared/obsPages.ts); an older version without it: every output page, as before. */
export function pollObs() {
  if (Date.now() - obsAt < 4000) return obsClients;
  obsAt = Date.now();
  // output pages that said hello (OBS Browser Sources + browser tabs; not the studio's own preview, server/bus.ts);
  // an older version only has busClients (every page on the bus, minus this studio)
  void fetch('/api/setup/status', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((s: { busClients?: number; outputs?: { count?: number; inObs?: number } } | null) => {
    if (s && typeof s.outputs?.inObs === 'number') obsClients = Math.max(0, s.outputs.inObs);
    else if (s && typeof s.outputs?.count === 'number') obsClients = Math.max(0, s.outputs.count);
    else if (s && typeof s.busClients === 'number') obsClients = Math.max(0, s.busClients - 1);
  }).catch(() => {});
  return obsClients;
}

// ================================================================ ROOM
/** Room prop toggles (scene.json `toggles` / glb extras `toggleGroup`): one pill per set, lit = shown on stream. */
function propsQuick(app: App, nav: Nav): HTMLElement | null {
  const S = app.scene, list = S.roomToggles();
  if (!list.length) return null;
  return h('div', { class: 's-field' }, h('span', null, 'Room props'), h('div', { class: 's-pills' }, ...list.map((t) => {
    const on = S.toggleOn(t.id);
    return h('button', { class: `s-pill ${on ? 'on' : ''}`, 'aria-pressed': String(on), title: on ? 'Shown on stream: click to hide it everywhere' : 'Hidden: click to show it again', onClick: () => { S.setToggle(t.id, !on); nav.refresh(); } }, on ? '✓ ' : '', t.label || t.id);
  })));
}
let preview = previewWanted();   // (off until the user turns it on: src/ui/previewFrame.ts)
function roomView(app: App, el: HTMLElement, nav: Nav) {
  add(el, observerNote(app) ?? '');
  const S = app.scene, st = S.effective, edit = S.canEdit;
  // (the PiP below stops drawing while nobody can see it; the opt-in "while tracking" savings need to know about tracking)
  S.trackingProbe ??= () => app.trackingOn;
  previewShowsFrom(() => { const S = app.scene, p = app.profile; return `${S.effective.sceneId ?? ''}|${S.members().map((m) => m.key).join(',')}|${p?.id ?? ''}|${p?.costume ?? ''}|${(p?.accessories ?? []).join(',')}`; },
    (changed) => { app.scene.on(changed); app.on((w) => { if (w === 'avatar' || w === 'costume') changed(); }); });
  if (S.role === 'guest') add(el, h('div', { class: 's-banner' }, h('span', null, '👋'), h('span', null, 'You are a guest: ', h('b', null, 'the host runs the room'), '. Your OBS follows it.')));
  const info = st.sceneId ? S.scenes.find((x) => x.id === st.sceneId) ?? null : null;
  // live preview (what OBS shows): a picture-in-picture over the 3D view (syncRoomPip), never re-created by re-renders
  add(el, h('div', { class: 's-row between', style: 'margin-bottom:12px' },
    // (clarity: a local preview, only on this screen: never a red "OBS view" that reads like something going out)
    h('span', { class: 'note', style: 'margin:0' }, preview ? 'The small picture in the corner shows what OBS will show. Only you see it.' : 'The live preview is off, so your graphics card stays free for OBS and games. Turn it on while you set up.'),
    button(preview ? 'Hide the preview' : 'Show the preview', () => { preview = !preview; setPreviewWanted(preview); syncRoomPip(true); nav.refresh(); }, preview ? 'ghost' : '')));

  // the room: current room + "Change room" drawer (grouped picture cards, search, favourites — src/ui/roomPicker.ts)
  add(el, roomPicker(app, { where: 'simple', rescan: true }));
  // quick controls for the current room
  if (info && edit) {
    const cur = st.lights.state ?? 'show';
    add(el, tut(card(h('span', null, info.name), null,
      h('div', { class: 's-field' }, h('span', null, 'Mode'), seg([['talk', '🎙 Talk', 'just you'], ['react', '🖥 React', 'screen comes down']], st.mode, (v) => S.setMode(v))),
      h('div', { class: 's-field', 'data-tut': 'room-lighting' }, h('span', null, 'Lighting'), seg(LIGHTING_STATES.map((s): [string, string, string] => [s.id, s.label, `Shift+${s.key}`]), cur, (v) => S.setLighting(v))),
      h('div', { class: 's-field', title: 'AFK: the camera tours the room (the ship, the deck, the battle) and cuts to landings and kills; chatter names ride on the ships. Options: Advanced → Scene → AFK / Starting soon' }, h('span', null, 'Away'),
        seg([['here', '🎙 I’m here', ''], ['afk', '🎬 AFK tour', '']], st.afk?.on ? 'afk' : 'here', (v) => S.toggleAfk(v === 'afk'))),
      info.environment ? envQuick(app) : null,
      info.raid || info.space ? actionQuick(app, !!info.space) : null,
      propsQuick(app, nav),
    ), 'room-quick'));
  }
  // prompter
  add(el, h('section', { class: 's-card hero violet', id: 'room-prompter' }, h('h3', null, '✨ Describe your room'), roomPrompter(app, () => nav.refresh(), {})));
  add(el, card('Guided set-ups', null, h('div', { class: 's-row' }, button('Set up a room (guided)', () => nav.wizard('room'), 'primary'), button('Set up the react screen', () => nav.wizard('react')))));
  add(el, card('Show, chat and OBS', 'Their own areas now: the show mode and where every cam, the game and the chat sit (with a drag-and-drop layout editor), chat and events, and OBS.',
    h('div', { class: 's-row' }, button('Show & layout', () => nav.go('show'), 'primary'), button('Chat & events', () => nav.go('chat')), button('OBS & stream', () => nav.go('stream')))));
  add(el, more('Advanced', 'who sits where, cameras, every light, weather, graphics, space and raid rooms', () => nav.advanced('room', 'scene')));
}
let pip: HTMLElement | null = null;
let pipBig = localStorage.getItem('vtp.ui.pipBig') === '1';
/** The room preview (output.html?preview=1 — what OBS renders) as a PiP in the viewport while Room (Simple) shows. */
export function syncRoomPip(active: boolean) {
  const vp = document.getElementById('viewport');
  const want = active && preview && !!vp;
  // (the preview frame itself is shared and kept running out of sight: src/ui/previewFrame.ts — no reload per visit)
  if (!want) { if (pip) { if (preview) parkPreviewFrame(); else closePreviewFrame(); pip.remove(); } pip = null; return; }
  if (pip?.isConnected) return;
  const size = () => { if (pip) pip.style.width = pipBig ? 'min(62%, 900px)' : 'min(40%, 520px)'; };
  const big = h('button', { class: 'btn', title: 'Bigger / smaller', onClick: () => { pipBig = !pipBig; localStorage.setItem('vtp.ui.pipBig', pipBig ? '1' : '0'); size(); } }, '⤢');
  const close = h('button', { class: 'btn', title: 'Hide the preview', onClick: () => { preview = false; setPreviewWanted(false); syncRoomPip(false); document.dispatchEvent(new CustomEvent('vtp-refresh')); } }, '✕');
  const bar = h('div', { class: 'room-pip-bar' }, h('span', { class: 'room-pip-lbl' }, 'Preview · only you see this'), h('span', { style: 'flex:1' }), big, close);
  pip = h('div', { class: 'room-pip' }, bar);
  size();
  vp!.append(pip);
  mountPreviewFrame(pip, bar);
}
// ================================================================ CREATE
const gen = { prompt: '', styles: [] as string[], images: [] as string[], job: null as Job | null, running: false };
const CHAR_STYLES: [string, string][] = [['anime', '✨ Anime'], ['cute', '🧸 Cute / chibi'], ['animal', '🐾 Animal mascot'], ['robot', '🤖 Robot'], ['fantasy', '🧝 Fantasy'], ['monster', '👾 Monster']];
function createView(app: App, el: HTMLElement, nav: Nav) {
  add(el, observerNote(app) ?? '');
  // lane create-gating: "How do you want to create?" comes first; no describe-it box until one way really works
  const { gate, showCreate } = createGate(app, el, nav);
  const byo = () => { const c = card(showCreate ? 'Bring your own model' : 'Already have a model?', 'Made a character in VRoid Studio (free) or have a .vrm / .glb? This is the best-looking, fastest way.',
    importDrop(app, 'Add my model', 'Drop any 3D model — .vrm, .glb, .fbx, .obj, .blend and more — here, or click. We check it and set it up with you.', nav),
    h('p', { class: 'note', style: 'margin:10px 0 0' }, guideLink('Making it yourself? Artist guide: models, outfits and accessories', openArtistAvatars))); c.id = 'cg-byo'; return c; };
  // a 2D avatar needs no AI and no key: from your own layered art, or from ONE picture (tap the eyes and the mouth)
  const twoD = () => { const c = card('2D avatar from your art or ONE picture', 'Have a layered PSD (or one picture per part)? Or only ONE picture? Open it in the 2D avatar maker: for one picture you tap the eyes and the mouth and it comes to life and follows your face. No AI, no key and no other software needed.',
    h('div', { class: 'btns' }, avatarMakerButton(app, 'Make a 2D avatar…', 'primary'))); c.id = 'cg-2d'; c.dataset.ui = 'create-2d'; return c; };
  if (!showCreate) { add(el, byo(), twoD()); return; }
  const s = serverStatus(nav);
  const how = gate.inPage;
  const ready = how.ok;
  add(el, byo(), twoD());

  // describe your character
  const ta = h('textarea', { placeholder: 'e.g. “a sleepy purple cat wizard with a big star hat and a cozy hoodie”', value: gen.prompt, rows: 3, 'aria-label': 'Describe your character', onInput: (e: Event) => (gen.prompt = (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
  const imgIn = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' }) as HTMLInputElement;
  const addFiles = (files: FileList | File[]) => { for (const f of Array.from(files).slice(0, 6)) { const r = new FileReader(); r.onload = () => { gen.images.push(String(r.result)); nav.refresh(); }; r.readAsDataURL(f); } };
  imgIn.onchange = () => imgIn.files && addFiles(imgIn.files);
  // VTube Pro's own Character 3D turns a PICTURE into 3D (it cannot build a character from words), so there the picture is the
  // point, not an extra. The user's own ComfyUI workflow file, and an older version (it cannot say which runs), are not held to it.
  const needPic = !!how.needsPicture;
  const refs = h('div', { class: 'drop', role: 'button', tabindex: 0, onClick: () => imgIn.click() }, gen.images.length ? `${gen.images.length} picture${gen.images.length > 1 ? 's' : ''} added — click to add more` : needPic ? '📎 Add a picture of your character (needed): a drawing or a full-body picture, facing front' : '📎 Add reference pictures (optional): drawings, a character sheet, screenshots');
  refs.ondragover = (e) => { e.preventDefault(); refs.classList.add('over'); };
  refs.ondragleave = () => refs.classList.remove('over');
  refs.ondrop = (e) => { e.preventDefault(); refs.classList.remove('over'); if (e.dataTransfer?.files) addFiles(e.dataTransfer.files); };
  const thumbs = gen.images.length ? h('div', { class: 'thumbs' }, ...gen.images.map((src, i) => h('img', { src, title: 'Click to remove', alt: 'reference', onClick: () => { gen.images.splice(i, 1); nav.refresh(); } }))) : null;
  const job = gen.job;
  const prog = job ? h('div', null, h('div', { class: 'progress' }, h('i', { style: `width:${Math.round(job.progress * 100)}%` })), h('p', { class: 'note' }, job.status === 'failed' ? `✕ ${job.error ?? 'failed'}` : job.log.slice(-1)[0]?.replace(/^\[[\d:]+\]\s*/, '') ?? 'Working…'),
    // a failed job that a helper page can fix (ComfyUI without its 3D model): one button, no guessing
    job.status === 'failed' && job.fixUrl ? button(SETUP_FIX_LABEL, () => runGateFix({ action: 'setup', label: SETUP_FIX_LABEL, url: job.fixUrl }), 'primary') : null,
    job.preview ? h('img', { src: job.preview, alt: 'preview', style: 'width:100%;border-radius:10px' }) : null) : null;
  const goBtn = button(gen.running ? 'Creating… (a few minutes)' : 'Create my character', async () => {
    gen.prompt = ta.value;
    if (!gen.prompt.trim() && !gen.images.length) { toast('Describe your character or add a picture first', 'warn'); return; }
    if (how.provider === 'comfy' && needPic && !gen.images.length) { toast('ComfyUI turns a picture into 3D: add a picture of your character first', 'warn'); return; }
    if (app.observer) { toast('Observer sandbox: nothing is generated here.', 'warn'); return; }
    gen.running = true; nav.refresh();
    const words = gen.styles.map((x) => CHAR_STYLES.find((c) => c[0] === x)?.[1].replace(/^\S+\s/, '') ?? x);
    try {
      const prompt = [gen.prompt.trim(), words.length ? `Style: ${words.join(', ')}.` : ''].filter(Boolean).join(' ');
      const { jobId } = await api.generate({ provider: 'comfy', prompt, images: gen.images, faceless: true });
      const j = await waitJob(jobId, (x) => { gen.job = x; nav.refresh(); });
      gen.job = j;
      if (j.status === 'succeeded' && j.result?.avatarId) { toast('Your character is ready ✓ — next: place its eyes & mouth (Me → Advanced → Face).', 'ok', 8000); await app.loadAvatar(j.result.avatarId, false, false); app.emit('library'); }   // (unstamped: a job finishing is no performer switch - OBS never jumps to this studio for it)
      else toast(`That didn’t work: ${j.error ?? 'unknown error'}`, 'err', 9000);
    } catch (e) { toast((e as Error).message, 'err', 8000); }
    gen.running = false; nav.refresh();
  }, 'primary');
  goBtn.disabled = gen.running || !ready;
  // only an AI app is linked: it does the making (the "Your AI is ready" card above); no in-page form that can't run
  const inPage = how.ok || !!how.fix;
  if (inPage) add(el, h('section', { class: 's-card hero violet' }, h('h3', null, 'Describe your character'),
    h('p', { class: 'lead' }, needPic ? 'Add a picture of your character. ComfyUI builds a 3D model from it on your computer and VTube Pro adds eyes and a mouth that follow yours.'
      : 'Say what they look like, or add a picture. ComfyUI builds a 3D model on your computer and VTube Pro adds eyes and a mouth that follow yours.'),
    ta,
    h('div', { class: 's-field' }, h('span', null, 'Style'), h('div', { class: 's-pills' }, ...CHAR_STYLES.map(([id, label]) => h('button', { class: `s-pill ${gen.styles.includes(id) ? 'on' : ''}`, 'aria-pressed': String(gen.styles.includes(id)), onClick: () => { gen.prompt = ta.value; gen.styles = gen.styles.includes(id) ? gen.styles.filter((x) => x !== id) : [...gen.styles, id]; nav.refresh(); } }, label)))),
    refs, imgIn, thumbs,
    !ready ? h('div', { class: 's-banner warn' }, h('span', null, how.why, ' '),
      how.fix?.action === 'setup' ? button(how.fix.label, () => runGateFix(how.fix!), 'primary')
        : gate.chat ? button('Ask your AI instead', () => void openAiChat(), 'link') : null) : null,
    h('div', { class: 's-row', style: 'margin-top:8px' }, goBtn, h('span', { class: 'note', style: 'margin:0' }, 'Takes a few minutes. Saved to your avatars.')),
    prog));
  // the room maker: a full brief for the user's AI app (seats, cameras, screen, door), then "＋ Add my room"
  add(el, roomMakerCard(app, { chat: gate.chat, refresh: () => nav.refresh(), guide: guideLink('Artist guide: rooms', openArtistRooms),
    pickRoom: () => { nav.go('room'); setTimeout(() => document.getElementById('room-prompter')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); } }));
  add(el, more('Advanced', 'local AI 3D with ComfyUI, auto-rig', () => nav.advanced('create', 'create')));
}

// ================================================================ FRIENDS
let dstatus: DiscordStatus | null = null, dAt = 0, dErr = '';
function friends(app: App, el: HTMLElement, nav: Nav) {
  add(el, observerNote(app) ?? '');
  if (Date.now() - dAt > 10000) { dAt = Date.now(); void discord.status().then((s) => { const ch = JSON.stringify(s) !== JSON.stringify(dstatus); dstatus = s; dErr = ''; if (ch) nav.refresh(); }).catch((e) => { dErr = (e as Error).message; }); }
  const P = app.party;
  add(el, heroCard('blue', h('h3', null, '👯 Stream together'),
    h('p', { class: 'lead' }, 'Up to 8 friends in one room. Everyone runs VTube Pro on their own PC and talks in Discord as usual; every OBS shows the whole party.'),
    h('div', { class: 's-list' },
      item(P.role === 'none' ? '' : 'ok', '🎉', P.role === 'host' ? `You are hosting (${P.remotes.size} guest${P.remotes.size === 1 ? '' : 's'})` : P.role === 'guest' ? `You joined ${P.hostInfo?.name ?? 'a party'}` : 'No party right now', P.role === 'none' ? 'Start one below, or click Join on a friend’s Discord post.' : 'Manage it below.'),
      item(dstatus?.configured ? 'ok' : 'warn', '🔗', dstatus?.configured ? 'Discord is set up' : 'Discord not set up yet', dstatus?.configured ? (dstatus.signedIn ? h('span', null, 'Signed in as ', safeName(dstatus.user?.name ?? '?', 'your Discord account')) : 'Sign in to host.') : 'Only the host needs this (one time, ~15 minutes). Guests need nothing.',
        dstatus?.configured ? null : button('Set up', () => nav.wizard('multiplayer'), 'primary', 'party-setup')))));
  add(el, gamesTeaser(nav)); // (was the Trail launcher) Party games (The Trail, the tabletop RPG): the Games area (src/ui/gamesHub.ts)
  if (dErr && !dstatus) add(el, h('p', { class: 'note' }, `Couldn’t read the Discord set-up: ${dErr}`));
  if (dstatus?.configured || P.role !== 'none') add(el, multiplayerSection(app));
  else add(el, card('Joining a friend?', null, h('p', { class: 'note' }, 'Just click ', h('b', null, 'Join'), ' on their Discord post while VTube Pro is running. It asks you here before anything is shared. Your avatar only lives in their PC’s memory while you’re in the party.')));
  add(el, more('Advanced', 'invite codes without Discord, hiding your internet address, who may join, bans', () => nav.advanced('friends', 'party')));
}

// ================================================================ SETTINGS
/** Look & feel: theme, Simple/Advanced, Layout, Open tools in. */
export function lookFeelCard(app: App, nav: SettingsNav) {
  return tagCard('look-feel', card('Look & feel', null,
    h('div', { class: 's-field' }, h('span', null, 'Theme'), seg<ThemeChoice>([['dark', '🌙 Dark'], ['light', '☀️ Light'], ['system', '🖥 Like Windows']], themeChoice(), (v) => { setTheme(v); nav.refresh(); })),
    h('div', { class: 's-field' }, h('span', null, 'Menus'), seg<'simple' | 'advanced'>([['simple', 'Simple', 'the essentials'], ['advanced', 'Advanced', 'every setting']], nav.globalAdvanced() ? 'advanced' : 'simple', (v) => nav.setGlobalAdvanced(v === 'advanced')),
      h('span', { class: 'hint' }, 'Each area also has its own Advanced switch at the top.')),
    // UX redesign (src/ui/layoutMode.ts): Classic = the studio arranged exactly as before; nothing is removed in either
    h('div', { class: 's-field', 'data-ui': 'layout-switch' }, h('span', null, 'Layout'), seg<'new' | 'classic'>([['new', 'New', 'grouped menu, bell, folding cards'], ['classic', 'Classic', 'exactly as before']], isClassic() ? 'classic' : 'new', (v) => { setClassic(v === 'classic', !app.observer); nav.refresh(); }),
      h('span', { class: 'hint' }, app.observer ? 'This observer tab switches only itself.' : 'Every button and setting is in both. Classic keeps notices in the header and the menu ungrouped.')),
    // docked: Chat Hub, Stream Deck & controllers and AI connectors open as a panel beside the stage, or in their own window
    h('div', { class: 's-field' }, h('span', null, 'Open tools in'), seg<'app' | 'window'>([['app', 'In app', 'a panel beside the stage'], ['window', 'New window', 'second monitor / OBS dock']], toolDefault(), (v) => { setToolDefault(v); nav.refresh(); }),
      h('span', { class: 'hint' }, 'Chat Hub, Stream Deck & controllers, AI connectors. Each tool also has “Pop out ↗” / “Dock back”, remembered per tool.'))));
}

function settingsView(app: App, el: HTMLElement, nav: Nav) {
  // Look & feel, Guided set-ups and Performance are shared with Settings -> Advanced (src/ui/settingsCards.ts):
  // Advanced shows these same cards first, then its own (src/ui/settingsRegistry.ts)
  add(el, lookFeelCard(app, nav));
  add(el, guidedSetupsCard(app, nav));
  add(el, performanceCard(app, nav));
  const s = serverStatus(nav);
  // (the browser version has no "studio server" on this computer: there it is the VTube Pro Helper, or nothing yet)
  add(el, tagCard('your-computer', card('Your computer', null, s ? h('div', { class: 's-kv' },
    h('span', null, 'Studio server'), h('span', null, '✓ running'),
    h('span', null, 'Blender'), h('span', null, s.blender.available ? `✓ ${s.blender.version ?? 'found'}` : '✕ not found — needed to build avatars and rooms'),
    h('span', null, 'ComfyUI'), h('span', null, s.comfy.reachable ? '✓ running' : 'not running (optional, for local AI pictures and 3D)'),
  ) : h('p', { class: 'note' }, 'Checking…'), h('div', { class: 's-row', style: 'margin-top:8px' }, button('Tools & settings', () => nav.advanced('settings'), '')))));
  add(el, tagCard('keyboard-shortcuts', card('Keyboard shortcuts', null, shortcutList())));
  add(el, more('Advanced', 'ComfyUI, Blender path, local AI models', () => nav.advanced('settings', 'settings')));
}
export { shortcutList };

// Show & layout, Chat & events and OBS & stream always show their full grouped settings (src/ui/shell.ts FULL): these only
// run if something asks for their Simple view anyway.
const fullOnly = (a: AreaId) => (_app: App, el: HTMLElement, nav: Nav) => { add(el, card('Every setting is one click away', null, button('Show them', () => nav.advanced(a), 'primary'))); };
export const SIMPLE: Record<AreaId, (app: App, el: HTMLElement, nav: Nav) => void> = { home: (app, el, nav) => homeView(app, el, nav), onair: () => { /* livedash: drawn by the shell (src/ui/live) */ }, me, live: goLive, room: roomView, show: fullOnly('show'), chat: fullOnly('chat'), stream: fullOnly('stream'), games: (app, el, nav) => gamesHub(app, el, nav), create: createView, friends, settings: settingsView };
