export type CashOutObservation = {
  balance: bigint
  tokenSupply: bigint
  cashOutTax: number
  price: number
}

export function explainCashOutChange(
  previous: CashOutObservation | undefined,
  current: CashOutObservation,
): string {
  if (!previous) return 'First indexed cash-out price observation.'

  const causes: string[] = []
  const balanceRose = current.balance > previous.balance
  const balanceFell = current.balance < previous.balance
  const supplyRose = current.tokenSupply > previous.tokenSupply
  const supplyFell = current.tokenSupply < previous.tokenSupply
  const backingRatio = compareBackingPerToken(previous, current)

  if (balanceRose && supplyRose) {
    causes.push(
      backingRatio < 0
        ? 'a payment increased token supply faster than backing, diluting backing per token'
        : backingRatio > 0
          ? 'a payment increased backing faster than token supply'
          : 'a payment added backing and tokens at the same backing-per-token ratio',
    )
  }
  else if (balanceFell && supplyFell) {
    causes.push(
      backingRatio > 0
        ? 'a cash out burned supply faster than it removed backing, increasing backing per remaining token'
        : backingRatio < 0
          ? 'a cash out removed backing faster than it burned supply'
          : 'a cash out removed backing and supply at the same ratio',
    )
  }
  else {
    if (balanceRose) causes.push('funds were added to the project')
    if (balanceFell) causes.push('a payout reduced project backing')
    if (supplyRose) causes.push('token supply increased')
    if (supplyFell) causes.push('tokens were burned')
  }
  if (current.cashOutTax !== previous.cashOutTax) {
    causes.push(
      `the cash-out tax changed from ${formatTax(previous.cashOutTax)} to ${formatTax(current.cashOutTax)}`,
    )
  }

  const direction =
    current.price > previous.price
      ? 'rose'
      : current.price < previous.price
        ? 'fell'
        : 'was unchanged'
  return causes.length
    ? `Cash-out price ${direction} because ${joinCauses(causes)}.`
    : `Cash-out price ${direction}; the indexed backing, supply, and tax inputs did not change.`
}

function compareBackingPerToken(
  previous: CashOutObservation,
  current: CashOutObservation,
): number {
  if (previous.tokenSupply === 0n || current.tokenSupply === 0n) return 0
  const left = current.balance * previous.tokenSupply
  const right = previous.balance * current.tokenSupply
  return left > right ? 1 : left < right ? -1 : 0
}

function formatTax(value: number): string {
  return `${(value / 100).toFixed(2).replace(/\.?0+$/, '')}%`
}

function joinCauses(causes: string[]): string {
  if (causes.length === 1) return causes[0]
  return `${causes.slice(0, -1).join(', ')} and ${causes.at(-1)}`
}
