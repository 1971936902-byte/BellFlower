import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';
import { BellFlowerStore } from './store.js';
import { buildConnectivityProbe, buildPeerView, findServiceEndpoint, isStale, normalizeJoinRequest, normalizeProbeRequest } from './network.js';
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

  if (req.method === 'POST' && url.pathname === '/api/leave') {
    const body = await readJson(req);
    const networkId = String(body.networkId || '');
    const device = store.leave(networkId, String(body.deviceId || ''));
    if (!device) {
      sendJson(res, 404, { error: 'device not found' });
      return;
    }
    sendJson(res, 200, { ok: true, device });
    broadcastNetwork(networkId);
    return;
  }

  if (url.pathname.startsWith('/api/networks/')) {
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

    if (req.method === 'POST' && parts[3] === 'probe') {
      const probeRequest = normalizeProbeRequest(await readJson(req));
      const source = store.findDevice(networkId, probeRequest.sourceDeviceId);
      const target = store.findDevice(networkId, probeRequest.targetDeviceId);
      const result = await buildProbeResult(source, target, probeRequest);
      sendJson(res, result.reachable ? 200 : 409, { networkId, ...result });
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
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
      serviceEndpoints: device.serviceEndpoints || [],
      lastSeenAt: device.lastSeenAt
    }))
  };
}

async function buildProbeResult(source, target, probeRequest) {
  const result = buildConnectivityProbe(source, target, probeRequest);
  const endpoint = findServiceEndpoint(target, probeRequest.protocol, probeRequest.port);
  if (!result.reachable || !endpoint || probeRequest.protocol === 'icmp') {
    return result;
  }

  return probeServiceEndpoint(endpoint, result);
}

async function probeServiceEndpoint(endpoint, result) {
  const startedAt = Date.now();
  try {
    if (endpoint.protocol === 'tcp') {
      await probeTcpEndpoint(endpoint);
      return {
        ...result,
        evidence: 'service-endpoint',
        serviceEndpoint: endpoint,
        latencyMs: Date.now() - startedAt,
        reason: 'ok'
      };
    }

    const httpStatus = await probeHttpEndpoint(endpoint);
    return {
      ...result,
      evidence: 'service-endpoint',
      serviceEndpoint: endpoint,
      latencyMs: Date.now() - startedAt,
      httpStatus,
      reason: 'ok'
    };
  } catch (error) {
    return {
      ...result,
      reachable: false,
      evidence: 'service-endpoint',
      serviceEndpoint: endpoint,
      latencyMs: null,
      reason: 'service_probe_failed',
      error: error.message
    };
  }
}

function probeTcpEndpoint(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('tcp probe timeout'));
    }, 2000);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function probeHttpEndpoint(endpoint) {
  const client = endpoint.secure ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request({
      method: 'GET',
      host: endpoint.host,
      port: endpoint.port,
      path: endpoint.path || '/',
      timeout: 2000
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => {
      req.destroy(new Error('http probe timeout'));
    });
    req.on('error', reject);
    req.end();
  });
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
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --surface: #ffffff;
      --surface-soft: #f9fafb;
      --line: #d8dee8;
      --line-soft: #e7ebf0;
      --text: #172033;
      --muted: #64748b;
      --primary: #1769aa;
      --primary-strong: #0f4f86;
      --ok: #0f8b5f;
      --warn: #ad6a00;
      --bad: #b42318;
      --relay: #6d5bd0;
      --shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 24px 0 32px; }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: end;
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0; font-size: 26px; line-height: 1.1; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 15px; letter-spacing: 0; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 700; }
    input, select, button {
      min-height: 40px;
      border-radius: 7px;
      border: 1px solid var(--line);
      padding: 0 11px;
      font-size: 14px;
      background: var(--surface);
      color: var(--text);
    }
    input:focus, select:focus { outline: 2px solid rgba(23, 105, 170, 0.18); border-color: var(--primary); }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border-color: var(--primary);
      background: var(--primary);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { background: var(--primary-strong); border-color: var(--primary-strong); }
    button.secondary { background: var(--surface); color: var(--primary); border-color: #b9cee1; }
    button.secondary:hover { background: #edf5fb; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .subtle { margin-top: 6px; color: var(--muted); font-size: 13px; }
    .shell { display: grid; grid-template-columns: 360px 1fr; gap: 16px; align-items: start; }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .panel-body { padding: 16px; }
    .stack { display: grid; gap: 16px; }
    .form-grid { display: grid; gap: 12px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .toolbar { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 10px;
      background: var(--surface);
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
    .dot.online { background: var(--ok); }
    .dot.offline { background: var(--bad); }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--line-soft); }
    .metric { padding: 12px 14px; border-right: 1px solid var(--line-soft); }
    .metric:last-child { border-right: 0; }
    .metric span { display: block; color: var(--muted); font-size: 12px; font-weight: 700; }
    .metric strong { display: block; margin-top: 4px; font-size: 18px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 680px; }
    th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line-soft); font-size: 14px; }
    th { color: var(--muted); font-size: 12px; background: var(--surface-soft); }
    tr[aria-selected="true"] { background: #eef7fb; }
    tr.device-row { cursor: pointer; }
    tr.device-row:hover { background: #f6fbfe; }
    code { background: #eef2f7; padding: 3px 6px; border-radius: 5px; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 999px;
      padding: 0 9px;
      font-size: 12px;
      font-weight: 800;
    }
    .badge.online { background: #e8f7ef; color: var(--ok); }
    .badge.offline { background: #feeceb; color: var(--bad); }
    .badge.p2p { background: #e8f2fb; color: var(--primary); }
    .badge.relay { background: #f2effb; color: var(--relay); }
    .result {
      min-height: 94px;
      display: grid;
      gap: 8px;
      align-content: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-soft);
      padding: 14px;
    }
    .result strong { font-size: 17px; }
    .result.ok { border-color: #a7dfc5; background: #f1fbf6; }
    .result.fail { border-color: #f2b8b5; background: #fff4f3; }
    .empty { padding: 24px 14px; color: var(--muted); text-align: center; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    @media (max-width: 900px) {
      main { width: min(100vw - 20px, 720px); padding-top: 16px; }
      header, .shell, .two { grid-template-columns: 1fr; }
      header { align-items: start; }
      .metrics { grid-template-columns: 1fr; }
      .metric { border-right: 0; border-bottom: 1px solid var(--line-soft); }
      .metric:last-child { border-bottom: 0; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>风铃草 BellFlower</h1>
        <div class="subtle">跨端虚拟组网 Demo 控制台</div>
      </div>
      <div class="status-pill"><span id="healthDot" class="dot"></span><span id="health">checking</span></div>
    </header>
    <div class="shell">
      <aside class="stack">
        <section class="panel">
          <div class="panel-body">
            <div class="toolbar">
              <h2>设备入网</h2>
              <span id="joinState" class="status-pill"><span class="dot"></span><span>未连接</span></span>
            </div>
            <form id="join" class="form-grid">
              <label>组网密钥
                <input name="networkKey" value="demo-secret" minlength="6" required>
              </label>
              <label>设备 ID
                <input name="deviceId" value="windows-pc-01" pattern="[a-zA-Z0-9_.:-]{3,128}" required>
              </label>
              <div class="two">
                <label>设备备注
                  <input name="name" value="Windows-PC">
                </label>
                <label>平台
                  <select name="platform">
                    <option value="windows">Windows</option>
                    <option value="ios">iOS</option>
                    <option value="android">Android</option>
                    <option value="darwin">macOS</option>
                    <option value="linux">Linux</option>
                  </select>
                </label>
              </div>
              <label>本机服务端点
                <input name="serviceEndpoint" placeholder="http://127.0.0.1:3000">
              </label>
              <button type="submit"><span aria-hidden="true">+</span><span>加入网络</span></button>
            </form>
          </div>
          <div class="metrics">
            <div class="metric"><span>网络</span><strong id="metricNetwork">--</strong></div>
            <div class="metric"><span>本机 IP</span><strong id="metricIp">--</strong></div>
            <div class="metric"><span>在线设备</span><strong id="metricOnline">0</strong></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-body stack">
            <div class="toolbar">
              <h2>联通性探测</h2>
              <button id="refresh" class="secondary" type="button">刷新</button>
            </div>
            <label>目标设备
              <select id="targetDevice" disabled></select>
            </label>
            <div class="two">
              <label>协议
                <select id="probeProtocol">
                  <option value="icmp">Ping</option>
                  <option value="tcp">TCP</option>
                  <option value="http">HTTP</option>
                </select>
              </label>
              <label>端口
                <input id="probePort" type="number" min="1" max="65535" value="3000">
              </label>
            </div>
            <button id="probe" type="button" disabled><span aria-hidden="true">↔</span><span>开始探测</span></button>
            <div id="probeResult" class="result">
              <strong>等待设备入网</strong>
              <span class="subtle">加入网络后可选择目标设备。</span>
            </div>
          </div>
        </section>
      </aside>

      <section class="panel">
        <div class="panel-body">
          <div class="toolbar">
            <div>
              <h2>虚拟局域网</h2>
              <div id="summary" class="subtle">尚未入网</div>
            </div>
            <span id="deviceCount" class="status-pill"><span class="dot online"></span><span>0 台设备</span></span>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>设备</th><th>平台</th><th>虚拟 IP</th><th>状态</th><th>链路</th><th>最后心跳</th></tr></thead>
            <tbody id="devices"><tr><td class="empty" colspan="6">尚无设备</td></tr></tbody>
          </table>
        </div>
      </section>
    </div>
  </main>
  <script>
    const health = document.querySelector('#health');
    const healthDot = document.querySelector('#healthDot');
    const summary = document.querySelector('#summary');
    const devices = document.querySelector('#devices');
    const joinState = document.querySelector('#joinState');
    const metricNetwork = document.querySelector('#metricNetwork');
    const metricIp = document.querySelector('#metricIp');
    const metricOnline = document.querySelector('#metricOnline');
    const deviceCount = document.querySelector('#deviceCount');
    const targetDevice = document.querySelector('#targetDevice');
    const probeProtocol = document.querySelector('#probeProtocol');
    const probePort = document.querySelector('#probePort');
    const probeButton = document.querySelector('#probe');
    const refreshButton = document.querySelector('#refresh');
    const probeResult = document.querySelector('#probeResult');
    const state = { networkId: null, device: null, devices: [], peers: [], timer: null };

    fetch('/health')
      .then(r => r.json())
      .then(() => setHealth(true))
      .catch(() => setHealth(false));

    document.querySelector('#join').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const payload = Object.fromEntries(form.entries());
      payload.capabilities = ['udp', 'relay'];
      payload.endpoints = ['udp:0.0.0.0:51820'];
      payload.serviceEndpoints = payload.serviceEndpoint ? [payload.serviceEndpoint] : [];
      delete payload.serviceEndpoint;
      setJoinState('连接中', false);
      try {
        const joined = await request('/api/join', { method: 'POST', body: payload });
        state.networkId = joined.networkId;
        state.device = joined.device;
        state.devices = joined.network.devices;
        state.peers = joined.peers;
        renderAll();
        setJoinState('已入网', true);
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(refresh, 2000);
      } catch (error) {
        setJoinState('入网失败', false);
        probeResult.className = 'result fail';
        setProbeResult('入网失败', error.message);
      }
    });

    refreshButton.addEventListener('click', refresh);
    probeProtocol.addEventListener('change', () => {
      probePort.disabled = probeProtocol.value === 'icmp';
    });
    probeButton.addEventListener('click', runProbe);

    async function refresh() {
      if (!state.networkId) return;
      try {
        const network = await request('/api/networks/' + state.networkId);
        state.devices = network.devices;
        if (state.device) {
          const peers = await request('/api/networks/' + state.networkId + '/peers/' + state.device.id);
          state.peers = peers.peers;
        }
        setHealth(true);
        renderAll();
      } catch (error) {
        setHealth(false);
        setJoinState('连接中断', false);
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
        probeResult.className = 'result fail';
        setProbeResult('服务不可用', error.message);
      }
    }

    async function runProbe() {
      if (!state.networkId || !state.device || !targetDevice.value) return;
      probeResult.className = 'result';
      setProbeResult('探测中', '正在检查虚拟链路。');
      try {
        const payload = {
          sourceDeviceId: state.device.id,
          targetDeviceId: targetDevice.value,
          protocol: probeProtocol.value,
          port: Number(probePort.value)
        };
        const result = await request('/api/networks/' + state.networkId + '/probe', { method: 'POST', body: payload });
        probeResult.className = 'result ok';
        setProbeResult('链路可达', result.connectionMode.toUpperCase() + ' / ' + result.latencyMs + ' ms / ' + result.evidence);
      } catch (error) {
        probeResult.className = 'result fail';
        setProbeResult('链路不可达', error.message);
      }
    }

    async function request(path, options = {}) {
      const init = { method: options.method || 'GET', headers: {} };
      if (options.body) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(path, init);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.reason || data.error || 'request failed');
      }
      return data;
    }

    function renderAll() {
      const online = state.devices.filter(device => device.status === 'online').length;
      summary.textContent = state.networkId ? '网络 ' + state.networkId + ' / 本机虚拟 IP ' + state.device.virtualIp : '尚未入网';
      metricNetwork.textContent = state.networkId ? state.networkId.slice(0, 8) : '--';
      metricIp.textContent = state.device ? state.device.virtualIp : '--';
      metricOnline.textContent = String(online);
      deviceCount.querySelector('span:last-child').textContent = state.devices.length + ' 台设备';
      renderDevices();
      renderTargets();
    }

    function renderDevices() {
      devices.textContent = '';
      if (!state.devices.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.className = 'empty';
        cell.colSpan = 6;
        cell.textContent = '尚无设备';
        row.appendChild(cell);
        devices.appendChild(row);
        return;
      }
      for (const device of state.devices) {
        const row = document.createElement('tr');
        row.className = 'device-row';
        row.setAttribute('aria-selected', state.device && device.id === state.device.id ? 'true' : 'false');
        appendCell(row, device.name);
        appendCell(row, device.platform);
        const ip = document.createElement('td');
        const code = document.createElement('code');
        code.textContent = device.virtualIp;
        ip.appendChild(code);
        row.appendChild(ip);
        const status = document.createElement('td');
        status.appendChild(badge(device.status, device.status));
        row.appendChild(status);
        const peer = state.peers.find(item => item.id === device.id);
        const link = document.createElement('td');
        link.appendChild(peer ? badge(peer.connectionMode.toUpperCase(), peer.connectionMode) : badge(device.id === state.device?.id ? '本机' : '--', ''));
        row.appendChild(link);
        appendCell(row, device.lastSeenAt);
        devices.appendChild(row);
      }
    }

    function renderTargets() {
      targetDevice.textContent = '';
      const peers = state.devices.filter(device => state.device && device.id !== state.device.id);
      for (const device of peers) {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = device.name + ' / ' + device.virtualIp;
        targetDevice.appendChild(option);
      }
      const enabled = Boolean(state.networkId && peers.length);
      targetDevice.disabled = !enabled;
      probeButton.disabled = !enabled;
      if (!enabled && state.networkId) {
        setProbeResult('等待目标设备', '同一网络加入第二台设备后可探测。');
      }
    }

    function appendCell(row, text) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.appendChild(cell);
      return cell;
    }

    function badge(text, kind) {
      const span = document.createElement('span');
      span.className = kind ? 'badge ' + kind : 'badge';
      span.textContent = text;
      return span;
    }

    function setHealth(ok) {
      health.textContent = ok ? 'online' : 'offline';
      healthDot.className = ok ? 'dot online' : 'dot offline';
    }

    function setJoinState(text, online) {
      joinState.querySelector('.dot').className = online ? 'dot online' : 'dot';
      joinState.querySelector('span:last-child').textContent = text;
    }

    function setProbeResult(title, detail) {
      probeResult.textContent = '';
      const strong = document.createElement('strong');
      strong.textContent = title;
      const span = document.createElement('span');
      span.className = 'subtle';
      span.textContent = detail;
      probeResult.appendChild(strong);
      probeResult.appendChild(span);
    }
  </script>
</body>
</html>`;
}
