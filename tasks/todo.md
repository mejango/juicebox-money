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
- [ ] Integration owner runs release/build/browser checks on the combined application changes. No install, build or deployment was performed in this task worktree.

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
