import { z } from 'zod';
import { Alias, Counter, text, Uuid, unique } from './scalars.js';
import {
  AssetDescription,
  AssetType,
  Description,
  GeofeatureType,
  Health,
  Heartbeat,
} from './components.js';
import { Capabilities } from './commands.js';
import { Geometry } from './geometry.js';
import { Origin, readSections, SectionEvidence } from './reports.js';
import { TaskControl, TaskQueue } from './tasks.js';

const fields = {
  dataset_id: Uuid,
  id: Uuid,
  version: Counter,
  edit_revision: Counter,
  alias: Alias.exactOptional(),
};
export const PublisherSubject = z
  .strictObject({ id: text(128, true), lifetime_id: Uuid })
  .meta({ id: 'PublisherSubject' });
export const Communications = z
  .strictObject({ health: Health, capacity: readSections.communications })
  .meta({ id: 'Communications' });
const commonReported = {
  telemetry: readSections.telemetry.exactOptional(),
  attitude: readSections.attitude.exactOptional(),
};
type Evidence = z.output<typeof SectionEvidence>;
type ReadingOrigin = z.output<typeof Origin>;
export function reportSequencesMatch(evidence: readonly (Evidence | null | undefined)[]): boolean {
  const sequences = new Map<string, Evidence['sequence']>();
  for (const item of evidence) {
    if (!item) continue;
    const scope = [
      item.dataset_id,
      item.entity_id,
      item.origin.kind,
      item.origin.kind === 'asset_process'
        ? item.origin.process_generation
        : item.origin.publisher_id,
      item.report_id,
    ].join(':');
    const prior = sequences.get(scope);
    if (prior !== undefined && prior !== item.sequence) return false;
    sequences.set(scope, item.sequence);
  }
  return true;
}
export function assetEvidenceMatches(
  evidence: Evidence | null | undefined,
  entityId: string,
  datasetId?: string,
): boolean {
  return (
    !evidence ||
    (evidence.entity_id === entityId &&
      evidence.origin.kind === 'asset_process' &&
      (datasetId === undefined || evidence.dataset_id === datasetId))
  );
}
function readingOrigins(
  value: z.output<typeof readSections.telemetry> | undefined,
): ReadingOrigin[] {
  return value?.state === 'value'
    ? Object.values(value.constituents)
        .filter((item) => item !== undefined)
        .map((item) => item.origin)
    : [];
}
const AssetDefinition = z
  .strictObject({
    ...fields,
    entity_type: z.literal('asset'),
    description: AssetDescription.exactOptional(),
    type: AssetType,
    capabilities: Capabilities,
    process_generation: Uuid,
    tags: readSections.tags.exactOptional(),
    status: readSections.status,
    communications: Communications,
    heartbeat: Heartbeat,
    task_queue: TaskQueue,
    task_control: TaskControl,
    ...commonReported,
    power: readSections.power.exactOptional(),
    camera: readSections.camera.exactOptional(),
    camera_optics: readSections.camera_optics.exactOptional(),
    gimbal: readSections.gimbal.exactOptional(),
  })
  .refine((value) => {
    const sections = [
      value.tags,
      value.status,
      value.communications.capacity,
      value.telemetry,
      value.attitude,
      value.power,
      value.camera,
      value.camera_optics,
      value.gimbal,
    ];
    return (
      reportSequencesMatch(sections.map((section) => section?.evidence)) &&
      sections.every((section) =>
        assetEvidenceMatches(section?.evidence, value.id, value.dataset_id),
      ) &&
      readingOrigins(value.telemetry).every((origin) => origin.kind === 'asset_process')
    );
  }, 'Asset evidence scope differs')
  .meta({ id: 'Asset' });
const ObservationDefinition = z
  .strictObject({
    ...fields,
    entity_type: z.literal('observation'),
    description: Description.exactOptional(),
    publisher_id: Uuid,
    track_id: Uuid,
    source_asset_id: Uuid,
    publisher_subject: PublisherSubject.exactOptional(),
    type: readSections.type,
    ...commonReported,
    geometry: readSections.geometry.exactOptional(),
  })
  .refine(
    (value) =>
      value.id !== value.track_id &&
      value.source_asset_id !== value.id &&
      value.source_asset_id !== value.track_id,
    'Observation Entity identities overlap',
  )
  .refine((value) => {
    const sections = [value.type, value.telemetry, value.attitude, value.geometry];
    return (
      reportSequencesMatch(sections.map((section) => section?.evidence)) &&
      sections.every(
        (section) =>
          !section?.evidence ||
          (section.evidence.dataset_id === value.dataset_id &&
            section.evidence.entity_id === value.id &&
            section.evidence.origin.kind === 'publisher' &&
            section.evidence.origin.publisher_id === value.publisher_id),
      ) &&
      readingOrigins(value.telemetry).every(
        (origin) => origin.kind === 'publisher' && origin.publisher_id === value.publisher_id,
      )
    );
  }, 'Observation evidence scope differs')
  .meta({ id: 'Observation' });
export const TrackSource = z
  .strictObject({ observation_id: Uuid, publisher_id: Uuid, source_asset_id: Uuid })
  .meta({ id: 'TrackSource' });
const TrackDefinition = z
  .strictObject({
    ...fields,
    entity_type: z.literal('track'),
    description: Description.exactOptional(),
    sources: z
      .array(TrackSource)
      .length(1)
      .refine((values) => unique(values, (value) => value.observation_id), 'Duplicate source'),
    type: readSections.type,
    ...commonReported,
    geometry: readSections.geometry.exactOptional(),
  })
  .refine(
    (value) =>
      value.sources.every(
        (source) =>
          source.observation_id !== value.id &&
          source.source_asset_id !== value.id &&
          source.source_asset_id !== source.observation_id,
      ),
    'Track Entity identities overlap',
  )
  .refine((value) => {
    const matches = (evidence: Evidence) =>
      evidence.dataset_id === value.dataset_id &&
      evidence.origin.kind === 'publisher' &&
      value.sources.some(
        (source) =>
          source.observation_id === evidence.entity_id &&
          evidence.origin.kind === 'publisher' &&
          source.publisher_id === evidence.origin.publisher_id,
      );
    const sections = [value.type, value.telemetry, value.attitude, value.geometry];
    return (
      reportSequencesMatch(sections.map((section) => section?.evidence)) &&
      sections.every((section) => !section?.evidence || matches(section.evidence)) &&
      readingOrigins(value.telemetry).every(
        (origin) =>
          origin.kind === 'publisher' &&
          value.sources.some(
            (source) => origin.kind === 'publisher' && source.publisher_id === origin.publisher_id,
          ),
      )
    );
  }, 'Track evidence scope differs')
  .meta({ id: 'Track' });
const GeofeatureDefinition = z
  .strictObject({
    ...fields,
    entity_type: z.literal('geofeature'),
    description: Description.exactOptional(),
    type: GeofeatureType,
    geometry: Geometry,
    geometry_revision: Counter,
  })
  .meta({ id: 'Geofeature' });
export type Asset = z.output<typeof AssetDefinition>;
type AssetDefinitionSchema = typeof AssetDefinition;
export interface AssetSchema extends AssetDefinitionSchema {}
export const Asset: AssetSchema = AssetDefinition;
export type Observation = z.output<typeof ObservationDefinition>;
type ObservationDefinitionSchema = typeof ObservationDefinition;
export interface ObservationSchema extends ObservationDefinitionSchema {}
export const Observation: ObservationSchema = ObservationDefinition;
export type Track = z.output<typeof TrackDefinition>;
type TrackDefinitionSchema = typeof TrackDefinition;
export interface TrackSchema extends TrackDefinitionSchema {}
export const Track: TrackSchema = TrackDefinition;
export type Geofeature = z.output<typeof GeofeatureDefinition>;
type GeofeatureDefinitionSchema = typeof GeofeatureDefinition;
export interface GeofeatureSchema extends GeofeatureDefinitionSchema {}
export const Geofeature: GeofeatureSchema = GeofeatureDefinition;
export type PublisherSubject = z.output<typeof PublisherSubject>;
export type Communications = z.output<typeof Communications>;
export type TrackSource = z.output<typeof TrackSource>;
