import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { caseFold } from '../../../Atlas Protocol/node_modules/unicode-case-folding/index.js';

const directory = await mkdtemp(join(tmpdir(), 'atlas-bend2-runtime-'));
const bend =
  process.env.BEND ?? fileURLToPath(new URL('../.tools/bend-2.0.39/bin/bend', import.meta.url));
async function compile(entry, name) {
  const compiled = spawnSync(
    bend,
    [fileURLToPath(new URL(entry, import.meta.url)), '-o', join(directory, name)],
    { encoding: 'utf8', env: { ...process.env, BEND_NO_TELEMETRY: '1' } },
  );
  assert.equal(compiled.status, 0, compiled.stderr + compiled.stdout);
  return (await import(pathToFileURL(join(directory, name)))).default;
}
function list(values) {
  let result = { $: 'Nil' };
  for (let index = values.length - 1; index >= 0; index--)
    result = { $: 'Con', head: values[index], tail: result };
  return result;
}
function array(values) {
  const result = [];
  for (let item = values; item.$ === 'Con'; item = item.tail) result.push(item.head);
  return result;
}
const names = {
  OrdinaryInteger: 'Integer',
  TypedFloat: 'Float',
  Counter: 'Counter',
  NewUuid: 'NewId',
  AssetType: 'AssetType',
  Capabilities: 'Capabilities',
  AssetDescription: 'AssetDescription',
  Integer: 'Integer',
  Timestamp: 'Timestamp',
  Position: 'Position',
};
try {
  const implementation = await compile('./runtime-driver.bend', 'runtime.mjs');
  let checked = 0;
  for (const name of ['acceptance', 'independent-cases']) {
    const corpus = JSON.parse(
      await readFile(
        new URL(`../../../Atlas Protocol/test/fixtures/${name}.json`, import.meta.url),
        'utf8',
      ),
    );
    for (const fixture of corpus.cases.filter(
      (fixture) => names[fixture.schema_name] && !fixture.scope,
    )) {
      const bytes = fixture.raw_bytes ?? new TextEncoder().encode(fixture.raw_json);
      const result = implementation.read_json(names[fixture.schema_name], list(bytes));
      assert.equal(result.$, fixture.expected === 'accept' ? 'Done' : 'Fail', fixture.id);
      if (result.$ === 'Done') {
        const encoded = implementation.write_json(names[fixture.schema_name], result.value);
        assert.equal(encoded.$, 'Done', fixture.id);
        const raw = new TextDecoder().decode(Uint8Array.from(array(encoded.value)));
        if (fixture.canonical_json !== undefined)
          assert.equal(raw, fixture.canonical_json, fixture.id);
        if (fixture.retained_json !== undefined)
          assert.deepEqual(JSON.parse(raw), JSON.parse(fixture.retained_json), fixture.id);
      } else if (fixture.error_code) {
        assert.equal(implementation.failure_code(result.error), fixture.error_code, fixture.id);
      }
      checked++;
    }
  }
  const folding = await compile('../casefold.bend', 'casefold.mjs');
  for (const value of [
    'Straße',
    'İ',
    'Σςσ',
    'ＡＢＣ',
    'Ꭰꭰ',
    'ﬃ',
    '𐐀',
    'Already lowercase',
    'A\u0301',
  ])
    assert.equal(folding.fold(value), caseFold(value), value);
  console.log(
    `runtime: ${checked} independent scalar/component cases and Unicode alias folding pass`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
