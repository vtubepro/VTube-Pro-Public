// Support & store (beta.13): the one place the helper builds the support hub and its parts, and the two hooks
// server/index.ts calls (supportRouter() mounted with the other routes, startSupport() once the server listens).
// Nothing connects until the streamer connects a service; nothing is ever sent to a service except reads with their
// own key and the store changes they confirm in the studio.
import path from 'node:path';
import type { Router } from 'express';
import { broadcast } from '../bus.ts';
import { chatHub, chatListeners } from '../chat/hub.ts';
import { CACHE_DIR, CONFIG_DIR, SAVES_DIR } from '../paths.ts';
import { savedRelayUrl } from '../routes/discord.ts';
import { SUPPORT_SERVICES } from '../../shared/supportConfig.ts';
import { makeConnector } from './connectors/index.ts';
import { SupportHub } from './hub.ts';
import { InboxClient } from './inbox.ts';
import { supportRoutes } from './routes.ts';
import { Store } from './store.ts';
import { Supporters, setSupporters } from './supporters.ts';

export const supportHub = new SupportHub({
  configDir: CONFIG_DIR, savesDir: SAVES_DIR, cacheDir: CACHE_DIR, broadcast,
  chat: { onFinance: (f, t, e, q) => chatHub.onFinance(f, t, e, q), onChat: (c, t) => chatHub.onChat(c, t), listeners: chatListeners, status: () => chatHub.snapshot() },
  connectors: (id) => makeConnector(id),
});
// a platform's own connector is live → its StreamElements / Streamlabs copies are dropped
for (const s of SUPPORT_SERVICES) supportHub.setNativeCheck(s, () => supportHub.connector(s)?.status().state === 'live');
export const supportInbox = new InboxClient(supportHub, () => savedRelayUrl());
export const supportStore = new Store(supportHub, CACHE_DIR, SAVES_DIR);
export const supportSupporters = new Supporters(supportHub, SAVES_DIR);
setSupporters(supportSupporters);
// `!link` in any chat (the line still shows: chat lines are the streamer's, we only read them)
chatListeners.add((e) => { if (e.kind === 'chat' && /^\s*!link\b/i.test(e.text)) supportSupporters.onChat(e); });

export function supportRouter(): Router {
  return supportRoutes({ hub: supportHub, inbox: supportInbox, store: supportStore, supporters: supportSupporters, imgDir: path.join(CACHE_DIR, 'support', 'img') });
}

/** Server start: connect what the streamer connected, drain the webhook inbox, catch up, load the store. */
export function startSupport() {
  void (async () => {
    try {
      await supportHub.start();
      supportInbox.start();
      supportStore.start();
    } catch (e) { console.warn('[support] start failed', e); }
  })();
}
process.on('exit', () => { try { supportHub.stop(); supportInbox.stop(); supportStore.stop(); } catch { /* exiting */ } });
