import type { Address } from 'viem'

/**
 * Every write the SDK holds for `account` on `chainId`, as the app-wide
 * HeldWritesNotice lists it (`hold.list`), each asked of the chain once.
 */
export async function listedHeld(account: Address, chainId: number, client: unknown) {
  const { writeHolds } = await import('@/lib/write-holds')
  return Promise.all(writeHolds.list({ account, chainId }).map(async ({ handle }) => ({ hold: handle, state: await handle.state(client as never) })))
}
