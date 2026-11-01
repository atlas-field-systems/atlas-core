import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareRecords, compareHistory } from '../dist/history.js';
import { saveRecord, readRecord, checkNames } from '../dist/records.js';
import { Group, inGroup } from '../dist/groups.js';
import { loadScenario } from '../dist/scenario.js';
import { aggregate } from '../scripts/ci-record.mjs';
const record = (branch = 'main', n = 1) => ({
  scenario: 'fixture',
  at: `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`,
  source: { branch, commit: 'a'.repeat(40), dirty: false },
  inputs: { scenario: 'a'.repeat(64), settings: 'b'.repeat(64) },
  checks: Object.fromEntries(checkNames.map((n) => [n, { kind: 'passed' }])),
  cleanup: {
    writersDrained: true,
    createdKeysRevoked: true,
    clientsClosed: true,
    coreExit: 'verified',
    failures: [],
  },
  verdict: 'passed',
  failures: [],
  measurements: { durationMs: n * 10 },
  environment: {
    node: 'v24.22.1',
    cpu: 'fixture',
    cpus: 4,
    memory: 16000000000,
    kernel: 'fixture',
    image: 'sha256:' + 'c'.repeat(64),
  },
});
test('history compares newest ten main medians, marks hashes and only correctness regressions fail CLI', async () => {
  const root = await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'comparison-'));
  const records = Array.from({ length: 12 }, (_, i) => record('main', i + 1));
  const right = record('feature', 13);
  right.inputs.scenario = 'd'.repeat(64);
  right.inputs.settings = 'e'.repeat(64);
  right.environment.cpu = 'other';
  records.push(right);
  for (const r of records) await saveRecord(root, r);
  const result = await compareHistory(root, 'main', 'feature');
  assert.equal(result[0].measurements.durationMs.before, 75);
  assert.equal(result[0].measurements.durationMs.after, 130);
  assert.ok(Math.abs(result[0].measurements.durationMs.percent - 73.3333333) < 0.001);
  assert.deepEqual(result[0].differences, ['scenario hash', 'settings hash', 'CPU model']);
  const cli = () =>
    spawnSync(process.execPath, ['dist/cli.js', 'compare', 'main', 'feature'], {
      env: { ...process.env, ATLAS_EVAL_HISTORY: root },
      encoding: 'utf8',
    });
  assert.equal(cli().status, 0);
  const unreadable = spawnSync(process.execPath, ['dist/cli.js', 'compare', 'main', 'feature'], {
    env: { ...process.env, ATLAS_EVAL_HISTORY: join(root, 'missing') },
  });
  assert.equal(unreadable.status, 2, 'Input errors stay distinct from a correctness regression');
  right.verdict = 'failed';
  right.at = '2026-10-14T00:00:00.000Z';
  right.checks.tasks = { kind: 'failed', reasons: ['control'] };
  await saveRecord(root, right);
  const failed = cli();
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /73.33%/);
  assert.equal(compareRecords([right], 'unknown', 'feature')[0].before, 'missing');
});
test('history streams archives beyond both lifetime entry limits and preserves selection', async () => {
  const root = await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'large-history-'));
  const append = async (slot, count) => {
    const directory = join(root, `archive-${slot}`);
    await mkdir(directory);
    const seed = join(directory, '0.json');
    await writeFile(seed, JSON.stringify(record('main', slot + 1)));
    for (let i = 1; i < count; i++) await link(seed, join(directory, `${i}.json`));
  };
  await append(0, 10001);
  await saveRecord(root, record('feature', 13));
  const first = await compareHistory(root, 'main', 'feature');
  assert.equal(first[0].measurements.durationMs.before, 10);
  assert.equal(first[0].measurements.durationMs.after, 130);
  for (let i = 1; i < 10; i++) await append(i, 10000);
  const result = await compareHistory(root, 'main', 'feature');
  assert.equal(result[0].measurements.durationMs.before, 55);
  assert.equal(result[0].measurements.durationMs.after, 130);
});
test('streaming history refuses oversized records, symlinks and excessive nesting', async () => {
  for (const kind of ['oversized', 'symlink', 'depth']) {
    const root = await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'unsafe-history-'));
    if (kind === 'oversized') await writeFile(join(root, 'large.json'), ' '.repeat(262145));
    if (kind === 'symlink') await symlink('/dev/null', join(root, 'link'));
    if (kind === 'depth') {
      let path = root;
      for (let i = 0; i < 17; i++) {
        path = join(path, 'child');
        await mkdir(path);
      }
    }
    await assert.rejects(
      compareHistory(root, 'main', 'feature'),
      kind === 'oversized' ? /Record exceeds/ : kind === 'symlink' ? /symlink/ : /depth/,
    );
  }
});
test('record writes are append-only and unwritable history fails', async () => {
  const root = await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'records-'));
  const path = await saveRecord(root, record());
  await assert.rejects(saveRecord(root, record()), /EEXIST/);
  assert.equal((await readRecord(path)).verdict, 'passed');
  await assert.rejects(saveRecord('/dev/null/atlas-unwritable-history', record()));
});
test('publisher rejects oversized, traversing, invalid and inconsistent records before publishing any', async () => {
  const root = await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'publisher-'));
  const source = join(root, 'input', 'records'),
    destination = join(root, 'history');
  await mkdir(source, { recursive: true });
  const run = (target = destination) =>
    spawnSync('python3', ['scripts/publish-records.py', join(root, 'input'), target, '123', '1'], {
      encoding: 'utf8',
    });
  const path = join(source, 'record.json');
  await writeFile(path, JSON.stringify(record()));
  assert.equal(run().status, 0);
  assert.notEqual(run().status, 0, 'append-only collision');
  const invalid = [
    { ...record(), scenario: '../escape' },
    { ...record(), checks: {} },
    { ...record(), failures: ['cannot pass'] },
    { ...record(), at: '2026-99-99T00:00:00.000Z' },
    { ...record(), environment: { ...record().environment, npm: {} } },
    { ...record(), environment: { ...record().environment, cpus: 9007199254740992 } },
  ];
  const bodies = [
    ...invalid.map((value) => JSON.stringify(value)),
    JSON.stringify(record()) + ' '.repeat(262145),
    JSON.stringify({ ...record(), measurements: { durationMs: 'OVERFLOW_NUMBER' } }).replace(
      '"OVERFLOW_NUMBER"',
      '1e309',
    ),
  ];
  for (const [index, bytes] of bodies.entries()) {
    await writeFile(path, bytes);
    const target = join(root, `invalid-${index}`);
    const result = run(target);
    assert.notEqual(result.status, 0, `Invalid record ${index} was accepted`);
    assert.deepEqual(
      await readdir(target).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }),
      [],
    );
  }
  assert.equal((await readdir(join(destination, 'fixture'))).length, 1);
  const workflow = await readFile('../.github/workflows/simulations.yml', 'utf8');
  const sourceCode = await readFile('scripts/publish-records.py', 'utf8');
  assert.ok(
    workflow.includes(
      sourceCode
        .trimEnd()
        .split('\n')
        .map((line) => (line ? '          ' + line : ''))
        .join('\n'),
    ),
    'Publisher runs this tested validator inline without artifact code',
  );
  assert.match(workflow, /fail-fast: false/);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/);
});
test('CI aggregator rejects failed, cancelled and missing groups and permits only fork publish skip', async () => {
  const root = join(await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'aggregation-')), 'records');
  await mkdir(root);
  const scenarios = await Promise.all(
    (await readdir('scenarios'))
      .filter((n) => n.endsWith('.json'))
      .map((n) => loadScenario(join('scenarios', n))),
  );
  for (const group of Group.options) {
    const dir = join(root, group);
    await mkdir(join(dir, 'records'), { recursive: true });
    const expected = scenarios.filter((i) => inGroup(i.scenario, group));
    for (const input of expected) {
      const r = record();
      r.scenario = input.scenario.name;
      r.inputs.scenario = input.sha256;
      await saveRecord(join(dir, 'records'), r);
    }
    await writeFile(
      join(dir, 'group.json'),
      JSON.stringify({ group, result: 'success', records: expected.length }),
    );
  }
  const needs = {
    build: { result: 'success' },
    eval: { result: 'success' },
    publish: { result: 'success' },
  };
  const history = join(root, '..', 'history');
  await mkdir(join(history, 'current'), { recursive: true });
  const workflow = await readFile('../.github/workflows/simulations.yml', 'utf8');
  const copyCommand = workflow.split('\n').find((line) => line.trimStart().startsWith('find '));
  assert.ok(copyCommand, 'The workflow must copy current run records');
  const copied = spawnSync('bash', ['-e', '-c', copyCommand], {
    env: { ...process.env, RECORD_DIRECTORY: root, ATLAS_EVAL_HISTORY: history },
    encoding: 'utf8',
  });
  assert.equal(copied.status, 0, copied.stderr);
  assert.equal((await readdir(join(history, 'current'))).length, scenarios.length);
  assert.equal((await compareHistory(history, 'main', 'a'.repeat(40))).length, scenarios.length);
  assert.deepEqual(await aggregate(root, needs, false), []);
  for (const result of ['failure', 'cancelled', 'skipped'])
    assert.ok((await aggregate(root, { ...needs, eval: { result } }, false)).length);
  assert.ok((await aggregate(root, { ...needs, publish: { result: 'skipped' } }, false)).length);
  assert.deepEqual(await aggregate(root, { ...needs, publish: { result: 'skipped' } }, true), []);
  await writeFile(
    join(root, 'ip', 'group.json'),
    JSON.stringify({ group: 'ip', result: 'failure', records: 0 }),
  );
  assert.ok((await aggregate(root, needs, false)).some((f) => f.startsWith('ip')));
  assert.ok((await aggregate(join(root, 'missing'), needs, false)).length >= 7);
});
test('concurrent orphan history appends retry without replacing prior records', async () => {
  const root = await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'history-git-'));
  const git = (args, cwd = root) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const remote = join(root, 'remote.git');
  git(['init', '--bare', remote]);
  const owners = [join(root, 'one'), join(root, 'two')];
  for (const [index, owner] of owners.entries()) {
    await mkdir(owner);
    git(['init'], owner);
    git(['remote', 'add', 'origin', remote], owner);
    git(['checkout', '--orphan', 'eval-history'], owner);
    git(['config', 'user.name', 'fixture'], owner);
    git(['config', 'user.email', 'fixture@example.test'], owner);
    await writeFile(join(owner, `record-${index}.json`), JSON.stringify(record()));
    git(['add', '.'], owner);
    git(['commit', '-m', 'Append fixture'], owner);
  }
  const script = join(process.cwd(), 'scripts/push-history.sh');
  for (const owner of owners) {
    const pushed = spawnSync('bash', [script], { cwd: owner, encoding: 'utf8' });
    assert.equal(pushed.status, 0, pushed.stderr);
  }
  const tree = git(['--git-dir', remote, 'ls-tree', '--name-only', 'eval-history']);
  assert.match(tree, /record-0.json/);
  assert.match(tree, /record-1.json/);
});
