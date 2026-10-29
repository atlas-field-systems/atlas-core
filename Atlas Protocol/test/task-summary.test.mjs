import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, exchanges, readHttp } from '../dist/index.js';
import * as s from './samples.mjs';
const read = (task, version = PROTOCOL_VERSION) =>
  readHttp(
    exchanges.GetTask,
    {
      status: 200,
      headers: new Headers({
        'Content-Type': 'application/json',
        'Atlas-Dataset-ID': s.id,
        'Atlas-Protocol-Version': version,
      }),
      body: new TextEncoder().encode(JSON.stringify({ dataset_id: s.id, data: task })),
    },
    { datasetId: s.id, request: { task_id: s.taskId } },
  );

test('Task reads require a compact, consistent selected execution summary', () => {
  read(s.task);
  const { execution_summary, ...missing } = s.task;
  assert.throws(() => read(missing));
  assert.throws(() => read(s.task, '0.2.0'));
  const summary = {
    origin: s.origin,
    report_id: s.requestId,
    sequence: '9007199254740993',
    generated_at: '2026-10-21T12:00:00.000000123Z',
    event: 'state',
    state: 'failed',
    reason: 'target_unreachable',
    message: 'Fence blocked route',
    geometry_revision: '9007199254740993',
  };
  const failed = {
    ...s.task,
    inputs: { target: { kind: 'geofeature', geofeature_id: s.requestId } },
    execution_state: 'failed',
    execution_summary: summary,
  };
  assert.deepEqual(read(failed).body.data.execution_summary, summary);
  for (const change of [
    (task) => {
      task.execution_summary = null;
    },
    (task) => {
      delete task.execution_summary.reason;
    },
    (task) => {
      task.execution_summary.reason = null;
    },
    (task) => {
      task.execution_summary.geometry_revision = null;
    },
    (task) => {
      task.execution_state = 'completed';
    },
    (task) => {
      task.execution_summary.generated_at = 'invalid';
    },
    (task) => {
      task.execution_summary.origin = { kind: 'publisher', publisher_id: s.id };
    },
    (task) => {
      task.execution_summary.sql = 'private';
    },
    (task) => {
      task.inputs = s.task.inputs;
    },
  ]) {
    const invalid = structuredClone(failed);
    change(invalid);
    assert.throws(() => read(invalid));
  }
  const omitted = structuredClone(failed);
  delete omitted.execution_summary.geometry_revision;
  delete omitted.execution_summary.message;
  omitted.execution_summary.generated_at = null;
  const actual = read(omitted).body.data.execution_summary;
  assert.equal(actual.generated_at, null);
  assert.equal(Object.hasOwn(actual, 'geometry_revision'), false);
  assert.equal(Object.hasOwn(actual, 'message'), false);
});
