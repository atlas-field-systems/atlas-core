import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = new URL('../scripts/qualification-evidence.mjs', import.meta.url).href;
const verifier = fileURLToPath(new URL('../scripts/verify-evidence.mjs', import.meta.url));

for (const kind of ['package', 'browser']) {
  test(`${kind} evidence requires its revision, artifact, supporting files and both closed log streams`, async () => {
    const directory = await mkdtemp(
      join(process.env.ATLAS_TEST_ROOT ?? tmpdir(), 'evidence-probe-'),
    );
    const execute = (argv, cwd = directory) => {
      const result = spawnSync(argv[0], argv.slice(1), {
        cwd,
        env: process.env,
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      return result;
    };
    try {
      for (const args of [
        ['init', '-q'],
        [
          '-c',
          'user.name=Evidence test',
          '-c',
          'user.email=evidence@example.invalid',
          'commit',
          '--allow-empty',
          '-qm',
          'fixture',
        ],
      ])
        assert.equal(execute(['git', ...args]).status, 0);
      const revision = execute(['git', 'rev-parse', 'HEAD']).stdout.trim();
      await writeFile(join(directory, '.gitignore'), '*\n');
      await writeFile(
        join(directory, 'generate.mjs'),
        `
import { createQualification } from ${JSON.stringify(helper)};
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const cwd = process.cwd();
const directory = join(cwd, 'report');
await mkdir(directory);
const qualification = await createQualification(directory, ${JSON.stringify(kind)}, cwd);
let failure;
try {
  await writeFile(join(directory, 'sdk.tgz'), 'test archive bytes');
  await qualification.artifact(join(directory, 'sdk.tgz'));
  for (const name of ${JSON.stringify(kind === 'package' ? ['browser-metafile.json'] : ['browser-metafile.json', 'runtime.json', 'traffic.json', 'profile-trust.txt'])}) {
    await writeFile(join(directory, name), '{}');
    await qualification.retain(join(directory, name));
  }
  for (const name of ${JSON.stringify(['build', 'pack', 'install', 'positive-types', 'bundle', ...(kind === 'package' ? ['source', 'installed'] : ['firefox'])])}) {
    await qualification.run(name, [process.execPath, '-e', "console.log('retained stdout'); console.error('retained stderr')"]);
  }
  for (let i = 0; i < ${kind === 'package' ? 7 : 0}; i++) {
    await qualification.run('negative-types-' + i, [process.execPath, '-e', "console.log('expected refusal'); process.exit(2)"], { expectedExit: 2 });
  }
  Object.assign(qualification.report, { browserBundle: true, sourceHttpsTests: true, installedHttpsTests: true, positiveTypes: true, negativeTypeCases: 7, typedBrowserWorkflows: true, testProcessExited: true, trust: { unknownIssuerRejected: true, caTrustedOnlyInProfile: true, authenticatedTlsSucceeded: true }, shutdown: { sdkClosed: true, browsersClosed: true, coreWorkerExited: true, serversClosed: true }, browser: { version: 'test fixture' } });
} catch (error) { failure = error; process.exitCode = 1; }
finally { await qualification.finish(failure); }
`,
      );
      const generated = execute([process.execPath, join(directory, 'generate.mjs')]);
      assert.equal(generated.status, 0, generated.stderr);
      const reportPath = join(directory, 'report/qualification.json');
      const original = await readFile(reportPath, 'utf8');
      const report = JSON.parse(original);
      const verify = (expected = revision) =>
        execute([process.execPath, verifier, '--revision', expected, reportPath]);
      assert.equal(verify().status, 0, verify().stderr);
      const stdout = join(directory, 'report', report.evidence.commands[0].logs[0].path);
      const stderr = join(directory, 'report', report.evidence.commands[0].logs[1].path);
      assert.equal(await readFile(stdout, 'utf8'), 'retained stdout\n');
      assert.equal(await readFile(stderr, 'utf8'), 'retained stderr\n');
      assert.notEqual(verify('0'.repeat(40)).status, 0);
      for (const corrupt of [
        (r) => {
          r.evidence.source.dirty = true;
        },
        (r) => {
          r.evidence.sourceAfter.revision = '0'.repeat(40);
        },
        (r) => {
          r.evidence.commands[0].exit = 3;
        },
        (r) => {
          r.evidence.commands[0].signal = 'SIGTERM';
        },
        (r) => {
          r.evidence.commands[0].logs[0].closed = false;
        },
        (r) => {
          r.evidence.commands[0].logs[0].truncated = true;
        },
        (r) => {
          delete r.evidence.commands[0].finishedAt;
        },
        (r) => {
          r.evidence.commands = r.evidence.commands.filter(
            (c) => c.name !== (kind === 'package' ? 'source' : 'firefox'),
          );
        },
        (r) => {
          r.evidence.commands[0].logs[1] = r.evidence.commands[0].logs[0];
        },
        ...report.evidence.files.map((file) => (r) => {
          r.evidence.files = r.evidence.files.filter((entry) => entry.path !== file.path);
        }),
        ...(kind === 'package'
          ? [
              (r) => {
                r.sourceHttpsTests = false;
              },
              (r) => {
                r.evidence.commands.find((c) => c.name === 'negative-types-0').exit = 0;
              },
            ]
          : []),
      ]) {
        const changed = JSON.parse(original);
        corrupt(changed);
        await writeFile(reportPath, JSON.stringify(changed));
        assert.notEqual(verify().status, 0, 'Corrupt report accepted');
      }
      await writeFile(reportPath, original);
      for (const path of [join(directory, 'report/sdk.tgz'), stdout]) {
        const bytes = await readFile(path);
        await writeFile(path, Buffer.alloc(bytes.length, 120));
        assert.notEqual(verify().status, 0, 'Same-size tampering accepted');
        await rm(path);
        assert.notEqual(verify().status, 0, 'Missing evidence accepted');
        await writeFile(path, bytes);
      }
      assert.equal(verify().status, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('failed commands and excessive output retain failed reports and bounded closed logs', async () => {
  const directory = await mkdtemp(
    join(process.env.ATLAS_TEST_ROOT ?? tmpdir(), 'evidence-failure-'),
  );
  try {
    for (const [name, code, expectedExit] of [
      ['exit', "console.error('primary failure'); process.exit(7)", 7],
      ['overflow', "process.stdout.write('x'.repeat(17 * 1024 * 1024))", 1],
    ]) {
      const script = join(directory, `${name}.mjs`);
      await writeFile(
        script,
        `
import { createQualification } from ${JSON.stringify(helper)};
import { mkdir } from 'node:fs/promises';
const directory = ${JSON.stringify(join(directory, name))};
await mkdir(directory);
const qualification = await createQualification(directory, 'package', ${JSON.stringify(fileURLToPath(new URL('../', import.meta.url)))});
let failure;
try { await qualification.run('probe', [process.execPath, '-e', ${JSON.stringify(code)}]); }
catch (error) { failure = error; process.exitCode = error.exitCode; }
finally { await qualification.finish(failure); }
`,
      );
      const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expectedExit, result.stderr);
      const report = JSON.parse(
        await readFile(join(directory, name, 'qualification.json'), 'utf8'),
      );
      assert.equal(report.evidence.status, 'failed');
      const command = report.evidence.commands[0];
      assert.equal(command.status, 'failed');
      assert.equal(command.exit, name === 'exit' ? 7 : 0);
      assert.equal(command.logs.length, 2);
      assert.ok(command.logs.every((log) => log.closed && log.bytes <= 16 * 1024 * 1024));
      if (name === 'overflow') assert.equal(command.logs[0].truncated, true);
      else
        assert.equal(
          await readFile(join(directory, name, command.logs[1].path), 'utf8'),
          'primary failure\n',
        );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
