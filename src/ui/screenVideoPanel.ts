// Scene tab → "Screen video": the room's big screen (or the solo side screen) plays a video IN the scene — a starting-
// soon loop in Preshow, BRB, an outro, or ambience during Talk (paused while React / Interview / Gaming / TTRPG are on).
// Library = this PC's videos/ folder (server/routes/videos.ts) + URLs; one playlist per moment (loop / shuffle / camera);
// muted by default with a "Video sound" switch (it plays in the studio). Host-owned (src/scene/screenVideoHost.ts drives the clock).
import type { App } from '../app.ts';
import { DEFAULT_PLAYLIST, DEFAULT_VIDEO_STATE, VIDEO_SLOTS, VIDEO_SLOT_LABEL, isVideoSrc, videoName, wantedSlot, type SceneVideoState, type VideoPlaylist, type VideoSlotId } from '../../shared/screenVideo.ts';
import { button, h, section, select, slider, toast, toggle } from './dom.ts';
import { forScripts } from './forScripts.ts';
import { OBS_VCAM } from '../../shared/screenVideo.ts';
import { AMB_MOVES, AMB_MOVE_LABEL, AMB_STATES, AMB_STATE_LABEL, DEFAULT_AMBCAM, ambSlot, type AmbMoveId, type SceneAmbientCam } from '../../shared/ambientCam.ts';

const CSS = `
.svid-now { font: 12px ui-monospace, Consolas, monospace; background:#12151b; border:1px solid var(--line); border-radius:6px; padding:6px 8px; margin:4px 0 8px; white-space:pre-wrap; }
.svid-slot { border:1px solid var(--line); border-radius:8px; padding:6px 8px; margin:6px 0; }
.svid-slot.live { border-color: var(--accent2); }
.svid-slot h4 { margin:2px 0 4px; font-size:13px; display:flex; gap:6px; align-items:center; }
.svid-slot h4 span { flex:1; }
.svid-item { display:grid; grid-template-columns: 1fr auto auto auto; gap:4px; align-items:center; font-size:12px; margin:2px 0; }
.svid-item .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.svid-item.on .nm { color: var(--accent2); font-weight:600; }
.svid-item button, .svid-add button { padding:1px 7px; font-size:11px; }
.svid-add { display:flex; gap:4px; margin:4px 0; }
.svid-add select, .svid-add input { flex:1; min-width:0; }
`;
let cssDone = false;
let lib: { dir: string; files: { name: string; size: number }[] } | null = null;
let libLoading: Promise<void> | null = null;
const loadLib = (force = false) => {
  if (libLoading && !force) return libLoading;
  libLoading = fetch('/api/videos').then((r) => (r.ok ? r.json() : null)).then((j) => { lib = j; }).catch(() => { lib = null; });
  return libLoading;
};

const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function screenVideoSection(app: App, rerender: () => void) {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const st = S.state;
  const v: SceneVideoState = st.video ?? DEFAULT_VIDEO_STATE;
  const edit = S.canEdit;
  if (!lib) void loadLib().then(() => { if (lib) rerender(); });
  const set = (fn: (x: SceneVideoState) => void) => S.setVideo(fn);
  const pl = (x: SceneVideoState, id: VideoSlotId): VideoPlaylist => (x.slots[id] ??= { ...DEFAULT_PLAYLIST, list: [] });

  // ---- what plays now (ticks by itself)
  const now = h('div', { class: 'svid-now' });
  const paint = () => {
    const e = S.effective.video, n = e?.now;
    const want = wantedSlot(e, S.effective.lights.state);
    if (!e?.on) { now.textContent = 'Off.'; return; }
    if (e.stopped) { now.textContent = 'Stopped (until Play or the next lighting state).'; return; }
    if (!n) { now.textContent = want ? 'Starting…' : `Nothing for this moment (${S.effective.lights.state ?? 'show'}) — give it a playlist below.`; return; }
    const pos = n.paused ? n.pos ?? 0 : Math.max(0, (Date.now() - n.at) / 1000);
    const len = e.slots[n.slot]?.list.length ?? 0;
    now.textContent = `${n.end ? '■ Finished' : n.paused ? '❚❚ Paused (screen busy: React / Interview / Gaming…)' : pos <= 0 ? '… Screen coming down' : '▶ Playing'}  ${VIDEO_SLOT_LABEL[n.slot]}${e.force ? ' (manual)' : ''}\n`
      + `${n.i + 1}/${len}  ${videoName(n.src)}  ${fmtT(n.dur ? pos % n.dur : pos)}${n.dur ? ` / ${fmtT(n.dur)}` : ''}\n`
      + `Sound: ${e.audio ? `in the studio, ${Math.round(e.volume * 100)} %` : 'muted'}`
      + (S.effective.mode !== 'talk' && n.slot !== 'ambience' ? '\n(React / a stage layout is using the screen: the video shows again when it’s free)' : '');
  };
  paint();
  const tick = window.setInterval(() => { if (!now.isConnected) { window.clearInterval(tick); return; } paint(); }, 500);

  const ctl = h('div', { class: 'btns tight' },
    button('▶ Play', () => S.video.control({ action: 'play' }), 'primary'),
    button('■ Stop', () => S.video.control({ action: 'stop' })),
    button('⏭ Next', () => S.video.control({ action: 'next' })),
    button('↺ Restart', () => S.video.control({ action: 'restart' })));

  // ---- library
  const fileIn = h('input', { type: 'file', accept: 'video/mp4,video/webm,.mp4,.webm,.m4v,.mov,.ogv', multiple: true, style: 'display:none' }) as HTMLInputElement;
  fileIn.addEventListener('change', async () => {
    for (const f of [...(fileIn.files ?? [])]) {
      toast(`Adding ${f.name}…`);
      try {
        const r = await fetch(`/api/videos/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
        const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText);
        toast(`Added ${j.name}`, 'ok');
      } catch (e) { toast(`Couldn’t add ${f.name}: ${(e as Error).message}`, 'err'); }
    }
    fileIn.value = '';
    S.video.forget(); await loadLib(true); rerender();
  });
  const libBox = h('div', null,
    h('p', { class: 'note' }, `Your videos folder: ${lib?.dir ?? '…'} (${lib ? `${lib.files.length} video${lib.files.length === 1 ? '' : 's'}` : 'loading'}). MP4 or WebM videos work best.`),
    h('div', { class: 'btns tight' },
      button('Add videos…', () => fileIn.click()),
      button('Open folder', () => { void fetch('/api/videos/open', { method: 'POST' }); }),
      button('Refresh', async () => { S.video.forget(); await loadLib(true); rerender(); })),
    fileIn);

  // ---- one playlist per moment
  const slotBox = (id: VideoSlotId) => {
    const p = v.slots[id] ?? DEFAULT_PLAYLIST;
    const live = v.now?.slot === id;
    const items = p.list.map((src, i) => h('div', { class: `svid-item${live && v.now?.i === i ? ' on' : ''}` },
      h('span', { class: 'nm', title: src }, `${i + 1}. ${videoName(src)}`),
      button('↑', () => set((x) => { const l = pl(x, id).list; if (i > 0) [l[i - 1], l[i]] = [l[i], l[i - 1]]; })),
      button('↓', () => set((x) => { const l = pl(x, id).list; if (i < l.length - 1) [l[i + 1], l[i]] = [l[i], l[i + 1]]; })),
      button('✕', () => set((x) => { pl(x, id).list.splice(i, 1); }))));
    const pick = h('select', null, h('option', { value: '' }, lib?.files.length ? 'Add from your videos…' : 'No videos yet — Add videos… above'),
      ...(lib?.files ?? []).map((f) => h('option', { value: `lib:${f.name}` }, f.name))) as HTMLSelectElement;
    pick.addEventListener('change', () => { const s = pick.value; if (isVideoSrc(s)) set((x) => { pl(x, id).list.push(s); x.on = true; }); });
    const url = h('input', { type: 'url', placeholder: 'or a video URL (https://…/clip.mp4)' }) as HTMLInputElement;
    const addUrl = button('Add', () => { const s = url.value.trim(); if (!isVideoSrc(s)) { toast('That isn’t an http(s) video link', 'warn'); return; } set((x) => { pl(x, id).list.push(s); x.on = true; }); });
    // live sources: a stream link (HLS / direct), the OBS Virtual Camera, the window feed
    const liveUrl = h('input', { type: 'url', placeholder: 'live stream link (…/index.m3u8 or a direct stream)' }) as HTMLInputElement;
    const addLive = button('Add live', async () => {
      const u = liveUrl.value.trim();
      const r = await fetch('/api/videos/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: u }) }).then((x) => x.json()).catch(() => null);
      if (!r?.ok) { toast(r?.why ?? r?.error ?? 'That link can’t be played', 'warn'); return; }
      if (isVideoSrc(r.src)) set((x) => { pl(x, id).list.push(r.src); x.on = true; });
    });
    const liveRow = h('div', { class: 'svid-add' }, liveUrl, addLive);
    const obsRow = h('div', { class: 'svid-add' },
      button('+ OBS Virtual Camera', () => set((x) => { pl(x, id).list.push(OBS_VCAM); x.on = true; })),
      button('+ Window feed', () => set((x) => { pl(x, id).list.push('feed:window'); x.on = true; })));
    return h('div', { class: `svid-slot${live ? ' live' : ''}` },
      h('h4', null, h('span', null, VIDEO_SLOT_LABEL[id]), p.list.length ? button('Play now', () => S.video.control({ action: 'play', slot: id })) : null),
      ...(items.length ? items : [h('p', { class: 'note', style: 'margin:2px 0' }, id === 'ambience' ? 'Empty: nothing plays during Talk.' : `Empty: nothing plays in ${VIDEO_SLOT_LABEL[id]}.`)]),
      h('div', { class: 'svid-add' }, pick),
      h('div', { class: 'svid-add' }, url, addUrl),
      liveRow, obsRow,
      toggle('Loop', p.loop, (b) => set((x) => { pl(x, id).loop = b; }), 'Off: the screen goes away after the last video'),
      toggle('Shuffle', p.shuffle, (b) => set((x) => { pl(x, id).shuffle = b; })),
      select('Camera', p.cam, [['keep', 'Keep the room camera'], ['screen', 'Show the screen (React shot)']], (c) => set((x) => { pl(x, id).cam = c; }),
        'Show the screen: while this plays the camera frames the screen like React does'));
  };

  const body = edit ? [
    toggle('Screen video', v.on, (b) => set((x) => { x.on = b; })),
    now, ctl,
    toggle('Video sound', v.audio, (b) => set((x) => { x.audio = b; }), 'Off by default. On: the video’s sound plays here in the studio, in step with the screen (Audio mixer → Room screen video), never on the OBS page.'),
    v.audio ? slider('Volume', Math.round(v.volume * 100), 0, 100, 1, (n) => set((x) => { x.volume = n / 100; }), 'Video sound level (played in the studio)', { def: 80, unit: '%' }) : null,
    libBox,
    ...VIDEO_SLOTS.map(slotBox),
    h('p', { class: 'note' },
      'The video plays ON the room’s big screen (rooms without one: the side screen beside you) — no OBS setup. Preshow / BRB / Outro follow the lighting state; ',
      h('b', null, 'Ambience'), ' plays during Talk and pauses by itself for React, Interview, Gaming or TTRPG, then carries on where it was. A manual Stop / Play now lasts until the next lighting state.'),
    forScripts('Stream Deck: Website / API action ', h('code', null, 'POST http://127.0.0.1:5191/api/scene/video'), ' with ', h('code', null, '{"action":"toggle"}'),
      ' (play / stop / next / restart, optional "slot": "preshow" | "ambience" | "brb" | "outro") or ', h('code', null, '{"audio":"toggle"}'), '.'),
    h('p', { class: 'note' }, h('b', null, 'Live sources'), ' (🔴 stream link, 📷 OBS Virtual Camera, 🪟 window feed) have no end: the playlist stays on them until Next. They start muted like everything here. '
      + 'Twitch / YouTube / Kick channel pages can’t be pulled directly — show your OBS “Starting Soon” / “BRB” scene instead: in OBS set Tools → Virtual Camera → Output: that scene (or open a Windowed Projector of it and pick that window for the window feed), then add “OBS Virtual Camera” here. '
      + 'Party guests can’t see your virtual camera or window feed (their screen shows theirs); stream links work for everyone.'),
    h('div', { class: 'btns tight' }, button('Start OBS Virtual Camera (asks OBS)', async () => {
      if (!confirm('Start the OBS Virtual Camera now? (OBS keeps showing whatever scene its Virtual Camera output is set to.)')) return;
      const r = await fetch('/api/obs/vcam', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: true }) }).then((x) => x.json()).catch(() => null);
      toast(r?.ok ? `OBS Virtual Camera ${r.active ? 'is on' : 'is off'}` : `OBS: ${r?.error ?? 'no answer'}`, r?.ok ? 'ok' : 'warn');
    })),
    h('p', { class: 'note', style: 'color:var(--dim)' }, 'Party guests: their OBS shows your video only when their own videos folder has a file with the same name (or you use a URL). The video’s sound plays here in the studio (Audio mixer → Room screen video), never on the OBS page: your stream hears it from this window, like your guests. Live streams play their sound there too. Cameras and the window feed have no sound: add it in OBS directly (Audio Input Capture / Application Audio Capture).'),
  ] : [now, h('p', { class: 'note' }, 'The host controls the screen video. Your OBS plays it when your videos folder has the same file (URLs always work).')];
  return section('Screen video', ...body);
}


/** Scene tab → "Ambient cameras": Preshow / BRB / Outro camera moves (shared/ambientCam.ts). */
export function ambientCamSection(app: App) {
  const S = app.scene;
  const a: SceneAmbientCam = S.state.ambcam ?? DEFAULT_AMBCAM;
  if (!S.canEdit) return section('Ambient cameras', h('p', { class: 'note' }, 'The host picks the Preshow / BRB / Outro camera moves.'));
  const set = (fn: (x: SceneAmbientCam) => void) => S.setAmbientCam((x) => { fn(x); return x; });
  const cmd = (c: Record<string, unknown>) => S.command({ ambcam: c });
  const slotBox = (id: (typeof AMB_STATES)[number]) => {
    const sl = ambSlot(a, id);
    const moves = h('div', { class: 'svid-add', style: 'flex-wrap:wrap' }, ...AMB_MOVES.map((m: AmbMoveId) =>
      toggle(AMB_MOVE_LABEL[m], sl.moves.includes(m), (b) => set((x) => { const s0 = ambSlot(x, id); const l = s0.moves.filter((q) => q !== m); if (b) l.push(m); x.slots[id] = { ...s0, moves: l.length ? l : [m] }; }))));
    return h('div', { class: 'svid-slot' },
      h('h4', null, h('span', null, AMB_STATE_LABEL[id]), button('Next shot', () => cmd({ action: 'next', state: id }))),
      toggle('Use ambient cameras', sl.on, (b) => set((x) => { x.slots[id] = { ...ambSlot(x, id), on: b }; })),
      moves,
      slider('Seconds per shot', sl.cycle, 8, 120, 1, (n) => set((x) => { x.slots[id] = { ...ambSlot(x, id), cycle: n }; }), 'A single move re-plans a new angle every shot', { def: sl.cycle, unit: ' s' }),
      slider('Motion', Math.round(sl.speed * 100), 25, 250, 5, (n) => set((x) => { x.slots[id] = { ...ambSlot(x, id), speed: n / 100 }; }), 'How far / fast the camera travels in a shot', { def: 100, unit: '%' }),
      select('Between shots', sl.cut ? 'cut' : 'glide', [['glide', 'Smooth glide'], ['cut', 'Cut']], (c) => set((x) => { x.slots[id] = { ...ambSlot(x, id), cut: c === 'cut' }; })));
  };
  return section('Ambient cameras',
    toggle('Ambient cameras', a.on, (b) => set((x) => { x.on = b; x.at = Date.now(); })),
    h('p', { class: 'note' }, 'Slow pans, orbits, dollies, crane moves, a handheld drift, a security cam and a tour of the room’s cameras while you’re in Preshow, BRB or Outro (Talk mode). Paths are planned per room so they stay inside the walls and clear of the furniture; with a screen video playing they aim at the screen. Every OBS page (and party guests) shows the same shot. Stream Deck: “Ambient cameras” (next / pick a move / on-off).'),
    ...AMB_STATES.map(slotBox));
}
