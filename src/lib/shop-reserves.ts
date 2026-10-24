/** JB721TiersHookStore rejects a one-item tier with positive reserves. */
export function reservedSupplyOk(supply: number | null, reserveFrequency: number): boolean {
  return supply !== 1 || reserveFrequency <= 0
}
