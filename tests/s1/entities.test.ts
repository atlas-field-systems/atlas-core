// Descriptive edits and Asset deletion: Alias resolution and uniqueness, edit
// revisions, mixed mutation classes, Asset self-description, unrelated edits
// beside reports, the nonterminal-Task guard, both commit orders against
// assignment and reports, revocation and Restart.
import assert from "node:assert/strict";
import { accepted } from "../../Atlas SDK/src/index.js";
import { AssetOS, ReportingProcess } from "../simulator/index.js";
import {
  acceptedOutcome,
  errorCode,
  establishedAsset,
  failsWith,
  directProtocol,
  newInstallation,
  moveTo,
  rejectionCode,
  step,
} from "./support.js";

const installation = await newInstallation();
await installation.start();
const operator = await installation.operator();
const direct = await directProtocol(installation);
await direct.discover();

const rover = await establishedAsset(installation, { alias: "Rover-A" });
const other = await establishedAsset(installation, { alias: "Rover-B" });

// Alias resolution ignores case; uniqueness ignores case.
assert.equal((await operator.getEntityByAlias("rover-a")).id, rover.os.assetId);
const reviewed = await operator.getEntity(other.os.assetId);
const clash = await operator.editEntity({
  entityId: other.os.assetId,
  expectedEditRevision: reviewed.edit_revision,
  alias: "ROVER-A",
});
assert.equal(rejectionCode(clash, "case-insensitive Alias clash"), "alias_conflict");

// Edit revision precondition: required, and stale edits conflict without
// overwriting. The SDK never refreshes the base itself.
const missing = await direct.request("PATCH", `/entities/${other.os.assetId}`, {
  headers: direct.context(),
  json: { alias: "no-precondition" },
});
assert.equal(missing.status, 428);
assert.equal(errorCode(missing), "precondition_required");
const edited = acceptedOutcome(
  await operator.editEntity({
    entityId: other.os.assetId,
    expectedEditRevision: reviewed.edit_revision,
    alias: "Scout",
  }),
  "first edit",
);
assert.equal(edited.value.alias, "Scout");
const stale = await operator.editEntity({
  entityId: other.os.assetId,
  expectedEditRevision: reviewed.edit_revision,
  subtype: "tracked",
});
assert.equal(rejectionCode(stale, "stale edit"), "edit_conflict");
assert.equal((await operator.getEntity(other.os.assetId)).subtype, null, "a stale edit does not overwrite");
await assert.rejects(() => operator.getEntityByAlias("rover-b"), failsWith("not_found"));
step("Alias resolution and uniqueness ignore case; edits require and check the reviewed edit revision");

// One mutation class per patch; Assets cannot self-describe after
// registration; operators cannot submit Asset reports.
const report = await rover.process.client.prepareComponentReport({ components: { telemetry: { heading_deg: 45 } } });
const mixed = await direct.request("PATCH", `/entities/${rover.os.assetId}`, {
  headers: direct.context(),
  json: { ...report.body, alias: "mixed", expected_edit_revision: "1" },
});
assert.equal(mixed.status, 400);
assert.equal(errorCode(mixed), "mixed_mutation_classes");
const selfDescribe = await direct.request("PATCH", `/entities/${rover.os.assetId}`, {
  headers: direct.context(),
  bearer: rover.os.credential,
  json: { alias: "self-named", expected_edit_revision: "1" },
});
assert.equal(selfDescribe.status, 403);
assert.equal(errorCode(selfDescribe), "forbidden_field");
const operatorReport = await direct.request("PATCH", `/entities/${rover.os.assetId}`, {
  headers: direct.context(),
  json: report.body,
});
assert.equal(operatorReport.status, 403);
assert.equal(errorCode(operatorReport), "forbidden_field");
const derived = await direct.request("PATCH", `/entities/${rover.os.assetId}`, {
  headers: direct.context(),
  json: { components: { heartbeat: { last_seen: null } } },
});
assert.equal(derived.status, 403, "Derived Contact is never written");
assert.equal(errorCode(derived), "forbidden_field");
step("mixed mutation classes, Asset self-description, operator reports and Derived writes are refused");

// An unrelated edit does not lose a report prepared before it or change
// Contact.
const roverBefore = await operator.getEntity(rover.os.assetId);
const subtypeEdit = acceptedOutcome(
  await operator.editEntity({
    entityId: rover.os.assetId,
    expectedEditRevision: roverBefore.edit_revision,
    subtype: "wheeled",
  }),
  "unrelated edit",
).value;
assert.deepEqual(subtypeEdit.components.heartbeat, roverBefore.components.heartbeat, "edits never establish Contact");
assert.deepEqual(subtypeEdit.reporting, roverBefore.reporting, "edits never change report ordering");
acceptedOutcome(await rover.process.client.submitEntityReport(report), "report prepared before the edit");
const roverAfter = await operator.getEntity(rover.os.assetId);
assert.equal(roverAfter.components.telemetry?.heading_deg, 45);
assert.equal(roverAfter.subtype, "wheeled");
step("an unrelated descriptive edit keeps reports and their ordering");

// Deletion guard: nonterminal work blocks deletion and credentials stay
// usable.
const task = accepted(
  await operator.createTask(await operator.prepareTaskCreation({ assetId: rover.os.assetId, input: moveTo(10, 20) })),
);
const guarded = await operator.deleteEntity(rover.os.assetId);
assert.equal(rejectionCode(guarded, "deletion with nonterminal work"), "nonterminal_tasks");
assert.equal(
  guarded.outcome === "rejected" && JSON.stringify(guarded.rejection.details?.task_ids),
  JSON.stringify([task.id]),
);
await rover.process.receiveWork();
await rover.process.capture(await rover.os.startNext());
await rover.process.capture(await rover.os.progress(task.id, 1));
await rover.process.capture(await rover.os.complete(task.id));
assert.deepEqual(
  (await rover.process.flush()).map((submission) => submission.outcome),
  ["accepted", "accepted", "accepted", "accepted"],
  "rejected deletion leaves the Asset credential usable",
);
step("nonterminal work blocks deletion and leaves credentials usable");

// Report then delete: the report's effects remain in history.
const lastReport = await rover.process.client.prepareComponentReport(
  { components: { telemetry: { position: { latitude: 9, longitude: 9 } } } },
  { kind: "current", observationTimes: { position: { observed_at: new Date().toISOString() } } },
);
acceptedOutcome(await rover.process.client.submitEntityReport(lastReport), "report before deletion");
const deleted = acceptedOutcome(await operator.deleteEntity(rover.os.assetId), "allowed deletion");
assert.match(deleted.commitCursor, /^[1-9][0-9]*$/u);
await assert.rejects(() => operator.getEntity(rover.os.assetId), failsWith("entity_deleted"));
const history = await operator.movementHistory(rover.os.assetId);
assert.equal(history.entity_deleted, true);
assert.equal(history.items.at(-1)?.position?.value.latitude, 9, "retained evidence survives deletion");
assert.equal((await operator.getTask(task.id)).status, "completed", "Task history is retained");

// Delete then report: revoked authority, no effects.
const afterDelete = await rover.process.client.prepareComponentReport(
  { components: { telemetry: { heading_deg: 1 } } },
  { kind: "historical", generatedAt: null, retainedEvidenceId: crypto.randomUUID() },
);
assert.equal(
  rejectionCode(await rover.process.client.submitEntityReport(afterDelete), "report after deletion"),
  "credential_revoked",
);
const health = await direct.request("GET", "/health", { bearer: rover.os.credential });
assert.equal(health.status, 401);
assert.equal(errorCode(health), "credential_revoked");
const replay = await new ReportingProcess(await AssetOS.load(rover.os.file), await installation.link()).client.register(
  rover.os.registration ?? assert.fail(),
);
assert.notEqual(replay.outcome, "accepted", "registration replay cannot undo deletion");
assert.equal(
  (await operator.listEntities()).items.some((entity) => entity.id === rover.os.assetId),
  false,
);
step("allowed deletion revokes credentials, keeps history and cannot be undone by registration replay");

// Assignment against deletion, in both commit orders.
const assignedFirst = await establishedAsset(installation);
const blocker = accepted(
  await operator.createTask(
    await operator.prepareTaskCreation({ assetId: assignedFirst.os.assetId, input: moveTo(1, 1) }),
  ),
);
assert.equal(
  rejectionCode(await operator.deleteEntity(assignedFirst.os.assetId), "assignment first"),
  "nonterminal_tasks",
);
assert.equal((await operator.getTask(blocker.id)).status, "pending");
const deletedFirst = await establishedAsset(installation);
acceptedOutcome(await operator.deleteEntity(deletedFirst.os.assetId), "deletion first");
const late = await operator.createTask(
  await operator.prepareTaskCreation({ assetId: deletedFirst.os.assetId, input: moveTo(1, 1) }),
);
assert.equal(rejectionCode(late, "assignment after deletion"), "entity_deleted");
step("assignment-first blocks deletion; deletion-first rejects assignment");

// Concurrent report and deletion: either the report commits first and
// remains, or deletion commits first and the report is refused.
for (let round = 0; round < 3; round++) {
  const racer = await establishedAsset(installation);
  const racing = await racer.process.client.prepareComponentReport(
    { components: { telemetry: { position: { latitude: 5, longitude: 5 } } } },
    { kind: "current", observationTimes: { position: { observed_at: new Date().toISOString() } } },
  );
  const [reported, removed] = await Promise.all([
    racer.process.client.submitEntityReport(racing),
    operator.deleteEntity(racer.os.assetId),
  ]);
  acceptedOutcome(removed, "racing deletion");
  const samples = (await operator.movementHistory(racer.os.assetId)).items.length;
  if (reported.outcome === "accepted") assert.equal(samples, 1, "report-first effects remain");
  else {
    assert.equal(rejectionCode(reported, "deletion-first"), "credential_revoked");
    assert.equal(samples, 0, "deletion-first report has no effect");
  }
}
step("racing report and deletion commit in one order with all-or-nothing effects");

await installation.restart();
assert.equal(
  rejectionCode(await rover.process.client.submitEntityReport(afterDelete), "revoked after Restart"),
  "credential_revoked",
);
step("revocation survives Restart");

await installation.stop();
