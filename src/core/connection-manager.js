'use strict';

const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('ssh2');

function expandPath(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function serverSignature(server) {
  return JSON.stringify({
    host: server.host,
    port: Number(server.port),
    username: server.username,
    authMode: server.authMode,
    keyPath: server.keyPath || '',
    hostFingerprint: server.hostFingerprint || '',
  });
}

function hostKeyFingerprint(key) {
  if (!Buffer.isBuffer(key)) throw new Error('The SSH server host key has an invalid format.');
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

function probeAgentPipe(pipePath, timeoutMs = 250) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection(pipePath);
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function resolveSshAgent(options = {}) {
  const environment = options.env || process.env;
  if (environment.SSH_AUTH_SOCK) return environment.SSH_AUTH_SOCK;
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return '';
  const pipePath = options.windowsAgentPipe || '\\\\.\\pipe\\openssh-ssh-agent';
  const probe = options.probeAgentPipe || probeAgentPipe;
  return await probe(pipePath, options.agentProbeTimeoutMs || 250) ? pipePath : 'pageant';
}

async function buildConnectConfig(server, secret, options = {}) {
  const config = {
    host: server.host,
    port: Number(server.port || 22),
    username: server.username,
    readyTimeout: options.readyTimeout || 12_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
  };

  if (server.authMode === 'password') {
    if (!secret.password) throw Object.assign(new Error('No SSH password is stored.'), { code: 'MISSING_PASSWORD' });
    config.password = secret.password;
  } else if (server.authMode === 'key') {
    if (!server.keyPath) throw Object.assign(new Error('No SSH private key path is configured.'), { code: 'MISSING_KEY' });
    try {
      config.privateKey = await fs.readFile(expandPath(server.keyPath));
    } catch (error) {
      throw Object.assign(new Error(`Could not read the SSH private key: ${error.message}`), { code: 'KEY_READ_FAILED' });
    }
    if (secret.passphrase) config.passphrase = secret.passphrase;
  } else if (server.authMode === 'agent') {
    const agent = await resolveSshAgent(options);
    if (!agent) throw Object.assign(new Error('No running SSH agent was found.'), { code: 'MISSING_AGENT' });
    config.agent = agent;
  }

  return config;
}

async function testServerConnection(server, secret = {}) {
  if (!server.hostFingerprint) {
    throw Object.assign(new Error('Verify the server host key before authentication.'), { code: 'UNTRUSTED_HOST' });
  }
  const connectConfig = await buildConnectConfig(server, secret, { readyTimeout: 10_000 });
  let offeredFingerprint = '';
  let mismatch = false;
  connectConfig.hostVerifier = (key) => {
    const fingerprint = hostKeyFingerprint(key);
    offeredFingerprint = fingerprint;
    const accepted = fingerprint === server.hostFingerprint;
    mismatch = !accepted;
    return accepted;
  };

  return new Promise((resolve) => {
    const client = new Client();
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      try { client.end(); } catch {}
      resolve(result);
    };
    client.once('ready', () => finish({
      ok: true,
      fingerprint: offeredFingerprint,
      trusted: Boolean(server.hostFingerprint && server.hostFingerprint === offeredFingerprint),
      message: 'The host key and SSH authentication were verified.',
    }));
    client.once('error', (error) => finish({
      ok: false,
      fingerprint: offeredFingerprint,
      mismatch,
      message: mismatch
        ? 'The server host key differs from the trusted value. Check for a man-in-the-middle attack or server reinstallation.'
        : error.message,
      code: mismatch ? 'HOST_KEY_MISMATCH' : error.code,
    }));
    client.once('close', () => finish({
      ok: false,
      fingerprint: offeredFingerprint,
      mismatch,
      message: offeredFingerprint
        ? 'The server closed the connection before SSH authentication completed.'
        : 'The SSH connection closed before a host key was received.',
      code: offeredFingerprint ? 'CONNECTION_CLOSED' : 'HOST_KEY_UNAVAILABLE',
    }));
    try {
      client.connect(connectConfig);
    } catch (error) {
      finish({ ok: false, fingerprint: offeredFingerprint, message: error.message, code: error.code });
    }
  });
}

function probeServerHostKey(server) {
  return new Promise((resolve) => {
    const client = new Client();
    let offeredFingerprint = '';
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      try { client.end(); } catch {}
      resolve(result);
    };
    const connectConfig = {
      host: server.host,
      port: Number(server.port || 22),
      username: server.username || 'host-key-probe',
      readyTimeout: 10_000,
      hostVerifier: (key) => {
        const fingerprint = hostKeyFingerprint(key);
        offeredFingerprint = fingerprint;
        queueMicrotask(() => finish({
          ok: true,
          fingerprint,
          trusted: Boolean(server.hostFingerprint && server.hostFingerprint === fingerprint),
          message: 'The server host key was received. No credentials have been sent.',
        }));
        return false;
      },
    };
    client.once('error', (error) => {
      if (offeredFingerprint) return;
      finish({ ok: false, fingerprint: '', message: error.message, code: error.code });
    });
    client.once('close', () => {
      if (!finished && !offeredFingerprint) {
        finish({ ok: false, fingerprint: '', message: 'The connection closed before a host key was received.', code: 'HOST_KEY_UNAVAILABLE' });
      }
    });
    try {
      client.connect(connectConfig);
    } catch (error) {
      finish({ ok: false, fingerprint: '', message: error.message, code: error.code });
    }
  });
}

class RemoteConnection extends EventEmitter {
  constructor(server, secretProvider, logger, options = {}) {
    super();
    this.server = server;
    this.secretProvider = secretProvider;
    this.logger = logger;
    this.buildConnectConfig = options.buildConnectConfig || buildConnectConfig;
    this.client = null;
    this.connecting = null;
    this.ready = false;
    this.closedByUser = false;
    this.disposed = false;
    this.generation = 0;
    this.remoteListeners = new Map();
    this.signature = serverSignature(server);
  }

  cancellationError() {
    return Object.assign(new Error('The SSH connection was cancelled.'), { code: 'CONNECTION_CANCELLED' });
  }

  assertCurrent(generation) {
    if (this.disposed || generation !== this.generation) throw this.cancellationError();
  }

  async connect() {
    if (this.disposed) throw this.cancellationError();
    if (this.ready && this.client) return this;
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    const connecting = this.open(generation);
    this.connecting = connecting;
    try {
      await connecting;
      this.assertCurrent(generation);
      return this;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  async open(generation) {
    this.assertCurrent(generation);
    if (!this.server.hostFingerprint) {
      throw Object.assign(new Error('Trust the server host key through a connection test first.'), { code: 'UNTRUSTED_HOST' });
    }
    let secret;
    try {
      secret = await this.secretProvider(this.server.id);
    } catch (error) {
      this.assertCurrent(generation);
      throw error;
    }
    this.assertCurrent(generation);
    let connectConfig;
    try {
      connectConfig = await this.buildConnectConfig(this.server, secret);
    } catch (error) {
      this.assertCurrent(generation);
      throw error;
    }
    this.assertCurrent(generation);
    connectConfig.hostVerifier = (key) => (
      !this.disposed
      && generation === this.generation
      && hostKeyFingerprint(key) === this.server.hostFingerprint
    );

    await new Promise((resolve, reject) => {
      const client = new Client();
      try {
        this.assertCurrent(generation);
      } catch (error) {
        reject(error);
        return;
      }
      this.client = client;
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      client.once('ready', () => {
        if (this.disposed || generation !== this.generation || this.client !== client) {
          try { client.end(); } catch {}
          fail(this.cancellationError());
          return;
        }
        settled = true;
        this.ready = true;
        this.logger('info', `${this.server.name} SSH connected`, { serverId: this.server.id });
        resolve();
      });
      client.on('tcp connection', (info, accept, rejectConnection) => {
        if (this.disposed || generation !== this.generation || this.client !== client) {
          rejectConnection();
          return;
        }
        this.onTcpConnection(info, accept, rejectConnection);
      });
      client.on('error', (error) => {
        if (this.disposed || generation !== this.generation || this.client !== client) {
          fail(this.cancellationError());
          return;
        }
        this.logger('error', `${this.server.name} SSH error`, { serverId: this.server.id, error: error.message });
        fail(error);
        this.emit('connection-error', error);
      });
      client.on('close', () => {
        if (this.client !== client) {
          fail(this.cancellationError());
          return;
        }
        const closedWhileCurrent = !this.disposed && generation === this.generation;
        if (!settled && !closedWhileCurrent) {
          fail(this.cancellationError());
        }
        const wasReady = this.ready;
        this.ready = false;
        this.client = null;
        this.disposed = true;
        this.generation += 1;
        for (const listener of this.remoteListeners.values()) listener.onLost?.();
        this.remoteListeners.clear();
        if (wasReady) this.logger('warn', `${this.server.name} SSH disconnected`, { serverId: this.server.id });
        this.emit('close', { expected: this.closedByUser });
        if (!settled) fail(new Error(`${this.server.name} SSH disconnected before it was ready.`));
      });
      try {
        this.assertCurrent(generation);
        client.connect(connectConfig);
      } catch (error) {
        fail(error);
      }
    });
  }

  onTcpConnection(info, accept, rejectConnection) {
    const listener = this.remoteListeners.get(Number(info.destPort));
    if (!listener) {
      rejectConnection();
      return;
    }
    let stream;
    try {
      stream = accept();
    } catch (error) {
      this.logger('error', 'Could not accept a remote listener connection.', { error: error.message });
      return;
    }
    listener.handler(stream, {
      sourceAddress: info.srcIP,
      sourcePort: info.srcPort,
      destinationAddress: info.destIP,
      destinationPort: info.destPort,
    });
  }

  async listen(bindHost, port, handler, onLost) {
    await this.connect();
    const generation = this.generation;
    this.assertCurrent(generation);
    const client = this.client;
    const requestedPort = Number(port);
    if (this.remoteListeners.has(requestedPort)) {
      throw new Error(`Remote port ${requestedPort} is already in use.`);
    }
    const actualPort = await new Promise((resolve, reject) => {
      client.forwardIn(bindHost, requestedPort, (error, assignedPort) => {
        if (this.disposed || generation !== this.generation || this.client !== client) {
          if (!error) {
            try { client.unforwardIn(bindHost, Number(assignedPort || port), () => {}); } catch {}
          }
          reject(this.cancellationError());
        } else if (error) reject(error);
        else resolve(Number(assignedPort || port));
      });
    });
    if (this.remoteListeners.has(actualPort)) {
      await new Promise((resolve) => {
        this.client.unforwardIn(bindHost, actualPort, () => resolve());
      });
      throw new Error(`Remote port ${actualPort} is already in use.`);
    }
    this.remoteListeners.set(actualPort, { bindHost, handler, onLost });
    return {
      port: actualPort,
      close: () => this.unlisten(bindHost, actualPort),
    };
  }

  async unlisten(bindHost, port) {
    this.remoteListeners.delete(Number(port));
    if (!this.ready || !this.client) return;
    await new Promise((resolve, reject) => {
      this.client.unforwardIn(bindHost, Number(port), (error) => error ? reject(error) : resolve());
    });
  }

  async dial(sourceAddress, sourcePort, targetHost, targetPort) {
    await this.connect();
    const generation = this.generation;
    this.assertCurrent(generation);
    const client = this.client;
    return new Promise((resolve, reject) => {
      client.forwardOut(
        sourceAddress || '127.0.0.1',
        Number(sourcePort || 0),
        targetHost,
        Number(targetPort),
        (error, stream) => {
          if (this.disposed || generation !== this.generation || this.client !== client) {
            stream?.destroy();
            reject(this.cancellationError());
          } else if (error) reject(error);
          else resolve(stream);
        },
      );
    });
  }

  close() {
    this.closedByUser = true;
    this.disposed = true;
    this.generation += 1;
    try { this.client?.end(); } catch {}
  }
}

class ConnectionManager {
  constructor(getConfig, secretProvider, logger = () => {}) {
    this.getConfig = getConfig;
    this.secretProvider = secretProvider;
    this.logger = logger;
    this.connections = new Map();
  }

  getServer(serverId) {
    const server = this.getConfig().servers.find((item) => item.id === serverId);
    if (!server) throw Object.assign(new Error(`Server not found: ${serverId}`), { code: 'SERVER_NOT_FOUND' });
    return server;
  }

  async get(serverId) {
    const server = this.getServer(serverId);
    let connection = this.connections.get(serverId);
    if (connection && connection.signature !== serverSignature(server)) {
      connection.close();
      this.connections.delete(serverId);
      connection = null;
    }
    if (!connection) {
      connection = new RemoteConnection(server, this.secretProvider, this.logger);
      this.connections.set(serverId, connection);
      connection.once('close', () => {
        if (this.connections.get(serverId) === connection) this.connections.delete(serverId);
      });
    }
    await connection.connect();
    return connection;
  }

  invalidate(serverId) {
    const connection = this.connections.get(serverId);
    if (connection) connection.close();
    this.connections.delete(serverId);
  }

  closeAll() {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}

module.exports = {
  ConnectionManager,
  RemoteConnection,
  buildConnectConfig,
  expandPath,
  hostKeyFingerprint,
  probeAgentPipe,
  resolveSshAgent,
  serverSignature,
  probeServerHostKey,
  testServerConnection,
};
