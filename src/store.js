import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CIDR, DEFAULT_LEASE_RECLAIM_MS, allocateVirtualIp, createDeviceId, keyToNetworkId } from './network.js';

export class BellFlowerStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'bellflower.json')) {
    this.filePath = filePath;
    this.leaseReclaimMs = Number(process.env.BELLFLOWER_LEASE_RECLAIM_MS || DEFAULT_LEASE_RECLAIM_MS);
    this.state = { networks: {} };
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    try {
      this.state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, corruptPath);
      this.state = { networks: {} };
      this.corruptBackupPath = corruptPath;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  join(joinRequest) {
    const networkId = keyToNetworkId(joinRequest.networkKey);
    const network = this.ensureNetwork(networkId);
    const nowIso = new Date().toISOString();
    const existingDevice = this.findReusableDevice(network, joinRequest);

    if (existingDevice) {
      existingDevice.name = joinRequest.name;
      existingDevice.platform = joinRequest.platform;
      existingDevice.status = 'online';
      existingDevice.endpoints = joinRequest.endpoints;
      existingDevice.serviceEndpoints = joinRequest.serviceEndpoints;
      existingDevice.capabilities = joinRequest.capabilities;
      existingDevice.lastSeenAt = nowIso;
      this.save();
      return { networkId, network, device: existingDevice };
    }

    const device = {
      id: joinRequest.deviceId || createDeviceId(),
      name: joinRequest.name,
      platform: joinRequest.platform,
      virtualIp: allocateVirtualIp(network.devices, network.cidr, { leaseReclaimMs: this.leaseReclaimMs }),
      status: 'online',
      endpoints: joinRequest.endpoints,
      serviceEndpoints: joinRequest.serviceEndpoints,
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
    if (Array.isArray(patch.serviceEndpoints)) {
      device.serviceEndpoints = patch.serviceEndpoints;
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

  findReusableDevice(network, joinRequest) {
    if (joinRequest.deviceId) {
      return network.devices.find((device) => device.id === joinRequest.deviceId) || null;
    }

    return null;
  }
}
