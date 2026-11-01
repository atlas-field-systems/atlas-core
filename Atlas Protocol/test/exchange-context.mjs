import { harness } from './harness.mjs';
import * as s from './samples.mjs';

export function runExchangeContext(p) {
  const { check, assert, refuses, encode, result } = harness(p);
  const headers = (version = p.PROTOCOL_VERSION) =>
    new Headers({
      'Atlas-Dataset-ID': s.id,
      'Atlas-Protocol-Version': version,
      'Content-Type': 'application/json',
    });
  const http = (name, data, request, version, context = {}) =>
    p.readHttp(
      p.exchanges[name],
      {
        status: 200,
        headers: headers(version),
        body: encode({ dataset_id: s.id, data, commit_cursor: 'committed' }),
      },
      { request, ...context },
    );
  const observationResult = (facts) => ({
    observation: { ...s.observation, ...facts },
    track: {
      ...s.track,
      sources: [
        {
          ...s.track.sources[0],
          ...(facts.source_asset_id === undefined
            ? {}
            : { source_asset_id: facts.source_asset_id }),
        },
      ],
    },
  });
  for (const [field, supplied, different] of [
    [
      'publisher_subject',
      { id: 'subject', lifetime_id: s.requestId },
      { id: 'other', lifetime_id: s.requestId },
    ],
  ]) {
    const facts = { [field]: supplied };
    const request = { ...s.examples.CreateObservation[0], ...facts };
    check(`creation preserves omitted ${field}`, () => {
      http('CreateObservation', observationResult({}), s.examples.CreateObservation[0]);
    });
    check(`creation preserves supplied ${field}`, () => {
      http('CreateObservation', observationResult(facts), request);
    });
    check(`creation refuses invented ${field}`, () => {
      refuses(
        () => http('CreateObservation', observationResult(facts), s.examples.CreateObservation[0]),
        'invalid_http',
      );
    });
    check(`creation refuses missing ${field}`, () => {
      refuses(() => http('CreateObservation', observationResult({}), request), 'invalid_http');
    });
    check(`creation refuses changed ${field}`, () => {
      refuses(
        () => http('CreateObservation', observationResult({ [field]: different }), request),
        'invalid_http',
      );
    });
  }
  check('creation requires source Asset attribution before submission', () => {
    const { source_asset_id: _source, ...withoutSource } = s.examples.CreateObservation[0];
    assert(
      p.exchanges.CreateObservation.request.schema.safeParse(s.examples.CreateObservation[0])
        .success,
      'The independently attributed creation must remain valid',
    );
    assert(
      !p.exchanges.CreateObservation.request.schema.safeParse(withoutSource).success,
      'Missing source Asset must be refused',
    );
    assert(
      !p.exchanges.CreateObservation.request.schema.safeParse({
        ...withoutSource,
        source_asset_id: null,
      }).success,
      'Null source Asset must be refused',
    );
  });
  check('later Observation reports need not repeat creation attribution', () => {
    const [request, data] = s.examples.ReportObservation;
    http(
      'ReportObservation',
      {
        ...data,
        ...observationResult({
          source_asset_id: s.assetId,
          publisher_subject: { id: 'subject', lifetime_id: s.requestId },
        }),
      },
      request,
    );
  });
  const foreign = '999.0.0';
  const context = { protocolVersion: foreign };
  const client = {
    type: 'authenticate',
    dataset_id: s.id,
    protocol_version: foreign,
    request_id: s.requestId,
    api_key: 'A'.repeat(43),
  };
  const server = {
    type: 'progress',
    dataset_id: s.id,
    protocol_version: foreign,
    data: { subscription_id: s.requestId, previous_cursor: 'A', through_cursor: 'B' },
  };
  for (const expected of [undefined, context]) {
    const label = expected ? 'with a caller version override' : 'without a caller version override';
    check(`HTTP refuses foreign success ${label}`, () => {
      refuses(
        () => http('GetTask', s.task, { task_id: s.taskId }, foreign, expected),
        'invalid_http',
      );
    });
    for (const [name, frame, read, write] of [
      ['client', client, p.readWssClient, p.writeWssClient],
      ['server', server, p.readWssServer, p.writeWssServer],
    ]) {
      check(`WSS ${name} read refuses foreign version ${label}`, () => {
        refuses(() => read(encode(frame), expected), 'invalid_value');
      });
      check(`WSS ${name} write refuses foreign version ${label}`, () => {
        refuses(() => write(frame, expected), 'invalid_value');
      });
    }
  }
  const mismatch = (version) => ({
    code: 'protocol_mismatch',
    message: 'Protocol version differs',
    request_id: s.requestId,
    details: { protocol_version: version },
  });
  check('HTTP retains a consistent typed protocol mismatch refusal', () => {
    const response = p.readHttp(p.exchanges.GetTask, {
      status: 409,
      headers: headers(foreign),
      body: encode({ dataset_id: s.id, error: mismatch(foreign) }),
    });
    assert(response.kind === 'error', 'Mismatch refusal was lost');
  });
  const error = (version, detailsVersion) => ({
    type: 'error',
    dataset_id: s.id,
    protocol_version: version,
    error: mismatch(detailsVersion),
  });
  check('WSS server reader retains a consistent typed protocol mismatch refusal', () => {
    assert(
      p.readWssServer(encode(error(foreign, foreign))).type === 'error',
      'Mismatch refusal was lost',
    );
  });
  check('WSS refuses mismatch details that contradict the frame version', () => {
    refuses(() => p.readWssServer(encode(error(p.PROTOCOL_VERSION, foreign))), 'invalid_value');
  });
  check('WSS refuses Dataset mismatch details that contradict the frame context', () => {
    const frame = {
      type: 'error',
      dataset_id: s.id,
      protocol_version: p.PROTOCOL_VERSION,
      error: {
        code: 'dataset_mismatch',
        message: 'Dataset differs',
        request_id: s.requestId,
        details: { dataset_id: s.assetId },
      },
    };
    refuses(() => p.readWssServer(encode(frame)), 'invalid_value');
    refuses(() => p.writeWssServer(frame), 'invalid_value');
  });
  check('WSS writer cannot claim a foreign version in a mismatch refusal', () => {
    refuses(() => p.writeWssServer(error(foreign, foreign)), 'invalid_value');
  });
  check('WSS writer retains a local typed mismatch refusal', () => {
    p.writeWssServer(error(p.PROTOCOL_VERSION, p.PROTOCOL_VERSION));
  });
  return result();
}
