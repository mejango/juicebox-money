
## next build vs running dev server (2026-07-16)
`npm run build` and `next dev` share `.next/` — running a production build
while the dev server is up clobbers its chunk cache (pages 404 their JS/CSS,
render unstyled). If a build is needed while dev runs, restart the dev
server afterward (kill next-server + `npx next dev -p 3006`), or build in a
checkout/worktree copy.

## 2026-09-03 — "fix X too" means every surface X has, not the easy one
jango asked for the later-ruleset start control on juicescan "too" and I ported only the launch flow,
noting the queue editor as a "scope limit" because its anchor looked unknown. He pushed back: both
sites should have the full queue-ruleset experience. The anchor WAS knowable (the parent ruleset is
read on-chain). Rule: a parity request covers create AND queue editors on both webclients; when a
piece looks blocked, check whether the missing input is actually available before scoping it out,
and if it truly is blocked, say so up front and ask rather than shipping around it.

## 2026-10-06 — Pending routing belongs to the receiving project
Show payments awaiting routing on the destination project, not the source that initiated them. Scope queries, validation and new activity to destination projectId; preserve sourceProjectId in committed on-chain call data. Test unequal source/destination IDs.

## 2026-10-06 — Destination changes include saved recovery discovery
When moving an action between project pages, migrate discovery of durable recovery state too. Authenticate the destination from immutable call data, hide source-only saved batches, and retain original scope/action/transaction hashes for resume. Give fresh destination actions a separate namespace so legacy source aliases cannot capture them. Completed calls must not keep an unrelated page's recovery card visible.
