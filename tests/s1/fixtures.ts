import type { components } from "../../Atlas SDK/src/index.js";
type S = components["schemas"];
export const assetId = "11111111-1111-4111-8111-111111111111";
export const datasetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const instant = "2026-10-09T10:00:00Z";
export const queue = {
  revision: "0",
  requested_revision: "0",
  requested_task_ids: [],
  confirmed_revision: null,
  confirmed_task_ids: [],
  adoption: { state: "none", reported_revision: null, reason: null },
  active_queued_task_id: null,
  suspended_task_id: null,
  execution_order: null,
} satisfies S["TaskQueue"];
export const asset = {
  id: assetId,
  type: "asset",
  alias: null,
  subtype: null,
  version: "1",
  edit_revision: "1",
  created_at: instant,
  updated_at: instant,
  components: {
    status: { value: "unknown", reason: null, reported_at: null, received_at: null, changed_at: null },
    communications: { state: "offline" },
    heartbeat: { last_seen: null },
  },
  command_manifest: [],
  reporting: {},
  task_queue: queue,
  process_authority: null,
} satisfies S["Asset"];
export function task(id: string): S["Task"] {
  return {
    id,
    asset_id: assetId,
    command: "move_to",
    input: { target: { kind: "position", position: { latitude: 10, longitude: 20 } } },
    scheduling: "queued",
    submission_sequence: "1",
    status: "pending",
    execution_status: "pending",
    execution_id: null,
    progress: null,
    failure: null,
    cancellation_requests: [],
    acknowledged_at: null,
    started_at: null,
    finished_at: null,
    created_at: instant,
    updated_at: instant,
    version: "1",
  };
}
