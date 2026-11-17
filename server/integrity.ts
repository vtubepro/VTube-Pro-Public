// Self-integrity check for the shipped helper.
//
// At start the helper verifies a SIGNED manifest of its own distributed files (the bundle). If a file was swapped
// or edited after release, it prints a friendly, non-fatal warning and keeps running (the owner can still use a
// tampered-with copy at their own risk; we only warn). This raises the bar for silently trojaning a distributed
// copy of the helper -- it does NOT make the code secret (see LIMITS.md).
//
// Signature scheme: Ed25519 over the exact UTF-8 bytes of the manifest
// JSON, detached, base64 in a sibling ".sig" file. Ed25519 is in Node core (node:crypto), so no new dependency.
//
//   dist-helper/
//     index.mjs, mcp.mjs, package.json   <- the files that ship
//     helper-manifest.json               <- { v, alg:"ed25519", subject:"helper", created, files:[{path,sha256,bytes}] }
//     helper-manifest.json.sig           <- base64(Ed25519 signature of helper-manifest.json's bytes)
//
// Source install (the owner running `node --import tsx server/index.ts`): there is no manifest next to this module,
// so the check reports "dev" and does nothing. That keeps the owner's own source install working untouched.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_BUILD } from './hardening.ts';

// The Ed25519 public key (SPKI PEM) a packaged build is checked against. This source tree ships NO key: whoever
// packages a signed build sets VTP_SIGN_PUBKEY (a PEM string or a path to a .pem). Without a key a manifest can
// never verify, and a source checkout (no manifest) reports 'dev' and does nothing.
const DEFAULT_PUBKEY_PEM = '';

const MANIFEST_NAME = 'helper-manifest.json';

export type IntegrityState = 'ok' | 'tampered' | 'unsigned' | 'dev' | 'error';
export interface IntegrityResult {
  state: IntegrityState;
  checked: number;
  problems: string[];
  message: string;
}

function loadPubKey(): crypto.KeyObject | null {
  let pem = process.env.VTP_SIGN_PUBKEY || DEFAULT_PUBKEY_PEM;
  try {
    if (pem && !pem.includes('BEGIN') && fs.existsSync(pem)) pem = fs.readFileSync(pem, 'utf8');
    return crypto.createPublicKey(pem);
  } catch { return null; }
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Verify the helper's own files against the signed manifest sitting next to this module. Never throws.
 * `dir` defaults to the directory of the running bundle (dist-helper when shipped).
 */
// A release build (server/hardening.ts RELEASE_BUILD, baked into the bundle) never counts as "dev": deleting the manifest of a
// release makes it 'unsigned' (the warning shows), instead of silently skipping the check.
export function verifySelfIntegrity(dir = path.dirname(fileURLToPath(import.meta.url)), release = RELEASE_BUILD): IntegrityResult {
  const manifestPath = process.env.VTP_HELPER_MANIFEST || path.join(dir, MANIFEST_NAME);
  const base = path.dirname(manifestPath);
  try {
    if (!fs.existsSync(manifestPath)) {
      if (release) return { state: 'unsigned', checked: 0, problems: ['manifest missing'], message: 'this release copy has no signed manifest (it was removed or never shipped)' };
      return { state: 'dev', checked: 0, problems: [], message: 'source/dev build: no signed manifest, integrity check skipped' };
    }
    const sigPath = manifestPath + '.sig';
    const raw = fs.readFileSync(manifestPath);
    const pub = loadPubKey();
    const problems: string[] = [];

    // 1) signature over the manifest bytes
    let signed = false;
    if (pub && fs.existsSync(sigPath)) {
      try {
        const sig = Buffer.from(fs.readFileSync(sigPath, 'utf8').trim(), 'base64');
        signed = crypto.verify(null, raw, pub, sig); // Ed25519: algorithm is null
      } catch { signed = false; }
    }
    if (!signed) {
      return { state: 'unsigned', checked: 0, problems: ['manifest signature missing or invalid'],
        message: 'this helper copy is not signed by VTube Pro (or the signature does not match)' };
    }

    // 2) every listed file hashes as expected
    let manifest: { files?: { path: string; sha256: string; bytes?: number }[] };
    try { manifest = JSON.parse(raw.toString('utf8')); } catch {
      return { state: 'error', checked: 0, problems: ['manifest is not valid JSON'], message: 'could not read the integrity manifest' };
    }
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    let checked = 0;
    for (const f of files) {
      const p = path.join(base, f.path);
      if (!fs.existsSync(p)) { problems.push(`missing: ${f.path}`); continue; }
      try {
        if (sha256(p) !== String(f.sha256).toLowerCase()) problems.push(`changed: ${f.path}`);
        checked++;
      } catch { problems.push(`unreadable: ${f.path}`); }
    }
    if (problems.length) {
      return { state: 'tampered', checked, problems, message: `${problems.length} helper file(s) do not match the signed manifest` };
    }
    return { state: 'ok', checked, problems: [], message: `verified ${checked} helper file(s) against the signed manifest` };
  } catch (e) {
    return { state: 'error', checked: 0, problems: [String((e as Error)?.message ?? e)], message: 'integrity check could not run' };
  }
}

/**
 * Run the check and print a friendly line. Never throws, never exits. Returns the result for callers/tests.
 */
export function reportIntegrity(dir?: string): IntegrityResult {
  let r: IntegrityResult;
  try { r = verifySelfIntegrity(dir); }
  catch (e) { r = { state: 'error', checked: 0, problems: [String(e)], message: 'integrity check crashed (ignored)' }; }
  switch (r.state) {
    case 'ok':
      console.log(`[vtube-pro] integrity: ${r.message}`);
      break;
    case 'dev':
      // quiet on the owner's source install
      break;
    case 'unsigned':
    case 'tampered':
      console.warn('');
      console.warn('  [!] VTube Pro could not confirm these program files are the genuine release.');
      console.warn(`      ${r.message}.`);
      console.warn('      VTube Pro will still start, but if you did not change these files on purpose,');
      console.warn('      please get a fresh copy of VTube Pro from the official VTube Pro site.');
      for (const p of r.problems.slice(0, 8)) console.warn(`        - ${p}`);
      console.warn('');
      break;
    default:
      console.warn(`[vtube-pro] integrity: ${r.message} (ignored)`);
  }
  return r;
}
