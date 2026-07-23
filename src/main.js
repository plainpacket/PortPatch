'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  Tray,
} = require('electron');
const { ConfigStore } = require('./core/config-store');
const { SecretStore } = require('./core/secret-store');
const {
  ConnectionManager,
  probeServerHostKey,
  serverSignature,
  testServerConnection,
} = require('./core/connection-manager');
const { RelayEngine } = require('./core/relay-engine');
const { routeSignature, validateConfig } = require('./core/model');
const { shouldValidateCredentialUpdate, validateCredentialUpdate } = require('./core/credential-policy');
const { discoverPrivateKeys } = require('./core/ssh-key-discovery');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow = null;
let tray = null;
let configStore = null;
let secretStore = null;
let connections = null;
let relayEngine = null;
let quitting = false;
let shutdownStarted = false;
let trayHintShown = false;
const logs = [];
let configSaveChain = Promise.resolve();

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return details;
  const copy = { ...details };
  for (const key of ['password', 'passphrase', 'privateKey']) delete copy[key];
  return copy;
}

function log(level, message, details = undefined) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level,
    message,
    details: sanitizeDetails(details),
  };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:log', entry);
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code,
    details: error?.details,
  };
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return { ok: true, value: await callback(payload, event) };
    } catch (error) {
      log('error', `${channel} request failed`, { error: error.message, code: error.code });
      return { ok: false, error: serializeError(error) };
    }
  });
}

function iconImage(forTray = false) {
  const filename = forTray ? 'tray.png' : 'icon.png';
  try {
    const image = nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, '..', 'assets', filename)));
    return image.isEmpty() ? undefined : image;
  } catch {
    return undefined;
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTray() {
  if (!tray || !relayEngine) return;
  const statuses = Object.values(relayEngine.statuses());
  const active = statuses.filter((status) => status.desired).length;
  const connected = statuses.reduce((sum, status) => sum + status.activeConnections, 0);
  tray.setToolTip(`PortPatch - ${active} active routes - ${connected} connections`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PortPatch', click: showMainWindow },
    { type: 'separator' },
    {
      label: `Start all routes (${statuses.length})`,
      enabled: statuses.length > 0,
      click: async () => {
        try {
          await configSaveChain.catch(() => {});
          ensureStoredConfigIsValid();
          await relayEngine.startAll();
        } catch (error) {
          log('error', 'Failed to start all routes', { error: error.message });
          dialog.showErrorBox('Could not start routes', error.message);
        }
      },
    },
    { label: 'Stop all routes', enabled: active > 0, click: () => relayEngine.stopAll() },
    { type: 'separator' },
    { label: 'Quit PortPatch', click: () => app.quit() },
  ]));
}

function createTray() {
  const image = iconImage(true);
  tray = new Tray(image || nativeImage.createEmpty());
  tray.on('double-click', showMainWindow);
  updateTray();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0a101d', symbolColor: '#aab6ca', height: 64 },
    } : {}),
    backgroundColor: '#0b1020',
    icon: iconImage(),
    title: 'PortPatch',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) showMainWindow();
  });
  mainWindow.on('close', (event) => {
    const closeToTray = configStore?.get().settings.closeToTray !== false;
    if (!quitting && closeToTray) {
      event.preventDefault();
      mainWindow.hide();
      if (!trayHintShown && process.platform === 'win32' && tray?.displayBalloon) {
        trayHintShown = true;
        tray.displayBalloon({
          title: 'PortPatch is still running',
          content: 'Port routes remain active in the system tray. Use the tray menu to quit completely.',
        });
      }
    } else if (!quitting) {
      app.quit();
    }
  });
}

function applyLoginSetting(settings) {
  if (!['win32', 'darwin'].includes(process.platform)) return;
  const executablePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({
    openAtLogin: Boolean(settings.startWithSystem),
    path: executablePath,
    args: settings.launchHidden ? ['--hidden'] : [],
  });
}

function invalidConfigError(errors) {
  const error = new Error(errors.join('\n'));
  error.code = 'INVALID_CONFIG';
  error.details = errors;
  return error;
}

function ensureStoredConfigIsValid() {
  const { errors } = validateConfig(configStore.get());
  if (errors.length) throw invalidConfigError(errors);
}

function secretBindings(config) {
  return Object.fromEntries(config.servers.map((server) => [server.id, serverSignature(server)]));
}

function secretMetadata(config) {
  return secretStore.metadata(config.servers.map((server) => ({
    id: server.id,
    binding: serverSignature(server),
  })));
}

function secretFieldsForServer(server) {
  if (server.authMode === 'password') return ['password'];
  if (server.authMode === 'key') return ['passphrase'];
  return [];
}

async function saveConfigTransaction(payload = {}) {
  const previous = configStore.get();
  const { config: candidate, errors } = validateConfig(payload.config);
  if (errors.length) throw invalidConfigError(errors);

  const secretUpdates = payload.secretUpdates && typeof payload.secretUpdates === 'object'
    ? payload.secretUpdates
    : {};
  const nextServerIds = new Set(candidate.servers.map((server) => server.id));
  for (const serverId of Object.keys(secretUpdates)) {
    if (!nextServerIds.has(serverId)) throw new Error(`Cannot find the server for this secret update: ${serverId}`);
  }

  const previousServers = new Map(previous.servers.map((server) => [server.id, server]));
  const nextServers = new Map(candidate.servers.map((server) => [server.id, server]));
  const previousSecretMetadata = secretMetadata(previous);
  const removedServerIds = previous.servers
    .filter((server) => !nextServers.has(server.id))
    .map((server) => server.id);
  const changedServerIds = new Set([...removedServerIds, ...Object.keys(secretUpdates)]);
  for (const [serverId, server] of nextServers) {
    const old = previousServers.get(serverId);
    const signatureChanged = Boolean(old && serverSignature(old) !== serverSignature(server));
    const hasSecretUpdate = Object.prototype.hasOwnProperty.call(secretUpdates, serverId);
    if (!old || signatureChanged) changedServerIds.add(serverId);
    if (shouldValidateCredentialUpdate({ existed: Boolean(old), signatureChanged, hasSecretUpdate })) {
      const credentialError = validateCredentialUpdate({
        server,
        existed: Boolean(old),
        signatureChanged,
        metadata: previousSecretMetadata[serverId],
        update: secretUpdates[serverId],
      });
      if (credentialError) {
        throw Object.assign(new Error(credentialError), { code: 'INVALID_CREDENTIAL_UPDATE' });
      }
    }
  }

  const nextRoutes = new Map(candidate.routes.map((route) => [route.id, route]));
  const affectedRouteIds = new Set();
  for (const oldRoute of previous.routes) {
    const nextRoute = nextRoutes.get(oldRoute.id);
    const touchesChangedServer = [oldRoute.source.nodeId, oldRoute.target.nodeId].some((nodeId) => changedServerIds.has(nodeId));
    if (!nextRoute || routeSignature(oldRoute) !== routeSignature(nextRoute) || touchesChangedServer) {
      affectedRouteIds.add(oldRoute.id);
    }
  }
  const desiredBefore = new Set(Object.values(relayEngine.statuses())
    .filter((status) => status.desired)
    .map((status) => status.routeId));

  for (const routeId of affectedRouteIds) await relayEngine.stop(routeId);

  const secretSnapshot = secretStore.snapshot();
  const hasSecretChanges = removedServerIds.length > 0 || Object.keys(secretUpdates).length > 0;
  let secretsApplied = false;
  let next;
  try {
    if (hasSecretChanges) {
      await secretStore.applyChanges(secretUpdates, removedServerIds, secretBindings(candidate));
      secretsApplied = true;
    }
    next = await configStore.save(candidate);
  } catch (error) {
    let rollbackError = null;
    if (secretsApplied) {
      try { await secretStore.restore(secretSnapshot); } catch (failure) { rollbackError = failure; }
    }
    try { await configStore.save(previous); } catch (failure) { rollbackError ||= failure; }
    for (const serverId of changedServerIds) connections.invalidate(serverId);
    if (!rollbackError) {
      for (const routeId of desiredBefore) {
        if (affectedRouteIds.has(routeId) && previous.routes.some((route) => route.id === routeId)) {
          await relayEngine.start(routeId).catch(() => {});
        }
      }
    }
    if (rollbackError) {
      error.message = `${error.message}\nRestoring the previous configuration also failed: ${rollbackError.message}`;
      error.code ||= 'CONFIG_ROLLBACK_FAILED';
    }
    throw error;
  }

  for (const serverId of changedServerIds) connections.invalidate(serverId);
  await relayEngine.syncConfig(previous, next);
  for (const routeId of desiredBefore) {
    if (affectedRouteIds.has(routeId) && nextRoutes.has(routeId)) await relayEngine.start(routeId).catch(() => {});
  }
  applyLoginSetting(next.settings);
  updateTray();
  return {
    config: next,
    secrets: secretMetadata(next),
  };
}

function registerIpc() {
  handle('state:get', async () => {
    const config = configStore.get();
    return {
      config,
      secrets: secretMetadata(config),
      encryption: await secretStore.encryptionStatus(),
      statuses: relayEngine.statuses(),
      logs,
      platform: process.platform,
      version: app.getVersion(),
    };
  });

  handle('config:save', (payload = {}) => {
    const operation = configSaveChain.catch(() => {}).then(() => saveConfigTransaction(payload));
    configSaveChain = operation.catch(() => {});
    return operation;
  });

  handle('dialog:select-key', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select an SSH private key',
      properties: ['openFile'],
      filters: [{ name: 'SSH private keys', extensions: ['pem', 'key', 'ppk', '*'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('ssh-keys:list', () => discoverPrivateKeys(app.getPath('home')));

  handle('server:probe-key', async ({ server } = {}) => {
    if (!server?.host) throw new Error('A server address is required.');
    return probeServerHostKey(server);
  });

  handle('server:test', async ({ server, credentialDraft } = {}) => {
    if (!server?.id) throw new Error('Server details are required.');
    if (!server.hostFingerprint) {
      throw Object.assign(new Error('Verify the server host key before authentication.'), { code: 'UNTRUSTED_HOST' });
    }
    const secret = await secretStore.get(
      server.id,
      credentialDraft || {},
      serverSignature(server),
      secretFieldsForServer(server),
    );
    const result = await testServerConnection(server, secret);
    log(result.ok ? 'info' : 'error', `${server.name || server.host} connection test: ${result.message}`, {
      serverId: server.id,
      fingerprint: result.fingerprint,
    });
    return result;
  });

  handle('route:start', async ({ routeId }) => {
    await configSaveChain.catch(() => {});
    ensureStoredConfigIsValid();
    return relayEngine.start(routeId);
  });
  handle('route:stop', async ({ routeId }) => relayEngine.stop(routeId));
  handle('route:start-all', async () => {
    await configSaveChain.catch(() => {});
    ensureStoredConfigIsValid();
    return relayEngine.startAll();
  });
  handle('route:stop-all', async () => relayEngine.stopAll());
  handle('window:show', async () => showMainWindow());
  handle('app:quit', async () => app.quit());
}

async function initialize() {
  configStore = new ConfigStore(app.getPath('userData'), log);
  await configStore.load();
  secretStore = new SecretStore(app.getPath('userData'), safeStorage, log);
  await secretStore.load();
  connections = new ConnectionManager(
    () => configStore.get(),
    (serverId) => {
      const server = configStore.get().servers.find((item) => item.id === serverId);
      if (!server) throw new Error(`Server not found: ${serverId}`);
      return secretStore.get(serverId, {}, serverSignature(server), secretFieldsForServer(server));
    },
    log,
  );
  relayEngine = new RelayEngine(
    () => configStore.get(),
    connections,
    log,
    (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('route:status', status);
      updateTray();
    },
  );
  applyLoginSetting(configStore.get().settings);
  createTray();
  createWindow();
  registerIpc();
  setTimeout(() => relayEngine.startAutoRoutes(), 300);
}

if (gotLock) {
  app.on('second-instance', () => showMainWindow());
  app.whenReady().then(initialize).catch((error) => {
    dialog.showErrorBox('PortPatch startup error', error.message);
    app.exit(1);
  });
  app.on('activate', showMainWindow);
  app.on('window-all-closed', () => {
    // Keep the tray application running until the user explicitly quits.
  });
  app.on('before-quit', (event) => {
    quitting = true;
    if (!shutdownStarted && relayEngine) {
      event.preventDefault();
      shutdownStarted = true;
      relayEngine.shutdown().finally(() => app.quit());
    }
  });
}
