// Ableton Link adapter, through Carabiner. Link is the sync that rekordbox (performance mode), Traktor, Serato, djay,
// VirtualDJ and Engine DJ hardware all speak: tempo + beat phase (quantum 4 = the bar).
//
// Licence: the Link SDK is GPLv2+ unless Ableton grants its proprietary licence (link-devs@ableton.com; being requested).
// VTube Pro is closed source, so until then we never link Link into the helper: the user runs Deep Symmetry's free
// Carabiner (GPL-2.0+, a separate program they download) and we talk to it over its local text protocol on
// 127.0.0.1:17000. Nothing is bundled.
//
// Carabiner (https://github.com/Deep-Symmetry/carabiner): one line per message, e.g.
//   status { :peers 2 :bpm 128.000000 :start 73743731220 :beat 597.737570 }
// :start = Link-clock µs of beat 0 (quantum 4), :beat = the beat when the status was built. It only pushes on changes,
// so we ask for `status` twice a second. LISTEN-ONLY: we never send bpm / start / stop / force-beat commands.
import net from 'node:net';
import type { SourceSample } from '../../shared/musicClock.ts';
import { plainNetError, Rate, type Adapter, type AdapterCtx, type AdapterStatus } from './net.ts';

export interface CarabinerStatus { peers: number; bpm: number; start: number; beat: number; playing?: boolean }
/** Parse one Carabiner line (null = not a status line). */
export function parseCarabinerStatus(line: string): CarabinerStatus | null {
  const m = /^status\s*\{(.*)\}\s*$/.exec(line.trim());
  if (!m) return null;
  const get = (k: string) => { const r = new RegExp(`:${k}\\s+(-?[0-9.]+|true|false)`).exec(m[1]); return r ? r[1] : null; };
  const peers = Number(get('peers')), bpm = Number(get('bpm')), start = Number(get('start')), beat = Number(get('beat'));
  if (![peers, bpm, start, beat].every(Number.isFinite)) return null;
  const pl = get('playing');
  return { peers, bpm, start, beat, ...(pl === 'true' ? { playing: true } : pl === 'false' ? { playing: false } : {}) };
}

export interface LinkConfig { host?: string; port?: number }

export class LinkAdapter implements Adapter {
  readonly id = 'link' as const;
  private sock: net.Socket | null = null;
  private buf = '';
  private retry: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private last: CarabinerStatus | null = null;
  /** Link clock (ms) − local epoch (ms): the largest estimate of the last 10 s (the smallest delivery delay) wins. */
  private offset = NaN;
  private offs: [number, number][] = [];
  private state: AdapterStatus['state'] = 'off';
  private says = '';
  private rate = new Rate();
  private fails = 0;
  constructor(private ctx: AdapterCtx, private cfg: LinkConfig = {}) {}

  async start() { this.stopped = false; this.state = 'starting'; this.connect(); }
  async stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.poll) clearInterval(this.poll);
    this.retry = null; this.poll = null;
    try { this.sock?.destroy(); } catch { /* gone */ }
    this.sock = null; this.last = null;
    this.ctx.drop('link');
    this.state = 'off';
  }

  private connect() {
    if (this.stopped) return;
    const s = net.connect({ host: this.cfg.host ?? '127.0.0.1', port: this.cfg.port ?? 17000 });
    this.sock = s;
    s.setNoDelay(true);
    s.on('connect', () => {
      this.fails = 0; this.state = 'connected'; this.says = 'Connected to Carabiner.'; this.offset = NaN; this.offs = [];
      s.write('status\n');
      if (this.poll) clearInterval(this.poll);
      this.poll = setInterval(() => { try { s.write('status\n'); } catch { /* closing */ } }, 500);
    });
    s.on('data', (d) => {
      this.buf += d.toString('utf8');
      if (this.buf.length > 65536) this.buf = this.buf.slice(-4096);
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); this.line(line); }
    });
    const down = (e?: Error) => {
      if (this.poll) clearInterval(this.poll);
      this.poll = null;
      if (this.sock !== s) return;
      this.sock = null;
      if (this.stopped) return;
      this.fails++;
      this.state = 'unavailable';
      this.says = e ? plainNetError(e, 'Carabiner (the free Ableton Link helper)') + ' Start Carabiner to sync with rekordbox, Traktor, Serato or djay.' : 'Carabiner closed.';
      if (this.last) { this.last = null; this.ctx.drop('link'); }
      this.retry = setTimeout(() => this.connect(), Math.min(10000, 1500 * this.fails));
    };
    s.on('error', (e) => down(e));
    s.on('close', () => down());
  }

  private line(line: string) {
    const st = parseCarabinerStatus(line);
    if (!st || !(st.bpm > 0)) return;
    this.rate.hit();
    const now = this.ctx.now();
    const linkMs = st.start / 1000 + st.beat * 60000 / st.bpm;     // Link time this status was built
    const est = linkMs - now;
    this.offs.push([now, est]);
    while (this.offs.length && now - this.offs[0][0] > 10000) this.offs.shift();
    // (a jump of the Link timeline itself re-anchors :start and :beat together, so the estimate stays continuous)
    this.offset = Math.max(...this.offs.map((o) => o[1]));
    this.last = st;
    const at = linkMs - this.offset;
    const s: SourceSample = {
      src: 'link', key: 'link', name: st.peers ? `Ableton Link · ${st.peers} app${st.peers > 1 ? 's' : ''}` : 'Ableton Link (no DJ app joined)',
      at, bpm: st.bpm, beat: st.beat, bar: ((Math.floor(st.beat) % 4) + 4) % 4,
      playing: st.peers > 0 && st.playing !== false, playKnown: st.playing !== undefined, q: st.peers > 0 ? 1 : 0.2,
    };
    this.ctx.sample(s);
  }

  status(): AdapterStatus {
    const st = this.last;
    let says = this.says;
    if (this.state === 'connected') says = !st ? 'Connected to Carabiner, waiting for Link.' : st.peers ? `Following ${st.peers} Link app${st.peers > 1 ? 's' : ''} at ${st.bpm.toFixed(1)} BPM.` : 'Carabiner is running, but no DJ app has Ableton Link turned on.';
    if (this.state === 'starting') says = 'Looking for Carabiner…';
    return { id: 'link', label: 'Ableton Link (via Carabiner)', state: this.state, says, found: st?.peers ? [`${st.peers} Link app${st.peers > 1 ? 's' : ''}`] : [], rate: this.rate.get(), extra: { peers: st?.peers ?? 0 } };
  }
}
