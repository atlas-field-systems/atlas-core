// Registration and process authority through real Core, the SDK Asset client
// and the simulator: distinct bound Assets, concurrent and conflicting
// registration, lost replies with process replacement, atomic claims,
// concurrent replacement and obsolete processes.
import assert from "node:assert/strict";
import { AssetClient, AtlasError } from "../../Atlas SDK/src/index.js";
import { AssetOS, prepareAsset, processSigner, recoveryAuthority, ReportingProcess } from "../simulator/index.js";
import {
  acceptedOutcome,
  FaultProxy,
  Installation,
  rejectionCode,
  requestTimeoutMs,
  runDirectory,
  step,
} from "./support.js";

const installation = await Installation.create();
await installation.start();
const operator = await installation.operator();
const fetch = await installation.fetch();
const direct = { baseUrl: installation.baseUrl, fetch, requestTimeoutMs };
const authorize = (assetId: string, key: string) => installation.authorizeEnrollment(assetId, key);
const proxy = await FaultProxy.start(installation);
const lossy = { baseUrl: proxy.baseUrl, fetch, requestTimeoutMs };

// Registration retries after a lost reply, across reporting-process
// replacement, return the one association and never reset later reports.
const first = await prepareAsset(runDirectory(), authorize, { alias: "first" });
proxy.set("drop_response");
const lost = await new ReportingProcess(first, lossy).register();
assert.equal(lost.outcome, "unknown_outcome", "the registration reply is lost after Core answered");
proxy.set("pass");
const restored = await AssetOS.load(first.file);
assert.notEqual(restored.registration, null, "the descriptor was retained before first transmission");
await restored.replaceProcess();
const replacement = new ReportingProcess(restored, direct);
const replayed = acceptedOutcome(await replacement.register(), "registration replay");
assert.equal(replayed.status, 200, "an identical retry replays");
assert.equal(replayed.value.registration.registration_id, restored.registration?.body.registration_id);
acceptedOutcome(
  await replacement.establish({ components: { status: { value: "ready", reason: null } } }),
  "first claim",
);
const again = acceptedOutcome(await replacement.client.register(restored.registration ?? assert.fail()), "late retry");
assert.equal(again.status, 200);
assert.equal(again.value.entity.components.status.value, "ready", "a late retry returns current state");
assert.equal((await operator.listEntities()).items.length, 1, "one association");
step("lost registration reply and process replacement replay one association without resetting later reports");

// Two distinct Assets, each with its own credential; concurrent identical
// registration commits once; conflicting identities are refused.
const second = await prepareAsset(runDirectory(), authorize, { alias: "second" });
const secondProcess = new ReportingProcess(second, direct);
await secondProcess.client.client.discover();
const secondDescriptor = await secondProcess.client.prepareRegistration({
  alias: "second",
  credential: second.credential,
});
const concurrent = await Promise.all([
  secondProcess.client.register(secondDescriptor),
  new AssetClient({
    ...direct,
    assetId: second.assetId,
    credential: second.credential,
    enrollmentToken: second.enrollmentToken ?? assert.fail(),
    signer: processSigner(second.reporting.key),
  }).register(secondDescriptor),
]);
const statuses = concurrent.map((outcome) => acceptedOutcome(outcome, "concurrent registration").status).sort();
assert.deepEqual(statuses, [200, 201], "one creation and one replay");
await second.registrationAccepted();
const secondEntity = await operator.getEntity(second.assetId);
assert.deepEqual(secondEntity.command_manifest, [], "omitted Command support is empty");
assert.equal(secondEntity.components.telemetry, undefined);
assert.deepEqual(secondEntity.reporting, {}, "no generation, report or Contact before a claim");
assert.equal(secondEntity.components.heartbeat.last_seen, null);

const impostor = await AssetOS.create(`${first.file}.impostor`, { assetId: second.assetId });
await impostor.authorizeEnrollment(await authorize(impostor.assetId, impostor.recoveryKey.publicKey));
const impostorProcess = new ReportingProcess(impostor, direct);
assert.equal(
  rejectionCode(await impostorProcess.register(), "second enrollment of a bound Asset ID"),
  "identity_conflict",
);
const conflicting = await secondProcess.client.register({
  ...secondDescriptor,
  body: { ...secondDescriptor.body, alias: "renamed" },
});
assert.equal(rejectionCode(conflicting, "changed registration facts"), "request_conflict");
assert.equal((await operator.getEntity(second.assetId)).alias, "second");
step("two distinct bound Assets; concurrent identical registration commits once; conflicts change nothing");

// A report before any claim has no process authority: the SDK refuses to
// prepare one, and Core refuses one claiming an unissued generation.
await assert.rejects(
  () => secondProcess.client.prepareStatusReport({ value: "ready", reason: null }),
  (error: unknown) => error instanceof AtlasError && error.code === "process_authority_required",
);
const unissued = new AssetClient({
  ...direct,
  assetId: second.assetId,
  credential: second.credential,
  signer: processSigner(second.reporting.key),
  processGeneration: "1",
});
const unclaimed = await unissued.prepareComponentReport(
  { components: { telemetry: { heading_deg: 10 } } },
  { kind: "historical", generatedAt: null, retainedEvidenceId: crypto.randomUUID() },
);
assert.equal(
  rejectionCode(await unissued.submitEntityReport(unclaimed), "unclaimed report"),
  "process_authority_required",
);

// A claim refused for its recovery proof establishes nothing.
const forged = await AssetOS.create(`${second.file}.forged`);
const forgedProcess = new AssetClient({
  ...direct,
  assetId: second.assetId,
  credential: second.credential,
  signer: processSigner(second.reporting.key),
});
const forgedClaim = await forgedProcess.prepareCheckIn(
  { components: { status: { value: "ready", reason: null } } },
  {
    claim: {
      descriptor: forgedProcess.prepareClaim("0"),
      recovery: recoveryAuthority(forged.recoveryKey),
    },
  },
);
const before = await operator.getEntity(second.assetId);
assert.equal(
  rejectionCode(await forgedProcess.submitEntityReport(forgedClaim), "claim with a foreign recovery key"),
  "invalid_recovery_proof",
);
assert.deepEqual(await operator.getEntity(second.assetId), before, "a refused claim leaves no generation or effects");
acceptedOutcome(await secondProcess.establish(), "authorized first claim");
assert.equal(second.expectedGeneration((await operator.discover()).datasetId), "1");
step(
  "unclaimed reports need authority; a refused claim changes nothing; the authorized claim establishes generation 1",
);

// Cross-Asset reports are refused on every report route.
const crossAsset = new AssetClient({
  ...direct,
  assetId: first.assetId,
  credential: second.credential,
  signer: processSigner(second.reporting.key),
  processGeneration: "1",
});
const historical = () => ({ kind: "historical" as const, generatedAt: null, retainedEvidenceId: crypto.randomUUID() });
for (const descriptor of [
  await crossAsset.prepareComponentReport({ components: { telemetry: { heading_deg: 1 } } }, historical()),
  await crossAsset.prepareStatusReport({ value: "error", reason: "spoofed" }, historical()),
]) {
  assert.equal(rejectionCode(await crossAsset.submitEntityReport(descriptor), descriptor.operation), "forbidden");
}
step("another Asset's credential cannot report on its behalf");

// Concurrent replacements: one winner. The loser and the obsolete process
// cannot report or reclaim; the winner's lost reply replays.
const obsolete = secondProcess;
// Each contender is a separate replacement process with its own key,
// prepared before either submits; both use the Asset's recovery authority.
const contenders: { client: AssetClient; descriptor: Awaited<ReturnType<AssetClient["prepareCheckIn"]>> }[] = [];
for (let index = 0; index < 2; index++) {
  const key = (await AssetOS.create(`${second.file}.contender-${index}`)).reporting.key;
  const client = new AssetClient({
    ...direct,
    assetId: second.assetId,
    credential: second.credential,
    signer: processSigner(key),
  });
  const descriptor = await client.prepareCheckIn(
    {},
    { claim: { descriptor: client.prepareClaim("1"), recovery: recoveryAuthority(second.recoveryKey) } },
  );
  contenders.push({ client, descriptor });
}
const decisions = await Promise.all(contenders.map(({ client, descriptor }) => client.submitEntityReport(descriptor)));
const winners = decisions.filter((outcome) => outcome.outcome === "accepted");
assert.equal(winners.length, 1, "exactly one replacement wins");
const loser = decisions.find((outcome) => outcome.outcome !== "accepted");
assert.equal(rejectionCode(loser ?? assert.fail(), "losing replacement"), "generation_conflict");
assert.equal(winners[0]?.outcome === "accepted" && winners[0].value.report?.authority?.process_generation, "2");

const stale = await obsolete.client.prepareComponentReport(
  { components: { telemetry: { heading_deg: 5 } } },
  { kind: "historical", generatedAt: null, retainedEvidenceId: crypto.randomUUID() },
);
assert.equal(rejectionCode(await obsolete.client.submitEntityReport(stale), "obsolete report"), "obsolete_process");
const reclaim = await obsolete.client.prepareCheckIn(
  {},
  { claim: { descriptor: obsolete.client.prepareClaim("1"), recovery: recoveryAuthority(second.recoveryKey) } },
);
assert.equal(rejectionCode(await obsolete.client.submitEntityReport(reclaim), "old hello"), "generation_conflict");
const winner = contenders[decisions.indexOf(winners[0] ?? assert.fail())] ?? assert.fail();
const borrowed = new AssetClient({
  ...direct,
  assetId: second.assetId,
  credential: second.credential,
  signer: processSigner(second.reporting.key),
  processGeneration: "2",
  nextSequence: "50",
});
const wrongKey = await borrowed.prepareComponentReport(
  { components: { telemetry: { heading_deg: 6 } } },
  { kind: "historical", generatedAt: null, retainedEvidenceId: crypto.randomUUID() },
);
assert.equal(rejectionCode(await borrowed.submitEntityReport(wrongKey), "old key"), "invalid_process_proof");
step("concurrent replacement has one winner; obsolete generation, old hello and old key cannot report or reclaim");

const lostClaimOS = await AssetOS.load(second.file);
await lostClaimOS.generationEstablished("2", (await operator.discover()).datasetId);
await lostClaimOS.replaceProcess();
proxy.set("drop_response");
const lostClaim = await new ReportingProcess(lostClaimOS, lossy).establish();
assert.equal(lostClaim.outcome, "unknown_outcome");
proxy.set("pass");
const retried = acceptedOutcome(await new ReportingProcess(lostClaimOS, direct).establish(), "lost claim retry");
assert.equal(retried.value.report?.disposition, "duplicate");
assert.equal(retried.value.report?.authority?.process_generation, "3");
const afterLost = await winner.client.prepareComponentReport(
  { components: { telemetry: { heading_deg: 7 } } },
  { kind: "historical", generatedAt: null, retainedEvidenceId: crypto.randomUUID() },
);
assert.equal(rejectionCode(await winner.client.submitEntityReport(afterLost), "replaced winner"), "obsolete_process");
step("a lost winning claim reply replays its generation and authority");

await proxy.close();
await installation.stop();
