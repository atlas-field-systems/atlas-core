# Closed public errors

> Retained current design for review. [Planning status](../../../README.md#planning-status).

Error requires code, message and request_id. Message is text at most 1,024
Unicode scalars. Request ID is Core-assigned UUIDv4. Details is optional; when
present it has exactly the fields below, never exception text or arbitrary keys.
`cursor_expired` requires details with its earliest recoverable cursor.
Codes without a details shape permit only an empty details object when supplied.

| Code | HTTP status | Nonempty details shape |
| --- | --- | --- |
| invalid_request, dataset_required | 400 | None |
| unauthorized | 401 | None |
| asset_not_found, entity_not_found, operator_not_found | 404 | None |
| protocol_mismatch | 409 | `{protocol_version}` |
| dataset_mismatch | 409 | `{dataset_id}` |
| cursor_expired | 410 | `{earliest_recoverable_cursor}` |
| allocation_expired, challenge_expired, operator_deleted | 410 | None |
| payload_too_large | 413 | None |
| invalid_geometry, unsupported_geometry, geometry_limit_exceeded | 422 | None |
| unsupported_filter, unsupported_command | 422 | None |
| resource_limit, contact_busy | 429 | None |
| storage_limit | 507 | None |
| integrity_fault | 500 | None |

The following closed conflict codes all use 409 and empty details if supplied:
counter_exhausted, allocation_conflict, generation_mismatch,
challenge_context_mismatch, challenge_consumed, queue_changed, cancellation_pending,
evidence_conflict, cancellation_changed, terminal_state_conflict,
control_not_confirmed, report_identity_conflict, section_sequence_conflict,
constituent_conflict, identity_conflict, edit_conflict, object_held.
Details strings use Wire token/version domains; IDs use existing UUID references.

Local boundary failures are typed invalid_json, invalid_utf8, invalid_value,
payload_too_large, resource_limit, invalid_geometry, unsupported_geometry,
geometry_limit_exceeded, invalid_http, or invalid_budget. They contain at most
16 bounded issues without rejected values, secrets or raw exception dumps.
They do not invent an HTTP response or establish a mutation outcome.
