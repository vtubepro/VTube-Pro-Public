// Read-only guides over HTTP: GET /api/docs (the Help guide list), GET /api/docs/<NAME>.md (that doc as a simple HTML
// page, rendered by shared/markdown.ts — the same renderer as the studio's Help viewer) and GET /api/docs/img/<file>
// (the pictures the guides use). Only plain names directly in docs/ (and docs/img/) are served, never a path.
// The studio's Help viewer (src/ui/help/helpViewer.ts) bundles the same guides and works without this route; this one
// is for opening a guide in a normal browser tab.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../paths.ts';
import { HttpError } from '../library.ts';
import { HELP_DOCS } from '../../shared/helpCatalog.ts';
import { escapeHtml as esc, renderMarkdown } from '../../shared/markdown.ts';

export const docsRoutes = Router();
const DOCS = path.join(ROOT, 'docs');

/** The guides shown in Help, in order (the catalog the studio's Help viewer uses). */
export const GUIDES = HELP_DOCS.map((d) => ({ file: d.file, title: d.title, who: d.blurb }));

const IMG_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const link = (href: string) => {
  const md = /^(?:\.\/|docs\/)?([A-Za-z0-9_]+\.md)(#[\w-]*)?$/.exec(href);
  if (md) return { href: `/api/docs/${md[1]}${md[2] ?? ''}`, external: false };
  if (href.startsWith('#')) return { href, external: false };
  if (/^https?:\/\//i.test(href)) return { href, external: true };
  return { href: '#', external: false };
};
const image = (src: string) => { const m = /^(?:\.\/)?img\/([A-Za-z0-9_.-]+\.(?:png|jpe?g|webp|gif))$/i.exec(src); return m ? `/api/docs/img/${m[1]}` : null; };

const CSS = `body{font:15px/1.6 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:16px 20px 60px;background:#111418;color:#e6e8eb}
a{color:#7bd88f}code{background:#1d232b;padding:1px 4px;border-radius:4px;font-size:.92em}pre{background:#1d232b;padding:12px;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}.md-table{overflow-x:auto}table{border-collapse:collapse;margin:10px 0}th,td{border:1px solid #2c343e;padding:6px 9px;text-align:left;vertical-align:top}
th{background:#1a2027}h1,h2,h3{line-height:1.25}h2{margin-top:32px;border-bottom:1px solid #2c343e;padding-bottom:4px}hr{border:0;border-top:1px solid #2c343e;margin:24px 0}
blockquote{margin:12px 0;padding:6px 14px;border-left:3px solid #6cc7f5;background:#6cc7f51a;border-radius:0 8px 8px 0}img{max-width:100%;border-radius:8px}
nav{font-size:13px;margin-bottom:8px;line-height:1.8}@media (prefers-color-scheme:light){body{background:#fff;color:#1b1f24}code,pre{background:#f1f3f5}th{background:#f6f8fa}th,td{border-color:#d0d7de}a{color:#1a7f37}}`;

docsRoutes.get('/api/docs', (_req, res) => {
  res.json(GUIDES.filter((g) => fs.existsSync(path.join(DOCS, g.file))).map((g) => ({ ...g, url: `/api/docs/${g.file}` })));
});

docsRoutes.get('/api/docs/img/:file', (req, res) => {
  const name = String(req.params.file);
  const ext = path.extname(name).toLowerCase();
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.') || !IMG_TYPES[ext]) throw new HttpError(400, 'Bad image name');
  const file = path.join(DOCS, 'img', name);
  if (!fs.existsSync(file)) throw new HttpError(404, `No image ${name}`);
  res.setHeader('Cache-Control', 'no-cache');
  res.type(IMG_TYPES[ext]).send(fs.readFileSync(file));
});

docsRoutes.get('/api/docs/:name', (req, res) => {
  const name = String(req.params.name);
  if (!/^[A-Za-z0-9_]+\.md$/.test(name)) throw new HttpError(400, 'Bad doc name');
  const file = path.join(DOCS, name);
  if (!fs.existsSync(file)) throw new HttpError(404, `No doc ${name}`);
  const md = fs.readFileSync(file, 'utf8');
  const title = (/^# (.+)$/m.exec(md)?.[1] ?? name).replace(/[`*]/g, '');
  const nav = GUIDES.filter((g) => fs.existsSync(path.join(DOCS, g.file))).map((g) => (g.file === name ? `<b>${esc(g.title)}</b>` : `<a href="/api/docs/${g.file}">${esc(g.title)}</a>`)).join(' · ');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — VTube Pro</title><style>${CSS}</style></head><body><nav>${nav}</nav>${renderMarkdown(md, { link, image })}</body></html>`);
});
