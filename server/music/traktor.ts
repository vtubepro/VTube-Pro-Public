// Traktor deck data (optional, off by default): receives the JSON that the community "traktor-api-client" mod (MIT,
// a QML mod the USER installs into Traktor — we never install or modify anything) POSTs to localhost:8080:
//   /deckLoaded/<deck>, /updateDeck/<deck>, /updateMasterClock, /updateChannel/<channel>
// It gives track title / artist, play state, master tempo, channel volume + on-air, ~10 times a second: metadata and
// faders, not beat-accurate (beat phase comes from Ableton Link or the music input). Field names are read defensively.
import http from 'node:http';
import type { DeckState, SourceSample } from '../../shared/musicClock.ts';
import { plainNetError, Rate, type Adapter, type AdapterCtx, type AdapterStatus } from './net.ts';

export interface TraktorConfig { port: number }
interface TDeck { title?: string; artist?: string; key?: string; playing?: boolean; bpm?: number; volume?: number; onAir?: boolean; elapsed?: number; length?: number; path?: string }
const DECKS = ['A', 'B', 'C', 'D'];

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 160) : undefined);

/** One POST → which deck / channel it is about and what changed. Exported for tests. */
export function parseTraktorPost(url: string, body: unknown): { deck?: number; master?: { deck?: number; bpm?: number }; patch?: TDeck } | null {
  const m = /^\/(deckLoaded|updateDeck|updateMasterClock|updateChannel)(?:\/([A-Da-d1-4]))?\/?$/.exec(url.split('?')[0]);
  if (!m || !body || typeof body !== 'object') return null;
  const x = body as Record<string, unknown>;
  const idx = (s: string | undefined) => (s ? (/\d/.test(s) ? Number(s) : DECKS.indexOf(s.toUpperCase()) + 1) : undefined);
  if (m[1] === 'updateMasterClock') return { master: { deck: idx(str(x.deck)) ?? num(x.deck), bpm: num(x.bpm) } };
  const deck = idx(m[2]);
  if (!deck) return null;
  if (m[1] === 'updateChannel') return { deck, patch: { volume: num(x.volume), onAir: typeof x.isOnAir === 'boolean' ? x.isOnAir : undefined } };
  const patch: TDeck = { playing: typeof x.isPlaying === 'boolean' ? x.isPlaying : undefined, bpm: num(x.bpm) ?? num(x.tempo), elapsed: num(x.elapsedTime), length: num(x.trackLength) };
  if (m[1] === 'deckLoaded') { patch.title = str(x.title); patch.artist = str(x.artist); patch.key = str(x.keyText) ?? str(x.key); patch.path = typeof x.filePath === 'string' ? x.filePath.slice(0, 600) : undefined; }
  return { deck, patch };
}

export class TraktorAdapter implements Adapter {
  readonly id = 'traktor' as const;
  private srv: http.Server | null = null;
  private decks = new Map<number, TDeck>();
  private masterDeck = 0;
  private masterBpm = 0;
  private state: AdapterStatus['state'] = 'off';
  private says = '';
  private rate = new Rate();
  constructor(private ctx: AdapterCtx, private cfg: TraktorConfig) {}

  async start() {
    const srv = http.createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (d: string) => { body += d; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
        let o: unknown; try { o = JSON.parse(body || '{}'); } catch { return; }
        this.post(req.url ?? '', o);
      });
    });
    try { await new Promise<void>((r, j) => { srv.once('error', j); srv.listen(this.cfg.port, '127.0.0.1', () => { srv.off('error', j); r(); }); }); }
    catch (e) { this.state = 'error'; this.says = plainNetError(e, 'the Traktor deck-data port', this.cfg.port); return; }
    this.srv = srv;
    this.state = 'listening';
  }
  async stop() {
    await new Promise<void>((r) => { if (!this.srv) return r(); this.srv.close(() => r()); this.srv.closeAllConnections?.(); });
    this.srv = null; this.ctx.drop('traktor'); this.state = 'off';
  }

  post(url: string, body: unknown) {
    const p = parseTraktorPost(url, body);
    if (!p) return;
    this.rate.hit();
    if (p.master) { if (p.master.deck) this.masterDeck = p.master.deck; if (p.master.bpm) this.masterBpm = p.master.bpm; }
    if (p.deck && p.patch) {
      const cur = this.decks.get(p.deck) ?? {};
      for (const [k, v] of Object.entries(p.patch)) if (v !== undefined) (cur as Record<string, unknown>)[k] = v;
      this.decks.set(p.deck, cur);
    }
    const now = this.ctx.now();
    const md = this.masterDeck || [...this.decks.entries()].find(([, d]) => d.playing)?.[0] || 1;
    const d = this.decks.get(md) ?? {};
    const decks: DeckState[] = [...this.decks.entries()].sort((a, b) => a[0] - b[0]).map(([n, x]) => ({ n, playing: !!x.playing, onAir: x.onAir ?? (!!x.playing && (x.volume ?? 1) > 0.05), master: n === md, ...(x.volume !== undefined ? { fader: Math.max(0, Math.min(1, x.volume)) } : {}), ...(x.bpm ? { bpm: x.bpm } : {}), ...(x.title ? { title: x.title } : {}), ...(x.artist ? { artist: x.artist } : {}) }));
    const s: SourceSample = { src: 'traktor', key: 'traktor', name: 'Traktor deck data', at: now, bpm: 0, beat: 0, playing: !!d.playing, decks, onAir: md,
      track: { deck: md, ...(d.title ? { title: d.title } : {}), ...(d.artist ? { artist: d.artist } : {}), ...(d.key ? { key: d.key } : {}), ...(d.elapsed !== undefined ? { posMs: d.elapsed * 1000 } : {}), ...(d.length ? { lenMs: d.length * 1000 } : {}) } };
    this.ctx.sample(s);
    void this.masterBpm;
    // the track library: each deck's elapsed time (coarse, ~10 a second; the beat phase comes from Link)
    if (p.deck && this.ctx.position) {
      const x = this.decks.get(p.deck);
      if (x && x.elapsed !== undefined && (x.title || x.path)) this.ctx.position({ src: 'traktor', deck: p.deck, at: now, ms: x.elapsed * 1000, playing: !!x.playing, exact: false, ident: { ...(x.path ? { path: x.path } : {}), ...(x.title ? { title: x.title } : {}), ...(x.artist ? { artist: x.artist } : {}), ...(x.length ? { durMs: x.length * 1000 } : {}) } });
    }
  }

  status(): AdapterStatus {
    const live = this.ctx.now() - this.rate.last() < 5000 && this.rate.last() > 0;
    if (this.state === 'listening' || this.state === 'connected') this.state = live ? 'connected' : 'listening';
    const says = this.state === 'connected' ? 'Traktor is sending deck data (track names, faders).' : this.state === 'listening' ? `Waiting for Traktor deck data on port ${this.cfg.port} (needs the community traktor-api-client mod — see the guide).` : this.says;
    return { id: 'traktor', label: 'Traktor deck data (community mod)', state: this.state, says, found: live ? ['Traktor'] : [], rate: this.rate.get() };
  }
}
