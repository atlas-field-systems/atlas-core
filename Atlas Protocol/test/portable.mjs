import * as s from './samples.mjs';
import { runAdmissionRegressions } from './admission-regressions.mjs';
import { runResponseRegressions } from './response-regressions.mjs';
import { runReviewFixes } from './review-fixes.mjs';
import { runIdentityRegressions } from './identity-regressions.mjs';

export function runPortable(p) {
  let checks = 0;
  const failures = [];
  const check = (name, fn) => {
    checks++;
    try {
      fn();
    } catch (error) {
      failures.push({ name, code: error.code ?? error.message });
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  const same = (a, b) => {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) || Array.isArray(b))
      return (
        Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((value, index) => same(value, b[index]))
      );
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
    );
  };
  for (const [name, [input, data]] of Object.entries(s.examples))
    check(name, () => {
      const binding = p.exchanges[name];
      const requestHeaders = new Headers({
        Authorization: `Bearer ${'A'.repeat(43)}`,
        'Atlas-Dataset-ID': s.id,
        'Atlas-Protocol-Version': '0.1.0',
        'Content-Type': 'application/json',
      });
      const request = { method: binding.method, path: binding.path, headers: requestHeaders };
      if (binding.transport === 'reference') requestHeaders.set('Accept', 'text/html');
      if (binding.transport === 'upload') {
        requestHeaders.set('Content-Type', 'multipart/form-data; boundary=atlas');
        request.uploadDescriptor = encode(input);
      } else if (binding.method === 'POST') request.body = encode(input);
      if (binding.transport === 'content')
        request.path = `/objects/${s.requestId}/content?disposition=inline`;
      const parsed = p.readHttpRequest(binding, request);
      assert(
        JSON.stringify(parsed) === JSON.stringify(p.readJson(binding.request, encode(input))),
        'Request facts differ',
      );
      const headers = new Headers({
        'Atlas-Dataset-ID': s.id,
        'Atlas-Protocol-Version': '0.1.0',
        'Atlas-Request-ID': s.requestId,
        'Content-Type': 'application/json',
      });
      const received = { status: 200, headers };
      if (binding.transport === 'content') {
        headers.set('Content-Type', s.storage.content_type);
        headers.set('Content-Length', '0');
        headers.set('Atlas-Content-SHA256', s.storage.sha256);
        headers.set('Content-Disposition', 'inline');
      } else if (binding.transport === 'reference') {
        headers.set('Content-Type', 'text/html');
        received.body = new TextEncoder().encode('<!doctype html><title>Atlas</title>');
      } else received.body = encode({ dataset_id: s.id, data, commit_cursor: 'cursor' });
      const response = p.readHttp(binding, received, { datasetId: s.id, request: parsed });
      assert(response.kind !== 'error', 'Success was lost');
    });
  check('maximum collinear, thin and subnormal polygons in one complete frame', () => {
    const ring = [
      ...Array.from({ length: 256 }, (_, i) => [i / 256, 0]),
      ...Array.from({ length: 256 }, (_, i) => [1, i / 256]),
      ...Array.from({ length: 256 }, (_, i) => [1 - i / 256, 1]),
      ...Array.from({ length: 255 }, (_, i) => [0, 1 - i / 255]),
      [0, 0],
    ];
    assert(ring.length === 1024, 'Wrong adversarial pair count');
    const changes = [1, 1e-100, 1e-320].map((height, index) => {
      const resourceId = `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`;
      const image = {
        ...s.geofeature,
        id: resourceId,
        geometry: {
          type: 'Polygon',
          coordinates: [ring.map(([x, y]) => [height === 1e-320 ? x * height : x, y * height])],
        },
      };
      return {
        kind: 'put',
        resource_kind: 'geofeature',
        resource_id: resourceId,
        version: '0',
        image,
      };
    });
    const frame = {
      type: 'change_batch',
      dataset_id: s.id,
      protocol_version: '0.1.0',
      data: {
        subscription_id: s.requestId,
        previous_cursor: 'before',
        commit_cursor: 'after',
        changes,
      },
    };
    const raw = encode(frame);
    const decoded = p.readWssServer(raw, { datasetId: s.id, subscriptionId: s.requestId });
    assert(decoded.data.changes.length === 3, 'Whole frame was truncated');
    assert(
      p.readWssServer(p.writeWssServer(decoded)).data.changes.length === 3,
      'Geometry was changed during serialization',
    );
    try {
      p.readWssServer(raw, { budget: { maxGeometryWork: 0 } });
    } catch (error) {
      assert(error.code === 'resource_limit', 'Wrong geometry budget refusal');
      return;
    }
    throw new Error('Geometry allowance was ignored');
  });
  check('exact binary64 dateline step', () => {
    const input = {
      type: 'LineString',
      coordinates: [
        [180, 0],
        [-5e-324, 0],
      ],
    };
    try {
      p.readJson(p.contract(p.Geometry), encode(input));
    } catch (error) {
      assert(error.code === 'unsupported_geometry', 'Wrong dateline refusal');
      return;
    }
    throw new Error('Rounded longitude difference hid a dateline crossing');
  });
  check(
    'mixed normal and subnormal 1024-pair geometry crosses full HTTP request and page boundaries',
    () => {
      const headers = new Headers({
        Authorization: `Bearer ${'A'.repeat(43)}`,
        'Atlas-Dataset-ID': s.id,
        'Atlas-Protocol-Version': '0.1.0',
        'Content-Type': 'application/json',
      });
      const definition = p.exchanges.CreateGeofeature;
      const request = { ...s.examples.CreateGeofeature[0], geometry: s.mixedPolygon };
      assert(request.geometry.coordinates[0].length === 1024, 'Wrong pair count');
      const parsed = p.readHttpRequest(definition, {
        method: definition.method,
        path: definition.path,
        headers,
        body: encode(request),
      });
      assert(JSON.stringify(parsed) === JSON.stringify(request), 'Mixed request changed');
      const items = [
        s.mixedPolygon,
        { ...s.mixedPolygon, coordinates: [[...s.mixedPolygon.coordinates[0]].reverse()] },
        s.mixedPolygon,
      ].map((geometry, i) => ({
        ...s.geofeature,
        id: `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`,
        geometry,
      }));
      const data = { items, next_page_token: null };
      const page = p.readHttp(
        p.exchanges.ListGeofeatures,
        { status: 200, headers, body: encode({ dataset_id: s.id, data }) },
        { request: { page_size: 3 } },
      );
      assert(same(page.body.data, data), 'Mixed page changed');
      const body = encode({
        dataset_id: s.id,
        data: { ...s.geofeature, geometry: s.mixedPolygon },
        commit_cursor: 'cursor',
      });
      assert(
        p.readHttp(definition, { status: 200, headers, body }, { request: parsed }).body.data
          .geometry.coordinates[0][128][1] === Number.MIN_VALUE,
        'Subnormal endpoint lost',
      );
    },
  );
  check('zero coefficients with maximum exponents retain numeric and Unicode facts', () => {
    for (const raw of ['0e-10000', '0e10000', '-0e-10000', '0.000e10000']) {
      assert(
        p.readJson(p.contract(p.Integer), new TextEncoder().encode(raw)) === 0,
        'Exact zero rejected',
      );
      assert(
        p.readJson(p.contract(p.Float), new TextEncoder().encode(raw)) === 0,
        'Floating zero rejected',
      );
    }
    for (const raw of ['1e-10000', '1e10000', '0e-10001', '0e10001', '100.0000000000000000001']) {
      try {
        p.readJson(p.contract(p.Integer), new TextEncoder().encode(raw));
      } catch (error) {
        assert(error.code === 'invalid_value', 'Wrong numeric refusal');
        continue;
      }
      throw new Error('Invalid integer accepted');
    }
    for (const value of ['\u0085', '\u2003', '\u3000', '\t\n']) {
      try {
        p.readJson(p.exchanges.GetAssetByAlias.request, encode({ alias: value }));
      } catch (error) {
        assert(error.code === 'invalid_value', 'Wrong blank refusal');
        continue;
      }
      throw new Error('Blank alias accepted');
    }
    for (const alias of ['地上局', '😀', '\ufeff', '\u200b'])
      assert(
        p.readJson(p.exchanges.GetAssetByAlias.request, encode({ alias })).alias === alias,
        'Unicode alias changed',
      );
  });
  check('lower-only limits and server controls', () => {
    assert(
      p.effectiveBudget('http_request', { maxBytes: 99999999 }).maxBytes === 1048576,
      'Byte ceiling was raised',
    );
    const frame = {
      type: 'gap',
      dataset_id: s.id,
      protocol_version: '0.1.0',
      data: {
        subscription_id: s.requestId,
        reason: 'resource_limit',
        earliest_recoverable_cursor: 'a'.repeat(17000),
      },
    };
    try {
      p.readWssServer(encode(frame));
    } catch (error) {
      assert(error.code === 'payload_too_large', 'Wrong control-size refusal');
      return;
    }
    throw new Error('A server control exceeded 16 KiB');
  });
  const regressions = runResponseRegressions(p);
  failures.push(...regressions.failures);
  checks += regressions.checks;
  const reviewFixes = runReviewFixes(p);
  failures.push(...reviewFixes.failures);
  checks += reviewFixes.checks;
  const admission = runAdmissionRegressions(p);
  failures.push(...admission.failures);
  checks += admission.checks;
  const identity = runIdentityRegressions(p);
  failures.push(...identity.failures);
  checks += identity.checks;
  return { checks, passed: checks - failures.length, failures };
}
