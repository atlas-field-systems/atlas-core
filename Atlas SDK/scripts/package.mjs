import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const consumer = await mkdtemp(join(parent, 'sdk-consumer-'));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.ok(process.env.npm_execpath, 'Run through npm');
const qualification = await createQualification(consumer, 'package', root);
const { report, run } = qualification;
const npm = (name, args, cwd = consumer, capture = false) =>
  run(name, [process.execPath, process.env.npm_execpath, ...args], {
    cwd,
    capture,
    env: {
      ...process.env,
      npm_config_cache: process.env.npm_config_cache ?? join(consumer, 'npm-cache'),
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
  await mkdir(join(consumer, 'artifacts'));
  await copyFile(
    join(root, 'artifacts/atlas-protocol-0.5.0.tgz'),
    join(consumer, 'artifacts/atlas-protocol-0.5.0.tgz'),
  );
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@atlas/sdk': `file:${packed.filename}`,
        '@atlas/protocol': 'file:artifacts/atlas-protocol-0.5.0.tgz',
        typescript: manifest.devDependencies.typescript,
      },
    }),
  );
  await npm('install', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  await writeFile(join(consumer, 'entry.mjs'), "export * from '@atlas/sdk';\n");
  const positive = `import { createClient, type DiagnosticEvent, type Prepared } from '@atlas/sdk';
import { Counter, NewId, type RequestOf, type ResponseOf, type Task } from '@atlas/protocol';
const id = NewId.parse('11111111-1111-4111-8111-111111111111');
const client = createClient({ baseUrl: 'https://localhost:8443', credentials: () => '', diagnostics: { mode: 'summary', observer: (event: DiagnosticEvent) => { if (event.kind === 'request') { const source: string = event.source; void source; } } } });
const operation: Prepared<RequestOf<'CreateTask'>, ResponseOf<'CreateTask'>> = client.tasks.create({
  request_id: id, task_id: id, asset_id: id, command: 'move_to', scheduling: 'queued',
  inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } },
});
const result = await operation.send();
if (result.attempt.kind === 'response' && result.attempt.response.kind === 'success') {
  const task: Task = result.attempt.response.body.data;
  const identifier: string = task.task_id;
  void identifier;
}
client.assets.list({ filters: { kinds: [null, 'tracker'], health: ['offline'] } });
client.assets.update({ request_id: id, asset_id: id, expected_edit_revision: Counter.parse('1'), alias: null });
await client.close();
`;
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    types: [],
    lib: ['ES2022', 'DOM'],
  };
  await writeFile(join(consumer, 'positive.ts'), positive);
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: options, files: ['positive.ts'] }),
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
  const negatives = [
    'client.assets.get({ task_id: id });',
    "client.assets.list({ page_token: 'foreign' });",
    "client.assets.update({ asset_id: id, request_id: id, expected_edit_revision: Counter.parse('1'), alias: undefined });",
    "createClient({ baseUrl: 'https://localhost', credentials: () => '', mode: 'partial' });",
    "createClient({ baseUrl: 'https://localhost', credentials: () => '', diagnostics: { mode: 'summary' } });",
    "createClient({ baseUrl: 'https://localhost', credentials: () => '', diagnostics: { mode: 'disabled', observer: () => {} } });",
    "const read = await client.tasks.get({ task_id: id }); if (read.kind === 'response' && read.response.kind === 'success') read.response.body.data.object_id;",
  ];
  for (const [i, line] of negatives.entries()) {
    await writeFile(join(consumer, 'negative.ts'), positive + '\n' + line + '\n');
    await writeFile(
      join(consumer, 'tsconfig-negative.json'),
      JSON.stringify({ compilerOptions: options, files: ['negative.ts'] }),
    );
    const stdout = await run(
      `negative-types-${i}`,
      [
        process.execPath,
        join(consumer, 'node_modules/typescript/bin/tsc'),
        '-p',
        join(consumer, 'tsconfig-negative.json'),
      ],
      { cwd: consumer, expectedExit: 2, capture: true },
    );
    assert.match(stdout, /negative\.ts\(\d+,\d+\): error TS/);
    assert.ok(!stdout.includes('TS2307'), stdout);
  }
  await run(
    'bundle',
    [
      process.execPath,
      join(root, 'node_modules/esbuild/bin/esbuild'),
      'entry.mjs',
      '--bundle',
      '--platform=browser',
      '--format=esm',
      '--outfile=browser.mjs',
      '--metafile=browser-metafile.json',
    ],
    { cwd: consumer },
  );
  const metafile = JSON.parse(await readFile(join(consumer, 'browser-metafile.json'), 'utf8'));
  assert.ok(
    Object.keys(metafile.inputs).every(
      (path) => !path.includes('zod-openapi') && !path.startsWith('node:'),
    ),
  );
  assert.ok(Object.values(metafile.outputs).every((output) => output.imports.length === 0));
  await qualification.retain(join(consumer, 'browser-metafile.json'));
  if (process.argv.includes('--source')) {
    const sourceEnv = { ...process.env };
    delete sourceEnv.ATLAS_SDK_ENTRY;
    await run('source', [process.execPath, join(root, 'scripts/test.mjs')], { env: sourceEnv });
    report.sourceHttpsTests = true;
  }
  await run('installed', [process.execPath, join(root, 'scripts/test.mjs')], {
    env: { ...process.env, ATLAS_SDK_ENTRY: pathToFileURL(join(consumer, 'entry.mjs')).href },
  });
  Object.assign(report, {
    node: process.versions.node,
    artifact: packed.filename,
    consumer,
    positiveTypes: true,
    negativeTypeCases: negatives.length,
    browserBundle: true,
    installedHttpsTests: true,
    installedSuites: (await readdir(join(root, 'test')))
      .filter((name) => name.endsWith('.test.mjs') && !name.endsWith('.owner.test.mjs'))
      .sort(),
    internalOwnerChecks: 'source-only; excluded from installed suites',
    protocol: manifest.atlasBuild.protocol,
  });
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
