import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { createSchema, createDocument } from 'zod-openapi';
import * as p from '../dist/index.js';
import { text, timestampNanoseconds } from '../dist/scalars.js';

const bytes = (value) => new TextEncoder().encode(value);
const read = (schema, raw, budget) => p.readJson(p.contract(schema), bytes(raw), budget);
const refuses = (fn, code) =>
  assert.throws(fn, (error) => error instanceof p.ProtocolError && (!code || error.code === code));

test('package entry keeps implementation builders private', () => {
  for (const name of [
    'binary64',
    'decimalCounter',
    'numeric',
    'uniqueArray',
    'page',
    'listQuery',
    'associatedQuery',
    'executionEvidence',
    'errorEnvelope',
    'text',
    'ordered',
    'unique',
  ])
    assert.equal(Object.hasOwn(p, name), false, name);
});

test('stock output tooling preserves the supported structural vocabulary', () => {
  const Sample = z
    .strictObject({ count: p.Integer, label: text(3), times: p.PowerTimes, when: p.Time })
    .meta({ id: 'Qualification' });
  const result = createSchema(Sample, { io: 'output', openapiVersion: '3.1.0' });
  const root = result.components.Qualification;
  assert.equal(root.additionalProperties, false);
  assert.equal(root.properties.label.maxLength, 3);
  assert.equal(root.properties.count.$ref, '#/components/schemas/Integer');
  assert.equal(result.components.Integer.type, 'integer');
  assert.equal(result.components.Integer.maximum, 2147483647);
  const map = result.components.PowerTimes.properties.reserves;
  assert.equal(map.maxProperties, 16);
  assert.equal(map.additionalProperties.additionalProperties, false);
  assert.ok(map.propertyNames);
  const doc = createDocument({
    openapi: '3.1.0',
    info: { title: 'Qualification', version: '0.5.0' },
    paths: {
      '/qualification': {
        post: {
          operationId: 'Qualification',
          responses: {
            200: {
              description: 'Result',
              content: { 'application/json': { schema: result.schema } },
            },
          },
        },
      },
    },
    components: { schemas: result.components },
  });
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(JSON.stringify(doc).includes('nullable'), false);
  assert.equal(JSON.stringify(doc).includes('allOf'), false);
});

test('exact number tokens precede conversion and integer checks', () => {
  for (const raw of ['100', '100.0', '1e2']) assert.equal(read(p.Integer, raw), 100);
  for (const raw of [
    '100.0000000000000000001',
    '2147483647.000000001',
    '1e-10000',
    '1e10001',
    '"100"',
    'NaN',
  ])
    refuses(() => read(p.Integer, raw));
  assert.equal(read(p.Longitude, '180'), 180);
  refuses(() => read(p.Longitude, '180.00000000000000000001'));
  refuses(() => read(p.Latitude, '-90.00000000000000000001'));
  assert.equal(read(p.Float, '5e-324'), Number.MIN_VALUE);
  refuses(() => read(p.Float, '1e-324'));
  assert.equal(read(p.Float, '1.7976931348623157e308'), Number.MAX_VALUE);
  refuses(() => read(p.Float, '1.7976931348623158e308'));
  const exactMax = ((1n << 1024n) - (1n << 971n)).toString();
  const max128 = `${exactMax.slice(0, 120)}e189`;
  assert.equal(read(p.Float, max128), Number.MAX_VALUE);
  refuses(() => read(p.Float, `${BigInt(exactMax.slice(0, 120)) + 1n}e189`));
  refuses(() => read(p.Float, '1'.repeat(129)));
  refuses(() => read(p.Float, '{"isLosslessNumber":true,"value":"1"}'));
});

test('UTF-8, one document, decoded duplicate names and malformed scalars', () => {
  const schema = z.strictObject({ a: p.Integer });
  for (const raw of [
    '{"a":1,"\\u0061":2}',
    '{"a":1} {}',
    '{"a":1,}',
    '/*x*/{"a":1}',
    '\ufeff{"a":1}',
  ])
    refuses(() => read(schema, raw), 'invalid_json');
  refuses(() => read(text(20), '"\\ud800"'), 'invalid_json');
  refuses(() => read(z.strictObject({}), '{"\\udfff":0}'), 'invalid_json');
  refuses(() => p.readJson(p.contract(schema), new Uint8Array([0xc0, 0xaf])), 'invalid_utf8');
  assert.equal(read(text(3), '"😀😀😀"'), '😀😀😀');
  refuses(() => read(text(3), '"😀😀😀😀"'));
  refuses(() => read(text(3, true), '"\u2003\u2003"'));
});

test('whole-envelope independent bytes, values, depth and construction budgets', () => {
  const schema = z.strictObject({ a: z.array(p.Integer) });
  assert.deepEqual(read(schema, '{"a":[0,1]}', { maxValues: 4, maxDepth: 3 }), { a: [0, 1] });
  refuses(() => read(schema, '{"a":[0,1]}', { maxValues: 3 }), 'resource_limit');
  refuses(() => read(schema, '{"a":[0,1]}', { maxDepth: 2 }), 'resource_limit');
  refuses(() => read(schema, '{"a":[0,1]}', { maxBytes: 10 }), 'payload_too_large');
  refuses(() => read(schema, '{"a":[]}', { maxDepth: -1 }), 'invalid_budget');
  const optional = p.contract(z.strictObject({ a: p.Integer.optional(), b: p.Integer.nullable() }));
  assert.equal(new TextDecoder().decode(p.writeJson(optional, { b: null })), '{"b":null}');
  assert.equal(new TextDecoder().decode(p.writeJson(optional, { a: 0, b: 0 })), '{"a":0,"b":0}');
  refuses(() => p.writeJson(optional, { a: undefined, b: null }));
  refuses(() => p.writeJson(optional, { b: 0, extra: true }));
  refuses(() => p.writeJson(optional, { b: NaN }));
  refuses(() => p.writeJson(optional, { b: 0 }, { maxValues: 1 }), 'resource_limit');
  const spoof = { value: '0', [Symbol.for('lossless-json.LosslessNumber')]: true };
  refuses(() => p.writeJson(p.contract(p.Float), spoof));
});

test('Gregorian spelling, exact nanoseconds, counters and keys', () => {
  for (const raw of [
    '0001-01-01T00:00:00Z',
    '2000-02-29T23:59:59.000000001Z',
    '9999-12-31T23:59:59.999999999Z',
  ])
    assert.equal(p.Timestamp.parse(raw), raw);
  for (const raw of [
    '0000-01-01T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00.1234567890Z',
  ])
    assert.equal(p.Timestamp.safeParse(raw).success, false);
  assert.equal(
    timestampNanoseconds('2026-01-01T00:00:00.1Z'),
    timestampNanoseconds('2026-01-01T00:00:00.100Z'),
  );
  assert.equal(
    timestampNanoseconds('2026-01-01T00:00:00.000000002Z') -
      timestampNanoseconds('2026-01-01T00:00:00.000000001Z'),
    1n,
  );
  for (const raw of ['0', '18446744073709551615']) assert.equal(p.Counter.parse(raw), raw);
  for (const raw of ['00', '+1', '-0', '1.0', '18446744073709551616'])
    assert.equal(p.Counter.safeParse(raw).success, false);
  assert.equal(p.Secret.safeParse('A'.repeat(43)).success, true);
  assert.equal(p.Secret.safeParse('A'.repeat(42) + 'B').success, false);
  for (const [schema, input] of [
    [p.Uuid, '11111111-1111-4111-8111-111111111111'],
    [p.NewId, '11111111-1111-4111-8111-111111111111'],
    [p.Counter, '1'],
    [p.Sequence, '1'],
    [p.ObjectLength, '1'],
    [p.Timestamp, '2026-10-23T00:00:00Z'],
    [p.Secret, 'A'.repeat(43)],
    [p.Sha256, '0'.repeat(64)],
    [p.ContentType, 'application/json'],
  ]) {
    assert.equal(schema.safeParse(input).success, true);
    for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029'])
      assert.equal(schema.safeParse(input + suffix).success, false, input);
  }
});

test('robust planar topology, winding, poles and exact subnormal area', () => {
  const polygon = (coordinates) => ({ type: 'Polygon', coordinates: [coordinates] });
  const valid = [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
    [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
    [
      [0, 89],
      [1, 89],
      [0, 90],
      [0, 89],
    ],
    [
      [0, 0],
      [5e-324, 0],
      [0, 5e-324],
      [0, 0],
    ],
    [
      [0, 0],
      [1, 1],
      [2, 2.0000000000000004],
      [0, 0],
    ],
  ];
  for (const shape of valid)
    assert.deepEqual(read(p.Geometry, JSON.stringify(polygon(shape))), polygon(shape));
  for (const shape of [
    [
      [0, 0],
      [1, 1],
      [2, 2],
      [0, 0],
    ],
    [
      [0, 0],
      [2, 2],
      [0, 2],
      [2, 0],
      [0, 0],
    ],
    [
      [0, 0],
      [2, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
    [
      [0, 0],
      [2, 0],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ])
    refuses(() => read(p.Geometry, JSON.stringify(polygon(shape))), 'invalid_geometry');
  for (const shape of [
    {
      type: 'LineString',
      coordinates: [
        [170, 0],
        [-170, 0],
      ],
    },
    {
      type: 'LineString',
      coordinates: [
        [-180, 0],
        [0, 0],
        [180, 0],
      ],
    },
    polygon([
      [0, 90],
      [1, 90],
      [1, 89],
      [0, 90],
    ]),
  ])
    refuses(() => read(p.Geometry, JSON.stringify(shape)), 'unsupported_geometry');
  assert.deepEqual(
    read(p.Geometry, '{"type":"LineString","coordinates":[[0,0],[180,0]]}').coordinates,
    [
      [0, 0],
      [180, 0],
    ],
  );
  assert.deepEqual(
    read(p.Geometry, '{"type":"Point","coordinates":[180,90]}').coordinates,
    [180, 90],
  );
  refuses(() => read(p.Geometry, '{"type":"Point","coordinates":[0]}'), 'invalid_geometry');
  refuses(
    () => read(p.Geometry, '{"type":"GeometryCollection","geometries":[]}'),
    'unsupported_geometry',
  );
});

test('maximum geometry and aggregate work are bounded before topology allocation', () => {
  const points = Array.from({ length: 1023 }, (_, index) => {
    const angle = (index * Math.PI * 2) / 1023;
    return [Math.cos(angle), Math.sin(angle)];
  });
  points.push(points[0]);
  const shape = { type: 'Polygon', coordinates: [points] };
  assert.deepEqual(read(p.Geometry, JSON.stringify(shape)), shape);
  const many = z.array(p.Geometry);
  refuses(() => read(many, JSON.stringify([shape, shape, shape, shape])), 'resource_limit');
  refuses(
    () => read(p.Geometry, JSON.stringify(shape), { maxGeometryWork: 100 }),
    'resource_limit',
  );
  const collinear = Array.from({ length: 1023 }, (_, i) => [i / 10, 0]);
  collinear.push(collinear[0]);
  refuses(
    () => read(p.Geometry, JSON.stringify({ type: 'Polygon', coordinates: [collinear] })),
    'invalid_geometry',
  );
});
