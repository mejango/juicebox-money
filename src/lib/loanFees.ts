/** REVLoans fee denominator (`JBConstants.MAX_FEE`). */
const MAX_FEE = 1000n
const REV_FEE_PERCENT = 10n

/** The minimum prepaid source fee accepted by REVLoans: 25 / 1000 = 2.5%. */
export const MIN_LOAN_SOURCE_FEE_PERCENT = 25n

/**
 * Net proceeds a borrower receives from a gross REVLoans quote.
 *
 * The terminal first takes its standard 2.5% fee (`gross / 40`), then
 * REVLoans deducts the 1% REV fee and the selected prepaid source fee from
 * the original gross amount. Owner summaries pass the minimum source fee so
 * they describe spendable proceeds rather than the principal to be repaid.
 */
export function netLoanProceeds(
  grossBorrowAmount: bigint,
  prepaidSourceFeePercent = MIN_LOAN_SOURCE_FEE_PERCENT,
): bigint {
  const protocolFee = grossBorrowAmount / 40n
  const revFee = (grossBorrowAmount * REV_FEE_PERCENT) / MAX_FEE
  const sourceFee = (grossBorrowAmount * prepaidSourceFeePercent) / MAX_FEE
  const fees = protocolFee + revFee + sourceFee
  return grossBorrowAmount > fees ? grossBorrowAmount - fees : 0n
}
