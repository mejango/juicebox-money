import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildCashOutTx,
  getAccountingContexts,
  getCashOutQuote,
  type CashOutQuote,
  type JBAccountingContext,
  type V6CashOutTxRequest,
} from '@bananapus/nana-sdk-core/v6'
import type { Address, PublicClient } from 'viem'

/**
 * Pure cash-out plumbing shared by the TreasuryCard client island and the
 * verification scripts: accounting-context resolution, quoting in the
 * project's own accounting terms, and tx-request assembly with a slippage
 * floor.
 */

/** Slippage floor on cash-out quotes, in thousandths: 975 = 97.5%. */
export const CASH_OUT_SLIPPAGE_FLOOR = 975n

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

/** The least the holder will accept: quote × 97.5% (2.5% slippage floor). */
export function minReclaimedFloor(quote: CashOutQuote): bigint {
  return (quote.reclaimAmountAfterFee * CASH_OUT_SLIPPAGE_FLOOR) / 1000n
}

/**
 * Assemble the `cashOutTokensOf` request with the slippage floor applied.
 * Throws when the floor would be zero — a zero `minTokensReclaimed` must
 * never be sent.
 */
export function buildCashOutRequest({
  chainId,
  terminal,
  holder,
  projectId,
  cashOutCount,
  tokenToReclaim,
  quote,
  beneficiary,
}: {
  chainId: JBChainId
  terminal: Address
  holder: Address
  projectId: bigint
  /** Project tokens to cash out, fixed-point 18 decimals. */
  cashOutCount: bigint
  tokenToReclaim: Address
  quote: CashOutQuote
  beneficiary: Address
}): V6CashOutTxRequest {
  const minTokensReclaimed = minReclaimedFloor(quote)
  if (minTokensReclaimed <= 0n) {
    throw new Error('Nothing to reclaim for this cash-out.')
  }
  return buildCashOutTx({
    chainId,
    terminal,
    holder,
    projectId,
    cashOutCount,
    tokenToReclaim,
    minTokensReclaimed,
    beneficiary,
  })
}
