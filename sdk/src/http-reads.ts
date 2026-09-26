import type createClient from "openapi-fetch";
import { componentsParametersPictureScopeValues, type components, type paths } from "./generated/protocol.js";
import { unwrap } from "./errors.js";
import { FeedConnection } from "./feed.js";
import { notify, type ChangeListener, type EntityReads, type FullScope } from "./types.js";

export type ProtocolClient = ReturnType<typeof createClient<paths>>;

/** Reads straight from Core, one request per call. */
export class HttpReads implements EntityReads {
  constructor(
    private readonly api: ProtocolClient,
    private readonly openFeed: () => WebSocket,
    private readonly apiKey: string,
    private readonly onListenerError: (error: unknown) => void,
  ) {}

  async entity(id: string) {
    return unwrap(await this.api.GET("/entities/{entity_id}", { params: { path: { entity_id: id } } }));
  }

  async assetStatus(id: string) {
    return unwrap(await this.api.GET("/entities/{entity_id}/status", { params: { path: { entity_id: id } } }));
  }

  async task(id: string) {
    return unwrap(await this.api.GET("/tasks/{task_id}", { params: { path: { task_id: id } } }));
  }

  async tasks(cursor?: string, limit?: number) {
    return unwrap(await this.api.GET("/tasks", { params: { query: { cursor, limit } } }));
  }

  async assignedTasks(assetId: string, cursor?: string, limit?: number) {
    return unwrap(await this.api.GET("/entities/{entity_id}/tasks", { params: { path: { entity_id: assetId }, query: { cursor, limit } } }));
  }

  async queryFull(cursor?: string, limit?: number, scope?: FullScope | components["parameters"]["PictureScope"]) {
    return unwrap(await this.api.GET("/queries/full", { params: { query: { cursor, limit, scope: scope === componentsParametersPictureScopeValues[0] ? scope : undefined } } }));
  }

  async changedSince(cursor: string, limit?: number, scope?: FullScope | components["parameters"]["PictureScope"]) {
    return unwrap(await this.api.GET("/queries/changed-since", { params: { query: { cursor, limit, scope: scope === componentsParametersPictureScopeValues[0] ? scope : undefined } } }));
  }

  /** Delivers live changes from a feed connection until unsubscribed or disconnected. */
  async subscribe(listener: ChangeListener) {
    const { connection } = await FeedConnection.open(this.openFeed(), this.apiKey);
    void (async () => {
      for (;;) {
        const message = await connection.next();
        if (message.type === "change") notify(listener, message.change, this.onListenerError);
      }
    })().catch(() => { /* The connection ended; the caller resubscribes if it needs more. */ });
    return () => connection.close();
  }
}
