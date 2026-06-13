import http from 'node:http';
import os from 'node:os';

const server = process.env.BELLFLOWER_SERVER || 'http://localhost:8787';
const networkKey = process.env.BELLFLOWER_KEY || 'demo-secret';
const name = process.env.BELLFLOWER_NAME || os.hostname();
const platform = process.platform;

const joined = await post('/api/join', {
  networkKey,
  name,
  platform,
  capabilities: ['udp', 'relay'],
  endpoints: ['udp:0.0.0.0:51820']
});

console.log(`Joined BellFlower network ${joined.networkId}`);
console.log(`Device ${joined.device.name} => ${joined.device.virtualIp}`);
printPeers(joined.peers);

setInterval(async () => {
  const ack = await post('/api/heartbeat', {
    networkId: joined.networkId,
    deviceId: joined.device.id,
    capabilities: ['udp', 'relay'],
    endpoints: ['udp:0.0.0.0:51820']
  });
  const network = await get(`/api/networks/${joined.networkId}`);
  console.log(`[${new Date().toLocaleTimeString()}] heartbeat ${ack.ok ? 'ok' : 'failed'} / ${network.devices.length} device(s)`);
}, 5000);

function post(path, body) {
  return request('POST', path, body);
}

function get(path) {
  return request('GET', path);
}

function request(method, path, body) {
  const url = new URL(path, server);
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;

  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(text || '{}');
        if (res.statusCode >= 400) {
          reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        } else {
          resolve(parsed);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function printPeers(peers) {
  if (!peers.length) {
    console.log('No peers yet. Start another client with the same BELLFLOWER_KEY to test discovery.');
    return;
  }

  for (const peer of peers) {
    console.log(`Peer ${peer.name} ${peer.virtualIp} ${peer.status} via ${peer.connectionMode}`);
  }
}
