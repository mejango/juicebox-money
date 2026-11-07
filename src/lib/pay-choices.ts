import { parseUnits } from 'viem'

/**
 * Which currency the pay panel opens on, and what its button does.
 *
 * Pure, and deliberately outside the panel: these are the two rules a payer without any of a
 * project's tokens actually meets, and they are worth being able to test without rendering a
 * form that reads six contracts.
 *
 * Kept identical in revnet-money (`payCardLayout.ts`) — the same two questions, the same two
 * answers, on both sites.
 */

/**
 * Whether the token menu should open on "$" rather than on a token.
 *
 * A wallet holding none of the tokens a project accepts cannot pay in any of them, so offering
 * one as the default asks the payer to go and acquire it before the panel does anything. Their
 * own choice always wins — this only decides where the menu starts.
 */
export function defaultsToDollars({
  isConnected,
  balances,
}: {
  isConnected: boolean
  /** One balance per accepted token. Undefined while a read is pending or failed. */
  balances: (bigint | undefined)[]
}): boolean {
  if (!isConnected || balances.length === 0) return false
  return balances.every(balance => balance === 0n)
}

/**
 * A typed dollar amount in token units, given JBPrices' price of one dollar in that token at the
 * token's decimals. Zero for anything that is not a positive number.
 */
export function tokensForDollars(dollars: string, tokensPerDollar: bigint): bigint {
  try {
    const trimmed = dollars.trim()
    if (!trimmed || Number(trimmed) <= 0) return 0n
    return (parseUnits(trimmed, 18) * tokensPerDollar) / 10n ** 18n
  } catch {
    return 0n
  }
}

/**
 * Where a picked token sits in a re-resolved list. Addresses differ across chains, so a token
 * absent by key is looked for by symbol. -1 when this list does not have it.
 */
export function pickedTokenIndex<T extends { symbol: string }>(
  tokens: readonly T[],
  key: string,
  symbol: string,
  keyOf: (token: T) => string,
): number {
  const byKey = tokens.findIndex(token => keyOf(token) === key)
  return byKey >= 0 ? byKey : tokens.findIndex(token => token.symbol === symbol)
}

/** What pressing the pay button does, given who is here and what they picked. */
export function payButtonAction({
  isConnected,
  payWithDollars,
}: {
  isConnected: boolean
  payWithDollars: boolean
}): 'signIn' | 'buyFirst' | 'confirm' {
  if (!isConnected) return 'signIn'
  // Dollars are not a token this project can be paid in; pressing Pay says so and offers the
  // purchase, rather than starting a payment that cannot settle.
  return payWithDollars ? 'buyFirst' : 'confirm'
}

/**
 * The ONE asset a payer should buy to pay this project.
 *
 * Not a list: "ETH or USDC" asks someone to make a choice the project has already made, and on
 * a project that takes only one of them it invites buying the half that cannot pay it. The
 * token they are already looking at wins; otherwise whichever the project accepts.
 */
export function buyableAsset({
  accepted,
  preferred,
}: {
  /** Symbols of every token the project accepts. */
  accepted: string[]
  /** The token currently selected in the pay panel, if any. */
  preferred?: string
}): 'ETH' | 'USDC' {
  const onRampable = ['ETH', 'USDC'] as const
  const has = (asset: string) =>
    accepted.some(symbol => symbol.toUpperCase() === asset)
  const chosen = onRampable.find(
    asset => asset === preferred?.toUpperCase() && has(asset),
  )
  return chosen ?? onRampable.find(has) ?? 'ETH'
}
