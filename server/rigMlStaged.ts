// How one ML rig job runs, by graphics-memory tier (shared/rigMl.ts rigPlan), with every side effect injected so tools/rigml_unit.ts can
// drive it against a MOCK model process and fake Blender steps (nothing is downloaded, no model or Blender is started by the tests):
//
//   normal     the model on the original mesh, as its README says
//   staged     a decimated copy ("proxy") -> the model's steps as separate processes (rigml_worker.py --staged) -> the skin weights are
//              transferred back to the full mesh (blender/weight_transfer.py via blender/mlrig_stage.py). If the model runs out of graphics
//              memory (WorkerError code 4) the SAME is tried once more with a smaller copy and the smallest knobs; if that runs out too,
//              the no-AI Blender templates rig the model instead, and the log says what happened.
//   templates  below the staged floor, or no NVIDIA card: the Blender templates, with the plan's plain message.
// A normal run that runs out of memory (other programs were using the card) is retried as a staged run, then the same fallback.
// The person is never asked "try anyway": the default path works, or says why it did something else.
import { RETRY_KNOBS, STAGED_TIERS, MIN_PROXY_FACES, outOfMemoryText, type RigMlModel, type RigPlan } from '../shared/rigMl.ts';
import { WorkerError, type StagedKnobs } from './rigMlCore.ts';

export type RigHow = 'normal' | 'staged' | 'templates';

export interface StagedDeps {
  log: (line: string) => void;
  /** Blender: a decimated copy of `input` (about `faces` triangles) written to `output`. */
  decimate: (o: { input: string; output: string; faces: number }) => Promise<{ facesBefore: number; facesAfter: number }>;
  /** The model on `input` -> a rigged file at `output` (rejects with WorkerError; code 4 = out of graphics memory). */
  rig: (o: { model: RigMlModel; input: string; output: string; staged?: StagedKnobs }) => Promise<string>;
  /** Blender: copy the skin weights of the rigged copy onto the full mesh -> `output`. */
  transfer: (o: { full: string; rigged: string; output: string }) => Promise<void>;
  /** Blender templates (no AI): rig `input` -> `output`. `why` is the plain reason this is happening. */
  templates: (o: { input: string; output: string; why: string }) => Promise<void>;
}

export interface RigJobResult {
  how: RigHow;
  /** The rigged file (bones not yet named for the studio when `named` is false). */
  path: string;
  /** true when the Blender templates made it (their bones are already named). */
  named: boolean;
  attempts: number;
  /** One plain sentence about what ran, for the job log. */
  summary: string;
}

const isOom = (e: unknown) => e instanceof WorkerError && e.code === 4;

/** The staged settings for a card that was believed to fit (a normal run that ran out of memory): the roomiest staged tier. */
function escalationPlan(model: RigMlModel): RigPlan {
  const t = STAGED_TIERS[0];
  return { mode: 'staged', model, proxyFaces: t.proxyFaces, retryFaces: Math.max(MIN_PROXY_FACES, Math.floor(t.proxyFaces / 2)), beams: t.beams, skinChunk: t.skinChunk, minutes: null, message: '' };
}

export async function runRigJob(plan: RigPlan, files: { input: string; work: (name: string) => string; output: string; haveGB: number | null }, d: StagedDeps): Promise<RigJobResult> {
  const out = (name: string) => files.work(name);
  const fallback = async (why: string, attempts: number): Promise<RigJobResult> => {
    d.log(why);
    await d.templates({ input: files.input, output: files.output, why });
    return { how: 'templates', path: files.output, named: true, attempts, summary: 'Rigged with the Blender skeleton (no AI).' };
  };
  if (plan.mode === 'templates' || !plan.model) return fallback(plan.message || 'This PC’s graphics card cannot run the smart skeleton.', 0);

  const model = plan.model;
  let staged = plan;
  let attempts = 0;
  if (plan.mode === 'normal') {
    attempts++;
    try {
      const made = await d.rig({ model, input: files.input, output: out('ml_rigged.glb') });
      return { how: 'normal', path: made, named: false, attempts, summary: 'Rigged by the smart skeleton model.' };
    } catch (e) {
      if (!isOom(e)) throw e;
      d.log(`${(e as Error).message} Switching to the low-memory staged mode.`);
      staged = escalationPlan(model);
    }
  } else if (plan.message) d.log(plan.message);

  const tries: { faces: number; knobs: StagedKnobs }[] = [
    { faces: staged.proxyFaces as number, knobs: { faces: staged.proxyFaces as number, beams: staged.beams as number, skinChunk: staged.skinChunk as number } },
    { faces: staged.retryFaces as number, knobs: { faces: staged.retryFaces as number, beams: RETRY_KNOBS.beams, skinChunk: RETRY_KNOBS.skinChunk } },
  ];
  let lastOom = '';
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    attempts++;
    d.log(i === 0 ? `Low-memory staged mode: rigging a smaller copy (about ${t.faces} faces), then moving the skin onto your full model.` : `Trying once more with a smaller copy (about ${t.faces} faces).`);
    const proxy = out(`proxy_${i}.glb`), proxyRigged = out(`proxy_rigged_${i}.glb`);
    const dec = await d.decimate({ input: files.input, output: proxy, faces: t.faces });
    d.log(`Smaller copy: ${dec.facesAfter} of ${dec.facesBefore} faces.`);
    try {
      const made = await d.rig({ model, input: proxy, output: proxyRigged, staged: t.knobs });
      await d.transfer({ full: files.input, rigged: made, output: files.output });
      return { how: 'staged', path: files.output, named: false, attempts, summary: `Rigged in the low-memory staged mode (a copy of ${dec.facesAfter} faces, weights moved to the full model).` };
    } catch (e) {
      if (!isOom(e)) throw e;
      lastOom = (e as Error).message;
      d.log(`Ran out of graphics memory with a copy of about ${t.faces} faces.${i === 0 ? '' : ' That was the smaller copy.'}`);
    }
  }
  return fallback(`${lastOom || outOfMemoryText(model, files.haveGB)} The staged mode ran out of memory twice (second time with a smaller copy), so the Blender skeleton (no AI, works on any PC) rigs your model instead.`, attempts);
}
