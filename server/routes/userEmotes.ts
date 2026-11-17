// "Record my own emote" (beta.16, lane recemote), helper side: the emotes you recorded from your own camera, kept in
// <data>/user-emotes/<id>.json on THIS computer. Nothing here is uploaded anywhere, and a clip holds bone angles only (never
// the camera picture, the face or the voice): src/avatar/recordEmote/clip.ts.
//   GET    /api/user-emotes        {emotes:[{id,name,secs,fps,frames,bones,loop,createdAt,idle}], idle, max}
//   GET    /api/user-emotes/:id    the clip (the studio and the OBS pages load it when the emote plays)
//   POST   /api/user-emotes        {clip, idle?}  -> {ok, id, emote}   (the clip is checked whole; the helper picks the id)
//   PATCH  /api/user-emotes/:id    {name?, loop?, idle?}
//   DELETE /api/user-emotes/:id
// The studio / OBS side is src/avatar/recordEmote/mount.ts; the screen is src/ui/recordEmotePanel.ts.
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.ts';
import { requireLocal } from './util.ts';
import type { B16ServerCtx } from '../b16/mount.ts';
import { CLIP_MAX_BYTES, EMOTE_ID, cleanEmoteName, emoteIdFor, sanitizeClip, type EmoteClip } from '../../src/avatar/recordEmote/clip.ts';

/** How many emotes the helper keeps. */
export const USER_EMOTES_MAX = 100;
const INDEX_FILE = '_index.json';
/** Ids of deleted emotes stay in _index.json so a new emote never takes one over: an OBS page that is open all day caches a clip by
 *  its id, and would otherwise keep playing the deleted one. Ids are tiny; only the newest RETIRED_MAX are kept. */
const RETIRED_MAX = 2000;

export interface UserEmoteMeta { id: string; name: string; secs: number; fps: number; frames: number; bones: number; loop: boolean; createdAt: number; idle: boolean; bytes: number }

/** The folder of clips. Everything is synchronous and small (a clip is under ~600 KB); `dir` is injectable for the unit test. */
export class UserEmoteStore {
  constructor(private dir: string) {}

  /** list() cache (R3-11): the decoded facts of each clip (everything but `idle`), keyed by the file's mtime + size so a clip that did not
   *  change is never read and base64-decoded again. save / patch / remove also drop their entry, so a same-size, same-tick rewrite is
   *  never served stale. A GET /api/user-emotes on a warm cache costs one readdir and one stat per clip. */
  private metaCache = new Map<string, { sig: string; meta: Omit<UserEmoteMeta, 'idle'> | null }>();
  /** How many clips list() actually decoded (the unit test reads this to prove the cache works). */
  decodeCount = 0;
  private forget(id: string) { this.metaCache.delete(id); }

  private file(id: string) { return path.join(this.dir, `${id}.json`); }
  private readIndex(): { idle: string | null; retired: string[] } {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(this.dir, INDEX_FILE), 'utf8')) as { idle?: unknown; retired?: unknown };
      const retired = Array.isArray(o.retired) ? o.retired.filter((x): x is string => typeof x === 'string' && EMOTE_ID.test(x)).slice(-RETIRED_MAX) : [];
      return { idle: typeof o.idle === 'string' && EMOTE_ID.test(o.idle) ? o.idle : null, retired };
    } catch { return { idle: null, retired: [] }; }
  }
  private writeAtomic(file: string, text: string) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }
  private writeIndex(idle: string | null, retired: string[] = this.readIndex().retired) {
    this.writeAtomic(path.join(this.dir, INDEX_FILE), JSON.stringify({ idle, retired: retired.slice(-RETIRED_MAX) }));
  }

  ids(): string[] {
    try { return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') && f !== INDEX_FILE).map((f) => f.slice(0, -5)).filter((id) => EMOTE_ID.test(id)); } catch { return []; }
  }
  private meta(id: string, clip: EmoteClip, bytes: number, idle: string | null): UserEmoteMeta {
    return { id, name: clip.name, secs: Math.round(((clip.frames - 1) / clip.fps) * 100) / 100, fps: clip.fps, frames: clip.frames, bones: Object.keys(clip.bones).length, loop: clip.loop, createdAt: clip.createdAt, idle: idle === id, bytes };
  }
  get(id: string): EmoteClip | null {
    if (!EMOTE_ID.test(id)) return null;
    try {
      const text = fs.readFileSync(this.file(id), 'utf8');
      return text.length > CLIP_MAX_BYTES ? null : sanitizeClip(JSON.parse(text));
    } catch { return null; }
  }
  list(): { emotes: UserEmoteMeta[]; idle: string | null } {
    const { idle } = this.readIndex();
    const emotes: UserEmoteMeta[] = [];
    const ids = this.ids();
    const live = new Set(ids);
    for (const k of [...this.metaCache.keys()]) if (!live.has(k)) this.metaCache.delete(k);   // (a file deleted behind our back)
    for (const id of ids) {
      let st: fs.Stats;
      try { st = fs.statSync(this.file(id)); } catch { this.forget(id); continue; }   // gone
      const sig = `${st.mtimeMs}:${st.size}`;
      let hit = this.metaCache.get(id);
      if (!hit || hit.sig !== sig) {
        const clip = this.get(id);
        this.decodeCount++;
        const m = clip ? this.meta(id, clip, st.size, null) : null;
        hit = { sig, meta: m ? (({ idle: _i, ...rest }) => { void _i; return rest; })(m) : null };
        this.metaCache.set(id, hit);
      }
      if (hit.meta) emotes.push({ ...hit.meta, idle: idle === id });
    }
    emotes.sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
    return { emotes, idle: emotes.some((e) => e.id === idle) ? idle : null };
  }
  /** Save a clip the caller sent. Returns an error text (plain words) instead of throwing. */
  save(input: unknown, idle = false, now = Date.now()): { ok: true; id: string; emote: UserEmoteMeta } | { ok: false; status: number; error: string } {
    const clip = sanitizeClip(input);
    if (!clip) return { ok: false, status: 400, error: 'That recording is not a valid emote.' };
    const ids = this.ids();
    if (ids.length >= USER_EMOTES_MAX) return { ok: false, status: 409, error: `You already have ${USER_EMOTES_MAX} recorded emotes. Delete one first.` };
    const stamped: EmoteClip = { ...clip, createdAt: clip.createdAt || now };
    const text = JSON.stringify(stamped);
    if (text.length > CLIP_MAX_BYTES) return { ok: false, status: 413, error: 'That recording is too big. Record a shorter one.' };
    const id = emoteIdFor(stamped.name, [...ids, ...this.readIndex().retired]);   // (never an id a deleted emote had)
    this.forget(id);
    this.writeAtomic(this.file(id), text);
    if (idle) this.writeIndex(id);
    return { ok: true, id, emote: this.meta(id, stamped, text.length, idle ? id : this.readIndex().idle) };
  }
  patch(id: string, p: { name?: unknown; loop?: unknown; idle?: unknown }): UserEmoteMeta | null {
    const clip = this.get(id);
    if (!clip) return null;
    const next: EmoteClip = { ...clip };
    if (typeof p.name === 'string') next.name = cleanEmoteName(p.name, clip.name);
    if (typeof p.loop === 'boolean') next.loop = p.loop;
    const text = JSON.stringify(next);
    this.forget(id);
    if (next.name !== clip.name || next.loop !== clip.loop) this.writeAtomic(this.file(id), text);
    const cur = this.readIndex().idle;
    if (p.idle === true && cur !== id) this.writeIndex(id);
    else if (p.idle === false && cur === id) this.writeIndex(null);
    return this.meta(id, next, text.length, this.readIndex().idle);
  }
  remove(id: string): boolean {
    if (!EMOTE_ID.test(id) || !fs.existsSync(this.file(id))) return false;
    this.forget(id);
    fs.rmSync(this.file(id), { force: true });
    const ix = this.readIndex();
    this.writeIndex(ix.idle === id ? null : ix.idle, [...ix.retired.filter((x) => x !== id), id]);
    return true;
  }
}

export function userEmotesRoutes(store: UserEmoteStore = new UserEmoteStore(path.join(DATA_DIR, 'user-emotes'))): Router {
  const r = Router();
  const json = express.json({ limit: '4mb' });   // (a clip is at most ~600 KB; the app-wide parser, when it already ran, is skipped by this one)
  const idOf = (req: express.Request) => String(req.params.id ?? '');

  r.get('/api/user-emotes', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...store.list(), max: USER_EMOTES_MAX });
  });
  r.get('/api/user-emotes/:id', (req, res) => {
    const clip = store.get(idOf(req));
    if (!clip) { res.status(404).json({ error: 'No such emote.' }); return; }
    res.setHeader('Cache-Control', 'no-cache');
    res.json(clip);
  });
  r.post('/api/user-emotes', json, (req, res) => {
    requireLocal(req);
    const b = (req.body ?? {}) as { clip?: unknown; idle?: unknown };
    const out = store.save(b.clip, b.idle === true);
    if (!out.ok) { res.status(out.status).json({ error: out.error }); return; }
    res.json({ ok: true, id: out.id, emote: out.emote });
  });
  r.patch('/api/user-emotes/:id', json, (req, res) => {
    requireLocal(req);
    const m = store.patch(idOf(req), (req.body ?? {}) as Record<string, unknown>);
    if (!m) { res.status(404).json({ error: 'No such emote.' }); return; }
    res.json({ ok: true, emote: m });
  });
  r.delete('/api/user-emotes/:id', (req, res) => {
    requireLocal(req);
    if (!store.remove(idOf(req))) { res.status(404).json({ error: 'No such emote.' }); return; }
    res.json({ ok: true });
  });
  // a body that is too big or not JSON: a sentence, not a stack trace
  r.use('/api/user-emotes', (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const status = Number((err as { status?: number })?.status) || 400;
    if (res.headersSent) { next(err); return; }
    res.status(status >= 400 && status < 500 ? status : 400).json({ error: status === 413 ? 'That recording is too big. Record a shorter one.' : 'That did not look like a recorded emote.' });
  });
  return r;
}

/** beta.16 lane entry (server/b16/mount.ts): the routes above. Nothing runs until a page asks. */
export function mount(ctx: B16ServerCtx): void {
  ctx.app.use(userEmotesRoutes());
}
