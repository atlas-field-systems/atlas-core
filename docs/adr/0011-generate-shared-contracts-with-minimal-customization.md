---
status: accepted
---

# Generate shared contracts with minimal customization

Atlas Protocol is the authoritative shared description of public resources, operations, messages and observable guarantees. Generate repeated types, structural validation, serialization, reference documentation and suitable Core/SDK bindings from those contracts to reduce independently maintained declarations. The user accepted the adversarial review's recommendation, with minimal customization and strong independent testing as conditions of adoption.

Generated output remains disposable and separate from handwritten business implementations. Prefer supported generator behavior; endpoint-specific templates, output patches and duplicate wrapper APIs undermine the maintenance objective. A small handwritten binding is preferable when a generator would require disproportionate customization. The schema language and toolchain still need a representative comparison; acceptance of the direction is not evidence that a particular generator is simpler. See the [review](../research/atlas-reassessment/12-protocol-generation-adversarial-review.md).
