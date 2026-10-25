import { z } from 'zod';
import { NewId, Sequence, text, Time, Uuid } from './scalars.js';
import {
  Attitude,
  Camera,
  CameraOptics,
  Capacity,
  Gimbal,
  Power,
  PowerTimes,
  Status,
  SubjectType,
  Telemetry,
} from './components.js';
import { Geometry } from './geometry.js';

const AssetOriginDefinition = z
  .strictObject({ kind: z.literal('asset_process'), process_generation: Uuid })
  .meta({ id: 'AssetOrigin' });
type AssetOriginDefinitionSchema = typeof AssetOriginDefinition;
export interface AssetOriginSchema extends AssetOriginDefinitionSchema {}
export const AssetOrigin: AssetOriginSchema = AssetOriginDefinition;
const PublisherOriginDefinition = z
  .strictObject({ kind: z.literal('publisher'), publisher_id: Uuid })
  .meta({ id: 'PublisherOrigin' });
type PublisherOriginDefinitionSchema = typeof PublisherOriginDefinition;
export interface PublisherOriginSchema extends PublisherOriginDefinitionSchema {}
export const PublisherOrigin: PublisherOriginSchema = PublisherOriginDefinition;
const OriginDefinition = z
  .discriminatedUnion('kind', [AssetOrigin, PublisherOrigin])
  .meta({ id: 'Origin' });
type OriginDefinitionSchema = typeof OriginDefinition;
export interface OriginSchema extends OriginDefinitionSchema {}
export const Origin: OriginSchema = OriginDefinition;
const ConstituentDefinition = z
  .strictObject({ origin: Origin, reading_id: NewId })
  .meta({ id: 'Constituent' });
type ConstituentDefinitionSchema = typeof ConstituentDefinition;
export interface ConstituentSchema extends ConstituentDefinitionSchema {}
export const Constituent: ConstituentSchema = ConstituentDefinition;
const ConstituentsDefinition = z
  .strictObject({
    position: Constituent,
    altitude: Constituent,
    ground_speed: Constituent,
    airspeed: Constituent.exactOptional(),
  })
  .meta({ id: 'Constituents' });
type ConstituentsDefinitionSchema = typeof ConstituentsDefinition;
export interface ConstituentsSchema extends ConstituentsDefinitionSchema {}
export const Constituents: ConstituentsSchema = ConstituentsDefinition;
export const SectionName = z.enum([
  'status',
  'communications',
  'telemetry',
  'attitude',
  'power',
  'camera',
  'camera_optics',
  'gimbal',
  'type',
  'geometry',
]);
const evidenceFields = {
  dataset_id: Uuid,
  entity_id: Uuid,
  origin: Origin,
  report_id: NewId,
  sequence: Sequence,
};
export const SectionEvidence = z
  .strictObject({ ...evidenceFields, section: SectionName })
  .meta({ id: 'SectionEvidence' });
const metadata = {
  classification: z.enum(['state_until_changed', 'dated_measurement']),
  observed_at: Time,
};
const SectionErrorDefinition = z
  .strictObject({ code: text(128, true), message: text(512).exactOptional() })
  .meta({ id: 'SectionError' });
type SectionErrorDefinitionSchema = typeof SectionErrorDefinition;
export interface SectionErrorSchema extends SectionErrorDefinitionSchema {}
export const SectionError: SectionErrorSchema = SectionErrorDefinition;

function applicable(value: unknown, times: unknown): boolean {
  if (!value || typeof value !== 'object' || !times || typeof times !== 'object') return true;
  return Object.keys(times).every((key) => key === 'geometry' || Object.hasOwn(value, key));
}
const errorFields = { state: z.literal('error'), ...metadata, error: SectionError };
const withdrawnFields = { state: z.literal('withdrawn'), ...metadata };
function valueResult<V extends z.ZodType, T extends z.ZodType>(value: V, times: T) {
  return z
    .strictObject({
      state: z.literal('value'),
      ...metadata,
      value,
      source_times: times.exactOptional(),
    })
    .refine(
      (result) => 'value' in result && applicable(result.value, result.source_times),
      'Inapplicable source time',
    );
}
function result<V extends z.ZodType, T extends z.ZodType>(value: V, times: T) {
  return z.discriminatedUnion('state', [
    valueResult(value, times),
    z.strictObject(errorFields),
    z.strictObject(withdrawnFields),
  ]);
}
function readResult<
  const K extends z.output<typeof SectionName>,
  V extends z.ZodType,
  T extends z.ZodType,
>(section: K, value: V, times: T, initial?: z.ZodType) {
  const evidence = SectionEvidence.extend({ section: z.literal(section) });
  return z.discriminatedUnion('state', [
    valueResult(value, times)
      .safeExtend({ evidence: evidence.nullable() })
      .refine(
        (result) =>
          result.evidence !== null ||
          (initial !== undefined &&
            'value' in result &&
            initial.safeParse(result.value).success &&
            result.classification === 'state_until_changed' &&
            result.observed_at === null &&
            result.source_times === undefined),
        'Invalid source-free value',
      ),
    z.strictObject({ ...errorFields, evidence }),
    z.strictObject({ ...withdrawnFields, evidence }),
  ]);
}
const statusTimes = z.strictObject({ condition: Time.exactOptional() });
const capacityTimes = z.strictObject({ bandwidth_bps: Time.exactOptional() });
const telemetryTimes = z.strictObject({
  position: Time.exactOptional(),
  altitude: Time.exactOptional(),
  ground_speed: Time.exactOptional(),
  airspeed: Time.exactOptional(),
});
const attitudeTimes = z.strictObject({
  heading: Time.exactOptional(),
  pitch: Time.exactOptional(),
  roll: Time.exactOptional(),
});
const gimbalTimes = z.strictObject({
  bearing: Time.exactOptional(),
  elevation: Time.exactOptional(),
});
const cameraTimes = z.strictObject({
  zoom_ratio: Time.exactOptional(),
  recording: Time.exactOptional(),
  capturing: Time.exactOptional(),
});
const opticsTimes = z.strictObject({
  horizontal_fov: Time.exactOptional(),
  vertical_fov: Time.exactOptional(),
});
const typeTimes = z.strictObject({ kind: Time.exactOptional() });
const geometryTimes = z.strictObject({ geometry: Time.exactOptional() });

function powerTimesValid(result: {
  state: string;
  value?: z.output<typeof Power>;
  source_times?: z.output<typeof PowerTimes> | undefined;
}): boolean {
  if (result.state !== 'value' || !result.value || !result.source_times?.reserves) return true;
  return Object.entries(result.source_times.reserves).every(([id, times]) => {
    const reserve = result.value?.reserves.find((value) => value.id === id);
    return (
      reserve !== undefined &&
      (reserve.kind === 'battery' ||
        (!Object.hasOwn(times, 'voltage_volts') && !Object.hasOwn(times, 'current_amperes')))
    );
  });
}
function telemetryKeys(result: {
  state: string;
  value?: z.output<typeof Telemetry>;
  constituents?: z.output<typeof Constituents>;
}): boolean {
  return (
    result.state !== 'value' ||
    (result.value !== undefined &&
      result.constituents !== undefined &&
      Object.hasOwn(result.value, 'airspeed') === Object.hasOwn(result.constituents, 'airspeed'))
  );
}
const inputSectionsDefinition = {
  status: result(Status, statusTimes).meta({ id: 'StatusInput' }),
  communications: result(Capacity, capacityTimes).meta({ id: 'CapacityInput' }),
  telemetry: z
    .discriminatedUnion('state', [
      valueResult(Telemetry, telemetryTimes).safeExtend({ constituents: Constituents }),
      z.strictObject(errorFields),
      z.strictObject(withdrawnFields),
    ])
    .refine(telemetryKeys, 'Constituent keys differ')
    .meta({ id: 'TelemetryInput' }),
  attitude: result(Attitude, attitudeTimes).meta({ id: 'AttitudeInput' }),
  power: result(Power, PowerTimes)
    .refine(powerTimesValid, 'Invalid reserve times')
    .meta({ id: 'PowerInput' }),
  camera: result(Camera, cameraTimes).meta({ id: 'CameraInput' }),
  camera_optics: result(CameraOptics, opticsTimes).meta({ id: 'CameraOpticsInput' }),
  gimbal: result(Gimbal, gimbalTimes).meta({ id: 'GimbalInput' }),
  type: result(SubjectType, typeTimes).meta({ id: 'SubjectTypeInput' }),
  geometry: result(Geometry, geometryTimes).meta({ id: 'GeometryInput' }),
};
type StatusInputDefinitionSchema = typeof inputSectionsDefinition.status;
export interface StatusInputSchema extends StatusInputDefinitionSchema {}
type CapacityInputDefinitionSchema = typeof inputSectionsDefinition.communications;
export interface CapacityInputSchema extends CapacityInputDefinitionSchema {}
type TelemetryInputDefinitionSchema = typeof inputSectionsDefinition.telemetry;
export interface TelemetryInputSchema extends TelemetryInputDefinitionSchema {}
type AttitudeInputDefinitionSchema = typeof inputSectionsDefinition.attitude;
export interface AttitudeInputSchema extends AttitudeInputDefinitionSchema {}
type PowerInputDefinitionSchema = typeof inputSectionsDefinition.power;
export interface PowerInputSchema extends PowerInputDefinitionSchema {}
type CameraInputDefinitionSchema = typeof inputSectionsDefinition.camera;
export interface CameraInputSchema extends CameraInputDefinitionSchema {}
type CameraOpticsInputDefinitionSchema = typeof inputSectionsDefinition.camera_optics;
export interface CameraOpticsInputSchema extends CameraOpticsInputDefinitionSchema {}
type GimbalInputDefinitionSchema = typeof inputSectionsDefinition.gimbal;
export interface GimbalInputSchema extends GimbalInputDefinitionSchema {}
type SubjectTypeInputDefinitionSchema = typeof inputSectionsDefinition.type;
export interface SubjectTypeInputSchema extends SubjectTypeInputDefinitionSchema {}
type GeometryInputDefinitionSchema = typeof inputSectionsDefinition.geometry;
export interface GeometryInputSchema extends GeometryInputDefinitionSchema {}
export const inputSections: {
  status: StatusInputSchema;
  communications: CapacityInputSchema;
  telemetry: TelemetryInputSchema;
  attitude: AttitudeInputSchema;
  power: PowerInputSchema;
  camera: CameraInputSchema;
  camera_optics: CameraOpticsInputSchema;
  gimbal: GimbalInputSchema;
  type: SubjectTypeInputSchema;
  geometry: GeometryInputSchema;
} = inputSectionsDefinition;
const readSectionsDefinition = {
  status: readResult(
    'status',
    Status,
    statusTimes,
    Status.refine((value) => value.condition === 'unknown' && value.explanation === undefined),
  ).meta({ id: 'StatusRead' }),
  communications: readResult(
    'communications',
    Capacity,
    capacityTimes,
    Capacity.refine((value) => value.bandwidth_bps === null),
  ).meta({ id: 'CapacityRead' }),
  telemetry: z
    .discriminatedUnion('state', [
      valueResult(Telemetry, telemetryTimes).safeExtend({
        constituents: Constituents,
        evidence: SectionEvidence.extend({ section: z.literal('telemetry') }),
      }),
      z.strictObject({
        ...errorFields,
        evidence: SectionEvidence.extend({ section: z.literal('telemetry') }),
      }),
      z.strictObject({
        ...withdrawnFields,
        evidence: SectionEvidence.extend({ section: z.literal('telemetry') }),
      }),
    ])
    .refine(telemetryKeys, 'Constituent keys differ')
    .meta({ id: 'TelemetryRead' }),
  attitude: readResult('attitude', Attitude, attitudeTimes).meta({ id: 'AttitudeRead' }),
  power: readResult('power', Power, PowerTimes)
    .refine(powerTimesValid, 'Invalid reserve times')
    .meta({ id: 'PowerRead' }),
  camera: readResult('camera', Camera, cameraTimes).meta({ id: 'CameraRead' }),
  camera_optics: readResult('camera_optics', CameraOptics, opticsTimes).meta({
    id: 'CameraOpticsRead',
  }),
  gimbal: readResult('gimbal', Gimbal, gimbalTimes).meta({ id: 'GimbalRead' }),
  type: readResult(
    'type',
    SubjectType,
    typeTimes,
    SubjectType.refine((value) => value.kind === null),
  ).meta({ id: 'SubjectTypeRead' }),
  geometry: readResult('geometry', Geometry, geometryTimes).meta({ id: 'GeometryRead' }),
};
type StatusReadDefinitionSchema = typeof readSectionsDefinition.status;
export interface StatusReadSchema extends StatusReadDefinitionSchema {}
type CapacityReadDefinitionSchema = typeof readSectionsDefinition.communications;
export interface CapacityReadSchema extends CapacityReadDefinitionSchema {}
type TelemetryReadDefinitionSchema = typeof readSectionsDefinition.telemetry;
export interface TelemetryReadSchema extends TelemetryReadDefinitionSchema {}
type AttitudeReadDefinitionSchema = typeof readSectionsDefinition.attitude;
export interface AttitudeReadSchema extends AttitudeReadDefinitionSchema {}
type PowerReadDefinitionSchema = typeof readSectionsDefinition.power;
export interface PowerReadSchema extends PowerReadDefinitionSchema {}
type CameraReadDefinitionSchema = typeof readSectionsDefinition.camera;
export interface CameraReadSchema extends CameraReadDefinitionSchema {}
type CameraOpticsReadDefinitionSchema = typeof readSectionsDefinition.camera_optics;
export interface CameraOpticsReadSchema extends CameraOpticsReadDefinitionSchema {}
type GimbalReadDefinitionSchema = typeof readSectionsDefinition.gimbal;
export interface GimbalReadSchema extends GimbalReadDefinitionSchema {}
type SubjectTypeReadDefinitionSchema = typeof readSectionsDefinition.type;
export interface SubjectTypeReadSchema extends SubjectTypeReadDefinitionSchema {}
type GeometryReadDefinitionSchema = typeof readSectionsDefinition.geometry;
export interface GeometryReadSchema extends GeometryReadDefinitionSchema {}
export const readSections: {
  status: StatusReadSchema;
  communications: CapacityReadSchema;
  telemetry: TelemetryReadSchema;
  attitude: AttitudeReadSchema;
  power: PowerReadSchema;
  camera: CameraReadSchema;
  camera_optics: CameraOpticsReadSchema;
  gimbal: GimbalReadSchema;
  type: SubjectTypeReadSchema;
  geometry: GeometryReadSchema;
} = readSectionsDefinition;
const assetSections = z.strictObject({
  status: inputSections.status.exactOptional(),
  communications: inputSections.communications.exactOptional(),
  telemetry: inputSections.telemetry.exactOptional(),
  attitude: inputSections.attitude.exactOptional(),
  power: inputSections.power.exactOptional(),
  camera: inputSections.camera.exactOptional(),
  camera_optics: inputSections.camera_optics.exactOptional(),
  gimbal: inputSections.gimbal.exactOptional(),
});
const observationSections = z.strictObject({
  type: inputSections.type.exactOptional(),
  telemetry: inputSections.telemetry.exactOptional(),
  attitude: inputSections.attitude.exactOptional(),
  geometry: inputSections.geometry.exactOptional(),
});
const reportFields = {
  dataset_id: Uuid,
  entity_id: Uuid,
  report_id: NewId,
  sequence: Sequence,
  generated_at: Time,
};
const proof = z.strictObject({ challenge_id: Uuid });
const AssetReportDefinition = z
  .discriminatedUnion('mode', [
    z
      .strictObject({
        ...reportFields,
        origin: AssetOrigin,
        mode: z.literal('current'),
        sections: assetSections,
        contact_proof: proof.exactOptional(),
      })
      .refine(
        (value) => Object.keys(value.sections).length > 0 || value.contact_proof !== undefined,
        'Empty report',
      )
      .refine(
        (value) => value.contact_proof === undefined || value.generated_at !== null,
        'Contact proof needs generation time',
      ),
    z.strictObject({
      ...reportFields,
      origin: AssetOrigin,
      mode: z.literal('history_only'),
      sections: assetSections.refine((value) => Object.keys(value).length > 0, 'Empty report'),
    }),
  ])
  .refine((value) => {
    const telemetry = value.sections.telemetry;
    return (
      telemetry?.state !== 'value' ||
      Object.values(telemetry.constituents).every(
        (reading) => !reading || reading.origin.kind === 'asset_process',
      )
    );
  }, 'Asset origin differs')
  .meta({ id: 'AssetReport' });
const ObservationReportDefinition = z
  .strictObject({
    ...reportFields,
    origin: PublisherOrigin,
    mode: z.enum(['current', 'history_only']),
    sections: observationSections.refine((value) => Object.keys(value).length > 0, 'Empty report'),
  })
  .refine(
    (value) =>
      value.sections.telemetry?.state !== 'value' ||
      Object.values(value.sections.telemetry.constituents).every(
        (reading) =>
          !reading ||
          (reading.origin.kind === 'publisher' &&
            reading.origin.publisher_id === value.origin.publisher_id),
      ),
    'Publisher origin differs',
  )
  .meta({ id: 'ObservationReport' });
export const EvidenceDisposition = z.enum(['accepted', 'duplicate']);
export type AssetReport = z.output<typeof AssetReportDefinition>;
type AssetReportDefinitionSchema = typeof AssetReportDefinition;
export interface AssetReportSchema extends AssetReportDefinitionSchema {}
export const AssetReport: AssetReportSchema = AssetReportDefinition;
export type ObservationReport = z.output<typeof ObservationReportDefinition>;
type ObservationReportDefinitionSchema = typeof ObservationReportDefinition;
export interface ObservationReportSchema extends ObservationReportDefinitionSchema {}
export const ObservationReport: ObservationReportSchema = ObservationReportDefinition;
export type AssetOrigin = z.output<typeof AssetOrigin>;
export type PublisherOrigin = z.output<typeof PublisherOrigin>;
export type Origin = z.output<typeof Origin>;
export type Constituent = z.output<typeof Constituent>;
export type Constituents = z.output<typeof Constituents>;
export type SectionName = z.output<typeof SectionName>;
export type SectionEvidence = z.output<typeof SectionEvidence>;
export type SectionError = z.output<typeof SectionError>;
export type EvidenceDisposition = z.output<typeof EvidenceDisposition>;

export type InputSection<K extends keyof typeof inputSections> = z.output<
  (typeof inputSections)[K]
>;
export type ReadSection<K extends keyof typeof readSections> = z.output<(typeof readSections)[K]>;
