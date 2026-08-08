/**
 * Plain-language definitions of protocol terms the UI uses as bare labels.
 *
 * Shared verbatim across juicebox-money, revnet-money and juicescan: these are protocol
 * concepts, not per-app copy. Every clause is checked against the contracts in this monorepo —
 * see the citation on each entry — because a confident wrong explanation of a fee is worse
 * than no explanation at all.
 */
export const PROTOCOL_CONCEPTS = {
  /** JBCashOuts.cashOutFrom — tax 0 returns the exact proportional share of surplus; a higher
   *  rate returns less than proportional; MAX returns nothing. */
  cashOutTax:
    'How much of the treasury stays behind when someone cashes out. At 0% you get your exact proportional share of the surplus. Higher rates return less than proportional, leaving the difference for the holders who stay.',

  /** JBRulesetMetadataResolver.reservedPercent — the share of newly minted tokens routed to the
   *  reserved split list instead of the payer. */
  reservedPercent:
    'The share of newly minted tokens set aside for the project’s reserved list instead of going to whoever paid. It applies to tokens minted by payments, not to tokens already in circulation.',

  /** REVLoans header (:42-46): 2.5% to the source revnet + 1% to $REV + a variable amount the
   *  borrower chooses, which sets the prepaid duration. After it lapses the repay cost ramps
   *  linearly to liquidation at LOAN_LIQUIDATION_DURATION (10 years). */
  prepaidFee:
    'Paid upfront when the loan opens, and it buys time: a larger prepayment extends the period where repaying costs nothing extra. Once that period ends, the cost to repay climbs steadily until the loan liquidates at 10 years and the collateral is lost for good.',

  /** JBBuybackHook._requireValidTwapWindow — 5 minutes to 2 days. The hook averages the pool
   *  price over this window to floor what a swap must return. */
  twapWindow:
    'How far back the buyback hook averages the pool price when deciding the least a swap may return. Longer windows are harder to manipulate but slower to reflect a real price move; shorter windows are the reverse. Allowed range is 300 to 172800 seconds.',
} as const
