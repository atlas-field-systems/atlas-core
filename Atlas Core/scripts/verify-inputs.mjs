import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { PROTOCOL_VERSION } from '@atlas/protocol';
import { exportReference } from '@atlas/protocol/reference';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lockBytes = await readFile(join(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.ok(process.env.npm_execpath, 'Run through npm run verify:inputs');
const npm = execFileSync(process.execPath, [process.env.npm_execpath, '--version'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
assert.equal(process.versions.node, manifest.engines.node, 'Use the pinned Node version');
assert.equal(npm, manifest.engines.npm, 'Use the pinned npm version');
assert.equal(manifest.packageManager, `npm@${npm}`);
assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
for (const [path, entry] of Object.entries(lock.packages)) {
  if (path !== '') assert.match(entry.integrity, /^sha512-/, path);
}
for (const [name, version] of Object.entries({
  ...manifest.dependencies,
  ...manifest.devDependencies,
})) {
  const installed = JSON.parse(
    await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'),
  );
  const expected = name === '@atlas/protocol' ? manifest.atlasBuild.protocol.version : version;
  assert.match(expected, /^\d+\.\d+\.\d+$/, name);
  assert.equal(lock.packages[`node_modules/${name}`].version, expected, name);
  assert.equal(installed.version, expected, name);
}
assert.equal(PROTOCOL_VERSION, manifest.atlasBuild.protocol.version);
const artifact = await readFile(
  join(root, manifest.dependencies['@atlas/protocol'].slice('file:'.length)),
);
assert.equal(
  hash(artifact),
  manifest.atlasBuild.protocol.sha256,
  'Protocol artifact hash mismatch',
);
assert.equal(
  `sha512-${createHash('sha512').update(artifact).digest('base64')}`,
  lock.packages['node_modules/@atlas/protocol'].integrity,
);
const db = new Database(':memory:');
let sqlite;
try {
  sqlite = {
    ...db.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get(),
    compileOptions: db
      .pragma('compile_options')
      .map((row) => row.compile_options)
      .sort(),
  };
  assert.equal(sqlite.version, manifest.atlasBuild.sqlite.version);
  assert.equal(sqlite.sourceId, manifest.atlasBuild.sqlite.sourceId);
} finally {
  db.close();
}
const report = {
  sourceRevision: process.env.ATLAS_SOURCE_REVISION ?? execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  sourceTree: process.env.ATLAS_SOURCE_TREE ?? execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: process.env.ATLAS_SOURCE_DIRTY === undefined ? execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim().length > 0 : process.env.ATLAS_SOURCE_DIRTY !== 'false',
  target: { os: process.platform, architecture: process.arch },
  node: process.versions.node,
  npm,
  protocol: manifest.atlasBuild.protocol,
  schemaProfileSha256: hash(
    await readFile(join(root, 'node_modules', '@atlas/protocol', 'schema-profile.md')),
  ),
  openapiSha256: hash(exportReference()),
  lockSha256: hash(lockBytes),
  packages: Object.fromEntries(
    Object.entries(lock.packages)
      .filter(([path]) => path !== '')
      .map(([path, entry]) => [path, entry.version]),
  ),
  sqlite,
};
await mkdir(join(root, 'artifacts'), { recursive: true });
await writeFile(
  join(root, 'artifacts', 'build-inputs.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  `Verified ${Object.keys(report.packages).length} locked packages, Protocol ${PROTOCOL_VERSION}, SQLite ${sqlite.version}`,
);
