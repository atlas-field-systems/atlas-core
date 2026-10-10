import assert from "node:assert/strict";
import { createAtlasClient } from "../../Atlas SDK/src/client.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let mutations = 0;
const client = createAtlasClient({
  baseUrl: "https://core.invalid",
  credential: () => "caller-owned-credential",
  fetch: async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    if (request.method === "POST") {
      mutations++;
      throw new Error("response lost after transmission began");
    }
    return new Response(
      JSON.stringify({
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
      }),
      {
        headers: { "Content-Type": "application/json", "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": "0.1.0" },
      },
    );
  },
});
assert.equal((await client.discover()).outcome, "accepted");
const descriptor = client.prepareTask({
  asset_id: "11111111-1111-4111-8111-111111111111",
  idempotency_key: "22222222-2222-4222-8222-222222222222",
  command: "move_to",
  input: { target: { kind: "position", position: { latitude: 10, longitude: 20 } } },
});
const result = await client.submit(descriptor);
assert.equal(result.outcome, "unknown_outcome");
assert.equal(mutations, 1, "unknown outcomes never cause implicit resubmission");
assert.deepEqual(
  client.restoreMutation(JSON.parse(JSON.stringify(descriptor))),
  descriptor,
  "restoration retains original facts and identity",
);
console.log("PASS SDK lost response preserves descriptor and makes one transmission");
