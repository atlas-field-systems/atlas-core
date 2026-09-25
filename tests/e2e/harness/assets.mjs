/** Shared Asset facts for enrollment scenarios. */
export const scoutFacts = {
  alias: "Scout One",
  subtype: "ground vehicle",
  components: { telemetry: { latitude: 42.2743, longitude: -71.8081 }, health: { battery_percent: 75 } },
  command_manifest: [{ command_id: "move_to", scheduling: ["queued"], cancellation: true, progress: true }],
};

/**
 * Prepares an Asset identity through the SDK and names its values in the
 * transcript. Call inside a step.
 */
export async function prepareAsset(s, core, label = "asset") {
  const enroller = s.client(core, core.installation.enrollmentKey);
  const identity = await enroller.prepareAssetEnrollment();
  s.transcript.name(identity.assetId, label);
  s.transcript.name(identity.requestId, `${label} request`);
  s.transcript.name(identity.credential, `${label} credential`);
  return identity;
}

/** Prepares and enrolls an Asset, returning its identity, result and own client. */
export async function enrollAsset(s, core, facts = scoutFacts, label = "asset") {
  const identity = await prepareAsset(s, core, label);
  const result = await s.client(core, core.installation.enrollmentKey).enrollAsset(identity, facts);
  return { identity, result, client: s.client(core, identity.credential) };
}

/** A status report for the given Asset identity. */
export function statusReport(s, identity, sequence, status, label) {
  const reportId = crypto.randomUUID();
  s.transcript.name(reportId, label ?? `report ${sequence}`);
  return { datasetId: identity.datasetId, reportId, sequence, status };
}

/** The direct Protocol body for an enrollment, for parity and malformed-input checks. */
export function enrollmentBody(identity, facts = {}) {
  return { dataset_id: identity.datasetId, id: identity.assetId, request_id: identity.requestId, kind: "asset", credential: identity.credential, ...facts };
}
