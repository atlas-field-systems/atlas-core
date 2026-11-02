# The run archive

## Story

After Reset, I can inspect earlier decisions and available files, distinguishing
missing results from successful transfers.

## Proposed inventory

The full-run ZIP is selected. This inventory and its checks remain proposals
for owner review.

| Owner | Archive content |
| --- | --- |
| Entities | Entity identities, final records, deletion markers, retained source provenance, and the history selected by the [history story](../entities/history.md) |
| Geofeatures within Entities | Authored geometry and its accepted revisions during the run |
| Tasks | Requests, accepted progress/outcomes, cancellation and order changes, retained delivery evidence, and result declarations |
| Objects | Metadata, associations, complete received file bytes, and declared-but-unavailable result status |
| Plugins | Published Entity/Object results and any invocation records already selected by a Plugin story |

Each owner retains selected records and changes until Reset. Final rows alone
cannot reconstruct history. The manifest states actual history coverage. This
selects neither every Entity field nor a Plugin job system.

## Proposed format and checks

Include a readable inventory with Dataset identity, capture cutoff, software and
schema versions, record/file locations, and checksums. Preserve identifiers and
references so results can be followed across systems.

Missing uploads remain explicitly unavailable; Core cannot export unseen bytes.
A supposedly complete stored file that cannot be verified fails the archive.
Exclude credential material, provider tokens, and private keys; retain non-secret
attribution identifiers. Archive verification does not promise restore support.

[Reset ordering and failure behavior](operations.md)
