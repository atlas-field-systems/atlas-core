# Geometry and references

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

A geometry edit advances its own revision. Tasks keep references to the same
Geofeature. The external Asset decides how to apply edits. Saving geometry does
not prove execution. Retain reported geometry-revision evidence until Reset,
without promising reconstruction of every old polygon.
Required references guard deletion while relevant Tasks remain nonterminal under
[Task rules](../../tasks/tasks.md). Terminal Tasks release those guards. Object holds are separate.
