# Atlas Core runtime reassessment

Current lifecycle contract: [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md) supersedes wipe-on-start. Start, Stop and Restart retain operational data and logs; Reset clears them while keeping setup and installed artifacts. Updates to a new Core release perform Reset; operational-data migrations are excluded. Backup and restore functionality is excluded. Source observations below describe the inspected historical implementation; successor recommendations remain provisional unless backed by an accepted decision.


Research date: 2026-09-20
Research timestamp: 2026-09-20T15:35:31-04:00

Status: provisional research, based on the verified source checkout at `8edee4e2743fbf0f85c16dfe638d9222141cf279`. These recommendations are options for the reassessment, not accepted design decisions.

The first version is one server with field devices connecting to it. Breaking changes are acceptable when they make the system easier to understand. Third-party identity is not a requirement. Plugin deployment and trust are still open questions, so this note treats a modular monolith as the organizing hypothesis and treats process isolation as a capability to earn later.

## What Core is today

Core is a Go HTTP service with a small number of long lived background loops. Startup loads and validates configuration, opens PostgreSQL, ensures the schema, initializes optional object storage, builds the feed and task services, and starts the plugin registry. The server sets bounded HTTP read, write, header, and idle timeouts. Shutdown cancels the runtime context, asks `http.Server` to drain for ten seconds, and closes the feed hub. The wiring is visible in [`main.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/cmd/atlas_core/main.go#L92-L101), [`main.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/cmd/atlas_core/main.go#L204-L241), and [`main.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/cmd/atlas_core/main.go#L306-L346).

The request path is already divided into useful layers:

- `cmd/atlas_core` owns process lifecycle and route assembly.
- API handlers decode protocol requests, apply body and conditional-request rules, and call actions.
- `internal/actions` owns transactions and domain orchestration.
- `internal/database` owns PostgreSQL setup and migrations.
- `internal/feed` owns the durable change-log tailer, WebSocket hub, and frame protocol.
- `internal/plugins` owns the private Plugin HTTP client and its manifest, health, admission, timeout, and failure state.
- `internal/admin` owns browser sessions, login throttling, password hashing, and managed API keys.
- `internal/sourcegateway` is a separate connector boundary with its own SSRF and egress policy.

That is a reasonable modular-monolith shape for the one-server version. The current package boundaries are not all deep modules yet. `internal/actions` is 33 production files and about 6,377 lines, spanning entities, objects, tasks, movement history, cursor pagination, JSON blobs, and the change log. A feed retention path constructs an `EntityActions` value only to call movement pruning, which is a concrete sign that the change-log and retention seam is misplaced. The existing problem note identifies the same seam and also points out the size of the package: [`actions-god-package.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-18-actions-god-package.md#L1-L15). This is structural complexity worth reducing, not evidence that every action should become a service or repository interface.

The long lived work has real reasons to exist. The feed dispatcher uses PostgreSQL `LISTEN/NOTIFY` only as a wakeup, then reads the durable change log in version order and advances a cursor. The hub has bounded client buffers and disconnects slow consumers. The plugin registry has one monitor per configured plugin, a bounded per-plugin in-flight semaphore, context deadlines, and a stable transport/application failure split. Immediate task expiry is reconciled at startup and once per second. These are reliability guarantees for a field-device control plane, not accidental framework ceremony. See [`dispatcher.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/feed/dispatcher.go#L21-L131), [`hub.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/feed/hub.go#L22-L72), [`registry.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/plugins/registry.go#L155-L273), and [`task_runtime.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/task_runtime.go#L519-L578).

## Go versus TypeScript and Node

Keep Core in Go for the first server. The question is not whether Node can serve these routes. It can. Node's HTTP API is deliberately low level, exposes stream and header parsing, and carries abort state on the request; a Node implementation could reproduce the HTTP boundary with a web framework and an external WebSocket package. The current Node documentation describes the low-level shape in [`node:http`](https://nodejs.org/api/http.html). The issue is the amount of policy that would have to be rebuilt around it: PostgreSQL transactions and advisory locks, durable change-feed wakeups, bounded goroutine-like workers, Argon2id login work, field-runtime fencing, and cancellation through every layer.

Go's standard context model already carries deadlines and cancellation across these boundaries and is safe to pass between goroutines when used as intended. See the [official `context` package documentation](https://pkg.go.dev/context). The current implementation uses that model in handlers, private Plugin calls, feed loops, and task reconciliation. Moving the service to Node would trade goroutine and context rules for Promise and `AbortSignal` rules, plus a new decision about worker threads or processes for password hashing and other CPU-bound work. Sharing TypeScript could reduce some authored type duplication, but the external validation and client contracts would still need an owner. That benefit needs a concrete generation comparison.

The credible Node alternative is therefore a rewrite project, not a local simplification. It becomes attractive only if one of these constraints changes: the service must share a large TypeScript domain implementation with the browser, the team cannot maintain Go, or deployment standardizes on a Node-only runtime. None is established here. A focused TypeScript service experiment would need to implement one transaction-heavy task lifecycle, one feed reconnect path, and one login benchmark before any migration decision. Its acceptance gate should compare source size, failure behavior, cancellation tests, memory under concurrent Argon2 logins, and operational shutdown behavior against the Go implementation. Do not pay the migration cost to remove a router or logger dependency.

## HTTP, WebSocket, and cancellation boundaries

### HTTP routing

The service uses `chi` for method/path routing and standard `net/http` handlers, plus middleware for request IDs, recovery, compression, CORS, and authentication. This is a coherent choice. `chi` is small and composes with the standard handler interface; its [official README](https://github.com/go-chi/chi) describes that design.

Go 1.22 and later made `http.ServeMux` materially more capable: method patterns, wildcard path segments, and `Request.PathValue` are now built in. The [Go 1.22 release notes](https://go.dev/doc/go1.22) and the [routing enhancements article](https://go.dev/blog/routing-enhancements) document the change. Core's entity and task paths could be expressed with those patterns. A router replacement is still not automatically simpler because the current value of `chi` is also its route grouping and middleware composition, and the service is already on Go 1.26.

The better first experiment is to separate authentication policy from route path strings, then decide whether `ServeMux` is sufficient. `CombinedAuth` currently has explicit text exceptions for public paths, `/feed`, logout, API-key management, and a special resources path. The feed handler then authenticates again because the WebSocket client sends its credential in the first frame. The source problem note correctly calls this a maintainability risk while recording that the current deny-by-default behavior is sound: [`auth-scattered-route-rules.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-18-auth-scattered-route-rules.md#L1-L9). A route-group policy such as public, browser session, API credential, and feed handshake would make the boundary legible without changing the authorization model.

### CORS

`go-chi/cors` is only the header and preflight adapter. Core's configuration layer already owns the security decision by validating full `http` and `https` origins, allowing one leftmost-label wildcard under an effective top-level domain, and rejecting unsafe patterns. The adapter's [source](https://github.com/go-chi/cors/blob/master/cors.go) confirms that its role is standard-handler CORS processing and an optional custom origin function.

There is a plausible dependency-reduction experiment: replace this adapter with a small local middleware that calls the existing validated-origin function. It should be considered only after the route policy experiment, since both changes touch preflight behavior. Acceptance requires exact-origin and wildcard tests, credentialed requests, `Vary` behavior, rejected origins, OPTIONS behavior, and browser compatibility against the current test corpus. Do not weaken origin validation to make the middleware smaller.

### WebSocket

Keep `github.com/coder/websocket`. The feed needs a server-side handshake, first-frame authentication, origin checks, concurrent read and write loops, bounded writes, keepalive pings, close handling, and cancellation when the HTTP request ends. `coder/websocket` is a small, context-aware implementation with concurrent-write support and compression options; its [official README](https://github.com/coder/websocket) also identifies the older `x/net/websocket` package as deprecated. There is no standard-library WebSocket server to substitute here.

The HTTP and WebSocket boundary is intentionally asymmetric. HTTP middleware can authenticate from a header or cookie before invoking a handler. A WebSocket client has to complete a protocol handshake before the server can authorize subscriptions, so `/feed` bypasses the global middleware and performs its own handshake. That is necessary. The accidental part is that `handler_feed.go` mutates `ServerConfig.EnableAPIAuth` to mean both “this server requires a key” and “this connection already authenticated,” then the feed server interprets the same flag. The source note records that the behavior is currently sound but the state model is confusing: [`handler_feed.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/api/handlers/handler_feed.go#L15-L79) and [`feed-config-mutation-auth-flag.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-18-feed-config-mutation-auth-flag.md#L1-L15).

The narrow fix to evaluate is an explicit per-connection authentication result passed into the feed server. It should preserve the two modes: static API-key validation in the handshake and a preauthenticated HTTP request that skips the first-frame key. The acceptance gate is a matrix covering API auth enabled and disabled, valid and invalid first frames, session auth, origin failures, missing origin, subscribe and barrier frames, disconnect cancellation, and slow-client eviction. This is a good candidate for a breaking internal API change because it removes mutable configuration state without changing the public protocol.

## Authentication and access control

Core owns operator and machine authentication. The design decision deliberately keeps it deployable without Cloudflare or another identity vendor: [`core-owned-operator-auth.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-07-04-core-owned-operator-auth.md#L1-L15). That remains the right first-version constraint when one Core serves field devices.

There are three credential shapes:

1. An admin password creates a browser session cookie. Login is throttled durably by user and client IP, unknown users take the dummy-hash path, Argon2id work is limited by a four-slot semaphore, and cookies are Secure, HttpOnly, and SameSite-configured. The implementation is in [`admin.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/admin/admin.go#L169-L305).
2. A bootstrap API key authenticates machine requests. Configuration rejects weak or placeholder values. This key is a deployment credential, not an operator identity.
3. Managed API keys are generated once, stored only as SHA-256 hashes, returned once at creation, and revocable. Their admin routes require a browser session, so a machine key cannot mint more machine keys. See [`api_keys.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/admin/api_keys.go#L57-L195) and [`handler_admin_api_keys.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/api/handlers/handler_admin_api_keys.go#L30-L107).

The current access model is intentionally coarse: any valid API credential can mutate any Asset. `Atlas-Runtime-ID` is execution fencing. It proves that a request claims to come from the currently registered runtime, but it is not a credential and is not Asset authorization. The tasking implementation plan says this explicitly and defers per-Asset authorization: [`commands-and-tasking-implementation-plan.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking-implementation-plan.md#L117-L121).

That is acceptable for the first one-server deployment if the deployment boundary is trusted. It becomes the wrong model when multiple operators, tenants, or independently administered field groups share one Core. Reopening it would require a system-wide subject and scope model across ordinary HTTP, feed snapshots and subscriptions, task creation and cancellation, runtime registration, SDK cache hydration, and object access. It should not be added as a middleware-only patch. Third-party auth is not needed to make that change; Core could issue and validate its own subjects first.

One exact decision is worth reopening now because it affects auditability even under the coarse model: Tasks intentionally do not record which operator or client created or cancelled them. The Protocol says so at rule 10 ([`commands-and-tasking.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L37-L49)) and lists fine-grained tasking provenance as deferred ([`commands-and-tasking.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L680-L693)). Provenance is not the same as authorization. A minimal `created_by` and `cancelled_by` subject reference could improve incident reconstruction without introducing per-Asset permissions. The tradeoff is schema and retention work, anonymous device clients, and a decision about whether a deployment key is a useful actor identity. The smallest experiment is an audit-only field in a fixture or local branch, with acceptance based on operator reconstruction of a task race and no change to authorization.

The existing error contract has a related boundary smell. Some client behavior matches exact human-readable error text across Go and TypeScript. A stable machine-readable error code would make the protocol less fragile. This is a contract change, so it belongs in the Protocol review rather than a local handler cleanup. The source lead is [`error-matching-by-message.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-18-error-matching-by-message.md#L1-L17).

## Tasks, concurrency, and cancellation

The task runtime machinery is complex because it is implementing safety and recovery guarantees:

- registering a new runtime fences the previous generation and drains stale work in committed batches;
- readiness is rejected until the stale nonterminal set is gone and the new manifest validates;
- task transitions lock the global change clock and then the task/runtime rows in a documented order;
- delivery is runtime-scoped and checks readiness, manifest support, and queued versus immediate ordering;
- timeout reconciliation is bounded to 100 rows per pass and runs at startup and once per second;
- the first valid terminal transition wins, while an exact retry is idempotent;
- request cancellation stops private Plugin calls and feed loops at context boundaries.

Those guarantees are appropriate for a field device that can disappear, restart, reconnect, or report an ambiguous HTTP result. The transition code documents the lock order and immutable runtime binding: [`task_transition.go`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/task_transition.go#L257-L324). Removing the reconciler or replacing it with a queue would simplify the code while weakening restart behavior and durable recovery.

The accidental complexity is concentrated in ownership and evidence:

- production exposes an empty command catalog, so roughly 1,460 lines of task and runtime machinery are exercised mainly by fixture catalogs and conformance tests. Before adding more tasking machinery, prove one real command end to end with a real field-device runtime;
- the task module contains persistence, lifecycle, delivery selection, runtime registration, and timeout work. It is acceptable as one concrete module while the catalog is empty, but its tests should establish seams before extraction;
- task cancellation describes Core intent, not proof that a physical action stopped. That distinction is correct and should remain visible in API wording;
- the current one-second scheduler is easy to reason about, but the process has several independently managed loops. Shutdown currently cancels and closes resources but does not visibly wait for every background goroutine to report completion. Treat that as an experiment target, not a confirmed leak.

A focused lifecycle experiment could add explicit wait accounting around feed, plugin-monitor, storage-reconciler, and task-reconciler goroutines. Acceptance should include shutdown under an active database outage, blocked Plugin request, slow WebSocket writer, and in-flight task transaction, with race detection and a bounded shutdown time. An `errgroup` is not automatically better than a small `WaitGroup`; choose the smallest mechanism that makes ownership observable.

## Plugins and the modular-monolith hypothesis

The current Plugin design deliberately moves a lot of machinery into Core: configured origins, fixed private routes, manifest validation, health monitoring, response caps, per-plugin admission, timeouts, cancellation, and stable public error categories. The original decisions explain why arbitrary public Plugin routes and Docker control were rejected: [`core-owns-plugin-http-interface.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-08-24-core-owns-plugin-http-interface.md#L1-L11) and [`core-connects-to-configured-plugins-over-http.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-08-25-core-connects-to-configured-plugins-over-http.md#L1-L11).

For the first version, those boundaries may be solving a deployment problem before the product has one. A simpler organizing hypothesis is:

- Core is a modular monolith with explicit internal modules for feed, tasking, source connectors, and future capabilities;
- each module owns its domain rules and exposes a narrow code interface to neighboring modules; Go interfaces apply only to the Go candidate;
- a module is not automatically a process, network client, or independently versioned package;
- a capability moves outside the process only when it needs fault containment, a separate credential boundary, a separate release cadence, a hostile dependency, or an operational scale profile that the monolith cannot safely carry.

That earlier placement hypothesis does not reopen accepted Core-managed Plugins. The current design retains dedicated internal modules alongside removable, trusted user-built Plugins. Core owns installed Plugin lifecycle; process/container and discovery mechanisms remain implementation choices. Startup preserves and reapplies installed Plugin selections, credentials and configuration and keeps Plugin artifacts. Start, Stop and Restart preserve operational data and logs. Reset clears operational records, content and Atlas-managed logs while keeping setup and artifacts. See [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md).

The narrow experiment is to implement one representative former Plugin capability as an internal module behind the same domain interface, without deleting the external adapter. Compare:

- startup and failure behavior when the capability is unavailable;
- cancellation and admission behavior under concurrent calls;
- test setup and source size;
- credential and egress boundaries;
- whether a crashed capability must take down Core;
- whether independent release is a real requirement.

If the experiment shows that the capability needs a separate crash or credential boundary, keep the private HTTP adapter. If it does not, internalize the capability and remove only the unused deployment machinery. The acceptance gate is a written failure matrix, a bounded-call test, a shutdown test, and an operator workflow that can explain availability without reading private Plugin URLs. This keeps modularity while avoiding a process boundary that has no earned purpose.

## Direct dependency dispositions

The complete direct list is in [`services/core/go.mod`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L7-L21). `pgx` and MinIO are included for completeness; storage owns their deeper evaluation. The standard-library alternatives below are assessed as runtime choices, not as a request to replace dependencies immediately.

| Dependency | Current responsibility | Standard-library alternative | Provisional disposition |
| --- | --- | --- | --- |
| [`github.com/coder/websocket`](https://github.com/coder/websocket) | Feed handshake, frames, ping/pong, close, concurrent writes | None in `net/http`; a raw upgrade implementation would be a new protocol stack | Keep. There is no standard-library server replacement. |
| [`github.com/go-chi/chi/v5`](https://github.com/go-chi/chi) | HTTP method/path routing and middleware composition | Go 1.22+ `http.ServeMux` supports methods, wildcards, and `PathValue` | Keep for now. Run a `ServeMux` route diff only if dependency count or route grouping becomes a real cost. |
| [`github.com/go-chi/cors`](https://github.com/go-chi/cors) | CORS headers and preflight adapter | `net/http` makes a small local middleware easy | Keep for now. A local adapter is a low-risk experiment after auth route grouping. |
| [`github.com/google/uuid`](https://pkg.go.dev/github.com/google/uuid) | Random UUID strings and database IDs in task, upload, and movement paths | `crypto/rand` plus a small UUID formatter | Keep unless dependency minimization is a stated goal. A helper removes little complexity and does not change the PostgreSQL UUID contract. |
| [`github.com/jackc/pgx/v5`](https://github.com/jackc/pgx) | PostgreSQL pool, transactions, advisory locks, and `LISTEN/NOTIFY` | `database/sql` still needs a driver and loses direct PostgreSQL APIs | Keep. Core relies on PostgreSQL-specific behavior, including `WaitForNotification` and transaction locking. |
| [`github.com/minio/minio-go/v7`](https://github.com/minio/minio-go) | S3-compatible object storage | `net/http` can issue S3 requests manually, with signing and retries to own | Keep at the storage boundary; do not replace as part of a runtime cleanup. |
| [`github.com/rs/zerolog`](https://github.com/rs/zerolog) | Structured JSON logs, context logger, fluent fields, and package-level logging | Go 1.21+ `log/slog` | Candidate for a mechanical `log/slog` experiment. Do not mix it with route or auth changes. |
| [`github.com/the-drunken-coder/atlas/packages/protocol`](https://github.com/the-Drunken-coder/Atlas-Modernization/tree/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol) | Local generated protocol and validators | No standard-library replacement; this is application contract code | Keep. This is an internal contract boundary, not replaceable infrastructure. |
| [`golang.org/x/crypto`](https://pkg.go.dev/golang.org/x/crypto) | Argon2id password hashing | No Argon2id implementation in the standard library | Keep. Replacing it with a weaker standard primitive would not preserve the password guarantee. |
| [`golang.org/x/net`](https://pkg.go.dev/golang.org/x/net) | IDNA, public-suffix checks, and HTTP header validation | `net/url` and `net/http` cover syntax, not these policy/data checks | Keep. These are security and Unicode policy dependencies, not convenience helpers. |
| [`golang.org/x/text`](https://pkg.go.dev/golang.org/x/text) | Unicode-aware lower casing for plugin hostname validation | `strings.ToLower` is not equivalent for Unicode policy | Keep while internationalized hostnames are accepted. Remove only if configuration is intentionally restricted to ASCII and the contract says so. |

The indirect dependencies are mostly transitive implementation details of pgx, MinIO, the WebSocket stack, and the local protocol generator. They should be revisited only after a direct dependency is removed and `go mod tidy` shows which transitive graph actually disappears.

### Logging: zerolog versus slog

Go has shipped structured [`log/slog`](https://go.dev/blog/slog) since Go 1.21. It would remove one direct dependency and standardize logging APIs, but the current code uses zerolog values in handler and service structs, context injection, fluent `Warn().Err().Msg` calls, formatted messages, interfaces, and package-level helpers. A slog migration is therefore a broad mechanical change, not a cleanup hidden behind one import.

The narrow experiment should port one vertical slice, preferably middleware plus one handler and one background loop. Acceptance is equivalent JSON field names and levels, request IDs, error causes, no credential leakage, comparable allocations in a representative request, and passing log assertions. Keep zerolog if the experiment cannot preserve those properties without a compatibility wrapper. A wrapper would retain the complexity the migration was meant to remove.

### Password hashing and Unicode helpers

Keep `x/crypto/argon2`, `x/net`, and `x/text`. The official Argon2 package documents Argon2id and memory-hard parameters in [`golang.org/x/crypto/argon2`](https://pkg.go.dev/golang.org/x/crypto/argon2). Core currently uses 19 MiB per hash, two iterations, one lane, and a four-slot semaphore. That is an operational choice, not proof that the parameters are optimal. A separate login benchmark should measure memory, latency, and failure behavior at the expected field deployment size before changing it.

`idna`, `publicsuffix`, `httpguts`, and Unicode case mapping sit on origin, SSRF, header, and hostname boundaries. Replacing them with hand-written checks would create security surface area. They should leave the dependency list only if the configuration contract is narrowed and the corresponding boundary is removed.

## Decisions worth reopening now

These are the highest-value provisional questions, ordered by likely simplification:

1. **Plugin process boundary.** Test one capability as an internal module. Keep external HTTP as an adapter only where crash, credential, trust, release, or scale isolation earns it.
2. **Feed authentication state.** Replace mutable `EnableAPIAuth` mode switching with an explicit authenticated-connection value. Preserve the custom first-frame handshake.
3. **Route authorization shape.** Group routes by auth requirement and make the route matrix executable. Then decide whether `ServeMux` removes enough dependency and grouping complexity to justify a router migration.
4. **Task provenance.** Decide whether an actor reference for creation and cancellation is more valuable than the schema and retention cost. This is distinct from per-Asset authorization.
5. **Task production evidence.** Keep the empty catalog boundary, but require one real Command and field-runtime path before adding more tasking features. The implementation plan explicitly says the production catalog starts empty and fixtures exercise the machinery: [`commands-and-tasking-implementation-plan.md`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking-implementation-plan.md#L188-L190).
6. **Logger.** Run the isolated zerolog to slog experiment if standard-library consolidation matters. Do not make it a prerequisite for the runtime redesign.
7. **Actions seams.** Extract change-log and retention ownership first if the package continues to grow. Avoid splitting concrete domain actions into interfaces until a consumer or test proves the seam.

The following are not good candidates to reopen merely for simplicity: Go itself, context cancellation, PostgreSQL-specific pgx, Argon2id, WebSocket support, durable feed ordering, runtime generation fencing, bounded task reconciliation, or origin validation. They encode the guarantees that make a disconnected field-device system operable.

## Narrow experiments and gates

| Experiment | Scope | Acceptance gate |
| --- | --- | --- |
| Internal capability module | One representative Plugin capability behind a local module interface, retaining the external adapter | Failure matrix, cancellation and admission tests, shutdown test, source-size comparison, and clear operator status |
| Feed auth state | Explicit connection authentication result passed from handler to feed server | Full auth/origin/frame matrix, reconnect and slow-client tests, race and leak checks |
| Route policy | Public, browser-session, API-key, and feed-handshake route groups | Generated method/path/auth matrix, CORS preflight tests, no public-route drift |
| `ServeMux` route diff | Translate a copy of the current route set to Go 1.26 patterns | All route behavior and middleware checks pass with equal or smaller wiring; otherwise keep chi |
| Local CORS adapter | Replace only `go-chi/cors` around the existing origin validator | Exact and wildcard origin tests, credentials, `Vary`, OPTIONS, rejected origins |
| zerolog to slog | Middleware, one handler, one background loop | Equivalent structured output, request IDs, error fields, no secrets, benchmark, no wrapper |
| Task provenance | Audit-only actor fields in a fixture or isolated schema branch | Reconstruct create/cancel races, define anonymous/device actor semantics, quantify migration and retention cost |
| Runtime shutdown accounting | Wait for feed, Plugin, storage, and task loops under blocked dependencies | Bounded shutdown with race detection and no goroutine leak; retain current cancellation if this adds more machinery than evidence justifies |
| Real task path | One real catalog Command, one field-runtime implementation, restart and ambiguous transport cases | Durable lifecycle, stale-runtime fencing, cancellation semantics, reconnect reconciliation, and operator-readable audit trail |

## Unknowns that block stronger conclusions

- There is no production traffic profile for WebSocket fanout, feed event size, task arrival rate, or login concurrency.
- Source provenance is recorded in the [review overview](README.md#evidence-baseline). The coordinator verified the remote revision and exported that exact local commit before this review.
- The production command catalog is empty, so tasking complexity has not yet been validated by a real physical command.
- It is not decided whether any capability requires a separate crash, credential, trust, release, or egress boundary. That decision determines whether Plugins are a product boundary or an internal module adapter.
- It is not known whether downstream log consumers depend on zerolog-specific field names, encodings, or hooks.
- It is not known whether operator audit needs require task actor provenance now or only after multiple human users exist.
- The local checkout's Go toolchain may differ from the source's declared Go 1.26.5 toolchain. Any router or logger experiment must use the repository toolchain.
- Storage schema, PostgreSQL sizing, S3 behavior, and deployment ingress are covered by the storage and system-options work and should not be inferred from this runtime note.

## External primary sources

The alternatives above are grounded in the maintainers' or language project's documentation:

- [Go 1.22 release notes](https://go.dev/doc/go1.22) and [Routing Enhancements](https://go.dev/blog/routing-enhancements) for `ServeMux` patterns and `PathValue`.
- [Go `context` package](https://pkg.go.dev/context) for cancellation and deadline propagation.
- [Go structured logging with `slog`](https://go.dev/blog/slog) for the standard logger's design and tradeoffs.
- [`coder/websocket` README](https://github.com/coder/websocket) for the WebSocket implementation's context and concurrency properties.
- [`go-chi/chi` README](https://github.com/go-chi/chi) and [`go-chi/cors` source](https://github.com/go-chi/cors/blob/master/cors.go) for the current router and CORS alternatives.
- [`pgx` README](https://github.com/jackc/pgx) for PostgreSQL-specific driver features and pooling.
- [`golang.org/x/crypto/argon2`](https://pkg.go.dev/golang.org/x/crypto/argon2), [`x/net/idna`](https://pkg.go.dev/golang.org/x/net/idna), and [`x/text/cases`](https://pkg.go.dev/golang.org/x/text/cases) for the cryptographic and Unicode boundary dependencies.
- [Node `http` API](https://nodejs.org/api/http.html) for the credible Node baseline.
