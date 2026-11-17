// Shared property-inspector glue (Stream Deck SDK v2 PI protocol). The inspector NEVER talks to VTube Pro itself:
// everything goes through the plugin's Node backend (sendToPlugin), which is the only thing that connects to :5191.
window.PI = { ws: null, uuid: '', action: '', settings: {}, onPlugin: () => {}, onSettings: () => {} };
window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent, info, actionInfo) {
  const a = JSON.parse(actionInfo || '{}');
  PI.uuid = uuid; PI.action = a.action; PI.settings = (a.payload && a.payload.settings) || {};
  PI.ws = new WebSocket('ws://127.0.0.1:' + port); // Stream Deck's own socket (NOT VTube Pro)
  PI.ws.onopen = () => { PI.ws.send(JSON.stringify({ event: registerEvent, uuid })); PI.toPlugin({ t: 'getActions' }); PI.onSettings(PI.settings); };
  PI.ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.event === 'sendToPropertyInspector') PI.onPlugin(m.payload || {});
    else if (m.event === 'didReceiveSettings') { PI.settings = (m.payload && m.payload.settings) || {}; PI.onSettings(PI.settings); }
  };
};
PI.toPlugin = (payload) => PI.ws && PI.ws.send(JSON.stringify({ event: 'sendToPlugin', action: PI.action, context: PI.uuid, payload }));
PI.save = (settings) => { PI.settings = settings; if (PI.ws) PI.ws.send(JSON.stringify({ event: 'setSettings', context: PI.uuid, payload: settings })); };
PI.status = (el, m) => {
  el.textContent = m.online
    ? 'Connected to VTube Pro (port ' + m.port + (m.pages ? ', ' + m.pages + ' page' + (m.pages > 1 ? 's' : '') : '') + ')'
    : 'VTube Pro not found on port ' + m.port + '. Start VTube Pro: the keys light up by themselves.';
  el.className = m.online ? 'ok' : 'warn';
};
PI.portRow = (host, m) => {
  host.innerHTML = '<div class="sdpi-item"><div class="sdpi-item-label">Port</div><input class="sdpi-item-value" id="port" type="number" min="1" max="65535"></div>';
  const i = host.querySelector('#port'); i.value = m.port;
  i.onchange = () => { const p = Math.round(+i.value); if (p > 0 && p < 65536) PI.toPlugin({ t: 'setPort', port: p }); setTimeout(() => PI.toPlugin({ t: 'getActions' }), 1500); };
};
PI.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
