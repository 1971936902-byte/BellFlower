import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateVirtualIp, buildPeerView, inferConnectionMode, keyToNetworkId, normalizeJoinRequest, shouldReserveIp } from '../src/network.js';

test('normalizes a valid join request', () => {
  const request = normalizeJoinRequest({ networkKey: 'secret-123', name: ' iPhone ', platform: 'ios' });

  assert.equal(request.networkKey, 'secret-123');
  assert.equal(request.name, 'iPhone');
  assert.equal(request.platform, 'ios');
});

test('normalizes optional stable device ids and caps list sizes', () => {
  const request = normalizeJoinRequest({
    networkKey: 'secret-123',
    deviceId: 'ios-device-01',
    endpoints: Array.from({ length: 12 }, (_, index) => `udp:10.0.0.${index}:51820`),
    capabilities: Array.from({ length: 20 }, (_, index) => `cap-${index}`)
  });

  assert.equal(request.deviceId, 'ios-device-01');
  assert.equal(request.endpoints.length, 8);
  assert.equal(request.capabilities.length, 16);
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

test('reclaims virtual ips from expired offline leases', () => {
  const now = Date.parse('2026-06-14T00:00:00.000Z');
  const ip = allocateVirtualIp(
    [
      { virtualIp: '10.144.0.2', status: 'offline', lastSeenAt: '2026-06-12T00:00:00.000Z' },
      { virtualIp: '10.144.0.3', status: 'online', lastSeenAt: '2026-06-14T00:00:00.000Z' }
    ],
    undefined,
    { now, leaseReclaimMs: 60_000 }
  );

  assert.equal(ip, '10.144.0.2');
});

test('reserves online and recent offline leases', () => {
  const now = Date.parse('2026-06-14T00:00:00.000Z');

  assert.equal(shouldReserveIp({ virtualIp: '10.144.0.2', status: 'online', lastSeenAt: '2026-06-01T00:00:00.000Z' }, now, 1), true);
  assert.equal(shouldReserveIp({ virtualIp: '10.144.0.2', status: 'offline', lastSeenAt: '2026-06-13T23:59:30.000Z' }, now, 60_000), true);
  assert.equal(shouldReserveIp({ virtualIp: '10.144.0.2', status: 'offline', lastSeenAt: '2026-06-13T00:00:00.000Z' }, now, 60_000), false);
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
