// The goals card on the OBS page (beta.13): the shown goal bars + the subathon timer docked in a free screen corner
// (never over a face, a performer cam, the capture / react screen, the docked chat or the poll card - shared/goalsView.ts
// pickGoalsDock), plus the big moments over the whole frame: celebration banners with confetti and the wheel spin.
// Hidden while a Full screen HUD layout already shows goal elements, and while the in-world board shows them.
// Draws ≤ 30 fps; costs nothing while there is nothing to show. Silent (sounds are played by the studio).
import type { StagePalette } from '../../shared/stage.ts';
import { pickGoalsDock, viewActive, type FRect } from '../../shared/goalsView.ts';
import { cardHeight, drawCard, drawFx, drawWheel, wheelActive, FX_MS, DEFAULT_LOOK, type Look } from './goalsDraw.ts';
import { goalsStore } from './goalsStore.ts';

export interface GoalsPlacement {
  /** what the card must never touch (normalised rects) */
  avoid(): FRect[];
  palette: StagePalette | null;
  /** the HUD element types on screen (a Full screen layout that draws goal elements itself) */
  hud: Set<string>;
  /** the in-world board shows the goals right now */
  worldShown: boolean;
}

export function lookOf(p: StagePalette | null, style: Look['style'], test: boolean): Look {
  return p ? { style, accent: p.accent, accent2: p.accent2, ink: '#f4f7ff', hero: p.hero, test } : { ...DEFAULT_LOOK, style, test };
}

export class GoalsOverlay {
  readonly card = document.createElement('canvas');
  readonly fx = document.createElement('canvas');
  private gc = this.card.getContext('2d')!;
  private gf = this.fx.getContext('2d')!;
  private alpha = 0;
  private rect: FRect | null = null;
  private lastDraw = 0;
  private lastFx = 0;
  private drawnRev = -1;
  private fxOn = false;
  /** debug / tests: where the card is */
  where: 'hidden' | 'docked' | 'hud' | 'world' = 'hidden';

  constructor() {
    for (const [c, id, z] of [[this.card, 'vtp-goals', 29], [this.fx, 'vtp-goals-fx', 44]] as const) {
      c.id = id; c.setAttribute('aria-hidden', 'true');
      c.style.cssText = `position:fixed;left:0;top:0;pointer-events:none;z-index:${z};opacity:0;transform-origin:top left;`;
      document.body.append(c);
    }
  }

  update(dt: number, place: GoalsPlacement | null) {
    goalsStore.step();
    const v = goalsStore.view;
    const now = goalsStore.now();
    const act = viewActive(v);
    const what = v?.show.what ?? 'both';
    const hud = place?.hud;
    const hudGoals = !!hud && (hud.has('goalBar') || hud.has('goalLadder')), hudTimer = !!hud?.has('subathonTimer');
    const goals = what === 'timer' || hudGoals ? [] : act.goals.slice(0, 3);
    const sub = what === 'goals' || hudTimer ? null : v?.sub ?? null;
    const any = !!v && v.show.dock !== 'off' && (act.goals.length > 0 || !!v.sub);
    this.where = !any ? 'hidden' : !goals.length && !sub ? 'hud' : place?.worldShown ? 'world' : 'docked';
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    const look = lookOf(place?.palette ?? null, v?.show.style ?? 'neon', !!v?.test);
    const avoid = place?.avoid() ?? [];
    const poll = document.getElementById('vtp-poll');
    if (poll && Number(poll.style.opacity) > 0.05) { const r = poll.getBoundingClientRect(); if (r.width > 0) avoid.push({ x: r.left / vw, y: r.top / vh, w: r.width / vw, h: r.height / vh }); }
    // ---- the docked card
    if (this.where === 'docked') {
      const w = Math.min(0.42, 0.24 * (v!.show.scale || 1));
      const Wpx = w * vw;
      const h = cardHeight(Wpx, goals, sub, what) / vh;
      const r = pickGoalsDock(avoid, w, Math.min(0.9, h), v!.show.dock, this.rect);
      this.rect = r;
    }
    const want = this.where === 'docked' && this.rect ? 1 : 0;
    this.alpha += (want - this.alpha) * (1 - Math.exp(-dt * 8));
    if (this.alpha < 0.01 && !want) { if (this.card.style.opacity !== '0') this.card.style.opacity = '0'; }
    else if (this.rect && v) {
      const r = this.rect;
      const W = Math.round(r.w * vw), H = Math.round(r.h * vh);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (this.card.width !== Math.round(W * dpr) || this.card.height !== Math.round(H * dpr)) {
        this.card.width = Math.round(W * dpr); this.card.height = Math.round(H * dpr);
        this.card.style.width = `${W}px`; this.card.style.height = `${H}px`;
      }
      this.card.style.left = `${Math.round(r.x * vw)}px`; this.card.style.top = `${Math.round(r.y * vh)}px`;
      this.card.style.opacity = this.alpha.toFixed(3);
      this.card.style.transform = `scale(${(0.95 + 0.05 * this.alpha).toFixed(3)})`;
      // full rate while something moves (a bar easing, a time pop, the last 5 minutes), else 5 redraws a second
      const urgent = !!sub && !sub.paused && !sub.ended && sub.endsAt - now < 5 * 60_000;
      const gap = goalsStore.moving || urgent ? 33 : 200;
      if (performance.now() - this.lastDraw >= gap || goalsStore.rev !== this.drawnRev) {
        this.lastDraw = performance.now(); this.drawnRev = goalsStore.rev;
        const g = this.gc;
        g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.card.width, this.card.height);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawCard(g, W, H, goals, sub, what, v.cur, look, now);
      }
    }
    // ---- celebrations + the wheel, over the whole frame
    const fxList = (v?.fx ?? []).filter((f) => now - f.at >= 0 && now - f.at < FX_MS);
    const spin = v?.wheel.spin ?? null;
    const wheelOn = wheelActive(spin, now);
    const fxWant = fxList.length > 0 || wheelOn;
    if (!fxWant) {
      if (this.fxOn) { this.fxOn = false; this.fx.style.opacity = '0'; this.gf.clearRect(0, 0, this.fx.width, this.fx.height); }
      return;
    }
    if (performance.now() - this.lastFx < 33) return;
    this.lastFx = performance.now();
    const sc = Math.min(1, 1920 / vw);
    const FW = Math.round(vw * sc), FH = Math.round(vh * sc);
    if (this.fx.width !== FW || this.fx.height !== FH) { this.fx.width = FW; this.fx.height = FH; this.fx.style.width = `${vw}px`; this.fx.style.height = `${vh}px`; }
    if (!this.fxOn) { this.fxOn = true; this.fx.style.opacity = '1'; }
    const g = this.gf;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, FW, FH);
    if (wheelOn && spin && v) {
      const side = 0.36 * FH;
      const cardR = this.where === 'docked' && this.rect ? [this.rect] : [];
      const wr = pickGoalsDock([...avoid, ...cardR], side / FW, (side * 1.45) / FH, 'auto', null) ?? { x: 0.5 - side / FW / 2, y: 0.08, w: side / FW, h: (side * 1.45) / FH };
      drawWheel(g, (wr.x + wr.w / 2) * FW, wr.y * FH + side * 0.62, side * 0.44, v.wheel.slots, spin, look, now);
    }
    // the newest celebration on top; a face under the top banner pushes it to the bottom
    const f = fxList[fxList.length - 1];
    if (f) {
      const banner = { x: 0.19, y: 0.1, w: 0.62, h: 0.16 };
      const faceHit = avoid.some((a) => a.x < banner.x + banner.w && banner.x < a.x + a.w && a.y < banner.y + banner.h && banner.y < a.y + a.h && a.h < 0.6);
      if (faceHit) { g.save(); g.translate(0, FH * 0.66); drawFx(g, FW, FH, f, look, now); g.restore(); }
      else drawFx(g, FW, FH, f, look, now);
    }
  }

  dispose() { this.card.remove(); this.fx.remove(); }
}
