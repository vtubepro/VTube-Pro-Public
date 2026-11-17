// VTube Pro local server: REST API + /library static files + /ws pub/sub bus.
// Listens on 127.0.0.1:5191 (Vite proxies /api, /library and /ws to it in dev).
import express, { type ErrorRequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { attachBus, broadcast, busClientCount, outputPages } from './bus.ts';
import { onPendingChange, setApprovalOpener, setStudioOpen } from './aiconnect.ts';
import { loadJobs } from './jobs.ts';
import { HttpError, invalidateAvatars } from './library.ts';
import { BUILTIN_DIR, CACHE_DIR, CONFIG_DIR, DATA_DIR, DATA_WHY, HOST, JOBS_DIR, LIBRARY_DIR, PORT, ROOT, SHIPPED_SCENES_DIR, USER_SCENES_DIR } from './paths.ts';
import { moveUserRooms } from './userRooms.ts';
import { moveUserAvatars } from './userAvatars.ts';
import { avatarRoutes } from './routes/avatars.ts';
import { rigEditRoutes } from './rigEdit.ts';
import { importConvertRoutes } from './routes/importConvert.ts';
import { docsRoutes } from './routes/docsView.ts';
import { blenderRoutes } from './routes/blender.ts';
import { costumeRoutes } from './routes/costumes.ts';
import { diagRoutes } from './routes/diag.ts';
import { GpuWatch, gpuWatchRoutes } from './gpuWatch.ts';
import { jobRoutes } from './routes/jobs.ts';
import { liveRoutes } from './routes/live.ts';
import { discordRoutes } from './routes/discord.ts';
import { sceneRoutes } from './routes/scenes.ts';
import { chatRoutes, startChat } from './routes/chat.ts';
import { startSupport, supportRouter } from './support/index.ts';
import { obsRoutes } from './obs.ts';
import { broadcastRoutes } from './routes/broadcast.ts';
import { streamKeysRoutes } from './routes/streamKeys.ts';
import { obsSetupRoutes } from './obsSetup.ts';
import { obsGamingRoutes } from './obsGaming.ts';
import { gameWindowRoutes } from './gameWindow.ts';
import { brbRoutes } from './routes/brb.ts';
import { captureRoutes } from './screenFeed.ts';
import { createExternal } from './routes/external.ts';
import { systemRoutes } from './routes/system.ts';
import { setupRoutes } from './routes/setup.ts';
import { ttrpgRoutes } from './routes/ttrpg.ts';
import { trailRoutes } from './routes/trail.ts';
import { deckRoutes } from './deck.ts';
import { goalsRoutes, startGoals } from './goals.ts';
import { videoRoutes } from './routes/videos.ts';
import { gpuRoutes } from './gpuSidecars.ts';
import { capabilityRoutes } from './capability.ts';
import { openSeeFaceRoutes } from './tracking/openSeeFace.ts';
import { rigMlRoutes } from './rigMl.ts';
import { attachCaptionSockets, captionRoutes, captions } from './captions/routes.ts';
import { voiceRoutes } from './voice/routes.ts';
import { kokoroRoutes } from './kokoro.ts';
import { attachSpout, spoutRoutes } from './spout.ts';
import { loadSettings } from './settings.ts';
import { localGuard } from './localGuard.ts';
import { streamPc } from './streamPc.ts';
import { guestFeed } from './guestFeed.ts';
import { reportIntegrity } from './integrity.ts';
import { applyReleaseGuard } from './hardening.ts';
import { aiconnectRoutes } from './routes/aiconnect.ts';
import { to3dRoutes } from './to3d/routes.ts';
import { noteMcpClient } from './to3d/readiness.ts';
import { toolsRoutes } from './toolsCatalog.ts';
import { aiSetupRoutes } from './aiSetup.ts';
import { aiAddonsRoutes } from './aiAddons.ts';
import { autopilotRoutes } from './routes/autopilot.ts';
import { aiConnectorRoutes } from './routes/aiConnectors.ts';
import { roomImportRoutes } from './routes/roomImport.ts';
import { roomEditRoutes } from './routes/roomEdits.ts';
import { flat2dRoomRoutes } from './routes/flat2dRooms.ts';
import { overlayStageRoutes } from './routes/overlayStages.ts';
import { healthRoutes } from './routes/health.ts';
import { licenceHeader, licenceRoutes } from './licenseNotice.ts';
import { relaySetupRoutes } from './routes/relaySetup.ts';
import { localAiRoutes } from './routes/localAi.ts';
import { createComfyWorkflowRoutes } from './routes/comfyWorkflows.ts';
import { realLauncher } from './toolsCatalog.ts';
import { createMusic } from './music/routes.ts';
import { toolOs } from '../shared/toolsDetect.ts';
import { mountB16Server } from './b16/mount.ts';

export { broadcast };

// first, before anything is written or listened on: release mode (VTP_BUILD=release) refuses --inspect / NODE_OPTIONS debuggers
// and closes a late-opened inspector (server/hardening.ts; a normal checkout is untouched)
applyReleaseGuard();

// A stray rejection or an 'error' event nobody listens for would end the process, and with it the studio <-> OBS bus in
// the middle of a stream (the supervisor does not restart it). Log and keep serving; only a storm of them (a loop that
// throws every tick) exits, so a broken server never spins forever.
let crashes: number[] = [];
function keepAlive(kind: string, e: unknown) {
  const now = Date.now();
  crashes = crashes.filter((t) => now - t < 10_000);
  crashes.push(now);
  if (crashes.length <= 20) console.error(`[vtube-pro] ${kind} (kept running):`, e);
  if (crashes.length > 50) { console.error('[vtube-pro] too many errors in 10 s, stopping'); process.exit(1); }
}
process.on('unhandledRejection', (r) => keepAlive('unhandled rejection', r));
process.on('uncaughtException', (e) => keepAlive('uncaught exception', e));

for (const d of [LIBRARY_DIR, CACHE_DIR, JOBS_DIR, CONFIG_DIR, BUILTIN_DIR]) fs.mkdirSync(d, { recursive: true });
// a release keeps everything it writes in the user's own folder (server/paths.ts dataHome); say where, once
if (DATA_WHY !== 'source') console.log(`[vtube-pro] your settings, avatars and cache live in ${DATA_DIR}`);
// a release keeps the user's own rooms out of the program folder (updates replace it): move any left there (server/userRooms.ts)
if (DATA_WHY === 'release') { try { moveUserRooms(ROOT, SHIPPED_SCENES_DIR, USER_SCENES_DIR, (s) => console.log(s)); } catch { /* never blocks startup */ } }
// the user's own avatars left in the program folder (an AI app or a creator script put them there): into the library,
// where the user can delete them (server/userAvatars.ts; a release only: no release_manifest.json = a source checkout, never touched).
try {
  const n = (await moveUserAvatars(ROOT, BUILTIN_DIR, LIBRARY_DIR, (s) => console.log(s))).length;
  if (n) invalidateAvatars();
} catch { /* never blocks startup */ }
loadSettings(); // creates config/settings.json from the example on first run
loadJobs();
try { reportIntegrity(); } catch { /* integrity check must never block startup */ } // verify the signed manifest of the shipped bundle (server/integrity.ts); no-op on a source/dev install

const app = express();
app.disable('x-powered-by');
// DNS-rebinding / cross-site guard: loopback Host only; state-changing requests need no Origin or a loopback one (server/localGuard.ts);
// no website is ever allowed (no pairing, no CORS)
app.use(licenceHeader); // every answer names the licence: a hosted copy identifies itself (server/licenseNotice.ts, docs/LICENSE_ENFORCEMENT.md)
app.use(licenceRoutes); // GET /licence.txt
app.use(streamPc().gate()); // Stream PC mode (off by default): requests from the home network are decided here, first and only (server/streamPc.ts)
app.use(localGuard());
app.use(noteMcpClient); // which AI app's MCP server is calling (X-VTP-MCP-Client): the 3D-version drawer's "Claude talked to VTube Pro" (server/to3d/readiness.ts)
// Generation requests carry reference images as data URLs, so allow large JSON bodies.
// Upload routes take raw bodies (even application/json ones, e.g. diag state.json), so skip JSON parsing there.
const JSON_MEDIA = /^\s*application\/([\w.+-]+\+)?json\s*(;|$)/i;
const RAW_ROUTES = /^\/api\/(diag\/|avatars\/[^/]+\/(thumbnail|snapshot|costumes\/import)$|avatars\/import$|party\/[^/]+\/(model|costume)$|support\/hook\/)/;
app.use(
  express.json({
    limit: '100mb',
    // A browser page (it sends Origin) only gets JSON parsed for a real JSON media type: "text/plain; x=json" is a CORS
    // "simple" request (no preflight) and must not reach the routes as JSON. Tools without Origin (Stream Deck, curl) keep
    // the lenient match.
    type: (req) => (req.headers.origin === undefined ? /json/i : JSON_MEDIA).test(String(req.headers['content-type'] ?? '')) && !RAW_ROUTES.test((req.url ?? '').split('?')[0]),
  }),
);

app.use(healthRoutes); // GET /health + POST /api/helper/shutdown (another copy on this computer asks this one to stop; refused while live) (server/routes/health.ts)
app.use(streamPc().routes()); // "Streaming from a second PC": the switch, pairing codes, paired stream PCs, firewall (this PC only)
app.use(guestFeed().routes()); // "Be a guest on someone else's show": the link for another streamer's OBS, its sender browser, Allow / Block (this PC only, server/guestFeed.ts)
app.use(systemRoutes);
app.use(costumeRoutes);
app.use(avatarRoutes);
app.use(rigEditRoutes); // "Edit rig": a 2D avatar from the maker saved back over the same avatar, one backup + undo (server/rigEdit.ts)
app.use(docsRoutes);
app.use(blenderRoutes);
app.use(diagRoutes);
// the graphics card's memory + utilisation while an OBS page is connected (a game holding it: shared/gpuStat.ts)
const gpuWatch = new GpuWatch(() => outputPages().inObs > 0, (m) => broadcast(m));
app.use(gpuWatchRoutes(gpuWatch));
app.use(jobRoutes);
app.use(liveRoutes);
app.use(discordRoutes);
app.use(relaySetupRoutes); // "Set up my invite server": the local page that puts the relay on the streamer's Cloudflare (server/routes/relaySetup.ts)
app.use(sceneRoutes);
app.use(roomEditRoutes); // Room editor: the user's own override layer per room (<data>/room-edits) + placeable props (server/routes/roomEdits.ts, docs/ROOM_EDITOR.md)
app.use(chatRoutes);
app.use(supportRouter()); // Support & store: tips, merch, patrons, wishlists → one support bus; keys encrypted on this PC (server/support/*, docs/SUPPORT.md)
app.use(obsRoutes);
app.use(obsSetupRoutes); // "Set up OBS" wizard (lane obs-wizard)
app.use(broadcastRoutes); // VTube Pro Live control plane: /api/broadcast/* Go Live with a fresh intent token, destinations, keys, record, replay (server/routes/broadcast.ts, docs/BROADCAST_PROTOCOL.md)
app.use(streamKeysRoutes); // /stream-keys: VTube Pro's own page for stream keys and a typed address, so a key page with a 'local-page' origin exists (server/routes/streamKeys.ts, R3-15)
app.use(obsGamingRoutes); // Gaming at 60 FPS: "this game blocks Game Capture" one-click fallback + OBS advice (server/obsGaming.ts)
app.use(gameWindowRoutes); // GET /api/game/fullscreen: is a fullscreen game running? (server/gameWindow.ts; on demand only)
app.use(brbRoutes); // your own BRB screen: one picture / short video kept on this computer (server/routes/brb.ts)
app.use(captureRoutes); // fast window feed for the react screen (server/screenFeed.ts, ws /ws/screen)
app.use(setupRoutes); // setup wizards + "Generate new room" requests (UI overhaul)
app.use(ttrpgRoutes()); // TTRPG: AI GM (a model on this PC), TTS/STT, campaign saves, the VTT bridge (docs/TTRPG.md)
app.use(videoRoutes); // screen video library + POST /api/scene/video (server/routes/videos.ts)
attachSpout(); app.use(spoutRoutes); // Spout2 performers: GET /api/spout + ws /ws/spout (server/spout.ts, tools/spout/spout_rx.py)
app.use(openSeeFaceRoutes(DATA_DIR)); // the optional light face tracker's models (OpenSeeFace, BSD-2): status, user-click install, local-only model files (server/tracking/openSeeFace.ts)
app.use(capabilityRoutes); // "What can my PC do?": GET /api/capability = the measured report + the per-feature matrix (server/capability.ts)
app.use(gpuRoutes); // GPU tracking sidecars: Audio2Face-3D lip sync, RTMW body, Maxine (server/gpuSidecars.ts)
app.use(rigMlRoutes); // optional ML rigging pack (offered to every user, installed on their click): status, on-demand install, rig job (server/rigMl.ts)
app.use(voiceRoutes); // local voice pack: one-click, consented install of live captions + the Kokoro alert voice (server/voice/, tools/voice/)
app.use(kokoroRoutes()); // Kokoro-82M alert voice on this PC: status + text -> WAV (server/kokoro.ts, read-aloud engine "kokoro")
app.use(captionRoutes()); // live captions: faster-whisper sidecar, OBS overlay, SRT/VTT (server/captions/, docs/LIVE_CAPTIONS.md)
app.use(deckRoutes); // Stream Deck & controllers: action registry, layout, /ws/deck (server/deck.ts, docs/STREAM_DECK.md)
app.use(goalsRoutes); // goals, stretch goals, incentives + the subathon timer: /api/goals/* (server/goals.ts)
app.use(trailRoutes); // The Trail party game: theme packs + graveyard / run history (src/game/trail, saves/trail)
app.use(aiConnectorRoutes()); // "Connect an AI in 3 steps" + the narrow AI API (server/routes/aiConnectors.ts)
app.use(autopilotRoutes); // autopilot: open the browser's / OS's camera + mic settings, who holds the camera, tools + first-run facts (server/routes/autopilot.ts)
app.use(aiSetupRoutes); // "Set up AI creation": Blender found + saved, MCP added to the AI apps, self-tests (server/aiSetup.ts)
app.use(aiAddonsRoutes); // "Make your AI better": add-ons per AI app (our skill, Blender / GIMP MCP), consented installs (server/aiAddons.ts)
app.use(toolsRoutes); // Tools list: detect Blender / ffmpeg / local AI / OBS plugins, consented installs (server/toolsCatalog.ts)
app.use(roomImportRoutes); // "Add my room": room check, Blender conversion, automatic seats, install (shared/roomCheck.ts)
app.use(flat2dRoomRoutes); // 2D environments from pictures (shared/flat2dRoom.ts)
app.use(overlayStageRoutes); // 2.5D overlays around 2D avatars: list, files, import, delete (shared/overlayStage.ts)
app.use(importConvertRoutes); // "Just drop a model": FBX / OBJ / .blend … converted by Blender for the studio's import report (shared/modelImport)
app.use(to3dRoutes); // Pro2D -> 3D with the user's own AI + Blender MCP: readiness, jobs, the to3d_* tools' API, the render page (server/to3d/routes.ts, docs/PRO2D_TO_3D.md)
app.use(aiconnectRoutes); // AI connectors: MCP clients, approvals, creation packages, built-in AI host, /mcp (docs/AI_CONNECT.md)
app.use(localAiRoutes); // Local AI recommender: consent-gated read-only hardware scan, model + ComfyUI picks, /local-ai (docs/LOCAL_AI.md)
app.use(createComfyWorkflowRoutes({ openUrl: (u) => realLauncher.openUrl(u, toolOs(process.platform)!) })); // shareable ComfyUI workflows + consented "Set it up for me", /comfyui (docs/COMFYUI.md)
const external = createExternal();
app.use(external.routes);
const music = createMusic(); // DJ sync: the music clock from DJ gear / DJ software + the studio's audio (server/music, docs/DJ_SYNC.md)
app.use(music.routes);
await mountB16Server(app); // beta.16 stream extras: rules, items, throw ... one lazy loader, a lane that fails is skipped (server/b16/mount.ts)

// Stable production build of the web client (npm run build → dist/). OBS should point here
// (http://127.0.0.1:5191/output.html): unlike the Vite dev server on :5190 it never hot-reloads
// while code is being edited.
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const DIST_ASSETS = path.join(DIST, 'assets') + path.sep;
// Clickjacking: a hostile site must not frame the studio under a transparent overlay and lure the Go Live / Start clicks.
// The two pages that carry the Go Live buttons (the studio and the pop-out Live panel) may be framed by themselves only.
// The other studio pages are framed by the studio (the room preview is a cross-site iframe, localhost <-> 127.0.0.1 on one
// port: src/scene/previewBridge.ts; the tool drawer; the game overlay), so they allow exactly the four loopback studio origins.
// (Where a CSP frame-ancestors is present the browser ignores X-Frame-Options, so the allowlisted pages send the CSP only.)
const STUDIO_FRAME_SELF = new Set(['index.html', 'live.html']);
const STUDIO_FRAME_ANCESTORS = "frame-ancestors 'self' http://localhost:5190 http://127.0.0.1:5190 http://localhost:5191 http://127.0.0.1:5191";
function studioFraming(res: { setHeader(name: string, value: string): unknown }, file: string): void {
  if (!/\.html$/i.test(file)) return;
  if (STUDIO_FRAME_SELF.has(path.basename(file).toLowerCase())) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  } else res.setHeader('Content-Security-Policy', STUDIO_FRAME_ANCESTORS);
}
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, {
    index: 'index.html',
    // only Vite's hashed output (dist/assets/) can cache forever; HTML entry points and the copied public/ files keep
    // their names across updates (MediaPipe models + wasm, vendor/, comfy-workflows/index.json, the web manifest), so a
    // browser / OBS revalidates them (ETag: a 304 costs a stat) instead of serving last version's copy for a year
    setHeaders: (res, file) => { res.setHeader('Cache-Control', file.startsWith(DIST_ASSETS) && !/\.html$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'); studioFraming(res, file); },
  }));
}

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown API endpoint' });
});

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : typeof err?.status === 'number' ? err.status : 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return;
  res.status(status).json({ error: err?.message ?? String(err) });
};
app.use(onError);

const server = http.createServer(app);
// the port is taken (another VTube Pro, another program): say so and exit, so the launcher's port check takes over
// (the keep-alive handlers above would otherwise leave a server running that listens on nothing)
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `[vtube-pro] port ${PORT} is already in use: is VTube Pro already running?` : `[vtube-pro] server error: ${e.message}`);
  process.exit(1);
});
streamPc().attach(app, server); // its LAN listener (when on) shares this app + this server's WebSocket router
const busWss = attachBus(server);
attachCaptionSockets(); // ws /ws/captions-in (the studio's mic audio) + /ws/captions (the OBS overlay page)
gpuWatch.start();
external.start(busWss);
music.start(busWss); // (a passive tap of the studio's beat packets; off until the user turns DJ sync on)
// An AI waits for the user's OK (blender_run_python, install_creation_package ...): every studio page hears it and shows
// "Your AI is waiting for your OK" (src/app.ts); with no studio open, the helper opens its approval
// page itself (server/aiconnect.ts showApprovalPage). Never the script: tool, app and time only.
setStudioOpen(() => busClientCount() - outputPages().count > 0);
setApprovalOpener((url) => { void realLauncher.openUrl(url, process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux').catch(() => {}); });
onPendingChange((list) => broadcast({ type: 'command', command: 'ai-approvals', args: { waiting: list.length, items: list.slice(0, 5).map((p) => ({ tool: p.tool, client: p.client, at: p.createdAt })) } }));
server.listen(PORT, HOST, () => {
  console.log(`[vtube-pro] server on http://${HOST}:${PORT}  (ws: /ws)`);
  startChat(); // live chat connectors: only the platforms enabled in config/chat.json (none by default)
  startSupport(); // support services the streamer connected (none by default) + the webhook inbox + the store cache
  startGoals(); // goals + the subathon timer: the engine up at start (server/goals.ts)
  void captions.resume(); // live captions come back if the user left them on (config/captions.json)
});
