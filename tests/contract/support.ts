import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import {
  contractValidator,
  createTransport,
  responseValidation,
  ResponseValidationError,
  type ResponseFailureReason,
} from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { components, paths } from "./generated/protocol.js";

// Facts authored in the fixture contract and Go fixture configuration. Tests
// compare responses with these literals, never with handler or generator output.
export const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const otherDataset = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const olderVersion = "0.1.0";
export const version = "0.2.0";
export const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
export const pinnedSQLiteVersion = "3.53.4";
export const unallocatedRequestId = "00000000-0000-0000-0000-000000000000";

// Every fixture request has a finite deadline, including generated transport calls.
export function timedFetch(input: Request | URL | string, init: RequestInit = {}) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(5000) });
}

interface FixtureClientOptions {
  headers?: Record<string, string>;
  datasetId?: string;
  protocolVersion?: string;
  document?: Parameters<typeof responseValidation>[0];
  maxJSONBytes?: number;
  fetch?: (request: Request) => Promise<Response>;
}

// Generated transport whose responses must satisfy `document` and the selected
// Dataset/edition context before the transport interprets them.
export function fixtureClient<Paths extends {} = paths>(baseUrl: string, options: FixtureClientOptions = {}) {
  const client = createTransport<Paths>({
    baseUrl,
    headers: options.headers ?? headers,
    fetch: options.fetch ?? ((request) => timedFetch(request)),
  });
  client.use(
    responseValidation(
      options.document ?? protocol,
      { datasetId: options.datasetId ?? dataset, protocolVersion: options.protocolVersion ?? version },
      { maxJSONBytes: options.maxJSONBytes ?? 1_048_576 },
    ),
  );
  return client;
}

export const validateError = contractValidator(protocol).compile<components["schemas"]["Error"]>({
  $ref: "atlas#/components/schemas/Error",
});

// Predicate for assert.rejects: the SDK refused the response for `reason`.
export function isRefusal(reason: ResponseFailureReason) {
  return (error: unknown) => error instanceof ResponseValidationError && error.reason === reason;
}

export function assertProcessGone(pid: number, message?: string) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, message);
}

export async function assertPathRemoved(path: string, message?: string) {
  await assert.rejects(access(path), { code: "ENOENT" }, message);
}

export function hasErrorCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

// Readiness evidence written by timeout-probe.ts after real HTTP/SQLite readiness.
export function isProbeEvidence(value: unknown): value is { pid: number; dataDir: string; workerPid: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "workerPid" in value &&
    typeof value.workerPid === "number" &&
    "dataDir" in value &&
    typeof value.dataDir === "string" &&
    "sqliteVersion" in value &&
    value.sqliteVersion === pinnedSQLiteVersion &&
    "journalMode" in value &&
    value.journalMode === "wal"
  );
}

// Rejects unless `work` settles within `ms`. A function message is evaluated
// when the deadline fires, so it can include output gathered meanwhile.
export async function within<T>(work: Promise<T>, ms: number, message: string | (() => string)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(typeof message === "string" ? message : message())), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Serves a controlled loopback supplier for adapter checks the Go fixture cannot
// produce. A close failure never hides the workflow's own failure.
export async function withLoopbackServer(listener: RequestListener, workflow: (baseUrl: string) => Promise<void>) {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let failure: { error: unknown } | undefined;
  try {
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    await workflow(`http://127.0.0.1:${address.port}`);
  } catch (error) {
    failure = { error };
  }
  server.closeAllConnections();
  const closeError = await new Promise<Error | undefined>((resolve) => server.close(resolve));
  if (failure && closeError)
    throw new AggregateError([failure.error, closeError], "Workflow and loopback server close both failed");
  if (failure) throw failure.error;
  if (closeError) throw closeError;
}
