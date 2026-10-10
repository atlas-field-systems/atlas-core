import type { components, paths } from "../generated/protocol.js";
import { commitCursorOf, Connection, sameDataset, type ConnectionOptions, type Discovery } from "./connection.js";
import { AtlasError, type MutationOutcome } from "./errors.js";

type Schemas = components["schemas"];
export type Entity = Schemas["Entity"];
export type Task = Schemas["Task"];
export type TaskQueue = Schemas["TaskQueue"];
export type MovementSample = Schemas["MovementSample"];
export type MoveToInput = Schemas["MoveTo"];
export type EntityListQuery = NonNullable<paths["/entities"]["get"]["parameters"]["query"]>;
export type TaskListQuery = NonNullable<paths["/tasks"]["get"]["parameters"]["query"]>;
export type MovementQuery = NonNullable<paths["/entities/{entity_id}/movement-history"]["get"]["parameters"]["query"]>;

// newIdentity allocates a stable request identity before first transmission.
export function newIdentity() {
  return crypto.randomUUID();
}

// TaskCreationDescriptor is retained by its caller while unresolved. Retrying
// the same descriptor recovers the original Task; a new descriptor
// deliberately creates new physical work.
export interface TaskCreationDescriptor {
  readonly kind: "task_creation";
  readonly datasetId: string;
  readonly body: Schemas["TaskCreate"];
}

export interface CancellationDescriptor {
  readonly kind: "task_cancellation";
  readonly datasetId: string;
  readonly taskId: string;
  readonly body: Schemas["TaskCancellationRequest"];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextPageToken: string | null;
}

export interface AssignedWork {
  readonly queueRevision: string;
  readonly taskQueue: TaskQueue;
  readonly tasks: readonly Task[];
}

// A changed queue between pages restarts the traversal; persistent change
// beyond this many restarts is reported rather than retried forever.
const maxAssignedRestarts = 5;

// AtlasClient is the HTTP-mode SDK client. Reads pass through to Core;
// mutations return Core's committed result without a local picture.
export class AtlasClient {
  readonly connection: Connection;

  constructor(options: ConnectionOptions) {
    this.connection = new Connection(options);
  }

  // discover negotiates the edition and binds the current Dataset.
  discover(): Promise<Discovery> {
    return this.connection.discover();
  }

  readiness() {
    return this.connection.read((session, signal) => session.transport.GET("/readiness", { signal }));
  }

  openAPI() {
    return this.connection.read((session, signal) => session.transport.GET("/openapi.json", { signal }));
  }

  async getEntity(entityId: string): Promise<Entity> {
    const response = await this.connection.read((session, signal) =>
      session.transport.GET("/entities/{entity_id}", {
        params: { header: session.headers, path: { entity_id: entityId } },
        signal,
      }),
    );
    return response.data;
  }

  async getEntityByAlias(alias: string): Promise<Entity> {
    const response = await this.connection.read((session, signal) =>
      session.transport.GET("/entities/alias/{alias}", {
        params: { header: session.headers, path: { alias } },
        signal,
      }),
    );
    return response.data;
  }

  async listEntities(query: EntityListQuery = {}): Promise<Page<Entity>> {
    const response = await this.connection.read((session, signal) =>
      session.transport.GET("/entities", { params: { header: session.headers, query }, signal }),
    );
    return { items: response.data.items, nextPageToken: response.data.next_page_token };
  }

  async getAssetStatus(entityId: string): Promise<Schemas["AssetStatus"]> {
    const response = await this.connection.read((session, signal) =>
      session.transport.GET("/entities/{entity_id}/status", {
        params: { header: session.headers, path: { entity_id: entityId } },
        signal,
      }),
    );
    return response.data.status;
  }

  async getTask(taskId: string): Promise<Task> {
    const response = await this.connection.read((session, signal) =>
      session.transport.GET("/tasks/{task_id}", {
        params: { header: session.headers, path: { task_id: taskId } },
        signal,
      }),
    );
    return response.data;
  }

  async listTasks(query: TaskListQuery = {}): Promise<Page<Task>> {
    const response = await this.connection.read((session, signal) =>
      session.transport.GET("/tasks", { params: { header: session.headers, query }, signal }),
    );
    return { items: response.data.items, nextPageToken: response.data.next_page_token };
  }

  // fetchAssignedTasks follows every page at one pinned queue revision and
  // restarts when the queue changes between pages. Reading never
  // acknowledges, starts or adopts work.
  async fetchAssignedTasks(
    assetId: string,
    options: { outstanding?: boolean; limit?: number } = {},
  ): Promise<AssignedWork> {
    for (let attempt = 0; attempt <= maxAssignedRestarts; attempt++) {
      const tasks = new Map<string, Task>();
      let token: string | undefined;
      let first: { queueRevision: string; taskQueue: TaskQueue } | undefined;
      try {
        do {
          const query = {
            ...(options.outstanding === undefined ? {} : { outstanding: options.outstanding }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(token === undefined ? {} : { page_token: token }),
          };
          const page = await this.connection.read((session, signal) =>
            session.transport.GET("/entities/{entity_id}/tasks", {
              params: { header: session.headers, path: { entity_id: assetId }, query },
              signal,
            }),
          );
          first ??= { queueRevision: page.data.queue_revision, taskQueue: page.data.task_queue };
          for (const task of page.data.items) tasks.set(task.id, task);
          token = page.data.next_page_token ?? undefined;
        } while (token !== undefined);
      } catch (error) {
        if (error instanceof AtlasError && error.code === "page_changed") continue;
        throw error;
      }
      if (first === undefined) throw new AtlasError("protocol_error", "Assigned work returned no page");
      return { ...first, tasks: [...tasks.values()] };
    }
    throw new AtlasError("page_changed", "The queue kept changing while assigned work was read");
  }

  async movementHistory(entityId: string, query: MovementQuery = {}) {
    const response = await this.connection.read((session, signal) =>
      session.transport.GET("/entities/{entity_id}/movement-history", {
        params: { header: session.headers, path: { entity_id: entityId }, query },
        signal,
      }),
    );
    return response.data;
  }

  // prepareTaskCreation binds a stable creation identity and the current
  // Dataset before first transmission.
  async prepareTaskCreation(request: {
    assetId: string;
    input: MoveToInput;
    scheduling?: Schemas["TaskScheduling"];
  }): Promise<TaskCreationDescriptor> {
    const session = await this.connection.session();
    return {
      kind: "task_creation",
      datasetId: session.datasetId,
      body: {
        request_id: newIdentity(),
        asset_id: request.assetId,
        input: request.input,
        ...(request.scheduling === undefined ? {} : { scheduling: request.scheduling }),
      },
    };
  }

  createTask(descriptor: TaskCreationDescriptor): Promise<MutationOutcome<Task>> {
    return this.connection.mutate(
      descriptor.datasetId,
      (session, signal) =>
        session.transport.POST("/tasks", { params: { header: session.headers }, body: descriptor.body, signal }),
      (data) => ({ value: required(data).data, commitCursor: commitCursorOf(data) }),
    );
  }

  async prepareCancellation(request: { taskId: string; reason?: string | null }): Promise<CancellationDescriptor> {
    const session = await this.connection.session();
    return {
      kind: "task_cancellation",
      datasetId: session.datasetId,
      taskId: request.taskId,
      body: {
        action: "request_cancellation",
        cancellation_id: newIdentity(),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      },
    };
  }

  // requestCancellation records cancellation intent. Cancelled requires the
  // assigned Asset's confirmation; this result never claims execution stopped.
  requestCancellation(descriptor: CancellationDescriptor): Promise<MutationOutcome<Task>> {
    return this.connection.mutate(
      descriptor.datasetId,
      (session, signal) =>
        session.transport.PATCH("/tasks/{task_id}/status", {
          params: { header: session.headers, path: { task_id: descriptor.taskId } },
          body: descriptor.body,
          signal,
        }),
      (data) => ({ value: required(data).data.task, commitCursor: commitCursorOf(data) }),
    );
  }

  // editEntity submits one Descriptive edit under the reviewed edit revision.
  // On conflict, reread and review; the SDK never refreshes the base itself.
  async editEntity(edit: {
    entityId: string;
    expectedEditRevision: string;
    alias?: string | null;
    subtype?: string | null;
  }): Promise<MutationOutcome<Entity>> {
    const session = await this.connection.session();
    const body: Schemas["EntityPatch"] = {
      expected_edit_revision: edit.expectedEditRevision,
      ...(edit.alias === undefined ? {} : { alias: edit.alias }),
      ...(edit.subtype === undefined ? {} : { subtype: edit.subtype }),
    };
    return this.connection.mutate(
      session.datasetId,
      (current, signal) =>
        current.transport.PATCH("/entities/{entity_id}", {
          params: { header: current.headers, path: { entity_id: edit.entityId } },
          body,
          signal,
        }),
      (data) => ({ value: required(data).data.entity, commitCursor: commitCursorOf(data) }),
    );
  }

  // deleteEntity deletes an Entity when permitted. Asset deletion revokes its
  // bound credentials.
  async deleteEntity(entityId: string): Promise<MutationOutcome<null>> {
    const session = await this.connection.session();
    return this.connection.mutate(
      session.datasetId,
      (current, signal) =>
        current.transport.DELETE("/entities/{entity_id}", {
          params: { header: session.headers, path: { entity_id: entityId } },
          signal,
        }),
      (_data, response) => ({ value: null, commitCursor: response.headers.get("Atlas-Commit-Cursor") ?? "" }),
    );
  }

  // datasetChanged reports whether a Dataset differs from the bound session.
  isCurrentDataset(datasetId: string) {
    const known = this.connection.known;
    return known !== undefined && sameDataset(known.datasetId, datasetId);
  }
}

function required<T>(data: T | undefined): T {
  if (data === undefined) throw new AtlasError("protocol_error", "Success response has no body");
  return data;
}
