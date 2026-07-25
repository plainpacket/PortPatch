'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('./atomic-file');

const DESKTOP_FILE_NAME = 'io.github.plainpacket.portpatch.desktop';
const NEEDS_QUOTING = /[\s"'\\><~|&;$*?#()`]/;

function autostartDirectory(homeDirectory) {
  return path.join(homeDirectory, '.config', 'autostart');
}

function desktopFilePath(homeDirectory) {
  return path.join(autostartDirectory(homeDirectory), DESKTOP_FILE_NAME);
}

// Desktop Entry Spec quoting: values run through the launcher's own tokenizer,
// never a shell, so this only has to satisfy that spec, not prevent shell injection.
function quoteExecArgument(value) {
  const text = String(value);
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

async function isLinuxAutostartEnabled(homeDirectory) {
  try {
    await fs.access(desktopFilePath(homeDirectory));
    return true;
  } catch {
    return false;
  }
}

async function setLinuxAutostart(homeDirectory, enabled, options = {}) {
  const filePath = desktopFilePath(homeDirectory);
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
  setLinuxAutostart,
};
