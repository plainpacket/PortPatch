'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const outputPath = path.resolve(
  process.argv[2] || path.join(process.cwd(), 'docs', 'portpatch-demo.gif'),
);
const FRAME_DELAY = 125;
const PALETTE_SIZE = 256;

let demoWindow;
let demoConfig = {
  version: 1,
  settings: {
    closeToTray: true,
    startWithSystem: false,
    launchHidden: false,
    uiScale: 100,
    uiScaleVersion: 2,
    theme: 'dark',
  },
  localNode: {
    id: 'local',
    name: 'Development Laptop',
    position: { x: 95, y: 255 },
  },
  servers: [],
  routes: [],
};

const statuses = {};

function response(value) {
  return { ok: true, value };
}

function statusFor(routeId, state, extra = {}) {
  return {
    routeId,
    state,
    desired: state !== 'idle',
    activeConnections: 0,
    bytesUp: 0,
    bytesDown: 0,
    lastError: null,
    ...extra,
  };
}

function publishStatus(status) {
  statuses[status.routeId] = status;
  if (demoWindow && !demoWindow.isDestroyed()) {
    demoWindow.webContents.send('route:status', status);
  }
}

function secretMetadata() {
  return Object.fromEntries(demoConfig.servers.map((server) => [server.id, {}]));
}

function registerMockIpc() {
  ipcMain.handle('state:get', () => response({
    config: demoConfig,
    secrets: secretMetadata(),
    encryption: { available: true, backend: 'dpapi', warning: null },
    statuses,
    logs: [],
    platform: 'win32',
    version: '0.3.0-demo',
  }));

  ipcMain.handle('config:save', (_event, payload) => {
    demoConfig = payload.config;
    return response({ config: demoConfig, secrets: secretMetadata() });
  });

  ipcMain.handle('route:start', (_event, { routeId }) => {
    publishStatus(statusFor(routeId, 'connecting'));
    setTimeout(() => {
      publishStatus(statusFor(routeId, 'running', {
        activeConnections: 1,
        bytesUp: 12288,
        bytesDown: 98304,
      }));
    }, 1100);
    return response(null);
  });

  ipcMain.handle('route:stop', (_event, { routeId }) => {
    publishStatus(statusFor(routeId, 'idle'));
    return response(null);
  });

  ipcMain.handle('route:start-all', () => {
    for (const route of demoConfig.routes) publishStatus(statusFor(route.id, 'connecting'));
    setTimeout(() => {
      demoConfig.routes.forEach((route, index) => {
        publishStatus(statusFor(route.id, 'running', {
          activeConnections: index % 2,
          bytesUp: 8192 * (index + 1),
          bytesDown: 32768 * (index + 1),
        }));
      });
    }, 1100);
    return response(null);
  });

  ipcMain.handle('window:set-theme', (_event, { theme }) => {
    const light = theme === 'light';
    demoWindow?.setTitleBarOverlay({
      color: light ? '#f8fafc' : '#0a101d',
      symbolColor: light ? '#334155' : '#aab6ca',
      height: 64,
    });
    return response(null);
  });

  for (const channel of [
    'server:probe-key',
    'server:test',
    'route:stop-all',
    'window:show',
    'app:quit',
    'dialog:select-key',
  ]) {
    ipcMain.handle(channel, () => response(null));
  }
  ipcMain.handle('ssh-keys:list', () => response([
    {
      name: 'id_ed25519',
      path: 'C:\\Users\\demo\\.ssh\\id_ed25519',
      preferred: true,
    },
  ]));
}

function bitmapToRgba(bitmap) {
  const rgba = new Uint8Array(bitmap.length);
  for (let index = 0; index < bitmap.length; index += 4) {
    rgba[index] = bitmap[index + 2];
    rgba[index + 1] = bitmap[index + 1];
    rgba[index + 2] = bitmap[index];
    rgba[index + 3] = bitmap[index + 3];
  }
  return rgba;
}

async function captureFrame(window) {
  const image = await window.webContents.capturePage();
  const size = image.getSize();
  return {
    width: size.width,
    height: size.height,
    rgba: bitmapToRgba(image.toBitmap()),
  };
}

async function writeGif(frames) {
  if (!frames.length) throw new Error('No demo frames were captured.');
  const gif = GIFEncoder();
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const palette = quantize(frame.rgba, PALETTE_SIZE, { format: 'rgb565' });
    const indexed = applyPalette(frame.rgba, palette, 'rgb565');
    gif.writeFrame(indexed, frame.width, frame.height, {
      palette,
      delay: FRAME_DELAY,
      repeat: 0,
    });
  }
  gif.finish();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, gif.bytes());
}

const demoSequence = `
(async () => {
  const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
  const center = (element) => {
    if (!element) throw new Error('The expected demo element was not found.');
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const nodeByName = (name) => Array.from(document.querySelectorAll('.node-card'))
    .find((card) => card.querySelector('.node-title strong')?.textContent === name);

  const style = document.createElement('style');
  style.textContent = \`
    #demo-cursor {
      position: fixed;
      left: 0;
      top: 0;
      width: 28px;
      height: 32px;
      z-index: 10000;
      pointer-events: none;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, .55));
      transition: transform 520ms cubic-bezier(.22, .75, .25, 1), opacity 180ms ease;
    }
    #demo-cursor svg {
      display: block;
      width: 28px;
      height: 32px;
      overflow: visible;
    }
    #demo-shortcut {
      position: fixed;
      left: 50%;
      top: 82px;
      z-index: 9999;
      transform: translate(-50%, -8px);
      padding: 8px 13px;
      border: 1px solid rgba(125, 211, 252, .45);
      border-radius: 9px;
      background: rgba(8, 15, 30, .92);
      color: #dbeafe;
      font: 600 13px/1 system-ui, sans-serif;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .35);
      opacity: 0;
      transition: opacity 180ms ease, transform 180ms ease;
      pointer-events: none;
    }
    #demo-shortcut.visible {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    #demo-shortcut kbd {
      margin-right: 7px;
      padding: 3px 7px;
      border: 1px solid #52627d;
      border-bottom-width: 2px;
      border-radius: 5px;
      background: #172033;
      color: #ffffff;
      font: inherit;
    }
  \`;
  document.head.appendChild(style);

  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  cursor.innerHTML = '<svg viewBox="0 0 28 32" aria-hidden="true"><path d="M3 2 L3 25 L9.2 19.2 L14 29 L18.3 26.9 L13.5 17 H22.5 Z" fill="#fff" stroke="#111827" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursor);
  const shortcut = document.createElement('div');
  shortcut.id = 'demo-shortcut';
  shortcut.innerHTML = '<kbd>Ctrl</kbd>drag to create a route';
  document.body.appendChild(shortcut);

  const moveCursor = async (point, duration = 520) => {
    cursor.style.transitionDuration = \`\${duration}ms, 180ms\`;
    cursor.style.transform = \`translate(\${point.x}px, \${point.y}px)\`;
    await wait(duration + 55);
  };
  const pulseCursor = async () => {
    cursor.animate(
      [
        { transform: cursor.style.transform + ' scale(1)' },
        { transform: cursor.style.transform + ' scale(.82)' },
        { transform: cursor.style.transform + ' scale(1)' },
      ],
      { duration: 190, easing: 'ease-out' },
    );
    await wait(205);
  };
  const clickElement = async (element, duration = 360) => {
    await moveCursor(center(element), duration);
    await pulseCursor();
    element.click();
    await wait(260);
  };
  const enterText = async (element, value, delay = 24) => {
    await moveCursor(center(element), 260);
    element.focus();
    await pulseCursor();
    element.value = '';
    for (const character of value) {
      element.value += character;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(delay);
    }
  };
  const addServer = async ({ name, host, username, authMode, fingerprint }) => {
    await clickElement(document.querySelector('#add-server-button'), 420);
    await wait(380);
    await enterText(document.querySelector('#server-name'), name, 28);
    await enterText(document.querySelector('#server-host'), host, 22);
    await enterText(document.querySelector('#server-username'), username, 32);
    const auth = document.querySelector('#server-auth');
    await moveCursor(center(auth), 250);
    auth.value = authMode;
    auth.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(authMode === 'key' ? 620 : 320);
    document.querySelector('#server-fingerprint').value = fingerprint;
    await clickElement(document.querySelector('#save-server'), 360);
    await wait(650);
  };

  let pointerId = 100;
  const dragNode = async (name, deltaX, deltaY) => {
    const card = nodeByName(name);
    const start = center(card);
    const end = { x: start.x + deltaX, y: start.y + deltaY };
    await moveCursor(start, 220);
    const pointer = { bubbles: true, button: 0, pointerId: pointerId++, pointerType: 'mouse' };
    card.dispatchEvent(new PointerEvent('pointerdown', {
      ...pointer,
      clientX: start.x,
      clientY: start.y,
    }));
    for (let step = 1; step <= 8; step += 1) {
      const progress = step / 8;
      const x = start.x + deltaX * progress;
      const y = start.y + deltaY * progress;
      cursor.style.transitionDuration = '32ms, 180ms';
      cursor.style.transform = \`translate(\${x}px, \${y}px)\`;
      document.dispatchEvent(new PointerEvent('pointermove', {
        ...pointer,
        clientX: x,
        clientY: y,
      }));
      await wait(35);
    }
    document.dispatchEvent(new PointerEvent('pointerup', {
      ...pointer,
      clientX: end.x,
      clientY: end.y,
    }));
    await wait(180);
  };

  const createRoute = async (sourceName, targetName, listenPort, targetPort, showShortcut = false) => {
    const source = nodeByName(sourceName);
    const target = nodeByName(targetName);
    const sourcePoint = center(source);
    const targetPoint = center(target);
    await moveCursor(sourcePoint, 380);
    if (showShortcut) {
      shortcut.classList.add('visible');
      await wait(430);
    }
    const pointer = {
      bubbles: true,
      button: 0,
      pointerId: pointerId++,
      pointerType: 'mouse',
      ctrlKey: true,
    };
    source.dispatchEvent(new PointerEvent('pointerdown', {
      ...pointer,
      clientX: sourcePoint.x,
      clientY: sourcePoint.y,
    }));
    for (let step = 1; step <= 12; step += 1) {
      const progress = step / 12;
      const x = sourcePoint.x + (targetPoint.x - sourcePoint.x) * progress;
      const y = sourcePoint.y + (targetPoint.y - sourcePoint.y) * progress;
      cursor.style.transitionDuration = '55ms, 180ms';
      cursor.style.transform = \`translate(\${x}px, \${y}px)\`;
      document.dispatchEvent(new PointerEvent('pointermove', {
        ...pointer,
        clientX: x,
        clientY: y,
      }));
      await wait(58);
    }
    document.dispatchEvent(new PointerEvent('pointerup', {
      ...pointer,
      clientX: targetPoint.x,
      clientY: targetPoint.y,
    }));
    shortcut.classList.remove('visible');
    await wait(360);
    if (!document.querySelector('#edge-route-form')) {
      const hit = document.elementFromPoint(targetPoint.x, targetPoint.y);
      throw new Error(
        \`Route editor did not open for \${sourceName} -> \${targetName}; target=(\${Math.round(targetPoint.x)},\${Math.round(targetPoint.y)}), hit=\${hit?.className || hit?.tagName || 'none'}\`,
      );
    }
    await enterText(document.querySelector('#edge-source-port'), String(listenPort), 42);
    await enterText(document.querySelector('#edge-target-port'), String(targetPort), 42);
    const exposureConsent = document.querySelector('#edge-route-allow-external');
    const exposureWarning = document.querySelector('#edge-exposure-warning');
    if (exposureConsent && exposureWarning && !exposureWarning.classList.contains('is-hidden')) {
      await clickElement(exposureConsent, 320);
      await wait(700);
    }
    await clickElement(document.querySelector('#edge-route-save'), 280);
    await wait(520);
  };

  cursor.style.transition = 'none';
  cursor.style.transform = 'translate(900px, 690px)';
  await wait(650);

  await addServer({
    name: 'GPU Server',
    host: '203.0.113.24',
    username: 'ubuntu',
    authMode: 'key',
    fingerprint: 'SHA256:DemoGpuHostKey',
  });
  await addServer({
    name: 'Private Gateway',
    host: 'gateway.example.net',
    username: 'dev',
    authMode: 'agent',
    fingerprint: 'SHA256:DemoGatewayHostKey',
  });

  await dragNode('GPU Server', 60, -25);
  await dragNode('Private Gateway', -200, 260);
  await dragNode('Development Laptop', 50, -30);
  await wait(450);

  await createRoute('Development Laptop', 'GPU Server', 18000, 8000, true);
  await clickElement(document.querySelector('#zoom-out'), 260);
  await wait(450);
  await createRoute('GPU Server', 'Development Laptop', 18002, 8000);
  await clickElement(document.querySelector('#zoom-reset'), 300);
  await wait(450);
  await createRoute('Development Laptop', 'Private Gateway', 15432, 5432);

  await clickElement(document.querySelector('#start-all-button'), 520);
  await wait(1900);

  await clickElement(document.querySelector('#settings-button'), 480);
  await wait(500);
  const theme = document.querySelector('#ui-theme');
  await moveCursor(center(theme), 320);
  theme.value = 'light';
  theme.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(1500);
  await clickElement(document.querySelector('#save-settings'), 380);
  await wait(1400);
  cursor.style.opacity = '0';
  await wait(800);
})()
`;

async function run() {
  registerMockIpc();
  demoWindow = new BrowserWindow({
    width: 1680,
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

  await demoWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await demoWindow.webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );

  const ready = await demoWindow.webContents.executeJavaScript(`({
    ready: document.querySelector('#app').classList.contains('ready'),
    nodes: document.querySelectorAll('.node-card').length,
    routes: document.querySelectorAll('.edge-group').length
  })`);
  if (!ready.ready || ready.nodes !== 1 || ready.routes !== 0) {
    throw new Error(`Demo render validation failed: ${JSON.stringify(ready)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 900));

  const frames = [];
  let capturing = true;
  const captureLoop = (async () => {
    while (capturing) {
      const startedAt = Date.now();
      frames.push(await captureFrame(demoWindow));
      const remainder = FRAME_DELAY - (Date.now() - startedAt);
      if (remainder > 0) await new Promise((resolve) => setTimeout(resolve, remainder));
    }
  })();

  const sequenceResult = await demoWindow.webContents.executeJavaScript(`(async () => {
    try {
      await ${demoSequence};
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error && (error.stack || error.message || String(error)) };
    }
  })()`);
  if (!sequenceResult.ok) throw new Error(`Demo sequence failed: ${sequenceResult.error}`);
  capturing = false;
  await captureLoop;
  await writeGif(frames);

  const stats = await fs.stat(outputPath);
  process.stdout.write(`Demo GIF: ${outputPath}\nFrames: ${frames.length}\nSize: ${stats.size} bytes\n`);
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch(async (error) => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true }).catch(() => {});
    await fs.writeFile(`${outputPath}.error.txt`, error.stack || String(error)).catch(() => {});
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  });
