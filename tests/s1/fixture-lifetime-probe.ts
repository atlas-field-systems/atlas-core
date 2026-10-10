import { readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ownedFixtureRoot, temporaryTLS } from "./tls.js";

const marker = process.argv[2];
if (!marker) throw new Error("TLS lifetime probe requires a readiness marker");
const root = ownedFixtureRoot(process.argv);
await using tls = await temporaryTLS(root);
if (tls.key.byteLength === 0 || tls.certificate.byteLength === 0) throw new Error("TLS fixture has no material");
const directories = await readdir(root);
if (directories.length !== 1 || !directories[0]?.startsWith("atlas-s1-tls-"))
  throw new Error("TLS fixture escaped its supplied root");
process.on("SIGTERM", () => {});
await writeFile(
  `${marker}.pending`,
  JSON.stringify({ workerPid: process.pid, privateRoot: root, tlsDirectory: join(root, directories[0]) }),
);
await rename(`${marker}.pending`, marker);
// The surviving runner must clean the real keys after stopping this worker.
setInterval(() => {}, 1000);
await new Promise(() => {});
