import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json')));
const version = manifest.atlasBuild.npm.version;
await mkdir(join(root, 'artifacts'), { recursive: true });
if (!process.argv.includes('--verify')) {
  assert.ok(process.env.npm_execpath);
  execFileSync(process.execPath, [process.env.npm_execpath, 'pack', `npm@${version}`, '--pack-destination', join(root, 'artifacts'), '--ignore-scripts', '--cache', join(root, 'artifacts', 'npm-cache')], { cwd: root, stdio: 'pipe' });
}
const bytes = await readFile(join(root, 'artifacts', `npm-${version}.tgz`));
assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, manifest.atlasBuild.npm.integrity);
process.stdout.write(`Verified npm ${version} artifact\n`);
