import createTransport from "openapi-fetch";
import protocol from "../generated/protocol.json" with { type: "json" };
import type { components, paths } from "../generated/protocol.js";
import { responseValidation, ResponseValidationError, sameDataset } from "./response.js";
import { contractValidator } from "./schema.js";
import { canonicalJSON } from "./facts.js";

type S = components["schemas"];
export type Outcome<T> =
  | { outcome: "accepted"; value: T }
  | { outcome: "rejected"; error: S["Error"] }
  | { outcome: "unknown_outcome"; reason: "transport" | "protocol" }
  | { outcome: "dataset_invalidated"; previousDatasetId: string; datasetId: string }
  | {
      outcome: "not_submitted";
      reason: "not_discovered" | "authentication" | "unsupported_version" | "invalid_descriptor";
    };

interface Descriptor<Operation extends string, Body> {
  format: 1;
  operation: Operation;
  datasetId: string;
  protocolVersion: string;
  targetId: string | null;
  body: Body;
}
export type PreparedRegistration = Descriptor<"register_asset", S["RegisterAssetRequest"]>;
export type PreparedCheckin = Descriptor<"checkin", S["CheckinRequest"]>;
export type PreparedEntityReport = Descriptor<"entity_report", S["EntityReportRequest"]>;
export type PreparedDescriptiveEdit = Descriptor<"descriptive_edit", S["DescriptiveEditRequest"]>;
export type PreparedStatusReport = Descriptor<"status_report", S["StatusReportRequest"]>;
export type PreparedTask = Descriptor<"task_create", S["CreateTaskRequest"]>;
export type PreparedTaskReport = Descriptor<"task_report", S["TaskReportRequest"]>;
export type PreparedCancellation = Descriptor<"cancellation_request", S["RequestCancellationRequest"]>;
export type PreparedDeletion = Descriptor<"delete_entity", null>;
export type PreparedMutation =
  | PreparedRegistration
  | PreparedCheckin
  | PreparedEntityReport
  | PreparedDescriptiveEdit
  | PreparedStatusReport
  | PreparedTask
  | PreparedTaskReport
  | PreparedCancellation
  | PreparedDeletion;
export type MutationOutcome<T, D extends PreparedMutation = PreparedMutation> = Outcome<T> & { descriptor: D };
export type MutationValue =
  | S["RegistrationResponse"]
  | S["EntityPatchResponse"]
  | S["StatusReportResponse"]
  | S["TaskStatusResponse"]
  | undefined;
export interface AtlasClientOptions {
  baseUrl: string;
  bootstrapContext?: { datasetId: string; protocolVersion: string };
  credential: () => string | Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxJSONBytes?: number;
}
export type DiscoveryQuery = NonNullable<paths["/health"]["get"]["parameters"]["query"]>;
export type EntityListQuery = Omit<
  NonNullable<paths["/entities"]["get"]["parameters"]["query"]>,
  "ids" | "type" | "alias"
> & {
  ids?: S["IdentifierFilter"];
  type?: S["EntityTypeFilter"];
  alias?: string;
};
export type TaskListQuery = Omit<
  NonNullable<paths["/tasks"]["get"]["parameters"]["query"]>,
  "ids" | "asset_id" | "status" | "scheduling"
> & {
  ids?: S["IdentifierFilter"];
  asset_id?: S["AssetIDFilter"] | string;
  status?: S["TaskStatusFilter"] | S["TaskStatus"];
  scheduling?: S["TaskSchedulingFilter"];
};
export type AssignedTaskQuery = Omit<
  NonNullable<paths["/entities/{entity_id}/tasks"]["get"]["parameters"]["query"]>,
  "ids" | "status" | "scheduling"
> & {
  ids?: S["IdentifierFilter"];
  status?: S["TaskStatusFilter"] | S["TaskStatus"];
  scheduling?: S["TaskSchedulingFilter"];
};
export type MovementHistoryQuery = NonNullable<
  paths["/entities/{entity_id}/movement-history"]["get"]["parameters"]["query"]
>;

type TransportResult<T> =
  { data: T; error?: never; response: Response } | { error: S["Error"] | undefined; data?: never; response: Response };
type RequestHeaders = { Authorization: string; "Atlas-Dataset-ID": string; "Atlas-Protocol-Version": string };

function entityQuery(query: EntityListQuery) {
  const { ids, type, alias, ...paging } = query;
  return {
    ...paging,
    ...(ids === undefined ? {} : { ids: JSON.stringify(ids) }),
    ...(type === undefined ? {} : { type: JSON.stringify(type) }),
    ...(alias === undefined ? {} : { alias: JSON.stringify(alias) }),
  };
}
function taskQuery(query: TaskListQuery) {
  const { ids, asset_id, status, scheduling, ...paging } = query;
  return {
    ...paging,
    ...(ids === undefined ? {} : { ids: JSON.stringify(ids) }),
    ...(asset_id === undefined
      ? {}
      : { asset_id: JSON.stringify(typeof asset_id === "string" ? [asset_id] : asset_id) }),
    ...(status === undefined ? {} : { status: JSON.stringify(typeof status === "string" ? [status] : status) }),
    ...(scheduling === undefined ? {} : { scheduling: JSON.stringify(scheduling) }),
  };
}
let compiled: ReturnType<typeof compileDescriptors> | undefined;
function descriptors() {
  return (compiled ??= compileDescriptors());
}
function compileDescriptors() {
  const validator = contractValidator(protocol);
  function descriptorValidator<T>(operation: string, bodySchema: string | null, targeted: boolean) {
    return validator.compile<T>({
      type: "object",
      additionalProperties: false,
      required: ["format", "operation", "datasetId", "protocolVersion", "targetId", "body"],
      properties: {
        format: { const: 1 },
        operation: { const: operation },
        datasetId: { $ref: "atlas#/components/schemas/Identifier" },
        protocolVersion: { const: protocol.info.version },
        targetId: targeted ? { $ref: "atlas#/components/schemas/Identifier" } : { type: "null" },
        body: bodySchema ? { $ref: `atlas#/components/schemas/${bodySchema}` } : { type: "null" },
      },
    });
  }
  return [
    descriptorValidator<PreparedRegistration>("register_asset", "RegisterAssetRequest", false),
    descriptorValidator<PreparedCheckin>("checkin", "CheckinRequest", true),
    descriptorValidator<PreparedEntityReport>("entity_report", "EntityReportRequest", true),
    descriptorValidator<PreparedDescriptiveEdit>("descriptive_edit", "DescriptiveEditRequest", true),
    descriptorValidator<PreparedStatusReport>("status_report", "StatusReportRequest", true),
    descriptorValidator<PreparedTask>("task_create", "CreateTaskRequest", false),
    descriptorValidator<PreparedTaskReport>("task_report", "TaskReportRequest", true),
    descriptorValidator<PreparedCancellation>("cancellation_request", "RequestCancellationRequest", true),
    descriptorValidator<PreparedDeletion>("delete_entity", null, true),
  ];
}
let successes: ReturnType<typeof compileSuccesses> | undefined;
function successValidators() {
  return (successes ??= compileSuccesses());
}
function compileSuccesses() {
  const ajv = contractValidator(protocol);
  return new Map(
    ["EntityReportResponse", "AssetMutationResponse", "TaskReportResponse", "TaskMutationResponse"].map((name) => [
      name,
      ajv.compile({ $ref: `atlas#/components/schemas/${name}` }),
    ]),
  );
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function restoreMutation(value: unknown): PreparedMutation {
  for (const validate of descriptors()) {
    if (validate(value)) {
      canonicalJSON(value);
      return freeze(structuredClone(value));
    }
  }
  throw new Error("Invalid retained Atlas mutation descriptor");
}

export function createAtlasClient(options: AtlasClientOptions) {
  return new AtlasHTTPClient(options);
}
export type AtlasClient = ReturnType<typeof createAtlasClient>;

class AtlasHTTPClient {
  private readonly transport;
  private datasetId: string | undefined;
  private epoch = 0;
  private bootstrapping = false;
  private readonly credential;
  private readonly timeoutMs: number;
  constructor(options: AtlasClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("Atlas requires a credential-free HTTPS base URL");
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("Atlas timeout must be a positive safe integer");
    const supplier = options.fetch ?? defaultHTTPSFetch(options.maxJSONBytes ?? 1048576, timeoutMs);
    this.credential = options.credential;
    this.timeoutMs = timeoutMs;
    if (options.bootstrapContext) {
      const validate = contractValidator(protocol).compile<{ datasetId: string; protocolVersion: string }>({
        type: "object",
        additionalProperties: false,
        required: ["datasetId", "protocolVersion"],
        properties: {
          datasetId: { $ref: "atlas#/components/schemas/Identifier" },
          protocolVersion: { const: protocol.info.version },
        },
      });
      if (!validate(options.bootstrapContext)) throw new Error("Invalid or unsupported Atlas bootstrap context");
      this.datasetId = options.bootstrapContext.datasetId;
      this.bootstrapping = true;
    }
    this.transport = createTransport<paths>({
      baseUrl: options.baseUrl,
      fetch: (request) =>
        supplier(
          new Request(request, {
            redirect: "error",
          }),
        ),
    });
    this.transport.use(
      responseValidation(protocol, {}, { maxJSONBytes: options.maxJSONBytes ?? 1048576, allowDatasetChange: true }),
    );
  }
  context() {
    return this.datasetId === undefined
      ? undefined
      : Object.freeze({ datasetId: this.datasetId, protocolVersion: protocol.info.version });
  }
  restoreMutation(value: unknown) {
    return restoreMutation(value);
  }
  private prepare<K extends string, B>(operation: K, targetId: string | null, body: B): Descriptor<K, B> {
    if (!this.datasetId) throw new Error("Discover Atlas before preparing a mutation");
    const descriptor = {
      format: 1,
      operation,
      datasetId: this.datasetId,
      protocolVersion: protocol.info.version,
      targetId,
      body,
    } as const;
    restoreMutation(descriptor);
    return freeze(structuredClone(descriptor));
  }
  prepareRegistration(body: S["RegisterAssetRequest"]): PreparedRegistration {
    return this.prepare("register_asset", null, body);
  }
  prepareCheckin(assetId: string, body: S["CheckinRequest"]): PreparedCheckin {
    return this.prepare("checkin", assetId, body);
  }
  prepareReport(assetId: string, body: S["EntityReportRequest"]): PreparedEntityReport {
    return this.prepare("entity_report", assetId, body);
  }
  prepareEdit(assetId: string, body: S["DescriptiveEditRequest"]): PreparedDescriptiveEdit {
    return this.prepare("descriptive_edit", assetId, body);
  }
  prepareStatus(assetId: string, body: S["StatusReportRequest"]): PreparedStatusReport {
    return this.prepare("status_report", assetId, body);
  }
  prepareTask(body: S["CreateTaskRequest"]): PreparedTask {
    return this.prepare("task_create", null, body);
  }
  prepareTaskReport(taskId: string, body: S["TaskReportRequest"]): PreparedTaskReport {
    return this.prepare("task_report", taskId, body);
  }
  prepareCancellation(taskId: string, body: S["RequestCancellationRequest"]): PreparedCancellation {
    return this.prepare("cancellation_request", taskId, body);
  }
  prepareDeletion(assetId: string): PreparedDeletion {
    return this.prepare("delete_entity", assetId, null);
  }

  async discover(query: DiscoveryQuery = {}): Promise<Outcome<S["HealthResponse"]>> {
    const epoch = this.epoch;
    using deadline = this.deadline();
    const headers = await this.authorize(deadline.signal);
    if (!headers) return { outcome: "not_submitted", reason: "authentication" };
    try {
      const result = await this.transport.GET("/health", { params: { query }, headers, signal: deadline.signal });
      if (result.data && !result.data.data.supported_protocol_versions.includes(protocol.info.version))
        return { outcome: "not_submitted", reason: "unsupported_version" };
      const outcome = this.interpret(result, undefined, epoch);
      if (outcome.outcome === "accepted") this.bootstrapping = false;
      return outcome;
    } catch (error) {
      return {
        outcome: "unknown_outcome",
        reason: error instanceof ResponseValidationError ? "protocol" : "transport",
      };
    }
  }
  getEntity(entityId: string) {
    return this.read((header, signal) =>
      this.transport.GET("/entities/{entity_id}", { params: { path: { entity_id: entityId }, header }, signal }),
    );
  }
  getEntityByAlias(alias: string) {
    return this.read((header, signal) =>
      this.transport.GET("/entities/alias/{alias}", { params: { path: { alias }, header }, signal }),
    );
  }
  listEntities(query: EntityListQuery = {}) {
    return this.read((header, signal) =>
      this.transport.GET("/entities", { params: { query: entityQuery(query), header }, signal }),
    );
  }
  getStatus(entityId: string) {
    return this.read((header, signal) =>
      this.transport.GET("/entities/{entity_id}/status", { params: { path: { entity_id: entityId }, header }, signal }),
    );
  }
  getAssignedTasks(entityId: string, query: AssignedTaskQuery = {}) {
    return this.read((header, signal) =>
      this.transport.GET("/entities/{entity_id}/tasks", {
        params: { path: { entity_id: entityId }, query: taskQuery(query), header },
        signal,
      }),
    );
  }
  getMovementHistory(entityId: string, query: MovementHistoryQuery) {
    return this.read((header, signal) =>
      this.transport.GET("/entities/{entity_id}/movement-history", {
        params: { path: { entity_id: entityId }, query, header },
        signal,
      }),
    );
  }
  getTask(taskId: string) {
    return this.read((header, signal) =>
      this.transport.GET("/tasks/{task_id}", { params: { path: { task_id: taskId }, header }, signal }),
    );
  }
  listTasks(query: TaskListQuery = {}) {
    return this.read((header, signal) =>
      this.transport.GET("/tasks", { params: { query: taskQuery(query), header }, signal }),
    );
  }
  readiness() {
    return this.read((header, signal) => this.transport.GET("/readiness", { headers: header, signal }));
  }
  documentation() {
    return this.read((headers, signal) => this.transport.GET("/docs", { headers, parseAs: "text", signal }));
  }
  openapi() {
    return this.read((headers, signal) => this.transport.GET("/openapi.json", { headers, signal }));
  }

  private async read<T>(
    request: (headers: RequestHeaders, signal: AbortSignal) => Promise<TransportResult<T>>,
  ): Promise<Outcome<T>> {
    const previous = this.datasetId;
    const epoch = this.epoch;
    if (!previous || this.bootstrapping) return { outcome: "not_submitted", reason: "not_discovered" };
    using deadline = this.deadline();
    const authorization = await this.authorize(deadline.signal);
    if (!authorization) return { outcome: "not_submitted", reason: "authentication" };
    const headers = { ...authorization, "Atlas-Dataset-ID": previous };
    try {
      return this.interpret(await request(headers, deadline.signal), previous, epoch);
    } catch (error) {
      return {
        outcome: "unknown_outcome",
        reason: error instanceof ResponseValidationError ? "protocol" : "transport",
      };
    }
  }
  private deadline() {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Atlas call timed out", "TimeoutError")),
      this.timeoutMs,
    );
    return { signal: controller.signal, [Symbol.dispose]: () => clearTimeout(timer) };
  }
  private async authorize(signal: AbortSignal) {
    let expired = () => {};
    const cancelled = new Promise<undefined>((resolve) => {
      expired = () => resolve(undefined);
      signal.addEventListener("abort", expired, { once: true });
      if (signal.aborted) expired();
    });
    try {
      const credential = await Promise.race([this.credential(), cancelled]);
      if (!credential || signal.aborted || /[\r\n]/u.test(credential)) return undefined;
      return { Authorization: `Bearer ${credential}`, "Atlas-Protocol-Version": protocol.info.version };
    } catch {
      return undefined;
    } finally {
      signal.removeEventListener("abort", expired);
    }
  }
  private interpret<T>(
    result: TransportResult<T>,
    previous: string | undefined,
    epoch: number,
    expected?: "EntityReportResponse" | "AssetMutationResponse" | "TaskReportResponse" | "TaskMutationResponse",
  ): Outcome<T> {
    const actual = result.response.headers.get("Atlas-Dataset-ID");
    if (!actual || result.response.headers.get("Atlas-Protocol-Version") !== protocol.info.version)
      return { outcome: "unknown_outcome", reason: "protocol" };
    // A delayed response must not replace a Dataset established by a newer reply.
    if (this.epoch !== epoch && this.datasetId && (!previous || !sameDataset(previous, this.datasetId))) {
      return { outcome: "dataset_invalidated", previousDatasetId: previous ?? actual, datasetId: this.datasetId };
    }
    if (previous && !sameDataset(actual, previous)) {
      this.datasetId = actual;
      this.epoch++;
      return { outcome: "dataset_invalidated", previousDatasetId: previous, datasetId: actual };
    }
    if (!previous && (!this.datasetId || !sameDataset(this.datasetId, actual))) {
      this.datasetId = actual;
      this.epoch++;
    }
    if ("error" in result) {
      return result.error === undefined
        ? { outcome: "unknown_outcome", reason: "protocol" }
        : { outcome: "rejected", error: result.error };
    }
    if (expected && !successValidators().get(expected)?.(result.data))
      return { outcome: "unknown_outcome", reason: "protocol" };
    return { outcome: "accepted", value: result.data };
  }

  submit(descriptor: PreparedRegistration): Promise<MutationOutcome<S["RegistrationResponse"], PreparedRegistration>>;
  submit(descriptor: PreparedCheckin): Promise<MutationOutcome<S["EntityReportResponse"], PreparedCheckin>>;
  submit(descriptor: PreparedEntityReport): Promise<MutationOutcome<S["EntityReportResponse"], PreparedEntityReport>>;
  submit(
    descriptor: PreparedDescriptiveEdit,
  ): Promise<MutationOutcome<S["AssetMutationResponse"], PreparedDescriptiveEdit>>;
  submit(descriptor: PreparedStatusReport): Promise<MutationOutcome<S["StatusReportResponse"], PreparedStatusReport>>;
  submit(descriptor: PreparedTask): Promise<MutationOutcome<S["TaskMutationResponse"], PreparedTask>>;
  submit(descriptor: PreparedTaskReport): Promise<MutationOutcome<S["TaskReportResponse"], PreparedTaskReport>>;
  submit(descriptor: PreparedCancellation): Promise<MutationOutcome<S["TaskMutationResponse"], PreparedCancellation>>;
  submit(descriptor: PreparedDeletion): Promise<MutationOutcome<undefined, PreparedDeletion>>;
  submit(descriptor: PreparedMutation): Promise<MutationOutcome<MutationValue>>;
  async submit(input: PreparedMutation): Promise<MutationOutcome<MutationValue>> {
    let descriptor: PreparedMutation;
    try {
      descriptor = restoreMutation(input);
    } catch {
      return { outcome: "not_submitted", reason: "invalid_descriptor", descriptor: input };
    }
    return { ...(await this.transmit(descriptor)), descriptor };
  }
  private async transmit(descriptor: PreparedMutation): Promise<Outcome<MutationValue>> {
    if (!this.datasetId || (this.bootstrapping && descriptor.operation !== "register_asset"))
      return { outcome: "not_submitted", reason: "not_discovered" };
    if (!sameDataset(descriptor.datasetId, this.datasetId))
      return { outcome: "dataset_invalidated", previousDatasetId: descriptor.datasetId, datasetId: this.datasetId };
    using deadline = this.deadline();
    const authorization = await this.authorize(deadline.signal);
    if (!authorization) return { outcome: "not_submitted", reason: "authentication" };
    if (!sameDataset(descriptor.datasetId, this.datasetId))
      return { outcome: "dataset_invalidated", previousDatasetId: descriptor.datasetId, datasetId: this.datasetId };
    const epoch = this.epoch;
    const header = { ...authorization, "Atlas-Dataset-ID": descriptor.datasetId };
    try {
      switch (descriptor.operation) {
        case "register_asset": {
          const outcome = this.interpret(
            await this.transport.POST("/entities", {
              body: descriptor.body,
              params: { header },
              signal: deadline.signal,
            }),
            descriptor.datasetId,
            epoch,
          );
          if (outcome.outcome === "accepted") this.bootstrapping = false;
          return outcome;
        }
        case "task_create":
          return this.interpret(
            await this.transport.POST("/tasks", { body: descriptor.body, params: { header }, signal: deadline.signal }),
            descriptor.datasetId,
            epoch,
          );
        case "checkin":
          return this.interpret(
            await this.transport.POST("/entities/{entity_id}/checkin", {
              body: descriptor.body,
              params: { path: { entity_id: requiredTarget(descriptor) }, header },
              signal: deadline.signal,
            }),
            descriptor.datasetId,
            epoch,
          );
        case "entity_report":
        case "descriptive_edit":
          return this.interpret(
            await this.transport.PATCH("/entities/{entity_id}", {
              body: descriptor.body,
              params: { path: { entity_id: requiredTarget(descriptor) }, header },
              signal: deadline.signal,
            }),
            descriptor.datasetId,
            epoch,
            descriptor.operation === "entity_report" ? "EntityReportResponse" : "AssetMutationResponse",
          );
        case "status_report":
          return this.interpret(
            await this.transport.PATCH("/entities/{entity_id}/status", {
              body: descriptor.body,
              params: { path: { entity_id: requiredTarget(descriptor) }, header },
              signal: deadline.signal,
            }),
            descriptor.datasetId,
            epoch,
          );
        case "task_report":
        case "cancellation_request":
          return this.interpret(
            await this.transport.PATCH("/tasks/{task_id}/status", {
              body: descriptor.body,
              params: { path: { task_id: requiredTarget(descriptor) }, header },
              signal: deadline.signal,
            }),
            descriptor.datasetId,
            epoch,
            descriptor.operation === "task_report" ? "TaskReportResponse" : "TaskMutationResponse",
          );
        case "delete_entity":
          return this.interpret(
            await this.transport.DELETE("/entities/{entity_id}", {
              params: { path: { entity_id: requiredTarget(descriptor) }, header },
              signal: deadline.signal,
            }),
            descriptor.datasetId,
            epoch,
          );
      }
    } catch (error) {
      return {
        outcome: "unknown_outcome",
        reason: error instanceof ResponseValidationError ? "protocol" : "transport",
      };
    }
  }
}
function requiredTarget(descriptor: PreparedMutation) {
  if (descriptor.targetId === null) throw new Error("Missing Atlas mutation target");
  return descriptor.targetId;
}

function defaultHTTPSFetch(maxJSONBytes: number, timeoutMs: number): typeof fetch {
  let supplier: Promise<typeof fetch> | undefined;
  return async (input, init) => {
    supplier ??= import("./node.js").then(({ createHTTPSFetch }) => createHTTPSFetch({ maxJSONBytes, timeoutMs }));
    return (await supplier)(input, init);
  };
}
