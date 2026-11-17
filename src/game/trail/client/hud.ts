// The Trail — HUD (DOM over the canvas): status strip, party, trail map, vote card, event / death cards, stop panel,
// toasts, prompts, store catalogue, epitaph editor, lobby, end screen (score + graveyard), help. Theme = deck palette.
// Spectator mode (OBS) shows the stream-friendly subset, bigger.
import type { DeckLite } from './decklite.ts';
import type { GameState, Member, PlayerInfo, RunState, VoteState } from '../../../../shared/trail/types.ts';
import type { TrailCmd, TrailEvent } from '../../../../shared/trail/wire.ts';
import { dateOf, healthWord, routeOf } from '../../../../shared/trail/rules.ts';
import { SIZE_ICON } from '../../../../shared/avatarSize.ts';

type El = HTMLElement;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
const esc = (s: string) => s;
/** Drop the null / false children of a replaceChildren call. */
const nn = <T extends Node>(...a: (T | null | undefined | false)[]): T[] => a.filter(Boolean) as T[];
const TIER_LABEL: Record<string, string> = { mild: 'MILD', hilarious: 'HILARIOUS', hard: 'HARD', insane: 'INSANE' };

export interface HudHooks { cmd(c: TrailCmd): void; myId(): string; isHost(): boolean; menu?(): void }

/** The theme pack's UI art (loaded once per theme; `null` = the pack doesn't have it → plain DOM look). */
class UiArt {
  private imgs = new Map<string, HTMLImageElement | null>();
  map: { nodes: { id: string; x: number; y: number }[] } | null = null;
  constructor(readonly theme: string, private onLoad: () => void) {
    for (const rel of ['logo.png', 'map.png', 'card_frame.png', 'tombstone_bg.png', ...ICONS.map((i) => `icons/${i}.png`)]) this.load(rel);
    fetch(this.url('map.json')).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && Array.isArray(j.nodes)) { this.map = { nodes: (j.nodes as { id: unknown; x: unknown; y: unknown }[]).slice(0, 40).map((n) => ({ id: String(n.id), x: Number(n.x) || 0, y: Number(n.y) || 0 })) }; this.onLoad(); } }).catch(() => {});
  }
  url(rel: string) { return `/api/trail/${encodeURIComponent(this.theme)}/file/ui/${rel.split('/').map(encodeURIComponent).join('/')}`; }
  private load(rel: string) {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => { this.imgs.set(rel, im); this.onLoad(); };
    im.onerror = () => this.imgs.set(rel, null);
    im.src = this.url(rel);
  }
  img(rel: string): HTMLImageElement | null { return this.imgs.get(rel) ?? null; }
  /** An <img> icon element (or null when the pack has none). */
  icon(id: string, cls = 'tr-ico'): HTMLImageElement | null {
    const src = this.img(`icons/${id}.png`);
    if (!src) return null;
    const e = document.createElement('img'); e.className = cls; e.src = src.src; e.alt = ''; e.draggable = false;
    return e;
  }
}
const ICONS = ['food', 'clothes', 'ammo', 'medicine', 'wheel', 'axle', 'tongue', 'draft', 'money', 'health', 'sick', 'dead', 'day', 'weather_clear', 'weather_warm', 'weather_hot', 'weather_rain', 'weather_cold', 'weather_storm',
  'tier_mild', 'tier_hilarious', 'tier_hard', 'tier_insane', 'vote', 'ghost', 'perk_banker', 'perk_carpenter', 'perk_whisperer', 'perk_medic', 'perk_hunter', 'perk_streamer'];

export class Hud {
  readonly root: El;
  private top = h('div', 'tr-top');
  private party = h('div', 'tr-party');
  private map = h('canvas', 'tr-map') as HTMLCanvasElement;
  private stopBox = h('div', 'tr-stop');
  private voteBox = h('div', 'tr-vote');
  private cardBox = h('div', 'tr-card');
  private toasts = h('div', 'tr-toasts');
  private prompt = h('div', 'tr-prompt');
  private cross = h('div', 'tr-cross');
  private modal = h('div', 'tr-modal');
  private talk = h('div', 'tr-talk');
  private banner = h('div', 'tr-banner');
  private lastSig: Record<string, string> = {};
  private deck: DeckLite | null = null;
  private art: UiArt | null = null;
  private tabOpen = false;
  private mapBig = false;
  private epitaphOpen = false;
  state: GameState | null = null;
  helpVisible = false;

  constructor(parent: El, private hooks: HudHooks, readonly spectator = false) {
    injectCss();
    this.root = h('div', `tr-hud${spectator ? ' tr-spect' : ''}`, this.top, this.party, this.map, this.stopBox, this.voteBox, this.cardBox, this.toasts, this.prompt, this.cross, this.talk, this.banner, this.modal);
    parent.append(this.root);
    this.map.width = 520; this.map.height = 200;
    new ResizeObserver(() => this.root.classList.toggle('narrow', this.root.clientWidth < 1180)).observe(this.root);
  }
  setDeck(d: DeckLite) {
    this.deck = d;
    const p = d.palette;
    const s = this.root.style;
    s.setProperty('--tr-bg', p.bg ?? '#141414'); s.setProperty('--tr-panel', p.panel ?? '#1f1f1f'); s.setProperty('--tr-ink', p.ink ?? '#fff');
    s.setProperty('--tr-accent', p.accent ?? '#e8a33d'); s.setProperty('--tr-accent2', p.accent2 ?? '#7fb8d6'); s.setProperty('--tr-danger', p.danger ?? '#e0523d'); s.setProperty('--tr-good', p.good ?? '#8fd16a');
    this.lastSig = {};
    if (this.art?.theme !== d.id) {
      let t = 0;
      this.art = new UiArt(d.id, () => { clearTimeout(t); t = window.setTimeout(() => this.artChanged(), 120); });
    }
  }
  /** Some theme art arrived: re-render everything that uses it. */
  private artChanged() {
    const a = this.art;
    if (!a) return;
    const frame = a.img('card_frame.png'), tomb = a.img('tombstone_bg.png');
    this.root.style.setProperty('--tr-frame', frame ? `url("${frame.src}")` : 'none');
    this.root.style.setProperty('--tr-tomb', tomb ? `url("${tomb.src}")` : 'none');
    this.root.classList.toggle('has-frame', !!frame);
    this.lastSig = {};
  }
  get typing() { return this.epitaphOpen || (document.activeElement instanceof HTMLInputElement) || (document.activeElement instanceof HTMLSelectElement); }
  get catalogueOpen() { return this.tabOpen; }
  setTab(on: boolean) { this.tabOpen = on; this.lastSig.modal = ''; }
  toggleMap() { this.mapBig = !this.mapBig; this.map.classList.toggle('big', this.mapBig); }
  setPrompt(s: string) { if (this.prompt.textContent !== s) { this.prompt.textContent = s; this.prompt.style.display = s ? '' : 'none'; } }
  setCrosshair(kind: '' | 'dot' | 'grab' | 'aim') { this.cross.className = `tr-cross ${kind}`; }
  openEpitaph() { if (this.state && this.state.epitaphs[this.hooks.myId()]) { this.epitaphOpen = true; this.lastSig.modal = ''; } }

  // ---------------------------------------------------------------- events
  event(e: TrailEvent) {
    if (e.e === 'toast') this.toast(e.text, e.tone ?? 'info');
    else if (e.e === 'talk') { if (e.to === this.hooks.myId() || this.spectator) this.showTalk(e.name, e.line); }
    else if (e.e === 'death') { this.toast(`☠ ${e.name} — ${e.cause}`, 'bad'); if (e.id === this.hooks.myId()) { this.epitaphOpen = true; this.lastSig.modal = ''; } }
    else if (e.e === 'photo') this.flashBanner(`📸 ${e.names.join(' · ')}`);
    else if (e.e === 'swap') this.flashBanner('🔀 SOUL SWAP!');
  }
  toast(text: string, tone: string) {
    const t = h('div', `tr-toast ${tone}`, text);
    this.toasts.prepend(t);
    while (this.toasts.children.length > (this.spectator ? 4 : 6)) this.toasts.lastChild?.remove();
    setTimeout(() => t.classList.add('out'), 5200);
    setTimeout(() => t.remove(), 6000);
  }
  private showTalk(name: string, line: string) {
    this.talk.replaceChildren(h('b', '', name), h('span', '', `“${line}”`));
    this.talk.classList.add('on');
    clearTimeout((this.talk as unknown as { t?: number }).t);
    (this.talk as unknown as { t?: number }).t = window.setTimeout(() => this.talk.classList.remove('on'), 5500);
  }
  private flashBanner(s: string) {
    this.banner.textContent = s; this.banner.classList.add('on');
    setTimeout(() => this.banner.classList.remove('on'), 2600);
  }

  // ---------------------------------------------------------------- per frame (cheap: rebuilds only on change)
  update(st: GameState, now: number, hostNowMs: number) {
    this.state = st;
    const d = this.deck;
    if (!d) return;
    const run = st.run;
    this.renderTop(st, run, d);
    this.renderParty(st, run, d);
    this.renderMap(st, run, d);
    this.renderStop(st, hostNowMs);
    this.renderVote(st.vote, st, hostNowMs, d);
    this.renderCard(st, hostNowMs);
    this.renderModal(st, run, d);
    void now;
  }
  private sig(k: string, v: string): boolean { if (this.lastSig[k] === v) return false; this.lastSig[k] = v; return true; }

  private renderTop(st: GameState, run: RunState | null, d: DeckLite) {
    const next = run ? routeOf(run, d as never)[run.node] : null;
    const health = run ? healthWord(avgHealth(run)) : '';
    const weather = run ? d.weather.find((w) => w.id === run.weather)?.name ?? run.weather : '';
    const s = JSON.stringify([st.phase, run?.day, Math.round(run?.miles ?? 0), Math.round(run?.food ?? 0), run?.money, health, weather, next?.id, run?.pace, run?.rations, st.rolling, run?.draft, run?.items.ammo]);
    if (!this.sig('top', s)) return;
    const a = this.art;
    const chip = (label: string, value: string, cls = '', icon = '') => { const ic = icon ? a?.icon(icon) : null; const e = h('div', `tr-chip ${cls} ${ic ? 'ic' : ''}`, ic, h('div', 'tr-cv', ic ? null : h('small', '', label), h('b', '', value))); e.title = label; return e; };
    const logo = a?.img('logo.png');
    const kids: Node[] = [logo ? (() => { const i = h('img', 'tr-logo') as HTMLImageElement; i.src = logo.src; i.alt = d.text.title ?? d.name; return i; })() : h('div', 'tr-title', d.text.title ?? d.name)];
    if (run) {
      kids.push(chip('Date', dateOf(run, d as never), 'k-date', 'day'), chip('Weather', weather, '', `weather_${run.weather}`), chip('Health', health, health === 'good' ? 'good' : health === 'fair' ? '' : 'bad', health === 'good' || health === 'fair' ? 'health' : 'sick'),
        chip('Food', `${Math.round(run.food)} lbs`, run.food < 60 ? 'bad' : '', 'food'), chip(d.currency.name, `${d.currency.sym}${run.money}`, '', 'money'),
        chip(d.text.draft ?? 'Oxen', String(run.draft), run.draft < 2 ? 'bad' : '', 'draft'), chip(d.text.ammoUnit ?? 'Ammo', String(run.items.ammo), '', 'ammo'),
        chip(`Next · ${run.pace} · ${run.rations}`, next ? `${next.name} · ${Math.max(0, Math.round(next.miles - run.miles))} mi` : '—', 'k-next'));
      if (st.phase === 'travel') kids.push(h('div', `tr-rolling ${st.rolling ? 'on' : ''}`, st.rolling ? '▶ rolling' : '❚❚ halted'));
    } else kids.push(chip('Seed', st.seed), chip('Players', String(st.players.filter((p) => p.connected).length)));
    this.top.replaceChildren(...kids);
  }

  private renderParty(st: GameState, run: RunState | null, d: DeckLite) {
    const boss = run ? run.order[run.bossIdx % Math.max(1, run.order.length)] : '';
    const s = JSON.stringify([st.players.map((p) => [p.id, p.name, p.role, p.connected, p.ready, p.cls]), run ? Object.values(run.party).map((m) => [m.id, Math.round(m.health), m.alive, m.ghost, m.conds.map((c) => c.id).join()]) : 0, boss]);
    if (!this.sig('party', s)) return;
    const rows = st.players.map((p) => {
      const m: Member | undefined = run?.party[p.id];
      const hp = m ? Math.round(m.health) : 100;
      const dead = m && !m.alive;
      const conds = m?.conds.map((c) => d.conds[c.id]?.name ?? c.id).join(', ') ?? '';
      return h('div', `tr-member ${dead ? 'dead' : ''} ${m?.ghost && !dead ? 'ghost' : ''} ${p.connected ? '' : 'away'}`,
        h('i', 'tr-dot', ''),
        h('div', 'tr-mname', h('b', '', this.art?.icon(dead ? 'dead' : m?.ghost ? 'ghost' : `perk_${p.role}`, 'tr-pico') ?? '', `${p.id === boss ? '👑 ' : ''}${p.name}${p.id === this.hooks.myId() ? ' (you)' : ''}`), h('small', '', `${SIZE_ICON[p.cls] ?? ''} ${p.cls} · ${d.roles[p.role]?.name ?? p.role}${conds ? ` · ${conds}` : ''}${dead ? ` · ☠ ${m?.diedOf}` : ''}`)),
        h('div', 'tr-hp', h('i', '', '')));
    });
    rows.forEach((r, i) => {
      const p = st.players[i], m = run?.party[p.id];
      (r.querySelector('.tr-dot') as El).style.background = p.color;
      (r.querySelector('.tr-hp i') as El).style.width = `${m ? Math.max(0, m.health) : 100}%`;
      (r.querySelector('.tr-hp i') as El).style.background = !m || m.health > 70 ? 'var(--tr-good)' : m.health > 30 ? 'var(--tr-accent)' : 'var(--tr-danger)';
    });
    this.party.replaceChildren(...rows);
  }

  private renderMap(st: GameState, run: RunState | null, d: DeckLite) {
    const s = JSON.stringify([run ? Math.round(run.miles) : -1, run?.node, run?.graves.length, this.mapBig]);
    if (!this.sig('map', s)) return;
    this.map.style.display = run ? '' : 'none';
    if (!run) return;
    const route = routeOf(run, d as never);
    const c = this.map, g = c.getContext('2d')!;
    const art = this.art, mapImg = art?.img('map.png'), mapNodes = art?.map?.nodes;
    if (mapImg && mapNodes && route.every((n) => mapNodes.some((m) => m.id === n.id))) { this.drawArtMap(run, d, route, mapImg, mapNodes); return; }
    if (c.height !== 200) { c.width = 520; c.height = 200; }
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(10,12,14,0.72)'; roundRect(g, 0, 0, W, H, 18); g.fill();
    const x = (mi: number) => 30 + (mi / run.total) * (W - 60);
    const y = (i: number) => H * 0.52 + Math.sin(i * 1.7 + 0.6) * H * 0.18;
    const pts = route.map((n, i) => [x(n.miles), y(i)] as const);
    g.lineWidth = 6; g.lineCap = 'round'; g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke();
    // travelled
    g.strokeStyle = getComputedStyle(this.root).getPropertyValue('--tr-accent') || '#e8a33d';
    g.beginPath();
    let wx = pts[0][0], wy = pts[0][1];
    for (let i = 0; i < route.length; i++) {
      const [px, py] = pts[i];
      if (route[i].miles <= run.miles) { i ? g.lineTo(px, py) : g.moveTo(px, py); wx = px; wy = py; }
      else { const a = route[i - 1], k = (run.miles - a.miles) / (route[i].miles - a.miles); wx = pts[i - 1][0] + (px - pts[i - 1][0]) * k; wy = pts[i - 1][1] + (py - pts[i - 1][1]) * k; g.lineTo(wx, wy); break; }
    }
    g.stroke();
    g.font = '700 15px Bahnschrift, Segoe UI, sans-serif'; g.textAlign = 'center';
    route.forEach((n, i) => {
      const [px, py] = pts[i];
      g.fillStyle = n.kind === 'river' ? '#5ab8ff' : n.kind === 'end' ? '#ffd23f' : n.kind === 'landmark' ? '#ff7ad8' : '#ffffff';
      g.beginPath(); g.arc(px, py, n.kind === 'end' ? 9 : 7, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillText(n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name, px, py + (i % 2 ? 26 : -16));
    });
    for (const gr of [...run.oldGraves, ...run.graves]) { const gx = x(gr.mile); g.fillStyle = '#c9c9c9'; g.fillText('✝', gx, H * 0.2); }
    // the wagon
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(wx, wy, 11, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#222'; g.font = '16px sans-serif'; g.fillText(d.id === 'bayou' ? '🐸' : d.id === 'skyisles' ? '🪽' : '🐂', wx, wy + 6);
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = '600 13px Bahnschrift, sans-serif'; g.textAlign = 'left';
    g.fillText(`${Math.round(run.miles)} / ${run.total} miles · day ${run.day}`, 16, H - 14);
  }

  /** trailart's illustrated map (map.png + map.json node positions): travelled path, wagon marker, graves on top. */
  private drawArtMap(run: RunState, d: DeckLite, route: ReturnType<typeof routeOf>, img: HTMLImageElement, nodes: { id: string; x: number; y: number }[]) {
    const c = this.map;
    if (c.width !== 640 || c.height !== 320) { c.width = 640; c.height = 320; }
    const g = c.getContext('2d')!, W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.save(); roundRect(g, 0, 0, W, H, 22); g.clip(); g.drawImage(img, 0, 0, W, H); g.restore();
    const pos = (id: string) => { const n = nodes.find((m) => m.id === id)!; return [n.x * W, n.y * H] as const; };
    const pts = route.map((n) => pos(n.id));
    const acc = getComputedStyle(this.root).getPropertyValue('--tr-accent') || '#e8a33d';
    g.lineCap = 'round'; g.lineJoin = 'round';
    // the route still ahead: dashed; travelled: solid accent with a dark casing
    g.setLineDash([10, 9]); g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke(); g.setLineDash([]);
    let wx = pts[0][0], wy = pts[0][1];
    const trail: [number, number][] = [[wx, wy]];
    for (let i = 1; i < route.length; i++) {
      const [px, py] = pts[i];
      if (route[i].miles <= run.miles) { trail.push([px, py]); wx = px; wy = py; }
      else { const a = route[i - 1], k = Math.max(0, Math.min(1, (run.miles - a.miles) / Math.max(1, route[i].miles - a.miles))); wx = pts[i - 1][0] + (px - pts[i - 1][0]) * k; wy = pts[i - 1][1] + (py - pts[i - 1][1]) * k; trail.push([wx, wy]); break; }
    }
    for (const [w, col] of [[10, 'rgba(0,0,0,0.55)'], [6, acc]] as const) { g.lineWidth = w; g.strokeStyle = col; g.beginPath(); trail.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke(); }
    g.font = '800 15px Bahnschrift, Segoe UI, sans-serif'; g.textAlign = 'center';
    route.forEach((n, i) => {
      const [px, py] = pts[i];
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.beginPath(); g.arc(px, py, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = n.miles <= run.miles ? acc : '#ffffff'; g.beginPath(); g.arc(px, py, 6, 0, Math.PI * 2); g.fill();
      g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.fillStyle = '#fff';
      const label = n.name.length > 20 ? n.name.slice(0, 19) + '…' : n.name, ly = py + (py < H * 0.5 ? 26 : -16);
      g.strokeText(label, px, ly); g.fillText(label, px, ly);
    });
    // graves along the way (this run's + earlier runs')
    const at = (mi: number): [number, number] => { for (let i = 1; i < route.length; i++) if (route[i].miles >= mi) { const a = route[i - 1], k = (mi - a.miles) / Math.max(1, route[i].miles - a.miles); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]; } return pts[pts.length - 1] as [number, number]; };
    g.font = '16px sans-serif';
    for (const gr of [...run.oldGraves, ...run.graves]) { const [gx, gy] = at(gr.mile); g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillText('✝', gx + 1, gy - 9); g.fillStyle = '#e8e8e8'; g.fillText('✝', gx, gy - 10); }
    // the wagon
    const draft = this.art?.img('icons/draft.png');
    g.fillStyle = '#fff'; g.beginPath(); g.arc(wx, wy, 15, 0, Math.PI * 2); g.fill();
    g.lineWidth = 3; g.strokeStyle = acc; g.stroke();
    if (draft) g.drawImage(draft, wx - 13, wy - 13, 26, 26);
    g.fillStyle = 'rgba(0,0,0,0.6)'; roundRect(g, 10, H - 34, 250, 24, 10); g.fill();
    g.fillStyle = '#fff'; g.font = '700 14px Bahnschrift, sans-serif'; g.textAlign = 'left';
    g.fillText(`${Math.round(run.miles)} / ${run.total} miles · day ${run.day}`, 20, H - 17);
    void d;
  }

  private renderStop(st: GameState, hostNowMs: number) {
    const s = st.stop;
    const left = s?.endsAt ? Math.max(0, Math.ceil((s.endsAt - hostNowMs) / 1000)) : -1;
    const key = JSON.stringify([s?.kind, s?.title, s?.objective, s?.notes, left, s?.ready.length, st.players.length]);
    if (!this.sig('stop', key)) return;
    this.stopBox.style.display = s ? '' : 'none';
    if (!s) return;
    const obj = s.objective;
    const pct = obj && obj.goal ? Math.min(100, (obj.progress / obj.goal) * 100) : 0;
    const humans = st.players.filter((p) => p.connected && !p.bot).length;
    const notes = s.notes.filter((n) => !n.startsWith('goal:'));
    this.stopBox.replaceChildren(...nn(
      h('div', 'tr-stop-title', h('b', '', s.title), left >= 0 ? h('span', `tr-timer ${left <= 10 ? 'hot' : ''}`, `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`) : null),
      obj ? h('div', 'tr-obj', obj.label) : null,
      obj && obj.goal ? h('div', 'tr-bar', h('i', '', '')) : null,
      notes.length ? h('div', 'tr-notes', notes.join(' · ')) : null,
      !this.spectator && (s.kind === 'store' || s.kind === 'landmark' || s.kind === 'camp' || s.kind === 'finish') ? h('div', 'tr-ready', `Enter = ready (${s.ready.length}/${humans})${this.hooks.isHost() ? ' · host: Enter = continue' : ''}${s.kind === 'store' ? ' · Tab = catalogue' : ''}`) : null,
    ));
    const bar = this.stopBox.querySelector('.tr-bar i') as El | null;
    if (bar) bar.style.width = `${pct}%`;
  }

  private renderVote(v: VoteState | null, st: GameState, hostNowMs: number, d: DeckLite) {
    const left = v ? Math.max(0, (v.endsAt - hostNowMs) / 1000) : 0;
    const key = JSON.stringify([v?.id, v?.votes, v?.options, v?.chat, Math.ceil(left)]);
    if (!this.sig('vote', key)) { const bar = this.voteBox.querySelector('.tr-vtime i') as El | null; if (bar && v) bar.style.width = `${Math.min(100, left / 15 * 100)}%`; return; }
    this.voteBox.style.display = v ? '' : 'none';
    if (!v) return;
    const me = this.hooks.myId();
    const byOpt = new Map<string, PlayerInfo[]>();
    for (const [pid, opt] of Object.entries(v.votes)) { const p = st.players.find((x) => x.id === pid); if (p) byOpt.set(opt, [...(byOpt.get(opt) ?? []), p]); }
    const opts = v.options.map((o, i) => {
      const who = byOpt.get(o.id) ?? [];
      const b = h('button', `tr-opt ${v.votes[me] === o.id ? 'mine' : ''} ${o.disabled ? 'off' : ''}`,
        h('kbd', '', String(i + 1)), h('div', 'tr-otext', h('b', '', o.label), o.hint || o.disabled ? h('small', '', o.disabled ? `✕ ${o.disabled}` : o.hint ?? '') : null),
        h('div', 'tr-chips', ...who.map((p) => { const c = h('i', 'tr-vchip', p.name.slice(0, 1).toUpperCase()); c.style.background = p.color; c.title = p.name; return c; }), v.chat?.[o.id] ? h('i', 'tr-vchip chat', `💬${v.chat[o.id]}`) : null));
      if (!this.spectator) b.onclick = () => this.hooks.cmd({ c: 'vote', opt: o.id });
      return b;
    });
    this.voteBox.replaceChildren(...nn<HTMLElement>(
      h('div', 'tr-vhead', v.tier ? h('span', `tr-tier ${v.tier}`, TIER_LABEL[v.tier]) : null, h('b', '', v.title)),
      h('p', '', v.text),
      h('div', 'tr-opts', ...opts),
      h('div', 'tr-vtime', h('i', '', '')),
      h('small', 'tr-vfoot', `Press 1–${v.options.length} · ties: ${st.players.find((p) => p.id === v.boss)?.name ?? 'fate'} decides${st.lobby.chatVotes ? ' · chat: !1…!' + v.options.length : ''}`),
      // the halt menu also holds the way out
      v.id === 'halt' && !this.spectator && this.hooks.menu ? (() => { const b = h('button', 'tr-btn small tr-quit', this.hooks.isHost() ? '⏹ End game for everyone…' : '🚪 Leave game…'); b.onclick = () => this.hooks.menu?.(); return b; })() : null,
    ));
    const bar = this.voteBox.querySelector('.tr-vtime i') as El;
    bar.style.width = `${Math.min(100, left / 15 * 100)}%`;
    void d;
  }

  private renderCard(st: GameState, hostNowMs: number) {
    const c = st.card;
    const key = JSON.stringify([c?.id]);
    if (!this.sig('card', key)) return;
    this.cardBox.style.display = c ? '' : 'none';
    this.cardBox.className = `tr-card ${c?.big ? 'big' : ''} ${c?.death ? 'death' : ''} ${c?.tier ?? ''}`;
    if (!c) return;
    this.cardBox.replaceChildren(...nn<HTMLElement>(c.tier ? h('span', `tr-tier ${c.tier}`, this.art?.icon(`tier_${c.tier}`, 'tr-tico') ?? null, TIER_LABEL[c.tier]) : h('span', ''), h('h2', '', c.title), h('p', '', c.text), !this.spectator && this.hooks.isHost() ? h('small', '', 'Enter = continue') : null));
    void hostNowMs;
  }

  private renderModal(st: GameState, run: RunState | null, d: DeckLite) {
    const me = this.hooks.myId();
    const mode = st.phase === 'lobby' ? 'lobby' : st.phase === 'end' ? 'end' : this.epitaphOpen && st.epitaphs[me] ? 'epitaph' : this.tabOpen && st.stop?.kind === 'store' ? 'store' : this.tabOpen ? 'party' : this.helpVisible ? 'help' : '';
    if (this.epitaphOpen && !st.epitaphs[me]) this.epitaphOpen = false;
    const key = JSON.stringify([mode, mode === 'lobby' ? [st.players, st.lobby, st.seed] : mode === 'end' ? run?.outcome : mode === 'store' ? run?.money : mode === 'party' ? run?.day : '']);
    if (!this.sig('modal', key)) return;
    this.modal.style.display = mode ? '' : 'none';
    this.modal.className = `tr-modal ${mode}`;
    if (this.spectator && mode !== 'lobby' && mode !== 'end') { this.modal.style.display = 'none'; return; }
    this.modal.classList.toggle('tomb', mode === 'epitaph' || (mode === 'end' && run?.outcome !== 'won'));
    if (mode === 'lobby') this.modal.replaceChildren(this.lobby(st, d));
    else if (mode === 'end') this.modal.replaceChildren(this.endScreen(st, run!, d));
    else if (mode === 'epitaph') this.modal.replaceChildren(this.epitaph(st, d));
    else if (mode === 'store') this.modal.replaceChildren(this.catalogue(run!, d));
    else if (mode === 'party') this.modal.replaceChildren(this.partySheet(st, run, d));
    else if (mode === 'help') this.modal.replaceChildren(helpSheet());
    else this.modal.replaceChildren();
  }
  private lobby(st: GameState, d: DeckLite): El {
    const me = this.hooks.myId(), host = this.hooks.isHost();
    const mine = st.players.find((p) => p.id === me);
    const roleSel = h('select', 'tr-sel') as HTMLSelectElement;
    for (const [id, r] of Object.entries(d.roles)) { const o = h('option', '', `${r.name} — ${r.perk} (${d.currency.sym}${r.money}, score ×${r.mult})`) as HTMLOptionElement; o.value = id; roleSel.append(o); }
    roleSel.value = mine?.role ?? 'banker';
    roleSel.onchange = () => this.hooks.cmd({ c: 'role', role: roleSel.value as never });
    const toggle = (label: string, key: string, on: boolean) => { const b = h('button', `tr-tog ${on ? 'on' : ''}`, `${on ? '☑' : '☐'} ${label}`); b.disabled = !host; b.onclick = () => this.hooks.cmd({ c: 'lobby', key, val: !on }); return b; };
    const mods = ['chaos', 'chill', 'speedrun', 'dysentery_any', 'hardcore', 'mirror'];
    return h('div', 'tr-lobby',
      this.art?.img('logo.png') ? (() => { const i = h('img', 'tr-biglogo') as HTMLImageElement; i.src = this.art!.img('logo.png')!.src; i.alt = d.text.title ?? d.name; return i; })() : h('h1', '', d.text.title ?? d.name), h('p', 'tr-sub', d.text.subtitle ?? ''),
      h('div', 'tr-lobby-cols',
        h('div', 'tr-lcol', h('h3', '', 'The party'), ...st.players.map((p) => h('div', 'tr-lp', h('i', 'tr-dot', ''), h('b', '', p.name), h('small', '', `${SIZE_ICON[p.cls] ?? ''} ${p.height.toFixed(2)} m ${p.cls} · ${d.roles[p.role]?.name ?? p.role}${p.host ? ' · host' : ''}${p.ready ? ' · ✓ ready' : ''}`)))),
        this.spectator ? h('div', 'tr-lcol', h('h3', '', 'Starting soon'), h('p', 'tr-small', `Seed ${st.seed} · ${st.lobby.slice ? 'short run' : 'full run'}${st.lobby.modifiers.length ? ' · ' + st.lobby.modifiers.join(', ') : ''}`)) : h('div', 'tr-lcol', h('h3', '', 'Your role'), roleSel, h('p', 'tr-small', 'Your size is your avatar\'s real size (Avatars → Real size). Micro = fast scout who carries little; macro = forklift with a food problem.'),
          h('h3', '', 'Run'), h('div', 'tr-small', `Seed ${st.seed}`),
          toggle('Vertical slice (short run)', 'slice', st.lobby.slice), toggle('Chat votes (!1…!4)', 'chatVotes', st.lobby.chatVotes), toggle('Allow soul-swap events (consent)', 'chaosConsent', st.lobby.chaosConsent),
          h('div', 'tr-mods', ...mods.map((m) => { const on = st.lobby.modifiers.includes(m); const b = h('button', `tr-tog ${on ? 'on' : ''}`, m.replace('_', ' ')); b.disabled = !host; b.onclick = () => this.hooks.cmd({ c: 'lobby', key: 'modifiers', val: on ? st.lobby.modifiers.filter((x) => x !== m) : [...st.lobby.modifiers, m].slice(-2) }); return b; })))),
      this.spectator ? null : h('div', 'tr-lobby-go', host ? (() => { const b = h('button', 'tr-big', '▶ START THE TRAIL'); b.onclick = () => this.hooks.cmd({ c: 'start' }); return b; })() : h('p', '', 'Waiting for the host to start…'),
        (() => { const b = h('button', 'tr-btn', mine?.ready ? '✓ Ready' : 'Ready'); b.onclick = () => this.hooks.cmd({ c: 'ready', on: !mine?.ready }); return b; })()),
    );
  }
  private endScreen(st: GameState, run: RunState, d: DeckLite): El {
    const sc = run.score;
    const won = run.outcome === 'won';
    return h('div', 'tr-end',
      h('h1', won ? 'win' : 'wipe', won ? (d.text.win ?? 'You made it!').replace('{place}', routeOf(run, d as never).at(-1)?.name ?? '') : d.text.wipe ?? 'Everyone has died.'),
      sc ? h('div', 'tr-score', ...sc.lines.map((l) => h('div', 'tr-sline', h('span', '', l.label), h('b', '', String(l.pts)))), h('div', 'tr-sline tot', h('span', '', `× ${sc.mult} (party role bonus)`), h('b', '', String(sc.total)))) : null,
      sc?.titles.length ? h('div', 'tr-titles', ...sc.titles.map((t) => h('div', 'tr-t', h('b', '', t.title), h('span', '', t.who)))) : null,
      run.graves.length ? h('div', 'tr-graves', h('h3', '', 'Here they lie'), ...run.graves.map((g) => h('div', 'tr-grave', h('b', '', g.name), h('small', '', `mile ${g.mile} · died of ${g.cause}`), h('i', '', `“${g.epitaph || '…'}”`)))) : null,
      this.hooks.isHost() && !this.spectator ? (() => { const b = h('button', 'tr-big', 'Back to the lobby'); b.onclick = () => this.hooks.cmd({ c: 'continue' }); return b; })() : null,
    );
  }
  private epitaph(st: GameState, d: DeckLite): El {
    const inp = h('input', 'tr-in') as HTMLInputElement;
    inp.maxLength = 60; inp.placeholder = 'Your epitaph (60 characters)…';
    const send = () => { this.hooks.cmd({ c: 'epitaph', text: inp.value }); this.epitaphOpen = false; inp.blur(); this.lastSig.modal = ''; };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') send(); if (e.key === 'Escape') { this.epitaphOpen = false; inp.blur(); this.lastSig.modal = ''; } };
    setTimeout(() => inp.focus(), 50);
    const ideas = d.epitaphs.slice(0, 4).map((x) => { const b = h('button', 'tr-btn small', x); b.onclick = () => { inp.value = x; }; return b; });
    const b = h('button', 'tr-big', 'Carve it');
    b.onclick = send;
    void st;
    return h('div', 'tr-epi', h('h2', '', '☠ You died. Write your epitaph.'), inp, h('div', 'tr-ideas', ...ideas), b);
  }
  private catalogue(run: RunState, d: DeckLite): El {
    const items: [string, string][] = [['food', `${d.items.food?.name ?? 'food'} (${d.items.food?.unit ?? 50} lbs)`], ['draft', d.items.draft?.name ?? 'ox'], ['clothes', d.items.clothes?.name ?? 'clothes'], ['ammo', d.items.ammo?.name ?? 'ammo'], ['wheel', d.items.wheel?.name ?? 'spare wheel'], ['axle', d.items.axle?.name ?? 'spare axle'], ['tongue', d.items.tongue?.name ?? 'spare tongue'], ['medicine', d.items.medicine?.name ?? 'medicine'], ['meme', d.items.meme?.name ?? 'meme']];
    return h('div', 'tr-cat', h('h2', '', d.text.storeName ?? 'General Store'), h('p', 'tr-small', `Orders drop on the porch — you still carry them into the ${d.text.wagon}. Animals come hitched. You pay for what's in the ${d.text.wagon} when you leave. ${d.currency.sym}${run.money} to spend.`),
      h('div', 'tr-catgrid', ...items.map(([id, name]) => {
        const price = d.items[id]?.price ?? 10;
        const row = h('div', 'tr-catrow', h('b', '', name), h('span', '', `${d.currency.sym}${price}`));
        for (const n of id === 'food' ? [1, 3] : [1, 2]) { const b = h('button', 'tr-btn small', `+${n}`); b.onclick = () => this.hooks.cmd({ c: 'buy', item: id, n }); row.append(b); }
        return row;
      })));
  }
  private partySheet(st: GameState, run: RunState | null, d: DeckLite): El {
    return h('div', 'tr-sheet', h('h2', '', 'The party'), ...st.players.map((p) => { const m = run?.party[p.id]; return h('div', 'tr-sline', h('span', '', `${p.name} — ${d.roles[p.role]?.name}`), h('b', '', m ? `${healthWord(m.health)} (${Math.round(m.health)})` : '')); }),
      run ? h('p', 'tr-small', `${d.items.clothes?.name}: ${run.items.clothes} · spare wheels ${run.items.wheel} · axles ${run.items.axle} · ${d.items.medicine?.name}: ${run.items.medicine} · ${d.items.meme?.name}: ${run.items.meme ? 'safe' : 'gone'} · morale ${Math.round(run.morale)}`) : null);
  }
}

function avgHealth(run: RunState) { const l = Object.values(run.party).filter((m) => m.alive && !m.ghost); return l.length ? l.reduce((a, m) => a + m.health, 0) / l.length : 0; }
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function helpSheet(): El {
  const rows = [['WASD', 'move'], ['Mouse', 'look (click to capture)'], ['Space / Shift', 'jump / sprint'], ['Left mouse', 'grab + hold (hunting: shoot)'], ['Q', 'grab (while hunting)'], ['Right mouse', 'throw what you hold'], ['Wheel', 'hold closer / further'], ['E', 'talk · sit · revive · hammer · paddle'], ['1–5', 'vote'], ['H', 'call a halt (trail menu)'], ['V', 'first / third person'], ['Tab', 'party / store catalogue'], ['M', 'big map'], ['Enter', 'ready / continue'], ['T', 'write your epitaph'], ['Esc', 'release the mouse · again: game menu (leave / end game)'], ['Ctrl+Shift+E ×2', 'host: end the game for everyone · guest: leave']];
  return h('div', 'tr-sheet', h('h2', '', 'Controls'), ...rows.map(([k, v]) => h('div', 'tr-sline', h('kbd', '', k), h('span', '', v))));
}
void esc;

let css = false;
function injectCss() {
  if (css) return; css = true;
  const s = document.createElement('style');
  s.textContent = `
.tr-hud{position:absolute;inset:0;pointer-events:none;font-family:Bahnschrift,"Segoe UI",system-ui,sans-serif;color:var(--tr-ink,#fff);--tr-accent:#e8a33d;--tr-good:#8fd16a;--tr-danger:#e0523d;user-select:none}
.tr-hud button,.tr-hud select,.tr-hud input{pointer-events:auto;font-family:inherit}
.tr-top{position:absolute;left:12px;right:12px;top:10px;display:flex;gap:6px;align-items:stretch;flex-wrap:nowrap;overflow:hidden}
.tr-title{font-weight:900;letter-spacing:.05em;font-size:18px;padding:6px 14px;border-radius:12px;background:var(--tr-accent);color:#101010;display:flex;align-items:center;text-transform:uppercase;white-space:nowrap;flex:0 0 auto}
.tr-chip{background:rgba(8,10,12,.62);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:4px 10px;display:flex;flex-direction:column;justify-content:center;min-width:54px;flex:0 1 auto;overflow:hidden}
.tr-chip small{font-size:10px;opacity:.65;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}.tr-chip b{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tr-chip.good b{color:var(--tr-good)}.tr-chip.bad b{color:var(--tr-danger)}
.tr-rolling{align-self:center;font-weight:800;font-size:13px;padding:6px 10px;border-radius:10px;background:rgba(0,0,0,.5);opacity:.8}.tr-rolling.on{color:var(--tr-good)}
.tr-party{position:absolute;left:12px;top:78px;display:flex;flex-direction:column;gap:6px;width:280px}
.tr-member{display:grid;grid-template-columns:12px 1fr;gap:4px 10px;align-items:center;background:rgba(8,10,12,.6);border-radius:12px;padding:7px 10px;border-left:3px solid transparent}
.tr-member .tr-hp{grid-column:1/3;height:5px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden}.tr-member .tr-hp i{display:block;height:100%}
.tr-member.dead{opacity:.55;filter:grayscale(.8)}.tr-member.ghost{border-left-color:#9fd8ff}.tr-member.away{opacity:.4}
.tr-dot{width:12px;height:12px;border-radius:50%;display:inline-block}
.tr-mname b{font-size:14px;display:block}.tr-mname small{font-size:11px;opacity:.7}
.tr-map{position:absolute;right:12px;top:78px;width:360px;height:auto;border-radius:18px;transition:all .25s}.tr-map.big{left:50%;top:50%;right:auto;width:min(1100px,90vw);transform:translate(-50%,-50%);z-index:5}
.tr-stop{position:absolute;left:50%;transform:translateX(-50%);top:78px;min-width:420px;max-width:640px;background:rgba(8,10,12,.7);border-radius:16px;padding:10px 16px;border-top:3px solid var(--tr-accent)}
.tr-stop-title{display:flex;justify-content:space-between;align-items:center;gap:12px}.tr-stop-title b{font-size:18px;text-transform:uppercase;letter-spacing:.04em}
.tr-timer{font-weight:900;font-size:20px;font-variant-numeric:tabular-nums}.tr-timer.hot{color:var(--tr-danger);animation:trp .5s infinite alternate}
@keyframes trp{to{transform:scale(1.12)}}
.tr-obj{font-size:14px;opacity:.9;margin-top:2px}.tr-bar{height:7px;background:rgba(255,255,255,.1);border-radius:4px;margin-top:7px;overflow:hidden}.tr-bar i{display:block;height:100%;background:var(--tr-accent);transition:width .2s}
.tr-notes{font-size:12px;opacity:.75;margin-top:5px}.tr-ready{font-size:11px;opacity:.6;margin-top:6px}
.tr-vote{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);width:min(760px,92vw);background:rgba(8,10,12,.82);border-radius:20px;padding:14px 18px 10px;border:2px solid var(--tr-accent);box-shadow:0 12px 40px rgba(0,0,0,.45);animation:trin .25s ease-out}
@keyframes trin{from{transform:translate(-50%,30px);opacity:0}}
.tr-vhead{display:flex;gap:10px;align-items:center}.tr-vhead b{font-size:22px}
.tr-vote p{margin:6px 0 10px;font-size:15px;opacity:.9}
.tr-tier{font-size:11px;font-weight:900;letter-spacing:.12em;padding:3px 8px;border-radius:6px;background:#555}.tr-tier.mild{background:#4a7a4a}.tr-tier.hilarious{background:#b04ad8}.tr-tier.hard{background:#d86a2a}.tr-tier.insane{background:#e0233d;animation:trp .35s infinite alternate}
.tr-opts{display:grid;gap:6px}
.tr-opt{display:grid;grid-template-columns:30px 1fr auto;gap:10px;align-items:center;text-align:left;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:8px 12px;cursor:pointer}
.tr-opt:hover{background:rgba(255,255,255,.12)}.tr-opt.mine{border-color:var(--tr-accent);background:rgba(255,255,255,.14)}.tr-opt.off{opacity:.4;cursor:not-allowed}
.tr-opt kbd{font:800 14px inherit;background:var(--tr-accent);color:#111;border-radius:7px;text-align:center;padding:3px 0}
.tr-otext b{font-size:15px;display:block}.tr-otext small{font-size:11px;opacity:.7}
.tr-chips{display:flex;gap:4px}.tr-vchip{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-weight:900;font-size:12px;color:#111;box-shadow:0 0 0 2px rgba(0,0,0,.4)}.tr-vchip.chat{width:auto;padding:0 6px;border-radius:10px;background:#9146ff;color:#fff}
.tr-vtime{height:4px;background:rgba(255,255,255,.1);border-radius:2px;margin-top:10px;overflow:hidden}.tr-vtime i{display:block;height:100%;background:var(--tr-accent);transition:width .25s linear}
.tr-vfoot{display:block;opacity:.55;font-size:11px;margin-top:5px}
.tr-card{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);width:min(640px,88vw);background:rgba(10,12,14,.9);border-radius:22px;padding:22px 28px;text-align:center;border:2px solid rgba(255,255,255,.14);animation:trpop .3s cubic-bezier(.2,1.6,.4,1)}
@keyframes trpop{from{transform:translate(-50%,-50%) scale(.7);opacity:0}}
.tr-card h2{margin:6px 0 8px;font-size:28px}.tr-card p{font-size:17px;opacity:.92;margin:0}.tr-card small{opacity:.5;display:block;margin-top:10px}
.tr-card.big h2{font-size:36px}.tr-card.death{border-color:var(--tr-danger);background:rgba(20,6,6,.92)}.tr-card.death h2{color:#ff9a8a;font-family:Georgia,serif;font-style:italic}
.tr-card.insane{border-color:#e0233d}.tr-card.hilarious{border-color:#b04ad8}
.tr-toasts{position:absolute;right:12px;top:230px;display:flex;flex-direction:column;gap:6px;width:340px;align-items:flex-end}
.tr-toast{background:rgba(8,10,12,.75);border-radius:10px;padding:7px 12px;font-size:13px;border-left:3px solid #999;transition:opacity .7s,transform .7s;animation:trslide .25s ease-out}
.tr-toast.good{border-color:var(--tr-good)}.tr-toast.bad{border-color:var(--tr-danger)}.tr-toast.meme{border-color:var(--tr-accent2);font-style:italic}.tr-toast.out{opacity:0;transform:translateX(30px)}
@keyframes trslide{from{transform:translateX(40px);opacity:0}}
.tr-prompt{position:absolute;left:50%;top:58%;transform:translateX(-50%);background:rgba(0,0,0,.6);padding:6px 12px;border-radius:10px;font-weight:700;font-size:14px}
.tr-cross{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 0 2px rgba(0,0,0,.35)}
.tr-cross.grab{width:18px;height:18px;margin:-9px 0 0 -9px;background:none;border:3px solid var(--tr-accent)}.tr-cross.aim{width:26px;height:26px;margin:-13px 0 0 -13px;background:none;border:2px solid #fff;border-radius:50%}.tr-cross.aim::after{content:'';position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px;background:#ff4f4f;border-radius:50%}
.tr-cross:not(.dot):not(.grab):not(.aim){display:none}
.tr-talk{position:absolute;left:50%;bottom:210px;transform:translateX(-50%);max-width:560px;background:#fffbe8;color:#222;border-radius:16px;padding:10px 16px;font-size:16px;opacity:0;transition:opacity .3s}.tr-talk.on{opacity:1}.tr-talk b{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7a5a1a}
.tr-banner{position:absolute;left:0;right:0;top:34%;text-align:center;font-size:54px;font-weight:900;letter-spacing:.04em;text-shadow:0 6px 30px rgba(0,0,0,.6);opacity:0;transform:scale(.8);transition:all .35s}.tr-banner.on{opacity:1;transform:scale(1)}
.tr-modal{position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.45);pointer-events:auto}
.tr-modal>div{background:rgba(12,14,16,.95);border-radius:24px;padding:26px 32px;max-width:min(980px,94vw);max-height:88vh;overflow:auto;border:1px solid rgba(255,255,255,.12)}
.tr-lobby h1,.tr-end h1{margin:0;font-size:44px;letter-spacing:.05em;color:var(--tr-accent);text-transform:uppercase}.tr-sub{opacity:.8;margin-top:4px}
.tr-lobby-cols{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:14px}.tr-lcol h3{margin:12px 0 6px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;opacity:.7}
.tr-lp{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)}.tr-lp small{opacity:.7;margin-left:auto}
.tr-sel,.tr-in{width:100%;background:#1b1e22;color:inherit;border:1px solid rgba(255,255,255,.2);border-radius:10px;padding:9px;font-size:14px}
.tr-small{font-size:12px;opacity:.7}.tr-mods{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.tr-tog,.tr-btn{background:rgba(255,255,255,.08);color:inherit;border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:7px 12px;cursor:pointer;margin:3px 0;display:block}.tr-tog.on{border-color:var(--tr-accent);background:rgba(255,255,255,.16)}.tr-mods .tr-tog{display:inline-block}.tr-btn.small{display:inline-block;padding:4px 10px;margin:2px}
.tr-big{background:var(--tr-accent);color:#111;border:0;border-radius:14px;padding:14px 28px;font-weight:900;font-size:20px;letter-spacing:.06em;cursor:pointer;margin-top:14px}
.tr-lobby-go{display:flex;gap:14px;align-items:center;justify-content:center;margin-top:10px}
.tr-end h1.wipe{color:var(--tr-danger)}.tr-score{margin:14px 0;min-width:420px}.tr-sline{display:flex;justify-content:space-between;gap:20px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.07)}.tr-sline.tot{font-size:20px;border:0;color:var(--tr-accent)}
.tr-titles{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.tr-t{background:rgba(255,255,255,.07);border-radius:10px;padding:6px 10px}.tr-t b{display:block;color:var(--tr-accent2)}
.tr-graves{margin-top:10px}.tr-grave{padding:8px 0;border-bottom:1px solid rgba(255,255,255,.07)}.tr-grave i{display:block;font-family:Georgia,serif;opacity:.85}.tr-grave small{opacity:.6;margin-left:10px}
.tr-epi h2{margin-top:0}.tr-ideas{margin:8px 0}.tr-catgrid{display:grid;gap:6px;margin-top:10px}.tr-catrow{display:grid;grid-template-columns:1fr 70px auto auto;gap:8px;align-items:center}
.tr-sheet{min-width:420px}.tr-sheet kbd{background:rgba(255,255,255,.12);border-radius:6px;padding:2px 8px;font-family:inherit}
.tr-logo{height:46px;width:auto;flex:0 0 auto;filter:drop-shadow(0 2px 6px rgba(0,0,0,.6))}.tr-biglogo{display:block;width:min(560px,70vw);margin:0 auto 4px;filter:drop-shadow(0 4px 12px rgba(0,0,0,.6))}
.tr-chip.ic{flex-direction:row;align-items:center;gap:5px;padding:4px 9px 4px 5px}.tr-chip.ic b{font-size:16px}.tr-ico{width:30px;height:30px;object-fit:contain;flex:0 0 auto}.tr-cv{display:flex;flex-direction:column;min-width:0}
.tr-pico{width:20px;height:20px;object-fit:contain;vertical-align:-4px;margin-right:5px}.tr-tico{width:20px;height:20px;object-fit:contain;vertical-align:-5px;margin-right:4px}
.tr-hud.has-frame .tr-card{border:40px solid transparent;border-image:var(--tr-frame) 64 fill stretch;background:none;padding:6px 16px;border-radius:0}
.tr-hud.has-frame .tr-card.death{background:none}
.tr-modal.tomb{background:linear-gradient(rgba(0,0,0,.25),rgba(0,0,0,.55)),var(--tr-tomb) center/cover no-repeat}
.tr-hud.narrow .tr-logo,.tr-hud.narrow .tr-title,.tr-hud.narrow .k-date,.tr-hud.narrow .k-next{display:none}.tr-hud.narrow .tr-chip{flex:0 0 auto}
.tr-quit{display:block;margin:10px auto 0;background:#b3261e !important;color:#fff !important;pointer-events:auto}
.tr-hud.narrow .tr-map:not(.big){display:none}.tr-hud.narrow .tr-stop{left:auto;right:12px;transform:none;min-width:0;width:min(400px,48%)}.tr-hud.narrow .tr-party{width:230px}.tr-hud.narrow .tr-toasts{width:260px;top:auto;bottom:230px}.tr-hud.narrow .tr-member small{display:none}
.tr-spect .tr-top{transform:scale(1.15);transform-origin:top left}.tr-spect .tr-vote{width:min(900px,70vw)}.tr-spect .tr-prompt,.tr-spect .tr-cross{display:none!important}
.tr-spect .tr-card h2{font-size:40px}
`;
  document.head.append(s);
}
