import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createQualification } from './qualification-evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = await realpath(new URL('../../', import.meta.url));
const parent = resolve(process.env.ATLAS_TEST_ROOT ?? tmpdir());
await mkdir(parent, { recursive: true });
const location = relative(workspace, await realpath(parent));
assert.ok(
  location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location),
  'Use an external ATLAS_TEST_ROOT',
);
const directory = await mkdtemp(join(parent, 'sdk-browser-'));
console.log(`Browser qualification evidence: ${directory}`);
const consumer = join(directory, 'consumer');
await mkdir(join(consumer, 'artifacts'), { recursive: true });
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.ok(process.env.npm_execpath, 'Run through npm');
const qualification = await createQualification(directory, 'browser', root);
const { report, run } = qualification;
const npm = (name, args, cwd = consumer, capture = false) =>
  run(name, [process.execPath, process.env.npm_execpath, ...args], {
    cwd,
    capture,
    env: {
      ...process.env,
      npm_config_cache: process.env.npm_config_cache ?? join(directory, 'npm-cache'),
    },
  });
let failure;
try {
  for (const name of ['typescript', 'esbuild']) {
    report.evidence.tools[name] = JSON.parse(
      await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'),
    ).version;
  }
  await npm('build', ['run', 'build'], root);
  const [packed] = JSON.parse(
    await npm(
      'pack',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', consumer],
      root,
      true,
    ),
  );
  await qualification.artifact(join(consumer, packed.filename));
  assert.ok(packed.files.some((file) => file.path === 'dist/index.js'));
  assert.ok(packed.files.every((file) => !/^(src|test|node_modules)\//.test(file.path)));
  await copyFile(
    join(root, 'artifacts/atlas-protocol-0.6.0.tgz'),
    join(consumer, 'artifacts/atlas-protocol-0.6.0.tgz'),
  );
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@atlas/sdk': `file:${packed.filename}`,
        '@atlas/protocol': 'file:artifacts/atlas-protocol-0.6.0.tgz',
        typescript: manifest.devDependencies.typescript,
      },
    }),
  );
  await npm('install', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
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
  await run(
    'positive-types',
    [
      process.execPath,
      join(consumer, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(consumer, 'tsconfig.json'),
    ],
    { cwd: consumer },
  );
  await run(
    'bundle',
    [
      process.execPath,
      join(root, 'node_modules/esbuild/bin/esbuild'),
      'workflows.mjs',
      '--bundle',
      '--platform=browser',
      '--format=esm',
      '--outfile=browser.mjs',
      `--metafile=${join(directory, 'browser-metafile.json')}`,
    ],
    { cwd: consumer },
  );
  const metafile = JSON.parse(await readFile(join(directory, 'browser-metafile.json'), 'utf8'));
  const inputs = Object.keys(metafile.inputs);
  assert.ok(inputs.some((path) => path.includes('node_modules/@atlas/sdk/dist/index.js')));
  assert.ok(
    inputs.every((path) => !/node:|Atlas Core|@atlas\/core|zod-openapi|\/reference[/.]/.test(path)),
  );
  assert.ok(Object.values(metafile.outputs).every((output) => output.imports.length === 0));
  await qualification.retain(join(directory, 'browser-metafile.json'));
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
  await run('firefox', [process.execPath, '--test', join(root, 'test/browser-runtime.mjs')], {
    env: { ...process.env, ATLAS_BROWSER_DIRECTORY: directory, TMPDIR: directory },
  });
  Object.assign(report, JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')));
  report.testProcessExited = true;
  for (const name of ['runtime.json', 'traffic.json', 'profile-trust.txt'])
    await qualification.retain(join(directory, name));
} catch (error) {
  failure = error;
  console.error(error);
  process.exitCode = error.exitCode ?? 1;
} finally {
  try {
    await qualification.finish(failure);
  } catch (error) {
    console.error('Could not finalize qualification evidence', error);
    process.exitCode ||= 1;
  }
}
