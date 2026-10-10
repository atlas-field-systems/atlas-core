// Transport bounds and content coding: gzip in both directions only when the
// complete eligible message is smaller, identical decoded facts and retry
// results, bounded refusal of malformed, truncated, corrupt, over-limit and
// unsupported input, deadlines and invalid responses as unknown outcomes,
// request limits and partial traffic without Core metadata.
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { accepted, AssetClient, AtlasClient } from "../../Atlas SDK/src/index.js";
import { processSigner } from "../simulator/index.js";
import {
  acceptedOutcome,
  errorCode,
  establishedAsset,
  FaultProxy,
  directProtocol,
  newInstallation,
  moveTo,
  record,
  rejectionCode,
  requestTimeoutMs,
  step,
} from "./support.js";

const installation = await newInstallation();
await installation.start();
const operator = await installation.operator();
const direct = await directProtocol(installation);
await direct.discover();
const { os, process } = await establishedAsset(installation);

// Independently stated eligible size: body, Content-Length field line and,
// when coded, the Content-Encoding field line.
const messageSize = (body: number, coded: boolean) =>
  body + "Content-Length: \r\n".length + String(body).length + (coded ? "Content-Encoding: gzip\r\n".length : 0);

// Wire recorder for SDK requests.
const sent: { path: string; encoding: string | null; wire: Buffer }[] = [];
const verified = await installation.fetch();
const recording = async (request: Request) => {
  if (request.method !== "GET") {
    sent.push({
      path: new URL(request.url).pathname,
      encoding: request.headers.get("content-encoding"),
      wire: Buffer.from(await request.clone().arrayBuffer()),
    });
  }
  return verified(request);
};
const decoded = (entry: { encoding: string | null; wire: Buffer }) =>
  entry.encoding === "gzip" ? gunzipSync(entry.wire) : entry.wire;
const key = await installation.adminKey();
const recorded = new AtlasClient({
  baseUrl: installation.baseUrl,
  fetch: recording,
  requestTimeoutMs,
  authentication: () => ({ bearer: key }),
});

// Responses: a repetitive list is gzip-coded and smaller as a complete
// message; the decoded bytes equal the direct response.
for (let index = 0; index < 25; index++) {
  accepted(
    await operator.createTask(await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(10, 20) })),
  );
}
const plain = await direct.request("GET", "/tasks?limit=1000", { headers: direct.context() });
const coded = await direct.request("GET", "/tasks?limit=1000", {
  headers: { ...direct.context(), "Accept-Encoding": "gzip" },
});
assert.equal(plain.headers["content-encoding"], undefined);
assert.equal(coded.headers["content-encoding"], "gzip");
assert.match(coded.headers.vary ?? "", /Accept-Encoding/iu);
assert.deepEqual(coded.raw, plain.raw, "identical decoded bytes");
assert(messageSize(coded.wire.length, true) < messageSize(plain.wire.length, false));
const refused = await direct.request("GET", "/tasks?limit=1000", {
  headers: { ...direct.context(), "Accept-Encoding": "gzip;q=0, identity" },
});
assert.equal(refused.headers["content-encoding"], undefined, "q=0 refuses gzip");
const small = await direct.request("GET", "/readiness", { headers: { "Accept-Encoding": "gzip" } });
assert.equal(small.headers["content-encoding"], undefined);
assert(
  messageSize(gzipSync(small.raw).length, true) >= messageSize(small.raw.length, false),
  "a small response stays direct because gzip would not be smaller",
);
assert.equal((await recorded.listTasks({ limit: 1000 })).items.length, 25, "the SDK reads coded responses");
step("responses use gzip only when the complete message is smaller; decoded bytes equal the direct form");

// Requests: the SDK codes a repetitive signed report and leaves small
// requests direct; Core verifies the original facts.
const description = "advance to the named coordinate position and report arrival ".repeat(7).trim();
const manifest = [
  { command: "move_to" as const, scheduling: ["queued" as const], cancellation: true, progress: true, description },
];
const reporter = new AssetClient({
  baseUrl: installation.baseUrl,
  fetch: recording,
  requestTimeoutMs,
  assetId: os.assetId,
  credential: os.credential,
  signer: processSigner(os.reporting.key),
  processGeneration: process.client.processGeneration ?? assert.fail(),
  nextSequence: process.client.nextSequence,
});
const signed = await reporter.prepareComponentReport({ command_manifest: manifest });
const first = acceptedOutcome(await reporter.submitEntityReport(signed), "gzip-coded signed report");
const signedWire = sent.at(-1) ?? assert.fail();
assert.equal(signedWire.encoding, "gzip");
assert(messageSize(signedWire.wire.length, true) < messageSize(decoded(signedWire).length, false));
assert.deepEqual(JSON.parse(decoded(signedWire).toString("utf8")), signed.body, "decoded bytes are the signed facts");
// The direct oracle sends the identical bytes uncoded.
const uncoded = await direct.request("PATCH", `/entities/${os.assetId}`, {
  headers: { ...direct.context(), "Content-Type": "application/json" },
  bearer: os.credential,
  body: decoded(signedWire),
});
assert.equal(uncoded.status, 200);
const replayReport = record(record(record(uncoded.body).data).report);
assert.equal(replayReport.disposition, "duplicate", "the same facts sent direct are the same report");
assert.deepEqual(replayReport.report_id, first.value.report?.report_id);
assert.deepEqual((await operator.getEntity(os.assetId)).command_manifest, manifest);

const target = (await operator.listTasks({ limit: 1 })).items[0] ?? assert.fail();
acceptedOutcome(
  await recorded.requestCancellation(await recorded.prepareCancellation({ taskId: target.id })),
  "small request",
);
const smallWire = sent.at(-1) ?? assert.fail();
assert.equal(smallWire.encoding, null);
assert(messageSize(gzipSync(smallWire.wire).length, true) >= messageSize(smallWire.wire.length, false));
step("requests use gzip only when smaller; Core verifies the signed facts, and the same bytes sent direct replay");

// Partial traffic carries no Core-owned metadata.
for (const entry of sent.filter((candidate) => candidate.path.startsWith("/entities/"))) {
  const text = decoded(entry).toString("utf8");
  for (const member of [
    "received_at",
    "changed_at",
    "updated_at",
    "created_at",
    "last_seen",
    "communications",
    "edit_revision",
  ]) {
    assert(!text.includes(`"${member}"`), `reports never echo ${member}`);
  }
}
step("Asset reports carry only supplied facts and never echo Core metadata");

// Bounded refusal of coded input, with no effect.
const tasksBefore = (await operator.listTasks({ limit: 1000 })).items.length;
const json = Buffer.from(
  JSON.stringify({ request_id: crypto.randomUUID(), asset_id: os.assetId, input: moveTo(3, 4) }),
);
const gzipped = gzipSync(json);
const corrupt = Buffer.from(gzipped);
corrupt[corrupt.length - 6] = (corrupt[corrupt.length - 6] ?? 0) ^ 0xff;
const post = (body: Buffer, encoding: string) =>
  direct.request("POST", "/tasks", {
    headers: { ...direct.context(), "Content-Type": "application/json", "Content-Encoding": encoding },
    body,
  });
for (const [name, body, encoding, status, code] of [
  ["unsupported coding", json, "br", 415, "unsupported_content_encoding"],
  ["not gzip", json, "gzip", 400, "invalid_content_encoding"],
  ["truncated gzip", gzipped.subarray(0, gzipped.length - 10), "gzip", 400, "invalid_content_encoding"],
  ["corrupt checksum", corrupt, "gzip", 400, "invalid_content_encoding"],
  ["trailing garbage", Buffer.concat([gzipped, Buffer.from("garbage")]), "gzip", 400, "invalid_content_encoding"],
  ["decoded size over the limit", gzipSync(Buffer.alloc(2 << 20, 0x20)), "gzip", 413, "payload_too_large"],
  ["encoded size over the limit", Buffer.alloc((1 << 20) + 1, 0x20), "identity", 413, "payload_too_large"],
] as const) {
  const response = await post(body, encoding);
  assert.equal(response.status, status, name);
  assert.equal(errorCode(response), code, name);
  if (status === 415) assert.equal(response.headers["accept-encoding"], "gzip", "415 names the supported coding");
}
assert.equal((await operator.listTasks({ limit: 1000 })).items.length, tasksBefore, "refused input has no effect");
const half = Math.floor(json.length / 2);
const multiMember = await post(
  Buffer.concat([gzipSync(json.subarray(0, half)), gzipSync(json.subarray(half))]),
  "gzip",
);
assert.equal(multiMember.status, 201, "multi-member gzip decodes as the concatenation of its members");
step(
  "unsupported, malformed, truncated, corrupt and over-limit coded input is refused without effect; multi-member decodes",
);

// Deadlines and invalid responses are unknown outcomes; retries recover.
const proxy = await FaultProxy.start(installation);
const impatient = new AtlasClient({
  baseUrl: proxy.baseUrl,
  fetch: verified,
  requestTimeoutMs: 2_000,
  authentication: () => ({ bearer: key }),
});
const slow = await impatient.prepareTaskCreation({ assetId: os.assetId, input: moveTo(5, 6) });
proxy.set("stall");
const timedOut = await impatient.createTask(slow);
assert.equal(timedOut.outcome, "unknown_outcome", "a deadline is never a rejection");
proxy.set("tamper");
const forged = await impatient.prepareTaskCreation({ assetId: os.assetId, input: moveTo(7, 8) });
const invalid = await impatient.createTask(forged);
assert.equal(invalid.outcome, "unknown_outcome", "an invalid response is never a success");
proxy.set("pass");
assert.equal(acceptedOutcome(await operator.createTask(slow), "retry after deadline").status, 200);
assert.equal(acceptedOutcome(await operator.createTask(forged), "retry after invalid response").status, 200);
step("deadlines and invalid responses are unknown outcomes; identical retries recover the committed Tasks");

// Admission limit: a typed refusal at the outstanding-Task bound.
const limited = await establishedAsset(installation);
let created = 0;
for (;;) {
  const outcome = await operator.createTask(
    await operator.prepareTaskCreation({ assetId: limited.os.assetId, input: moveTo(1, 1) }),
  );
  if (outcome.outcome !== "accepted") {
    assert.equal(rejectionCode(outcome, "outstanding bound"), "resource_limit");
    assert.equal(outcome.outcome === "rejected" && outcome.rejection.status, 429);
    break;
  }
  created += 1;
}
assert.equal(created, 1000, "the bound is 1000 outstanding Tasks per Asset");
step("the outstanding-Task admission bound refuses with a typed 429");

await proxy.close();
await installation.stop();
