import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { fixture } from "./harness/fixtures.mjs";
import { scenario } from "./harness/scenario.mjs";

scenario("Readiness reports unavailable Object storage while health stays alive", async (s) => {
  const core = await s.startCore();
  const client = s.client(core, core.installation.operatorKey);

  await s.step("A new installation is ready", async () => {
    assert.deepEqual(await client.readiness(), await fixture("readiness"));
  });

  await s.step("Replace the Object directory with a file", async () => {
    const objects = path.join(core.installation.operationalDir, "objects");
    await rm(objects, { recursive: true });
    await writeFile(objects, "blocked");
    s.transcript.note("The private Object directory is now an ordinary file.");
  });

  await s.step("Readiness reports Object storage unavailable", async () => {
    assert.deepEqual(await client.readiness(), {
      status: "unavailable",
      dependencies: { sqlite: "ready", objects: "unavailable" },
    });
  });

  await s.step("Health stays alive", async () => {
    assert.deepEqual(await client.health(), await fixture("health"));
  });
});

scenario("Readiness reports unavailable Dataset storage while health stays alive", async (s) => {
  const core = await s.startCore();
  const client = s.client(core, core.installation.operatorKey);

  await s.step("Remove the Dataset table under the running Core", async () => {
    const database = new DatabaseSync(path.join(core.installation.operationalDir, "operational.sqlite"));
    database.exec("DROP TABLE dataset");
    database.close();
    s.transcript.note("The operational database no longer has a dataset table.");
  });

  await s.step("Readiness reports SQLite unavailable", async () => {
    assert.deepEqual(await client.readiness(), {
      status: "unavailable",
      dependencies: { sqlite: "unavailable", objects: "ready" },
    });
  });

  await s.step("Health stays alive", async () => {
    assert.deepEqual(await client.health(), await fixture("health"));
  });
});
