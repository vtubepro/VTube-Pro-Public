// Licence notice for hosted copies.
//
// VTube Pro is a LOCAL app: its pages are served by the VTube Pro server on your own PC (127.0.0.1 / localhost), or to
// another PC on your home network ("Streaming from a second PC"). When one of its pages is opened from any other
// address, somebody is hosting it as a website or web service. That is allowed for free, noncommercial use, but
// nobody may charge for it or run it as a paid, subscription or ad-funded service (LICENSE: PolyForm Noncommercial
// License 1.0.0 + streaming permission). So a hosted copy tells its visitors, in plain words, that the software is
// free and where the original is. Nothing is sent anywhere: this only reads the page's own address.
//
// This notice is part of the project's licence information ("Required Notice", LICENSE). Removing or hiding it is
// not covered by the licence.
export const LICENCE_ID = 'PolyForm-Noncommercial-1.0.0+streaming';
export const PROJECT_HOME = 'https://github.com/vtubepro/VTube-Pro-Public';
/** A fixed, searchable sentence (also in every page's <meta name="vtube-pro-licence"> and the server's licence answer). */
export const LICENCE_LINE = 'VTube Pro is free software for noncommercial use (PolyForm Noncommercial License 1.0.0). It may not be sold or offered as a paid, subscription or ad-funded service.';

const LOCAL_NAME = /^(localhost|[\w-]+\.localhost|[\w-]+\.local|[\w-]+\.lan|[\w-]+\.home|[\w-]+\.internal)$/i;

/** True for this PC and private / home-network addresses (never a public website). Pure: exported for tests. */
export function isLocalAddress(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || LOCAL_NAME.test(h) || !h.includes('.') && !h.includes(':')) return true;   // '' (file:), localhost, bare PC names
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;       // IPv6 loopback / unique-local / link-local
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);                    // + link-local, CGNAT / mesh VPNs
}

/** Show the licence notice when this page is served from a public address. Safe to call more than once. */
export function showLicenceNoticeIfHosted(doc: Document = document, loc: Location = location): boolean {
  if (isLocalAddress(loc.hostname)) return false;
  if (doc.getElementById('vtp-licence-notice')) return true;
  const bar = doc.createElement('div');
  bar.id = 'vtp-licence-notice';
  bar.setAttribute('role', 'note');
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 14px;background:#101418;color:#f2f5f7;'
    + 'font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif;border-top:2px solid #36d399;text-align:center';
  const text = doc.createElement('span');
  text.textContent = `This copy of VTube Pro is hosted at ${loc.hostname}. VTube Pro is free: nobody may charge you for it or sell it as a service. If you paid for this, the licence is being broken. The free original: `;
  const link = doc.createElement('a');
  link.href = PROJECT_HOME; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.textContent = PROJECT_HOME.replace('https://', '');
  link.style.cssText = 'color:#7ee0b8;text-decoration:underline';
  bar.append(text, link);
  const add = () => doc.body?.appendChild(bar);
  if (doc.body) add(); else doc.addEventListener('DOMContentLoaded', add, { once: true });
  return true;
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') showLicenceNoticeIfHosted();
