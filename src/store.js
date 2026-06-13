import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CIDR, allocateVirtualIp, createDeviceId, keyToNetworkId } from './network.js';

export class BellFlowerStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'bellflower.json')) {
    this.filePath = filePath;
    this.state = { networks: {} };
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    this.state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  join(joinRequest) {
    const networkId = keyToNetworkId(joinRequest.networkKey);
    const network = this.ensureNetwork(networkId);
    const nowIso = new Date().toISOString();
    const device = {
      id: createDeviceId(),
      name: joinRequest.name,
      platform: joinRequest.platform,
      virtualIp: allocateVirtualIp(network.devices, network.cidr),
      status: 'online',
      endpoints: joinRequest.endpoints,
      capabilities: joinRequest.capabilities,
      joinedAt: nowIso,
      lastSeenAt: nowIso
    };

    network.devices.push(device);
    this.save();
    return { networkId, network, device };
  }

  leave(networkId, deviceId) {
    const device = this.findDevice(networkId, deviceId);
    if (!device) {
      return null;
    }

    device.status = 'offline';
    device.lastSeenAt = new Date().toISOString();
    this.save();
    return device;
  }

  heartbeat(networkId, deviceId, patch = {}) {
    const device = this.findDevice(networkId, deviceId);
    if (!device) {
      return null;
    }

    device.status = 'online';
    device.lastSeenAt = new Date().toISOString();
    if (Array.isArray(patch.endpoints)) {
      device.endpoints = patch.endpoints.map(String);
    }
    if (Array.isArray(patch.capabilities)) {
      device.capabilities = patch.capabilities.map(String);
    }
    this.save();
    return device;
  }

  markStaleDevices(isStaleFn) {
    let changed = false;

    for (const network of Object.values(this.state.networks)) {
      for (const device of network.devices) {
        if (device.status === 'online' && isStaleFn(device)) {
          device.status = 'offline';
          changed = true;
        }
      }
    }

    if (changed) {
      this.save();
    }

    return changed;
  }

  getNetwork(networkId) {
    return this.state.networks[networkId] || null;
  }

  findDevice(networkId, deviceId) {
    return this.getNetwork(networkId)?.devices.find((device) => device.id === deviceId) || null;
  }

  ensureNetwork(networkId) {
    if (!this.state.networks[networkId]) {
      this.state.networks[networkId] = {
        id: networkId,
        cidr: DEFAULT_CIDR,
        devices: [],
        createdAt: new Date().toISOString()
      };
    }

    return this.state.networks[networkId];
  }
}
