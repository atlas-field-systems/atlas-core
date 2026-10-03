import { randomUUID } from "node:crypto";
import { isFixtureReply, replyError, type FixtureCommand, type FixtureOptions, type FixtureReply, type Ready } from "./fixture-messages.js";
export { FixtureStartupError, type FixtureOptions } from "./fixture-messages.js";

// Tests request fixtures from the surviving outer owner. They never spawn a Go
// child or allocate private Dataset files in the killable worker process.
export async function withFixture<T>(workflow: (ready: Ready & { dataDir: string; pid: number }) => Promise<T>, options: FixtureOptions = {}): Promise<T> {
  if (!process.send) throw new Error("Run fixture tests through tests/contract/run.mjs so the supervisor owns cleanup");
  const id = randomUUID();
  let reply: ((response: FixtureReply) => void) | undefined;
  let rejectReply: ((error: Error) => void) | undefined;
  const receive = (message: unknown) => {
    if (isFixtureReply(message) && message.id === id) reply?.(message);
  };
  const disconnect = () => rejectReply?.(new Error("Fixture supervisor disconnected"));
  process.on("message", receive);
  process.on("disconnect", disconnect);
  process.channel?.ref();
  const request = (command: FixtureCommand) => new Promise<FixtureReply>((resolve, reject) => {
    reply = resolve;
    rejectReply = reject;
    if (!process.send || !process.connected) { reject(new Error("Fixture supervisor unavailable")); return; }
    process.send(command, undefined, undefined, (error: Error | null) => { if (error) reject(error); });
  });
  try {
    const outcome = await (async () => {
      const started = await request({ id, action: "start", options });
      if (started.event === "failure") throw replyError(started);
      if (started.event !== "ready") throw new Error("Fixture supervisor did not return readiness");
      return workflow(started.state);
    })().then((value) => ({ ok: true, value } as const), (error: unknown) => ({ ok: false, error } as const));
    let cleanupError: unknown;
    try {
      const stopped = await request({ id, action: "stop" });
      if (stopped.event === "failure") throw replyError(stopped);
      if (stopped.event !== "stopped") throw new Error("Fixture supervisor did not confirm cleanup");
    } catch (error) { cleanupError = error; }
    if (!outcome.ok) {
      if (cleanupError !== undefined) throw new AggregateError([outcome.error, cleanupError], "Workflow and fixture cleanup both failed");
      throw outcome.error;
    }
    if (cleanupError !== undefined) throw cleanupError;
    return outcome.value;
  } finally {
    process.off("message", receive);
    process.off("disconnect", disconnect);
    if (process.listenerCount("message") === 0) process.channel?.unref();
  }
}
