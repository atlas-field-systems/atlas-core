import { join } from "node:path";
import { AssetOS, type CommandManifest } from "./asset-os.js";

export { AssetOS, arrivalToleranceM } from "./asset-os.js";
export type { CommandManifest, Execution, ExecutionState, Position, RetainedEvidence } from "./asset-os.js";
export { generateKey, processSigner, recoveryAuthority } from "./keys.js";
export type { RetainedKey } from "./keys.js";
export { ReportingProcess } from "./reporting.js";
export type { Link, Submission } from "./reporting.js";

// prepareAsset creates a simulated Asset OS and obtains its deployment
// enrollment authorization for the Asset ID and recovery public key.
export async function prepareAsset(
  directory: string,
  authorize: (assetId: string, recoveryPublicKey: string) => Promise<string>,
  options: { assetId?: string; alias?: string | null; commandManifest?: CommandManifest } = {},
) {
  const os = await AssetOS.create(join(directory, `asset-${options.assetId ?? crypto.randomUUID()}.json`), options);
  await os.authorizeEnrollment(await authorize(os.assetId, os.recoveryKey.publicKey));
  return os;
}
