import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'atlas-bend2-schema-'));
const bend =
  process.env.BEND ?? fileURLToPath(new URL('../.tools/bend-2.0.39/bin/bend', import.meta.url));
const compiled = spawnSync(
  bend,
  [
    fileURLToPath(new URL('./schema-core-driver.bend', import.meta.url)),
    '-o',
    join(directory, 'schema.mjs'),
  ],
  { encoding: 'utf8', env: { ...process.env, BEND_NO_TELEMETRY: '1' } },
);
assert.equal(compiled.status, 0, compiled.stderr + compiled.stdout);

function list(values) {
  return values.reduceRight((tail, head) => ({ $: 'Con', head, tail }), { $: 'Nil' });
}
function json(value) {
  if (value === null) return { $: 'JNull' };
  if (typeof value === 'string') return { $: 'JStr', value };
  if (typeof value === 'number') return { $: 'JNum', raw: String(value) };
  if (typeof value === 'boolean') return { $: 'JBool', value };
  if (Array.isArray(value)) return { $: 'JArr', items: list(value.map(json)) };
  return {
    $: 'JObj',
    members: list(
      Object.entries(value).map(([key, item]) => ({ $: 'Member', key, value: json(item) })),
    ),
  };
}

try {
  const { default: implementation } = await import(pathToFileURL(join(directory, 'schema.mjs')));
  const validate = (schema, value) => implementation.validate(json(schema), json(value));
  const object = {
    type: 'object',
    required: ['name', 'state'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 4 },
      state: { anyOf: [{ const: 'ready' }, { type: 'null' }] },
      note: { type: 'string' },
    },
    additionalProperties: false,
  };
  assert.equal(validate(object, { state: null, name: 'a' }).$, 'Done');
  for (const value of [
    { name: 'a' },
    { state: 'ready' },
    { state: null, name: '' },
    { state: null, name: '12345' },
    { state: 'other', name: 'a' },
    { state: null, name: 'a', extra: true },
  ])
    assert.equal(validate(object, value).$, 'Fail', JSON.stringify(value));
  const reordered = validate(object, { state: null, name: 'a' }).value.members;
  assert.equal(reordered.head.key, 'name');
  assert.equal(reordered.tail.head.key, 'state');
  assert.equal(reordered.tail.tail.$, 'Nil');
  const items = {
    type: 'array',
    minItems: 1,
    maxItems: 2,
    items: { type: 'string' },
    uniqueItems: true,
  };
  assert.equal(validate(items, ['a', 'b']).$, 'Done');
  for (const input of [[], ['a', 'a'], ['a', 'b', 'c'], [null]])
    assert.equal(validate(items, input).$, 'Fail');
  const dictionary = {
    type: 'object',
    propertyNames: { type: 'string', minLength: 2 },
    additionalProperties: { type: 'boolean' },
    maxProperties: 2,
  };
  assert.equal(validate(dictionary, { aa: true, bb: false }).$, 'Done');
  assert.equal(validate(dictionary, { a: true }).$, 'Fail');
  assert.equal(validate(dictionary, { aa: null }).$, 'Fail');
  assert.equal(
    validate(
      { anyOf: [{ type: 'string', title: 'AlwaysReject' }, { const: 'accepted' }] },
      'accepted',
    ).$,
    'Done',
  );
  const scoped = {
    ...object,
    properties: { ...object.properties, name: { type: 'string', title: 'GeometryFixture' } },
  };
  assert.equal(validate(scoped, { name: 'a', state: 'invalid' }).error.code.$, 'InvalidValue');
  assert.equal(validate(scoped, { name: null, state: 'ready' }).error.code.$, 'InvalidGeometry');
  console.log(
    'schema-core: closed objects, omission, null, ordering, arrays, dictionaries, alternatives and error scopes pass',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
