// HUD element "logo" (shared/hud.ts HUD_TYPES.logo): an image served by this computer's VTube Pro (a path starting
// with '/'), never a remote address: party guests' OBS pages draw the host's layout and must not fetch an address the
// host typed (privacy). docs/LAYOUTS.md → "Logo / image".
import { safeImagePath } from '../../../../shared/hud.ts';
import { prop, registerHudElement, type HudFrame, type HudPlaced, type HudView } from '../hudCore.ts';

class LogoView implements HudView {
  readonly el = document.createElement('div');
  private img = document.createElement('img');
  private src = '';
  constructor() {
    this.img.decoding = 'async';
    this.img.alt = '';
    this.img.style.cssText = 'width:100%;height:100%;display:block;';
    this.img.onerror = () => { this.img.style.visibility = 'hidden'; };
    this.img.onload = () => { this.img.style.visibility = ''; };
    this.el.append(this.img);
  }
  update(e: HudPlaced, f: HudFrame) {
    const p = e.props, k = f.frameH / 1080;
    const src = prop.str(p.src, '');
    if (src !== this.src) { this.src = src; if (safeImagePath(src)) this.img.src = src; else this.img.removeAttribute('src'); }
    this.img.style.objectFit = prop.str(p.fit, 'contain') === 'cover' ? 'cover' : 'contain';
    this.img.style.borderRadius = `${prop.num(p.radius, 0)}%`;
    const sh = prop.num(p.shadow, 0.4);
    this.img.style.filter = sh > 0.01 ? `drop-shadow(0 ${(3 * k).toFixed(1)}px ${(8 * k).toFixed(1)}px rgba(0,0,0,${sh.toFixed(2)}))` : '';
  }
  dispose() { this.img.removeAttribute('src'); }
}

registerHudElement({ type: 'logo', mount: () => new LogoView() });
