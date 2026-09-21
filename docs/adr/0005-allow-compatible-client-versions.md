---
status: accepted
---

# Allow compatible client versions

Connected clients may use a different release version from Core when their contracts are compatible. The user accepted this on 20 September 2026 so field devices and other clients do not require an exact version match on every server update.

[Matching Core, SDK and Protocol release numbers](0001-release-core-sdk-and-protocol-together.md) identify corresponding published artifacts; they do not require runtime version equality. Each release documents a supported client-version range and clearly rejects unsupported clients. The exact ranges and wire-level checks remain implementation choices; a shared release number does not itself establish compatibility. This decision does not promise that every older client works indefinitely.

Before starting operational service after an update, validate retained configuration and installed Plugin compatibility. Report invalid configuration without silently converting it. Keep incompatible Plugins installed but disabled and explain the incompatibility. Start compatible enabled Plugins normally. The user selected this behavior on 21 September 2026; it does not introduce automatic configuration conversion or operational-data migrations.
