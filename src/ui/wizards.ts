// The setup wizards: first-time setup, a room, multiplayer (Discord), the react screen (chat & stream: src/ui/streamSetup).
// Every step explains itself in plain words and offers buttons; nothing starts, switches or goes live unless the
// performer clicks. Wizards are skippable (any step) and resumable (src/ui/wizard.ts keeps the place).
import { LEARNME_PRIVACY, learnMeToggle } from './learnMePanel.ts';
import type { App } from '../app.ts';
import { api } from '../api.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { LIGHTING_STATES } from '../../shared/lightShow.ts';
import { presetById } from '../../shared/lightPresets.ts';
import type { ObsProbe } from '../../shared/obs.ts';
import { discord, type DiscordStatus } from '../net/discordClient.ts';
import { button, h, toast, tut } from './dom.ts';
import { safeName } from './streamSafe.ts';
import { brandMark } from './brandMark.ts';
import { openWizard, wizHead, wizardState, type WizCtx, type WizDef, type WizStep } from './wizard.ts';
import { OBS_URL, cameraMirror, cameras, copyRow, faceChecks, micLevel, mics, savedCamera, savedMic, startCamera, startMic } from './liveOps.ts';
import { actionQuick, add, card, envQuick, item, live, observerNote, pill, seg } from './bits.ts';
import { isTestRoom, roomPrompter } from './prompter.ts';
import { roomPicker } from './roomPicker.ts';
import { phoneWizard } from './phonePanel.ts';
import { multicamWizard } from './multicamPanel.ts';
import { betterLipSyncCard } from './voicePanel.ts';
import { openLipSyncGuide } from './lipsyncGuide.ts';
import { openHelp } from './help/helpViewer.ts';
import { HOSTING_HELP } from '../../shared/helpCatalog.ts';
import { PRIVATE_LINKS_HELP, checkClientId, checkRelayUrl, privacyWarning } from '../../shared/relaySetup.ts';
import { openModelWizard } from './modelWizard.ts';
import { onboardingOpen } from './onboard/shell.ts';
import { pollObs } from './simple.ts';

/** How wizards reach the rest of the shell (set by src/ui/shell.ts). */
export interface WizNav { go(area: string): void; advanced(area: string, sub?: string): void; refresh(): void }
let nav: WizNav = { go: () => {}, advanced: () => {}, refresh: () => {} };
export function setWizardNav(n: WizNav) { nav = n; }
/** The shell's navigation, for panels that point somewhere else ("Party settings", "Pick a room"). */
export const studioNav = (): WizNav => nav;

// ---------------------------------------------------------------- shared step bits
const ok = (b: boolean) => (b ? 'ok' : '') as 'ok' | '';
function camBox(app: App, ctx: WizCtx) {
  const box = h('div', { class: 'wiz-cam' });
  if (!app.trackingOn) {
    box.append(h('div', { class: 'off' }, app.observer ? 'Observer sandbox: the camera stays off here. In the real studio you would see yourself in this box.' : 'Your camera picture shows up here once it’s on.'));
    return box;
  }
  let v = ctx.data.video as HTMLVideoElement | undefined;
  if (!v || (v.srcObject !== app.video.video.srcObject)) { v = cameraMirror(app); ctx.data.video = v; }
  v.classList.toggle('mirror', app.tune.mirror);
  box.append(v, h('div', { class: 'guide', title: 'Keep your face inside the oval' }));
  return box;
}
function checksBox(app: App) {
  const box = h('div', { class: 'wiz-checks', 'aria-live': 'polite' });
  const paint = () => box.replaceChildren(...faceChecks(app).map((c) => h('div', { class: `wiz-check ${c.state === 'idle' ? '' : c.state}` },
    h('span', { class: 'ic' }, c.state === 'ok' ? '✓' : c.state === 'idle' ? '·' : '!'), h('div', null, h('b', null, c.title), h('span', null, c.detail)))));
  paint();
  live(() => { if (!box.isConnected) return false; paint(); return true; });
  return box;
}
const steps = (...li: (string | Node | (string | Node)[])[]) => h('ol', { class: 's-steps' }, ...li.map((x) => h('li', null, h('span', null, ...(Array.isArray(x) ? x : [x])))));
const b = (t: string) => h('b', null, t);
const link = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', style: 'color:var(--accent2);font-weight:600' }, text);
const j = async <T>(r: Response) => { const body = await r.json().catch(() => ({})); if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`); return body as T; };
const post = (url: string, body: unknown, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ================================================================ FIRST-TIME SETUP
function firstRun(app: App): WizDef {
  const steps_: WizStep[] = [
    {
      id: 'welcome', title: 'Welcome',
      render: (ctx, el) => add(el, h('div', { style: 'margin-bottom:10px' }, brandMark('tile', 48)), ...wizHead('Welcome to VTube Pro', 'Let’s get you streaming. About 5 minutes. Every step is optional: skip anything and come back later from Home or Settings → Guided set-ups.'),
        observerNote(app) ?? '',
        h('div', { class: 's-list' },
          item('', '☺', 'Your avatar', 'Pick one, bring your own VRoid model, or make one with AI.'),
          item('', '📷', 'Your camera', 'Pick it and check your lighting — your face drives the avatar.'),
          item('', '🎤', 'Your microphone', 'So the mouth follows your voice too.'),
          item('', '🗣', 'Your voice & faces', 'A quick 45-second test so the avatar reads YOUR expressions.'),
          item('', '📺', 'OBS', 'The exact settings to paste, so your avatar appears on stream.'),
          item('', '🏠', 'A room', 'Stream from a 3D room, or keep a see-through background.')),
        h('p', { class: 'note', style: 'margin-top:12px' }, // (truth: they DO come back by themselves on the next visit when left on: say so)
          'The camera and mic start only when you click their buttons. If you leave them on, they turn back on the next time you open the studio.')),
      nextLabel: 'Let’s go',
    },
    {
      id: 'avatar', title: 'Avatar',
      isDone: () => !!app.profile,
      render: (ctx, el) => {
        const list = ctx.data.avatars as AvatarProfile[] | undefined;
        if (!list) void api.avatars().then((l) => { ctx.data.avatars = l.filter((a) => a.source !== 'builtin-test'); ctx.refresh(); }).catch(() => { ctx.data.avatars = []; ctx.refresh(); });
        const p = app.profile;
        add(el, ...wizHead('Pick your avatar', 'Click one to wear it. You can change any time in Me.'),
          list ? h('div', { class: 's-grid', style: 'grid-template-columns:repeat(5,1fr)' }, ...list.map((a) => h('button', { class: `s-tile ${p?.id === a.id ? 'on' : ''}`, 'aria-pressed': String(p?.id === a.id), onClick: () => { if (p?.id !== a.id) void app.loadAvatar(a.id).then(() => ctx.refresh()); } },
            a.thumbnail ? h('img', { class: 'img', src: api.fileUrl(a, a.thumbnail), alt: '', loading: 'lazy' }) : h('div', { class: 'img' }, '☺'), p?.id === a.id ? h('span', { class: 'check' }, '✓') : null, h('span', { class: 'nm' }, a.name)))) : h('p', { class: 'note' }, 'Loading avatars…'),
          h('div', { class: 's-row', style: 'margin-top:12px' },
            // "Add my model" (src/ui/modelWizard.ts): first-time setup steps aside while it runs, then comes back
            button('Bring my own model…', () => { openModelWizard(app, { onDone: () => { ctx.data.avatars = undefined; } }); ctx.minimize('Adding your model…', () => !onboardingOpen()); }, 'primary'),
            button('Make one with AI…', () => { ctx.close(); nav.go('create'); })));
      },
    },
    {
      id: 'camera', title: 'Camera',
      isDone: () => app.trackingOn,
      render: (ctx, el) => {
        const list = ctx.data.cams as Awaited<ReturnType<typeof cameras>> | undefined;
        if (!list) void cameras().then((c) => { ctx.data.cams = c; ctx.refresh(); });
        const cur = (ctx.data.cam as string | undefined) ?? (list ? savedCamera(list)?.deviceId : undefined);
        const sel = h('select', { 'aria-label': 'Camera', onChange: (e: Event) => { ctx.data.cam = (e.target as HTMLSelectElement).value; } },
          ...(list?.length ? list.map((c) => h('option', { value: c.deviceId, selected: c.deviceId === cur }, c.label || 'Camera')) : [h('option', null, list ? 'No camera found' : 'Looking for cameras…')]));
        const res = (ctx.data.res as number | undefined) ?? Number(localStorage.getItem('vtp.res') ?? 2);
        add(el, ...wizHead('Pick your camera', 'Any webcam works, no iPhone or depth camera needed. It only moves your avatar: viewers see your avatar, not your camera picture. Put it at eye level, about an arm’s length away.'),
          h('div', { class: 'wiz-cols' }, camBox(app, ctx), h('div', null,
            h('label', { class: 's-field' }, h('span', null, 'Camera'), sel),
            h('div', { class: 's-field' }, h('span', null, 'Picture quality'), seg<string>([['1', 'Smooth', '720p · lighter'], ['2', 'Sharp', '1080p · best']], String(res === 1 ? 1 : 2), (v) => { ctx.data.res = +v; ctx.refresh(); })),
            h('div', { class: 's-row', style: 'margin-top:10px' },
              button(app.trackingOn ? 'Use this camera' : '📷 Turn on camera', async () => {
                if (app.trackingOn) app.stopTracking();
                await startCamera(app, (ctx.data.cam as string | undefined) ?? sel.value, (ctx.data.res as number | undefined) ?? res);
                ctx.refresh();
              }, 'primary')),
            h('p', { class: 'note' }, app.trackingOn ? `✓ On: ${app.stats.camera}` : 'Your browser asks to use your camera the first time: click Allow. That only lets this studio page see your face, to move your avatar.'))));
      },
      live: (ctx) => { const on = ctx.data.wasOn; if (on !== app.trackingOn) { ctx.data.wasOn = app.trackingOn; ctx.refresh(); } },
      blocker: () => (app.trackingOn || app.observer ? null : 'Turn the camera on (or skip this step)'),
    },
    {
      id: 'light', title: 'Lighting & framing',
      render: (ctx, el) => add(el, ...wizHead('Check your lighting & framing', 'Good light on your face is the #1 thing that makes tracking smooth. Fix anything marked below, it updates live.'),
        h('div', { class: 'wiz-cols' }, camBox(app, ctx), h('div', null, checksBox(app),
          h('p', { class: 'note', style: 'margin-top:10px' }, 'Tips: a lamp behind your screen pointing at you works wonders. Avoid a bright window behind you. Glasses and beards are fine.'),
          app.trackingOn ? h('div', { class: 's-row' }, button('Set my neutral face (2 s)', async () => { toast('Relax your face and look at the screen…'); await app.face.calibrate(2); toast('Neutral face set ✓', 'ok'); })) : null))),
      live: (ctx) => { if (ctx.data.wasOn !== app.trackingOn) { ctx.data.wasOn = app.trackingOn; ctx.refresh(); } },
    },
    {
      id: 'mic', title: 'Microphone',
      isDone: () => app.audio.active,
      render: (ctx, el) => {
        const list = ctx.data.mics as Awaited<ReturnType<typeof mics>> | undefined;
        if (!list) void mics().then((m) => { ctx.data.mics = m; ctx.refresh(); });
        const cur = (ctx.data.mic as string | undefined) ?? (list ? savedMic(list)?.deviceId : undefined);
        const sel = h('select', { 'aria-label': 'Microphone', onChange: (e: Event) => { ctx.data.mic = (e.target as HTMLSelectElement).value; } },
          ...(list?.length ? list.map((m) => h('option', { value: m.deviceId, selected: m.deviceId === cur }, m.label || 'Microphone')) : [h('option', null, list ? 'No microphone found' : 'Looking…')]));
        const bar = h('i', { style: 'width:0%' });
        live(() => { if (!bar.isConnected) return false; bar.style.width = `${Math.round(micLevel(app) * 100)}%`; return true; });
        add(el, ...wizHead('Pick your microphone', 'The avatar’s mouth follows your voice as well as your lips — great when your hand is in front of your face or the room is dark. Your voice stays on this computer. It goes out only when you have guests or join a party: then they hear you.'),
          h('label', { class: 's-field' }, h('span', null, 'Microphone'), sel),
          h('div', { class: 's-row', style: 'margin:8px 0 14px' }, button(app.audio.active ? 'Use this microphone' : '🎤 Turn on microphone', async () => {
            if (app.audio.active) app.audio.stop();
            await startMic(app, (ctx.data.mic as string | undefined) ?? sel.value); ctx.refresh();
          }, 'primary'), app.audio.active ? h('span', { class: 's-badge ok' }, `on · ${app.audio.deviceLabel || 'mic'}`) : null),
          h('div', { class: 's-field' }, h('span', null, 'Say something — this bar should jump'), h('div', { class: 's-meter' }, bar)),
          h('p', { class: 'note' }, 'Use the same microphone you stream with. Nothing moving? Click the icon at the left of the address bar and allow the microphone. On Windows also check Settings → Privacy & security → Microphone, and that the mic isn’t muted.'));
      },
      live: (ctx) => { if (ctx.data.micOn !== app.audio.active) { ctx.data.micOn = app.audio.active; ctx.refresh(); } },
    },
    {
      id: 'voice', title: 'Voice & expressions',
      render: (ctx, el) => {
        const noise = ctx.data.noise as string | undefined;
        add(el, ...wizHead('Teach it your voice and faces', 'Two quick things make the avatar feel like YOU. It is saved for you, not per avatar — every avatar is ready after one run.'),
          card('1 · Room noise (3 seconds)', 'Stay quiet so it learns your fan, keyboard and room hum — then only your voice moves the mouth.',
            h('div', { class: 's-row' }, button('Calibrate room noise', async (e) => {
              if (!app.audio.active) { toast('Turn the microphone on first (previous step)', 'warn'); return; }
              const bt = e.currentTarget as HTMLButtonElement; bt.disabled = true; bt.textContent = 'Stay quiet… 3 s';
              try { const r = await app.audio.calibrateNoise(3); ctx.data.noise = r.pP90 > 0.5 ? 'I heard a voice (TV, someone talking?). Try again when it is quiet.' : `✓ Learned your room (${Math.round(r.rawFloor)} dB).`; }
              catch (err) { ctx.data.noise = `✕ ${(err as Error).message}`; }
              ctx.refresh();
            }, app.audio.active ? 'primary' : ''), noise ? h('span', { class: 'note', style: 'margin:0' }, noise) : !app.audio.active ? h('span', { class: 'note', style: 'margin:0' }, 'Needs the microphone.') : null)),
          card('2 · The 45-second test', 'Prompts appear over your avatar: relax, smile, grin, sad, angry, surprised, kiss, puff, smirk, talk' + (app.audio.active ? ', then a few held sounds (AAH, EEE, SSS…).' : '.') + ' Just copy them.',
            h('div', { class: 's-row' }, button(app.setupRunning ? 'Running…' : '▶ Start the test', () => {
              if (!app.trackingOn) { toast('Turn the camera on first (step 2)', 'warn'); return; }
              void app.runSetupTest();
              ctx.data.tested = true;
              ctx.minimize('Follow the prompts on screen — the setup comes back when the test ends', () => !app.setupRunning);
            }, app.trackingOn ? 'primary' : ''), ctx.data.tested && !app.setupRunning ? h('span', { class: 's-badge ok' }, 'done') : null, !app.trackingOn ? h('span', { class: 'note', style: 'margin:0' }, 'Needs the camera.') : null)),
          card('3 · Best lip sync for me', 'Not sure what to pick? We check your model, computer, mic and camera, then set it up.',
            h('div', { class: 's-row' }, button('Find my best lip sync', () => openLipSyncGuide(app, { from: 'first-run', nav: { go: (a) => nav.go(a), advanced: (a, s) => nav.advanced(a, s) } }), 'primary'))),
          betterLipSyncCard(app, () => ctx.refresh(), { title: 'Or choose yourself: Better lip sync' }),
          card('4 · Keep learning me (optional)', LEARNME_PRIVACY + ' Off unless you switch it on; you can pause it or delete everything any time (Tracking → Advanced → Voice, phone & 2nd camera).', learnMeToggle(app, () => ctx.refresh())),
          h('p', { class: 'note' }, 'Turn “Better” on BEFORE the 45-second test: the test then also tunes the voice model to you.'));
      },
    },
    {
      id: 'obs', title: 'OBS',
      // real state: an output page (the OBS Browser Source) has said hello to the studio (pollObs, src/ui/simple.ts)
      isDone: () => pollObs() > 0,
      live: (ctx) => { const on = pollObs() > 0; if (ctx.data.obsSeen !== on) { ctx.data.obsSeen = on; ctx.refresh(); } },
      render: (ctx, el) => {
        const [W, H] = (ctx.data.canvas as [number, number] | undefined) ?? [1920, 1080];
        const probe = ctx.data.obsCheck as string | undefined;
        // lane obs-wizard: the step-by-step "Set up OBS" (src/ui/obsWizard.ts) is the main path; the copy steps stay below
        add(el, ...wizHead('Show your avatar in OBS', 'OBS is the free app that sends your picture to Twitch, YouTube or Kick. VTube Pro never streams by itself: you start your stream in OBS. Our step-by-step OBS setup adds VTube Pro to OBS for you and sets up your stream scenes.'),
          pollObs() > 0 ? h('div', { class: 's-banner', role: 'status', 'data-ui': 'wiz-obs-connected' }, h('b', null, '✓ Connected'), ' VTube Pro is showing in OBS. Nothing to click here.') : null,
          h('div', { class: 's-row', style: 'margin:6px 0 10px' }, button('Set up OBS step by step', () => void import('./obsWizard.ts').then((m) => m.openObsWizard()), 'primary')),
          h('details', null, h('summary', null, 'Or add it by hand'),
          h('p', { class: 'note' }, 'Add one Browser Source. Copy each value into OBS. The background is see-through, so your avatar sits on top of your game or camera.'),
          h('div', { class: 's-field' }, h('span', null, 'Your OBS canvas size (OBS → Settings → Video → Base resolution)'), h('div', { class: 's-pills' },
            ...([[1920, 1080, '1080p'], [2560, 1440, '1440p'], [1280, 720, '720p'], [1080, 1920, 'Vertical']] as const).map(([w, hh, l]) => pill(W === w && H === hh, `${l} · ${w}×${hh}`, () => { ctx.data.canvas = [w, hh]; ctx.refresh(); })))),
          steps(
            ['In OBS: ', b('Sources'), ' → ', b('+'), ' → ', b('Browser'), ' → name it “VTube Pro” → OK.'],
            ['Paste the ', b('URL'), ':', copyRow('URL', OBS_URL, 'The URL')],
            ['Set ', b('Width'), ' and ', b('Height'), ':', h('div', { class: 's-grid two' }, copyRow('Width', String(W)), copyRow('Height', String(H)))],
            ['Tick ', b('Use custom frame rate'), ' and set it to ', b('60'), '.', copyRow('FPS', '60')],
            ['Untick ', b('Shutdown source when not visible'), ' and ', b('Refresh browser when scene becomes active'), ' — so your avatar stays warm between scenes. Click OK.'],
            ['Check OBS → ', b('Settings'), ' → ', b('Advanced'), ' → ', b('Sources'), ': ', b('Enable Browser Source Hardware Acceleration'), ' must be ON (restart OBS if you change it).'],
          ),
          h('div', { class: 's-row', style: 'margin:6px 0' }, button('Check the connection', async () => {
            try { const s = await (await fetch('/api/setup/status', { cache: 'no-store' })).json() as { busClients: number; outputs?: { count: number } }; const n = typeof s.outputs?.count === 'number' ? s.outputs.count : Math.max(0, s.busClients - 1); ctx.data.obsCheck = n > 0 ? `✓ Connected — ${n} output page${n > 1 ? 's are' : ' is'} listening.` : 'Not seen yet. Is the Browser Source visible in your OBS scene?'; }
            catch { ctx.data.obsCheck = 'Couldn’t reach the studio server.'; }
            ctx.refresh();
          }), probe ? h('span', { class: 'note', style: 'margin:0' }, probe) : null),
          obsAutomation(app, ctx)));
      },
    },
    {
      id: 'room', title: 'Room',
      isDone: () => !!app.scene.effective.sceneId,
      // premium pass: pick where you stream from, right in the first-time setup (no room = a see-through background)
      render: (ctx, el) => {
        add(el, ...wizHead('Pick a room', 'Your avatar can stream from a 3D room, or float on a see-through background over your game or camera. Click a room to switch; you can change it any time in Room.'), observerNote(app) ?? '');
        if (app.scene.canEdit) add(el, roomPicker(app, { where: 'wizard', alwaysOpen: true, onPick: () => ctx.refresh() }));
        else add(el, h('p', { class: 'note' }, 'You are a guest in a party: the host picks the room.'));
      },
      live: (ctx) => { const sid = app.scene.effective.sceneId ?? ''; if (ctx.data.sid !== sid) { ctx.data.sid = sid; ctx.refresh(); } },
    },
    {
      id: 'done', title: 'All set',
      render: (ctx, el) => {
        // every row below reads the real state (never "Next was pressed"): FR-01
        const obsSeen = pollObs() > 0;
        // (nothing is really set up: don't congratulate and say "start streaming")
        const skipped = !app.trackingOn && !app.audio.active && !obsSeen && !app.scene.effective.sceneId;
        // (only a full set of real states says "all set": a skipped camera or OBS is named, not celebrated)
        const complete = !!app.profile && (app.trackingOn || app.observer) && obsSeen;
        add(el, ...(skipped ? wizHead('Setup skipped for now', 'Your avatar is ready. To stream: turn on your camera, then add VTube Pro to OBS (Home shows how).')
          : !complete ? wizHead('Saved: a few things are still open', 'What is not ready is listed below. Home shows what is left, and “Continue setup” brings you back here.')
          : wizHead('You’re all set 🎉', 'Start streaming in OBS when you’re ready. Home always shows whether the camera, mic and OBS are working.')),
          h('div', { class: 's-list' },
            item(ok(app.trackingOn), '📷', app.trackingOn ? 'Camera on' : 'Camera off', app.trackingOn ? 'Tracking your face.' : 'Turn it on any time in Tracking or Home.'),
            item(ok(app.audio.active), '🎤', app.audio.active ? 'Microphone on' : 'Microphone off', 'Optional.'),
            item(ok(!!ctx.data.tested), '🗣', 'Voice & faces', ctx.data.tested ? 'Learned.' : 'Run the test later from Tracking → How it feels.'),
            item(ok(!!app.profile), '☺', app.profile ? `Avatar: ${app.profile.name}` : 'No avatar', 'Change it in Me.'),
            item(ok(obsSeen), '📺', obsSeen ? 'OBS: Connected' : 'OBS: not added yet', obsSeen ? 'VTube Pro is showing in OBS.' : 'Not added yet. Copy the OBS link on Home.'),
            item(ok(!!app.scene.effective.sceneId), '🏠', app.scene.effective.sceneId ? `Room: ${app.scene.scenes.find((x) => x.id === app.scene.effective.sceneId)?.name ?? ''}` : 'No room', app.scene.effective.sceneId ? 'Change it any time in Room.' : 'A see-through background. Pick a room any time in Room.')),
          h('p', { class: 'note', style: 'margin-top:14px' }, 'What next?'),
          h('div', { class: 's-row' },
            button(app.scene.effective.sceneId ? 'Set up the room’s mode & lights' : 'Put me in a 3D room', () => { ctx.close(); openNamed(app, 'room'); }),
            button('Set up my chat & stream', () => { ctx.close(); openNamed(app, 'chat'); }),
            button('Stream with friends', () => { ctx.close(); openNamed(app, 'multiplayer'); })));
      },
      live: (ctx) => { const k = `${pollObs() > 0}|${app.trackingOn}|${app.audio.active}`; if (ctx.data.doneSig !== k) { ctx.data.doneSig = k; ctx.refresh(); } },
      nextLabel: 'Go to Home',
    },
  ];
  return { id: 'firstRun', title: 'First-time setup', blurb: 'Avatar, camera, lighting, mic, voice, OBS and a room.', steps: steps_, onFinish: () => nav.go('home') };
}

function obsAutomation(app: App, ctx: WizCtx) {
  const d = ctx.data as { obsUrl?: string; obsPw?: string; obsMsg?: string; obsOpen?: boolean };
  const url = h('input', { type: 'text', value: d.obsUrl ?? 'ws://127.0.0.1:4455', 'aria-label': 'OBS WebSocket address', onInput: (e: Event) => (d.obsUrl = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
  const pw = h('input', { type: 'password', value: d.obsPw ?? '', autocomplete: 'off', placeholder: 'Server password (from the same OBS window)', 'aria-label': 'OBS WebSocket password', onInput: (e: Event) => (d.obsPw = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
  const det = h('details', { open: !!d.obsOpen, onToggle: (e: Event) => (d.obsOpen = (e.target as HTMLDetailsElement).open) } as never,
    h('summary', null, 'Optional: let VTube Pro switch OBS scenes and line up the react screen'),
    h('p', { class: 'note' }, 'In OBS: ', b('Tools'), ' → ', b('WebSocket Server Settings'), ' → tick ', b('Enable WebSocket server'), ' → ', b('Show Connect Info'), '. Copy the password here.'),
    h('label', { class: 's-field' }, h('span', null, 'Address'), url),
    h('label', { class: 's-field' }, h('span', null, 'Password'), pw),
    h('div', { class: 's-row' },
      button('Test connection', async () => {
        if (app.observer) { d.obsMsg = 'Observer sandbox: not tested.'; ctx.refresh(); return; }
        d.obsMsg = 'Connecting…'; ctx.refresh();
        try {
          const p = await j<ObsProbe>(await post('/api/obs/probe', { url: url.value.trim(), password: pw.value || undefined }));
          d.obsMsg = p.ok ? `✓ Connected to OBS (${p.scenes?.length ?? 0} scenes, canvas ${p.canvas?.width}×${p.canvas?.height}).` : `✕ ${p.error ?? 'failed'}`;
        } catch (e) { d.obsMsg = `✕ ${(e as Error).message}`; }
        ctx.refresh();
      }),
      button('Save & turn on', async () => {
        if (app.observer) { toast('Observer sandbox: OBS settings are not saved', 'warn'); return; }
        try { await j(await post('/api/obs', { enabled: true, url: url.value.trim(), ...(pw.value ? { password: pw.value } : {}) }, 'PUT')); d.obsPw = ''; d.obsMsg = '✓ Saved. VTube Pro will talk to OBS when you switch to React.'; }
        catch (e) { d.obsMsg = `✕ ${(e as Error).message}`; }
        ctx.refresh();
      }, 'primary'),
      d.obsMsg ? h('span', { class: 'note', style: 'margin:0' }, d.obsMsg) : null),
    h('p', { class: 'note' }, 'The password stays in config/obs.json on this PC. More options: OBS → OBS automation.'));
  return det;
}

// ================================================================ ROOM
const QUICK_PRESETS = ['chill_lounge', 'candlelight', 'neon_noir', 'club_classic', 'horror_red', 'movie_night'];
function roomWizard(app: App): WizDef {
  const S = app.scene;
  S.trackingProbe ??= () => app.trackingOn;   // (its preview frame: src/scene/previewLink.ts PreviewGate)
  const info = () => (S.effective.sceneId ? S.scenes.find((x) => x.id === S.effective.sceneId) ?? null : null);
  const needRoom = () => (info() ? null : 'Pick a room first (or skip)');
  const guard = (el: HTMLElement) => { if (!S.canEdit) { add(el, h('div', { class: 's-banner warn' }, 'You are a guest: the host runs the room.')); return true; } return false; };
  const def: WizDef = {
    id: 'room', title: 'Set up a room', blurb: 'Pick a 3D room, then its mode, lights, sky and action. Your OBS shows every change.',
    persistent: () => h('div', { style: 'margin:0 0 14px' }, h('div', { class: 's-prev', style: 'max-height:240px' }, h('iframe', { src: '/output.html?preview=1&fps=15&tier=medium', title: 'Room preview', allow: 'display-capture' })), h('p', { class: 'note', style: 'margin:4px 0 0' }, 'Preview of your room, as OBS will show it. Only you see this.')),
    steps: [
      {
        id: 'pick', title: 'Pick a room', persistent: true,
        render: (ctx, el) => {
          add(el, ...wizHead('Where are you streaming from?', 'Describe it, or click a room below. It switches right away — try a few.'), observerNote(app) ?? '');
          if (guard(el)) return;
          add(el, card('✨ Describe your room', null, roomPrompter(app, () => ctx.refresh(), { compact: true })),
            roomPicker(app, { where: 'wizard', alwaysOpen: true, onPick: () => ctx.refresh() }));
        },
      },
      {
        id: 'mode', title: 'Talk or React', persistent: true, blocker: needRoom,
        render: (ctx, el) => {
          add(el, ...wizHead('Talk or React?', 'Talk: the camera is on you. React: a big screen comes down showing a window you pick (a video, a game) and the camera turns to it.'));
          if (guard(el)) return;
          const m = S.effective.mode;
          add(el, h('div', { class: 'wiz-choice' },
            h('button', { class: `wiz-opt ${m === 'talk' ? 'on' : ''}`, onClick: () => { S.setMode('talk'); ctx.refresh(); } }, h('b', null, '🎙 Talk'), h('span', null, 'Just chatting. Your avatar is the star.')),
            h('button', { class: `wiz-opt ${m === 'react' ? 'on' : ''}`, onClick: () => { S.setMode('react'); ctx.refresh(); } }, h('b', null, '🖥 React'), h('span', null, 'Watching something together. Pick the window in the next set-up (“Set up the react screen”).'))),
            h('p', { class: 'note', style: 'margin-top:10px' }, 'Switch any time from the Room area — or bind it to a Stream Deck button.'));
        },
      },
      {
        id: 'lights', title: 'Lights', persistent: true, blocker: needRoom,
        render: (ctx, el) => {
          add(el, ...wizHead('Set the mood', 'The big buttons are lighting “states” for your show — Starting soon, the normal Show, React, BRB and the Outro. Below them, pick a colour style.'));
          if (guard(el)) return;
          const cur = S.effective.lights.state ?? 'show';
          add(el, seg(LIGHTING_STATES.map((s): [string, string, string] => [s.id, s.label, `Shift+${s.key}`]), cur, (v) => { S.setLighting(v); ctx.refresh(); }),
            h('div', { class: 's-field', style: 'margin-top:14px' }, h('span', null, 'Colour style'), h('div', { class: 's-pills' },
              pill(S.effective.lights.program === 'show', '🏠 The room’s own', () => { S.setLights({ program: 'show', groups: undefined }); ctx.refresh(); }),
              ...QUICK_PRESETS.map((id) => presetById(id)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => pill(S.effective.lights.program === `p_${p.id}`, p.name, () => { S.setLights({ program: `p_${p.id}`, groups: undefined }); ctx.refresh(); }, p.vibe)))),
            h('p', { class: 'note' }, '50 more looks, music-reactive lights and every fixture: Room → Advanced → Lights.'));
        },
      },
      {
        id: 'sky', title: 'Time & weather', persistent: true, hidden: () => !info()?.environment,
        render: (ctx, el) => {
          add(el, ...wizHead('Time of day & weather', 'This room has a real sky. Lamps and windows light up by themselves when it gets dark.'));
          if (guard(el)) return;
          add(el, envQuick(app));
        },
      },
      {
        id: 'action', title: 'Background action', persistent: true, hidden: () => !info()?.raid && !info()?.space,
        render: (ctx, el) => {
          const sp = !!info()?.space;
          add(el, ...wizHead(sp ? 'Space battle' : 'Background action', sp ? 'A battle plays outside the window. Donations can call in orbital strikes.' : 'Soldiers skirmish far in the background — never in front of your face or the screen. Donations can trigger a big event.'));
          if (guard(el)) return;
          add(el, actionQuick(app, sp));
        },
      },
      {
        id: 'done', title: 'Done',
        render: (ctx, el) => add(el, ...wizHead('Your room is ready 🏠', 'OBS already shows it — no OBS change needed (the same Browser Source shows the room).'),
          h('div', { class: 's-row' }, button('Set up the react screen', () => { ctx.close(); openNamed(app, 'react'); }), button('Set up my chat & stream', () => { ctx.close(); openNamed(app, 'chat'); }),
            button('Move seats, cameras & lights (Advanced)', () => { ctx.close(); nav.advanced('room', 'scene'); }, 'ghost'))),
        nextLabel: 'Finish',
      },
    ],
    onFinish: () => nav.go('room'),
  };
  return def;
}

// ================================================================ MULTIPLAYER (DISCORD)
// Written for someone who has never used a terminal: every step says where to click, what the value looks like and
// links its section of docs/HOSTING_SETUP.md (Help viewer). Pasted values are checked by shared/relaySetup.ts.
const guide = (target: string, text = 'Show me this step in the guide') => button(`📖 ${text}`, () => openHelp(target));
/** The helper's local "Set up my invite server" page (server/routes/relaySetup.ts). It handles a Cloudflare key, so it
 *  only opens as a page on this computer. */
const inviteServerPage = () => (location.port === '5191' && /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? '/invite-server' : 'http://127.0.0.1:5191/invite-server');
function mpWizard(app: App): WizDef {
  const d = {} as { st?: DiscordStatus | null; relay?: string; client?: string; probe?: string };
  const load = (ctx: WizCtx) => { if (d.st === undefined) { d.st = null; void discord.status().then((s) => { d.st = s; d.relay ??= s.relayUrl; d.client ??= s.clientId; ctx.refresh(); }).catch(() => {}); } };
  return {
    id: 'multiplayer', title: 'Set up multiplayer', blurb: 'Host parties and interview guests with your own free invite server and your own Discord app. One time, about 10 minutes. Guests need nothing.',
    steps: [
      {
        id: 'how', title: 'How it works',
        render: (ctx, el) => { load(ctx); add(el, ...wizHead('Stream together with friends', 'Party guests run VTube Pro on their own PC; interview guests only need a browser. Every OBS shows the whole party, up to 8 people.'),
          h('div', { class: 's-list' },
            item('', '1', 'A free Cloudflare account', 'Your invite server runs there, free. Sign up takes two minutes.'),
            item('', '2', 'Your own Discord app', 'A free app you make at discord.com/developers. You and your guests sign in with it. You copy its Client ID and Client Secret.'),
            item('', '3', 'Your invite server', 'VTube Pro builds it for you on your Cloudflare account and puts your Discord app’s ID and secret on it. Nothing to install.'),
            item('', '4', 'Sign in with Discord', 'That makes you the host. VTube Pro fills in your host code for you.')),
          h('p', { class: 'note', style: 'margin-top:12px' }, 'Everything is yours: your Cloudflare account and your Discord app. Nothing goes through anyone else’s server. Only the host does this. Joining a friend needs no setup. It costs nothing on the free plans (the guide explains the limits).'),
          h('div', { class: 's-row' }, guide(HOSTING_HELP.overview, 'Open the step-by-step guide')),
          d.st?.configured ? h('div', { class: 's-banner' }, '✓ Discord is already set up on this PC. You can jump to “Sign in”.') : null); },
      },
      {
        id: 'server', title: 'Invite server',
        render: (ctx, el) => { load(ctx); add(el, ...wizHead('Set up your invite server', 'Your guests join through it. VTube Pro puts it on your own free Cloudflare account.'),
          steps(
            ['Press ', b('Set up my invite server'), '. A VTube Pro page opens in your browser.'],
            ['Follow its big buttons: connect Cloudflare, paste your Discord app’s Client ID and Client Secret, build, and sign in with Discord.'],
            ['When it says ', b('Your invite server is ready ✔'), ', come back here. It’s already saved.'],
          ),
          h('div', { class: 's-row' }, button('Set up my invite server', () => { window.open(inviteServerPage(), '_blank', 'noopener'); toast('Finish the steps in VTube Pro’s page, then come back here', 'info', 7000); }, 'primary'),
            button('I’m done — check', () => { d.st = undefined; load(ctx); })),
          d.st?.configured ? h('div', { class: 's-banner' }, '✓ Your invite server is saved on this computer.') : null,
          h('p', { class: 'note' }, 'Free Cloudflare account needed (no card for this). It never sees your avatars: they go straight between computers, encrypted.'),
          h('div', { class: 's-row' }, guide(HOSTING_HELP.relay), guide(HOSTING_HELP.troubleshooting, 'It went wrong'))); },
      },
      {
        id: 'connect', title: 'Paste & test',
        render: (ctx, el) => {
          load(ctx);
          const hint = h('div', { 'aria-live': 'polite' });
          const paint = () => {
            const r = (d.relay ?? '').trim(), c = (d.client ?? '').trim();
            const rc = r ? checkRelayUrl(r) : null, cc = c ? checkClientId(c) : null;
            const out: Node[] = [];
            if (rc && !rc.ok) out.push(h('p', { class: 'note', style: 'color:#f5c451' }, `Relay address: ${rc.error}`));
            if (rc?.ok) {
              if (rc.note) out.push(h('p', { class: 'note' }, rc.note));
              // your own Discord app needs both redirects (OAuth2 → Redirects)
              if (cc?.ok) out.push(h('p', { class: 'note' }, 'Your Discord app → ', h('b', null, 'OAuth2 → Redirects'), ' needs both of these:'),
                copyRow('Guests', rc.redirect), copyRow('You', 'http://127.0.0.1:5191/api/discord/callback'));
              const warn = privacyWarning(rc.privacy);
              if (warn) out.push(h('div', { class: 's-banner warn' }, h('span', null, '🔒'), h('span', null, warn, ' '), button('Private links', () => openHelp(PRIVATE_LINKS_HELP))));
            }
            if (cc && !cc.ok) out.push(h('p', { class: 'note', style: 'color:#f5c451' }, `Client ID: ${cc.error}`));
            hint.replaceChildren(...out);
          };
          const relay = h('input', { type: 'url', value: d.relay ?? '', placeholder: 'https://vtube-pro-relay.<name>.workers.dev', 'aria-label': 'Relay address', onInput: (e: Event) => { d.relay = (e.target as HTMLInputElement).value; paint(); } }) as HTMLInputElement;
          const client = h('input', { type: 'text', value: d.client ?? '', placeholder: 'Discord Client ID (only digits)', 'aria-label': 'Client ID', inputMode: 'numeric', onInput: (e: Event) => { d.client = (e.target as HTMLInputElement).value; paint(); } }) as HTMLInputElement;
          paint();
          add(el, ...wizHead('Check your invite server', d.st?.configured ? 'VTube Pro saved it for you. Press Test to check it answers.' : 'Set it up in the previous step, or paste an address you already have.'),
            h('label', { class: 's-field' }, h('span', null, 'Relay address'), relay),
            h('label', { class: 's-field' }, h('span', null, 'Your Discord app’s Client ID'), client),
            h('p', { class: 'note' }, 'The Client Secret goes only into your invite server (VTube Pro’s page asks for it). Never paste it here.'),
            hint,
            h('div', { class: 's-row' },
              button('Test the relay', async () => {
                const rc = checkRelayUrl(relay.value);
                if (!rc.ok) { d.probe = `✕ ${rc.error}`; ctx.refresh(); return; }
                d.probe = 'Testing…'; ctx.refresh();
                try { const r = await j<{ ok: boolean; error?: string }>(await post('/api/setup/probe-relay', { url: rc.origin })); d.probe = r.ok ? '✓ The relay is up and answering.' : `✕ ${r.error} (Help: the guide’s Troubleshooting)`; }
                catch (e) { d.probe = `✕ ${(e as Error).message}`; }
                ctx.refresh();
              }),
              button('Save', async () => {
                if (app.observer) { toast('Observer sandbox: not saved', 'warn'); return; }
                const rc = checkRelayUrl(relay.value), cc = checkClientId(client.value);
                if (!rc.ok) { toast(rc.error, 'warn', 8000); return; }
                if (!cc.ok) { toast(cc.error, 'warn', 8000); return; }
                d.relay = rc.origin; d.client = cc.id;
                try { d.st = await discord.save({ relayUrl: rc.origin, clientId: cc.id }); toast('Saved ✓', 'ok'); } catch (e) { toast((e as Error).message, 'err', 6000); }
                ctx.refresh();
              }, 'primary'),
              d.probe ? h('span', { class: 'note', style: 'margin:0' }, d.probe) : null),
            d.st?.configured ? h('p', { class: 'note' }, '✓ Saved on this PC.') : null,
            h('div', { class: 's-row' }, guide(HOSTING_HELP.paste)));
        },
      },
      {
        id: 'signin', title: 'Sign in',
        render: (ctx, el) => {
          load(ctx);
          const st = d.st;
          // claim your relay: after the first sign-in, type the code the relay setup window showed
          const code = h('input', { type: 'text', placeholder: 'e.g. K7QF-M2XR', 'aria-label': 'Claim code', autocomplete: 'off', style: 'font-size:22px;letter-spacing:3px;text-transform:uppercase;max-width:260px' }) as HTMLInputElement;
          const claimIt = async () => {
            if (!code.value.trim()) { toast('Type the claim code from the relay setup window', 'warn'); return; }
            try { d.st = await discord.claim(code.value); toast('You’re the host of your relay ✓', 'ok'); } catch (e) { toast((e as Error).message, 'warn', 8000); }
            ctx.refresh();
          };
          code.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void claimIt(); });
          add(el, ...wizHead('Sign in with Discord', 'A browser window opens: sign in with Discord there, then come back here. Nothing secret is stored on this PC.'),
            st?.signedIn ? h('div', { class: 's-banner' }, '✓ Signed in as ', safeName(st.user?.name ?? '?', 'your Discord account'))
              : st?.claim ? h('div', null,
                h('div', { class: 's-banner' }, 'Signed in as ', safeName(st.claim.name, 'your Discord account'), '. Last step: make this relay yours.'),
                h('p', null, 'Type the ', h('b', null, 'host code'), ' the invite server page showed in big letters (capitals and dashes don’t matter):'),
                h('div', { class: 's-row' }, code, button('Make me the host', () => void claimIt(), 'primary')),
                h('p', { class: 'note' }, 'Lost the code? Open Set up my invite server again and press Make a new host code.'))
              : h('div', { class: 's-row' }, button('Connect Discord', () => { if (!st?.configured) { toast('Save the relay first (previous step)', 'warn'); return; } discord.login(); toast('Finish signing in in the Discord window', 'info', 6000); }, 'primary'),
                button('I signed in — check', () => { d.st = undefined; load(ctx); })),
            h('p', { class: 'note' }, '“This relay already has its host”? Someone used the code first: open Set up my invite server, press Make a new host code, then sign in again. (“Invalid OAuth2 redirect_uri”? Add the two redirects shown in the previous step to your Discord app.)'),
            h('div', { class: 's-row' }, guide(HOSTING_HELP.troubleshooting, 'Troubleshooting')));
        },
        live: (ctx) => { const t = (ctx.data.mpAt as number | undefined) ?? 0; if (!d.st?.signedIn && Date.now() - t > 3000) { ctx.data.mpAt = Date.now(); void discord.status().then((s) => { if (s.signedIn !== d.st?.signedIn || !!s.claim !== !!d.st?.claim) { d.st = s; ctx.refresh(); } }).catch(() => {}); } },
      },
      {
        id: 'done', title: 'Go live',
        render: (ctx, el) => add(el, ...wizHead('Ready to party 🎉', 'In Party: pick the channel for your invites, then “Go live · post invite”. Friends click Join, you let them in. Interview guests: copy an interview guest link.'),
          h('div', { class: 's-banner' }, h('span', null, '💡'), h('span', null, 'Some guests (mobile data, work or school Wi-Fi, VPNs) can only connect with TURN. Setting it up takes 5 minutes and is free up to 1,000 GB a month.')),
          h('div', { class: 's-row' }, button('Open Party', () => { ctx.close(); nav.go('friends'); }, 'primary'), guide(HOSTING_HELP.turn, 'Set up TURN'))),
        nextLabel: 'Finish',
      },
    ],
    onFinish: () => nav.go('friends'),
  };
}

// ================================================================ CHAT & STREAM
// "Set up my chat & stream" has its own premium wizard (src/ui/streamSetup/*, lane stream-setup): openNamed('chat').

// ================================================================ REACT SCREEN
const SVG_INSCENE = `<svg viewBox="0 0 200 110" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="200" height="110" fill="#1b2230"/><path d="M0 80 L200 80 L200 110 L0 110Z" fill="#232b3b"/><path d="M60 18 L150 26 L150 70 L60 76Z" fill="#0c1016" stroke="#6cc7f5" stroke-width="2"/><path d="M66 25 L144 31 L144 64 L66 69Z" fill="#6cc7f5" opacity=".55"/><circle cx="36" cy="66" r="11" fill="#7bd88f"/><rect x="26" y="76" width="20" height="22" rx="6" fill="#7bd88f"/><text x="100" y="104" fill="#a3abba" font-size="9" text-anchor="middle" font-family="sans-serif">window drawn on the 3D screen</text></svg>`;
const SVG_PASS = `<svg viewBox="0 0 200 110" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="200" height="110" fill="#1b2230"/><rect x="40" y="12" width="120" height="66" rx="4" fill="#6cc7f5" opacity=".5" transform="translate(10,8)"/><text x="110" y="52" fill="#06131a" font-size="8" text-anchor="middle" font-family="sans-serif" transform="translate(0,4)">OBS Window Capture</text><rect x="40" y="12" width="120" height="66" rx="4" fill="none" stroke="#ffb454" stroke-width="2" stroke-dasharray="4 3"/><text x="100" y="9" fill="#ffb454" font-size="8" text-anchor="middle" font-family="sans-serif">a hole in the room</text><circle cx="30" cy="70" r="10" fill="#7bd88f"/><rect x="21" y="79" width="18" height="20" rx="6" fill="#7bd88f"/><text x="110" y="104" fill="#a3abba" font-size="9" text-anchor="middle" font-family="sans-serif">OBS fills the hole underneath</text></svg>`;
function svgEl(src: string) { const d = h('div'); d.innerHTML = src; return d.firstElementChild as Element; }
function reactWizard(app: App): WizDef {
  const S = app.scene;
  const shareVideo = () => { const v = h('video', { muted: true, autoplay: true, playsInline: true, style: 'width:100%;aspect-ratio:16/9;background:#000;border-radius:12px' }) as HTMLVideoElement; v.srcObject = S.captureStream; return v; };
  return {
    id: 'react', title: 'Set up the react screen', blurb: 'Show a video or game on a big screen inside your room.',
    steps: [
      {
        id: 'what', title: 'How it works',
        render: (ctx, el) => {
          const m = S.effective.screen?.mode ?? 'auto';
          add(el, ...wizHead('Two ways to show a window', 'In React mode a screen comes down in your room. VTube Pro can draw your window ON that screen (recommended), or leave a hole that OBS fills.'),
            h('div', { class: 'wiz-choice' },
              h('div', { class: `wiz-opt ${m !== 'passthrough' ? 'on' : ''}` }, svgEl(SVG_INSCENE), h('b', null, 'In-scene (recommended)'), h('span', null, 'Looks right from every camera angle, even while the camera moves, and people can stand in front of it. Nothing to set up in OBS.')),
              h('div', { class: `wiz-opt ${m === 'passthrough' ? 'on' : ''}` }, svgEl(SVG_PASS), h('b', null, 'OBS passthrough'), h('span', null, 'The old way: an OBS Window Capture under the Browser Source shows through a hole. Only lines up exactly on straight-on screens.'))),
            !S.effective.sceneId ? h('div', { class: 's-banner warn', style: 'margin-top:12px' }, 'The react screen lives in 3D rooms — pick a room first (Room area or the “Set up a room” guide).') : null);
        },
      },
      {
        id: 'pick', title: 'Pick a window',
        render: (ctx, el) => {
          add(el, ...wizHead('Pick what to show', 'Click the button, choose a window (a browser with a video, a game…) and click Share. Its sound stays in OBS as usual.'),
            h('div', { class: 'wiz-cols' },
              S.capturing ? shareVideo() : h('div', { class: 'wiz-cam' }, h('div', { class: 'off' }, 'The window you pick shows here.')),
              h('div', null,
                h('div', { class: 's-row' }, button(S.capturing ? 'Pick another window…' : '🪟 Pick a window…', async () => { try { await S.pickSource(); } catch (e) { toast(`No window picked (${(e as Error).message})`, 'warn'); } ctx.refresh(); }, 'primary', 'react-pick'),
                  S.capturing ? button('Stop sharing', () => { S.setCapture(null); ctx.refresh(); }, 'danger') : null),
                h('p', { class: 'note' }, S.capturing ? `● Sharing ${S.share.status.label || 'a window'}` : 'Browsers can’t re-open a window by themselves: after restarting the studio, pick it again (OBS shows “no signal” until then).'))));
        },
        live: (ctx) => { if (ctx.data.cap !== S.capturing) { ctx.data.cap = S.capturing; ctx.refresh(); } },
      },
      {
        id: 'mode', title: 'In-scene or passthrough',
        render: (ctx, el) => {
          const m = S.effective.screen?.mode ?? 'auto';
          add(el, ...wizHead('Which way?', 'You can change this any time.'));
          if (!S.canEdit) { add(el, h('div', { class: 's-banner warn' }, 'You are a guest: the host decides.')); return; }
          // "In-scene (recommended)" saves In-scene for real ('inscene': always drawn ON the 3D screen — the fast window
          // feed, a shared window, else NO SIGNAL); it used to save Auto. The buttons show what is saved now: Auto (the
          // default) has its own button, so pressing Next without a click never looks like In-scene while Auto is on.
          add(el, tut(seg<string>([['inscene', 'In-scene', 'recommended'], ['auto', 'Auto', 'OBS capture when it fits exactly, else in the room'], ['passthrough', 'OBS passthrough', 'the old way']], m, (v) => { S.setScreen({ mode: v as 'inscene' | 'auto' | 'passthrough' }); ctx.refresh(); }), 'react-mode'),
            m === 'auto' ? h('p', { class: 'note' }, 'Auto lets OBS show your capture on a screen that faces the camera straight on (with OBS automation on), which stays smooth next to a heavy game. A screen at an angle is drawn in the room with the window feed. In-scene always draws it in the room (NO SIGNAL if nothing arrives).') : null,
            m === 'passthrough' ? h('div', { class: 's-obs' }, h('b', null, 'In OBS: '), 'add a ', b('Window Capture'), ' BELOW the VTube Pro Browser Source. Easiest: turn on OBS automation (First-time setup → OBS) and VTube Pro moves it into place for you. The exact numbers are in Show → OBS passthrough (fallback). A screen at an angle only lines up with the corner-pin plugin. Without it, VTube Pro draws that screen in the room instead, with your window from the fast window feed (NO SIGNAL if the feed can’t run).') : null);
        },
      },
      {
        id: 'try', title: 'Try it',
        render: (ctx, el) => {
          add(el, ...wizHead('Try it', 'Switch to React: the screen comes down and the camera turns to it. Back to Talk puts it away.'));
          if (!S.effective.sceneId) { add(el, h('div', { class: 's-banner warn' }, 'Pick a room first.')); return; }
          if (!S.canEdit) return;
          add(el, tut(seg<string>([['talk', '🎙 Talk'], ['react', '🖥 React']], S.effective.mode, (v) => { S.setMode(v as 'talk' | 'react'); ctx.refresh(); }), 'react-try'),
            h('p', { class: 'note', style: 'margin-top:10px' }, 'Tip: the Lighting “React” state (Shift+3) dims the room for watching.'));
        },
      },
      {
        id: 'done', title: 'Done',
        render: (ctx, el) => add(el, ...wizHead('React screen ready 🖥', 'Switch between Talk and React from the Room area whenever you like.')),
        nextLabel: 'Finish',
      },
    ],
  };
}

// ---------------------------------------------------------------- registry
const BUILDERS: Record<string, (app: App) => WizDef> = { firstRun, room: roomWizard, multiplayer: mpWizard, react: reactWizard, phone: phoneWizard, multicam: multicamWizard };
export const WIZARD_LIST: { id: string; icon: string; title: string; blurb: string }[] = [
  { id: 'firstRun', icon: '🚀', title: 'First-time setup', blurb: 'Camera, lighting, mic, voice, avatar and OBS — about 5 minutes.' },
  { id: 'model', icon: '🧍', title: 'Add my model', blurb: 'Bring your own VRM, GLB or FBX: we check it and set it up for you, or walk you through it.' },
  { id: 'room', icon: '🏠', title: 'Set up a room', blurb: 'Pick a 3D room, its mode, lights, sky and action.' },
  { id: 'chat', icon: '💬', title: 'Set up my chat & stream', blurb: 'Twitch, YouTube, Kick, Rumble or TikTok, your alerts and chat on screen. About 3 minutes.' },
  { id: 'react', icon: '🖥', title: 'Set up the react screen', blurb: 'Show a video or game on a screen in your room.' },
  { id: 'phone', icon: '📱', title: 'Use my phone for face tracking', blurb: 'iPhone Live Link Face, iFacialMocap or the VTube Studio app.' },
  { id: 'multicam', icon: '📷', title: 'Use two webcams', blurb: 'A second USB webcam: stereo face capture, a close-up of your mouth, or your body and hands.' },
  { id: 'multiplayer', icon: '👯', title: 'Set up multiplayer (Discord)', blurb: 'Your own free invite server: parties with a Join button in Discord, and interview guest links.' },
];
const titles = new Map<string, Map<string, string>>();
/** Step titles are static: build a definition against a stand-in app (its render functions never run). */
const FAKE_APP: App = (() => { const f: unknown = new Proxy(function () { /* stand-in */ }, { get: () => f, apply: () => f }); return f as App; })();
export function wizardStatus(id: string) {
  const st = wizardState(id);
  if (!titles.has(id) && BUILDERS[id]) { try { titles.set(id, new Map(BUILDERS[id](FAKE_APP).steps.map((s) => [s.id, s.title]))); } catch { titles.set(id, new Map()); } }
  return { finished: st.finished, started: !st.finished && (!!st.step || st.done.length > 0 || st.seen.length > 0), stepTitle: st.step ? titles.get(id)?.get(st.step) ?? '' : '' };
}
export function openNamed(app: App, id: string, at?: string) {
  // "Add my model": the drop-anywhere importer (src/ui/dropImport.ts; its "Step by step" hands over to the guided
  // wizard, src/ui/modelWizard.ts, which also stays under Me → Advanced → Avatars)
  if (id === 'model') { void import('./dropImport.ts').then((m) => m.openModelImport(app, null, { onDone: () => app.emit('library') })); return; }
  if (id === 'chat') { void import('./streamSetup/index.ts').then((m) => m.openStreamSetup(app, at ? { step: at as import('../../shared/streamSetup.ts').StepId } : {})); return; }
  const b = BUILDERS[id];
  if (!b) { toast(`No guided set-up “${id}”`, 'warn'); return; }
  openWizard(app, b(app), { at });
}
