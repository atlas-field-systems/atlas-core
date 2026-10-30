import { z } from 'zod';
import {
  Asset,
  AssetReport,
  Observation,
  ObservationReport,
  Uuid,
  exchanges,
} from '@atlas/protocol';
import type { RequestOf, ResponseOf } from '@atlas/protocol';
import type { Session } from './connection.js';
import type { Prepared, RequestOptions, WaitResult } from './contracts.js';
import { SdkError } from './contracts.js';
import { component } from './components.js';
import { freeze } from './http.js';
import { policies } from './policy.js';
import type { Operations } from './prepared.js';

type ReadingOf<T> = T extends unknown ? Omit<T, 'dataset_id' | 'entity_id' | 'origin'> : never;
export type AssetReading = ReadingOf<AssetReport>;
export type ObservationReading = ReadingOf<ObservationReport>;
export type AssetChanges = Omit<RequestOf<'UpdateAsset'>, 'asset_id' | 'report'>;
type Write<K extends 'UpdateAsset' | 'ReportObservation' | 'RegisterAsset' | 'CreateObservation'> =
  Prepared<RequestOf<K>, ResponseOf<K>>;
export type AssetReporter = Readonly<{
  identity: Pick<Asset, 'id' | 'process_generation'>;
  update: (changes: AssetChanges, reading?: AssetReading) => Write<'UpdateAsset'>;
}>;
export type ObservationReporter = Readonly<{
  identity: Pick<RequestOf<'ReportObservation'>, 'observation_id' | 'publisher_id'> & {
    dataset_id: Uuid;
  };
  report: (reading: ObservationReading) => Write<'ReportObservation'>;
  reconcile: (options?: RequestOptions) => Promise<WaitResult<ResponseOf<'GetObservation'>>>;
  recordedTrack: (options?: RequestOptions) => Promise<WaitResult<ResponseOf<'GetTrack'>>>;
}>;
export type Reporting = Readonly<{
  asset: (identity: Pick<Asset, 'id' | 'process_generation'>) => AssetReporter;
  observation: (identity: Pick<Observation, 'id' | 'publisher_id'>) => ObservationReporter;
  register: (
    input: RequestOf<'RegisterAsset'>,
  ) => Readonly<{ registration: Write<'RegisterAsset'>; reporter: AssetReporter }>;
  createObservation: (
    input: RequestOf<'CreateObservation'>,
  ) => Readonly<{ creation: Write<'CreateObservation'>; reporter: ObservationReporter }>;
}>;

// Derive caller fragments from Protocol, then validate the completed request there too.
const {
  dataset_id: _ad,
  entity_id: _ae,
  origin: _ao,
  ...assetCurrentFields
} = AssetReport.options[0].shape;
const {
  dataset_id: _hd,
  entity_id: _he,
  origin: _ho,
  ...assetHistoryFields
} = AssetReport.options[1].shape;
const assetReading: z.ZodType<AssetReading> = z.discriminatedUnion('mode', [
  z.strictObject(assetCurrentFields),
  z.strictObject(assetHistoryFields),
]);
const {
  dataset_id: _od,
  entity_id: _oe,
  origin: _oo,
  ...observationFields
} = ObservationReport.shape;
const observationReading: z.ZodType<ObservationReading> = z.strictObject(observationFields);
const {
  asset_id: _asset,
  report: _report,
  ...changeFields
} = exchanges.UpdateAsset.request.schema.shape;
const assetChanges = z.strictObject(changeFields);
const assetIdentity = z.strictObject({
  id: Asset.shape.id,
  process_generation: Asset.shape.process_generation,
});
const observationIdentity = z.strictObject({
  id: Observation.shape.id,
  publisher_id: Observation.shape.publisher_id,
});

/** Reporting retains source identities and uses the client's shared effect cells. */
export function createReporting(session: Session, operations: Operations): Reporting {
  const register = operations.bind(exchanges.RegisterAsset, policies.RegisterAsset);
  const update = operations.bind(exchanges.UpdateAsset, policies.UpdateAsset);
  const create = operations.bind(exchanges.CreateObservation, policies.CreateObservation);
  const report = operations.bind(exchanges.ReportObservation, policies.ReportObservation);
  const getObservation = session.read(exchanges.GetObservation);
  const getTrack = session.read(exchanges.GetTrack);
  const originalDataset = () => {
    const id = session.datasetId;
    if (id === null) throw new SdkError('not_connected');
    return Uuid.parse(id);
  };
  function asset(identity: Pick<Asset, 'id' | 'process_generation'>): AssetReporter {
    const facts = component(assetIdentity, identity, session.requestBudget);
    const datasetId = originalDataset(),
      epoch = session.datasetEpoch;
    const current = () => {
      if (session.datasetId !== datasetId || session.datasetEpoch !== epoch)
        throw new SdkError('dataset_invalidated');
    };
    return Object.freeze({
      identity: facts,
      update(input: AssetChanges, reading?: AssetReading) {
        current();
        const changes = component(assetChanges, input, session.requestBudget);
        const submitted =
          reading === undefined
            ? undefined
            : component(assetReading, reading, session.requestBudget);
        return update({
          ...changes,
          asset_id: facts.id,
          ...(submitted === undefined
            ? {}
            : {
                report: component(
                  AssetReport,
                  {
                    ...submitted,
                    dataset_id: datasetId,
                    entity_id: facts.id,
                    origin: { kind: 'asset_process', process_generation: facts.process_generation },
                  },
                  session.requestBudget,
                ),
              }),
        });
      },
    });
  }
  function observation(identity: Pick<Observation, 'id' | 'publisher_id'>): ObservationReporter {
    const facts = component(observationIdentity, identity, session.requestBudget);
    const datasetId = originalDataset(),
      epoch = session.datasetEpoch;
    const current = () => session.datasetId === datasetId && session.datasetEpoch === epoch;
    return Object.freeze({
      identity: freeze({
        observation_id: facts.id,
        publisher_id: facts.publisher_id,
        dataset_id: datasetId,
      }),
      report(input: ObservationReading) {
        if (!current()) throw new SdkError('dataset_invalidated');
        const reading = component(observationReading, input, session.requestBudget);
        return report({
          observation_id: facts.id,
          publisher_id: facts.publisher_id,
          report: component(
            ObservationReport,
            {
              ...reading,
              dataset_id: datasetId,
              entity_id: facts.id,
              origin: { kind: 'publisher', publisher_id: facts.publisher_id },
            },
            session.requestBudget,
          ),
        });
      },
      reconcile(options: RequestOptions = {}) {
        if (!current())
          return session.refuse<ResponseOf<'GetObservation'>>(
            'GetObservation',
            'dataset_invalidated',
          ).settled;
        return getObservation({ observation_id: facts.id }, options);
      },
      async recordedTrack(
        options: RequestOptions = {},
      ): Promise<WaitResult<ResponseOf<'GetTrack'>>> {
        if (!current())
          return session.refuse<ResponseOf<'GetTrack'>>('GetTrack', 'dataset_invalidated').settled;
        const result = await getObservation({ observation_id: facts.id }, options);
        if (result.kind !== 'response') return result;
        if (result.response.kind === 'error') return { ...result, response: result.response };
        if (!current())
          return session.refuse<ResponseOf<'GetTrack'>>('GetTrack', 'dataset_invalidated').settled;
        if (options.signal?.aborted)
          return session.refuse<ResponseOf<'GetTrack'>>('GetTrack', 'cancelled').settled;
        return getTrack({ track_id: result.response.body.data.track_id }, options);
      },
    });
  }
  return Object.freeze({
    asset,
    observation,
    register(input: RequestOf<'RegisterAsset'>) {
      const registration = register(input);
      const facts = registration.submission.facts;
      return Object.freeze({
        registration,
        reporter: asset({ id: facts.asset_id, process_generation: facts.process_generation }),
      });
    },
    createObservation(input: RequestOf<'CreateObservation'>) {
      const creation = create(input);
      const facts = creation.submission.facts;
      return Object.freeze({
        creation,
        reporter: observation({ id: facts.observation_id, publisher_id: facts.publisher_id }),
      });
    },
  });
}
