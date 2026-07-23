'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Server, utils } = require('ssh2');
const {
  RemoteConnection,
  hostKeyFingerprint,
  probeServerHostKey,
  resolveSshAgent,
  testServerConnection,
} = require('../src/core/connection-manager');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test('the host-key probe does not send credentials', async (context) => {
  const ssh2Root = path.dirname(require.resolve('ssh2/package.json'));
  const hostKey = fs.readFileSync(path.join(ssh2Root, 'test', 'fixtures', 'ssh_host_rsa_key'));
  let passwordAttempts = 0;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {
      // The probe intentionally closes immediately after receiving the host key.
    });
    client.on('authentication', (authentication) => {
      if (authentication.method === 'password') passwordAttempts += 1;
      if (authentication.method === 'password' && authentication.password === 'secret') authentication.accept();
      else authentication.reject();
    });
  });
  server.on('error', () => {
    // A server-side connection error is expected because the host-key probe intentionally rejects key exchange.
  });
  const port = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const draft = {
    id: 'server', name: 'Test server', host: '127.0.0.1', port, username: 'dev',
    authMode: 'password', keyPath: '', hostFingerprint: '',
  };
  const probe = await probeServerHostKey(draft);
  assert.equal(probe.ok, true);
  assert.match(probe.fingerprint, /^SHA256:/);
  assert.equal(passwordAttempts, 0);

  await assert.rejects(testServerConnection(draft, { password: 'secret' }), { code: 'UNTRUSTED_HOST' });
  assert.equal(passwordAttempts, 0);

  const authenticated = await testServerConnection(
    { ...draft, hostFingerprint: probe.fingerprint },
    { password: 'secret' },
  );
  assert.equal(authenticated.ok, true);
  assert.equal(passwordAttempts, 1);
});

test('closing while the secret provider is pending prevents stale authentication permanently', async (context) => {
  let acceptedConnections = 0;
  const tcpServer = net.createServer((socket) => {
    acceptedConnections += 1;
    socket.destroy();
  });
  const port = await listen(tcpServer);
  context.after(() => new Promise((resolve) => tcpServer.close(resolve)));

  let releaseSecret;
  let markSecretRequested;
  const secretRequested = new Promise((resolve) => { markSecretRequested = resolve; });
  let providerCalls = 0;
  const connection = new RemoteConnection({
    id: 'cancel-secret',
    name: 'cancel secret',
    host: '127.0.0.1',
    port,
    username: 'dev',
    authMode: 'password',
    hostFingerprint: 'SHA256:not-used-after-cancel',
  }, async () => {
    providerCalls += 1;
    markSecretRequested();
    return new Promise((resolve) => { releaseSecret = resolve; });
  }, () => {});

  const pending = connection.connect();
  await secretRequested;
  connection.close();
  releaseSecret({ password: 'must-not-be-sent' });

  await assert.rejects(pending, { code: 'CONNECTION_CANCELLED' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(acceptedConnections, 0);
  await assert.rejects(connection.connect(), { code: 'CONNECTION_CANCELLED' });
  assert.equal(providerCalls, 1);
});

test('closing while key/config preparation is pending prevents a later SSH connect', async (context) => {
  let acceptedConnections = 0;
  const tcpServer = net.createServer((socket) => {
    acceptedConnections += 1;
    socket.destroy();
  });
  const port = await listen(tcpServer);
  context.after(() => new Promise((resolve) => tcpServer.close(resolve)));

  let releaseBuild;
  let markBuildStarted;
  const buildStarted = new Promise((resolve) => { markBuildStarted = resolve; });
  const connection = new RemoteConnection({
    id: 'cancel-build',
    name: 'cancel build',
    host: '127.0.0.1',
    port,
    username: 'dev',
    authMode: 'key',
    keyPath: 'delayed-key',
    hostFingerprint: 'SHA256:not-used-after-cancel',
  }, async () => ({ passphrase: 'must-not-be-sent' }), () => {}, {
    buildConnectConfig: async () => {
      markBuildStarted();
      return new Promise((resolve) => { releaseBuild = resolve; });
    },
  });

  const pending = connection.connect();
  await buildStarted;
  connection.close();
  releaseBuild({
    host: '127.0.0.1',
    port,
    username: 'dev',
    privateKey: Buffer.from('not-a-real-key'),
  });

  await assert.rejects(pending, { code: 'CONNECTION_CANCELLED' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(acceptedConnections, 0);
});

test('Windows agent selection prefers SSH_AUTH_SOCK, then OpenSSH pipe, then Pageant', async () => {
  const pipePath = '\\\\.\\pipe\\openssh-ssh-agent';
  let probes = 0;
  assert.equal(await resolveSshAgent({
    env: { SSH_AUTH_SOCK: 'custom-agent' },
    platform: 'win32',
    probeAgentPipe: async () => { probes += 1; return true; },
  }), 'custom-agent');
  assert.equal(probes, 0);

  assert.equal(await resolveSshAgent({
    env: {},
    platform: 'win32',
    probeAgentPipe: async (candidate) => {
      probes += 1;
      assert.equal(candidate, pipePath);
      return true;
    },
  }), pipePath);
  assert.equal(await resolveSshAgent({
    env: {},
    platform: 'win32',
    probeAgentPipe: async () => {
      probes += 1;
      return false;
    },
  }), 'pageant');
  assert.equal(probes, 2);
});

test('connection test settles when a server closes cleanly before authentication finishes', async (context) => {
  const ssh2Root = path.dirname(require.resolve('ssh2/package.json'));
  const hostKey = fs.readFileSync(path.join(ssh2Root, 'test', 'fixtures', 'ssh_host_rsa_key'));
  const publicKey = utils.parseKey(hostKey).getPublicSSH();
  const fingerprint = hostKeyFingerprint(publicKey);
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', () => client.end());
  });
  server.on('error', () => {});
  const port = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await withTimeout(
    testServerConnection({
      id: 'clean-close',
      name: 'clean close',
      host: '127.0.0.1',
      port,
      username: 'dev',
      authMode: 'password',
      hostFingerprint: fingerprint,
    }, { password: 'secret' }),
    2_000,
    'testServerConnection did not settle after close',
  );
  assert.equal(result.ok, false);
  assert.equal(result.fingerprint, fingerprint);
  assert.equal(result.code, 'CONNECTION_CLOSED');
});

test('a RemoteConnection is permanently disposed after its SSH client closes', async (context) => {
  const ssh2Root = path.dirname(require.resolve('ssh2/package.json'));
  const hostKey = fs.readFileSync(path.join(ssh2Root, 'test', 'fixtures', 'ssh_host_rsa_key'));
  const fingerprint = hostKeyFingerprint(utils.parseKey(hostKey).getPublicSSH());
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (authentication) => {
      if (authentication.method === 'password' && authentication.password === 'secret') authentication.accept();
      else authentication.reject();
    });
    client.on('ready', () => setTimeout(() => client.end(), 50));
  });
  server.on('error', () => {});
  const port = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));

  let providerCalls = 0;
  const connection = new RemoteConnection({
    id: 'remote-close',
    name: 'remote close',
    host: '127.0.0.1',
    port,
    username: 'dev',
    authMode: 'password',
    hostFingerprint: fingerprint,
  }, async () => {
    providerCalls += 1;
    return { password: 'secret' };
  }, () => {});
  const closed = once(connection, 'close');

  await connection.connect();
  await withTimeout(closed, 2_000, 'RemoteConnection did not close');
  assert.equal(connection.disposed, true);
  await assert.rejects(connection.connect(), { code: 'CONNECTION_CANCELLED' });
  assert.equal(providerCalls, 1);
});
