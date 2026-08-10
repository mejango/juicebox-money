/**
 * Wallet gas limits are deliberately twice the latest RPC estimate.
 *
 * Some Juicebox terminal calls catch a failed internal fee payment and keep
 * going. An RPC can therefore return an estimate for that cheaper recovery
 * path even though the intended fee route needs more gas. Unused gas is not
 * spent, so a 2x limit is a cheap guard against that under-estimation.
 */
export function gasWithHeadroom(estimate: bigint): bigint {
  return estimate * 2n
}
