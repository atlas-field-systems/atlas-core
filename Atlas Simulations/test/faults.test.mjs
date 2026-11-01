import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadScenario, faultIds } from '../dist/scenario.js';
import { evaluate } from '../dist/run.js';
import { verifyFault } from '../dist/fault-checks.js';
import { faultControls } from './fault-controls.mjs';
assert.deepEqual(Object.keys(faultControls).sort(), [...faultIds].sort());
for (const id of faultIds)
  test(`real fault ${id}`, { timeout: 240000 }, async (t) => {
    const before = new Set(await readdir(process.env.ATLAS_TEST_ROOT));
    const record = await evaluate(await loadScenario(`scenarios/${id}.json`));
    assert.equal(record.verdict, 'passed', JSON.stringify(record));
    const added = (await readdir(process.env.ATLAS_TEST_ROOT)).filter(
      (name) => name.startsWith('run-') && !before.has(name),
    );
    assert.equal(added.length, 1);
    const receipts = JSON.parse(
      await readFile(join(process.env.ATLAS_TEST_ROOT, added[0], 'faults.json'), 'utf8'),
    );
    const matching = receipts.filter((r) => r.id === id);
    assert.ok(matching.length);
    if (id === 'reply-lost') assert.equal(matching.length, 4);
    for (const receipt of matching) {
      assert.deepEqual(verifyFault(receipt), []);
      const broken = structuredClone(receipt);
      faultControls[id](broken.observations);
      assert.notDeepEqual(verifyFault(broken), [], `Broken control must fail ${id}`);
      if (id === 'queue-changed') {
        const unrecovered = structuredClone(receipt);
        unrecovered.observations[2] = { kind: 'not_sent', code: 'not_connected' };
        assert.notDeepEqual(verifyFault(unrecovered), [], 'Fresh assigned read must recover');
      }
      if (id === 'asset-deleted') {
        for (const slot of [3, 4]) {
          const lostTask = structuredClone(receipt);
          lostTask.observations[slot].execution_state = 'pending';
          lostTask.observations[slot].execution_summary = null;
          assert.notDeepEqual(verifyFault(lostTask), [], 'Deletion must retain an active Task');
        }
        const unrelated = structuredClone(receipt);
        unrelated.observations[5].code = 'network';
        assert.notDeepEqual(
          verifyFault(unrelated),
          [],
          'Only the expected refusal can stop the Asset',
        );
      }
      t.diagnostic(`Fault control rejected ${id}`);
    }
  });
