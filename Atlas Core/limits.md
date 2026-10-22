# Initial finite limits

These selected defaults bound admission, not retention or claimed capacity.
Configuration may tune resource budgets after measurement. It cannot weaken
[Protocol](../Atlas%20Protocol/wire.md), evict accepted facts, or make an atomic effect partial.
MiB/GiB use powers of two. GB uses 1,000,000,000 bytes.

## Messages and work

| Boundary | Selected default |
| --- | --- |
| HTTP JSON request | 1 MiB encoded UTF-8 |
| Ordinary HTTP JSON response/page | 4 MiB, including envelope |
| Complete sync data message or replay page | 4 MiB and 1,000 changes, including envelopes |
| Pending data per sync connection | 4 MiB of whole messages |
| Sync control message | 16 KiB, separate from data capacity |
| Public JSON structure | Depth and value counts from [Protocol](../Atlas%20Protocol/limits.md#whole-message-bounds) |
| Complete public resource image | 1 MiB, including accumulated declarations and queue |
| Concurrent sync connections | 32 per installation |
| WebSocket authentication | 10 seconds from connection, with no data before acceptance |
| Upload | 2 GB per file, four concurrent uploads per installation |
| Download | Four concurrent streams per installation, streamed without whole-file buffering |
| Outstanding Tasks | 1,000 per Asset, including cancellation-requested work |
| Retained replay | 64 MiB or 15 minutes, whichever prunes first |

Apply Protocol's parsing bounds to responses and complete frames too.
Binary streams bypass JSON bounds. Endpoint pages may be shorter than their item
limit to fit byte/value limits. The complete result and commit must fit before growth
is accepted. Reserve representable cancellation, terminal evidence, and failure paths.
Public field ranges and reusable component counts belong only to Protocol schemas.

## Temporary allocations

| Owner | Selected default |
| --- | --- |
| Snapshot captures | Eight per Core run, two per credential, 512 MiB each, 2 GiB aggregate disk |
| Snapshot expiry | Original [allocation-context deadline](../Atlas%20Protocol/temporary-reads.md#context-before-allocation), never extended by retries/pages |
| HTTP history views | 16 per Core run, four per credential, original allocation-context expiry |
| History membership | 100,000 references/view, 1,000,000 across Core views |
| History frozen data and indexes | 128 MiB aggregate, charged before allocation |
| Allocation receipts | 4,096 per Core run across snapshots and history views |
| Coverage join | One addition/client, sharing the existing 4 MiB connection buffer, 10-second cutover wait |

Use Protocol's finite allocation contexts so a released/expired receipt cannot
resurrect after pruning. Releases and status remain usable when allocation is full.
Expire temporary history views and recheck admission before refusing otherwise
viable writes or coverage. Never truncate matching history or pin replay indefinitely.
SDK's separate [picture budgets](../Atlas%20SDK/picture.md#capacity-and-retry) still apply.

## Disk, Plugins, and management

| Owner | Selected default |
| --- | --- |
| Installation aggregate storage | 64 GB accounting ceiling, with 8 GB free-disk headroom |
| Published Object bytes | 16 GB quota within aggregate storage |
| Plugin bundle | 8 MiB manifest/schemas, 64 capabilities, 128 schema files, 256 KiB/schema |
| Plugin version strings | 128 UTF-8 bytes each |
| Private Plugin message | 1 MiB, with the same JSON structural bounds |
| Live receipts | 65,536 Operations/runtime, never recycled during that runtime |
| Plugin evidence | 256 KiB/report, 64 progress revisions and one terminal revision/Operation |
| Plugin work area | 2 GB/installation, including receipts and unacknowledged evidence |
| Management authority record | 64 KiB, including bounded completed steps and failure codes |
| Local activity journal | 64 MiB total, 16 KiB/payload, 1 MiB reserved for outcomes/stop |

Plugin admission reserves a receipt plus terminal evidence space before acceptance.
Progress reporting may stop at its bound; the reserved terminal revision remains
usable. Receipts and evidence bytes can exhaust before the count. A full Plugin
work area cannot consume installation headroom. Installation preflight rejects
overcommitted reservations; enabled Plugins share real disk, not independent promises.
Image storage, SQLite/WAL/indexes, retry facts, logs, staging, captures, deleted files
still held open, and manager storage all count against actual installation capacity.
The configured ceiling never promises that the host has that free space.

Normal logs and sensitive capture share the [diagnostic budget](diagnostics.md#collection-and-lifetime).
New ordinary work stops before consuming the 8 GB headroom. Required terminal/control
records use reserved space; if even those fail, expose failure without inventing success.
Confirmed stop and inspection remain reachable, with incomplete evidence visible.
Use `413 payload_too_large`, `429 resource_limit`, or `507 storage_limit` at their
Protocol-defined boundaries. Lowered settings govern new admission, not silent
cancellation, truncation, restart, or eviction. Actual disk isolation, decoded RAM,
and sustained workloads still require [qualification](workload-qualification.md).
