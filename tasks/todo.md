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
