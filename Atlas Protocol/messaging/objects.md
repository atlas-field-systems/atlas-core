# Object messages

**Object messages publish complete file content and manage its metadata.**
An Object becomes public only after verified publication. Shared message context
and the proposal status of exact names and payloads follow the [messaging index](../messaging.md).

## Messages

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `UploadObject` | Asset runtime, operator app, or integration publishes a complete image or other file | Stable Object/upload request IDs, descriptor, initial metadata/associations, and complete binary content | Ready Object after verified publication under [upload rules](../objects.md#upload-and-retry) |
| `ListObjects` | Operator app browses or searches available file metadata | Bounded filters | Matching ready Object metadata |
| `GetObject` | Operator app or processing integration inspects a known file's metadata before reading it | Object ID | Ready Object metadata |
| `EditObject` | Operator app or integration corrects file metadata or associations | Object ID, permitted metadata edits, and retry facts | Committed metadata change |
| `DeleteObject` | Operator app or cleanup integration requests removal of an unneeded file | Object ID and retry facts | Deletion or refusal under [deletion holds](../objects.md#metadata-references-and-deletion) |
| `ReadObjectContent` | Operator app views or downloads a file; a processing integration reads its bytes | Object ID and requested read disposition | Complete content or an explicit [integrity failure](../objects.md#integrity) |

The descriptor defines the original byte length, SHA-256 digest, and content type.
Binary content remains binary; the message contract does not require JSON-encoded
files. There is no metadata-only create, partial public Object, or resumable upload.

Task result declarations belong to [Task messages](tasks.md). A declaration can
precede upload and does not establish that the Object is ready.

[Messaging index](../messaging.md)
