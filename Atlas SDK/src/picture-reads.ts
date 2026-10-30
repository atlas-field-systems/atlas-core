import { exchanges, selection } from '@atlas/protocol';
import type {
  Asset,
  Track,
  Geofeature,
  Task,
  ObjectImage,
  RequestOf,
  ResponseOf,
  ExchangeName,
} from '@atlas/protocol';
import type { z } from 'zod';
import type { Session } from './connection.js';
import type { JsonBinding, JsonReply } from './http.js';
import { submission } from './http.js';
import { SdkError } from './contracts.js';
import type { PictureData } from './picture-data.js';
import type { PictureLocal } from './picture-local.js';
import type { FrozenQuery, PictureRefusal } from './picture-local.js';
import type { PictureRead } from './contracts.js';

type Read<K extends ExchangeName, T> = (request: RequestOf<K>) => PictureRead<T | null>;
type Query<K extends ExchangeName, T> = (
  request: Exclude<RequestOf<K>, { page_token: string }>,
) => PictureRead<FrozenQuery<T>> | PictureRefusal;
type Resource<T, G extends ExchangeName, L extends ExchangeName> = Readonly<{
  get: Read<G, T>;
  list: Query<L, T>;
  query: Query<L, T>;
}>;
export type PictureResources = Readonly<{
  assets: Resource<Asset, 'GetAsset', 'ListAssets'> &
    Readonly<{
      byAlias: Read<'GetAssetByAlias', Asset>;
      status: Read<
        'GetAssetStatus',
        Extract<ResponseOf<'GetAssetStatus'>, { kind: 'success' }>['body']['data']
      >;
      objects: Query<'GetAssetObjects', ObjectImage>;
    }>;
  tracks: Resource<Track, 'GetTrack', 'ListTracks'> &
    Readonly<{
      byAlias: Read<'GetTrackByAlias', Track>;
      objects: Query<'GetTrackObjects', ObjectImage>;
    }>;
  geofeatures: Resource<Geofeature, 'GetGeofeature', 'ListGeofeatures'> &
    Readonly<{
      byAlias: Read<'GetGeofeatureByAlias', Geofeature>;
      objects: Query<'GetGeofeatureObjects', ObjectImage>;
    }>;
  tasks: Resource<Task, 'GetTask', 'ListTasks'> &
    Readonly<{ objects: Query<'GetTaskObjects', ObjectImage> }>;
  objects: Resource<ObjectImage, 'GetObject', 'ListObjects'>;
}>;

export function pictureReads(local: PictureLocal, session: Session): PictureResources {
  function get<R extends z.ZodType, S extends z.ZodType<JsonReply>, T>(
    binding: JsonBinding<R, S>,
    select: (data: PictureData, facts: z.output<R>) => T,
  ) {
    return (request: z.output<R>) => {
      const { facts } = submission(binding, request, session.requestBudget);
      return local.read((data) => select(data, facts));
    };
  }
  function query<
    R extends z.ZodType<{ page_size?: number } | { page_token: string }>,
    S extends z.ZodType<JsonReply>,
    T,
  >(
    binding: JsonBinding<R, S>,
    select: (data: PictureData) => ReadonlyMap<string, T>,
    matches: (facts: z.output<R>, image: T, data: PictureData) => boolean,
  ) {
    return (request: Exclude<z.output<R>, { page_token: string }>) => {
      const input = local.queryInput(() => submission(binding, request, session.requestBudget));
      if ('kind' in input) return input;
      const { facts } = input;
      if ('page_token' in facts) throw new SdkError('invalid_value');
      if (!local.data)
        return local.read(() => {
          throw new SdkError('not_connected');
        });
      const data = local.data;
      return local.query(
        select(data),
        (image) => matches(facts, image, data),
        facts.page_size ?? 100,
      );
    };
  }
  const assets = query(
    exchanges.ListAssets,
    (data) => data.assets,
    (q, image) => !('page_token' in q) && selection.asset(q.filters, image),
  );
  const tracks = query(
    exchanges.ListTracks,
    (data) => data.tracks,
    (q, image) => !('page_token' in q) && selection.track(q.filters, image),
  );
  const geofeatures = query(
    exchanges.ListGeofeatures,
    (data) => data.geofeatures,
    (q, image) => !('page_token' in q) && selection.geofeature(q.filters, image),
  );
  const tasks = query(
    exchanges.ListTasks,
    (data) => data.tasks,
    (q, image) => !('page_token' in q) && selection.task(q.filters, image),
  );
  const objects = query(
    exchanges.ListObjects,
    (data) => data.objects,
    (q, image) => !('page_token' in q) && selection.object(q.filters, image),
  );
  return Object.freeze({
    assets: Object.freeze({
      get: get(exchanges.GetAsset, (data, q) => data.assets.get(q.asset_id) ?? null),
      byAlias: get(exchanges.GetAssetByAlias, (data, q) => {
        for (const image of data.assets.values())
          if (selection.asset({ aliases: [q.alias] }, image)) return image;
        return null;
      }),
      status: get(exchanges.GetAssetStatus, (data, q) => {
        const asset = data.assets.get(q.asset_id);
        return asset
          ? Object.freeze({
              asset_id: asset.id,
              status: asset.status,
              communications: asset.communications,
              heartbeat: asset.heartbeat,
            })
          : null;
      }),
      list: assets,
      query: assets,
      objects: query(
        exchanges.GetAssetObjects,
        (data) => data.objects,
        (q, image) =>
          !('page_token' in q) &&
          image.metadata.associations.some((a) => a.kind === 'asset' && a.id === q.asset_id),
      ),
    }),
    tracks: Object.freeze({
      get: get(exchanges.GetTrack, (data, q) => data.tracks.get(q.track_id) ?? null),
      byAlias: get(exchanges.GetTrackByAlias, (data, q) => {
        for (const image of data.tracks.values())
          if (selection.track({ aliases: [q.alias] }, image)) return image;
        return null;
      }),
      list: tracks,
      query: tracks,
      objects: query(
        exchanges.GetTrackObjects,
        (data) => data.objects,
        (q, image) =>
          !('page_token' in q) &&
          image.metadata.associations.some((a) => a.kind === 'track' && a.id === q.track_id),
      ),
    }),
    geofeatures: Object.freeze({
      get: get(exchanges.GetGeofeature, (data, q) => data.geofeatures.get(q.geofeature_id) ?? null),
      byAlias: get(exchanges.GetGeofeatureByAlias, (data, q) => {
        for (const image of data.geofeatures.values())
          if (selection.geofeature({ aliases: [q.alias] }, image)) return image;
        return null;
      }),
      list: geofeatures,
      query: geofeatures,
      objects: query(
        exchanges.GetGeofeatureObjects,
        (data) => data.objects,
        (q, image) =>
          !('page_token' in q) &&
          image.metadata.associations.some(
            (a) => a.kind === 'geofeature' && a.id === q.geofeature_id,
          ),
      ),
    }),
    tasks: Object.freeze({
      get: get(exchanges.GetTask, (data, q) => data.tasks.get(q.task_id) ?? null),
      list: tasks,
      query: tasks,
      objects: query(
        exchanges.GetTaskObjects,
        (data) => data.objects,
        (q, image, data) =>
          !('page_token' in q) &&
          (image.metadata.associations.some((a) => a.kind === 'task' && a.id === q.task_id) ||
            data.tasks
              .get(q.task_id)
              ?.result_declarations.some((d) => d.object_id === image.object_id) === true),
      ),
    }),
    objects: Object.freeze({
      get: get(exchanges.GetObject, (data, q) => data.objects.get(q.object_id) ?? null),
      list: objects,
      query: objects,
    }),
  });
}
