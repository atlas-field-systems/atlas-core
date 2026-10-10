// SDK and direct Protocol parity: one independently authored scenario over
// all 19 S1 routes runs through the public SDK and through hand-built HTTPS
// requests on two isolated installations. Each step has an independent
// expected status and code, and both modes must observe the same normalized
// result. Only allocated identifiers, times, versions and cursors are
// normalized; ordering, absence, null and errors are compared as is.
import assert from "node:assert/strict";
import canonicalize from "../../Atlas SDK/node_modules/canonicalize/lib/canonicalize.js";
import {
  AssetClient,
  AtlasClient,
  AtlasError,
  type MutationOutcome,
  type RegistrationDescriptor,
  type ReportDescriptor,
  type ReportResult,
} from "../../Atlas SDK/src/index.js";
import { generateKey, processSigner, recoveryAuthority } from "../simulator/index.js";
import {
  DirectProtocol,
  directProtocol,
  errorCode,
  newInstallation,
  record,
  step,
  text,
  type DirectResponse,
  type Installation,
} from "./support.js";

// Shared client-chosen facts for both isolated datasets.
const assetId = crypto.randomUUID();
const registrationId = crypto.randomUUID();
const creationIds = [crypto.randomUUID(), crypto.randomUUID()];
const cancellationId = crypto.randomUUID();
const transferId = crypto.randomUUID();
const processId = crypto.randomUUID();
const credential = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const recoveryKey = await generateKey();
const processKey = await generateKey();
const manifest = [
  {
    command: "move_to" as const,
    scheduling: ["queued" as const],
    cancellation: true,
    progress: true,
    description: null,
  },
];
const target = {
  command: "move_to" as const,
  target: { kind: "position" as const, position: { latitude: 10, longitude: 20 } },
};

interface Observation {
  readonly status: number;
  readonly code?: string;
  readonly value?: unknown;
}

// Mode state: the installation and the Task IDs Core allocated in it.
interface Context {
  readonly installation: Installation;
  readonly enrollment: string;
  taskId: string;
  sdk: { operator: AtlasClient; asset: AssetClient };
  direct: { operator: DirectProtocol; asset: DirectProtocol };
}

// ------------------------------------------------------------------------
// Independent direct composition of signed report facts (RFC 8785, Ed25519),
// authored from the report contract rather than the SDK's helpers.
const encoder = new TextEncoder();
const canonical = (value: unknown) => encoder.encode(canonicalize(value) ?? assert.fail("facts have JSON"));
const sha256 = async (bytes: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("base64url");

let directSequence = 0;
async function directReport(
  context: Context,
  operation: "checkin" | "entity_patch" | "status_report" | "task_status",
  targetId: string,
  payload: Record<string, unknown>,
  claim?: boolean,
) {
  directSequence += 1;
  const asset = context.direct.asset;
  const challenge = await asset.request("GET", `/health?challenge_asset_id=${assetId}&challenge_generation=1`);
  const token = text(record(record(record(challenge.body).data).contact_challenge).token, "challenge");
  const unsigned = {
    asset_id: assetId,
    process_generation: "1",
    sequence: String(directSequence),
    generated_at: new Date().toISOString(),
    evidence_kind: "current",
    evidence_origin: null,
    retained_evidence_id: null,
    contact_challenge: token,
  };
  const facts = canonical({
    atlas_signature: "atlas-report-v1",
    dataset_id: asset.datasetId,
    protocol_version: "0.0.0",
    operation,
    target_id: targetId,
    report_context: unsigned,
    payload,
  });
  const body: Record<string, unknown> = {
    ...payload,
    report_context: { ...unsigned, process_proof: await processSigner(processKey).sign(facts) },
  };
  if (claim) {
    const claimFacts = {
      transfer_id: transferId,
      process_id: processId,
      expected_generation: "0",
      process_public_key: processKey.publicKey,
    };
    const recoveryProof = await recoveryAuthority(recoveryKey).authorize(
      canonical({
        atlas_signature: "atlas-authority-claim-v1",
        dataset_id: asset.datasetId,
        asset_id: assetId,
        claim: claimFacts,
        report_digest: await sha256(facts),
      }),
    );
    body.authority_claim = { ...claimFacts, recovery_proof: recoveryProof };
  }
  return body;
}

// ------------------------------------------------------------------------
// Observation helpers for each mode.
function fromDirect(response: DirectResponse, view: (data: unknown) => unknown = (data) => data): Observation {
  if (response.status >= 400) return { status: response.status, code: errorCode(response) };
  const body = response.body === undefined ? undefined : record(response.body);
  return { status: response.status, value: body === undefined ? undefined : view(body.data) };
}

async function fromRead(read: () => Promise<unknown>, view: (data: unknown) => unknown = (data) => data) {
  try {
    return { status: 200, value: view(await read()) };
  } catch (error) {
    if (error instanceof AtlasError) return { status: error.status ?? 0, code: error.code };
    throw error;
  }
}

function fromOutcome<T>(outcome: MutationOutcome<T>, view: (value: T) => unknown = (value) => value): Observation {
  switch (outcome.outcome) {
    case "accepted":
      return { status: outcome.status, value: view(outcome.value) };
    case "rejected":
      return { status: outcome.rejection.status, code: outcome.rejection.code };
    default:
      return assert.fail(`unexpected SDK outcome ${JSON.stringify(outcome)}`);
  }
}

const reportView = (report: unknown) => {
  const value = record(report);
  return {
    disposition: value.disposition,
    report_id: value.report_id,
    applied_fields: value.applied_fields,
    task_effect: value.task_effect,
    samples: Array.isArray(value.movement_sample_ids) ? value.movement_sample_ids.length : undefined,
    contact_refreshed: value.contact_refreshed,
    authority: value.authority,
  };
};
const sdkReport = (result: ReportResult<unknown>) => reportView(result.report);
const directReportView = (data: unknown) => reportView(record(data).report);

// ------------------------------------------------------------------------
// The scenario. Expected status and code are authored here, independently of
// both modes.
const steps: {
  name: string;
  expect: { status: number; code?: string };
  sdk: (context: Context) => Promise<Observation>;
  direct: (context: Context) => Promise<Observation>;
}[] = [
  {
    name: "GET /health",
    expect: { status: 200 },
    sdk: async ({ sdk }) =>
      fromRead(
        () => sdk.operator.discover(),
        (data) => record(data).principal,
      ),
    direct: async ({ direct }) =>
      fromDirect(await direct.operator.request("GET", "/health"), (data) => record(data).principal),
  },
  {
    name: "GET /readiness",
    expect: { status: 200 },
    sdk: async ({ sdk }) => fromRead(() => sdk.operator.readiness()),
    direct: async ({ direct }) => fromDirect(await direct.operator.request("GET", "/readiness")),
  },
  {
    name: "GET /openapi.json",
    expect: { status: 200 },
    sdk: async ({ sdk }) =>
      fromRead(
        () => sdk.operator.openAPI(),
        (data) => record(data).info,
      ),
    direct: async ({ direct }) => {
      const response = await direct.operator.request("GET", "/openapi.json");
      return { status: response.status, value: record(response.body).info };
    },
  },
  {
    name: "POST /entities registers through enrollment",
    expect: { status: 201 },
    sdk: async ({ sdk }) => fromOutcome(await sdk.asset.register(await registration(sdk.asset)), (data) => data),
    direct: async (context) =>
      fromDirect(await directRegistration(context, { alias: "Parity-Rover", command_manifest: manifest })),
  },
  {
    name: "POST /entities identical retry replays",
    expect: { status: 200 },
    sdk: async ({ sdk }) => fromOutcome(await sdk.asset.register(await registration(sdk.asset))),
    direct: async (context) =>
      fromDirect(await directRegistration(context, { alias: "Parity-Rover", command_manifest: manifest })),
  },
  {
    name: "POST /entities changed facts conflict",
    expect: { status: 409, code: "request_conflict" },
    sdk: async ({ sdk }) => {
      const descriptor = await registration(sdk.asset);
      return fromOutcome(await sdk.asset.register({ ...descriptor, body: { ...descriptor.body, alias: "Other" } }));
    },
    direct: async (context) =>
      fromDirect(await directRegistration(context, { alias: "Other", command_manifest: manifest })),
  },
  {
    name: "POST /entities refuses Reported components",
    expect: { status: 403, code: "forbidden_field" },
    sdk: async ({ sdk }) => {
      const descriptor = await registration(sdk.asset);
      return fromOutcome(
        await sdk.asset.register({
          ...descriptor,
          body: { ...descriptor.body, components: { status: { value: "ready", reason: null } } },
        }),
      );
    },
    direct: async (context) =>
      fromDirect(
        await directRegistration(context, {
          alias: "Parity-Rover",
          command_manifest: manifest,
          components: { status: { value: "ready", reason: null } },
        }),
      ),
  },
  {
    name: "GET /entities",
    expect: { status: 200 },
    sdk: async ({ sdk }) =>
      fromRead(
        () => sdk.operator.listEntities(),
        (page) => record(page).items,
      ),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("GET", "/entities", { headers: direct.operator.context() }),
        (data) => record(data).items,
      ),
  },
  {
    name: "GET /entities/{entity_id}",
    expect: { status: 200 },
    sdk: async ({ sdk }) => fromRead(() => sdk.operator.getEntity(assetId)),
    direct: async ({ direct }) =>
      fromDirect(await direct.operator.request("GET", `/entities/${assetId}`, { headers: direct.operator.context() })),
  },
  {
    name: "GET /entities/{entity_id} unknown",
    expect: { status: 404, code: "not_found" },
    sdk: async ({ sdk }) => fromRead(() => sdk.operator.getEntity("00000000-0000-4000-8000-000000000000")),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("GET", "/entities/00000000-0000-4000-8000-000000000000", {
          headers: direct.operator.context(),
        }),
      ),
  },
  {
    name: "GET /entities/alias/{alias} ignores case",
    expect: { status: 200 },
    sdk: async ({ sdk }) =>
      fromRead(
        () => sdk.operator.getEntityByAlias("parity-rover"),
        (data) => record(data).id,
      ),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("GET", "/entities/alias/parity-rover", { headers: direct.operator.context() }),
        (data) => record(data).id,
      ),
  },
  {
    name: "PATCH /entities/{entity_id} descriptive edit",
    expect: { status: 200 },
    sdk: async ({ sdk }) =>
      fromOutcome(await sdk.operator.editEntity({ entityId: assetId, expectedEditRevision: "1", subtype: "rover" })),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("PATCH", `/entities/${assetId}`, {
          headers: direct.operator.context(),
          json: { subtype: "rover", expected_edit_revision: "1" },
        }),
        (data) => record(data).entity,
      ),
  },
  {
    name: "PATCH /entities/{entity_id} stale edit",
    expect: { status: 409, code: "edit_conflict" },
    sdk: async ({ sdk }) =>
      fromOutcome(await sdk.operator.editEntity({ entityId: assetId, expectedEditRevision: "1", subtype: "stale" })),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("PATCH", `/entities/${assetId}`, {
          headers: direct.operator.context(),
          json: { subtype: "stale", expected_edit_revision: "1" },
        }),
      ),
  },
  {
    name: "POST /tasks while the Asset is offline",
    expect: { status: 201 },
    sdk: async (context) => {
      const outcome = await context.sdk.operator.createTask(creation(context.sdk.operator, 0));
      if (outcome.outcome === "accepted") context.taskId = outcome.value.id;
      return fromOutcome(outcome);
    },
    direct: async (context) => {
      const response = await context.direct.operator.request("POST", "/tasks", {
        headers: context.direct.operator.context(),
        json: { request_id: creationIds[0], asset_id: assetId, input: target },
      });
      if (response.status === 201) context.taskId = text(record(record(response.body).data).id, "Task ID");
      return fromDirect(response);
    },
  },
  {
    name: "POST /tasks identical retry replays",
    expect: { status: 200 },
    sdk: async ({ sdk }) => fromOutcome(await sdk.operator.createTask(creation(sdk.operator, 0))),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("POST", "/tasks", {
          headers: direct.operator.context(),
          json: { request_id: creationIds[0], asset_id: assetId, input: target },
        }),
      ),
  },
  {
    name: "POST /tasks immediate scheduling",
    expect: { status: 400, code: "unsupported_scheduling" },
    sdk: async ({ sdk }) => {
      const descriptor = creation(sdk.operator, 1);
      return fromOutcome(
        await sdk.operator.createTask({ ...descriptor, body: { ...descriptor.body, scheduling: "immediate" } }),
      );
    },
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("POST", "/tasks", {
          headers: direct.operator.context(),
          json: { request_id: creationIds[1], asset_id: assetId, scheduling: "immediate", input: target },
        }),
      ),
  },
  {
    name: "DELETE /entities/{entity_id} with nonterminal work",
    expect: { status: 409, code: "nonterminal_tasks" },
    sdk: async ({ sdk }) => fromOutcome(await sdk.operator.deleteEntity(assetId)),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("DELETE", `/entities/${assetId}`, { headers: direct.operator.context() }),
      ),
  },
  {
    name: "POST /entities/{entity_id}/checkin claims process authority",
    expect: { status: 200 },
    sdk: async ({ sdk }) => {
      const descriptor = await sdk.asset.prepareCheckIn(
        { components: { telemetry: { position: { latitude: 10.0003, longitude: 20 } } } },
        {
          claim: {
            descriptor: { transferId, processId, expectedGeneration: "0", processPublicKey: processKey.publicKey },
            recovery: recoveryAuthority(recoveryKey),
          },
        },
      );
      return fromOutcome(await sdk.asset.submitEntityReport(descriptor), sdkReport);
    },
    direct: async (context) =>
      fromDirect(
        await context.direct.asset.request("POST", `/entities/${assetId}/checkin`, {
          headers: context.direct.asset.context(),
          json: await directReport(
            context,
            "checkin",
            assetId,
            { components: { telemetry: { position: { latitude: 10.0003, longitude: 20 } } } },
            true,
          ),
        }),
        directReportView,
      ),
  },
  {
    name: "PATCH /entities/{entity_id}/status reports Operational status",
    expect: { status: 200 },
    sdk: async ({ sdk }) =>
      fromOutcome(
        await submit(sdk.asset, await sdk.asset.prepareStatusReport({ value: "busy", reason: "driving" })),
        sdkReport,
      ),
    direct: async (context) =>
      fromDirect(
        await context.direct.asset.request("PATCH", `/entities/${assetId}/status`, {
          headers: context.direct.asset.context(),
          json: await directReport(context, "status_report", assetId, { status: { value: "busy", reason: "driving" } }),
        }),
        directReportView,
      ),
  },
  {
    name: "GET /entities/{entity_id}/status",
    expect: { status: 200 },
    sdk: async ({ sdk }) => fromRead(() => sdk.operator.getAssetStatus(assetId)),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("GET", `/entities/${assetId}/status`, { headers: direct.operator.context() }),
        (data) => record(data).status,
      ),
  },
  {
    name: "PATCH /entities/{entity_id} reports partial telemetry",
    expect: { status: 200 },
    sdk: async ({ sdk }) =>
      fromOutcome(
        await submit(
          sdk.asset,
          await sdk.asset.prepareComponentReport({ components: { telemetry: { speed_mps: 1.5 } } }),
        ),
        sdkReport,
      ),
    direct: async (context) =>
      fromDirect(
        await context.direct.asset.request("PATCH", `/entities/${assetId}`, {
          headers: context.direct.asset.context(),
          json: await directReport(context, "entity_patch", assetId, { components: { telemetry: { speed_mps: 1.5 } } }),
        }),
        directReportView,
      ),
  },
  {
    name: "GET /entities/{entity_id}/movement-history",
    expect: { status: 200 },
    sdk: async ({ sdk }) => fromRead(() => sdk.operator.movementHistory(assetId)),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("GET", `/entities/${assetId}/movement-history`, {
          headers: direct.operator.context(),
        }),
      ),
  },
  {
    name: "GET /entities/{entity_id}/tasks",
    expect: { status: 200 },
    sdk: async ({ sdk }) =>
      fromRead(
        () => sdk.asset.fetchAssignedTasks(),
        (work) => record(work).tasks,
      ),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.asset.request("GET", `/entities/${assetId}/tasks?outstanding=true`, {
          headers: direct.asset.context(),
        }),
        (data) => record(data).items,
      ),
  },
  {
    name: "PATCH /tasks/{task_id}/status Asset acknowledgement",
    expect: { status: 200 },
    sdk: async (context) =>
      fromOutcome(
        await submit(
          context.sdk.asset,
          await context.sdk.asset.prepareTaskReport(context.taskId, { event: "acknowledged" }),
        ),
        sdkReport,
      ),
    direct: async (context) =>
      fromDirect(
        await context.direct.asset.request("PATCH", `/tasks/${context.taskId}/status`, {
          headers: context.direct.asset.context(),
          json: await directReport(context, "task_status", context.taskId, { action: "report", event: "acknowledged" }),
        }),
        directReportView,
      ),
  },
  {
    name: "PATCH /tasks/{task_id}/status cancellation request",
    expect: { status: 200 },
    sdk: async (context) =>
      fromOutcome(
        await context.sdk.operator.requestCancellation({
          kind: "task_cancellation",
          datasetId: (await context.sdk.operator.discover()).datasetId,
          taskId: context.taskId,
          body: { action: "request_cancellation", cancellation_id: cancellationId, reason: "parity" },
        }),
      ),
    direct: async (context) =>
      fromDirect(
        await context.direct.operator.request("PATCH", `/tasks/${context.taskId}/status`, {
          headers: context.direct.operator.context(),
          json: { action: "request_cancellation", cancellation_id: cancellationId, reason: "parity" },
        }),
        (data) => record(data).task,
      ),
  },
  {
    name: "PATCH /tasks/{task_id}/status Asset confirms cancellation",
    expect: { status: 200 },
    sdk: async (context) =>
      fromOutcome(
        await submit(
          context.sdk.asset,
          await context.sdk.asset.prepareTaskReport(context.taskId, {
            event: "cancellation_confirmed",
            cancellationId,
          }),
        ),
        sdkReport,
      ),
    direct: async (context) =>
      fromDirect(
        await context.direct.asset.request("PATCH", `/tasks/${context.taskId}/status`, {
          headers: context.direct.asset.context(),
          json: await directReport(context, "task_status", context.taskId, {
            action: "report",
            event: "cancellation_confirmed",
            cancellation_id: cancellationId,
          }),
        }),
        directReportView,
      ),
  },
  {
    name: "GET /tasks",
    expect: { status: 200 },
    sdk: async ({ sdk }) =>
      fromRead(
        () => sdk.operator.listTasks(),
        (page) => record(page).items,
      ),
    direct: async ({ direct }) =>
      fromDirect(
        await direct.operator.request("GET", "/tasks", { headers: direct.operator.context() }),
        (data) => record(data).items,
      ),
  },
  {
    name: "GET /tasks/{task_id}",
    expect: { status: 200 },
    sdk: async (context) => fromRead(() => context.sdk.operator.getTask(context.taskId)),
    direct: async (context) =>
      fromDirect(
        await context.direct.operator.request("GET", `/tasks/${context.taskId}`, {
          headers: context.direct.operator.context(),
        }),
      ),
  },
  {
    name: "DELETE /entities/{entity_id} after terminal work",
    expect: { status: 204 },
    sdk: async ({ sdk }) => fromOutcome(await sdk.operator.deleteEntity(assetId), () => null),
    direct: async ({ direct }) => {
      const response = await direct.operator.request("DELETE", `/entities/${assetId}`, {
        headers: direct.operator.context(),
      });
      assert.match(response.headers["atlas-commit-cursor"] ?? "", /^[1-9][0-9]*$/u);
      return { status: response.status, value: null };
    },
  },
  {
    name: "GET /entities/{entity_id} after deletion",
    expect: { status: 410, code: "entity_deleted" },
    sdk: async ({ sdk }) => fromRead(() => sdk.operator.getEntity(assetId)),
    direct: async ({ direct }) =>
      fromDirect(await direct.operator.request("GET", `/entities/${assetId}`, { headers: direct.operator.context() })),
  },
];

// Helpers that need per-mode clients. The registration descriptor is
// prepared once and retained, as an Asset retains it across retries.
let retained: RegistrationDescriptor | undefined;
async function registration(asset: AssetClient) {
  if (retained === undefined || !asset.isCurrent(retained)) {
    await asset.client.discover();
    retained = await asset.prepareRegistration({
      registrationId,
      alias: "Parity-Rover",
      commandManifest: manifest,
      credential,
    });
  }
  return retained;
}

function creation(operator: AtlasClient, index: number) {
  const known = operator.connection.known ?? assert.fail("discovered");
  return {
    kind: "task_creation" as const,
    datasetId: known.datasetId,
    body: { request_id: creationIds[index] ?? assert.fail(), asset_id: assetId, input: target },
  };
}

function submit(asset: AssetClient, descriptor: ReportDescriptor): Promise<MutationOutcome<ReportResult<unknown>>> {
  return descriptor.operation === "task_status"
    ? asset.submitTaskReport(descriptor)
    : asset.submitEntityReport(descriptor);
}

async function directRegistration(context: Context, facts: Record<string, unknown>) {
  return context.direct.asset.request("POST", "/entities", {
    bearer: null,
    headers: { ...context.direct.asset.context(), "Atlas-Enrollment": context.enrollment },
    json: { id: assetId, type: "asset", registration_id: registrationId, ...facts, enrollment: { credential } },
  });
}

// ------------------------------------------------------------------------
// Normalization of intentionally nondeterministic values only.
function normalizer() {
  const identifiers = new Map<string, string>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  const normalize = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([member, inner]) => [
          member,
          member === "communications" ? "<derived>" : normalize(inner, member),
        ]),
      );
    }
    if (typeof value !== "string") return value;
    if (/(_at|_seen|_time)$/u.test(key)) return "<time>";
    if (
      ["version", "commit_cursor", "commitCursor", "queue_revision", "dataset_id", "datasetId", "token"].includes(key)
    ) {
      return `<${key}>`;
    }
    if (uuid.test(value)) {
      if (!identifiers.has(value)) identifiers.set(value, `<id:${identifiers.size}>`);
      return identifiers.get(value);
    }
    return value;
  };
  return normalize;
}

async function prepare(installation: Installation): Promise<Context> {
  await installation.start();
  const enrollment = await installation.authorizeEnrollment(assetId, recoveryKey.publicKey);
  const operator = await installation.operator();
  const link = await installation.link();
  const asset = new AssetClient({
    ...link,
    assetId,
    credential,
    enrollmentToken: enrollment,
    signer: processSigner(processKey),
  });
  const directOperator = await directProtocol(installation);
  const directAsset = new DirectProtocol(installation.baseUrl, await installation.ca(), credential);
  await directOperator.discover();
  directAsset.datasetId = directOperator.datasetId;
  return {
    installation,
    enrollment,
    taskId: "",
    sdk: { operator, asset },
    direct: { operator: directOperator, asset: directAsset },
  };
}

const modes = { sdk: await prepare(await newInstallation()), direct: await prepare(await newInstallation()) };
const normalizeSDK = normalizer();
const normalizeDirect = normalizer();
const routes = new Set<string>();
for (const scenario of steps) {
  const sdk = await scenario.sdk(modes.sdk);
  const direct = await scenario.direct(modes.direct);
  for (const [mode, observation] of [
    ["SDK", sdk],
    ["direct Protocol", direct],
  ] as const) {
    assert.equal(
      observation.status,
      scenario.expect.status,
      `${scenario.name} (${mode}): ${JSON.stringify(observation)}`,
    );
    assert.equal(observation.code, scenario.expect.code, `${scenario.name} (${mode})`);
  }
  assert.deepEqual(
    normalizeSDK(sdk.value),
    normalizeDirect(direct.value),
    `${scenario.name}: SDK and direct results agree`,
  );
  routes.add(scenario.name.split(" ").slice(0, 2).join(" "));
}
step(
  `${steps.length} independently specified steps over ${routes.size} method/path pairs agree between SDK and direct Protocol`,
);

// GET /docs is an HTML page for browsers that the SDK deliberately does not
// wrap; it is checked through direct Protocol only.
const docs = await modes.direct.direct.operator.request("GET", "/docs");
assert.equal(docs.status, 200);
assert.match(docs.headers["content-type"] ?? "", /^text\/html/u);
routes.add("GET /docs");
assert.equal(routes.size, 19, `covered routes: ${[...routes].sort().join(", ")}`);
step("GET /docs is the one deliberately unwrapped route; all 19 method/path pairs are exercised");

for (const mode of Object.values(modes)) await mode.installation.stop();
