# Plugin Operations

> Historical design for review, not approved. [Planning status](../../README.md#planning-status).

**An Operation invokes one Plugin capability, separately from an Asset Task.**
Core records the invocation and outcome. The Plugin performs the processing.

## Payload facts

Inputs, outputs, and known effects are Plugin-owned JSON. Omission differs from
explicit null. Preserve accepted numeric token spelling, including large integers,
precise decimals, and underflow such as `1e-400`. Reject tokens whose conversion
overflows finite binary64 range, such as `1e400`. Do not replace underflow with zero.
Plugins own the arithmetic meaning of accepted values. Larger ranges need
Plugin-defined strings. [Wire limits](https://github.com/atlas-field-systems/atlas-core/blob/30a3f9958c6eb6aa953596d413b12c3a3d3fb02e/Atlas%20Protocol/wire.md#parsing-and-edits) still apply.

Retry equality compares JSON structure. Object member order and whitespace do not
matter. Compare decoded member names and string values, preserve array order, and
compare numeric tokens by exact spelling. Thus `1` and `1.0` conflict under the same
retry identity. Omitted fields and explicit null also differ.

SDK exposes a lossless JSON representation for these payloads. Callers retain their
prepared inputs for retries. Supported browsers must preserve the same facts as
other runtimes. A browser-compatible lossless codec is required; ordinary
number parsing is not a fallback. Codec conformance remains unmeasured.

## Admission and state

An Operation records its original capability, release, and input under a durable
identity. Its state is queryable, and cancellation is explicit. Core validates
input, availability, and capacity before accepting new work. It resolves an exact
retry before requiring the Plugin to still be available.

States are `pending`, `in_progress`, `cancellation_requested`, `completed`, `failed`,
`cancelled`, and `interrupted`. The last four are terminal. Caller disconnection or
an aborted SDK wait does not cancel processing. Explicit cancellation is a separate
request. Do not retry or roll back external effects automatically.

An accepted cancellation request sets unfinished work to `cancellation_requested`.
Core records `cancelled` only after the Plugin confirms cancellation took effect.
If processing completes or fails before cancellation takes effect, Core accepts
`completed` or `failed`, even after recording the request. Later reports cannot
rewrite a terminal state. Runtime loss follows the rules below.

## Runtime loss and recovery

Possible exposure means Core may have delivered the Operation to a Plugin.
It does not prove that processing or external effects occurred.

For unfinished Operations, apply these rules:

| Event | Outcome |
| --- | --- |
| Channel outage with the same verified live runtime | Keep the current state. |
| Confirmed Plugin runtime loss, confirmed never-exposed work | Keep the current state. Pending work remains pending. |
| Confirmed Plugin runtime loss, possibly exposed work | Mark it `interrupted`. |
| Whole-Core restart, including never-exposed work | Mark it `interrupted` before new Plugin execution. |

Pending never-exposed work may receive its first dispatch after verified Plugin
replacement within the same Core run. Possibly exposed work cannot execute anew
after replacement.

For example, a lookup confirmed never exposed stays pending after a Plugin crash.
If Core cannot rule out delivery before that crash, the unfinished lookup becomes
`interrupted`, even when the Plugin's receipt is unknown.

Preserve known effects. Core records later valid evidence separately as a recovered
outcome under the original Operation identity. Reads of that Operation include the
recovered outcome, known effects, and any result links. The original state remains
`interrupted`. Recording recovery does not create another Operation or authorize
another execution.

## Public Operation view

Every read returns `operation_id`, `plugin_installation_id`, `capability_id`,
`plugin_release`, `input`, `state`, `known_effects`, `result_object_ids`, and
`recovered_outcome`. The selected release is an opaque nonblank string of at most
256 scalar values from Plugin discovery. It stays immutable after uninstall.
`input` and `known_effects` are lossless Plugin JSON. Null means no known effects;
an accepted non-null effect record must remain visible. `result_object_ids` is a
unique UUID array, initially empty. Missing files do not reverse processing outcome.

`completed` requires `output`; other states omit it. Explicit null is valid.
`failed` requires `error`, with `code` and optional `message`; other states omit it.
`interrupted` does not invent an output or hide known effects.
`recovered_outcome` is initially null. After recovery it is exactly:

| Field | Required meaning |
| --- | --- |
| `outcome_id`, `revision` | Original terminal evidence UUID and positive uint64 revision, retained unchanged across replay |
| `state` | `completed`, `failed`, or `cancelled`, never another invocation |
| `known_effects`, `result_object_ids` | Retained Plugin JSON and unique Object IDs |
| `output`, `error` | The same state-dependent presence rules as the ordinary outcome |

Exact evidence repeats return the accepted revision without another effect.
Conflicting reuse is refused. Before a recovered terminal outcome, cumulative
progress may add known effects without restoring execution. The first accepted
terminal recovery fixes the outcome, output/error, effects, and result links.
Later evidence cannot rewrite that terminal result.
Recovery never changes the original `interrupted` state or dispatches work anew.
Private evidence delivery and acknowledgments belong to Core, not this public view.

[Next: Objects](https://github.com/atlas-field-systems/atlas-core/blob/30a3f9958c6eb6aa953596d413b12c3a3d3fb02e/Atlas%20Protocol/objects.md)
