// Task admission and order, Asset-reported execution, generic failure,
// dropped Command support and cancellation through real Core, the SDK and the
// simulator.
import assert from "node:assert/strict";
import { accepted, type Page } from "../../Atlas SDK/src/index.js";
import {
  acceptedOutcome,
  directProtocol,
  errorCode,
  establishedAsset,
  moveTo,
  newInstallation,
  rejectionCode,
  step,
} from "./support.js";

const installation = await newInstallation();
await installation.start();
const operator = await installation.operator();
const direct = await directProtocol(installation);
await direct.discover();

const { os, process } = await establishedAsset(installation, { alias: "tasker" });
const taskCount = async () => (await operator.listTasks({ limit: 1000 })).items.length;
const issueActivity = async () =>
  (await installation.activity()).filter((entry) => entry.action === "task.issue").length;

// Admission rejects unsupported or invalid input before creating anything.
const baselineTasks = await taskCount();
const baselineActivity = await issueActivity();
const createDirect = (body: Record<string, unknown>) =>
  direct.request("POST", "/tasks", { headers: direct.context(), json: { request_id: crypto.randomUUID(), ...body } });
for (const [name, body, status, code] of [
  ["latitude above 90", { asset_id: os.assetId, input: moveTo(91, 20) }, 400, "invalid_request"],
  ["longitude below -180", { asset_id: os.assetId, input: moveTo(10, -181) }, 400, "invalid_request"],
  [
    "missing longitude",
    { asset_id: os.assetId, input: { command: "move_to", target: { kind: "position", position: { latitude: 10 } } } },
    400,
    "invalid_request",
  ],
  [
    "immediate scheduling",
    { asset_id: os.assetId, scheduling: "immediate", input: moveTo(10, 20) },
    400,
    "unsupported_scheduling",
  ],
  [
    "point Geofeature target",
    {
      asset_id: os.assetId,
      input: { command: "move_to", target: { kind: "geofeature", geofeature_id: crypto.randomUUID() } },
    },
    400,
    "unsupported_target",
  ],
  [
    "start deadline",
    { asset_id: os.assetId, input: { ...moveTo(10, 20), deadline: "2026-10-10T12:00:00Z" } },
    400,
    "invalid_request",
  ],
  [
    "start-by on the request",
    { asset_id: os.assetId, start_by: "2026-10-10T12:00:00Z", input: moveTo(10, 20) },
    400,
    "invalid_request",
  ],
  ["unregistered Asset", { asset_id: crypto.randomUUID(), input: moveTo(10, 20) }, 400, "unknown_asset"],
] as const) {
  const response = await createDirect(body);
  assert.equal(response.status, status, name);
  assert.equal(errorCode(response), code, name);
}
const sdkInvalid = await operator.createTask(
  await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(10, 20), scheduling: "immediate" }),
);
assert.equal(rejectionCode(sdkInvalid, "SDK immediate scheduling"), "unsupported_scheduling");
const unsupported = await establishedAsset(installation, { commandManifest: [] });
const noSupport = await operator.createTask(
  await operator.prepareTaskCreation({ assetId: unsupported.os.assetId, input: moveTo(10, 20) }),
);
assert.equal(rejectionCode(noSupport, "missing Command support"), "command_not_supported");
assert.equal(await taskCount(), baselineTasks, "rejections create no Task");
assert.equal(await issueActivity(), baselineActivity, "rejections record no issuance");
step(
  "invalid coordinates, half positions, immediate/Geofeature/deadline inputs, missing support and unknown Assets reject before creation",
);

// Request identity: identical retry replays; changed facts conflict.
const first = await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(10, 20) });
const created = acceptedOutcome(await operator.createTask(first), "first creation");
assert.equal(created.status, 201);
const replay = acceptedOutcome(await operator.createTask(first), "replay");
assert.equal(replay.status, 200);
assert.equal(replay.value.id, created.value.id);
assert.equal(replay.commitCursor, created.commitCursor, "a replay returns the original commit cursor");
const conflict = await operator.createTask({ ...first, body: { ...first.body, input: moveTo(11, 20) } });
assert.equal(rejectionCode(conflict, "changed creation facts"), "request_conflict");
const directReplay = await direct.request("POST", "/tasks", { headers: direct.context(), json: first.body });
assert.equal(directReplay.status, 200);
assert.equal(directReplay.body !== undefined && JSON.stringify(directReplay.body).includes(created.value.id), true);
step("identical creation retries replay one Task and cursor; changed facts conflict");

// Default requested order follows accepted submission order.
const second = accepted(
  await operator.createTask(await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(10.001, 20) })),
);
const third = accepted(
  await operator.createTask(await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(10.002, 20) })),
);
assert.deepEqual(
  [created.value, second, third].map((task) => task.submission_sequence),
  ["1", "2", "3"],
);
const entity = await operator.getEntity(os.assetId);
assert.deepEqual(entity.task_queue?.requested_task_ids, [created.value.id, second.id, third.id]);
assert.equal(entity.task_queue?.confirmed_revision, null, "creation never confirms adoption");
assert.deepEqual(entity.task_queue?.confirmed_task_ids, []);
const work = await process.receiveWork();
assert.deepEqual(
  work.tasks.map((task) => task.id),
  [created.value.id, second.id, third.id],
);
const paged = await operator.fetchAssignedTasks(os.assetId, { outstanding: true, limit: 1 });
assert.deepEqual(
  paged.tasks.map((task) => task.id),
  [created.value.id, second.id, third.id],
  "pagination keeps one pinned queue revision",
);
assert.equal((await operator.getEntity(os.assetId)).task_queue?.confirmed_revision, null, "reading confirms nothing");
step("submission sequence and default requested order; listing assigned work confirms no adoption");

// Lists page from one boundary without gaps or duplicates.
const pages = async <T extends { id: string }>(read: (token?: string) => Promise<Page<T>>) => {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const page = await read(token);
    ids.push(...page.items.map((item) => item.id));
    token = page.nextPageToken ?? undefined;
  } while (token !== undefined);
  return ids;
};
const allTasks = (await operator.listTasks({ limit: 1000 })).items.map((task) => task.id);
assert(allTasks.length >= 3);
assert.deepEqual(
  await pages((token) => operator.listTasks({ limit: 1, ...(token === undefined ? {} : { page_token: token }) })),
  allTasks,
);
const allEntities = (await operator.listEntities({ limit: 1000 })).items.map((item) => item.id);
assert.equal(allEntities.length, 2);
assert.deepEqual(
  await pages((token) => operator.listEntities({ limit: 1, ...(token === undefined ? {} : { page_token: token }) })),
  allEntities,
);
step("Entity and Task lists page one item at a time without gaps or duplicates");

// Execution: completion is accepted with older or outside telemetry; it
// needs no Object.
await process.capture(await os.startNext());
await process.capture(
  await os.observe({ position: { latitude: 45, longitude: 45 } }, { position: "2026-01-01T00:00:00Z" }),
);
await process.capture(await os.progress(created.value.id, 3));
await process.capture(await os.complete(created.value.id));
await process.flush();
const completed = await operator.getTask(created.value.id);
assert.equal(completed.status, "completed", "Core does not compare the Asset's arrival with telemetry");
assert.equal(completed.failure, undefined);
step("Asset-reported completion is recorded with old, distant telemetry and no Object");

// Generic failure is the Asset's typed report.
await process.capture(await os.startNext());
await process.capture(await os.fail(second.id, { code: "execution_failed", message: "drive fault" }));
await process.flush();
const failed = await operator.getTask(second.id);
assert.equal(failed.status, "failed");
assert.deepEqual(failed.failure, { code: "execution_failed", message: "drive fault" });

// Status error alone never changes a Task outcome.
await process.capture(await os.startNext());
await process.capture(await os.reportStatus({ value: "error", reason: "sensor fault" }));
await process.flush();
assert.equal((await operator.getTask(third.id)).status, "in_progress");
assert.equal((await operator.getAssetStatus(os.assetId)).value, "error");
step("typed Asset failure recorded; status error leaves the running Task in progress");

// Dropping Command support keeps outstanding work, which the Asset may fail
// as unsupported; new admission is rejected.
await os.advertise([]);
const dropped = await process.client.prepareComponentReport({ command_manifest: [] });
acceptedOutcome(await process.client.submitEntityReport(dropped), "dropped support");
assert.equal((await operator.getTask(third.id)).status, "in_progress", "outstanding work is kept");
assert.equal(
  rejectionCode(
    await operator.createTask(await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(10, 20) })),
    "admission after dropped support",
  ),
  "command_not_supported",
);
await process.capture(await os.fail(third.id, { code: "unsupported", message: "Move To no longer supported" }));
await process.flush();
assert.deepEqual((await operator.getTask(third.id)).failure, {
  code: "unsupported",
  message: "Move To no longer supported",
});
step("dropped support keeps outstanding work, permits its unsupported failure and rejects new admission");

await installation.stop();
