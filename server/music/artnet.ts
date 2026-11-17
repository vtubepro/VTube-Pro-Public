// Art-Net / sACN receiver: the DJ's light show (SoundSwitch, Engine Lighting, QLC+, Lightjams…) drives the 3D rig.
// RECEIVE ONLY. Art-Net on UDP 6454 (broadcast or unicast to this PC), sACN on UDP 5568 (multicast groups for the
// universes we listen to, or unicast). Answering Art-Net polls (so strict Art-Net 4 desks find us) is an opt-in.
import type dgram from 'node:dgram';
import { ARTNET_PORT, SACN_PORT, UniverseStore, buildArtPollReply, isArtPoll, parseArtDmx, parseSacn } from '../../shared/dmxIn.ts';
import { ifaceFor, localIPv4s, plainNetError, Rate, udpBind, type Adapter, type AdapterCtx, type AdapterStatus } from './net.ts';

export interface ArtnetConfig { artnet: boolean; sacn: boolean; universes: number[]; pollReply: boolean; bind?: string; artnetPort?: number; sacnPort?: number }

export class ArtnetAdapter implements Adapter {
  readonly id = 'artnet' as const;
  private socks: dgram.Socket[] = [];
  private store = new UniverseStore();
  private state: AdapterStatus['state'] = 'off';
  private says = '';
  private rate = new Rate();
  private timer: ReturnType<typeof setInterval> | null = null;
  private errors: string[] = [];
  constructor(private ctx: AdapterCtx, private cfg: ArtnetConfig) {}

  async start() {
    this.state = 'starting'; this.errors = [];
    const bind = this.cfg.bind ?? '0.0.0.0';
    if (this.cfg.artnet) {
      try {
        const s = await udpBind(this.cfg.artnetPort ?? ARTNET_PORT, bind);
        s.on('message', (m, r) => this.onArtnet(m, r.address, s));
        this.socks.push(s);
      } catch (e) { this.errors.push(plainNetError(e, 'the Art-Net port', ARTNET_PORT)); }
    }
    if (this.cfg.sacn) {
      try {
        const s = await udpBind(this.cfg.sacnPort ?? SACN_PORT, bind);
        s.on('message', (m) => this.onFrame(parseSacn(m)));
        if (bind === '0.0.0.0') for (const u of this.cfg.universes) for (const f of localIPv4s()) try { s.addMembership(`239.255.${(u >> 8) & 0xff}.${u & 0xff}`, f.address); } catch { /* card can't */ }
        this.socks.push(s);
      } catch (e) { this.errors.push(plainNetError(e, 'the sACN port', SACN_PORT)); }
    }
    this.state = this.socks.length ? 'listening' : 'error';
    this.says = this.socks.length ? 'Listening for a DMX light show (Art-Net / sACN).' : this.errors[0] ?? 'Off.';
    this.timer = setInterval(() => this.store.sweep(this.ctx.now()), 2000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.socks) try { s.close(); } catch { /* closed */ }
    this.socks = [];
    this.state = 'off';
  }

  private onArtnet(m: Buffer, from: string, sock: dgram.Socket) {
    if (isArtPoll(m)) {
      if (!this.cfg.pollReply) return;
      const f = ifaceFor(from); if (!f) return;
      const reply = buildArtPollReply({ ip: f.address.split('.').map(Number), mac: f.mac.split(':').map((x) => parseInt(x, 16) || 0), universes: this.cfg.universes });
      setTimeout(() => { try { sock.send(reply, ARTNET_PORT, from); } catch { /* down */ } }, Math.random() * 800);
      return;
    }
    const f = parseArtDmx(m);
    if (f) f.source = `Art-Net from ${from}`;
    this.onFrame(f);
  }
  private onFrame(f: ReturnType<typeof parseArtDmx>) {
    if (!f) return;
    if (this.cfg.universes.length && !this.cfg.universes.includes(f.universe)) return;
    this.rate.hit();
    const now = this.ctx.now();
    if (this.store.put(f, now)) { const d = this.store.get(f.universe); if (d) this.ctx.dmx(f.universe, d, f.source); }
  }

  /** Current values of a universe (tests / the panel). */
  universe(u: number) { return this.store.get(u); }

  status(): AdapterStatus {
    const now = this.ctx.now();
    const list = this.store.list(now);
    if (this.state === 'listening' || this.state === 'connected') this.state = list.length ? 'connected' : 'listening';
    const says = this.state === 'connected' ? `Receiving ${list.length} DMX universe${list.length > 1 ? 's' : ''} — your light show drives the stage.` : this.state === 'listening' ? `Listening for Art-Net / sACN (universes ${this.cfg.universes.join(', ')}).` : this.says;
    return { id: 'artnet', label: 'DMX light show in (Art-Net / sACN)', state: this.state, says, found: [...new Set(list.map((l) => l.source))], rate: this.rate.get(), extra: { universes: list, pollReply: this.cfg.pollReply, errors: this.errors } };
  }
}
