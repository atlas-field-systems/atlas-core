import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

const report = { experiment: 'sync', cases: [], findings: [], limitations: [
  'Throwaway mechanism experiment, not qualified Atlas SDK/Core behavior. Private envelopes and decimal cursor indexes are fixture choices.',
  'Real Node 24 HTTP sockets, serialized JSON, and SQLite WAL/FULL. No Python helper or child process is used.',
  'Capture expiry uses an injected monotonic tick clock. Allocation and release response losses use real interrupted HTTP sockets.',
  'Small bounded fixtures do not establish aggregate RAM, workload capacity, power-loss durability, authentication, cross-language validation, or the planned Go/TypeScript implementation.',
  'Slow-consumer evidence covers the SDK local journal, not Core socket backpressure. Capture restart is a control fixture, not a killed process.',
  'No competing replay stream, disconnect/resume of complete staging, full wire-parser qualification, randomized schedules, process restart, or physical/radio workflow is exercised.'
] };
const check = (name, expected, observed) => report.cases.push({ name, expected, observed, passed: isDeepStrictEqual(expected, observed) });
const must = (value, reason) => { if (!value) throw Error(reason); };
const fail = code => { throw Error(code); };
const json = value => JSON.stringify(value);
const index = cursor => { must(/^c\d+$/.test(cursor), 'cursor'); return Number(cursor.slice(1)); };
const cursor = n => `c${n}`;
const image = (id, version, value) => ({ kind: 'image', id, version, value });
const deletion = (id, version) => ({ kind: 'deletion', id, version });
function resource(r) {
  must(r && typeof r.id === 'string' && /^[a-z]+$/.test(r.id) && Number.isSafeInteger(r.version) && r.version > 0, 'resource');
  must(r.kind === 'deletion' || (r.kind === 'image' && typeof r.value === 'string'), 'resource');
  must(Object.keys(r).sort().join() === (r.kind === 'image' ? 'id,kind,value,version' : 'id,kind,version'), 'resource_fields');
  return r;
}
function merge(base, changes) {
  const next = new Map(base);
  for (const r of changes) {
    const old = next.get(r.id);
    if (!old || old.version < r.version) next.set(r.id, r);
    else if (old.version === r.version) must(isDeepStrictEqual(old, r), 'conflicting_version');
  }
  return next;
}
const visible = map => Object.fromEntries([...map].filter(([, r]) => r.kind === 'image').sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => [id, [r.version, r.value]]));

class Picture {
  constructor(budget = { bytes: 65536, changes: 20 }) {
    this.dataset = 'D1'; this.published = null; this.staged = null; this.applied = null;
    this.stageCursor = null; this.H = null; this.coverage = 'initializing'; this.generation = 0;
    this.journal = []; this.position = 0; this.notifications = []; this.receipts = new Map();
    this.budget = budget; this.capture = null; this.releasePending = false; this.pageOffset = 0; this.pagesDone = false;
  }
  query() {
    return this.coverage === 'synchronized' || this.coverage === 'disconnected'
      ? { resources: visible(this.published), cursor: this.applied, localCursor: this.position, generation: this.generation, dataset: this.dataset }
      : null;
  }
  effects() {
    return { resources: this.published && visible(this.published), staged: this.staged && visible(this.staged), cursor: this.applied,
      journal: structuredClone(this.journal), notifications: structuredClone(this.notifications) };
  }
  begin(capture) {
    this.capture = capture; this.releasePending = false; this.staged = new Map(); this.stageCursor = capture.N; this.coverage = 'recovering';
    this.pageOffset = 0; this.pagesDone = false; this.receipts = new Map();
  }
  page(raw) {
    const page = JSON.parse(raw);
    must(page.loadId === this.capture.loadId && page.N === this.capture.N && Array.isArray(page.rows) && page.offset === this.pageOffset && !this.pagesDone, 'page_context');
    const rows = page.rows.map(resource);
    this.staged = merge(this.staged, rows);
    this.pageOffset += rows.length; this.pagesDone = page.next === null;
  }
  receive(raw, incremental = false) {
    if (Buffer.byteLength(raw) > this.budget.bytes) { this.coverage = 'resource-limited'; fail('capacity'); }
    const c = JSON.parse(raw);
    must(c.type === 'commit' && c.dataset === this.dataset && Array.isArray(c.changes), 'commit_context');
    const seq = index(c.cursor);
    if (c.changes.length > this.budget.changes) { this.coverage = 'resource-limited'; fail('capacity'); }
    if (this.receipts.has(c.cursor)) { must(isDeepStrictEqual(JSON.parse(this.receipts.get(c.cursor)), c), 'conflicting_commit'); return; }
    const previous = index(this.staged ? this.stageCursor : this.applied);
    must(seq === previous + 1, 'commit_order');
    if (incremental) {
      for (const r of c.changes) {
        this.published = merge(this.published, [resource(r)]);
        this.applied = c.cursor; this.record(c);
      }
      return;
    }
    const changes = c.changes.map(resource);
    const next = merge(this.staged || this.published, changes);
    this.receipts.set(c.cursor, json(c));
    if (this.staged) { this.staged = next; this.stageCursor = c.cursor; }
    else { this.published = next; this.applied = c.cursor; this.record(c); }
  }
  record(commit) {
    this.journal.push({ position: ++this.position, commit });
    if (this.journal.length > 2) this.journal.shift();
    this.notifications.push(this.query());
  }
  ready(end) {
    must(this.pagesDone && end.H === this.H && this.stageCursor === this.H, 'handoff_incomplete');
    this.published = this.staged; this.staged = null; this.applied = this.stageCursor;
    this.generation++; this.position = 0; this.journal = []; this.coverage = 'synchronized';
  }
  invalidate(reason) { this.coverage = reason; this.staged = null; }
  replayRefused(response) {
    must(response.status === 410 && JSON.parse(response.body).error === 'replay_expired', 'unexpected_replay_refusal');
    this.invalidate('recovering');
  }
  subscribe(position = this.position) { return { position, generation: this.generation, stopped: false }; }
  drain(sub) {
    if (sub.stopped) return [];
    if (sub.generation !== this.generation || sub.position < (this.journal[0]?.position ?? this.position + 1) - 1) {
      sub.stopped = true; return [{ type: 'gap' }];
    }
    const batches = this.journal.filter(b => b.position > sub.position);
    if (batches.length) sub.position = batches.at(-1).position;
    return batches;
  }
  async recover(api, load, explicit = false) {
    if (this.coverage === 'resource-limited' && !explicit) return 'paused';
    const limits = JSON.parse((await api('/limits')).body);
    if (limits.bytes > this.budget.bytes || limits.changes > this.budget.changes) { this.coverage = 'resource-limited'; return 'paused'; }
    if (this.releasePending && limits.tick < this.capture.expiry) return 'awaiting_release';
    const response = await api('/allocate', load);
    must(response.status === 200, `allocation_${response.status}`);
    this.begin(JSON.parse(response.body)); return 'loading';
  }
}

let directory, db, server;
const sockets = new Set(), feeds = new Set(), requests = new Set();
let tick = 0, run = 'run-1', allocations = 0, allocationAttempts = 0, prunedThrough = 0, nextFeed = 0;
const seed = [image('a', 1, 'A0'), image('b', 1, 'B0'), image('c', 1, 'C0'), image('d', 1, 'D0')];
const head = () => db.prepare('SELECT seq FROM metadata').get().seq;
const rows = (sql, ...args) => db.prepare(sql).all(...args).map(r => JSON.parse(r.data));
function write(changes) {
  changes.forEach(resource);
  const c = { type: 'commit', dataset: 'D1', cursor: cursor(head() + 1), changes };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of changes) db.prepare('INSERT OR REPLACE INTO resources VALUES(?,?)').run(r.id, json(r));
    db.prepare('INSERT INTO commits VALUES(?,?)').run(index(c.cursor), json(c));
    db.prepare('UPDATE metadata SET seq=?').run(index(c.cursor));
    db.exec('COMMIT'); return c;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function reset() {
  must(feeds.size === 0, 'reset_with_active_feed');
  db.exec('DELETE FROM resources; DELETE FROM commits; DELETE FROM captures; DELETE FROM snapshot; UPDATE metadata SET seq=0');
  tick = 0; run = 'run-1'; allocations = 0; allocationAttempts = 0; prunedThrough = 0; write(seed);
}
const load = (id, issued = tick) => ({ dataset: 'D1', loadId: id, run, issued, facts: 'page=2' });
function allocate(ctx) {
  if (ctx.dataset !== 'D1' || ctx.run !== run || !Number.isInteger(ctx.issued) || ctx.issued > tick || ctx.issued + 50 <= tick) return [409, { error: 'ended_context' }];
  const old = db.prepare('SELECT * FROM captures WHERE loadId=?').get(ctx.loadId);
  if (old) {
    if (old.facts !== json(ctx)) return [409, { error: 'changed_facts' }];
    if (old.status !== 'active' || old.expiry <= tick) return [409, { error: 'ended_context' }];
    return [200, { loadId: ctx.loadId, N: cursor(old.n), expiry: old.expiry }];
  }
  if (db.prepare("SELECT count(*) n FROM captures WHERE status='active' AND expiry>?").get(tick).n >= 2) return [429, { error: 'capture_limit' }];
  db.exec('BEGIN IMMEDIATE');
  try {
    const n = head(), expiry = ctx.issued + 50;
    db.prepare('INSERT INTO captures VALUES(?,?,?,?,?)').run(ctx.loadId, n, expiry, json(ctx), 'active');
    db.prepare('INSERT INTO snapshot SELECT ?,id,data FROM resources').run(ctx.loadId);
    db.exec('COMMIT'); allocations++; return [200, { loadId: ctx.loadId, N: cursor(n), expiry }];
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
const send = (res, status, value, cut) => {
  const body = Buffer.from(json(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  if (cut) { res.write(body.subarray(0, Math.floor(body.length / 2))); setImmediate(() => res.destroy()); }
  else res.end(body);
};
async function route(req, res) {
  const url = new URL(req.url, 'http://fixture');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; must(size <= 65536, 'request_limit'); chunks.push(chunk); }
  const body = size ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  let status = 200, value;
  switch (url.pathname) {
    case '/write': value = write(body.changes); break;
    case '/allocate': allocationAttempts++; [status, value] = allocate(body); break;
    case '/release':
      db.prepare("UPDATE captures SET status='released' WHERE loadId=?").run(body.loadId);
      db.prepare('DELETE FROM snapshot WHERE loadId=?').run(body.loadId);
      value = { type: 'snapshot_released', loadId: body.loadId }; break;
    case '/page': {
      const cap = db.prepare('SELECT * FROM captures WHERE loadId=?').get(url.searchParams.get('load'));
      if (!cap || cap.status !== 'active' || cap.expiry <= tick) { status = 410; value = { error: 'capture_expired' }; break; }
      const offset = Number(url.searchParams.get('offset'));
      const pageRows = url.searchParams.has('live')
        ? rows("SELECT data FROM resources WHERE json_extract(data,'$.kind')='image' ORDER BY id LIMIT 2 OFFSET ?", offset)
        : rows('SELECT data FROM snapshot WHERE loadId=? ORDER BY id LIMIT 2 OFFSET ?', cap.loadId, offset);
      const total = url.searchParams.has('live')
        ? db.prepare("SELECT count(*) n FROM resources WHERE json_extract(data,'$.kind')='image'").get().n
        : db.prepare('SELECT count(*) n FROM snapshot WHERE loadId=?').get(cap.loadId).n;
      value = { loadId: cap.loadId, N: cursor(cap.n), offset, rows: pageRows, next: offset + pageRows.length < total ? offset + pageRows.length : null }; break;
    }
    case '/subscribe': {
      const from = index(url.searchParams.get('from'));
      if (from < prunedThrough) { status = 410; value = { error: 'replay_expired' }; break; }
      const f = { id: ++nextFeed, from, H: head(), res };
      feeds.add(f); res.on('close', () => feeds.delete(f));
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(json({ type: 'ack', dataset: 'D1', H: cursor(f.H), feed: f.id }) + '\n'); return;
    }
    case '/deliver': {
      const f = [...feeds].find(f => f.id === body.feed); must(f, 'missing_feed');
      const end = body.moving ? head() : f.H;
      for (const c of rows('SELECT data FROM commits WHERE seq>? AND seq<=? ORDER BY seq', f.from, end)) f.res.write(json(c) + '\n');
      f.from = end; f.res.write(json({ type: 'caught_up', H: cursor(end) }) + '\n'); value = { delivered: cursor(end) }; break;
    }
    case '/live': {
      const f = [...feeds].find(f => f.id === body.feed); must(f, 'missing_feed');
      for (const c of rows('SELECT data FROM commits WHERE seq>? ORDER BY seq', f.from)) f.res.write(json(c) + '\n');
      f.from = head(); value = { delivered: cursor(f.from) }; break;
    }
    case '/message':
      value = url.searchParams.has('cursor')
        ? rows('SELECT data FROM commits WHERE seq=?', index(url.searchParams.get('cursor')))[0]
        : { type: 'commit', dataset: 'D1', cursor: 'c2', changes: [image('a', 2, 'A2'), image('b', 2, url.searchParams.has('invalid') ? 17 : 'B2')] };
      if (url.searchParams.has('reordered')) value = {
        changes: value.changes.map(r => Object.fromEntries(Object.entries(r).reverse())), cursor: value.cursor, dataset: value.dataset, type: value.type
      };
      if (url.searchParams.has('reversed')) value.changes.reverse();
      break;
    case '/limits': {
      const retained = rows('SELECT data FROM commits');
      value = { bytes: Math.max(1024, ...retained.map(c => Buffer.byteLength(json(c)))), changes: Math.max(4, ...retained.map(c => c.changes.length)), tick }; break;
    }
    case '/clock': tick = body.tick; value = { tick }; break;
    case '/prune':
      prunedThrough = body.through; db.prepare('DELETE FROM commits WHERE seq<=?').run(body.through);
      db.prepare('DELETE FROM snapshot WHERE loadId IN (SELECT loadId FROM captures WHERE expiry<=?)').run(tick);
      db.prepare('DELETE FROM captures WHERE expiry<=?').run(tick); value = { prunedThrough }; break;
    case '/restart': run = 'run-2'; db.exec('DELETE FROM snapshot; DELETE FROM captures'); value = { run }; break;
    default: status = 404; value = { error: 'missing_route' };
  }
  send(res, status, value, url.searchParams.has('cut'));
}
let port;
function api(path, body) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false, status;
    const request = http.request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', agent: false }, res => {
      status = res.statusCode;
      res.on('data', chunk => { size += chunk.length; if (size > 65536) request.destroy(Error('response_limit')); else chunks.push(chunk); });
      res.on('end', () => finish(null, { status, body: Buffer.concat(chunks).toString() }));
      res.on('error', error => finish(error));
    });
    requests.add(request);
    const timer = setTimeout(() => request.destroy(Error('http_deadline')), 2000);
    function finish(error, result) {
      if (done) return; done = true; clearTimeout(timer); requests.delete(request);
      if (error) reject(Object.assign(error, { received: Buffer.concat(chunks).toString(), status })); else resolve(result);
    }
    request.on('error', error => finish(error));
    request.end(body ? json(body) : undefined);
  });
}
function openFeed(from) {
  const queue = []; let waiting, ended = false, buffer = '';
  const req = http.get({ host: '127.0.0.1', port, path: `/subscribe?from=${from}`, agent: false }, res => {
    res.setEncoding('utf8');
    res.on('data', chunk => {
      if (buffer.length + chunk.length > 65536) { req.destroy(Error('feed_limit')); return; } buffer += chunk;
      for (let at; (at = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (waiting) { const w = waiting; waiting = null; w.resolve(line); }
        else if (queue.length >= 20) { req.destroy(Error('feed_queue_limit')); return; } else queue.push(line);
      }
    });
    res.on('error', error => { ended = true; waiting?.reject(error); waiting = null; });
    res.on('end', () => { ended = true; waiting?.reject(Error('feed_ended')); waiting = null; });
  });
  requests.add(req); req.on('error', error => { ended = true; waiting?.reject(error); waiting = null; });
  return {
    get open() { return !ended && !req.destroyed; },
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      must(!ended && !waiting, 'feed_unavailable');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting = null; reject(Error('feed_deadline')); req.destroy(); }, 2000);
        waiting = { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } };
      });
    },
    async close() {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('feed_close_deadline')), 2000);
        req.once('close', () => { clearTimeout(timer); resolve(); }); req.destroy();
      }); requests.delete(req);
      await api('/limits');
    }
  };
}
function baseline() {
  const p = new Picture(); p.begin({ loadId: 'fixture', N: 'c1', expiry: 50 });
  p.page(json({ loadId: 'fixture', N: 'c1', rows: seed, offset: 0, next: null })); p.H = 'c1'; p.ready({ H: 'c1' }); return p;
}
async function refused(action) { try { await action(); return 'accepted'; } catch (error) { return error.message; } }
async function interrupted(action) {
  try { await action(); fail('expected_socket_interruption'); }
  catch (error) { must(error.received?.length > 0, `no_partial_bytes_${error.message}`); return error; }
}

async function atomicCases() {
  reset(); const p = baseline(), before = p.effects();
  const cut = await interrupted(() => api('/message?cut=1'));
  const truncated = await refused(() => p.receive(cut.received));
  check('truncated_commit_preserves_all_effects', { partialBytes: true, rejected: true, unchanged: true },
    { partialBytes: cut.received.length > 0, rejected: truncated !== 'accepted', unchanged: isDeepStrictEqual(before, p.effects()) });
  const invalid = (await api('/message?invalid=1')).body;
  check('invalid_final_resource_preserves_all_effects', { rejection: 'resource', unchanged: true },
    { rejection: await refused(() => p.receive(invalid)), unchanged: isDeepStrictEqual(before, p.effects()) });
  const broken = baseline(), brokenBefore = broken.effects(); await refused(() => broken.receive(invalid, true));
  const brokenAfter = broken.effects(), detected = !isDeepStrictEqual(brokenBefore, brokenAfter);
  check('control_apply_partial_detected_by_same_unchanged_predicate',
    { unchanged: false, resources: { a: [2, 'A2'], b: [1, 'B0'], c: [1, 'C0'], d: [1, 'D0'] }, cursor: 'c2', journal: 1, notifications: 1 },
    { unchanged: !detected, resources: brokenAfter.resources, cursor: brokenAfter.cursor, journal: brokenAfter.journal.length, notifications: brokenAfter.notifications.length });
  if (detected) report.findings.push({ classification: 'documented-rule pitfall', claim: 'Incremental validation mutated state before rejecting the invalid final resource.',
    evidence: { changed: Object.keys(brokenBefore).filter(key => !isDeepStrictEqual(brokenBefore[key], brokenAfter[key])), resources: brokenAfter.resources, cursor: brokenAfter.cursor } });
  p.receive((await api('/write', { changes: [image('a', 2, 'A2'), image('b', 2, 'B2')] })).body);
  check('complete_commit_notifies_once_with_coherent_query_and_cursor',
    { resources: { a: [2, 'A2'], b: [2, 'B2'], c: [1, 'C0'], d: [1, 'D0'] }, cursor: 'c2', journal: 1, notifications: 1, coherent: true },
    { resources: p.query().resources, cursor: p.applied, journal: p.journal.length, notifications: p.notifications.length, coherent: isDeepStrictEqual(p.notifications[0], p.query()) });
  const afterComplete = p.effects();
  check('reordered_object_members_duplicate_is_inert', { result: 'accepted', unchanged: true },
    { result: await refused(async () => p.receive((await api('/message?cursor=c2&reordered=1')).body)), unchanged: isDeepStrictEqual(afterComplete, p.effects()) });
  check('reordered_changes_array_duplicate_is_rejected', { rejection: 'conflicting_commit', unchanged: true },
    { rejection: await refused(async () => p.receive((await api('/message?cursor=c2&reversed=1')).body)), unchanged: isDeepStrictEqual(afterComplete, p.effects()) });
  const c3 = JSON.parse((await api('/write', { changes: [deletion('b', 3)] })).body);
  p.receive(json(c3)); const afterDelete = p.effects(); p.receive(json(c3));
  check('exact_duplicate_is_inert', true, isDeepStrictEqual(afterDelete, p.effects()));
  check('reordered_deletion_duplicate_is_inert', { result: 'accepted', unchanged: true },
    { result: await refused(async () => p.receive((await api('/message?cursor=c3&reordered=1')).body)), unchanged: isDeepStrictEqual(afterDelete, p.effects()) });
  const conflicting = { ...c3, changes: [image('b', 3, 'resurrect')] };
  check('conflicting_duplicate_is_rejected', { rejection: 'conflicting_commit', unchanged: true },
    { rejection: await refused(() => p.receive(json(conflicting))), unchanged: isDeepStrictEqual(afterDelete, p.effects()) });
  p.receive((await api('/write', { changes: [image('b', 1, 'stale')] })).body);
  check('tombstone_blocks_stale_resurrection', { present: false, tombstoneVersion: 3, cursor: 'c4' },
    { present: 'b' in p.query().resources, tombstoneVersion: p.published.get('b').version, cursor: p.applied });
  const beforeDataset = p.effects();
  check('new_dataset_commit_rejected', { rejection: 'commit_context', unchanged: true },
    { rejection: await refused(() => p.receive(json({ ...c3, dataset: 'D2', cursor: 'c5' }))), unchanged: isDeepStrictEqual(beforeDataset, p.effects()) });
  const slow = p.subscribe(0), current = p.subscribe();
  check('slow_subscriber_gets_explicit_gap', [{ type: 'gap' }], p.drain(slow));
  check('new_subscriber_starts_at_boundary', [], p.drain(current));
  p.receive((await api('/write', { changes: [image('a', 3, 'A5')] })).body);
  check('gapped_subscriber_stops_and_current_subscriber_gets_whole_commit', { stopped: [], changes: [image('a', 3, 'A5')], position: 4 },
    { stopped: p.drain(slow), changes: p.drain(current)[0].commit.changes, position: current.position });
  check('same_version_reordered_resource_is_harmless',
    { result: 'accepted', resources: { a: [3, 'A5'], c: [1, 'C0'], d: [1, 'D0'] }, cursor: 'c6', notifications: 5 },
    { result: await refused(async () => p.receive((await api('/write', { changes: [{ value: 'A5', version: 3, id: 'a', kind: 'image' }] })).body)),
      resources: p.query().resources, cursor: p.applied, notifications: p.notifications.length });
  const beforeVersionConflict = p.effects();
  check('same_version_changed_resource_is_rejected', { rejection: 'conflicting_version', unchanged: true },
    { rejection: await refused(async () => p.receive((await api('/write', { changes: [image('a', 3, 'different')] })).body)),
      unchanged: isDeepStrictEqual(beforeVersionConflict, p.effects()) });
}

const throughH = { b: [2, 'B@2'], c: [1, 'C0'], d: [2, 'D@3'] };
const readyPredicate = value => isDeepStrictEqual(value, { resources: throughH, cursor: 'c3', H: 'c3', ready: true });
async function handoff(variant) {
  reset(); const p = new Picture(), ctx = load(`handoff-${variant}`);
  await p.recover(api, ctx); p.page((await api(`/page?load=${ctx.loadId}&offset=0`)).body);
  const privateDuringPages = p.query() === null;
  await api('/write', { changes: [deletion('a', 2), image('b', 2, 'B@2'), image('e', 1, 'E@2')] });
  const pageBefore = p.effects(), cut = await interrupted(() => api(`/page?load=${ctx.loadId}&offset=2&cut=1`));
  must(cut.received.length > 0 && isDeepStrictEqual(pageBefore, p.effects()), 'partial_page_mutated');
  p.page((await api(`/page?load=${ctx.loadId}&offset=2${variant === 'live_pages' ? '&live=1' : ''}`)).body);
  await api('/write', { changes: [image('d', 2, 'D@3'), deletion('e', 2)] });
  await api('/release', { loadId: ctx.loadId });
  const feed = openFeed('c1');
  try {
    const ack = JSON.parse(await feed.next()); p.H = ack.H;
    const ackIsNotProgress = p.applied === null && p.query() === null;
    await api('/write', { changes: [image('b', 3, 'B@4'), image('f', 1, 'F@4')] });
    await api('/deliver', { feed: ack.feed, moving: variant === 'move_h' });
    for (;;) {
      const raw = await feed.next(), event = JSON.parse(raw);
      if (event.type === 'caught_up') { if (variant === 'move_h') p.H = event.H; p.ready(event); break; }
      p.receive(raw);
    }
    const first = { resources: p.query().resources, cursor: p.applied, H: p.H, ready: p.coverage === 'synchronized' };
    if (variant === 'fixed') {
      check('immutable_paging_fixed_h_matches_handwritten_map', { resources: throughH, cursor: 'c3', H: 'c3', ready: true }, first);
      check('private_staging_ack_not_progress_and_after_h_cannot_delay_readiness',
        { privateDuringPages: true, ackIsNotProgress: true, streamStillOpen: true, serverHead: 'c4', syntheticEvents: 0 },
        { privateDuringPages, ackIsNotProgress, streamStillOpen: feed.open, serverHead: cursor(head()), syntheticEvents: p.notifications.length });
      await api('/live', { feed: ack.feed }); p.receive(await feed.next());
      check('after_h_commit_enters_live_path_after_first_readiness', { resources: { b: [3, 'B@4'], c: [1, 'C0'], d: [2, 'D@3'], f: [1, 'F@4'] }, cursor: 'c4', notifications: 1 },
        { resources: p.query().resources, cursor: p.applied, notifications: p.notifications.length });
    } else {
      const expectedBad = variant === 'move_h'
        ? { resources: { b: [3, 'B@4'], c: [1, 'C0'], d: [2, 'D@3'], f: [1, 'F@4'] }, cursor: 'c4', H: 'c4', ready: true }
        : { resources: { b: [2, 'B@2'], d: [2, 'D@3'] }, cursor: 'c3', H: 'c3', ready: true };
      check(`control_${variant}_detected_by_same_handwritten_h_predicate`, { oracle_accepts: false, picture: expectedBad },
        { oracle_accepts: readyPredicate(first), picture: first });
      if (!readyPredicate(first)) report.findings.push({ classification: 'documented-rule pitfall', claim: variant === 'move_h' ? 'Moving H published post-handoff B@4 and F@4.' : 'Live-table offset paging omitted unchanged resource c.', evidence: first });
    }
  } finally { await feed.close(); }
}

async function captureCases() {
  reset(); const ctx = load('lost-allocation');
  await interrupted(() => api('/allocate?cut=1', ctx));
  await api('/clock', { tick: 10 });
  await api('/write', { changes: [image('a', 2, 'later')] });
  const cap = JSON.parse((await api('/allocate', ctx)).body);
  check('lost_allocation_retry_recovers_original_capture_and_expiry', { loadId: ctx.loadId, N: 'c1', expiry: 50, allocations: 1 }, { ...cap, allocations });
  check('changed_load_facts_conflict', 409, (await api('/allocate', { ...ctx, facts: 'page=3' })).status);
  const p = new Picture(); p.begin(cap); p.page((await api(`/page?load=${ctx.loadId}&offset=0`)).body); p.page((await api(`/page?load=${ctx.loadId}&offset=2`)).body);
  const feed = openFeed(cap.N);
  try {
    const ack = JSON.parse(await feed.next()); p.H = ack.H;
    await api('/deliver', { feed: ack.feed });
    for (;;) {
      const raw = await feed.next(), event = JSON.parse(raw);
      if (event.type === 'caught_up') {
        p.releasePending = true; await interrupted(() => api('/release?cut=1', { loadId: ctx.loadId })); p.ready(event); break;
      }
      p.receive(raw);
    }
  } finally { await feed.close(); }
  check('lost_release_reply_does_not_gate_complete_picture', true, p.query() !== null);
  check('replacement_waits_for_release_ack_without_allocating', { state: 'awaiting_release', allocations: 1 }, { state: await p.recover(api, load('replacement')), allocations });
  const release = JSON.parse((await api('/release', { loadId: ctx.loadId })).body); p.releasePending = false;
  check('release_retry_acknowledges_without_resurrection', { type: 'snapshot_released', loadId: ctx.loadId }, release);
  check('released_context_cannot_allocate_again', 409, (await api('/allocate', ctx)).status);
  await api('/clock', { tick: 60 }); await api('/prune', { through: 0 });
  check('expired_pruned_context_cannot_resurrect', { status: 409, allocations: 1 }, { status: (await api('/allocate', ctx)).status, allocations });
  const oldRun = load('old-run'); await api('/restart');
  check('old_run_context_cannot_allocate_after_restart', 409, (await api('/allocate', oldRun)).status);
  reset(); const waiting = new Picture(), abandoned = load('release-lost-until-expiry');
  await waiting.recover(api, abandoned);
  waiting.releasePending = true; await interrupted(() => api('/release?cut=1', { loadId: abandoned.loadId }));
  await api('/clock', { tick: 60 }); const replacement = load('after-expiry');
  check('replacement_after_lost_release_expiry_allocates_fresh_capture',
    { state: 'loading', capture: { loadId: 'after-expiry', N: 'c1', expiry: 110 }, allocations: 2, allocationAttempts: 2 },
    { state: await waiting.recover(api, replacement), capture: waiting.capture, allocations, allocationAttempts });
  check('fresh_capture_retry_does_not_inherit_expired_release_wait',
    { state: 'loading', capture: { loadId: 'after-expiry', N: 'c1', expiry: 110 }, allocations: 2, allocationAttempts: 3 },
    { state: await waiting.recover(api, replacement), capture: waiting.capture, allocations, allocationAttempts });
  await api('/release', { loadId: replacement.loadId });
}

async function recoveryCases() {
  reset(); const p = baseline(), old = p.subscribe(), generation = p.generation;
  await api('/write', { changes: [deletion('a', 2), image('b', 2, 'B-rebuilt')] });
  await api('/prune', { through: 2 });
  const replay = await api('/subscribe?from=c1');
  p.replayRefused(replay);
  check('expired_replay_immediately_invalidates_coverage_before_allocation', { status: 410, readable: false, allocations: 0 }, { status: replay.status, readable: p.query() !== null, allocations });
  const ctx = load('rebuild'); await p.recover(api, ctx);
  check('rebuild_stages_privately', null, p.query());
  p.page((await api(`/page?load=${ctx.loadId}&offset=0`)).body); p.page((await api(`/page?load=${ctx.loadId}&offset=2`)).body);
  const feed = openFeed(p.capture.N);
  try {
    const ack = JSON.parse(await feed.next()); p.H = ack.H; await api('/deliver', { feed: ack.feed }); p.ready(JSON.parse(await feed.next()));
    check('expired_replay_rebuild_publishes_new_generation_and_baseline', { resources: { b: [2, 'B-rebuilt'], c: [1, 'C0'], d: [1, 'D0'] }, cursor: 'c2', generation: generation + 1, journal: [], oldSubscription: [{ type: 'gap' }] },
      { resources: p.query().resources, cursor: p.applied, generation: p.generation, journal: p.journal, oldSubscription: p.drain(old) });
  } finally { await feed.close(); await api('/release', { loadId: ctx.loadId }); }
  reset(); const held = load('held'); await api('/allocate', held);
  const small = new Picture({ bytes: 64, changes: 1 }), candidate = load('too-small');
  const states = []; for (let i = 0; i < 5; i++) states.push(await small.recover(api, candidate));
  await api('/write', { changes: [image('a', 2, 'operational-write')] });
  const release = await api('/release', { loadId: held.loadId });
  check('capacity_refusal_pauses_without_allocation_churn_and_controls_work', { states: Array(5).fill('paused'), allocations: 1, allocationAttempts: 1, release: 200, head: 'c2', readable: false },
    { states, allocations, allocationAttempts, release: release.status, head: cursor(head()), readable: small.query() !== null });
  small.budget = { bytes: 65536, changes: 20 };
  check('capacity_change_explicit_retry_allocates_once', { state: 'loading', allocations: 2 }, { state: await small.recover(api, candidate, true), allocations });
  await api('/release', { loadId: candidate.loadId });
  const limited = baseline(); limited.budget = { bytes: 65536, changes: 1 }; const before = limited.effects();
  const message = json({ type: 'commit', dataset: 'D1', cursor: 'c2', changes: [image('a', 2, 'A2'), image('b', 2, 'B2')] });
  check('increased_message_requirements_pause_whole_commit', { rejection: 'capacity', unchanged: true, coverage: 'resource-limited' },
    { rejection: await refused(() => limited.receive(message)), unchanged: isDeepStrictEqual(before, limited.effects()), coverage: limited.coverage });
}

async function main() {
  must(Number(process.versions.node.split('.')[0]) === 24, 'requires_node24');
  directory = await mkdtemp(`${tmpdir()}/atlas-sync-`); db = new DatabaseSync(`${directory}/sync.sqlite`);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE metadata(seq INTEGER); INSERT INTO metadata VALUES(0); CREATE TABLE resources(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE commits(seq INTEGER PRIMARY KEY,data TEXT); CREATE TABLE captures(loadId TEXT PRIMARY KEY,n INTEGER,expiry INTEGER,facts TEXT,status TEXT); CREATE TABLE snapshot(loadId TEXT,id TEXT,data TEXT,PRIMARY KEY(loadId,id));');
  server = http.createServer((req, res) => { route(req, res).catch(error => { if (!res.headersSent) send(res, 500, { error: error.message }); else res.destroy(error); }); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); port = server.address().port;
  await atomicCases(); await handoff('fixed'); await handoff('move_h'); await handoff('live_pages'); await captureCases(); await recoveryCases();
}
try { await main(); }
catch (error) { check('unexpected_failure', 'none', error.stack); }
finally {
  try {
    for (const request of requests) request.destroy();
    if (server) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('server_cleanup_deadline')), 2000);
      server.close(error => { clearTimeout(timer); error ? reject(error) : resolve(); }); server.closeAllConnections();
    });
    must(sockets.size === 0 || [...sockets].every(s => s.destroyed), 'socket_cleanup');
    db?.close(); if (directory) { await rm(directory, { recursive: true }); await access(directory).then(() => fail('directory_survived'), error => must(error.code === 'ENOENT', error.message)); }
    const storageExists = directory ? await access(directory).then(() => true, error => { must(error.code === 'ENOENT', error.message); return false; }) : false;
    check('owned_http_sqlite_and_temp_storage_cleaned', { listening: false, liveSockets: 0, storageExists: false },
      { listening: server?.listening ?? false, liveSockets: [...sockets].filter(s => !s.destroyed).length, storageExists });
  } catch (error) { check('cleanup_failure', 'none', error.stack); }
}
process.stdout.write(json(report) + '\n');
process.exitCode = report.cases.every(c => c.passed) ? 0 : 1;
