'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

app.disableHardwareAcceleration();

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'assets', 'icon.svg');

function createIco(images) {
  const count = images.length;
  const headerSize = 6 + (16 * count);
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = headerSize;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + (index * 16);
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

async function run() {
  const window = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  const svg = await fs.readFile(sourcePath, 'utf8');
  const html = `<!doctype html><style>*{box-sizing:border-box}html,body{margin:0;width:256px;height:256px;background:transparent}img{display:block;width:256px;height:256px}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const captured = await window.webContents.capturePage(
    { x: 0, y: 0, width: 256, height: 256 },
    { stayHidden: true },
  );
  if (captured.isEmpty()) throw new Error('The rendered SVG icon is empty.');

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => ({ size, png: captured.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  const outputs = [
    ['icon.png', images.at(-1).png],
    ['tray.png', images.find((image) => image.size === 32).png],
    ['icon.ico', createIco(images)],
  ];
  for (const [filename, buffer] of outputs) {
    await fs.writeFile(path.join(root, 'assets', filename), buffer);
  }
  const written = await Promise.all(outputs.map(async ([filename]) => ({
    filename,
    size: (await fs.stat(path.join(root, 'assets', filename))).size,
  })));
  console.log(JSON.stringify({ ok: true, written }));
  window.destroy();
}

app.whenReady().then(run).then(() => app.exit(0)).catch((error) => {
  console.error(error);
  fs.writeFile(path.join(root, 'assets', 'icon-generation-error.txt'), error.stack || error.message).catch(() => {});
  app.exit(1);
});
