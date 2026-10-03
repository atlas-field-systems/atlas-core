import { writeFile } from "node:fs/promises";
import { withFixture } from "./runner.js";

const mode = process.argv[2];
const marker = process.argv[3];
if (!marker || !["async", "blocked", "startup"].includes(mode ?? "")) throw new Error("timeout probe requires mode and marker");
await withFixture(async ({ pid, dataDir, baseUrl, sqliteVersion, journalMode }) => {
  const response = await fetch(`${baseUrl}/__fixture/value`, { headers: {
    "Atlas-Dataset-ID": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Atlas-Protocol-Version": "0.2.0",
  }, signal: AbortSignal.timeout(5000) });
  if (response.status !== 200) throw new Error("fixture was not serving before timeout");
  await writeFile(marker, JSON.stringify({ pid, dataDir, sqliteVersion, journalMode }));
  if (mode === "blocked") { while (true) { /* Controlled unresponsive test worker. */ } }
  await new Promise(() => {});
}, mode === "startup" ? { mode: "missing_readiness", startupMs: 5000 } : {});
