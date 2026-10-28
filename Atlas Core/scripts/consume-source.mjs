import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2, 'Supply source.tar and its paired release-manifest.json, or neither');
const archivePath = resolve(args[0] ?? join(root, 'artifacts', 'source.tar'));
const manifestPath = resolve(args[1] ?? join(root, 'artifacts', 'release-manifest.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const archive = await readFile(archivePath);
const release = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(hash(archive), release.sourceArchive.sha256, 'Release source archive hash mismatch');
assert.equal(archive.byteLength, release.sourceArchive.bytes);
assert.match(release.sourceRevision, /^[0-9a-f]{40}$/);
assert.match(release.sourceTree, /^[0-9a-f]{40}$/);
assert.equal(release.inputs.sourceRevision, release.sourceRevision);
assert.equal(release.inputs.sourceTree, release.sourceTree);
assert.equal(release.inputs.sourceDirty, false);
const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.deepEqual(release.protocol, expected.atlasBuild.protocol);
assert.deepEqual(release.inputs.protocol, release.protocol);
assert.ok(process.env.npm_execpath, 'Run through npm run release:consume');
const directory = await mkdtemp(join(tmpdir(), 'atlas-source-consumer-'));
try {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8' });
  assert.equal(git.error, undefined);
  assert.notEqual(git.status, 0, 'Release consumer must run outside any ancestor Git checkout');
  execFileSync('tar', ['-xf', archivePath, '-C', directory], { cwd: directory, stdio: 'inherit' });
  const source = join(directory, 'atlas');
  const core = join(source, 'Atlas Core');
  for (const layer of ['Atlas Core', 'Atlas Protocol']) {
    for (const name of ['package.json', 'package-lock.json']) {
      const actual = await readFile(join(source, layer, name));
      const original = await readFile(join(root, '..', layer, name));
      assert.equal(hash(actual), hash(original), `Released ${layer}/${name} differs from the locked input`);
    }
  }
  assert.equal(hash(await readFile(join(core, 'package-lock.json'))), release.inputs.lockSha256);
  const env = { ...process.env, ATLAS_SOURCE_REVISION: release.sourceRevision,
    ATLAS_SOURCE_TREE: release.sourceTree, ATLAS_SOURCE_DIRTY: 'false' };
  const npm = args => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: core, env, stdio: 'inherit' });
  npm(['run', 'protocol:prepare']);
  npm(['ci', '--include=dev', '--no-audit', '--no-fund']);
  npm(['run', 'build']);
  const built = JSON.parse(await readFile(join(core, 'artifacts', 'build-inputs.json'), 'utf8'));
  for (const name of ['sourceRevision', 'sourceTree', 'sourceDirty', 'lockSha256', 'schemaProfileSha256', 'openapiSha256', 'node', 'npm']) {
    assert.equal(built[name], release.inputs[name], name);
  }
  for (const name of ['protocol', 'packages', 'sqlite']) assert.deepEqual(built[name], release.inputs[name], name);
  await readFile(join(core, 'dist', 'runtime.js'));
  await readFile(join(core, 'dist', 'cli.js'));
  console.log('Built the released Core and Protocol outside Git with the original locked hashes and paired release provenance');
} finally {
  await rm(directory, { recursive: true, force: true });
}
