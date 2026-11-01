import { z } from 'zod';
import type Database from 'better-sqlite3';
import { HistoryReading, SectionEvidence, TimeStatus, inputSections } from '@atlas/protocol';
import type { AssetReport, Continuation, HistoryQuery, ObservationReport, Origin, InputSection, ReadSection, SectionName } from '@atlas/protocol';
import { canonical, instant, now, timeKey } from './exact.js';
import { refuse } from './fault.js';
import type { Store, Transaction } from './database.js';

const Facts = z.object({ facts: z.string() });
const StoredReading = Facts.extend({ status: TimeStatus });
const SectionStatusRow = z.object({ time_status: z.string() });
const QuantityTimes = z.record(z.string(), z.string().nullable());
const ReadingRow = z.object({ identity: z.string(), image: z.string() });
type PositionSelection = Pick<Exclude<HistoryQuery, Continuation>, 'time_groups' | 'source_time_from' | 'source_time_before'>;
const positionGroup = "CASE status WHEN 'known' THEN 0 ELSE 1 END";
const positionTime = "CASE WHEN status='known' THEN time_key ELSE '' END";
type Report = AssetReport | ObservationReport;
export const originId = (origin: Origin): string => origin.kind === 'asset_process' ? origin.process_generation : origin.publisher_id;
export function evidenceFor(report: Report, section: SectionName): SectionEvidence {
  return { dataset_id: report.dataset_id, entity_id: report.entity_id, origin: report.origin,
    report_id: report.report_id, sequence: report.sequence, section };
}
export function eligible(old: { evidence: SectionEvidence | null } | undefined, report: Report): boolean {
  return report.mode === 'current' && (!old?.evidence || originId(old.evidence.origin) !== originId(report.origin) || BigInt(report.sequence) > BigInt(old.evidence.sequence));
}
export class Evidence {
  constructor(private readonly store: Store) {
    const columns = z.array(z.object({ name: z.string() })).parse(store.db.pragma('table_info(evidence_readings)'));
    if (columns.length > 0 && !columns.some(column => column.name === 'status')) throw new Error('incompatible_evidence_format');
    store.db.exec(`CREATE TABLE IF NOT EXISTS evidence_reports(scope TEXT NOT NULL,report TEXT NOT NULL,facts TEXT NOT NULL,PRIMARY KEY(scope,report)) STRICT;
      CREATE TABLE IF NOT EXISTS evidence_sections(scope TEXT NOT NULL,section TEXT NOT NULL,sequence TEXT NOT NULL,report TEXT NOT NULL,time_status TEXT NOT NULL,PRIMARY KEY(scope,section,sequence)) STRICT;
      CREATE TABLE IF NOT EXISTS evidence_readings(identity TEXT PRIMARY KEY,facts TEXT NOT NULL,status TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS evidence_positions(identity TEXT PRIMARY KEY,entity TEXT NOT NULL,source_kind TEXT NOT NULL,time_key TEXT,status TEXT NOT NULL,image TEXT NOT NULL) STRICT;
      DROP INDEX IF EXISTS positions_order;
      CREATE INDEX IF NOT EXISTS positions_stream ON evidence_positions(entity,${positionGroup},${positionTime},identity);
      CREATE INDEX IF NOT EXISTS positions_status_stream ON evidence_positions(entity,status,identity);`);
  }
  scope(report: Report): string { return `${report.entity_id}/${report.origin.kind}/${originId(report.origin)}`; }
  duplicate(report: Report): boolean {
    const found = this.store.db.prepare('SELECT facts FROM evidence_reports WHERE scope=? AND report=?').get(this.scope(report), report.report_id);
    if (!found) return false;
    if (Facts.parse(found).facts !== canonical(report)) refuse('report_identity_conflict');
    return true;
  }
  admit(tx: Transaction, report: Report, kind: 'asset' | 'observation'): void {
    const scope = this.scope(report);
    const admittedAt = now();
    const telemetry = report.sections.telemetry;
    if (telemetry?.state === 'value') this.readings(report, kind, telemetry, admittedAt);
    for (const [name, value] of Object.entries(report.sections)) {
      const section = SectionEvidence.shape.section.parse(name);
      if (this.store.db.prepare('SELECT report FROM evidence_sections WHERE scope=? AND section=? AND sequence=?').get(scope, section, report.sequence)) refuse('section_sequence_conflict');
      this.store.db.prepare('INSERT INTO evidence_sections VALUES(?,?,?,?,?)').run(scope, section, report.sequence, report.report_id, JSON.stringify(this.statuses(value, report, section, admittedAt)));
    }
    this.store.db.prepare('INSERT INTO evidence_reports VALUES(?,?,?)').run(scope, report.report_id, canonical(report));
    tx.dirty = true;
  }
  private readings(report: Report, kind: 'asset' | 'observation', telemetry: Extract<ReadSection<'telemetry'>, { state: 'value' }> | Extract<Report['sections']['telemetry'], { state: 'value' }>, admittedAt: string): void {
    for (const quantity of ['position', 'altitude', 'ground_speed', 'airspeed'] as const) {
      const source = telemetry.constituents[quantity];
      if (source === undefined) continue;
      const observed = telemetry.source_times && Object.hasOwn(telemetry.source_times, quantity)
        ? telemetry.source_times[quantity] : telemetry.observed_at;
      if (observed === undefined) throw new Error('missing_source_time');
      const value = telemetry.value[quantity];
      const identity = `${kind}/${report.entity_id}/${source.origin.kind}/${originId(source.origin)}/${quantity}/${source.reading_id}`;
      const facts = canonical({ value, observed_at: observed });
      const found = this.store.db.prepare('SELECT facts FROM evidence_readings WHERE identity=?').get(identity);
      if (found) {
        if (Facts.parse(found).facts !== facts) refuse('constituent_conflict');
        continue;
      }
      if (originId(source.origin) !== originId(report.origin)) refuse('constituent_conflict');
      const status = this.classify(observed, admittedAt);
      this.store.db.prepare('INSERT INTO evidence_readings VALUES(?,?,?)').run(identity, facts, status);
      if (quantity !== 'position') continue;
      const image = HistoryReading.parse({ source_entity_kind: kind, source_entity_id: report.entity_id,
        quantity: 'position', value, observed_at: observed, time_status: status,
        source_evidence: source, track_ids: [] });
      this.store.db.prepare('INSERT INTO evidence_positions VALUES(?,?,?,?,?,?)').run(identity, report.entity_id, kind,
        observed === null ? null : timeKey(observed), status, JSON.stringify(image));
    }
  }
  private classify(time: string | null, admittedAt: string): TimeStatus {
    return time === null ? 'unknown' : instant(time) > instant(admittedAt) ? 'uncertain' : 'known';
  }
  sourced<S extends z.ZodType>(schema: S, value: InputSection<SectionName>, report: Report, section: SectionName): z.output<S> {
    const row = SectionStatusRow.parse(this.store.db.prepare('SELECT time_status FROM evidence_sections WHERE scope=? AND section=? AND sequence=?').get(this.scope(report), section, report.sequence));
    return schema.parse({ ...value, evidence: evidenceFor(report, section), time_status: JSON.parse(row.time_status) });
  }
  private statuses(value: InputSection<SectionName>, report: Report, section: SectionName, admittedAt: string) {
    if (value.state !== 'value') return this.classify(value.observed_at, admittedAt);
    const quantities = <K extends string>(keys: readonly K[], times: Partial<Record<K, string | null>>) =>
      Object.fromEntries(keys.map(key => [key, this.classify(times[key] === undefined ? value.observed_at : times[key], admittedAt)]));
    // Parse the selected component to retain its quantity keys and nested time types.
    switch (section) {
      case 'telemetry': {
        const telemetry = inputSections.telemetry.parse(value);
        if (telemetry.state !== 'value') throw new Error('invalid_telemetry_state');
        const status = (quantity: keyof typeof telemetry.constituents): TimeStatus => {
          const source = telemetry.constituents[quantity];
          if (!source) throw new Error('missing_constituent');
          const kind = report.origin.kind === 'asset_process' ? 'asset' : 'observation';
          const identity = `${kind}/${report.entity_id}/${source.origin.kind}/${originId(source.origin)}/${quantity}/${source.reading_id}`;
          return StoredReading.parse(this.store.db.prepare('SELECT facts,status FROM evidence_readings WHERE identity=?').get(identity)).status;
        };
        return { position: status('position'), altitude: status('altitude'), ground_speed: status('ground_speed'),
          ...(telemetry.constituents.airspeed === undefined ? {} : { airspeed: status('airspeed') }) };
      }
      case 'power': {
        const power = inputSections.power.parse(value);
        if (power.state !== 'value') throw new Error('invalid_power_state');
        return { external_power: this.classify(power.source_times?.external_power === undefined ? power.observed_at : power.source_times.external_power, admittedAt),
          reserves: Object.fromEntries(power.value.reserves.map(reserve => {
            const times = power.source_times?.reserves?.[reserve.id];
            const at = (quantity: 'remaining_percent' | 'voltage_volts' | 'current_amperes') => this.classify(times?.[quantity] === undefined ? power.observed_at : times[quantity], admittedAt);
            return [reserve.id, { remaining_percent: at('remaining_percent'), ...(reserve.kind === 'battery' ? { voltage_volts: at('voltage_volts'), current_amperes: at('current_amperes') } : {}) }];
          })) };
      }
      case 'bearing_measurement':
        return this.classify(value.observed_at, admittedAt);
      default: {
        const times = 'source_times' in value ? value.source_times ?? {} : {};
        const keys = section === 'geometry' ? ['geometry'] : Object.keys(value.value).filter(key => key !== 'explanation');
        return quantities(keys, QuantityTimes.parse(times));
      }
    }
  }
  *positions(entityId: string, selection: PositionSelection = {}, source: Database.Database = this.store.db): Generator<{ identity: string; reading: HistoryReading }> {
    const groups = [{ order: 0, statuses: ['known'] }, { order: 1, statuses: ['unknown', 'uncertain'] }] as const;
    for (const group of groups) {
      const statuses = group.statuses.filter(status => selection.time_groups === undefined || selection.time_groups.includes(status));
      if (statuses.length === 0) continue;
      const byStatus = group.order === 1 && statuses.length === 1;
      const conditions = ['entity=?', `status IN (${statuses.map(() => '?').join(',')})`];
      const bindings: (string | number)[] = [entityId, ...statuses];
      if (!byStatus) { conditions.push(`${positionGroup}=?`); bindings.push(group.order); }
      if (group.order === 0) {
        for (const [bound, operator] of [[selection.source_time_from, '>='], [selection.source_time_before, '<']] as const) {
          if (bound === undefined) continue;
          conditions.push(`${positionTime}${operator}?`); bindings.push(timeKey(bound));
        }
      }
      for (const row of source.prepare(`SELECT identity,image FROM evidence_positions WHERE ${conditions.join(' AND ')}
        ORDER BY ${byStatus ? 'identity' : `${positionTime},identity`}`).iterate(...bindings)) {
        const value = ReadingRow.parse(row);
        yield { identity: value.identity, reading: HistoryReading.parse(JSON.parse(value.image)) };
      }
    }
  }
  position(identity: string): HistoryReading {
    const row = this.store.db.prepare('SELECT identity,image FROM evidence_positions WHERE identity=?').get(identity);
    return HistoryReading.parse(JSON.parse(ReadingRow.parse(row).image));
  }
  clearDataset(): void { this.store.db.exec('DELETE FROM evidence_positions; DELETE FROM evidence_readings; DELETE FROM evidence_sections; DELETE FROM evidence_reports'); }
}
