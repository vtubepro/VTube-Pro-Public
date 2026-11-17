// VTT bridge: a small WebSocket at ws://127.0.0.1:5191/ws/vtt that the Foundry VTT module, the Owlbear Rodeo extension
// and the Roll20 userscript (tools/ttrpg/*) connect to FROM THE USER'S OWN BROWSER. They relay dice rolls, chat,
// initiative and token positions into VTube Pro so the 3D table mirrors the VTT. Nothing is sent back to the VTT, no
// logins are automated, no credentials of ours are involved.
// Safety: off until the host enables it (TTRPG → VTT bridge); every client must present the pairing code shown there
// (a random token in config/ttrpg.json — foreign web pages can open sockets to 127.0.0.1, the code is what stops a
// random site from injecting rolls); messages are schema-sanitised (shared/ttrpg/wire.ts) and rate-limited.
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { broadcast, onUpgrade } from '../bus.ts';
import { sanitizeVtt, type VttSource } from '../../shared/ttrpg/wire.ts';
import { loadTtrpgConfig } from './config.ts';

interface Client { id: string; src: VttSource; name: string; at: number; ws: WebSocket; tok: number; tokAt: number }
const clients = new Map<string, Client>();
let wss: WebSocketServer | null = null;
const SRCS: VttSource[] = ['foundry', 'owlbear', 'roll20', 'generic'];

export function bridgeStatus() { return [...clients.values()].map((c) => ({ id: c.id, src: c.src, name: c.name, at: c.at })); }
const announce = () => broadcast({ type: 'ttrpg', m: { k: 'vttStatus', clients: bridgeStatus() } });

export function startVttBridge() {
  if (wss) return;
  wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
  onUpgrade('/ws/vtt', (req: IncomingMessage, socket, head) => {
    const cfg = loadTtrpgConfig();
    if (!cfg.bridge.enabled) { socket.destroy(); return; }
    // the code may come in the URL (?code=…) or in the first 'hello' message
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    wss!.handleUpgrade(req, socket, head, (ws) => accept(ws, url.searchParams.get('code') ?? '', url.searchParams.get('src') ?? ''));
  });
}

function accept(ws: WebSocket, code: string, srcHint: string) {
  const cfg = loadTtrpgConfig();
  let client: Client | null = null;
  const pair = (c: string, src: string, name: string) => {
    if (c !== cfg.bridge.token) { ws.send(JSON.stringify({ k: 'error', message: 'Wrong pairing code — copy it from VTube Pro → TTRPG → VTT bridge.' })); ws.close(4001, 'bad code'); return false; }
    const id = Math.random().toString(36).slice(2, 10);
    client = { id, src: SRCS.includes(src as VttSource) ? src as VttSource : 'generic', name: String(name || src || 'VTT').replace(/[^\w .()-]/g, '').slice(0, 40), at: Date.now(), ws, tok: 30, tokAt: Date.now() };
    clients.set(id, client);
    ws.send(JSON.stringify({ k: 'welcome', id, app: 'VTube Pro', v: 1 }));
    announce();
    return true;
  };
  if (code && !pair(code, srcHint, srcHint)) return;
  const helloTimer = setTimeout(() => { if (!client) ws.close(4002, 'no hello'); }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!client) { if (m.k === 'hello' && typeof m.code === 'string') pair(m.code, String(m.src ?? ''), String(m.name ?? '')); return; }
    const c = client as Client;
    const now = Date.now();
    c.tok = Math.min(30, c.tok + ((now - c.tokAt) / 1000) * 10); c.tokAt = now;
    if (c.tok < 1) return;
    c.tok -= 1; c.at = now;
    if (m.k === 'ping') { ws.send(JSON.stringify({ k: 'pong' })); return; }
    const v = sanitizeVtt(m, c.src);
    if (v) broadcast({ type: 'ttrpg', m: { k: 'vtt', m: v } });
  });
  ws.on('close', () => { clearTimeout(helloTimer); if (client) { clients.delete((client as Client).id); announce(); } });
  ws.on('error', () => ws.terminate());
}
