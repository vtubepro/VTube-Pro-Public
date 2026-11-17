// The local voice pack (live captions, Kokoro alert voice): what is installed and the one-click, consented install.
//   GET  /api/voice/status                      → { dir, installed, setup:{running, ok, steps}, models, gpu }
//   POST /api/voice/setup {parts?, model?, dryRun?}   parts ⊂ runtime | captions | kokoro | gpu   (nothing downloads until this)
//   POST /api/voice/setup/cancel
//   POST /api/voice/uninstall {part?: 'captions' | 'kokoro'}
// This PC only (requireLocal + server/localGuard.ts): another website may not make the helper download software.
import { Router } from 'express';
import { ALL_PARTS, KOKORO_VOICES, WHISPER_MODELS, type Part, type WhisperModelId } from '../../tools/voice/voice_setup.ts';
import { requireLocal } from '../routes/util.ts';
import { runOffLoop } from '../spawnOffLoop.ts';
import { VoiceSetupJob } from './setup.ts';


export const voiceSetup = new VoiceSetupJob(process.env.VTP_VOICE_DIR || undefined);

let gpu: { name: string; vramMB: number; nvidia: boolean } | null = null;
const detectGpu = () => new Promise<NonNullable<typeof gpu>>((res) => {
  if (gpu) { res(gpu); return; }
  // (started off the event loop: spawn() itself holds it for 60-250 ms on Windows; server/spawnOffLoop.ts)
  void runOffLoop('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 4000 }).then((r) => {
    const bad = !!r.error || r.timedOut || r.code !== 0;
    const [name = '', mem = '0'] = bad ? [] : r.stdout.toString('utf8').trim().split('\n')[0].split(',').map((x) => x.trim());
    gpu = { name, vramMB: Number(mem) || 0, nvidia: !!name };
    res(gpu);
  });
});

export const voiceRoutes = Router();
voiceRoutes.get('/api/voice/status', async (req, res) => {
  requireLocal(req);
  const full = {
    dir: voiceSetup.dir, installed: voiceSetup.inspect(), setup: voiceSetup.state, gpu: await detectGpu(),
    models: Object.values(WHISPER_MODELS).map((m) => ({ id: m.id, label: m.label, mb: m.mb, langs: m.langs, note: m.note })),
    voices: Object.entries(KOKORO_VOICES).map(([id, v]) => ({ id, label: v.label })),
  };
  res.json(full);
});
voiceRoutes.post('/api/voice/setup', (req, res) => {
  requireLocal(req);
  const parts = (Array.isArray(req.body?.parts) ? req.body.parts : ALL_PARTS).filter((p: string) => (['runtime', 'captions', 'kokoro', 'gpu'] as string[]).includes(p)) as Part[];
  const model = typeof req.body?.model === 'string' && req.body.model in WHISPER_MODELS ? req.body.model as WhisperModelId : undefined;
  res.json({ started: voiceSetup.start(parts, model, !!req.body?.dryRun), setup: voiceSetup.state });
});
voiceRoutes.post('/api/voice/setup/cancel', (req, res) => { requireLocal(req); voiceSetup.cancel(); res.json({ ok: true }); });
voiceRoutes.post('/api/voice/uninstall', async (req, res) => {
  requireLocal(req);
  const part = req.body?.part === 'captions' || req.body?.part === 'kokoro' ? req.body.part as 'captions' | 'kokoro' : undefined;
  const done = await voiceSetup.remove(part);
  res.status(done ? 200 : 409).json({ ok: done, setup: voiceSetup.state });
});
