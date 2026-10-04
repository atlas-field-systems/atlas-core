import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { withFixture } from "./runner.js";
import fixtures from "./fixtures.json" with { type: "json" };

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": "0.2.0" };
let silent: Socket | undefined;
let peerClosed = false;
try {
  const owned = await withFixture(async ({ baseUrl, pid, dataDir }) => {
    const address = new URL(baseUrl);
    const peer = createConnection({ host: address.hostname, port: Number(address.port) });
    silent = peer;
    peer.on("close", () => { peerClosed = true; });
    await new Promise<void>((resolve, reject) => {
      peer.once("connect", resolve);
      peer.once("error", reject);
    });
    // This later real HTTP connection proves the accept loop passed the silent
    // peer. No bytes are sent on that peer, including during normal cleanup.
    const response = await fetch(`${baseUrl}/__fixture/value`, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { dataset_id: dataset, data: fixtures.initial });
    assert.equal(peerClosed, false, "accepted silent peer remains open before fixture shutdown");
    return { pid, dataDir };
  });
  if (!peerClosed) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("silent peer survived fixture shutdown")), 1000);
    assert(silent !== undefined);
    silent.once("close", () => { clearTimeout(timer); resolve(); });
  });
  assert(peerClosed, "fixture shutdown closes its accepted silent peer");
  assert.throws(() => process.kill(owned.pid, 0), { code: "ESRCH" });
  await assert.rejects(access(owned.dataDir), { code: "ENOENT" });
  console.log("PASS accepted silent TCP peer cannot exhaust graceful fixture shutdown; peer/PID/private directory are gone");
} finally { silent?.destroy(); }
