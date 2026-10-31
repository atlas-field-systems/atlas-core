import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenario } from '../dist/scenario.js';
import { evaluate } from '../dist/run.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
test(
  'shared runtime moves to points in requested order after idle Pause and fresh Resume',
  { timeout: 90000 },
  async () => {
    const input = await loadScenario('scenarios/road-inspection.json');
    const record = await evaluate(input);
    assert.equal(record.verdict, 'passed', JSON.stringify(record));
  },
);
test('failed setup still writes a failed complete record', { timeout: 30000 }, async () => {
  const before = await readdir(process.env.ATLAS_TEST_ROOT);
  const key = process.env.ATLAS_SIM_TLS_KEY;
  delete process.env.ATLAS_SIM_TLS_KEY;
  try {
    const record = await evaluate(await loadScenario('scenarios/road-inspection.json'));
    assert.equal(record.verdict, 'failed');
    assert.match(record.failures.join(' '), /TLS/);
    const after = await readdir(process.env.ATLAS_TEST_ROOT);
    const added = after.filter((v) => !before.includes(v) && v.startsWith('run-'));
    assert.equal(added.length, 1);
    const files = await readdir(join(process.env.ATLAS_TEST_ROOT, added[0], 'records'));
    assert.equal(files.length, 1);
  } finally {
    process.env.ATLAS_SIM_TLS_KEY = key;
  }
});
test(
  'each independent check rejects its named broken observation and missing checks fail decoding',
  { timeout: 90000 },
  async () => {
    const { readFile } = await import('node:fs/promises');
    const { checkEvidence } = await import('../dist/checks.js');
    const { CheckResults } = await import('../dist/records.js');
    const dirs = (await readdir(process.env.ATLAS_TEST_ROOT)).filter((n) => n.startsWith('run-'));
    let capture;
    for (const dir of dirs) {
      try {
        const value = JSON.parse(
          await readFile(join(process.env.ATLAS_TEST_ROOT, dir, 'evidence.json'), 'utf8'),
        );
        if (value.scenario.name === 'road-inspection') capture = value;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    assert.ok(capture, 'Real run verification capture required');
    const input = {
      scenario: capture.scenario,
      assets: new Map(capture.assets),
      moves: capture.moves,
    };
    const decode = (value) => ({
      ...value,
      assets: new Map(value.assets),
      tasks: new Map(value.tasks),
      observations: new Map(value.observations),
      history: new Map(value.history),
    });
    assert.ok(
      Object.values(checkEvidence(input, decode(capture.evidence))).every(
        (r) => r.kind === 'passed',
      ),
    );
    const mutations = {
      tasks: (i, e) => {
        const task = e.tasks.values().next().value;
        task.execution_state = 'failed';
      },
      order: (i, e) => {
        const starts = e.physical.filter((p) => p.event === 'start');
        [starts[0].task, starts[1].task] = [starts[1].task, starts[0].task];
      },
      assets: (i, e) => {
        i.scenario.expect.removed_assets = [i.scenario.assets[0].alias];
      },
      positions: (i, e) => {
        e.history.values().next().value.pop();
      },
      final_position: (i, e) => {
        e.assets.values().next().value.telemetry.value.position.latitude = 0;
      },
      tracks: (i, e) => {
        i.scenario.expect.tracks++;
      },
      tags: (i, e) => {
        const first = e.submissions.find((s) => s.operation === 'UpdateAsset');
        delete first.facts.report.sections.tags;
      },
      faults: (i, e) => {
        i.scenario.timeline.push({ at_seconds: 25, action: 'fault', id: 'reply-lost' });
      },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const i = structuredClone(input),
        e = decode(structuredClone(capture.evidence));
      mutate(i, e);
      assert.equal(checkEvidence(i, e)[name].kind, 'failed', name);
    }
    const complete = checkEvidence(input, decode(capture.evidence));
    delete complete.positions;
    assert.equal(CheckResults.safeParse(complete).success, false);
  },
);
