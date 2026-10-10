import { Ajv } from "../../Atlas SDK/node_modules/ajv/dist/ajv.js";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { restoreMutation, type PreparedTaskReport, type RetainedExecutionEvidence } from "../../Atlas SDK/src/index.js";

const executionStates = ["completed", "running", "suspended", "not_started", "unknown"] as const;
type ExecutionState = (typeof executionStates)[number];
export type ExecutionSnapshot = {
  taskId: string;
  executionId: string | null;
  executionCount: number;
  state: ExecutionState;
  eventTime: string | null;
  progress: { distanceRemainingM: number } | null;
  outcome: { status: "completed" | "failed" | "cancelled"; failure: { code: string; message: string } | null } | null;
  origin: { processGeneration: string; sequence: string } | null;
  retainedEvidenceId: string;
  heldTaskIds: string[];
  originalReport: PreparedTaskReport | null;
};
type RetainedExecutions = { format: 1; executions: ExecutionSnapshot[] };
type RawExecutions = {
  format: 1;
  executions: (Omit<ExecutionSnapshot, "originalReport"> & { originalReport: unknown })[];
};
type RecoveryEvidence = Pick<ExecutionSnapshot, "eventTime" | "progress"> & {
  state: Exclude<ExecutionState, "unknown">;
  outcome?: ExecutionSnapshot["outcome"];
};
const maximumExecutions = 256;
const arrivalToleranceM = 5;
export const maximumRetainedBytes = 1024 * 1024;

/** The fixture's Asset OS owns this file independently of its reporting process. */
export async function openExecutionStore(directory: string) {
  const nullableString = { type: ["string", "null"] };
  const ajv = new Ajv({ strict: true, allowUnionTypes: true });
  const valid = ajv.compile<RawExecutions>({
    type: "object",
    additionalProperties: false,
    required: ["format", "executions"],
    properties: {
      format: { const: 1 },
      executions: {
        type: "array",
        maxItems: maximumExecutions,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "taskId",
            "executionId",
            "executionCount",
            "state",
            "eventTime",
            "progress",
            "outcome",
            "origin",
            "retainedEvidenceId",
            "heldTaskIds",
            "originalReport",
          ],
          properties: {
            taskId: { type: "string", minLength: 1 },
            executionId: nullableString,
            executionCount: { type: "integer", minimum: 0 },
            state: { enum: executionStates },
            eventTime: nullableString,
            progress: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["distanceRemainingM"],
              properties: { distanceRemainingM: { type: "number", minimum: 0 } },
            },
            outcome: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["status", "failure"],
              properties: {
                status: { enum: ["completed", "failed", "cancelled"] },
                failure: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  required: ["code", "message"],
                  properties: { code: { type: "string" }, message: { type: "string" } },
                },
              },
            },
            origin: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["processGeneration", "sequence"],
              properties: { processGeneration: { type: "string" }, sequence: { type: "string" } },
            },
            retainedEvidenceId: { type: "string", minLength: 1 },
            heldTaskIds: { type: "array", maxItems: maximumExecutions, uniqueItems: true, items: { type: "string" } },
            originalReport: {},
          },
        },
      },
    },
  });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "executions.json");
  let retained: RetainedExecutions = { format: 1, executions: [] };
  try {
    const bytes = await readRetainedFile(path, maximumRetainedBytes, true);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!valid(value)) throw new Error("Retained execution evidence is invalid; explicit repair is required");
    retained = {
      format: value.format,
      executions: value.executions.map((entry) => {
        const report = entry.originalReport === null ? null : restoreMutation(entry.originalReport);
        if (report !== null && (report.operation !== "task_report" || report.targetId !== entry.taskId))
          throw new Error("Retained source report belongs to another execution");
        return { ...entry, originalReport: report };
      }),
    };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let writing = false;
  let unavailable = false;
  const get = (state: RetainedExecutions, taskId: string) => {
    const entry = state.executions.find((item) => item.taskId === taskId);
    if (!entry) throw new Error("Task has no retained execution evidence");
    return entry;
  };
  const newEvent = (entry: ExecutionSnapshot) => {
    entry.originalReport = null;
    entry.origin = null;
    entry.retainedEvidenceId = randomUUID();
  };
  const change = async (update: (state: RetainedExecutions) => void) => {
    if (writing || unavailable) throw new Error("Execution evidence is busy or unavailable; reopen before recovery");
    writing = true;
    try {
      const next = structuredClone(retained);
      update(next);
      if (!valid(next)) throw new Error("Execution evidence violates its retained contract");
      try {
        await retainJSON(directory, path, next);
      } catch (error) {
        unavailable = true;
        throw error;
      }
      retained = next;
    } finally {
      writing = false;
    }
  };
  return {
    snapshots: () => structuredClone(retained.executions),
    snapshot: (taskId: string) => structuredClone(get(retained, taskId)),
    evidence: (): RetainedExecutionEvidence[] =>
      retained.executions.map((entry) => {
        const original = entry.originalReport?.body;
        const fields = original
          ? (({ kind, report_context, ...facts }) => {
              void kind;
              void report_context;
              return facts;
            })(original)
          : null;
        return {
          taskId: entry.taskId,
          executionId: entry.executionId,
          executionCount: entry.executionCount,
          state: entry.state,
          progress: entry.progress === null ? null : { distance_remaining_m: entry.progress.distanceRemainingM },
          generatedAt: original ? original.report_context.generated_at : entry.eventTime,
          acknowledgedAt: original?.acknowledged_at ?? null,
          startedAt: original?.started_at ?? null,
          finishedAt: original?.finished_at ?? null,
          origin:
            entry.origin === null
              ? null
              : { process_generation: entry.origin.processGeneration, sequence: entry.origin.sequence },
          retainedEvidenceId: entry.origin === null ? entry.retainedEvidenceId : null,
          outcome:
            entry.outcome === null
              ? null
              : {
                  status: entry.outcome.status,
                  ...(entry.outcome.failure === null ? {} : { failure: entry.outcome.failure }),
                },
          heldContinuation: [...entry.heldTaskIds],
          ...(original && fields
            ? {
                originalReport: {
                  fields,
                  timing: {
                    generatedAt: original.report_context.generated_at,
                    ...(original.report_context.observation_times === undefined
                      ? {}
                      : { observationTimes: original.report_context.observation_times }),
                    ...(original.report_context.clock_uncertainty_ms === undefined
                      ? {}
                      : { clockUncertaintyMs: original.report_context.clock_uncertainty_ms }),
                  },
                },
              }
            : {}),
        };
      }),
    recordReport: (taskId: string, descriptor: PreparedTaskReport) =>
      change((state) => {
        const original = restoreMutation(descriptor);
        if (original.operation !== "task_report" || original.targetId !== taskId)
          throw new Error("Source report belongs to another execution");
        const entry = get(state, taskId);
        entry.originalReport = original;
        entry.origin = {
          processGeneration: original.body.report_context.process_generation,
          sequence: original.body.report_context.sequence,
        };
      }),
    loadTasks: (taskIds: readonly string[]) =>
      change((state) => {
        for (const taskId of taskIds)
          if (!state.executions.some((entry) => entry.taskId === taskId)) {
            state.executions.push({
              taskId,
              executionId: null,
              executionCount: 0,
              state: "not_started",
              eventTime: null,
              progress: null,
              outcome: null,
              origin: null,
              retainedEvidenceId: randomUUID(),
              heldTaskIds: [],
              originalReport: null,
            });
          }
      }),
    start: (taskId: string, eventTime: string | null, origin: ExecutionSnapshot["origin"]) =>
      change((state) => {
        const entry = get(state, taskId);
        if (
          entry.state === "completed" ||
          entry.state === "unknown" ||
          state.executions.some((item) => item.state === "unknown" && item.heldTaskIds.includes(taskId))
        ) {
          throw new Error("Execution is complete or held for explicit recovery");
        }
        if (entry.state === "not_started") {
          newEvent(entry);
          entry.executionId = randomUUID();
          entry.executionCount += 1;
          entry.state = "running";
          entry.eventTime = eventTime;
          entry.origin = origin;
        }
      }),
    distance: (taskId: string, distanceRemainingM: number, eventTime: string | null) =>
      change((state) => {
        const entry = get(state, taskId);
        if (entry.state !== "running") throw new Error("Distance evidence requires a running execution");
        newEvent(entry);
        entry.progress = { distanceRemainingM };
        entry.eventTime = eventTime;
        if (distanceRemainingM <= arrivalToleranceM) {
          entry.state = "completed";
          entry.outcome = { status: "completed", failure: null };
        }
      }),
    suspend: (taskId: string, eventTime: string | null) =>
      change((state) => {
        const entry = get(state, taskId);
        if (entry.state !== "running") throw new Error("Only running execution can be suspended");
        newEvent(entry);
        entry.state = "suspended";
        entry.eventTime = eventTime;
      }),
    finish: (taskId: string, outcome: NonNullable<ExecutionSnapshot["outcome"]>, eventTime: string | null) =>
      change((state) => {
        const entry = get(state, taskId);
        if (!["running", "suspended"].includes(entry.state)) throw new Error("A known active execution is required");
        newEvent(entry);
        entry.state = "completed";
        entry.outcome = outcome;
        entry.eventTime = eventTime;
      }),
    loseEvidence: (taskId: string, heldTaskIds: string[]) =>
      change((state) => {
        const entry = get(state, taskId);
        if (entry.state === "completed") throw new Error("Established outcome evidence cannot be discarded");
        for (const heldId of heldTaskIds) get(state, heldId);
        entry.state = "unknown";
        entry.heldTaskIds = [...heldTaskIds];
      }),
    recover: (taskId: string, evidence: RecoveryEvidence) =>
      change((state) => {
        const entry = get(state, taskId);
        if (entry.state !== "unknown") throw new Error("Explicit recovery requires an unknown execution");
        if (evidence.state === "completed" && !evidence.outcome)
          throw new Error("Completion recovery requires established outcome evidence");
        newEvent(entry);
        Object.assign(entry, evidence);
        entry.heldTaskIds = [];
      }),
  };
}

export async function retainJSON(directory: string, path: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > maximumRetainedBytes) throw new RangeError("Retained state exceeds its byte bound");
  const temporary = join(directory, `.pending-${randomUUID()}`);
  try {
    {
      await using file = await open(temporary, "wx", 0o600);
      await file.writeFile(bytes);
      await file.sync();
    }
    await rename(temporary, path);
    await using parent = await open(directory, "r");
    await parent.sync();
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Retaining and cleaning execution evidence failed");
    }
    throw error;
  }
}

export async function readRetainedFile(path: string, maximum: number, privateOwner = false): Promise<Buffer> {
  await using file = await open(path, "r");
  const metadata = await file.stat();
  if (!metadata.isFile() || metadata.size > maximum) throw new RangeError("Retained file exceeds its bound");
  if (privateOwner && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()))
    throw new Error("Retained credentials must be private to their owner");
  const buffer = Buffer.alloc(maximum + 1);
  let size = 0;
  while (size <= maximum) {
    const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
    if (bytesRead === 0) return buffer.subarray(0, size);
    size += bytesRead;
  }
  throw new RangeError("Retained file exceeds its bound");
}
