'use strict';

const { isIP } = require('node:net');

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffers = [];
    this.length = 0;
    this.pending = [];
    this.closedError = null;
    this.onData = (chunk) => {
      this.buffers.push(chunk);
      this.length += chunk.length;
      this.flush();
    };
    this.onError = (error) => this.fail(error);
    this.onClose = () => this.fail(new Error('The SOCKS client disconnected.'));
    socket.on('data', this.onData);
    socket.once('error', this.onError);
    socket.once('close', this.onClose);
  }

  read(size) {
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.length >= size) return Promise.resolve(this.take(size));
    return new Promise((resolve, reject) => this.pending.push({ size, resolve, reject }));
  }

  take(size) {
    const result = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.buffers[0];
      const count = Math.min(chunk.length, size - offset);
      chunk.copy(result, offset, 0, count);
      offset += count;
      if (count === chunk.length) this.buffers.shift();
      else this.buffers[0] = chunk.subarray(count);
      this.length -= count;
    }
    return result;
  }

  flush() {
    while (this.pending.length && this.length >= this.pending[0].size) {
      const request = this.pending.shift();
      request.resolve(this.take(request.size));
    }
  }

  fail(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const request of this.pending.splice(0)) request.reject(error);
  }

  detach() {
    // Keep bytes that arrive while the destination is being dialed in the
    // socket's readable buffer. A flowing socket would otherwise discard them
    // after this temporary protocol reader is removed.
    this.socket.pause();
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    const leftover = this.length ? this.take(this.length) : Buffer.alloc(0);
    this.pending.length = 0;
    return leftover;
  }
}

function parseIPv6(buffer) {
  const groups = [];
  for (let index = 0; index < 16; index += 2) groups.push(buffer.readUInt16BE(index).toString(16));
  return groups.join(':');
}

function successReply() {
  return Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function failureReply(code = 0x01) {
  return Buffer.from([0x05, code, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function socksErrorCode(error) {
  if (error?.code === 'ECONNREFUSED') return 0x05;
  if (error?.code === 'ENETUNREACH') return 0x03;
  if (error?.code === 'EHOSTUNREACH' || error?.code === 'ENOTFOUND') return 0x04;
  if (error?.code === 'ETIMEDOUT') return 0x06;
  return 0x01;
}

async function negotiateSocks5(socket) {
  const reader = new SocketReader(socket);
  try {
    const greeting = await reader.read(2);
    if (greeting[0] !== 0x05) throw Object.assign(new Error('Only SOCKS5 is supported.'), { replyCode: 0x01 });
    const methods = await reader.read(greeting[1]);
    if (!methods.includes(0x00)) {
      socket.write(Buffer.from([0x05, 0xff]));
      throw Object.assign(new Error('Only unauthenticated SOCKS5 is supported.'), { alreadyReplied: true });
    }
    socket.write(Buffer.from([0x05, 0x00]));

    const request = await reader.read(4);
    if (request[0] !== 0x05) throw Object.assign(new Error('Invalid SOCKS version.'), { replyCode: 0x01 });
    if (request[1] !== 0x01) throw Object.assign(new Error('Only the SOCKS CONNECT command is supported.'), { replyCode: 0x07 });

    let host;
    if (request[3] === 0x01) {
      host = [...await reader.read(4)].join('.');
    } else if (request[3] === 0x03) {
      const size = (await reader.read(1))[0];
      host = (await reader.read(size)).toString('utf8');
    } else if (request[3] === 0x04) {
      host = parseIPv6(await reader.read(16));
    } else {
      throw Object.assign(new Error('Unsupported SOCKS address type.'), { replyCode: 0x08 });
    }
    const port = (await reader.read(2)).readUInt16BE(0);
    if (!host || !port || (!isIP(host) && host.length > 253)) {
      throw Object.assign(new Error('Invalid SOCKS destination address.'), { replyCode: 0x08 });
    }
    const leftover = reader.detach();
    return { host, port, leftover };
  } catch (error) {
    reader.detach();
    throw error;
  }
}

async function handleSocks5(socket, dial) {
  let request;
  try {
    request = await negotiateSocks5(socket);
  } catch (error) {
    if (!error.alreadyReplied && !socket.destroyed) socket.end(failureReply(error.replyCode || 0x01));
    else if (!socket.destroyed) socket.end();
    throw error;
  }

  let target;
  try {
    target = await dial(request.host, request.port);
  } catch (error) {
    if (!socket.destroyed) socket.end(failureReply(socksErrorCode(error)));
    throw error;
  }

  socket.write(successReply());
  if (request.leftover.length) target.write(request.leftover);
  return { target, destination: { host: request.host, port: request.port } };
}

module.exports = {
  SocketReader,
  failureReply,
  handleSocks5,
  negotiateSocks5,
  socksErrorCode,
  successReply,
};
