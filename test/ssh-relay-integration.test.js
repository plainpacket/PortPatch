'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Server, utils } = require('ssh2');
const { ConnectionManager, hostKeyFingerprint } = require('../src/core/connection-manager');
const { RelayEngine } = require('../src/core/relay-engine');

function listenNet(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
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

function createForwardingSshServer(hostKey) {
  const forwardedListeners = new Map();
  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (authentication) => {
      if (authentication.method === 'password' && authentication.password === 'secret') authentication.accept();
      else authentication.reject();
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const target = net.createConnection({ host: info.destIP, port: info.destPort });
        target.once('connect', () => {
          let channel;
          try { channel = accept(); } catch { target.destroy(); return; }
          target.pipe(channel).pipe(target);
        });
        target.once('error', () => {
          try { reject(); } catch {}
        });
      });
      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          let actualPort = 0;
          const listener = net.createServer((socket) => {
            client.forwardOut(
              info.bindAddr,
              actualPort,
              socket.remoteAddress || '127.0.0.1',
              socket.remotePort || 0,
              (error, channel) => {
                if (error) socket.destroy(error);
                else socket.pipe(channel).pipe(socket);
              },
            );
          });
          listener.once('error', () => {
            try { reject(); } catch {}
          });
          listener.listen(info.bindPort, info.bindAddr, () => {
            actualPort = listener.address().port;
            forwardedListeners.set(`${info.bindAddr}:${actualPort}`, listener);
            accept(actualPort);
          });
          return;
        }
        if (name === 'cancel-tcpip-forward') {
          const key = `${info.bindAddr}:${info.bindPort}`;
          const listener = forwardedListeners.get(key);
          if (!listener) return reject();
          forwardedListeners.delete(key);
          listener.close(() => accept());
          return;
        }
        reject();
      });
    });
  });
  server.on('error', () => {});
  return {
    server,
    async listen() { return listenNet(server); },
    async close() {
      for (const listener of forwardedListeners.values()) await new Promise((resolve) => listener.close(resolve));
      forwardedListeners.clear();
      for (const client of clients) client.end();
      if (server.address()) await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('real ssh2 forwardIn(A) to forwardOut(B) relays data between servers', async () => {
  const ssh2Root = path.dirname(require.resolve('ssh2/package.json'));
  const hostKey = fs.readFileSync(path.join(ssh2Root, 'test', 'fixtures', 'ssh_host_rsa_key'));
  const parsedKey = utils.parseKey(hostKey);
  if (parsedKey instanceof Error) throw parsedKey;
  const fingerprint = hostKeyFingerprint(parsedKey.getPublicSSH());

  const echo = net.createServer((socket) => socket.pipe(socket));
  const echoPort = await listenNet(echo);
  const sshA = createForwardingSshServer(hostKey);
  const sshB = createForwardingSshServer(hostKey);
  const portA = await sshA.listen();
  const portB = await sshB.listen();
  const route = {
    id: 'real-remote-bridge', name: 'Real SSH server-to-server route', protocol: 'tcp', reconnect: false, allowExternal: true,
    source: { nodeId: 'server-a', bindHost: '127.0.0.1', port: 0 },
    target: { nodeId: 'server-b', host: '127.0.0.1', port: echoPort },
  };
  const config = {
    servers: [
      { id: 'server-a', name: 'Server A', host: '127.0.0.1', port: portA, username: 'dev', authMode: 'password', keyPath: '', hostFingerprint: fingerprint },
      { id: 'server-b', name: 'Server B', host: '127.0.0.1', port: portB, username: 'dev', authMode: 'password', keyPath: '', hostFingerprint: fingerprint },
    ],
    routes: [route],
  };
  const manager = new ConnectionManager(() => config, async () => ({ password: 'secret' }));
  const engine = new RelayEngine(() => config, manager);

  try {
    await engine.start(route.id);
    const socket = await connect(engine.status(route.id).boundPort);
    socket.write('real ssh2 bridge');
    assert.equal((await nextData(socket)).toString(), 'real ssh2 bridge');
    socket.destroy();
  } finally {
    await engine.shutdown();
    await Promise.all([sshA.close(), sshB.close()]);
    await new Promise((resolve) => echo.close(resolve));
  }
});
