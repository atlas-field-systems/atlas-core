import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadScenario } from '../dist/scenario.js';
import { CheckResults } from '../dist/records.js';
test('scenario parser rejects malformed, oversized and unknown input before networking', async () => {
  const directory = await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'inputs-'));
  for (const [i, text] of [
    '{',
    ' '.repeat(1048577),
    '{"name":"x","assets":[],"subjects":[],"unknown":1}',
  ].entries()) {
    const path = join(directory, `${i}.json`);
    await writeFile(path, text);
    await assert.rejects(loadScenario(path));
  }
  const valid = JSON.parse(await readFile('scenarios/road-inspection.json', 'utf8'));
  for (const [name, mutate] of [
    ['missing', (s) => s.expect.tasks.pop()],
    ['duplicate', (s) => s.expect.tasks.push({ ...s.expect.tasks[0] })],
  ]) {
    const scenario = structuredClone(valid);
    mutate(scenario);
    const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify(scenario));
    await assert.rejects(loadScenario(path), { code: 'invalid_value' });
  }
  assert.equal(CheckResults.safeParse({}).success, false);
});
