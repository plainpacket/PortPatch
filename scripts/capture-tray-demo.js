'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} = require('electron');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const outputPath = path.resolve(
  process.argv[2] || path.join(process.cwd(), 'docs', 'assets', 'portpatch-tray-demo.gif'),
);
const FRAME_DELAY = 125;
const PALETTE_SIZE = 256;

let backdropWindow;
let demoWindow;
let cursorWindow;
let notificationWindow;
let trayPanelWindow;
let tray;
let trayMenu;
let quitting = false;

const demoConfig = {
  version: 1,
  settings: {
    closeToTray: true,
    startWithSystem: false,
    launchHidden: false,
    uiScale: 100,
    uiScaleVersion: 2,
    theme: 'dark',
  },
  localNode: { id: 'local', name: 'Development Laptop', position: { x: 95, y: 255 } },
  servers: [
    {
      id: 'gpu',
      name: 'GPU Server',
      host: '203.0.113.24',
      port: 22,
      username: 'ubuntu',
      authMode: 'key',
      keyPath: 'C:\\Users\\demo\\.ssh\\id_ed25519',
      hostFingerprint: 'SHA256:DemoGpuHostKey',
      position: { x: 500, y: 130 },
    },
    {
      id: 'gateway',
      name: 'Private Gateway',
      host: 'gateway.example.net',
      port: 22,
      username: 'dev',
      authMode: 'agent',
      keyPath: '',
      hostFingerprint: 'SHA256:DemoGatewayHostKey',
      position: { x: 485, y: 420 },
    },
  ],
  routes: [
    {
      id: 'llm',
      name: 'Development Laptop to GPU Server',
      protocol: 'tcp',
      source: { nodeId: 'local', bindHost: '127.0.0.1', port: 18000 },
      target: { nodeId: 'gpu', host: '127.0.0.1', port: 8000 },
      reconnect: true,
      allowExternal: false,
    },
    {
      id: 'database',
      name: 'Development Laptop to Private Gateway',
      protocol: 'tcp',
      source: { nodeId: 'local', bindHost: '127.0.0.1', port: 15432 },
      target: { nodeId: 'gateway', host: '127.0.0.1', port: 5432 },
      reconnect: true,
      allowExternal: false,
    },
  ],
};

const statuses = {
  llm: {
    routeId: 'llm',
    state: 'running',
    desired: true,
    activeConnections: 1,
    bytesUp: 24576,
    bytesDown: 196608,
    lastError: null,
  },
  database: {
    routeId: 'database',
    state: 'running',
    desired: true,
    activeConnections: 1,
    bytesUp: 16384,
    bytesDown: 65536,
    lastError: null,
  },
};

function response(value) {
  return { ok: true, value };
}

function registerMockIpc() {
  ipcMain.handle('state:get', () => response({
    config: demoConfig,
    secrets: { gpu: {}, gateway: {} },
    encryption: { available: true, backend: 'dpapi', warning: null },
    statuses,
    logs: [],
    platform: 'win32',
    version: '0.3.0-demo',
  }));
  ipcMain.handle('config:save', (_event, payload) => response({
    config: payload.config,
    secrets: { gpu: {}, gateway: {} },
  }));
  for (const channel of [
    'server:probe-key',
    'server:test',
    'route:start',
    'route:stop',
    'route:start-all',
    'route:stop-all',
    'window:set-theme',
    'window:show',
    'app:quit',
    'dialog:select-key',
  ]) {
    ipcMain.handle(channel, () => response(null));
  }
  ipcMain.handle('ssh-keys:list', () => response([]));
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

async function captureDesktopFrame() {
  const image = await backdropWindow.webContents.capturePage();
  const size = image.getSize();
  return {
    width: size.width,
    height: size.height,
    rgba: bitmapToRgba(image.toBitmap()),
    capturedAt: Date.now(),
  };
}

async function writeGif(frames) {
  if (!frames.length) throw new Error('No tray demo frames were captured.');
  const gif = GIFEncoder();
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const palette = quantize(frame.rgba, PALETTE_SIZE, { format: 'rgb565' });
    const nextFrame = frames[index + 1];
    const delay = nextFrame
      ? Math.max(FRAME_DELAY, Math.min(1000, nextFrame.capturedAt - frame.capturedAt))
      : 600;
    gif.writeFrame(applyPalette(frame.rgba, palette, 'rgb565'), frame.width, frame.height, {
      palette,
      delay,
      repeat: 0,
    });
  }
  gif.finish();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, gif.bytes());
}

function trayIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

async function createWindows() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const iconDataUrl = nativeImage
    .createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'))
    .resize({ width: 24, height: 24 })
    .toDataURL();

  backdropWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#060a13',
  });
  await backdropWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><body style="margin:0;height:100vh;overflow:hidden;background:
      radial-gradient(circle at 50% 40%,#17213a 0,#0a1020 42%,#050810 100%);">
      <div style="position:absolute;left:28px;top:24px;color:#71809b;font:600 13px system-ui">
        PortPatch demo
      </div>
      <div style="position:absolute;left:0;right:0;bottom:0;height:44px;background:#f3f5f8;
        border-top:1px solid #dbe1e9">
        <div style="position:absolute;right:18px;top:6px;display:flex;align-items:center;gap:8px;
          color:#536176;font:600 12px system-ui">
          <span>PortPatch</span><img src="${iconDataUrl}" style="width:24px;height:24px">
        </div>
      </div>
    </body></html>
  `)}`);
  backdropWindow.show();

  const width = Math.min(1320, workArea.width - 80);
  const height = Math.min(820, workArea.height - 80);
  demoWindow = new BrowserWindow({
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
    show: false,
    alwaysOnTop: true,
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
  demoWindow.setMenuBarVisibility(false);
  await demoWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await demoWindow.webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const demoImageDataUrl = (await demoWindow.webContents.capturePage()).toDataURL();
  const appX = Math.round((workArea.width - width) / 2);
  const appY = Math.round((workArea.height - height) / 2);
  await backdropWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html>
      <head>
        <style>
          * { box-sizing: border-box; }
          html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
          body {
            background: radial-gradient(circle at 50% 40%, #17213a 0, #0a1020 42%, #050810 100%);
            font-family: system-ui, sans-serif;
          }
          #demo-label {
            position: absolute; left: 28px; top: 24px; color: #71809b;
            font-size: 13px; font-weight: 600;
          }
          #app-shot {
            position: absolute; left: ${appX}px; top: ${appY}px;
            width: ${width}px; height: ${height}px; border-radius: 13px;
            box-shadow: 0 28px 80px rgba(0, 0, 0, .55);
          }
          #cursor {
            position: absolute; z-index: 5; width: 28px; height: 32px;
            opacity: 0; pointer-events: none;
          }
          #notification {
            position: absolute; z-index: 4; right: 22px; bottom: 54px;
            width: 360px; height: 104px; padding: 15px 16px;
            display: none; color: #e7eefb; border: 1px solid #3a4966;
            border-radius: 12px; background: #111b30;
            box-shadow: 0 14px 36px rgba(0, 0, 0, .45);
          }
          #notification-content { display: flex; gap: 11px; align-items: flex-start; }
          #notification img { width: 28px; height: 28px; }
          #notification strong { display: block; font-size: 14px; }
          #notification span {
            display: block; margin-top: 5px; color: #aebbd0;
            font-size: 12px; line-height: 1.4;
          }
          #tray-panel {
            position: absolute; z-index: 4; right: 22px; bottom: 54px;
            width: 252px; padding: 8px; display: none; color: #172033;
            border: 1px solid #c7d0dc; border-radius: 10px; background: #fff;
            box-shadow: 0 14px 36px rgba(0, 0, 0, .28); font-size: 13px;
          }
          #tray-panel .heading {
            padding: 8px 10px 10px; color: #60708a;
            font-size: 11px; font-weight: 700;
          }
          #tray-panel .item { padding: 8px 10px; }
          #tray-panel .selected {
            padding: 9px 10px; border-radius: 6px; background: #eef3ff; font-weight: 650;
          }
          #tray-panel .separator { height: 1px; margin: 6px 2px; background: #d9e0e9; }
          #taskbar {
            position: absolute; left: 0; right: 0; bottom: 0; height: 44px;
            border-top: 1px solid #dbe1e9; background: #f3f5f8;
          }
          #tray-entry {
            position: absolute; right: 18px; top: 6px; display: flex;
            align-items: center; gap: 8px; color: #536176;
            font-size: 12px; font-weight: 600;
          }
          #tray-entry img { width: 24px; height: 24px; }
        </style>
      </head>
      <body>
        <div id="demo-label">PortPatch demo</div>
        <img id="app-shot" src="${demoImageDataUrl}">
        <div id="cursor">
          <svg viewBox="0 0 28 32" width="28" height="32">
            <path d="M3 2 L3 25 L9.2 19.2 L14 29 L18.3 26.9 L13.5 17 H22.5 Z"
              fill="#fff" stroke="#111827" stroke-width="1.7" stroke-linejoin="round"/>
          </svg>
        </div>
        <div id="notification">
          <div id="notification-content">
            <img src="${iconDataUrl}">
            <div>
              <strong>PortPatch is still running</strong>
              <span>Port routes remain active in the system tray.<br>2 active routes - 2 connections</span>
            </div>
          </div>
        </div>
        <div id="tray-panel">
          <div class="heading">PORTPATCH - 2 ACTIVE ROUTES</div>
          <div class="selected">Open PortPatch</div>
          <div class="separator"></div>
          <div class="item">Start all routes (2)</div>
          <div class="item">Stop all routes</div>
          <div class="separator"></div>
          <div class="item">Quit PortPatch</div>
        </div>
        <div id="taskbar">
          <div id="tray-entry"><span>PortPatch</span><img src="${iconDataUrl}"></div>
        </div>
      </body>
    </html>
  `)}`);
  demoWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    demoWindow.hide();
    tray.displayBalloon?.({
      title: 'PortPatch is still running',
      content: 'Port routes remain active in the system tray. Use the tray menu to quit completely.',
    });
  });
  backdropWindow.showInactive();
  backdropWindow.moveTop();

  cursorWindow = new BrowserWindow({
    width: 34,
    height: 40,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
  });
  cursorWindow.setIgnoreMouseEvents(true);
  await cursorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
      <svg viewBox="0 0 28 32" width="28" height="32">
        <path d="M3 2 L3 25 L9.2 19.2 L14 29 L18.3 26.9 L13.5 17 H22.5 Z"
          fill="#fff" stroke="#111827" stroke-width="1.7" stroke-linejoin="round"/>
      </svg>
    </body></html>
  `)}`);

  notificationWindow = new BrowserWindow({
    x: workArea.x + workArea.width - 382,
    y: workArea.y + workArea.height - 132,
    width: 360,
    height: 110,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: true,
  });
  notificationWindow.setIgnoreMouseEvents(true);
  await notificationWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><body style="margin:0;background:transparent;font-family:system-ui;color:#e7eefb">
      <div style="box-sizing:border-box;height:104px;margin:3px;padding:15px 16px;border:1px solid #3a4966;
        border-radius:12px;background:#111b30;box-shadow:0 14px 36px rgba(0,0,0,.45)">
        <div style="display:flex;gap:11px;align-items:flex-start">
          <img src="${iconDataUrl}" style="width:28px;height:28px">
          <div><strong style="display:block;font-size:14px">PortPatch is still running</strong>
            <span style="display:block;margin-top:5px;color:#aebbd0;font-size:12px;line-height:1.4">
              Port routes remain active in the system tray.<br>2 active routes - 2 connections
            </span>
          </div>
        </div>
      </div>
    </body></html>
  `)}`);

  trayPanelWindow = new BrowserWindow({
    x: workArea.x + workArea.width - 274,
    y: workArea.y + workArea.height - 250,
    width: 252,
    height: 228,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: true,
  });
  trayPanelWindow.setIgnoreMouseEvents(true);
  await trayPanelWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><body style="margin:0;background:transparent;font:13px system-ui;color:#172033">
      <div style="box-sizing:border-box;margin:3px;padding:8px;border:1px solid #c7d0dc;border-radius:10px;
        background:#fff;box-shadow:0 14px 36px rgba(0,0,0,.28)">
        <div style="padding:8px 10px 10px;color:#60708a;font-size:11px;font-weight:700">PORTPATCH - 2 ACTIVE ROUTES</div>
        <div style="padding:9px 10px;border-radius:6px;background:#eef3ff;font-weight:650">Open PortPatch</div>
        <div style="height:1px;margin:6px 2px;background:#d9e0e9"></div>
        <div style="padding:8px 10px">Start all routes (2)</div>
        <div style="padding:8px 10px">Stop all routes</div>
        <div style="height:1px;margin:6px 2px;background:#d9e0e9"></div>
        <div style="padding:8px 10px">Quit PortPatch</div>
      </div>
    </body></html>
  `)}`);
}

async function moveCursor(from, to, duration) {
  const steps = Math.max(1, Math.round(duration / 35));
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    cursorWindow.setPosition(
      Math.round(from.x + (to.x - from.x) * progress),
      Math.round(from.y + (to.y - from.y) * progress),
    );
    await new Promise((resolve) => setTimeout(resolve, duration / steps));
  }
}

async function runSequence() {
  await backdropWindow.webContents.executeJavaScript(`
    (async () => {
      const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
      const app = document.querySelector('#app-shot');
      const cursor = document.querySelector('#cursor');
      const notification = document.querySelector('#notification');
      const trayPanel = document.querySelector('#tray-panel');
      const rect = app.getBoundingClientRect();
      const start = { x: rect.left + rect.width * .68, y: rect.bottom - 95 };
      const close = { x: rect.right - 24, y: rect.top + 23 };

      cursor.style.transform = \`translate(\${start.x}px, \${start.y}px)\`;
      cursor.style.opacity = '1';
      await wait(700);
      cursor.style.transition = 'transform 850ms ease-in-out';
      cursor.style.transform = \`translate(\${close.x}px, \${close.y}px)\`;
      await wait(1200);

      app.style.display = 'none';
      cursor.style.opacity = '0';
      notification.style.display = 'block';
      await wait(2300);
      notification.style.display = 'none';
      trayPanel.style.display = 'block';
      await wait(2300);
      trayPanel.style.display = 'none';
      app.style.display = 'block';
      await wait(1500);
    })()
  `);
}

async function run() {
  registerMockIpc();
  tray = new Tray(trayIcon());
  tray.setToolTip('PortPatch - 2 active routes - 2 connections');
  trayMenu = Menu.buildFromTemplate([
    { label: 'Open PortPatch', click: () => demoWindow.show() },
    { type: 'separator' },
    { label: 'Start all routes (2)', enabled: true },
    { label: 'Stop all routes', enabled: true },
    { type: 'separator' },
    { label: 'Quit PortPatch', enabled: true },
  ]);
  tray.setContextMenu(trayMenu);
  await createWindows();
  await new Promise((resolve) => setTimeout(resolve, 900));

  const frames = [];
  let capturing = true;
  const captureLoop = (async () => {
    while (capturing) {
      const startedAt = Date.now();
      frames.push(await captureDesktopFrame());
      const remainder = FRAME_DELAY - (Date.now() - startedAt);
      if (remainder > 0) await new Promise((resolve) => setTimeout(resolve, remainder));
    }
  })();

  await runSequence();
  capturing = false;
  await captureLoop;
  await writeGif(frames);

  const stats = await fs.stat(outputPath);
  process.stdout.write(`Tray demo GIF: ${outputPath}\nFrames: ${frames.length}\nSize: ${stats.size} bytes\n`);
}

app.whenReady()
  .then(run)
  .then(() => {
    quitting = true;
    tray?.destroy();
    app.quit();
  })
  .catch(async (error) => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true }).catch(() => {});
    await fs.writeFile(`${outputPath}.error.txt`, error.stack || String(error)).catch(() => {});
    process.stderr.write(`${error.stack || error}\n`);
    quitting = true;
    tray?.destroy();
    app.exit(1);
  });
