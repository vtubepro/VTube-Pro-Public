// Scene tab → DJ sync → "Track library": the DJ's own track analysis (beat grids, rekordbox phrases, waveforms, cues)
// pulled in read-only from rekordbox / Engine DJ / Traktor / Serato / VirtualDJ / Mixxx, plus VTube Pro's own analysis
// for the rest, so the light show is BUILT for each track in advance (the drop countdown, a blackout before the drop,
// pyro on the downbeat) instead of reacting late. Zero effort: one "Find my DJ libraries" click imports everything it
// finds; learning runs by itself when you're not live; the follower picks the track up from the decks.
// Also: the studio side of audio matching (src/audio/trackFeatures.ts) and of decoding files the helper can't
// (no ffmpeg: the browser decodes them off-screen — never played — and analyses them in a worker).
// Mounted by src/ui/djSyncPanel.ts (one line).
import type { App } from '../app.ts';
import { button, h, toast, toggle } from './dom.ts';
import { TrackFeatures } from '../audio/trackFeatures.ts';

interface Settings { phrases: boolean; autoAnalyse: boolean; analyseAll: boolean; matchAudio: boolean; style: string; traktorMp3OffsetMs: number; ffmpegPath: string; traktorCast?: boolean; traktorCastPort?: number }
interface Names { serato: { deck: number; title: string }[] | null; traktor: { on: boolean; port: number; connected: boolean; title?: string; artist?: string; at: number; says: string } }
interface Source { kind: string; label: string; path: string; at: number; tracks: number; says: string; ok: boolean }
interface Now { deck: number; id: string; title?: string; artist?: string; beat: number; conf: number; src: string; srcLabel: string; sec: string | null; dropIn: number | null; blend: boolean; decks: { n: number; title?: string; conf: number; gain: number }[] }
interface Hint { id: string; title: string; artist?: string; by: 'pick' | 'name'; from?: string; placed: boolean; stream: string | null; learned: boolean; heard: number; need: number; wave: boolean }
interface Kinds { local: number; streaming: number; stream: Record<string, number>; samples: number; streamLearned: number }
interface Lib {
  settings: Settings; sources: Source[];
  /** tracks on this PC / streaming per service / sampler sounds skipped */ kinds?: Kinds;
  /** the studio should send the music input's features */ listen?: boolean;
  counts: { tracks: number; grid: number; phrases: number; analysed: number; waiting: number; failed: number; bytes: number; outside?: number };
  roots?: string[]; ask?: { path: string; tracks: number }[];
  analyzer: { state: string; says: string; done: number; total: number; current: string; pageJobs: number; ffmpeg: boolean; /** "learn now" until */ learnNow?: number | null; avgMs?: number };
  model: { state: string; progress: { got: number; total: number } | null; name: string; mb: number; licence: string };
  now: Now | null;
  /** VTube Pro's own Track library page (server/music/libraryRoutes.ts) */ page?: string;
  matching?: { tracks: number; indexMB: number; seconds: number; listening: { id: string; title?: string; state: 'identified' | 'locked'; since: number } | null; hint?: Hint | null; learning?: { id: string; title: string; heard: number; need: number } | null; names?: Names; controller?: string | null };
}
interface Found { kind: string; path: string; label: string; kindLabel: string }
interface TrackRow { id: string; title: string; artist: string; mix?: string; bpm: number; durMs: number; st: { grid: boolean; phrases: boolean; analysed: boolean; drops: number; phraseSrc: string | null }; err: string | null; srcs: string[]; stream?: string | null; learned?: boolean }
interface TrackDetail { id: string; title: string; artist: string; durMs: number; bpm: number; grid: { anchors: { ms: number; beat: number; bpm: number }[]; downbeat: number } | null; phrases: { beat: number; end: number; sec: string; kind: string }[]; bands: { cols: number; b64: string } | null; drops: number[]; cues: { ms: number; kind: string }[]; show: { cues: number; maxFlashHz: number; genre: string } | null; srcs: string[] }

const CSS = `
.dt-wrap { margin: 12px 0 6px; border-top: 1px solid var(--line); padding-top: 10px; }
.dt-wrap h4 { margin: 0 0 6px; font-size: 13px; font-weight: 750; display:flex; align-items:center; gap:8px; }
.dt-wrap h4 small { font-weight: 500; color: var(--dim); font-size: 11.5px; }
.dt-now { border:1px solid var(--line); border-radius:12px; background:var(--card); padding:9px 11px; margin:4px 0 8px; font-size:12px; }
.dt-now .t { font-weight:700; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dt-now .m { color:var(--dim); margin-top:3px; display:flex; flex-wrap:wrap; gap:4px 10px; align-items:center; }
.dt-conf { display:inline-flex; gap:2px; vertical-align:middle; } .dt-conf i { width:6px; height:10px; border-radius:2px; background:var(--card3); } .dt-conf i.on { background:var(--ok); }
.dt-counts { font-size:12px; color:var(--dim); margin:2px 0 8px; }
.dt-counts b { color:var(--text); }
.dt-btns { display:flex; flex-wrap:wrap; gap:6px; margin:4px 0 8px; }
.dt-list { display:flex; flex-direction:column; gap:5px; margin:4px 0 8px; }
.dt-item { display:grid; grid-template-columns: 1fr auto; gap:2px 8px; align-items:center; padding:6px 9px; border:1px solid var(--line); border-radius:10px; background:var(--card); font-size:12px; }
.dt-item .p { grid-column:1; color:var(--faint); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dt-item .n { font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dt-item .s { grid-column:1 / -1; color:var(--dim); font-size:11.5px; }
.dt-prog { height:6px; border-radius:99px; background:var(--card3); overflow:hidden; margin:4px 0; } .dt-prog i { display:block; height:100%; background:var(--accent); width:0; transition: width .4s; }
.dt-says { font-size:12px; color:var(--dim); line-height:1.4; }
.dt-chip { font-size:10.5px; font-weight:700; padding:1px 6px; border-radius:99px; background:var(--card3); color:var(--faint); }
.dt-chip.on { background:var(--ok-soft, var(--accent-soft)); color:var(--ok, var(--accent)); }
.dt-track { cursor:pointer; } .dt-track:hover { border-color: var(--line2); } .dt-track.sel { border-color: var(--accent); }
.dt-track .c { display:flex; gap:4px; justify-content:flex-end; }
.dt-prev { border:1px solid var(--line); border-radius:10px; background:var(--card); padding:8px; margin:4px 0 8px; }
.dt-prev canvas { width:100%; height:78px; display:block; border-radius:6px; background: var(--card2); }
.dt-prev .k { display:flex; flex-wrap:wrap; gap:4px 10px; font-size:11px; color:var(--dim); margin-top:6px; }
.dt-prev .k span::before { content:''; display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:4px; vertical-align:-1px; background: var(--c); }
.dt-search { width:100%; box-sizing:border-box; margin:2px 0 6px; }
.dt-small { font-size:11.5px; color:var(--faint); line-height:1.4; }
.dt-helper { border:1px solid var(--line); border-radius:12px; background:var(--card); padding:9px 11px; margin:4px 0 8px; }
.dt-helper .dt-btns { margin:8px 0 0; }
.dt-pick { border:1px solid var(--line); border-radius:12px; background:var(--card); padding:8px 10px; margin:0 0 8px; }
.dt-pick .dt-search { margin:4px 0 4px; }
.dt-pick .r { display:flex; align-items:center; gap:8px; padding:5px 2px; border-top:1px solid var(--line); font-size:12px; min-width:0; }
.dt-pick .r:first-of-type { border-top:0; }
.dt-pick .r .x { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dt-pick .r .x small { color:var(--dim); }
.dt-pick .r button { flex:none; }
.dt-pick .r .x small.w { display:block; white-space:normal; margin-top:2px; line-height:1.35; }
`;
const SEC_COL: Record<string, string> = { intro: '#5b8def', groove: '#3fbf8f', build: '#f0a83c', drop: '#ef4d6a', breakdown: '#9a6cf0', outro: '#6d7a90' };
let cssDone = false;
let root: HTMLElement | null = null;
let lib: Lib | undefined;
let found: Found[] | null = null;
let tracks: TrackRow[] = [];
let query = '';
/** The "Now playing" picker: its search and results. */
let pickQ = '';
let pickRes: TrackRow[] = [];
let pickOpen = false;
let sel: TrackDetail | null = null;
let poll = 0, busy = false, lastSig = '';
let readOnly = false;
let features: TrackFeatures | null = null;
let decoding = false;
/** The studio page's deadline for analysing one track (the helper gives up on a handed-out job after 10 minutes). */
const PAGE_JOB_MS = 5 * 60000;

async function api<T>(method: string, path: string, data?: unknown, click = false, raw?: Blob): Promise<T> {
  const r = await fetch(`/api/music/library${path}`, { method, cache: 'no-store', headers: { ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...(click ? { 'x-vtp-user-action': '1' } : {}) }, body: raw ?? (data === undefined ? undefined : JSON.stringify(data)) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error || `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
async function refresh(full = false) {
  if (busy) return;
  busy = true;
  try {
    lib = await api<Lib>('GET', '');
    if (full || !tracks.length || poll % 5 === 0) tracks = (await api<{ tracks: TrackRow[] }>('GET', `/tracks?limit=40&q=${encodeURIComponent(query)}`)).tracks;
    void pageJobs();
  } catch { /* the next poll tries again */ }
  finally { busy = false; }
  render();
}

// ---------------------------------------------------------------------------------------------------- studio-side jobs
/** Files the helper can't decode (no ffmpeg): the browser decodes them off-screen (never played) and a worker analyses
 *  them. The helper only hands out a job when you're not live. */
async function pageJobs() {
  if (decoding || readOnly || !lib?.analyzer.pageJobs) return;
  decoding = true;
  try {
    const { job } = await api<{ job: { id: string; name: string } | null }>('GET', '/page-job');
    if (!job) return;
    const bytes = await (await fetch(`/api/music/library/file/${encodeURIComponent(job.id)}`, { cache: 'no-store' })).arrayBuffer();
    const ctx = new OfflineAudioContext(1, 22050, 22050);          // decode only: an offline context never reaches the speakers
    const buf = await ctx.decodeAudioData(bytes);
    const pcm = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) pcm[i] += d[i] / buf.numberOfChannels; }
    // the analysis has a deadline too: past it the worker is terminated and the helper told (the track is marked failed)
    const w = new Worker(new URL('../audio/trackAnalyzeWorker.ts', import.meta.url), { type: 'module', name: 'vtp-track-analyse' });
    let timer = 0;
    try {
      const a = await new Promise<unknown>((res, rej) => {
        timer = window.setTimeout(() => rej(new Error('it took too long')), PAGE_JOB_MS);
        w.onmessage = (e) => (e.data.ok ? res(e.data.a) : rej(new Error(e.data.error))); w.onerror = (e) => rej(new Error(e.message));
        w.postMessage({ id: job.id, pcm }, [pcm.buffer]);
      });
      await api('POST', `/analysis/${encodeURIComponent(job.id)}`, a);
    } catch (e) { await api('POST', `/analysis/${encodeURIComponent(job.id)}`, { failed: (e as Error).message || 'failed' }).catch(() => null); }
    finally { clearTimeout(timer); w.terminate(); }
  } catch { /* the next poll tries the next one */ }
  finally { decoding = false; }
}

// ---------------------------------------------------------------------------------------------------- actions
async function allowRoots(add: string[], remove: string[] = []) {
  if (remove.length && !confirm('Stop VTube Pro reading these music folders? (Allow them again any time.)')) return;
  try { await api('POST', '/roots', { add, remove }, true); } catch (e) { toast(`Couldn’t change that: ${(e as Error).message}`, 'err'); }
  await refresh(true);
}
async function findLibraries() {
  try { found = (await api<{ found: Found[] }>('POST', '/find', {}, true)).found; if (!found.length) toast('No DJ library found on this PC. Export your collection from your DJ app (see the tip), or pick the file below.', 'warn', 6000); }
  catch (e) { toast(`Couldn’t look: ${(e as Error).message}`, 'err'); }
  render(true);
}
async function importOne(f: { kind: string; path: string }, quiet = false) {
  try {
    const r = await api<{ ok: boolean; says: string; added?: number }>('POST', '/import', { kind: f.kind, path: f.path }, true);
    if (!quiet) toast(r.says, r.ok ? 'ok' : 'warn', 5000);
    return r;
  } catch (e) { toast(`Couldn’t import: ${(e as Error).message}`, 'err'); return null; }
}
async function importAll() {
  if (!found?.length) return;
  // rekordbox's XML first: its paths tell same-named analysis files apart
  const order = [...found].sort((a, b) => (a.kind === 'rekordbox-xml' ? -1 : b.kind === 'rekordbox-xml' ? 1 : 0));
  let n = 0;
  for (const f of order) { const r = await importOne(f, true); if (r?.ok) n++; }
  toast(`Imported ${n} of ${order.length} libraries. VTube Pro learns the rest of your tracks when you’re not live.`, 'ok', 6000);
  found = null;
  await refresh(true);
}
function pickFile() {
  const inp = h('input', { type: 'file', accept: '.xml,.nml,.db,.sqlite', style: 'display:none' });
  inp.onchange = async () => {
    const f = inp.files?.[0]; if (!f) return;
    const head = await f.slice(0, 4096).text().catch(() => '');
    const kind = /\.nml$/i.test(f.name) || /<NML/.test(head) ? 'traktor' : /VirtualDJ_Database/.test(head) ? 'vdj' : /DJ_PLAYLISTS/.test(head) ? 'rekordbox-xml' : /mixxx/i.test(f.name) ? 'mixxx' : /\.db$/i.test(f.name) ? 'engine' : '';
    if (!kind) { toast('That doesn’t look like a DJ library export. Pick rekordbox’s exported XML, Traktor’s collection.nml, VirtualDJ’s database.xml, Engine’s m.db or Mixxx’s mixxxdb.sqlite.', 'warn', 7000); return; }
    try { const r = await api<{ ok: boolean; says: string }>('POST', `/upload?kind=${kind}&name=${encodeURIComponent(f.name)}`, undefined, true, f); toast(r.says, r.ok ? 'ok' : 'warn', 5000); }
    catch (e) { toast(`Couldn’t import: ${(e as Error).message}`, 'err'); }
    await refresh(true);
  };
  document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
}
async function setSetting(p: Partial<Settings>) {
  if (readOnly) { toast('This is a test tab: settings are read-only here.', 'warn'); return; }
  try { await api('PUT', '/settings', p); await refresh(); } catch (e) { toast(String(e), 'err'); }
}
/** "I'm not live, learn now" (on) / stop (off): never while OBS streams or records; OBS unknown → one confirm. */
async function learnNow(on: boolean, confirmed = false) {
  if (readOnly) { toast('This is a test tab: settings are read-only here.', 'warn'); return; }
  try {
    const r = await api<{ ok: boolean; says: string; needsConfirm?: boolean }>('POST', '/learn-now', { on, confirm: confirmed }, true);
    if (r.needsConfirm && !confirmed) { if (confirm(`${r.says}\n\nAre you sure you’re not streaming or recording?`)) await learnNow(on, true); return; }
    toast(r.says, r.ok ? 'ok' : 'warn', 7000);
  } catch (e) { toast(`Couldn’t do that: ${(e as Error).message}`, 'warn', 7000); }
  await refresh();
}
/** "Now playing": the DJ says which track plays (a streaming track on a DDJ: nothing else can say). null = stop. */
async function pickNow(id: string | null) {
  if (readOnly) { toast('This is a test tab: the show isn’t changed from here.', 'warn'); return; }
  try {
    const r = await api<{ ok: boolean; says: string }>('POST', '/now', { id });
    toast(r.says, r.ok ? 'ok' : 'warn', 7000);
    if (r.ok) { pickOpen = false; pickQ = ''; pickRes = []; }
  } catch (e) { toast(`Couldn’t do that: ${(e as Error).message}`, 'warn', 7000); }
  await refresh();
  render(true);
}
async function searchPick(q: string) {
  pickQ = q;
  try { pickRes = q.trim() ? (await api<{ tracks: TrackRow[] }>('GET', `/tracks?limit=8&q=${encodeURIComponent(q)}`)).tracks : []; } catch { pickRes = []; }
  render(true);
}
async function openTrack(id: string) {
  try { sel = await api<TrackDetail>('GET', `/track/${encodeURIComponent(id)}`); } catch { sel = null; }
  render(true);
}

// ---------------------------------------------------------------------------------------------------- rendering
function conf(v: number) { const n = Math.round(v * 4); return h('span', { class: 'dt-conf', title: `How sure: ${Math.round(v * 100)} %` }, ...[0, 1, 2, 3].map((i) => h('i', { class: i < n ? 'on' : '' }))); }
/** What the picked (or named) track is doing, in one line. */
function hintLine(H: Hint): string {
  if (H.placed) return H.learned || !H.stream ? 'The show follows it.' : H.heard ? `The show follows it. Learning it while it plays (${Math.min(H.heard, H.need)} of ${H.need} s) — next time it’s found by listening.` : 'The show follows it; it’s learned while it plays.';
  if (H.learned) return 'Listening for where you are in it…';
  if (H.wave) return 'Finding your place in it from rekordbox’s waveform (about a minute the first time). The lights follow the sound until then.';
  return 'Waiting for your decks to say where you are in it. The lights follow the sound until then.';
}
/** "Now playing": a search over the library; picking a track tells VTube Pro what plays (DDJ + streaming). */
function pickerEl(L: Lib): HTMLElement | null {
  if (readOnly || !L.counts.tracks) return null;
  const H = L.matching?.hint ?? null;
  const kids: (HTMLElement | null)[] = [];
  if (H && !pickOpen) {
    kids.push(h('div', { class: 'r', 'data-hint': H.id },
      h('span', { class: 'x' }, `${H.by === 'pick' ? 'You picked' : `${H.from ?? 'Your DJ app'} says`}: ${H.title}${H.artist ? ` — ${H.artist}` : ''}${H.stream ? ` (${H.stream})` : ''}`, h('small', { class: 'w' }, hintLine(H))),
      button('Change', () => { pickOpen = true; render(true); }), H.by === 'pick' ? button('Stop', () => void pickNow(null)) : null));
    return h('div', { class: 'dt-pick', 'data-pick': 'hint' }, ...kids);
  }
  if (!pickOpen) {
    if (L.now) return null;   // (a deck already says what plays)
    if (!L.now && !L.matching?.listening && learnCard()) return null;   // (the "not learned yet" card offers it already)
    if (L.matching?.controller) return h('div', { class: 'dt-small', style: 'margin:-2px 0 8px' }, `Following your decks from ${L.matching.controller} (play, cue, hot cues, loops, tempo). Which track is on? `,
      button('Tell VTube Pro what’s playing', () => { pickOpen = true; render(true); }));
    return h('div', { class: 'dt-small', style: 'margin:-2px 0 8px' }, 'Playing from Beatport, Spotify or a controller (DDJ) and nothing shows here? ',
      button('Tell VTube Pro what’s playing', () => { pickOpen = true; render(true); }));
  }
  const search = h('input', { class: 'dt-search', type: 'search', placeholder: 'What’s playing? Type a title or artist', value: pickQ, 'data-pick-search': '1' });
  search.oninput = () => { const v = search.value; void searchPick(v).then(() => { const el = root?.querySelector<HTMLInputElement>('[data-pick-search]'); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }); };
  kids.push(h('div', { class: 'dt-small' }, 'Pick the track you’re playing: the show follows it on your DJ app’s beat, and VTube Pro learns it so next time it finds it by itself.'), search);
  for (const t of pickRes.slice(0, 6)) kids.push(h('div', { class: 'r', 'data-pick-row': t.id },
    h('span', { class: 'x' }, `${t.title}${t.artist ? ` — ${t.artist}` : ''}`, t.mix ? h('small', null, ` (${t.mix})`) : null, t.stream ? h('small', null, ` · ${t.stream}`) : null),
    button('Playing now', () => void pickNow(t.id), 'primary')));
  if (pickQ.trim() && !pickRes.length) kids.push(h('div', { class: 'dt-small' }, 'Nothing in your library matches. Import your DJ app’s library above (rekordbox: export your collection again after adding tracks).'));
  kids.push(h('div', { class: 'dt-btns' }, button('Close', () => { pickOpen = false; render(true); })));
  queueMicrotask(() => { if (document.activeElement === document.body) search.focus(); });
  return h('div', { class: 'dt-pick', 'data-pick': 'open' }, ...kids);
}
const SVC_LABEL: Record<string, string> = { beatport: 'Beatport', beatsource: 'Beatsource', spotify: 'Spotify', tidal: 'TIDAL', soundcloud: 'SoundCloud' };
/** The library in plain words: "40 tracks on this PC · 64 Beatport + 27 Spotify streaming tracks (…) · 62 sampler sounds skipped". */
function countsEl(L: Lib): HTMLElement {
  const c = L.counts, k = L.kinds;
  if (!c.tracks) return h('div', { class: 'dt-counts' }, k?.samples ? `No tracks yet (${k.samples} sampler sound${k.samples === 1 ? '' : 's'} skipped: they aren’t tracks). ` : '', 'One click finds your DJ app’s library (rekordbox, Engine DJ, Traktor, Serato, VirtualDJ, Mixxx) and reads it — read-only, nothing is changed.');
  const parts: (HTMLElement | string)[] = [];
  if (k && k.streaming) {
    if (k.local) parts.push(h('b', null, `${k.local}`), ` track${k.local === 1 ? '' : 's'} on this PC · `);
    const svc = Object.entries(k.stream).filter(([, v]) => v).map(([n, v]) => `${v} ${SVC_LABEL[n] ?? n}`);
    parts.push(h('b', null, svc.join(' + ')), ` streaming track${k.streaming === 1 ? '' : 's'} (shows from rekordbox’s analysis; learned the first time you play them${k.streamLearned ? `: ${k.streamLearned} learned` : ''})`);
  } else parts.push(h('b', null, `${c.tracks}`), ` track${c.tracks === 1 ? '' : 's'}`);
  if (k?.samples) parts.push(` · ${k.samples} sampler sound${k.samples === 1 ? '' : 's'} skipped`);
  return h('div', { class: 'dt-counts' }, h('span', null, ...parts), h('br'),
    h('span', null, h('b', null, `${c.phrases}`), ' with sections · ', h('b', null, `${c.grid}`), ' with a beat grid', c.analysed ? ` · ${c.analysed} learned by VTube Pro` : ''));
}
/** Nothing is followed because the tracks on this PC aren't learned yet: say so, with the progress and the fix right
 *  here (owner feedback: "No analysed track playing" while 0 of 38 were learned and learning waited for the camera). */
function learnCard(): HTMLElement | null {
  const L = lib;
  if (!L) return null;
  const A = L.analyzer, c = L.counts;
  const left = Math.max(0, A.total - A.done), learned = c.analysed, total = learned + left;
  const outside = c.outside ?? 0;
  if (!left && !outside) return null;
  // (the picker is the suggested action while tracks aren't learned: the show follows a picked track right away)
  const pick = !readOnly ? button('Tell VTube Pro what’s playing', () => { pickOpen = true; render(true); }, 'primary') : null;
  if (!left) return h('div', { class: 'dt-now', 'data-learn': 'folders' }, h('div', { class: 't', style: 'white-space:normal' }, `VTube Pro can’t learn ${outside} of your tracks yet`),
    h('div', { class: 'm' }, 'Allow their music folder below (read-only), then it learns them while you’re not live. Until then: ', pick));
  if (A.state === 'running') {
    const eta = A.avgMs ? Math.max(1, Math.round(left * A.avgMs / 60000)) : 0;
    return h('div', { class: 'dt-now', 'data-learn': 'running' }, h('div', { class: 't', style: 'white-space:normal' }, `Learning your tracks: ${learned} of ${total}`),
      h('div', { class: 'dt-prog' }, h('i', { style: `width:${Math.round(learned / Math.max(1, total) * 100)}%` })),
      h('div', { class: 'm' }, h('span', null, `${A.current ? `Now: ${A.current}` : ''}${eta ? ` · about ${eta} min left` : ''}`), h('span', null, 'Playing one of them now? '), pick));
  }
  return h('div', { class: 'dt-now', 'data-learn': A.state }, h('div', { class: 't', style: 'white-space:normal' }, learned ? `VTube Pro has learned ${learned} of ${total} of your tracks` : `VTube Pro hasn’t learned your tracks yet (0 of ${total})`),
    h('div', { class: 'm' }, h('span', null, `It learns while you’re not live.${A.state === 'waiting' && A.says ? ` Waiting because ${A.says.replace(/^Waiting:\s*/, '').replace(/\.\s*Track learning.*$/, '')}.` : ''} Until then the lights follow the sound — or tell VTube Pro which track you’re playing.`)),
    h('div', { class: 'dt-btns', style: 'margin:6px 0 0' },
      A.state === 'waiting' && !readOnly && !/streaming or recording/.test(A.says) ? button('I’m not live — learn now', () => void learnNow(true), 'primary') : null, pick));
}
function nowCard(): HTMLElement {
  const n = lib?.now;
  const li = lib?.matching?.listening;
  if (!n && li) return h('div', { class: 'dt-now', 'data-listening': li.state }, h('div', { class: 't' }, `♪ ${li.title ?? 'A track from your library'}`),
    h('div', { class: 'm' }, li.state === 'locked' ? 'Found by listening.' : 'Found by listening — finding the exact place in the track (a looped part can take a while). The lights follow the sound until then.'));
  if (!n) { const why = learnCard(); if (why) return why; }
  if (!n) return h('div', { class: 'dt-now' }, h('div', { class: 't' }, 'No analysed track playing right now'),
    h('div', { class: 'm' }, 'The lights follow the sound (the realtime show). Play a track from your library and the show is built for it.'));
  const sec = n.sec ? h('span', { class: `dj-sec ${n.sec}` }, n.sec) : null;
  return h('div', { class: 'dt-now', 'data-now': n.id },
    h('div', { class: 't' }, `♪ ${n.title ?? 'Unknown track'}${n.artist ? ` — ${n.artist}` : ''}`),
    h('div', { class: 'm' }, h('span', null, `Deck ${n.deck} · ${n.srcLabel}`), conf(n.conf), sec,
      n.dropIn !== null ? h('span', null, `drop in ${Math.ceil(n.dropIn)} beats`) : null, n.blend ? h('span', null, 'mixing two decks') : null));
}
function preview(d: TrackDetail): HTMLElement {
  const cv = h('canvas', { width: 1200, height: 156 });
  const draw = () => {
    const g = cv.getContext('2d'); if (!g) return;
    const W = cv.width, H = cv.height, dur = d.durMs || 1;
    g.clearRect(0, 0, W, H);
    const bpm0 = d.grid?.anchors[0];
    const msOf = (beat: number) => { const a = d.grid?.anchors.filter((x) => x.beat <= beat).pop() ?? bpm0; return a ? a.ms + (beat - a.beat) * 60000 / a.bpm : 0; };
    // sections underneath
    for (const p of d.phrases) { const x0 = msOf(p.beat) / dur * W, x1 = msOf(p.end) / dur * W; g.fillStyle = SEC_COL[p.sec] ?? '#888'; g.globalAlpha = 0.28; g.fillRect(x0, 0, Math.max(1, x1 - x0), H); g.globalAlpha = 1; g.fillRect(x0, H - 10, Math.max(1, x1 - x0 - 1), 10); }
    // the waveform (low / mid / high stacked)
    if (d.bands) {
      const b = Uint8Array.from(atob(d.bands.b64), (c) => c.charCodeAt(0)), n = d.bands.cols;
      for (let i = 0; i < n; i++) {
        const x = i / n * W, w = Math.max(1, W / n);
        const lo = b[i * 3] / 255, mi = b[i * 3 + 1] / 255, hi = b[i * 3 + 2] / 255, mid = (H - 10) / 2;
        g.fillStyle = 'rgba(80,140,255,.85)'; g.fillRect(x, mid - lo * mid * 0.95, w, lo * mid * 1.9);
        g.fillStyle = 'rgba(255,170,60,.75)'; g.fillRect(x, mid - mi * mid * 0.6, w, mi * mid * 1.2);
        g.fillStyle = 'rgba(255,255,255,.7)'; g.fillRect(x, mid - hi * mid * 0.3, w, hi * mid * 0.6);
      }
    }
    // drops
    g.fillStyle = '#ff2d55';
    for (const D of d.drops) { const x = msOf(D) / dur * W; g.fillRect(x - 1.5, 0, 3, H); }
  };
  requestAnimationFrame(draw);
  const secs = [...new Set(d.phrases.map((p) => p.sec))];
  return h('div', { class: 'dt-prev', 'data-preview': d.id },
    h('div', { class: 'n', style: 'font-weight:650;font-size:12.5px;margin-bottom:6px' }, `${d.title}${d.artist ? ` — ${d.artist}` : ''}`),
    cv,
    h('div', { class: 'k' }, ...secs.map((s) => h('span', { style: `--c:${SEC_COL[s] ?? '#888'}` }, s)), h('span', { style: '--c:#ff2d55' }, `${d.drops.length} drop${d.drops.length === 1 ? '' : 's'}`)),
    h('div', { class: 'dt-small', style: 'margin-top:4px' }, d.show ? `Light show built: ${d.show.cues} cues (${d.show.genre} style), at most ${d.show.maxFlashHz} full flash${d.show.maxFlashHz === 1 ? '' : 'es'} a second.` : d.phrases.length ? '' : 'No sections yet: VTube Pro learns this track when you’re not live.',
      d.srcs.length ? ` From: ${d.srcs.join(', ')}.` : ''));
}
function render(force = false) {
  if (!root) return;
  const L = lib;
  const sig = JSON.stringify([L === undefined ? 0 : [L.settings, L.sources, L.counts, L.kinds, L.matching?.hint, L.matching?.learning, L.matching?.names, L.matching?.controller, pickOpen, pickQ, pickRes.map((t) => t.id), L.roots, L.ask, L.analyzer, L.model.state, L.model.progress && Math.round(L.model.progress.got / 1e6), L.now && [L.now.id, L.now.deck, Math.round(L.now.conf * 4), L.now.sec, L.now.dropIn !== null ? Math.ceil(L.now.dropIn) : null, L.now.blend], L.page ?? ''], found, tracks.map((t) => [t.id, t.st]), sel?.id, readOnly]);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  const kids: (HTMLElement | null)[] = [h('h4', null, 'Track library', L ? h('small', null, 'light shows built for your tracks') : null)];
  if (L === undefined) kids.push(h('p', { class: 'dt-says' }, 'Checking…'));
  else {
    kids.push(nowCard());
    kids.push(pickerEl(L));
    const c = L.counts;
    kids.push(countsEl(L));
    if (!readOnly) kids.push(h('div', { class: 'dt-btns' }, button('Find my DJ libraries', () => void findLibraries(), c.tracks ? '' : 'primary'), button('Pick an exported file…', () => pickFile())));
    if (found) {
      kids.push(found.length ? h('div', { class: 'dt-list', 'data-found': String(found.length) },
        ...found.map((f) => h('div', { class: 'dt-item' }, h('span', { class: 'n' }, f.label), button('Import', () => void importOne(f).then(() => refresh(true))), h('span', { class: 'p' }, f.path))),
        h('div', { class: 'dt-btns' }, button(`Import ${found.length === 1 ? 'it' : `all ${found.length}`}`, () => void importAll(), 'primary'))) : null);
    }
    if (!c.tracks && !found) kids.push(h('div', { class: 'dj-tip' }, h('b', null, 'rekordbox: '), 'File → Export Collection in xml format (once; save it in Documents). Turn on phrase analysis in rekordbox’s Preferences → Analysis so VTube Pro knows every drop. ', h('br'), h('b', null, 'CDJs / XDJs: '), 'turn on “Track names + drop countdown” above — the players send the grid and phrases by themselves.'));
    if (L.sources.length) kids.push(h('div', { class: 'dt-list' }, ...L.sources.slice(0, 6).map((s) => h('div', { class: 'dt-item', 'data-src': s.kind }, h('span', { class: 'n' }, s.label), h('span', { class: 'dt-small' }, s.ok ? '✓' : '!'), h('span', { class: 's' }, s.says)))));
    // music folders: VTube Pro only reads tracks inside folders you allow (your DJ app's list can name any file)
    if (L.ask?.length && !readOnly) {
      kids.push(h('div', { class: 'dt-says', style: 'margin-top:6px' }, 'To learn your tracks, VTube Pro reads the music files in these folders (read-only; nothing else on your PC). Allow the ones that are your music:'));
      kids.push(h('div', { class: 'dt-list', 'data-ask': String(L.ask.length) }, ...L.ask.map((r) => h('div', { class: 'dt-item' }, h('span', { class: 'n' }, r.path), button('Allow', () => void allowRoots([r.path]), 'primary'), h('span', { class: 'p' }, `${r.tracks} track${r.tracks === 1 ? '' : 's'}`)))));
    }
    if (L.roots?.length) kids.push(h('div', { class: 'dt-small', 'data-roots': String(L.roots.length) }, `Music folders allowed: ${L.roots.join(' · ')} `, readOnly ? null : button('Change', () => void allowRoots([], L.roots ?? []))));
    // learning
    const A = L.analyzer, total = Math.max(A.total, A.done);
    if (c.tracks) {
      kids.push(h('div', { class: 'dt-says', 'data-analyzer': A.state }, A.says || (A.state === 'idle' ? 'Every track is ready.' : '')));
      // waiting only because the camera tracks / OBS is open (a preview, not live): the user can say so
      if (!readOnly && L.now && A.state === 'waiting' && !/streaming or recording/.test(A.says)) kids.push(h('div', { class: 'dt-btns', 'data-learn-now': 'offer' }, button('I’m not live — learn now', () => void learnNow(true), 'primary')));
      if (!readOnly && A.learnNow) kids.push(h('div', { class: 'dt-small', 'data-learn-now': 'on' }, `Learning while you’re not live, until ${new Date(A.learnNow).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} or until OBS starts streaming or recording. `, button('Stop', () => void learnNow(false))));
      if (A.state === 'running' && total) kids.push(h('div', { class: 'dt-prog' }, h('i', { style: `width:${Math.round(A.done / total * 100)}%` })));
      if (A.pageJobs && !readOnly) kids.push(h('p', { class: 'dt-small' }, `${A.pageJobs} track${A.pageJobs === 1 ? '' : 's'} can only be read by this browser (no ffmpeg on this PC): keep this tab open while you’re not live and they’re learned one by one.`));
      const M = L.model;
      kids.push(h('div', { class: 'dt-small', style: 'margin:6px 0' }, M.state === 'ready' ? 'The optional beat finder is installed.' : M.state === 'downloading' && M.progress ? `Downloading the optional beat finder… ${Math.round(M.progress.got / 1e6)} / ${Math.round(M.progress.total / 1e6)} MB` : `Tracks without a DJ app’s beat grid use VTube Pro’s own beat finder. The optional beat finder (${M.mb} MB, free) is more accurate and can be added: `,
        M.state !== 'ready' && M.state !== 'downloading' && !readOnly ? button('Get it', () => void api<{ ok: boolean; says: string }>('POST', '/model', {}, true).then((r) => toast(r.says, r.ok ? 'ok' : 'warn')).catch((e) => toast(String(e), 'err'))) : null));
      kids.push(h('div', { class: 'dt-small', 'data-licence': '1' }, `Licence note: ${M.name}, ${M.licence}.`));
      // tracks
      const search = h('input', { class: 'dt-search', type: 'search', placeholder: 'Search your tracks', value: query });
      search.oninput = () => { query = search.value; void api<{ tracks: TrackRow[] }>('GET', `/tracks?limit=40&q=${encodeURIComponent(query)}`).then((r) => { tracks = r.tracks; render(true); search.focus(); }); };
      kids.push(search);
      kids.push(h('div', { class: 'dt-list', 'data-tracks': String(tracks.length) }, ...tracks.slice(0, 40).map((t) => {
        const chip = (on: boolean, label: string, tip: string) => h('span', { class: `dt-chip ${on ? 'on' : ''}`, title: tip }, label);
        return h('div', { class: `dt-item dt-track ${sel?.id === t.id ? 'sel' : ''}`, onClick: () => void openTrack(t.id) },
          h('span', { class: 'n' }, `${t.title}${t.artist ? ` — ${t.artist}` : ''}`),
          h('span', { class: 'c' }, t.stream ? chip(true, t.stream, `Streaming from ${t.stream} through your DJ app: no file on this PC`) : null, chip(t.st.grid, 'grid', 'Beat grid'), chip(t.st.phrases, t.st.drops ? `${t.st.drops} drop${t.st.drops === 1 ? '' : 's'}` : 'sections', t.st.phraseSrc === 'rekordbox' || t.st.phraseSrc === 'cdj' ? 'Sections from rekordbox’s phrase analysis' : 'Sections'), chip(t.st.analysed || !!t.learned, 'learned', t.stream ? 'Learned while it played: found by listening' : 'Analysed by VTube Pro')),
          h('span', { class: 'p' }, `${t.bpm ? `${t.bpm.toFixed(1)} BPM · ` : ''}${t.srcs.join(', ')}${t.err ? ` · ${t.err}` : ''}`));
      })));
      if (sel) kids.push(preview(sel));
      // settings
      kids.push(h('details', null, h('summary', null, 'Track library settings'),
        toggle('Read rekordbox’s phrase analysis', L.settings.phrases, (v) => void setSetting({ phrases: v }), 'Reads the phrases (intro / up / chorus / down / outro) rekordbox stores in its analysis files and CDJs share — read-only. Off = VTube Pro’s own sections are used instead.'),
        toggle('Find the track by listening', L.settings.matchAudio, (v) => void setSetting({ matchAudio: v }), 'When your DJ setup doesn’t say what is playing (rekordbox + a DDJ controller, Traktor, Serato), VTube Pro compares the music input with your learned tracks. It only answers when it is sure. Nothing is recorded.'),
        h('p', { class: 'dt-small' }, L.matching?.tracks ? `Listening for ${L.matching.tracks} learned track${L.matching.tracks === 1 ? '' : 's'}. It usually knows the track within seconds; the exact place in a looped part can take until the music changes. Still learning your library? Tracks are added as they’re learned.` : 'Listening starts once VTube Pro has learned some of your tracks (learning…).'),
        toggle('Learn tracks by itself', L.settings.autoAnalyse, (v) => void setSetting({ autoAnalyse: v }), 'Analyses tracks in the background, one at a time, never while you’re live.'),
        L.settings.traktorCast !== undefined ? traktorCastRow(L) : null,
        L.matching?.names?.serato ? h('p', { class: 'dt-small', 'data-serato': String(L.matching.names.serato.length) }, L.matching.names.serato.length ? `Serato’s history says: ${L.matching.names.serato.map((d) => `deck ${d.deck}: ${d.title}`).join(' · ')}` : 'Serato: VTube Pro reads which track is on each deck from Serato’s history while you play.') : null,
        vdjPortRow(),
        h('div', { class: 'dt-btns' }, !readOnly ? button('Clear the track library', () => { if (confirm('Forget every imported track? Your DJ app’s files are not touched.')) void api('POST', '/clear', {}, true).then(() => { sel = null; tracks = []; return refresh(true); }); }) : null),
        h('p', { class: 'dt-small' }, `Stored in VTube Pro’s own folder (${Math.round(c.bytes / 1e5) / 10} MB of 50). Never audio, never a copy of a music file.`)));
    }
  }
  root.replaceChildren(...kids.filter((k): k is HTMLElement => !!k));
}

/** Traktor: track names from its Broadcasting (VTube Pro is a local Icecast server for it; metadata only). */
function traktorCastRow(L: Lib): HTMLElement {
  const T = L.matching?.names?.traktor, port = L.settings.traktorCastPort ?? 18000, on = !!L.settings.traktorCast;
  const portIn = h('input', { type: 'number', min: '1024', max: '65535', value: String(port), style: 'width:7em', disabled: readOnly });
  portIn.onchange = () => { const n = Math.round(Number(portIn.value)); if (!(n >= 1024 && n <= 65535)) { toast('Use a port from 1024 to 65535.', 'warn'); return; } void setSetting({ traktorCastPort: n }); };
  return h('div', { 'data-traktor-cast': on ? (T?.connected ? 'connected' : 'on') : 'off' },
    toggle('Track names from Traktor (Broadcasting)', on, (v) => void setSetting({ traktorCast: v }), 'Traktor shares the title of the track on air through its Broadcasting feature. VTube Pro receives it on this PC only and keeps only the title and artist: no audio is stored or sent anywhere.'),
    on ? h('div', { class: 'dt-small', style: 'margin:2px 0 6px' },
      'In Traktor: Preferences → Broadcasting → Server Settings: Address ', h('b', null, '127.0.0.1'), ', Port ', h('b', null, String(port)), ', Mount Path ', h('b', null, '/vtubepro'), ', Password ', h('b', null, 'vtubepro'),
      ', Format ', h('b', null, 'Ogg Vorbis, 11025 Hz, 32 kBit/s'), ' (the smallest). Then click the Broadcasting (antenna) button in Traktor’s header. ',
      h('br'), T?.connected ? (T.title ? `Connected · on air: ${T.title}${T.artist ? ` — ${T.artist}` : ''}` : 'Connected · waiting for the first track name.') : (T?.says || 'Waiting for Traktor.'),
      h('label', { class: 'row', style: 'margin-top:4px' }, h('span', { class: 'lbl' }, 'Port'), portIn)) : null);
}
/** VirtualDJ's OSC port (its oscPort setting): DJ sync then asks it for each deck's file + position (this PC only). */
let vdjPort: number | null = null;
function vdjPortRow(): HTMLElement {
  if (vdjPort === null) void fetch('/api/music', { cache: 'no-store' }).then((r) => r.json()).then((v: { config?: { vdjOscPort?: number } }) => { vdjPort = v.config?.vdjOscPort ?? 0; render(true); }).catch(() => {});
  const inp = h('input', { type: 'number', min: '0', max: '65535', value: String(vdjPort ?? 0), style: 'width:7em', disabled: readOnly });
  inp.onchange = () => { const n = Math.round(Number(inp.value)); if (!(n === 0 || (n >= 1024 && n <= 65535))) { toast('Use 0 (off) or VirtualDJ’s oscPort (1024–65535).', 'warn'); return; } void fetch('/api/music', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vdjOscPort: n }) }).then(() => { vdjPort = n; toast(n ? `Asking VirtualDJ on port ${n} for its decks’ files and positions.` : 'VirtualDJ OSC off.', 'ok'); }); };
  return h('label', { class: 'row', title: 'VirtualDJ → Settings: oscPort (e.g. 9000) and oscPortBack = 4460. Then type the oscPort here. 0 = off.' }, h('span', { class: 'lbl' }, 'VirtualDJ OSC port (track position)'), inp);
}

/** The "Track library" part of the DJ sync section (src/ui/djSyncPanel.ts). */
export function trackLibraryEl(app: App): HTMLElement {
  return mount(app.scene.observer && !/[?&]djTest=1/.test(location.search));
}
/** The helper's own Track library page (tools.html?view=djlib, src/tools/djlibView.ts): same panel, on this PC. */
export function trackLibraryPageEl(): HTMLElement { return mount(false); }
function mount(ro: boolean): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  readOnly = ro;
  if (!root) root = h('div', { class: 'dt-wrap', 'data-tick': '1' });
  if (!poll) { void refresh(true); poll = window.setInterval(() => { if (root?.isConnected) { poll++; void refresh(); } }, 2000); }
  // (not synchronously: this runs inside the panel's rerender (src/ui/dom.ts), which puts nodes removed during its build
  // back where they were, so replacing the root's children here doubled them: two "Set up …" buttons)
  else if (!root.childElementCount) render(true);
  else queueMicrotask(() => render());
  return root;
}
/** Studio start (from djSyncBoot): the music input's onsets go to the helper for audio matching while DJ sync and
 *  "Find the track by listening" are on and the library has learned tracks. Never in observer / test tabs. */
export function djTrackBoot(app: App) {
  if (app.scene.observer) return;
  features ??= new TrackFeatures();
  const follow = async () => {
    try {
      const m = await (await fetch('/api/music', { cache: 'no-store' })).json() as { config?: { enabled?: boolean } };
      const L = await api<Lib>('GET', '');
      // (the server says when: learned tracks to listen for, or streaming tracks to place / learn while they play)
      features!.set(!!m.config?.enabled && L.settings.matchAudio && (L.listen ?? L.counts.analysed > 0));
    } catch { features!.set(false); }
  };
  void follow();
  window.setInterval(() => void follow(), 15000);
}
