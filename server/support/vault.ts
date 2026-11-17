// Support & store keys, kept on THIS computer only, encrypted at rest (beta.13).
//
// One random 256-bit master key encrypts config/support-secrets.json with AES-256-GCM (Node's built-in crypto). The master
// key itself is protected by the operating system, with no native module and no download:
//   * Windows: DPAPI (CurrentUser) through Windows PowerShell's ProtectedData (built into every Windows 10 / 11). The
//     protected blob sits in config/support-key.dpapi; a copied config folder is useless on another account / PC.
//   * macOS: the login Keychain (`security add-generic-password` / `find-generic-password`).
//   * Linux: the Secret Service (`secret-tool`, libsecret) when a keyring runs.
//   * Otherwise: a key file readable only by this user (chmod 600), shown to the streamer as "Saved on this computer
//     (not locked by the system)". Never silently weaker than that.
// The master key is unwrapped once (lazily), held in memory; the studio only ever learns WHICH fields are saved. Until a
// key is saved there is no vault file and the system key store is never asked (beta.14.1: on Windows that ask is a hidden
// PowerShell, and Emsisoft blocked it from the helper's node.exe as an "exploit attempt" at every helper start).
// Keys never leave this PC: no route returns them, nothing logs them, no web page may write them
// (server/support/routes.ts guard). VTP_SUPPORT_VAULT=plain|dpapi|keychain|libsecret forces a kind (tests).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type VaultKind = 'dpapi' | 'keychain' | 'libsecret' | 'plain';
export const VAULT_LABEL: Record<VaultKind, string> = {
  dpapi: 'Locked by Windows to your account (DPAPI)',
  keychain: 'Locked in your macOS Keychain',
  libsecret: 'Locked in your system keyring',
  plain: 'Saved on this computer only (not locked by the system)',
};

type Secrets = Record<string, Record<string, string>>;
interface SealedFile { v: 1; kind: VaultKind; iv: string; tag: string; data: string }

const ENTROPY = 'vtube-pro-support-v1';
const KEYCHAIN_SERVICE = 'VTube Pro support key';

function run(cmd: string, args: string[], input?: string, timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
    if (input !== undefined) { p.stdin?.end(input); }
  });
}

/** DPAPI through Windows PowerShell 5.1 (always present on Windows; pwsh 7 lacks ProtectedData by default). The data
 *  goes over stdin, never the command line. */
const PS = (protect: boolean) => [
  '-NoProfile', '-NonInteractive', '-Command',
  `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd().Trim();` +
  `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}');` +
  `$o=[Security.Cryptography.ProtectedData]::${protect ? 'Protect' : 'Unprotect'}([Convert]::FromBase64String($i),$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
  `[Console]::Out.Write([Convert]::ToBase64String($o))`,
];
const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export async function dpapiProtect(b64: string): Promise<string> { return run(powershell(), PS(true), b64); }
export async function dpapiUnprotect(b64: string): Promise<string> { return run(powershell(), PS(false), b64); }

export class Vault {
  private key: Buffer | null = null;
  private data: Secrets = {};
  private loading: Promise<void> | null = null;
  /** The protection in use; before anything is saved, the one the first save will try. */
  kind: VaultKind;
  /** Something went wrong reading the vault (shown once in the studio, keys must be pasted again). */
  problem = '';

  constructor(private dir: string, private platform: NodeJS.Platform = process.platform, private force = process.env.VTP_SUPPORT_VAULT as VaultKind | undefined) {
    this.kind = this.pick();
  }

  get file() { return path.join(this.dir, 'support-secrets.json'); }
  /** Nothing was ever saved: nothing to unlock (the first set() makes the key). */
  get empty() { return !fs.existsSync(this.file); }
  private keyFile(kind: VaultKind) { return path.join(this.dir, kind === 'dpapi' ? 'support-key.dpapi' : 'support-key.local'); }

  /** Which protection this PC gets (decided once). */
  private pick(): VaultKind {
    if (this.force && ['dpapi', 'keychain', 'libsecret', 'plain'].includes(this.force)) return this.force;
    if (this.platform === 'win32') return 'dpapi';
    if (this.platform === 'darwin') return 'keychain';
    return 'libsecret';
  }

  ready(): Promise<void> {
    if (!this.loading) this.loading = this.load().catch((e) => { this.problem = (e as Error).message; console.warn('[support] vault:', (e as Error).message); });
    return this.loading;
  }

  private async load() {
    let sealed: SealedFile | null = null;
    try { sealed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as SealedFile; } catch { sealed = null; }
    const want = sealed?.kind ?? this.pick();
    this.key = await this.masterKey(want, !!sealed);
    if (sealed && this.key) {
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
        d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        this.data = JSON.parse(Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8')) as Secrets;
      } catch {
        this.data = {};
        this.problem = 'Your saved support keys could not be unlocked on this account. Paste them again.';
      }
    }
  }

  /** Get (or make) the master key under `kind`; falls back to a plain key file when the system store isn't usable. */
  private async masterKey(kind: VaultKind, existing: boolean): Promise<Buffer> {
    fs.mkdirSync(this.dir, { recursive: true });
    const tryKind = async (k: VaultKind): Promise<Buffer | null> => {
      try {
        if (k === 'dpapi') {
          const f = this.keyFile('dpapi');
          if (fs.existsSync(f)) return Buffer.from(await dpapiUnprotect(fs.readFileSync(f, 'utf8').trim()), 'base64');
          const key = crypto.randomBytes(32);
          const blob = await dpapiProtect(key.toString('base64'));
          if (!blob) return null;
          writeAtomic(f, blob);
          return key;
        }
        if (k === 'keychain') {
          try { const v = await run('security', ['find-generic-password', '-a', 'vtube-pro', '-s', KEYCHAIN_SERVICE, '-w']); if (v) return Buffer.from(v, 'base64'); } catch { /* none yet */ }
          const key = crypto.randomBytes(32);
          // the key goes over stdin (`security -i` reads its command there), never the command line (`ps` shows that)
          await run('security', ['-i'], `add-generic-password -a vtube-pro -s "${KEYCHAIN_SERVICE}" -U -w ${key.toString('base64')}\n`);
          const back = await run('security', ['find-generic-password', '-a', 'vtube-pro', '-s', KEYCHAIN_SERVICE, '-w']);
          return back === key.toString('base64') ? key : null;
        }
        if (k === 'libsecret') {
          try { const v = await run('secret-tool', ['lookup', 'app', 'vtube-pro', 'kind', 'support-key']); if (v) return Buffer.from(v, 'base64'); } catch { /* none yet */ }
          const key = crypto.randomBytes(32);
          await run('secret-tool', ['store', '--label=VTube Pro support key', 'app', 'vtube-pro', 'kind', 'support-key'], key.toString('base64'));
          const back = await run('secret-tool', ['lookup', 'app', 'vtube-pro', 'kind', 'support-key']);
          return back === key.toString('base64') ? key : null;
        }
        // plain: a key file only this user can read
        const f = this.keyFile('plain');
        if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
        const key = crypto.randomBytes(32);
        writeAtomic(f, key.toString('base64'), 0o600);
        await lockToUser(f);
        return key;
      } catch (e) {
        if (k !== 'plain') console.warn(`[support] vault: the system key store (${k}) isn't usable here: ${(e as Error).message.split('\n')[0]}`);
        return null;
      }
    };
    const k1 = await tryKind(kind);
    if (k1 && k1.length === 32) { this.kind = kind; return k1; }
    if (existing && kind !== 'plain') throw new Error('The system key store did not unlock your saved support keys. Paste them again.');
    const k2 = await tryKind('plain');
    if (!k2) throw new Error('Could not make a key file for your support keys.');
    this.kind = 'plain';
    return k2;
  }

  private save() {
    if (!this.key) throw new Error('vault not ready');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(this.data), 'utf8')), c.final()]);
    const sealed: SealedFile = { v: 1, kind: this.kind, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    writeAtomic(this.file, JSON.stringify(sealed), 0o600);
    // (each save is a new file by rename: it gets the ACL again)
    if (this.kind === 'plain') void lockToUser(this.file);
  }

  /** A saved value ('' when none). Call after ready(). */
  get(scope: string, field: string): string { return this.data[scope]?.[field] ?? ''; }
  /** The fields saved for a scope (names only: what the studio may see). */
  saved(scope: string): string[] { return Object.keys(this.data[scope] ?? {}).filter((k) => !!this.data[scope][k]); }
  /** Set / clear fields (null or '' clears). */
  async set(scope: string, fields: Record<string, string | null | undefined>) {
    await this.ready();
    if (!this.key) throw new Error(this.problem || 'Your keys can’t be saved on this computer right now.');
    const cur = { ...(this.data[scope] ?? {}) };
    for (const [k, v] of Object.entries(fields)) { if (v === undefined) continue; if (v === null || v === '') delete cur[k]; else cur[k] = String(v); }
    if (Object.keys(cur).length) this.data[scope] = cur; else delete this.data[scope];
    this.save();
    this.problem = '';
  }
  async clear(scope: string) { await this.ready(); delete this.data[scope]; if (this.key) this.save(); }
}

/** The plain fallback on Windows: chmod does nothing there, so the file gets an explicit ACL (this user only, no
 *  inherited entries). Best effort: the studio already labels the plain kind "not locked by the system". */
export async function lockToUser(file: string) {
  if (process.platform !== 'win32') return;
  const user = process.env.USERNAME ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME}` : '';
  if (!user) return;
  try { await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `${user}:F`]); } catch (e) { console.warn('[support] could not lock the key file to this user:', (e as Error).message.split('\n')[0]); }
}

export function writeAtomic(file: string, text: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode) { try { fs.chmodSync(file, mode); } catch { /* windows */ } }
}
