// "Material style" (surface render styles: felt puppet, plush, knit, clay, scales, fur… — src/avatar/surfaceStyles.ts,
// docs/AI_CREATOR_GUIDE.md §5.5). Swatch cards grouped by category, then the style's own tweaks.
//   surfaceSimpleCard(app, refresh)        Me → Simple: pick a look, re-colour, pattern, puppet eyes
//   surfaceStyleSection(app, p, rerender)  Me → Advanced → Face (Look): every tweak + per-part assignment (look.surfaces)
// Changing the style / pattern rebuilds the avatar (one shader compile); every other control is live (runtime.setLook).
import type { App } from '../app.ts';
import type { AvatarProfile, SurfaceStyle, SurfaceStyleId } from '../../shared/types.ts';
import { SURFACE_STYLES, normalizeSurface, surfacePreset, type SurfaceCategory } from '../avatar/surfaceStyles.ts';
import { color, h, section, select, slider, toggle } from './dom.ts';

type Look = NonNullable<AvatarProfile['look']>;
const CATS: { id: SurfaceCategory; icon: string; blurb: string }[] = [
  { id: 'Fabric & puppet', icon: '🧶', blurb: 'Felt, sock, fleece, plush, knit' },
  { id: 'Toy & craft', icon: '🧸', blurb: 'Clay, plastic, vinyl, porcelain, paper' },
  { id: 'Hard & special', icon: '💎', blurb: 'Metal, glass, crystal, slime, stone' },
  { id: 'Creature', icon: '🦎', blurb: 'Scales, horn, wet skin, fur' },
];

const CSS = `
.sf-cats { display:flex; gap:4px; flex-wrap:wrap; margin:0 0 8px; }
.sf-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; }
.sf-card { border:1px solid var(--line, #2a303c); background: var(--card2, #171b22); border-radius:10px; padding:0; cursor:pointer; color:inherit; font:inherit; text-align:left; overflow:hidden; position:relative; }
.sf-card:hover { border-color: var(--line2, #3d4658); }
.sf-card.on { border-color: var(--accent, #7bd88f); box-shadow: 0 0 0 1px var(--accent, #7bd88f) inset; }
.sf-card .sw { display:block; width:100%; height:44px; border-radius:0; box-shadow:none; position:relative; }
.sf-card .sw::after { content:''; position:absolute; inset:0; opacity:.55; mix-blend-mode:overlay; }
.sf-card .sw.fibre::after { background: repeating-linear-gradient(35deg, #fff3 0 1px, #0000 1px 3px), repeating-linear-gradient(-50deg, #0003 0 1px, #0000 1px 4px); }
.sf-card .sw.yarn::after { background: repeating-linear-gradient(90deg, #0005 0 2px, #0000 2px 9px), repeating-linear-gradient(60deg, #fff4 0 3px, #0000 3px 9px); }
.sf-card .sw.scales::after { background: radial-gradient(circle at 50% 0, #0000 55%, #0006 58%, #0000 64%) 0 0/12px 9px; opacity:.9; }
.sf-card .sw.smooth::after, .sf-card .sw.glass::after { background: radial-gradient(ellipse at 30% 25%, #fffa 0 12%, #0000 30%); }
.sf-card .sw.metal::after { background: repeating-linear-gradient(0deg, #fff3 0 1px, #0000 1px 3px); }
.sf-card .sw.clay::after, .sf-card .sw.stone::after, .sf-card .sw.paper::after { background: radial-gradient(circle, #0004 1px, #0000 2px) 0 0/7px 7px; }
.sf-card .sw.fur::after { background: repeating-linear-gradient(80deg, #fff3 0 1px, #0000 1px 2px); opacity:.8; }
.sf-card .nm { display:block; padding:5px 7px 6px; font-size:11.5px; font-weight:650; line-height:1.2; }
.sf-card .ck { position:absolute; top:4px; right:4px; width:18px; height:18px; border-radius:50%; background: var(--accent, #7bd88f); color: var(--accent-ink, #08130b); display:grid; place-items:center; font-size:11px; font-weight:800; }
.sf-parts .row { grid-template-columns: 1fr 150px; }
.sf-parts .row .lbl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
`;
let cssDone = false;
const css = () => { if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; } };
let curCat: SurfaceCategory | null = null;

const kernelClass = (k: string) => (/fur/.test(k) ? 'fur' : k);
function swatchCard(id: SurfaceStyleId, on: boolean, onPick: () => void) {
  const pre = surfacePreset(id);
  const bg = pre ? `linear-gradient(135deg, ${pre.swatch[0]} 0 55%, ${pre.swatch[1]} 55% 100%)` : 'repeating-conic-gradient(#8883 0 25%, #0000 0 50%) 0 0/12px 12px';
  return h('button', { class: `sf-card ${on ? 'on' : ''}`, title: pre?.hint ?? 'The model’s own look', 'aria-pressed': String(on), onClick: onPick },
    h('div', { class: `sw ${pre ? kernelClass(pre.kernel) : ''}`, style: `background:${bg}` }), on ? h('span', { class: 'ck' }, '✓') : null,
    h('span', { class: 'nm' }, pre?.label ?? 'None (plain)'));
}

/** Edit look.surface; rebuild = the style / pattern changed (shader compile), else a live uniform update. */
function setter(app: App, p: AvatarProfile) {
  return (fn: (s: SurfaceStyle) => void, rebuild: boolean) => app.edit((q) => {
    const l = { ...(q.look ?? p.look) } as Look;
    const s: SurfaceStyle = { ...(normalizeSurface(l.surface) ?? { style: 'none' }) };
    fn(s);
    l.surface = s.style === 'none' ? undefined : s;
    q.look = l;
    if (!rebuild) app.runtime?.setLook(l);
  }, rebuild);
}

function picker(app: App, p: AvatarProfile, cur: SurfaceStyle, refresh: () => void) {
  css();
  const set = setter(app, p);
  const curPre = surfacePreset(cur.style);
  const cat = curCat ?? curPre?.category ?? 'Fabric & puppet';
  const pills = h('div', { class: 'sf-cats', role: 'tablist' }, ...CATS.map((c) => h('button', { class: `s-pill ${c.id === cat ? 'on' : ''}`, role: 'tab', 'aria-selected': String(c.id === cat), title: c.blurb, onClick: () => { curCat = c.id; refresh(); } }, `${c.icon} ${c.id}`)));
  const grid = h('div', { class: 'sf-grid' },
    swatchCard('none', cur.style === 'none', () => { set((s) => { s.style = 'none'; delete s.pattern; }, true); refresh(); }),
    ...SURFACE_STYLES.filter((s) => s.category === cat).map((s) => swatchCard(s.id, cur.style === s.id, () => { if (cur.style !== s.id) { set((x) => { x.style = s.id; delete x.pattern; }, true); refresh(); } })));
  return h('div', null, pills, grid);
}

function puppetEyes(app: App, p: AvatarProfile, cur: SurfaceStyle, refresh: () => void) {
  const pre = surfacePreset(cur.style);
  if (!pre || pre.category !== 'Fabric & puppet' || p.eyes.mode !== 'procedural' || (p.eyes.style !== 'bulb' && p.eyes.style !== 'inset')) return null;
  const v = (p.eyes.puppet ?? 'none') as string;
  const opt = (id: string, label: string) => h('button', { class: `s-pill ${v === id ? 'on' : ''}`, 'aria-pressed': String(v === id), onClick: () => { app.edit((q) => { q.eyes.puppet = id === 'none' ? null : (id as 'googly' | 'button' | 'felt'); }, true); refresh(); } }, label);
  return h('div', { class: 's-field' }, h('span', null, 'Puppet eyes'), h('div', { class: 's-pills' }, opt('none', 'Normal'), opt('googly', '👀 Googly'), opt('button', '🔘 Buttons'), opt('felt', '⚪ Felt discs')),
    h('span', { class: 'hint' }, 'Googly pupils fall with gravity and swing when you move.'));
}

function infoLine(app: App) {
  const i = app.runtime?.surfaces?.info();
  if (!i) return null;
  const n = i.materials.filter((m) => m.style && m.style !== 'none').length;
  return h('p', { class: 'note', style: 'margin:6px 0 0' }, `${n} part${n === 1 ? '' : 's'} styled${i.shells.some((s) => s.layers > 0) ? ' · fur shells on' : ''}`,
    ...i.warnings.slice(0, 2).map((w) => h('span', { style: 'display:block;color:var(--warn)' }, `⚠ ${w}`)));
}

/** Me → Simple. */
export function surfaceSimpleCard(app: App, refresh: () => void): HTMLElement | null {
  const p = app.profile;
  if (!p || !app.runtime) return null;
  const cur: SurfaceStyle = normalizeSurface(p.look?.surface) ?? { style: 'none' };
  const pre = surfacePreset(cur.style);
  const set = setter(app, p);
  const extra: (HTMLElement | null)[] = [];
  if (pre) {
    extra.push(h('p', { class: 'note', style: 'margin:8px 0 4px' }, h('b', null, pre.label), ' — ', pre.hint));
    if (pre.patterns && pre.patterns.length > 1 && pre.params.includes('pattern')) {
      const pat = cur.pattern ?? pre.patterns[0];
      extra.push(h('div', { class: 's-field' }, h('span', null, 'Pattern'), h('div', { class: 's-pills' }, ...pre.patterns.map((x) => h('button', { class: `s-pill ${x === pat ? 'on' : ''}`, onClick: () => { set((s) => (s.pattern = x), true); refresh(); } }, x)))));
    }
    if (pre.params.includes('tint')) {
      const tinted = !!cur.tint;
      const inp = h('input', { type: 'color', value: cur.tint ?? pre.swatch[0], 'aria-label': 'Colour', onInput: (e: Event) => set((s) => (s.tint = (e.target as HTMLInputElement).value), false) });
      extra.push(h('div', { class: 's-field' }, h('span', null, 'Colour'), h('div', { class: 's-row' },
        h('button', { class: `s-pill ${!tinted ? 'on' : ''}`, onClick: () => { set((s) => (s.tint = null), false); refresh(); } }, 'Model colours'),
        h('button', { class: `s-pill ${tinted ? 'on' : ''}`, onClick: () => { if (!tinted) { set((s) => (s.tint = pre.swatch[0]), false); refresh(); } } }, 'My colour'),
        tinted ? inp : null)));
    }
    extra.push(puppetEyes(app, p, cur, refresh), infoLine(app));
  }
  return h('section', { class: 's-card' }, h('h3', null, '✨ Material style'),
    h('p', { class: 'lead' }, 'Make your avatar look like a felt puppet, a plush toy, clay, scales or fur — no textures needed. Every part keeps its colours unless you pick one.'),
    picker(app, p, cur, refresh), ...extra.filter((x): x is HTMLElement => !!x));
}

/** Me → Advanced → Face → Look: the full editor (every tweak + per part). */
export function surfaceStyleSection(app: App, p: AvatarProfile, rerender: () => void): HTMLElement {
  const cur: SurfaceStyle = normalizeSurface(p.look?.surface) ?? { style: 'none' };
  const set = setter(app, p);
  const sec = section('Surface style', h('p', { class: 'note' }, 'A material for the whole avatar: felt, plush, clay, scales and more. Outfits keep their own.'), picker(app, p, cur, rerender));
  const pre = surfacePreset(cur.style);
  if (pre) {
    sec.append(h('p', { class: 'note' }, pre.hint));
    const has = (k: keyof SurfaceStyle) => pre.params.includes(k);
    if (pre.patterns && pre.patterns.length > 1 && has('pattern'))
      sec.append(select('Pattern', (cur.pattern ?? pre.patterns[0]) as string, pre.patterns.map((x) => [x, x] as [string, string]), (v) => set((s) => (s.pattern = v), true)));
    if (has('tint')) {
      sec.append(toggle('Re-colour', !!cur.tint, (v) => { set((s) => (s.tint = v ? pre.swatch[0] : null), false); rerender(); }, 'Replace the model colours (keeps light / dark detail)'));
      if (cur.tint) sec.append(color('Colour', cur.tint, (v) => set((s) => (s.tint = v), false)));
    }
    if (has('color2')) sec.append(color(pre.kernel === 'scales' ? 'Belly / plates' : 'Second colour', cur.color2 ?? pre.color2, (v) => set((s) => (s.color2 = v), false)));
    if (has('stitchColor')) sec.append(color('Stitch thread', cur.stitchColor ?? pre.stitchColor, (v) => set((s) => (s.stitchColor = v), false)));
    const num = (k: keyof SurfaceStyle, label: string, min: number, max: number, step: number, d: number, hint?: string) => {
      if (has(k)) sec.append(slider(label, (cur[k] as number | undefined) ?? d, min, max, step, (v) => set((s) => ((s as unknown as Record<string, number>)[k] = v), false), hint, { def: d }));
    };
    num('scale', 'Pattern size', 0.3, 3, 0.05, 1);
    num('relief', 'Relief', 0, 2.5, 0.05, 1);
    num('fuzz', 'Fuzz / sheen', 0, 2, 0.05, 1);
    num('variation', 'Variation', 0, 1, 0.01, pre.variation);
    num('iridescence', 'Iridescence', 0, 1, 0.01, pre.iridescence);
    num('translucency', 'Translucency', 0, 1, 0.01, pre.translucency);
    num('gloss', 'Gloss', 0, 1, 0.01, pre.gloss ?? 0.5);
    num('belly', 'Belly plates', 0, 1, 0.01, pre.belly);
    num('wear', 'Wear / chips', 0, 1, 0.01, pre.wear);
    num('boil', 'Stop-motion boil', 0, 1, 0.01, pre.boil, 'The detail re-sculpts itself 12×/s like claymation');
    num('wobble', 'Wobble', 0, 1, 0.01, pre.wobble);
    num('furLength', 'Fur length (m)', 0.002, 0.06, 0.001, pre.furLength, 'Shell fur shows on High / Ultra (or set Shells: always)');
    num('furDensity', 'Fur density', 0.2, 1, 0.01, pre.furDensity);
    num('droop', 'Droop', 0, 1, 0.01, pre.droop);
    num('wind', 'Wind sway', 0, 1, 0.01, pre.wind);
    if (has('shells')) sec.append(select('Shells', cur.shells ?? 'auto', [['auto', 'Auto — High / Ultra only'], ['always', 'Always (costs GPU on Balanced)'], ['off', 'Off']], (v) => set((s) => (s.shells = v), true)));
    if (has('stitches')) sec.append(select('Stitches', cur.stitches ?? pre.stitches, [['auto', 'Auto (authored, else UV seams)'], ['seams', 'UV seams + borders'], ['authored', 'Authored _STITCH only'], ['none', 'None']], (v) => set((s) => (s.stitches = v), true)));
    const pe = puppetEyes(app, p, cur, rerender);
    if (pe) sec.append(pe);
  }
  sec.append(partsBlock(app, p, rerender));
  const inf = infoLine(app);
  if (inf) sec.append(inf);
  return sec;
}

/** Per-part assignment (look.surfaces, keyed by material name): Default (the avatar style) / None / any style. */
function partsBlock(app: App, p: AvatarProfile, rerender: () => void): HTMLElement {
  const rt = app.runtime;
  const names = new Set<string>();
  rt?.model.traverse((o) => {
    const m = o as unknown as { isMesh?: boolean; material?: { name?: string } | { name?: string }[]; userData?: Record<string, unknown> };
    if (!m.isMesh || m.userData?.vtpOutline || m.userData?.vtpGenerated || m.userData?.vtpShell) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat?.name) names.add(mat.name);
  });
  const map = p.look?.surfaces ?? {};
  const opts: [string, string][] = [['', 'Default (avatar style)'], ['none', 'None (plain)'], ...SURFACE_STYLES.map((s) => [s.id, `${s.category.split(' ')[0]}: ${s.label}`] as [string, string])];
  const setPart = (name: string, v: string) => app.edit((q) => {
    const l = { ...(q.look ?? p.look) } as Look;
    const m = { ...(l.surfaces ?? {}) };
    if (v) m[name] = v as SurfaceStyleId; else delete m[name];
    l.surfaces = Object.keys(m).length ? m : undefined;
    q.look = l;
  }, true);
  const rows = [...names].sort().slice(0, 40).map((n) => {
    const v = map[n];
    const cur = typeof v === 'string' ? v : v?.style ?? '';
    return select(n, cur as string, opts, (x) => { setPart(n, x); rerender(); }, `Material “${n}”`);
  });
  const custom = Object.keys(map).filter((k) => !names.has(k));
  return h('details', { class: 'sf-parts' }, h('summary', null, `Per part (${Object.keys(map).length} set) — style single materials differently`),
    h('p', { class: 'note' }, 'e.g. a felt body with a fleece mane and plastic buttons. Saved as look.surfaces. Eyes, teeth, mouths and screens are always skipped.'),
    ...(rows.length ? rows : [h('p', { class: 'note' }, 'No named materials found on this model.')]),
    custom.length ? h('p', { class: 'note' }, `Also set by name / pattern in profile.json: ${custom.join(', ')}`) : null);
}
