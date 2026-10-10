import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PreparedStatusReport } from "../../Atlas SDK/src/index.js";
import { openReportingRuntime } from "../../examples/s1/reporting-runtime.js";

test("runtime retains keys and exact pending descriptors before replacing a process", async () => {
  const index = process.argv.indexOf("--owned-root");
  const directory = await mkdtemp(
    join(index < 0 ? tmpdir() : (process.argv[index + 1] ?? tmpdir()), "atlas-reporting-"),
  );
  await using _cleanup = { [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }) };
  const assetId = "11111111-1111-4111-8111-111111111111";
  const first = await openReportingRuntime(directory, assetId);
  const retainedSecret = first.credential();
  const signer = first.signer();
  const bytes = Buffer.from("independently retained report bytes");
  const signature = await signer.sign(bytes);
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: signer.publicKey }, format: "jwk" });
  assert(verify(null, bytes, publicKey, signature));
  const descriptor: PreparedStatusReport = {
    format: 1,
    operation: "status_report",
    datasetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    protocolVersion: "0.1.0",
    targetId: assetId,
    body: {
      status: { value: "ready", reason: null },
      report_context: {
        asset_id: assetId,
        process_generation: "1",
        sequence: "9",
        generated_at: "2026-10-10T00:00:00.500+00:00",
        evidence_kind: "current",
        evidence_origin: null,
        retained_evidence_id: null,
        contact_challenge: null,
        process_proof: Buffer.from(signature).toString("base64url"),
      },
    },
  };
  const id = await first.retain(descriptor, { processGeneration: "1", nextSequence: "10" });
  const restored = await openReportingRuntime(directory, assetId);
  assert.equal(restored.credential(), retainedSecret);
  assert.deepEqual(restored.pending(), [{ id, descriptor }]);
  assert.deepEqual(restored.reportState(), {
    assetId,
    processId: signer.processId,
    processGeneration: "1",
    nextSequence: "10",
  });
  const recoveryBefore = await restored.authorizer().authorize(bytes);
  await restored.replaceProcess();
  assert.notEqual(restored.signer().publicKey, signer.publicKey);
  assert.deepEqual(await restored.authorizer().authorize(bytes), recoveryBefore);
  assert.deepEqual(restored.pending(), [{ id, descriptor }]);
  const again = await openReportingRuntime(directory, assetId);
  assert.deepEqual(again.pending(), [{ id, descriptor }]);
  await again.acknowledge(id);
  assert.deepEqual((await openReportingRuntime(directory, assetId)).pending(), []);
  assert.equal((await stat(join(directory, "reporter.json"))).mode & 0o777, 0o600);
  const path = join(directory, "reporter.json");
  const intact = await readFile(path);
  const secret = "PRIVATE_CREDENTIAL_MUST_NOT_APPEAR_IN_DIAGNOSTICS";
  await writeFile(path, `{"credential":"${secret}" invalid}`);
  await assert.rejects(openReportingRuntime(directory, assetId), (error) => {
    assert(error instanceof Error);
    assert(!error.stack?.includes(secret));
    assert.match(error.message, /explicit repair/u);
    return true;
  });
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(openReportingRuntime(directory, assetId), /bound/u);
  await writeFile(path, intact);
  assert.equal((await openReportingRuntime(directory, assetId)).credential(), retainedSecret);
});
