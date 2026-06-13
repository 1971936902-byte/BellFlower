import crypto from 'node:crypto';

export const DEFAULT_CIDR = '10.144.0.0/24';
export const DEFAULT_RELAY_REGION = 'cn-light-relay';
export const DEFAULT_LEASE_RECLAIM_MS = 24 * 60 * 60 * 1000;
export const MAX_DEVICE_NAME_LENGTH = 64;
export const MAX_PLATFORM_LENGTH = 32;
export const MAX_ENDPOINTS = 8;
export const MAX_SERVICE_ENDPOINTS = 8;
export const MAX_CAPABILITIES = 16;
export const MAX_PROBE_PORT = 65_535;

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
    serviceEndpoints: normalizeServiceEndpoints(body.serviceEndpoints),
    capabilities: normalizeStringList(body.capabilities, MAX_CAPABILITIES, 32)
  };
}

export function normalizeProbeRequest(raw) {
  const body = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
  const sourceDeviceId = normalizeDeviceId(body.sourceDeviceId);
  const targetDeviceId = normalizeDeviceId(body.targetDeviceId);
  const protocol = normalizeProbeProtocol(body.protocol);
  const port = Number(body.port || 0);

  if (!sourceDeviceId) {
    throw new Error('sourceDeviceId is required');
  }
  if (!targetDeviceId) {
    throw new Error('targetDeviceId is required');
  }
  if (sourceDeviceId === targetDeviceId) {
    throw new Error('sourceDeviceId and targetDeviceId must be different');
  }
  if (protocol !== 'icmp' && (!Number.isInteger(port) || port < 1 || port > MAX_PROBE_PORT)) {
    throw new Error(`port must be between 1 and ${MAX_PROBE_PORT}`);
  }

  return {
    sourceDeviceId,
    targetDeviceId,
    protocol,
    port: protocol === 'icmp' ? null : port
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

export function buildConnectivityProbe(source, target, options = {}) {
  const now = options.now || Date.now();
  const protocol = options.protocol || 'icmp';
  const port = options.port ?? null;
  const sourceOnline = source?.status === 'online';
  const targetOnline = target?.status === 'online';
  const connectionMode = source && target ? inferConnectionMode(source, target) : null;
  const reachable = Boolean(sourceOnline && targetOnline && connectionMode);
  const latencyMs = reachable ? estimateLatency(target, now) + (connectionMode === 'relay' ? 20 : 0) : null;

  return {
    reachable,
    protocol,
    port,
    source: source ? deviceProbeSummary(source) : null,
    target: target ? deviceProbeSummary(target) : null,
    connectionMode: reachable ? connectionMode : null,
    relayRegion: reachable && connectionMode === 'relay' ? DEFAULT_RELAY_REGION : null,
    latencyMs,
    checkedAt: new Date(now).toISOString(),
    evidence: 'control-plane',
    serviceEndpoint: findServiceEndpoint(target, protocol, port),
    reason: probeReason(source, target, reachable)
  };
}

export function findServiceEndpoint(device, protocol, port) {
  if (!device || !Array.isArray(device.serviceEndpoints)) {
    return null;
  }

  return device.serviceEndpoints.find((endpoint) => {
    if (endpoint.protocol !== protocol) {
      return false;
    }
    return protocol === 'icmp' || endpoint.port === port;
  }) || null;
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

function normalizeProbeProtocol(value) {
  const protocol = String(value || 'icmp').trim().toLowerCase();
  if (['icmp', 'tcp', 'http'].includes(protocol)) {
    return protocol;
  }
  throw new Error('protocol must be one of icmp, tcp, http');
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

function normalizeServiceEndpoints(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((endpoint) => normalizeServiceEndpoint(endpoint))
    .filter(Boolean)
    .slice(0, MAX_SERVICE_ENDPOINTS);
}

function normalizeServiceEndpoint(endpoint) {
  if (typeof endpoint === 'string') {
    return normalizeServiceEndpointString(endpoint);
  }

  if (!endpoint || typeof endpoint !== 'object') {
    return null;
  }

  const protocol = normalizeServiceProtocol(endpoint.protocol);
  const host = normalizeHost(endpoint.host);
  const port = Number(endpoint.port || 0);
  const path = truncate(String(endpoint.path || '/').trim() || '/', 128);

  if (!protocol || !host || !Number.isInteger(port) || port < 1 || port > MAX_PROBE_PORT) {
    return null;
  }

  return { protocol, host, port, path: path.startsWith('/') ? path : `/${path}`, secure: Boolean(endpoint.secure) };
}

function normalizeServiceEndpointString(value) {
  const text = truncate(String(value || '').trim(), 256);
  if (!text) {
    return null;
  }

  if (text.startsWith('http://') || text.startsWith('https://')) {
    try {
      const url = new URL(text);
      return {
        protocol: 'http',
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        path: url.pathname || '/',
        secure: url.protocol === 'https:'
      };
    } catch (error) {
      return null;
    }
  }

  const match = /^(tcp|http):([^:]+):([0-9]{1,5})(\/.*)?$/i.exec(text);
  if (!match) {
    return null;
  }

  const protocol = normalizeServiceProtocol(match[1]);
  const host = normalizeHost(match[2]);
  const port = Number(match[3]);
  const path = truncate(match[4] || '/', 128);

  if (!protocol || !host || port < 1 || port > MAX_PROBE_PORT) {
    return null;
  }

  return { protocol, host, port, path, secure: false };
}

function normalizeServiceProtocol(value) {
  const protocol = String(value || '').trim().toLowerCase();
  return ['tcp', 'http'].includes(protocol) ? protocol : null;
}

function normalizeHost(value) {
  const host = truncate(String(value || '').trim(), 128);
  return /^[a-zA-Z0-9_.:-]+$/.test(host) ? host : null;
}

function truncate(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function deviceProbeSummary(device) {
  return {
    id: device.id,
    name: device.name,
    virtualIp: device.virtualIp,
    status: device.status
  };
}

function probeReason(source, target, reachable) {
  if (!source) {
    return 'source_not_found';
  }
  if (!target) {
    return 'target_not_found';
  }
  if (source.status !== 'online') {
    return 'source_offline';
  }
  if (target.status !== 'online') {
    return 'target_offline';
  }
  return reachable ? 'ok' : 'unreachable';
}
