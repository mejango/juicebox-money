# Relayr journeys across the V6 clients

Relayr pays for independent destination calls with one native-token payment on
Ethereum, Optimism, Base, or Arbitrum. An ordinary wallet signs each destination
request, reviews the available funding options, and pays on its selected chain.
The clients continue to use their existing direct and Safe transaction routes
where forwarding is unsuitable. This integration uses user-paid Relayr; it does
not introduce Center gas sponsorship.

## Action coverage

| Journey | Juicebox Money | Revnet Money | Juicescan |
| --- | --- | --- | --- |
| Multichain creation | Relayr for supported mainnets and an ordinary wallet; saved launch configuration and per-chain recovery | Reviewed Relayr deployment | Reviewed Relayr deployment |
| Queue rulesets | Selected eligible project chains, with a live baseline and controller for each chain | Intentionally unavailable: revnet stages are fixed | Multichain queueing, including supported hook-deployment variants |
| Project profile (`setUriOf`) | Selected chains through the authority router | Selected chains through reviewed Relayr | Selected chains through the operator editor |
| Token name/symbol (`setTokenMetadataOf`) and deployment (`deployERC20For`) | Selected chains; each destination updates or deploys its own token | Selected chains; each destination updates or deploys its own token | Selected chains through the token editor |
| Ownership/operator changes | Selected chains through the authority router | Operator changes across its project group | Changes across the matching authority group |
| Operator permissions | Selected chains; preserves unknown permission IDs | Read-only permission view | Selected chains; preserves unknown permission IDs |
| Buyback hook, router terminal, TWAP | Selected chains with destination-specific addresses | Selected available chains | Selected available chains |
| Payment terminals, controller, accounting tokens | Selected chains where the ruleset permits the action | No general editor | Selected chains where the ruleset permits the action |
| Edit existing splits | Current reserved address recipients on selected eligible mainnets; other split groups individually | Multichain split-recipient update | Applicable multichain split operations |
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
to addresses. Payout groups, project recipients, custom hooks, Safe accounts,
and testnets use individual edits until their destination mappings and routing
are established. The review shows each chain's resulting allocation and owner
remainder; changing one group does not replace other groups.

Money's ruleset editor applies changed fields to each selected chain's own
baseline. Unedited metadata, hooks, splits, and fund-access limits stay local to
that chain. Token-denominated changes need an established mapping on every
selected chain. The confirmation shows the expected start on each chain because
existing ruleset calendars and approval hooks can differ. Selections requiring
Safe execution, testnets, and mixed authorities can still be edited individually.
Older owner editors still require individual submissions for unsupported
forwarding targets or repeated calls on one chain. The six project batch
journeys above have a durable per-call journal: eligible mainnet calls use
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
  Another action must resolve that reservation before funding conflicting calls.
- Funding options must match the validated Relayr payment contract, native token,
  bundle identity, and deadline. An unavailable selected chain cannot silently
  become another funding chain.
- After funding review, the clients simulate the exact signed destination calls
  again before requesting payment. A stale nonce, changed prerequisite, or
  insufficient signed gas limit stops funding.
- Payment submission is journaled before asking the wallet to send. Once a
  payment might have been broadcast, a timeout or missing hash requires
  reconciliation of that attempt, never an automatic second payment.
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

Recovery is browser-local and some ambiguous outcomes need wallet activity or
external transaction evidence. Money preserves the exact published requests for
unpaid recovery. Juicescan preserves publication fingerprints instead of signed
calldata; an unpaid quote can reopen in the same session, while reloading during
publication or unpaid funding requires external reconciliation. An unknown
publication must stay blocked rather than mint fresh authorizations. The
deterministic tests exercise the clients' decisions; they do not establish a
successful live Relayr deployment.

## Implementation references

- Money: `src/lib/authority.ts`, `src/lib/relayr.ts`,
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
