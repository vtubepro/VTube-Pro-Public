// Small networking helpers shared by the DJ adapters (server/music/*): UDP binds that share ports politely, plain-words
// errors, this PC's network cards, and the adapter contract. Every adapter is LISTEN-ONLY toward the DJ's gear.
import dgram from 'node:dgram';
import os from 'node:os';
import type { ControllerEvent, SourceSample } from '../../shared/musicClock.ts';

export const epochNow = () => performance.timeOrigin + performance.now();

export type AdapterId = 'link' | 'prolink' | 'stagelinq' | 'os2l' | 'osc' | 'midi' | 'artnet' | 'traktor';
export type AdapterState = 'off' | 'starting' | 'listening' | 'connected' | 'error' | 'unavailable';
export interface AdapterStatus {
  id: AdapterId;
  label: string;
  state: AdapterState;
  /** One plain sentence: what it is doing / what is wrong and what to do. */
  says: string;
  /** What it found (devices, apps, peers). */
  found: string[];
  /** Packets / messages per second (0 when idle). */
  rate?: number;
  /** Extra state for the panel (e.g. the controller map in use). */
  extra?: Record<string, unknown>;
}
export interface AdapterCtx {
  now(): number;
  sample(s: SourceSample): void;
  drop(key: string): void;
  /** Controller / button events; `src` = the sending adapter's clock source (MIDI = 'controller'). */
  controller(evs: ControllerEvent[], src?: import('../../shared/musicClock.ts').ClockSource): void;
  /** DMX in (Art-Net / sACN): one universe's channel values changed. */
  dmx(universe: number, data: Uint8Array, from: string): void;
  log(msg: string): void;
  /** Track library (server/music/trackSync.ts): a deck's playhead + what it plays. */
  position?(r: import('../../shared/trackFollow.ts').PosReport): void;
  /** Track library: a DJ controller's raw MIDI (listen-only) for following each deck's playhead (shared/deckPlayhead.ts). */
  deckMidi?(port: string, msgs: [number, number, number, number][]): void;
  /** Track library: a CDJ's grid / phrase tags for a track (track-info mode). */
  cdjTrack?(meta: { title?: string; artist?: string; durationSec?: number }, tags: import('./library/anlz.ts').Anlz[]): void;
}
export interface Adapter {
  readonly id: AdapterId;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): AdapterStatus;
}

/** Bind a UDP socket that shares the port with other listeners (rekordbox, SoundSwitch, Resolume often listen too). */
export function udpBind(port: number, address = '0.0.0.0', opts: { reuse?: boolean; broadcast?: boolean } = {}): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: opts.reuse !== false });
    const fail = (e: Error) => { try { s.close(); } catch { /* not open */ } reject(e); };
    s.once('error', fail);
    s.bind({ port, address, exclusive: false }, () => {
      s.off('error', fail);
      s.on('error', () => { /* per-packet errors never take VTube Pro down */ });
      if (opts.broadcast) try { s.setBroadcast(true); } catch { /* fine */ }
      resolve(s);
    });
  });
}

/** An OS error → one plain sentence. */
export function plainNetError(e: unknown, what: string, port?: number): string {
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'EADDRINUSE' || code === 'EACCES') return `Another app on this PC is using ${what}${port ? ` (port ${port})` : ''}. Close it, or let that app send to VTube Pro instead.`;
  if (code === 'ECONNREFUSED') return `${what} isn’t running on this PC.`;
  if (code === 'EADDRNOTAVAIL') return 'That network card isn’t connected right now.';
  return `${what} stopped: ${(e as Error)?.message ?? String(e)}`;
}

export interface LocalIf { name: string; address: string; netmask: string; mac: string; broadcast: string }
/** This PC's IPv4 network cards (not loopback). */
export function localIPv4s(): LocalIf[] {
  const out: LocalIf[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      out.push({ name, address: a.address, netmask: a.netmask, mac: a.mac, broadcast: ip.map((v, i) => (v & mask[i]) | (~mask[i] & 255)).join('.') });
    }
  }
  return out;
}
/** The card on the same subnet as `ip` (null = none). */
export function ifaceFor(ip: string, ifs: LocalIf[] = localIPv4s()): LocalIf | null {
  const t = ip.split('.').map(Number);
  for (const f of ifs) {
    const a = f.address.split('.').map(Number), m = f.netmask.split('.').map(Number);
    if (t.every((v, i) => (v & m[i]) === (a[i] & m[i]))) return f;
  }
  return null;
}

/** Packets-per-second meter. */
export class Rate {
  private times: number[] = [];
  private lastAt = 0;
  hit(now = Date.now()) { this.times.push(now); this.lastAt = now; if (this.times.length > 400) this.times.shift(); }
  get(now = Date.now()) { while (this.times.length && now - this.times[0] > 2000) this.times.shift(); return Math.round(this.times.length / 2); }
  /** When the newest packet came (0 = never; survives get() pruning its window). */
  last() { return this.lastAt; }
}
