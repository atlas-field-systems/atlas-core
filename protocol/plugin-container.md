# Plugin container contract

A managed Plugin runs in its own container. Local management installs it from the manifest in its directory and starts it; Core dispatches Operations to it. This contract is between Core and the container. Everything a Plugin does to Core goes through the public [Protocol](openapi.yaml) and the SDK.

## Manifest

`atlas-plugin.json` in the Plugin's directory:

| Field | Meaning |
| --- | --- |
| `id` | Plugin ID, matching `^[a-z][a-z0-9-]{0,62}$` |
| `release` | Plugin release; `/health` must report the same value |
| `image` | Container image local management runs |
| `port` | Port the container listens on |
| `capabilities[]` | `name` and `input_schema`, a JSON Schema that Core applies to Operation input before accepting it |

## Environment

Local management writes these into the container's environment at install:

| Variable | Use |
| --- | --- |
| `ATLAS_PLUGIN_ID` | This Plugin's ID |
| `ATLAS_PLUGIN_KEY` | Integration credential for the SDK; reads operational data and reports this Plugin's Operations |
| `ATLAS_DISPATCH_SECRET` | Core presents it on every call below except `/health` |
| `ATLAS_CORE_URL` | Where to reach Core |
| `ATLAS_PLUGIN_PORT` | Port to listen on |

The container receives no Core storage and no Docker control.

## Calls from Core

Every call except `GET /health` carries `Authorization: Bearer <ATLAS_DISPATCH_SECRET>`. Any 2xx reply is acceptance; any other reply is a definite refusal.

| Call | Meaning |
| --- | --- |
| `GET /health` | 200 with `{"id", "release", "capabilities": [names]}` when ready. Core probes it to track availability; a Plugin that answered earlier and then misses two probes is recorded as lost. |
| `POST /operations` with `{"id", "capability", "input"}` | Start an Operation. Accepting the same `id` twice starts it once. A refusal makes the attempt `failed`; no reply makes it `interrupted`. |
| `POST /operations/{id}/cancel` | Stop the Operation if possible, then report `canceled` (or its actual outcome) through the SDK. |
| `POST /quiesce` | Planned stop: refuse new Operations and pause continuous ingestion, while finishing accepted work. |

## Reports to Core

The Plugin reports progress and outcomes with the SDK's `reportOperation`, which calls `POST /plugins/{plugin_id}/operations/{operation_id}/reports`. `in_progress` may carry partial output; `completed`, `failed` (with an `error`) and `canceled` are terminal and cannot change afterwards.
