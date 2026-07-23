'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function atomicWriteFile(filePath, contents, options = {}) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle = null;
  try {
    handle = await fs.open(temporaryPath, 'w', options.mode ?? 0o600);
    await handle.writeFile(contents, { encoding: options.encoding || 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    try {
      const directoryHandle = await fs.open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch {
      // Windows may not support directory fsync; the file replacement itself is atomic.
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { atomicWriteFile };
