'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  discoverPrivateKeys,
  looksLikePrivateKey,
} = require('../src/core/ssh-key-discovery');

test('private key headers are recognized without exposing key contents', () => {
  assert.equal(looksLikePrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret'), true);
  assert.equal(looksLikePrivateKey('PuTTY-User-Key-File-3: ssh-ed25519\nsecret'), true);
  assert.equal(looksLikePrivateKey('ssh-ed25519 AAAA public-key'), false);
});

test('private keys are discovered in preferred order while helper files are ignored', async (context) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-keys-'));
  const sshDirectory = path.join(homeDirectory, '.ssh');
  await fs.mkdir(sshDirectory);
  await Promise.all([
    fs.writeFile(path.join(sshDirectory, 'custom-key'), '-----BEGIN OPENSSH PRIVATE KEY-----\ncustom'),
    fs.writeFile(path.join(sshDirectory, 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----\nrsa'),
    fs.writeFile(path.join(sshDirectory, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\ned25519'),
    fs.writeFile(path.join(sshDirectory, 'id_ed25519.pub'), 'ssh-ed25519 AAAA public'),
    fs.writeFile(path.join(sshDirectory, 'known_hosts'), 'example ssh-ed25519 AAAA'),
  ]);
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  const keys = await discoverPrivateKeys(homeDirectory);
  assert.deepEqual(keys.map((key) => key.name), ['id_ed25519', 'id_rsa', 'custom-key']);
  assert.equal(keys[0].preferred, true);
  assert.equal(keys[2].preferred, false);
  assert.ok(keys.every((key) => !Object.hasOwn(key, 'content')));
});

test('a missing SSH directory returns no detected keys', async () => {
  const homeDirectory = path.join(os.tmpdir(), `portpatch-missing-${Date.now()}`);
  assert.deepEqual(await discoverPrivateKeys(homeDirectory), []);
});
