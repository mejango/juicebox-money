/**
 * TEMPORARY: remove once Bendystraw records each event's token.
 *
 * V6 pay, add-to-balance, cash-out and payout events carry no token, so
 * Bendystraw labels and prices every one with the project's last-set
 * accounting context. A project that accepts more than one token then gets
 * wrong amounts, symbols and USD values (a 0.0001 ETH payment indexed as
 * 100,000,000 USDC). Those figures are only shown when every deployment's
 * live accounting contexts were read and none has more than one.
 *
 * `contextCounts` holds one entry per deployment: the number of accounting
 * contexts, null when the read failed, undefined while it is pending.
 * Returns undefined while any read is pending and none has disqualified it.
 */
export function indexedAmountsTrusted(
  contextCounts: readonly (number | null | undefined)[],
): boolean | undefined {
  if (contextCounts.some(count => count != null && count > 1)) return false
  if (contextCounts.some(count => count === undefined)) return undefined
  return contextCounts.every(count => count != null)
}
