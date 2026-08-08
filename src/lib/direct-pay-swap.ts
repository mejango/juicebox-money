export {
  buildDirectPaySwapTx,
  NATIVE_SWAP_BY_CHAIN,
  quoteDirectPaySwap,
  type DirectPaySwapQuote,
} from "@bananapus/nana-sdk-core/v6/direct-pay";

/**
 * Whether a fetched direct-swap quote may route THIS payment.
 *
 * A quote's presence says nothing about whether it belongs to what's on
 * screen: react-query applies `placeholderData` to any pending query whether
 * or not `enabled` is satisfied, so the previous amount's quote survives being
 * disabled. Re-assert every condition that gated the fetch, because the quote
 * carries the minimum output the transaction is built with — routing an
 * add-to-balance or a shop checkout with a leftover quote sends the old
 * minimum alongside the new amount and drops the NFT metadata.
 */
/**
 * The reviewed swap request with a fresh execution deadline.
 *
 * Every direct-swap route is a Universal Router `execute(commands, inputs,
 * deadline)` call — the deadline is the third argument and appears nowhere
 * inside the encoded inputs, so ONLY that argument changes: amounts and
 * slippage minimums stay exactly as reviewed. Stamp it immediately before
 * send, not at dialog-open — a request frozen with the 20-minute EOA window
 * made a late confirm (and every retry of it) revert in simulation until the
 * dialog was rebuilt. An unexpected request shape is returned unchanged
 * rather than corrupted.
 */
export function restampDirectSwapDeadline<
  T extends { functionName: string; args: readonly unknown[] },
>(request: T, deadline: bigint): T {
  if (request.functionName !== "execute" || request.args.length !== 3) {
    return request;
  }
  return { ...request, args: [request.args[0], request.args[1], deadline] };
}

export function directSwapRouteApplies(input: {
  hasQuote: boolean;
  quoteErrored: boolean;
  /** react-query's `isPlaceholderData`: the quote is the previous one. */
  quoteIsPrevious: boolean;
  mode: "pay" | "addbalance";
  cartCount: number;
  amountRaw: bigint;
}): boolean {
  return (
    input.hasQuote &&
    !input.quoteErrored &&
    !input.quoteIsPrevious &&
    input.mode === "pay" &&
    input.cartCount === 0 &&
    input.amountRaw > 0n
  );
}
