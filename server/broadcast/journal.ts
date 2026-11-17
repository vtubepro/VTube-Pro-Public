// live.json: the Go Live journal (VTube Pro Live, Phase 1, workstream W2).
//
// It records the click that started the show, the plan, a heartbeat (`lastAliveAt`) and the times of earlier crash
// resumes: only what is needed to decide a resume (docs/BROADCAST_PROTOCOL.md section 1.4) and to show the
// "You were live; go live again?" card. It NEVER holds a stream key, a token or a path (the plan only has destination
// ids, a title and a category). One small file in the cache folder, written atomically.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from '../paths.ts';
import type { BackendKind, GoLivePlan, IntentSource, LiveJournal } from '../../shared/broadcastTypes.ts';

export const journalFile = () => path.join(CACHE_DIR, 'live.json');
const HOUR_MS = 3_600_000;
/** The heartbeat reaches the disk at most this often (the resume window is 90 s, so 5 s is plenty precise). */
export const BEAT_WRITE_EVERY_MS = 5_000;
const SOURCES: readonly IntentSource[] = ['click', 'deck-confirmed', 'crash-resume'];

/** A plan that holds only plain data (ids and short strings), whatever was on disk. */
export function cleanPlan(p: unknown): GoLivePlan {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const ids = Array.isArray(o.destIds) ? o.destIds.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64).slice(0, 8) : [];
  return {
    destIds: ids, title: typeof o.title === 'string' ? o.title.slice(0, 140) : '', category: typeof o.category === 'string' ? o.category.slice(0, 80) : '',
    ...(o.dryRun === true ? { dryRun: true } : {}), ...(o.record === true ? { record: true } : {}),
  };
}

export function emptyJournal(): LiveJournal {
  return { v: 1, startedAt: 0, source: 'unknown', plan: { destIds: [], title: '', category: '' }, backend: 'obs', lastAliveAt: 0, resumes: [], endedCleanly: true };
}

/** Read whatever is on disk as a valid journal (anything odd = no show running). Pure so a test can feed it junk. */
export function parseJournal(raw: unknown): LiveJournal {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const backend: BackendKind = o.backend === 'engine' ? 'engine' : 'obs';
  return {
    v: 1, startedAt: n(o.startedAt), source: SOURCES.includes(o.source as IntentSource) ? (o.source as IntentSource) : 'unknown', plan: cleanPlan(o.plan), backend,
    lastAliveAt: n(o.lastAliveAt), resumes: Array.isArray(o.resumes) ? o.resumes.map(n).filter((t) => t > 0).slice(-12) : [], endedCleanly: o.endedCleanly !== false,
  };
}

export interface Journal {
  read(): LiveJournal;
  /** The person's click started a show. */
  begin(source: IntentSource, plan: GoLivePlan, backend: BackendKind, now: number): LiveJournal;
  /** The Helper saw the stream alive. Kept in memory every time; written to disk (asynchronously) at most every 5 s. */
  beat(now: number): void;
  /** The show ended. `clean` = on purpose (End Show, or the person stopped it in OBS), or it never started. */
  end(clean: boolean, now: number): void;
  /** A crash resume happened now. */
  noteResume(now: number): void;
  resumesInLastHour(now: number): number;
}

export function createJournal(file: string = journalFile()): Journal {
  let mem: LiveJournal | null = null;
  const load = (): LiveJournal => {
    if (mem) return mem;
    try { mem = parseJournal(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { mem = emptyJournal(); }
    return mem;
  };
  let gen = 0;                 // bumped by every synchronous save: an older asynchronous heartbeat write must not win over it
  let lastWriteAt = 0;         // when the heartbeat last went to disk (or a state change was saved)
  let beatWriting = false;
  const save = (j: LiveJournal) => {
    mem = j;
    gen++;
    lastWriteAt = j.lastAliveAt;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
      fs.renameSync(tmp, file);
    } catch { /* the journal is a safety net: in memory it still works for this run */ }
  };
  return {
    read: () => ({ ...load(), plan: { ...load().plan, destIds: [...load().plan.destIds] }, resumes: [...load().resumes] }),
    begin(source, plan, backend, now) {
      const prev = load();
      const j: LiveJournal = { v: 1, startedAt: now, source, plan: cleanPlan(plan), backend, lastAliveAt: now, resumes: source === 'crash-resume' ? prev.resumes : [], endedCleanly: false };
      save(j);
      return j;
    },
    beat(now) {
      const j = load();
      if (!(j.startedAt > 0) || j.endedCleanly) return;
      mem = { ...j, lastAliveAt: Math.max(j.lastAliveAt, now) };
      if (now - lastWriteAt < BEAT_WRITE_EVERY_MS || beatWriting) return;
      lastWriteAt = now;
      beatWriting = true;
      const startGen = gen;
      const snap = mem;
      const tmp = `${file}.${process.pid}.beat.tmp`;
      void (async () => {
        try {
          await fsp.mkdir(path.dirname(file), { recursive: true });
          await fsp.writeFile(tmp, JSON.stringify(snap, null, 2));
          await fsp.rename(tmp, file);
        } catch { /* a missed heartbeat only means the next one tries again */ }
        beatWriting = false;
        if (gen !== startGen && mem) save(mem);       // a state change was saved meanwhile: the file must hold the newest state, not this beat
      })();
    },
    end(clean, now) { const j = load(); save({ ...j, endedCleanly: clean, lastAliveAt: clean ? j.lastAliveAt : Math.max(j.lastAliveAt, now), ...(clean ? { startedAt: 0 } : {}) }); },
    noteResume(now) { const j = load(); save({ ...j, resumes: [...j.resumes.filter((t) => now - t < HOUR_MS), now] }); },
    resumesInLastHour: (now) => load().resumes.filter((t) => now - t < HOUR_MS && t <= now).length,
  };
}
