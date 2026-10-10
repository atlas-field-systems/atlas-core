import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:https";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { createAtlasClient } from "../../Atlas SDK/src/index.js";
import { createHTTPSFetch } from "../../Atlas SDK/src/node.js";
import { ownedFixtureRoot, temporaryTLS } from "./tls.js";

const oldDataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const newDataset = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const taskInput = {
  asset_id: "11111111-1111-4111-8111-111111111111",
  idempotency_key: "22222222-2222-4222-8222-222222222222",
  command: "move_to",
  input: { target: { kind: "position", position: { latitude: 10, longitude: 20 } } },
} as const;
function health(dataset: string) {
  return {
    dataset_id: dataset,
    read_context: { source: "http", commit_cursor: "1" },
    data: {
      live: true,
      core_release: "0.1.0",
      supported_protocol_versions: ["0.1.0"],
      server_time: "2026-10-09T10:00:00Z",
      open_enrollment: false,
      open_enrolled_identity_count: 0,
    },
  };
}
function reply(response: ServerResponse, dataset: string, body: unknown, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Atlas-Dataset-ID": dataset,
    "Atlas-Protocol-Version": "0.1.0",
  });
  response.end(JSON.stringify(body));
}
function refusal(dataset: string) {
  return {
    dataset_id: dataset,
    error: {
      code: "authorization_denied",
      message: "Assigned caller required",
      request_id: "33333333-3333-4333-8333-333333333333",
    },
  };
}

test(
  "SDK deadlines bound pending credentials before discovery or retained transmission",
  { timeout: 3000 },
  async () => {
    let fetches = 0;
    let release: (credential: string) => void = () => {};
    const credential = new Promise<string>((resolve) => {
      release = resolve;
    });
    const client = createAtlasClient({
      baseUrl: "https://127.0.0.1:1",
      bootstrapContext: { datasetId: oldDataset, protocolVersion: "0.1.0" },
      credential: () => credential,
      timeoutMs: 30,
      fetch: async () => {
        fetches++;
        throw new Error("Credential deadline must prevent transmission");
      },
    });
    const retained = client.prepareRegistration({
      id: taskInput.asset_id,
      type: "asset",
      registration_id: taskInput.idempotency_key,
    });
    assert.deepEqual(await client.discover(), { outcome: "not_submitted", reason: "authentication" });
    assert.deepEqual(await client.submit(retained), {
      outcome: "not_submitted",
      reason: "authentication",
      descriptor: retained,
    });
    assert.equal(fetches, 0);
    release("late-credential");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fetches, 0, "late credential resolution cannot submit an abandoned call");
  },
);

test("SDK Dataset discovery invalidates retained writes and delayed old replies through trusted HTTPS", async () => {
  await using tls = await temporaryTLS(ownedFixtureRoot(process.argv));
  let current = oldDataset;
  let mode: "hold" | "refuse" | "mismatch" = "hold";
  let writes = 0;
  let held: ServerResponse | undefined;
  let entered: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await using server = createServer({ key: tls.key, cert: tls.certificate }, (request, response) => {
    if (request.method === "GET") reply(response, current, health(current));
    else {
      writes++;
      if (mode === "hold") {
        held = response;
        entered();
      } else reply(response, current, refusal(mode === "mismatch" ? oldDataset : current), 403);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const client = createAtlasClient({
    baseUrl: `https://127.0.0.1:${address.port}`,
    credential: () => "retained-secret",
    fetch: createHTTPSFetch({ ca: tls.certificate, maxJSONBytes: 8192, timeoutMs: 2000 }),
  });
  assert.equal((await client.discover()).outcome, "accepted");
  const original = client.prepareTask(taskInput);
  const delayed = client.submit(original);
  await barrier;
  current = newDataset;
  assert.equal((await client.discover()).outcome, "accepted");
  assert(held);
  reply(held, oldDataset, refusal(oldDataset), 403);
  assert.deepEqual(await delayed, {
    outcome: "dataset_invalidated",
    previousDatasetId: oldDataset,
    datasetId: newDataset,
    descriptor: original,
  });
  assert.equal(client.context()?.datasetId, newDataset, "late traffic cannot resurrect an old Dataset");
  assert.equal((await client.submit(original)).outcome, "dataset_invalidated");
  assert.equal(writes, 1, "known obsolete descriptors are refused before transmission");
  mode = "refuse";
  const refused = await client.submit(client.prepareTask(taskInput));
  assert.equal(refused.outcome, "rejected");
  if (refused.outcome === "rejected") assert.equal(refused.error.error.code, "authorization_denied");
  mode = "mismatch";
  const mismatched = client.prepareTask(taskInput);
  assert.deepEqual(
    await client.submit(mismatched),
    { outcome: "unknown_outcome", reason: "protocol", descriptor: mismatched },
    "header/body context disagreement cannot prove a mutation refusal",
  );
  assert.equal(writes, 3);
  server.closeAllConnections();
});
