// The licence, stated by the server itself.
//
// Every answer carries an `X-VTube-Pro-Licence` header, and GET /licence.txt (also /.well-known/vtube-pro-licence.txt)
// returns the notice as plain text. A normal install only ever answers this PC, so nobody sees it. A copy that someone
// hosts on the internet answers everyone, which makes hosted copies easy to recognise and to find
// (docs/LICENSE_ENFORCEMENT.md). Nothing is sent anywhere by this file: it only adds text to answers.
//
// Part of the project's licence information ("Required Notice", LICENSE). Removing it is not covered by the licence.
import { Router, type RequestHandler } from 'express';

export const LICENCE_ID = 'PolyForm-Noncommercial-1.0.0+streaming';
export const PROJECT_HOME = 'https://github.com/vtubepro/VTube-Pro-Public';
export const LICENCE_LINE = 'VTube Pro is free software for noncommercial use (PolyForm Noncommercial License 1.0.0). It may not be sold or offered as a paid, subscription or ad-funded service.';

export const LICENCE_TEXT = [
  'VTube Pro',
  '',
  LICENCE_LINE,
  '',
  'Licence: PolyForm Noncommercial License 1.0.0 plus a permission to use it on your own streams and videos.',
  'Allowed: running, studying, changing, sharing and forking it for noncommercial purposes.',
  'Not allowed: selling it, charging for access to it, or hosting it as a paid, subscription or ad-funded service.',
  '',
  'If you were asked to pay for VTube Pro, or for a service built from it, the licence is being broken.',
  `The free original and the full licence text: ${PROJECT_HOME}`,
  '',
].join('\n');

/** Adds the licence header to every answer. */
export const licenceHeader: RequestHandler = (_req, res, next) => {
  res.setHeader('X-VTube-Pro-Licence', `${LICENCE_ID}; not-for-sale; ${PROJECT_HOME}`);
  next();
};

export const licenceRoutes = Router();
const send: RequestHandler = (_req, res) => { res.type('text/plain; charset=utf-8').send(LICENCE_TEXT); };
licenceRoutes.get('/licence.txt', send);
licenceRoutes.get('/license.txt', send);
licenceRoutes.get('/.well-known/vtube-pro-licence.txt', send);
