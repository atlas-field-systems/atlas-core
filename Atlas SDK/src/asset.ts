import type { components } from "../generated/protocol.js";
import type { AtlasClient, Outcome, PreparedMutation, PreparedTaskReport } from "./client.js";
import { canonicalJSON, digest, base64URL } from "./facts.js";
import { sameDataset } from "./response.js";

type S = components["schemas"];
export type Position = S["Position"];
export type MoveToProgress = S["MoveToProgress"];
export type TaskFailure = S["TaskFailure"];
export type TaskCancellationResponse = S["CancellationResponse"];
export type EvidenceOrigin = S["EvidenceOrigin"];
export interface ProcessSigner {
  readonly processId: string;
  readonly publicKey: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}
export interface ReplacementAuthorizer {
  authorize(bytes: Uint8Array): Promise<Uint8Array>;
}
export interface AssetProcessSnapshot {
  assetId: string;
  datasetId: string;
  processId: string;
  processGeneration: string | null;
  nextSequence: string;
}
export interface RetainedTaskOutcome {
  status: "completed" | "failed" | "cancelled";
  failure?: TaskFailure;
  cancellationResponse?: TaskCancellationResponse;
}
export interface RetainedExecutionEvidence {
  taskId: string;
  executionId: string | null;
  executionCount: number;
  state: "completed" | "running" | "suspended" | "not_started" | "unknown";
  progress: MoveToProgress;
  generatedAt: string | null;
  acknowledgedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  observationTimes?: S["ReportContext"]["observation_times"];
  originalReport?: { fields: TaskReportFields; timing: ReportTiming };
  origin: EvidenceOrigin;
  retainedEvidenceId: string | null;
  outcome: RetainedTaskOutcome | null;
  heldContinuation: string[];
}
export interface RetainedAssetSnapshot extends AssetProcessSnapshot {
  executions: RetainedExecutionEvidence[];
  pending: PreparedMutation[];
}
export interface ReconciliationPlan {
  tasks: S["Task"][];
  reports: PreparedTaskReport[];
  heldTaskIds: string[];
  pending: PreparedMutation[];
}
export interface AssetClientOptions {
  client: AtlasClient;
  assetId: string;
  signer: ProcessSigner;
  authorizer: ReplacementAuthorizer;
  processGeneration?: string;
  nextSequence?: string;
}
export interface ReportTiming {
  generatedAt: string | null;
  observationTimes?: S["ReportContext"]["observation_times"];
  clockUncertaintyMs?: number | null;
}
export interface ReportOptions extends ReportTiming {
  contactChallenge?: string | null;
  evidence?: { kind: "historical"; origin: EvidenceOrigin; retainedEvidenceId: string | null };
}
export interface ComponentReportOptions extends ReportOptions {
  components?: S["ReportedComponents"];
  commandManifest?: S["CommandManifest"];
}
export interface AuthorityOptions extends ComponentReportOptions {
  expectedGeneration: string;
  transferId: string;
}
export type TaskReportFields = Omit<S["TaskReportRequest"], "kind" | "report_context">;
export type AssetClient = ReturnType<typeof createAssetClient>;
export function createAssetClient(options: AssetClientOptions) {
  return new AssetReports(options);
}

class AssetReports {
  private generation: string | undefined;
  private nextSequence: bigint;
  private readonly datasetId: string;
  private readonly options: AssetClientOptions;
  constructor(options: AssetClientOptions) {
    this.options = {
      ...options,
      signer: {
        processId: options.signer.processId,
        publicKey: options.signer.publicKey,
        sign: options.signer.sign.bind(options.signer),
      },
      authorizer: { authorize: options.authorizer.authorize.bind(options.authorizer) },
    };
    const context = options.client.context();
    if (!context) throw new Error("Discover Atlas before creating its Asset client");
    this.datasetId = context.datasetId;
    if (options.processGeneration !== undefined && !/^[1-9][0-9]*$/u.test(options.processGeneration))
      throw new Error("Invalid retained process generation");
    if (!/^[1-9][0-9]*$/u.test(options.nextSequence ?? "1")) throw new Error("Invalid retained report sequence");
    this.generation = options.processGeneration;
    this.nextSequence = BigInt(options.nextSequence ?? "1");
  }
  snapshot(): AssetProcessSnapshot {
    return Object.freeze({
      assetId: this.options.assetId,
      datasetId: this.datasetId,
      processId: this.options.signer.processId,
      processGeneration: this.generation ?? null,
      nextSequence: String(this.nextSequence),
    });
  }
  observeAuthority(response: S["EntityReportResponse"]): void {
    if (!sameDataset(response.dataset_id, this.datasetId))
      throw new Error("Authority response belongs to another Dataset");
    const authority = response.data.entity.process_authority;
    if (
      !authority ||
      authority.process_id !== this.options.signer.processId ||
      authority.process_public_key !== this.options.signer.publicKey ||
      response.data.entity.id !== this.options.assetId
    )
      throw new Error("Current process authority belongs to another process");
    this.generation = authority.process_generation;
  }
  async prepareAuthority(input: AuthorityOptions) {
    if (!/^(0|[1-9][0-9]*)$/u.test(input.expectedGeneration)) throw new Error("Invalid expected process generation");
    if (input.evidence) throw new Error("Authority transfer requires current evidence");
    const options = structuredClone(input);
    const generation = String(BigInt(options.expectedGeneration) + 1n);
    const payload = componentsPayload(options);
    const report_context = this.reserveContext(generation, options);
    const signingBytes = this.signingBytes("checkin", this.options.assetId, report_context, payload);
    report_context.process_proof = base64URL(await this.options.signer.sign(signingBytes));
    const context = this.requireContext();
    const recoveryBytes = canonicalJSON({
      kind: "authority_transfer",
      dataset_id: context.datasetId,
      asset_id: this.options.assetId,
      transfer_id: options.transferId,
      process_id: this.options.signer.processId,
      expected_generation: options.expectedGeneration,
      process_public_key: this.options.signer.publicKey,
      report_digest: await digest(signingBytes),
    });
    const recoveryProof = base64URL(await this.options.authorizer.authorize(recoveryBytes));
    this.requireContext();
    return this.options.client.prepareCheckin(this.options.assetId, {
      ...payload,
      report_context,
      authority_claim: {
        transfer_id: options.transferId,
        process_id: this.options.signer.processId,
        expected_generation: options.expectedGeneration,
        process_public_key: this.options.signer.publicKey,
        recovery_proof: recoveryProof,
      },
    });
  }
  async prepareCheckin(input: ComponentReportOptions) {
    const options = structuredClone(input);
    const payload = componentsPayload(options);
    const report_context = await this.signedContext("checkin", this.options.assetId, payload, options);
    return this.options.client.prepareCheckin(this.options.assetId, { ...payload, report_context });
  }
  async prepareReport(input: ComponentReportOptions) {
    const options = structuredClone(input);
    const payload = componentsPayload(options);
    const report_context = await this.signedContext("entity_report", this.options.assetId, payload, options);
    return this.options.client.prepareReport(this.options.assetId, { ...payload, report_context });
  }
  async prepareStatus(status: S["StatusReport"], input: ReportOptions) {
    const payload = structuredClone({ status });
    const report_context = await this.signedContext(
      "status_report",
      this.options.assetId,
      payload,
      structuredClone(input),
    );
    return this.options.client.prepareStatus(this.options.assetId, { ...payload, report_context });
  }
  async prepareTaskReport(taskId: string, fields: TaskReportFields, input: ReportOptions) {
    const payload = { kind: "report", ...structuredClone(fields) } as const;
    const report_context = await this.signedContext("task_report", taskId, payload, structuredClone(input));
    return this.options.client.prepareTaskReport(taskId, { ...payload, report_context });
  }
  private async signedContext(kind: string, targetId: string, payload: unknown, options: ReportOptions) {
    if (!this.generation) throw new Error("Establish or restore process authority before reporting");
    const context = this.reserveContext(this.generation, options);
    context.process_proof = base64URL(
      await this.options.signer.sign(this.signingBytes(kind, targetId, context, payload)),
    );
    this.requireContext();
    return context;
  }
  private requireContext() {
    const context = this.options.client.context();
    if (!context || !sameDataset(context.datasetId, this.datasetId))
      throw new Error("Asset reporting process belongs to an obsolete Dataset");
    return context;
  }
  private reserveContext(generation: string, options: ReportOptions): S["ReportContext"] {
    this.requireContext();
    const sequence = String(this.nextSequence++);
    const evidence = options.evidence;
    if (evidence && (evidence.origin === null) === (evidence.retainedEvidenceId === null))
      throw new Error("Historical evidence requires exactly one retained origin identity");
    return {
      asset_id: this.options.assetId,
      process_generation: generation,
      sequence,
      generated_at: options.generatedAt,
      evidence_kind: evidence?.kind ?? "current",
      evidence_origin: evidence?.origin ?? null,
      retained_evidence_id: evidence?.retainedEvidenceId ?? null,
      contact_challenge: evidence ? null : (options.contactChallenge ?? null),
      process_proof: "",
      ...(options.observationTimes === undefined ? {} : { observation_times: options.observationTimes }),
      ...(options.clockUncertaintyMs === undefined ? {} : { clock_uncertainty_ms: options.clockUncertaintyMs }),
    };
  }
  private signingBytes(kind: string, targetId: string, context: S["ReportContext"], payload: unknown) {
    const { process_proof: ignored, ...report_context } = context;
    void ignored;
    const selected = this.requireContext();
    return canonicalJSON({
      kind,
      dataset_id: selected.datasetId,
      protocol_version: selected.protocolVersion,
      target_id: targetId,
      report_context,
      payload,
    });
  }

  async reconcile(snapshot: RetainedAssetSnapshot): Promise<Outcome<ReconciliationPlan>> {
    const selected = this.options.client.context();
    if (!selected) return { outcome: "not_submitted", reason: "not_discovered" };
    if (!sameDataset(snapshot.datasetId, selected.datasetId))
      return { outcome: "dataset_invalidated", previousDatasetId: snapshot.datasetId, datasetId: selected.datasetId };
    if (snapshot.assetId !== this.options.assetId || !this.generation)
      return { outcome: "not_submitted", reason: "invalid_descriptor" };
    const outstanding: S["Task"][] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.options.client.getAssignedTasks(this.options.assetId, {
        outstanding: true,
        ...(cursor ? { cursor } : {}),
      });
      if (result.outcome !== "accepted") return result;
      outstanding.push(...result.value.data.items);
      cursor = result.value.data.next_cursor ?? undefined;
      if (cursor && cursors.has(cursor)) return { outcome: "unknown_outcome", reason: "protocol" };
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const pending = snapshot.pending.map((descriptor) => this.options.client.restoreMutation(descriptor));
    const held = new Set<string>();
    const established = new Map(snapshot.executions.map((evidence) => [evidence.taskId, evidence]));
    for (const evidence of snapshot.executions) {
      if (evidence.state === "unknown") {
        held.add(evidence.taskId);
        evidence.heldContinuation.forEach((id) => held.add(id));
      }
    }
    const reports: PreparedTaskReport[] = [];
    const tasks: S["Task"][] = [];
    let missingQueuedEvidence = false;
    for (const task of outstanding) {
      const evidence = established.get(task.id);
      if (!evidence) {
        held.add(task.id);
        if (task.scheduling === "queued") missingQueuedEvidence = true;
        continue;
      }
      if (held.has(task.id)) continue;
      if (evidence.state === "not_started") {
        // Assigned work follows submission order. Missing execution knowledge
        // keeps its queued continuation back until the Asset OS reconciles it.
        if (task.scheduling === "queued" && missingQueuedEvidence) held.add(task.id);
        else tasks.push(task);
        continue;
      }
      if (!evidence.executionId || (evidence.state === "completed" && !evidence.outcome)) {
        held.add(task.id);
        evidence.heldContinuation.forEach((id) => held.add(id));
        continue;
      }
      // An unresolved descriptor is the original report, not permission to
      // generate another identity or infer whether physical work occurred.
      if (
        pending.some(
          (descriptor) =>
            descriptor.operation === "task_report" &&
            descriptor.targetId === task.id &&
            descriptor.body.report_context.process_generation === this.generation,
        )
      ) {
        held.add(task.id);
        continue;
      }
      const status =
        evidence.state === "completed"
          ? evidence.outcome?.status
          : evidence.state === "running"
            ? "in_progress"
            : "paused";
      if (status === undefined) continue;
      if (evidence.origin !== null && !evidence.originalReport) {
        held.add(task.id);
        evidence.heldContinuation.forEach((id) => held.add(id));
        continue;
      }
      const fields: TaskReportFields = evidence.originalReport?.fields ?? {
        status,
        execution_id: evidence.executionId,
        // Unknown retained times supply no new fact. Omission preserves any
        // original time Core already accepted for this execution.
        ...(evidence.acknowledgedAt === null ? {} : { acknowledged_at: evidence.acknowledgedAt }),
        ...(evidence.startedAt === null ? {} : { started_at: evidence.startedAt }),
        ...(evidence.finishedAt === null ? {} : { finished_at: evidence.finishedAt }),
        ...(evidence.progress === null ? {} : { progress: evidence.progress }),
        ...(evidence.outcome?.failure === undefined ? {} : { failure: evidence.outcome.failure }),
        ...(evidence.outcome?.cancellationResponse === undefined
          ? {}
          : { cancellation_response: evidence.outcome.cancellationResponse }),
      };
      reports.push(
        await this.prepareTaskReport(task.id, fields, {
          ...(evidence.originalReport?.timing ?? {
            generatedAt: evidence.generatedAt,
            ...(evidence.observationTimes === undefined ? {} : { observationTimes: evidence.observationTimes }),
          }),
          evidence: { kind: "historical", origin: evidence.origin, retainedEvidenceId: evidence.retainedEvidenceId },
        }),
      );
    }
    return {
      outcome: "accepted",
      value: { tasks: tasks.filter((task) => !held.has(task.id)), reports, heldTaskIds: [...held], pending },
    };
  }
}
function componentsPayload(options: ComponentReportOptions) {
  return {
    ...(options.components === undefined ? {} : { components: options.components }),
    ...(options.commandManifest === undefined ? {} : { command_manifest: options.commandManifest }),
  };
}
