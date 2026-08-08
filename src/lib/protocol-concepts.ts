/**
 * Plain-language definitions of protocol terms the UI uses as bare labels.
 *
 * Shared verbatim across juicebox-money, revnet-money and juicescan: these are protocol
 * concepts, not per-app copy. Every clause is checked against the contracts in this monorepo —
 * see the citation on each entry — because a confident wrong explanation of where money goes
 * is worse than no explanation at all.
 *
 * Written for someone who has never read a Juicebox doc. No "ruleset", no "issuance weight",
 * no "surplus", no "splits" — those are our words, not theirs. Where a word is unavoidable
 * (a "cycle" is a real thing that repeats) it gets glossed in the sentence that uses it.
 */
export const PROTOCOL_CONCEPTS = {
  /** tokenCount = amount * weight / weightRatio (JBTerminalStore.sol:1165-1175). */
  issuance:
    'How many tokens you get for each unit you put in. The project sets this in its rules, so unlike a market price it does not move with trading.',

  /** JBRuleset.weightCutPercent — the issuance weight is reduced by this each cycle. */
  issuanceCut:
    'How much that rate drops each cycle. Where there is a cut, the same payment gets you fewer tokens later on — so paying earlier gets you more.',

  /** JBRulesetMetadataResolver.reservedPercent — the share of newly minted tokens routed to
   *  the reserved split list instead of the payer. */
  reservedShare:
    'The share of newly created tokens that goes to people the project chose in advance, instead of to whoever paid. Whoever paid gets the rest.',

  /** REVOwner / JBController auto-issuance: minted to named beneficiaries at stage start. */
  autoIssuance:
    'Tokens created for specific people the moment this stage begins, without anyone paying for them.',

  /** JBCashOuts.cashOutFrom — 0 returns the exact proportional share of surplus; a higher rate
   *  returns less than proportional; MAX returns nothing. */
  cashOutTax:
    'What the project keeps when someone cashes their tokens back in. At 0% you get your full share of the money in the treasury. Higher settings pay you less than your full share and leave the difference to everyone still holding.',

  /** JBFundAccessLimitGroup.payoutLimits — "maximum amounts distributable to splits per ruleset
   *  cycle". Resets every cycle. */
  payoutLimit:
    'The most the project can send to the people it pays, in one cycle. It refills at the start of every cycle. Anything above it stays in the treasury, where it backs what token holders can cash out.',

  /** JBFundAccessLimitGroup.surplusAllowances — "maximum amounts withdrawable from surplus per
   *  ruleset". JBTerminalStore.sol:140-144 is explicit that usage is keyed by `ruleset.id`, NOT
   *  cycle number, so cycles rolling over do NOT refill it. That is the whole difference from
   *  the payout limit and the thing an owner is most likely to get wrong. */
  surplusAllowance:
    'The most the project’s owner can take out of the treasury on top of the payouts, to spend however they choose. Unlike the payout limit this does not refill each cycle — it is a single budget that lasts as long as the current rules do.',

  /** REVLoans header (:42-46): an upfront fee, part of which the borrower chooses; it sets the
   *  prepaid duration, after which the repay cost ramps to liquidation at 10 years. */
  prepaidFee:
    'Paid upfront when the loan opens, and it buys time: paying more extends the stretch where paying the loan back costs you nothing extra. Once that runs out, the cost to get your collateral back climbs steadily, until after 10 years the collateral is gone for good.',

  /** JBBuybackHook._requireValidTwapWindow — 5 minutes to 2 days. */
  twapWindow:
    'How far back to average the trading price when checking that a swap is a fair deal. A longer window is harder for someone to manipulate, but slower to notice a real change in price. A shorter one is the opposite. Anything from 300 to 172800 seconds.',

  /** JB721 tier flag `transfersPausable` — only tiers that opted in are affected. */
  itemTransfers:
    'Whether this stage stops shop items from being passed on to someone else. It only affects items whose creator agreed to let the project’s rules control that.',
} as const
