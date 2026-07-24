'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const UI_SCALE_BASELINE = 1.1;

async function invoke(channel, payload) {
  const response = await ipcRenderer.invoke(channel, payload);
  if (!response?.ok) {
    const error = new Error(response?.error?.message || 'The request could not be processed.');
    error.code = response?.error?.code;
    error.details = response?.error?.details;
    throw error;
  }
  return response.value;
}

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('sshRouter', Object.freeze({
  getState: () => invoke('state:get'),
  getUiScale: () => Math.round((webFrame.getZoomFactor() / UI_SCALE_BASELINE) * 100),
  setUiScale: (scale) => webFrame.setZoomFactor((Number(scale) / 100) * UI_SCALE_BASELINE),
  setWindowTheme: (theme) => invoke('window:set-theme', { theme }),
  saveConfig: (payload) => invoke('config:save', payload),
  selectKeyFile: () => invoke('dialog:select-key'),
  listPrivateKeys: () => invoke('ssh-keys:list'),
  probeServerKey: (server) => invoke('server:probe-key', { server }),
  testServer: (server, credentialDraft) => invoke('server:test', { server, credentialDraft }),
  startRoute: (routeId) => invoke('route:start', { routeId }),
  stopRoute: (routeId) => invoke('route:stop', { routeId }),
  startAll: () => invoke('route:start-all'),
  stopAll: () => invoke('route:stop-all'),
  showWindow: () => invoke('window:show'),
  quit: () => invoke('app:quit'),
  onRouteStatus: (callback) => subscribe('route:status', callback),
  onLog: (callback) => subscribe('app:log', callback),
}));
