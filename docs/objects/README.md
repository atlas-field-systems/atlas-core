# Objects

## Story

A drone finishes a Task and produces a photograph. I can see that the Task finished
even if the file takes longer to arrive, then download the complete file when ready.

## One possible flow

```mermaid
sequenceDiagram
    participant Asset
    participant Atlas
    actor Operator
    Asset->>Atlas: Report Task completion and declare a result Object ID
    Atlas-->>Operator: Task complete; declared file not yet available
    Asset->>Atlas: Upload the file and metadata
    Atlas->>Atlas: Verify complete bytes and publish the Object
    Atlas-->>Operator: Result file available
    Operator->>Atlas: Download the complete file
```

## Retained decisions to review

- Upload and Task reporting can happen in either order. Neither proves the other succeeded.
- A public Object has complete verified content. There is no successful partial download placeholder.
- Associations connect files to Entities and Tasks. Deleting an Entity does not automatically delete its files.
- Required Task results protect their Objects from deletion until Reset in the previous design.

## Details when needed

- [Upload, retry, references, and deletion](../reference/current-design/objects/objects.md).
- [Messages](../reference/current-design/objects/messages.md) and [file publication](../reference/current-design/objects/publication.md).
- [Task declarations](../reference/current-design/tasks/tasks.md#references-and-results).

[Atlas planning](../README.md)
