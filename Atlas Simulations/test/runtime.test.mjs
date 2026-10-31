import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { loadScenario } from '../dist/scenario.js';
import { evaluate } from '../dist/run.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
test(
  'shared runtime moves to points in requested order after idle Pause and fresh Resume',
  { timeout: 90000 },
  async () => {
    const before = new Set(await readdir(process.env.ATLAS_TEST_ROOT));
    const input = await loadScenario('scenarios/road-inspection.json');
    const record = await evaluate(input);
    assert.equal(record.verdict, 'passed', JSON.stringify(record));
    const m = record.measurements;
    assert.ok(
      m.requests > m.observedAttempts,
      'HTTP reads and Full bootstrap requests count beyond instrumented writes',
    );
    assert.equal(m.latencyCoverage + m.latencyOmissions, m.observedAttempts);
    assert.ok(m.acceptedReports > 0 && m.pictureLagCoverage > 0 && m.coreSamples > 0);
    assert.ok(m.databaseBytes > 0 && m.installationBytes >= m.databaseBytes + m.walBytes);
    const directory = (await readdir(process.env.ATLAS_TEST_ROOT)).find(
      (n) => n.startsWith('run-') && !before.has(n),
    );
    assert.ok(directory);
    const sizes = execFileSync(
      'find',
      [
        join(process.env.ATLAS_TEST_ROOT, directory, 'installation'),
        '-type',
        'f',
        '-printf',
        '%s\n',
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .map(Number);
    assert.equal(
      m.installationBytes,
      sizes.reduce((sum, n) => sum + n, 0),
      'Final byte count includes verified writer exit artifacts',
    );
    assert.notEqual(
      record.inputs.actualSettings,
      record.inputs.settings,
      'Record actual installed Settings including selected port',
    );
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
        const starts = e.physical.filter((p) => p.event === 'start' && p.asset === 'Drone 1');
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
    const skippedHead = decode(structuredClone(capture.evidence));
    const firstStart = skippedHead.physical.find(
      (p) => p.event === 'start' && p.asset === 'Drone 1',
    );
    assert.ok(firstStart);
    skippedHead.physical = skippedHead.physical.filter((p) => p !== firstStart);
    assert.equal(checkEvidence(input, skippedHead).order.kind, 'failed');
    const worldless = decode(structuredClone(capture.evidence));
    worldless.world = [];
    assert.equal(checkEvidence(input, worldless).positions.kind, 'failed');
    for (const entity of [capture.evidence.observations[0][0], capture.evidence.tracks[0].id]) {
      const missingHistory = decode(structuredClone(capture.evidence));
      missingHistory.history.set(entity, []);
      assert.equal(checkEvidence(input, missingHistory).positions.kind, 'failed');
    }
    const complete = checkEvidence(input, decode(capture.evidence));
    delete complete.positions;
    assert.equal(CheckResults.safeParse(complete).success, false);
  },
);
test(
  'unwritable history turns a correct mission into a failed recorded run',
  { timeout: 90000 },
  async () => {
    const previous = process.env.ATLAS_EVAL_HISTORY;
    process.env.ATLAS_EVAL_HISTORY = '/dev/null/atlas-history';
    try {
      const record = await evaluate(await loadScenario('scenarios/road-inspection.json'));
      assert.equal(record.verdict, 'failed');
      assert.ok(Object.values(record.checks).every((check) => check.kind === 'passed'));
      assert.match(record.failures.join(' '), /History publication/);
      assert.equal(record.cleanup.coreExit, 'verified');
    } finally {
      if (previous === undefined) delete process.env.ATLAS_EVAL_HISTORY;
      else process.env.ATLAS_EVAL_HISTORY = previous;
    }
  },
);

test(
  'a completed move cannot hide an earlier arrival short of its target',
  { timeout: 60000 },
  async () => {
    const { World } = await import('../dist/world.js');
    const { Scenario } = await import('../dist/scenario.js');
    const scenario = Scenario.parse({
      name: 'premature-first-arrival',
      assets: [
        {
          alias: 'Drone',
          position: { latitude: 0, longitude: 0 },
          cruise_speed: 100,
          detection_radius: 0,
        },
      ],
      subjects: [],
      timeline: [
        {
          at_seconds: 0,
          action: 'move_to',
          asset: 'Drone',
          position: { latitude: 0.001, longitude: 0 },
        },
        {
          at_seconds: 0,
          action: 'move_to',
          asset: 'Drone',
          position: { latitude: 0.002, longitude: 0 },
        },
      ],
      deadline_seconds: 30,
      expect: {
        tasks: [
          { asset: 'Drone', index: 0, state: 'completed' },
          { asset: 'Drone', index: 1, state: 'completed' },
        ],
        tracks: 0,
      },
    });
    const move = World.prototype.move;
    let injected = false;
    World.prototype.move = function (...args) {
      if (!injected) {
        injected = true;
        return true;
      }
      return move.apply(this, args);
    };
    try {
      const record = await evaluate({ scenario, sha256: '1'.repeat(64) });
      assert.ok(injected);
      assert.equal(record.verdict, 'failed');
      assert.equal(record.checks.tasks.kind, 'failed');
      assert.match(record.checks.tasks.reasons.join(' '), /Arrival missed target/);
      assert.equal(
        record.checks.final_position.kind,
        'passed',
        'Later correct arrival does not mask the earlier defect',
      );
    } finally {
      World.prototype.move = move;
    }
    const baseline = await evaluate({ scenario, sha256: '1'.repeat(64) });
    assert.equal(baseline.verdict, 'passed', JSON.stringify(baseline));
  },
);

test(
  'cancelling later work keeps its held position after an earlier arrival',
  { timeout: 60000 },
  async () => {
    const { Scenario } = await import('../dist/scenario.js');
    const scenario = Scenario.parse({
      name: 'cancel-after-arrival',
      assets: [
        {
          alias: 'Drone',
          position: { latitude: 0, longitude: 0 },
          cruise_speed: 10,
          detection_radius: 0,
        },
      ],
      subjects: [],
      timeline: [
        {
          at_seconds: 0,
          action: 'move_to',
          asset: 'Drone',
          position: { latitude: 0, longitude: 0 },
        },
        {
          at_seconds: 4,
          action: 'move_to',
          asset: 'Drone',
          position: { latitude: 1, longitude: 0 },
        },
        { at_seconds: 8, action: 'cancel', asset: 'Drone', index: 1 },
      ],
      deadline_seconds: 30,
      expect: {
        tasks: [
          { asset: 'Drone', index: 0, state: 'completed' },
          { asset: 'Drone', index: 1, state: 'cancelled' },
        ],
        tracks: 0,
      },
    });
    const record = await evaluate({ scenario, sha256: '2'.repeat(64) });
    assert.equal(record.verdict, 'passed', JSON.stringify(record));
  },
);

test(
  'reordering pending work preserves previously completed execution',
  { timeout: 60000 },
  async () => {
    const { Scenario } = await import('../dist/scenario.js');
    const scenario = Scenario.parse({
      name: 'reorder-after-completed',
      assets: [
        {
          alias: 'Drone',
          position: { latitude: 0, longitude: 0 },
          cruise_speed: 1000000,
          detection_radius: 0,
        },
      ],
      subjects: [],
      timeline: [
        {
          at_seconds: 0,
          action: 'move_to',
          asset: 'Drone',
          position: { latitude: 0, longitude: 0 },
        },
        { at_seconds: 4, action: 'pause', asset: 'Drone' },
        {
          at_seconds: 6,
          action: 'move_to',
          asset: 'Drone',
          position: { latitude: 0.001, longitude: 0 },
        },
        {
          at_seconds: 6,
          action: 'move_to',
          asset: 'Drone',
          position: { latitude: 0.002, longitude: 0 },
        },
        { at_seconds: 7, action: 'reorder', asset: 'Drone', indexes: [2, 1] },
        { at_seconds: 8, action: 'resume', asset: 'Drone' },
      ],
      deadline_seconds: 30,
      expect: {
        tasks: [
          { asset: 'Drone', index: 0, state: 'completed' },
          { asset: 'Drone', index: 1, state: 'completed' },
          { asset: 'Drone', index: 2, state: 'completed' },
        ],
        tracks: 0,
      },
    });
    const record = await evaluate({ scenario, sha256: '2'.repeat(64) });
    assert.equal(record.verdict, 'passed', JSON.stringify(record));
  },
);
