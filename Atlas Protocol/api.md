# Public API surface

**These are the intended routes, not implemented endpoints.** Complete schemas
belong in Protocol. The tables are a compact scope map, not another field definition.
`{id}` means the resource ID for that row.

## Operational routes

| Family | Routes |
| --- | --- |
| Entities | `GET, POST /entities`; `GET, PATCH, DELETE /entities/{id}` |
| Alias | `GET /entities/alias/{alias}` |
| Retirement | `POST /entities/{id}/retire` |
| Asset reporting | `POST /entities/{id}/checkin`; `GET, PATCH /entities/{id}/status` |
| Assigned work | `GET /entities/{id}/tasks`; `PUT /entities/{id}/task-order`; `POST /entities/{id}/task-order/confirm` |
| Entity evidence | `GET /entities/{id}/movement-history`; `GET /entities/{id}/objects` |
| Tasks | `GET, POST /tasks`; `GET /tasks/{id}`; `PATCH /tasks/{id}/status` |
| Task results | `POST /tasks/{id}/results`; `GET /tasks/{id}/objects` |
| Objects | `GET /objects`; `POST /objects/upload`; `GET, PATCH, DELETE /objects/{id}` |
| Content | `GET /objects/{id}/download`; `GET /objects/{id}/view` |
| Plugins | `GET /plugins`; `GET /plugins/{plugin_id}` |
| Operations | `GET, POST /plugins/{plugin_id}/operations`; `GET /plugins/{plugin_id}/operations/{operation_id}` |
| Operation cancellation | `POST /plugins/{plugin_id}/operations/{operation_id}/cancel` |

Registration uses Entity creation; it is not a separate enrollment service.
Pause and Resume use Task creation. Task status handles authorized execution
reports and cancellation intent, not arbitrary state assignment.

## Administration and synchronization

| Family | Routes |
| --- | --- |
| Resource/activity inspection | `GET /admin/resources`; `GET /admin/activity` |
| API keys | `GET, POST /admin/auth/api-keys`; `DELETE /admin/auth/api-keys/{key_id}` |
| Operator profiles | `GET, POST /admin/operators`; `GET, PATCH, DELETE /admin/operators/{operator_id}` |
| Snapshot/replay | `GET /queries/full`; `GET /queries/changed-since` |
| Live changes | WebSocket `GET /feed` |
| Health/reference | `GET /health`; `GET /readiness`; `GET /docs`; `GET /openapi.json` |

Health and reference data require authentication. An unauthenticated docs page may
show only a minimal key-entry shell, without exposing the schema. Keep keys in
memory, not URLs or browser persistent storage.

Core configuration, Start/Stop/Restart/Reset/Hard Reset, Plugin installation,
updates, and runtime configuration are **local administration**, not public routes.
The Command Catalog is a local Protocol artifact. There is no generic Task deletion,
resumable-upload API, or remote Core-configuration endpoint.

[Next: synchronization](synchronization.md)
