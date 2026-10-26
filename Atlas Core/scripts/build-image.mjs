import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json')));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--allow-dirty', 'Unknown build argument');
assert.ok(!dirty || args.includes('--allow-dirty'), 'Release image build requires a clean committed checkout');
execFileSync('sudo', ['-n', 'docker', 'build', '--platform', manifest.atlasBuild.container.platform,
  '--build-arg', `ATLAS_NODE_IMAGE=${manifest.atlasBuild.container.image}`, '--build-arg', `ATLAS_SOURCE_REVISION=${revision}`,
  '--build-arg', `ATLAS_SOURCE_TREE=${tree}`, '--build-arg', `ATLAS_SOURCE_DIRTY=${dirty}`,
  '--iidfile', join(root, 'artifacts', 'image-id'), root], { cwd: root, stdio: 'inherit' });
