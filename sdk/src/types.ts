import type { components } from "./generated/protocol.js";

type Schemas = components["schemas"];
export type Readiness = Schemas["Readiness"];
export type Entity = Schemas["Entity"];
export type EntityPage = Schemas["EntityPage"];
export type EntityChange = Schemas["EntityChange"];
export type ChangePage = Schemas["ChangePage"];
export type AssetStatus = Schemas["AssetStatus"];
export type AssetStatusView = Schemas["AssetStatusView"];
export type FeedHello = Schemas["FeedHello"];
export type FeedChange = Schemas["FeedChange"];
export type FeedGap = Schemas["FeedGap"];
export type Plugin = Schemas["Plugin"];
export type Operation = Schemas["Operation"];
export type OperationSubmission = Schemas["OperationSubmission"];
export type OperationReport = Schemas["OperationReport"];
export type ChangeListener = (change: EntityChange) => void;

/** Operational reads offered identically by HTTP and full synchronization. */
export interface EntityReads {
  entity(id: string): Promise<Entity>;
  assetStatus(id: string): Promise<AssetStatusView>;
  queryFull(cursor?: string, limit?: number): Promise<EntityPage>;
  changedSince(cursor: string, limit?: number): Promise<ChangePage>;
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
