import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [flag, base, mode] = process.argv.slice(2);
assert.ok(
  flag === '--base' && /^[0-9a-f]{40}$/.test(base) && [undefined, '--write'].includes(mode),
  'Usage: node scripts/format.mjs --base <full-comparison-commit> [--write]',
);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
assert.equal(git('rev-parse', `${base}^{commit}`).trim(), base, 'Comparison base must be a commit');
assert.notEqual(git('rev-parse', 'HEAD').trim(), base, 'Comparison base must precede HEAD');
git('merge-base', '--is-ancestor', base, 'HEAD');
const prettier = join(root, 'Atlas Protocol/node_modules/prettier');
assert.equal(JSON.parse(await readFile(join(prettier, 'package.json'), 'utf8')).version, '3.8.1');
const code = /\.(?:[cm]?js|tsx?)$/;
const sdk = [];
async function collect(path) {
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await collect(child);
    else if (entry.isFile() && code.test(child)) sdk.push(child);
  }
}
for (const part of ['src', 'scripts', 'test']) {
  await collect(`Atlas SDK/${part}`);
  await collect(`Atlas Simulations/${part}`);
}
const core = [
  ...new Set([
    ...git('diff', '--name-only', '-z', '--diff-filter=ACMR', base, '--', 'Atlas Core').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z', '--', 'Atlas Core').split('\0'),
  ]),
].filter((path) => /^Atlas Core\/(src|scripts|test)\//.test(path) && code.test(path));
const paths = ['scripts/format.mjs', ...sdk.sort(), ...core.sort()];
console.log(
  `Format base ${base}: all ${sdk.length} SDK code files, ${core.length} changed Core code files`,
);
const result = spawnSync(
  process.execPath,
  [
    join(prettier, 'bin/prettier.cjs'),
    '--config',
    join(root, 'Atlas Protocol/.prettierrc.json'),
    mode ?? '--check',
    ...paths,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
