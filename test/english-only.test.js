'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.svg', '.yaml', '.yml']);
const roots = ['src', 'scripts', 'docs'];
const topLevelFiles = ['README.md', 'package.json', 'pnpm-workspace.yaml'];

function collectTextFiles(entry) {
  const absolute = path.join(root, entry);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return textExtensions.has(path.extname(entry)) ? [entry] : [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((item) => {
    const child = path.join(entry, item.name);
    return item.isDirectory() ? collectTextFiles(child) : collectTextFiles(child);
  });
}

test('shipped program text and documentation are English-only ASCII', () => {
  const files = [...roots.flatMap(collectTextFiles), ...topLevelFiles];
  const failures = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (/[^\x00-\x7F]/u.test(line)) failures.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(failures, [], `Non-ASCII text found in:\n${failures.join('\n')}`);
});
