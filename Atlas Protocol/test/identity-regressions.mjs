import { harness } from './harness.mjs';
import * as s from './samples.mjs';

export function runIdentityRegressions(p) {
  const { check, assert, refuses, encode, result: report } = harness(p);
  const http = (operation, data, request) =>
    p.readHttp(
      p.exchanges[operation],
      {
        status: 200,
        headers: new Headers({
          'Atlas-Dataset-ID': data.dataset_id ?? s.id,
          'Atlas-Protocol-Version': '0.5.0',
          'Content-Type': 'application/json',
        }),
        body: encode({ dataset_id: data.dataset_id ?? s.id, data, commit_cursor: 'cursor' }),
      },
      { request },
    ).body.data;
  const wss = (image) =>
    p.readWssServer(
      encode({
        type: 'change_batch',
        dataset_id: image.dataset_id,
        protocol_version: '0.5.0',
        data: {
          subscription_id: s.requestId,
          previous_cursor: 'before',
          commit_cursor: 'after',
          changes: [
            {
              kind: 'put',
              resource_kind: image.entity_type,
              resource_id: image.id,
              version: image.version,
              image,
            },
          ],
        },
      }),
      { datasetId: image.dataset_id, subscriptionId: s.requestId },
    ).data.changes[0].image;

  for (const [name, image] of [
    ['Asset', s.asset],
    ['Observation', s.observation],
    ['Track', s.track],
    ['Geofeature', s.geofeature],
  ]) {
    const lookup = (alias, resource) => http(`Get${name}ByAlias`, resource, { alias });
    for (const [label, resource] of [
      ['absent', image],
      ['unrelated', { ...image, alias: 'wrong' }],
    ])
      check(`${name} alias lookup rejects ${label} alias`, () => {
        refuses(() => lookup('wanted', resource), 'invalid_http');
      });
    for (const [requested, returned] of [
      ['Wanted', 'wAnTeD'],
      ['Straße', 'STRASSE'],
      ['ẞ', 'ss'],
      ['ΟΣ', 'ος'],
      ['οσ', 'ος'],
      ['İ', 'i\u0307'],
      ['𐐀', '𐐨'],
    ])
      check(`${name} alias lookup preserves ${requested} and ${returned}`, () => {
        const request = { alias: requested };
        const result = http(`Get${name}ByAlias`, { ...image, alias: returned }, request);
        assert(result.alias === returned && request.alias === requested, 'Alias spelling changed');
      });
    for (const [requested, returned] of [
      ['é', 'e\u0301'],
      ['I', 'ı'],
      ['İ', 'i'],
      ['A', 'А'],
    ])
      check(`${name} alias lookup keeps ${requested} distinct from ${returned}`, () => {
        refuses(() => lookup(requested, { ...image, alias: returned }), 'invalid_http');
      });
  }

  const evidence = (entity_id, origin, section, sequence = '1') => ({
    dataset_id: s.id,
    entity_id,
    origin,
    report_id: s.requestId,
    sequence,
    section,
  });
  const result = (state, evidence, value) => ({
    state,
    classification: 'state_until_changed',
    observed_at: null,
    evidence,
    time_status:
      state === 'value'
        ? Object.fromEntries(
            (evidence.section === 'geometry' ? ['geometry'] : Object.keys(value)).map((key) => [
              key,
              'unknown',
            ]),
          )
        : 'unknown',
    ...(state === 'value' ? { value } : state === 'error' ? { error: { code: 'sensor' } } : {}),
  });
  const publisher = { kind: 'publisher', publisher_id: s.processId };
  for (const state of ['value', 'error', 'withdrawn']) {
    const asset = {
      ...s.asset,
      status: result(state, evidence(s.assetId, s.origin, 'status'), { condition: 'healthy' }),
      communications: {
        ...s.asset.communications,
        capacity: result(state, evidence(s.assetId, s.origin, 'communications', '2'), {
          bandwidth_bps: null,
        }),
      },
    };
    const observation = {
      ...s.observation,
      type: result(state, evidence(s.observationId, publisher, 'type'), { kind: 'person' }),
      geometry: result(state, evidence(s.observationId, publisher, 'geometry', '2'), s.geometry),
    };
    const track = { ...s.track, type: observation.type, geometry: observation.geometry };
    check(`Asset status ${state} rejects contradictory report sequences over HTTP`, () => {
      refuses(
        () =>
          http('GetAssetStatus', {
            asset_id: asset.id,
            status: asset.status,
            communications: asset.communications,
            heartbeat: asset.heartbeat,
          }),
        'invalid_value',
      );
    });
    for (const [name, image, first, second] of [
      ['Asset', asset, asset.status.evidence, asset.communications.capacity.evidence],
      ['Observation', observation, observation.type.evidence, observation.geometry.evidence],
      ['Track', track, track.type.evidence, track.geometry.evidence],
    ]) {
      const read = (resource) => http(`Get${name}`, resource);
      check(`${name} ${state} rejects contradictory report sequences over HTTP`, () => {
        refuses(() => read(image), 'invalid_value');
      });
      if (name !== 'Observation')
        check(`${name} ${state} rejects contradictory report sequences over WSS`, () => {
          refuses(() => wss(image), 'invalid_value');
        });
      check(`${name} ${state} permits a different report and equal sequences`, () => {
        second.report_id = s.taskId;
        read(image);
        if (name !== 'Observation') wss(image);
        second.report_id = first.report_id;
        second.sequence = first.sequence;
        read(image);
        if (name !== 'Observation') wss(image);
        second.sequence = '2';
      });
    }
    check(`Asset ${state} permits report ID reuse across process generations`, () => {
      asset.communications.capacity.evidence.origin = {
        kind: 'asset_process',
        process_generation: s.requestId,
      };
      asset.communications.capacity.evidence.sequence = '2';
      http('GetAsset', asset);
      wss(asset);
    });
  }

  for (const [label, changes] of [
    ['Dataset', { dataset_id: s.requestId }],
    ['Entity', { id: s.taskId }],
    ['publisher', { publisher_id: s.assetId }],
  ])
    check(`different ${label} scopes may reuse a report ID`, () => {
      for (const [sequence, fields] of [
        ['1', {}],
        ['2', changes],
      ]) {
        const image = { ...s.observation, ...fields };
        image.type = result(
          'value',
          {
            ...evidence(
              image.id,
              { kind: 'publisher', publisher_id: image.publisher_id },
              'type',
              sequence,
            ),
            dataset_id: image.dataset_id,
          },
          { kind: 'person' },
        );
        http('GetObservation', image);
      }
    });

  for (const [label, image] of [
    ['Observation equals Track', { ...s.observation, track_id: s.observationId }],
    ['Observation equals source Asset', { ...s.observation, source_asset_id: s.observationId }],
    ['Track equals source Asset', { ...s.observation, source_asset_id: s.trackId }],
  ]) {
    check(`${label} is refused by direct Observation HTTP reads`, () => {
      refuses(() => http('GetObservation', image), 'invalid_value');
    });
    check(`${label} is refused by CreateObservation HTTP replies`, () => {
      const track = {
        ...s.track,
        id: image.track_id,
        sources: [
          {
            observation_id: image.id,
            publisher_id: image.publisher_id,
            ...(image.source_asset_id ? { source_asset_id: image.source_asset_id } : {}),
          },
        ],
      };
      refuses(
        () =>
          http('CreateObservation', { observation: image, track }, s.examples.CreateObservation[0]),
        'invalid_value',
      );
    });
  }
  for (const [label, image] of [
    ['Track equals Observation', { ...s.track, id: s.observationId }],
    [
      'Track equals source Asset',
      { ...s.track, sources: [{ ...s.track.sources[0], source_asset_id: s.trackId }] },
    ],
    [
      'Observation equals source Asset',
      { ...s.track, sources: [{ ...s.track.sources[0], source_asset_id: s.observationId }] },
    ],
  ]) {
    check(`${label} is refused by direct Track HTTP reads`, () => {
      refuses(() => http('GetTrack', image), 'invalid_value');
    });
    check(`${label} is refused by Track WSS images`, () => {
      refuses(() => wss(image), 'invalid_value');
    });
  }
  for (const publisher_id of [s.observationId, s.trackId, s.assetId])
    check(`publisher scope may coincide with Entity ${publisher_id}`, () => {
      const observation = { ...s.observation, source_asset_id: s.assetId, publisher_id };
      const track = {
        ...s.track,
        sources: [{ observation_id: s.observationId, source_asset_id: s.assetId, publisher_id }],
      };
      http('GetObservation', observation);
      http('GetTrack', track);
      http(
        'CreateObservation',
        { observation, track },
        {
          ...s.examples.CreateObservation[0],
          source_asset_id: s.assetId,
          publisher_id,
        },
      );
      wss(track);
    });
  for (const [name, schema, value, undefinedValue, absent] of [
    ['Asset alias', p.Asset, s.asset, { ...s.asset, alias: undefined }, 'alias'],
    [
      'Command altitude',
      p.CreateTask,
      s.createTask,
      { ...s.createTask, inputs: { ...s.createTask.inputs, altitude: undefined } },
      'altitude',
    ],
  ]) {
    check(`${name} schema rejects explicit undefined`, () => {
      assert(!schema.safeParse(undefinedValue).success, 'Schema accepted explicit undefined');
    });
    check(`${name} writers reject explicit undefined and preserve omission`, () => {
      const definition = p.contract(schema);
      refuses(() => p.writeJson(definition, undefinedValue), 'invalid_value');
      const parsed = p.readJson(definition, p.writeJson(definition, value));
      assert(
        !Object.hasOwn(name === 'Asset alias' ? parsed : parsed.inputs, absent),
        'Absence lost',
      );
    });
  }
  for (const [operation, request, data, report] of [
    [
      'CreateObservation',
      s.examples.CreateObservation[0],
      { observation: s.observation, track: s.track },
      s.observationReport,
    ],
    [
      'UpdateAsset',
      { request_id: s.requestId, asset_id: s.assetId, expected_edit_revision: '0', alias: 'A' },
      { asset: s.asset },
      s.report,
    ],
  ]) {
    for (const disposition of ['accepted', 'duplicate']) {
      const response = { ...data, evidence_disposition: disposition };
      check(`${operation} rejects ${disposition} disposition without a submitted report`, () => {
        refuses(() => http(operation, response, request), 'invalid_http');
      });
      check(`${operation} permits ${disposition} disposition with a report or no context`, () => {
        http(operation, response, { ...request, report });
        http(operation, response);
      });
    }
    check(`${operation} requires disposition exactly when the request has a report`, () => {
      http(operation, data, request);
      http(operation, data);
      refuses(() => http(operation, data, { ...request, report }), 'invalid_http');
    });
  }
  return report();
}
