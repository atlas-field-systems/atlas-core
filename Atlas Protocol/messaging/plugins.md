# Plugin and Operation messages

Applications invoke Plugin capabilities through Operations, separately from Asset Tasks.
The Plugin performs the requested processing.

## Messages

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `ListPlugins` | Operator app or integration discovers installed processing capabilities | Bounded Plugin query | Installed capability information |
| `GetPlugin` | Invoking application checks one Plugin's capabilities before requesting work | Plugin identity | Installed capability information |
| `CreateOperation` | Operator app or automation requests Plugin processing | Plugin capability, stable invocation identity, and inputs | Recorded Operation under [Operation rules](../operations.md) |
| `ListOperations` | Operator app reviews Plugin processing requests | Bounded Operation query | Matching Operations |
| `GetOperation` | Invoking application checks progress or recovers the recorded outcome after a lost reply | Plugin and Operation identities | Recorded Operation state |
| `CancelOperation` | Invoking application explicitly asks to cancel Plugin processing | Operation identity and retry facts | Recorded cancellation intent under Operation rules |

Caller disconnection does not cancel an Operation. Admission, cancellation, and
runtime-loss outcomes follow [Operation rules](../operations.md).

[Messaging index](../messaging.md)
