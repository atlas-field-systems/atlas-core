---
status: accepted
---

# Generate shared contracts with minimal customization

Atlas Protocol is the authoritative shared description of public resources, operations, messages and observable guarantees. Generate repeated types, structural validation, serialization, reference documentation and suitable Core/SDK bindings from those contracts to reduce independently maintained declarations. The user accepted the adversarial review's recommendation, with minimal customization and strong independent testing as conditions of adoption.

Generated output remains disposable and separate from handwritten business implementations. Prefer supported generator behavior; endpoint-specific templates, output patches and duplicate wrapper APIs undermine the maintenance objective. A small handwritten binding is preferable when a generator would require disproportionate customization. [ADR-0016](0016-use-go-sqlite-and-openapi-tooling.md) selects OpenAPI and the generation toolchain. The first slice must verify the expected maintenance benefit without custom output patches; the selection is not a benchmark result. See the [review](../research/atlas-reassessment/12-protocol-generation-adversarial-review.md).
