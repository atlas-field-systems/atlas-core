// Stop, Restart and ordinary Reset through the shared private management
// implementation, the real Core container, SQLite and files.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { accepted } from "../../Atlas SDK/src/index.js";
import { AssetOS, ReportingProcess } from "../simulator/index.js";
import {
  acceptedOutcome,
  errorCode,
  establishedAsset,
  failsWith,
  FaultProxy,
  Installation,
  ManageError,
  manageWith,
  moveTo,
  record,
  releaseProbeImage,
  runDirectory,
  step,
  text,
  waitFor,
} from "./support.js";

const run = promisify(execFile);
const installation = await Installation.create();
const started = await installation.start();
const firstDataset = text(started.dataset_id, "Dataset");
const operator = await installation.operator();
const { os, process } = await establishedAsset(installation, { alias: "keeper" });
const task = accepted(
  await operator.createTask(await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(10, 20) })),
);
const deletedAsset = await establishedAsset(installation);
acceptedOutcome(await operator.deleteEntity(deletedAsset.os.assetId), "deletion before Reset");

// Stop and Restart retain the Dataset, credentials and records.
assert.equal((await installation.stop()).outcome, "stopped");
assert.equal((await installation.stop()).outcome, "already_stopped");
const restarted = await installation.start();
assert.equal(restarted.dataset_id, firstDataset);
assert.equal((await operator.getTask(task.id)).status, "pending");
await process.receiveWork();
assert.deepEqual(
  (await process.flush()).map((submission) => submission.outcome),
  ["accepted"],
  "the Asset credential and process authority survive",
);
const restart = await installation.restart();
assert.equal(restart.dataset_id, firstDataset);
assert.equal((await operator.getTask(task.id)).status, "acknowledged");
const lifecycleActions = (await installation.activity()).map((entry) => entry.action);
for (const action of ["core.stop", "core.start", "core.restart"]) assert(lifecycleActions.includes(action), action);
step("Stop/Start/Restart retain the Dataset, credentials, process authority, Tasks and activity");

// Start refuses invalid configuration and an incompatible writing release,
// without conversion or wiping.
await installation.stop();
const settingsFile = join(installation.root, "setup", "core", "config.json");
const settings = await readFile(settingsFile, "utf8");
await writeFile(
  settingsFile,
  settings.replace(/"request_body_limit_bytes": *[0-9]+/u, '"request_body_limit_bytes": 1'),
);
await assert.rejects(() => installation.start(), ManageError, "invalid settings refuse Start");
await writeFile(settingsFile, settings);
// The deployment runs another loaded Core release over the same storage.
const composeFile = join(installation.root, "setup", "compose.json");
const deployment = await readFile(composeFile, "utf8");
const probe = (await run("docker", ["image", "inspect", "--format", "{{.Id}}", releaseProbeImage])).stdout.trim();
await writeFile(composeFile, deployment.replace(/"image": *"[^"]*"/u, `"image": "${probe}"`));
await assert.rejects(() => installation.start(), ManageError, "an incompatible writing release refuses Start");
await writeFile(composeFile, deployment);
assert.equal((await installation.start()).dataset_id, firstDataset);
assert.equal((await operator.getTask(task.id)).status, "acknowledged", "refused Starts preserved the data");
step("invalid settings and an incompatible writing release refuse Start and preserve the Dataset");

// Incomplete Stop is reported and retained until a verified stop.
const shim = join(runDirectory(), "docker-shim");
await mkdir(shim, { recursive: true });
const realDocker = (globalThis.process.env.PATH ?? "")
  .split(":")
  .map((directory) => resolve(directory, "docker"))
  .find((candidate) => existsSync(candidate));
assert(realDocker !== undefined, "docker is on PATH");
await writeFile(
  join(shim, "docker"),
  `#!/bin/sh\ncase " $* " in *" stop "*) echo "injected stop failure" >&2; exit 1;; esac\nexec "${realDocker}" "$@"\n`,
);
await chmod(join(shim, "docker"), 0o755);
const failing = { PATH: `${shim}:${globalThis.process.env.PATH ?? ""}` };
const incomplete = await manageWith(installation, failing, "stop").catch((error: unknown) => error);
assert(incomplete instanceof ManageError);
assert.equal(record(incomplete.result).outcome, "stop_incomplete");
const pending = record(await installation.inspect());
assert(
  Array.isArray(pending.pending_actions) && pending.pending_actions.some((action) => record(action).kind === "stop"),
);
// Core already exited after its private stop request; the verified stop
// confirms that and completes the incomplete record.
assert.equal((await installation.stop()).outcome, "already_stopped");
assert.deepEqual(record(await installation.inspect()).pending_actions, []);
step("an unverified stop is reported incomplete and cleared by a verified stop");

// Reset: an obsolete mutation delayed across Reset is rejected without
// effect; setup, identities and denials are retained.
await installation.start();
const proxy = await FaultProxy.start(installation);
// The delayed request outlives the whole Reset.
const delayedOperator = await installation.operator(proxy.baseUrl, { timeoutMs: 170_000 });
const delayedCreation = await delayedOperator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(11, 20) });
proxy.set("hold");
const delayed = delayedOperator.createTask(delayedCreation);
await proxy.nextHeld();
const oldDescriptor = await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(12, 20) });
const resetAction = crypto.randomUUID();
const reset = await installation.reset(resetAction);
assert.equal(reset.outcome, "completed");
const secondDataset = text(reset.dataset_id, "new Dataset");
assert.notEqual(secondDataset, firstDataset);
proxy.release();
const delayedOutcome = await delayed;
assert.equal(
  delayedOutcome.outcome,
  "dataset_invalidated",
  `Core rejected the delayed obsolete mutation: ${JSON.stringify(delayedOutcome)}`,
);
assert.equal((await operator.createTask(oldDescriptor)).outcome, "dataset_invalidated");
const direct = await installation.direct();
const stale = await direct.request("POST", "/tasks", {
  headers: { "Atlas-Dataset-ID": firstDataset, "Atlas-Protocol-Version": "0.0.0" },
  json: delayedCreation.body,
});
assert.equal(stale.status, 409);
assert.equal(errorCode(stale), "dataset_mismatch");
assert.equal((await operator.discover()).datasetId, secondDataset);
assert.deepEqual((await operator.listTasks()).items, [], "no Task from the old Dataset or the delayed request");
assert.deepEqual((await operator.listEntities()).items, []);
const activity = await installation.activity();
assert.deepEqual(
  activity.map((entry) => entry.action),
  ["core.reset"],
  "pre-Reset activity is not imported",
);
assert.equal(activity[0]?.action_id, resetAction);
assert.deepEqual(
  (await readdir(join(installation.root, "logs"))).filter((name) => name !== "core.log"),
  [],
  "Atlas-managed logs were cleared",
);
step("Reset establishes a new Dataset once; delayed and obsolete submissions are rejected without effect");

// A surviving credential registers again without new enrollment authority; a
// deleted Asset stays denied.
const survivor = await AssetOS.load(os.file);
await survivor.replaceProcess();
const survivorProcess = new ReportingProcess(survivor, await installation.link());
const reRegistered = acceptedOutcome(await survivorProcess.register(), "re-registration in the new Dataset");
assert.equal(reRegistered.status, 201);
assert.notEqual(reRegistered.value.registration.registration_id, os.registration?.body.registration_id);
const claim = acceptedOutcome(await survivorProcess.establish(), "first claim in the new Dataset");
assert.equal(claim.value.report?.authority?.process_generation, "1");
const denied = new ReportingProcess(await AssetOS.load(deletedAsset.os.file), await installation.link());
await assert.rejects(() => denied.register(), failsWith("credential_revoked"), "deletion remains denied after Reset");
await assert.rejects(() => operator.getEntity(deletedAsset.os.assetId), failsWith("not_found"));
step("a surviving credential re-registers without enrollment; a deleted Asset stays denied after Reset");

// Completed Reset results: a lost reply's retry replays without effects;
// another Reset makes the old result no longer retained.
const newWork = accepted(
  await operator.createTask(await operator.prepareTaskCreation({ assetId: survivor.assetId, input: moveTo(13, 20) })),
);
const replayed = await installation.reset(resetAction);
assert.equal(replayed.replayed, true);
assert.equal(replayed.dataset_id, secondDataset);
assert.equal((await operator.getTask(newWork.id)).status, "pending", "a replay erases no new work");
assert.equal(record(record(await installation.inspect()).last_reset).action_id, resetAction);
const nextReset = await installation.reset();
assert.notEqual(nextReset.dataset_id, secondDataset);
const notRetained = await installation.reset(resetAction).catch((error: unknown) => error);
assert(notRetained instanceof ManageError && /result_no_longer_retained/u.test(notRetained.stderr));
assert.equal((await operator.discover()).datasetId, nextReset.dataset_id, "the old retry changed nothing");
step("a completed Reset replays after a lost reply; after another Reset its result is no longer retained");

// Interrupted Reset resumes before serving and establishes once.
const interruptedAction = crypto.randomUUID();
const child = spawn(
  resolve(import.meta.dirname, "../../.artifacts/atlas-manage"),
  ["reset", "--root", installation.root, "--recovery", installation.recovery, "--action-id", interruptedAction],
  { stdio: "ignore" },
);
await waitFor("the pending Reset record", async () =>
  (await readdir(join(installation.recovery, "actions")).catch(() => [] as string[])).some((name) =>
    name.startsWith(interruptedAction),
  )
    ? true
    : undefined,
);
child.kill("SIGKILL");
await new Promise((resolveExit) => child.once("exit", resolveExit));
const inspected = record(await installation.inspect());
const resumed = await installation.start();
assert.equal(resumed.action_id, interruptedAction, "Start resumes the pending Reset");
assert.equal(resumed.outcome, "completed");
const settledDataset = text(resumed.dataset_id, "resumed Dataset");
assert.notEqual(settledDataset, nextReset.dataset_id);
assert.equal((await installation.reset(interruptedAction)).dataset_id, settledDataset, "no second establishment");
assert.equal((await operator.discover()).datasetId, settledDataset);
assert(Array.isArray(inspected.pending_actions));
step("an interrupted Reset resumes on Start, establishes once and replays its result");

await proxy.close();
await installation.stop();
