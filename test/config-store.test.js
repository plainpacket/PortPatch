'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/core/config-store');

test('configuration is saved to disk and loaded again', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ConfigStore(directory);
  const config = await store.load();
  config.localNode.name = 'Workstation';
  await store.save(config);
  const second = new ConfigStore(directory);
  assert.equal((await second.load()).localNode.name, 'Workstation');
});

test('an invalid route configuration is not saved', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ConfigStore(directory);
  const config = await store.load();
  config.routes.push({
    id: 'bad', name: 'Invalid route', protocol: 'tcp',
    source: { nodeId: 'local', bindHost: '127.0.0.1', port: 99999 },
    target: { nodeId: 'local', host: '127.0.0.1', port: 80 },
  });
  await assert.rejects(store.save(config), { code: 'INVALID_CONFIG' });
});
