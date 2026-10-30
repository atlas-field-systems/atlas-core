import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@atlas/protocol';

const root = new URL('../', import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const manifest = await json('package.json');
const lock = await json('package-lock.json');
const core = await json('../Atlas Core/package.json');
assert.equal(process.versions.node, manifest.engines.node);
assert.ok(process.env.npm_execpath, 'Run through npm');
assert.equal(
  execFileSync(process.execPath, [process.env.npm_execpath, '--version'], {
    encoding: 'utf8',
  }).trim(),
  manifest.engines.npm,
);
assert.equal(manifest.packageManager, `npm@${manifest.engines.npm}`);
assert.deepEqual(manifest.atlasBuild.protocol, core.atlasBuild.protocol);
assert.equal(PROTOCOL_VERSION, manifest.atlasBuild.protocol.version);
assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
const artifact = await readFile(new URL(manifest.dependencies['@atlas/protocol'].slice(5), root));
assert.equal(
  createHash('sha256').update(artifact).digest('hex'),
  manifest.atlasBuild.protocol.sha256,
);
assert.equal(
  `sha512-${createHash('sha512').update(artifact).digest('base64')}`,
  lock.packages['node_modules/@atlas/protocol'].integrity,
);
for (const [path, entry] of Object.entries(lock.packages)) {
  if (path) assert.match(entry.integrity, /^sha512-/);
}
for (const [name, version] of Object.entries({
  ...manifest.dependencies,
  ...manifest.devDependencies,
})) {
  const installed = await json(`node_modules/${name}/package.json`);
  const expected = name === '@atlas/protocol' ? PROTOCOL_VERSION : version;
  assert.equal(installed.version, expected);
  assert.equal(lock.packages[`node_modules/${name}`].version, expected);
}
const installedProtocol = new URL('../node_modules/@atlas/protocol/', import.meta.url);
const artifactPath = fileURLToPath(
  new URL(manifest.dependencies['@atlas/protocol'].slice(5), root),
);
const listing = execFileSync('tar', ['-tzf', artifactPath], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');
for (const path of listing.filter(
  (path) => path.startsWith('package/dist/') && !path.endsWith('/'),
)) {
  const packed = execFileSync('tar', ['-xOzf', artifactPath, path], {
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.deepEqual(await readFile(new URL(path.slice(8), installedProtocol)), packed, path);
}
console.log(
  `Verified SDK inputs and installed Protocol bytes, SHA-256 ${manifest.atlasBuild.protocol.sha256}`,
);
