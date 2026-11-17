// HUD element "text" (shared/hud.ts HUD_TYPES.text): a short outlined label (a schedule, !commands, "now playing" …).
import { HUD_FONTS, prop, registerHudElement, textShadow, type HudFrame, type HudPlaced, type HudView } from '../hudCore.ts';

class TextView implements HudView {
  readonly el = document.createElement('div');
  private sig = '';
  constructor() {
    const s = this.el.style;
    s.display = 'flex'; s.alignItems = 'center'; s.overflow = 'hidden'; s.lineHeight = '1.2'; s.overflowWrap = 'anywhere';
  }
  update(e: HudPlaced, f: HudFrame) {
    const p = e.props, k = f.frameH / 1080;
    const sig = `${JSON.stringify(p)}|${k.toFixed(3)}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const s = this.el.style;
    s.fontSize = `${(26 * prop.num(p.size, 1.2) * k).toFixed(2)}px`;
    s.fontFamily = HUD_FONTS[prop.str(p.font, 'sans')] ?? HUD_FONTS.sans;
    s.fontWeight = prop.bool(p.bold, true) ? '800' : '500';
    s.color = prop.str(p.color, '#ffffff');
    s.textShadow = textShadow(prop.num(p.outline, 3), prop.num(p.shadow, 0.7), k);
    const al = prop.str(p.align, 'left');
    s.justifyContent = al === 'center' ? 'center' : al === 'right' ? 'flex-end' : 'flex-start';
    s.textAlign = al;
    this.el.textContent = prop.str(p.text, '');
  }
  dispose() { /* nothing held */ }
}

registerHudElement({ type: 'text', mount: () => new TextView() });
