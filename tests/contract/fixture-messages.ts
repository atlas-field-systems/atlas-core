export interface Ready {
  event: "ready";
  baseUrl: string;
  sqliteVersion: string;
  journalMode: string;
}
export interface FixtureOptions {
  mode?: "normal" | "missing_readiness" | "startup_failure" | "request_hooks";
  startupMs?: number;
}
export class FixtureStartupError extends Error {
  constructor(message: string, readonly dataDir: string, readonly pid: number | undefined, readonly trace: string) {
    super(message);
    this.name = "FixtureStartupError";
  }
}
export type FixtureCommand = { id: string; action: "start"; options: FixtureOptions } | { id: string; action: "stop" };
interface Failure {
  message: string;
  code?: string;
  errors?: Failure[];
  startup?: { dataDir: string; pid: number | null; trace: string };
}
export type FixtureReply = { id: string; event: "ready"; state: Ready & { dataDir: string; pid: number } } |
  { id: string; event: "stopped" } | ({ id: string; event: "failure" } & Failure);

export function isReady(value: unknown): value is Ready {
  return typeof value === "object" && value !== null &&
    "event" in value && value.event === "ready" &&
    "baseUrl" in value && typeof value.baseUrl === "string" &&
    "sqliteVersion" in value && typeof value.sqliteVersion === "string" &&
    "journalMode" in value && typeof value.journalMode === "string";
}
function isOptions(value: unknown): value is FixtureOptions {
  return typeof value === "object" && value !== null &&
    (!("mode" in value) || ["normal", "missing_readiness", "startup_failure", "request_hooks"].some((mode) => mode === value.mode)) &&
    (!("startupMs" in value) || typeof value.startupMs === "number" && Number.isFinite(value.startupMs) && value.startupMs > 0);
}
export function isFixtureCommand(value: unknown): value is FixtureCommand {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" &&
    "action" in value && (value.action === "stop" || value.action === "start" && "options" in value && isOptions(value.options));
}
export function isFixtureReply(value: unknown): value is FixtureReply {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" || !("event" in value)) return false;
  if (value.event === "stopped") return true;
  if (value.event === "ready") return "state" in value && isReady(value.state) && "dataDir" in value.state &&
    typeof value.state.dataDir === "string" && "pid" in value.state && typeof value.state.pid === "number";
  return value.event === "failure" && isFailure(value);
}
function isFailure(value: unknown): value is Failure {
  if (typeof value !== "object" || value === null || !("message" in value) || typeof value.message !== "string") return false;
  if ("code" in value && typeof value.code !== "string") return false;
  if ("errors" in value && (!Array.isArray(value.errors) || !value.errors.every(isFailure))) return false;
  if (!("startup" in value)) return true;
  const startup = value.startup;
  return typeof startup === "object" && startup !== null && "dataDir" in startup && typeof startup.dataDir === "string" &&
    "pid" in startup && (startup.pid === null || typeof startup.pid === "number") && "trace" in startup && typeof startup.trace === "string";
}

function serializeFailure(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof FixtureStartupError) return { message,
    startup: { dataDir: error.dataDir, pid: error.pid ?? null, trace: error.trace } };
  if (error instanceof AggregateError) return { message, errors: error.errors.map((nested: unknown) => serializeFailure(nested)) };
  if (error instanceof Error && "code" in error && typeof error.code === "string") return { message, code: error.code };
  return { message };
}
export function fixtureFailure(id: string, error: unknown): FixtureReply {
  return { id, event: "failure", ...serializeFailure(error) };
}
export function replyError(reply: Failure): Error {
  if (reply.startup) return new FixtureStartupError(reply.message, reply.startup.dataDir, reply.startup.pid ?? undefined, reply.startup.trace);
  if (reply.errors) return new AggregateError(reply.errors.map(replyError), reply.message);
  return reply.code ? Object.assign(new Error(reply.message), { code: reply.code }) : new Error(reply.message);
}
