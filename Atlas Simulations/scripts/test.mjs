import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const parent = process.env.ATLAS_TEST_ROOT;
assert.ok(parent && isAbsolute(parent), 'Set external ATLAS_TEST_ROOT');
await mkdir(parent, { recursive: true });
const rel = relative(await realpath(resolve(root, '..')), await realpath(parent));
assert.ok(
  rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel),
  'Test root must be external',
);
const tls = await mkdtemp(join(parent, 'tls-'));
const certificate = join(tls, 'certificate.pem'),
  key = join(tls, 'key.pem');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    certificate,
    '-days',
    '2',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ],
  { stdio: 'ignore', cwd: root },
);
const result = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate, ATLAS_SIM_TLS_KEY: key },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
