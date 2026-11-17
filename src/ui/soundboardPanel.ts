// Live > Stream extras > "Sounds & screen effects" (beta.16 "soundfx" lane, docs/b16/SOUNDFX.md). Zero-effort screen:
//   1. one switch: "Play sounds on my stream" (OFF until you turn it on) + a volume;
//   2. the sounds: 7 built in, 12 CC0 starter stings, your own (drop a file); press a name to play it, 🎧 to hear it only on
//      your headphones, a volume for each;
//   3. "Do it when…": an emote starts / an outfit goes on / a redeem is used -> play a sound and/or fire a screen effect;
//   4. "Scream": loud for a moment -> a sound and/or an effect, set from your own voice with one button;
//   5. screen effects: glitch, old tape (VHS), pixelate, shake, glow pop, black & white, for N seconds (press to try).
// Sounds play in the studio window (your stream hears it through Desktop Audio, like your guests: docs/SOUND.md); the OBS
// page is silent by design. Nothing here makes a sound until the streamer presses a button.
import { h, toast } from './dom.ts';
import type { SoundfxApi } from '../audio/soundfxMount.ts';
import {
  FX_PRESETS, MAX_SOUND_BYTES, MAX_SOUND_SECS, levelFromPeak, type CueWhen, type FxPick, type FxPresetId, type SoundCue, type SoundboardCfg, newCueId,
} from '../../shared/soundboard.ts';

const CSS = `
.sbx { display:grid; gap:10px; font-size:13px; }
.sbx h4 { margin:0; font:700 12px/1.2 Inter, system-ui, sans-serif; text-transform:uppercase; letter-spacing:.04em; color:var(--dim, #9aa4b8); }
.sbx p { margin:0; color:var(--dim, #9aa4b8); font-size:12px; line-height:1.4; }
.sbx .card { display:grid; gap:6px; padding:9px 11px; border-radius:10px; border:1px solid var(--line2, #3a4254); background:var(--card2, #1b2130); }
.sbx .card.on { border-color:var(--accent2, #6cc7f5); }
.sbx .warn { color:var(--text, #e8ecf4); background:color-mix(in srgb, #e9c440 12%, var(--card2, #1b2130)); border:1px solid #e9c44088; border-radius:8px; padding:6px 9px; }
.sbx .rowx { display:flex; flex-wrap:wrap; gap:6px 8px; align-items:center; }
.sbx .grow { flex:1 1 140px; min-width:0; }
.sbx button { font:inherit; font-size:12.5px; padding:4px 10px; border-radius:99px; border:1px solid var(--line2, #3a4254); background:var(--card2, #1b2130); color:var(--text, #e8ecf4); cursor:pointer; }
.sbx button:hover:not(:disabled) { border-color:var(--accent2, #6cc7f5); }
.sbx button:disabled { opacity:.45; cursor:default; }
.sbx button.pri { background:var(--accent2, #6cc7f5); color:#06131a; border-color:transparent; font-weight:700; }
.sbx select, .sbx input[type=text], .sbx input[type=number] { font:inherit; font-size:12.5px; max-width:100%; }
.sbx input[type=text] { flex:1 1 150px; min-width:120px; }
.sbx .snd { display:grid; grid-template-columns:minmax(0,1fr) 92px auto auto; gap:6px; align-items:center; }
.sbx .snd .nm { text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border-radius:8px; }
.sbx .snd input[type=range] { width:100%; }
.sbx .snd.played .nm { border-color:var(--accent2, #6cc7f5); }
.sbx .cue { display:flex; flex-wrap:wrap; gap:4px 8px; align-items:center; padding:5px 8px; border-radius:8px; border:1px solid var(--line2, #3a4254); }
.sbx .cue.off { opacity:.55; }
.sbx .cue .tx { flex:1 1 200px; min-width:0; }
.sbx .fxg { display:grid; grid-template-columns:repeat(auto-fill, minmax(128px, 1fr)); gap:6px; }
.sbx .fxg button { display:grid; justify-items:start; gap:1px; border-radius:10px; padding:6px 9px; text-align:left; }
.sbx .fxg button small { color:var(--dim, #9aa4b8); font-size:10.5px; white-space:normal; line-height:1.25; }
.sbx .meter { height:8px; border-radius:99px; background:var(--card, #131824); border:1px solid var(--line2, #3a4254); overflow:hidden; position:relative; flex:1 1 140px; }
.sbx .meter i { position:absolute; inset:0 auto 0 0; width:0; background:var(--accent2, #6cc7f5); }
.sbx .meter b { position:absolute; top:-1px; bottom:-1px; width:2px; background:#e9c440; }
.sbx .drop { border:1px dashed var(--line2, #3a4254); border-radius:10px; padding:8px; text-align:center; color:var(--dim, #9aa4b8); }
.sbx .drop.over { border-color:var(--accent2, #6cc7f5); color:var(--text, #e8ecf4); }
`;
let cssDone = false;

const WHEN_LABEL: Record<CueWhen['kind'], string> = { emote: 'An emote starts', outfit: 'An outfit goes on', redeem: 'A redeem is used' };

/** How long the clip is (null = this browser can't read it). Uses an offline context: it never plays. */
async function clipSeconds(f: File): Promise<number | null> {
  try {
    const Ctx = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!Ctx) return null;
    const ac = new Ctx(1, 1, 44100);
    const b = await ac.decodeAudioData(await f.arrayBuffer());
    return b.duration;
  } catch { return null; }
}

export function drawSoundboard(host: HTMLElement, api: SoundfxApi): () => void {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const root = h('div', { class: 'sbx', 'data-soundboard': '1' });
  host.append(root);
  let emotes: { id: string; label: string }[] = [];
  let draft: { kind: CueWhen['kind']; target: string; sound: string; fx: '' | FxPresetId; secs: number } = { kind: 'emote', target: '', sound: 'sy_tada', fx: '', secs: 3 };
  let fxSecs = 3;
  let fxMsg = '';
  let lastPlayed = '';
  let dead = false;
  let saveT = 0;
  let pending: SoundboardCfg | null = null;
  void import('../avatar/emotes.ts').then((m) => { emotes = m.EMOTES.map((e) => ({ id: e.id, label: e.label })); if (!dead) paint(); }).catch(() => { /* none */ });

  const cfg = () => pending ?? api.cfg();
  const fail = (e: unknown) => toast((e as Error).message || 'That did not work', 'err');
  const saveNow = (next: SoundboardCfg) => { pending = null; return api.save(next).catch(fail).finally(() => { if (!dead) paint(); }); };
  const saveSoon = (next: SoundboardCfg) => { pending = next; clearTimeout(saveT); saveT = window.setTimeout(() => { const n = pending; pending = null; if (n) void api.save(n).catch(fail); }, 300); };
  const soundName = (id: string) => api.sounds().find((s) => s.id === id)?.name ?? (id ? 'a sound that is gone' : '');
  const soundSelect = (cur: string, none: string, onPick: (id: string) => void) => {
    const s = api.sounds();
    const g = (label: string, k: string) => { const l = s.filter((x) => x.kind === k); return l.length ? h('optgroup', { label }, ...l.map((x) => h('option', { value: x.id, selected: cur === x.id }, x.name))) : null; };
    return h('select', { 'aria-label': 'Sound', onChange: (e: Event) => onPick((e.target as HTMLSelectElement).value) },
      h('option', { value: '', selected: !cur }, none), g('Your sounds', 'mine'), g('Built in', 'synth'), g('Starter stings', 'sting'));
  };
  const fxSelect = (cur: string, onPick: (p: '' | FxPresetId) => void) => h('select', { 'aria-label': 'Screen effect', onChange: (e: Event) => onPick((e.target as HTMLSelectElement).value as '' | FxPresetId) },
    h('option', { value: '', selected: !cur }, 'no effect'), ...FX_PRESETS.map((p) => h('option', { value: p.id, selected: cur === p.id }, p.label)));

  // ---------------------------------------------------------------- actions
  const play = async (id: string) => {
    if (!cfg().on) { toast('Sounds are off. Switch on “Play sounds on my stream” first.', 'warn'); return; }
    const v = await api.play(id);
    lastPlayed = v === 'played' ? id : '';
    const why: Record<string, string> = {
      nolead: 'This window is not the one that plays sound (another studio window is, or the browser has not started sound yet: click once in the studio).',
      again: 'Just played: wait a moment.', busy: 'Four sounds are already playing.', rate: 'That is a lot of sounds in a minute: waiting a bit.', quiet: 'The volume is at zero.', missing: 'That sound could not be loaded.',
    };
    if (v !== 'played' && v !== 'off') toast(why[v] ?? 'Could not play it', 'warn', 4500);
    paint();
  };
  const hear = (id: string) => { const r = api.test(id); if (!r.ok) toast(r.why, 'warn', 6000); else toast(r.why, 'info', 2200); };
  const addFile = async (f: File) => {
    if (f.size > MAX_SOUND_BYTES) { toast(`“${f.name}” is bigger than 3 MB: use a shorter clip.`, 'err'); return; }
    const secs = await clipSeconds(f);
    if (secs !== null && secs > MAX_SOUND_SECS) { toast(`“${f.name}” is ${Math.round(secs)} s long. Stings can be ${MAX_SOUND_SECS} s at most.`, 'err'); return; }
    try { await api.upload(f); toast('Sound added', 'ok', 1400); } catch (e) { fail(e); }
    if (!dead) paint();
  };
  const fire = (p: FxPresetId) => {
    const r = api.fireFx(p, fxSecs);
    fxMsg = r === 'limited' ? 'Too soon after the last glow: the flash-safety limit waits a moment.' : 'Running…';
    paint();
    window.setTimeout(() => {
      if (dead) return;
      const via = api.fxVia(p);
      fxMsg = r === 'limited' ? fxMsg
        : via === 'none' ? (p === 'pixelate' ? 'Pixelate needs Graphics: High or Ultra (Settings → Graphics).' : 'This page could not show the effect.')
        : via === 'css' ? 'Shown. (This graphics level uses the light version; High and Ultra look richer.)' : 'Shown.';
      paint();
    }, 700);
  };

  // ---------------------------------------------------------------- painting
  function paint() {
    if (dead) return;
    const c = cfg();
    const mine = api.sounds().filter((s) => s.kind === 'mine');
    const rows: (HTMLElement | null)[] = [];

    if (api.helper === 'down') rows.push(h('div', { class: 'warn' }, 'VTube Pro on this PC is not answering, so sounds can’t be saved or loaded. Start it, then ', h('button', { onClick: () => void api.load().then(paint) }, 'Try again')));
    if (api.observer) rows.push(h('div', { class: 'warn' }, 'This is a read-only tab: nothing here is saved and nothing plays.'));

    // 1. master
    rows.push(h('div', { class: `card ${c.on ? 'on' : ''}` },
      h('label', { class: 'rowx' },
        h('input', { type: 'checkbox', checked: c.on, disabled: api.observer || api.helper !== 'ok', 'aria-label': 'Play sounds on my stream', onChange: (e: Event) => void saveNow({ ...cfg(), on: (e.target as HTMLInputElement).checked }) }),
        h('b', null, 'Play sounds on my stream')),
      h('p', null, c.on
        ? 'On. Sounds play from this studio window, and OBS hears them the same way it hears your guests (Desktop Audio). Nothing plays on the OBS page itself.'
        : 'Off, so nothing makes a sound yet. Turn it on when OBS is set to hear this window (Windows: Desktop Audio is on by default).'),
      h('div', { class: 'rowx' }, h('span', null, 'Volume'),
        h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(c.volume * 100)), 'aria-label': 'Soundboard volume', class: 'grow', onInput: (e: Event) => saveSoon({ ...cfg(), volume: Number((e.target as HTMLInputElement).value) / 100 }) }))));

    // 2. sounds
    const snd = (id: string, name: string, canDelete: boolean) => h('div', { class: `snd ${lastPlayed === id ? 'played' : ''}`, 'data-sound': id },
      h('button', { class: 'nm', title: `Play “${name}” on the stream`, onClick: () => void play(id) }, `▶ ${name}`),
      h('input', { type: 'range', min: '0', max: '100', value: String(Math.round((c.vols[id] ?? 1) * 100)), title: `Volume of “${name}”`, 'aria-label': `Volume of ${name}`, onInput: (e: Event) => saveSoon({ ...cfg(), vols: { ...cfg().vols, [id]: Number((e.target as HTMLInputElement).value) / 100 } }) }),
      h('button', { title: 'Hear it only on your headphones (the “Only me” output)', 'aria-label': `Hear ${name} only on my headphones`, onClick: () => hear(id) }, '🎧'),
      canDelete ? h('button', { title: 'Remove this sound', 'aria-label': `Remove ${name}`, onClick: () => { if (confirm(`Remove “${name}”?`)) void api.remove(id).catch(fail).finally(paint); } }, '🗑') : h('span'));
    const file = h('input', { type: 'file', accept: 'audio/*,.mp3,.ogg,.wav,.m4a,.webm,.flac', multiple: true, style: 'display:none', 'aria-label': 'Add your own sound', onChange: (e: Event) => { const fs = [...((e.target as HTMLInputElement).files ?? [])]; (e.target as HTMLInputElement).value = ''; void Promise.all(fs.map(addFile)); } });
    const drop = h('div', { class: 'drop', onDragover: (e: Event) => { e.preventDefault(); drop.classList.add('over'); }, onDragleave: () => drop.classList.remove('over'), onDrop: (e: Event) => { e.preventDefault(); drop.classList.remove('over'); const fs = [...((e as DragEvent).dataTransfer?.files ?? [])]; void Promise.all(fs.map(addFile)); } },
      'Drop a sound file here, or ', h('button', { disabled: api.observer || api.helper !== 'ok', onClick: () => file.click() }, 'Add your own sound'), file, h('div', { style: 'font-size:11px' }, `mp3, ogg, wav, m4a, flac · up to ${MAX_SOUND_SECS} s · 3 MB`));
    rows.push(h('div', { class: 'card' },
      h('h4', null, 'Sounds'),
      ...(mine.length ? [h('p', null, 'Yours'), ...mine.map((s) => snd(s.id, s.name, true))] : []),
      h('p', null, 'Built in'), ...api.sounds().filter((s) => s.kind === 'synth').map((s) => snd(s.id, s.name, false)),
      h('p', null, 'Starter stings (free to use, CC0)'), ...api.sounds().filter((s) => s.kind === 'sting').map((s) => snd(s.id, s.name, false)),
      drop));

    // 3. cues
    const cueText = (q: SoundCue) => {
      const w = q.when;
      const when = w.kind === 'emote' ? (w.name ? `the emote “${emotes.find((e) => e.id === w.name)?.label ?? w.name}” starts` : 'any emote starts')
        : w.kind === 'outfit' ? (w.id ? `I put on “${api.outfits().find((o) => o.id === w.id)?.name ?? w.id}”` : 'I change outfit')
          : `someone uses the redeem “${w.title}”`;
      const does = [q.sound ? `play “${soundName(q.sound)}”` : '', q.fx ? `${FX_PRESETS.find((p) => p.id === q.fx!.preset)?.label ?? q.fx.preset} for ${q.fx.secs} s` : ''].filter(Boolean).join(' and ');
      return `When ${when}, ${does}.`;
    };
    const targetControl = (): HTMLElement => {
      if (draft.kind === 'emote') return h('select', { 'aria-label': 'Which emote', onChange: (e: Event) => { draft.target = (e.target as HTMLSelectElement).value; } },
        h('option', { value: '', selected: !draft.target }, 'any emote'), ...emotes.map((e) => h('option', { value: e.id, selected: draft.target === e.id }, e.label)));
      if (draft.kind === 'outfit') return h('select', { 'aria-label': 'Which outfit', onChange: (e: Event) => { draft.target = (e.target as HTMLSelectElement).value; } },
        h('option', { value: '', selected: !draft.target }, 'any outfit'), ...api.outfits().map((o) => h('option', { value: o.id, selected: draft.target === o.id }, o.name)));
      return h('input', { type: 'text', placeholder: 'The redeem’s name, as viewers see it', maxLength: 80, value: draft.target, 'aria-label': 'Redeem name', onInput: (e: Event) => { draft.target = (e.target as HTMLInputElement).value; } });
    };
    const addCue = () => {
      const when: CueWhen = draft.kind === 'emote' ? { kind: 'emote', name: draft.target } : draft.kind === 'outfit' ? { kind: 'outfit', id: draft.target } : { kind: 'redeem', title: draft.target.trim() };
      if (when.kind === 'redeem' && !when.title) { toast('Type the redeem’s name first (exactly as it shows in your channel).', 'warn'); return; }
      if (!draft.sound && !draft.fx) { toast('Pick a sound or a screen effect to do.', 'warn'); return; }
      if (cfg().cues.length >= 40) { toast('That is 40 already: remove one first.', 'warn'); return; }
      const cue: SoundCue = { id: newCueId(), on: true, when, sound: draft.sound, vol: 1, fx: draft.fx ? { preset: draft.fx, secs: draft.secs } : null };
      draft = { ...draft, target: '' };
      void saveNow({ ...cfg(), cues: [...cfg().cues, cue] });
    };
    rows.push(h('div', { class: 'card' },
      h('h4', null, 'Do it when…'),
      h('p', null, 'Give an emote, an outfit or a redeem its own sound and/or screen effect. For anything else (a follow, a raid, a key) use Rules, or a Stream Deck key with “Play a sound”.'),
      ...cfg().cues.map((q) => h('div', { class: `cue ${q.on ? '' : 'off'}`, 'data-cue': q.id },
        h('input', { type: 'checkbox', checked: q.on, 'aria-label': 'On', onChange: (e: Event) => void saveNow({ ...cfg(), cues: cfg().cues.map((x) => (x.id === q.id ? { ...x, on: (e.target as HTMLInputElement).checked } : x)) }) }),
        h('span', { class: 'tx' }, cueText(q)),
        h('button', { 'aria-label': 'Remove this', title: 'Remove', onClick: () => void saveNow({ ...cfg(), cues: cfg().cues.filter((x) => x.id !== q.id) }) }, '🗑'))),
      h('div', { class: 'rowx', 'data-cue-form': '1' },
        h('select', { 'aria-label': 'When', onChange: (e: Event) => { draft = { ...draft, kind: (e.target as HTMLSelectElement).value as CueWhen['kind'], target: '' }; paint(); } },
          ...(Object.keys(WHEN_LABEL) as CueWhen['kind'][]).map((k) => h('option', { value: k, selected: draft.kind === k }, WHEN_LABEL[k]))),
        targetControl(),
        h('span', null, '→'),
        soundSelect(draft.sound, 'no sound', (id) => { draft.sound = id; }),
        fxSelect(draft.fx, (p) => { draft.fx = p; }),
        h('button', { class: 'pri', disabled: api.observer || api.helper !== 'ok', onClick: addCue }, 'Add'))));

    // 4. scream
    const sc = c.scream;
    const setScream = (patch: Partial<typeof sc>) => void saveNow({ ...cfg(), scream: { ...cfg().scream, ...patch } });
    const meter = h('div', { class: 'meter', 'aria-label': 'Your voice level' }, h('i'), h('b', { style: `left:${Math.round(sc.level * 100)}%` }));
    rows.push(h('div', { class: `card ${sc.on ? 'on' : ''}` },
      h('label', { class: 'rowx' },
        h('input', { type: 'checkbox', checked: sc.on, disabled: api.observer || api.helper !== 'ok', 'aria-label': 'Scream reaction', onChange: (e: Event) => setScream({ on: (e.target as HTMLInputElement).checked }) }),
        h('b', null, 'Scream reaction')),
      h('p', null, 'When your voice stays loud for a moment (a jump scare, a rage), play a sound and/or an effect. Rules can also use it as “I get loud”. Off until you turn it on; it listens to your mic only while it is on.'),
      h('div', { class: 'rowx' }, 'Your voice now', meter, h('button', { title: 'Shout once, as loud as you will on stream: the line is set a little under it', onClick: () => void learn() }, 'Set from my voice')),
      h('div', { class: 'rowx' }, 'Loud above',
        h('input', { type: 'range', min: '15', max: '98', value: String(Math.round(sc.level * 100)), 'aria-label': 'Loud above', onInput: (e: Event) => saveSoon({ ...cfg(), scream: { ...cfg().scream, level: Number((e.target as HTMLInputElement).value) / 100 } }) }),
        'for', h('input', { type: 'number', min: '150', max: '5000', step: '50', value: String(sc.forMs), style: 'width:70px', 'aria-label': 'Milliseconds', onChange: (e: Event) => setScream({ forMs: Number((e.target as HTMLInputElement).value) }) }), 'ms · again after',
        h('input', { type: 'number', min: '2', max: '300', value: String(sc.cooldownSecs), style: 'width:56px', 'aria-label': 'Seconds before again', onChange: (e: Event) => setScream({ cooldownSecs: Number((e.target as HTMLInputElement).value) }) }), 's'),
      h('div', { class: 'rowx' }, 'Then', soundSelect(sc.sound, 'no sound', (id) => setScream({ sound: id })),
        fxSelect(sc.fx?.preset ?? '', (p) => setScream({ fx: p ? { preset: p, secs: sc.fx?.secs ?? 2 } as FxPick : null })))));

    // 5. screen effects
    rows.push(h('div', { class: 'card' },
      h('h4', null, 'Screen effects'),
      h('p', null, api.flashSafe()
        ? 'Flash safety is on: nothing here flashes more than 3 times a second. They show on your preview and on every OBS page.'
        : 'Flash safety is off (you turned it off in the Scene tab). Effects may flash faster than 3 times a second.'),
      h('div', { class: 'rowx' }, 'For', h('input', { type: 'range', min: '0.5', max: '20', step: '0.5', value: String(fxSecs), 'aria-label': 'Seconds', onInput: (e: Event) => { fxSecs = Number((e.target as HTMLInputElement).value); (e.target as HTMLElement).nextElementSibling!.textContent = `${fxSecs} s`; } }), h('span', null, `${fxSecs} s`)),
      h('div', { class: 'fxg' }, ...FX_PRESETS.map((p) => h('button', { 'data-fx': p.id, onClick: () => fire(p.id) }, h('span', null, `${p.icon} ${p.label}`), h('small', null, p.hint)))),
      fxMsg ? h('p', { role: 'status' }, fxMsg) : null,
      h('p', null, 'To use them from a key or a redeem: Stream Deck → “Screen effect” and “Play a sound”, or a Rule’s steps.')));

    root.replaceChildren(...(rows.filter(Boolean) as HTMLElement[]));
  }

  // "Set from my voice": the loudest the mic got in 4 s
  let learning = false;
  async function learn() {
    if (learning) return;
    if (api.level() === null) { toast('Your microphone is not open. Start it in the studio first, then try again.', 'warn', 5000); return; }
    learning = true; toast('Shout like you would on stream… (4 seconds)', 'info', 3800);
    let peak = 0;
    const t0 = performance.now();
    await new Promise<void>((done) => { const iv = window.setInterval(() => { peak = Math.max(peak, api.level() ?? 0); if (performance.now() - t0 > 4000 || dead) { clearInterval(iv); done(); } }, 50); });
    learning = false;
    if (dead) return;
    if (peak < 0.12) { toast('I barely heard anything. Check your microphone and try again.', 'warn', 5000); return; }
    toast(`Set to ${Math.round(levelFromPeak(peak) * 100)}%`, 'ok', 2200);
    void saveNow({ ...cfg(), scream: { ...cfg().scream, level: levelFromPeak(peak) } });
  }

  // the live meter: only while the panel is on screen AND the mic is open (nothing runs otherwise)
  const meterT = window.setInterval(() => {
    if (dead || !root.isConnected) return;
    const l = api.level();
    const i = root.querySelector<HTMLElement>('.meter i');
    if (i) i.style.width = l === null ? '0' : `${Math.min(100, Math.round(l * 100))}%`;
  }, 100);

  const unwatch = api.onChange(() => { if (!root.contains(document.activeElement)) paint(); });
  paint();
  void api.load().then(paint);
  return () => { dead = true; clearInterval(meterT); clearTimeout(saveT); unwatch(); root.remove(); };
}
