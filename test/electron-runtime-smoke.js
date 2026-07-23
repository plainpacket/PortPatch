'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, nativeImage, safeStorage, Tray } = require('electron');
const { SecretStore } = require('../src/core/secret-store');

const resultPath = path.resolve(process.argv[2] || path.join(process.cwd(), 'electron-runtime-smoke.json'));

async function run() {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-electron-'));
  try {
    const store = new SecretStore(tempDirectory, safeStorage);
    await store.load();
    const encryption = await store.encryptionStatus();
    if (!encryption.available) throw new Error('Electron safeStorage is unavailable.');
    const binding = 'electron-runtime-smoke-binding';
    await store.update('server-test', { password: 'temporary-test-secret', passphrase: 'temporary-passphrase' }, binding);
    const decrypted = await store.get('server-test', {}, binding);
    if (decrypted.password !== 'temporary-test-secret' || decrypted.passphrase !== 'temporary-passphrase') {
      throw new Error('The secure-storage encryption round trip failed.');
    }

    const icon = nativeImage.createFromBuffer(fsSync.readFileSync(path.join(__dirname, '..', 'assets', 'tray.png')));
    if (icon.isEmpty()) throw new Error('The tray PNG icon could not be loaded.');
    const tray = new Tray(icon);
    tray.setToolTip('PortPatch runtime smoke test');
    tray.destroy();

    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.writeFile(resultPath, JSON.stringify({ ok: true, encryption, iconSize: icon.getSize() }, null, 2));
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

app.whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch(async (error) => {
    await fs.mkdir(path.dirname(resultPath), { recursive: true }).catch(() => {});
    await fs.writeFile(resultPath, JSON.stringify({ ok: false, error: error.stack || error.message }, null, 2)).catch(() => {});
    app.exit(1);
  });
