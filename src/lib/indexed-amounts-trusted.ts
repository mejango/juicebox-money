/**
 * Bendystraw's project and sucker-group `balance` and `volume` add raw
 * amounts without regard to token, labeled with the project's last-set
 * accounting context. They are in one unit only when the project accepts one
 * token: eth:12 accepts ETH and USDC, so its 0.0001 ETH balance (1e14 wei)
 * reads as 100,000,000 USDC. Per-event amounts carry their own token and are
 * unaffected. Those raw totals are only used when every deployment's live
 * accounting contexts were read and none has more than one.
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
