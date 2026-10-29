import { exchanges } from '@atlas/protocol';
import type { ExchangeName, RequestOf, ResponseOf } from '@atlas/protocol';
import { Session } from './connection.js';
import type { ClientOptions } from './connection.js';
import { list } from './lists.js';
import { policies } from './policy.js';
import { Operations } from './prepared.js';
import type { ConnectionState, Prepared, RequestOptions, WaitResult } from './contracts.js';
import type { ListCursor } from './lists.js';

type Reads<M extends Record<string, ExchangeName>> = {
  readonly [P in keyof M]: (
    request: RequestOf<M[P]>,
    options?: RequestOptions,
  ) => Promise<WaitResult<ResponseOf<M[P]>>>;
};
type Lists<M extends Record<string, ExchangeName>> = {
  readonly [P in keyof M]: (
    request: Exclude<RequestOf<M[P]>, { page_token: string }>,
  ) => ListCursor<ResponseOf<M[P]>>;
};
type Writes<M extends Record<string, ExchangeName>> = {
  readonly [P in keyof M]: (
    request: RequestOf<M[P]>,
  ) => Prepared<RequestOf<M[P]>, ResponseOf<M[P]>>;
};
export type HttpResources = Readonly<{
  assets: Reads<{
    get: 'GetAsset';
    byAlias: 'GetAssetByAlias';
    status: 'GetAssetStatus';
  }> &
    Lists<{ list: 'ListAssets'; objects: 'GetAssetObjects' }> &
    Writes<{
      register: 'RegisterAsset';
      update: 'UpdateAsset';
      delete: 'DeleteAsset';
      replaceProcess: 'ReplaceAssetProcess';
    }>;
  observations: Reads<{
    get: 'GetObservation';
    byAlias: 'GetObservationByAlias';
  }> &
    Lists<{ list: 'ListObservations'; objects: 'GetObservationObjects' }> &
    Writes<{
      create: 'CreateObservation';
      report: 'ReportObservation';
      edit: 'EditObservation';
    }>;
  tracks: Reads<{ get: 'GetTrack'; byAlias: 'GetTrackByAlias' }> &
    Lists<{
      list: 'ListTracks';
      objects: 'GetTrackObjects';
      observations: 'GetTrackObservations';
    }> &
    Writes<{ edit: 'EditTrack' }>;
  geofeatures: Reads<{
    get: 'GetGeofeature';
    byAlias: 'GetGeofeatureByAlias';
  }> &
    Lists<{ list: 'ListGeofeatures'; objects: 'GetGeofeatureObjects' }> &
    Writes<{
      create: 'CreateGeofeature';
      edit: 'EditGeofeature';
      delete: 'DeleteGeofeature';
    }>;
  tasks: Reads<{ get: 'GetTask' }> &
    Lists<{ list: 'ListTasks'; objects: 'GetTaskObjects' }> &
    Writes<{
      create: 'CreateTask';
      cancel: 'RequestTaskCancellation';
      reportExecution: 'ReportTaskExecution';
      reportResults: 'ReportTaskResults';
      setOrder: 'SetTaskOrder';
      confirmOrder: 'ConfirmTaskOrder';
    }>;
  objects: Reads<{ get: 'GetObject' }> &
    Lists<{ list: 'ListObjects' }> &
    Writes<{ edit: 'EditObject'; delete: 'DeleteObject' }>;
  operators: Reads<{ get: 'GetOperator' }> &
    Lists<{ list: 'ListOperators' }> &
    Writes<{
      create: 'CreateOperator';
      edit: 'EditOperator';
      delete: 'DeleteOperator';
    }>;
  apiKeys: Lists<{ list: 'ListApiKeys' }> &
    Writes<{ create: 'CreateApiKey'; revoke: 'RevokeApiKey' }>;
}> &
  Lists<{ resources: 'ListResources'; activity: 'ReadActivity' }> &
  Reads<{ readiness: 'GetReadiness' }>;
export type Client = HttpResources &
  Readonly<{
    mode: 'http';
    http: HttpResources;
    state: ConnectionState;
    connect: () => Promise<WaitResult<ResponseOf<'GetHealth'>>>;
    recover: () => Promise<WaitResult<ResponseOf<'GetHealth'>>>;
    close: () => Promise<void>;
  }>;

export function httpResources(session: Session, operations: Operations): HttpResources {
  return Object.freeze({
    assets: Object.freeze({
      get: session.read(exchanges.GetAsset),
      byAlias: session.read(exchanges.GetAssetByAlias),
      status: session.read(exchanges.GetAssetStatus),
      list: list(session, exchanges.ListAssets),
      objects: list(session, exchanges.GetAssetObjects),
      register: operations.bind(exchanges.RegisterAsset, policies.RegisterAsset),
      update: operations.bind(exchanges.UpdateAsset, policies.UpdateAsset),
      delete: operations.bind(exchanges.DeleteAsset, policies.DeleteAsset),
      replaceProcess: operations.bind(exchanges.ReplaceAssetProcess, policies.ReplaceAssetProcess),
    }),
    observations: Object.freeze({
      get: session.read(exchanges.GetObservation),
      byAlias: session.read(exchanges.GetObservationByAlias),
      list: list(session, exchanges.ListObservations),
      objects: list(session, exchanges.GetObservationObjects),
      create: operations.bind(exchanges.CreateObservation, policies.CreateObservation),
      report: operations.bind(exchanges.ReportObservation, policies.ReportObservation),
      edit: operations.bind(exchanges.EditObservation, policies.EditObservation),
    }),
    tracks: Object.freeze({
      get: session.read(exchanges.GetTrack),
      byAlias: session.read(exchanges.GetTrackByAlias),
      list: list(session, exchanges.ListTracks),
      observations: list(session, exchanges.GetTrackObservations),
      objects: list(session, exchanges.GetTrackObjects),
      edit: operations.bind(exchanges.EditTrack, policies.EditTrack),
    }),
    geofeatures: Object.freeze({
      get: session.read(exchanges.GetGeofeature),
      byAlias: session.read(exchanges.GetGeofeatureByAlias),
      list: list(session, exchanges.ListGeofeatures),
      objects: list(session, exchanges.GetGeofeatureObjects),
      create: operations.bind(exchanges.CreateGeofeature, policies.CreateGeofeature),
      edit: operations.bind(exchanges.EditGeofeature, policies.EditGeofeature),
      delete: operations.bind(exchanges.DeleteGeofeature, policies.DeleteGeofeature),
    }),
    tasks: Object.freeze({
      get: session.read(exchanges.GetTask),
      list: list(session, exchanges.ListTasks),
      objects: list(session, exchanges.GetTaskObjects),
      create: operations.bind(exchanges.CreateTask, policies.CreateTask),
      cancel: operations.bind(exchanges.RequestTaskCancellation, policies.RequestTaskCancellation),
      reportExecution: operations.bind(exchanges.ReportTaskExecution, policies.ReportTaskExecution),
      reportResults: operations.bind(exchanges.ReportTaskResults, policies.ReportTaskResults),
      setOrder: operations.bind(exchanges.SetTaskOrder, policies.SetTaskOrder),
      confirmOrder: operations.bind(exchanges.ConfirmTaskOrder, policies.ConfirmTaskOrder),
    }),
    objects: Object.freeze({
      get: session.read(exchanges.GetObject),
      list: list(session, exchanges.ListObjects),
      edit: operations.bind(exchanges.EditObject, policies.EditObject),
      delete: operations.bind(exchanges.DeleteObject, policies.DeleteObject),
    }),
    operators: Object.freeze({
      get: session.read(exchanges.GetOperator),
      list: list(session, exchanges.ListOperators),
      create: operations.bind(exchanges.CreateOperator, policies.CreateOperator),
      edit: operations.bind(exchanges.EditOperator, policies.EditOperator),
      delete: operations.bind(exchanges.DeleteOperator, policies.DeleteOperator),
    }),
    apiKeys: Object.freeze({
      list: list(session, exchanges.ListApiKeys),
      create: operations.bind(exchanges.CreateApiKey, policies.CreateApiKey),
      revoke: operations.bind(exchanges.RevokeApiKey, policies.RevokeApiKey),
    }),
    resources: list(session, exchanges.ListResources),
    activity: list(session, exchanges.ReadActivity),
    readiness: session.read(exchanges.GetReadiness),
  });
}

export function createClient(options: ClientOptions): Client {
  const session = new Session(options);
  const operations = new Operations(session);
  const http = httpResources(session, operations);
  return Object.freeze({
    mode: 'http' satisfies 'http',
    ...http,
    http,
    get state() {
      return session.state;
    },
    connect: () => session.discover(),
    recover: () => session.discover(true),
    async close() {
      await session.close();
      operations.close();
    },
  });
}
