import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { threadId } from 'node:worker_threads';

const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
const output = join(artifacts, 'capture-failures');
const maximumBytes = 32 * 1024 * 1024;
let recorded = false;
const attempt = action => {
  try { return action(); }
  catch (error) { return { error: error.message, code: error.code }; }
};
const inspect = database => ({
  inTransaction: database.inTransaction,
  integrity: attempt(() => database.pragma('integrity_check(16)')),
  sequence: attempt(() => database.prepare("SELECT value FROM core_meta WHERE key='sequence'").get()),
  positions: attempt(() => database.prepare('SELECT count(*) AS count FROM evidence_positions').get()),
});

function preserve(statement, error) {
  const database = statement.database, source = resolve(database.name);
  const location = relative(artifacts, source);
  if (recorded || !database.readonly || basename(source) !== 'core.sqlite' ||
    location.startsWith('..') || isAbsolute(location) || source.startsWith(output + '/')) return;
  recorded = true;
  mkdirSync(output, { recursive: true, mode: 0o700 });
  let directory;
  for (let slot = 0; slot < 4; slot++) {
    const candidate = join(output, `failure-${slot}`);
    try { mkdirSync(candidate, { mode: 0o700 }); directory = candidate; break; }
    catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
  }
  if (directory === undefined) throw new Error('capture_diagnostic_slots_full');
  const report = { source: location, query: statement.source, code: error.code, error: error.message,
    stack: error.stack?.slice(0, 8192), pid: process.pid, thread: threadId, files: [], copy: 'incomplete' };
  const files = ['', '-wal', '-shm'].map(suffix => source + suffix).filter(existsSync);
  const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
  if (bytes <= maximumBytes) {
    report.copy = attempt(() => {
      for (const file of files) {
        const target = join(directory, basename(file));
        copyFileSync(file, target);
        const data = readFileSync(target);
        report.files.push({ name: basename(file), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
      }
      return 'complete';
    });
  } else report.copy = { error: 'capture_diagnostic_byte_limit', bytes, limit: maximumBytes };
  report.active = inspect(database);
  let reader;
  report.fresh = attempt(() => {
    reader = new Database(source, { readonly: true, fileMustExist: true });
    return inspect(reader);
  });
  if (reader !== undefined) report.freshClose = attempt(() => { reader.close(); return 'closed'; });
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stderr.write(`Capture failure evidence: ${relative(dirname(artifacts), directory)}\n`);
}

const sample = new Database(':memory:');
const iterator = sample.prepare('SELECT 1').iterate();
const prototype = Object.getPrototypeOf(iterator);
iterator.return(); sample.close();
const next = prototype.next;
prototype.next = function () {
  try { return next.call(this); }
  catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('SQLITE_CORRUPT')) {
      try { preserve(this.statement, error); }
      catch (failure) { process.stderr.write(`Capture failure evidence incomplete: ${failure.message}\n`); }
    }
    throw error;
  }
};
