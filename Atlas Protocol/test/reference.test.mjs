import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import * as protocol from '../dist/index.js';
import { referenceDocument } from '../dist/reference.js';
import { examples, wssExamples, id, requestId } from './samples.mjs';

test('all 66 routes match the independent inventory and stock exported schemas', async () => {
  const routes = JSON.parse(await readFile(new URL('./routes.json', import.meta.url), 'utf8'));
  assert.equal(routes.length, 66);
  const document = referenceDocument();
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document.paths['/messages/subscribe_changes'], undefined);
  assert.equal(document.paths['/messages/unsubscribe_changes'], undefined);
  assert.equal(document.info.version, '0.6.0');
  assert.equal(Object.keys(document.paths).length, 66);
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });
  addFormats(ajv);
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  ajv.addSchema(document, 'atlas');
  for (const route of routes) {
    const [name, method, path] = route.split(' ');
    const binding = protocol.exchanges[name];
    assert.deepEqual([binding.operationId, binding.method, binding.path], [name, method, path]);
    assert.equal(document.paths[path][method.toLowerCase()].operationId, name);
    const request = ajv.compile({ $ref: `atlas#/components/schemas/${name}Request` });
    assert.equal(request(examples[name][0]), true, `${name}: ${ajv.errorsText(request.errors)}`);
    assert.equal(
      request({ ...examples[name][0], unknown: true }),
      false,
      `${name} request closure`,
    );
    if (binding.transport === 'content' || binding.transport === 'reference') continue;
    const response = ajv.compile({ $ref: `atlas#/components/schemas/${name}Response` });
    assert.equal(
      response({ dataset_id: id, data: examples[name][1], commit_cursor: 'cursor' }),
      true,
      `${name}: ${ajv.errorsText(response.errors)}`,
    );
    assert.equal(
      response({ dataset_id: id, data: examples[name][1], unexpected: true }),
      false,
      `${name} envelope closure`,
    );
  }
  const clientFrame = ajv.compile({ $ref: 'atlas#/components/schemas/ClientFrame' });
  const serverFrame = ajv.compile({ $ref: 'atlas#/components/schemas/ServerFrame' });
  const deletion = ajv.compile({ $ref: 'atlas#/components/schemas/Delete' });
  const replay = ajv.compile({ $ref: 'atlas#/components/schemas/ReadChangesResponse' });
  for (const [kind, permitted] of [
    ['asset', true],
    ['geofeature', true],
    ['object', true],
    ['task', false],
    ['track', false],
  ]) {
    const change = { kind: 'delete', resource_kind: kind, resource_id: requestId, version: '1' };
    const batch = {
      type: 'change_batch',
      data: { previous_cursor: 'start', commit_cursor: 'end', changes: [change] },
    };
    assert.equal(deletion(change), permitted, `Delete ${kind}`);
    assert.equal(
      replay({
        dataset_id: id,
        data: {
          replay_boundary: 'end',
          messages: [batch],
          through_cursor: 'end',
          next_page_token: null,
        },
      }),
      permitted,
      `Replay delete ${kind}`,
    );
    assert.equal(
      serverFrame({
        ...batch,
        dataset_id: id,
        protocol_version: protocol.PROTOCOL_VERSION,
        data: { ...batch.data, subscription_id: requestId },
      }),
      permitted,
      `WSS delete ${kind}`,
    );
  }
  for (const [name, type, replyType] of [
    ['SubscribeChanges', 'subscribe_changes', 'subscribed'],
    ['UnsubscribeChanges', 'unsubscribe_changes', 'unsubscribed'],
  ]) {
    const context = { dataset_id: id, protocol_version: '0.6.0', request_id: requestId };
    const request = { type, ...context, data: wssExamples[name][0] };
    const response = { type: replyType, ...context, data: wssExamples[name][1] };
    assert.equal(clientFrame(request), true, ajv.errorsText(clientFrame.errors));
    assert.equal(serverFrame(response), true, ajv.errorsText(serverFrame.errors));
    assert.equal(clientFrame({ ...request, extra: true }), false);
    assert.equal(serverFrame({ ...response, extra: true }), false);
    const { request_id: removedRequestId, ...withoutRequest } = request;
    const { request_id: removedReplyId, ...withoutReply } = response;
    void removedRequestId;
    void removedReplyId;
    assert.equal(clientFrame(withoutRequest), false);
    assert.equal(serverFrame(withoutReply), false);
  }
  const integer = ajv.compile({ $ref: 'atlas#/components/schemas/Integer' });
  assert.equal(integer(2147483647), true);
  assert.equal(integer(2147483648), false);
  assert.equal(integer(1.5), false);
  const counter = ajv.compile({ $ref: 'atlas#/components/schemas/Counter' });
  assert.equal(counter('18446744073709551615'), true);
  assert.equal(counter('18446744073709551616'), false);
  assert.equal(counter('00'), false);
  assert.equal(counter('1\n'), false);
  const bearingInput = ajv.compile({ $ref: 'atlas#/components/schemas/BearingMeasurementInput' });
  const bearingRead = ajv.compile({ $ref: 'atlas#/components/schemas/BearingMeasurementRead' });
  const sighting = {
    state: 'value',
    classification: 'dated_measurement',
    observed_at: null,
    value: {
      sensor_origin: { position: null, altitude: null },
      bearing: 0,
      elevation: null,
      bearing_interval: { start: 350, end: 10 },
    },
  };
  const withValue = (changes) => ({ ...sighting, value: { ...sighting.value, ...changes } });
  const { bearing: _omittedBearing, ...withoutBearing } = sighting.value;
  assert.equal(bearingInput(sighting), true, ajv.errorsText(bearingInput.errors));
  for (const [name, invalid] of Object.entries({
    'empty source_times': { ...sighting, source_times: {} },
    'state until changed': { ...sighting, classification: 'state_until_changed' },
    'omitted angle': { ...sighting, value: withoutBearing },
    'null interval': withValue({ bearing_interval: null }),
    'bearing 360': withValue({ bearing: 360 }),
    'confidence field': withValue({ confidence: 0.9 }),
    'null origin': withValue({ sensor_origin: null }),
    'open origin': withValue({ sensor_origin: { position: null, altitude: null, range: 1 } }),
  }))
    assert.equal(bearingInput(invalid), false, name);
  const bearingEvidence = {
    dataset_id: id,
    entity_id: requestId,
    origin: { kind: 'publisher', publisher_id: id },
    report_id: requestId,
    sequence: '1',
    section: 'bearing_measurement',
  };
  const sourced = { ...sighting, evidence: bearingEvidence, time_status: 'unknown' };
  assert.equal(bearingRead(sourced), true, ajv.errorsText(bearingRead.errors));
  assert.equal(bearingRead({ ...sourced, time_status: { bearing: 'unknown' } }), false);
  assert.equal(bearingRead({ ...sourced, evidence: null }), false);
  assert.equal(
    bearingRead({ ...sourced, evidence: { ...bearingEvidence, section: 'gimbal' } }),
    false,
  );
  const schemas = document.components.schemas;
  assert.ok(schemas.Observation.properties.bearing_measurement);
  assert.equal(schemas.Asset.properties.bearing_measurement, undefined);
  assert.equal(schemas.Track.properties.bearing_measurement, undefined);
  const times = ajv.compile({ $ref: 'atlas#/components/schemas/PowerTimes' });
  assert.equal(times({ reserves: { [id]: { remaining_percent: null } } }), true);
  assert.equal(times({ reserves: { bad: { remaining_percent: null } } }), false);
  assert.equal(times({ reserves: { [id]: { extra: null } } }), false);
  const error = ajv.compile({ $ref: 'atlas#/components/schemas/ErrorObject' });
  assert.equal(
    error({
      code: 'unauthorized',
      message: '',
      request_id: requestId,
      details: { stack: 'internal' },
    }),
    false,
  );
  for (const schema of Object.values(document.components.schemas))
    assert.equal(ajv.validateSchema(schema), true, ajv.errorsText());
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    assert.equal('nullable' in value, false);
    assert.equal('allOf' in value, false);
    if ('$ref' in value) assert.ok(value.$ref.startsWith('#/'));
    if (value.type === 'object' && !value.oneOf && !value.anyOf)
      assert.ok(
        value.additionalProperties === false ||
          (typeof value.additionalProperties === 'object' &&
            value.propertyNames &&
            value.maxProperties === 16),
      );
    Object.values(value).forEach(walk);
  };
  walk(document);
});

test('Protocol calls leave host validator policies unchanged under concurrent consumers', async () => {
  const before = { ...z.config() };
  const host = new Ajv2020({ coerceTypes: false, removeAdditional: false, useDefaults: false });
  host.addFormat('host-only', () => false);
  const validate = host.compile({ type: 'string', format: 'host-only' });
  const unique = host.compile({ type: 'array', items: { type: 'integer' }, uniqueItems: true });
  const policy = { ...host.opts };
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      assert.equal(validate(id), false);
      assert.equal(unique([1, 1]), false);
      assert.equal(protocol.Uuid.safeParse(id).success, true);
      assert.equal(
        protocol.readJson(protocol.contract(protocol.Integer), new TextEncoder().encode('1e2')),
        100,
      );
    }),
  );
  assert.deepEqual(z.config(), before);
  assert.deepEqual(host.opts, policy);
  assert.equal(validate(id), false);
  assert.equal(unique([1, 1]), false);
});

test('stock exported uniqueness matches public scalar-list boundaries', () => {
  const document = referenceDocument();
  const ajv = new Ajv2020({
    strict: false,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });
  addFormats(ajv);
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  ajv.addSchema(document, 'atlas');
  const cases = [
    ['ListAssets', (values) => ({ filters: { ids: values } }), [id, requestId]],
    ['ListAssets', (values) => ({ filters: { kinds: values } }), [null, 'drone']],
    ['ListTasks', (values) => ({ filters: { commands: values } }), ['pause', 'resume']],
    ['ListOperators', (values) => ({ filters: { ids: values } }), [id, requestId]],
    [
      'GetTrackObservations',
      (values) => ({ ...examples.GetTrackObservations[0], publisher_ids: values }),
      [id, requestId],
    ],
    [
      'GetAssetMovementHistory',
      (values) => ({ ...examples.GetAssetMovementHistory[0], time_groups: values }),
      ['known', 'unknown'],
    ],
    [
      'SetTaskOrder',
      (values) => ({ ...examples.SetTaskOrder[0], task_ids: values }),
      [id, requestId],
    ],
  ];
  for (const [name, input, distinct] of cases) {
    const exported = ajv.compile({ $ref: `atlas#/components/schemas/${name}Request` });
    const read = (value) =>
      protocol.readJson(
        protocol.exchanges[name].request,
        new TextEncoder().encode(JSON.stringify(value)),
      );
    for (const values of [[], distinct]) {
      assert.equal(exported(input(values)), true, `${name}: ${ajv.errorsText(exported.errors)}`);
      assert.deepEqual(read(input(values)), input(values));
    }
    const duplicate = input([distinct[0], distinct[0]]);
    assert.equal(exported(duplicate), false, `${name} exported duplicate refusal`);
    assert.ok(exported.errors.some((error) => error.keyword === 'uniqueItems'));
    assert.throws(
      () => read(duplicate),
      (error) => error instanceof protocol.ProtocolError && error.code === 'invalid_value',
    );
  }
});

test('stock nonblank patterns agree with Unicode White_Space at public boundaries', () => {
  const document = referenceDocument();
  const ajv = new Ajv2020({
    strict: false,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });
  addFormats(ajv);
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  ajv.addSchema(document, 'atlas');
  const whitespace =
    '\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
  for (const [name, input] of [
    ['CreateOperator', (name) => ({ ...examples.CreateOperator[0], name })],
    ['GetAssetByAlias', (alias) => ({ alias })],
  ]) {
    const exported = ajv.compile({ $ref: `atlas#/components/schemas/${name}Request` });
    for (const value of [
      '',
      ...whitespace,
      whitespace,
      '地上局',
      '😀',
      '\ufeff',
      '\u200b',
      `${whitespace}名${whitespace}`,
    ]) {
      const expected =
        value.length > 0 &&
        (!whitespace.includes(value) || value === '\ufeff' || value === '\u200b');
      assert.equal(exported(input(value)), expected, `${name} stock ${JSON.stringify(value)}`);
      if (expected)
        assert.deepEqual(
          protocol.readJson(
            protocol.exchanges[name].request,
            new TextEncoder().encode(JSON.stringify(input(value))),
          ),
          input(value),
        );
      else
        assert.throws(
          () =>
            protocol.readJson(
              protocol.exchanges[name].request,
              new TextEncoder().encode(JSON.stringify(input(value))),
            ),
          (error) => error instanceof protocol.ProtocolError && error.code === 'invalid_value',
        );
    }
  }
});
