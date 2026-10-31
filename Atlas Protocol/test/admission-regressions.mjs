import { harness } from './harness.mjs';
import * as s from './samples.mjs';

export function runAdmissionRegressions(p) {
  const { check, assert, refuses, encode, result } = harness(p);
  check('WSS subscription controls have no HTTP operations', () => {
    assert(
      !Object.hasOwn(p.exchanges, 'SubscribeChanges') &&
        !Object.hasOwn(p.exchanges, 'UnsubscribeChanges'),
      'Connection-owned subscription exposed over HTTP',
    );
    const context = { dataset_id: s.id, protocol_version: '0.4.0', request_id: s.requestId };
    for (const [type, data] of [
      ['subscribe_changes', { subscription_id: s.requestId, from_cursor: 'cursor', ...s.limits }],
      ['unsubscribe_changes', { subscription_id: s.requestId }],
    ]) {
      const frame = { type, ...context, data };
      assert(p.readWssClient(p.writeWssClient(frame)).type === type, 'WSS control lost');
    }
  });
  for (const [key, budgetKey, maximum] of [
    ['max_message_bytes', 'maxBytes', 1024],
    ['max_json_values', 'maxValues', 100],
    ['max_changes', 'maxChanges', 1],
  ])
    check(`WSS subscription cannot raise negotiated ${key}`, () => {
      const limits = { ...s.limits, [key]: maximum };
      const frame = {
        type: 'subscribed',
        dataset_id: s.id,
        protocol_version: '0.4.0',
        request_id: s.requestId,
        data: { subscription_id: s.requestId, handoff_cursor: 'cursor', limits },
      };
      const context = { subscriptionId: s.requestId, budget: { [budgetKey]: maximum } };
      p.readWssServer(encode(frame), context);
      p.writeWssServer(frame, context);
      const raised = {
        ...frame,
        data: { ...frame.data, limits: { ...limits, [key]: maximum + 1 } },
      };
      refuses(() => p.readWssServer(encode(raised), context), 'invalid_value');
      refuses(() => p.writeWssServer(raised, context), 'invalid_value');
    });
  for (const key of ['dataset_id', 'protocol_version', 'request_id'])
    check(`WSS writer refuses ${key} accessor without calling it`, () => {
      const frame = {
        type: 'authenticate',
        dataset_id: s.id,
        protocol_version: '0.4.0',
        request_id: s.requestId,
        api_key: 'A'.repeat(43),
      };
      let reads = 0;
      Object.defineProperty(frame, key, {
        enumerable: true,
        get() {
          reads++;
          return key === 'protocol_version' ? '0.4.0' : s.id;
        },
      });
      refuses(() => p.writeWssClient(frame, { requestId: s.requestId }), 'invalid_value');
      assert(reads === 0, 'Writer invoked caller getter');
    });
  check('array length refuses work before proportional property enumeration', () => {
    const array = new Proxy(Array(4096).fill(s.taskId), {
      ownKeys() {
        throw new Error('Enumerated oversized array');
      },
    });
    refuses(
      () =>
        p.writeJson(
          p.exchanges.SetTaskOrder.request,
          { ...s.examples.SetTaskOrder[0], task_ids: array },
          { maxValues: 8 },
        ),
      'resource_limit',
    );
    refuses(
      () =>
        p.writeJson(
          p.exchanges.SetTaskOrder.request,
          { ...s.examples.SetTaskOrder[0], task_ids: array },
          { maxBytes: 256 },
        ),
      'payload_too_large',
    );
  });
  check('resource kind put is not a synchronization change', () => {
    const body = {
      dataset_id: s.id,
      data: { items: [{ kind: 'put', used: '0', capacity: '1' }], next_page_token: null },
    };
    const headers = new Headers({
      'Atlas-Dataset-ID': s.id,
      'Atlas-Protocol-Version': '0.4.0',
      'Content-Type': 'application/json',
    });
    const result = p.readHttp(
      p.exchanges.ListResources,
      { status: 200, headers, body: encode(body) },
      { budget: { maxChanges: 0, maxGeometryWork: 0 } },
    );
    assert(result.body.data.items[0].kind === 'put', 'Core-owned resource name rejected');
  });
  check('geometry allowance counts each occurrence and does not change shape validity', () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    const images = [s.id, s.requestId].map((id) => ({ ...s.geofeature, id, geometry: polygon }));
    const data = { items: images, next_page_token: null };
    const headers = new Headers({
      'Atlas-Dataset-ID': s.id,
      'Atlas-Protocol-Version': '0.4.0',
      'Content-Type': 'application/json',
    });
    const reply = { status: 200, headers, body: encode({ dataset_id: s.id, data }) };
    const read = (work) =>
      p.readHttp(p.exchanges.ListGeofeatures, reply, { budget: { maxGeometryWork: work } });
    assert(read(96).body.data.items.length === 2, 'Exact geometry allowance rejected');
    refuses(() => read(95), 'resource_limit');
    const request = { ...s.examples.CreateGeofeature[0], geometry: polygon };
    const write = (work) =>
      p.writeJson(p.exchanges.CreateGeofeature.request, request, { maxGeometryWork: work });
    write(48);
    refuses(() => write(47), 'resource_limit');
    refuses(
      () =>
        p.readJson(
          p.contract(p.Geometry),
          encode({
            ...polygon,
            coordinates: [
              [
                [0, 0],
                [1, 1],
                [2, 2],
                [0, 0],
              ],
            ],
          }),
        ),
      'invalid_geometry',
    );
  });
  return result();
}
