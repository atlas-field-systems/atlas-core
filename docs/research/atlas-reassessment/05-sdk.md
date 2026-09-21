# SDK technology reassessment

Current lifecycle contract: [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md) supersedes wipe-on-start. Start, Stop and Restart retain operational data and logs; Reset clears them while keeping setup and installed artifacts. Core stays running throughout field missions; Restart and Reset are primarily development actions outside missions. Mission execution continuity across Core restart is outside scope. Updates to a new Core release perform Reset; operational-data migrations are excluded. Backup and restore functionality is excluded. Source observations below describe the inspected historical implementation; successor recommendations remain provisional unless backed by an accepted decision.


**Assessment date:** 2026-09-20
**Research timestamp:** 2026-09-20T15:35:31-04:00
**Source:** Atlas Modernization `main` at [`8edee4e2743fbf0f85c16dfe638d9222141cf279`](https://github.com/the-Drunken-coder/Atlas-Modernization/tree/8edee4e2743fbf0f85c16dfe638d9222141cf279). The local input was the verified source export at `/private/tmp/atlas-core-reassessment-20260920`.
**Status labels:** `[Fact]` is directly visible in the source, `[Allegation]` comes from a problem report and is checked below, `[Proposal]` is a successor design, `[Unknown]` needs an experiment or a product decision.

## Verdict

The successor should have a small, dependency-free TypeScript client for external consumers and a separate optional synchronization session. The first deployment has one Core server and field devices, so the SDK does not need to be a universal integration bus, an offline database, a plugin framework, or a second application state system.

The current SDK has useful protocol behavior but combines four jobs in one public package: endpoint methods, a cache, a WebSocket session with recovery, and a Node CLI. The recovery behavior is the valuable part. The broad default hydration and the internal lifecycle machinery are the parts to challenge. A smaller successor can be a breaking change because there is no production compatibility requirement in the source assessment brief.

`[Proposal]` Keep one npm package initially, with explicit exports for `client`, `sync`, and `cli`, rather than creating a package maze. Keep the implementation boundaries as if they were separate packages. A later package split should be driven by a real consumer, not by an abstract monorepo rule.

`[Proposal]` Treat in-process modules as Core code. They should call domain or application interfaces directly. Do not make a former plugin call Core through its own public HTTP SDK merely to preserve an old boundary. If a separately deployed integration appears, it can use the external client. This leaves the plugin question open without forcing public SDK semantics onto internal modules.

## What exists today

`[Fact]` The package is a Node 24, browser-capable typed client with HTTP, optional sync, an in-memory cache, a change feed, reconciliation, admin auth, and a JSON-lines CLI. The protocol package owns generated types, validators, and revision metadata, so the SDK consumes protocol output rather than owning schema tooling. See the [SDK overview](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-sdk/README.md#L1-L15), [public exports](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/index.ts#L1-L174), and [protocol boundary](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-06-04-atlas-protocol-build-boundary.md#L4-L10).

`[Fact]` HTTP is already close to a thin client: injected or global `fetch`, auth, timeouts, abort signals, validation, ETags, typed errors, and object bytes. The feed adds revision and auth handshakes, filters, a subscription barrier, validation, and 100-event or 8 MiB bounds. See [transport](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/http.ts#L103-L272), [feed contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-change-feed/README.md#L15-L65), and [feed manager](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/feed-connection.ts#L49-L365).

`[Fact]` Sync owns hydration, the single cursor, reconnect and `changed-since` recovery, cursor-expiry fallback, ordered events, bounded buffering, cache version guards, degraded status, and safety polling. The cache adds immutable snapshots, tombstones, local-delete state, generations, hydration epochs, and an object-content LRU. See [sync and recovery](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts#L273-L390), [recovery runner](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine-recovery.ts#L60-L113), and [cache](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/cache.ts#L97-L173).

`[Fact]` The CLI wraps entity reads, task creation, and watch with Node signal and environment handling. See [CLI](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/cli.ts#L1-L102).

## Direct dependency inventory

The package has no runtime npm dependency. That is a strong baseline for a browser and field-device client. The platform dependencies are `fetch`, `WebSocket`, `AbortController`, URL, streams, and text encoding. They are injected where tests or a host need control. Node 24 is already a package requirement. Node's current official documentation records a browser-compatible global WebSocket and AbortController; [WebSocket](https://nodejs.org/api/globals.html#class-websocket) is stable since Node 22.4 and [AbortController](https://nodejs.org/api/globals.html#class-abortcontroller) is long established.

| Package or surface | Direct runtime dependencies | Direct development dependencies | Disposition |
| --- | --- | --- | --- |
| `@the-drunken-coder/atlas-sdk` | None. Platform `fetch`, `WebSocket`, `AbortController`, URL, streams, text encoding, and timers only. | `@biomejs/biome` 2.5.13; `@types/node` 26.5.1; `@vitest/browser-playwright` 5.0.1; `playwright` 1.63.0; `typescript` `^7.0.2`; `vitest` 5.0.1. | Keep zero runtime npm dependencies. Keep TypeScript, Biome, Vitest, and Playwright for browser behavior. Source: [`packages/sdk/package.json`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/package.json#L1-L85). |
| Root workspace build | None in the SDK. Root `postinstall` builds it; root coverage, Playwright, React, and React DOM are shared tooling. | Root workspace tools. | Deployment/tooling owner decides workspace mechanics. Do not copy them into the SDK. Source: [root package](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/package.json#L1-L56). |
| Command interface and simulations | SDK plus surface-specific React, MapLibre, Blueprint, Vite, Wrangler, `lucide-react`, and `tsx` dependencies. | Surface-specific test and build tools. | Keep these at the surface. The SDK should not gain React, MapLibre, or simulation events. Sources: [command data source](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/command-interface/src/atlas/data-source.ts#L53-L67), [simulation factory](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/simulations/src/server/atlas.ts#L1-L35). |
| Meshtastic link | SDK types, predicates, and validators plus radio and serial-port libraries. | Integration-specific Biome, TypeScript, and Vitest. | Keep radio dependencies outside the SDK. Source: [contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/meshtastic-link/src/contract.ts#L1-L24). |
| Current plugin packages | Building scan and reference currently use SDK types; source does not show live SDK calls. | Plugin-specific tooling. | Resolve in-process versus deployed boundary before preserving a full-access plugin SDK. Source: [building scan](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/plugins/building_scan/src/operation.ts#L1-L9) and [plugin decision](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-08-25-plugins-use-full-access-atlas-sdk.md#L3-L9). |

`[Fact]` The SDK's TypeScript configuration includes generated protocol TypeScript directly, uses repository root `rootDir: "../.."`, and emits package files under `dist/packages/sdk/src`. The public exports and CLI bin point at those paths. See [SDK `tsconfig.json`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/tsconfig.json#L1-L15) and [package exports](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/package.json#L27-L60).

`[Proposal]` Make the successor's output package-local, or use a deliberate project-reference build that produces a clean package root. Do not let an external consumer's import path depend on monorepo layout. This is deployment and shared tooling work, so this document records the constraint rather than prescribing the workspace implementation.

## Actual consumption

The source shows two different consumers. A browser command surface needs a warm, broad snapshot and live health. A simulation server uses a narrow client-like interface and passes request cancellation. A field or radio integration needs typed operations and validation, not necessarily a full cache. These should not be forced into one default mode.

| Consumer | Evidence from source | Consequence |
| --- | --- | --- |
| Command interface browser | `sync: "all"`, raw entity events, snapshots, health, task/geofeature writes, disposal, and browser token storage. See [data source](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/command-interface/src/atlas/data-source.ts#L53-L164) and [lifecycle](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/command-interface/src/atlas/data-source.ts#L251-L369). | Optional sync and immutable snapshots remain. React belongs in an adapter. |
| Simulation server | Narrow `AtlasClientLike`, `sync: false`, a two-second poll, and run-level fetch cancellation. See [factory](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/simulations/src/server/atlas.ts#L1-L123) and [scenario signal](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/simulations/src/server/scenario.ts#L114-L180). | Thin client and uniform cancellation must work without sync. |
| Simulation browser | Uses `EventSource` for simulation run events, not Core. See [run stream](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/simulations/src/client/run-event-stream.ts#L10-L59). | Keep SSE application-specific; keep Core WebSocket. |
| Meshtastic link | Imports generated types and predicates. The gateway decision says typed SDK operations reach Core without mirroring Shared Picture. See [contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/meshtastic-link/src/contract.ts#L1-L24) and [decision](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-09-02-meshtastic-gateway-does-not-sync-the-picture.md#L3-L9). | Preserve types and validators. Devices start with point operations and scoped subscriptions. |
| Plugins and acceptance | Current plugin code mostly uses types. Acceptance covers entities, tasks, objects, auth/conflicts, recovery, browser, packed installs, and simulations. See [entity](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/tests/acceptance/sdk-entity.mjs#L1-L174) and [tasks](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/tests/acceptance/sdk-tasks.mjs#L1-L200). | Treat former plugins as in-process until a deployed consumer exists. Keep these tests as successor gates. |

## Guarantees worth keeping

These are the parts of the current SDK that solve real distributed-systems problems. A simpler implementation must prove them or explicitly drop the capability.

1. **Protocol identity.** The client checks the protocol revision during HTTP and feed handshakes and validates payloads before they enter the cache. Keep generated validators and context checks. See [validation entry points](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/validation.ts#L44-L145).
2. **One durable order.** The WebSocket feed and `changed-since` query read the same durable event log. The feed is a fast path, not the source of truth. Keep a single monotonically ordered cursor. See the [feed source-of-truth contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-change-feed/README.md#L3-L11) and [retention and pagination bounds](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-change-feed/README.md#L22-L45).
3. **No missed writes across reconnect.** On reconnect, capture a cursor, install listeners, pass the subscription barrier, buffer events, replay from the captured cursor, then drain buffered events in order. This ordering is the reason for the current complexity. See [reconnect and recovery](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-change-feed/README.md#L47-L65) and [`reconnectAndRecover`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts#L739-L812).
4. **Explicit expiry recovery.** A cursor older than the server retention window causes full hydration, then establishes a new baseline. The client must not silently skip the gap. See [hydration watermark handling](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts#L668-L724) and [cursor-expiry fallback](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts#L333-L390).
5. **Version and delete ordering.** A stale event cannot overwrite a newer resource. Deletes carry versions, exact resource-specific 404 deletes are idempotent, and a local delete is guarded against a late read. See [version guards](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/cache.ts#L298-L429).
6. **Bounded memory.** Feed and recovery buffers have event and byte bounds. Object content is a separate count-bounded LRU. Preserve these limits even if the cache is simplified. See [feed bounds](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/feed-connection.ts#L1-L25) and [object content cache](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/cache.ts#L97-L129).
7. **Degraded fallthrough.** Reads remain usable through HTTP when a feed is unavailable, while status communicates that the cache is not current. Do not return stale cache data as healthy. See [cache serving rules](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts#L864-L880).
8. **Read cancellation.** The transport composes caller cancellation with its timeout and preserves the caller's abort reason. Make this consistent across every operation. See [timeout and abort composition](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/http.ts#L229-L272).

## Allegations checked against source

### Ergonomics gaps

`[Confirmed static gap]` The internal write path takes ten positional arguments, and entity/object creation passes `undefined` placeholders. The HTTP JSON helper also takes positional arguments. This is a maintainability cost, not a protocol failure. See [`writeResource`](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts#L457-L509), [entity creation](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/client.ts#L120-L150), and the [reported gap](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-18-sdk-ergonomics-gaps.md#L1-L9).

`[Confirmed static gap]` Abort support is inconsistent. Delete options have no signal, entity/object update options have no signal, full and changed-since query options have no signal, and object content and command-catalog methods do not expose cancellation even though they use HTTP. See [public option types](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/types.ts#L38-L115), [object content](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/client.ts#L322-L409), and the [ergonomics report](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-18-sdk-ergonomics-gaps.md#L1-L9).

`[Confirmed scope omission]` Object upload is not wrapped by the SDK. The docs deliberately defer it and no source evidence shows an existing consumer hand-rolling it. Keep upload out of the first successor unless a field-device consumer requires it. If it is added, use the same options-object and signal convention as every other request.

### Packaging paths

`[Confirmed static layout]` The package uses a workspace-root `rootDir` and exports paths containing `dist/packages/sdk/src`. The report's claim about a particular `npm pack` result was not re-run from the source export because the export has no installed build output. Treat the path coupling as confirmed and the tarball symptom as unverified here. See the [packaging report](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-18-sdk-packaging-monorepo-paths.md#L1-L9).

`[Proposal]` The successor's packed package must expose a stable root such as `dist/index.js`, `dist/index.d.ts`, and a separate CLI entry. Generated protocol code should be an explicit build input, not an accidental consequence of a repository-wide root directory. The deployment/tooling owner should choose the monorepo mechanics.

### Sync complexity

`[Confirmed static risk]` The sync implementation is large and coordinates several lifetimes: lifecycle generations, feed connection attempts, recovery operations, hydration identity and operation tokens, recovery-buffer identity, reconnect timers, and recovery ownership. The report measures a 984-line `sync-engine.ts` and identifies the token families. See the [complexity report](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-18-sync-engine-complexity.md#L1-L20).

This is not a reproduced runtime defect. The tokens are defending real races, and the source has focused unit and acceptance coverage. The right simplification is an explicit session state machine and one cancellation or generation scope, followed by the same race tests. Removing tokens without that proof would trade visible complexity for missed updates.

### Hydration ignores subscriptions

`[Confirmed static gap]` Starting sync calls full hydration. The full-dataset options contain only page cursors and limits. Hydration pages all entities, tasks, and objects and replaces the cache, while feed subscriptions only filter live events. The initial `sync: "all"` subscription is therefore not a bounded bootstrap scope. See [sync startup](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts#L586-L630), [full hydration](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts#L668-L724), and the [hydration report](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-18-sdk-hydration-ignores-subscriptions.md#L1-L9).

This matters more for field devices than for a command dashboard. A device should not download every task and object in the server merely because it opened a live subscription. A successor must either add a server-side scoped snapshot or define sync as an explicit, intentionally broad operation. “Optional sync” cannot mean “always hydrate everything after start.”

### Delete contract

`[Confirmed documentation mismatch]` The implementation treats an exact resource-specific 404 delete as an idempotent success, while the README says HTTP errors reject. The behavior is useful for retries and is covered by the resource-specific path. Either document it as part of the contract or remove it deliberately in a breaking version. Do not let a generic generated client erase this choice. See [delete behavior](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts#L540-L567) and the [reported mismatch](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-17-sdk-delete-missing-contract.md#L1-L14).

## Technology alternatives

### Generated REST client

OpenAPI TypeScript is a reasonable reference for a runtime-free generated type layer and a typed fetch wrapper. Its current documentation says it supports OpenAPI 3.0 and 3.1 and generates runtime-free types. See the [official introduction](https://openapi-ts.dev/introduction#features). OpenAPI Generator's `typescript-fetch` generator is a reasonable reference for a generated Fetch client. See its [official generator page](https://openapi-generator.tech/docs/generators/typescript-fetch/).

`[Proposal]` Do not move Atlas's JSON Schema authority to OpenAPI just to obtain a generated client. The protocol agent owns the JSON Schema and generated validators. A thin client can be hand-authored against the generated types, or a small generator can emit endpoint methods from the same protocol metadata. Generic codegen cannot express the change-feed barrier, durable cursor, hydration watermark, local-delete race, or resource-context validation. It can reduce request boilerplate, not replace the sync protocol.

### WebSocket versus SSE

The official MDN documentation describes WebSocket as bidirectional and capable of sending and receiving data, while warning that the browser API has no automatic backpressure. See [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket#websocket) and its [backpressure warning](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket#websocket). The SDK's 100-event and 8 MiB bounds are therefore necessary application-level protection.

MDN describes SSE as one-way: the client receives server events but cannot send events to the server. It also documents automatic reconnect and `id` and `retry` fields. See [Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#receiving_events_from_the_server) and [event fields](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#fields).

`[Proposal]` Use WebSocket as the comparison baseline for the Core feed. Subscription filters, authentication, the subscription barrier, and a server-directed handshake are part of the contract. SSE could carry append-only notifications, but replacing the feed with SSE would move subscription state and ordering into a second HTTP protocol. The simulation browser's SSE stream is a separate application event stream and is not a reason to change Core.

### TanStack Query or React Query

TanStack Query is a good React-side server-state tool. Its official overview covers fetching, caching, synchronization, stale state, pagination, garbage collection, and structural sharing. See [TanStack Query overview](https://tanstack.com/query/latest/docs/framework/react/overview#overview).

It is not a replacement for the SDK's ledger. Query invalidation tells a UI to refetch a key; it does not prove that a client saw every change between two global revisions, install listeners before a barrier, replay an ordered cursor, or recover an expired cursor. A query cache also has no reason to understand Atlas tombstones or resource versions.

`[Proposal]` Keep TanStack Query out of the core SDK. If the command interface needs it, add an optional React adapter that maps SDK point reads, mutations, and sync snapshots to query keys. Prefer a `useSyncExternalStore` adapter first because the SDK already exposes immutable snapshots and watches. The adapter must not own the feed or recovery state.

### IndexedDB and Dexie

Dexie is a capable IndexedDB wrapper with React live-query helpers. Its official React tutorial documents a singleton database and live queries. See [Dexie React tutorial](https://dexie.org/docs/Tutorial/React).

`[Proposal]` Defer persistent SDK storage. The current SDK explicitly has no historical or offline archive and no offline write outbox. A persistent cache would require account partitioning, schema migration, eviction, encryption or token policy, crash recovery, and a clear definition of whether a stored revision is safe to serve. A field device may eventually need this, but it is a product capability, not a cache-library substitution. Do not add Dexie until the outbox identity and idempotency contract exists.

### Node and browser platform APIs

The package's current choice to use web-standard APIs is sound for the first version. Node's official globals documentation lists `AbortController`, `AbortSignal.any`, and browser-compatible `WebSocket`; see [AbortController](https://nodejs.org/api/globals.html#class-abortcontroller), [AbortSignal.any](https://nodejs.org/api/globals.html#static-method-abortsignalanysignals), and [WebSocket](https://nodejs.org/api/globals.html#class-websocket). Keep constructors injectable for tests and hosts that provide their own WebSocket implementation. Adding `ws`, axios, a retry package, or a state library would create runtime weight without solving an Atlas-specific problem.

## Proposed successor shape

### 1. Thin client first

`[Proposal]` Define a single `AtlasClient` around a transport with these properties:

- Every operation takes one options object. Put `signal`, request timeout override, auth, and conditional version fields in named positions.
- Return decoded and validated protocol values, not untyped JSON.
- Keep typed API, conflict, validation, and protocol-revision errors.
- Keep HTTP methods needed by actual external consumers: authentication, entities, tasks, runtime registration, object metadata and content, and the query endpoints required by sync.
- Keep direct array-buffer reads for object content. Add upload only when a real consumer needs it.
- Make `delete` idempotency explicit in its method contract.
- Keep no cache in the thin client. A point read is a point read and a mutation returns the server result.

This is the right field-device default. It is usable when a device can reach one Core server, it has no browser or React assumptions, and it does not force the device to maintain a global copy of Core state.

### 2. Optional sync session

`[Proposal]` Move cache and live behavior behind an explicit `SyncSession` that depends on the thin client and an injected WebSocket constructor. Keep the public state small:

```ts
type SyncState =
  | { kind: "stopped" }
  | { kind: "hydrating"; scope: SyncScope }
  | { kind: "connecting"; since: number }
  | { kind: "recovering"; since: number }
  | { kind: "healthy"; revision: number; scope: SyncScope }
  | { kind: "degraded"; reason: SyncDegradedReason };
```

The exact TypeScript shape is a proposal, not a source requirement. The point is one visible state machine, one generation or cancellation owner, and separate helpers for feed connection, hydration, replay, and cache mutation. The implementation still needs the current guards, but their ownership becomes reviewable.

`[Proposal]` Require a scope when starting sync. For example, an external dashboard may request all entities and selected task classes, while a field device may request its assigned assets and tasks. If Core cannot provide a scoped snapshot, the API should say so and the consumer should use the thin client instead of pretending that a feed filter bounded the initial cache.

`[Proposal]` Keep these sync operations:

- handshake and protocol revision check;
- subscribe and barrier acknowledgement;
- snapshot hydration at a known server watermark;
- `changed-since` replay with strict increasing revisions;
- reconnect capture, listener installation, barrier, replay, and buffered-event drain;
- cursor expiry to full or scoped hydration;
- version guards, tombstones, immutable snapshots, and bounded buffers;
- healthy versus degraded status and HTTP fallthrough.

`[Proposal]` Drop or defer these from the first successor:

- broad all-resource hydration as the implicit result of `start()`;
- a persistent/offline archive;
- an offline write outbox;
- speculative composite resources;
- a plugin-specific SDK mode;
- generic mutation invalidation as a substitute for ordered replay;
- a direct object-upload abstraction until a real consumer requests it.

### 3. CLI as a separate entry point

`[Proposal]` Keep a small Node-only CLI for entity reads, task creation, and JSON-lines watch if operators use it. Put its process environment and signal code behind the CLI export so browser consumers cannot accidentally import Node globals. The CLI is a convenience over the thin client and sync session, not a third client implementation.

### 4. React as an adapter, not a dependency

`[Proposal]` If the command interface remains React, expose a tiny adapter around the session's immutable snapshot and watch APIs. A React adapter may translate sync health and resource snapshots into component state. It must not add React to the core package or move protocol recovery into React Query.

## Design conflicts and decisions still open

1. **Plugin boundary.** The existing decision says plugins use the full SDK to avoid duplicated clients, but current plugin code mostly imports types and the current product direction may make plugins in-process modules. Resolve this before preserving a “full-access plugin SDK” as a design goal. See the [existing plugin decision](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-08-25-plugins-use-full-access-atlas-sdk.md#L3-L9).
2. **Bootstrap scope.** The current feed supports filters but the full snapshot does not. Decide whether Core will add filtered snapshot endpoints or whether only selected external consumers may run sync. This is the central contract change for field devices.
3. **Object bytes.** Metadata has version guards and a separate LRU content cache, but upload is absent. Decide whether field devices upload through a first-class SDK method or a direct signed/object endpoint.
4. **Auth.** The client supports API keys and credentials and the admin client has login and API-key management. The SDK docs call auth hardening deferred. Decide which auth a field device uses before adding persistent cache or outbox behavior. See [admin client](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/admin.ts#L1-L69).
5. **One server is an opportunity.** Do not design federation, multi-server merge, or cross-device offline conflict resolution in this SDK version. Preserve the cursor and ordering needed to survive one server's reconnect and retention window.

## Experiments and gates

These experiments are sufficient to decide whether the simplified shape is real. They are intentionally smaller than a full rewrite.

| Experiment | Proof required | Gate |
| --- | --- | --- |
| Thin-client parity | Hand-authored or generated endpoint methods use options objects and uniform signals. Run entity, task, object, auth/conflict, and packed-consumer acceptance suites. | No wire behavior changes except deliberate delete and error documentation. Package imports from a clean temporary consumer. |
| Explicit sync session | Use the existing fake Core and WebSocket tests to interleave stop, reconnect, hydration, gap replay, cursor expiry, duplicate events, and late point reads. Then run real Core recovery acceptance. | No missed or out-of-order events, no stale overwrite, bounded queues, and clear degraded state. The same test matrix must pass in Node and browser harnesses. |
| Scoped bootstrap | Add a server-side snapshot scope or prove that a selected external consumer can safely use the thin client. Measure startup time, bytes, object count, and memory for a device-sized scope and an all-resource dashboard scope. | Startup work scales with scope. A write concurrent with pagination is recovered by the watermark and replay rules. |
| React edge adapter | Wrap a session in an external-store adapter and test subscribe/unsubscribe cleanup, snapshot reference stability, strict mode, and feed loss. | The adapter has no protocol logic and no core React dependency. |
| Persistent storage, only if required | Prototype Dexie or raw IndexedDB with account partitioning, migration, eviction, and crash recovery. Do not add writes yet. | A written identity, idempotency, auth, and outbox contract exists first. Otherwise the experiment is deferred. |

## Capability losses to state plainly

The successor deliberately gives up several current conveniences unless a consumer pays for them:

- A default all-resource in-memory view is no longer assumed for every sync caller.
- Internal modules do not receive a public SDK or HTTP loopback path merely because they were once called plugins.
- There is no promise of an offline archive or offline write queue.
- A generic React data library does not provide Atlas feed recovery.
- Generic generated REST code does not provide Atlas ordering, barriers, or cursor expiry recovery.
- Object upload remains a direct API concern until a concrete client needs it.

Those are acceptable losses for one Core server and field devices. They should be recorded in the public package documentation so a future consumer does not infer capabilities from the old SDK.

## Unknowns

- The real field-device resource scope and whether devices need inbound live updates, outbound mutations, or both are not defined in the SDK source.
- The first external consumer besides the command interface is not identified. Without one, a React adapter and persistent storage are speculative.
- The source export does not include a built `dist` tree, so a fresh `npm pack` result was not reproduced here. The rootDir and export path coupling is directly confirmed.
- The exact protocol generator contract is owned by the protocol work. This document assumes generated types, predicates, revision, and validators remain available.
- The deployment/tooling work owns workspace build and packaging mechanics. This document records package-local output as a requirement, not a second tooling plan.

## Research sources

The alternatives section was checked against primary or official documentation on 2026-09-20:

- [MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [MDN server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [Node.js globals](https://nodejs.org/api/globals.html)
- [TanStack Query React overview](https://tanstack.com/query/latest/docs/framework/react/overview)
- [Dexie React tutorial](https://dexie.org/docs/Tutorial/React)
- [openapi-typescript introduction](https://openapi-ts.dev/introduction)
- [OpenAPI Generator TypeScript Fetch](https://openapi-generator.tech/docs/generators/typescript-fetch/)
