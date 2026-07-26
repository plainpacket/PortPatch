'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const outputDirectory = path.resolve(process.argv[2] || path.join(process.cwd(), 'visual-test-output'));

const demoConfig = {
  version: 1,
  settings: { closeToTray: true, startWithSystem: false, launchHidden: false, uiScale: 100, uiScaleVersion: 2, theme: 'dark' },
  localNode: { id: 'local', name: 'Development Laptop', position: { x: 100, y: 260 } },
  servers: [
    { id: 'gpu', name: 'GPU Server', host: '10.10.0.21', port: 22, username: 'ubuntu', authMode: 'agent', keyPath: '', hostFingerprint: 'demo', position: { x: 500, y: 120 } },
    { id: 'private', name: 'Private Network Gateway', host: 'bastion.internal', port: 22, username: 'dev', authMode: 'password', keyPath: '', hostFingerprint: 'demo', position: { x: 500, y: 410 } },
    { id: 'lab', name: 'Offline Research Server', host: '172.16.20.8', port: 2222, username: 'research', authMode: 'agent', keyPath: '', hostFingerprint: 'demo', position: { x: 900, y: 260 } },
  ],
  routes: [
    { id: 'llm', name: 'GPU LLM API', protocol: 'tcp', source: { nodeId: 'local', bindHost: '127.0.0.1', port: 18000 }, target: { nodeId: 'gpu', host: '127.0.0.1', port: 8000 }, reconnect: true },
    { id: 'intranet', name: 'Private Site Proxy', protocol: 'socks5', source: { nodeId: 'local', bindHost: '127.0.0.1', port: 1080 }, target: { nodeId: 'private', host: '127.0.0.1', port: 0 }, reconnect: true },
    { id: 'internet', name: 'Research Server Internet Egress', protocol: 'socks5', source: { nodeId: 'lab', bindHost: '127.0.0.1', port: 1080 }, target: { nodeId: 'local', host: '127.0.0.1', port: 0 }, reconnect: true },
  ],
};

const demoStatuses = {
  llm: { routeId: 'llm', state: 'running', desired: true, activeConnections: 2, bytesUp: 245760, bytesDown: 1572864, lastError: null },
  intranet: { routeId: 'intranet', state: 'idle', desired: false, activeConnections: 0, bytesUp: 0, bytesDown: 0, lastError: null },
  internet: { routeId: 'internet', state: 'reconnecting', desired: true, activeConnections: 0, bytesUp: 8192, bytesDown: 16384, retryInMs: 4000, lastError: 'The SSH connection was interrupted.' },
};

let configSaveCount = 0;

function response(value) {
  return { ok: true, value };
}

function registerMockIpc() {
  ipcMain.handle('state:get', () => response({
    config: demoConfig,
    secrets: { gpu: {}, private: { hasPassword: true, hasPassphrase: false }, lab: {} },
    encryption: { available: true, backend: 'dpapi', warning: null },
    statuses: demoStatuses,
    logs: [
      { id: '1', timestamp: new Date().toISOString(), level: 'info', message: 'GPU LLM API route started', details: { routeId: 'llm', port: 18000 } },
      { id: '2', timestamp: new Date().toISOString(), level: 'warn', message: 'Research server SSH disconnected', details: { serverId: 'lab' } },
    ],
    platform: 'win32',
    version: '0.4.0-test',
  }));
  ipcMain.handle('config:save', async (_event, payload) => {
    configSaveCount += 1;
    if (configSaveCount === 1) await new Promise((resolve) => setTimeout(resolve, 250));
    return response({
      config: payload.config,
      secrets: { gpu: {}, private: { hasPassword: true, hasPassphrase: false }, lab: {} },
    });
  });
  for (const channel of ['server:probe-key', 'server:test', 'route:start', 'route:stop', 'route:start-all', 'route:stop-all', 'window:set-theme', 'window:show', 'app:quit', 'dialog:select-key']) {
    ipcMain.handle(channel, () => response(null));
  }
  ipcMain.handle('ssh-keys:list', () => response([
    { name: 'id_ed25519', path: 'C:\\Users\\demo\\.ssh\\id_ed25519', preferred: true },
    { name: 'project-key', path: 'C:\\Users\\demo\\.ssh\\project-key', preferred: false },
  ]));
}

async function capture(window, filename) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      window.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await window.webContents.capturePage();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const image = await window.webContents.capturePage();
      await fs.writeFile(path.join(outputDirectory, filename), image.toPNG());
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function executeChecked(window, label, script) {
  const result = await window.webContents.executeJavaScript(`(() => {
    try {
      return { ok: true, value: (${script}) };
    } catch (error) {
      return { ok: false, error: error && (error.stack || error.message || String(error)) };
    }
  })()`);
  if (!result.ok) throw new Error(`${label}: ${result.error}`);
  return result.value;
}

async function run() {
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.unlink(path.join(outputDirectory, 'error.txt')).catch(() => {});
  registerMockIpc();
  const window = new BrowserWindow({
    width: 1320,
    height: 820,
    show: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a101d', symbolColor: '#aab6ca', height: 64 },
    backgroundColor: '#080d19',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const errors = [];
  window.webContents.on('console-message', (_event, detailsOrLevel, maybeMessage) => {
    const details = typeof detailsOrLevel === 'object' && detailsOrLevel !== null
      ? detailsOrLevel
      : { level: detailsOrLevel, message: maybeMessage };
    if (Number(details.level) >= 2) errors.push(details.message);
  });
  await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 700));
  const ready = await window.webContents.executeJavaScript(`({
    ready: document.querySelector('#app').classList.contains('ready'),
    nodes: document.querySelectorAll('.node-card').length,
    portHandles: document.querySelectorAll('.port-handle').length,
    edges: document.querySelectorAll('.edge-group').length,
    securityBadges: document.querySelectorAll('#security-badge').length,
    title: document.querySelector('.brand strong')?.textContent
  })`);
  if (!ready.ready || ready.nodes !== 4 || ready.portHandles !== 0 || ready.edges !== 3
    || ready.securityBadges !== 0
    || ready.title !== 'PortPatch') {
    throw new Error(`Render validation failed: ${JSON.stringify(ready)}`);
  }
  const connectingArrow = await window.webContents.executeJavaScript(`(() => {
    const edge = document.querySelector('[data-edge-id="internet"] .route-edge');
    const arrow = document.querySelector('#arrow-connecting path');
    return {
      marker: getComputedStyle(edge).markerEnd,
      edgeColor: getComputedStyle(edge).stroke,
      arrowColor: getComputedStyle(arrow).fill,
      edgeAnimation: getComputedStyle(edge).animationName,
      arrowAnimation: getComputedStyle(arrow).animationName
    };
  })()`);
  if (!connectingArrow.marker.includes('arrow-connecting')
    || connectingArrow.edgeColor !== connectingArrow.arrowColor
    || connectingArrow.edgeAnimation !== 'connecting-pulse'
    || connectingArrow.arrowAnimation !== 'none') {
    throw new Error(`Connecting arrow validation failed: ${JSON.stringify(connectingArrow)}`);
  }
  const loopbackLabel = await window.webContents.executeJavaScript(
    `document.querySelector('[data-edge-id="llm"] .edge-label').textContent.replace(/\\s+/g, ' ').trim()`,
  );
  if (!loopbackLabel.includes('18000') || !loopbackLabel.includes('8000')
    || loopbackLabel.includes(':18000') || loopbackLabel.includes(':8000')) {
    throw new Error(`Loopback edge label validation failed: ${loopbackLabel}`);
  }
  await capture(window, '01-graph.png');

  const stagedNodeMove = await executeChecked(window, 'stage two node moves while the first save is pending', `(() => {
    const source = document.querySelector('[data-node-id="local"]');
    const before = { left: parseFloat(source.style.left), top: parseFloat(source.style.top) };
    const rect = source.getBoundingClientRect();
    const firstOptions = { bubbles: true, button: 0, pointerId: 71, pointerType: 'mouse' };
    source.dispatchEvent(new PointerEvent('pointerdown', { ...firstOptions, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...firstOptions, clientX: rect.x + rect.width / 2 + 80, clientY: rect.y + rect.height / 2 + 55 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...firstOptions, clientX: rect.x + rect.width / 2 + 80, clientY: rect.y + rect.height / 2 + 55 }));
    const afterFirst = { left: parseFloat(source.style.left), top: parseFloat(source.style.top) };

    const secondRect = source.getBoundingClientRect();
    const secondOptions = { bubbles: true, button: 0, pointerId: 72, pointerType: 'mouse' };
    const endX = secondRect.x + secondRect.width / 2 + 65;
    const endY = secondRect.y + secondRect.height / 2 + 35;
    source.dispatchEvent(new PointerEvent('pointerdown', { ...secondOptions, clientX: secondRect.x + secondRect.width / 2, clientY: secondRect.y + secondRect.height / 2 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...secondOptions, clientX: endX, clientY: endY }));
    window.__pendingNodeDrag = { options: secondOptions, endX, endY };
    return {
      before,
      afterFirst,
      staged: { left: parseFloat(source.style.left), top: parseFloat(source.style.top) },
      edges: document.querySelectorAll('.edge-group').length
    };
  })()`);
  if (stagedNodeMove.afterFirst.left <= stagedNodeMove.before.left
    || stagedNodeMove.afterFirst.top <= stagedNodeMove.before.top
    || stagedNodeMove.staged.left <= stagedNodeMove.afterFirst.left
    || stagedNodeMove.staged.top <= stagedNodeMove.afterFirst.top
    || stagedNodeMove.edges !== 3) {
    throw new Error(`Node movement staging failed: ${JSON.stringify(stagedNodeMove)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 320));
  await executeChecked(window, 'finish the second node move after the stale save returns', `(() => {
    const pending = window.__pendingNodeDrag;
    document.dispatchEvent(new PointerEvent('pointerup', {
      ...pending.options,
      clientX: pending.endX,
      clientY: pending.endY
    }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const settledNodeMove = await executeChecked(window, 'rerender the node after queued saves', `(() => {
    document.querySelector('[data-node-list-id="local"]').click();
    const source = document.querySelector('[data-node-id="local"]');
    return { left: parseFloat(source.style.left), top: parseFloat(source.style.top) };
  })()`);
  if (Math.abs(settledNodeMove.left - stagedNodeMove.staged.left) > 0.5
    || Math.abs(settledNodeMove.top - stagedNodeMove.staged.top) > 0.5) {
    throw new Error(`A stale save moved the node: ${JSON.stringify({ stagedNodeMove, settledNodeMove })}`);
  }

  const zoomedCanvas = await executeChecked(window, 'zoom canvas with the mouse wheel', `(() => {
    const viewport = document.querySelector('#canvas-viewport');
    const rect = viewport.getBoundingClientRect();
    viewport.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -240,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2
    }));
    const result = {
      level: document.querySelector('#zoom-level').textContent,
      transform: document.querySelector('#graph-canvas').style.transform,
      worldWidth: parseFloat(document.querySelector('#graph-world').style.width),
      worldHeight: parseFloat(document.querySelector('#graph-world').style.height)
    };
    document.querySelector('#zoom-reset').click();
    return result;
  })()`);
  if (zoomedCanvas.level === '100%'
    || !zoomedCanvas.transform.startsWith('scale(')
    || zoomedCanvas.worldWidth <= 1200
    || zoomedCanvas.worldWidth !== zoomedCanvas.worldHeight) {
    throw new Error(`Canvas zoom validation failed: ${JSON.stringify(zoomedCanvas)}`);
  }

  const pannedCanvas = await executeChecked(window, 'pan canvas by dragging the background', `(() => {
    const viewport = document.querySelector('#canvas-viewport');
    const canvas = document.querySelector('#graph-canvas');
    viewport.scrollLeft = 220;
    viewport.scrollTop = 140;
    const before = { left: viewport.scrollLeft, top: viewport.scrollTop };
    const rect = viewport.getBoundingClientRect();
    const options = { bubbles: true, button: 0, pointerId: 73, pointerType: 'mouse' };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...options, clientX: rect.x + 420, clientY: rect.y + 420 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: rect.x + 350, clientY: rect.y + 370 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...options, clientX: rect.x + 350, clientY: rect.y + 370 }));
    return {
      before,
      after: { left: viewport.scrollLeft, top: viewport.scrollTop },
      panningClassRemoved: !viewport.classList.contains('is-panning')
    };
  })()`);
  if (pannedCanvas.after.left <= pannedCanvas.before.left
    || pannedCanvas.after.top <= pannedCanvas.before.top
    || !pannedCanvas.panningClassRemoved) {
    throw new Error(`Canvas pan validation failed: ${JSON.stringify(pannedCanvas)}`);
  }

  await executeChecked(window, 'select route', `document.querySelector('[data-route-list-id="llm"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await capture(window, '02-route-inspector.png');

  await executeChecked(window, 'create an inline route by dragging an edge', `(() => {
    const viewport = document.querySelector('#canvas-viewport');
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    document.querySelector('#zoom-out').click();
    const source = document.querySelector('[data-node-id="local"]');
    const target = document.querySelector('[data-node-id="gpu"]');
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    window.__nodePositionsBeforeRouteDrag = {
      source: { left: source.style.left, top: source.style.top },
      target: { left: target.style.left, top: target.style.top }
    };
    const options = { bubbles: true, button: 0, pointerId: 77, pointerType: 'mouse', ctrlKey: true };
    source.dispatchEvent(new PointerEvent('pointerdown', { ...options, clientX: from.x + from.width / 2, clientY: from.y + from.height / 2 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: to.x + to.width / 2, clientY: to.y + to.height / 2 }));
    const path = document.querySelector('#draft-edge');
    const totalLength = path.getTotalLength();
    const first = path.getPointAtLength(0);
    const last = path.getPointAtLength(totalLength);
    const matrix = path.getScreenCTM();
    const firstScreen = new DOMPoint(first.x, first.y).matrixTransform(matrix);
    const lastScreen = new DOMPoint(last.x, last.y).matrixTransform(matrix);
    window.__draftAlignment = {
      endpointError: Math.hypot(lastScreen.x - (to.x + to.width / 2), lastScreen.y - (to.y + to.height / 2)),
      sourceBoundaryError: Math.min(
        Math.abs(firstScreen.x - from.left),
        Math.abs(firstScreen.x - from.right),
        Math.abs(firstScreen.y - from.top),
        Math.abs(firstScreen.y - from.bottom)
      )
    };
    document.dispatchEvent(new PointerEvent('pointerup', { ...options, clientX: to.x + to.width / 2, clientY: to.y + to.height / 2 }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const routeEditor = await window.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('#edge-route-form');
    const rect = editor?.getBoundingClientRect();
    return {
      visible: Boolean(editor),
      modalHidden: document.querySelector('#modal-backdrop').classList.contains('is-hidden'),
      sourcePort: Boolean(document.querySelector('#edge-source-port')),
      targetPort: Boolean(document.querySelector('#edge-target-port')),
      autoStartControl: Boolean(document.querySelector('#edge-route-autostart')),
      nodeContext: document.querySelector('.edge-editor-context')?.textContent.replace(/\\s+/g, ' ').trim(),
      edges: document.querySelectorAll('.edge-group').length,
      width: rect?.width,
      height: rect?.height,
      display: editor ? getComputedStyle(editor).display : null,
      layerZIndex: getComputedStyle(document.querySelector('#edge-editor-layer')).zIndex,
      draftAlignment: window.__draftAlignment,
      nodePositionsUnchanged: (() => {
        const source = document.querySelector('[data-node-id="local"]');
        const target = document.querySelector('[data-node-id="gpu"]');
        return source.style.left === window.__nodePositionsBeforeRouteDrag.source.left
          && source.style.top === window.__nodePositionsBeforeRouteDrag.source.top
          && target.style.left === window.__nodePositionsBeforeRouteDrag.target.left
          && target.style.top === window.__nodePositionsBeforeRouteDrag.target.top;
      })()
    };
  })()`);
  if (!routeEditor.visible || !routeEditor.modalHidden || !routeEditor.sourcePort || !routeEditor.targetPort
    || routeEditor.autoStartControl
    || !routeEditor.nodeContext.includes('Development Laptop')
    || !routeEditor.nodeContext.includes('GPU Server')
    || routeEditor.edges !== 4
    || routeEditor.width < 300
    || routeEditor.height < 60
    || routeEditor.display === 'none'
    || Number(routeEditor.layerZIndex) < 4
    || routeEditor.draftAlignment.endpointError > 1.5
    || routeEditor.draftAlignment.sourceBoundaryError > 1.5
    || !routeEditor.nodePositionsUnchanged) {
    throw new Error(`Inline route editor validation failed: ${JSON.stringify(routeEditor)}`);
  }
  await capture(window, '03-edge-editor.png');

  await executeChecked(window, 'save inline route', `(() => {
    document.querySelector('#edge-source-port').value = '19000';
    document.querySelector('#edge-target-port').value = '9000';
    document.querySelector('#edge-target-host').value = '10.0.0.5';
    document.querySelector('#edge-route-form').requestSubmit();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const savedRoute = await window.webContents.executeJavaScript(`({
    editorClosed: !document.querySelector('#edge-route-form'),
    matchingLabel: [...document.querySelectorAll('.edge-label')].some((label) =>
      label.textContent.includes('19000')
      && label.textContent.includes(String.fromCharCode(8594))
      && label.textContent.includes('10.0.0.5:9000')
      && !label.textContent.includes(':19000')
      && !label.textContent.includes('->')),
    edges: document.querySelectorAll('.edge-group').length,
    parallelRoutes: (() => {
      const groups = [...document.querySelectorAll('.edge-group')].filter((group) => {
        const text = group.querySelector('.edge-label')?.textContent || '';
        return text.includes('18000') || text.includes('19000');
      });
      const paths = groups.map((group) => group.querySelector('.route-edge')?.getAttribute('d'));
      const labels = groups.map((group) => group.querySelector('.edge-label-bg')?.getBoundingClientRect());
      const labelsOverlap = labels.length === 2
        && labels[0].left < labels[1].right
        && labels[0].right > labels[1].left
        && labels[0].top < labels[1].bottom
        && labels[0].bottom > labels[1].top;
      return {
        count: groups.length,
        distinctPaths: new Set(paths).size,
        labelsOverlap,
      };
    })()
  })`);
  if (!savedRoute.editorClosed || !savedRoute.matchingLabel || savedRoute.edges !== 4
    || savedRoute.parallelRoutes.count !== 2
    || savedRoute.parallelRoutes.distinctPaths !== 2
    || savedRoute.parallelRoutes.labelsOverlap) {
    throw new Error(`Inline route save validation failed: ${JSON.stringify(savedRoute)}`);
  }

  await executeChecked(window, 'open server modal', `window.openServerModal()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const keyDetection = await window.webContents.executeJavaScript(`({
    selectedPath: document.querySelector('#server-key-path')?.value,
    selectionControls: document.querySelectorAll('#detected-key-select').length,
    optionsClosed: !document.querySelector('#key-options')?.open,
    summary: document.querySelector('#key-options-summary')?.textContent,
    status: document.querySelector('#key-detection-status')?.textContent
  })`);
  if (keyDetection.selectedPath !== 'C:\\Users\\demo\\.ssh\\id_ed25519'
    || keyDetection.selectionControls !== 0
    || !keyDetection.optionsClosed
    || keyDetection.summary !== 'id_ed25519 detected automatically'
    || !keyDetection.status.includes('Using id_ed25519 from ~/.ssh')) {
    throw new Error(`Private key detection validation failed: ${JSON.stringify(keyDetection)}`);
  }
  await capture(window, '04-server-modal.png');

  await executeChecked(window, 'open server with a saved password', `(() => {
    document.querySelector('[data-close-modal]').click();
    window.openServerModal('private');
    return true;
  })()`);
  const savedPassword = await window.webContents.executeJavaScript(`({
    authMode: document.querySelector('#server-auth')?.value,
    fieldHidden: document.querySelector('#password-field')?.classList.contains('is-hidden'),
    value: document.querySelector('#server-password')?.value,
    placeholder: document.querySelector('#server-password')?.placeholder,
    state: document.querySelector('.credential-state')?.textContent,
    storage: document.querySelector('.credential-storage-note')?.textContent
  })`);
  if (savedPassword.authMode !== 'password'
    || savedPassword.fieldHidden
    || savedPassword.value !== ''
    || savedPassword.placeholder !== 'Leave blank to keep the saved password'
    || savedPassword.state !== 'Saved securely'
    || !savedPassword.storage.includes('Windows DPAPI')
    || !savedPassword.storage.includes('secrets.json')) {
    throw new Error(`Saved password presentation validation failed: ${JSON.stringify(savedPassword)}`);
  }
  await capture(window, '05-password-server-modal.png');

  await executeChecked(window, 'open help modal', `(() => {
    document.querySelector('[data-close-modal]').click();
    document.querySelector('#help-button').click();
    return true;
  })()`);
  const helpModal = await window.webContents.executeJavaScript(`({
    title: document.querySelector('#modal-title')?.textContent,
    items: document.querySelectorAll('.help-item').length,
    includesConnect: document.querySelector('#modal')?.textContent.includes('Ctrl + drag'),
    includesZoom: document.querySelector('#modal')?.textContent.includes('Mouse wheel'),
    descriptionFontSize: parseFloat(getComputedStyle(document.querySelector('.help-item span')).fontSize)
  })`);
  if (helpModal.title !== 'Using the routing map' || helpModal.items !== 6
    || !helpModal.includesConnect || !helpModal.includesZoom
    || helpModal.descriptionFontSize < 11) {
    throw new Error(`Help modal validation failed: ${JSON.stringify(helpModal)}`);
  }
  await capture(window, '06-help-modal.png');

  await executeChecked(window, 'open application settings', `(() => {
    document.querySelector('[data-close-modal]').click();
    document.querySelector('#settings-button').click();
    return true;
  })()`);
  const startupSettings = await window.webContents.executeJavaScript(`({
    title: document.querySelector('#modal-title')?.textContent,
    startupControls: document.querySelectorAll('#start-with-system').length,
    startupLabel: document.querySelector('label[for="start-with-system"]')?.textContent,
    routeStartupControls: document.querySelectorAll('#edge-route-autostart').length,
    routeBehaviorNote: document.querySelector('#modal')?.textContent.includes('Port routes remain stopped until you select Start route or Start all.'),
    hiddenLaunchDisabled: document.querySelector('#launch-hidden')?.disabled,
    interfaceSize: document.querySelector('#ui-scale')?.value,
    theme: document.querySelector('#ui-theme')?.value
  })`);
  if (startupSettings.title !== 'Application settings'
    || startupSettings.startupControls !== 1
    || startupSettings.startupLabel !== 'Launch PortPatch when I sign in'
    || startupSettings.routeStartupControls !== 0
    || !startupSettings.routeBehaviorNote
    || !startupSettings.hiddenLaunchDisabled
    || startupSettings.interfaceSize !== '100'
    || startupSettings.theme !== 'dark') {
    throw new Error(`Startup settings validation failed: ${JSON.stringify(startupSettings)}`);
  }
  await capture(window, '07-settings-modal.png');
  await executeChecked(window, 'preview and cancel a compact interface size', `(() => {
    document.querySelector('#ui-scale').value = '90';
    document.querySelector('#ui-scale').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#ui-theme').value = 'light';
    document.querySelector('#ui-theme').dispatchEvent(new Event('change', { bubbles: true }));
    return window.sshRouter.getUiScale();
  })()`);
  const previewScale = await window.webContents.executeJavaScript(`window.sshRouter.getUiScale()`);
  if (previewScale !== 90) throw new Error(`Interface scale preview was not applied: ${previewScale}`);
  const previewTheme = await window.webContents.executeJavaScript(`document.documentElement.dataset.theme`);
  if (previewTheme !== 'light') throw new Error(`Interface theme preview was not applied: ${previewTheme}`);
  await capture(window, '08-light-theme-preview.png');
  await executeChecked(window, 'cancel the interface size preview', `(() => {
    [...document.querySelectorAll('[data-close-modal]')].find((element) => element.textContent === 'Cancel').click();
    return true;
  })()`);
  const restoredScale = await window.webContents.executeJavaScript(`window.sshRouter.getUiScale()`);
  if (restoredScale !== 100) throw new Error(`Cancelled interface scale was not restored: ${restoredScale}`);
  const restoredTheme = await window.webContents.executeJavaScript(`document.documentElement.dataset.theme`);
  if (restoredTheme !== 'dark') throw new Error(`Cancelled interface theme was not restored: ${restoredTheme}`);

  await executeChecked(window, 'save a compact interface size', `(() => {
    document.querySelector('#settings-button').click();
    document.querySelector('#ui-scale').value = '90';
    document.querySelector('#ui-scale').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#ui-theme').value = 'light';
    document.querySelector('#ui-theme').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#save-settings').click();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const appliedScale = await window.webContents.executeJavaScript(`window.sshRouter.getUiScale()`);
  if (appliedScale !== 90) throw new Error(`Interface scale was not applied: ${appliedScale}`);
  const appliedTheme = await window.webContents.executeJavaScript(`document.documentElement.dataset.theme`);
  if (appliedTheme !== 'light') throw new Error(`Interface theme was not applied: ${appliedTheme}`);
  const lightWarning = await executeChecked(window, 'check the light-theme exposure warning', `(() => {
    window.openRouteEditor('llm');
    const bind = document.querySelector('#edge-source-bind');
    bind.value = '0.0.0.0';
    bind.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#edge-advanced').open = true;
    const warning = document.querySelector('#edge-exposure-warning');
    const style = getComputedStyle(warning);
    return {
      visible: !warning.classList.contains('is-hidden'),
      color: style.color,
      backgroundColor: style.backgroundColor,
      labelColor: getComputedStyle(warning.querySelector('label')).color
    };
  })()`);
  if (!lightWarning.visible
    || lightWarning.color !== 'rgb(113, 59, 8)'
    || lightWarning.labelColor !== 'rgb(113, 59, 8)'
    || lightWarning.backgroundColor !== 'rgb(255, 247, 232)') {
    throw new Error(`Light-theme warning contrast validation failed: ${JSON.stringify(lightWarning)}`);
  }
  await capture(window, '09-light-theme-warning.png');
  await executeChecked(window, 'close the light-theme warning editor', `(() => {
    document.querySelector('#edge-editor-close').click();
    return true;
  })()`);
  await capture(window, '10-light-theme-graph.png');

  if (errors.length) throw new Error(`Renderer console errors: ${errors.join(' | ')}`);
  window.destroy();
}

app.whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch(async (error) => {
    await fs.mkdir(outputDirectory, { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(outputDirectory, 'error.txt'), error.stack || error.message).catch(() => {});
    app.exit(1);
  });
