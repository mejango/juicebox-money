# Full parity build (user 2026-07-16: "do them all", incl. split hooks +
# per-chain payout amounts & item supply)

Order minimizes rework. Commit per batch; Sepolia sims per encoding change.

- [x] B1 P5 issuance base currency (ETH/USD choice; project-wide, encodes
      per-ruleset — website has per-stage granularity, ours is one choice)
- [x] B2 smalls: P17 custom cash-out tax %, P16 tags, P18 ToS checkbox,
      P19 25MB media
- [x] B3 flavor batch: P12 custom approval-hook address (+per-chain),
      P13 router terminal toggle, P15 per-chain owner/operator, P14 verify
      custom token on every selected chain
- [x] B4 splits batch: P10 split locks (fixed-duration stages),
      P11 pay vs add-to-balance for project payout splits, split HOOK
      recipients (custom hook addr + optional projectId/beneficiary; Fund
      market LP option for reserved splits)
- [x] B5 P4 surplus allowance: capped amount + currency; owner-surplus
      toggle alongside routed payouts
- [x] B6 P2 multi-token payouts (per-context modes/amounts) + per-chain
      payout AMOUNT overrides (website has data model only; jango adds UI
      there)
- [x] B7 store batch: P8 categories, P9 per-item flags + voting units,
      per-chain item supply overrides, P7 revnet operator store
      permissions, P6 revnet auto-issuances
- [x] B8 P1 suckers/chain linking (CCIP via SDK parseSuckerDeployerConfig; omnichain deployer for linked projects): bridge choice (native/ccip/both),
      parseSuckerDeployerConfig both flavors, omnichain deployer + shared
      salt for projects
- [ ] B9 P3 Relayr pay-once — DECISION FOR USER: keep per-chain signing
      (simple, no third-party dependency, works today) or integrate
      Relayr's bundle API (one gas payment, but adds quote/refund flow +
      external service dependency). website has Relayr; jbm could keep
      per-chain as a deliberate simplification.
- [ ] P20 network toggle: SKIPPED as architecture — jbm is env-scoped per
      network (bendystraw + wagmi config baked per deployment); flag for
      user sign-off
- [x] B10 native-bridge suckers — DONE (nana-sdk-core 1.2.0, jbm 9ada54d):
      "Linked by" selector (CCIP / Native bridges / Native and CCIP) under
      the chain chips; plan.bridge → parseSuckerDeployerConfig. 'native'
      gated by nativeBridgeViable (exactly Ethereum + one L2, ETH-only
      accounting — the SDK throws on other pairs and silently drops USDC
      mappings otherwise); 'both' always safe (falls back to CCIP per
      pair/asset). Sim shapes linked-native-bridge-project +
      linked-both-bridges-project PASS on Sepolia.

Watch: website/ baseline a1ef87b (see memory jb-jbm-website-parity-watch).

## B11: Project-page tabs + pay-card parity with website/ (2026-07-16)
Directive: functionally identical to website/'s tabs + pay card — the only
difference is copy/prioritization targeted at mainstream users. Use the SDK
(nana-sdk-core v6 helpers) where possible. Revnet-aware (bendystraw isRevnet
is already in PROJECT_FIELDS, currently unused).
- [x] Research: specs committed in tasks/b11-specs/ (tabs, paycard, transactions)
- [x] Foundation: ProjectTabs/SubTabs + useSafeTx (simulate-first) — f32c771
- [x] Page restructure: revnet-aware header + Overview + Owner/Operator shell — d9029d6
- [x] Funds tab + sendPayoutsOf/useAllowanceOf (bdc9aed)
- [x] Rulesets (custom) + Terms (revnet) read-only tabs (3e0804c)
- [x] Tokens/Owners tab: Accounts (You/All bars), Reserved/Splits + claim &
      distribute txs (5f23489). Settlement/Market subtabs still pending.
- [x] Shop tab read-only (5f23489); +Add items CTA pending (write flow)
- [x] Extras tab (.jb export, payer deploy) — 703ab26
- [x] Pay-card upgrade (488b37a): mode select, index-valued multi-token
      selector from live contexts, 721 shop strip→metadata, verified-preview
      min, ERC-20 approve step, start-gate. STILL TODO: router-swap pay
      (ETH/USDC via JBRouterTerminalRegistry + Permit2) and direct-AMM-swap
      bypass — deferred, current card only offers directly-accepted tokens.
- [ ] Cash-out upgrade (fee layering, buyback/direct-sell routes, revnet
      delay lock) — existing CashOutPanel works for treasury route; upgrade
      pending
- [~] Owner/Operator back-office: account/transfer + permissions +
      deploy/rename ERC-20 DONE (a13806a); still pending: Powers card
      (mint/feeds/terminals/controller/migrate/setToken), buyback/router
      card, Safe queue
- [ ] Revnet: loans, auto-issuance; multichain: bridges/movement, gossip
- [ ] GRAPHS (port all, jbm style = CashOutCurve-like hoverable SVGs):
      (1) revnet price chart on Overview — component READY (a13806a), wire
      with floor/AMM reads; (2) Terms projected-issuance ladder — DONE
      (a13806a); (3) holders distribution — DONE as bars (5f23489);
      (4) Market subtab LP composition bar + liquidity-by-price depth chart
      (with Market subtab) — PENDING. Graphs 1-3 DONE (issuance ladder,
      price ceiling c4ec8b1, holders bars).
- [x] Queue ruleset + edit splits — DONE, wired into Rulesets (2b5f4b8).
- [x] Powers card + buyback/router — DONE, wired into back-office (2b5f4b8).
- [x] Revnet loans + auto-issuance — DONE, Owners subtabs (2b5f4b8).
- [x] Settlement composition/bridges/move/sync — DONE (2b5f4b8). CLAIM is
      fail-closed: no merkle-proof source in SDK/bendystraw (documented gap).
- [~] Market subtab (AMM price + LP charts) — building (agent).
- [x] OwnersTab subtabs wired (Settlement/Loans/AutoIssuance); Market pending.
- [ ] Final adversarial audit (custom + revnet) + production build.
- [ ] Reorganize TreasuryCard to website/'s pay-card functionality
- [ ] ALL project-page transactions from website/ ship complete + safe:
      owner (metadata, queue rulesets, payouts, allowance, splits, mint,
      deploy ERC20, permissions), holder (claim, transfer credits, burn,
      cash out, revnet loans), 721 shop buys, sucker chain moves. Every tx:
      simulation before send, displayed min == sent param, confirm step.
- [ ] Revnet awareness everywhere (vocabulary, operator, stages, loans,
      auto-issuance, cash-out delay)
- [ ] Full adversarial audit (agents): custom project + revnet coverage,
      math correctness, gating correctness
- [ ] Sims/typecheck/build + browser verification on real projects

# Ruleset #2 start control (jango 2026-09-03: "cycle N times / until date, then custom ruleset")
- [x] launch.ts: deriveStartFrom mirror + DEADLINE_SECONDS; encoder sends stage.mustStartAtOrAfter for every stage (0 = next boundary, unchanged default)
- [x] DraftStage: startMode cycles|date, startCycles (default 1), startDate; Timing "Starts" control on stage 2+ (project flavor); summaries
- [x] draft.ts sanitize new fields
- [x] CreateForm: absolute mustStart chain (scheduled / multichain pin / now), notice-vs-start gate (also covers standby+terminal), Cycle blurb points at Custom…
- [x] tests: deriveStartFrom + encoder passes later-stage start; vitest 935 green + tsc + eslint; rendered via gstack browse (cycles / date / notice clash)

Review: default N=1 still encodes 0, so existing launches are byte-identical. Single-chain unscheduled
stage 1 starts at the deploy block, so "N cycles" is exact as long as the tx lands within one
ruleset-1 duration of clicking Launch (deriveStartFrom snaps up otherwise → one extra cycle).
The notice gate also catches the pre-existing silent failure where a Wait/Terminate closing ruleset
started sooner than the deadline hook allowed. Not committed — awaiting go-ahead.

# Published SDK switch (2026-10-05)
- [x] Inspect PR, dependency references, and failing CI.
- [x] Replace preview SDK with published core 2.19.0 and remove preview artifacts.
- [x] Regenerate lockfile and investigate the existing production audit failure: node-forge has no patched release; preserve the audit gate.
- [x] Run CI-equivalent verification and review the final diff.
- [x] Prepare the verified change for the existing PR branch and update its release-integration description.

Review: published core 2.19.0 has identical distributed SDK code to the preview. Locked install, 1,979 unit tests with coverage, 57 browser tests, production build, client budgets, lint, typecheck, dependency/source/container/schema/transaction/dead-code checks, and 252 pinned protocol entries across eight chains passed with Node 26.7.0 / npm 12.0.1. Production audit still fails on inherited node-forge GHSA-86w9-cpqp-85rv; npm reports no patched release. No audit exceptions or gate changes. Original working checkout remains untouched.

# Production audit advisories (2026-10-05)
- [x] Read how Para 3.15.0 uses node-forge. Seven files generate and restore an RSA key pair, unwrap shares with RSA-OAEP, convert keys to and from PEM, and use AES-CBC, SHA-256 and random bytes. No Para code verifies a signature, so GHSA-86w9-cpqp-85rv's code path is never reached.
- [x] Allow GHSA-86w9-cpqp-85rv by advisory id at high severity, only while the source check of Para's node-forge usage matches that audit (jango, 2026-10-05: Para's audit findings don't block merges until Signa replaces Para).
- [x] Move source-map-js to 1.2.2 for GHSA-68fv-2mgg-jv7q with a lockfile-only update; postcss already accepts ^1.2.1.
- [x] Prove an unknown advisory still fails: unit cases, and the live audit on the old lockfile, which names only source-map-js.

Review: Para's own JavaScript is identical in jbm and revnet, so one audit covers both. The new gate failed live on the old lockfile and named only source-map-js, then passed on 1.2.2. `npm run check` passed with Node 26.7.0 / npm 12.0.1: dependency, dead-code, audit, container, lint, typecheck, source, protocol (fixture mode), schema (38 documents), transaction inventory, coverage (179 files, 1,995 tests), browser build, client budgets and browser checks (57 passed, inside the shared gate lock).

# SDK 2.21.0 adoption (2026-10-06)
- [x] Take @bananapus/nana-sdk-core 2.21.0 exactly; the lockfile changes only the SDK.
- [x] Delete jbm's copies the SDK now holds: the Center lag retry, the pre-review account check, the strict Relayr payment wrappers, the Safe wait's not-found wrapper, the server's 429 rewrite and the Relayr bundle guard.
- [x] Give every Safe execution wait its flow's signal (required by type; components read useUnmountSignal), with an abort leaving the proposal submitted.
- [x] Find a batch queued through MultiSendCallOnly 1.4.1, show the count a reserved distribution sent, say View as's refusal without a dash.
- [x] Hand every page's Bendystraw read its signal, and the relay the browser request's.

Review: refactors first, behavior changes tests first. Budgets measured on the same toolchain: main 434.4/502.1/2507.0 KiB (home/create/all), SDK 2.21.0 alone 435.1/503.0/2508.2, this branch 435.3/503.3/2509.0; caps 436/504/2510. Gate: lint, types, knip, audit, container, source, protocol, schema, transaction inventory, 2,461 unit tests with coverage, 57 browser tests in the shared gate lock, production build last.

# SDK 2.22.0 Relayr session rules (2026-10-06)
- [x] Take @bananapus/nana-sdk-core 2.22.0 exactly; the lockfile changes only the SDK.
- [x] Delete jbm's copies of the finalized-block reads, the request classification, the verdict, the deadline check, the discard-reason guard and the dead-session decision, and call the SDK's, in relayr.ts, launch-relayr.ts and forwarder-authorization.ts.
- [x] Keep what the SDK leaves to the app: saved sessions, lines and errors, the forwarder lock, the R104 quote-release helpers.
- [x] Pin the differences the SDK states: a block that is not a block reads as unknown, each request is read for its own signer, and a recheck the node could not answer holds (ruling R118), JB Center's -32001 after its retries included.

Review: no jbm test called a moved function by itself, so none was deleted. Seven tests fail on the old copies and pass on the SDK's: the lock's two reservation cases, which now expect each request's signer, the new two-signer case, the three unknown-block cases, and the R118 case. Budgets on the same toolchain: main 435.3/503.3/2508.9 KiB (home/create/all), SDK 2.22.0 alone 435.3/503.3/2508.9, this branch 435.3/503.3/2509.4; caps 436/504/2510. Gate: lint, types, knip, source, transaction inventory, 2,466 unit tests with coverage, 57 browser tests in the shared gate lock, production build last.

# SDK 2.23.0 Relayr release, retry and payment-proof rules (2026-10-06)
- [x] Take @bananapus/nana-sdk-core 2.23.0 exactly; the lockfile changes only the SDK.
- [x] Delete relayr-payments.ts and jbm's copies of the quote release (ruling R104), the retry option and rule, the attempt outcome, the saved-payment proof and the sent-payment record, and call the SDK's, in relayr.ts, launch-relayr.ts, payer-relayr.ts and the account view.
- [x] Keep what the SDK leaves to the app: readRelayrBundle for relayrPoll, which counts Relayr's 404s, and relayrQuoteReleased, which only the account view's line reads.
- [x] Pin each difference the SDK states, in this app's own flows: amounts and deadlines the SDK reads as numbers, lists, bundle IDs, the unreadable twin, the clock after the bundle and a clock that is not a time, the saved deadline bound to its calldata, and a payment of another bundle.

Review: no jbm test called a moved function by itself, so none was deleted, and no existing test changed beyond taking sentRelayrPayment from the SDK. Eleven of the twelve new tests fail on the old copies and pass on the SDK's; the twelfth pins the clock read after the bundle, which both read. Budgets on the same toolchain: main 435.3/503.3/2509.5 KiB (home/create/all), this branch 435.3/503.3/2509.7; caps 436/504/2510. Gate: lint, types, knip, audit, container, source, protocol, schema, transaction inventory, 2,481 unit tests with coverage, 57 browser tests in the shared gate lock, production build last.

## Concurrent Safe execution checks (2026-10-06)
- [x] Trace initial checks and payment rechecks; inspect shared RPC quota.
- [x] Run independent chains with at most two concurrent checks, preserving each chain's safety sequence and batch order.
- [x] Drain all checks before releasing busy state; any failure prevents quoting/payment.
- [x] Verify overlap, ordering, failure gating, and existing Safe flow tests.

Plan review: use a bounded worker owner for both check phases; keep transport and nonce-dependent wallet writes unchanged. Center quotas are shared by origin/IP and site, so concurrency cannot guarantee avoiding rate limits.

Concurrency review: combined 90 tests passed across nine files (Safe queue/review, worker bounds/order/drain, Safe orchestration and authority); changed-file ESLint passed. `npm run ts:check` passed after removing one obsolete generated route type for the absent project-diagnostics endpoint. No RPC transport changes; provider rate-limit failures still prevent quote/payment.

## 2026-10-06 — Readable Safe confirmations, final verification
- [x] Reuse queue labels and exact queued calldata for signing, direct execution, and Relayr batch review.
- [x] Show nested actions before Safe execution arguments; preserve raw fallback.
- [x] Test canonical decoding, actual batch rendering, consent, and both concurrency phases.

Final review: 90 focused tests pass; full suite has 1,722 passing and seven failures in unchanged launch encoding tests (the installed SDK requires an explicit 721 configuration/defaults choice). No launch source or dependency files changed in this task. Typecheck and changed-file ESLint pass. Both requested UX changes are implemented locally; not deployed.

Rebase review: preserved current origin/main SDK 2.23.0 rules and shared MultiSend decoding; installed locked dependencies without changing manifests. The seven previously reported launch failures pass on this matching checkout and SDK. Source invariants, transaction inventory, dead-code check and changed-file ESLint pass.

Rebased verification: full suite passed 2,512 tests with two concurrency fixtures requiring the upstream snapshot owners and object-form payment API; both fixtures corrected and all 13 queue tests now pass. Final typecheck and ESLint pass. No remaining test failures.

## 2026-10-06 — Destination pending-payment inventory
- [x] Query and authenticate pending payments by destination project; retain source in committed calldata.
- [x] Refresh persisted operation registry and isolate destination query caches.
- [x] Add destination/source regression coverage and run focused tests, types, lint and registry check.

Plan review: keep inventory ownership in pending-payments.ts; unchanged permissionless retry and saved actions remain available.

Review: destination inventory includes incoming calls from sources 6 and 9, excludes source-only pages, rejects unrelated destination and malformed source rows, and preserves original commitment/calldata. New retry activity belongs to the destination; legacy saved attempts accept their original source activity metadata. Registry regenerated. Focused data/component tests, typecheck, changed-file lint and offline registry check pass. Browser fixture updated for unequal source/destination; browser suite not run.

## 2026-10-06 — Relayr batch for pending routing payments
- [x] Trace existing direct batches, gateway permissions, and raw Relayr recovery patterns.
- [x] Add one Relayr bundle for independent pending-payment calls, including repeated destination chains.
- [x] Keep exact payment/call binding, progress recovery, live rechecks, and legacy direct attempts.
- [x] Update pending-payment review copy and add focused regression tests.
- [x] Run focused tests, types, and changed-file lint; document results.

Plan review: gateway retries are permissionless and retain original committed beneficiaries; raw requests avoid a forwarding wrapper near the transaction gas limit. Ordinary authority actions retain their existing chain sequencing. Coordinate transport implementation across both apps before changing recovery logic.

Review: new independent pending payments quote as one raw Relayr bundle, including repeated destination chains, with one funding payment and per-call outcomes. Existing false-tagged saved attempts keep their original direct/Safe recovery. Shared raw funding lifecycle was extracted from payer deployments first (49 payer tests passed before/after), then reused. Exact gateway calldata, commitment/failure state, gas cap and bounded raw eth_call are checked before quote/funding; inventory and rechecks use two workers. Canonical receipt matching binds quote UUID plus virtual nonce and calldata, including reverted siblings. 178 focused tests, typecheck, changed-file ESLint, transaction inventory, source invariants, dead-code check and diff check pass. No wallet transaction, commit or push performed.

Destination recovery follow-up: enumerate and authenticate old source-scoped journals by committed destination calldata, show unfinished destination participation, and resume the original scope/action unchanged. Fresh actions use route-destination-payments to avoid legacy alias collisions. Multiple legacy journals are offered one at a time; all-completed pending journals can finish without resending. Added corresponding regressions and lesson. Full suite passes 2,542 tests across 190 files. Full typecheck, changed-file ESLint, source invariants, transaction inventory and dead-code check pass. Full-suite source scan required naming the shared lifecycle callback saveState (persist is reserved for query tags); pre-existing queue recovery tests now install their required Web Locks fixture.

## 2026-10-06 — Pending inventory remains visible during checks
- [x] Separate destination discovery from paced live validation.
- [x] Render discovered payments during checks and distinguish saved selection from inventory count.
- [x] Cover delayed checks, failures and saved subsets; run focused tests, typecheck and lint.

Plan review: retain the two-worker verification owner and exact saved recovery set. Inventory refresh invalidates discovery and verification together.

Review: inventory and two-worker RPC verification now have independent caches, with a new inventory namespace for the changed response shape. Indexed rows stay visible while checks run; errors retain their rows and disable unverified attempts. Saved progress appears separately from the full inventory total. 69 focused component/data tests pass, including saved3/live7, delayed two-worker checks, failed checks and initial loading; full typecheck and changed-file ESLint pass. No commits or pushes.

## 2026-10-06 — Replace untouched pending-payment drafts
- [x] Inspect journal exposure markers and shared alias locks.
- [x] Classify untouched drafts in the journal owner; replace only under old/new locks.
- [x] Let untouched selections review the current inventory; preserve in-flight recovery.
- [x] Add race/exposure regressions and verify tests, types, and lint.

Plan review: absence of confirmed receipts is insufficient. Require absence of submissions, Relayr publications/rounds/bindings and sessions; reread under locks before replacement. Retain the abandoned draft tombstone.

Review: an untouched saved selection now reviews all currently eligible payments. Replacement retains the old tombstone and rechecks submission/publication/session evidence under every original and new alias lock. In-flight or ambiguous records still resume unchanged, including malformed retained Relayr data. The modal binds its original recovery identity and requires reopening after a replacement consumes that identity. 163 focused tests (including empty raw-session corruption), full typecheck, changed-file ESLint, source invariants and diff check pass. No commit or push.

## 2026-10-06 — Explain and recheck saved pending-payment recovery
- [x] Inspect raw quote release and persisted recovery evidence owners.
- [x] Show the reason a saved batch remains recoverable despite zero handled calls.
- [x] Reuse the raw lifecycle expired/unfunded proof for a read-only recheck under original alias and raw-session locks.
- [x] Verify recovery guards, focused tests, typecheck, and lint.

Plan review: rechecking never quotes, signs or pays. Only a quote with authenticated payment options whose deadlines are past at canonical finalized blocks and whose SDK bundle read proves unpaid/pending permits abandoning the old project intent. Paid, unknown-send, malformed, and forwarded records retain recovery.

Review: saved recovery now explains its evidence and offers Re-check saved batch without starting any signature or payment. The shared raw lifecycle release predicate verifies every authenticated payment deadline on finalized canonical blocks and then SDK unpaid/pending proof; both fresh re-quoting and recovery release use it. Advanced local clocks and unsupported quote options cannot authorize release. 155 focused tests, typecheck, changed-file ESLint, source invariants and diff check pass. No push.

## 2026-10-06 — Pace RPC starts instead of waiting for chain checks
- [x] Inspect shared browser transport and independent-check owner.
- [x] Start all independent checks and pace actual browser RPC fetch starts.
- [x] Verify slow-response overlap, order, error drain, aborts and rate-limit cooldown.

Plan review: keep wallet submissions sequential and all-check gates intact. One browser scheduler serves every chain; server requests do not share a process-wide queue.

Review: browser RPC requests now start at least 125ms apart across every chain and provider retry, independent of response completion. Abort removes unsent work and HTTP429 cooldown applies across chains. Independent checks start together and drain before quote/payment decisions. Full unit suite passes 2,576 tests across 191 files, including real SDK browser transport overlap; full typecheck, changed-file ESLint, source invariants and diff check pass. The existing Center retry fixture now advances fake wall time with timers so pacing can progress. No commit or push.

## 2026-10-06 — Safe quote recovery account and storage checks
- [x] Trace the unavailable-session error and exercise actual journal serialization through the rendered flow.
- [x] Bind read-only checks to the saved account while keeping funding tied to the connected wallet.
- [x] Show shared recovery results for missing quotes and canonically consumed Safe nonces.
- [x] Cover reload, legacy account mismatch and missing-quote recovery; run focused tests, types and source checks.
- [x] Build in an isolated checkout and measure client budgets.

Plan review: current quote/create/reload/fund path must retain its original journal identity. Safe-scoped records can belong to a different wallet; status checks use their saved identity and payment requires the original wallet. The shared SDK remains the only owner of release decisions.

Review: opening a saved bundle clears stale errors and immediately checks its saved account. A payable saved quote still requires explicit call review; journal replacement or removal cannot open the wallet. The shared SDK supplies missing-quote explanations and canonical nonce results, and consumed-nonce release refreshes the queue without claiming successful execution or payment expiry. Recovery rows retain the saved transaction identity. Complete legacy proofs keep exact reservations; partial funding evidence remains unresolved and malformed financial history fails closed before normalization. Real browser-storage caller tests reproduce the legacy account error and cover fresh four-chain quote identity through reload/funding/recovery; fresh preparation alone did not reproduce the reported automatic error. Focused caller/transaction tests, full types, changed-file lint, source invariants, transaction inventory and diff checks pass. Isolated production builds with identical SDK dependencies measure 2518.4 KiB on HEAD versus 2519.2 KiB with the fix (+770 bytes); 2520 KiB is the minimum rounded aggregate ceiling. All route, largest-chunk, style and lazy-loading gates pass unchanged. No wallet transaction, commit or push.

Published-package verification: both apps now pin SDK2.24.1; all745 installed SDK dist files match the tested preview. Removed temporary vendor files. Final346 focused JBM tests, full typecheck, source/transaction gates and whitespace checks pass; the full2617-test suite passed before the final targeted regressions. The final missing-ID button label passes46 modal tests. No wallet transaction or client push performed.

## 2026-10-06 — Replace unused Safe quotes with the current selection
- [x] Use the SDK's quote-replacement decision for the queue entry point and single-slot persistence.
- [x] Preserve contradictory legacy funding evidence and persist SDK retirement before replacement.
- [x] Exercise actual storage through lost quote, changed selection, new review, new quote and one explicit payment.
- [x] Verify cancellation, ambiguous funding, stale tabs, source boundaries and client checks.

Plan review: quote publication is not a wallet funding attempt. The SDK owns replacement eligibility and retirement under the existing Safe lock, after the current selection passes validation and review. The app normalizes legacy evidence, persists retirement before replacement, and renders the shared decision. Existing or ambiguous funding remains recoverable.

Review: the normal Execute action now handles an unused quote, including a lost response, through the shared SDK classifier. The SDK's single-session store mode protects the existing Safe-scoped journal while reviewing a changed selection. Legacy hashes, payment history, unresolved sends and execution records remain visible to that classifier; malformed nested record containers fail closed. Real-storage tests replace received/lost four-chain quotes with the current three-chain calls, then explicitly fund the new bundle once. Cancellation preserves the original journal, and funding recorded by another tab during review blocks replacement. All 2,639 unit tests across 192 files pass, including 359 focused Safe/Relayr tests. Full types and lint, source invariants, transaction inventory and whitespace checks pass. No wallet transaction or app publication performed.

Published-package verification: SDK 2.24.2 is installed from the registry and all 745 distribution files match the verified preview. Repeated the full checks after the locked dependency installation: all 2,639 tests, full types and lint, source invariants, transaction inventory and whitespace checks pass. No further app source changes were needed.

## 2026-10-07 — Load account and Safe queue information independently
- [x] Render verified authority addresses per chain without waiting for every account classification.
- [x] Share display-only account identity queries and start Safe queue reads while those checks are pending.
- [x] Keep unknown account types retryable and transaction authority checks fresh.
- [x] Verify partial-chain loading, retries, write controls, handle tuples and existing authority flows.

Plan review: the Account card, Safe queue, badges, batch tray, editors and Safe-owned project list consume the same read-only identity query. Each chain progresses independently; no completed account check grants transaction authority. The query loads SDK and wallet modules lazily to keep the header lightweight. Failed identity reads remain unknown, and transaction boundaries continue to recheck current authority, Safe policy and nonce before writing.

Account review: strict live authority reads and shared canonical account classification progress per chain. Verified addresses and candidate queue groups render while other classifications are pending; full resolved authority tuples remain available to handle checks. Unknown classifications expose Retry and withhold transfer/deployment controls. Nineteen loading, Safe deployment, permission and Relayr-discard tests pass, including delayed authorities and identities, null/error retry, and stale indexed candidates excluded from queue discovery. Typecheck and changed-file lint pass. Queue integration and final app checks are tracked by the coordinating task.

Shared display review: all component Safe identity reads now use this query owner, including the badge, batch tray, editors and Safe-owned projects. Transaction identity reads remain fresh and internal to the transaction module. All 67 account/tray/loading/deployment/queue-service tests and 69 editor/ruleset tests pass, including one identity read shared by an Account card and badge, and by two projects owned by the same Safe. Changed-source lint, dead-code, source and transaction-inventory gates pass. The full run exposed one test-only concurrent-import mock issue; module spies fixed it while preserving the queue assertions. Final combined SDK integration verification remains with the coordinating task.

Safe progress review: rendered caller tests use the real SDK controller and journal through a delayed quote response, wallet rejection, confirmed funding, independently arriving execution receipts and background completion. The quote request has its own phase; a pending wallet request removes the Pay action, and definite rejection restores the same unpaid quote. Exact destination receipts and Safe success events produce independent Executed/Confirming links, then refresh both queues after completion, with one quote and one payment. Explicit failed destination records remain Failed. All 70 focused modal/adapter tests and the full 2,652-test suite across 193 files pass against the frozen SDK preview; full types, full lint and whitespace checks pass. Published-package and production verification remain with the coordinating task.

## Browser verification repair for Safe quote release (2026-10-07)

## Plan refinement

- **Objective:** Complete the full production browser gate against the existing destination-owned pending-payment inventory and retained disabled actions while checks run.
- **System fit:** PendingPayments already owns live inventory and readiness; this changes only browser expectations and the deterministic read fixture, preserving application execution and funding authority.
- **Reuse and simplicity:** Reuse the current browser gate, existing verification latch and strict fixture matcher; replace the stale hidden-panel assertion and source-project fixture query with the current contract.
- **Evidence and unknowns:** The first full run passed 55/57 tests; both failures expected an absent panel during checks, and teardown rejected the new destination query. Baseline ac8430c already implements the visible inventory and destination query.
- **Verification:** Assert all 3 rows visible and all 4 routing controls disabled before releasing verification, preserve retry/finalization/cooldown assertions afterward, then rerun the full 57-test browser suite and fixture audit using the existing isolated production build.
- **Resource budget:** Two test-only edits, one full suite rerun; no new build for fixture-only changes, no app changes, wallet sends, dependency changes or relaxed fixture acceptance.

- [x] Update browser pending inventory assertion and destination fixture.
- [x] Rerun full browser suite and fixture audit; record source hashes and result.

Review: isolated production build passed with Node 26.7.0 / npm 12.0.1 / sharp 0.35.5 and the final preview SDK dist. Unchanged budget gate passed at 2,548,919 gzip bytes (2489.2KiB); all 57 browser tests plus strict fixture audit passed after the two test-only corrections. Relevant-file ESLint passed; source and installed SDK hashes remained unchanged through verification. Evidence: `/tmp/safe-quote-replacement-builds.Cs0JWc/juicebox-{source-manifest,browser-source-manifest,sdk-manifest,final-hash-diff,runtime,sizes}.json` and `juicebox-{build,budget,browser}.log`. SDK metadata is 2.24.1 until the parent matches final published 2.24.2 dist bytes. No budget or production code edits, commits, pushes or wallet actions.


### Published dependency graph verification

The official SDK 2.24.2 and sharp 0.35.5 installation changed the installed dependency graph, so fresh isolated production and full browser gates were rerun: build passed; all 57 browser checks plus fixture audit passed. All 1,116 installed package manifests, the installed lockfile, and all 745 SDK dist files stayed unchanged through verification. Only concurrent task notes changed.

The unchanged budget gate measured home 447,501 B and create 517,399 B above the old 436/504 KiB caps. A controlled ac8430c baseline used the same final dependencies with only the official SDK 2.24.1 override, whose tarball SHA512 matched the committed lockfile. Baseline home/create were 447,505/517,401 B, so the current change is 4/2 B smaller. The release owner approved only the minimum 438/506 KiB caps; aggregate 2520, project 570, largest chunk 450, CSS 20 KiB and all lazy-loading checks remain unchanged. Current aggregate is 2,580,108 B, 50 B below the controlled baseline.

Evidence: `/tmp/safe-quote-replacement-builds.Cs0JWc/published-juicebox-*`, `baseline-juicebox-*`, and `official-sdk-2.24.1-proof.json`. The old SDK backup differed from the verified archive and was not used. No wallet action, commit or push occurred in verification.


### Post-push Linux CI aggregate budget correction (2026-10-07)

CI run 37562644216 for commit 15d83b70 passed its production build, but aggregate JavaScript measured 2521.7 KiB against the 2520 KiB cap. Every route, largest chunk, stylesheet and lazy-loading check passed. The local published build measured 2519.6 KiB; the controlled local baseline/current comparison was 2,580,158/2,580,108 B (-50 B). The precise source of the cross-environment output difference has not been established.

The release owner approved only the minimum aggregate ceiling of 2522 KiB. Home/create/project ceilings remain 438/506/570 KiB, largest chunk 450 KiB, CSS 20 KiB and all lazy-loading assertions remain unchanged. The amended gate on the retained published build, script lint, source checks and diff checks all pass; no runtime changes or repeated full build/browser runs were needed. The parent owns committing, pushing and observing the next CI run, including the browser gate skipped after this budget failure. CI evidence: `/tmp/jbm-ci-37562644216-failed.log`.


### Safe progress and Account loading preview verification (2026-10-07)

The isolated physical dependency clone builds successfully with Node 26.7.0/npm 12.0.1 and CI flags; all 57 production browser tests plus strict fixture audit pass. All 115,570 dependency files/links and source inputs stayed unchanged. This remains preview evidence until official SDK 2.24.3 and the final installed graph are reconciled.

A controlled 75841bd baseline with the identical physical dependency graph and integrity-verified official SDK 2.24.2 measured 2,582,256 gzip bytes; current Account/queue display reads and per-chain Safe progress measure 2,587,564 bytes (+5,308). The release owner approved only the minimum aggregate ceiling of 2527 KiB. Route ceilings 438/506/570 KiB, largest chunk 450 KiB, CSS 20 KiB and every lazy-loading assertion remain unchanged. The amended budget gate passes against the retained preview output, along with script lint, source guards and diff checks. Evidence: `/tmp/safe-progress-final-verification.y3xQVa/juicebox-budget-comparison.json`, `juicebox-preview-*`, `juicebox-baseline-*`. No additional build/browser run was needed for this budget/comment-only adjustment.

Published SDK 2.24.3 is now reconciled: all 745 SDK dist files, the full physical runtime dependency graph and application source match the tested preview. Every difference was inspected: SDK version/lock metadata, Vitest timing/order cache, the approved budget checker and task notes. The retained build, all budget checks and 57 browser passes therefore qualify for the official package; local evidence is ready. No repeated build/browser run was needed. The parent owns remote Linux CI confirmation. Full manifests and qualification: `/tmp/safe-progress-final-verification.y3xQVa/juicebox-published-comparison-summary.json` and `juicebox-published-*.json`.

## 2026-10-07 — Make automatic Safe checks passive

- [x] Replace the empty quote selector and disabled action with one accessible progress indicator until a quote exists.
- [x] Preserve dismissal, quoted payment controls and all execution/recovery states; cover delayed checks and quotes.
- [x] Run focused Safe suites, types, touched lint, source and whitespace gates; coordinate desktop/mobile preview evidence.

Plan review: the workspace plan refinement is approved and passes its gate. SafeQueueCard continues to display SDK phases; this change only renders the preparation state passively, without altering quote, funding or recovery decisions. Reuse existing Tailwind spinner styles and keep the current per-chain row layout.

Review: automatic preparation now renders one accessible spinner/status message. The empty payment selector and idle primary button are absent until a real quote exists, and the duplicate body phase notice is hidden during preparation. The close control remains available; quoted funding, wallet rejection, execution and recovery behavior remain covered. All 77 focused Safe modal/service/adapter tests, full types, touched-file lint, source invariants and whitespace checks pass. The coordinator owns visual evidence: existing deterministic fixtures need an inert connected-wallet state to mount the actual SafeQueueCard, so no new application route was added for screenshots.

Production verification: actual four-chain checking/quoting/quoted dialog markup was captured from the existing component test, then the test was restored byte-for-byte. The refreshed isolated production build passes with unchanged source/SDK hashes. Aggregate JavaScript measures 2,587,667 B, up 103 B on the same dependency graph and 19 B above the old ceiling. The release owner approved only the minimum 2528 KiB aggregate cap; route/chunk/style caps and lazy assertions remain unchanged. The amended gate against that build, script lint, source guards and diff checks pass. No build/browser repeat was needed for this budget/comment adjustment. Evidence: `/tmp/safe-modal-visual/jbm-provenance.json` and `/tmp/safe-progress-final-verification.y3xQVa/juicebox-modal-*`. The parent owns desktop/mobile visual review and remote CI confirmation.

## 2026-10-07 — Share existing cross-chain activity grouping

- [x] Replace the local matching loop and six-hour window with the shared SDK helper while preserving renderer signatures and output.
- [x] Run unchanged activity regressions and affected static checks after the shared export is available.

Plan review: the approved workspace refinement extracts the existing Juicebox policy before changing Revnet. The app keeps its renderer-specific event signature and project-scoped wrapper; the SDK owns distinct-chain matching, representative order and the time window. Queries, financial formatting, home/account feeds and transaction behavior remain unchanged. Package installation and publication stay with the coordinating task.

Review: ActivityList now adapts each existing group into the shared helper and restores the unchanged `{group, chains}` shape. The local matching loop and window are removed; display signatures and all existing tests are untouched. All 42 unchanged cross-chain, same-transaction and activity-metadata regressions pass against the real SDK preview export, as do full types, source invariants, targeted lint and whitespace checks. The coordinator owns the official SDK 2.24.4 pin and final publication gates.

Official package qualification: root manifest and lockfile now pin published core2.24.4 with verified registry integrity. All753 distribution files match the tested preview; unrelated physical dependencies and runtime sources are unchanged. The qualified production build measures2,587,907B (+240B) and passes the unchanged2528KiB aggregate limit plus all route/chunk/CSS/lazy guards. The final actual-package cross-chain/same-tx25-test rerun and exact-toolchain dependency check pass. Hosted CI and live revision checks are tracked by the workspace release checklist.


## 2026-10-07 — Keep anonymous browsing free of wallet initialization

- [x] Remove only the root provider's idle Para mount; preserve intent preload, sign-in/add-funds, and marked-session restoration.
- [x] Add wallet-enabled provider regressions covering native idle and timeout fallback after page load, intent preload, explicit requests, and marked sessions.
- [x] Verify the focused wallet suites, touched lint, full types, and source invariants; production build/browser evidence belongs to combined integration.

Plan review: use `/Users/jango/Documents/jb/v6/evm/docs/WEBSITE_PERFORMANCE_IMPLEMENTATION.md` (refinement gate passed), root `AGENTS.md`, pinned `workflow/ponytail/SKILL.md`/`README.md`, `docs/PLAN_REFINEMENT.md`, and relevant root/app lessons. Existing Para context, lazy host, reconnect marker, and module preload already own the behavior; remove the conflicting unsolicited mount without introducing a second wallet loader. The new provider tests run with Para enabled, and both idle cases fail on the original provider while explicit requests and session verification pass. The installed Next16.3.8 lazy-loading guide confirms the existing conditional React.lazy boundary is appropriate.

Review: all 32 focused wallet tests pass, including the new provider idle regressions and existing connector restoration/auth/host behavior. Full types, touched-file ESLint, source invariants, and whitespace checks pass. Independent read-only review found no blockers. Existing browser builds intentionally disable Para, so these enabled-provider timing regressions provide the direct guard; a production-environment browser network capture remains part of combined integration verification. No build, dependency installation, push or deployment was performed in this worktree.
## 2026-10-07 — Shared project display reads and progressive tabs

Authorized by the website performance implementation plan at `/Users/jango/Documents/jb/v6/evm/docs/WEBSITE_PERFORMANCE_IMPLEMENTATION.md`; its refinement gate passed before edits. Workspace AGENTS, pinned Ponytail, plan-refinement checklist, applicable lessons and installed Next/TanStack guidance were read.

- [x] Extract existing project read contracts without changing execution, then separately share the existing TanStack cache across display consumers.
- [x] Reuse current/upcoming rulesets for 15 seconds, accounting contexts/history for 60 seconds, and the existing project-token symbol contract for 5 minutes. Keys include protocol, chain, project and history size; account-position keys retain holder scope.
- [x] Capture the expiry of evidence actually consumed by composed queries. A cache hit retains its original age; a new read is conservatively bounded from request start. Persisted compositions carry their expiry with a versioned envelope, selected away before rendering. Failure fallbacks remain immediately retryable.
- [x] Cancel pre-confirmation in-flight display reads before invalidation following actual successful transaction receipts. Safe proposals alone do not invalidate. Direct batch completion integration is handled by its owning flows.
- [x] Render each Funds chain independently and current rules independently of history/upcoming reads. Partial funds are labeled and totals withheld until verified; failures expose retry. Stable ruleset IDs preserve selection when delayed history arrives.
- [x] Preserve final transaction simulation/authority/nonce/expiry guards. Optional market display readers share accounting evidence; omitted readers used by execution guards still read live and resolve the project's actual controller.
- [x] Verify full local unit suite (196 files, 2,668 tests), TypeScript, full ESLint, dead-code check, source invariants and whitespace checks. Added in-flight deduplication, TTL expiry, invalidation, failed-read recovery, delayed-composition refresh, slow-chain and slow-history regressions. Independent cache review accepted the corrected expiry and invalidation boundaries.
- [x] Integration owner completed locked-install release/build/browser checks on the combined application changes; details follow below.

### Review

Current/history/accounting and token-symbol reads have one owning query contract. Composed query freshness lives with the consumed data instead of looking at a dependency's potentially newer cache timestamp; tests cover both renewal during a slow computation and a pre-write response arriving after a receipt. Wallet and transaction preparation caches are not persisted through this display owner. Existing chart range/style controls use local state and do not change these query keys; alias history transitions remain with the navigation workstream.
## 2026-10-07 — Bounded transaction preparation reuse

Required shared instructions read at `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `workflow/ponytail/SKILL.md`, `workflow/ponytail/README.md`, `docs/PLAN_REFINEMENT.md` and `tasks/lessons.md`; app AGENTS/lessons and installed Next client-component/testing guides also reviewed. This task implements the preparation subset of `docs/WEBSITE_PERFORMANCE_IMPLEMENTATION.md` in an isolated checkout.

## Plan refinement

- **Objective:** Reopening the same split/distribution/redemption draft within five seconds reuses successful preparation reads; changed identities, expired reads and failed reads fetch again. Explicit review, signature and final execution checks retain their live reads.
- **System fit:** Existing component query owners collect editor evidence, existing review functions freeze exact requests, and existing authority/transaction runners revalidate and simulate execution. Synchronous localStorage journal discovery is recovery state, not network evidence, so its immediate reread remains intentional. Confirmed mutations invalidate preparation and the shared display owner; queued Safe proposals alone do not imply execution.
- **Reuse and simplicity:** Reuse TanStack Query and the current query keys, plus one small shared five-second freshness policy for preparation. Add the missing redemption metadata target to its key. Retain existing forced refetch and pending-journal checks; no generic evidence cache, transport wrapper, dependency or refactor is needed.
- **Evidence and unknowns:** Source traces show split review/send calls readSplitDestination directly, distribution review/send calls reviewReserved/reviewPayout/reverifyDistribution directly, and redemption review forces refetchQuote before frozen request creation. Failed per-chain rows are existing error values and must stay immediately stale. Shared display invalidation is being implemented independently and integrated as an explicit dependency.
- **Verification:** Run real QueryClient regressions for within-window reuse, expiry, invalidation, error retry, partial failure and chain/project/account/metadata/selection isolation through actual components. Run unchanged split, distribution, queue and redemption review/recovery tests plus targeted lint and source checks. Root owns final combined type/build/browser release gates.
- **Resource budget:** One small policy and existing component owners; parallel Revnet diagnostics remains isolated. Stop and replan if reuse reaches final send guards or evidence identity is incomplete. No installs, builds, production writes or external side effects in this task.

- [x] Apply five-second successful-preparation reuse and exact identity keys.
- [x] Invalidate owning preparation/display queries after confirmed execution and preserve retry/recovery freshness.
- [x] Verify real-query reuse and unchanged money/recovery gates; record final evidence.

Review: successful network preparation now reuses exact identities for five seconds. Split destination/live/fallback reads, distribution options and NFT redemption quotes use the shared policy; rejected/partial reads and errors retaining earlier data remain immediately stale. Redemption identity includes its metadata target. Explicit redemption review, direct split/distribution review and final authority/simulation/send checks still read fresh. LocalStorage split/ruleset recovery queries intentionally retain zero stale time: they are cheap synchronous recovery discovery, not network preparation.

Confirmed writes invalidate preparation and the shared display owner. Per-receipt distribution invalidation advances independently of pending destinations, and verified chains are not invalidated twice when their batch completes. Split/ruleset failures conservatively invalidate affected display/preparation because earlier calls may have completed, without asserting execution; queued Safe results alone do not invalidate. The existing journal locks and retained recovery behavior are unchanged.

Verification: Node 26.7.0, installed Vitest 4.1.10; 136 affected tests across nine files pass (17 new actual QueryClient/component freshness tests plus partial-distribution/recovery checks). Replacing the lease with always-stale behavior fails nine new regressions; source was restored byte-for-byte. Full Next route type generation and TypeScript check, touched-file ESLint, source invariants, transaction inventory and whitespace checks pass. Independent review found the partial-success invalidation gap and it was closed with regressions. No dependency install, build, push or deployment. Integration must include the independently owned project-display-queries.ts helper before this commit; a local copy was used only to test that dependency and is excluded from this commit. Root owns final combined release/browser gates.

## 2026-10-07 — Keep display invalidation out of the read dependency graph

## Plan refinement

- **Objective:** Restore the existing home/create/all-script bundle caps after shared display caching without changing reads, TTLs, review, mutation or recovery behavior.
- **System fit:** Confirmed mutation receipts currently import the read-factory module only to expire cached display evidence; move its existing key/invalidation contract to a lightweight owner so wallet/create consumers do not load display SDK reads. Query composition and final execution guards remain unchanged.
- **Reuse and simplicity:** Extract the existing project key and cancellation-before-invalidation functions verbatim, and the project-token query into a separate owner because WalletButton also imports it eagerly; switch every caller and retain one home per key/predicate/query. No new cache, dependencies, policy or budget increase.
- **Evidence and unknowns:** Baseline and integrated production builds use the same physical locked dependencies; home increased from 434.9 to 441.4 KiB and create from 503.0 to 518.4 KiB. The heavy read owner imports SDK reads, token helpers and persistence; its full factory exports appear in the layout chunk through mutation invalidation and WalletButton token reads. Production comparison will establish how much both import splits recover.
- **Verification:** Run existing real QueryClient freshness/invalidation and Safe/preparation receipt regressions, types and touched lint; build this isolated checkout with the same deterministic script and run unchanged bundle budgets. Inspect module/chunk evidence before declaring the cause resolved.
- **Resource budget:** One isolated worktree from 2728bb6, shared read-only locked node_modules, one read-only chunk-analysis delegate, no install or root edits. Replan only if the measured split does not restore caps; preserve the full authorized performance result.

- [x] Extract lightweight project display cache identity/invalidation and token-query ownership and migrate every caller without behavioral changes.
- [ ] Verify unchanged race/freshness/receipt behavior and controlled production bundle budgets.

Extraction review: 234 affected tests, touched ESLint, source invariants, TypeScript through the controlled production build, and whitespace checks pass. With the same physical locked dependencies, home falls 441.4 → 437.5 KiB and all scripts 2538.1 → 2527.5 KiB, both within unchanged caps. Create falls 518.4 → 514.5 KiB and still exceeds its 506 KiB cap; remaining duplicate modules are under investigation. No read, TTL, invalidation, send, recovery or cache key behavior changed.

## Plan refinement

- **Objective:** Remove the remaining create bundle regression within the unchanged 506 KiB cap, preserving every server-cache and navigation freshness guarantee.
- **System fit:** Server project identity/data owners currently import a cache class through the React adapter barrel; Next registers its client hooks on every route, duplicating existing provider and application code. Use the same cache class directly from its server-safe core package.
- **Reuse and simplicity:** Pin the already installed query-core 5.101.4 as an explicit dependency and change only two server imports. Runtime identity confirms React Query re-exports this exact QueryClient class. No new implementation or dependency version is introduced.
- **Evidence and unknowns:** Baseline route manifests contain zero React Query client modules; current manifests contain all thirteen, introduced by these two server imports. Core-import production comparison will establish whether removing the accidental client boundaries also removes create duplication before considering a broader provider/config extraction.
- **Verification:** Run server identity/display freshness tests, dependency-tree validation, source checks and another same-dependency production build with unchanged budgets. Root integrates the separate navigation freshness follow-up; this commit alters no cache policy.
- **Resource budget:** Two import lines plus manifest/root-lock metadata, no install or dependency reification. One controlled build after focused tests; leave existing Providers/config ownership alone if caps pass.

Server-import review: 35 server resolution, data freshness, streaming, invalidation and API tests pass; touched lint, whitespace checks and production TypeScript pass. Runtime QueryClient identity and unchanged lock package graph are verified; only the direct dependency declaration was added. Production total falls 2527.5 → 2519.8 KiB; create 514.5 → 511.8 KiB remains above 506, and home rechunks to 438.1 KiB (438 cap). The remaining modal/full-route-provider coupling is delegated to the navigation owner. npm ls cannot validate this symlinked node_modules checkout (it classifies the linked package tree as extraneous); root must repeat the dependency-tree gate after integration. No install or physical dependency change occurred.


## 2026-10-07 — Combined performance verification

All application changes are integrated on `codex/performance-20261007`. Final application source is f5e293f; 40d8ed2 changes only measured bundle limits. Full pinned Node 26.7 / npm 12 locked-install checks pass: dependencies/audit/container definition, lint/types/source/dead code, pinned deployments, live+offline schema and transaction inventory; 212 unit suites / 2,763 tests with coverage; production build; all bundle/lazy/style gates; 59 Chromium browser tests including real handle navigation at 390/1280px. The production image passed read-only/non-root readiness and exact version checks. Real Para browser verification observes zero guest runtime downloads or initialization after six seconds, intent-only preload, and explicit sign-in/marked-session initialization; vendor requests were blocked, so this is not an authentication test.

Controlled comparison uses matching physical dependency contents and a common deterministic ENS transport/fixture overlay on baseline 096540c. All 20 original desktop/mobile journeys pass with zero unknown fixture reads or page errors. Reentry removes the baseline's two project reads and six contract reads in the observed mobile phases. Original assertion-completion timings are mixed and retain Playwright polling delay. A separately reviewed three-run mobile diagnostic records actual click-to-DOM readiness: entry 2367→2329 ms, reentry 541→438 ms; following-frame reentry 542→442 ms. These are local fixture observations, not paint measurements or production forecasts.

After removing duplicate imports, clean physical baseline/final gzip totals are 2,588,016/2,592,848 bytes. Only measured ceilings are rounded: home 439, create 507 and aggregate 2533 KiB; other project/largest/style/lazy limits remain unchanged. The earlier symlink-based passing measurements are superseded by the physical integration build.

Independent source, cache/invalidation, alias/review and measurement-method reviews are complete. Verification records and limitations are in `/Users/jango/Documents/jb/v6/evm/docs/WEBSITE_PERFORMANCE_IMPLEMENTATION.md` and `docs/performance/2026-10-07-verification.json`; raw checks remain under `/private/tmp/jb-performance-checks`. No push or production deployment was performed. All owned browser, fixture and container processes are stopped.

## 2026-10-07 — Load Terms independently of heavy project tabs

Required root resources (`AGENTS.md`, pinned `workflow/ponytail/SKILL.md` and `README.md`, `docs/PLAN_REFINEMENT.md`, root lessons), app instructions/lessons and installed Next 16.3.8 lazy-loading/package-bundling docs reviewed. The accepted scope and independent design review are in `/Users/jango/Documents/jb/v6/evm/docs/WEBSITE_PERFORMANCE_RELEASE_FOLLOWUPS.md`.

## Plan refinement

- **Objective:** Reduce first-Terms JavaScript transfer while retaining immediate local loading feedback, populated terms, repeated-tab state and later heavy-tab functionality; retain all existing bundle caps.
- **System fit:** Change only `LazyProjectTabs`' Terms import to its existing `TermsTab` owner and remove its `DeferredProjectTabs` re-export. Project navigation, query evidence/freshness, transaction preparation, authority, execution and recovery owners remain unchanged.
- **Reuse and simplicity:** Reuse Next dynamic imports and the existing Terms skeleton; leave the six other tabs grouped. No warmup, preload registry, routing/cache policy or dependency changes; the existing clean import boundary needs no extraction first.
- **Evidence and unknowns:** The first-batch physical build and ten matched browser journeys download 180,159 script response bytes on first Terms. Static module analysis motivates separation but does not establish savings; actual final manifest/network evidence must prove the result. Physical locked dependency bytes and symlink targets match first-batch integration.
- **Verification:** Run focused tab/display tests and all required repository gates after final edits. Compare production chunk/transfer evidence, existing route/aggregate/lazy budgets, numeric and alias navigation, direct Terms entry, Terms before/after a heavy tab, retained repeat state, delayed loading and failed-chunk recovery through the existing error boundary. Reserve a quiet measurement slot with root before timing comparisons.
- **Resource budget:** Two application boundary edits, existing test owners and one controlled production build; no install, release-artifact mutation or independent deployment. Replan if the split duplicates SDK code, exceeds a cap or loses existing behavior. Root owns release and cross-app timing coordination.

- [x] Split only the Terms import and remove the old barrel export.
- [x] Verify production module separation, browser loading/recovery and existing repository gates.
- [x] Record actual first-Terms bytes and matched timing evidence; commit the bounded result for root review.

## Plan refinement

- **Objective:** Keep the measured Terms improvement and round only the aggregate ceiling from 2533 to 2534 KiB; retain every initial-route, largest-chunk, style and lazy-wallet limit.
- **System fit:** The application boundary and all financial/navigation owners are already verified. The existing budget checker owns this measured size decision; independent review and the preserved production artifact qualify the result.
- **Reuse and simplicity:** Keep the two-line import change. Webpack duplicates the existing small protocol-concepts text module; adding another API, shared chunk or configuration rule solely to save 783 bytes would complicate ownership without improving the measured user path.
- **Evidence and unknowns:** All 12 matched journeys transfer 180,159 bytes before and 3,604 after on first Terms, saving 176,555 bytes. Aggregate gzip output grows 1,727 bytes to 2,594,575; no SDK/ABI copies increase. Desktop first-Terms medians are 429.2→424.9 ms, throttled mobile 1429.3→421.3 ms; these small local fixture samples include assertion polling and do not establish production percentiles or paint timing. Root accepted this explicit tradeoff in the release/follow-up record.
- **Verification:** Preserve the original failing 2533 KiB check and all 12 observations; run the unchanged owning checker with the minimum 2534 KiB ceiling, script lint/source checks, whitespace checks and independent final review. All 2,763 unit tests, 64 production browser tests, types, dependencies/audit, protocol/schema and other source checks already pass for the runtime change.
- **Resource budget:** One numeric ceiling and explanatory comment, no application rebuild, new dependencies or further timing probes. The existing artifact and negative/positive budget results provide the regression evidence; root owns push and hosted release checks.

Review: the emitted Terms chunk is independent of the six heavier tabs, and SDK/ABI copies do not increase. Five new production browser cases use the emitted manifest and actual script requests to prove both tab orders, repeat reuse, numeric/alias/direct-hash entry, draft/document retention during delayed loading, successful one-reload recovery and bounded persistent chunk failure. Independent source, browser-test, bundle and measurement-provenance reviews pass.

Verification: pinned Node 26.7.0/npm 12.0.1 with matching physical locked dependencies; 18 focused tests, all 212 unit suites/2,763 tests with coverage, all 64 production browser tests, dependencies/audit/container, lint/types/source/dead-code, pinned deployments, live/offline schema and transaction inventory pass. The final owning budget check and changed-script lint pass after the accepted 2534 KiB refinement; the original failed 2533 KiB check is retained. Initial network/server checks were blocked by the sandbox and passed with the required network/local-server access. No runtime changes followed the successful build and browser checks.

Matched three-run desktop/mobile comparisons preserve every observation: first-Terms script transfers are 180,159→3,604 bytes in every run; repeated tabs and graph changes make no requests. Initial home/project/create gzip totals are 448,965/172,538/518,999 bytes; aggregate 2,594,575 bytes, with 241 bytes below the minimum revised ceiling. Raw checks and the complete `jbm-terms-split-navigation-comparison.json`, artifact comparison and dependency provenance are under `/private/tmp/jb-performance-checks`. Timing limitations and the approved tradeoff are recorded above and in the root release/follow-up record. No push or deployment from this worktree; all owned processes are stopped.

## 2026-10-07 — Describe transaction actions without background-service branding

Required root resources at `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `workflow/ponytail/SKILL.md`, `workflow/ponytail/README.md`, `docs/PLAN_REFINEMENT.md`, root/app lessons, app `AGENTS.md` and owning `docs/WEBSITE_PERFORMANCE_RELEASE_FOLLOWUPS.md` reviewed. Work is isolated from live `1f456a08`; the qualified performance source and artifact remain unchanged.

## Plan refinement

- **Objective:** Remove the background service's name from visible transaction progress, reviews, failures, saved recovery and public guide prose; retain useful chain, simulation and recovery context.
- **System fit:** Controlled copy belongs to the existing Safe queue, relay/payment review, authority/batch/launch owners and product descriptions. Existing `lib/errors.ts` and actual render boundaries use one lightweight `transaction-message.ts` presentation helper for SDK and historical messages; its import-free owner keeps review/viem modules out of basic UI imports. Signing, fees, call bytes, validation, lifecycle decisions, original error identity/cause, stored records and identifiers remain unchanged. Root separately owns simulation diagnosis and release.
- **Reuse and simplicity:** Reuse existing phase maps, `shortError`/`friendlyError`, `TxError`, `TxConfirmDialog` and existing Safe/recovery tests; add a single display-text helper only because SDK and historical records bypass those error helpers. Replace controlled prose at its owner; do not rewrite raw payloads, APIs, storage discriminators or dependencies.
- **Evidence and unknowns:** Read-only AST inventory found 93 human-readable Relayr fragments plus inherited SDK errors and recovery lines. Safe queue displays raw `Error.message`; SDK HTTP errors retain bounded chain/reason details and original response in `cause`. A neutral message does not resolve the eth:4 simulation failure, and a generic formatter cannot claim no payment was sent.
- **Verification:** Extend focused actual-component Safe queue pending/failure and historical recovery tests plus error formatting regressions; preserve original errors/cause, chain/revert reasons and uncertainty guidance. Run affected existing tests, lint, types, source/transaction/dead-code checks and an AST copy inventory. Root runs final combined build/browser/hosted gates after independent review.
- **Resource budget:** One writer in this isolated checkout, existing pinned physical dependencies and Node 26.7/npm 12; no install, build, push or deployment. Replan if presentation requires any execution/storage semantic change; coordinate matching language with the separate Revnet copy writer.

- [x] Replace controlled visible prose and route SDK/historical status/error text through the existing presentation owner.
- [x] Verify pending, failure and saved recovery rendering, preserved diagnostics/authority and affected static gates.
- [x] Record evidence and commit the scoped candidate for independent review.

Review: controlled Safe, payment, launch, project-action, recovery and public build-guide copy now describes the action without naming its background service. One import-free presentation helper covers SDK and historical error/status text through existing formatters and actual rendered sinks. The AST inventory retains all 49 original thrown diagnostic fragments unchanged and removes the 44 controlled visible fragments; internal API/storage identifiers and raw transaction review payloads remain exact. A recognized quote simulation failure keeps its chain and revert reason; generic failures preserve uncertainty and never infer payment or execution status. Original Error identity/message/cause and saved payment evidence are preserved.

Verification: pinned Node 26.7.0/npm 12.0.1, physical dependencies identical to the qualified performance tree (115,530 distinct files, 50 internal symlinks). All 212 suites / 2,767 tests pass with coverage, including actual SDK HTTP 406 failure rendering, deferred quote progress, historical account recovery, unchanged Safe/lifecycle safeguards and the existing authority payment review tests. Full lint, route types/TypeScript, source invariants, transaction inventory, dead-code and whitespace checks pass. The first focused run is retained: old copy selectors/assertions were updated and a raw-diagnostic marker was separated from legitimate call bytes in the fixture; no application retry or safeguard changed. Independent source review found no blocker. Evidence is `/private/tmp/jb-performance-checks/jbm-service-copy-*.log`, `jbm-service-copy-inventory.json` and `jbm-service-copy-physical-provenance.json`. No install, production build, browser run, push, deployment, signing or payment occurred; root owns final combined release qualification and the separate eth:4 simulation correction.

## Plan refinement

- **Objective:** Resolve PR117's measured create/aggregate client budget failure with the approved, measured ceilings while preserving neutral copy, diagnostic/recovery semantics and the shipped performance gains.
- **System fit:** The existing deterministic build and client budget checker own qualification. CI37696063294 passed unit/build/OCI but stopped at create507.2KiB and aggregate2534.4KiB; no promotion occurred. Root reviews the measured cause/options before any budget adjustment and owns push/release; original d3eeed7 evidence and the live baseline artifact remain immutable.
- **Reuse and simplicity:** Reuse the pinned physical dependency clone, existing build fixture, client budget checker and out-of-tree module snapshot tool. Inspect actual formatter placement and caller imports before changing source; no dependency changes, code golf, speculative refactor or automatic budget increase.
- **Evidence and unknowns:** CI retained coverage but no emitted build artifact. All185 preserved baseline chunks verify and live1f456a08 source matches9d0d58a. Matching package/lock/config/fixture inputs establish create518999→519278B (+279) and aggregate2594575→2595210B (+635). The import-free formatter emits twice within existing create/shared lazy chunk placement;185 chunks and initial-route file counts remain unchanged, with no heavy dependency or new eager chunk. Hosted create507.2KiB versus local507.1KiB is a small observed platform/codegen variance; aggregate agrees2534.4KiB.
- **Verification:** Preserve the first failing CI/local reports and the built d3 artifact. Run the owning budget gate on that exact artifact after changing only create507→508KiB and aggregate2534→2535KiB, plus budget-script syntax/lint, source invariants and whitespace checks. Verify runtime and test trees match d3 and retain the existing2767-test/static evidence; final exact-head hosted build/browser gates remain mandatory and root-owned.
- **Resource budget:** Root approved those two measured ceiling adjustments after cause review. Do not rebuild for this non-runtime cap change, alter other limits or optimize unrelated code. Keep the build/browser slot free and hand the scoped config/task commit and linked evidence to root for independent review and hosted qualification.

- [x] Verify preserved baseline/provenance and measure unchanged d3 runtime source.
- [x] Report causal module/route findings and choose the smallest reviewed correction.
- [x] Qualify the local budget-only successor and record evidence for root's remaining hosted release gates.

Review: the exact d3 runtime build reproduces the first hosted budget failure. Preserved baseline185 chunk hashes and all compared package/lock/config/fixture inputs verify. The one new import-free formatter appears in create and existing shared lazy chunk9653, with no new heavy import or initial chunk; home changes by-10B and the project manifest by+1B. Root approved rounding only create507→508KiB and aggregate2534→2535KiB for the measured+279/+635B cost. All other budgets and lazy-boundary assertions remain unchanged.

Verification: the existing d3 artifact passes the final budget gate, budget-script syntax/lint, source invariants and whitespace checks. Runtime source and tests are byte-identical to d3, so its independently reviewed2767-test/static evidence remains valid. No rebuild or browser run was performed for the config-only change. The first CI/local failures remain preserved. Measurement and provenance are linked by `/private/tmp/jb-performance-checks/jbm-service-copy-budget-comparison.json`; final budget/source/lint reports use the `jbm-service-copy-final-budget` and `jbm-service-copy-budget-*` names. Root must still run the exact successor through hosted build/browser gates before promotion.

## Plan refinement

- **Objective:** Use the exact label “Pay” on Juicebox's Safe batch payment CTA and the nested payment confirmation, as the user requested after confirming the quote works.
- **System fit:** SafeQueueCard owns the initial CTA and relayrPay owns the shared transaction-review confirmLabel for Safe/launch/raw payment callers. Only those two labels change; payment details, handlers, disabled states, checks and progress remain unchanged. Root separately explains the rechecking behavior and owns release.
- **Reuse and simplicity:** Change the existing literals and exact selectors in existing Safe payment regressions; extend the existing authenticated-payment assertion to require confirmLabel Pay. No new helper, rule, dependency or execution path.
- **Evidence and unknowns:** Source tracing found one initial label and one shared confirmLabel; the pre-payment and after-payment validation sequence is not changed by this copy request. The d3 artifact remains budget-diagnosis evidence and no longer qualifies the newly labeled runtime.
- **Verification:** Run the real Safe queue and shared payment orchestration regressions plus affected adapter/authority/launch/payer callers, lint, types, source/transaction checks and whitespace. Preserve financial/nonce/receipt assertions; root requires the exact new head's full hosted build/budget/browser gates before promotion.
- **Resource budget:** Two runtime literals, existing test selectors and one assertion; no additional live quote, simulation, wallet or local rebuild. Keep the separate approved budget-only commit and link prior evidence honestly, with the new focused/static results qualifying this small delta.

- [x] Update both labels and exact existing payment-flow assertions.
- [x] Pass focused/static checks and commit the separate copy delta for root review.

Review: SafeQueueCard's ready payment CTA and relayrPay's shared review confirmation now both say exactly “Pay.” The runtime diff contains only those two string replacements. All26 existing Safe button selectors now require the exact label, and the existing authenticated/simulated/reverified payment test also asserts confirmLabel Pay while retaining exact call/value/gas/receipt and recheck assertions.

Verification: all436 tests in seven affected Safe/payment/adapter/authority/launch/payer/raw suites pass, along with full lint, route types/TypeScript, source invariants, transaction inventory and whitespace. Reports are `/private/tmp/jb-performance-checks/jbm-pay-label-*.log`. No local rebuild/browser or live wallet/quote/transaction ran for this delta; the previous artifact proves the earlier measured budget diagnosis only. Root requires the final exact head's full hosted build, budget and browser qualification before deployment. Progress wording and all validation logic remain unchanged.

## Plan refinement

- **Objective:** Accurately track the user's submitted/wrapped Safe payment through independent, receipt-proven execution and show final payment validation at its actual phase, while retaining Pay labels, recovery reservations and exact financial safeguards.
- **System fit:** The shared SDK owns canonical funding proof, final beforeSend phase and post-submission inspection. createProjectSafeRelayr adapts its durable journal/events; SafeQueueCard renders those events and uses the existing controller.watch. The SDK writer adds payment-checking and recovers a post-send adapter error only on proven funding or complete exact destinations; the app must preserve the original diagnostic and no-Pay state otherwise.
- **Reuse and simplicity:** Reuse the actual SDK controller, existing adapter, storage and Safe queue regressions. Add only the approved phase label once its SDK preview qualifies, and distinguish saved submitted/ambiguous payment evidence from waiting for user funding in the existing row renderer. No extra poller, wrapper parser, funding policy, duplicated validation or relaxed authority check.
- **Evidence and unknowns:** Root's saved funding/event and four destination receipts establish the actual wrapped case; SDK2.24.4 only accepts direct outer payment identity. Current fund skips inspect after an adapter proof error, and beforeSend leaves payment-review stale. Existing tests cover successful independent slow-chain progress and durable recovery, but not a held nested review followed by delayed final checks or post-onSent adapter failure. Qualified preview365ebd65 supplies payment-checking, optional canonical-block getCode for wrapped proof and persistence-gated post-send inspection; its tarball SHA256 is a137b8db853940e931988f1d67780bfcc912d2c9c0d8f9215a419c9558201856. Its manifest remains2.24.4 and is preview-only; official publication/integrity remain pending. Old builds and approved6bcd12bc reports remain immutable.
- **Verification:** Preserve failing-before rendered submitted-hash status evidence, prove unfunded/rejected/pre-send states do not imply payment submission, and retain no-Pay behavior for unavailable/wrong proof. After SDK preview, add delayed nested-review/final-check and post-error/reopen independent-receipt regressions using actual controller/storage. Run affected adapter/payment/Safe tests and required static checks; official SDK lock adoption and full exact-head app CI/build/budget/browser gates remain root-owned.
- **Resource budget:** One app writer in this isolated tree; stage only the verified preview SDK package bytes with a preserved original package, unchanged app manifests/lock and no dependency re-resolution. No Next build, public quote/RPC test, wallet action, push or deployment. Archive the sole d3 .next diagnostic artifact before a later official-source build; require the official published package/lock before final qualification. Replan if the SDK result contract requires app recovery logic beyond the existing applyResult/watch path.

- [x] Regress and correct submitted/ambiguous funding status without changing unpaid behavior.
- [x] Integrate the qualified SDK preview phase/proof/recovery artifact and exercise deferred review plus independent receipt progress.
- [x] Run scoped preview qualification, record evidence and hand the app source head to root for official dependency adoption and release gates.

Status checkpoint: two new actual-controller/durable-journal regressions fail before on the incorrect Waiting for payment text, then pass after the guarded presentation change. Sending/submitted status, a saved payment hash or the SDK's normalized fundingObserved field now shows Checking payment status; ordinary unfunded/rejected-wallet states retain their existing behavior. Wrong/unavailable proof retains the saved hash and original reservation with no Pay action, new quote or second payment. All73 Safe queue/adapter tests, changed-file lint, types, source/transaction checks and whitespace pass. Before/after evidence is `/private/tmp/jb-performance-checks/jbm-payment-progress-before.log` and `jbm-payment-progress-status-after.log`. This checkpoint does not repair wrapped proof or post-error inspection; the qualified SDK phase/recovery artifact and its integration tests remain pending.


Preview integration review: the queue renders Preparing payment during the nested review and existing payment runtime/simulation preparation, then Checking before payment when the SDK enters its final beforeSend guards. Guard order and handlers are unchanged. The actual controller, adapter and durable journal demonstrate independent chain receipts, automatic inspection/watch after a post-onSent adapter proof error, and close/remount/reopen without another quote or payment. Completion waits for the delayed destination receipt; wrong or unavailable funding proof retains submitted evidence and never offers Pay. The actual relayrPay integration accepts a canonical wallet-wrapped funding event while retaining the reviewed payment details and original submitted hash; it does not infer the debited account from that event.

Qualification uses only the verified preview365ebd65 package bytes (tarball SHA256 a137b8db853940e931988f1d67780bfcc912d2c9c0d8f9215a419c9558201856), with all three app/installed package manifests and lock inputs unchanged and no dependency resolution. All 443 cases in seven affected suites pass, as do full lint, route types/TypeScript, source invariants, transaction inventory, dead-code and whitespace checks. The deferred phase test failed before the new mapping; the first broader run exposed incomplete canonical log metadata and old wrong-target fixtures whose receipt target contradicted their transaction. Those fixtures now provide consistent canonical negative evidence while retaining all original rejection, reservation and discard assertions; a separate inconsistent-RPC regression explicitly remains submitted/unavailable. Both original failed reports and the one intermediate reverted-target fixture correction are preserved.

Evidence: /private/tmp/jb-performance-checks/jbm-payment-progress-preview-affected.log and preview-{lint,types,source,transaction,dead-code}.log; jbm-payment-progress-sdk-preview-provenance.json records exact package bytes and unchanged manifests. The complete previous d3 .next artifact is archived read-only at /private/tmp/jb-performance-artifacts-20261007/jbm-service-copy-d3eeed7/.next; jbm-service-copy-d3-archive.json verifies all files and all 185 previously measured chunks. No Next build, browser, public RPC/quote, wallet action, push or deployment ran. The preview still declares2.24.4 and is not a release dependency; root must adopt the official published version/integrity and run exact-head release gates.

## Plan refinement

- **Objective:** Measure the qualified SDK preview's production client cost once, before official publication, so any material size-gate issue can be resolved without wasting a later full hosted release run.
- **System fit:** Root grants the sole local production-build slot for a diagnostic build of reviewed app fcd1f439 with exact SDK preview365ebd65. Existing deterministic build fixtures and client budgets own the measurement; this evidence does not authorize deployment or replace official package/lock qualification. The d3 artifact remains archived read-only with all 3,050 file hashes and 185 compared chunks verified.
- **Reuse and simplicity:** Reuse the same physical dependency graph, Node26.7/npm12 toolchain, build:browser script, fixture transport and owning budget checker. Compare route/aggregate/chunk/module changes to the preserved d3 artifact before considering any source or threshold change; no new dependency, duplicate build method or budget padding.
- **Evidence and unknowns:** Source, focused/static checks and the preview tarball are independently approved, but the preview still declares2.24.4. SDK package growth alone does not establish browser transfer cost. App manifest/lock bytes and all non-SDK dependency inputs remain unchanged; record exact build configuration, fixture and installed SDK hashes before the run.
- **Verification:** Run one diagnostic production build plus the unchanged budget gate, preserve any failure, and record exact gzip totals and affected emitted module placement against archived d3. Check every lazy-boundary assertion and inspect new eager dependencies or duplication before proposing narrowly rounded caps for root and independent review. Final official npm integrity, dependency install and full hosted CI remain mandatory.
- **Resource budget:** One serialized local build, bounded artifact inspection and no browser or external mutation/wallet traffic. Preserve raw logs and old artifacts; do not edit app source, dependencies or budgets during measurement. Stop and replan on a build failure or unmatched provenance rather than repeat blindly.

- [x] Capture matched inputs, run the diagnostic build and existing budget gate once.
- [x] Attribute route/aggregate growth, report exact evidence and release the build slot.


Diagnostic build review: the single preview production build and every unchanged budget/lazy boundary check pass. Compared with archived d3, home/project/create are 448,954/172,538/519,277 gzip bytes (one byte smaller each, attributable to generated build-reference variation rather than a performance gain). Aggregate is 2,595,778 bytes, +568 bytes, with 62 bytes below the existing 2,535 KiB ceiling. No budget or runtime edit is proposed from this passing local measurement; the small headroom is a limit of this evidence and the official-source hosted artifact remains decisive.

The graph retains 185 chunks, 1,995 emitted module copies and identical initial-route file counts of 22/5/29. The shared proof and Safe lifecycle modules each remain one copy in their existing lazy chunks, adding 480/62 gzip bytes at the chunk level with unchanged imports. The existing Operator chunk adds28 bytes, the payment adapter chunk has no gzip growth, and generated hashes account for the remaining net-2 bytes. The only changed module ID is the same 197-byte refreshProjectDisplay server reference in its prior three locations. Largest chunk, styles, the isolated Terms boundary and all vendor/review/diagnostic lazy checks remain unchanged. No accidental eager dependency or new duplication was found.

Evidence: /private/tmp/jb-performance-checks/jbm-payment-progress-preview-budget-comparison.json links the matched configuration/fixture/package provenance, full raw build and budget logs, both module/chunk snapshots, extracted owning modules and immutable d3 archive. Source fcd1f439 and SDK preview365ebd65 bytes were unchanged during the build; only this task record changed. The owning deterministic local fixture stopped, no browser/wallet/remote mutation ran, and the production-build slot was released. This is diagnostic evidence only, pending the official package version/integrity, exact dependency pin and final release qualification.

## Plan refinement

- **Objective:** Replace the verified payment SDK preview with the exact official core2.24.5 release while retaining the reviewed app behavior, tested package graph and immutable diagnostic evidence.
- **System fit:** Root owns registry-release verification and will supply the official tarball/integrity. This worktree owns only its exact app dependency and lock entry, installed core package bytes and corresponding installed-lock metadata; final hosted CI installs the official lock and owns full release qualification. Payment proof, controller/watch, copy, app code and budgets stay unchanged.
- **Reuse and simplicity:** Reuse the reviewed preview graph and compare the official archive file-for-file. If all753 non-manifest package files are identical and dependency/peer metadata is unchanged, update only the core version/resolved/integrity fields and exact root version, stage the official package physically while retaining any installed nested dependency directory, and preserve every unrelated lock entry without dependency re-resolution.
- **Evidence and unknowns:** Clean e0ea9996 is independently approved and its diagnostic build passes with only62 bytes of aggregate headroom. SDK version PR193 passed and merged3a0c1561; root now supplied verified official core2.24.5 from that gitHead, tarball SHA256 a8a1fb5501aab4c028129c4c393774cfff41d3f356ac931db453f13a7999adcc and registry SHA512 integrity. The SDK writer proved753 compiled files equal the preview and replayed the recorded funding/retry proof; independently verify those bytes and unchanged dependency metadata locally before adoption.
- **Verification:** Independently check the supplied tarball's SHA512 integrity and SHA256, exact package version/metadata and all753 compiled-file hashes against preview. Prove the manifest/lock diff is limited to the SDK pin, installed files match the official archive and all unrelated lock entries are byte-equivalent. Run local dependency-tree validation, type/source/transaction checks and whitespace, then commit the scoped adoption for final review. Reuse prior443-case and build evidence only with explicit file equality; final hosted full CI remains mandatory.
- **Resource budget:** Prepare now and wait for root's official signal. No new local production build, repeated preview suite, registry polling, general install/resolution, source/cap edit, push or deployment. Replan on any compiled-byte or dependency-metadata difference before extending verification.

- [x] Receive and verify the official package/integrity against the tested preview.
- [x] Adopt only the exact version/lock/package bytes, validate the installed graph and report the final clean head.


Dependency-layout check: the separate Revnet staging investigation exposed a possible lost nested-dependency risk. Juicebox is unaffected: both preserved original core directories have exactly754 package files and no nested node_modules, consistent with the initial package manifest. Explicit resolution from the current and preserved baseline SDK roots proves identical relative paths, lock versions and every package-file hash for bs58 5.0.0, its base-x 4.0.1 dependency, fpnum 1.0.0 and the installed optional graphql17.0.2 peer. No restoration or rebuild is needed, and the earlier Juicebox diagnostic remains valid. Evidence: /private/tmp/jb-performance-checks/jbm-payment-progress-preview-dependency-resolution.json (SHA256 a409bf1a756ab2d99e6fe578afaaf4a2abfa87b8358eaeaee95a5874d13d2a4b). Official staging must preserve nested dependencies if present and recheck this resolution graph, rather than relying only on archive-file equality.


Official adoption review: core2.24.5 is pinned to the registry URL and exact SHA512 integrity supplied by root, with gitHead3a0c1561 and tarball SHA256 a8a1fb5501aab4c028129c4c393774cfff41d3f356ac931db453f13a7999adcc independently verified. All753 non-manifest package files are byte-identical to the tested preview; only package.json's version changes. Staging therefore writes only the exact official package manifest in place, preserving every installed dependency directory. All754 installed package files match the official archive. Tracked changes are limited to package.json, the root/core SDK fields in package-lock.json and this task record; the installed-lock metadata is synchronized without dependency resolution.

Whole-graph verification matches all1,115 installed non-core locked packages and114,770 owned files against the preserved physical baseline, including every nested package. All199 absent locked paths match, as do all50 executable/internal symlink targets. The raw node_modules inventory differs only by two worktree-specific Jiti cache files for the Vitest and Playwright configs; the initial unclassified path comparison is retained, and those tool caches are explicitly separated from dependency contents. Every non-cache path and every unrelated locked package/file remains unchanged. SDK dependency resolution retains bs58 5.0.0/base-x4.0.1, fpnum1.0.0 and graphql17.0.2 at the same paths.

Final local dependency-tree validation, route types/TypeScript, source invariants, transaction inventory, plan and whitespace checks pass. Source, tests, build scripts, config and budgets remain identical to independently reviewed fcd1f439, so the443 affected cases and diagnostic build remain applicable supporting evidence through explicit compiled-file/graph equality. No redundant local suite/build, registry mutation, wallet action, push or deployment ran. Evidence is /private/tmp/jb-performance-checks/jbm-payment-progress-official-adoption.json, jbm-payment-progress-official-physical-graph.json and official-{deps,types,source,transaction}.log. Root still requires the final clean hosted npm-ci/full-tests/build/budget/browser artifact before promotion.

## Plan refinement

- **Objective:** Repair the four hosted launch browser failures caused by stale service-branded prose expectations, preserving every funding-chain, publication, authorization, saved-state and recovery assertion.
- **System fit:** CI37710507056 passed source/unit/build/budget/OCI and60 browser cases; the existing launch spec owns the four failed mainnet/testnet cases. Change only its two positive copy expectations and one negative copy expectation to the already reviewed rendered language. Root owns the refreshed full hosted run and release.
- **Reuse and simplicity:** Reuse the existing launch scenarios and independently qualified matching-source production artifact, whose compiled SDK bytes and physical graph match the official dependency. No app source, lockfile, cap, fixture behavior, timeout, retry or production build change.
- **Evidence and unknowns:** The preserved CI log identifies launch.spec.ts41/43/73 and the removed Relayr wording. Confirm replacement literals at their current render owner before editing; the local affected spec must pass with the same protected launch data and financial assertions. Preserve the unrelated server on4173 and use the existing configurable browser setup on a free port.
- **Verification:** Run the complete affected launch browser spec once against the existing artifact, plus changed-test lint, plan and whitespace checks. Preserve any first failure, immutable artifact hashes and reporter evidence. Require fresh full hosted CI for the final test-only commit before promotion.
- **Resource budget:** Root grants the sole browser slot; use pinned Node26.7/npm12 and existing deterministic fixture/Playwright setup without rebuilding. Start and stop only owned test servers, keep external writes/wallet actions absent, and commit only the test and task record.

- [x] Update the three stale expectations and run the affected launch spec against the preserved artifact.
- [x] Record the scoped evidence and hand the narrow test-only correction to independent review.


Review: the launch spec now expects the reviewed neutral launch instruction and saved-payment status, including the negative assertion that an unfunded launch does not show saved-payment checking. The only test edits are three string replacements; all funding-chain, publication, cancellation, draft-lock, saved-state, recovery and responsive assertions remain unchanged. No application source, dependency, budget, fixture, timeout, retry or global-audit behavior changed.

Verification: the complete affected launch spec runs against the preserved, source-equivalent preview artifact using pinned Node26.7.0/npm12.0.1 and the existing deterministic setup on owned ports3100/4399. All11 tests passed on their first attempt in4.6 seconds, with zero unexpected, flaky or skipped tests. The command exits1 solely in the unchanged global teardown because its full-suite required GraphQL/ABI reads are absent from this launch-only run; no unexpected-request, eth_call or Multicall audit failure was reported. Preserve this first result as scoped test evidence, not a passing full-suite gate; do not weaken or bypass the audit. Changed-test ESLint, plan and whitespace checks pass. The original log/report are /private/tmp/jb-performance-checks/jbm-launch-copy-browser.log and jbm-launch-copy-browser-report.json; the prior hosted failure also remains intact. No rebuild or unrelated server action occurred, owned test servers stopped, and root must run the exact final head through full hosted CI before promotion.


## 2026-10-08 — Shared client RPC and Safe execution owners

- [x] Replace duplicated RPC pacing with the shared SDK export.
- [x] Replace matching Safe execution rules with SDK calls while preserving each caller's accepted transaction shapes.
- [x] Run existing RPC, Safe proof and caller regressions plus source/lint/type gates; record exact preview and remaining root-owned qualification.

## Plan refinement

- **Objective:** Make Juicebox and Revnet consume the same SDK-owned request pacing and exact reviewed Safe execution proof as the other clients, preserving existing visible behavior, journal schema, wallet guards and recovery policy.
- **System fit:** App display/transaction flows retain their React/wagmi adapters and journals; SDK owns request-start pacing, exact reviewed calls and receipt execution evidence. Fresh wallet authority, submission and durable recovery retain their existing owners. Root coordinates the four-client architecture inventory, package staging and final build/browser verification.
- **Reuse and simplicity:** The two RPC implementations are identical apart from formatting. Extracted SDK exports replace the duplicated implementations through their existing app paths. Safe execution extraction reuses existing SDK decoding and receipt owners; Revnet's explicit single-call versus batch policy remains a required argument in its local wrapper. Pending-proposal timing and stamped-call policies differ and stay local.
- **Evidence and unknowns:** Baselines are the latest refreshed Juicebox 6a0598d and Revnet 1fcbf1f1. Existing tests cover 125ms pacing, aborts, 429 cooldown, canonical MultiSend deployments, exact order/value/data, immediate execution and strict single-call rejection. SDK exports are being implemented in the sibling isolated checkout and are unverified until its qualified package is staged. Installed Next 16.3.8 client-boundary/Vitest docs were read from the existing Juicebox checkout while clean physical dependencies are prepared here.
- **Verification:** Preserve and run existing RPC/Safe tests and the full affected transaction callers; source gates require the new shared owners. Run lint, types, source invariants, transaction/write-site checks and whitespace. Root owns exact preview staging with nested dependencies preserved, full suite/coverage, serialized production builds and browser journeys; no publication or deployment is part of this change.
- **Resource budget:** One writer owns both small caller migrations; the SDK agent owns extraction/tests, root owns installation and release gates. Reuse existing regressions rather than duplicate SDK unit suites. Replan before changing any acceptance set, recovery behavior or package graph.

Refinement extension: transaction wording also shares the SDK review owner under `../sdk-client-reconciliation/tasks/transaction-message-plan.md`; the two current formatters differ, so first extract Revnet unchanged, then reconcile Juicebox's demonstrated presentation cases while preserving URL/identifier protection, diagnostics and all recovery warnings. JBM pending lookup/stamp/polling helpers move unchanged to the SDK because Sticky/Homerun adopt that exact policy; Revnet keeps its different lifecycle.


## Plan refinement

- **Objective:** Finish the shared SDK caller migration and fix the reproduced browser RPC queue timeout: queued requests must wait through a server-directed cooldown before their transport timeout starts, while independent requests remain paced and overlap.
- **System fit:** SDK provider admission now owns both 125ms request-start spacing and Retry-After cooldown before request timeout creation. App transports provide one browser limiter across chains and a correctly bound window fetch. Server transport, pinned-block retry, wallet authorization, execution proof and journals retain their existing owners.
- **Reuse and simplicity:** Replace the first-phase fetch re-export with the existing provider limiter extension createPacedJBCenterLimiter. Remove obsolete app fetch wrappers and their moved SDK unit tests; preserve actual transport integration tests and add long-cooldown/concurrency acceptance there. Safe and formatter migrations follow the earlier checked refinement unchanged.
- **Evidence and unknowns:** SDK investigation reproduced that fetch-level queuing begins after provider timeout creation and duplicates the provider response-slot limiter. Root approved moving pacing into SDK admission. Source extraction equivalence was verified first; this second phase intentionally fixes only admission timing, response concurrency and shared cooldown ownership. Final preview qualification remains pending SDK owner gates.
- **Verification:** Actual viem transport tests must prove twelve unresolved requests can start 125ms apart, a 60-second Retry-After wait does not expire the 15-second request timeout, server origin and browser fetch receiver remain correct, and pinned-block retries still pass. Existing Safe proof, explicit non-batch rejection, error evidence and source gates remain required, followed by root-owned full builds/browser checks.
- **Resource budget:** One limiter per browser module, no extra scheduler or dependency. SDK unit tests own abort and timer details; app integration tests own provider placement. Root stages the exact package into physical locked installs. Replan on changed server behavior, unreliable fake-time results, or any authority/recovery change.


## Plan refinement

- **Objective:** Close the demonstrated final wallet window in useSafeTx so chain, view-as and Safe-route changes during simulation or intent persistence cannot reach the wallet; keep current Safe proposal and receipt behavior.
- **System fit:** SDK review owns the final synchronous beforeSend boundary and conditional intent cleanup, as recorded in `../sdk-client-reconciliation/tasks/contract-write-final-plan.md`. Juicebox supplies live framework wallet/chain/view-as checks and sends explicit request.chainId; existing reviews, durable callbacks and proof owners are preserved.
- **Reuse and simplicity:** Move the existing Safe-route guard into shared beforeSend and add current chain/view-as assertions there. Remove local cleanup from write; the SDK owns cleanup once. Keep current account checks in SDK and wallet send in write. No unused proposal callback or product journal migration.
- **Evidence and unknowns:** Current writer checks Safe-route changes but omits live chain/view-as after awaited simulation or beforeWrite, and trusts simulated request chain fields. SDK regression proved six missing final-gate cases before its change; new application regressions will reproduce the concrete chain/view-as gap against the current preview before adapting the hook.
- **Verification:** Defer simulation and beforeWrite, change wallet chain/view-as, then require no wallet invocation and exactly one pre-wallet cleanup only when a persisted intent exists. Preserve Safe-route drift and explicit rejection/ambiguous-send tests; assert explicit reviewed chainId reaches the writer. SDK owner covers signing-phase drift and final guard ordering. Run full Safe hook/proposal and transaction suites plus static gates on the qualified preview.
- **Resource budget:** One hook, existing regression file and SDK shared gate; coordinated app owners reuse beforeSend. Root stages the rebuilt exact preview; no local dependency re-resolution. Replan for any changed proposal acceptance, journal recovery or wallet prompt semantics.


## Plan refinement

- **Objective:** Retain submitted Safe actions after an outer transaction reverts or exact execution proof is unavailable, allowing release only on an authenticated inner ExecutionFailure or existing nonce/deadline proof.
- **System fit:** SDK SafeExecutionResult distinguishes failed inner execution from reverted/unproven outer evidence. useSafeTx renders this evidence and keeps proposal deduplication; project-batch owns durable submission retention across resume. Authority/batch senders continue their existing error and journal paths. No new wallet action or inference of a consumed Safe nonce.
- **Reuse and simplicity:** Use the existing SDK result statuses. A distinct known proposal remains awaiting after uncertain execution evidence, including later service failures; explicit repeat sends restart the existing follower behind one in-flight guard. Direct at-once hash display retains its existing failure behavior; durable submissions remain held without exact inner failure. No new poller or status engine. Update caller mocks to target extracted public helpers; SDK and safe-connector acceptance tests still own real queue/receipt helper behavior.
- **Evidence and unknowns:** Independent four-client review found useSafeTx marks reverted outer receipts failed. Source tracing also found project-batch deletes saved submissions on reverted or unproven result; existing tests explicitly expected that unsafe release. The initial full suite reported14 extraction mock failures and5 resource-contention timeouts; preserve that first report and rerun bounded workers after correcting mock seams.
- **Verification:** Prove reverted and unrelated/unproven Safe executions remain submitted on repeated sends, component remount and durable batch resume without additional wallet calls; preserve exact ExecutionFailure release and success cases. Run changed caller suites plus bounded full coverage, types, lint, dead-code and source/transaction gates. Parent coordinates corresponding Homerun/Sticky and Revnet changes and final builds.
- **Resource budget:** Keep current receipts/records and lifecycle owners; no SDK API change, new poller or journal migration. Source edits waited until full readers finished. Limit subsequent workers and serialize full suites to avoid false wall-clock failures; replan if the held state cannot be recovered using existing verified paths.


Reconciliation review in progress: the qualified preview was installed with npm12 and a clean physical npm ci, preserving the locked nested dependency graph. The first extraction checkpoint passed145 RPC/Safe/error cases; caller mock seams were subsequently moved to the extracted public helper boundary and passed113 cases before any recovery policy change. The final wallet guard has four application regressions that failed before the fix and now pass with the full97 hook/contract/proposal cases. The Safe retention refinement adds six failing-before cases; the corrected authority/project-batch/proposal suites pass171 cases. Distinct known proposals remain held through reset, dismissal, remount, unavailable service and explicit rechecks; exact inner failure and nonce replacement still settle. At-once outer-revert presentation is preserved, while every durable batch journal retains reverted/unproven evidence.

Initial full coverage evidence is retained at /private/tmp/jbm-client-reconciliation-coverage.log: 2756/2775 passed;14 failures exposed stale extracted-helper mock seams (fixed above), and5 timed out during concurrent heavyweight work. No timeouts or assertions were weakened. Full lint, types, dependencies, container, source, protocol-fixture, live/offline schemas, production audit and transaction inventory passed; dead-code identified one unused type re-export, now removed. Root subsequently assigned a separate owner to close additional Relayr final-wallet windows; final bounded full coverage and repeated changed-source gates wait for that source, followed by exact official SDK adoption and serialized build/browser qualification. No app release or deployment has occurred.

## Plan refinement

- **Objective:** Close every remaining reviewed contract and Permit2 final-wallet window with a single framework context owner, and release authority intent markers only when the wallet was demonstrably not invoked.
- **System fit:** SDK beforeSend owns ordering and pre-write cleanup; a lightweight wallet-context module owns live account, target chain, connector uid and view-as assertions. The local reviewed-write adapter composes that guard with Safe-route binding for every existing caller. Authority retains its actual send owner; project-batch owns exact saved-marker cleanup. Child wallet-boundary work is recorded in tasks/jbm-wallet-boundaries.md.
- **Reuse and simplicity:** Extend the existing reviewed-write adapter instead of repeating checks in CreateForm, free mint and Safe creation. Permit2 reuses the same captured context before and after signing. Preserve explicit per-product error/recovery behavior and send the reviewed chain explicitly. An optional authority abort callback removes only its original hashless marker; wallet exceptions never use that path.
- **Evidence and unknowns:** Inventory identifies all direct writers and signatures. The main hook was fixed first; remaining reviewed callers omit final chain/connector/view-as checks and the launch flow rereads Safe classification after wallet completion. Permit2 already checks account/chain/view-as but not connector identity. Authority invokes awaited onSending after its last account check, so its durable marker needs a proven-prewrite cleanup path.
- **Verification:** Add deferred review/simulation/persistence and signing context-drift regressions at the shared adapter and Permit2 boundaries. Preserve ordinary and Safe caller acceptance tests, ambiguous wallet error retention, exact inner Safe failure semantics and launch recovery tests. Run complete changed suites and source/transaction/type/lint gates before final bounded full coverage on the qualified SDK package.
- **Resource budget:** One shared framework helper, one adapter and existing caller files/tests; delegate independent raw-wallet owners. No new dependency, queue, poller or wallet action. Replan if existing saved Safe execution recovery confuses outer transaction failure with nonce consumption, rather than silently releasing it.

Final wallet refinement review: all reviewed writes now compose SDK beforeSend with the common captureWalletContext owner; the main hook and free-mint callback also capture the original context before their initial awaited queue/eligibility reads. Deferred original-connector tests failed before these early captures and now pass in the complete124-case adapter/Permit2/hook/proposal/mint set. Authority's proven pre-wallet abort callback clears only the exact original hashless project marker; all78 project-batch cases pass, including three failed-before cleanup cases and preserved ambiguous/hash-bearing submissions. The separate raw-wallet owner passed196 authority/Safe/payer/context cases (tasks/jbm-wallet-boundaries.md). No timeout, coverage floor or recovery assertion was relaxed.

The delayed-hydration owner reproduced a real hydrateRoot mismatch after restored persisted data became available at window.load, then moved every persisted reader to the shared per-component hydration adapter. Its plan/evidence is tasks/delayed-hydration-reconciliation.md; scoped198 cases and lint passed. Launch/setup admission and Safe recovery are recorded in tasks/launch-boundary-reconciliation.md, with133 focused cases passing before an independently reviewed finality refinement. Root authorized finalized and canonical evidence only for releasing failed non-idempotent launch authority; unknown legacy submissions remain held. Final source freeze, the SDK's final wallet-error normalizer package, complete coverage and production/browser gates remain outstanding.


Release-candidate verification: SDK2.25.0 preview4 (sha512-DeJMW245XZq1QUs+0zzgE8E8ETah+s+D7QxJoh0KG5uTzyrQh3Jn3EWDRh69f/hi6mTOBCMR1txt8TWUf0RoMA==) was installed with the real pinned npm12 shim and a clean physical npm ci (1116 packages). All11 final static/audit/schema gates passed: dependency tree, dead-code, production audit, container policy, full lint, route generation/types, source invariants, protocol fixture, live and offline schemas and transaction inventory. Final launch/setup/session/failure/Relayr focused tests passed224 cases; the Relayr guard/normalizer suites passed226. Their independent source review has no remaining blockers.

The final complete coverage run passed all214 files and2904 tests with no skipped cases. All coverage floors passed: statements63.13%, branches56.04%, functions59.05%, lines65.08%. The first bounded run passed2903 cases and exposed one stale View-as test seam importing the real wallet provider behind a partial wagmi mock. Adding only provider/account mocks preserved every refusal assertion; the affected9 cases and final complete rerun passed. All first logs remain intact. Evidence: /private/tmp/jbm-client-final-coverage-after-mock.log and /private/tmp/jbm-client-release-candidate-static-results.json. No timeouts, assertions, retries, coverage floors or audit exceptions were weakened.

A final read-only parity census confirmed existing indexed permission readers retain projectId0 grants and the authority view separately scopes wildcard grants to the resolved owner; the latest Revnet zero-project validation fix therefore requires no Juicebox data change. Original unknown launch and Safe submissions retain durable evidence, and failure-only retry now requires exact finalized canonical proof. Root still owns official package payload comparison/registry adoption and the final production-build/budget/browser gates, including the revised launch reload scenarios; those gates remain outstanding.


## Plan refinement

- **Objective:** Ship the completed shared-client reconciliation against published SDK2.25.0 through reviewable pull requests with final production and browser evidence.
- **System fit:** The registry package owns the tested shared protocol helpers; app adapters retain wallet context, product journals and rendering. Root verified official payload identity and owns merge after hosted CI. This step changes package provenance and current ownership documentation, not runtime behavior.
- **Reuse and simplicity:** Adopt the exact registry version using the existing npm12 lockfile workflow and physical clean installs. Reuse release-candidate unit coverage because every published payload file and the tarball integrity match; use existing hosted build, budget, browser and container gates without adding a second workflow.
- **Evidence and unknowns:** Root verified all762 published files and integrity sha512-DeJMW245XZq1QUs+0zzgE8E8ETah+s+D7QxJoh0KG5uTzyrQh3Jn3EWDRh69f/hi6mTOBCMR1txt8TWUf0RoMA== against the fully tested candidate. Final hosted production/browser results are still unknown; source is frozen except fixes required by those gates.
- **Verification:** Perform npm install of exact2.25.0 and physical npm ci, confirm registry resolution/integrity, rerun dependency, source, type and documentation-sensitive inventory checks, then require all hosted CI jobs on the exact pushed revision. Preserve first failures and fix their causes without weakening gates.
- **Resource budget:** One owner mutates each dependency graph sequentially. Do not repeat identical full unit coverage; hosted CI runs final heavy gates while sibling local builds are serialized. Commit only inventoried reconciliation files, open both PRs and replan for any payload mismatch or unexpected dependency drift.


Official adoption complete: exact registry SDK2.25.0 is pinned in the manifest and lockfile, with the verified published integrity above. A clean physical npm ci reified all1116 packages with pinned Node26.7.0/npm12.0.1. Registry resolution and installed version match, and final dependency, type, source and wallet-inventory gates pass; deployment/container policy also passes (plus Revnet formatting ratchet). Logs: /private/tmp/jbm-client-official-static-results.json. Current TESTING ownership documentation names the published shared owners. Full unit/coverage evidence above remains valid because the official package is byte-identical to the tested candidate; no full rerun was needed. Pull-request CI now owns final production-build, budgets, browser and OCI smoke evidence before root merges; these gates are not yet reported as passed.


## Plan refinement

- **Objective:** Resolve the first hosted bundle-budget failure while preserving the verified wallet and recovery behavior and all existing lazy-loading guarantees.
- **System fit:** CI37724379008 passed full units, production compilation and OCI smoke but stopped before browser tests at client budgets. Application imports and emitted chunks own this performance question; shared financial rules and authority policy stay unchanged. Final browser qualification follows a green measured build.
- **Reuse and simplicity:** Compare baseline6a0598d with candidate7e39b80 on the same Node26.7/npm12 physical lockfile workflow and deterministic build script. Inspect newly introduced eager/duplicate imports first; prefer an existing async boundary if it removes unnecessary first-load work without creating another copy or control flow.
- **Evidence and unknowns:** Hosted candidate measures home439.3KiB, create509.2KiB and aggregate2536.9KiB against439/508/2535 limits. Project168.5KiB, largest419.3KiB, styles18.4KiB and all lazy SDK/dialog checks pass. First failure is retained at /private/tmp/jbm-client-pr118-first-failure.log. Exact matched baseline deltas and chunk attribution remain unknown.
- **Verification:** Preserve both build outputs, measure gzip bytes/chunk counts and route references, review changed imports independently, and run the unchanged budget checker. Any justified minimal budget adjustment requires recorded measured added rules and independent review; never conceal an eager-wallet regression. Re-run affected source/type/tests for any runtime change and hosted full CI before merge.
- **Resource budget:** Root released the single local heavy slot for two serialized builds. One child performs read-only import review while the other monitors Revnet CI. No speculative performance rewrite, dependency graph shortcut or repeated full unit suite; replan if evidence identifies a broader regression.


Matched budget review: baseline6a0598d and candidate7e39b80 use separate physical npm12 installs with Node26.7.0 and identical deterministic build/fixture/checker scripts. Both builds pass. Exact gzip bytes: home448960→449801 (+841), create519284→521420 (+2136), all2595769→2597812 (+2043). Both emit185 chunks; largest429344B and styles18872B are unchanged, and all project/lazy constraints pass. Raw measurements and chunk maps are /private/tmp/jbm-client-budget-{baseline,candidate}-exact.log and /private/tmp/jbm-client-budget-chunk-diff.json; original builds remain in their isolated checkouts.

Independent import/chunk review approves440KiB home,510KiB create and2537KiB aggregate, leaving759/820/76B headroom. The local finalized-failure adapter adds327B once on create and is absent from home; its heavy SDK proof already loads lazily. Moving it into Safe setup would couple EOA failure to that module, while a new recovery chunk adds loading/compression overhead and cannot resolve home or aggregate growth. Required hydration, original-wallet checks and durable recovery remain intact. No application source changed; project570KiB, largest450KiB, styles20KiB and every lazy-loading constraint are unchanged. New hosted CI must run the previously blocked browser journeys before merge.

The unchanged candidate artifact passes the reviewed caps; source invariants, scoped ESLint, whitespace and refinement checks also pass. Root accepted the measured limits and existing lazy placement. The76B aggregate headroom is only the measured rounding margin, not a broader performance claim; hosted output on the pushed revision remains decisive.
