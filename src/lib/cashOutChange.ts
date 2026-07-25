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

  if (balanceRose && supplyRose) {
    causes.push('a payment added backing and issued tokens')
  }
  else if (balanceFell && supplyFell) {
    causes.push('a cash out removed backing and burned tokens')
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

function formatTax(value: number): string {
  return `${(value / 100).toFixed(2).replace(/\.?0+$/, '')}%`
}

function joinCauses(causes: string[]): string {
  if (causes.length === 1) return causes[0]
  return `${causes.slice(0, -1).join(', ')} and ${causes.at(-1)}`
}
