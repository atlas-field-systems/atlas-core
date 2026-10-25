import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as protocol from '../dist/index.js';
import { runPortable } from './portable.mjs';
test('portable consumer workflows and aggregate adversarial geometry', () => {
  const result = runPortable(protocol);
  assert.deepEqual(result.failures, []);
  assert.equal(result.passed, result.checks);
});
