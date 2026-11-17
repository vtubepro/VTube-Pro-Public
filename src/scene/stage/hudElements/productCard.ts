// HUD element "productCard" (shared/hud.ts HUD_TYPES.productCard, beta.13): the streamer's featured product (Support &
// store → Store) and "Sam just bought this!" when something sells, in an OBS layout's own spot. While a layout shows
// this element the floating card stays away (src/support/productCard.ts). Canvas text only.
import { drawProductCard, productImgRev, showStore } from '../../../support/productCard.ts';
import { prop, registerHudElement, type HudFrame, type HudPlaced, type HudView } from '../hudCore.ts';

class ProductCardView implements HudView {
  readonly el = document.createElement('div');
  private canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d')!;
  private key = '';
  private last = 0;
  constructor() {
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;';
    this.el.append(this.canvas);
  }
  update(e: HudPlaced, f: HudFrame) {
    const cur = showStore.current(f.now);
    const purchasesOnly = !prop.bool(e.props.showcase, true);
    const show = !!cur && !(purchasesOnly && !cur.flash);
    this.el.style.visibility = show ? '' : 'hidden';
    if (!show || !cur) return;
    showStore.hudAt = f.now;
    const W = Math.max(40, Math.round(e.rect.w * f.frameW)), H = Math.max(40, Math.round(e.rect.h * f.frameH));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); this.key = ''; }
    const key = `${showStore.rev}|${productImgRev()}|${cur.product?.id ?? ''}|${cur.flash?.id ?? ''}|${this.canvas.width}x${this.canvas.height}|${e.props.qr}`;
    if (key === this.key && !cur.flash) return;
    if (cur.flash && f.now - this.last < 50) return;
    this.key = key; this.last = f.now;
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    drawProductCard(this.g, this.canvas.width, this.canvas.height, f.now, cur, { qr: prop.bool(e.props.qr, true) && !!showStore.view?.qr, shopUrl: showStore.view?.shopUrl ?? '' });
  }
  dispose() { /* nothing held */ }
}

registerHudElement({ type: 'productCard', mount: () => new ProductCardView() });
