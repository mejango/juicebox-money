# B11 adversarial audit findings (2026-07-17)

## Revnet-vs-custom audit — CLEAN on load-bearing axes
No wrong-flavor tab/flow/contract/data path. Authority, vocabulary, transfer,
token/queue gating, hook resolution, accounting-vs-project-token all correct.
Findings (act on MEDIUM; rest cosmetic):
- [MEDIUM] Revnet Splits subtab has no Edit CTA — a revnet operator with
  SET_SPLIT_GROUPS can't edit splits anywhere. FIX needs permission-aware
  gating (EditSplitsFlow gates on ownerOf==connected; revnet owner is the
  REVOwner contract, so operator needs hasPermissions(SET_SPLIT_GROUPS)).
- [LOW] Shop tab shows for custom projects with no 721 hook (spec: remove).
- [LOW] tokenSymbol prop into OwnersTab is the accounting symbol; MarketSection
  overrides on-chain so display is correct — plumbing mislabel only.
- [LOW] EOA/Safe chip only computed for custom (revnet operator lacks it).
- [LOW] Market subtab always present (degrades to "no pool" — harmless).
- [LOW] BackOffice card order differs from spec (cosmetic).

## Fund-safety audit — NO CRITICAL. Core invariant holds (simulate-before-sign
everywhere, no raw-write bypass, unified account). Fixed:
- M-1 Settlement dest project id per-chain (was hardcoded to source) — FIXED ab81186
- M-2 PayPanel pay min = 99% floor not exact (buyback/USD-issuance revert) — FIXED ab81186
- L-1 useSafeTx signs the simulated request — FIXED ab81186
- L-2 QueueRulesetFlow metadata spread verified safe (keep a round-trip test).
## Math/read audit — one HIGH numeric bug + one label bug, both fixed:
- BUG 1 HIGH RulesetsTab base-currency fund limits used token decimals (1e12x
  overstatement on 6-dec tokens) — FIXED ab81186 (mirror FundsTab: 18-dec for
  base-currency limits, token-dec for token-keyed).
- BUG 2 MEDIUM RevnetPriceCard base-symbol hardcoded USDC — FIXED ab81186
  (USD_CURRENCY_ID + resolved token symbol).
- Everything else numeric CONFIRMED CORRECT (V4 price, chart projection,
  cash-out/holder denominators, discount, decimals).

## Revnet split-edit MEDIUM — FIXED 69ca3d6 (permission-aware EditSplitsFlow).

## NET: all CRITICAL/HIGH/MEDIUM findings fixed. Remaining LOW items (Shop tab
## on hookless custom projects, EOA/Safe chip for revnet operators, BackOffice
## card order) are cosmetic/parity nits — left as-is.
