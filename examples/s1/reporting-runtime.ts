import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Ajv } from "../../Atlas SDK/node_modules/ajv/dist/ajv.js";
import { restoreMutation, type PreparedMutation } from "../../Atlas SDK/src/index.js";
import { maximumRetainedBytes, readRetainedFile, retainJSON } from "./execution-store.js";

type RetainedReporter = {
  format: 1;
  assetId: string;
  credentialId: string;
  enrollmentAuthorizationId: string;
  credential: string;
  recoveryKey: string;
  processId: string;
  processKey: string;
  processGeneration: string | null;
  nextSequence: string;
  pending: { id: string; descriptor: PreparedMutation }[];
};

/** The trusted runtime owns private keys and descriptors; the SDK receives signers. */
export async function openReportingRuntime(directory: string, assetId: string) {
  const ajv = new Ajv({ strict: true, allowUnionTypes: true });
  const valid = ajv.compile<Omit<RetainedReporter, "pending"> & { pending: { id: string; descriptor: unknown }[] }>({
    type: "object",
    additionalProperties: false,
    required: [
      "format",
      "assetId",
      "credentialId",
      "enrollmentAuthorizationId",
      "credential",
      "recoveryKey",
      "processId",
      "processKey",
      "processGeneration",
      "nextSequence",
      "pending",
    ],
    properties: {
      format: { const: 1 },
      assetId: { type: "string", minLength: 1 },
      credentialId: { type: "string", minLength: 1 },
      enrollmentAuthorizationId: { type: "string", minLength: 1 },
      credential: { type: "string", minLength: 32 },
      recoveryKey: { type: "string", minLength: 1 },
      processId: { type: "string", minLength: 1 },
      processKey: { type: "string", minLength: 1 },
      processGeneration: { type: ["string", "null"], pattern: "^[1-9][0-9]*$" },
      nextSequence: { type: "string", pattern: "^[1-9][0-9]*$" },
      pending: {
        type: "array",
        maxItems: 128,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "descriptor"],
          properties: { id: { type: "string" }, descriptor: {} },
        },
      },
    },
  });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "reporter.json");
  let state: RetainedReporter;
  try {
    const bytes = await readRetainedFile(path, maximumRetainedBytes, true);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Retained reporting JSON is invalid; explicit repair is required");
    }
    if (!valid(value) || value.assetId !== assetId)
      throw new Error("Retained reporting state is invalid; explicit repair is required");
    state = {
      ...value,
      pending: value.pending.map((item) => ({ id: item.id, descriptor: restoreMutation(item.descriptor) })),
    };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    state = {
      format: 1,
      assetId,
      credentialId: randomUUID(),
      enrollmentAuthorizationId: randomUUID(),
      credential: randomBytes(32).toString("base64url"),
      recoveryKey: newKey(),
      processId: randomUUID(),
      processKey: newKey(),
      processGeneration: null,
      nextSequence: "1",
      pending: [],
    };
    await retainJSON(directory, path, state);
  }
  const key = (encoded: string) =>
    createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
  const publicKey = (encoded: string) => {
    const exported = key(encoded).export({ format: "jwk" });
    if (typeof exported.x !== "string" || exported.crv !== "Ed25519" || exported.kty !== "OKP")
      throw new Error("Retained key is not an Ed25519 signing key");
    return exported.x;
  };
  // Validate retained keys before any traffic; replacement cannot manufacture authority.
  publicKey(state.processKey);
  publicKey(state.recoveryKey);
  let writing = false;
  let unavailable = false;
  const change = async (update: (next: RetainedReporter) => void) => {
    if (writing || unavailable) throw new Error("Reporting retention is busy or unavailable; reopen before recovery");
    writing = true;
    try {
      const next = structuredClone(state);
      update(next);
      if (!valid(next)) throw new Error("Reporting retention violates its contract");
      try {
        await retainJSON(directory, path, next);
      } catch (error) {
        unavailable = true;
        throw error;
      }
      state = next;
    } finally {
      writing = false;
    }
  };
  return {
    credential: () => state.credential,
    enrollment: (installationId: string) => ({
      installation_id: installationId,
      authorization_id: state.enrollmentAuthorizationId,
      asset_id: assetId,
      credential_id: state.credentialId,
      credential_verifier: createHash("sha256").update(state.credential).digest("base64url"),
      recovery_public_key: publicKey(state.recoveryKey),
      proof: "",
    }),
    signer: () => {
      const processKey = key(state.processKey);
      return {
        processId: state.processId,
        publicKey: publicKey(state.processKey),
        sign: async (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, processKey)),
      };
    },
    authorizer: () => {
      const recoveryKey = key(state.recoveryKey);
      return { authorize: async (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, recoveryKey)) };
    },
    reportState: () => ({
      assetId,
      processId: state.processId,
      processGeneration: state.processGeneration,
      nextSequence: state.nextSequence,
    }),
    pending: () => structuredClone(state.pending),
    retain: async (
      descriptor: PreparedMutation,
      reportState?: { processGeneration: string | null; nextSequence: string },
    ) => {
      const original = restoreMutation(descriptor);
      const id = randomUUID();
      await change((next) => {
        next.pending.push({ id, descriptor: original });
        if (reportState) {
          next.processGeneration = reportState.processGeneration;
          next.nextSequence = reportState.nextSequence;
        }
      });
      return id;
    },
    acknowledge: (id: string, reportState?: { processGeneration: string | null; nextSequence: string }) =>
      change((next) => {
        if (!next.pending.some((item) => item.id === id)) throw new Error("Pending descriptor is not retained");
        next.pending = next.pending.filter((item) => item.id !== id);
        if (reportState) {
          next.processGeneration = reportState.processGeneration;
          next.nextSequence = reportState.nextSequence;
        }
      }),
    replaceProcess: () =>
      change((next) => {
        next.processId = randomUUID();
        next.processKey = newKey();
        next.nextSequence = "1";
      }),
  };
}

function newKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
}
