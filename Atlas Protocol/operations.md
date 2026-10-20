# Plugin Operations

**An Operation invokes one Plugin capability, separately from an Asset Task.**
Core records the invocation and outcome. The Plugin performs the processing.

## Payload facts

Inputs, outputs, and known effects are Plugin-owned JSON. Omission differs from
explicit null. Preserve accepted numeric token spelling, including large integers,
precise decimals, and underflow such as `1e-400`. Reject tokens whose conversion
overflows finite binary64 range, such as `1e400`. Do not replace underflow with zero.
Plugins own the arithmetic meaning of accepted values. Larger ranges need
Plugin-defined strings. [Wire limits](wire.md#parsing-and-edits) still apply.

Retry equality compares JSON structure. Object member order and whitespace do not
matter. Compare decoded member names and string values, preserve array order, and
compare numeric tokens by exact spelling. Thus `1` and `1.0` conflict under the same
retry identity. Omitted fields and explicit null also differ.

SDK exposes a lossless JSON representation for these payloads. Callers retain their
prepared inputs for retries. Supported browsers must preserve the same facts as
other runtimes. Qualify a browser-compatible codec before claiming support; ordinary
number parsing is not a fallback. Native JSON APIs are not Protocol requirements.

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

[Next: Objects](objects.md)
