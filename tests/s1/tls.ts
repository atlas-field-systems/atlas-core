import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export function ownedFixtureRoot(args: readonly string[]): string {
  const index = args.indexOf("--owned-root");
  const root = index >= 0 ? args[index + 1] : undefined;
  if (root === undefined || !isAbsolute(root)) throw new Error("S1 fixtures require a supervisor-owned absolute root");
  return root;
}

export async function temporaryTLS(parent: string, options: { serverNames?: string; expired?: boolean } = {}) {
  const directory = await mkdtemp(join(parent, "atlas-s1-tls-"));
  const keyPath = join(directory, "server.key");
  const certificatePath = join(directory, "server.pem");
  try {
    const requestPath = join(directory, "server.csr");
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=localhost",
        "-addext",
        `subjectAltName=${options.serverNames ?? "DNS:localhost,IP:127.0.0.1"}`,
        "-keyout",
        keyPath,
        "-out",
        requestPath,
      ],
      { stdio: "ignore", timeout: 10000 },
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        requestPath,
        "-signkey",
        keyPath,
        "-copy_extensions",
        "copy",
        "-days",
        options.expired ? "-1" : "1",
        "-out",
        certificatePath,
      ],
      { stdio: "ignore", timeout: 10000 },
    );
    return {
      key: await readFile(keyPath),
      certificate: await readFile(certificatePath),
      close: () => rm(directory, { recursive: true, force: true }),
      [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "TLS preparation and cleanup failed");
    }
    throw error;
  }
}
