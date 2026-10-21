# Atlas Core

**Core is the running authority for one Atlas installation.** It validates requests,
records intent and evidence, stores data, and serves clients. It does not fly the
drone or turn a network acknowledgment into physical success.

## Deployment

Start with one Go server, ordinary internal modules, one SQLite database in WAL
mode, and local Object files. Core and independently managed Plugins run in Docker
containers on a Linux host. A small host manager survives Core for local lifecycle
control. These are selected implementation choices, not Protocol requirements.

Operators and field integrations connect over adequate IP using the SDK. Gateway
software and constrained-radio transport are separate projects. The operator UI is
a separate Atlas project outside Core and Protocol; closing it does not stop Core.
The [operating environment](../operating-environment.md) assumes host internet
access while allowing interruptions on field links. Local Core work does not
require a cloud service.

## Ownership inside the server

| Owner | Responsibility |
| --- | --- |
| Identity | Authenticate keys, record attribution, and enforce revocation |
| Entities/reporting | Descriptions, accepted Asset and Observation reports, retained Tracks and associations, contact, and movement |
| Fusion policy | Observation-to-Track decisions and derived state, initially one-to-one |
| Tasks | Command admission, intent, requested order, and reported execution |
| Objects | Complete content publication, metadata, holds, and cleanup |
| Plugins | Installed capability policy and recorded Operation attempts |
| Synchronization | Publish and replay whole committed changes |
| Host manager | Container control and destructive work that must outlive Core |

Core's internal owners use direct calls and a shared transaction boundary.
Keep each domain's tables private behind its owner. Add no
generic event bus, scheduler service, or module framework without a concrete need.

## Generation boundary

Use Protocol's OpenAPI definitions for Go types/server interfaces and TypeScript
transport types. The selected starting tools are `oapi-codegen`,
`openapi-typescript`, and `openapi-fetch`. Use `sqlc` for bindings from Core's
**handwritten private SQL**, never by turning public resources into database tables.

Handwrite authorization, validation integration, Task rules, transactions, file
publication, Plugin supervision, and recovery. SDK workflow code is also handwritten.
Use stock configuration; no custom schema language, endpoint-specific templates,
patched generated files, or duplicate wrapper API. A narrow handwritten binding
is preferable when generation makes an exceptional route harder to understand.

Tool versions and the supported schema profile are not yet pinned or qualified.
This repo contains no qualified locks or generated packages. Measure saved
maintenance, not generated line count. Removing repeated declarations is the goal;
generating most of Core is not.

## Scope

This baseline covers one installation. Clustering, federation, operational
backup/restore, operational-data migrations, and automatic mission recovery across
Core restart are outside scope.

## Reading order

[Storage](storage.md) → [Lifecycle](lifecycle.md) → [Plugins](plugins.md) → [Fusion](fusion.md) →
[Diagnostics](diagnostics.md) → [Qualification](qualification.md).

Shared behavior remains in [Protocol](../Atlas%20Protocol/README.md).
