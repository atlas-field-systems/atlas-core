import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { createAssetClient } from "../../Atlas SDK/src/asset.js";
import { createAtlasClient } from "../../Atlas SDK/src/client.js";

const assetId = "11111111-1111-4111-8111-111111111111";
const processId = "22222222-2222-4222-8222-222222222222";
const transferId = "33333333-3333-4333-8333-333333333333";
const datasetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const processKey = generateKeyPairSync("ed25519");
const recovery = generateKeyPairSync("ed25519");
let processFacts: Uint8Array | undefined;
let replacementFacts: Uint8Array | undefined;
const client = createAtlasClient({
  baseUrl: "https://core.invalid",
  credential: () => "retained-secret",
  fetch: async () =>
    new Response(
      JSON.stringify({
        dataset_id: datasetId,
        read_context: { source: "http", commit_cursor: "1" },
        data: {
          live: true,
          core_release: "0.1.0",
          supported_protocol_versions: ["0.1.0"],
          server_time: "2026-10-09T10:00:00Z",
          open_enrollment: false,
          open_enrolled_identity_count: 0,
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Atlas-Dataset-ID": datasetId,
          "Atlas-Protocol-Version": "0.1.0",
        },
      },
    ),
});
assert.equal((await client.discover()).outcome, "accepted");
const asset = createAssetClient({
  client,
  assetId,
  signer: {
    processId,
    publicKey: processKey.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url"),
    sign: async (bytes) => {
      processFacts = bytes;
      return sign(null, bytes, processKey.privateKey);
    },
  },
  authorizer: {
    authorize: async (bytes) => {
      replacementFacts = bytes;
      return sign(null, bytes, recovery.privateKey);
    },
  },
});
const first = await asset.prepareAuthority({
  expectedGeneration: "0",
  transferId,
  generatedAt: "2026-10-09T12:00:00.123400+02:00",
  components: { telemetry: { position: { latitude: 10, longitude: 20 } } },
  observationTimes: { position: { observed_at: "2026-10-09T11:59:59.5000+02:00" } },
});
assert.equal(first.body.report_context.generated_at, "2026-10-09T12:00:00.123400+02:00");
assert.equal(first.body.report_context.observation_times?.position?.observed_at, "2026-10-09T11:59:59.5000+02:00");
assert.equal(first.body.report_context.sequence, "1");
assert.equal(first.body.report_context.process_generation, "1");
assert(processFacts && replacementFacts);
assert(
  verify(null, processFacts, processKey.publicKey, Buffer.from(first.body.report_context.process_proof, "base64url")),
);
assert(first.body.authority_claim);
assert(
  verify(
    null,
    replacementFacts,
    recovery.publicKey,
    Buffer.from(first.body.authority_claim.recovery_proof, "base64url"),
  ),
);
const signed = JSON.parse(new TextDecoder().decode(processFacts));
assert.equal("authority_claim" in signed.payload, false, "process signing has no circular authority proof input");
assert.equal("process_proof" in signed.report_context, false);
assert.equal(signed.target_id, assetId);
assert.equal(signed.kind, "checkin");
assert.deepEqual(client.restoreMutation(JSON.parse(JSON.stringify(first))), first);
assert.equal(asset.snapshot().nextSequence, "2", "one shared sequence reserved before transmission");
console.log("PASS Asset externally owned Ed25519 keys sign retained original source facts");
