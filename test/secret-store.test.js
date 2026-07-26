'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SecretStore } = require('../src/core/secret-store');
const TEST_BINDING = 'server-signature-test';

async function withTemporaryStore(context, safeStorage) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-secret-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SecretStore(directory, safeStorage);
  await store.load();
  return store;
}

test('secrets round-trip through the Electron 43 asynchronous safeStorage API', async (context) => {
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    isEncryptionAvailable: () => true,
    encryptStringAsync: async (value) => Buffer.from(`encrypted:${value}`),
    decryptStringAsync: async (buffer) => ({
      shouldReEncrypt: false,
      result: buffer.toString().replace(/^encrypted:/, ''),
    }),
  };
  const store = await withTemporaryStore(context, safeStorage);
  await store.update('server', { password: 'secret', passphrase: 'phrase' }, TEST_BINDING);
  assert.deepEqual(await store.get('server', {}, TEST_BINDING), { password: 'secret', passphrase: 'phrase' });
});

test('secrets round-trip when Electron exposes only synchronous safeStorage', async (context) => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`legacy:${value}`),
    decryptString: (buffer) => buffer.toString().replace(/^legacy:/, ''),
  };
  const store = await withTemporaryStore(context, safeStorage);
  await store.update('server', { password: 'secret' }, TEST_BINDING);
  assert.deepEqual(await store.get('server', {}, TEST_BINDING), { password: 'secret' });
});

test('new secrets are rejected when Linux secure storage falls back to basic_text', async (context) => {
  const safeStorage = {
    getSelectedStorageBackend: () => 'basic_text',
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (buffer) => buffer.toString(),
  };
  const store = await withTemporaryStore(context, safeStorage);
  const status = await store.encryptionStatus();
  assert.equal(status.available, true);
  assert.equal(status.canPersistSecrets, false);
  assert.match(status.warning, /will not save new passwords/i);
  await assert.rejects(
    store.update('server', { password: 'must-not-be-written' }, TEST_BINDING),
    { code: 'INSECURE_SECRET_STORAGE' },
  );
  assert.deepEqual(store.metadata([{ id: 'server', binding: TEST_BINDING }]), {
    server: { hasPassword: false, hasPassphrase: false },
  });
});

test('an encryption failure does not change the existing in-memory secrets', async (context) => {
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    isEncryptionAvailable: () => true,
    encryptStringAsync: async (value) => {
      if (value === 'fail') throw new Error('encryption failed');
      return Buffer.from(`encrypted:${value}`);
    },
    decryptStringAsync: async (buffer) => ({ shouldReEncrypt: false, result: buffer.toString().replace(/^encrypted:/, '') }),
  };
  const store = await withTemporaryStore(context, safeStorage);
  await store.update('server', { password: 'old' }, TEST_BINDING);
  await assert.rejects(store.update('server', { password: 'new', passphrase: 'fail' }, TEST_BINDING), /encryption failed/);
  assert.deepEqual(await store.get('server', {}, TEST_BINDING), { password: 'old' });
});

test('a stored secret cannot be decrypted with a different server signature', async (context) => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`bound:${value}`),
    decryptString: (buffer) => buffer.toString().replace(/^bound:/, ''),
  };
  const store = await withTemporaryStore(context, safeStorage);
  await store.update('server', { password: 'secret' }, 'host-a-signature');
  await assert.rejects(store.get('server', {}, 'host-b-signature'), { code: 'SECRET_BINDING_MISMATCH' });
  assert.deepEqual(store.metadata([{ id: 'server', binding: 'host-b-signature' }]), {
    server: { hasPassword: false, hasPassphrase: false },
  });
});

test('changing authentication mode can remove an unused old secret without reading it', async (context) => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`mode:${value}`),
    decryptString: (buffer) => buffer.toString().replace(/^mode:/, ''),
  };
  const store = await withTemporaryStore(context, safeStorage);
  await store.update('server', { password: 'old-password' }, 'password-mode-signature');
  assert.deepEqual(await store.get('server', {}, 'key-mode-signature', ['passphrase']), {});
  assert.deepEqual(await store.get('server', {}, 'agent-mode-signature', []), {});
  await store.applyChanges(
    { server: { clearPassword: true, clearPassphrase: true } },
    [],
    { server: 'agent-mode-signature' },
  );
  assert.deepEqual(store.metadata([{ id: 'server', binding: 'agent-mode-signature' }]), {
    server: { hasPassword: false, hasPassphrase: false },
  });
});

test('a stored passphrase can be explicitly removed without changing key authentication mode', async (context) => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`clear:${value}`),
    decryptString: (buffer) => buffer.toString().replace(/^clear:/, ''),
  };
  const store = await withTemporaryStore(context, safeStorage);
  await store.update('server', { passphrase: 'old-passphrase' }, TEST_BINDING);
  assert.deepEqual(
    await store.get('server', { clearPassphrase: true }, TEST_BINDING, ['passphrase']),
    {},
  );
  await store.applyChanges(
    { server: { clearPassphrase: true } },
    [],
    { server: TEST_BINDING },
  );
  assert.deepEqual(store.metadata([{ id: 'server', binding: TEST_BINDING }]), {
    server: { hasPassword: false, hasPassphrase: false },
  });
});
