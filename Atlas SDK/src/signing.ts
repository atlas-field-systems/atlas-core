import canonicalize from "canonicalize";

// Domain separators shared with Core. A signature for one fact kind never
// verifies as another kind with an identical member layout.
export const reportSignature = "atlas-report-v1";
export const authorityClaimSignature = "atlas-authority-claim-v1";
export const enrollmentSignature = "atlas-enrollment-v1";

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// canonicalBytes is RFC 8785 JSON canonicalization of validated facts:
// omission and null stay distinct, array order is kept and object keys sort by
// UTF-16 code units.
export function canonicalBytes(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) throw new Error("Facts have no JSON representation");
  return encoder.encode(text);
}

export function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function digest(bytes: Uint8Array) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
}

// Identifiers sign in canonical lowercase form; header and path spellings do
// not change the signed identity.
export function canonicalIdentifier(value: string) {
  return value.toLowerCase().replace(/^urn:uuid:/u, "");
}

// reportFacts is the process-signed document for one report. It covers the
// Dataset and edition headers, operation kind, target, the report context
// without its proof, and the typed payload without context or authority claim.
export function reportFacts(input: {
  datasetId: string;
  protocolVersion: string;
  operation: string;
  targetId: string;
  body: Readonly<Record<string, unknown>>;
}) {
  const { report_context: context, authority_claim: _claim, ...payload } = input.body;
  if (!isRecord(context)) throw new Error("Reports carry report_context");
  const { process_proof: _proof, ...unsignedContext } = context;
  return canonicalBytes({
    atlas_signature: reportSignature,
    dataset_id: canonicalIdentifier(input.datasetId),
    protocol_version: input.protocolVersion,
    operation: input.operation,
    target_id: canonicalIdentifier(input.targetId),
    report_context: unsignedContext,
    payload,
  });
}

// authorityClaimFacts is the recovery-authority-signed document binding a
// process-authority claim to its first report's digest, Dataset and Asset.
export function authorityClaimFacts(input: {
  datasetId: string;
  assetId: string;
  claim: Readonly<Record<string, unknown>>;
  reportDigest: string;
}) {
  const { recovery_proof: _proof, ...claim } = input.claim;
  return canonicalBytes({
    atlas_signature: authorityClaimSignature,
    dataset_id: canonicalIdentifier(input.datasetId),
    asset_id: canonicalIdentifier(input.assetId),
    claim,
    report_digest: input.reportDigest,
  });
}

// enrollmentFacts is the document deployment enrollment authority signs to
// authorize first Enrollment of one Asset ID with its recovery public key.
export function enrollmentFacts(input: { installationId: string; assetId: string; recoveryPublicKey: string }) {
  return canonicalBytes({
    atlas_signature: enrollmentSignature,
    installation_id: input.installationId,
    asset_id: canonicalIdentifier(input.assetId),
    recovery_public_key: input.recoveryPublicKey,
  });
}

// prepareCredential generates a secret of 32 cryptographically random bytes.
// The caller retains it securely before first submission; Core stores only a
// verifier.
export function prepareCredential() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
