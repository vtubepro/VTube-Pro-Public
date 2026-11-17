// Campaign saves on the host PC: saves/ttrpg/<id>.json (git-ignored; atomic writes; deletes go to saves/ttrpg/.trash).
// Names + sheets + the story log + the GM's memory notes — never anyone's avatar.
import fs from 'node:fs';
import path from 'node:path';
import { SAVES_DIR } from '../paths.ts';
import { HttpError } from '../library.ts';

export const CAMPAIGN_DIR = path.join(SAVES_DIR, 'ttrpg');
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export interface CampaignMeta { id: string; title: string; env: string; system: string; savedAt: number; sessions: number; chars: string[] }

function file(id: string) { if (!ID.test(id)) throw new HttpError(400, 'Bad campaign id'); return path.join(CAMPAIGN_DIR, `${id}.json`); }

export function listCampaigns(): CampaignMeta[] {
  let names: string[] = [];
  try { names = fs.readdirSync(CAMPAIGN_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out: CampaignMeta[] = [];
  for (const n of names.slice(0, 500)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CAMPAIGN_DIR, n), 'utf8'));
      out.push({ id: n.slice(0, -5), title: String(j.title ?? n).slice(0, 80), env: String(j.env ?? '').slice(0, 48), system: String(j.system ?? ''), savedAt: Number(j.savedAt) || 0,
        sessions: Number(j.sessions) || 0, chars: Array.isArray(j.chars) ? j.chars.slice(0, 12).map((c: any) => String(c?.name ?? '').slice(0, 32)) : [] });
    } catch { /* skip broken */ }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function readCampaign(id: string): unknown {
  const f = file(id);
  if (!fs.existsSync(f)) throw new HttpError(404, 'No such campaign');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export function writeCampaign(id: string, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a campaign object');
  const text = JSON.stringify({ ...(body as object), savedAt: Date.now() });
  if (text.length > 4_000_000) throw new HttpError(413, 'Campaign too large (4 MB max)');
  fs.mkdirSync(CAMPAIGN_DIR, { recursive: true });
  const f = file(id), tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
  return { ok: true, id };
}

export function trashCampaign(id: string) {
  const f = file(id);
  if (!fs.existsSync(f)) throw new HttpError(404, 'No such campaign');
  const trash = path.join(CAMPAIGN_DIR, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(f, path.join(trash, `${id}-${Date.now()}.json`));
  return { ok: true };
}
