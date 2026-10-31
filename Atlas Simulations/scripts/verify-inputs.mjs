import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const json = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const manifest = await json('package.json'),
  lock = await json('package-lock.json');
assert.equal(process.versions.node, manifest.engines.node);
assert.ok(process.env.npm_execpath, 'Run through npm');
assert.equal(
  execFileSync(process.execPath, [process.env.npm_execpath, '--version'], {
    encoding: 'utf8',
  }).trim(),
  manifest.engines.npm,
);
assert.deepEqual(
  manifest.atlasBuild.protocol,
  (await json('../Atlas Core/package.json')).atlasBuild.protocol,
);
assert.deepEqual(manifest.dependencies, lock.packages[''].dependencies);
assert.deepEqual(manifest.devDependencies, lock.packages[''].devDependencies);
for (const [name, version] of Object.entries({
  ...manifest.dependencies,
  ...manifest.devDependencies,
})) {
  const entry = lock.packages[`node_modules/${name}`];
  assert.match(entry.integrity, /^sha512-/);
  assert.equal((await json(`node_modules/${name}/package.json`)).version, entry.version);
  if (!version.startsWith('file:')) {
    assert.equal(version, entry.version);
    continue;
  }
  const path = fileURLToPath(new URL(version.slice(5), root));
  const bytes = await readFile(path);
  assert.equal(entry.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  if (name === '@atlas/protocol')
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      manifest.atlasBuild.protocol.sha256,
    );
  const listing = execFileSync('tar', ['-tzf', path], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
    .trim()
    .split('\n');
  assert.ok(
    listing.every((p) => !/^package\/(src|test)\//.test(p)),
    'Archive contains private sources',
  );
  for (const item of listing.filter((p) => p.startsWith('package/dist/') && !p.endsWith('/'))) {
    assert.deepEqual(
      await readFile(new URL(`node_modules/${name}/${item.slice(8)}`, root)),
      execFileSync('tar', ['-xOzf', path, item], { maxBuffer: 8 * 1024 * 1024 }),
    );
  }
}
async function boundary(dir) {
  for (const item of await readdir(new URL(dir, root), { withFileTypes: true })) {
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) await boundary(path);
    else if (/\.[cm]?[jt]s$/.test(path)) {
      const text = await readFile(new URL(path, root), 'utf8');
      assert.ok(
        !/(?:import|export).*?(?:Atlas Core|Atlas SDK\/(?:src|test)|@atlas\/(?:core|sdk)\/(?:src|test))/.test(
          text,
        ),
        `Private import in ${path}`,
      );
    }
  }
}
await boundary('src');
process.stdout.write(
  'Verified pinned tools, archives, installed bytes and public import boundary\n',
);
