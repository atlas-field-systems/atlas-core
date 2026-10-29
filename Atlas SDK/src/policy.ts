import type { ErrorObject, ExchangeName, RequestOf } from '@atlas/protocol';

export type MutationPolicy<R> = Readonly<{
  kind: 'mutation';
  report?: (request: R) => boolean;
  identity: (request: R) => string;
  noEffect: (error: ErrorObject) => boolean;
}>;
type Policy<R> =
  | MutationPolicy<R>
  | Readonly<{
      kind:
        | 'read'
        | 'moving-list'
        | 'discovery'
        | 'history-view'
        | 'assigned-read'
        | 'capture'
        | 'replay'
        | 'release'
        | 'contact'
        | 'upload'
        | 'content'
        | 'reference';
    }>;
const request = {
  kind: 'mutation',
  identity: (input: { request_id: string }) => input.request_id,
  noEffect: () => false,
} satisfies MutationPolicy<{ request_id: string }>;
const execution = {
  kind: 'mutation',
  report: () => true,
  identity: (input: RequestOf<'ReportTaskExecution'> | RequestOf<'ReportTaskResults'>) =>
    JSON.stringify([
      input.evidence.asset_id,
      input.evidence.origin.process_generation,
      input.evidence.payload.task_id,
      input.evidence.report_id,
    ]),
  noEffect: () => false,
} satisfies MutationPolicy<RequestOf<'ReportTaskExecution'>>;

// `committed` describes a response envelope. Reports can mutate without that flag.
export const policies = {
  GetHealth: { kind: 'discovery' },
  GetReadiness: { kind: 'read' },
  GetReference: { kind: 'reference' },
  ListResources: { kind: 'moving-list' },
  ReadActivity: { kind: 'moving-list' },
  ListApiKeys: { kind: 'moving-list' },
  CreateApiKey: request,
  RevokeApiKey: request,
  ListOperators: { kind: 'moving-list' },
  GetOperator: { kind: 'read' },
  CreateOperator: request,
  EditOperator: request,
  DeleteOperator: request,
  RegisterAsset: request,
  ListAssets: { kind: 'moving-list' },
  GetAsset: { kind: 'read' },
  GetAssetByAlias: { kind: 'read' },
  UpdateAsset: {
    ...request,
    report: (input) =>
      input.report !== undefined &&
      input.alias === undefined &&
      input.description === undefined &&
      input.type === undefined &&
      input.capabilities === undefined,
  },
  DeleteAsset: request,
  GetAssetStatus: { kind: 'read' },
  GetAssetMovementHistory: { kind: 'history-view' },
  GetAssetObjects: { kind: 'moving-list' },
  CreateObservation: request,
  ReportObservation: {
    kind: 'mutation',
    report: () => true,
    identity: (input) =>
      JSON.stringify([input.observation_id, input.publisher_id, input.report.report_id]),
    noEffect: () => false,
  },
  EditObservation: request,
  ListObservations: { kind: 'moving-list' },
  GetObservation: { kind: 'read' },
  GetObservationByAlias: { kind: 'read' },
  GetObservationMovementHistory: { kind: 'history-view' },
  GetObservationObjects: { kind: 'moving-list' },
  ListTracks: { kind: 'moving-list' },
  GetTrack: { kind: 'read' },
  GetTrackByAlias: { kind: 'read' },
  EditTrack: request,
  GetTrackObservations: { kind: 'moving-list' },
  GetTrackMovementHistory: { kind: 'history-view' },
  GetTrackObjects: { kind: 'moving-list' },
  CreateGeofeature: request,
  ListGeofeatures: { kind: 'moving-list' },
  GetGeofeature: { kind: 'read' },
  GetGeofeatureByAlias: { kind: 'read' },
  EditGeofeature: request,
  DeleteGeofeature: request,
  GetGeofeatureObjects: { kind: 'moving-list' },
  CreateTask: {
    ...request,
    noEffect: (error) => error.code === 'unsupported_command',
  },
  ListTasks: { kind: 'moving-list' },
  GetTask: { kind: 'read' },
  ReportTaskExecution: execution,
  RequestTaskCancellation: request,
  ReportTaskResults: execution,
  GetTaskObjects: { kind: 'moving-list' },
  GetAssignedTasks: { kind: 'assigned-read' },
  SetTaskOrder: request,
  ConfirmTaskOrder: {
    kind: 'mutation',
    report: () => true,
    identity: (input) =>
      JSON.stringify([
        input.evidence.asset_id,
        input.evidence.origin.process_generation,
        input.evidence.report_id,
      ]),
    noEffect: () => false,
  },
  UploadObject: { kind: 'upload' },
  ListObjects: { kind: 'moving-list' },
  GetObject: { kind: 'read' },
  EditObject: request,
  DeleteObject: request,
  ReadObjectContent: { kind: 'content' },
  ReleaseHistoryView: { kind: 'release' },
  ReadSnapshot: { kind: 'capture' },
  ReleaseSnapshot: { kind: 'release' },
  ReadChanges: { kind: 'replay' },
  BeginAssetContact: { kind: 'contact' },
  ReplaceAssetProcess: request,
} satisfies { [K in ExchangeName]: Policy<RequestOf<K>> };
