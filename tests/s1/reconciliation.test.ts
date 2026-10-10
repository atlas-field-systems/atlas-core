import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:https";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  createAtlasClient,
  createAssetClient,
  type RetainedExecutionEvidence,
  type TaskReportFields,
  type RetainedAssetSnapshot,
} from "../../Atlas SDK/src/index.js";
import { createHTTPSFetch } from "../../Atlas SDK/src/node.js";
import { ownedFixtureRoot, temporaryTLS } from "./tls.js";
import { assetId, datasetId, task, queue, instant } from "./fixtures.js";
const ids = [
  "22222222-2222-4222-8222-222222222221",
  "22222222-2222-4222-8222-222222222222",
  "22222222-2222-4222-8222-222222222223",
  "22222222-2222-4222-8222-222222222224",
  "22222222-2222-4222-8222-222222222225",
  "22222222-2222-4222-8222-222222222226",
] as const;
function retained(taskId: string, state: RetainedExecutionEvidence["state"]): RetainedExecutionEvidence {
  return {
    taskId,
    executionId: "44444444-4444-4444-8444-444444444444",
    executionCount: 1,
    state,
    progress: null,
    generatedAt: "2026-10-09T12:00:00.5000+02:00",
    acknowledgedAt: null,
    startedAt: instant,
    finishedAt: null,
    origin: null,
    retainedEvidenceId: "55555555-5555-4555-8555-555555555555",
    outcome: null,
    heldContinuation: [],
  };
}

test("replacement reconciliation preserves source provenance and holds unknown work with its continuation", async () => {
  await using tls = await temporaryTLS(ownedFixtureRoot(process.argv));
  let writes = 0;
  await using server = createServer({ key: tls.key, cert: tls.certificate }, (request, response) => {
    if (request.method !== "GET") writes++;
    const data =
      request.url === "/health"
        ? {
            live: true,
            core_release: "0.1.0",
            supported_protocol_versions: ["0.1.0"],
            server_time: instant,
            open_enrollment: false,
            open_enrolled_identity_count: 0,
          }
        : { items: ids.map(task), next_cursor: null, queue_revision: "0", task_queue: queue };
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Atlas-Dataset-ID": datasetId,
      "Atlas-Protocol-Version": "0.1.0",
    });
    response.end(JSON.stringify({ dataset_id: datasetId, read_context: { source: "http", commit_cursor: "1" }, data }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const client = createAtlasClient({
    baseUrl: `https://127.0.0.1:${address.port}`,
    credential: () => "asset-owned-secret",
    fetch: createHTTPSFetch({ ca: tls.certificate, maxJSONBytes: 16384, timeoutMs: 2000 }),
  });
  assert.equal((await client.discover()).outcome, "accepted");
  const key = generateKeyPairSync("ed25519");
  const reporter = createAssetClient({
    client,
    assetId,
    processGeneration: "2",
    signer: {
      processId: "33333333-3333-4333-8333-333333333333",
      publicKey: key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"),
      sign: async (bytes) => sign(null, bytes, key.privateKey),
    },
    authorizer: { authorize: async (bytes) => sign(null, bytes, key.privateKey) },
  });
  const completed = retained(ids[0], "completed");
  completed.outcome = { status: "completed" };
  completed.finishedAt = "2026-10-09T12:00:00.5000+02:00";
  completed.origin = { process_generation: "1", sequence: "7" };
  completed.retainedEvidenceId = null;
  const completedFields: TaskReportFields = {
    status: "completed",
    execution_id: "44444444-4444-4444-8444-444444444444",
    finished_at: completed.finishedAt,
  };
  // Original omission is significant: recovered completion must not invent
  // acknowledged_at or started_at under this already established event origin.
  completed.originalReport = { fields: completedFields, timing: { generatedAt: completed.generatedAt } };
  const unknown = retained(ids[1], "unknown");
  unknown.heldContinuation = [ids[2]];
  const running = retained(ids[3], "running");
  running.origin = { process_generation: "1", sequence: "8" };
  running.retainedEvidenceId = null;
  running.originalReport = {
    fields: {
      status: "in_progress",
      execution_id: "44444444-4444-4444-8444-444444444444",
      started_at: instant,
      progress: { distance_remaining_m: 5.1 },
    },
    timing: { generatedAt: running.generatedAt },
  };
  const suspended = retained(ids[4], "suspended");
  const snapshot: RetainedAssetSnapshot = {
    assetId,
    datasetId,
    processId: "66666666-6666-4666-8666-666666666666",
    processGeneration: "1",
    nextSequence: "9",
    executions: [
      completed,
      unknown,
      retained(ids[2], "not_started"),
      running,
      suspended,
      retained(ids[5], "not_started"),
    ],
    pending: [],
  };
  const result = await reporter.reconcile(snapshot);
  assert.equal(result.outcome, "accepted");
  assert(result.outcome === "accepted");
  assert.deepEqual(
    result.value.tasks.map((task) => task.id),
    [ids[5]],
  );
  assert.deepEqual(new Set(result.value.heldTaskIds), new Set([ids[1], ids[2]]));
  assert.deepEqual(
    result.value.reports.map((report) => report.targetId),
    [ids[0], ids[3], ids[4]],
  );
  const recovered = result.value.reports[0];
  assert(recovered);
  assert.equal(recovered.body.report_context.evidence_kind, "historical");
  assert.equal(recovered.body.report_context.contact_challenge, null);
  assert.deepEqual(recovered.body.report_context.evidence_origin, { process_generation: "1", sequence: "7" });
  assert.equal(recovered.body.report_context.generated_at, completed.generatedAt);
  assert.equal("started_at" in recovered.body, false);
  assert.equal("acknowledged_at" in recovered.body, false);
  assert.deepEqual(
    snapshot.executions.map((evidence) => evidence.executionCount),
    [1, 1, 1, 1, 1, 1],
    "report reconciliation does not execute or change external execution evidence",
  );
  assert.equal(writes, 0);
  delete completed.originalReport;
  const uncertain = await reporter.reconcile(snapshot);
  assert(uncertain.outcome === "accepted");
  assert(
    uncertain.value.heldTaskIds.includes(ids[0]),
    "missing exact facts cannot fabricate a new payload under an old event origin",
  );
  unknown.state = "not_started";
  unknown.heldContinuation = [];
  const recoveredQueue = await reporter.reconcile(snapshot);
  assert(recoveredQueue.outcome === "accepted");
  assert(recoveredQueue.value.tasks.some((task) => task.id === ids[1]));
  assert(recoveredQueue.value.tasks.some((task) => task.id === ids[2]));
  server.closeAllConnections();
});
