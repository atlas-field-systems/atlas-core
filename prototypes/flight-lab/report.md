# Atlas prototype findings

Four throwaway prototypes reproduced practical implementation traps in the design
at `1ca5623`. All 233 recorded observations matched their expected results in the
[assembled run](evidence/summary.json). These are observation points, including
expected failures of broken alternatives, rather than 233 independent workflows.

## What ran

| Instrument | Observations | Real boundaries |
| --- | ---: | --- |
| [Retry and execution](evidence/retry.stdout.json) | 56 | HTTP, SQLite WAL/FULL, Plugin processes, Unix sockets, independent effect log |
| [Synchronization](evidence/sync.stdout.json) | 38 | HTTP streams, interrupted JSON, SQLite captures, local picture and journal |
| [Object publication](evidence/storage.stdout.json) | 98 | Files, fsync, SQLite WAL/FULL, 75 child processes, four publication kill barriers |
| [Wire decoding](evidence/wire.stdout.json) | 41 | Raw bytes through Python and Node, minimal SQL update specimen |

Run `env TMPDIR=/tmp python3 prototypes/flight-lab/run.py` from the repository root.
[Environment and source hashes](evidence/environment.json) identify the executed code.

## Findings that matter

1. **Acknowledgment cannot retire Plugin receipts.** The broken eviction control
   recorded two external effects for one Operation. The protected path retained one,
   including after receipt capacity filled. Keeping terminal evidence and keeping
   receipt protection are separate responsibilities. See the receipt-eviction case
   in [retry evidence](evidence/retry.stdout.json) and [Plugin delivery](https://github.com/atlas-field-systems/atlas-core/blob/1ca56231fb5cf64968a8ae2a04488ff3b8899f0a/Atlas%20Core/plugins.md#delivery-without-accidental-reruns).

2. **Synchronization must validate privately and freeze its handoff.** Incremental
   validation changed resources, cursor, journal, and notifications before rejecting
   an invalid final resource. Live-table paging omitted unchanged resource `c`.
   Moving H included later `B@4` and `F@4` values. The fixed capture and handoff
   matched an independent handwritten map. See [sync evidence](evidence/sync.stdout.json)
   and [synchronization](https://github.com/atlas-field-systems/atlas-core/blob/1ca56231fb5cf64968a8ae2a04488ff3b8899f0a/Atlas%20Protocol/synchronization.md).

3. **Unreferenced files can belong to live uploads.** The broken sweep deleted an
   installed file while its publisher was alive before SQL commit. Publication then
   reported an integrity error. Per-artifact ownership checks preserved live,
   committed, collided, replaced, and unproven files. Four publication kill barriers preserved all-or-none public
   metadata, retry, and change records. See [storage evidence](evidence/storage.stdout.json)
   and [file publication](https://github.com/atlas-field-systems/atlas-core/blob/1ca56231fb5cf64968a8ae2a04488ff3b8899f0a/Atlas%20Core/storage.md#publishing-files).

4. **Lost replies and broad ordering shortcuts invent or lose work.** Allocating on
   retry produced two Tasks, sequences, and batches. Retained exact retry recovered
   one after Core process death. A single Asset watermark discarded an earlier
   unseen Task completion after newer telemetry. Gateway-scoped deduplication added
   duplicate movement. See [retry evidence](evidence/retry.stdout.json),
   [requests](https://github.com/atlas-field-systems/atlas-core/blob/1ca56231fb5cf64968a8ae2a04488ff3b8899f0a/Atlas%20SDK/requests.md), and [reports](https://github.com/atlas-field-systems/atlas-core/blob/1ca56231fb5cf64968a8ae2a04488ff3b8899f0a/Atlas%20Protocol/reports.md).

5. **Ordinary parsing can destroy facts before schema validation.** Node accepted
   decoded duplicate keys, malformed UTF-8 after replacement decoding, lone
   surrogates, and overflowed numbers. Numeric conversion changed `9007199254740993`
   to `9007199254740992`. Subfield merging retained an optional field omitted from
   a replacement section. See [wire evidence](evidence/wire.stdout.json) and
   [wire rules](https://github.com/atlas-field-systems/atlas-core/blob/1ca56231fb5cf64968a8ae2a04488ff3b8899f0a/Atlas%20Protocol/wire.md).

The reviewed rules address these traps. Links below and above pin that historical design. The prototypes make
their consequences reproducible. I found no clear contradiction in these selected
boundaries; that is a bounded investigation result, not a conformance verdict.

## Decisions and recommendations at the reviewed revision

- Approved follow-up decisions are recorded in [Operation rules](https://github.com/atlas-field-systems/atlas-core/blob/1ca56231fb5cf64968a8ae2a04488ff3b8899f0a/Atlas%20Protocol/operations.md)
  and [Core storage](https://github.com/atlas-field-systems/atlas-core/blob/1ca56231fb5cf64968a8ae2a04488ff3b8899f0a/Atlas%20Core/storage.md). These prose changes do not qualify
  an implementation.
- Attempt-specific installed paths demonstrated retry progress without overwriting
  orphan bytes. This adds orphan storage to account for until verified cleanup.
- Protocol still needs concrete Operation schemas and counter ranges.
  The wire fixture assumes unsigned 64-bit counters.
- Core still needs a qualified runtime-continuity handshake and ownership proof
  across manager takeover. Test PID/token pinning is an experiment assumption.
- Next, prove one narrow Go/TypeScript workflow using the eventual schemas, a lost
  post-commit reply, and atomic replay. These scripts supply scenarios, not reusable
  production modules.

## Limits

File content is a three-byte known digest fixture. ENOSPC is simulated. Capture
expiry uses injected ticks. Plugin dispatch uses synchronous Unix RPC instead of
the planned long polling. Slow-subscriber tests cover the SDK journal, not network
backpressure. No speed, memory, large-file, or deployment-capacity claim is made.

Go, the TypeScript SDK, full schemas/generation, TLS, Docker/host-manager lifecycle,
Reset recovery, contact proofs, concurrent duplicate uploads, physical reclamation,
real Assets/radio, and power-loss durability remain unqualified or unrun.
