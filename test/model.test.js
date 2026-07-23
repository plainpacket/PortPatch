'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDefaultConfig,
  canonicalHost,
  describeRoute,
  isLoopbackBind,
  normalizeConfig,
  validateConfig,
} = require('../src/core/model');

test('a new configuration has a local node and safe defaults', () => {
  const config = createDefaultConfig();
  assert.equal(config.localNode.id, 'local');
  assert.equal(config.settings.closeToTray, true);
  assert.deepEqual(config.servers, []);
});

test('a remote node rejects duplicate ports even with different bind addresses', () => {
  const config = createDefaultConfig();
  config.servers = [{ id: 'remote', name: 'Remote', host: 'remote', port: 22, username: 'dev', authMode: 'agent' }];
  config.routes = [
    {
      id: 'one', name: 'First remote route', protocol: 'tcp',
      source: { nodeId: 'remote', bindHost: '127.0.0.1', port: 9000 },
      target: { nodeId: 'local', host: '127.0.0.1', port: 9001 },
    },
    {
      id: 'two', name: 'Second remote route', protocol: 'tcp',
      source: { nodeId: 'remote', bindHost: '::1', port: 9000 },
      target: { nodeId: 'local', host: '127.0.0.1', port: 9002 },
    },
  ];
  assert.ok(validateConfig(config).errors.some((message) => message.includes('already uses')));
});

test('an external-interface listener requires explicit consent', () => {
  const config = createDefaultConfig();
  const route = {
    id: 'external', name: 'External SOCKS', protocol: 'socks5',
    source: { nodeId: 'local', bindHost: '192.168.10.5', port: 1080 },
    target: { nodeId: 'local', host: '127.0.0.1', port: 0 },
  };
  config.routes = [route];
  assert.ok(validateConfig(config).errors.some((message) => message.includes('explicit consent')));
  route.allowExternal = true;
  assert.ok(!validateConfig(config).errors.some((message) => message.includes('explicit consent')));
  assert.equal(isLoopbackBind('127.3.2.1'), true);
  assert.equal(isLoopbackBind('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoopbackBind('::'), false);

  config.servers = [{ id: 'remote', name: 'Remote', host: 'remote', port: 22, username: 'dev', authMode: 'agent' }];
  config.routes = [{
    id: 'remote-listen', name: 'Remote loopback listener', protocol: 'tcp',
    source: { nodeId: 'remote', bindHost: '127.0.0.1', port: 18000 },
    target: { nodeId: 'local', host: '127.0.0.1', port: 8000 },
  }];
  assert.ok(validateConfig(config).errors.some((message) => message.includes('explicit consent')));
  config.routes[0].allowExternal = true;
  assert.ok(!validateConfig(config).errors.some((message) => message.includes('explicit consent')));
});

test('wildcard listeners reject overlapping duplicate ports and self-loops', () => {
  const duplicateConfig = createDefaultConfig();
  duplicateConfig.routes = [
    {
      id: 'wildcard', name: 'Wildcard listener', protocol: 'tcp', allowExternal: true,
      source: { nodeId: 'local', bindHost: '0.0.0.0', port: 9100 },
      target: { nodeId: 'local', host: '127.0.0.1', port: 9200 },
    },
    {
      id: 'specific', name: 'Specific listener', protocol: 'tcp',
      source: { nodeId: 'local', bindHost: '127.0.0.1', port: 9100 },
      target: { nodeId: 'local', host: '127.0.0.1', port: 9201 },
    },
  ];
  assert.ok(validateConfig(duplicateConfig).errors.some((message) => message.includes('already uses')));

  const loopConfig = createDefaultConfig();
  loopConfig.routes = [{
    id: 'loop', name: 'Wildcard loop', protocol: 'tcp', allowExternal: true,
    source: { nodeId: 'local', bindHost: '0.0.0.0', port: 9300 },
    target: { nodeId: 'local', host: '127.0.0.1', port: 9300 },
  }];
  assert.ok(validateConfig(loopConfig).errors.some((message) => message.includes('infinite loop')));

  loopConfig.routes = [{
    id: 'ipv6-loop', name: 'IPv6 alias loop', protocol: 'tcp',
    source: { nodeId: 'local', bindHost: '::1', port: 9301 },
    target: { nodeId: 'local', host: '0:0:0:0:0:0:0:1', port: 9301 },
  }];
  assert.ok(validateConfig(loopConfig).errors.some((message) => message.includes('infinite loop')));

  loopConfig.servers = [{
    id: 'remote', name: 'Remote server', host: 'remote', port: 22, username: 'dev', authMode: 'agent',
  }];
  loopConfig.routes = [{
    id: 'remote-loop', name: 'GatewayPorts remote loop', protocol: 'tcp', allowExternal: true,
    source: { nodeId: 'remote', bindHost: '127.0.0.1', port: 9302 },
    target: { nodeId: 'remote', host: '10.0.0.8', port: 9302 },
  }];
  assert.ok(validateConfig(loopConfig).errors.some((message) => message.includes('infinite loop')));

  assert.equal(
    canonicalHost('::ffff:127.0.0.1'),
    canonicalHost('0:0:0:0:0:ffff:7f00:1'),
  );
});

test('a TCP route rejects a duplicate listener port', () => {
  const config = createDefaultConfig();
  config.routes = [
    {
      id: 'one', name: 'First route', protocol: 'tcp',
      source: { nodeId: 'local', bindHost: '127.0.0.1', port: 9000 },
      target: { nodeId: 'local', host: '127.0.0.1', port: 9001 },
    },
    {
      id: 'two', name: 'Second route', protocol: 'tcp',
      source: { nodeId: 'local', bindHost: '127.0.0.1', port: 9000 },
      target: { nodeId: 'local', host: '127.0.0.1', port: 9002 },
    },
  ];
  const result = validateConfig(config);
  assert.ok(result.errors.some((message) => message.includes('already uses')));
});

test('a route is described as a user-facing listen-to-destination sentence', () => {
  const config = normalizeConfig({
    servers: [{ id: 'gpu', name: 'GPU Server', host: 'gpu', username: 'me', authMode: 'agent' }],
  });
  const text = describeRoute(config, {
    id: 'llm', name: 'LLM', protocol: 'tcp',
    source: { nodeId: 'local', bindHost: '127.0.0.1', port: 18000 },
    target: { nodeId: 'gpu', host: '127.0.0.1', port: 8000 },
  });
  assert.equal(text, 'My Computer 127.0.0.1:18000 -> GPU Server 127.0.0.1:8000');
});
