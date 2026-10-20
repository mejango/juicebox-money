import { expect, it, vi } from 'vitest'

// The first download of the ENS client fails, as a dropped chunk would.
const state = vi.hoisted(() => ({
  failures: 0,
  getEnsAddress: vi.fn(async () => `0x${'ab'.repeat(20)}`),
  getEnsName: vi.fn(async () => 'vitalik.eth'),
}))
vi.mock('@/lib/ens-client', async () => {
  if (state.failures-- > 0) throw new Error('Loading chunk 3936 failed.')
  return { ensClient: { getEnsAddress: state.getEnsAddress, getEnsName: state.getEnsName } }
})

import { lookupEnsAddress, lookupEnsName, resolvedAddress } from '@/lib/ens'

// The module loads once per file, so both lookups fail first, then recover.
it('a failed client download is never cached as "no answer"', async () => {
  state.failures = 2
  const address = `0x${'cd'.repeat(20)}`
  // Reverse lookups throw, so useEnsName's query retries instead of keeping null.
  await expect(lookupEnsName(address)).rejects.toThrow()
  // Forward lookups answer null for the moment and leave the cache empty.
  expect(await lookupEnsAddress('vitalik.eth')).toBeNull()
  expect(resolvedAddress('vitalik.eth')).toBeNull()

  expect(await lookupEnsName(address)).toBe('vitalik.eth')
  expect(await lookupEnsAddress('vitalik.eth')).toBe(`0x${'ab'.repeat(20)}`)
  expect(resolvedAddress('vitalik.eth')).toBe(`0x${'ab'.repeat(20)}`)
})
