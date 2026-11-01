import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const env = { ...process.env };
if (args[0] === 'eval' && !env.NODE_EXTRA_CA_CERTS) {
  const parent = env.ATLAS_TEST_ROOT;
  if (!parent || !isAbsolute(parent)) throw new Error('Set absolute external ATLAS_TEST_ROOT');
  await mkdir(parent, { recursive: true });
  const tls = await mkdtemp(join(parent, 'tls-'));
  env.NODE_EXTRA_CA_CERTS = join(tls, 'certificate.pem');
  env.ATLAS_SIM_TLS_KEY = join(tls, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      env.ATLAS_SIM_TLS_KEY,
      '-out',
      env.NODE_EXTRA_CA_CERTS,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { cwd: root, stdio: 'ignore' },
  );
}
const child = spawn(process.execPath, ['dist/cli.js', ...args], {
  cwd: root,
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', (e) => {
  process.stderr.write(e.message + '\n');
  process.exitCode = 1;
});
child.once('close', (code) => {
  process.exitCode = code ?? 1;
});
