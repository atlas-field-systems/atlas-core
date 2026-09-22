# Storage reassessment

Research record: historical evidence and proposals. Read the [status and decision pointers](README.md#status-and-authority) before using this report for successor planning.

- Review date: 2026-09-20
- Review timestamp: 2026-09-20T15:35:31-04:00
- Source: [Atlas-Modernization](https://github.com/the-Drunken-coder/Atlas-Modernization) at `8edee4e2743fbf0f85c16dfe638d9222141cf279`
- Scope: Atlas Core durable storage, change ordering and recovery, blob storage, backup/restore, and storage-facing SDK and former Plugin boundaries.

This is an outside recommendation against the immutable snapshot. It does not change the accepted architecture or claim benchmark results. The source has meaningful storage tests, but it does not have a sustained write benchmark or a filesystem-versus-object-store benchmark.

The first-version planning constraints are one Core server with field devices connecting to it, and permission to make breaking changes during extraction. The report does not assume a distributed deployment. The former Plugin shape is also open for reconsideration: a Plugin can become an internal Core module when its responsibilities and trust boundary fit there, and managed Plugin distribution or a separate Source Gateway process is optional. Source credentials still need explicit ownership and must not become generic storage state.
## Recommendation at a glance

Keep the current ordering, feed, object publication, and recovery semantics while extracting the system. Prototype two smaller deployment profiles before committing to a replacement:

1. PostgreSQL metadata with a filesystem blob adapter, retaining an S3-compatible adapter for deployments that need a separate object service.
2. A single-process Core using SQLite for metadata and a local content directory.

The first experiment tests whether MinIO justifies a second daemon, credentials, bucket bootstrapping and paired volumes. The source paired backup procedure is excluded from the successor. The SQLite experiment is worthwhile because the current change clock already serializes every versioned write, but it is a semantic rewrite, not a driver swap.

For this first-version deployment, keep PostgreSQL plus MinIO as the behavioral baseline, test PostgreSQL plus local files first, then test SQLite plus local files as a competing profile. Select one default after the workload and recovery gates; do not commit to three production profiles. The expected scale in the source is 10–20 Assets and low hundreds of Tracks, never thousands ([SDK README, lines 80–88](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-sdk/README.md#L80-L88)). That makes a simpler store plausible, but it does not prove that it is safe.

## What exists now

### Metadata and history

Core uses `pgx/v5` with a `pgxpool.Pool` and PostgreSQL 15. The direct Go storage dependencies are declared in [`services/core/go.mod`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L7-L21): `github.com/jackc/pgx/v5` for the database and `github.com/minio/minio-go/v7` for blob storage. The development and production Compose files pin PostgreSQL 15 and MinIO images and give each service its own volume ([development Compose, lines 74–153](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docker/docker-compose.yml#L74-L153), [production Compose, lines 73–147](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docker/docker-compose.production.yml#L73-L147)).

The baseline schema stores Entity, Task, and Object metadata in relational tables with validated JSONB blobs. Entity and Object identity, type, alias/path/content type, timestamps, and version are columns; components, references, and extension data remain in JSONB. Objects have a GIN `jsonb_path_ops` index over `json->'referenced_by'` ([schema DDL, lines 24–81](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/database/db.go#L24-L81)). The repository explicitly describes this as a flexible canonical blob with stable query fields promoted only when they stop changing frequently ([Entity storage guide, lines 1–16 and 108–125](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/entities.md#L1-L16)).

Movement history is the deliberate exception. Migration 10 stores samples in a normalized table with an identity sequence, entity creation identity, source/arrival/effective times, optional position/speed/altitude, uniqueness checks, retention indexes, and a 30-day pruning policy ([migration 10, lines 279–312](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/database/migrations.go#L279-L312), [movement guide, lines 219–221](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/entities.md#L219-L221)).

Schema changes are inline, ordered migrations with immutable checksums and schema fingerprints. Startup takes a PostgreSQL advisory transaction lock, verifies migration history and catalog drift, applies pending DDL in one transaction, and refuses unknown, gapped, modified, or drifted schemas ([migration definitions, lines 62–170](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/database/migrations.go#L62-L170), [migration execution, lines 346–425](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/database/migrations.go#L346-L425), [schema connection and reset, lines 268–309](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/database/db.go#L268-L309)).

### Global ordering and feed recovery

Every versioned mutation begins a transaction by locking the singleton `atlas_change_clock` row. It then reserves a contiguous version, mutates the resource, appends the complete feed event, and commits as one unit ([write-version helper, lines 12–53](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/write_version.go#L12-L53), [event recording, lines 178–247](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/change_hook.go#L178-L247)). `LISTEN/NOTIFY` carries only a wake-up. The dispatcher reads committed rows in version order and publishes them to the in-process hub ([dispatcher, lines 21–130](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/feed/dispatcher.go#L21-L130)). `GET /queries/changed-since` reads that same durable event table, bounded by a seven-day retention floor and an 8 MiB page limit ([change-feed contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-change-feed/README.md#L37-L69), [retention implementation, lines 12–90](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/change_retention.go#L12-L90)).

This is a strong semantic choice. A rejected transaction does not create a cursor gap, websocket and recovery use the same event envelope, and restart recovery is a database read. It also creates a known capacity ceiling. Entity check-ins, Task transitions, object writes, runtime registration, and other versioned writes all hold one row lock until commit. The repository has recorded this as an intentional design consequence, but the source snapshot contains no sustained writes-per-second measurement ([design decision, lines 3–10](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-06-10-global-write-version-lock.md#L3-L10)). Treat the ceiling as a design risk, not a measured failure.

### Blob storage and cross-store recovery

The storage client is a narrow wrapper around MinIO's S3-compatible API. It validates credentials, endpoint, bucket, and region; creates a bucket only in disposable mode; uploads with a content type; streams through `GetObject`; and deletes idempotently on missing keys ([storage client, lines 1–105](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/storage/storage.go#L1-L105), [object operations, lines 171–270](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/storage/storage.go#L171-L270)). Paths are unique, version-like keys of the form `objects/<object-id>/<unix-nanoseconds>`.

Upload is a two-phase protocol:

1. Core reserves the path, object identity, and a renewable five-minute upload intent in PostgreSQL.
2. It uploads bytes to MinIO while a heartbeat renews the intent.
3. A second transaction rechecks the object and deletion fence, writes metadata and a change event, removes the intent, and queues the previous blob for deletion.
4. If the process dies or metadata commit fails, recovery waits for lease expiry and orphan grace, checks whether the path became live, and queues only an unreferenced blob for deletion ([upload path, lines 194–350](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/object_upload.go#L194-L350), [intent recovery, lines 156–268](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/object_upload_intents.go#L156-L268)).

Object metadata deletion commits a durable outbox row with the metadata tombstone and event. A background reconciler claims rows with `FOR UPDATE SKIP LOCKED`, checks that no current metadata points at the path, retries deletion with bounded exponential backoff, and retains a completed row as a permanent path tombstone ([deletion outbox, lines 23–49 and 160–257](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/object_storage_deletions.go#L23-L49), [reconciliation, lines 270–320](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/object_storage_deletions.go#L270-L320), [object storage guide, lines 67–84](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/objects.md#L67-L84)).

Production startup refuses to create a missing bucket. PostgreSQL and MinIO are treated as one logical durable store. The runbook stops Core, creates a PostgreSQL custom dump, mirrors the full bucket, validates both under one backup-set ID, and restores both as a pair ([deployment runbook, lines 1–5 and 73–80](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/DEPLOYMENT_RUNBOOK.md#L1-L5), [backup procedure, lines 158–265](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/DEPLOYMENT_RUNBOOK.md#L158-L265), [restore procedure, lines 294–363](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/DEPLOYMENT_RUNBOOK.md#L294-L363)).

### SDK and Plugin storage boundary

The SDK cache is in-memory synchronization state, not a durable database or offline archive. Object bytes are cached by `(object_id, version)` with bounded eviction, while metadata and content are fetched through Core ([SDK README, lines 23–30 and 90–97](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-sdk/README.md#L23-L30)). The current Plugin contract does not permit direct Core database or storage access. Former Plugins can be internal modules in the first version when their source credentials and trust decisions remain owned by that module. Caches and temporary files are disposable, and persistent private state remains deferred until Atlas resources cannot represent a real requirement ([Plugin architecture, lines 266–266 and 432–432](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md#L266), [Plugin storage decision, lines 428–434](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md#L428-L434)).

Protocol intentionally has no storage dependency. Its boundary documentation excludes database tables, transactions, locks, pagination, storage wiring, and startup lifecycle, and says that importing a database driver would cross the boundary ([Protocol boundary, lines 30–35](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/README.md#L30-L35)). Keep that separation if metadata moves to SQLite or another store.

## Technology dispositions

The following table is a recommendation for the reassessment. It is not an accepted implementation decision.

| Direct technology or storage choice | Current role | Disposition | Reason and condition |
| --- | --- | --- | --- |
| PostgreSQL 15 | Metadata, constraints, transactions, migration ledger, global clock, event log, outbox/intents, movement history, admin records | Keep as baseline; compare local-files and SQLite profiles | PostgreSQL already expresses the hard invariants cleanly and has mature backup/PITR. SQLite may cut deployment cost for the one-server deployment, but replacing `FOR UPDATE`, advisory locks, `LISTEN/NOTIFY`, JSONB operators, `jsonb_to_recordset`, migration introspection, and pool behavior is a semantic rewrite. |
| `pgx/v5` and `pgxpool` | Go driver, pool, transactions, PostgreSQL-specific listener | Keep behind a database seam | It is a good Go/PostgreSQL fit and officially exposes PostgreSQL-specific features including pooling and LISTEN/NOTIFY. Do not spread `pgx.Tx` through every action if a database alternative remains plausible. |
| JSONB resource blobs | Extensible Entity/Object components and Task payloads | Keep with limits | PostgreSQL documents JSONB as decomposed binary data with index support. Keep the flexible blob, but promote fields only when query or integrity requirements justify it. Do not add a broad GIN index by default. |
| `jsonb_path_ops` reference index | Object `referenced_by` lookup | Keep; measure | The existing operator is a focused containment query and the index is justified. Confirm index size and query plans with realistic object counts before adding more JSON indexes. |
| `atlas_change_clock` singleton | One contiguous global cursor and serialization point | Keep semantics; prototype alternatives | This is the source of feed correctness. Measure before redesigning. If throughput becomes a problem, change the cursor contract deliberately rather than bypassing the lock. |
| `atlas_change_events` plus `LISTEN/NOTIFY` | Durable recovery log plus low-latency wake-up | Keep | Notifications remain hints; the durable row is authoritative. Poll-only is simpler, but the UI requirement for low-latency updates and the existing recovery contract justify the wake-up path. Move pruning out of the dispatcher if cleanup latency matters. |
| MinIO server | Local S3-compatible blob service | Prototype filesystem backend; keep S3 adapter | MinIO adds a daemon, credentials, bucket lifecycle, second durable volume, and paired backup/restore. A filesystem adapter may be enough for a single-host, low-volume deployment. Keep an S3-compatible adapter for remote buckets, shared storage, lifecycle policy, or future scale. |
| `minio-go/v7` | Go client for upload, stream, stat, delete, bucket operations | Keep behind object-store interface; consider AWS SDK v2 only with a provider requirement | The current interface is already narrow. Swapping clients without a provider need buys little. The MinIO Go API automatically uses single PUT below 16 MiB and multipart above it, so content-integrity and crash tests must cover both paths. |
| S3 object semantics | Durable bytes, object metadata, deletes, multipart behavior | Keep as an adapter contract, not as an assumption about ETags | AWS documents strong read-after-write for object PUT/DELETE, but concurrent writes are last-writer-wins and multipart ETags are not necessarily MD5. Store or verify an explicit checksum if integrity matters. |
| Docker Compose and paired external volumes | Single-host process orchestration and durable PostgreSQL/MinIO volumes | Defer | It is deployment machinery, not a domain storage choice. Keep for the current package until a filesystem or SQLite profile proves a smaller operator workflow. |
| `pg_dump`/`pg_restore` plus `mc mirror` | Historical manual paired backup and restore | Exclude | Atlas provides no backup or restore functionality. Test retained-state startup and Reset directly. |
| PostGIS | Not present; geometry is validated GeoJSON in JSONB | Defer | PostGIS would help indexed spatial predicates, but it adds an extension, SRID/type decisions, and migration/deployment cost. Current requirements describe storage and validation, not server-side spatial search. |
| SQLite | Not present | Competing profile after PostgreSQL plus filesystem gates | SQLite is attractive for one-server deployment, but it supports one writer per database and cannot supply PostgreSQL's server-level listener/advisory-lock behavior. Use a prototype to test the actual contract, not a library swap. |
| Plugin private persistence, managed Plugin distribution, and separate Source Gateway process | Explicitly absent or optional | Omit as separate storage/process concerns for first version; reevaluate as internal modules | Former Plugins do not justify a database or generic key-value store. A source-ingest responsibility can be a Core module when source credentials and trust are explicit there. Add separate packaging, process, or private persistence only for a demonstrated lifecycle, isolation, or deployment requirement. |

External references for this table are first-party documentation: [PostgreSQL JSONB](https://www.postgresql.org/docs/17/datatype-json.html), [PostgreSQL GIN and `jsonb_path_ops`](https://www.postgresql.org/docs/17/gin.html), [PostgreSQL advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS), [PostgreSQL asynchronous notification](https://www.postgresql.org/docs/17/libpq-notify.html), [PostgreSQL backup choices](https://www.postgresql.org/docs/17/backup.html), [pgx](https://github.com/jackc/pgx), [MinIO Go API](https://pkg.go.dev/github.com/minio/minio-go/v7), [MinIO lifecycle management](https://min.io/docs/minio/kubernetes/upstream/administration/object-management/object-lifecycle-management.html), and [MinIO versioning](https://min.io/docs/minio/kubernetes/upstream/administration/object-management/object-versioning.html).

## Design challenges and source tensions

### The global clock is both the best simplification and the largest ceiling

The old sequence-plus-post-commit approach was rejected because it burned versions on rollback and required skip bookkeeping. The current clock row makes the event log and recovery cursor simple and correct. It also means every versioned write waits on one row for the entire transaction. The source documents this consequence and includes lock-order tests, but no throughput benchmark. Do not describe the issue as a confirmed outage.

The measured question is not just writes per second. It is the combined rate of check-ins, movement samples, object metadata changes, Task lifecycle transitions, event-log reads, and feed fan-out at the expected deployment scale. A redesign that gives up contiguous global versions must replace the SDK's one-cursor recovery proof and the websocket barrier contract.

### The feed's source of truth is durable, but its maintenance lives in the delivery loop

The dispatcher drains events, prunes movement history, and prunes the seven-day change log in one LISTEN connection loop ([dispatcher, lines 78–104](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/feed/dispatcher.go#L78-L104)). A pruning failure can reconnect the feed, and slow cleanup can delay delivery. This is a structural issue recorded in the source's problem notes, not a benchmark. If the feed remains in Core, run cleanup in an independent bounded worker with its own retry policy.

### JSONB preserves change velocity but hides query costs

The Entity contract intentionally keeps components in JSONB and promotes only a few fields. This avoids a migration for every integration component, and PostgreSQL's JSONB operators and GIN indexes support targeted containment lookups. It does not make arbitrary geometry or component queries cheap. Current geofeature geometry is GeoJSON, and current movement history is normalized numeric columns. PostGIS is justified only if product queries need server-side intersection, distance, nearest-neighbor, or spatial indexing. Until then, adding it would move complexity into the database without a source requirement.

### Object metadata and bytes are one logical store but two commit systems

PostgreSQL can commit metadata and its event atomically. It cannot atomically commit a remote MinIO write in the same transaction. The upload intent, heartbeat, deletion fence, and outbox are a careful compensation protocol that is stronger than a naive two-phase attempt. A filesystem adapter would not make crashes disappear; it would replace HTTP/S3 failure modes with rename, fsync, disk-full and partial-copy failures. The right comparison is recovery proof and operator burden, not line count.

### Historical backup behavior

The runbook correctly quiesces Core before taking a PostgreSQL dump and mirroring MinIO, then restores both from one backup-set ID. PostgreSQL's official backup documentation distinguishes logical dumps, file-system backups, and continuous archiving/PITR. A `pg_dump` plus `mc mirror` pair is a valid small-deployment procedure when quiesced and verified, but it is not a transactionally atomic snapshot. This is historical source behavior. The successor excludes backup and restore functionality.

### ETags are not content hashes

Core exposes the object-store ETag in `ObjectInfo`, but the application uses the metadata `version` for object ETags and does not persist an application checksum. MinIO's Go client switches to multipart upload above 16 MiB; AWS documents that multipart ETags are not necessarily MD5. If the system needs end-to-end corruption detection, add a content checksum to the object metadata contract and verify it after upload and download. Do not silently treat ETag as a digest.

## Source decisions that a redesign must resolve explicitly

These are real tensions between the snapshot's accepted decisions and the simpler first-version constraint. They are recommendations for review, not silent replacements:

- The durable-storage decision treats PostgreSQL and MinIO as one paired production store, requires a pre-existing bucket, and rejects down migrations in favor of paired restore ([durable storage decision, lines 3–8](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-05-29-schema-evolution-without-migrations.md#L3-L8)). Successor storage profiles instead follow ADR-0015: retain same-release state, initialize empty storage on first use, and Reset on release updates. They do not implement the source backup or migration workflow.
- The global-clock and feed decisions require one transactional PostgreSQL cursor and database-backed recovery ([global clock decision, lines 3–7](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-06-10-global-write-version-lock.md#L3-L7), [feed decision, lines 3–7](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-06-12-change-feed-websocket-fat-events.md#L3-L7)). SQLite can preserve the cursor semantics, but only through a new single-process writer and notification design.
- The current Plugin release decision requires an independently signed catalog, host-side installation, and fixed Core and Source Gateway origins ([independent Plugin release decision, lines 3–6](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-09-01-plugins-release-independently-from-atlas-core.md#L3-L6)). The first-version recommendation allows former Plugins to become internal modules and omits those separate processes when no isolation or lifecycle requirement justifies them. This needs an explicit product and trust-boundary decision before implementation.

## Alternatives and failure semantics

| Alternative | What gets simpler | Failure semantics that must be rebuilt | Cost and fit |
| --- | --- | --- | --- |
| Keep PostgreSQL + MinIO | Retains the source storage engines; adapt tests and runbook to the accepted lifecycle | Two-store crash windows, one global write lock and MinIO service availability remain; source backup/restore is excluded | Highest operator footprint, lowest semantic risk. Fits current source and expected scale. |
| PostgreSQL + local filesystem blobs | Removes MinIO daemon, bucket credentials, bucket init, and S3 endpoint from a single-host profile | Must use unique paths, atomic publish, durable intent/outbox rows, fsync policy, disk-full handling, concurrent read/delete behavior, and retained-state startup and Reset cleanup. A file can exist without metadata and vice versa. | Best first simplification experiment. Keeps PostgreSQL's transaction/feed contract. |
| SQLite + local filesystem | One Core process, one metadata file, one blob root, fewer services and simpler local storage | One writer per database; no PostgreSQL `LISTEN/NOTIFY` or advisory locks; schema initialization and validation change; event-feed wake-up must be in-process or polling; retention and Reset must cover WAL and blob root; multiple Core processes must be prohibited | Potentially simplest operator package at current scale. Highest semantic rewrite risk. |
| SQLite + S3-compatible blobs | Removes PostgreSQL service but keeps remote blob durability | All SQLite changes above plus the existing cross-store upload/recovery protocol | Only makes sense when remote object storage is required but PostgreSQL is operationally unacceptable. |
| PostgreSQL + PostGIS | Indexed spatial predicates and server-side geometry operations | Extension availability, SRID and geometry/geography policy, fresh initialization and retained-state validation, and new query semantics | Defer until a measured spatial query requirement exists. |
| Poll-only durable change feed | Removes dedicated `LISTEN/NOTIFY` connection and dispatcher wake-up | Adds update latency or polling load and requires explicit client cadence; current UI low-latency rationale would change | Valid fallback if live updates stop mattering. Do not adopt silently. |

Official comparison sources: [SQLite transaction concurrency](https://www.sqlite.org/lang_transaction.html), [SQLite WAL](https://www.sqlite.org/wal.html), [SQLite intended use](https://www.sqlite.org/whentouse.html), [Amazon S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html), [S3 upload integrity and ETags](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html), and [PostGIS geometry versus geography](https://postgis.net/documentation/faq/geometry-or-geography/).

## Behavioral invariants to preserve

These successor requirements follow the accepted [lifecycle](../../adr/0015-separate-start-stop-restart-and-reset.md), independent of the selected database or content backend:

- Commit resource changes consistently with their published records. Rejected transactions publish no mutation.
- Supported synchronization must handle snapshot/write races, missed changes and reconnects without exposing stale resource state. Cursor and ordering mechanisms remain implementation choices.
- Retain Task records, Object metadata/content, histories, Plugin Operation records and logs across ordinary Stop/Start and Restart. Retaining a record does not automatically resume its execution.
- Publish an Object only when its required content is usable. Protect content still referenced by retained metadata from cleanup and prevent replacement/delete races from removing the current content.
- The 22 September upload simplification supersedes the earlier same-run resume and partial-transfer retention requirements. Retry interrupted uploads from the beginning, clean temporary staging and retain successful upload identities with completed Objects until Reset. See [ADR-0009](../../adr/0009-expose-objects-only-when-ready.md#upload-failures-and-retries).
- Prevent stale references or clients from restoring cleared data after Reset. A permanent never-reused-path scheme is a historical implementation mechanism, not an accepted public storage contract.
- Reset clears operational metadata, content, activity history, transfer/sync state and Atlas-managed diagnostic logs. Installed selections, credentials, configuration, software and Plugin artifacts survive.
- Start validates the availability of retained metadata and content; it must not silently expose unusable Objects. The number of stores remains undecided; backup and restore functionality is excluded.
- SDK caches remain projections. Plugins use SDK/Core APIs, not private storage. Preserve public geometry, movement and observation-time meanings when changing internal layout.

Backup and restore functionality is excluded. The old deletion outbox remains a historical mechanism to evaluate against actual consistency requirements. Updates to a new Core release perform Reset; operational-data migrations are excluded.

## Prioritized experiments and acceptance gates

### P0: Establish a real baseline before changing the seam

Run the current required live transaction and storage-recovery suites from the immutable source, then add a repeatable workload harness that mixes:

- Asset check-ins and movement history at the expected deployment scale.
- Entity/Object updates and deletes.
- Task creation and lifecycle transitions.
- Concurrent object uploads, replacement, delete, and retry.
- One feed receiver with reconnects, intentional dropped notifications, and `changed-since` recovery.

Record transactions per second, p50/p95/p99 write latency, clock-lock wait, event-log growth, dispatcher lag, storage bytes, failed operations, and recovery time. This is the first benchmark. The existing lock and race tests are correctness evidence, not throughput evidence.

Acceptance: no lost or duplicate committed events; no version gaps after successful transactions; no object path resurrection; all existing focused tests pass; the report includes raw workload settings and results.

### P1: PostgreSQL plus filesystem blob adapter

Implement only in a throwaway prototype or isolated branch. Reuse the current `objectStorage` interface ([object storage contract, lines 10–16](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/object_storage_contract.go#L10-L16)). Use a per-object immutable path, write to a temporary file in the same filesystem, fsync, atomically rename, and fsync the directory where the platform requires it. Keep upload intents, deletion fences, and the outbox until crash testing proves a smaller protocol.

Acceptance: inject disk-full, permission, delayed read, delayed rename and deletion failures; run concurrent readers and replacements; verify that published Objects remain usable. Test Stop/Start and Restart retention, then Reset cleanup with setup and artifacts preserved. Check content integrity and publication consistency. Interruptions must produce explicit outcomes rather than false completion. Do not make backup restoration or automatic execution recovery an acceptance requirement.

### P1: Explicit object integrity

Add a prototype-only checksum path using a standard full-object checksum, independent of ETag. Exercise small single PUT and large multipart upload, interrupted upload, download verification, and metadata-only update. MinIO's API documents automatic multipart behavior and AWS documents ETag limitations.

Acceptance: a modified or truncated blob is detected before Core returns success to a caller; the recovery path can delete or quarantine an unreferenced corrupt blob; the prototype does not silently make a checksum field or a migration strategy part of the public contract.

### P2: SQLite metadata prototype

Port only enough of the current contract to run the P0 workload. Start with a single Core process and one writer coordinator. Replace PostgreSQL-only SQL intentionally: row locks, advisory locks, JSONB operators, `jsonb_to_recordset`, `LISTEN/NOTIFY`, migration catalog introspection, `FOR UPDATE SKIP LOCKED`, timestamp intervals, and `infinity` timestamps all require decisions. If testing SQLite WAL, account for its storage files in retention and Reset tests. Do not add the Online Backup API or restore tooling.

Acceptance: one process is enforced; two simultaneous Core processes fail closed; retained metadata/content remain coherent through ordinary Stop/Start and Restart and Reset clears the operational stores/logs while preserving setup; p99 latency is no worse than the P0 baseline at expected scale; WAL checkpoint starvation and disk-full behavior are bounded; no PostgreSQL-only semantic leak remains in the adapter.

### P2: Cleanup isolation

Move movement-history pruning and change-log pruning out of the feed delivery loop in a prototype. Keep cleanup bounded, independently retried, observable, and unable to make the websocket dispatcher reconnect.

Acceptance: injected prune failures leave feed delivery running; cleanup catches up after recovery; event dispatch lag is unchanged within the agreed budget; cursor expiry still reports the correct floor.

### P3: Spatial query decision

Gather actual server-side spatial queries from the operator interface and Plugins. If the workload is only point/GeoJSON storage and client rendering, keep JSONB. If it needs intersection, distance, nearest-neighbor, or large-scale bounding-box filtering, benchmark PostGIS `geometry` with an explicit SRID against the current read path. Do not introduce `geography` by default; PostGIS documents its convenience for global coordinates but higher computational cost and a smaller function set than `geometry`.

Acceptance: a query plan and dataset size justify the extension; fresh initialization, same-release retained startup and release Reset remain deterministic; the chosen geometry/geography representation is documented, with public geometry semantics covered by Protocol tests; no API wire shape changes without an explicit protocol decision.

## Unknowns

- No sustained current-store throughput or lock-wait benchmark exists in the snapshot. The global clock may be entirely adequate at expected scale, but that is not proven.
- The one-server field-device deployment is accepted for the first version, but the number of Core processes on that server and the operator's recovery budget are not specified. Those facts decide how attractive SQLite is.
- No requirement says blobs need remote access, lifecycle expiration, versioning, object lock, erasure coding, or cloud-provider portability. Those facts decide whether MinIO or S3 is buying enough.
- The source pins an older MinIO image release. Upgrade compatibility, security posture, and backup format behavior were not evaluated here.
- Upload integrity relies on the storage client's reported size and ETag; the application checksum policy is unspecified.
- The bounded seven-day change log and permanent path tombstones have different growth and retention policies. Long-running deployments need a measured storage-growth budget.
- Backup/restore is a quiesced manual pair procedure. RPO/RTO, off-host backup replication, encryption at rest, and disaster recovery drills are not specified.
- PostGIS is absent, and no server-side geometry query requirement was found. Whether a Plugin will need spatial joins is unknown.
- The current migration fingerprint intentionally inspects PostgreSQL catalog details. A replacement database would need a new drift and adoption model, not just translated DDL.
- The SDK's content cache is bounded in memory and verifies metadata version after download, but it does not provide an offline durable blob cache. That appears intentional and should stay explicit.

## Recommendation

The current design has unusually good failure semantics for a greenfield two-store system. Its complexity is concentrated in PostgreSQL's global write clock and the cross-store blob recovery protocol. Preserve those semantics while extracting, establish the PostgreSQL plus MinIO baseline, and test PostgreSQL plus local files before the competing SQLite plus local-files profile. Select one first-version stack after the workload, interrupted-write, lifecycle and credential-boundary gates. Keep PostGIS, managed Plugin distribution, a separate Source Gateway process, and Plugin private persistence out until real requirements justify them.
