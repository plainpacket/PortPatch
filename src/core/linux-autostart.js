'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('./atomic-file');

const DESKTOP_FILE_NAME = 'io.github.plainpacket.portpatch.desktop';
const NEEDS_QUOTING = /[\s"'\\><~|&;$*?#()`]/;

// The XDG Base Directory Specification requires these paths to be absolute and
// says a relative value should be treated as invalid, i.e. ignored like unset.
function autostartDirectory(homeDirectory, options = {}) {
  const environment = options.env || process.env;
  const xdgConfigHome = environment.XDG_CONFIG_HOME;
  const configHome = xdgConfigHome && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(homeDirectory, '.config');
  return path.join(configHome, 'autostart');
}

function desktopFilePath(homeDirectory, options = {}) {
  return path.join(autostartDirectory(homeDirectory, options), DESKTOP_FILE_NAME);
}

// The AppImage runtime sets APPIMAGE to the original file's stable path before
// exec'ing the wrapped binary. process.execPath instead resolves to a path under
// a per-launch /tmp/.mount_* FUSE mount that stops existing once the app exits,
// so an autostart entry written with it would point nowhere after a reboot.
function resolveLinuxExecutablePath(options = {}) {
  const environment = options.env || process.env;
  const fallback = options.execPath || process.execPath;
  return environment.APPIMAGE || fallback;
}

// Desktop Entry Spec quoting: values run through the launcher's own tokenizer,
// never a shell, so this only has to satisfy that spec, not prevent shell injection.
// Separately, a literal "%" must always become "%%" -- otherwise a path like
// .../100%free/... would have "%f" read as a field code substitution, regardless
// of whether the surrounding value ends up quoted.
function quoteExecArgument(value) {
  const text = String(value).replace(/%/g, '%%');
  if (!NEEDS_QUOTING.test(text)) return text;
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  return `"${escaped}"`;
}

function buildExecLine(execPath, args = []) {
  return [execPath, ...args].map(quoteExecArgument).join(' ');
}

function buildDesktopEntry(execPath, args = []) {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=PortPatch',
    'Comment=Start PortPatch and resume active port routes',
    `Exec=${buildExecLine(execPath, args)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
  ];
  return `${lines.join('\n')}\n`;
}

async function isLinuxAutostartEnabled(homeDirectory, options = {}) {
  try {
    await fs.access(desktopFilePath(homeDirectory, options));
    return true;
  } catch {
    return false;
  }
}

async function setLinuxAutostart(homeDirectory, enabled, options = {}) {
  const filePath = desktopFilePath(homeDirectory, options);
  if (!enabled) {
    await fs.rm(filePath, { force: true });
    return;
  }
  if (!options.execPath) throw new Error('An executable path is required to enable autostart.');
  await atomicWriteFile(filePath, buildDesktopEntry(options.execPath, options.args || []), { mode: 0o644 });
}

module.exports = {
  autostartDirectory,
  desktopFilePath,
  buildDesktopEntry,
  buildExecLine,
  isLinuxAutostartEnabled,
  resolveLinuxExecutablePath,
  setLinuxAutostart,
};
