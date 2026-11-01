import assert from 'node:assert/strict';
import { uuid, registration } from './harness.mjs';
export async function sourceAsset(http) {
  const operation = http.assets.register({ ...registration(), capabilities: { commands: [] } });
  try {
    return sent(await operation.send()).asset.id;
  } finally {
    operation.close();
  }
}
export function success(result) {
  assert.equal(result.kind, 'response', JSON.stringify(result));
  assert.equal(result.response.kind, 'success', JSON.stringify(result));
  return result.response.body.data;
}
export function sent(result) {
  return success(result.attempt);
}
export async function publicClient(_t, f, options = {}, remote) {
  const client = f.client({
    ...options,
    ...(remote ? { remote } : {}),
  });
  success(await client.connect());
  return { client, http: client.http, reporting: client.reporting };
}
export function reading(sequence, sections, extras = {}) {
  return {
    report_id: uuid(),
    sequence: String(sequence),
    generated_at: '2026-10-21T12:00:00Z',
    mode: 'current',
    sections,
    ...extras,
  };
}
export function telemetry(origin, latitude, at, readingId = uuid()) {
  return {
    state: 'value',
    classification: 'dated_measurement',
    observed_at: at,
    value: { position: { latitude, longitude: -1 }, altitude: null, ground_speed: 0 },
    constituents: {
      position: { origin, reading_id: readingId },
      altitude: { origin, reading_id: uuid() },
      ground_speed: { origin, reading_id: uuid() },
    },
  };
}
