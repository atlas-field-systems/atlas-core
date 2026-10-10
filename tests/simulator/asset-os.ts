import { randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import {
  prepareCredential,
  type components,
  type RegistrationDescriptor,
  type ReportDescriptor,
} from "../../Atlas SDK/src/index.js";
import { generateKey, type RetainedKey } from "./keys.js";

type Schemas = components["schemas"];
export type Position = Schemas["Position"];
export type CommandManifest = Schemas["CommandManifest"];

// The simulated Asset's own arrival rule. Core never applies it.
export const arrivalToleranceM = 5;

export type ExecutionState = "completed" | "running" | "suspended" | "not_started" | "unknown";

// Execution is the Asset OS's record of one Task's work. It is never derived
// from Core Task status or SDK submission results.
export interface Execution {
  readonly taskId: string;
  readonly target: Position;
  state: ExecutionState;
  executionId: string | null;
  executionCount: number;
  distanceRemainingM: number | null;
  outcome: "completed" | "failed" | "cancelled" | null;
  // Unknown work holds every later queued execution until explicit recovery.
  holdsContinuation: boolean;
}

export type EvidenceFacts =
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly event: Schemas["TaskReportEvent"];
      readonly progress?: Schemas["TaskProgressReport"];
      readonly failure?: Schemas["TaskFailure"];
      readonly cancellationId?: string;
    }
  | {
      readonly kind: "telemetry";
      readonly telemetry: NonNullable<Schemas["TelemetryPatch"]>;
      // Original measurement time per supplied quantity; null is unknown.
      readonly observedAt: Readonly<Record<string, string | null>>;
    }
  | { readonly kind: "status"; readonly status: NonNullable<Schemas["AssetStatusReport"]> };

// RetainedEvidence is one execution or observation event with the report
// that carries it. Its ID is the stable unknown-origin identity used when no
// report identity was assigned while it happened.
export interface RetainedEvidence {
  readonly id: string;
  readonly occurredAt: string | null;
  readonly facts: EvidenceFacts;
  descriptor: ReportDescriptor | null;
  accepted: boolean;
  rejection: string | null;
}

// ReportingState is the trusted runtime's state for the current reporting
// process: its key, Core-issued generation and next sequence.
export interface ReportingState {
  readonly processId: string;
  readonly key: RetainedKey;
  generation: string | null;
  nextSequence: string;
  // The authority-claim check-in, retained until accepted.
  claim: ReportDescriptor | null;
}

interface Retained {
  readonly format: 1;
  readonly assetId: string;
  readonly credential: string;
  enrollmentToken: string | null;
  readonly recoveryKey: RetainedKey;
  readonly alias: string | null;
  commandManifest: CommandManifest;
  registration: RegistrationDescriptor | null;
  registered: boolean;
  // Last generation established by an accepted claim, and its Dataset. A
  // replacement claims the generation after it; a new Dataset starts at 0.
  establishedGeneration: string;
  establishedDataset: string | null;
  reporting: ReportingState;
  readonly executions: Execution[];
  readonly evidence: RetainedEvidence[];
}

const moveToSupport: CommandManifest = [
  { command: "move_to", scheduling: ["queued"], cancellation: true, progress: true, description: null },
];

// AssetOS is the private simulator fixture: it schedules and executes work,
// owns the recovery key and retains execution evidence and pending report
// descriptors outside any reporting process, in its own file format.
export class AssetOS {
  private constructor(
    readonly file: string,
    private state: Retained,
  ) {}

  static async create(
    file: string,
    options: { assetId?: string; alias?: string | null; commandManifest?: CommandManifest } = {},
  ) {
    const os = new AssetOS(file, {
      format: 1,
      assetId: options.assetId ?? randomUUID(),
      credential: prepareCredential(),
      enrollmentToken: null,
      recoveryKey: await generateKey(),
      alias: options.alias ?? null,
      commandManifest: options.commandManifest ?? moveToSupport,
      registration: null,
      registered: false,
      establishedGeneration: "0",
      establishedDataset: null,
      reporting: await newReporting(),
      executions: [],
      evidence: [],
    });
    await os.save();
    return os;
  }

  // load restores retained state, as after an Asset OS or process restart.
  static async load(file: string) {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRetained(parsed)) throw new Error(`${file} is not a simulator retention file`);
    return new AssetOS(file, parsed);
  }

  get assetId() {
    return this.state.assetId;
  }
  get credential() {
    return this.state.credential;
  }
  get recoveryKey() {
    return this.state.recoveryKey;
  }
  get alias() {
    return this.state.alias;
  }
  get commandManifest() {
    return this.state.commandManifest;
  }
  get enrollmentToken() {
    return this.state.enrollmentToken;
  }
  get reporting(): Readonly<ReportingState> {
    return this.state.reporting;
  }
  // expectedGeneration is the generation a new claim in datasetId expects.
  expectedGeneration(datasetId: string) {
    return this.state.establishedDataset === datasetId ? this.state.establishedGeneration : "0";
  }
  get registration() {
    return this.state.registration;
  }
  get registered() {
    return this.state.registered;
  }

  // Deployment tooling supplies enrollment authorization out of band.
  async authorizeEnrollment(token: string) {
    this.state.enrollmentToken = token;
    await this.save();
  }

  async retainRegistration(descriptor: RegistrationDescriptor) {
    this.state.registration = descriptor;
    await this.save();
  }

  async registrationAccepted() {
    this.state.registered = true;
    this.state.enrollmentToken = null;
    await this.save();
  }

  async advertise(manifest: CommandManifest) {
    this.state.commandManifest = manifest;
    await this.save();
  }

  async updateReporting(update: Partial<Pick<ReportingState, "generation" | "nextSequence" | "claim">>) {
    this.state.reporting = { ...this.state.reporting, ...update };
    await this.save();
  }

  async generationEstablished(generation: string, datasetId: string) {
    this.state.establishedGeneration = generation;
    this.state.establishedDataset = datasetId;
    this.state.reporting = { ...this.state.reporting, generation, claim: null };
    await this.save();
  }

  // replaceProcess starts a new reporting process with a new key. Retained
  // execution and evidence survive; the old process's authority does not.
  async replaceProcess() {
    this.state.reporting = await newReporting();
    await this.save();
  }

  executions(): readonly Readonly<Execution>[] {
    return this.state.executions;
  }

  execution(taskId: string): Readonly<Execution> {
    return this.find(taskId);
  }

  evidence(): readonly Readonly<RetainedEvidence>[] {
    return this.state.evidence;
  }

  // receive records delivered work. Repeated delivery adds nothing; work the
  // OS already knows keeps its own state.
  async receive(task: { id: string; input: Schemas["MoveTo"] }, at = now()) {
    if (this.state.executions.some((execution) => execution.taskId === task.id)) return undefined;
    if (task.input.target.kind !== "position") throw new Error("S1 simulator executes coordinate targets only");
    this.state.executions.push({
      taskId: task.id,
      target: task.input.target.position,
      state: "not_started",
      executionId: null,
      executionCount: 0,
      distanceRemainingM: null,
      outcome: null,
      holdsContinuation: false,
    });
    return this.record(at, { kind: "task", taskId: task.id, event: "acknowledged" });
  }

  // startNext starts the first not-started execution when nothing running,
  // suspended or unknown is ahead of it. Completed work never starts again.
  async startNext(at = now()) {
    for (const execution of this.state.executions) {
      if (execution.state === "running" || execution.state === "suspended" || execution.holdsContinuation) {
        return undefined;
      }
      if (execution.state === "not_started") {
        execution.state = "running";
        execution.executionId = randomUUID();
        execution.executionCount += 1;
        return this.record(at, { kind: "task", taskId: execution.taskId, event: "started" });
      }
    }
    return undefined;
  }

  async progress(taskId: string, distanceRemainingM: number, at = now()) {
    const execution = this.running(taskId);
    execution.distanceRemainingM = distanceRemainingM;
    return this.record(at, {
      kind: "task",
      taskId,
      event: "progress",
      progress: { details: { command: "move_to", distance_remaining_m: distanceRemainingM } },
    });
  }

  // complete reports arrival only within the Asset's own tolerance.
  async complete(taskId: string, at = now()) {
    const execution = this.running(taskId);
    if (execution.distanceRemainingM === null || execution.distanceRemainingM > arrivalToleranceM) {
      throw new Error(`Task ${taskId} is not within ${arrivalToleranceM} m of its target`);
    }
    execution.state = "completed";
    execution.outcome = "completed";
    return this.record(at, { kind: "task", taskId, event: "completed" });
  }

  async fail(taskId: string, failure: Schemas["TaskFailure"], at = now()) {
    const execution = this.find(taskId);
    execution.state = "completed";
    execution.outcome = "failed";
    return this.record(at, { kind: "task", taskId, event: "failed", failure });
  }

  // decideCancellation is the Asset's decision on one cancellation request.
  async decideCancellation(taskId: string, cancellationId: string, confirm: boolean, at = now()) {
    const execution = this.find(taskId);
    if (confirm) {
      execution.state = "completed";
      execution.outcome = "cancelled";
    }
    return this.record(at, {
      kind: "task",
      taskId,
      event: confirm ? "cancellation_confirmed" : "cancellation_declined",
      cancellationId,
    });
  }

  async suspend(taskId: string) {
    this.running(taskId).state = "suspended";
    await this.save();
  }

  // loseCertainty models an OS restart that cannot tell whether running work
  // finished. The work and its queued continuation stay held.
  async loseCertainty(taskId: string) {
    const execution = this.find(taskId);
    execution.state = "unknown";
    execution.holdsContinuation = true;
    await this.save();
  }

  // recover applies explicitly supplied recovery evidence for unknown work and
  // releases its continuation.
  async recover(taskId: string, recovered: "completed" | "not_started", at = now()) {
    const execution = this.find(taskId);
    if (execution.state !== "unknown") throw new Error(`Task ${taskId} has no unknown work to recover`);
    execution.holdsContinuation = false;
    execution.state = recovered;
    if (recovered === "completed") {
      execution.outcome = "completed";
      return this.record(at, { kind: "task", taskId, event: "completed" });
    }
    await this.save();
    return undefined;
  }

  async observe(
    telemetry: NonNullable<Schemas["TelemetryPatch"]>,
    observedAt: Record<string, string | null>,
    at = now(),
  ) {
    return this.record(at, { kind: "telemetry", telemetry, observedAt });
  }

  async reportStatus(status: NonNullable<Schemas["AssetStatusReport"]>, at = now()) {
    return this.record(at, { kind: "status", status });
  }

  async attach(evidenceId: string, descriptor: ReportDescriptor) {
    this.evidenceById(evidenceId).descriptor = descriptor;
    await this.save();
  }

  async settle(evidenceId: string, settlement: { accepted: true } | { rejection: string }) {
    const evidence = this.evidenceById(evidenceId);
    if ("accepted" in settlement) evidence.accepted = true;
    else evidence.rejection = settlement.rejection;
    await this.save();
  }

  // pending lists evidence still awaiting an acceptance, in occurrence order.
  pending(): readonly Readonly<RetainedEvidence>[] {
    return this.state.evidence.filter((evidence) => !evidence.accepted && evidence.rejection === null);
  }

  // save replaces the retention file atomically and durably.
  async save() {
    const temporary = `${this.file}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.state, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.file);
  }

  private async record(occurredAt: string | null, facts: EvidenceFacts) {
    const evidence: RetainedEvidence = {
      id: randomUUID(),
      occurredAt,
      facts,
      descriptor: null,
      accepted: false,
      rejection: null,
    };
    this.state.evidence.push(evidence);
    await this.save();
    return evidence;
  }

  private find(taskId: string) {
    const execution = this.state.executions.find((candidate) => candidate.taskId === taskId);
    if (!execution) throw new Error(`The Asset OS has not received Task ${taskId}`);
    return execution;
  }

  private running(taskId: string) {
    const execution = this.find(taskId);
    if (execution.state !== "running") throw new Error(`Task ${taskId} is ${execution.state}, not running`);
    return execution;
  }

  private evidenceById(id: string) {
    const evidence = this.state.evidence.find((candidate) => candidate.id === id);
    if (!evidence) throw new Error(`Unknown retained evidence ${id}`);
    return evidence;
  }
}

async function newReporting(): Promise<ReportingState> {
  return { processId: randomUUID(), key: await generateKey(), generation: null, nextSequence: "1", claim: null };
}

function now() {
  return new Date().toISOString();
}

function isRetained(value: unknown): value is Retained {
  return typeof value === "object" && value !== null && "format" in value && value.format === 1;
}
