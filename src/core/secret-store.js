'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('./atomic-file');

class SecretStore {
  constructor(userDataPath, safeStorage, logger = () => {}) {
    this.filePath = path.join(userDataPath, 'secrets.json');
    this.safeStorage = safeStorage;
    this.logger = logger;
    this.data = { version: 1, servers: {} };
  }

  async load() {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed?.version === 1 && parsed?.servers && typeof parsed.servers === 'object') this.data = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger('error', 'The credential store could not be read.', { error: error.message });
    }
  }

  async encryptionStatus() {
    const asyncAvailable = await this.asyncEncryptionAvailable();
    const syncAvailable = typeof this.safeStorage.isEncryptionAvailable === 'function'
      ? this.safeStorage.isEncryptionAvailable()
      : false;
    const backend = process.platform === 'linux' && typeof this.safeStorage.getSelectedStorageBackend === 'function'
      ? this.safeStorage.getSelectedStorageBackend()
      : process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'unknown';
    return {
      available: Boolean(asyncAvailable || syncAvailable),
      backend,
      warning: backend === 'basic_text'
        ? 'No Linux secure-storage backend was found. Secrets are not strongly protected.'
        : null,
    };
  }

  metadata(serverEntries = []) {
    const result = {};
    for (const entry of serverEntries) {
      const id = typeof entry === 'string' ? entry : entry.id;
      const expectedBinding = typeof entry === 'string' ? '' : entry.binding;
      const record = this.data.servers[id];
      const bindingMatches = Boolean(expectedBinding && record?.binding === expectedBinding);
      result[id] = {
        hasPassword: Boolean(bindingMatches && record?.password),
        hasPassphrase: Boolean(bindingMatches && record?.passphrase),
      };
    }
    return result;
  }

  async update(serverId, updates = {}, binding = '') {
    if (!serverId) throw new Error('A server ID is required.');
    await this.applyChanges({ [serverId]: updates }, [], { [serverId]: binding });
  }

  async remove(serverId) {
    if (this.data.servers[serverId]) await this.applyChanges({}, [serverId]);
  }

  snapshot() {
    return structuredClone(this.data);
  }

  async applyChanges(updatesByServer = {}, removeServerIds = [], bindingsByServer = {}) {
    const next = this.snapshot();
    for (const serverId of removeServerIds) delete next.servers[serverId];
    for (const [serverId, updates] of Object.entries(updatesByServer || {})) {
      if (!serverId) throw new Error('A server ID is required.');
      const current = { ...(next.servers[serverId] || {}) };
      let wroteSecret = false;
      for (const field of ['password', 'passphrase']) {
        if (updates?.[`clear${field[0].toUpperCase()}${field.slice(1)}`]) {
          delete current[field];
        } else if (typeof updates?.[field] === 'string' && updates[field].length) {
          current[field] = await this.encrypt(updates[field]);
          wroteSecret = true;
        }
      }
      if (wroteSecret) {
        const binding = bindingsByServer[serverId];
        if (!binding) throw new Error(`The secret has no server binding: ${serverId}`);
        current.binding = binding;
      }
      if (current.password || current.passphrase) next.servers[serverId] = current;
      else delete next.servers[serverId];
    }
    await this.persistData(next);
    this.data = next;
  }

  async restore(snapshot) {
    const next = structuredClone(snapshot);
    await this.persistData(next);
    this.data = next;
  }

  async get(serverId, draft = {}, expectedBinding = '', fields = ['password', 'passphrase']) {
    const encrypted = this.data.servers[serverId] || {};
    const bindingMatches = Boolean(expectedBinding && encrypted.binding === expectedBinding);
    const result = {};
    for (const field of fields) {
      if (!['password', 'passphrase'].includes(field)) continue;
      const clearField = `clear${field[0].toUpperCase()}${field.slice(1)}`;
      if (draft[clearField] === true) continue;
      if (typeof draft[field] === 'string' && draft[field].length) result[field] = draft[field];
      else if (encrypted[field]) {
        if (!bindingMatches) {
          throw Object.assign(new Error('The stored credentials do not match the current server address or host key. Enter the credentials again.'), {
            code: 'SECRET_BINDING_MISMATCH',
          });
        }
        result[field] = await this.decrypt(encrypted[field]);
      }
    }
    return result;
  }

  async encrypt(value) {
    if (typeof this.safeStorage.encryptStringAsync === 'function' && await this.asyncEncryptionAvailable()) {
      const result = await this.safeStorage.encryptStringAsync(value);
      const buffer = Buffer.isBuffer(result) ? result : result?.encrypted;
      if (!Buffer.isBuffer(buffer)) throw new Error('The operating-system encryption result is invalid.');
      return Buffer.from(buffer).toString('base64');
    }
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Operating-system encryption is unavailable.');
    return this.safeStorage.encryptString(value).toString('base64');
  }

  async decrypt(encoded) {
    const buffer = Buffer.from(encoded, 'base64');
    if (typeof this.safeStorage.decryptStringAsync === 'function' && await this.asyncEncryptionAvailable()) {
      const result = await this.safeStorage.decryptStringAsync(buffer);
      const decrypted = typeof result === 'string'
        ? result
        : result?.result ?? result?.decryptedString;
      if (typeof decrypted !== 'string') throw new Error('The operating-system decryption result is invalid.');
      return decrypted;
    }
    return this.safeStorage.decryptString(buffer);
  }

  async asyncEncryptionAvailable() {
    if (typeof this.safeStorage.isAsyncEncryptionAvailable !== 'function') return false;
    try {
      return Boolean(await this.safeStorage.isAsyncEncryptionAvailable());
    } catch (error) {
      this.logger('warn', 'Asynchronous operating-system encryption could not be initialized.', { error: error.message });
      return false;
    }
  }

  async persist() {
    await this.persistData(this.data);
  }

  async persistData(data) {
    await atomicWriteFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

module.exports = { SecretStore };
