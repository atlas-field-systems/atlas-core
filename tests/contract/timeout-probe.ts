import { rename, writeFile } from "node:fs/promises";
import { withFixture } from "./runner.js";
import { headers, timedFetch } from "./support.js";

const mode = process.argv[2] ?? process.env.ATLAS_CONTRACT_PROBE_MODE;
const marker = process.argv[3] ?? process.env.ATLAS_CONTRACT_PROBE_MARKER;
if (!marker || !["async", "blocked", "startup"].includes(mode ?? "")) throw new Error("timeout probe requires mode and marker");
await withFixture(async ({ pid, dataDir, baseUrl, sqliteVersion, journalMode }) => {
  const response = await timedFetch(`${baseUrl}/__fixture/value`, { headers });
  if (response.status !== 200) throw new Error("fixture was not serving before timeout");
  if (mode === "blocked") process.on("SIGTERM", () => {});
  await writeFile(`${marker}.pending`, JSON.stringify({ pid, dataDir, sqliteVersion, journalMode, workerPid: process.pid }));
  await rename(`${marker}.pending`, marker);
  if (mode === "blocked") { while (true) { /* Controlled worker requires the supervisor's hard stop. */ } }
  await new Promise(() => {});
}, mode === "startup" ? { mode: "missing_readiness", startupMs: 5000 } : {});
