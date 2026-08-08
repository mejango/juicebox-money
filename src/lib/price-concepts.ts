/**
 * Plain-language definitions of the three prices every client's chart plots.
 *
 * Kept identical across juicebox-money, revnet-money and juicescan: these are protocol
 * concepts, not per-app copy, and a reader who learns "cash out price" on one should not meet
 * a different definition on another. juicescan had the only version of this text for a long
 * time, on a hover with nothing on screen to reveal it.
 *
 * Every clause is checkable: issuance is `1 / weight` in the ruleset's base currency and moves
 * only when the ruleset says so; the pool price is Uniswap spot, bounded by arbitrage against
 * the other two; the cash-out floor derives from treasury balance, token supply and the
 * ruleset's cash-out tax, and is quoted BEFORE fees (a nonzero tax means a fee on every cash
 * out, so naming a single percentage here would be wrong).
 */
export function priceConcept(
  kind: "issuance" | "pool" | "cashOut",
  { tokenSymbol, baseSymbol }: { tokenSymbol?: string | null; baseSymbol: string },
): string {
  // Only clients that actually hold the PROJECT token's symbol pass one. revnet's chart is
  // given the accounting-context symbol, which is a different token — naming it here would
  // label a project-token price with its treasury token.
  const symbol = tokenSymbol || "token";
  switch (kind) {
    case "issuance":
      return `What it costs to have one ${symbol} minted by paying the project right now — 1 ÷ the ruleset's issuance weight, in ${baseSymbol}. Set by the ruleset rather than by trading, so it changes only on the schedule the project has scheduled.`;
    case "pool":
      return `What one ${symbol} trades for in the Uniswap pool right now, set by trading. Arbitrage keeps it between the issuance price (mint instead) and the cash out price (cash out instead).`;
    case "cashOut":
      return `What cashing out one ${symbol} returns from the treasury right now, before fees. It moves with the treasury balance, the token supply, and the ruleset's cash out tax.`;
  }
}
