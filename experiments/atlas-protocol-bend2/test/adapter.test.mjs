import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protocol as p } from './adapter.mjs';

test('HTTP byte limits refuse body and upload copies before iteration', () => {
  let iterations = 0;
  class UnreadBytes extends Uint8Array {
    *[Symbol.iterator]() {
      iterations++;
      throw new Error('Oversized bytes were iterated');
    }
  }
  const refused = (read) => {
    assert.throws(
      read,
      (error) => error instanceof p.ProtocolError && error.code === 'payload_too_large',
    );
    assert.equal(iterations, 0);
  };
  const response = {
    status: 200,
    headers: new Headers(),
    body: new UnreadBytes(p.budgets.http_response.maxBytes + 1),
  };
  refused(() => p.readHttp(p.exchanges.GetReadiness, response));
  const request = {
    method: 'POST',
    path: '/',
    headers: new Headers(),
    body: new UnreadBytes(p.budgets.http_request.maxBytes + 1),
  };
  refused(() => p.readHttpRequest(p.exchanges.CreateTask, request));
  const { body: uploadDescriptor, ...withoutBody } = request;
  refused(() => p.readHttpRequest(p.exchanges.CreateTask, { ...withoutBody, uploadDescriptor }));
  const small = { ...response, body: new UnreadBytes(5) };
  refused(() => p.readHttp(p.exchanges.GetReadiness, small, { budget: { maxBytes: 4 } }));
  refused(() =>
    p.readHttpRequest(p.exchanges.CreateTask, { ...request, body: small.body }, { maxBytes: 4 }),
  );
});
