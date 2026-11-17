// Generates the files for controllers other than the Elgato Stream Deck from the ONE action registry (shared/deck.ts),
// so they never drift from the app:
//   other-devices/touchportal/entry.json          Touch Portal plugin (no background process: "execute" actions → curl)
//   other-devices/touchportal/VTubePro.tpp        the same entry.json zipped (Touch Portal's import file; byte for byte the same every run)
//   other-devices/companion/vtube-pro-http.json   Bitfocus Companion "Generic: HTTP Requests" button list (POST URLs)
//   other-devices/urls.md                         Every action as a POST URL (Streamer.bot, Loupedeck, AutoHotkey, macro pads …)
// Run from the repo root after adding actions: npx tsx tools/streamdeck-plugin/make_other_devices.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECK_ACTIONS, type DeckActionDef } from '../../shared/deck.ts';
import { zipEntries } from './pack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'other-devices');
const BASE = 'http://127.0.0.1:5191/api/deck/run';
const usable = DECK_ACTIONS.filter((a) => !a.local);
const write = (rel: string, text: string) => { const p = path.join(OUT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text.replace(/\r?\n/g, '\n')); console.log('wrote', path.relative(process.cwd(), p)); };
const defaults = (a: DeckActionDef) => Object.fromEntries((a.params ?? []).map((p) => [p.key, String(p.default ?? '')]));
const url = (a: DeckActionDef, params: Record<string, string>) => { const q = new URLSearchParams(params).toString(); return `${BASE}/${a.id}${q ? `?${q}` : ''}`; };

// ---------------------------------------------------------------- Touch Portal (API: entry.json, "execute" actions)
const tpId = (a: DeckActionDef, k?: string) => `vtubepro.${a.id}${k ? `.${k}` : ''}`;
const tpActions = usable.map((a) => {
  const data = (a.params ?? []).map((p) => (p.type === 'select'
    ? { id: tpId(a, p.key), type: 'choice', label: p.label, default: String(p.default ?? p.options?.[0]?.value ?? ''), valueChoices: (p.options ?? []).map((o) => o.value) }
    : { id: tpId(a, p.key), type: p.type === 'number' ? 'number' : 'text', label: p.label, default: String(p.default ?? '') }));
  // Touch Portal fills {$id$} in the command; curl ships with Windows 10+ and macOS. Params go in the query string (no JSON quoting).
  const q = (a.params ?? []).map((p) => `${p.key}={$${tpId(a, p.key)}$}`).join('&');
  const target = `${BASE}/${a.id}${q ? `?${q}` : ''}`;
  return {
    id: tpId(a), prefix: 'VTube Pro', name: a.label, type: 'execute', tryInline: true,
    format: (a.params ?? []).length ? `${a.label}: ${(a.params ?? []).map((p) => `{$${tpId(a, p.key)}$}`).join(' ')}` : a.label,
    execution_cmd: `curl -s -X POST "${target}"`,
    description: a.hint,
    ...(data.length ? { data } : {}),
  };
});
write('touchportal/entry.json', JSON.stringify({
  sdk: 6, version: 100, name: 'VTube Pro', id: 'vtubepro',
  configuration: { colorDark: '#2a1a5a', colorLight: '#7c5cff' },
  categories: [{ id: 'vtubepro.main', name: 'VTube Pro', actions: tpActions }],
}, null, 2) + '\n');

// the .tpp Touch Portal imports is that entry.json in a zip, under VTubePro/ (it went stale when only entry.json was regenerated)
{
  const tpp = path.join(OUT, 'touchportal/VTubePro.tpp');
  fs.writeFileSync(tpp, zipEntries([['VTubePro/entry.json', fs.readFileSync(path.join(OUT, 'touchportal/entry.json'))]]));
  console.log('wrote', path.relative(process.cwd(), tpp));
}

// ---------------------------------------------------------------- Bitfocus Companion ("Generic: HTTP Requests" module)
const presets = usable.flatMap((a) => {
  const sel = a.params?.find((p) => p.type === 'select');
  const variants = sel?.options?.length && (a.params ?? []).length === 1 ? sel.options.map((o) => ({ label: `${a.label}: ${o.label}`, params: { [sel.key]: o.value } })) : [{ label: a.label, params: defaults(a) }];
  return variants.map((v) => ({ group: a.group, label: v.label, method: 'POST', url: url(a, v.params), body: '', contentType: 'application/json', stateful: !!a.stateful }));
});
write('companion/vtube-pro-http.json', JSON.stringify({
  about: 'VTube Pro buttons for Bitfocus Companion. Add the "Generic: HTTP Requests" connection (base URL empty), then per button add the action "POST" with the url below (body empty). Not a .companionconfig import file: see docs/STREAM_DECK.md.',
  buttons: presets,
}, null, 2) + '\n');

// ---------------------------------------------------------------- any tool: URL list
const lines = ['# VTube Pro — every controllable action as a URL', '', 'Generated from `shared/deck.ts` by `tools/streamdeck-plugin/make_other_devices.ts`. See docs/STREAM_DECK.md.', '',
  'Send an HTTP **POST** from this PC (no key needed; tools that can only do GET: copy the per-PC URL with `key=` from VTube Pro → Stream Deck & controllers).', '',
  '| Group | Action | POST URL (default parameters) | Parameters |', '|---|---|---|---|',
  ...usable.map((a) => `| ${a.group} | ${a.icon} ${a.label} | \`${url(a, defaults(a))}\` | ${(a.params ?? []).map((p) => `\`${p.key}\`${p.options ? ': ' + p.options.map((o) => o.value || '""').join(' / ') : ''}`).join('; ') || '—'} |`), ''];
write('urls.md', lines.join('\n'));
