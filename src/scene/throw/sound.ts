// Per-hit impact sound (beta.16, docs/b16/THROW.md). OFF by default. When the host switches it on it plays on the host's own
// OBS Browser Source only (window.obsstudio exists there, and OBS carries the page's audio into the stream). Never in the studio,
// never on a guest's page, never in a test page. The sounds are the CC0 Kenney impact pack the helper already serves.
let ctx: AudioContext | null = null;
const buffers = new Map<string, AudioBuffer | null>();
const loading = new Map<string, Promise<AudioBuffer | null>>();

/** May this page make the throw sound at all? Only an OBS Browser Source that is the host's own. */
export function soundAllowed(role: 'studio' | 'output', self: string): boolean {
  return role === 'output' && self === '@host' && !!(globalThis as { obsstudio?: unknown }).obsstudio;
}

async function load(name: string): Promise<AudioBuffer | null> {
  if (buffers.has(name)) return buffers.get(name) ?? null;
  let p = loading.get(name);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(`/api/trail/sfx/kenney_impact/${name}.ogg`);
        if (!r.ok || !ctx) return null;
        return await ctx.decodeAudioData(await r.arrayBuffer());
      } catch { return null; }
    })().then((b) => { buffers.set(name, b); loading.delete(name); return b; });
    loading.set(name, p);
  }
  return p;
}

/** Play one impact. `name` is a Kenney file name without the extension (shared/throwables.ts throwSoundName). */
export function playImpact(name: string, gain = 0.6, rate = 1) {
  try {
    ctx ??= new AudioContext();
    const c = ctx;
    void load(name).then((b) => {
      if (!b) return;
      const src = c.createBufferSource(), g = c.createGain();
      src.buffer = b; src.playbackRate.value = rate; g.gain.value = Math.max(0, Math.min(1, gain));
      src.connect(g).connect(c.destination);
      src.start();
    });
  } catch { /* no audio on this page */ }
}
/** The page was closed or the feature switched off. */
export function stopSound() { try { void ctx?.close(); } catch { /* already closed */ } ctx = null; buffers.clear(); loading.clear(); }
