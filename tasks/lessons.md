
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

## 2026-10-07 — Independent account and queue reads should progress independently
Do not hide every chain behind the slowest account classification or mount a queue only after its parent repeats the same expensive Safe checks. Share display queries, show each verified result as it arrives, and leave live authority and execution checks at the transaction boundary. An RPC failure means unknown with retry, never a guessed EOA or contract type.

## 2026-10-07 — Progress labels must follow the operation and its evidence
Use shared lifecycle phases to distinguish quote requests, wallet confirmation, payment confirmation and destination execution. Render each canonically verified chain immediately while other chains remain pending, and keep its transaction link visible. Verify delayed responses and receipt arrival through the actual controller and storage; a funding receipt must never stand in for a Safe execution receipt.

## 2026-10-07 — Automatic work is status, not an idle action
During automatic Safe checks and quote preparation, show one passive progress indicator and retain dismissal. Do not render a disabled action or empty payment selector before a quote exists. Keep phase copy in one location and verify that real controls appear only when usable data is available.

## 2026-10-09 — Submitted payment confirmation is recoverable
- User reported that a batch showing confirmation uncertainty succeeded and registered on continuation, then requested the equivalent Juicebox Money check.
- Keep typed submitted-payment errors bound to their exact durably saved hash/chain; continue canonical reconciliation without another payment. Hashless, mismatched and unavailable proof remain pending. Foreground recovery must use the exact submitted scope/ID, including after replacing a draft.
- Gates: raw lifecycle regressions enforce one wallet payment and canonical funding/destination proof; PendingPayments tests enforce exact recovery identity, while modal error checks preserve readable full hashes.

## 2026-10-11 — Native market copy uses ordinary punctuation
The user rejected middot separators in the new native market views. Use ordinary punctuation in summaries, captions and retry copy. The actual native Entries browser view now asserts that no middot is displayed; preserve snapshot/receipt evidence instead of removing audit details with decorative copy.

## 2026-10-11 — Protocol identity is not application identity
The user corrected a Metalog-specific native inventory classification: SDK Defifa detection proves only the protocol family. Defifa inventory must display actual tier names, independent prices, current supply and phase without numerical-range assumptions or automatic application links/advice. Curve information belongs only in Metalog; generic Defifa consumers must not expose application-specific curve views or infer a Metalog collection. Existing browser and payment tests enforce nonnumeric names, mixed prices and absent automatic Metalog navigation.

## 2026-10-11 — Honor the final consumer boundary
The user explicitly removed curve information from Juicebox Money and Juicescan. Keep generic Defifa tiers and protocol Flavor; remove curve tabs, Metalog API callers and curve-only dependencies/fixtures from these consumers. Native desktop/mobile tests assert no curve controls, automatic Metalog links or API requests while preserving SDK inventory and writer guards.

## 2026-10-12 — Scope compatibility to the operation
The user requested basic Juicebox actions for Defifa without inert UI. A generic pay metadata incompatibility must not disable hook-free add-to-balance or compatible fund/admin actions. Keep native pay preparation explicit, but scope mint identity/start/pause guards to minting. Actual payment-engine tests prove native/unknown funding while ordinary pay and reviewed-account protections remain enforced.

## Defifa native action verification
- Development SDK installs must preserve the existing lock graph. Do not use --package-lock=false for no-save previews: ranged dev dependencies may drift and invalidate baseline comparisons. Restore npm ci, install a checked package against the lock, and rerun final gates.
- Reuse actual app control classes (input-well and padded buttons), then inspect mobile browser artifacts; nonexistent class names can leave working controls visually unrecognizable.
- Native attempt guards must survive mode/tab/remount and reload through the shared recovery owner. Local refs alone do not preserve unknown direct submissions.

## 2026-10-12 — Shared auxiliary reads must honor the RPC owner
Live native acceptance found owner/account ENS names still used publicnode through an older production-only client branch, although primary protocol reads used Center. Route the single ENS client through the existing Center transport for name, address and handle consumers alike. A regression invokes real forward/reverse ENS reads and asserts every RPC URL/origin uses Center; deterministic alias behavior remains covered.

## 2026-10-12 — Image availability requires actual decode evidence
- Live preview acceptance found valid JSON and a returned SVG URI did not imply the SVG would decode: middle-tier images had naturalWidth zero. Verify each visible image's actual browser decode or a graceful named fallback, including selected thumbnails. Keep malformed untrusted metadata unchanged and place cosmetic failure handling in the shared presentation owner.

## 2026-10-23 — Validate the configuration that will be encoded
A Simple launch must activate preset rule settings, including issuance denomination, while saving Custom rules separately for restoration. Preserve that separation through reload and export/import. Scope stage-specific checks to the active flavor; continue validating shop settings that every flavor encodes. Derive visible launch requirements from the same checks that disable the button. Reproduce disabled actions with the exported draft rather than inferring hidden values from review labels. Rendered launch regressions enforce this boundary.

## 2026-10-24 — Make summary layout consistent and distinguish launch prerequisites
Keep labels on one line in modal summaries, align values in one column including rule lists, and show one creation-fee total with an accessible per-chain disclosure. A combined wallet/forwarder error cannot identify the failed condition: read each prerequisite and distinguish exact EIP-7702 delegation from arbitrary contract code before deciding supported execution paths. Preserve signature, canonical transaction and recovery proofs.
