// The Trail — what a view needs of the host's deck (names, texts, palette, route, prices). Guests don't have the host's
// theme pack; the host sends this subset in 'hello'. Sanitised on receipt (strings / numbers only, bounded).
import type { Deck } from '../../../../shared/trail/types.ts';

export interface DeckLite {
  id: string; name: string; text: Record<string, string>; currency: { name: string; sym: string }; palette: Record<string, string>;
  route: Deck['route']; slice?: Deck['route'];
  roles: Record<string, { name: string; perk: string; money: number; mult: number }>;
  conds: Record<string, { name: string }>; items: Record<string, { name: string; price: number; unit?: number }>;
  weather: { id: string; name: string }[]; biomes: { id: string; name: string; from: number }[]; epitaphs: string[];
}
export function liteOf(d: Deck): DeckLite {
  return {
    id: d.id, name: d.name, text: d.text, currency: d.currency, palette: d.palette, route: d.route, slice: d.slice,
    roles: Object.fromEntries(Object.entries(d.roles).map(([k, r]) => [k, { name: r.name, perk: r.perk, money: r.money, mult: r.mult }])),
    conds: Object.fromEntries(Object.entries(d.conds).map(([k, c]) => [k, { name: c.name }])),
    items: Object.fromEntries(Object.entries(d.items).map(([k, i]) => [k, { name: i.name, price: i.price, unit: i.unit }])),
    weather: d.weather.map((w) => ({ id: w.id, name: w.name })), biomes: d.biomes, epitaphs: d.epitaphs.slice(0, 12),
  };
}
const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown, n = 64): unknown[] => (Array.isArray(v) ? v.slice(0, n) : []);
/** Guest side: the host's deck subset, cleaned. */
export function sanitizeLite(v: unknown): DeckLite | null {
  const o = obj(v);
  if (!o.id) return null;
  const strMap = (x: unknown, n = 300) => Object.fromEntries(Object.entries(obj(x)).slice(0, 200).map(([k, s]) => [str(k, 40), str(s, n)]));
  const node = (x: unknown) => { const r = obj(x); return { id: str(r.id, 40), kind: str(r.kind, 12) as never, name: str(r.name, 60), miles: num(r.miles), depth: num(r.depth), width: num(r.width), ferry: num(r.ferry), talk: arr(r.talk, 8).map((t) => str(t)) }; };
  return {
    id: str(o.id, 40), name: str(o.name, 80), text: strMap(o.text), currency: { name: str(obj(o.currency).name, 24), sym: str(obj(o.currency).sym, 4) }, palette: strMap(o.palette, 16),
    route: arr(o.route, 20).map(node), slice: o.slice ? arr(o.slice, 20).map(node) : undefined,
    roles: Object.fromEntries(Object.entries(obj(o.roles)).slice(0, 12).map(([k, r]) => [str(k, 20), { name: str(obj(r).name, 40), perk: str(obj(r).perk, 120), money: num(obj(r).money), mult: num(obj(r).mult) }])),
    conds: Object.fromEntries(Object.entries(obj(o.conds)).slice(0, 16).map(([k, r]) => [str(k, 20), { name: str(obj(r).name, 40) }])),
    items: Object.fromEntries(Object.entries(obj(o.items)).slice(0, 16).map(([k, r]) => [str(k, 20), { name: str(obj(r).name, 40), price: num(obj(r).price), unit: num(obj(r).unit) || undefined }])),
    weather: arr(o.weather, 12).map((w) => ({ id: str(obj(w).id, 20), name: str(obj(w).name, 30) })),
    biomes: arr(o.biomes, 8).map((b) => ({ id: str(obj(b).id, 20), name: str(obj(b).name, 30), from: num(obj(b).from) })),
    epitaphs: arr(o.epitaphs, 12).map((e) => str(e, 60)),
  };
}
