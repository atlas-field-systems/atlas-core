import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { withFixture } from "./runner.js";
import { assertPathRemoved, assertProcessGone, dataset, headers, timedFetch, within } from "./support.js";
import fixtures from "./fixtures.json" with { type: "json" };

for (const mode of ["immediate cleanup", "peer expires before GET"]) {
  let silent: Socket | undefined;
  let peerClosed = false;
  try {
    const owned = await withFixture(async ({ baseUrl, pid, dataDir }) => {
      const address = new URL(baseUrl);
      const peer = createConnection({ host: address.hostname, port: Number(address.port) });
      silent = peer;
      peer.on("close", () => {
        peerClosed = true;
      });
      await new Promise<void>((resolve, reject) => {
        peer.once("connect", resolve);
        peer.once("error", reject);
      });
      if (mode === "peer expires before GET") {
        // A delayed barrier can legitimately observe the peer already expired.
        await once(peer, "close", { signal: AbortSignal.timeout(6000) });
      }
      // This later real HTTP connection proves the accept loop passed the silent
      // peer. No bytes are sent on that peer, including during normal cleanup.
      const response = await timedFetch(`${baseUrl}/__fixture/value`, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { dataset_id: dataset, data: fixtures.initial });
      return { pid, dataDir };
    });
    if (!peerClosed) {
      assert(silent !== undefined);
      await within(once(silent, "close"), 1000, "silent peer survived fixture shutdown");
    }
    assert(peerClosed, "accepted silent peer is closed after fixture shutdown");
    assertProcessGone(owned.pid);
    await assertPathRemoved(owned.dataDir);
    console.log(
      `PASS ${mode}: accepted silent peer permits graceful fixture shutdown; peer/PID/private directory are gone`,
    );
  } finally {
    silent?.destroy();
  }
}
