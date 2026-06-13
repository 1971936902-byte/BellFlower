import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateVirtualIp, buildPeerView, inferConnectionMode, keyToNetworkId, normalizeJoinRequest } from '../src/network.js';

test('normalizes a valid join request', () => {
  const request = normalizeJoinRequest({ networkKey: 'secret-123', name: ' iPhone ', platform: 'ios' });

  assert.equal(request.networkKey, 'secret-123');
  assert.equal(request.name, 'iPhone');
  assert.equal(request.platform, 'ios');
});

test('rejects weak network keys', () => {
  assert.throws(() => normalizeJoinRequest({ networkKey: '123' }), /at least 6/);
});

test('generates stable network ids without exposing the key', () => {
  const first = keyToNetworkId('same-key');
  const second = keyToNetworkId('same-key');

  assert.equal(first, second);
  assert.notEqual(first, 'same-key');
});

test('allocates the next free virtual ip in the demo cidr', () => {
  const ip = allocateVirtualIp([{ virtualIp: '10.144.0.2' }, { virtualIp: '10.144.0.3' }]);

  assert.equal(ip, '10.144.0.4');
});

test('prefers p2p when both peers advertise udp capability', () => {
  const a = { capabilities: ['udp'], endpoints: ['udp:1.1.1.1:51820'] };
  const b = { capabilities: ['udp'], endpoints: [] };

  assert.equal(inferConnectionMode(a, b), 'p2p');
});

test('falls back to relay when udp traversal metadata is missing', () => {
  const a = { capabilities: ['relay'], endpoints: [] };
  const b = { capabilities: ['udp'], endpoints: ['udp:1.1.1.1:51820'] };

  assert.equal(inferConnectionMode(a, b), 'relay');
});

test('builds a peer view with connection mode and latency', () => {
  const now = Date.now();
  const device = { id: 'a', capabilities: ['udp'], endpoints: ['udp:1.1.1.1:1'] };
  const peer = {
    id: 'b',
    name: 'Android',
    platform: 'android',
    virtualIp: '10.144.0.3',
    status: 'online',
    capabilities: ['udp'],
    endpoints: ['udp:2.2.2.2:2'],
    lastSeenAt: new Date(now).toISOString()
  };

  const peers = buildPeerView(device, [device, peer], now);

  assert.equal(peers.length, 1);
  assert.equal(peers[0].connectionMode, 'p2p');
  assert.equal(peers[0].latencyMs, 12);
});
