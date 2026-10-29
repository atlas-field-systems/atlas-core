import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const parent = resolve(process.env.ATLAS_TEST_ROOT ?? tmpdir());
assert.ok(
  !parent.startsWith(workspace) && parent !== workspace.slice(0, -1),
  'Use an external ATLAS_TEST_ROOT',
);
await mkdir(parent, { recursive: true });
const consumer = await mkdtemp(join(parent, 'sdk-consumer-'));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.ok(process.env.npm_execpath, 'Run through npm');
const npm = (args, cwd = consumer) =>
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      npm_config_cache: process.env.npm_config_cache ?? join(consumer, 'npm-cache'),
    },
  });
const [packed] = JSON.parse(
  npm(['pack', '--json', '--ignore-scripts', '--pack-destination', consumer], root),
);
assert.ok(packed.files.some((file) => file.path === 'dist/index.js'));
assert.ok(packed.files.every((file) => !/^(src|test|node_modules)\//.test(file.path)));
await mkdir(join(consumer, 'artifacts'));
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
npm(['install', '--ignore-scripts', '--no-audit', '--no-fund']);
await writeFile(join(consumer, 'entry.mjs'), "export { createClient } from '@atlas/sdk';\n");
const positive = `import { createClient, type Prepared } from '@atlas/sdk';
import { Counter, NewId, type RequestOf, type ResponseOf, type Task } from '@atlas/protocol';
const id = NewId.parse('11111111-1111-4111-8111-111111111111');
const client = createClient({ baseUrl: 'https://localhost:8443', credentials: () => '' });
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
execFileSync(
  process.execPath,
  [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')],
  { cwd: consumer, stdio: 'pipe' },
);
const negatives = [
  'client.assets.get({ task_id: id });',
  "client.assets.list({ page_token: 'foreign' });",
  "client.assets.update({ asset_id: id, request_id: id, expected_edit_revision: Counter.parse('1'), alias: undefined });",
  "createClient({ baseUrl: 'https://localhost', credentials: () => '', mode: 'full' });",
  "const read = await client.tasks.get({ task_id: id }); if (read.kind === 'response' && read.response.kind === 'success') read.response.body.data.object_id;",
];
for (const [i, line] of negatives.entries()) {
  await writeFile(join(consumer, 'negative.ts'), positive + '\n' + line + '\n');
  await writeFile(
    join(consumer, 'tsconfig-negative.json'),
    JSON.stringify({ compilerOptions: options, files: ['negative.ts'] }),
  );
  const result = spawnSync(
    process.execPath,
    [
      join(consumer, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(consumer, 'tsconfig-negative.json'),
    ],
    { cwd: consumer, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0, `Negative type case ${i}`);
  assert.match(result.stdout, /negative\.ts\(\d+,\d+\): error TS/);
  assert.ok(!result.stdout.includes('TS2307'), result.stdout);
}
const bundled = await build({
  entryPoints: [join(consumer, 'entry.mjs')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: join(consumer, 'browser.mjs'),
  metafile: true,
});
assert.ok(
  Object.keys(bundled.metafile.inputs).every(
    (path) => !path.includes('zod-openapi') && !path.startsWith('node:'),
  ),
);
assert.ok(Object.values(bundled.metafile.outputs).every((output) => output.imports.length === 0));
await writeFile(join(consumer, 'browser-metafile.json'), JSON.stringify(bundled.metafile, null, 2));
execFileSync(process.execPath, [join(root, 'scripts/test.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ATLAS_SDK_ENTRY: pathToFileURL(join(consumer, 'entry.mjs')).href,
  },
});
const report = {
  node: process.versions.node,
  artifact: packed.filename,
  consumer,
  positiveTypes: true,
  negativeTypeCases: negatives.length,
  browserBundle: true,
  installedHttpsTests: true,
  protocol: manifest.atlasBuild.protocol,
};
await writeFile(join(consumer, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
