# Operator profiles

Profiles are installation setup. Reset retains them and their key bindings; Hard
Reset clears them. `operator_id` is immutable and cannot be reused after deletion
within the installation. A profile has required nonblank `name` of at most 256
Unicode scalar values, optional `description` of at most 4,096, and `edit_revision`.
Creation starts revision `"0"`. Edits require `expected_edit_revision`; null clears
description, while omission preserves it. No profile field grants permissions.

`CreateApiKey` can explicitly bind `operator_id`. Omission creates an unbound key;
null is invalid. The binding is immutable. `DeleteOperator` atomically deletes the
profile and revokes every key explicitly bound to it, including open sessions.
Unbound keys are unaffected. Binding and deletion serialize in one transaction.
A deleted-profile tombstone prevents any concurrent or later active binding.
Past request/activity attribution keeps the original operator ID marked deleted;
it is never transferred to a new profile. Exact deletion retries recover success.

Revocation stops new authorized network work at commit. It cannot erase bytes
already downloaded by applications. Complete local copies may remain readable as
stale and authorization-required under the [SDK picture contract](../Atlas%20SDK/picture.md).


[Identity and authority](identity.md)
