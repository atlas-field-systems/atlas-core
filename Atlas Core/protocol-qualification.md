# Protocol boundary qualification

The preserved Protocol experiment demonstrated failures at stateless boundaries.
These cases guide future qualification. They do not prescribe its experimental
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

## Remaining evidence

The archived fixes and tests cover particular Go and TypeScript paths. They do not
establish arbitrary schema support, browser compatibility, or deployment capacity.
Real reconnection, durable queues, concurrent Core consumers, and SDK picture
application still require the [integration workflows](qualification.md).
Test agreement against independent expected results, not only the other language.

Protocol now selects the [embedded queue](../Atlas%20Protocol/tasks.md#scheduling-and-controls),
[lossless Plugin payloads](../Atlas%20Protocol/operations.md#payload-facts), and
[geometry boundary examples](../Atlas%20Protocol/components/geometry.md#boundary-examples).
Qualify these contracts before expanding implementation. Include queue and adoption
images in page and whole-commit budgets. Core's selected [limits](limits.md),
Protocol's geometry/Power bounds, and the [lossless browser codec](build-profile.md#lossless-boundary)
still require implementation qualification.
Archive regressions do not establish durable behavior or deployment capacity.
