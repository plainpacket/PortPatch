'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('./atomic-file');

function normalizeRouteIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((routeId) => typeof routeId === 'string').map((routeId) => routeId.trim()).filter(Boolean))];
}

function selectResumableRouteIds(routes, statuses, previouslySavedIds, options = {}) {
  const validIds = new Set((Array.isArray(routes) ? routes : []).map((route) => route?.id).filter(Boolean));
  const previouslySaved = new Set(normalizeRouteIds(previouslySavedIds));
  return Object.values(statuses && typeof statuses === 'object' ? statuses : {})
    .filter((status) => (
      status?.desired
      && validIds.has(status.routeId)
      && (options.includeAllDesired || status.state === 'running' || previouslySaved.has(status.routeId))
    ))
    .map((status) => status.routeId);
}

class RouteIntentStore {
  constructor(userDataPath, logger = () => {}) {
    this.filePath = path.join(userDataPath, 'route-intent.json');
    this.logger = logger;
    this.routeIds = [];
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.routeIds = normalizeRouteIds(parsed?.routeIds);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger('warn', 'The saved route-resume state could not be read; no routes will resume.', { error: error.message });
      }
      this.routeIds = [];
    }
    return this.get();
  }

  get() {
    return [...this.routeIds];
  }

  async replace(routeIds) {
    const normalized = normalizeRouteIds(routeIds);
    return this.update(() => normalized);
  }

  async add(routeId) {
    return this.update((current) => [...current, routeId]);
  }

  async remove(routeId) {
    return this.update((current) => current.filter((savedRouteId) => savedRouteId !== routeId));
  }

  async clearFailClosed() {
    try {
      return await this.replace([]);
    } catch (writeError) {
      try {
        await fs.rm(this.filePath, { force: true });
        this.routeIds = [];
        return [];
      } catch (removeError) {
        throw Object.assign(new Error(`The route-resume state could not be cleared: ${removeError.message}`), {
          code: 'ROUTE_INTENT_CLEAR_FAILED',
          cause: writeError,
        });
      }
    }
  }

  async update(updater) {
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const normalized = normalizeRouteIds(updater(this.get()));
      const serialized = `${JSON.stringify({ version: 1, routeIds: normalized }, null, 2)}\n`;
      await atomicWriteFile(this.filePath, serialized, { encoding: 'utf8', mode: 0o600 });
      this.routeIds = normalized;
    });
    await this.writeChain;
    return this.get();
  }
}

module.exports = {
  normalizeRouteIds,
  RouteIntentStore,
  selectResumableRouteIds,
};
