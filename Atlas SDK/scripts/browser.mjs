import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = await realpath(new URL('../../', import.meta.url));
const parent = resolve(process.env.ATLAS_TEST_ROOT ?? tmpdir());
await mkdir(parent, { recursive: true });
const location = relative(workspace, await realpath(parent));
assert.ok(location.startsWith('../') || isAbsolute(location), 'Use an external ATLAS_TEST_ROOT');
const directory = await mkdtemp(join(parent, 'sdk-browser-'));
console.log(`Browser qualification evidence: ${directory}`);
const consumer = join(directory, 'consumer');
await mkdir(join(consumer, 'artifacts'), { recursive: true });
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.ok(process.env.npm_execpath, 'Run through npm');
const npm = (args, cwd = consumer) =>
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      npm_config_cache: process.env.npm_config_cache ?? join(directory, 'npm-cache'),
    },
  });
const [packed] = JSON.parse(
  npm(['pack', '--json', '--ignore-scripts', '--pack-destination', consumer], root),
);
assert.ok(packed.files.some((file) => file.path === 'dist/index.js'));
assert.ok(packed.files.every((file) => !/^(src|test|node_modules)\//.test(file.path)));
await copyFile(
  join(root, 'artifacts/atlas-protocol-0.3.0.tgz'),
  join(consumer, 'artifacts/atlas-protocol-0.3.0.tgz'),
);
await writeFile(
  join(consumer, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@atlas/sdk': `file:${packed.filename}`,
      '@atlas/protocol': 'file:artifacts/atlas-protocol-0.3.0.tgz',
      typescript: manifest.devDependencies.typescript,
    },
  }),
);
await writeFile(
  join(directory, 'install.log'),
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund']),
);
await copyFile(join(root, 'test/browser-workflows.mjs'), join(consumer, 'workflows.mjs'));
await copyFile(join(root, 'test/transfers-browser.mjs'), join(consumer, 'transfers-browser.mjs'));
await writeFile(
  join(consumer, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      exactOptionalPropertyTypes: true,
      allowJs: true,
      checkJs: true,
      noEmit: true,
      types: [],
      lib: ['ES2022', 'DOM'],
    },
    files: ['workflows.mjs'],
  }),
);
execFileSync(
  process.execPath,
  [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')],
  { stdio: 'inherit' },
);
const bundled = await build({
  absWorkingDir: consumer,
  entryPoints: ['workflows.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: join(consumer, 'browser.mjs'),
  metafile: true,
});
const inputs = Object.keys(bundled.metafile.inputs);
assert.ok(inputs.some((path) => path.includes('node_modules/@atlas/sdk/dist/index.js')));
assert.ok(
  inputs.every((path) => !/node:|Atlas Core|@atlas\/core|zod-openapi|\/reference[/.]/.test(path)),
);
assert.ok(Object.values(bundled.metafile.outputs).every((output) => output.imports.length === 0));
await writeFile(
  join(directory, 'browser-metafile.json'),
  JSON.stringify(bundled.metafile, null, 2),
);
await writeFile(
  join(directory, 'package.json'),
  JSON.stringify(
    {
      node: process.versions.node,
      command: 'npm run test:browser',
      platform: `${process.platform}/${process.arch}`,
      artifact: join(consumer, packed.filename),
      consumer,
      typedBrowserWorkflows: true,
      browserBundle: true,
      protocol: manifest.atlasBuild.protocol,
    },
    null,
    2,
  ),
);
const child = spawn(process.execPath, ['--test', join(root, 'test/browser-runtime.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ATLAS_BROWSER_DIRECTORY: directory, TMPDIR: directory },
});
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
});
if (code === 0) {
  const report = JSON.parse(await readFile(join(directory, 'qualification.json'), 'utf8'));
  report.testProcessExited = true;
  await writeFile(join(directory, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = code;
