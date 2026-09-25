import { PictureError } from "./errors.js";
import { notify, type ChangeListener, type ChangePage, type Entity, type EntityChange, type EntityPage, type EntityReads } from "./types.js";

export type SynchronizationState = "initializing" | "ready" | "stale" | "stopped" | "failed";

export interface PictureLimits {
  maxEntities: number;
  localHistoryLimit: number;
}

/**
 * The locally applied Dataset picture. It applies changes strictly in
 * sequence order and serves reads only while ready; it never falls back to
 * Core. Synchronization decides what to apply.
 */
export class Picture implements EntityReads {
  readonly #entities = new Map<string, Entity>();
  readonly #listeners = new Set<ChangeListener>();
  readonly #waiters = new Set<() => void>();
  readonly #instance = crypto.randomUUID();
  #history: EntityChange[] = [];
  #historyStart = 0;
  #state: SynchronizationState = "initializing";
  #datasetId = "";
  #generation = 0;
  #applied = 0;
  /** Core's replay cursor after the last applied change. */
  cursor = "";

  constructor(
    private readonly limits: PictureLimits,
    private readonly onListenerError: (error: unknown) => void,
  ) {}

  get status() {
    return { state: this.#state, datasetId: this.#datasetId || null, sequence: this.#applied, generation: this.#generation };
  }

  get applied() { return this.#applied; }
  get datasetId() { return this.#datasetId; }

  /** Discards the picture to load a new snapshot. Local cursors from before stop working. */
  reset(): void {
    this.#generation++;
    this.#entities.clear();
    this.#history = [];
    this.#setState("initializing");
  }

  /** Adds one snapshot page. Pages may hold states newer than the baseline. */
  load(page: EntityPage): void {
    for (const entity of page.entities) this.#store(entity);
  }

  /** Marks the loaded snapshot as the state at its baseline. */
  setBaseline(datasetId: string, sequence: number, cursor: string): void {
    this.#datasetId = datasetId;
    this.#applied = sequence;
    this.#historyStart = sequence;
    this.cursor = cursor;
  }

  /** Applies the next change in sequence and notifies local subscribers. */
  apply(change: EntityChange): void {
    if (change.sequence !== this.#applied + 1) throw new PictureError("replay_gap", `Expected change ${this.#applied + 1}, got ${change.sequence}.`);
    if (change.dataset_id !== this.#datasetId) throw new PictureError("dataset_changed", "A change belongs to another Dataset.");
    const current = this.#entities.get(change.resource_id);
    if (!current || change.entity.version > current.version) this.#store(change.entity);
    this.#applied = change.sequence;
    this.#remember(change);
    for (const listener of this.#listeners) notify(listener, change, this.onListenerError);
    this.#notifyWaiters();
  }

  markReady(): void { this.#setState("ready"); }
  markStale(): void { this.#setState("stale"); }
  markStopped(): void { this.#setState("stopped"); }
  markFailed(): void { this.#setState("failed"); }

  async entity(id: string) {
    this.#requireReadable();
    const entity = this.#entities.get(id);
    if (!entity) throw new PictureError("not_found", "The Entity is not in the local picture.");
    return structuredClone(entity);
  }

  async assetStatus(id: string) {
    const { components } = await this.entity(id);
    return { status: components.status, communications: components.communications, heartbeat: components.heartbeat };
  }

  async queryFull(cursor?: string, limit = 50): Promise<EntityPage> {
    this.#requireReadable();
    requirePositive(limit);
    const offset = cursor ? this.#readCursor(cursor, "snapshot").offset : 0;
    const entities = [...this.#entities.values()].sort((a, b) => a.id.localeCompare(b.id));
    const end = offset + limit;
    return {
      dataset_id: this.#datasetId,
      baseline: this.#cursor("changes", 0),
      baseline_sequence: this.#applied,
      entities: structuredClone(entities.slice(offset, end)),
      ...(end < entities.length ? { next_cursor: this.#cursor("snapshot", end) } : {}),
    };
  }

  async changedSince(cursor: string, limit = 50): Promise<ChangePage> {
    this.#requireReadable();
    requirePositive(limit);
    const after = this.#readCursor(cursor, "changes").sequence;
    if (after < this.#historyStart) throw new PictureError("cursor_expired", "Local change history no longer covers this cursor.");
    const changes = this.#history.filter((change) => change.sequence > after).slice(0, limit);
    const last = changes.at(-1)?.sequence ?? after;
    return { dataset_id: this.#datasetId, changes: structuredClone(changes), cursor: this.#cursor("changes", 0, last) };
  }

  async subscribe(listener: ChangeListener) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Resolves once the picture has applied the commit that produced entity. */
  waitFor(entity: Entity, timeoutMs: number): Promise<void> {
    if (entity.dataset_id !== this.#datasetId) return Promise.reject(new PictureError("dataset_changed", "This write belongs to another Dataset."));
    return new Promise((resolve, reject) => {
      const finish = (error?: PictureError) => {
        clearTimeout(timeout);
        this.#waiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.#state === "stopped" || this.#state === "failed") finish(new PictureError("sync_unavailable", "Synchronization ended before the write was applied."));
        else if (this.#state === "ready" && this.#applied >= entity.change_sequence) finish();
      };
      const timeout = setTimeout(() => finish(new PictureError("sync_timeout", "The write committed, but the picture has not applied it yet.")), timeoutMs);
      this.#waiters.add(check);
      check();
    });
  }

  #store(entity: Entity): void {
    if (!this.#entities.has(entity.id) && this.#entities.size >= this.limits.maxEntities) {
      throw new PictureError("resource_limit", "The local picture exceeds its Entity limit.");
    }
    this.#entities.set(entity.id, entity);
  }

  #remember(change: EntityChange): void {
    this.#history.push(change);
    if (this.#history.length > this.limits.localHistoryLimit) this.#historyStart = this.#history.shift()!.sequence;
  }

  #setState(state: SynchronizationState): void {
    this.#state = state;
    this.#notifyWaiters();
  }

  #notifyWaiters(): void {
    for (const check of this.#waiters) check();
  }

  #requireReadable(): void {
    if (this.#state === "stale") throw new PictureError("stale", "The local picture is stale; no request was made to Core.");
    if (this.#state !== "ready") throw new PictureError("not_ready", "The local picture is not ready.");
  }

  /** Local cursors name this picture instance and generation, so they never reach Core or outlive a rebuild. */
  #cursor(list: "snapshot" | "changes", offset: number, sequence = this.#applied): string {
    return `local.${btoa(JSON.stringify({ instance: this.#instance, generation: this.#generation, list, sequence, offset }))}`;
  }

  #readCursor(cursor: string, list: "snapshot" | "changes"): { sequence: number; offset: number } {
    let position: { instance?: string; generation?: number; list?: string; sequence?: number; offset?: number };
    try {
      position = JSON.parse(atob(cursor.replace(/^local\./, "")));
    } catch {
      throw new PictureError("invalid_cursor", "The local cursor is invalid.");
    }
    if (position.list !== list || !Number.isSafeInteger(position.sequence) || !Number.isSafeInteger(position.offset)) {
      throw new PictureError("invalid_cursor", "The local cursor is invalid.");
    }
    if (position.instance !== this.#instance || position.generation !== this.#generation) {
      throw new PictureError("cursor_expired", "The local cursor belongs to an earlier picture.");
    }
    if (list === "snapshot" && position.sequence !== this.#applied) {
      throw new PictureError("cursor_expired", "The picture changed during pagination.");
    }
    return { sequence: position.sequence!, offset: position.offset! };
  }
}

function requirePositive(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new PictureError("invalid_limit", "The page limit must be a positive integer.");
}
