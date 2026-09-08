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
