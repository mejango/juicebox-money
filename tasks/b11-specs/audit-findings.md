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

## Fund-safety audit — PENDING
## Math/read audit — PENDING
