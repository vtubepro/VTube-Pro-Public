// DJ decks for party guests: the host's helper puts its controller snapshots on the HOST's bus ({type:'djdeck'}); the
// host's studio sends them to every guest over the party link ({t:'djdeck'}, at most 10 a second, the latest one to
// someone who just joined); a guest's studio puts them on ITS bus as {type:'djdeck', origin:'party'} for its OBS pages.
// So every guest's stream shows the host's decks and hands moving like the host's. Listen-only data (no MIDI travels:
// only which controls are where). Observer tabs relay nothing.
import { sanitizeDeckSnapshot, type DeckSnapshot } from '../../../shared/djDeck/reader.ts';
import type { Bus } from '../../bus.ts';
import type { Party } from '../../party.ts';

export function installDeckRelay(bus: Bus, party: Party, observer: boolean) {
  if (observer) return;
  let last: DeckSnapshot | null = null;      // host: the newest snapshot of this PC's controller
  let fromHost: DeckSnapshot | null = null;  // guest: the host's newest
  let sentAt = 0, timer = 0, members = party.members.length;
  const send = (now = false) => {
    if (party.role !== 'host' || !last) return;
    const go = () => { timer = 0; sentAt = performance.now(); if (last) party.sendDjDeck(last); };
    if (now) { clearTimeout(timer); go(); return; }
    if (timer) return;
    timer = window.setTimeout(go, Math.max(0, 100 - (performance.now() - sentAt)));
  };
  bus.on((m) => {
    if (m.type === 'djdeck' && m.origin !== 'party') { const v = sanitizeDeckSnapshot(m.s); if (v) { last = v; send(); } return; }
    if (m.type === 'hello' && m.role === 'output' && party.role === 'guest' && fromHost) bus.send({ type: 'djdeck', s: fromHost, origin: 'party' });
  });
  party.onDjDeck = (s) => {
    if (party.role !== 'guest') return;
    const v = sanitizeDeckSnapshot(s); if (!v) return;
    fromHost = v;
    bus.send({ type: 'djdeck', s: v, origin: 'party' });
  };
  party.listeners.add(() => {
    const n = party.members.length;
    if (party.role === 'host' && n > members) send(true);
    if (party.role !== 'guest') fromHost = null;
    members = n;
  });
}
