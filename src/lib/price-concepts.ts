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
 * ruleset says so; the pool price is Uniswap spot, held between the other two by traders
 * taking the cheaper route; the cash-out floor derives from treasury balance, token supply and
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
      return `What it costs, in ${baseSymbol}, to get one ${symbol} by paying the project directly right now. The project sets this in its own rules rather than the market, so it only changes when the project's schedule says it should.`;
    case "pool":
      return `What one ${symbol} costs to buy from the trading pool right now. Traders keep it between the other two prices: if it climbs above what paying the project costs, people pay the project instead; if it drops below what cashing out returns, people cash out instead.`;
    case "cashOut":
      return `What you would get back for one ${symbol} by cashing it in to the project's treasury right now, before fees. It moves with how much is in the treasury, how many tokens exist, and the project's cash out tax.`;
  }
}
