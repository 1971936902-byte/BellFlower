import crypto from 'node:crypto';

export const DEFAULT_CIDR = '10.144.0.0/24';
export const DEFAULT_RELAY_REGION = 'cn-light-relay';
export const DEFAULT_LEASE_RECLAIM_MS = 24 * 60 * 60 * 1000;
export const MAX_DEVICE_NAME_LENGTH = 64;
export const MAX_PLATFORM_LENGTH = 32;
export const MAX_ENDPOINTS = 8;
export const MAX_CAPABILITIES = 16;

export function normalizeJoinRequest(raw) {
  const body = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
  const networkKey = String(body.networkKey || '').trim();
  const name = truncate(String(body.name || '').trim(), MAX_DEVICE_NAME_LENGTH);

  if (networkKey.length < 6) {
    throw new Error('networkKey must be at least 6 characters');
  }

  return {
    networkKey,
    deviceId: normalizeDeviceId(body.deviceId),
    name: name || defaultDeviceName(),
    platform: truncate(String(body.platform || 'unknown').trim() || 'unknown', MAX_PLATFORM_LENGTH),
    endpoints: normalizeStringList(body.endpoints, MAX_ENDPOINTS, 128),
    capabilities: normalizeStringList(body.capabilities, MAX_CAPABILITIES, 32)
  };
}

export function keyToNetworkId(networkKey) {
  return crypto.createHash('sha256').update(networkKey).digest('hex').slice(0, 16);
}

export function createDeviceId() {
  return crypto.randomUUID();
}

export function allocateVirtualIp(existingDevices, cidr = DEFAULT_CIDR, options = {}) {
  const now = options.now || Date.now();
  const leaseReclaimMs = options.leaseReclaimMs ?? DEFAULT_LEASE_RECLAIM_MS;
  const used = new Set(
    existingDevices
      .filter((device) => shouldReserveIp(device, now, leaseReclaimMs))
      .map((device) => device.virtualIp)
  );
  const [prefix] = cidr.split('/');
  const parts = prefix.split('.').map(Number);

  for (let host = 2; host < 255; host += 1) {
    const candidate = `${parts[0]}.${parts[1]}.${parts[2]}.${host}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`virtual network ${cidr} is full`);
}

export function inferConnectionMode(device, peer) {
  const bothHavePublicUdp =
    hasCapability(device, 'udp') &&
    hasCapability(peer, 'udp') &&
    (hasEndpoint(device, 'udp') || hasEndpoint(peer, 'udp'));

  return bothHavePublicUdp ? 'p2p' : 'relay';
}

export function buildPeerView(device, peers, now = Date.now()) {
  return peers
    .filter((peer) => peer.id !== device.id)
    .map((peer) => ({
      id: peer.id,
      name: peer.name,
      platform: peer.platform,
      virtualIp: peer.virtualIp,
      status: peer.status,
      latencyMs: estimateLatency(peer, now),
      connectionMode: inferConnectionMode(device, peer),
      relayRegion: inferConnectionMode(device, peer) === 'relay' ? DEFAULT_RELAY_REGION : null,
      lastSeenAt: peer.lastSeenAt
    }));
}

export function estimateLatency(device, now = Date.now()) {
  if (device.status !== 'online') {
    return null;
  }

  const heartbeatAge = Math.max(0, now - Date.parse(device.lastSeenAt));
  return Math.min(999, 12 + Math.round(heartbeatAge / 200));
}

export function isStale(device, now = Date.now(), timeoutMs = 30_000) {
  return now - Date.parse(device.lastSeenAt) > timeoutMs;
}

export function shouldReserveIp(device, now = Date.now(), leaseReclaimMs = DEFAULT_LEASE_RECLAIM_MS) {
  if (!device.virtualIp) {
    return false;
  }
  if (!device.status || device.status === 'online') {
    return true;
  }

  const lastSeen = Date.parse(device.lastSeenAt || device.joinedAt || 0);
  return Number.isFinite(lastSeen) && now - lastSeen <= leaseReclaimMs;
}

function defaultDeviceName() {
  return `BellFlower-${crypto.randomBytes(2).toString('hex')}`;
}

function hasCapability(device, capability) {
  return Array.isArray(device.capabilities) && device.capabilities.includes(capability);
}

function hasEndpoint(device, protocol) {
  return Array.isArray(device.endpoints) && device.endpoints.some((endpoint) => endpoint.startsWith(`${protocol}:`));
}

function normalizeDeviceId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_.:-]{3,128}$/.test(id) ? id : null;
}

function normalizeStringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => truncate(String(item || '').trim(), maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function truncate(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
