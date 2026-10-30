import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const workspace = await realpath(new URL('../../', import.meta.url));
const parent = resolve(process.env.ATLAS_TEST_ROOT ?? tmpdir());
await mkdir(parent, { recursive: true });
const location = relative(workspace, await realpath(parent));
if (location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location))
  throw new Error('Use an external ATLAS_TEST_ROOT');
const root = await mkdtemp(join(parent, 'sdk-'));
const certificate = join(root, 'test-ca.pem');
const key = join(root, 'test-ca.key');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout',
    key,
    '-out',
    certificate,
  ],
  { stdio: 'ignore' },
);
const suites = (await readdir(new URL('../test/', import.meta.url)))
  .filter(
    (name) =>
      name.endsWith('.test.mjs') &&
      (!process.env.ATLAS_SDK_ENTRY || !name.endsWith('.owner.test.mjs')),
  )
  .sort()
  .map((name) => `test/${name}`);
console.log(
  `${process.env.ATLAS_SDK_ENTRY ? 'Installed public' : 'Source public and internal owner'} suites: ${suites.join(', ')}`,
);
if (suites.length === 0) throw new Error('No SDK test suites found');
const evidence = await mkdtemp(join(parent, 'sdk-evidence-'));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: workspace,
  encoding: 'utf8',
});
const changes = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
  cwd: workspace,
  encoding: 'utf8',
});
const args = [
  '--test',
  ...process.argv.slice(2),
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=tap',
  `--test-reporter-destination=${join(evidence, 'results.tap')}`,
  ...suites,
];
const report = {
  kind: process.env.ATLAS_SDK_ENTRY ? 'installed' : 'source',
  entry: process.env.ATLAS_SDK_ENTRY ?? new URL('../dist/index.js', import.meta.url).href,
  revision:
    process.env.ATLAS_SOURCE_REVISION ?? (revision.status === 0 ? revision.stdout.trim() : null),
  dirty:
    process.env.ATLAS_SOURCE_DIRTY === undefined
      ? changes.status === 0
        ? changes.stdout.trim().length > 0
        : null
      : process.env.ATLAS_SOURCE_DIRTY !== 'false',
  node: process.versions.node,
  platform: `${process.platform}/${process.arch}`,
  command: [process.execPath, ...args],
  suites,
  fixtureRoot: root,
  status: 'running',
};
const saveReport = () =>
  writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await saveReport();
console.log(`SDK test report and TAP: ${evidence}`);
const child = spawn(process.execPath, args, {
  cwd: new URL('../', import.meta.url),
  stdio: 'inherit',
  env: {
    ...process.env,
    ATLAS_TEST_ROOT: root,
    SDK_TEST_CERTIFICATE: certificate,
    SDK_TEST_KEY: key,
    NODE_EXTRA_CA_CERTS: certificate,
  },
});
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
const code = result.signal ? 1 : (result.code ?? 1);
if (code === 0) await rm(root, { recursive: true, force: true });
else console.error(`Retained SDK test evidence at ${root}`);
Object.assign(report, {
  status: code === 0 ? 'passed' : 'failed',
  exitCode: code,
  signal: result.signal,
  fixturesRemoved: code === 0,
});
await saveReport();
process.exitCode = code;
