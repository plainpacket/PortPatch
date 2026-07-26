'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizeRouteIds, RouteIntentStore, selectResumableRouteIds } = require('../src/core/route-intent-store');

test('route resume IDs are trimmed, deduplicated, and limited to strings', () => {
  assert.deepEqual(normalizeRouteIds([' first ', '', 'first', null, 3, 'second']), ['first', 'second']);
  assert.deepEqual(normalizeRouteIds(null), []);
});

test('only running or previously saved desired routes are selected', () => {
  const routes = [{ id: 'running' }, { id: 'starting' }, { id: 'reconnecting' }, { id: 'stopped' }];
  const statuses = {
    running: { routeId: 'running', desired: true, state: 'running' },
    starting: { routeId: 'starting', desired: true, state: 'starting' },
    reconnecting: { routeId: 'reconnecting', desired: true, state: 'reconnecting' },
    stopped: { routeId: 'stopped', desired: false, state: 'idle' },
    deleted: { routeId: 'deleted', desired: true, state: 'running' },
  };

  assert.deepEqual(selectResumableRouteIds(routes, statuses, ['reconnecting']), ['running', 'reconnecting']);
  assert.deepEqual(
    selectResumableRouteIds(routes, statuses, [], { includeAllDesired: true }),
    ['running', 'starting', 'reconnecting'],
  );
});

test('route resume intent is persisted separately from user configuration', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-route-intent-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new RouteIntentStore(directory);
  assert.deepEqual(await store.load(), []);
  assert.deepEqual(await store.replace(['route-a', 'route-b', 'route-a']), ['route-a', 'route-b']);

  const reloaded = new RouteIntentStore(directory);
  assert.deepEqual(await reloaded.load(), ['route-a', 'route-b']);
  assert.deepEqual(await reloaded.add('route-c'), ['route-a', 'route-b', 'route-c']);
  const parsed = JSON.parse(await fs.readFile(path.join(directory, 'route-intent.json'), 'utf8'));
  assert.deepEqual(parsed, { version: 1, routeIds: ['route-a', 'route-b', 'route-c'] });
});

test('concurrent route removals cannot restore an ID removed by another operation', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-route-intent-concurrent-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RouteIntentStore(directory);
  await store.replace(['route-a', 'route-b', 'route-c']);

  await Promise.all([store.remove('route-a'), store.remove('route-b')]);
  assert.deepEqual(store.get(), ['route-c']);
});

test('clearing route intent removes every saved route', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-route-intent-clear-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RouteIntentStore(directory);
  await store.replace(['route-a', 'route-b']);

  assert.deepEqual(await store.clearFailClosed(), []);
  const parsed = JSON.parse(await fs.readFile(path.join(directory, 'route-intent.json'), 'utf8'));
  assert.deepEqual(parsed, { version: 1, routeIds: [] });
});

test('an unreadable route resume state fails closed', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-route-intent-broken-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'route-intent.json'), '{broken');
  const logs = [];
  const store = new RouteIntentStore(directory, (level, message) => logs.push({ level, message }));

  assert.deepEqual(await store.load(), []);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].message, /no routes will resume/i);
});
