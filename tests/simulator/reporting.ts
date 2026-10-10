import {
  AssetClient,
  AtlasError,
  type AssignedWork,
  type Evidence,
  type MutationOutcome,
  type ReportDescriptor,
} from "../../Atlas SDK/src/index.js";
import type { AssetOS, RetainedEvidence } from "./asset-os.js";
import { processSigner, recoveryAuthority } from "./keys.js";

export interface Link {
  readonly baseUrl: string;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly requestTimeoutMs?: number;
}

export interface Submission {
  readonly evidenceId: string;
  readonly outcome: MutationOutcome<unknown>["outcome"];
  readonly code?: string;
}

// ReportingProcess is one simulated Core-facing reporting process built on
// the SDK Asset client. It reports the Asset OS's retained evidence; it never
// schedules or executes work, and it owns no keys or storage.
export class ReportingProcess {
  readonly client: AssetClient;

  constructor(
    readonly os: AssetOS,
    link: Link,
  ) {
    const reporting = os.reporting;
    const token = os.enrollmentToken;
    this.client = new AssetClient({
      baseUrl: link.baseUrl,
      fetch: link.fetch,
      ...(link.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: link.requestTimeoutMs }),
      assetId: os.assetId,
      credential: os.credential,
      ...(token === null || os.registered ? {} : { enrollmentToken: token }),
      signer: processSigner(reporting.key),
      ...(reporting.generation === null
        ? {}
        : { processGeneration: reporting.generation, nextSequence: reporting.nextSequence }),
    });
  }

  // register submits the retained registration, preparing it once before its
  // first transmission. A retry after a lost reply resends it unchanged.
  async register() {
    let descriptor = this.os.registration;
    if (descriptor === null) {
      descriptor = await this.client.prepareRegistration({
        alias: this.os.alias,
        commandManifest: this.os.commandManifest,
        credential: this.os.credential,
      });
      await this.os.retainRegistration(descriptor);
    }
    const outcome = await this.client.register(descriptor);
    if (outcome.outcome === "accepted") await this.os.registrationAccepted();
    return outcome;
  }

  // establish claims process authority with a signed check-in. The claim is
  // retained until accepted, so a lost transfer response retries identically.
  async establish(payload: Parameters<AssetClient["prepareCheckIn"]>[0] = {}) {
    let descriptor = this.os.reporting.claim;
    if (descriptor === null) {
      const claim = this.client.prepareClaim(this.os.establishedGeneration);
      descriptor = await this.client.prepareCheckIn(
        { command_manifest: this.os.commandManifest, ...payload },
        { claim: { descriptor: claim, recovery: recoveryAuthority(this.os.recoveryKey) } },
      );
      await this.os.updateReporting({ claim: descriptor, nextSequence: this.client.nextSequence });
    }
    const outcome = await this.client.submitEntityReport(descriptor);
    if (outcome.outcome === "accepted") {
      const generation = outcome.value.report?.authority?.process_generation;
      if (generation === undefined) throw new AtlasError("protocol_error", "Accepted claim returned no authority");
      await this.os.generationEstablished(generation);
    }
    return outcome;
  }

  // receiveWork reads outstanding assigned work and delivers new Tasks to the
  // Asset OS. Reading never acknowledges or starts work in Core.
  async receiveWork(): Promise<AssignedWork> {
    const work = await this.client.fetchAssignedTasks();
    for (const task of work.tasks) {
      if (task.input.target.kind === "position") await this.os.receive(task);
    }
    return work;
  }

  // capture prepares current evidence immediately while Core is reachable.
  // Disconnected evidence stays unprepared and is later reported as
  // historical with its original time and stable identity.
  async capture(evidence: RetainedEvidence | undefined) {
    if (evidence === undefined) return;
    try {
      await this.prepare(evidence, { kind: "current" });
    } catch (error) {
      if (!(error instanceof AtlasError) || error.code !== "transport_error") throw error;
    }
  }

  // flush submits pending evidence in occurrence order and stops at the first
  // unknown outcome, which the next flush retries with the same descriptor.
  async flush(): Promise<Submission[]> {
    const submissions: Submission[] = [];
    await this.client.client.connection.session();
    for (const evidence of this.os.pending()) {
      const original = evidence.descriptor;
      if (original !== null && !this.client.isCurrent(original)) {
        // A known Dataset change makes the descriptor obsolete; it is
        // discarded, never relabelled into the new Dataset.
        await this.os.settle(evidence.id, { rejection: "dataset_invalidated" });
        submissions.push({ evidenceId: evidence.id, outcome: "dataset_invalidated" });
        continue;
      }
      const descriptor =
        original !== null && original.processGeneration === this.client.processGeneration
          ? original
          : await this.prepare(evidence, this.historical(evidence));
      const outcome =
        descriptor.operation === "task_status"
          ? await this.client.submitTaskReport(descriptor)
          : await this.client.submitEntityReport(descriptor);
      if (outcome.outcome === "accepted") {
        await this.os.settle(evidence.id, { accepted: true });
      } else if (outcome.outcome === "rejected") {
        await this.os.settle(evidence.id, { rejection: outcome.rejection.code });
      }
      submissions.push({
        evidenceId: evidence.id,
        outcome: outcome.outcome,
        ...(outcome.outcome === "rejected" ? { code: outcome.rejection.code } : {}),
      });
      if (outcome.outcome !== "accepted" && outcome.outcome !== "rejected") break;
    }
    return submissions;
  }

  // Evidence prepared by an earlier process keeps its original identity: its
  // report identity, or the retained identity it was already reported with.
  private historical(evidence: RetainedEvidence): Evidence {
    const observationTimes = this.observationTimes(evidence);
    const times = observationTimes === undefined ? {} : { observationTimes };
    const original = evidence.descriptor?.body.report_context;
    const descriptor = evidence.descriptor;
    if (original === undefined || descriptor === null) {
      return { kind: "historical", generatedAt: evidence.occurredAt, retainedEvidenceId: evidence.id, ...times };
    }
    const generatedAt = original.generated_at ?? null;
    if (original.evidence_kind === "current") {
      return {
        kind: "historical",
        generatedAt,
        origin: { processGeneration: descriptor.processGeneration, sequence: descriptor.sequence },
        ...times,
      };
    }
    if (original.evidence_origin !== null) {
      return {
        kind: "historical",
        generatedAt,
        origin: {
          processGeneration: original.evidence_origin.process_generation,
          sequence: original.evidence_origin.sequence,
        },
        ...times,
      };
    }
    return {
      kind: "historical",
      generatedAt,
      retainedEvidenceId: original.retained_evidence_id ?? evidence.id,
      ...times,
    };
  }

  private observationTimes(evidence: RetainedEvidence) {
    if (evidence.facts.kind !== "telemetry") return undefined;
    return Object.fromEntries(
      Object.entries(evidence.facts.observedAt).map(([quantity, observedAt]) => [
        quantity,
        { observed_at: observedAt },
      ]),
    );
  }

  private async prepare(evidence: RetainedEvidence, kind: Evidence) {
    const observationTimes = this.observationTimes(evidence);
    const evidenceKind: Evidence =
      kind.kind === "current" && observationTimes !== undefined ? { kind: "current", observationTimes } : kind;
    const facts = evidence.facts;
    let descriptor: ReportDescriptor;
    switch (facts.kind) {
      case "task":
        descriptor = await this.client.prepareTaskReport(
          facts.taskId,
          {
            event: facts.event,
            ...(facts.progress === undefined ? {} : { progress: facts.progress }),
            ...(facts.failure === undefined ? {} : { failure: facts.failure }),
            ...(facts.cancellationId === undefined ? {} : { cancellationId: facts.cancellationId }),
          },
          evidenceKind,
        );
        break;
      case "telemetry":
        descriptor = await this.client.prepareComponentReport(
          { components: { telemetry: facts.telemetry } },
          evidenceKind,
        );
        break;
      case "status":
        descriptor = await this.client.prepareStatusReport(facts.status, evidenceKind);
        break;
    }
    await this.os.attach(evidence.id, descriptor);
    await this.os.updateReporting({ nextSequence: this.client.nextSequence });
    return descriptor;
  }
}
