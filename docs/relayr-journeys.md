# Relayr journeys across the V6 clients

Relayr pays for independent destination calls with one native-token payment on
Ethereum, Optimism, Base, or Arbitrum, including their Sepolia testnets. Each
bundle and its funding options stay within one network family: mainnets or
testnets. An ordinary wallet signs each destination request, reviews the
available funding options, and pays on its selected chain.
The clients continue to use their existing direct and Safe transaction routes
where forwarding is unsuitable. This integration uses user-paid Relayr; it does
not introduce Center gas sponsorship.

## Action coverage

| Journey | Juicebox Money | Revnet Money | Juicescan |
| --- | --- | --- | --- |
| Multichain creation | Relayr for supported mainnets or testnets and an ordinary wallet; saved launch configuration and per-chain recovery | Reviewed Relayr deployment | Reviewed Relayr deployment |
| Queue rulesets | Selected eligible project chains, with a live baseline and controller for each chain | Intentionally unavailable: revnet stages are fixed | Multichain queueing, including supported hook-deployment variants |
| Project profile (`setUriOf`) | Selected chains through the authority router | Selected chains through reviewed Relayr | Selected chains through the operator editor |
| Token name/symbol (`setTokenMetadataOf`) and deployment (`deployERC20For`) | Selected chains; each destination updates or deploys its own token | Selected chains; each destination updates or deploys its own token | Selected chains through the token editor |
| Ownership/operator changes | Selected chains through the authority router | Operator changes across its project group | Changes across the matching authority group |
| Operator permissions | Selected chains; preserves unknown permission IDs | Read-only permission view | Selected chains; preserves unknown permission IDs |
| Buyback hook, router terminal, TWAP | Selected chains with destination-specific addresses | Selected available chains | Selected available chains |
| Payment terminals, controller, accounting tokens | Selected chains where the ruleset permits the action | No general editor | Selected chains where the ruleset permits the action |
| Edit existing splits | Current reserved address recipients on selected eligible chains within one network family; other split groups individually | Multichain split-recipient update | Applicable multichain split operations |
| Execute approved Safe transactions | One currently executable transaction per chain; later Safe nonces wait | Existing Safe route | Existing Safe execution route |
| Add shop items and replace their media | Selected shops, frozen tier configuration and original metadata | Selected shops, including a media editor | Selected shops, including a media editor |
| Deploy project payer addresses | Raw factory calls with explicit owner, beneficiary, and local project ID | Raw factory calls with explicit per-chain review | Raw factory calls with explicit per-chain review |
| Distribute reserved tokens | Selected chains, live controllers and local recipients | Selected chains, live controllers and local recipients | Selected chains, live controllers and local recipients |
| Claim credits as ERC-20 tokens | Selected claimable chains, local token and holder balance | Selected claimable chains, local token and holder balance | Selected claimable chains, local token and holder balance |
| Distribute unlocked auto-issuance | Every selected unlocked allocation, in successive rounds when needed | Every selected unlocked allocation, in successive rounds when needed | Every selected unlocked allocation, in successive rounds when needed |
| Distribute payouts | Selected chains with local accounting token, currency, amount, and recipients | Selected chains with local accounting token, currency, amount, and recipients | Selected chains with local accounting token, currency, amount, and recipients |
| Pay, cash out, loans, bridged claims, and liquidity | Existing individual transaction journeys | Existing individual transaction journeys | Existing individual transaction journeys |

## Applying one edit across chains

`setUriOf` is a natural shared action: review the changed profile fields once,
sign one request per selected chain, and choose where to pay. Each destination
still needs its own live controller and project ID. Editing a shared name or
description must not copy an unrelated chain's custom properties, tags, cover,
or other untouched profile fields over the destination's metadata. Identical
resulting documents can share a pinned URI; preserving different local fields
can require different URIs in the same bundle.

Token name/symbol, operator permissions, ownership/operator transfers, buyback
hook selection, router terminal selection, and TWAP windows also have existing
multichain owner/operator surfaces as listed above. The selected
chains share the review; addresses, project IDs, permissions, and token references
are resolved or explicitly entered for each destination. A project handle claim
is different: its registry and ENS operations have a designated home chain and
must keep their verification order.

Accounting-token registration also reviews each destination token's decimals
separately. A shared token label does not establish matching addresses or
decimals. Likewise, a split recipient project's numeric ID is local to its
chain; a shared edit must resolve that recipient's peer project or require an
individual submission.

Money's current reserved-recipient editor resolves each peer's current ruleset
ID and preserves its locked recipients. Shared unlocked recipients are limited
to addresses. Payout groups, project recipients, custom hooks, and Safe accounts
use individual edits until their destination mappings and routing
are established. The review shows each chain's resulting allocation and owner
remainder; changing one group does not replace other groups.

Money's ruleset editor applies changed fields to each selected chain's own
baseline. Unedited metadata, hooks, splits, and fund-access limits stay local to
that chain. Token-denominated changes need an established mapping on every
selected chain. The confirmation shows the expected start on each chain because
existing ruleset calendars and approval hooks can differ. Selections requiring
Safe execution or mixed authorities can still be edited individually.
Older owner editors still require individual submissions for unsupported
forwarding targets or repeated calls on one chain. The six project batch
journeys above have a durable per-call journal: eligible same-family calls use
Relayr, other calls use reviewed direct or Safe transactions, and subsequent
calls on the same chain wait for earlier calls to complete.

Adding shop items freezes each shop's pricing, supply, splits, and next tier
identity. Replacing media preserves unrelated metadata and rechecks the original
tier identity. Payer deployment uses raw calls because the factory takes explicit
owner and beneficiary arguments rather than an ERC-2771 sender; completion
requires the exact factory deployment event and resulting payer configuration.

Claims use each holder's local credits and token contract. Auto-issuance retains
every selected unlocked stage and beneficiary, including multiple allocations
on a single chain. Reserved-token and payout reviews retain local controllers,
rulesets, recipients, and amounts. Their completion checks inspect distribution
events as well as receipt success, including failed split hooks and unused
allocations.

An approval followed by a payment, a permission grant followed by a loan, a bridge
preparation followed by settlement, or consecutive Safe nonces remains a sequence
of dependent operations. A multichain bundle does not make these dependencies
atomic.

## Funding and recovery contract

- A forwarded bundle contains at most one independent call per supported chain.
  The signed request binds the original wallet, chain, forwarder, target, calldata,
  native value, nonce, gas limit, and deadline.
- Forwarded actions also reserve the signer's nonce on each destination across
  different project actions and launches. Browser locks cover authorization and
  payment, and published recovery records preserve the reservation after a reload.
  A saved session or launch reserves its signer's nonces on its chains exactly
  while one of its requests is live by the classification below, anything
  unknown counting as live, and never by the device clock or a quote's expiry
  (ruling R117): an unpaid quote whose options expired still reserves while
  its signed requests can run. Each new relayed action classifies every
  session that would reserve its chains, once, before it signs, so one whose
  requests are all dead stops reserving the moment that is true, with no visit
  to the account view. A session marked for Discard reserves nothing.
- A saved project action whose bundle will not run as signed (an unpaid quote
  released, a payment that reverted, a paid bundle whose calls reverted or
  cannot be proven, a nonce that moved) is classified before its own recheck
  runs (ruling R114). A paid bundle is first proven from its destinations, so
  one that ran completes. Each request it published is read at one canonical
  finalized block on its chain. A request is dead once the forwarder's nonce
  for the signer moved past the nonce it was signed with, or once its deadline
  is strictly earlier than that block's timestamp, since the forwarder runs a
  request only while its deadline is at least the block's timestamp. Anything
  unknown counts as live: a failed read, no finalized block, and a block no
  longer canonical. A forwarder execute that reverts leaves its nonce unused,
  so a paid bundle whose calls reverted stays live until their deadlines.
- While any request is live, the action signs nothing new and offers no
  Discard. It quotes or pays again with the requests it published while every
  one still verifies and its recheck passes. That needs no read of the old
  bundle: the new bundle carries the same signed requests, so their nonces let
  at most one of the two run. Only now does Relayr's report of the bundle
  matter: another payment that funded a reverted quote is proven, never paid
  again. Otherwise it says until when its last live request can run, as a
  paid or wallet-held bundle whose calls are not proven does, and as a
  reverted quote whose release is not yet proven does.
- Once every request is dead, nothing old can run again, whatever Relayr
  reports of the old bundle: paid, reverted or unreadable. If no nonce moved
  and the recheck passes, the action signs its calls again with the nonce and
  gas each request was signed with (ruling R104), and quotes and pays a new
  bundle. When the old bundle was paid and its calls reverted, the new
  payment's review says "The earlier payment can't be reused: its bundle ran
  and reverted." If no nonce moved and the recheck fails, it offers Discard
  after "The project changed since this review." A recheck the node could not
  answer decides nothing (ruling R118): a transport failure, or a JSON-RPC
  error that is not an execution revert, such as JB Center's -32001 while its
  node is behind. It says "Couldn't check the project. Try again." and keeps
  the session; a revert with data is the chain answering, and reads as the
  project having changed. If a nonce moved, or the session saved no nonces,
  another action used the nonce or anyone holding the request ran it outside
  Relayr, and the app cannot tell which, so it offers Discard after "This
  action's earlier signature may already have run. Check the project, then
  discard it to review it again." The account view applies the same
  classification when it checks such a session, a released quote included:
  one that may have run ends with Discard, and since it cannot run the
  action's recheck, one whose requests expired unused offers Discard after
  "This action's earlier signatures expired without running." (ruling R114
  (e)); opening the action still signs them again at the saved nonces. The
  editors resume a saved session through their own action, so they can sign
  it again.
- Known limit: a reorg that drops an earlier forwarded transaction can leave
  the forwarder's finalized nonce below a saved one. Such a request is neither
  unused nor moved, so the session holds until the nonce catches up.
- The classification, the verdict and what a session does next are the SDK's
  (`@bananapus/nana-sdk-core/review/relayr`: `relayrRequestStates`,
  `relayrRequestsVerdict` and `relayrSessionOutcome`). This app supplies the
  clients, the lines, the storage and each action's recheck.
- Every flow that can show one of these lines shows Discard with it, in place
  of its error: the editors, the owner actions, the project batches and the
  account view. Discard removes the session. A fresh review signs at the live
  nonces, which no old request can use. After a "may already have run"
  Discard, nothing sends the same reviewed calls again without a fresh review
  (ruling R114 (f)):
  - An editor keeps its saved review, which it can review again or set aside:
    its own recheck refuses calls that already ran.
  - A batch whose round's Relayr session was discarded abandons its saved
    journal, so its calls are reviewed again from live state. The payout
    recheck refuses a payout that already ran: it compares the payout limit
    used since the review with the reviewed one.
  - An action with no recheck of its own (the owner powers such as Mint
    tokens, the buyback and router edits, the ownership transfer, the
    operator permissions and the token details) closes its review on
    Discard, so it offers no one-click retry.
  The split and ruleset recoveries, the metadata editor and the account view
  keep their resume or check action beside Discard, since a paid bundle that
  ran still completes when checked again.
- A launch classifies its outstanding requests the same way, after Relayr's
  read of a reverted quote, which matters only while a request can still run.
  While one can still run, and none moved, it signs again only at the saved
  nonces: a changed creation fee or signatures near expiry refresh every
  request at its own nonce, since the forwarder runs one request per nonce, so
  the old and new signatures cannot both run. Anything else waits and says
  until when. A destination it cannot prove, its record naming another
  transaction included, is classified the same way. Once all expired unused
  it can sign again at the saved nonces or be cancelled. Once all are dead with
  a nonce moved, it offers only cancelling, after "This launch's earlier
  signature may already have run. Check the project, then cancel this
  deployment to start over." A launch whose finalized nonce fell below a
  saved one holds, as the known limit above says.
- A payer deployment publishes raw factory calls, which carry no forwarder
  nonce or deadline and run only through a paid bundle, so there is nothing
  per request to classify. It quotes its raw calls again only once an
  uncached bundle read reports the old quote unpaid with every call pending,
  after the R104 proof when its payment reverted.
- Funding options must match the validated Relayr payment contract, native token,
  bundle identity, deadline, and destination network family. An unavailable
  selected chain cannot silently become another funding chain. Testnet calls
  never offer a mainnet payment. A project action keeps every option it
  authenticated, which the release proof checks; a quote offering more than
  the 16 it can keep is never paid, and its action quotes the same signed
  requests again.
- After funding review, the clients simulate the exact signed destination calls
  again before requesting payment. A stale nonce, changed prerequisite, or
  insufficient signed gas limit stops funding.
- Payment submission is journaled before asking the wallet to send. Once a
  payment might have been broadcast, a timeout or missing hash requires
  reconciliation of that attempt, never an automatic second payment. A payment
  is proven from the chain under the hash it was mined. One proven reverted
  leaves its quote to be paid once more, never replaced, with exactly the
  option it used (chain, calldata and amount), and only when the SDK's retry
  rule clears every payment sent for it: each reverted, the quote still open,
  and Relayr's bundle, read without a cache, unpaid with every call pending.
  Before that, one read of the bundle decides: a payment or a call running or
  run means another payment funded it, so its destinations are proven and it
  is never paid again. Once its quote expires, it is released as above, and
  until then every flow asks to try again later.
- Those rules are the SDK's (`@bananapus/nana-sdk-core/review/relayr`):
  `revertedRelayrQuote` (funded, payable or released), `relayrRetryOption`,
  `requireRelayrRetry`, `proveSavedRelayrPayment`,
  `relayrPaymentAttemptOutcome` and the saved record of a payment
  (`sentRelayrPayment`, `relayrSentPaymentsSnapshot`). This app supplies the
  clients and stores the journals. A journal the SDK cannot read exactly holds
  the quote: a padded amount or deadline, a payment of another bundle, a saved
  deadline that is not the one its calldata pays until, a bundle ID that is
  not a Relayr ID (never read), and a clock that is not a time.
- Relayr's response supplies candidate transaction hashes. Completion requires
  checking the exact destination transaction and its canonical receipt. Safe
  execution additionally needs its Safe transaction proof.
- Partial execution remains partial. A provider failure label, a missing bundle,
  or wall-clock signature expiry alone does not prove a destination never ran.
  Unknown outcomes retain their recovery records.
- The six project batch journeys persist the full reviewed plan and its selected
  participants before submitting. Each completed round is saved before its
  underlying Relayr journal clears; reloads resume the original plan. A queued
  Safe proposal remains pending until its exact execution is proven. A definite
  wallet rejection before publication permits a new review; unknown submissions
  remain blocked against replay.
- Saved direct attempts retain their original transport when testnet support
  becomes available. They must be recovered or safely abandoned before starting
  a fresh relayed action. Money's older project-batch journals retain their
  original mainnet-only eligibility; new same-family testnet batches use Relayr.

On 2026-09-07, the live `https://api.relayr.ba5ed.com/v1/chains` response listed
all eight supported chains. Read-only `eth_chainId` and `eth_getCode` requests
also verified the existing payment address
`0x1c05f7841379d4393574c0ffa17908ec40ffd97d` on chain IDs 11155111, 11155420,
84532, and 421614. Each returned the same 297-byte runtime and expected Keccak-256
hash `0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6`.
The payment address, selector, and runtime allowlist remain unchanged.

Recovery is browser-local and some ambiguous outcomes need wallet activity or
external transaction evidence. Money preserves the exact published requests for
unpaid recovery. Juicescan preserves publication fingerprints instead of signed
calldata; an unpaid quote can reopen in the same session, while reloading during
publication or unpaid funding requires external reconciliation. An unknown
publication must stay blocked rather than mint fresh authorizations. The
deterministic tests exercise the clients' decisions; they do not establish a
successful live Relayr deployment.

## Implementation references

- Money: `src/lib/authority.ts`, `src/lib/relayr.ts`
  (on the SDK's `@bananapus/nana-sdk-core/review/relayr`),
  `src/lib/project-batch.ts`, `src/lib/payer-relayr.ts`,
  `src/lib/project-distributions.ts`, `src/lib/project-token-batch.ts`,
  `src/lib/shop-batch.ts`,
  `src/lib/launch-relayr.ts`, `src/components/project/QueueRulesetFlow.tsx`,
  `src/components/project/SafeQueueCard.tsx`,
  `src/components/project/AuthorityEditsCard.tsx`,
  `src/components/project/EditSplitsFlow.tsx`.
- Revnet Money: `src/hooks/useReviewedRelayr.ts`,
  `src/hooks/useMultichainBatch.ts`, `src/lib/multichain-guards.ts`,
  `src/lib/payout-receipts.ts`,
  `src/components/TransactionReviewProvider.tsx`.
- Juicescan: `src/relayr.js`, `src/relayr-ui.js`, `src/discover.js`,
  `src/action-plan.js`, `src/distribution-plan.js`, `src/credit-claims.js`,
  `src/auto-issuance-aggregate.js`, `src/shop-media.js`, `src/create-flow.js`.
- Money's exact request and recovery test inventory:
  [Transaction coverage](../test/TRANSACTION_COVERAGE.md).

## Validation of the six project batch groups (2026-09-07)

Money passed 1,238 tests across 141 files, including its coverage gates, plus
TypeScript, lint, source invariants, transaction inventory, and the deterministic
production build. The inventory records 33 Safe-hook sends, 13 authority
boundaries, and three reviewed direct-write boundaries. The issuance coverage
floor follows the moved write/recovery code into `ProjectTokenBatchFlow.tsx`.

Money's home and create routes now fit their unchanged 428/485 KiB gzip
ceilings: 423.2/481.1 KiB, down from 436.2/501.4 KiB before lazy review/editor
loading. The global transaction queue stays ready while the complete decoder
and review dialog load only on request. A loading dialog cannot authorize a call;
loading failures, cancellation, and unmount decline pending requests. Rules and
shop editor drafts stay in the create form when their UI unmounts between steps.

Aggregate JavaScript measures 2,407.9 KiB gzip: the six project groups and recovery
first measured 2,402.8 KiB, and splitting UI across separately compressed files
adds 5.1 KiB while lowering initial route downloads. The aggregate cap is 2,410
KiB, leaving 2.1 KiB of headroom. Largest-chunk, CSS, wallet laziness, and the new
transaction-dialog laziness assertion pass. The preceding setters build measured
2,386.1 KiB aggregate.

Money's full 34-test browser suite and strict fixture audit pass after correcting
mobile navigation overflow and tablist structure. Desktop metadata checks compare
vertically centered row items, and the home fixture selects its intended Trending
feed. The final create walkthrough checks rules and shop drafts across editor
unmount/remount, including per-chain supplies. Deployment configuration passes
using the documented repository origin and revision; see
[deployment validation](deployment-validation.md). Nonbrowser source, dependency,
inventory, and offline registry checks pass. All 37 production GraphQL documents
also validate against both live Bendystraw schemas; all 236 pinned deployment
entries were verified against their original local git objects.

Revnet passed full coverage with 1,271 tests and one skip, plus all 105 browser
tests with retries disabled. Its delayed-hydration search regression also passed
three focused desktop repetitions. TypeScript, lint, dead-code checks, formatting,
dependency integrity, environment/deployment/source checks, 44 independent protocol
artifacts, its 126-site wallet inventory, production build, and standalone checks
passed. The native bundle checker now accepts deployment query suffixes and
measures 607.3 KiB for the largest route, 841.3 KiB of route-referenced JavaScript,
and 2,543.6 KiB aggregate gzip, within the original budgets. The existing documented
public development defaults restored missing local configuration.

Both Money and Revnet now reject failed or malformed npm audit reports instead
of treating absent vulnerability data as a clean audit. Local subprocess
regressions verify this behavior without registry access. The live advisory audit
remains unrun: automatic approval review rejected uploading private dependency
metadata to the npm registry without specific authorization.

Juicescan passed 1,479 tests across 162 files with coverage thresholds, followed
by 150 targeted Safe tests, 69 phase/helper tests, and 47 final boundary tests.
Its source check covers 240 JavaScript files and its transaction inventory records
103 occurrences in 22 modules. The production bundle and generated-file checks
pass. Final app size is 9,000,252 bytes raw and 1,322,865 bytes gzip; total
distribution gzip is 2,068,905 bytes. This adds 119,772 raw and 28,519 gzip bytes
to the preceding setters build. Caps are 9,001,000 raw / 1,323,000 gzip for the
app and 2,070,000 gzip for the distribution. Deployment parity remains separate:
the local deploy-all-v6 checkout is `9dea556…`, while Juicescan pins `20883a7…`;
deployment pins were preserved.
