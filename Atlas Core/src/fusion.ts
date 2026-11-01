import type { Observation, Track } from '@atlas/protocol';

type FusionObservation = Readonly<
  Pick<
    Observation,
    'id' | 'publisher_id' | 'source_asset_id' | 'type' | 'telemetry' | 'attitude' | 'geometry'
  >
>;
type DerivedTrack = Pick<Track, 'sources' | 'type' | 'telemetry' | 'attitude' | 'geometry'>;

export function fuseOneToOne(observation: FusionObservation): DerivedTrack {
  return {
    sources: [
      {
        observation_id: observation.id,
        publisher_id: observation.publisher_id,
        ...(observation.source_asset_id === undefined
          ? {}
          : { source_asset_id: observation.source_asset_id }),
      },
    ],
    type: observation.type,
    ...(observation.telemetry === undefined ? {} : { telemetry: observation.telemetry }),
    ...(observation.attitude === undefined ? {} : { attitude: observation.attitude }),
    ...(observation.geometry === undefined ? {} : { geometry: observation.geometry }),
  };
}
