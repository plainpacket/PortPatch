'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const PREFERRED_KEY_NAMES = [
  'id_ed25519',
  'id_mldsa44_ed25519',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519_sk',
  'id_rsa',
  'id_dsa',
];

const IGNORED_NAMES = new Set([
  'authorized_keys',
  'config',
  'known_hosts',
  'known_hosts.old',
]);

function keyPreference(name) {
  const index = PREFERRED_KEY_NAMES.indexOf(name);
  return index === -1 ? PREFERRED_KEY_NAMES.length : index;
}

function looksLikePrivateKey(content) {
  return [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN DSA PRIVATE KEY-----',
    '-----BEGIN EC PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----',
    'PuTTY-User-Key-File-',
  ].some((header) => content.includes(header));
}

async function readPrefix(filePath, length = 4096) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function discoverPrivateKeys(homeDirectory) {
  const sshDirectory = path.join(homeDirectory, '.ssh');
  let entries;
  try {
    entries = await fs.readdir(sshDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return [];
    throw error;
  }

  const candidates = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink())
      && !entry.name.endsWith('.pub')
      && !entry.name.endsWith('-cert.pub')
      && !IGNORED_NAMES.has(entry.name))
    .sort((left, right) => {
      const preference = keyPreference(left.name) - keyPreference(right.name);
      return preference || left.name.localeCompare(right.name);
    });

  const keys = [];
  for (const entry of candidates) {
    const filePath = path.join(sshDirectory, entry.name);
    try {
      const content = await readPrefix(filePath);
      if (!looksLikePrivateKey(content)) continue;
      keys.push({
        name: entry.name,
        path: filePath,
        preferred: PREFERRED_KEY_NAMES.includes(entry.name),
      });
    } catch (error) {
      if (!['EACCES', 'ENOENT', 'EISDIR'].includes(error.code)) throw error;
    }
  }
  return keys;
}

module.exports = {
  PREFERRED_KEY_NAMES,
  discoverPrivateKeys,
  looksLikePrivateKey,
};
