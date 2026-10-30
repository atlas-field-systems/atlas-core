# Protocol boundary qualification

The archived Protocol experiment demonstrated failures at stateless boundaries.
Its Go tooling and Plugin payloads are historical evidence, not active implementation
choices or APIs. Retain applicable failure cases without importing experimental
helpers, generator versions, or wire layouts.

## Demonstrated pitfalls

- [Valid bounded polygons](https://github.com/atlas-field-systems/atlas-core/commit/67688e0a0e8af386257ef2036bae4e27541237a8)
  caused excessive allocation and synchronous validation time. Test maximum
  collinear, near-degenerate, and subnormal-coordinate shapes through requests
  and complete multi-resource frames. A vertex cap alone does not bound cost.
- [Large Plugin strings](https://github.com/atlas-field-systems/atlas-core/commit/ad1e0472baeee672b64beb119cf3ea80c67ffedd)
  decoded but failed unchanged re-encoding when raw byte length counted as JSON
  values. Test root and nested round trips at independent byte, value, and depth bounds.
- [Queue read contracts](https://github.com/atlas-field-systems/atlas-core/commit/a5ea00853e39d5fa9e5a1ec1f5f485d45ec53085)
  lacked enough information to recover edited order from Task items and a revision.
  Reconstruct order and adoption from reads, snapshots, and later changes without
  retaining the editor's state. Stateless examples do not prove durable queue behavior.
- [Numeric and generated Go construction cases](https://github.com/atlas-field-systems/atlas-core/blob/75dac3029615695f29cca754a345440578f09a8d/Atlas%20Protocol/numeric_workflow_test.go)
  reproduced rounded fractions passing integer checks and missing telemetry becoming
  zero readings. Later envelope validation accepted those fabricated readings.
  Test original numeric tokens and missing, null, and explicit zero through
  construction and serialization, before information is lost.
- [Shared Go validator settings](https://github.com/atlas-field-systems/atlas-core/blob/bf808dbb3a46ce64e292c040fa718dd3542db4ec/Atlas%20Protocol/first_use_test.go)
  changed acceptance. Test host format, regex, and uniqueness policies before,
  during, and after Protocol use, including concurrent consumers.

## Current qualification

The maintained [Protocol qualification](../Atlas%20Protocol/qualification.md) exercises
runtime schemas, boundary parsing, stock exports, geometry, and Power against
independent expected facts. The archived fixes explain why those cases matter;
they do not establish current implementation coverage or deployment capacity.

[Core workflows](qualification.md) exercise retained server behavior, queues, and
concurrent consumers. [SDK qualification](../Atlas%20SDK/qualification.md) exercises
client/server integration, reconnection, and picture application, with a separate
actual-browser procedure. Each guide owns its commands, coverage, and evidence limits.

Protocol retains the [embedded queue](../Atlas%20Protocol/tasks.md#scheduling-and-controls)
and [geometry boundary examples](../Atlas%20Protocol/components/geometry.md#boundary-examples).
Include queue and adoption images in page and whole-commit budgets under the
[shared build gates](build-profile.md#required-implementation-qualification).
Functional checks do not establish sustained workloads under Core's selected
[limits](limits.md) or power-loss durability. Historical Plugin payloads create no
current payload or codec requirement.
