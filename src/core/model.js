'use strict';

const net = require('node:net');

const LOCAL_NODE_ID = 'local';
const ROUTE_PROTOCOLS = new Set(['tcp', 'socks5']);
const AUTH_MODES = new Set(['key', 'password', 'agent']);

function createDefaultConfig() {
  return {
    version: 1,
    settings: {
      closeToTray: true,
      startWithSystem: false,
      launchHidden: false,
    },
    localNode: {
      id: LOCAL_NODE_ID,
      name: 'My Computer',
      position: { x: 120, y: 220 },
    },
    servers: [],
    routes: [],
  };
}

function isPort(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function expandIpv6(host) {
  const expandEmbeddedIpv4 = (groups) => {
    const index = groups.findIndex((group) => group.includes('.'));
    if (index === -1) return groups;
    if (index !== groups.length - 1) return null;
    const octets = groups[index].split('.');
    if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
    return [
      ...groups.slice(0, index),
      ((Number(octets[0]) << 8) | Number(octets[1])).toString(16),
      ((Number(octets[2]) << 8) | Number(octets[3])).toString(16),
    ];
  };
  const parts = host.split('::');
  if (parts.length > 2) return null;
  const left = expandEmbeddedIpv4(parts[0] ? parts[0].split(':') : []);
  const right = expandEmbeddedIpv4(parts[1] ? parts[1].split(':') : []);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (parts.length === 1 && missing !== 0) return null;
  if (parts.length === 2 && missing < 1) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  return groups.map((part) => Number.parseInt(part, 16));
}

function isLoopbackBind(value) {
  let host = cleanText(value).toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.split('%')[0];
  if (host === 'localhost') return true;
  if (net.isIP(host) === 4) return Number(host.split('.')[0]) === 127;
  if (net.isIP(host) === 6) {
    const groups = expandIpv6(host);
    return Boolean(groups && groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1);
  }
  return false;
}

function isWildcardBind(value) {
  let host = cleanText(value).toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.split('%')[0];
  if (host === '*' || host === '0.0.0.0') return true;
  if (net.isIP(host) !== 6) return false;
  const groups = expandIpv6(host);
  return Boolean(groups && groups.every((group) => group === 0));
}

function canonicalHost(value) {
  let host = cleanText(value).toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.split('%')[0];
  if (net.isIP(host) === 4) return host.split('.').map((part) => String(Number(part))).join('.');
  if (net.isIP(host) === 6) {
    const groups = expandIpv6(host);
    return groups ? groups.map((group) => group.toString(16)).join(':') : host;
  }
  return host;
}

function bindsOverlap(first, second) {
  const left = canonicalHost(first);
  const right = canonicalHost(second);
  if (left === right) return true;
  if (isWildcardBind(left) || isWildcardBind(right)) return true;
  return (left === 'localhost' && isLoopbackBind(right)) || (right === 'localhost' && isLoopbackBind(left));
}

function routeRequiresExternalConsent(route) {
  return route?.source?.nodeId !== LOCAL_NODE_ID || !isLoopbackBind(route?.source?.bindHost);
}

function normalizeConfig(input) {
  const defaults = createDefaultConfig();
  const raw = input && typeof input === 'object' ? input : {};
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const localNode = raw.localNode && typeof raw.localNode === 'object' ? raw.localNode : {};

  return {
    version: 1,
    settings: {
      closeToTray: settings.closeToTray !== false,
      startWithSystem: Boolean(settings.startWithSystem),
      launchHidden: Boolean(settings.launchHidden),
    },
    localNode: {
      id: LOCAL_NODE_ID,
      name: cleanText(localNode.name) || defaults.localNode.name,
      position: normalizePosition(localNode.position, defaults.localNode.position),
    },
    servers: Array.isArray(raw.servers) ? raw.servers.map(normalizeServer) : [],
    routes: Array.isArray(raw.routes) ? raw.routes.map(normalizeRoute) : [],
  };
}

function normalizePosition(value, fallback = { x: 240, y: 180 }) {
  return {
    x: Number.isFinite(Number(value?.x)) ? Number(value.x) : fallback.x,
    y: Number.isFinite(Number(value?.y)) ? Number(value.y) : fallback.y,
  };
}

function normalizeServer(server) {
  return {
    id: cleanText(server?.id),
    name: cleanText(server?.name),
    host: cleanText(server?.host),
    port: Number(server?.port || 22),
    username: cleanText(server?.username),
    authMode: AUTH_MODES.has(server?.authMode) ? server.authMode : 'key',
    keyPath: cleanText(server?.keyPath),
    hostFingerprint: cleanText(server?.hostFingerprint),
    position: normalizePosition(server?.position),
  };
}

function normalizeRoute(route) {
  const protocol = ROUTE_PROTOCOLS.has(route?.protocol) ? route.protocol : 'tcp';
  return {
    id: cleanText(route?.id),
    name: cleanText(route?.name),
    protocol,
    source: {
      nodeId: cleanText(route?.source?.nodeId) || LOCAL_NODE_ID,
      bindHost: cleanText(route?.source?.bindHost) || '127.0.0.1',
      port: Number(route?.source?.port || 0),
    },
    target: {
      nodeId: cleanText(route?.target?.nodeId) || LOCAL_NODE_ID,
      host: cleanText(route?.target?.host) || '127.0.0.1',
      port: Number(route?.target?.port || 0),
    },
    reconnect: route?.reconnect !== false,
    allowExternal: Boolean(route?.allowExternal),
  };
}

function validateConfig(input) {
  const config = normalizeConfig(input);
  const errors = [];
  const nodeIds = new Set([LOCAL_NODE_ID]);
  const serverIds = new Set();

  for (const server of config.servers) {
    if (!server.id || server.id === LOCAL_NODE_ID || serverIds.has(server.id)) {
      errors.push(`A server ID is empty or duplicated: ${server.id || '(none)'}`);
    } else {
      serverIds.add(server.id);
      nodeIds.add(server.id);
    }
    if (!server.name) errors.push(`Server ${server.id || '(new server)'} requires a name.`);
    if (!server.host) errors.push(`Server ${server.name || server.id} requires an address.`);
    if (!isPort(server.port)) errors.push(`Server ${server.name || server.id} has an invalid SSH port.`);
    if (!server.username) errors.push(`Server ${server.name || server.id} requires a username.`);
    if (server.authMode === 'key' && !server.keyPath) {
      errors.push(`Server ${server.name || server.id} requires a private key path.`);
    }
  }

  const routeIds = new Set();
  const listeners = new Map();
  for (const route of config.routes) {
    if (!route.id || routeIds.has(route.id)) {
      errors.push(`A route ID is empty or duplicated: ${route.id || '(none)'}`);
    } else {
      routeIds.add(route.id);
    }
    if (!route.name) errors.push(`Route ${route.id || '(new route)'} requires a name.`);
    if (!nodeIds.has(route.source.nodeId)) errors.push(`${route.name}: source node not found.`);
    if (!nodeIds.has(route.target.nodeId)) errors.push(`${route.name}: target node not found.`);
    if (!route.source.bindHost) errors.push(`${route.name}: a bind address is required.`);
    if (!isPort(route.source.port)) errors.push(`${route.name}: the listen port is invalid.`);
    if (route.protocol === 'tcp') {
      if (!route.target.host) errors.push(`${route.name}: a target address is required.`);
      if (!isPort(route.target.port)) errors.push(`${route.name}: the target port is invalid.`);
    }

    if (routeRequiresExternalConsent(route) && !route.allowExternal) {
      errors.push(`${route.name}: explicit consent is required for a potentially exposed listener.`);
    }

    const listenerKey = `${route.source.nodeId}\u0000${route.source.port}`;
    const existingBinds = listeners.get(listenerKey) || [];
    const listenerConflict = route.source.nodeId === LOCAL_NODE_ID
      ? existingBinds.some((bindHost) => bindsOverlap(bindHost, route.source.bindHost))
      : existingBinds.length > 0;
    if (listenerConflict) {
      const endpoint = route.source.nodeId === LOCAL_NODE_ID
        ? `${route.source.bindHost}:${route.source.port}`
        : `remote port ${route.source.port}`;
      errors.push(`${route.name}: another route already uses ${endpoint} on the same node.`);
    }
    existingBinds.push(route.source.bindHost);
    listeners.set(listenerKey, existingBinds);

    if (
      route.protocol === 'tcp'
      && route.source.nodeId === route.target.nodeId
      && route.source.port === route.target.port
      && (
        route.source.nodeId !== LOCAL_NODE_ID
        || isWildcardBind(route.source.bindHost)
        || bindsOverlap(route.source.bindHost, route.target.host)
      )
    ) {
      errors.push(`${route.name}: identical source and destination endpoints would create an infinite loop.`);
    }
  }

  return { config, errors };
}

function nodeName(config, nodeId) {
  if (nodeId === LOCAL_NODE_ID) return config.localNode.name;
  return config.servers.find((server) => server.id === nodeId)?.name || nodeId;
}

function describeRoute(configInput, routeInput) {
  const config = normalizeConfig(configInput);
  const route = normalizeRoute(routeInput);
  const sourceName = nodeName(config, route.source.nodeId);
  const targetName = nodeName(config, route.target.nodeId);
  if (route.protocol === 'socks5') {
    return `${sourceName} ${route.source.bindHost}:${route.source.port} SOCKS5 -> network egress from ${targetName}`;
  }
  return `${sourceName} ${route.source.bindHost}:${route.source.port} -> ${targetName} ${route.target.host}:${route.target.port}`;
}

function routeSignature(route) {
  const normalized = normalizeRoute(route);
  return JSON.stringify({
    protocol: normalized.protocol,
    source: normalized.source,
    target: normalized.target,
    reconnect: normalized.reconnect,
  });
}

module.exports = {
  AUTH_MODES,
  bindsOverlap,
  canonicalHost,
  LOCAL_NODE_ID,
  ROUTE_PROTOCOLS,
  createDefaultConfig,
  describeRoute,
  isLoopbackBind,
  isPort,
  isWildcardBind,
  normalizeConfig,
  normalizeRoute,
  normalizeServer,
  routeRequiresExternalConsent,
  routeSignature,
  validateConfig,
};
