'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { RelayEngine, dialLocal, listenLocal } = require('../src/core/relay-engine');

function createServer(handler) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextData(socket) {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve);
    socket.once('error', reject);
  });
}

test('a local TCP listen-to-target route relays data in both directions', async (context) => {
  const echo = await createServer((socket) => socket.pipe(socket));
  context.after(() => new Promise((resolve) => echo.close(resolve)));
  const targetPort = echo.address().port;
  const route = {
    id: 'tcp', name: 'TCP test', protocol: 'tcp', reconnect: false,
    source: { nodeId: 'local', bindHost: '127.0.0.1', port: 0 },
    target: { nodeId: 'local', host: '127.0.0.1', port: targetPort },
  };
  const config = { routes: [route], servers: [] };
  const engine = new RelayEngine(() => config, { closeAll() {} });
  context.after(() => engine.shutdown());
  await engine.start('tcp');
  const socket = await connect(engine.status('tcp').boundPort);
  socket.write('hello relay');
  assert.equal((await nextData(socket)).toString(), 'hello relay');
  socket.destroy();
  await engine.stop('tcp');
  assert.equal(engine.status('tcp').state, 'idle');
});

test('a SOCKS5 route connects to the requested destination', async (context) => {
  const echo = await createServer((socket) => socket.pipe(socket));
  context.after(() => new Promise((resolve) => echo.close(resolve)));
  const targetPort = echo.address().port;
  const route = {
    id: 'socks', name: 'SOCKS test', protocol: 'socks5', reconnect: false,
    source: { nodeId: 'local', bindHost: '127.0.0.1', port: 0 },
    target: { nodeId: 'local', host: '', port: 0 },
  };
  const config = { routes: [route], servers: [] };
  const engine = new RelayEngine(() => config, { closeAll() {} });
  context.after(() => engine.shutdown());
  await engine.start('socks');
  const socket = await connect(engine.status('socks').boundPort);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual(await nextData(socket), Buffer.from([0x05, 0x00]));
  socket.write(Buffer.from([
    0x05, 0x01, 0x00, 0x01,
    127, 0, 0, 1,
    (targetPort >> 8) & 0xff, targetPort & 0xff,
  ]));
  const reply = await nextData(socket);
  assert.equal(reply[1], 0x00);
  socket.write('through socks');
  assert.equal((await nextData(socket)).toString(), 'through socks');
  socket.destroy();
});

test('a server-A listener to server-B target relays between both connections', async (context) => {
  const echo = await createServer((socket) => socket.pipe(socket));
  context.after(() => new Promise((resolve) => echo.close(resolve)));
  const targetPort = echo.address().port;

  class FakeRemote extends EventEmitter {
    constructor(id) {
      super();
      this.server = { id };
    }

    listen(_host, _port, handler, onLost) {
      return listenLocal('127.0.0.1', 0, handler, onLost);
    }

    dial(_sourceAddress, _sourcePort, host, port) {
      return dialLocal(host, port);
    }
  }

  const remotes = new Map([
    ['server-a', new FakeRemote('server-a')],
    ['server-b', new FakeRemote('server-b')],
  ]);
  const manager = { get: async (id) => remotes.get(id), closeAll() {} };
  const route = {
    id: 'remote-to-remote', name: 'Server-to-server route', protocol: 'tcp', reconnect: true,
    source: { nodeId: 'server-a', bindHost: '127.0.0.1', port: 22000 },
    target: { nodeId: 'server-b', host: '127.0.0.1', port: targetPort },
  };
  const config = { routes: [route], servers: [] };
  const engine = new RelayEngine(() => config, manager);
  context.after(() => engine.shutdown());
  await engine.start(route.id);
  const socket = await connect(engine.status(route.id).boundPort);
  socket.write('server bridge');
  assert.equal((await nextData(socket)).toString(), 'server bridge');
  socket.destroy();
  await engine.stop(route.id);
});

test('a route without automatic reconnection enters error state after listener loss', async () => {
  const route = {
    id: 'no-retry', name: 'No reconnection', protocol: 'tcp', reconnect: false,
    source: { nodeId: 'local', bindHost: '127.0.0.1', port: 19001 },
    target: { nodeId: 'local', host: '127.0.0.1', port: 19002 },
  };
  const engine = new RelayEngine(() => ({ routes: [route], servers: [] }), { closeAll() {} });
  const runtime = engine.ensureRuntime(route.id);
  runtime.desired = true;
  runtime.token = 1;
  runtime.listener = { close: async () => {} };
  await engine.listenerLost(route, runtime, 1, new Error('listener lost'));
  assert.equal(engine.status(route.id).state, 'error');
  assert.equal(engine.status(route.id).retryInMs, null);
  assert.equal(runtime.retryTimer, null);
});

test('a stale listener-loss callback does not overwrite state after stop', async () => {
  const route = {
    id: 'stale-loss', name: 'Stale callback', protocol: 'tcp', reconnect: true,
    source: { nodeId: 'local', bindHost: '127.0.0.1', port: 19003 },
    target: { nodeId: 'local', host: '127.0.0.1', port: 19004 },
  };
  const engine = new RelayEngine(() => ({ routes: [route], servers: [] }), { closeAll() {} });
  const runtime = engine.ensureRuntime(route.id);
  let releaseClose;
  runtime.desired = true;
  runtime.token = 1;
  runtime.listener = { close: () => new Promise((resolve) => { releaseClose = resolve; }) };
  const loss = engine.listenerLost(route, runtime, 1, new Error('listener lost'));
  await Promise.resolve();
  runtime.desired = false;
  runtime.token = 2;
  engine.emit(runtime, { state: 'idle', lastError: null });
  releaseClose();
  await loss;
  assert.equal(engine.status(route.id).state, 'idle');
  assert.equal(runtime.retryTimer, null);
});

test('starting an already-running route does not invalidate its listener-loss token', async () => {
  const route = {
    id: 'already-running', name: 'Already running', protocol: 'tcp', reconnect: true,
    source: { nodeId: 'local', bindHost: '127.0.0.1', port: 19005 },
    target: { nodeId: 'local', host: '127.0.0.1', port: 19006 },
  };
  const engine = new RelayEngine(() => ({ routes: [route], servers: [] }), { closeAll() {} });
  const runtime = engine.ensureRuntime(route.id);
  runtime.desired = true;
  runtime.token = 7;
  runtime.listener = { port: 19005, close: async () => {} };
  await engine.start(route.id);
  assert.equal(runtime.token, 7);
  assert.equal(engine.status(route.id).state, 'running');
});

test('manual stop resets the reconnection backoff count', async () => {
  const route = {
    id: 'reset-backoff', name: 'Reset backoff', protocol: 'tcp', reconnect: true,
    source: { nodeId: 'local', bindHost: '127.0.0.1', port: 19007 },
    target: { nodeId: 'local', host: '127.0.0.1', port: 19008 },
  };
  const engine = new RelayEngine(() => ({ routes: [route], servers: [] }), { closeAll() {} });
  const runtime = engine.ensureRuntime(route.id);
  runtime.desired = true;
  runtime.retryAttempt = 5;
  await engine.stop(route.id);
  assert.equal(runtime.retryAttempt, 0);
});

function remoteSourceRoute(id) {
  return {
    id,
    name: id,
    protocol: 'tcp',
    reconnect: false,
    source: { nodeId: 'remote-source', bindHost: '127.0.0.1', port: 22000 },
    target: { nodeId: 'local', host: '127.0.0.1', port: 22001 },
  };
}

class LifecycleRemote extends EventEmitter {
  constructor() {
    super();
    this.server = { id: 'remote-source' };
    this.listenCalls = 0;
    this.closeCalls = 0;
    this.handler = null;
    this.immediateLoss = false;
  }

  async listen(_host, port, handler, onLost) {
    this.listenCalls += 1;
    this.handler = handler;
    if (this.immediateLoss) onLost(new Error('lost before publication'));
    return {
      port,
      close: async () => { this.closeCalls += 1; },
    };
  }
}

test('concurrent route starts share one activation and one listener bind', async (context) => {
  const route = remoteSourceRoute('concurrent-start');
  const remote = new LifecycleRemote();
  let releaseDependency;
  const dependency = new Promise((resolve) => { releaseDependency = resolve; });
  let getCalls = 0;
  const manager = {
    get: async () => {
      getCalls += 1;
      return dependency;
    },
    closeAll() {},
  };
  const engine = new RelayEngine(() => ({ routes: [route], servers: [] }), manager);
  context.after(() => engine.shutdown());

  const first = engine.start(route.id);
  const second = engine.start(route.id);
  assert.strictEqual(first, second);
  releaseDependency(remote);
  await Promise.all([first, second]);

  assert.equal(getCalls, 1);
  assert.equal(remote.listenCalls, 1);
  assert.equal(engine.status(route.id).state, 'running');
});

test('stop during activation followed by immediate start waits for stale activation cleanup', async (context) => {
  const route = remoteSourceRoute('restart-during-start');
  const remote = new LifecycleRemote();
  let releaseFirstDependency;
  const firstDependency = new Promise((resolve) => { releaseFirstDependency = resolve; });
  let getCalls = 0;
  const manager = {
    get: async () => {
      getCalls += 1;
      return getCalls === 1 ? firstDependency : remote;
    },
    closeAll() {},
  };
  const engine = new RelayEngine(() => ({ routes: [route], servers: [] }), manager);
  context.after(() => engine.shutdown());

  const staleStart = engine.start(route.id);
  await Promise.resolve();
  await engine.stop(route.id);
  const freshStart = engine.start(route.id);
  assert.notStrictEqual(staleStart, freshStart);
  releaseFirstDependency(remote);
  await Promise.all([staleStart, freshStart]);

  assert.equal(getCalls, 2);
  assert.equal(remote.listenCalls, 1);
  assert.equal(engine.status(route.id).state, 'running');
  assert.equal(engine.status(route.id).desired, true);
});

test('listener loss during activation is closed and never published as running', async (context) => {
  const route = remoteSourceRoute('loss-during-activation');
  const remote = new LifecycleRemote();
  remote.immediateLoss = true;
  const manager = { get: async () => remote, closeAll() {} };
  const engine = new RelayEngine(() => ({ routes: [route], servers: [] }), manager);
  context.after(() => engine.shutdown());

  await assert.rejects(engine.start(route.id));
  assert.equal(remote.listenCalls, 1);
  assert.equal(remote.closeCalls, 1);
  assert.equal(engine.ensureRuntime(route.id).listener, null);
  assert.equal(engine.status(route.id).state, 'error');
});

test('a stale listener callback destroys the socket instead of accepting a route pair', async (context) => {
  const route = remoteSourceRoute('stale-accept');
  const remote = new LifecycleRemote();
  const manager = { get: async () => remote, closeAll() {} };
  const engine = new RelayEngine(() => ({ routes: [route], servers: [] }), manager);
  context.after(() => engine.shutdown());
  let accepted = 0;
  engine.accept = () => { accepted += 1; };

  await engine.start(route.id);
  const staleHandler = remote.handler;
  await engine.stop(route.id);
  let destroyed = 0;
  staleHandler({ destroy: () => { destroyed += 1; } }, {});

  assert.equal(destroyed, 1);
  assert.equal(accepted, 0);
  assert.equal(engine.ensureRuntime(route.id).pairs.size, 0);
});

test('stopping while the first dependency connects does not authenticate a later dependency', async (context) => {
  const route = {
    id: 'stop-between-dependencies',
    name: 'stop between dependencies',
    protocol: 'tcp',
    reconnect: false,
    source: { nodeId: 'remote-a', bindHost: '127.0.0.1', port: 22002 },
    target: { nodeId: 'remote-b', host: '127.0.0.1', port: 22003 },
  };
  const remoteA = new LifecycleRemote();
  remoteA.server = { id: 'remote-a' };
  const remoteB = new LifecycleRemote();
  remoteB.server = { id: 'remote-b' };
  let releaseA;
  const pendingA = new Promise((resolve) => { releaseA = resolve; });
  const requested = [];
  const manager = {
    get: async (id) => {
      requested.push(id);
      if (id === 'remote-a') return pendingA;
      return remoteB;
    },
    closeAll() {},
  };
  const engine = new RelayEngine(() => ({ routes: [route], servers: [] }), manager);
  context.after(() => engine.shutdown());

  const starting = engine.start(route.id);
  await Promise.resolve();
  await engine.stop(route.id);
  releaseA(remoteA);
  await starting;

  assert.deepEqual(requested, ['remote-a']);
  assert.equal(remoteA.listenCalls, 0);
  assert.equal(remoteB.listenCalls, 0);
  assert.equal(engine.status(route.id).state, 'idle');
});
