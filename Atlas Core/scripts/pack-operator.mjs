import assert from 'node:assert/strict';
import { build } from '../operator/node_modules/esbuild/lib/main.js';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir, copyFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { join, basename, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ReleaseMetadata, RegistryReference } from '../dist/release.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.ok(process.env.npm_execpath, 'Run through npm run operator:pack');
assert.equal(process.versions.node, '24.22.1');
assert.equal(
  execFileSync(process.execPath, [process.env.npm_execpath, '--version'], {
    encoding: 'utf8',
  }).trim(),
  '11.19.0',
);
const tools = JSON.parse(await readFile(join(root, 'operator/package.json')));
const lock = JSON.parse(await readFile(join(root, 'operator/package-lock.json')));
assert.deepEqual(lock.packages[''].dependencies, tools.dependencies);
assert.deepEqual(lock.packages[''].devDependencies, tools.devDependencies);
for (const [name, version] of Object.entries({ ...tools.dependencies, ...tools.devDependencies })) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    JSON.parse(await readFile(join(root, 'operator/node_modules', name, 'package.json'))).version,
    version,
  );
}
for (const [path, entry] of Object.entries(lock.packages))
  if (path !== '') assert.match(entry.integrity, /^sha512-/);
const destination = process.env.ATLAS_OPERATOR_OUT ?? join(root, 'artifacts');
assert.ok(isAbsolute(destination));
const image =
  process.env.ATLAS_OPERATOR_IMAGE ??
  (await readFile(join(root, 'artifacts/image-id'), 'utf8')).trim();
const name = process.env.ATLAS_OPERATOR_NPM_NAME ?? null;
if (name !== null) assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/);
const metadata = ReleaseMetadata.parse({
  format: 1,
  release: '0.4.0',
  protocol: '0.4.0',
  databaseFormat: '5',
  platform: 'linux/amd64',
  node: '24.22.1',
  npm: '11.19.0',
  sourceRevision: git('rev-parse', 'HEAD'),
  sourceTree: git('rev-parse', 'HEAD^{tree}'),
  sourceDirty: git('status', '--porcelain').length > 0,
  image,
  imageReference: process.env.ATLAS_OPERATOR_IMAGE_REFERENCE
    ? RegistryReference.parse(process.env.ATLAS_OPERATOR_IMAGE_REFERENCE)
    : null,
  npmName: name,
  packagePrivate: name === null,
});
if (name !== null)
  assert.equal(metadata.sourceDirty, false, 'Named release requires clean committed source');
const stage = await mkdtemp(join(process.env.ATLAS_TEST_ROOT ?? tmpdir(), 'atlas-operator-pack-'));
await mkdir(join(stage, 'dist'));
const bundle = await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outdir: join(stage, 'dist'),
  bundle: true,
  jsx: 'automatic',
  splitting: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  target: 'node24',
  metafile: true,
  nodePaths: [join(root, 'operator/node_modules')],
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    'process.env.DEV': 'false',
    'process.env.NODE_ENV': '"production"',
  },
  plugins: [
    {
      name: 'operator-source',
      setup(builder) {
        builder.onResolve({ filter: /tui\.js$/ }, () => ({ path: join(root, 'operator/tui.tsx') }));
        builder.onResolve({ filter: /^\.\.\/src\// }, ({ path }) => ({
          path: join(root, 'src', basename(path).replace(/\.js$/, '.ts')),
        }));
      },
    },
  ],
  banner: {
    js: "import { createRequire as operatorRequire } from 'node:module'; const require = operatorRequire(import.meta.url);",
  },
});
const allowed = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
for (const path of Object.keys(bundle.metafile.inputs)) {
  assert.ok(
    !/(?:better-sqlite3|\.node$)/.test(path) &&
      (path.includes('node_modules/') ||
        !/(?:^|\/)(?:database|rpc|worker|objects)\.[jt]s$/.test(path)),
    `Server dependency in operator graph: ${path}`,
  );
}
for (const output of Object.values(bundle.metafile.outputs))
  for (const imported of output.imports)
    if (imported.external)
      assert.ok(allowed.has(imported.path), `Unbundled output dependency: ${imported.path}`);
await writeFile(join(stage, 'dist/operator-release.json'), JSON.stringify(metadata) + '\n');
const packageManifest = {
  name: name ?? '@atlas/core-operator-qualification',
  version: metadata.release,
  private: name === null,
  type: 'module',
  engines: { node: metadata.node, npm: metadata.npm },
  bin: { 'atlas-core': './dist/cli.js' },
  files: ['dist', 'LICENSES'],
  dependencies: {},
};
await writeFile(join(stage, 'package.json'), JSON.stringify(packageManifest, null, 2) + '\n');
await chmod(join(stage, 'dist/cli.js'), 0o755);
await mkdir(join(stage, 'LICENSES'));
for (const modules of [join(root, 'node_modules'), join(root, 'operator/node_modules')]) {
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const packages = entry.name.startsWith('@')
      ? (await readdir(join(modules, entry.name))).map((child) => `${entry.name}/${child}`)
      : [entry.name];
    for (const dependency of packages) {
      if (dependency.includes('better-sqlite3')) continue;
      for (const file of await readdir(join(modules, dependency))) {
        if (/^licen[cs]e(?:\.|$)/i.test(file))
          await copyFile(
            join(modules, dependency, file),
            join(stage, 'LICENSES', dependency.replaceAll('/', '_') + '-' + file),
          );
      }
    }
  }
}
await mkdir(destination, { recursive: true });
const packed = JSON.parse(
  execFileSync(
    process.execPath,
    [
      process.env.npm_execpath,
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      destination,
    ],
    { cwd: stage, encoding: 'utf8' },
  ),
);
assert.equal(packed.length, 1);
const file = basename(packed[0].filename);
const bytes = await readFile(join(destination, file));
const artifact = {
  name,
  private: name === null,
  file,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
  nativeAddons: [],
};
const verifierBytes = await readFile(join(root, 'scripts/verify-operator-tarball.mjs'));
await writeFile(join(destination, 'verify-operator-tarball.mjs'), verifierBytes);
const verifier = {
  file: 'verify-operator-tarball.mjs',
  sha256: createHash('sha256').update(verifierBytes).digest('hex'),
  bytes: verifierBytes.length,
};
await writeFile(
  join(destination, 'operator-manifest.json'),
  JSON.stringify({ ...metadata, operatorPackage: artifact, verifier }, null, 2) + '\n',
);
await writeFile(
  join(destination, 'operator-graph.json'),
  JSON.stringify(bundle.metafile, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(artifact) + '\n');
