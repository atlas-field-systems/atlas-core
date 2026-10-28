import { z } from 'zod';
import type Database from 'better-sqlite3';
import { HistoryReading, SectionEvidence } from '@atlas/protocol';
import type { AssetReport, ObservationReport, Origin, ReadSection, SectionName } from '@atlas/protocol';
import { canonical, instant, now, timeKey } from './exact.js';
import { refuse } from './fault.js';
import type { Store, Transaction } from './database.js';

const Facts = z.object({ facts: z.string() });
const ReadingRow = z.object({ identity: z.string(), image: z.string() });
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
    store.db.exec(`CREATE TABLE IF NOT EXISTS evidence_reports(scope TEXT NOT NULL,report TEXT NOT NULL,facts TEXT NOT NULL,PRIMARY KEY(scope,report)) STRICT;
      CREATE TABLE IF NOT EXISTS evidence_sections(scope TEXT NOT NULL,section TEXT NOT NULL,sequence TEXT NOT NULL,report TEXT NOT NULL,PRIMARY KEY(scope,section,sequence)) STRICT;
      CREATE TABLE IF NOT EXISTS evidence_readings(identity TEXT PRIMARY KEY,facts TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS evidence_positions(identity TEXT PRIMARY KEY,entity TEXT NOT NULL,source_kind TEXT NOT NULL,time_key TEXT,status TEXT NOT NULL,image TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS positions_order ON evidence_positions(entity,status,time_key,identity);`);
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
    for (const section of Object.keys(report.sections)) {
      if (this.store.db.prepare('SELECT report FROM evidence_sections WHERE scope=? AND section=? AND sequence=?').get(scope, section, report.sequence)) refuse('section_sequence_conflict');
      this.store.db.prepare('INSERT INTO evidence_sections VALUES(?,?,?,?)').run(scope, section, report.sequence, report.report_id);
    }
    const telemetry = report.sections.telemetry;
    if (telemetry?.state === 'value') this.readings(report, kind, telemetry);
    this.store.db.prepare('INSERT INTO evidence_reports VALUES(?,?,?)').run(scope, report.report_id, canonical(report));
    tx.dirty = true;
  }
  private readings(report: Report, kind: 'asset' | 'observation', telemetry: Extract<ReadSection<'telemetry'>, { state: 'value' }> | Extract<Report['sections']['telemetry'], { state: 'value' }>): void {
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
      this.store.db.prepare('INSERT INTO evidence_readings VALUES(?,?)').run(identity, facts);
      if (quantity !== 'position') continue;
      const status = observed === null ? 'unknown' : instant(observed) > instant(now()) ? 'uncertain' : 'known';
      const image = HistoryReading.parse({ source_entity_kind: kind, source_entity_id: report.entity_id,
        quantity: 'position', value, observed_at: observed, time_status: status,
        source_evidence: source, track_ids: [] });
      this.store.db.prepare('INSERT INTO evidence_positions VALUES(?,?,?,?,?,?)').run(identity, report.entity_id, kind,
        observed === null ? null : timeKey(observed), status, JSON.stringify(image));
    }
  }
  *positions(entityId: string, source: Database.Database = this.store.db): Generator<{ identity: string; reading: HistoryReading }> {
    for (const row of source.prepare(`SELECT identity,image FROM evidence_positions WHERE entity=?
      ORDER BY CASE status WHEN 'known' THEN 0 ELSE 1 END,CASE WHEN status='known' THEN time_key ELSE '' END,identity`).iterate(entityId)) {
      const value = ReadingRow.parse(row);
      yield { identity: value.identity, reading: HistoryReading.parse(JSON.parse(value.image)) };
    }
  }
  position(identity: string): HistoryReading {
    const row = this.store.db.prepare('SELECT identity,image FROM evidence_positions WHERE identity=?').get(identity);
    return HistoryReading.parse(JSON.parse(ReadingRow.parse(row).image));
  }
  clearDataset(): void { this.store.db.exec('DELETE FROM evidence_positions; DELETE FROM evidence_readings; DELETE FROM evidence_sections; DELETE FROM evidence_reports'); }
}
