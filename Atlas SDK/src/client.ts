import { exchanges } from '@atlas/protocol';
import type { ExchangeName, RequestOf, ResponseOf } from '@atlas/protocol';
import { Session } from './connection.js';
import type { ClientOptions } from './connection.js';
import { list } from './lists.js';
import { policies } from './policy.js';
import { Operations } from './prepared.js';
import type { ConnectionState, Prepared, RequestOptions, WaitResult } from './contracts.js';
import type { ListCursor } from './lists.js';
import { Picture } from './picture.js';
import { SdkError } from './contracts.js';
import { createRemoteReads } from './remote-reads.js';
import type { RemoteReads } from './remote-reads.js';
import { createReporting } from './reporting.js';
import type { Reporting } from './reporting.js';
import { createTransfers } from './transfers.js';
import type { Transfers } from './transfers.js';
import { ClientCloseError } from './lifecycle.js';
import type { ClientCloseResult } from './lifecycle.js';

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
  assets: Readonly<{ history: RemoteReads['history']['asset']; contact: RemoteReads['contact'] }> &
    Reads<{
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
  observations: Readonly<{ history: RemoteReads['history']['observation'] }> &
    Reads<{
      get: 'GetObservation';
      byAlias: 'GetObservationByAlias';
    }> &
    Lists<{ list: 'ListObservations'; objects: 'GetObservationObjects' }> &
    Writes<{
      create: 'CreateObservation';
      report: 'ReportObservation';
      edit: 'EditObservation';
    }>;
  tracks: Readonly<{ history: RemoteReads['history']['track'] }> &
    Reads<{ get: 'GetTrack'; byAlias: 'GetTrackByAlias' }> &
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
  tasks: Readonly<{ assigned: RemoteReads['assigned'] }> &
    Reads<{ get: 'GetTask' }> &
    Lists<{ list: 'ListTasks'; objects: 'GetTaskObjects' }> &
    Writes<{
      create: 'CreateTask';
      cancel: 'RequestTaskCancellation';
      reportExecution: 'ReportTaskExecution';
      reportResults: 'ReportTaskResults';
      setOrder: 'SetTaskOrder';
      confirmOrder: 'ConfirmTaskOrder';
    }>;
  objects: Readonly<{ upload: Transfers['prepareUpload']; content: Transfers['getContent'] }> &
    Reads<{ get: 'GetObject' }> &
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
export type HttpClient = HttpResources &
  Readonly<{
    mode: 'http';
    http: HttpResources;
    state: ConnectionState;
    connect: () => Promise<WaitResult<ResponseOf<'GetHealth'>>>;
    recover: () => Promise<WaitResult<ResponseOf<'GetHealth'>>>;
    reporting: Reporting;
    reference: Transfers['getReference'];
    close: () => Promise<ClientCloseResult>;
  }>;
type LocalReads = Picture['reads'];
export type FullClient = Omit<HttpClient, 'mode' | keyof LocalReads> &
  Readonly<{
    mode: 'full';
    picture: Pick<Picture, 'status' | 'cursor' | 'changedSince' | 'subscribe' | 'retry'>;
  }> & {
    readonly [K in keyof LocalReads]: Omit<HttpResources[K], keyof LocalReads[K]> & LocalReads[K];
  };
export type Client = HttpClient | FullClient;

export function httpResources(
  session: Session,
  operations: Operations,
  remote: RemoteReads,
  transfers: Transfers,
): HttpResources {
  return Object.freeze({
    assets: Object.freeze({
      history: remote.history.asset,
      contact: remote.contact,
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
      history: remote.history.observation,
      get: session.read(exchanges.GetObservation),
      byAlias: session.read(exchanges.GetObservationByAlias),
      list: list(session, exchanges.ListObservations),
      objects: list(session, exchanges.GetObservationObjects),
      create: operations.bind(exchanges.CreateObservation, policies.CreateObservation),
      report: operations.bind(exchanges.ReportObservation, policies.ReportObservation),
      edit: operations.bind(exchanges.EditObservation, policies.EditObservation),
    }),
    tracks: Object.freeze({
      history: remote.history.track,
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
      assigned: remote.assigned,
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
      upload: transfers.prepareUpload,
      content: transfers.getContent,
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

export function createClient(options: ClientOptions & { mode: 'full' }): FullClient;
export function createClient(options: ClientOptions & { mode?: 'http' }): HttpClient;
export function createClient(options: ClientOptions): Client;
export function createClient(options: ClientOptions): Client {
  if (options.mode === 'full' && options.limits?.concurrentAttempts === 1)
    throw new SdkError('invalid_options');
  const session = new Session(options);
  const operations = new Operations(session);
  const remote = createRemoteReads(session, operations, options.remote);
  const reporting = createReporting(session, operations);
  const transfers = createTransfers(session, operations);
  const http = httpResources(session, operations, remote, transfers);
  const picture = options.mode === 'full' ? new Picture(session, options.picture) : undefined;
  let closing: Promise<ClientCloseResult> | undefined;
  const lifecycle = {
    http,
    reporting,
    reference: transfers.getReference,
    connect: () => session.discover(),
    recover: () => session.discover(true),
    close(): Promise<ClientCloseResult> {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        const [pictureResult, remoteResult] = await Promise.allSettled([
          pictureShutdown,
          remoteShutdown,
        ]);
        if (pictureResult.status === 'rejected') errors.push(pictureResult.reason);
        if (remoteResult.status === 'rejected') errors.push(remoteResult.reason);
        try {
          await session.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await picture?.settled();
        } catch (error) {
          errors.push(error);
        }
        try {
          operations.close();
        } catch (error) {
          errors.push(error);
        }
        if (remoteResult.status === 'rejected') throw new ClientCloseError(errors, undefined);
        if (errors.length) throw new ClientCloseError(errors, remoteResult.value);
        return Object.freeze({ remote: remoteResult.value });
      });
      // Publish the close owner before aborting user-owned sources can re-enter it.
      const drained = session.beginClose();
      const pictureShutdown = picture?.shutdown(drained);
      const remoteShutdown = remote.close(drained);
      return closing;
    },
  };
  if (picture)
    return Object.freeze({
      ...http,
      ...lifecycle,
      mode: 'full',
      get state() {
        return session.state;
      },
      picture: Object.freeze({
        get status() {
          return picture.status;
        },
        get cursor() {
          return picture.cursor;
        },
        changedSince: (cursor: string, limit?: number) => picture.changedSince(cursor, limit),
        subscribe: (cursor?: string) => picture.subscribe(cursor),
        retry: (limits?: ClientOptions['picture']) => picture.retry(limits),
      }),
      assets: Object.freeze({ ...http.assets, ...picture.reads.assets }),
      tracks: Object.freeze({ ...http.tracks, ...picture.reads.tracks }),
      geofeatures: Object.freeze({ ...http.geofeatures, ...picture.reads.geofeatures }),
      tasks: Object.freeze({ ...http.tasks, ...picture.reads.tasks }),
      objects: Object.freeze({ ...http.objects, ...picture.reads.objects }),
    });
  return Object.freeze({
    ...http,
    ...lifecycle,
    mode: 'http',
    get state() {
      return session.state;
    },
  });
}
