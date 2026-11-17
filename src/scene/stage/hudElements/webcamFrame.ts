// HUD element "webcamFrame" (shared/hud.ts HUD_TYPES.webcamFrame): a decorative frame whose middle stays see-through,
// for a real webcam (or any other OBS source) placed under the browser source in OBS. Optional name tag.
import { prop, registerHudElement, textShadow, type HudFrame, type HudPlaced, type HudView } from '../hudCore.ts';

class WebcamFrameView implements HudView {
  readonly el = document.createElement('div');
  private ring = document.createElement('div');
  private tag = document.createElement('div');
  private sig = '';
  constructor() {
    this.ring.style.cssText = 'position:absolute;inset:0;box-sizing:border-box;';
    this.tag.style.cssText = 'position:absolute;left:50%;bottom:0;transform:translate(-50%,55%);padding:.2em .8em;border-radius:99px;font-weight:800;font-family:"Segoe UI",Inter,system-ui,sans-serif;color:#fff;white-space:nowrap;';
    this.el.append(this.ring, this.tag);
  }
  update(e: HudPlaced, f: HudFrame) {
    const p = e.props, k = f.frameH / 1080;
    const col = prop.str(p.color, '') || f.palette.accent;
    const sig = `${JSON.stringify(p)}|${col}|${k.toFixed(3)}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const w = Math.max(1, prop.num(p.width, 6) * k), r = prop.num(p.radius, 14) * k, style = prop.str(p.style, 'bezel');
    const s = this.ring.style;
    s.borderRadius = `${r.toFixed(1)}px`;
    s.border = `${(style === 'thin' ? Math.max(1, w * 0.4) : w).toFixed(1)}px solid ${col}`;
    s.boxShadow = style === 'glow' ? `0 0 ${(w * 3).toFixed(1)}px ${col}, inset 0 0 ${(w * 2).toFixed(1)}px ${col}88`
      : style === 'neon' ? `0 0 ${(w * 1.5).toFixed(1)}px #fff, 0 0 ${(w * 4).toFixed(1)}px ${col}, 0 0 ${(w * 8).toFixed(1)}px ${col}`
        : style === 'bezel' ? `0 ${(3 * k).toFixed(1)}px ${(14 * k).toFixed(1)}px rgba(0,0,0,.55), inset 0 0 0 ${(1.5 * k).toFixed(1)}px rgba(0,0,0,.45)` : 'none';
    const label = prop.str(p.label, '');
    this.tag.textContent = label;
    this.tag.style.display = label ? '' : 'none';
    this.tag.style.fontSize = `${(20 * k).toFixed(1)}px`;
    this.tag.style.background = col;
    this.tag.style.textShadow = textShadow(1.5, 0.5, k);
  }
  dispose() { /* nothing held */ }
}

registerHudElement({ type: 'webcamFrame', mount: () => new WebcamFrameView() });
