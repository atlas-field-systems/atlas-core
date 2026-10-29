import assert from 'node:assert/strict';
import { Session } from '../dist/connection.js';
import { Operations } from '../dist/prepared.js';
import { createRemoteReads } from '../dist/remote-reads.js';
import { createReporting } from '../dist/reporting.js';
import { httpResources } from '../dist/client.js';
import { uuid } from './harness.mjs';

export function success(result) {
  assert.equal(result.kind, 'response', JSON.stringify(result));
  assert.equal(result.response.kind, 'success', JSON.stringify(result));
  return result.response.body.data;
}
export function sent(result) {
  return success(result.attempt);
}
export async function owners(t, f, options = {}, remoteLimits) {
  const session = new Session({ baseUrl: f.proxyUrl, credentials: () => f.apiKey, ...options });
  const operations = new Operations(session);
  success(await session.discover());
  const remote = createRemoteReads(session, operations, remoteLimits);
  const reporting = createReporting(session, operations);
  const http = httpResources(session, operations);
  t.after(async () => {
    await session.close();
    operations.close();
  });
  return { session, operations, remote, reporting, http };
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
