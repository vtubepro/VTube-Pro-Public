// MIDI in: DJ controllers (crossfader, faders, EQ, filter, play / cue, pads, FX, jog) and MIDI clock (Traktor, Mixxx,
// DJM mixers, SoundSwitch). LISTEN-ONLY: no MIDI or SysEx is ever sent to any device.
// Two ways in (the OBS browser source can't use Web MIDI, so everything lands HERE in the helper):
//  - the studio page forwards Web MIDI (Chrome / Edge; no install): src/ui/djSyncPanel.ts → /ws/music;
//  - an optional native module, if present (`@julusian/midi`, MIT, prebuilt for Windows / macOS / Linux) — not bundled
//    yet (the integrator decides); without it the studio path covers everyone.
// Sharing a controller with the DJ app: macOS always allows it; Windows 11 with "Windows MIDI Services" (2026) makes every
// MIDI port multi-client; older Windows lets only one app open it — we say so in plain words.
import { execFile } from 'node:child_process';
import { DjControllerReader, MidiClockTracker, UNSUPPORTED_CONTROLLERS, isVirtualPort, mapFor } from '../../shared/djControllers.ts';
import type { ControllerEvent } from '../../shared/musicClock.ts';
import { Rate, type Adapter, type AdapterCtx, type AdapterStatus } from './net.ts';

export interface MidiConfig { native: boolean; /** Every controller message as it came (DJ decks: server/music/deckRig.ts). */ raw?(port: string, msgs: MidiMsg[]): void }
interface Port { name: string; via: 'native' | 'studio'; reader: DjControllerReader; clock: MidiClockTracker; busy: boolean; lastAt: number }
/** One forwarded message: [epoch ms, status, data1, data2] (song position: data1/data2 = its 14 bits). */
export type MidiMsg = [number, number, number, number];

interface NativeInput { getPortCount(): number; getPortName(i: number): string; openPort(i: number): void; closePort(): void; ignoreTypes(sysex: boolean, timing: boolean, sensing: boolean): void; on(ev: 'message', fn: (dt: number, m: number[]) => void): void }

let multiClient: boolean | null | undefined;
/** Windows MIDI Services present (every port multi-client)? null = unknown / not Windows. */
export function windowsMidiShared(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (multiClient !== undefined) return Promise.resolve(multiClient);
  return new Promise((res) => {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Drivers32', '/v', 'midi1'], { windowsHide: true, timeout: 3000 }, (err, out) => {
      multiClient = err ? null : /wdmaud2\.drv/i.test(String(out));
      res(multiClient);
    });
  });
}

export class MidiAdapter implements Adapter {
  readonly id = 'midi' as const;
  private ports = new Map<string, Port>();
  private natives: { name: string; input: NativeInput }[] = [];
  private nativeMod: { Input: new () => NativeInput } | null = null;
  private nativeState: 'off' | 'missing' | 'on' = 'off';
  private scan: ReturnType<typeof setInterval> | null = null;
  private rate = new Rate();
  private state: AdapterStatus['state'] = 'off';
  private studioBusy: string[] = [];
  private studioAt = 0;
  private lastCtlEmit = 0;
  private shared: boolean | null = null;
  constructor(private ctx: AdapterCtx, private cfg: MidiConfig) {}

  async start() {
    this.state = 'listening';
    void windowsMidiShared().then((v) => { this.shared = v; });
    if (this.cfg.native) {
      try {
        const name = '@julusian/midi';
        const mod = (await import(/* @vite-ignore */ name)) as { Input?: new () => NativeInput; default?: { Input: new () => NativeInput } };
        const Input = mod.Input ?? mod.default?.Input;
        if (Input) { this.nativeMod = { Input }; this.nativeState = 'on'; this.rescan(); this.scan = setInterval(() => this.rescan(), 5000); }
        else this.nativeState = 'missing';
      } catch { this.nativeState = 'missing'; }
    }
  }
  async stop() {
    if (this.scan) clearInterval(this.scan);
    this.scan = null;
    for (const n of this.natives) try { n.input.closePort(); } catch { /* gone */ }
    this.natives = [];
    this.ports.clear();
    this.ctx.drop('midiclock'); this.ctx.drop('controller');
    this.state = 'off';
  }

  /** Native backend: open every input we don't have yet (a port the DJ app holds exclusively = busy). */
  private rescan() {
    const M = this.nativeMod; if (!M) return;
    let probe: NativeInput;
    try { probe = new M.Input(); } catch { return; }
    const n = probe.getPortCount();
    const names = Array.from({ length: n }, (_, i) => probe.getPortName(i));
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (this.natives.some((x) => x.name === name) || /VTube Pro/i.test(name)) continue;
      const input = new M.Input();
      try {
        input.ignoreTypes(true, false, true);   // no SysEx, keep clock, no active sensing
        input.on('message', (_dt, m) => this.feed(name, 'native', [[this.ctx.now(), m[0] ?? 0, m[1] ?? 0, m[2] ?? 0]]));
        input.openPort(i);
        this.natives.push({ name, input });
        this.port(name, 'native').busy = false;
      } catch { this.port(name, 'native').busy = true; }
    }
    // unplugged ports
    for (const x of [...this.natives]) if (!names.includes(x.name)) { try { x.input.closePort(); } catch { /* gone */ } this.natives = this.natives.filter((y) => y !== x); this.ports.delete(x.name); }
  }

  private port(name: string, via: Port['via']): Port {
    let p = this.ports.get(name);
    if (!p) { p = { name, via, reader: new DjControllerReader(name), clock: new MidiClockTracker(), busy: false, lastAt: 0 }; this.ports.set(name, p); }
    return p;
  }

  /** Messages forwarded by the studio page's Web MIDI (or the native backend). `busy` = ports the browser couldn't open. */
  fromStudio(port: string, msgs: MidiMsg[], busy?: string[]) {
    this.studioAt = this.ctx.now();
    if (busy) this.studioBusy = busy.slice(0, 16).map((b) => String(b).slice(0, 80));
    if (port && msgs.length) this.feed(port.slice(0, 80), 'studio', msgs.slice(0, 512));
  }

  private feed(name: string, via: Port['via'], msgs: MidiMsg[]) {
    if (!isVirtualPort(name)) try { this.cfg.raw?.(name, msgs); } catch { /* never break DJ sync */ }
    const p = this.port(name, via);
    const evs: ControllerEvent[] = [];
    let clock = false, ctl = false;
    for (const [t, st, d1, d2] of msgs) {
      if (!Number.isFinite(t) || st < 0x80 || st > 0xff) continue;
      this.rate.hit();
      p.lastAt = t;
      if (st >= 0xf8 || st === 0xf2) { p.clock.feed(st, t, st === 0xf2 ? ((d2 & 0x7f) << 7) | (d1 & 0x7f) : undefined); clock = true; continue; }
      if (st >= 0xf0) continue;   // (SysEx / system common: ignored)
      const e = p.reader.feed(st, d1 & 0x7f, d2 & 0x7f, t);
      if (e.length) evs.push(...e);
      ctl = true;
    }
    const now = this.ctx.now();
    if (evs.length) this.ctx.controller(evs);
    // (the Track library follows each deck's playhead from the same messages: play, cue, pads, tempo fader, jog)
    if (ctl && !isVirtualPort(name)) { try { this.ctx.deckMidi?.(name, msgs); } catch { /* never break the adapter */ } }
    if (clock && p.clock.ready) {
      const s = p.clock.sample(now);
      this.ctx.sample({ src: 'midiclock', key: 'midiclock', name: `MIDI clock (${name})`, at: s.at, bpm: s.bpm, beat: s.beat, ...(s.bar !== undefined ? { bar: s.bar } : {}), playing: s.playing, playKnown: s.playKnown, q: s.bar !== undefined ? 1 : 0.85 });
    }
    if (ctl && !isVirtualPort(name) && now - this.lastCtlEmit > 33) {
      this.lastCtlEmit = now;
      this.ctx.sample({ src: 'controller', key: 'controller', name: p.reader.state.device ?? name, at: now, bpm: 0, beat: 0, playing: false, ctl: p.reader.snapshot(now) });
    }
  }

  /** Keep the controller state fresh while the jog activity decays (so a scratch fades out on every page). */
  tick(now: number) {
    if (now - this.lastCtlEmit < 100) return;
    for (const p of this.ports.values()) {
      if (isVirtualPort(p.name) || !p.reader.messages || now - p.lastAt > 2000) continue;
      this.lastCtlEmit = now;
      this.ctx.sample({ src: 'controller', key: 'controller', name: p.reader.state.device ?? p.name, at: now, bpm: 0, beat: 0, playing: false, ctl: p.reader.snapshot(now) });
      break;
    }
  }

  status(): AdapterStatus {
    const now = this.ctx.now();
    const ports = [...this.ports.values()];
    const live = ports.filter((p) => now - p.lastAt < 10000);
    const found = ports.map((p) => (p.reader.map ? p.reader.map.name : p.name) + (p.busy ? ' (in use by another app)' : ''));
    for (const b of this.studioBusy) if (!found.some((f) => f.startsWith(b))) found.push(`${b} (in use by another app)`);
    const busy = ports.some((p) => p.busy) || this.studioBusy.length > 0;
    const studio = now - this.studioAt < 15000;
    const hint = UNSUPPORTED_CONTROLLERS.find((u) => ports.some((p) => u.match.test(p.name)));
    let says: string;
    if (live.length) {
      const c = live.find((p) => !isVirtualPort(p.name) && p.reader.messages > 0);
      const clk = live.find((p) => p.clock.ready);
      says = [c ? `Reading ${c.reader.map?.name ?? c.name}${c.reader.known ? '' : ' (as a generic controller)'}` : '', clk ? `MIDI clock ${clk.clock.sample(now).bpm.toFixed(1)} BPM` : ''].filter(Boolean).join(' · ') + '.';
    } else if (busy) {
      says = this.shared === false || this.shared === null
        ? 'Your DJ app has the controller to itself. On Windows 11, update Windows (it brings “Windows MIDI Services”, which lets two apps share a controller), then reconnect it.'
        : 'Your DJ app has the controller to itself right now. Unplug it and plug it back in, then press “Find my controller”.';
    } else if (!studio && this.nativeState !== 'on') says = 'Press “Find my controller” in the studio (your browser asks once to use MIDI devices).';
    else says = ports.length ? 'Controller connected — move a fader.' : 'No DJ controller found. Plug it in, then press “Find my controller”.';
    if (hint && !live.some((p) => p.reader.known)) says += ` ${hint.says}`;
    const state: AdapterStatus['state'] = this.state === 'off' ? 'off' : live.length ? 'connected' : busy ? 'error' : 'listening';
    return { id: 'midi', label: 'DJ controller / MIDI', state, says, found, rate: this.rate.get(), extra: { native: this.nativeState, studio, shared: this.shared, maps: [...new Set(ports.map((p) => p.reader.map?.id).filter(Boolean))] } };
  }
}

export { mapFor };
