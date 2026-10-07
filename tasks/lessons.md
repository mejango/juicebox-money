
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

## 2026-10-06 — Saved progress is not the pending inventory
Show indexed pending payments while RPC checks run; state loading/errors explicitly. Label saved batch counts as saved selections and never imply they represent every pending payment.

## 2026-10-06 — Untouched drafts should not constrain a refreshed selection
Separate local intent from potentially exposed execution using the journal owner’s conservative classifier. Zero handled calls does not prove no submission. Replace proven untouched drafts only after locking and rechecking every original and replacement alias.

## 2026-10-06 — Recovery restrictions need observable reasons
Explain the persisted state that requires resume, rather than repeating zero completed attempts. Offer a read-only recheck through the owning release proof when safely available; never infer that the actual user batch is unfunded.

## 2026-10-06 — Pace egress, not response completion
A two-worker chain-check limit makes unrelated chains wait for slow responses. Pace actual browser RPC request starts in the shared transport, let independent checks overlap, and still drain every check before quote/payment decisions.

## 2026-10-06 — Exercise persisted recovery through the actual caller
Mocked journal storage cannot verify serialization or reload identity. Cover quote creation, modal reopening, funding and recovery with the real writer/reader. Safe-scoped status checks use the saved funding identity; connecting a different wallet must not prevent read-only reconciliation or authorize that wallet to fund. Reproduce the reported click sequence before attributing an automatic error to a payment click.

## 2026-10-06 — An unused Safe quote must not block the current transaction set
A lost quote response is not a submitted wallet payment. Use the shared Safe lifecycle's funding-evidence decision to let users review and quote the currently ready set again, including changed chain selections. Preserve real or ambiguous funding and verify the complete user journey through an explicit payment, rather than stopping at recovery diagnostics.
