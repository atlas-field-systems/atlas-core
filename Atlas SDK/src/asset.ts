import type { components } from "../generated/protocol.js";
import { AtlasClient, newIdentity, type AssignedWork, type Entity, type Task } from "./client.js";
import { commitCursorOf, sameDataset, type ConnectionOptions } from "./connection.js";
import { AtlasError, type MutationOutcome } from "./errors.js";
import { authorityClaimFacts, canonicalIdentifier, digest, reportFacts } from "./signing.js";

type Schemas = components["schemas"];

// ProcessSigner is the current reporting process's Ed25519 authority. Its
// private key stays in the Asset or its trusted runtime; the SDK receives
// signatures, never the key.
export interface ProcessSigner {
  readonly publicKey: string;
  sign(message: Uint8Array): Promise<string>;
}

// RecoveryAuthority belongs to the Asset OS or deployment authority. It
// authorizes process replacement by signing claim facts.
export interface RecoveryAuthority {
  authorize(message: Uint8Array): Promise<string>;
}

// Original observation timing for one supplied quantity. Omitted or null
// timing stays unknown; it never inherits report or receipt time.
export type ObservationTimes = Readonly<Record<string, Schemas["MovementObservationTime"]>>;

// Evidence describes what a report states. Current evidence is newly
// generated now; historical evidence is retained execution or observation
// evidence with its original time and identity.
export type Evidence =
  | { readonly kind: "current"; readonly observationTimes?: ObservationTimes }
  | {
      readonly kind: "historical";
      readonly generatedAt: string | null;
      readonly origin?: { readonly processGeneration: string; readonly sequence: string };
      readonly retainedEvidenceId?: string;
      readonly observationTimes?: ObservationTimes;
    };

export type ReportOperation = "checkin" | "entity_patch" | "status_report" | "task_status";

interface ReportIdentity {
  readonly kind: "asset_report";
  readonly datasetId: string;
  readonly protocolVersion: string;
  readonly targetId: string;
  readonly processGeneration: string;
  readonly sequence: string;
}

// ReportDescriptor is a prepared, signed report. Its identity and facts are
// fixed before first transmission; an unknown-outcome retry resends it and
// never takes a new sequence. The Asset OS retains it when it must survive a
// reporting-process restart.
export type ReportDescriptor =
  | (ReportIdentity & { readonly operation: "checkin"; readonly body: Schemas["CheckIn"] })
  | (ReportIdentity & { readonly operation: "entity_patch"; readonly body: Schemas["EntityPatch"] })
  | (ReportIdentity & { readonly operation: "status_report"; readonly body: Schemas["AssetStatusReportRequest"] })
  | (ReportIdentity & { readonly operation: "task_status"; readonly body: Schemas["TaskLifecycleReport"] });

type UnsignedContext = Omit<Schemas["ReportContext"], "process_proof">;

interface Prepared {
  readonly identity: ReportIdentity;
  readonly context: UnsignedContext;
}

export interface RegistrationDescriptor {
  readonly kind: "asset_registration";
  readonly datasetId: string;
  readonly body: Schemas["EntityCreate"];
}

// ClaimDescriptor is a prepared process-authority claim. The Asset OS retains
// it with its process key so a lost transfer response retries identically.
export interface ClaimDescriptor {
  readonly transferId: string;
  readonly processId: string;
  readonly expectedGeneration: string;
  readonly processPublicKey: string;
}

export interface ReportResult<T> {
  readonly resource: T;
  readonly report?: Schemas["ReportResult"];
}

export interface AssetClientOptions extends Omit<ConnectionOptions, "authentication"> {
  readonly assetId: string;
  // The Asset's prepared credential, retained by the Asset OS.
  readonly credential: string;
  // Deployment enrollment authorization, needed only until first Enrollment
  // is accepted.
  readonly enrollmentToken?: string;
  readonly signer: ProcessSigner;
  // Resume reporting within an established generation of this process.
  readonly processGeneration?: string;
  readonly nextSequence?: string;
}

// The challenge is refreshed after half its window, measured on this process's
// monotonic clock rather than by estimating Core time.
const challengeRefreshFraction = 0.5;

interface CachedChallenge {
  readonly generation: string;
  readonly token: string;
  readonly obtained: number;
  readonly windowMs: number;
}

// AssetClient owns Asset-originated traffic: registration, signed reports with
// stable identities and ordering, Contact challenges, process-authority
// claims and assigned-work reads. It never schedules, starts or reruns work;
// the Asset OS owns execution and supplies its evidence.
export class AssetClient {
  readonly client: AtlasClient;
  readonly assetId: string;
  private readonly signer: ProcessSigner;
  private enrollmentToken: string | undefined;
  private generation: string | undefined;
  private sequence: bigint;
  private challenge: CachedChallenge | undefined;

  constructor(options: AssetClientOptions) {
    this.assetId = canonicalIdentifier(options.assetId);
    this.signer = options.signer;
    this.enrollmentToken = options.enrollmentToken;
    this.generation = options.processGeneration;
    this.sequence = BigInt(options.nextSequence ?? "1");
    this.client = new AtlasClient({
      ...options,
      authentication: () =>
        this.enrollmentToken === undefined ? { bearer: options.credential } : { enrollment: this.enrollmentToken },
    });
  }

  // processGeneration is the current process's Core-issued generation, once
  // established or resumed.
  get processGeneration() {
    return this.generation;
  }

  // nextSequence is the next unallocated report sequence in this generation.
  get nextSequence() {
    return this.sequence.toString();
  }

  // prepareRegistration fixes the registration identity and permitted initial
  // Descriptive data and Command support before submission.
  async prepareRegistration(request: {
    registrationId?: string;
    alias?: string | null;
    subtype?: string | null;
    commandManifest?: Schemas["CommandManifest"];
    credential?: string;
  }): Promise<RegistrationDescriptor> {
    const session = await this.client.connection.session();
    return {
      kind: "asset_registration",
      datasetId: session.datasetId,
      body: {
        id: this.assetId,
        type: "asset",
        registration_id: request.registrationId ?? newIdentity(),
        ...(request.alias === undefined ? {} : { alias: request.alias }),
        ...(request.subtype === undefined ? {} : { subtype: request.subtype }),
        ...(request.commandManifest === undefined ? {} : { command_manifest: request.commandManifest }),
        ...(request.credential === undefined ? {} : { enrollment: { credential: request.credential } }),
      },
    };
  }

  // register submits a prepared registration. Once accepted, later requests
  // authenticate with the Asset's own credential.
  async register(descriptor: RegistrationDescriptor): Promise<MutationOutcome<Schemas["RegistrationData"]>> {
    const outcome = await this.client.connection.mutate(
      descriptor.datasetId,
      (session, signal) =>
        session.transport.POST("/entities", { params: { header: session.headers }, body: descriptor.body, signal }),
      (data) => {
        if (data === undefined) throw new AtlasError("protocol_error", "Registration response has no body");
        return { value: data.data, commitCursor: commitCursorOf(data) };
      },
    );
    if (outcome.outcome === "accepted") {
      this.enrollmentToken = undefined;
      await this.client.discover();
    }
    return outcome;
  }

  // prepareClaim prepares a new process's authority claim for the generation
  // after expectedGeneration.
  prepareClaim(expectedGeneration: string): ClaimDescriptor {
    return {
      transferId: newIdentity(),
      processId: newIdentity(),
      expectedGeneration,
      processPublicKey: this.signer.publicKey,
    };
  }

  // contactChallenge returns a current challenge for this Asset and
  // generation, requesting a new one through authenticated health when the
  // cached one is past half its window.
  private async contactChallenge(generation: string) {
    const cached = this.challenge;
    if (
      cached !== undefined &&
      cached.generation === generation &&
      performance.now() - cached.obtained < cached.windowMs * challengeRefreshFraction
    ) {
      return cached.token;
    }
    const discovery = await this.client.connection.discover({ assetId: this.assetId, generation });
    const issued = discovery.contactChallenge;
    if (issued === undefined) throw new AtlasError("protocol_error", "Health returned no contact challenge");
    this.challenge = {
      generation,
      token: issued.token,
      obtained: performance.now(),
      windowMs: Date.parse(issued.expires_at) - Date.parse(issued.issued_at),
    };
    return issued.token;
  }

  // begin assigns the next sequence and builds the shared report context. A
  // claim makes this the first report of the next process generation.
  private async begin(
    targetId: string,
    evidence: Evidence = { kind: "current" },
    claim?: ClaimDescriptor,
  ): Promise<Prepared> {
    const session = await this.client.connection.session();
    let generation = this.generation;
    if (claim !== undefined) {
      generation = (BigInt(claim.expectedGeneration) + 1n).toString();
      if (this.generation !== generation) {
        this.generation = generation;
        this.sequence = 1n;
      }
    }
    if (generation === undefined) {
      throw new AtlasError("process_authority_required", "Establish process authority with a claim before reporting");
    }
    const historical = evidence.kind === "historical" ? evidence : undefined;
    // Obtain the challenge before allocating a sequence, so a disconnected
    // preparation consumes no report identity.
    const challenge = historical === undefined ? await this.contactChallenge(generation) : null;
    const sequence = this.sequence.toString();
    this.sequence += 1n;
    const context: UnsignedContext = {
      asset_id: this.assetId,
      process_generation: generation,
      sequence,
      generated_at: historical === undefined ? new Date().toISOString() : historical.generatedAt,
      evidence_kind: evidence.kind,
      evidence_origin:
        historical?.origin === undefined
          ? null
          : { process_generation: historical.origin.processGeneration, sequence: historical.origin.sequence },
      retained_evidence_id: historical?.retainedEvidenceId ?? null,
      contact_challenge: challenge,
      ...(evidence.observationTimes === undefined ? {} : { observation_times: evidence.observationTimes }),
    };
    return {
      identity: {
        kind: "asset_report",
        datasetId: session.datasetId,
        protocolVersion: session.protocolVersion,
        targetId,
        processGeneration: generation,
        sequence,
      },
      context,
    };
  }

  // sign produces the process proof over the canonical report facts.
  private async sign(operation: ReportOperation, prepared: Prepared, payload: Readonly<Record<string, unknown>>) {
    const facts = reportFacts({
      datasetId: prepared.identity.datasetId,
      protocolVersion: prepared.identity.protocolVersion,
      operation,
      targetId: prepared.identity.targetId,
      body: { ...payload, report_context: prepared.context },
    });
    return { facts, context: { ...prepared.context, process_proof: await this.signer.sign(facts) } };
  }

  // prepareCheckIn prepares a signed check-in of current Reported data. With
  // a claim, the recovery authority authorizes the claim over this report's
  // digest, establishing the next generation atomically with the report.
  async prepareCheckIn(
    payload: { components?: Schemas["ComponentsPatch"]; command_manifest?: Schemas["CommandManifest"] },
    options: { evidence?: Evidence; claim?: { descriptor: ClaimDescriptor; recovery: RecoveryAuthority } } = {},
  ): Promise<ReportDescriptor> {
    const prepared = await this.begin(this.assetId, options.evidence, options.claim?.descriptor);
    const { facts, context } = await this.sign("checkin", prepared, payload);
    const body: Schemas["CheckIn"] = { ...payload, report_context: context };
    if (options.claim !== undefined) {
      const { descriptor, recovery } = options.claim;
      const claim = {
        transfer_id: descriptor.transferId,
        process_id: descriptor.processId,
        expected_generation: descriptor.expectedGeneration,
        process_public_key: descriptor.processPublicKey,
      };
      const proof = await recovery.authorize(
        authorityClaimFacts({
          datasetId: prepared.identity.datasetId,
          assetId: this.assetId,
          claim,
          reportDigest: await digest(facts),
        }),
      );
      body.authority_claim = { ...claim, recovery_proof: proof };
    }
    return { ...prepared.identity, operation: "checkin", body };
  }

  async prepareComponentReport(
    payload: { components?: Schemas["ComponentsPatch"]; command_manifest?: Schemas["CommandManifest"] },
    evidence?: Evidence,
  ): Promise<ReportDescriptor> {
    const prepared = await this.begin(this.assetId, evidence);
    const { context } = await this.sign("entity_patch", prepared, payload);
    return { ...prepared.identity, operation: "entity_patch", body: { ...payload, report_context: context } };
  }

  async prepareStatusReport(
    status: NonNullable<Schemas["AssetStatusReport"]>,
    evidence?: Evidence,
  ): Promise<ReportDescriptor> {
    const prepared = await this.begin(this.assetId, evidence);
    const { context } = await this.sign("status_report", prepared, { status });
    return { ...prepared.identity, operation: "status_report", body: { status, report_context: context } };
  }

  // prepareTaskReport prepares the assigned Asset's lifecycle evidence for
  // one Task: acknowledgement, start, progress, outcome or a cancellation
  // decision.
  async prepareTaskReport(
    taskId: string,
    report: {
      event: Schemas["TaskReportEvent"];
      progress?: Schemas["TaskProgressReport"];
      failure?: Schemas["TaskFailure"];
      cancellationId?: string;
    },
    evidence?: Evidence,
  ): Promise<ReportDescriptor> {
    const payload = {
      action: "report" as const,
      event: report.event,
      ...(report.progress === undefined ? {} : { progress: report.progress }),
      ...(report.failure === undefined ? {} : { failure: report.failure }),
      ...(report.cancellationId === undefined ? {} : { cancellation_id: report.cancellationId }),
    };
    const prepared = await this.begin(canonicalIdentifier(taskId), evidence);
    const { context } = await this.sign("task_status", prepared, payload);
    return { ...prepared.identity, operation: "task_status", body: { ...payload, report_context: context } };
  }

  // submitEntityReport sends a prepared check-in, component or status report.
  submitEntityReport(descriptor: ReportDescriptor): Promise<MutationOutcome<ReportResult<Entity>>> {
    const extract = (data: { commit_cursor?: string; data: Schemas["EntityMutationData"] } | undefined) => {
      if (data === undefined) throw new AtlasError("protocol_error", "Report response has no body");
      const value: ReportResult<Entity> = {
        resource: data.data.entity,
        ...(data.data.report === undefined ? {} : { report: data.data.report }),
      };
      return { value, commitCursor: commitCursorOf(data) };
    };
    const path = { entity_id: descriptor.targetId };
    const connection = this.client.connection;
    switch (descriptor.operation) {
      case "checkin":
        return connection.mutate(
          descriptor.datasetId,
          (session, signal) =>
            session.transport.POST("/entities/{entity_id}/checkin", {
              params: { header: session.headers, path },
              body: descriptor.body,
              signal,
            }),
          extract,
        );
      case "status_report":
        return connection.mutate(
          descriptor.datasetId,
          (session, signal) =>
            session.transport.PATCH("/entities/{entity_id}/status", {
              params: { header: session.headers, path },
              body: descriptor.body,
              signal,
            }),
          extract,
        );
      case "entity_patch":
        return connection.mutate(
          descriptor.datasetId,
          (session, signal) =>
            session.transport.PATCH("/entities/{entity_id}", {
              params: { header: session.headers, path },
              body: descriptor.body,
              signal,
            }),
          extract,
        );
      case "task_status":
        return Promise.resolve({ outcome: "not_submitted", reason: "Task reports use submitTaskReport" });
    }
  }

  // submitTaskReport sends a prepared Task lifecycle report and returns
  // Core's recorded Task, never an echo of the requested status.
  submitTaskReport(descriptor: ReportDescriptor): Promise<MutationOutcome<ReportResult<Task>>> {
    if (descriptor.operation !== "task_status") {
      return Promise.resolve({ outcome: "not_submitted", reason: "Entity reports use submitEntityReport" });
    }
    return this.client.connection.mutate(
      descriptor.datasetId,
      (session, signal) =>
        session.transport.PATCH("/tasks/{task_id}/status", {
          params: { header: session.headers, path: { task_id: descriptor.targetId } },
          body: descriptor.body,
          signal,
        }),
      (data) => {
        if (data === undefined) throw new AtlasError("protocol_error", "Report response has no body");
        const value: ReportResult<Task> = {
          resource: data.data.task,
          ...(data.data.report === undefined ? {} : { report: data.data.report }),
        };
        return { value, commitCursor: commitCursorOf(data) };
      },
    );
  }

  // fetchAssignedTasks reads outstanding assigned work at one pinned queue
  // revision. Reading does not acknowledge, start or adopt any Task.
  fetchAssignedTasks(): Promise<AssignedWork> {
    return this.client.fetchAssignedTasks(this.assetId, { outstanding: true });
  }

  // isCurrent reports whether a retained descriptor targets the bound
  // Dataset. After Reset, old descriptors are discarded, not relabelled.
  isCurrent(descriptor: { datasetId: string }) {
    const known = this.client.connection.known;
    return known !== undefined && sameDataset(known.datasetId, descriptor.datasetId);
  }
}
