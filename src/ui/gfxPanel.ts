// Scene tab → "Graphics quality": the OBS output's level (Auto / Performance / Balanced / High / Ultra), the studio
// preview's own level, Auto's ceiling and an Advanced fold with every effect (default / on / off). Saved with the scene
// state (host / solo: cache/scene.json → this PC's OBS pages); a party guest's choice stays on its own PC.
import type { App } from '../app.ts';
import { DEFAULT_GFX, GFX_CHOICES, GFX_DEFAULTS, GFX_EFFECTS, GFX_EFFECT_LABELS, GFX_LABELS, GFX_NAMES, GFX_SCALES, GFX_TARGET_FPS, type GfxBenchResult, type GfxChoice, type GfxEffect, type SceneGfxState } from '../../shared/graphics.ts';
import { h, section, select, toast, toggle } from './dom.ts';
import { AVATAR_DETAIL_CHOICES, AVATAR_DETAIL_LINE, AVATAR_DETAIL_NAMES, AVATAR_DETAIL_TEX_NOTE, AVATAR_DETAIL_TIPS, avatarDetailOf, type AvatarDetailChoice } from '../../shared/avatarDetail.ts';
import { isObserverTab } from './observerMode.ts';
import { previewVisible } from './previewFrame.ts';
import { lowDetailRow } from '../mobile/lowDetail.ts';
import { gfxTierLine } from './capabilityView.ts';

const CSS = `
.gfx-seg { display:flex; gap:0; margin:2px 0 8px; }
.gfx-seg .btn { flex:1 1 0; border-radius:0; padding:6px 2px; font-size:11.5px; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gfx-seg .btn:first-child { border-radius:8px 0 0 8px; } .gfx-seg .btn:last-child { border-radius:0 8px 8px 0; }
.gfx-seg .btn.on { background: var(--accent2); color:#06131a; border-color:transparent; font-weight:700; }
.gfx-seg .btn.ultra.on { background:#ff9f43; }
.gfx-warn { background:#3a2410; border:1px solid #ff9f43; color:#ffd7a8; border-radius:8px; padding:6px 9px; margin:4px 0 8px; font-size:12px; }
.gfx-fx { display:grid; grid-template-columns: 1fr 128px; gap:4px 8px; align-items:center; margin:6px 0; }
.gfx-fx select { width:100%; }
.gfx-fx .nm { font-size:12px; }
.gfx-stat { font: 11px/1.5 ui-monospace, Consolas, monospace; background:#12151b; border:1px solid var(--line); border-radius:6px; padding:5px 8px; margin:6px 0; white-space:pre-wrap; }
`;
let cssDone = false;

/** High / Ultra go through the Hardware check first (src/ui/lipsyncGuide.ts): on a computer where it is a stretch, the
 *  performer sees the exact limits and picks "Use it anyway" or "Pick the safe option" (Medium). */
function pickGfx(app: App, c: GfxChoice, set: (v: GfxChoice) => void) {
  if (c !== 'high' && c !== 'ultra') { set(c); return; }
  void import('./lipsyncGuide.ts').then((m) => m.confirmHeavy(app, c === 'high' ? 'graphics-high' : 'graphics-ultra'))
    .then((v) => set(v === 'safe' ? 'balanced' : c))
    .catch(() => set(c));
}

const WHAT: Record<string, string> = {
  performance: 'Low: no post effects, lighter NPCs (far ones become impostor cards), optional room detail hidden, never supersampled. For GTX 1060 / RX 580-class cards or a busy PC.',
  balanced: 'Medium: the standard look and cost, no post effects. The pick for GTX 1080 / RTX 3060 / RX 6600-class cards.',
  high: 'HDR post: bloom on every light, per-room colour grade, N8AO contact shadows, SMAA edges, HDRI room light + reflections, glowing haze, background blur in talk shots, rim light + highlights, soft contact shadows, animated water / skies, detailed NPCs up close.',
  ultra: 'High + supersampling (×1.5), light shafts, glossy-floor reflections, a real soft shadow for performers, detailed NPCs out to 20 m.',
  auto: 'Starts at Balanced and steps up only while the GPU has room and face tracking stays healthy; steps down the moment tracking slows.',
};

type DetailScene = { gfx: SceneGfxState; setGfx(p: Partial<SceneGfxState>): void; role: string };

/** "Avatar detail" (docs/PERFORMANCE.md): lighter versions of very detailed avatars, this PC only. The first row of
 *  Graphics quality; also shown on its own when there is no room (it applies to the classic layout too). */
export function avatarDetailRow(app: App, label = true): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene as unknown as DetailScene;
  const cur = avatarDetailOf((S.gfx ?? DEFAULT_GFX).avatarDetail);
  const seg = h('div', { class: 'gfx-seg' }, ...AVATAR_DETAIL_CHOICES.map((c: AvatarDetailChoice) =>
    h('button', { class: `btn ${cur === c ? 'on' : ''}`, title: AVATAR_DETAIL_TIPS[c], onClick: () => S.setGfx({ avatarDetail: c }) }, AVATAR_DETAIL_NAMES[c])));
  return h('div', null,
    label ? h('div', { class: 'note', style: 'margin:0 0 3px' }, h('b', null, 'Avatar detail')) : null, seg,
    h('p', { class: 'note', style: 'margin:0 0 2px' }, AVATAR_DETAIL_LINE),
    h('p', { class: 'note', style: 'margin:0 0 8px;opacity:.75' }, AVATAR_DETAIL_TEX_NOTE));
}

export function avatarDetailSection(app: App): HTMLElement {
  const S = app.scene as unknown as DetailScene;
  return section('Avatar detail', lowDetailRow(), avatarDetailRow(app, false),   // (no room: low detail matters most for 2D avatars)
    S.role === 'guest' ? h('p', { class: 'note' }, 'As a guest this setting is yours alone: it only changes YOUR OBS, not the host’s.') : null);
}

export function gfxSection(app: App): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene as unknown as { gfx: SceneGfxState; setGfx(p: Partial<SceneGfxState>): void; benchGfx(): Promise<GfxBenchResult | null>; report: { room?: unknown; gfx?: { level: string; choice: string; post: string[]; memMB: number; ratio: number; costMs: number; auto: { level: string; reason: string } | null; npc: { lod0: number; impostors: number } } } | null; role: string };
  const g = S.gfx ?? DEFAULT_GFX;
  const seg = (which: 'obs' | 'preview') => h('div', { class: 'gfx-seg' }, ...GFX_CHOICES.map((c) =>
    h('button', { class: `btn ${c === 'ultra' ? 'ultra' : ''} ${g[which] === c ? 'on' : ''}`, title: GFX_LABELS[c], onClick: () => pickGfx(app, c, (v) => S.setGfx({ [which]: v } as Partial<SceneGfxState>)) },
      c === 'ultra' ? 'Ultra ⚠' : GFX_NAMES[c])));
  const warn = (c: GfxChoice) => (c === 'ultra'
    ? h('div', { class: 'gfx-warn' }, '⚠ Ultra is heavy: supersampled, every effect on. It shares the GPU with your face tracking — if the track Hz drops, use High or Auto.')
    : null);
  // (only a preview the user can see counts as live: the hidden room-analysis preview's one report is not — review round 1)
  const st = previewVisible() ? S.report?.gfx : undefined;
  const stat = h('div', { class: 'gfx-stat' }, st
    ? `preview: ${st.level}${st.choice === 'auto' ? ` (auto — ${st.auto?.reason ?? ''})` : ''} · ×${st.ratio} · ${st.post.length ? st.post.join(' ') : 'no post'} · ${st.memMB} MB · ${st.costMs} ms CPU · NPC LOD0 ${st.npc.lod0} / impostors ${st.npc.impostors}\nface inference now: ${app.stats.inferMs.toFixed(1)} ms · tracking ${Math.round(app.stats.trackFps ?? 0)} Hz`
    : 'Turn the preview on to see what the preview renders.');
  // advanced: every effect, tri-state (only honoured on High / Ultra)
  const fx = h('div', { class: 'gfx-fx' });
  for (const e of GFX_EFFECTS as GfxEffect[]) {
    const [label, tip] = GFX_EFFECT_LABELS[e];
    const cur = g.fx[e];
    const hi = GFX_DEFAULTS.high[e], ul = GFX_DEFAULTS.ultra[e];
    const def = hi === ul ? (hi ? 'on' : 'off') : ul ? 'Ultra' : 'High';
    const sel = h('select', { title: tip, onChange: (ev: Event) => {
      const v = (ev.target as HTMLSelectElement).value;
      const next = { ...g.fx };
      if (v === 'default') delete next[e]; else next[e] = v === 'on';
      S.setGfx({ fx: next });
    } },
    h('option', { value: 'default', selected: cur === undefined }, `Default (${def})`),
    h('option', { value: 'on', selected: cur === true }, 'On'),
    h('option', { value: 'off', selected: cur === false }, 'Off'));
    fx.append(h('span', { class: 'nm', title: tip }, label), sel);
  }
  const adv = h('details', { 'data-key': 'gfx-adv' } as never,
    h('summary', { class: 'note' }, 'Advanced — individual effects (High / Ultra only)'), fx,
    h('p', { class: 'note' }, 'Performance and Balanced are fixed presets. Effects compile when you change them (a one-off hitch) — never in the middle of a show.'));
  const note = h('p', { class: 'note' }, h('b', null, 'OBS output: '), WHAT[g.obs] ?? '');
  // performance options (docs/PERFORMANCE.md): render scale per page, MSAA, auto-lower, benchmark
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  const scaleOpts = GFX_SCALES.map((v) => [String(v), v === 1 ? '100 % (preset default)' : pct(v)] as [string, string]);
  const b = g.bench;
  const benchLine = h('div', { class: 'gfx-stat' }, b
    ? `Benchmark: ${GFX_NAMES[b.pick]} recommended · ${b.cls}${b.how === 'timer' ? ` · GPU High ${b.ms.high ?? '?'} ms, Medium ${b.ms.balanced ?? '?'} ms per 1080p frame` : ' · from the GPU name (no GPU timer in this browser)'}${b.room ? ` · room ${b.room}` : ''}`
    : 'No benchmark yet: it runs by itself the first time a room is in the preview (about 10 s), or press Run benchmark.');
  const benchBtn = h('button', { class: 'btn', onClick: async (ev: Event) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    btn.disabled = true; btn.textContent = 'Benchmarking… (~10 s)';
    const r = await S.benchGfx();
    btn.disabled = false; btn.textContent = 'Run benchmark';
    if (!r) { benchLine.textContent = 'The benchmark needs the Scene preview on, with a room loaded.'; return; }
    S.setGfx({ bench: r, obs: r.pick, preview: r.pick === 'high' ? 'balanced' : r.pick });
  } }, 'Run benchmark');
  const perfOpts = h('details', { 'data-key': 'gfx-perf', open: true } as never,
    h('summary', { class: 'note' }, 'Performance options'),
    h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0' }, benchBtn, h('span', { class: 'note' }, 'Renders this room at High and Medium for ~10 s and picks the preset for this PC (never Ultra).')),
    benchLine,
    select('OBS render scale', String(g.obsScale ?? 1), scaleOpts, (v) => S.setGfx({ obsScale: Number(v) }), 'Renders the OBS picture at fewer pixels and scales it up: the biggest GPU saving after the preset itself'),
    select('Preview render scale', String(g.previewScale ?? 1), scaleOpts, (v) => S.setGfx({ previewScale: Number(v) }), 'The studio preview only'),
    select('Anti-aliasing (High / Ultra)', String(g.msaa ?? 4), [['4', 'MSAA ×4 + SMAA (default)'], ['2', 'MSAA ×2 + SMAA (faster)'], ['0', 'SMAA only (fastest)']], (v) => S.setGfx({ msaa: Number(v) as 0 | 2 | 4 }), 'Multisampling of the post-effects target. SMAA still smooths edges at every setting'),
    toggle('Lower quality automatically to keep the stream smooth', g.autoLower !== false, (v) => S.setGfx({ autoLower: v }), 'On by default. Steps down one preset when frames drop, your processor runs out of time or face tracking slows, and tells you (OK / Undo). Steps back up (never above your choice) after a minute of headroom'),
    g.autoLower !== false ? select('Target fps', String(g.targetFps ?? 60), GFX_TARGET_FPS.map((f) => [String(f), `${f} fps`] as [string, string]), (v) => S.setGfx({ targetFps: Number(v) })) : null);
  maybeFirstRunBench(app, S);
  return section('Graphics quality',
    lowDetailRow(), // "Low detail is on … Full detail" after a graphics-memory crash (src/mobile/lowDetail.ts)
    avatarDetailRow(app),
    h('div', { class: 'note', style: 'margin:0 0 3px' }, 'OBS output'), seg('obs'), gfxTierLine(), warn(g.obs), note,
    perfOpts,
    toggle('Auto may use Ultra', g.autoUltra, (v) => S.setGfx({ autoUltra: v }), 'Off: Auto tops out at High'),
    h('div', { class: 'note', style: 'margin:8px 0 3px' }, 'Studio preview (shares the GPU with the face tracker — keep it cheap)'), seg('preview'), warn(g.preview),
    stat, adv,
    S.role === 'guest' ? h('p', { class: 'note' }, 'As a guest this setting is yours alone: it only changes YOUR OBS, not the host’s.') : null,
    h('p', { class: 'note' }, 'One OBS source can also pin its own level: add ', h('code', null, '?gfx=high'), ' (low / medium / high / ultra / auto) to its URL.'));
}

/** Zero-effort: the first-run benchmark below starts by itself as soon as a room preview has reported (the Room area's
 *  picture-in-picture or any panel's preview) — the user never has to open Advanced. Registered once per studio. */
let autoBenchOn = false;
export function autoBench(app: App) {
  if (autoBenchOn) return;
  autoBenchOn = true;
  const S = app.scene as unknown as BenchScene & { on(fn: (w: string) => void): () => void };
  const off = S.on((w) => {
    if (w !== 'report') return;
    let done = false;
    try { done = !!localStorage.getItem('vtp.gfx.firstBench') || !!S.gfx?.bench; } catch { done = true; }
    if (done) { off(); return; }
    maybeFirstRunBench(app, S);
  });
}

/** First run: benchmark once (~10 s) when a room is in the preview and tracking is off. The pick is applied only while the
 *  quality is still untouched (Medium / Medium, no overrides): an existing choice is never changed, only annotated. */
let firstRunBusy = false;
type BenchScene = { gfx: SceneGfxState; setGfx(p: Partial<SceneGfxState>): void; benchGfx(): Promise<GfxBenchResult | null>; report: { room?: unknown } | null; role: string };
function maybeFirstRunBench(app: App, S: BenchScene) {
  if (firstRunBusy || S.gfx?.bench) return;
  try { if (localStorage.getItem('vtp.gfx.firstBench')) return; } catch { return; }
  const tracking = () => !!(app as unknown as { trackingOn?: boolean }).trackingOn;
  if (!S.report?.room || tracking()) return;
  // (only on a preview the user is looking at: never on the hidden room-analysis preview, src/ui/logicPreview.ts)
  if (!previewVisible()) return;
  if (isObserverTab()) return; // observer tabs never write the scene state
  firstRunBusy = true;
  setTimeout(async () => {
    try {
      if (tracking() || S.gfx?.bench) return;
      const r = await S.benchGfx();
      if (!r) return;
      try { localStorage.setItem('vtp.gfx.firstBench', String(r.at)); } catch { /* full */ }
      const g = S.gfx ?? DEFAULT_GFX;
      const untouched = g.obs === 'balanced' && g.preview === 'balanced' && !Object.keys(g.fx ?? {}).length;
      S.setGfx(untouched ? { bench: r, obs: r.pick, preview: r.pick === 'high' ? 'balanced' : r.pick } : { bench: r });
      // (zero-effort: say what was done, in one sentence)
      if (untouched) toast(`VTube Pro tested your computer and set the room quality to ${GFX_NAMES[r.pick]} for OBS. It lowers it by itself if your stream starts to stutter.`, 'ok', 7000);
    } finally { firstRunBusy = false; }
  }, 4000);
}
