import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const protocol = fileURLToPath(new URL('../../Atlas Protocol/', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.ok(process.env.npm_execpath, 'Run through npm run protocol:prepare');
const run = (args, options = {}) =>
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
assert.equal(process.versions.node, manifest.engines.node, 'Use the pinned Node version');
assert.equal(run(['--version'], { encoding: 'utf8', stdio: 'pipe' }).trim(), manifest.engines.npm);
const source = JSON.parse(await readFile(join(protocol, 'package.json'), 'utf8'));
assert.equal(source.name, '@atlas/protocol');
assert.equal(source.version, manifest.atlasBuild.protocol.version);
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
run([
  '--prefix',
  protocol,
  'ci',
  '--include=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--cache',
  join(artifacts, 'npm-cache'),
]);
await rm(join(protocol, 'dist'), { recursive: true, force: true });
run(['--prefix', protocol, 'run', 'build']);
const staging = await mkdtemp(join(artifacts, 'protocol-'));
try {
  const [packed] = JSON.parse(
    run(['pack', protocol, '--json', '--ignore-scripts', '--pack-destination', staging], {
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  );
  assert.equal(packed.name, source.name);
  assert.equal(packed.version, source.version);
  assert.ok(packed.files.some((file) => file.path === 'dist/index.d.ts'));
  assert.ok(packed.files.every((file) => !file.path.startsWith('src/')));
  const artifact = join(staging, packed.filename);
  const sha256 = createHash('sha256')
    .update(await readFile(artifact))
    .digest('hex');
  assert.equal(
    sha256,
    manifest.atlasBuild.protocol.sha256,
    'Protocol artifact differs from the pinned build',
  );
  await copyFile(
    artifact,
    join(root, manifest.dependencies['@atlas/protocol'].slice('file:'.length)),
  );
  console.log(`Prepared ${packed.name}@${packed.version}, SHA-256 ${sha256}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
