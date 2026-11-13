/**
 * The chains a holder action (cash out, loan, burn) can run on: every chain whose balance is not a settled zero.
 * An unread balance keeps its chain listed, so a failed read never hides a chain the holder may hold on.
 */
export function holderActionChains(
  chains: readonly (readonly [number, number])[],
  heldByChain: readonly bigint[] | undefined,
): [number, number][] {
  return chains.filter((_, index) => heldByChain?.[index] !== 0n).map(pair => [pair[0], pair[1]])
}
