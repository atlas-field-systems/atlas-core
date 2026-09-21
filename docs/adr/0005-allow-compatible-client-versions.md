---
status: accepted
---

# Allow compatible client versions

Connected clients may use a different release version from Core when their contracts are compatible. The user accepted this on 20 September 2026 so field devices and other clients do not require an exact version match on every server update.

[Matching Core, SDK and Protocol release numbers](0001-release-core-sdk-and-protocol-together.md) identify corresponding published artifacts; they do not require runtime version equality. The compatibility checks, supported upgrade overlap and handling of unsupported capabilities remain to be designed. This decision does not promise that every older client works indefinitely.
