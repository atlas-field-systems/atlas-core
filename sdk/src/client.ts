import createClient from "openapi-fetch";
import { taskStatusValues, type components, type paths } from "./generated/protocol.js";
import { newAssetCredential } from "./credentials.js";
import { PictureError, WaitTimeoutError, unwrap } from "./errors.js";
import { FeedConnection } from "./feed.js";
import { commandCatalog } from "./generated/catalog.js";
import { HttpReads } from "./http-reads.js";
import { Picture } from "./picture.js";
import { Synchronization } from "./synchronization.js";
import type { AssetStatus, ChangeListener, EntityReads, Operation, OperationReport, OperationSubmission, Readiness, Task, TaskSubmission, TaskStatusUpdate } from "./types.js";

type Schemas = components["schemas"];
export type AssetEnrollmentFacts = Pick<Schemas["AssetEnrollmentRequest"], "alias" | "subtype" | "components" | "command_manifest">;

/**
 * Everything an Asset needs to enroll and retry. Persist it before the first
 * attempt: a retry must reuse the same request ID and credential.
 */
export interface AssetEnrollmentIdentity {
  datasetId: string;
  assetId: string;
  requestId: string;
  credential: string;
}

export interface AssetStatusReport {
  datasetId: string;
  reportId: string;
  sequence: number;
  status: AssetStatus;
}

/** A check-in or partial update; see the Protocol AssetReport schema for merge rules. */
export interface AssetReport {
  datasetId: string;
  reportId: string;
  sequence: number;
  components?: Schemas["AssetComponentPatch"];
  commandManifest?: Schemas["CommandSupport"][];
}

export interface AtlasClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** "http" reads Core on every call; "full" serves reads from a synchronized local picture. Default "http". */
  mode?: "http" | "full";
  /** Entities a full picture may hold before synchronization fails. Default 10,000. */
  maxEntities?: number;
  /** Tasks a full picture may hold before synchronization fails. Default 10,000. */
  maxTasks?: number;
  /** Changes kept for local changedSince reads. Default 1,000. */
  localHistoryLimit?: number;
  /** Entities per snapshot request while loading a full picture. Default 100. */
  snapshotPageSize?: number;
  webSocketFactory?: (url: string) => WebSocket;
  /** Receives exceptions thrown by change listeners. Default console.error. */
  onListenerError?: (error: unknown) => void;
}

/** How long waitForSynchronization and waitForOperation wait by default. */
const defaultWaitMs = 10_000;

/** How often waitForOperation reads an attempt; outcomes are not on the feed. */
const operationPollMs = 100;

const taskStatuses = Object.fromEntries(taskStatusValues.map((status) => [status, status]));

const terminalStatuses: ReadonlySet<Operation["status"]> = new Set(["completed", "canceled", "failed", "interrupted"]);

export interface Page {
  cursor?: string;
  limit?: number;
}

/** Authenticated access to one Core. Reads behave the same in either mode. */
export class AtlasClient {
  readonly #api: ReturnType<typeof createClient<paths>>;
  readonly #reads: EntityReads;
  readonly #picture?: Picture;
  readonly #synchronization?: Synchronization;

  constructor(options: AtlasClientOptions) {
    this.#api = createClient<paths>({ baseUrl: options.baseUrl, headers: { Authorization: `Bearer ${options.apiKey}` }, fetch: options.fetch });
    const onListenerError = options.onListenerError ?? console.error;
    const openSocket = () => (options.webSocketFactory ?? ((url) => new WebSocket(url)))(feedUrl(options.baseUrl));
    const http = new HttpReads(this.#api, openSocket, options.apiKey, onListenerError);
    if (options.mode !== "full") {
      this.#reads = http;
      return;
    }
    this.#picture = new Picture({ maxEntities: options.maxEntities ?? 10_000, maxTasks: options.maxTasks ?? 10_000, localHistoryLimit: options.localHistoryLimit ?? 1_000 }, onListenerError);
    this.#reads = this.#picture;
    this.#synchronization = new Synchronization(this.#picture, {
      snapshotPage: (cursor, limit) => http.queryFull(cursor, limit),
      changesSince: (cursor, limit) => http.changedSince(cursor, limit),
      openFeed: () => FeedConnection.open(openSocket(), options.apiKey),
    }, options.snapshotPageSize ?? 100);
  }

  async health() {
    return unwrap(await this.#api.GET("/health"));
  }

  /** Returns dependency states; an unavailable dependency is a result, not an error. */
  async readiness(): Promise<Readiness> {
    const result = await this.#api.GET("/readiness");
    if (result.error && "dependencies" in result.error) return result.error;
    return unwrap(result);
  }

  async dataset() {
    return unwrap(await this.#api.GET("/dataset"));
  }

  /** Allocates a new Asset identity for the current Dataset. */
  async prepareAssetEnrollment(): Promise<AssetEnrollmentIdentity> {
    const dataset = await this.dataset();
    return { datasetId: dataset.id, assetId: crypto.randomUUID(), requestId: crypto.randomUUID(), credential: newAssetCredential() };
  }

  /** Enrolls, or retries an enrollment of, a prepared Asset identity. */
  async enrollAsset(identity: AssetEnrollmentIdentity, facts: AssetEnrollmentFacts = {}) {
    const body = { dataset_id: identity.datasetId, id: identity.assetId, request_id: identity.requestId, kind: "asset" as const, credential: identity.credential, ...facts };
    return unwrap(await this.#api.POST("/entities", { body }));
  }

  /** Reports this Asset's status. Resending a report ID with the same facts is safe. */
  async reportAssetStatus(id: string, report: AssetStatusReport) {
    const body = { dataset_id: report.datasetId, report_id: report.reportId, sequence: report.sequence, status: report.status };
    return unwrap(await this.#api.PATCH("/entities/{entity_id}/status", { params: { path: { entity_id: id } }, body }));
  }

  /** Reports changed components of this Asset. */
  async patchEntity(id: string, report: AssetReport) {
    return unwrap(await this.#api.PATCH("/entities/{entity_id}", { params: { path: { entity_id: id } }, body: reportBody(report) }));
  }

  /** Checks in, reporting current state and contact. */
  async checkInAsset(id: string, report: AssetReport) {
    return unwrap(await this.#api.POST("/entities/{entity_id}/checkin", { params: { path: { entity_id: id } }, body: reportBody(report) }));
  }

  /** Prepare once, then persist and reuse this identity after an uncertain response. */
  async prepareMoveTo(assetId: string, input: TaskSubmission["input"]): Promise<TaskSubmission> {
    const dataset = await this.dataset();
    return { dataset_id: dataset.id, submission_id: crypto.randomUUID(), asset_id: assetId, command_id: commandCatalog.move_to.id, input, scheduling: commandCatalog.move_to.scheduling[0] };
  }

  /** Returns as soon as Core commits the Task, independently of local catch-up. */
  async submitTask(submission: TaskSubmission): Promise<Task> {
    return unwrap(await this.#api.POST("/tasks", { body: submission }));
  }

  /** Persist requestId before sending so an uncertain response can be retried. */
  async cancelTask(id: string, datasetId: string, requestId: string): Promise<Task> {
    return unwrap(await this.#api.PATCH("/tasks/{task_id}/status", { params: { path: { task_id: id } }, body: { dataset_id: datasetId, status: taskStatuses.cancellation_requested, request_id: requestId } }));
  }

  /** For the assigned Asset: report execution with a stable report identity. */
  async reportTask(id: string, update: TaskStatusUpdate): Promise<Task> {
    return unwrap(await this.#api.PATCH("/tasks/{task_id}/status", { params: { path: { task_id: id } }, body: update }));
  }

  async plugins(page: Page = {}) {
    return unwrap(await this.#api.GET("/plugins", { params: { query: page } }));
  }

  async plugin(id: string) {
    return unwrap(await this.#api.GET("/plugins/{plugin_id}", { params: { path: { plugin_id: id } } }));
  }

  /**
   * Prepares a submission for the current Dataset. Keep it to retry: a
   * retry with the same submission returns the original attempt.
   */
  async prepareOperation(capability: string, input: OperationSubmission["input"]): Promise<OperationSubmission> {
    const dataset = await this.dataset();
    return { dataset_id: dataset.id, submission_id: crypto.randomUUID(), capability, input };
  }

  /** Submits, or retries a submission of, a durable Operation attempt. */
  async submitOperation(pluginId: string, submission: OperationSubmission) {
    return unwrap(await this.#api.POST("/plugins/{plugin_id}/operations", { params: { path: { plugin_id: pluginId } }, body: submission }));
  }

  async operation(pluginId: string, id: string) {
    return unwrap(await this.#api.GET("/plugins/{plugin_id}/operations/{operation_id}", { params: { path: { plugin_id: pluginId, operation_id: id } } }));
  }

  async operations(pluginId: string, page: Page = {}) {
    return unwrap(await this.#api.GET("/plugins/{plugin_id}/operations", { params: { path: { plugin_id: pluginId }, query: page } }));
  }

  /**
   * Requests cancellation. An undispatched attempt is canceled at once; a
   * dispatched one waits for the Plugin's outcome. It never stops the Plugin.
   */
  async cancelOperation(pluginId: string, id: string) {
    return unwrap(await this.#api.POST("/plugins/{plugin_id}/operations/{operation_id}/cancel", { params: { path: { plugin_id: pluginId, operation_id: id } } }));
  }

  /** Resolves with the attempt once it reaches a terminal status. */
  async waitForOperation(pluginId: string, id: string, timeoutMs = defaultWaitMs): Promise<Operation> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const operation = await this.operation(pluginId, id);
      if (terminalStatuses.has(operation.status)) return operation;
      if (Date.now() >= deadline) throw new WaitTimeoutError("The Operation has no outcome yet.");
      await new Promise((resolve) => setTimeout(resolve, operationPollMs));
    }
  }

  /** For a Plugin: reports progress or an outcome of one of its own attempts. */
  async reportOperation(pluginId: string, id: string, report: OperationReport) {
    return unwrap(await this.#api.POST("/plugins/{plugin_id}/operations/{operation_id}/reports", { params: { path: { plugin_id: pluginId, operation_id: id } }, body: report }));
  }

  entity(id: string) { return this.#reads.entity(id); }
  assetStatus(id: string) { return this.#reads.assetStatus(id); }
  task(id: string) { return this.#reads.task(id); }
  tasks(page: Page = {}) { return this.#reads.tasks(page.cursor, page.limit); }
  assignedTasks(assetId: string, page: Page = {}) { return this.#reads.assignedTasks(assetId, page.cursor, page.limit); }
  queryFull(cursor?: string, limit?: number) { return this.#reads.queryFull(cursor, limit); }
  changedSince(cursor: string, limit?: number) { return this.#reads.changedSince(cursor, limit); }
  subscribeFeed(listener: ChangeListener) { return this.#reads.subscribe(listener); }

  get synchronization() {
    return this.#picture?.status ?? { state: "http" as const, datasetId: null, sequence: null, generation: null };
  }

  /** Loads the full picture and follows Core; resolves when local reads are ready. */
  startSynchronization() { return this.#requireSynchronization().start(); }

  stopSynchronization() { this.#synchronization?.stop(); }

  /** Resolves once the local picture includes the commit that returned a resource. */
  waitForSynchronization(receipt: Pick<Task, "dataset_id" | "change_sequence" | "receipt_sequence">, timeoutMs = defaultWaitMs) {
    this.#requireSynchronization();
    return this.#picture!.waitFor(receipt, timeoutMs);
  }

  #requireSynchronization(): Synchronization {
    if (!this.#synchronization) throw new PictureError("unsupported", "This client reads over HTTP; create it with mode \"full\" to synchronize.");
    return this.#synchronization;
  }
}

function reportBody(report: AssetReport) {
  return {
    dataset_id: report.datasetId,
    report_id: report.reportId,
    sequence: report.sequence,
    ...(report.components === undefined ? {} : { components: report.components }),
    ...(report.commandManifest === undefined ? {} : { command_manifest: report.commandManifest }),
  };
}

function feedUrl(baseUrl: string): string {
  const url = new URL("/feed", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
