// The GM's voice + players' push-to-talk, in the studio:
//  - TTS: the browser's own voices (Web Speech API: free, local, no key) or a voice server on this PC through the
//    server (/api/ttrpg/tts: OpenAI-compatible, a local Kokoro / openedai-speech server). NPC lines get
//    a different pitch / rate. onStart / onLevel let the session re-time the mouth on this PC's OBS pages.
//  - STT: the browser's speech recognition (Chrome / Edge: audio goes to the browser vendor's service — the panel says
//    so) or a recording sent to /api/ttrpg/stt (a local whisper server on this PC).
import { studioShow } from '../../audio/mixer/showSounds.ts';
import { sanitizeLip, type LipCue } from '../../../shared/ttrpg/wire.ts';
export interface SpeakOpts { voice?: string; rate?: number; pitch?: number; npc?: 'low' | 'high' | 'rough' | 'soft' | string; provider?: 'browser' | 'server'; serverVoice?: string }
export interface SpeakHandle { done: Promise<void>; stop(): void }

const NPC_SHIFT: Record<string, [number, number]> = { low: [0.7, 0.92], high: [1.35, 1.05], rough: [0.8, 0.95], soft: [1.1, 0.9] };

export function browserVoices(): SpeechSynthesisVoice[] { try { return speechSynthesis.getVoices(); } catch { return []; } }
export const hasBrowserTts = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

export function speak(text: string, o: SpeakOpts, cb: { onStart?: (dur: number) => void; onLevel?: (v: number) => void } = {}): SpeakHandle {
  if (o.provider === 'server') return speakServer(text, o, cb);
  let stopped = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  if (!hasBrowserTts()) { cb.onStart?.(Math.max(1, text.length / 14.5)); setTimeout(resolve, Math.max(1000, (text.length / 14.5) * 1000)); return { done, stop: () => resolve() }; }
  const u = new SpeechSynthesisUtterance(text);
  const vs = browserVoices();
  const v = vs.find((x) => x.voiceURI === o.voice) ?? vs.find((x) => /en[-_]GB/i.test(x.lang) && /male|george|ryan|guy/i.test(x.name)) ?? vs.find((x) => /^en/i.test(x.lang)) ?? null;
  if (v) u.voice = v;
  const [pm, rm] = o.npc ? NPC_SHIFT[o.npc] ?? [1.15, 1] : [1, 1];
  u.pitch = Math.max(0, Math.min(2, (o.pitch ?? 1) * pm));
  u.rate = Math.max(0.5, Math.min(2, (o.rate ?? 1) * rm));
  const est = Math.max(0.8, text.length / (14.5 * u.rate));
  const t0 = { at: 0 };
  u.onstart = () => { t0.at = performance.now(); cb.onStart?.(est); };
  u.onend = () => resolve();
  u.onerror = () => resolve();
  // Chrome drops utterances queued while another is speaking in a hidden tab: cancel first, then speak
  try { speechSynthesis.speak(u); } catch { resolve(); }
  // safety: some engines never fire onend
  setTimeout(() => { if (!stopped) resolve(); }, est * 1000 * 1.8 + 4000);
  return { done, stop: () => { stopped = true; try { speechSynthesis.cancel(); } catch { /* */ } resolve(); } };
}

function speakServer(text: string, o: SpeakOpts, cb: { onStart?: (dur: number) => void; onLevel?: (v: number) => void }): SpeakHandle {
  let audio: HTMLAudioElement | null = null, ctx: AudioContext | null = null, raf = 0, stopped = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const finish = () => { cancelAnimationFrame(raf); try { ctx?.close(); } catch { /* */ } resolve(); };
  void (async () => {
    try {
      const r = await fetch('/api/ttrpg/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice: o.serverVoice || undefined }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `TTS ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      if (stopped) { URL.revokeObjectURL(url); return finish(); }
      audio = new Audio(url);
      ctx = new AudioContext();
      const src = ctx.createMediaElementSource(audio);
      const an = ctx.createAnalyser(); an.fftSize = 512;
      src.connect(an); an.connect(ctx.destination);
      const buf = new Float32Array(an.fftSize);
      const tick = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; cb.onLevel?.(Math.min(1, Math.sqrt(s / buf.length) * 5)); raf = requestAnimationFrame(tick); };
      audio.onplaying = () => { cb.onStart?.(Number.isFinite(audio!.duration) ? audio!.duration : text.length / 14.5); tick(); };
      audio.onended = () => { URL.revokeObjectURL(url); finish(); };
      audio.onerror = () => { URL.revokeObjectURL(url); finish(); };
      await audio.play();
    } catch (e) {
      console.warn('[ttrpg] server voice failed, using the browser voice', e);
      const h = speak(text, { ...o, provider: 'browser' }, cb);
      await h.done; finish();
    }
  })();
  return { done, stop: () => { stopped = true; try { audio?.pause(); } catch { /* */ } finish(); } };
}

// ---------------------------------------------------------------- the GM on stream (the STUDIO plays the line)
// A line is rendered on this PC's server — its Windows voices (free, offline) or the voice provider from Setup — and
// the studio plays it through the audio mixer's narrator row (src/audio/mixer/showSounds.ts); the stream hears it from
// the studio window like the guests. This PC's OBS pages get the same {k:'play'} and follow its level (the narrator's
// mouth, captions) without making a sound (src/ttrpg/gm/voicePlayer.ts; output pages are silent). 'stream' and 'both'
// now sound the same: once, in the studio.
export type VoiceOut = 'stream' | 'studio' | 'both';
export interface RenderedLine { url: string; dur: number; voice: string; /** the audio's own mouth shapes (Rhubarb on the server), when available */ lip?: LipCue[] }

/** Render a line on the server (this PC's Windows voices, or the Setup voice provider). */
export async function renderLine(text: string, o: SpeakOpts): Promise<RenderedLine> {
  const [pm, rm] = o.npc ? NPC_SHIFT[o.npc] ?? [1.15, 1] : [1, 1];
  const bv = browserVoices().find((x) => x.voiceURI === o.voice);
  const r = await fetch('/api/ttrpg/voice/line', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, engine: o.provider === 'server' ? 'provider' : 'system', voice: o.provider === 'server' ? o.serverVoice || undefined : bv?.name ?? o.voice ?? undefined, rate: (o.rate ?? 1) * rm, pitch: (o.pitch ?? 1) * pm }) });
  const j = await r.json().catch(() => ({})) as Partial<RenderedLine> & { error?: string };
  const lip = sanitizeLip(j.lip);
  if (!r.ok || typeof j.url !== 'string') throw new Error(j.error ?? `voice ${r.status}`);
  let dur = typeof j.dur === 'number' && j.dur > 0 ? j.dur : 0;
  if (!dur) {                                                        // provider audio (mp3): measure it here
    try { const ctx = new OfflineAudioContext(1, 1, 22050); const b = await ctx.decodeAudioData(await (await fetch(j.url)).arrayBuffer()); dur = b.duration; } catch { dur = Math.max(1, text.length / 14.5); }
  }
  return { url: j.url, dur, voice: j.voice ?? '', ...(lip ? { lip } : {}) };
}

/** Play a rendered line on the mixer's "Only me" output (the host's headphones), in the window that plays the show's
 *  sounds. The OBS pages get only the timing (sayAt): no 'play', no sound anywhere else. */
export function playPrivately(line: RenderedLine, at: number): SpeakHandle {
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const here = studioShow()?.playLine(line.url, at, true) ?? null;
  const end = setTimeout(() => resolve(), Math.max(0, at - Date.now()) + line.dur * 1000 + 120);
  return { done, stop: () => { clearTimeout(end); here?.stop(); resolve(); } };
}

/** Play a rendered line in the studio (once, through the mixer) and tell this PC's OBS pages (its mouth / captions),
 *  starting at `at` (ms). `alsoHere` is kept for callers: the studio always plays it now. */
export function playOnStream(bus: { send(m: unknown): void }, id: string, line: RenderedLine, at: number, alsoHere: boolean): SpeakHandle {
  void alsoHere;
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  bus.send({ type: 'ttrpg', m: { k: 'play', id, url: line.url, at, dur: line.dur } });
  const here = studioShow()?.playLine(line.url, at) ?? null;
  const end = setTimeout(() => resolve(), Math.max(0, at - Date.now()) + line.dur * 1000 + 120);
  return { done, stop: () => { clearTimeout(end); here?.stop(); bus.send({ type: 'ttrpg', m: { k: 'hush', id } }); resolve(); } };
}

// ---------------------------------------------------------------- push-to-talk
type Rec = { stop(): Promise<string>; cancel(): void };
export const hasBrowserStt = () => typeof window !== 'undefined' && !!((window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);

/** Start listening; stop() resolves with the text. 'browser' = Web Speech recognition, 'server' = record → /api/ttrpg/stt. */
export function listen(mode: 'browser' | 'server', lang = 'en-US', onPartial?: (t: string) => void): Rec {
  if (mode === 'browser' && hasBrowserStt()) {
    const C = ((window as unknown as { SpeechRecognition?: new () => any }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition: new () => any }).webkitSpeechRecognition);
    const r = new C();
    r.lang = lang; r.interimResults = true; r.continuous = true;
    let text = '';
    r.onresult = (e: any) => { let fin = '', part = ''; for (let i = 0; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) fin += t; else part += t; } text = fin; onPartial?.((fin + part).trim()); };
    try { r.start(); } catch { /* already started */ }
    return {
      stop: () => new Promise<string>((res) => { r.onend = () => res(text.trim()); try { r.stop(); } catch { res(text.trim()); } setTimeout(() => res(text.trim()), 1500); }),
      cancel: () => { try { r.abort(); } catch { /* */ } },
    };
  }
  let rec: MediaRecorder | null = null, stream: MediaStream | null = null;
  const chunks: Blob[] = [];
  const ready = navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
    stream = s; rec = new MediaRecorder(s); rec.ondataavailable = (e) => chunks.push(e.data); rec.start();
  });
  const close = () => { for (const t of stream?.getTracks() ?? []) t.stop(); };
  return {
    stop: async () => {
      await ready.catch(() => null);
      if (!rec) { close(); return ''; }
      const blob = await new Promise<Blob>((res) => { rec!.onstop = () => res(new Blob(chunks, { type: rec!.mimeType || 'audio/webm' })); rec!.stop(); });
      close();
      const r = await fetch('/api/ttrpg/stt', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `speech-to-text ${r.status}`);
      return String(j.text ?? '');
    },
    cancel: () => { try { rec?.stop(); } catch { /* */ } close(); },
  };
}
