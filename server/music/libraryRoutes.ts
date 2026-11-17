// Track library REST (the DJ sync panel's "Track library"):
//   GET  /api/music/library                     → settings, sources, counts, analyser + model state, now playing
//   GET  /api/music/library/tracks?q=&limit=    → library entries (search)
//   GET  /api/music/library/track/:id           → one track for the preview: grid, phrases, waveform, energy, cues, show summary
//   POST /api/music/library/find                → the DJ libraries on this PC (looked at only now, on the user's click)
//   POST /api/music/library/import {kind, path} → import one (read-only) — a path from "find", or one the user typed
//   POST /api/music/library/upload?kind=        → import an exported file the user picked in the browser (body = the file)
//   PUT  /api/music/library/settings            → settings patch
//   POST /api/music/library/analyse {all?}      → (re)start learning tracks now (still never while live)
//   POST /api/music/library/model               → fetch the optional beat-finder model (user click; pinned + checksummed)
//   GET  /api/music/library/page-job            → a track the studio page should decode (no ffmpeg here) + its bytes:
//   GET  /api/music/library/file/:id            →   the music file (this PC only, studio tab only, read-only)
//   POST /api/music/library/analysis/:id        →   the page's analysis of it ({failed} = the page gave up on it)
//   POST /api/music/library/roots {add?, remove?} → the music folders the user allows tracks to be read from
//   POST /api/music/library/clear               → forget the library (our own folder only)
//   POST /api/music/library/learn-now {on, confirm?} → "I'm not live, learn now" (never while OBS streams / records; OBS's
//                                                  state unknown → {needsConfirm} first); 2 hours at most
//   POST /api/music/library/now {id|null}       → "Now playing": the DJ picks the track that plays (streaming tracks on a
//                                                  DDJ: nothing else says which); null = find it by itself again
// Music files are only read inside the music folders the user allowed (store.ts readable), and only audio files.
import fs from 'node:fs';
import { pipeline } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import express, { Router } from 'express';
import { HttpError } from '../library.ts';
import { requireLocal } from '../routes/util.ts';
import { analysisStatus, dropStarts, sanitizeAnalysis, SRC_LABEL } from '../../shared/trackAnalysis.ts';
import { detectSources } from './library/detect.ts';
import { IMPORT_KINDS, IMPORT_LABEL, type ImportKind } from './library/types.ts';
import { BEAT_THIS_MODEL, downloadModel, modelState } from './library/beatThis.ts';
import type { TrackSync } from './trackSync.ts';
import { STREAM_LABEL } from './library/streaming.ts';

const USER_ACTION = 'x-vtp-user-action';
/** VTube Pro's own Track library page (src/tools/djlibView.ts): where the local-only parts (find / import / allow folders) happen. */
export const LIBRARY_PAGE = '/tools.html?view=djlib';
/** What each kind of import may be pointed at: the DJ app's own collection file (by its type) or folder. */
const IMPORT_TARGET: Record<ImportKind, { file: RegExp; dir: boolean }> = {
  'rekordbox-xml': { file: /\.xml$/i, dir: false }, 'rekordbox-anlz': { file: /^ANLZ\d+\.(DAT|EXT|2EX)$/i, dir: true }, engine: { file: /\.db$/i, dir: true },
  traktor: { file: /\.nml$/i, dir: false }, serato: { file: /^database V2$/i, dir: true }, vdj: { file: /\.xml$/i, dir: false }, mixxx: { file: /\.(sqlite|db)$/i, dir: false },
};
/** A path typed / found for an import: absolute, no ".." step, and the kind of file or folder that app keeps. */
export function importTargetOk(kind: ImportKind, p: string): boolean {
  if (!p || p.length > 1000 || p.includes('\0') || !path.isAbsolute(p) || p.split(/[\\/]+/).includes('..')) return false;
  let st: fs.Stats; try { st = fs.statSync(p); } catch { return false; }
  const t = IMPORT_TARGET[kind];
  return st.isDirectory() ? t.dir : st.isFile() && t.file.test(path.basename(p));
}

export function libraryRoutes(ts: () => TrackSync, dataDir: string): Router {
  const r = Router();
  const userAction = (req: { headers: Record<string, unknown> }) => { if (req.headers[USER_ACTION] !== '1') throw new HttpError(403, 'Press the button in VTube Pro on this PC'); };
  let modelBusy: { got: number; total: number } | null = null;

  r.get('/api/music/library', (_req, res) => {
    const t = ts(), es = [...t.lib.entries.values()];
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      settings: t.settings, sources: t.lib.sources.map((s) => ({ ...s, label: IMPORT_LABEL[s.kind] })),
      counts: { tracks: es.length, grid: es.filter((e) => e.st.grid).length, phrases: es.filter((e) => e.st.phrases).length, analysed: es.filter((e) => e.st.analysed).length, waiting: es.filter((e) => e.needs && !e.err).length, failed: es.filter((e) => e.err).length, outside: t.lib.outsideRoots(), bytes: t.lib.bytes() },
      // tracks on this PC / streaming tracks per service / sampler sounds skipped (the panel's plain counts)
      kinds: t.lib.kinds(),
      // the studio should send the music input's features (listening + learning streaming tracks while they play)
      listen: t.settings.matchAudio && (t.lmIndex.size > 0 || es.some((e) => e.st.analysed || e.stream)),
      roots: t.lib.roots, ask: t.lib.ask,
      analyzer: t.analyzer.state(),
      model: { state: modelBusy ? 'downloading' : modelState(dataDir), progress: modelBusy, name: BEAT_THIS_MODEL.name, mb: Math.round(BEAT_THIS_MODEL.bytes / 1e6), licence: BEAT_THIS_MODEL.licence },
      now: t.nowPlayingView(),
      matching: t.matchingView(),
      // VTube Pro's own page for the parts the studio tab may not do (find / import / allow folders)
      page: LIBRARY_PAGE,
    });
  });
  r.get('/api/music/library/tracks', (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase().slice(0, 80), limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const lib = ts().lib;
    // (words in any order, case and accents ignored: "deathmachine sick" finds "Sick Bass — Deathmachine")
    const list = (q ? lib.search(q, limit) : [...lib.entries.values()].sort((a, b) => b.used - a.used || (a.title ?? a.base).localeCompare(b.title ?? b.base)).slice(0, limit))
      .map((e) => ({ id: e.id, title: e.title ?? (e.stream ? `${STREAM_LABEL[e.stream.svc]} track` : e.base), artist: e.artist ?? '', ...(e.mix ? { mix: e.mix } : {}), bpm: +e.bpm.toFixed(2), durMs: e.durMs, st: e.st, needs: e.needs, err: e.err ?? null, srcs: e.srcs.map((s) => SRC_LABEL[s]),
        stream: e.stream ? STREAM_LABEL[e.stream.svc] : null, learned: !!e.lm }));
    res.json({ tracks: list, total: ts().lib.entries.size });
  });
  r.get('/api/music/library/track/:id', (req, res) => {
    const t = ts(), id = String(req.params.id);
    const e = t.lib.entries.get(id), a = e ? t.lib.analysis(id) : null;
    if (!e || !a) throw new HttpError(404, 'That track isn’t in the library');
    const show = t.showOf(id);
    res.json({
      id, title: e.title ?? (e.stream ? `${STREAM_LABEL[e.stream.svc]} track` : e.base), artist: e.artist ?? '', stream: e.stream ? STREAM_LABEL[e.stream.svc] : null, learned: !!e.lm, durMs: a.durMs, bpm: a.bpm, st: analysisStatus(a), srcs: a.srcs.map((s) => SRC_LABEL[s]),
      grid: a.grid, phrases: a.phrases, energy: a.energy ?? [], bands: a.bands ?? null, cues: a.cues, events: a.events, drops: dropStarts(a.phrases),
      show: show ? { id: show.id, genre: show.genre, cues: show.cues.length, drops: show.drops, maxFlashHz: show.maxFlashHz, sections: show.sections } : null,
    });
  });
  r.post('/api/music/library/find', (req, res) => {
    requireLocal(req); userAction(req);
    res.json({ found: detectSources().map((f) => ({ ...f, kindLabel: IMPORT_LABEL[f.kind] })) });
  });
  r.post('/api/music/library/import', async (req, res) => {
    requireLocal(req); userAction(req);
    const kind = String(req.body?.kind ?? '') as ImportKind, where = String(req.body?.path ?? '');
    if (!(IMPORT_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'Unknown library kind');
    if (!where || where.length > 1000) throw new HttpError(400, 'Which file or folder?');
    if (!importTargetOk(kind, where)) { res.json({ ok: false, says: `That isn’t a ${IMPORT_LABEL[kind]} (pick the app’s own collection file or folder).` }); return; }
    try { res.json({ ok: true, ...(await ts().import(kind, path.resolve(where))) }); }
    catch (e) { res.json({ ok: false, says: `Couldn’t read it: ${(e as Error).message}` }); }
  });
  // an exported file picked in the browser: imported from a temporary copy, deleted right after
  r.post('/api/music/library/upload', express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
    requireLocal(req); userAction(req);
    const kind = String(req.query.kind ?? '') as ImportKind;
    if (!['rekordbox-xml', 'traktor', 'vdj', 'engine', 'mixxx'].includes(kind)) throw new HttpError(400, 'Pick a rekordbox XML, Traktor collection.nml, VirtualDJ database.xml, Engine m.db or Mixxx mixxxdb.sqlite');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'The file was empty');
    const name = String(req.query.name ?? 'upload').replace(/[^\w.-]+/g, '_').slice(0, 80);
    const tmp = path.join(os.tmpdir(), `vtp-djlib-${process.pid}-${Date.now()}-${name}`);
    fs.writeFileSync(tmp, body);
    try { res.json({ ok: true, ...(await ts().import(kind, tmp)) }); }
    catch (e) { res.json({ ok: false, says: `Couldn’t read it: ${(e as Error).message}` }); }
    finally { try { fs.unlinkSync(tmp); } catch { /* temp */ } }
  });
  r.put('/api/music/library/settings', (req, res) => { requireLocal(req); ts().updateSettings(req.body); res.json({ settings: ts().settings }); });
  r.post('/api/music/library/analyse', (req, res) => {
    requireLocal(req);
    const t = ts();
    if (req.body?.all !== undefined) t.updateSettings({ analyseAll: !!req.body.all });
    t.analyzer.start(); t.analyzer.kick();
    res.json({ ok: true, analyzer: t.analyzer.state() });
  });
  r.post('/api/music/library/model', async (req, res) => {
    requireLocal(req); userAction(req);
    if (modelBusy) { res.json({ ok: false, says: 'Already downloading.' }); return; }
    if (modelState(dataDir) === 'ready') { res.json({ ok: true, says: 'Already installed.' }); return; }
    if (process.env.VTP_TOOLS_DRYRUN === '1' || process.env.VTP_NO_MODEL_DOWNLOAD === '1') { res.json({ ok: true, dryRun: true, says: `Would download ${BEAT_THIS_MODEL.name} (${Math.round(BEAT_THIS_MODEL.bytes / 1e6)} MB) and check its checksum.` }); return; }
    modelBusy = { got: 0, total: BEAT_THIS_MODEL.bytes };
    res.json({ ok: true, says: 'Downloading…' });
    void downloadModel(dataDir, { progress: (got, total) => { modelBusy = { got, total }; } }).then((r2) => { modelBusy = null; if (!r2.ok) console.log(`[music] beat finder download: ${r2.says}`); });
  });
  r.get('/api/music/library/page-job', async (req, res) => { requireLocal(req); res.json({ job: await ts().analyzer.nextPageJob() }); });
  r.get('/api/music/library/file/:id', (req, res) => {
    requireLocal(req);
    const t = ts(), id = String(req.params.id);
    // only a track handed out as a page job, only an audio file, only inside a music folder the user allowed (links
    // followed: the real file must be inside too)
    // (opened first, then the handle checked: what is streamed is the file that was checked)
    const h = t.analyzer.openPageFile(id);
    if (!h) throw new HttpError(404, 'Not waiting for the studio');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/octet-stream');
    // (pipeline: however the response ends — done, aborted, failed — the read stream is destroyed and the handle closed)
    pipeline(fs.createReadStream('', { fd: h.fd, autoClose: true }), res, () => { /* aborted / done */ });
  });
  r.post('/api/music/library/analysis/:id', express.json({ limit: '4mb' }), (req, res) => {
    requireLocal(req);
    if (req.body && typeof req.body.failed === 'string') { res.json({ ok: ts().analyzer.pageFailed(String(req.params.id), req.body.failed) }); return; }
    const a = sanitizeAnalysis(req.body);
    if (!a) throw new HttpError(400, 'Not an analysis');
    res.json({ ok: ts().analyzer.pageResult(String(req.params.id), a) });
  });
  r.post('/api/music/library/roots', (req, res) => {
    requireLocal(req); userAction(req);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 32) : []);
    const t = ts();
    t.lib.setRoots(list(req.body?.add), list(req.body?.remove));
    t.analyzer.kick();
    res.json({ ok: true, roots: t.lib.roots, ask: t.lib.ask });
  });
  r.post('/api/music/library/learn-now', async (req, res) => {
    requireLocal(req); userAction(req);
    const t = ts();
    if (req.body?.on && !t.settings.autoAnalyse) t.updateSettings({ autoAnalyse: true });
    const r2 = await t.analyzer.setLearnNow(!!req.body?.on, req.body?.confirm === true);
    res.json({ ...r2, analyzer: t.analyzer.state() });
  });
  r.post('/api/music/library/now', (req, res) => {
    requireLocal(req);
    const id = req.body?.id;
    if (id !== null && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id))) throw new HttpError(400, 'Which track?');
    res.json({ ...ts().pick(id), hint: ts().hintView() });
  });
  r.post('/api/music/library/clear', (req, res) => { requireLocal(req); userAction(req); ts().lib.clear(); res.json({ ok: true }); });
  return r;
}
