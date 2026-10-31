import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  stat,
  lstat,
  rm,
  symlink,
  chmod,
} from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mutableRoot } from './paths.mjs';
import { parseArgv, perform } from '../dist/command.js';
import {
  saveTls,
  savedTls,
  tlsView,
  recoverTlsAfterWriterExit,
  recordTlsActivation,
  validateTls,
} from '../dist/tls.js';
import { checkCompatibility } from '../dist/release.js';
import { Administration } from '../dist/admin.js';
import { defaults } from '../dist/settings.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (...args) =>
  spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], { encoding: 'utf8' });
async function directory(t) {
  const path = await mkdtemp(join(mutableRoot, 'operator-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function certificate(base, name) {
  const cert = join(base, `${name}.pem`),
    key = join(base, `${name}.key`);
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
      `/CN=${name}`,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  return { cert, key };
}
test('source parser rejects invalid commands without creating installation storage', async (t) => {
  const base = await directory(t),
    selected = join(base, 'absent');
  for (const args of [
    ['no-such-command'],
    ['start', '--unknown'],
    ['hard-reset'],
    ['settings', 'apply'],
    ['start', '--force'],
    ['start', '--image', `sha256:${'a'.repeat(64)}`],
    ['help', '--image', `sha256:${'a'.repeat(64)}`],
  ]) {
    const result = run(...args, '--installation', selected);
    assert.equal(result.status, 1, args.join(' '));
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.ok(!result.stdout.includes(selected));
    await assert.rejects(lstat(selected), { code: 'ENOENT' });
  }
  await assert.rejects(parseArgv(['start', '--installation', 'relative']), /invalid_arguments/);
  const parsed = await parseArgv(['start']);
  assert.ok(parsed.root.endsWith('/.atlas/core'));
  assert.equal(run().status, 0);
  assert.equal(run('help').status, 0);
  assert.equal(run('version').status, 0);
  assert.equal(JSON.parse(run('tui').stdout).code, 'terminal_required');
});
test('doctor leaves missing and existing installations byte-for-byte unchanged', async (t) => {
  const base = await directory(t),
    selected = join(base, 'absent');
  const missing = await perform({
    root: selected,
    operation: { effect: 'read', command: { kind: 'doctor' } },
  });
  assert.equal(missing.exitCode, 1, 'This host has no Docker');
  assert.ok(['pass', 'fail', 'unavailable'].includes(missing.envelope.data.checks.docker.status));
  await assert.rejects(stat(selected), { code: 'ENOENT' });
  await mkdir(join(selected, 'setup'), { recursive: true, mode: 0o700 });
  const file = join(selected, 'setup/settings.json');
  await writeFile(
    file,
    JSON.stringify({
      revision: '0',
      saved: { ...defaults, freeDiskBytes: 0 },
      effective: null,
      last_working: null,
      apply_failure: null,
    }),
  );
  const before = await readFile(file),
    names = await readdir(selected);
  await perform({ root: selected, operation: { effect: 'read', command: { kind: 'doctor' } } });
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(selected), names);
  assert.deepEqual(await readdir(join(selected, 'setup')), ['settings.json']);
});
test('protected credential parsing never emits secret values or creates an invalid installation', async (t) => {
  const base = await directory(t),
    file = join(base, 'credential.json'),
    selected = join(base, 'absent');
  const secret = 's'.repeat(43);
  await writeFile(
    file,
    JSON.stringify({ request_id: randomUUID(), api_key_id: randomUUID(), secret }),
    { mode: 0o644 },
  );
  const result = run('provision', '--credential-file', file, '--installation', selected);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, 'credential_file_unprotected');
  assert.ok(!result.stdout.includes(secret));
  await assert.rejects(stat(selected), { code: 'ENOENT' });
});
test('TLS validates bounded regular files, matching keys and certificate lifetime before a save', async (t) => {
  const base = await directory(t),
    installation = join(base, 'installation');
  await mkdir(join(installation, 'setup'), { recursive: true });
  const a = await certificate(base, 'first'),
    b = await certificate(base, 'second');
  const expired = join(base, 'expired.pem');
  execFileSync(
    'openssl',
    ['x509', '-in', a.cert, '-signkey', a.key, '-days', '-1', '-out', expired],
    { stdio: 'ignore' },
  );
  await assert.rejects(validateTls(expired, a.key), /tls_invalid/);
  await assert.rejects(saveTls(installation, a.cert, b.key), /tls_invalid/);
  assert.deepEqual(await readdir(join(installation, 'setup')), []);
  const large = join(base, 'large');
  await writeFile(large, Buffer.alloc(65_537));
  await assert.rejects(validateTls(large, a.key), /record_limit/);
  const link = join(base, 'link');
  await symlink(a.key, link);
  await assert.rejects(validateTls(a.cert, link), /tls_invalid/);
  await saveTls(installation, a.cert, a.key);
  const first = await savedTls(installation);
  assert.equal((await stat(first.key)).mode & 0o777, 0o600);
  assert.equal((await tlsView(installation)).active, null);
  await recordTlsActivation(installation, true);
  await saveTls(installation, b.cert, b.key);
  const view = await tlsView(installation);
  assert.equal(view.active.certificateSha256, first.state.saved.certificateSha256);
  assert.notEqual(view.saved.certificateSha256, view.active.certificateSha256);
  assert.equal(view.pendingActivation, true);
  await recordTlsActivation(installation, false);
  assert.equal((await tlsView(installation)).activationFailure, 'start_failed');
  assert.equal(
    (await savedTls(installation)).state.saved.generation,
    view.saved.generation,
    'Failed activation never rolls back saved TLS',
  );
});
test('explicit TLS recovery reconciles both sides of pointer commit and refuses inconsistent evidence', async (t) => {
  const base = await directory(t),
    installation = join(base, 'installation'),
    setup = join(installation, 'setup');
  await mkdir(setup, { recursive: true });
  const a = await certificate(base, 'before'),
    b = await certificate(base, 'after');
  await saveTls(installation, a.cert, a.key);
  const old = (await savedTls(installation)).state;
  await recordTlsActivation(installation, true);
  await saveTls(installation, b.cert, b.key);
  const next = (await savedTls(installation)).state;
  const journal = { previous: old.saved.generation, next: next.saved };
  const file = join(setup, 'tls-journal.json');
  await writeFile(file, JSON.stringify(journal));
  await assert.rejects(savedTls(installation), /recovery_required/);
  await recoverTlsAfterWriterExit(installation);
  assert.equal((await savedTls(installation)).state.saved.generation, next.saved.generation);
  await writeFile(join(setup, 'tls-state.json'), JSON.stringify(old));
  await writeFile(file, JSON.stringify(journal));
  await recoverTlsAfterWriterExit(installation);
  assert.equal((await savedTls(installation)).state.saved.generation, old.saved.generation);
  assert.deepEqual(await readdir(join(setup, 'tls')), [old.saved.generation]);
  await writeFile(file, JSON.stringify({ ...journal, previous: randomUUID() }));
  await assert.rejects(recoverTlsAfterWriterExit(installation), /repair_required/);
  assert.ok(await readFile(file));
});
test('TLS recovery accepts intact expired history while startup still requires a current pair', async (t) => {
  const base = await directory(t), installation = join(base, 'installation');
  await mkdir(join(installation, 'setup'), { recursive: true });
  const oldPair = await certificate(base, 'old'), nextPair = await certificate(base, 'next');
  await saveTls(installation, oldPair.cert, oldPair.key);
  const old = (await savedTls(installation)).state;
  await writeFile(join(installation, 'setup', 'tls-journal.json'), JSON.stringify({
    previous: old.saved.generation,
    next: { ...old.saved, generation: randomUUID() },
  }));
  const clock = t.mock.method(Date, 'now', () => Date.parse(old.saved.notAfter) + 1000);
  await recoverTlsAfterWriterExit(installation);
  assert.equal((await tlsView(installation)).recoveryRequired, false);
  assert.equal((await tlsView(installation)).saved.generation, old.saved.generation);
  assert.equal((await tlsView(installation)).active, null);
  await assert.rejects(savedTls(installation), /tls_invalid/);
  clock.mock.restore();
  await saveTls(installation, nextPair.cert, nextPair.key);
  assert.notEqual((await savedTls(installation)).state.saved.generation, old.saved.generation);
});
test('doctor rejects a FIFO installation record within its read-only probe budget', async (t) => {
  const base = await directory(t), installation = join(base, 'installation');
  await mkdir(join(installation, 'setup'), { recursive: true });
  const fifo = join(installation, 'setup', 'installation.json');
  execFileSync('mkfifo', ['--mode=0600', fifo]);
  const result = spawnSync(process.execPath, [join(root, 'dist/cli.js'), 'doctor', '--installation', installation], {
    encoding: 'utf8', timeout: 12_000, killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 1, 'Doctor must report nonregular records instead of waiting for a producer');
  const report = JSON.parse(result.stdout);
  assert.equal(report.code, 'prerequisite_failed');
  assert.notEqual(report.data.checks.compatibility.status, 'pass');
  assert.equal((await lstat(fifo)).isFIFO(), true);
  await assert.rejects(stat(join(installation, 'control')), { code: 'ENOENT' });
});
test('TLS admission precedes inspecting a recorded writer during Start', async (t) => {
  const base = await directory(t), installation = join(base, 'installation');
  await mkdir(join(installation, 'setup'), { recursive: true });
  await mkdir(join(installation, 'control'));
  const pair = await certificate(base, 'admission');
  await saveTls(installation, pair.cert, pair.key);
  const state = (await savedTls(installation)).state;
  await writeFile(join(installation, 'setup', 'installation.json'), JSON.stringify({
    format: 1, installation_id: randomUUID(), image: `sha256:${'a'.repeat(64)}`,
  }));
  await writeFile(join(installation, 'setup', 'settings.json'), JSON.stringify({
    revision: '0', saved: defaults, effective: null, last_working: null, apply_failure: null,
  }));
  await writeFile(join(installation, 'control', 'writer.json'), JSON.stringify({
    container: 'f'.repeat(64), launch: randomUUID(), kind: 'service', host: null,
  }));
  await writeFile(join(installation, 'setup', 'tls-journal.json'), JSON.stringify({
    previous: null, next: state.saved,
  }));
  await assert.rejects(new Administration(installation).start(), /recovery_required/);
  await rm(join(installation, 'setup', 'tls-journal.json'));
  await rm(join(installation, 'setup', 'tls-state.json'));
  await assert.rejects(new Administration(installation).start(), /tls_conversion_required/);
});
test('same-certificate replacement supersedes damaged retained key material', async (t) => {
  const base = await directory(t), installation = join(base, 'installation');
  await mkdir(join(installation, 'setup'), { recursive: true });
  const pair = await certificate(base, 'replacement');
  await saveTls(installation, pair.cert, pair.key);
  for (const damage of ['permissions', 'bytes']) {
    const before = await savedTls(installation);
    if (damage === 'permissions') await chmod(before.key, 0o644);
    else await writeFile(before.key, 'not a private key');
    await saveTls(installation, pair.cert, pair.key);
    const after = await savedTls(installation);
    assert.notEqual(after.state.saved.generation, before.state.saved.generation);
    assert.equal(after.state.saved.certificateSha256, before.state.saved.certificateSha256);
    assert.equal((await stat(after.key)).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(after.key), await readFile(pair.key));
  }
});
test('doctor distinguishes incomplete TLS setup and evaluated invalid certificates from unavailable probes', async (t) => {
  const base = await directory(t), installation = join(base, 'installation');
  await mkdir(join(installation, 'setup'), { recursive: true });
  const pair = await certificate(base, 'doctor-invalid');
  await saveTls(installation, pair.cert, pair.key);
  const partial = await perform({ root: installation, operation: { effect: 'read', command: { kind: 'doctor' } } });
  assert.equal(partial.envelope.data.checks.tls.status, 'fail');
  assert.match(partial.envelope.data.checks.recovery.instruction, /fresh installation path/);
  await writeFile(join(installation, 'setup', 'installation.json'), JSON.stringify({
    format: 1, installation_id: randomUUID(), image: `sha256:${'a'.repeat(64)}`,
  }));
  const saved = await savedTls(installation);
  await writeFile(saved.certificate, 'not a certificate');
  const invalid = await perform({ root: installation, operation: { effect: 'read', command: { kind: 'doctor' } } });
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.envelope.data.checks.tls.status, 'fail');
});
test('release mismatch refuses mutation before creating a command lock; cancellation before work writes nothing', async (t) => {
  const base = await directory(t),
    selected = join(base, 'installation');
  await mkdir(join(selected, 'setup'), { recursive: true });
  await writeFile(
    join(selected, 'setup/installation.json'),
    JSON.stringify({ format: 1, installation_id: randomUUID(), image: `sha256:${'a'.repeat(64)}` }),
  );
  await assert.rejects(
    checkCompatibility(selected, { image: `sha256:${'b'.repeat(64)}` }, undefined, 'start'),
    /incompatible_image/,
  );
  await assert.rejects(stat(join(selected, 'control')), { code: 'ENOENT' });
  const controller = new AbortController();
  controller.abort();
  const result = await perform(
    { root: join(base, 'cancelled'), operation: { effect: 'write', command: { kind: 'start' } } },
    controller.signal,
  );
  assert.equal(result.exitCode, 130);
  await assert.rejects(stat(join(base, 'cancelled')), { code: 'ENOENT' });
});

test(
  'a killed TLS saver leaves the old or new complete generation and requires explicit recovery',
  { timeout: 15_000 },
  async (t) => {
    const base = await directory(t),
      installation = join(base, 'installation');
    await mkdir(join(installation, 'setup'), { recursive: true });
    const a = await certificate(base, 'original'),
      b = await certificate(base, 'replacement');
    await saveTls(installation, a.cert, a.key);
    const original = (await savedTls(installation)).state.saved.generation;
    for (const phase of ['before-pointer', 'after-pointer']) {
      const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [root, certificate, key, phase] = process.argv.slice(1);
      const hold = async () => { process.stdout.write('held\\n'); await new Promise(() => { setInterval(() => {}, 1000); }); };
      const open = fs.promises.open;
      fs.promises.open = async (...args) => {
        const file = await open(...args);
        if (phase === 'before-pointer' && String(args[0]).endsWith('/certificate.pem') && args[1] === 'wx') {
          const sync = file.sync.bind(file);
          file.sync = async () => { await sync(); await hold(); };
        }
        return file;
      };
      const rm = fs.promises.rm;
      fs.promises.rm = async (...args) => {
        if (phase === 'after-pointer' && String(args[0]).endsWith('/tls-journal.json')) await hold();
        return rm(...args);
      };
      syncBuiltinESMExports();
      const { saveTls } = await import(${JSON.stringify(new URL('../dist/tls.js', import.meta.url).href)});
      await saveTls(root, certificate, key);
    `;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', script, installation, b.cert, b.key, phase],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });
      const [message] = await once(child.stdout, 'data');
      assert.match(message.toString(), /held/);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const view = await tlsView(installation);
      assert.equal(view.recoveryRequired, true);
      assert.equal(view.saved.generation === original, phase === 'before-pointer');
      await assert.rejects(savedTls(installation), /recovery_required/);
      await recoverTlsAfterWriterExit(installation);
      const saved = await savedTls(installation);
      assert.deepEqual(
        await readFile(saved.certificate),
        await readFile(phase === 'before-pointer' ? a.cert : b.cert),
      );
    }
  },
);

test('setup refuses orphaned retained data before creating setup or replacing credentials', async (t) => {
  const base = await directory(t),
    installation = join(base, 'installation');
  await mkdir(join(installation, 'data'), { recursive: true });
  const retained = join(installation, 'data', 'core.sqlite');
  await writeFile(retained, 'ambiguous retained database');
  const pair = await certificate(base, 'setup');
  await assert.rejects(
    new Administration(installation).setup({
      image: `sha256:${'a'.repeat(64)}`,
      certificate: pair.cert,
      key: pair.key,
      credential: { api_key_id: randomUUID(), request_id: randomUUID(), secret: 's'.repeat(43) },
    }),
    /already_setup/,
  );
  assert.equal(await readFile(retained, 'utf8'), 'ambiguous retained database');
  await assert.rejects(stat(join(installation, 'setup')), { code: 'ENOENT' });
});

test('legacy TLS refuses Start and converts only through explicit replacement', async (t) => {
  const base = await directory(t),
    installation = join(base, 'legacy'),
    setup = join(installation, 'setup');
  await mkdir(setup, { recursive: true });
  const pair = await certificate(base, 'legacy');
  await writeFile(
    join(setup, 'installation.json'),
    JSON.stringify({ format: 1, installation_id: randomUUID(), image: `sha256:${'a'.repeat(64)}` }),
  );
  await writeFile(
    join(setup, 'settings.json'),
    JSON.stringify({
      revision: '0',
      saved: defaults,
      effective: null,
      last_working: null,
      apply_failure: null,
    }),
  );
  const admin = new Administration(installation);
  await assert.rejects(admin.start(), /tls_conversion_required/);
  await assert.rejects(stat(join(setup, 'tls-state.json')), { code: 'ENOENT' });
  assert.equal((await tlsView(installation)).conversionRequired, true);
  await admin.tlsReplace(pair.cert, pair.key);
  const converted = await savedTls(installation);
  assert.deepEqual(await readFile(converted.certificate), await readFile(pair.cert));
  assert.equal(converted.state.active, null);
  await assert.rejects(
    stat(join(installation, 'control')),
    { code: 'ENOENT' },
    'Administration remains unlocked for externally locked callers',
  );
});
