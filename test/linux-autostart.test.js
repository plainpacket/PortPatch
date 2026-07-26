'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildDesktopEntry,
  buildExecLine,
  desktopFilePath,
  isLinuxAutostartEnabled,
  setLinuxAutostart,
} = require('../src/core/linux-autostart');

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-autostart-'));
}

test('enabling autostart writes a spec-compliant desktop entry at the XDG path', async (context) => {
  const homeDirectory = await tempHome();
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  assert.equal(await isLinuxAutostartEnabled(homeDirectory), false);
  await setLinuxAutostart(homeDirectory, true, { execPath: '/opt/PortPatch/portpatch', args: ['--hidden'] });
  assert.equal(await isLinuxAutostartEnabled(homeDirectory), true);

  const contents = await fs.readFile(desktopFilePath(homeDirectory), 'utf8');
  assert.match(contents, /^\[Desktop Entry\]/);
  assert.match(contents, /^Type=Application$/m);
  assert.match(contents, /^Exec=\/opt\/PortPatch\/portpatch --hidden$/m);
  assert.match(contents, /^X-GNOME-Autostart-enabled=true$/m);

  if (process.platform !== 'win32') {
    const stat = await fs.stat(desktopFilePath(homeDirectory));
    assert.equal(stat.mode & 0o777, 0o644);
  }
});

test('disabling autostart removes the desktop entry and is idempotent', async (context) => {
  const homeDirectory = await tempHome();
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  await setLinuxAutostart(homeDirectory, true, { execPath: '/usr/bin/portpatch' });
  assert.equal(await isLinuxAutostartEnabled(homeDirectory), true);

  await setLinuxAutostart(homeDirectory, false);
  assert.equal(await isLinuxAutostartEnabled(homeDirectory), false);

  await assert.doesNotReject(setLinuxAutostart(homeDirectory, false));
});

test('enabling without an executable path fails instead of writing a broken entry', async (context) => {
  const homeDirectory = await tempHome();
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  await assert.rejects(setLinuxAutostart(homeDirectory, true, {}));
  assert.equal(await isLinuxAutostartEnabled(homeDirectory), false);
});

test('Exec arguments with reserved characters are quoted per the Desktop Entry Specification', () => {
  assert.equal(buildExecLine('/usr/bin/portpatch'), '/usr/bin/portpatch');
  assert.equal(
    buildExecLine('/opt/My App/portpatch', ['--hidden']),
    '"/opt/My App/portpatch" --hidden',
  );
  assert.equal(
    buildExecLine('/opt/weird"$`\\path/portpatch'),
    '"/opt/weird\\"\\$\\`\\\\path/portpatch"',
  );
});

test('the built entry never embeds unescaped double quotes from a quoted argument', () => {
  const entry = buildDesktopEntry('/opt/say "hi"/portpatch');
  const execLine = entry.split('\n').find((line) => line.startsWith('Exec='));
  assert.equal(execLine, 'Exec="/opt/say \\"hi\\"/portpatch"');
});
