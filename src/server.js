import http from 'node:http';
import { URL } from 'node:url';
import { BellFlowerStore } from './store.js';
import { buildPeerView, isStale, normalizeJoinRequest } from './network.js';
import { acceptWebSocket, decodeFrames, encodeFrame } from './websocket.js';

const PORT = Number(process.env.PORT || 8787);
const MAX_JSON_BODY_BYTES = Number(process.env.BELLFLOWER_MAX_BODY_BYTES || 1024 * 1024);
const store = new BellFlowerStore(process.env.BELLFLOWER_DATA);
const clients = new Map();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
  }
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  if (!acceptWebSocket(req, socket)) {
    return;
  }

  let state = null;
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const decoded = decodeFrames(buffer);
    buffer = decoded.remaining;

    for (const frame of decoded.frames) {
      if (frame.opcode === 8) {
        socket.end();
        return;
      }
      state = handleSocketMessage(socket, state, frame.payload);
    }
  });

  socket.on('error', () => cleanupSocketState(state));
  socket.on('close', () => cleanupSocketState(state));
});

function cleanupSocketState(state) {
    if (state) {
      store.leave(state.networkId, state.device.id);
      clients.delete(state.device.id);
      broadcastNetwork(state.networkId);
    }
}

server.listen(PORT, () => {
  console.log(`BellFlower control server listening on http://localhost:${PORT}`);
});

setInterval(() => {
  if (store.markStaleDevices((device) => isStale(device))) {
    for (const networkId of Object.keys(store.state.networks)) {
      broadcastNetwork(networkId);
    }
  }
}, 5000).unref();

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, dashboardHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'BellFlower', timestamp: new Date().toISOString() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/join') {
    const joinRequest = normalizeJoinRequest(await readJson(req));
    const joined = store.join(joinRequest);
    sendJson(res, 201, publicJoinResponse(joined));
    broadcastNetwork(joined.networkId);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
    const body = await readJson(req);
    const device = store.heartbeat(String(body.networkId || ''), String(body.deviceId || ''), body);
    if (!device) {
      sendJson(res, 404, { error: 'device not found' });
      return;
    }
    sendJson(res, 200, { ok: true, device });
    broadcastNetwork(String(body.networkId || ''));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/networks/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const networkId = parts[2];
    const network = store.getNetwork(networkId);
    if (!network) {
      sendJson(res, 404, { error: 'network not found' });
      return;
    }

    if (parts[3] === 'peers' && parts[4]) {
      const device = store.findDevice(networkId, parts[4]);
      if (!device) {
        sendJson(res, 404, { error: 'device not found' });
        return;
      }
      sendJson(res, 200, { networkId, deviceId: device.id, peers: buildPeerView(device, network.devices) });
      return;
    }

    sendJson(res, 200, publicNetwork(network));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

function handleSocketMessage(socket, state, payload) {
  let message;
  try {
    message = JSON.parse(payload || '{}');
  } catch (error) {
    safeSocketWrite(socket, { type: 'error', error: 'invalid JSON message' });
    return state;
  }

  if (message.type === 'join') {
    let joined;
    try {
      joined = store.join(normalizeJoinRequest(message));
    } catch (error) {
      safeSocketWrite(socket, { type: 'error', error: error.message });
      return state;
    }
    clients.set(joined.device.id, { socket, networkId: joined.networkId, deviceId: joined.device.id });
    safeSocketWrite(socket, { type: 'joined', ...publicJoinResponse(joined) });
    broadcastNetwork(joined.networkId);
    return { networkId: joined.networkId, device: joined.device };
  }

  if (!state) {
    safeSocketWrite(socket, { type: 'error', error: 'join first' });
    return state;
  }

  if (message.type === 'heartbeat') {
    const device = store.heartbeat(state.networkId, state.device.id, message);
    const network = store.getNetwork(state.networkId);
    safeSocketWrite(socket, { type: 'heartbeat_ack', device });
    broadcastNetwork(state.networkId);
    return { networkId: state.networkId, device, network };
  }

  if (message.type === 'ping') {
    safeSocketWrite(socket, { type: 'pong', sentAt: message.sentAt, receivedAt: new Date().toISOString() });
  }

  return state;
}

function broadcastNetwork(networkId) {
  const network = store.getNetwork(networkId);
  if (!network) {
    return;
  }

  for (const client of clients.values()) {
    if (client.networkId !== networkId) {
      continue;
    }

    const device = network.devices.find((candidate) => candidate.id === client.deviceId);
    if (!device) {
      continue;
    }

    if (!safeSocketWrite(client.socket, { type: 'peers', network: publicNetwork(network), peers: buildPeerView(device, network.devices) })) {
      clients.delete(client.deviceId);
    }
  }
}

function publicJoinResponse({ networkId, network, device }) {
  return {
    networkId,
    device,
    network: publicNetwork(network),
    peers: buildPeerView(device, network.devices)
  };
}

function publicNetwork(network) {
  return {
    id: network.id,
    cidr: network.cidr,
    devices: network.devices.map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      virtualIp: device.virtualIp,
      status: device.status,
      lastSeenAt: device.lastSeenAt
    }))
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) {
        return;
      }
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        rejected = true;
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) {
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(new Error('invalid JSON body'));
      }
    });
  });
}

function safeSocketWrite(socket, payload) {
  try {
    if (socket.destroyed || socket.writableEnded) {
      return false;
    }
    socket.write(encodeFrame(payload));
    return true;
  } catch (error) {
    return false;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BellFlower 控制台</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #1f2937; }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 28px; }
    .panel { background: #fff; border: 1px solid #dde2ea; border-radius: 8px; padding: 18px; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    input, button { min-height: 40px; border-radius: 6px; border: 1px solid #cbd5e1; padding: 0 12px; font-size: 14px; }
    button { background: #1967d2; color: white; border-color: #1967d2; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
    .online { color: #047857; font-weight: 700; }
    .offline { color: #9ca3af; }
    code { background: #eef2f7; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>风铃草 BellFlower</h1>
        <div>轻量控制服务：设备入网、虚拟 IP、在线状态与链路模式同步</div>
      </div>
      <code id="health">checking...</code>
    </header>
    <section class="panel">
      <form id="join" class="grid">
        <input name="networkKey" value="demo-secret" placeholder="组网密钥" minlength="6" required>
        <input name="name" value="Windows-PC" placeholder="设备备注">
        <input name="platform" value="windows" placeholder="平台">
        <button type="submit">加入网络</button>
      </form>
    </section>
    <section class="panel">
      <div id="summary">尚未入网</div>
      <table>
        <thead><tr><th>设备</th><th>虚拟 IP</th><th>状态</th><th>最后心跳</th></tr></thead>
        <tbody id="devices"></tbody>
      </table>
    </section>
  </main>
  <script>
    const health = document.querySelector('#health');
    const summary = document.querySelector('#summary');
    const devices = document.querySelector('#devices');
    fetch('/health').then(r => r.json()).then(() => health.textContent = 'online');
    document.querySelector('#join').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const payload = Object.fromEntries(form.entries());
      payload.capabilities = ['udp', 'relay'];
      payload.endpoints = ['udp:0.0.0.0:51820'];
      const joined = await fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json());
      summary.textContent = '网络 ' + joined.networkId + ' / 本机虚拟 IP ' + joined.device.virtualIp;
      render(joined.network.devices);
      setInterval(() => refresh(joined.networkId), 2000);
    });
    async function refresh(networkId) {
      const network = await fetch('/api/networks/' + networkId).then(r => r.json());
      render(network.devices);
    }
    function render(items) {
      devices.textContent = '';
      for (const device of items) {
        const row = document.createElement('tr');
        appendCell(row, device.name);
        const ip = document.createElement('td');
        const code = document.createElement('code');
        code.textContent = device.virtualIp;
        ip.appendChild(code);
        row.appendChild(ip);
        const status = appendCell(row, device.status);
        status.className = device.status;
        appendCell(row, device.lastSeenAt);
        devices.appendChild(row);
      }
    }
    function appendCell(row, text) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.appendChild(cell);
      return cell;
    }
  </script>
</body>
</html>`;
}
