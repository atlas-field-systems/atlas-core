import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRecord, type RunRecord } from './records.js';
export type Comparison = {
  scenario: string;
  before: string;
  after: string;
  differences: string[];
  measurements: Record<
    string,
    { before: number | null; after: number | null; percent: number | null }
  >;
};
function median(values: number[]): number | null {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2),
    right = values[mid];
  return right === undefined
    ? null
    : values.length % 2
      ? right
      : ((values[mid - 1] ?? right) + right) / 2;
}
export function compareRecords(
  records: readonly RunRecord[],
  left: string,
  right: string,
): Comparison[] {
  const scenarios = [
    ...new Set(
      records
        .filter((r) => r.source.branch === right || r.source.commit === right)
        .map((r) => r.scenario),
    ),
  ].sort();
  return scenarios.map((scenario) => {
    const select = (branch: string) =>
      records
        .filter(
          (r) =>
            r.scenario === scenario &&
            (r.source.branch === branch || r.source.commit === branch) &&
            !(branch === 'main' && /^[a-f0-9]{40}$/.test(right) && r.source.commit === right),
        )
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, branch === 'main' ? 10 : 1);
    const a = select(left),
      b = select(right),
      first = a[0],
      last = b[0];
    const measurements: Comparison['measurements'] = {};
    for (const key of new Set([...a, ...b].flatMap((r) => Object.keys(r.measurements)))) {
      const values = (rows: RunRecord[]) =>
        rows.flatMap((r) => {
          const value = r.measurements[key];
          return typeof value === 'number' ? [value] : [];
        });
      const before = median(values(a)),
        after = median(values(b));
      measurements[key] = {
        before,
        after,
        percent:
          before === null || before === 0 || after === null
            ? null
            : ((after - before) / before) * 100,
      };
    }
    const differences: string[] = [];
    if (!first) differences.push('baseline missing');
    if (last && a.some((r) => r.inputs.scenario !== last.inputs.scenario))
      differences.push('scenario hash');
    if (last && a.some((r) => r.inputs.settings !== last.inputs.settings))
      differences.push('settings hash');
    if (last && a.some((r) => r.environment.cpu !== last.environment.cpu))
      differences.push('CPU model');
    return {
      scenario,
      before: first?.verdict ?? 'missing',
      after: last?.verdict ?? 'missing',
      differences,
      measurements,
    };
  });
}
export async function compareHistory(
  directory: string,
  left: string,
  right: string,
): Promise<Comparison[]> {
  const records: RunRecord[] = [];
  async function visit(path: string, depth = 0): Promise<void> {
    if (depth > 16) throw new Error('History directory depth');
    const entries = await opendir(path, { bufferSize: 32 });
    for await (const item of entries) {
      if (item.isSymbolicLink()) throw new Error('History symlink refused');
      if (item.isDirectory() && item.name !== '.git') await visit(join(path, item.name), depth + 1);
      else if (item.isFile() && item.name.endsWith('.json')) {
        const record = await readRecord(join(path, item.name));
        if (
          ![left, right].some((ref) => record.source.branch === ref || record.source.commit === ref)
        )
          continue;
        if (
          records.some(
            (r) =>
              r.scenario === record.scenario &&
              r.at === record.at &&
              r.source.commit === record.source.commit,
          )
        )
          continue;
        records.push(record);
        const selected = new Set(
          [left, right].flatMap((ref) =>
            records
              .filter(
                (r) =>
                  r.scenario === record.scenario &&
                  (r.source.branch === ref || r.source.commit === ref) &&
                  !(ref === 'main' && /^[a-f0-9]{40}$/.test(right) && r.source.commit === right),
              )
              .sort((a, b) => b.at.localeCompare(a.at))
              .slice(0, ref === 'main' ? 10 : 1),
          ),
        );
        for (const older of records.filter(
          (r) => r.scenario === record.scenario && !selected.has(r),
        ))
          records.splice(records.indexOf(older), 1);
        if (
          records.length > 10000 ||
          records.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)), 0) > 67108864
        )
          throw new Error('History retained byte budget');
      }
    }
  }
  await visit(directory);
  return compareRecords(records, left, right);
}
export function comparisonMarkdown(rows: readonly Comparison[]): string {
  const safe = (s: string) => s.replaceAll('|', '/').replaceAll('\n', ' ');
  return (
    [
      '| Scenario | Before | After | Differences | Measurement | Before | After | Change |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.flatMap((r) =>
        Object.entries(r.measurements).map(
          ([name, m]) =>
            `| ${safe(r.scenario)} | ${r.before} | ${r.after} | ${r.differences.join(', ')} | ${safe(name)} | ${m.before ?? 'unavailable'} | ${m.after ?? 'unavailable'} | ${m.percent === null ? 'n/a' : m.percent.toFixed(2) + '%'} |`,
        ),
      ),
    ].join('\n') + '\n'
  );
}
