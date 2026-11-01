import { X509Certificate } from 'node:crypto';
import { mutableRoot } from './paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  chmod,
  open,
  stat,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { request } from 'node:https';
import { isAbsolute, join } from 'node:path';
import { root, uuid, secret, registration } from './helpers.mjs';
import { defaults } from '../dist/settings.js';
import { installationLock } from '../dist/installation.js';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity, exited as writerExited } from '../dist/ownership.js';
import { createContainer } from '../dist/docker.js';
import { Administration } from '../dist/admin.js';
import { diskUsage } from '../dist/capacity.js';
import Database from 'better-sqlite3';
const exec = promisify(execFile);
const cliExecutable = process.env.ATLAS_TEST_CLI ?? join(root, 'dist', 'cli.js');
assert.ok(isAbsolute(cliExecutable), 'ATLAS_TEST_CLI must select an absolute installed executable');
test(
  'real CLI and pinned container retain Restart, fence Reset, recover proof and require new Hard Reset setup',
  { timeout: 180000 },
  async (t) => {
    const image = (await readFile(join(root, 'artifacts', 'image-id'), 'utf8')).trim();
    assert.match(image, /^sha256:[0-9a-f]{64}$/);
    const base = await mkdtemp(join(mutableRoot, 'container-'));
    const installation = join(base, 'installation');
    const cert = join(base, 'tls.pem'),
      key = join(base, 'tls.key'),
      credentials = join(base, 'credential.json');
    const apiKey = secret();
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
        cert,
      ],
      { cwd: root, stdio: 'ignore' },
    );
    await writeFile(
      credentials,
      JSON.stringify({ request_id: uuid(), api_key_id: uuid(), secret: apiKey }),
      { mode: 0o600 },
    );
    const port = await new Promise((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const a = s.address();
        assert.ok(a && typeof a === 'object');
        s.close(() => resolve(a.port));
      });
    });
    const settings = { ...defaults, port, freeDiskBytes: 0 };
    const settingsFile = join(base, 'settings.json');
    await writeFile(settingsFile, JSON.stringify(settings));
    const installationIds = new Set();
    function cli(...args) {
      return cliAt(installation, ...args);
    }
    async function cliAt(directory, ...args) {
      try {
        return JSON.parse(
          (
            await exec(process.execPath, [cliExecutable, ...args, '--installation', directory], {
              cwd: root,
              maxBuffer: 131072,
              timeout: 90000,
            })
          ).stdout,
        );
      } catch (error) {
        if (error.stdout) return JSON.parse(error.stdout);
        throw error;
      }
    }
    t.after(async () => {
      for (const id of installationIds) {
        const ids = (
          await exec(
            'sudo',
            [
              '-n',
              'docker',
              'ps',
              '--all',
              '--no-trunc',
              '--filter',
              `label=atlas.installation=${id}`,
              '--format',
              '{{.ID}}',
            ],
            { cwd: root },
          )
        ).stdout
          .trim()
          .split('\n')
          .filter(Boolean);
        for (const container of ids) {
          assert.match(container, /^[0-9a-f]{64}$/);
          const [state] = JSON.parse(
            (await exec('sudo', ['-n', 'docker', 'inspect', container], { cwd: root })).stdout,
          );
          assert.equal(state.Config.Labels['atlas.installation'], id);
          const owner = state.State.Running ? await processIdentity(state.State.Pid) : null;
          await exec('sudo', ['-n', 'docker', 'rm', '--force', container], { cwd: root });
          if (owner) assert.equal(await writerExited(owner), true);
        }
      }
      await rm(base, { recursive: true, force: true });
    });
    const firstUse = await cli('inspect');
    assert.equal(firstUse.ok, true);
    assert.equal(firstUse.data.setup_required, true);
    const setup = await cli(
      'setup',
      '--image',
      image,
      '--certificate',
      cert,
      '--key',
      key,
      '--credential-file',
      credentials,
      '--settings',
      settingsFile,
    );
    assert.equal(setup.ok, true, JSON.stringify(setup));
    const manifest = JSON.parse(await readFile(join(installation, 'setup', 'installation.json')));
    installationIds.add(manifest.installation_id);
    assert.deepEqual(await readdir(join(installation, 'control', 'exits')), []);
    const created = await createContainer(
      installation,
      manifest.installation_id,
      image,
      'serve',
      settings,
    );
    const writerPath = join(installation, 'control', 'writer.json');
    await writeFile(writerPath, JSON.stringify(created));
    const writerBefore = await readFile(writerPath, 'utf8');
    await installationLock(installation, async () => {
      for (let i = 0; i < 3; i++) {
        const inspected = await cli('inspect');
        assert.equal(inspected.ok, true, JSON.stringify(inspected));
      }
    });
    assert.equal(await readFile(writerPath, 'utf8'), writerBefore);
    assert.deepEqual(await readdir(join(installation, 'control', 'exits')), []);
    const start = await cli('start');
    assert.equal(start.ok, true, JSON.stringify(start));
    await installationLock(installation, async () => {
      assert.equal((await cli('stop')).code, 'management_busy');
      assert.equal((await cli('inspect')).ok, true);
    });
    const ca = await readFile(cert);
    let dataset;
    async function api(path, body, credential = apiKey, hostname = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = request(
          {
            hostname,
            servername: 'localhost',
            port,
            path,
            method: body === undefined ? 'GET' : 'POST',
            ca,
            headers: {
              Authorization: `Bearer ${credential}`,
              ...(dataset
                ? { 'Atlas-Dataset-ID': dataset, 'Atlas-Protocol-Version': '0.5.0' }
                : {}),
              ...(bytes
                ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length }
                : {}),
            },
          },
          (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () =>
              resolve({
                status: response.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              }),
            );
          },
        );
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('https_timeout')));
        req.end(bytes);
      });
    }
    let health = await api('/health');
    assert.equal(health.status, 200);
    dataset = health.body.dataset_id;
    const replacementCert = join(base, 'replacement.pem'),
      replacementKey = join(base, 'replacement.key');
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
        '/CN=replacement',
        '-keyout',
        replacementKey,
        '-out',
        replacementCert,
      ],
      { stdio: 'ignore' },
    );
    const tlsBefore = (await cli('tls', 'show')).data;
    assert.equal(tlsBefore.pendingActivation, false);
    const invalidTls = await cli('tls', 'replace', '--certificate', replacementCert, '--key', key);
    assert.equal(invalidTls.ok, false);
    assert.equal(invalidTls.code, 'tls_invalid');
    assert.equal((await cli('tls', 'show')).data.saved.generation, tlsBefore.saved.generation);
    const stagedTls = await cli(
      'tls',
      'replace',
      '--certificate',
      replacementCert,
      '--key',
      replacementKey,
    );
    assert.equal(stagedTls.ok, true);
    assert.equal(stagedTls.data.active.generation, tlsBefore.saved.generation);
    assert.equal(stagedTls.data.pendingActivation, true);
    assert.equal(
      (await api('/health')).status,
      200,
      'Saving TLS must keep the existing verified TLS connection available',
    );
    assert.equal((await cli('restart')).ok, true);
    const activeTls = (await cli('tls', 'show')).data;
    assert.equal(activeTls.active.generation, stagedTls.data.saved.generation);
    await new Promise((resolve, reject) => {
      const req = request(
        { hostname: '127.0.0.1', port, path: '/health', rejectUnauthorized: false },
        (response) => {
          assert.equal(
            response.socket.getPeerCertificate().raw.toString('base64'),
            new X509Certificate(
              execFileSync('openssl', ['x509', '-in', replacementCert, '-outform', 'DER']),
            ).raw.toString('base64'),
          );
          response.resume();
          response.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(
      (await cli('tls', 'replace', '--certificate', cert, '--key', key, '--restart')).ok,
      true,
    );
    assert.equal((await api('/health')).status, 200);
    const r = registration('Retained');
    assert.equal((await api('/messages/register_asset', r)).status, 200);
    assert.equal((await cli('restart')).ok, true);
    assert.deepEqual(await readdir(join(installation, 'control', 'exits')), []);
    health = await api('/health');
    assert.equal(health.body.dataset_id, dataset);
    assert.equal((await api('/messages/get_asset', { asset_id: r.asset_id })).status, 200);
    const candidate = { ...settings, storageBytes: 63_000_000_000, openEnrollment: true };
    await writeFile(settingsFile, JSON.stringify(candidate));
    assert.equal(
      (await cli('settings', 'save', '--expected-revision', '0', '--file', settingsFile)).ok,
      true,
    );
    const saved = await cli('settings', 'show');
    assert.equal(saved.data.revision, '1');
    assert.equal(saved.data.effective.revision, '0');
    assert.equal((await cli('settings', 'apply', '--restart')).ok, true);
    const applied = await cli('settings', 'show');
    assert.equal(applied.data.effective.revision, '1');
    assert.equal(applied.data.last_working.revision, '1');
    const occupied = createServer();
    await new Promise((resolve) => occupied.listen(0, '0.0.0.0', resolve));
    t.after(() => {
      if (occupied.listening) occupied.close();
    });
    const occupiedAddress = occupied.address();
    assert.ok(occupiedAddress && typeof occupiedAddress === 'object');
    await writeFile(settingsFile, JSON.stringify({ ...candidate, port: occupiedAddress.port }));
    assert.equal(
      (await cli('settings', 'save', '--expected-revision', '1', '--file', settingsFile)).ok,
      true,
    );
    assert.equal((await cli('settings', 'apply', '--restart')).ok, false);
    const failedApply = await cli('settings', 'show');
    assert.equal(failedApply.data.apply_failure, 'start_failed');
    assert.equal(failedApply.data.last_working.revision, '1');
    await new Promise((resolve) => occupied.close(resolve));
    await writeFile(settingsFile, JSON.stringify(candidate));
    assert.equal(
      (await cli('settings', 'save', '--expected-revision', '2', '--file', settingsFile)).ok,
      true,
    );
    assert.equal((await cli('settings', 'apply', '--restart')).ok, true);
    const enrollment = registration('Local enrollment');
    const enrollmentFile = join(base, 'registration.json');
    await writeFile(enrollmentFile, JSON.stringify(enrollment), { mode: 0o600 });
    const enrolled = await cli('enroll', '--dataset', dataset, '--request-file', enrollmentFile);
    assert.equal(enrolled.ok, true, JSON.stringify(enrolled));
    const bindings = await cli('enrollment', 'inspect');
    assert.equal(bindings.data.bindings.length, 1);
    assert.equal(
      (
        await cli(
          'enrollment',
          'revoke',
          '--binding',
          enrolled.data.binding_id,
          '--api-key',
          enrollment.api_key_id,
          '--confirm',
        )
      ).ok,
      true,
    );
    const interrupted = spawn(
      process.execPath,
      [cliExecutable, 'reset', '--installation', installation],
      { cwd: root, stdio: 'ignore' },
    );
    const exited = new Promise((resolve) =>
      interrupted.once('exit', (code, signal) => resolve({ code, signal })),
    );
    let pending;
    for (let i = 0; i < 1000; i++) {
      pending = await readFile(join(installation, 'recovery', 'action.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (pending) break;
      await delay(5);
    }
    assert.ok(pending);
    assert.equal(pending.phase, 'intent');
    interrupted.kill('SIGKILL');
    assert.equal((await exited).signal, 'SIGKILL');
    assert.equal((await cli('start')).code, 'recovery_required');
    const resumed = await cli('recover');
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    const action = JSON.parse(
      await readFile(join(installation, 'recovery', 'action.json'), 'utf8'),
    );
    assert.notEqual(action.intended_dataset, dataset);
    assert.equal(action.phase, 'complete');
    await rm(join(installation, 'recovery', 'proof.json'));
    await writeFile(
      join(installation, 'recovery', 'action.json'),
      JSON.stringify({ ...action, phase: 'cleaned' }),
    );
    assert.equal((await cli('start')).code, 'recovery_required');
    const recover = await cli('recover');
    assert.equal(recover.ok, true, JSON.stringify(recover));
    assert.equal(
      JSON.parse(await readFile(join(installation, 'recovery', 'proof.json'))).dataset,
      action.intended_dataset,
    );
    assert.equal((await cli('start')).ok, true);
    health = await api('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.dataset_id, action.intended_dataset);
    assert.equal(
      (await api('/messages/get_asset', { asset_id: r.asset_id })).body.error.code,
      'dataset_mismatch',
    );
    dataset = action.intended_dataset;
    assert.equal((await api('/messages/get_asset', { asset_id: r.asset_id })).status, 404);
    const exportPath = join(base, 'diagnostics.jsonl');
    const exportResult = await cli('export', '--out', exportPath);
    assert.equal(exportResult.ok, true, JSON.stringify(exportResult));
    const exportBytes = await readFile(exportPath),
      exported = exportBytes.toString('utf8');
    const exportedLines = exported
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(exportedLines[0].context.engine.version, '3.53.4');
    assert.equal(exportResult.data.bytes, exportBytes.length);
    assert.equal(exportedLines.at(-1).included_events, exportedLines.length - 2);
    assert.equal(exportedLines.at(-1).partial, exportResult.data.partial);
    assert.ok(!exported.includes(apiKey));
    assert.ok(!exported.includes(enrollment.secret));
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await cli('export', '--out', exportPath);
      assert.equal(failed.ok, false, 'An existing output path must be refused');
      assert.deepEqual(
        await readFile(exportPath),
        exportBytes,
        'Failed export cannot overwrite the existing bundle',
      );
    }
    const afterFailures = await cli('export', '--out', join(base, 'after-existing-path.jsonl'));
    assert.equal(afterFailures.ok, true, JSON.stringify(afterFailures));
    const pressure = join(installation, 'data', 'export-pressure');
    const filler = await open(pressure, 'wx');
    try {
      await filler.truncate(
        settings.storageBytes - settings.reserveBytes - diskUsage(installation).bytes - 32768,
      );
    } finally {
      await filler.close();
    }
    const refusedExport = join(base, 'refused-export.jsonl');
    assert.equal((await cli('export', '--out', refusedExport)).ok, false);
    await assert.rejects(stat(refusedExport), { code: 'ENOENT' });
    assert.equal((await api('/readiness')).body.data.ready, true);
    assert.ok(diskUsage(installation).bytes <= settings.storageBytes);
    await rm(pressure);
    assert.equal((await cli('export', '--out', join(base, 'next-export.jsonl'))).ok, true);
    assert.equal((await cli('update', '--image', image)).code, 'destructive_confirmation_required');
    const updated = await cli('update', '--image', image, '--confirm-reset');
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal((await cli('start')).ok, true);
    const afterUpdate = await api('/health');
    assert.equal(afterUpdate.status, 200);
    assert.notEqual(afterUpdate.body.dataset_id, dataset);
    dataset = afterUpdate.body.dataset_id;
    assert.equal((await api('/messages/list_assets', {})).body.data.items.length, 0);
    await t.test(
      'bind addresses publish reachable HTTPS on the selected host interface',
      async () => {
        const lan = Object.values(networkInterfaces())
          .flat()
          .find((address) => address?.family === 'IPv4' && !address.internal);
        assert.ok(lan, 'Container qualification requires a host IPv4 interface');
        const candidateFile = join(base, 'binding-settings.json');
        async function bind(host) {
          const current = await cli('settings', 'show');
          assert.equal(current.ok, true, JSON.stringify(current));
          await writeFile(candidateFile, JSON.stringify({ ...current.data.saved, host }));
          const saved = await cli(
            'settings',
            'save',
            '--expected-revision',
            current.data.revision,
            '--file',
            candidateFile,
          );
          assert.equal(saved.ok, true, JSON.stringify(saved));
          const restarted = await cli('restart');
          assert.equal(restarted.ok, true, JSON.stringify(restarted));
        }
        try {
          for (const [host, address] of [
            ['localhost', '127.0.0.1'],
            ['127.0.0.1', '127.0.0.1'],
            [lan.address, lan.address],
            ['::1', '::1'],
          ]) {
            await bind(host);
            const healthy = await api('/health', undefined, apiKey, address);
            assert.equal(healthy.status, 200, `${host} must serve authenticated HTTPS`);
            const writer = JSON.parse(await readFile(writerPath));
            const [container] = JSON.parse(
              (await exec('sudo', ['-n', 'docker', 'inspect', writer.container])).stdout,
            );
            assert.deepEqual(
              container.HostConfig.PortBindings[`${port}/tcp`],
              [{ HostIp: address, HostPort: String(port) }],
              'Publish only the selected host address',
            );
          }
        } finally {
          await bind(settings.host);
        }
      },
    );
    await writeFile(join(installation, 'unrelated.txt'), 'keep');
    assert.equal((await cli('hard-reset')).code, 'destructive_confirmation_required');
    const reset = await cli('hard-reset', '--confirm-destructive');
    assert.equal(reset.ok, true, JSON.stringify(reset));
    const resetInspection = await cli('inspect');
    assert.equal(resetInspection.ok, true, JSON.stringify(resetInspection));
    assert.equal(resetInspection.data.setup_required, true, 'Hard Reset must offer fresh setup');
    assert.equal(await readFile(join(installation, 'unrelated.txt'), 'utf8'), 'keep');
    await assert.rejects(readFile(join(installation, 'setup', 'tls.key')));
    assert.equal((await cli('start')).code, 'setup_required');
    const hardReset = JSON.parse(await readFile(join(installation, 'recovery', 'action.json')));
    await writeFile(
      join(installation, 'recovery', 'action.json'),
      JSON.stringify({ ...hardReset, phase: 'established' }),
    );
    assert.equal((await cli('start')).code, 'recovery_required');
    const finishHardReset = await cli('recover');
    assert.equal(finishHardReset.ok, true, JSON.stringify(finishHardReset));
    assert.equal((await cli('start')).code, 'setup_required');
    const recoveredInspection = await cli('inspect');
    assert.equal(recoveredInspection.ok, true, JSON.stringify(recoveredInspection));
    assert.equal(
      recoveredInspection.data.setup_required,
      true,
      'Recovered Hard Reset must offer fresh setup',
    );
    const proof = JSON.parse(await readFile(join(installation, 'recovery', 'proof.json')));
    assert.notEqual(proof.dataset, dataset);
    const newKey = secret();
    await writeFile(
      credentials,
      JSON.stringify({ request_id: uuid(), api_key_id: uuid(), secret: newKey }),
      { mode: 0o600 },
    );
    const setupAgain = await cli(
      'setup',
      '--image',
      image,
      '--certificate',
      cert,
      '--key',
      key,
      '--credential-file',
      credentials,
      '--settings',
      settingsFile,
    );
    assert.equal(setupAgain.ok, true, JSON.stringify(setupAgain));
    installationIds.add(
      JSON.parse(await readFile(join(installation, 'setup', 'installation.json'))).installation_id,
    );
    const startedAgain = await cli('start');
    assert.equal(startedAgain.ok, true, JSON.stringify(startedAgain));
    assert.equal((await api('/health')).status, 401);
    assert.equal((await api('/health', undefined, newKey)).status, 200);
    const stopped = await cli('stop');
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    await t.test(
      'stopped export checks aggregate capacity and persists a complete independently counted trailer',
      async () => {
        const path = join(base, 'stopped-export.jsonl'),
          pressure = join(installation, 'data', 'stopped-pressure');
        const logs = join(installation, 'data', 'logs');
        for (const name of await readdir(logs)) await rm(join(logs, name));
        const event = {
          at: '2026-10-29T00:00:00Z',
          severity: 'INFO',
          event: 'export_fixture',
          component: 'runtime',
          release: '0.5.0',
          count: 17,
        };
        await writeFile(join(logs, 'events.0.jsonl'), JSON.stringify(event) + '\ninvalid JSON\n');
        const database = join(installation, 'data', 'core.sqlite'),
          before = await readFile(database);
        const filler = await open(pressure, 'wx');
        try {
          await filler.truncate(
            candidate.storageBytes - candidate.reserveBytes - diskUsage(installation).bytes - 32768,
          );
        } finally {
          await filler.close();
        }
        try {
          const refused = await cli('export', '--out', path);
          assert.equal(refused.ok, false);
          assert.equal(refused.code, 'storage_limit', JSON.stringify(refused));
          await assert.rejects(stat(path), { code: 'ENOENT' });
          assert.deepEqual(
            await readFile(database),
            before,
            'Stopped pressure refusal preserves retained SQLite bytes',
          );
        } finally {
          await rm(pressure);
        }
        const result = await cli('export', '--out', path);
        assert.equal(result.ok, true, JSON.stringify(result));
        const bytes = await readFile(path),
          lines = bytes
            .toString('utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        assert.equal(result.data.bytes, bytes.length);
        assert.equal(lines[0].context.marker.exists, true);
        assert.deepEqual(lines.slice(1, -1), [event]);
        assert.deepEqual(lines.at(-1), { partial: true, included_events: 1, omitted_events: 1 });
        assert.equal(result.data.partial, true);
        assert.deepEqual(
          await readFile(database),
          before,
          'Successful stopped export also uses read-only inspection',
        );
      },
    );
    await t.test(
      'incompatible update and pending recovery preserve retained data and setup',
      async () => {
        const path = join(installation, 'data', 'core.sqlite');
        const db = new Database(path);
        let oldDataset;
        try {
          oldDataset = db.prepare("SELECT value FROM core_meta WHERE key='dataset'").get().value;
          db.prepare("UPDATE core_meta SET value='1' WHERE key='format'").run();
        } finally {
          db.close();
        }
        const retained = [
          'data/core.sqlite',
          'setup/installation.json',
          'setup/settings.json',
          'setup/tls-state.json',
          'software.json',
          'control/writer.json',
        ];
        for (const directory of ['objects', 'logs', 'captures']) {
          const file = `data/${directory}/retained`;
          await mkdir(join(installation, 'data', directory), { recursive: true });
          await writeFile(join(installation, file), `retained ${directory}`);
          retained.push(file);
        }
        const snapshot = () =>
          Promise.all(
            retained.map((file) =>
              readFile(join(installation, file)).catch((error) => {
                if (error.code === 'ENOENT') return null;
                throw error;
              }),
            ),
          );
        const before = await snapshot();
        const refused = await cli('update', '--image', image, '--confirm-reset');
        assert.equal(refused.code, 'incompatible_format', JSON.stringify(refused));
        await assert.rejects(readFile(join(installation, 'recovery', 'action.json')), {
          code: 'ENOENT',
        });
        await assert.rejects(readFile(join(installation, 'recovery', 'proof.json')), {
          code: 'ENOENT',
        });
        assert.deepEqual(await snapshot(), before);
        const writer = JSON.parse(await readFile(join(installation, 'control', 'writer.json')));
        const manifest = JSON.parse(
          await readFile(join(installation, 'setup', 'installation.json')),
        );
        for (const phase of ['intent', 'stopped', 'cleaned']) {
          if (phase === 'cleaned') await rm(join(installation, 'data', 'objects', 'retained'));
          const expected =
            phase === 'cleaned'
              ? before.map((bytes, index) =>
                  retained[index] === 'data/objects/retained' ? null : bytes,
                )
              : before;
          const action = {
            format: 1,
            action_id: uuid(),
            installation_id: manifest.installation_id,
            kind: 'update',
            old_dataset: oldDataset,
            intended_dataset: uuid(),
            writer,
            image,
            phase,
            primary_failure: null,
            cleanup_failure: null,
          };
          await writeFile(join(installation, 'recovery', 'action.json'), JSON.stringify(action));
          const refusedRecovery = await cli('recover');
          assert.equal(
            refusedRecovery.code,
            'incompatible_format',
            JSON.stringify(refusedRecovery),
          );
          const pending = JSON.parse(await readFile(join(installation, 'recovery', 'action.json')));
          assert.equal(pending.phase, phase);
          assert.equal(pending.primary_failure, 'incompatible_format');
          await assert.rejects(readFile(join(installation, 'recovery', 'proof.json')), {
            code: 'ENOENT',
          });
          assert.deepEqual(
            await snapshot(),
            expected,
            `Recovery in ${phase} must refuse before cleanup and cannot restore missing files`,
          );
        }
      },
    );
    for (const denyExitProof of [false, true]) {
      await t.test(
        `failed Start stops its writer when settings writes fail${denyExitProof ? ' and retains the exit-proof failure' : ''}`,
        async () => {
          assert.notEqual(
            process.getuid(),
            0,
            'The filesystem failure regression requires an unprivileged user',
          );
          const failedInstallation = join(
            base,
            denyExitProof ? 'failed-start-and-proof' : 'failed-start',
          );
          const setup = await cliAt(
            failedInstallation,
            'setup',
            '--image',
            image,
            '--certificate',
            cert,
            '--key',
            key,
            '--credential-file',
            credentials,
            '--settings',
            settingsFile,
          );
          assert.equal(setup.ok, true, JSON.stringify(setup));
          const setupDirectory = join(failedInstallation, 'setup'),
            exitsDirectory = join(failedInstallation, 'control', 'exits');
          const manifest = JSON.parse(await readFile(join(setupDirectory, 'installation.json')));
          installationIds.add(manifest.installation_id);
          assert.deepEqual(await readdir(exitsDirectory), []);
          const settingsBefore = await readFile(join(setupDirectory, 'settings.json'), 'utf8');
          await chmod(setupDirectory, 0o500);
          try {
            if (denyExitProof) await chmod(exitsDirectory, 0o500);
            if (denyExitProof) {
              const failed = await cliAt(failedInstallation, 'start');
              assert.equal(failed.ok, false);
              assert.equal(failed.code, 'management_failed');
              assert.equal(failed.primary_failure, 'management_failed');
              assert.equal(failed.cleanup_failure, 'management_failed');
              assert.deepEqual(failed.failures, [
                'management_failed',
                'management_failed',
                'management_failed',
                'management_failed',
              ]);
              assert.ok(!JSON.stringify(failed).includes(failedInstallation));
              assert.ok(!JSON.stringify(failed).includes(newKey));
            } else {
              let failure;
              try {
                await installationLock(failedInstallation, () =>
                  new Administration(failedInstallation).start(),
                );
              } catch (error) {
                failure = error;
              }
              assert.ok(
                failure instanceof AggregateError,
                `Start must retain both settings write errors: ${failure}`,
              );
              assert.equal(failure.message, 'start_cleanup_failed');
              assert.equal(failure.errors.length, 3);
              assert.ok(failure.errors[2].path.startsWith(join(setupDirectory, 'tls-state.json.')));
              for (const error of failure.errors.slice(0, 2)) {
                assert.equal(error.code, 'EACCES');
                assert.equal(error.syscall, 'open');
                assert.ok(error.path.startsWith(join(setupDirectory, 'settings.json.')));
              }
              assert.notEqual(failure.errors[0], failure.errors[1]);
            }
            assert.equal(
              await readFile(join(setupDirectory, 'settings.json'), 'utf8'),
              settingsBefore,
            );
            const writer = JSON.parse(
              await readFile(join(failedInstallation, 'control', 'writer.json'), 'utf8'),
            );
            const [state] = JSON.parse(
              (await exec('sudo', ['-n', 'docker', 'inspect', writer.container], { cwd: root }))
                .stdout,
            );
            assert.equal(
              state.State.Running,
              false,
              'The command must stop the live container before returning',
            );
            assert.equal(state.State.ExitCode, 0, 'The runtime must complete a graceful shutdown');
            assert.ok(writer.host, 'Startup must have captured the live writer identity');
            assert.equal(await writerExited(writer.host), true);
            const proofPath = join(exitsDirectory, `${writer.container}.json`);
            if (denyExitProof) {
              await assert.rejects(readFile(proofPath), { code: 'ENOENT' });
            } else {
              assert.deepEqual(JSON.parse(await readFile(proofPath)), {
                container: writer.container,
                launch: writer.launch,
                installation: manifest.installation_id,
              });
            }
          } finally {
            await chmod(setupDirectory, 0o700);
            await chmod(exitsDirectory, 0o700);
          }
        },
      );
    }
  },
);
