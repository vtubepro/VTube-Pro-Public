// Keys & pads: MIDI in (docs/b16/BINDINGS.md). Listen-only Web MIDI (never SysEx, nothing is ever sent to the device).
// Starts only when a binding needs it or the user is teaching a pad, and only asks the browser after a click the first time
// (then remembers that it was allowed, like the DJ sync panel does). Uses addEventListener, so it never takes a port away
// from the DJ sync panel (which sets onmidimessage on the ports it uses). Closing is left alone for the same reason.
import { parseMidi, type MidiMsg } from './bindings.ts';

const ALLOWED_KEY = 'vtp.bindings.midi';

export type MidiState = 'off' | 'on' | 'unsupported' | 'denied';
export class MidiSource {
  state: MidiState = 'off';
  /** Input names the browser sees. */
  ports: string[] = [];
  error = '';
  private access: MIDIAccess | null = null;
  private bound = new Map<string, { input: MIDIInput; fn: (e: Event) => void }>();
  constructor(private onMsg: (m: MidiMsg, port: string) => void, private onChange: () => void) {}

  /** The user said yes once before (so a page load can start without a prompt). */
  get allowedBefore(): boolean { try { return localStorage.getItem(ALLOWED_KEY) === '1'; } catch { return false; } }

  async start(ask: boolean): Promise<boolean> {
    if (this.access) { this.bind(); return true; }
    if (!('requestMIDIAccess' in navigator)) { this.state = 'unsupported'; this.error = 'This browser can’t read MIDI. Use Chrome or Edge for the studio.'; this.onChange(); return false; }
    if (!ask && !this.allowedBefore) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.error = ''; this.state = 'on';
      try { localStorage.setItem(ALLOWED_KEY, '1'); } catch { /* storage off */ }
      this.access.onstatechange = () => { this.bind(); this.onChange(); };
      this.bind();
      this.onChange();
      return true;
    } catch (e) {
      const n = (e as Error).name;
      this.state = 'denied';
      this.error = n === 'SecurityError' || n === 'NotAllowedError' ? 'The browser said no to MIDI. Click the lock icon in the address bar, allow MIDI devices, then try again.' : `MIDI didn’t start: ${(e as Error).message}`;
      this.onChange();
      return false;
    }
  }

  private bind() {
    const a = this.access; if (!a) return;
    const seen = new Set<string>();
    this.ports = [];
    for (const input of a.inputs.values()) {
      const name = input.name || input.id;
      this.ports.push(name); seen.add(input.id);
      if (this.bound.has(input.id)) continue;
      const fn = (e: Event) => { const m = parseMidi((e as MIDIMessageEvent).data); if (m) this.onMsg(m, name); };
      input.addEventListener('midimessage', fn);
      this.bound.set(input.id, { input, fn });
      input.open().catch(() => { /* another program holds this port: the rest still work */ });
    }
    for (const [id, b] of [...this.bound]) if (!seen.has(id)) { b.input.removeEventListener('midimessage', b.fn); this.bound.delete(id); }
  }

  /** Stop listening (the ports stay open for whoever else uses them). */
  stop() {
    for (const b of this.bound.values()) b.input.removeEventListener('midimessage', b.fn);
    this.bound.clear();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
    if (this.state === 'on') this.state = 'off';
  }
}
