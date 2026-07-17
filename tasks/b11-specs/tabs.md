# B11 spec — website/ project-page TAB system (scout report, 2026-07-16)

All refs: website/src/discover.js. Detail page = renderProjectDetail (5279-5472).

## Page-level (outside tabs)
- Back button; detail header (logo + symbol chip + name, tagline, stat line,
  meta row "Flavor: REVNET|CUSTOM · On: chains · Owner|Operator: addr · Site").
- Stat line: cross-chain USD balance (mountUsdBalance). Revnet → "Balance | N
  owners" (fetchOwnersCount); custom → indexed volume/payments/contributors.
- Contract warnings card when inspectProjectContracts finds unknown contracts.
- Two columns: LEFT = rule-change notice + Pay card + Activity (desktop);
  RIGHT = tab row + content. jb:project-updated listener refreshes header.

## Tab lists (lazy-built, cached, URL-hash deep links via tabSlug)
- REVNET: Activity(mobile) · Overview · Terms · Owners · Shop(cond) · Extras · Operator
- CUSTOM: Activity(mobile) · Overview · Rulesets · Funds · Tokens · Shop(cond) · Extras · Owner
- Shop: optimistic, removed if no 721 hook (STORE() probe); revnets keep even
  empty (operator can add tiers).
- Activity is a TAB only ≤600px; desktop = left-column card.

## OVERVIEW
- Revnet w/ stages: price chart (issuance ceiling ladder SVG + AMM price +
  cash-out floor legend).
- About card: logo/tagline/description(+rich), links, Edit CTA → edit modal.
- Other info: project IDs per chain (clickable), token name/symbol/type/addr/
  chains, owner/operator ENS + per-chain divergence.

## TERMS (revnet) = renderStagesSection
- Issuance card: current rate SYM/ETH, next cut countdown or "Fixed",
  reserved %, projected-issuance SVG ladder (1Y/5Y/10Y/All).
- Terms table: per stage — period, issuance + "cut X% every N days", split
  limit, auto-issuance total (bendystraw), cash out tax.

## OWNERS (revnet) / TOKENS (custom) = renderOwnersSection — subtabbed
- Token panel above subtabs: name/symbol/type/address/chains or "No ERC-20
  yet"; Deploy ERC-20 / Edit CTA.
- Subtabs revnet: Accounts, Market*, Settlement, Splits, Auto Issuance, Loans
- Subtabs custom: Accounts, Market*, Settlement, Reserved  (noLoans:true)
  (*Market only when ERC-20 exists)
- Accounts: YOU card (connect-gated; per-chain Balance+Credits/ERC20, Cash
  out value, Max loan (revnet), LP; actions: Cash out, Get a loan (revnet),
  Move between chains (multichain), Add market liquidity (ERC20); Claim
  credits when ERC20 + credits; Your loans table w/ Repay) + ALL card
  (holder donut + table from bendystraw participants).
- Market: AMM card (pool, LP pie, composition, depth chart) + BannyLPSplitHook
  card (accumulated, pool deployed, claimable fees; keeper actions).
- Settlement: Composition per chain (supply/balance/unit value), Gossip
  (multichain), Bridges table (native vs CCIP), Queued movements w/ claim.
- Splits (revnet): per-stage stepper, split-limit, per-chain recipient tables,
  leftover→REVOwner; Edit splits CTA; Latest distributions.
- Reserved (custom): same, current ruleset only, no Edit here (lives in
  Rulesets tab).
- Auto Issuance (revnet): chain/stage/account/amount/unlock/Distribute
  (REVOwner.autoIssueFor).
- Loans (revnet): active loans table.

## RULESETS (custom) = renderRulesetsFundsSection
- Cycle carousel (← Cycle #N Current/Upcoming/Projected →), status, remaining/
  duration, id; ruleset diff grid (CYCLE/OTHER RULES/TOKEN/EXTENSION);
  per-token FUNDS ACCESS (payout limit + surplus allowance); PAYOUT SPLITS
  per token w/ Edit; RESERVED SPLITS w/ Edit; upcoming-change diff notice;
  Queue ruleset button; per-chain sync note/selector.

## FUNDS (custom) = renderFundsCard
- Total balance + per-token subtabs; per token: balance, per-chain table
  (balance/payout limit remaining/surplus), Distribute payouts button,
  Use surplus allowance button, payouts table (home chain).

## SHOP = renderShopSection
- +Add items CTA (owner/operator), shop credit line, category chips, tier
  cards, collection address. Purchases via pay card.

## EXTRAS (both)
- Copy this project (.jb export).
- Payer address card: deploy JBProjectPayer per chain (behavior select,
  beneficiary orig/custom per chain, memo, editable toggle, metadata,
  duplicate detection).

## OWNER (custom) / OPERATOR (revnet) = renderBackOfficeSection
Cards: Account (authority per chain, EOA/Safe type, Safe policy/signers,
undeployed-Safe helper, Transfer CTA) · Pending Safe txs (Sign/Execute,
warnings) · Edits (project metadata / token metadata / reserved splits) ·
Powers (CUSTOM ONLY: 7 owner powers w/ enabled state + CTAs) · Buyback &
swap router (set hook / set router / init pool) · Permissions (revnet
read-only "Operator" list; custom editable → set-permissions modal).
Order revnet: Account, PendingSafe, Edits, BuybackRouter, Permissions.
Order custom: Account, PendingSafe, Edits, Powers, BuybackRouter, Permissions.

## ACTIVITY
- Chain multi-select + event-type filters; pay/cashout/payout/reserved/loan/
  NFT-mint/erc20-deploy/creation events (bendystraw).

## Revnet detection (authoritative)
- ownerOf(projectId) == REVOwner address for that chain → isRevnet.
- operator = bendystraw permissionHolders(isRevnetOperator:true), preferring
  rows still holding permissions; null → hide (never fabricate).
- Branches: tab set/vocab, price chart, header stats, authority labels,
  subtabs (Splits/AutoIssuance/Loans vs Reserved), You-card loans, splits
  empty copy (REVOwner vs owner), BackOffice card set + read-only perms,
  Transfer modal (setOperatorOf vs NFT transferFrom), reserved-split owner
  recipient, shop minter labels, .jb export projectType.

## Data sources
- On-chain: JBProjects.ownerOf, JBTokens, JBController (rulesets, pending
  reserved, total supply w/ reserved), JBSplits.splitsOf, JBFundAccessLimits,
  JBTerminalStore (balance/surplus/reclaimable), REVLoans, REVOwner
  (cashOutDelayOf/autoIssueFor), BannyLPSplitHook, UniV4 pool.
- Bendystraw: project meta, sucker groups, operator, permission holders,
  payers, swaps, participants, auto-issue events, sucker moments, loans,
  reserved distributions, activity.
