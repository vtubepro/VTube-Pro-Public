// POST /api/generate, GET /api/jobs, GET /api/jobs/:id, job files.
import { Router } from 'express';
import type { GenerateRequest } from '../../shared/types.ts';
import { asciiJson, getJob, jobDir, listJobs, startJob } from '../jobs.ts';
import { HttpError } from '../library.ts';
import { PROVIDERS, validateGenerate } from '../providers/index.ts';
import { sendFrom, wildcardPath } from './util.ts';

export const jobRoutes = Router();

jobRoutes.post('/api/generate', (req, res) => {
  const body = req.body as GenerateRequest;
  const problem = validateGenerate(body);
  if (problem) throw new HttpError(400, problem);
  const run = PROVIDERS[body.provider];
  const job = startJob(`generate-${body.provider}`, (ctx) => run(ctx.job, body, ctx), { provider: body.provider });
  res.json({ jobId: job.id });
});

jobRoutes.get('/api/jobs', (_req, res) => {
  res.type('application/json; charset=utf-8').send(asciiJson(listJobs()));
});

jobRoutes.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new HttpError(404, `No job '${req.params.id}'`);
  res.type('application/json; charset=utf-8').send(asciiJson(job));
});

jobRoutes.get('/api/jobs/:id/files/*name', (req, res) => {
  if (!getJob(req.params.id)) throw new HttpError(404, `No job '${req.params.id}'`);
  sendFrom(res, jobDir(req.params.id), wildcardPath((req.params as Record<string, unknown>).name));
});
