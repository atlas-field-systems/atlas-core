import { z } from 'zod';
import {
  Altitude,
  Float,
  numeric,
  Position,
  text,
  Time,
  Uuid,
  unique,
  uniqueArray,
} from './scalars.js';

export const Description = z
  .strictObject({ name: text(128, true), description: text(4096).exactOptional() })
  .meta({ id: 'Description' });
export const AssetDescription = z
  .strictObject({
    ...Description.shape,
    manufacturer: text(128, true).exactOptional(),
    model: text(128, true).exactOptional(),
  })
  .meta({ id: 'AssetDescription' });
export const AssetType = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('drone'),
      variant: z.enum(['powered_fixed_wing', 'fixed_wing_glider', 'quadcopter']).nullable(),
    }),
    z.strictObject({ kind: z.enum(['security_camera', 'tracker', 'other']).nullable() }),
  ])
  .meta({ id: 'AssetType' });
export const SubjectKind = z.enum(['person', 'ground_vehicle', 'aircraft', 'animal', 'other']);
export const SubjectType = z
  .strictObject({ kind: SubjectKind.nullable() })
  .meta({ id: 'SubjectType' });
export const GeofeatureKind = z.enum([
  'point_of_interest',
  'route',
  'search_area',
  'boundary',
  'other',
]);
export const GeofeatureType = z
  .strictObject({ kind: GeofeatureKind.nullable() })
  .meta({ id: 'GeofeatureType' });
export const Status = z
  .strictObject({
    condition: z.enum(['unknown', 'healthy', 'degraded', 'faulted']),
    explanation: text(512, true).exactOptional(),
  })
  .meta({ id: 'Status' });
export const Telemetry = z
  .strictObject({
    position: Position.nullable(),
    altitude: Altitude.nullable(),
    ground_speed: numeric({ min: 0 }).nullable(),
    airspeed: numeric({ min: 0 }).nullable().exactOptional(),
  })
  .meta({ id: 'Telemetry' });
export const Attitude = z
  .strictObject({
    heading: numeric({ min: 0, exclusiveMax: 360 }).nullable(),
    pitch: numeric({ min: -90, max: 90 }).nullable(),
    roll: numeric({ min: -180, exclusiveMax: 180 }).nullable(),
  })
  .refine(
    (value) => Math.abs(value.pitch ?? 0) !== 90 || (value.heading === null && value.roll === null),
    'Singular attitude',
  )
  .meta({ id: 'Attitude' });
export const Gimbal = z
  .strictObject({
    bearing: numeric({ min: 0, exclusiveMax: 360 }).nullable(),
    elevation: numeric({ min: -90, max: 90 }).nullable(),
  })
  .refine(
    (value) => Math.abs(value.elevation ?? 0) !== 90 || value.bearing === null,
    'Singular gimbal',
  )
  .meta({ id: 'Gimbal' });
export const Camera = z
  .strictObject({
    zoom_ratio: numeric({ min: 1 }).nullable(),
    recording: z.boolean().nullable().exactOptional(),
    capturing: z.boolean().nullable().exactOptional(),
  })
  .meta({ id: 'Camera' });
export const CameraOptics = z
  .strictObject({
    horizontal_fov: numeric({ exclusiveMin: 0, exclusiveMax: 180 }).nullable(),
    vertical_fov: numeric({ exclusiveMin: 0, exclusiveMax: 180 }).nullable(),
  })
  .meta({ id: 'CameraOptics' });
export const AssetTag = z.enum(['simulated']);
export const Tags = z
  .strictObject({ tags: uniqueArray(AssetTag, AssetTag.options.length) })
  .meta({ id: 'Tags' });
export const Capacity = z
  .strictObject({ bandwidth_bps: numeric({ exclusiveMin: 0 }).nullable() })
  .meta({ id: 'Capacity' });
export const Health = z.enum(['healthy', 'degraded', 'offline']);
export const Heartbeat = z.strictObject({ last_contact_at: Time }).meta({ id: 'Heartbeat' });
const reserve = { id: Uuid, remaining_percent: numeric({ min: 0, max: 100 }).nullable() };
export const Reserve = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...reserve,
      kind: z.literal('battery'),
      voltage_volts: numeric({ min: 0 }).nullable(),
      current_amperes: Float.nullable(),
    }),
    z.strictObject({ ...reserve, kind: z.literal('fuel') }),
  ])
  .meta({ id: 'Reserve' });
export const Power = z
  .strictObject({
    external_power: z.boolean().nullable(),
    reserves: z
      .array(Reserve)
      .max(16)
      .refine((values) => unique(values, (value) => value.id), 'Duplicate reserve'),
  })
  .meta({ id: 'Power' });
export const PowerTimes = z
  .strictObject({
    external_power: Time.exactOptional(),
    reserves: z
      .record(
        Uuid,
        z.strictObject({
          remaining_percent: Time.exactOptional(),
          voltage_volts: Time.exactOptional(),
          current_amperes: Time.exactOptional(),
        }),
      )
      .refine((value) => Object.keys(value).length <= 16, 'Reserve time limit')
      .meta({ maxProperties: 16 })
      .exactOptional(),
  })
  .meta({ id: 'PowerTimes' });

export type Telemetry = z.output<typeof Telemetry>;
export type Power = z.output<typeof Power>;
export type Attitude = z.output<typeof Attitude>;
export type Description = z.output<typeof Description>;
export type AssetDescription = z.output<typeof AssetDescription>;
export type AssetType = z.output<typeof AssetType>;
export type SubjectType = z.output<typeof SubjectType>;
export type GeofeatureType = z.output<typeof GeofeatureType>;
export type Status = z.output<typeof Status>;
export type Gimbal = z.output<typeof Gimbal>;
export type Camera = z.output<typeof Camera>;
export type CameraOptics = z.output<typeof CameraOptics>;
export type AssetTag = z.output<typeof AssetTag>;
export type Tags = z.output<typeof Tags>;
export type Capacity = z.output<typeof Capacity>;
export type Health = z.output<typeof Health>;
export type Heartbeat = z.output<typeof Heartbeat>;
export type Reserve = z.output<typeof Reserve>;
export type PowerTimes = z.output<typeof PowerTimes>;
