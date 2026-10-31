import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
assert.ok(process.env.npm_execpath, 'Run through npm run operator:prepare');
assert.equal(process.versions.node, '24.22.1');
assert.equal(
  execFileSync(process.execPath, [process.env.npm_execpath, '--version'], {
    encoding: 'utf8',
  }).trim(),
  '11.19.0',
);
execFileSync(
  process.execPath,
  [process.env.npm_execpath, 'ci', '--prefix', 'operator', '--include=dev', '--ignore-scripts'],
  { cwd: root, stdio: 'inherit' },
);
