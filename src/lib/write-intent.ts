import { keccak256, stringToHex } from 'viem'

/** A parameter the user chose; volatile fields (deadlines, Permit2 expirations or nonces, signatures, quotes) never go in. */
type IntentParam = string | number | bigint | boolean | null | undefined

/**
 * The write hold key for a write whose calldata regenerates on retry (a fresh
 * deadline, Permit2 expiration, signature or quote): the action and the
 * parameters the user chose. A retry of the same intent is held by the first
 * attempt until its explicit exit. Addresses and hex compare case-blind;
 * parameter order doesn't matter.
 */
export function writeIntentKey(action: string, params: Record<string, IntentParam>): string {
  const stable = Object.keys(params)
    .sort()
    .map(name => {
      const value = params[name]
      return [name, typeof value === 'string' ? value.toLowerCase() : value === undefined || value === null ? null : String(value)]
    })
  const digest = keccak256(stringToHex(JSON.stringify([action, stable]))).slice(2, 42)
  return `intent:${action.toLowerCase().replace(/[^a-z0-9._/-]/g, '-').slice(0, 40)}:${digest}`
}

/**
 * A Permit2 approve(token, spender, amount, expiration)'s intent: its token,
 * spender and amount. Its expiration restamps on every review, so it's left out.
 */
export function permit2ApproveIntent(request: { chainId: number; args: readonly unknown[] }): string {
  const [token, spender, amount] = request.args as readonly [string, string, bigint]
  return writeIntentKey('permit2-approve', { chainId: request.chainId, token, spender, amount: BigInt(amount) })
}
