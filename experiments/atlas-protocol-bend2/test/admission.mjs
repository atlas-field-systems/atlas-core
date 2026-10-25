import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'atlas-bend2-admission-'));
const compiler =
  process.env.BEND ?? fileURLToPath(new URL('../.tools/bend-2.0.39/bin/bend', import.meta.url));
const result = spawnSync(
  compiler,
  [
    fileURLToPath(new URL('../admission.bend', import.meta.url)),
    '-o',
    join(directory, 'admission.mjs'),
  ],
  { encoding: 'utf8', env: { ...process.env, BEND_NO_TELEMETRY: '1' } },
);
assert.equal(result.status, 0, result.stderr + result.stdout);
const empty = { $: 'JObj', members: { $: 'Nil' } };
const budget = {
  $: 'Budget',
  max_bytes: 4194304,
  max_values: 262144,
  max_depth: 32,
  max_changes: 1000,
  max_geometry_work: 4194304,
};
function list(values) {
  let result = { $: 'Nil' };
  for (let index = values.length - 1; index >= 0; index--)
    result = { $: 'Con', head: values[index], tail: result };
  return result;
}
try {
  const { default: implementation } = await import(pathToFileURL(join(directory, 'admission.mjs')));
  const prepare = (name, value) =>
    implementation.prepare(
      name,
      list(new TextEncoder().encode(JSON.stringify(value))),
      budget,
      empty,
    );
  const largeControl = { type: 'error', message: 'x'.repeat(16384) };
  assert.equal(prepare('Wss.ServerFrame', largeControl).error.code.$, 'PayloadTooLarge');
  assert.equal(prepare('ServerFrame', largeControl).$, 'Done');
  assert.equal(
    prepare('Wss.ServerFrame', { type: 'error', values: Array(4096).fill(0) }).error.code.$,
    'ResourceLimit',
  );
  const envelope = (limits) => ({ dataset_id: 'dataset', data: { limits, items: [] } });
  const limits = { max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 };
  const accepted = prepare('Success.ReadSnapshot', envelope(limits));
  assert.equal(accepted.$, 'Done');
  assert.equal(accepted.value.budget.max_changes, 1000);
  assert.equal(
    prepare('Success.ReadSnapshot', envelope({ ...limits, max_message_bytes: 1 })).error.code.$,
    'PayloadTooLarge',
  );
  assert.equal(
    prepare('Success.ReadSnapshot', envelope({ ...limits, max_json_values: 1 })).error.code.$,
    'ResourceLimit',
  );
  assert.equal(prepare('SnapshotPage', envelope({ ...limits, max_message_bytes: 1 })).$, 'Done');
  assert.equal(
    prepare('Success.ReadSnapshot', envelope({ ...limits, max_changes: 1001 })).$,
    'Done',
  );
  assert.equal(
    prepare('Wss.ServerFrame', {
      type: 'read_snapshot_result',
      ...envelope({ ...limits, max_message_bytes: 1 }),
    }).error.code.$,
    'PayloadTooLarge',
  );
  console.log('admission: control and declared snapshot limits enforced before tree construction');
} finally {
  await rm(directory, { recursive: true, force: true });
}
