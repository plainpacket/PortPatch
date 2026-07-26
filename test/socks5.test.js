'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const {
  handleSocks5,
  MAX_NEGOTIATION_BUFFER,
  negotiateSocks5,
  socksErrorCode,
} = require('../src/core/socks5');

class MockSocket extends PassThrough {
  constructor() {
    super();
    this.responses = [];
  }

  write(chunk, ...args) {
    this.responses.push(Buffer.from(chunk));
    return true;
  }

  feed(chunk) {
    return PassThrough.prototype.write.call(this, chunk);
  }
}

test('a domain-name SOCKS5 CONNECT request is parsed', async () => {
  const socket = new MockSocket();
  const pending = negotiateSocks5(socket);
  socket.feed(Buffer.from([0x05, 0x01, 0x00]));
  const hostname = Buffer.from('internal.example');
  socket.feed(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostname.length]),
    hostname,
    Buffer.from([0x01, 0xbb]),
    Buffer.from('GET /'),
  ]));
  const result = await pending;
  assert.equal(result.host, 'internal.example');
  assert.equal(result.port, 443);
  assert.equal(result.leftover.toString(), 'GET /');
  assert.deepEqual(socket.responses[0], Buffer.from([0x05, 0x00]));
});

test('a fragmented IPv4 SOCKS5 CONNECT request is parsed', async () => {
  const socket = new MockSocket();
  const pending = negotiateSocks5(socket);
  socket.feed(Buffer.from([0x05]));
  socket.feed(Buffer.from([0x01, 0x00, 0x05, 0x01]));
  socket.feed(Buffer.from([0x00, 0x01, 10, 0, 0, 4, 0x1f, 0x40]));
  const result = await pending;
  assert.equal(result.host, '10.0.0.4');
  assert.equal(result.port, 8000);
});

test('SOCKS application data received while awaiting the destination is preserved', async () => {
  const socket = new MockSocket();
  const target = new PassThrough();
  const targetChunks = [];
  target.on('data', (chunk) => targetChunks.push(Buffer.from(chunk)));

  let resolveDial;
  let notifyDial;
  const dialStarted = new Promise((resolve) => { notifyDial = resolve; });
  const pending = handleSocks5(socket, () => {
    notifyDial();
    return new Promise((resolve) => { resolveDial = () => resolve(target); });
  });

  socket.feed(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00]),
    Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x40]),
    Buffer.from('pipelined-before-dial'),
  ]));
  await dialStarted;
  socket.feed(Buffer.from('queued-during-dial'));
  resolveDial();
  await pending;

  assert.equal(Buffer.concat(targetChunks).toString(), 'pipelined-before-dial');
  const queued = new Promise((resolve) => socket.once('data', resolve));
  socket.resume();
  assert.equal((await queued).toString(), 'queued-during-dial');
});

test('network errors are mapped to SOCKS5 reply codes', () => {
  assert.equal(socksErrorCode({ code: 'ECONNREFUSED' }), 0x05);
  assert.equal(socksErrorCode({ code: 'ENOTFOUND' }), 0x04);
  assert.equal(socksErrorCode(new Error('unknown')), 0x01);
});

test('an oversized SOCKS handshake is rejected before it can exhaust memory', async () => {
  const socket = new MockSocket();
  const pending = negotiateSocks5(socket);
  socket.feed(Buffer.alloc(MAX_NEGOTIATION_BUFFER + 1, 0x05));
  await assert.rejects(pending, { code: 'SOCKS_HANDSHAKE_TOO_LARGE' });
});
