import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildCashOutTx,
  getAccountingContexts,
  getCashOutQuote,
  type CashOutQuote,
  type CashOutRoute,
  type JBAccountingContext,
  type V6CashOutTxRequest,
} from '@bananapus/nana-sdk-core/v6'
import { formatUnits, type Address, type PublicClient } from 'viem'

/**
 * Pure cash-out plumbing shared by the TreasuryCard client island and the
 * verification scripts: accounting-context resolution, quoting in the
 * project's own accounting terms, and tx-request assembly from an SDK
 * slippage-protected route (getHookAwareCashOutQuote/resolveCashOutRoute).
 */

export function isNativeToken(token: string): boolean {
  return token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
}

/**
 * Resolve the project's accounting context — the token its treasury is
 * accounted in. The first registered context is the accounting token; do NOT
 * assume native (USDC-accounting projects exist, e.g. Artizen on Base).
 */
export async function getCashOutContext(
  client: PublicClient,
  { chainId, projectId }: { chainId: JBChainId; projectId: bigint },
): Promise<JBAccountingContext | null> {
  const contexts = await getAccountingContexts(client, { chainId, projectId })
  return contexts[0] ?? null
}

/**
 * Quote a cash-out in the accounting context's own terms (its decimals and
 * token-keyed currency), so no price-feed conversion is involved.
 *
 * Hook-blind (`currentReclaimableSurplusOf` skips data hooks) — display-only.
 * Transactions must quote through the SDK's `getHookAwareCashOutQuote`.
 */
export function getContextCashOutQuote(
  client: PublicClient,
  {
    chainId,
    projectId,
    cashOutCount,
    context,
  }: {
    chainId: JBChainId
    projectId: bigint
    /** Project tokens to cash out, fixed-point 18 decimals. */
    cashOutCount: bigint
    context: JBAccountingContext
  },
): Promise<CashOutQuote> {
  return getCashOutQuote(client, {
    chainId,
    projectId,
    cashOutCount,
    decimals: BigInt(context.decimals),
    currency: BigInt(context.currency),
  })
}

/**
 * The current per-token cash-out price from an omnichain revnet's aggregate
 * surplus and token supply. This is the exact integer form used by the cash
 * out curve for one 18-decimal project token:
 *
 * balance × share × ((1 - tax) + tax × share)
 *
 * Keeping the calculation in bigint avoids the zero returned by an onchain
 * one-token quote when a very small result rounds down inside the store.
 */
export function cashOutPriceFromTotals({
  balance,
  tokenSupply,
  cashOutTaxRate,
  balanceDecimals,
}: {
  balance: bigint
  tokenSupply: bigint
  /** Basis points, out of 10,000. */
  cashOutTaxRate: number
  balanceDecimals: number
}): number | null {
  if (balance <= 0n || tokenSupply <= 0n) return null

  const oneToken = 10n ** 18n
  const tax = BigInt(Math.max(0, Math.min(10_000, cashOutTaxRate)))
  const factor = (10_000n - tax) * tokenSupply + tax * oneToken
  const rawPrice =
    (balance * oneToken * factor) /
    (tokenSupply * tokenSupply * 10_000n)
  if (rawPrice <= 0n) return null

  const value = Number(formatUnits(rawPrice, balanceDecimals))
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * The current cash-out curve's backing asymptote:
 * (1 - tax) × balance ÷ supply.
 *
 * The one-token quote is slightly above this value because it includes that
 * token's quadratic share term. As supply grows, the quote approaches this
 * value. This is distinct from the payment asymptote shown on the chart.
 */
export function minimumCashOutPriceFromTotals({
  balance,
  tokenSupply,
  cashOutTaxRate,
  balanceDecimals,
}: {
  balance: bigint
  tokenSupply: bigint
  /** Basis points, out of 10,000. */
  cashOutTaxRate: number
  balanceDecimals: number
}): number | null {
  if (balance <= 0n || tokenSupply <= 0n) return null

  const oneToken = 10n ** 18n
  const tax = BigInt(Math.max(0, Math.min(10_000, cashOutTaxRate)))
  const rawPrice =
    (balance * oneToken * (10_000n - tax)) /
    (tokenSupply * 10_000n)
  if (rawPrice <= 0n) return null

  const value = Number(formatUnits(rawPrice, balanceDecimals))
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Long-run cash-out price after payments at the current issuance price. */
export function minimumCashOutPriceAtIssuancePrice(
  issuancePrice: number,
  cashOutTaxRate: number,
): number | null {
  if (!Number.isFinite(issuancePrice) || issuancePrice <= 0) return null
  const tax = Math.max(0, Math.min(10_000, cashOutTaxRate))
  return issuancePrice * (1 - tax / 10_000)
}

/** Show the payment asymptote only when paid issuance can pull the live quote down toward it. */
export function shouldShowCashOutAsymptote(
  cashOutPrice: number | undefined,
  asymptote: number | undefined,
): boolean {
  return (
    cashOutPrice !== undefined &&
    asymptote !== undefined &&
    Number.isFinite(cashOutPrice) &&
    Number.isFinite(asymptote) &&
    cashOutPrice > 0 &&
    asymptote > 0 &&
    cashOutPrice > asymptote
  )
}

/**
 * Assemble the `cashOutTokensOf` request from an SDK slippage-protected
 * route: the route's terminal minimum and metadata carry the floor (in
 * `minTokensReclaimed` on the treasury route, in the buyback hook metadata
 * on the pool route). Throws when the route's floor is zero — an
 * unprotected cash-out must never be sent.
 */
export function buildCashOutRequest({
  chainId,
  terminal,
  holder,
  projectId,
  cashOutCount,
  tokenToReclaim,
  route,
  beneficiary,
}: {
  chainId: JBChainId
  terminal: Address
  holder: Address
  projectId: bigint
  /** Project tokens to cash out, fixed-point 18 decimals. */
  cashOutCount: bigint
  tokenToReclaim: Address
  route: CashOutRoute
  beneficiary: Address
}): V6CashOutTxRequest {
  if (route.minimumReturn <= 0n) {
    throw new Error('Nothing to reclaim for this cash-out.')
  }
  return buildCashOutTx({
    chainId,
    terminal,
    holder,
    projectId,
    cashOutCount,
    tokenToReclaim,
    minTokensReclaimed: route.terminalMinimum,
    beneficiary,
    metadata: route.metadata,
  })
}
