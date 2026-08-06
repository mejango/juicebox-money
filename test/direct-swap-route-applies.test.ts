// A direct-swap quote carries the minimum output the transaction is built with, so it may
// only route the payment it was fetched for. react-query keeps serving `placeholderData`
// after a query is disabled (it applies to any pending query regardless of `enabled`), so
// the previous amount's quote outlives the conditions that produced it — these pin the
// re-assertion that keeps it from routing something else.
import { directSwapRouteApplies } from "@/lib/direct-pay-swap";
import { describe, expect, it } from "vitest";

const fresh = {
  hasQuote: true,
  quoteErrored: false,
  quoteIsPrevious: false,
  mode: "pay" as const,
  cartCount: 0,
  amountRaw: 1_000n,
};

describe("directSwapRouteApplies", () => {
  it("routes a fresh quote for a plain pay", () => {
    expect(directSwapRouteApplies(fresh)).toBe(true);
  });

  it("refuses a placeholder (previous-amount) quote", () => {
    // The hijack: old quote's minimumTokenCount would ride the new amount.
    expect(directSwapRouteApplies({ ...fresh, quoteIsPrevious: true })).toBe(false);
  });

  it("refuses to route an add-to-balance", () => {
    // Add-to-balance has no min-output bound; a swap route would be unbounded.
    expect(directSwapRouteApplies({ ...fresh, mode: "addbalance" })).toBe(false);
  });

  it("refuses to route a shop checkout", () => {
    // The pool cannot mint the selected NFTs, and the 721 metadata would be dropped.
    expect(directSwapRouteApplies({ ...fresh, cartCount: 2 })).toBe(false);
  });

  it("refuses a zero amount, an errored quote, and a missing quote", () => {
    expect(directSwapRouteApplies({ ...fresh, amountRaw: 0n })).toBe(false);
    expect(directSwapRouteApplies({ ...fresh, quoteErrored: true })).toBe(false);
    expect(directSwapRouteApplies({ ...fresh, hasQuote: false })).toBe(false);
  });

  it("needs every condition at once — a stale quote in the wrong mode stays refused", () => {
    expect(
      directSwapRouteApplies({
        ...fresh,
        quoteIsPrevious: true,
        mode: "addbalance",
        cartCount: 3,
      }),
    ).toBe(false);
  });
});
