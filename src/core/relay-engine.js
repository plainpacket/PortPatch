'use strict';

const net = require('node:net');
const { LOCAL_NODE_ID, routeSignature } = require('./model');
const { handleSocks5 } = require('./socks5');

function initialStatus(routeId) {
  return {
    routeId,
    state: 'idle',
    desired: false,
    activeConnections: 0,
    bytesUp: 0,
    bytesDown: 0,
    boundPort: null,
    retryInMs: null,
    lastError: null,
    startedAt: null,
  };
}

function listenLocal(bindHost, port, onConnection, onLost) {
  return new Promise((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: false }, (socket) => {
      socket.setKeepAlive(true, 10_000);
      onConnection(socket, {
        sourceAddress: socket.remoteAddress,
        sourcePort: socket.remotePort,
        destinationAddress: socket.localAddress,
        destinationPort: socket.localPort,
      });
    });
    let listening = false;
    server.once('error', reject);
    server.listen({ host: bindHost, port: Number(port), exclusive: true }, () => {
      listening = true;
      server.removeListener('error', reject);
      server.on('error', (error) => onLost(error));
      const address = server.address();
      resolve({
        port: typeof address === 'object' ? address.port : Number(port),
        close: () => new Promise((done) => {
          if (!listening) return done();
          listening = false;
          server.close(() => done());
        }),
      });
    });
  });
}

function dialLocal(host, port, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const timer = setTimeout(() => {
      const error = Object.assign(new Error(`Connection to ${host}:${port} timed out.`), { code: 'ETIMEDOUT' });
      socket.destroy(error);
    }, timeoutMs);
    socket.setKeepAlive(true, 10_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

class RelayEngine {
  constructor(getConfig, connectionManager, logger = () => {}, onStatus = () => {}) {
    this.getConfig = getConfig;
    this.connectionManager = connectionManager;
    this.logger = logger;
    this.onStatus = onStatus;
    this.runtime = new Map();
    this.shuttingDown = false;
  }

  getRoute(routeId) {
    const route = this.getConfig().routes.find((item) => item.id === routeId);
    if (!route) throw Object.assign(new Error(`Route not found: ${routeId}`), { code: 'ROUTE_NOT_FOUND' });
    return route;
  }

  ensureRuntime(routeId) {
    if (!this.runtime.has(routeId)) {
      this.runtime.set(routeId, {
        status: initialStatus(routeId),
        desired: false,
        listener: null,
        pairs: new Set(),
        retryTimer: null,
        retryAttempt: 0,
        token: 0,
        startPromise: null,
        startToken: null,
        signature: null,
        statsTimer: null,
      });
    }
    return this.runtime.get(routeId);
  }

  status(routeId) {
    return { ...this.ensureRuntime(routeId).status };
  }

  statuses() {
    const result = {};
    for (const route of this.getConfig().routes) result[route.id] = this.status(route.id);
    return result;
  }

  emit(runtime, patch = {}) {
    runtime.status = {
      ...runtime.status,
      ...patch,
      desired: runtime.desired,
      activeConnections: runtime.pairs.size,
    };
    this.onStatus({ ...runtime.status });
  }

  emitStats(runtime) {
    if (runtime.statsTimer) return;
    runtime.statsTimer = setTimeout(() => {
      runtime.statsTimer = null;
      this.emit(runtime);
    }, 200);
  }

  start(routeId) {
    const route = this.getRoute(routeId);
    const runtime = this.ensureRuntime(routeId);
    runtime.desired = true;
    runtime.signature = routeSignature(route);
    if (runtime.listener) {
      this.emit(runtime, { state: 'running', lastError: null });
      return Promise.resolve(this.status(routeId));
    }
    if (runtime.startPromise && runtime.startToken === runtime.token) return runtime.startPromise;
    const previousStart = runtime.startPromise;
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    runtime.token += 1;
    const token = runtime.token;
    let startPromise;
    startPromise = (async () => {
      try {
        if (previousStart) await previousStart.catch(() => {});
        if (!runtime.desired || token !== runtime.token || this.shuttingDown) return this.status(routeId);
        await this.activate(route, runtime, token);
        return this.status(routeId);
      } finally {
        if (runtime.startPromise === startPromise) {
          runtime.startPromise = null;
          runtime.startToken = null;
        }
      }
    })();
    runtime.startPromise = startPromise;
    runtime.startToken = token;
    return startPromise;
  }

  async activate(route, runtime, token) {
    this.emit(runtime, {
      state: runtime.retryAttempt ? 'reconnecting' : 'starting',
      retryInMs: null,
      lastError: null,
    });
    let dependencyConnections = [];
    let onDependencyClose = null;
    let listenerPublished = false;
    let lostDuringActivation = null;
    try {
      const onConnection = (socket, info) => {
        if (!runtime.desired || token !== runtime.token || this.shuttingDown) {
          socket.destroy();
          return;
        }
        this.accept(route, runtime, socket, info);
      };
      const onLost = (error) => {
        if (!listenerPublished) {
          lostDuringActivation ||= error || new Error('The listener closed while the route was starting.');
          return;
        }
        this.listenerLost(route, runtime, token, error);
      };
      const remoteNodeIds = [...new Set([route.source.nodeId, route.target.nodeId].filter((nodeId) => nodeId !== LOCAL_NODE_ID))];
      for (const nodeId of remoteNodeIds) {
        if (!runtime.desired || token !== runtime.token || this.shuttingDown) return;
        const connection = await this.connectionManager.get(nodeId);
        if (!runtime.desired || token !== runtime.token || this.shuttingDown) return;
        dependencyConnections.push(connection);
      }
      if (!runtime.desired || token !== runtime.token || this.shuttingDown) return;
      onDependencyClose = () => onLost(new Error('A required SSH connection was lost.'));
      for (const connection of dependencyConnections) connection.once('close', onDependencyClose);
      let listener;
      if (route.source.nodeId === LOCAL_NODE_ID) {
        listener = await listenLocal(route.source.bindHost, route.source.port, onConnection, onLost);
      } else {
        const connection = dependencyConnections.find((item) => item.server.id === route.source.nodeId);
        listener = await connection.listen(route.source.bindHost, route.source.port, onConnection, () => onLost(
          new Error('The remote listener closed because its SSH connection was lost.'),
        ));
      }
      const closeListener = listener.close;
      listener.close = async () => {
        for (const connection of dependencyConnections) connection.off('close', onDependencyClose);
        await closeListener();
      };
      if (!runtime.desired || token !== runtime.token || this.shuttingDown) {
        await listener.close().catch(() => {});
        return;
      }
      if (lostDuringActivation) {
        await listener.close().catch(() => {});
        throw lostDuringActivation;
      }
      runtime.listener = listener;
      listenerPublished = true;
      runtime.retryAttempt = 0;
      this.emit(runtime, {
        state: 'running',
        boundPort: listener.port,
        retryInMs: null,
        lastError: null,
        startedAt: new Date().toISOString(),
      });
      this.logger('info', `${route.name} route started`, { routeId: route.id, port: listener.port });
    } catch (error) {
      if (onDependencyClose) {
        for (const connection of dependencyConnections) connection.off('close', onDependencyClose);
      }
      if (!runtime.desired || token !== runtime.token) return;
      this.logger('error', `${route.name} route failed to start`, { routeId: route.id, error: error.message });
      this.emit(runtime, { state: 'error', lastError: error.message, boundPort: null });
      this.scheduleRetry(route, runtime, token);
      throw error;
    }
  }

  async listenerLost(route, runtime, token, error) {
    if (token !== runtime.token || !runtime.desired) return;
    if (!runtime.listener) return;
    const listener = runtime.listener;
    runtime.listener = null;
    for (const pair of runtime.pairs) {
      pair.incoming?.destroy();
      pair.outgoing?.destroy();
    }
    runtime.pairs.clear();
    await listener?.close().catch(() => {});
    if (token !== runtime.token || !runtime.desired || this.shuttingDown) return;
    this.logger('warn', `${route.name} listener was lost`, { routeId: route.id, error: error?.message });
    const lastError = error?.message || 'The listener was lost.';
    if (!route.reconnect) {
      this.emit(runtime, { state: 'error', lastError, boundPort: null, retryInMs: null });
      return;
    }
    this.emit(runtime, { state: 'reconnecting', lastError, boundPort: null });
    this.scheduleRetry(route, runtime, token);
  }

  scheduleRetry(route, runtime, token) {
    if (token !== runtime.token || !runtime.desired || !route.reconnect || this.shuttingDown || runtime.retryTimer) return;
    runtime.retryAttempt += 1;
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(runtime.retryAttempt - 1, 5)));
    this.emit(runtime, { state: 'reconnecting', retryInMs: delay });
    runtime.retryTimer = setTimeout(async () => {
      runtime.retryTimer = null;
      if (!runtime.desired || token !== runtime.token) return;
      try {
        await this.activate(this.getRoute(route.id), runtime, token);
      } catch {
        // activate schedules the next retry.
      }
    }, delay);
  }

  async accept(route, runtime, incoming, info) {
    const pair = { incoming, outgoing: null, closed: false };
    runtime.pairs.add(pair);
    this.emit(runtime);
    incoming.pause();
    const connectTimer = setTimeout(() => incoming.destroy(Object.assign(new Error('The connection timed out.'), { code: 'ETIMEDOUT' })), 30_000);

    const finish = () => {
      if (pair.closed) return;
      pair.closed = true;
      clearTimeout(connectTimer);
      runtime.pairs.delete(pair);
      this.emit(runtime);
    };
    incoming.once('close', () => {
      pair.outgoing?.destroy();
      finish();
    });
    incoming.once('error', (error) => {
      this.logger('warn', `${route.name} incoming connection error`, { routeId: route.id, error: error.message });
    });

    try {
      if (route.protocol === 'socks5') {
        incoming.resume();
        const socks = await handleSocks5(incoming, (host, port) => this.dial(route, info, host, port));
        pair.outgoing = socks.target;
        this.logger('info', `${route.name}: SOCKS connected to ${socks.destination.host}:${socks.destination.port}`, { routeId: route.id });
      } else {
        pair.outgoing = await this.dial(route, info, route.target.host, route.target.port);
      }

      if (incoming.destroyed) {
        pair.outgoing.destroy();
        return;
      }
      clearTimeout(connectTimer);
      pair.outgoing.once('error', (error) => {
        this.logger('warn', `${route.name} target connection error`, { routeId: route.id, error: error.message });
        incoming.destroy();
      });
      pair.outgoing.once('close', () => {
        incoming.destroy();
        finish();
      });
      incoming.on('data', (chunk) => {
        runtime.status.bytesUp += chunk.length;
        this.emitStats(runtime);
      });
      pair.outgoing.on('data', (chunk) => {
        runtime.status.bytesDown += chunk.length;
        this.emitStats(runtime);
      });
      incoming.pipe(pair.outgoing);
      pair.outgoing.pipe(incoming);
      incoming.resume();
    } catch (error) {
      if (!incoming.writableEnded) incoming.destroy();
      pair.outgoing?.destroy();
      finish();
      this.logger('warn', `${route.name} relay failure`, {
        routeId: route.id,
        sourceAddress: info?.sourceAddress,
        error: error.message,
      });
    }
  }

  async dial(route, sourceInfo, host, port) {
    if (route.target.nodeId === LOCAL_NODE_ID) return dialLocal(host, port);
    const connection = await this.connectionManager.get(route.target.nodeId);
    return connection.dial(sourceInfo?.sourceAddress, sourceInfo?.sourcePort, host, port);
  }

  async stop(routeId) {
    const runtime = this.ensureRuntime(routeId);
    runtime.desired = false;
    runtime.token += 1;
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    runtime.retryAttempt = 0;
    this.emit(runtime, { state: 'stopping', retryInMs: null });
    for (const pair of runtime.pairs) {
      pair.incoming?.destroy();
      pair.outgoing?.destroy();
    }
    runtime.pairs.clear();
    const listener = runtime.listener;
    runtime.listener = null;
    if (listener) await listener.close().catch((error) => {
      this.logger('warn', 'An error occurred while closing a route listener.', { routeId, error: error.message });
    });
    this.emit(runtime, {
      state: 'idle',
      activeConnections: 0,
      boundPort: null,
      retryInMs: null,
      lastError: null,
      startedAt: null,
    });
    return this.status(routeId);
  }

  async syncConfig(previousConfig, nextConfig) {
    const nextRoutes = new Map(nextConfig.routes.map((route) => [route.id, route]));
    for (const oldRoute of previousConfig.routes) {
      const runtime = this.runtime.get(oldRoute.id);
      const nextRoute = nextRoutes.get(oldRoute.id);
      if (!runtime) continue;
      if (!nextRoute) {
        await this.stop(oldRoute.id);
        this.runtime.delete(oldRoute.id);
      } else if (runtime.desired && routeSignature(nextRoute) !== runtime.signature) {
        await this.stop(oldRoute.id);
        await this.start(nextRoute.id).catch(() => {});
      }
    }
  }

  async startAll() {
    await Promise.allSettled(this.getConfig().routes.map((route) => this.start(route.id)));
    return this.statuses();
  }

  async stopAll() {
    await Promise.allSettled([...this.runtime.keys()].map((routeId) => this.stop(routeId)));
    return this.statuses();
  }

  async shutdown() {
    this.shuttingDown = true;
    await this.stopAll();
    this.connectionManager.closeAll();
  }
}

module.exports = {
  RelayEngine,
  dialLocal,
  initialStatus,
  listenLocal,
};
