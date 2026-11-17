// Build the invite server (the Cloudflare Worker in relay/) into ONE minified file that the studio's
// "Set up my invite server" page uploads to YOUR Cloudflare account.
//
//   node tools/build_relay.mjs [--root <tree>] [--out <dir>]
//
// Output: <root>/relay/dist/{worker.js, relay-manifest.json} (git-ignored). The server runs this by itself the first
// time the page needs it (server/routes/relaySetup.ts). esbuild is already installed (a vite dependency). No network.
import esbuild from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const getArg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const ROOT = path.resolve(getArg('--root', path.resolve(HERE, '..')));
const OUT = path.resolve(getArg('--out', path.join(ROOT, 'relay', 'dist')));
const RELAY = path.join(ROOT, 'relay');

const toml = fs.readFileSync(path.join(RELAY, 'wrangler.toml'), 'utf8');
const tomlStr = (k) => (new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm').exec(toml) ?? [])[1] ?? '';
const scriptName = tomlStr('name') || 'vtube-pro-relay';
const compatibilityDate = tomlStr('compatibility_date');
if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) throw new Error('relay/wrangler.toml: compatibility_date missing');
// [[durable_objects.bindings]] name / class_name and the LAST [[migrations]] tag + its sqlite classes
const doBlock = /\[\[durable_objects\.bindings\]\]\s*\n\s*name\s*=\s*"([^"]+)"\s*\n\s*class_name\s*=\s*"([^"]+)"/.exec(toml);
const migs = [...toml.matchAll(/\[\[migrations\]\]\s*\n\s*tag\s*=\s*"([^"]+)"\s*\n\s*new_sqlite_classes\s*=\s*\[([^\]]*)\]/g)];
if (!doBlock || !migs.length) throw new Error('relay/wrangler.toml: Durable Object binding / migration not found');
const migrations = migs.map((m) => ({ tag: m[1], newSqliteClasses: [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]) }));
// every top-level Durable Object binding (beta.13: ROOMS → Room + INBOXES → Inbox, the webhook inbox); `durableObject`
// stays the first one for helpers that only know one
const doBlocks = [...toml.matchAll(/^\[\[durable_objects\.bindings\]\]\s*\n\s*name\s*=\s*"([^"]+)"\s*\n\s*class_name\s*=\s*"([^"]+)"/gm)].map((m) => ({ binding: m[1], className: m[2] }));
// the plain [vars] defaults (all empty / neutral in the template: a check below refuses anything that looks personal)
const varsBlock = /^\[vars\]\s*\n([\s\S]*?)(?=^\[|\s*$(?![\s\S]))/m.exec(toml)?.[1] ?? '';
const vars = Object.fromEntries([...varsBlock.matchAll(/^([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1], m[2]]));
for (const k of ['HOST_USER_IDS', 'PUBLIC_NAME', 'DISCORD_CLIENT_ID', 'TURN_KEY_ID', 'TURN_URLS']) {
  if (vars[k]) throw new Error(`relay/wrangler.toml: ${k} must be empty in the shipped template`);
}

let version = '0.0.0';
try { version = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? version); } catch { /* keep */ }
const BANNER = `/*! VTube Pro invite server ${version} - (c) VTube Pro. See LICENSE. Machine-generated: do not edit. */`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const outfile = path.join(OUT, 'worker.js');
await esbuild.build({
  entryPoints: [path.join(RELAY, 'src', 'index.ts')],
  outfile,
  ...(fs.existsSync(path.join(RELAY, 'tsconfig.json')) ? { tsconfig: path.join(RELAY, 'tsconfig.json') } : {}),
  bundle: true,
  format: 'esm',
  platform: 'neutral',         // the Workers runtime: Web APIs only, no Node built-ins
  mainFields: ['module', 'main'],
  target: 'es2022',
  minify: true,
  sourcemap: false,            // never ship source maps
  legalComments: 'none',
  banner: { js: BANNER },
  charset: 'utf8',
  logLevel: 'warning',
});
const code = fs.readFileSync(outfile);
const text = code.toString('utf8');
// guard rails: no source map hint, the two exports the platform needs, nothing Node-only
if (/sourceMappingURL/.test(text)) throw new Error('worker.js carries a source map reference');
if (!/export\s*\{[^}]*\bas default\b/.test(text) && !/export default/.test(text)) throw new Error('worker.js has no default export');
if (!/\bRoom\b/.test(text)) throw new Error('worker.js does not export the Room class');
if (/from\s*"node:/.test(text) || /require\(/.test(text)) throw new Error('worker.js imports Node built-ins');

const manifest = {
  v: 1,
  kind: 'vtube-pro-relay',
  version,
  scriptName,
  mainModule: 'worker.js',
  bytes: code.length,
  sha256: crypto.createHash('sha256').update(code).digest('hex'),
  compatibilityDate,
  durableObject: { binding: doBlock[1], className: doBlock[2] },
  ...(doBlocks.length > 1 ? { durableObjects: doBlocks } : {}),
  migrations,
  vars,
  workersDev: true,
  previewUrls: false,
  observability: false,
};
fs.writeFileSync(path.join(OUT, 'relay-manifest.json'), JSON.stringify(manifest, null, 1) + '\n');

console.log(`[relay] built relay/dist/worker.js (${code.length} bytes)`);
