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
    'How many new tokens a payment creates per unit paid, before any are set aside for other recipients. The rules set this rate; trading does not.',

  /** JBRuleset.weightCutPercent — the issuance weight is reduced by this each cycle. */
  issuanceCut:
    'How much the token creation rate falls each time the rules repeat. A lower rate means the same payment creates fewer tokens.',

  /** JBRulesetMetadataResolver.reservedPercent — the share of newly minted tokens routed to
   *  the reserved split list instead of the payer. */
  reservedShare:
    'The share of new tokens set aside for chosen recipients. The payer gets the rest.',

  /** REVOwner.autoIssueFor: named beneficiaries can receive their allocation after stage start. */
  autoIssuance:
    'Tokens set aside for named recipients without a payment. They can be created once their stage starts.',

  /** JBCashOuts.cashOutFrom — 0 returns the exact proportional share of surplus; a higher rate
   *  returns less than proportional; MAX returns nothing. */
  cashOutTax:
    'A setting that leaves more money for remaining holders when someone cashes out part of the token supply. At 0%, the formula returns a proportional share of funds not set aside for payouts. Higher settings return less; 100% returns nothing.',

  /** JBFundAccessLimitGroup.payoutLimits — "maximum amounts distributable to splits per ruleset
   *  cycle". Resets every cycle. */
  payoutLimit:
    'The most the project can pay to its recipients each time the rules repeat. This budget resets each cycle. Funds above the unused budget can back cash outs, subject to the other rules.',

  /** JBFundAccessLimitGroup.surplusAllowances — "maximum amounts withdrawable from surplus per
   *  ruleset". JBTerminalStore.sol:140-144 is explicit that usage is keyed by `ruleset.id`, NOT
   *  cycle number, so cycles rolling over do NOT refill it. That is the whole difference from
   *  the payout limit and the thing an owner is most likely to get wrong. */
  surplusAllowance:
    'An extra withdrawal budget for funds not set aside for payouts. The owner or an account they authorize can spend it. It does not reset when the same rules repeat.',

  /** REVLoans header (:42-46): an upfront fee, part of which the borrower chooses; it sets the
   *  prepaid duration, after which the repay cost ramps to liquidation at 10 years. */
  prepaidFee:
    'Paid when the loan opens. Paying more gives you longer before repayment costs start growing. Repay to recover the tokens locked for the loan. After 10 years, those tokens are lost.',

  /** JBBuybackHook._requireValidTwapWindow — 5 minutes to 2 days. */
  twapWindow:
    'How much trading history to use for an average price. This helps check a trade before it goes through. A longer window is harder to manipulate but slower to reflect price changes. Allowed range: 5 minutes to 2 days.',

  /** JB721 tier flag `transfersPausable` — only tiers that opted in are affected. */
  itemTransfers:
    'Whether holders can send shop items to someone else during this stage. A pause affects only items created with this control enabled.',
} as const

/**
 * Exactly what a revnet's operator may do.
 *
 * Not a paraphrase: `REVOwner._operatorPermissionIndexesOf` grants SET_SPLIT_GROUPS,
 * SET_BUYBACK_POOL, SET_BUYBACK_TWAP, SET_PROJECT_URI, SUCKER_SAFETY, SET_BUYBACK_HOOK,
 * SET_ROUTER_TERMINAL, SET_TOKEN_METADATA and SIGN_FOR_ERC20; `REVDeployer` adds
 * ADJUST_721_TIERS, SET_721_METADATA, MINT_721 and SET_721_DISCOUNT_PERCENT for the shop, each
 * droppable by its `prevent*` flag; and `deploySuckersFor` / `REVOwner.setOperatorOf` are
 * operator-only entrypoints. One line here per power, and nothing that is not one.
 *
 * Identical to revnet-money's copy in its own `src/lib/protocolConcepts.ts`.
 */
export const OPERATOR_POWERS = [
  "Change the revnet's name, logo, and description",
  "Change the token's name and symbol",
  "Change who receives the share of new tokens set at launch, without increasing that share",
  "Add, remove, and re-price shop items, create them for free, and change their discounts",
  "Choose where tokens are bought back and how the reference trading price is averaged",
  "Choose among approved payment contracts, including one that can convert payment tokens",
  "Extend the revnet to new approved chains, and pause a bridge that looks unsafe",
  "Sign messages on behalf of the revnet's token",
  "Hand the operator role to another address",
] as const

/** The other half of the sentence: what the role can never reach. */
export const OPERATOR_LIMITS =
  "It cannot change how new tokens are created, the cash out rules, or the stage schedule. It cannot withdraw the revnet's funds."
