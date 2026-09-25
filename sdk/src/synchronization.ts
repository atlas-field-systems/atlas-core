import { AtlasError, PictureError, isCursorExpired } from "./errors.js";
import type { FeedConnection } from "./feed.js";
import type { Picture } from "./picture.js";
import type { ChangePage, EntityPage, FeedChange, FeedHello } from "./types.js";

/** The Core operations synchronization uses. */
export interface Remote {
  snapshotPage(cursor: string | undefined, limit: number): Promise<EntityPage>;
  changesSince(cursor: string, limit: number): Promise<ChangePage>;
  openFeed(): Promise<{ connection: FeedConnection; hello: FeedHello }>;
}

/** Replay page size: the Protocol maximum, so catching up takes few requests. */
const replayPageSize = 100;
/** Pause before reconnecting after the feed ends. */
const reconnectDelayMs = 200;
/** Rebuilds allowed before the first ready state, so a load that can never finish fails instead of looping. */
const maxInitialRebuilds = 3;

interface Run {
  controller: AbortController;
  ready: Promise<void>;
  rejectReady(error: unknown): void;
}

/**
 * Keeps a Picture current: load a snapshot, replay from its baseline to the
 * feed's subscription point, then apply live changes in sequence order. A
 * missing change is fetched by replay; a feed disconnect reconnects and
 * replays; an expired cursor or new Dataset rebuilds from a new snapshot.
 */
export class Synchronization {
  #run?: Run;

  constructor(
    private readonly picture: Picture,
    private readonly remote: Remote,
    private readonly snapshotPageSize: number,
  ) {}

  /** Starts synchronizing and resolves at the first ready state. */
  start(): Promise<void> {
    if (this.#run) return this.#run.ready;
    const controller = new AbortController();
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.#run = { controller, ready, rejectReady };
    void this.#synchronize(controller.signal, resolveReady, rejectReady);
    return ready;
  }

  /** Stops synchronizing. A pending start rejects with code "stopped". */
  stop(): void {
    const run = this.#run;
    this.#run = undefined;
    const stopped = new PictureError("stopped", "Synchronization was stopped.");
    run?.controller.abort(stopped);
    run?.rejectReady(stopped);
    this.picture.markStopped();
  }

  async #synchronize(signal: AbortSignal, onReady: () => void, onFailure: (error: unknown) => void): Promise<void> {
    let everReady = false;
    let needsSnapshot = true;
    let rebuilds = 0;
    const ready = () => { everReady = true; onReady(); };
    while (!signal.aborted) {
      try {
        if (needsSnapshot) await this.#loadSnapshot(signal);
        needsSnapshot = false;
        await this.#follow(signal, ready);
      } catch (error) {
        if (signal.aborted) return;
        if (requiresSnapshot(error) && (everReady || ++rebuilds <= maxInitialRebuilds)) {
          needsSnapshot = true;
          continue;
        }
        if (!everReady || isFatal(error)) return this.#fail(error, onFailure);
      }
      this.picture.markStale();
      await delay(reconnectDelayMs);
    }
  }

  #fail(error: unknown, onFailure: (error: unknown) => void): void {
    this.#run = undefined;
    this.picture.markFailed();
    onFailure(error);
  }

  async #loadSnapshot(signal: AbortSignal): Promise<void> {
    this.picture.reset();
    const first = await settled(this.remote.snapshotPage(undefined, this.snapshotPageSize), signal);
    this.picture.load(first);
    for (let page = first; page.next_cursor;) {
      page = await settled(this.remote.snapshotPage(page.next_cursor, this.snapshotPageSize), signal);
      this.picture.load(page);
    }
    this.picture.setBaseline(first.dataset_id, first.baseline_sequence, first.baseline);
  }

  async #follow(signal: AbortSignal, onReady: () => void): Promise<void> {
    const { connection, hello } = await settled(this.remote.openFeed(), signal);
    const closeOnStop = () => connection.close();
    signal.addEventListener("abort", closeOnStop, { once: true });
    try {
      if (hello.dataset_id !== this.picture.datasetId) throw new PictureError("dataset_changed", "The feed belongs to another Dataset.");
      await this.#replayThrough(hello.sequence, signal);
      this.picture.markReady();
      onReady();
      for (;;) {
        const message = await settled(connection.next(), signal);
        if (message.type === "gap") throw new PictureError("cursor_expired", "The feed fell behind Core's change log.");
        await this.#receive(message, signal);
      }
    } finally {
      signal.removeEventListener("abort", closeOnStop);
      connection.close();
    }
  }

  async #receive({ change, cursor }: FeedChange, signal: AbortSignal): Promise<void> {
    if (change.sequence > this.picture.applied + 1) await this.#replayThrough(change.sequence - 1, signal);
    if (change.sequence !== this.picture.applied + 1) return;
    this.picture.apply(change);
    this.picture.cursor = cursor;
  }

  async #replayThrough(target: number, signal: AbortSignal): Promise<void> {
    while (this.picture.applied < target) {
      const page = await settled(this.remote.changesSince(this.picture.cursor, replayPageSize), signal);
      if (page.changes.length === 0) throw new PictureError("replay_gap", "Core did not return the missing changes.");
      for (const change of page.changes) {
        if (change.sequence > this.picture.applied) this.picture.apply(change);
      }
      this.picture.cursor = page.cursor;
    }
  }
}

/** Awaits a request, then stops if synchronization was stopped meanwhile. */
async function settled<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const value = await pending;
  signal.throwIfAborted();
  return value;
}

function requiresSnapshot(error: unknown): boolean {
  return isCursorExpired(error) || ((error instanceof AtlasError || error instanceof PictureError) && error.code === "dataset_changed");
}

/** Failures that retrying cannot fix: a revoked credential or a picture too large. */
function isFatal(error: unknown): boolean {
  if (error instanceof AtlasError) return error.status === 401 || error.status === 403;
  return error instanceof PictureError && error.code === "resource_limit";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
