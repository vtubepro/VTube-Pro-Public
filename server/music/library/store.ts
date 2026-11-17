// The track library: every DJ app's analysis merged per track, kept in the helper's own data folder
// (<data>/musicLibrary: index.json + one gzipped TrackAnalysis per track, LRU-capped at 50 MB). Never audio, never a copy
// of a music file, nothing but the user's own library. Lookups for the live follower: by the app's path, by file name,
// by title + artist (+ length when known).
// Music files are only ever opened (to learn a track, or handed to the studio page to decode) when they are audio files
// inside a MUSIC FOLDER the user allowed (`roots`): a collection file can name any path, so the folders its tracks live
// in are shown to the user ("Allow") and nothing outside them is read.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  ANALYSIS_VERSION, analysisStatus, baseName, emptyAnalysis, mergeAnalysis, normName, sanitizeAnalysis, type TrackAnalysis, type TrackSrc,
} from '../../../shared/trackAnalysis.ts';
import type { TrackIdent } from '../../../shared/trackFollow.ts';
import type { ImportKind, ImportResult, ImportedTrack } from './types.ts';
import { isSampleEntry, nameScore, STREAM_SERVICES, streamFromBase, streamKey, titleKey, type StreamRef, type StreamService } from './streaming.ts';

export interface LibEntry {
  id: string; base: string; path?: string;
  title?: string; artist?: string; durMs: number; bpm: number;
  /** The version when the app keeps it apart from the title (rekordbox's Mix: "Extended Mix"). */
  mix?: string;
  /** A streaming track (Beatport, Spotify, …): there is no file; learned by listening while it plays (trackSync.ts). */
  stream?: StreamRef;
  srcs: TrackSrc[];
  refs: Partial<Record<TrackSrc, string>>;
  st: ReturnType<typeof analysisStatus>;
  /** Our own analysis is wanted (no phrases from the DJ app) and hasn't run yet. */
  needs: boolean;
  /** Has spectral landmarks (can be found by listening). */
  lm?: boolean;
  /** Last time the follower / UI used it (LRU). */
  used: number;
  err?: string;
  /** Our analysis was dropped to keep the library under its cap: learned again only once the track is played. */
  pruned?: boolean;
}
export interface LibSource { kind: ImportKind; path: string; at: number; tracks: number; says: string; ok: boolean; samples?: number }
/** What the library holds, for the panel: tracks on this PC, streaming tracks per service, sampler sounds skipped. */
export interface LibKinds { local: number; streaming: number; stream: Partial<Record<StreamService, number>>; samples: number; streamLearned: number }
/** A folder imported tracks live in that the user hasn't allowed yet. */
export interface RootAsk { path: string; tracks: number }
interface IndexFile { v: 1; sources: LibSource[]; tracks: LibEntry[]; roots?: string[]; ask?: RootAsk[] }

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1').toLowerCase().normalize('NFC');

/** The audio files a track may be (nothing else is ever opened or streamed). */
export const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aif', '.aiff', '.aifc', '.flac', '.m4a', '.aac', '.mp4', '.alac', '.ogg', '.oga', '.opus', '.wma']);
export const isAudioPath = (p: string) => AUDIO_EXTS.has(path.extname(p).toLowerCase());
/** A track path from a collection, safe to keep: absolute, no ".." step, an audio file name (else undefined). */
export function cleanTrackPath(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p || p.length > 1000 || p.includes('\0')) return undefined;
  if (p.split(/[\\/]+/).some((seg) => seg === '..')) return undefined;
  if (!(path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p))) return undefined;
  return isAudioPath(p) ? p : undefined;
}
const caseless = process.platform !== 'linux';
/** Comparable form of a path (case-insensitive on Windows and macOS). */
const cmpPath = (p: string) => { const n = path.resolve(p).replace(/\\/g, '/').normalize('NFC').replace(/\/+$/, ''); return caseless ? n.toLowerCase() : n; };
/** Is `file` strictly inside folder `root`? */
export const insideFolder = (file: string, root: string) => cmpPath(file).startsWith(`${cmpPath(root)}/`);
/** The music folders a set of track paths suggests: each track's folder, folded into a listed folder above it; only when
 *  there are more than `max` do the deepest ones go up to their parent (so a stray folder is shown as itself, never
 *  hidden inside a broad one). */
export function suggestRoots(paths: string[], max = 12): RootAsk[] {
  const depth = (p: string) => path.relative(path.parse(p).root, p).split(path.sep).filter(Boolean).length;
  const merge = (l: RootAsk[]) => { const m = new Map<string, RootAsk>(); for (const d of l) { const k = cmpPath(d.path), c = m.get(k); if (c) c.tracks += d.tracks; else m.set(k, { ...d }); } return [...m.values()]; };
  const fold = (l: RootAsk[]) => { const out: RootAsk[] = []; for (const d of [...l].sort((a, b) => a.path.length - b.path.length)) { const up = out.find((o) => insideFolder(d.path, o.path)); if (up) up.tracks += d.tracks; else out.push({ ...d }); } return out; };
  let list = fold(merge(paths.map((p) => ({ path: path.dirname(path.resolve(p)), tracks: 1 }))));
  while (list.length > max) {
    const deepest = Math.max(...list.map((d) => depth(d.path)));
    if (deepest <= 1) break;
    list = fold(merge(list.map((d) => (depth(d.path) === deepest ? { path: path.dirname(d.path), tracks: d.tracks } : d))));
  }
  return list.sort((a, b) => b.tracks - a.tracks || a.path.localeCompare(b.path)).slice(0, max);
}

export class TrackLibrary {
  entries = new Map<string, LibEntry>();
  sources: LibSource[] = [];
  /** Music folders the user allowed: tracks are only read from inside them. */
  roots: string[] = [];
  /** Folders with imported tracks that the user hasn't allowed yet (the panel asks). */
  ask: RootAsk[] = [];
  private byPath = new Map<string, string>();
  private byBase = new Map<string, string[]>();
  private byName = new Map<string, string[]>();
  private byTitle = new Map<string, string[]>();
  private cache = new Map<string, TrackAnalysis>();
  private dirty = false;
  /** Bytes the analysis files may use (default 50 MB: the cache must stay small). */
  capBytes = 50 << 20;
  constructor(readonly dir: string) {}

  private file(id: string) { return path.join(this.dir, 'a', `${id}.json.gz`); }
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')) as IndexFile;
      if (j?.v === 1) {
        this.sources = Array.isArray(j.sources) ? j.sources.slice(0, 32) : [];
        this.roots = Array.isArray(j.roots) ? j.roots.filter((r) => typeof r === 'string' && path.isAbsolute(r)).slice(0, 64) : [];
        this.ask = Array.isArray(j.ask) ? j.ask.filter((r) => r && typeof r.path === 'string' && typeof r.tracks === 'number').slice(0, 12) : [];
        for (const e of j.tracks ?? []) if (e && typeof e.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.id)) { if (e.path !== undefined && !cleanTrackPath(e.path)) delete e.path; this.entries.set(e.id, e); }
      }
    } catch { /* first run */ }
    const migrated = this.migrate();
    this.reindex();
    // (a library saved before music folders existed has no `ask`: work it out now, so the panel offers Allow)
    this.updateAsk(); this.dirty = false;
    // (a library fixed by migrate() is written back at once: the next start finds it fixed)
    if (migrated) { this.dirty = true; this.save(); }
  }
  save() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = path.join(this.dir, `index.json.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, sources: this.sources, tracks: [...this.entries.values()], roots: this.roots, ask: this.ask } satisfies IndexFile));
      fs.renameSync(tmp, path.join(this.dir, 'index.json'));
      this.dirty = false;
    } catch { /* disk full: try again next time */ }
  }
  /** A library saved before streaming tracks were understood: their analysis entries ("beatport:tracks:<id>", no file)
   *  waited for a file forever, and rekordbox's sampler sounds were listed as tracks. Both are fixed in place. */
  private migrate(): boolean {
    let changed = false;
    for (const e of [...this.entries.values()]) {
      if (e.stream && !(STREAM_SERVICES as readonly string[]).includes(e.stream.svc)) delete e.stream;
      const st = !e.path ? (e.stream ?? streamFromBase(e.base)) : null;
      if (st) {
        if (!e.stream || e.base !== streamKey(st)) { e.stream = st; e.base = streamKey(st); changed = true; }
        if (e.needs) { e.needs = false; changed = true; }
        continue;
      }
      if (isSampleEntry({ path: e.path, ...(e.durMs > 0 ? { durS: e.durMs / 1000 } : {}) })) {
        this.entries.delete(e.id); this.cache.delete(e.id);
        try { fs.unlinkSync(this.file(e.id)); } catch { /* none */ }
        changed = true;
      }
    }
    return changed;
  }
  private reindex() {
    this.byPath.clear(); this.byBase.clear(); this.byName.clear(); this.byTitle.clear();
    for (const e of this.entries.values()) this.indexOne(e);
  }
  private indexOne(e: LibEntry) {
    if (e.path) this.byPath.set(normPath(e.path), e.id);
    const b = this.byBase.get(e.base) ?? []; if (!b.includes(e.id)) b.push(e.id); this.byBase.set(e.base, b);
    const nk = normName(e.title);
    if (nk) { const k = `${nk}|${normName(e.artist)}`; const l = this.byName.get(k) ?? []; if (!l.includes(e.id)) l.push(e.id); this.byName.set(k, l); }
    // (the song's title without its mix / feat. tail: what a deck or a tool that reports only a name is matched by)
    const tk = titleKey(e.title);
    if (tk) { const l = this.byTitle.get(tk) ?? []; if (!l.includes(e.id)) l.push(e.id); this.byTitle.set(tk, l); }
  }

  analysis(id: string): TrackAnalysis | null {
    const c = this.cache.get(id);
    if (c) { this.cache.delete(id); this.cache.set(id, c); return c; }
    let a: TrackAnalysis | null = null;
    try { a = sanitizeAnalysis(JSON.parse(zlib.gunzipSync(fs.readFileSync(this.file(id))).toString('utf8'))); } catch { a = null; }
    if (a) { this.cache.set(id, a); if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!); }
    return a;
  }
  /** Store one analysis. false = nothing written: that one file alone wouldn't fit under the cap. */
  private writeAnalysis(a: TrackAnalysis): boolean {
    const gz = zlib.gzipSync(JSON.stringify(a));
    if (gz.length > this.capBytes) return false;
    this.cache.set(a.id, a);
    try { fs.mkdirSync(path.dirname(this.file(a.id)), { recursive: true }); fs.writeFileSync(this.file(a.id), gz); } catch { /* disk full */ }
    return true;
  }

  /** The entry an imported track belongs to (same file name; a different length = a different track). */
  private entryFor(t: ImportedTrack): LibEntry {
    const p = t.path ? this.byPath.get(normPath(t.path)) : undefined;
    if (p && this.entries.has(p)) return this.entries.get(p)!;
    const same = (this.byBase.get(t.base) ?? []).map((id) => this.entries.get(id)!).filter(Boolean);
    // (a streaming track: the same service id IS the same track)
    const hit = t.stream ? same[0] : same.find((e) => !t.durMs || !e.durMs || Math.abs(e.durMs - t.durMs) < 3000);
    if (hit) return hit;
    const h = crypto.createHash('sha1').update(t.base).digest('hex').slice(0, 16);
    let id = `k${h}`;
    for (let n = 2; this.entries.has(id); n++) id = `k${h}-${n}`;
    const e: LibEntry = { id, base: t.base, durMs: t.durMs ?? 0, bpm: t.bpm ?? 0, srcs: [], refs: {}, st: analysisStatus(emptyAnalysis(id)), needs: !t.stream, used: 0, ...(t.stream ? { stream: t.stream } : {}) };
    this.entries.set(id, e);
    return e;
  }
  /** Merge one importer's result in (the DJ app's grid / phrases win over ours; cues are united). */
  addImport(kind: ImportKind, where: string, r: ImportResult, record = true): { added: number; updated: number; unsafe: number; streaming: number; samples: number } {
    let added = 0, updated = 0, unsafe = 0, streaming = 0;
    for (const t of r.tracks) {
      if (!t.base) continue;
      // a streaming track has no file at all: never a path, never "unsafe"
      if (t.stream) { t.path = undefined; streaming++; }
      // (a path that isn't an absolute audio file path without ".." steps is never kept: matched by name only)
      const tp = cleanTrackPath(t.path);
      if (t.path && !tp) { unsafe++; t.path = undefined; }
      const before = this.entries.size;
      const e = this.entryFor(t);
      if (this.entries.size > before) added++; else updated++;
      if (tp && !e.path) e.path = tp;
      if (t.title && !e.title) e.title = t.title;
      if (t.artist && !e.artist) e.artist = t.artist;
      if (t.mix && !e.mix) e.mix = t.mix;
      if (t.stream && !e.stream && !e.path) { e.stream = t.stream; e.needs = false; }
      if (t.durMs && !e.durMs) e.durMs = Math.round(t.durMs);
      if (t.ref) e.refs[t.src] = t.ref;
      const cur = this.analysis(e.id) ?? emptyAnalysis(e.id, e.durMs);
      const merged = mergeAnalysis(cur, { ...t.part, ...(t.title ? { title: t.title } : {}), ...(t.artist ? { artist: t.artist } : {}), ...(t.durMs ? { durMs: Math.round(t.durMs) } : {}) });
      if (!merged.bpm && t.bpm) merged.bpm = t.bpm;
      if (this.writeAnalysis(merged)) this.refresh(e, merged);
      this.indexOne(e);
    }
    this.updateAsk();
    if (record) this.sources = [{ kind, path: where, at: Date.now(), tracks: r.tracks.length, says: r.says, ok: r.tracks.length > 0, ...(r.samples ? { samples: r.samples } : {}) }, ...this.sources.filter((s) => !(s.kind === kind && s.path === where))].slice(0, 16);
    this.dirty = true;
    this.prune();
    this.save();
    return { added, updated, unsafe, streaming, samples: r.samples ?? 0 };
  }
  /** Our own analysis of a track arrived. */
  putOwn(id: string, own: TrackAnalysis): TrackAnalysis | null {
    const e = this.entries.get(id);
    if (!e) return null;
    const cur = this.analysis(id) ?? emptyAnalysis(id, e.durMs);
    // the app's grid stays; our phrases / energy / events / fingerprint fill the gaps
    const merged = mergeAnalysis(cur, { ...own, id });
    if (!cur.phrases.length || cur.phrases[0].src === 'vtp') merged.phrases = own.phrases.length ? own.phrases : merged.phrases;
    if (own.events.length) merged.events = own.events;
    if (own.energy?.length) merged.energy = own.energy;
    if (own.fp) merged.fp = own.fp;
    if (own.lm) merged.lm = own.lm;
    merged.ours = own.ours;
    // one track whose analysis can't fit under the whole cap is refused (it would push every other track out)
    if (!this.writeAnalysis(merged)) { this.markFailed(id, 'Its analysis is too big for the track library.'); this.save(); return null; }
    e.pruned = false;
    this.refresh(e, merged);
    e.needs = false; delete e.err;
    this.dirty = true;
    this.prune(id);   // (the cap holds on every write; the track just learned stays)
    this.save();
    return merged;
  }
  /** Phrases / grid from the DJ's own analysis must not be redone; our analysis is wanted when phrases are missing
   *  (or the fingerprint for audio matching). */
  private refresh(e: LibEntry, a: TrackAnalysis) {
    e.st = analysisStatus(a);
    e.srcs = a.srcs; e.bpm = a.bpm || e.bpm; if (a.durMs) e.durMs = a.durMs;
    // every reachable track is analysed once by us (version ANALYSIS_VERSION): the fingerprints for finding it by listening
    // (and, without the DJ app's phrases, its sections); the DJ app's grid / phrases are kept
    // (a track whose analysis was pruned for space is learned again only once it's played: never a prune → learn loop)
    // (a streaming track has no file to learn from: it is learned by listening while it plays, never queued)
    e.needs = !e.stream && !e.pruned && (!a.ours || a.ours.v < ANALYSIS_VERSION);
    e.lm = !!a.lm;
  }
  markFailed(id: string, why: string) { const e = this.entries.get(id); if (e) { e.err = why.slice(0, 200); e.needs = false; this.dirty = true; } }

  /** The library entry for what a deck / app says is playing. */
  find(i: TrackIdent): LibEntry | null {
    if (i.trackId && this.entries.has(i.trackId)) return this.touch(this.entries.get(i.trackId)!);
    if (i.stream) { const st = streamFromBase(i.stream); const id = st ? this.byBase.get(streamKey(st))?.[0] : undefined; if (id && this.entries.has(id)) return this.touch(this.entries.get(id)!); }
    if (i.path) {
      const p = this.byPath.get(normPath(i.path.replace(/^net:\/\/[^/]+\//i, '')));
      if (p) return this.touch(this.entries.get(p)!);
      const list = (this.byBase.get(baseName(i.path)) ?? []).map((id) => this.entries.get(id)!).filter(Boolean);
      const m = this.pickByLen(list, i.durMs);
      if (m) return this.touch(m);
    }
    if (i.title) {
      const k = `${normName(i.title)}|${normName(i.artist)}`;
      let list = (this.byName.get(k) ?? []).map((id) => this.entries.get(id)!).filter(Boolean);
      if (!list.length && !i.artist) list = [...this.byName.entries()].filter(([kk]) => kk.startsWith(`${normName(i.title)}|`)).flatMap(([, ids]) => ids.map((id) => this.entries.get(id)!));
      const m = this.pickByLen(list, i.durMs);
      if (m) return this.touch(m);
      // a name as decks and tools say it: "Sick Bass (Original Mix)", "feat." artists, accents, case (streaming.ts)
      const n = this.byNameLoose(i);
      if (n) return this.touch(n);
    }
    return null;
  }
  /**
   * The entry for a reported title / artist (+ length), tolerant of mix / feat. tails, case and accents — or null when it
   * isn't clear: two versions that score alike ("Original Mix" / "Extended Mix" / "Radio Edit" are the same recording
   * for the name but not for the grid), two songs with the same title and no artist said, … A wrong match would put
   * another track's drops on the show, so an unclear name finds nothing (listening or the picker decide instead).
   */
  byNameLoose(i: { title?: string; artist?: string; durMs?: number; mix?: string }): LibEntry | null {
    const scored: { e: LibEntry; sc: number }[] = [];
    for (const id of this.byTitle.get(titleKey(i.title)) ?? []) {
      const e = this.entries.get(id); if (!e) continue;
      let sc = nameScore(i, e);
      if (!sc) continue;
      if (i.durMs && e.durMs) { const d = Math.abs(e.durMs - i.durMs); if (d > 15000) continue; if (d < 1500) sc += 4; else if (d < 3000) sc += 2; }
      scored.push({ e, sc });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.sc - a.sc);
    if (scored.length === 1) return scored[0].e;
    // a clear lead only: ≥ 3 points (an artist that matches, a length that fits, a named remix that agrees)
    return scored[0].sc - scored[1].sc >= 3 ? scored[0].e : null;
  }
  /** The "Now playing" picker's search: every word of the query in the title / artist / mix (case, accents ignored). */
  search(q: string, limit = 20): LibEntry[] {
    const ws = normName(q).split(' ').filter(Boolean);
    const out: LibEntry[] = [];
    for (const e of this.entries.values()) {
      const hay = normName(`${e.title ?? ''} ${e.artist ?? ''} ${e.mix ?? ''} ${e.title ? '' : e.base}`);
      if (ws.every((w) => hay.includes(w))) out.push(e);
    }
    return out.sort((a, b) => b.used - a.used || (a.title ?? a.base).localeCompare(b.title ?? b.base)).slice(0, limit);
  }
  /** Counts for the panel: tracks on this PC, streaming tracks per service (and how many are learned), sampler sounds skipped. */
  kinds(): LibKinds {
    const k: LibKinds = { local: 0, streaming: 0, stream: {}, samples: 0, streamLearned: 0 };
    for (const e of this.entries.values()) {
      if (e.stream) { k.streaming++; k.stream[e.stream.svc] = (k.stream[e.stream.svc] ?? 0) + 1; if (e.lm) k.streamLearned++; } else k.local++;
    }
    // (the XML and the analysis folder skip the same sounds: the bigger count, not the sum)
    k.samples = Math.max(0, ...this.sources.map((s) => s.samples ?? 0));
    return k;
  }
  /** A track learned while it played (streaming: no file): its landmarks (derived numbers, never audio) join its analysis. */
  putLearned(id: string, lm: { v: 1; n: number; b64: string }): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    const cur = this.analysis(id) ?? emptyAnalysis(id, e.durMs);
    const merged: TrackAnalysis = { ...cur, lm };
    if (!this.writeAnalysis(merged)) return false;
    e.lm = true; e.pruned = false; e.st = analysisStatus(merged);
    this.dirty = true;
    this.prune(id);
    this.save();
    return true;
  }
  /** One entry of several with the same name: the one whose length fits — null when that doesn't decide (no length
   *  said and more than one, or two lengths that fit alike): never the first one indexed by chance. */
  private pickByLen(list: LibEntry[], durMs?: number): LibEntry | null {
    if (!list.length) return null;
    if (!durMs) return list.length === 1 ? list[0] : null;
    const ok = list.filter((e) => !e.durMs || Math.abs(e.durMs - durMs) < 3000).sort((a, b) => Math.abs(a.durMs - durMs) - Math.abs(b.durMs - durMs));
    if (ok.length > 1 && Math.abs(Math.abs(ok[1].durMs - durMs) - Math.abs(ok[0].durMs - durMs)) < 1000) return null;
    return ok[0] ?? null;
  }
  private touch(e: LibEntry) {
    e.used = Date.now();
    // played after its analysis was pruned for space: learn it again (now the most recently used: others go first)
    if (e.pruned) { e.pruned = false; e.needs = !e.err && !e.stream; this.dirty = true; }
    return e;
  }
  resolve(i: TrackIdent): TrackAnalysis | null { const e = this.find(i); return e ? this.analysis(e.id) : null; }

  /** Keep the analysis folder under the cap: drop the least recently used (learned again only once played; `keep` = the
   *  file just written). */
  prune(keep?: string) {
    const dir = path.join(this.dir, 'a');
    let files: { f: string; size: number; used: number }[] = [];
    try { files = fs.readdirSync(dir).map((f) => { const id = f.replace(/\.json\.gz$/, ''); return { f, size: fs.statSync(path.join(dir, f)).size, used: this.entries.get(id)?.used ?? 0 }; }); } catch { return; }
    let total = files.reduce((s, x) => s + x.size, 0);
    if (total <= this.capBytes) return;
    // least recently used first; among equals the biggest first (a learned analysis: learned again when played)
    const order = files.sort((a, b) => a.used - b.used || b.size - a.size);
    // 1. slim: keep what the DJ app said (grid, phrases, cues, waveform), drop what we learned ourselves (landmarks,
    //    fingerprint, energy: back when the track is played); 2. only if that isn't enough, whole files go
    for (const pass of [1, 2]) {
      for (const x of order) {
        if (total <= this.capBytes * 0.9) break;
        const id = x.f.replace(/\.json\.gz$/, '');
        if (id === keep || x.size === 0) continue;
        const e = this.entries.get(id);
        try {
          if (pass === 1) {
            const a = this.analysis(id);
            if (!a || !(a.lm || a.fp || a.energy || a.ours)) continue;
            const slim: TrackAnalysis = { ...a }; delete slim.lm; delete slim.fp; delete slim.energy; delete slim.ours;
            const gz = zlib.gzipSync(JSON.stringify(slim));
            if (gz.length >= x.size) continue;
            fs.writeFileSync(path.join(dir, x.f), gz); total -= x.size - gz.length; x.size = gz.length; this.cache.set(id, slim);
            if (e) { e.st = analysisStatus(slim); e.lm = false; e.pruned = true; e.needs = false; }
          } else {
            fs.unlinkSync(path.join(dir, x.f)); total -= x.size; x.size = 0; this.cache.delete(id);
            if (e) { e.st = analysisStatus(emptyAnalysis(id)); e.lm = false; e.pruned = true; e.needs = false; }
          }
        } catch { /* in use */ }
      }
    }
    this.dirty = true;
  }
  /** Forget everything (the panel's "Clear the track library"). Only our own folder is touched. */
  clear() {
    for (const id of this.entries.keys()) try { fs.unlinkSync(this.file(id)); } catch { /* gone */ }
    this.entries.clear(); this.sources = []; this.ask = []; this.cache.clear(); this.reindex(); this.dirty = true; this.save();
  }

  // ---------------------------------------------------------------------------------------------------- music folders
  /** Is this path inside a music folder the user allowed (by name: cheap, for the queue)? */
  inRoots(p: string | undefined): boolean { return !!p && !!cleanTrackPath(p) && this.roots.some((r) => insideFolder(p, r)); }
  /** The real file to open for an entry: an audio file inside an allowed folder, also once links are followed. null =
   *  not allowed / not there. */
  readable(e: LibEntry | undefined): string | null {
    if (!e?.path || !this.inRoots(e.path)) return null;
    try {
      const real = fs.realpathSync.native(e.path);
      if (!isAudioPath(real) || !fs.statSync(real).isFile()) return null;
      return this.roots.some((r) => { try { return insideFolder(real, fs.realpathSync.native(r)); } catch { return false; } }) ? real : null;
    } catch { return null; }
  }
  /**
   * Open an entry's music file for reading, checking the HANDLE: the file is opened (not following a final link where
   * the OS can say so), then its real path is resolved again and must still be the checked file inside an allowed
   * folder, and the handle must be that very file (same volume + file id). A folder swapped for a link between the
   * check and the open is refused. `hook` = tests only (runs between the check and the open). The caller closes `fd`.
   */
  openReadable(e: LibEntry | undefined, hook?: () => void): { fd: number; real: string } | null {
    const real = this.readable(e);
    if (!real) return null;
    hook?.();
    let fd: number;
    try { fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch { return null; }
    if (this.sameFile(fd, real)) return { fd, real };
    try { fs.closeSync(fd); } catch { /* closed */ }
    return null;
  }
  /** Is this open handle still the checked file `real` (inside an allowed folder, no link on the way)? */
  sameFile(fd: number, real: string): boolean {
    try {
      const again = fs.realpathSync.native(real);
      if (cmpPath(again) !== cmpPath(real) || !isAudioPath(again)) return false;
      if (!this.roots.some((r) => { try { return insideFolder(again, fs.realpathSync.native(r)); } catch { return false; } })) return false;
      const h = fs.fstatSync(fd, { bigint: true }), l = fs.lstatSync(again, { bigint: true });
      return l.isFile() && h.isFile() && h.ino === l.ino && h.dev === l.dev;
    } catch { return false; }
  }
  /** The user allowed (or took back) music folders. Only existing folders, never with ".." steps. */
  setRoots(add: string[] = [], remove: string[] = []) {
    const rm = new Set(remove.filter((r) => typeof r === 'string').map(cmpPath));
    const next = this.roots.filter((r) => !rm.has(cmpPath(r)));
    for (const a of add) {
      if (typeof a !== 'string' || a.length > 1000 || !path.isAbsolute(a) || a.split(/[\\/]+/).includes('..')) continue;
      let dir = false; try { dir = fs.statSync(a).isDirectory(); } catch { dir = false; }
      if (dir && !next.some((r) => cmpPath(r) === cmpPath(a))) next.push(path.resolve(a));
    }
    this.roots = next.slice(0, 64);
    this.updateAsk();
    this.save();
  }
  /** Folders holding imported tracks that aren't allowed yet. */
  private updateAsk() {
    this.ask = suggestRoots([...this.entries.values()].filter((e) => e.path && !e.err && !this.inRoots(e.path)).map((e) => e.path!));
    this.dirty = true;
  }
  /** Tracks waiting only because their folder isn't allowed. */
  outsideRoots(): number { let n = 0; for (const e of this.entries.values()) if (e.path && e.needs && !e.err && !this.inRoots(e.path)) n++; return n; }
  bytes(): number { try { return fs.readdirSync(path.join(this.dir, 'a')).reduce((s, f) => s + fs.statSync(path.join(this.dir, 'a', f)).size, 0); } catch { return 0; } }
}
