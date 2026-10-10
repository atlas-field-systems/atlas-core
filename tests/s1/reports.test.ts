// Sparse reports, distinct source/receipt/change times, movement history and
// shared report acceptance across Entity and Task report routes.
import assert from "node:assert/strict";
import { accepted, AssetClient, type Evidence } from "../../Atlas SDK/src/index.js";
import { processSigner } from "../simulator/index.js";
import {
  acceptedOutcome,
  errorCode,
  establishedAsset,
  directProtocol,
  newInstallation,
  moveTo,
  rejectionCode,
  sameInstant,
  step,
} from "./support.js";

const installation = await newInstallation();
await installation.start();
const operator = await installation.operator();
const { os, process } = await establishedAsset(installation);
const client = process.client;
const report = async (payload: Parameters<AssetClient["prepareComponentReport"]>[0], evidence?: Evidence) =>
  acceptedOutcome(await client.submitEntityReport(await client.prepareComponentReport(payload, evidence)), "report");
const observed = (quantities: Record<string, string | null>): Evidence => ({
  kind: "current",
  observationTimes: Object.fromEntries(
    Object.entries(quantities).map(([quantity, time]) => [quantity, { observed_at: time }]),
  ),
});

// Position observed at one time; a later heading-only report leaves the
// position's age and report metadata unchanged.
const positionTime = new Date(Date.now() - 2_000).toISOString();
await report(
  { components: { telemetry: { position: { latitude: 10, longitude: 20 } } } },
  observed({ position: positionTime }),
);
const afterPosition = await operator.getEntity(os.assetId);
const positionUnit = afterPosition.reporting.position;
sameInstant(positionUnit?.observed_at, positionTime, "original observation time is preserved");
assert.notEqual(positionUnit?.received_at, positionTime, "receipt time is Core's");
await report({ components: { telemetry: { heading_deg: 90 } } });
const afterHeading = await operator.getEntity(os.assetId);
assert.deepEqual(afterHeading.reporting.position, positionUnit, "heading-only report does not refresh position age");
assert.deepEqual(afterHeading.components.telemetry, {
  position: { latitude: 10, longitude: 20 },
  heading_deg: 90,
});
assert.equal(
  afterHeading.reporting.heading_deg?.observed_at,
  null,
  "an unsupplied observation time is unknown, never the report or receipt time",
);
step("position keeps its observation time and age when a later report carries only heading");

// Same-status newer report advances report and receipt metadata, not changed_at.
const statusReport = async (value: "ready" | "busy") =>
  acceptedOutcome(await client.submitEntityReport(await client.prepareStatusReport({ value, reason: null })), "status");
await statusReport("ready");
const readyOnce = await operator.getAssetStatus(os.assetId);
assert.equal(readyOnce.value, "ready");
assert.notEqual(readyOnce.changed_at, null);
await statusReport("ready");
const readyTwice = await operator.getAssetStatus(os.assetId);
assert.equal(readyTwice.changed_at, readyOnce.changed_at, "unchanged value keeps changed_at");
assert(
  readyTwice.received_at !== null && readyOnce.received_at !== null && readyTwice.received_at > readyOnce.received_at,
);
assert(
  readyTwice.reported_at !== null && readyOnce.reported_at !== null && readyTwice.reported_at >= readyOnce.reported_at,
);
step("same-status newer report advances reported/received metadata but not changed_at");

// Speed-only and altitude-only samples, unknown observation time and null
// removal.
await report({ components: { telemetry: { speed_mps: 2.5 } } }, observed({ speed_mps: null }));
await report(
  { components: { telemetry: { altitude: { value_m: 120.5, vertical_reference: "wgs84_ellipsoid" } } } },
  observed({ altitude: new Date().toISOString() }),
);
await report({ components: { telemetry: { heading_deg: null } } });
const telemetry = (await operator.getEntity(os.assetId)).components.telemetry;
assert.equal(telemetry?.heading_deg, undefined, "null removes heading");
assert.equal(telemetry?.speed_mps, 2.5);
const history = await operator.movementHistory(os.assetId);
assert.deepEqual(
  history.items.map((sample) =>
    Object.keys(sample).filter((key) => ["position", "speed_mps", "altitude"].includes(key)),
  ),
  [["position"], ["speed_mps"], ["altitude"]],
  "each sample has only its supplied quantities; heading is not movement",
);
assert.equal(history.items[1]?.speed_mps?.observed_at, null, "unknown original time stays null");
const direct = await directProtocol(installation);
await direct.discover();
const complete = await client.prepareComponentReport({
  components: { telemetry: { position: { latitude: 10, longitude: 20 } } },
});
const halfPosition = await direct.request("PATCH", `/entities/${os.assetId}`, {
  headers: direct.context(),
  bearer: os.credential,
  json: { ...complete.body, components: { telemetry: { position: { latitude: 10 } } } },
});
assert.equal(halfPosition.status, 400, "a position needs both coordinates");
assert.equal(errorCode(halfPosition), "invalid_request");
step("speed-only and altitude-only samples, unknown original time and null removal; half positions are invalid");

// History pages and explicit time basis.
const pages: string[] = [];
let token: string | undefined;
do {
  const page = await operator.movementHistory(os.assetId, {
    limit: 1,
    ...(token === undefined ? {} : { page_token: token }),
  });
  pages.push(...page.items.map((sample) => sample.sample_id));
  token = page.next_page_token ?? undefined;
} while (token !== undefined);
assert.deepEqual(
  pages,
  history.items.map((sample) => sample.sample_id),
);
const byObservation = await operator.movementHistory(os.assetId, { time_basis: "observed_at" });
assert.equal(byObservation.time_basis, "observed_at");
assert(
  byObservation.items.every((sample) => (sample.position ?? sample.speed_mps ?? sample.altitude)?.observed_at !== null),
  "observation-time history contains only samples with known observation time",
);
const wrongToken = await operator.movementHistory(os.assetId, { time_basis: "observed_at", limit: 1 });
if (wrongToken.next_page_token !== null) {
  await assert.rejects(
    () => operator.movementHistory(os.assetId, { limit: 1, page_token: wrongToken.next_page_token ?? "" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "cursor_invalid",
  );
}
step("movement history pages follow one boundary; time basis is explicit and its token cannot be reused");

// Duplicates and identity conflicts: no second sample, Contact or effect.
const before = await operator.getEntity(os.assetId);
const samplesBefore = (await operator.movementHistory(os.assetId)).items.length;
const positionReport = await client.prepareComponentReport(
  { components: { telemetry: { position: { latitude: 11, longitude: 21 } } } },
  observed({ position: new Date().toISOString() }),
);
const first = acceptedOutcome(await client.submitEntityReport(positionReport), "first submission");
const repeat = acceptedOutcome(await client.submitEntityReport(positionReport), "duplicate submission");
assert.equal(repeat.value.report?.disposition, "duplicate");
assert.deepEqual(repeat.value.report?.movement_sample_ids, first.value.report?.movement_sample_ids);
assert.equal((await operator.movementHistory(os.assetId)).items.length, samplesBefore + 1, "one sample");
const afterDuplicate = await operator.getEntity(os.assetId);
assert.equal(afterDuplicate.components.heartbeat.last_seen, first.value.resource.components.heartbeat.last_seen);
assert(before.version !== afterDuplicate.version);
const sameIdentity = new AssetClient({
  ...(await installation.link()),
  assetId: os.assetId,
  credential: os.credential,
  signer: processSigner(os.reporting.key),
  processGeneration: positionReport.processGeneration,
  nextSequence: positionReport.sequence,
});
const changedFacts = await sameIdentity.prepareComponentReport(
  { components: { telemetry: { position: { latitude: 12, longitude: 21 } } } },
  observed({ position: new Date().toISOString() }),
);
assert.equal(
  rejectionCode(await sameIdentity.submitEntityReport(changedFacts), "changed facts"),
  "report_identity_conflict",
);
const changedTime = await new AssetClient({
  ...(await installation.link()),
  assetId: os.assetId,
  credential: os.credential,
  signer: processSigner(os.reporting.key),
  processGeneration: positionReport.processGeneration,
  nextSequence: positionReport.sequence,
}).prepareComponentReport(
  { components: { telemetry: { position: { latitude: 11, longitude: 21 } } } },
  observed({ position: "2026-01-01T00:00:00Z" }),
);
assert.equal(
  rejectionCode(await sameIdentity.submitEntityReport(changedTime), "changed source time"),
  "report_identity_conflict",
);
assert.deepEqual(await operator.getEntity(os.assetId), afterDuplicate, "conflicts leave no effect");
step("duplicates replay the original receipt without new samples or Contact; changed facts or source times conflict");

// Per-unit ordering: an older position delivered late is accepted as
// history but does not replace the newer current value.
const older = await client.prepareComponentReport({
  components: { telemetry: { position: { latitude: 1, longitude: 1 } } },
});
const newer = await client.prepareComponentReport({
  components: { telemetry: { position: { latitude: 2, longitude: 2 } } },
});
acceptedOutcome(await client.submitEntityReport(newer), "newer position");
const lateOlder = acceptedOutcome(await client.submitEntityReport(older), "older position");
assert.deepEqual(lateOlder.value.report?.applied_fields, []);
assert.deepEqual((await operator.getEntity(os.assetId)).components.telemetry?.position, { latitude: 2, longitude: 2 });
assert.equal(lateOlder.value.report?.movement_sample_ids.length, 1, "the older observation is retained as history");
step("per-unit ordering keeps the newer current position while retaining the older sample");

// An older Task outcome delivered after newer telemetry is still recorded.
const task = accepted(
  await operator.createTask(await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(10, 20) })),
);
await process.receiveWork();
await process.capture(await os.startNext());
await process.flush();
await os.progress(task.id, 1);
const outcome = await client.prepareTaskReport(task.id, { event: "completed" });
const laterTelemetry = await client.prepareComponentReport({ components: { telemetry: { speed_mps: 0 } } });
acceptedOutcome(await client.submitEntityReport(laterTelemetry), "newer telemetry");
acceptedOutcome(await client.submitTaskReport(outcome), "older outcome");
assert.equal((await operator.getTask(task.id)).status, "completed");
step("an older Task outcome delivered after newer telemetry is recorded");

// Historical evidence is recorded without refreshing Contact.
const seen = (await operator.getEntity(os.assetId)).components.heartbeat.last_seen;
const historical = acceptedOutcome(
  await client.submitEntityReport(
    await client.prepareComponentReport(
      { components: { telemetry: { speed_mps: 1.5 } } },
      {
        kind: "historical",
        generatedAt: new Date(Date.now() - 60_000).toISOString(),
        retainedEvidenceId: crypto.randomUUID(),
      },
    ),
  ),
  "historical report",
);
assert.equal(historical.value.report?.contact_refreshed, false);
assert.equal((await operator.getEntity(os.assetId)).components.heartbeat.last_seen, seen);
step("historical evidence is recorded without refreshing Contact");

// A current report received after its challenge window cannot prove Contact.
const delayed = await client.prepareComponentReport({ components: { telemetry: { speed_mps: 1 } } });
const window = 10_000;
await new Promise((resolveDelay) => setTimeout(resolveDelay, window + 1_000));
const stale = acceptedOutcome(await client.submitEntityReport(delayed), "stale current report");
assert.equal(stale.value.report?.disposition, "accepted");
assert.equal(stale.value.report?.contact_refreshed, false, "late receipt is not fresh Contact");
assert.equal((await operator.getEntity(os.assetId)).components.communications.state, "offline");
step("a current report received outside its challenge window is accepted without fresh Contact");

await installation.stop();
