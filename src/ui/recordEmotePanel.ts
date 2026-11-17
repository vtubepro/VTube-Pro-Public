// Live > Stream extras > "Record my own emote" (beta.16, lane recemote; docs/b16/RECORD_EMOTE.md).
//   1. Press Record: 3-2-1, then do your wave (up to the chosen length; Stop any time).
//   2. The take is trimmed to where you moved. Drag the two handles to change it. Smooth, "only what moved", repeat: sliders and
//      ticks with working defaults. Preview plays it on your avatar (this studio only, never on the stream).
//   3. Name it and Save: it joins "My emotes" below, the deck / rules action "My recorded emote", and (tick) your idle.
// Recordings are bone angles only, kept on this PC by the helper. Simple words, no settings needed for the usual case.
import type { App } from '../app.ts';
import type { B16PanelHandle } from '../b16/panels.ts';
import {
  CLIP_MAX_SECS, DEFAULT_EDIT, cleanEmoteName, encodeClip, motionProfile, processTake, suggestTrim, takeSeconds, type EditOptions, type Take,
} from '../avatar/recordEmote/clip.ts';
import { TakeRecorder, recordBlocker, type RecorderHost } from '../avatar/recordEmote/recorder.ts';
import { forgetUserEmote, listUserEmotes, playPreview, playRecorded, stopRecordedEmote, type EmoteHost, type UserEmoteMeta } from '../avatar/recordEmote/player.ts';
import { recordedName } from '../avatar/recordEmote/clip.ts';
import { idleEmote } from '../avatar/recordEmote/mount.ts';
import { button, h, toast, toggle } from './dom.ts';

const CSS = `
.rem { display:flex; flex-direction:column; gap:10px; }
.rem .rem-card { background:#17140f; border:1px solid #3a2f17; border-radius:10px; padding:10px 12px; }
.rem h4 { margin:0 0 6px; font-size:13px; }
.rem .rem-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.rem .rem-big { font-size:42px; font-weight:800; line-height:1; text-align:center; color:#F5A623; min-height:48px; }
.rem .rem-rec { font-weight:800; }
.rem .rem-rec.on { background:#c0392b; color:#fff; border-color:transparent; }
.rem .rem-bar { height:6px; border-radius:3px; background:#2a2316; overflow:hidden; flex:1 1 140px; }
.rem .rem-bar i { display:block; height:100%; width:0; background:#c0392b; }
.rem canvas.rem-strip { width:100%; height:64px; background:#0f0d09; border-radius:6px; cursor:ew-resize; touch-action:none; display:block; }
.rem .rem-trim { display:grid; grid-template-columns:auto 1fr; gap:4px 8px; align-items:center; margin-top:6px; font-size:12px; }
.rem .rem-trim input[type=range] { width:100%; }
.rem .rem-list { display:flex; flex-direction:column; gap:6px; }
.rem .rem-item { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:6px 8px; border-radius:8px; background:#1d1a14; border:1px solid #2f2713; }
.rem .rem-item .nm { flex:1 1 130px; font-weight:700; cursor:text; }
.rem .rem-item .keyname { flex:1 1 100%; font-size:11px; opacity:.85; }
.rem .rem-item .keyname code { background:#0f0d09; border-radius:4px; padding:1px 6px; user-select:all; color:#F5A623; }
.rem .rem-item .tag { font-size:10px; padding:1px 7px; border-radius:9px; background:#2a2316; color:#F5A623; }
.rem .rem-item input[type=text] { flex:1 1 130px; }
.rem .note { margin:0; font-size:12px; opacity:.85; }
.rem .note.warn { color:#e9b44c; }
.rem .btn.danger { border-color:#7a2d24; color:#f1948a; }
`;
let cssDone = false;
const css = () => { if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; } };

const LENGTHS = [3, 5, 8, 12, 20, CLIP_MAX_SECS];
const fmtSecs = (s: number) => `${s.toFixed(1)} s`;

export function mountRecordEmotePanel(host: HTMLElement, app: App): B16PanelHandle {
  css();
  const rhost = app as unknown as RecorderHost & EmoteHost;
  const rec = new TakeRecorder();
  const root = h('div', { class: 'rem' });
  host.replaceChildren(root);
  let dead = false;

  // ---- state
  let maxSecs = 8;
  let raw: Take | null = null;
  let profile: Float32Array = new Float32Array(0);
  let edit: EditOptions = { ...DEFAULT_EDIT };
  let name = '';
  let asIdle = false;
  let lostWarn = false;
  let status = '';
  let statusWarn = false;
  let count: number | null = null;
  let recSecs = 0;
  let list: UserEmoteMeta[] = [];
  let listError = '';
  let loadedList = false;
  let renaming: string | null = null;
  let confirmDel: string | null = null;
  let saving = false;
  let raf = 0;

  const say = (t: string, warn = false) => { status = t; statusWarn = warn; };

  // ---- the server list
  async function refresh() {
    const l = await listUserEmotes();
    if (dead) return;
    loadedList = true;
    if ('error' in l) { listError = l.error; list = []; } else {
      listError = ''; list = l.emotes;
      idleEmote()?.set(l.idle);       // VTube Pro knows which one is the idle emote: this browser follows
    }
    draw();
  }

  // ---- recording
  function startRecording() {
    say('');
    const why = recordBlocker(rhost);
    if (why) { say(why, true); toast(why, 'warn'); draw(); return; }
    raw = null;
    rec.start(rhost, { maxSecs, countdown: 3 }, {
      onCount: (n) => { count = n; recSecs = 0; draw(); },
      onProgress: (s, max) => { count = null; recSecs = s; const bar = root.querySelector<HTMLElement>('.rem-bar i'); const t = root.querySelector<HTMLElement>('.rem-time'); if (bar) bar.style.width = `${Math.min(100, (s / max) * 100)}%`; if (t) t.textContent = `${fmtSecs(s)} of ${max} s`; if (root.querySelector('.rem-count')) draw(); },
      onDone: (take, info) => {
        raw = take; profile = motionProfile(take); count = null;
        const s = suggestTrim(take);
        edit = { ...DEFAULT_EDIT, start: s.start, end: s.end };
        name = nextName(); asIdle = false; lostWarn = info.lostFraction > 0.4;
        say(lostWarn ? 'I lost sight of you for a while during that take. You can record it again.' : '', lostWarn);
        draw();
        preview();
      },
      onError: (t) => { count = null; say(t, true); toast(t, 'warn'); draw(); },
    });
    draw();
  }
  const nextName = () => { const base = 'My emote'; const used = new Set(list.map((e) => e.name.toLowerCase())); for (let i = 1; i < 500; i++) { const n = `${base} ${i}`; if (!used.has(n.toLowerCase())) return n; } return base; };

  // ---- the edited take
  const processed = () => (raw ? processTake(raw, edit) : null);
  function preview() {
    const p = processed();
    if (!p) return;
    const r = playPreview(rhost, p, edit.loop);
    if (!r.ok) { say(r.error, true); draw(); return; }
    cancelAnimationFrame(raf);
    const tick = () => { if (dead || rhost.emote?.name !== recordedName('_preview')) { drawStrip(); return; } drawStrip(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
  }
  function stopPreview() { if (rhost.emote?.name === recordedName('_preview')) rhost.stopEmote(); }

  async function save() {
    const p = processed();
    if (!p || saving) return;
    const nm = cleanEmoteName(name, nextName());
    saving = true; say('Saving...'); draw();
    try {
      const r = await fetch('/api/user-emotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clip: encodeClip(p, nm, edit.loop || asIdle), idle: asIdle }) });
      const j = await r.json().catch(() => ({})) as { id?: string; error?: string };
      if (!r.ok || !j.id) throw new Error(j.error || 'Could not save that emote.');
      if (asIdle) idleEmote()?.set(j.id);
      stopPreview();
      toast(`Saved "${nm}". It is under My emotes below.`, 'ok');
      raw = null; say('');
      await refresh();
    } catch (e) {
      const t = (e as Error).message === 'Failed to fetch' ? 'I could not reach VTube Pro. Is VTube Pro running?' : (e as Error).message;
      say(t, true); toast(t, 'err');
    } finally { saving = false; draw(); }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      const r = await fetch(`/api/user-emotes/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('Could not change that emote.');
      forgetUserEmote(id);
    } catch (e) { toast((e as Error).message, 'err'); }
    await refresh();
  }
  async function remove(id: string) {
    try {
      const r = await fetch(`/api/user-emotes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Could not delete that emote.');
      if (idleEmote()?.current === id) idleEmote()?.set(null);
      forgetUserEmote(id);
    } catch (e) { toast((e as Error).message, 'err'); }
    confirmDel = null;
    await refresh();
  }
  async function play(m: UserEmoteMeta) {
    const r = await playRecorded(rhost, m.id, { list });
    if (!r.ok) { toast(r.error, 'warn'); return; }
    draw();
    if (!m.loop) setTimeout(() => { if (!dead) draw(); }, r.secs * 1000 + 700);
  }
  const playingNow = (id: string) => rhost.emote?.name === recordedName(id);

  // ---- drawing
  let strip: HTMLCanvasElement | null = null;
  function drawStrip() {
    const c = strip;
    if (!c || !raw) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(200, c.clientWidth || 560), H = 64;
    if (c.width !== Math.floor(W * dpr)) { c.width = Math.floor(W * dpr); c.height = H * dpr; }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const n = raw.frames, px = (f: number) => (f / Math.max(1, n - 1)) * W;
    let peak = 1; for (let i = 0; i < n; i++) peak = Math.max(peak, profile[i]);
    g.fillStyle = '#6d5321';
    for (let x = 0; x < W; x++) {
      const f = Math.min(n - 1, Math.floor((x / W) * n));
      const v = Math.min(1, profile[f] / peak);
      g.fillRect(x, H - 4 - v * (H - 10), 1, v * (H - 10) + 2);
    }
    const a = px(edit.start), z = px(edit.end);
    g.fillStyle = 'rgba(0,0,0,.62)'; g.fillRect(0, 0, a, H); g.fillRect(z, 0, W - z, H);
    g.fillStyle = '#F5A623'; g.fillRect(a - 1.5, 0, 3, H); g.fillRect(z - 1.5, 0, 3, H);
    g.fillRect(a - 5, 0, 8, 7); g.fillRect(z - 3, 0, 8, 7);
    const st = rhost.emote;
    if (st && st.name === recordedName('_preview')) {
      const t = Math.max(0, (Date.now() - st.at) / 1000), len = (edit.end - edit.start) / raw.fps;
      const f = edit.start + (st.loop ? t % Math.max(0.05, len) : Math.min(t, len)) * raw.fps;
      g.fillStyle = '#fff'; g.fillRect(px(f) - 1, 0, 2, H);
    }
  }
  function onStripPointer(e: PointerEvent) {
    if (!raw || !strip) return;
    const rect = strip.getBoundingClientRect();
    const frame = Math.round(((e.clientX - rect.left) / Math.max(1, rect.width)) * (raw.frames - 1));
    const which = e.type === 'pointerdown' ? (Math.abs(frame - edit.start) <= Math.abs(frame - edit.end) ? 'start' : 'end') : strip.dataset.drag as 'start' | 'end' | undefined;
    if (!which) return;
    if (e.type === 'pointerdown') { strip.dataset.drag = which; strip.setPointerCapture(e.pointerId); }
    if (which === 'start') edit.start = Math.max(0, Math.min(edit.end - 3, frame)); else edit.end = Math.min(raw.frames - 1, Math.max(edit.start + 3, frame));
    syncTrim(); drawStrip();
  }
  function syncTrim() {
    if (!raw) return;
    const s = root.querySelector<HTMLInputElement>('input[name=trimStart]'), z = root.querySelector<HTMLInputElement>('input[name=trimEnd]'), len = root.querySelector<HTMLElement>('.rem-len');
    if (s) s.value = String(edit.start);
    if (z) z.value = String(edit.end);
    if (len) len.textContent = `Your emote is ${fmtSecs((edit.end - edit.start) / raw.fps)} long.`;
  }

  function recordCard(): HTMLElement {
    const recording = rec.phase !== 'idle';
    const lenSel = h('select', { onChange: (e: Event) => { maxSecs = Number((e.target as HTMLSelectElement).value); }, disabled: recording, 'aria-label': 'Longest recording' },
      ...LENGTHS.map((s) => h('option', { value: String(s), selected: s === maxSecs }, `${s} seconds`)));
    const btn = rec.phase === 'recording' ? button('■ Stop', () => { rec.stop(); }, 'rem-rec on')
      : rec.phase === 'countdown' ? button('Cancel', () => { rec.cancel(); count = null; draw(); })
        : button('● Record', startRecording, 'rem-rec');
    return h('div', { class: 'rem-card' },
      h('h4', null, '1. Record'),
      h('div', { class: 'rem-row' }, btn, h('label', { class: 'rem-row' }, 'Up to', lenSel)),
      rec.phase === 'countdown' ? h('div', { class: 'rem-big rem-count', role: 'status' }, count === null ? '' : String(count)) : null,
      rec.phase === 'recording' ? h('div', { class: 'rem-row', role: 'status' }, h('div', { class: 'rem-bar' }, h('i')), h('span', { class: 'rem-time' }, `${fmtSecs(recSecs)} of ${maxSecs} s`)) : null,
      h('p', { class: 'note' }, rec.phase === 'recording' ? 'Recording. Do your emote, then press Stop.' : rec.phase === 'countdown' ? 'Get ready...' : 'Needs your camera on and a 3D avatar. Press Record, wait for 3-2-1, then do your wave.'),
      status ? h('p', { class: `note${statusWarn ? ' warn' : ''}`, role: 'status' }, status) : null);
  }

  function editCard(): HTMLElement | null {
    if (!raw) return null;
    const r = raw;
    strip = h('canvas', { class: 'rem-strip', 'aria-label': 'Recording timeline: drag the two handles to cut the start and the end', onPointerdown: onStripPointer, onPointermove: onStripPointer, onPointerup: () => { if (strip) delete strip.dataset.drag; } }) as HTMLCanvasElement;
    const trim = (key: 'start' | 'end', label: string) => h('input', {
      type: 'range', name: key === 'start' ? 'trimStart' : 'trimEnd', min: '0', max: String(r.frames - 1), step: '1', value: String(edit[key]), 'aria-label': label,
      onInput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (key === 'start') edit.start = Math.max(0, Math.min(edit.end - 3, v)); else edit.end = Math.min(r.frames - 1, Math.max(edit.start + 3, v));
        syncTrim(); drawStrip();
      },
    });
    const smooth = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(edit.smooth * 100)), 'aria-label': 'Smooth', onInput: (e: Event) => { edit.smooth = Number((e.target as HTMLInputElement).value) / 100; } });
    const nameBox = h('input', { type: 'text', value: name, maxlength: 40, placeholder: 'Name your emote', 'aria-label': 'Emote name', onInput: (e: Event) => { name = (e.target as HTMLInputElement).value; } });
    const loopT = toggle('Repeat it (loop)', edit.loop || asIdle, (v) => { edit.loop = v; }, 'Plays round and round until you stop it, and the end flows into the start');
    if (asIdle) loopT.querySelector('input')!.disabled = true;
    const el = h('div', { class: 'rem-card' },
      h('h4', null, '2. Trim and polish'),
      strip,
      h('div', { class: 'rem-trim' }, h('span', null, 'Start'), trim('start', 'Cut the start'), h('span', null, 'End'), trim('end', 'Cut the end')),
      h('p', { class: 'note rem-len' }, `Your emote is ${fmtSecs((edit.end - edit.start) / r.fps)} long.`),
      h('label', { class: 'row slider', title: 'Softens little shakes from tracking' }, h('span', { class: 'lbl' }, 'Smooth'), smooth),
      toggle('Keep only what moved', edit.keepMoved, (v) => { edit.keepMoved = v; }, 'Fingers and head that stayed still keep following your live tracking while the emote plays'),
      toggle('Include legs and hips', edit.legs, (v) => { edit.legs = v; }, 'Cameras rarely see them, so this is off. Rooms with a seat pose ignore them anyway'),
      loopT,
      h('div', { class: 'rem-row' }, button('▶ Preview on my avatar', preview), button('■ Stop preview', stopPreview),
        h('span', { class: 'note' }, 'Only you see the preview, not the stream.')),
      h('h4', { style: 'margin-top:8px' }, '3. Save'),
      h('div', { class: 'rem-row' }, nameBox),
      toggle('Use as my idle', asIdle, (v) => { asIdle = v; draw(); }, 'Plays on a loop whenever the camera is not tracking you, and stops when you are back'),
      h('div', { class: 'rem-row' }, button(saving ? 'Saving...' : 'Save emote', () => { void save(); }, 'primary'),
        button('Throw it away', () => { stopPreview(); raw = null; say(''); draw(); }, 'danger')));
    return el;
  }

  function listCard(): HTMLElement {
    const rows = list.map((m) => {
      const nameEl = renaming === m.id
        ? h('input', { type: 'text', value: m.name, maxlength: 40, 'aria-label': 'New name', onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value; renaming = null; void patch(m.id, { name: v }); }
          if (e.key === 'Escape') { renaming = null; draw(); }
        }, onBlur: () => { if (renaming === m.id) { renaming = null; draw(); } } })
        : h('span', { class: 'nm', title: 'Click to rename', onClick: () => { renaming = m.id; draw(); root.querySelector<HTMLInputElement>('.rem-item input[type=text]')?.focus(); } }, m.name);
      return h('div', { class: 'rem-item' }, nameEl,
        h('span', { class: 'note' }, fmtSecs(m.secs)),
        m.loop ? h('span', { class: 'tag' }, 'loop') : null, m.idle ? h('span', { class: 'tag' }, 'my idle') : null,
        playingNow(m.id) ? button('■ Stop', () => { stopRecordedEmote(rhost); draw(); }) : button('▶ Play', () => { void play(m); }),
        button(m.idle ? 'Not my idle' : 'Use as idle', () => { void patch(m.id, { idle: !m.idle, ...(m.idle ? {} : { loop: true }) }); }),
        confirmDel === m.id ? button('Really delete?', () => { void remove(m.id); }, 'danger') : button('Delete', () => { confirmDel = m.id; draw(); setTimeout(() => { if (confirmDel === m.id) { confirmDel = null; if (!dead) draw(); } }, 4000); }),
        // The Stream Deck / rules box takes letters, digits and dashes only, so show the exact text to type (the id never changes on rename).
        h('div', { class: 'keyname' }, 'Deck / key name: ', h('code', { title: 'Type this in the "My recorded emote" box on a Stream Deck key, a redeem or a rule' }, m.id)));
    });
    return h('div', { class: 'rem-card' },
      h('h4', null, 'My emotes'),
      !loadedList ? h('p', { class: 'note' }, 'Loading...') : listError ? h('p', { class: 'note warn', role: 'status' }, listError)
        : rows.length ? h('div', { class: 'rem-list' }, ...rows) : h('p', { class: 'note' }, 'Nothing here yet. Record your first one above.'),
      h('p', { class: 'note' }, 'To use one on a Stream Deck key, a redeem or a rule, pick "My recorded emote" and type its "Deck / key name" from the list above (leave it empty for your newest). Recordings stay on this PC.'));
  }

  function draw() {
    if (dead) return;
    root.replaceChildren(...[recordCard(), editCard(), listCard()].filter((x): x is HTMLElement => !!x));
    if (raw) { syncTrim(); drawStrip(); }
  }

  draw();
  void refresh();
  return {
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      rec.cancel();
      stopPreview();
      root.remove();
    },
  };
}
