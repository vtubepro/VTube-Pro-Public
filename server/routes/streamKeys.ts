// GET /stream-keys: the helper's own page for pasted stream keys and a typed stream address (server/streamKeysPage.ts).
// It gives VTube Pro the 'local-page' origin that /api/broadcast/keys/* demands (R3-15): the page
// calls the existing /api/broadcast routes from a browser on this PC. It adds no route that writes a key.
//   * this PC only: a non-loopback caller gets 403; server/localGuard.ts keeps every web origin away from it
//   * never framed: X-Frame-Options DENY + CSP frame-ancestors 'none' (a site cannot overlay a key box on this page)
//   * CSP: one-time script nonce, connect-src 'self' only (the page can talk to this helper and nobody else)
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireLocal } from './util.ts';
import { STREAM_KEYS_NONCE_TOKEN, STREAM_KEYS_PAGE } from '../streamKeysPage.ts';

export const STREAM_KEYS_PATH = '/stream-keys';
export const streamKeysRoutes = Router();


/** The response headers of the page (exported for the unit). */
export function streamKeysHeaders(nonce: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

streamKeysRoutes.get([STREAM_KEYS_PATH, `${STREAM_KEYS_PATH}/`], (req, res) => {
  requireLocal(req);
  const nonce = crypto.randomBytes(16).toString('base64');
  for (const [k, v] of Object.entries(streamKeysHeaders(nonce))) res.setHeader(k, v);
  res.type('html').send(STREAM_KEYS_PAGE.split(STREAM_KEYS_NONCE_TOKEN).join(nonce));
});
