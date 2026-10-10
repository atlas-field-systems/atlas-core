// Runnable setup and trust: genuine HTTPS trust, wrong CA, wrong hostname and
// expired certificates fail without bypass or plaintext fallback; protected
// documentation; edition negotiation and Dataset boundaries; secrets stay out
// of arguments, logs, records and public responses; and the documented demo
// runs with internet disabled.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AtlasClient } from "../../Atlas SDK/src/index.js";
import { nodeFetch } from "../../Atlas SDK/src/node.js";
import {
  DirectProtocol,
  directProtocol,
  errorCode,
  establishedAsset,
  failsWith,
  freePort,
  manage,
  newInstallation,
  record,
  requestTimeoutMs,
  runDirectory,
  step,
} from "./support.js";

const run = promisify(execFile);
const installation = await newInstallation();
const outputs: unknown[] = [await installation.start()];
const operator = await installation.operator();
const direct = await directProtocol(installation);

// Protected documentation: the anonymous shell exposes no schema; the raw
// document requires authentication.
const docs = await direct.request("GET", "/docs", { bearer: null });
assert.equal(docs.status, 401, "anonymous callers receive only the key-entry shell");
assert.match(docs.headers["content-type"] ?? "", /^text\/html/u);
for (const fragment of ['"paths"', "/entities/{", "TaskCreate", "components", "schemas", "move_to"]) {
  assert(!docs.raw.toString("utf8").includes(fragment), `anonymous docs omit ${fragment}`);
}
for (const path of ["/openapi.json", "/health", "/readiness", "/entities"]) {
  const anonymous = await direct.request("GET", path, { bearer: null });
  assert.equal(anonymous.status, 401, `${path} requires authentication`);
  assert.equal(errorCode(anonymous), "unauthenticated");
}
assert.equal((await direct.request("GET", "/docs")).status, 200, "authenticated documentation");
const document = record(await operator.openAPI());
assert.equal(record(document.info).version, "0.0.0");
const pairs = Object.entries(record(document.paths)).flatMap(([path, item]) =>
  Object.keys(record(item))
    .filter((key) => ["get", "post", "put", "patch", "delete"].includes(key))
    .map((method) => `${method.toUpperCase()} ${path}`),
);
assert.equal(pairs.length, 19, "the served edition has exactly the 19 S1 routes");
step("anonymous documentation exposes no schema; the raw document and every operation require authentication");

// Edition negotiation and Dataset boundaries.
const health = await direct.request("GET", "/health");
assert.deepEqual(record(record(health.body).data).supported_protocol_versions, ["0.0.0"]);
const staleHealth = await direct.request("GET", "/health", {
  headers: { "Atlas-Dataset-ID": crypto.randomUUID(), "Atlas-Protocol-Version": "9.9.9" },
});
assert.equal(staleHealth.status, 200, "health needs no current Dataset or edition");
const unsupported = new AtlasClient({
  baseUrl: installation.baseUrl,
  fetch: await installation.fetch(),
  requestTimeoutMs,
  editions: ["9.9.9"],
  authentication: async () => ({ bearer: await installation.adminKey() }),
});
await assert.rejects(() => unsupported.discover(), failsWith("protocol_unsupported"));
await direct.discover();
for (const [headers, status, code] of [
  [{ "Atlas-Dataset-ID": direct.datasetId ?? "" }, 400, "protocol_version_required"],
  [{ "Atlas-Dataset-ID": direct.datasetId ?? "", "Atlas-Protocol-Version": "9.9.9" }, 400, "protocol_unsupported"],
  [{ "Atlas-Protocol-Version": "0.0.0" }, 400, "dataset_required"],
  [{ "Atlas-Dataset-ID": crypto.randomUUID(), "Atlas-Protocol-Version": "0.0.0" }, 409, "dataset_mismatch"],
] as const) {
  for (const [method, path] of [
    ["GET", "/entities"],
    ["POST", "/tasks"],
  ] as const) {
    const response = await direct.request(method, path, { headers, json: method === "POST" ? {} : undefined });
    assert.equal(response.status, status, `${method} ${path} ${code}`);
    assert.equal(errorCode(response), code);
  }
}
step(
  "editions negotiate; health needs no Dataset; every operational request carries a supported edition and the current Dataset",
);

// Wrong CA, wrong hostname, expired certificate and plaintext all fail;
// nothing falls back or bypasses verification.
const other = await newInstallation();
await other.start();
const wrongCA = new AtlasClient({
  baseUrl: installation.baseUrl,
  fetch: nodeFetch({ ca: await other.ca() }),
  requestTimeoutMs,
  authentication: async () => ({ bearer: await installation.adminKey() }),
});
await assert.rejects(() => wrongCA.discover(), failsWith("transport_error"));
await other.stop();

const certificates = join(runDirectory(), "certificates");
await run("mkdir", ["-p", certificates]);
const openssl = (...args: string[]) => run("openssl", args, { cwd: certificates });
await openssl(
  "req",
  "-x509",
  "-newkey",
  "ec",
  "-pkeyopt",
  "ec_paramgen_curve:P-256",
  "-nodes",
  "-keyout",
  "ca.key",
  "-out",
  "ca.crt",
  "-subj",
  "/CN=Supplied test CA",
  "-days",
  "2",
  "-addext",
  "basicConstraints=critical,CA:TRUE",
  "-addext",
  "keyUsage=critical,keyCertSign",
);
await writeFile(join(certificates, "index.txt"), "");
await writeFile(join(certificates, "serial"), "01\n");
await writeFile(
  join(certificates, "ca.cnf"),
  [
    "[ca]",
    "default_ca = supplied",
    "[supplied]",
    `database = ${join(certificates, "index.txt")}`,
    `new_certs_dir = ${certificates}`,
    `serial = ${join(certificates, "serial")}`,
    "default_md = sha256",
    "policy = anything",
    "copy_extensions = copy",
    "unique_subject = no",
    "[anything]",
    "commonName = supplied",
    "",
  ].join("\n"),
);
const stamp = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().replace(/[-:T]/gu, "").slice(0, 14) + "Z";
const supplied = async (name: string, subjectAltName: string, start: string, end: string) => {
  await openssl(
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/CN=${name}`,
    "-addext",
    `subjectAltName=${subjectAltName}`,
  );
  await openssl(
    "ca",
    "-batch",
    "-config",
    "ca.cnf",
    "-cert",
    "ca.crt",
    "-keyfile",
    "ca.key",
    "-in",
    `${name}.csr`,
    "-out",
    `${name}.crt`,
    "-startdate",
    start,
    "-enddate",
    end,
    "-notext",
  );
  return { serverCertificate: join(certificates, `${name}.crt`), serverKey: join(certificates, `${name}.key`) };
};
const suppliedCA = await readFile(join(certificates, "ca.crt"), "utf8");
for (const [name, certificate, expected] of [
  ["valid", await supplied("valid", "IP:127.0.0.1", stamp(-1), stamp(1)), undefined],
  ["wrong-host", await supplied("wrong-host", "DNS:core.invalid", stamp(-1), stamp(1)), "ERR_TLS_CERT_ALTNAME_INVALID"],
  ["expired", await supplied("expired", "IP:127.0.0.1", "20200101000000Z", "20200102000000Z"), "CERT_HAS_EXPIRED"],
] as const) {
  const target = await newInstallation(certificate);
  await target.start();
  const client = new AtlasClient({
    baseUrl: target.baseUrl,
    fetch: nodeFetch({ ca: suppliedCA }),
    requestTimeoutMs,
    authentication: async () => ({ bearer: await target.adminKey() }),
  });
  const oracle = new DirectProtocol(target.baseUrl, suppliedCA, await target.adminKey());
  if (expected === undefined) {
    assert.equal((await client.discover()).protocolVersion, "0.0.0", "administrator-supplied trust succeeds");
    assert.equal((await oracle.request("GET", "/health")).status, 200);
  } else {
    await assert.rejects(() => client.discover(), failsWith("transport_error"), name);
    await assert.rejects(() => oracle.request("GET", "/health"), { code: expected }, name);
  }
  await target.stop();
}
const plaintext = await new Promise<number>((resolveStatus, reject) => {
  const outgoing = httpRequest(
    `http://127.0.0.1:${installation.port}/health`,
    { timeout: requestTimeoutMs },
    (response) => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    },
  );
  outgoing.on("error", reject);
  outgoing.end();
});
assert.equal(plaintext, 400, "Core never serves the API over plaintext");
const plainClient = new AtlasClient({
  baseUrl: `http://127.0.0.1:${installation.port}`,
  requestTimeoutMs,
  authentication: async () => ({ bearer: await installation.adminKey() }),
});
await assert.rejects(() => plainClient.discover());
step("installation and supplied trust succeed; wrong CA, wrong hostname, expired certificate and plaintext fail");

// Secrets never appear in arguments, logs, records or public responses.
const { os, process } = await establishedAsset(installation);
outputs.push(await installation.inspect(), await installation.activity(), await manage(installation, "ca"));
outputs.push(
  await operator.getEntity(os.assetId),
  await operator.listEntities(),
  await process.client.client.discover(),
);
await installation.restart();
outputs.push(await installation.stop());
const adminKey = await installation.adminKey();
const authority = (await readFile(installation.enrollmentAuthorityFile, "utf8")).split("\n").slice(1, -2).join("");
const secrets = { "administrator key": adminKey, "Asset credential": os.credential, "enrollment authority": authority };
for (const file of [installation.adminKeyFile, installation.enrollmentAuthorityFile]) {
  assert.equal((await stat(file)).mode & 0o077, 0, `${file} is owner-only`);
}
const files = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
const surfaces: [string, string][] = [["CLI and public responses", JSON.stringify(outputs)]];
for (const file of [...(await files(installation.root)), ...(await files(installation.recovery))]) {
  surfaces.push([file, (await readFile(file)).toString("latin1")]);
}
const container = (
  await run("docker", [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=com.atlas.installation=${installation.installationId}`,
  ])
).stdout.trim();
const definition = (await run("docker", ["inspect", container])).stdout;
surfaces.push(["container definition", definition]);
const containers: unknown = JSON.parse(definition);
assert(Array.isArray(containers), "docker inspect returns a list");
const inspected = record(containers[0]);
const hostConfig = record(inspected.HostConfig);
assert.equal(hostConfig.ReadonlyRootfs, true, "Core runs on a read-only root filesystem");
assert.equal(record(hostConfig.RestartPolicy).Name, "no", "the host manager, not Docker, restarts Core");
const mounts = Array.isArray(inspected.Mounts) ? inspected.Mounts.map(record) : [];
assert(
  mounts.length > 0 && mounts.every((mount) => !String(mount.Source).includes("docker.sock")),
  "Core never receives the Docker socket",
);
const logs = await run("docker", ["logs", container]);
surfaces.push(["container logs", logs.stdout + logs.stderr]);
for (const [surface, content] of surfaces) {
  for (const [name, secret] of Object.entries(secrets)) {
    assert(secret.length > 20 && !content.includes(secret), `${name} is absent from ${surface}`);
  }
}
step(
  `secrets are absent from CLI output, public responses, ${surfaces.length - 3} owned files, the container definition and logs`,
);

// The documented demonstration runs with internet disabled: a network
// namespace with only loopback, relayed to Core's published port.
const port = await freePort();
const socketPath = join(runDirectory(), "core-relay.sock");
const relay = createServer((client) => {
  const upstream = createConnection(port, "127.0.0.1");
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
await new Promise<void>((resolveListen) => relay.listen(socketPath, resolveListen));
const demoDirectory = join(runDirectory(), "offline-demo");
await run("mkdir", ["-p", demoDirectory]);
const root = resolve(import.meta.dirname, "../..");
// Creating a network namespace needs privilege; a non-root run uses
// non-interactive sudo and drops back to the invoking user for the demo.
const uid = globalThis.process.getuid?.() ?? 0;
const gid = globalThis.process.getgid?.() ?? 0;
const privileged =
  uid === 0
    ? ["unshare", "--net", "python3", join(import.meta.dirname, "offline.py")]
    : [
        "sudo",
        "-n",
        "--preserve-env=PATH,HOME",
        "unshare",
        "--net",
        "python3",
        join(import.meta.dirname, "offline.py"),
        "--as",
        `${uid}:${gid}`,
      ];
const offline = spawn(
  privileged[0] ?? "unshare",
  [
    ...privileged.slice(1),
    String(port),
    socketPath,
    globalThis.process.execPath,
    join(root, "tests/simulator/demo.mjs"),
    demoDirectory,
    "--port",
    String(port),
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);
let transcript = "";
offline.stdout.on("data", (chunk: Buffer) => (transcript += chunk.toString("utf8")));
const exit = await new Promise<number | null>((resolveExit) => offline.once("close", resolveExit));
relay.close();
await rm(socketPath, { force: true });
assert.equal(exit, 0, `offline demo failed:\n${transcript}`);
assert.match(transcript, /first Task completed after progress/u);
assert.match(transcript, /second Task cancelled/u);
step("the documented S1 demonstration ran setup, management, SDK and simulator with internet disabled");
