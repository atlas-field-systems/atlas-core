# Plugin and Operation messages

> Historical design for review, not approved. [Planning status](../../README.md#planning-status).

Applications invoke Plugin capabilities through Operations, separately from Asset Tasks.
The Plugin performs the requested processing.

## Messages

| Message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `ListPlugins` | Operator app or integration discovers installed processing capabilities | Bounded Plugin query | Installed capability information |
| `GetPlugin` | Invoking application checks one Plugin's capabilities before requesting work | Plugin identity | Installed capability information |
| `CreateOperation` | Operator app or automation requests Plugin processing | Plugin capability, stable invocation identity, and inputs | Recorded Operation under [Operation rules](operations.md) |
| `ListOperations` | Operator app reviews Plugin processing requests | Bounded Operation query | Matching Operations |
| `GetOperation` | Invoking application checks progress or recovers the recorded outcome after a lost reply | Plugin and Operation identities | Complete public Operation view, including any recovered outcome |
| `CancelOperation` | Invoking application explicitly asks to cancel Plugin processing | Operation identity and retry facts | Recorded cancellation intent under Operation rules |

Caller disconnection does not cancel an Operation. Admission, cancellation, and
runtime-loss outcomes follow [Operation rules](operations.md).
`CreateOperation` requires `request_id`, `operation_id`, `plugin_installation_id`,
`capability_id`, and `input`. Core selects and retains the available immutable
`plugin_release`. An exact retry resolves the original selection before current
availability checks. `CancelOperation` requires `operation_id` and `request_id`.
A repeat returns existing intent or terminal outcome. Reads include the
[recovery shape](operations.md#public-operation-view), even after uninstall.

[Messaging index](https://github.com/atlas-field-systems/atlas-core/blob/30a3f9958c6eb6aa953596d413b12c3a3d3fb02e/Atlas%20Protocol/messaging.md)
