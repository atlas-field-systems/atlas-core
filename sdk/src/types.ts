import type { components } from "./generated/protocol.js";

type Schemas = components["schemas"];
export type Readiness = Schemas["Readiness"];
export type Entity = Schemas["Entity"];
export type EntityPage = Schemas["EntityPage"];
export type EntityChange = Schemas["EntityChange"];
export type Task = Schemas["Task"];
export type TaskPage = Schemas["TaskPage"];
export type PictureCoverage = Schemas["PictureCoverage"];
export type TaskSubmission = Schemas["TaskSubmission"];
export type TaskStatusUpdate = Schemas["TaskStatusUpdate"];
export type ChangePage = Schemas["ChangePage"];
export type AssetStatus = Schemas["AssetStatus"];
export type AssetStatusView = Schemas["AssetStatusView"];
export type FeedHello = Schemas["FeedHello"];
export type FeedChange = Schemas["FeedChange"];
export type FeedGap = Schemas["FeedGap"];
export type FeedProgress = Schemas["FeedProgress"];
export type Plugin = Schemas["Plugin"];
export type Operation = Schemas["Operation"];
export type OperationSubmission = Schemas["OperationSubmission"];
export type OperationReport = Schemas["OperationReport"];
export type ChangeListener = (change: EntityChange) => void;

/** Operational reads offered identically by all three read modes. */
export interface EntityReads {
  entity(id: string): Promise<Entity>;
  assetStatus(id: string): Promise<AssetStatusView>;
  task(id: string, options?: { scope?: "full" }): Promise<Task>;
  tasks(cursor?: string, limit?: number, scope?: "full"): Promise<TaskPage>;
  assignedTasks(assetId: string, cursor?: string, limit?: number): Promise<TaskPage>;
  queryFull(cursor?: string, limit?: number, scope?: "full"): Promise<EntityPage>;
  changedSince(cursor: string, limit?: number, scope?: "full"): Promise<ChangePage>;
  /** Calls listener for each committed change; resolves to an unsubscribe function. */
  subscribe(listener: ChangeListener): Promise<() => void>;
}

/** Calls an application listener; its failure never interrupts delivery. */
export function notify(listener: ChangeListener, change: EntityChange, onError: (error: unknown) => void): void {
  try {
    listener(structuredClone(change));
  } catch (error) {
    onError(error);
  }
}
