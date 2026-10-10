import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:https";
import test from "node:test";
import { createAtlasClient } from "../../Atlas SDK/src/index.js";
import { createHTTPSFetch } from "../../Atlas SDK/src/node.js";
import { ownedFixtureRoot, temporaryTLS } from "./tls.js";
import { assetId, datasetId, asset } from "./fixtures.js";

test("bootstrap registration uses the prepared Asset credential and retains a lost reply", async () => {
  await using tls = await temporaryTLS(ownedFixtureRoot(process.argv));
  const bodies: string[] = [];
  await using server = createServer({ key: tls.key, cert: tls.certificate }, async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer asset-owned-secret");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString());
    if (bodies.length === 1) {
      response.destroy();
      return;
    }
    response.writeHead(201, {
      "Content-Type": "application/json",
      "Atlas-Dataset-ID": datasetId,
      "Atlas-Protocol-Version": "0.1.0",
    });
    response.end(
      JSON.stringify({
        dataset_id: datasetId,
        commit_cursor: "1",
        data: {
          entity: asset,
          association: {
            registration_id: "22222222-2222-4222-8222-222222222222",
            asset_id: assetId,
            principal_id: "33333333-3333-4333-8333-333333333333",
            credential_id: "44444444-4444-4444-8444-444444444444",
          },
        },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const client = createAtlasClient({
    baseUrl: `https://127.0.0.1:${address.port}`,
    bootstrapContext: { datasetId, protocolVersion: "0.1.0" },
    credential: () => "asset-owned-secret",
    fetch: createHTTPSFetch({ ca: tls.certificate, maxJSONBytes: 8192, timeoutMs: 2000 }),
  });
  assert.deepEqual(await client.getEntity(assetId), { outcome: "not_submitted", reason: "not_discovered" });
  const retained = client.prepareRegistration({
    id: assetId,
    type: "asset",
    registration_id: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal((await client.submit(retained)).outcome, "unknown_outcome");
  const accepted = await client.submit(client.restoreMutation(JSON.parse(JSON.stringify(retained))));
  assert.equal(accepted.outcome, "accepted");
  assert.equal(bodies.length, 2);
  assert.equal(
    bodies[0],
    bodies[1],
    "explicit registration retry sends original facts without reidentifying or changing secret",
  );
  server.closeAllConnections();
});
