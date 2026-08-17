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
  /** One balance per accepted token. Empty while they are still being read. */
  balances: bigint[]
}): boolean {
  if (!isConnected || balances.length === 0) return false
  return balances.every(balance => balance === 0n)
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
