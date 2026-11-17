// The TTRPG drawer: a lobby (open the table, load a campaign), the Table (roll requests, the dice tray, the story log,
// what you do / say), your Character, the GM's controls (host or the human GM) and Setup (rules, content & safety, the
// AI Game Master (a model on this PC), voices, the stream overlay, VTT bridges, campaigns). Nothing here asks for a key.
import { h, clear, rerender, sliderControl, toast } from '../../ui/dom.ts';
import { DEFAULT_VOICE_PREFS } from '../studio/engine.ts';
import { api } from '../../api.ts';
import type { TtrpgSession } from '../studio/session.ts';
import { TTRPG_CSS } from './panelCss.ts';
import { GM_BUILTINS, BUILTIN_NAMES, TTRPG_MOODS, roomGmStyles, type TtrpgShot } from '../../../shared/ttrpg/state.ts';
import { CLASSES, CONDITIONS, MONSTERS, ARCHETYPES, RACES, SRD_ATTRIBUTION, ABILITIES, abilityMod, fmtMod } from '../../../shared/ttrpg/srd.ts';
import { blankCharacter, quickBuild5e, checkBonus, type TtrpgCharacter } from '../../../shared/ttrpg/rules.ts';
import { MAP_TEMPLATES } from '../../../shared/ttrpg/maps.ts';
import { RATINGS } from '../../../shared/ttrpg/gm.ts';
import { findSeed } from '../../../shared/ttrpg/seeds.ts';
import { browserVoices, hasBrowserStt, listen } from '../studio/voice.ts';
import type { LogEntry, RollRequest } from '../../../shared/ttrpg/wire.ts';

type Tab = 'table' | 'char' | 'gm' | 'setup';
const DIE_PATHS: Record<number, string> = {
  4: 'M20 3 L37 35 L3 35 Z', 6: 'M6 6 H34 V34 H6 Z', 8: 'M20 2 L37 20 L20 38 L3 20 Z', 10: 'M20 2 L37 16 L20 38 L3 16 Z',
  12: 'M20 2 L38 15 L31 37 L9 37 L2 15 Z', 20: 'M20 2 L37 11 L37 29 L20 38 L3 29 L3 11 Z', 100: 'M20 3 A17 17 0 1 1 19.9 3 Z',
};
const LOOK_ICON: Record<string, string> = { d20: '🎲', tome: '📖', skull: '💀', radio: '📻', orb: '🔮', voice: '✨' };
const svgNS = 'http://www.w3.org/2000/svg';
function dieSvg(sides: number) { const s = document.createElementNS(svgNS, 'svg'); s.setAttribute('viewBox', '0 0 40 40'); const p = document.createElementNS(svgNS, 'path'); p.setAttribute('d', DIE_PATHS[sides] ?? DIE_PATHS[6]); p.setAttribute('class', 'f'); s.append(p); return s; }
const d20Icon = () => { const s = document.createElementNS(svgNS, 'svg'); s.setAttribute('viewBox', '0 0 40 40'); s.innerHTML = '<path d="M20 2 L37 11 L37 29 L20 38 L3 29 L3 11 Z" fill="currentColor" opacity=".9"/><path d="M20 9 L30 27 H10 Z" fill="none" stroke="var(--panel)" stroke-width="2"/>'; return s; };

interface Cfg { model: string; local: { kind: string; url: string }; temperature: number; maxTokens: number;
  tts: { provider: string; model: string; voice: string; url: string }; stt: { provider: string; model: string; url: string }; limits: { minGapSec: number; perMinute: number; sessionTokens: number };
  bridge: { enabled: boolean; code: string } }

export class TtrpgPanel {
  readonly el: HTMLDivElement;
  private head = h('div', { class: 'tt-head' });
  private body = h('div', { class: 'tt-body' });
  private foot = h('div');
  /** Roll requests live above the composer, never scrolled away. */
  private reqBox = h('div', { class: 'tt-reqs' });
  private tab: Tab = (localStorage.getItem('vtp.ttrpg.tab') as Tab) || 'table';
  private pool = new Map<number, number>();
  private mod = 0;
  private adv: '' | 'adv' | 'dis' = '';
  private draft = '';
  private ooc = false;
  private cfg: Cfg | null = null;
  private cfgErr = '';
  private models: string[] = [];
  private test: { ok: boolean; text: string } | null = null;
  private campaigns: { id: string; title: string; env: string; savedAt: number; sessions: number; chars: string[] }[] | null = null;
  private avatars: { id: string; name: string }[] = [];
  private sysVoices: { ok: boolean; names: string[] } | null = null;
  private logEl: HTMLElement | null = null;
  private stick = true;

  constructor(private s: TtrpgSession) {
    if (!document.getElementById('tt-css')) document.head.append(h('style', { id: 'tt-css' }, TTRPG_CSS));
    this.el = h('div', { class: 'tt-drawer', role: 'dialog', 'aria-label': 'Tabletop RPG' }, this.head, this.body, this.foot);
    document.body.append(this.el);
    this.body.addEventListener('scroll', () => { const b = this.body; this.stick = b.scrollTop + b.clientHeight > b.scrollHeight - 48; }, { passive: true });
    s.on((what) => { if (!this.isOpen) return; if (what === 'live') this.renderLive(); else this.render(); });
    setInterval(() => { if (this.isOpen && (this.tab === 'gm' || this.tab === 'setup') && this.s.isHost) void this.refreshSpend(); }, 5000);
  }
  get isOpen() { return this.el.classList.contains('open'); }
  open(tab?: Tab) { if (tab) this.setTab(tab); this.el.classList.add('open'); this.render(); if (this.s.isHost) { void this.loadCfg(); void this.loadCampaigns(); } void this.loadAvatars(); }
  close() { this.el.classList.remove('open'); }
  toggle() { if (this.isOpen) this.close(); else this.open(); }
  private setTab(t: Tab) { if (t !== this.tab) this.body.scrollTop = 0; this.tab = t; localStorage.setItem('vtp.ttrpg.tab', t); if (t === 'table') this.stick = true; }

  // ---------------------------------------------------------------- data
  private async loadCfg() { try { this.cfg = await api.get<Cfg>('/api/ttrpg/config'); this.cfgErr = ''; } catch (e) { this.cfgErr = (e as Error).message; } this.render(); }
  private async saveCfg(p: Record<string, unknown>) {
    try { this.cfg = await apiJson<Cfg>('PUT', '/api/ttrpg/config', p); toast('Saved', 'ok', 1400); } catch (e) { toast((e as Error).message, 'err'); }
    this.render();
  }
  private async loadCampaigns() { try { this.campaigns = await api.get('/api/ttrpg/campaigns'); } catch { this.campaigns = []; } this.render(); }
  private async loadAvatars() { if (this.avatars.length) return; try { const l = await api.avatars(); this.avatars = l.map((a) => ({ id: a.id, name: a.name })); } catch { /* */ } }
  private async refreshSpend() { try { this.s.spend = await api.get('/api/ttrpg/spend'); if (this.tab === 'gm') this.render(); } catch { /* */ } }

  // ---------------------------------------------------------------- render
  render() {
    const s = this.s;
    const t = s.table;
    clear(this.head);
    const title = t?.on ? (s.isHost ? s.game?.title : s.view?.title) || 'The table' : 'Tabletop RPG';
    const status = s.isHost ? s.gmStatus : s.view?.gmBusy ?? '';
    const statusText: Record<string, string> = { thinking: 'GM is thinking', speaking: 'GM is speaking', waiting: 'Waiting for rolls', paused: 'GM paused', approve: 'Line to approve', error: 'GM error', '': t?.on ? 'Table open' : 'Closed' };
    this.head.append(h('div', { class: 'top' },
      h('h2', null, title),
      h('span', { class: `tt-status ${status}` }, h('i'), statusText[status] ?? status),
      t?.on ? h('button', { class: 'tt-x', title: 'X-card: stop, rewind the last description and move on. Nobody has to explain why.', 'aria-label': 'X-card', onClick: () => { s.xcard(); toast('X-card: the GM rewinds and moves on.', 'warn'); } }, '✕') : null,
      h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onClick: () => this.close() }, '›')));
    const room = t?.on ? s.roomInfo(s.scene.effective.sceneId)?.name : null;
    this.head.append(h('div', { class: 'room' }, t?.on ? `${room ?? 'Table'}${s.isHost && s.game?.gm.kind === 'ai' ? ` with ${s.game.gm.look.name}` : ''}` : s.isHost ? 'Play a tabletop game with your party, right in your room.' : 'The host opens the table; you play from here.'));
    const tabs: [Tab, string][] = [['table', 'Table'], ['char', 'Character']];
    const iAmGm = !s.isHost && s.view?.gmKind === 'human' && s.scene.effective.ttrpg?.gm.who === s.selfKey;
    if (s.isHost || iAmGm) tabs.push(['gm', 'Game master']);
    if (s.isHost) tabs.push(['setup', 'Setup']);
    if (!tabs.some(([k]) => k === this.tab)) this.setTab('table');
    this.head.append(h('div', { class: 'tt-tabs', role: 'tablist' }, ...tabs.map(([k, l]) => h('button', { class: this.tab === k ? 'on' : '', role: 'tab', onClick: () => { this.setTab(k); this.render(); } }, l))));
    this.body.classList.toggle('table-view', this.tab === 'table' && !!t?.on);
    // the composer lives outside the re-rendered body: the log keeps updating while you type
    const wantFoot = this.tab === 'table' && !!t?.on;
    if (wantFoot && !this.foot.firstChild) this.foot.append(this.reqBox, this.composer());
    else if (!wantFoot && this.foot.firstChild) clear(this.foot);
    if (wantFoot) rerender(this.reqBox, () => this.requests());
    rerender(this.body, () => {
      if (!t?.on && this.tab !== 'setup' && this.tab !== 'char') { this.lobby(); return; }
      if (this.tab === 'table') this.tableTab();
      else if (this.tab === 'char') this.charTab();
      else if (this.tab === 'gm') this.gmTab();
      else this.setupTab();
    });
    if (this.tab === 'table' && this.logEl && this.stick) this.body.scrollTop = 1e9;
  }

  private renderLive() {
    const live = this.body.querySelector('.tt-e.live');
    if (live) live.textContent = this.s.live; else this.render();
    if (this.stick) this.body.scrollTop = 1e9;
  }

  // ---------------------------------------------------------------- lobby
  private lobby() {
    const s = this.s, b = this.body;
    if (!s.isHost) { b.append(h('div', { class: 'tt-card tt-start' }, h('p', { class: 'big' }, 'Waiting for the table'), h('p', null, 'When the host opens it, your party walks to the table and your character sheet, dice and the story show up here. You can make your character now in the Character tab.'))); return; }
    const cur = s.scene.state.sceneId;
    const target = s.ttrpgRoomFor(cur);
    const tInfo = s.roomInfo(target);
    const sys = (localStorage.getItem('vtp.ttrpg.sys') as '5e' | 'generic') || '5e';
    const seg = <T extends string>(opts: [T, string][], cur: T, on: (v: T) => void) => h('div', { class: 'seg' }, ...opts.map(([v, l]) => h('button', { class: v === cur ? 'on' : '', onClick: () => on(v) }, l)));
    b.append(h('div', { class: 'tt-card tt-start' },
      h('p', { class: 'big' }, tInfo ? `Open the table in ${tInfo.name}` : 'Open the table'),
      h('p', null, tInfo ? `Everyone walks over to ${tInfo.name}${cur && target !== cur ? ` (from ${s.roomInfo(cur)?.name ?? cur})` : ''} and sits down. The transition plays on every OBS page.` : 'No TTRPG room is installed yet: the table opens in the current room (map and dice need a TTRPG room).'),
      h('div', { class: 'tt-row' }, h('label', null, 'Rules'), seg<'5e' | 'generic'>([['5e', '5e-compatible (SRD)'], ['generic', 'Rules-light']], sys, (v) => { localStorage.setItem('vtp.ttrpg.sys', v); this.render(); })),
      h('button', { class: 'btn primary big', onClick: () => { s.enter({ system: sys }); this.setTab('table'); this.render(); } }, s.game && s.game.env === (s.roomCfg(cur)?.of ?? cur) ? 'Resume the table' : 'Open the table'),
      s.game ? h('button', { class: 'btn ghost', onClick: () => { if (confirm('Start a new adventure? The current one stays in your saved campaigns.')) { void s.save(); s.newCampaign(sys); } } }, 'Start a new adventure instead') : null));
    b.append(this.campaignCard());
  }

  private campaignCard() {
    const s = this.s;
    const list = this.campaigns;
    return h('div', { class: 'tt-card' }, h('h3', null, 'Saved campaigns'),
      !list ? h('p', { class: 'hint' }, 'Loading…') : !list.length ? h('p', { class: 'hint' }, 'Campaigns save themselves on this PC while you play (every minute and when the table closes).') :
        h('div', { class: 'tt-camps' }, ...list.slice(0, 12).map((c) => h('div', { class: 'tt-camp' },
          h('div', null, h('b', null, c.title), h('br'), h('span', null, `${c.chars.join(', ') || 'no characters yet'}${c.sessions ? `, session ${c.sessions}` : ''}, ${new Date(c.savedAt).toLocaleDateString()}`)),
          h('button', { class: 'btn', onClick: () => void s.load(c.id).then(() => { this.setTab('table'); this.render(); }).catch((e) => toast(String(e.message ?? e), 'err')) }, 'Load')))),
      s.game?.table.on ? h('div', { class: 'tt-row', style: 'margin-top:8px' }, h('button', { class: 'btn', onClick: () => void s.save().then((ok) => { toast(ok ? 'Campaign saved' : 'Could not save', ok ? 'ok' : 'err'); void this.loadCampaigns(); }) }, 'Save now'),
        h('button', { class: 'btn ghost', onClick: () => { if (confirm('Close the table and go back?')) { s.leave(); this.render(); } } }, 'Close the table')) : null);
  }

  // ---------------------------------------------------------------- table
  private requests() {
    const s = this.s, b = this.reqBox;
    const reqs = (s.isHost ? s.game?.requests : s.view?.requests) ?? [];
    const mine = reqs.filter((r) => r.who === s.selfKey || (s.isHost && s.game?.chars.find((c) => c.name === r.name && !c.owner)));
    for (const r of mine) b.append(this.reqCard(r));
    if (s.isHost) for (const r of reqs.filter((x) => !mine.includes(x))) b.append(h('div', { class: 'tt-req other' }, h('div', { class: 'what' }, h('b', null, `${r.name}: ${r.label}`), h('span', null, `waiting for their roll (${r.expr})`)), h('button', { class: 'btn', title: 'Roll it for them', onClick: () => s.rollFor(r.who, r.expr, r.label, r.id) }, 'Roll for them')));
    if (s.isHost && s.gmStatus === 'waiting') b.append(h('button', { class: 'btn ghost', onClick: () => s.continueWithout() }, 'Let the GM go on without the missing rolls'));
  }

  private tableTab() {
    const s = this.s, b = this.body;
    b.append(this.tray());
    const logWrap = h('div', { class: 'tt-log', 'aria-live': 'polite' });
    const entries = ((s.isHost ? s.game?.log : s.view?.log) ?? []).slice(-80);
    for (const e of entries) logWrap.append(this.entry(e));
    if (s.isHost && s.live && s.gmStatus === 'thinking') logWrap.append(h('div', { class: 'tt-e gm live' }, s.live));
    if (!entries.length) logWrap.append(h('p', { class: 'hint' }, s.isHost && s.game?.gm.kind === 'ai' ? 'Say what your character does below, or open Game master and press Start the story.' : 'The story shows up here.'));
    this.logEl = logWrap;
    b.append(logWrap);
  }

  private entry(e: LogEntry) {
    return h('div', { class: `tt-e ${e.kind}` }, e.kind === 'gm' || e.kind === 'roll' || e.kind === 'system' ? null : h('span', { class: 'who' }, e.name), e.text);
  }

  private reqCard(r: RollRequest) {
    return h('div', { class: 'tt-req' },
      h('div', { class: 'what' }, h('b', null, r.label), h('span', null, `${r.name} rolls ${r.expr}${r.secret ? ' (secret)' : ''}`)),
      h('button', { class: 'tt-rollbtn', onClick: () => { this.s.roll(r.expr, r.label, r.id, r.secret); } }, 'Roll'));
  }

  private tray() {
    const expr = this.poolExpr();
    const dice = h('div', { class: 'tt-dice' }, ...[4, 6, 8, 10, 12, 20, 100].map((n) => {
      const c = this.pool.get(n) ?? 0;
      const b = h('button', { class: `tt-die${c ? ' picked' : ''}`, title: `Add a d${n === 100 ? '%' : n} (right-click removes one)`, 'aria-label': `d${n}`,
        onClick: () => { this.pool.set(n, Math.min(20, c + 1)); this.render(); },
        onContextmenu: (ev: MouseEvent) => { ev.preventDefault(); if (c > 1) this.pool.set(n, c - 1); else this.pool.delete(n); this.render(); } });
      b.append(dieSvg(n), h('b', null, n === 100 ? '%' : `d${n}`), h('span', { class: 'n' }, String(c)));
      return b;
    }));
    const input = h('input', { type: 'text', value: expr, placeholder: 'd20+5, 2d6+3, 4d6kh3', 'aria-label': 'Dice to roll', onInput: (e: Event) => { this.pool.clear(); this.custom = (e.target as HTMLInputElement).value; } }) as HTMLInputElement;
    if (this.custom && !this.pool.size) input.value = this.custom;
    const advSeg = h('div', { class: 'seg', title: 'Advantage / disadvantage on a single d20' }, ...([['', 'Normal'], ['adv', 'Adv'], ['dis', 'Dis']] as ['' | 'adv' | 'dis', string][]).map(([v, l]) => h('button', { class: this.adv === v ? 'on' : '', onClick: () => { this.adv = v; this.render(); } }, l)));
    const roll = () => {
      let e = (this.pool.size ? this.poolExpr() : input.value || this.custom).trim();
      if (!e) { toast('Pick some dice first', 'warn', 1500); return; }
      if (this.adv && /^1?d20\b/.test(e)) e = e.replace(/^1?d20/, `d20 ${this.adv} `);
      this.s.roll(e, 'Roll');
      this.pool.clear(); this.custom = '';
      this.render();
    };
    return h('div', { class: 'tt-tray' }, dice, h('div', { class: 'tt-traybar' },
      h('button', { class: 'btn ghost', title: 'Modifier −1', onClick: () => { this.mod--; this.render(); } }, '−'),
      input,
      h('button', { class: 'btn ghost', title: 'Modifier +1', onClick: () => { this.mod++; this.render(); } }, '+'),
      h('button', { class: 'tt-rollbtn', onClick: roll }, 'Roll')), h('div', { class: 'tt-traybar' }, advSeg, h('span', { class: 'tt-grow' }), this.pool.size || this.mod ? h('button', { class: 'btn ghost', onClick: () => { this.pool.clear(); this.mod = 0; this.render(); } }, 'Clear') : null));
  }
  private custom = '';
  private poolExpr() {
    const parts = [...this.pool.entries()].sort((a, b) => b[0] - a[0]).map(([n, c]) => `${c}d${n}`);
    return parts.length || this.mod ? `${parts.join('+') || 'd20'}${this.mod ? fmtMod(this.mod) : ''}` : '';
  }

  private composer() {
    const s = this.s;
    const ta = h('textarea', { placeholder: this.ooc ? 'Table talk (out of character)…' : 'What does your character do or say?', 'aria-label': 'Your action', value: this.draft,
      onInput: (e: Event) => { this.draft = (e.target as HTMLTextAreaElement).value; },
      onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } }) as HTMLTextAreaElement;
    const send = () => { const t = ta.value.trim(); if (!t) return; s.act(t, this.ooc); this.draft = ''; ta.value = ''; this.stick = true; };
    let rec: ReturnType<typeof listen> | null = null;
    const mode = (localStorage.getItem('vtp.ttrpg.stt') as 'browser' | 'server') || (hasBrowserStt() ? 'browser' : 'server');
    const ptt = h('button', { class: 'tt-ptt', title: 'Hold to talk: your words become your action (speech-to-text)',
      onPointerdown: () => { ptt.classList.add('on'); try { rec = listen(mode, 'en-US', (p) => { ta.value = p; }); } catch (e) { toast(String(e), 'err'); } },
      onPointerup: async () => { ptt.classList.remove('on'); if (!rec) return; try { const t = await rec.stop(); if (t) { ta.value = t; this.draft = t; } } catch (e) { toast(`Speech-to-text: ${(e as Error).message}`, 'err'); } rec = null; },
      onPointerleave: () => { if (rec) { ptt.classList.remove('on'); void rec.stop().then((t) => { if (t) { ta.value = t; this.draft = t; } }).catch(() => {}); rec = null; } } }, '🎙 Hold to talk');
    return h('div', { class: 'tt-composer' }, ta, h('div', { class: 'tt-row' }, ptt,
      h('label', { class: 'tt-chip' + (this.ooc ? ' on' : ''), style: 'min-width:0', title: 'Out of character: table talk the GM answers briefly' }, h('input', { type: 'checkbox', checked: this.ooc, style: 'display:none', onChange: (e: Event) => { this.ooc = (e.target as HTMLInputElement).checked; this.render(); } }), 'Out of character'),
      h('span', { class: 'tt-grow' }), h('button', { class: 'btn primary', onClick: send }, 'Send')));
  }

  // ---------------------------------------------------------------- character
  private charTab() {
    const s = this.s, b = this.body;
    const c = s.myChar();
    if (!c) { b.append(this.builder()); return; }
    b.append(this.sheet(c, true));
    if (s.isHost) {
      const others = (s.game?.chars ?? []).filter((x) => x.id !== c.id);
      if (others.length) b.append(h('div', { class: 'tt-card' }, h('h3', null, 'The party'), ...others.map((o) => h('div', { class: 'tt-camp', style: 'margin-bottom:6px' }, h('div', null, h('b', null, o.name), h('br'), h('span', null, `${o.concept}, played by ${o.owner ? s.memberName(o.owner) : 'nobody yet'}. HP ${o.hp[0]}/${o.hp[1]}, AC ${o.ac}`)),
        h('button', { class: 'btn ghost', onClick: () => { if (confirm(`Remove ${o.name}?`)) s.removeSheet(o.id); } }, 'Remove')))));
    }
  }

  private builder() {
    const s = this.s;
    const sys = s.isHost ? s.game?.system ?? '5e' : s.view?.system ?? '5e';
    const name = h('input', { type: 'text', placeholder: 'Character name', value: '' }) as HTMLInputElement;
    const race = h('select', null, ...RACES.map((r) => h('option', { value: r.id }, r.name))) as HTMLSelectElement;
    const cls = h('select', null, ...CLASSES.map((c) => h('option', { value: c.id }, c.name))) as HTMLSelectElement;
    const concept = h('input', { type: 'text', placeholder: 'Ex-scav medic, frog line cook…' }) as HTMLInputElement;
    const file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onChange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
      try { const r = s.importSheet(JSON.parse(await f.text())); toast(r.c ? `Imported ${r.c.name} (${r.from})` : r.why, r.c ? 'ok' : 'err'); } catch (err) { toast(`Not a sheet: ${(err as Error).message}`, 'err'); }
    } }) as HTMLInputElement;
    return h('div', { class: 'tt-card' }, h('h3', null, 'Make your character'),
      h('div', { class: 'tt-field' }, h('span', null, 'Name'), name),
      sys === '5e' ? h('div', { class: 'tt-row' }, h('div', { class: 'tt-field tt-grow' }, h('span', null, 'Ancestry'), race), h('div', { class: 'tt-field tt-grow' }, h('span', null, 'Class'), cls))
        : h('div', { class: 'tt-field' }, h('span', null, 'Who are they?'), concept),
      h('p', { class: 'hint' }, sys === '5e' ? 'Level 1 with the standard array placed for the class. You can tweak everything after.' : 'Four stats to start (Might, Grace, Wits, Heart) — rename or change them after.'),
      h('div', { class: 'tt-row', style: 'margin-top:8px' },
        h('button', { class: 'btn primary', onClick: () => {
          const nm = name.value.trim() || 'Hero';
          const c = sys === '5e' ? quickBuild5e(race.value, cls.value, nm, s.selfKey) : { ...blankCharacter('generic', s.selfKey, nm), concept: concept.value.trim() || 'Adventurer', hp: [12, 12] as [number, number] };
          c.color = ['#45b7d1', '#e8615a', '#b07cf0', '#5cc98b', '#f2a541', '#f07cc0', '#6c8cff', '#9fd356'][Math.abs(hashStr(s.selfKey)) % 8];
          s.setSheet(c); this.render();
        } }, 'Create'),
        h('button', { class: 'btn', onClick: () => file.click(), title: 'VTube Pro sheet JSON, a Foundry VTT dnd5e actor export, or {name, hp, ac, stats}' }, 'Import a sheet'), file));
  }

  private sheet(c: TtrpgCharacter, mine: boolean) {
    const s = this.s;
    const upd = (p: Partial<TtrpgCharacter>) => { s.setSheet({ ...c, ...p }); };
    const rollCheck = (what: string) => { const b = checkBonus(c, what); if (b) s.roll(`d20${this.adv ? ` ${this.adv}` : ''}${b.bonus ? fmtMod(b.bonus) : ''}`, b.label); };
    const is5e = c.system === '5e';
    const stats = h('div', { class: 'tt-stats' }, ...Object.entries(c.stats).slice(0, 6).map(([k, v]) => h('button', { class: 'tt-stat', title: `Roll ${k}`, onClick: () => rollCheck(k) },
      h('small', null, k.length <= 3 ? k.toUpperCase() : k), h('b', null, is5e ? fmtMod(abilityMod(v)) : fmtMod(v)), is5e ? h('i', null, String(v)) : null)));
    const skills = h('div', { class: 'tt-list' }, ...Object.entries(c.skills).map(([k, v]) => h('button', { title: `Roll ${k}`, onClick: () => rollCheck(k) }, k, h('span', null, fmtMod(v)))));
    const hpBtn = (d: number, label: string) => h('button', { title: d < 0 ? 'Take 1 damage' : 'Heal 1', onClick: () => upd({ hp: [Math.max(0, Math.min(c.hp[1], c.hp[0] + d)), c.hp[1]] }) }, label);
    const newItem = h('input', { type: 'text', placeholder: 'Add an item', onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v) upd({ inventory: [...c.inventory, v] }); } } });
    return h('div', { class: 'tt-card' },
      h('div', { class: 'tt-sheet-top' }, h('div', null, h('input', { class: 'name', type: 'text', value: c.name, 'aria-label': 'Name', onChange: (e: Event) => upd({ name: (e.target as HTMLInputElement).value.trim() || c.name, icon: ((e.target as HTMLInputElement).value.trim() || c.name).slice(0, 1).toUpperCase() }) }),
        h('div', { class: 'hint' }, c.concept)), h('input', { type: 'color', value: c.color, title: 'Your mini’s colour', onChange: (e: Event) => upd({ color: (e.target as HTMLInputElement).value }) })),
      h('div', { class: 'tt-vitals' },
        h('div', { class: 'tt-vital' }, h('b', null, `${c.hp[0]}/${c.hp[1]}`), h('span', null, `HP${c.temp ? ` +${c.temp}` : ''}`), mine ? h('div', { class: 'hpbtns' }, hpBtn(-1, '−'), hpBtn(1, '+')) : null),
        h('div', { class: 'tt-vital' }, h('b', null, String(c.ac)), h('span', null, 'AC')),
        h('div', { class: 'tt-vital', title: 'Click to roll initiative', style: 'cursor:pointer', onClick: () => rollCheck('init') }, h('b', null, fmtMod(checkBonus(c, 'init')?.bonus ?? 0)), h('span', null, 'Initiative'))),
      stats,
      c.attacks.length ? h('div', { style: 'margin-top:10px' }, ...c.attacks.map((a) => h('div', { class: 'tt-atk' }, h('span', null, a.name, a.note ? h('span', { class: 'hint' }, ` ${a.note}`) : null),
        h('button', { class: 'btn', onClick: () => s.roll(`d20${this.adv ? ` ${this.adv}` : ''}${fmtMod(a.hit)}`, `${a.name} attack`) }, `${fmtMod(a.hit)} to hit`),
        h('button', { class: 'btn', onClick: () => s.roll(a.dmg, `${a.name} damage`) }, a.dmg)))) : null,
      Object.keys(c.skills).length ? h('div', { style: 'margin-top:10px' }, h('h3', null, 'Skills'), skills) : null,
      h('div', { style: 'margin-top:10px' }, h('h3', null, 'Conditions'), h('div', { class: 'tt-chips' }, ...CONDITIONS.map((k) => h('button', { class: `tt-chip${c.conditions.includes(k) ? ' on' : ''}`, onClick: () => upd({ conditions: c.conditions.includes(k) ? c.conditions.filter((x) => x !== k) : [...c.conditions, k] }) }, k)))),
      h('div', { style: 'margin-top:10px' }, h('h3', null, 'Inventory'), h('div', { class: 'tt-chips' }, ...c.inventory.map((it, i) => h('button', { class: 'tt-chip', title: 'Remove', onClick: () => upd({ inventory: c.inventory.filter((_, k) => k !== i) }) }, it))), h('div', { class: 'tt-row', style: 'margin-top:6px' }, newItem)),
      c.features.length ? h('p', { class: 'hint' }, c.features.join(', ')) : null,
      h('div', { class: 'tt-row', style: 'margin-top:10px' }, h('span', { class: 'hint tt-grow' }, `Luck ${c.luck}`),
        h('button', { class: 'btn ghost', onClick: () => download(`${c.name}.json`, JSON.stringify(s.exportSheet(c), null, 2)) }, 'Export'),
        mine ? h('button', { class: 'btn ghost danger', onClick: () => { if (confirm('Make a new character? This one is removed from the table.')) { if (s.isHost) s.removeSheet(c.id); else s.setSheet({ ...c, owner: undefined }); this.render(); } } }, 'New character') : null));
  }

  // ---------------------------------------------------------------- game master
  private gmTab() {
    const s = this.s, b = this.body, g = s.game;
    if (!s.isHost || !g) { b.append(this.gmTools()); return; }
    const kinds: ['ai' | 'human' | 'none', string][] = [['ai', 'AI'], ['human', 'A person'], ['none', 'Nobody']];
    const members = s.scene.members();
    b.append(h('div', { class: 'tt-card' }, h('h3', null, 'Who runs the game'),
      h('div', { class: 'seg' }, ...kinds.map(([k, l]) => h('button', { class: g.gm.kind === k ? 'on' : '', onClick: () => s.setGm({ kind: k, who: k === 'human' ? g.gm.who ?? s.selfKey : undefined }) }, l))),
      g.gm.kind === 'human' ? h('div', { class: 'tt-row', style: 'margin-top:8px' }, h('label', null, 'GM'), h('select', { onChange: (e: Event) => s.setGm({ kind: 'human', who: (e.target as HTMLSelectElement).value }) }, ...members.map((m) => h('option', { value: m.key, selected: m.key === (g.gm.who ?? s.selfKey) }, m.name)))) : null,
      h('p', { class: 'hint' }, g.gm.kind === 'ai' ? 'An AI model narrates, voices the NPCs, asks for rolls and moves the minis. It runs on a model on this PC (Setup).' : g.gm.kind === 'human' ? 'That person sits in the GM’s chair and gets the Game master tools in their panel.' : 'Free play: dice, map and initiative, no narrator.')));
    if (g.gm.kind === 'ai') {
      b.append(this.lookCard());
      const st = s.gmStatus;
      b.append(h('div', { class: 'tt-card' }, h('h3', null, 'The story'),
        h('div', { class: 'tt-row' },
          !g.log.some((e) => e.kind === 'gm') ? h('button', { class: 'btn primary', disabled: st === 'thinking', onClick: () => void s.gmTurn({ kind: 'start' }, false) }, 'Start the story') : h('button', { class: 'btn primary', disabled: st === 'thinking', onClick: () => void s.gmTurn({ kind: 'continue' }, false) }, 'Continue'),
          h('button', { class: 'btn', disabled: st === 'thinking', onClick: () => void s.gmTurn({ kind: 'recap' }, false) }, 'Recap'),
          h('button', { class: 'btn', disabled: st !== 'speaking', onClick: () => s.skipLine() }, 'Skip line'),
          h('button', { class: 'btn', onClick: () => s.stopAll() }, 'Stop')),
        h('div', { class: 'tt-row', style: 'margin-top:6px' },
          h('button', { class: 'btn ghost', onClick: () => s.redo(), title: 'Put the table back as it was before the last GM turn and ask again' }, 'Redo last turn'),
          h('button', { class: 'btn ghost', onClick: () => s.undo(), title: 'Put the table back as it was before the last GM turn' }, 'Undo last turn'),
          h('button', { class: `btn ${s.paused ? 'primary' : 'ghost'}`, onClick: () => s.setPaused(!s.paused) }, s.paused ? 'Resume GM' : 'Pause GM')),
        toggleRow('Approve every GM line before it is spoken', g.ai.approve, (v) => s.setAi({ approve: v })),
        toggleRow('GM answers players automatically', g.ai.auto, (v) => s.setAi({ auto: v })),
        s.gmError ? h('p', { class: 'hint', style: 'color:var(--err)' }, s.gmError) : null,
        s.lastTurn ? h('p', { class: 'hint' }, `Last turn: first words after ${(s.lastTurn.firstMs / 1000).toFixed(1)} s, done in ${(s.lastTurn.ms / 1000).toFixed(1)} s (${s.lastTurn.model})`) : null));
      if (s.pending) b.append(this.pendingCard());
    }
    b.append(this.gmTools());
    if (g.gm.kind === 'ai') {
      const seeds = s.seeds();
      const seed = findSeed(g.ai.seedId);
      b.append(h('div', { class: 'tt-card' }, h('h3', null, 'Adventure'),
        h('div', { class: 'tt-row' }, h('label', null, 'Seed'), h('select', { onChange: (e: Event) => { const id = (e.target as HTMLSelectElement).value; const sd = findSeed(id); s.setAi({ seedId: id }); if (sd) s.setTitle(sd.title); } },
          h('option', { value: '' }, 'Improvise'), ...seeds.map((x) => h('option', { value: x.id, selected: x.id === g.ai.seedId }, x.title)))),
        seed ? h('p', { class: 'hint' }, seed.pitch) : null,
        h('div', { class: 'tt-field', style: 'margin-top:8px' }, h('span', null, 'Campaign title'), h('input', { type: 'text', value: g.title, onChange: (e: Event) => s.setTitle((e.target as HTMLInputElement).value) })),
        h('div', { class: 'tt-field' }, h('span', null, 'The GM’s notes (kept short automatically as the story grows)'), h('textarea', { rows: 4, value: g.ai.memory, onChange: (e: Event) => s.setAi({ memory: (e.target as HTMLTextAreaElement).value.slice(0, 2000) }) })),
        g.ai.facts.length ? h('p', { class: 'hint' }, `Remembered: ${g.ai.facts.slice(-8).join('; ')}`) : null,
        h('div', { class: 'tt-field' }, h('span', null, 'The GM’s character'), h('input', { type: 'text', value: g.gm.persona, placeholder: 'a gruff radio handler, a whispering skull…', onChange: (e: Event) => s.setGm({ persona: (e.target as HTMLInputElement).value.slice(0, 240) }) }))));
      const sp = s.spend;
      if (sp) b.append(h('div', { class: 'tt-card' }, h('h3', null, 'This session’s AI use'), h('div', { class: 'tt-kv' },
        h('span', null, 'GM turns'), h('span', null, String(sp.calls)), h('span', null, 'Tokens'), h('span', null, `${(sp.input + sp.output).toLocaleString()} (${sp.input.toLocaleString()} in, ${sp.output.toLocaleString()} out)`),
        h('span', null, 'Limit'), h('span', null, `${sp.budgetTokens.toLocaleString()} tokens a session`)),
        h('button', { class: 'btn ghost', onClick: () => void apiJson('POST', '/api/ttrpg/spend/reset', {}).then(() => this.refreshSpend()) }, 'Reset the meter')));
    }
  }

  private lookCard() {
    const s = this.s, g = s.game!;
    const cfg = s.roomCfg(g.room);
    const room = roomGmStyles(cfg).filter((x) => !x.builtin);
    const cur = g.gm.look.style;
    const pick = (style: string, name?: string) => s.setGm({ look: { ...g.gm.look, style, ...(name ? { name } : {}) } });
    return h('div', { class: 'tt-card' }, h('h3', null, 'How the GM appears'),
      h('div', { class: 'tt-looks' },
        ...room.map((r) => h('button', { class: `tt-look${cur === `room:${r.id}` ? ' on' : ''}`, onClick: () => pick(`room:${r.id}`, r.kind === 'character' ? r.name : undefined) }, h('span', { class: 'ic' }, r.kind === 'character' ? '🧙' : '✦'), r.name)),
        ...GM_BUILTINS.map((k) => h('button', { class: `tt-look${cur === k ? ' on' : ''}`, onClick: () => pick(k) }, h('span', { class: 'ic' }, LOOK_ICON[k]), BUILTIN_NAMES[k]))),
      h('div', { class: 'tt-row', style: 'margin-top:8px' }, h('label', null, 'An avatar'), h('select', { onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) pick(`avatar:${v}`, this.avatars.find((a) => a.id === v)?.name); } },
        h('option', { value: '' }, 'Pick from your library…'), ...this.avatars.map((a) => h('option', { value: a.id, selected: cur === `avatar:${a.id}` }, a.name)))),
      h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('label', null, 'Name'), h('input', { type: 'text', value: g.gm.look.name, onChange: (e: Event) => s.setGm({ look: { ...g.gm.look, name: (e.target as HTMLInputElement).value.slice(0, 40) || 'The Game Master' } }) }),
        h('input', { type: 'color', value: g.gm.look.color, title: 'Glow colour', onChange: (e: Event) => s.setGm({ look: { ...g.gm.look, color: (e.target as HTMLInputElement).value } }) })),
      h('p', { class: 'hint' }, 'Guests’ OBS pages show library avatars only if they have the same avatar; otherwise they see the room’s default GM.'),
      this.voiceRows());
  }

  private voiceRows() {
    const s = this.s, g = s.game!;
    const vs = browserVoices();
    this.loadSysVoices();
    return h('div', { style: 'margin-top:8px' },
      h('div', { class: 'tt-row' }, h('label', null, 'Voice'), h('select', { onChange: (e: Event) => s.setVoice({ voice: (e.target as HTMLSelectElement).value }) }, h('option', { value: '' }, 'Browser default'), ...vs.map((v) => h('option', { value: v.voiceURI, selected: v.voiceURI === g.voice.voice }, `${v.name} (${v.lang})`)))),
      h('div', { class: 'tt-row' }, h('label', null, 'Speed'), sliderControl(g.voice.rate, 0.7, 1.4, 0.05, (v) => s.setVoice({ rate: v }), { inline: true, commit: true, label: 'GM voice speed', unit: '×', def: DEFAULT_VOICE_PREFS.rate })),
      h('div', { class: 'tt-row' }, h('label', null, 'Pitch'), sliderControl(g.voice.pitch, 0.5, 1.5, 0.05, (v) => s.setVoice({ pitch: v }), { inline: true, commit: true, label: 'GM voice pitch', def: DEFAULT_VOICE_PREFS.pitch })),
      h('div', { class: 'tt-row' }, h('label', null, 'Voice from'), h('div', { class: 'seg' }, ...([['browser', 'This browser (free)'], ['server', 'Voice server on this PC (Setup)']] as const).map(([v, l]) => h('button', { class: g.voice.provider === v ? 'on' : '', onClick: () => s.setVoice({ provider: v }) }, l)))),
      h('div', { class: 'tt-row' }, h('label', null, 'Plays on'), h('div', { class: 'seg' },
        ...([['stream', 'On stream'], ['studio', 'Only me'], ['off', 'Muted']] as const).map(([v, l]) => {
          const on = v === 'off' ? !s.hearGm : s.hearGm && s.voiceOut === v;
          return h('button', { class: on ? 'on' : '', onClick: () => { if (v === 'off') s.setHear(false); else { if (!s.hearGm) s.setHear(true); s.setVoiceOut(v); } } }, l);
        }))),
      h('p', { class: 'hint' }, !s.hearGm ? 'No sound anywhere: captions and the GM’s mouth still keep the pace.'
        : s.voiceOut === 'studio' ? 'Only you: the GM’s voice plays on the Audio mixer’s “Only me” output. Pick your headphones there, or a window capture in OBS will hear it too.'
        : 'Your viewers hear it: this studio plays the GM’s voice (Audio mixer → Tabletop narrator) and your stream picks it up from this window, like your guests. The OBS page stays silent.'
          + (g.voice.provider === 'browser' ? ` On stream it uses this PC’s Windows voices${this.sysVoices?.names.length ? ` (${this.sysVoices.names.join(', ')})` : ''}.` : '')),
      s.voiceNote ? h('p', { class: 'hint', style: 'color:var(--tt-ember, #e8615a)' }, s.voiceNote) : null,
      this.sysVoices?.ok === false && s.hearGm && s.voiceOut !== 'studio' && g.voice.provider === 'browser' ? h('p', { class: 'hint' }, 'This PC has no Windows voices for the stream: choose “Voice server on this PC (Setup)” above, or play it in this studio.') : null);
  }
  private loadSysVoices() {
    if (this.sysVoices) return;
    this.sysVoices = { ok: true, names: [] };
    void api.get<{ systemOk: boolean; system: { name: string }[] }>('/api/ttrpg/voices')
      .then((r) => { this.sysVoices = { ok: r.systemOk, names: r.system.map((v) => v.name.replace(/^Microsoft\s+/, '').replace(/\s+Desktop$/, '')) }; this.render(); })
      .catch(() => { this.sysVoices = { ok: false, names: [] }; });
  }

  private pendingCard() {
    const p = this.s.pending!;
    const ta = h('textarea', { value: p.narration, 'aria-label': 'The GM’s line' }) as HTMLTextAreaElement;
    const keep = p.actions.map(() => true);
    return h('div', { class: 'tt-card tt-pending' }, h('h3', null, 'Approve the GM’s line'),
      ta, ...p.actions.map((a, i) => h('label', { class: 'tt-act' }, h('input', { type: 'checkbox', checked: true, onChange: (e: Event) => { keep[i] = (e.target as HTMLInputElement).checked; } }), h('span', null, a.type.replace(/_/g, ' ')), h('code', null, JSON.stringify(a).slice(0, 140)))),
      p.dropped.length ? h('p', { class: 'hint' }, `Ignored: ${p.dropped.join('; ')}`) : null,
      h('div', { class: 'tt-row', style: 'margin-top:8px' }, h('button', { class: 'btn primary', onClick: () => this.s.approve(ta.value, keep) }, 'Speak it'),
        h('button', { class: 'btn', onClick: () => this.s.redo() }, 'Ask again'), h('button', { class: 'btn ghost', onClick: () => this.s.discard() }, 'Throw away')));
  }

  /** Map, minis, mood, camera, combat, handouts, NPC lines: the same tools for the host, a human GM and to steer the AI. */
  private gmTools() {
    const s = this.s;
    const t = s.table;
    const title = h('input', { type: 'text', placeholder: 'Where are we?', value: t?.map?.title ?? '' }) as HTMLInputElement;
    const tpl = h('select', null, ...MAP_TEMPLATES.map((m) => h('option', { value: m.id, selected: m.id === t?.map?.tpl, title: m.hint }, m.name))) as HTMLSelectElement;
    const mon = h('select', null, h('optgroup', { label: 'SRD 5.1 creatures' }, ...MONSTERS.map((m) => h('option', { value: m.id }, `${m.name} (CR ${m.cr})`))), h('optgroup', { label: 'Any setting' }, ...ARCHETYPES.map((a) => h('option', { value: a.id }, `${a.name}: ${a.note}`)))) as HTMLSelectElement;
    const monName = h('input', { type: 'text', placeholder: 'Name (optional: “Scav”, “Rogue fry cook”)' }) as HTMLInputElement;
    const count = h('input', { type: 'number', min: 1, max: 8, value: 2, style: 'width:56px;flex:none' }) as HTMLInputElement;
    const say = h('input', { type: 'text', placeholder: 'A line for the GM or an NPC to speak' }) as HTMLInputElement;
    const npc = h('input', { type: 'text', placeholder: 'NPC name (empty = the GM)', style: 'max-width:150px' }) as HTMLInputElement;
    const hT = h('input', { type: 'text', placeholder: 'Handout title' }) as HTMLInputElement;
    const hX = h('textarea', { rows: 2, placeholder: 'What it says' }) as HTMLTextAreaElement;
    const hS = h('select', null, ...['parchment', 'note', 'dossier', 'wanted', 'screen'].map((x) => h('option', { value: x }, x))) as HTMLSelectElement;
    const img = h('input', { type: 'file', accept: 'image/*', style: 'display:none', onChange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
      const url = await shrink(f, 1400); const id = `img${Date.now().toString(36)}`;
      s.sendImage(id, url);
      s.gmDo({ type: 'show_handout', title: hT.value || f.name.replace(/\.[^.]+$/, ''), text: hX.value, style: hS.value as 'note' });
      toast('Image sent to the table', 'ok');
    } }) as HTMLInputElement;
    const shot = (v: TtrpgShot, l: string) => h('button', { class: `tt-chip${t?.cam === v ? ' on' : ''}`, onClick: () => s.isHost ? s.pin(v, undefined, v === 'auto' ? 0 : 20) : s.gmDo({ type: 'camera', shot: v === 'auto' ? 'wide' : v as 'wide' }) }, l);
    return h('div', { class: 'tt-card' }, h('h3', null, 'Table tools'),
      h('div', { class: 'tt-row' }, title, tpl, h('button', { class: 'btn', onClick: () => s.gmDo({ type: 'set_scene', title: title.value || 'A new place', map: tpl.value }) }, 'New scene')),
      h('div', { class: 'tt-row', style: 'margin-top:6px' }, mon, count), h('div', { class: 'tt-row', style: 'margin-top:6px' }, monName, h('button', { class: 'btn', onClick: () => {
        const srd = MONSTERS.find((m) => m.id === mon.value), arch = ARCHETYPES.find((a) => a.id === mon.value);
        s.gmDo({ type: 'spawn_token', name: monName.value.trim() || srd?.name || arch?.name || 'Foe', count: Math.max(1, Math.min(8, +count.value || 1)), kind: 'monster', srd: mon.value, at: 'east' });
      } }, 'Add to the map')),
      h('div', { class: 'tt-row', style: 'margin-top:10px' }, h('label', null, 'Mood'), h('div', { class: 'tt-chips' }, ...TTRPG_MOODS.map((m) => h('button', { class: `tt-chip${t?.mood === m ? ' on' : ''}`, onClick: () => s.gmDo({ type: 'mood_light', mood: m }) }, m)))),
      h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('label', null, 'Camera'), h('div', { class: 'tt-chips' }, shot('auto', 'Auto'), shot('wide', 'Table'), shot('map', 'Map'), shot('gm', 'GM'), shot('dice', 'Dice'))),
      h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('label', null, 'Combat'), h('button', { class: 'btn', onClick: () => s.gmDo({ type: 'start_combat' }) }, t?.init.on ? 'Reroll initiative' : 'Roll initiative'),
        h('button', { class: 'btn', disabled: !t?.init.on, onClick: () => s.gmDo({ type: 'next_turn' }) }, 'Next turn'), h('button', { class: 'btn ghost', disabled: !t?.init.on, onClick: () => s.gmDo({ type: 'end_combat' }) }, 'End')),
      h('div', { class: 'tt-row', style: 'margin-top:10px' }, npc, say, h('button', { class: 'btn', onClick: () => { const text = say.value.trim(); if (!text) return; if (npc.value.trim()) s.gmDo({ type: 'npc_say', name: npc.value.trim(), text }); else s.narrate(text); say.value = ''; } }, 'Say')),
      h('div', { style: 'margin-top:10px' }, h('div', { class: 'tt-row' }, hT, hS), h('div', { class: 'tt-field', style: 'margin-top:6px' }, hX),
        h('div', { class: 'tt-row' }, h('button', { class: 'btn', onClick: () => s.gmDo({ type: 'show_handout', title: hT.value || 'Handout', text: hX.value, style: hS.value as 'note' }) }, 'Show handout'), h('button', { class: 'btn ghost', onClick: () => img.click() }, 'Show an image…'), img)),
      t?.tokens.length ? h('div', { style: 'margin-top:10px' }, h('h3', null, 'On the map'), ...t.tokens.filter((k) => k.kind !== 'pc').slice(0, 20).map((k) => h('div', { class: 'tt-atk' }, h('span', null, `${k.name}${k.hp ? ` (${k.hp[0]}/${k.hp[1]})` : ''}${k.dead ? ', down' : ''}`),
        h('button', { class: 'btn', title: 'Take 1 HP', onClick: () => s.gmDo({ type: 'damage', who: k.name, amount: 1 }) }, '−1'), h('button', { class: 'btn ghost', title: 'Remove', onClick: () => s.gmDo({ type: 'remove_token', who: k.name }) }, '✕')))) : null);
  }

  // ---------------------------------------------------------------- setup (host)
  private setupTab() {
    const s = this.s, b = this.body, g = s.game;
    if (g) {
      const lineIn = h('input', { type: 'text', placeholder: 'Add a line (never happens)' }) as HTMLInputElement;
      const veilIn = h('input', { type: 'text', placeholder: 'Add a veil (off-screen only)' }) as HTMLInputElement;
      b.append(h('div', { class: 'tt-card' }, h('h3', null, 'Rules, content and safety'),
        h('div', { class: 'tt-row' }, h('label', null, 'Rules'), h('div', { class: 'seg' }, ...([['5e', '5e-compatible'], ['generic', 'Rules-light']] as const).map(([v, l]) => h('button', { class: g.system === v ? 'on' : '', onClick: () => s.setSystem(v) }, l)))),
        h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('label', null, 'Content'), h('div', { class: 'seg' }, ...RATINGS.map((r) => h('button', { class: g.ai.rating === r.id ? 'on' : '', title: r.rule, onClick: () => s.setAi({ rating: r.id }) }, r.name)))),
        h('p', { class: 'hint' }, RATINGS.find((r) => r.id === g.ai.rating)?.rule ?? ''),
        h('div', { class: 'tt-field', style: 'margin-top:6px' }, h('span', null, 'Lines: things that never appear'), h('div', { class: 'tt-chips' }, ...g.ai.lines.map((l) => h('button', { class: 'tt-chip bad', title: 'Remove', onClick: () => s.setAi({ lines: g.ai.lines.filter((x) => x !== l) }) }, l))),
          h('div', { class: 'tt-row' }, lineIn, h('button', { class: 'btn', onClick: () => { const v = lineIn.value.trim(); if (v) s.setAi({ lines: [...g.ai.lines, v].slice(0, 20) }); } }, 'Add'))),
        h('div', { class: 'tt-field' }, h('span', null, 'Veils: things that only happen off-screen'), h('div', { class: 'tt-chips' }, ...g.ai.veils.map((l) => h('button', { class: 'tt-chip', title: 'Remove', onClick: () => s.setAi({ veils: g.ai.veils.filter((x) => x !== l) }) }, l))),
          h('div', { class: 'tt-row' }, veilIn, h('button', { class: 'btn', onClick: () => { const v = veilIn.value.trim(); if (v) s.setAi({ veils: [...g.ai.veils, v].slice(0, 20) }); } }, 'Add'))),
        h('p', { class: 'hint' }, 'Everyone at the table can tap ✕ (the X-card) at any time: the voice stops, the stream captions grey out and the GM rewinds the last description.')));
      b.append(h('div', { class: 'tt-card' }, h('h3', null, 'On the stream'),
        toggleRow('Captions of the GM and NPCs', g.table.overlay.captions, (v) => s.setOverlay({ captions: v })),
        toggleRow('A card for each roll', g.table.overlay.rolls, (v) => s.setOverlay({ rolls: v })),
        toggleRow('Initiative order in combat', g.table.overlay.init, (v) => s.setOverlay({ init: v }))));
    }
    b.append(this.aiCard());
    b.append(this.bridgeCard());
    b.append(this.campaignCard());
    b.append(h('div', { class: 'tt-card' }, h('h3', null, 'About the rules'), h('p', { class: 'tt-srd' }, SRD_ATTRIBUTION), h('p', { class: 'tt-srd' }, 'Adventure seeds, rules-light archetypes, maps, dice and the GM characters are original VTube Pro content.')));
  }

  private aiCard() {
    const c = this.cfg;
    if (!c) return h('div', { class: 'tt-card' }, h('h3', null, 'AI Game Master'), h('p', { class: 'hint' }, this.cfgErr || 'Loading…'));
    const model = h('input', { type: 'text', value: c.model ?? '', list: 'tt-models', placeholder: 'e.g. qwen3:8b', onChange: (e: Event) => void this.saveCfg({ model: (e.target as HTMLInputElement).value.trim() }) }) as HTMLInputElement;
    return h('div', { class: 'tt-card' }, h('h3', null, 'AI Game Master'),
      h('p', { class: 'hint' }, 'The Game Master is a model that runs on this PC: Ollama, LM Studio, llama.cpp or KoboldCpp. It is free and nothing leaves your computer. Quality depends on the model (8B or bigger is recommended).'),
      h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('label', null, 'Server'), h('select', { onChange: (e: Event) => { const kind = (e.target as HTMLSelectElement).value; const urls: Record<string, string> = { ollama: 'http://127.0.0.1:11434/v1', lmstudio: 'http://127.0.0.1:1234/v1', llamacpp: 'http://127.0.0.1:8080/v1', koboldcpp: 'http://127.0.0.1:5001/v1', other: c.local.url }; void this.saveCfg({ local: { kind, url: urls[kind] } }); } },
        ...([['ollama', 'Ollama'], ['lmstudio', 'LM Studio'], ['llamacpp', 'llama.cpp server'], ['koboldcpp', 'KoboldCpp'], ['other', 'Other OpenAI-compatible (on this PC)']] as const).map(([v, l]) => h('option', { value: v, selected: v === c.local.kind }, l)))),
      h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('label', null, 'URL'), h('input', { type: 'url', value: c.local.url, onChange: (e: Event) => void this.saveCfg({ local: { url: (e.target as HTMLInputElement).value.trim() } }) })),
      h('p', { class: 'hint' }, 'The address must be on this PC (it starts with http://127.0.0.1 or http://localhost).'),
      h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('label', null, 'Model'), model, h('datalist', { id: 'tt-models' }, ...this.models.map((m) => h('option', { value: m }))),
        h('button', { class: 'btn ghost', onClick: async () => { try { const r = await api.get<{ models: string[] }>('/api/ttrpg/models'); this.models = r.models; toast(`${r.models.length} models`, 'ok', 1400); } catch (e) { toast((e as Error).message, 'err'); } this.render(); } }, 'Find models')),
      h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('button', { class: 'btn primary', onClick: async () => { this.test = { ok: true, text: 'Testing…' }; this.render(); try { const r = await apiJson<{ ok: boolean; reply: string; ms: number; error?: string; models: string[] }>('POST', '/api/ttrpg/test', { model: c.model }); this.test = { ok: r.ok, text: r.ok ? `Connected in ${(r.ms / 1000).toFixed(1)} s: “${r.reply}”` : r.error ?? 'Failed' }; if (r.models?.length) this.models = r.models; } catch (e) { this.test = { ok: false, text: (e as Error).message }; } this.render(); } }, 'Test connection'),
        this.test ? h('span', { class: 'hint', style: `color:var(${this.test.ok ? '--ok' : '--err'})` }, this.test.text) : null),
      h('div', { class: 'tt-row', style: 'margin-top:8px' }, h('label', null, 'Limits'), h('span', { class: 'hint' }, 'at most'), h('input', { type: 'number', min: 1, max: 60, value: c.limits.perMinute, style: 'width:56px;flex:none', onChange: (e: Event) => void this.saveCfg({ limits: { perMinute: +(e.target as HTMLInputElement).value } }) }), h('span', { class: 'hint' }, 'turns a minute')),
      h('h3', { style: 'margin-top:12px' }, 'Voice and speech-to-text'),
      h('div', { class: 'tt-row' }, h('label', null, 'Voice server'), h('select', { onChange: (e: Event) => void this.saveCfg({ tts: { provider: (e.target as HTMLSelectElement).value } }) }, ...([['browser', 'None (browser voice)'], ['local', 'A voice server on this PC (OpenAI-compatible, e.g. Kokoro)']] as const).map(([v, l]) => h('option', { value: v, selected: c.tts.provider === v }, l)))),
      c.tts.provider !== 'browser' ? h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('label', null, 'Voice'), h('input', { type: 'text', value: c.tts.voice, style: 'max-width:110px', onChange: (e: Event) => void this.saveCfg({ tts: { voice: (e.target as HTMLInputElement).value } }) }),
        h('input', { type: 'text', value: c.tts.model, onChange: (e: Event) => void this.saveCfg({ tts: { model: (e.target as HTMLInputElement).value } }) })) : null,
      c.tts.provider === 'local' ? h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('label', null, 'TTS URL'), h('input', { type: 'url', value: c.tts.url, onChange: (e: Event) => void this.saveCfg({ tts: { url: (e.target as HTMLInputElement).value } }) })) : null,
      h('div', { class: 'tt-row', style: 'margin-top:6px' }, h('label', null, 'Hold to talk'), h('select', { onChange: (e: Event) => { localStorage.setItem('vtp.ttrpg.stt', (e.target as HTMLSelectElement).value === 'browser' ? 'browser' : 'server'); void this.saveCfg({ stt: { provider: (e.target as HTMLSelectElement).value } }); } },
        ...([['browser', 'Browser speech recognition'], ['local', 'Local whisper server']] as const).map(([v, l]) => h('option', { value: v, selected: c.stt.provider === v }, l)))),
      h('p', { class: 'hint' }, c.stt.provider === 'browser' ? 'Chrome and Edge send the recording to their own speech service. Pick a local whisper server to keep it on your PC.' : 'Recordings go from this PC’s server to your whisper server on this PC only while you hold the button.'));
  }

  private bridgeCard() {
    const c = this.cfg;
    const s = this.s;
    if (!c) return h('div');
    const base = 'http://127.0.0.1:5191';
    return h('div', { class: 'tt-card' }, h('h3', null, 'Play with a VTT (Foundry, Owlbear Rodeo, Roll20)'),
      toggleRow('Let VTT add-ons on this PC send rolls, chat, initiative and tokens', c.bridge.enabled, (v) => void this.saveCfg({ bridge: { enabled: v } })),
      c.bridge.enabled ? h('div', { class: 'tt-kv', style: 'margin-top:6px' },
        h('span', null, 'Pairing code'), h('span', null, h('b', null, c.bridge.code), ' ', h('button', { class: 'btn link', onClick: () => void navigator.clipboard?.writeText(c.bridge.code).then(() => toast('Copied', 'ok', 1200)) }, 'copy'), ' ', h('button', { class: 'btn link', onClick: () => { if (confirm('Make a new code? Connected add-ons must be paired again.')) void this.saveCfg({ bridge: { newToken: true } }); } }, 'new code')),
        h('span', null, 'Foundry VTT'), h('span', null, `Install Module → Manifest URL: ${base}/vtt/foundry/vtube-pro-bridge/module.json`),
        h('span', null, 'Owlbear Rodeo'), h('span', null, `Extensions → Add custom: ${base}/vtt/owlbear/manifest.json`),
        h('span', null, 'Roll20'), h('span', null, `Tampermonkey / Violentmonkey: ${base}/vtt/roll20/vtube-pro-roll20.user.js`),
        h('span', null, 'Connected'), h('span', null, s.vtt.clients.length ? s.vtt.clients.map((x) => `${x.name} (${x.src})`).join(', ') : 'nothing yet')) : null,
      h('p', { class: 'hint' }, 'Read-only mirrors: the VTT stays the source of truth, VTube Pro shows its dice on the 3D table, its chat in the log, its initiative and token positions on the map. Nothing logs into anything; the add-ons run in your own browser. Details: docs/TTRPG.md.'));
  }

  focusComposer() { (this.body.querySelector('.tt-composer textarea') as HTMLTextAreaElement | null)?.focus(); }
}

// ---------------------------------------------------------------- bits
function toggleRow(label: string, on: boolean, set: (v: boolean) => void) {
  return h('label', { class: 'row toggle', style: 'display:flex;justify-content:space-between;gap:10px;margin-top:6px;cursor:pointer' }, h('span', { class: 'lbl', style: 'color:var(--text);font-size:12.5px' }, label),
    h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: on, onChange: (e: Event) => set((e.target as HTMLInputElement).checked) }), h('i')));
}
async function apiJson<T>(method: string, url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `${r.status}`);
  return j as T;
}
function download(name: string, text: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name.replace(/[^\w .-]/g, '_'); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function hashStr(s: string) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return x; }
async function shrink(f: File, max: number): Promise<string> {
  const img = await createImageBitmap(f);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
export { d20Icon, ABILITIES };
