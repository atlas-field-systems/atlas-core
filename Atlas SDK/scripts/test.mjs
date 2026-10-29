import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const parent = resolve(process.env.ATLAS_TEST_ROOT ?? tmpdir());
if (parent === workspace.slice(0, -1) || parent.startsWith(workspace))
  throw new Error('Use an external ATLAS_TEST_ROOT');
await mkdir(parent, { recursive: true });
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
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), 'test/http.test.mjs'], {
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
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
});
if (code === 0) await rm(root, { recursive: true, force: true });
else console.error(`Retained SDK test evidence at ${root}`);
process.exitCode = code;
