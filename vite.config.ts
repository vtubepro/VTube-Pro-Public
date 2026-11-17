import { defineConfig } from 'vite';

const SERVER = 'http://127.0.0.1:5191';

export default defineConfig({
  server: {
    port: 5190,
    // the dev studio is never framed by a stranger's page (clickjacking on Go Live). Loopback studio origins only: the room
    // preview is a cross-site iframe (localhost <-> 127.0.0.1), so the allowlist, not 'self' alone. X-Frame-Options is the
    // old-browser lock; where frame-ancestors is present the browser uses that instead. (server/index.ts is the same policy
    // for the built studio, and tightens index.html and live.html to 'self'.)
    headers: {
      'Content-Security-Policy': "frame-ancestors 'self' http://localhost:5190 http://127.0.0.1:5190 http://localhost:5191 http://127.0.0.1:5191",
      'X-Frame-Options': 'SAMEORIGIN',
    },
    proxy: {
      '/api': SERVER,
      '/library': SERVER,
      '/ws': { target: SERVER.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    rollupOptions: { input: { studio: 'index.html', output: 'output.html', dj: 'dj.html', trail: 'trail.html', chathub: 'chathub.html', deck: 'deck.html', live: 'live.html', tools: 'tools.html', 'obs-setup': 'obs-setup.html', view: 'view.html', 'to3d-render': 'to3d-render.html', looklab: 'looklab.html', captions: 'captions.html' } },
  },
});
