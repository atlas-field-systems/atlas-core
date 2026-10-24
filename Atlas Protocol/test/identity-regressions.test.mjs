import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as protocol from '../dist/index.js';
import { runIdentityRegressions } from './identity-regressions.mjs';

test('alias lookup, scoped reports, Entity identities and exact optionals at public boundaries', () => {
  const result = runIdentityRegressions(protocol);
  assert.deepEqual(result.failures, []);
  assert.equal(result.passed, result.checks);
});
