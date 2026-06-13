import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BellFlowerStore } from '../src/store.js';
import { normalizeJoinRequest } from '../src/network.js';

test('reuses a stable device id and keeps its virtual ip', () => {
  const store = new BellFlowerStore(tempDataPath());
  const first = store.join(normalizeJoinRequest({ networkKey: 'secret-123', deviceId: 'win-01', name: 'PC', platform: 'windows' }));
  const second = store.join(normalizeJoinRequest({ networkKey: 'secret-123', deviceId: 'win-01', name: 'PC Renamed', platform: 'windows' }));

  assert.equal(second.device.id, first.device.id);
  assert.equal(second.device.virtualIp, first.device.virtualIp);
  assert.equal(second.network.devices.length, 1);
  assert.equal(second.device.name, 'PC Renamed');
});

test('isolates devices with the same stable id across different network keys', () => {
  const store = new BellFlowerStore(tempDataPath());
  const first = store.join(normalizeJoinRequest({ networkKey: 'secret-123', deviceId: 'same-device' }));
  const second = store.join(normalizeJoinRequest({ networkKey: 'secret-456', deviceId: 'same-device' }));

  assert.notEqual(first.networkId, second.networkId);
  assert.equal(first.device.virtualIp, '10.144.0.2');
  assert.equal(second.device.virtualIp, '10.144.0.2');
});

test('backs up corrupt state files and starts with an empty store', () => {
  const filePath = tempDataPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{bad json');

  const store = new BellFlowerStore(filePath);

  assert.deepEqual(store.state, { networks: {} });
  assert.ok(store.corruptBackupPath);
  assert.equal(fs.existsSync(store.corruptBackupPath), true);
});

function tempDataPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bellflower-')), 'state.json');
}
