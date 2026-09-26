import { PictureError } from "./errors.js";
import type { HttpReads } from "./http-reads.js";
import type { Picture } from "./picture.js";
import type { ChangeListener, EntityReads, FullScope } from "./types.js";

/** Routes the Asset's maintained subset locally and deliberate broader reads to Core. */
export class HybridReads implements EntityReads {
  constructor(
    private readonly assetId: string,
    private readonly picture: Picture,
    private readonly http: HttpReads,
  ) {}

  entity(id: string) { return id === this.assetId ? this.picture.entity(id) : this.http.entity(id); }
  assetStatus(id: string) { return id === this.assetId ? this.picture.assetStatus(id) : this.http.assetStatus(id); }

  /** An unknown ID might be an in-scope Task still in flight. Broader Task reads are explicit. */
  task(id: string, options: { scope?: FullScope } = {}) {
    return options.scope === "full" ? this.http.task(id) : this.picture.task(id);
  }

  tasks(cursor?: string, limit?: number, scope?: FullScope) {
    if (scope === "full" && cursor?.startsWith("local.")) throw new PictureError("invalid_cursor", "A local cursor cannot be used for a Core query.");
    return scope === "full" ? this.http.tasks(cursor, limit) : this.picture.tasks(cursor, limit);
  }

  assignedTasks(assetId: string, cursor?: string, limit?: number) {
    return assetId === this.assetId ? this.picture.assignedTasks(assetId, cursor, limit) : this.http.assignedTasks(assetId, cursor, limit);
  }

  queryFull(cursor?: string, limit?: number, scope?: FullScope) {
    if (scope === "full" && cursor?.startsWith("local.")) throw new PictureError("invalid_cursor", "A local cursor cannot be used for a Core query.");
    return scope === "full" ? this.http.queryFull(cursor, limit) : this.picture.queryFull(cursor, limit);
  }

  changedSince(cursor: string, limit?: number, scope?: FullScope) {
    if (scope === "full" && cursor.startsWith("local.")) throw new PictureError("invalid_cursor", "A local cursor cannot be used for a Core query.");
    return scope === "full" ? this.http.changedSince(cursor, limit) : this.picture.changedSince(cursor, limit);
  }

  subscribe(listener: ChangeListener) { return this.picture.subscribe(listener); }
}
