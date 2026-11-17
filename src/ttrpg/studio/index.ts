// TTRPG mode in the studio: the session (session.ts), the drawer (ui/panel.ts), a launcher button, Shift+Y, the bus /
// MCP command `ttrpg`, and the "TTRPG" entry in the stage-mode bar (the `stagemodes` workstream's registry when it is
// installed — window.vtpStageModes.register — else the launcher button is the way in).
//   send_command ttrpg {"open": true}            open the drawer
//   send_command ttrpg {"start": true}           open the table in this environment's TTRPG room (host)
//   send_command ttrpg {"stop": true}            close the table, back to the environment
//   send_command ttrpg {"roll": "d20+5", "label": "Stealth"}   roll for the host
//   send_command ttrpg {"say": "…"}              the host acts / speaks in character
//   send_command ttrpg {"continue": true}        the AI GM goes on;  {"xcard": true}  the X-card
import type { App } from '../../app.ts';
import { TtrpgSession } from './session.ts';
import { TtrpgPanel, d20Icon } from '../ui/panel.ts';
import { toast } from '../../ui/dom.ts';

export interface StageModeDef { id: string; label: string; icon?: string; order?: number; active: () => boolean; enter: () => void; exit: () => void; available?: () => boolean }

export function initTtrpg(app: App) {
  const s = new TtrpgSession(app.scene, app.party, app.bus, app.observer);
  const panel = new TtrpgPanel(s);
  const launch = document.createElement('button');
  launch.className = 'tt-launch';
  // (clarity: "TTRPG" is an acronym most streamers don't know)
  launch.title = 'A dice-and-story game, solo or with your party (Shift+Y)';
  launch.append(d20Icon(), document.createTextNode('Tabletop game'));
  launch.addEventListener('click', () => panel.toggle());
  document.body.append(launch);
  let wasOn = false;
  const sync = () => {
    const on = s.active;
    launch.classList.toggle('live', on);
    // guests: the host just opened the table → open the drawer once
    if (on && !wasOn && !s.isHost) { toast('The host opened the tabletop game: your dice and sheet are in the TTRPG panel.', 'info', 6000); panel.open('table'); }
    wasOn = on;
  };
  app.scene.on((what) => { sync(); if (what === 'state' && panel.isOpen) panel.render(); }); s.on(sync); sync();
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input,textarea,select')) return;
    if (e.key === 'Y' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); panel.toggle(); }
  });
  app.bus.on((m) => {
    if (m.type !== 'command' || m.command !== 'ttrpg') return;
    const a = (m.args && typeof m.args === 'object' ? m.args : {}) as Record<string, unknown>;
    if (a.open) panel.open();
    if (a.start && s.isHost) { s.enter(); panel.open('table'); }
    if (a.stop && s.isHost) s.leave();
    if (typeof a.roll === 'string') s.roll(a.roll.slice(0, 40), typeof a.label === 'string' ? a.label.slice(0, 60) : 'Roll');
    if (typeof a.say === 'string') s.act(a.say.slice(0, 500));
    if (a.continue && s.isHost) void s.gmTurn({ kind: 'continue' }, false);
    if (a.xcard) s.xcard();
  });
  // stage-mode bar (stagemodes workstream): register when its registry exists, now or later
  const def: StageModeDef = {
    id: 'ttrpg', label: 'TTRPG', icon: '🎲', order: 40, active: () => s.active, available: () => s.isHost,
    enter: () => { s.enter(); panel.open('table'); }, exit: () => s.leave(),
  };
  const reg = () => { const r = (window as unknown as { vtpStageModes?: { register(d: StageModeDef): void } }).vtpStageModes; if (r) { r.register(def); return true; } return false; };
  if (!reg()) window.addEventListener('vtp-stagemodes-ready', () => reg(), { once: true });
  (window as unknown as { vtpTtrpg: unknown }).vtpTtrpg = { session: s, panel };
  return { session: s, panel };
}
