import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import * as protocol from '../dist/index.js';
import { runFixtures } from '../test/fixture-adapter.mjs';
import { asset, task, createTask, id } from '../test/samples.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const run = (command, args, cwd = root) => exec(command, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, protocol.PROTOCOL_VERSION);
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
for (const [name, version] of Object.entries({
  ...manifest.dependencies,
  ...manifest.devDependencies,
})) {
  assert.equal(lock.packages[`node_modules/${name}`].version, version);
  assert.match(lock.packages[`node_modules/${name}`].integrity, /^sha512-/);
}
for (const [path, entry] of Object.entries(lock.packages))
  if (path !== '') assert.match(entry.integrity, /^sha512-/);
await run('npm', ['ls', '--all']);
const first = join(artifacts, 'openapi-first.json'),
  second = join(artifacts, 'openapi-second.json');
await run(process.execPath, [join(root, 'scripts', 'export.mjs'), first]);
await run(process.execPath, [join(root, 'scripts', 'export.mjs'), second]);
const firstBytes = await readFile(first),
  secondBytes = await readFile(second);
assert.deepEqual(firstBytes, secondBytes);
await writeFile(join(artifacts, 'openapi.json'), firstBytes);
const openapi = await run(join(root, 'node_modules', '.bin', 'redocly'), [
  'lint',
  first,
  '--extends',
  'minimal',
]);
await writeFile(join(artifacts, 'openapi-validation.txt'), openapi.stdout + openapi.stderr);
const packed = JSON.parse(
  (await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', artifacts]))
    .stdout,
)[0];
assert.ok(packed.files.some((file) => file.path === 'dist/index.d.ts'));
assert.ok(packed.files.every((file) => !file.path.startsWith('src/')));
const consumer = await mkdtemp(join(artifacts, 'consumer-'));
await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
await run(
  'npm',
  ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(artifacts, packed.filename)],
  consumer,
);
await writeFile(
  join(consumer, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      exactOptionalPropertyTypes: true,
      types: [],
      lib: ['ES2022', 'DOM'],
      outDir: 'output',
    },
    files: ['index.ts'],
  }),
);
await writeFile(
  join(consumer, 'index.ts'),
  `
import { exchanges, readJson, writeJson, readHttp, Task, NewId, Uuid } from '@atlas/protocol';
import { exportReference } from '@atlas/protocol/reference';
import type { Camera, Status, Power, Origin, HistoryQuery, RequestOf, ResponseOf } from '@atlas/protocol';
export type PublicComponents = [Camera, Status, Power, Origin, HistoryQuery, RequestOf<'CreateTask'>, ResponseOf<'GetTask'>];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
export type ExactName = Expect<Equal<typeof exchanges.CreateTask.operationId, 'CreateTask'>>;
export type ExactRoute = Expect<Equal<typeof exchanges.CreateTask.path, '/messages/create_task'>>;
export type ExactMethod = Expect<Equal<typeof exchanges.GetTask.method, 'POST'>>;
const request = readJson(exchanges.CreateTask.request, new TextEncoder().encode(${JSON.stringify(JSON.stringify(createTask))}));
if (request.command === 'move_to') { const queued: 'queued' = request.scheduling; if (request.inputs.target.kind === 'position') request.inputs.target.position.latitude.toFixed(); void queued; }
const bytes = writeJson(exchanges.CreateTask.request, request);
if (bytes.byteLength === 0 || exportReference().byteLength === 0) throw new Error('Empty artifact');
const task = Task.parse(${JSON.stringify(task)});
if (task.execution_state === 'completed' || task.execution_state === 'failed' || task.execution_state === 'cancelled') { const cleared: null = task.cancellation_request_id; void cleared; }
const readBody: Extract<ResponseOf<'GetTask'>, {kind:'success'}>['body'] = {dataset_id:Uuid.parse(${JSON.stringify(id)}), data:task};
void readBody;
const committedResponse = readHttp(exchanges.CreateTask, { status:200, headers:new Headers({'Atlas-Dataset-ID':${JSON.stringify(id)}, 'Atlas-Protocol-Version':'0.2.0', 'Content-Type':'application/json'}), body:new TextEncoder().encode(JSON.stringify({dataset_id:${JSON.stringify(id)}, data:task, commit_cursor:'cursor'})) });
if (committedResponse.kind === 'success') { const cursor:string = committedResponse.body.commit_cursor; void cursor; }
const response = readHttp(exchanges.GetTask, { status: 200, headers: new Headers({ 'Atlas-Dataset-ID': ${JSON.stringify(id)}, 'Atlas-Protocol-Version': '0.2.0', 'Content-Type': 'application/json' }), body: new TextEncoder().encode(JSON.stringify({dataset_id:${JSON.stringify(id)}, data:task})) });
if (response.kind === 'success' && response.body.data.command === 'move_to') response.body.data.inputs.target.kind;
NewId.parse(${JSON.stringify(id)});
`,
);
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
await run(process.execPath, [compiler, '-p', join(consumer, 'tsconfig.json')], consumer);
await run(process.execPath, [join(consumer, 'output', 'index.js')], consumer);
await writeFile(
  join(consumer, 'negative.ts'),
  `
import { NewId, Task } from '@atlas/protocol';
import type { CreateTask, ResponseOf } from '@atlas/protocol';
const identity = NewId.parse(${JSON.stringify(id)});
const invalidCommand: CreateTask = { request_id:identity, task_id:identity, asset_id:identity, command:'move_to', scheduling:'immediate', inputs:{target:{kind:'position',position:{latitude:0,longitude:0}}} };
const invalidTerminal: Task = {...Task.parse(${JSON.stringify(task)}),execution_state:'completed',cancellation_request_id:identity};
const missingCursor: Extract<ResponseOf<'CreateTask'>, {kind:'success'}>['body'] = {dataset_id:identity, data:Task.parse(${JSON.stringify(task)})};
const undefinedCursor: Extract<ResponseOf<'CreateTask'>, {kind:'success'}>['body'] = {dataset_id:identity, data:Task.parse(${JSON.stringify(task)}), commit_cursor:undefined};
void invalidCommand; void invalidTerminal; void missingCursor; void undefinedCursor;
`,
);
let rejectedTypes = false;
try {
  await run(
    process.execPath,
    [
      compiler,
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      join(consumer, 'negative.ts'),
    ],
    consumer,
  );
} catch (error) {
  const output = error.stdout + error.stderr;
  assert.ok(
    (output.match(/error TS2322/g) ?? []).length >= 3 && /error TS2741/.test(output),
    output,
  );
  await writeFile(join(artifacts, 'negative-types.txt'), output);
  rejectedTypes = true;
}
assert.equal(rejectedTypes, true);
await writeFile(
  join(consumer, 'undefined-optionals.ts'),
  `
import { Asset, NewId } from '@atlas/protocol';
import type { RequestOf } from '@atlas/protocol';
const identity = NewId.parse(${JSON.stringify(id)});
const undefinedAlias: Asset = {...Asset.parse(${JSON.stringify(asset)}), alias:undefined};
const undefinedAltitude: RequestOf<'CreateTask'> = {request_id:identity, task_id:identity, asset_id:identity, command:'move_to', scheduling:'queued', inputs:{target:{kind:'position',position:{latitude:0,longitude:0}},altitude:undefined}};
void undefinedAlias; void undefinedAltitude;
`,
);
let rejectedUndefinedOptionals = false;
try {
  await run(
    process.execPath,
    [
      compiler,
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      join(consumer, 'undefined-optionals.ts'),
    ],
    consumer,
  );
} catch (error) {
  const output = error.stdout + error.stderr;
  assert.equal((output.match(/error TS2375/g) ?? []).length, 2, output);
  await writeFile(join(artifacts, 'undefined-optionals.txt'), output);
  rejectedUndefinedOptionals = true;
}
assert.equal(rejectedUndefinedOptionals, true, 'Installed types accepted explicit undefined');
await writeFile(
  join(consumer, 'version-overrides.ts'),
  `
import { exchanges, readHttp, readWssClient, readWssServer, writeWssClient, writeWssServer } from '@atlas/protocol';
import type { HttpContext, WssContext, ReceivedHttp, ClientFrame, ServerFrame } from '@atlas/protocol';
declare const received: ReceivedHttp;
declare const bytes: Uint8Array;
declare const client: ClientFrame;
declare const server: ServerFrame;
const http: HttpContext = {protocolVersion:'999.0.0'};
const wss: WssContext = {protocolVersion:'999.0.0'};
readHttp(exchanges.GetTask, received, {protocolVersion:'999.0.0'});
readWssClient(bytes, {protocolVersion:'999.0.0'});
readWssServer(bytes, {protocolVersion:'999.0.0'});
writeWssClient(client, {protocolVersion:'999.0.0'});
writeWssServer(server, {protocolVersion:'999.0.0'});
void http; void wss;
`,
);
let rejectedVersionOverrides = false;
try {
  await run(
    process.execPath,
    [
      compiler,
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--module',
      'NodeNext',
      '--target',
      'ES2022',
      join(consumer, 'version-overrides.ts'),
    ],
    consumer,
  );
} catch (error) {
  const output = error.stdout + error.stderr;
  assert.equal((output.match(/error TS2353/g) ?? []).length, 7, output);
  await writeFile(join(artifacts, 'version-overrides.txt'), output);
  rejectedVersionOverrides = true;
}
assert.equal(rejectedVersionOverrides, true, 'Installed types accepted a version override');
await writeFile(
  join(consumer, 'private-import.mjs'),
  `import assert from 'node:assert/strict'; await assert.rejects(import('@atlas/protocol/src/scalars.js'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});`,
);
await run(process.execPath, [join(consumer, 'private-import.mjs')], consumer);
const entry = join(consumer, 'browser-entry.mjs');
await writeFile(
  entry,
  `import * as p from '@atlas/protocol';\nimport {runFixtures} from ${JSON.stringify(join(root, 'test', 'fixture-adapter.mjs'))};\nimport {runPortable} from ${JSON.stringify(join(root, 'test', 'portable.mjs'))};\nconst corpora = await Promise.all(['/fixtures.json', '/independent-cases.json'].map(async path => (await fetch(path)).json()));\nconst fixtures = corpora.flatMap(corpus => runFixtures(corpus, p));\nwindow.qualification={userAgent:navigator.userAgent,portable:runPortable(p),fixtures:{total:fixtures.length,passed:fixtures.filter(r=>r.pass).length,failures:fixtures.filter(r=>!r.pass)}};\ndocument.querySelector('pre').textContent=JSON.stringify(window.qualification,null,2);`,
);
const bundled = await build({
  entryPoints: [entry],
  outfile: join(consumer, 'bundle.js'),
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  bundle: true,
  metafile: true,
});
assert.ok(
  Object.keys(bundled.metafile.inputs).every(
    (path) => !path.includes('zod-openapi') && !path.endsWith('/reference.js'),
  ),
);
await writeFile(
  join(artifacts, 'installed-browser-metafile.json'),
  JSON.stringify(bundled.metafile, null, 2),
);
const corpora = await Promise.all(
  ['acceptance', 'independent-cases'].map(async (name) =>
    JSON.parse(await readFile(join(root, 'test', 'fixtures', name + '.json'), 'utf8')),
  ),
);
const fixtures = corpora.flatMap((corpus) => runFixtures(corpus, protocol));
const report = {
  version: protocol.PROTOCOL_VERSION,
  node: process.version,
  npm: (await run('npm', ['--version'])).stdout.trim(),
  lockedPackages: Object.keys(lock.packages).length - 1,
  export: {
    byteIdentical: true,
    bytes: firstBytes.length,
    sha256: createHash('sha256').update(firstBytes).digest('hex'),
    stockOpenapiValid: true,
  },
  externalConsumer: {
    path: consumer,
    typecheck: true,
    runtime: true,
    invalidTypesRejected: true,
    undefinedOptionalsRejected: true,
    versionOverridesRejected: true,
    privateImportsBlocked: true,
    browserBundle: true,
    browserEntry: entry,
  },
  fixtures: {
    total: fixtures.length,
    passed: fixtures.filter((result) => result.pass).length,
    failures: fixtures.filter((result) => !result.pass),
  },
  unrun: ['Core and SDK integration', 'durability and deployment capacity', 'Firefox', 'WebKit'],
};
await writeFile(join(artifacts, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.fixtures.failures.length) process.exitCode = 1;
