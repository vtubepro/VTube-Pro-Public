// Goals + the subathon timer for party guests (beta.13): the host's helper pushes its view on the HOST's bus; the host's
// studio sends it to every guest over the party link ({t:'goals'}, ≤ 2 a second, and the latest one to someone who just
// joined); a guest's studio puts it on ITS bus as {type:'goals', origin:'party'} for its OBS pages (and hands the latest
// one to an OBS page that connects later). So every guest's stream shows the host's goals, timer and celebrations,
// identical to the host's. Test-mode views never leave the host's PC. Observer tabs relay nothing.
import { sanitizeGoalsView, type GoalsView } from '../../shared/goalsView.ts';
import type { Bus } from '../bus.ts';
import type { Party } from '../party.ts';

export function installGoalsRelay(bus: Bus, party: Party, observer: boolean) {
  if (observer) return;
  let last: GoalsView | null = null;      // host: the newest real view of this PC's helper
  let fromHost: GoalsView | null = null;  // guest: the newest view of the host
  let members = party.members.length;
  let sentAt = 0;
  let timer = 0;
  const send = (now = false) => {
    if (party.role !== 'host' || !last) return;
    const go = () => { timer = 0; sentAt = performance.now(); if (last) party.sendGoals(last); };
    if (now) { clearTimeout(timer); go(); return; }
    if (timer) return;
    timer = window.setTimeout(go, Math.max(0, 500 - (performance.now() - sentAt)));
  };
  bus.on((m) => {
    if (m.type === 'goals' && m.origin !== 'party') {
      const v = sanitizeGoalsView(m.s);
      if (!v || v.test) return;            // (test mode stays on this PC)
      last = v;
      send();
      return;
    }
    // an OBS page connected: a guest hands it the host's latest view
    if (m.type === 'hello' && m.role === 'output' && party.role === 'guest' && fromHost) bus.send({ type: 'goals', s: fromHost, origin: 'party' });
  });
  party.onGoals = (s) => {
    if (party.role !== 'guest') return;
    const v = sanitizeGoalsView(s);
    if (!v) return;
    fromHost = v;
    bus.send({ type: 'goals', s: v, origin: 'party' });
  };
  party.listeners.add(() => {
    const n = party.members.length;
    if (party.role === 'host' && n > members) send(true);
    if (party.role !== 'guest') fromHost = null;
    members = n;
  });
}
