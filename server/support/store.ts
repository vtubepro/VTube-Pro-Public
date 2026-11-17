// The Fourthwall store in the studio + on stream (beta.13, research B).
//   * Products: the creator's Open API (all products, incl. hidden + sold-out state) or, without a key, the public
//     Storefront API with the storefront token. Cached in cache/support/store.json, refreshed every 10 minutes and on
//     Fourthwall's PRODUCT_* / COLLECTION_UPDATED webhooks. Images go through this PC (/api/support/img/…).
//   * Showcase: the featured product or a carousel, shown on every OBS page ({type:'supportShow'}); a purchase of a
//     product flashes its card ("Sam bought this") for ~10 s.
//   * Management (all confirmed in the studio first: "This changes your live store"): show / hide a product in the shop,
//     set the products of a collection (a "featured on stream" collection), and a TIMED promo code (Fourthwall's API
//     has no expiry, so the helper ends it at the time: PUT /promotions/{id} {status:'ENDED'}; the schedule is saved and
//     an overdue code is ended at the next start). Inventory can't be changed through the API (read only: "3 left!").
import fs from 'node:fs';
import path from 'node:path';
import type { SupportEvent } from '../../shared/support.ts';
import { cleanText, sanitizeProduct, sanitizeShowcase, supportImg, type ShowcaseView, type StoreCollection, type StoreProduct, type StoreSnapshot } from '../../shared/supportConfig.ts';
import type { FourthwallConnector } from './connectors/fourthwall.ts';
import { cur, s, toMinor } from './types.ts';
import type { SupportHub } from './hub.ts';
import { writeAtomic } from './vault.ts';

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const STOREFRONT = 'https://storefront-api.fourthwall.com/v1';
const FLASH_MS = 11_000;

/** A product from the Open API (OfferFullV1) or the Storefront API. */
export function productFrom(p: J, shopUrl: string): StoreProduct | null {
  const v0 = o(arr(p.variants)[0]);
  const price = o(v0.unitPrice ?? p.price);
  const c = cur(price.currency);
  const img = s(o(arr(p.images)[0]).url, 500) || s(o(p.thumbnailImage).url, 500) || s(o(p.primaryImage).url, 500);
  const access = s(o(p.access).type, 20);
  const state = s(o(p.state).type, 20);
  const limited = arr(p.variants).map(o).map((v) => o(v.stock)).filter((st) => s(st.type, 20) === 'LIMITED');
  const left = limited.length ? limited.reduce((n, st) => n + (Number(st.inStock) || 0), 0) : undefined;
  const slug = s(p.slug, 120);
  return sanitizeProduct({
    id: s(p.id, 80), slug, name: s(p.name, 120), image: img ? supportImg(img) : '', priceMinor: toMinor(price.value, c), currency: c,
    available: state !== 'SOLD_OUT' && (left === undefined || left > 0), listed: !access || access === 'PUBLIC',
    url: shopUrl && slug ? `${shopUrl}/products/${slug}` : '', ...(left !== undefined && left <= 10 ? { left } : {}),
  });
}

interface Promo { id: string; code: string; endAt: number; ended: boolean }

export class Store {
  snap: StoreSnapshot = { products: [], collections: [], shopUrl: '', at: 0, error: '' };
  private flashV: ShowcaseView['flash'] = null;
  private timer: NodeJS.Timeout | null = null;
  private flashT: NodeJS.Timeout | null = null;
  private promoT: NodeJS.Timeout | null = null;
  private promos: Promo[] = [];
  private loading: Promise<void> | null = null;
  private file: string;
  private promoFile: string;

  constructor(private hub: SupportHub, cacheDir: string, savesDir: string) {
    this.file = path.join(cacheDir, 'support', 'store.json');
    this.promoFile = path.join(savesDir, 'support', 'promos.json');
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreSnapshot; this.snap = { ...this.snap, ...j, products: arr(j.products).map(sanitizeProduct).filter((x): x is StoreProduct => !!x) }; } catch { /* first run */ }
    try { this.promos = JSON.parse(fs.readFileSync(this.promoFile, 'utf8')) as Promo[]; } catch { this.promos = []; }
    hub.showcase = { view: () => this.view(), flash: (ev) => this.flash(ev), refresh: () => { void this.load(); this.push(); } };
  }

  private fw(): FourthwallConnector | null { return this.hub.connector('fourthwall') as FourthwallConnector | null; }
  private shopUrl() { return this.hub.settings.services.fourthwall.shopUrl ?? ''; }

  start() {
    const tick = () => { void this.load(); this.timer = setTimeout(tick, 10 * 60_000); };
    this.timer = setTimeout(tick, 3000);
    this.armPromos();
  }
  stop() { if (this.timer) clearTimeout(this.timer); if (this.flashT) clearTimeout(this.flashT); if (this.promoT) clearTimeout(this.promoT); }

  /** Reload the products (the Open API when the key is saved, else the public storefront). */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const shop = this.shopUrl();
      const prev = this.snap;
      try {
        const fw = this.fw();
        let products: StoreProduct[] = [];
        let collections: StoreCollection[] = prev.collections;
        if (fw?.hasKey()) {
          for (let page = 0; page < 5; page++) {
            const r = o(await fw.api(`/products?page=${page}&size=100`));
            products.push(...arr(r.results).map(o).map((p) => productFrom(p, shop)).filter((x): x is StoreProduct => !!x));
            if (page + 1 >= (Number(r.totalPages) || 1)) break;
          }
          try {
            const cs = o(await fw.api('/collections?page=0&size=100'));
            collections = arr(cs.results).map(o).map((c) => ({ id: s(c.id, 80), slug: s(c.slug, 120), name: cleanText(s(c.name, 80), 60) })).filter((c) => c.id);
          } catch { /* keep */ }
        } else {
          const token = this.hub.vault.get('fourthwall', 'storefrontToken');
          if (!token) { this.snap = { ...prev, error: this.hub.settings.services.fourthwall.enabled ? 'Add your Fourthwall key (or storefront token) to show your products.' : '' }; return; }
          const r = await this.hub.deps.fetch!(`${STOREFRONT}/collections/all/products?storefront_token=${encodeURIComponent(token)}&size=50`, { signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Fourthwall didn’t accept that storefront token.' : `Fourthwall said no (${r.status}).`);
          products = arr(o(await r.json()).results).map(o).map((p) => productFrom(p, shop)).filter((x): x is StoreProduct => !!x);
        }
        this.snap = { products, collections, shopUrl: shop, at: Date.now(), error: '' };
        writeAtomic(this.file, JSON.stringify(this.snap));
      } catch (e) {
        this.snap = { ...prev, error: (e as Error).message };
      } finally { this.loading = null; this.push(); }
    })();
    return this.loading;
  }

  /** What the OBS pages draw. */
  view(): ShowcaseView {
    const sc = this.hub.settings.showcase;
    const hidden = new Set(sc.hidden);
    const products = this.snap.products.filter((p) => !hidden.has(p.id) && p.listed).slice(0, 24);
    return sanitizeShowcase({ on: sc.on, mode: sc.mode, where: sc.where, every: sc.every, qr: sc.qr, shopUrl: this.shopUrl(), products, featured: sc.featured, flash: this.flashV && Date.now() - this.flashV.at < FLASH_MS ? this.flashV : null })!;
  }
  push() { this.hub.deps.broadcast({ type: 'supportShow', v: this.view() }); }

  /** "Sam bought the Night Owl Hoodie": its card on stream for ~10 s (when the streamer allows purchase cards). */
  flash(ev: SupportEvent) {
    if (!this.hub.settings.showcase.purchases || !ev.item) return;
    const want = (ev.item.productId ?? '').toLowerCase(), nm = ev.item.name.toLowerCase();
    const product = this.snap.products.find((p) => (want && p.id.toLowerCase() === want) || nm.startsWith(p.name.toLowerCase())) ?? null;
    const image = product?.image || (ev.item.imageUrl ? supportImg(ev.item.imageUrl) : '');
    this.flashV = { id: ev.id, product, itemName: ev.item.name, image, who: ev.who.name, at: Date.now(), test: ev.test };
    this.push();
    if (this.flashT) clearTimeout(this.flashT);
    this.flashT = setTimeout(() => { this.flashV = null; this.push(); }, FLASH_MS);
  }

  // ---------------------------------------------------------------- management (the studio confirms each one first)
  private need(): FourthwallConnector {
    const fw = this.fw();
    if (!fw?.hasKey()) throw Object.assign(new Error('Connect Fourthwall with your API username and password first.'), { status: 409 });
    return fw;
  }
  /** Show / hide a product in the shop (Fourthwall's product state PUBLIC / HIDDEN). */
  async setListed(id: string, listed: boolean) {
    await this.need().api(`/products/${encodeURIComponent(id)}/state`, { method: 'PUT', body: { state: listed ? 'PUBLIC' : 'HIDDEN' } });
    this.snap = { ...this.snap, products: this.snap.products.map((p) => (p.id === id ? { ...p, listed } : p)) };
    this.push();
    void this.load();
  }
  /** Replace the products of a collection (e.g. "On stream now"). */
  async setCollection(id: string, offerIds: string[]) {
    await this.need().api(`/collections/${encodeURIComponent(id)}/products`, { method: 'PUT', body: { offerIds: offerIds.slice(0, 200) } });
    void this.load();
  }
  /** A promo code that ends by itself after `minutes` (and/or after `maxUses`). */
  async createPromo(o2: { code: string; percent?: number; flat?: number; freeShipping?: boolean; minutes: number; maxUses?: number; oncePerCustomer?: boolean; currency?: string }) {
    const code = String(o2.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
    if (code.length < 3) throw Object.assign(new Error('Give the code at least 3 letters or numbers.'), { status: 400 });
    const minutes = Math.max(1, Math.min(7 * 24 * 60, Math.round(o2.minutes || 10)));
    const discount = o2.freeShipping ? { type: 'FREE_SHIPPING' }
      : o2.flat && o2.flat > 0 ? { type: 'FLAT_RATE', money: { value: Math.round(o2.flat * 100) / 100, currency: cur(o2.currency, this.hub.settings.displayCurrency) }, freeShipping: false }
        : { type: 'PERCENTAGE', percentage: Math.max(1, Math.min(100, Math.round(o2.percent ?? 10))), shipping: 'Excluded' };
    const body: J = { type: 'SHOP_SINGLE', code, discount };
    if (o2.maxUses || o2.oncePerCustomer) body.limits = { ...(o2.maxUses ? { maximumUse: Math.max(1, Math.round(o2.maxUses)) } : {}), oneUsePerCustomer: !!o2.oncePerCustomer };
    const r = o(await this.need().api('/promotions', { method: 'POST', body }));
    const pid = s(r.id, 80);
    const promo: Promo = { id: pid, code, endAt: Date.now() + minutes * 60_000, ended: false };
    if (pid) { this.promos.push(promo); this.savePromos(); this.armPromos(); }
    return { id: pid, code, endsAt: new Date(promo.endAt).toISOString() };
  }
  async endPromo(id: string) {
    await this.need().api(`/promotions/${encodeURIComponent(id)}`, { method: 'PUT', body: { status: 'ENDED' } });
    const p = this.promos.find((x) => x.id === id); if (p) p.ended = true;
    this.savePromos();
  }
  promoList() { return this.promos.filter((p) => !p.ended).map((p) => ({ id: p.id, code: p.code, endsAt: new Date(p.endAt).toISOString() })); }
  private savePromos() { this.promos = this.promos.filter((p) => !p.ended || Date.now() - p.endAt < 7 * 86400_000).slice(-50); writeAtomic(this.promoFile, JSON.stringify(this.promos)); }
  /** End every code whose time is up (now, and at the next due time). */
  private armPromos() {
    if (this.promoT) clearTimeout(this.promoT);
    const open = this.promos.filter((p) => !p.ended);
    if (!open.length) return;
    const due = open.filter((p) => p.endAt <= Date.now());
    for (const p of due) void this.endPromo(p.id).catch((e) => console.warn('[support] promo end failed (retrying):', (e as Error).message));
    const next = open.filter((p) => p.endAt > Date.now()).sort((a, b) => a.endAt - b.endAt)[0];
    const wait = next ? Math.min(next.endAt - Date.now(), 2 ** 31 - 1) : due.length ? 60_000 : 0;
    if (wait) this.promoT = setTimeout(() => this.armPromos(), Math.max(1000, wait));
  }
}
