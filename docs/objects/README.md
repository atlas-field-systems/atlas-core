# Objects

## Story

An Asset finishes work and produces a photograph. I can see the Task outcome
before the photograph arrives, then retrieve the complete file when available.

## One possible flow

```mermaid
sequenceDiagram
    participant Asset
    participant Core
    actor Operator
    Asset->>Core: Report completion and declare a result file
    Core-->>Operator: Task complete; file not yet available
    Asset->>Core: Upload the file
    Core-->>Operator: Complete Object available
    Operator->>Core: Retrieve the file
```

## Selected direction

- The Object system owns file content and metadata.
- Associations make files discoverable from Entities, Tasks, and published Plugin results.
- Completion and upload can arrive in either order. Neither proves the other succeeded.
- Interrupted uploads can restart from zero in this build.
- Retaining received files until Reset is acceptable for the few-hour operating scope.
- Reset produces the run's operational archive. Its [detailed inventory](../support/archive.md) is proposed for review.

## Proposed delivery after deletion

Allow already declared Task-result files to arrive after Asset deletion and retain
their associations. This must not recreate the Asset, authorize new work, or revive
credentials. This policy needs owner approval.

## Open

Other deletion protections remain open. If the delivery proposal is approved,
its transfer contract still needs definition.

[Subsystem planning](../README.md)
