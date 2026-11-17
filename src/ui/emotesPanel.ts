// Chat & events → "Emotes & emote sounds" (owner: "integrate and read custom emotes from my channels and have the option
// to have sound play every time they are active. This will be off by default"). Zero effort: the emotes of the channels
// already connected are read by the helper by themselves (server/chat/emotes.ts); this panel lists them (search, grouped
// by where they come from, how often chat used each one this stream) and gives any emote a sound:
//   · the master switch (OFF until the streamer turns it on) + the master volume;
//   · per emote: a built-in or their own sound file (kept in the helper's library), its volume, how long before it can
//     play again, and "only when N people use it within X seconds" (a hype / combo trigger);
//   · advanced: the gap between any two sounds, at most N sounds per message, ignore bots;
//   · Test = the studio plays it on the audio mixer's "Only me" output (shared/showSound.ts `only`), never on the OBS page.
// Settings: the helper's config/emote_sounds.json (GET / PUT /api/chat/emote-sounds); a Stream Deck key flips the switch.
//
// Mounted by src/ui/chatPanel.ts (one line). Polls the usage counts every 4 s while it is on screen; nothing else runs.
import type { App } from '../app.ts';
import { EMOTE_SOURCE_LABEL, emoteKey, searchEmotes, type EmoteDef, type EmoteListing, type EmoteSource, type EmoteStats } from '../../shared/emotes.ts';
import { DEFAULT_EMOTE_SOUNDS, RULE_LIMITS, sanitizeEmoteSoundCfg, type EmoteSoundCfg, type EmoteSoundRule, type UserSound } from '../../shared/emoteSounds.ts';
import { h, slider, toast, toggle } from './dom.ts';
import { studioShow } from '../audio/mixer/showSounds.ts';

/** Test plays on the audio mixer's "Only me" output. Only when that is a separate device (your headphones) is it really
 *  only for you: on "Same as the studio" a window / desktop capture in OBS hears it too, so Test waits until one is picked. */
function onlyMeOutput(): { ok: boolean; why: string } {
  const sh = studioShow();
  if (!sh) return { ok: false, why: 'Test plays in the studio window: open the studio (not a pop-out).' };
  if (!sh.sinkOk) return { ok: false, why: 'This browser can’t pick a separate output, so a test would play with the studio and a window capture in OBS would hear it too.' };
  if (!sh.meSink) return { ok: false, why: 'To test without your stream hearing it, pick your headphones as the “Only me” output (Audio mixer → Only me). On “Same as the studio” a window or desktop capture in OBS hears it too.' };
  if (sh.meFellBack) return { ok: false, why: 'Your “Only me” output isn’t available (unplugged?), so a test would play with the studio and OBS could hear it. Plug it back in or pick another in the Audio mixer.' };
  return { ok: true, why: 'Plays only on your “Only me” output (your headphones), never on your stream.' };
}

const CSS = `
.emo { display:grid; gap:8px; }
.emo-st { font-size:12px; color:var(--dim, #9aa4b8); display:flex; flex-wrap:wrap; gap:4px 10px; align-items:center; }
.emo-st .chip { padding:2px 8px; border-radius:99px; background:var(--card2, #1b2130); border:1px solid var(--line2, #3a4254); color:var(--text, #e8ecf4); }
.emo-st .chip.err { border-color:#e9c440; }
.emo-err { font-size:12px; margin:0; color:var(--text, #e8ecf4); background:color-mix(in srgb, #e9c440 12%, var(--card2, #1b2130)); border:1px solid #e9c44088; border-radius:8px; padding:5px 8px; }
.emo-master { display:grid; gap:4px; padding:8px 10px; border-radius:10px; border:1px solid var(--line2, #3a4254); background:var(--card2, #1b2130); }
.emo-master.on { border-color:var(--accent2, #6cc7f5); }
.emo-master p { margin:0; font-size:12px; color:var(--dim, #9aa4b8); }
.emo-tabs { display:flex; flex-wrap:wrap; gap:4px; }
.emo-tabs button { font:inherit; font-size:12px; padding:4px 10px; border-radius:99px; border:1px solid var(--line2, #3a4254); background:var(--card2, #1b2130); color:var(--text, #e8ecf4); cursor:pointer; }
.emo-tabs button[aria-pressed="true"] { background:var(--accent2, #6cc7f5); color:#06131a; border-color:transparent; font-weight:700; }
.emo-q { width:100%; box-sizing:border-box; }
.emo-grp { font:700 11.5px/1.2 Inter, system-ui, sans-serif; color:var(--dim, #9aa4b8); margin:6px 0 2px; text-transform:uppercase; letter-spacing:.04em; }
.emo-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(74px, 1fr)); gap:5px; }
.emo-t { position:relative; display:grid; justify-items:center; gap:2px; padding:6px 3px 4px; border-radius:8px; border:1px solid var(--line2, #3a4254); background:var(--card2, #1b2130); color:var(--text, #e8ecf4); cursor:pointer; font:inherit; min-width:0; }
.emo-t[aria-pressed="true"] { border-color:var(--accent2, #6cc7f5); box-shadow:0 0 0 1px var(--accent2, #6cc7f5) inset; }
.emo-t img { width:32px; height:32px; object-fit:contain; }
.emo-t .nm { font-size:10.5px; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.emo-t .n { position:absolute; left:3px; top:2px; font:700 9.5px/1.3 Inter, system-ui, sans-serif; background:var(--accent, #a78bfa); color:#fff; border-radius:6px; padding:0 4px; }
.emo-t .snd { position:absolute; right:3px; top:1px; font-size:11px; }
.emo-t .snd.off { opacity:.4; }
.emo-ed { display:grid; gap:6px; padding:8px 10px; border-radius:10px; border:1px solid var(--accent2, #6cc7f5); background:var(--card2, #1b2130); }
.emo-ed .hd { display:flex; gap:10px; align-items:center; }
.emo-ed .hd img { width:48px; height:48px; object-fit:contain; }
.emo-ed .hd b { font-size:14px; } .emo-ed .hd small { display:block; color:var(--dim, #9aa4b8); font-size:11.5px; }
.emo-ed .rowx { display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:12.5px; }
.emo-ed select { max-width:100%; }
.emo-ed input[type=number] { width:64px; }
.emo-more { justify-self:start; }
.emo-note { font-size:12px; color:var(--dim, #9aa4b8); margin:0; }
`;
let cssDone = false;

type Tab = 'mine' | 'global' | 'seen' | 'used' | 'sounds';
interface SoundsView { cfg: EmoteSoundCfg; sounds: UserSound[]; builtins: { id: string; label: string }[]; last?: { at: number; key: string }[] }
const imgSrc = (u: string) => (u.startsWith('/') ? u : `/api/chat/img?u=${encodeURIComponent(u)}`);
const j = async <T>(r: Response): Promise<T> => { if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).error ?? m; } catch { /* */ } throw new Error(m); } return r.json() as Promise<T>; };
const ago = (t: number) => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const ORDER: EmoteSource[] = ['kick', 'twitch', 'youtube', '7tv', 'bttv', 'ffz'];

export function emotesSection(app: App): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const observer = app.scene.observer;
  const canEdit = () => app.scene.canEdit && !observer;
  const root = h('div', { class: 'emo', 'data-emotes': '1' });
  let listing: EmoteListing | null = null, stats: EmoteStats | null = null, sounds: SoundsView | null = null;
  let err = '', tab: Tab = 'mine', q = '', sel: string | null = null, limit = 180, busy = false;

  const load = async () => {
    try {
      const [l, s, v] = await Promise.all([fetch('/api/chat/emotes').then((r) => j<EmoteListing>(r)), fetch('/api/chat/emotes/stats').then((r) => j<EmoteStats>(r)), fetch('/api/chat/emote-sounds').then((r) => j<SoundsView>(r))]);
      listing = l; stats = s; sounds = { ...v, cfg: sanitizeEmoteSoundCfg(v.cfg) }; err = '';
    } catch { err = 'Emotes come from VTube Pro on this PC. Start it, and your channels’ emotes show up here by themselves.'; }
    paint();
  };
  const saveCfg = async (next: EmoteSoundCfg, quiet = true) => {
    if (!canEdit()) { toast(observer ? 'Observer: emote sounds are not saved' : 'The host sets emote sounds', 'warn'); return; }
    if (sounds) sounds = { ...sounds, cfg: sanitizeEmoteSoundCfg(next) };
    paint();
    try { const v = await fetch('/api/chat/emote-sounds', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) }).then((r) => j<SoundsView>(r)); sounds = { ...v, cfg: sanitizeEmoteSoundCfg(v.cfg) }; if (!quiet) toast('Saved', 'ok', 1200); }
    catch (e) { toast(`Couldn’t save: ${(e as Error).message}`, 'err'); }
  };
  let saveT = 0;
  const saveSoon = (next: EmoteSoundCfg) => { if (sounds) sounds = { ...sounds, cfg: next }; clearTimeout(saveT); saveT = window.setTimeout(() => void saveCfg(next), 350); };
  const cfg = () => sounds?.cfg ?? DEFAULT_EMOTE_SOUNDS;
  const ruleOf = (key: string) => cfg().rules.find((r) => r.key === key) ?? null;
  const setRule = (r: EmoteSoundRule | null, key: string) => { const rules = cfg().rules.filter((x) => x.key !== key); saveSoon({ ...cfg(), rules: r ? [...rules, r] : rules }); };
  const test = async (snd: string, gain: number) => {
    if (observer) { toast('Observer: no sound', 'warn'); return; }
    const out = onlyMeOutput();
    if (!out.ok) { toast(out.why, 'warn', 5000); return; }
    try { await fetch('/api/chat/emote-sounds/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snd, gain }) }).then((r) => j(r)); toast('Playing on your “Only me” output (your headphones)', 'info', 1800); }
    catch (e) { toast((e as Error).message, 'err'); }
  };
  const upload = async (f: File): Promise<string | null> => {
    if (!canEdit()) return null;
    if (f.size > 3 << 20) { toast('That sound is bigger than 3 MB: use a shorter clip', 'err'); return null; }
    try { const v = await fetch(`/api/chat/emote-sounds/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f }).then((r) => j<SoundsView & { added: string }>(r)); sounds = { ...v, cfg: sanitizeEmoteSoundCfg(v.cfg) }; toast('Sound added', 'ok', 1500); return v.added; }
    catch (e) { toast((e as Error).message, 'err'); return null; }
  };

  // ---------------------------------------------------------------- painting
  const all = (): EmoteDef[] => listing?.emotes ?? [];
  const useOf = (key: string) => stats?.top.find((u) => u.key === key)?.n ?? 0;
  function visible(): { group: string; list: EmoteDef[] }[] {
    const by = (pred: (e: EmoteDef) => boolean) => searchEmotes(all().filter(pred), q);
    const grouped = (list: EmoteDef[], scopeWord: string) => ORDER.map((src) => ({ group: `${EMOTE_SOURCE_LABEL[src]}${scopeWord}`, list: list.filter((e) => e.src === src) })).filter((g) => g.list.length);
    if (tab === 'mine') return grouped(by((e) => e.scope === 'channel'), ' · your channel');
    if (tab === 'global') return grouped(by((e) => e.scope === 'global'), ' · everyone');
    if (tab === 'seen') return grouped(by((e) => e.scope === 'seen'), ' · seen in your chat');
    if (tab === 'sounds') { const keys = new Set(cfg().rules.map((r) => r.key)); const list = by((e) => keys.has(emoteKey(e))); const missing = cfg().rules.filter((r) => !list.some((e) => emoteKey(e) === r.key)).map((r): EmoteDef => ({ id: r.key.split(':').slice(1).join(':'), name: r.name, src: r.key.split(':')[0] as EmoteSource, url: r.url ?? '', scope: 'seen' })); return [{ group: 'With a sound', list: [...list, ...searchEmotes(missing, q)] }]; }
    // used this stream: from the counts (emotes that are in no list still show)
    const known = new Map(all().map((e) => [emoteKey(e), e]));
    const list = (stats?.top ?? []).map((u) => known.get(u.key) ?? { id: u.key.split(':').slice(1).join(':'), name: u.name, src: u.key.split(':')[0] as EmoteSource, url: u.url, scope: 'seen' as const });
    return [{ group: `Used this stream (${stats?.total ?? 0} in all)`, list: searchEmotes(list, q) }];
  }
  function tile(e: EmoteDef) {
    const key = emoteKey(e), r = ruleOf(key), n = useOf(key);
    return h('button', { class: 'emo-t', type: 'button', 'aria-pressed': String(sel === key), 'data-key': key, title: `${e.name} · ${EMOTE_SOURCE_LABEL[e.src]}${e.sub ? ' (subscribers)' : ''}${n ? ` · used ${n}× this stream` : ''}${r ? ' · has a sound' : ''}`, onClick: () => { sel = sel === key ? null : key; paint(); } },
      e.url ? h('img', { src: imgSrc(e.url), alt: e.name, loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' }) : h('span', { style: 'height:32px' }, '?'),
      h('span', { class: 'nm' }, e.name),
      n ? h('span', { class: 'n' }, String(n)) : null,
      r ? h('span', { class: `snd ${r.on ? '' : 'off'}`, 'aria-label': r.on ? 'has a sound' : 'sound off' }, '🔊') : null);
  }
  function soundOptions(cur: string): HTMLSelectElement {
    const v = sounds;
    const s = h('select', { 'aria-label': 'Sound', disabled: !canEdit() },
      h('optgroup', { label: 'Built in' }, ...(v?.builtins ?? []).map((b) => h('option', { value: `b:${b.id}`, selected: cur === `b:${b.id}` }, b.label))),
      ...(v?.sounds.length ? [h('optgroup', { label: 'Your sounds' }, ...v.sounds.map((u) => h('option', { value: `u:${u.id}`, selected: cur === `u:${u.id}` }, u.name)))] : []),
      h('option', { value: '+add' }, 'Add your own sound…'));
    return s;
  }
  function editor(key: string) {
    const e = all().find((x) => emoteKey(x) === key) ?? null;
    const r = ruleOf(key);
    const name = e?.name ?? r?.name ?? key, url = e?.url ?? r?.url ?? '';
    const base: EmoteSoundRule = r ?? { key, name, ...(url && /^https:/.test(url) ? { url } : {}), snd: 'b:pop', vol: 1, cd: 5, combo: null, on: true };
    const file = h('input', { type: 'file', accept: 'audio/*,.mp3,.ogg,.wav,.m4a,.webm,.flac', style: 'display:none' });
    const pickSnd = soundOptions(base.snd);
    pickSnd.addEventListener('change', () => {
      if (pickSnd.value === '+add') { pickSnd.value = base.snd; file.click(); return; }
      setRule({ ...base, snd: pickSnd.value }, key);
    });
    file.addEventListener('change', async () => { const f = file.files?.[0]; if (!f) return; const added = await upload(f); if (added) setRule({ ...base, snd: added }, key); });
    const num = (label: string, v: number, lo: number, hi: number, set: (n: number) => void, unit: string, title: string) =>
      h('label', { class: 'rowx', title }, label, h('input', { type: 'number', min: lo, max: hi, step: 1, value: v, disabled: !canEdit(), onChange: (ev: Event) => { const n = parseFloat((ev.target as HTMLInputElement).value); if (Number.isFinite(n)) set(Math.min(hi, Math.max(lo, n))); } }), unit);
    const src = e ? EMOTE_SOURCE_LABEL[e.src] : EMOTE_SOURCE_LABEL[key.split(':')[0] as EmoteSource] ?? '';
    return h('div', { class: 'emo-ed', 'data-editor': key },
      h('div', { class: 'hd' }, url ? h('img', { src: imgSrc(url), alt: name }) : null, h('div', null, h('b', null, name), h('small', null, `${src}${e?.scope === 'channel' ? ' · your channel' : e?.scope === 'global' ? ' · everyone' : ''}${useOf(key) ? ` · used ${useOf(key)}× this stream` : ''}`))),
      !r ? h('div', { class: 'rowx' }, h('button', { class: 'btn primary', 'data-act': 'add-sound', disabled: !canEdit(), onClick: () => setRule(base, key) }, '🔊 Give this emote a sound'))
        : h('div', { style: 'display:grid; gap:6px' },
          h('div', { class: 'rowx' }, 'Sound', pickSnd, file,
            ((o) => h('button', { class: 'btn', 'data-act': 'test', disabled: !o.ok, title: o.why, onClick: () => void test(r.snd, Math.min(1.5, r.vol * cfg().vol)) }, '▶ Test (only me)'))(onlyMeOutput())),
          ((o) => o.ok ? null : h('p', { class: 'emo-note', 'data-hint': 'only-me' }, o.why, ' ',
            h('button', { class: 'btn', 'data-act': 'open-mixer', onClick: () => void import('./audioMixerPanel.ts').then((m) => m.openAudioMixer()) }, 'Open the Audio mixer')))(onlyMeOutput()),
          slider('Volume', r.vol, RULE_LIMITS.vol[0], RULE_LIMITS.vol[1], 0.05, (v) => setRule({ ...r, vol: v }, key), 'This emote’s volume (× the master volume)', { scale: 100, unit: '%', commit: true, def: 1, disabled: !canEdit() }),
          num('Wait', r.cd, RULE_LIMITS.cd[0], RULE_LIMITS.cd[1], (n) => setRule({ ...r, cd: n }, key), 's before it can play again', 'So a chat spamming it doesn’t play it non-stop'),
          toggle('Only when several people use it (hype)', !!r.combo, (v) => setRule({ ...r, combo: v ? { n: 3, secs: 10 } : null }, key), 'Plays once enough different people used it within the time (a combo)'),
          r.combo ? h('div', { class: 'rowx' },
            num('', r.combo.n, RULE_LIMITS.comboN[0], RULE_LIMITS.comboN[1], (n) => setRule({ ...r, combo: { ...r.combo!, n } }, key), 'people', 'How many different people'),
            num('within', r.combo.secs, RULE_LIMITS.comboSecs[0], RULE_LIMITS.comboSecs[1], (n) => setRule({ ...r, combo: { ...r.combo!, secs: n } }, key), 'seconds', 'Within this many seconds')) : null,
          h('div', { class: 'rowx' },
            toggle('This sound is on', r.on, (v) => setRule({ ...r, on: v }, key)),
            h('button', { class: 'btn', 'data-act': 'remove', disabled: !canEdit(), onClick: () => { setRule(null, key); } }, 'Remove the sound'))),
      !cfg().on && r ? h('p', { class: 'emo-note' }, 'Emote sounds are switched off (above): turn them on to hear this one when chat uses it.') : null);
  }
  function paint() {
    if (!root.isConnected && root.childNodes.length) return;
    const ae = document.activeElement as HTMLInputElement | null;
    const typing = ae?.classList?.contains('emo-q');
    if (err) { root.replaceChildren(h('p', { class: 'emo-note' }, err), h('button', { class: 'btn emo-more', onClick: () => void load() }, 'Try again')); return; }
    if (!listing || !sounds) { root.replaceChildren(h('p', { class: 'emo-note' }, 'Reading your channels’ emotes…')); return; }
    const c = cfg();
    // ---- where they come from
    const st = h('div', { class: 'emo-st' },
      ...listing.sets.filter((s) => s.count || s.error).map((s) => h('span', { class: `chip ${s.error ? 'err' : ''}`, title: s.error ?? `${s.count} emotes · read ${ago(s.at)}` }, `${s.label}: ${s.count}`)),
      h('span', null, listing.refreshing ? 'Reading…' : `Updated ${ago(listing.at)}`),
      h('button', { class: 'btn', 'data-act': 'refresh', disabled: busy || observer, onClick: async () => { busy = true; paint(); try { listing = await fetch('/api/chat/emotes/refresh', { method: 'POST' }).then((r) => j<EmoteListing>(r)); } catch (e) { toast((e as Error).message, 'err'); } busy = false; paint(); } }, busy ? 'Reading…' : 'Refresh'));
    const errs = listing.sets.filter((s) => s.error);
    const noneConfigured = !listing.sets.some((s) => s.scope === 'channel');
    // ---- the master switch
    const master = h('div', { class: `emo-master ${c.on ? 'on' : ''}`, 'data-master': c.on ? 'on' : 'off' },
      toggle('Play a sound when chat uses an emote', c.on, (v) => void saveCfg({ ...cfg(), on: v }, false), 'Off by default. Only the emotes you give a sound play one.'),
      c.on ? slider('Master volume', c.vol, 0, 1, 0.05, (v) => saveSoon({ ...cfg(), vol: v }), 'Every emote sound × this', { scale: 100, unit: '%', commit: true, def: DEFAULT_EMOTE_SOUNDS.vol, disabled: !canEdit() }) : null,
      h('p', null, c.rules.length ? `${c.rules.filter((r) => r.on).length} emote${c.rules.filter((r) => r.on).length === 1 ? '' : 's'} with a sound. ` : 'Click an emote below, then “Give this emote a sound”. ',
        'Sounds play in your studio window (your stream hears them like your guests: Desktop Audio). Stream Deck: “Emote sounds on / off”.'));
    // ---- tabs + search + grid
    const tabs: [Tab, string][] = [['mine', 'Your channels'], ['used', 'Used this stream'], ['sounds', `With a sound (${c.rules.length})`], ['global', 'Everyone’s'], ['seen', 'Seen in chat']];
    const tabEl = h('div', { class: 'emo-tabs', role: 'tablist' }, ...tabs.map(([t, l]) => h('button', { type: 'button', role: 'tab', 'aria-pressed': String(tab === t), 'data-tab': t, onClick: () => { tab = t; limit = 180; paint(); } }, l)));
    const search = h('input', { class: 'emo-q', type: 'search', placeholder: 'Search emotes', value: q, 'aria-label': 'Search emotes', onInput: (ev: Event) => { q = (ev.target as HTMLInputElement).value; limit = 180; paint(); } });
    const groups = visible();
    let shown = 0;
    const gridEls: Node[] = [];
    for (const g of groups) {
      if (shown >= limit) break;
      const list = g.list.slice(0, limit - shown);
      shown += list.length;
      gridEls.push(h('div', { class: 'emo-grp' }, `${g.group} (${g.list.length})`), h('div', { class: 'emo-grid' }, ...list.map(tile)));
    }
    const total = groups.reduce((a, g) => a + g.list.length, 0);
    const empty = !total ? h('p', { class: 'emo-note' }, q ? `No emote called “${q}”.`
      : tab === 'mine' ? (noneConfigured ? 'Connect your chat (Set up my chat & stream, above) and your channels’ emotes show up here by themselves.' : 'Your channels have no emotes of their own here yet (or they are still being read).')
      : tab === 'used' ? 'Nothing yet: emotes chat uses during this stream are counted here.'
      : tab === 'sounds' ? 'No emote has a sound yet: click an emote, then “Give this emote a sound”.'
      : tab === 'seen' ? 'Twitch, Kick and YouTube member emotes appear here once someone uses them in your chat.' : 'Nothing here.') : null;
    const ed = sel ? editor(sel) : null;
    // advanced
    const adv = h('details', null, h('summary', null, 'More emote sound settings'),
      h('div', { style: 'display:grid; gap:6px; margin-top:6px' },
        slider('Gap between sounds', c.gcd, RULE_LIMITS.gcd[0], 10, 0.5, (v) => saveSoon({ ...cfg(), gcd: v }), 'At least this long between any two emote sounds', { unit: 's', commit: true, def: DEFAULT_EMOTE_SOUNDS.gcd, hard: [0, RULE_LIMITS.gcd[1]], disabled: !canEdit() }),
        slider('Sounds per message', c.maxPerMsg, 1, 5, 1, (v) => saveSoon({ ...cfg(), maxPerMsg: Math.round(v) }), 'A message with several emotes plays at most this many', { commit: true, def: 1, disabled: !canEdit() }),
        slider('Same person again after', c.userCd, 0, 120, 5, (v) => saveSoon({ ...cfg(), userCd: Math.round(v) }), 'One viewer can’t set off sounds faster than this (0 = no limit)', { unit: 's', commit: true, def: DEFAULT_EMOTE_SOUNDS.userCd, hard: [0, RULE_LIMITS.userCd[1]], disabled: !canEdit() }),
        slider('At most (per 10 s)', c.burst.n, 1, 10, 1, (v) => saveSoon({ ...cfg(), burst: { n: Math.round(v), secs: 10 } }), 'All emotes together: no more sounds than this in 10 seconds', { commit: true, def: DEFAULT_EMOTE_SOUNDS.burst.n, disabled: !canEdit() }),
        slider('Pause during raids above', c.flood, 0, 200, 5, (v) => saveSoon({ ...cfg(), flood: Math.round(v) }), 'No emote sounds while chat is faster than this many messages in 10 s (0 = never pause)', { unit: ' msgs', commit: true, def: DEFAULT_EMOTE_SOUNDS.flood, hard: [0, RULE_LIMITS.flood[1]], disabled: !canEdit() }),
        toggle('Only subscribers / members', c.subsOnly, (v) => void saveCfg({ ...cfg(), subsOnly: v }), 'Only people with a subscriber, member, VIP or moderator badge set sounds off'),
        toggle('Ignore bots', c.ignoreBots, (v) => void saveCfg({ ...cfg(), ignoreBots: v }), 'Nightbot, StreamElements, Botrix … and your “More bots” list never trigger a sound'),
        h('button', { class: 'btn emo-more', 'data-act': 'reset-stats', disabled: observer, onClick: async () => { try { stats = await fetch('/api/chat/emotes/stats/reset', { method: 'POST' }).then((r) => j<EmoteStats>(r)); paint(); } catch (e) { toast((e as Error).message, 'err'); } } }, 'Start counting again (new stream)')));
    root.replaceChildren(st, ...errs.map((s) => h('p', { class: 'emo-err' }, `${s.label}: ${s.error}`)), master, tabEl, search, ed ?? '', ...gridEls, empty ?? '',
      total > shown ? h('button', { class: 'btn emo-more', onClick: () => { limit += 300; paint(); } }, `Show ${Math.min(300, total - shown)} more`) : '', adv);
    if (typing) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  // usage counts while the panel is on screen (and the helper's list once it has read the sets)
  const timer = window.setInterval(async () => {
    if (!root.isConnected) { if (started) window.clearInterval(timer); return; }
    started = true;
    if (document.hidden || err) return;
    try {
      const s = await fetch('/api/chat/emotes/stats').then((r) => j<EmoteStats>(r));
      const changed = JSON.stringify(s.top.map((u) => [u.key, u.n])) !== JSON.stringify(stats?.top.map((u) => [u.key, u.n]));
      stats = s;
      let relisted = false;
      if (listing?.refreshing || !listing?.at) { const l = await fetch('/api/chat/emotes').then((r) => j<EmoteListing>(r)); relisted = l.at !== listing?.at || l.emotes.length !== listing?.emotes.length || l.refreshing !== listing?.refreshing; listing = l; }
      const ae = document.activeElement;
      if ((changed || relisted) && !(ae && root.contains(ae) && ae.tagName !== 'BUTTON')) paint();
    } catch { /* VTube Pro restarts: next tick */ }
  }, 4000);
  let started = false;
  paint();
  void load();
  const wrap = h('div', null, h('h4', { style: 'margin:14px 0 4px' }, 'Emotes & emote sounds'), root);
  return wrap;
}
