/**
 * Plain-language definitions of the three prices every client's chart plots.
 *
 * Kept identical across juicebox-money, revnet-money and juicescan: these are protocol
 * concepts, not per-app copy, and a reader who learns "cash out price" on one should not meet
 * a different definition on another.
 *
 * Written to the same standard as PROTOCOL_CONCEPTS — for someone who has never read a
 * Juicebox doc. No "ruleset", no "issuance weight", no "mint", no "arbitrage". Those are our
 * words; a person looking at a price chart wants to know what the number costs them.
 *
 * Still checkable: issuance is 1/weight in the ruleset's base currency and moves only when the
 * ruleset says so; the pool price is Uniswap spot and can move outside the other two prices;
 * the cash-out floor derives from treasury balance, token supply and
 * the cash-out tax, and is quoted BEFORE fees (a nonzero tax means a fee on every cash out, so
 * naming a single percentage here would be wrong).
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
      return `The reference cost in ${baseSymbol} to create one new ${symbol} under the current rules. A payment may set aside some new tokens for other recipients, so this is not always the payer's cost per token.`;
    case "pool":
      return `The current trading price of one ${symbol}. Buyers and sellers can move it. Creating new tokens or cashing out can offer a better deal, but neither sets a guaranteed market price.`;
    case "cashOut":
      return `A reference value for cashing out one ${symbol}. It depends on available project funds, token supply, and the cash out rules. Check a quote for the amount you want to cash out.`;
  }
}
