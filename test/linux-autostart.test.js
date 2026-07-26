'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  autostartDirectory,
  buildDesktopEntry,
  buildExecLine,
  desktopFilePath,
  isLinuxAutostartEnabled,
  resolveLinuxExecutablePath,
  setLinuxAutostart,
} = require('../src/core/linux-autostart');

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'portpatch-autostart-'));
}

test('enabling autostart writes a spec-compliant desktop entry at the XDG path', async (context) => {
  const homeDirectory = await tempHome();
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  assert.equal(await isLinuxAutostartEnabled(homeDirectory, { env: {} }), false);
  await setLinuxAutostart(homeDirectory, true, { execPath: '/opt/PortPatch/portpatch', args: ['--hidden'], env: {} });
  assert.equal(await isLinuxAutostartEnabled(homeDirectory, { env: {} }), true);

  const contents = await fs.readFile(desktopFilePath(homeDirectory, { env: {} }), 'utf8');
  assert.match(contents, /^\[Desktop Entry\]/);
  assert.match(contents, /^Type=Application$/m);
  assert.match(contents, /^Exec=\/opt\/PortPatch\/portpatch --hidden$/m);
  assert.match(contents, /^X-GNOME-Autostart-enabled=true$/m);

  if (process.platform !== 'win32') {
    const stat = await fs.stat(desktopFilePath(homeDirectory, { env: {} }));
    assert.equal(stat.mode & 0o777, 0o644);
  }
});

test('disabling autostart removes the desktop entry and is idempotent', async (context) => {
  const homeDirectory = await tempHome();
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  await setLinuxAutostart(homeDirectory, true, { execPath: '/usr/bin/portpatch', env: {} });
  assert.equal(await isLinuxAutostartEnabled(homeDirectory, { env: {} }), true);

  await setLinuxAutostart(homeDirectory, false, { env: {} });
  assert.equal(await isLinuxAutostartEnabled(homeDirectory, { env: {} }), false);

  await assert.doesNotReject(setLinuxAutostart(homeDirectory, false, { env: {} }));
});

test('enabling without an executable path fails instead of writing a broken entry', async (context) => {
  const homeDirectory = await tempHome();
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  await assert.rejects(setLinuxAutostart(homeDirectory, true, { env: {} }));
  assert.equal(await isLinuxAutostartEnabled(homeDirectory, { env: {} }), false);
});

test('XDG_CONFIG_HOME overrides the default ~/.config location', () => {
  assert.equal(
    autostartDirectory('/home/alice', { env: {} }),
    path.join('/home/alice', '.config', 'autostart'),
  );
  assert.equal(
    autostartDirectory('/home/alice', { env: { XDG_CONFIG_HOME: '/mnt/config' } }),
    path.join('/mnt/config', 'autostart'),
  );
  assert.equal(
    autostartDirectory('/home/alice', { env: { XDG_CONFIG_HOME: '' } }),
    path.join('/home/alice', '.config', 'autostart'),
  );
});

test('a relative XDG_CONFIG_HOME is treated as invalid per the XDG Base Directory Specification', () => {
  assert.equal(
    autostartDirectory('/home/alice', { env: { XDG_CONFIG_HOME: 'relative/config' } }),
    path.join('/home/alice', '.config', 'autostart'),
  );
  assert.equal(
    autostartDirectory('/home/alice', { env: { XDG_CONFIG_HOME: '~/config' } }),
    path.join('/home/alice', '.config', 'autostart'),
  );
});

test('resolveLinuxExecutablePath prefers the AppImage runtime path over process.execPath', () => {
  assert.equal(
    resolveLinuxExecutablePath({
      env: { APPIMAGE: '/home/alice/Apps/PortPatch.AppImage' },
      execPath: '/tmp/.mount_abc123/portpatch',
    }),
    '/home/alice/Apps/PortPatch.AppImage',
  );
  assert.equal(
    resolveLinuxExecutablePath({ env: {}, execPath: '/opt/PortPatch/portpatch' }),
    '/opt/PortPatch/portpatch',
  );
  assert.equal(
    typeof resolveLinuxExecutablePath({ env: {} }),
    'string',
  );
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

test('a literal percent sign is escaped so it cannot be read as a field code', () => {
  assert.equal(
    buildExecLine('/home/user/100%free/PortPatch.AppImage'),
    '/home/user/100%%free/PortPatch.AppImage',
  );
  assert.equal(
    buildExecLine('/home/user/100% free/PortPatch.AppImage'),
    '"/home/user/100%% free/PortPatch.AppImage"',
  );
});
