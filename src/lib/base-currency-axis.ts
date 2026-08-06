import {
  JBCoreContracts,
  jbContractAddress,
  jbPricesAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import type { PublicClient } from 'viem'

/**
 * PRICE-CHART AXIS — canonical semantics, shared by every webclient.
 *
 * The axis unit is the ruleset's `baseCurrency`. That is what the project denominates
 * issuance in and what the protocol itself prices against: `JBTerminalStore` converts every
 * payment into `ruleset.baseCurrency()` before applying the weight
 * (`tokenCount = amount * weight / weightRatio`, JBTerminalStore.sol:1165-1175), and
 * `JBBuybackHook` repeats that conversion when choosing mint-vs-swap
 * (JBBuybackHook.sol:1153-1164). It is also the only unit in which the issuance line is
 * EXACT, since issuance is `1 / weight` with no feed involved.
 *
 * Series and their native units:
 *   issuance ceiling (1/weight) → already base currency per token. NO conversion.
 *   AMM / pool price            → accounting (terminal) token per project token.
 *   cash-out floor + minimum    → accounting token per project token (balance ÷ supply).
 *
 * The last two are multiplied by `basePerAccountingToken` to reach the axis. Plotting them
 * unconverted under a base-currency label is the defect this module exists to prevent.
 *
 * NEVER fabricate a rate: without one, omit the series and say so. A missing line is
 * honest, a wrongly denominated one is not.
 */

/**
 * Base-currency units per ONE accounting token, via the same project-scoped feed the
 * terminal uses on every payment.
 *
 * `pricePerUnitOf` is documented as "the `pricingCurrency` price of one `unitCurrency`"
 * (JBPrices.sol:217-225), so pricing in the BASE currency a unit of the ACCOUNTING currency
 * is exactly the factor needed. The contract short-circuits identical currencies to `1e18`
 * (`:238`), so the common same-currency project needs no special case — though callers
 * should still skip the call entirely to avoid a pointless RPC round trip.
 *
 * Returns null when no feed is configured (`JBPrices_PriceFeedNotFound`) or the read fails.
 */
export async function basePerAccountingToken(
  client: PublicClient,
  {
    chainId,
    projectId,
    baseCurrency,
    accountingCurrency,
  }: {
    chainId: JBChainId
    projectId: bigint
    baseCurrency: number
    accountingCurrency: number
  },
): Promise<number | null> {
  if (baseCurrency === accountingCurrency) return 1
  const prices = jbContractAddress['6'][JBCoreContracts.JBPrices]?.[chainId]
  if (!prices) return null
  try {
    const price = (await client.readContract({
      address: prices,
      abi: jbPricesAbi,
      functionName: 'pricePerUnitOf',
      args: [projectId, BigInt(baseCurrency), BigInt(accountingCurrency), 18n],
    })) as bigint
    const rate = Number(price) / 1e18
    return Number.isFinite(rate) && rate > 0 ? rate : null
  } catch {
    return null
  }
}

/** Convert an accounting-denominated value onto the base-currency axis. */
export function toBaseAxis(
  value: number | null | undefined,
  rate: number | null,
): number | null {
  if (value === null || value === undefined) return null
  if (rate === null) return null // no rate ⇒ omit, never guess
  return value * rate
}
