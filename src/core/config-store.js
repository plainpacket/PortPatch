'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('./atomic-file');
const { createDefaultConfig, normalizeConfig, validateConfig } = require('./model');

class ConfigStore {
  constructor(userDataPath, logger = () => {}) {
    this.filePath = path.join(userDataPath, 'config.json');
    this.logger = logger;
    this.config = createDefaultConfig();
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text);
      const { config, errors } = validateConfig(parsed);
      if (errors.length) {
        this.logger('warn', 'The configuration contains invalid routes; they will remain stopped.', { errors });
      }
      this.config = config;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger('error', 'The configuration file could not be read; defaults will be used.', { error: error.message });
        await this.backupBrokenFile();
      }
      this.config = createDefaultConfig();
    }
    return this.get();
  }

  get() {
    return structuredClone(this.config);
  }

  async save(input) {
    const { config, errors } = validateConfig(input);
    if (errors.length) {
      const error = new Error(errors.join('\n'));
      error.code = 'INVALID_CONFIG';
      error.details = errors;
      throw error;
    }
    const nextConfig = normalizeConfig(config);
    const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      await atomicWriteFile(this.filePath, serialized, { encoding: 'utf8', mode: 0o600 });
    });
    await this.writeChain;
    this.config = nextConfig;
    return this.get();
  }

  async backupBrokenFile() {
    try {
      await fs.copyFile(this.filePath, `${this.filePath}.broken-${Date.now()}`);
    } catch {
      // Leave an unreadable file in place and recover with new settings.
    }
  }
}

module.exports = { ConfigStore };
