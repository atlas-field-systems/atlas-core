import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import { fileEvidence } from './qualification-evidence.mjs';

const [flag, revision, ...paths] = process.argv.slice(2);
assert.ok(
  flag === '--revision' && /^[0-9a-f]{40}$/.test(revision) && paths.length > 0,
  'Usage: npm run evidence:verify -- --revision <full-HEAD> <qualification.json> [...]',
);
const kinds = new Set();
let artifactHash;
for (const path of paths) {
  const directory = dirname(resolve(path));
  assert.ok((await stat(path)).size <= 1024 * 1024, 'Qualification report is too large');
  const report = JSON.parse(await readFile(path, 'utf8'));
  const evidence = report.evidence;
  assert.equal(evidence?.version, 1, 'Unsupported evidence version');
  assert.ok(['package', 'browser'].includes(evidence.kind), 'Unknown qualification kind');
  assert.ok(!kinds.has(evidence.kind), 'Duplicate qualification kind');
  kinds.add(evidence.kind);
  assert.equal(evidence.status, 'passed', 'Qualification did not pass');
  for (const source of [evidence.source, evidence.sourceAfter]) {
    assert.equal(source?.revision, revision, 'Tested revision differs');
    assert.equal(source.dirty, false, 'Dirty source is not handoff evidence');
  }
  assert.equal(evidence.tools.node, '24.22.1');
  assert.equal(evidence.tools.npm, '11.19.0');
  assert.ok(
    Date.parse(evidence.finishedAt) >= Date.parse(evidence.startedAt),
    'Incomplete qualification',
  );
  async function verifyFile(file, limit) {
    assert.ok(
      file && typeof file.path === 'string' && !isAbsolute(file.path),
      'Missing relative evidence path',
    );
    const target = resolve(directory, file.path);
    const location = relative(directory, target);
    assert.ok(
      location && location !== '..' && !location.startsWith(`..${sep}`),
      'Evidence escapes report directory',
    );
    assert.ok(
      Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= limit,
      'Invalid evidence size',
    );
    assert.equal((await stat(target)).size, file.bytes, `Evidence size changed: ${file.path}`);
    assert.deepEqual(
      await fileEvidence(directory, target),
      { path: file.path, bytes: file.bytes, sha256: file.sha256 },
      `Evidence hash changed: ${file.path}`,
    );
  }
  await verifyFile(evidence.artifact, 64 * 1024 * 1024);
  artifactHash ??= evidence.artifact.sha256;
  assert.equal(evidence.artifact.sha256, artifactHash, 'Reports tested different SDK artifacts');
  const expected = new Map([
    ['build', 0],
    ['pack', 0],
    ['install', 0],
    ['positive-types', 0],
    ['bundle', 0],
    ...(evidence.kind === 'package'
      ? [
          ['source', 0],
          ...Array.from({ length: 7 }, (_, i) => [`negative-types-${i}`, 2]),
          ['installed', 0],
        ]
      : [['firefox', 0]]),
  ]);
  assert.equal(evidence.commands.length, expected.size, 'Missing or unexpected commands');
  for (const [index, command] of evidence.commands.entries()) {
    assert.ok(expected.has(command.name), `Unexpected command: ${command.name}`);
    assert.equal(command.expectedExit, expected.get(command.name), 'Unexpected exit contract');
    expected.delete(command.name);
    assert.equal(command.status, 'passed', `Failed command: ${command.name}`);
    assert.equal(command.exit, command.expectedExit, `Failed exit: ${command.name}`);
    assert.equal(command.signal, null, 'Signalled command');
    assert.ok(
      Date.parse(command.finishedAt) >= Date.parse(command.startedAt),
      'Unfinished command',
    );
    assert.ok(
      Array.isArray(command.argv) &&
        command.argv.length > 0 &&
        command.argv.every((arg) => typeof arg === 'string'),
      'Missing argv',
    );
    assert.ok(typeof command.cwd === 'string' && isAbsolute(command.cwd), 'Missing cwd');
    assert.equal(command.logs.length, 2, 'Missing stdout/stderr evidence');
    const prefix = `evidence/${String(index + 1).padStart(2, '0')}-${command.name}`;
    assert.deepEqual(
      command.logs.map((log) => log.path).sort(),
      [`${prefix}.stderr.log`, `${prefix}.stdout.log`],
      'Missing distinct stdout/stderr evidence',
    );
    for (const log of command.logs) {
      assert.equal(log.closed, true, 'Unclosed log');
      assert.equal(log.truncated, false, 'Truncated log');
      await verifyFile(log, 16 * 1024 * 1024);
    }
  }
  assert.equal(report.browserBundle, true);
  const requiredFiles = [
    'browser-metafile.json',
    ...(evidence.kind === 'browser' ? ['runtime.json', 'traffic.json', 'profile-trust.txt'] : []),
  ];
  assert.deepEqual(
    evidence.files.map((file) => file.path).sort(),
    requiredFiles.sort(),
    'Missing or unexpected supporting evidence',
  );
  for (const file of evidence.files) await verifyFile(file, 64 * 1024 * 1024);
  if (evidence.kind === 'package') {
    assert.equal(report.sourceHttpsTests, true, 'Source phase not qualified');
    assert.equal(report.installedHttpsTests, true);
    assert.equal(report.positiveTypes, true);
    assert.equal(report.negativeTypeCases, 7);
  } else {
    assert.equal(report.typedBrowserWorkflows, true);
    assert.equal(report.testProcessExited, true);
    for (const key of [
      'unknownIssuerRejected',
      'caTrustedOnlyInProfile',
      'authenticatedTlsSucceeded',
    ])
      assert.equal(report.trust?.[key], true, `Missing trust evidence: ${key}`);
    for (const key of ['sdkClosed', 'browsersClosed', 'coreWorkerExited', 'serversClosed'])
      assert.equal(report.shutdown?.[key], true, `Missing cleanup evidence: ${key}`);
    assert.ok(typeof report.browser?.version === 'string', 'Missing actual browser version');
  }
  console.log(`PASS ${evidence.kind} ${revision} SDK SHA-256 ${evidence.artifact.sha256}`);
}
