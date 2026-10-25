# Closed moving-list queries

First pages have optional page_size and filters. Continuations contain only
page_token. Omission keeps the documented default without inserting a field.
Pages are exactly `{items, next_page_token}`. Items are the family's complete
read images, at most 1,000 with unique stable IDs. Only null completes a list.

Filters is a closed object. Every field is an optional unique array of at most
1,000 entries. Empty arrays match nothing; AND between fields and OR within
a field follow Wire. UUID fields use existing canonical references.

| Family | Permitted filter fields |
| --- | --- |
| Assets | ids, aliases, kinds, health |
| Observations | ids, aliases, kinds, publisher_ids, source_asset_ids, track_ids |
| Tracks | ids, aliases, kinds |
| Geofeatures | ids, aliases, kinds |
| Tasks | ids, asset_ids, commands, states |
| Objects | ids, content_types |
| API keys | ids, operator_ids |
| Operators | ids |
| Resources | kinds |
| Activity | categories |

Kinds, health, commands, states, aliases and content_types use the corresponding
resource scalar domains. Resource kinds and activity categories remain bounded
Core-owned names. No substring search, arbitrary paths, historical quantities or
unlisted filters are accepted. Associated-object queries use only the named
parent ID and optional page_size; their continuation contains only page_token.
