// HUD elements "goalLadder" + "subathonTimer" (shared/hud.ts HUD_TYPES): a goal's stretch-goal ladder and the subathon
// timer of the helper's goals engine (Goals & subathon), drawn by the same canvas renderers as the docked card and the
// in-world board (src/goals/goalsDraw.ts) into the element's box. Hidden while there is nothing to show.
import { prop, registerHudElement, type HudFrame, type HudPlaced, type HudView } from '../hudCore.ts';
import { boardH, drawLadder, drawLeaders, drawTimer, timerH, type Look } from '../../../goals/goalsDraw.ts';
import { lookOf } from '../../../goals/goalsOverlay.ts';
import { goalsStore, pickGoal } from '../../../goals/goalsStore.ts';

abstract class CanvasView implements HudView {
  readonly el = document.createElement('div');
  protected canvas = document.createElement('canvas');
  protected g = this.canvas.getContext('2d')!;
  private last = 0;
  private rev = -1;
  constructor(cls: string) {
    this.el.className = cls;
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    this.el.append(this.canvas);
  }
  update(e: HudPlaced, f: HudFrame) {
    const show = this.wanted(e);
    this.el.style.visibility = show ? '' : 'hidden';
    if (!show) return;
    const now = performance.now();
    goalsStore.step();
    if (now - this.last < (goalsStore.moving ? 33 : 200) && goalsStore.rev === this.rev) return;
    this.last = now; this.rev = goalsStore.rev;
    const W = Math.max(1, Math.round(e.rect.w * f.frameW)), H = Math.max(1, Math.round(e.rect.h * f.frameH));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); }
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = goalsStore.view!;
    const st = prop.str(e.props.style, 'auto');
    const look: Look = lookOf(f.palette, st === 'neon' || st === 'clean' || st === 'bold' ? st : v.show.style, v.test);
    this.draw(e, W, H, look, goalsStore.now());
  }
  protected abstract wanted(e: HudPlaced): boolean;
  protected abstract draw(e: HudPlaced, W: number, H: number, look: Look, now: number): void;
  dispose() { this.canvas.width = this.canvas.height = 0; }
}

class LadderView extends CanvasView {
  constructor() { super('hud-goal-ladder'); }
  protected wanted(e: HudPlaced) { const g = pickGoal(prop.str(e.props.goal, '')); return !!g && g.show; }
  protected draw(e: HudPlaced, W: number, H: number, look: Look, now: number) {
    const g = pickGoal(prop.str(e.props.goal, ''));
    if (g) drawLadder(this.g, 0, 0, W, H, g, goalsStore.view!.cur, look, now);
  }
}

class TimerView extends CanvasView {
  constructor() { super('hud-subathon'); }
  protected wanted() { return !!goalsStore.view?.sub; }
  protected draw(e: HudPlaced, W: number, H: number, look: Look, now: number) {
    const sub = goalsStore.view!.sub!;
    if (prop.bool(e.props.board, false)) {
      const th = timerH(W), bh = boardH(W, sub.top.length);
      const k = Math.min(1, H / (th + bh + W * 0.025));
      drawTimer(this.g, 0, 0, W, th * k, sub, look, now);
      drawLeaders(this.g, 0, th * k + W * 0.025 * k, W, bh * k, sub, look);
    } else drawTimer(this.g, 0, 0, W, H, sub, look, now);
  }
}

registerHudElement({ type: 'goalLadder', mount: () => new LadderView() });
registerHudElement({ type: 'subathonTimer', mount: () => new TimerView() });
